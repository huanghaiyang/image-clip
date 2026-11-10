<script setup>
/**
 * 灰度着色舞台
 * ------------
 * 只负责展示 useGrayscale 生成的预览画布，并支持缩放/平移；
 * 所有像素计算都在 composable 里完成，舞台不碰像素。
 */
import { computed, nextTick, ref, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useGrayscale } from '../composables/useGrayscale.js';
import { useStageViewport } from '../composables/useStageViewport.js';

const { selected } = useWorkspace();
const { state, actions } = useGrayscale();
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
} = useStageViewport();

const item = computed(() => selected.value ?? null);
const panning = ref(false);
const previewInfo = ref(null);

function drawBase(preview) {
  const canvas = baseEl.value;
  if (!canvas || !preview) return;
  if (canvas.width !== preview.width || canvas.height !== preview.height) {
    canvas.width = preview.width;
    canvas.height = preview.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(preview.canvas, 0, 0);
}

async function refresh() {
  panning.value = false;
  const current = item.value;
  const preview = actions.ensurePreview();
  previewInfo.value = preview && current ? { preview, width: current.width, height: current.height } : null;
  if (!current || !preview) return;
  setImage(preview.width, preview.height);
  await nextTick();
  drawBase(preview);
}

watch([() => item.value?.id, () => state.version], refresh, { immediate: true });

// --------------------------------------------------------------- 画布平移

function onStagePointerDown(event) {
  if (!item.value || !isPanGesture(event)) return;
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
      <p>还没有可着色的素材</p>
      <p class="muted">从左侧选择图片，或把图片拖进窗口</p>
    </div>

    <template v-else>
      <div class="frame" :style="frameStyle">
        <canvas ref="baseEl" class="base" />
      </div>

      <div class="hud">
        <button class="hud-btn" type="button" title="缩小" @click="zoomOut">−</button>
        <span class="hud-zoom mono">{{ zoomPercent }}%</span>
        <button class="hud-btn" type="button" title="放大" @click="zoomIn">+</button>
        <button class="hud-btn is-text" type="button" title="适合窗口" @click="resetView">适合</button>
      </div>

      <div class="stage-hint muted">
        <span v-if="state.options.strength === 0">强度 0%：显示原图 · 拖动强度查看灰度效果</span>
        <span v-else>灰度 → {{ state.options.color.toUpperCase() }} · 强度 {{ state.options.strength }}%</span>
        <span v-if="previewInfo && previewInfo.preview.scale < 1">
          · 预览 {{ previewInfo.preview.width }}×{{ previewInfo.preview.height }}，导出按原图
          {{ previewInfo.width }}×{{ previewInfo.height }}
        </span>
        <span> · 空格 / 中键拖动平移</span>
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
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  color: #d7d7d7;
  font-size: 10px;
}
</style>
