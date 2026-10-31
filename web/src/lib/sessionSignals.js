/**
 * 临时会话的“脏信号”总线
 * -----------------------
 * 有些工作区状态（橡皮擦画布、像素画布、水印掩膜、背景去除参数）藏在
 * composable 的私有 entries 里，外面既 watch 不到，也不适合让会话层去遍历。
 * 这些模块在关键动作后调用 markSessionDirty(scope)，由 useWorkSession 统一
 * 防抖落盘，避免每个模块各写一套保存逻辑。
 */
const listeners = new Set();
let suspended = 0;

export function markSessionDirty(scope) {
  if (suspended || !scope) return;
  for (const listener of listeners) listener(scope);
}

export function onSessionDirty(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 恢复会话期间暂停脏信号：导入动作本身会触发大量状态变化，
 * 若逐个记脏会造成无意义的重复保存。
 */
export function suspendSessionSignals() {
  suspended += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspended = Math.max(0, suspended - 1);
  };
}
