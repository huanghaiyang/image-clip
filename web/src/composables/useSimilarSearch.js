/**
 * 相似资源检索（智能识图）的共享状态
 * ---------------------------------
 *  - `openWith(entry)`：以资源库里某张图为查询做检索；
 *  - `openBlank()`：打开空面板，让用户拖入 / 粘贴 / 选择一张图做“以图搜图”；
 *  - 结果点击后直接在资源库里定位并选中，双击再打开预览。
 *
 * 指纹在服务端本地计算（dHash），不上传任何第三方服务。
 */
import { reactive } from 'vue';

import { fetchSimilarByImage, fetchSimilarByPath } from '../lib/library.js';
import { rankSimilarResults, summarizeSimilar } from '../lib/similar.js';
import { setMode } from './useAppMode.js';
import { useLibrary } from './useLibrary.js';

const state = reactive({
  open: false,
  /** 查询图：{ kind:'path', entry } 或 { kind:'file', name, blob, url } */
  query: null,
  loading: false,
  error: '',
  results: [],
  meta: null,
  summary: '',
});

let seq = 0;

function clearResults() {
  state.results = [];
  state.meta = null;
  state.summary = '';
  state.error = '';
}

function revokeQueryUrl() {
  if (state.query?.kind === 'file' && state.query.url) {
    URL.revokeObjectURL(state.query.url);
    state.query.url = '';
  }
}

async function runSearch(load) {
  const mine = ++seq;
  state.loading = true;
  state.error = '';
  try {
    const payload = await load();
    if (mine !== seq) return payload;
    const results = rankSimilarResults(payload?.results ?? []);
    state.results = results;
    state.meta = {
      totalImages: payload?.totalImages ?? 0,
      indexed: payload?.indexed ?? 0,
      indexing: Boolean(payload?.indexing),
      queued: payload?.queued ?? 0,
    };
    state.summary = summarizeSimilar({ ...payload, results });
    return payload;
  } catch (err) {
    if (mine === seq) {
      state.error = err.message || '检索失败';
      state.results = [];
      state.meta = null;
      state.summary = '';
    }
    return null;
  } finally {
    if (mine === seq) state.loading = false;
  }
}

/** 以资源库里的图片为查询。 */
export async function searchByEntry(entry, { limit = 60, minScore = 0.55 } = {}) {
  if (!entry?.path) return null;
  revokeQueryUrl();
  state.query = { kind: 'path', entry, hash: '' };
  const payload = await runSearch(() => fetchSimilarByPath(entry.path, { limit, minScore }));
  if (payload?.query?.hash && state.query?.kind === 'path') state.query.hash = payload.query.hash;
  return payload;
}

/** 以一张本地图片（拖入 / 粘贴 / 文件选择）为查询，做“以图搜图”。 */
export async function searchByFile(blob, name = 'query.png', { limit = 60, minScore = 0.55 } = {}) {
  if (!blob) return null;
  revokeQueryUrl();
  state.query = { kind: 'file', name, blob, url: URL.createObjectURL(blob), hash: '' };
  const payload = await runSearch(() => fetchSimilarByImage(blob, { fileName: name, limit, minScore }));
  if (payload?.query?.hash && state.query?.kind === 'file') state.query.hash = payload.query.hash;
  return payload;
}

export function openSimilarWith(entry) {
  state.open = true;
  if (entry?.kind === 'image') {
    void searchByEntry(entry);
    return;
  }
  state.query = null;
  revokeQueryUrl();
  clearResults();
}

export function openSimilarBlank() {
  state.open = true;
  state.query = null;
  revokeQueryUrl();
  clearResults();
}

export function closeSimilar() {
  state.open = false;
  seq += 1; // 关掉后到达的响应当作过期
  state.loading = false;
}

/**
 * 在资源库里定位并选中某个结果。
 * 先把搜索词清掉：结果文件不一定匹配当前搜索词，否则“定位”后列表里根本看不到它。
 */
function focusResult(result) {
  if (!result?.path) return false;
  const { actions } = useLibrary();
  setMode('library');
  actions.setSearch('');
  actions.setDir(result.dir ?? '');
  actions.setSelection([result.path]);
  return true;
}

export function revealSimilarResult(result) {
  if (!focusResult(result)) return;
  closeSimilar();
}

/** 定位并打开预览。 */
export function openSimilarResult(result) {
  if (!focusResult(result)) return;
  const { actions } = useLibrary();
  actions.openPreview(result.path);
  closeSimilar();
}

export function useSimilarSearch() {
  return {
    state,
    actions: { openWith: openSimilarWith, openBlank: openSimilarBlank, close: closeSimilar, searchByFile, searchByEntry, revealResult: revealSimilarResult, openResult: openSimilarResult },
  };
}
