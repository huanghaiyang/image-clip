<script setup>
/**
 * 底部状态栏
 * ----------
 * 不同工作区关注的运行状态不一样：
 *  - 图片类：Node 服务端 / 引擎 / 素材数量；
 *  - 资源库：文件与目录统计、上传状态；
 *  - 视频：FFmpeg 是否就绪、当前视频的帧率与时长。
 * 这里按模式挑一条最相关的提示显示，避免把 9 个状态都堆在 26px 里。
 */
import { computed } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useAppMode } from '../composables/useAppMode.js';
import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { useAudio } from '../composables/useAudio.js';
import { useCropTool } from '../composables/useCropTool.js';
import { useBgRemoval } from '../composables/useBgRemoval.js';
import { useEraser } from '../composables/useEraser.js';
import { usePixelPaint } from '../composables/usePixelPaint.js';
import { useWatermark } from '../composables/useWatermark.js';
import { formatBytes } from '../lib/imaging.js';
import { formatDuration, formatSize } from '../lib/library.js';

const { state, stats, meta } = useWorkspace();
const { state: appMode } = useAppMode();
const { state: libraryState, stats: libraryStats } = useLibrary();
const { state: videoState, duration, fps } = useVideo();
const { state: audioState } = useAudio();
const { state: cropState } = useCropTool();
const { state: bgState } = useBgRemoval();
const { state: eraserState } = useEraser();
const { state: pixelState } = usePixelPaint();
const { state: watermarkState } = useWatermark();

const mode = computed(() => appMode.mode);

const serverText = computed(() => {
  if (!state.server.checked) return '正在检查 Node 服务端…';
  if (!state.server.ok) return 'Node 服务端未连接 · 当前使用浏览器引擎（npm run dev:server 可启用）';
  const sharp = state.server.sharp ? `sharp ${state.server.sharp}` : 'sharp 版本未知';
  return `Node 服务端已连接 · ${sharp} · 算法 ${state.server.algorithm ?? meta.ALGORITHM}`;
});

const message = computed(() => {
  switch (mode.value) {
    case 'library':
      return libraryState.error || libraryState.status || '资源库就绪 · 支持拖拽上传、子目录、批量改名';
    case 'video':
      return videoState.error || videoState.status || videoState.progress || '视频工作区就绪';
    case 'audio':
      return audioState.error || audioState.status || '音频工作区就绪 · 拖出选区后裁剪并保存 WAV';
    case 'cropimage':
      return cropState.error || cropState.status || '选择比例或拖动裁剪框，再应用';
    case 'bgremove':
      return bgState.error || bgState.status || '自动识别背景色，也可以用取色器或套索';
    case 'eraser':
      return eraserState.error || eraserState.status || '拖动擦除，[ / ] 调整笔刷大小';
    case 'pixel':
      return pixelState.error || pixelState.status || '像素笔绘就绪 · 拖动绘制，[ / ] 调笔刷，B/E/I 切换工具';
    case 'watermark':
      return watermarkState.error || watermarkState.status || '就绪';
    default:
      return state.error || state.status || '就绪';
  }
});

const isError = computed(() => {
  switch (mode.value) {
    case 'library':
      return Boolean(libraryState.error);
    case 'video':
      return Boolean(videoState.error);
    case 'audio':
      return Boolean(audioState.error);
    case 'cropimage':
      return Boolean(cropState.error);
    case 'bgremove':
      return Boolean(bgState.error);
    case 'eraser':
      return Boolean(eraserState.error);
    case 'pixel':
      return Boolean(pixelState.error);
    case 'watermark':
      return Boolean(watermarkState.error);
    default:
      return Boolean(state.error);
  }
});

const busy = computed(() => {
  if (mode.value === 'library') return libraryState.busy || libraryState.refreshing;
  if (mode.value === 'video') return videoState.busy || videoState.loading || videoState.filmstripLoading;
  if (mode.value === 'audio') return audioState.busy || audioState.loading;
  if (mode.value === 'cropimage') return cropState.busy;
  if (mode.value === 'bgremove') return bgState.busy;
  if (mode.value === 'eraser') return eraserState.busy;
  if (mode.value === 'pixel') return pixelState.busy;
  return state.busy;
});

const ffmpegText = computed(() => {
  const health = videoState.health;
  if (!health.checked) return 'FFmpeg 检查中';
  if (!health.ok) return 'FFmpeg 未就绪';
  return `FFmpeg ${health.ffmpeg?.version ?? '就绪'}`;
});

const rightStats = computed(() => {
  if (mode.value === 'library') {
    const s = libraryStats.value;
    return `${s.files} 文件 · ${s.folders} 目录 · ${formatSize(s.bytes)}`;
  }
  if (mode.value === 'video') {
    if (!videoState.meta) return '未选择视频';
    return `${fps.value ? `${fps.value.toFixed(2)}fps · ` : ''}${formatDuration(duration.value)}`;
  }
  if (mode.value === 'audio') {
    if (!audioState.activePath) return '未选择音频';
    const rate = audioState.sampleRate ? `${(audioState.sampleRate / 1000).toFixed(1)}kHz` : '';
    const channels = audioState.channels ? `${audioState.channels}ch` : '';
    return [formatDuration(audioState.duration), rate, channels].filter(Boolean).join(' · ');
  }
  return `${stats.value.total} 张 · ${stats.value.ready} 可裁剪 · ${formatBytes(stats.value.sourceBytes)}`;
});

const engineChip = computed(() => {
  if (mode.value === 'video') return 'ffmpeg';
  if (mode.value === 'audio') return 'web-audio';
  if (mode.value === 'library') return 'library';
  if (mode.value === 'bgremove') return 'bg-remove';
  if (mode.value === 'eraser') return 'eraser';
  if (mode.value === 'pixel') return 'pixel-paint';
  if (mode.value === 'cropimage') return 'crop-tool';
  return state.engine === 'server' ? 'node-sharp' : 'browser-canvas';
});
</script>

<template>
  <footer class="statusbar">
    <div class="status-left">
      <span class="status-dot" :class="{ 'is-ok': state.server.ok, 'is-bad': state.server.checked && !state.server.ok }" />
      <span class="status-text" :title="serverText">{{ serverText }}</span>
      <span v-if="mode === 'video' || mode === 'library'" class="ffmpeg-chip" :class="{ 'is-bad': !videoState.health.ok }">
        {{ ffmpegText }}
      </span>
    </div>
    <div class="status-message" :class="{ 'is-error': isError }">{{ message }}</div>
    <div class="status-right">
      <span v-if="busy" class="busy">处理中…</span>
      <span class="mono">{{ rightStats }}</span>
      <span class="chip mono">{{ engineChip }}</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 26px;
  padding: 0 12px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.status-right {
  justify-content: flex-end;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}

.status-dot.is-ok {
  background: var(--ok);
}

.status-dot.is-bad {
  background: var(--warn);
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ffmpeg-chip {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
}

.ffmpeg-chip.is-bad {
  color: var(--warn);
}

.status-message {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.status-message.is-error {
  color: var(--danger);
}

.busy {
  color: var(--accent);
}
</style>
