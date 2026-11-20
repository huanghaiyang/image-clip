/**
 * 掩膜工具单元测试（魔棒 / 布尔运算 / 羽化 / 扩展）。
 */
import { combineMask, createMask, expandMask, featherMask, invertMask, magicWand, maskBounds, maskCoverage } from '../maskops.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 造一张 w×h 的 RGBA：左半边红、右半边蓝。 */
function twoTone(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      data[i] = left ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = left ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

test('魔棒只选中连通的同色区域', () => {
  const w = 8;
  const h = 4;
  const rgba = twoTone(w, h);
  const mask = magicWand(rgba, w, h, { x: 0, y: 0, tolerance: 16, contiguous: true });
  assert(mask.data[0] === 255, '种子点必须选中');
  assert(mask.data[w - 1] === 0, '右半边应为 0');
  assert(maskCoverage(mask) > 0.45 && maskCoverage(mask) < 0.55, `覆盖率应约 50%，实际 ${maskCoverage(mask)}`);
});

test('魔棒容差 0 只选种子色', () => {
  const w = 6;
  const h = 2;
  const rgba = twoTone(w, h);
  const mask = magicWand(rgba, w, h, { x: 2, y: 0, tolerance: 0 });
  assert(maskCoverage(mask) > 0 && maskCoverage(mask) <= 0.5 + 1e-6, '不应跨过边界');
});

test('布尔运算：并 / 减 / 交', () => {
  const a = createMask(4, 1, 0);
  const b = createMask(4, 1, 0);
  a.data.set([255, 255, 0, 0]);
  b.data.set([0, 255, 255, 0]);
  const union = combineMask(a, b, 'union');
  assert(union.data[0] === 255 && union.data[2] === 255, '并集');
  const sub = combineMask(a, b, 'subtract');
  assert(sub.data[0] === 255 && sub.data[1] === 0, '减法');
  const inter = combineMask(a, b, 'intersect');
  assert(inter.data[1] === 255 && inter.data[0] === 0 && inter.data[2] === 0, '交集');
});

test('反相', () => {
  const mask = createMask(2, 1, 255);
  const inverted = invertMask(mask);
  assert(inverted.data[0] === 0 && mask.data[0] === 255, '不能原地改原掩膜');
});

test('扩展 / 收缩改变包围盒', () => {
  const mask = createMask(9, 9, 0);
  mask.data[4 * 9 + 4] = 255;
  const grown = expandMask(mask, 2);
  const box = maskBounds(grown);
  assert(box && box.width === 5 && box.height === 5, `扩展 2px 后应为 5×5，实际 ${box && box.width}`);
  const shrunk = expandMask(grown, -2);
  const small = maskBounds(shrunk);
  assert(small && small.width === 1 && small.height === 1, `5×5 收缩 2px 应剩 1×1，实际 ${small && small.width}`);
  assert(maskBounds(expandMask(mask, -1)) === null, '单点收缩 1px 应消失');
});

test('羽化让边缘出现中间值', () => {
  const mask = createMask(7, 7, 0);
  for (let y = 0; y < 7; y += 1) for (let x = 0; x < 7; x += 1) mask.data[y * 7 + x] = x < 3 ? 255 : 0;
  const soft = featherMask(mask, 2);
  const hasMid = [...soft.data].some((value) => value > 20 && value < 235);
  assert(hasMid, '羽化应产生过渡像素');
  assert(mask.data[0] === 255, '原掩膜不能被修改');
});

test('包围盒忽略低阈值噪点', () => {
  const mask = createMask(5, 5, 0);
  mask.data[0] = 1;
  mask.data[12] = 255;
  const box = maskBounds(mask, 8);
  assert(box && box.width === 1 && box.height === 1, '阈值 8 应跳过噪点');
});

console.log(`\nmaskops: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
