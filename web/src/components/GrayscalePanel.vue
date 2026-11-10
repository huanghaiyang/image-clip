<script setup>
/**
 * 灰度着色右侧面板
 * ----------------
 * 左侧选素材 → 右侧挑颜色/强度 → 中间实时预览。
 * 白色就是普通灰度；选任意颜色即把灰度映射到该颜色。
 */
import { computed, ref, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useGrayscale } from '../composables/useGrayscale.js';
import RangeField from './ui/RangeField.vue';

const { selected } = useWorkspace();
const { state, checkedCount, actions } = useGrayscale();

const item = computed(() => selected.value ?? null);
const saveToLibrary = ref(false);
const batchSaveToLibrary = ref(true);
const hexInput = ref(state.options.color.toUpperCase());

const presetColors = [
  { hex: '#ffffff', label: '纯灰度' },
  { hex: '#ffd28a', label: '暖金' },
  { hex: '#9ecbff', label: '冷蓝' },
  { hex: '#c7a5ff', label: '淡紫' },
  { hex: '#8ef0c0', label: '青绿' },
  { hex: '#ff9f9f', label: '珊瑚粉' },
];

watch(
  () => state.options.color,
  (color) => {
    hexInput.value = color.toUpperCase();
  },
);

function onHexInput() {
  const text = hexInput.value.trim();
  if (!/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(text)) {
    hexInput.value = state.options.color.toUpperCase();
    return;
  }
  actions.setOption('color', text);
  hexInput.value = state.options.color.toUpperCase();
}

function pickPreset(hex) {
  actions.setOption('color', hex);
}
</script>

<template>
  <aside class="panel grayscale-panel">
    <div class="panel-title">
      <span>灰度着色</span>
      <span class="chip mono">{{ state.options.color.toUpperCase() }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!item" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">着色颜色</h3>
          <div class="color-row">
            <input
              class="color-input"
              type="color"
              :value="state.options.color"
              title="选择着色颜色"
              @input="actions.setOption('color', $event.target.value)"
            />
            <input
              v-model="hexInput"
              class="hex-input mono"
              type="text"
              maxlength="7"
              spellcheck="false"
              title="也可直接输入十六进制颜色"
              @change="onHexInput"
              @keydown.enter.prevent="onHexInput"
            />
          </div>
          <div class="preset-row">
            <button
              v-for="preset in presetColors"
              :key="preset.hex"
              class="preset"
              type="button"
              :class="{ 'is-active': state.options.color === preset.hex }"
              :style="{ background: preset.hex }"
              :title="preset.label"
              @click="pickPreset(preset.hex)"
            />
          </div>
          <p class="hint">
            白色 = 纯灰度；其他颜色会把灰度色阶映射到该颜色（黑→黑，白→所选颜色），透明度保持不变。
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">强度</h3>
          <RangeField
            label="灰度着色强度"
            :model-value="state.options.strength"
            :min="0"
            :max="100"
            :step="1"
            suffix="%"
            hint="0% 保持原图；100% 完全按亮度着色；中间值用于保留部分原始色彩"
            @update:model-value="actions.setOption('strength', $event)"
          />
          <button class="btn is-block is-ghost" type="button" @click="actions.resetOptions()">恢复默认（纯灰度）</button>
        </section>

        <section class="section">
          <h3 class="section-title">导出</h3>
          <p class="stat-row">
            <span class="muted">原图尺寸</span>
            <span class="mono">{{ item.width }} × {{ item.height }}</span>
          </p>
          <button
            class="btn is-primary is-block"
            type="button"
            :disabled="state.busy"
            @click="actions.exportTint({ addToWorkspace: true, saveToLibrary })"
          >
            {{ state.busy ? '正在生成…' : '生成新素材（PNG）' }}
          </button>
          <button
            class="btn is-block is-ghost mt-6"
            type="button"
            :disabled="state.busy"
            @click="actions.exportTint({ addToWorkspace: false, download: true })"
          >
            仅下载 PNG
          </button>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>同时保存到资源库/灰度结果</span>
          </label>
          <p class="hint">结果作为新素材加入左侧列表，原图保持不变。</p>
        </section>

        <section class="section">
          <div class="section-head">
            <h3 class="section-title">批量处理</h3>
            <span class="chip">{{ checkedCount }} 张已勾选</span>
          </div>
          <button
            class="btn is-block"
            type="button"
            :disabled="state.busy || checkedCount === 0"
            @click="actions.applyTintBatch({ saveToLibrary: batchSaveToLibrary })"
          >
            {{ state.busy ? '正在处理…' : `应用到勾选的 ${checkedCount} 张` }}
          </button>
          <label class="check-row">
            <input v-model="batchSaveToLibrary" type="checkbox" />
            <span>保存到资源库/灰度结果</span>
          </label>
          <p class="hint">使用同一组颜色与强度批量输出，不修改原图。</p>
        </section>

        <p v-if="state.error" class="hint is-warn">{{ state.error }}</p>
        <p v-else-if="state.status" class="hint">{{ state.status }}</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.grayscale-panel {
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
}

.color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  cursor: pointer;
}

.hex-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.hex-input:focus {
  outline: none;
  border-color: var(--accent);
}

.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.preset {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}

.preset.is-active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 8px;
  font-size: 11px;
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

.hint.is-warn {
  color: var(--danger, #e5534b);
}
</style>
