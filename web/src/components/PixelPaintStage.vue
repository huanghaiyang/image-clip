<script setup>
/**
 * 像素笔绘舞台
 * ------------
 * 显示 usePixelPaint 维护的工作画布：笔迹直接写进画布像素，
 * 舞台只负责把画布画出来、把指针坐标换算成图像像素并驱动落笔。
 *
 * 和橡皮擦不同的两点：
 *  - 笔刷是方形且不做抗锯齿，放大后能清楚看到像素格；
 *  - 增加「吸管 / 平移」工具，取色和平移大图都不需要离开这个工作区。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { usePixelPaint } from '../composables/usePixelPaint.js';
import { useStageViewport } from '../composables/useStageViewport.js';

const { selected } = useWorkspace();
const { state, activeEntry, actions } = usePixelPaint();
const { container, baseEl, view, frameStyle, displayWidth, displayHeight, zoomPercent, setImage, zoomIn, zoomOut, resetView, toImage, frameOrigin } =
  useStageViewport();

const overlayEl = ref(null);
const item = computed(() => selected.value ?? null);
const entry = computed(() => activeEntry.value);

let overlayFrame = 0;
let painting = false;
let panning = null;
/** 光标位置（覆盖层容器坐标），null 表示不在画面上。 */
const cursor = ref(null);

const stageClass = computed(() => ({
  'is-pan': state.brush.tool === 'pan',
}));

function pointFromEvent(event) {
  const point = toImage(event);
  const current = item.value;
  if (!point || !current) return null;
  return {
    x: Math.max(0, Math.min(current.width - 1, point.x)),
    y: Math.max(0, Math.min(current.height - 1, point.y)),
  };
}

function onPointerDown(event) {
  if (!entry.value || event.button !== 0) return;

  if (state.brush.tool === 'pan') {
    panning = { clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return;
  }

  const point = pointFromEvent(event);
  if (!point) return;

  if (state.brush.tool === 'pick') {
    actions.pickColorAt(point);
    updateCursor(event);
    return;
  }

  event.currentTarget.setPointerCapture?.(event.pointerId);
  painting = actions.beginStroke(point);
  updateCursor(event);
}

function onPointerMove(event) {
  updateCursor(event);

  if (panning) {
    view.panX += event.clientX - panning.clientX;
    view.panY += event.clientY - panning.clientY;
    panning.clientX = event.clientX;
    panning.clientY = event.clientY;
    return;
  }

  if (!painting) return;
  const point = pointFromEvent(event);
  if (point) actions.extendStroke(point);
}

function onPointerUp(event) {
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  panning = null;
  if (!painting) return;
  actions.endStroke();
  painting = false;
}

/** 指针离开画面：结束当前笔画并隐藏笔刷光标。 */
function onPointerLeave() {
  if (painting) {
    actions.endStroke();
    painting = false;
  }
  panning = null;
  cursor.value = null;
  scheduleOverlay();
}

function updateCursor(event) {
  const origin = frameOrigin();
  if (!origin || !container.value || !item.value) {
    cursor.value = null;
    return;
  }
  const host = container.value.getBoundingClientRect();
  const x = event.clientX - host.left;
  const y = event.clientY - host.top;
  cursor.value = { x, y };
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
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(e.canvas, 0, 0);
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
  const e = entry.value;
  const current = item.value;
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

  const origin = frameOrigin();
  if (!e || !current || !origin) return;

  const stepX = origin.width / e.width;
  const stepY = origin.height / e.height;

  // 像素网格：每个图像像素至少占 3 个屏幕像素时才画，避免缩放很小时糊成一片
  if (state.brush.grid && stepX >= 3 && stepY >= 3) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(origin.x, origin.y, origin.width, origin.height);
    ctx.clip();
    ctx.strokeStyle = 'rgba(127,127,127,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 只画可见范围内的线：4000px 的大图放大后也不会生成上万条路径
    const startX = Math.max(0, Math.floor((0 - origin.x) / stepX));
    const endX = Math.min(e.width, Math.ceil((cssWidth - origin.x) / stepX));
    const startY = Math.max(0, Math.floor((0 - origin.y) / stepY));
    const endY = Math.min(e.height, Math.ceil((cssHeight - origin.y) / stepY));
    for (let x = startX; x <= endX; x += 1) {
      const sx = Math.round(origin.x + x * stepX) + 0.5;
      ctx.moveTo(sx, Math.max(origin.y, 0));
      ctx.lineTo(sx, Math.min(origin.y + origin.height, cssHeight));
    }
    for (let y = startY; y <= endY; y += 1) {
      const sy = Math.round(origin.y + y * stepY) + 0.5;
      ctx.moveTo(Math.max(origin.x, 0), sy);
      ctx.lineTo(Math.min(origin.x + origin.width, cssWidth), sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (!cursor.value || state.brush.tool === 'pan') return;

  const ix = Math.floor((cursor.value.x - origin.x) / stepX);
  const iy = Math.floor((cursor.value.y - origin.y) / stepY);
  if (ix < 0 || iy < 0 || ix >= e.width || iy >= e.height) return;

  if (state.brush.tool === 'pick') {
    // 吸管：小圆环 + 十字，提示“点击取色”
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cursor.value.x, cursor.value.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cursor.value.x, cursor.value.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cursor.value.x - 11, cursor.value.y);
    ctx.lineTo(cursor.value.x + 11, cursor.value.y);
    ctx.moveTo(cursor.value.x, cursor.value.y - 11);
    ctx.lineTo(cursor.value.x, cursor.value.y + 11);
    ctx.stroke();
    return;
  }

  // 画笔画刷：按图像像素对齐的方框，所见即所画
  const size = Math.max(1, Math.round(state.brush.size));
  const left = Math.round(ix - size / 2);
  const top = Math.round(iy - size / 2);
  const sx = origin.x + left * stepX;
  const sy = origin.y + top * stepY;
  const sw = Math.max(2, size * stepX);
  const sh = Math.max(2, size * stepY);

  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.strokeStyle = state.brush.tool === 'eraser' ? 'rgba(242,72,34,0.95)' : 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(sx, sy, sw, sh);

  // 大笔刷时在中心加一个像素点，方便对齐网格
  if (stepX >= 6) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(origin.x + ix * stepX, origin.y + iy * stepY, Math.max(1, stepX), Math.max(1, stepY));
  }
}

// --------------------------------------------------------------- 生命周期

watch(
  () => item.value?.id,
  async () => {
    painting = false;
    panning = null;
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

// 笔刷大小 / 工具 / 网格 / 缩放 / 平移变化 → 光标和网格跟着重画
watchEffect(() => {
  void state.brush.size;
  void state.brush.tool;
  void state.brush.grid;
  void displayWidth.value;
  void displayHeight.value;
  void view.containerWidth;
  void view.containerHeight;
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
  painting = false;
  panning = null;
});

function onWheel(event) {
  if (!entry.value) return;
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  view.zoom = Math.min(16, Math.max(0.05, view.zoom * factor));
  if (view.zoom <= 1.0001) {
    view.panX = 0;
    view.panY = 0;
  }
}
</script>

<template>
  <section ref="container" class="stage" :class="stageClass" @wheel.prevent="onWheel">
    <div v-if="!item" class="stage-empty">
      <p>还没有可绘制的素材</p>
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
        <canvas ref="baseEl" class="base" :class="{ 'is-pixelated': zoomPercent >= 100 }" />
      </div>

      <canvas ref="overlayEl" class="overlay" />

      <div class="hud">
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
      </div>

      <div class="stage-hint muted">
        <template v-if="state.brush.tool === 'brush'">像素画笔：拖动绘制 · [ / ] 调笔刷 · Ctrl+Z 撤销</template>
        <template v-else-if="state.brush.tool === 'eraser'">像素橡皮：拖动擦成透明 · 可配合网格精修</template>
        <template v-else-if="state.brush.tool === 'pick'">吸管：点击画面取色（B 回到画笔）</template>
        <template v-else>平移：拖动查看大图（滚轮仍可缩放）</template>
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

.stage.is-pan {
  cursor: grab;
}

.stage.is-pan:active {
  cursor: grabbing;
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

.base {
  display: block;
  width: 100%;
  height: 100%;
}

/* 放大到 100% 以上时用最近邻采样，像素块保持锐利 */
.base.is-pixelated {
  image-rendering: pixelated;
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
