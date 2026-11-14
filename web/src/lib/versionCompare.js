/**
 * 历史版本对比的纯计算部分（不依赖 DOM / Vue，方便单测）
 * ----------------------------------------------------
 * 图片：逐像素求差 → 统计「差异像素 / 占比 / 平均差 / 最大差 / alpha 变化」，
 *       并生成一张放大的灰度差异图给画布直接 putImageData。
 * 音频：把 AudioBuffer 的声道数据按列压成 min/max/RMS，再比较两条波形的列差异。
 * 视频：逐帧对比只要帧号 ⇄ 秒数换算（真正的解码交给 <video>）。
 */

/** 判定“这个像素变了”的默认阈值（任一通道差值 > 阈值）。JPEG 重编码噪声通常在 1–3。 */
export const DEFAULT_PIXEL_THRESHOLD = 2;

/**
 * 逐像素比较两张 **同尺寸** RGBA 图。
 *
 * @param {Uint8ClampedArray} a 旧版本像素（RGBA）
 * @param {Uint8ClampedArray} b 当前像素（RGBA）
 * @param {{width:number,height:number,threshold?:number,gain?:number}} options
 *   threshold：任一通道差 > 该值才算“不同”；gain：差异图放大倍数（默认 4，暗差也能看见）
 * @returns {{
 *   width:number, height:number, totalPixels:number,
 *   diffPixels:number, ratio:number, meanDelta:number, maxDelta:number,
 *   alphaDiffPixels:number, diff:Uint8ClampedArray
 * }}
 */
export function diffImageData(a, b, { width, height, threshold = DEFAULT_PIXEL_THRESHOLD, gain = 4 } = {}) {
  if (!a || !b) throw new TypeError('diffImageData: 需要两张图的像素数据');
  const total = width * height;
  if (!total) return { width: 0, height: 0, totalPixels: 0, diffPixels: 0, ratio: 0, meanDelta: 0, maxDelta: 0, alphaDiffPixels: 0, diff: new Uint8ClampedArray(0) };
  if (a.length < total * 4 || b.length < total * 4) throw new RangeError('diffImageData: 像素数据长度不足');

  const diff = new Uint8ClampedArray(total * 4);
  let diffPixels = 0;
  let alphaDiffPixels = 0;
  let sumDelta = 0;
  let maxDelta = 0;

  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    const dr = Math.abs(a[p] - b[p]);
    const dg = Math.abs(a[p + 1] - b[p + 1]);
    const db = Math.abs(a[p + 2] - b[p + 2]);
    const da = Math.abs(a[p + 3] - b[p + 3]);
    // 每个像素取通道最大差：既不像 L1 那样被大片小差淹没，也能看见单通道偏色
    const delta = Math.max(dr, dg, db, da);
    sumDelta += delta;
    if (delta > maxDelta) maxDelta = delta;
    if (delta > threshold) {
      diffPixels += 1;
      if (da > threshold) alphaDiffPixels += 1;
    }
    const shade = Math.min(255, delta * gain);
    diff[p] = shade;
    diff[p + 1] = shade;
    diff[p + 2] = shade;
    diff[p + 3] = 255;
  }

  return {
    width,
    height,
    totalPixels: total,
    diffPixels,
    ratio: diffPixels / total,
    meanDelta: sumDelta / total,
    maxDelta,
    alphaDiffPixels,
    diff,
  };
}

/**
 * 把音频声道数据压成每列的 min / max / RMS，供画波形用。
 *
 * @param {ArrayLike<Float32Array>} channels 各声道样本（-1..1）
 * @param {{columns?:number,sampleRate?:number,duration?:number}} [options]
 * @returns {{columns:number, min:Float32Array, max:Float32Array, rms:Float32Array,
 *   sampleRate:number, duration:number, channels:number}}
 */
export function buildAudioPeaks(channels, { columns = 1200, sampleRate = 0, duration = 0 } = {}) {
  const list = Array.from(channels ?? []).filter((channel) => channel && channel.length);
  const count = Math.max(1, Math.min(4000, Math.round(Number(columns) || 1200)));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const rms = new Float32Array(count);
  if (!list.length) return { columns: count, min, max, rms, sampleRate, duration, channels: 0 };

  const frames = list[0].length;
  const per = Math.max(1, Math.ceil(frames / count));
  for (let column = 0; column < count; column += 1) {
    const start = column * per;
    const end = Math.min(frames, start + per);
    if (start >= end) {
      min[column] = 0;
      max[column] = 0;
      rms[column] = 0;
      continue;
    }
    let lo = 1;
    let hi = -1;
    let sumSq = 0;
    let samples = 0;
    for (let i = start; i < end; i += 1) {
      // 多声道取平均值：单声道和立体声的波形形状可以直接对照
      let value = 0;
      for (const channel of list) value += channel[i] ?? 0;
      value /= list.length;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
      sumSq += value * value;
      samples += 1;
    }
    min[column] = lo;
    max[column] = hi;
    rms[column] = Math.sqrt(sumSq / Math.max(1, samples));
  }
  return { columns: count, min, max, rms, sampleRate, duration, channels: list.length };
}

/**
 * 比较两条波形（列数必须一致；不一致时按较短的对齐并报告缺口）。
 * 用 RMS 列做主体判据：它比瞬时峰值稳定，能代表“这一段能量变了”。
 *
 * @returns {{columns:number, maxDelta:number, maxDeltaIndex:number, meanDelta:number,
 *   changedColumns:number, ratio:number, comparableColumns:number}}
 */
export function comparePeaks(a, b) {
  const columns = Math.min(a?.columns ?? 0, b?.columns ?? 0);
  if (!columns) {
    return { columns: 0, maxDelta: 0, maxDeltaIndex: -1, meanDelta: 0, changedColumns: 0, ratio: 0, comparableColumns: 0 };
  }
  let maxDelta = 0;
  let maxDeltaIndex = -1;
  let sumDelta = 0;
  let changedColumns = 0;
  for (let i = 0; i < columns; i += 1) {
    const delta = Math.abs((a.rms[i] ?? 0) - (b.rms[i] ?? 0));
    sumDelta += delta;
    if (delta > 0.02) changedColumns += 1;
    if (delta > maxDelta) {
      maxDelta = delta;
      maxDeltaIndex = i;
    }
  }
  return {
    columns,
    maxDelta,
    maxDeltaIndex,
    meanDelta: sumDelta / columns,
    changedColumns,
    ratio: changedColumns / columns,
    comparableColumns: columns,
  };
}

/** 秒 → 帧号（从 0 开始，向下取整，避免浮点误差多算一帧）。 */
export function frameAt(seconds, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const value = Math.max(0, Number(seconds) || 0);
  return Math.floor(value * rate + 1e-6);
}

/** 帧号 → 秒。 */
export function frameTime(index, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  return Math.max(0, Number(index) || 0) / rate;
}

/** 秒 → mm:ss.ff（fps 用于小数位；没有 fps 时显示两位毫秒）。 */
export function formatFrameTime(seconds, fps = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(value);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  if (Number(fps) > 0) {
    const frames = Math.min(Math.round(Number(fps)) - 1, frameAt(value, fps) % Math.round(Number(fps)));
    return `${mm}:${ss}.${String(frames).padStart(2, '0')}`;
  }
  return `${mm}:${ss}.${String(Math.round((value - total) * 100)).padStart(2, '0')}`;
}

/** 0..1 → 百分比文本（差异统计用）。 */
export function formatPercent(value, digits = 2) {
  const n = Number(value) || 0;
  return `${(n * 100).toFixed(digits)}%`;
}
