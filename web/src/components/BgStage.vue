<script setup>
/**
 * 背景去除舞台
 * ------------
 * 显示的是**预览分辨率**（最长边 1600px）的合成结果，保证拖参数时实时；
 * 点“应用”时才由 useBgRemoval 按原图分辨率重算并导出 PNG。
 *
 * 坐标换算要特别小心：
 *  屏幕 → 预览图（viewport.toImage）→ 原图（除以 preview.scale）。
 * useBgRemoval 内部统一用**原图坐标**存套索多边形，所以这里必须乘/除回去。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useBgRemoval } from '../composables/useBgRemoval.js';
import { useStageViewport } from '../composables/useStageViewport.js';

const { selected } = useWorkspace();
const { state, activeEntry, actions } = useBgRemoval();
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
const hoveredHole = ref(null); // { id, area, bbox } | null
const item = computed(() => selected.value ?? null);
const entry = computed(() => activeEntry.value);

let overlayFrame = 0;
let drag = null; // {mode:'pan', clientX, clientY} | {mode:'lasso'}

const cursorClass = computed(() => {
  if (state.tool === 'pan') return 'cursor-grab';
  if (state.tool === 'pick') return 'cursor-pick';
  if (state.tool === 'hole') return 'cursor-hole';
  return 'cursor-lasso';
});

/** 预览图坐标 → 原图坐标。 */
function toOriginal(point) {
  const scale = entry.value?.preview?.scale || 1;
  return { x: point.x / scale, y: point.y / scale };
}

function pointFromEvent(event) {
  const point = toImage(event);
  if (!point) return null;
  const e = entry.value;
  if (!e) return null;
  const preview = e.preview;
  return {
    preview: {
      x: Math.max(0, Math.min(preview.width, point.x)),
      y: Math.max(0, Math.min(preview.height, point.y)),
    },
    original: toOriginal(point),
  };
}

/** 屏幕像素 / 预览像素：智能套索用它把“屏幕吸附半径”换算到预览坐标。 */
function screenScale() {
  return view.fit * Math.max(0.01, view.zoom);
}

// 参数面板改动吸附半径时，useBgRemoval 需要当前缩放来重算已绘制的选区
watchEffect(() => {
  actions.setViewScale(screenScale());
});

// --------------------------------------------------------------- 指针交互

function onPointerDown(event) {
  if (isPanGesture(event)) return; // 交给舞台容器处理平移
  if (!entry.value || event.button !== 0) return;
  if (state.tool === 'pan') {
    drag = { mode: 'pan', clientX: event.clientX, clientY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.stopPropagation();
    return;
  }

  const point = pointFromEvent(event);
  if (!point) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);

  if (state.tool === 'pick') {
    actions.pickColorAt(point.original.x, point.original.y);
    drag = null;
    return;
  }

  if (state.tool === 'hole') {
    // 孔洞工具：点选当前光标下的那个孔洞 → 移除
    const hole = actions.holeAtPoint(entry.value, point.preview.x, point.preview.y);
    if (hole) actions.removeHole(entry.value, hole.id);
    drag = null;
    return;
  }

  drag = { mode: 'lasso' };
  actions.beginLasso(point.preview, screenScale());
}

function onPointerMove(event) {
  // hole 工具的 hover 检测：不走 drag 状态，直接查当前点有没有命中孔洞
  if (state.tool === 'hole') {
    const point = pointFromEvent(event);
    if (!point) return;
    const e = entry.value;
    const hole = e ? actions.holeAtPoint(e, point.preview.x, point.preview.y) : null;
    hoveredHole.value = hole;
    scheduleOverlay();
    return;
  }

  if (panning.value || !drag) return;

  if (drag.mode === 'pan') {
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    // 平移直接改 view，不需要经过 composable
    view.panX += dx;
    view.panY += dy;
    return;
  }

  const point = pointFromEvent(event);
  if (point) actions.extendLasso(point.preview, screenScale());
}

function onPointerUp(event) {
  if (!drag) return;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  if (drag.mode === 'lasso') actions.endLasso({ close: true }, screenScale());
  drag = null;
}

// --------------------------------------------------------------- 画布平移

function onStagePointerDown(event) {
  if (!entry.value) return;
  const wantsPan = isPanGesture(event) || (state.tool === 'pan' && event.button === 0);
  if (!wantsPan) return;
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
  const canvas = baseEl.value;
  const previewCanvas = entry.value?.previewCanvas;
  if (!canvas || !previewCanvas) return;
  if (canvas.width !== previewCanvas.width || canvas.height !== previewCanvas.height) {
    canvas.width = previewCanvas.width;
    canvas.height = previewCanvas.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(previewCanvas, 0, 0);
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
  if (!canvas || !host || !e) return;

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
  const preview = e.preview;
  // 原图坐标 → 屏幕坐标
  const k = (origin.width / preview.width) * preview.scale;
  const toScreen = (point) => ({ x: origin.x + point.x * k, y: origin.y + point.y * k });

  const polygon = e.polygon;
  const draft = e.draftPoints;

  if (polygon.length >= 3) {
    ctx.beginPath();
    const first = toScreen(polygon[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < polygon.length; i += 1) {
      const p = toScreen(polygon[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    // 选区内淡蓝色填充，告诉用户“约束范围”落在哪
    ctx.fillStyle = 'rgba(13,153,255,0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(13,153,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#0d99ff';
    for (const point of polygon) {
      const p = toScreen(point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (draft.length > 0) {
    ctx.beginPath();
    const first = toScreen(draft[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < draft.length; i += 1) {
      const p = toScreen(draft[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = '#ffcd29';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 起点画一个小圆，提示“回到这里闭合”
    ctx.fillStyle = '#ffcd29';
    ctx.beginPath();
    ctx.arc(first.x, first.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ----------------------------------------------------------- 孔洞标记
  const holes = e.holes;
  if (state.tool === 'hole' && holes && holes.length) {
    const highlight = hoveredHole.value?.id;
    for (const hole of holes) {
      const { x: bx, y: by, width: bw, height: bh } = hole.bbox;
      const tl = toScreen({ x: bx, y: by });
      const br = toScreen({ x: bx + bw, y: by + bh });
      const cx = (tl.x + br.x) / 2;
      const cy = (tl.y + br.y) / 2;
      const diag = Math.hypot(bw, bh) * k;
      const r = Math.max(4, Math.min(28, diag * 0.5));
      const isHighlight = hole.id === highlight;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = isHighlight ? 'rgba(255,80,80,0.32)' : 'rgba(255,180,80,0.22)';
      ctx.fill();
      ctx.strokeStyle = isHighlight ? '#ff3f3f' : '#ffb450';
      ctx.lineWidth = isHighlight ? 2 : 1.2;
      ctx.stroke();

      if (isHighlight) {
        const tr = toScreen({ x: bx + bw, y: by });
        const bl = toScreen({ x: bx, y: by + bh });
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(br.x, br.y);
        ctx.lineTo(bl.x, bl.y);
        ctx.closePath();
        ctx.strokeStyle = '#ff3f3f';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (hole.area > 1) {
          ctx.fillStyle = '#ff3f3f';
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${hole.area}px`, cx, cy);
        }
      }
    }
  }
}

// --------------------------------------------------------------- 生命周期

watch(
  () => item.value?.id,
  async () => {
    drag = null;
    const current = item.value;
    const e = actions.prepareSelected();
    if (!current || !e) return;
    setImage(e.preview.width, e.preview.height);
    await nextTick();
    drawBase();
    scheduleOverlay();
  },
  { immediate: true },
);

watch(
  () => entry.value?.previewVersion,
  async () => {
    await nextTick();
    drawBase();
    scheduleOverlay();
  },
);

watchEffect(() => {
  const e = entry.value;
  if (!e) return;
  void e.polygon.length;
  void e.draftPoints.length;
  const last = e.draftPoints[e.draftPoints.length - 1];
  if (last) {
    void last.x;
    void last.y;
  }
  void e.holes?.length;
  void state.tool; // 切换「噪点」工具后立刻重绘标记，不用等鼠标移动
  if (state.tool !== 'hole') hoveredHole.value = null;
  void hoveredHole.value?.id;
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
      <p>还没有可抠图的素材</p>
      <p class="muted">从左侧选择图片，或把图片拖进窗口</p>
    </div>

    <template v-else>
      <div
        class="frame"
        :class="cursorClass"
        :style="frameStyle"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <canvas ref="baseEl" class="base" :width="entry?.preview.width || 1" :height="entry?.preview.height || 1" />
      </div>

      <canvas ref="overlayEl" class="overlay" />

      <div class="hud">
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
      </div>

      <div class="stage-hint muted">
        <template v-if="state.tool === 'lasso'">
          {{ entry?.options.lassoMode === 'smart' ? '智能套索：落点吸附图像边缘，松开自动简化' : '按住拖动绘制套索，松开自动闭合' }} ·
          空格 / 中键拖动平移
        </template>
        <template v-else-if="state.tool === 'pick'">点击画面取背景色（仅去除该颜色） · 空格 / 中键拖动平移</template>
        <template v-else-if="state.tool === 'hole'">
          点击画面上的孔洞标记将其移除 ·
          {{ entry?.holes?.length ? `已检测到 ${entry.holes.length} 个孔洞` : '当前没有检测到孔洞' }} ·
          空格 / 中键拖动平移
        </template>
        <template v-else>拖动平移画面 · 空格 / 中键也可拖动</template>
        <template v-if="entry?.computing"> · 计算中…</template>
        <template v-else-if="entry"> · {{ (entry.coverage * 100).toFixed(1) }}% 透明</template>
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

.cursor-lasso {
  cursor: crosshair;
}

.cursor-pick {
  cursor: copy;
}

.cursor-hole {
  cursor: not-allowed;
  cursor: var(--cursor-hole, cell);
}

.cursor-grab {
  cursor: grab;
}

.cursor-grab:active {
  cursor: grabbing;
}

/* 空格 / 中键拖动平移：光标提示要压过工具光标 */
.stage.is-pan-ready,
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
