<script setup>
/**
 * 音频工作区中央舞台
 * ------------------
 * 一块 canvas 同时承担三件事：
 *  1. 频谱图：解码后离线 FFT 得到的「时间 × 频段」热力图；
 *  2. 波形：峰值降采样后的包络，便于看清静音段与音量变化；
 *  3. 时间轴交互：单击定位播放头，横向拖动框选保留区间。
 *
 * 播放头来自 useAudio 的 state.playhead（由 AudioContext 时钟推算），
 * 播放过程中每帧都会更新，watch 触发重绘即可。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useAudio } from '../composables/useAudio.js';
import { formatAudioClock, formatAudioTime } from '../lib/audio.js';

const { state, duration, hasAudio, hasSelection, selectionLength, actions } = useAudio();

const canvasEl = ref(null);
const wrapEl = ref(null);

const dragging = ref(false);
const dragAnchor = ref(0);
const dragMoved = ref(false);

/** 离屏频谱画布：只在解码/裁剪后重建一次，重绘时缩放贴图。 */
const spectrogramCanvas = document.createElement('canvas');
let heatLut = null;
let resizeObserver = null;

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const ticks = computed(() => {
  const total = duration.value;
  if (!(total > 0)) return [];
  const step = TICK_STEPS.find((candidate) => total / candidate <= 11) ?? 600;
  const list = [];
  const count = Math.floor(total / step + 1e-6);
  for (let index = 0; index <= count; index += 1) {
    const time = Math.min(total, index * step);
    list.push({ time, left: (time / total) * 100, label: step < 1 ? `${time.toFixed(1)}s` : formatAudioClock(time) });
  }
  const last = list[list.length - 1];
  if (last && total - last.time > 0.01) list.push({ time: total, left: 100, label: formatAudioClock(total) });
  return list;
});

function tickStyle(tick) {
  const shift = tick.left <= 0.5 ? '0' : tick.left >= 99.5 ? '-100%' : '-50%';
  return { left: `${tick.left}%`, transform: `translateX(${shift})` };
}

/** 频谱热力色阶：深蓝 → 品牌蓝 → 青 → 暖黄。 */
function buildHeatLut() {
  const stops = [
    [8, 12, 20],
    [16, 50, 92],
    [13, 153, 255],
    [110, 231, 220],
    [255, 208, 92],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const pos = (i / 255) * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(pos));
    const ratio = pos - index;
    for (let c = 0; c < 3; c += 1) {
      lut[i * 3 + c] = Math.round(stops[index][c] + (stops[index + 1][c] - stops[index][c]) * ratio);
    }
  }
  heatLut = lut;
}

function buildSpectrogramCanvas() {
  const spec = state.spectrum;
  if (!spec) {
    spectrogramCanvas.width = 0;
    spectrogramCanvas.height = 0;
    return;
  }
  if (!heatLut) buildHeatLut();
  spectrogramCanvas.width = spec.columns;
  spectrogramCanvas.height = spec.bands;
  const ctx = spectrogramCanvas.getContext('2d');
  const image = ctx.createImageData(spec.columns, spec.bands);
  for (let col = 0; col < spec.columns; col += 1) {
    for (let band = 0; band < spec.bands; band += 1) {
      const value = spec.data[col * spec.bands + band];
      // 低频放底部：band 0 对应最后一行
      const y = spec.bands - 1 - band;
      const offset = (y * spec.columns + col) * 4;
      image.data[offset] = heatLut[value * 3];
      image.data[offset + 1] = heatLut[value * 3 + 1];
      image.data[offset + 2] = heatLut[value * 3 + 2];
      image.data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function draw() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // 频谱和波形在浅色主题下也保持深色底，避免细线条看不见
  ctx.fillStyle = '#0b1018';
  ctx.fillRect(0, 0, width, height);

  const total = duration.value;
  if (!(total > 0)) return;

  const spectrogramHeight = Math.round(height * 0.7);
  if (spectrogramCanvas.width) {
    ctx.globalAlpha = 0.96;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(spectrogramCanvas, 0, 0, width, spectrogramHeight);
    ctx.globalAlpha = 1;
  }

  // 波形区：底部约 28%，以中线为 0
  const waveformTop = spectrogramHeight;
  const waveformHeight = height - waveformTop;
  const centerY = waveformTop + waveformHeight / 2;
  const amplitude = waveformHeight * 0.42;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  const waveform = state.waveform;
  if (waveform) {
    const buckets = waveform.min.length;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const index = Math.min(buckets - 1, Math.floor((x / width) * buckets));
      ctx.lineTo(x, centerY - waveform.max[index] * amplitude);
    }
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = Math.min(buckets - 1, Math.floor((x / width) * buckets));
      ctx.lineTo(x, centerY - waveform.min[index] * amplitude);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(13, 153, 255, 0.55)';
    ctx.fill();
  }

  // 选区
  const start = state.selection.start;
  const end = state.selection.end;
  if (end - start > 0) {
    const x0 = (start / total) * width;
    const x1 = (end / total) * width;
    ctx.fillStyle = 'rgba(13, 153, 255, 0.16)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    ctx.strokeStyle = 'rgba(13, 153, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0);
    ctx.lineTo(x0 + 0.5, height);
    ctx.moveTo(x1 - 0.5, 0);
    ctx.lineTo(x1 - 0.5, height);
    ctx.stroke();
  }

  // 播放头
  const playheadX = Math.min(width - 1, Math.max(0, (state.playhead / total) * width));
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(playheadX + 0.5, 0);
  ctx.lineTo(playheadX + 0.5, height);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(playheadX, 5, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

// --------------------------------------------------------------- 时间轴交互

function ratioAt(event) {
  const canvas = canvasEl.value;
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function timeAt(event) {
  return ratioAt(event) * duration.value;
}

function onPointerDown(event) {
  if (!hasAudio.value || !(duration.value > 0) || event.button !== 0) return;
  dragging.value = true;
  dragMoved.value = false;
  dragAnchor.value = timeAt(event);
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    /* 指针捕获失败不影响后续松手判定 */
  }
  event.preventDefault();
}

function onPointerMove(event) {
  if (!dragging.value) return;
  const time = timeAt(event);
  if (Math.abs(time - dragAnchor.value) > duration.value / 500) dragMoved.value = true;
  if (!dragMoved.value) return;
  actions.setSelection(dragAnchor.value, time);
}

function onPointerUp(event) {
  if (!dragging.value) return;
  dragging.value = false;
  try {
    event.currentTarget.releasePointerCapture(event.pointerId);
  } catch {
    /* 浏览器可能已自动释放 */
  }
  if (dragMoved.value) {
    // 选区拖到末尾时指针可能已移出画布，用最终位置再收一次
    actions.setSelection(dragAnchor.value, timeAt(event));
    return;
  }
  // 单击 = 定位播放头，并清空选区
  actions.clearSelection();
  actions.seek(dragAnchor.value);
}

// --------------------------------------------------------------- 生命周期

watch(
  () => state.spectrum,
  () => {
    buildSpectrogramCanvas();
    draw();
  },
);

watch(
  () => [state.activePath, state.duration, state.selection.start, state.selection.end, state.playhead],
  () => draw(),
);

onMounted(() => {
  buildSpectrogramCanvas();
  draw();
  if (wrapEl.value) {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(wrapEl.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <section class="stage">
    <div ref="wrapEl" class="canvas-zone">
      <canvas
        ref="canvasEl"
        class="timeline-canvas"
        :class="{ 'is-disabled': !hasAudio }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />

      <div v-if="!state.activePath" class="stage-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 13v-2M7 16V8M10 18V6M13 15V9M16 17V7M19 12v0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <p class="empty-title">从左侧选择音频，或在资源库中双击音频</p>
        <p class="empty-hint muted">音频需要先进入资源库；也可以在视频工作区提取音轨后再编辑。</p>
      </div>

      <p v-else-if="state.loading" class="stage-hint">正在解码音频…</p>
      <p v-if="state.error" class="stage-banner">{{ state.error }}</p>
    </div>

    <div class="ticks">
      <span v-for="tick in ticks" :key="tick.time" class="tick mono" :style="tickStyle(tick)">{{ tick.label }}</span>
    </div>

    <footer class="controls">
      <div class="control-row">
        <button
          class="btn is-ghost is-icon"
          type="button"
          :disabled="!hasAudio"
          :title="state.playing ? '暂停（空格）' : '播放（空格）'"
          @click="actions.togglePlay()"
        >
          <svg v-if="state.playing" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4.5" y="3" width="2.4" height="10" rx="0.6" fill="currentColor" />
            <rect x="9.1" y="3" width="2.4" height="10" rx="0.6" fill="currentColor" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 3.4l7 4.6-7 4.6z" fill="currentColor" />
          </svg>
        </button>

        <button class="btn is-ghost is-icon" type="button" :disabled="!hasAudio" title="停止并回到起点" @click="actions.stop()">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </button>

        <button class="btn is-ghost is-icon" type="button" :disabled="!hasAudio" title="后退 5 秒" @click="actions.stepTime(-5)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10.5 3.5L5 8l5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M3.6 3.5v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>

        <button class="btn is-ghost is-icon" type="button" :disabled="!hasAudio" title="前进 5 秒" @click="actions.stepTime(5)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.5 3.5L11 8l-5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M12.4 3.5v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>

        <span class="timecode mono">{{ formatAudioTime(state.playhead) }}</span>
        <span class="duration muted mono">/ {{ formatAudioTime(duration) }}</span>

        <span
          v-if="hasSelection"
          class="selection-chip mono"
          :title="`${formatAudioTime(state.selection.start)} – ${formatAudioTime(state.selection.end)}`"
        >
          选区 {{ selectionLength.toFixed(2) }}s
        </span>
        <span v-else class="selection-hint muted">拖动选择区间</span>

        <span class="flex-spacer" />

        <button
          class="btn is-ghost is-mini"
          type="button"
          :class="{ 'is-on': state.loopSelection }"
          :disabled="!hasSelection"
          title="循环播放选区"
          @click="actions.setLoopSelection(!state.loopSelection)"
        >
          循环选区
        </button>

        <div class="volume">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 6h2.2L8.4 3.6v8.8L5.2 10H3z" fill="currentColor" stroke="currentColor" stroke-width="1" />
            <path d="M10.6 5.4a3.6 3.6 0 0 1 0 5.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <input
            class="volume-range"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="state.volume"
            :disabled="!hasAudio"
            title="音量"
            @input="actions.setVolume(Number($event.target.value))"
          />
        </div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
}

.canvas-zone {
  position: relative;
  flex: 1;
  min-height: 120px;
  padding: 10px 12px 0;
  overflow: hidden;
}

.timeline-canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}

.timeline-canvas.is-disabled {
  cursor: default;
}

.stage-empty {
  position: absolute;
  inset: 10px 12px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: var(--radius-sm);
  color: #9a9a9a;
  text-align: center;
  pointer-events: none;
}

.empty-title {
  margin: 8px 0 0;
  color: #e6e6e6;
  font-size: 12px;
}

.empty-hint {
  margin: 0;
  font-size: 11px;
}

.stage-hint,
.stage-banner {
  position: absolute;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  max-width: 80%;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.62);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.stage-hint {
  color: #fff;
}

.stage-banner {
  color: var(--warn);
}

.ticks {
  position: relative;
  flex: none;
  height: 18px;
  margin: 0 12px;
}

.tick {
  position: absolute;
  top: 2px;
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.controls {
  flex: none;
  padding: 4px 12px 10px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.timecode {
  font-size: 12px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.duration {
  font-size: 11px;
}

.selection-chip {
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  line-height: 20px;
}

.selection-hint {
  font-size: 10px;
}

.flex-spacer {
  flex: 1;
}

.btn.is-on {
  background: var(--accent-soft);
  color: var(--accent);
}

.volume {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
}

.volume-range {
  width: 72px;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

.volume-range:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
</style>
