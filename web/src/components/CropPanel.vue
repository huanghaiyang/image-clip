<script setup>
/**
 * 图片裁剪右侧面板
 * ----------------
 * 面板只做参数输入与触发，真正的裁剪、批量、导出都在 useCropTool 里。
 * 批量裁剪使用「归一化裁剪框」：当前框在任意一张图上的相对位置会套用到全部素材，
 * 因此视频关键帧（尺寸一致）得到完全相同的构图，而不同尺寸的图片也能保持一致取景。
 */
import { computed, ref } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useCropTool, BUILTIN_SIZES, CROP_RATIOS } from '../composables/useCropTool.js';
import SegmentedControl from './ui/SegmentedControl.vue';

const { state: workspaceState, checkedItems } = useWorkspace();
const { state, actions, activeItem, outputSize, normalizedRect, canApply, atlasCount } = useCropTool();

const presetName = ref('');
const saveToLibrary = ref(true);
const downloadZip = ref(false);
const applySaveToLibrary = ref(false);

const ratioOptions = computed(() => CROP_RATIOS.map((ratio) => ({ value: ratio.value, label: ratio.label })));

const outputModeOptions = [
  { value: 'natural', label: '原始尺寸' },
  { value: 'resize', label: '指定尺寸' },
];

const rectSummary = computed(() => {
  const rect = state.rect;
  return `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
});

const normalizedSummary = computed(() => {
  const norm = normalizedRect.value;
  return `${(norm.x * 100).toFixed(1)}% , ${(norm.y * 100).toFixed(1)}% · ${(norm.width * 100).toFixed(1)}% × ${(
    norm.height * 100
  ).toFixed(1)}%`;
});

const batchProgress = computed(() => {
  const { done, total } = state.batch;
  return total > 0 ? Math.round((done / total) * 100) : 0;
});

function updateRect(key, event) {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) return;
  const rect = { ...state.rect };
  if (key === 'x' || key === 'y') rect[key] = Math.max(0, Math.round(value));
  else rect[key] = Math.max(1, Math.round(value));
  actions.setRect(rect);
}

function updateOutput(key, event) {
  actions.setOutputDimension(key, event.target.value);
}

function savePreset() {
  const preset = actions.saveSizePreset(presetName.value);
  if (preset) presetName.value = '';
}
</script>

<template>
  <aside class="panel crop-panel">
    <div class="panel-title">
      <span>图片裁剪</span>
      <span class="muted mono">{{ activeItem ? `${activeItem.width}×${activeItem.height}` : '—' }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!activeItem" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">图集模式</h3>
          <label class="check-row">
            <input type="checkbox" :checked="state.atlas.enabled" @change="actions.toggleAtlas()" />
            <span>勾选的素材像纸一样叠加，统一裁剪框</span>
          </label>
          <template v-if="state.atlas.enabled">
            <div class="atlas-row">
              <button class="btn is-ghost" type="button" @click="actions.stepLayer(-1)">上一层</button>
              <span class="mono atlas-pos">第 {{ state.atlas.layer + 1 }} / {{ atlasCount }} 层</span>
              <button class="btn is-ghost" type="button" @click="actions.stepLayer(1)">下一层</button>
            </div>
            <p class="hint">舞台右侧层条可逐层预览裁切效果，方向键 ←/→ 也能翻层。</p>
          </template>
          <p v-else class="hint">适合图集 / 序列帧：先在左侧勾选素材，一个裁剪框按相对位置作用到每张图。</p>
        </section>

        <section class="section">
          <h3 class="section-title">裁剪比例</h3>
          <div class="ratio-grid">
            <button
              v-for="ratio in CROP_RATIOS"
              :key="ratio.label"
              class="ratio"
              :class="{ 'is-active': Math.abs(state.aspect - ratio.value) < 0.001 }"
              type="button"
              @click="actions.setAspect(ratio.value)"
            >
              {{ ratio.label }}
            </button>
          </div>
          <p class="hint">选择比例后裁剪框会保持该比例；「自由」可以任意拉伸。</p>
        </section>

        <section class="section">
          <h3 class="section-title">裁剪框（像素）</h3>
          <div class="grid-2">
            <label class="mini-field">
              <span>X</span>
              <input type="number" min="0" :value="Math.round(state.rect.x)" @change="updateRect('x', $event)" />
            </label>
            <label class="mini-field">
              <span>Y</span>
              <input type="number" min="0" :value="Math.round(state.rect.y)" @change="updateRect('y', $event)" />
            </label>
            <label class="mini-field">
              <span>宽</span>
              <input type="number" min="1" :value="Math.round(state.rect.width)" @change="updateRect('width', $event)" />
            </label>
            <label class="mini-field">
              <span>高</span>
              <input type="number" min="1" :value="Math.round(state.rect.height)" @change="updateRect('height', $event)" />
            </label>
          </div>
          <div class="row-actions">
            <span class="muted mono">{{ rectSummary }} px</span>
            <button class="btn is-ghost" type="button" @click="actions.resetRect()">重置</button>
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">输出尺寸</h3>
          <SegmentedControl
            :model-value="state.output.mode"
            :options="outputModeOptions"
            size="sm"
            block
            @update:model-value="actions.setOutputMode($event)"
          />
          <div v-if="state.output.mode === 'resize'" class="grid-2 mt-8">
            <label class="mini-field">
              <span>宽</span>
              <input type="number" min="1" placeholder="自动" :value="state.output.width || ''" @change="updateOutput('width', $event)" />
            </label>
            <label class="mini-field">
              <span>高</span>
              <input type="number" min="1" placeholder="自动" :value="state.output.height || ''" @change="updateOutput('height', $event)" />
            </label>
          </div>
          <p class="hint">
            实际输出：<span class="mono">{{ outputSize.width }} × {{ outputSize.height }}</span>
            <template v-if="state.output.mode === 'resize'">（只填一边时按裁剪框比例自动推算另一边）</template>
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">尺寸预设</h3>
          <div class="preset-chips">
            <button
              v-for="preset in BUILTIN_SIZES"
              :key="preset.name"
              class="preset-chip"
              type="button"
              :title="`${preset.width}×${preset.height}`"
              @click="actions.applySizePreset(preset)"
            >
              {{ preset.name }}
            </button>
            <button
              v-for="preset in state.sizePresets"
              :key="preset.id"
              class="preset-chip is-custom"
              type="button"
              :title="`${preset.width}×${preset.height}`"
              @click="actions.applySizePreset(preset)"
            >
              {{ preset.name }}
              <span class="preset-remove" title="删除预设" @click.stop="actions.deleteSizePreset(preset.id)">×</span>
            </button>
          </div>
          <div class="preset-save mt-8">
            <input v-model="presetName" class="text-input" type="text" placeholder="预设名称（可留空）" @keydown.enter="savePreset" />
            <button class="btn" type="button" @click="savePreset">保存尺寸</button>
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">应用</h3>
          <button
            class="btn is-primary is-block"
            type="button"
            :disabled="!canApply || state.busy"
            @click="actions.applyCurrentCrop({ addToWorkspace: true, saveToLibrary: applySaveToLibrary })"
          >
            裁剪并生成新素材{{ applySaveToLibrary ? '（含资源库）' : '' }}
          </button>
          <button
            class="btn is-block is-ghost mt-6"
            type="button"
            :disabled="!canApply || state.busy"
            @click="actions.applyCurrentCrop({ addToWorkspace: false, download: true })"
          >
            仅下载 PNG
          </button>
          <button
            class="btn is-block mt-6"
            type="button"
            :disabled="!canApply || state.busy"
            @click="actions.applyCurrentCrop({ inPlace: true })"
          >
            保存到当前素材（不新增）
          </button>
          <label class="check-row mt-8">
            <input v-model="applySaveToLibrary" type="checkbox" />
            <span>保存到资源库/裁剪结果</span>
          </label>
          <p class="hint">
            裁剪结果会作为新素材加入左侧列表，原图保持不变，方便对比；「保存到当前素材」则直接覆盖当前素材的资源库文件（旧内容自动存为历史版本），不新增素材。
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">
            批量裁剪（已选 {{ checkedItems.length }} 张）<span v-if="state.atlas.enabled" class="tag-atlas">图集</span>
          </h3>
          <p class="hint">
            以{{ state.atlas.enabled ? '图集统一裁剪框' : '当前裁剪框' }}为模板，按相对位置套用到左侧勾选的素材。归一化取景：
            <span class="mono">{{ normalizedSummary }}</span>
          </p>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>保存到资源库/裁剪结果</span>
          </label>
          <label class="check-row">
            <input v-model="downloadZip" type="checkbox" />
            <span>打包下载 ZIP</span>
          </label>
          <button
            class="btn is-block mt-8"
            type="button"
            :disabled="state.batch.running || checkedItems.length === 0"
            @click="actions.batchCrop({ saveToLibrary, download: downloadZip })"
          >
            {{ state.batch.running ? `裁剪中 ${state.batch.done}/${state.batch.total}` : `批量裁剪 ${checkedItems.length} 张` }}
          </button>
          <div v-if="state.batch.running" class="progress">
            <span class="progress-fill" :style="{ width: `${batchProgress}%` }" />
          </div>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.crop-panel {
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

.atlas-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}

.atlas-pos {
  color: var(--text-muted);
  font-size: 10px;
}

.tag-atlas {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9px;
  font-weight: 400;
  vertical-align: 1px;
}

.ratio-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}

.ratio {
  height: 26px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
}

.ratio:hover {
  background: var(--panel-3);
}

.ratio.is-active {
  background: var(--accent);
  border-color: transparent;
  color: #fff;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.mini-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.mini-field input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  text-align: right;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-family: var(--mono);
}

.mini-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.row-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
}

.preset-chip:hover {
  background: var(--panel-3);
  color: var(--text);
}

.preset-chip.is-custom {
  border-style: dashed;
}

.preset-remove {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
}

.preset-remove:hover {
  color: var(--danger);
}

.preset-save {
  display: flex;
  gap: 6px;
}

.text-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
}

.text-input:focus {
  outline: none;
  border-color: var(--accent);
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  color: var(--text-2);
  font-size: 11px;
}

.check-row input {
  accent-color: var(--accent);
}

.mt-6 {
  margin-top: 6px;
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

.progress {
  height: 4px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--panel-3);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
</style>
