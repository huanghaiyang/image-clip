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
