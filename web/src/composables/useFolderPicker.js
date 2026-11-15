/**
 * 资源库目录选择器（单例）
 * ------------------------
 * 需要「选择资源库里的一个文件夹」的地方统一走这里：
 *
 *   const path = await openFolderPicker({ title: '选择关键帧保存位置', value: current, allowRoot: true });
 *   if (path !== null) actions.setOption('dir', path);
 *
 * 返回相对资源库根目录的 POSIX 路径（根目录为 ''）；用户取消返回 null。
 * 之前这些位置是手填的字符串，容易打错、也不会校验目录是否存在，现在改成树形选择。
 */
import { reactive } from 'vue';

const state = reactive({
  open: false,
  title: '选择保存位置',
  detail: '',
  value: '',
  allowRoot: true,
});

let resolver = null;

export function openFolderPicker({ title = '选择保存位置', detail = '', value = '', allowRoot = true } = {}) {
  // 同一时间只允许一个选择器：上一次未完成的会被当作取消
  resolver?.(null);
  state.open = true;
  state.title = title;
  state.detail = detail;
  state.value = String(value ?? '');
  state.allowRoot = allowRoot !== false;
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

function settle(path) {
  const resolve = resolver;
  resolver = null;
  state.open = false;
  resolve?.(path);
}

/** 用户确认选择（path 为资源库相对路径，根目录用 ''）。 */
export function submitFolder(path) {
  settle(String(path ?? ''));
}

export function cancelFolderPicker() {
  settle(null);
}

export function useFolderPicker() {
  return { state, actions: { open: openFolderPicker, submit: submitFolder, cancel: cancelFolderPicker } };
}
