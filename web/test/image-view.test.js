/**
 * 画布查看（透明通道）裁剪单测
 * --------------------------------
 * 透明通道视图的滤镜输出是不透明的（黑 = 全透明），而 StageCanvas / WatermarkStage
 * 的画布铺满整个舞台。`alphaViewClip()` 负责把滤镜结果裁到图片矩形，
 * 否则整块画布（图片之外的棋盘格背景）都会被染成黑色。
 *
 * 这些用例锁定住三个不变量：
 *  1. 图片在舞台内 → inset 精确等于图片矩形；
 *  2. 图片被平移出可视区 → 四个值仍夹在舞台内，不会把背景裁坏；
 *  3. 没有图片 / 舞台还没测量 → 返回“空裁剪”，宁可什么都不画也别涂黑整块画布。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { alphaViewClip } from '../src/composables/useImageView.js';

const EMPTY = 'inset(0 100% 0 0)';

/** 'inset(1px 2px 3px 4px)' → { top: 1, right: 2, bottom: 3, left: 4 } */
function parseInset(value) {
  const matched = /^inset\((-?\d+)px (-?\d+)px (-?\d+)px (-?\d+)px\)$/.exec(String(value));
  assert.ok(matched, `不是合法的 inset()：${value}`);
  return { top: +matched[1], right: +matched[2], bottom: +matched[3], left: +matched[4] };
}

test('图片完整落在舞台内：inset 精确等于图片矩形', () => {
  const clip = alphaViewClip({ x: 100, y: 40, width: 300, height: 200 }, { w: 800, h: 600 });
  assert.deepEqual(parseInset(clip), { top: 40, right: 400, bottom: 360, left: 100 });
});

test('小数坐标取整，且三边之和不会超过舞台尺寸', () => {
  const clip = alphaViewClip({ x: 10.4, y: 20.6, width: 300.5, height: 200.4 }, { w: 800, h: 600 });
  const { top, right, bottom, left } = parseInset(clip);
  assert.ok(left >= 0 && top >= 0 && right >= 0 && bottom >= 0, '四个方向都必须非负');
  assert.ok(left + right <= 800, `左右之和 ${left + right} 不能超过舞台宽 800`);
  assert.ok(top + bottom <= 600, `上下之和 ${top + bottom} 不能超过舞台高 600`);
});

test('图片被平移出可视区：裁到与舞台的交集，不产生负值', () => {
  const clip = alphaViewClip({ x: -120, y: -60, width: 300, height: 200 }, { w: 800, h: 600 });
  // 交集是 (0,0)-(180,140)
  assert.deepEqual(parseInset(clip), { top: 0, right: 620, bottom: 460, left: 0 });
});

test('图片完全在舞台外：返回空裁剪（整块画布不画）', () => {
  assert.equal(alphaViewClip({ x: 1000, y: 10, width: 300, height: 200 }, { w: 800, h: 600 }), EMPTY);
  assert.equal(alphaViewClip({ x: 10, y: 700, width: 300, height: 200 }, { w: 800, h: 600 }), EMPTY);
});

test('没有图片 / 尺寸无效：返回空裁剪，避免整块画布被涂黑', () => {
  assert.equal(alphaViewClip(null, { w: 800, h: 600 }), EMPTY);
  assert.equal(alphaViewClip({ x: 0, y: 0, width: 0, height: 0 }, { w: 800, h: 600 }), EMPTY);
  assert.equal(alphaViewClip({ x: 0, y: 0, width: 300, height: 200 }, { w: 0, h: 0 }), EMPTY);
  assert.equal(alphaViewClip({ x: 0, y: 0, width: 300, height: 200 }, null), EMPTY);
  assert.equal(alphaViewClip({ x: Number.NaN, y: 0, width: 300, height: 200 }, { w: 800, h: 600 }), EMPTY);
});
