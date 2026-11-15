<script setup>
/**
 * 资源库目录选择弹窗
 * ------------------
 * 树形展示资源库目录（与左侧目录树同源），选中后返回相对路径；
 * 用于「关键帧保存位置」「音频/视频导出目录」等以前需要手填路径的地方。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useFolderPicker } from '../composables/useFolderPicker.js';
import { useLibrary } from '../composables/useLibrary.js';

const { state, actions } = useFolderPicker();
const { folderTree } = useLibrary();

const selected = ref('');
const collapsed = ref(new Set());

const rows = computed(() => {
  const list = [];
  // 根目录（如果允许）
  list.push({ key: 'root', path: '', name: '资源库根目录', depth: 0 });
  const folders = (folderTree.value ?? []).filter((folder) => !folder.isRoot);
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  const visible = (folder) => {
    let parent = folder.parent ?? '';
    while (parent) {
      if (collapsed.value.has(parent)) return false;
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
    }
    return true;
  };
  for (const folder of sorted) {
    if (!visible(folder)) continue;
    const depth = Math.max(1, Number(folder.depth) || 0);
    list.push({ key: folder.path, path: folder.path, name: folder.name, depth: depth + (state.allowRoot ? 1 : 0) });
  }
  return list;
});

const hasChildren = computed(() => {
  const map = new Set();
  for (const folder of folderTree.value ?? []) {
    if (folder.isRoot) continue;
    const parent = folder.parent ?? '';
    if (parent) map.add(parent);
  }
  return map;
});

function toggle(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

function pick(path) {
  selected.value = path;
}

function confirm() {
  actions.submit(selected.value);
}

// 每次打开时默认选中当前值
watch(
  () => state.open,
  (open) => {
    if (open) selected.value = state.value ?? '';
  },
  { immediate: true },
);

function onKeydown(event) {
  if (!state.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  actions.cancel();
}

onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="fp-mask" @click.self="actions.cancel()">
      <div class="fp-dialog" role="dialog" aria-modal="true" aria-label="选择保存位置">
        <header class="fp-head">
          <h2>{{ state.title || '选择保存位置' }}</h2>
          <button class="fp-close" type="button" title="关闭 (Esc)" @click="actions.cancel()">×</button>
        </header>
        <p v-if="state.detail" class="fp-detail">{{ state.detail }}</p>

        <div class="fp-list">
          <div
            v-for="row in rows"
            :key="row.key"
            class="fp-row"
            :class="{ 'is-active': selected === row.path, 'is-root': row.path === '' }"
            :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
            role="button"
            tabindex="0"
            @click="pick(row.path)"
            @dblclick="pick(row.path); confirm()"
            @keydown.enter.prevent="pick(row.path); confirm()"
          >
            <span
              v-if="hasChildren.has(row.path)"
              class="fp-chev"
              :class="{ 'is-open': !collapsed.has(row.path) }"
              role="button"
              :title="collapsed.has(row.path) ? '展开' : '折叠'"
              @click.stop="toggle(row.path)"
              >›</span
            >
            <span v-else class="fp-chev is-empty"></span>
            <span class="fp-icon" aria-hidden="true">▣</span>
            <span class="fp-name" :title="row.path">{{ row.name }}</span>
          </div>
          <p v-if="rows.length <= 1" class="fp-empty muted">资源库里还没有子目录，默认保存到根目录。</p>
        </div>

        <footer class="fp-foot">
          <span class="fp-current mono" :title="selected">资源库/{{ selected }}</span>
          <div class="fp-actions">
            <button class="btn is-mini is-ghost" type="button" @click="actions.cancel()">取消</button>
            <button class="btn is-mini is-primary" type="button" @click="confirm">选择这个目录</button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fp-mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.fp-dialog {
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: min(620px, 86vh);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}

.fp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.fp-head h2 {
  flex: 1;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.fp-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.fp-close:hover {
  background: var(--hover);
  color: var(--text);
}

.fp-detail {
  margin: 10px 14px 0;
  font-size: 10px;
  color: var(--text-muted);
}

.fp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.fp-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-2);
}

.fp-row:hover {
  background: var(--hover);
}

.fp-row.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.fp-row.is-root {
  font-weight: 600;
}

.fp-chev {
  flex: none;
  width: 12px;
  text-align: center;
  color: var(--text-muted);
  transition: transform 0.12s ease;
}

.fp-chev.is-open {
  transform: rotate(90deg);
}

.fp-chev.is-empty {
  visibility: hidden;
}

.fp-icon {
  flex: none;
  color: var(--text-muted);
  font-size: 10px;
}

.fp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-empty {
  margin: 12px 8px;
  font-size: 10px;
}

.fp-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.fp-current {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-muted);
}

.fp-actions {
  display: flex;
  gap: 8px;
}
</style>
