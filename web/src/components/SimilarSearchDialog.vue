<script setup>
/**
 * 智能识图 · 相似资源检索
 * ----------------------
 * 以一张图（资源库里的 / 拖入 / 粘贴）为查询，按 dHash 指纹找出资源库里最像的图片：
 *  - 结果按汉明距离升序，相似度 = 1 - distance/64，直接标在卡片上；
 *  - 单击结果 → 在资源库里定位并选中；双击 → 打开预览；
 *  - 不会改动任何文件，也不联网（指纹在本地服务端计算）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useSimilarSearch } from '../composables/useSimilarSearch.js';
import { libraryThumbUrl } from '../lib/library.js';
import { formatSimilarity, similarityLabel, similarityLevel } from '../lib/similar.js';

const { state, actions } = useSimilarSearch();
const fileInput = ref(null);
const dragging = ref(false);

/** Esc 关闭；打开时给个轻微提示（焦点在弹窗上，保证粘贴事件能收到）。 */
function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    actions.close();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
watch(
  () => state.open,
  (open) => {
    if (open) dragging.value = false;
  },
);

const queryThumb = computed(() => {
  const query = state.query;
  if (!query) return '';
  if (query.kind === 'file') return query.url;
  return libraryThumbUrl(query.entry, 480);
});
const queryName = computed(() => {
  const query = state.query;
  if (!query) return '';
  return query.kind === 'file' ? query.name : query.entry?.name ?? '';
});
const queryMeta = computed(() => {
  const query = state.query;
  if (!query) return '';
  return query.kind === 'file' ? '本地图片（未入库）' : query.entry?.dir || '资源库根目录';
});

function pickFile() {
  fileInput.value?.click();
}

async function onFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) await actions.searchByFile(file, file.name);
}

async function onDrop(event) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) await actions.searchByFile(file, file.name);
}

async function onPaste(event) {
  const items = [...(event.clipboardData?.items ?? [])];
  const item = items.find((entry) => entry.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) await actions.searchByFile(file, file.name || 'clipboard.png');
}

function levelClass(score) {
  return `is-${similarityLevel(score)}`;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="ss-mask" @click.self="actions.close()">
      <div
        class="ss-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="智能识图 · 相似资源检索"
        @paste.prevent="onPaste"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <header class="ss-head">
          <div class="ss-heading">
            <span class="ss-tag">智能识图</span>
            <h2>相似资源检索</h2>
            <span class="ss-sub muted">{{ state.summary || '按图片内容指纹（dHash）在资源库里找相似图片' }}</span>
            <span v-if="state.meta?.indexing || state.meta?.queued" class="ss-indexing muted">
              正在后台补建指纹{{ state.meta.queued ? `（队列 ${state.meta.queued}）` : '' }}，结果可能暂不完整
            </span>
          </div>
          <button class="ss-close" type="button" title="关闭 (Esc)" @click="actions.close()">×</button>
        </header>

        <div class="ss-query">
          <div class="ss-query-thumb" :class="{ 'is-empty': !queryThumb }">
            <img v-if="queryThumb" :src="queryThumb" :alt="queryName" />
            <span v-else class="muted">未选择查询图</span>
          </div>
          <div class="ss-query-body">
            <template v-if="state.query">
              <div class="ss-query-name" :title="queryName">{{ queryName }}</div>
              <div class="ss-query-meta muted mono">{{ queryMeta }}</div>
              <div class="ss-query-hash muted mono">指纹 {{ state.query.hash ?? '' }}</div>
            </template>
            <template v-else>
              <div class="ss-query-name">拖一张图片到窗口，或粘贴 / 选择文件</div>
              <div class="ss-query-meta muted">用任意图片做“以图搜图”，不会上传到网络。</div>
            </template>
            <div class="ss-query-actions">
              <button class="btn is-mini" type="button" :disabled="state.loading" @click="pickFile">选择图片…</button>
              <button
                class="btn is-mini is-ghost"
                type="button"
                :disabled="state.loading || !state.query"
                @click="state.query?.kind === 'path' ? actions.searchByEntry(state.query.entry) : null"
              >
                重试
              </button>
              <span v-if="dragging" class="ss-drop-hint">松手即用这张图检索</span>
            </div>
          </div>
          <input ref="fileInput" class="ss-file" type="file" accept="image/*" @change="onFileChange" />
        </div>

        <div class="ss-body">
          <p v-if="state.error" class="ss-error">{{ state.error }}</p>
          <div v-else-if="state.loading" class="ss-loading">
            <span class="ss-spinner"></span>
            正在计算指纹并比对（首次检索会为资源库建索引，稍等片刻）…
          </div>
          <template v-else-if="state.results.length">
            <div class="ss-grid">
              <button
                v-for="result in state.results"
                :key="result.path"
                class="ss-card"
                type="button"
                :title="`${result.path}\n综合 ${formatSimilarity(result.score)} · 结构 ${formatSimilarity(result.structure)} · 颜色 ${formatSimilarity(result.color)}`"
                @click="actions.revealResult(result)"
                @dblclick="actions.openResult(result)"
              >
                <span class="ss-thumb">
                  <img :src="libraryThumbUrl(result, 480)" :alt="result.name" loading="eager" decoding="async" />
                  <span class="ss-score mono" :class="levelClass(result.score)">{{ formatSimilarity(result.score) }}</span>
                </span>
                <span class="ss-name" :title="result.name">{{ result.name }}</span>
                <span class="ss-meta mono">
                  {{ similarityLabel(result.score) }} · 结构 {{ formatSimilarity(result.structure) }} · 颜色 {{ formatSimilarity(result.color) }}
                </span>
                <span class="ss-dir muted" :title="result.path">{{ result.dir || '根目录' }}</span>
              </button>
            </div>
          </template>
          <p v-else class="ss-empty muted">
            {{ state.query ? '没有找到足够相似的图片（资源库里的图指纹已全部比对）。' : '先选择一张查询图。' }}
          </p>
        </div>

        <footer class="ss-foot">
          <span class="muted">单击结果在资源库定位并选中 · 双击打开预览 · 指纹只在本机计算</span>
          <button class="btn is-mini" type="button" @click="actions.close()">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ss-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.ss-dialog {
  display: flex;
  flex-direction: column;
  width: min(1080px, 100%);
  height: min(880px, 92vh);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
}

.ss-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.ss-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ss-heading h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.ss-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.ss-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}

.ss-indexing {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  border: 1px solid var(--border);
  font-size: 9px;
  white-space: nowrap;
}

.ss-close {
  flex: none;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.ss-close:hover {
  background: var(--hover);
  color: var(--text);
}

.ss-query {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.ss-query-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 132px;
  height: 99px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  overflow: hidden;
  font-size: 10px;
}

.ss-query-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.ss-query-body {
  flex: 1;
  min-width: 0;
}

.ss-query-name {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-query-meta,
.ss-query-hash {
  margin-top: 2px;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-query-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.ss-drop-hint {
  font-size: 10px;
  color: var(--accent);
}

.ss-file {
  display: none;
}

.ss-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}

.ss-loading,
.ss-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 24px 0;
  font-size: 11px;
}

.ss-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ss-spin 0.8s linear infinite;
}

@keyframes ss-spin {
  to {
    transform: rotate(360deg);
  }
}

.ss-error {
  margin: 24px 0;
  font-size: 11px;
  color: var(--danger);
}

.ss-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 12px;
}

.ss-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.ss-card:hover {
  border-color: var(--accent);
}

.ss-thumb {
  position: relative;
  display: grid;
  place-items: center;
  /* 用 4:3 的比例盒子 + contain：不管原图是 16:9、竖图还是方图，整张图都完整可见，
     不会再出现“只能看到一部分”或上下被切的情况。 */
  aspect-ratio: 4 / 3;
  border-radius: var(--radius-sm);
  /* 纯色底而不是棋盘格：半透明 PNG（抠图素材）不会透出格子，看起来是一整张图 */
  background: #17181b;
  overflow: hidden;
}

.ss-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.ss-score {
  position: absolute;
  left: 4px;
  top: 4px;
  z-index: 2;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 9px;
  line-height: 14px;
  color: #fff;
  background: rgba(0, 0, 0, 0.62);
}

.ss-score.is-same {
  background: #14ae5c;
}

.ss-score.is-high {
  background: #0d99ff;
}

.ss-score.is-similar {
  background: rgba(13, 153, 255, 0.72);
}

.ss-name {
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-meta {
  font-size: 9px;
  color: var(--text-muted);
}

.ss-dir {
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 10px;
}
</style>
