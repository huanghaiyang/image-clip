/**
 * HTTP 访问 / 错误日志
 * --------------------
 * - 每个 /api 请求一条结构化访问日志（requestId、方法、路径、状态、耗时、用户）；
 * - 4xx 记 warn，5xx 记 error；错误处理中间件额外记 error（带堆栈）；
 * - 慢请求（默认 >2s）单独标记 slow:true；
 * - 响应头返回 X-Request-Id，便于把前端错误和后端请求对上。
 */
import crypto from 'node:crypto';

function requestId(req) {
  const fromHeader = String(req.headers['x-request-id'] ?? '').trim();
  if (/^[A-Za-z0-9._-]{6,80}$/.test(fromHeader)) return fromHeader;
  return `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function createAccessLogger({ logger, slowMs = 2000, skip = () => false, quietGets = [] } = {}) {
  return function accessLogger(req, res, next) {
    if (!req.path.startsWith('/api/') || skip(req)) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    const id = requestId(req);
    req.requestId = id;
    res.setHeader('X-Request-Id', id);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const status = res.statusCode;
      // 轮询 / 缩略图 / 视频流这类高频 GET 只写 debug，避免日志被刷屏；
      // 出错时仍按 warn/error 正常记录。
      const quiet = req.method === 'GET' && quietGets.some((pattern) => pattern.test(req.path));
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : quiet ? 'debug' : 'info';
      const data = {
        requestId: id,
        method: req.method,
        path: req.path,
        status,
        ms: Math.round(ms),
        slow: ms >= slowMs || undefined,
        user: req.user?.id ?? null,
        guestName: req.user?.name ?? null,
        ip: req.ip ?? null,
        bytes: Number(res.getHeader('content-length')) || undefined,
        queryKeys: Object.keys(req.query ?? {}).slice(0, 20),
      };
      if (res.locals.errorInfo) {
        data.errorCode = res.locals.errorInfo.code;
        data.errorMessage = res.locals.errorInfo.message;
      }
      logger[level]('http', `${req.method} ${req.path} ${status}`, data);
    });

    next();
  };
}

export function logHttpError(logger, err, req, { status, code, message } = {}) {
  const data = {
    requestId: req.requestId ?? null,
    method: req.method,
    path: req.path,
    status,
    code,
    message,
    userId: req.user?.id ?? null,
    ip: req.ip ?? null,
  };
  if (status >= 500) {
    data.stack = String(err?.stack ?? '').slice(0, 8000);
    logger.error('http', `请求异常 ${req.method} ${req.path}`, data);
  } else {
    logger.warn('http', `请求失败 ${req.method} ${req.path}`, data);
  }
}

const CLIENT_LEVELS = new Set(['error', 'warn', 'info']);

/** 校验 / 截断浏览器上报的错误，避免日志被超大或畸形负载撑爆。 */
export function sanitizeClientEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const message = String(body.message ?? '').trim().slice(0, 600);
  if (!message) return null;
  const number = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);
  return {
    level: CLIENT_LEVELS.has(body.level) ? body.level : 'error',
    message,
    stack: String(body.stack ?? '').slice(0, 6000),
    url: String(body.url ?? '').slice(0, 600),
    source: String(body.source ?? '').slice(0, 300),
    line: number(body.line),
    column: number(body.column),
    kind: String(body.kind ?? 'unknown').slice(0, 40),
    userAgent: String(body.userAgent ?? '').slice(0, 300),
    appVersion: String(body.appVersion ?? '').slice(0, 40),
  };
}
