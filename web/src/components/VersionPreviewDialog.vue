<script setup>
/**
 * 历史版本预览面板
 * ----------------
 * 以前点「预览」是用 window.open 在浏览器新标签页打开文件，既离开应用、也没有透明度查看。
 * 这个面板把版本图片读进当前应用里看：
 *
 *  - 背景可切 棋盘 / 深色 / 浅色，透明区域一目了然；
 *  - 「透明通道」把 alpha 直接画成灰度，检查半透明/羽化是否保留；
 *  - 「软边高亮」把 0 < alpha < 255 的像素染红，快速看抠图边缘；
 *  - 支持滚轮缩放（以指针为锚点）、拖拽平移、适合窗口 / 100% 切换。
 *
 * 面板只读：恢复版本 / 与当前文件对比都通过事件交给资源库检查器处理。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';

import { fetchLibraryBlob, formatSize } from '../lib/library.js';
import { createCanvas } from '../lib/imageops.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  entry: { type: Object, default: null },
  version: { type: Object, default: null },
});
const emit = defineEmits(['close', 'restore', 'compare']);

const wrapEl = ref(null);
const rootEl = ref(null);

const state = reactive({
  loading: false,
  error: '',
  width: 0,
  height: 0,
  bytes: 0,
});
const view = reactive({ zoom: 1, panX: 0, panY: 0, fit: 1 });
const mode = ref('original'); // original | alpha | edge
const background = ref('checker'); // checker | dark | light

const bitmap = shallowRef(null);
const alphaSource = shallowRef(null);
const edgeSource = shallowRef(null);
let dragState = null;

const isImage = computed(() => props.version?.kind === 'image' || props.entry?.kind === 'image');
const zoomPercent = computed(() => Math.round(view.fit * view.zoom * 100));
const versionTime = computed(() => {
  const at = props.version?.at;
  return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
});
const modeOptions = [
  { value: 'original', label: '原图' },
  { value: 'alpha', label: '透明通道' },
  { value: 'edge', label: '软边高亮' },
];
const bgOptions = [
  { value: 'checker', label: '棋盘' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

// --------------------------------------------------------------- 解码 / 派生视图
async function load() {
  cleanup();
  if (!props.open || !props.version) return;
  if (!isImage.value) {
    state.error = '这个历史版本不是图片，请用「对比」查看（视频逐帧 / 音频波形）。';
    return;
  }
  state.loading = true;
  state.error = '';
  try {
    const blob = await fetchLibraryBlob(props.version.url);
    const bmp = await createImageBitmap(blob);
    bitmap.value = bmp;
    state.width = bmp.width;
    state.height = bmp.height;
    state.bytes = blob.size || props.version.bytes || 0;
    await nextTick();
    computeFit();
    render();
  } catch (err) {
    state.error = `读取历史版本失败：${err.message}`;
  } finally {
    state.loading = false;
  }
}

/** 透明通道：alpha 当灰度画出来。 */
function alphaCanvasFor(bmp) {
  const canvas = createCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const image = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    data[i] = alpha;
    data[i + 1] = alpha;
    data[i + 2] = alpha;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 软边高亮：半透明像素染红，全透明保持透明，不透明保留原样。 */
function edgeCanvasFor(bmp) {
  const canvas = createCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const image = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) {
      data[i + 3] = 0;
    } else if (alpha < 255) {
      data[i] = 255;
      data[i + 1] = 64;
      data[i + 2] = 64;
      data[i + 3] = 235;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function ensureLayer(target) {
  if (!bitmap.value) return null;
  if (target === 'alpha') {
    if (!alphaSource.value) alphaSource.value = alphaCanvasFor(bitmap.value);
    return alphaSource.value;
  }
  if (!edgeSource.value) edgeSource.value = edgeCanvasFor(bitmap.value);
  return edgeSource.value;
}

// --------------------------------------------------------------- 渲染
function computeFit() {
  const wrap = wrapEl.value;
  if (!wrap || !state.width || !state.height) return;
  const availW = Math.max(40, wrap.clientWidth - 32);
  const availH = Math.max(40, wrap.clientHeight - 32);
  // 上限 4 倍：小图放大到 4 倍足够看清像素，再大只剩马赛克
  view.fit = Math.min(availW / state.width, availH / state.height, 4);
}

function render() {
  const canvas = wrapEl.value?.querySelector('canvas');
  const wrap = wrapEl.value;
  if (!canvas || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(1, wrap.clientWidth);
  const cssH = Math.max(1, wrap.clientHeight);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!bitmap.value) return;

  const scale = view.fit * view.zoom;
  const dw = state.width * scale;
  const dh = state.height * scale;
  const dx = (cssW - dw) / 2 + view.panX;
  const dy = (cssH - dh) / 2 + view.panY;

  const source = mode.value === 'original' ? bitmap.value : ensureLayer(mode.value);
  if (!source) return;
  // 放大到 4 倍以上关掉插值：看到真实像素块，方便判断边缘是否干净
  ctx.imageSmoothingEnabled = scale < 4;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, dx, dy, dw, dh);
}

// --------------------------------------------------------------- 交互
function zoomAt(event, factor) {
  const wrap = wrapEl.value;
  if (!wrap) return;
  const nextZoom = Math.min(32, Math.max(0.02, view.zoom * factor));
  if (Math.abs(nextZoom - view.zoom) < 1e-6) return;
  const rect = wrap.getBoundingClientRect();
  const anchorX = event.clientX - rect.left;
  const anchorY = event.clientY - rect.top;
  const before = view.fit * view.zoom;
  const u = (anchorX - (rect.width - state.width * before) / 2 - view.panX) / before;
  const v = (anchorY - (rect.height - state.height * before) / 2 - view.panY) / before;
  view.zoom = nextZoom;
  const after = view.fit * view.zoom;
  view.panX = anchorX - u * after - (rect.width - state.width * after) / 2;
  view.panY = anchorY - v * after - (rect.height - state.height * after) / 2;
  render();
}

function onWheel(event) {
  event.preventDefault();
  zoomAt(event, event.deltaY < 0 ? 1.12 : 1 / 1.12);
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  dragState = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  wrapEl.value?.classList.add('is-dragging');
}

function onPointerMove(event) {
  if (!dragState) return;
  view.panX = dragState.panX + (event.clientX - dragState.x);
  view.panY = dragState.panY + (event.clientY - dragState.y);
  render();
}

function onPointerUp(event) {
  if (!dragState) return;
  dragState = null;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  wrapEl.value?.classList.remove('is-dragging');
}

function fitView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  render();
}

/** 100%：1 个图片像素 = 1 个 CSS 像素。 */
function actualSize() {
  view.zoom = 1 / Math.max(0.0001, view.fit);
  view.panX = 0;
  view.panY = 0;
  render();
}

function setMode(value) {
  mode.value = value;
  render();
}

function setBackground(value) {
  background.value = value;
}

function close() {
  cleanup();
  emit('close');
}

function restore() {
  if (props.version) emit('restore', props.version);
}

function compare() {
  if (props.version) emit('compare', props.version);
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (!isImage.value) return;
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomAt({ clientX: wrapEl.value?.getBoundingClientRect().left + 40, clientY: wrapEl.value?.getBoundingClientRect().top + 40 }, 1.25);
  } else if (event.key === '-') {
    event.preventDefault();
    zoomAt({ clientX: wrapEl.value?.getBoundingClientRect().left + 40, clientY: wrapEl.value?.getBoundingClientRect().top + 40 }, 1 / 1.25);
  } else if (event.key === '0') {
    event.preventDefault();
    fitView();
  }
}

function cleanup() {
  if (bitmap.value) bitmap.value.close?.();
  bitmap.value = null;
  alphaSource.value = null;
  edgeSource.value = null;
  state.loading = false;
  state.error = '';
  state.width = 0;
  state.height = 0;
  state.bytes = 0;
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  mode.value = 'original';
}

function onResize() {
  if (!props.open) return;
  computeFit();
  render();
}

watch(
  () => [props.open, props.version?.id],
  async () => {
    if (!props.open) {
      cleanup();
      return;
    }
    await load();
    void nextTick(() => rootEl.value?.focus());
  },
  { immediate: true },
);

window.addEventListener('resize', onResize);

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  cleanup();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="vp-modal">
      <div v-if="open" ref="rootEl" class="vp-mask" tabindex="-1" @click.self="close" @keydown="onKeydown">
        <div class="vp-dialog" role="dialog" aria-modal="true" :aria-label="`历史版本预览：${entry?.name ?? ''}`">
          <header class="vp-head">
            <div class="vp-heading">
              <span class="vp-tag">历史版本</span>
              <h2 :title="entry?.name">{{ entry?.name ?? '版本预览' }}</h2>
              <span class="vp-meta mono">{{ versionTime }}</span>
            </div>
            <div class="vp-head-actions">
              <button class="vp-close" type="button" title="关闭 (Esc)" @click="close">×</button>
            </div>
          </header>

          <div class="vp-toolbar">
            <div class="vp-group">
              <span class="vp-label">视图</span>
              <div class="vp-tabs">
                <button
                  v-for="option in modeOptions"
                  :key="option.value"
                  class="vp-tab"
                  :class="{ 'is-on': mode === option.value }"
                  type="button"
                  :disabled="!isImage"
                  @click="setMode(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div class="vp-group">
              <span class="vp-label">背景</span>
              <div class="vp-tabs">
                <button
                  v-for="option in bgOptions"
                  :key="option.value"
                  class="vp-tab"
                  :class="{ 'is-on': background === option.value }"
                  type="button"
                  @click="setBackground(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div class="vp-spacer"></div>
            <span class="vp-meta mono">{{ state.width }}×{{ state.height }} · {{ formatSize(state.bytes) }}</span>
            <button class="btn is-mini" type="button" title="适合窗口 (0)" @click="fitView">适合</button>
            <button class="btn is-mini" type="button" title="100% 实际像素" @click="actualSize">100%</button>
            <span class="vp-zoom mono">{{ zoomPercent }}%</span>
          </div>

          <div
            ref="wrapEl"
            class="vp-stage"
            :class="[`bg-${background}`, { 'is-pixel': mode === 'alpha' || mode === 'edge' }]"
            @wheel.prevent="onWheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <div v-if="state.loading" class="vp-hint">正在读取历史版本…</div>
            <div v-else-if="state.error" class="vp-hint is-error">{{ state.error }}</div>
            <canvas class="vp-canvas" :class="{ 'is-hidden': !isImage || state.loading || state.error }"></canvas>
          </div>

          <footer class="vp-foot">
            <span class="vp-tip muted">
              <template v-if="mode === 'alpha'">透明通道：白色为不透明，黑色为全透明，灰色为半透明。</template>
              <template v-else-if="mode === 'edge'">软边高亮：红色是 0 &lt; alpha &lt; 255 的半透明边缘。</template>
              <template v-else>滚轮缩放 · 拖拽平移 · Esc 关闭</template>
            </span>
            <div class="vp-actions">
              <button class="btn is-mini" type="button" :disabled="!version" @click="compare">与当前对比</button>
              <button class="btn is-mini is-primary" type="button" :disabled="!version" @click="restore">恢复这一版</button>
              <button class="btn is-mini" type="button" @click="close">关闭</button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vp-mask {
  position: fixed;
  inset: 0;
  z-index: 82;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.vp-dialog {
  display: flex;
  flex-direction: column;
  width: min(1100px, 100%);
  height: min(86vh, 820px);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  outline: none;
}

.vp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.vp-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.vp-heading h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.vp-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
}

.vp-close:hover {
  background: var(--hover);
  color: var(--text);
}

.vp-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}

.vp-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vp-label {
  font-size: 10px;
  color: var(--text-muted);
}

.vp-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius);
  background: var(--panel-2);
  border: 1px solid var(--border);
}

.vp-tab {
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.vp-tab.is-on {
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow-frame);
}

.vp-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.vp-spacer {
  flex: 1;
}

.vp-meta {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.vp-zoom {
  min-width: 44px;
  text-align: right;
  font-size: 10px;
  color: var(--text-2);
}

.vp-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}

.vp-stage.is-dragging {
  cursor: grabbing;
}

.vp-stage.bg-checker {
  background-color: var(--checker-a);
  background-image: repeating-conic-gradient(var(--checker-b) 0% 25%, transparent 0% 50%);
  background-size: 16px 16px;
}

.vp-stage.bg-dark {
  background: #101013;
}

.vp-stage.bg-light {
  background: #f2f2f2;
}

.vp-canvas {
  position: absolute;
  inset: 0;
}

.vp-canvas.is-hidden {
  display: none;
}

.vp-hint {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  z-index: 1;
  font-size: 11px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--panel) 86%, transparent);
}

.vp-hint.is-error {
  color: var(--danger);
}

.vp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

.vp-tip {
  font-size: 10px;
  line-height: 1.5;
}

.vp-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vp-modal-enter-active,
.vp-modal-leave-active {
  transition: opacity 0.16s ease;
}

.vp-modal-enter-from,
.vp-modal-leave-to {
  opacity: 0;
}

.vp-modal-enter-active .vp-dialog {
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.vp-modal-enter-from .vp-dialog {
  transform: translateY(8px) scale(0.988);
}
</style>
