<script setup>
/**
 * 图集裁切框尺寸编辑器
 * --------------------
 * - 自动：输出尺寸 = 最大 AABB（各帧裁剪后的最大宽高）；
 * - 固定尺寸：可手动调大，但**不允许小于最大 AABB**（拖到更小会自动吸附回下限）；
 * - 可视化：画布上拖动右下角把手调整，红色虚线是「最大 AABB」内容区，蓝色是输出框；
 * - 预设：快捷尺寸（最大 AABB / 正方形 / ×1.5 / ×2）+ 命名尺寸列表（保存 / 添加 / 应用 / 删除）。
 */
import { computed, reactive, ref, watch, watchEffect } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { resizeAtlasFrame } from '../lib/atlasFrame.js';

const { state, trimAtlas, atlasMinSize, atlasFrameSize, atlasQuickSizes, actions } = useWorkspace();

const W = 300;
const H = 190;
const PAD = 14;
const canvasEl = ref(null);
const custom = reactive({ name: '', width: 0, height: 0 });
const drag = ref(null);
const hoverHandle = ref('');

const mode = computed(() => state.atlasFrame.mode);
const min = computed(() => atlasMinSize.value);
const size = computed(() => atlasFrameSize.value);
const presets = computed(() => state.atlasSizePresets ?? []);

/** 画布缩放：以「输出框」为基准，留出内边距。 */
const scale = computed(() => {
  const frame = size.value;
  if (!frame) return 1;
  return Math.min((W - PAD * 2) / frame.width, (H - PAD * 2) / frame.height);
});

const frameRect = computed(() => {
  const frame = size.value;
  if (!frame) return null;
  const scaleValue = scale.value;
  const width = frame.width * scaleValue;
  const height = frame.height * scaleValue;
  return { x: (W - width) / 2, y: (H - height) / 2, width, height };
});

/** 8 个把手：四角 + 四条边中点（边只改一个方向，角同时改两个方向）。 */
const handles = computed(() => {
  const outer = frameRect.value;
  if (!outer) return [];
  const midX = outer.x + outer.width / 2;
  const midY = outer.y + outer.height / 2;
  const right = outer.x + outer.width;
  const bottom = outer.y + outer.height;
  return [
    { id: 'nw', x: outer.x, y: outer.y, cursor: 'nwse-resize' },
    { id: 'n', x: midX, y: outer.y, cursor: 'ns-resize' },
    { id: 'ne', x: right, y: outer.y, cursor: 'nesw-resize' },
    { id: 'e', x: right, y: midY, cursor: 'ew-resize' },
    { id: 'se', x: right, y: bottom, cursor: 'nwse-resize' },
    { id: 's', x: midX, y: bottom, cursor: 'ns-resize' },
    { id: 'sw', x: outer.x, y: bottom, cursor: 'nesw-resize' },
    { id: 'w', x: outer.x, y: midY, cursor: 'ew-resize' },
  ];
});

const activeHandle = computed(() => drag.value?.handle ?? hoverHandle.value);

const canvasCursor = computed(() => {
  if (drag.value) {
    return handles.value.find((item) => item.id === drag.value.handle)?.cursor ?? 'default';
  }
  return handles.value.find((item) => item.id === hoverHandle.value)?.cursor ?? 'default';
});

/** 内容区（最大 AABB）在输出框里等比居中。 */
const contentRect = computed(() => {
  const frame = size.value;
  const limit = min.value;
  const outer = frameRect.value;
  if (!frame || !limit || !outer) return null;
  const fit = Math.min(outer.width / limit.width, outer.height / limit.height);
  const width = limit.width * fit;
  const height = limit.height * fit;
  return { x: outer.x + (outer.width - width) / 2, y: outer.y + (outer.height - height) / 2, width, height };
});

watchEffect(() => {
  // 让悬停把手切换时也重绘
  void hoverHandle.value;
  void activeHandle.value;
  const canvas = canvasEl.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // 背景棋盘
  const cell = 10;
  for (let y = 0; y < H; y += cell) {
    for (let x = 0; x < W; x += cell) {
      ctx.fillStyle = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? '#1a1b1f' : '#22242a';
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const outer = frameRect.value;
  if (!outer) return;

  // 输出框
  ctx.fillStyle = 'rgba(13, 153, 255, 0.12)';
  ctx.fillRect(outer.x, outer.y, outer.width, outer.height);
  ctx.strokeStyle = '#0d99ff';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(outer.x + 0.5, outer.y + 0.5, outer.width - 1, outer.height - 1);

  // 内容区（最大 AABB）
  const content = contentRect.value;
  if (content) {
    ctx.strokeStyle = 'rgba(255, 90, 90, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(content.x + 0.5, content.y + 0.5, content.width - 1, content.height - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 90, 90, 0.35)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText('最大 AABB', content.x + 4, content.y - 4);
  }

  // 8 个把手：四角 + 边中点；悬停/拖动时放大高亮
  for (const item of handles.value) {
    const active = item.id === activeHandle.value;
    const radius = active ? 5.5 : 3.5;
    ctx.beginPath();
    ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#7cc7ff' : '#0d99ff';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // 尺寸文字
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`${size.value.width}×${size.value.height}`, 8, H - 8);
});

/** 拖拽把手：只允许变大，小于最大 AABB 时自动吸附回下限。 */
function pixelFromEvent(event) {
  const canvas = canvasEl.value;
  const rect = canvas.getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * W, y: ((event.clientY - rect.top) / rect.height) * H };
}

/** 命中检测：返回最近的把手（半径 12 个画布像素）。 */
function handleAt(point) {
  let best = null;
  let bestDistance = 12;
  for (const item of handles.value) {
    const distance = Math.hypot(point.x - item.x, point.y - item.y);
    if (distance <= bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

function onPointerDown(event) {
  const point = pixelFromEvent(event);
  const handle = handleAt(point);
  if (!handle) return;
  drag.value = {
    handle: handle.id,
    start: { ...size.value },
    point,
    // 缩放冻结在按下时：拖动过程中尺寸变化不会改变光标→尺寸的映射
    scale: scale.value,
  };
  hoverHandle.value = handle.id;
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function onPointerMove(event) {
  const point = pixelFromEvent(event);
  if (!drag.value) {
    hoverHandle.value = handleAt(point)?.id ?? '';
    return;
  }
  const next = resizeAtlasFrame({
    start: drag.value.start,
    dx: point.x - drag.value.point.x,
    dy: point.y - drag.value.point.y,
    scale: drag.value.scale,
    handle: drag.value.handle,
  });
  actions.setAtlasFrameSize(next);
}

function onPointerUp(event) {
  drag.value = null;
  hoverHandle.value = '';
  event.currentTarget.releasePointerCapture?.(event.pointerId);
}

function onPointerLeave() {
  if (!drag.value) hoverHandle.value = '';
}

function applyMode(next) {
  actions.setAtlasFrameMode(next);
}

function applySizeInput(key, event) {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  actions.setAtlasFrameSize({ width: key === 'width' ? value : size.value?.width, height: key === 'height' ? value : size.value?.height });
}

watch(
  () => size.value && `${size.value.width}x${size.value.height}`,
  () => {
    custom.width = size.value?.width ?? 0;
    custom.height = size.value?.height ?? 0;
  },
  { immediate: true },
);

function savePreset() {
  actions.saveAtlasSizePreset(custom.name);
  custom.name = '';
}

function addPreset() {
  actions.addAtlasSizePreset({ name: custom.name, width: custom.width, height: custom.height });
  custom.name = '';
}
</script>

<template>
  <div v-if="trimAtlas" class="afe">
    <div class="afe-head">
      <span class="afe-title">裁切框 / 输出尺寸</span>
      <div class="afe-modes">
        <button class="btn is-mini" type="button" :class="{ 'is-primary': mode === 'auto' }" @click="applyMode('auto')">自动</button>
        <button class="btn is-mini" type="button" :class="{ 'is-primary': mode === 'custom' }" @click="applyMode('custom')">固定尺寸</button>
      </div>
    </div>

    <canvas
      ref="canvasEl"
      class="afe-canvas"
      :style="{ width: `${W}px`, height: `${H}px`, cursor: canvasCursor }"
      title="拖四角同时调宽高；拖左右边只调宽；拖上下边只调高（不能小于红色虚线的最大 AABB）"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
    />

    <div class="afe-fields">
      <label>
        <span>宽</span>
        <input class="text-input" type="number" min="1" :value="size?.width" @change="applySizeInput('width', $event)" />
      </label>
      <label>
        <span>高</span>
        <input class="text-input" type="number" min="1" :value="size?.height" @change="applySizeInput('height', $event)" />
      </label>
      <span class="afe-min muted mono">最小 {{ min?.width }}×{{ min?.height }}</span>
    </div>
    <p class="afe-note muted">
      拖<b>四角</b>同时调宽高；拖<b>左右边</b>只调宽；拖<b>上下边</b>只调高。只能大于或等于最大 AABB（红色虚线），
      多出的区域为透明边，内容等比居中不拉伸。
    </p>

    <div class="afe-quick">
      <button
        v-for="item in atlasQuickSizes"
        :key="item.id"
        class="btn is-mini is-ghost"
        type="button"
        :disabled="size && size.width === item.width && size.height === item.height"
        @click="actions.setAtlasFrameSize({ width: item.width, height: item.height })"
      >
        {{ item.label }}（{{ item.width }}×{{ item.height }}）
      </button>
    </div>

    <div class="afe-preset-add">
      <input v-model="custom.name" class="text-input" maxlength="40" placeholder="尺寸命名（可空）" />
      <button class="btn is-mini is-ghost" type="button" @click="savePreset">保存当前尺寸</button>
      <button class="btn is-mini" type="button" @click="addPreset">添加尺寸</button>
    </div>

    <div v-if="presets.length" class="afe-list">
      <div v-for="preset in presets" :key="preset.id" class="afe-item" :class="{ 'is-active': size && preset.width <= size.width && preset.height <= size.height }">
        <span class="afe-item-name">{{ preset.name }}</span>
        <span class="afe-item-size mono">{{ preset.width }}×{{ preset.height }}</span>
        <button class="btn is-mini is-ghost" type="button" @click="actions.applyAtlasSizePreset(preset.id)">应用</button>
        <button class="btn is-mini is-ghost is-danger" type="button" title="删除" @click="actions.deleteAtlasSizePreset(preset.id)">×</button>
      </div>
    </div>
    <p v-else class="afe-note muted">还没有命名尺寸：调整好尺寸后点「保存当前尺寸」，或填名字后「添加尺寸」。</p>
  </div>
</template>

<style scoped>
.afe {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
}

.afe-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.afe-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
}

.afe-modes {
  display: flex;
  gap: 4px;
}

.afe-canvas {
  display: block;
  width: 300px;
  max-width: 100%;
  height: 190px;
  margin: 0 auto;
  border-radius: 5px;
  touch-action: none;
}

.afe-fields {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin-top: 8px;
}

.afe-fields label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 84px;
  font-size: 9px;
  color: var(--text-muted);
}

.afe-min {
  margin-left: auto;
  font-size: 9px;
}

.afe-note {
  margin: 6px 0 0;
  font-size: 9px;
  line-height: 1.5;
}

.afe-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.afe-preset-add {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}

.afe-preset-add .text-input {
  flex: 1;
  min-width: 0;
}

.afe-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 8px;
  max-height: 150px;
  overflow-y: auto;
}

.afe-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 10px;
}

.afe-item:hover {
  background: var(--hover);
}

.afe-item.is-active {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

.afe-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.afe-item-size {
  flex: none;
  font-size: 9px;
  color: var(--text-muted);
}
</style>
