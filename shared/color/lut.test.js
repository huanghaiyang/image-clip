/**
 * 3D LUT 调色单元测试。
 */
import {
  DEFAULT_ADJUST,
  applyLutToRgba,
  encodeCube,
  identityLut,
  isAdjustActive,
  lutFromAdjust,
  parseCube,
  sampleCurve,
  sampleLut,
} from '../color/lut.js';

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

function near(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps;
}

test('恒等 LUT 采样接近原值', () => {
  const lut = identityLut(9);
  for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75], [0.9, 0.1, 0.4]]) {
    const out = sampleLut(lut, r, g, b);
    assert(near(out[0], r) && near(out[1], g) && near(out[2], b), `采样偏差过大：${out}`);
  }
});

test('enabled=false 时参数不生效', () => {
  const lut = lutFromAdjust({ ...DEFAULT_ADJUST, enabled: false, contrast: 80 });
  const out = sampleLut(lut, 0.5, 0.5, 0.5);
  assert(near(out[0], 0.5, 0.01), `应保持 0.5，实际 ${out[0]}`);
});

test('曝光 +100 提亮，-100 压暗', () => {
  const up = sampleLut(lutFromAdjust({ enabled: true, exposure: 100 }), 0.3, 0.3, 0.3);
  const down = sampleLut(lutFromAdjust({ enabled: true, exposure: -100 }), 0.3, 0.3, 0.3);
  assert(up[0] > 0.3, `+2EV 应更亮：${up[0]}`);
  assert(down[0] < 0.3, `-2EV 应更暗：${down[0]}`);
});

test('饱和度 -100 输出接近灰度', () => {
  const lut = lutFromAdjust({ enabled: true, saturation: -100 });
  const out = sampleLut(lut, 0.8, 0.2, 0.2);
  assert(near(out[0], out[1], 0.03) && near(out[1], out[2], 0.03), `应接近灰：${out}`);
});

test('曲线控制点线性插值', () => {
  assert(sampleCurve([[0, 0], [1, 1]], 0.5) === 0.5, '线性曲线中点');
  assert(near(sampleCurve([[0, 0], [0.5, 1], [1, 1]], 0.25), 0.5), '分段线性');
  assert(sampleCurve([[0, 0], [1, 1]], -1) === 0, '越界下界');
  assert(sampleCurve([[0, 0], [1, 1]], 2) === 1, '越界上界');
});

test('参数判断：只改 enabled 但没有参数视为无效', () => {
  assert(isAdjustActive({ enabled: true }) === false, '全 0 不应认为有效');
  assert(isAdjustActive({ enabled: true, contrast: 10 }) === true, '有参数应视为有效');
  assert(isAdjustActive({ enabled: true, curves: { ...DEFAULT_ADJUST.curves, rgb: [[0, 0], [0.5, 0.2], [1, 1]] } }) === true, '自定义曲线应视为有效');
});

test('.cube 解析与导出往返', () => {
  const lut = identityLut(4);
  const text = encodeCube(lut);
  const parsed = parseCube(text);
  assert(parsed.size === 4, '尺寸应一致');
  const out = sampleLut(parsed, 0.2, 0.6, 0.9);
  assert(near(out[0], 0.2, 0.02) && near(out[1], 0.6, 0.02) && near(out[2], 0.9, 0.02), `往返采样偏差：${out}`);
});

test('.cube 数据量不符要报错', () => {
  let threw = false;
  try {
    parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1');
  } catch {
    threw = true;
  }
  assert(threw, '数据量不足应抛错');
});

test('applyLutToRgba 保留 alpha 且强度 0 不变', () => {
  const image = { width: 1, height: 1, data: new Uint8ClampedArray([120, 80, 40, 200]) };
  applyLutToRgba(image, lutFromAdjust({ enabled: true, saturation: -100 }), 0);
  assert(image.data[0] === 120 && image.data[1] === 80 && image.data[3] === 200, '强度 0 不能改像素');
  applyLutToRgba(image, lutFromAdjust({ enabled: true, saturation: -100 }), 1);
  assert(image.data[3] === 200, 'alpha 必须保持');
});

console.log(`\nlut: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
