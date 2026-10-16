import test from 'node:test';
import assert from 'node:assert/strict';

import { mse, psnr, ssim, toGray } from './metrics.js';

/** 造一张 w×h 的纯色/渐变 RGBA 图。 */
function image(width, height, fill = 128) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
    const v = typeof fill === 'function' ? fill(i % width, Math.floor(i / width)) : fill;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { width, height, data };
}

test('mse：完全相同为 0，固定偏移可精确计算', () => {
  const a = image(4, 4, 100);
  const b = image(4, 4, 110);
  assert.equal(mse(a, a), 0);
  assert.equal(mse(a, b), 100, '(110-100)² = 100');
});

test('mse/psnr：区域限定只看指定范围', () => {
  const clean = image(10, 10, 100);
  const dirty = image(10, 10, 100);
  // 只污染右下角 2×2
  for (let y = 8; y < 10; y += 1) {
    for (let x = 8; x < 10; x += 1) {
      const p = (y * 10 + x) * 4;
      dirty.data[p] = 200;
      dirty.data[p + 1] = 200;
      dirty.data[p + 2] = 200;
    }
  }
  assert.equal(mse(clean, dirty, { region: { x: 0, y: 0, width: 5, height: 5 } }), 0);
  assert.equal(mse(clean, dirty, { region: { x: 8, y: 8, width: 2, height: 2 } }), 10000);
});

test('psnr：完全一致为 Infinity，差距越大值越小', () => {
  const clean = image(8, 8, 100);
  const same = image(8, 8, 100);
  const near = image(8, 8, 101);
  const far = image(8, 8, 160);
  assert.equal(psnr(clean, same), Infinity);
  assert.ok(psnr(clean, near) > psnr(clean, far));
  assert.ok(psnr(clean, far) > 0);
});

test('toGray：按 Rec.601 加权', () => {
  const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
  const gray = toGray(img);
  assert.ok(Math.abs(gray.data[0] - 76.245) < 0.01);
});

test('ssim：完全一致为 1，加噪后显著下降且范围合法', () => {
  const clean = image(32, 32, (x, y) => 40 + ((x * 3 + y * 5) % 180));
  const same = { width: 32, height: 32, data: new Uint8ClampedArray(clean.data) };
  assert.ok(Math.abs(ssim(clean, same) - 1) < 1e-9);

  const noisy = { width: 32, height: 32, data: new Uint8ClampedArray(clean.data) };
  for (let i = 0; i < noisy.data.length; i += 4) {
    const n = (i / 4) % 2 === 0 ? 60 : -60;
    noisy.data[i] = Math.max(0, Math.min(255, noisy.data[i] + n));
    noisy.data[i + 1] = Math.max(0, Math.min(255, noisy.data[i + 1] + n));
    noisy.data[i + 2] = Math.max(0, Math.min(255, noisy.data[i + 2] + n));
  }
  const value = ssim(clean, noisy);
  assert.ok(value > 0 && value < 1, `SSIM 应落在 (0,1)，实际 ${value}`);
  assert.ok(value < 0.95, '明显噪声应当让 SSIM 明显下降');
});

test('ssim 支持区域限定，尺寸不一致时显式报错', () => {
  const clean = image(16, 16, 120);
  const dirty = image(16, 16, 120);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const p = (y * 16 + x) * 4;
      if (x < 8) {
        dirty.data[p] = 40;
        dirty.data[p + 1] = 40;
        dirty.data[p + 2] = 40;
      }
    }
  }
  // 只在左半边退化
  assert.ok(ssim(clean, dirty, { region: { x: 0, y: 0, width: 8, height: 16 } }) < 0.9);
  // 右半边完全一致；把区域取在离边界一个窗口半径之外，SSIM 应当精确等于 1
  assert.ok(Math.abs(ssim(clean, dirty, { region: { x: 13, y: 0, width: 3, height: 16 } }) - 1) < 1e-9);
  // 紧贴边界时滑动窗口会跨越到退化区域，因此不再等于 1（这是 SSIM 的固有行为）
  assert.ok(ssim(clean, dirty, { region: { x: 8, y: 0, width: 3, height: 16 } }) < 1);
  assert.throws(() => ssim(clean, image(8, 8, 0)), /尺寸不一致/);
});
