<script setup>
/**
 * 应用外壳
 * --------
 * 4 个工作区共用同一个三栏布局（左：资源/素材，中：舞台，右：参数面板）：
 *   1 资源库 · 2 视频 · 3 图片处理 · 4 音频
 * 图片处理内部再用右侧 tab 切换具体工具（透明裁剪 / 图片裁剪 / …）。
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
import ImageToolPanel from './components/ImageToolPanel.vue';
import WatermarkStage from './components/WatermarkStage.vue';
import CropStage from './components/CropStage.vue';
import BgStage from './components/BgStage.vue';
import EraserStage from './components/EraserStage.vue';
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
import SpriteStage from './components/SpriteStage.vue';
import StatusBar from './components/StatusBar.vue';
import ChatDrawer from './components/ChatDrawer.vue';
import UploadDialog from './components/UploadDialog.vue';
import RenameDialog from './components/RenameDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import SessionDialog from './components/SessionDialog.vue';

import { useWorkspace } from './composables/useWorkspace.js';
import { useWatermark } from './composables/useWatermark.js';
import { useAppMode, MODES } from './composables/useAppMode.js';
import { useLibrary } from './composables/useLibrary.js';
import { importFilesToLibrary } from './composables/useLibraryImport.js';
import { useVideo } from './composables/useVideo.js';
import { useAudio } from './composables/useAudio.js';
import { useEraser } from './composables/useEraser.js';
import { usePixelPaint } from './composables/usePixelPaint.js';
import { useSprite } from './composables/useSprite.js';
import { resetActiveViewport } from './composables/useStageViewport.js';
import { openImportPicker, useUploadPicker } from './composables/useUploadPicker.js';
import { useWorkSession } from './composables/useWorkSession.js';
import { useUndo } from './composables/useUndo.js';

const { state, actions } = useWorkspace();
const { state: watermarkState, actions: watermarkActions } = useWatermark();
const { state: appMode, activeTool, actions: modeActions } = useAppMode();
const { actions: libraryActions } = useLibrary();
const { state: videoState, actions: videoActions } = useVideo();
const { state: audioState, actions: audioActions } = useAudio();
const { state: eraserState, actions: eraserActions } = useEraser();
const { state: pixelState, actions: pixelActions } = usePixelPaint();
const { actions: spriteActions } = useSprite();
const { state: uploadState } = useUploadPicker();
const { state: sessionState, actions: sessionActions } = useWorkSession();
const { actions: undoActions } = useUndo();

const mode = computed(() => appMode.mode);

/** 这些图片工具的舞台没有内置拖放，交给窗口级处理。 */
const WINDOW_DROP_TOOLS = new Set(['cropimage', 'bgremove', 'eraser', 'pixel', 'sprite']);

/** 资源库 / 视频 / 音频直接入库；图片处理入库后自动载入素材列表。 */
async function importFiles(files, { toLibrary = false } = {}) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return;
  if (toLibrary) {
    if (mode.value === 'image') {
      await importFilesToLibrary(list, { mode: activeTool.value });
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
  const toLibrary = mode.value === 'library' || mode.value === 'video' || mode.value === 'audio' || mode.value === 'image';
  void importFiles(files, { toLibrary });
}

/** 阻止拖到窗口其他位置时浏览器直接打开文件。 */
function preventWindowDrop(event) {
  event.preventDefault();
}

/** 图片处理工作区里，舞台自己处理拖放的工具除外，其余交给窗口级导入。 */
function onWindowDrop(event) {
  event.preventDefault();
  if (uploadState.open) return;
  if (!WINDOW_DROP_TOOLS.has(activeTool.value)) return;
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

  // 全局撤销 / 重做：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y 重做
  if (meta && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
    event.preventDefault();
    if (event.key.toLowerCase() === 'y' || event.shiftKey) undoActions.redo();
    else undoActions.undo();
    return;
  }

  // 数字键切换工作区（1 资源库 / 2 视频 / 3 图片处理 / 4 音频）
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

  // 图片处理：快捷键按右侧当前选中的工具分派
  if (mode.value !== 'image') return;
  const tool = activeTool.value;

  if (tool === 'watermark') {
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

  if (tool === 'eraser') {
    // 橡皮擦：撤销/重做走全局 Ctrl+Z，这里只处理笔刷大小和 fit
    if (event.key === '0') resetActiveViewport();
    if (event.key === '[' || event.key === ']') {
      const step = event.key === ']' ? 2 : -2;
      const next = Math.min(400, Math.max(2, eraserState.brush.size + step));
      eraserActions.setBrush('size', next);
    }
    return;
  }

  if (tool === 'pixel') {
    // 像素笔绘：撤销/重做走全局 Ctrl+Z；[ ] 调笔刷；B/E/I 切换画笔/橡皮/吸管；G 网格
    if (event.key === '0') resetActiveViewport();
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

  if (tool === 'sprite') {
    // 精灵图：空格播放/暂停，←/→ 逐帧
    if (event.key === ' ') {
      event.preventDefault();
      spriteActions.togglePlay();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      spriteActions.step(event.key === 'ArrowLeft' ? -1 : 1);
    }
    return;
  }

  if (tool === 'crop') {
    if (event.key === '0') actions.setView('zoom', 'fit');
    if (event.key.toLowerCase() === 'r' && !meta) {
      actions.setView('mode', state.view.mode === 'source' ? 'result' : 'source');
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
      actions.removeItem(state.selectedId);
    }
    return;
  }

  if (tool === 'cropimage') {
    // 图片裁剪：0 适合窗口，Delete/Backspace 删除当前素材
    if (event.key === '0') resetActiveViewport();
    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
      actions.removeItem(state.selectedId);
    }
    return;
  }

  if (tool === 'bgremove') {
    // 去背景：0 适合窗口
    if (event.key === '0') resetActiveViewport();
    return;
  }
}

onMounted(() => {
  document.documentElement.dataset.theme = state.theme;
  window.addEventListener('paste', onPaste);
  window.addEventListener('dragover', preventWindowDrop);
  window.addEventListener('drop', onWindowDrop);
  window.addEventListener('keydown', onKeydown);
  void actions.checkServer();
  // 恢复上次临时会话；之后所有变更自动暂存
  void sessionActions.init();
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

    <!-- 恢复提示：告诉用户上次的临时现场已经续上，可随时关掉 -->
    <div v-if="sessionState.restoreHint && !sessionState.hintDismissed" class="session-banner">
      <span class="session-banner-text" :title="sessionState.restoreHint">{{ sessionState.restoreHint }}</span>
      <button class="btn is-mini is-ghost" type="button" @click="sessionActions.openDialog()">查看</button>
      <button class="btn is-mini is-ghost" type="button" @click="sessionActions.dismissHint()">知道了</button>
    </div>

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

      <!-- 图片处理：共用左侧素材列表，中间舞台与右侧 tab 面板随当前工具切换 -->
      <template v-else>
        <AssetPanel />
        <CropStage v-if="activeTool === 'cropimage'" />
        <BgStage v-else-if="activeTool === 'bgremove'" />
        <EraserStage v-else-if="activeTool === 'eraser'" />
        <PixelPaintStage v-else-if="activeTool === 'pixel'" />
        <SpriteStage v-else-if="activeTool === 'sprite'" />
        <WatermarkStage v-else-if="activeTool === 'watermark'" />
        <StageCanvas v-else />
        <ImageToolPanel />
      </template>
    </main>

    <StatusBar />
    <ChatDrawer />
    <UploadDialog />
    <RenameDialog />
    <ConfirmDialog />
    <SessionDialog v-if="sessionState.open" @close="sessionActions.closeDialog()" />
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

.session-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 0 12px;
  height: 32px;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
}

.session-banner-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 11px;
}
</style>
