<script setup>
/**
 * 合成工作室 · 舞台
 * -----------------
 * 中间画布 = 文档渲染结果（预览最长边 1600px），叠加层画：
 *  - 当前图层包围盒（8 个手柄只是提示，缩放走 Shift 拖动、旋转走 Alt 拖动）；
 *  - 选区（按掩膜填一层半透明色 + 虚线包围盒）；
 *  - 播放时的帧号与时间。
 * 所有像素来自 useStudio 的预览缓存，舞台不重复渲染。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useStudio } from '../composables/useStudio.js';
import { useStageViewport } from '../composables/useStageViewport.js';
import { layerBounds, findLayer } from '@shared/compose/doc.js';
import { maskBounds } from '@shared/maskops.js';

const { state, actions, computed: studioComputed } = useStudio();
const workspace = useWorkspace();
const {
  container,
  baseEl,
  view,
  frameStyle,
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
const tool = ref('move'); // move | wand
const panning = ref(false);
const dragging = ref(null);
const lastDocId = ref('');

const doc = computed(() => state.doc);
const scale = computed(() => studioComputed.previewScale.value);
const activeLayer = computed(() => findLayer(state.doc, state.activeLayerId));
const activeBounds = computed(() => (activeLayer.value ? layerBounds(activeLayer.value, actions.sampleFor?.(activeLayer.value) ?? null) : null));

function drawBase(preview) {
  const canvas = baseEl.value;
  if (!canvas || !preview) return;
  if (canvas.width !== preview.width || canvas.height !== preview.height) {
    canvas.width = preview.width;
    canvas.height = preview.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(preview, 0, 0);
}

/** 选区掩膜 → 舞台尺寸的半透明覆盖层。 */
function selectionCanvas(mask, width, height) {
  if (!mask) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / height));
    for (let x = 0; x < width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / width));
      const i = (y * width + x) * 4;
      data[i] = 90;
      data[i + 1] = 170;
      data[i + 2] = 255;
      data[i + 3] = Math.round(mask.data[my * mask.width + mx] * 0.22);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function drawOverlay() {
  const canvas = overlayEl.value;
  const host = container.value;
  if (!canvas || !host) return;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const origin = frameOrigin();
  if (!origin || !doc.value) return;

  const s = origin.width / doc.value.width;

  // 选区覆盖
  if (state.selection.mask && state.selection.layerId === state.activeLayerId) {
    const overlay = selectionCanvas(state.selection.mask, Math.round(doc.value.width * s), Math.round(doc.value.height * s));
    if (overlay) ctx.drawImage(overlay, origin.x, origin.y);
    const box = maskBounds(state.selection.mask, 8);
    if (box) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 190, 255, 0.95)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(origin.x + box.x * s, origin.y + box.y * s, box.width * s, box.height * s);
      ctx.restore();
    }
  }

  // 图层包围盒
  const bounds = activeBounds.value;
  if (!bounds) return;
  const x = origin.x + bounds.x * s;
  const y = origin.y + bounds.y * s;
  const w = bounds.width * s;
  const h = bounds.height * s;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 170, 40, 0.95)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255, 170, 40, 0.95)';
  const handles = [
    [x, y],
    [x + w / 2, y],
    [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h],
    [x + w / 2, y + h],
    [x, y + h],
    [x, y + h / 2],
  ];
  for (const [hx, hy] of handles) ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
  ctx.restore();

  if (doc.value) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(origin.x, origin.y - 18, 150, 16);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillText(`${doc.value.width}×${doc.value.height} · ${doc.value.layers.length}L`, origin.x + 5, origin.y - 7);
    ctx.restore();
  }
}

let refreshScheduled = false;
function refresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  nextTick(() => {
    refreshScheduled = false;
    const preview = actions.renderPreview();
    if (!preview) return;
    const docId = state.doc?.id ?? '';
    setImage(preview.width, preview.height, { reset: docId !== lastDocId.value });
    lastDocId.value = docId;
    drawBase(preview);
    drawOverlay();
  });
}

watch(
  () => [state.version, state.time, state.doc?.id, state.activeLayerId, state.selection.mask],
  refresh,
  { immediate: true },
);
watch([() => view.zoom, () => view.panX, () => view.panY, () => view.containerWidth, () => view.containerHeight], drawOverlay);
watch(doc, () => refresh());

function docPoint(event) {
  const point = toImage(event);
  if (!point) return null;
  return { x: point.x / scale.value, y: point.y / scale.value };
}

function onPointerDown(event) {
  if (!doc.value) return;
  if (isPanGesture(event)) {
    event.preventDefault();
    beginPan(event);
    panning.value = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  const point = docPoint(event);
  if (!point) return;
  if (tool.value === 'wand') {
    actions.wandAt(point.x, point.y);
    return;
  }
  const layer = actions.pickLayerAt(point.x, point.y);
  if (!layer) return;
  dragging.value = {
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
    ox: layer.transform.x,
    oy: layer.transform.y,
    osx: layer.transform.scaleX,
    osy: layer.transform.scaleY,
    orot: layer.transform.rotation,
    cx: point.x - layer.transform.x,
    cy: point.y - layer.transform.y,
  };
  actions.record?.('移动图层');
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  if (panning.value) {
    movePan(event);
    return;
  }
  const drag = dragging.value;
  const layer = activeLayer.value;
  if (!drag || !layer) return;
  const point = docPoint(event);
  if (!point) return;
  if (event.altKey) {
    const angle = Math.atan2(point.y - drag.cy - drag.oy, point.x - drag.cx - drag.ox);
    layer.transform.rotation = Math.round((angle * 180) / Math.PI);
  } else if (event.shiftKey) {
    const dx = (point.x - drag.startX) / Math.max(1, layer.width);
    const dy = (point.y - drag.startY) / Math.max(1, layer.height);
    const factor = Math.max(0.05, 1 + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
    layer.transform.scaleX = drag.osx * factor;
    layer.transform.scaleY = drag.osy * factor;
  } else {
    layer.transform.x = Math.round(drag.ox + (point.x - drag.startX));
    layer.transform.y = Math.round(drag.oy + (point.y - drag.startY));
  }
  state.version += 1;
}

function onPointerUp(event) {
  if (panning.value) {
    panning.value = false;
    endPan();
  }
  if (dragging.value) {
    // 拖动结束：有轨道的属性写入当前时间的关键帧，并提交一步历史
    actions.commitTransformKeys();
    dragging.value = null;
  }
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

function onWheel(event) {
  if (!doc.value) return;
  zoomAt(event, event.deltaY < 0 ? 1.1 : 1 / 1.1);
}

function buildFromSelection() {
  const list = workspace.checkedItems.value.length ? workspace.checkedItems.value : [workspace.selected.value].filter(Boolean);
  actions.buildFromItems(list, { replace: true });
}

function setTool(next) {
  tool.value = next;
}

onMounted(() => {
  actions.syncItems();
  if (!state.doc) buildFromSelection();
});

onBeforeUnmount(() => {
  actions.stopPlay();
});
</script>

<template>
  <section
    ref="container"
    class="stage studio-stage"
    :class="{ 'is-pan-ready': spaceHeld, 'is-panning': panning, 'is-wand': tool === 'wand' }"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div v-if="!doc" class="stage-empty">
      <p>还没有合成文档</p>
      <p class="muted">从左侧选择（可多选）图片，然后建立合成</p>
      <button class="btn is-primary is-mini mt-8" type="button" @click="buildFromSelection">用选中素材建立合成</button>
    </div>

    <template v-else>
      <div class="frame" :style="frameStyle">
        <canvas ref="baseEl" class="base" />
      </div>
      <canvas ref="overlayEl" class="overlay" />

      <div class="stage-toolbar">
        <button
          class="hud-btn"
          type="button"
          :class="{ 'is-on': tool === 'move' }"
          title="移动 / 拖动图层（Shift 缩放，Alt 旋转）"
          @click="setTool('move')"
        >
          移动
        </button>
        <button
          class="hud-btn"
          type="button"
          :class="{ 'is-on': tool === 'wand' }"
          title="魔棒：点击取色并建立选区"
          @click="setTool('wand')"
        >
          魔棒
        </button>
        <span class="tool-sep" />
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
        <span class="tool-sep" />
        <button class="hud-btn is-text" type="button" :title="state.playing ? '暂停' : '播放'" @click="actions.togglePlay()">
          {{ state.playing ? '暂停' : '播放' }}
        </button>
        <span class="hud-zoom mono">{{ state.time.toFixed(2) }}s</span>
      </div>

      <div class="stage-hint muted">
        <span>{{ activeLayer ? activeLayer.name : '未选中图层' }}</span>
        <span> · 拖动移动 · Shift 缩放 · Alt 旋转 · 空格/中键平移</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.studio-stage {
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

.mt-8 {
  margin-top: 8px;
}

.frame {
  position: relative;
  flex: none;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 10px 36px rgba(0, 0, 0, 0.4);
}

.base {
  display: block;
  width: 100%;
  height: 100%;
}

.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.studio-stage.is-pan-ready {
  cursor: grab;
}

.studio-stage.is-panning {
  cursor: grabbing;
}

.studio-stage.is-wand {
  cursor: crosshair;
}

.stage-toolbar {
  position: absolute;
  left: 12px;
  bottom: 34px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.62);
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
}

.hud-btn.is-text {
  padding: 0 8px;
}

.hud-zoom {
  min-width: 44px;
  text-align: center;
  font-size: 11px;
}

.tool-sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: rgba(255, 255, 255, 0.22);
}

.stage-hint {
  position: absolute;
  bottom: 10px;
  left: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  color: #d7d7d7;
  font-size: 10px;
}
</style>
