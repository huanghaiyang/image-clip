<script setup>
/**
 * 背景去除右侧面板
 * ----------------
 * 参数修改后由 useBgRemoval 做 140ms 防抖重算（预览分辨率），
 * 因此拖动滑块的反馈是实时的；这里只负责把控件和状态接起来。
 */
import { computed, ref } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useBgRemoval } from '../composables/useBgRemoval.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';

const { selected } = useWorkspace();
const { state, activeEntry, actions } = useBgRemoval();

const entry = computed(() => activeEntry.value);
const item = computed(() => selected.value ?? null);
const customColor = ref('#ffffff');
const saveToLibrary = ref(false);

const toolOptions = [
  { value: 'lasso', label: '套索', hint: '手绘或智能选区，限定去除范围或保护内容' },
  { value: 'pick', label: '取色器', hint: '点击画面取背景色' },
  { value: 'pan', label: '平移', hint: '拖动查看大图' },
];

const lassoModeOptions = [
  { value: 'smart', label: '智能套索', hint: '落点自动吸附到图像边缘，松开后自动简化顶点' },
  { value: 'free', label: '手绘套索', hint: '完全按拖动轨迹生成选区' },
];

const selectionModeOptions = [
  { value: 'inside', label: '仅选区内', hint: '只去除套索范围内的背景色' },
  { value: 'outside', label: '保护选区', hint: '套索内保持不变，只处理外部' },
  { value: 'all', label: '忽略选区', hint: '全图按颜色去除' },
];

const coverageText = computed(() => {
  const e = entry.value;
  if (!e) return '—';
  return `${(e.coverage * 100).toFixed(2)}%`;
});

function addCustomColor() {
  actions.useColor(customColor.value);
}
</script>

<template>
  <aside class="panel bg-panel">
    <div class="panel-title">
      <span>背景去除</span>
      <span class="chip">{{ state.tool === 'lasso' ? '套索' : state.tool === 'pick' ? '取色器' : '平移' }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!item || !entry" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">工具</h3>
          <SegmentedControl :model-value="state.tool" :options="toolOptions" size="sm" block @update:model-value="actions.setTool($event)" />
        </section>

        <section class="section">
          <div class="section-head">
            <h3 class="section-title">背景色</h3>
            <button class="btn is-ghost is-mini" type="button" @click="actions.autoDetectColors()">重新自动识别</button>
          </div>

          <div class="color-list">
            <div
              v-for="(color, index) in entry.colors"
              :key="`${color.hex}-${index}`"
              class="color-row"
              :class="{ 'is-off': !color.enabled }"
            >
              <button
                class="swatch"
                type="button"
                :style="{ background: color.hex }"
                :title="color.enabled ? '点击停用该颜色' : '点击启用该颜色'"
                @click="actions.toggleColor(index)"
              />
              <span class="color-hex mono">{{ color.hex.toUpperCase() }}</span>
              <span class="color-tag">{{
                color.source === 'custom' ? '自定义' : `${(color.ratio * 100).toFixed(1)}%`
              }}</span>
              <button class="color-remove" type="button" title="移除" @click="actions.removeColor(index)">×</button>
            </div>
          </div>

          <div class="color-add">
            <input v-model="customColor" type="color" class="color-input" />
            <button class="btn is-mini" type="button" @click="addCustomColor">添加颜色</button>
          </div>
          <p class="hint">
            默认从画面四边取样识别主色。勾选的颜色都会按容差去除；取色器会切换为「仅去除该颜色」。
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">去除参数</h3>
          <RangeField
            label="颜色容差"
            :model-value="entry.options.tolerance"
            :min="0"
            :max="120"
            :step="1"
            hint="越大去掉的背景越多，也越容易误伤与背景接近的主体颜色"
            @update:model-value="actions.setOption('tolerance', $event)"
          />
          <SwitchField
            label="只去除与边缘连通区域"
            :model-value="entry.options.connected"
            hint="关闭后，画面内部与背景同色的部分也会被抠掉"
            @update:model-value="actions.setOption('connected', $event)"
          />
          <RangeField
            label="边缘羽化"
            :model-value="entry.options.feather"
            :min="0"
            :max="20"
            suffix="px"
            hint="让抠图边缘过渡更自然，适合毛发或抗锯齿边缘"
            @update:model-value="actions.setOption('feather', $event)"
          />
          <RangeField
            label="向内收缩"
            :model-value="entry.options.erode"
            :min="0"
            :max="10"
            suffix="px"
            hint="先腐蚀再羽化，可去掉背景色残留的一圈描边"
            @update:model-value="actions.setOption('erode', $event)"
          />
          <SwitchField
            label="边缘颜色反混合"
            :model-value="entry.options.decontaminate"
            hint="按公式反算前景色，消除半透明边缘的底色污染"
            @update:model-value="actions.setOption('decontaminate', $event)"
          />
        </section>

        <section class="section">
          <div class="section-head">
            <h3 class="section-title">套索选区</h3>
            <button class="btn is-ghost is-mini" type="button" :disabled="!entry.polygon.length" @click="actions.clearSelection()">
              清除
            </button>
          </div>
          <SegmentedControl
            v-if="state.tool === 'lasso'"
            :model-value="entry.options.lassoMode"
            :options="lassoModeOptions"
            size="sm"
            block
            @update:model-value="actions.setOption('lassoMode', $event)"
          />
          <SegmentedControl
            :model-value="entry.options.selectionMode"
            :options="selectionModeOptions"
            size="sm"
            block
            @update:model-value="actions.setOption('selectionMode', $event)"
          />
          <p class="hint">
            <template v-if="entry.polygon.length">
              选区有 {{ entry.polygon.length }} 个顶点，当前模式生效中。
            </template>
            <template v-else-if="entry.options.lassoMode === 'smart'">
              还没有套索选区：切到「套索」后按住拖动，落点会自动吸附到图像边缘。
            </template>
            <template v-else>还没有套索选区：切到「套索」后在画面上按住拖动即可。</template>
          </p>
          <SwitchField
            label="显示去除掩膜"
            :model-value="entry.options.showMask"
            hint="红色区域表示会被抠掉的像素"
            @update:model-value="actions.setOption('showMask', $event)"
          />
        </section>

        <section class="section">
          <h3 class="section-title">应用</h3>
          <div class="stat-row">
            <span class="muted">透明面积</span>
            <span class="mono">{{ coverageText }}</span>
          </div>
          <div class="stat-row">
            <span class="muted">去除像素</span>
            <span class="mono">{{ entry.removedPixels.toLocaleString() }}</span>
          </div>
          <div class="stat-row">
            <span class="muted">预览计算</span>
            <span class="mono">{{ entry.elapsedMs }}ms</span>
          </div>

          <button
            class="btn is-primary is-block mt-8"
            type="button"
            :disabled="state.busy"
            @click="actions.applyBackgroundRemoval({ saveToLibrary })"
          >
            {{ state.busy ? '正在处理…' : '按原图分辨率应用' }}
          </button>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>同时保存到资源库/抠图结果</span>
          </label>
          <p class="hint">结果会作为新素材加入左侧列表（PNG，保留透明通道），原图不变。</p>
        </section>

        <p v-if="entry.error" class="panel-error">{{ entry.error }}</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.bg-panel {
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

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-head .section-title {
  margin: 0;
}

.is-mini {
  height: 22px;
  padding: 0 6px;
  font-size: 10px;
}

.color-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.color-row.is-off {
  opacity: 0.45;
}

.swatch {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}

.color-hex {
  font-size: 10px;
}

.color-tag {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 10px;
}

.color-remove {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}

.color-remove:hover {
  color: var(--danger);
}

.color-add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.color-input {
  width: 28px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  font-size: 11px;
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

.mt-8 {
  margin-top: 8px;
}

.hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.panel-error {
  margin: 10px 12px;
  color: var(--danger);
  font-size: 11px;
}
</style>
