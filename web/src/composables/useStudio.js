/**
 * 合成工作室（图层 / 蒙版 / 调色 / 选区 / 关键帧动画 / 图集导出）
 * -------------------------------------------------------------
 * 这一层负责把「素材列表里的图片」变成「文档里的图层」，以及所有面板动作。
 * 像素渲染在 lib/studio/render.js，纯数据在 shared/compose/doc.js，
 * 这里只做状态与编排，避免变成第三个算法实现。
 *
 * 设计约束（和现有九个工作区保持一致）：
 *  - 不改动素材本体：所有操作只改文档，导出才写回资源库；
 *  - 撤销/重做走快照，位图与蒙版共享引用，一步不复制像素；
 *  - 预览按最长边 1600px 渲染，导出才按文档原尺寸重算。
 */
import { computed, markRaw, reactive } from 'vue';

import {
  addLayer,
  createHistory,
  createLayer,
  createDoc,
  duplicateLayer,
  findLayer,
  hitTest,
  moveLayer,
  patchLayer,
  removeLayer,
  serializeDoc,
} from '@shared/compose/doc.js';
import { DEFAULT_ADJUST, encodeCube, isAdjustActive, lutFromAdjust, normalizeAdjust, parseCube } from '@shared/color/lut.js';
import {
  TRACK_PROPS,
  createAnimation,
  ensureTrack,
  hasKeyAt,
  keyframeTimes,
  loopTime,
  removeKey,
  sampleAnimation,
  setKey,
  sampleTrack,
  EASING_PRESETS,
} from '@shared/anim/keyframes.js';
import {
  combineMask,
  createMask,
  expandMask,
  featherMask,
  invertMask,
  magicWand,
  maskBounds,
  maskCoverage,
} from '@shared/maskops.js';
import { buildAtlasBundle } from '@shared/atlas/meta.js';

import { useWorkspace } from './useWorkspace.js';
import { saveBlobToLibrary } from './useLibrary.js';
import { downloadBlob } from '../lib/imaging.js';
import { createZip, blobToBytes } from '../lib/zip.js';
import {
  canvasToBlob,
  canvasToBytes,
  renderAnimationSheet,
  renderDoc,
  renderLayerSurface,
  renderLayerThumb,
} from '../lib/studio/render.js';

const PREVIEW_MAX_SIDE = 1600;

const workspace = useWorkspace();

/** 图层像素缓存：同一个位图只解一次 ImageData（魔棒要用）。 */
const pixelCache = new WeakMap();
function layerPixels(layer) {
  if (!layer?.bitmap) return null;
  const cached = pixelCache.get(layer);
  if (cached && cached.bitmap === layer.bitmap) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = layer.width;
  canvas.height = layer.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(layer.bitmap, 0, 0, layer.width, layer.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const entry = { bitmap: layer.bitmap, imageData };
  pixelCache.set(layer, entry);
  return entry;
}

const state = reactive({
  doc: null,
  activeLayerId: '',
  time: 0,
  playing: false,
  version: 0,
  busy: false,
  status: '',
  error: '',
  /** 选区只对当前图层有意义，所以一起记录 layerId */
  selection: { layerId: '', mask: null, op: 'replace', tolerance: 32, contiguous: true },
  exportOptions: {
    scale: 1,
    columns: 0,
    gap: 0,
    padding: 2,
    extrude: 2,
    pow2: false,
    trim: true,
    frameCount: 12,
    nineSlice: 8,
    background: 'transparent',
  },
  panelTab: 'layers',
});

let history = null;
/** 历史深度镜像：createHistory 的 getter 不是响应式的，UI 用这份计数判断可用性。 */
const historyFlags = reactive({ undo: 0, redo: 0 });

function syncHistoryFlags() {
  historyFlags.undo = history?.canUndo ? 1 : 0;
  historyFlags.redo = history?.canRedo ? 1 : 0;
}
let rafId = 0;
let lastFrameAt = 0;
const previewCache = new Map();

function touch(message = '') {
  state.version += 1;
  if (message) {
    state.status = message;
    state.error = '';
  }
  previewCache.clear();
}

function setError(message) {
  state.error = message;
  state.busy = false;
}

function ensureDoc() {
  if (state.doc) return state.doc;
  const source = workspace.selected.value ?? workspace.state.items[0] ?? null;
  const width = source?.width || 512;
  const height = source?.height || 512;
  state.doc = reactive(createDoc({ width, height, name: source ? `${source.name} 合成` : '未命名合成' }));
  history = createHistory(state.doc);
  syncHistoryFlags();
  return state.doc;
}

function record(label) {
  ensureDoc();
  history?.record(label);
  syncHistoryFlags();
}

/** 素材 → 图层。同一素材重复添加会得到独立图层（方便做残影/位移动画）。 */
function layerFromItem(item, doc) {
  const layer = createLayer('image', {
    name: item.name,
    width: item.width,
    height: item.height,
    itemId: item.id,
  });
  layer.bitmap = markRaw(item.bitmap);
  layer.sourceVersion = item.pixelVersion;
  layer.transform.x = Math.round((doc.width - item.width) / 2);
  layer.transform.y = Math.round((doc.height - item.height) / 2);
  return layer;
}

/** 用素材重建文档；items 为空时保留当前文档。 */
export function buildFromItems(items, { replace = false } = {}) {
  const list = [...(items ?? [])].filter((item) => item?.bitmap);
  if (!list.length) {
    state.error = '请先在左侧选择图片（可勾选多张后一起添加）';
    return null;
  }
  const existing = state.doc;
  if (!replace && existing && existing.layers.length) {
    return addItemsAsLayers(list);
  }
  const width = Math.max(...list.map((item) => item.width)) || 512;
  const height = Math.max(...list.map((item) => item.height)) || 512;
  state.doc = reactive(createDoc({ width, height, name: `${list[0].name} 合成` }));
  history = createHistory(state.doc);
  syncHistoryFlags();
  for (const item of list) addLayer(state.doc, layerFromItem(item, state.doc));
  state.activeLayerId = state.doc.layers[state.doc.layers.length - 1]?.id ?? '';
  state.selection = { ...state.selection, layerId: '', mask: null };
  state.time = 0;
  touch(`已用 ${list.length} 张素材建立 ${width}×${height} 合成`);
  return state.doc;
}

export function addItemsAsLayers(items) {
  const doc = ensureDoc();
  const list = [...(items ?? [])].filter((item) => item?.bitmap);
  if (!list.length) return null;
  record('添加图层');
  for (const item of list) addLayer(doc, layerFromItem(item, doc));
  state.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? state.activeLayerId;
  touch(`已添加 ${list.length} 个图层`);
  return doc;
}

export function addAdjustLayer() {
  const doc = ensureDoc();
  record('添加调整层');
  const layer = createLayer('adjust', { name: '调整层', width: doc.width, height: doc.height });
  layer.adjust = { ...DEFAULT_ADJUST, enabled: true };
  // 调整层插在当前图层上方，符合 PS 的直觉
  const activeIndex = doc.layers.findIndex((item) => item.id === state.activeLayerId);
  addLayer(doc, layer, { at: activeIndex >= 0 ? activeIndex + 1 : null });
  state.activeLayerId = layer.id;
  touch('已添加调整层（作用于它下面的所有图层）');
  return layer;
}

export function addTextLayer(content = '文字') {
  const doc = ensureDoc();
  record('添加文字层');
  const layer = createLayer('text', { name: content.slice(0, 12) || '文字层', width: doc.width, height: Math.round(doc.height / 2) });
  Object.assign(layer.text, { content, size: Math.round(doc.width / 8) || 48 });
  layer.transform.y = Math.round(doc.height / 4);
  addLayer(doc, layer);
  state.activeLayerId = layer.id;
  touch('已添加文字层');
  return layer;
}

export function selectLayer(id) {
  state.activeLayerId = id;
  state.version += 1;
}

export function setActiveLayerProp(patch) {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  record('修改图层');
  patchLayer(state.doc, layer.id, patch);
  touch();
}

export function setTransform(key, value, { commit = true } = {}) {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  if (commit) record('变换图层');
  const num = Number.isFinite(Number(value)) ? Number(value) : value;
  layer.transform[key] = num;
  // 这条属性已经有动画轨道时，改值等于在当前时间打一个关键帧
  const track = state.doc.animation?.tracks?.[layer.id]?.[key];
  if (track) setKey(track, state.time, num, 'ease');
  touch();
}

export function nudgeTransform(dx, dy) {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  layer.transform.x += dx;
  layer.transform.y += dy;
  state.version += 1;
  previewCache.clear();
}

/** 一次拖动结束：把有轨道的属性写进当前时间的关键帧，并提交历史。 */
export function commitTransformKeys() {
  const layer = activeLayer();
  if (!layer || !state.doc?.animation) {
    history?.commit('变换图层');
    return;
  }
  const tracks = state.doc.animation.tracks?.[layer.id] ?? {};
  for (const prop of ['x', 'y', 'scaleX', 'scaleY', 'rotation']) {
    if (tracks[prop]) setKey(tracks[prop], state.time, layer.transform[prop], 'ease');
  }
  history?.commit('变换图层');
  touch();
}

export function flipAxis(axis = 'x') {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  record('翻转图层');
  if (axis === 'x') layer.transform.flipX = !layer.transform.flipX;
  else layer.transform.flipY = !layer.transform.flipY;
  touch();
}

export function resetTransform() {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  record('还原变换');
  Object.assign(layer.transform, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false });
  touch();
}

export function removeActiveLayer() {
  if (!state.doc) return;
  const index = state.doc.layers.findIndex((layer) => layer.id === state.activeLayerId);
  if (index < 0) return;
  record('删除图层');
  removeLayer(state.doc, state.activeLayerId);
  const next = state.doc.layers[Math.max(0, index - 1)] ?? state.doc.layers[0] ?? null;
  state.activeLayerId = next?.id ?? '';
  touch('已删除图层');
}

export function duplicateActiveLayer() {
  if (!state.doc) return;
  record('复制图层');
  const copy = duplicateLayer(state.doc, state.activeLayerId);
  if (copy) state.activeLayerId = copy.id;
  touch('已复制图层');
}

export function moveActiveLayer(delta) {
  if (!state.doc) return;
  record('调整图层顺序');
  moveLayer(state.doc, state.activeLayerId, delta);
  touch();
}

export function setAdjust(key, value) {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  layer.adjust = normalizeAdjust({ ...(layer.adjust ?? {}), enabled: true, [key]: value });
  state.version += 1;
  previewCache.clear();
}

export function resetAdjust() {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return;
  record('重置调色');
  layer.adjust = { ...DEFAULT_ADJUST, enabled: true };
  layer.cubeLut = null;
  touch('已重置调色');
}

/** 导入 .cube：作为图层上的完整 LUT（优先级高于参数化调色）。 */
export function loadCube(text, name = '自定义 LUT') {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer) return null;
  try {
    const lut = parseCube(text);
    record('导入 LUT');
    layer.cubeLut = markRaw({ id: `lut-${Date.now()}`, name, size: lut.size, data: lut.data });
    touch(`已载入 ${name}（${lut.size}³）`);
    return layer.cubeLut;
  } catch (err) {
    setError(`读取 .cube 失败：${err.message}`);
    return null;
  }
}

export function downloadCube() {
  const layer = findLayer(state.doc, state.activeLayerId);
  if (!layer?.adjust) {
    setError('当前图层没有调色参数');
    return;
  }
  const data = encodeCube(lutFromAdjust(normalizeAdjust(layer.adjust)), layer.name);
  downloadBlob(new Blob([data], { type: 'text/plain' }), `${layer.name || 'lut'}.cube`);
}

// --------------------------------------------------------------- 选区

function activeLayer() {
  return findLayer(state.doc, state.activeLayerId);
}

function selectionContext() {
  const layer = activeLayer();
  if (!layer) {
    setError('请先选择一个图层');
    return null;
  }
  if (state.selection.layerId && state.selection.layerId !== layer.id) {
    state.selection.mask = null;
    state.selection.layerId = layer.id;
  }
  state.selection.layerId = layer.id;
  return layer;
}

/** 魔棒：在舞台点击处取色（坐标是文档坐标，这里换算到图层本地）。 */
export function wandAt(docX, docY) {
  const layer = selectionContext();
  if (!layer || layer.kind !== 'image') {
    setError('魔棒只对图片层有效');
    return null;
  }
  const pixels = layerPixels(layer);
  if (!pixels) return null;
  const t = layer.transform;
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const angle = (-t.rotation * Math.PI) / 180;
  const dx = docX - t.x - cx;
  const dy = docY - t.y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const lx = (dx * cos - dy * sin) / t.scaleX + cx;
  const ly = (dx * sin + dy * cos) / t.scaleY + cy;
  const x = Math.round(lx);
  const y = Math.round(ly);
  if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) {
    setError('点击位置不在该图层范围内');
    return null;
  }
  record('魔棒选区');
  const mask = magicWand(pixels.imageData.data, layer.width, layer.height, {
    x,
    y,
    tolerance: state.selection.tolerance,
    contiguous: state.selection.contiguous,
  });
  const next = combineMask(state.selection.mask, mask, state.selection.op);
  state.selection.mask = next;
  state.selection.layerId = layer.id;
  touch(`魔棒选中 ${(maskCoverage(next) * 100).toFixed(1)}%`);
  return next;
}

export function selectionOp(op) {
  state.selection.op = op;
}

export function selectionInvert() {
  if (!state.selection.mask) return;
  record('反选');
  state.selection.mask = invertMask(state.selection.mask);
  touch('已反选');
}

export function selectionFeather(radius) {
  if (!state.selection.mask) return;
  record('羽化选区');
  state.selection.mask = featherMask(state.selection.mask, radius);
  touch(`羽化 ${radius}px`);
}

export function selectionExpand(pixels) {
  if (!state.selection.mask) return;
  record('扩展选区');
  state.selection.mask = expandMask(state.selection.mask, pixels);
  touch(`${pixels > 0 ? '扩展' : '收缩'} ${Math.abs(pixels)}px`);
}

export function selectionClear() {
  state.selection.mask = null;
  state.selection.layerId = '';
  touch('已取消选区');
}

export function selectionBox() {
  return state.selection.mask ? maskBounds(state.selection.mask) : null;
}

/** 选区 → 图层蒙版（选区本身保留，方便继续加减）。 */
export function selectionToMask() {
  const layer = selectionContext();
  if (!layer || !state.selection.mask) return;
  record('应用蒙版');
  layer.mask = state.selection.mask;
  touch('已生成图层蒙版');
}

export function clearLayerMask() {
  const layer = activeLayer();
  if (!layer?.mask) return;
  record('清除蒙版');
  layer.mask = null;
  touch('已清除蒙版');
}

/** 整层变成蒙版（按 alpha 建掩膜）：适合给抠好的图加边缘处理。 */
export function maskFromLayerAlpha() {
  const layer = selectionContext();
  if (!layer || layer.kind !== 'image') return;
  const pixels = layerPixels(layer);
  if (!pixels) return;
  const { data, width, height } = pixels.imageData;
  const mask = createMask(width, height, 0);
  for (let i = 0; i < width * height; i += 1) mask.data[i] = data[i * 4 + 3];
  record('按 Alpha 建选区');
  state.selection.mask = mask;
  state.selection.layerId = layer.id;
  touch('已按图层 Alpha 建立选区');
}

export function selectionCoverage() {
  return state.selection.mask ? maskCoverage(state.selection.mask) : 0;
}

/** 素材被其它工具就地保存后，同步图层底图（按 itemId 匹配）。 */
export function syncItems() {
  if (!state.doc) return;
  const items = workspace.state.items;
  let changed = false;
  for (const layer of state.doc.layers) {
    if (!layer.itemId) continue;
    const item = items.find((entry) => entry.id === layer.itemId);
    if (!item?.bitmap) continue;
    if (item.pixelVersion !== layer.sourceVersion) {
      layer.bitmap = markRaw(item.bitmap);
      layer.sourceVersion = item.pixelVersion;
      layer.width = item.width;
      layer.height = item.height;
      changed = true;
    }
  }
  if (changed) touch('素材已更新，图层底图已同步');
}

// --------------------------------------------------------------- 动画

const defaultSample = (layer) => ({
  x: layer.transform.x,
  y: layer.transform.y,
  scaleX: layer.transform.scaleX,
  scaleY: layer.transform.scaleY,
  rotation: layer.transform.rotation,
  opacity: layer.opacity,
});

export function sampleFor(layer) {
  if (!state.doc?.animation) return null;
  return sampleAnimation(state.doc.animation, state.time, layer.id, defaultSample(layer));
}

export function setAnimOption(key, value) {
  const anim = ensureDoc().animation ?? (state.doc.animation = createAnimation());
  if (key === 'fps') anim.fps = Math.max(1, Math.min(60, Math.round(Number(value) || 24)));
  else if (key === 'duration') anim.duration = Math.max(0.1, Number(value) || 2);
  else if (key === 'loop') anim.loop = value;
  state.time = Math.min(state.time, anim.duration);
  touch();
}

export function seek(time) {
  const doc = ensureDoc();
  state.time = Math.max(0, Number(time) || 0);
  state.version += 1;
  previewCache.clear();
  return state.time;
}

export function togglePlay() {
  if (state.playing) stopPlay();
  else startPlay();
}

export function startPlay() {
  if (state.playing) return;
  const doc = ensureDoc();
  state.playing = true;
  lastFrameAt = performance.now();
  const tick = (now) => {
    if (!state.playing) return;
    const delta = Math.min(0.1, (now - lastFrameAt) / 1000);
    lastFrameAt = now;
    state.time = loopTime(state.time + delta, doc.animation?.duration ?? 2, doc.animation?.loop ?? 'loop');
    state.version += 1;
    previewCache.clear();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function stopPlay() {
  state.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

export function addKeyframe(prop = 'x', value = null) {
  const layer = activeLayer();
  if (!layer) return;
  const doc = ensureDoc();
  const base = defaultSample(layer);
  record('打关键帧');
  const track = ensureTrack(doc.animation, layer.id, prop, value ?? base[prop] ?? 0);
  const finalValue = value ?? (prop === 'opacity' ? layer.opacity : base[prop] ?? 0);
  setKey(track, state.time, finalValue, 'ease');
  touch(`已在 ${state.time.toFixed(2)}s 为 ${prop} 打关键帧`);
}

export function deleteKeyframe(prop, time = state.time) {
  const layer = activeLayer();
  const track = state.doc?.animation?.tracks?.[layer?.id]?.[prop];
  if (!track) return;
  record('删除关键帧');
  removeKey(track, time);
  touch('已删除关键帧');
}

export function setKeyEasing(prop, keyTime, easing) {
  const layer = activeLayer();
  const track = state.doc?.animation?.tracks?.[layer?.id]?.[prop];
  if (!track) return;
  const key = track.keys.find((item) => Math.abs(item.t - keyTime) < 1e-3);
  if (!key) return;
  record('修改缓动');
  key.easing = easing;
  touch();
}

export const trackProperties = TRACK_PROPS;
export const easingPresets = Object.keys(EASING_PRESETS);

export const activeTracks = computed(() => {
  const layerId = state.activeLayerId;
  const tracks = state.doc?.animation?.tracks?.[layerId] ?? {};
  return TRACK_PROPS.filter((prop) => tracks[prop]).map((prop) => ({
    prop,
    track: tracks[prop],
    keys: tracks[prop].keys,
    hasKey: hasKeyAt(tracks[prop], state.time),
    value: sampleTrack(tracks[prop], state.time, 0),
  }));
});

export const timelineMarks = computed(() => keyframeTimes(state.doc?.animation ?? createAnimation()));

// --------------------------------------------------------------- 渲染

export const previewScale = computed(() => {
  const doc = state.doc;
  if (!doc) return 1;
  return Math.min(1, PREVIEW_MAX_SIDE / Math.max(doc.width, doc.height));
});

/** 舞台用：返回当前帧的画布（按版本+时间缓存）。 */
export function renderPreview() {
  const doc = state.doc;
  if (!doc) return null;
  const key = `${state.version}|${state.time.toFixed(3)}|${previewScale.value}`;
  const cached = previewCache.get(key);
  if (cached) return cached;
  const canvas = renderDoc(doc, { time: state.time, sampleFor, scale: previewScale.value });
  previewCache.set(key, canvas);
  if (previewCache.size > 24) {
    const first = previewCache.keys().next().value;
    previewCache.delete(first);
  }
  return canvas;
}

export function renderFull() {
  const doc = ensureDoc();
  return renderDoc(doc, {
    time: state.time,
    sampleFor,
    scale: Number(state.exportOptions.scale) || 1,
    background: state.exportOptions.background === 'transparent' ? null : state.exportOptions.background,
  });
}

/** 图层面板缩略图（dataURL，按 id 缓存）。 */
const thumbCache = new Map();
export function layerThumb(layer) {
  const key = `${layer.id}|${state.version}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  try {
    const url = renderLayerThumb(layer).toDataURL('image/png');
    thumbCache.set(key, url);
    if (thumbCache.size > 80) thumbCache.delete(thumbCache.keys().next().value);
    return url;
  } catch {
    return '';
  }
}

export function documentBounds(layer) {
  return layer ? { x: layer.transform.x, y: layer.transform.y, width: layer.width, height: layer.height } : null;
}

export function pickLayerAt(x, y) {
  if (!state.doc) return null;
  const layer = hitTest(state.doc, x, y, sampleFor);
  if (layer) state.activeLayerId = layer.id;
  state.version += 1;
  return layer;
}

// --------------------------------------------------------------- 导出

async function pushBlob(blob, filename, { toWorkspace = true, toLibrary = false, download = false, dir = '合成结果' } = {}) {
  if (toWorkspace) await workspace.actions.addImageBlob(blob, filename);
  if (toLibrary) await saveBlobToLibrary(blob, filename, dir);
  if (download) downloadBlob(blob, filename);
}

export async function exportPng({ toWorkspace = true, toLibrary = false, download = false } = {}) {
  if (!state.doc) return null;
  state.busy = true;
  try {
    const canvas = renderFull();
    const blob = await canvasToBlob(canvas);
    const name = `${state.doc.name || '合成'}.png`;
    await pushBlob(blob, name, { toWorkspace, toLibrary, download });
    state.status = `已导出 ${name}（${canvas.width}×${canvas.height}）`;
    return blob;
  } catch (err) {
    setError(`导出失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/**
 * 图集导出：PNG + TexturePacker JSON(hash/array) + Phaser + Cocos plist + 九宫格，
 * 打包成一个 ZIP，避免用户逐个下载不知道哪个配哪个。
 */
export async function exportAtlas({ toLibrary = true, download = true } = {}) {
  if (!state.doc) return null;
  const doc = state.doc;
  const options = state.exportOptions;
  state.busy = true;
  try {
    const result = renderAnimationSheet(doc, {
      count: options.frameCount,
      columns: options.columns,
      gap: options.gap,
      padding: options.padding,
      extrude: options.extrude,
      pow2: options.pow2,
      trim: options.trim,
      scale: options.scale,
      sampleFor,
    });
    const imageName = `${doc.name || 'atlas'}.png`;
    const frames = result.frames.map((frame) => {
      const placement = result.plan.placements.find((item) => item.name === frame.name);
      return {
        name: frame.name,
        width: frame.width,
        height: frame.height,
        trimmed: frame.trimmed,
        trimX: frame.trimX,
        trimY: frame.trimY,
        sourceWidth: frame.sourceWidth,
        sourceHeight: frame.sourceHeight,
        placement,
      };
    });
    const nineSlice =
      options.nineSlice > 0
        ? { left: options.nineSlice, right: options.nineSlice, top: options.nineSlice, bottom: options.nineSlice }
        : null;
    const bundle = buildAtlasBundle({
      image: imageName,
      width: result.canvas.width,
      height: result.canvas.height,
      frames,
      scale: options.scale,
      nineSlice,
    });

    const png = await canvasToBytes(result.canvas);
    const entries = [
      { name: 'mimetype', data: new TextEncoder().encode('image/png') },
      { name: imageName, data: png },
      { name: 'atlas.json', data: new TextEncoder().encode(bundle.jsonHash) },
      { name: 'atlas-array.json', data: new TextEncoder().encode(bundle.jsonArray) },
      { name: 'atlas-phaser.json', data: new TextEncoder().encode(bundle.phaser) },
      { name: 'atlas.plist', data: new TextEncoder().encode(bundle.plist) },
      {
        name: 'atlas-info.json',
        data: new TextEncoder().encode(
          JSON.stringify(
            {
              image: imageName,
              size: { width: result.canvas.width, height: result.canvas.height },
              frameCount: frames.length,
              padding: options.padding,
              extrude: options.extrude,
              pow2: options.pow2,
              trim: options.trim,
              nineSlice,
            },
            null,
            2,
          ),
        ),
      },
    ];
    const zip = createZip(entries);

    if (toLibrary) await saveBlobToLibrary(zip, `${doc.name || 'atlas'}-atlas.zip`, '精灵图');
    if (download) downloadBlob(zip, `${doc.name || 'atlas'}-atlas.zip`);
    state.status = `已导出图集 ${result.canvas.width}×${result.canvas.height}（${frames.length} 帧）`;
    return { zip, plan: result.plan };
  } catch (err) {
    setError(`图集导出失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

function oraComposite(layer) {
  const map = {
    normal: 'svg:src-over',
    multiply: 'svg:multiply',
    screen: 'svg:screen',
    overlay: 'svg:overlay',
    add: 'svg:plus',
    darken: 'svg:darken',
    lighten: 'svg:lighten',
    difference: 'svg:difference',
    exclusion: 'svg:xor',
  };
  return map[layer.blend] ?? `svg:${layer.blend}`;
}

/**
 * 分层交换格式：OpenRaster（.ora）。
 * 没有引入 PSD 解析库，但 .ora 是 ZIP+PNG+XML 的开放标准，
 * Krita / GIMP / Photopea 都能打开并保留图层，游戏美术交接够用。
 */
export async function exportOra({ download = true, toLibrary = false } = {}) {
  if (!state.doc) return null;
  const doc = state.doc;
  state.busy = true;
  try {
    const entries = [{ name: 'mimetype', data: new TextEncoder().encode('image/openraster') }];
    const layers = doc.layers.filter((layer) => layer.kind !== 'adjust');
    const reversed = [...layers].reverse(); // ORA 的 stack 是从上到下
    const xmlLayers = [];
    for (let i = 0; i < reversed.length; i += 1) {
      const layer = reversed[i];
      const surface = renderLayerSurface(layer);
      const pngName = `data/layer-${String(i).padStart(3, '0')}.png`;
      entries.push({ name: pngName, data: await canvasToBytes(surface) });
      xmlLayers.push(
        `    <layer name="${escapeXml(layer.name)}" src="${pngName}" x="${Math.round(layer.transform.x)}" y="${Math.round(
          layer.transform.y,
        )}" opacity="${(layer.opacity / 100).toFixed(3)}" visibility="${layer.visible ? 'visible' : 'hidden'}" composite-op="${oraComposite(layer)}"/>`,
      );
    }
    const merged = await canvasToBytes(renderDoc(doc, { time: state.time, sampleFor, scale: 1 }));
    entries.push({ name: 'mergedimage.png', data: merged });
    entries.push({ name: 'Thumbnails/thumbnail.png', data: merged });

    const stack = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="${doc.width}" h="${doc.height}">
  <stack>
${xmlLayers.join('\n')}
  </stack>
</image>`;
    entries.push({ name: 'stack.xml', data: new TextEncoder().encode(stack) });
    const zip = createZip(entries);
    if (toLibrary) await saveBlobToLibrary(zip, `${doc.name || '合成'}.ora`, '合成结果');
    if (download) downloadBlob(zip, `${doc.name || '合成'}.ora`);
    state.status = `已导出分层文件 .ora（${layers.length} 个图层）`;
    return zip;
  } catch (err) {
    setError(`导出 .ora 失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 保存当前文档的 JSON（下次可恢复结构，位图按 itemId 重新取）。 */
export function downloadDocJson() {
  if (!state.doc) return;
  const json = JSON.stringify(serializeDoc(state.doc), null, 2);
  downloadBlob(new Blob([json], { type: 'application/json' }), `${state.doc.name || 'doc'}.json`);
}

// --------------------------------------------------------------- 清理

export function undo() {
  if (!history?.undo()) return false;
  syncHistoryFlags();
  state.activeLayerId = state.doc.layers.some((layer) => layer.id === state.activeLayerId)
    ? state.activeLayerId
    : state.doc.layers[state.doc.layers.length - 1]?.id ?? '';
  touch('已撤销');
  return true;
}

export function redo() {
  if (!history?.redo()) return false;
  syncHistoryFlags();
  touch('已重做');
  return true;
}

export const canUndo = computed(() => historyFlags.undo > 0);
export const canRedo = computed(() => historyFlags.redo > 0);

export function clearDoc() {
  stopPlay();
  state.doc = null;
  history = null;
  syncHistoryFlags();
  state.activeLayerId = '';
  state.time = 0;
  state.selection = { ...state.selection, mask: null, layerId: '' };
  thumbCache.clear();
  touch('已清空合成');
}

export function useStudio() {
  return {
    state,
    actions: {
      buildFromItems,
      addItemsAsLayers,
      addAdjustLayer,
      addTextLayer,
      selectLayer,
      setActiveLayerProp,
      setTransform,
      nudgeTransform,
      flipAxis,
      resetTransform,
      removeActiveLayer,
      duplicateActiveLayer,
      moveActiveLayer,
      setAdjust,
      resetAdjust,
      loadCube,
      downloadCube,
      wandAt,
      selectionOp,
      selectionInvert,
      selectionFeather,
      selectionExpand,
      selectionClear,
      selectionToMask,
      clearLayerMask,
      maskFromLayerAlpha,
      selectionBox,
      selectionCoverage,
      syncItems,
      commitTransformKeys,
      setAnimOption,
      seek,
      togglePlay,
      startPlay,
      stopPlay,
      addKeyframe,
      deleteKeyframe,
      setKeyEasing,
      renderPreview,
      renderFull,
      sampleFor,
      layerThumb,
      pickLayerAt,
      exportPng,
      exportAtlas,
      exportOra,
      downloadDocJson,
      undo,
      redo,
      clearDoc,
      record,
    },
    computed: {
      previewScale,
      activeTracks,
      timelineMarks,
      canUndo,
      canRedo,
    },
  };
}

// 供其它模块使用的常量
export { PREVIEW_MAX_SIDE, isAdjustActive, blobToBytes };
