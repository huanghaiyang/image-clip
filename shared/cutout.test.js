/**
 * AI 抠图算法单元测试（纯 JS，无 ONNX 依赖）。
 */
import {
  CUTOUT_MODELS,
  cutoutInputSize,
  findCutoutModel,
  planesFromRgba,
  probabilitiesToMask,
  removalMaskFromAlpha,
  resizeMaskBilinear,
  spanToMask,
} from './cutout.js';

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

function rgbaAt(pixels) {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

console.log('cutout');
test('模型注册表可查找且含三个人像/物体模型', () => {
  assert(CUTOUT_MODELS.length === 3, '模型数量应为 3');
  for (const model of CUTOUT_MODELS) {
    assert(findCutoutModel(model.id) === model, `按 id 查找失败：${model.id}`);
  }
  assert(findCutoutModel('nope') === null, '未知 id 应返回 null');
});

test('RVM 输入尺寸按长边 512、16 对齐', () => {
  assert(JSON.stringify(cutoutInputSize('person', 1920, 1080)) === JSON.stringify({ width: 512, height: 288 }), '1920×1080');
  assert(JSON.stringify(cutoutInputSize('person', 100, 200)) === JSON.stringify({ width: 256, height: 512 }), '100×200');
});

test('Selfie / IS-Net 使用固定方形输入', () => {
  assert(cutoutInputSize('selfie', 900, 600).width === 256, 'selfie');
  assert(cutoutInputSize('object', 900, 600).width === 1024, 'object');
});

test('RGBA → RGB 三平面顺序正确', () => {
  const planes = planesFromRgba(rgbaAt([[255, 0, 0], [0, 255, 0]]), 2, 1, 2, 1);
  assert(Math.abs(planes[0] - 1) < 1e-6 && Math.abs(planes[1]) < 1e-6, 'R plane');
  assert(Math.abs(planes[2]) < 1e-6 && Math.abs(planes[3] - 1) < 1e-6, 'G plane');
  assert(Math.abs(planes[4]) < 1e-6 && Math.abs(planes[5]) < 1e-6, 'B plane');
});

test('最近邻缩放不越界', () => {
  const planes = planesFromRgba(rgbaAt([[10, 20, 30]]), 1, 1, 7, 5);
  for (let i = 0; i < 3 * 35; i += 1) {
    assert(planes[i] >= 0 && planes[i] <= 1, '取值范围');
  }
});

test('概率掩膜四舍五入并夹取', () => {
  const mask = probabilitiesToMask(new Float32Array([0, 0.5, 1, 1.4, -0.2]), 5, 1);
  assert(JSON.stringify([...mask]) === JSON.stringify([0, 128, 255, 255, 0]), JSON.stringify([...mask]));
});

test('IS-Net 输出按最小最大值拉伸', () => {
  const mask = spanToMask(new Float32Array([-3, 1, 5]), 3, 1);
  assert(JSON.stringify([...mask]) === JSON.stringify([0, 128, 255]), JSON.stringify([...mask]));
});

test('双线性缩放与像素中心对齐', () => {
  const out = resizeMaskBilinear(new Uint8Array([0, 255]), 2, 1, 4, 1);
  assert(JSON.stringify([...out]) === JSON.stringify([0, 64, 191, 255]), JSON.stringify([...out]));
  const same = resizeMaskBilinear(new Uint8Array([1, 2, 3, 4]), 2, 2, 2, 2);
  assert(JSON.stringify([...same]) === JSON.stringify([1, 2, 3, 4]), '同尺寸应原样返回');
});

test('主体 alpha 转为去除掩膜', () => {
  const mask = removalMaskFromAlpha(new Uint8Array([0, 128, 255]), 3, 1);
  assert(JSON.stringify([...mask]) === JSON.stringify([255, 127, 0]), JSON.stringify([...mask]));
});

console.log(`\ncutout: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
