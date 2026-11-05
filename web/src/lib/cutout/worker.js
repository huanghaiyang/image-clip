/**
 * AI 抠图 Worker 入口：串行执行推理请求，避免多个模型同时占用内存。
 */
import { segmentRgba } from './engine.js';

let queue = Promise.resolve();

async function handle(message) {
  const { id, modelId, rgba, width, height } = message;
  try {
    const result = await segmentRgba(modelId, rgba, width, height, (progress) => {
      self.postMessage({ id, type: 'progress', ...progress });
    });
    self.postMessage({ id, type: 'done', ...result }, [result.alpha.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message ?? String(err) });
  }
}

self.onmessage = (event) => {
  queue = queue.then(() => handle(event.data)).catch(() => {});
};
