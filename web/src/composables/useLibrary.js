/**
 * 资源库状态与动作（单例）
 * ------------------------
 * 数据结构是“扁平文件列表 + 扁平文件夹列表”，由前端按 `dir` / `parent` 组合成树。
 * 这样搜索能跨目录，批量操作也只需要一组相对路径，不用递归遍历 UI 树。
 *
 * 所有路径都是**相对资源库根目录的 POSIX 路径**（例如 `关键帧/视频A/frame-001.png`），
 * 上传、改名、移动、删除都直接把这组路径交给服务端处理。
 */
import { computed, reactive, readonly, shallowRef } from 'vue';

import {
  LibraryApiError,
  createLibraryFolder,
  createLibraryFolders,
  deleteLibraryItems,
  fetchLibraryBlob,
  fetchLibraryDirectory,
  fetchLibraryEntryMeta,
  fetchLibraryTree,
  moveLibraryItems,
  copyLibraryItems,
  renameLibraryItems,
  setLibraryLocks,
  setLibraryMarks,
  restoreLibraryVersion,
  revealLibraryPath,
  uploadLibraryFile,
  uploadBlobToLibrary,
  fetchLibraryDuplicates,
  resolveInPlaceTarget,
} from '../lib/library.js';
import { useWorkspace } from './useWorkspace.js';
import { useConfirm } from './useConfirm.js';
import { pushToast } from './useToasts.js';
import { finishLocalTask, startLocalTask, updateLocalTask } from './useJobs.js';
import { setMode } from './useAppMode.js';
import { movesFromResults, notifyLibraryPathsMoved, remapLibraryPath } from '../lib/pathMoves.js';
import { mapLimit } from '../lib/async.js';

const EMPTY_STATS = { files: 0, folders: 0, images: 0, videos: 0, audios: 0, bytes: 0, truncated: false };

const BROWSE_MODE_KEY = 'image-clip:library-browse-mode';
// 迁移标记带版本号：每次调整默认值时换一个，保证老用户也会落到新默认（只清一次）
const BROWSE_MODE_MIGRATED_KEY = 'image-clip:library-browse-mode-migrated-v3';

/**
 * 资源库主列表的展示方式。
 *
 * 默认平铺（缩略图网格，文件名与预览一眼看清）；用户手动切成树形后记住选择。
 * 上一版的默认值是树形，而且会话恢复会把当时的 'tree' 写进 localStorage，所以做一次
 * 一次性迁移：没有迁移标记时清掉遗留的 'tree'，直接落到新的默认平铺。之后用户再手动
 * 切成树形就会被正常记住。
 */
function initialBrowseMode() {
  try {
    const stored = localStorage.getItem(BROWSE_MODE_KEY);
    if (!localStorage.getItem(BROWSE_MODE_MIGRATED_KEY)) {
      localStorage.setItem(BROWSE_MODE_MIGRATED_KEY, '1');
      if (stored === 'tree') localStorage.removeItem(BROWSE_MODE_KEY);
      return 'flat';
    }
    return stored === 'tree' ? 'tree' : 'flat';
  } catch {
    return 'flat';
  }
}

/**
 * 资源库懒加载分三层：
 *  1. 全库轻量索引（只有名称 / 目录 / stat，不含尺寸与时长）→ 统计、跨目录搜索、树形；
 *  2. 目录内容缓存（list?dir=）→ 进入哪个目录才请求哪个目录；
 *  3. 元数据覆盖层（meta?path=）→ 卡片进入视口后才补尺寸 / 时长。
 */
const libraryIndex = shallowRef({ folders: [], entries: [], stats: { ...EMPTY_STATS }, ready: false });
const dirCache = shallowRef(new Map());
const metaByPath = shallowRef(new Map());
/** 锁定状态覆盖：id -> boolean；接口返回后立即生效，不用整库刷新。 */
const lockOverrides = shallowRef(new Map());
/** 收藏 / 标记覆盖：id -> { favorite?, mark? }；接口返回后立即生效。 */
const markOverrides = shallowRef(new Map());

const state = reactive({
  initialized: false,
  loading: false,
  refreshing: false,
  busy: false,
  error: '',
  status: '',
  currentDir: '',
  search: '',
  kindFilter: 'all', // all | image | video | audio | folder
  /** 状态筛选：all | marked | favorite | locked（“显示标记”等）。 */
  markFilter: 'all',
  sort: 'name', // name | kind | mtime | size
  browseMode: initialBrowseMode(), // flat | tree
  selected: [], // 相对路径数组，可包含文件夹
  previewPath: null,
  indexLoading: false,
  indexReady: false,
  dirLoading: false,
  upload: { active: false, name: '', percent: 0, index: 0, total: 0, skipped: [], failed: [] },
  // 同目录查重结果：dir 与当前目录不一致时自动失效（只做高亮标记）
  duplicates: { dir: '', scanning: false, groups: [] },
});

/** 已知文件 = 轻量索引 + 已加载目录，再叠加按需补全的元数据。 */
/**
 * 把锁定 / 收藏 / 标记的本地覆盖叠加到条目上。
 * 所有展示列表（当前目录、搜索、树形、预览）都必须经过这里，
 * 否则接口成功后只有刷新才会重新拉服务端状态。
 */
function withStatusOverrides(list) {
  const overrides = lockOverrides.value;
  const markPatches = markOverrides.value;
  if (!overrides.size && !markPatches.size) return list;
  return list.map((entry) => {
    const locked = overrides.get(entry.id);
    const marks = markPatches.get(entry.id);
    if (locked === undefined && !marks) return entry;
    return { ...entry, ...(locked === undefined ? {} : { locked }), ...(marks ?? {}) };
  });
}

const entries = computed(() => {
  if (!libraryIndex.value.ready && dirCache.value.size === 0) return [];
  const map = new Map();
  for (const entry of libraryIndex.value.entries) map.set(entry.path, entry);
  for (const bucket of dirCache.value.values()) {
    for (const entry of bucket.entries) map.set(entry.path, entry);
  }
  const list = [...map.values()];
  const withMeta = !metaByPath.value.size
    ? list
    : list.map((entry) => {
        const info = metaByPath.value.get(entry.path);
        return info ? { ...entry, ...info } : entry;
      });
  return withStatusOverrides(withMeta);
});

const folders = computed(() => {
  const map = new Map();
  for (const folder of libraryIndex.value.folders) map.set(folder.path, folder);
  for (const bucket of dirCache.value.values()) {
    for (const folder of bucket.folders) map.set(folder.path, folder);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
});

const stats = computed(() => libraryIndex.value.stats ?? EMPTY_STATS);

const folderTree = computed(() => {
  const root = { path: '', name: '资源库', parent: null, depth: -1, isRoot: true };
  return [root, ...folders.value];
});

const currentFolders = computed(() => {
  if (state.search.trim()) return [];
  const cached = dirCache.value.get(state.currentDir);
  const list = cached ? cached.folders : folders.value.filter((folder) => folder.parent === state.currentDir);
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
});

/** 状态筛选：锁定 / 收藏 / 已标记。 */
function matchesMarkFilter(entry) {
  switch (state.markFilter) {
    case 'marked':
      return Boolean(entry.mark);
    case 'favorite':
      return Boolean(entry.favorite);
    case 'locked':
      return Boolean(entry.locked);
    default:
      return true;
  }
}

/** 统一处理类型过滤、状态筛选与排序。 */
function arrangeEntries(list) {
  let result = list;
  if (state.kindFilter !== 'all' && state.kindFilter !== 'folder') {
    result = result.filter((entry) => entry.kind === state.kindFilter);
  }
  if (state.markFilter !== 'all') {
    result = result.filter(matchesMarkFilter);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  switch (state.sort) {
    case 'kind':
      return [...result].sort((a, b) => a.kind.localeCompare(b.kind) || byName(a, b));
    case 'mtime':
      return [...result].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    case 'size':
      return [...result].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    default:
      return [...result].sort(byName);
  }
}

/** 当前目录下的文件；搜索时跨目录（依赖后台补全的轻量索引）。 */
const currentEntries = computed(() => {
  const keyword = state.search.trim().toLowerCase();
  // 统一从 entries 取（已叠加元数据 + 锁定/收藏/标记覆盖）：
  // 之前平铺视图直接读 dirCache，导致接口成功后状态要刷新才生效。
  const base = keyword
    ? entries.value.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.path.toLowerCase().includes(keyword))
    : entries.value.filter((entry) => entry.dir === state.currentDir);
  return arrangeEntries(base);
});

const selectedEntries = computed(() => {
  const set = new Set(state.selected);
  return entries.value.filter((entry) => set.has(entry.path));
});

const selectedFolders = computed(() => {
  const set = new Set(state.selected);
  return folders.value.filter((folder) => set.has(folder.path));
});

const previewEntry = computed(() => entries.value.find((entry) => entry.path === state.previewPath) ?? null);
const previewList = computed(() => {
  const keyword = state.search.trim().toLowerCase();
  let list = entries.value;
  if (keyword) {
    // 与列表搜索保持一致：文件名和路径都参与匹配
    list = list.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.path.toLowerCase().includes(keyword));
  } else if (state.browseMode === 'tree') {
    // 树形视图会显示当前目录的整棵子树，预览翻页也跟着这棵子树走
    const root = state.currentDir;
    list = list.filter((entry) => !root || entry.dir === root || entry.dir.startsWith(`${root}/`));
  } else {
    list = list.filter((entry) => entry.dir === state.currentDir);
  }
  if (state.kindFilter !== 'all' && state.kindFilter !== 'folder') {
    list = list.filter((entry) => entry.kind === state.kindFilter);
  }
  if (state.markFilter !== 'all') {
    list = list.filter(matchesMarkFilter);
  }
  return list;
});
const previewIndex = computed(() => {
  if (!previewEntry.value) return -1;
  // 与预览翻页使用同一份列表（目录/搜索/类型筛选后），页码才和实际可翻页数一致
  return previewList.value.findIndex((entry) => entry.path === previewEntry.value.path);
});

const breadcrumbs = computed(() => {
  const parts = state.currentDir ? state.currentDir.split('/') : [];
  const crumbs = [{ name: '资源库', path: '' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
});

const canGoUp = computed(() => Boolean(state.currentDir));

/** 查重结果只在扫描时所在的目录里生效；切换目录后自动隐藏标记。 */
const duplicateGroups = computed(() => (state.duplicates.dir === state.currentDir ? state.duplicates.groups : []));
const duplicatePaths = computed(() => new Set(duplicateGroups.value.flatMap((group) => group.paths)));
/** 路径 → 第几组重复，用于在缩略图上显示组号。 */
const duplicateGroupOf = computed(() => {
  const map = new Map();
  duplicateGroups.value.forEach((group, index) => {
    for (const path of group.paths) map.set(path, index + 1);
  });
  return map;
});

const selectedSummary = computed(() => {
  const files = selectedEntries.value;
  const folderCount = selectedFolders.value.length;
  return {
    files: files.length,
    folders: folderCount,
    bytes: files.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    total: state.selected.length,
  };
});

// --------------------------------------------------------------- 内部工具

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

function preserveSelected() {
  const paths = new Set(entries.value.map((entry) => entry.path));
  const folderPaths = new Set(folders.value.map((folder) => folder.path));
  state.selected = state.selected.filter((p) => paths.has(p) || folderPaths.has(p));
}

function extensionOf(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? name.slice(index) : '';
}

function baseOf(name) {
  const ext = extensionOf(name);
  return ext ? name.slice(0, name.length - ext.length) : String(name);
}

function failedCount(result) {
  return Math.max(0, Number(result?.total ?? 0) - Number(result?.succeeded ?? 0));
}

/**
 * 改名 / 移动成功后同步前端关联状态：
 * 选中项、当前目录、预览路径都可能位于被改名的文件或文件夹之下。
 * 必须在 refreshLibrary 之前调用，否则旧路径会先被“清理选中”过滤掉。
 */
function applyPathMoves(results) {
  const moves = movesFromResults(results);
  if (!moves.length) return [];
  state.selected = [...new Set(state.selected.map((path) => remapLibraryPath(path, moves)))];
  state.currentDir = remapLibraryPath(state.currentDir, moves);
  state.previewPath = remapLibraryPath(state.previewPath, moves);
  notifyLibraryPathsMoved(moves);
  return moves;
}

// --------------------------------------------------------------- 增量更新（避免整页刷新闪烁）

/** 用条目列表重算 stats（与后端 /tree 的统计口径保持一致）。 */
function recomputeStats(list, folders = libraryIndex.value.folders ?? []) {
  return {
    files: list.length,
    folders: folders.length,
    images: list.filter((entry) => entry.kind === 'image').length,
    videos: list.filter((entry) => entry.kind === 'video').length,
    audios: list.filter((entry) => entry.kind === 'audio').length,
    bytes: list.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0),
    truncated: Boolean(libraryIndex.value.stats?.truncated),
  };
}

/**
 * 增量：把新条目并入轻量索引与「已加载的目录缓存」，不重建整个列表。
 * 上传/截帧/导出后调用，当前页面不会闪、也不会打断正在进行的操作。
 */
export function applyLibraryAdditions(added = []) {
  const list = (added ?? []).filter((entry) => entry?.path);
  if (!list.length) return 0;

  // 轻量索引还没加载完时不要动它（否则统计会被算成"只有新增的几项"）；目录缓存照常增量。
  if (libraryIndex.value.ready) {
    const indexEntries = new Map((libraryIndex.value.entries ?? []).map((entry) => [entry.path, entry]));
    for (const entry of list) indexEntries.set(entry.path, { ...(indexEntries.get(entry.path) ?? {}), ...entry });
    const nextIndexEntries = [...indexEntries.values()];
    libraryIndex.value = {
      ...libraryIndex.value,
      entries: nextIndexEntries,
      stats: recomputeStats(nextIndexEntries),
    };
  }

  // 只 patch 已经加载过的目录；未加载的目录进入时会自己拉取
  const nextCache = new Map(dirCache.value);
  for (const entry of list) {
    const bucket = nextCache.get(entry.dir);
    if (!bucket) continue;
    const byPath = new Map((bucket.entries ?? []).map((item) => [item.path, item]));
    byPath.set(entry.path, { ...(byPath.get(entry.path) ?? {}), ...entry });
    nextCache.set(entry.dir, { ...bucket, entries: [...byPath.values()] });
  }
  dirCache.value = nextCache;

  const nextMeta = new Map(metaByPath.value);
  for (const entry of list) {
    if (entry.width || entry.height || entry.duration || entry.bytes) nextMeta.set(entry.path, entry);
  }
  metaByPath.value = nextMeta;

  preserveSelected();
  return list.length;
}

/** 增量：从索引 / 目录缓存 / 元数据里移除被删除的路径（支持文件夹前缀）。 */
export function applyLibraryRemoval(paths = []) {
  const roots = (paths ?? []).filter(Boolean);
  if (!roots.length) return 0;
  const inside = (value) => Boolean(value) && roots.some((root) => value === root || value.startsWith(`${root}/`));

  if (libraryIndex.value.ready) {
    const indexEntries = (libraryIndex.value.entries ?? []).filter((entry) => !inside(entry.path));
    const indexFolders = (libraryIndex.value.folders ?? []).filter((folder) => !inside(folder.path));
    libraryIndex.value = {
      ...libraryIndex.value,
      entries: indexEntries,
      folders: indexFolders,
      stats: recomputeStats(indexEntries, indexFolders),
    };
  }

  const nextCache = new Map();
  for (const [dir, bucket] of dirCache.value) {
    if (inside(dir)) continue;
    nextCache.set(dir, {
      ...bucket,
      entries: (bucket.entries ?? []).filter((entry) => !inside(entry.path)),
      folders: (bucket.folders ?? []).filter((folder) => !inside(folder.path)),
    });
  }
  dirCache.value = nextCache;

  const nextMeta = new Map();
  for (const [path, info] of metaByPath.value) if (!inside(path)) nextMeta.set(path, info);
  metaByPath.value = nextMeta;

  state.selected = state.selected.filter((path) => !inside(path));
  if (state.previewPath && inside(state.previewPath)) state.previewPath = null;
  for (const root of roots) {
    if (state.currentDir && (state.currentDir === root || state.currentDir.startsWith(`${root}/`))) {
      state.currentDir = root.includes('/') ? root.slice(0, root.lastIndexOf('/')) : '';
    }
  }
  return roots.length;
}

/** 增量：改名 / 移动后把索引、目录缓存、元数据里的路径整体映射到新路径。 */
export function applyLibraryMoves(moves = []) {
  const list = (moves ?? []).filter((move) => move?.from && move?.to && move.from !== move.to);
  if (!list.length) return;
  const remap = (value) => remapLibraryPath(value, list);
  const indexEntries = (libraryIndex.value.entries ?? []).map((entry) => {
    const path = remap(entry.path);
    if (path === entry.path) return entry;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return { ...entry, path, dir, name: path.slice(path.lastIndexOf('/') + 1) };
  });
  const indexFolders = (libraryIndex.value.folders ?? []).map((folder) => {
    const path = remap(folder.path);
    if (path === folder.path) return folder;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return { ...folder, path, parent, name: path.slice(path.lastIndexOf('/') + 1) };
  });
  libraryIndex.value = { ...libraryIndex.value, entries: indexEntries, folders: indexFolders };

  // 目录缓存按「新的 dir」重新归组：移动后源目录里不能再残留旧条目，
  // 目标目录已加载时要立刻出现这些条目（关键修复：之前只改 path/dir 字段，
  // 条目仍留在源目录的 bucket 里，导致当前文件夹不刷新）。
  const nextCache = new Map();
  for (const [dir, bucket] of dirCache.value) {
    const key = remap(dir);
    nextCache.set(key, {
      ...bucket,
      key,
      entries: [],
      folders: [],
    });
  }
  const pushEntry = (dir, entry) => {
    const bucket = nextCache.get(dir);
    if (!bucket) return; // 目标目录没加载过，进入时会重新拉取
    if (!bucket.entries.some((item) => item.path === entry.path)) bucket.entries.push(entry);
  };
  const pushFolder = (parent, folder) => {
    const bucket = nextCache.get(parent);
    if (!bucket) return;
    if (!bucket.folders.some((item) => item.path === folder.path)) bucket.folders.push(folder);
  };
  for (const [, bucket] of dirCache.value) {
    for (const entry of bucket.entries ?? []) {
      const path = remap(entry.path);
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      pushEntry(dir, path === entry.path ? entry : { ...entry, path, dir, name: path.slice(path.lastIndexOf('/') + 1) });
    }
    for (const folder of bucket.folders ?? []) {
      const path = remap(folder.path);
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      pushFolder(parent, path === folder.path ? folder : { ...folder, path, parent, name: path.slice(path.lastIndexOf('/') + 1) });
    }
  }
  dirCache.value = nextCache;

  const nextMeta = new Map();
  for (const [path, info] of metaByPath.value) nextMeta.set(remap(path), info);
  metaByPath.value = nextMeta;
}

// --------------------------------------------------------------- 动作

const dirRequests = new Map();

/**
 * 加载单个目录的直接子项（有缓存则直接复用）。
 * 只有进入目录 / 展开目录时才触发，不再为了首屏读取整个资源库。
 */
export async function loadDir(dir = '', { force = false } = {}) {
  const key = dir ?? '';
  if (!force && dirCache.value.has(key)) return dirCache.value.get(key);
  if (dirRequests.has(key)) return dirRequests.get(key);
  state.dirLoading = true;
  const request = fetchLibraryDirectory(key, { force })
    .then((data) => {
      const next = new Map(dirCache.value);
      next.set(key, { folders: data.folders ?? [], entries: data.entries ?? [] });
      dirCache.value = next;
      return next.get(key);
    })
    .finally(() => {
      dirRequests.delete(key);
      if (!dirRequests.size) state.dirLoading = false;
    });
  dirRequests.set(key, request);
  return request;
}

let indexRequest = null;

/**
 * 轻量全库索引：只含名称 / 目录 / stat，不含尺寸与时长。
 * 用于统计、跨目录搜索与树形视图；首次按需触发后在内存中复用。
 */
export function loadLibraryIndex({ force = false } = {}) {
  if (!force && libraryIndex.value.ready) return Promise.resolve(libraryIndex.value);
  if (indexRequest) return indexRequest;
  state.indexLoading = true;
  indexRequest = fetchLibraryTree({ light: true, force })
    .then((data) => {
      libraryIndex.value = {
        folders: data.folders ?? [],
        entries: data.entries ?? [],
        stats: data.stats ?? { ...EMPTY_STATS },
        ready: true,
      };
      state.indexReady = true;
      preserveSelected();
      return libraryIndex.value;
    })
    .catch((err) => {
      setError(`读取资源库索引失败：${err.message}`);
      return libraryIndex.value;
    })
    .finally(() => {
      state.indexLoading = false;
      indexRequest = null;
    });
  return indexRequest;
}

// --------------------------------------------------------------- 元数据懒加载
const META_CONCURRENCY = 4;
const metaQueue = [];
const metaRequested = new Set();
let metaRunning = 0;

/** 卡片进入视口后请求尺寸 / 时长；同一路径只请求一次。 */
/** 把路径转成 {id,path} 引用：接口优先按 id 定位，路径作为兜底。 */
function refOfPath(path) {
  const entry = entries.value.find((item) => item.path === path);
  return entry?.id ? { id: entry.id, path } : { path };
}

export function requestEntryMeta(entry) {
  const ref = typeof entry === 'string' ? { path: entry } : entry;
  const key = ref?.id ?? ref?.path;
  if (!key || metaRequested.has(key) || (ref?.path && metaByPath.value.has(ref.path))) return;
  metaRequested.add(key);
  metaQueue.push(ref);
  pumpMetaQueue();
}

function pumpMetaQueue() {
  while (metaRunning < META_CONCURRENCY && metaQueue.length) {
    const ref = metaQueue.shift();
    const path = ref?.path ?? String(ref);
    metaRunning += 1;
    fetchLibraryEntryMeta(ref)
      .then((info) => {
        if (!info) return;
        const next = new Map(metaByPath.value);
        next.set(path, info);
        metaByPath.value = next;
      })
      .catch(() => {
        // 单个文件解析失败不影响列表，允许下次重试
        metaRequested.delete(path);
      })
      .finally(() => {
        metaRunning -= 1;
        pumpMetaQueue();
      });
  }
}

// --------------------------------------------------------------- 刷新

export async function refreshLibrary({ quiet = false } = {}) {
  if (!quiet) state.loading = true;
  state.refreshing = true;
  state.error = '';
  // 目录缓存全部失效，重新按需拉取；元数据服务端有缓存，可继续复用
  dirCache.value = new Map();
  try {
    try {
      await loadDir(state.currentDir, { force: true });
    } catch (err) {
      if (!state.currentDir) throw err;
      // 当前目录可能已被删除/改名，退回根目录
      state.currentDir = '';
      state.previewPath = null;
      await loadDir('', { force: true });
    }
    state.initialized = true;
    // 统计、跨目录搜索、树形所需的轻量索引在后台补全，不阻塞当前目录首屏
    void loadLibraryIndex({ force: true });
    preserveSelected();
    if (state.previewPath && !entries.value.some((entry) => entry.path === state.previewPath)) {
      state.previewPath = null;
    }
    if (!quiet) {
      setStatus(
        stats.value.files
          ? `资源库已刷新：${stats.value.files} 个文件 · ${stats.value.folders} 个子目录`
          : '资源库已刷新',
      );
    }
  } catch (err) {
    setError(`读取资源库失败：${err.message}`);
  } finally {
    state.loading = false;
    state.refreshing = false;
  }
}

export function setDir(dir) {
  const next = dir ?? '';
  state.currentDir = next;
  state.previewPath = null;
  state.selected = [];
  void loadDir(next).catch((err) => setError(`读取目录失败：${err.message}`));
}

export function navigate(path) {
  setDir(path);
}

export function openFolder(folder) {
  setDir(folder.path);
}

export function goUp() {
  if (!state.currentDir) return;
  const parts = state.currentDir.split('/');
  parts.pop();
  setDir(parts.join('/'));
}

/** 在系统文件资源管理器中打开：文件定位选中，文件夹或根目录直接打开。 */
export async function reveal(target = '') {
  const rel = typeof target === 'string' ? target : target?.path ?? '';
  state.error = '';
  try {
    const result = await revealLibraryPath(rel || state.currentDir);
    setStatus(result?.selected ? '已在文件资源管理器中选中该文件' : '已在文件资源管理器中打开');
  } catch (err) {
    setError(`打开文件资源管理器失败：${err.message}`);
  }
}

export function setSearch(value) {
  state.search = String(value ?? '');
  // 跨目录搜索依赖轻量索引，第一次搜索时补全
  if (state.search.trim()) void loadLibraryIndex();
}

export function setKindFilter(value) {
  state.kindFilter = value;
}

export function setMarkFilter(value) {
  state.markFilter = ['marked', 'favorite', 'locked'].includes(value) ? value : 'all';
}

export function setSort(value) {
  state.sort = value;
}

export function setBrowseMode(value) {
  state.browseMode = value === 'tree' ? 'tree' : 'flat';
  try {
    localStorage.setItem(BROWSE_MODE_KEY, state.browseMode);
  } catch {
    // 存不下不影响当前会话
  }
  // 树形视图需要完整的目录层级，按需补全轻量索引
  if (state.browseMode === 'tree') void loadLibraryIndex();
}

export function setCurrentDir(path) {
  const next = path ?? '';
  state.currentDir = next;
  void loadDir(next).catch((err) => setError(`读取目录失败：${err.message}`));
}

export function toggleSelect(path) {
  if (!path) return;
  const index = state.selected.indexOf(path);
  if (index >= 0) state.selected.splice(index, 1);
  else state.selected.push(path);
}

export function selectOnly(path) {
  state.selected = path ? [path] : [];
}

/** 用一组路径替换当前选择（Shift 连选）。 */
export function setSelection(paths) {
  state.selected = [...new Set((paths ?? []).filter(Boolean))];
}

/** 把一组路径并入当前选择（Shift + Ctrl/Alt 追加连选）。 */
export function addSelection(paths) {
  state.selected = [...new Set([...state.selected, ...(paths ?? []).filter(Boolean)])];
}

export function selectAllVisible() {
  state.selected = [...currentFolders.value.map((folder) => folder.path), ...currentEntries.value.map((entry) => entry.path)];
}

export function clearSelection() {
  state.selected = [];
}

export async function uploadFiles(fileList, options = {}) {
  const files = [...(fileList ?? [])].filter(Boolean);
  if (!files.length) return [];
  const baseDir = options.dir ?? state.currentDir;

  state.busy = true;
  state.error = '';
  state.upload.active = true;
  state.upload.index = 0;
  state.upload.total = files.length;
  state.upload.skipped = [];
  state.upload.failed = [];
  const uploaded = [];
  const uploadTaskId = `upload-${Date.now().toString(36)}`;
  startLocalTask({ id: uploadTaskId, title: `上传 ${files.length} 个文件`, detail: '准备中…' });

  try {
    for (const [index, file] of files.entries()) {
      state.upload.index = index + 1;
      state.upload.name = file.name;
      state.upload.percent = 0;

      // 拖入文件夹时浏览器会给出 webkitRelativePath，用它保留子目录结构。
      const relative = String(file.webkitRelativePath ?? '').replace(/\\/g, '/');
      const relativeDir = relative.includes('/') ? relative.split('/').slice(0, -1).join('/') : '';
      const dir = [baseDir, relativeDir].filter(Boolean).join('/');

      try {
        // 手动上传默认开启 checksum 去重：内容完全相同的文件不再重复入库
        const result = await uploadLibraryFile(file, {
          dir,
          dedup: options.dedup !== false,
          onProgress: (percent) => {
            state.upload.percent = percent;
          },
        });
        if (result?.entry) uploaded.push(result.entry);
      } catch (err) {
        // 单个文件失败（含重复）不中断整批上传
        if (err?.code === 'DUPLICATE') state.upload.skipped.push({ name: file.name, message: err.message });
        else state.upload.failed.push({ name: file.name, message: err.message });
      }
      setStatus(`已处理 ${index + 1}/${files.length}：${file.name}`);
      updateLocalTask(uploadTaskId, {
        progress: files.length ? (index + 1) / files.length : 0,
        detail: `${index + 1}/${files.length} · ${file.name}`,
      });
    }

    // 增量并入：不整页刷新，避免列表闪烁和打断正在进行的操作
    applyLibraryAdditions(uploaded);
    const skipped = state.upload.skipped.length;
    const failed = state.upload.failed.length;
    if (failed) {
      setError(`上传结束：成功 ${uploaded.length}，重复跳过 ${skipped}，失败 ${failed} —— ${state.upload.failed[0].message}`);
    } else if (skipped) {
      setStatus(`已上传 ${uploaded.length} 个文件，跳过 ${skipped} 个重复文件`);
    } else {
      setStatus(`已上传 ${uploaded.length} 个文件到资源库`);
    }
    finishLocalTask(uploadTaskId, {
      status: failed ? 'failed' : 'done',
      detail: `成功 ${uploaded.length} 个${skipped ? ` · 跳过 ${skipped} 个重复` : ''}${failed ? ` · 失败 ${failed}` : ''}`,
    });
    if (uploaded.length) {
      pushToast({
        kind: 'success',
        title: '上传完成',
        message: `${uploaded.length} 个文件已加入资源库${skipped ? ` · 跳过 ${skipped} 个重复` : ''}${failed ? ` · ${failed} 个失败` : ''}`,
      });
    }
  } catch (err) {
    setError(`上传失败：${err.message}`);
  } finally {
    state.upload.active = false;
    state.upload.name = '';
    state.upload.percent = 0;
    state.busy = false;
  }
  return uploaded;
}

/** 编辑器结果保存到资源库（裁剪 / 抠图 / 橡皮擦共用）。 */
export async function saveBlobToLibrary(blob, name, dir = '导出') {
  state.busy = true;
  try {
    const result = await uploadBlobToLibrary(blob, name, dir);
    if (result?.entry) applyLibraryAdditions([result.entry]);
    setStatus(`已保存到资源库：${result.entry?.path ?? `${dir}/${name}`}`);
    return result.entry ?? null;
  } catch (err) {
    setError(`保存到资源库失败：${err.message}`);
    throw err;
  } finally {
    state.busy = false;
    state.upload.active = false;
  }
}

/**
 * 就地保存：把编辑结果写回**当前素材**对应的资源库文件。
 *
 * 与 saveBlobToLibrary（另存为新文件）相反，这里覆盖同一个文件：
 *  - path 有值：必要时先把文件改名成 `.png`（编辑器输出统一是保留 alpha 的 PNG，
 *    而原文件可能是 JPG/WebP），再覆盖写入；服务端会先把旧内容存成历史版本，
 *    所以覆盖后仍可在资源库检查器里回滚；
 *  - path 为空（素材还没进资源库，比如示例图 / 拖进来的文件）：在资源库根目录
 *    新建一个同名 PNG，之后再次保存就是覆盖它。
 *
 * @param {Blob} blob
 * @param {{path?:string, name?:string}} [options]
 * @returns {Promise<{entry:object|null, path:string}>}
 */
export async function saveBlobToLibraryPath(blob, { path = '', name = '' } = {}) {
  if (!blob) throw new LibraryApiError('没有可保存的内容', 'EMPTY_BLOB');
  const target = resolveInPlaceTarget(path, name || 'image');
  state.busy = true;
  state.error = '';
  try {
    let targetPath = target.path;
    let targetName = target.name;

    // 覆盖上传是「按目标路径写字节」，扩展名必须和真实编码一致，所以先改名成 .png
    if (targetPath && target.renamed) {
      const entryRef = entries.value.find((item) => item.path === targetPath);
      const response = await renameLibraryItems([{ ...(entryRef?.id ? { id: entryRef.id } : {}), path: targetPath, name: targetName }]);
      const result = (response?.results ?? []).find((row) => row.ok !== false && row.to);
      if (!result?.to) {
        const failed = (response?.results ?? []).find((row) => row.ok === false);
        throw new LibraryApiError(failed?.error || '改名失败：无法把文件改成 PNG', 'RENAME_FAILED');
      }
      targetPath = result.to;
      targetName = targetPath.split('/').pop() || targetName;
      // 改名同样要同步资源库的选中项/当前目录/预览路径与各工作区的来源路径
      applyPathMoves(response?.results ?? []);
    }

    const uploaded = await uploadLibraryFile(blob, {
      name: targetName,
      dir: target.dir,
      overwritePath: targetPath || undefined,
      dedup: false,
    });
    await refreshLibrary({ quiet: true });
    const entry = uploaded?.entry ?? null;
    const finalPath = entry?.path ?? targetPath ?? `${target.dir ? `${target.dir}/` : ''}${targetName}`;
    return { entry, path: finalPath };
  } catch (err) {
    setError(`保存到当前素材失败：${err.message}`);
    throw err;
  } finally {
    state.busy = false;
  }
}

export async function createFolder(name) {
  if (!String(name ?? '').trim()) {
    setError('请输入文件夹名称');
    return null;
  }
  state.busy = true;
  try {
    const result = await createLibraryFolder(state.currentDir, name);
    await refreshLibrary({ quiet: true });
    setStatus(`已创建文件夹：${result.folder.path}`);
    return result.folder;
  } catch (err) {
    setError(`创建文件夹失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/**
 * 在当前目录下批量创建固定名称的子文件夹（不覆盖、不自动编号）。
 * @param {string[]} names
 * @returns {Promise<{results:object[],created:number,total:number}|null>}
 */
export async function createFolders(names) {
  const list = (Array.isArray(names) ? names : [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  if (!list.length) {
    setError('请至少输入一个文件夹名称');
    return null;
  }
  state.busy = true;
  try {
    const result = await createLibraryFolders(state.currentDir, list);
    await refreshLibrary({ quiet: true });
    const created = Number(result.created) || 0;
    const skipped = (result.results ?? []).filter((row) => !row.ok);
    if (created) {
      setStatus(`已在「${state.currentDir || '根目录'}」创建 ${created} 个子文件夹${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);
    } else {
      const first = skipped[0];
      setError(`没有创建文件夹：${first?.error ?? '名称重复或已存在'}`);
    }
    return { ...result, results: result.results ?? [] };
  } catch (err) {
    setError(`批量创建文件夹失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export async function renameOne(entry, name) {
  const target = String(name ?? '').trim();
  if (!target || target === entry.name) return true;
  state.busy = true;
  try {
    const result = await renameLibraryItems([{ ...(entry.id ? { id: entry.id } : {}), path: entry.path, name: target }]);
    if (!result.ok) {
      const first = result.results?.find((item) => item.ok === false);
      throw new LibraryApiError(first?.error || '重命名失败', 'RENAME_FAILED');
    }
    // 文件夹改名时，选中项 / 当前目录 / 预览路径可能都在它下面
    const moves = applyPathMoves(result.results);
    applyLibraryMoves(moves);
    const finalName = moves[0]?.to?.split('/').pop() || target;
    setStatus(`已重命名为 ${finalName}`);
    return true;
  } catch (err) {
    setError(`重命名失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

/**
 * 批量改名配置：
 *   mode: 'replace'  查找替换 + 可选前缀/后缀/序号
 *   mode: 'sequence' 统一改成「前缀 + 序号 + 后缀」，扩展名保持不变
 *   mode: 'prefix'   统一加前缀（原文件名保留）
 */
export function buildBatchNames(list, config) {
  const mode = config?.mode ?? 'replace';
  const prefix = String(config?.prefix ?? '');
  const suffix = String(config?.suffix ?? '');
  const find = String(config?.find ?? '');
  const replace = String(config?.replace ?? '');
  const start = Math.max(0, Math.round(Number(config?.start) || 1));
  const padding = Math.max(1, Math.min(6, Math.round(Number(config?.padding) || 3)));
  const withNumber = Boolean(config?.withNumber);

  return list.map((entry, index) => {
    // 文件夹没有扩展名概念：整名当主体，避免把 "v1.2" 拆成主体 + ".2"
    const isFolder = !entry.kind;
    const ext = isFolder ? '' : extensionOf(entry.name);
    let base = isFolder ? String(entry.name) : baseOf(entry.name);
    if (mode === 'sequence') {
      base = `${prefix}${String(start + index).padStart(padding, '0')}${suffix}`;
    } else {
      if (find) base = base.split(find).join(replace);
      base = `${prefix}${base}${suffix}`;
      if (withNumber) base += String(start + index).padStart(padding, '0');
    }
    return { entry, name: `${base || 'file'}${ext}` };
  });
}

/** 批量改名预览：标出同目录重名（服务端会自动加序号，这里提前提示）。 */
export function previewBatchRename(config, list = selectedEntries.value) {
  const rows = buildBatchNames(list, config);
  const seen = new Map();
  return rows.map(({ entry, name }) => {
    const key = `${entry.dir ?? entry.parent ?? ''}/${name.toLowerCase()}`;
    const duplicate = seen.has(key);
    seen.set(key, true);
    return { entry, name, duplicate };
  });
}

export async function batchRename(config, list = selectedEntries.value) {
  if (!list.length) {
    setError('请先选择要改名的文件');
    return false;
  }
  const rows = buildBatchNames(list, config);
  state.busy = true;
  try {
    const result = await renameLibraryItems(rows.map(({ entry, name }) => ({ ...(entry.id ? { id: entry.id } : {}), path: entry.path, name })));
    applyPathMoves(result.results);
    await refreshLibrary({ quiet: true });
    const failed = failedCount(result);
    if (failed) setError(`批量改名部分失败：${failed} 项`);
    else setStatus(`已批量重命名 ${rows.length} 项`);
    return result.ok;
  } catch (err) {
    setError(`批量改名失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

export async function moveSelected(targetDir) {
  if (!state.selected.length) {
    setError('请先选择要移动的文件或文件夹');
    return false;
  }
  state.busy = true;
  try {
    const result = await moveLibraryItems([...state.selected].map(refOfPath), targetDir ?? '');
    // 若移动的是当前目录（或它的上级），把目录与预览路径一起迁到新位置
    applyLibraryMoves(applyPathMoves(result.results));
    state.selected = [];
    const failed = failedCount(result);
    if (failed) setError(`移动部分失败：${failed} 项`);
    else setStatus(`已移动 ${result.succeeded} 项到 ${targetDir || '根目录'}`);
    return result.ok;
  } catch (err) {
    setError(`移动失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

/**
 * 复制选中的文件 / 文件夹到目标目录（保留原件），支持批量。
 */
export async function copySelected(targetDir) {
  if (!state.selected.length) {
    setError('请先选择要复制的文件或文件夹');
    return false;
  }
  state.busy = true;
  try {
    const result = await copyLibraryItems([...state.selected].map(refOfPath), targetDir ?? '');
    // 复制返回的结果里有新路径：用源条目做模板增量并入，避免整页刷新闪烁
    const template = new Map(entries.value.map((entry) => [entry.path, entry]));
    const added = [];
    for (const row of result.results ?? []) {
      if (!row.ok || !row.from || !row.to) continue;
      const source = template.get(row.from);
      if (!source) continue;
      const dir = row.to.includes('/') ? row.to.slice(0, row.to.lastIndexOf('/')) : '';
      added.push({ ...source, path: row.to, dir, name: row.to.slice(row.to.lastIndexOf('/') + 1) });
    }
    applyLibraryAdditions(added);
    state.selected = [];
    const failed = failedCount(result);
    if (failed) setError(`复制部分失败：${failed} 项`);
    else setStatus(`已复制 ${result.succeeded} 项到 ${targetDir || '根目录'}`);
    return result.ok;
  } catch (err) {
    setError(`复制失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

/**
 * 按路径删除文件 / 文件夹（移入回收站，可从回收站恢复）。
 * 供素材面板等不依赖 `state.selected` 的地方复用。
 */
/**
 * 删除前检查「正在编辑」的资源：图片处理当前素材、视频/音频工作区。
 * 有影响时弹确认框（用户可选择取消删除）；确认后返回受影响的素材，供删除后统一清理。
 */
async function inspectDeletionImpact(list) {
  const inside = (value) => list.some((root) => value === root || value.startsWith(`${root}/`));
  const workspace = useWorkspace();
  const imageItems = workspace.state.items.filter((item) => item.libraryPath && inside(item.libraryPath));
  let videoActive = null;
  let audioActive = null;
  try {
    const { useVideo } = await import('./useVideo.js');
    const video = useVideo();
    if (video.state.activePath && inside(video.state.activePath)) videoActive = video.state.activePath;
  } catch {
    // 视频工作区未加载时不阻断删除
  }
  try {
    const { useAudio } = await import('./useAudio.js');
    const audio = useAudio();
    if (audio.state.activePath && inside(audio.state.activePath)) audioActive = audio.state.activePath;
  } catch {
    // 音频工作区未加载时不阻断删除
  }
  return { imageItems, videoActive, audioActive };
}

/**
 * 删除影响描述（供各删除入口拼进确认弹窗）。
 * 返回 message 为空字符串表示没有正在编辑的内容受影响。
 */
export async function describeDeletionImpact(paths) {
  const list = [...new Set((paths ?? []).filter(Boolean))];
  if (!list.length) return { count: 0, message: '', detail: '' };
  const impact = await inspectDeletionImpact(list);
  const reasons = [];
  if (impact.imageItems.length) reasons.push(`图片处理工作区的「当前素材」里有 ${impact.imageItems.length} 张来自这里`);
  if (impact.videoActive) reasons.push('视频工作区正在播放这个视频');
  if (impact.audioActive) reasons.push('音频工作区正在编辑这个音频');
  return {
    count: reasons.length ? 1 : 0,
    message: reasons.length ? `${reasons.join('；')}。删除后会一并从工作区移除，未保存的编辑将丢失。` : '',
    detail: impact.imageItems.slice(0, 6).map((item) => item.name).join('、'),
  };
}

/** 删除完成后清理工作区里已经失效的内容。 */
async function applyDeletionImpact(impact, list) {
  if (impact.imageItems?.length) {
    useWorkspace().actions.removeByLibraryPaths(list);
  }
  if (impact.videoActive) {
    try {
      const { useVideo } = await import('./useVideo.js');
      useVideo().actions.resetSession?.();
    } catch {
      /* 视频模块未加载则忽略 */
    }
  }
  if (impact.audioActive) {
    try {
      const { useAudio } = await import('./useAudio.js');
      const audio = useAudio();
      if (typeof audio.actions?.close === 'function') audio.actions.close();
      else if (typeof audio.actions?.resetSession === 'function') audio.actions.resetSession();
    } catch {
      /* 音频模块未加载则忽略 */
    }
  }
}

function refOfEntry(entry) {
  return entry?.id ? { id: entry.id, path: entry.path } : { path: entry?.path };
}

function applyLockResults(results) {
  const next = new Map(lockOverrides.value);
  for (const row of results ?? []) {
    const id = row.id ?? entries.value.find((item) => item.path === row.path)?.id;
    if (id) next.set(id, Boolean(row.locked));
  }
  lockOverrides.value = next;
}

/** 锁定 / 解锁指定文件（entry 或 {id,path}）。 */
export async function setLock(items, locked) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!list.length) return false;
  state.busy = true;
  try {
    const response = await setLibraryLocks(list.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path })), Boolean(locked));
    applyLockResults(response.results);
    const failed = failedCount(response);
    if (failed) {
      const first = response.results?.find((row) => row.ok === false);
      setError(`锁定操作部分失败：${first?.error ?? `${failed} 项`}`);
      pushToast({ kind: 'error', title: '锁定失败', message: first?.error ?? `${failed} 项没有更新` });
    } else {
      const text = locked ? '已锁定' : '已解锁';
      setStatus(`${text} ${response.succeeded ?? list.length} 项${locked ? '（锁定后不能删除）' : ''}`);
      pushToast({ kind: 'success', title: text, message: `${response.succeeded ?? list.length} 个文件${locked ? '已锁定，删除会被拒绝' : '已解锁'}` });
    }
    return response.ok;
  } catch (err) {
    setError(`锁定操作失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

export async function toggleLock(entry) {
  if (!entry) return false;
  return setLock([entry], !entry.locked);
}

/** 批量锁定选中的文件（文件夹会被忽略并提示）。 */
export async function lockSelected() {
  const files = selectedEntries.value.filter((entry) => entry.kind !== 'folder');
  if (!files.length) {
    setError('请选中要锁定的文件（文件夹不支持锁定）');
    return false;
  }
  return setLock(files, true);
}

export async function unlockSelected() {
  const files = selectedEntries.value.filter((entry) => entry.kind !== 'folder');
  if (!files.length) {
    setError('请选中要解锁的文件');
    return false;
  }
  return setLock(files, false);
}

function applyMarkResults(results) {
  const next = new Map(markOverrides.value);
  for (const row of results ?? []) {
    if (!row?.id) continue;
    next.set(row.id, { favorite: Boolean(row.favorite), mark: row.mark ?? null });
  }
  markOverrides.value = next;
}

/** 设置收藏 / emoji 标记；patch 例：{favorite:true} / {mark:'⭐'} / {mark:null}。 */
export async function setMarks(items, patch) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!list.length) return false;
  state.busy = true;
  try {
    const response = await setLibraryMarks(
      list.map((item) => (item.id ? { id: item.id, path: item.path } : { path: item.path })),
      patch,
    );
    applyMarkResults(response.results);
    const failed = failedCount(response);
    if (failed) {
      const first = response.results?.find((row) => row.ok === false);
      setError(`收藏/标记部分失败：${first?.error ?? `${failed} 项`}`);
    } else {
      const count = response.succeeded ?? list.length;
      if (typeof patch.favorite === 'boolean') setStatus(`${patch.favorite ? '已收藏' : '已取消收藏'} ${count} 项`);
      else if (Object.prototype.hasOwnProperty.call(patch, 'mark')) {
        setStatus(patch.mark ? `已标记 ${patch.mark} ${count} 项` : `已清除标记 ${count} 项`);
      }
    }
    return response.ok;
  } catch (err) {
    setError(`收藏/标记失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

export async function toggleFavorite(entry) {
  if (!entry) return false;
  return setMarks([entry], { favorite: !entry.favorite });
}

export async function favoriteSelected() {
  const files = selectedEntries.value.filter((entry) => entry.kind !== 'folder');
  if (!files.length) {
    setError('请选中要收藏的文件');
    return false;
  }
  return setMarks(files, { favorite: true });
}

export async function unfavoriteSelected() {
  const files = selectedEntries.value.filter((entry) => entry.kind !== 'folder');
  if (!files.length) {
    setError('请选中要取消收藏的文件');
    return false;
  }
  return setMarks(files, { favorite: false });
}

export async function setEntryMark(entry, mark) {
  if (!entry) return false;
  return setMarks([entry], { mark });
}

export async function markSelected(mark) {
  const files = selectedEntries.value.filter((entry) => entry.kind !== 'folder');
  if (!files.length) {
    setError('请选中要标记的文件');
    return false;
  }
  return setMarks(files, { mark });
}

export async function clearSelectedMarks() {
  return markSelected(null);
}

export async function deletePaths(paths) {
  const list = [...new Set((paths ?? []).filter(Boolean))];
  if (!list.length) {
    setError('请先选择要删除的文件或文件夹');
    return false;
  }
  state.busy = true;
  try {
    const result = await deleteLibraryItems(list.map(refOfPath));
    // 只移除真正成功的项：锁定 / 失败的项目必须留在列表里
    const removed = (result.results ?? []).filter((row) => row.ok).map((row) => row.path);
    if (removed.length) {
      await applyDeletionImpact(await inspectDeletionImpact(removed), removed);
      applyLibraryRemoval(removed);
    }
    const failed = failedCount(result);
    if (failed) {
      const first = result.results?.find((row) => row.ok === false);
      const message = first?.error?.includes('锁定') ? first.error : `${failed} 项没有移入回收站${first?.error ? `：${first.error}` : ''}`;
      setError(`删除部分失败：${message}`);
      pushToast({ kind: 'error', title: '删除被阻止', message });
    } else {
      setStatus(`已将 ${result.succeeded ?? list.length} 项移入回收站`);
      pushToast({ kind: 'success', title: '已移入回收站', message: `${result.succeeded ?? list.length} 项 · 可在回收站恢复` });
    }
    return result.ok;
  } catch (err) {
    setError(`删除失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

export async function deleteSelected() {
  return deletePaths(state.selected);
}

/**
 * 删除整个文件夹（连同子目录与文件一起移入回收站）。
 * 与 deleteSelected 的区别：不依赖当前选中项，且会处理“正在浏览/预览/选中”
 * 恰好位于该文件夹内部的情况，避免刷新后停在已不存在的目录。
 */
export async function deleteFolder(folder) {
  const path = folder?.path ?? '';
  if (!path) return false;
  const name = folder?.name || path.split('/').pop();
  state.busy = true;
  try {
    const result = await deleteLibraryItems([{ path }]);
    const removed = (result.results ?? []).filter((row) => row.ok).map((row) => row.path);
    if (removed.length) {
      await applyDeletionImpact(await inspectDeletionImpact(removed), removed);
      // applyLibraryRemoval 会顺带处理当前目录 / 预览 / 选中项
      applyLibraryRemoval(removed);
    }
    const failed = failedCount(result);
    if (failed) {
      const first = result.results?.find((row) => row.ok === false);
      setError(`删除文件夹失败：${first?.error ?? `${failed} 项`}`);
    } else setStatus(`已将文件夹「${name}」及其内容移入回收站`);
    return result.ok;
  } catch (err) {
    setError(`删除文件夹失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

/**
 * 上传一个新版本覆盖已有文件（旧内容由服务端存为历史版本）。
 * 用于资源检查器里的「上传新版本」，让编辑前后的内容都可以找回。
 */
export async function uploadNewVersion(entry, file) {
  if (!entry || !file) return null;
  state.busy = true;
  state.error = '';
  state.upload.active = true;
  state.upload.name = file.name ?? entry.name;
  state.upload.percent = 0;
  try {
    const result = await uploadLibraryFile(file, {
      name: entry.name,
      dir: entry.dir,
      overwritePath: entry.path,
      // 覆盖上传允许内容相同（用户可能只是想留一版记录），不做重复拦截
      dedup: false,
      onProgress: (percent) => {
        state.upload.percent = percent;
      },
    });
    await refreshLibrary({ quiet: true });
    setStatus(`已保存新版本：${entry.path}（旧版本已存入历史）`);
    return result?.entry ?? null;
  } catch (err) {
    setError(`保存新版本失败：${err.message}`);
    return null;
  } finally {
    state.upload.active = false;
    state.upload.name = '';
    state.upload.percent = 0;
    state.busy = false;
  }
}

/** 恢复某个历史版本（当前内容会先自动存成一版）。 */
export async function restoreVersionHistory(entry, versionId) {
  if (!entry || !versionId) return null;
  state.busy = true;
  try {
    const result = await restoreLibraryVersion(entry.path, versionId);
    await refreshLibrary({ quiet: true });
    setStatus(`已恢复历史版本：${entry.name}`);
    return result?.entry ?? null;
  } catch (err) {
    setError(`恢复历史版本失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export function openPreview(path) {
  state.previewPath = path;
}

export function closePreview() {
  state.previewPath = null;
}

export function stepPreview(direction) {
  const list = previewList.value;
  if (!list.length || !state.previewPath) return;
  const index = list.findIndex((entry) => entry.path === state.previewPath);
  const next = (index + direction + list.length) % list.length;
  state.previewPath = list[next].path;
}

/**
 * 一键转入编辑：下载资源库文件 → 作为素材导入工作区 → 切到图片工作区。
 *
 * 支持单个条目、路径或条目数组：
 *  - 单张 → 默认切到「透明裁剪」（可用 options.mode 指定 cropimage/bgremove/eraser）；
 *  - 多张 → 切到「图片裁剪」，那里有批量裁剪，正好处理一组关键帧。
 */
/**
 * 批量转入图片编辑前的确认：工作区已有素材时询问是否先清空。
 * 默认项是「追加到现有素材」（即不清空）；返回 false 表示用户取消。
 */
export async function confirmTransferToEditor(count = 0) {
  const workspace = useWorkspace();
  const editing = workspace.state.items.length;
  if (!editing) return true;
  const { confirm } = useConfirm();
  const choice = await confirm({
    title: '当前已有正在编辑的素材',
    message: `图片处理工作区里已经有 ${editing} 个素材。要把选中的 ${count} 张追加进去，还是先清空再转入？`,
    detail: '默认是追加（不清空）。清空后原来的素材会从「当前素材」移除，未保存的编辑会丢失；资源库文件不受影响。',
    choices: [
      { text: '追加到现有素材', value: 'append', kind: 'primary' },
      { text: '清空后转入', value: 'clean', kind: 'danger' },
      { text: '取消', value: 'cancel', kind: 'ghost' },
    ],
    autoFocusValue: 'append',
  });
  if (choice === 'cancel' || choice === null) return false;
  if (choice === 'clean') workspace.actions.clearItems();
  return true;
}

export async function openInEditor(entryOrPath, options = {}) {
  const list = Array.isArray(entryOrPath) ? entryOrPath : [entryOrPath];
  const resolved = list
    .map((item) => (typeof item === 'string' ? entries.value.find((e) => e.path === item) : item))
    .filter(Boolean);
  if (!resolved.length) {
    setError('找不到要编辑的文件');
    return null;
  }

  const videos = resolved.filter((entry) => entry.kind === 'video');
  if (videos.length) {
    setError('视频请使用「在视频工作区打开」');
    return null;
  }
  const images = resolved.filter((entry) => entry.kind === 'image');
  if (!images.length) {
    setError('选中的文件不是图片，无法进入图片编辑');
    return null;
  }

  state.busy = true;
  try {
    const workspace = useWorkspace();
    // 同一张资源库图片只建立一个工作素材，重复点击直接选中已有素材
    const pending = images.filter(
      (entry) => !workspace.state.items.some((item) => item.libraryPath === entry.path),
    );
    // 下载限并发 4：多选转入编辑时不必一张一张等
    const fetched = await mapLimit(pending, 4, async (entry) => {
      try {
        const blob = await fetchLibraryBlob(entry);
        return new File([blob], entry.name, { type: blob.type || 'image/png' });
      } catch (err) {
        console.warn('[library] 读取文件失败:', entry.path, err.message);
        return null;
      }
    });
    const files = [];
    const paths = [];
    fetched.forEach((file, index) => {
      if (!file) return;
      files.push(file);
      paths.push(pending[index].path);
    });
    if (files.length) {
      await workspace.actions.addFiles(files, { libraryPaths: paths });
    } else {
      const existing = workspace.state.items.find((item) => item.libraryPath === images[0].path);
      if (existing) workspace.actions.selectItem(existing.id);
    }
    // options.mode 优先：从图片模块的素材库载入时保持当前工作区，不被强制切走
    const targetMode = options.mode || (images.length > 1 ? 'cropimage' : 'crop');
    setMode(targetMode);
    setStatus(
      files.length < images.length
        ? `已载入 ${files.length} 张新图片，其余已在素材列表中`
        : images.length > 1
          ? `已把 ${images.length} 张图片转入图片裁剪（可直接批量裁剪）`
          : `已将 ${images[0].name} 转入编辑工作区`,
    );
    return images;
  } catch (err) {
    setError(`转入编辑失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export function entryByPath(path) {
  return entries.value.find((entry) => entry.path === path) ?? null;
}

/**
 * 对资源库当前目录做一次内容查重（sha256），只标记不处理。
 * 结果与目录绑定：切到别的目录后高亮自动消失。
 */
async function scanDuplicates() {
  if (state.duplicates.scanning) return;
  const dir = state.currentDir;
  state.duplicates.scanning = true;
  try {
    const result = await fetchLibraryDuplicates(dir);
    const groups = Array.isArray(result?.groups) ? result.groups : [];
    state.duplicates.dir = dir;
    state.duplicates.groups = groups;
    const label = dir || '根目录';
    const count = result?.duplicateFiles ?? groups.reduce((sum, group) => sum + group.paths.length, 0);
    if (count) setStatus(`「${label}」发现 ${groups.length} 组重复资源（共 ${count} 个文件），已在列表高亮`);
    else setStatus(`「${label}」没有内容相同的资源`);
  } catch (err) {
    setError(`查重失败：${err.message}`);
  } finally {
    state.duplicates.scanning = false;
  }
}

function clearDuplicates() {
  state.duplicates.dir = '';
  state.duplicates.groups = [];
  setStatus('');
}

export function useLibrary() {
  return {
    state: readonly(state),
    entries,
    folders,
    stats,
    folderTree,
    currentFolders,
    currentEntries,
    selectedEntries,
    selectedFolders,
    selectedSummary,
    previewEntry,
    previewIndex,
    previewList,
    breadcrumbs,
    canGoUp,
    duplicateGroups,
    duplicatePaths,
    duplicateGroupOf,
    actions: {
      refresh: refreshLibrary,
      loadDir,
      loadIndex: loadLibraryIndex,
      requestMeta: requestEntryMeta,
      reveal,
      setDir,
      navigate,
      openFolder,
      goUp,
      setSearch,
      setKindFilter,
      setMarkFilter,
      setSort,
      setBrowseMode,
      setCurrentDir,
      toggleSelect,
      selectOnly,
      setSelection,
      addSelection,
      selectAllVisible,
      clearSelection,
      uploadFiles,
      saveBlobToLibrary,
      uploadNewVersion,
      restoreVersionHistory,
      createFolder,
      createFolders,
      renameOne,
      previewBatchRename,
      batchRename,
      moveSelected,
      copySelected,
      deletePaths,
      deleteSelected,
      setLock,
      toggleLock,
      lockSelected,
      unlockSelected,
      setMarks,
      toggleFavorite,
      favoriteSelected,
      unfavoriteSelected,
      setEntryMark,
      markSelected,
      clearSelectedMarks,
      deleteFolder,
      describeDeletionImpact,
      confirmTransferToEditor,
      applyLibraryAdditions,
      applyLibraryRemoval,
      applyLibraryMoves,
      openPreview,
      closePreview,
      stepPreview,
      openInEditor,
      entryByPath,
      scanDuplicates,
      clearDuplicates,
    },
  };
}

export { baseOf as fileBaseName, extensionOf as fileExtension };
