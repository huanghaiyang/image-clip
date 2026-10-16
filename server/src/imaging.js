/**
 * 图片解码 / 检测 / 裁剪 —— 服务端的 sharp 实现。
 *
 * 关键约定：检测算法与浏览器端**完全同一份** shared/aabb.js。
 * 这里只负责把任意输入格式解码成“直通 RGBA 字节”，再把 AABB 结果裁出来。
 */
import sharp from 'sharp';
import { detectBounds, normalizeOptions, ALGORITHM } from '../../shared/aabb.js';

export { ALGORITHM };

/** 与 UI 允许选择一致的输出格式。 */
export const OUTPUT_FORMATS = Object.freeze(['png', 'webp', 'jpeg', 'avif', 'source']);

export const LIMITS = Object.freeze({
  maxUploadBytes: 64 * 1024 * 1024, // 单张 64MB
  maxPixels: 64 * 1000 * 1000, // 6400 万像素
  maxBatch: 64,
});

export class InputError extends Error {
  constructor(message, code = 'BAD_INPUT', status = 400) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    this.status = status;
  }
}

/** `data:image/png;base64,xxx` / 裸 base64 / Buffer 都能吃。 */
export function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input !== 'string') throw new InputError('无法解析图片数据：期望二进制、base64 或 dataURL');

  const value = input.trim();
  if (!value) throw new InputError('图片数据为空');

  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0) throw new InputError('dataURL 格式不合法');
    const meta = value.slice(5, comma);
    const payload = value.slice(comma + 1);
    return meta.includes('base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'binary');
  }
  return Buffer.from(value, 'base64');
}

export function toDataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function createSharp(buffer) {
  if (!buffer?.length) throw new InputError('图片数据为空');
  if (buffer.length > LIMITS.maxUploadBytes) {
    throw new InputError(
      `图片过大：${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 ${LIMITS.maxUploadBytes / 1024 / 1024}MB`,
      'PAYLOAD_TOO_LARGE',
      413,
    );
  }
  return sharp(buffer, { limitInputPixels: LIMITS.maxPixels, animated: false });
}

/** 读取元信息（不做完整解码）。 */
export async function readMetadata(buffer) {
  try {
    const meta = await createSharp(buffer).metadata();
    return {
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format: meta.format ?? 'unknown',
      hasAlpha: Boolean(meta.hasAlpha),
      channels: meta.channels ?? 0,
      colorSpace: meta.space ?? 'unknown',
      isPalette: Boolean(meta.isPalette),
      orientation: meta.orientation ?? 1,
      pages: meta.pages ?? 1,
    };
  } catch (err) {
    throw new InputError(`无法识别的图片格式：${err.message}`, 'UNSUPPORTED_FORMAT', 415);
  }
}

/**
 * 解码成直通 RGBA（浏览器 canvas getImageData 的等价物）。
 * 统一走 srgb + ensureAlpha，保证灰度/CMYK/调色板/带 alpha 的图都能得到 4 通道。
 */
export async function decodeRgba(buffer) {
  try {
    const { data, info } = await createSharp(buffer)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) {
      throw new InputError(`解码后通道数为 ${info.channels}，期望 4 (RGBA)`, 'DECODE_UNEXPECTED_CHANNELS', 500);
    }
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError(`图片解码失败：${err.message}`, 'DECODE_FAILED', 422);
  }
}

/** 检测 AABB。返回结构与浏览器端一致，便于对照与联调。 */
export async function analyze(buffer, options = {}, knownMeta = null) {
  const started = Date.now();
  const meta = knownMeta ?? (await readMetadata(buffer));
  const { data, width, height } = await decodeRgba(buffer);
  const result = detectBounds(data, width, height, options);
  return {
    engine: 'node-sharp',
    algorithm: ALGORITHM,
    source: { ...meta, width, height, bytes: buffer.length },
    ...result,
    elapsedMs: Date.now() - started,
  };
}

/** 按检测到的边界裁切并编码。 */
export async function crop(buffer, options = {}) {
  const opts = normalizeOptions(options);
  const meta = await readMetadata(buffer);
  const analysis = await analyze(buffer, opts, meta); // 复用同一份元信息，避免重复解码前的探测

  if (analysis.empty) {
    throw new InputError('整张图片都是透明区域，没有可裁剪的内容', 'EMPTY_CONTENT', 422);
  }

  const { bounds } = analysis;
  const format = normalizeOutputFormat(options.format, meta.format);
  const quality = clampQuality(options.quality);

  let pipeline = createSharp(buffer).extract({
    left: bounds.x,
    top: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });

  let mime;
  switch (format) {
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 9, palette: false });
      mime = 'image/png';
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality, lossless: quality >= 100, effort: 4 });
      mime = 'image/webp';
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality, effort: 4 });
      mime = 'image/avif';
      break;
    case 'jpeg':
      // JPEG 没有 alpha 通道，先用白底压平，否则透明区域会变黑。
      pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality });
      mime = 'image/jpeg';
      break;
    default:
      pipeline = pipeline.png({ compressionLevel: 9 });
      mime = 'image/png';
  }

  const out = await pipeline.toBuffer();
  return {
    buffer: out,
    bytes: out.length,
    mime,
    format,
    bounds,
    trimmed: analysis.trimmed,
    source: analysis.source,
    options: opts,
    algorithm: ALGORITHM,
    elapsedMs: analysis.elapsedMs,
  };
}

export function normalizeOutputFormat(format, sourceFormat) {
  const value = String(format ?? 'png').toLowerCase();
  if (value === 'source') {
    const source = String(sourceFormat ?? '').toLowerCase();
    if (['png', 'webp', 'jpeg', 'jpg', 'avif'].includes(source)) return source === 'jpg' ? 'jpeg' : source;
    return 'png'; // gif/tiff/svg 等没有无损编码路径 → 退回 PNG
  }
  if (value === 'jpg') return 'jpeg';
  if (OUTPUT_FORMATS.includes(value)) return value;
  throw new InputError(`不支持的输出格式：${format}（可选 ${OUTPUT_FORMATS.join(' / ')}）`, 'BAD_FORMAT');
}

function clampQuality(quality) {
  const n = Math.round(Number(quality));
  if (!Number.isFinite(n)) return 90;
  return Math.min(100, Math.max(1, n));
}

/** 从 query / JSON body 中提取检测参数（JSON body 优先）。 */
export function pickOptions(query = {}, body = {}) {
  const fromQuery = {
    alphaThreshold: query.alphaThreshold ?? query.threshold,
    padding: query.padding,
    matchColor: toBool(query.matchColor),
    backgroundColor: query.backgroundColor,
    colorTolerance: query.colorTolerance,
    sample: query.sample,
  };
  const raw = { ...stripUndefined(fromQuery), ...stripUndefined(body.options ?? body) };
  const opts = normalizeOptions(raw);
  const format = body.format ?? query.format;
  const quality = body.quality ?? query.quality;
  return { ...opts, format, quality };
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

function toBool(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
