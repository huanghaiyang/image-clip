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

import { useCropTool } from '../composables/useCropTool.js';
import { useStageViewport } from '../composables/useStageViewport.js';
import { clampRect } from '@shared/selection.js';

const { state, actions, activeItem, atlasItems, atlasCount, atlasIndex, normalizedRect } = useCropTool();
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
// 图集模式下当前项 = 当前层，否则跟随左侧素材选中
const item = computed(() => activeItem.value ?? null);
const atlasEnabled = computed(() => state.atlas.enabled);

/**
 * 纸叠效果：当前层底下露出的几张“纸”（循环取前面几层）。
 * 只是视觉层叠，真正的层切换在右侧层条里。
 */
const paperLayers = computed(() => {
  if (!atlasEnabled.value) return [];
  const list = atlasItems.value;
  const count = list.length;
  if (count < 2) return [];
  const show = Math.min(3, count - 1);
  const papers = [];
  for (let i = show; i >= 1; i -= 1) {
    const layer = list[(atlasIndex.value - i + count) % count];
    papers.push({
      id: layer.id,
      src: layer.thumbnail,
      name: layer.name,
      style: {
        transform: `translate(${i * 7}px, ${i * 9}px) rotate(${i % 2 ? 1.6 : -1.2}deg)`,
        zIndex: i,
      },
    });
  }
  return papers;
});

/**
 * 右侧层条：每一层按当前归一化裁剪框裁出预览缩略图。
 * 用 CSS 百分比定位模拟裁切（img 放大到 1/nw 倍再平移），不用逐张生成位图。
 */
const layerThumbs = computed(() => {
  if (!atlasEnabled.value) return [];
  const norm = normalizedRect.value;
  const nw = Math.max(0.0001, norm.width);
  const nh = Math.max(0.0001, norm.height);
  return atlasItems.value.map((layer, index) => ({
    id: layer.id,
    index,
    name: layer.name,
    src: layer.thumbnail,
    aspect: (nw * layer.width) / Math.max(1e-6, nh * layer.height),
    imgStyle: {
      width: `${100 / nw}%`,
      height: `${100 / nh}%`,
      left: `${(-norm.x / nw) * 100}%`,
      top: `${(-norm.y / nh) * 100}%`,
    },
  }));
});

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
  if (isPanGesture(event)) return; // 交给舞台容器处理平移
  if (!item.value || event.button !== 0) return;
  const point = pointFromEvent(event);
  if (!point) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);

  const handle = handleAt(point);
  actions.beginCropEdit();
  if (handle === 'move') {
    drag = { mode: 'move', startRect: { ...state.rect }, origin: point };
  } else if (handle) {
    drag = { mode: 'resize', handle, startRect: { ...state.rect }, origin: point };
  } else {
    drag = { mode: 'create', anchor: point, startRect: { ...state.rect } };
  }
}

function onPointerMove(event) {
  if (panning.value) return;
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
  actions.endCropEdit();
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

// --------------------------------------------------------------- 画布平移

function onStagePointerDown(event) {
  if (!isPanGesture(event) || !item.value) return;
  event.preventDefault();
  beginPan(event);
  panning.value = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
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
    // 图集模式切层时保持缩放与平移，翻看效果才连贯
    setImage(current.width, current.height, { reset: !state.atlas.enabled });
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
  window.addEventListener('keydown', onLayerKeydown);
});

onBeforeUnmount(() => {
  if (overlayFrame) cancelAnimationFrame(overlayFrame);
  window.removeEventListener('resize', scheduleOverlay);
  window.removeEventListener('keydown', onLayerKeydown);
});

/** 图集模式下用方向键翻层（不在输入框中时）。 */
function onLayerKeydown(event) {
  if (!state.atlas.enabled) return;
  const target = event.target;
  if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    event.preventDefault();
    actions.stepLayer(1);
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault();
    actions.stepLayer(-1);
  }
}

function onWheel(event) {
  if (!item.value) return;
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
        <!-- 图集模式：底下几张“纸”从当前层后面露出来 -->
        <div v-for="paper in paperLayers" :key="paper.id" class="paper" :style="paper.style" :title="paper.name">
          <img :src="paper.src" :alt="paper.name" draggable="false" />
        </div>
        <canvas ref="baseEl" class="base" :class="{ 'is-top': atlasEnabled }" :width="item.width" :height="item.height" />
      </div>

      <canvas ref="overlayEl" class="overlay" />

      <!-- 图集模式：右侧层条，逐层预览裁切效果 -->
      <div v-if="atlasEnabled" class="layer-strip">
        <div class="layer-strip-head mono">{{ atlasIndex + 1 }}/{{ atlasCount }}</div>
        <div class="layer-list">
          <button
            v-for="thumb in layerThumbs"
            :key="thumb.id"
            class="layer-thumb"
            :class="{ 'is-active': thumb.index === atlasIndex }"
            type="button"
            :title="`${thumb.index + 1}. ${thumb.name}`"
            @click="actions.setAtlasLayer(thumb.index)"
          >
            <span class="layer-clip" :style="{ aspectRatio: String(thumb.aspect) }">
              <img :src="thumb.src" :alt="thumb.name" :style="thumb.imgStyle" draggable="false" />
            </span>
            <span class="layer-index mono">{{ thumb.index + 1 }}</span>
          </button>
        </div>
      </div>

      <div class="hud">
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
        <button
          class="hud-btn is-text"
          :class="{ 'is-on': atlasEnabled }"
          type="button"
          title="图集模式：素材像纸一样叠加，统一裁剪框，逐层查看效果"
          @click="actions.toggleAtlas()"
        >
          图集
        </button>
      </div>

      <div class="stage-hint muted">
        <template v-if="atlasEnabled">图集模式 · ←/→ 或点击右侧层条翻看每一层 · 拖动调整统一裁剪框</template>
        <template v-else>拖动边角调整裁剪框 · 空格 / 中键拖动平移 · 滚轮缩放</template>
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

/* 空格 / 中键拖动平移：光标提示要压过框上的手柄光标 */
.stage.is-pan-ready {
  cursor: grab;
}
.stage.is-pan-ready .frame {
  cursor: grab;
}
.stage.is-panning,
.stage.is-panning .frame {
  cursor: grabbing;
}

.base {
  display: block;
  width: 100%;
  height: 100%;
}

/* 图集模式：顶层的“纸”要有自己的投影，和底下的纸区分开；
   背景沿用棋盘格，透明 PNG 的透明区不会变成纯白。 */
.base.is-top {
  position: relative;
  z-index: 10;
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-color: var(--checker-a);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.paper {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-color: var(--checker-a);
  border: 1px solid rgba(0, 0, 0, 0.18);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28);
}

.paper img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
}

/* 右侧层条：逐层裁切预览 */
.layer-strip {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 48px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  width: 92px;
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  overflow: hidden;
}

.layer-strip-head {
  flex: none;
  padding: 6px 0 4px;
  text-align: center;
  color: #fff;
  font-size: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.layer-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.layer-thumb {
  position: relative;
  display: block;
  width: 100%;
  margin-bottom: 6px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.layer-thumb:hover {
  background: rgba(255, 255, 255, 0.14);
}

.layer-thumb.is-active {
  border-color: var(--accent);
  background: rgba(13, 153, 255, 0.18);
}

.layer-clip {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: 2px;
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  background-color: var(--checker-a);
}

.layer-clip img {
  position: absolute;
  max-width: none;
  max-height: none;
}

.layer-index {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
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

.hud-btn.is-on {
  background: var(--accent);
  color: #fff;
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
