<script setup>
/**
 * 资源库多选图片轮播（Slideshow）
 * ---------------------------------
 * 从资源库中选中多张图片后打开，和系统幻灯片一样按顺序循环播放：
 *  - 上一张 / 下一张（首尾循环），缩略图条可直接跳转；
 *  - 自动播放（默认开启）、暂停/继续、播放间隔 2/3/5/8 秒、顶部进度条；
 *  - 键盘：← → 翻页、空格播放/暂停、F 全屏、Esc 关闭；
 *  - 全屏切换、当前图片文件名/分辨率/大小/页码、相邻图片预加载、加载失败重试。
 *
 * 组件只负责展示与播放，关闭后由父组件保留原选择。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { formatSize, libraryFileUrl, libraryThumbUrl } from '../lib/library.js';

const props = defineProps({
  /** 要轮播的图片条目（保持资源库列表中的可见顺序）。 */
  images: { type: Array, default: () => [] },
  /** 打开时从哪张开始。 */
  startPath: { type: String, default: '' },
});

const emit = defineEmits(['close']);

const INTERVALS = [2000, 3000, 5000, 8000];
/** 播放间隔的输入范围：毫秒级可调，最小 10ms，最大 10 分钟。 */
const MIN_INTERVAL_MS = 10;
const MAX_INTERVAL_MS = 600000;

const root = ref(null);
const strip = ref(null);

const count = computed(() => props.images.length);
const initialIndex = props.images.findIndex((entry) => entry.path === props.startPath);
const index = ref(initialIndex >= 0 ? initialIndex : 0);
const current = computed(() => props.images[index.value] ?? null);

const playing = ref(true);
const intervalMs = ref(3000);
const ready = ref(false);
const failed = ref(false);
const reloadToken = ref(0);
const isFullscreen = ref(false);

const metaText = computed(() => {
  const entry = current.value;
  if (!entry) return '';
  const parts = [];
  if (entry.width && entry.height) parts.push(`${entry.width}×${entry.height}`);
  parts.push(formatSize(entry.bytes));
  return parts.join(' · ');
});

const imageSrc = computed(() => {
  const entry = current.value;
  if (!entry) return '';
  const url = libraryFileUrl(entry);
  // 重试时加一个版本参数，绕开浏览器对同一 URL 的失败缓存
  return reloadToken.value ? `${url}${url.includes('?') ? '&' : '?'}r=${reloadToken.value}` : url;
});

function clampIndex(value) {
  const total = count.value;
  return total ? ((value % total) + total) % total : 0;
}

// ------------------------------------------------------------ 自动播放计时
/** setTimeout 而不是 setInterval：暂停/继续能保留剩余时间，切图后重新计时。 */
let timer = null;
let startedAt = 0;
let remaining = intervalMs.value;

function stopTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  if (!playing.value || count.value <= 1) return;
  startedAt = Date.now();
  timer = setTimeout(tick, Math.max(1, remaining));
}

function tick() {
  timer = null;
  index.value = clampIndex(index.value + 1);
  remaining = intervalMs.value;
  startTimer();
}

function pauseTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  remaining = Math.max(0, remaining - (Date.now() - startedAt));
}

/** 手动翻页 / 跳转后重新开始倒计时。 */
function restartCountdown() {
  remaining = intervalMs.value;
  startTimer();
}

function go(delta) {
  if (count.value <= 1) return;
  index.value = clampIndex(index.value + delta);
  restartCountdown();
}

function jump(path) {
  const target = props.images.findIndex((entry) => entry.path === path);
  if (target < 0 || target === index.value) return;
  index.value = target;
  restartCountdown();
}

function togglePlay() {
  if (count.value <= 1) return;
  if (playing.value) {
    playing.value = false;
    pauseTimer();
  } else {
    playing.value = true;
    startTimer();
  }
}

/** 把任意输入规整为合法毫秒值；空值或非法输入回退到当前间隔。 */
function normalizeInterval(value) {
  const raw = String(value ?? '').trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return intervalMs.value;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(parsed)));
}

function setIntervalMs(value) {
  const next = normalizeInterval(value);
  if (next === intervalMs.value) return;
  intervalMs.value = next;
  remaining = next;
  // 暂停状态下 startTimer 会直接返回，只更新 CSS 进度条（保持暂停）
  startTimer();
}

/** 输入框提交（回车 / 失焦）：按毫秒生效，并把越界值回填成实际间隔。 */
function commitInterval(event) {
  const next = normalizeInterval(event.target.value);
  event.target.value = String(next);
  setIntervalMs(next);
}

function onIntervalEnter(event) {
  commitInterval(event);
  event.target.blur();
}

// -------------------------------------------------------------- 翻页过渡
/**
 * 上一张图的快照：过渡时垫在新图下面，新图淡入并轻微缩放，形成交叉淡化。
 * 过渡结束后立刻清掉，避免长轮播时多占一层图片。
 */
const previous = ref(null);
let previousTimer = null;

/** 过渡时长跟随播放间隔缩放，间隔极短时不转场，保证切图节奏准确。 */
const transitionMs = computed(() => {
  const scaled = Math.min(450, intervalMs.value * 0.4);
  return scaled >= 60 ? Math.round(scaled) : 0;
});

function clearPreviousTimer() {
  if (previousTimer) {
    clearTimeout(previousTimer);
    previousTimer = null;
  }
}

function clearPrevious() {
  clearPreviousTimer();
  previous.value = null;
}

// ---------------------------------------------------------------- 图片加载
function onImageLoad() {
  ready.value = true;
  failed.value = false;
  // 新图真正加载完才开始计时移除垫底图，慢图也不会提前露底
  if (previous.value) {
    clearPreviousTimer();
    previousTimer = setTimeout(() => {
      previousTimer = null;
      previous.value = null;
    }, transitionMs.value + 40);
  }
}

function onImageError() {
  failed.value = true;
  ready.value = false;
  clearPrevious();
}

function retry() {
  reloadToken.value += 1;
  failed.value = false;
  ready.value = false;
}

watch(index, async (next, prevIndex) => {
  clearPreviousTimer();
  const outgoing = props.images[prevIndex];
  if (outgoing && transitionMs.value > 0) {
    previous.value = { path: outgoing.path, src: libraryFileUrl(outgoing) };
  } else {
    previous.value = null;
  }
  ready.value = false;
  failed.value = false;
  await nextTick();
  scrollStripToCurrent();
  preloadNeighbors();
});

/** 底部缩略图条跟随当前项自动滚动（居中显示）。 */
function scrollStripToCurrent() {
  const container = strip.value;
  if (!container) return;
  const item = container.children[index.value];
  item?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

/** 预加载前后各一张，翻页时不出现空白等待。 */
const preloaded = new Set();
function preloadNeighbors() {
  if (count.value <= 1) return;
  for (const offset of [-1, 1]) {
    const entry = props.images[clampIndex(index.value + offset)];
    if (!entry || preloaded.has(entry.path)) continue;
    preloaded.add(entry.path);
    const img = new Image();
    img.src = libraryFileUrl(entry);
  }
}

// ------------------------------------------------------------------ 全屏
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await root.value?.requestFullscreen();
    }
  } catch {
    /* 浏览器或权限拒绝全屏时保持窗口模式 */
  }
}

function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === root.value;
}

async function close() {
  stopTimer();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  emit('close');
}

// ------------------------------------------------------------------ 键盘
/**
 * 用捕获阶段监听：先于资源库预览与 App 全局快捷键处理，
 * 处理过的按键把事件截断，避免轮播打开时切换工作区或触发其他快捷键。
 */
function onKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  // 在间隔输入框里打字时不抢按键：数字/方向键留给输入框本身（Esc 仍然关闭）
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (typing && key !== 'Escape') return;
  let handled = true;

  if (key === 'Escape') {
    void close();
  } else if (key === 'ArrowLeft') {
    go(-1);
  } else if (key === 'ArrowRight') {
    go(1);
  } else if (key === ' ' || key === 'Spacebar') {
    if (!event.repeat) togglePlay();
  } else if (key === 'f' || key === 'F') {
    void toggleFullscreen();
  } else if (/^[1-9]$/.test(key)) {
    // 数字键在 App 里是切换工作区，轮播是模态层，不能让它把组件卸载掉
    event.stopImmediatePropagation();
    handled = false;
  } else {
    handled = false;
  }

  if (handled) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  remaining = intervalMs.value;
  startTimer();
  void nextTick(() => {
    scrollStripToCurrent();
    preloadNeighbors();
  });
});

onBeforeUnmount(() => {
  stopTimer();
  clearPreviousTimer();
  window.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="slideshow" role="dialog" aria-modal="true" aria-label="图片轮播">
      <header class="topbar">
        <div class="title">
          <span class="name" :title="current?.path">{{ current?.name ?? '没有可播放的图片' }}</span>
          <span v-if="metaText" class="meta mono">{{ metaText }}</span>
        </div>

        <span class="counter mono">{{ count ? index + 1 : 0 }} / {{ count }}</span>

        <button class="ctl" type="button" :disabled="count <= 1" @click="togglePlay">
          {{ playing ? '暂停' : '播放' }}
        </button>

        <label class="interval-field" title="播放间隔，可精确到毫秒（10–600000）">
          <span>间隔</span>
          <input
            class="interval-input"
            type="number"
            min="10"
            max="600000"
            step="1"
            :value="intervalMs"
            aria-label="播放间隔（毫秒）"
            @change="commitInterval"
            @keydown.enter.prevent="onIntervalEnter"
          />
          <span>ms</span>
        </label>

        <div class="intervals" role="group" aria-label="常用播放间隔">
          <button
            v-for="ms in INTERVALS"
            :key="ms"
            class="interval"
            :class="{ 'is-active': intervalMs === ms }"
            type="button"
            :title="`每 ${ms / 1000} 秒切换到下一张`"
            @click="setIntervalMs(ms)"
          >
            {{ ms / 1000 }}s
          </button>
        </div>

        <button class="ctl" type="button" @click="toggleFullscreen">
          {{ isFullscreen ? '退出全屏' : '全屏' }}
        </button>
        <button class="ctl is-close" type="button" title="关闭 (Esc)" @click="close">×</button>
      </header>

      <div class="progress" aria-hidden="true">
        <span
          :key="`${index}-${intervalMs}`"
          class="progress-fill"
          :style="{ animationDuration: `${intervalMs}ms`, animationPlayState: playing ? 'running' : 'paused' }"
        />
      </div>

      <div class="stage">
        <button
          class="nav prev"
          type="button"
          title="上一张 (←)"
          :disabled="count <= 1"
          @click="go(-1)"
        >
          ‹
        </button>

        <div class="frame" :style="{ '--slide-transition': `${transitionMs}ms` }">
          <!-- 交叉淡化：上一张垫在下面，新图淡入并轻微缩放 -->
          <img
            v-if="previous"
            class="media is-under"
            :src="previous.src"
            alt=""
            draggable="false"
          />
          <img
            v-if="current && !failed"
            :key="`${current.path}:${reloadToken}`"
            class="media is-over"
            :class="{ 'is-ready': ready }"
            :src="imageSrc"
            alt=""
            draggable="false"
            @load="onImageLoad"
            @error="onImageError"
          />
          <div v-if="failed" class="fallback">
            <span>无法加载这张图片</span>
            <button class="ctl is-small" type="button" @click="retry">重试</button>
          </div>
          <div v-else-if="!ready" class="loading">加载中…</div>
        </div>

        <button
          class="nav next"
          type="button"
          title="下一张 (→)"
          :disabled="count <= 1"
          @click="go(1)"
        >
          ›
        </button>
      </div>

      <footer class="film">
        <div ref="strip" class="strip">
          <button
            v-for="(entry, i) in images"
            :key="entry.path"
            class="thumb"
            :class="{ 'is-active': i === index }"
            type="button"
            :title="entry.name"
            @click="jump(entry.path)"
          >
            <img :src="libraryThumbUrl(entry)" alt="" loading="lazy" draggable="false" />
            <span class="thumb-index mono">{{ i + 1 }}</span>
          </button>
        </div>
        <span class="hints">← → 翻页 · 空格 播放/暂停 · F 全屏 · Esc 关闭</span>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.slideshow {
  position: fixed;
  inset: 0;
  z-index: 94;
  display: flex;
  flex-direction: column;
  background: rgba(6, 8, 12, 0.96);
  color: #eee;
  /* 模态层里不需要文字选区，避免拖拽/连点出现蓝色选区 */
  user-select: none;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.28);
}

.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #f2f4f8;
}

.meta {
  color: #8b94a4;
  font-size: 10px;
}

.counter {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #c6ccd8;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ctl {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  color: #e7ebf2;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.ctl:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.32);
}

.ctl:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ctl.is-small {
  height: 22px;
  padding: 0 8px;
  font-size: 10px;
}

.ctl.is-close {
  width: 28px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
}

.interval-field {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  color: #aeb6c4;
  font-size: 10px;
}

.interval-field:focus-within {
  border-color: var(--accent);
}

.interval-input {
  width: 60px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: #e7ebf2;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
  -moz-appearance: textfield;
}

.interval-input::-webkit-outer-spin-button,
.interval-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.interval-input:focus {
  outline: none;
  border-color: var(--accent);
}

.intervals {
  display: flex;
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  overflow: hidden;
}

.interval {
  height: 24px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: #aeb6c4;
  font-size: 10px;
  cursor: pointer;
}

.interval + .interval {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.interval:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.interval.is-active {
  background: var(--accent);
  color: #fff;
}

.progress {
  height: 2px;
  flex: none;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: left center;
  animation-name: slideshow-progress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes slideshow-progress {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 58px;
}

.frame {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: repeating-conic-gradient(rgba(255, 255, 255, 0.03) 0% 25%, rgba(255, 255, 255, 0.06) 0% 50%) 50% / 16px
    16px;
  overflow: hidden;
}

.media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transform: scale(1.025);
  transition-property: opacity, transform;
  transition-duration: var(--slide-transition, 0ms);
  transition-timing-function: ease-out;
  will-change: opacity, transform;
}

/* 垫底的上一张：始终完整显示，不做自己的过渡 */
.media.is-under {
  opacity: 1;
  transform: none;
  transition: none;
}

/* 新图加载完成后淡入并回落到原始比例 */
.media.is-ready {
  opacity: 1;
  transform: scale(1);
}

.loading,
.fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #9aa3b1;
  font-size: 12px;
  pointer-events: none;
}

.fallback {
  pointer-events: auto;
}

.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 42px;
  height: 76px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s ease;
}

.nav:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}

.nav:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav.prev {
  left: 8px;
}

.nav.next {
  right: 8px;
}

.film {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.3);
}

.strip {
  display: flex;
  gap: 6px;
  padding: 4px 14px;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-behavior: smooth;
}

.strip::-webkit-scrollbar {
  height: 6px;
}

.thumb {
  position: relative;
  flex: none;
  width: 62px;
  height: 44px;
  padding: 2px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  overflow: hidden;
  opacity: 0.66;
  transition: opacity 0.12s ease, border-color 0.12s ease;
}

.thumb:hover {
  opacity: 1;
  border-color: rgba(255, 255, 255, 0.4);
}

.thumb.is-active {
  opacity: 1;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.thumb-index {
  position: absolute;
  right: 2px;
  bottom: 1px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 8px;
  line-height: 12px;
}

.hints {
  padding: 0 14px;
  color: #6f7887;
  font-size: 9px;
}
</style>
