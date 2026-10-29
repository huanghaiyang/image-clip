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
  deleteLibraryItems,
  fetchLibraryBlob,
  fetchLibraryTree,
  moveLibraryItems,
  renameLibraryItems,
  uploadLibraryFile,
  uploadBlobToLibrary,
} from '../lib/library.js';
import { useWorkspace } from './useWorkspace.js';
import { setMode } from './useAppMode.js';

const EMPTY_STATS = { files: 0, folders: 0, images: 0, videos: 0, audios: 0, bytes: 0, truncated: false };

const tree = shallowRef({ folders: [], entries: [], stats: { ...EMPTY_STATS } });

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
  sort: 'name', // name | kind | mtime | size
  selected: [], // 相对路径数组，可包含文件夹
  previewPath: null,
  upload: { active: false, name: '', percent: 0, index: 0, total: 0 },
});

const entries = computed(() => tree.value.entries ?? []);
const folders = computed(() => tree.value.folders ?? []);
const stats = computed(() => tree.value.stats ?? EMPTY_STATS);

const folderTree = computed(() => {
  const root = { path: '', name: '资源库', parent: null, depth: -1, isRoot: true };
  return [root, ...folders.value];
});

const currentFolders = computed(() => {
  if (state.search.trim()) return [];
  return folders.value
    .filter((folder) => folder.parent === state.currentDir)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
});

/** 当前目录下的文件；搜索时跨目录。 */
const currentEntries = computed(() => {
  const keyword = state.search.trim().toLowerCase();
  let list = entries.value;
  if (keyword) {
    list = list.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.path.toLowerCase().includes(keyword));
  } else {
    list = list.filter((entry) => entry.dir === state.currentDir);
  }
  if (state.kindFilter !== 'all' && state.kindFilter !== 'folder') {
    list = list.filter((entry) => entry.kind === state.kindFilter);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  switch (state.sort) {
    case 'kind':
      return [...list].sort((a, b) => a.kind.localeCompare(b.kind) || byName(a, b));
    case 'mtime':
      return [...list].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    case 'size':
      return [...list].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    default:
      return [...list].sort(byName);
  }
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
  if (keyword) list = list.filter((entry) => entry.name.toLowerCase().includes(keyword));
  else list = list.filter((entry) => entry.dir === state.currentDir);
  if (state.kindFilter !== 'all' && state.kindFilter !== 'folder') {
    list = list.filter((entry) => entry.kind === state.kindFilter);
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

const moveTargets = computed(() => [{ path: '', name: '资源库根目录' }, ...folders.value]);

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

// --------------------------------------------------------------- 动作

export async function refreshLibrary({ quiet = false } = {}) {
  if (!quiet) state.loading = true;
  state.refreshing = true;
  state.error = '';
  try {
    const data = await fetchLibraryTree();
    tree.value = {
      folders: data.folders ?? [],
      entries: data.entries ?? [],
      stats: data.stats ?? { ...EMPTY_STATS },
    };
    state.initialized = true;
    if (state.currentDir && !folders.value.some((folder) => folder.path === state.currentDir)) {
      state.currentDir = '';
    }
    preserveSelected();
    if (state.previewPath && !entries.value.some((entry) => entry.path === state.previewPath)) {
      state.previewPath = null;
    }
    if (!quiet) setStatus(`资源库已刷新：${stats.value.files} 个文件 · ${stats.value.folders} 个子目录`);
  } catch (err) {
    setError(`读取资源库失败：${err.message}`);
  } finally {
    state.loading = false;
    state.refreshing = false;
  }
}

export function setDir(dir) {
  state.currentDir = dir ?? '';
  state.previewPath = null;
  state.selected = [];
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

export function setSearch(value) {
  state.search = String(value ?? '');
}

export function setKindFilter(value) {
  state.kindFilter = value;
}

export function setSort(value) {
  state.sort = value;
}

export function setCurrentDir(path) {
  state.currentDir = path ?? '';
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
  const uploaded = [];

  try {
    for (const [index, file] of files.entries()) {
      state.upload.index = index + 1;
      state.upload.name = file.name;
      state.upload.percent = 0;

      // 拖入文件夹时浏览器会给出 webkitRelativePath，用它保留子目录结构。
      const relative = String(file.webkitRelativePath ?? '').replace(/\\/g, '/');
      const relativeDir = relative.includes('/') ? relative.split('/').slice(0, -1).join('/') : '';
      const dir = [baseDir, relativeDir].filter(Boolean).join('/');

      const result = await uploadLibraryFile(file, {
        dir,
        onProgress: (percent) => {
          state.upload.percent = percent;
        },
      });
      if (result?.entry) uploaded.push(result.entry);
      setStatus(`已上传 ${index + 1}/${files.length}：${file.name}`);
    }
    await refreshLibrary({ quiet: true });
    setStatus(`已上传 ${uploaded.length} 个文件到资源库`);
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
    await refreshLibrary({ quiet: true });
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

export async function renameOne(entry, name) {
  const target = String(name ?? '').trim();
  if (!target || target === entry.name) return true;
  state.busy = true;
  try {
    const result = await renameLibraryItems([{ path: entry.path, name: target }]);
    if (!result.ok) {
      const first = result.results?.find((item) => item.ok === false);
      throw new LibraryApiError(first?.error || '重命名失败', 'RENAME_FAILED');
    }
    await refreshLibrary({ quiet: true });
    setStatus(`已重命名为 ${target}`);
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
    const ext = extensionOf(entry.name);
    let base = baseOf(entry.name);
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
    const key = `${entry.dir}/${name.toLowerCase()}`;
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
    const result = await renameLibraryItems(rows.map(({ entry, name }) => ({ path: entry.path, name })));
    await refreshLibrary({ quiet: true });
    state.selected = [];
    const failed = failedCount(result);
    if (failed) setError(`批量改名部分失败：${failed} 项`);
    else setStatus(`已批量重命名 ${rows.length} 个文件`);
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
    const result = await moveLibraryItems([...state.selected], targetDir ?? '');
    await refreshLibrary({ quiet: true });
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

export async function deleteSelected() {
  if (!state.selected.length) {
    setError('请先选择要删除的文件或文件夹');
    return false;
  }
  state.busy = true;
  try {
    const result = await deleteLibraryItems([...state.selected]);
    await refreshLibrary({ quiet: true });
    state.selected = [];
    const failed = failedCount(result);
    if (failed) setError(`删除部分失败：${failed} 项`);
    else setStatus(`已删除 ${result.succeeded} 项`);
    return result.ok;
  } catch (err) {
    setError(`删除失败：${err.message}`);
    return false;
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
    const files = [];
    for (const entry of images) {
      const blob = await fetchLibraryBlob(entry);
      files.push(new File([blob], entry.name, { type: blob.type || 'image/png' }));
    }
    const workspace = useWorkspace();
    await workspace.actions.addFiles(files);
    const targetMode = images.length > 1 ? 'cropimage' : options.mode || 'crop';
    setMode(targetMode);
    setStatus(
      images.length > 1
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
    moveTargets,
    actions: {
      refresh: refreshLibrary,
      setDir,
      navigate,
      openFolder,
      goUp,
      setSearch,
      setKindFilter,
      setSort,
      setCurrentDir,
      toggleSelect,
      selectOnly,
      selectAllVisible,
      clearSelection,
      uploadFiles,
      saveBlobToLibrary,
      createFolder,
      renameOne,
      previewBatchRename,
      batchRename,
      moveSelected,
      deleteSelected,
      openPreview,
      closePreview,
      stepPreview,
      openInEditor,
      entryByPath,
    },
  };
}

export { baseOf as fileBaseName, extensionOf as fileExtension };
