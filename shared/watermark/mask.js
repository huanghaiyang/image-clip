/**
 * 水印掩膜工具（纯 JS，浏览器与 Node 通用）
 * ---------------------------------------
 * 约定：掩膜是 `Uint8Array(width * height)` 的单通道灰度图，
 * **255 = 需要去除的像素，0 = 保留**。所有函数都不修改入参，返回新数组。
 *
 * 这里不依赖 OpenCV，因为掩膜编辑（画笔、橡皮、膨胀、羽化、预览叠加）
 * 需要在浏览器里即时响应；OpenCV 只用在检测与修补这类重活上。
 */

/** @typedef {{ width:number, height:number, data:Uint8Array }} Mask */

export function createMask(width, height, fill = 0) {
  const data = new Uint8Array(Math.max(0, width * height));
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function cloneMask(mask) {
  return { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) };
}

export function countMask(mask) {
  let n = 0;
  const { data } = mask;
  for (let i = 0; i < data.length; i += 1) if (data[i] > 127) n += 1;
  return n;
}

export function coverage(mask) {
  const total = mask.width * mask.height;
  return total ? countMask(mask) / total : 0;
}

export function isEmpty(mask) {
  return countMask(mask) === 0;
}

/** 掩膜内容的包围盒（空掩膜返回 empty:true）。 */
export function maskBounds(mask) {
  const { width: w, height: h, data } = mask;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[row + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0, empty: true };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false };
}

function clampRadius(radius) {
  const r = Math.round(Number(radius) || 0);
  return Math.min(256, Math.max(0, r));
}

/**
 * 膨胀。`shape` 决定结构元：
 *  - 'square'（默认）：r×r 方块，各方向生长均匀，适合覆盖抗锯齿边缘；
 *  - 'cross'：只沿上下左右生长，适合需要保持细结构连通性的清理。
 * 复杂度 O(w*h*r)，r 通常 ≤ 32，实测 1MP 图 r=8 约 40ms。
 */
export function dilate(mask, radius, shape = 'square') {
  const r = clampRadius(radius);
  if (!r) return cloneMask(mask);
  return separableRank(mask, r, true, shape);
}

export function erode(mask, radius, shape = 'square') {
  const r = clampRadius(radius);
  if (!r) return cloneMask(mask);
  return separableRank(mask, r, false, shape);
}

/** 开运算：先腐蚀后膨胀（去孤立噪点）。 */
export function open(mask, radius, shape = 'square') {
  return dilate(erode(mask, radius, shape), radius, shape);
}

/** 闭运算：先膨胀后腐蚀（补内部小洞）。 */
export function close(mask, radius, shape = 'square') {
  return erode(dilate(mask, radius, shape), radius, shape);
}

function separableRank(mask, r, isMax, shape = 'square') {
  const { width: w, height: h } = mask;
  const src = mask.data;

  const horizontal = window(src, w, h, r, isMax, 'row');
  const vertical = window(src, w, h, r, isMax, 'col');

  if (shape === 'cross') {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = isMax ? Math.max(horizontal[i], vertical[i]) : Math.min(horizontal[i], vertical[i]);
    }
    return { width: w, height: h, data: out };
  }

  // square：横向结果再做一次纵向窗口 = r×r 方块
  return { width: w, height: h, data: window(horizontal, w, h, r, isMax, 'col') };
}

/** 一维窗口的 max/min（按行走或按列走）。 */
function window(src, w, h, r, isMax, axis) {
  const out = new Uint8Array(w * h);
  const initial = isMax ? 0 : 255;
  if (axis === 'row') {
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const from = Math.max(0, x - r);
        const to = Math.min(w - 1, x + r);
        let acc = initial;
        for (let i = from; i <= to; i += 1) {
          const v = src[row + i];
          if (isMax ? v > acc : v < acc) acc = v;
        }
        out[row + x] = acc;
      }
    }
    return out;
  }
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      const from = Math.max(0, y - r);
      const to = Math.min(h - 1, y + r);
      let acc = initial;
      for (let i = from; i <= to; i += 1) {
        const v = src[i * w + x];
        if (isMax ? v > acc : v < acc) acc = v;
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * 羽化：对掩膜做两次盒式模糊（近似高斯），得到 0..255 的软边 alpha。
 * 修补后按这个 alpha 与原图混合，可以消掉接缝。
 */
export function feather(mask, radius) {
  const r = clampRadius(radius);
  if (!r) return cloneMask(mask);
  const once = boxBlur(mask, r);
  return boxBlur(once, r);
}

/** 分离式盒式模糊（滑窗求和，O(w*h)）。 */
export function boxBlur(mask, radius) {
  const r = clampRadius(radius);
  const { width: w, height: h } = mask;
  if (!r) return cloneMask(mask);
  const src = mask.data;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = r * 2 + 1;

  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = Math.round(sum / win);
      const add = row + Math.min(w - 1, x + r + 1);
      const sub = row + Math.max(0, x - r);
      sum += src[add] - src[sub];
    }
  }

  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = Math.round(sum / win);
      const add = Math.min(h - 1, y + r + 1) * w + x;
      const sub = Math.max(0, y - r) * w + x;
      sum += tmp[add] - tmp[sub];
    }
  }
  return { width: w, height: h, data: out };
}

/** 布尔/加权合并工具。 */
export function union(...masks) {
  const usable = masks.filter(Boolean);
  if (usable.length === 0) throw new Error('union 至少需要一个掩膜');
  const { width, height } = usable[0];
  assertSameSize(usable, width, height);
  const out = new Uint8Array(width * height);
  for (const m of usable) {
    const d = m.data;
    for (let i = 0; i < out.length; i += 1) if (d[i] > out[i]) out[i] = d[i];
  }
  return { width, height, data: out };
}

export function intersect(a, b) {
  assertSameSize([a, b], a.width, a.height);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.min(a.data[i], b.data[i]);
  return { width: a.width, height: a.height, data: out };
}

export function subtract(a, b) {
  assertSameSize([a, b], a.width, a.height);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(0, a.data[i] - b.data[i]);
  return { width: a.width, height: a.height, data: out };
}

/** 用画笔在掩膜上画圆（mode: 'paint' 加掩膜 / 'erase' 减掩膜）。 */
export function paintCircle(mask, cx, cy, radius, mode = 'paint', softness = 0.35) {
  const r = Math.max(1, Math.round(radius));
  const inner = r * (1 - Math.min(0.9, Math.max(0, softness)));
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const t = d <= inner ? 1 : 1 - (d - inner) / Math.max(1, r - inner);
      const i = y * mask.width + x;
      if (mode === 'erase') {
        mask.data[i] = Math.max(0, mask.data[i] - Math.round(255 * t));
      } else {
        mask.data[i] = Math.max(mask.data[i], Math.round(255 * t));
      }
    }
  }
  return mask;
}

/** 画笔沿两点之间连线涂抹（避免快速拖动出现断点）。 */
export function paintStroke(mask, from, to, radius, mode = 'paint', softness = 0.35) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius * 0.5)));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    paintCircle(mask, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, mode, softness);
  }
  return mask;
}

/** 统一接受「RGBA 数组」或「{width,height,data} 图像对象」。 */
function rgbaData(input) {
  return input?.data ?? input;
}

/**
 * 从 RGBA 的 alpha 通道生成掩膜（用于「水印图自带透明通道」的场景）。
 */
export function fromAlpha(rgba, width, height, threshold = 8) {
  const src = rgbaData(rgba);
  const w = width ?? rgba?.width;
  const h = height ?? rgba?.height;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < out.length; i += 1, p += 4) out[i] = src[p] > threshold ? 255 : 0;
  return { width: w, height: h, data: out };
}

/** 掩膜 → 可直接渲染/导出的 RGBA（白色 + 掩膜作为 alpha）。 */
export function maskToRgba(mask, color = [255, 255, 255]) {
  const { width: w, height: h, data } = mask;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    out[p] = color[0];
    out[p + 1] = color[1];
    out[p + 2] = color[2];
    out[p + 3] = data[i];
  }
  return { width: w, height: h, data: out };
}

/** 在 RGBA 图上叠加半透明掩膜色块（画布预览用，返回新图，不修改入参）。 */
export function overlayRgba(rgba, mask, color = [13, 153, 255], alpha = 0.45) {
  const src = rgbaData(rgba);
  const out = new Uint8ClampedArray(src);
  const { data } = mask;
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    if (data[i] <= 0) continue;
    const a = (data[i] / 255) * alpha;
    out[p] = out[p] * (1 - a) + color[0] * a;
    out[p + 1] = out[p + 1] * (1 - a) + color[1] * a;
    out[p + 2] = out[p + 2] * (1 - a) + color[2] * a;
    out[p + 3] = Math.max(out[p + 3], Math.round(255 * a));
  }
  return { width: mask.width, height: mask.height, data: out };
}

/**
 * 掩膜连通域标记（两遍扫描 + union-find，8 邻接），返回按面积排序的区域。
 * 用于过滤噪点、统计候选水印区域。
 */
export function connectedComponents(mask, { minArea = 1, maxArea = Infinity } = {}) {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const parent = [0];

  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  let next = 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (data[i] <= 127) continue;
      const neighbors = [];
      if (x > 0 && labels[i - 1]) neighbors.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) neighbors.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) neighbors.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) neighbors.push(labels[i - w + 1]);
      }
      if (neighbors.length === 0) {
        labels[i] = next;
        parent[next] = next;
        next += 1;
      } else {
        const min = Math.min(...neighbors);
        labels[i] = min;
        for (const n of neighbors) union(min, n);
      }
    }
  }

  const stats = new Map();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const root = find(labels[i]);
      labels[i] = root;
      let s = stats.get(root);
      if (!s) {
        s = { label: root, area: 0, minX: x, minY: y, maxX: x, maxY: y };
        stats.set(root, s);
      }
      s.area += 1;
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
    }
  }

  return [...stats.values()]
    .filter((s) => s.area >= minArea && s.area <= maxArea)
    .map((s) => ({
      ...s,
      x: s.minX,
      y: s.minY,
      width: s.maxX - s.minX + 1,
      height: s.maxY - s.minY + 1,
      fillRatio: s.area / ((s.maxX - s.minX + 1) * (s.maxY - s.minY + 1)),
    }))
    .sort((a, b) => b.area - a.area);
}

/** 只保留指定 label 集合的像素（配合 connectedComponents 使用）。 */
export function keepLabels(mask, labels, keep) {
  const keepSet = keep instanceof Set ? keep : new Set(keep);
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i += 1) {
    if (labels[i] && keepSet.has(labels[i])) out[i] = mask.data[i];
  }
  return { width: mask.width, height: mask.height, data: out };
}

/** 掩膜 → 紧凑 RLE（`[value, runLength, value, runLength, ...]`），用于接口传输。 */
export function encodeRle(mask) {
  const runs = [];
  let prev = mask.data[0] ?? 0;
  let count = 0;
  for (const v of mask.data) {
    const b = v > 127 ? 255 : 0;
    if (b === prev) {
      count += 1;
    } else {
      runs.push(prev === 255 ? 1 : 0, count);
      prev = b;
      count = 1;
    }
  }
  runs.push(prev === 255 ? 1 : 0, count);
  return { width: mask.width, height: mask.height, runs };
}

export function decodeRle(rle, width = rle.width, height = rle.height) {
  const data = new Uint8Array(width * height);
  let i = 0;
  for (let r = 0; r < rle.runs.length; r += 2) {
    const on = rle.runs[r];
    const len = rle.runs[r + 1];
    if (on) data.fill(255, i, Math.min(data.length, i + len));
    i += len;
  }
  return { width, height, data };
}

/** 掩膜与真值的重合度指标（用于验证检测效果）。 */
export function compareMasks(predicted, truth) {
  assertSameSize([predicted, truth], predicted.width, predicted.height);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < predicted.data.length; i += 1) {
    const p = predicted.data[i] > 127;
    const t = truth.data[i] > 127;
    if (p && t) tp += 1;
    else if (p) fp += 1;
    else if (t) fn += 1;
  }
  const union = tp + fp + fn;
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : 0,
    recall: tp + fn ? tp / (tp + fn) : 0,
    iou: union ? tp / union : 1,
    f1: tp ? (2 * tp) / (2 * tp + fp + fn) : 0,
  };
}

function assertSameSize(masks, width, height) {
  for (const m of masks) {
    if (!m || m.width !== width || m.height !== height) {
      throw new Error(`掩膜尺寸不一致：期望 ${width}×${height}`);
    }
  }
}
