/**
 * 图片处理 · 编辑历史时间轴 + 前后对比
 * ------------------------------------
 * 各工具（裁剪/去背景/橡皮擦/像素画/水印/素材列表）本来就有各自的撤销栈，
 * 但用户看不到「改了几步、每一步长什么样」。这里做一层统一的可视化：
 *
 *  - 每 600ms 检查各工具的历史深度 + 当前工具，一旦变化就抓一张「当前结果」缩略图
 *    放进时间轴（垂直列表，带步骤缩略图）；
 *  - 点击某一步 → 把各工具栈 undo / redo 到那一步的深度（跨工具也能回退）；
 *  - 「前后对比」= 选中的那一步 vs 最新一步，左右并排 + 拖动分界线。
 *
 * 缩略图直接来自各工具已经渲染好的 canvas（橡皮擦/像素画/去背景/灰度），
 * 裁剪类则按裁剪框从原图画出来，所以不需要额外的离屏渲染或大内存快照。
 */
import { computed, reactive } from 'vue';

import { useAppMode } from './useAppMode.js';
import { useWorkspace, historyInfo as workspaceHistoryInfo } from './useWorkspace.js';
import { useCropTool, historyInfo as cropHistoryInfo } from './useCropTool.js';
import { useBgRemoval, historyInfo as bgHistoryInfo } from './useBgRemoval.js';
import { useEraser, historyState as eraserHistoryState } from './useEraser.js';
import { usePixelPaint, historyState as pixelHistoryState } from './usePixelPaint.js';
import { useWatermark, maskHistoryInfo } from './useWatermark.js';
import { useGrayscale } from './useGrayscale.js';

const { state: appMode } = useAppMode();
const workspace = useWorkspace();
const crop = useCropTool();
const bgRemoval = useBgRemoval();
const eraser = useEraser();
const pixel = usePixelPaint();
const watermark = useWatermark();
const grayscale = useGrayscale();

const TOOL_LABELS = {
  crop: '透明裁剪',
  cropimage: '图片裁剪',
  bgremove: '背景去除',
  eraser: '橡皮擦',
  watermark: '水印去除',
  pixel: '像素笔绘',
  sprite: '精灵图',
  tint: '灰度着色',
};

const MAX_STEPS = 40;
const THUMB_SIDE = 220;

const state = reactive({
  open: false,
  entries: [],
  selectedId: null,
  compare: false,
});

let seq = 0;
let timer = 0;
let lastSignature = '';
let restoring = false;

/** 各工具历史深度的读取 + 回退函数（顺序：先工具，最后素材列表）。 */
const sources = [
  { key: 'crop', info: cropHistoryInfo, undo: () => crop.actions.undoCrop(), redo: () => crop.actions.redoCrop() },
  { key: 'bg', info: bgHistoryInfo, undo: () => bgRemoval.actions.undoBg(), redo: () => bgRemoval.actions.redoBg() },
  { key: 'eraser', info: eraserHistoryState, undo: () => eraser.actions.undo(), redo: () => eraser.actions.redo() },
  { key: 'pixel', info: pixelHistoryState, undo: () => pixel.actions.undo(), redo: () => pixel.actions.redo() },
  { key: 'watermark', info: maskHistoryInfo, undo: () => watermark.actions.undoMask(), redo: () => watermark.actions.redoMask() },
  { key: 'workspace', info: workspaceHistoryInfo, undo: () => workspace.actions.undoWorkspace(), redo: () => workspace.actions.redoWorkspace() },
];

function readDepths() {
  const depths = {};
  for (const source of sources) {
    try {
      depths[source.key] = source.info();
    } catch {
      depths[source.key] = { undo: 0, redo: 0 };
    }
  }
  return depths;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** 从已有 canvas 抓缩略图（各工具已经渲染好的结果画布）。 */
function thumbFromCanvas(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const scale = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const out = makeCanvas(canvas.width * scale, canvas.height * scale);
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** 从素材原图按矩形裁一块做缩略图（裁剪类工具）。 */
function thumbFromItemRect(item, rect) {
  if (!item?.bitmap) return null;
  const x = Math.max(0, Math.min(item.width - 1, Math.round(rect?.x ?? 0)));
  const y = Math.max(0, Math.min(item.height - 1, Math.round(rect?.y ?? 0)));
  const width = Math.max(1, Math.min(item.width - x, Math.round(rect?.width ?? item.width)));
  const height = Math.max(1, Math.min(item.height - y, Math.round(rect?.height ?? item.height)));
  const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
  const out = makeCanvas(width * scale, height * scale);
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(item.bitmap, x, y, width, height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function thumbForTool(tool) {
  const item = workspace.selected.value;
  if (!item) return null;
  try {
    if (tool === 'eraser') return thumbFromCanvas(eraser.activeEntry.value?.canvas) ?? thumbFromItemRect(item);
    if (tool === 'pixel') return thumbFromCanvas(pixel.activeEntry.value?.canvas) ?? thumbFromItemRect(item);
    if (tool === 'bgremove') return thumbFromCanvas(bgRemoval.activeEntry.value?.previewCanvas) ?? thumbFromItemRect(item);
    if (tool === 'tint') return thumbFromCanvas(grayscale.preview.value?.canvas) ?? thumbFromItemRect(item);
    if (tool === 'cropimage') return thumbFromItemRect(item, crop.state.rect);
    if (tool === 'crop') {
      const bounds = item.bounds && !item.resultEmpty ? item.bounds : null;
      return thumbFromItemRect(item, bounds);
    }
    return thumbFromItemRect(item);
  } catch {
    return null;
  }
}

function snapshot(force = false) {
  if (appMode.mode !== 'image') return null;
  const tool = appMode.imageTool;
  const depths = readDepths();
  const signature = `${tool}|${JSON.stringify(depths)}`;
  if (!force && signature === lastSignature) return null;
  lastSignature = signature;
  const entry = {
    id: `step-${++seq}`,
    at: Date.now(),
    tool,
    label: TOOL_LABELS[tool] ?? tool,
    thumb: thumbForTool(tool),
    depths,
  };
  state.entries.push(entry);
  if (state.entries.length > MAX_STEPS) state.entries.shift();
  state.selectedId = entry.id;
  return entry;
}

function tick() {
  if (restoring) return;
  snapshot();
}

/** 回退到某一步：把每个工具栈 undo/redo 到当时的深度。 */
export function restoreStep(stepId) {
  const step = state.entries.find((item) => item.id === stepId);
  if (!step) return false;
  restoring = true;
  try {
    for (const source of sources) {
      const target = step.depths?.[source.key] ?? { undo: 0, redo: 0 };
      const current = source.info();
      const delta = (Number(target.undo) || 0) - (Number(current.undo) || 0);
      let guard = 0;
      if (delta > 0) {
        while (guard < MAX_STEPS) {
          if (!source.undo()) break;
          guard += 1;
        }
      } else if (delta < 0) {
        while (guard < MAX_STEPS) {
          if (!source.redo()) break;
          guard += 1;
        }
      }
    }
    state.selectedId = step.id;
    // 回退后不新增一步：只把签名同步到当前真实深度，下一步操作才会记录新步骤
    lastSignature = `${appMode.imageTool}|${JSON.stringify(readDepths())}`;
    return true;
  } finally {
    restoring = false;
  }
}

export function selectStep(stepId) {
  state.selectedId = stepId;
}

export function toggleCompare() {
  state.compare = !state.compare;
}

export function toggleTimeline() {
  state.open = !state.open;
}

export function clearTimeline() {
  state.entries.splice(0, state.entries.length);
  state.selectedId = null;
  lastSignature = '';
}

export function startTimeline() {
  if (timer) return;
  snapshot(true);
  timer = window.setInterval(tick, 600);
}

export function stopTimeline() {
  if (timer) clearInterval(timer);
  timer = 0;
}

const selectedStep = computed(() => state.entries.find((item) => item.id === state.selectedId) ?? null);
const latestStep = computed(() => state.entries[state.entries.length - 1] ?? null);
const selectedIndex = computed(() => state.entries.findIndex((item) => item.id === state.selectedId));
const comparePair = computed(() => {
  const index = selectedIndex.value;
  const before = index > 0 ? state.entries[index - 1] : state.entries[0] ?? null;
  const after = state.entries[state.entries.length - 1] ?? null;
  return { before, after };
});

export function useEditTimeline() {
  return {
    state,
    selectedStep,
    latestStep,
    selectedIndex,
    comparePair,
    actions: {
      start: startTimeline,
      stop: stopTimeline,
      snapshot,
      restore: restoreStep,
      select: selectStep,
      toggleCompare,
      toggle: toggleTimeline,
      clear: clearTimeline,
    },
  };
}
