/**
 * 像素笔绘状态（单例）
 * --------------------
 * 设计要点：
 *  1. 每张素材维护一块**工作画布**（原图副本），笔绘只改这块画布；
 *     原素材 bitmap 不变，随时「恢复原图」或重新导出。
 *  2. 笔迹是真正的像素级绘制：坐标取整、方形笔刷、关闭抗锯齿，
 *     1px 笔刷就是 1 个像素，放大后能看到清晰的像素格。
 *  3. 撤销沿用橡皮擦的**脏矩形快照**：每笔只缓存受影响的矩形，
 *     4000×3000 的大图也不会因为撤销栈把内存吃爆。
 *  4. 画布 / 上下文都 markRaw，避免 Vue 对 DOM 对象做深度代理。
 */
import { computed, markRaw, reactive, readonly } from 'vue';

import { useWorkspace } from './useWorkspace.js';
import { saveBlobToLibrary } from './useLibrary.js';
import { canvasToBlob, createCanvas, stripExtension } from '../lib/imageops.js';
import { decodeBitmap, downloadBlob } from '../lib/imaging.js';
import { markSessionDirty } from '../lib/sessionSignals.js';

/** 撤销栈上限：像素画通常是很多笔细修，24 步比橡皮擦的 20 步更宽松。 */
const HISTORY_LIMIT = 24;

/** 常用色板：主色 + 黑白 + 高对比像素画常用色。 */
export const PALETTE = [
  '#0d99ff',
  '#ffffff',
  '#111111',
  '#f24822',
  '#14ae5c',
  '#ffcd29',
  '#c58bff',
  '#ff8a00',
  '#00c2a8',
  '#ff5c8a',
  '#8b5cf6',
  '#8d6e63',
];

const DEFAULT_BRUSH = {
  tool: 'brush', // brush | eraser | pick | pan
  color: '#0d99ff',
  size: 8, // 直径（图像像素），1 就是单像素
  opacity: 100, // 单次落笔强度（%）
  grid: true, // 放大到一定程度显示像素网格
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

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** 把 #rgb / #rrggbb / 不带 # 的写法统一成小写 #rrggbb；非法值返回 null。 */
export function normalizeColor(value) {
  let hex = String(value ?? '').trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = `#${hex
      .slice(1)
      .split('')
      .map((char) => char + char)
      .join('')}`;
  }
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
}

// --------------------------------------------------------------- 脏矩形工具

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

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
 * 记录落笔区域的“未修改像素”。
 * 第一笔直接截取整个笔刷矩形；笔迹扩张时只补录新增条带。
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
    return;
  }

  const merged = entry.ctx.createImageData(union.width, union.height);
  blit(old.image, 0, 0, old.rect.width, old.rect.height, merged, old.rect.x - union.x, old.rect.y - union.y);

  const oldRight = old.rect.x + old.rect.width;
  const oldBottom = old.rect.y + old.rect.height;
  const unionRight = union.x + union.width;
  const unionBottom = union.y + union.height;
  const strips = [];
  if (union.y < old.rect.y) strips.push({ x: union.x, y: union.y, width: union.width, height: old.rect.y - union.y });
  if (unionBottom > oldBottom) strips.push({ x: union.x, y: oldBottom, width: union.width, height: unionBottom - oldBottom });
  if (union.x < old.rect.x) strips.push({ x: union.x, y: old.rect.y, width: old.rect.x - union.x, height: old.rect.height });
  if (unionRight > oldRight) strips.push({ x: oldRight, y: old.rect.y, width: unionRight - oldRight, height: old.rect.height });

  for (const strip of strips) {
    if (strip.width < 1 || strip.height < 1) continue;
    const piece = entry.ctx.getImageData(strip.x, strip.y, strip.width, strip.height);
    blit(piece, 0, 0, strip.width, strip.height, merged, strip.x - union.x, strip.y - union.y);
  }

  entry.pending = { rect: union, image: merged };
}

// --------------------------------------------------------------- 像素笔刷

/**
 * 在 (px,py) 落一个方形像素笔刷。
 * 不做任何抗锯齿：fillRect 的边界始终落在整数像素上，放大后是干净的方块。
 */
function drawDab(entry, px, py) {
  const size = clampInt(state.brush.size, 1, 64);
  const left = Math.round(px - size / 2);
  const top = Math.round(py - size / 2);
  captureRegion(entry, { x: left, y: top, width: size, height: size });

  const ctx = entry.ctx;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = Math.max(0.02, Math.min(1, state.brush.opacity / 100));
  ctx.globalCompositeOperation = state.brush.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.fillStyle = state.brush.color;
  ctx.fillRect(left, top, size, size);
  ctx.restore();
}

/**
 * Bresenham 连线：把两个像素点之间的像素全部补齐。
 * 比“按间距补点”更适合像素画 —— 无论拖动多快，1px 笔刷都不会断线。
 */
function strokeSegment(entry, point) {
  const toX = clampInt(point.x, 0, entry.width - 1);
  const toY = clampInt(point.y, 0, entry.height - 1);
  const from = entry.lastPixel ?? { x: toX, y: toY };
  let x0 = from.x;
  let y0 = from.y;
  const dx = Math.abs(toX - x0);
  const sx = x0 < toX ? 1 : -1;
  const dy = -Math.abs(toY - y0);
  const sy = y0 < toY ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    // 起点已经落过笔，避免同一像素在低不透明度下被叠加两次
    if (!entry.lastPixel || x0 !== entry.lastPixel.x || y0 !== entry.lastPixel.y) {
      drawDab(entry, x0, y0);
      entry.lastPixel = { x: x0, y: y0 };
    }
    if (x0 === toX && y0 === toY) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// --------------------------------------------------------------- 素材工作区

function ensureEntry(item = activeItem.value) {
  if (!item) return null;
  const existing = entries[item.id];
  // 素材被「就地保存」过（像素对象换了）→ 旧画布与撤销栈都已失效，按新像素重建
  if (existing && existing.sourceBitmap === item.bitmap) return existing;

  const canvas = createCanvas(item.width, item.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(item.bitmap, 0, 0);

  const source = createCanvas(item.width, item.height);
  source.getContext('2d').drawImage(item.bitmap, 0, 0);

  const entry = reactive({
    id: item.id,
    name: item.name,
    width: item.width,
    height: item.height,
    /** 这份编辑层是基于哪个像素对象建立的；就地保存后 item.bitmap 会换新 */
    sourceBitmap: markRaw(item.bitmap),
    canvas: markRaw(canvas),
    ctx: markRaw(ctx),
    source: markRaw(source),
    version: 0,
    history: [],
    redo: [],
    pending: null,
    drawing: false,
    lastPixel: null,
    dirty: false,
  });
  entries[item.id] = entry;
  return entry;
}

export function prepareSelected() {
  return ensureEntry(activeItem.value);
}

export function setTool(tool) {
  if (!['brush', 'eraser', 'pick', 'pan'].includes(tool)) return;
  state.brush.tool = tool;
  markSessionDirty('pixel');
}

/** 面板里的颜色 / 大小 / 透明度 / 网格都走这里，值统一做一次校验或钳制。 */
export function setBrush(key, value) {
  markSessionDirty('pixel');
  if (key === 'color') {
    const hex = normalizeColor(value);
    if (!hex) return false;
    state.brush.color = hex;
    return true;
  }
  if (key === 'size') {
    state.brush.size = clampInt(Number(value) || 1, 1, 64);
    return true;
  }
  if (key === 'opacity') {
    state.brush.opacity = clampInt(Number(value) || 100, 5, 100);
    return true;
  }
  if (key === 'grid') {
    state.brush.grid = Boolean(value);
    return true;
  }
  if (key === 'tool') {
    setTool(value);
    return true;
  }
  return false;
}

/**
 * 开始一笔。
 * @param {{x:number,y:number}} point 图像像素坐标
 */
export function beginStroke(point) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !point) return false;
  if (state.brush.tool !== 'brush' && state.brush.tool !== 'eraser') return false;

  const x = clampInt(point.x, 0, entry.width - 1);
  const y = clampInt(point.y, 0, entry.height - 1);
  entry.drawing = true;
  entry.pending = null;
  entry.lastPixel = { x, y };
  drawDab(entry, x, y);
  entry.version += 1;
  entry.dirty = true;
  markSessionDirty('pixel');
  return true;
}

export function extendStroke(point) {
  const entry = activeEntry.value;
  if (!entry?.drawing || !point) return;
  strokeSegment(entry, point);
  entry.version += 1;
}

export function endStroke() {
  const entry = activeEntry.value;
  if (!entry?.drawing) return;
  entry.drawing = false;
  entry.lastPixel = null;
  if (entry.pending) {
    entry.history.push(entry.pending);
    if (entry.history.length > HISTORY_LIMIT) entry.history.shift();
    entry.redo = [];
    entry.pending = null;
    entry.version += 1;
  }
  markSessionDirty('pixel');
}

/** 吸管：读取工作画布上的真实像素（透明像素提示不可取色）。 */
export function pickColorAt(point) {
  const entry = ensureEntry(activeItem.value);
  if (!entry || !point) return null;
  const x = clampInt(point.x, 0, entry.width - 1);
  const y = clampInt(point.y, 0, entry.height - 1);
  const [r, g, b, a] = entry.ctx.getImageData(x, y, 1, 1).data;
  if (a === 0) {
    setStatus(`像素 (${x}, ${y}) 为透明，未改变颜色`);
    return null;
  }
  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  state.brush.color = hex;
  markSessionDirty('pixel');
  setStatus(`已从 (${x}, ${y}) 取色 ${hex.toUpperCase()}`);
  return hex;
}

export function undo() {
  const entry = activeEntry.value;
  if (!entry?.history.length) return;
  const step = entry.history.pop();
  const current = entry.ctx.getImageData(step.rect.x, step.rect.y, step.rect.width, step.rect.height);
  entry.redo.push({ rect: step.rect, image: current });
  entry.ctx.putImageData(step.image, step.rect.x, step.rect.y);
  entry.dirty = entry.history.length > 0 || entry.redo.length > 0;
  entry.version += 1;
  markSessionDirty('pixel');
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
  markSessionDirty('pixel');
  setStatus('已重做一步');
}

/** 恢复原图：清空所有笔迹与历史。 */
export function resetCanvas() {
  const entry = ensureEntry(activeItem.value);
  if (!entry) return;
  entry.ctx.clearRect(0, 0, entry.width, entry.height);
  entry.ctx.drawImage(entry.source, 0, 0);
  entry.history = [];
  entry.redo = [];
  entry.pending = null;
  entry.lastPixel = null;
  entry.dirty = false;
  entry.version += 1;
  markSessionDirty('pixel');
  setStatus('已恢复原图');
}

// --------------------------------------------------------------- 导出

/**
 * 就地保存之后：把「原图副本」换成刚保存的像素，并清空撤销栈
 * （旧历史步骤指向保存前的像素，继续撤销会和磁盘上的文件对不上）。
 */
function rebaseEntry(entry, item) {
  if (!entry) return;
  const ctx = entry.source.getContext('2d');
  ctx.clearRect(0, 0, entry.width, entry.height);
  ctx.drawImage(entry.canvas, 0, 0);
  entry.sourceBitmap = markRaw(item.bitmap);
  entry.history = [];
  entry.redo = [];
  entry.pending = null;
  entry.dirty = false;
  entry.version += 1;
  markSessionDirty('pixel');
}

/**
 * 把笔绘结果生成为新素材，或就地写回当前素材。
 * @param {{addToWorkspace?:boolean,saveToLibrary?:boolean,download?:boolean,inPlace?:boolean}} [options]
 *   inPlace=true 时覆盖当前素材（不新增素材条目）。
 */
export async function applyPaint(options = {}) {
  const item = activeItem.value;
  const entry = ensureEntry(item);
  if (!item || !entry) {
    setError('请先选择一张素材');
    return null;
  }
  if (state.busy) return null;

  const { addToWorkspace = true, saveToLibrary: save = false, download = false, inPlace = false } = options;
  state.busy = true;
  try {
    const blob = await canvasToBlob(entry.canvas, 'image/png');
    const filename = `${stripExtension(item.name)}-笔绘.png`;
    if (inPlace) {
      const saved = await workspace.actions.saveEditedItem(item, blob);
      if (!saved) return null;
      rebaseEntry(entry, item);
      setStatus(`已保存到当前素材：${saved.path}（${Math.round(blob.size / 1024)} KB）`);
      return { blob, item: saved.item };
    }
    let newItem = null;
    if (addToWorkspace) newItem = await workspace.actions.addImageBlob(blob, filename);
    if (save) await saveBlobToLibrary(blob, filename, '笔绘结果');
    if (download) downloadBlob(blob, filename);
    setStatus(
      `已生成笔绘结果 ${filename}（${Math.round(blob.size / 1024)} KB）` +
        `${save ? ' · 已保存到资源库/笔绘结果' : ''}`,
    );
    return { blob, newItem };
  } catch (err) {
    setError(`导出笔绘结果失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

// --------------------------------------------------------------- 临时会话

/** 与橡皮擦一致：只存改过的画布，撤销/重做栈不持久化。 */
export async function exportSession() {
  const items = {};
  const blobs = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry.dirty && !entry.history.length && !entry.redo.length) continue;
    items[id] = { dirty: entry.dirty, version: entry.version };
    try {
      blobs.set(`pixel:${id}`, await canvasToBlob(entry.canvas, 'image/png'));
    } catch (err) {
      console.warn('[session] 像素画布导出失败:', id, err.message);
    }
  }
  return { doc: { brush: { ...state.brush }, items }, blobs };
}

export async function importSession(doc, blobs = {}) {
  for (const id of Object.keys(entries)) delete entries[id];
  if (!doc || typeof doc !== 'object') return;
  Object.assign(state.brush, DEFAULT_BRUSH, doc.brush ?? {});

  for (const [id, meta] of Object.entries(doc.items ?? {})) {
    const item = workspace.state.items.find((entry) => entry.id === id);
    if (!item) continue;
    const entry = ensureEntry(item);
    const blob = blobs[`pixel:${id}`];
    if (blob) {
      try {
        const bitmap = await decodeBitmap(blob);
        entry.ctx.clearRect(0, 0, entry.width, entry.height);
        entry.ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
      } catch (err) {
        console.warn('[session] 像素画布恢复失败:', id, err.message);
      }
    }
    entry.dirty = Boolean(meta?.dirty);
    entry.version = Number(meta?.version) || 0;
  }
}

export function clearSession() {
  for (const id of Object.keys(entries)) delete entries[id];
  Object.assign(state.brush, DEFAULT_BRUSH);
}

export function usePixelPaint() {
  return {
    state: readonly(state),
    activeItem,
    activeEntry,
    canUndo,
    canRedo,
    hasEdits,
    palette: PALETTE,
    actions: {
      prepareSelected,
      setTool,
      setBrush,
      beginStroke,
      extendStroke,
      endStroke,
      pickColorAt,
      undo,
      redo,
      resetCanvas,
      applyPaint,
      exportSession,
      importSession,
      clearSession,
    },
  };
}
