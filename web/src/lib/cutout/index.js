/**
 * AI 抠图客户端（主线程）：管理 Worker 池与请求。
 *
 * 模型推理在 Worker 里跑，多个素材可以并行；每个 Worker 内部仍然串行，
 * 因此并发度 = Worker 数量。默认按 CPU 核心数取 2（模型内存占用较大，
 * 不适合开太多），算力小的机器自动退化为 1。
 */
const poolSize = (() => {
  const cores = Number(navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(2, Math.floor(cores / 2)));
})();

/** 每个 worker 的当前排队/执行中的请求数，用来把新任务分给最闲的那个。 */
const workers = [];
let sequence = 0;
const pending = new Map();

/** 当前并发度（1 = 串行）。批量抠图可以按它决定同时处理几张。 */
export function cutoutConcurrency() {
  return poolSize;
}

function createWorker() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const entry = { worker, load: 0, closed: false };

  worker.onmessage = (event) => {
    const { id } = event.data;
    const task = pending.get(id);
    if (!task) return;
    if (event.data.type === 'progress') {
      task.onProgress?.(event.data);
      return;
    }
    pending.delete(id);
    entry.load = Math.max(0, entry.load - 1);
    if (event.data.type === 'error') {
      task.reject(new Error(event.data.message));
      return;
    }
    task.resolve({
      alpha: event.data.alpha,
      width: event.data.width,
      height: event.data.height,
      elapsedMs: event.data.elapsedMs,
    });
  };

  worker.onerror = (event) => {
    // 单个 Worker 崩溃时只影响它自己的任务，其余 Worker 继续工作
    const err = new Error(event.message || 'AI 抠图 Worker 运行失败');
    for (const [id, task] of pending) {
      if (task.worker !== entry) continue;
      pending.delete(id);
      task.reject(err);
    }
    entry.closed = true;
    entry.worker.terminate();
    const index = workers.indexOf(entry);
    if (index >= 0) workers.splice(index, 1);
  };

  workers.push(entry);
  return entry;
}

/** 优先复用空闲 Worker，没有空闲且未达并发上限时再新建一个。 */
function pickWorker() {
  let best = null;
  for (const entry of workers) {
    if (entry.closed) continue;
    if (entry.load === 0) return entry;
    if (!best || entry.load < best.load) best = entry;
  }
  if (workers.length < poolSize) return createWorker();
  return best ?? createWorker();
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
  const entry = pickWorker();
  const id = ++sequence;
  entry.load += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress, worker: entry });
    try {
      entry.worker.postMessage({ id, modelId, rgba, width, height }, [rgba.buffer]);
    } catch (err) {
      pending.delete(id);
      entry.load = Math.max(0, entry.load - 1);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** 释放全部 Worker（切换工作区时可调用；模型缓存仍保留在 Cache Storage）。 */
export function disposeCutoutWorker() {
  for (const entry of workers) entry.worker.terminate();
  workers.length = 0;
  for (const task of pending.values()) task.reject(new Error('AI 抠图已取消'));
  pending.clear();
}

/** 查询服务端模型就绪状态。 */
export async function fetchCutoutStatus() {
  const response = await fetch('/api/cutout/health');
  if (!response.ok) throw new Error(`读取抠图模型状态失败（HTTP ${response.status}）`);
  return response.json();
}
