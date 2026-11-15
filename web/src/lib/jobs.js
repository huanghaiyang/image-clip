/**
 * 后台任务 API 封装（与 server/src/jobs.js 对应）
 */
import { requestJson } from './library.js';

/** 全部任务（含最近完成的）；active=true 只取运行中的。 */
export function fetchJobs({ active = false, all = false } = {}) {
  const params = new URLSearchParams();
  if (active) params.set('active', '1');
  if (all) params.set('all', '1');
  const qs = params.toString();
  return requestJson(`/api/jobs${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
}

/** 任务日志（尾部 N 行）：长任务排查问题用。 */
export function fetchJobLog(id, { limit = 200 } = {}) {
  return requestJson(`/api/jobs/${encodeURIComponent(id)}/log?limit=${limit}`, { cache: 'no-store' });
}

/** 单个任务状态。 */
export function fetchJob(id) {
  return requestJson(`/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
}

/** 请求取消任务（服务端在下一个分片检查并中止）。 */
export function cancelJob(id) {
  return requestJson(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}
