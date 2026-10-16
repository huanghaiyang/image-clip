<script setup>
/** 右侧检查器：检测参数 / 当前结果 / 导出（对应 Figma 的右侧属性面板）。 */
import { computed } from 'vue';
import RangeField from './ui/RangeField.vue';
import SwitchField from './ui/SwitchField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { formatBytes, formatRatio } from '../lib/imaging.js';

const { state, selected, actions, meta } = useWorkspace();

const items = computed(() => state.items);
const exportable = computed(() => items.value.filter((item) => item.bounds && !item.resultEmpty));

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'jpeg', label: 'JPEG' },
];

const keepRatio = computed(() => {
  const item = selected.value;
  if (!item?.bounds || item.resultEmpty) return null;
  return (item.bounds.width * item.bounds.height) / Math.max(1, item.width * item.height);
});

const shrunkBytesHint = computed(() => {
  const item = selected.value;
  if (!item) return '';
  return `${formatBytes(item.bytes)} · ${item.type || '未知类型'}`;
});

const qualityVisible = computed(() => state.output.format !== 'png');
</script>

<template>
  <aside class="inspector panel">
    <div class="panel-title">
      <span>检查器</span>
      <span class="chip">{{ meta.ALGORITHM }}</span>
    </div>

    <div class="inspector-scroll">
      <!-- 检测参数 -->
      <section class="section">
        <h3 class="section-title">检测</h3>

        <SwitchField
          label="颜色背景模式"
          :model-value="state.options.matchColor"
          hint="把接近背景色的不透明像素也视为背景，适合白底 JPG/截图（无 alpha 的素材）。"
          @update:model-value="actions.setOption('matchColor', $event)"
        />

        <div v-if="state.options.matchColor" class="color-row">
          <label class="color-label">背景色</label>
          <div class="color-input">
            <input
              type="color"
              :value="state.options.backgroundColor"
              @input="actions.setOption('backgroundColor', $event.target.value)"
            />
            <span class="mono">{{ state.options.backgroundColor }}</span>
          </div>
        </div>

        <RangeField
          v-if="state.options.matchColor"
          label="颜色容差"
          :model-value="state.options.colorTolerance"
          :min="0"
          :max="255"
          suffix="/255"
          hint="RGB 三通道最大差值，越大抠掉的颜色范围越宽。"
          @update:model-value="actions.setOption('colorTolerance', $event)"
        />

        <RangeField
          label="透明阈值"
          :model-value="state.options.alphaThreshold"
          :min="0"
          :max="254"
          hint="alpha 大于该值的像素才算内容；调大可丢弃几乎不可见的阴影噪点。"
          @update:model-value="actions.setOption('alphaThreshold', $event)"
        />

        <RangeField
          label="边缘留白"
          :model-value="state.options.padding"
          :min="-40"
          :max="80"
          suffix="px"
          hint="正值在裁剪框外多留边距，负值向内收缩。"
          @update:model-value="actions.setOption('padding', $event)"
        />

        <button class="btn is-block is-ghost" type="button" @click="actions.resetOptions()">重置为默认值</button>
      </section>

      <!-- 结果 -->
      <section class="section">
        <h3 class="section-title">结果</h3>

        <p v-if="!selected" class="muted empty">选择左侧任意素材查看裁剪结果。</p>

        <template v-else>
          <dl class="kv">
            <div class="kv-row">
              <dt>原始尺寸</dt>
              <dd class="mono">{{ selected.width }} × {{ selected.height }}</dd>
            </div>
            <div class="kv-row">
              <dt>裁剪尺寸</dt>
              <dd class="mono accent">
                <template v-if="selected.bounds && !selected.resultEmpty">
                  {{ selected.bounds.width }} × {{ selected.bounds.height }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
            <div class="kv-row">
              <dt>裁剪框坐标</dt>
              <dd class="mono">
                <template v-if="selected.bounds && !selected.resultEmpty">
                  {{ selected.bounds.x }}, {{ selected.bounds.y }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
            <div class="kv-row">
              <dt>保留面积</dt>
              <dd class="mono">{{ keepRatio === null ? '—' : formatRatio(keepRatio) }}</dd>
            </div>
            <div class="kv-row">
              <dt>文件</dt>
              <dd class="mono">{{ shrunkBytesHint }}</dd>
            </div>
            <div class="kv-row">
              <dt>引擎 / 耗时</dt>
              <dd class="mono">
                {{ selected.engine || '—' }}
                <template v-if="selected.elapsedMs"> · {{ selected.elapsedMs }}ms</template>
              </dd>
            </div>
          </dl>

          <div v-if="selected.trimmed && !selected.resultEmpty" class="trim-grid">
            <div class="trim">
              <span class="trim-edge">左</span>
              <span class="mono">−{{ selected.trimmed.left }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">上</span>
              <span class="mono">−{{ selected.trimmed.top }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">右</span>
              <span class="mono">−{{ selected.trimmed.right }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">下</span>
              <span class="mono">−{{ selected.trimmed.bottom }}</span>
            </div>
          </div>

          <p v-if="selected.error" class="error">{{ selected.error }}</p>

          <div class="row-actions">
            <button class="btn" type="button" @click="actions.copyBounds(selected)">复制坐标</button>
            <button class="btn" type="button" @click="actions.recomputeAll()">重新检测</button>
          </div>
        </template>
      </section>

      <!-- 导出 -->
      <section class="section is-last">
        <h3 class="section-title">导出</h3>

        <SegmentedControl
          block
          :model-value="state.output.format"
          :options="FORMATS"
          @update:model-value="actions.setOutput('format', $event)"
        />

        <RangeField
          v-if="qualityVisible"
          class="quality"
          label="质量"
          :model-value="state.output.quality"
          :min="10"
          :max="100"
          suffix="%"
          @update:model-value="actions.setOutput('quality', $event)"
        />
        <p v-else class="muted note">PNG 为无损输出，保留 alpha 通道。</p>
        <p v-if="state.output.format === 'jpeg'" class="muted note">JPEG 不支持透明，透明区域会填成白色。</p>

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="state.busy || !selected || !selected.bounds || selected.resultEmpty"
          @click="actions.exportItem(selected)"
        >
          导出当前图片
        </button>
        <button
          class="btn is-block"
          type="button"
          :disabled="state.busy || exportable.length === 0"
          @click="actions.exportAll()"
        >
          批量导出 ZIP（{{ exportable.length }} 张）
        </button>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  width: 288px;
  flex: none;
  border-left: 1px solid var(--border);
}

.inspector-scroll {
  flex: 1;
  overflow-y: auto;
}

.section.is-last {
  border-bottom: none;
}

.empty {
  margin: 0;
  font-size: 11px;
}

.kv {
  margin: 0 0 10px;
}

.kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
}

.kv-row dt {
  color: var(--text-muted);
}

.kv-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.accent {
  color: var(--accent);
}

.trim-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 8px;
  margin-bottom: 10px;
  border-radius: var(--radius);
  background: var(--panel-2);
}

.trim {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.trim-edge {
  color: var(--text-muted);
  font-size: 10px;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.row-actions .btn {
  flex: 1;
}

.color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.color-label {
  color: var(--text-2);
}

.color-input {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 10px;
}

.color-input input[type='color'] {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
}

.quality {
  margin-top: 12px;
}

.note {
  margin: 6px 0 10px;
  font-size: 10px;
  line-height: 1.6;
}

.error {
  margin: 0 0 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
  font-size: 11px;
}

.is-last .btn + .btn {
  margin-top: 6px;
}
</style>
