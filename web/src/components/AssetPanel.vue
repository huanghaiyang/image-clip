<script setup>
/**
 * 左侧素材面板（所有图片工作区共用）
 * ---------------------------------
 * 两个来源：
 *  - 当前素材：本次工作区导入 / 生成的图片，可移除；
 *  - 资源库：直接浏览资源库中的图片，点击即载入当前工作区。
 * 上传与拖拽现在统一写入资源库，保证所有模块共用同一份素材。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAppMode } from '../composables/useAppMode.js';
import { useLibrary } from '../composables/useLibrary.js';
import { useWorkspace } from '../composables/useWorkspace.js';
import { pickLibraryImages } from '../composables/useLibraryImport.js';
import { useResourceViewMode } from '../composables/useResourceViewMode.js';
import { libraryThumbUrl, uploadBlobToLibrary } from '../lib/library.js';
import { buildResourceTree, collectFolderPaths, flattenResourceTree } from '../lib/resourceTree.js';
import { formatBytes, formatRatio } from '../lib/imaging.js';
import ViewToggle from './ui/ViewToggle.vue';

const { state, selected, checkedItems, stats, actions } = useWorkspace();
const {
  state: libraryState,
  entries: libraryEntries,
  duplicatePaths,
  duplicateGroupOf,
  actions: libraryActions,
} = useLibrary();
const { state: appMode } = useAppMode();

const items = computed(() => state.items);
/** 当前素材非空时先看工作区，否则直接展示资源库，减少空面板。 */
const tab = ref(items.value.length ? 'workspace' : 'library');
const keyword = ref('');
const failedThumbs = ref(new Set());

// --------------------------------------------------------------- 当前素材拖拽排序
const draggingId = ref(null);
/** 落点提示：{ id, after }，after=true 表示插到该行下方。 */
const dropHint = ref(null);

function onWorkspaceDragStart(event, item) {
  draggingId.value = item.id;
  dropHint.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  }
}

function onWorkspaceDragOver(event, item) {
  if (!draggingId.value || draggingId.value === item.id) return;
  const rect = event.currentTarget.getBoundingClientRect();
  dropHint.value = { id: item.id, after: event.clientY > rect.top + rect.height / 2 };
}

function onWorkspaceDrop(event, item) {
  if (!draggingId.value) return;
  const after = dropHint.value?.id === item.id ? dropHint.value.after : false;
  actions.moveItem(draggingId.value, item.id, after);
  onWorkspaceDragEnd();
}

function onWorkspaceDragEnd() {
  draggingId.value = null;
  dropHint.value = null;
}

const libraryImages = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return libraryEntries.value
    .filter((entry) => entry.kind === 'image')
    .filter((entry) => !kw || entry.name.toLowerCase().includes(kw) || entry.path.toLowerCase().includes(kw))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
});

// --------------------------------------------------------------- 平铺 / 树形
const viewMode = useResourceViewMode('assets', 'flat');
const collapsed = ref(new Set());

const treeRoot = computed(() => buildResourceTree(libraryImages.value));
const treeRows = computed(() => flattenResourceTree(treeRoot.value, collapsed.value));

/** 平铺与树形共用同一套文件行渲染，树形只多一层文件夹行与缩进。 */
const libraryRows = computed(() => {
  if (viewMode.value === 'tree') return treeRows.value;
  return libraryImages.value.map((entry) => ({
    type: 'file',
    key: `file:${entry.path}`,
    path: entry.path,
    name: entry.name,
    entry,
    depth: 0,
  }));
});

function toggleFolder(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

// 资源库列表滚动分页：一次只渲染一页，避免大库卡顿
const LIST_PAGE = 120;
const rowLimit = ref(LIST_PAGE);
const listSentinel = ref(null);
let rowObserver = null;
const visibleLibraryRows = computed(() => libraryRows.value.slice(0, rowLimit.value));
const hasMoreLibraryRows = computed(() => libraryRows.value.length > visibleLibraryRows.value.length);
watch([keyword, viewMode], () => {
  rowLimit.value = LIST_PAGE;
});
function loadMoreLibraryRows() {
  if (!hasMoreLibraryRows.value) return;
  rowLimit.value = Math.min(libraryRows.value.length, rowLimit.value + LIST_PAGE);
}

/** 树中所有文件夹路径，用于「全部展开 / 全部折叠」。 */
const treeFolderPaths = computed(() => collectFolderPaths(treeRoot.value));

const allCollapsed = computed(
  () => treeFolderPaths.value.length > 0 && treeFolderPaths.value.every((path) => collapsed.value.has(path)),
);

function expandAllFolders() {
  collapsed.value = new Set();
}

function collapseAllFolders() {
  collapsed.value = new Set(treeFolderPaths.value);
}

// 搜索条件变化后重新展开，避免折叠状态把命中文件藏起来
watch(keyword, () => {
  collapsed.value = new Set();
});

// --------------------------------------------------------------- 多选与加入
const selectedPaths = ref(new Set());

const selectedEntries = computed(() => libraryImages.value.filter((entry) => selectedPaths.value.has(entry.path)));

/** 当前素材对应的资源库路径：正在编辑的那张会在资源库列表里高亮。 */
const editingPath = computed(() => selected.value?.libraryPath || '');
const loadedPaths = computed(() => new Set(state.items.map((item) => item.libraryPath).filter(Boolean)));

function toggleSelect(entry) {
  const next = new Set(selectedPaths.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.add(entry.path);
  selectedPaths.value = next;
  selectionAnchor.value = entry.path;
}

/** 上一次单击的文件，Shift 连选以它为起点；连选本身不改起点。 */
const selectionAnchor = ref('');

/** 当前可见的文件行顺序（树形只算文件行），决定 Shift 连选的范围。 */
const visibleFilePaths = computed(() => {
  if (viewMode.value === 'tree') {
    return treeRows.value.filter((row) => row.type === 'file').map((row) => row.path);
  }
  return libraryImages.value.map((entry) => entry.path);
});

/**
 * 单击只选这一张；Ctrl/Cmd/Alt 切换该张；Shift 从上次单击的文件连选，
 * Shift + Ctrl/Alt 把这一段并入已有选择。
 */
function selectEntry(event, entry) {
  const additive = event.ctrlKey || event.metaKey || event.altKey;
  if (event.shiftKey) {
    const paths = visibleFilePaths.value;
    const from = paths.indexOf(selectionAnchor.value);
    const to = paths.indexOf(entry.path);
    if (from >= 0 && to >= 0) {
      const range = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
      selectedPaths.value = additive ? new Set([...selectedPaths.value, ...range]) : new Set(range);
      return;
    }
  }
  if (additive) {
    toggleSelect(entry);
    return;
  }
  selectedPaths.value = new Set([entry.path]);
  selectionAnchor.value = entry.path;
}

function rowClass(entry) {
  return {
    'is-editing': editingPath.value === entry.path,
    'is-loaded': loadedPaths.value.has(entry.path),
    'is-selected': selectedPaths.value.has(entry.path),
    'is-duplicate': duplicatePaths.value.has(entry.path),
  };
}

function dropSelection(path) {
  if (!selectedPaths.value.has(path)) return;
  const next = new Set(selectedPaths.value);
  next.delete(path);
  selectedPaths.value = next;
}

/**
 * 行末「＋」：把这张图加入当前素材，但保持在资源库标签页，
 * 方便连续添加多张后再统一切换到工作区。
 */
async function addEntry(entry) {
  const loaded = await libraryActions.openInEditor(entry, { mode: appMode.mode });
  if (loaded) dropSelection(entry.path);
}

async function addSelected() {
  if (!selectedEntries.value.length) return;
  const loaded = await libraryActions.openInEditor(selectedEntries.value, { mode: appMode.mode });
  if (loaded) selectedPaths.value = new Set();
}

// --------------------------------------------------------------- 当前素材多选
/**
 * 多选状态放在 workspace 里（state.checkedIds），因为图集模式、批量抠图、批量裁剪
 * 都只处理这里勾选的素材；本组件只负责交互与导入素材库。
 */
const checkedIds = computed(() => new Set(state.checkedIds));
const workspaceAnchor = ref('');
const importing = ref(false);
const importNote = ref('');

/** 已经在素材库里的素材不需要重复导入，只统计还没落盘的 */
const importableItems = computed(() => checkedItems.value.filter((item) => !item.libraryPath));
/** 当前素材里所有还没录入素材库的内容（含裁剪 / 抠图等编辑结果）。 */
const pendingImportItems = computed(() => items.value.filter((item) => !item.libraryPath));
const allChecked = computed(() => items.value.length > 0 && checkedItems.value.length === items.value.length);
const someChecked = computed(() => checkedItems.value.length > 0 && !allChecked.value);

function toggleChecked(id) {
  actions.toggleCheckedItem(id);
  workspaceAnchor.value = id;
  importNote.value = '';
}

/** 勾选框：Ctrl/Cmd/Alt 追加，Shift 从上一张连选。 */
function checkWorkspaceItem(event, item) {
  if (event.shiftKey) {
    const ids = items.value.map((entry) => entry.id);
    const from = ids.indexOf(workspaceAnchor.value);
    const to = ids.indexOf(item.id);
    if (from >= 0 && to >= 0) {
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      const additive = event.ctrlKey || event.metaKey || event.altKey;
      actions.setCheckedItems(additive ? [...checkedIds.value, ...range] : range);
      importNote.value = '';
      return;
    }
  }
  toggleChecked(item.id);
}

function onWorkspaceRowClick(event, item) {
  actions.selectItem(item.id);
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    checkWorkspaceItem(event, item);
    return;
  }
  workspaceAnchor.value = item.id;
}

function toggleCheckAll() {
  if (allChecked.value) actions.clearCheckedItems();
  else actions.checkAllItems();
  importNote.value = '';
}

/** 把当前素材逐个写回素材库（根目录），已入库的自动跳过。 */
async function importItemsToLibrary(targets) {
  if (!targets.length || importing.value) return;
  importing.value = true;
  importNote.value = '';
  let done = 0;
  let failed = 0;
  try {
    for (const item of targets) {
      try {
        const blob = new Blob([item.buffer], { type: item.type || 'image/png' });
        const result = await uploadBlobToLibrary(blob, item.name, '');
        const path = result?.entry?.path ?? '';
        if (path) actions.setItemLibraryPath(item.id, path);
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn('[assets] 导入素材库失败:', item.name, err.message);
      }
    }
    if (done) await libraryActions.refresh({ quiet: true });
    importNote.value = `已导入 ${done} 张到素材库${failed ? `，失败 ${failed} 张` : ''}`;
  } finally {
    importing.value = false;
  }
}

/** 只录入勾选的素材。 */
function importCheckedToLibrary() {
  return importItemsToLibrary(importableItems.value);
}

/** 一次性把「当前素材」里所有未入库的内容（含编辑结果）录入素材库。 */
function importAllToLibrary() {
  return importItemsToLibrary(pendingImportItems.value);
}

// 资源库刷新后（删除 / 外部改动），把已经不存在于列表的选中项清掉
watch(libraryImages, (list) => {
  const alive = new Set(list.map((entry) => entry.path));
  const next = [...selectedPaths.value].filter((path) => alive.has(path));
  if (next.length !== selectedPaths.value.size) selectedPaths.value = new Set(next);
});

function savedRatio(item) {
  if (!item.bounds || item.resultEmpty) return null;
  const before = item.width * item.height;
  const after = item.bounds.width * item.bounds.height;
  if (!before) return null;
  return Math.max(0, 1 - after / before);
}

function onThumbError(path) {
  failedThumbs.value = new Set([...failedThumbs.value, path]);
}

async function loadFromLibrary(entry) {
  const loaded = await libraryActions.openInEditor(entry, { mode: appMode.mode });
  if (loaded) tab.value = 'workspace';
}

function refreshLibrary() {
  void libraryActions.refresh({ quiet: true });
}

function pickFiles() {
  pickLibraryImages({
    title: '导入到素材库',
    onUploaded: () => {
      tab.value = 'workspace';
    },
  });
}

onMounted(() => {
  // 直接从图片模块进入时资源库可能还没初始化，静默拉取一次
  if (!libraryState.initialized) refreshLibrary();
  rowObserver = new IntersectionObserver(
    (records) => {
      if (records.some((record) => record.isIntersecting)) loadMoreLibraryRows();
    },
    { rootMargin: '160px' },
  );
  if (listSentinel.value) rowObserver.observe(listSentinel.value);
});

watch(listSentinel, (el, prev) => {
  if (prev) rowObserver?.unobserve(prev);
  if (el) rowObserver?.observe(el);
});

onBeforeUnmount(() => {
  rowObserver?.disconnect();
  rowObserver = null;
});

// 资源库 tab 需要跨目录的所有图片，按需补全轻量索引
watch(
  tab,
  (value) => {
    if (value === 'library') void libraryActions.loadIndex();
  },
  { immediate: true },
);
</script>

<template>
  <aside class="assets panel">
    <div class="panel-title">
      <span>素材库</span>
      <span class="muted">{{ tab === 'workspace' ? stats.total : libraryImages.length }}</span>
    </div>

    <div class="source-tabs">
      <button
        class="source-tab"
        :class="{ 'is-active': tab === 'workspace' }"
        type="button"
        @click="tab = 'workspace'"
      >
        当前素材 <span class="count mono">{{ stats.total }}</span>
      </button>
      <button
        class="source-tab"
        :class="{ 'is-active': tab === 'library' }"
        type="button"
        @click="tab = 'library'"
      >
        资源库 <span class="count mono">{{ libraryImages.length }}</span>
      </button>
    </div>

    <div class="assets-list">
      <!-- 当前工作区素材 -->
      <template v-if="tab === 'workspace'">
        <p v-if="items.length === 0" class="assets-empty muted">
          还没有工作素材。<br />切换到「资源库」选择图片，或上传到素材库。
        </p>

        <div v-if="items.length" class="workspace-tools">
          <label class="workspace-check-all">
            <input
              type="checkbox"
              :checked="allChecked"
              :indeterminate.prop="someChecked"
              @change="toggleCheckAll"
            />
            <span>全选{{ checkedItems.length ? `（已选 ${checkedItems.length}）` : '' }}</span>
          </label>
          <div class="workspace-actions">
            <button
              class="btn is-mini is-ghost"
              type="button"
              :disabled="items.length < 2"
              title="按文件名排序（中文按拼音、数字按自然顺序）；仍可拖拽手动调整"
              @click="actions.sortItemsByName()"
            >
              按名称排序
            </button>
            <button
              class="btn is-mini"
              type="button"
              :disabled="importing || !importableItems.length"
              :title="`把勾选且未入库的 ${importableItems.length} 张写入素材库`"
              @click="importCheckedToLibrary"
            >
              {{ importing ? '导入中…' : `选中入库（${importableItems.length}）` }}
            </button>
            <button
              class="btn is-mini is-ghost"
              type="button"
              :disabled="importing || !pendingImportItems.length"
              title="把当前素材中所有未入库的内容（含裁剪、抠图等编辑结果）一次性录入素材库"
              @click="importAllToLibrary"
            >
              {{ importing ? '导入中…' : `全部入库（${pendingImportItems.length}）` }}
            </button>
          </div>
        </div>
        <p v-if="importNote" class="workspace-note">{{ importNote }}</p>

        <button
          v-for="item in items"
          :key="item.id"
          class="asset"
          :class="{
            'is-active': selected && selected.id === item.id,
            'is-empty': item.resultEmpty,
            'is-checked': checkedIds.has(item.id),
            'is-dragging': draggingId === item.id,
            'is-drop-before': dropHint?.id === item.id && !dropHint.after,
            'is-drop-after': dropHint?.id === item.id && dropHint.after,
          }"
          type="button"
          @click="onWorkspaceRowClick($event, item)"
          @dragover.prevent="onWorkspaceDragOver($event, item)"
          @drop.prevent="onWorkspaceDrop($event, item)"
        >
          <span
            class="drag-handle"
            role="button"
            draggable="true"
            title="拖拽调整顺序"
            @dragstart="onWorkspaceDragStart($event, item)"
            @dragend="onWorkspaceDragEnd"
            @click.stop
            @dblclick.stop
          >⋮⋮</span>
          <span
            class="select-mark"
            :class="{ 'is-on': checkedIds.has(item.id) }"
            role="checkbox"
            :aria-checked="checkedIds.has(item.id)"
            :title="checkedIds.has(item.id) ? '取消勾选' : '勾选后可批量保存到素材库'"
            @click.stop="checkWorkspaceItem($event, item)"
            @dblclick.stop
          >
            <svg v-if="checkedIds.has(item.id)" width="9" height="9" viewBox="0 0 10 10" fill="none">
              <path d="M2 5.2 4.1 7.3 8 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </span>
          <span class="asset-thumb">
            <img :src="item.thumbnail" :alt="item.name" />
          </span>
          <span class="asset-body">
            <span class="asset-name" :title="item.name">{{ item.name }}</span>
            <span class="asset-dims mono">
              <template v-if="item.bounds && !item.resultEmpty">
                {{ item.width }}×{{ item.height }} → {{ item.bounds.width }}×{{ item.bounds.height }}
              </template>
              <template v-else-if="item.resultEmpty">整张透明，无可裁剪内容</template>
              <template v-else>{{ item.width }}×{{ item.height }}</template>
            </span>
            <span class="asset-tags">
              <span v-if="savedRatio(item) !== null" class="tag is-accent">
                裁掉 {{ formatRatio(savedRatio(item), 0) }}
              </span>
              <span class="tag">{{ formatBytes(item.bytes) }}</span>
              <span v-if="state.options.matchColor" class="tag">颜色抠底</span>
              <span v-if="item.libraryPath" class="tag is-library">资源库</span>
            </span>
          </span>
          <span class="asset-remove" title="移除" @click.stop="actions.removeItem(item.id)">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </span>
        </button>
      </template>

      <!-- 资源库图片：平铺 / 树形，支持 Shift / Alt 多选后加入当前素材 -->
      <template v-else>
        <input v-model="keyword" class="library-search" type="search" placeholder="搜索资源库图片" />
        <div class="library-head">
          <span class="muted">{{ keyword ? `匹配 ${libraryImages.length} 张` : `共 ${libraryImages.length} 张图片` }}</span>
          <div class="library-tools">
            <ViewToggle v-model="viewMode" />
            <button class="library-refresh" type="button" :disabled="libraryState.refreshing" @click="refreshLibrary">
              刷新
            </button>
          </div>
        </div>
        <div v-if="viewMode === 'tree' && libraryImages.length" class="tree-tools">
          <button
            class="tree-tool"
            type="button"
            :disabled="!treeFolderPaths.length || collapsed.size === 0"
            @click="expandAllFolders"
          >
            全部展开
          </button>
          <button
            class="tree-tool"
            type="button"
            :disabled="!treeFolderPaths.length || allCollapsed"
            @click="collapseAllFolders"
          >
            全部折叠
          </button>
        </div>
        <p v-if="!libraryImages.length" class="assets-empty muted">
          <template v-if="keyword">没有匹配的图片。</template>
          <template v-else>资源库里还没有图片。<br />点击下方「上传到素材库」导入。</template>
        </p>

        <template v-for="row in visibleLibraryRows" :key="row.key">
          <button
            v-if="row.type === 'folder'"
            class="folder-row"
            type="button"
            :title="row.path"
            :style="{ paddingLeft: `${2 + row.depth * 12}px` }"
            @click="toggleFolder(row.path)"
          >
            <span class="chev" :class="{ 'is-open': !collapsed.has(row.path) }">›</span>
            <svg class="folder-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.8 4.1c0-.6.5-1.1 1.1-1.1h3l1.3 1.4h5.9c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.1Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
            <span class="folder-name">{{ row.name }}</span>
            <span class="folder-count mono">{{ row.count }}</span>
          </button>

          <div
            v-else
            class="asset library-asset"
            :class="rowClass(row.entry)"
            role="button"
            tabindex="0"
            :title="row.entry.path"
            :style="{ paddingLeft: `${6 + (viewMode === 'tree' ? row.depth * 12 : 0)}px` }"
            @click="selectEntry($event, row.entry)"
            @dblclick="loadFromLibrary(row.entry)"
            @keydown.enter.prevent="toggleSelect(row.entry)"
            @keydown.space.prevent="toggleSelect(row.entry)"
          >
            <span
              class="select-mark"
              :class="{ 'is-on': selectedPaths.has(row.entry.path) }"
              :title="selectedPaths.has(row.entry.path) ? '取消选中' : '选中'"
              role="checkbox"
              :aria-checked="selectedPaths.has(row.entry.path)"
              @click.stop="toggleSelect(row.entry)"
              @dblclick.stop
            >
              <svg v-if="selectedPaths.has(row.entry.path)" width="9" height="9" viewBox="0 0 10 10" fill="none">
                <path d="M2 5.2 4.1 7.3 8 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </span>
            <span class="asset-thumb">
              <img
                v-if="!failedThumbs.has(row.entry.path)"
                :src="libraryThumbUrl(row.entry, 160)"
                :alt="row.entry.name"
                @error="onThumbError(row.entry.path)"
              />
              <span v-else class="thumb-fallback">▣</span>
            </span>
            <span class="asset-body">
              <span class="asset-name">{{ row.entry.name }}</span>
              <span class="asset-dims mono">
                {{ row.entry.width ? `${row.entry.width}×${row.entry.height}` : '图片' }}
              </span>
              <span class="library-meta">
                <span class="library-dir" :title="row.entry.path">{{ row.entry.dir || '根目录' }}</span>
                <span v-if="duplicatePaths.has(row.entry.path)" class="tag is-dup">
                  重复 {{ duplicateGroupOf.get(row.entry.path) }}
                </span>
                <span v-if="editingPath === row.entry.path" class="tag is-editing">编辑中</span>
                <span v-else-if="loadedPaths.has(row.entry.path)" class="tag is-library">已加入</span>
              </span>
            </span>
            <button
              class="asset-add"
              type="button"
              title="加入当前素材"
              :disabled="libraryState.busy"
              @click.stop="addEntry(row.entry)"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2.2v7.6M2.2 6h7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </template>
        <div v-if="hasMoreLibraryRows" ref="listSentinel" class="assets-more">
          向下滚动加载更多（{{ visibleLibraryRows.length }} / {{ libraryRows.length }}）
        </div>
      </template>
    </div>

    <div class="assets-footer">
      <template v-if="tab === 'workspace'">
        <button class="btn is-block" type="button" :disabled="state.busy" @click="pickFiles">导入到素材库</button>
        <button class="btn is-block" type="button" :disabled="state.busy" @click="actions.loadSamples()">
          载入示例
        </button>
        <button
          class="btn is-block is-ghost"
          type="button"
          :disabled="state.busy || !items.length"
          @click="actions.clearItems()"
        >
          清空
        </button>
      </template>
      <template v-else>
        <button
          v-if="selectedEntries.length"
          class="btn is-primary is-block"
          type="button"
          :disabled="libraryState.busy"
          @click="addSelected"
        >
          加入选中 {{ selectedEntries.length }} 张
        </button>
        <button class="btn is-block" type="button" :disabled="libraryState.busy" @click="pickFiles">
          上传到素材库
        </button>
        <button class="btn is-block is-ghost" type="button" :disabled="libraryState.refreshing" @click="refreshLibrary">
          刷新列表
        </button>
        <p class="assets-note">删除资源请到「资源库」工作区（移入回收站后可恢复）。</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.assets {
  display: flex;
  flex-direction: column;
  width: 288px;
  flex: none;
  border-right: 1px solid var(--border);
}

/* 当前素材 / 资源库切换 */
.source-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 8px 6px;
  border-bottom: 1px solid var(--border);
}

.source-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.source-tab:hover {
  background: var(--hover);
  color: var(--text);
}

.source-tab.is-active {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.4);
  color: var(--accent);
}

.source-tab .count {
  padding: 0 4px;
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 9px;
}

.library-search {
  width: calc(100% - 8px);
  height: 24px;
  margin: 2px 4px 6px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
}

.library-search:focus {
  outline: none;
  border-color: var(--accent);
}

.library-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 6px 4px;
  font-size: 10px;
}

.library-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* 树形列表全部展开 / 全部折叠 */
.tree-tools {
  display: flex;
  gap: 4px;
  padding: 0 6px 5px;
}

.tree-tool {
  flex: 1;
  height: 20px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-muted);
  font-size: 9px;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}

.tree-tool:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.tree-tool:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 树形文件夹行 */
.folder-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 24px;
  padding: 2px 6px;
  margin-bottom: 1px;
  border-radius: var(--radius-sm);
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.folder-row:hover {
  background: var(--hover);
}

.chev {
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  transition: transform 0.12s ease;
}

.chev.is-open {
  transform: rotate(90deg);
}

.folder-icon {
  flex: none;
  color: var(--accent);
}

.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-size: 11px;
}

.folder-count {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
  font-size: 9px;
}

.library-refresh {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 10px;
  cursor: pointer;
}

.library-refresh:disabled {
  color: var(--text-muted);
  cursor: default;
}

.library-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 9px;
  opacity: 0.8;
}

.library-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.library-asset {
  cursor: pointer;
}

.library-asset:hover {
  border-color: rgba(13, 153, 255, 0.3);
}

.library-asset:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}

/* 已加入当前素材：左侧细蓝条；正在编辑：整行强调 + 徽标 */
.library-asset.is-loaded::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.45;
}

.library-asset.is-selected {
  background: var(--panel-2);
  border-color: rgba(13, 153, 255, 0.35);
}

.library-asset.is-editing {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.65);
}

.library-asset.is-editing::before {
  opacity: 1;
  width: 3px;
}

/* 行首勾选标记：独立在缩略图左侧，不覆盖素材画面 */
.select-mark {
  flex: none;
  align-self: center;
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--accent);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
}

.library-asset:hover .select-mark,
.select-mark:hover {
  opacity: 1;
  border-color: var(--accent);
}

.select-mark.is-on {
  opacity: 1;
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 行末「＋」：单张加入当前素材 */
.asset-add {
  flex: none;
  align-self: center;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel-2);
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.asset-add:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.asset-add:disabled {
  opacity: 0.5;
  cursor: default;
}

.thumb-fallback {
  color: var(--text-muted);
  font-size: 14px;
}

.tag.is-library {
  background: rgba(13, 153, 255, 0.16);
  color: var(--accent);
}

.tag.is-editing {
  flex: none;
  background: var(--accent);
  color: #fff;
}

/* 查重标记：同目录内容相同的资源，只高亮不做处理 */
.tag.is-dup {
  flex: none;
  background: rgba(240, 160, 40, 0.2);
  color: #f0a028;
}

.asset.library-asset.is-duplicate {
  border-color: rgba(240, 160, 40, 0.7);
  box-shadow: inset 0 0 0 1px rgba(240, 160, 40, 0.28);
}

.assets-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.assets-empty {
  margin: 16px 10px;
  font-size: 11px;
  line-height: 1.7;
}

.assets-more {
  padding: 8px 4px 10px;
  text-align: center;
  color: var(--text-muted);
  font-size: 10px;
}

.asset {
  position: relative;
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 6px;
  margin-bottom: 2px;
  text-align: left;
  border-radius: var(--radius);
  border: 1px solid transparent;
  transition: background 0.12s ease;
  /* Shift / Alt 多选时不要连带选中文字，避免出现蓝色选区 */
  user-select: none;
}

.asset:hover {
  background: var(--hover);
}

/* ---------- 当前素材拖拽排序 ---------- */
.drag-handle {
  flex: none;
  align-self: center;
  width: 10px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  letter-spacing: -1px;
  cursor: grab;
  opacity: 0.35;
  user-select: none;
}

.asset:hover .drag-handle {
  opacity: 0.9;
}

.drag-handle:active {
  cursor: grabbing;
}

.asset.is-dragging {
  opacity: 0.45;
}

.asset.is-drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.asset.is-drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.asset.is-active {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.45);
}

/* 当前素材多选：勾选行加一层底色，和“正在编辑”区分开 */
.asset.is-checked {
  background: var(--panel-2);
  border-color: rgba(13, 153, 255, 0.35);
}

.workspace-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 8px;
  flex-wrap: wrap;
}

.workspace-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-left: auto;
}

.workspace-check-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.workspace-check-all input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
}

.workspace-note {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.asset.is-empty .asset-dims {
  color: var(--warn);
}

.asset-thumb {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background-image: linear-gradient(45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(-45deg, var(--checker-b) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--checker-b) 75%),
    linear-gradient(-45deg, transparent 75%, var(--checker-b) 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
  background-color: var(--checker-a);
  overflow: hidden;
}

.asset-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.asset-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.asset-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.asset-dims {
  font-size: 10px;
  color: var(--text-muted);
}

.asset-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-2);
  color: var(--text-muted);
  font-size: 10px;
}

.tag.is-accent {
  background: var(--accent-soft);
  color: var(--accent);
}

.asset-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--text-muted);
}

.asset:hover .asset-remove {
  display: grid;
}

.asset-remove:hover {
  color: var(--danger);
}

.assets-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}

.assets-note {
  margin: 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.5;
  text-align: center;
}
</style>
