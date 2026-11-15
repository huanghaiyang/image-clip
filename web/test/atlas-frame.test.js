/**
 * 图集裁切框尺寸约束：只能大于或等于最大 AABB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ATLAS_SIDE,
  atlasSizeName,
  clampAtlasSize,
  makeAtlasSizePreset,
  normalizeMinSize,
  quickAtlasSizes,
  resolveAtlasFrameSize,
  resizeAtlasFrame,
  customFrameRect,
} from '../src/lib/atlasFrame.js';

test('低于最大 AABB 的尺寸被夹回下限', () => {
  const min = { width: 640, height: 480 };
  const result = clampAtlasSize(min, { width: 320, height: 200 });
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
  assert.equal(result.clamped.width, true);
  assert.equal(result.clamped.height, true);
});

test('大于最大 AABB 的尺寸原样保留（允许透明留边）', () => {
  const result = clampAtlasSize({ width: 640, height: 480 }, { width: 1280, height: 720 });
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(result.clamped.width, false);
  const square = resolveAtlasFrameSize({ width: 640, height: 480 }, { mode: 'custom', width: 800, height: 800 });
  assert.equal(square.width, 800);
  assert.equal(square.height, 800);
});

test('自动模式跟随最大 AABB', () => {
  const size = resolveAtlasFrameSize({ width: 1024, height: 512 }, { mode: 'auto', width: 9999, height: 9999 });
  assert.deepEqual([size.width, size.height], [1024, 512]);
});

test('非法 / 超限尺寸被规整到 1..MAX_ATLAS_SIDE', () => {
  assert.deepEqual(normalizeMinSize({ width: 0, height: -5 }), { width: 1, height: 1 });
  const huge = clampAtlasSize({ width: 10, height: 10 }, { width: 999999, height: 999999 });
  assert.equal(huge.width, MAX_ATLAS_SIDE);
  assert.equal(huge.height, MAX_ATLAS_SIDE);
});

test('命名：空名字用宽×高；预设会被夹到下限', () => {
  assert.equal(atlasSizeName('', 800, 600), '800×600');
  assert.equal(atlasSizeName('  帧尺寸  ', 800, 600), '帧尺寸');
  const preset = makeAtlasSizePreset({ name: '太小', width: 100, height: 100 }, { width: 640, height: 480 }, 'p1');
  assert.equal(preset.width, 640);
  assert.equal(preset.height, 480);
  assert.equal(preset.clamped.width, true);
});

test('快捷尺寸从最大 AABB 派生', () => {
  const list = quickAtlasSizes({ width: 320, height: 200 });
  const byId = Object.fromEntries(list.map((item) => [item.id, item]));
  assert.equal(byId.max.width, 320);
  assert.equal(byId.square.width, 320);
  assert.equal(byId.square.height, 320);
  assert.equal(byId['x2'].width, 640);
});


test('拖动把手：左右边只改宽、上下边只改高、四角同时改', () => {
  const start = { width: 640, height: 480 };
  const right = resizeAtlasFrame({ start, dx: 20, scale: 1, handle: 'e' });
  assert.deepEqual([right.width, right.height], [680, 480]);
  const bottom = resizeAtlasFrame({ start, dy: 20, scale: 1, handle: 's' });
  assert.deepEqual([bottom.width, bottom.height], [640, 520]);
  const corner = resizeAtlasFrame({ start, dx: 20, dy: -10, scale: 1, handle: 'se' });
  assert.deepEqual([corner.width, corner.height], [680, 460]);
  // 左上角往左上拖：宽高都变大
  const nw = resizeAtlasFrame({ start, dx: -15, dy: -5, scale: 1, handle: 'nw' });
  assert.deepEqual([nw.width, nw.height], [670, 490]);
  // 缩放系数：屏幕位移 20px、scale 0.5 时总尺寸变化 80px
  const scaled = resizeAtlasFrame({ start, dx: 20, scale: 0.5, handle: 'e' });
  assert.equal(scaled.width, 720);
});


test('自定义尺寸框：按输出宽高比包住 AABB、默认居中、位置夹在图片内', () => {
  const base = { imageWidth: 1000, imageHeight: 800, bounds: { x: 100, y: 100, width: 400, height: 300 } };
  const frame = customFrameRect({ ...base, outSize: { width: 1000, height: 1000 } });
  assert.equal(frame.width, frame.height, '1:1 输出应得到正方形框');
  assert.ok(frame.width >= 400 && frame.height >= 300, '必须完整包住 AABB');
  assert.ok(frame.x >= 0 && frame.y >= 0);
  assert.ok(frame.x + frame.width <= 1000 && frame.y + frame.height <= 800);
  assert.equal(frame.cx, 300 / 1000);

  // 自定义位置：只移动，尺寸不变
  const moved = customFrameRect({ ...base, outSize: { width: 1000, height: 500 }, center: { cx: 0.9, cy: 0.1 } });
  const later = customFrameRect({ ...base, outSize: { width: 1000, height: 500 }, center: { cx: 0.9, cy: 0.1 } });
  assert.deepEqual([moved.width, moved.height], [later.width, later.height]);
  assert.ok(moved.x + moved.width <= 1000 && moved.y >= 0);

  // 框比图片还大时收缩到图片范围内
  const huge = customFrameRect({ imageWidth: 100, imageHeight: 80, bounds: null, outSize: { width: 4000, height: 3000 } });
  assert.ok(huge.width <= 100 && huge.height <= 80);
});
