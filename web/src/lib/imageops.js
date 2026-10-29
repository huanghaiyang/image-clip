/**
 * 浏览器端图像合成小工具。
 * 所有图片编辑结果（裁剪 / 抠图 / 橡皮擦）最终都走这里输出 PNG，
 * 保证透明通道不会像 JPEG 那样被吞掉。
 */

/** 创建 2D canvas，顺带关闭不必要的 alpha 抖动。 */
export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** canvas → Blob（默认 PNG）。 */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('浏览器无法编码该图片'))),
      type,
      type === 'image/jpeg' ? quality : undefined,
    );
  });
}

/**
 * 从位图按像素矩形裁剪，可选缩放到目标尺寸。
 *
 * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement} source
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} [outputSize] 省略时输出裁剪框原尺寸
 * @param {{type?:string,quality?:number,background?:string}} [options]
 * @returns {Promise<Blob>}
 */
export async function cropToBlob(source, rect, outputSize, options = {}) {
  const width = Math.max(1, Math.round(Number(rect?.width) || 0));
  const height = Math.max(1, Math.round(Number(rect?.height) || 0));
  if (!source || width < 1 || height < 1) throw new Error('裁剪区域为空');

  const outWidth = Math.max(1, Math.round(Number(outputSize?.width) || width));
  const outHeight = Math.max(1, Math.round(Number(outputSize?.height) || height));
  const canvas = createCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  const type = options.type ?? 'image/png';

  if (type === 'image/jpeg') {
    ctx.fillStyle = options.background ?? '#ffffff';
    ctx.fillRect(0, 0, outWidth, outHeight);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    source,
    Math.round(rect.x),
    Math.round(rect.y),
    width,
    height,
    0,
    0,
    outWidth,
    outHeight,
  );
  return canvasToBlob(canvas, type, options.quality);
}

/** 去掉扩展名，用于生成 `xxx-裁剪.png` 这类名字。 */
export function stripExtension(name) {
  const text = String(name ?? 'image');
  const index = text.lastIndexOf('.');
  return index > 0 ? text.slice(0, index) : text;
}
