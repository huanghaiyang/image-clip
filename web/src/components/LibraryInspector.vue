<script setup>
/**
 * 资源库右侧检查器
 * ----------------
 * 三块内容，按选中状态显示：
 *  1. 单个文件详情 + 重命名 + 一键转入编辑 / 在视频或音频工作区打开；
 *  2. 批量改名（编号 / 查找替换 / 前后缀），先预览新旧对照再提交；
 *  3. 批量移动与删除，目标是资源库内的任意子目录。
 */
import { computed, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { useAudio } from '../composables/useAudio.js';
import { setMode } from '../composables/useAppMode.js';
import { formatDuration, formatSize } from '../lib/library.js';

const { state, selectedEntries, selectedFolders, selectedSummary, moveTargets, actions } = useLibrary();
const { actions: videoActions } = useVideo();
const { actions: audioActions } = useAudio();

const RENAME_MODES = [
  { value: 'sequence', label: '按序号' },
  { value: 'replace', label: '查找替换' },
  { value: 'prefix', label: '加前后缀' },
];

const single = computed(() => (selectedEntries.value.length === 1 && !selectedFolders.value.length ? selectedEntries.value[0] : null));
const firstSelected = computed(() => selectedEntries.value[0] ?? selectedFolders.value[0] ?? null);

const renameName = ref('');
const renaming = ref(false);

const config = ref({
  mode: 'sequence',
  prefix: '',
  suffix: '',
  find: '',
  replace: '',
  start: 1,
  padding: 3,
  withNumber: false,
});

const moveTarget = ref('');

const preview = computed(() => {
  const list = selectedEntries.value;
  if (!list.length) return [];
  return actions.previewBatchRename(config.value, list);
});

const changed = computed(() => preview.value.filter((row) => row.name !== row.entry.name));

const dupCount = computed(() => preview.value.filter((row) => row.duplicate).length);

watch(
  single,
  (entry) => {
    renameName.value = entry?.name ?? '';
    renaming.value = false;
  },
  { immediate: true },
);

function mtimeText(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function submitRename() {
  const entry = single.value;
  if (!entry) return;
  const name = renameName.value.trim();
  if (!name || name === entry.name) {
    renaming.value = false;
    return;
  }
  const ok = await actions.renameOne(entry, name);
  if (ok) renaming.value = false;
}

async function removeAll() {
  if (!state.selected.length) return;
  const ok = window.confirm(`确定删除选中的 ${state.selected.length} 项？删除后不可恢复。`);
  if (ok) await actions.deleteSelected();
}

async function moveAll() {
  if (!state.selected.length) return;
  await actions.moveSelected(moveTarget.value);
}

async function openVideo(entry) {
  setMode('video');
  await videoActions.selectVideo(entry);
}

async function openAudio(entry) {
  setMode('audio');
  await audioActions.selectAudio(entry);
}

function fileInfo(entry) {
  const rows = [
    ['类型', entry.kind],
    ['大小', formatSize(entry.bytes)],
    ['修改时间', mtimeText(entry.mtime)],
    ['路径', entry.path],
  ];
  if (entry.width) rows.splice(1, 0, ['尺寸', `${entry.width}×${entry.height}`]);
  if (entry.duration) rows.splice(1, 0, ['时长', formatDuration(entry.duration)]);
  return rows;
}
</script>

<template>
  <aside class="inspector">
    <div class="panel-head">
      <div class="panel-title">资源详情</div>
      <div class="panel-sub">
        <template v-if="selectedSummary.total">
          已选 {{ selectedSummary.total }} 项 · {{ selectedSummary.files }} 文件 · {{ formatSize(selectedSummary.bytes) }}
        </template>
        <template v-else>未选择任何文件</template>
      </div>
    </div>

    <div class="scroll">
      <!-- 单个文件详情 -->
      <section v-if="single" class="block">
        <div class="row">
          <label class="label">文件名</label>
          <div class="rename">
            <input
              v-model="renameName"
              class="text-input"
              :disabled="!renaming"
              @keydown.enter.prevent="submitRename"
              @keydown.esc="renaming = false"
            />
            <button v-if="!renaming" class="btn is-mini" type="button" @click="renaming = true">改名</button>
            <button v-else class="btn is-mini" type="button" @click="submitRename">保存</button>
          </div>
        </div>
        <table class="info">
          <tbody>
            <tr v-for="[key, value] in fileInfo(single)" :key="key">
              <th>{{ key }}</th>
              <td :title="String(value)">{{ value }}</td>
            </tr>
          </tbody>
        </table>
        <div class="actions">
          <button class="btn is-block" type="button" @click="actions.openPreview(single.path)">预览</button>
          <button v-if="single.kind === 'image'" class="btn is-block" type="button" @click="actions.openInEditor(single)">
            转入图片编辑
          </button>
          <button v-else-if="single.kind === 'video'" class="btn is-block" type="button" @click="openVideo(single)">
            在视频工作区打开
          </button>
          <button v-else-if="single.kind === 'audio'" class="btn is-block" type="button" @click="openAudio(single)">
            在音频工作区打开
          </button>
        </div>
      </section>

      <section v-else-if="firstSelected" class="block">
        <div class="hint">多选时可以在下方批量改名 / 移动 / 删除。</div>
      </section>

      <!-- 批量改名 -->
      <section v-if="selectedEntries.length" class="block">
        <div class="block-title">批量改名 · {{ selectedEntries.length }} 个文件</div>
        <div class="segmented">
          <button
            v-for="item in RENAME_MODES"
            :key="item.value"
            class="seg"
            :class="{ 'is-active': config.mode === item.value }"
            type="button"
            @click="config.mode = item.value"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="grid2">
          <label class="field">
            <span>前缀</span>
            <input v-model="config.prefix" class="text-input" placeholder="frame-" />
          </label>
          <label class="field">
            <span>后缀</span>
            <input v-model="config.suffix" class="text-input" placeholder="-hd" />
          </label>
          <template v-if="config.mode === 'replace'">
            <label class="field">
              <span>查找</span>
              <input v-model="config.find" class="text-input" placeholder="旧文字" />
            </label>
            <label class="field">
              <span>替换为</span>
              <input v-model="config.replace" class="text-input" placeholder="新文字" />
            </label>
          </template>
          <template v-else-if="config.mode === 'sequence'">
            <label class="field">
              <span>起始</span>
              <input v-model.number="config.start" class="text-input" type="number" min="0" />
            </label>
            <label class="field">
              <span>位数</span>
              <input v-model.number="config.padding" class="text-input" type="number" min="1" max="6" />
            </label>
          </template>
          <label v-else class="field is-inline">
            <input v-model="config.withNumber" type="checkbox" />
            <span>追加序号</span>
          </label>
        </div>

        <div class="preview-list">
          <div v-for="row in preview.slice(0, 8)" :key="row.entry.path" class="preview-row">
            <span class="old" :title="row.entry.name">{{ row.entry.name }}</span>
            <span class="arrow">→</span>
            <span class="new" :class="{ 'is-change': row.name !== row.entry.name, 'is-dup': row.duplicate }" :title="row.name">
              {{ row.name }}
            </span>
          </div>
          <div v-if="preview.length > 8" class="preview-more">还有 {{ preview.length - 8 }} 个…</div>
          <div v-if="dupCount" class="dup-warn">有 {{ dupCount }} 个新名与前面重复，服务端会自动加序号。</div>
        </div>

        <button
          class="btn is-block"
          type="button"
          :disabled="state.busy || !changed.length"
          @click="actions.batchRename(config, selectedEntries)"
        >
          应用批量改名{{ changed.length ? `（${changed.length} 项）` : '' }}
        </button>
      </section>

      <!-- 移动 / 删除 -->
      <section v-if="state.selected.length" class="block">
        <div class="block-title">移动到</div>
        <div class="move-row">
          <select v-model="moveTarget" class="select">
            <option v-for="target in moveTargets" :key="target.path || '__root__'" :value="target.path">
              {{ target.name }}
            </option>
          </select>
          <button class="btn is-mini" type="button" :disabled="state.busy" @click="moveAll">移动</button>
        </div>
        <button class="btn is-block is-ghost is-danger" type="button" :disabled="state.busy" @click="removeAll">
          删除选中项
        </button>
      </section>

      <section v-if="!firstSelected" class="block empty">
        <div class="empty-title">还没有选择</div>
        <div class="empty-hint">
          <p>单击选中、Ctrl 点按多选，双击打开：</p>
          <p>· 图片 → 预览，可一键「转入图片编辑」</p>
          <p>· 视频 → 直接切到视频工作区</p>
          <p>· 文件夹 → 进入子目录</p>
        </div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex: none;
  min-height: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
}

.panel-head {
  flex: none;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--border);
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.panel-sub {
  margin-top: 3px;
  font-size: 10px;
  color: var(--text-muted);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 16px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.block:last-child {
  border-bottom: 0;
}

.block-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 10px;
  color: var(--text-muted);
}

.rename {
  display: flex;
  gap: 6px;
}

.text-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
}

.text-input:disabled {
  color: var(--text-2);
  background: transparent;
  border-color: transparent;
}

.info {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}

.info th {
  width: 64px;
  padding: 4px 0;
  text-align: left;
  font-weight: 400;
  color: var(--text-muted);
  vertical-align: top;
}

.info td {
  padding: 4px 0;
  color: var(--text-2);
  word-break: break-all;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.seg {
  flex: 1;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
}

.seg + .seg {
  border-left: 1px solid var(--border);
}

.seg.is-active {
  background: var(--accent-soft, rgba(90, 160, 255, 0.16));
  color: var(--text);
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.field.is-inline {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  grid-column: span 2;
}

.preview-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--panel-2);
  font-size: 10px;
  max-height: 168px;
  overflow-y: auto;
}

.preview-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.old,
.new {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.old {
  color: var(--text-muted);
  text-align: right;
}

.new {
  color: var(--text-2);
}

.new.is-change {
  color: var(--accent);
}

.new.is-dup {
  color: var(--warn, #e0b04a);
}

.arrow {
  flex: none;
  color: var(--text-muted);
}

.preview-more {
  color: var(--text-muted);
}

.dup-warn {
  color: var(--warn, #e0b04a);
}

.move-row {
  display: flex;
  gap: 6px;
}

.select {
  flex: 1;
  min-width: 0;
  height: 26px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
}

.hint {
  font-size: 10px;
  color: var(--text-muted);
}

.empty {
  align-items: flex-start;
}

.empty-title {
  font-size: 11px;
  color: var(--text-2);
}

.empty-hint {
  font-size: 10px;
  line-height: 1.7;
  color: var(--text-muted);
}

.empty-hint p {
  margin: 0;
}
</style>
