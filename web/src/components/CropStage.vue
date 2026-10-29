<script setup>
/**
 * 图片裁剪舞台
 * ------------
 * 交互层画在一张铺满容器的透明 canvas 上（屏幕坐标），图片本体用另一张
 * 按自然分辨率绘制的 canvas（CSS 缩放显示），因此：
 *  - 放大后裁剪手柄、边框线宽保持不变，不会变成“柱子”；
 *  - 导出时直接用原图 bitmap 按裁剪框裁切，不受显示缩放影响。
 *
 * 操作：
 *  · 拖动框内 = 移动；拖动边/角 = 缩放（锁定比例时保持比例）；
 *  · 在框外拖动 = 重新拉框；
 *  · 滚轮缩放，缩放后可用「平移」模式或中键拖动（这里用空格键切换手型）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useCropTool } from '../composables/useCropTool.js';
import { useStageViewport } from '../composables/useStageViewport.js';
import { clampRect } from '@shared/selection.js';

const { selected } = useWorkspace();
const { state, actions } = useCropTool();
const { container, baseEl, view, frameStyle, displayWidth, displayHeight, zoomPercent, setImage, zoomIn, zoomOut, resetView, toImage, frameOrigin } = useStageViewport();

const overlayEl = ref(null);
const item = computed(() => selected.value ?? null);

/** 指针拖动状态：null 表示没在拖。 */
let drag = null;
let overlayFrame = 0;
const hoverHandle = ref('');

const HANDLE_CURSORS = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  move: 'move',
  create: 'crosshair',
};

function pixelsPerImage() {
  const origin = frameOrigin();
  if (!origin || !item.value) return 1;
  return origin.width / item.value.width;
}

/** 边/角命中检测（tolerance 用屏幕像素换算成图片像素）。 */
function handleAt(point) {
  const rect = state.rect;
  const tol = 10 / Math.max(0.0001, pixelsPerImage());
  const nearLeft = Math.abs(point.x - rect.x) <= tol;
  const nearRight = Math.abs(point.x - (rect.x + rect.width)) <= tol;
  const nearTop = Math.abs(point.y - rect.y) <= tol;
  const nearBottom = Math.abs(point.y - (rect.y + rect.height)) <= tol;

  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';
  if (nearLeft) return 'w';
  if (nearRight) return 'e';
  if (nearTop) return 'n';
  if (nearBottom) return 's';

  const inside = point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  return inside ? 'move' : null;
}

/**
 * 按手柄缩放矩形。
 * @param {object} start 起始矩形（图片像素）
 * @param {string} handle 手柄名
 * @param {number} dx 图片像素位移
 * @param {number} dy
 * @param {number} aspect 0 = 自由
 */
function resizeRect(start, handle, dx, dy, aspect) {
  let { x, y, width, height } = start;
  if (handle.includes('w')) {
    x += dx;
    width -= dx;
  }
  if (handle.includes('e')) width += dx;
  if (handle.includes('n')) {
    y += dy;
    height -= dy;
  }
  if (handle.includes('s')) height += dy;

  const minSize = 8;
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);

  if (aspect > 0) {
    if (handle === 'n' || handle === 's') {
      // 上下边缩放：宽度跟着高度变，左右居中
      const nextWidth = height * aspect;
      x = start.x + (start.width - nextWidth) / 2;
      width = nextWidth;
    } else if (handle === 'e' || handle === 'w') {
      // 左右边缩放：高度跟着宽度变，上下居中
      const nextHeight = width / aspect;
      y = start.y + (start.height - nextHeight) / 2;
      height = nextHeight;
    } else {
      // 四角：以变化更大的一边为准，锚定对角
      if (width / aspect >= height) height = width / aspect;
      else width = height * aspect;
      if (handle.includes('w')) x = start.x + start.width - width;
      else x = start.x;
      if (handle.includes('n')) y = start.y + start.height - height;
      else y = start.y;
    }
  }

  return { x, y, width, height };
}

function pointFromEvent(event) {
  const point = toImage(event);
  if (!point || !item.value) return null;
  return {
    x: Math.max(0, Math.min(item.value.width, point.x)),
    y: Math.max(0, Math.min(item.value.height, point.y)),
  };
}

function onPointerDown(event) {
  if (!item.value || event.button !== 0) return;
  const point = pointFromEvent(event);
  if (!point) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);

  const handle = handleAt(point);
  if (handle === 'move') {
    drag = { mode: 'move', startRect: { ...state.rect }, origin: point };
  } else if (handle) {
    drag = { mode: 'resize', handle, startRect: { ...state.rect }, origin: point };
  } else {
    drag = { mode: 'create', anchor: point, startRect: { ...state.rect } };
  }
}

function onPointerMove(event) {
  const point = pointFromEvent(event);
  if (!point) return;

  if (!drag) {
    hoverHandle.value = handleAt(point) ?? '';
    return;
  }

  const { width: imageWidth, height: imageHeight } = item.value;
  if (drag.mode === 'move') {
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    const next = {
      x: Math.max(0, Math.min(imageWidth - drag.startRect.width, drag.startRect.x + dx)),
      y: Math.max(0, Math.min(imageHeight - drag.startRect.height, drag.startRect.y + dy)),
      width: drag.startRect.width,
      height: drag.startRect.height,
    };
    actions.setRect(next);
    return;
  }

  if (drag.mode === 'resize') {
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    const next = resizeRect(drag.startRect, drag.handle, dx, dy, state.aspect);
    actions.setRect(clampRect(next, imageWidth, imageHeight));
    return;
  }

  // create：从按下点拉出新框；锁定比例时以宽度为基准
  const left = Math.min(drag.anchor.x, point.x);
  const top = Math.min(drag.anchor.y, point.y);
  let width = Math.max(1, Math.abs(point.x - drag.anchor.x));
  let height = Math.max(1, Math.abs(point.y - drag.anchor.y));
  if (state.aspect > 0) {
    if (width / state.aspect >= height) height = width / state.aspect;
    else width = height * state.aspect;
    if (width > imageWidth) {
      width = imageWidth;
      height = width / state.aspect;
    }
    if (height > imageHeight) {
      height = imageHeight;
      width = height * state.aspect;
    }
  }
  const x = Math.max(0, Math.min(imageWidth - width, point.x < drag.anchor.x ? drag.anchor.x - width : drag.anchor.x));
  const y = Math.max(0, Math.min(imageHeight - height, point.y < drag.anchor.y ? drag.anchor.y - height : drag.anchor.y));
  actions.setRect({ x, y, width, height });
}

function onPointerUp(event) {
  if (!drag) return;
  drag = null;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

// --------------------------------------------------------------- 绘制

function drawBase() {
  const current = item.value;
  const canvas = baseEl.value;
  if (!current || !canvas) return;
  if (canvas.width !== current.width || canvas.height !== current.height) {
    canvas.width = current.width;
    canvas.height = current.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(current.bitmap, 0, 0);
}

function scheduleOverlay() {
  if (overlayFrame) return;
  overlayFrame = requestAnimationFrame(() => {
    overlayFrame = 0;
    drawOverlay();
  });
}

function drawOverlay() {
  const canvas = overlayEl.value;
  const host = container.value;
  const current = item.value;
  if (!canvas || !host || !current) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, host.clientWidth);
  const cssHeight = Math.max(1, host.clientHeight);
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const origin = frameOrigin();
  if (!origin) return;
  const k = origin.width / current.width;
  const rect = state.rect;
  const x = origin.x + rect.x * k;
  const y = origin.y + rect.y * k;
  const w = rect.width * k;
  const h = rect.height * k;

  // 框外压暗
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(origin.x, origin.y, origin.width, Math.max(0, y - origin.y));
  ctx.fillRect(origin.x, y + h, origin.width, Math.max(0, origin.y + origin.height - (y + h)));
  ctx.fillRect(origin.x, y, Math.max(0, x - origin.x), h);
  ctx.fillRect(x + w, y, Math.max(0, origin.x + origin.width - (x + w)), h);

  // 三分构图辅助线
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i <= 2; i += 1) {
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
  }
  ctx.stroke();

  // 边框
  ctx.strokeStyle = '#0d99ff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, w - 1.5), Math.max(0, h - 1.5));

  // 手柄（8 个，恒定 8px 屏幕尺寸）
  const size = 8;
  const half = size / 2;
  const points = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
    [x + w / 2, y],
    [x + w / 2, y + h],
    [x, y + h / 2],
    [x + w, y + h / 2],
  ];
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0d99ff';
  ctx.lineWidth = 1;
  for (const [px, py] of points) {
    ctx.beginPath();
    ctx.rect(px - half, py - half, size, size);
    ctx.fill();
    ctx.stroke();
  }

  // 尺寸标签
  const label = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  ctx.font = '11px ' + (getComputedStyle(document.documentElement).getPropertyValue('--font') || 'sans-serif');
  const textWidth = ctx.measureText(label).width + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(x, Math.max(0, y - 20), textWidth, 18);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + 6, Math.max(12, y - 7));
}

// --------------------------------------------------------------- 生命周期

watch(
  () => item.value?.id,
  async () => {
    const current = item.value;
    if (!current) {
      drag = null;
      return;
    }
    actions.syncCrop();
    setImage(current.width, current.height);
    await nextTick();
    drawBase();
    scheduleOverlay();
  },
  { immediate: true },
);

// 裁剪框 / 缩放 / 平移 / 容器尺寸变化都要重画覆盖层
watchEffect(() => {
  const rect = state.rect;
  void rect.x;
  void rect.y;
  void rect.width;
  void rect.height;
  void view.containerWidth;
  void view.containerHeight;
  void displayWidth.value;
  void displayHeight.value;
  void view.panX;
  void view.panY;
  scheduleOverlay();
});

onMounted(() => {
  window.addEventListener('resize', scheduleOverlay);
});

onBeforeUnmount(() => {
  if (overlayFrame) cancelAnimationFrame(overlayFrame);
  window.removeEventListener('resize', scheduleOverlay);
});

function onWheel(event) {
  if (!item.value) return;
  zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
}

function zoomBy(factor) {
  // 由 useStageViewport 暴露的 zoomIn/zoomOut 以外，还需要任意倍率
  const next = view.zoom * factor;
  view.zoom = Math.min(16, Math.max(0.05, next));
  if (view.zoom <= 1.0001) {
    view.panX = 0;
    view.panY = 0;
  }
}
</script>

<template>
  <section ref="container" class="stage" @wheel.prevent="onWheel">
    <div v-if="!item" class="stage-empty">
      <p>还没有可裁剪的素材</p>
      <p class="muted">从左侧选择图片，或把图片拖进窗口</p>
    </div>

    <template v-else>
      <div
        class="frame"
        :style="frameStyle"
        :class="`cursor-${hoverHandle || 'create'}`"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="hoverHandle = ''"
      >
        <canvas ref="baseEl" class="base" :width="item.width" :height="item.height" />
      </div>

      <canvas ref="overlayEl" class="overlay" />

      <div class="hud">
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
      </div>

      <div class="stage-hint muted">
        拖动边角调整裁剪框 · 框外拖动重新拉框 · 滚轮缩放
      </div>
    </template>
  </section>
</template>

<style scoped>
.stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-canvas);
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-color: var(--checker-a);
  touch-action: none;
}

.stage-empty {
  text-align: center;
  color: var(--text-2);
}

.stage-empty p {
  margin: 4px 0;
}

.frame {
  position: relative;
  flex: none;
  cursor: crosshair;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 8px 32px rgba(0, 0, 0, 0.35);
}

.frame.cursor-move {
  cursor: move;
}
.frame.cursor-nw,
.frame.cursor-se {
  cursor: nwse-resize;
}
.frame.cursor-ne,
.frame.cursor-sw {
  cursor: nesw-resize;
}
.frame.cursor-n,
.frame.cursor-s {
  cursor: ns-resize;
}
.frame.cursor-e,
.frame.cursor-w {
  cursor: ew-resize;
}
.frame.cursor-create {
  cursor: crosshair;
}

.base {
  display: block;
  width: 100%;
  height: 100%;
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hud {
  position: absolute;
  left: 12px;
  bottom: 34px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
}

.hud-btn {
  height: 22px;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 4px;
  color: #fff;
  font-size: 11px;
}

.hud-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}

.hud-zoom {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
}

.stage-hint {
  position: absolute;
  bottom: 10px;
  left: 12px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  color: #d7d7d7;
}
</style>
