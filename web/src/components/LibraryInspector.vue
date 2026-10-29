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
import { formatDuration, formatSize, fetchLibraryVersions } from '../lib/library.js';

const { state, selectedEntries, selectedFolders, selectedSummary, moveTargets, actions } = useLibrary();
const { actions: videoActions } = useVideo();
const { actions: audioActions } = useAudio();

const RENAME_MODES = [
  { value: 'sequence', label: '按序号' },
  { value: 'replace', label: '查找替换' },
  { value: 'prefix', label: '加前后缀' },
];

const single = computed(() => (selectedEntries.value.length === 1 && !selectedFolders.value.length ? selectedEntries.value[0] : null));
/** 只选中一个文件夹时也给出详情与改名入口。 */
const singleFolder = computed(() => (selectedFolders.value.length === 1 && !selectedEntries.value.length ? selectedFolders.value[0] : null));
const singleItem = computed(() => single.value ?? singleFolder.value);
const firstSelected = computed(() => selectedEntries.value[0] ?? selectedFolders.value[0] ?? null);
/** 批量改名同时支持文件与文件夹；顺序与原列表一致。 */
const batchList = computed(() => [...selectedEntries.value, ...selectedFolders.value]);

const renameName = ref('');
const renaming = ref(false);

/** 当前文件的历史版本（服务端在覆盖上传 / 恢复前自动留档）。 */
const versions = ref([]);
const versionsLoading = ref(false);
const versionsError = ref('');
const versionInput = ref(null);

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
  const list = batchList.value;
  if (!list.length) return [];
  return actions.previewBatchRename(config.value, list);
});

const changed = computed(() => preview.value.filter((row) => row.name !== row.entry.name));

const dupCount = computed(() => preview.value.filter((row) => row.duplicate).length);

watch(
  singleItem,
  (entry) => {
    renameName.value = entry?.name ?? '';
    renaming.value = false;
    // 历史版本只属于文件，文件夹选中时不必请求
    void loadVersions(single.value);
  },
  { immediate: true },
);

async function loadVersions(entry) {
  versions.value = [];
  versionsError.value = '';
  if (!entry) return;
  versionsLoading.value = true;
  try {
    const data = await fetchLibraryVersions(entry.path);
    // 切换选中后旧请求可能后返回，只在路径仍然匹配时写入
    if (single.value?.path === entry.path) versions.value = data.versions ?? [];
  } catch (err) {
    if (single.value?.path === entry.path) versionsError.value = `读取历史版本失败：${err.message}`;
  } finally {
    versionsLoading.value = false;
  }
}

function versionTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function openVersion(version) {
  window.open(version.url, '_blank', 'noopener');
}

function pickVersionFile() {
  versionInput.value?.click();
}

async function onVersionFile(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !single.value) return;
  versionsError.value = '';
  const result = await actions.uploadNewVersion(single.value, file);
  if (result) await loadVersions(single.value);
}

async function restoreVersion(version) {
  if (!single.value) return;
  const ok = window.confirm(
    `恢复「${single.value.name}」到 ${versionTime(version.at)} 的版本？当前内容会先存为一版，可再次恢复。`,
  );
  if (!ok) return;
  const result = await actions.restoreVersionHistory(single.value, version.id);
  if (result) await loadVersions(single.value);
}

function mtimeText(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function submitRename() {
  const entry = singleItem.value;
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
  const ok = window.confirm(`确定将选中的 ${state.selected.length} 项移入回收站？之后可在回收站恢复或彻底删除。`);
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

        <!-- 历史版本：覆盖上传会先把旧内容留在这里，随时可预览 / 恢复 -->
        <div class="versions-head">
          <span class="block-title">历史版本</span>
          <span class="versions-count mono">{{ versions.length }}</span>
        </div>
        <div v-if="versionsLoading" class="hint">正在读取历史版本…</div>
        <div v-else-if="versions.length" class="version-list">
          <div v-for="version in versions" :key="version.id" class="version-row">
            <span class="version-time mono" :title="versionTime(version.at)">{{ versionTime(version.at) }}</span>
            <span class="version-size mono">{{ formatSize(version.bytes) }}</span>
            <button class="link-action" type="button" title="在新标签页预览这一版" @click="openVersion(version)">预览</button>
            <button class="link-action" type="button" :disabled="state.busy" @click="restoreVersion(version)">恢复</button>
          </div>
        </div>
        <p v-else class="hint">还没有历史版本。上传新版本时会自动保留旧内容。</p>
        <button class="btn is-block" type="button" :disabled="state.busy" @click="pickVersionFile">
          上传新版本（保留旧版本）
        </button>
        <input ref="versionInput" class="hidden-input" type="file" @change="onVersionFile" />
        <p v-if="versionsError" class="version-error">{{ versionsError }}</p>
      </section>

      <!-- 单个文件夹详情：也支持改名，子文件的版本/尺寸缓存会跟着迁移 -->
      <section v-else-if="singleFolder" class="block">
        <div class="row">
          <label class="label">文件夹名</label>
          <div class="rename">
            <input
              v-model="renameName"
              class="text-input"
              :disabled="!renaming"
              @keydown.enter.prevent="submitRename"
              @keydown.esc="renaming = false"
            />
            <button v-if="!renaming" class="btn is-mini" type="button" @click="renaming = true">改名</button>
            <button v-else class="btn is-mini" type="button" :disabled="state.busy" @click="submitRename">保存</button>
          </div>
        </div>
        <table class="info">
          <tbody>
            <tr>
              <th>类型</th>
              <td>文件夹</td>
            </tr>
            <tr>
              <th>位置</th>
              <td :title="singleFolder.parent || '资源库根目录'">{{ singleFolder.parent || '资源库根目录' }}</td>
            </tr>
            <tr>
              <th>路径</th>
              <td :title="singleFolder.path">{{ singleFolder.path }}</td>
            </tr>
          </tbody>
        </table>
        <div class="actions">
          <button class="btn is-block" type="button" @click="actions.openFolder(singleFolder)">进入文件夹</button>
        </div>
        <p class="hint">改名后，文件夹内文件的尺寸缓存与历史版本记录会一起迁移。</p>
      </section>

      <section v-else-if="firstSelected" class="block">
        <div class="hint">多选时可以在下方批量改名 / 移动 / 删除。</div>
      </section>

      <!-- 批量改名：文件和文件夹都可以 -->
      <section v-if="batchList.length" class="block">
        <div class="block-title">批量改名 · {{ batchList.length }} 项</div>
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
          @click="actions.batchRename(config, batchList)"
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

.versions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.versions-count {
  font-size: 10px;
  color: var(--text-muted);
}

.version-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--panel-2);
  max-height: 150px;
  overflow-y: auto;
}

.version-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.version-time {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.version-size {
  flex: none;
  color: var(--text-muted);
}

.link-action {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 10px;
  cursor: pointer;
}

.link-action:hover:not(:disabled) {
  text-decoration: underline;
}

.link-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.hidden-input {
  display: none;
}

.version-error {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--danger);
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
