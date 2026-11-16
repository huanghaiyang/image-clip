/**
 * 右下角气泡通知
 * --------------
 * 单例队列：同一时间最多保留 5 条，新的在最上面。
 * 支持「进度型」通知：传同一个 id 反复 push / update 会原地更新（用于后台任务进度），
 * 任务结束时再更新成成功/失败样式并自动消失。
 *
 * 用法：
 *   const { actions } = useToasts();
 *   actions.push({ kind:'success', title:'已保存', message:'xxx.png' });
 *   actions.update('job-1', { kind:'success', title:'截帧完成', timeout:4000 });
 */
import { computed, reactive } from 'vue';

const MAX_TOASTS = 5;
// progress 也兜一个 45s 超时：任务异常结束/事件丢失时不会一直挂在角上
const DEFAULT_TIMEOUT = { success: 4200, info: 4200, error: 8000, progress: 45000 };

const state = reactive({ items: [] });

let seq = 0;
const timers = new Map();
let sweepTimer = 0;

/**
 * 后台标签页会被浏览器节流 setTimeout，导致到点的通知不消失。
 * 用 1s 的轻量扫描兜底，并在页面回到前台时立即清一遍。
 */
function ensureSweep() {
  if (sweepTimer || typeof window === 'undefined') return;
  sweepTimer = setInterval(() => {
    if (!state.items.length) {
      clearInterval(sweepTimer);
      sweepTimer = 0;
      return;
    }
    expireToasts();
  }, 1000);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') expireToasts();
  });
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

function scheduleDismiss(toast) {
  clearTimer(toast.id);
  const timeout = Number(toast.timeout ?? DEFAULT_TIMEOUT[toast.kind] ?? 4000);
  if (!timeout || timeout <= 0) return;
  const timer = setTimeout(() => dismissToast(toast.id), timeout);
  timers.set(toast.id, timer);
}

export function pushToast({ id, kind = 'info', title = '', message = '', detail = '', timeout, action = null } = {}) {
  const toastId = id || `toast-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const existing = state.items.find((item) => item.id === toastId);
  if (existing) {
    Object.assign(existing, { kind, title, message, detail, action });
    if (timeout !== undefined) existing.timeout = timeout;
    scheduleDismiss(existing);
    return existing;
  }
  const toast = {
    id: toastId,
    kind,
    title,
    message,
    detail,
    timeout: timeout ?? DEFAULT_TIMEOUT[kind] ?? 4000,
    createdAt: Date.now(),
    action,
  };
  state.items.unshift(toast);
  ensureSweep();
  if (state.items.length > MAX_TOASTS) {
    const dropped = state.items.splice(MAX_TOASTS);
    for (const item of dropped) clearTimer(item.id);
  }
  scheduleDismiss(toast);
  return toast;
}

export function updateToast(id, patch = {}) {
  const toast = state.items.find((item) => item.id === id);
  if (!toast) return null;
  Object.assign(toast, patch);
  if (patch.timeout === undefined && patch.kind) toast.timeout = DEFAULT_TIMEOUT[patch.kind] ?? 4000;
  scheduleDismiss(toast);
  return toast;
}

export function dismissToast(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  state.items.splice(index, 1);
  clearTimer(id);
  return true;
}

/**
 * 按创建时间清理过期气泡。
 * 浏览器后台会节流 setTimeout，切回来时可能剩一堆"过期未消失"的通知；
 * 轮询里定期扫一遍，保证 toast 不会一直显示。
 */
export function expireToasts(now = Date.now()) {
  for (const toast of [...state.items]) {
    const timeout = Number(toast.timeout ?? DEFAULT_TIMEOUT[toast.kind] ?? 4000);
    if (!timeout || timeout <= 0) continue;
    if (now - (toast.createdAt ?? now) >= timeout) dismissToast(toast.id);
  }
}

export function clearToasts() {
  for (const item of state.items) clearTimer(item.id);
  state.items.splice(0, state.items.length);
}

export function useToasts() {
  return {
    state,
    actions: {
      push: pushToast,
      update: updateToast,
      dismiss: dismissToast,
      clear: clearToasts,
      expire: expireToasts,
    },
    count: computed(() => state.items.length),
  };
}
