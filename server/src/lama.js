/**
 * LaMa 修复模型运行时（ONNX Runtime / Node）
 * ----------------------------------------
 * 上游：
 *   - 模型 LaMa: advimman/lama (Apache-2.0)，权重用 Carve/LaMa-ONNX 的 ONNX 导出
 *   - 运行时 onnxruntime-node (MIT)
 *
 * 该导出是**固定 512×512 输入**（`image` 1×3×512×512 float32、`mask` 1×1×512×512 float32，
 * mask=1 表示待修补区域），所以这里采用「原生分辨率切片」策略：
 *   按掩膜包围盒扩张出若干 512×512 的窗口（有重叠），逐块推理，只把掩膜内的像素贴回。
 *   好处是**不做缩放**，不会因为下采样丢掉细节；代价是要跑多次推理（CPU 上每块约 1–3 秒）。
 *
 * 关于执行后端：本机实测 DirectML(EP=dml) 在该模型的 FFC/RTTN 的 MatMul 上会报
 * E_INVALIDARG，因此默认走 CPU；需要试验 GPU 时可设 IMAGE_CLIP_LAMA_EP=dml。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_FILES = ['lama_fp32.onnx', 'lama.onnx'];

/** 模型目录在调用时解析，便于运行期通过环境变量切换（测试也会用到）。 */
function modelDir() {
  return process.env.IMAGE_CLIP_MODEL_DIR || path.join(ROOT, 'models');
}

export const LAMA_PATCH = 512;

/** 找模型文件：环境变量 > models/ 目录。 */
export function resolveModelPath() {
  const fromEnv = process.env.IMAGE_CLIP_LAMA_MODEL;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const file of MODEL_FILES) {
    const candidate = path.join(modelDir(), file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function lamaStatus() {
  const modelPath = resolveModelPath();
  if (!modelPath) {
    return {
      available: false,
      path: null,
      bytes: null,
      patch: LAMA_PATCH,
      install: 'node scripts/download-lama.mjs',
    };
  }
  const stat = fs.statSync(modelPath);
  return {
    available: true,
    path: path.relative(ROOT, modelPath),
    bytes: stat.size,
    patch: LAMA_PATCH,
    executionProvider: process.env.IMAGE_CLIP_LAMA_EP || 'cpu',
  };
}

let sessionPromise = null;

/** 惰性创建并缓存推理会话（加载 200MB 模型约 20 秒，只做一次）。 */
export function getLamaSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const modelPath = resolveModelPath();
    if (!modelPath) {
      throw new Error('未找到 LaMa 模型，请先执行：node scripts/download-lama.mjs');
    }
    const ort = (await import('onnxruntime-node')).default;
    const requested = process.env.IMAGE_CLIP_LAMA_EP || 'cpu';
    const providers = requested === 'cpu' ? ['cpu'] : [requested, 'cpu'];
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
    return { ort, session, modelPath, providers };
  })().catch((err) => {
    sessionPromise = null; // 失败不缓存，下次可重试
    throw err;
  });
  return sessionPromise;
}

/** 预热（可选）：服务启动时后台加载模型，避免第一次请求等 20 秒。 */
export function warmupLama() {
  if (!resolveModelPath()) return Promise.resolve(lamaStatus());
  const started = Date.now();
  return getLamaSession()
    .then(() => ({ ...lamaStatus(), loadMs: Date.now() - started }))
    .catch((err) => ({ ...lamaStatus(), error: err.message }));
}

/**
 * 从大图中取一块 patch×patch 的补丁（越界用边缘复制填充）。
 * 直接用 JS 采样，避免引入额外依赖。
 */
function extractPatch(image, mask, x, y, size) {
  const rgb = new Float32Array(3 * size * size);
  const m = new Float32Array(size * size);
  const plane = size * size;
  const { width: w, height: h } = image;

  for (let py = 0; py < size; py += 1) {
    const sy = Math.min(h - 1, Math.max(0, y + py));
    for (let px = 0; px < size; px += 1) {
      const sx = Math.min(w - 1, Math.max(0, x + px));
      const src = (sy * w + sx) * 4;
      const dst = py * size + px;
      rgb[dst] = image.data[src] / 255;
      rgb[plane + dst] = image.data[src + 1] / 255;
      rgb[2 * plane + dst] = image.data[src + 2] / 255;
      m[dst] = mask.data[sy * w + sx] > 127 ? 1 : 0;
    }
  }
  return { rgb, mask: m };
}

/** 规划覆盖掩膜区域的窗口（先按包围盒扩张，再按 stride 平铺）。 */
export function planPatches(image, mask, { patch = LAMA_PATCH, overlap = 96, context = 0.25 } = {}) {
  const { width: w, height: h } = image;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mask.data[y * w + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return [];

  const marginX = Math.round((maxX - minX + 1) * context);
  const marginY = Math.round((maxY - minY + 1) * context);
  const x0 = Math.max(0, minX - marginX);
  const y0 = Math.max(0, minY - marginY);
  const x1 = Math.min(w, maxX + 1 + marginX);
  const y1 = Math.min(h, maxY + 1 + marginY);

  const stride = Math.max(32, patch - overlap);
  const windows = [];
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      // 贴边时向内回退，让窗口完整落在图内（小图则由越界填充处理）
      const wx = w <= patch ? 0 : Math.min(Math.max(0, x), w - patch);
      const wy = h <= patch ? 0 : Math.min(Math.max(0, y), h - patch);
      if (windows.some((win) => win.x === wx && win.y === wy)) continue;
      windows.push({ x: wx, y: wy });
    }
    if (h <= patch) break;
  }
  if (w <= patch) {
    const dedup = [];
    for (const win of windows) if (!dedup.some((d) => d.y === win.y)) dedup.push(win);
    return dedup;
  }
  return windows;
}

/**
 * 该 ONNX 导出的输出已经是 **0–255**（实测：把 255 当作 0–1 去乘会整张过曝）。
 * 不同导出可能不同，所以运行时按数值范围判定并缓存判定结果。
 */
function outputScaleFor(tensor) {
  if (tensor.__imageClipScale) return tensor.__imageClipScale;
  let max = 0;
  const { data } = tensor;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (v > max) max = v;
  }
  const scale = max > 2 ? 1 : 255;
  Object.defineProperty(tensor, '__imageClipScale', { value: scale, enumerable: false });
  return scale;
}

/**
 * 逐窗口跑 LaMa，并把掩膜内的结果贴回。
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{width:number,height:number,data:Uint8Array}} mask 255=待修补
 * @returns {Promise<{image:object, patches:number, windows:Array, elapsedMs:number}>}
 */
export async function lamaInpaint(image, mask, options = {}) {
  const started = Date.now();
  const opts = { patch: LAMA_PATCH, overlap: 96, context: 0.25, maxPatches: 32, onProgress: null, ...options };
  const windows = planPatches(image, mask, opts);
  if (windows.length === 0) {
    return { image: { ...image, data: new Uint8ClampedArray(image.data) }, patches: 0, windows: [], elapsedMs: 0 };
  }
  if (windows.length > opts.maxPatches) {
    throw new Error(
      `需要 ${windows.length} 个 512×512 推理窗口（上限 ${opts.maxPatches}）：水印区域过大，请缩小检测区域或改用本地修补引擎`,
    );
  }

  const { ort, session, providers } = await getLamaSession();
  const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const { patch } = opts;
  let outputScale = null;

  for (const [index, win] of windows.entries()) {
    const { rgb, mask: patchMask } = extractPatch(image, mask, win.x, win.y, patch);
    const feeds = {};
    feeds[session.inputNames[0]] = new ort.Tensor('float32', rgb, [1, 3, patch, patch]);
    feeds[session.inputNames[1]] = new ort.Tensor('float32', patchMask, [1, 1, patch, patch]);
    const result = await session.run(feeds);
    const tensor = result[session.outputNames[0]];
    if (outputScale === null) outputScale = outputScaleFor(tensor);
    const plane = patch * patch;

    // 只贴回掩膜内的像素（避免模型对未遮挡区域的轻微重建误差影响画质）
    for (let py = 0; py < patch; py += 1) {
      const ty = win.y + py;
      if (ty < 0 || ty >= image.height) continue;
      for (let px = 0; px < patch; px += 1) {
        const tx = win.x + px;
        if (tx < 0 || tx >= image.width) continue;
        const mi = ty * image.width + tx;
        if (mask.data[mi] <= 127) continue;
        const pi = py * patch + px;
        const dp = mi * 4;
        out.data[dp] = Math.max(0, Math.min(255, tensor.data[pi] * outputScale));
        out.data[dp + 1] = Math.max(0, Math.min(255, tensor.data[plane + pi] * outputScale));
        out.data[dp + 2] = Math.max(0, Math.min(255, tensor.data[2 * plane + pi] * outputScale));
      }
    }
    if (opts.onProgress) opts.onProgress({ done: index + 1, total: windows.length });
  }

  return { image: out, patches: windows.length, windows, providers, outputScale, elapsedMs: Date.now() - started };
}

/** 跑一次推理并返回原始输出张量（供自检/测试用）。 */
export async function lamaRawRun(image, mask, { x = 0, y = 0, patch = LAMA_PATCH } = {}) {
  const { ort, session, providers } = await getLamaSession();
  const { rgb, mask: patchMask } = extractPatch(image, mask, x, y, patch);
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', rgb, [1, 3, patch, patch]);
  feeds[session.inputNames[1]] = new ort.Tensor('float32', patchMask, [1, 1, patch, patch]);
  const result = await session.run(feeds);
  return { tensor: result[session.outputNames[0]], providers };
}
