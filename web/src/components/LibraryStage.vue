<script setup>
/**
 * 资源库中间舞台：面包屑 + 搜索/筛选 + 文件夹与文件网格 + 预览大图
 * ---------------------------------------------------------------
 * 交互约定：
 *  - 单击选中（Ctrl/Cmd 追加选择），双击打开（文件夹进入 / 图片预览 / 视频或音频切到对应工作区）；
 *  - 预览层支持 ← → 翻页、Esc 关闭；
 *  - 右键不处理，所有批量操作都在右侧检查器里。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { useAudio } from '../composables/useAudio.js';
import { setMode } from '../composables/useAppMode.js';
import { formatDuration, formatSize, libraryFileUrl, libraryThumbUrl } from '../lib/library.js';

const { state, currentEntries, currentFolders, breadcrumbs, canGoUp, previewEntry, previewIndex, previewList, actions } =
  useLibrary();
const { actions: videoActions } = useVideo();
const { actions: audioActions } = useAudio();

const KIND_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

const SORTS = [
  { value: 'name', label: '名称' },
  { value: 'mtime', label: '修改时间' },
  { value: 'size', label: '大小' },
  { value: 'kind', label: '类型' },
];

const KIND_ICON = { image: '▣', video: '▶', audio: '♪', file: '▤' };

const failedThumbs = ref(new Set());
const previewError = ref(false);

const selectedSet = computed(() => new Set(state.selected));
const totalVisible = computed(() => currentFolders.value.length + currentEntries.value.length);

const previewCount = computed(() => previewList.value.length);

function select(event, entry) {
  const meta = event.ctrlKey || event.metaKey;
  if (meta) actions.toggleSelect(entry.path);
  else actions.selectOnly(entry.path);
}

function openEntry(entry) {
  if (entry.kind === 'image') {
    actions.openPreview(entry.path);
    return;
  }
  if (entry.kind === 'video') {
    void openVideo(entry);
    return;
  }
  if (entry.kind === 'audio') void openAudio(entry);
}

async function openVideo(entry) {
  setMode('video');
  await videoActions.selectVideo(entry);
}

async function openAudio(entry) {
  setMode('audio');
  await audioActions.selectAudio(entry);
}

function onThumbError(path) {
  failedThumbs.value = new Set([...failedThumbs.value, path]);
}

function thumbOf(entry) {
  return failedThumbs.value.has(entry.path) ? '' : libraryThumbUrl(entry);
}

function entryMeta(entry) {
  const parts = [formatSize(entry.bytes)];
  if (entry.kind === 'image' && entry.width) parts.unshift(`${entry.width}×${entry.height}`);
  if (entry.kind === 'video') {
    if (entry.width) parts.unshift(`${entry.width}×${entry.height}`);
    if (entry.duration) parts.push(formatDuration(entry.duration));
  }
  if (entry.kind === 'audio' && entry.duration) parts.push(formatDuration(entry.duration));
  return parts.join(' · ');
}

function onPreviewKey(event) {
  if (!state.previewPath) return;
  if (event.key === 'Escape') actions.closePreview();
  else if (event.key === 'ArrowLeft') actions.stepPreview(-1);
  else if (event.key === 'ArrowRight') actions.stepPreview(1);
}

watch(
  () => state.previewPath,
  () => {
    previewError.value = false;
  },
);

onMounted(() => window.addEventListener('keydown', onPreviewKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKey));
</script>

<template>
  <section class="stage">
    <div class="toolbar">
      <button class="icon-btn" type="button" title="上一级" :disabled="!canGoUp" @click="actions.goUp()">←</button>
      <nav class="crumbs">
        <button
          v-for="(crumb, index) in breadcrumbs"
          :key="crumb.path || '__root__'"
          class="crumb"
          type="button"
          @click="actions.setDir(crumb.path)"
        >
          {{ crumb.name }}<span v-if="index < breadcrumbs.length - 1" class="crumb-sep">/</span>
        </button>
      </nav>
      <input
        class="search"
        type="search"
        placeholder="搜索文件名 / 路径"
        :value="state.search"
        @input="actions.setSearch($event.target.value)"
      />
    </div>

    <div class="subbar">
      <div class="segmented">
        <button
          v-for="item in KIND_FILTERS"
          :key="item.value"
          class="seg"
          :class="{ 'is-active': state.kindFilter === item.value }"
          type="button"
          @click="actions.setKindFilter(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
      <label class="sort">
        <span>排序</span>
        <select class="select" :value="state.sort" @change="actions.setSort($event.target.value)">
          <option v-for="item in SORTS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <span class="count mono">{{ totalVisible }} 项</span>
      <div class="spacer" />
      <button class="btn is-mini is-ghost" type="button" :disabled="!totalVisible" @click="actions.selectAllVisible()">
        全选
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="!state.selected.length" @click="actions.clearSelection()">
        清除选择
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="state.refreshing" @click="actions.refresh()">刷新</button>
    </div>

    <div class="grid-wrap">
      <div v-if="state.loading && !state.initialized" class="placeholder">正在读取资源库…</div>
      <div v-else-if="!totalVisible" class="placeholder">
        <div class="placeholder-title">{{ state.search ? '没有匹配的文件' : '这个目录还是空的' }}</div>
        <div class="placeholder-hint">
          上传图片或视频，或在视频工作区截取关键帧 —— 关键帧会默认保存到「关键帧/视频名/」。
        </div>
      </div>
      <div v-else class="grid">
        <button
          v-for="folder in currentFolders"
          :key="`folder:${folder.path}`"
          class="card is-folder"
          :class="{ 'is-selected': selectedSet.has(folder.path) }"
          type="button"
          @click="select($event, folder)"
          @dblclick="actions.openFolder(folder)"
        >
          <span class="folder-icon">▸</span>
          <span class="card-name" :title="folder.name">{{ folder.name }}</span>
          <span class="card-meta">文件夹</span>
        </button>

        <button
          v-for="entry in currentEntries"
          :key="entry.path"
          class="card"
          :class="{ 'is-selected': selectedSet.has(entry.path) }"
          type="button"
          :title="entry.path"
          @click="select($event, entry)"
          @dblclick="openEntry(entry)"
        >
          <span class="thumb">
            <img
              v-if="thumbOf(entry)"
              :src="thumbOf(entry)"
              alt=""
              loading="lazy"
              @error="onThumbError(entry.path)"
            />
            <span v-else class="thumb-icon">{{ KIND_ICON[entry.kind] ?? '▤' }}</span>
            <span v-if="entry.kind === 'video'" class="badge-video">▶</span>
          </span>
          <span class="card-name" :title="entry.name">{{ entry.name }}</span>
          <span class="card-meta mono">{{ entryMeta(entry) }}</span>
        </button>
      </div>
    </div>

    <!-- 预览层 -->
    <div v-if="previewEntry" class="preview">
      <div class="preview-head">
        <span class="preview-name" :title="previewEntry.path">{{ previewEntry.name }}</span>
        <span class="preview-count mono">{{ previewIndex + 1 }} / {{ previewCount }}</span>
        <button class="icon-btn" type="button" title="关闭 (Esc)" @click="actions.closePreview()">×</button>
      </div>
      <div class="preview-body">
        <button class="nav-btn prev" type="button" title="上一张 (←)" @click="actions.stepPreview(-1)">‹</button>
        <img
          v-if="previewEntry.kind === 'image' && !previewError"
          class="preview-media"
          :src="libraryFileUrl(previewEntry)"
          alt=""
          @error="previewError = true"
        />
        <video
          v-else-if="previewEntry.kind === 'video'"
          class="preview-media"
          :src="libraryFileUrl(previewEntry)"
          controls
          autoplay
        />
        <audio v-else-if="previewEntry.kind === 'audio'" class="preview-audio" :src="libraryFileUrl(previewEntry)" controls autoplay />
        <div v-else class="preview-fallback">无法预览这个文件</div>
        <button class="nav-btn next" type="button" title="下一张 (→)" @click="actions.stepPreview(1)">›</button>
      </div>
      <div class="preview-foot">
        <span class="mono">{{ entryMeta(previewEntry) }}</span>
        <button
          v-if="previewEntry.kind === 'image'"
          class="btn is-mini"
          type="button"
          @click="actions.openInEditor(previewEntry)"
        >
          转入编辑
        </button>
        <button v-else-if="previewEntry.kind === 'video'" class="btn is-mini" type="button" @click="openVideo(previewEntry)">
          在视频工作区打开
        </button>
        <button v-else-if="previewEntry.kind === 'audio'" class="btn is-mini" type="button" @click="openAudio(previewEntry)">
          在音频工作区打开
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

.crumb {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.crumb:hover {
  color: var(--accent);
}

.crumb-sep {
  margin: 0 3px;
  color: var(--text-muted);
}

.search {
  margin-left: auto;
  width: 200px;
  height: 24px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
}

.subbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 10px;
  color: var(--text-muted);
}

.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.seg {
  padding: 3px 9px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
}

.seg + .seg {
  border-left: 1px solid var(--border);
}

.seg.is-active {
  background: var(--accent-soft, rgba(90, 160, 255, 0.16));
  color: var(--text);
}

.sort {
  display: flex;
  align-items: center;
  gap: 5px;
}

.select {
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-2);
  font-size: 10px;
}

.spacer {
  flex: 1;
}

.grid-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.card:hover {
  border-color: var(--text-muted);
}

.card.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.card.is-folder {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  height: 46px;
  padding: 0 10px;
  background: var(--panel-2);
}

.folder-icon {
  color: var(--accent);
  font-size: 12px;
}

.card.is-folder .card-name {
  flex: 1;
}

.card.is-folder .card-meta {
  flex: none;
}

.thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 4px;
  background: repeating-conic-gradient(var(--panel-3) 0% 25%, var(--panel-2) 0% 50%) 50% / 12px 12px;
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-icon {
  font-size: 22px;
  color: var(--text-muted);
}

.badge-video {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
}

.card-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 11px;
}

.card-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 9px;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
  font-size: 11px;
  text-align: center;
  padding: 24px;
}

.placeholder-title {
  color: var(--text-2);
  font-size: 13px;
}

.placeholder-hint {
  max-width: 360px;
  line-height: 1.6;
}

.preview {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.86);
  z-index: 20;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: #eee;
  font-size: 11px;
}

.preview-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-count {
  color: #aaa;
}

.preview-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 48px;
}

.preview-media {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-audio {
  width: min(520px, 90%);
}

.preview-fallback {
  color: #aaa;
  font-size: 12px;
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 34px;
  height: 56px;
  border: 0;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 22px;
  cursor: pointer;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.nav-btn.prev {
  left: 8px;
}

.nav-btn.next {
  right: 8px;
}

.preview-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  color: #bbb;
  font-size: 10px;
}
</style>
