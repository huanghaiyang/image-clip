<script setup>
/**
 * 上传文件选择器（应用内弹窗）
 * ----------------------------
 * 代替原生 <input type=file> 的选择框：统一使用应用的设计令牌，支持
 *  - 拖拽 / 点击浏览 / 粘贴文件；
 *  - 选择后先预览清单（图片显示缩略图），可逐个移除；
 *  - 资源库模式可编辑目标子目录，上传时显示逐文件进度；
 *  - 导入完成回调，方便调用方自动选中新上传的视频 / 音频。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { closeUploadPicker, useUploadPicker } from '../composables/useUploadPicker.js';
import { useLibrary } from '../composables/useLibrary.js';
import { useWorkspace } from '../composables/useWorkspace.js';
import { formatSize } from '../lib/library.js';

const { state: pickerState } = useUploadPicker();
const { state: libraryState, actions: libraryActions } = useLibrary();
const { state: workspaceState, actions: workspaceActions } = useWorkspace();

const config = computed(() => pickerState.config);

const inputEl = ref(null);
const dialogEl = ref(null);
const items = ref([]);
const dragging = ref(false);
const uploading = ref(false);
const success = ref(false);
const error = ref('');
const notice = ref('');
const targetDir = ref('');

let closeTimer = 0;

const KIND_LABEL = { image: '图片', video: '视频', audio: '音频', file: '文件' };
const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
};

const typeLabel = computed(() => {
  const accept = String(config.value.accept || '*/*');
  if (accept.includes('*/*') || accept === '*') return '任意文件';
  const labels = [];
  if (accept.includes('image/')) labels.push('图片');
  if (accept.includes('video/')) labels.push('视频');
  if (accept.includes('audio/')) labels.push('音频');
  return labels.length ? labels.join(' / ') : '文件';
});

const subtitle = computed(() => {
  if (config.value.description) return config.value.description;
  return config.value.dest === 'library'
    ? '文件会写入资源库，之后可在资源库工作区统一管理'
    : '图片会加入左侧素材列表，不会写入资源库';
});

const totalSize = computed(() => items.value.reduce((sum, item) => sum + item.size, 0));
const summary = computed(() =>
  items.value.length ? `共 ${items.value.length} 个文件 · ${formatSize(totalSize.value)}` : `支持 ${typeLabel.value}${config.value.multiple ? '，可多选' : ''}`,
);

const progressText = computed(() => {
  if (config.value.dest === 'workspace') return `正在导入 ${items.value.length} 个文件…`;
  const upload = libraryState.upload;
  const total = upload?.total || items.value.length;
  const index = upload?.index || 1;
  if (!upload?.active) return '准备上传…';
  return `${index}/${total} · ${upload.percent || 0}%${upload.name ? ` · ${upload.name}` : ''}`;
});

const progressPercent = computed(() => (config.value.dest === 'workspace' ? 0 : libraryState.upload?.percent || 0));

function kindOf(file) {
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = String(file.name.split('.').pop() || '').toLowerCase();
  return EXT_KIND[ext] || 'file';
}

// ------------------------------------------------------------- 文件类型过滤

const MIME_EXT = {
  'image/': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'],
  'video/': ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'],
  'audio/': ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus'],
};

function isAccepted(file) {
  const rules = String(config.value.accept || '*/*')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  if (!rules.length || rules.includes('*/*') || rules.includes('*')) return true;

  const type = String(file.type || '').toLowerCase();
  const ext = String(file.name.split('.').pop() || '').toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return ext === rule.slice(1);
    if (rule.endsWith('/*')) {
      const prefix = rule.slice(0, -1);
      return type.startsWith(prefix) || (MIME_EXT[prefix] || []).includes(ext);
    }
    return type === rule;
  });
}

// ------------------------------------------------------------- 选择与移除

function addFiles(fileList) {
  if (uploading.value || success.value) return;
  const incoming = [...(fileList ?? [])].filter(Boolean);
  if (!incoming.length) return;

  const accepted = [];
  let rejected = 0;
  for (const file of incoming) {
    if (!isAccepted(file)) {
      rejected += 1;
      continue;
    }
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (items.value.some((item) => item.key === key)) continue;
    accepted.push({
      key,
      file,
      name: file.name,
      size: file.size,
      kind: kindOf(file),
      url: kindOf(file) === 'image' ? URL.createObjectURL(file) : '',
    });
  }

  let next = [...items.value, ...accepted];
  if (!config.value.multiple && next.length > 1) {
    // 只保留最后选中的一个，其余缩略图 URL 需要立即释放
    next.slice(0, -1).forEach((item) => item.url && URL.revokeObjectURL(item.url));
    next = [next[next.length - 1]];
  }
  items.value = next;
  notice.value = rejected ? `已忽略 ${rejected} 个不支持的文件` : '';
  error.value = '';
}

function removeItem(item) {
  if (uploading.value) return;
  if (item.url) URL.revokeObjectURL(item.url);
  items.value = items.value.filter((entry) => entry.key !== item.key);
  notice.value = '';
}

function clearAll() {
  if (uploading.value) return;
  items.value.forEach((item) => item.url && URL.revokeObjectURL(item.url));
  items.value = [];
  notice.value = '';
}

function browse() {
  if (uploading.value || success.value) return;
  inputEl.value?.click();
}

function onInputChange(event) {
  const input = event.target;
  addFiles(input.files);
  // 清空 input，允许再次选择同一个文件（否则 change 不会触发）
  input.value = '';
}

function onDrop(event) {
  dragging.value = false;
  addFiles(event.dataTransfer?.files);
}

function onDragLeave(event) {
  // 只有指针真正离开整个拖拽区才取消高亮，避免子元素触发闪烁
  if (!event.currentTarget.contains(event.relatedTarget)) dragging.value = false;
}

// ------------------------------------------------------------- 上传

async function submit() {
  if (!items.value.length || uploading.value || success.value) return;
  const files = items.value.map((item) => item.file);
  const beforeLibraryError = libraryState.error;
  const beforeWorkspaceError = workspaceState.error;

  uploading.value = true;
  error.value = '';
  notice.value = '';

  try {
    let uploaded = [];
    if (config.value.dest === 'library') {
      uploaded = await libraryActions.uploadFiles(files, { dir: targetDir.value });
      if (libraryState.error && libraryState.error !== beforeLibraryError) throw new Error(libraryState.error);
      if (uploaded.length !== files.length) throw new Error('部分文件上传失败，请重试');
    } else {
      await workspaceActions.addFiles(files);
      if (workspaceState.error && workspaceState.error !== beforeWorkspaceError) throw new Error(workspaceState.error);
    }

    uploading.value = false;
    success.value = true;
    if (typeof config.value.onUploaded === 'function') {
      try {
        await config.value.onUploaded(uploaded);
      } catch {
        /* 回调失败不影响上传结果 */
      }
    }
    closeTimer = window.setTimeout(() => close(), 800);
  } catch (err) {
    uploading.value = false;
    error.value = err?.message || '上传失败';
  }
}

// ------------------------------------------------------------- 打开 / 关闭

function close() {
  if (uploading.value) return;
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = 0;
  }
  closeUploadPicker();
}

function resetState() {
  items.value.forEach((item) => item.url && URL.revokeObjectURL(item.url));
  items.value = [];
  uploading.value = false;
  success.value = false;
  error.value = '';
  notice.value = '';
  dragging.value = false;
}

watch(
  () => pickerState.open,
  (open) => {
    if (!open) {
      resetState();
      return;
    }
    resetState();
    // null = 资源库当前目录；'' = 根目录
    targetDir.value = config.value.dir ?? libraryState.currentDir ?? '';
    nextTick(() => dialogEl.value?.focus());
  },
);

function onKeydown(event) {
  if (!pickerState.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

function onPaste(event) {
  if (!pickerState.open || uploading.value) return;
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('paste', onPaste);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('paste', onPaste);
  if (closeTimer) clearTimeout(closeTimer);
  resetState();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="upload-modal">
      <div v-if="pickerState.open" class="upload-backdrop" @click.self="close">
        <section ref="dialogEl" class="upload-dialog" role="dialog" aria-modal="true" :aria-label="config.title" tabindex="-1">
          <header class="upload-head">
            <span class="upload-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M12 15V4m0 0L8 8m4-4l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M4 14v4.2A1.8 1.8 0 0 0 5.8 20h12.4a1.8 1.8 0 0 0 1.8-1.8V14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </span>
            <div class="upload-heading">
              <h2>{{ config.title }}</h2>
              <p>{{ subtitle }}</p>
            </div>
            <button class="upload-close" type="button" title="关闭（Esc）" :disabled="uploading" @click="close">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="upload-body">
            <div
              class="dropzone"
              :class="{ 'is-dragging': dragging, 'is-compact': items.length > 0 }"
              @click="browse"
              @dragenter.prevent="dragging = true"
              @dragover.prevent="dragging = true"
              @dragleave="onDragLeave"
              @drop.prevent="onDrop"
            >
              <input
                ref="inputEl"
                class="upload-input"
                type="file"
                :accept="config.accept"
                :multiple="config.multiple"
                @change="onInputChange"
              />
              <span class="dropzone-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M12 16V7m0 0L8.5 10.5M12 7l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M5 15.5v2.7A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8v-2.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </span>
              <p class="dropzone-title">拖拽{{ typeLabel }}到这里</p>
              <p class="dropzone-hint muted">
                或
                <button class="browse-link" type="button" @click.stop="browse">浏览文件</button>
                {{ config.multiple ? ' · 支持多选与 Ctrl+V 粘贴' : '' }}
              </p>
            </div>

            <p v-if="notice" class="upload-notice">{{ notice }}</p>

            <div v-if="items.length" class="file-panel">
              <div class="file-head">
                <span>已选择 {{ items.length }} 个文件 · {{ formatSize(totalSize) }}</span>
                <button class="link-btn" type="button" :disabled="uploading" @click="clearAll">全部移除</button>
              </div>
              <ul class="file-list">
                <li v-for="item in items" :key="item.key" class="file-row">
                  <span class="file-thumb" :class="`is-${item.kind}`">
                    <img v-if="item.url" :src="item.url" :alt="item.name" />
                    <svg v-else-if="item.kind === 'video'" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <rect x="3" y="6" width="12.5" height="12" rx="2" stroke="currentColor" stroke-width="1.5" />
                      <path d="M15.5 10.5L21 7.5v9l-5.5-3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                    </svg>
                    <svg v-else-if="item.kind === 'audio'" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M9 18V6l9-2v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                      <circle cx="6.5" cy="18" r="2.5" stroke="currentColor" stroke-width="1.5" />
                      <circle cx="15.5" cy="16" r="2.5" stroke="currentColor" stroke-width="1.5" />
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 3.5h7l5 5V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                      <path d="M13 3.5V9h5.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                    </svg>
                  </span>
                  <span class="file-meta">
                    <span class="file-name" :title="item.name">{{ item.name }}</span>
                    <span class="file-sub mono">{{ formatSize(item.size) }} · {{ KIND_LABEL[item.kind] }}</span>
                  </span>
                  <button class="file-remove" type="button" title="移除" :disabled="uploading" @click="removeItem(item)">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    </svg>
                  </button>
                </li>
              </ul>
            </div>

            <label v-if="config.dest === 'library'" class="dest-row">
              <span class="dest-label">保存到资源库</span>
              <span class="dest-input">
                <span class="dest-prefix mono">/</span>
                <input
                  v-model="targetDir"
                  class="dest-field mono"
                  type="text"
                  placeholder="根目录"
                  :disabled="uploading"
                  spellcheck="false"
                />
              </span>
            </label>

            <div v-if="uploading" class="progress">
              <div class="progress-track">
                <span
                  class="progress-bar"
                  :class="{ 'is-indeterminate': config.dest !== 'library' }"
                  :style="{ width: `${progressPercent}%` }"
                />
              </div>
              <span class="progress-text mono">{{ progressText }}</span>
            </div>

            <p v-if="error" class="upload-error">{{ error }}</p>
            <p v-else-if="success" class="upload-success">
              {{ config.dest === 'library' ? '已上传' : '已导入' }} {{ items.length }} 个文件，正在关闭…
            </p>
          </div>

          <footer class="upload-foot">
            <span class="upload-summary muted">{{ summary }}</span>
            <span class="flex-spacer" />
            <button class="btn" type="button" :disabled="uploading" @click="close">取消</button>
            <button class="btn is-primary" type="button" :disabled="!items.length || uploading || success" @click="submit">
              {{ uploading ? '上传中…' : `${config.actionLabel}${items.length ? ` ${items.length} 个` : ''}` }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.upload-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
}

.upload-dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(86vh, 720px);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  outline: none;
}

.upload-dialog:focus-visible {
  border-color: var(--accent);
}

.upload-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 16px 14px 18px;
  border-bottom: 1px solid var(--border);
}

.upload-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}

.upload-heading {
  flex: 1;
  min-width: 0;
}

.upload-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.upload-heading p {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
}

.upload-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.upload-close:hover:not(:disabled) {
  background: var(--hover);
  color: var(--text);
}

.upload-close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.upload-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  overflow-y: auto;
}

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 22px 16px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel-2);
  text-align: center;
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, padding 0.14s ease;
}

.dropzone:hover {
  border-color: var(--accent);
}

.dropzone.is-compact {
  padding: 12px 16px;
  flex-direction: row;
  gap: 10px;
  text-align: left;
}

.dropzone.is-dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.dropzone-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: var(--panel-3);
  color: var(--accent);
}

.dropzone.is-compact .dropzone-icon {
  width: 30px;
  height: 30px;
  margin-bottom: 0;
}

.dropzone-title {
  margin: 0;
  font-size: 12px;
  color: var(--text);
}

.dropzone-hint {
  margin: 0;
  font-size: 10px;
}

.dropzone.is-compact .dropzone-hint {
  margin-left: auto;
}

.browse-link,
.link-btn {
  color: var(--accent);
  text-decoration: none;
}

.browse-link:hover,
.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.link-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.upload-input {
  display: none;
}

.upload-notice {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  color: var(--warn);
  font-size: 10px;
}

.file-panel {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.file-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 10px;
}

.file-list {
  max-height: 190px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
}

.file-row + .file-row {
  border-top: 1px solid var(--border);
}

.file-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-3);
  color: var(--text-muted);
}

.file-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.file-thumb.is-audio {
  color: #c58bff;
}

.file-thumb.is-video {
  color: var(--accent);
}

.file-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.file-name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-sub {
  color: var(--text-muted);
  font-size: 10px;
}

.file-remove {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.file-remove:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}

.file-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dest-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.dest-label {
  flex: none;
  color: var(--text-2);
  font-size: 11px;
}

.dest-input {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
}

.dest-input:focus-within {
  border-color: var(--accent);
}

.dest-prefix {
  color: var(--text-muted);
  font-size: 11px;
}

.dest-field {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  outline: none;
}

.dest-field::placeholder {
  color: var(--text-muted);
}

.progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.progress-track {
  position: relative;
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--panel-3);
}

.progress-bar {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.16s ease;
}

.progress-bar.is-indeterminate {
  width: 36% !important;
  animation: upload-slide 1.1s ease-in-out infinite;
}

.progress-text {
  flex: none;
  max-width: 55%;
  color: var(--text-muted);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload-error,
.upload-success {
  margin: 0;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  line-height: 1.5;
}

.upload-error {
  background: color-mix(in srgb, var(--danger) 13%, transparent);
  color: var(--danger);
}

.upload-success {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}

.upload-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.upload-summary {
  font-size: 10px;
}

.flex-spacer {
  flex: 1;
}

@keyframes upload-slide {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(320%);
  }
}

/* 弹窗进出场：只在遮罩上淡入淡出，面板轻微上浮 */
.upload-modal-enter-active,
.upload-modal-leave-active {
  transition: opacity 0.16s ease;
}

.upload-modal-enter-from,
.upload-modal-leave-to {
  opacity: 0;
}

.upload-modal-enter-active .upload-dialog {
  transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.upload-modal-enter-from .upload-dialog {
  transform: translateY(10px) scale(0.985);
}
</style>
