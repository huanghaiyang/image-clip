<script setup>
/**
 * 应用外壳
 * --------
 * 9 个工作区共用同一个三栏布局（左：资源/素材，中：舞台，右：参数面板）：
 *   1 资源库 · 2 视频 · 3 透明裁剪 · 4 图片裁剪 · 5 背景去除 · 6 橡皮擦 · 7 水印去除 · 8 音频 · 9 像素笔绘
 *
 * 全局只做三件事：
 *  - 工作区切换（useAppMode 是唯一状态源）；
 *  - 导入路由：图片进入工作区素材，资源库/视频模式则直接把文件上传到服务端磁盘；
 *  - 键盘快捷键：数字键切工作区，各模式内保留自己的快捷键。
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';

import TopBar from './components/TopBar.vue';
import AssetPanel from './components/AssetPanel.vue';
import StageCanvas from './components/StageCanvas.vue';
import InspectorPanel from './components/InspectorPanel.vue';
import WatermarkStage from './components/WatermarkStage.vue';
import WatermarkPanel from './components/WatermarkPanel.vue';
import CropStage from './components/CropStage.vue';
import CropPanel from './components/CropPanel.vue';
import BgStage from './components/BgStage.vue';
import BgPanel from './components/BgPanel.vue';
import EraserStage from './components/EraserStage.vue';
import EraserPanel from './components/EraserPanel.vue';
import LibrarySidebar from './components/LibrarySidebar.vue';
import LibraryStage from './components/LibraryStage.vue';
import LibraryInspector from './components/LibraryInspector.vue';
import VideoSidebar from './components/VideoSidebar.vue';
import VideoStage from './components/VideoStage.vue';
import VideoPanel from './components/VideoPanel.vue';
import AudioSidebar from './components/AudioSidebar.vue';
import AudioStage from './components/AudioStage.vue';
import AudioPanel from './components/AudioPanel.vue';
import PixelPaintStage from './components/PixelPaintStage.vue';
import PixelPaintPanel from './components/PixelPaintPanel.vue';
import StatusBar from './components/StatusBar.vue';
import ChatDrawer from './components/ChatDrawer.vue';
import UploadDialog from './components/UploadDialog.vue';
import RenameDialog from './components/RenameDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';

import { useWorkspace } from './composables/useWorkspace.js';
import { useWatermark } from './composables/useWatermark.js';
import { useAppMode, MODES, IMAGE_MODES } from './composables/useAppMode.js';
import { useLibrary } from './composables/useLibrary.js';
import { importFilesToLibrary } from './composables/useLibraryImport.js';
import { useVideo } from './composables/useVideo.js';
import { useAudio } from './composables/useAudio.js';
import { useEraser } from './composables/useEraser.js';
import { usePixelPaint } from './composables/usePixelPaint.js';
import { openImportPicker, useUploadPicker } from './composables/useUploadPicker.js';

const { state, actions } = useWorkspace();
const { state: watermarkState, actions: watermarkActions } = useWatermark();
const { state: appMode, actions: modeActions } = useAppMode();
const { actions: libraryActions } = useLibrary();
const { state: videoState, actions: videoActions } = useVideo();
const { state: audioState, actions: audioActions } = useAudio();
const { state: eraserState, actions: eraserActions } = useEraser();
const { state: pixelState, actions: pixelActions } = usePixelPaint();
const { state: uploadState } = useUploadPicker();

const mode = computed(() => appMode.mode);

/** 这些图片工作区的舞台没有内置拖放，交给窗口级处理。 */
const WINDOW_DROP_MODES = new Set(['cropimage', 'bgremove', 'eraser', 'pixel']);

/** 资源库 / 视频 / 音频直接入库；图片工作区入库后自动载入素材列表。 */
async function importFiles(files, { toLibrary = false } = {}) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return;
  if (toLibrary) {
    if (IMAGE_MODES.has(mode.value)) {
      await importFilesToLibrary(list, { mode: mode.value });
    } else {
      await libraryActions.uploadFiles(list, { dir: mode.value === 'audio' ? '音频' : '' });
    }
    return;
  }
  void actions.addFiles(list);
}

/** 打开应用内的上传选择器：按当前工作区决定目标位置与文件类型。 */
function openFilePicker() {
  openImportPicker(mode.value);
}

function onPaste(event) {
  // 上传弹窗打开时由弹窗自己接收粘贴，避免重复导入
  if (uploadState.open) return;
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  // 资源库/视频/音频模式：粘贴等于入库；图片工作区：入库后自动载入素材列表
  const toLibrary = mode.value === 'library' || mode.value === 'video' || mode.value === 'audio' || IMAGE_MODES.has(mode.value);
  void importFiles(files, { toLibrary });
}

/** 阻止拖到窗口其他位置时浏览器直接打开文件。 */
function preventWindowDrop(event) {
  event.preventDefault();
}

/** 在图片工作区把文件拖到窗口任意位置都能导入（舞台自己处理拖放的模式除外）。 */
function onWindowDrop(event) {
  event.preventDefault();
  if (uploadState.open) return;
  if (!WINDOW_DROP_MODES.has(mode.value)) return;
  // 图片工作区拖放同样先入库，保证所有模块共用素材库
  void importFiles(event.dataTransfer?.files, { toLibrary: true });
}

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function onKeydown(event) {
  // 上传弹窗打开时接管键盘：Esc 关闭、粘贴/拖拽由弹窗处理，避免数字键切换工作区
  if (uploadState.open) return;

  const meta = event.ctrlKey || event.metaKey;
  const typing = isTypingTarget(event.target);

  // Ctrl/Cmd + O 统一走导入入口（和大多数编辑器一致）
  if (meta && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    openFilePicker();
    return;
  }

  if (typing) return;

  // 数字键切换工作区
  if (!meta && /^[1-9]$/.test(event.key)) {
    const next = MODES[Number(event.key) - 1];
    if (next) {
      event.preventDefault();
      modeActions.setMode(next.value);
    }
    return;
  }

  if (mode.value === 'audio') {
    // 音频快捷键：空格播放/暂停，左右方向键按 1s（Shift 为 5s）微调播放头
    if (event.key === ' ') {
      event.preventDefault();
      audioActions.togglePlay();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
      audioActions.stepTime(step);
    }
    return;
  }

  if (mode.value === 'watermark') {
    // 水印模式：R 轮换视图，0 适合窗口，[ ] 调笔刷
    if (event.key.toLowerCase() === 'r' && !meta) watermarkActions.cycleView();
    if (event.key === '0') watermarkActions.setView('zoom', 'fit');
    if (event.key === '[' || event.key === ']') {
      const step = event.key === ']' ? 2 : -2;
      const next = Math.min(200, Math.max(1, watermarkState.brush.radius + step));
      watermarkActions.setBrush('radius', next);
    }
    return;
  }

  if (mode.value === 'eraser') {
    // 橡皮擦：Ctrl/Cmd+Z 撤销、Shift 重做，[ ] 调笔刷大小
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) eraserActions.redo();
      else eraserActions.undo();
      return;
    }
    if (event.key === '[' || event.key === ']') {
      const step = event.key === ']' ? 2 : -2;
      const next = Math.min(400, Math.max(2, eraserState.brush.size + step));
      eraserActions.setBrush('size', next);
    }
    return;
  }

  if (mode.value === 'pixel') {
    // 像素笔绘：Ctrl/Cmd+Z 撤销、Shift 重做；[ ] 调笔刷；B/E/I 切换画笔/橡皮/吸管；G 网格
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) pixelActions.redo();
      else pixelActions.undo();
      return;
    }
    if (event.key === '[' || event.key === ']') {
      const step = event.key === ']' ? 1 : -1;
      pixelActions.setBrush('size', pixelState.brush.size + step);
      return;
    }
    if (!meta) {
      const key = event.key.toLowerCase();
      if (key === 'b') pixelActions.setTool('brush');
      else if (key === 'e') pixelActions.setTool('eraser');
      else if (key === 'i') pixelActions.setTool('pick');
      else if (key === 'h') pixelActions.setTool('pan');
      else if (key === 'g') pixelActions.setBrush('grid', !pixelState.brush.grid);
    }
    return;
  }

  if (mode.value === 'crop') {
    if (event.key === '0') actions.setView('zoom', 'fit');
    if (event.key.toLowerCase() === 'r' && !meta) {
      actions.setView('mode', state.view.mode === 'source' ? 'result' : 'source');
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
      actions.removeItem(state.selectedId);
    }
    return;
  }

  if (mode.value === 'cropimage' && (event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
    actions.removeItem(state.selectedId);
  }
}

onMounted(() => {
  document.documentElement.dataset.theme = state.theme;
  window.addEventListener('paste', onPaste);
  window.addEventListener('dragover', preventWindowDrop);
  window.addEventListener('drop', onWindowDrop);
  window.addEventListener('keydown', onKeydown);
  void actions.checkServer();
});

onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('dragover', preventWindowDrop);
  window.removeEventListener('drop', onWindowDrop);
  window.removeEventListener('keydown', onKeydown);
});

/**
 * 进入资源库 / 视频工作区时刷新一次磁盘目录；
 * 视频还需要探测 FFmpeg 能力（只在第一次或重新进入时做，状态层会缓存）。
 */
watch(
  mode,
  (next) => {
    if (next === 'library' || next === 'video' || next === 'audio') {
      void libraryActions.refresh({ quiet: true });
    }
    if (next === 'video' && !videoState.health.checked) {
      void videoActions.checkHealth();
    }
    // 离开音频工作区时停止播放，避免切到其他工具后声音还在响
    if (next !== 'audio' && audioState.playing) audioActions.pause();
  },
  { immediate: true },
);
</script>

<template>
  <div class="app">
    <TopBar />

    <main class="app-body">
      <!-- 资源库：左侧目录树 / 中间文件网格 / 右侧详情与批量操作 -->
      <template v-if="mode === 'library'">
        <LibrarySidebar />
        <LibraryStage />
        <LibraryInspector />
      </template>

      <!-- 视频：左侧视频列表 / 中间播放器与时间轴 / 右侧截帧与音频 -->
      <template v-else-if="mode === 'video'">
        <VideoSidebar />
        <VideoStage />
        <VideoPanel />
      </template>

      <!-- 音频：左侧音频列表 / 中间频谱时间轴 / 右侧裁剪与导出 -->
      <template v-else-if="mode === 'audio'">
        <AudioSidebar />
        <AudioStage />
        <AudioPanel />
      </template>

      <!-- 图片工作区：共用左侧素材列表，右侧按工具切换 -->
      <template v-else>
        <AssetPanel />
        <CropStage v-if="mode === 'cropimage'" />
        <BgStage v-else-if="mode === 'bgremove'" />
        <EraserStage v-else-if="mode === 'eraser'" />
        <PixelPaintStage v-else-if="mode === 'pixel'" />
        <WatermarkStage v-else-if="mode === 'watermark'" />
        <StageCanvas v-else />
        <CropPanel v-if="mode === 'cropimage'" />
        <BgPanel v-else-if="mode === 'bgremove'" />
        <EraserPanel v-else-if="mode === 'eraser'" />
        <PixelPaintPanel v-else-if="mode === 'pixel'" />
        <WatermarkPanel v-else-if="mode === 'watermark'" />
        <InspectorPanel v-else />
      </template>
    </main>

    <StatusBar />
    <ChatDrawer />
    <UploadDialog />
    <RenameDialog />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
