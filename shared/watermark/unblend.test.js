import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateWatermarkParams, isUnblendPlausible, parseWatermarkColor, unblendImage } from './unblend.js';
import { psnr, ssim } from './metrics.js';
import { createMask } from './mask.js';

const W = 256;
const H = 256;

/** 有结构、有纹理的"干净背景"（避免用纯色图自欺欺人）。 */
function cleanImage() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 4;
      data[p] = 60 + 100 * (x / W) + 25 * Math.sin(x / 7);
      data[p + 1] = 80 + 80 * (y / H) + 20 * Math.cos(y / 9);
      data[p + 2] = 140 - 50 * ((x + y) / (2 * W)) + 30 * Math.sin((x + y) / 11);
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** 叠一层半透明"文字状"水印，返回带水印图与真值掩膜。 */
function applyWatermark(image, { alpha, color = [255, 255, 255], strokes }) {
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const mask = createMask(image.width, image.height);
  for (const [x0, y0, x1, y1] of strokes) {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = (y * image.width + x) * 4;
        for (let c = 0; c < 3; c += 1) out.data[p + c] = out.data[p + c] * (1 - alpha) + color[c] * alpha;
        mask.data[y * image.width + x] = 255;
      }
    }
  }
  return { image: out, mask };
}

const TEXT_STROKES = [
  [40, 150, 200, 158],
  [44, 168, 204, 176],
  [48, 186, 208, 194],
  [52, 204, 212, 212],
];

test('parseWatermarkColor：white / black / #rrggbb / auto', () => {
  assert.deepEqual(parseWatermarkColor('white'), [255, 255, 255]);
  assert.deepEqual(parseWatermarkColor('black'), [0, 0, 0]);
  assert.deepEqual(parseWatermarkColor('#0d99ff'), [13, 153, 255]);
  assert.deepEqual(parseWatermarkColor('0d99ff'), [13, 153, 255]);
  assert.equal(parseWatermarkColor('auto'), null);
  assert.equal(parseWatermarkColor('不是颜色'), null);
});

test('估计不透明度：白色半透明水印能还原出真值 α', () => {
  const clean = cleanImage();
  const TRUE_ALPHA = 0.35;
  const { image: dirty, mask } = applyWatermark(clean, { alpha: TRUE_ALPHA, strokes: TEXT_STROKES });

  const params = estimateWatermarkParams(dirty, mask, { watermarkColor: 'white' });
  assert.ok(Math.abs(params.alpha - TRUE_ALPHA) < 0.02, `α 估计 ${params.alpha}，真值 ${TRUE_ALPHA}`);
  assert.deepEqual(params.color, [255, 255, 255]);
  assert.equal(params.criterion, 'boundary');
  assert.ok(params.confidence > 0.3, `置信度过低：${params.confidence}`);
  assert.equal(isUnblendPlausible(params), true);
});

test('反混合还原：掩膜区的 PSNR 应当从十几 dB 提升到 40dB 以上', () => {
  const clean = cleanImage();
  const { image: dirty, mask } = applyWatermark(clean, { alpha: 0.35, strokes: TEXT_STROKES });
  const before = psnr(clean, dirty);

  const params = estimateWatermarkParams(dirty, mask, { watermarkColor: 'white' });
  const recovered = unblendImage(dirty, mask, params);
  const after = psnr(clean, recovered);

  assert.ok(before < 30, `带水印图的 PSNR 本来就该不高，实际 ${before}`);
  assert.ok(after > 40, `反混合后应显著提升，实际 ${after.toFixed(2)}dB（之前 ${before.toFixed(2)}dB）`);
  assert.ok(ssim(clean, recovered) > 0.99, 'SSIM 应接近 1');
  // 掩膜外的像素必须逐字节不变
  for (let i = 0, p = 0; i < mask.data.length; i += 1, p += 4) {
    if (mask.data[i] > 0) continue;
    for (let c = 0; c < 3; c += 1) assert.equal(recovered.data[p + c], dirty.data[p + c]);
  }
});

test('不同不透明度都能估准（0.2 / 0.5 / 0.7）', () => {
  const clean = cleanImage();
  for (const truth of [0.2, 0.5, 0.7]) {
    const { image: dirty, mask } = applyWatermark(clean, { alpha: truth, strokes: TEXT_STROKES });
    const params = estimateWatermarkParams(dirty, mask, { watermarkColor: 'white' });
    assert.ok(Math.abs(params.alpha - truth) < 0.03, `α=${truth} 时估成 ${params.alpha}`);
    const recovered = unblendImage(dirty, mask, params);
    assert.ok(psnr(clean, recovered) > 38, `α=${truth} 时还原 PSNR 只有 ${psnr(clean, recovered).toFixed(2)}dB`);
  }
});

test('灰色水印的颜色也能被搜出来', () => {
  const clean = cleanImage();
  const { image: dirty, mask } = applyWatermark(clean, { alpha: 0.45, color: [128, 128, 128], strokes: TEXT_STROKES });
  const params = estimateWatermarkParams(dirty, mask);
  assert.ok(Math.abs(params.alpha - 0.45) < 0.03, `α 估计 ${params.alpha}`);
  assert.ok(Math.abs(params.color[0] - 128) <= 8, `颜色估计 ${params.color[0]}，真值 128`);
  assert.ok(psnr(clean, unblendImage(dirty, mask, params)) > 36);
});

test('没有水印时置信度低，不应被误判为可反混合', () => {
  const clean = cleanImage();
  const mask = createMask(W, H);
  // 随便框一块干净的背景
  for (let y = 150; y <= 212; y += 1) for (let x = 40; x <= 212; x += 1) mask.data[y * W + x] = 255;
  const params = estimateWatermarkParams(clean, mask, { watermarkColor: 'white' });
  assert.ok(params.confidence < 0.999);
  // 能量最优解会退化到"不改变画面"，因此还原结果与原因几乎相同
  const recovered = unblendImage(clean, mask, params);
  assert.ok(psnr(clean, recovered, { region: { x: 40, y: 150, width: 172, height: 62 } }) > 30);
});

test('软掩膜：按覆盖度缩放不透明度，边缘过渡自然', () => {
  const clean = cleanImage();
  const { image: dirty, mask } = applyWatermark(clean, { alpha: 0.35, strokes: TEXT_STROKES });
  const hard = unblendImage(dirty, mask, { alpha: 0.35, color: [255, 255, 255] });

  const soft = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) };
  for (let i = 0; i < soft.data.length; i += 1) if (soft.data[i] > 0) soft.data[i] = 128; // 半覆盖
  const blended = unblendImage(dirty, soft, { alpha: 0.35, color: [255, 255, 255] });
  // 半覆盖时只应用一半的不透明度 → 结果应当落在原图与完全还原之间
  const p = (155 * W + 100) * 4;
  assert.ok(blended.data[p] > hard.data[p], '软掩膜修正力度更小');
  assert.ok(blended.data[p] < dirty.data[p], '但确实做了一部分修正');
});
