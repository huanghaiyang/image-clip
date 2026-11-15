/**
 * 进程内后台任务
 * --------------
 * 慢操作（视频截帧等）不再阻塞 HTTP 请求：先建一个 job 返回给前端，
 * 具体干活由 async 函数在后台跑，过程中反复 `update()` 进度，结束 `finish()`/`fail()`。
 *
 * 约定：
 *  - job 保存在内存里，同时把已完成的历史写入 `cacheFile`（默认 data/cache/jobs-history.json），
 *    这样重启服务后仍能看到「历史任务」，满足任务留存；
 *  - `status`: running | done | failed | cancelled；
 *  - `progress` 0~1，`detail` 给前端展示的短文本；
 *  - 前端通过 GET /api/jobs 轮询，按 id 去重后驱动右下角通知气泡与任务面板。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function createJobManager({ max = 50, cacheFile = '' } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  let seq = 0;
  let saveTimer = null;
  let loaded = false;

  function prune() {
    if (jobs.size <= max) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    while (jobs.size > max && finished.length) {
      jobs.delete(finished.shift().id);
    }
  }

  async function persist() {
    if (!cacheFile) return;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      const items = list().slice(0, max);
      await fs.writeFile(cacheFile, JSON.stringify({ version: 1, jobs: items }));
    } catch (err) {
      console.warn('[jobs] 历史任务写入失败:', err.message);
    }
  }

  function schedulePersist() {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 800);
    saveTimer.unref?.();
  }

  /** 启动时把上次的历史读回来（只恢复已结束的任务）。 */
  async function init() {
    if (loaded || !cacheFile) return;
    loaded = true;
    try {
      const raw = await fs.readFile(cacheFile, 'utf8');
      const data = JSON.parse(raw);
      for (const job of data?.jobs ?? []) {
        if (!job?.id || job.status === 'running') continue;
        jobs.set(job.id, { ...job, seq: Number(job.seq) || ++seq });
      }
    } catch {
      // 首次运行 / 文件损坏：忽略
    }
  }

  function create({ type, label = '', meta = null } = {}) {
    const order = ++seq;
    const id = `job-${Date.now().toString(36)}-${order.toString(36)}`;
    const job = {
      id,
      seq: order,
      type,
      label,
      meta,
      status: 'running',
      progress: 0,
      detail: '',
      result: null,
      error: '',
      startedAt: Date.now(),
      finishedAt: 0,
    };
    jobs.set(id, job);
    prune();
    return job;
  }

  function get(id) {
    return jobs.get(String(id ?? '')) ?? null;
  }

  function update(id, patch = {}) {
    const job = get(id);
    if (!job) return null;
    if (patch.progress != null) {
      const value = Number(patch.progress);
      if (Number.isFinite(value)) job.progress = Math.max(0, Math.min(1, value));
    }
    if (patch.detail != null) job.detail = String(patch.detail);
    if (patch.meta != null) job.meta = { ...(job.meta ?? {}), ...patch.meta };
    return job;
  }

  function finish(id, result = null) {
    const job = get(id);
    if (!job || job.status !== 'running') return job ?? null;
    job.status = 'done';
    job.progress = 1;
    job.result = result;
    job.finishedAt = Date.now();
    job.detail = job.detail || '已完成';
    schedulePersist();
    return job;
  }

  function fail(id, error) {
    const job = get(id);
    if (!job || job.status !== 'running') return job ?? null;
    job.status = 'failed';
    job.error = String(error?.message ?? error ?? '任务失败');
    job.finishedAt = Date.now();
    job.detail = job.error;
    schedulePersist();
    return job;
  }

  function cancel(id) {
    const job = get(id);
    if (!job || job.status !== 'running') return job ?? null;
    job.cancelled = true;
    job.detail = '正在取消…';
    return job;
  }

  function list({ active = false } = {}) {
    const items = [...jobs.values()];
    return (active ? items.filter((job) => job.status === 'running') : items)
      .sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq);
  }

  return { init, create, get, update, finish, fail, cancel, list, persist };
}
