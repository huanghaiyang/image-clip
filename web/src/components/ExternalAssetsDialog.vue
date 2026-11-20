<script setup>
/**
 * 关联资源 · 非素材库 / 非回收站检索
 * ------------------------------------
 * 资源库舞台只展示 data/library。这里单独检索资源库之外、由应用产生的素材：
 *  - AI 对话产物（data/artifacts），带 sessionId 与标签；
 *  - 导出文件（data/exports）。
 * 服务端已经为每条记录建好索引与缩略图 URL，本组件只负责搜索、分页展示和预览。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  externalAssetThumbUrl,
  fetchExternalAssets,
  fetchExternalAssetStatus,
  formatDuration,
  formatSize,
  rebuildExternalAssetIndex,
} from '../lib/library.js';

const props = defineProps({
  initialQuery: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const keyword = ref(props.initialQuery || '');
const kind = ref('all');
const source = ref('all');
const items = ref([]);
const total = ref(0);
const stats = ref(null);
const generatedAt = ref('');
const loading = ref(false);
const rebuilding = ref(false);
const error = ref('');
const preview = ref(null);
const failedThumbs = ref(new Set());
let searchTimer = 0;
let requestSeq = 0;

const summary = computed(() => {
  if (!stats.value) return '';
  const parts = [`索引 ${stats.value.total} 项`];
  if (stats.value.artifacts) parts.push(`AI 产物 ${stats.value.artifacts}`);
  if (stats.value.exports) parts.push(`导出 ${stats.value.exports}`);
  return parts.join(' · ');
});

const kindLabel = { image: '图片', video: '视频', audio: '音频', file: '文件' };

function metaText(entry) {
  const parts = [];
  if (entry.width && entry.height) parts.push(`${entry.width}×${entry.height}`);
  if (entry.duration) parts.push(formatDuration(entry.duration));
  if (entry.bytes) parts.push(formatSize(entry.bytes));
  return parts.join(' · ');
}

async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  error.value = '';
  try {
    const [list, status] = await Promise.all([
      fetchExternalAssets({ q: keyword.value.trim(), kind: kind.value, source: source.value, limit: 300 }),
      fetchExternalAssetStatus(),
    ]);
    if (seq !== requestSeq) return;
    items.value = list.entries || [];
    total.value = list.total || 0;
    generatedAt.value = list.generatedAt || '';
    stats.value = status.stats || list.stats || null;
  } catch (err) {
    if (seq !== requestSeq) return;
    error.value = `读取关联资源失败：${err.message}`;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function scheduleSearch() {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = 0;
    void load();
  }, 220);
}

async function rebuild() {
  if (rebuilding.value) return;
  rebuilding.value = true;
  requestSeq += 1;
  error.value = '';
  try {
    await rebuildExternalAssetIndex();
    await load();
  } catch (err) {
    error.value = `重建索引失败：${err.message}`;
  } finally {
    rebuilding.value = false;
  }
}

function thumb(entry, width = 320) {
  if (failedThumbs.value.has(entry.id)) return '';
  return externalAssetThumbUrl(entry, width);
}

function onThumbError(entry) {
  const next = new Set(failedThumbs.value);
  next.add(entry.id);
  failedThumbs.value = next;
}

function openPreview(entry) {
  preview.value = entry;
}

function closePreview() {
  preview.value = null;
}

function onKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (preview.value) closePreview();
  else emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void load();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (searchTimer) window.clearTimeout(searchTimer);
});
</script>

<template>
  <Teleport to="body">
    <div class="ea-mask" @click.self="emit('close')">
      <div class="ea-dialog" role="dialog" aria-modal="true" aria-label="关联资源检索">
        <header class="ea-head">
          <div class="ea-heading">
            <span class="ea-tag">关联资源</span>
            <h2>非素材库 / 非回收站检索</h2>
            <span class="ea-sub muted">
              AI 产物与导出文件 · 已单独建索引与缩略图
              <template v-if="summary"> · {{ summary }}</template>
            </span>
          </div>
          <button class="ea-close" type="button" title="关闭 (Esc)" @click="emit('close')">×</button>
        </header>

        <div class="ea-toolbar">
          <label class="ea-search">
            <span class="muted">搜索</span>
            <input
              v-model="keyword"
              type="search"
              placeholder="名称 / 路径 / 会话 ID / 标签"
              autocomplete="off"
              @input="scheduleSearch"
            />
          </label>
          <label class="ea-filter">
            <span class="muted">类型</span>
            <select v-model="kind" @change="load">
              <option value="all">全部</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
          </label>
          <label class="ea-filter">
            <span class="muted">来源</span>
            <select v-model="source" @change="load">
              <option value="all">全部</option>
              <option value="artifact">AI 产物</option>
              <option value="export">导出文件</option>
            </select>
          </label>
          <span class="ea-count mono">{{ total }} 项</span>
          <div class="ea-spacer" />
          <button class="btn is-mini is-ghost" type="button" :disabled="loading || rebuilding" @click="rebuild">
            {{ rebuilding ? '重建中…' : '重建索引' }}
          </button>
          <button class="btn is-mini" type="button" @click="emit('close')">关闭</button>
        </div>

        <div class="ea-body">
          <p v-if="error" class="ea-error">{{ error }}</p>
          <div v-else-if="loading" class="ea-loading"><span class="ea-spinner"></span>正在读取索引…</div>
          <template v-else-if="items.length">
            <div class="ea-grid">
              <button
                v-for="entry in items"
                :key="entry.id"
                class="ea-card"
                type="button"
                :title="`${entry.path}\n${entry.sourceLabel}${entry.sessionId ? ` · ${entry.sessionId}` : ''}`"
                @click="openPreview(entry)"
              >
                <span class="ea-thumb" :class="{ 'is-audio': entry.kind === 'audio' }">
                  <img
                    v-if="thumb(entry, 320)"
                    :src="thumb(entry, 320)"
                    :alt="entry.name"
                    loading="lazy"
                    decoding="async"
                    @error="onThumbError(entry)"
                  />
                  <span v-else class="ea-thumb-icon">{{ entry.kind === 'video' ? '▶' : entry.kind === 'audio' ? '♪' : '▣' }}</span>
                  <span class="ea-source">{{ entry.sourceLabel }}</span>
                </span>
                <span class="ea-name" :title="entry.name">{{ entry.name }}</span>
                <span class="ea-meta mono">{{ metaText(entry) || kindLabel[entry.kind] || entry.kind }}</span>
                <span class="ea-path muted" :title="entry.path">{{ entry.path }}</span>
              </button>
            </div>
          </template>
          <p v-else class="ea-empty muted">
            {{ keyword || kind !== 'all' || source !== 'all' ? '没有匹配的关联资源。' : '还没有 AI 产物或导出文件。' }}
          </p>
        </div>

        <footer class="ea-foot">
          <span class="muted">
            只包含 data/artifacts 与 data/exports；资源库和回收站不在此索引内
            <template v-if="generatedAt"> · 索引时间 {{ new Date(generatedAt).toLocaleString() }}</template>
          </span>
        </footer>

        <div v-if="preview" class="ea-preview" @click.self="closePreview">
          <div class="ea-preview-box">
            <header class="ea-preview-head">
              <span class="ea-preview-name" :title="preview.name">{{ preview.name }}</span>
              <span class="ea-preview-meta muted mono">{{ metaText(preview) }}</span>
              <button class="ea-close" type="button" title="关闭预览 (Esc)" @click="closePreview">×</button>
            </header>
            <div class="ea-preview-body">
              <img v-if="preview.kind === 'image'" :src="preview.url" :alt="preview.name" />
              <video v-else-if="preview.kind === 'video'" :src="preview.url" controls autoplay />
              <audio v-else-if="preview.kind === 'audio'" :src="preview.url" controls autoplay />
              <p v-else class="muted">该文件类型不支持预览。</p>
            </div>
            <footer class="ea-preview-foot muted">
              <span>{{ preview.sourceLabel }} · {{ preview.path }}</span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ea-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.ea-dialog {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1120px, 100%);
  height: min(860px, 92vh);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
}

.ea-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.ea-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.ea-tag {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--accent-soft, rgba(99, 102, 241, 0.14));
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
}

.ea-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.ea-sub {
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ea-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.ea-close:hover {
  background: var(--panel-2);
  color: var(--text);
}

.ea-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.ea-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 200px;
  max-width: 460px;
}

.ea-search input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.ea-search input:focus {
  border-color: var(--accent);
}

.ea-filter {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ea-filter select {
  height: 28px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 11.5px;
}

.ea-count {
  color: var(--text-muted);
  font-size: 11px;
}

.ea-spacer {
  flex: 1;
}

.ea-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.ea-loading,
.ea-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 180px;
  font-size: 12px;
}

.ea-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ea-spin 0.8s linear infinite;
}

@keyframes ea-spin {
  to {
    transform: rotate(360deg);
  }
}

.ea-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 10px;
}

.ea-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.ea-card:hover {
  border-color: var(--accent);
  background: var(--panel-2);
}

.ea-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  background: var(--bg);
  overflow: hidden;
}

.ea-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.ea-thumb-icon {
  color: var(--text-muted);
  font-size: 26px;
}

.ea-source {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  font-size: 9.5px;
}

.ea-name {
  padding: 0 8px;
  font-size: 11.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ea-meta,
.ea-path {
  padding: 0 8px;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ea-path {
  padding-bottom: 7px;
}

.ea-error {
  margin: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.12);
  color: #f87171;
  font-size: 11.5px;
}

.ea-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
}

.ea-preview {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.72);
}

.ea-preview-box {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  height: min(720px, 100%);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
}

.ea-preview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.ea-preview-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}

.ea-preview-meta {
  font-size: 10.5px;
}

.ea-preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: var(--bg);
}

.ea-preview-body img,
.ea-preview-body video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.ea-preview-body audio {
  width: min(560px, 100%);
}

.ea-preview-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
