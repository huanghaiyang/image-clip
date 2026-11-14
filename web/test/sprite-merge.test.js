/**
 * 多图合并精灵图：布局纯函数单测
 * -----------------------------
 * 合并的判据是「单元格 = 各帧最大宽/高、等比居中、不拉伸」，面板预览与导出共用；
 * 这里钉死自动列数、列数钳制、间距与混合尺寸的边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planSpriteSheet, spriteCellOrigin } from '../src/lib/sprite.js';

test('空输入返回 null', () => {
  assert.equal(planSpriteSheet({ sizes: [] }), null);
  assert.equal(planSpriteSheet(), null);
});

test('尺寸一致时单元格就是该尺寸，自动列数按 ⌈√N⌉', () => {
  const plan = planSpriteSheet({ sizes: Array.from({ length: 6 }, () => ({ width: 100, height: 80 })) });
  assert.deepEqual(plan.cell, { width: 100, height: 80 });
  assert.equal(plan.count, 6);
  assert.equal(plan.cols, 3);
  assert.equal(plan.rows, 2);
  assert.equal(plan.width, 300);
  assert.equal(plan.height, 160);
});

test('混合尺寸时单元格取最大宽/高（不跳过任何一帧）', () => {
  const plan = planSpriteSheet({
    sizes: [
      { width: 100, height: 80 },
      { width: 240, height: 120 },
      { width: 160, height: 200 },
    ],
  });
  assert.deepEqual(plan.cell, { width: 240, height: 200 });
  assert.equal(plan.count, 3);
});

test('指定列数会被钳制在 1..帧数 之间', () => {
  const sizes = Array.from({ length: 5 }, () => ({ width: 10, height: 10 }));
  assert.equal(planSpriteSheet({ sizes, columns: 0 }).cols, 3); // 自动
  assert.equal(planSpriteSheet({ sizes, columns: 2 }).cols, 2);
  assert.equal(planSpriteSheet({ sizes, columns: 99 }).cols, 5);
  assert.equal(planSpriteSheet({ sizes, columns: -3 }).cols, 3);
});

test('间距计入总尺寸，行数按列数向上取整', () => {
  const plan = planSpriteSheet({
    sizes: Array.from({ length: 5 }, () => ({ width: 40, height: 30 })),
    columns: 2,
    gap: 6,
  });
  assert.equal(plan.cols, 2);
  assert.equal(plan.rows, 3);
  assert.equal(plan.width, 2 * 40 + 6);
  assert.equal(plan.height, 3 * 30 + 2 * 6);
});

test('非法尺寸被忽略，负数间距按 0 处理', () => {
  const plan = planSpriteSheet({
    sizes: [{ width: 0, height: 10 }, { width: 20, height: 0 }, { width: 30, height: 30 }],
    gap: -8,
  });
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.cell, { width: 30, height: 30 });
  assert.equal(plan.spacing, 0);
});

test('单元格原点按行优先排布，含间距', () => {
  const plan = { cols: 3, cell: { width: 100, height: 50 }, spacing: 4, count: 7 };
  assert.deepEqual(spriteCellOrigin(plan, 0), { x: 0, y: 0 });
  assert.deepEqual(spriteCellOrigin(plan, 2), { x: 208, y: 0 });
  assert.deepEqual(spriteCellOrigin(plan, 3), { x: 0, y: 54 });
  assert.deepEqual(spriteCellOrigin(plan, 5), { x: 208, y: 54 });
  assert.deepEqual(spriteCellOrigin(plan, 6), { x: 0, y: 108 });
});
