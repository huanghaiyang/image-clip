/**
 * 背景去除的纯算法（浏览器 / Node 共用，零依赖）。
 *
 * 目标：任意底色（白、纯色、渐变、绿幕……）都能自动识别并抠掉。
 * 做法分三步，全部可解释：
 *
 *   1) **边框取色**：背景通常贴着画面边缘，统计图像四周 2px 环带里出现最多的颜色，
 *      量化到 4bit（每通道 16 档）后聚类合并。得到 1~3 个候选背景色，
 *      因此纯色、双色渐变、简单扎染底都能覆盖。
 *   2) **颜色距离 + 连通性**：按加权 RGB 距离（人眼对绿色更敏感）判定“像背景”。
 *      默认从四条边向内做 4 邻域漫水填充，只抠与边缘连通的区域——
 *      这样人物身上的白色衣服不会被误抠；需要“全图同色都去掉”时可关闭连通性。
 *   3) **边缘收放**：先按 `erode` 收缩（去掉描边残留），再按 `feather` 做箱式模糊，
 *      让 alpha 从 0 平滑过渡到原值，避免锯齿与白边。
 *
 * 掩膜语义：0 = 完全保留，255 = 完全去除；中间值表示半透明过渡。
 * 这与 `applyMaskToRgba()` 的乘法公式一一对应：alpha' = alpha × (1 − mask/255)。
 */

export const BG_DEFAULTS = Object.freeze({
  /** 颜色容差（0~255，加权 RGB 距离）。 */
  tolerance: 32,
  /** 只去除与画面边缘连通的背景。 */
  connected: true,
  /** 边缘羽化半径（像素，0 = 硬边）。 */
  feather: 2,
  /** 边缘收缩半径（像素，用来切掉底色描边）。 */
  erode: 0,
  /** alpha 小于等于该值的像素直接视为透明。 */
  alphaThreshold: 8,
  /** 最多识别几种背景色。 */
  maxColors: 3,
  /** 边框采样环带宽度（像素）。 */
  ring: 2,
});

const BUCKET_SHIFT = 4; // 每通道量化到 16 档（0~15）
const BUCKET_SIZE = 1 << BUCKET_SHIFT;

/** '#rgb' / '#rrggbb' / 'rgb(...)' / {r,g,b} → { r,g,b }；非法输入返回 null。 */
export function parseColor(input) {
  if (!input) return null;
  if (typeof input === 'object') {
    const r = Number(input.r);
    const g = Number(input.g);
    const b = Number(input.b);
    if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
      return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
    }
    return null;
  }
  const text = String(input).trim();
  const rgbMatch = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: clamp255(Number(rgbMatch[1])),
      g: clamp255(Number(rgbMatch[2])),
      b: clamp255(Number(rgbMatch[3])),
    };
  }
  let hex = text.replace(/^#/, '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length === 8) hex = hex.slice(0, 6);
  if (hex.length !== 6 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** {r,g,b} → '#rrggbb'。 */
export function colorToHex(color) {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0 };
  return `#${[c.r, c.g, c.b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 加权 RGB 距离（0~255）：0.299R² + 0.587G² + 0.114B² 再开方。
 * 用绿色权重更高，比直接取三通道最大差值更符合“看起来像不像同一种颜色”。
 */
export function colorDistance(r, g, b, color) {
  const c = parseColor(color);
  if (!c) return Infinity;
  const dr = r - c.r;
  const dg = g - c.g;
  const db = b - c.b;
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
}

/**
 * 检测边框主色。
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ring?:number,maxColors?:number,alphaThreshold?:number,mergeDistance?:number}} [options]
 * @returns {{colors:{r:number,g:number,b:number,hex:string,ratio:number,count:number}[], sampled:number, transparentRatio:number}}
 */
export function detectBackgroundColors(rgba, width, height, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  if (!rgba || rgba.length < w * h * 4) {
    throw new TypeError('detectBackgroundColors: rgba 长度必须 >= width*height*4');
  }
  const ring = Math.max(1, Math.min(32, Math.round(Number(options.ring) || BG_DEFAULTS.ring)));
  const alphaThreshold = Math.max(0, Math.min(255, Math.round(Number(options.alphaThreshold) || 0)));
  const maxColors = Math.max(1, Math.min(8, Math.round(Number(options.maxColors) || BG_DEFAULTS.maxColors)));
  const mergeDistance = Math.max(0, Number(options.mergeDistance) || 26);

  const buckets = new Map();
  let sampled = 0;
  let transparent = 0;

  const add = (x, y) => {
    const i = (y * w + x) * 4;
    sampled += 1;
    if (rgba[i + 3] <= alphaThreshold) {
      transparent += 1;
      return;
    }
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const key = ((r >> BUCKET_SHIFT) << 8) | ((g >> BUCKET_SHIFT) << 4) | (b >> BUCKET_SHIFT);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  };

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const edge = x < ring || y < ring || x >= w - ring || y >= h - ring;
      if (edge) add(x, y);
    }
  }

  // 量化桶 → 平均色，再按距离做一次贪心合并（相邻色阶往往是同一片渐变）
  const candidates = [...buckets.values()]
    .map((b) => ({ r: b.r / b.count, g: b.g / b.count, b: b.b / b.count, count: b.count }))
    .sort((a, b) => b.count - a.count);

  const merged = [];
  for (const c of candidates) {
    let target = null;
    for (const m of merged) {
      if (colorDistance(c.r, c.g, c.b, { r: m.r, g: m.g, b: m.b }) <= mergeDistance) {
        target = m;
        break;
      }
    }
    if (target) {
      const total = target.count + c.count;
      target.r = (target.r * target.count + c.r * c.count) / total;
      target.g = (target.g * target.count + c.g * c.count) / total;
      target.b = (target.b * target.count + c.b * c.count) / total;
      target.count = total;
    } else {
      merged.push({ ...c });
    }
  }
  merged.sort((a, b) => b.count - a.count);

  const opaqueSampled = Math.max(0, sampled - transparent);
  const colors = merged.slice(0, maxColors).map((c) => ({
    r: Math.round(c.r),
    g: Math.round(c.g),
    b: Math.round(c.b),
    hex: colorToHex(c),
    count: c.count,
    ratio: opaqueSampled ? c.count / opaqueSampled : 0,
  }));

  return {
    colors,
    sampled,
    transparentRatio: sampled ? transparent / sampled : 0,
  };
}

/**
 * 构建背景掩膜。
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
 *   colors?: ({r:number,g:number,b:number}|string)[],
 *   tolerance?: number,
 *   connected?: boolean,
 *   feather?: number,
 *   erode?: number,
 *   alphaThreshold?: number,
 *   selection?: Uint8Array|null,
 *   selectionMode?: 'all'|'inside'|'outside'
 * }} [options]
 * @returns {{mask:Uint8Array,width:number,height:number,coverage:number,backgroundPixels:number}}
 */
export function buildBackgroundMask(rgba, width, height, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const n = w * h;
  if (!rgba || rgba.length < n * 4) throw new TypeError('buildBackgroundMask: rgba 长度必须 >= width*height*4');

  const tolerance = clamp(Number(options.tolerance ?? BG_DEFAULTS.tolerance), 0, 255);
  const alphaThreshold = clamp(Number(options.alphaThreshold ?? BG_DEFAULTS.alphaThreshold), 0, 255);
  const connected = options.connected !== false;
  const colors = (options.colors ?? []).map(parseColor).filter(Boolean);
  const selectionMode = options.selectionMode ?? 'all';
  const selection = options.selection ?? null;

  // 没有可去除的背景色 → 什么都不改。
  // 否则会把“本来就是透明”的像素当成背景再羽化一圈，
  // 打开一张已抠好的结果图时，预览边缘会比导出的 PNG 更薄。
  if (!colors.length) {
    return { mask: new Uint8Array(n), width: w, height: h, coverage: 0, backgroundPixels: 0 };
  }

  // 1) 候选像素：透明像素 + 与任一背景色距离 <= 容差的不透明像素
  const candidate = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    if (rgba[p + 3] <= alphaThreshold) {
      candidate[i] = 1;
      continue;
    }
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    for (let c = 0; c < colors.length; c += 1) {
      if (colorDistance(r, g, b, colors[c]) <= tolerance) {
        candidate[i] = 1;
        break;
      }
    }
  }

  const mask = new Uint8Array(n);
  let backgroundPixels = 0;

  if (!connected) {
    for (let i = 0; i < n; i += 1) {
      if (candidate[i]) {
        mask[i] = 255;
        backgroundPixels += 1;
      }
    }
  } else {
    // 2) 从四条边向内漫水填充：只有与边缘连通的候选像素才算背景
    const stack = new Int32Array(n);
    let top = 0;
    const push = (index) => {
      if (!candidate[index] || mask[index]) return;
      mask[index] = 255;
      backgroundPixels += 1;
      stack[top++] = index;
    };

    for (let x = 0; x < w; x += 1) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y += 1) {
      push(y * w);
      push(y * w + w - 1);
    }

    while (top > 0) {
      const index = stack[--top];
      const x = index % w;
      const y = (index - x) / w;
      if (x > 0) push(index - 1);
      if (x + 1 < w) push(index + 1);
      if (y > 0) push(index - w);
      if (y + 1 < h) push(index + w);
    }
  }

  // 3) 套索选区限制（仅选区内 / 仅选区外）
  let output = mask;
  if (selection && selectionMode !== 'all') {
    output = new Uint8Array(n);
    let hits = 0;
    for (let i = 0; i < n; i += 1) {
      const inside = selection[i] > 127;
      const keep = selectionMode === 'inside' ? inside : !inside;
      if (keep && mask[i]) {
        output[i] = mask[i];
        hits += 1;
      }
    }
    backgroundPixels = hits;
  }

  // 4) 收边 + 羽化（顺序固定：先腐蚀掉底色描边，再模糊出过渡）
  const erode = clamp(Math.round(Number(options.erode) || 0), 0, 64);
  const feather = clamp(Math.round(Number(options.feather) || 0), 0, 64);
  if (erode > 0) output = erodeMask(output, w, h, erode);
  if (feather > 0) output = blurMask(output, w, h, feather);

  const coverage = countMask(output) / n;
  return { mask: output, width: w, height: h, coverage, backgroundPixels };
}

/**
 * 由 AI 主体 alpha 生成背景去除掩膜。
 *
 * AI 模型给出的是「主体 alpha」（0 = 背景、255 = 主体），与颜色抠图的
 * 「去除掩膜」相反，所以先取反，再沿用与颜色路径一致的选区限制 / 收边 / 羽化，
 * 保证两种抠图方式在工具栏里的行为完全一致。
 *
 * @param {Uint8Array} alpha 主体 alpha，长度 width*height
 * @param {number} width
 * @param {number} height
 * @param {object} [options] 与 {@link buildBackgroundMask} 相同：selection / selectionMode / erode / feather
 * @returns {{mask: Uint8Array, width: number, height: number, coverage: number, backgroundPixels: number}}
 */
export function buildSubjectMask(alpha, width, height, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const n = w * h;
  if (!alpha || alpha.length < n) throw new TypeError('buildSubjectMask: alpha 长度必须 >= width*height');

  let output = new Uint8Array(n);
  let backgroundPixels = 0;
  for (let i = 0; i < n; i += 1) {
    const removal = 255 - alpha[i];
    output[i] = removal;
    if (removal) backgroundPixels += 1;
  }

  // 套索选区限制（仅选区内 / 仅选区外），与颜色路径一致
  if (options.selection && options.selectionMode !== 'all') {
    const inside = options.selectionMode === 'inside';
    const restricted = new Uint8Array(n);
    let hits = 0;
    for (let i = 0; i < n; i += 1) {
      const selected = options.selection[i] > 127;
      if ((inside ? selected : !selected) && output[i]) {
        restricted[i] = output[i];
        hits += 1;
      }
    }
    output = restricted;
    backgroundPixels = hits;
  }

  // 收边 + 羽化（与颜色路径保持同样的顺序）
  const erode = clamp(Math.round(Number(options.erode) || 0), 0, 64);
  const feather = clamp(Math.round(Number(options.feather) || 0), 0, 64);
  if (erode > 0) output = erodeMask(output, w, h, erode);
  if (feather > 0) output = blurMask(output, w, h, feather);

  const coverage = countMask(output) / n;
  return { mask: output, width: w, height: h, coverage, backgroundPixels };
}

/**
 * 把掩膜应用到直通 RGBA，返回新的 `Uint8ClampedArray`（不修改入参）。
 *
 * `decontaminate` 打开时会顺手去掉边缘的底色污染：
 *   F = (C − (1−α)·B) / α
 * 其中 B 是最近的背景色。它只对半透明过渡像素生效，把“白边/绿边”还原成前景色。
 */
export function applyMaskToRgba(rgba, width, height, mask, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const n = w * h;
  if (!rgba || rgba.length < n * 4) throw new TypeError('applyMaskToRgba: rgba 长度必须 >= width*height*4');
  if (!mask || mask.length < n) throw new TypeError('applyMaskToRgba: mask 长度必须 >= width*height');

  const out = new Uint8ClampedArray(rgba.slice(0, n * 4));
  const colors = (options.decontaminate ? options.colors ?? [] : []).map(parseColor).filter(Boolean);
  let removedPixels = 0;

  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    const amount = mask[i] / 255;
    if (amount <= 0) continue;
    const alpha = out[p + 3];
    if (amount >= 1) {
      out[p + 3] = 0;
      removedPixels += 1;
      continue;
    }
    const nextAlpha = Math.round(alpha * (1 - amount));
    if (colors.length && nextAlpha > 0) {
      const opacity = nextAlpha / 255;
      if (opacity > 0.02 && opacity < 0.999) {
        const bg = nearestColor(out[p], out[p + 1], out[p + 2], colors);
        for (let c = 0; c < 3; c += 1) {
          const value = (out[p + c] - (1 - opacity) * bg[c]) / opacity;
          out[p + c] = clamp255(value);
        }
      }
    }
    out[p + 3] = nextAlpha;
    removedPixels += 1;
  }

  return { data: out, width: w, height: h, removedPixels };
}

// ------------------------------------------------------------------ 形态学

/** 腐蚀（3×3 可分离最小值滤波），让掩膜向内容方向收缩，切掉一圈底色描边。 */
export function erodeMask(mask, width, height, radius = 1) {
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (!r) return Uint8Array.from(mask);
  const { width: w, height: h } = normalizeDims(width, height);
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let min = 255;
      for (let dx = -r; dx <= r; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const v = mask[y * w + xx];
        if (v < min) min = v;
      }
      tmp[y * w + x] = min;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let min = 255;
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const v = tmp[yy * w + x];
        if (v < min) min = v;
      }
      out[y * w + x] = min;
    }
  }
  return out;
}

/** 羽化：可分离箱式模糊（一次遍历得到半径 r 的平均值）。 */
export function blurMask(mask, width, height, radius = 1) {
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (!r) return Uint8Array.from(mask);
  const { width: w, height: h } = normalizeDims(width, height);
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const window = r * 2 + 1;

  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += mask[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = Math.round(sum / window);
      const outX = x - r;
      const inX = x + r + 1;
      sum -= mask[row + clamp(outX, 0, w - 1)];
      sum += mask[row + clamp(inX, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = Math.round(sum / window);
      const outY = y - r;
      const inY = y + r + 1;
      sum -= tmp[clamp(outY, 0, h - 1) * w + x];
      sum += tmp[clamp(inY, 0, h - 1) * w + x];
    }
  }
  return out;
}

// ------------------------------------------------------------------ 工具

function nearestColor(r, g, b, colors) {
  let best = colors[0];
  let bestDistance = Infinity;
  for (const c of colors) {
    const d = colorDistance(r, g, b, c);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return [best.r, best.g, best.b];
}

function normalizeDims(width, height) {
  return {
    width: Math.max(1, Math.floor(Number(width) || 1)),
    height: Math.max(1, Math.floor(Number(height) || 1)),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp255(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function countMask(mask) {
  let hits = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 127) hits += 1;
  return hits;
}
