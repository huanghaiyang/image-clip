/**
 * 并发限流（保护 CPU / 内存密集接口）
 * -----------------------------------
 * sharp 解码、ffmpeg、模型推理都吃 CPU/内存；如果几百个请求同时打进来，
 * 进程会被拖死（延迟飙升、OOM、甚至整个服务不可用）。
 *
 * 这里实现一个有界并发闸门：
 *  - 同时最多 `concurrency` 个请求在处理（默认 CPU 核数-1，至少 2）；
 *  - 排队最多 `queueLimit` 个，再多直接返回 503 + Retry-After，让客户端退避；
 *  - 统计 active / queued / rejected，暴露到 /api/health 便于观察。
 *
 * 仅用于「重接口」，轻量的列表/元数据/静态资源不受影响。
 */
import os from 'node:os';

export function createLimiter({ name = 'heavy', concurrency, queueLimit = 200, logger = null } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || Math.max(2, os.cpus().length - 1)));
  const maxQueue = Math.max(1, Math.floor(Number(queueLimit) || 200));
  let active = 0;
  let rejected = 0;
  const waiters = [];

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  /** Express 中间件：拿到槽位后放行，响应结束自动释放。 */
  function middleware() {
    return (req, res, next) => {
      const run = () => {
        active += 1;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          release();
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
      };

      if (active < limit) {
        run();
        return;
      }
      if (waiters.length >= maxQueue) {
        rejected += 1;
        logger?.warn?.('limiter', '拒绝重请求（队列已满）', { name, queue: waiters.length, path: req.path });
        res.set('Retry-After', '2');
        res.status(503).json({
          error: { code: 'BUSY', message: '服务器繁忙，请稍后重试' },
        });
        return;
      }
      waiters.push(run);
    };
  }

  function stats() {
    return { name, concurrency: limit, queueLimit: maxQueue, active, queued: waiters.length, rejected };
  }

  /** 供非 Express 场景手动占槽（比如任务处理器内部）。 */
  async function acquire() {
    if (active >= limit) {
      await new Promise((resolve) => waiters.push(resolve));
    } else {
      active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  return { middleware, stats, acquire, name };
}

/** 全局限流器集合：按用途分开，避免缩略图把视频截帧的槽位占满。 */
export function createLimiters({ logger = null } = {}) {
  const cpuCount = os.cpus().length;
  return {
    image: createLimiter({ name: 'image', concurrency: Math.max(2, cpuCount - 1), queueLimit: 120, logger }),
    thumbnail: createLimiter({ name: 'thumbnail', concurrency: Math.max(4, cpuCount), queueLimit: 400, logger }),
    video: createLimiter({ name: 'video', concurrency: 2, queueLimit: 20, logger }),
    stats() {
      return {
        image: this.image.stats(),
        thumbnail: this.thumbnail.stats(),
        video: this.video.stats(),
      };
    },
  };
}
