/**
 * AI 抠图客户端（主线程）：管理 Worker 生命周期与请求。
 */
let worker = null;
let sequence = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const { id } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    if (event.data.type === 'progress') {
      entry.onProgress?.(event.data);
      return;
    }
    pending.delete(id);
    if (event.data.type === 'error') {
      entry.reject(new Error(event.data.message));
      return;
    }
    entry.resolve({
      alpha: event.data.alpha,
      width: event.data.width,
      height: event.data.height,
      elapsedMs: event.data.elapsedMs,
    });
  };
  worker.onerror = (event) => {
    const err = new Error(event.message || 'AI 抠图 Worker 运行失败');
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/**
 * 调用 WASM 推理，返回主体 alpha（原始分辨率）。
 *
 * @param {object} options
 * @param {string} options.modelId  person / object / selfie
 * @param {Uint8ClampedArray|Uint8Array} options.rgba 会转移所有权，调用方需自行复制
 * @param {number} options.width
 * @param {number} options.height
 * @param {(p: object) => void} [options.onProgress]
 * @returns {Promise<{alpha: Uint8Array, width: number, height: number, elapsedMs: number}>}
 */
export function segmentImage({ modelId, rgba, width, height, onProgress }) {
  const target = ensureWorker();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    target.postMessage({ id, modelId, rgba, width, height }, [rgba.buffer]);
  });
}

/** 释放 Worker（切换工作区时可调用；模型缓存仍保留在 Cache Storage）。 */
export function disposeCutoutWorker() {
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) entry.reject(new Error('AI 抠图已取消'));
  pending.clear();
}

/** 查询服务端模型就绪状态。 */
export async function fetchCutoutStatus() {
  const response = await fetch('/api/cutout/health');
  if (!response.ok) throw new Error(`读取抠图模型状态失败（HTTP ${response.status}）`);
  return response.json();
}
