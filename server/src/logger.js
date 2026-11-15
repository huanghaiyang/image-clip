/**
 * 日志系统（应用日志 + 任务日志）
 * ------------------------------
 * 需求：日志长久留存、支持拆分。
 *
 * 落盘结构（默认 `data/logs`）：
 *
 *   logs/
 *     app-2026-01-02.jsonl          应用日志，按天拆分
 *     app-2026-01-02.1.jsonl        同一天超过 maxBytes 后按大小再拆（.1/.2/...）
 *     jobs/
 *       2026-01-02/
 *         job-xxx.jsonl             单个任务的完整日志
 *       jobs-2026-01-02.jsonl       当天所有任务日志的汇总（按天拆分）
 *
 * - JSONL：一行一个 JSON，便于 tail / grep / 导入；
 * - 保留天数可配（默认应用 14 天、任务 30 天），启动与每天定时清理；
 * - 写入串行化，避免并发 append 交错；写失败只告警一次，不影响主流程。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function pad(value) {
  return String(value).padStart(2, '0');
}

function dayStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp ?? ''));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function removeOlderThan(dir, days, { keep = () => true } = {}) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await listFiles(dir)) {
    if (!keep(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(file);
        removed += 1;
      }
    } catch {
      /* 文件可能刚被删掉 */
    }
  }
  return removed;
}

export function createLogger({
  dir = path.join(process.cwd(), 'data', 'logs'),
  minLevel = 'info',
  maxBytes = 8 * 1024 * 1024,
  retainAppDays = 14,
  retainJobDays = 30,
  now = () => new Date(),
} = {}) {
  const jobRoot = path.join(dir, 'jobs');
  let queue = Promise.resolve();
  let warned = false;
  let initialized = false;
  let sweepTimer = null;

  function enabled(level) {
    return (LEVELS[level] ?? 20) >= (LEVELS[minLevel] ?? 20);
  }

  /** 串行写文件：把任务追加到队列尾部，任何一次失败都不会中断后续日志。 */
  function enqueue(work) {
    queue = queue
      .then(work)
      .catch((err) => {
        if (!warned) {
          warned = true;
          console.warn('[logger] 写入日志失败（后续不再重复提示）:', err.message);
        }
      });
    return queue;
  }

  async function writeLine(file, line) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(line)}\n`);
  }

  /** 同一天超过 maxBytes 时，换到 app-YYYY-MM-DD.N.jsonl。 */
  async function appFileFor(day) {
    const base = path.join(dir, `app-${day}.jsonl`);
    if (maxBytes <= 0) return base;
    let index = 0;
    let file = base;
    while (true) {
      const size = await fileSize(file);
      if (size < maxBytes) return file;
      index += 1;
      file = path.join(dir, `app-${day}.${index}.jsonl`);
      if (index > 999) return file;
    }
  }

  function format(level, scope, message, data) {
    const line = {
      t: now().toISOString(),
      level,
      scope: scope || 'app',
      msg: String(message ?? ''),
    };
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (['t', 'level', 'scope', 'msg'].includes(key)) continue;
        line[key] = value;
      }
    }
    return line;
  }

  async function cleanup() {
    await fs.mkdir(jobRoot, { recursive: true });
    await removeOlderThan(dir, retainAppDays, { keep: (name) => name.startsWith('app-') && name.endsWith('.jsonl') });
    await removeOlderThan(jobRoot, retainJobDays, { keep: (name) => name.startsWith('jobs-') && name.endsWith('.jsonl') });
    // jobs/<day>/ 目录按目录 mtime 清理
    if (retainJobDays > 0) {
      const cutoff = Date.now() - retainJobDays * 24 * 60 * 60 * 1000;
      let days = [];
      try {
        days = (await fs.readdir(jobRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      } catch {
        days = [];
      }
      for (const entry of days) {
        if (!parseDay(entry.name)) continue;
        const sub = path.join(jobRoot, entry.name);
        try {
          // 目录 mtime 可能因为刚写入而变新，逐个文件按时间清理；全部清完再删目录
          const dirStat = await fs.stat(sub);
          if (dirStat.mtimeMs < cutoff) {
            await fs.rm(sub, { recursive: true, force: true });
            continue;
          }
          const files = await listFiles(sub);
          let kept = 0;
          for (const name of files) {
            if (!name.endsWith('.jsonl')) continue;
            const file = path.join(sub, name);
            const stat = await fs.stat(file);
            if (stat.mtimeMs < cutoff) await fs.unlink(file);
            else kept += 1;
          }
          if (kept === 0) await fs.rm(sub, { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  async function init() {
    if (initialized) return;
    initialized = true;
    await fs.mkdir(jobRoot, { recursive: true });
    await cleanup();
    if (!sweepTimer && typeof setInterval === 'function') {
      sweepTimer = setInterval(() => {
        void cleanup();
      }, 24 * 60 * 60 * 1000);
      sweepTimer.unref?.();
    }
  }

  function log(level, scope, message, data) {
    if (!enabled(level)) return;
    const line = format(level, scope, message, data);
    const day = dayStamp(now());
    enqueue(async () => {
      const file = await appFileFor(day);
      await writeLine(file, line);
    });
  }

  const logger = {
    debug: (scope, message, data) => log('debug', scope, message, data),
    info: (scope, message, data) => log('info', scope, message, data),
    warn: (scope, message, data) => log('warn', scope, message, data),
    error: (scope, message, data) => log('error', scope, message, data),
    child: (scope) => ({
      debug: (message, data) => log('debug', scope, message, data),
      info: (message, data) => log('info', scope, message, data),
      warn: (message, data) => log('warn', scope, message, data),
      error: (message, data) => log('error', scope, message, data),
    }),
  };

  /**
   * 写一条任务日志：同时进入「单任务文件」和「当天汇总文件」。
   * 返回 Promise 便于任务结束前 flush。
   */
  function jobLog(jobId, level, scope, message, data = {}) {
    const line = format(level, scope || 'job', message, { jobId, ...data });
    const date = now();
    const day = dayStamp(date);
    const single = path.join(jobRoot, day, `${jobId}.jsonl`);
    const combined = path.join(jobRoot, `jobs-${day}.jsonl`);
    enqueue(async () => {
      await writeLine(single, line);
      await writeLine(combined, line);
    });
    return queue;
  }

  /** 读取文件尾部若干行（默认 200）。 */
  async function tail(file, limit = 200) {
    const max = Math.max(1, Math.min(5000, Number(limit) || 200));
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const slice = lines.slice(-max);
    return { total: lines.length, lines: slice };
  }

  async function listLogs() {
    const app = [];
    for (const name of await listFiles(dir)) {
      if (!name.startsWith('app-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      app.push({ name, bytes: await fileSize(file) });
    }
    const jobDays = [];
    try {
      const entries = await fs.readdir(jobRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const files = [];
          for (const name of await listFiles(path.join(jobRoot, entry.name))) {
            if (!name.endsWith('.jsonl')) continue;
            files.push({ name, bytes: await fileSize(path.join(jobRoot, entry.name, name)) });
          }
          jobDays.push({ day: entry.name, jobs: files.length, files });
        } else if (entry.name.startsWith('jobs-') && entry.name.endsWith('.jsonl')) {
          jobDays.push({ day: entry.name.replace(/^jobs-|\.jsonl$/g, ''), aggregate: entry.name, bytes: await fileSize(path.join(jobRoot, entry.name)) });
        }
      }
    } catch {
      /* 目录还没建 */
    }
    app.sort((a, b) => b.name.localeCompare(a.name));
    jobDays.sort((a, b) => String(b.day).localeCompare(String(a.day)));
    return { dir, retainAppDays, retainJobDays, app, jobDays };
  }

  return {
    init,
    cleanup,
    log,
    jobLog,
    listLogs,
    fileForApp: (date = now()) => path.join(dir, `app-${dayStamp(date)}.jsonl`),
    fileForJob: (jobId, date = now()) => path.join(jobRoot, dayStamp(date), `${jobId}.jsonl`),
    fileForJobDay: (date = now()) => path.join(jobRoot, `jobs-${dayStamp(date)}.jsonl`),
    tailFile: tail,
    /** 等待所有排队日志写完（关闭服务前调用）。 */
    flush: () => queue,
    close: async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      await queue;
    },
    ...logger,
  };
}
