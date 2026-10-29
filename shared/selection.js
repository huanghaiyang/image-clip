/**
 * 选区与裁剪的纯数学工具（浏览器 / Node 共用，零依赖）。
 *
 * 为什么单独成文件：
 *  - 图片裁剪界面、批量裁剪、套索选区、背景去除的“仅选区内处理”都用同一套坐标换算，
 *    如果各写一份，很容易出现「预览和导出差 1 像素」「批量裁剪和单张裁剪不一致」；
 *  - 这里的函数全部只做数值运算（不碰 canvas / ImageData），因此可以在 Node 里单测，
 *    也可以被将来的服务端批处理直接复用。
 *
 * 约定：
 *  - 矩形统一写成 `{ x, y, width, height }`，单位是**图像像素**，左上角为原点；
 *  - 归一化矩形写成 `{ x, y, width, height }`，单位是**比例 0~1**（例如 0.5 表示图宽的一半）；
 *  - 所有函数都不修改入参，返回新对象/新数组。
 */

/** @typedef {{ x:number, y:number, width:number, height:number }} Rect */
/** @typedef {{ x:number, y:number }} Point */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 把矩形夹取到 [0,width]×[0,height] 内，并保证宽高非负。 */
export function clampRect(rect, width, height) {
  const w = Math.max(0, Math.floor(num(width)));
  const h = Math.max(0, Math.floor(num(height)));
  let x = num(rect?.x);
  let y = num(rect?.y);
  let rw = Math.max(0, num(rect?.width));
  let rh = Math.max(0, num(rect?.height));

  if (x < 0) {
    rw += x;
    x = 0;
  }
  if (y < 0) {
    rh += y;
    y = 0;
  }
  if (x + rw > w) rw = w - x;
  if (y + rh > h) rh = h - y;

  return {
    x: Math.round(clamp(x, 0, w)),
    y: Math.round(clamp(y, 0, h)),
    width: Math.max(0, Math.round(rw)),
    height: Math.max(0, Math.round(rh)),
  };
}

/** 像素矩形 → 归一化矩形（除以图片尺寸）。 */
export function normalizeRect(rect, width, height) {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  const r = clampRect(rect, w, h);
  return {
    x: r.x / w,
    y: r.y / h,
    width: r.width / w,
    height: r.height / h,
  };
}

/** 归一化矩形 → 指定图片尺寸下的像素矩形。 */
export function rectFromNormalized(norm, width, height) {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  return clampRect(
    {
      x: num(norm?.x) * w,
      y: num(norm?.y) * h,
      width: num(norm?.width) * w,
      height: num(norm?.height) * h,
    },
    w,
    h,
  );
}

/**
 * 在图片内取一个居中的最大矩形，满足宽高比 aspect（宽/高）。
 * aspect 为 0/NaN 时返回整图。
 */
export function fitAspectRect(width, height, aspect) {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  const ratio = num(aspect);
  if (!(ratio > 0)) return { x: 0, y: 0, width: w, height: h };

  let rw = w;
  let rh = Math.round(w / ratio);
  if (rh > h) {
    rh = h;
    rw = Math.round(h * ratio);
  }
  rw = Math.max(1, Math.min(w, rw));
  rh = Math.max(1, Math.min(h, rh));
  return {
    x: Math.round((w - rw) / 2),
    y: Math.round((h - rh) / 2),
    width: rw,
    height: rh,
  };
}

/**
 * 把任意矩形调整成目标宽高比，并保持中心不变、夹取在图内。
 * 用于用户切换「1:1 / 16:9 …」预设时的即时重排。
 */
export function rectToAspect(rect, aspect, width, height) {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  const ratio = num(aspect);
  const source = clampRect(rect, w, h);
  if (!(ratio > 0)) return source;

  const cx = source.x + source.width / 2;
  const cy = source.y + source.height / 2;
  let rw = Math.max(source.width, 1);
  let rh = Math.max(Math.round(rw / ratio), 1);
  if (rh > h) {
    rh = h;
    rw = Math.max(Math.round(rh * ratio), 1);
  }
  if (rw > w) {
    rw = w;
    rh = Math.max(Math.round(rw / ratio), 1);
  }
  rw = Math.min(rw, w);
  rh = Math.min(rh, h);

  let x = Math.round(cx - rw / 2);
  let y = Math.round(cy - rh / 2);
  x = Math.round(clamp(x, 0, w - rw));
  y = Math.round(clamp(y, 0, h - rh));
  return { x, y, width: rw, height: rh };
}

/**
 * 解析裁剪输出尺寸。
 *
 * output 约定：
 *   - `{ mode:'natural' }` 或空 → 用裁剪框本身尺寸；
 *   - `{ mode:'resize', width, height }` → 指定宽高；只给一边时按裁剪框比例补另一边；
 *   - 数值都会被收敛到 [1, 20000]，避免 canvas 尺寸非法。
 */
export function resolveOutputSize(cropRect, output = {}) {
  const cw = Math.max(1, Math.round(num(cropRect?.width, 1)));
  const ch = Math.max(1, Math.round(num(cropRect?.height, 1)));
  if (!output || output.mode !== 'resize') return { width: cw, height: ch };

  let ow = Math.round(num(output.width));
  let oh = Math.round(num(output.height));
  const hasW = Number.isFinite(ow) && ow > 0;
  const hasH = Number.isFinite(oh) && oh > 0;

  if (hasW && !hasH) oh = Math.round((ow * ch) / cw);
  if (!hasW && hasH) ow = Math.round((oh * cw) / ch);
  if (!hasW && !hasH) return { width: cw, height: ch };

  return {
    width: clamp(ow, 1, 20000),
    height: clamp(oh, 1, 20000),
  };
}

/** 多边形面积（绝对值，像素²）。用于过滤“误点两下”的无效套索。 */
export function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += num(a.x) * num(b.y) - num(b.x) * num(a.y);
  }
  return Math.abs(sum) / 2;
}

/** 按比例缩放多边形点（用于预览分辨率与全分辨率之间换算）。 */
export function scalePolygon(points, scaleX, scaleY = scaleX) {
  return (points ?? []).map((p) => ({ x: num(p.x) * scaleX, y: num(p.y) * scaleY }));
}

/**
 * 多边形栅格化成 0/255 掩膜（扫描线 + 奇偶填充）。
 *
 * 算法：对每一行取像素中心 y+0.5，求所有边与该水平线的交点，
 * 排序后成对填充。像素中心落在 [x0, x1) 内即被填上。
 * 这样不会出现「边线抖动导致整行漏填」的经典问题，且复杂度是 O(h * edges)。
 *
 * @param {Point[]} points 图像像素坐标
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} 长度 width*height，0 或 255
 */
export function rasterizePolygon(points, width, height) {
  const w = Math.max(1, Math.floor(num(width, 1)));
  const h = Math.max(1, Math.floor(num(height, 1)));
  const mask = new Uint8Array(w * h);
  const pts = (points ?? []).filter((p) => Number.isFinite(num(p?.x)) && Number.isFinite(num(p?.y)));
  if (pts.length < 3 || polygonArea(pts) < 1) return mask;

  const xs = [];
  for (let y = 0; y < h; y += 1) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ay = a.y;
      const by = b.y;
      // 水平边不参与求交；半开区间 [minY, maxY) 保证顶点只算一次
      if (ay === by) continue;
      if (cy < Math.min(ay, by) || cy >= Math.max(ay, by)) continue;
      const t = (cy - ay) / (by - ay);
      xs.push(a.x + t * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      if (!(x1 > x0)) continue;
      const start = Math.max(0, Math.ceil(x0 - 0.5));
      const end = Math.min(w - 1, Math.floor(x1 - 0.5));
      const row = y * w;
      for (let x = start; x <= end; x += 1) mask[row + x] = 255;
    }
  }
  return mask;
}

/**
 * 把两张等尺寸掩膜按模式合成。
 *
 * @param {Uint8Array} mask 处理掩膜（255=要去除）
 * @param {Uint8Array} selection 选区掩膜（255=选区内）
 * @param {'all'|'inside'|'outside'} mode
 *   - all：忽略选区
 *   - inside：只保留选区内的处理像素
 *   - outside：只保留选区外的处理像素
 * @returns {Uint8Array} 新掩膜
 */
export function applySelection(mask, selection, mode = 'all') {
  const out = Uint8Array.from(mask ?? []);
  if (!selection || mode === 'all') return out;
  for (let i = 0; i < out.length; i += 1) {
    const inSelection = selection[i] > 127;
    if (mode === 'inside' && !inSelection) out[i] = 0;
    if (mode === 'outside' && inSelection) out[i] = 0;
  }
  return out;
}

/** 统计掩膜中 >127 的像素数。 */
export function countMask(mask) {
  let hits = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 127) hits += 1;
  return hits;
}
