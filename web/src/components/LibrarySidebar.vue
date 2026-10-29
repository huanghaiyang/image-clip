<script setup>
/**
 * 资源库左侧：目录树 + 上传 + 新建文件夹
 * --------------------------------------
 * 目录树直接用服务端返回的扁平文件夹列表（每个条目带 parent/depth），
 * 前端不再递归建树 —— 这样搜索、批量移动都不需要遍历 UI 结构。
 */
import { computed, ref } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useRenamePrompt } from '../composables/useRenamePrompt.js';
import { openUploadPicker } from '../composables/useUploadPicker.js';
import { formatSize } from '../lib/library.js';

const { state, folderTree, currentFolders, currentEntries, stats, actions } = useLibrary();
const { actions: renameActions } = useRenamePrompt();

const creating = ref(false);
const folderName = ref('');

/** 每层缩进 12px，根节点不缩进。 */
function indentOf(folder) {
  return `${Math.max(0, folder.depth) * 12}px`;
}

/** 当前目录下的直接子文件夹数量，用于树上显示计数。 */
const childCount = computed(() => {
  const map = new Map();
  for (const folder of currentFolders.value) map.set(folder.path, 1);
  return map;
});

/** 当前目录就是上传目标，弹窗里仍可改子目录。 */
function upload() {
  openUploadPicker({
    title: '上传到资源库',
    description: '文件会写入下面的目标目录，图片、视频、音频都会自动分类',
    accept: 'image/*,video/*,audio/*',
    dest: 'library',
    dir: state.currentDir,
    actionLabel: '上传',
  });
}

async function submitFolder() {
  const name = folderName.value.trim();
  if (!name) return;
  const folder = await actions.createFolder(name);
  if (folder) {
    creating.value = false;
    folderName.value = '';
    actions.setDir(folder.path);
  }
}

/** 目录树上的重命名入口；根目录不可改名。 */
function renameFolder(folder) {
  renameActions.open(folder, true);
}
</script>

<template>
  <aside class="sidebar">
    <div class="panel-head">
      <div>
        <div class="panel-title">资源库</div>
        <div class="panel-sub">{{ stats.files }} 文件 · {{ stats.folders }} 目录 · {{ formatSize(stats.bytes) }}</div>
      </div>
      <div class="head-actions">
        <button class="icon-btn" type="button" title="刷新" :disabled="state.refreshing" @click="actions.refresh()">
          ⟳
        </button>
        <button class="icon-btn" type="button" title="上传文件" :disabled="state.busy" @click="upload">
          ↑
        </button>
      </div>
    </div>

    <div class="dirlabel">
      <span class="dirlabel-text" :title="state.currentDir || '资源库根目录'">
        {{ state.currentDir || '根目录' }}
      </span>
      <span class="dirlabel-count">{{ currentFolders.length }} 夹 / {{ currentEntries.length }} 文件</span>
    </div>

    <div class="tree">
      <button
        v-for="folder in folderTree"
        :key="folder.path || '__root__'"
        class="tree-row"
        :class="{ 'is-active': folder.path === state.currentDir, 'is-root': folder.isRoot }"
        type="button"
        :style="{ paddingLeft: folder.isRoot ? '10px' : indentOf(folder) }"
        :title="folder.path || '资源库根目录'"
        @click="actions.setDir(folder.path)"
      >
        <span class="tree-icon">{{ folder.isRoot ? '⌂' : '▸' }}</span>
        <span class="tree-name">{{ folder.name }}</span>
        <span
          v-if="!folder.isRoot"
          class="tree-rename"
          role="button"
          title="重命名文件夹"
          @click.stop="renameFolder(folder)"
          >✎</span
        >
        <span v-if="childCount.has(folder.path)" class="tree-badge">·</span>
      </button>
      <div v-if="folderTree.length <= 1" class="tree-empty">还没有子目录，可在下方新建</div>
    </div>

    <div class="footer">
      <div v-if="state.upload.active" class="upload-line">
        <span class="upload-name" :title="state.upload.name">{{ state.upload.name }}</span>
        <span class="mono">{{ state.upload.index }}/{{ state.upload.total }} · {{ state.upload.percent }}%</span>
      </div>
      <div v-else-if="creating" class="new-folder">
        <input
          v-model="folderName"
          class="text-input"
          placeholder="文件夹名称"
          @keydown.enter.prevent="submitFolder"
          @keydown.esc="creating = false"
        />
        <button class="btn is-mini" type="button" @click="submitFolder">创建</button>
      </div>
      <div v-else class="footer-actions">
        <button class="btn is-mini is-ghost" type="button" @click="creating = true">+ 新建文件夹</button>
        <button class="btn is-mini" type="button" :disabled="state.busy" @click="upload">上传</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: 252px;
  flex: none;
  min-height: 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.panel-sub {
  margin-top: 3px;
  font-size: 10px;
  color: var(--text-muted);
}

.head-actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.dirlabel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-muted);
}

.dirlabel-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.dirlabel-count {
  flex: none;
  font-family: var(--mono);
}

.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 6px 10px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.tree-row:hover {
  background: var(--panel-2);
}

.tree-row.is-active {
  background: var(--accent-soft, rgba(90, 160, 255, 0.14));
  color: var(--text);
}

.tree-icon {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--text-muted);
}

.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-badge {
  flex: none;
  color: var(--accent);
}

.tree-rename {
  flex: none;
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1;
  opacity: 0.5;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.tree-rename:hover {
  opacity: 1;
  background: var(--panel-3);
  color: var(--accent);
}

.tree-empty {
  padding: 8px;
  font-size: 10px;
  color: var(--text-muted);
}

.footer {
  flex: none;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}

.footer-actions {
  display: flex;
  gap: 6px;
}

.footer-actions .btn {
  flex: 1;
}

.upload-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  color: var(--text-2);
}

.upload-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-folder {
  display: flex;
  gap: 6px;
}

.text-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
}

.mono {
  font-family: var(--mono);
}
</style>
