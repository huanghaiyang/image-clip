<script setup>
/**
 * 图片处理工作区的右侧属性面板
 * ----------------------------
 * 六个图片工具共用一个工作区后，右侧栏用 tab 切换具体工具：
 *   - tab 决定渲染哪一个工具面板，同时决定中间舞台用哪一个 Stage（由 App.vue 渲染）；
 *   - 工具面板本身仍是原来的组件，这里只做容器，并把它们的宽度/左边框收敛掉，
 *     避免出现「面板里再套一个面板」的双层边框。
 */
import { computed } from 'vue';

import InspectorPanel from './InspectorPanel.vue';
import CropPanel from './CropPanel.vue';
import BgPanel from './BgPanel.vue';
import EraserPanel from './EraserPanel.vue';
import WatermarkPanel from './WatermarkPanel.vue';
import PixelPaintPanel from './PixelPaintPanel.vue';
import SpritePanel from './SpritePanel.vue';
import GrayscalePanel from './GrayscalePanel.vue';
import { IMAGE_TOOLS, useAppMode } from '../composables/useAppMode.js';

const { state, actions } = useAppMode();

const PANELS = {
  crop: InspectorPanel,
  cropimage: CropPanel,
  bgremove: BgPanel,
  eraser: EraserPanel,
  watermark: WatermarkPanel,
  pixel: PixelPaintPanel,
  sprite: SpritePanel,
  tint: GrayscalePanel,
};

const activeTool = computed(() => state.imageTool);
const activePanel = computed(() => PANELS[state.imageTool] ?? InspectorPanel);
</script>

<template>
  <aside class="panel image-tools">
    <nav class="tool-tabs" role="tablist" aria-label="图片处理工具">
      <button
        v-for="tool in IMAGE_TOOLS"
        :key="tool.value"
        class="tool-tab"
        :class="{ 'is-active': tool.value === activeTool }"
        type="button"
        role="tab"
        :aria-selected="tool.value === activeTool"
        :title="tool.hint"
        @click="actions.setImageTool(tool.value)"
      >
        {{ tool.label }}
      </button>
    </nav>

    <div class="tool-body">
      <component :is="activePanel" />
    </div>
  </aside>
</template>

<style scoped>
.image-tools {
  display: flex;
  flex-direction: column;
  width: 336px;
  flex: none;
  min-height: 0;
  border-left: 1px solid var(--border);
}

.tool-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  flex: none;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.tool-tab {
  height: 26px;
  padding: 0 4px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tool-tab:hover {
  background: var(--panel-3);
  color: var(--text);
}

.tool-tab.is-active {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.tool-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 工具面板自带的宽度 / 左边框 / 标题行由本容器接管：
   宽度撑满右栏，边框只留外层的，标题改为 tab 行。 */
.tool-body :deep(.panel) {
  width: auto;
  flex: 1;
  min-width: 0;
  border-left: none;
}

.tool-body :deep(.panel-title) {
  display: none;
}
</style>
