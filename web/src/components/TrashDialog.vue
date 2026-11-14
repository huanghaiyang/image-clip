<script setup>
/**
 * 回收站面板
 * ----------
 * 资源库删除的文件/文件夹会先进入服务端回收站（`.trash`），这里提供：
 *  - 列表与缩略图（图片/视频显示真实缩略图，其余显示类型标签）；
 *  - 选中后可预览原图、播放视频/音频；
 *  - 单项恢复、彻底删除，以及清空回收站。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useConfirm } from '../composables/useConfirm.js';
import {
  fetchLibraryTrash,
  fetchLibraryTrashContents,
  formatDuration,
  formatSize,
  libraryThumbUrl,
  purgeLibraryTrash,
  restoreLibraryTrash,
} from '../lib/library.js';

defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const { actions } = useLibrary();
const { confirm } = useConfirm();

const items = ref([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const previewId = ref('');
const dialogEl = ref(null);

/** 文件夹预览：内容列表、加载/错误状态，以及在文件夹内放大查看的文件。 */
const folderContents = ref(null);
const folderLoading = ref(false);
const folderError = ref('');
const folderFile = ref(null);
let folderToken = 0;

const previewItem = computed(() => items.value.find((item) => item.id === previewId.value) ?? null);
const totalBytes = computed(() => items.value.reduce((sum, item) => sum + (item.bytes ?? 0), 0));

const folderSummary = computed(() => {
  const data = folderContents.value;
  if (!data) return '';
  const parts = [];
  if (data.folderCount) parts.push(`${data.folderCount} 个文件夹`);
  parts.push(`${data.count} 个文件`);
  return parts.join(' · ');
});

const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', file: '文件', folder: '文件夹' };

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 尺寸信息：图片/视频显示宽×高，音频显示时长。 */
function dimText(item) {
  if (item.width && item.height) return `${item.width}×${item.height}`;
  if (item.duration) return formatDuration(item.duration);
  if (item.isDir) return '文件夹';
  return KIND_LABEL[item.kind] || '文件';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchLibraryTrash();
    items.value = data.items ?? [];
    if (previewId.value && !items.value.some((item) => item.id === previewId.value)) previewId.value = '';
  } catch (err) {
    error.value = `读取回收站失败：${err.message}`;
  } finally {
    loading.value = false;
  }
}

/** 预览文案里文件夹显示内容统计，文件沿用尺寸/时长。 */
function previewDim(item) {
  if (item.isDir) return folderContents.value ? `文件夹 · ${folderSummary.value}` : '文件夹';
  return dimText(item);
}

function resetFolderPreview() {
  folderToken += 1;
  folderContents.value = null;
  folderLoading.value = false;
  folderError.value = '';
  folderFile.value = null;
}

async function loadFolderContents(item) {
  const token = ++folderToken;
  folderLoading.value = true;
  folderError.value = '';
  try {
    const data = await fetchLibraryTrashContents(item.id);
    if (token !== folderToken) return;
    folderContents.value = data;
  } catch (err) {
    if (token !== folderToken) return;
    folderError.value = `读取文件夹内容失败：${err.message}`;
  } finally {
    if (token === folderToken) folderLoading.value = false;
  }
}

watch(previewId, (id) => {
  const item = items.value.find((row) => row.id === id);
  resetFolderPreview();
  if (item?.isDir) void loadFolderContents(item);
});

async function restore(item) {
  busy.value = true;
  error.value = '';
  try {
    const result = await restoreLibraryTrash([item.id]);
    const failed = result.results?.find((row) => row.ok === false);
    if (failed) throw new Error(failed.error || '恢复失败');
    const restoredPath = result.results?.[0]?.path ?? item.originalPath;
    previewId.value = '';
    await load();
    // 资源库列表同步刷新，并跳到恢复到的目录，用户能立刻看到文件
    await actions.refresh({ quiet: true });
    actions.setDir(item.dir ?? '');
    const restored = actions.entryByPath(restoredPath);
    if (restored) actions.openPreview(restored.path);
  } catch (err) {
    error.value = `恢复失败：${err.message}`;
  } finally {
    busy.value = false;
  }
}

async function purge(item) {
  const ok = await confirm({
    title: '彻底删除',
    message: `「${item.name}」将被永久删除。`,
    detail: item.originalPath ? `原位置：${item.originalPath}` : '',
    confirmText: '彻底删除',
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await purgeLibraryTrash([item.id]);
    if (previewId.value === item.id) previewId.value = '';
    await load();
  } catch (err) {
    error.value = `删除失败：${err.message}`;
  } finally {
    busy.value = false;
  }
}

async function purgeAll() {
  if (!items.value.length) return;
  const ok = await confirm({
    title: '清空回收站',
    message: `将永久删除回收站中的 ${items.value.length} 项。`,
    detail: '此操作不可撤销。',
    confirmText: '清空回收站',
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  error.value = '';
  try {
    await purgeLibraryTrash([], true);
    previewId.value = '';
    await load();
  } catch (err) {
    error.value = `清空失败：${err.message}`;
  } finally {
    busy.value = false;
  }
}

function close() {
  if (busy.value) return;
  folderFile.value = null;
  emit('close');
}

function onKeydown(event) {
  if (event.key !== 'Escape') return;
  if (folderFile.value) {
    folderFile.value = null;
    return;
  }
  if (previewId.value) {
    previewId.value = '';
    return;
  }
  close();
}

onMounted(() => {
  load();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="trash-modal">
      <div v-if="open" class="trash-backdrop" @click.self="close">
        <section ref="dialogEl" class="trash-dialog" role="dialog" aria-modal="true" aria-label="回收站" tabindex="-1">
          <header class="trash-head">
            <span class="trash-mark" aria-hidden="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                <path d="M4 7h16M10 4h4M6 7l1 12.2A1.8 1.8 0 0 0 8.8 21h6.4a1.8 1.8 0 0 0 1.8-1.8L18 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </span>
            <div class="trash-heading">
              <h2>回收站</h2>
              <p>删除的资源会先放在这里，可随时恢复或彻底删除</p>
            </div>
            <button class="trash-close" type="button" title="关闭（Esc）" :disabled="busy" @click="close">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="trash-body">
            <p v-if="error" class="trash-error">{{ error }}</p>

            <div v-if="loading" class="trash-empty">正在读取回收站…</div>

            <div v-else-if="!items.length" class="trash-empty">
              <p class="empty-title">回收站是空的</p>
              <p class="muted">从资源库删除的文件会先进入这里。</p>
            </div>

            <div
              v-else
              class="trash-layout"
              :class="{ 'has-preview': previewItem, 'has-folder-preview': previewItem?.isDir }"
            >
              <ul class="trash-list">
                <li
                  v-for="item in items"
                  :key="item.id"
                  class="trash-item"
                  :class="{ 'is-active': item.id === previewId }"
                >
                  <button class="trash-card" type="button" :title="`预览 ${item.name}`" @click="previewId = item.id">
                    <span class="trash-thumb">
                      <img v-if="item.thumbUrl" :src="libraryThumbUrl(item, 160)" :alt="item.name" loading="lazy" draggable="false" />
                      <span v-else class="trash-thumb-label">{{ KIND_LABEL[item.kind] || '文件' }}</span>
                    </span>
                    <span class="trash-meta">
                      <span class="trash-name">{{ item.name }}</span>
                      <span class="trash-path mono" :title="item.originalPath">{{ item.originalPath }}</span>
                      <span class="trash-sub mono">{{ dimText(item) }} · {{ formatSize(item.bytes) }} · {{ formatDateTime(item.deletedAt) }}</span>
                    </span>
                  </button>
                  <div class="trash-actions">
                    <button class="btn is-mini is-ghost" type="button" :disabled="busy" @click="restore(item)">恢复</button>
                    <button class="btn is-mini is-danger" type="button" :disabled="busy" @click="purge(item)">彻底删除</button>
                  </div>
                </li>
              </ul>

              <aside v-if="previewItem" class="trash-preview">
                <div class="trash-preview-stage" :class="{ 'is-folder': previewItem.isDir }">
                  <template v-if="previewItem.isDir">
                    <div v-if="folderFile" class="trash-folder-file-view">
                      <div class="trash-folder-bar">
                        <button class="trash-folder-back" type="button" @click="folderFile = null">← 文件夹</button>
                        <span class="trash-folder-current mono" :title="folderFile.relativePath">
                          {{ folderFile.relativePath }}
                        </span>
                      </div>
                      <div class="trash-folder-file-stage">
                        <img
                          v-if="folderFile.kind === 'image'"
                          :src="folderFile.url"
                          :alt="folderFile.name"
                        />
                        <video
                          v-else-if="folderFile.kind === 'video'"
                          :src="folderFile.url"
                          controls
                          preload="metadata"
                          playsinline
                        />
                        <audio
                          v-else-if="folderFile.kind === 'audio'"
                          :src="folderFile.url"
                          controls
                          preload="metadata"
                        />
                        <span v-else class="trash-preview-empty">该类型暂不支持预览</span>
                      </div>
                    </div>

                    <div v-else-if="folderLoading" class="trash-preview-empty">正在读取文件夹内容…</div>
                    <p v-else-if="folderError" class="trash-folder-error">{{ folderError }}</p>
                    <template v-else-if="folderContents">
                      <div class="trash-folder-head">
                        <span>{{ folderSummary }}</span>
                        <span v-if="folderContents.truncated" class="trash-folder-trunc">
                          仅显示前 {{ folderContents.items.length }} 个
                        </span>
                      </div>
                      <div v-if="folderContents.items.length" class="trash-folder-grid">
                        <button
                          v-for="file in folderContents.items"
                          :key="file.path"
                          class="trash-folder-file"
                          type="button"
                          :title="file.relativePath"
                          @click="folderFile = file"
                        >
                          <span class="trash-folder-thumb">
                            <img
                              v-if="file.thumbUrl"
                              :src="file.thumbUrl"
                              :alt="file.name"
                              loading="lazy"
                              draggable="false"
                            />
                            <span v-else class="trash-folder-label">{{ KIND_LABEL[file.kind] || '文件' }}</span>
                          </span>
                          <span class="trash-folder-name">{{ file.name }}</span>
                          <span class="trash-folder-rel mono">{{ file.relativePath }}</span>
                        </button>
                      </div>
                      <p v-else class="trash-preview-empty">
                        {{ folderContents.folderCount ? '文件夹中没有可预览的文件' : '文件夹是空的' }}
                      </p>
                    </template>
                  </template>
                  <img v-else-if="previewItem.kind === 'image'" :src="previewItem.url" :alt="previewItem.name" />
                  <video
                    v-else-if="previewItem.kind === 'video'"
                    :src="previewItem.url"
                    controls
                    preload="metadata"
                    playsinline
                  />
                  <audio v-else-if="previewItem.kind === 'audio'" :src="previewItem.url" controls preload="metadata" />
                  <span v-else class="trash-preview-empty">该类型暂不支持预览，可先恢复后再查看</span>
                </div>
                <div class="trash-preview-info">
                  <span class="trash-preview-name" :title="previewItem.name">{{ previewItem.name }}</span>
                  <span class="trash-preview-line mono">{{ previewDim(previewItem) }} · {{ formatSize(previewItem.bytes) }}</span>
                  <span class="trash-preview-line mono" :title="previewItem.originalPath">原位置：{{ previewItem.originalPath }}</span>
                  <span class="trash-preview-line mono">删除于 {{ formatDateTime(previewItem.deletedAt) }}</span>
                </div>
                <div class="trash-preview-actions">
                  <button class="btn is-mini is-ghost" type="button" :disabled="busy" @click="restore(previewItem)">恢复</button>
                  <button class="btn is-mini is-danger" type="button" :disabled="busy" @click="purge(previewItem)">彻底删除</button>
                </div>
              </aside>
            </div>
          </div>

          <footer class="trash-foot">
            <span class="trash-summary muted">
              {{ items.length }} 项 · {{ formatSize(totalBytes) }}
            </span>
            <span class="flex-spacer" />
            <button class="btn is-mini is-ghost" type="button" :disabled="busy || loading" @click="load">刷新</button>
            <button class="btn is-mini is-danger" type="button" :disabled="busy || !items.length" @click="purgeAll">
              清空回收站
            </button>
            <button class="btn" type="button" :disabled="busy" @click="close">关闭</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.trash-backdrop {
  position: fixed;
  inset: 0;
  z-index: 78;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
}

.trash-dialog {
  display: flex;
  flex-direction: column;
  width: min(940px, 100%);
  max-height: min(86vh, 760px);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  outline: none;
}

.trash-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 16px 14px 18px;
  border-bottom: 1px solid var(--border);
}

.trash-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

.trash-heading {
  flex: 1;
  min-width: 0;
}

.trash-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.trash-heading p {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.trash-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.trash-close:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.trash-close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.trash-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 18px 16px;
  overflow-y: auto;
}

.trash-error {
  margin: 0;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 13%, transparent);
  color: var(--danger);
  font-size: 10px;
  line-height: 1.5;
}

.trash-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 200px;
  color: var(--text-muted);
  font-size: 11px;
}

.trash-empty .empty-title {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
}

.trash-empty p {
  margin: 0;
}

.trash-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.trash-layout.has-preview {
  grid-template-columns: minmax(0, 1fr) 300px;
}

/* 文件夹预览需要更宽的网格来展示缩略图 */
.trash-layout.has-folder-preview {
  grid-template-columns: minmax(0, 1fr) 390px;
}

.trash-list {
  margin: 0;
  padding: 0;
  max-height: 100%;
  overflow-y: auto;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
}

.trash-item + .trash-item {
  border-top: 1px solid var(--border);
}

.trash-item.is-active {
  background: var(--accent-soft);
}

.trash-card {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  text-align: left;
}

.trash-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 72px;
  height: 54px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.04) 75%) 0 0 / 12px 12px,
    var(--panel-3);
  color: var(--text-muted);
}

.trash-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.trash-thumb-label {
  font-size: 10px;
  color: var(--text-muted);
}

.trash-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.trash-name {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-path,
.trash-sub {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.trash-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.trash-preview-stage {
  display: grid;
  place-items: center;
  min-height: 160px;
  max-height: 240px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: #0b0b0d;
}

.trash-preview-stage img,
.trash-preview-stage video {
  display: block;
  max-width: 100%;
  max-height: 240px;
  object-fit: contain;
}

.trash-preview-stage audio {
  width: 100%;
  padding: 0 8px;
}

.trash-preview-empty {
  padding: 16px;
  color: var(--text-muted);
  font-size: 11px;
  text-align: center;
}

/* ---------------------------------------------------------- 文件夹内容预览 */
.trash-preview-stage.is-folder {
  display: block;
  max-height: 340px;
  padding: 8px;
  overflow-y: auto;
  background: var(--panel-3);
}

.trash-folder-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  padding: 0 2px;
  color: var(--text-muted);
  font-size: 10px;
}

.trash-folder-trunc {
  color: var(--warn);
  white-space: nowrap;
}

.trash-folder-error {
  margin: 0;
  padding: 12px 6px;
  color: var(--danger);
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
}

.trash-folder-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.trash-folder-file {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.trash-folder-file:hover {
  border-color: rgba(13, 153, 255, 0.45);
  background: var(--hover);
}

.trash-folder-thumb {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  border-radius: 3px;
  background: #0b0b0d;
}

.trash-folder-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.trash-folder-label {
  color: var(--text-muted);
  font-size: 10px;
}

.trash-folder-name,
.trash-folder-rel {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-folder-name {
  color: var(--text);
  font-size: 10px;
}

.trash-folder-rel {
  color: var(--text-muted);
  font-size: 9px;
  opacity: 0.85;
}

.trash-folder-file-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.trash-folder-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.trash-folder-back {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--accent);
  font-size: 10px;
  cursor: pointer;
}

.trash-folder-back:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.trash-folder-current {
  flex: 1;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-folder-file-stage {
  display: grid;
  place-items: center;
  min-height: 180px;
  max-height: 260px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: #0b0b0d;
}

.trash-folder-file-stage img,
.trash-folder-file-stage video {
  display: block;
  max-width: 100%;
  max-height: 260px;
  object-fit: contain;
}

.trash-folder-file-stage audio {
  width: 100%;
  padding: 0 8px;
}

.trash-preview-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.trash-preview-name {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-preview-line {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-preview-actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}

.trash-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.trash-summary {
  font-size: 10px;
}

.flex-spacer {
  flex: 1;
}

.trash-modal-enter-active,
.trash-modal-leave-active {
  transition: opacity 0.16s ease;
}

.trash-modal-enter-from,
.trash-modal-leave-to {
  opacity: 0;
}

.trash-modal-enter-active .trash-dialog {
  transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.trash-modal-enter-from .trash-dialog {
  transform: translateY(10px) scale(0.985);
}

@media (max-width: 760px) {
  .trash-layout.has-preview,
  .trash-layout.has-folder-preview {
    grid-template-columns: 1fr;
  }

  .trash-preview {
    display: none;
  }
}
</style>
