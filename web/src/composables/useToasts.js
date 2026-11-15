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
const DEFAULT_TIMEOUT = { success: 4200, info: 4200, error: 8000, progress: 0 };

const state = reactive({ items: [] });

let seq = 0;
const timers = new Map();

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
  const timer = setTimeout(() => dismiss(toast.id), timeout);
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
    },
    count: computed(() => state.items.length),
  };
}
