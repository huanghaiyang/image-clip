/**
 * 背景去除状态（单例）
 * --------------------
 * 支持三种交互，全部共用同一套算法（`shared/bgremove.js`）：
 *   1. 自动识别：从画面边缘取主色，默认勾选最有可能的底色；
 *   2. 取色器：在画面上点一下，只去除与这个颜色接近、且与边缘连通的区域；
 *   3. 套索：手绘多边形选区，可限定「只在选区内去除」或「保护选区」。
 *
 * 实时预览工作在最长边 1600px 的缩略图上，参数拖动不会卡；
 * 点「应用」时才按原始分辨率重算，保证导出清晰度。
 */
import { computed, markRaw, reactive, readonly } from 'vue';

import {
  applyMaskToRgba,
  buildBackgroundMask,
  colorDistance,
  colorToHex,
  detectBackgroundColors,
  parseColor,
} from '@shared/bgremove.js';
import { polygonArea, rasterizePolygon, scalePolygon } from '@shared/selection.js';

import { useWorkspace } from './useWorkspace.js';
import { saveBlobToLibrary } from './useLibrary.js';

const PREVIEW_MAX_SIDE = 1600;
const DEFAULT_OPTIONS = {
  tolerance: 32,
  connected: true,
  feather: 2,
  erode: 0,
  decontaminate: true,
  selectionMode: 'inside', // inside | outside | all（仅在存在套索选区时生效）
  showMask: false,
};

const workspace = useWorkspace();

const state = reactive({
  tool: 'lasso', // lasso | pick | pan
  busy: false,
  status: '',
  error: '',
  lastPick: null,
});

/** 以素材 id 为键的编辑状态；大对象全部 markRaw。 */
const entries = reactive({});

const activeItem = computed(() => workspace.selected.value ?? null);
const activeEntry = computed(() => {
  const item = activeItem.value;
  return item ? entries[item.id] ?? null : null;
});

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** 生成预览数据：大图按最长边 1600 缩放，小图直接用原数据（零拷贝引用）。 */
function buildPreviewSource(item) {
  const maxSide = Math.max(item.width, item.height);
  if (maxSide <= PREVIEW_MAX_SIDE) {
    return {
      data: item.imageData.data,
      width: item.width,
      height: item.height,
      scale: 1,
      full: true,
    };
  }

  const scale = PREVIEW_MAX_SIDE / maxSide;
  const width = Math.max(1, Math.round(item.width * scale));
  const height = Math.max(1, Math.round(item.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(item.bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { data, width, height, scale: width / item.width, full: false };
}

function detectColors(item) {
  try {
    return detectBackgroundColors(item.imageData.data, item.width, item.height, {
      ring: 2,
      maxColors: 3,
      mergeDistance: 26,
    });
  } catch {
    return { colors: [], sampled: 0, transparentRatio: 0 };
  }
}

function defaultColorState(detected) {
  return detected.map((color, index) => ({
    ...color,
    enabled: index === 0 || (index < 3 && color.ratio >= 0.2),
    source: 'auto',
  }));
}

function ensureEntry(item = activeItem.value) {
  if (!item) return null;
  const existing = entries[item.id];
  if (existing && existing.sourceData === item.imageData.data) return existing;

  const detected = detectColors(item);
  const entry = reactive({
    id: item.id,
    name: item.name,
    width: item.width,
    height: item.height,
    sourceData: markRaw(item.imageData.data),
    bitmap: markRaw(item.bitmap),
    preview: markRaw(buildPreviewSource(item)),
    previewCanvas: null,
    previewMask: null,
    previewVersion: 0,
    detected: detected.colors,
    transparentRatio: detected.transparentRatio,
    colors: defaultColorState(detected.colors),
    options: { ...DEFAULT_OPTIONS },
    polygon: [],
    draftPoints: [],
    drawing: false,
    selectionMask: null,
    coverage: 0,
    removedPixels: 0,
    elapsedMs: 0,
    computing: false,
    error: '',
    renderToken: 0,
    timer: null,
  });

  entries[item.id] = entry;
  scheduleRecompute(entry);
  return entry;
}

function scheduleRecompute(entry) {
  if (!entry) return;
  entry.renderToken += 1;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void recompute(entry);
  }, 140);
}

function scaledRadius(value, scale) {
  const radius = Math.max(0, Number(value) || 0);
  if (!radius) return 0;
  return Math.max(1, Math.round(radius * scale));
}

/** 把当前参数应用到预览分辨率的画布。 */
async function recompute(entry) {
  const token = entry.renderToken;
  entry.computing = true;
  const started = performance.now();
  try {
    const preview = entry.preview;
    const colors = entry.colors.filter((color) => color.enabled).map((color) => parseColor(color));
    const selection =
      entry.polygon.length >= 3
        ? rasterizePolygon(scalePolygon(entry.polygon, preview.scale), preview.width, preview.height)
        : null;

    const built = buildBackgroundMask(preview.data, preview.width, preview.height, {
      colors,
      tolerance: entry.options.tolerance,
      connected: entry.options.connected,
      feather: scaledRadius(entry.options.feather, preview.scale),
      erode: scaledRadius(entry.options.erode, preview.scale),
      selection,
      selectionMode: selection ? entry.options.selectionMode : 'all',
    });

    const applied = applyMaskToRgba(preview.data, preview.width, preview.height, built.mask, {
      decontaminate: entry.options.decontaminate,
      colors,
    });

    if (token !== entry.renderToken) return; // 参数已经又变了，丢弃这次结果

    let canvas = entry.previewCanvas;
    if (!canvas || canvas.width !== preview.width || canvas.height !== preview.height) {
      canvas = createCanvas(preview.width, preview.height);
      entry.previewCanvas = markRaw(canvas);
    }
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(applied.data), preview.width, preview.height), 0, 0);

    if (entry.options.showMask) {
      tintMask(ctx, built.mask, preview.width, preview.height);
    }

    entry.previewMask = markRaw(built.mask);
    entry.coverage = built.coverage;
    entry.removedPixels = applied.removedPixels;
    entry.elapsedMs = Math.round(performance.now() - started);
    entry.error = '';
    entry.previewVersion += 1;
  } catch (err) {
    if (token === entry.renderToken) entry.error = err.message;
  } finally {
    if (token === entry.renderToken) entry.computing = false;
  }
}

function tintMask(ctx, mask, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const amount = mask[i] / 255;
    if (!amount) continue;
    const alpha = Math.min(255, Math.round(amount * 150));
    data[p] = Math.round(data[p] * 0.55 + 255 * 0.45);
    data[p + 1] = Math.round(data[p + 1] * 0.55 + 60 * 0.45);
    data[p + 2] = Math.round(data[p + 2] * 0.55 + 60 * 0.45);
    data[p + 3] = Math.max(data[p + 3], alpha);
  }
  ctx.putImageData(image, 0, 0);
}

// --------------------------------------------------------------- 参数

export function prepareSelected() {
  return ensureEntry(activeItem.value);
}

export function setTool(tool) {
  state.tool = ['lasso', 'pick', 'pan'].includes(tool) ? tool : 'lasso';
}

export function setOption(key, value) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !(key in entry.options)) return;
  entry.options[key] = value;
  scheduleRecompute(entry);
}

export function resetOptions() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  Object.assign(entry.options, DEFAULT_OPTIONS);
  scheduleRecompute(entry);
  setStatus('背景去除参数已重置');
}

// --------------------------------------------------------------- 颜色

export function autoDetectColors() {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!entry) return;
  const detected = detectColors(item);
  entry.detected = detected.colors;
  entry.transparentRatio = detected.transparentRatio;
  entry.colors = defaultColorState(detected.colors);
  scheduleRecompute(entry);
  setStatus(
    detected.colors.length
      ? `已识别 ${detected.colors.length} 种背景色：${detected.colors.map((color) => color.hex.toUpperCase()).join('、')}`
      : '边框没有可用的背景色（可能整张图都是内容，或边缘已经透明）',
  );
}

export function toggleColor(index) {
  const entry = ensureEntry(activeItem.value);
  if (!entry?.colors[index]) return;
  entry.colors[index].enabled = !entry.colors[index].enabled;
  scheduleRecompute(entry);
}

/** 添加/启用一个自定义背景色。 */
export function useColor(input, { exclusive = false } = {}) {
  const entry = ensureEntry(activeItem.value);
  const color = parseColor(input);
  if (!entry || !color) return;
  const hex = colorToHex(color);
  const found = entry.colors.find((item) => item.hex.toLowerCase() === hex.toLowerCase());
  if (found) found.enabled = true;
  else entry.colors.push({ ...color, hex, ratio: 0, enabled: true, source: 'custom' });
  if (exclusive) {
    for (const item of entry.colors) item.enabled = item.hex.toLowerCase() === hex.toLowerCase();
  }
  scheduleRecompute(entry);
  setStatus(`背景色已设为 ${hex.toUpperCase()}${exclusive ? '（仅去除该颜色）' : ''}`);
}

export function removeColor(index) {
  const entry = ensureEntry(activeItem.value);
  if (!entry?.colors[index]) return;
  entry.colors.splice(index, 1);
  scheduleRecompute(entry);
}

/**
 * 取色器：读取原始分辨率像素，返回 hex。
 * 默认“只去除这一色”，避免用户点错时把之前识别的颜色也一起处理。
 */
export function pickColorAt(x, y) {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!entry) return null;
  const px = Math.max(0, Math.min(item.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(item.height - 1, Math.round(y)));
  const index = (py * item.width + px) * 4;
  const data = item.imageData.data;
  if (data[index + 3] === 0) {
    setStatus('这个位置是透明像素');
    return null;
  }
  const hex = colorToHex({ r: data[index], g: data[index + 1], b: data[index + 2] });
  state.lastPick = { x: px, y: py, hex };
  useColor(hex, { exclusive: true });
  setStatus(`已取色 ${hex.toUpperCase()}（仅去除该颜色，可在颜色列表恢复其他颜色）`);
  return hex;
}

/** 判断某个像素是否接近当前启用的背景色（用于 UI 提示，不参与算法）。 */
export function isBackgroundLike(r, g, b) {
  const entry = activeEntry.value;
  if (!entry) return false;
  return entry.colors
    .filter((color) => color.enabled)
    .some((color) => colorDistance(r, g, b, color) <= entry.options.tolerance);
}

// --------------------------------------------------------------- 套索

export function beginLasso(point) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !point) return;
  entry.drawing = true;
  entry.draftPoints = [{ x: point.x, y: point.y }];
}

export function extendLasso(point) {
  const entry = activeEntry.value;
  if (!entry?.drawing || !point) return;
  const last = entry.draftPoints[entry.draftPoints.length - 1];
  if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
  entry.draftPoints.push({ x: point.x, y: point.y });
}

export function endLasso({ close = true } = {}) {
  const entry = activeEntry.value;
  if (!entry?.drawing) return;
  entry.drawing = false;
  const points = entry.draftPoints;
  entry.draftPoints = [];
  if (close && points.length >= 3 && polygonArea(points) >= 4) {
    entry.polygon = points;
    entry.selectionMask = markRaw(rasterizePolygon(points, entry.width, entry.height));
    scheduleRecompute(entry);
    setStatus(`已建立套索选区（${points.length} 个顶点），可切换“仅选区内 / 保护选区”`);
  } else {
    setStatus('套索顶点太少，已取消');
  }
}

export function clearSelection() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  entry.polygon = [];
  entry.draftPoints = [];
  entry.selectionMask = null;
  entry.drawing = false;
  scheduleRecompute(entry);
  setStatus('已清除套索选区');
}

// --------------------------------------------------------------- 应用

function stripExtension(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : String(name);
}

/**
 * 按原始分辨率应用抠图。
 * @param {{saveToLibrary?:boolean}} [options]
 */
export async function applyBackgroundRemoval({ saveToLibrary = false } = {}) {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!item || !entry) {
    setError('请先选择一张素材');
    return null;
  }
  if (state.busy) return null;

  state.busy = true;
  const started = performance.now();
  try {
    const colors = entry.colors.filter((color) => color.enabled).map((color) => parseColor(color));
    const selection = entry.polygon.length >= 3 ? rasterizePolygon(entry.polygon, item.width, item.height) : null;
    const built = buildBackgroundMask(item.imageData.data, item.width, item.height, {
      colors,
      tolerance: entry.options.tolerance,
      connected: entry.options.connected,
      feather: entry.options.feather,
      erode: entry.options.erode,
      selection,
      selectionMode: selection ? entry.options.selectionMode : 'all',
    });
    const applied = applyMaskToRgba(item.imageData.data, item.width, item.height, built.mask, {
      decontaminate: entry.options.decontaminate,
      colors,
    });

    const canvas = createCanvas(item.width, item.height);
    canvas
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(applied.data), item.width, item.height), 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('PNG 编码失败'))), 'image/png');
    });

    const filename = `${stripExtension(item.name)}-去背景.png`;
    const newItem = await workspace.actions.addImageBlob(blob, filename);
    if (saveToLibrary) await saveBlobToLibrary(blob, filename, '抠图结果');

    const coverage = (built.coverage * 100).toFixed(1);
    setStatus(
      `已应用背景去除：透明 ${coverage}% · ${Math.round(performance.now() - started)}ms${
        saveToLibrary ? ' · 已保存到资源库/抠图结果' : ''
      }`,
    );
    return { blob, newItem, coverage: built.coverage };
  } catch (err) {
    setError(`应用背景去除失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export function useBgRemoval() {
  return {
    state: readonly(state),
    activeItem,
    activeEntry,
    actions: {
      prepareSelected,
      setTool,
      setOption,
      resetOptions,
      autoDetectColors,
      toggleColor,
      useColor,
      removeColor,
      pickColorAt,
      isBackgroundLike,
      beginLasso,
      extendLasso,
      endLasso,
      clearSelection,
      applyBackgroundRemoval,
    },
  };
}
