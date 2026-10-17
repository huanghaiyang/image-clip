<script setup>
/** 顶部工具栏：品牌、当前素材、模式/引擎切换、导入入口、主题。 */
import { computed } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { useWatermark } from '../composables/useWatermark.js';
import { useLlmChat } from '../composables/useLlmChat.js';
import { ENGINES } from '../lib/engine.js';
import { formatBytes } from '../lib/imaging.js';
import { SERVER_HINT } from '../lib/watermark.js';

const { state, selected, stats, actions, meta } = useWorkspace();
const { state: watermarkState, actions: watermarkActions } = useWatermark();
const { state: llmState, actions: llmActions } = useLlmChat();

const MODES = [
  { value: 'crop', label: '透明裁剪', hint: '检测 AABB 透明区域并裁剪' },
  { value: 'watermark', label: '水印去除', hint: '识别水印掩膜并做内容修复' },
];

/**
 * 水印模式的引擎取自 health 能力报告（缺项时退回契约里固定的三个值）。
 * 后端把 unblend 与 opencv 都归为“本地 OpenCV”一类，但 value 原样透传，
 * 后端仍然能区分是反混合还是修补。
 */
const WATERMARK_ENGINES = {
  auto: { label: '自动', hint: '按可用性自动挑选去除引擎' },
  unblend: { label: '本地 OpenCV', hint: '半透明水印反混合，推荐首选' },
  opencv: { label: 'OpenCV 修补', hint: 'Telea/NS 修补，适合细笔画、不透明水印' },
  lama: { label: 'LaMa 深度', hint: '深度模型修复，复杂纹理最好，显存占用高' },
};

const engineOptions = computed(() =>
  ENGINES.map((engine) => ({
    value: engine.value,
    label: engine.label,
    hint: engine.hint,
  })),
);

const watermarkEngineOptions = computed(() => {
  const list = watermarkState.health.checked ? watermarkState.health.engines : [];
  const usable = list.length ? list : Object.keys(WATERMARK_ENGINES);
  return usable.map((value) => ({ value, ...(WATERMARK_ENGINES[value] ?? { label: value }) }));
});

const engineHint = computed(() => {
  if (!watermarkState.health.checked) return '正在检查水印服务…';
  if (!watermarkState.health.ok) return SERVER_HINT;
  const { lama, lamaBytes, opencv } = watermarkState.health;
  const parts = [opencv ? 'OpenCV 就绪' : 'OpenCV 不可用'];
  parts.push(lama ? `LaMa 就绪${lamaBytes ? `（${formatBytes(lamaBytes)}）` : ''}` : 'LaMa 未就绪');
  return parts.join(' · ');
});

const currentLabel = computed(() => {
  if (state.items.length === 0) return '未导入素材';
  if (!selected.value) return `${state.items.length} 张素材`;
  return selected.value.name;
});

function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => actions.addFiles(input.files);
  input.click();
}
</script>

<template>
  <header class="topbar">
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
        <span class="doc-name">{{ currentLabel }}</span>
        <span class="doc-meta muted">
          {{ stats.total }} 张 · {{ stats.ready }} 张可裁剪
          <template v-if="stats.sourceBytes"> · {{ formatBytes(stats.sourceBytes) }}</template>
        </span>
      </div>
    </div>

    <div class="topbar-center">
      <SegmentedControl
        :model-value="watermarkState.mode"
        :options="MODES"
        size="sm"
        @update:model-value="watermarkActions.setMode($event)"
      />
      <span class="divider" />
      <!-- 两种模式的引擎语义完全不同：裁剪模式是“在哪算”，水印模式是“用什么算法修”，因此按模式替换而不是并排 -->
      <SegmentedControl
        v-if="watermarkState.mode === 'crop'"
        :model-value="state.engine"
        :options="engineOptions"
        size="sm"
        @update:model-value="actions.setEngine($event)"
      />
      <template v-else>
        <SegmentedControl
          :model-value="watermarkState.options.engine"
          :options="watermarkEngineOptions"
          size="sm"
          @update:model-value="watermarkActions.setOption('engine', $event)"
        />
        <span class="engine-hint muted" :title="engineHint">{{ engineHint }}</span>
      </template>
    </div>

    <div class="topbar-right">
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
      <button class="btn" type="button" :disabled="state.busy" @click="actions.loadSamples()">载入示例</button>
      <button class="btn is-primary" type="button" :disabled="state.busy" @click="pickFiles">导入图片</button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 48px;
  padding: 0 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
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

.topbar-center {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.topbar-right {
  flex: 1;
  justify-content: flex-end;
}

.engine-hint {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
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
</style>
