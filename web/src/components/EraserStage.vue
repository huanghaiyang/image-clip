<script setup>
/**
 * 橡皮擦舞台
 * ----------
 * 显示的是 useEraser 维护的**工作画布**：擦除直接改画布像素，
 * 舞台只负责把它画出来并处理指针事件，因此撤销/对比/导出都基于同一份数据。
 *
 * 笔刷光标画在覆盖层（屏幕坐标），半径按缩放换算，
 * 这样用户看到的就是实际会擦掉的屏幕范围。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useEraser } from '../composables/useEraser.js';
import { useStageViewport } from '../composables/useStageViewport.js';

const { selected } = useWorkspace();
const { state, activeEntry, actions } = useEraser();
const {
  container,
  baseEl,
  view,
  frameStyle,
  displayWidth,
  displayHeight,
  zoomPercent,
  spaceHeld,
  setImage,
  zoomIn,
  zoomOut,
  resetView,
  zoomAt,
  isPanGesture,
  beginPan,
  movePan,
  endPan,
  toImage,
  frameOrigin,
} = useStageViewport();

const overlayEl = ref(null);
const panning = ref(false);
const item = computed(() => selected.value ?? null);
const entry = computed(() => activeEntry.value);

let overlayFrame = 0;
let painting = false;
/** 光标位置（覆盖层容器坐标），null 表示移出画面。 */
const cursor = ref(null);

function pointFromEvent(event) {
  const point = toImage(event);
  if (!point || !item.value) return null;
  return {
    x: Math.max(0, Math.min(item.value.width, point.x)),
    y: Math.max(0, Math.min(item.value.height, point.y)),
  };
}

function onPointerDown(event) {
  if (isPanGesture(event)) return; // 交给舞台容器处理平移
  if (!entry.value || event.button !== 0) return;
  const point = pointFromEvent(event);
  if (!point) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  painting = actions.beginStroke(point);
  updateCursor(event);
}

function onPointerMove(event) {
  if (panning.value) return;
  updateCursor(event);
  if (!painting) return;
  const point = pointFromEvent(event);
  if (point) actions.extendStroke(point);
}

function onPointerUp(event) {
  if (!painting) {
    updateCursor(event);
    return;
  }
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  actions.endStroke();
  painting = false;
}

// --------------------------------------------------------------- 画布平移

function onStagePointerDown(event) {
  if (!entry.value || !isPanGesture(event)) return;
  event.preventDefault();
  beginPan(event);
  panning.value = true;
  cursor.value = null;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  scheduleOverlay();
}

function onStagePointerMove(event) {
  if (!panning.value) return;
  event.preventDefault();
  movePan(event);
}

function onStagePointerUp(event) {
  if (!panning.value) return;
  panning.value = false;
  endPan();
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

/** 指针离开画面：结束当前笔画并隐藏笔刷光标。 */
function onPointerLeave() {
  if (painting) {
    actions.endStroke();
    painting = false;
  }
  cursor.value = null;
  scheduleOverlay();
}

function updateCursor(event) {
  const origin = frameOrigin();
  if (!origin || !container.value) {
    cursor.value = null;
    return;
  }
  const host = container.value.getBoundingClientRect();
  cursor.value = { x: event.clientX - host.left, y: event.clientY - host.top };
}

// --------------------------------------------------------------- 绘制

function drawBase() {
  const canvas = baseEl.value;
  const e = entry.value;
  if (!canvas || !e) return;
  if (canvas.width !== e.width || canvas.height !== e.height) {
    canvas.width = e.width;
    canvas.height = e.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // 「对比原图」时直接画原图副本；否则画工作画布
  ctx.drawImage(state.brush.showOriginal ? e.source : e.canvas, 0, 0);
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
  if (!canvas || !host) return;

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

  if (!cursor.value) return;
  const radius = Math.max(1.5, (state.brush.size / 2) * (displayWidth.value / Math.max(1, item.value?.width ?? 1)));

  // 黑白双圈：无论背景明暗都能看清笔刷范围
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cursor.value.x, cursor.value.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = state.brush.mode === 'restore' ? 'rgba(20,174,92,0.95)' : 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cursor.value.x, cursor.value.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  // 十字中心点，方便精修细节
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cursor.value.x - 4, cursor.value.y);
  ctx.lineTo(cursor.value.x + 4, cursor.value.y);
  ctx.moveTo(cursor.value.x, cursor.value.y - 4);
  ctx.lineTo(cursor.value.x, cursor.value.y + 4);
  ctx.stroke();
}

// --------------------------------------------------------------- 生命周期

watch(
  () => item.value?.id,
  async () => {
    painting = false;
    cursor.value = null;
    const current = item.value;
    const e = actions.prepareSelected();
    if (!current || !e) return;
    setImage(current.width, current.height);
    await nextTick();
    drawBase();
    scheduleOverlay();
  },
  { immediate: true },
);

watch(
  () => entry.value?.version,
  async () => {
    await nextTick();
    drawBase();
    scheduleOverlay();
  },
);

watch(
  () => state.brush.showOriginal,
  () => {
    drawBase();
    scheduleOverlay();
  },
);

// 笔刷大小 / 缩放变化 → 光标圆圈跟着变
watchEffect(() => {
  void state.brush.size;
  void displayWidth.value;
  void view.containerWidth;
  void view.containerHeight;
  scheduleOverlay();
});

onMounted(() => {
  window.addEventListener('resize', scheduleOverlay);
});

onBeforeUnmount(() => {
  if (overlayFrame) cancelAnimationFrame(overlayFrame);
  window.removeEventListener('resize', scheduleOverlay);
  painting = false;
});

function onWheel(event) {
  if (!entry.value) return;
  zoomAt(event, event.deltaY < 0 ? 1.1 : 1 / 1.1);
}
</script>

<template>
  <section
    ref="container"
    class="stage"
    :class="{ 'is-pan-ready': spaceHeld, 'is-panning': panning }"
    @wheel.prevent="onWheel"
    @pointerdown="onStagePointerDown"
    @pointermove="onStagePointerMove"
    @pointerup="onStagePointerUp"
    @pointercancel="onStagePointerUp"
  >
    <div v-if="!item" class="stage-empty">
      <p>还没有可擦除的素材</p>
      <p class="muted">从左侧选择图片，或把图片拖进窗口</p>
    </div>

    <template v-else>
      <div
        class="frame"
        :style="frameStyle"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
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
        <template v-if="state.brush.showOriginal">正在对比原图（关闭开关后继续编辑）</template>
        <template v-else-if="state.brush.mode === 'restore'">还原笔刷：把原图像素画回去 · 空格 / 中键拖动平移</template>
        <template v-else>擦除笔刷：拖动擦成透明 · [ / ] 调整笔刷大小 · 空格 / 中键拖动平移</template>
        <template v-if="entry?.dirty"> · 有未导出的修改</template>
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
  user-select: none;
  cursor: crosshair;
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
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 8px 32px rgba(0, 0, 0, 0.35);
}

/* 空格 / 中键拖动平移：覆盖全局的十字光标 */
.stage.is-pan-ready {
  cursor: grab;
}
.stage.is-panning {
  cursor: grabbing;
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
