/**
 * 工作区状态与全部业务动作。
 *
 * 说明：这是一个单窗口应用，因此状态以模块级单例维护（useWorkspace() 返回同一份），
 * 避免在 4 个面板之间层层透传 props。重负载对象（ImageBitmap / ImageData / ArrayBuffer）
 * 一律 markRaw，避免 Vue 深度代理带来的额外开销。
 */
import { computed, markRaw, reactive, readonly } from 'vue';
import { ALGORITHM, DEFAULT_OPTIONS } from '@shared/aabb.js';

import {
  ImageDecodeError,
  croppedFilename,
  decodeToRgba,
  downloadBlob,
  formatBytes,
  makeThumbnail,
} from '../lib/imaging.js';
import { analyzeWith, cropWith } from '../lib/engine.js';
import { blobToBytes, createZip } from '../lib/zip.js';
import { onLibraryPathsMoved, remapLibraryPath } from '../lib/pathMoves.js';
import { canvasToBlob } from '../lib/imageops.js';

let uid = 0;

const state = reactive({
  items: [],
  selectedId: null,
  engine: 'client',
  output: { format: 'png', quality: 92 },
  options: {
    alphaThreshold: DEFAULT_OPTIONS.alphaThreshold,
    padding: DEFAULT_OPTIONS.padding,
    matchColor: DEFAULT_OPTIONS.matchColor,
    backgroundColor: DEFAULT_OPTIONS.backgroundColor,
    colorTolerance: DEFAULT_OPTIONS.colorTolerance,
  },
  view: { mode: 'source', showBox: true, zoom: 'fit' },
  theme: 'dark',
  busy: false,
  status: '',
  error: '',
  server: { checked: false, ok: false, sharp: null, algorithm: null },
});

const selected = computed(() => state.items.find((item) => item.id === state.selectedId) ?? null);
const stats = computed(() => {
  const total = state.items.length;
  const ready = state.items.filter((item) => item.bounds && !item.empty).length;
  const empty = state.items.filter((item) => item.resultEmpty).length;
  const sourceBytes = state.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  return { total, ready, empty, sourceBytes };
});

// 资源库改名 / 移动后，已载入素材的来源路径跟着更新，避免再次打开时重复导入
onLibraryPathsMoved((moves) => {
  for (const item of state.items) {
    if (item.libraryPath) item.libraryPath = remapLibraryPath(item.libraryPath, moves);
  }
});

// --------------------------------------------------------------- 内部工具

let recomputeTimer = null;

function optionsSnapshot() {
  return {
    alphaThreshold: state.options.alphaThreshold,
    padding: state.options.padding,
    matchColor: state.options.matchColor,
    backgroundColor: state.options.backgroundColor,
    colorTolerance: state.options.colorTolerance,
  };
}

function scheduleRecompute({ immediate = false } = {}) {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  if (immediate) {
    void recomputeAll();
    return;
  }
  // 拖动滑块时合并计算，避免每一帧都跑全图扫描
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    void recomputeAll();
  }, 90);
}

/** 检测单张图片；服务端失败时自动回退到浏览器引擎并提示。 */
export async function recomputeItem(item) {
  if (!item.imageData) return;
  const options = optionsSnapshot();
  try {
    const result = await analyzeWith(state.engine, item, options);
    item.bounds = result.bounds;
    item.trimmed = result.trimmed;
    item.resultEmpty = result.empty;
    item.contentPixels = result.contentPixels;
    item.contentRatio = result.contentRatio;
    item.engine = result.engine;
    item.elapsedMs = result.elapsedMs;
    item.detectedAt = Date.now();
    item.error = '';
    if (state.engine === 'server') {
      item.serverSource = result.source ?? null;
      item.isPalette = Boolean(result.source?.isPalette);
    }
  } catch (err) {
    item.error = err.message;
    if (state.engine === 'server') {
      const fallback = await analyzeWith('client', item, options);
      item.bounds = fallback.bounds;
      item.trimmed = fallback.trimmed;
      item.resultEmpty = fallback.empty;
      item.contentPixels = fallback.contentPixels;
      item.contentRatio = fallback.contentRatio;
      item.engine = `${fallback.engine} (服务端不可用，已回退)`;
      item.elapsedMs = fallback.elapsedMs;
    }
  }
}

export async function recomputeAll() {
  if (state.items.length === 0) return;
  await Promise.all(state.items.map((item) => recomputeItem(item)));
}

// --------------------------------------------------------------- 历史

const HISTORY_LIMIT = 20;
const RECORD_GAP = 500;
const history = reactive([]);
const redo = reactive([]);
let lastRecord = { group: '', at: 0 };

/**
 * 素材列表快照只保存引用：图片像素不动，撤销增删/清空时直接换回数组即可。
 * 分析结果不是快照的一部分，恢复参数后会重新计算。
 */
function workspaceSnapshot() {
  return {
    items: [...state.items],
    selectedId: state.selectedId,
    options: { ...state.options },
    engine: state.engine,
  };
}

function pushHistory(snapshot) {
  history.push(snapshot);
  if (history.length > HISTORY_LIMIT) history.shift();
  redo.splice(0, redo.length);
}

/** group 相同的连续操作（滑块、数字输入）在 500ms 内合并为一条。 */
function recordHistory(group = '') {
  const now = performance.now();
  if (group && lastRecord.group === group && now - lastRecord.at < RECORD_GAP) {
    lastRecord.at = now;
    return;
  }
  lastRecord = { group, at: now };
  pushHistory(workspaceSnapshot());
}

function applySnapshot(snapshot) {
  if (recomputeTimer) {
    clearTimeout(recomputeTimer);
    recomputeTimer = null;
  }
  state.items.splice(0, state.items.length, ...snapshot.items);
  state.selectedId = snapshot.selectedId;
  Object.assign(state.options, snapshot.options);
  state.engine = snapshot.engine;
  scheduleRecompute({ immediate: true });
}

export function undoWorkspace() {
  if (!history.length) return false;
  redo.push(workspaceSnapshot());
  applySnapshot(history.pop());
  setStatus('已撤销工作区操作');
  return true;
}

export function redoWorkspace() {
  if (!redo.length) return false;
  history.push(workspaceSnapshot());
  applySnapshot(redo.pop());
  setStatus('已重做工作区操作');
  return true;
}

function resetHistory() {
  history.splice(0, history.length);
  redo.splice(0, redo.length);
  lastRecord = { group: '', at: 0 };
}

const canUndoAssets = computed(() => history.length > 0);
const canRedoAssets = computed(() => redo.length > 0);

// --------------------------------------------------------------- 动作

/** 导入单个图片文件：解码 → 建立素材项 → 自动检测 AABB。 */
async function addOneFile(file) {
  const buffer = await file.arrayBuffer();
  const { bitmap, imageData, width, height } = await decodeToRgba(file);
  const item = reactive({
    id: `img-${++uid}`,
    name: file.name || `image-${uid}`,
    type: file.type || 'application/octet-stream',
    bytes: buffer.byteLength,
    width,
    height,
    thumbnail: markRaw(makeThumbnail(bitmap, 160)),
    bitmap: markRaw(bitmap),
    imageData: markRaw(imageData),
    buffer: markRaw(buffer),
    bounds: null,
    trimmed: null,
    resultEmpty: false,
    contentPixels: 0,
    contentRatio: 0,
    engine: '',
    elapsedMs: 0,
    error: '',
    detectedAt: 0,
    /** 来源资源库路径；同一张库图片再次打开时直接选中，不重复建素材 */
    libraryPath: '',
  });
  state.items.push(item);
  state.selectedId = item.id;
  await recomputeItem(item);
  return item;
}

/**
 * 批量导入图片文件。
 * options.libraryPaths 与文件顺序一一对应，用于记住来源资源库路径；
 * 返回值是本次实际建立的素材项，便于调用方继续选中 / 标记来源。
 */
export async function addFiles(fileList, options = {}) {
  const files = [...(fileList ?? [])].filter((file) => file && /^image\//.test(file.type || '') );
  const fallbackFiles = [...(fileList ?? [])].filter((file) => file && !/^image\//.test(file.type || ''));
  const all = [...files, ...fallbackFiles];
  if (all.length === 0) return [];

  recordHistory();
  state.busy = true;
  state.error = '';
  const created = [];
  for (const [index, file] of all.entries()) {
    try {
      const item = await addOneFile(file);
      if (options.libraryPaths?.[index]) item.libraryPath = options.libraryPaths[index];
      created.push(item);
      setStatus(`已导入 ${item.name}（${item.width}×${item.height}）`);
    } catch (err) {
      const message = err instanceof ImageDecodeError ? err.message : `无法读取「${file.name}」：${err.message}`;
      setError(message);
    }
  }
  state.busy = false;
  return created;
}

/**
 * 把处理结果（Blob）作为新素材加入工作区。
 * 裁剪 / 背景去除 / 橡皮擦都通过它产出新图，原始素材保持不变，便于对比与继续处理。
 */
export async function addImageBlob(blob, name) {
  if (!blob) return null;
  recordHistory();
  state.busy = true;
  state.error = '';
  try {
    const file = new File([blob], name || `result-${Date.now()}.png`, { type: blob.type || 'image/png' });
    const item = await addOneFile(file);
    setStatus(`已生成新素材 ${item.name}（${item.width}×${item.height}）`);
    return item;
  } catch (err) {
    setError(`生成素材失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/** 从 Node 服务端拉取 samples/ 里的示例图片。 */
export async function loadSamples() {
  state.busy = true;
  state.error = '';
  try {
    const res = await fetch('/api/samples');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { samples } = await res.json();
    if (!samples?.length) throw new Error('服务端 samples/ 目录为空');

    for (const sample of samples) {
      if (state.items.some((item) => item.name === sample.name)) continue;
      const imageRes = await fetch(sample.url);
      if (!imageRes.ok) throw new Error(`示例图下载失败：${sample.name}`);
      const blob = await imageRes.blob();
      const file = new File([blob], sample.name, { type: blob.type || 'image/webp' });
      await addFiles([file]);
    }
    setStatus(`已载入 ${samples.length} 张示例图片`);
  } catch (err) {
    setError(`载入示例失败：${err.message}（请确认 Node 服务已启动: npm run dev:server）`);
  } finally {
    state.busy = false;
  }
}

export function removeItem(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  recordHistory();
  const [removed] = state.items.splice(index, 1);
  if (state.selectedId === id) {
    state.selectedId = state.items[Math.min(index, state.items.length - 1)]?.id ?? null;
  }
  setStatus(`已移除 ${removed.name}`);
}

export function clearItems() {
  if (!state.items.length) return;
  recordHistory();
  state.items.splice(0, state.items.length);
  state.selectedId = null;
  setStatus('已清空素材');
}

export function selectItem(id) {
  state.selectedId = id;
}

export function resetOptions() {
  recordHistory();
  Object.assign(state.options, {
    alphaThreshold: DEFAULT_OPTIONS.alphaThreshold,
    padding: DEFAULT_OPTIONS.padding,
    matchColor: DEFAULT_OPTIONS.matchColor,
    backgroundColor: DEFAULT_OPTIONS.backgroundColor,
    colorTolerance: DEFAULT_OPTIONS.colorTolerance,
  });
  scheduleRecompute({ immediate: true });
  setStatus('检测参数已重置为默认值');
}

export async function setEngine(engine) {
  if (state.engine === engine) return;
  recordHistory();
  state.engine = engine;
  await recomputeAll();
  setStatus(engine === 'server' ? '已切换到 Node 引擎（服务端 sharp 计算）' : '已切换到浏览器引擎（本地即时计算）');
}

export function setOption(key, value) {
  if (!(key in state.options) || state.options[key] === value) return;
  recordHistory(`option:${key}`);
  state.options[key] = value;
  scheduleRecompute();
}

export function setOutput(key, value) {
  state.output[key] = value;
}

export function setView(key, value) {
  state.view[key] = value;
}

export function setStatus(message) {
  state.status = message;
  state.error = '';
}

export function setError(message) {
  state.error = message;
  state.status = '';
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
}

// --------------------------------------------------------------- 导出

export async function exportItem(item) {
  if (!item?.bounds || item.resultEmpty) {
    setError('这张图片没有可裁剪的内容');
    return;
  }
  state.busy = true;
  try {
    const filename = croppedFilename(item.name, state.output.format);
    const { blob } = await cropWith(state.engine, item, optionsSnapshot(), {
      format: state.output.format,
      quality: state.output.quality,
      filename,
    });
    downloadBlob(blob, filename);
    setStatus(`已导出 ${filename}（${formatBytes(blob.size)}）`);
  } catch (err) {
    setError(`导出失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

export async function exportAll() {
  const targets = state.items.filter((item) => item.bounds && !item.resultEmpty);
  if (targets.length === 0) {
    setError('没有可导出的图片');
    return;
  }
  state.busy = true;
  try {
    const entries = [];
    for (const item of targets) {
      const filename = croppedFilename(item.name, state.output.format);
      const { blob } = await cropWith(state.engine, item, optionsSnapshot(), {
        format: state.output.format,
        quality: state.output.quality,
        filename,
      });
      entries.push({ name: filename, data: await blobToBytes(blob) });
    }
    const zip = createZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(zip, `image-clip-${stamp}.zip`);
    setStatus(`已打包导出 ${entries.length} 张（${formatBytes(zip.size)}）`);
  } catch (err) {
    setError(`批量导出失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

export async function copyBounds(item) {
  if (!item?.bounds || item.resultEmpty) return;
  const text = JSON.stringify({ ...item.bounds, source: { width: item.width, height: item.height } });
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`已复制裁剪框坐标 ${text}`);
  } catch {
    setError('浏览器拒绝了剪贴板写入');
  }
}

/** 挂载时检查 Node 服务端能力（状态栏展示）。 */
export async function checkServer() {
  try {
    const res = await fetch('/api/health');
    const body = await res.json();
    state.server = {
      checked: true,
      ok: Boolean(body.ok),
      sharp: body.sharp ?? null,
      algorithm: body.algorithm ?? null,
      engine: body.engine ?? null,
      outputFormats: body.outputFormats ?? [],
    };
  } catch {
    state.server = { checked: true, ok: false, sharp: null, algorithm: null };
  }
  return state.server;
}

// --------------------------------------------------------------- 临时会话

/** 只保存可序列化的素材元信息；像素数据由 IndexedDB 的 Blob 负责。 */
function sessionItemMeta(item) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    bytes: item.bytes,
    width: item.width,
    height: item.height,
    bounds: item.bounds ? { ...item.bounds } : null,
    trimmed: item.trimmed ? { ...item.trimmed } : null,
    resultEmpty: item.resultEmpty,
    contentPixels: item.contentPixels,
    contentRatio: item.contentRatio,
    engine: item.engine,
    elapsedMs: item.elapsedMs,
    error: item.error,
    detectedAt: item.detectedAt,
    libraryPath: item.libraryPath,
  };
}

/** 导出单个素材的原始字节（优先保留上传时的编码，避免二次转码）。 */
export async function exportItemBlob(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return null;
  if (item.buffer && item.buffer.byteLength > 0) {
    return new Blob([item.buffer], { type: item.type || 'image/png' });
  }
  if (!item.bitmap) return null;
  const canvas = document.createElement('canvas');
  canvas.width = item.width;
  canvas.height = item.height;
  canvas.getContext('2d').drawImage(item.bitmap, 0, 0);
  return canvasToBlob(canvas, 'image/png');
}

/**
 * 导出工作区现场。
 * withBlobs=false 时只给文档，供自动保存按需补图片（避免每次保存都复制大图）。
 */
export async function exportSession({ withBlobs = true } = {}) {
  const doc = {
    selectedId: state.selectedId,
    engine: state.engine,
    output: { ...state.output },
    options: { ...state.options },
    view: { ...state.view },
    theme: state.theme,
    items: state.items.map(sessionItemMeta),
  };
  const blobs = new Map();
  if (withBlobs) {
    for (const item of state.items) {
      const blob = await exportItemBlob(item.id);
      if (blob) blobs.set(`asset:${item.id}`, blob);
    }
  }
  return { doc, blobs };
}

/**
 * 恢复工作区现场：先把旧素材全部清掉，再按 Blob 重新解码。
 * 素材 id 必须原样恢复——橡皮擦 / 像素 / 水印的 entries 都以 id 为键。
 */
export async function importSession(snapshot, blobs = {}) {
  // 历史栈不随会话持久化，恢复现场后从干净状态开始
  resetHistory();
  state.items.splice(0, state.items.length);
  state.selectedId = null;

  if (!snapshot || typeof snapshot !== 'object') return [];

  for (const meta of snapshot.items ?? []) {
    const blob = blobs[`asset:${meta?.id}`];
    if (!blob) continue;
    try {
      const buffer = await blob.arrayBuffer();
      const { bitmap, imageData, width, height } = await decodeToRgba(blob);
      const item = reactive({
        id: String(meta.id),
        name: meta.name || `image-${meta.id}`,
        type: meta.type || blob.type || 'image/png',
        bytes: buffer.byteLength || meta.bytes || 0,
        width,
        height,
        thumbnail: markRaw(makeThumbnail(bitmap, 160)),
        bitmap: markRaw(bitmap),
        imageData: markRaw(imageData),
        buffer: markRaw(buffer),
        bounds: meta.bounds ? { ...meta.bounds } : null,
        trimmed: meta.trimmed ? { ...meta.trimmed } : null,
        resultEmpty: Boolean(meta.resultEmpty),
        contentPixels: Number(meta.contentPixels) || 0,
        contentRatio: Number(meta.contentRatio) || 0,
        engine: meta.engine || '',
        elapsedMs: Number(meta.elapsedMs) || 0,
        error: '',
        detectedAt: Number(meta.detectedAt) || 0,
        libraryPath: meta.libraryPath || '',
      });
      // id 是运行期自增的，恢复后要把计数器推到最大值，避免新素材撞 id
      const numeric = Number(String(meta.id).replace(/^img-/, ''));
      if (Number.isFinite(numeric)) uid = Math.max(uid, numeric);
      state.items.push(item);
    } catch (err) {
      console.warn('[session] 素材恢复失败:', meta?.id, err.message);
    }
  }

  state.engine = snapshot.engine === 'server' ? 'server' : 'client';
  Object.assign(state.output, { format: 'png', quality: 92 }, snapshot.output ?? {});
  Object.assign(state.options, DEFAULT_OPTIONS, snapshot.options ?? {});
  Object.assign(state.view, { mode: 'source', showBox: true, zoom: 'fit' }, snapshot.view ?? {});
  if (snapshot.theme === 'light' || snapshot.theme === 'dark') {
    state.theme = snapshot.theme;
    document.documentElement.dataset.theme = state.theme;
  }

  const exists = state.items.some((item) => item.id === snapshot.selectedId);
  state.selectedId = exists ? snapshot.selectedId : state.items[state.items.length - 1]?.id ?? null;
  return state.items;
}

/** 素材保存到资源库后回填来源路径（用于列表标记与重复导入判断）。 */
export function setItemLibraryPath(id, path) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  item.libraryPath = path || '';
}

export function useWorkspace() {
  return {
    state: readonly(state),
    selected,
    stats,
    canUndoAssets,
    canRedoAssets,
    actions: {
      undoWorkspace,
      redoWorkspace,
      addFiles,
      addImageBlob,
      loadSamples,
      removeItem,
      setItemLibraryPath,
      clearItems,
      selectItem,
      setEngine,
      setOption,
      setOutput,
      setView,
      resetOptions,
      exportItem,
      exportAll,
      copyBounds,
      checkServer,
      toggleTheme,
      recomputeAll,
      exportSession,
      exportItemBlob,
      importSession,
    },
    meta: { ALGORITHM },
  };
}
