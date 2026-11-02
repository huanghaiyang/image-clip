/**
 * 全局撤销 / 重做分发
 * --------------------
 * 每个工作区各自维护自己的历史栈（工具落笔、掩膜涂抹、裁剪框、素材增删…），
 * 这里只做“按当前工作区选栈”的薄分发，不复制任何状态：
 *
 *  - 图片处理优先撤销**当前工具内**的编辑，工具栈空了再回退到素材列表；
 *  - 视频工作区撤销标记点，其余模式撤销素材操作；
 *  - 重做优先回到上一次撤销所用的那条栈，避免两条栈交叉时顺序错乱。
 *
 * 历史栈都不持久化（临时会话恢复后从干净状态开始）。
 */
import { computed } from 'vue';

import { useAppMode } from './useAppMode.js';
import { useWorkspace } from './useWorkspace.js';
import { useCropTool } from './useCropTool.js';
import { useBgRemoval } from './useBgRemoval.js';
import { useEraser } from './useEraser.js';
import { usePixelPaint } from './usePixelPaint.js';
import { useWatermark } from './useWatermark.js';
import { useVideo } from './useVideo.js';

const { state: appMode } = useAppMode();
const workspace = useWorkspace();
const crop = useCropTool();
const bg = useBgRemoval();
const eraser = useEraser();
const pixel = usePixelPaint();
const watermark = useWatermark();
const video = useVideo();

const workspaceStack = {
  key: 'workspace',
  canUndo: workspace.canUndoAssets,
  canRedo: workspace.canRedoAssets,
  undo: () => workspace.actions.undoWorkspace(),
  redo: () => workspace.actions.redoWorkspace(),
};

const cropStack = {
  key: 'crop',
  canUndo: crop.canUndoCrop,
  canRedo: crop.canRedoCrop,
  undo: () => crop.actions.undoCrop(),
  redo: () => crop.actions.redoCrop(),
};

const bgStack = {
  key: 'bg',
  canUndo: bg.canUndoBg,
  canRedo: bg.canRedoBg,
  undo: () => bg.actions.undoBg(),
  redo: () => bg.actions.redoBg(),
};

const eraserStack = {
  key: 'eraser',
  canUndo: eraser.canUndo,
  canRedo: eraser.canRedo,
  undo: () => eraser.actions.undo(),
  redo: () => eraser.actions.redo(),
};

const pixelStack = {
  key: 'pixel',
  canUndo: pixel.canUndo,
  canRedo: pixel.canRedo,
  undo: () => pixel.actions.undo(),
  redo: () => pixel.actions.redo(),
};

const watermarkStack = {
  key: 'watermark',
  canUndo: watermark.canUndoMask,
  canRedo: watermark.canRedoMask,
  undo: () => watermark.actions.undoMask(),
  redo: () => watermark.actions.redoMask(),
};

const videoStack = {
  key: 'video',
  canUndo: video.canUndoMarks,
  canRedo: video.canRedoMarks,
  undo: () => video.actions.undoMarks(),
  redo: () => video.actions.redoMarks(),
};

/** 图片处理工作区：按右侧当前工具选栈。 */
const STACKS_BY_TOOL = {
  crop: [workspaceStack],
  cropimage: [cropStack, workspaceStack],
  bgremove: [bgStack, workspaceStack],
  eraser: [eraserStack, workspaceStack],
  pixel: [pixelStack, workspaceStack],
  watermark: [watermarkStack, workspaceStack],
};

/** 其他工作区的撤销优先级：越靠前越贴近当前操作。 */
const STACKS_BY_MODE = {
  video: [videoStack, workspaceStack],
  library: [workspaceStack],
  audio: [workspaceStack],
};

/** 上一次撤销用的栈：重做时优先回到这条栈上。 */
let lastUndoStack = null;

function currentStacks() {
  if (appMode.mode === 'image') return STACKS_BY_TOOL[appMode.imageTool] ?? [workspaceStack];
  return STACKS_BY_MODE[appMode.mode] ?? [workspaceStack];
}

export function undo() {
  for (const stack of currentStacks()) {
    if (!stack.canUndo.value) continue;
    stack.undo();
    lastUndoStack = stack;
    return true;
  }
  return false;
}

export function redo() {
  const stacks = currentStacks();
  const ordered = lastUndoStack && stacks.includes(lastUndoStack)
    ? [lastUndoStack, ...stacks.filter((stack) => stack !== lastUndoStack)]
    : stacks;
  for (const stack of ordered) {
    if (!stack.canRedo.value) continue;
    stack.redo();
    lastUndoStack = stack;
    return true;
  }
  return false;
}

const canUndo = computed(() => currentStacks().some((stack) => stack.canUndo.value));
const canRedo = computed(() => currentStacks().some((stack) => stack.canRedo.value));

export function useUndo() {
  return {
    canUndo,
    canRedo,
    actions: { undo, redo },
  };
}
