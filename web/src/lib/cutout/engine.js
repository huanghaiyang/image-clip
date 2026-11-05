/**
 * AI 抠图推理引擎（运行在 Web Worker 中）
 * --------------------------------------
 * 使用 onnxruntime-web 的 WASM 后端执行 ONNX 模型，算法移植自 Concat：
 *   - Person (RVM): src 三平面 0..1 → pha（真 alpha，含发丝）
 *   - Object (IS-Net): 按最亮值归一 → 输出按 min/max 拉伸
 *   - Selfie (MediaPipe): pixel_values 0..1 → alphas
 *
 * 模型只在本机推理；权重文件由服务端 /api/cutout/model/:id 提供，
 * 首次下载后写入 Cache Storage，后续进入页面直接命中，不重复走网络。
 */
// 只引入 WASM 后端：不把 WebGPU/JSEP 的运行时打进包里
import * as ort from 'onnxruntime-web/wasm';

import {
  cutoutInputSize,
  planesFromRgba,
  probabilitiesToMask,
  resizeMaskBilinear,
  spanToMask,
} from '@shared/cutout.js';

// 单线程模式：多线程 WASM 需要页面开启 COOP/COEP（SharedArrayBuffer），
// 本项目的本地服务没有这些响应头；对单张图片推理来说单线程已经够用。
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.proxy = false;

const CACHE_NAME = 'image-clip-cutout-models';
const sessions = new Map();
const modelBuffers = new Map();

function reportProgress(report, phase, extra = {}) {
  report?.({ phase, ...extra });
}

/** 读取模型字节：内存 → Cache Storage → 网络（带下载进度）。 */
async function loadModelBuffer(modelId, report) {
  if (modelBuffers.has(modelId)) return modelBuffers.get(modelId);
  const key = `/api/cutout/model/${modelId}`;
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    /* 无 Cache Storage（极少数隐私模式）时退化为纯内存 + 网络 */
  }

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      reportProgress(report, 'loading', { message: '读取本地缓存的模型…' });
      const bytes = new Uint8Array(await hit.arrayBuffer());
      modelBuffers.set(modelId, bytes);
      return bytes;
    }
  }

  reportProgress(report, 'download', { loaded: 0, total: 0, message: '首次使用，下载模型…' });
  const response = await fetch(key);
  if (!response.ok) {
    let message = `模型下载失败（HTTP ${response.status}）`;
    try {
      const data = await response.json();
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(message);
  }

  const total = Number(response.headers.get('content-length') || 0);
  let loaded = 0;
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      reportProgress(report, 'download', { loaded, total, message: '下载模型…' });
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  modelBuffers.set(modelId, bytes);
  if (cache) {
    try {
      await cache.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      /* 配额不足时忽略缓存失败，模型仍在内存里可用 */
    }
  }
  return bytes;
}

async function getSession(modelId, report) {
  if (sessions.has(modelId)) return sessions.get(modelId);
  const bytes = await loadModelBuffer(modelId, report);
  reportProgress(report, 'session', { message: '初始化 ONNX 会话…' });
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  sessions.set(modelId, session);
  return session;
}

function tensor(type, data, dims) {
  return new ort.Tensor(type, data, dims);
}

/** 人像：RVM，返回模型输入尺寸下的主体 alpha。 */
async function personMask(session, planes, width, height) {
  const inputs = {
    src: tensor('float32', planes, [1, 3, height, width]),
    r1i: tensor('float32', new Float32Array([0]), [1, 1, 1, 1]),
    r2i: tensor('float32', new Float32Array([0]), [1, 1, 1, 1]),
    r3i: tensor('float32', new Float32Array([0]), [1, 1, 1, 1]),
    r4i: tensor('float32', new Float32Array([0]), [1, 1, 1, 1]),
    downsample_ratio: tensor('float32', new Float32Array([1]), [1]),
  };
  const outputs = await session.run(inputs, ['pha']);
  return probabilitiesToMask(outputs.pha.data, width, height);
}

/** 通用物体：IS-Net，返回模型 1024 尺寸下的主体 alpha。 */
async function objectMask(session, planes, width, height) {
  let brightest = 0;
  for (let i = 0; i < planes.length; i += 1) if (planes[i] > brightest) brightest = planes[i];
  brightest = Math.max(brightest, 1e-6);
  for (let i = 0; i < planes.length; i += 1) planes[i] = planes[i] / brightest - 0.5;
  const outputs = await session.run(
    { input_image: tensor('float32', planes, [1, 3, height, width]) },
    ['output_image'],
  );
  return spanToMask(outputs.output_image.data, width, height);
}

/** 轻量人像：MediaPipe Selfie Segmentation。 */
async function selfieMask(session, planes, width, height) {
  const outputs = await session.run(
    { pixel_values: tensor('float32', planes, [1, 3, height, width]) },
    ['alphas'],
  );
  return probabilitiesToMask(outputs.alphas.data, width, height);
}

/**
 * 对一张 RGBA 图生成主体 alpha（原始分辨率）。
 * @returns {Uint8Array} 长度 width*height
 */
export async function segmentRgba(modelId, rgba, width, height, report) {
  const session = await getSession(modelId, report);
  const started = performance.now();
  const { width: modelWidth, height: modelHeight } = cutoutInputSize(modelId, width, height);
  reportProgress(report, 'preprocess', { message: '预处理图像…' });
  const planes = planesFromRgba(rgba, width, height, modelWidth, modelHeight);

  reportProgress(report, 'inference', { message: 'AI 推理中…' });
  let mask;
  if (modelId === 'person') mask = await personMask(session, planes, modelWidth, modelHeight);
  else if (modelId === 'object') mask = await objectMask(session, planes, modelWidth, modelHeight);
  else if (modelId === 'selfie') mask = await selfieMask(session, planes, modelWidth, modelHeight);
  else throw new Error(`未知的抠图模型：${modelId}`);

  const alpha = resizeMaskBilinear(mask, modelWidth, modelHeight, width, height);
  return { alpha, width, height, elapsedMs: Math.round(performance.now() - started) };
}
