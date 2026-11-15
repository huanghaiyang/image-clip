<script setup>
/**
 * 精灵图播放器（资源库预览用）
 * ---------------------------
 * 把一张精灵图按帧切出来循环播放：
 *  - 「自动分隔」按透明分隔线识别帧（detectSpriteGrid）；
 *  - 「网格」按列数 × 行数等分（buildGridFrames）；
 *  - 名称里带 sprite / 序列 / sheet / 帧 的图片会自动进入播放模式，
 *    其他图片也可以手动点「精灵图播放」。
 *
 * 帧数据从图片像素算出来，不依赖服务端；大图先缩到 2048 以内再分析，
 * 避免一次性占几十 MB 内存。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { buildGridFrames, detectSpriteGrid } from '../lib/sprite.js';

const props = defineProps({
  src: { type: String, default: '' },
  name: { type: String, default: '' },
});

const MAX_ANALYZE_SIDE = 2048;
const canvasEl = ref(null);

const loading = ref(false);
const error = ref('');
const image = ref(null); // { width, height, bitmap }
const mode = ref('auto'); // auto | grid
const columns = ref(4);
const rows = ref(4);
const frames = ref([]);
const index = ref(0);
const playing = ref(true);
const fps = ref(12);

const playingTicker = ref(0);
let rafId = 0;
let lastTick = 0;

const frameCount = computed(() => frames.value.length || 1);
const currentFrame = computed(() => frames.value[index.value] ?? null);
const canPlay = computed(() => frames.value.length > 1);

const NAME_HINT = /sprite|sheet|序列|帧序列|动画帧|_seq/i;
/** 名称里常直接写着网格，例如 `xxx-sprite-7x6.png`：优先按它切。 */
const NAME_GRID = /(\d{1,3})\s*[x×]\s*(\d{1,3})/i;

const autoHint = computed(() => NAME_HINT.test(props.name) && frames.value.length > 1);

watch(
  () => [props.src, props.name],
  () => {
    resetFrames();
    void load();
  },
  { immediate: true },
);

watch([mode, columns, rows], () => {
  if (!image.value) return;
  rebuildFrames();
});

watch(
  () => [index.value, currentFrame.value, image.value?.id],
  () => draw(),
  { flush: 'post' },
);

onBeforeUnmount(() => {
  stopPlayback();
  image.value?.bitmap?.close?.();
  image.value = null;
});

function resetFrames() {
  stopPlayback();
  frames.value = [];
  index.value = 0;
  error.value = '';
  playing.value = true;
}

async function load() {
  if (!props.src) return;
  loading.value = true;
  try {
    const response = await fetch(props.src, { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    image.value = { width: bitmap.width, height: bitmap.height, bitmap, id: Date.now() };
    // 分析用的小图（长边 ≤ 2048）
    const scale = Math.min(1, MAX_ANALYZE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const analyze = document.createElement('canvas');
    analyze.width = width;
    analyze.height = height;
    analyze.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const data = analyze.getContext('2d').getImageData(0, 0, width, height).data;
    const nameGrid = props.name.match(NAME_GRID);
    const detected = detectSpriteGrid(data, width, height, { alphaThreshold: 8 });
    if (nameGrid) {
      // 名称带 WxH（常见于导出命名）：直接按网格切，比透明分隔更贴合
      mode.value = 'grid';
      columns.value = Math.max(1, Math.min(128, Number(nameGrid[1])));
      rows.value = Math.max(1, Math.min(128, Number(nameGrid[2])));
      frames.value = buildGridFrames(bitmap.width, bitmap.height, columns.value, rows.value);
    } else if (detected && detected.frames.length > 1) {
      mode.value = 'auto';
      frames.value = detected.frames;
      columns.value = detected.columns;
      rows.value = detected.rows;
    } else {
      // 识别不到分隔线（例如帧紧贴）：按 4×4 网格起步，用户可自行改列/行
      mode.value = 'grid';
      columns.value = 4;
      rows.value = 4;
      frames.value = buildGridFrames(bitmap.width, bitmap.height, 4, 4);
    }
    index.value = 0;
    draw();
    startPlayback();
  } catch (err) {
    error.value = err.message || '精灵图加载失败';
  } finally {
    loading.value = false;
  }
}

function rebuildFrames() {
  if (!image.value) return;
  if (mode.value === 'grid') {
    frames.value = buildGridFrames(image.value.width, image.value.height, columns.value, rows.value);
  } else {
    // 重新走一遍检测需要像素数据，这里保持不变（用户可点「自动检测」重建）
    return;
  }
  index.value = Math.min(index.value, Math.max(0, frames.value.length - 1));
  draw();
}

function switchMode(next) {
  if (next === mode.value) return;
  if (next === 'grid') {
    mode.value = 'grid';
    frames.value = image.value ? buildGridFrames(image.value.width, image.value.height, columns.value, rows.value) : [];
    index.value = 0;
    draw();
    return;
  }
  void load();
}

function redetect() {
  if (!image.value) return;
  mode.value = 'auto';
  columns.value = 4;
  rows.value = 4;
  void load();
}

function draw() {
  const canvas = canvasEl.value;
  const current = image.value;
  const frame = frames.value[index.value];
  if (!canvas || !current || !frame) return;
  const maxWidth = 900;
  const maxHeight = Math.round(window.innerHeight * 0.62);
  const scale = Math.min(maxWidth / frame.width, maxHeight / frame.height, 6);
  const cssWidth = Math.max(1, Math.round(frame.width * scale));
  const cssHeight = Math.max(1, Math.round(frame.height * scale));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(current.bitmap, frame.x, frame.y, frame.width, frame.height, 0, 0, cssWidth, cssHeight);
}

function startPlayback() {
  stopPlayback();
  if (!canPlay.value) return;
  playing.value = true;
  lastTick = 0;
  const tick = (time) => {
    rafId = requestAnimationFrame(tick);
    if (!lastTick) lastTick = time;
    const interval = 1000 / Math.max(1, Number(fps.value) || 12);
    if (time - lastTick < interval) return;
    lastTick = time;
    index.value = (index.value + 1) % frames.value.length;
  };
  rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  lastTick = 0;
}

function togglePlay() {
  if (playing.value) {
    stopPlayback();
    playing.value = false;
  } else {
    startPlayback();
  }
}

function step(delta) {
  stopPlayback();
  playing.value = false;
  index.value = (index.value + delta + frames.value.length) % frames.value.length;
}
</script>

<template>
  <div class="sprite-player">
    <p v-if="error" class="sprite-error">{{ error }}</p>
    <p v-else-if="loading" class="sprite-loading muted">正在分析精灵图…</p>
    <canvas v-show="!error" ref="canvasEl" class="sprite-canvas"></canvas>

    <div class="sprite-controls">
      <button class="btn is-mini" type="button" :disabled="!canPlay" :title="playing ? '暂停' : '播放'" @click="togglePlay">
        {{ playing && canPlay ? '⏸' : '▶' }}
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="!canPlay" title="上一帧" @click="step(-1)">‹</button>
      <span class="sprite-count mono">{{ index + 1 }} / {{ frameCount }}</span>
      <button class="btn is-mini is-ghost" type="button" :disabled="!canPlay" title="下一帧" @click="step(1)">›</button>

      <label class="sprite-field">
        <span>FPS</span>
        <select v-model.number="fps" class="select">
          <option :value="6">6</option>
          <option :value="8">8</option>
          <option :value="12">12</option>
          <option :value="24">24</option>
          <option :value="30">30</option>
        </select>
      </label>

      <label class="sprite-field">
        <span>列</span>
        <input v-model.number="columns" class="text-input sprite-num" type="number" min="1" max="128" @change="mode = 'grid'" />
      </label>
      <label class="sprite-field">
        <span>行</span>
        <input v-model.number="rows" class="text-input sprite-num" type="number" min="1" max="128" @change="mode = 'grid'" />
      </label>
      <div class="sprite-mode">
        <button class="btn is-mini" type="button" :class="{ 'is-on': mode === 'auto' }" title="按透明分隔线切帧" @click="switchMode('auto')">
          自动分隔
        </button>
        <button class="btn is-mini" type="button" :class="{ 'is-on': mode === 'grid' }" title="按列数 × 行数等分" @click="switchMode('grid')">
          网格
        </button>
      </div>
      <button class="btn is-mini is-ghost" type="button" title="按透明分隔线重新识别帧" @click="redetect">重新识别</button>
      <span class="sprite-hint muted">
        {{ mode === 'auto' ? '自动分隔' : `网格 ${columns}×${rows}` }}
        <template v-if="autoHint"> · 名称含 sprite/序列</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.sprite-player {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-height: 0;
}

.sprite-canvas {
  display: block;
  max-width: 100%;
  background: repeating-conic-gradient(#1c1d21 0% 25%, #17181b 0% 50%) 50% / 16px 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  image-rendering: pixelated;
}

.sprite-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 10px;
}

.sprite-count {
  min-width: 56px;
  text-align: center;
  color: var(--text-2);
}

.sprite-field {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
}

.sprite-num {
  width: 44px;
  padding: 2px 4px;
  text-align: center;
}

.sprite-mode {
  display: flex;
  gap: 4px;
}

.sprite-hint {
  font-size: 9px;
}

.sprite-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger);
}
</style>
