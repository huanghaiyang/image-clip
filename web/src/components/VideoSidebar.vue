<script setup>
/**
 * 视频工作区左侧栏：资源库视频列表 + 上传入口 + FFmpeg 健康状态。
 *
 * 为什么视频必须先进入资源库：
 *   `<video>` 的播放地址走 `/api/library/file`（服务端支持 HTTP Range，才能流畅拖动进度条），
 *   关键帧与音频也默认写回资源库。因此这里直接复用 useLibrary 的 entries / uploadFiles，
 *   不在前端维护第二份“最近打开”的临时文件列表，避免刷新后丢失。
 */
import { computed, onMounted, ref } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { openUploadPicker } from '../composables/useUploadPicker.js';
import { formatDuration, formatSize, libraryThumbUrl } from '../lib/library.js';

const { state: libraryState, entries, actions: libraryActions } = useLibrary();
const { state, actions } = useVideo();

/**
 * 缩略图加载失败的条目路径。
 * 视频缩略图由服务端 FFmpeg 生成，FFmpeg 缺失或首次生成失败时会 404，
 * 这里退回「▶ 占位块」，而不是让列表出现一堆破图。
 */
const failedThumbs = ref([]);

/** 只列资源库中的视频（图片/音频不参与视频工作区）。 */
const videos = computed(() =>
  entries.value
    .filter((entry) => entry.kind === 'video')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
);

const healthReady = computed(() => Boolean(state.health.ffmpeg?.available));

/** 只取版本号主体：完整的 "ffmpeg version 7.x ..." 在 252px 侧栏里会被截成无意义片段。 */
const ffmpegVersion = computed(() => {
  const version = state.health.ffmpeg?.version || '';
  const matched = version.match(/version\s+([^\s]+)/i);
  return matched ? matched[1] : version;
});

const healthText = computed(() => {
  if (!state.health.checked) return '正在检测 FFmpeg…';
  if (healthReady.value) return `FFmpeg ${ffmpegVersion.value}`.trim();
  return 'FFmpeg 未就绪';
});

/** 不可用时把服务端的 hint / error 放进 title，鼠标悬浮即可看到原因。 */
const healthTitle = computed(() => {
  if (!state.health.checked) return '正在检测服务端 FFmpeg';
  if (healthReady.value) return state.health.ffmpeg?.version || 'FFmpeg 可用';
  return state.health.error || state.health.ffmpeg?.hint || 'FFmpeg 不可用';
});

const healthDotClass = computed(() => {
  if (healthReady.value) return 'is-ok';
  return state.health.checked ? 'is-warn' : 'is-idle';
});

const uploadText = computed(() => {
  const upload = libraryState.upload;
  if (!upload?.active) return '';
  const total = upload.total || 1;
  return `上传中 ${upload.index || 1}/${total}${upload.percent ? ` · ${upload.percent}%` : ''}`;
});

function refreshList() {
  // quiet 刷新不显示整页 loading，列表只做原地更新，视频列表不会闪空
  void libraryActions.refresh({ quiet: true });
}

function pickFiles() {
  openUploadPicker({
    title: '导入视频',
    description: '视频会保存到资源库根目录，上传后自动在视频工作区打开',
    accept: 'video/*',
    dest: 'library',
    dir: '',
    actionLabel: '上传',
    onUploaded: (uploaded) => {
      const video = uploaded.find((entry) => entry.kind === 'video');
      if (video) void actions.selectVideo(video);
    },
  });
}

function onThumbError(path) {
  if (!failedThumbs.value.includes(path)) failedThumbs.value.push(path);
}

onMounted(() => {
  // checkHealth 内部有缓存；Stage/Panel 也会调用，这里只是让左栏立刻显示状态
  void actions.checkHealth();
  // 资源库可能尚未初始化（从其他工作区切过来），静默刷新一次
  void libraryActions.refresh({ quiet: true });
});
</script>

<template>
  <aside class="sidebar panel">
    <div class="panel-title">
      <span>视频 · 资源库</span>
      <button
        class="btn is-ghost is-icon"
        type="button"
        title="刷新资源库列表"
        :disabled="libraryState.refreshing"
        @click="refreshList"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path d="M13 1.9v3.4h-3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- FFmpeg 健康徽标：绿点=可用，黄点=不可用（悬浮看原因） -->
    <div class="health-strip" :title="healthTitle">
      <span class="dot" :class="healthDotClass" />
      <span class="health-text">{{ healthText }}</span>
    </div>

    <div class="video-list">
      <p v-if="videos.length === 0" class="list-empty muted">
        资源库里还没有视频。<br />请先在资源库上传视频。
      </p>

      <button
        v-for="entry in videos"
        :key="entry.path"
        class="video-item"
        :class="{ 'is-active': state.activePath === entry.path }"
        type="button"
        :title="entry.path"
        @click="actions.selectVideo(entry)"
      >
        <span class="video-thumb">
          <img
            v-if="libraryThumbUrl(entry) && !failedThumbs.includes(entry.path)"
            :src="libraryThumbUrl(entry)"
            :alt="entry.name"
            loading="lazy"
            @error="onThumbError(entry.path)"
          />
          <span v-else class="thumb-fallback" aria-hidden="true">▶</span>
        </span>
        <span class="video-body">
          <span class="video-name">{{ entry.name }}</span>
          <span class="video-meta mono">
            {{ formatDuration(entry.duration) }} · {{ formatSize(entry.bytes) }}
          </span>
        </span>
      </button>
    </div>

    <div class="sidebar-footer">
      <button class="btn is-block" type="button" :disabled="libraryState.busy" @click="pickFiles">
        {{ libraryState.upload?.active ? '上传中…' : '上传视频' }}
      </button>
      <p v-if="libraryState.upload?.active" class="upload-progress mono">{{ uploadText }}</p>
      <p v-if="videos.length === 0" class="footer-hint muted">请先在资源库上传视频。</p>
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

.health-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  flex: none;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
}

.dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--text-muted);
}

.dot.is-ok {
  background: var(--ok);
}

.dot.is-warn {
  background: var(--warn);
}

.health-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.list-empty {
  margin: 16px 10px;
  font-size: 11px;
  line-height: 1.7;
}

.video-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px;
  margin-bottom: 2px;
  text-align: left;
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition: background 0.12s ease;
}

.video-item:hover {
  background: var(--hover);
}

.video-item.is-active {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.45);
}

.video-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 56px;
  height: 34px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  overflow: hidden;
}

.video-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-fallback {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
}

.video-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.video-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.video-meta {
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
