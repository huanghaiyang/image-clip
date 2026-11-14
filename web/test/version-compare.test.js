/**
 * 历史版本对比纯函数单测
 * ----------------------
 * 覆盖图片逐像素差异统计、音频波形降采样与列比较、帧号换算。
 * 这些是「对比结果」的唯一判据来源，所以边界（透明像素、单通道偏色、阈值、列数不一致）
 * 都要钉死，避免界面上给出似是而非的“相同 / 不同”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PIXEL_THRESHOLD,
  buildAudioPeaks,
  comparePeaks,
  diffImageData,
  formatFrameTime,
  frameAt,
  frameTime,
} from '../src/lib/versionCompare.js';

/** 生成一张 width×height 的纯色 RGBA 图（可逐像素覆盖）。 */
function makeImage(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = a;
  }
  return data;
}

test('完全相同的两张图：差异像素为 0，差异图全黑', () => {
  const a = makeImage(4, 3, [10, 20, 30]);
  const b = a.slice();
  const result = diffImageData(a, b, { width: 4, height: 3 });
  assert.equal(result.totalPixels, 12);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.ratio, 0);
  assert.equal(result.meanDelta, 0);
  assert.equal(result.maxDelta, 0);
  assert.equal(result.alphaDiffPixels, 0);
  assert.equal(result.diff.length, 12 * 4);
  assert.ok(result.diff.every((value, index) => (index % 4 === 3 ? value === 255 : value === 0)));
});

test('单个像素的 RGB 变化能被定位与统计', () => {
  const a = makeImage(2, 2, [0, 0, 0]);
  const b = a.slice();
  b[0] = 200; // 左上角红通道
  const result = diffImageData(a, b, { width: 2, height: 2 });
  assert.equal(result.diffPixels, 1);
  assert.equal(result.ratio, 0.25);
  assert.equal(result.maxDelta, 200);
  // gain=4 时饱和到 255
  assert.equal(result.diff[0], 255);
  // 相邻像素仍是黑的
  assert.equal(result.diff[4], 0);
});

test('阈值以内的重编码噪声不算差异；超过阈值才算', () => {
  const a = makeImage(1, 1, [100, 100, 100]);
  const b = a.slice();
  b[0] += 2;
  b[1] -= 2;
  b[2] += 2;
  const near = diffImageData(a, b, { width: 1, height: 1 });
  assert.equal(near.diffPixels, 0, `默认阈值 ${DEFAULT_PIXEL_THRESHOLD} 内应视为相同`);
  assert.equal(near.maxDelta, 2);

  const over = diffImageData(a, b, { width: 1, height: 1, threshold: 1 });
  assert.equal(over.diffPixels, 1);
});

test('只有 alpha 变化时单独计数（透明通道差异）', () => {
  const a = makeImage(3, 1, [0, 0, 0, 255]);
  const b = a.slice();
  b[3] = 0; // 第一个像素全透明
  const result = diffImageData(a, b, { width: 3, height: 1 });
  assert.equal(result.diffPixels, 1);
  assert.equal(result.alphaDiffPixels, 1);
  assert.equal(result.maxDelta, 255);
});

test('像素数据长度不足时明确抛错，而不是给出错误结论', () => {
  assert.throws(() => diffImageData(new Uint8ClampedArray(4), new Uint8ClampedArray(4), { width: 2, height: 2 }), /长度不足/);
  assert.throws(() => diffImageData(null, null, { width: 1, height: 1 }), /需要两张图/);
});

test('波形降采样：min/max/RMS 与原始样本一致', () => {
  // 4 个样本、2 列 → 每列 2 个样本
  const left = new Float32Array([0, 1, -1, 0.5]);
  const peaks = buildAudioPeaks([left], { columns: 2, sampleRate: 48000, duration: 4 / 48000 });
  assert.equal(peaks.columns, 2);
  assert.equal(peaks.channels, 1);
  assert.deepEqual(Array.from(peaks.min), [0, -1]);
  assert.deepEqual(Array.from(peaks.max), [1, 0.5]);
  assert.ok(Math.abs(peaks.rms[0] - Math.sqrt(0.5)) < 1e-6);
  assert.ok(Math.abs(peaks.rms[1] - Math.sqrt((1 + 0.25) / 2)) < 1e-6);
});

test('波形降采样：多声道取平均；空输入返回全零', () => {
  const left = new Float32Array([1, 1]);
  const right = new Float32Array([-1, -1]);
  const peaks = buildAudioPeaks([left, right], { columns: 1 });
  assert.deepEqual(Array.from(peaks.max), [0]);
  assert.deepEqual(Array.from(peaks.min), [0]);

  const empty = buildAudioPeaks([], { columns: 3 });
  assert.equal(empty.channels, 0);
  assert.equal(empty.columns, 3);
  assert.deepEqual(Array.from(empty.rms), [0, 0, 0]);
});

test('波形比较：完全一致为 0；能量变化能定位到列', () => {
  const base = new Float32Array(10).fill(0.1);
  const same = buildAudioPeaks([base], { columns: 10 });
  assert.deepEqual(comparePeaks(same, same), {
    columns: 10,
    maxDelta: 0,
    maxDeltaIndex: -1,
    meanDelta: 0,
    changedColumns: 0,
    ratio: 0,
    comparableColumns: 10,
  });

  const louder = new Float32Array(10).fill(0.1);
  louder[7] = 0.9;
  const changed = buildAudioPeaks([louder], { columns: 10 });
  const result = comparePeaks(same, changed);
  assert.equal(result.maxDeltaIndex, 7);
  assert.ok(result.maxDelta > 0.7);
  assert.equal(result.changedColumns, 1);
});

test('波形比较：列数不一致时按较短的对齐，不越界', () => {
  const a = buildAudioPeaks([new Float32Array(8).fill(0.5)], { columns: 8 });
  const b = buildAudioPeaks([new Float32Array(4).fill(0.5)], { columns: 4 });
  const result = comparePeaks(a, b);
  assert.equal(result.columns, 4);
  assert.equal(result.comparableColumns, 4);
  assert.equal(result.changedColumns, 0);
});

test('帧号与秒数换算（30fps / 浮点边界）', () => {
  assert.equal(frameAt(0, 30), 0);
  assert.equal(frameAt(1 / 30, 30), 1);
  assert.equal(frameAt(1 / 30 + 1e-9, 30), 1, '浮点误差不应多算一帧');
  assert.equal(frameAt(1, 30), 30);
  assert.equal(frameTime(30, 30), 1);
  assert.equal(frameTime(0, 30), 0);
  // fps 缺失时按 30 兜底，不产生 NaN
  assert.equal(frameAt(1, 0), 30);
  assert.equal(frameTime(15, undefined), 0.5);
});

test('时间码格式化：有 fps 用帧号小数，没有则用百分秒', () => {
  assert.equal(formatFrameTime(0, 30), '00:00.00');
  assert.equal(formatFrameTime(1.1, 30), '00:01.03');
  assert.equal(formatFrameTime(61.5, 0), '01:01.50');
  assert.equal(formatFrameTime(-3, 0), '00:00.00');
});
