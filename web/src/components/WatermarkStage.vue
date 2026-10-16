<script setup>
/**
 * 水印模式的中央画布：源图 / 掩膜 / 结果三种视图 + 掩膜画笔 + 前后对比。
 *
 * 性能设计（大图是主要场景，4000×3000 很常见）：
 *  - 两层 canvas 分工：base 画棋盘格+图片（只在换图/换视图时重绘），
 *    overlay 只画掩膜与笔刷光标（涂抹期间每帧都要动）。
 *  - 掩膜先在离屏层按图片像素坐标画好（增量），再按“显示分辨率”缓存成 maskCanvas；
 *    每帧只把 maskCanvas 贴一次到 overlay，重绘的是显示尺寸而不是图片尺寸，
 *    避免每帧上传 4000×3000 级别的纹理。
 *  - 涂抹坐标最终由 composable 回写到 Uint8Array，保证“看到的就是要提交的掩膜”。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { useWatermark } from '../composables/useWatermark.js';
import { createMaskLayer, maskToImageData } from '../lib/watermark.js';

const { state: workspaceState, selected, actions: workspaceActions } = useWorkspace();
const { state, selectedEntry, hasMask, coverage, actions } = useWatermark();

const stageEl = ref(null);
const baseEl = ref(null);
const overlayEl = ref(null);
const stageSize = ref({ w: 0, h: 0 });
const offset = ref({ x: 0, y: 0 });
const cursor = ref(null);
const dragging = ref(false);
const dropActive = ref(false);

const VIEWS = [
  { value: 'source', label: '原图' },
  { value: 'mask', label: '掩膜' },
  { value: 'result', label: '结果' },
];

const item = computed(() => selected.value);
const entry = computed(() => selectedEntry.value);
const view = computed(() => state.view);
const result = computed(() => entry.value?.result ?? null);
/** 自动检测出的候选区域个数（画布标记与左下角读数共用） */
const boxCount = computed(() => entry.value?.detect?.boxes?.length ?? 0);
const resultUrl = computed(() => result.value?.url ?? '');
const isCompare = computed(() => view.value.compare && Boolean(resultUrl.value));

const displayDims = computed(() => {
  const current = item.value;
  if (!current) return { w: 1, h: 1 };
  return { w: current.width, h: current.height };
});

const isFit = computed(() => view.value.zoom === 'fit');

const fitScale = computed(() => {
  const { w, h } = displayDims.value;
  const pad = 96;
  const available = { w: Math.max(32, stageSize.value.w - pad), h: Math.max(32, stageSize.value.h - pad) };
  return Math.min(available.w / w, available.h / h, 8) || 1;
});

const zoom = computed(() => (isFit.value ? fitScale.value : Number(view.value.zoom) || 1));

function centeredOffset(scale = zoom.value) {
  const { w, h } = displayDims.value;
  return {
    x: Math.round((stageSize.value.w - w * scale) / 2),
    y: Math.round((stageSize.value.h - h * scale) / 2),
  };
}

function fitToView() {
  actions.setView('zoom', 'fit');
  offset.value = centeredOffset();
}

function setZoom(value, anchor) {
  const next = Math.min(8, Math.max(0.02, value));
  const stage = stageEl.value;
  if (anchor && stage) {
    const rect = stage.getBoundingClientRect();
    const ax = anchor.x - rect.left;
    const ay = anchor.y - rect.top;
    const ratio = next / zoom.value;
    offset.value = { x: ax - (ax - offset.value.x) * ratio, y: ay - (ay - offset.value.y) * ratio };
  }
  actions.setView('zoom', Number(next.toFixed(4)));
}

// ------------------------------------------------------------- 绘制

let patternCache = { key: '', pattern: null };
let rafId = 0;
let maskLayer = null;
let maskCanvas = null;
let maskScratch = null;
let overlayVersion = -1;
let overlayDims = { w: 0, h: 0 };
let lastCacheKey = '';
const resultCache = { url: '', image: null };

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function checkerPattern(ctx) {
  const a = cssVar('--checker-a', '#1a1a1a');
  const b = cssVar('--checker-b', '#262626');
  const key = `${a}|${b}`;
  if (patternCache.key !== key) {
    const tile = document.createElement('canvas');
    tile.width = 16;
    tile.height = 16;
    const tctx = tile.getContext('2d');
    tctx.fillStyle = a;
    tctx.fillRect(0, 0, 16, 16);
    tctx.fillStyle = b;
    tctx.fillRect(0, 0, 8, 8);
    tctx.fillRect(8, 8, 8, 8);
    patternCache = { key, pattern: ctx.createPattern(tile, 'repeat') };
  }
  return patternCache.pattern;
}

function requestDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    paint();
  });
}

/** 掩膜层：与图片同尺寸的离屏 canvas，画笔落点后只提交受影响的小块。 */
function ensureMaskLayer() {
  const current = item.value;
  const currentEntry = entry.value;
  if (!current || !currentEntry?.maskState.mask) {
    maskLayer = null;
    return null;
  }
  const { width, height, mask, version } = currentEntry.maskState;
  if (!maskLayer || maskLayer.canvas.width !== width || maskLayer.canvas.height !== height) {
    maskLayer = createMaskLayer(width, height, { color: cssVar('--accent', '#0d99ff'), alpha: 0.55 });
    maskLayer.rebuild(mask);
    maskLayer.version = version;
    return maskLayer;
  }
  // 版本不一致说明掩膜被整体替换或回滚（新检测 / 撤销 / 清空 / 反选）→ 整层重建
  if (maskLayer.version !== version) {
    maskLayer.rebuild(mask);
    maskLayer.version = version;
  }
  return maskLayer;
}

/** 结果图必须在 canvas 里解码（DOM img 作为可绘制源，Blob URL 直接交给 drawImage）。 */
async function ensureResultImage() {
  const url = resultUrl.value;
  if (!url) {
    resultCache.url = '';
    resultCache.image = null;
    return null;
  }
  if (resultCache.url === url) return resultCache.image;
  resultCache.url = url;
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('无法解码去除结果'));
      img.src = url;
    });
    resultCache.image = img;
  } catch {
    resultCache.image = null;
  }
  requestDraw();
  return resultCache.image;
}

function imageRect() {
  const { w, h } = displayDims.value;
  const scale = zoom.value;
  return { x: offset.value.x, y: offset.value.y, w: w * scale, h: h * scale };
}

function paintBase() {
  const canvas = baseEl.value;
  const stage = stageEl.value;
  if (!canvas || !stage) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = checkerPattern(ctx);
  ctx.fillRect(0, 0, w, h);

  const current = item.value;
  if (!current) return;
  const rect = imageRect();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (view.value.mode === 'mask') {
    // 掩膜视图下把源图压暗，白色掩膜块才看得清
    ctx.globalAlpha = 0.28;
    ctx.drawImage(current.bitmap, rect.x, rect.y, rect.w, rect.h);
    ctx.globalAlpha = 1;
    return;
  }

  if (view.value.mode === 'result' && isCompare.value) {
    // 左原图 / 右结果：同一坐标系 + clip，保证两侧像素严格对齐
    const splitX = rect.x + rect.w * view.value.split;
    ctx.drawImage(current.bitmap, rect.x, rect.y, rect.w, rect.h);
    const image = resultCache.image;
    if (image) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, rect.y, Math.max(0, rect.x + rect.w - splitX), rect.h);
      ctx.clip();
      ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }
    return;
  }

  if (view.value.mode === 'result' && resultCache.image) {
    ctx.drawImage(resultCache.image, rect.x, rect.y, rect.w, rect.h);
    return;
  }

  ctx.drawImage(current.bitmap, rect.x, rect.y, rect.w, rect.h);
}

/**
 * 显示分辨率的掩膜缓存：只在掩膜版本/尺寸/缩放变化时重算，画笔每帧只需一次 drawImage。
 *
 * 掩膜视图走另一条路径（直接画灰度像素），因为那里要展示“白=会去掉”的真实掩膜，
 * 而不是强调色叠加层——两种画法混在一起容易让用户误读掩膜范围。
 */
function refreshMaskCanvas() {
  const stage = stageEl.value;
  const currentEntry = entry.value;
  const rect = imageRect();
  const width = Math.max(1, Math.round(rect.w));
  const height = Math.max(1, Math.round(rect.h));
  if (!stage || !currentEntry?.maskState.mask) return null;

  // 版本号读响应式镜像（maskState 是 markRaw，直接读它无法触发重绘）
  const version = currentEntry.maskVersion;
  const key = view.value.mode === 'mask' ? 'mask' : 'overlay';
  const pending =
    !maskCanvas ||
    overlayDims.w !== width ||
    overlayDims.h !== height ||
    overlayVersion !== version ||
    lastCacheKey !== key;
  if (!pending) return { canvas: maskCanvas, x: rect.x, y: rect.y, w: width, h: height };

  const layer = ensureMaskLayer();
  if (!maskCanvas) maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const ctx = maskCanvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  if (key === 'mask') {
    // 掩膜视图：按显示尺寸重采样灰度掩膜，白色即会被去除的区域。
    // scratch 复用同一张（尺寸随素材变化才重建），避免每次切换视图都申请一张全尺寸画布。
    if (!maskScratch || maskScratch.width !== currentEntry.maskState.width || maskScratch.height !== currentEntry.maskState.height) {
      maskScratch = document.createElement('canvas');
      maskScratch.width = currentEntry.maskState.width;
      maskScratch.height = currentEntry.maskState.height;
    }
    const sctx = maskScratch.getContext('2d');
    sctx.putImageData(maskToImageData(currentEntry.maskState.mask, maskScratch.width, maskScratch.height), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(maskScratch, 0, 0, width, height);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (layer) ctx.drawImage(layer.canvas, 0, 0, width, height);
  }

  overlayDims = { w: width, h: height };
  overlayVersion = version;
  lastCacheKey = key;
  return { canvas: maskCanvas, x: rect.x, y: rect.y, w: width, h: height };
}

function paintOverlay() {
  const canvas = overlayEl.value;
  const stage = stageEl.value;
  if (!canvas || !stage) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!item.value) return;

  if (view.value.mode !== 'result' && state.brush.showOverlay) {
    const cached = refreshMaskCanvas();
    if (cached) ctx.drawImage(cached.canvas, cached.x, cached.y, cached.w, cached.h);
  }

  // 检出位置标记：自动检测出的候选区域画成虚线框。
  // 不受「掩膜叠加」开关影响 —— 这是"检测结果"，不是掩膜本身；关掉叠加时
  // 也要能看出水印在哪（否则用户只看到面板里一个数字，不知道该修哪里）。
  if (view.value.mode !== 'result') paintDetectBoxes(ctx);

  // 笔刷光标：掩膜视图/原图视图下都要能看见落点，用强调色描边
  if (cursor.value?.inside && view.value.mode !== 'result') {
    const r = Math.max(1, state.brush.radius * zoom.value);
    ctx.beginPath();
    ctx.arc(cursor.value.x, cursor.value.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
    ctx.strokeStyle = cssVar('--accent', '#0d99ff');
    ctx.stroke();
  }
}

/**
 * 把自动检测出的候选区域画成屏幕坐标的虚线框。
 *
 * 编号只给面积最大的若干个：平铺水印会一次检出几十个区域，
 * 逐个标号会糊成一片，但框全部保留（用户需要看到完整范围）。
 */
function paintDetectBoxes(ctx) {
  const boxes = entry.value?.detect?.boxes;
  if (!boxes?.length) return;
  const rect = imageRect();
  const scale = zoom.value;
  if (rect.w <= 0 || rect.h <= 0 || scale <= 0) return;

  const mapped = boxes
    .map((box, index) => ({
      index: index + 1,
      area: box.width * box.height,
      x: rect.x + box.x * scale,
      y: rect.y + box.y * scale,
      w: Math.max(1, box.width * scale),
      h: Math.max(1, box.height * scale),
    }))
    // 屏幕上不足 3px 的框画出来只会是一坨噪点
    .filter((b) => b.w >= 3 && b.h >= 3);
  if (!mapped.length) return;

  const color = cssVar('--warn', '#ffcd29');
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = color;
  for (const b of mapped) ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
  ctx.setLineDash([]);

  const labeled = [...mapped].sort((a, b) => b.area - a.area).slice(0, 8);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (const b of labeled) {
    const text = String(b.index);
    const padX = 3;
    const chipW = ctx.measureText(text).width + padX * 2;
    const chipH = 14;
    // 框在画布边缘时把标签翻到框内，避免被裁掉
    const cx = Math.min(b.x, rect.x + rect.w - chipW);
    const cy = b.y - chipH - 2 >= rect.y ? b.y - chipH - 2 : b.y + 2;
    ctx.fillStyle = color;
    ctx.fillRect(cx, cy, chipW, chipH);
    ctx.fillStyle = '#141414';
    ctx.fillText(text, cx + padX, cy + chipH / 2 + 0.5);
  }
  ctx.restore();
}

function paint() {
  try {
    paintBase();
    paintOverlay();
  } catch (err) {
    console.error('[image-clip] 水印画布绘制失败', err);
  }
}

/** 屏幕坐标 → 图片像素坐标；返回 null 表示落在图片外。 */
function toImagePoint(event) {
  const stage = stageEl.value;
  const current = item.value;
  if (!stage || !current) return null;
  const rect = stage.getBoundingClientRect();
  const scale = zoom.value;
  const ix = (event.clientX - rect.left - offset.value.x) / scale;
  const iy = (event.clientY - rect.top - offset.value.y) / scale;
  return {
    x: Math.floor(ix),
    y: Math.floor(iy),
    inside: ix >= 0 && iy >= 0 && ix < current.width && iy < current.height,
  };
}

/** 对比分隔条在 stage 内的 X 坐标（DOM 覆盖层与命中判定共用同一套换算）。 */
const splitLocal = computed(() => {
  const rect = imageRect();
  return rect.x + rect.w * view.value.split;
});

function pointerLocalX(event) {
  const stage = stageEl.value;
  if (!stage) return 0;
  return event.clientX - stage.getBoundingClientRect().left;
}

// ------------------------------------------------------------- 交互

let panState = null;
let stroke = null;
let splitDrag = false;

function isEraseModifier(event) {
  return state.brush.tool === 'erase' || event.altKey || event.button === 2;
}

function onPointerDown(event) {
  const stage = stageEl.value;
  if (!stage || !item.value) return;
  if (event.target.closest?.('.stage-toolbar, .stage-zoom, .empty-actions, .split-handle')) return;

  // 前后对比：落在分隔条附近时优先拖动分隔条，而不是涂抹
  if (isCompare.value && event.button === 0) {
    if (Math.abs(pointerLocalX(event) - splitLocal.value) <= 10) {
      splitDrag = true;
      stage.setPointerCapture?.(event.pointerId);
      return;
    }
  }

  const panning = event.button === 1;
  if (panning) {
    panState = { x: event.clientX, y: event.clientY, ox: offset.value.x, oy: offset.value.y };
    dragging.value = true;
    stage.setPointerCapture?.(event.pointerId);
    return;
  }

  if (event.button !== 0 && event.button !== 2) return;
  const point = toImagePoint(event);
  if (!point?.inside || !hasMask.value) return;

  event.preventDefault();
  const erase = isEraseModifier(event);
  actions.beginStroke(item.value);
  stroke = { erase, last: point };
  actions.paintSegment(item.value, point, point, { erase });
  commitToLayer(point, point, erase);
  stage.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  const stage = stageEl.value;
  if (!stage) return;
  const point = toImagePoint(event);

  if (splitDrag) {
    const rect = imageRect();
    if (rect.w > 0) {
      const next = (pointerLocalX(event) - rect.x) / rect.w;
      actions.setView('split', Math.min(1, Math.max(0, next)));
    }
    return;
  }

  if (panState) {
    offset.value = {
      x: panState.ox + (event.clientX - panState.x),
      y: panState.oy + (event.clientY - panState.y),
    };
    cursor.value = null;
    return;
  }

  if (stroke && point?.inside) {
    actions.paintSegment(item.value, stroke.last, point, { erase: stroke.erase });
    commitToLayer(stroke.last, point, stroke.erase);
    stroke.last = point;
  }

  const rect = stage.getBoundingClientRect();
  cursor.value = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    inside: Boolean(point?.inside),
  };
  requestDraw();
}

/** 把这次涂抹同步到离屏掩膜层，然后只重绘受影响的显示区域。 */
function commitToLayer(from, to, erase) {
  const layer = maskLayer;
  const currentEntry = entry.value;
  if (!layer || !currentEntry?.maskState.mask) return;
  const radius = state.brush.radius;
  if (from.x === to.x && from.y === to.y) {
    layer.paintCircle(to.x + 0.5, to.y + 0.5, radius, erase);
  } else {
    layer.paintSegment(
      { x: from.x + 0.5, y: from.y + 0.5 },
      { x: to.x + 0.5, y: to.y + 0.5 },
      radius,
      erase,
    );
  }
  const box = boxOf(from, to, radius);
  layer.commitStroke(currentEntry.maskState.mask, box);
  // 立刻把版本号对齐 composable 侧，避免下一帧因版本不一致而整层重建
  layer.version = currentEntry.maskVersion;
  invalidateMaskRegion(box);
}

/** 一次涂抹波及的图片像素包围盒（画笔半径外扩，避免边界漏格）。 */
function boxOf(from, to, radius) {
  const { width, height } = entry.value.maskState;
  const x0 = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius));
  const y0 = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0 + 1), height: Math.max(0, y1 - y0 + 1) };
}

/**
 * 只重画显示缓存里对应的那一小块（图片像素域 → 显示域）。
 * 大图上“整层重贴”是每帧几十 MB 的纹理上传，这里把代价压到笔刷覆盖范围。
 */
function invalidateMaskRegion(box) {
  const layer = maskLayer;
  if (!layer || !maskCanvas || !box?.width || !box?.height) return;
  const sx = maskCanvas.width / layer.canvas.width;
  const sy = maskCanvas.height / layer.canvas.height;
  const dx = Math.floor(box.x * sx);
  const dy = Math.floor(box.y * sy);
  const dw = Math.max(1, Math.ceil(box.width * sx));
  const dh = Math.max(1, Math.ceil(box.height * sy));
  const ctx = maskCanvas.getContext('2d');
  ctx.save();
  // 先裁到脏区：否则整层重贴会让半透明色反复叠加，看上去越涂越深
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.clearRect(dx, dy, dw, dh);
  ctx.drawImage(layer.canvas, 0, 0, maskCanvas.width, maskCanvas.height);
  ctx.restore();
}

function onPointerUp(event) {
  if (stroke) stroke = null;
  splitDrag = false;
  panState = null;
  dragging.value = false;
  stageEl.value?.releasePointerCapture?.(event.pointerId);
}

function onPointerLeave() {
  cursor.value = null;
  requestDraw();
}

function onWheel(event) {
  if (!item.value) return;
  event.preventDefault();
  setZoom(zoom.value * Math.exp(-event.deltaY * 0.0015), { x: event.clientX, y: event.clientY });
}

function onDrop(event) {
  event.preventDefault();
  dropActive.value = false;
  if (event.dataTransfer?.files?.length) workspaceActions.addFiles(event.dataTransfer.files);
}

function onDragOver(event) {
  event.preventDefault();
  dropActive.value = true;
}

function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => workspaceActions.addFiles(input.files);
  input.click();
}

// ------------------------------------------------------------- 生命周期

let observer = null;

onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    stageSize.value = { w: box.width, h: box.height };
    if (isFit.value) offset.value = centeredOffset();
    requestDraw();
  });
  observer.observe(stageEl.value);
  stageSize.value = { w: stageEl.value.clientWidth, h: stageEl.value.clientHeight };
  fitToView();
  void actions.checkHealth();
  requestDraw();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

/** 掩膜或视图变化后作废显示缓存（掩膜视图与叠加视图用的是两种画法）。 */
function invalidateMaskCache() {
  overlayVersion = -1;
  lastCacheKey = '';
  requestDraw();
}

watch(
  () => [view.value.mode, hasMask.value, entry.value?.maskVersion],
  () => invalidateMaskCache(),
  { flush: 'post' },
);

// 换素材：重新适应窗口，掩膜缓存与结果图全部作废
watch(
  () => item.value?.id,
  () => {
    maskLayer = null;
    maskCanvas = null;
    maskScratch = null;
    overlayDims = { w: 0, h: 0 };
    cursor.value = null;
    resultCache.url = '';
    resultCache.image = null;
    fitToView();
    invalidateMaskCache();
  },
);

watch(resultUrl, () => {
  void ensureResultImage();
  requestDraw();
});

watch(
  () => [stageSize.value.w, stageSize.value.h, zoom.value, offset.value.x, offset.value.y, view.value.mode, isCompare.value, view.value.split, state.brush.showOverlay],
  () => requestDraw(),
  { flush: 'post' },
);

watch(
  () => workspaceState.theme,
  () => {
    // 主题换了要重新取 --accent / --checker-*，掩膜层颜色也得跟着重建
    if (maskLayer) maskLayer.setColor(cssVar('--accent', '#0d99ff'));
    invalidateMaskCache();
  },
  { flush: 'post' },
);
</script>

<template>
  <section
    ref="stageEl"
    class="stage"
    :class="{ 'is-dragging': dragging, 'is-drop': dropActive, 'is-brush': hasMask && view.mode !== 'result' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerLeave"
    @wheel="onWheel"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="dropActive = false"
    @contextmenu.prevent
  >
    <canvas ref="baseEl" class="stage-canvas" />
    <canvas ref="overlayEl" class="stage-canvas is-overlay" />

    <!-- 前后对比分隔条：拖动它就改 split，不触发涂抹 -->
    <div v-if="isCompare" class="split-line" :style="{ left: `${splitLocal}px` }">
      <span class="split-handle" title="拖动对比原图 / 结果">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M4 2L1.5 5 4 8M6 2l2.5 3L6 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="split-tag is-left">原图</span>
      <span class="split-tag is-right">结果</span>
    </div>

    <div class="stage-toolbar">
      <SegmentedControl :model-value="view.mode" :options="VIEWS" size="sm" @update:model-value="actions.setView('mode', $event)" />
      <button
        class="btn is-ghost"
        :class="{ 'is-on': state.brush.showOverlay }"
        type="button"
        :disabled="!hasMask"
        @click="actions.setBrush('showOverlay', !state.brush.showOverlay)"
      >
        <span class="dot" :class="{ 'is-on': state.brush.showOverlay }" />掩膜叠加
      </button>
      <button
        class="btn is-ghost"
        :class="{ 'is-on': isCompare }"
        type="button"
        :disabled="!result"
        @click="actions.setView('compare', !view.compare)"
      >
        前后对比
      </button>
      <span class="toolbar-sep" />
      <button class="btn is-ghost" type="button" :disabled="!hasMask" @click="actions.undoMask()">撤销涂抹</button>
      <button class="btn is-ghost" type="button" :disabled="!hasMask" @click="actions.clearMask()">清空掩膜</button>
    </div>

    <div v-if="item" class="stage-zoom">
      <button class="btn is-ghost is-icon" type="button" title="缩小" @click="setZoom(zoom / 1.25)">−</button>
      <button class="btn is-ghost zoom-value mono" type="button" title="点击适应窗口" @click="fitToView">
        {{ Math.round(zoom * 100) }}%
      </button>
      <button class="btn is-ghost is-icon" type="button" title="放大" @click="setZoom(zoom * 1.25)">＋</button>
      <span class="stage-zoom-sep" />
      <button class="btn is-ghost" type="button" @click="fitToView">适应</button>
      <button class="btn is-ghost" type="button" @click="setZoom(1)">1:1</button>
    </div>

    <!-- 画笔状态：左键涂抹 / Alt 或右键擦除，半径在右侧检查器里调 -->
    <div v-if="item && hasMask" class="stage-readout">
      <span class="readout-tool">{{ state.brush.tool === 'erase' ? '橡皮' : '画笔' }}</span>
      <span class="mono">Ø{{ state.brush.radius * 2 }}px</span>
      <span class="readout-sep" />
      <span>左键涂抹 · Alt/右键擦除 · 中键拖动平移 · 滚轮缩放</span>
      <span class="readout-sep" />
      <span v-if="boxCount" class="readout-boxes mono">检出 {{ boxCount }} 处</span>
      <span class="mono">覆盖 {{ (coverage * 100).toFixed(2) }}%</span>
      <span v-if="entry?.dirty" class="readout-dirty">掩膜已改动，需重新去除</span>
    </div>

    <!-- 后端不可用：明确告知，不静默失败 -->
    <div v-if="state.health.checked && !state.health.ok" class="stage-warning is-blocking">
      水印功能需要 Node 服务端（npm run dev:server）
      <button class="btn is-ghost" type="button" @click="actions.checkHealth()">重试</button>
    </div>

    <div v-if="!item" class="stage-empty">
      <div class="empty-card">
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
          <rect x="4.5" y="7.5" width="25" height="19" rx="2.5" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" />
          <path d="M9 19l5-5 4 4 3-3 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="24" cy="13" r="2" stroke="currentColor" stroke-width="1.3" />
        </svg>
        <p class="empty-title">先导入素材，再识别水印</p>
        <p class="empty-hint muted">支持 PNG / WebP / JPEG / AVIF · 也可以 Ctrl+V 粘贴</p>
        <div class="empty-actions">
          <button class="btn" type="button" @click="pickFiles">导入图片</button>
          <button class="btn is-primary" type="button" :disabled="workspaceState.busy" @click="workspaceActions.loadSamples()">
            载入示例
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="view.mode === 'result' && !result" class="stage-warning">
      还没有去除结果 —— 先在右侧执行「执行去除」，或切换到「原图 / 掩膜」视图检查掩膜。
    </div>

    <div v-else-if="!hasMask" class="stage-warning">
      尚未生成掩膜 —— 点击右侧「自动检测水印」，或执行一次检测后直接手动画笔修补。
    </div>
  </section>
</template>

<style scoped>
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-canvas);
  cursor: grab;
  touch-action: none;
}

.stage.is-dragging {
  cursor: grabbing;
}

.stage.is-brush {
  cursor: crosshair;
}

.stage.is-drop::after {
  content: '';
  position: absolute;
  inset: 8px;
  border: 1.5px dashed var(--accent);
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  pointer-events: none;
}

.stage-canvas {
  display: block;
  position: absolute;
  inset: 0;
}

.stage-canvas.is-overlay {
  pointer-events: none;
}

.split-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  transform: translateX(-0.5px);
  pointer-events: none;
}

.split-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  box-shadow: var(--shadow-panel);
}

.split-tag {
  position: absolute;
  bottom: 12px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.split-tag.is-left {
  right: 8px;
}

.split-tag.is-right {
  left: 8px;
}

.stage-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-panel);
  backdrop-filter: blur(6px);
}

.stage-toolbar .btn.is-on {
  color: var(--accent);
}

.toolbar-sep {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--border);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.dot.is-on {
  background: var(--accent);
}

.stage-zoom {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-panel);
  backdrop-filter: blur(6px);
}

.zoom-value {
  min-width: 46px;
  font-size: 11px;
}

.stage-zoom-sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}

.stage-readout {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 10px;
  box-shadow: var(--shadow-panel);
}

.readout-tool {
  color: var(--text-2);
}

.readout-boxes {
  color: var(--warn);
}

.readout-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
}

.readout-dirty {
  color: var(--warn);
}

.stage-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 30px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  color: var(--text-muted);
  text-align: center;
}

.empty-title {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 13px;
}

.empty-hint {
  margin: 0;
  font-size: 11px;
}

.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  pointer-events: auto;
}

.stage-warning {
  position: absolute;
  left: 50%;
  top: 64px;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(560px, calc(100% - 48px));
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 18%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  color: var(--text);
  font-size: 11px;
  text-align: center;
}

.stage-warning.is-blocking {
  background: color-mix(in srgb, var(--danger) 16%, var(--panel));
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  pointer-events: auto;
}
</style>
