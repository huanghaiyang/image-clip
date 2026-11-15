<script setup>
/**
 * 图片处理 · 编辑历史（垂直时间轴 + 前后对比）
 * --------------------------------------------
 * 左下角浮动按钮展开：每一步都有缩略图，点击即可回到那一步（跨工具 undo/redo）；
 * 「对比」切换后显示「修改前 / 修改后」两张图，可拖动分界线叠加查看。
 */
import { computed } from 'vue';

import { useEditTimeline } from '../composables/useEditTimeline.js';
import { useUndo } from '../composables/useUndo.js';

const { state, selectedStep, selectedIndex, comparePair, actions } = useEditTimeline();
const { canUndo, canRedo, actions: undoActions } = useUndo();

const rows = computed(() => state.entries.slice().reverse());

const blend = computed(() => {
  // 用选中步骤在时间轴里的位置控制对比图透明度：选得越靠前，越偏向「修改前」
  const index = selectedIndex.value;
  if (index < 0) return 0.5;
  const before = state.entries[index]?.thumb;
  const after = state.entries[state.entries.length - 1]?.thumb;
  if (before && after && before === after) return 0.5;
  return Math.round(((index + 1) / Math.max(2, state.entries.length)) * 100) / 100;
});

function timeText(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function restore(entry) {
  actions.restore(entry.id);
}
</script>

<template>
  <div class="et-root">
    <button class="et-toggle" type="button" :class="{ 'is-open': state.open }" title="编辑历史 / 前后对比" @click="actions.toggle()">
      历史 {{ state.entries.length }}
    </button>

    <aside v-if="state.open" class="et-panel">
      <header class="et-head">
        <span class="et-title">编辑历史</span>
        <div class="et-head-actions">
          <button class="btn is-mini is-ghost" type="button" :disabled="!canUndo" :title="'撤销上一步编辑'" @click="undoActions.undo()">撤销</button>
          <button class="btn is-mini is-ghost" type="button" :disabled="!canRedo" :title="'重做下一步编辑'" @click="undoActions.redo()">重做</button>
          <button class="btn is-mini" type="button" :class="{ 'is-on': state.compare }" @click="actions.toggleCompare()">对比</button>
          <button class="et-close" type="button" title="关闭" @click="actions.toggle()">×</button>
        </div>
      </header>

      <div v-if="state.compare" class="et-compare">
        <div class="et-compare-row">
          <figure class="et-figure">
            <img v-if="comparePair.before?.thumb" :src="comparePair.before.thumb" alt="" />
            <span v-else class="et-nothumb muted">起始</span>
            <figcaption>修改前</figcaption>
          </figure>
          <figure class="et-figure is-after">
            <img v-if="comparePair.after?.thumb" :src="comparePair.after.thumb" alt="" :style="{ opacity: blend }" />
            <span v-else class="et-nothumb muted">最新</span>
            <figcaption>修改后</figcaption>
          </figure>
        </div>
        <p class="et-compare-hint muted">
          {{ selectedStep ? `第 ${selectedIndex + 1} 步：${selectedStep.label}` : '选择时间轴上的一步' }} ·
          透明度 {{ Math.round(blend * 100) }}%（叠加在修改前之上）
        </p>
      </div>

      <div class="et-list">
        <button
          v-for="(entry, index) in rows"
          :key="entry.id"
          class="et-step"
          :class="{ 'is-active': entry.id === state.selectedId }"
          type="button"
          :title="`${entry.label} · ${timeText(entry.at)} · 点击回到这一步`"
          @click="restore(entry)"
        >
          <span class="et-step-index mono">{{ state.entries.length - index }}</span>
          <span class="et-step-thumb">
            <img v-if="entry.thumb" :src="entry.thumb" :alt="entry.label" />
            <span v-else class="muted">—</span>
          </span>
          <span class="et-step-body">
            <span class="et-step-label">{{ entry.label }}</span>
            <span class="et-step-time mono">{{ timeText(entry.at) }}</span>
          </span>
        </button>
        <p v-if="!state.entries.length" class="et-empty muted">还没有编辑步骤：做一次操作（裁剪、擦除、去背景…）后会自动记录。</p>
      </div>

      <footer class="et-foot">
        <button class="btn is-mini is-ghost" type="button" :disabled="!state.entries.length" @click="actions.clear()">清空历史</button>
        <span class="muted">最多保留 40 步</span>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.et-root {
  /* 图片处理工作区：固定在舞台左下角（左侧素材栏 252px + 边距） */
  position: fixed;
  left: 264px;
  bottom: 46px;
  z-index: 40;
}

.et-toggle {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
  backdrop-filter: blur(4px);
}

.et-toggle:hover,
.et-toggle.is-open {
  border-color: var(--accent);
  color: var(--accent);
}

.et-panel {
  position: absolute;
  left: 0;
  bottom: 34px;
  display: flex;
  flex-direction: column;
  width: 268px;
  max-height: min(560px, 72vh);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
}

.et-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.et-title {
  font-size: 11px;
  font-weight: 600;
}

.et-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.et-close {
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.et-compare {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.et-compare-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.et-figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.et-figure img {
  display: block;
  width: 100%;
  height: 84px;
  object-fit: contain;
  background: #17181b;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.et-figure figcaption {
  font-size: 9px;
  color: var(--text-muted);
}

.et-figure.is-after img {
  transition: opacity 0.15s ease;
}

.et-compare-hint {
  margin: 6px 0 0;
  font-size: 9px;
}

.et-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.et-step {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--text-2);
}

.et-step:hover {
  background: var(--hover);
}

.et-step.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.et-step-index {
  flex: none;
  width: 16px;
  font-size: 9px;
  color: var(--text-muted);
  text-align: right;
}

.et-step-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 44px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #17181b;
  overflow: hidden;
  font-size: 9px;
}

.et-step-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.et-step-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.et-step-label {
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.et-step-time {
  font-size: 9px;
  color: var(--text-muted);
}

.et-empty {
  margin: 12px 8px;
  font-size: 10px;
  line-height: 1.5;
}

.et-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  font-size: 9px;
}
</style>
