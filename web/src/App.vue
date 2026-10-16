<script setup>
/** 应用外壳：三栏布局 + 全局拖放/粘贴导入 + 主题初始化。 */
import { onBeforeUnmount, onMounted } from 'vue';
import TopBar from './components/TopBar.vue';
import AssetPanel from './components/AssetPanel.vue';
import StageCanvas from './components/StageCanvas.vue';
import InspectorPanel from './components/InspectorPanel.vue';
import StatusBar from './components/StatusBar.vue';
import { useWorkspace } from './composables/useWorkspace.js';

const { state, actions } = useWorkspace();

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
  if (event.key === '0' && !event.target.closest?.('input')) {
    actions.setView('zoom', 'fit');
  }
  if (event.key.toLowerCase() === 'r' && !meta) {
    actions.setView('mode', state.view.mode === 'source' ? 'result' : 'source');
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId && !event.target.closest?.('input')) {
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
      <StageCanvas />
      <InspectorPanel />
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
