/**
 * 关键帧与缓动 —— 纯算法，浏览器与 Node 共用
 * -------------------------------------------
 * AE 时间轴的最小可用模型：一条属性 = 一条轨道（track），
 * 轨道里是按时间排好序的关键帧 {t, v, easing}。
 *
 * 缓动的实现是三次贝塞尔 + 牛顿迭代求 x 对应的参数，
 * 和 CSS cubic-bezier / AE 的「速度图表」是同一套数学，
 * 所以前端面板给出的曲线和导出结果一致。
 */

/** 可动画的图层属性。sprite 用 frame 表示「第几帧」，只认 hold。 */
export const TRACK_PROPS = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'frame'];

export const EASING_PRESETS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  strongIn: [0.6, 0, 1, 0.6],
  strongOut: [0, 0.4, 0.4, 1],
};

const NEWTON_ITERATIONS = 6;

function bezierAt(p1, p2, t) {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function bezierSlope(p1, p2, t) {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** 用贝塞尔控制点求 ease(t)：先解 x(t)=x，再取 y(t)。 */
export function cubicBezier(x1, y1, x2, y2) {
  const p1 = [Math.max(0, Math.min(1, x1)), y1];
  const p2 = [Math.max(0, Math.min(1, x2)), y2];
  return function ease(x) {
    const target = Math.max(0, Math.min(1, Number(x) || 0));
    if (target === 0) return 0;
    if (target === 1) return 1;
    let t = target;
    for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
      const diff = bezierAt(p1[0], p2[0], t) - target;
      if (Math.abs(diff) < 1e-5) break;
      const slope = bezierSlope(p1[0], p2[0], t);
      if (Math.abs(slope) < 1e-6) break;
      t -= diff / slope;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
    }
    return bezierAt(p1[1], p2[1], t);
  };
}

const easeCache = new Map();

/** easing 可以是预设名、'hold'、或 {bezier:[x1,y1,x2,y2]}。 */
export function easeValue(easing, t) {
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  if (easing === 'hold' || easing === 'step') return x >= 1 ? 1 : 0;
  let points = EASING_PRESETS.linear;
  if (typeof easing === 'string' && EASING_PRESETS[easing]) points = EASING_PRESETS[easing];
  else if (easing && Array.isArray(easing.bezier) && easing.bezier.length === 4) points = easing.bezier;
  const key = points.join(',');
  let fn = easeCache.get(key);
  if (!fn) {
    fn = cubicBezier(points[0], points[1], points[2], points[3]);
    easeCache.set(key, fn);
  }
  return fn(x);
}

export function createTrack(property, value = 0) {
  return { property, keys: [{ t: 0, v: Number(value) || 0, easing: 'linear' }] };
}

export function createAnimation({ fps = 24, duration = 2, loop = 'loop' } = {}) {
  return { fps, duration, loop, tracks: {} };
}

function sortKeys(track) {
  track.keys.sort((a, b) => a.t - b.t);
}

/** 打一个关键帧；同一时刻（±1e-3s）已有关键帧则覆盖。返回该关键帧。 */
export function setKey(track, time, value, easing = 'ease') {
  const t = Math.max(0, Number(time) || 0);
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  const existing = track.keys.find((key) => Math.abs(key.t - t) < 1e-3);
  if (existing) {
    existing.v = v;
    existing.easing = easing;
    return existing;
  }
  const key = { t, v, easing };
  track.keys.push(key);
  sortKeys(track);
  return key;
}

export function removeKey(track, time) {
  const t = Number(time) || 0;
  const index = track.keys.findIndex((key) => Math.abs(key.t - t) < 1e-3);
  if (index < 0) return false;
  // 至少留一个关键帧，否则轨道没有意义
  if (track.keys.length <= 1) return false;
  track.keys.splice(index, 1);
  return true;
}

export function hasKeyAt(track, time) {
  const t = Number(time) || 0;
  return track.keys.some((key) => Math.abs(key.t - t) < 1e-3);
}

/**
 * 采样一条轨道。段缓动取「左关键帧的 easing」——这是 AE 的默认语义：
 * 缓动属于段起点，改一个关键帧的速度曲线只影响它右侧那一段。
 */
export function sampleTrack(track, time, fallback = 0) {
  const keys = track?.keys ?? [];
  if (!keys.length) return Number(fallback) || 0;
  if (keys.length === 1) return keys[0].v;
  const t = Number(time) || 0;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t > b.t) continue;
    const span = b.t - a.t;
    if (span <= 1e-6) return b.v;
    const k = easeValue(a.easing, (t - a.t) / span);
    return a.v + (b.v - a.v) * k;
  }
  return last.v;
}

/** 循环时间：loop 直接取模，pingpong 往返，once 到达末尾后停住。 */
export function loopTime(time, duration, mode = 'loop') {
  const d = Math.max(1e-3, Number(duration) || 0);
  const t = Math.max(0, Number(time) || 0);
  if (mode === 'once') return Math.min(t, d);
  if (mode === 'pingpong') {
    const period = d * 2;
    const phase = t % period;
    return phase <= d ? phase : period - phase;
  }
  return t % d;
}

/** 所有轨道关键帧时间的并集（面板画刻度用）。兼容「按图层嵌套」与「扁平」两种结构。 */
export function keyframeTimes(animation) {
  const set = new Set();
  const tracks = animation?.tracks ?? {};
  for (const value of Object.values(tracks)) {
    if (!value) continue;
    if (Array.isArray(value.keys)) {
      for (const key of value.keys) set.add(Number(key.t.toFixed(3)));
      continue;
    }
    for (const track of Object.values(value)) {
      for (const key of track?.keys ?? []) set.add(Number(key.t.toFixed(3)));
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 采样整份动画：返回 {x, y, scaleX, scaleY, rotation, opacity, frame}，
 * 缺轨道的属性返回 fallback。
 * tracks 的 key 是图层 id，值是 {x: track, y: track, ...}。
 */
export function sampleAnimation(animation, time, layerId, fallback = {}) {
  const out = {};
  for (const prop of TRACK_PROPS) {
    const track = animation?.tracks?.[layerId]?.[prop];
    const base = fallback[prop];
    out[prop] = track ? sampleTrack(track, time, base) : base;
  }
  return out;
}

export function ensureTrack(animation, layerId, prop, value = 0) {
  animation.tracks = animation.tracks ?? {};
  animation.tracks[layerId] = animation.tracks[layerId] ?? {};
  if (!animation.tracks[layerId][prop]) {
    animation.tracks[layerId][prop] = createTrack(prop, value);
  }
  return animation.tracks[layerId][prop];
}

/** 导出精灵条前用：按帧率把整段动画拆成时间点。 */
export function frameTimes(animation, count) {
  const total = Math.max(1, Math.round(Number(count) || 1));
  const duration = Math.max(1e-3, Number(animation?.duration) || 0);
  const times = [];
  for (let i = 0; i < total; i += 1) {
    times.push(loopTime((i * duration) / total, duration, 'once'));
  }
  return times;
}
