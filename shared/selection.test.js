/**
 * shared/selection.js 单测：坐标收敛、比例适配、批量裁剪换算、套索栅格化。
 * 运行：node shared/selection.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySelection,
  clampRect,
  countMask,
  fitAspectRect,
  normalizeRect,
  polygonArea,
  rasterizePolygon,
  rectFromNormalized,
  rectToAspect,
  resolveOutputSize,
  scalePolygon,
} from './selection.js';

test('clampRect：负坐标与越界都会被收回图内', () => {
  assert.deepEqual(clampRect({ x: -10, y: -4, width: 40, height: 20 }, 100, 50), {
    x: 0,
    y: 0,
    width: 30,
    height: 16,
  });
  assert.deepEqual(clampRect({ x: 90, y: 40, width: 40, height: 20 }, 100, 50), {
    x: 90,
    y: 40,
    width: 10,
    height: 10,
  });
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 0, height: 0 }, 100, 50), {
    x: 10,
    y: 10,
    width: 0,
    height: 0,
  });
});

test('归一化矩形与像素矩形可以无损往返', () => {
  const norm = normalizeRect({ x: 100, y: 50, width: 400, height: 200 }, 1000, 800);
  assert.deepEqual(norm, { x: 0.1, y: 0.0625, width: 0.4, height: 0.25 });
  assert.deepEqual(rectFromNormalized(norm, 1000, 800), { x: 100, y: 50, width: 400, height: 200 });

  // 同一份归一化矩形套到不同尺寸的图上：批量裁剪（例如一组关键帧）正是靠它
  assert.deepEqual(rectFromNormalized(norm, 500, 400), { x: 50, y: 25, width: 200, height: 100 });
});

test('fitAspectRect：在图片内取居中最大比例矩形', () => {
  assert.deepEqual(fitAspectRect(1000, 800, 1), { x: 100, y: 0, width: 800, height: 800 });
  assert.deepEqual(fitAspectRect(1000, 800, 16 / 9), { x: 0, y: 119, width: 1000, height: 563 });
  // 4:5 正好填满 800×1000 的竖图
  assert.deepEqual(fitAspectRect(800, 1000, 4 / 5), { x: 0, y: 0, width: 800, height: 1000 });
  // 9:16 比图片更窄，只能取到高 1000、宽 563 的居中条带
  assert.deepEqual(fitAspectRect(800, 1000, 9 / 16), { x: 119, y: 0, width: 563, height: 1000 });
  assert.deepEqual(fitAspectRect(1000, 800, 0), { x: 0, y: 0, width: 1000, height: 800 });
});

test('rectToAspect：切换比例时保持中心并夹在图内', () => {
  const out = rectToAspect({ x: 100, y: 100, width: 400, height: 200 }, 1, 1000, 800);
  assert.equal(out.width, out.height);
  assert.equal(out.x + out.width / 2, 300);
  assert.equal(out.y + out.height / 2, 200);
  assert.ok(out.x >= 0 && out.y >= 0 && out.x + out.width <= 1000 && out.y + out.height <= 800);

  const edge = rectToAspect({ x: 0, y: 0, width: 900, height: 100 }, 1, 1000, 800);
  assert.equal(edge.width, 800);
  assert.equal(edge.x, 50, '保持中心 x=450，边长收到 800 后左边界是 50');
  assert.equal(edge.y, 0);
});

test('resolveOutputSize：自然尺寸 / 单边推算 / 上限收敛', () => {
  assert.deepEqual(resolveOutputSize({ width: 640, height: 480 }), { width: 640, height: 480 });
  assert.deepEqual(resolveOutputSize({ width: 640, height: 480 }, { mode: 'resize', width: 1280 }), {
    width: 1280,
    height: 960,
  });
  assert.deepEqual(resolveOutputSize({ width: 640, height: 480 }, { mode: 'resize', height: 240 }), {
    width: 320,
    height: 240,
  });
  assert.deepEqual(resolveOutputSize({ width: 640, height: 480 }, { mode: 'resize', width: 999999, height: 999999 }), {
    width: 20000,
    height: 20000,
  });
});

test('rasterizePolygon：正方形套索覆盖像素中心，边界像素不多吃', () => {
  const mask = rasterizePolygon(
    [
      { x: 2, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 6 },
      { x: 2, y: 6 },
    ],
    8,
    8,
  );
  assert.equal(countMask(mask), 16);
  assert.equal(mask[2 * 8 + 2], 255);
  assert.equal(mask[5 * 8 + 5], 255);
  assert.equal(mask[1 * 8 + 2], 0);
  assert.equal(mask[2 * 8 + 6], 0);
});

test('rasterizePolygon：不足三个点或面积为 0 时返回空掩膜', () => {
  assert.equal(countMask(rasterizePolygon([{ x: 1, y: 1 }, { x: 5, y: 5 }], 8, 8)), 0);
  assert.equal(
    countMask(
      rasterizePolygon(
        [
          { x: 1, y: 1 },
          { x: 5, y: 1 },
          { x: 3, y: 1 },
        ],
        8,
        8,
      ),
    ),
    0,
  );
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]), 16);
});

test('applySelection：仅选区内 / 仅选区外', () => {
  const mask = new Uint8Array([255, 255, 255, 255]);
  const selection = new Uint8Array([255, 255, 0, 0]);
  assert.deepEqual([...applySelection(mask, selection, 'inside')], [255, 255, 0, 0]);
  assert.deepEqual([...applySelection(mask, selection, 'outside')], [0, 0, 255, 255]);
  assert.deepEqual([...applySelection(mask, selection, 'all')], [255, 255, 255, 255]);
});

test('scalePolygon：按预览缩放比例换算套索点', () => {
  assert.deepEqual(scalePolygon([{ x: 10, y: 20 }], 0.5), [{ x: 5, y: 10 }]);
  assert.deepEqual(scalePolygon([{ x: 10, y: 20 }], 0.5, 0.25), [{ x: 5, y: 5 }]);
});
