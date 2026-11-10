<script setup>
/**
 * 顶部工具栏（两行）
 * ------------------
 * 第一行：品牌、当前文档、AI 对话、主题、导入。
 * 第二行：4 个工作区切换 + 当前工作区相关的能力/引擎控件。
 *
 * 为什么分成两行：工作区和引擎控件挤在 48px 里一定会把文字压扁；
 * 拆成「内容行 + 模式行」既保留了原有视觉，也让每个模式都有稳定宽度。
 * 图片处理工作区的工具切换在右侧属性面板的 tab 里，这里只显示当前工具的引擎控件。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import SegmentedControl from './ui/SegmentedControl.vue';
import RangeField from './ui/RangeField.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { useWatermark } from '../composables/useWatermark.js';
import { useLlmChat } from '../composables/useLlmChat.js';
import { useAppMode, MODES } from '../composables/useAppMode.js';
import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { useAudio } from '../composables/useAudio.js';
import { useImageView } from '../composables/useImageView.js';
import { useWorkSession } from '../composables/useWorkSession.js';
import { useUndo } from '../composables/useUndo.js';
import { openImportPicker } from '../composables/useUploadPicker.js';
import { ENGINES } from '../lib/engine.js';
import { formatBytes } from '../lib/imaging.js';
import { formatDuration, formatSize } from '../lib/library.js';
import { SERVER_HINT } from '../lib/watermark.js';

const { state, selected, stats, actions, meta } = useWorkspace();
const { state: watermarkState, actions: watermarkActions } = useWatermark();
const { state: llmState, actions: llmActions } = useLlmChat();
const { state: appMode, currentMode, currentTool, activeTool, actions: modeActions } = useAppMode();
const { state: libraryState, stats: libraryStats } = useLibrary();
const { state: videoState, videoName } = useVideo();
const { state: audioState } = useAudio();
const { state: viewState, actions: viewActions } = useImageView();

/** 画布查看弹出面板：灰度 + 画布背景都在里面调。 */
const viewOpen = ref(false);
const viewWrap = ref(null);
const hexInput = ref(viewState.color.toUpperCase());
const backdropHex = ref(viewState.backdropColor.toUpperCase());
const presetColors = [
  { hex: '#ffffff', label: '纯灰度' },
  { hex: '#ffd28a', label: '暖金' },
  { hex: '#9ecbff', label: '冷蓝' },
  { hex: '#c7a5ff', label: '淡紫' },
  { hex: '#8ef0c0', label: '青绿' },
  { hex: '#ff9f9f', label: '珊瑚粉' },
];
const backdropOptions = [
  { value: 'checker', label: '棋盘格', hint: '透明区域显示为棋盘格，便于确认Alpha' },
  { value: 'solid', label: '纯色', hint: '用纯色铺底，看边缘与明暗更干净' },
];
const backdropPresets = [
  { hex: '#ffffff', label: '白' },
  { hex: '#d4d4d4', label: '浅灰' },
  { hex: '#808080', label: '中灰' },
  { hex: '#333333', label: '深灰' },
  { hex: '#000000', label: '黑' },
];

watch(
  () => viewState.color,
  (color) => {
    hexInput.value = color.toUpperCase();
  },
);

watch(
  () => viewState.backdropColor,
  (color) => {
    backdropHex.value = color.toUpperCase();
  },
);

function toggleViewPanel() {
  viewOpen.value = !viewOpen.value;
}

function onDocPointerDown(event) {
  if (!viewWrap.value?.contains(event.target)) viewOpen.value = false;
}

function onViewKeydown(event) {
  if (event.key === 'Escape') viewOpen.value = false;
}

watch(viewOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onViewKeydown);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('keydown', onViewKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onViewKeydown);
});

function applyHex() {
  const text = hexInput.value.trim();
  if (!/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(text)) {
    hexInput.value = viewState.color.toUpperCase();
    return;
  }
  viewActions.setColor(text);
  hexInput.value = viewState.color.toUpperCase();
}

function applyBackdropHex() {
  const text = backdropHex.value.trim();
  if (!/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(text)) {
    backdropHex.value = viewState.backdropColor.toUpperCase();
    return;
  }
  viewActions.setBackdropColor(text);
  backdropHex.value = viewState.backdropColor.toUpperCase();
}
const { state: sessionState, actions: sessionActions } = useWorkSession();
const { canUndo, canRedo, actions: undoActions } = useUndo();

const mode = computed(() => appMode.mode);
const isImageMode = computed(() => mode.value === 'image');

const engineOptions = computed(() => ENGINES.map((engine) => ({ value: engine.value, label: engine.label, hint: engine.hint })));

const WATERMARK_ENGINES = {
  auto: { label: '自动', hint: '按可用性自动挑选去除引擎' },
  unblend: { label: '本地 OpenCV', hint: '半透明水印反混合，推荐首选' },
  opencv: { label: 'OpenCV 修补', hint: 'Telea/NS 修补，适合细笔画、不透明水印' },
  lama: { label: 'LaMa 深度', hint: '深度模型修复，复杂纹理最好，显存占用高' },
};

const watermarkEngineOptions = computed(() => {
  const list = watermarkState.health.checked ? watermarkState.health.engines : [];
  const usable = list.length ? list : Object.keys(WATERMARK_ENGINES);
  return usable.map((value) => ({ value, ...(WATERMARK_ENGINES[value] ?? { label: value }) }));
});

const watermarkHint = computed(() => {
  if (!watermarkState.health.checked) return '正在检查水印服务…';
  if (!watermarkState.health.ok) return SERVER_HINT;
  const { lama, lamaBytes, opencv } = watermarkState.health;
  const parts = [opencv ? 'OpenCV 就绪' : 'OpenCV 不可用'];
  parts.push(lama ? `LaMa 就绪${lamaBytes ? `（${formatBytes(lamaBytes)}）` : ''}` : 'LaMa 未就绪');
  return parts.join(' · ');
});

/** 第一行左侧显示的“当前文档”。 */
const docLabel = computed(() => {
  if (mode.value === 'library') return libraryState.currentDir ? `资源库 / ${libraryState.currentDir}` : '资源库';
  if (mode.value === 'video') return videoName.value || '视频工作区';
  if (mode.value === 'audio') return audioState.name || '音频工作区';
  if (!selected.value) return '未导入素材';
  return selected.value.name;
});

const docMeta = computed(() => {
  if (mode.value === 'library') {
    return `${libraryStats.value.files} 个文件 · ${libraryStats.value.folders} 个目录 · ${formatSize(libraryStats.value.bytes)}`;
  }
  if (mode.value === 'video') {
    const info = videoState.meta;
    if (!info) return '从左侧选择视频';
    return `${info.width || '?'}×${info.height || '?'} · ${formatDuration(info.duration)}${info.fps ? ` · ${info.fps.toFixed(2)}fps` : ''}`;
  }
  if (mode.value === 'audio') {
    if (!audioState.activePath) return '从左侧选择音频';
    const rate = audioState.sampleRate ? `${(audioState.sampleRate / 1000).toFixed(1)}kHz` : '—';
    const channels = audioState.channels === 1 ? '单声道' : audioState.channels === 2 ? '立体声' : `${audioState.channels || '?'} 声道`;
    return `${formatDuration(audioState.duration)} · ${rate} · ${channels}`;
  }
  return `${stats.value.total} 张素材 · ${formatBytes(stats.value.sourceBytes)}`;
});

const importLabel = computed(() => {
  if (mode.value === 'video') return '导入视频';
  if (mode.value === 'audio') return '导入音频';
  if (mode.value === 'library') return '上传文件';
  return '导入图片';
});

/** 统一走应用内上传弹窗（按当前工作区决定目标位置与文件类型）。 */
function pickFiles() {
  openImportPicker(mode.value);
}

const sessionHint = computed(() => {
  if (sessionState.saving) return '正在暂存临时会话…';
  if (sessionState.hasSession) {
    const time = sessionState.savedAt
      ? new Date(sessionState.savedAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '';
    return `临时会话已暂存${time ? `（${time}）` : ''}，点击查看`;
  }
  return '临时会话：自动保留未提交的操作，刷新或重启后可恢复';
});
</script>

<template>
  <header class="topbar">
    <div class="topbar-main">
      <div class="topbar-left">
        <span class="logo" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <path d="M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <path d="M17 13v2.5A1.5 1.5 0 0 1 15.5 17H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <path d="M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <rect x="6.5" y="6.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </span>
        <div class="brand">
          <span class="brand-name">ImageClip</span>
          <span class="chip">{{ meta.ALGORITHM }}</span>
        </div>
        <span class="divider" />
        <div class="doc">
          <span class="doc-name" :title="docLabel">{{ docLabel }}</span>
          <span class="doc-meta muted">{{ docMeta }}</span>
        </div>
      </div>

      <div class="topbar-right">
        <button
          class="btn is-ghost is-icon"
          type="button"
          title="撤销（Ctrl+Z）"
          :disabled="!canUndo"
          @click="undoActions.undo()"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M6.2 3.4 2.6 6.6l3.6 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M2.9 6.6h6.1a3.7 3.7 0 0 1 0 7.4H6.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
        <button
          class="btn is-ghost is-icon"
          type="button"
          title="重做（Ctrl+Shift+Z / Ctrl+Y）"
          :disabled="!canRedo"
          @click="undoActions.redo()"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M9.8 3.4 13.4 6.6l-3.6 3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M13.1 6.6H7a3.7 3.7 0 0 0 0 7.4h2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
        <button class="btn is-ghost session-btn" type="button" :title="sessionHint" @click="sessionActions.openDialog()">
          <span
            class="session-dot"
            :class="{
              'is-saving': sessionState.saving,
              'is-saved': !sessionState.saving && sessionState.hasSession,
            }"
          />
          临时会话
        </button>
        <button
          class="btn is-ghost"
          type="button"
          :title="llmState.providers.length ? '用自然语言操作图片（本地大模型）' : '还没有可用的模型端点'"
          @click="llmActions.toggle()"
        >
          <span class="ai-dot" :class="llmState.activeError ? 'bad' : llmState.activeReachable ? 'ok' : 'idle'" />
          AI 对话
        </button>
        <button class="btn is-ghost is-icon" type="button" title="切换主题" @click="actions.toggleTheme()">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
            <circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
        <button v-if="isImageMode" class="btn" type="button" :disabled="state.busy" @click="actions.loadSamples()">载入示例</button>
        <button class="btn is-primary" type="button" @click="pickFiles">{{ importLabel }}</button>
      </div>
    </div>

    <div class="topbar-modes">
      <nav class="mode-tabs" role="tablist">
        <button
          v-for="item in MODES"
          :key="item.value"
          class="mode-tab"
          :class="{ 'is-active': item.value === mode }"
          type="button"
          role="tab"
          :aria-selected="item.value === mode"
          :title="`${item.hint}（快捷键 ${item.key}）`"
          @click="modeActions.setMode(item.value)"
        >
          <span class="mode-key">{{ item.key }}</span>
          {{ item.label }}
        </button>
      </nav>

      <div class="mode-controls">
        <template v-if="mode === 'image'">
          <div ref="viewWrap" class="gray-view-wrap">
            <button
              class="btn is-ghost gray-toggle"
              :class="{ 'is-on': viewState.grayscale > 0 || viewState.alpha, 'is-open': viewOpen }"
              type="button"
              title="画布查看：实时灰度、透明通道与背景色（仅影响显示）"
              @click="toggleViewPanel"
            >
              <span class="gray-dot" :class="{ 'is-on': viewState.grayscale > 0 || viewState.alpha }" />画布查看
            </button>

            <div v-if="viewOpen" class="gray-popover" role="dialog" aria-label="画布查看设置">
              <div class="gray-popover-head">
                <span>画布查看</span>
                <button class="gray-close" type="button" title="关闭面板（Esc）" @click="viewOpen = false">×</button>
              </div>

              <label class="gray-switch">
                <input
                  type="checkbox"
                  :checked="viewState.grayscale > 0"
                  @change="viewActions.setGrayscale($event.target.checked ? 100 : 0)"
                />
                <span>在画布上实时查看</span>
              </label>

              <RangeField
                label="灰度强度"
                :model-value="viewState.grayscale"
                :min="0"
                :max="100"
                :step="1"
                suffix="%"
                hint="0% 关闭；100% 完全按灰度显示"
                @update:model-value="viewActions.setGrayscale($event)"
              />

              <div class="gray-color-row">
                <input
                  class="gray-color"
                  type="color"
                  :value="viewState.color"
                  title="选择灰度映射到的颜色"
                  @input="viewActions.setColor($event.target.value)"
                />
                <input
                  v-model="hexInput"
                  class="gray-hex mono"
                  type="text"
                  maxlength="7"
                  spellcheck="false"
                  title="也可直接输入十六进制颜色"
                  @change="applyHex"
                  @keydown.enter.prevent="applyHex"
                />
              </div>

              <div class="gray-presets">
                <button
                  v-for="preset in presetColors"
                  :key="preset.hex"
                  class="gray-preset"
                  :class="{ 'is-active': viewState.color === preset.hex }"
                  :style="{ background: preset.hex }"
                  type="button"
                  :title="preset.label"
                  @click="viewActions.setColor(preset.hex)"
                />
              </div>

              <p class="gray-hint">白色 = 纯灰度；选其他颜色会把灰度映射到该色。只影响显示，不修改图片与导出结果。</p>

              <div class="gray-section">
                <div class="gray-section-title">透明通道</div>
                <label class="gray-switch">
                  <input
                    type="checkbox"
                    :checked="viewState.alpha"
                    @change="viewActions.setAlpha($event.target.checked)"
                  />
                  <span>按 Alpha 显示（黑 = 透明，白 = 不透明）</span>
                </label>

                <template v-if="viewState.alpha">
                  <RangeField
                    label="Alpha 增益"
                    :model-value="viewState.alphaGain"
                    :min="1"
                    :max="50"
                    :step="1"
                    suffix="×"
                    hint="2.4% 的残影用 10× 就能看清；1× 为原始透明度"
                    @update:model-value="viewActions.setAlphaGain($event)"
                  />
                  <p class="gray-hint">开启后优先显示 Alpha 通道，灰度设置暂时不生效。</p>
                </template>
              </div>

              <div class="gray-section">
                <div class="gray-section-title">画布背景</div>
                <SegmentedControl
                  :model-value="viewState.backdrop"
                  :options="backdropOptions"
                  size="sm"
                  block
                  @update:model-value="viewActions.setBackdrop($event)"
                />

                <template v-if="viewState.backdrop === 'solid'">
                  <div class="gray-color-row is-backdrop">
                    <input
                      class="gray-color"
                      type="color"
                      :value="viewState.backdropColor"
                      title="选择画布背景色"
                      @input="viewActions.setBackdropColor($event.target.value)"
                    />
                    <input
                      v-model="backdropHex"
                      class="gray-hex mono"
                      type="text"
                      maxlength="7"
                      spellcheck="false"
                      title="也可直接输入十六进制颜色"
                      @change="applyBackdropHex"
                      @keydown.enter.prevent="applyBackdropHex"
                    />
                  </div>

                  <div class="gray-presets">
                    <button
                      v-for="preset in backdropPresets"
                      :key="preset.hex"
                      class="gray-preset is-square"
                      :class="{ 'is-active': viewState.backdropColor === preset.hex }"
                      :style="{ background: preset.hex }"
                      type="button"
                      :title="preset.label"
                      @click="viewActions.setBackdropColor(preset.hex)"
                    />
                  </div>

                  <p class="gray-hint">纯色背景只在图片工作区生效，用来检查边缘和明暗；导出仍然保留原图透明通道。</p>
                </template>
              </div>
            </div>
          </div>
          <span class="mode-divider" />
        </template>

        <template v-if="activeTool === 'crop'">
          <SegmentedControl
            :model-value="state.engine"
            :options="engineOptions"
            size="sm"
            @update:model-value="actions.setEngine($event)"
          />
        </template>
        <template v-else-if="activeTool === 'watermark'">
          <SegmentedControl
            :model-value="watermarkState.options.engine"
            :options="watermarkEngineOptions"
            size="sm"
            @update:model-value="watermarkActions.setOption('engine', $event)"
          />
          <span class="engine-hint muted" :title="watermarkHint">{{ watermarkHint }}</span>
        </template>
        <template v-else-if="mode === 'video'">
          <span class="engine-hint muted">
            {{ videoState.health.checked ? (videoState.health.ok ? 'FFmpeg 就绪' : 'FFmpeg 未就绪') : '正在检查 FFmpeg…' }}
          </span>
        </template>
        <template v-else-if="mode === 'audio'">
          <span class="engine-hint muted">
            {{ audioState.loading ? '正在解码…' : audioState.sampleRate ? `${(audioState.sampleRate / 1000).toFixed(1)}kHz · Web Audio` : 'Web Audio · 支持框选裁剪' }}
          </span>
        </template>
        <template v-else>
          <span class="mode-hint muted">{{ mode === 'image' ? currentTool.hint : currentMode.hint }}</span>
        </template>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: relative;
  z-index: 30;
  flex: none;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.topbar-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 48px;
  padding: 0 12px;
}

.topbar-modes {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 34px;
  padding: 0 12px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.topbar-left,
.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.topbar-left {
  flex: 1;
}

.topbar-right {
  flex: none;
}

.mode-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
}

.mode-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  white-space: nowrap;
  font-size: 11px;
}

.mode-tab:hover {
  background: var(--hover);
  color: var(--text);
}

.mode-tab.is-active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 500;
}

.mode-key {
  font-family: var(--mono);
  font-size: 9px;
  padding: 0 3px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
}

.mode-tab.is-active .mode-key {
  background: var(--accent);
  color: #fff;
}

.mode-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  max-width: 42%;
}

.engine-hint,
.mode-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

/* 灰度查看：弹出面板，只作用于舞台画布的显示，不写入素材 */
.gray-view-wrap {
  position: relative;
}

.gray-toggle.is-on {
  color: var(--accent);
}

.gray-toggle.is-open {
  background: var(--hover);
}

.gray-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.gray-dot.is-on {
  background: var(--accent);
}

.gray-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  width: 252px;
  padding: 10px 12px 12px;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.gray-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
}

.gray-close {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
}

.gray-close:hover {
  background: var(--hover);
  color: var(--text);
}

.gray-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--text-2);
  font-size: 11px;
}

.gray-switch input {
  accent-color: var(--accent);
}

.gray-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.gray-color {
  width: 32px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  cursor: pointer;
}

.gray-hex {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.gray-hex:focus {
  outline: none;
  border-color: var(--accent);
}

.gray-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.gray-preset {
  width: 20px;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}

.gray-preset.is-active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.gray-hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.gray-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.gray-section-title {
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 500;
}

.gray-color-row.is-backdrop {
  margin-top: 8px;
}

.gray-preset.is-square {
  border-radius: 4px;
}

.mode-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
}

.logo {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
}

.brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
}

.doc {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.doc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.doc-meta {
  font-size: 11px;
  white-space: nowrap;
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background 0.15s ease;
}

.session-dot.is-saved {
  background: var(--accent);
}

.session-dot.is-saving {
  background: #e8a33d;
}
</style>
