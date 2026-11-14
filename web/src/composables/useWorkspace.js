/**
 * 工作区状态与全部业务动作。
 *
 * 说明：这是一个单窗口应用，因此状态以模块级单例维护（useWorkspace() 返回同一份），
 * 避免在 4 个面板之间层层透传 props。重负载对象（ImageBitmap / ImageData / ArrayBuffer）
 * 一律 markRaw，避免 Vue 深度代理带来的额外开销。
 */
import { computed, markRaw, reactive, readonly } from 'vue';
import { ALGORITHM, DEFAULT_OPTIONS, detectBounds } from '@shared/aabb.js';

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
import { canvasToBlob, createCanvas, cropToBlob, stripExtension } from '../lib/imageops.js';
import { mapLimit } from '../lib/async.js';
import { computeAtlasOutputSize, fitInto } from '../lib/atlas.js';
import { planSpriteSheet, spriteCellOrigin } from '../lib/sprite.js';

let uid = 0;

const state = reactive({
  items: [],
  selectedId: null,
  // 当前素材列表的多选（图集模式 / 批量抠图只作用于这些素材）
  checkedIds: [],
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
/** 已勾选的素材，按素材列表顺序返回。 */
const checkedItems = computed(() => state.items.filter((item) => state.checkedIds.includes(item.id)));

/**
 * 图集（透明裁剪）：把勾选素材各自的内容框换算成归一化坐标后取并集，
 * 得到「最大 AABB」；再用同一个相对框裁切每张图，序列帧构图才能对齐。
 *
 * 并集使用「去噪」AABB：单帧 AABB 只按 alpha > 1 判定内容，去背景残留的
 * alpha 2~6 杂点会落在很远的位置，一帧就能把整批并集撑大一大圈。
 * 因此并集统一忽略 alpha 小于 ATLAS_NOISE_ALPHA 的像素。
 */
export const ATLAS_NOISE_ALPHA = 8;

const noiseBoundsCache = new Map();

function atlasBounds(item) {
  const options = optionsSnapshot();
  const threshold = Math.max(options.alphaThreshold, ATLAS_NOISE_ALPHA);
  const key = [
    threshold,
    options.matchColor ? options.backgroundColor : '',
    options.colorTolerance,
    options.padding,
    item.width,
    item.height,
    item.detectedAt ?? 0,
  ].join('|');
  const hit = noiseBoundsCache.get(item.id);
  if (hit && hit.key === key) return hit.bounds;

  let bounds = item.bounds;
  if (item.imageData) {
    try {
      const result = detectBounds(item.imageData.data, item.width, item.height, { ...options, alphaThreshold: threshold });
      if (!result.empty) bounds = result.bounds;
    } catch {
      // 数据异常时退回单帧检测结果
    }
  }
  noiseBoundsCache.set(item.id, { key, bounds });
  return bounds;
}

const trimAtlas = computed(() => {
  const usable = checkedItems.value.filter((item) => item.bounds && !item.resultEmpty && item.width && item.height);
  const list = usable
    .map((item) => {
      const bounds = atlasBounds(item);
      return bounds && bounds.width > 0 && bounds.height > 0 ? { item, bounds } : null;
    })
    .filter(Boolean);
  if (!list.length) return null;

  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  for (const { item, bounds } of list) {
    left = Math.min(left, bounds.x / item.width);
    top = Math.min(top, bounds.y / item.height);
    right = Math.max(right, (bounds.x + bounds.width) / item.width);
    bottom = Math.max(bottom, (bounds.y + bounds.height) / item.height);
  }
  const norm = {
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: Math.min(1, right) - Math.max(0, left),
    height: Math.min(1, bottom) - Math.max(0, top),
  };
  const items = list.map((row) => row.item);
  // 各帧按同一个相对框裁出来以后，像素尺寸可能不同（源图尺寸不一致时）。
  // 统一尺寸取「最大裁剪宽高」，预览与批量裁剪都输出这个尺寸，帧与帧才能对齐播放/拼图。
  const outSize = computeAtlasOutputSize(items.map((item) => normRect(item, norm)));
  return { count: list.length, skipped: usable.length - list.length, items, norm, outSize };
});
/**
 * 多图合并精灵图的帧集合：勾选素材里所有可用图片都参与，**尺寸可以不同**。
 *
 * 单元格尺寸取各帧最大宽/高，每帧等比缩放后居中放进自己的格子（不拉伸、空白透明），
 * 具体排版由 lib/sprite.js 的 planSpriteSheet 统一算，导出与面板预览共用。
 */
const spriteMerge = computed(() => {
  const frames = checkedItems.value.filter((item) => item.bitmap && item.width > 0 && item.height > 0);
  if (!frames.length) return null;
  const cell = {
    width: Math.max(...frames.map((item) => item.width)),
    height: Math.max(...frames.map((item) => item.height)),
  };
  const sizeCount = new Set(frames.map((item) => `${item.width}x${item.height}`)).size;
  return { frames, cell, count: frames.length, sizeCount };
});

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

/** 解码一个文件为素材项（先不入列）：并行导入时先并行解码，再按原始顺序入列。 */
async function createItem(file) {
  const buffer = await file.arrayBuffer();
  const { bitmap, imageData, width, height } = await decodeToRgba(file);
  return reactive({
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
    /**
     * 像素版本：就地保存（saveEditedItem）后自增。
     * 用来让“按素材 id 缓存像素”的地方（临时会话的素材 Blob、各工具的编辑层）知道底图换了。
     */
    pixelVersion: 0,
  });
}

/** 导入单个图片文件：解码 → 建立素材项 → 自动检测 AABB。 */
async function addOneFile(file) {
  const item = await createItem(file);
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
  setStatus(`正在导入 ${all.length} 张图片…`);

  // 解码是 CPU + 内存密集型：限并发 3 并行解码，再按原始顺序入列，
  // 保证 libraryPaths 与素材列表顺序仍然一一对应。
  const failures = [];
  const decoded = await mapLimit(all, 3, async (file, index) => {
    try {
      return { file, index, item: await createItem(file) };
    } catch (err) {
      failures.push(err instanceof ImageDecodeError ? err.message : `无法读取「${file.name}」：${err.message}`);
      return null;
    }
  });

  const created = [];
  for (const row of decoded) {
    if (!row) continue;
    if (options.libraryPaths?.[row.index]) row.item.libraryPath = options.libraryPaths[row.index];
    state.items.push(row.item);
    created.push(row.item);
  }

  if (created.length) {
    state.selectedId = created[created.length - 1].id;
    // AABB 检测同样按并发跑，素材先出现在列表里（此时还没有裁剪框），体验比整批卡住好
    await mapLimit(created, 3, (item) => recomputeItem(item));
    setStatus(
      `已导入 ${created.length} 张素材` +
        (created.length > 1 ? `（${created[0].name} 等 ${created.length} 张）` : `（${created[0].name}）`),
    );
  }
  if (failures.length) setError(failures[0]);
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
  state.checkedIds = state.checkedIds.filter((checked) => checked !== id);
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
  state.checkedIds = [];
  setStatus('已清空素材');
}

export function selectItem(id) {
  state.selectedId = id;
}

// --------------------------------------------------------------- 排序

/** 按文件名排序（中文按拼音、数字按自然序），选中与勾选状态保持不变。 */
export function sortItemsByName() {
  if (state.items.length < 2) return;
  recordHistory();
  const sorted = [...state.items].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
  );
  state.items.splice(0, state.items.length, ...sorted);
  setStatus(`已按名称排序（${sorted.length} 张）`);
}

/**
 * 手动拖拽排序：把 draggedId 插到 targetId 前（after=true 时插到其后）。
 * 一次拖放只记一条历史，撤销可回到拖动前的顺序。
 */
export function moveItem(draggedId, targetId, after = false) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const from = state.items.findIndex((item) => item.id === draggedId);
  if (from < 0) return;
  const targetIndex = state.items.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return;
  recordHistory();
  const [moved] = state.items.splice(from, 1);
  const insertAt = state.items.findIndex((item) => item.id === targetId) + (after ? 1 : 0);
  state.items.splice(insertAt, 0, moved);
  setStatus(`已把「${moved.name}」移到第 ${insertAt + 1} 位`);
}

// --------------------------------------------------------------- 多选

export function toggleCheckedItem(id) {
  const index = state.checkedIds.indexOf(id);
  if (index >= 0) state.checkedIds.splice(index, 1);
  else state.checkedIds.push(id);
}

export function setCheckedItems(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  state.checkedIds = state.items.filter((item) => wanted.has(item.id)).map((item) => item.id);
}

export function checkAllItems() {
  state.checkedIds = state.items.map((item) => item.id);
}

export function clearCheckedItems() {
  state.checkedIds = [];
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

/** 把单张素材的透明裁剪结果写入资源库/裁剪结果。 */
export async function saveTrimmedItem(item) {
  if (!item?.bounds || item.resultEmpty) {
    setError('这张图片没有可裁剪的内容');
    return;
  }
  state.busy = true;
  try {
    const { saveBlobToLibrary } = await import('./useLibrary.js');
    const filename = croppedFilename(item.name, 'png');
    const { blob } = await cropWith(state.engine, item, optionsSnapshot(), {
      format: 'png',
      quality: 100,
      filename,
    });
    const entry = await saveBlobToLibrary(blob, filename, '裁剪结果');
    setStatus(`已保存到资源库：${entry?.path ?? `裁剪结果/${filename}`}`);
  } catch (err) {
    setError(`保存到资源库失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

/**
 * 就地保存：把处理结果写回**当前素材**，不新增素材条目。
 *
 * 行为：
 *  1. 覆盖资源库里的同一个文件（必要时先改名成 .png）。旧内容由服务端存成历史版本，
 *     可以在资源库检查器里回滚；素材还没进资源库时（示例图 / 拖进来的文件），
 *     先在资源库根目录建一个同名 PNG，后续保存就覆盖它。
 *  2. 素材项的像素 / 尺寸 / 缩略图原地更新，id、列表位置、选中状态都不变，
 *     所以「当前图片」就是处理结果，可以接着在这个结果上继续编辑。
 *
 * @param {object} item 目标素材项
 * @param {Blob} blob 编辑结果（PNG，保留 alpha）
 * @returns {Promise<{entry:object|null,path:string,item:object}|null>}
 */
export async function saveEditedItem(item, blob) {
  if (!item || !blob) {
    setError('没有可保存的内容');
    return null;
  }
  const previousPath = item.libraryPath || '';
  state.busy = true;
  state.error = '';
  try {
    const { saveBlobToLibraryPath } = await import('./useLibrary.js');
    const saved = await saveBlobToLibraryPath(blob, { path: previousPath, name: item.name });
    const buffer = await blob.arrayBuffer();
    const { bitmap, imageData, width, height } = await decodeToRgba(blob);

    item.bitmap = markRaw(bitmap);
    item.imageData = markRaw(imageData);
    item.buffer = markRaw(buffer);
    item.bytes = buffer.byteLength;
    item.width = width;
    item.height = height;
    item.thumbnail = markRaw(makeThumbnail(bitmap, 160));
    item.type = blob.type || 'image/png';
    item.name = saved.entry?.name || item.name;
    item.libraryPath = saved.path;
    item.pixelVersion = (Number(item.pixelVersion) || 0) + 1;
    // 像素和尺寸都换了：内容框按新图重新检测（detectedAt 归零，图集噪声缓存也会重建）
    item.detectedAt = 0;
    await recomputeItem(item);

    setStatus(
      previousPath
        ? `已保存到当前素材：${saved.path}（旧内容已存入历史版本）`
        : `已保存到资源库：${saved.path}（当前素材已绑定，之后保存直接覆盖）`,
    );
    return { entry: saved.entry ?? null, path: saved.path, item };
  } catch (err) {
    setError(`保存到当前素材失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/** 透明裁剪：把 AABB 裁剪结果写回当前素材（不新增素材）。 */
export async function saveTrimmedInPlace(item) {
  if (!item?.bounds || item.resultEmpty) {
    setError('这张图片没有可裁剪的内容');
    return null;
  }
  state.busy = true;
  try {
    const filename = croppedFilename(item.name, 'png');
    const { blob } = await cropWith(state.engine, item, optionsSnapshot(), { format: 'png', quality: 100, filename });
    return await saveEditedItem(item, blob);
  } catch (err) {
    setError(`保存到当前素材失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/** 归一化取景框 → 当前素材的像素矩形；批量裁剪与预览共用，保证两者结果一致。 */
function normRect(item, norm) {
  const x = Math.max(0, Math.min(item.width - 1, Math.round(norm.x * item.width)));
  const y = Math.max(0, Math.min(item.height - 1, Math.round(norm.y * item.height)));
  const width = Math.max(1, Math.min(item.width - x, Math.round(norm.width * item.width)));
  const height = Math.max(1, Math.min(item.height - y, Math.round(norm.height * item.height)));
  return { x, y, width, height };
}

async function cropByNorm(item, norm) {
  const rect = normRect(item, norm);
  return cropToBlob(item.bitmap, rect, rect, { type: 'image/png' });
}

/**
 * 图集统一尺寸裁帧：按并集取景框裁出这一帧，再按比例居中放进统一尺寸。
 *
 * 比例一致时正好铺满（等比缩放）；源图比例不同时留透明边，不做拉伸。
 * 预览与真正的「图集透明裁剪」都走这里，保证看到的尺寸就是最终输出尺寸。
 */
async function cropAtlasFrame(item, norm, outSize) {
  const rect = normRect(item, norm);
  const canvas = createCanvas(outSize.width, outSize.height);
  const ctx = canvas.getContext('2d');
  const fit = fitInto(rect, outSize);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(item.bitmap, rect.x, rect.y, rect.width, rect.height, fit.dx, fit.dy, fit.dw, fit.dh);
  return canvasToBlob(canvas, 'image/png');
}

/**
 * 图集透明裁剪预览：按当前并集取景框把**全部**勾选素材裁出来。
 *
 * 和真正的「图集透明裁剪」走同一个 cropByNorm，所以预览看到的就是裁切后的效果
 * （不是原图 + 取景框）。张数可能很多，所以：
 *  - 并发 3 张边裁边回调（onResult / onProgress），面板可以渐进显示；
 *  - 只读，不写入素材列表 / 资源库；调用方负责 revokeObjectURL 释放。
 *
 * @param {{onResult?:(row:object)=>void, onProgress?:(info:{done:number,total:number})=>void}} [options]
 */
export async function previewAtlasCrop({ onResult, onProgress } = {}) {
  const atlas = trimAtlas.value;
  if (!atlas) {
    setError('请先在左侧「当前素材」勾选要图集透明裁剪的图片');
    return null;
  }
  const items = atlas.items;
  const outSize = atlas.outSize;
  const rows = new Array(items.length);
  let done = 0;
  await mapLimit(items, 3, async (item, index) => {
    try {
      const rect = normRect(item, atlas.norm);
      const blob = await cropAtlasFrame(item, atlas.norm, outSize);
      const row = {
        id: item.id,
        index,
        name: item.name,
        url: URL.createObjectURL(blob),
        sourceWidth: item.width,
        sourceHeight: item.height,
        width: outSize.width,
        height: outSize.height,
        cropWidth: rect.width,
        cropHeight: rect.height,
      };
      rows[index] = row;
      onResult?.(row);
    } catch (err) {
      console.warn('[workspace] 图集裁剪预览失败:', item.name, err.message);
    }
    done += 1;
    onProgress?.({ done, total: items.length });
  });
  return {
    count: atlas.count,
    total: items.length,
    norm: { ...atlas.norm },
    outSize: { ...outSize },
    results: rows.filter(Boolean),
  };
}

/** 图集透明裁剪：所有勾选素材共用最大 AABB，结果写回素材列表，可选存入资源库。 */
export async function trimAtlasBatch({ saveToLibrary = true } = {}) {
  const atlas = trimAtlas.value;
  if (!atlas) {
    setError('请先在左侧「当前素材」勾选要图集透明裁剪的图片');
    return;
  }
  state.busy = true;
  let done = 0;
  let failed = 0;
  try {
    const { saveBlobToLibrary } = await import('./useLibrary.js');
    const outSize = atlas.outSize;
    for (const item of atlas.items) {
      try {
        const blob = await cropAtlasFrame(item, atlas.norm, outSize);
        const filename = `${stripExtension(item.name)}-透明裁剪.png`;
        await addImageBlob(blob, filename);
        if (saveToLibrary) await saveBlobToLibrary(blob, filename, '裁剪结果');
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn('[workspace] 图集透明裁剪失败:', item.name, err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setStatus(
      `图集透明裁剪完成：${done}/${atlas.count} 张 · 统一 ${outSize.width}×${outSize.height}${
        saveToLibrary ? '，已存入资源库/裁剪结果' : ''
      }${failed ? `，失败 ${failed} 张` : ''}`,
    );
  } finally {
    state.busy = false;
  }
}

/**
 * 合并精灵图：把勾选的所有图片按行列拼成一张 PNG（尺寸不同也能合）。
 *
 * columns=0 时按 ⌈√N⌉ 自动决定列数；gap 为帧间距（像素，透明填充）；
 * maxSide>0 时按比例缩小输出，供面板预览用（避免每次改参数都生成大图）。
 */
export async function buildSpriteSheet({ columns = 0, gap = 0, maxSide = 0, fit = 'contain' } = {}) {
  const merge = spriteMerge.value;
  if (!merge) return null;
  const plan = planSpriteSheet({
    sizes: merge.frames.map((item) => ({ width: item.width, height: item.height })),
    columns,
    gap,
  });
  if (!plan) return null;

  const fitScale = maxSide > 0 ? Math.min(1, maxSide / Math.max(plan.width, plan.height)) : 1;
  const sheetWidth = Math.max(1, Math.round(plan.width * fitScale));
  const sheetHeight = Math.max(1, Math.round(plan.height * fitScale));
  const canvas = createCanvas(sheetWidth, sheetHeight);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  merge.frames.forEach((item, index) => {
    const origin = spriteCellOrigin(plan, index);
    // contain（默认）：等比缩放到单元格，帧与帧视觉大小统一；
    // original：保持原始像素不缩放，只在单元格里居中（小图不会被打采样放大）。
    const placement =
      fit === 'original'
        ? {
            dx: Math.round((plan.cell.width - item.width) / 2),
            dy: Math.round((plan.cell.height - item.height) / 2),
            dw: item.width,
            dh: item.height,
          }
        : fitInto({ width: item.width, height: item.height }, { width: plan.cell.width, height: plan.cell.height });
    ctx.drawImage(
      item.bitmap,
      Math.round((origin.x + placement.dx) * fitScale),
      Math.round((origin.y + placement.dy) * fitScale),
      Math.max(1, Math.round(placement.dw * fitScale)),
      Math.max(1, Math.round(placement.dh * fitScale)),
    );
  });

  return { canvas, width: sheetWidth, height: sheetHeight, plan, scale: fitScale, count: merge.frames.length };
}

/**
 * 多图合并为精灵图并输出。
 * @param {{columns?:number, gap?:number, target?:'download'|'asset'|'library'}} options
 */
export async function exportSpriteSheet({ columns = 0, gap = 0, target = 'download', fit = 'contain' } = {}) {
  const merge = spriteMerge.value;
  if (!merge) {
    setError('请先在左侧「当前素材」勾选要合并成精灵图的图片');
    return null;
  }

  state.busy = true;
  try {
    const built = await buildSpriteSheet({ columns, gap, fit });
    const blob = await canvasToBlob(built.canvas, 'image/png');
    const { plan } = built;
    const filename = `${stripExtension(merge.frames[0].name)}-sprite-${plan.cols}x${plan.rows}.png`;
    const summary = `${built.width}×${built.height}，${merge.count} 帧 · ${plan.cols} 列 × ${plan.rows} 行`;

    if (target === 'asset') {
      await addImageBlob(blob, filename);
      setStatus(`已生成精灵图素材 ${filename}（${summary}）`);
    } else if (target === 'library') {
      const { saveBlobToLibrary } = await import('./useLibrary.js');
      await saveBlobToLibrary(blob, filename, '精灵图');
      setStatus(`已把精灵图存入资源库：精灵图/${filename}（${summary}）`);
    } else {
      downloadBlob(blob, filename);
      setStatus(`已导出精灵图 ${filename}（${summary}）`);
    }
    return { ...built, blob, filename };
  } catch (err) {
    setError(`合并精灵图失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
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
    pixelVersion: item.pixelVersion ?? 0,
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

  // 恢复素材要逐张 createImageBitmap + getImageData，是整个启动里最重的一段。
  // 限并发 3 并行解码，再按快照顺序入列（18 张实测恢复耗时约 1.15s → 0.9s）。
  const metas = (snapshot.items ?? []).filter((meta) => meta?.id && blobs[`asset:${meta.id}`]);
  const decoded = await mapLimit(metas, 3, async (meta) => {
    const blob = blobs[`asset:${meta.id}`];
    try {
      const buffer = await blob.arrayBuffer();
      const { bitmap, imageData, width, height } = await decodeToRgba(blob);
      return { meta, blob, buffer, bitmap, imageData, width, height };
    } catch (err) {
      console.warn('[session] 素材恢复失败:', meta?.id, err.message);
      return null;
    }
  });

  for (const row of decoded) {
    if (!row) continue;
    const { meta, blob, buffer, bitmap, imageData, width, height } = row;
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
      pixelVersion: Number(meta.pixelVersion) || 0,
    });
    // id 是运行期自增的，恢复后要把计数器推到最大值，避免新素材撞 id
    const numeric = Number(String(meta.id).replace(/^img-/, ''));
    if (Number.isFinite(numeric)) uid = Math.max(uid, numeric);
    state.items.push(item);
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
    checkedItems,
    trimAtlas,
    spriteMerge,
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
      sortItemsByName,
      moveItem,
      toggleCheckedItem,
      setCheckedItems,
      checkAllItems,
      clearCheckedItems,
      setEngine,
      setOption,
      setOutput,
      setView,
      resetOptions,
      exportItem,
      exportAll,
      copyBounds,
      saveTrimmedItem,
      saveTrimmedInPlace,
      saveEditedItem,
      trimAtlasBatch,
      previewAtlasCrop,
      buildSpriteSheet,
      exportSpriteSheet,
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
