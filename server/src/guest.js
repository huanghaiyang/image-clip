/**
 * 临时用户（匿名会话）
 * --------------------
 * 多人同时使用同一个资源库时，不需要登录/注册：
 *  - 浏览器为每个标签页生成一个随机 `X-Client-Id`（客户端存 sessionStorage）；
 *  - 服务端只把它当成「临时用户标识」，用于隔离任务列表、任务日志与工作区现场；
 *  - 资源库、回收站、指纹索引是所有临时用户共享的（同一个团队媒体库）；
 *  - 没有 header 的请求（curl、脚本、老客户端）落到 `guest-local`，行为与单用户一致。
 *
 * 注意：这不是安全机制——知道别人的 client id 就能查到对方任务；
 * 它解决的是「多人共用一台机器/一个服务时工作区与任务不要互相混淆」。
 */

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NAME_MAX = 32;

function decodeName(value) {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, NAME_MAX);
}

export function guestFromRequest(req) {
  const raw = String(req.headers?.['x-client-id'] ?? '').trim();
  const id = ID_RE.test(raw) ? raw : 'guest-local';
  const fallbackName = `临时用户-${id.slice(-4).toUpperCase()}`;
  const name = sanitizeName(decodeName(req.headers?.['x-client-name'])) || fallbackName;
  return { id, name, role: 'member', guest: true, local: id === 'guest-local' };
}

export function guestMiddleware() {
  return (req, _res, next) => {
    req.user = guestFromRequest(req);
    next();
  };
}
