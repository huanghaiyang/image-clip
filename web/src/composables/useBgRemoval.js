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
import { markSessionDirty } from '../lib/sessionSignals.js';

const PREVIEW_MAX_SIDE = 1600;
const DEFAULT_OPTIONS = {
  tolerance: 32,
  connected: true,
  feather: 2,
  erode: 0,
  decontaminate: true,
  selectionMode: 'inside', // inside | outside | all（仅在存在套索选区时生效）
  showMask: false,
  lassoMode: 'smart', // smart | free：智能套索会吸附到边缘并简化顶点
};

/** 智能套索参数（预览图坐标系）。 */
const SNAP_RADIUS = 5;
const SNAP_MIN_GRADIENT = 24;
const SNAP_TOLERANCE = 2;
const HISTORY_LIMIT = 30;
const OPTION_RECORD_GAP = 500;

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
    snapMap: null,
    history: [],
    redo: [],
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

// --------------------------------------------------------------- 历史

let lastRecord = { id: '', group: '', at: 0 };

function entrySnapshot(entry) {
  return {
    colors: entry.colors.map((color) => ({ ...color })),
    options: { ...entry.options },
    polygon: entry.polygon.map((point) => ({ x: point.x, y: point.y })),
    detected: entry.detected.map((color) => ({ ...color })),
    transparentRatio: entry.transparentRatio,
  };
}

/**
 * 记录一次可撤销的编辑。
 * group 相同的连续操作（例如拖动同一个滑块）在 500ms 内合并为一条，
 * 避免撤销时要点十几次才回到拖动前。
 */
function recordEntryHistory(entry, group = '') {
  if (!entry) return;
  const now = performance.now();
  if (group && lastRecord.id === entry.id && lastRecord.group === group && now - lastRecord.at < OPTION_RECORD_GAP) {
    lastRecord.at = now;
    return;
  }
  lastRecord = { id: entry.id, group, at: now };
  entry.history.push(entrySnapshot(entry));
  if (entry.history.length > HISTORY_LIMIT) entry.history.shift();
  entry.redo = [];
}

function applyEntrySnapshot(entry, snapshot) {
  if (!entry || !snapshot) return;
  entry.colors = snapshot.colors.map((color) => ({ ...color }));
  entry.options = { ...DEFAULT_OPTIONS, ...snapshot.options };
  entry.detected = snapshot.detected.map((color) => ({ ...color }));
  entry.transparentRatio = snapshot.transparentRatio;
  entry.polygon = snapshot.polygon.map((point) => ({ x: point.x, y: point.y }));
  entry.draftPoints = [];
  entry.drawing = false;
  entry.selectionMask =
    entry.polygon.length >= 3 ? markRaw(rasterizePolygon(entry.polygon, entry.width, entry.height)) : null;
  scheduleRecompute(entry);
}

export function undoBg() {
  const entry = activeEntry.value;
  if (!entry?.history.length) return false;
  entry.redo.push(entrySnapshot(entry));
  applyEntrySnapshot(entry, entry.history.pop());
  markSessionDirty('bgremove');
  setStatus('已撤销上一步背景去除操作');
  return true;
}

export function redoBg() {
  const entry = activeEntry.value;
  if (!entry?.redo.length) return false;
  entry.history.push(entrySnapshot(entry));
  applyEntrySnapshot(entry, entry.redo.pop());
  markSessionDirty('bgremove');
  setStatus('已重做背景去除操作');
  return true;
}

const canUndoBg = computed(() => Boolean(activeEntry.value?.history.length));
const canRedoBg = computed(() => Boolean(activeEntry.value?.redo.length));

// --------------------------------------------------------------- 智能套索

/**
 * 在预览图上做一次 Sobel 梯度扫描，缓存边缘强度图。
 * 用预览分辨率而不是原图，套索过程中每次吸附都能即时响应。
 */
function ensureSnapMap(entry) {
  if (!entry) return null;
  const preview = entry.preview;
  if (entry.snapMap && entry.snapMap.width === preview.width && entry.snapMap.height === preview.height) {
    return entry.snapMap;
  }
  const { data, width, height } = preview;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    // 透明区按“最亮”处理，让图标轮廓天然形成强边缘
    if (data[p + 3] === 0) {
      gray[i] = 255;
      continue;
    }
    gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }

  const magnitude = new Uint16Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      magnitude[i] = Math.min(65535, Math.abs(gx) + Math.abs(gy));
    }
  }
  entry.snapMap = markRaw({ width, height, magnitude });
  return entry.snapMap;
}

/** 把落点吸附到邻域内梯度最强的像素（原图坐标进、原图坐标出）。 */
function snapPoint(entry, point) {
  const map = ensureSnapMap(entry);
  if (!map) return { x: point.x, y: point.y };
  const scale = entry.preview.scale || 1;
  const px = Math.round(point.x * scale);
  const py = Math.round(point.y * scale);
  let best = null;
  let bestScore = 0;
  for (let dy = -SNAP_RADIUS; dy <= SNAP_RADIUS; dy += 1) {
    for (let dx = -SNAP_RADIUS; dx <= SNAP_RADIUS; dx += 1) {
      const dist2 = dx * dx + dy * dy;
      if (dist2 > SNAP_RADIUS * SNAP_RADIUS) continue;
      const x = px + dx;
      const y = py + dy;
      if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
      const gradient = map.magnitude[y * map.width + x];
      if (gradient < SNAP_MIN_GRADIENT) continue;
      const score = gradient / (1 + Math.sqrt(dist2));
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (!best) return { x: point.x, y: point.y };
  return { x: best.x / scale, y: best.y / scale };
}

/** Ramer–Douglas–Peucker 折线简化（用于抹掉吸附后多余的小抖动）。 */
function simplifyPath(points, tolerance) {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy) || 1;
  let maxDistance = 0;
  let splitIndex = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i];
    const distance = Math.abs(dy * (p.x - first.x) - dx * (p.y - first.y)) / length;
    if (distance > maxDistance) {
      maxDistance = distance;
      splitIndex = i;
    }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = simplifyPath(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyPath(points.slice(splitIndex), tolerance);
  return left.slice(0, -1).concat(right);
}

/** 智能模式收尾：先在预览坐标简化，再换回原图坐标。 */
function refineSmartPath(entry, points) {
  const scale = entry.preview.scale || 1;
  const previewPoints = points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  const simplified = simplifyPath(previewPoints, SNAP_TOLERANCE);
  if (simplified.length < 3) return points;
  return simplified.map((point) => ({ x: point.x / scale, y: point.y / scale }));
}

// --------------------------------------------------------------- 参数

export function prepareSelected() {
  return ensureEntry(activeItem.value);
}

export function setTool(tool) {
  state.tool = ['lasso', 'pick', 'pan'].includes(tool) ? tool : 'lasso';
  markSessionDirty('bgremove');
}

export function setOption(key, value) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !(key in entry.options) || entry.options[key] === value) return;
  // 这两项只影响工具行为/显示，不改变抠图结果，不进撤销栈
  if (key === 'lassoMode' || key === 'showMask') {
    entry.options[key] = value;
    markSessionDirty('bgremove');
    return;
  }
  recordEntryHistory(entry, `option:${key}`);
  entry.options[key] = value;
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
}

export function resetOptions() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  const unchanged = Object.keys(DEFAULT_OPTIONS).every((key) => entry.options[key] === DEFAULT_OPTIONS[key]);
  if (unchanged) return;
  recordEntryHistory(entry);
  Object.assign(entry.options, DEFAULT_OPTIONS);
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus('背景去除参数已重置');
}

// --------------------------------------------------------------- 颜色

export function autoDetectColors() {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!entry) return;
  recordEntryHistory(entry);
  const detected = detectColors(item);
  entry.detected = detected.colors;
  entry.transparentRatio = detected.transparentRatio;
  entry.colors = defaultColorState(detected.colors);
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus(
    detected.colors.length
      ? `已识别 ${detected.colors.length} 种背景色：${detected.colors.map((color) => color.hex.toUpperCase()).join('、')}`
      : '边框没有可用的背景色（可能整张图都是内容，或边缘已经透明）',
  );
}

export function toggleColor(index) {
  const entry = ensureEntry(activeItem.value);
  if (!entry?.colors[index]) return;
  recordEntryHistory(entry);
  entry.colors[index].enabled = !entry.colors[index].enabled;
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
}

/** 添加/启用一个自定义背景色。 */
export function useColor(input, { exclusive = false } = {}) {
  const entry = ensureEntry(activeItem.value);
  const color = parseColor(input);
  if (!entry || !color) return;
  recordEntryHistory(entry);
  const hex = colorToHex(color);
  const found = entry.colors.find((item) => item.hex.toLowerCase() === hex.toLowerCase());
  if (found) found.enabled = true;
  else entry.colors.push({ ...color, hex, ratio: 0, enabled: true, source: 'custom' });
  if (exclusive) {
    for (const item of entry.colors) item.enabled = item.hex.toLowerCase() === hex.toLowerCase();
  }
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus(`背景色已设为 ${hex.toUpperCase()}${exclusive ? '（仅去除该颜色）' : ''}`);
}

export function removeColor(index) {
  const entry = ensureEntry(activeItem.value);
  if (!entry?.colors[index]) return;
  recordEntryHistory(entry);
  entry.colors.splice(index, 1);
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
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
  // 历史只在真正生成选区时记录：单点点击（顶点不足被取消）不该产生可撤销步骤
  entry.drawing = true;
  const smart = entry.options.lassoMode === 'smart';
  const start = smart ? snapPoint(entry, point) : { x: point.x, y: point.y };
  entry.draftPoints = [start];
}

export function extendLasso(point) {
  const entry = activeEntry.value;
  if (!entry?.drawing || !point) return;
  const smart = entry.options.lassoMode === 'smart';
  const next = smart ? snapPoint(entry, point) : point;
  const last = entry.draftPoints[entry.draftPoints.length - 1];
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < 1.5) return;
  entry.draftPoints.push(next);
}

export function endLasso({ close = true } = {}) {
  const entry = activeEntry.value;
  if (!entry?.drawing) return;
  entry.drawing = false;
  let points = entry.draftPoints;
  entry.draftPoints = [];
  if (entry.options.lassoMode === 'smart' && points.length >= 3) {
    points = refineSmartPath(entry, points);
  }
  if (close && points.length >= 3 && polygonArea(points) >= 4) {
    recordEntryHistory(entry);
    entry.polygon = points;
    entry.selectionMask = markRaw(rasterizePolygon(points, entry.width, entry.height));
    scheduleRecompute(entry);
    markSessionDirty('bgremove');
    const mode = entry.options.lassoMode === 'smart' ? '智能套索（已吸附边缘）' : '套索';
    setStatus(`已建立${mode}选区（${points.length} 个顶点），可切换“仅选区内 / 保护选区”`);
  } else {
    setStatus('套索顶点太少，已取消');
  }
}

export function clearSelection() {
  const entry = ensureEntry(activeItem.value);
  if (!entry || (!entry.polygon.length && !entry.draftPoints.length)) return;
  recordEntryHistory(entry);
  entry.polygon = [];
  entry.draftPoints = [];
  entry.selectionMask = null;
  entry.drawing = false;
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
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

// --------------------------------------------------------------- 临时会话

/** 背景去除只保存参数与选区，预览图在恢复后按原图重新计算。 */
export function exportSession() {
  const items = {};
  for (const [id, entry] of Object.entries(entries)) {
    items[id] = {
      colors: entry.colors.map((color) => ({ ...color })),
      options: { ...entry.options },
      polygon: entry.polygon.map((point) => ({ x: point.x, y: point.y })),
      detected: entry.detected.map((color) => ({ ...color })),
      transparentRatio: entry.transparentRatio,
    };
  }
  return { tool: state.tool, items };
}

export function importSession(doc) {
  for (const id of Object.keys(entries)) {
    if (entries[id]?.timer) clearTimeout(entries[id].timer);
    delete entries[id];
  }
  if (!doc || typeof doc !== 'object') return;
  if (['lasso', 'pick', 'pan'].includes(doc.tool)) state.tool = doc.tool;

  for (const [id, saved] of Object.entries(doc.items ?? {})) {
    const item = workspace.state.items.find((entry) => entry.id === id);
    if (!item) continue;
    const entry = ensureEntry(item);
    if (!entry || !saved) continue;
    if (Array.isArray(saved.colors)) entry.colors = saved.colors.map((color) => ({ ...color }));
    if (saved.options) Object.assign(entry.options, saved.options);
    if (Array.isArray(saved.detected)) entry.detected = saved.detected.map((color) => ({ ...color }));
    if (Number.isFinite(saved.transparentRatio)) entry.transparentRatio = saved.transparentRatio;
    entry.polygon = Array.isArray(saved.polygon) ? saved.polygon.map((point) => ({ x: point.x, y: point.y })) : [];
    entry.selectionMask = entry.polygon.length >= 3
      ? markRaw(rasterizePolygon(entry.polygon, entry.width, entry.height))
      : null;
    // 历史栈不随会话持久化，恢复后从干净的起点开始
    entry.history = [];
    entry.redo = [];
    entry.snapMap = null;
    scheduleRecompute(entry);
  }
}

export function clearSession() {
  for (const id of Object.keys(entries)) {
    if (entries[id]?.timer) clearTimeout(entries[id].timer);
    delete entries[id];
  }
  state.lastPick = null;
}

export function useBgRemoval() {
  return {
    state: readonly(state),
    activeItem,
    activeEntry,
    canUndoBg,
    canRedoBg,
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
      undoBg,
      redoBg,
      exportSession,
      importSession,
      clearSession,
    },
  };
}
