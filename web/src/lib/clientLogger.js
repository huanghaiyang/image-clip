/**
 * 浏览器错误上报
 * --------------
 * 捕获 window.onerror / unhandledrejection，去重限流后 POST 到 /api/logs/client，
 * 由服务端写入同一天的 app-*.jsonl（scope=client），方便和后端接口日志对照。
 *
 * 只做错误上报，不采集用户操作或页面内容；请求本身失败时静默丢弃，避免上报循环。
 */
const ENDPOINT = '/api/logs/client';
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const DEDUPE_MS = 8_000;

let installed = false;
const recent = [];
const seen = new Map();

function shouldReport(key) {
  const now = Date.now();
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_PER_WINDOW) return false;
  const last = seen.get(key) ?? 0;
  if (now - last < DEDUPE_MS) return false;
  seen.set(key, now);
  if (seen.size > 200) {
    for (const [oldKey, at] of seen) if (now - at > WINDOW_MS) seen.delete(oldKey);
  }
  recent.push(now);
  return true;
}

function post(payload) {
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 上报失败不影响页面 */
  }
}

/** 手动上报（供 try/catch 中调用）。 */
export function reportClientError(error, context = {}) {
  if (typeof window === 'undefined') return;
  const err = error instanceof Error ? error : new Error(String(error?.message ?? error ?? '未知错误'));
  const message = String(context.message ?? err.message ?? '未知错误').slice(0, 600);
  if (!message) return;
  if (/ResizeObserver loop/i.test(message)) return;
  const key = `${context.kind ?? 'manual'}|${message}`;
  if (!shouldReport(key)) return;
  post({
    level: context.level ?? 'error',
    kind: context.kind ?? 'manual',
    message,
    stack: String(err.stack ?? '').slice(0, 6000),
    url: `${location.pathname}${location.search}`.slice(0, 600),
    source: context.source ?? '',
    line: context.line ?? null,
    column: context.column ?? null,
    userAgent: navigator.userAgent,
  });
}

export function installClientErrorLogging() {
  if (installed || typeof window === 'undefined') return installed;
  installed = true;

  window.addEventListener('error', (event) => {
    // 资源加载错误（img/script）没有 error 对象，也记一条，排除第三方扩展产生的 noise
    const target = event.target;
    if (!event.error && target && target !== window) {
      const tag = target.tagName?.toLowerCase?.() ?? 'resource';
      reportClientError(new Error(`${tag} 资源加载失败`), {
        kind: 'resource',
        source: target.src || target.href || '',
        message: `${tag} 资源加载失败：${String(target.src || target.href || '').slice(0, 300)}`,
      });
      return;
    }
    reportClientError(event.error ?? new Error(event.message || 'window.onerror'), {
      kind: 'window-error',
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : new Error(String(reason?.message ?? reason ?? '未处理的 Promise 拒绝'));
    reportClientError(error, { kind: 'unhandledrejection', message: error.message });
  });

  return installed;
}
