<script setup>
/**
 * 音频工作区右侧面板：音频信息 → 选区与裁剪 → 导出与保存。
 *
 * 裁剪是“非破坏式”的：原文件不动，裁剪结果编码成 PCM16 WAV 后
 * 写入资源库（默认 `音频/`），同时把编辑缓冲替换成裁剪结果便于继续试听。
 */
import { computed } from 'vue';

import { setMode } from '../composables/useAppMode.js';
import { useAudio } from '../composables/useAudio.js';
import { useLibrary } from '../composables/useLibrary.js';
import { downloadBlob, formatAudioClock, formatAudioTime } from '../lib/audio.js';
import { formatSize } from '../lib/library.js';

const { state, duration, hasAudio, hasSelection, selectionLength, actions } = useAudio();
const { actions: libraryActions } = useLibrary();

const sampleRateText = computed(() => (state.sampleRate ? `${(state.sampleRate / 1000).toFixed(1)} kHz` : '—'));
const channelsText = computed(() => {
  if (!state.channels) return '—';
  return state.channels === 1 ? '单声道' : state.channels === 2 ? '立体声' : `${state.channels} 声道`;
});
const selectionText = computed(() =>
  hasSelection.value
    ? `${formatAudioTime(state.selection.start)} – ${formatAudioTime(state.selection.end)}`
    : '未选择（默认整段）',
);

/** 裁剪结果大致字节数：采样率 × 声道 × 2 字节（PCM16）。 */
const estimateBytes = computed(() => {
  if (!state.duration) return 0;
  const seconds = hasSelection.value ? selectionLength.value : state.duration;
  return Math.round(seconds * state.sampleRate * Math.max(1, state.channels) * 2);
});

const canTrim = computed(() => hasAudio.value && hasSelection.value && selectionLength.value >= 0.05 && !state.busy);

function onBoundaryChange(which, event) {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) {
    event.target.value = String(which === 'start' ? state.selection.start : state.selection.end);
    return;
  }
  if (which === 'start') actions.setSelection(value, state.selection.end);
  else actions.setSelection(state.selection.start, value);
}

function auditionSelection() {
  if (!hasSelection.value) return;
  actions.setLoopSelection(true);
  actions.seek(state.selection.start);
  actions.play();
}

function exportDownload() {
  const result = actions.exportWav();
  if (result) downloadBlob(result.blob, result.name);
}

async function trim({ save }) {
  await actions.applyTrim({ save });
}

function openExportFolder() {
  const dir = state.lastExport?.dir ?? '';
  libraryActions.setDir(dir);
  setMode('library');
}
</script>

<template>
  <aside class="audio-panel panel">
    <div class="panel-title">
      <span>音频 · 处理</span>
      <span class="chip mono">{{ formatAudioClock(duration) }}</span>
    </div>

    <div class="scroll">
      <!-- 音频信息 -->
      <section class="section">
        <h3 class="section-title">音频信息</h3>
        <p v-if="!state.activePath" class="note">从左侧选择音频后显示详细信息。</p>
        <dl v-else class="kv">
          <div class="kv-row">
            <dt>名称</dt>
            <dd class="mono" :title="state.activePath">{{ state.name }}</dd>
          </div>
          <div class="kv-row">
            <dt>时长</dt>
            <dd class="mono">{{ formatAudioTime(duration) }}</dd>
          </div>
          <div class="kv-row">
            <dt>采样率</dt>
            <dd class="mono">{{ sampleRateText }}</dd>
          </div>
          <div class="kv-row">
            <dt>声道</dt>
            <dd class="mono">{{ channelsText }}</dd>
          </div>
        </dl>
      </section>

      <!-- 选区与裁剪 -->
      <section class="section">
        <h3 class="section-title">裁剪区间</h3>
        <p v-if="!hasAudio" class="note">先选择音频，再在时间轴上拖动框选要保留的区间。</p>

        <template v-else>
          <div class="boundary-row">
            <label class="boundary">
              <span class="field-label">起点 (s)</span>
              <input
                class="text-input mono"
                type="number"
                min="0"
                :max="duration"
                step="0.01"
                :value="Number(state.selection.start.toFixed(3))"
                @change="onBoundaryChange('start', $event)"
              />
            </label>
            <label class="boundary">
              <span class="field-label">终点 (s)</span>
              <input
                class="text-input mono"
                type="number"
                min="0"
                :max="duration"
                step="0.01"
                :value="Number(state.selection.end.toFixed(3))"
                @change="onBoundaryChange('end', $event)"
              />
            </label>
          </div>

          <div class="quick-row">
            <button class="btn is-mini" type="button" @click="actions.selectAll()">全选</button>
            <button class="btn is-mini" type="button" @click="actions.clearSelection()">清除</button>
            <button class="btn is-mini" type="button" :disabled="!hasSelection" @click="auditionSelection">试听选区</button>
          </div>

          <p class="readonly-line">
            <span class="field-label">保留</span>
            <span class="mono">{{ selectionText }}</span>
          </p>
          <p class="note">
            共 {{ selectionLength ? selectionLength.toFixed(2) : '0.00' }} 秒 · 预计 WAV 约
            {{ formatSize(estimateBytes) }}。原文件不会被修改。
          </p>

          <div class="field-row">
            <div class="field-head">
              <label class="field-label">保存目录</label>
            </div>
            <input
              class="text-input"
              type="text"
              :value="state.outputDir"
              placeholder="音频"
              @input="actions.setOutputDir($event.target.value)"
            />
          </div>

          <button class="btn is-primary is-block" type="button" :disabled="!canTrim" @click="trim({ save: true })">
            {{ state.busy ? '正在裁剪…' : '裁剪并保存到资源库' }}
          </button>
          <button class="btn is-block" type="button" :disabled="!canTrim" @click="trim({ save: false })">
            仅裁剪（可继续试听）
          </button>
          <button class="btn is-block" type="button" :disabled="!hasAudio || state.busy" @click="actions.reloadOriginal()">
            还原原始音频
          </button>

          <div v-if="state.lastExport" class="result-box">
            <div class="result-head">
              <span>上次保存</span>
              <span class="chip mono">{{ formatSize(state.lastExport.bytes) }}</span>
            </div>
            <p class="result-path mono" :title="state.lastExport.path">{{ state.lastExport.path }}</p>
            <button class="btn is-block" type="button" @click="openExportFolder">在资源库查看</button>
          </div>
        </template>
      </section>

      <!-- 导出 -->
      <section class="section is-last">
        <h3 class="section-title">导出</h3>
        <p class="note">导出的是当前编辑缓冲（裁剪后即为裁剪结果），格式为未压缩 PCM16 WAV。</p>
        <button class="btn is-block" type="button" :disabled="!hasAudio || state.busy" @click="exportDownload">
          下载 WAV
        </button>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.audio-panel {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex: none;
  border-left: 1px solid var(--border);
}

.scroll {
  flex: 1;
  overflow-y: auto;
}

.section.is-last {
  border-bottom: none;
}

.note {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.kv {
  margin: 0;
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
  white-space: nowrap;
}

.kv-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.boundary-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.boundary {
  flex: 1;
  min-width: 0;
}

.boundary .text-input {
  margin-top: 4px;
}

.quick-row {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.readonly-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  font-size: 11px;
}

.field-label {
  display: block;
  color: var(--text-2);
}

.field-row {
  margin: 10px 0;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.text-input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
}

.text-input:focus {
  outline: none;
  border-color: var(--accent);
}

.audio-panel .btn.is-block + .btn.is-block {
  margin-top: 6px;
}

.result-box {
  margin-top: 10px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 11px;
}

.result-path {
  margin: 0 0 6px;
  color: var(--text-muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}
</style>
