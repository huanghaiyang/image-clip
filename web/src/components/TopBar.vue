<script setup>
/** 顶部工具栏：品牌、当前素材、引擎切换、导入入口、主题。 */
import { computed } from 'vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { ENGINES } from '../lib/engine.js';
import { formatBytes } from '../lib/imaging.js';

const { state, selected, stats, actions, meta } = useWorkspace();

const engineOptions = computed(() =>
  ENGINES.map((engine) => ({
    value: engine.value,
    label: engine.label,
    hint: engine.hint,
  })),
);

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
        :model-value="state.engine"
        :options="engineOptions"
        size="sm"
        @update:model-value="actions.setEngine($event)"
      />
    </div>

    <div class="topbar-right">
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
  flex: none;
}

.topbar-right {
  flex: 1;
  justify-content: flex-end;
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
