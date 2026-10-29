/**
 * 图片橡皮擦状态（单例）
 * ----------------------
 * 设计要点：
 *  1. 每张素材维护一块**工作画布**（初始为原图副本），擦除只改这块画布，
 *     原素材与 bitmap 始终不变，随时可以对比或重新导出。
 *  2. 笔刷用 `destination-out` + 径向渐变实现「硬度」：中心完全透明、边缘渐隐，
 *     避免硬边锯齿；「还原」模式则把原图对应的圆形区域盖回去。
 *  3. 撤销采用**脏矩形快照**而不是整图快照：
 *     一笔画到哪里，就把哪片区域的像素缓存下来；大图也不会因为撤销栈把内存吃爆。
 *     笔迹扩张时只补录「新增的、尚未被修改的」条带像素，因此结果与整图快照一致。
 *  4. 画布与上下文都 markRaw，避免 Vue 对 DOM 对象做深度代理。
 */
import { computed, markRaw, reactive, readonly } from 'vue';

import { useWorkspace } from './useWorkspace.js';
import { saveBlobToLibrary } from './useLibrary.js';
import { canvasToBlob, createCanvas, stripExtension } from '../lib/imageops.js';
import { downloadBlob } from '../lib/imaging.js';

/** 撤销栈上限：一次涂抹算一步，20 步对图片修饰足够。 */
const HISTORY_LIMIT = 20;

const DEFAULT_BRUSH = {
  size: 48, // 直径（原图像素）
  hardness: 65, // 0=全羽化 100=硬边
  opacity: 100, // 单次笔刷强度（%）
  mode: 'erase', // erase | restore
  showOriginal: false, // 按住对比：显示原图而不是编辑结果
};

const workspace = useWorkspace();

const state = reactive({
  busy: false,
  status: '',
  error: '',
  brush: { ...DEFAULT_BRUSH },
});

/** 以素材 id 为键的编辑状态。 */
const entries = reactive({});

const activeItem = computed(() => workspace.selected.value ?? null);
const activeEntry = computed(() => {
  const item = activeItem.value;
  return item ? entries[item.id] ?? null : null;
});
const canUndo = computed(() => Boolean(activeEntry.value?.history.length));
const canRedo = computed(() => Boolean(activeEntry.value?.redo.length));
const hasEdits = computed(() => Boolean(activeEntry.value?.dirty));

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

// --------------------------------------------------------------- 脏矩形工具

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 两个矩形求并集（像素坐标，整数）。 */
function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** 把 src 的某个矩形拷贝进 dst 的 (dx,dy) 位置（均为像素坐标）。 */
function blit(src, srcX, srcY, width, height, dst, dstX, dstY) {
  const srcData = src.data;
  const dstData = dst.data;
  for (let row = 0; row < height; row += 1) {
    const from = ((srcY + row) * src.width + srcX) * 4;
    const to = ((dstY + row) * dst.width + dstX) * 4;
    dstData.set(srcData.subarray(from, from + width * 4), to);
  }
}

/**
 * 记录涂抹区域的“未修改像素”。
 *
 * 第一次调用直接截取整个笔刷矩形；之后再扩张时，只从画布补录新增条带——
 * 那些条带此前一定没被本笔画过，因此仍然是原始像素。
 */
function captureRegion(entry, rect) {
  const x = clampInt(rect.x, 0, entry.width);
  const y = clampInt(rect.y, 0, entry.height);
  const right = clampInt(rect.x + rect.width, 0, entry.width);
  const bottom = clampInt(rect.y + rect.height, 0, entry.height);
  const clipped = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  if (clipped.width < 1 || clipped.height < 1) return;

  if (!entry.pending) {
    entry.pending = {
      rect: clipped,
      image: entry.ctx.getImageData(clipped.x, clipped.y, clipped.width, clipped.height),
    };
    return;
  }

  const old = entry.pending;
  const union = unionRect(old.rect, clipped);
  if (union.x === old.rect.x && union.y === old.rect.y && union.width === old.rect.width && union.height === old.rect.height) {
    return; // 没有扩张，直接复用
  }

  const merged = entry.ctx.createImageData(union.width, union.height);
  blit(old.image, 0, 0, old.rect.width, old.rect.height, merged, old.rect.x - union.x, old.rect.y - union.y);

  const oldRight = old.rect.x + old.rect.width;
  const oldBottom = old.rect.y + old.rect.height;
  const unionRight = union.x + union.width;
  const unionBottom = union.y + union.height;
  const strips = [];
  // 上条带（整宽）
  if (union.y < old.rect.y) strips.push({ x: union.x, y: union.y, width: union.width, height: old.rect.y - union.y });
  // 下条带（整宽）
  if (unionBottom > oldBottom) strips.push({ x: union.x, y: oldBottom, width: union.width, height: unionBottom - oldBottom });
  // 左条带（只覆盖旧矩形的高度，避免和上下条带重叠）
  if (union.x < old.rect.x) strips.push({ x: union.x, y: old.rect.y, width: old.rect.x - union.x, height: old.rect.height });
  // 右条带
  if (unionRight > oldRight) {
    strips.push({ x: oldRight, y: old.rect.y, width: unionRight - oldRight, height: old.rect.height });
  }

  for (const strip of strips) {
    if (strip.width < 1 || strip.height < 1) continue;
    const piece = entry.ctx.getImageData(strip.x, strip.y, strip.width, strip.height);
    blit(piece, 0, 0, strip.width, strip.height, merged, strip.x - union.x, strip.y - union.y);
  }

  entry.pending = { rect: union, image: merged };
}

// --------------------------------------------------------------- 笔刷绘制

function brushRadius(entry) {
  // 直径至少 2px，半径按素材坐标计算
  return Math.max(1, state.brush.size / 2);
}

/** 还原模式用的临时印章画布（每个素材各一块，避免反复分配）。 */
function stampFor(entry) {
  const size = Math.ceil(brushRadius(entry) * 2) + 2;
  if (!entry.stamp || entry.stamp.width !== size) {
    entry.stamp = markRaw(createCanvas(size, size));
    entry.stampCtx = markRaw(entry.stamp.getContext('2d'));
  }
  return { canvas: entry.stamp, ctx: entry.stampCtx, size };
}

function fillRadial(ctx, x, y, radius, alpha) {
  const inner = radius * (Math.max(0, Math.min(100, state.brush.hardness)) / 100);
  const gradient = ctx.createRadialGradient(x, y, inner, x, y, radius);
  gradient.addColorStop(0, `rgba(0,0,0,${alpha})`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 在 (x,y) 画一个笔刷印章。 */
function drawDab(entry, x, y) {
  const radius = brushRadius(entry);
  const alpha = Math.max(0.02, Math.min(1, state.brush.opacity / 100));

  // 先记账再落笔：这笔区域此前的像素必须留住
  captureRegion(entry, { x: x - radius - 1, y: y - radius - 1, width: radius * 2 + 2, height: radius * 2 + 2 });

  const ctx = entry.ctx;
  if (state.brush.mode === 'restore') {
    const stamp = stampFor(entry);
    const sctx = stamp.ctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, stamp.size, stamp.size);
    // 把原图对应区域画到印章左上角
    sctx.drawImage(entry.source, -Math.round(x - radius), -Math.round(y - radius));
    // 用径向渐变做蒙版：只有圆内保留原图像素
    sctx.globalCompositeOperation = 'destination-in';
    fillRadial(sctx, radius, radius, radius, alpha);
    sctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(stamp.canvas, Math.round(x - radius), Math.round(y - radius));
    ctx.restore();
    return;
  }

  // 擦除：destination-out 直接把 alpha 乘掉，透明通道保留
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  fillRadial(ctx, x, y, radius, alpha);
  ctx.restore();
}

/** 两点之间按间距补点，保证快速拖动也是连续笔迹而不是一串点。 */
function strokeSegment(entry, from, to) {
  const radius = brushRadius(entry);
  const spacing = Math.max(1, radius * 0.22);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.floor(distance / spacing));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    drawDab(entry, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
}

// --------------------------------------------------------------- 素材工作区

function ensureEntry(item = activeItem.value) {
  if (!item) return null;
  if (entries[item.id]) return entries[item.id];

  const canvas = createCanvas(item.width, item.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(item.bitmap, 0, 0);

  // 原图副本：既用于「还原」笔刷，也用于「按住对比」
  const source = createCanvas(item.width, item.height);
  source.getContext('2d').drawImage(item.bitmap, 0, 0);

  const entry = reactive({
    id: item.id,
    name: item.name,
    width: item.width,
    height: item.height,
    canvas: markRaw(canvas),
    ctx: markRaw(ctx),
    source: markRaw(source),
    stamp: null,
    stampCtx: null,
    version: 0,
    history: [],
    redo: [],
    pending: null,
    drawing: false,
    lastPoint: null,
    dirty: false,
    error: '',
  });
  entries[item.id] = entry;
  return entry;
}

export function prepareSelected() {
  return ensureEntry(activeItem.value);
}

export function setBrush(key, value) {
  if (!(key in state.brush)) return;
  state.brush[key] = value;
}

/**
 * 开始一笔。
 * @param {{x:number,y:number}} point 原图像素坐标
 */
export function beginStroke(point) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !point) return false;
  entry.drawing = true;
  entry.pending = null;
  entry.lastPoint = { x: point.x, y: point.y };
  drawDab(entry, point.x, point.y);
  entry.version += 1;
  entry.dirty = true;
  return true;
}

export function extendStroke(point) {
  const entry = activeEntry.value;
  if (!entry?.drawing || !point) return;
  const from = entry.lastPoint ?? point;
  strokeSegment(entry, from, point);
  entry.lastPoint = { x: point.x, y: point.y };
  entry.version += 1;
}

export function endStroke() {
  const entry = activeEntry.value;
  if (!entry?.drawing) return;
  entry.drawing = false;
  entry.lastPoint = null;
  if (entry.pending) {
    entry.history.push(entry.pending);
    if (entry.history.length > HISTORY_LIMIT) entry.history.shift();
    entry.redo = [];
    entry.pending = null;
    entry.version += 1;
  }
}

/** 撤销一笔：把这一笔开始前的区域像素放回去。 */
export function undo() {
  const entry = activeEntry.value;
  if (!entry?.history.length) return;
  const step = entry.history.pop();
  const current = entry.ctx.getImageData(step.rect.x, step.rect.y, step.rect.width, step.rect.height);
  entry.redo.push({ rect: step.rect, image: current });
  entry.ctx.putImageData(step.image, step.rect.x, step.rect.y);
  entry.dirty = entry.history.length > 0 || entry.redo.length > 0;
  entry.version += 1;
  setStatus(`已撤销一步（剩余 ${entry.history.length} 步可撤销）`);
}

export function redo() {
  const entry = activeEntry.value;
  if (!entry?.redo.length) return;
  const step = entry.redo.pop();
  const current = entry.ctx.getImageData(step.rect.x, step.rect.y, step.rect.width, step.rect.height);
  entry.history.push({ rect: step.rect, image: current });
  entry.ctx.putImageData(step.image, step.rect.x, step.rect.y);
  entry.dirty = true;
  entry.version += 1;
  setStatus('已重做一步');
}

/** 恢复原图（会清空撤销栈，属于“重新开始”操作）。 */
export function resetCanvas() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  entry.ctx.clearRect(0, 0, entry.width, entry.height);
  entry.ctx.drawImage(entry.source, 0, 0);
  entry.history = [];
  entry.redo = [];
  entry.pending = null;
  entry.dirty = false;
  entry.version += 1;
  setStatus('已恢复原图');
}

/** 撤销 / 重做状态由界面读取，这里集中做一次浅判断。 */
export function historyState() {
  const entry = activeEntry.value;
  return { undo: entry?.history.length ?? 0, redo: entry?.redo.length ?? 0 };
}

// --------------------------------------------------------------- 导出

/**
 * 把擦除结果生成为新素材。
 * @param {{addToWorkspace?:boolean,saveToLibrary?:boolean,download?:boolean}} [options]
 */
export async function applyEraser(options = {}) {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!item || !entry) {
    setError('请先选择一张素材');
    return null;
  }
  if (state.busy) return null;

  const { addToWorkspace = true, saveToLibrary = false, download = false } = options;
  state.busy = true;
  try {
    const blob = await canvasToBlob(entry.canvas, 'image/png');
    const filename = `${stripExtension(item.name)}-擦除.png`;
    let newItem = null;
    if (addToWorkspace) newItem = await workspace.actions.addImageBlob(blob, filename);
    if (saveToLibrary) await saveBlobToLibrary(blob, filename, '擦除结果');
    if (download) downloadBlob(blob, filename);
    setStatus(
      `已生成擦除结果 ${filename}（${Math.round(blob.size / 1024)} KB）` +
        `${saveToLibrary ? ' · 已保存到资源库/擦除结果' : ''}`,
    );
    return { blob, newItem };
  } catch (err) {
    setError(`导出擦除结果失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export function useEraser() {
  return {
    state: readonly(state),
    activeItem,
    activeEntry,
    canUndo,
    canRedo,
    hasEdits,
    actions: {
      prepareSelected,
      setBrush,
      beginStroke,
      extendStroke,
      endStroke,
      undo,
      redo,
      resetCanvas,
      applyEraser,
      historyState,
    },
  };
}
