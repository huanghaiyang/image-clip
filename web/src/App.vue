<script setup>
/** 应用外壳：三栏布局 + 全局拖放/粘贴导入 + 主题初始化 + 模式切换（透明裁剪 / 水印去除）。 */
import { onBeforeUnmount, onMounted } from 'vue';
import TopBar from './components/TopBar.vue';
import AssetPanel from './components/AssetPanel.vue';
import StageCanvas from './components/StageCanvas.vue';
import InspectorPanel from './components/InspectorPanel.vue';
import WatermarkStage from './components/WatermarkStage.vue';
import WatermarkPanel from './components/WatermarkPanel.vue';
import StatusBar from './components/StatusBar.vue';
import { useWorkspace } from './composables/useWorkspace.js';
import { useWatermark } from './composables/useWatermark.js';

const { state, actions } = useWorkspace();
const { state: watermarkState, actions: watermarkActions } = useWatermark();

function onPaste(event) {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    actions.addFiles(files);
  }
}

/** 阻止拖到窗口其他位置时浏览器直接打开图片 */
function preventWindowDrop(event) {
  event.preventDefault();
}

function onKeydown(event) {
  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => actions.addFiles(input.files);
    input.click();
  }
  if (event.target.closest?.('input')) return;

  // 1 / 2 切换功能模式，避免为了换模式去抓鼠标
  if (event.key === '1' && !meta) {
    watermarkActions.setMode('crop');
    return;
  }
  if (event.key === '2' && !meta) {
    watermarkActions.setMode('watermark');
    return;
  }

  if (watermarkState.mode === 'watermark') {
    // 水印模式下 R 在三种视图间轮换（透明裁剪模式里 R 仍是“源图/结果”切换）
    if (event.key.toLowerCase() === 'r' && !meta) watermarkActions.cycleView();
    if (event.key === '0') watermarkActions.setView('zoom', 'fit');
    // [ / ] 调笔刷半径，与常见图像工具一致，省得来回拉滑块
    if (event.key === '[' || event.key === ']') {
      const step = event.key === ']' ? 2 : -2;
      const next = Math.min(200, Math.max(1, watermarkState.brush.radius + step));
      watermarkActions.setBrush('radius', next);
    }
    return;
  }

  if (event.key === '0') {
    actions.setView('zoom', 'fit');
  }
  if (event.key.toLowerCase() === 'r' && !meta) {
    actions.setView('mode', state.view.mode === 'source' ? 'result' : 'source');
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
    actions.removeItem(state.selectedId);
  }
}

onMounted(() => {
  document.documentElement.dataset.theme = state.theme;
  window.addEventListener('paste', onPaste);
  window.addEventListener('dragover', preventWindowDrop);
  window.addEventListener('drop', preventWindowDrop);
  window.addEventListener('keydown', onKeydown);
  void actions.checkServer();
  // 水印能力探测只在切到该模式时做，避免无关的启动请求
});

onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste);
  window.removeEventListener('dragover', preventWindowDrop);
  window.removeEventListener('drop', preventWindowDrop);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="app">
    <TopBar />
    <main class="app-body">
      <AssetPanel />
      <WatermarkStage v-if="watermarkState.mode === 'watermark'" />
      <StageCanvas v-else />
      <WatermarkPanel v-if="watermarkState.mode === 'watermark'" />
      <InspectorPanel v-else />
    </main>
    <StatusBar />
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
