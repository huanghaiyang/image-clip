<script setup>
/**
 * 中央画布：透明棋盘格底 + 图片 + 裁剪框（Figma 风格选择框与手柄）。
 * 支持滚轮缩放、拖拽平移、拖放导入，并实时显示像素坐标与 alpha 值。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';

const { state, selected, actions } = useWorkspace();

const stageEl = ref(null);
const canvasEl = ref(null);
const size = ref({ w: 0, h: 0 });
const offset = ref({ x: 0, y: 0 });
const hover = ref(null);
const dragging = ref(false);
const dropActive = ref(false);

const MODES = [
  { value: 'source', label: '源图 + 裁剪框' },
  { value: 'result', label: '裁剪结果' },
];

const mode = computed(() => state.view.mode);
const showBox = computed(() => state.view.showBox);

/** 当前视图要显示的尺寸：源图模式=整图，结果模式=裁剪框。 */
const displayDims = computed(() => {
  const item = selected.value;
  if (!item) return { w: 1, h: 1 };
  if (mode.value === 'result' && item.bounds && !item.resultEmpty) {
    return { w: item.bounds.width, h: item.bounds.height };
  }
  return { w: item.width, h: item.height };
});

const isFit = computed(() => state.view.zoom === 'fit');

const fitScale = computed(() => {
  const { w, h } = displayDims.value;
  const pad = 88;
  const available = { w: Math.max(32, size.value.w - pad), h: Math.max(32, size.value.h - pad) };
  return Math.min(available.w / w, available.h / h, 8) || 1;
});

const zoom = computed(() => (isFit.value ? fitScale.value : Number(state.view.zoom) || 1));

function centeredOffset(scale = zoom.value) {
  const { w, h } = displayDims.value;
  return {
    x: Math.round((size.value.w - w * scale) / 2),
    y: Math.round((size.value.h - h * scale) / 2),
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

// ------------------------------------------------------------- 画布绘制

let patternCache = { key: '', pattern: null };

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

let rafId = 0;

function requestDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    draw();
  });
}

/** 外层包一层 try/catch：绘制异常不应让画布静默变空白（会打到控制台便于定位）。 */
function draw() {
  try {
    paint();
  } catch (err) {
    console.error('[image-clip] 画布绘制失败', err);
  }
}

function paint() {
  const canvas = canvasEl.value;
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

  const item = selected.value;
  if (!item) return;

  const scale = zoom.value;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (mode.value === 'result' && item.bounds && !item.resultEmpty) {
    // 注意 item.bounds 的键是 width/height（与 detectBounds 的返回一致）
    const { x, y, width: dw, height: dh } = item.bounds;
    if (dw > 0 && dh > 0) {
      ctx.drawImage(item.bitmap, x, y, dw, dh, offset.value.x, offset.value.y, dw * scale, dh * scale);
    }
    return;
  }

  const dw = item.width * scale;
  const dh = item.height * scale;
  ctx.drawImage(item.bitmap, offset.value.x, offset.value.y, dw, dh);

  if (!showBox.value || !item.bounds || item.resultEmpty) return;

  // 裁剪掉的区域压暗，直观看到“要切掉什么”
  const fx = offset.value.x + item.bounds.x * scale;
  const fy = offset.value.y + item.bounds.y * scale;
  const fw = item.bounds.width * scale;
  const fh = item.bounds.height * scale;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.fillRect(offset.value.x, offset.value.y, dw, Math.max(0, fy - offset.value.y));
  ctx.fillRect(offset.value.x, fy + fh, dw, Math.max(0, offset.value.y + dh - (fy + fh)));
  ctx.fillRect(offset.value.x, fy, Math.max(0, fx - offset.value.x), fh);
  ctx.fillRect(fx + fw, fy, Math.max(0, offset.value.x + dw - (fx + fw)), fh);
}

/** 选择框在屏幕坐标下的位置（用于 DOM 叠加层，保证 1px 描边清晰）。 */
const frame = computed(() => {
  const item = selected.value;
  if (!item || !item.bounds || item.resultEmpty || mode.value !== 'source' || !showBox.value) return null;
  const scale = zoom.value;
  return {
    left: offset.value.x + item.bounds.x * scale,
    top: offset.value.y + item.bounds.y * scale,
    width: item.bounds.width * scale,
    height: item.bounds.height * scale,
  };
});

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// ------------------------------------------------------------- 交互

let panState = null;

function onPointerDown(event) {
  const stage = stageEl.value;
  if (!stage || (event.button !== 0 && event.button !== 1)) return;
  if (!selected.value) return;
  // 工具栏/缩放控件上的按下不触发平移
  if (event.target.closest?.('.stage-toolbar, .stage-zoom, .empty-actions')) return;
  panState = { x: event.clientX, y: event.clientY, ox: offset.value.x, oy: offset.value.y };
  dragging.value = true;
  stage.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  const stage = stageEl.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();

  if (panState) {
    offset.value = {
      x: panState.ox + (event.clientX - panState.x),
      y: panState.oy + (event.clientY - panState.y),
    };
    hover.value = null;
    return;
  }

  const item = selected.value;
  if (!item || mode.value === 'result') {
    hover.value = null;
    return;
  }

  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const scale = zoom.value;
  const ix = Math.floor((sx - offset.value.x) / scale);
  const iy = Math.floor((sy - offset.value.y) / scale);

  if (ix < 0 || iy < 0 || ix >= item.width || iy >= item.height) {
    hover.value = null;
    return;
  }
  const data = item.imageData.data;
  const i = (iy * item.width + ix) * 4;
  hover.value = { x: ix, y: iy, r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

function onPointerUp(event) {
  panState = null;
  dragging.value = false;
  stageEl.value?.releasePointerCapture?.(event.pointerId);
}

function onWheel(event) {
  if (!selected.value) return;
  event.preventDefault();
  setZoom(zoom.value * Math.exp(-event.deltaY * 0.0015), { x: event.clientX, y: event.clientY });
}

function onDrop(event) {
  event.preventDefault();
  dropActive.value = false;
  if (event.dataTransfer?.files?.length) actions.addFiles(event.dataTransfer.files);
}

function onDragOver(event) {
  event.preventDefault();
  dropActive.value = true;
}

function onDragLeave() {
  dropActive.value = false;
}

function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => actions.addFiles(input.files);
  input.click();
}

// ------------------------------------------------------------- 生命周期

let observer = null;

onMounted(() => {
  observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    size.value = { w: box.width, h: box.height };
    if (isFit.value) offset.value = centeredOffset();
    requestDraw();
  });
  observer.observe(stageEl.value);
  size.value = { w: stageEl.value.clientWidth, h: stageEl.value.clientHeight };
  fitToView();
  requestDraw();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});

watch(selected, () => {
  fitToView();
  hover.value = null;
  requestDraw();
});

watch([mode, showBox], () => {
  fitToView();
  requestDraw();
});

watch(
  () => [size.value.w, size.value.h, zoom.value, offset.value.x, offset.value.y, selected.value?.bounds?.x, selected.value?.bounds?.width, selected.value?.resultEmpty],
  () => requestDraw(),
  { flush: 'post' },
);

watch(
  () => state.theme,
  () => requestDraw(),
  { flush: 'post' },
);
</script>

<template>
  <section
    ref="stageEl"
    class="stage"
    :class="{ 'is-dragging': dragging, 'is-drop': dropActive }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
  >
    <canvas ref="canvasEl" class="stage-canvas" />

    <!-- Figma 风格选择框：1px 描边 + 8 个手柄 + 尺寸标签 -->
    <div v-if="frame" class="frame" :style="{ left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px` }">
      <span v-for="handle in handles" :key="handle" class="handle" :class="`is-${handle}`" />
      <span class="frame-label" :class="{ 'is-inside': frame.top < 26 }">
        {{ selected.bounds.width }} × {{ selected.bounds.height }}
      </span>
    </div>

    <div class="stage-toolbar">
      <SegmentedControl :model-value="mode" :options="MODES" size="sm" @update:model-value="actions.setView('mode', $event)" />
      <button
        v-if="mode === 'source'"
        class="btn is-ghost"
        :class="{ 'is-on': showBox }"
        type="button"
        @click="actions.setView('showBox', !showBox)"
      >
        <span class="dot" :class="{ 'is-on': showBox }" />显示裁剪框
      </button>
    </div>

    <div v-if="selected" class="stage-zoom">
      <button class="btn is-ghost is-icon" type="button" title="缩小" @click="setZoom(zoom / 1.25)">−</button>
      <button class="btn is-ghost zoom-value mono" type="button" title="点击适应窗口" @click="fitToView">
        {{ Math.round(zoom * 100) }}%
      </button>
      <button class="btn is-ghost is-icon" type="button" title="放大" @click="setZoom(zoom * 1.25)">＋</button>
      <span class="stage-zoom-sep" />
      <button class="btn is-ghost" type="button" @click="fitToView">适应</button>
      <button class="btn is-ghost" type="button" @click="setZoom(1)">1:1</button>
    </div>

    <div v-if="hover" class="stage-readout mono">
      x {{ hover.x }} · y {{ hover.y }}
      <span class="readout-sep" />
      RGBA {{ hover.r }},{{ hover.g }},{{ hover.b }}
      <span class="readout-alpha" :class="{ 'is-transparent': hover.a === 0 }">A {{ hover.a }}</span>
    </div>

    <div v-if="!selected" class="stage-empty">
      <div class="empty-card">
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
          <rect x="4.5" y="7.5" width="25" height="19" rx="2.5" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 3" />
          <path d="M12 20l4-4.5 3.5 4 2.5-2.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="13" cy="13.5" r="1.6" fill="currentColor" />
        </svg>
        <p class="empty-title">把图片拖到这里</p>
        <p class="empty-hint muted">支持 PNG / WebP / JPEG / AVIF · 也可以 Ctrl+V 粘贴</p>
        <div class="empty-actions">
          <button class="btn" type="button" @click="pickFiles">导入图片</button>
          <button class="btn is-primary" type="button" :disabled="state.busy" @click="actions.loadSamples()">载入示例</button>
        </div>
      </div>
    </div>

    <div v-if="selected && selected.resultEmpty" class="stage-warning">
      这张图片没有任何不透明像素，AABB 为空 —— 请调低透明阈值或检查素材。
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

.frame {
  position: absolute;
  border: 1.5px solid var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}

.handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #fff;
  border: 1.5px solid var(--accent);
  border-radius: 1px;
}

.handle.is-nw { left: -4px; top: -4px; }
.handle.is-n { left: calc(50% - 4px); top: -4px; }
.handle.is-ne { right: -4px; top: -4px; }
.handle.is-e { right: -4px; top: calc(50% - 4px); }
.handle.is-se { right: -4px; bottom: -4px; }
.handle.is-s { left: calc(50% - 4px); bottom: -4px; }
.handle.is-sw { left: -4px; bottom: -4px; }
.handle.is-w { left: -4px; top: calc(50% - 4px); }

.frame-label {
  position: absolute;
  left: 50%;
  bottom: -22px;
  transform: translateX(-50%);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-family: var(--mono);
  font-size: 10px;
  white-space: nowrap;
}

.frame-label.is-inside {
  bottom: auto;
  top: 4px;
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

.readout-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
}

.readout-alpha {
  color: var(--text-2);
}

.readout-alpha.is-transparent {
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
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--warn) 18%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  color: var(--text);
  font-size: 11px;
  pointer-events: none;
}
</style>
