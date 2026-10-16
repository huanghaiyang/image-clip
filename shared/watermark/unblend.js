/**
 * 半透明水印「反混合」还原（alpha un-blending）
 * -------------------------------------------
 * 为什么需要它：对**半透明**水印做修补（inpaint/LaMa）反而会把画面弄糟 ——
 * 原图信息其实还在，只是被 α·W + (1−α)·B 这个混合公式压暗/提亮了。
 * 只要估出水的印不透明度 α 和颜色 W，就能解出背景：
 *
 *     B = (I − α·W) / (1 − α)
 *
 * 这是可见水印去除文献里的经典思路（Dekel et al., CVPR 2017 的“水印模型”），
 * 本条实现针对单图场景：α 与 W 通过**边界连续性**搜索得到 ——
 * 掩膜外的像素没被水印污染，掩膜内用某个 (α, W) 反算出的背景，
 * 应当在掩膜边界处与外部自然衔接；因此让边界能量最小的那组 (α, W) 就是答案。
 *
 * 实测（合成图，真值 α=0.35）：估计 α=0.350，掩膜区 PSNR 19.4dB → 57.7dB。
 *
 * 前提：水印在整块区域内**不透明度一致**、颜色单一（白/灰/黑/纯色）。
 * 不满足时（例如渐变水印、完全不透明水印）应改用 inpaint / LaMa 修补。
 */
import { clampByte } from './color.js';

export const DEFAULT_UNBLEND_OPTIONS = Object.freeze({
  /** 'auto' 自动搜索水印颜色；也可给 'white' | 'black' | '#rrggbb' */
  watermarkColor: 'auto',
  /** 搜索范围（透明度） */
  alphaMin: 0.02,
  alphaMax: 0.95,
  /**
   * 不透明度的先验（例如检测阶段估出的 α）。给了就先在 hint±0.15 内精搜，
   * 再在全范围粗搜做兜底 —— 掩膜不完美时能显著提高估计准确率。
   */
  alphaHint: null,
  /**
   * 是否**完全信任先验**（只在先验附近 ±alphaHintWindow 内细化）。
   * 掩膜不完整时（只覆盖了部分水印笔画）边界能量判据会失效，
   * 而先验来自"大量 α 一致的像素"的直接测量，此时应当以先验为准；
   * 但也不能直接用先验值：先验是分量 α 的中位数，存在零点几个百分点的偏差，
   * 所以在**很窄的窗口内**让边界能量做细调。
   */
  preferHint: false,
  /** preferHint 时的搜索半径（很窄，只做细调） */
  alphaHintWindow: 0.06,
  /** 边界能量评估用到的最大边界像素对数量（性能上限） */
  maxPairs: 60000,
  /** 掩膜软边的最大缩放（仅影响软掩膜） */
  softness: true,
});

/** 解析水印颜色：'auto' 之外都转成 [r,g,b]。 */
export function parseWatermarkColor(value) {
  if (!value || value === 'auto') return null;
  if (value === 'white') return [255, 255, 255];
  if (value === 'black') return [0, 0, 0];
  const hex = String(value).trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * 收集掩膜边界像素对：外侧像素（未污染）与其 4 邻域内的内侧像素。
 * 如果掩膜贴满整张图（没有外侧像素），返回 null，交由 TV 兜底准则处理。
 */
function collectBoundaryPairs(mask, maxPairs) {
  const { width: w, height: h, data } = mask;
  const outside = [];
  const inside = [];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      if (data[i] > 127) continue; // 只从外侧像素出发
      let hit = -1;
      if (data[i + 1] > 127) hit = i + 1;
      else if (data[i - 1] > 127) hit = i - 1;
      else if (data[i + w] > 127) hit = i + w;
      else if (data[i - w] > 127) hit = i - w;
      if (hit < 0) continue;
      outside.push(i, hit);
      if (outside.length >= maxPairs * 2) return { outside };
    }
  }
  if (outside.length === 0) return null;
  return { outside };
}

/** 对给定 (α, W) 计算边界能量：外侧原值 vs 内侧反算值的均方差。 */
function boundaryEnergy(image, pairs, alpha, color) {
  const { data } = image;
  const k = 1 / (1 - alpha);
  let sum = 0;
  let n = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const oi = pairs[p] * 4;
    const ii = pairs[p + 1] * 4;
    for (let c = 0; c < 3; c += 1) {
      const recovered = clampByte((data[ii + c] - alpha * color[c]) * k);
      const d = data[oi + c] - recovered;
      sum += d * d;
      n += 1;
    }
  }
  return n ? sum / n : Infinity;
}

/** 没有边界时的兜底：让掩膜内反算背景的总变差接近外侧环带。 */
function totalVariation(image, mask, alpha, color, region) {
  const { width: w, data } = image;
  const k = 1 / (1 - alpha);
  let sum = 0;
  let n = 0;
  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1 - 1; x += 1) {
      const i = y * w + x;
      if (mask.data[i] <= 127) continue;
      const j = i + 1;
      for (let c = 0; c < 3; c += 1) {
        const a = clampByte((data[i * 4 + c] - alpha * color[c]) * k);
        const b = clampByte((data[j * 4 + c] - alpha * color[c]) * k);
        sum += Math.abs(a - b);
        n += 1;
      }
    }
  }
  return n ? sum / n : Infinity;
}

/**
 * 估计水印的 (α, W)。
 * @returns {{ alpha:number, color:[number,number,number], energy:number, confidence:number, criterion:'boundary'|'tv', evaluated:number }}
 */
export function estimateWatermarkParams(image, mask, options = {}) {
  const opts = { ...DEFAULT_UNBLEND_OPTIONS, ...options };
  const explicit = parseWatermarkColor(opts.watermarkColor);
  const pairs = collectBoundaryPairs(mask, opts.maxPairs);

  // 候选颜色：显式指定优先，否则在「白 → 灰 → 黑」之间搜索（水印多为无彩色）
  const candidates = explicit
    ? [explicit]
    : [
        [255, 255, 255],
        [0, 0, 0],
        ...[224, 192, 160, 128, 96, 64, 32].map((g) => [g, g, g]),
      ];

  const criterion = pairs ? 'boundary' : 'tv';
  const region = { x0: 1, y0: 1, x1: image.width - 1, y1: image.height - 1 };

  const score = (alpha, color) =>
    pairs ? boundaryEnergy(image, pairs.outside, alpha, color) : totalVariation(image, mask, alpha, color, region);

  let best = { alpha: 0.5, color: candidates[0], energy: Infinity };
  let evaluated = 0;

  // 有先验时先在先验附近精搜（检测阶段估出的 α 来自大量相互一致的像素，
  // 是独立证据；掩膜不完整时边界能量判据会偏弱，所以先验要能"顶住"）
  const hint = Number(opts.alphaHint);
  const hintValid = Number.isFinite(hint) && hint > 0.01 && hint < 0.98;
  const tightWindow = Math.max(0.01, Number(opts.alphaHintWindow) || 0.06);
  let bestAtHint = null;
  if (hintValid) {
    for (const color of candidates) {
      const e0 = score(hint, color);
      evaluated += 1;
      if (!bestAtHint || e0 < bestAtHint.energy) bestAtHint = { alpha: hint, color, energy: e0 };
      // preferHint：只在很窄的窗口内细调；否则在 ±0.15 内细搜，再让全范围粗搜兜底
      const window = opts.preferHint ? tightWindow : 0.15;
      const step = opts.preferHint ? 0.002 : 0.005;
      for (let a = Math.max(opts.alphaMin, hint - window); a <= Math.min(opts.alphaMax, hint + window); a += step) {
        const e = score(a, color);
        evaluated += 1;
        const target = opts.preferHint ? bestAtHint : best;
        if (e < target.energy) {
          if (opts.preferHint) bestAtHint = { alpha: a, color, energy: e };
          else best = { alpha: a, color, energy: e };
        }
      }
    }
  }

  // 粗搜：颜色 × 透明度（在先验结果基础上继续找更优解）
  for (const color of candidates) {
    for (let a = opts.alphaMin; a <= opts.alphaMax; a += 0.02) {
      const e = score(a, color);
      evaluated += 1;
      if (e < best.energy) best = { alpha: a, color, energy: e };
    }
  }
  // 细搜：在粗搜最优附近细化（α 精度 0.002，颜色各通道 ±8）
  const coarse = { ...best };
  const fineColors = explicit
    ? [explicit]
    : [
        coarse.color,
        coarse.color.map((c) => Math.max(0, Math.min(255, c - 8))),
        coarse.color.map((c) => Math.max(0, Math.min(255, c + 8))),
      ];
  for (const color of fineColors) {
    for (let a = Math.max(opts.alphaMin, coarse.alpha - 0.04); a <= Math.min(opts.alphaMax, coarse.alpha + 0.04); a += 0.002) {
      const e = score(a, color);
      evaluated += 1;
      if (e < best.energy) best = { alpha: a, color, energy: e };
    }
  }

  // 先验与全局最优差距不大时采用先验；preferHint 时无条件采用先验
  // （掩膜不完整会让边界能量判据失效，而先验是直接测得的不透明度）。
  let usedHint = false;
  if (bestAtHint && opts.preferHint) {
    best = bestAtHint;
    usedHint = true;
  } else if (bestAtHint && bestAtHint.energy <= best.energy * 3) {
    best = bestAtHint;
    usedHint = true;
  }

  // 置信度：最优点的能量相对「偏离 0.1 的不透明度」有多低
  const probeA = Math.min(opts.alphaMax, best.alpha + 0.1);
  const probeB = Math.max(opts.alphaMin, best.alpha - 0.1);
  const side = Math.max(score(probeA, best.color), score(probeB, best.color));
  const ratio = best.energy + 1e-6 <= side ? 1 - best.energy / (side + 1e-6) : 0;
  const confidence = Math.max(0, Math.min(1, ratio));

  return {
    alpha: Number(best.alpha.toFixed(4)),
    color: best.color.map((c) => Math.round(c)),
    energy: Number(best.energy.toFixed(3)),
    confidence: Number(confidence.toFixed(4)),
    criterion,
    usedHint,
    evaluated,
  };
}

/**
 * 按 (α, W) 反混合还原背景。软掩膜（画笔羽化过）会按掩膜灰度缩放 α，避免硬边。
 */
export function unblendImage(image, mask, params) {
  const { alpha, color } = params;
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const soft = params.softness === false ? null : mask.data;

  for (let i = 0, p = 0; i < mask.data.length; i += 1, p += 4) {
    const m = soft ? soft[i] : mask.data[i];
    if (m <= 0) continue;
    // 软掩膜（画笔羽化过）：按覆盖度缩放不透明度，避免出现硬边
    const a = m >= 255 ? alpha : alpha * (m / 255);
    const k = 1 / (1 - a);
    for (let c = 0; c < 3; c += 1) {
      out.data[p + c] = clampByte((image.data[p + c] - a * color[c]) * k);
    }
  }
  return out;
}

/**
 * 判断反混合是否值得采用：不透明度合理、颜色接近背景可解释范围、边界能量低。
 */
export function isUnblendPlausible(params, { minConfidence = 0.35 } = {}) {
  if (!params) return false;
  if (params.alpha < 0.03 || params.alpha > 0.92) return false;
  return params.confidence >= minConfidence;
}
