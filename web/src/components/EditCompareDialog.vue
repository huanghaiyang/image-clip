<script setup>
/**
 * 图片编辑 · 前后对比（滑块 + 大面板）
 * ------------------------------------
 * 左边是「修改前」（选中的那一步 / 上一步），右边是「修改后」（最新一步）。
 * 拖动分界线或底部滑块即可擦除式对比；面板尽量大，方便看清楚细节。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useEditTimeline } from '../composables/useEditTimeline.js';

const { state, selectedStep, selectedIndex, actions } = useEditTimeline();

const percent = ref(50);
const stageEl = ref(null);
let dragging = false;

const before = computed(() => {
  const index = selectedIndex.value;
  if (index > 0) return state.entries[index - 1];
  return state.entries[0] ?? null;
});
const after = computed(() => state.entries[state.entries.length - 1] ?? null);
const label = computed(() => {
  const step = selectedStep.value;
  return step ? `第 ${selectedIndex.value + 1} 步 · ${step.label}` : '最新一步';
});

watch(
  () => state.compareOpen,
  (open) => {
    if (open) percent.value = 50;
  },
);

function onKeydown(event) {
  if (!state.compareOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    actions.closeCompare();
  } else if (event.key === 'ArrowLeft') {
    percent.value = Math.max(0, percent.value - 2);
  } else if (event.key === 'ArrowRight') {
    percent.value = Math.min(100, percent.value + 2);
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));

function setFromEvent(event) {
  const stage = stageEl.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  percent.value = Math.round((x / rect.width) * 100);
}

function onPointerDown(event) {
  dragging = true;
  stageEl.value?.setPointerCapture?.(event.pointerId);
  setFromEvent(event);
}

function onPointerMove(event) {
  if (!dragging) return;
  setFromEvent(event);
}

function onPointerUp(event) {
  dragging = false;
  stageEl.value?.releasePointerCapture?.(event.pointerId);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state.compareOpen" class="cmp-mask" @click.self="actions.closeCompare()">
      <div class="cmp-panel" role="dialog" aria-label="前后对比">
        <header class="cmp-head">
          <div class="cmp-title">
            前后对比
            <span class="cmp-sub muted">{{ label }}</span>
          </div>
          <div class="cmp-head-actions">
            <span class="cmp-legend"><i class="is-before"></i>修改前</span>
            <span class="cmp-legend"><i class="is-after"></i>修改后</span>
            <button class="cmp-close" type="button" title="关闭 (Esc)" @click="actions.closeCompare()">×</button>
          </div>
        </header>

        <div
          ref="stageEl"
          class="cmp-stage"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <img v-if="before?.thumb" class="cmp-img is-before" :src="before.thumb" alt="修改前" draggable="false" />
          <div v-else class="cmp-empty muted">还没有可对比的修改前状态</div>
          <div v-if="after?.thumb" class="cmp-after-clip" :style="{ clipPath: `inset(0 0 0 ${percent}%)` }">
            <img class="cmp-img is-after" :src="after.thumb" alt="修改后" draggable="false" />
          </div>
          <div class="cmp-handle" :style="{ left: `${percent}%` }"><span></span></div>
        </div>

        <footer class="cmp-foot">
          <span class="cmp-percent mono">{{ percent }}%</span>
          <input v-model.number="percent" class="cmp-range" type="range" min="0" max="100" step="1" aria-label="对比分界线" />
          <button class="btn is-mini is-ghost" type="button" @click="percent = 50">居中</button>
          <button class="btn is-mini" type="button" @click="actions.closeCompare()">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmp-mask {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(3px);
}

.cmp-panel {
  display: flex;
  flex-direction: column;
  width: min(1180px, 96vw);
  height: min(820px, 92vh);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}

.cmp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.cmp-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.cmp-sub {
  font-size: 10px;
}

.cmp-head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.cmp-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.cmp-legend i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.cmp-legend i.is-before {
  background: #f59e0b;
}

.cmp-legend i.is-after {
  background: #0d99ff;
}

.cmp-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}

.cmp-close:hover {
  background: var(--hover);
  color: var(--text);
}

.cmp-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: repeating-conic-gradient(#1c1d21 0% 25%, #17181b 0% 50%) 50% / 18px 18px;
  cursor: ew-resize;
  touch-action: none;
}

.cmp-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
}

.cmp-after-clip {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cmp-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}

.cmp-handle span {
  position: absolute;
  top: 50%;
  left: -9px;
  width: 18px;
  height: 18px;
  margin-top: -9px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
}

.cmp-empty {
  font-size: 11px;
}

.cmp-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.cmp-percent {
  width: 42px;
  text-align: right;
  font-size: 10px;
  color: var(--text-2);
}

.cmp-range {
  flex: 1;
  min-width: 0;
}
</style>
