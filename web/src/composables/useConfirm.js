/**
 * 全局确认弹窗（单例）
 * --------------------
 * 用应用内的 ConfirmDialog 替代 window.confirm：
 *  - `confirm(options)` 返回 Promise<boolean>，用法与原生 confirm 接近；
 *  - 同一时间只显示一个弹窗，后发起的请求会让前一个以「取消」结束；
 *  - 支持标题、正文、补充说明、按钮文案与危险操作样式。
 */
import { reactive, readonly } from 'vue';

const state = reactive({
  open: false,
  title: '',
  message: '',
  detail: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
});

let resolver = null;

function settle(value) {
  state.open = false;
  const resolve = resolver;
  resolver = null;
  resolve?.(value);
}

function accept() {
  if (!state.open) return;
  settle(true);
}

function cancel() {
  if (!state.open) return;
  settle(false);
}

/**
 * @param {{title?:string,message?:string,detail?:string,confirmText?:string,cancelText?:string,danger?:boolean}} [options]
 * @returns {Promise<boolean>} 用户确认返回 true，取消或关闭返回 false
 */
export function confirm(options = {}) {
  return new Promise((resolve) => {
    // 前一个确认框还没结束就被新请求覆盖时，按取消处理，避免 Promise 悬挂
    if (resolver) {
      const previous = resolver;
      resolver = null;
      previous(false);
    }
    state.title = options.title || '请确认操作';
    state.message = options.message || '';
    state.detail = options.detail || '';
    state.confirmText = options.confirmText || '确定';
    state.cancelText = options.cancelText || '取消';
    state.danger = Boolean(options.danger);
    state.open = true;
    resolver = resolve;
  });
}

export function useConfirm() {
  return { state: readonly(state), actions: { accept, cancel }, confirm };
}
