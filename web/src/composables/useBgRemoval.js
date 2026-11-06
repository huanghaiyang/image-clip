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
  buildSubjectMask,
  colorDistance,
  colorToHex,
  detectBackgroundColors,
  parseColor,
} from '@shared/bgremove.js';
import { resizeMaskBilinear } from '@shared/cutout.js';
import { polygonArea, rasterizePolygon, scalePolygon } from '@shared/selection.js';

import { cutoutConcurrency, fetchCutoutStatus, segmentImage } from '../lib/cutout/index.js';

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
  // 智能套索的可调参数（单位都是“屏幕像素”，与图片大小/缩放无关）
  lassoRadius: 14, // 吸附半径：鼠标离边缘多远仍能吸住
  lassoSimplify: 0.8, // 路径简化容差：越小折角越圆润、顶点越多；0=保留全部吸附点
};

/** 只影响套索交互/显示的工具偏好：不进撤销栈，撤销时也保持不变。 */
const TOOL_PREF_KEYS = ['lassoMode', 'lassoRadius', 'lassoSimplify', 'showMask'];

/** AI 抠图的默认状态（每个素材独立保存）。 */
function defaultAiState() {
  return {
    model: 'person',
    // idle | running | ready | error
    status: 'idle',
    progress: null,
    error: '',
    /** 原图分辨率的「主体 alpha」（0 背景 / 255 主体）。 */
    alpha: null,
    /** 预览分辨率的同一份 alpha，供实时预览与参数重算使用。 */
    previewAlpha: null,
    elapsedMs: 0,
    coverage: 0,
  };
}

function resetAiState(entry) {
  entry.ai = defaultAiState();
}

/**
 * 智能套索内部约束。
 * 两个用户参数按“屏幕像素”定义，再按当前缩放换算到预览像素，
 * 这样无论图片多大、缩放多少，手感都是恒定的（原来的固定 5px 在大图上几乎等于没吸附）。
 */
const SNAP_MIN_RADIUS = 3;
const SNAP_MAX_RADIUS = 32;
const SNAP_MIN_GRADIENT = 20;
/** 两个采样点在预览图上的最小间距，小于它就不重复记录。 */
const SNAP_MIN_GAP = 1.2;
const HISTORY_LIMIT = 30;
const OPTION_RECORD_GAP = 500;

const workspace = useWorkspace();

const state = reactive({
  // 套索不默认启用：进入背景去除先给「平移」，需要选区时再手动点「套索」
  tool: 'pan', // lasso | pick | pan
  // 抠图方式标签页：AI 抠图 / 参数抠图（默认停在 AI，但不会自动运行）
  tab: 'ai', // ai | color
  // 批量抠图进度（参考裁剪工作区的批量裁剪）
  batch: { running: false, done: 0, total: 0, saveToLibrary: false },
  busy: false,
  status: '',
  error: '',
  lastPick: null,
  // 当前舞台的“屏幕像素/预览像素”缩放：参数面板改动吸附半径时按同一手感重算选区
  viewScale: 1,
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

/** 「默认不抠图」状态：预览画布直接显示原图。 */
function drawOriginalPreview(entry) {
  const preview = entry.preview;
  let canvas = entry.previewCanvas;
  if (!canvas || canvas.width !== preview.width || canvas.height !== preview.height) {
    canvas = createCanvas(preview.width, preview.height);
    entry.previewCanvas = markRaw(canvas);
  }
  const image = new ImageData(new Uint8ClampedArray(preview.data), preview.width, preview.height);
  canvas.getContext('2d').putImageData(image, 0, 0);
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
    // 默认不抠图：只有用户明确选「参数抠图」或运行 AI 之后才生成掩膜
    mode: 'none', // none | color | ai
    options: { ...DEFAULT_OPTIONS },
    polygon: [],
    draftPoints: [],
    // 本次拖动的原始轨迹（原图坐标）：参数改动时用它重新吸附/简化
    draftRaw: [],
    // 最近一次成功选区的原始轨迹（原图坐标）
    lassoRaw: [],
    drawing: false,
    // 智能套索的连续性状态（预览坐标）：上一次原始落点与上一次吸附点
    lastRawPoint: null,
    lastSnapPoint: null,
    selectionMask: null,
    snapMap: null,
    ai: defaultAiState(),
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
    // 默认不抠图：选图后先原样显示，等用户选参数抠图 / 运行 AI 再生成掩膜
    if (entry.mode === 'none') {
      if (token !== entry.renderToken) return;
      drawOriginalPreview(entry);
      entry.previewMask = null;
      entry.coverage = 0;
      entry.removedPixels = 0;
      entry.elapsedMs = 0;
      entry.error = '';
      entry.previewVersion += 1;
      return;
    }
    const colors = entry.colors.filter((color) => color.enabled).map((color) => parseColor(color));
    const selection =
      entry.polygon.length >= 3
        ? rasterizePolygon(scalePolygon(entry.polygon, preview.scale), preview.width, preview.height)
        : null;

    const built = entry.mode === 'ai' && entry.ai.alpha
      ? buildSubjectMask(entry.ai.previewAlpha, preview.width, preview.height, {
          feather: scaledRadius(entry.options.feather, preview.scale),
          erode: scaledRadius(entry.options.erode, preview.scale),
          selection,
          selectionMode: selection ? entry.options.selectionMode : 'all',
        })
      : buildBackgroundMask(preview.data, preview.width, preview.height, {
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
    mode: entry.mode,
    colors: entry.colors.map((color) => ({ ...color })),
    options: { ...entry.options },
    polygon: entry.polygon.map((point) => ({ x: point.x, y: point.y })),
    detected: entry.detected.map((color) => ({ ...color })),
    transparentRatio: entry.transparentRatio,
    // 只保存 alpha 的引用：重复改参数时不会把几十 MB 的掩膜复制进历史
    ai: {
      model: entry.ai.model,
      alpha: entry.ai.alpha,
      previewAlpha: entry.ai.previewAlpha,
      elapsedMs: entry.ai.elapsedMs,
      coverage: entry.ai.coverage,
    },
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
  // 工具偏好不属于“可撤销的文档状态”：撤销时保留用户当前的套索模式/半径/简化与掩膜显示
  const toolPrefs = {};
  for (const key of TOOL_PREF_KEYS) toolPrefs[key] = entry.options[key];
  entry.mode = snapshot.mode ?? 'none';
  entry.colors = snapshot.colors.map((color) => ({ ...color }));
  entry.options = { ...DEFAULT_OPTIONS, ...snapshot.options, ...toolPrefs };
  entry.detected = snapshot.detected.map((color) => ({ ...color }));
  entry.transparentRatio = snapshot.transparentRatio;
  const ai = snapshot.ai ?? { model: entry.ai.model, alpha: null };
  entry.ai = {
    ...defaultAiState(),
    model: ai.model ?? 'person',
    alpha: ai.alpha ? markRaw(ai.alpha) : null,
    previewAlpha: ai.previewAlpha ? markRaw(ai.previewAlpha) : null,
    status: ai.alpha ? 'ready' : 'idle',
    elapsedMs: ai.elapsedMs ?? 0,
    coverage: ai.coverage ?? 0,
  };
  const samePolygon =
    snapshot.polygon.length === entry.polygon.length &&
    snapshot.polygon.every((point, index) => point.x === entry.polygon[index].x && point.y === entry.polygon[index].y);
  entry.polygon = snapshot.polygon.map((point) => ({ x: point.x, y: point.y }));
  entry.draftPoints = [];
  entry.draftRaw = [];
  // 撤销到别的选区后，原轨迹不再对应，避免调参数时又把新轨迹贴回来
  if (!samePolygon) entry.lassoRaw = [];
  entry.drawing = false;
  entry.lastRawPoint = null;
  entry.lastSnapPoint = null;
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
  // 单位法向量（指向灰度变化方向），用于判断边缘是否“顺着拖动方向”。
  const normalX = new Int8Array(width * height);
  const normalY = new Int8Array(width * height);
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
      const length = Math.hypot(gx, gy);
      if (length > 0.001) {
        normalX[i] = Math.round((gx / length) * 127);
        normalY[i] = Math.round((gy / length) * 127);
      }
    }
  }
  entry.snapMap = markRaw({ width, height, magnitude, normalX, normalY });
  return entry.snapMap;
}

/** 吸附半径：用户设置的是屏幕像素，这里随当前缩放换算成预览像素。 */
function snapRadiusFor(entry, screenScale) {
  const screenRadius = Number(entry.options.lassoRadius);
  const radius = (Number.isFinite(screenRadius) ? screenRadius : 14) / Math.max(0.05, screenScale || 1);
  return Math.max(SNAP_MIN_RADIUS, Math.min(SNAP_MAX_RADIUS, radius));
}

/**
 * 把预览坐标吸附到附近的边缘点。
 *
 * 评分同时考虑三件事，避免“只挑局部最强梯度”导致的乱跳：
 *  1) 梯度强度与离鼠标的距离（近且强优先）；
 *  2) 边缘方向：法向量与拖动方向垂直，说明这条边是“顺着”走的；
 *  3) 与上一个吸附点的连续性，距离过远直接丢弃。
 */
function snapToEdge(entry, point, { radius = SNAP_MIN_RADIUS, prev = null, direction = null } = {}) {
  const map = ensureSnapMap(entry);
  const target = { x: point.x, y: point.y };
  if (!map) return target;

  const r = Math.max(2, Math.round(radius));
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  const x0 = Math.max(1, px - r);
  const x1 = Math.min(map.width - 2, px + r);
  const y0 = Math.max(1, py - r);
  const y1 = Math.min(map.height - 2, py + r);
  if (x1 <= x0 || y1 <= y0) return target;

  // 先用窗口内最大梯度算出相对阈值：弱边缘只要比周围明显也能吸附
  let localMax = 0;
  for (let y = y0; y <= y1; y += 1) {
    const row = y * map.width;
    for (let x = x0; x <= x1; x += 1) {
      const value = map.magnitude[row + x];
      if (value > localMax) localMax = value;
    }
  }
  const threshold = Math.max(SNAP_MIN_GRADIENT, localMax * 0.45);

  let best = null;
  let bestScore = 0;
  for (let y = y0; y <= y1; y += 1) {
    const row = y * map.width;
    for (let x = x0; x <= x1; x += 1) {
      const dist2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (dist2 > r * r) continue;
      const index = row + x;
      const gradient = map.magnitude[index];
      if (gradient < threshold) continue;

      const distance = Math.sqrt(dist2);
      let score = gradient / (1 + distance * 0.7);

      if (prev) {
        const gap = Math.hypot(x - prev.x, y - prev.y);
        // 离上一吸附点太远，多半是另一条边，直接排除
        if (gap > r * 1.9) continue;
        score *= 1 - 0.3 * (gap / (r * 1.9));
      }

      if (direction) {
        const nx = map.normalX[index] / 127;
        const ny = map.normalY[index] / 127;
        if (nx || ny) {
          // |法向量·拖动方向| 越小，说明边走的方向和鼠标走势越一致
          const align = Math.abs(nx * direction.x + ny * direction.y);
          score *= 1 - 0.55 * align;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best ?? target;
}

function toOriginalPoint(entry, point) {
  const scale = entry.preview.scale || 1;
  return { x: point.x / scale, y: point.y / scale };
}

function toPreviewPoint(entry, point) {
  const scale = entry.preview.scale || 1;
  return { x: point.x * scale, y: point.y * scale };
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
function refineSmartPath(entry, points, screenScale = 1) {
  const scale = entry.preview.scale || 1;
  const previewPoints = points.map((point) => ({ x: point.x * scale, y: point.y * scale }));
  const screenTolerance = Number(entry.options.lassoSimplify);
  const tolerance = (Number.isFinite(screenTolerance) ? Math.max(0, screenTolerance) : 0.8) /
    Math.max(0.05, screenScale || 1);
  // 0 表示不做简化：保留全部吸附点，路径最贴合、折角最少
  const simplified = tolerance > 0.01 ? simplifyPath(previewPoints, tolerance) : previewPoints;
  if (simplified.length < 3) return points;
  return simplified.map((point) => ({ x: point.x / scale, y: point.y / scale }));
}

/**
 * 沿 from→to 插值采样并吸附（预览坐标）。
 * 绘制过程与“参数改动后重算”共用这一条路径，保证两种场景的手感一致。
 */
function traceSmartSegment(entry, from, to, radius, cursor, lastPushed) {
  const points = [];
  let current = { x: cursor.x, y: cursor.y };
  let pushed = { x: lastPushed.x, y: lastPushed.y };
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.min(6, Math.max(2, radius * 0.25));
  const steps = Math.min(48, Math.max(1, Math.ceil(distance / step)));

  for (let i = 1; i <= steps; i += 1) {
    const t = {
      x: from.x + (to.x - from.x) * (i / steps),
      y: from.y + (to.y - from.y) * (i / steps),
    };
    const dx = t.x - current.x;
    const dy = t.y - current.y;
    const len = Math.hypot(dx, dy);
    const direction = len > 0.001 ? { x: dx / len, y: dy / len } : null;
    const snapped = snapToEdge(entry, t, { radius, prev: current, direction });
    current = snapped;
    const gap = Math.hypot(current.x - pushed.x, current.y - pushed.y);
    if (gap >= SNAP_MIN_GAP) {
      points.push({ x: current.x, y: current.y });
      pushed = { x: current.x, y: current.y };
    }
  }
  return { cursor: current, points };
}

/** 对整条原始轨迹重新吸附（预览坐标），用于绘制结束后的参数重算。 */
function traceSmartPath(entry, rawPoints, screenScale = 1) {
  const radius = snapRadiusFor(entry, screenScale);
  let cursor = snapToEdge(entry, rawPoints[0], { radius });
  const snapped = [{ x: cursor.x, y: cursor.y }];
  let lastPushed = cursor;
  for (let i = 1; i < rawPoints.length; i += 1) {
    const traced = traceSmartSegment(entry, rawPoints[i - 1], rawPoints[i], radius, cursor, lastPushed);
    cursor = traced.cursor;
    for (const point of traced.points) snapped.push(point);
    if (traced.points.length) lastPushed = traced.points[traced.points.length - 1];
  }
  return snapped;
}

/** 用当前参数从原始轨迹生成选区（原图坐标）。 */
function deriveLassoPolygon(entry, screenScale = 1) {
  const raw = entry.lassoRaw.map((point) => toPreviewPoint(entry, point));
  if (raw.length < 3) return null;

  if (entry.options.lassoMode === 'free') {
    // 手绘：直接还原拖动轨迹，只做最小间距去重
    const points = [];
    let previous = null;
    for (const point of raw) {
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < SNAP_MIN_GAP) continue;
      previous = point;
      points.push(toOriginalPoint(entry, point));
    }
    return points;
  }

  const snapped = traceSmartPath(entry, raw, screenScale);
  const originals = snapped.map((point) => toOriginalPoint(entry, point));
  return refineSmartPath(entry, originals, screenScale);
}

/**
 * 参数变更后重算已绘制的选区（吸附半径 → 贴哪条边，路径简化 → 保留多少顶点）。
 * 这属于“工具偏好”变更，不占撤销步骤。
 */
function refreshLasso(entry, screenScale = state.viewScale) {
  if (!entry || entry.drawing || !entry.lassoRaw.length) return false;
  const points = deriveLassoPolygon(entry, screenScale);
  if (!points || points.length < 3 || polygonArea(points) < 4) return false;
  entry.polygon = points;
  entry.selectionMask = markRaw(rasterizePolygon(points, entry.width, entry.height));
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  return true;
}

// --------------------------------------------------------------- 参数

export function prepareSelected() {
  return ensureEntry(activeItem.value);
}

export function setTool(tool) {
  state.tool = ['lasso', 'pick', 'pan'].includes(tool) ? tool : 'lasso';
  markSessionDirty('bgremove');
}

/**
 * 切换「AI 抠图 / 参数抠图」标签页。
 * 切到参数页立即按颜色参数生效；切到 AI 页时如果还没有 AI 结果，就回到“不抠图”，
 * 避免标签页和画面结果对不上。
 */
export function setTab(tab) {
  const next = tab === 'color' ? 'color' : 'ai';
  state.tab = next;
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  const mode = next === 'color' ? 'color' : entry.ai.alpha ? 'ai' : 'none';
  if (entry.mode !== mode) {
    entry.mode = mode;
    scheduleRecompute(entry);
  }
  markSessionDirty('bgremove');
}

/** 参数抠图页的显式入口：默认不抠图时，点一下才按当前颜色参数生成掩膜。 */
export function startColorRemoval() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  if (entry.mode !== 'color') {
    recordEntryHistory(entry);
    entry.mode = 'color';
    scheduleRecompute(entry);
    markSessionDirty('bgremove');
  }
  setStatus('已按当前颜色参数抠图，可继续调整容差 / 背景色');
}

/** 舞台缩放变化时记录当前比例，供参数面板换算“屏幕像素”吸附半径。 */
export function setViewScale(scale) {
  const value = Number(scale);
  if (Number.isFinite(value) && value > 0) state.viewScale = value;
}

/** 会影响已绘制套索形态的工具偏好：改完要用原始轨迹重新生成选区。 */
const LASSO_REBUILD_KEYS = ['lassoMode', 'lassoRadius', 'lassoSimplify'];

export function setOption(key, value) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !(key in entry.options) || entry.options[key] === value) return;
  // 这几项只影响套索交互/显示，不改变抠图参数，不进撤销栈
  if (TOOL_PREF_KEYS.includes(key)) {
    entry.options[key] = value;
    // 套索参数必须立刻作用于已经画好的选区，而不是只影响下一次绘制
    if (LASSO_REBUILD_KEYS.includes(key)) refreshLasso(entry);
    markSessionDirty('bgremove');
    return;
  }
  recordEntryHistory(entry, `option:${key}`);
  // 默认不抠图：第一次改抠图参数就视为“开始参数抠图”，AI 结果则继续保留
  if (entry.mode === 'none') entry.mode = 'color';
  entry.options[key] = value;
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
}

export function resetOptions() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  const keys = Object.keys(DEFAULT_OPTIONS);
  const docChanged = keys.some(
    (key) => !TOOL_PREF_KEYS.includes(key) && entry.options[key] !== DEFAULT_OPTIONS[key],
  );
  const prefChanged = TOOL_PREF_KEYS.some((key) => entry.options[key] !== DEFAULT_OPTIONS[key]);
  const lassoChanged = LASSO_REBUILD_KEYS.some((key) => entry.options[key] !== DEFAULT_OPTIONS[key]);
  if (!docChanged && !prefChanged) return;
  // 只重置工具偏好时不必占用一步撤销
  if (docChanged) recordEntryHistory(entry);
  Object.assign(entry.options, DEFAULT_OPTIONS);
  if (lassoChanged) refreshLasso(entry);
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus('背景去除参数已重置');
}

// --------------------------------------------------------------- 颜色

/** 任何颜色操作都视为开始「参数抠图」；AI 结果不受影响。 */
function ensureColorMode(entry) {
  if (entry.mode === 'none') entry.mode = 'color';
}

export function autoDetectColors() {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!entry) return;
  recordEntryHistory(entry);
  ensureColorMode(entry);
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
  ensureColorMode(entry);
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
  ensureColorMode(entry);
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus(`背景色已设为 ${hex.toUpperCase()}${exclusive ? '（仅去除该颜色）' : ''}`);
}

export function removeColor(index) {
  const entry = ensureEntry(activeItem.value);
  if (!entry?.colors[index]) return;
  recordEntryHistory(entry);
  entry.colors.splice(index, 1);
  ensureColorMode(entry);
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

/**
 * 开始套索。`point` 使用预览图坐标，`screenScale` 是当前“屏幕像素/预览像素”的缩放比例。
 */
export function beginLasso(point, screenScale = 1) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !point) return;
  // 历史只在真正生成选区时记录：单点点击（顶点不足被取消）不该产生可撤销步骤
  entry.drawing = true;
  const smart = entry.options.lassoMode === 'smart';
  const raw = { x: point.x, y: point.y };
  entry.draftRaw = [toOriginalPoint(entry, raw)];
  entry.lastRawPoint = raw;
  const start = smart ? snapToEdge(entry, raw, { radius: snapRadiusFor(entry, screenScale) }) : raw;
  entry.lastSnapPoint = start;
  entry.draftPoints = [toOriginalPoint(entry, start)];
}

/**
 * 拖动采样。智能模式下会在两个鼠标事件之间按小步长插值，
 * 每个插值点都重新吸附并带着“方向 + 连续性”的评分，路径因此能贴着边缘走。
 */
export function extendLasso(point, screenScale = 1) {
  const entry = activeEntry.value;
  if (!entry?.drawing || !point) return;
  const smart = entry.options.lassoMode === 'smart';
  const raw = { x: point.x, y: point.y };
  // 原始轨迹一并留存：之后调整吸附半径/路径简化时，用它重算当前选区
  entry.draftRaw.push(toOriginalPoint(entry, raw));
  const lastRaw = entry.lastRawPoint ?? raw;
  const prev = entry.lastSnapPoint ?? lastRaw;

  if (!smart) {
    const next = toOriginalPoint(entry, raw);
    const last = entry.draftPoints[entry.draftPoints.length - 1];
    const scale = entry.preview.scale || 1;
    if (last && Math.hypot(next.x - last.x, next.y - last.y) < SNAP_MIN_GAP / scale) return;
    entry.draftPoints.push(next);
    entry.lastRawPoint = raw;
    entry.lastSnapPoint = raw;
    return;
  }

  const radius = snapRadiusFor(entry, screenScale);
  const lastPoint = entry.draftPoints[entry.draftPoints.length - 1];
  const lastPushed = lastPoint ? toPreviewPoint(entry, lastPoint) : { ...prev };
  const traced = traceSmartSegment(entry, lastRaw, raw, radius, prev, lastPushed);
  for (const point of traced.points) entry.draftPoints.push(toOriginalPoint(entry, point));

  entry.lastRawPoint = raw;
  entry.lastSnapPoint = traced.cursor;
}

export function endLasso({ close = true } = {}, screenScale = 1) {
  const entry = activeEntry.value;
  if (!entry?.drawing) return;
  entry.drawing = false;
  entry.lastRawPoint = null;
  entry.lastSnapPoint = null;
  const raw = entry.draftRaw;
  entry.draftRaw = [];
  let points = entry.draftPoints;
  entry.draftPoints = [];
  if (entry.options.lassoMode === 'smart' && points.length >= 3) {
    points = refineSmartPath(entry, points, screenScale);
  }
  if (close && points.length >= 3 && polygonArea(points) >= 4) {
    recordEntryHistory(entry);
    // 保存原始轨迹：之后拖动“吸附半径 / 路径简化”会据此重新生成选区
    entry.lassoRaw = raw;
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
  entry.draftRaw = [];
  entry.lassoRaw = [];
  entry.selectionMask = null;
  entry.drawing = false;
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus('已清除套索选区');
}

// --------------------------------------------------------------- AI 精准抠像

/** 服务端的模型就绪状态（用于面板提示；未下载时给出下载命令）。 */
const cutoutModels = reactive({ loading: false, loaded: false, error: '', models: [], install: '' });

export async function loadCutoutStatus(force = false) {
  if (cutoutModels.loading || (cutoutModels.loaded && !force)) return;
  cutoutModels.loading = true;
  cutoutModels.error = '';
  try {
    const status = await fetchCutoutStatus();
    cutoutModels.models = status.models ?? [];
    cutoutModels.install = status.install ?? '';
    cutoutModels.loaded = true;
  } catch (err) {
    cutoutModels.error = err.message;
  } finally {
    cutoutModels.loading = false;
  }
}

/**
 * 运行 AI 精准抠图（浏览器 WASM 推理）。
 *
 * 只换取一次原图 alpha：预览用降采样版本实时重算，应用时直接用原图 alpha，
 * 避免每次调羽化/选区都重新跑一遍神经网络。
 */
export async function runAiCutout(modelId) {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!item || !entry) {
    setError('请先选择一张图片');
    return null;
  }
  if (entry.ai.status === 'running') return null;

  const model = modelId || entry.ai.model;
  entry.ai.model = model;
  entry.ai.status = 'running';
  entry.ai.error = '';
  entry.ai.progress = { phase: 'start', message: '准备模型…' };
  setStatus('AI 抠像中…');

  try {
    // Worker 会转移这块内存的所有权；必须复制，不能把素材本身的数据传出去
    const rgba = new Uint8ClampedArray(entry.sourceData);
    const result = await segmentImage({
      modelId: model,
      rgba,
      width: item.width,
      height: item.height,
      onProgress: (progress) => {
        entry.ai.progress = { ...progress };
      },
    });

    entry.ai.alpha = markRaw(result.alpha);
    entry.ai.previewAlpha = markRaw(
      resizeMaskBilinear(result.alpha, item.width, item.height, entry.preview.width, entry.preview.height),
    );
    entry.ai.status = 'ready';
    entry.ai.progress = null;
    entry.ai.elapsedMs = result.elapsedMs;
    // AI 结果接管掩膜；标签页也切到 AI，保持面板与画面一致
    entry.mode = 'ai';
    state.tab = 'ai';
    recordEntryHistory(entry, 'ai-cutout');
    scheduleRecompute(entry);
    markSessionDirty('bgremove');
    const label = cutoutModels.models.find((m) => m.id === model)?.label ?? model;
    setStatus(`AI 抠像完成（${label} · ${result.elapsedMs}ms），可继续用羽化/套索微调`);
    return result;
  } catch (err) {
    entry.ai.status = 'error';
    entry.ai.progress = null;
    entry.ai.error = err.message;
    setError(`AI 抠像失败：${err.message}`);
    return null;
  }
}

/** 切换后续运行使用的模型（不清除当前 AI 结果）。 */
export function setAiModel(modelId) {
  const entry = ensureEntry(activeItem.value);
  if (entry && modelId) entry.ai.model = modelId;
}

/** 清除 AI 结果，回到「默认不抠图」。 */
export function clearAiCutout() {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !entry.ai.alpha) return;
  recordEntryHistory(entry);
  resetAiState(entry);
  entry.ai.status = 'idle';
  entry.mode = 'none';
  state.tab = 'ai';
  scheduleRecompute(entry);
  markSessionDirty('bgremove');
  setStatus('已清除 AI 抠像结果，当前不抠图');
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
  if (entry.mode === 'none') {
    setError('还没有抠图结果：先在「AI 抠图」运行模型，或在「参数抠图」开始去除背景');
    return null;
  }

  state.busy = true;
  const started = performance.now();
  try {
    // 整个应用过程只认这一份面板参数快照，避免中途被别的事件改掉
    const options = { ...entry.options };
    const colors = entry.colors.filter((color) => color.enabled).map((color) => parseColor(color));
    const polygon = entry.polygon.map((point) => ({ x: point.x, y: point.y }));
    // 预览有 140ms 防抖：先把还没算完的预览补上，保证“导出结果 = 当前预览”
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      await recompute(entry);
    }

    const selection = polygon.length >= 3 ? rasterizePolygon(polygon, item.width, item.height) : null;
    const useAi = entry.mode === 'ai' && entry.ai.alpha;
    const built = useAi
      ? buildSubjectMask(entry.ai.alpha, item.width, item.height, {
          feather: options.feather,
          erode: options.erode,
          selection,
          selectionMode: selection ? options.selectionMode : 'all',
        })
      : buildBackgroundMask(item.imageData.data, item.width, item.height, {
          colors,
          tolerance: options.tolerance,
          connected: options.connected,
          feather: options.feather,
          erode: options.erode,
          selection,
          selectionMode: selection ? options.selectionMode : 'all',
        });
    const applied = applyMaskToRgba(item.imageData.data, item.width, item.height, built.mask, {
      decontaminate: options.decontaminate,
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
    // 结果只是产物：应用后回到原素材继续编辑，
    // 否则面板会切到结果图（默认参数、且已经没有背景色），再调参就像“应用没反应”
    if (newItem) workspace.actions.selectItem(item.id);

    const coverage = (built.coverage * 100).toFixed(1);
    setStatus(
      `已应用背景去除：透明 ${coverage}% · ${Math.round(performance.now() - started)}ms${
        saveToLibrary ? ' · 已保存到资源库/抠图结果' : ''
      } · 结果已加入左侧素材列表（仍在编辑原图）`,
    );
    return { blob, newItem, coverage: built.coverage };
  } catch (err) {
    setError(`应用背景去除失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

// --------------------------------------------------------------- 批量抠图

/**
 * 批量抠图（参考裁剪工作区的图集/批量裁剪）：
 * 只处理「当前素材」里勾选的图片；以当前标签页的方法为模板——参数页用当前颜色与去除参数，
 * AI 页用当前模型，套索选区按归一化坐标换算到每张图，逐个生成 `-去背景.png` 加入素材列表。
 */
export async function batchBackgroundRemoval({ saveToLibrary = false } = {}) {
  const template = ensureEntry(activeItem.value);
  const all = [...workspace.checkedItems.value];
  if (!template) {
    setError('请先选择一张图片作为批量模板');
    return null;
  }
  if (!all.length) {
    setError('请先在左侧「当前素材」中勾选要批量抠图的图片');
    return null;
  }
  if (state.batch.running || state.busy) return null;

  const useAi = state.tab === 'ai';
  const model = template.ai.model;
  const colors = template.colors.filter((color) => color.enabled).map((color) => parseColor(color));
  const options = { ...template.options };
  const polygonNorm =
    template.polygon.length >= 3
      ? template.polygon.map((point) => ({ x: point.x / template.width, y: point.y / template.height }))
      : null;

  const started = performance.now();
  state.batch.running = true;
  state.batch.done = 0;
  state.batch.total = all.length;
  state.batch.saveToLibrary = saveToLibrary;
  state.busy = true;
  setStatus(`正在批量抠图（${useAi ? 'AI' : '颜色参数'}）：${all.length} 张…`);

  const results = [];
  let failed = 0;
  // AI 推理在 Worker 池里跑，可以同时处理多张；颜色参数模式仍逐张处理。
  const limit = useAi ? Math.min(cutoutConcurrency(), all.length) : 1;

  async function processItem(item) {
    try {
      let alpha = null;
      if (useAi) {
        // Worker 会转移传入内存的所有权，必须复制一份
        const segmented = await segmentImage({
          modelId: model,
          rgba: new Uint8ClampedArray(item.imageData.data),
          width: item.width,
          height: item.height,
        });
        alpha = segmented.alpha;
      }
      const selection = polygonNorm
        ? rasterizePolygon(
            polygonNorm.map((point) => ({ x: point.x * item.width, y: point.y * item.height })),
            item.width,
            item.height,
          )
        : null;
      const built = alpha
        ? buildSubjectMask(alpha, item.width, item.height, {
            feather: options.feather,
            erode: options.erode,
            selection,
            selectionMode: selection ? options.selectionMode : 'all',
          })
        : buildBackgroundMask(item.imageData.data, item.width, item.height, {
            colors,
            tolerance: options.tolerance,
            connected: options.connected,
            feather: options.feather,
            erode: options.erode,
            selection,
            selectionMode: selection ? options.selectionMode : 'all',
          });
      const applied = applyMaskToRgba(item.imageData.data, item.width, item.height, built.mask, {
        decontaminate: options.decontaminate,
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
      await workspace.actions.addImageBlob(blob, filename);
      if (saveToLibrary) await saveBlobToLibrary(blob, filename, '抠图结果');
      return { name: filename, coverage: built.coverage };
    } catch (err) {
      console.warn('[bgremove] 批量抠图失败:', item.name, err.message);
      return null;
    } finally {
      state.batch.done += 1;
    }
  }

  try {
    const queue = [...all];
    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (queue.length) {
          const item = queue.shift();
          const result = await processItem(item);
          if (result) results.push(result);
          else failed += 1;
          // 让出一帧，避免连续计算把界面卡住
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }),
    );

    setStatus(
      `批量抠图完成：${results.length}/${all.length} 张 · ${Math.round(performance.now() - started)}ms` +
        `${saveToLibrary ? ' · 已保存到资源库/抠图结果' : ''}${failed ? ` · 失败 ${failed}` : ''}`,
    );
    return { results, failed, total: all.length };
  } catch (err) {
    setError(`批量抠图失败：${err.message}`);
    return null;
  } finally {
    state.batch.running = false;
    state.busy = false;
  }
}

// --------------------------------------------------------------- 临时会话

/** 背景去除只保存参数与选区，预览图在恢复后按原图重新计算。 */
export function exportSession() {
  const items = {};
  for (const [id, entry] of Object.entries(entries)) {
    items[id] = {
      // AI 掩膜体积大不持久化，恢复后 AI 页需要重新运行
      mode: entry.mode === 'ai' ? 'none' : entry.mode,
      colors: entry.colors.map((color) => ({ ...color })),
      options: { ...entry.options },
      polygon: entry.polygon.map((point) => ({ x: point.x, y: point.y })),
      // 原始轨迹，恢复后仍可调吸附半径/简化重算选区
      rawPath: entry.lassoRaw.map((point) => ({ x: point.x, y: point.y })),
      detected: entry.detected.map((color) => ({ ...color })),
      transparentRatio: entry.transparentRatio,
    };
  }
  return { tool: state.tool, tab: state.tab, items };
}

export function importSession(doc) {
  for (const id of Object.keys(entries)) {
    if (entries[id]?.timer) clearTimeout(entries[id].timer);
    delete entries[id];
  }
  if (!doc || typeof doc !== 'object') return;
  // 套索不默认启用：恢复会话只带回取色器/平移，不还原上次的套索工具
  state.tool = ['pick', 'pan'].includes(doc.tool) ? doc.tool : 'pan';
  state.tab = doc.tab === 'color' ? 'color' : 'ai';

  for (const [id, saved] of Object.entries(doc.items ?? {})) {
    const item = workspace.state.items.find((entry) => entry.id === id);
    if (!item) continue;
    const entry = ensureEntry(item);
    if (!entry || !saved) continue;
    if (Array.isArray(saved.colors)) entry.colors = saved.colors.map((color) => ({ ...color }));
    entry.mode = saved.mode === 'color' ? 'color' : 'none';
    if (saved.options) Object.assign(entry.options, saved.options);
    if (Array.isArray(saved.detected)) entry.detected = saved.detected.map((color) => ({ ...color }));
    if (Number.isFinite(saved.transparentRatio)) entry.transparentRatio = saved.transparentRatio;
    entry.polygon = Array.isArray(saved.polygon) ? saved.polygon.map((point) => ({ x: point.x, y: point.y })) : [];
    entry.lassoRaw = Array.isArray(saved.rawPath)
      ? saved.rawPath.map((point) => ({ x: point.x, y: point.y }))
      : [];
    entry.selectionMask = entry.polygon.length >= 3
      ? markRaw(rasterizePolygon(entry.polygon, entry.width, entry.height))
      : null;
    // 历史栈不随会话持久化，恢复后从干净的起点开始
    entry.history = [];
    entry.redo = [];
    entry.snapMap = null;
    entry.drawing = false;
    entry.draftPoints = [];
    entry.draftRaw = [];
    entry.lastRawPoint = null;
    entry.lastSnapPoint = null;
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
    cutoutModels: readonly(cutoutModels),
    canUndoBg,
    canRedoBg,
    actions: {
      prepareSelected,
      setTool,
      setTab,
      startColorRemoval,
      setViewScale,
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
      runAiCutout,
      setAiModel,
      clearAiCutout,
      loadCutoutStatus,
      applyBackgroundRemoval,
      batchBackgroundRemoval,
      undoBg,
      redoBg,
      exportSession,
      importSession,
      clearSession,
    },
  };
}
