/**
 * 文本区域检测（DBNet / PP-OCRv4 det，ONNX）—— **离线**推理。
 *
 * 为什么需要它
 * ------------
 * 纯统计的水印检测没有「水印」这个概念，只能看 α-map / 形态学特征。实测用户那张
 * 20 只蝴蝶的插画：亮极性把浅色蝴蝶读成 α≈0.48~0.55 的「半透明叠加」，掩膜里
 * 99.6% 是画面内容；周期性路径甚至把蝴蝶网格判成「平铺水印」（22%）。
 * 这些不是参数问题，而是**语义**问题 —— 但也不需要上一整套大模型：
 *
 *   绝大多数可见水印是**文字**（版权标、AI 生成标、平台昵称、店铺名…）。
 *
 * 所以用一个小文本检测模型（PP-OCRv4 det，**4.5MB**，纯 ONNX、无需 torch）先把
 * 「图里哪些像素是文字」找出来，把水印检测限制在这些区域内。效果：
 *   - 插画/照片里的非文字内容（蝴蝶翅膀、纹理、高光）**从结构上**不再可能被当成水印；
 *   - 文字区域内部仍然由原有 α-map 做像素级精修与不透明度估计（模型不管 α）；
 *   - 模型不存在时，整套流程行为与之前完全一致（可关、可回退）。
 *
 * 局限（写清楚，避免误用）：它只回答「哪里是文字」，不回答「这段文字是不是水印」。
 * 因此区域内仍需原有的门限（贴角 / 重复 / α 一致性 / 覆盖率）做取舍 —— 例如书页
 * 扫描件里的正文会被判为文字区域，此时还需要靠「是否像水印」的先验来排除。
 */
import fs from 'node:fs';
import path from 'node:path';

/** DBNet 要求输入边长为 32 的倍数。 */
const ALIGN = 32;
/** 长边上限：太大只是徒增耗时，PP-OCR 训练时也常用 960。 */
const DEFAULT_LIMIT_SIDE = 960;
/** 概率图阈值（PaddleOCR 默认 0.3）。 */
const DEFAULT_BOX_THRESH = 0.3;
/** 文本概率图的归一化参数（与 PaddleOCR det 预处理一致）。 */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessionPromise = null;

export function resolveTextModelPath() {
  const fromEnv = process.env.TEXT_DET_ONNX || process.env.OCR_DET_ONNX;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(import.meta.dirname, '../../models/ppocrv4-det.onnx');
}

export function textModelStatus() {
  const modelPath = resolveTextModelPath();
  try {
    const stat = fs.statSync(modelPath);
    return { available: true, path: modelPath, sizeBytes: stat.size, reason: null };
  } catch (err) {
    return {
      available: false,
      path: modelPath,
      sizeBytes: 0,
      reason: `未找到文本检测模型（${err.code ?? err.message}）：先跑 node scripts/download-text-model.mjs`,
    };
  }
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const status = textModelStatus();
      if (!status.available) throw new Error(status.reason);
      const ort = (await import('onnxruntime-node')).default;
      const providers = (process.env.ORT_PROVIDERS || 'cpu').split(',').map((s) => s.trim()).filter(Boolean);
      const session = await ort.InferenceSession.create(status.path, { executionProviders: providers });
      return { session, input: session.inputNames[0], output: session.outputNames[0] };
    })().catch((err) => {
      sessionPromise = null; // 失败不缓存，装好模型后可以重试
      throw new Error(`文本检测模型加载失败：${err.message}`);
    });
  }
  return sessionPromise;
}

/** 按 PaddleOCR 的方式缩放（保持长宽比、边长补齐到 32 的倍数）。 */
function planSize(width, height, limitSide) {
  let ratio = 1;
  const longSide = Math.max(width, height);
  if (limitSide > 0 && longSide > limitSide) ratio = limitSide / longSide;
  let w = Math.max(ALIGN, Math.round((width * ratio) / ALIGN) * ALIGN);
  let h = Math.max(ALIGN, Math.round((height * ratio) / ALIGN) * ALIGN);
  if (w < ALIGN) w = ALIGN;
  if (h < ALIGN) h = ALIGN;
  return { w, h };
}

/** 双线性缩放（RGB → NCHW float32，按 ImageNet 均值方差归一化）。 */
function toTensor(rgba, width, height, outW, outH, ort) {
  const data = new Float32Array(3 * outW * outH);
  const scaleX = width / outW;
  const scaleY = height / outH;
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = sx - x0;
      for (let c = 0; c < 3; c += 1) {
        const p00 = rgba[(y0 * width + x0) * 4 + c];
        const p01 = rgba[(y0 * width + x1) * 4 + c];
        const p10 = rgba[(y1 * width + x0) * 4 + c];
        const p11 = rgba[(y1 * width + x1) * 4 + c];
        const top = p00 + (p01 - p00) * wx;
        const bottom = p10 + (p11 - p10) * wx;
        const v = (top + (bottom - top) * wy) / 255;
        data[c * outW * outH + y * outW + x] = (v - MEAN[c]) / STD[c];
      }
    }
  }
  return new ort.Tensor('float32', data, [1, 3, outH, outW]);
}

/** 概率图上采样回原尺寸（最近邻取最大，保证细笔画不被抹掉）。 */
function upsampleProb(prob, probW, probH, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(probH - 1, Math.floor((y * probH) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(probW - 1, Math.floor((x * probW) / width));
      out[y * width + x] = prob[sy * probW + sx];
    }
  }
  return out;
}

/**
 * 找出图中的文字区域。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{limitSide?:number,threshold?:number,dilateRatio?:number}} [options]
 * @returns {Promise<{mask:Uint8Array,coverage:number,elapsedMs:number,boxes:Array<{x:number,y:number,width:number,height:number}>,inputSize:{width:number,height:number}}>}
 */
export async function detectTextRegions(image, options = {}) {
  const started = Date.now();
  const { session, input, output } = await getSession();
  const ort = (await import('onnxruntime-node')).default;
  const limitSide = Number.isFinite(options.limitSide) ? options.limitSide : DEFAULT_LIMIT_SIDE;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_BOX_THRESH;
  const dilateRatio = Number.isFinite(options.dilateRatio) ? options.dilateRatio : 0.012;

  const { w, h } = planSize(image.width, image.height, limitSide);
  const tensor = toTensor(image.data, image.width, image.height, w, h, ort);
  const results = await session.run({ [input]: tensor });
  const probTensor = results[output];
  const [, , probH, probW] = probTensor.dims;
  const prob = upsampleProb(probTensor.data, probW, probH, image.width, image.height);

  // 阈值化 + 膨胀：DBNet 输出的是**收缩后**的文本核，适度膨胀才能覆盖字形边缘
  const raw = new Uint8Array(image.width * image.height);
  let hits = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (prob[i] >= threshold) {
      raw[i] = 255;
      hits += 1;
    }
  }
  const radius = Math.max(2, Math.round(Math.min(image.width, image.height) * dilateRatio));
  const mask = dilateBox(raw, image.width, image.height, radius);

  const boxes = maskToBoxes(mask, image.width, image.height);
  const coverage = countOn(mask) / (image.width * image.height);
  void hits;
  return {
    mask,
    coverage,
    boxes,
    elapsedMs: Date.now() - started,
    inputSize: { width: w, height: h },
  };
}

/** 盒式膨胀（半径按轴分离，等价于矩形结构元；比逐点圆形膨胀快得多）。 */
function dilateBox(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width + radius; x += 1) {
      if (x < width && mask[y * width + x] > 127) count += 1;
      if (x - 2 * radius - 1 >= 0 && mask[y * width + x - 2 * radius - 1] > 127) count -= 1;
      if (x - radius >= 0 && x - radius < width) tmp[y * width + x - radius] = count > 0 ? 255 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < height + radius; y += 1) {
      if (y < height && tmp[y * width + x] > 127) count += 1;
      if (y - 2 * radius - 1 >= 0 && tmp[(y - 2 * radius - 1) * width + x] > 127) count -= 1;
      if (y - radius >= 0 && y - radius < height) out[(y - radius) * width + x] = count > 0 ? 255 : 0;
    }
  }
  return out;
}

function countOn(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] > 127) n += 1;
  return n;
}

/** 连通域外接框（UI 上标记文本区域用；只在调用方需要时算）。 */
function maskToBoxes(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] <= 127 || seen[start]) continue;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[i - 1] > 127 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && mask[i + 1] > 127 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - width] > 127 && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && mask[i + width] > 127 && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }
    if (area < 16) continue;
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
  }
  return boxes.sort((a, b) => b.area - a.area);
}
