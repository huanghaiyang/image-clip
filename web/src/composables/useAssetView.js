/**
 * 左侧素材面板的界面现场（随临时会话保存）
 * ---------------------------------------
 * 会话恢复时除了素材本身，还要回到“上次看到的位置”：
 *  - 停在「当前素材」还是「资源库」；
 *  - 资源库搜索关键字；
 *  - 两个列表各自的滚动位置（分开存，切 tab 不会互相覆盖）。
 *
 * 只放界面状态，不放素材数据；素材 / 勾选 / 当前选中项由 useWorkspace 的会话负责。
 */
import { reactive } from 'vue';

const state = reactive({
  /** 'workspace' | 'library' | null（null = 还没决定，按素材是否为空自动选） */
  tab: null,
  keyword: '',
  scrollTop: { workspace: 0, library: 0 },
});

function normalizeTab(value) {
  return value === 'workspace' || value === 'library' ? value : null;
}

function normalizeScrollTop(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/** 供 useAssetPanel 绑定；写 state 就是持久化的那个现场。 */
export function useAssetView() {
  return { state };
}

export function exportAssetView() {
  return {
    tab: state.tab ?? '',
    keyword: state.keyword ?? '',
    scrollTop: {
      workspace: normalizeScrollTop(state.scrollTop.workspace),
      library: normalizeScrollTop(state.scrollTop.library),
    },
  };
}

export function importAssetView(doc) {
  if (!doc || typeof doc !== 'object') return;
  state.tab = normalizeTab(doc.tab);
  state.keyword = typeof doc.keyword === 'string' ? doc.keyword : '';
  const scroll = doc.scrollTop && typeof doc.scrollTop === 'object' ? doc.scrollTop : {};
  state.scrollTop.workspace = normalizeScrollTop(scroll.workspace);
  state.scrollTop.library = normalizeScrollTop(scroll.library);
}

/** 清空会话时复位，避免新建会话还带着旧列表位置。 */
export function resetAssetView() {
  state.tab = null;
  state.keyword = '';
  state.scrollTop.workspace = 0;
  state.scrollTop.library = 0;
}
