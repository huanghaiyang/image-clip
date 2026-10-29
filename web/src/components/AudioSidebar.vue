<script setup>
/**
 * 音频工作区左侧栏：资源库音频列表 + 上传入口。
 *
 * 和视频工作区一样，音频必须先进入资源库：
 * 播放、频谱与裁剪后的 WAV 都围绕资源库里的文件进行，
 * 这样刷新或切换工作区后列表不会丢。
 */
import { computed, onMounted } from 'vue';

import { useAudio } from '../composables/useAudio.js';
import { useLibrary } from '../composables/useLibrary.js';
import { openUploadPicker } from '../composables/useUploadPicker.js';
import { formatDuration, formatSize } from '../lib/library.js';

const { state: libraryState, entries, actions: libraryActions } = useLibrary();
const { state, actions } = useAudio();

/** 只列资源库中的音频条目。 */
const audios = computed(() =>
  entries.value
    .filter((entry) => entry.kind === 'audio')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
);

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

    <div class="audio-list">
      <p v-if="audios.length === 0" class="list-empty muted">
        资源库里还没有音频。<br />可以上传音频，或在视频工作区提取音轨。
      </p>

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
