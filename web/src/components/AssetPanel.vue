<script setup>
/** 左侧素材列表（对应 Figma 的图层/资源面板）。 */
import { computed } from 'vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { formatBytes, formatRatio } from '../lib/imaging.js';

const { state, selected, stats, actions } = useWorkspace();

const items = computed(() => state.items);

function savedRatio(item) {
  if (!item.bounds || item.resultEmpty) return null;
  const before = item.width * item.height;
  const after = item.bounds.width * item.bounds.height;
  if (!before) return null;
  return Math.max(0, 1 - after / before);
}

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
  <aside class="assets panel">
    <div class="panel-title">
      <span>素材</span>
      <span class="muted">{{ stats.total }}</span>
    </div>

    <div class="assets-list">
      <p v-if="items.length === 0" class="assets-empty muted">
        还没有素材。<br />拖拽图片到画布，或点击下方按钮导入。
      </p>

      <button
        v-for="item in items"
        :key="item.id"
        class="asset"
        :class="{ 'is-active': selected && selected.id === item.id, 'is-empty': item.resultEmpty }"
        type="button"
        @click="actions.selectItem(item.id)"
      >
        <span class="asset-thumb">
          <img :src="item.thumbnail" :alt="item.name" />
        </span>
        <span class="asset-body">
          <span class="asset-name" :title="item.name">{{ item.name }}</span>
          <span class="asset-dims mono">
            <template v-if="item.bounds && !item.resultEmpty">
              {{ item.width }}×{{ item.height }} → {{ item.bounds.width }}×{{ item.bounds.height }}
            </template>
            <template v-else-if="item.resultEmpty">整张透明，无可裁剪内容</template>
            <template v-else>{{ item.width }}×{{ item.height }}</template>
          </span>
          <span class="asset-tags">
            <span v-if="savedRatio(item) !== null" class="tag is-accent">
              裁掉 {{ formatRatio(savedRatio(item), 0) }}
            </span>
            <span class="tag">{{ formatBytes(item.bytes) }}</span>
            <span v-if="state.options.matchColor" class="tag">颜色抠底</span>
          </span>
        </span>
        <span class="asset-remove" title="移除" @click.stop="actions.removeItem(item.id)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </span>
      </button>
    </div>

    <div class="assets-footer">
      <button class="btn is-block" type="button" :disabled="state.busy" @click="pickFiles">导入图片</button>
      <button class="btn is-block" type="button" :disabled="state.busy" @click="actions.loadSamples()">
        载入示例
      </button>
      <button class="btn is-block is-ghost" type="button" :disabled="state.busy || !items.length" @click="actions.clearItems()">
        清空
      </button>
    </div>
  </aside>
</template>

<style scoped>
.assets {
  display: flex;
  flex-direction: column;
  width: 252px;
  flex: none;
  border-right: 1px solid var(--border);
}

.assets-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.assets-empty {
  margin: 16px 10px;
  font-size: 11px;
  line-height: 1.7;
}

.asset {
  position: relative;
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 6px;
  margin-bottom: 2px;
  text-align: left;
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition: background 0.12s ease;
}

.asset:hover {
  background: var(--hover);
}

.asset.is-active {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.45);
}

.asset.is-empty .asset-dims {
  color: var(--warn);
}

.asset-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  background-color: var(--checker-a);
  overflow: hidden;
}

.asset-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.asset-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.asset-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.asset-dims {
  font-size: 10px;
  color: var(--text-muted);
}

.asset-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-2);
  color: var(--text-muted);
  font-size: 10px;
}

.tag.is-accent {
  background: var(--accent-soft);
  color: var(--accent);
}

.asset-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--text-muted);
}

.asset:hover .asset-remove {
  display: grid;
}

.asset-remove:hover {
  color: var(--danger);
}

.assets-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
</style>
