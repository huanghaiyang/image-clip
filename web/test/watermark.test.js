/**
 * 掩膜本地编辑的单元测试（画笔 / 橡皮 / 羽化 / 覆盖统计）。
 *
 * 这些函数是水印模式里唯一“浏览器与后端都会依赖”的本地计算：
 * 涂抹结果最终会被编码成灰度 PNG 提交给 /api/watermark/remove，
 * 一旦这里算错，用户看到的叠加层和实际去除范围就会不一致，
 * 因此用 node:test 直接跑纯逻辑，不依赖 DOM。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVER_HINT,
  WatermarkApiError,
  createMask,
  detectWatermark,
  fetchHealth,
  maskBounds,
  maskCoverage,
  removeWatermark,
  strokeMask,
  featherMask,
} from '../src/lib/watermark.js';

const W = 32;
const H = 8;

function freshMask() {
  return createMask(W, H);
}

test('createMask 尺寸与初始值正确', () => {
  const mask = createMask(W, H);
  assert.equal(mask.length, W * H);
  assert.ok(mask.every((v) => v === 0));

  const filled = createMask(W, H, 255);
  assert.ok(filled.every((v) => v === 255));
});

test('画笔写入掩膜并返回受影响包围盒', () => {
  const mask = freshMask();
  const box = strokeMask(mask, W, H, { x: 5, y: 3 }, { x: 5, y: 3 }, { radius: 2 });

  // 包围盒取“可能被圆心扫描到的像素”外扩，只要求覆盖真实改动且不越界
  assert.ok(box.x <= 3 && box.y <= 1 && box.x + box.width >= 8 && box.y + box.height >= 6);
  assert.equal(mask[3 * W + 5], 255, '笔心应被涂上');
  assert.equal(mask[0], 0, '笔刷外的像素不应被改动');
  assert.equal(mask[3 * W + 7], 255, '半径 2 应覆盖到 x=7');
  assert.equal(mask[3 * W + 8], 0, '半径 2 不应越过 x=8');
  assert.ok(maskCoverage(mask) > 0 && maskCoverage(mask) < 0.1);
});

test('连续两点之间自动补点（快速拖动不留断点）', () => {
  const mask = freshMask();
  strokeMask(mask, W, H, { x: 2, y: 4 }, { x: 29, y: 4 }, { radius: 2 });
  for (let x = 2; x <= 29; x += 1) {
    assert.equal(mask[4 * W + x], 255, `x=${x} 处不应有断点`);
  }
});

test('橡皮把掩膜清回 0', () => {
  const mask = freshMask();
  strokeMask(mask, W, H, { x: 10, y: 4 }, { x: 10, y: 4 }, { radius: 3 });
  assert.equal(mask[4 * W + 10], 255);

  const box = strokeMask(mask, W, H, { x: 10, y: 4 }, { x: 10, y: 4 }, { radius: 1, erase: true });
  assert.ok(box.width <= 4 && box.height <= 4, '半径 1 的橡皮包围盒不应超过 4×4');
  assert.equal(mask[4 * W + 10], 0, '橡皮应把笔心擦回 0');
  assert.equal(mask[2 * W + 10], 255, '橡皮半径外的像素应保留');
});

test('涂抹完全落在画布外时返回 null（调用方据此跳过重绘）', () => {
  const mask = freshMask();
  const box = strokeMask(mask, W, H, { x: -10, y: -10 }, { x: -10, y: -10 }, { radius: 2 });
  assert.equal(box, null);
  assert.equal(maskCoverage(mask), 0);
});

test('坐标越界时被裁剪到画布内，不抛异常', () => {
  const mask = freshMask();
  const box = strokeMask(mask, W, H, { x: -1, y: 2 }, { x: 1, y: 2 }, { radius: 4 });
  assert.ok(box.x >= 0 && box.y >= 0);
  assert.ok(box.x + box.width <= W);
  assert.ok(box.y + box.height <= H);
});

test('maskCoverage / maskBounds 与掩膜内容一致', () => {
  const mask = freshMask();
  strokeMask(mask, W, H, { x: 4, y: 2 }, { x: 4, y: 2 }, { radius: 1 });
  assert.deepEqual(maskBounds(mask, W, H), { x: 3, y: 1, width: 3, height: 3 });
  assert.ok(Math.abs(maskCoverage(mask) - 5 / (W * H)) < 1e-9);

  assert.equal(maskBounds(freshMask(), W, H), null);
  assert.equal(maskCoverage(freshMask()), 0);
});

test('羽化把硬边摊成渐变，核心保持实心，且不修改原掩膜', () => {
  const mask = freshMask();
  strokeMask(mask, W, H, { x: 16, y: 4 }, { x: 16, y: 4 }, { radius: 4 });
  const before = Uint8Array.from(mask);

  const soft = featherMask(mask, W, H, 2);
  assert.deepEqual(Array.from(mask), Array.from(before), 'featherMask 必须是纯函数');
  assert.equal(soft[4 * W + 16], 255, '笔心必须保持实心，否则去除会留下残影');

  let gradient = 0;
  let grew = 0;
  for (let i = 0; i < soft.length; i += 1) {
    if (soft[i] > 0 && soft[i] < 255) gradient += 1;
    if (soft[i] > 0 && before[i] === 0) grew += 1;
    assert.ok(soft[i] >= before[i], '羽化结果不应把任何原本要去除的像素减弱');
  }
  assert.ok(gradient > 0, '边缘应出现中间值（软过渡）');
  assert.ok(grew > 0, '软过渡应扩展到笔画外侧');
  assert.equal(soft[0], 0, '远离掩膜的区域不受影响');
});

test('featherMask 接受半径为 0 时不产生副作用', () => {
  const mask = freshMask();
  strokeMask(mask, W, H, { x: 8, y: 4 }, { x: 8, y: 4 }, { radius: 2 });
  const soft = featherMask(mask, W, H, 0);
  assert.equal(soft[4 * W + 8], 255);
  assert.equal(soft[4 * W], 0);
});

// ------------------------------------------------------------- API 客户端

function jsonResponse(body, init = {}) {
  return {
    ok: init.status ? init.status < 400 : true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  };
}

test('detectWatermark 把参数放在 query 上，并转发服务端掩膜字段', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      method: 'overlay',
      usedMethods: ['overlay'],
      confidence: 0.8,
      coverage: 0.01,
      elapsedMs: 12,
      mask: { width: 2, height: 2, dataUrl: 'data:image/png;base64,AA==' },
      rle: { width: 2, height: 2, runs: [0, 4] },
      boxes: [{ x: 0, y: 0, width: 1, height: 1, score: 0.8, source: 'overlay' }],
      diagnostics: {},
    });
  };

  const body = await detectWatermark(
    { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) },
    { method: 'overlay', sensitivity: 70, dilate: 3, minArea: 12, maxCoverage: 0.5 },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/api\/watermark\/detect\?/);
  const query = new URLSearchParams(calls[0].url.split('?')[1]);
  assert.equal(query.get('method'), 'overlay');
  assert.equal(query.get('sensitivity'), '70');
  assert.equal(query.get('dilate'), '3');
  assert.equal(query.get('minArea'), '12');
  assert.equal(query.get('maxCoverage'), '0.5');
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png', '无模板时应走二进制体');
  assert.equal(body.mask.dataUrl, 'data:image/png;base64,AA==');
});

test('模板模式改用 JSON 体（模板图与源图无法共存在一个二进制体里）', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ method: 'template', mask: null, boxes: [] });
  };

  // 与 composable 的真实调用一致：模板同时出现在图片载荷与 options 里
  await detectWatermark(
    { dataUrl: 'data:image/png;base64,AAA', template: 'data:image/png;base64,BBB' },
    { method: 'template', template: 'data:image/png;base64,BBB' },
  );

  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image, 'data:image/png;base64,AAA');
  assert.equal(body.template, 'data:image/png;base64,BBB');
});

test('removeWatermark 传了掩膜就走 JSON 体，并保留二进制结果', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      blob: async () => new Blob([new Uint8Array([9, 9])], { type: 'image/png' }),
    };
  };

  const result = await removeWatermark(
    { blob: new Blob([new Uint8Array([1])], { type: 'image/png' }) },
    { engine: 'opencv', format: 'png', quality: 92, inpaintRadius: 4, feather: 2, watermarkColor: 'white' },
    'data:image/png;base64,MASK',
  );

  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.mask, 'data:image/png;base64,MASK');

  const query = new URLSearchParams(calls[0].url.split('?')[1]);
  assert.equal(query.get('engine'), 'opencv');
  assert.equal(query.get('format'), 'png');
  assert.equal(query.get('inpaintRadius'), '4');
  assert.equal(query.get('watermarkColor'), 'white');
  assert.equal(query.get('quality'), null, 'PNG 是无损输出，不应带 quality');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.blob.size, 2);
});

test('JSON 体两个字段都必须存在（否则服务端以 MISSING_IMAGE 拒收）', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      blob: async () => new Blob([new Uint8Array([1])]),
    };
  };

  // 组合成 composable 里的 imagePayloadForJson() 形态
  const payload = { dataUrl: 'data:image/webp;base64,IMG', template: '' };
  await removeWatermark(payload, { engine: 'unopencv' }, 'data:image/png;base64,MASK');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image, 'data:image/webp;base64,IMG');
  assert.equal(body.mask, 'data:image/png;base64,MASK');
  assert.notEqual(body.image, undefined, 'image 绝不能是 undefined');

  // 没有图片数据时应立刻抛错，而不是发一个服务端必然拒绝的请求
  await assert.rejects(
    () => removeWatermark({ dataUrl: '' }, {}, 'data:image/png;base64,MASK'),
    (err) => {
      assert.ok(err instanceof WatermarkApiError);
      return true;
    },
  );
});

test('服务端错误响应被翻译成可读的 WatermarkApiError', async () => {  globalThis.fetch = async () => jsonResponse({ error: { message: '模型未就绪' } }, { status: 503 });

  await assert.rejects(
    () => detectWatermark({ blob: new Blob([new Uint8Array([1])]) }, {}),
    (err) => {
      assert.ok(err instanceof WatermarkApiError);
      assert.equal(err.message, '模型未就绪');
      assert.equal(err.status, 503);
      return true;
    },
  );
});

test('health 不可用时给出明确的启动提示，而不是静默失败', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  await assert.rejects(
    () => fetchHealth(),
    (err) => {
      assert.ok(err instanceof WatermarkApiError);
      assert.match(err.message, /npm run dev:server/);
      assert.equal(err.message.includes(SERVER_HINT), true);
      return true;
    },
  );
});
