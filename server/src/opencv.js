/**
 * OpenCV.js 单例加载（服务端）
 * --------------------------
 * 上游包 `@techstark/opencv-js`（Apache-2.0，OpenCV 5 的 wasm 构建）。
 * 注意：这个包里模块本身是 thenable —— `await cv` 之后才拿得到 Mat/inpaint/dft，
 * 因此统一用 shared/watermark/cv-utils.js 的 loadOpenCv() 包装。
 *
 * wasm 加载约 1–2 秒、常驻约几十 MB，所以进程内只加载一次并缓存 Promise。
 */
import { loadOpenCv } from '../../shared/watermark/cv-utils.js';

let cvPromise = null;

export function getOpenCv() {
  if (!cvPromise) {
    cvPromise = (async () => {
      const mod = await import('@techstark/opencv-js');
      return loadOpenCv(mod);
    })().catch((err) => {
      cvPromise = null; // 失败不缓存，允许重试
      throw new Error(`OpenCV 初始化失败：${err.message}`);
    });
  }
  return cvPromise;
}

/** 供 /api/watermark/health 使用的能力探测。 */
export async function opencvStatus() {
  const started = Date.now();
  try {
    const cv = await getOpenCv();
    return {
      available: true,
      version: 'opencv.js (wasm / OpenCV 5)',
      hasInpaint: typeof cv.inpaint === 'function',
      hasDft: typeof cv.dft === 'function',
      hasMatchTemplate: typeof cv.matchTemplate === 'function',
      loadMs: Date.now() - started,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}
