/**
 * 服务端集成测试：真实启动 HTTP 服务，走完整解码 → AABB → 裁剪 → 编码链路。
 * 直接用 node:test + 全局 fetch，不引入额外测试依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { createApp } from '../src/index.js';
import { DEFAULT_OPTIONS } from '../../shared/aabb.js';

// ---------------------------------------------------------------- fixtures

/** 透明画布 + 中间一块不透明矩形，返回原始 RGBA。 */
function blockRgba({ width = 40, height = 30, rect = { x: 10, y: 6, width: 12, height: 8 }, color = [220, 30, 30] } = {}) {
  const data = Buffer.alloc(width * height * 4, 0);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return { data, width, height, rect };
}

async function pngFixture(opts) {
  const { data, width, height, rect } = blockRgba(opts);
  const buffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { buffer, width, height, rect };
}

async function emptyPngFixture(width = 16, height = 12) {
  const data = Buffer.alloc(width * height * 4, 0);
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ---------------------------------------------------------------- harness

async function withServer(fn) {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postBinary(base, route, buffer, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined)).toString();
  const res = await fetch(`${base}${route}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: buffer,
  });
  return res;
}

async function postJson(base, route, payload) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res;
}

// ---------------------------------------------------------------- tests

test('GET /api/health 报告引擎与算法契约', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.algorithm, 'aabb/v1');
    assert.equal(body.sharpAvailable, true);
    assert.deepEqual(body.defaults, DEFAULT_OPTIONS);
    assert.ok(body.outputFormats.includes('png'));
  });
});

test('POST /api/analyze（二进制）返回精确 AABB 与四边去除量', async () => {
  const { buffer, width, height, rect } = await pngFixture();
  await withServer(async (base) => {
    const res = await postBinary(base, '/api/analyze', buffer);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.bounds, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    assert.deepEqual(body.trimmed, { left: 10, top: 6, right: 18, bottom: 16 });
    assert.equal(body.empty, false);
    assert.equal(body.contentPixels, rect.width * rect.height);
    assert.equal(body.source.width, width);
    assert.equal(body.source.height, height);
    assert.equal(body.source.format, 'png');
    assert.equal(body.source.hasAlpha, true);
    assert.equal(body.algorithm, 'aabb/v1');
    assert.ok(body.elapsedMs >= 0);
  });
});

test('POST /api/analyze（JSON dataURL）与二进制输入结果一致', async () => {
  const { buffer, rect } = await pngFixture();
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  await withServer(async (base) => {
    const binary = await (await postBinary(base, '/api/analyze', buffer)).json();
    const json = await (await postJson(base, '/api/analyze', { name: '蝴蝶-01.png', image: dataUrl })).json();
    assert.deepEqual(json.bounds, binary.bounds);
    assert.deepEqual(json.bounds, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    assert.equal(json.name, '蝴蝶-01.png');
  });
});

test('alphaThreshold 生效：低不透明度的边缘被丢弃', async () => {
  const { data, width, height } = blockRgba();
  // 在内容左侧铺一条 alpha=20 的“投影”
  for (let y = 0; y < height; y += 1) {
    for (let x = 2; x < 10; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 20;
    }
  }
  const buffer = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await withServer(async (base) => {
    const loose = await (await postBinary(base, '/api/analyze', buffer)).json();
    assert.equal(loose.bounds.x, 2, '默认阈值下投影也被算作内容');

    const strict = await (await postBinary(base, '/api/analyze', buffer, { alphaThreshold: 60 })).json();
    assert.equal(strict.bounds.x, 10, '阈值调高后投影被忽略');
  });
});

test('POST /api/crop 输出裁剪后的 PNG（保留 alpha 通道）', async () => {
  const { buffer, rect } = await pngFixture();
  await withServer(async (base) => {
    const res = await postBinary(base, '/api/crop', buffer);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const boundsHeader = JSON.parse(Buffer.from(res.headers.get('x-image-clip-bounds'), 'base64').toString('utf8'));
    assert.deepEqual(boundsHeader, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });

    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, rect.width);
    assert.equal(meta.height, rect.height);
    assert.equal(meta.hasAlpha, true);
    assert.ok(out.length > 0);
  });
});

test('padding 与输出格式参数生效（PNG / WebP / JPEG）', async () => {
  const { buffer, rect } = await pngFixture();
  await withServer(async (base) => {
    const padded = await (await postBinary(base, '/api/crop', buffer, { padding: 2 })).arrayBuffer();
    const paddedMeta = await sharp(Buffer.from(padded)).metadata();
    assert.equal(paddedMeta.width, rect.width + 4);
    assert.equal(paddedMeta.height, rect.height + 4);

    const webp = await postBinary(base, '/api/crop', buffer, { format: 'webp', quality: 95 });
    assert.equal(webp.headers.get('content-type'), 'image/webp');
    const webpMeta = await sharp(Buffer.from(await webp.arrayBuffer())).metadata();
    assert.equal(webpMeta.format, 'webp');
    assert.equal(webpMeta.width, rect.width);

    const jpeg = await postBinary(base, '/api/crop', buffer, { format: 'jpeg', quality: 92 });
    assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
    const jpegMeta = await sharp(Buffer.from(await jpeg.arrayBuffer())).metadata();
    assert.equal(jpegMeta.format, 'jpeg');
    assert.equal(jpegMeta.hasAlpha, false);
  });
});

test('?response=json 返回 dataURL 与边界信息', async () => {
  const { buffer, rect } = await pngFixture();
  await withServer(async (base) => {
    const res = await postBinary(base, '/api/crop', buffer, { response: 'json' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(body.bounds, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    assert.equal(body.mime, 'image/png');
  });
});

test('POST /api/crop/batch 逐张返回结果与错误，不因单张失败而整体失败', async () => {
  const a = await pngFixture();
  const b = await pngFixture({ rect: { x: 0, y: 0, width: 5, height: 5 }, width: 20, height: 20 });
  const empty = await emptyPngFixture();
  await withServer(async (base) => {
    const res = await postJson(base, '/api/crop/batch', {
      images: [
        { name: 'a.png', image: `data:image/png;base64,${a.buffer.toString('base64')}` },
        { name: 'b.png', image: `data:image/png;base64,${b.buffer.toString('base64')}` },
        { name: 'empty.png', image: `data:image/png;base64,${empty.toString('base64')}` },
      ],
      options: { format: 'png' },
    });
    const body = await res.json();
    assert.equal(body.total, 3);
    assert.equal(body.succeeded, 2);
    assert.equal(body.results[0].ok, true);
    assert.deepEqual(body.results[0].bounds, { x: a.rect.x, y: a.rect.y, width: a.rect.width, height: a.rect.height });
    assert.deepEqual(body.results[1].bounds, { x: 0, y: 0, width: 5, height: 5 });
    assert.equal(body.results[2].ok, false);
    assert.equal(body.results[2].error.code, 'EMPTY_CONTENT');
  });
});

test('全透明图片：analyze 标记 empty，crop 返回 422', async () => {
  const empty = await emptyPngFixture(12, 9);
  await withServer(async (base) => {
    const analysis = await (await postBinary(base, '/api/analyze', empty)).json();
    assert.equal(analysis.empty, true);
    assert.deepEqual(analysis.bounds, { x: 0, y: 0, width: 0, height: 0 });

    const res = await postBinary(base, '/api/crop', empty);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.code, 'EMPTY_CONTENT');
  });
});

test('CMYK JPEG（无 alpha）会被规范化为 sRGB，不会整张被判成透明', async () => {
  const width = 24;
  const height = 18;
  const rect = { x: 3, y: 4, width: 6, height: 5 };
  // 白底 + 红块，无 alpha 通道
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255;
    rgba[i + 1] = 255;
    rgba[i + 2] = 255;
    rgba[i + 3] = 255;
  }
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = 220;
      rgba[i + 1] = 30;
      rgba[i + 2] = 30;
    }
  }
  const buffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .toColourspace('cmyk')
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.space, 'cmyk');
  assert.equal(meta.hasAlpha, false);

  await withServer(async (base) => {
    // 若不把 CMYK 转成 sRGB，K 通道会被当成 alpha → 整张图“全透明”
    const naive = await (await postBinary(base, '/api/analyze', buffer)).json();
    assert.equal(naive.source.colorSpace, 'cmyk');
    assert.equal(naive.empty, false, 'CMYK 图片不应被判为全透明');
    assert.equal(naive.bounds.width, width, 'JPEG 无 alpha，整图都算内容');

    // 配合颜色背景模式即可精确找到白底上的主体
    const trimmed = await (
      await postBinary(base, '/api/analyze', buffer, { matchColor: 'true', backgroundColor: '#ffffff', colorTolerance: 40 })
    ).json();
    assert.ok(Math.abs(trimmed.bounds.x - rect.x) <= 2, `x 偏差过大: ${trimmed.bounds.x}`);
    assert.ok(Math.abs(trimmed.bounds.y - rect.y) <= 2, `y 偏差过大: ${trimmed.bounds.y}`);
    assert.ok(Math.abs(trimmed.bounds.width - rect.width) <= 4, `宽度偏差过大: ${trimmed.bounds.width}`);
    assert.ok(Math.abs(trimmed.bounds.height - rect.height) <= 4, `高度偏差过大: ${trimmed.bounds.height}`);
  });
});

test('调色板 PNG（color type 3）同样走 RGBA 规范化路径', async () => {
  const { buffer: source, rect } = await pngFixture();
  const palette = await sharp(source).png({ palette: true, colours: 16 }).toBuffer();
  const meta = await sharp(palette).metadata();
  assert.equal(meta.isPalette, true);

  await withServer(async (base) => {
    const body = await (await postBinary(base, '/api/analyze', palette)).json();
    assert.equal(body.source.isPalette, true);
    assert.deepEqual(body.bounds, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });

    const cropped = await postBinary(base, '/api/crop', palette, { format: 'png' });
    const out = Buffer.from(await cropped.arrayBuffer());
    const outMeta = await sharp(out).metadata();
    assert.equal(outMeta.width, rect.width);
    assert.equal(outMeta.height, rect.height);
  });
});

test('非图片数据 → 415，缺图 → 400，未知路由 → 404', async () => {
  await withServer(async (base) => {
    const junk = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('这不是图片'),
    });
    assert.equal(junk.status, 415);
    assert.equal((await junk.json()).error.code, 'UNSUPPORTED_FORMAT');

    const missing = await postJson(base, '/api/analyze', { hello: 'world' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'MISSING_IMAGE');

    const notFound = await fetch(`${base}/api/nope`);
    assert.equal(notFound.status, 404);
  });
});

test('不支持的输出格式会显式报错', async () => {
  const { buffer } = await pngFixture();
  await withServer(async (base) => {
    const res = await postBinary(base, '/api/crop', buffer, { format: 'tiff' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_FORMAT');
  });
});

test('示例图片接口：列出并读取仓库内 samples（含中文名）', async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/samples`)).json();
    assert.ok(Array.isArray(list.samples));
    if (list.samples.length === 0) return; // 未放样例时不强求

    const sample = list.samples[0];
    const res = await fetch(`${base}${sample.url}`);
    assert.equal(res.status, 200);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(buffer.length, sample.bytes);

    const traversal = await fetch(`${base}/api/samples/${encodeURIComponent('../package.json')}`);
    assert.equal(traversal.status, 400);
  });
});
