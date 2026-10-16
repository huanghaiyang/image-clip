/**
 * image-clip · AABB (axis-aligned bounding box) detection
 * ------------------------------------------------------
 * Dependency-free and environment-free: the browser feeds it `ImageData.data`
 * and Node feeds it the RAW RGBA buffer produced by sharp. The *same* byte of
 * code runs on both sides, which is what keeps客户端 and 服务端 results identical.
 *
 * Expected input: straight (non-premultiplied) 8-bit RGBA, row-major,
 * `width * height * 4` bytes — exactly what canvas `getImageData()` and
 * `sharp().ensureAlpha().raw()` produce.
 */

/** @typedef {{ x:number, y:number, width:number, height:number }} Rect */

export const ALGORITHM = 'aabb/v1';

export const DEFAULT_OPTIONS = Object.freeze({
  /**
   * 透明阈值 (0-255). 像素 alpha > alphaThreshold 视为“内容”。
   * 0 = 只要有 1/255 的不透明度就算内容（最保守，阴影也会保留）；
   * 调大可以丢弃几乎不可见的边缘噪点/投影。
   */
  alphaThreshold: 1,

  /** 裁剪框四周额外保留的像素 (可负，表示向内收缩)。 */
  padding: 0,

  /**
   * 颜色背景模式：除透明像素外，还把“接近 backgroundColor 的不透明像素”当作背景，
   * 适合白底/纯色底的 JPG、截图等没有 alpha 的素材。
   */
  matchColor: false,
  backgroundColor: '#ffffff',
  /** 颜色容差：RGB 三通道最大差值 (0-255)。 */
  colorTolerance: 12,
});

/** '#rgb' / '#rrggbb' / '#rrggbbaa' → { r, g, b }；非法输入返回 null。 */
export function parseHexColor(hex) {
  if (typeof hex !== 'string') return null;
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6 && s.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 归一化外部传入的选项，越界值会被收敛而不是抛错。 */
export function normalizeOptions(options = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...(options || {}) };
  return {
    alphaThreshold: clampInt(merged.alphaThreshold, 0, 255, DEFAULT_OPTIONS.alphaThreshold),
    padding: clampInt(merged.padding, -100000, 100000, 0),
    matchColor: Boolean(merged.matchColor),
    backgroundColor: parseHexColor(merged.backgroundColor) ? merged.backgroundColor : DEFAULT_OPTIONS.backgroundColor,
    colorTolerance: clampInt(merged.colorTolerance, 0, 255, DEFAULT_OPTIONS.colorTolerance),
  };
}

/**
 * 计算所有“内容像素”的最小外接矩形 (AABB)。
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba 长度 >= width*height*4 的直通 RGBA
 * @param {number} width
 * @param {number} height
 * @param {object} [options] 见 DEFAULT_OPTIONS
 * @returns {{
 *   width:number, height:number,
 *   bounds:Rect, empty:boolean,
 *   contentPixels:number, contentRatio:number,
 *   trimmed:{left:number,top:number,right:number,bottom:number},
 *   options:object
 * }}
 */
export function detectBounds(rgba, width, height, options = {}) {
  const opts = normalizeOptions(options);
  const w = Math.max(0, Math.floor(width) || 0);
  const h = Math.max(0, Math.floor(height) || 0);

  if (!rgba || typeof rgba.length !== 'number' || rgba.length < w * h * 4) {
    throw new TypeError('detectBounds: rgba 必须是长度 >= width*height*4 的 RGBA 缓冲区');
  }
  if (w === 0 || h === 0) return emptyResult(w, h, opts);

  const { alphaThreshold, matchColor, colorTolerance } = opts;
  const bg = matchColor ? parseHexColor(opts.backgroundColor) : null;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let contentPixels = 0;

  const rowBytes = w * 4;

  for (let y = 0; y < h; y += 1) {
    let rowHasContent = false;
    const rowStart = y * rowBytes;

    for (let x = 0; x < w; x += 1) {
      const i = rowStart + x * 4;
      // 透明像素一律算背景；颜色背景模式下，接近 backgroundColor 的像素也算背景。
      let isContent = rgba[i + 3] > alphaThreshold;

      if (isContent && bg) {
        const dr = rgba[i] - bg.r;
        const dg = rgba[i + 1] - bg.g;
        const db = rgba[i + 2] - bg.b;
        if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) <= colorTolerance) isContent = false;
      }

      if (isContent) {
        if (!rowHasContent) {
          rowHasContent = true;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        contentPixels += 1;
      }
    }
  }

  if (maxX < 0) return emptyResult(w, h, opts);

  const bounds = applyPadding({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, opts.padding, w, h);

  return {
    width: w,
    height: h,
    bounds,
    empty: bounds.width === 0 || bounds.height === 0,
    contentPixels,
    contentRatio: w * h ? contentPixels / (w * h) : 0,
    trimmed: {
      left: bounds.x,
      top: bounds.y,
      right: w - (bounds.x + bounds.width),
      bottom: h - (bounds.y + bounds.height),
    },
    options: opts,
  };
}

/** 给矩形加 padding 并夹取到图片范围内。 */
export function applyPadding(rect, padding, width, height) {
  const p = clampInt(padding, -100000, 100000, 0);
  if (!p) return { ...rect };
  const x = Math.max(0, rect.x - p);
  const y = Math.max(0, rect.y - p);
  const right = Math.min(width, rect.x + rect.width + p);
  const bottom = Math.min(height, rect.y + rect.height + p);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function emptyResult(width, height, options) {
  return {
    width,
    height,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    empty: true,
    contentPixels: 0,
    contentRatio: 0,
    trimmed: { left: 0, top: 0, right: 0, bottom: 0 },
    options,
  };
}

/** 把检测结果格式化成一行人类可读的摘要（CLI / 日志 / UI 提示共用）。 */
export function describeResult(result, originalBytes) {
  if (result.empty) return '整张图片都是透明区域，没有可裁剪的内容';
  const { bounds, trimmed, width, height } = result;
  const areaRatio = (bounds.width * bounds.height) / Math.max(1, width * height);
  const size = originalBytes ? ` · ${formatBytes(originalBytes)}` : '';
  return [
    `${width}×${height}${size}`,
    `→ ${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})`,
    `去除 左${trimmed.left} 上${trimmed.top} 右${trimmed.right} 下${trimmed.bottom}`,
    `面积 ${(areaRatio * 100).toFixed(1)}%`,
  ].join(' · ');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
