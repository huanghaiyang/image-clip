<script setup>
/**
 * 精灵图舞台
 * ----------
 * 上下两块：
 *  - 上：动画预览（按当前帧矩形从源图裁绘，FPS 由右侧面板控制）
 *  - 下：整图切分（原图 + 半透明帧框，点击格子选中该帧）
 *
 * 帧只保存矩形，因此切法变化时不需要重新生成任何位图。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useSprite } from '../composables/useSprite.js';

const { selected } = useWorkspace();
const { state, source, frames, currentFrame, actions } = useSprite();

const playbackEl = ref(null);
const sheetBody = ref(null);
const sheetUrl = ref('');
const box = ref({ width: 0, height: 0 });
let observer = null;

const item = computed(() => selected.value ?? null);

/** 整图按容器等比缩放后的显示尺寸（帧框用百分比叠加，必须和显示尺寸一致）。 */
const display = computed(() => {
  const { width, height } = box.value;
  if (!state.width || !state.height || !width || !height) return { width: 0, height: 0 };
  const scale = Math.min(width / state.width, height / state.height);
  return {
    width: Math.max(1, Math.round(state.width * scale)),
    height: Math.max(1, Math.round(state.height * scale)),
  };
});

function observeSheet(el) {
  observer?.disconnect();
  observer = null;
  if (!el) return;
  observer = new ResizeObserver((entries) => {
    const rect = entries[0].contentRect;
    box.value = { width: rect.width, height: rect.height };
  });
  observer.observe(el);
}

/** 把整张 sprite 图转成 blob URL，供下方 <img> 显示（帧框按百分比叠在上面）。 */
function buildSheetUrl() {
  const src = source.value;
  if (!src) return;
  const canvas = document.createElement('canvas');
  canvas.width = state.width;
  canvas.height = state.height;
  canvas.getContext('2d').drawImage(src.bitmap, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    if (sheetUrl.value) URL.revokeObjectURL(sheetUrl.value);
    sheetUrl.value = URL.createObjectURL(blob);
  }, 'image/png');
}

function drawPlayback() {
  const canvas = playbackEl.value;
  const frame = currentFrame.value;
  const src = source.value;
  if (!canvas || !frame || !src) return;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, frame.width, frame.height);
  ctx.drawImage(src.bitmap, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
}

watch(
  () => source.value,
  async () => {
    await nextTick();
    observeSheet(sheetBody.value);
    buildSheetUrl();
    drawPlayback();
  },
  { flush: 'post', immediate: true },
);

watch(currentFrame, drawPlayback, { flush: 'post' });

function cellStyle(frame) {
  return {
    left: `${(frame.x / state.width) * 100}%`,
    top: `${(frame.y / state.height) * 100}%`,
    width: `${(frame.width / state.width) * 100}%`,
    height: `${(frame.height / state.height) * 100}%`,
  };
}

onBeforeUnmount(() => {
  actions.pause();
  observer?.disconnect();
  if (sheetUrl.value) URL.revokeObjectURL(sheetUrl.value);
});
</script>

<template>
  <section class="stage sprite-stage">
    <div v-if="!source" class="stage-empty">
      <p>还没有载入 sprite 图</p>
      <p class="muted">从左侧选择一张图片，或在右侧面板点「导入 sprite 图」</p>
    </div>

    <template v-else>
      <div class="pane anim-pane">
        <div class="pane-head">
          <span>动画预览</span>
          <span class="pane-meta mono">
            {{ state.selected + 1 }} / {{ frames.length || 0 }} · {{ state.fps }} FPS
            <template v-if="currentFrame">
              · {{ currentFrame.width }}×{{ currentFrame.height }}
            </template>
          </span>
        </div>
        <div class="anim-body">
          <canvas ref="playbackEl" class="playback" />
        </div>
      </div>

      <div class="pane sheet-pane">
        <div class="pane-head">
          <span>整图切分</span>
          <span class="pane-meta mono">{{ state.width }} × {{ state.height }} · {{ frames.length }} 帧</span>
        </div>
        <div ref="sheetBody" class="sheet-body">
          <div v-if="display.width" class="sheet-frame" :style="{ width: `${display.width}px`, height: `${display.height}px` }">
            <img :src="sheetUrl" alt="sprite sheet" draggable="false" />
            <button
              v-for="(frame, index) in frames"
              :key="index"
              class="sheet-cell"
              :class="{ 'is-active': index === state.selected }"
              type="button"
              :style="cellStyle(frame)"
              :title="`第 ${index + 1} 帧 · ${frame.width} × ${frame.height}`"
              @click="actions.select(index)"
            />
          </div>
        </div>
      </div>

      <div class="stage-hint muted">
        <template v-if="item">点击下方格子选中帧 · 空格播放/暂停 · ←/→ 逐帧</template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sprite-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-canvas);
}

.stage-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  text-align: center;
}

.stage-empty p {
  margin: 4px 0;
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.anim-pane {
  flex: 1;
  border-bottom: 1px solid var(--border);
}

.sheet-pane {
  flex: none;
  height: 42%;
}

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  height: 30px;
  padding: 0 12px;
  color: var(--text-2);
  font-size: 11px;
  border-bottom: 1px solid var(--border);
}

.pane-meta {
  overflow: hidden;
  color: var(--text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.anim-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-color: var(--checker-a);
}

.playback {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.35));
}

.sheet-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: var(--panel);
}

.sheet-frame {
  position: relative;
  line-height: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.sheet-frame img {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}

.sheet-cell {
  position: absolute;
  padding: 0;
  border: 1px dashed rgba(255, 255, 255, 0.28);
  background: transparent;
  cursor: pointer;
}

.sheet-cell:hover {
  border-color: rgba(255, 255, 255, 0.7);
  background: rgba(255, 255, 255, 0.08);
}

.sheet-cell.is-active {
  border: 2px solid var(--accent);
  background: rgba(120, 170, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.stage-hint {
  position: absolute;
  left: 12px;
  bottom: 10px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.45);
  font-size: 11px;
  pointer-events: none;
}
</style>
