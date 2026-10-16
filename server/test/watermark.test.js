/**
 * 水印识别 / 去除的集成测试。
 *
 * 思路：**合成已知水印**（作者自己画上去、真值掩膜与不透明度都已知），
 * 这样检测可以用 IoU/精确率/召回率衡量，去除可以用 PSNR/SSIM 衡量，
 * 而且能验证「掩膜外的像素一个都不能动」这条硬性不变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { analyzeWatermark, decodeMaskInput, maskToPng, removeWatermark } from '../src/watermark.js';
import { compareMasks } from '../../shared/watermark/mask.js';
import { psnr, ssim } from '../../shared/watermark/metrics.js';
import { resolveModelPath } from '../src/lama.js';
import { DEFAULT_DETECT_OPTIONS } from '../../shared/watermark/detect.js';

const W = 640;
const H = 480;

/** 有纹理、有结构的"干净照片"（避免纯色图上自欺欺人）。 */
function cleanImage(width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      data[p] = 70 + 90 * (x / width) + 18 * Math.sin(x / 5);
      data[p + 1] = 90 + 70 * (y / height) + 14 * Math.cos(y / 7);
      data[p + 2] = 150 - 40 * ((x + y) / (width + height)) + 22 * Math.sin((x + y) / 9);
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 叠半透明白色"文字条"，返回带水印图 / 真值掩膜 / 干净图。 */
function withWatermark({ alpha = 0.35, color = [255, 255, 255], bars } = {}) {
  const clean = cleanImage();
  const dirty = { width: clean.width, height: clean.height, data: new Uint8ClampedArray(clean.data) };
  const mask = new Uint8Array(clean.width * clean.height);
  const list = bars ?? [0, 1, 2, 3].map((k) => [120 + k * 6, 300 + k * 24, 460 + k * 6, 312 + k * 24]);
  for (const [x0, y0, x1, y1] of list) {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = (y * clean.width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          dirty.data[p + c] = dirty.data[p + c] * (1 - alpha) + color[c] * alpha;
        }
        mask[y * clean.width + x] = 255;
      }
    }
  }
  return { clean, dirty, truth: { width: clean.width, height: clean.height, data: mask } };
}

const toPng = (image) =>
  sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();

const fromBuffer = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};

test('半透明水印：检测 IoU 应接近 1，不透明度估计接近真值', async () => {
  const { dirty, truth } = withWatermark({ alpha: 0.35 });
  const png = await toPng(dirty);

  const result = await analyzeWatermark(png, { method: 'auto', sensitivity: 60 });
  assert.equal(result.method, 'overlay');
  assert.ok(result.usedMethods.includes('overlay'));

  const cmp = compareMasks(result.mask, truth);
  assert.ok(cmp.iou > 0.95, `IoU 只有 ${cmp.iou.toFixed(3)}`);
  assert.ok(cmp.precision > 0.95, `精确率只有 ${cmp.precision.toFixed(3)}`);
  assert.ok(cmp.recall > 0.95, `召回率只有 ${cmp.recall.toFixed(3)}`);
  assert.ok(
    Math.abs(result.estimatedAlpha - 0.35) < 0.06,
    `不透明度估计 ${result.estimatedAlpha}，真值 0.35`,
  );
  // 亮极性胜出，且没有把笔画间隙误检进来
  assert.equal(result.diagnostics.overlay.polarity, 'bright');
});

test('反混合引擎：掩膜区 PSNR 从约 20dB 提升到 45dB 以上，且掩膜外一像素不动', async () => {
  const { clean, dirty, truth } = withWatermark({ alpha: 0.35 });
  const png = await toPng(dirty);

  const result = await removeWatermark(png, { engine: 'auto' });
  assert.equal(result.engine, 'unblend');
  assert.ok(Math.abs(result.alpha - 0.35) < 0.02, `α=${result.alpha}`);
  assert.equal(result.watermarkColor, '#ffffff');
  assert.equal(result.integrity.changedOutsideMask, 0, '掩膜外的像素必须完全不变');

  const output = await fromBuffer(result.buffer);
  const before = psnr(clean, dirty);
  const after = psnr(clean, output);
  assert.ok(after > 45, `去除后 PSNR 只有 ${after.toFixed(2)}dB（带水印时 ${before.toFixed(2)}dB）`);
  assert.ok(after - before > 20, '提升幅度应非常明显');
  assert.ok(ssim(clean, output) > 0.99);
  assert.ok(compareMasks(truth, truth).iou === 1);
});

test('不同不透明度的半透明水印都能还原（0.2 / 0.45 / 0.65）', async () => {
  for (const alpha of [0.2, 0.45, 0.65]) {
    const { clean, dirty } = withWatermark({ alpha });
    const result = await removeWatermark(await toPng(dirty), { engine: 'auto' });
    assert.equal(result.engine, 'unblend', `α=${alpha} 时应选反混合引擎`);
    assert.ok(Math.abs(result.alpha - alpha) < 0.03, `α 估计 ${result.alpha}，真值 ${alpha}`);
    const output = await fromBuffer(result.buffer);
    assert.ok(psnr(clean, output) > 42, `α=${alpha} 时 PSNR 仅 ${psnr(clean, output).toFixed(2)}dB`);
  }
});

test('不透明水印：反混合不适用，显式掩膜交给修补引擎，只改动掩膜内', async () => {
  const block = [200, 180, 440, 240]; // 一整块不透明白块
  const { dirty } = withWatermark({ alpha: 1, color: [255, 255, 255], bars: [block] });
  const png = await toPng(dirty);

  // 大面积不透明标记自动检测覆盖不到（见 README 的已知边界），
  // 这类素材的推荐路径是模板匹配 / 框选 / 画笔给出掩膜。
  const mask = new Uint8Array(W * H);
  for (let y = block[1]; y <= block[3]; y += 1) {
    for (let x = block[0]; x <= block[2]; x += 1) mask[y * W + x] = 255;
  }
  const maskPng = await maskToPng({ width: W, height: H, data: mask });

  const result = await removeWatermark(png, { engine: 'opencv', inpaintRadius: 6, mask: maskPng });
  assert.equal(result.engine, 'opencv');
  assert.equal(result.source.width, W);
  const output = await fromBuffer(result.buffer);
  assert.equal(output.width, W);
  assert.equal(output.height, H);
  assert.equal(result.integrity.changedOutsideMask, 0, '掩膜外不能有改动');
  // 修补区域应当不再是纯白
  const center = (210 * W + 320) * 4;
  assert.ok(output.data[center] < 250, `修补后白块中心仍为 ${output.data[center]}`);
});

test('显式传入掩膜（模拟前端画笔）时跳过自动检测', async () => {
  const { dirty, truth } = withWatermark({ alpha: 0.35 });
  const png = await toPng(dirty);
  const maskPng = await maskToPng(truth);

  const result = await removeWatermark(png, { engine: 'unblend', mask: maskPng });
  assert.equal(result.detection, null, '提供了掩膜就不该再跑检测');
  assert.ok(result.coverage > 0.04);
  assert.equal(result.integrity.changedOutsideMask, 0);
});

test('掩膜尺寸与图片不一致时会最近邻对齐，而不是报错', async () => {
  const { dirty, truth } = withWatermark({ alpha: 0.35 });
  const png = await toPng(dirty);
  const halfMask = await sharp(Buffer.from(truth.data), { raw: { width: W, height: H, channels: 1 } })
    .resize(W / 2, H / 2, { kernel: 'nearest' })
    .png()
    .toBuffer();

  const decoded = await decodeMaskInput(halfMask, W, H);
  assert.equal(decoded.width, W);
  assert.equal(decoded.height, H);
  const result = await removeWatermark(png, { mask: halfMask });
  assert.ok(result.coverage > 0.03);
});

test('空掩膜 → EMPTY_MASK 明确报错', async () => {
  const { dirty } = withWatermark();
  const png = await toPng(dirty);
  const emptyMask = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .greyscale()
    .png()
    .toBuffer();
  await assert.rejects(() => removeWatermark(png, { mask: emptyMask }), /掩膜为空/);
});

test('干净图（无半透明叠加）不应产生误检掩膜', async () => {
  // 1) 合成干净图
  const clean = cleanImage();
  const png = await toPng(clean);
  for (const sensitivity of [20, 50, 80]) {
    const result = await analyzeWatermark(png, { method: 'auto', sensitivity });
    assert.ok(
      result.coverage < 0.005,
      `灵敏度 ${sensitivity} 时合成干净图误检覆盖率 ${(result.coverage * 100).toFixed(2)}% 偏高`,
    );
  }

  // 2) 真实素材：三张蝴蝶图都没有水印，自动检测必须"什么都不报"
  //    （否则界面会出现 confidence=100% + coverage=0% 的矛盾结果）
  for (const name of ['蝴蝶-01.webp', '蝴蝶-02.webp', '蝴蝶-03.webp']) {
    const file = path.resolve(import.meta.dirname, '../../samples', name);
    const buffer = await fs.promises.readFile(file);
    const result = await analyzeWatermark(buffer, { method: 'auto', sensitivity: 50 });
    assert.equal(result.coverage, 0, `${name} 不应检测到水印（覆盖率 ${(result.coverage * 100).toFixed(2)}%）`);
    assert.equal(result.confidence, 0, `${name} 无结果时置信度必须为 0`);
    assert.equal(result.boxes.length, 0, `${name} 无结果时不应返回候选框`);
  }
});

test('模板匹配：给一张水印图能定位到图中的位置', async () => {
  const clean = cleanImage(320, 240);
  const tw = 60;
  const th = 20;
  // 模板必须有内部结构（两条杠），纯色模板在 TM_CCOEFF 下是退化的
  const templateData = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      const p = (y * tw + x) * 4;
      const on = y < 6 || (y >= 12 && y < 18);
      const v = on ? 255 : 40;
      templateData[p] = v;
      templateData[p + 1] = v;
      templateData[p + 2] = v;
      templateData[p + 3] = 255;
    }
  }
  // 把模板以 0.5 不透明度贴到 (200,150)
  const dirty = { ...clean, data: new Uint8ClampedArray(clean.data) };
  const px = 200;
  const py = 150;
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      const src = (y * tw + x) * 4;
      const dst = ((py + y) * clean.width + px + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        dirty.data[dst + c] = dirty.data[dst + c] * 0.5 + templateData[src + c] * 0.5;
      }
    }
  }

  const imageBuffer = await toPng(dirty);
  const templateBuffer = await toPng({ width: tw, height: th, data: templateData });
  const result = await analyzeWatermark(imageBuffer, {
    method: 'template',
    sensitivity: 70,
    templateBuffer: templateBuffer.toString('base64'),
  });

  assert.equal(result.method, 'template');
  assert.equal(result.diagnostics.template.flatTemplate, false);
  assert.ok(result.diagnostics.template.matches >= 1, '至少应当匹配到一次');
  const box = result.boxes[0];
  assert.ok(Math.abs(box.x - px) <= 4 && Math.abs(box.y - py) <= 4, `匹配位置偏差过大：${JSON.stringify(box)}`);
});

test('LaMa：模型缺失时明确回退到 opencv，而不是整个请求失败', async () => {
  const block = [200, 180, 440, 240];
  const { dirty } = withWatermark({ alpha: 1, bars: [block] });
  const png = await toPng(dirty);
  const mask = new Uint8Array(W * H);
  for (let y = block[1]; y <= block[3]; y += 1) {
    for (let x = block[0]; x <= block[2]; x += 1) mask[y * W + x] = 255;
  }
  const maskPng = await maskToPng({ width: W, height: H, data: mask });

  const originalDir = process.env.IMAGE_CLIP_MODEL_DIR;
  const originalModel = process.env.IMAGE_CLIP_LAMA_MODEL;
  const emptyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'image-clip-no-model-'));
  process.env.IMAGE_CLIP_MODEL_DIR = emptyDir;
  delete process.env.IMAGE_CLIP_LAMA_MODEL;
  try {
    assert.equal(resolveModelPath(), null, '测试前提：模型目录里没有模型');
    // 显式给掩膜 + engine=lama：装了模型才会走 lama，没装就必须回退
    const result = await removeWatermark(png, { engine: 'lama', mask: maskPng });
    assert.equal(result.engine, 'opencv', '没有模型时应回退到 opencv');
    assert.equal(result.integrity.changedOutsideMask, 0);
  } finally {
    if (originalDir === undefined) delete process.env.IMAGE_CLIP_MODEL_DIR;
    else process.env.IMAGE_CLIP_MODEL_DIR = originalDir;
    if (originalModel !== undefined) process.env.IMAGE_CLIP_LAMA_MODEL = originalModel;
    await fs.promises.rm(emptyDir, { recursive: true, force: true });
  }
});

test('LaMa：装了模型时能真的跑通推理（无模型则跳过）', async (t) => {
  if (!resolveModelPath()) {
    t.skip('未下载 LaMa 模型（npm run model:lama）');
    return;
  }
  // 小图 + 小掩膜 → 只需一个 512 窗口，CPU 上约 3 秒
  const width = 420;
  const height = 320;
  const clean = cleanImage(width, height);
  const dirty = { width, height, data: new Uint8ClampedArray(clean.data) };
  const mask = new Uint8Array(width * height);
  for (let y = 150; y < 190; y += 1) {
    for (let x = 150; x < 260; x += 1) {
      const p = (y * width + x) * 4;
      dirty.data[p] = 255;
      dirty.data[p + 1] = 255;
      dirty.data[p + 2] = 255;
      mask[y * width + x] = 255;
    }
  }
  const png = await toPng(dirty);
  const maskPng = await maskToPng({ width, height, data: mask });

  const result = await removeWatermark(png, { engine: 'lama', mask: maskPng });
  assert.equal(result.engine, 'lama');
  assert.ok(result.patches >= 1, '应当至少跑了一个 512 窗口');

  const output = await fromBuffer(result.buffer);
  assert.equal(output.width, width);
  assert.equal(output.height, height);
  assert.equal(result.integrity.changedOutsideMask, 0, '掩膜外不能有改动');
  // 掩膜内应当被改写（不再是纯白）
  const inside = (170 * width + 200) * 4;
  assert.ok(output.data[inside] < 250, `LaMa 应当填充了掩膜区域（当前 ${output.data[inside]}）`);
});

test('检测参数契约与默认值保持一致', () => {
  assert.equal(DEFAULT_DETECT_OPTIONS.dilate, 0, '检测阶段默认不膨胀，避免反混合把干净像素算暗');
  assert.equal(DEFAULT_DETECT_OPTIONS.polarity, 'auto');
});
