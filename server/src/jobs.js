/**
 * 后台任务管理器（多用户 + 并发受控 + 日志留存）
 * ---------------------------------------------
 * - 所有长任务都走 `jobs.run(spec, handler)`：先入队，由管理器按 `concurrency`
 *   控制同时运行的数量；同一用户默认最多 3 个（排队 + 运行），防止一个用户打满；
 * - 任务状态：queued → running → done | failed | cancelled；排队时返回 queuePosition；
 * - 每个任务有独立日志文件（logger.jobLog），并把状态变化写进应用日志；
 * - 已完成任务持久化到 `cacheFile`（重启后历史仍在，保留 max 条）。
 *
 * 兼容旧的 create/finish/fail API：视频等模块可继续自己驱动状态，
 * 但推荐用 run() 以便享受排队、并发限制与日志。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIVE_STATUSES = new Set(['queued', 'running']);

export class JobLimitError extends Error {
  constructor(message, code = 'TOO_MANY_JOBS', status = 429) {
    super(message);
    this.name = 'JobLimitError';
    this.code = code;
    this.status = status;
  }
}

export function createJobManager({
  max = 200,
  cacheFile = '',
  logger = null,
  concurrency = 2,
  maxPerUser = 3,
} = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map();
  /** @type {Array<{job: object, handler: Function}>} */
  let queue = [];
  let running = 0;
  let seq = 0;
  let saveTimer = null;
  let loaded = false;

  function jobLog(job, level, message, data) {
    logger?.jobLog?.(job.id, level, job.type, message, { userId: job.userId ?? null, ...data });
  }

  function prune() {
    if (jobs.size <= max) return;
    const finished = [...jobs.values()]
      .filter((job) => !ACTIVE_STATUSES.has(job.status))
      .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt));
    while (jobs.size > max && finished.length) jobs.delete(finished.shift().id);
  }

  async function persist() {
    if (!cacheFile) return;
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      // 运行中的任务不写进历史（重启后无法恢复现场），只留已结束的
      const items = list().filter((job) => !ACTIVE_STATUSES.has(job.status)).slice(0, max);
      await fs.writeFile(cacheFile, JSON.stringify({ version: 2, jobs: items }));
    } catch (err) {
      logger?.warn?.('jobs', '历史任务写入失败', { error: err.message });
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

  async function init() {
    if (loaded || !cacheFile) return;
    loaded = true;
    try {
      const raw = await fs.readFile(cacheFile, 'utf8');
      const data = JSON.parse(raw);
      for (const job of data?.jobs ?? []) {
        if (!job?.id || ACTIVE_STATUSES.has(job.status)) continue;
        jobs.set(job.id, { ...job, seq: Number(job.seq) || ++seq });
      }
      logger?.info?.('jobs', '已恢复历史任务', { count: jobs.size });
    } catch {
      // 首次运行 / 文件损坏：忽略
    }
  }

  function activeCountFor(userId) {
    let count = 0;
    for (const job of jobs.values()) {
      if (job.userId === userId && ACTIVE_STATUSES.has(job.status)) count += 1;
    }
    return count;
  }

  function refreshQueuePositions() {
    queue.forEach((entry, index) => {
      entry.job.queuePosition = index + 1;
    });
  }

  function createJob({ type, label = '', meta = null, userId = null } = {}) {
    const order = ++seq;
    const id = `job-${Date.now().toString(36)}-${order.toString(36)}`;
    const job = {
      id,
      seq: order,
      type,
      label,
      meta,
      userId,
      status: 'queued',
      progress: 0,
      detail: '',
      result: null,
      error: '',
      queuePosition: 0,
      enqueuedAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
    };
    jobs.set(id, job);
    prune();
    return job;
  }

  function start(entry) {
    const job = entry.job;
    running += 1;
    job.status = 'running';
    job.startedAt = Date.now();
    job.queuePosition = 0;
    logger?.info?.('jobs', '任务开始', { id: job.id, type: job.type, userId: job.userId, label: job.label });
    jobLog(job, 'info', 'started', { meta: job.meta });

    let lastMilestone = -1;
    const ctx = {
      job,
      progress(value, detail = '') {
        const next = Number(value);
        if (Number.isFinite(next)) job.progress = Math.max(0, Math.min(1, next));
        if (detail) job.detail = String(detail);
        const milestone = Math.floor(job.progress * 20);
        if (milestone !== lastMilestone || detail) {
          lastMilestone = milestone;
          jobLog(job, 'debug', 'progress', { progress: job.progress, detail: job.detail });
        }
      },
      log(message, data = {}) {
        jobLog(job, 'info', message, data);
      },
      isCancelled() {
        return Boolean(job.cancelled);
      },
    };

    Promise.resolve()
      .then(() => entry.handler(ctx))
      .then((result) => {
        finishInternal(job, result ?? null);
      })
      .catch((err) => {
        failInternal(job, err);
      })
      .finally(() => {
        running -= 1;
        schedulePersist();
        schedule();
      });
  }

  function schedule() {
    refreshQueuePositions();
    while (running < concurrency && queue.length) {
      const entry = queue.shift();
      start(entry);
    }
  }

  function finishInternal(job, result) {
    if (!ACTIVE_STATUSES.has(job.status)) return job;
    job.finishedAt = Date.now();
    if (job.cancelled) {
      job.status = 'cancelled';
      job.detail = '已取消';
    } else {
      job.status = 'done';
      job.progress = 1;
      job.result = result;
      job.detail = job.detail || '已完成';
    }
    jobLog(job, job.status === 'done' ? 'info' : 'warn', job.status, { detail: job.detail });
    logger?.info?.('jobs', '任务结束', { id: job.id, type: job.type, status: job.status, userId: job.userId, ms: job.finishedAt - job.startedAt });
    return job;
  }

  function failInternal(job, err) {
    if (!ACTIVE_STATUSES.has(job.status)) return job;
    job.status = 'failed';
    job.error = String(err?.message ?? err ?? '任务失败');
    job.finishedAt = Date.now();
    job.detail = job.error;
    jobLog(job, 'error', 'failed', { error: job.error, stack: err?.stack });
    logger?.error?.('jobs', '任务失败', { id: job.id, type: job.type, userId: job.userId, error: job.error });
  }

  /**
   * 提交一个任务：排队或立即执行。返回 job（含 status / queuePosition）。
   * handler 抛错 → failed；返回任意值 → done 的 result。
   */
  function run(spec = {}, handler = () => null) {
    const userId = spec.userId ?? null;
    if (userId != null && activeCountFor(userId) >= maxPerUser) {
      throw new JobLimitError(`每个用户同时最多 ${maxPerUser} 个任务，请等待前面的任务完成`);
    }
    const job = createJob(spec);
    jobLog(job, 'info', 'enqueued', { label: job.label, meta: job.meta });
    if (running < concurrency) {
      start({ job, handler });
    } else {
      queue.push({ job, handler });
      refreshQueuePositions();
    }
    return job;
  }

  function get(id) {
    return jobs.get(String(id ?? '')) ?? null;
  }

  /** 旧接口：只创建任务记录（不执行），由调用方 finish/fail。 */
  function create(spec = {}) {
    const job = createJob(spec);
    job.status = 'running';
    job.startedAt = Date.now();
    jobLog(job, 'info', 'started', { meta: job.meta });
    running += 1;
    return job;
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
    if (!job || !ACTIVE_STATUSES.has(job.status)) return job ?? null;
    running = Math.max(0, running - 1);
    finishInternal(job, result);
    schedulePersist();
    schedule();
    return job;
  }

  function fail(id, error) {
    const job = get(id);
    if (!job || !ACTIVE_STATUSES.has(job.status)) return job ?? null;
    running = Math.max(0, running - 1);
    failInternal(job, error);
    schedulePersist();
    schedule();
    return job;
  }

  function cancel(id) {
    const job = get(id);
    if (!job || !ACTIVE_STATUSES.has(job.status)) return job ?? null;
    job.cancelled = true;
    jobLog(job, 'warn', 'cancelled', { status: job.status });
    if (job.status === 'queued') {
      queue = queue.filter((entry) => entry.job.id !== job.id);
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      job.detail = '已取消（未开始执行）';
      schedulePersist();
    } else {
      job.detail = '正在取消…';
    }
    refreshQueuePositions();
    return job;
  }

  function list({ active = false, userId = undefined, all = false } = {}) {
    let items = [...jobs.values()];
    if (userId !== undefined && !all) items = items.filter((job) => job.userId === userId);
    if (active) items = items.filter((job) => job.status === 'running');
    return items.sort((a, b) => (b.enqueuedAt || b.startedAt) - (a.enqueuedAt || a.startedAt) || b.seq - a.seq);
  }

  /** 供路由/调试：当前并发与排队情况。 */
  function stats() {
    return {
      concurrency,
      maxPerUser,
      running,
      queued: queue.length,
      total: jobs.size,
      active: [...jobs.values()].filter((job) => ACTIVE_STATUSES.has(job.status)).length,
    };
  }

  /** 等待所有任务结束（优雅关闭用，最多等 timeoutMs）。 */
  async function drain(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (stats().active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (stats().active > 0) {
      for (const job of [...jobs.values()]) {
        if (ACTIVE_STATUSES.has(job.status)) cancel(job.id);
      }
    }
  }

  return {
    init,
    run,
    create,
    update,
    finish,
    fail,
    cancel,
    list,
    get,
    stats,
    drain,
    persist,
  };
}
