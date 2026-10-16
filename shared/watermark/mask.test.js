import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boxBlur,
  cloneMask,
  compareMasks,
  connectedComponents,
  countMask,
  coverage,
  createMask,
  decodeRle,
  dilate,
  encodeRle,
  erode,
  feather,
  fromAlpha,
  intersect,
  isEmpty,
  keepLabels,
  maskBounds,
  maskToRgba,
  open,
  close,
  overlayRgba,
  paintCircle,
  paintStroke,
  subtract,
  union,
} from './mask.js';

/** 用字符画构造掩膜：'#'=255，'.'=0 */
function art(rows) {
  const height = rows.length;
  const width = rows[0].length;
  for (const row of rows) assert.equal(row.length, width, '每行长度必须一致');
  const data = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '#') data[y * width + x] = 255;
    });
  });
  return { width, height, data };
}

const rows = (mask) => {
  const out = [];
  for (let y = 0; y < mask.height; y += 1) {
    let line = '';
    for (let x = 0; x < mask.width; x += 1) line += mask.data[y * mask.width + x] > 127 ? '#' : '.';
    out.push(line);
  }
  return out;
};

test('createMask / countMask / coverage / isEmpty', () => {
  const m = createMask(4, 3);
  assert.equal(m.data.length, 12);
  assert.equal(countMask(m), 0);
  assert.equal(coverage(m), 0);
  assert.equal(isEmpty(m), true);

  const filled = createMask(4, 3, 255);
  assert.equal(countMask(filled), 12);
  assert.equal(coverage(filled), 1);
  assert.equal(isEmpty(filled), false);
});

test('maskBounds：空掩膜与内容包围盒', () => {
  assert.deepEqual(maskBounds(createMask(5, 5)), { x: 0, y: 0, width: 0, height: 0, empty: true });
  const m = art([
    '.....',
    '.###.',
    '.###.',
    '.....',
    '.....',
  ]);
  assert.deepEqual(maskBounds(m), { x: 1, y: 1, width: 3, height: 2, empty: false });
});

test('dilate：方块结构元各方向均匀生长，cross 只沿上下左右生长', () => {
  const m = art([
    '.....',
    '..#..',
    '.....',
  ]);
  assert.deepEqual(rows(dilate(m, 1)), [
    '.###.',
    '.###.',
    '.###.',
  ], 'square（默认）生长为 3×3 方块');
  assert.deepEqual(rows(dilate(m, 1, 'cross')), [
    '..#..',
    '.###.',
    '..#..',
  ], 'cross 只生长 4 邻域');
});

test('erode：方块结构元与 cross 结构元的差异', () => {
  const block = art([
    '.....',
    '.###.',
    '.###.',
    '.###.',
    '.....',
  ]);
  assert.deepEqual(rows(erode(block, 1)), [
    '.....',
    '.....',
    '..#..',
    '.....',
    '.....',
  ], '3×3 方块腐蚀后只剩中心点');

  const cross = art([
    '.....',
    '..#..',
    '.###.',
    '..#..',
    '.....',
  ]);
  assert.deepEqual(rows(erode(cross, 1, 'cross')), [
    '.....',
    '.....',
    '..#..',
    '.....',
    '.....',
  ], '十字形用 cross 结构元腐蚀后保留中心');
  assert.equal(countMask(erode(cross, 1)), 0, '十字形用方块结构元腐蚀后什么都不剩（对角不连续）');
});

test('open 去孤立噪点、close 补内部空洞', () => {
  const noisy = art([
    '#........',
    '.........',
    '...###...',
    '...###...',
    '...###...',
    '........#',
  ]);
  // radius=1 的开运算：消掉 1 像素孤立点，3×3 实体块保持不变
  assert.deepEqual(rows(open(noisy, 1)), [
    '.........',
    '.........',
    '...###...',
    '...###...',
    '...###...',
    '.........',
  ]);

  const holed = art([
    '#####',
    '##.##',
    '#####',
  ]);
  assert.deepEqual(rows(close(holed, 1)), ['#####', '#####', '#####']);
});

test('dilate 与 erode 不修改入参', () => {
  const m = art(['.#.', '...', '...']);
  const before = [...m.data];
  dilate(m, 2);
  erode(m, 2);
  assert.deepEqual([...m.data], before);
});

test('boxBlur / feather：范围、均值语义与软边过渡', () => {
  const m = art([
    '.....',
    '.###.',
    '.###.',
    '.....',
  ]);
  const blurred = boxBlur(m, 1);
  assert.equal(blurred.data.some((v) => v < 0 || v > 255), false, '模糊结果必须落在 0..255');
  // 盒式模糊就是窗口均值：中心 3×3 窗口里有 6 个 255 → 6*255/9 = 170
  assert.equal(blurred.data[1 * 5 + 2], 170);
  assert.ok(blurred.data[0] < 255 && blurred.data[0] > 0, '边界外侧被扩散出中间值');

  const soft = feather(m, 1);
  assert.ok(soft.data[0 * 5 + 2] > 0 && soft.data[0 * 5 + 2] < 255, '羽化会在边界外产生软过渡');
  const sum = (x) => [...x.data].reduce((a, b) => a + b, 0);
  assert.ok(Math.max(...soft.data) < 255, '羽化后峰值必然低于 255（这正是"软边"的含义）');
  assert.ok(sum(soft) > 0.4 * sum(m) && sum(soft) < 1.6 * sum(m), '盒式模糊大致保持能量（不放大也不丢失）');
});

test('union / intersect / subtract / cloneMask', () => {
  const a = art(['##.', '...']);
  const b = art(['..#', '.#.']);
  assert.deepEqual(rows(union(a, b)), ['###', '.#.']);
  assert.deepEqual(rows(intersect(a, b)), ['...', '...']);
  assert.deepEqual(rows(subtract(a, b)), ['##.', '...']);

  const c = cloneMask(a);
  c.data[0] = 0;
  assert.equal(a.data[0], 255, 'clone 必须是深拷贝');
});

test('尺寸不一致时显式报错', () => {
  assert.throws(() => union(createMask(2, 2), createMask(3, 3)), /尺寸不一致/);
  assert.throws(() => intersect(createMask(2, 2), createMask(2, 3)), /尺寸不一致/);
});

test('paintCircle / paintStroke：画笔与橡皮', () => {
  const m = createMask(11, 11);
  paintCircle(m, 5, 5, 2, 'paint', 0);
  assert.ok(countMask(m) > 0);
  const painted = countMask(m);
  paintCircle(m, 5, 5, 2, 'erase', 0);
  assert.equal(countMask(m), 0, '橡皮应能完全擦掉刚画的圆');

  const stroke = createMask(21, 5);
  paintStroke(stroke, { x: 1, y: 2 }, { x: 19, y: 2 }, 1, 'paint', 0);
  assert.equal(countMask(stroke) > 0, true);
  // 连线上不应出现断点
  for (let x = 1; x <= 19; x += 1) assert.ok(stroke.data[2 * 21 + x] > 127, `x=${x} 处出现断点`);
  assert.equal(painted > 0, true);
});

test('connectedComponents：面积、包围盒与最小面积过滤', () => {
  const m = art([
    '##....#',
    '##....#',
    '.......',
    '..#....',
  ]);
  const comps = connectedComponents(m, { minArea: 2 });
  assert.equal(comps.length, 2, '1 像素的点会被 minArea 过滤掉');
  assert.equal(comps[0].area, 4);
  assert.deepEqual(
    { x: comps[0].x, y: comps[0].y, width: comps[0].width, height: comps[0].height },
    { x: 0, y: 0, width: 2, height: 2 },
  );
  assert.equal(comps[1].area, 2);
  assert.equal(comps[1].x, 6);
});

test('connectedComponents：8 邻接（对角相连算一个区域）', () => {
  const m = art([
    '#..',
    '.#.',
    '..#',
  ]);
  assert.equal(connectedComponents(m, { minArea: 1 }).length, 1);
});

test('keepLabels：只保留指定区域', () => {
  const m = art(['##...#', '##...#', '......']);
  const labels = new Int32Array(m.width * m.height);
  const comps = connectedComponents(m, { minArea: 1 });
  // 手工重建 label 视图：左块 label=1，右块 label=2
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) labels[y * m.width + x] = 1;
    for (let x = 5; x < 6; x += 1) labels[y * m.width + x] = 2;
  }
  assert.equal(comps.length, 2);
  const kept = keepLabels(m, labels, [2]);
  assert.deepEqual(rows(kept), ['.....#', '.....#', '......']);
});

test('RLE 往返：任意尺寸都能无损还原', () => {
  const m = art([
    '#.#.#',
    '.....',
    '#####',
  ]);
  const rle = encodeRle(m);
  const back = decodeRle(rle);
  assert.deepEqual([...back.data], [...m.data]);
  assert.equal(rle.width, 5);
  assert.equal(rle.height, 3);

  const empty = createMask(3, 3);
  assert.deepEqual([...decodeRle(encodeRle(empty)).data], [...empty.data]);
  const full = createMask(3, 3, 255);
  assert.deepEqual([...decodeRle(encodeRle(full)).data], [...full.data]);
});

test('compareMasks：IoU / 精确率 / 召回率', () => {
  const pred = art(['###', '#..', '...']);
  const truth = art(['##.', '##.', '...']);
  const cmp = compareMasks(pred, truth);
  assert.equal(cmp.tp, 3);
  assert.equal(cmp.fp, 1);
  assert.equal(cmp.fn, 1);
  assert.equal(cmp.precision, 3 / 4);
  assert.equal(cmp.recall, 3 / 4);
  assert.equal(cmp.iou, 3 / 5);
  assert.equal(compareMasks(truth, truth).iou, 1);
});

test('fromAlpha / maskToRgba / overlayRgba', () => {
  const rgba = new Uint8ClampedArray([
    10, 10, 10, 0,
    20, 20, 20, 255,
    30, 30, 30, 128,
    40, 40, 40, 5,
  ]);
  const m = fromAlpha(rgba, 4, 1, 8);
  assert.deepEqual([...m.data], [0, 255, 255, 0]);

  const back = maskToRgba(m, [255, 0, 0]);
  assert.equal(back.data.length, 16);
  assert.equal(back.data[0], 255);
  assert.equal(back.data[3], 0);
  assert.equal(back.data[7], 255);

  const base = { width: 4, height: 1, data: new Uint8ClampedArray(16).fill(100) };
  const over = overlayRgba(base, m, [13, 153, 255], 0.5);
  assert.deepEqual(over.data.length, 16);
  assert.equal(over.data[0], 100, '掩膜外的像素保持原样');
  assert.ok(over.data[4] !== 100, '掩膜内的像素被染色');
  assert.equal(base.data[4], 100, 'overlayRgba 不应修改入参');

  // 也接受「裸 RGBA 数组」这种入参形式
  const raw = overlayRgba(new Uint8ClampedArray(16).fill(100), m, [13, 153, 255], 0.5);
  assert.equal(raw.data[0], 100);
  assert.ok(raw.data[4] !== 100);
});
