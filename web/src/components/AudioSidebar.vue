<script setup>
/**
 * 音频工作区左侧栏：资源库音频列表 + 上传入口。
 *
 * 和视频工作区一样，音频必须先进入资源库：
 * 播放、频谱与裁剪后的 WAV 都围绕资源库里的文件进行，
 * 这样刷新或切换工作区后列表不会丢。
 */
import { computed, onMounted, ref } from 'vue';

import { useAudio } from '../composables/useAudio.js';
import { useLibrary } from '../composables/useLibrary.js';
import { openUploadPicker } from '../composables/useUploadPicker.js';
import { useResourceViewMode } from '../composables/useResourceViewMode.js';
import { formatDuration, formatSize } from '../lib/library.js';
import { buildResourceTree, collectFolderPaths, flattenResourceTree } from '../lib/resourceTree.js';
import ViewToggle from './ui/ViewToggle.vue';

const { state: libraryState, entries, actions: libraryActions } = useLibrary();
const { state, actions } = useAudio();

/** 只列资源库中的音频条目。 */
const audios = computed(() =>
  entries.value
    .filter((entry) => entry.kind === 'audio')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
);

const viewMode = useResourceViewMode('audio', 'flat');
const collapsed = ref(new Set());
const treeRoot = computed(() => buildResourceTree(audios.value));
const treeRows = computed(() => flattenResourceTree(treeRoot.value, collapsed.value));

function toggleFolder(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

/** 树中所有文件夹路径，用于「全部展开 / 全部折叠」。 */
const treeFolderPaths = computed(() => collectFolderPaths(treeRoot.value));

const allCollapsed = computed(
  () => treeFolderPaths.value.length > 0 && treeFolderPaths.value.every((path) => collapsed.value.has(path)),
);

function expandAllFolders() {
  collapsed.value = new Set();
}

function collapseAllFolders() {
  collapsed.value = new Set(treeFolderPaths.value);
}

const uploadText = computed(() => {
  const upload = libraryState.upload;
  if (!upload?.active) return '';
  const total = upload.total || 1;
  return `上传中 ${upload.index || 1}/${total}${upload.percent ? ` · ${upload.percent}%` : ''}`;
});

function pickFiles() {
  openUploadPicker({
    title: '导入音频',
    description: '音频会保存到资源库「音频」目录，上传后自动载入音频工作区',
    accept: 'audio/*',
    dest: 'library',
    dir: '音频',
    actionLabel: '上传',
    onUploaded: (uploaded) => {
      const first = uploaded.find((entry) => entry.kind === 'audio');
      if (first) void actions.selectAudio(first);
    },
  });
}

onMounted(() => {
  void libraryActions.refresh({ quiet: true });
});
</script>

<template>
  <aside class="sidebar panel">
    <div class="panel-title">
      <span>音频 · 资源库</span>
      <div class="title-actions">
        <ViewToggle v-model="viewMode" />
        <button
          class="btn is-ghost is-icon"
          type="button"
          title="刷新资源库列表"
          :disabled="libraryState.refreshing"
          @click="libraryActions.refresh({ quiet: true })"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M13 1.9v3.4h-3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="viewMode === 'tree' && audios.length" class="tree-tools">
      <button
        class="tree-tool"
        type="button"
        :disabled="!treeFolderPaths.length || collapsed.size === 0"
        @click="expandAllFolders"
      >
        全部展开
      </button>
      <button
        class="tree-tool"
        type="button"
        :disabled="!treeFolderPaths.length || allCollapsed"
        @click="collapseAllFolders"
      >
        全部折叠
      </button>
    </div>

    <div class="audio-list">
      <p v-if="audios.length === 0" class="list-empty muted">
        资源库里还没有音频。<br />可以上传音频，或在视频工作区提取音轨。
      </p>

      <template v-else-if="viewMode === 'flat'">
        <button
          v-for="entry in audios"
          :key="entry.path"
          class="audio-item"
          :class="{ 'is-active': state.activePath === entry.path }"
          type="button"
          :title="entry.path"
          @click="actions.selectAudio(entry)"
        >
          <span class="audio-icon" aria-hidden="true">♪</span>
          <span class="audio-body">
            <span class="audio-name">{{ entry.name }}</span>
            <span class="audio-meta mono">
              <template v-if="entry.duration">{{ formatDuration(entry.duration) }} · </template>{{ formatSize(entry.bytes) }}
            </span>
          </span>
        </button>
      </template>

      <!-- 树形视图：文件夹行点击展开/折叠，文件行沿用平铺列表样式 -->
      <template v-else>
        <template v-for="row in treeRows" :key="row.key">
          <button
            v-if="row.type === 'folder'"
            class="folder-row"
            type="button"
            :title="row.path"
            :style="{ paddingLeft: `${2 + row.depth * 14}px` }"
            @click="toggleFolder(row.path)"
          >
            <span class="chev" :class="{ 'is-open': !collapsed.has(row.path) }">›</span>
            <svg class="folder-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.8 4.1c0-.6.5-1.1 1.1-1.1h3l1.3 1.4h5.9c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.1Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
            <span class="folder-name">{{ row.name }}</span>
            <span class="folder-count mono">{{ row.count }}</span>
          </button>

          <button
            v-else
            class="audio-item"
            :class="{ 'is-active': state.activePath === row.path }"
            type="button"
            :title="row.path"
            :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
            @click="actions.selectAudio(row.entry)"
          >
            <span class="audio-icon" aria-hidden="true">♪</span>
            <span class="audio-body">
              <span class="audio-name">{{ row.name }}</span>
              <span class="audio-meta mono">
                <template v-if="row.entry.duration">{{ formatDuration(row.entry.duration) }} · </template>{{ formatSize(row.entry.bytes) }}
              </span>
            </span>
          </button>
        </template>
      </template>
    </div>

    <div class="sidebar-footer">
      <button class="btn is-block" type="button" :disabled="libraryState.busy" @click="pickFiles">
        {{ libraryState.upload?.active ? '上传中…' : '上传音频' }}
      </button>
      <p v-if="libraryState.upload?.active" class="upload-progress mono">{{ uploadText }}</p>
      <p v-if="state.loading" class="footer-hint muted">正在解码音频…</p>
      <p v-if="libraryState.error" class="error-text">{{ libraryState.error }}</p>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: 252px;
  flex: none;
  border-right: 1px solid var(--border);
}

.title-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 树形列表全部展开 / 全部折叠 */
.tree-tools {
  display: flex;
  gap: 4px;
  padding: 6px 8px 5px;
  flex: none;
  border-bottom: 1px solid var(--border);
}

.tree-tool {
  flex: 1;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-muted);
  font-size: 9px;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}

.tree-tool:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.tree-tool:disabled {
  opacity: 0.4;
  cursor: default;
}

.folder-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 26px;
  padding: 3px 6px;
  margin-bottom: 1px;
  border-radius: var(--radius-sm);
  text-align: left;
  cursor: pointer;
}

.folder-row:hover {
  background: var(--hover);
}

.chev {
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  transition: transform 0.12s ease;
}

.chev.is-open {
  transform: rotate(90deg);
}

.folder-icon {
  flex: none;
  color: var(--accent);
}

.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 11px;
}

.folder-count {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
  font-size: 9px;
}

.audio-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.list-empty {
  margin: 16px 10px;
  font-size: 11px;
  line-height: 1.7;
}

.audio-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 6px;
  margin-bottom: 2px;
  text-align: left;
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition: background 0.12s ease;
}

.audio-item:hover {
  background: var(--hover);
}

.audio-item.is-active {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.45);
}

.audio-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--accent);
  font-size: 14px;
  line-height: 1;
}

.audio-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.audio-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.audio-meta {
  font-size: 10px;
  color: var(--text-muted);
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  flex: none;
  border-top: 1px solid var(--border);
}

.upload-progress {
  margin: 0;
  color: var(--accent);
  font-size: 10px;
}

.footer-hint {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
}

.error-text {
  margin: 0;
  color: var(--danger);
  font-size: 10px;
  line-height: 1.5;
}
</style>
