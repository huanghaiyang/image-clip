/**
 * 视频特效滤镜链编译单元测试（不依赖 ffmpeg 可执行文件）。
 */
import { buildArgs, buildFilterChain, normalizeEffect, EFFECT_TYPES } from '../src/effects.js';

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

test('参数范围会被夹紧', () => {
  const effect = normalizeEffect({ type: 'eq', brightness: 9, contrast: -5, saturation: 2 });
  assert(effect.brightness === 1, `brightness 应夹到 1，实际 ${effect.brightness}`);
  assert(effect.contrast === 0, `contrast 应夹到 0，实际 ${effect.contrast}`);
  assert(effect.saturation === 2, `saturation 保留 2，实际 ${effect.saturation}`);
});

test('未知效果直接拒绝', () => {
  let threw = false;
  try {
    normalizeEffect({ type: 'rm -rf' });
  } catch (err) {
    threw = /不支持/.test(err.message);
  }
  assert(threw, '未知类型必须抛错，不能把字符串塞进滤镜链');
});

test('基础线性滤镜链', () => {
  const graph = buildFilterChain([
    { type: 'eq', brightness: 0.1, contrast: 1.2, saturation: 0.8 },
    { type: 'blur', sigma: 3 },
    { type: 'sharpen', amount: 1.5, size: 7 },
    { type: 'vignette', angle: 0.5 },
    { type: 'invert' },
  ]);
  assert(graph.complex === null, '没有 glow 时不应产生 filter_complex');
  assert(graph.chain.includes('eq=brightness=0.1:contrast=1.2:saturation=0.8'), graph.chain);
  assert(graph.chain.includes('gblur=sigma=3'), 'blur');
  assert(graph.chain.includes('unsharp=7:7:1.5'), 'sharpen');
  assert(graph.chain.includes('negate'), 'invert');
});

test('发光走 split + blend 的 filter_complex', () => {
  const graph = buildFilterChain([{ type: 'eq', contrast: 1.1 }, { type: 'glow', radius: 20, opacity: 0.4 }]);
  assert(graph.complex.includes('split=2[b1][b2]'), graph.complex);
  assert(graph.complex.includes('gblur=sigma=20'), graph.complex);
  assert(graph.complex.includes('blend=all_mode=screen:all_opacity=0.4'), graph.complex);
  assert(graph.complex.includes('[vout]'), '必须输出 [vout]');
});

test('只有 glow 时也要能成立', () => {
  const graph = buildFilterChain([{ type: 'glow', radius: 8, opacity: 0.2 }]);
  assert(graph.complex.includes('[0:v]split=2[b1][b2]'), graph.complex);
});

test('变速与补帧', () => {
  const graph = buildFilterChain([
    { type: 'retime', speed: 2, fps: 60, interpolate: 1 },
    { type: 'eq', contrast: 1 },
  ]);
  assert(graph.chain.startsWith('setpts=0.5*PTS'), graph.chain);
  assert(graph.chain.includes('minterpolate=fps=60:mi_mode=mci'), graph.chain);
  assert(graph.needsAudioTempo === 2, '音频需要 atempo');
});

test('lut 只在给了路径时才加进链里', () => {
  assert(buildFilterChain([{ type: 'lut' }]).chain === '', '没有路径不能生成 lut3d');
  const graph = buildFilterChain([{ type: 'lut' }], { lutPath: 'D:\\lib\\look.cube' });
  assert(graph.chain.includes('lut3d=file='), graph.chain);
  assert(graph.chain.includes('D\\:/lib/look.cube') || graph.chain.includes('D\\\\:/lib'), '路径需要转义');
});

test('buildArgs：映射、编码与音频 tempo', () => {
  const graph = buildFilterChain([{ type: 'eq', contrast: 1.5 }, { type: 'retime', speed: 1.5 }]);
  const args = buildArgs({ input: 'in.mp4', output: 'out.webm', start: 1.5, duration: 3, graph, format: 'webm', speed: 1.5, hasAudio: true });
  assert(args.includes('-ss') && args.includes('1.5'), '起始时间');
  assert(args.includes('-t') && args.includes('3'), '时长');
  assert(args.includes('libvpx-vp9'), 'webm 编码');
  assert(args.includes('-map'), '必须显式映射');
  const audioIndex = args.indexOf('-filter:a');
  assert(audioIndex > 0 && args[audioIndex + 1].includes('atempo=1.5'), '音频应有 atempo');
});

test('buildArgs：complex 图走 -filter_complex + [vout]', () => {
  const graph = buildFilterChain([{ type: 'glow' }]);
  const args = buildArgs({ input: 'in.mp4', output: 'out.mp4', graph, format: 'mp4', hasAudio: false });
  assert(args.includes('-filter_complex'), 'complex');
  assert(args.includes('[vout]'), '映射标签');
  assert(!args.includes('0:a?'), '无音轨时不能映射音频');
  assert(!args.includes('-vf'), 'complex 模式不应再用 -vf');
});

test('效果类型清单稳定', () => {
  for (const type of ['eq', 'blur', 'sharpen', 'glow', 'vignette', 'invert', 'lut', 'retime', 'colorTemp']) {
    assert(EFFECT_TYPES.includes(type), `缺少效果 ${type}`);
  }
});

console.log(`\neffects: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
