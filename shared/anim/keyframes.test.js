/**
 * 关键帧 / 缓动单元测试。
 */
import {
  EASING_PRESETS,
  createAnimation,
  createTrack,
  cubicBezier,
  easeValue,
  frameTimes,
  hasKeyAt,
  keyframeTimes,
  loopTime,
  removeKey,
  sampleAnimation,
  sampleTrack,
  setKey,
} from './keyframes.js';

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

function near(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

test('线性缓动两端点精确', () => {
  const ease = cubicBezier(0, 0, 1, 1);
  assert(ease(0) === 0 && ease(1) === 1, '端点必须是 0/1');
  assert(near(ease(0.5), 0.5, 0.01), `线性中点应约 0.5，实际 ${ease(0.5)}`);
});

test('easeIn 前段慢、easeOut 前段快', () => {
  assert(easeValue('easeIn', 0.25) < 0.25, 'easeIn 起步慢');
  assert(easeValue('easeOut', 0.25) > 0.25, 'easeOut 起步快');
  assert(near(easeValue('easeInOut', 0.5), 0.5, 0.02), 'easeInOut 中点对称');
});

test('hold 只在末尾跳变', () => {
  assert(easeValue('hold', 0.2) === 0, '中途保持起点');
  assert(easeValue('hold', 0.99) === 0, '99% 仍保持');
  assert(easeValue('hold', 1) === 1, '末尾跳到终点');
});

test('关键帧插值：首尾外推、区间内缓动', () => {
  const track = createTrack('x', 0);
  setKey(track, 1, 100, 'linear');
  assert(sampleTrack(track, 0) === 0, '起点前取第一帧');
  assert(sampleTrack(track, 2) === 100, '终点后取最后一帧');
  assert(near(sampleTrack(track, 0.5), 50, 1), `中点应约 50，实际 ${sampleTrack(track, 0.5)}`);
});

test('同一时刻重复打键覆盖而不新增', () => {
  const track = createTrack('x', 0);
  setKey(track, 1, 10, 'linear');
  setKey(track, 1, 20, 'hold');
  assert(track.keys.length === 2, `关键帧数应保持 2，实际 ${track.keys.length}`);
  assert(track.keys[1].v === 20, '应覆盖为新值');
  assert(track.keys[1].easing === 'hold', '应覆盖缓动');
});

test('删除关键帧至少保留一个', () => {
  const track = createTrack('x', 5);
  assert(removeKey(track, 0) === false, '只剩一个时不允许删除');
  setKey(track, 1, 9);
  assert(removeKey(track, 1) === true, '有两个时应能删');
});

test('循环 / 往返 / 单次', () => {
  assert(near(loopTime(2.5, 2, 'loop'), 0.5), '循环取模');
  assert(near(loopTime(2.75, 2, 'pingpong'), 1.25), '往返折回');
  assert(loopTime(5, 2, 'once') === 2, '单次停在末尾');
});

test('采样整份动画时缺轨道回退图层值', () => {
  const anim = createAnimation({ duration: 2 });
  setKey((anim.tracks.l1 = { x: createTrack('x', 0) }).x, 1, 40);
  const sample = sampleAnimation(anim, 0.5, 'l1', { x: 0, y: 10, scaleX: 1, scaleY: 1, rotation: 0, opacity: 80 });
  assert(sample.y === 10, '没有轨道时用回退值');
  assert(sample.opacity === 80, '不透明度回退');
  assert(sample.x > 0 && sample.x < 40, `x 应在区间内，实际 ${sample.x}`);
});

test('关键帧时间并集与帧序列', () => {
  const anim = createAnimation({ duration: 1 });
  anim.tracks.l1 = { x: createTrack('x'), y: createTrack('y') };
  setKey(anim.tracks.l1.x, 0.5, 1);
  setKey(anim.tracks.l1.y, 0.25, 2);
  assert(JSON.stringify(keyframeTimes(anim)) === JSON.stringify([0, 0.25, 0.5]), JSON.stringify(keyframeTimes(anim)));
  const times = frameTimes(anim, 4);
  assert(times.length === 4 && near(times[0], 0) && near(times[3], 0.75), JSON.stringify(times));
});

test('缓动预设齐全', () => {
  for (const name of ['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut']) {
    assert(Array.isArray(EASING_PRESETS[name]) && EASING_PRESETS[name].length === 4, `预设 ${name} 应为 4 个控制点`);
  }
  assert(hasKeyAt(createTrack('x'), 0), '默认轨道在 0 处有关键帧');
});

console.log(`\nkeyframes: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
