/**
 * 图集统一输出尺寸 / 居中适配 单测
 * -------------------------------
 * 「统一尺寸」是图集预览与批量裁剪的共同判据：帧尺寸不一致会导致
 * 精灵图拼不起来、GIF 播放抖动，所以边界（同尺寸、混合尺寸、极端长宽比）都要钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeAtlasOutputSize, fitInto } from '../src/lib/atlas.js';

test('所有帧裁剪尺寸一致时，统一尺寸就是该尺寸', () => {
  const rects = [
    { width: 280, height: 190 },
    { width: 280, height: 190 },
    { width: 280, height: 190 },
  ];
  assert.deepEqual(computeAtlasOutputSize(rects), { width: 280, height: 190 });
});

test('混合尺寸时取最大宽/最大高（不因取整丢帧）', () => {
  const rects = [
    { width: 280, height: 190 },
    { width: 560, height: 380 },
    { width: 420, height: 380 },
  ];
  assert.deepEqual(computeAtlasOutputSize(rects), { width: 560, height: 380 });
});

test('空输入/非法值不会返回 0 尺寸', () => {
  assert.deepEqual(computeAtlasOutputSize([]), { width: 1, height: 1 });
  assert.deepEqual(computeAtlasOutputSize(null), { width: 1, height: 1 });
  assert.deepEqual(computeAtlasOutputSize([{ width: 0, height: 0 }]), { width: 1, height: 1 });
});

test('比例一致时填满目标尺寸（放大/缩小都居中铺满）', () => {
  const up = fitInto({ width: 280, height: 190 }, { width: 560, height: 380 });
  assert.equal(up.dx, 0);
  assert.equal(up.dy, 0);
  assert.equal(up.dw, 560);
  assert.equal(up.dh, 380);
  assert.equal(up.scale, 2);

  const down = fitInto({ width: 560, height: 380 }, { width: 280, height: 190 });
  assert.deepEqual([down.dx, down.dy, down.dw, down.dh], [0, 0, 280, 190]);
});

test('比例不同时留透明边并居中（不拉伸）', () => {
  const wide = fitInto({ width: 400, height: 100 }, { width: 400, height: 400 });
  assert.equal(wide.dw, 400);
  assert.equal(wide.dh, 100);
  assert.equal(wide.dx, 0);
  assert.equal(wide.dy, 150);

  const tall = fitInto({ width: 100, height: 400 }, { width: 400, height: 400 });
  assert.equal(tall.dx, 150);
  assert.equal(tall.dy, 0);
});

test('奇数差值时偏移向下取整，尺寸至少 1px', () => {
  const result = fitInto({ width: 3, height: 3 }, { width: 4, height: 5 });
  assert.ok(result.dw >= 1 && result.dh >= 1);
  assert.ok(Number.isInteger(result.dx) && Number.isInteger(result.dy));
  assert.ok(result.dx >= 0 && result.dy >= 0);
  assert.ok(result.dx + result.dw <= 4);
  assert.ok(result.dy + result.dh <= 5);
});
