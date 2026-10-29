/**
 * shared/bgremove.js 单测：边框取色、漫水填充、选区限制、羽化与 alpha 应用。
 * 运行：node shared/bgremove.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMaskToRgba,
  buildBackgroundMask,
  colorDistance,
  colorToHex,
  detectBackgroundColors,
  erodeMask,
  blurMask,
  parseColor,
} from './bgremove.js';

/** 生成 width×height 的 RGBA，draw(x,y) 返回 [r,g,b,a]。 */
function makeImage(width, height, draw) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = draw(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

function pixelAt(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

test('颜色解析与距离', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor('#123456'), { r: 18, g: 52, b: 86 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3 });
  assert.equal(colorToHex({ r: 18, g: 52, b: 86 }), '#123456');
  assert.equal(colorDistance(255, 255, 255, '#ffffff'), 0);
  assert.ok(colorDistance(0, 0, 0, '#ffffff') > 200);
});

test('detectBackgroundColors：从边框识别主色，中心物体不参与', () => {
  const width = 8;
  const height = 6;
  const data = makeImage(width, height, (x, y) => (x >= 3 && x <= 4 && y >= 2 && y <= 3 ? [220, 30, 30] : [255, 255, 255]));
  const result = detectBackgroundColors(data, width, height, { ring: 2 });
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].hex, '#ffffff');
  assert.equal(result.colors[0].ratio, 1);
  assert.equal(result.transparentRatio, 0);
});

test('detectBackgroundColors：双色渐变底会给出两个候选色', () => {
  const width = 10;
  const height = 10;
  const data = makeImage(width, height, (x) => (x < 5 ? [250, 250, 250] : [30, 30, 30]));
  const result = detectBackgroundColors(data, width, height, { ring: 2, maxColors: 3 });
  assert.ok(result.colors.length >= 2, `期望至少两种候选色，实际 ${result.colors.length}`);
  assert.equal(result.colors[0].hex, '#fafafa');
  assert.ok(result.colors.some((c) => c.hex === '#1e1e1e'));
});

test('buildBackgroundMask：连通模式下只抠与边缘相连的底色', () => {
  const width = 8;
  const height = 6;
  const data = makeImage(width, height, (x, y) => (x >= 3 && x <= 4 && y >= 2 && y <= 3 ? [220, 30, 30] : [255, 255, 255]));
  const { mask, coverage, backgroundPixels } = buildBackgroundMask(data, width, height, {
    colors: ['#ffffff'],
    tolerance: 8,
    connected: true,
    feather: 0,
    erode: 0,
  });
  assert.equal(backgroundPixels, width * height - 4);
  assert.ok(Math.abs(coverage - (width * height - 4) / (width * height)) < 1e-9);
  assert.equal(mask[(2 * width) + 3], 0, '红色中心必须保留');
  assert.equal(mask[0], 255, '边角白色必须去除');
});

test('buildBackgroundMask：关闭连通性后会连内部同色区域一起去掉', () => {
  const width = 9;
  const height = 9;
  // 外白 → 黑环 → 内白；关闭连通性时内部白也会被抠掉
  const data = makeImage(width, height, (x, y) => {
    const inRing = x >= 2 && x <= 6 && y >= 2 && y <= 6;
    const inner = x >= 3 && x <= 5 && y >= 3 && y <= 5;
    if (inner) return [255, 255, 255];
    if (inRing) return [0, 0, 0];
    return [255, 255, 255];
  });

  const connected = buildBackgroundMask(data, width, height, {
    colors: ['#ffffff'],
    tolerance: 4,
    connected: true,
    feather: 0,
  });
  assert.equal(connected.mask[4 * width + 4], 0, '被黑环包围的白色不应被连通模式抠掉');

  const global = buildBackgroundMask(data, width, height, {
    colors: ['#ffffff'],
    tolerance: 4,
    connected: false,
    feather: 0,
  });
  assert.equal(global.mask[4 * width + 4], 255, '关闭连通性后内部白也会被去除');
});

test('buildBackgroundMask：透明像素天然算背景，套索可限制处理范围', () => {
  const width = 6;
  const height = 4;
  const data = makeImage(width, height, () => [0, 0, 0, 0]);
  const { mask } = buildBackgroundMask(data, width, height, {
    colors: ['#000000'],
    connected: false,
    feather: 0,
  });
  assert.equal(mask[0], 255, '透明像素应当被视为可移除');

  const white = makeImage(width, height, () => [255, 255, 255]);
  const selection = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width / 2; x += 1) selection[y * width + x] = 255;
  }
  const limited = buildBackgroundMask(white, width, height, {
    colors: ['#ffffff'],
    connected: false,
    feather: 0,
    selection,
    selectionMode: 'inside',
  });
  assert.equal(limited.mask[0], 255);
  assert.equal(limited.mask[width - 1], 0);
  assert.equal(limited.backgroundPixels, (width / 2) * height);
});

test('applyMaskToRgba：按掩膜缩放 alpha，不修改原数组', () => {
  const width = 3;
  const data = makeImage(width, 1, () => [10, 20, 30, 200]);
  const mask = new Uint8Array([0, 128, 255]);
  const result = applyMaskToRgba(data, width, 1, mask);
  assert.equal(result.data[3], 200);
  assert.equal(result.data[7], Math.round(200 * (1 - 128 / 255)));
  assert.equal(result.data[11], 0);
  assert.equal(data[11], 200, '原数组必须保持不变');
  assert.equal(result.removedPixels, 2);
});

test('applyMaskToRgba：反混合可去掉半透明边缘的底色污染', () => {
  // 前景 100% 红被白底覆盖成粉色（alpha=128 → 与白底混合后 255,128,128）
  const width = 1;
  const data = new Uint8ClampedArray([255, 128, 128, 128]);
  const mask = new Uint8Array([128]);
  const result = applyMaskToRgba(data, width, 1, mask, { decontaminate: true, colors: ['#ffffff'] });
  assert.equal(result.data[3], Math.round(128 * (1 - 128 / 255)));
  assert.equal(result.data[0], 255);
  assert.ok(result.data[1] < 40, `绿色分量应被还原为接近 0，实际 ${result.data[1]}`);
});

test('erodeMask / blurMask：收缩与羽化方向正确', () => {
  const mask = new Uint8Array(9 * 9);
  mask[4 * 9 + 4] = 255;
  const eroded = erodeMask(mask, 9, 9, 1);
  assert.equal(eroded[4 * 9 + 4], 0, '3×3 腐蚀会把单像素吃掉');

  const blurred = blurMask(mask, 9, 9, 1);
  assert.ok(blurred[4 * 9 + 4] > 0 && blurred[4 * 9 + 4] < 255, '模糊后中心应是中间值');
  assert.ok(blurred[3 * 9 + 4] > 0, '模糊会把边缘扩散到相邻像素');
});
