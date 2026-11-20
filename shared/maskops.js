/**
 * 掩膜（选区）运算 —— 纯算法，浏览器与 Node 共用
 * ------------------------------------------------
 * 掩膜就是一张 width×height 的 Uint8 灰度图（0 = 未选，255 = 全选）。
 * 之所以不用「多边形点集」，是因为魔棒、羽化、扩展都是像素级操作，
 * 统一成灰度图之后所有工具（蒙版、导出、批量）都只需要一种数据。
 *
 * 提供：
 *  - 魔棒（容差 + 连通性），算法与 shared/bgremove.js 的漫水保持一致；
 *  - 选区布尔运算（并 / 减 / 交 / 替换）；
 *  - 羽化（三次盒式模糊近似高斯）、扩展 / 收缩（可分离最大值 / 最小值滤波）；
 *  - 掩膜包围盒、反相、写入 alpha。
 */

export function createMask(width, height, fill = 0) {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  return { width: w, height: h, data: new Uint8Array(w * h).fill(fill ? 255 : 0) };
}

export function cloneMask(mask) {
  return { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) };
}

/** 加权 RGB 距离：人眼对绿最敏感、对蓝最不敏感（与 bgremove 同一套权重）。 */
function colorDistance(data, i, r, g, b) {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
}

/**
 * 魔棒：从 (x,y) 取种子色，把所有「颜色足够接近」的像素选中。
 * @param {Uint8ClampedArray|Uint8Array} rgba 原图 RGBA
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,tolerance?:number,contiguous?:boolean,alphaTolerance?:number}} options
 *   tolerance 为 0~255 的加权距离阈值；contiguous=false 时做全图同色选择。
 * @returns {{width:number,height:number,data:Uint8Array,seed:number[]}}
 */
export function magicWand(rgba, width, height, { x, y, tolerance = 32, contiguous = true, alphaTolerance = 0 } = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const mask = createMask(w, h, 0);
  const sx = Math.max(0, Math.min(w - 1, Math.round(Number(x) || 0)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(Number(y) || 0)));
  const seed = sy * w + sx;
  const sr = rgba[seed * 4];
  const sg = rgba[seed * 4 + 1];
  const sb = rgba[seed * 4 + 2];
  const sa = rgba[seed * 4 + 3];
  const tol = Math.max(0, Math.min(255, Number(tolerance) || 0));
  const atol = Math.max(0, Math.min(255, Number(alphaTolerance) || 0));

  const matches = (index) => {
    const i = index * 4;
    if (Math.abs(rgba[i + 3] - sa) > atol) return false;
    return colorDistance(rgba, i, sr, sg, sb) <= tol;
  };

  if (!contiguous) {
    for (let index = 0; index < w * h; index += 1) {
      if (matches(index)) mask.data[index] = 255;
    }
    return { ...mask, seed: [sx, sy] };
  }

  // 四邻域漫水：用显式栈而不是递归，4K 图递归会爆栈
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = seed;
  visited[seed] = 1;
  while (top > 0) {
    const index = stack[top - 1];
    top -= 1;
    if (!matches(index)) continue;
    mask.data[index] = 255;
    const cx = index % w;
    const cy = (index - cx) / w;
    if (cx > 0 && !visited[index - 1]) {
      visited[index - 1] = 1;
      stack[top++] = index - 1;
    }
    if (cx < w - 1 && !visited[index + 1]) {
      visited[index + 1] = 1;
      stack[top++] = index + 1;
    }
    if (cy > 0 && !visited[index - w]) {
      visited[index - w] = 1;
      stack[top++] = index - w;
    }
    if (cy < h - 1 && !visited[index + w]) {
      visited[index + w] = 1;
      stack[top++] = index + w;
    }
  }
  return { ...mask, seed: [sx, sy] };
}

export const MASK_OPS = ['replace', 'union', 'subtract', 'intersect'];

/**
 * 选区布尔运算。尺寸不一致时按「左上角对齐 + 目标尺寸裁剪」处理，
 * 不做缩放 —— 选区和图片必须严格同一坐标系，缩放会丢精度。
 */
export function combineMask(base, next, op = 'replace') {
  if (!next) return cloneMask(base);
  if (op === 'replace' || !base) return cloneMask(next);

  const width = base.width;
  const height = base.height;
  const out = { width, height, data: new Uint8Array(width * height) };
  const copyW = Math.min(width, next.width);
  const copyH = Math.min(height, next.height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const other = y < copyH && x < copyW ? next.data[y * next.width + x] : 0;
      const value = base.data[index];
      if (op === 'union') out.data[index] = Math.max(value, other);
      else if (op === 'subtract') out.data[index] = Math.max(0, value - other);
      else out.data[index] = Math.min(value, other);
    }
  }
  return out;
}

export function invertMask(mask) {
  const out = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.length) };
  for (let i = 0; i < mask.data.length; i += 1) out.data[i] = 255 - mask.data[i];
  return out;
}

/** 水平方向的一维盒式模糊（滑动窗口，O(n)）。 */
function boxBlurH(src, dst, w, h, radius) {
  const window = radius * 2 + 1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x += 1) {
      dst[row + x] = Math.round(sum / window);
      sum -= src[row + Math.min(w - 1, Math.max(0, x - radius))];
      sum += src[row + Math.min(w - 1, Math.max(0, x + radius + 1))];
    }
  }
}

function boxBlurV(src, dst, w, h, radius) {
  const window = radius * 2 + 1;
  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = Math.round(sum / window);
      sum -= src[Math.min(h - 1, Math.max(0, y - radius)) * w + x];
      sum += src[Math.min(h - 1, Math.max(0, y + radius + 1)) * w + x];
    }
  }
}

/**
 * 羽化：三次盒式模糊 ≈ 高斯（误差 < 3%，和 PS 的「羽化」观感一致）。
 * radius 单位是像素，0 直接返回副本。
 */
export function featherMask(mask, radius = 0) {
  const r = Math.round(Number(radius) || 0);
  if (r <= 0) return cloneMask(mask);
  const { width: w, height: h } = mask;
  let a = new Uint8Array(mask.data);
  let b = new Uint8Array(w * h);
  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return { width: w, height: h, data: a };
}

/** 可分离最大值滤波（横向 + 纵向），用于膨胀。 */
function maxFilter(src, w, h, radius) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const nx = x + k;
        if (nx < 0 || nx >= w) continue;
        if (src[row + nx] > value) value = src[row + nx];
      }
      tmp[row + x] = value;
    }
  }
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let value = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const ny = y + k;
        if (ny < 0 || ny >= h) continue;
        if (tmp[ny * w + x] > value) value = tmp[ny * w + x];
      }
      out[y * w + x] = value;
    }
  }
  return out;
}

/** 可分离最小值滤波，用于收缩。 */
function minFilter(src, w, h, radius) {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) inv[i] = 255 - src[i];
  const dilated = maxFilter(inv, w, h, radius);
  for (let i = 0; i < dilated.length; i += 1) dilated[i] = 255 - dilated[i];
  return dilated;
}

/**
 * 扩展 / 收缩，单位像素。正数向外扩，负数向内收。
 * 用的是方形结构元：比圆形快，且和 PS 的观感足够接近。
 */
export function expandMask(mask, pixels = 0) {
  const p = Math.round(Number(pixels) || 0);
  if (p === 0) return cloneMask(mask);
  const { width: w, height: h } = mask;
  const data = p > 0 ? maxFilter(mask.data, w, h, p) : minFilter(mask.data, w, h, -p);
  return { width: w, height: h, data };
}

/**
 * 选区包围盒（默认阈值 8，避免羽化尾巴把框撑到整张图）。
 * 全空返回 null。
 */
export function maskBounds(mask, threshold = 8) {
  const { width: w, height: h, data } = mask;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[row + x] < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 掩膜覆盖率（0~1），面板里显示「选中 xx%」用。 */
export function maskCoverage(mask) {
  if (!mask?.data?.length) return 0;
  let sum = 0;
  for (let i = 0; i < mask.data.length; i += 1) sum += mask.data[i];
  return sum / (mask.data.length * 255);
}

/** 把掩膜乘进 RGBA 的 alpha 通道（原地修改并返回同一个 ImageData）。 */
export function applyMaskToAlpha(imageData, mask) {
  if (!imageData || !mask) return imageData;
  const data = imageData.data;
  const w = Math.min(mask.width, imageData.width);
  const h = Math.min(mask.height, imageData.height);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * imageData.width + x) * 4 + 3;
      data[i] = Math.round((data[i] * mask.data[y * mask.width + x]) / 255);
    }
  }
  return imageData;
}
