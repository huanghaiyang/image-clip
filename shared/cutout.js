/**
 * AI 精准抠图 · 模型注册表与纯算法（浏览器 / Node 共用，零依赖）
 * -----------------------------------------------------------
 * 实现移植自开源项目 Concat（AGPL-3.0）的 concat-vision 抠图管线：
 *   - Person: Robust Video Matting (MobileNetV3)，输出带发丝细节的真 alpha；
 *   - Object: IS-Net，1024×1024 通用物体分割；
 *   - Selfie: MediaPipe Selfie Segmentation，256×256 的轻量人像分割。
 * 这里只复刻它的**预处理 / 后处理算法**（缩放、归一到 0..1、概率转掩膜、
 * 双线性采样等），模型权重由用户本地下载，不随仓库分发。
 *
 * 掩膜语义：`subject` alpha，0 = 背景，255 = 主体。
 * 与共享抠图模块的「去除掩膜」相反，转换见 `removalMaskFromAlpha()`。
 */

/** 可用的抠图模型。 */
export const CUTOUT_MODELS = Object.freeze([
  {
    id: 'person',
    label: '人像发丝',
    hint: 'RVM 人像抠图，保留头发、运动模糊等真实 alpha 边缘；视频、人像首选',
    file: 'rvm-mobilenetv3.onnx',
    bytes: 14975696,
    sha256: '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828',
    licence: 'GPL-3.0',
    upstream:
      'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx',
    /** 模型输入长边（内部会再按 16 对齐）。 */
    edge: 512,
  },
  {
    id: 'object',
    label: '通用物体',
    hint: 'IS-Net 通用主体分割，适合商品、动物、汽车、插画等非人像画面',
    file: 'isnet-general-use.onnx',
    bytes: 178648008,
    sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
    licence: 'Apache-2.0',
    upstream: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    /** 固定 1024×1024 输入。 */
    size: 1024,
  },
  {
    id: 'selfie',
    label: '快速人像',
    hint: 'MediaPipe 人像分割，256×256，体积小、速度最快；边缘细节弱于人像发丝模型',
    file: 'selfie-segmentation.onnx',
    bytes: 462352,
    sha256: null,
    licence: 'Apache-2.0',
    upstream:
      'https://raw.githubusercontent.com/jub0t/Concat/main/src/crates/concat-vision/models/selfie-segmentation.onnx',
    /** 固定 256×256 输入。 */
    size: 256,
  },
]);

const BY_ID = new Map(CUTOUT_MODELS.map((model) => [model.id, model]));

export function findCutoutModel(id) {
  return BY_ID.get(String(id)) ?? null;
}

/**
 * 模型实际的输入尺寸。
 *
 * Person（RVM）按长边 512、各边 16 的倍数取整，最小 64 —— 与 Concat 一致，
 * 这样网络内部的每一级 stride 都整除，不会在边缘补零。
 */
export function cutoutInputSize(modelId, width, height) {
  const model = findCutoutModel(modelId);
  if (!model) throw new Error(`未知的抠图模型：${modelId}`);
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  if (model.size) return { width: model.size, height: model.size };
  const scale = model.edge / Math.max(w, h);
  const round = (edge) => Math.max(64, Math.round((edge * scale) / 16) * 16);
  return { width: round(w), height: round(h) };
}

/**
 * RGBA → 模型输入的三平面 float32（0..1，RGB 顺序）。
 *
 * 采用最近邻采样（与 Concat 的 `planes()` 一致）：缩放模型输入本身不追求
 * 抗锯齿，避免在 alpha 边缘先引入一层灰度过渡。
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width 源图宽
 * @param {number} height 源图高
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {Float32Array} 长度 3*outWidth*outHeight
 */
export function planesFromRgba(rgba, width, height, outWidth, outHeight) {
  const sw = Math.max(1, Math.floor(Number(width) || 0));
  const sh = Math.max(1, Math.floor(Number(height) || 0));
  const dw = Math.max(1, Math.floor(Number(outWidth) || 0));
  const dh = Math.max(1, Math.floor(Number(outHeight) || 0));
  if (!rgba || rgba.length < sw * sh * 4) {
    throw new TypeError('planesFromRgba: rgba 长度必须 >= width*height*4');
  }
  const data = new Float32Array(3 * dw * dh);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const p = (sy * sw + sx) * 4;
      const index = y * dw + x;
      data[index] = rgba[p] / 255; // R
      data[dw * dh + index] = rgba[p + 1] / 255; // G
      data[2 * dw * dh + index] = rgba[p + 2] / 255; // B
    }
  }
  return data;
}

/** 0..1 的概率 → 8bit alpha 掩膜。 */
export function probabilitiesToMask(data, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const size = w * h;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const p = data[i];
    out[i] = Math.round(Math.max(0, Math.min(1, p)) * 255);
  }
  return out;
}

/**
 * IS-Net 的输出范围不是固定 0..1，按 Concat 的做法用最小/最大值拉伸到 0..255。
 * 返回拉伸后的掩膜（尺寸不变）。
 */
export function spanToMask(data, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const size = w * h;
  const out = new Uint8Array(size);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < size; i += 1) {
    const v = data[i];
    if (v < low) low = v;
    if (v > high) high = v;
  }
  const span = Math.max(1e-6, high - low);
  for (let i = 0; i < size; i += 1) {
    const p = (data[i] - low) / span;
    out[i] = Math.round(Math.max(0, Math.min(1, p)) * 255);
  }
  return out;
}

/**
 * 掩膜缩放（双线性、边缘夹取），输出尺寸为 `dstWidth × dstHeight`。
 * 对应 Concat `Mask::sample()` 的读数方式：按像素中心对齐采样。
 */
export function resizeMaskBilinear(mask, srcWidth, srcHeight, dstWidth, dstHeight) {
  const sw = Math.max(1, Math.floor(Number(srcWidth) || 0));
  const sh = Math.max(1, Math.floor(Number(srcHeight) || 0));
  const dw = Math.max(1, Math.floor(Number(dstWidth) || 0));
  const dh = Math.max(1, Math.floor(Number(dstHeight) || 0));
  if (!mask || mask.length < sw * sh) throw new TypeError('resizeMaskBilinear: 掩膜长度不足');
  if (sw === dw && sh === dh) return new Uint8Array(mask.slice(0, sw * sh));
  const out = new Uint8Array(dw * dh);
  const at = (x, y) => {
    const cx = Math.max(0, Math.min(sw - 1, x));
    const cy = Math.max(0, Math.min(sh - 1, y));
    return mask[cy * sw + cx];
  };
  for (let y = 0; y < dh; y += 1) {
    const fy = ((y + 0.5) / dh) * sh - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) / dw) * sw - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const top = at(x0, y0) * (1 - wx) + at(x0 + 1, y0) * wx;
      const bottom = at(x0, y0 + 1) * (1 - wx) + at(x0 + 1, y0 + 1) * wx;
      out[y * dw + x] = Math.round(top * (1 - wy) + bottom * wy);
    }
  }
  return out;
}

/** 主体 alpha → 背景去除掩膜（0 保留 / 255 去除），与 shared/bgremove.js 语义一致。 */
export function removalMaskFromAlpha(alpha, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const n = w * h;
  if (!alpha || alpha.length < n) throw new TypeError('removalMaskFromAlpha: 掩膜长度不足');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = 255 - alpha[i];
  return out;
}
