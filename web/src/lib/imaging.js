/**
 * 浏览器端图片处理：解码 → AABB 检测 → 裁剪导出。
 *
 * 检测算法来自 @shared/aabb.js —— 与 Node 服务端是同一份源码，
 * 所以“浏览器引擎”和“Node 引擎”的结果可以逐像素对齐。
 */
import { detectBounds, ALGORITHM, formatBytes } from '@shared/aabb.js';

export { ALGORITHM, formatBytes };

/** 单张图片的像素上限，防止超大图把标签页内存打满。 */
export const MAX_PIXELS = 64 * 1000 * 1000;

export const MIME_BY_FORMAT = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

export class ImageDecodeError extends Error {}

/** 把 File/Blob 解码成 ImageBitmap（优先 createImageBitmap，退回 <img>）。 */
export async function decodeBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch (err) {
      // 少数浏览器对某些编码（如老 WebP/AVIF）需要走 <img> 路径
      if (!/decode|unsupported|invalid/i.test(String(err?.message))) throw err;
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new ImageDecodeError('浏览器无法解码这张图片'));
      img.src = url;
    });
    if (typeof createImageBitmap === 'function') return await createImageBitmap(img);
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 解码一张图片并取出直通 RGBA 像素（canvas getImageData 与 sharp raw 等价）。 */
export async function decodeToRgba(source) {
  const bitmap = await decodeBitmap(source);

  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    throw new ImageDecodeError(`图片过大：${bitmap.width}×${bitmap.height}，上限约 ${Math.round(MAX_PIXELS / 1e6)}MP`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageDecodeError('无法创建 canvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);

  return {
    bitmap,
    imageData: ctx.getImageData(0, 0, bitmap.width, bitmap.height),
    width: bitmap.width,
    height: bitmap.height,
  };
}

/** 浏览器引擎：本地即时检测（不联网、不等待）。 */
export function analyzeLocally({ imageData, width, height }, options = {}) {
  const started = performance.now();
  const result = detectBounds(imageData.data, width, height, options);
  return {
    ...result,
    engine: 'browser-canvas',
    algorithm: ALGORITHM,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

/** 生成列表缩略图（dataURL，最长边 maxSize）。 */
export function makeThumbnail(bitmap, maxSize = 128) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** 按 AABB 裁剪，返回 Blob。JPEG 无 alpha，会先铺白底。 */
export async function renderCrop(bitmap, bounds, { format = 'png', quality = 92, background = '#ffffff' } = {}) {
  if (!bounds || bounds.width < 1 || bounds.height < 1) throw new ImageDecodeError('裁剪区域为空');

  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const ctx = canvas.getContext('2d');

  // 新建 canvas 本身是全透明的，只有导出 JPEG 时需要先铺底色
  if (format === 'jpeg') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, bounds.width, bounds.height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 1:1 取源图区域，不做缩放 —— 裁剪结果与原始像素一一对应
  ctx.drawImage(bitmap, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

  const mime = MIME_BY_FORMAT[format] ?? 'image/png';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, format === 'png' ? undefined : quality / 100));
  if (!blob) throw new ImageDecodeError(`当前浏览器不支持导出 ${format.toUpperCase()}`);
  return { blob, mime };
}

/** 触发浏览器下载。 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 原始文件名 → 裁剪后的文件名。 */
export function croppedFilename(name, format) {
  const base = String(name ?? 'image').replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}-cropped.${format === 'jpeg' ? 'jpg' : format}`;
}

export function formatRatio(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}
