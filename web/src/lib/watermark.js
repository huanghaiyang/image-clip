/**
 * 水印识别与去除的浏览器端客户端 + 掩膜本地编辑工具。
 *
 * 分工（与后端契约一致）：
 *   - 服务端只负责“识别”和“去除”两个重活（POST /api/watermark/detect、/remove）；
 *   - 掩膜在本模块用 canvas 编解码，画笔/橡皮/羽化全在本地完成，
 *     因此涂抹过程中不需要任何网络往返，也不影响后端实现。
 *
 * 掩膜的内存表示统一为 Uint8Array(width*height)，取值 0..255：
 * 0 = 保留，255 = 去除；中间值是本地羽化产生的软边（编码成灰度 PNG 交给服务端）。
 */

export class WatermarkApiError extends Error {
  constructor(message, { status = 0, endpoint = '' } = {}) {
    super(message);
    this.name = 'WatermarkApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** 后端不可用时的统一提示（界面各处直接复用，避免文案漂移）。 */
export const SERVER_HINT = '水印功能需要 Node 服务端（npm run dev:server）';

export const WATERMARK_ENDPOINTS = {
  health: '/api/watermark/health',
  detect: '/api/watermark/detect',
  remove: '/api/watermark/remove',
};

/** 契约里固定的枚举值，集中一处便于与后端对照。 */
export const DETECT_METHODS = ['auto', 'overlay', 'periodic', 'template'];
export const REMOVE_ENGINES = ['auto', 'unblend', 'opencv', 'lama'];

// ------------------------------------------------------------- 服务端调用

async function readError(res, endpoint) {
  try {
    const body = await res.json();
    const message = body?.error?.message ?? body?.message;
    if (message) return new WatermarkApiError(message, { status: res.status, endpoint });
  } catch {
    // 非 JSON 响应（例如服务端返回 HTML 错误页）走下面的通用文案
  }
  return new WatermarkApiError(`HTTP ${res.status}`, { status: res.status, endpoint });
}

function toQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  return query;
}

export async function fetchHealth({ timeoutMs = 8000 } = {}) {
  // health 是模式切换时的即时探针：超时必须自己兜住，否则后端没起时界面会一直转圈
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(WATERMARK_ENDPOINTS.health, { signal: controller.signal });
    if (!res.ok) throw await readError(res, WATERMARK_ENDPOINTS.health);
    const body = await res.json();
    return {
      ok: Boolean(body.ok),
      opencv: { available: Boolean(body.opencv?.available) },
      lama: { available: Boolean(body.lama?.available), bytes: body.lama?.bytes ?? null },
      engines: Array.isArray(body.engines) && body.engines.length ? body.engines : REMOVE_ENGINES,
      detectMethods:
        Array.isArray(body.detectMethods) && body.detectMethods.length ? body.detectMethods : DETECT_METHODS,
    };
  } catch (err) {
    if (err instanceof WatermarkApiError) throw err;
    const reason = err?.name === 'AbortError' ? '请求超时' : err?.message || '无法连接';
    throw new WatermarkApiError(`${SERVER_HINT}（${reason}）`, { endpoint: WATERMARK_ENDPOINTS.health });
  } finally {
    clearTimeout(timer);
  }
}

/** 图片要么是 { blob }（用二进制最省流量），要么是 { dataUrl }（JSON 体，便于带模板图）。 */
function imagePayload(image) {
  if (!image?.blob && !image?.dataUrl) throw new WatermarkApiError('素材缺少可上传的图片数据');
  return image;
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

export async function detectWatermark(image, options = {}) {
  const source = imagePayload(image);
  const base = {
    method: options.method ?? 'auto',
    sensitivity: options.sensitivity,
    dilate: options.dilate,
    minArea: options.minArea,
    maxCoverage: options.maxCoverage,
  };

  let res;
  if (options.template) {
    // 模板也是 dataURL，二进制体塞不下第二个图，只能走 JSON 体
    res = await fetch(`${WATERMARK_ENDPOINTS.detect}?${toQuery(base)}`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ image: source.dataUrl, template: options.template }),
    });
  } else {
    res = await fetch(`${WATERMARK_ENDPOINTS.detect}?${toQuery(base)}`, {
      method: 'POST',
      headers: { 'Content-Type': source.blob?.type || 'application/octet-stream' },
      body: source.blob,
    });
  }
  if (!res.ok) throw await readError(res, WATERMARK_ENDPOINTS.detect);
  return res.json();
}

/**
 * 执行去除。
 * 返回 { blob, mime, engine, elapsedMs, alpha, coverage }：默认要二进制（二进制可直接预览、下载、打包），
 * 同时请求 response=json 拿到引擎与耗时等元信息——两者二选一时会丢信息，后端支持则都拿。
 */
export async function removeWatermark(image, options = {}, maskDataUrl = '') {
  const source = imagePayload(image);
  const query = toQuery({
    engine: options.engine,
    method: options.method,
    sensitivity: options.sensitivity,
    dilate: options.dilate,
    minArea: options.minArea,
    maxCoverage: options.maxCoverage,
    watermarkColor: options.watermarkColor,
    inpaintRadius: options.inpaintRadius,
    feather: options.feather,
    format: options.format,
    quality: options.format === 'png' ? undefined : options.quality,
    // 检测阶段的先验：让服务端能正确选择"反混合"而不是退化成昂贵的修补
    alphaHint: options.alphaHint,
    polarity: options.polarity,
  });

  // 带掩膜时必须走 JSON 体：掩膜与图片是两个独立资源，二进制体只能承载其中一个
  const useJson = Boolean(maskDataUrl);
  const url = `${WATERMARK_ENDPOINTS.remove}?${query}`;
  const res = useJson
    ? await fetch(url, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ image: source.dataUrl, mask: maskDataUrl }),
      })
    : await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': source.blob?.type || 'application/octet-stream' },
        body: source.blob,
      });
  if (!res.ok) throw await readError(res, WATERMARK_ENDPOINTS.remove);

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    // 服务端选了 JSON（?response=json 或即便没指定也返回 JSON）——统一收敛成 blob 方便预览与打包
    const body = await res.json();
    const blob = body.dataUrl ? await fetch(body.dataUrl).then((r) => r.blob()) : null;
    return {
      blob,
      mime: blob?.type || contentType,
      engine: body.engine ?? null,
      elapsedMs: body.elapsedMs ?? 0,
      alpha: body.alpha ?? null,
      watermarkColor: body.watermarkColor ?? null,
      coverage: body.coverage ?? null,
      patches: body.patches ?? null,
    };
  }

  return {
    blob: await res.blob(),
    mime: contentType || 'image/png',
    engine: res.headers.get('x-watermark-engine') || res.headers.get('x-image-clip-engine') || null,
    elapsedMs:
      Number(res.headers.get('x-watermark-elapsed-ms') || res.headers.get('x-image-clip-elapsed-ms')) || 0,
    alpha: null,
    watermarkColor: null,
    coverage: null,
    patches: null,
  };
}

// ------------------------------------------------------------- 掩膜编解码

/** 新建全 0 掩膜（尺寸取自素材天然像素）。 */
export function createMask(width, height, fill = 0) {
  const mask = new Uint8Array(Math.max(0, width * height));
  if (fill) mask.fill(fill);
  return mask;
}

function make2d(width, height, readFrequently = false) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return { canvas, ctx: canvas.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined) };
}

/** 灰度 PNG dataURL → Uint8Array(0..255)。掩膜是单通道图，取任一通道即可。 */
export async function decodeMaskFromDataUrl(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const { ctx } = make2d(bitmap.width, bitmap.height, true);
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const mask = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) mask[i] = data[p];
  bitmap.close?.();
  return { mask, width: bitmap.width, height: bitmap.height };
}

/**
 * 服务端 RLE（`[on, len, on, len, …]` 交替，on=1 表示掩膜）→ Uint8Array。
 *
 * 优先使用它而不是灰度 PNG：解码结果完全确定，不依赖 canvas / createImageBitmap，
 * 也省掉一次 PNG 解码。（实测在浏览器里走 canvas 解码灰度 PNG 会得到全 0 掩膜，
 * 于是界面出现"检测到 96 个区域、置信度 100%，但覆盖面积 0.00%"的自相矛盾结果，
 * 后续"执行去除"还会因为空掩膜被后端拒绝。）
 */
export function decodeMaskFromRle(rle) {
  const width = Math.max(0, Math.round(rle?.width ?? 0));
  const height = Math.max(0, Math.round(rle?.height ?? 0));
  const runs = Array.isArray(rle?.runs) ? rle.runs : [];
  const mask = new Uint8Array(width * height);
  let i = 0;
  for (let r = 0; r + 1 < runs.length; r += 2) {
    const on = runs[r];
    const len = runs[r + 1];
    if (on) mask.fill(255, i, Math.min(mask.length, i + len));
    i += len;
  }
  return { mask, width, height };
}

/**
 * Uint8Array → 灰度 PNG dataURL。
 * `feather`>0 时先做一次可分离盒式模糊（两趟一维，O(n)），软边更贴合不透明区域的过渡；
 * 后端仍未上线对应参数时把它当 0 传即可，两端都不会因此报错。
 */
export function encodeMaskToDataUrl(mask, width, height, { feather = 0 } = {}) {
  const source = feather > 0 ? featherMask(mask, width, height, feather) : mask;
  const { ctx } = make2d(width, height, true);
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  for (let i = 0, p = 0; i < source.length; i += 1, p += 4) {
    const v = source[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return ctx.canvas.toDataURL('image/png');
}

export function maskToImageData(mask, width, height) {
  const { ctx } = make2d(width, height, true);
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const v = mask[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return imageData;
}
/** 覆盖面积占比（0..1），结果面板与批量进度都用它。 */
export function maskCoverage(mask) {
  if (!mask?.length) return 0;
  let hits = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 127) hits += 1;
  return hits / mask.length;
}

/** mask → 整数包围盒（用于快速判断掩膜是否为空、以及本地统计）。 */
export function maskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ------------------------------------------------------------- 本地编辑

/** 一次画圆的包围盒，画笔与橡皮共用（只回写受影响区域，避免整图扫描）。 */
function circleBox(cx, cy, radius, width, height) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  return { x0, y0, x1, y1 };
}

/**
 * 在掩膜上涂抹一段（从 from 到 to），返回受影响的包围盒。
 *
 * 两点之间按半径的 1/3 补步，快速拖动时不会留下断点。
 * 距离用“像素中心 (±0.5)”判定，必须与叠加层的 arc(x+0.5, y+0.5, r) 保持同一套几何——
 * 否则界面上画出来的圆和真正提交给后端的掩膜会差半个像素（半径 1 时尤其明显）。
 */
export function strokeMask(mask, width, height, from, to, { radius = 12, erase = false, value = 255 } = {}) {
  const r = Math.max(1, radius);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, r / 3)));
  const target = erase ? 0 : value;

  const box = {
    x0: width,
    y0: height,
    x1: -1,
    y1: -1,
  };

  for (let s = 0; s <= steps; s += 1) {
    const cx = from.x + (dx * s) / steps + 0.5;
    const cy = from.y + (dy * s) / steps + 0.5;
    const { x0, y0, x1, y1 } = circleBox(cx, cy, r, width, height);
    for (let y = y0; y <= y1; y += 1) {
      const row = y * width;
      const py = y + 0.5 - cy;
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5 - cx;
        if (px * px + py * py > r * r) continue;
        mask[row + x] = target;
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      box.x0 = Math.min(box.x0, x0);
      box.y0 = Math.min(box.y0, y0);
      box.x1 = Math.max(box.x1, x1);
      box.y1 = Math.max(box.y1, y1);
    }
  }

  if (box.x1 < box.x0) return null;
  return { x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1 };
}

/**
 * 可分离盒式模糊：两趟一维滑动窗口，复杂度与半径无关（大图羽化才敢这么用）。
 *
 * 第一趟的中间结果写进独立的 work：max 混合之后的值如果留在滑动窗口里，
 * 后续列/行的求和会被污染（求出来的“模糊”其实是错的）。
 * 最终用 max(原值, 模糊值) 而不是纯模糊：笔画核心被模糊后会掉到 255 以下，
 * 提交给后端就可能留下残影；max 只把过渡扩展到边缘，核心保持实心。
 */
export function featherMask(mask, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const size = width * height;
  const window = r * 2 + 1;
  const soft = new Uint8Array(mask);

  if (size === 0 || mask.length < size) return soft;

  const work = new Uint8Array(size);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += mask[row + Math.min(width - 1, Math.max(0, k))];
    for (let x = 0; x < width; x += 1) {
      work[row + x] = sum / window;
      const drop = Math.min(width - 1, Math.max(0, x - r));
      const add = Math.min(width - 1, Math.max(0, x + r + 1));
      sum += mask[row + add] - mask[row + drop];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += work[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y += 1) {
      const index = y * width + x;
      soft[index] = Math.max(mask[index], sum / window);
      const drop = Math.min(height - 1, Math.max(0, y - r)) * width + x;
      const add = Math.min(height - 1, Math.max(0, y + r + 1)) * width + x;
      sum += work[add] - work[drop];
    }
  }
  return soft;
}

// ------------------------------------------------------------- 叠加层

function toRgbaColor(color) {
  const raw = String(color || '').trim();
  const hex = raw.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    const [a, b, c] = short[1].split('').map((ch) => parseInt(ch + ch, 16));
    return [a, b, c];
  }
  return null;
}

function readCssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * 掩膜叠加层：一张与图片同尺寸的离屏画布，用强调色把掩膜画成半透明色块。
 *
 * 之所以不每帧按像素重绘，是因为 4000×3000 的 RGBA 缓冲是 48MB 级别：
 * 涂抹时只回写受影响的那一小块（commitStroke），平移缩放时只是 drawImage 一次，
 * 大图下叠加层依旧跟手。
 */
export function createMaskLayer(width, height, options = {}) {
  const { canvas, ctx } = make2d(width, height, true);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let color = options.color || readCssColor('--accent', '#0d99ff');
  let alpha = options.alpha ?? 0.5;
  let rgba = toRgbaColor(color) ?? [13, 153, 255];

  function applyStyle() {
    rgba = toRgbaColor(color) ?? rgba;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
  }

  /**
   * 整层重建：仅在“解码服务端掩膜”“清空”“切换素材”时需要。
   * 一次性构造 ImageData 再 putImageData，比逐像素 fillRect 快一个量级（大图上有肉眼可见的差别）。
   */
  function rebuild(mask) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!mask) return;
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    const out = imageData.data;
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    for (let i = 0, p = 0; i < mask.length && p < out.length; i += 1, p += 4) {
      if (mask[i] <= 0) continue;
      out[p] = rgba[0];
      out[p + 1] = rgba[1];
      out[p + 2] = rgba[2];
      out[p + 3] = a;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function paintCircle(cx, cy, radius, erase) {
    const r = Math.max(1, radius);
    applyStyle();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function paintSegment(from, to, radius, erase) {
    const r = Math.max(1, radius);
    applyStyle();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = r * 2;
    ctx.strokeStyle = `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** 把离屏层按当前缩放/平移贴到可见画布上（只做一次 drawImage）。 */
  function blitTo(targetCtx, { x, y, scale }) {
    targetCtx.drawImage(canvas, x, y, canvas.width * scale, canvas.height * scale);
  }

  /** 画笔落点后，只把包围盒区域同步回掩膜（保证“本地编辑”与显示严格一致）。 */
  function commitStroke(mask, box) {
    if (!box) return;
    const { data } = ctx.getImageData(box.x, box.y, box.width, box.height);
    for (let y = 0; y < box.height; y += 1) {
      const src = y * box.width * 4;
      const dst = (box.y + y) * canvas.width + box.x;
      for (let x = 0; x < box.width; x += 1) {
        const a = data[src + x * 4 + 3];
        mask[dst + x] = a > 127 ? 255 : 0;
      }
    }
  }

  return {
    canvas,
    ctx,
    setColor(next) {
      color = next;
    },
    setAlpha(next) {
      alpha = next;
    },
    rebuild,
    paintCircle,
    paintSegment,
    blitTo,
    commitStroke,
    get color() {
      return color;
    },
  };
}
