/**
 * 全局重命名弹窗状态（单例）
 * --------------------------
 * 资源库卡片、树形行、左侧目录树等位置只需要调用 openRenamePrompt(item)，
 * 弹窗内部统一走 useLibrary.renameOne —— 文件和文件夹共用同一套关联迁移逻辑。
 */
import { reactive, readonly } from 'vue';

const state = reactive({
  open: false,
  path: '',
  name: '',
  isFolder: false,
});

function open(item, isFolder = false) {
  if (!item?.path) return; // 资源库根目录不支持改名
  state.open = true;
  state.path = item.path;
  state.name = item.name ?? item.path.split('/').pop() ?? '';
  state.isFolder = Boolean(isFolder);
}

function close() {
  state.open = false;
}

export function useRenamePrompt() {
  return { state: readonly(state), actions: { open, close } };
}
