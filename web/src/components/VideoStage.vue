<script setup>
/**
 * 视频工作区中央舞台：`<video>` 播放器 + 完整时间轴 + 底部控制条。
 *
 * 时间同步说明（重要）：
 *   useVideo 的 `state.currentTime` 只在 `seekTo()` 时写入，播放过程中不会跟随播放器更新。
 *   因此这里用本地 `now`（监听 timeupdate）记录真实播放位置，时间轴/时间码都基于 `now`；
 *   只有在外部 seekTo（标记跳转、逐帧、拖动等）时才回读 `state.currentTime`。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { formatDuration, formatTimecode, libraryFileUrl } from '../lib/library.js';

const { state, duration, fps, frameStep, hasVideo, actions } = useVideo();
const { entries } = useLibrary();

const videoEl = ref(null);
const trackEl = ref(null);

/** 真实播放位置（秒），由 timeupdate 驱动。 */
const now = ref(0);
const playing = ref(false);
const dragging = ref(false);
const videoError = ref('');

/**
 * 时间轴关键帧预览
 * ----------------
 * hoverVisible/hoverTime：悬停时显示光标处最近的一帧，移动指针即连续换帧（类似 GIF 的拖动预览）；
 * gifPlaying：点按钮后按固定节奏轮播 filmstrip，方便快速回顾整段画面。
 */
const hoverVisible = ref(false);
const hoverPercent = ref(0);
const hoverTime = ref(0);
const gifPlaying = ref(false);
const gifIndex = ref(0);
let gifTimer = 0;

const previewFrame = computed(() => {
  const frames = state.filmstrip;
  if (!frames.length) return null;
  if (gifPlaying.value) return frames[gifIndex.value % frames.length] ?? frames[0];
  let best = frames[0];
  let bestDiff = Infinity;
  for (const frame of frames) {
    const diff = Math.abs((frame.time ?? 0) - hoverTime.value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = frame;
    }
  }
  return best;
});

const previewStyle = computed(() => {
  const percent = hoverPercent.value;
  // 靠近两端时调整对齐方式，避免预览框超出时间轴被裁掉
  const shift = percent < 12 ? '0' : percent > 88 ? '-100%' : '-50%';
  return { left: `${percent}%`, transform: `translateX(${shift})` };
});

function onTrackHover(event) {
  if (!hasVideo.value || !(duration.value > 0)) return;
  const ratio = ratioAt(event);
  hoverPercent.value = ratio * 100;
  hoverTime.value = ratio * duration.value;
  hoverVisible.value = true;
}

function onTrackLeave() {
  hoverVisible.value = false;
  stopGifPreview();
}

function toggleGifPreview() {
  if (gifPlaying.value) {
    stopGifPreview();
    return;
  }
  if (!state.filmstrip.length) return;
  gifPlaying.value = true;
  gifIndex.value = 0;
  gifTimer = window.setInterval(() => {
    gifIndex.value = (gifIndex.value + 1) % state.filmstrip.length;
  }, 260);
}

function stopGifPreview() {
  if (gifTimer) {
    clearInterval(gifTimer);
    gifTimer = 0;
  }
  gifPlaying.value = false;
}

const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2];

const MEDIA_ERRORS = {
  1: '加载被中止',
  2: '网络错误',
  3: '解码失败',
  4: '格式不受支持或文件已损坏',
};

/** 当前视频条目：优先用资源库条目自带的 url（可能带缓存参数），找不到再拼服务端地址。 */
const activeEntry = computed(() => entries.value.find((entry) => entry.path === state.activePath) ?? null);

const videoSrc = computed(() => {
  if (!state.activePath) return '';
  if (activeEntry.value) return libraryFileUrl(activeEntry.value);
  // 兜底：即使资源库列表还没刷新到，也能直接通过 Range 地址播放
  return `/api/library/file?path=${encodeURIComponent(state.activePath)}`;
});

const progressPercent = computed(() => {
  const total = duration.value;
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, (now.value / total) * 100));
});

const playheadStyle = computed(() => ({ left: `${progressPercent.value}%` }));

/** 逐帧步长提示：优先展示 1/fps，帧率未知时退回秒数。 */
const frameStepTitle = computed(() => {
  const value = fps.value;
  return value > 0 ? `1/${value.toFixed(2)}s` : `${frameStep.value.toFixed(3)}s`;
});

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** 按总时长自动挑刻度步长，保证标签数量不超过约 12 个。 */
const ticks = computed(() => {
  const total = duration.value;
  if (!(total > 0)) return [];
  const step = TICK_STEPS.find((candidate) => total / candidate <= 11) ?? 600;
  const list = [];
  const count = Math.floor(total / step + 1e-6);
  for (let index = 0; index <= count; index += 1) {
    const time = Math.min(total, index * step);
    list.push({ time, left: (time / total) * 100, label: tickLabel(time, step) });
  }
  // 末尾补总时长，避免最后一段没有刻度
  const last = list[list.length - 1];
  if (last && total - last.time > 0.01) {
    list.push({ time: total, left: 100, label: tickLabel(total, step) });
  }
  return list;
});

function tickLabel(time, step) {
  return step < 1 ? `${time.toFixed(1)}s` : formatDuration(time);
}

/** 首尾刻度向内对齐，避免文字被裁掉或盖住“添加标记”按钮。 */
function tickStyle(tick) {
  const shift = tick.left <= 0.5 ? '0' : tick.left >= 99.5 ? '-100%' : '-50%';
  return { left: `${tick.left}%`, transform: `translateX(${shift})` };
}

function markStyle(mark) {
  const total = duration.value;
  const percent = total > 0 ? Math.min(100, Math.max(0, (Number(mark) / total) * 100)) : 0;
  return { left: `${percent}%` };
}

// --------------------------------------------------------------- 播放器事件

/**
 * 添加标记。
 * 不用 addMarkAtCurrentTime()：它读的是 state.currentTime，而播放/暂停后这个值
 * 仍停留在“最后一次 seekTo 的位置”。本地 now 才是当前画面对应的真实时间，
 * 否则播放中打点会落到错误的时间点。
 */
function addMarkHere() {
  actions.addMark(now.value);
}

function onLoadedMetadata() {
  const el = videoEl.value;
  if (!el) return;
  // 时长一律以 ffprobe 得到的 meta.duration 为准：浏览器解出的值可能差几十毫秒，
  // 若反过来改写 state.meta，时间轴比例和刻度会和截帧时间点错位。
  now.value = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  el.playbackRate = state.playbackRate;
  el.volume = state.volume;
  el.muted = state.muted;
  videoError.value = '';
}

function onTimeUpdate() {
  const el = videoEl.value;
  if (el) now.value = el.currentTime;
}

function onPlay() {
  playing.value = true;
}

function onPause() {
  playing.value = false;
}

function onEnded() {
  playing.value = false;
  const el = videoEl.value;
  now.value = el?.currentTime || now.value;
}

function onVideoError() {
  const code = Number(videoEl.value?.error?.code) || 0;
  videoError.value = `视频加载失败：${MEDIA_ERRORS[code] || '未知错误'}。请确认文件仍在资源库中。`;
  playing.value = false;
}

function reloadVideo() {
  videoError.value = '';
  const el = videoEl.value;
  if (el) el.load();
}

// --------------------------------------------------------------- 时间轴交互

function ratioAt(event) {
  const el = trackEl.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return 0;
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function onTrackPointerDown(event) {
  if (!hasVideo.value || !(duration.value > 0) || event.button !== 0) return;
  dragging.value = true;
  // 拖动期间先暂停：避免播放位置追着指针跑，松手后由用户自行继续播放
  actions.pause();
  const time = ratioAt(event) * duration.value;
  // 先写本地时间再 seekTo，避免 seekTo 引起的回跳把播放头闪一下
  now.value = time;
  actions.seekTo(time);
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    /* 个别浏览器在元素未挂载/已被移除时会抛错，不影响本次 seek */
  }
  event.preventDefault();
}

function onTrackPointerMove(event) {
  onTrackHover(event);
  if (!dragging.value) return;
  const time = ratioAt(event) * duration.value;
  now.value = time;
  actions.seekTo(time);
}

function onTrackPointerUp(event) {
  if (!dragging.value) return;
  dragging.value = false;
  try {
    event.currentTarget.releasePointerCapture(event.pointerId);
  } catch {
    /* 指针捕获可能已由浏览器自动释放 */
  }
}

// --------------------------------------------------------------- 同步

// 切换视频时重置本地读数：src 变化后浏览器会自动重新发起 Range 请求
watch(
  () => state.activePath,
  () => {
    now.value = 0;
    playing.value = false;
    videoError.value = '';
    hoverVisible.value = false;
    stopGifPreview();
  },
);

// 仅在外部 seekTo 造成明显跳变时同步本地时间，避免拖动时双向覆盖产生抖动
watch(
  () => state.currentTime,
  (value) => {
    if (Math.abs(value - now.value) > 0.15) now.value = value;
  },
);

onMounted(() => {
  actions.setPlayer(videoEl.value);
  const el = videoEl.value;
  if (el) {
    el.playbackRate = state.playbackRate;
    el.volume = state.volume;
    el.muted = state.muted;
  }
});

onBeforeUnmount(() => {
  // 必须注销，否则卸载后全局还持有已销毁的 DOM
  actions.setPlayer(null);
  stopGifPreview();
});
</script>

<template>
  <section class="stage">
    <div class="canvas">
      <!-- 元素常驻：没有视频时也保持挂载，onMounted 才能把 player 注册进状态层 -->
      <video
        ref="videoEl"
        class="video"
        :class="{ 'is-hidden': !state.activePath }"
        :src="videoSrc || undefined"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @play="onPlay"
        @pause="onPause"
        @ended="onEnded"
        @error="onVideoError"
      />

      <div v-if="!state.activePath" class="stage-empty">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2.5" y="5.5" width="19" height="13" rx="2" stroke="currentColor" stroke-width="1.3" />
          <path d="M2.5 12h19" stroke="currentColor" stroke-width="1.2" />
          <path d="M6.5 5.5v13M17.5 5.5v13" stroke="currentColor" stroke-width="1.1" />
        </svg>
        <p class="empty-title">从左侧选择视频，或在资源库中双击视频</p>
        <p class="empty-hint muted">视频需要先进入资源库，播放与截帧都直接使用库内文件。</p>
      </div>

      <p v-else-if="state.loading" class="stage-hint">正在读取视频信息…</p>

      <template v-else>
        <button
          v-if="!playing && !videoError"
          class="play-overlay"
          type="button"
          title="播放"
          @click="actions.togglePlay()"
        >
          <span class="play-circle">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 3.3l7.2 4.7L5 12.7z" fill="currentColor" />
            </svg>
          </span>
        </button>

        <div v-if="videoError" class="stage-error">
          <p>{{ videoError }}</p>
          <button class="btn" type="button" @click="reloadVideo">重新加载</button>
        </div>
      </template>

      <p v-if="state.error" class="stage-banner">{{ state.error }}</p>
    </div>

    <footer class="controls">
      <div class="timeline-row">
        <div class="timeline-col">
          <div
            ref="trackEl"
            class="track"
            :class="{ 'is-dragging': dragging, 'is-disabled': !hasVideo }"
            @pointerdown="onTrackPointerDown"
            @pointermove="onTrackPointerMove"
            @pointerup="onTrackPointerUp"
            @pointercancel="onTrackPointerUp"
            @pointerleave="onTrackLeave"
          >
            <div class="track-view">
              <div v-if="state.filmstrip.length" class="filmstrip">
                <img
                  v-for="(frame, index) in state.filmstrip"
                  :key="index"
                  class="film"
                  :src="frame.dataUrl"
                  alt=""
                  draggable="false"
                />
              </div>
              <div v-else class="filmstrip-placeholder">
                <span>{{ state.filmstripLoading ? '时间轴缩略图生成中…' : '暂无时间轴缩略图' }}</span>
              </div>
            </div>

            <!-- 标记点：红色竖线 + 顶部小三角；左键跳转、右键或悬浮删除 -->
            <div
              v-for="mark in state.marks"
              :key="mark"
              class="mark"
              :style="markStyle(mark)"
              @pointerdown.stop
              @contextmenu.prevent="actions.removeMark(mark)"
            >
              <button
                class="mark-hit"
                type="button"
                :title="`跳转到 ${formatTimecode(mark, fps)}（右键删除）`"
                @click.stop="actions.seekTo(mark)"
              />
              <button class="mark-del" type="button" title="删除标记" @click.stop="actions.removeMark(mark)">×</button>
            </div>

            <!-- 播放头：白色竖线 + 顶部圆点 -->
            <div class="playhead" :style="playheadStyle">
              <span class="playhead-dot" />
            </div>

            <!-- 关键帧预览：悬停显示光标处最近的一帧，可切换成 GIF 式自动轮播 -->
            <div
              v-if="hoverVisible && previewFrame"
              class="frame-preview"
              :style="previewStyle"
              @pointerdown.stop
              @click.stop
            >
              <img class="frame-preview-img" :src="previewFrame.dataUrl" alt="" draggable="false" />
              <div class="frame-preview-bar">
                <span class="mono">{{ formatTimecode(previewFrame.time ?? 0, fps) }}</span>
                <button class="frame-preview-btn" type="button" @click.stop="toggleGifPreview">
                  {{ gifPlaying ? '暂停' : 'GIF 预览' }}
                </button>
              </div>
            </div>
          </div>

          <div class="ticks">
            <span v-for="tick in ticks" :key="tick.time" class="tick mono" :style="tickStyle(tick)">
              {{ tick.label }}
            </span>
          </div>
        </div>

        <button
          class="btn is-ghost mark-add"
          type="button"
          :disabled="!hasVideo"
          title="在当前播放位置添加标记"
          @click="addMarkHere"
        >
          + 标记 <span class="mono">{{ state.marks.length }}</span>
        </button>
      </div>

      <div class="control-row">
        <button
          class="btn is-ghost is-icon"
          type="button"
          :disabled="!hasVideo"
          :title="playing ? '暂停' : '播放'"
          @click="actions.togglePlay()"
        >
          <svg v-if="playing" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4.5" y="3" width="2.4" height="10" rx="0.6" fill="currentColor" />
            <rect x="9.1" y="3" width="2.4" height="10" rx="0.6" fill="currentColor" />
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 3.4l7 4.6-7 4.6z" fill="currentColor" />
          </svg>
        </button>

        <button
          class="btn is-ghost is-icon"
          type="button"
          :disabled="!hasVideo"
          :title="`上一帧（${frameStepTitle}）`"
          @click="actions.stepFrame(-1)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10.5 3.5L5 8l5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M3.6 3.5v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>

        <button
          class="btn is-ghost is-icon"
          type="button"
          :disabled="!hasVideo"
          :title="`下一帧（${frameStepTitle}）`"
          @click="actions.stepFrame(1)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5.5 3.5L11 8l-5.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M12.4 3.5v9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>

        <span class="timecode mono">{{ formatTimecode(now, fps) }}</span>
        <span class="duration muted mono">/ {{ formatDuration(duration) }}</span>

        <span class="flex-spacer" />

        <select
          class="select"
          :value="state.playbackRate"
          :disabled="!hasVideo"
          title="播放速度"
          @change="actions.setPlaybackRate(Number($event.target.value))"
        >
          <option v-for="rate in PLAYBACK_RATES" :key="rate" :value="rate">{{ rate }}×</option>
        </select>

        <div class="volume">
          <button
            class="btn is-ghost is-icon"
            type="button"
            :disabled="!hasVideo"
            :title="state.muted ? '取消静音' : '静音'"
            @click="actions.toggleMute()"
          >
            <svg v-if="state.muted" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6h2.2L8.4 3.6v8.8L5.2 10H3z" fill="currentColor" stroke="currentColor" stroke-width="1" />
              <path d="M10.8 5.6l4 4.8M14.8 5.6l-4 4.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 6h2.2L8.4 3.6v8.8L5.2 10H3z" fill="currentColor" stroke="currentColor" stroke-width="1" />
              <path d="M10.6 5.4a3.6 3.6 0 0 1 0 5.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <path d="M12.4 3.8a6 6 0 0 1 0 8.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <input
            class="volume-range"
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="state.volume"
            :disabled="!hasVideo"
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

.canvas {
  position: relative;
  flex: 1;
  /* 必须 min-height: 0，否则视频会把底部时间轴挤出可视区域 */
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
}

.video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.video.is-hidden {
  visibility: hidden;
}

.stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 24px;
  text-align: center;
  /* 舞台永远是黑底（浅色主题下也一样），这里用固定浅色而不是 --text-*，
     否则浅色主题的深灰文字在黑色画面上几乎看不见 */
  color: #9a9a9a;
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
  top: 12px;
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
}

.stage-hint {
  color: #fff;
}

.stage-banner {
  color: var(--warn);
}

.play-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: transparent;
}

.play-circle {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #fff;
  transition: background 0.12s ease;
}

.play-overlay:hover .play-circle {
  background: rgba(0, 0, 0, 0.74);
}

.stage-error {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.72);
  color: var(--danger);
  font-size: 11px;
  text-align: center;
}

.stage-error p {
  margin: 0;
}

.controls {
  flex: none;
  padding: 8px 12px 10px;
  background: var(--panel);
  border-top: 1px solid var(--border);
}

.timeline-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-col {
  flex: 1;
  min-width: 0;
}

.track {
  position: relative;
  height: 56px;
  border-radius: var(--radius-sm);
  background: var(--panel-3);
  cursor: pointer;
  /* 指针拖动时禁止浏览器把水平位移解释成滚动/文本选择 */
  touch-action: none;
  user-select: none;
}

.track.is-dragging {
  cursor: ew-resize;
}

.track.is-disabled {
  cursor: default;
}

.track-view {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.filmstrip {
  display: flex;
  height: 100%;
}

.film {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 56px;
  /* contain：整帧完整显示（上下不裁切），留黑边而不是裁掉画面 */
  object-fit: contain;
  background: #0b0b0d;
  display: block;
}

.filmstrip-placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 11px;
  background: linear-gradient(90deg, var(--panel-2), var(--panel-3), var(--panel-2));
}

.mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  transform: translateX(-50%);
}

.mark-hit {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.mark-hit::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: var(--danger);
}

.mark-hit::after {
  content: '';
  position: absolute;
  top: 0;
  left: 1px;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 6px solid var(--danger);
}

.mark-del {
  position: absolute;
  top: 1px;
  left: 7px;
  display: none;
  width: 13px;
  height: 13px;
  border-radius: 3px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  line-height: 1;
}

.mark:hover .mark-del {
  display: block;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 2px solid #fff;
  transform: translateX(-1px);
  pointer-events: none;
}

.playhead-dot {
  position: absolute;
  top: -5px;
  left: -6px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

/* 关键帧悬停预览：浮在时间轴上方，靠近两端时自动换对齐方向 */
.frame-preview {
  position: absolute;
  bottom: calc(100% + 8px);
  z-index: 6;
  width: 224px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: var(--radius-sm);
  background: rgba(8, 8, 10, 0.94);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
}

.frame-preview-img {
  display: block;
  width: 100%;
  max-height: 140px;
  object-fit: contain;
  background: #000;
}

.frame-preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 6px;
  color: #d8d8d8;
  font-size: 10px;
}

.frame-preview-btn {
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 3px;
  background: transparent;
  color: #e8e8e8;
  font-size: 10px;
  cursor: pointer;
}

.frame-preview-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.ticks {
  position: relative;
  height: 14px;
  margin-top: 3px;
}

.tick {
  position: absolute;
  top: 0;
  color: var(--text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.mark-add {
  flex: none;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.timecode {
  font-size: 12px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.duration {
  font-size: 11px;
}

.flex-spacer {
  flex: 1;
}

.select {
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.select:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.volume {
  display: flex;
  align-items: center;
  gap: 4px;
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
