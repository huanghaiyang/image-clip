<script setup>
/**
 * 像素笔绘右侧面板
 * ----------------
 * 颜色 / 笔刷 / 网格 / 历史 / 导出都直接写进 usePixelPaint 的 state.brush，
 * 舞台的光标方框与画布落笔读同一份参数，保证所见即所画。
 */
import { computed, ref, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { usePixelPaint } from '../composables/usePixelPaint.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';

const { selected } = useWorkspace();
const { state, canUndo, canRedo, hasEdits, palette, actions } = usePixelPaint();

const item = computed(() => selected.value ?? null);
const saveToLibrary = ref(false);
const hexInput = ref(state.brush.color.toUpperCase());

watch(
  () => state.brush.color,
  (value) => {
    hexInput.value = value.toUpperCase();
  },
);

const colorValue = computed({
  get: () => state.brush.color,
  set: (value) => actions.setBrush('color', value),
});

function commitHex() {
  if (!actions.setBrush('color', hexInput.value)) {
    hexInput.value = state.brush.color.toUpperCase();
    return;
  }
  hexInput.value = state.brush.color.toUpperCase();
}

const toolOptions = [
  { value: 'brush', label: '画笔', hint: '像素级绘制（B）' },
  { value: 'eraser', label: '橡皮', hint: '把像素擦成透明（E）' },
  { value: 'pick', label: '吸管', hint: '从画面取色（I）' },
  { value: 'pan', label: '平移', hint: '拖动查看大图' },
];

const toolLabel = computed(() => toolOptions.find((option) => option.value === state.brush.tool)?.label ?? '画笔');
</script>

<template>
  <aside class="panel pixel-panel">
    <div class="panel-title">
      <span>像素笔绘</span>
      <span class="chip">{{ toolLabel }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!item" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">工具</h3>
          <SegmentedControl :model-value="state.brush.tool" :options="toolOptions" size="sm" block @update:model-value="actions.setTool($event)" />
        </section>

        <section class="section">
          <h3 class="section-title">颜色</h3>
          <div class="color-row">
            <input v-model="colorValue" class="color-input" type="color" :title="`当前颜色 ${state.brush.color}`" />
            <input
              v-model="hexInput"
              class="hex-input mono"
              type="text"
              spellcheck="false"
              maxlength="7"
              title="支持 #RGB 或 #RRGGBB"
              @change="commitHex"
              @keydown.enter.prevent="commitHex"
            />
          </div>
          <div class="swatches">
            <button
              v-for="color in palette"
              :key="color"
              class="swatch"
              :class="{ 'is-active': color === state.brush.color }"
              type="button"
              :style="{ background: color }"
              :title="color.toUpperCase()"
              @click="actions.setBrush('color', color)"
            />
          </div>
          <p class="hint">吸管可以从画面任意位置取色；色板只影响后续笔迹。</p>
        </section>

        <section class="section">
          <h3 class="section-title">笔刷</h3>
          <RangeField
            label="笔刷大小"
            :model-value="state.brush.size"
            :min="1"
            :max="64"
            :step="1"
            suffix="px"
            hint="按图像像素计算：1px 是单像素描边，放大画面后可以看到像素格"
            @update:model-value="actions.setBrush('size', $event)"
          />
          <RangeField
            label="不透明度"
            :model-value="state.brush.opacity"
            :min="5"
            :max="100"
            :step="1"
            suffix="%"
            hint="100% 为实色像素；降低后同一笔内多次落点会叠出更深的颜色"
            @update:model-value="actions.setBrush('opacity', $event)"
          />
          <div class="btn-row">
            <button
              v-for="size in [1, 2, 4, 8, 16]"
              :key="size"
              class="btn is-mini"
              :class="{ 'is-primary': state.brush.size === size }"
              type="button"
              @click="actions.setBrush('size', size)"
            >
              {{ size }}px
            </button>
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">辅助</h3>
          <SwitchField
            label="显示像素网格"
            :model-value="state.brush.grid"
            hint="放大到每像素占 3 个屏幕像素以上时自动显示，方便对齐边缘"
            @update:model-value="actions.setBrush('grid', $event)"
          />
        </section>

        <section class="section">
          <h3 class="section-title">历史</h3>
          <div class="btn-row">
            <button class="btn is-block" type="button" :disabled="!canUndo" @click="actions.undo()">撤销</button>
            <button class="btn is-block" type="button" :disabled="!canRedo" @click="actions.redo()">重做</button>
          </div>
          <button class="btn is-block is-ghost mt-6" type="button" :disabled="!hasEdits" @click="actions.resetCanvas()">
            恢复原图（清空笔迹）
          </button>
          <p class="hint">撤销按脏矩形保存每一笔的像素，大图也不会占用过多内存。</p>
        </section>

        <section class="section">
          <h3 class="section-title">导出</h3>
          <button
            class="btn is-primary is-block"
            type="button"
            :disabled="state.busy || !hasEdits"
            @click="actions.applyPaint({ addToWorkspace: true, saveToLibrary })"
          >
            {{ state.busy ? '正在生成…' : '生成新素材（PNG）' }}
          </button>
          <button
            class="btn is-block is-ghost mt-6"
            type="button"
            :disabled="state.busy || !hasEdits"
            @click="actions.applyPaint({ addToWorkspace: false, download: true })"
          >
            仅下载 PNG
          </button>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>同时保存到资源库/笔绘结果</span>
          </label>
          <p class="hint">结果作为新素材加入左侧列表，原图保持不变。</p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.pixel-panel {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex: none;
  border-left: 1px solid var(--border);
}

.panel-body {
  flex: 1;
  overflow-y: auto;
}

.empty {
  padding: 14px 12px;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.color-input {
  flex: none;
  width: 36px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  cursor: pointer;
}

.color-input::-webkit-color-swatch-wrapper {
  padding: 2px;
}

.color-input::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}

.hex-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
  text-transform: uppercase;
  outline: none;
}

.hex-input:focus {
  border-color: var(--accent);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
}

.swatch {
  aspect-ratio: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}

.swatch:hover {
  transform: scale(1.06);
}

.swatch.is-active {
  box-shadow: 0 0 0 1px var(--panel), 0 0 0 2px var(--accent);
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.btn-row .btn {
  flex: 1 1 auto;
}

.mt-6 {
  margin-top: 6px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: var(--text-2);
  font-size: 11px;
}

.check-row input {
  accent-color: var(--accent);
}

.hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}
</style>
