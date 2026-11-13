<script setup>
/**
 * 橡皮擦右侧面板
 * --------------
 * 笔刷参数直接写进 useEraser 的 state.brush，
 * 舞台上的光标圆圈与擦除强度都读同一份参数，所见即所得。
 */
import { computed, ref } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useEraser } from '../composables/useEraser.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';

const { selected } = useWorkspace();
const { state, canUndo, canRedo, hasEdits, actions } = useEraser();

const item = computed(() => selected.value ?? null);
const saveToLibrary = ref(false);

const modeOptions = [
  { value: 'erase', label: '擦除', hint: '把像素擦成透明' },
  { value: 'restore', label: '还原', hint: '把原图像素画回来' },
];
</script>

<template>
  <aside class="panel eraser-panel">
    <div class="panel-title">
      <span>橡皮擦</span>
      <span class="chip">{{ state.brush.mode === 'restore' ? '还原' : '擦除' }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!item" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">笔刷</h3>
          <SegmentedControl
            :model-value="state.brush.mode"
            :options="modeOptions"
            size="sm"
            block
            @update:model-value="actions.setBrush('mode', $event)"
          />
          <div class="mt-10">
            <RangeField
              label="笔刷大小"
              :model-value="state.brush.size"
              :min="2"
              :max="400"
              :step="1"
              suffix="px"
              hint="按原图像素计算；大图擦细节时先放大画面再缩小笔刷"
              @update:model-value="actions.setBrush('size', $event)"
            />
            <RangeField
              label="硬度"
              :model-value="state.brush.hardness"
              :min="0"
              :max="100"
              :step="1"
              suffix="%"
              hint="100% 为硬边（干净利落），低硬度带羽化（适合去阴影、柔边）"
              @update:model-value="actions.setBrush('hardness', $event)"
            />
            <RangeField
              label="强度"
              :model-value="state.brush.opacity"
              :min="5"
              :max="100"
              :step="1"
              suffix="%"
              hint="单次涂抹的透明程度，可多次叠加"
              @update:model-value="actions.setBrush('opacity', $event)"
            />
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">对比</h3>
          <SwitchField
            label="显示原图"
            :model-value="state.brush.showOriginal"
            hint="打开后画面显示未擦除的版本，方便检查边缘"
            @update:model-value="actions.setBrush('showOriginal', $event)"
          />
        </section>

        <section class="section">
          <h3 class="section-title">历史</h3>
          <div class="btn-row">
            <button class="btn is-block" type="button" :disabled="!canUndo" @click="actions.undo()">撤销（{{ canUndo ? '有' : '0' }}）</button>
            <button class="btn is-block" type="button" :disabled="!canRedo" @click="actions.redo()">重做</button>
          </div>
          <button class="btn is-block is-ghost mt-6" type="button" :disabled="!hasEdits" @click="actions.resetCanvas()">
            恢复原图（清空历史）
          </button>
          <p class="hint">撤销栈保存每一笔的脏矩形像素，大图也不会占用过多内存。</p>
        </section>

        <section class="section">
          <h3 class="section-title">导出</h3>
          <button
            class="btn is-primary is-block"
            type="button"
            :disabled="state.busy || !hasEdits"
            @click="actions.applyEraser({ addToWorkspace: true, saveToLibrary })"
          >
            {{ state.busy ? '正在生成…' : '生成新素材（PNG）' }}
          </button>
          <button
            class="btn is-block is-ghost mt-6"
            type="button"
            :disabled="state.busy || !hasEdits"
            @click="actions.applyEraser({ addToWorkspace: false, download: true })"
          >
            仅下载 PNG
          </button>
          <button
            class="btn is-block mt-6"
            type="button"
            :disabled="state.busy || !hasEdits"
            @click="actions.applyEraser({ inPlace: true })"
          >
            保存到当前素材（不新增）
          </button>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>同时保存到资源库/擦除结果</span>
          </label>
          <p class="hint">
            结果作为新素材加入左侧列表，原图保持不变；「保存到当前素材」直接覆盖当前素材（旧内容自动存为历史版本），不新增素材。
          </p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.eraser-panel {
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

.btn-row {
  display: flex;
  gap: 6px;
}

.mt-6 {
  margin-top: 6px;
}

.mt-10 {
  margin-top: 10px;
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
