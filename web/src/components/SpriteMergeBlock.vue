<script setup>
/**
 * 多图合并为精灵图 —— 设置区（精灵图工作区的「合并」子模式）
 * ------------------------------------------------------
 * 数据源是左侧「当前素材」里勾选的图片（尺寸可以不同）：
 *  - 单元格 = 各帧最大宽/高，等比铺满或原始像素两种口径；
 *  - 列数 0 为自动方阵，间距单位像素；
 *  - 参数与中间舞台的实时预览共用 useSpriteMerge，改完立即生效；
 *  - 输出三选一：生成新素材 / 仅下载 PNG / 存入资源库「精灵图/」。
 */
import { computed, ref, watch } from 'vue';

import { useSpriteMerge } from '../composables/useSpriteMerge.js';
import { useWorkspace } from '../composables/useWorkspace.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';

const { state } = useWorkspace();
const { columns, gap, fit, mergeSource, plan, maxColumns, autoColumns, exportSheet } = useSpriteMerge();

const fitOptions = [
  { value: 'contain', label: '等比铺满', hint: '每帧等比缩放到单元格大小，帧与帧视觉尺寸统一' },
  { value: 'original', label: '原始像素', hint: '不缩放，小图在单元格里居中（不产生重采样）' },
];
const busy = ref(false);

watch(maxColumns, (max) => {
  if (columns.value > max) columns.value = max;
});

async function runExport(target) {
  if (!mergeSource.value) return;
  busy.value = true;
  try {
    await exportSheet(target);
  } finally {
    busy.value = false;
  }
}

const summary = computed(() => (plan.value ? `${plan.value.cols} 列 × ${plan.value.rows} 行` : ''));
</script>

<template>
  <section class="sprite-merge">
    <template v-if="mergeSource && plan">
      <dl class="kv">
        <div class="kv-row">
          <dt>帧数</dt>
          <dd class="mono">{{ mergeSource.count }} 张</dd>
        </div>
        <div class="kv-row">
          <dt>单元格</dt>
          <dd class="mono">{{ plan.cell.width }} × {{ plan.cell.height }}</dd>
        </div>
        <div class="kv-row">
          <dt>输出尺寸</dt>
          <dd class="mono accent">{{ plan.width }} × {{ plan.height }}（{{ summary }}）</dd>
        </div>
      </dl>

      <p v-if="mergeSource.sizeCount > 1" class="hint">
        勾选的帧有 {{ mergeSource.sizeCount }} 种尺寸：统一放进 {{ plan.cell.width }}×{{ plan.cell.height }} 的单元格，
        按下面的缩放方式居中排布。
      </p>

      <div class="fit-row">
        <span class="fit-label">缩放</span>
        <SegmentedControl :model-value="fit" :options="fitOptions" size="sm" @update:model-value="fit = $event" />
      </div>

      <RangeField
        label="列数"
        :model-value="columns"
        :min="0"
        :max="maxColumns"
        :hint="`0 表示自动方阵（约 ${autoColumns} 列），最多 ${maxColumns} 列。`"
        @update:model-value="columns = $event"
      />
      <RangeField
        label="间距"
        :model-value="gap"
        :min="0"
        :max="64"
        suffix="px"
        hint="帧与帧之间的透明间距。"
        @update:model-value="gap = $event"
      />

      <div class="merge-actions">
        <button class="btn is-primary is-block" type="button" :disabled="state.busy || busy" @click="runExport('asset')">
          合并并生成新素材
        </button>
        <button class="btn is-block" type="button" :disabled="state.busy || busy" @click="runExport('download')">
          仅下载 PNG
        </button>
        <button class="btn is-block is-ghost" type="button" :disabled="state.busy || busy" @click="runExport('library')">
          合并并存入资源库
        </button>
      </div>

      <p class="hint">中间舞台是合并结果的实时预览；帧顺序按左侧「当前素材」列表顺序，合并不会改动原图。</p>
    </template>

    <p v-else class="empty muted">
      先在左侧「当前素材」勾选要合并的图片（数量 ≥ 1，尺寸可以不同），
      这里会显示合并尺寸，中间舞台实时预览排版。
    </p>
  </section>
</template>

<style scoped>
.sprite-merge {
  padding: 4px 2px 8px;
}

.kv {
  margin: 0 0 10px;
}

.kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
  font-size: 11px;
}

.kv-row dt {
  color: var(--text-muted);
}

.kv-row dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 12px;
}

.fit-label {
  flex: none;
  font-size: 10px;
  color: var(--text-muted);
}

.merge-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
}

.hint {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.accent {
  color: var(--accent);
}
</style>
