/**
 * 水印检测模型（YOLOv5 水印检测器，ONNX）—— **离线**推理。
 *
 * 它在整套水印流程里的位置
 * ------------------------
 * 纯统计的 α-map 检测有个绕不过去的弱点：它没有「水印」这个概念，只能看统计特征。
 * 实测用户那张图（2720×1520，20 只蝴蝶排成网格 + 右下角「豆包AI生成」浅灰角标）：
 *   - 亮极性把浅色蝴蝶读成 α≈0.48~0.55 的「半透明叠加」，掩膜里 99.6% 是画面内容；
 *   - 周期性路径更把 20 只蝴蝶的网格判成「平铺水印」，覆盖 22%。
 * 两种错法都不是参数问题，而是「语义」问题 —— 所以引入一个**会认水印的模型**：
 *   - 模型只负责**区域提议**（哪里可能是水印，给边界框）；
 *   - 框内仍然由本地 α-map / 形态学做**像素级精修**（模型给不出准确的 α）；
 *   - 模型不存在时整套流程回落到原来的纯统计路径，行为与之前完全一致。
 *
 * 权重来源：Eugeoter/yolov5-watermark-detection（HuggingFace 镜像 hf-mirror.com），
 * 构建期用 scripts/export-wm-yolov5.py 导出为 ONNX；运行期只依赖 onnxruntime-node。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 默认输入边长（与导出脚本一致）。 */
const DEFAULT_IMGSZ = 640;
/** 置信度阈值：水印检测宁可召回高一点，误检交给后面的精修与门限过滤。 */
const DEFAULT_CONF = 0.35;
const DEFAULT_IOU = 0.45;

let sessionPromise = null;

/** 模型路径：环境变量优先，其次 models/watermark-yolov5.onnx。 */
export function resolveWmModelPath() {
  const fromEnv = process.env.WATERMARK_ONNX || process.env.WM_MODEL_PATH;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(import.meta.dirname, '../../models/watermark-yolov5.onnx');
}

/** 模型可用性（供 /api/watermark/health 与界面提示使用）。 */
export function wmModelStatus() {
  const modelPath = resolveWmModelPath();
  try {
    const stat = fs.statSync(modelPath);
    return { available: true, path: modelPath, sizeBytes: stat.size, reason: null };
  } catch (err) {
    return {
      available: false,
      path: modelPath,
      sizeBytes: 0,
      reason: `未找到模型文件（${err.code ?? err.message}）：先跑 node scripts/download-wm-model.mjs，再跑 python 导出脚本`,
    };
  }
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const status = wmModelStatus();
      if (!status.available) throw new Error(status.reason);
      const ort = (await import('onnxruntime-node')).default;
      const providers = (process.env.ORT_PROVIDERS || 'cpu').split(',').map((s) => s.trim()).filter(Boolean);
      const session = await ort.InferenceSession.create(status.path, { executionProviders: providers });
      const input = session.inputNames?.[0] ?? 'images';
      const shape = session.inputMetadata?.[input]?.dimensions ?? [];
      const imgsz = Number(shape[2]) || DEFAULT_IMGSZ;
      return { session, input, output: session.outputNames?.[0] ?? 'predictions', imgsz };
    })().catch((err) => {
      sessionPromise = null; // 失败不缓存，允许装好模型后重试
      throw new Error(`水印模型加载失败：${err.message}`);
    });
  }
  return sessionPromise;
}

/**
 * letterbox 到 imgsz×imgsz（保持长宽比，居中补边），返回 NCHW float32 张量。
 * YOLOv5 训练/导出都用这种预处理，检测时必须一致。
 */
function letterbox(rgba, width, height, imgsz) {
  const scale = Math.min(imgsz / width, imgsz / height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  const padX = Math.floor((imgsz - newW) / 2);
  const padY = Math.floor((imgsz - newH) / 2);

  // 双线性缩放 + 居中补 114（YOLOv5 的默认填充色）
  const out = new Float32Array(3 * imgsz * imgsz).fill(114 / 255);
  for (let y = 0; y < newH; y += 1) {
    const sy = Math.min(height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < newW; x += 1) {
      const sx = Math.min(width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = sx - x0;
      const dy = padY + y;
      const dx = padX + x;
      for (let c = 0; c < 3; c += 1) {
        const p00 = rgba[(y0 * width + x0) * 4 + c];
        const p01 = rgba[(y0 * width + x1) * 4 + c];
        const p10 = rgba[(y1 * width + x0) * 4 + c];
        const p11 = rgba[(y1 * width + x1) * 4 + c];
        const top = p00 + (p01 - p00) * wx;
        const bottom = p10 + (p11 - p10) * wx;
        const value = top + (bottom - top) * wy;
        out[c * imgsz * imgsz + dy * imgsz + dx] = value / 255;
      }
    }
  }
  return { data: out, scale, padX, padY, imgsz };
}

/** 标准 IoU-NMS（按置信度降序，逐类无关——水印检测只有一类）。 */
function nms(boxes, iouThreshold) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of sorted) {
    let overlap = false;
    for (const other of kept) {
      const x0 = Math.max(box.x, other.x);
      const y0 = Math.max(box.y, other.y);
      const x1 = Math.min(box.x + box.width, other.x + other.width);
      const y1 = Math.min(box.y + box.height, other.y + other.height);
      const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      if (inter <= 0) continue;
      const iou = inter / (box.width * box.height + other.width * other.height - inter);
      if (iou > iouThreshold) {
        overlap = true;
        break;
      }
    }
    if (!overlap) kept.push(box);
  }
  return kept;
}

/**
 * 用模型找出"疑似水印"的边界框。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{confidence?:number,iou?:number,maxBoxes?:number}} [options]
 * @returns {Promise<{boxes:Array<{x:number,y:number,width:number,height:number,score:number}>,elapsedMs:number,imgsz:number}>}
 */
export async function detectWatermarkRegions(image, options = {}) {
  const started = Date.now();
  const { session, input, output, imgsz } = await getSession();
  const confThreshold = Number.isFinite(options.confidence) ? options.confidence : DEFAULT_CONF;
  const iouThreshold = Number.isFinite(options.iou) ? options.iou : DEFAULT_IOU;
  const maxBoxes = Number.isFinite(options.maxBoxes) ? options.maxBoxes : 32;

  const ort = (await import('onnxruntime-node')).default;
  const { data, scale, padX, padY } = letterbox(image.data, image.width, image.height, imgsz);
  const tensor = new ort.Tensor('float32', data, [1, 3, imgsz, imgsz]);
  const results = await session.run({ [input]: tensor });
  const predictions = results[output];
  const dims = predictions.dims; // [1, N, 5+nc]
  const rows = dims[1];
  const stride = dims[2];
  const flat = predictions.data;

  const boxes = [];
  for (let i = 0; i < rows; i += 1) {
    const base = i * stride;
    const objectness = flat[base + 4];
    if (objectness < confThreshold) continue;
    // 单类（水印）：类别分数取最大
    let bestClass = 0;
    let bestScore = 0;
    for (let c = 5; c < stride; c += 1) {
      if (flat[base + c] > bestScore) {
        bestScore = flat[base + c];
        bestClass = c - 5;
      }
    }
    const score = objectness * (stride > 5 ? bestScore : 1);
    if (score < confThreshold) continue;

    // 输出坐标是 letterbox 图上的像素值（cx, cy, w, h）
    const cx = flat[base];
    const cy = flat[base + 1];
    const bw = flat[base + 2];
    const bh = flat[base + 3];
    let x = (cx - bw / 2 - padX) / scale;
    let y = (cy - bh / 2 - padY) / scale;
    let w = bw / scale;
    let h = bh / scale;
    // 裁到图内
    x = Math.max(0, Math.min(image.width - 1, x));
    y = Math.max(0, Math.min(image.height - 1, y));
    w = Math.max(1, Math.min(image.width - x, w));
    h = Math.max(1, Math.min(image.height - y, h));
    boxes.push({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
      score: Number(score.toFixed(4)),
      class: bestClass,
    });
  }

  const kept = nms(boxes, iouThreshold).slice(0, maxBoxes);
  return { boxes: kept, elapsedMs: Date.now() - started, imgsz };
}
