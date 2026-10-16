import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBounds,
  normalizeOptions,
  parseHexColor,
  applyPadding,
  describeResult,
  DEFAULT_OPTIONS,
} from './aabb.js';

/**
 * 用“字符画”构造 RGBA 缓冲，测试用例因此可以直接看出边界在哪：
 *   '.'           → 完全透明
 *   '#'           → 不透明（白）
 *   '1'..'9'      → alpha = 数字 * 28（半透明）
 *   'W'           → 不透明纯白（用于颜色背景模式）
 *   'B'           → 不透明纯黑
 */
function art(rows, painter = {}) {
  const height = rows.length;
  const width = rows[0].length;
  for (const [i, row] of rows.entries()) {
    assert.equal(row.length, width, `第 ${i} 行长度不一致`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const i = (y * width + x) * 4;
      if (ch === '.') return; // 全透明
      let [r, g, b, a] = [255, 255, 255, 255];
      if (/[1-9]/.test(ch)) a = Number(ch) * 28;
      else if (ch === 'W') [r, g, b] = [255, 255, 255];
      else if (ch === 'B') [r, g, b] = [0, 0, 0];
      else if (ch === 'R') [r, g, b] = [220, 30, 30];
      if (painter[ch]) [r, g, b, a] = painter[ch];
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    });
  });
  return { data, width, height };
}

test('全不透明图片：边界等于整图，没有可去除的边距', () => {
  const { data, width, height } = art(['###', '###', '###']);
  const res = detectBounds(data, width, height);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 3, height: 3 });
  assert.equal(res.empty, false);
  assert.deepEqual(res.trimmed, { left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(res.contentPixels, 9);
});

test('四周透明：AABB 精确落在内容上并给出四边去除量', () => {
  const { data, width, height } = art([
    '.....',
    '.....',
    '..##.',
    '..##.',
    '.....',
  ]);
  const res = detectBounds(data, width, height);
  assert.deepEqual(res.bounds, { x: 2, y: 2, width: 2, height: 2 });
  assert.deepEqual(res.trimmed, { left: 2, top: 2, right: 1, bottom: 1 });
  assert.equal(res.contentPixels, 4);
  assert.equal(describeResult(res).includes('5×5'), true);
});

test('单像素角落内容也能识别（右下角）', () => {
  const { data, width, height } = art(['...', '...', '..#']);
  const res = detectBounds(data, width, height);
  assert.deepEqual(res.bounds, { x: 2, y: 2, width: 1, height: 1 });
  assert.deepEqual(res.trimmed, { left: 2, top: 2, right: 0, bottom: 0 });
});

test('不规则形状：按最左/最右/最上/最下像素取包围盒', () => {
  const { data, width, height } = art([
    '..#..',
    '.###.',
    '#...#',
    '.....',
  ]);
  const res = detectBounds(data, width, height);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 5, height: 3 });
  assert.deepEqual(res.trimmed, { left: 0, top: 0, right: 0, bottom: 1 });
});

test('整图透明：empty=true 且边界退化为 0×0', () => {
  const { data, width, height } = art(['...', '...']);
  const res = detectBounds(data, width, height);
  assert.equal(res.empty, true);
  assert.deepEqual(res.bounds, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(res.contentPixels, 0);
  assert.equal(describeResult(res).includes('透明'), true);
});

test('alpha 阈值：严格大于阈值才算内容（边界值不会误判）', () => {
  const { data, width, height } = art([
    '1#',
    '1#',
    '1#',
  ]); // 2 列 × 3 行，左列 alpha=28，右列 alpha=255
  // 阈值 28 时 28 > 28 为假 → 左列被当作背景。
  const strict = detectBounds(data, width, height, { alphaThreshold: 28 });
  assert.deepEqual(strict.bounds, { x: 1, y: 0, width: 1, height: 3 });
  assert.deepEqual(strict.trimmed, { left: 1, top: 0, right: 0, bottom: 0 });

  const loose = detectBounds(data, width, height, { alphaThreshold: 27 });
  assert.deepEqual(loose.bounds, { x: 0, y: 0, width: 2, height: 3 });
});

test('alphaThreshold=0：任何非零 alpha 都算内容（最保守设置）', () => {
  const { data, width, height } = art(['1..', '...'], { 1: [255, 255, 255, 1] });
  assert.deepEqual(detectBounds(data, width, height, { alphaThreshold: 0 }).bounds, {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.equal(detectBounds(data, width, height, { alphaThreshold: 1 }).empty, true);
});

test('alpha 阈值：高阈值可丢弃低不透明度的边缘噪点/投影', () => {
  const { data, width, height } = art([
    '22###',
    '22###',
    '22###',
  ]);
  const res = detectBounds(data, width, height, { alphaThreshold: 60 });
  assert.deepEqual(res.bounds, { x: 2, y: 0, width: 3, height: 3 });
  assert.deepEqual(res.trimmed, { left: 2, top: 0, right: 0, bottom: 0 });

  const loose = detectBounds(data, width, height, { alphaThreshold: 0 });
  assert.deepEqual(loose.bounds, { x: 0, y: 0, width: 5, height: 3 });
});

test('padding：正数向外扩，且被夹取在图片范围内', () => {
  const { data, width, height } = art([
    '.....',
    '..##.',
    '..##.',
    '.....',
    '.....',
  ]); // 5×5，内容位于 (2,1)-(3,2)
  const res = detectBounds(data, width, height, { padding: 1 });
  assert.deepEqual(res.bounds, { x: 1, y: 0, width: 4, height: 4 });

  const huge = detectBounds(data, width, height, { padding: 100 });
  assert.deepEqual(huge.bounds, { x: 0, y: 0, width: 5, height: 5 });
});

test('padding 负数：向内收缩，允许把内容裁掉一部分', () => {
  const { data, width, height } = art([
    '###',
    '###',
    '###',
  ]); // 3×3 全不透明
  const res = detectBounds(data, width, height, { padding: -1 });
  assert.deepEqual(res.bounds, { x: 1, y: 1, width: 1, height: 1 });
});

test('颜色背景模式：把接近白底的不透明像素当背景（适用于无 alpha 的 JPG）', () => {
  const { data, width, height } = art([
    'WWWWW',
    'WWRWW',
    'WWWWW',
  ]);
  const off = detectBounds(data, width, height, { matchColor: false });
  assert.deepEqual(off.bounds, { x: 0, y: 0, width: 5, height: 3 });

  const on = detectBounds(data, width, height, {
    matchColor: true,
    backgroundColor: '#ffffff',
    colorTolerance: 12,
  });
  assert.deepEqual(on.bounds, { x: 2, y: 1, width: 1, height: 1 });
  assert.deepEqual(on.trimmed, { left: 2, top: 1, right: 2, bottom: 1 });
});

test('颜色背景模式：容差内的“近白”被丢弃，容差外的浅色被保留', () => {
  const nearWhite = art(['WWW', 'W2W', 'WWW'], { 2: [246, 246, 246, 255] });
  const dropped = detectBounds(nearWhite.data, 3, 3, {
    matchColor: true,
    colorTolerance: 12,
  });
  assert.equal(dropped.empty, true);

  const kept = detectBounds(nearWhite.data, 3, 3, {
    matchColor: true,
    colorTolerance: 4, // 246 与 255 相差 9 > 4 → 视为内容
  });
  assert.deepEqual(kept.bounds, { x: 1, y: 1, width: 1, height: 1 });
});

test('采样/步长已移除：算法始终逐像素精确扫描，不会漏掉细小内容', () => {
  // 仅 1 个像素的内容，位于图片正中间；曾用抽样加速会漏掉这种情况。
  const { data, width, height } = art([
    '.........',
    '.........',
    '.........',
    '....#....',
    '.........',
    '.........',
    '.........',
  ]);
  const res = detectBounds(data, width, height);
  assert.deepEqual(res.bounds, { x: 4, y: 3, width: 1, height: 1 });
  assert.equal(res.contentPixels, 1);
  assert.deepEqual(res.options.sample, undefined);
});

test('contentRatio 反映内容像素占比', () => {
  const { data, width, height } = art([
    '##..',
    '##..',
    '....',
    '....',
  ]);
  const res = detectBounds(data, width, height);
  assert.equal(res.contentPixels, 4);
  assert.equal(res.contentRatio, 4 / 16);
});

test('非法缓冲区会显式报错，而不是静默返回空框', () => {
  assert.throws(() => detectBounds(new Uint8ClampedArray(4), 2, 2), TypeError);
  assert.throws(() => detectBounds(null, 1, 1), TypeError);
});

test('normalizeOptions：越界值收敛、缺省值回退', () => {
  const o = normalizeOptions({ alphaThreshold: 999, padding: 1.6, colorTolerance: -5, backgroundColor: 'nope' });
  assert.equal(o.alphaThreshold, 255);
  assert.equal(o.padding, 2);
  assert.equal(o.colorTolerance, 0);
  assert.equal(o.backgroundColor, DEFAULT_OPTIONS.backgroundColor);
  assert.deepEqual(normalizeOptions(), { ...DEFAULT_OPTIONS });
});

test('parseHexColor 支持 3/6/8 位十六进制与非法输入', () => {
  assert.deepEqual(parseHexColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor('0d99ff'), { r: 13, g: 153, b: 255 });
  assert.deepEqual(parseHexColor('#0d99ffcc'), { r: 13, g: 153, b: 255 });
  assert.equal(parseHexColor('rgb(1,2,3)'), null);
  assert.equal(parseHexColor('#12'), null);
});

test('applyPadding 不变更原对象', () => {
  const rect = { x: 2, y: 2, width: 3, height: 3 };
  const out = applyPadding(rect, 1, 10, 10);
  assert.deepEqual(rect, { x: 2, y: 2, width: 3, height: 3 });
  assert.deepEqual(out, { x: 1, y: 1, width: 5, height: 5 });
  assert.deepEqual(applyPadding(rect, 0, 10, 10), rect);
});

test('返回的 options 是归一化后的快照（便于服务端回显与复现）', () => {
  const { data, width, height } = art(['#']);
  const res = detectBounds(data, width, height, { padding: '3' });
  assert.equal(res.options.padding, 3);
  assert.equal(res.options.alphaThreshold, 1);
});
