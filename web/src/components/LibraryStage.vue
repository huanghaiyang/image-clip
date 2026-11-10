<script setup>
/**
 * 资源库中间舞台：面包屑 + 搜索/筛选 + 文件夹与文件网格 + 预览大图
 * ---------------------------------------------------------------
 * 交互约定：
 *  - 单击选中（Ctrl/Cmd/Alt 追加选择，Shift 连选），双击打开（文件夹进入 / 图片预览 / 视频或音频切到对应工作区）；
 *  - 预览层支持 ← → 翻页、Esc 关闭；
 *  - 改名入口：卡片 / 树形行上的 ✎ 打开全局重命名弹窗，右侧检查器也可改名；
 *  - 右键不处理，批量操作都在右侧检查器里。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useWorkspace } from '../composables/useWorkspace.js';
import { useVideo } from '../composables/useVideo.js';
import { useAudio } from '../composables/useAudio.js';
import { useRenamePrompt } from '../composables/useRenamePrompt.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useSlideshowPrefs } from '../composables/useSlideshowPrefs.js';
import { setMode } from '../composables/useAppMode.js';
import { formatDuration, formatSize, libraryFileUrl, libraryThumbUrl } from '../lib/library.js';
import { buildResourceTree, flattenResourceTree } from '../lib/resourceTree.js';
import LibrarySlideshow from './LibrarySlideshow.vue';
import TrashDialog from './TrashDialog.vue';
import ViewToggle from './ui/ViewToggle.vue';

const {
  state,
  entries,
  folders,
  currentEntries,
  currentFolders,
  breadcrumbs,
  canGoUp,
  previewEntry,
  previewIndex,
  previewList,
  duplicateGroups,
  duplicatePaths,
  duplicateGroupOf,
  actions,
} = useLibrary();
const { actions: videoActions, state: videoState } = useVideo();
const { actions: audioActions, state: audioState } = useAudio();
const { selected: workspaceSelected } = useWorkspace();
const { actions: renameActions } = useRenamePrompt();
const { confirm } = useConfirm();
const { state: slideshowPrefs } = useSlideshowPrefs();

const KIND_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

const SORTS = [
  { value: 'name', label: '名称' },
  { value: 'mtime', label: '修改时间' },
  { value: 'size', label: '大小' },
  { value: 'kind', label: '类型' },
];

const KIND_ICON = { image: '▣', video: '▶', audio: '♪', file: '▤' };

const failedThumbs = ref(new Set());
const previewError = ref(false);
const trashOpen = ref(false);

/** 正在编辑的资源：图片工作区当前素材的来源 + 视频/音频当前打开的文件。 */
const editingPaths = computed(() => {
  const paths = new Set();
  if (workspaceSelected.value?.libraryPath) paths.add(workspaceSelected.value.libraryPath);
  if (videoState.activePath) paths.add(videoState.activePath);
  if (audioState.activePath) paths.add(audioState.activePath);
  return paths;
});

const selectedSet = computed(() => new Set(state.selected));
const totalVisible = computed(() => currentFolders.value.length + currentEntries.value.length);

const previewCount = computed(() => previewList.value.length);

// --------------------------------------------------------------- 树形视图
const collapsed = ref(new Set());

/** 排序规则与平铺视图保持一致；名称排序交给 buildResourceTree 的对照器。 */
function compareEntries(a, b) {
  if (state.sort === 'mtime') return (b.mtime ?? 0) - (a.mtime ?? 0);
  if (state.sort === 'size') return (b.bytes ?? 0) - (a.bytes ?? 0);
  if (state.sort === 'kind') return a.kind.localeCompare(b.kind);
  return 0;
}

/** 树形视图下的文件：搜索跨目录，否则只取当前目录整棵子树（由 buildResourceTree 过滤）。 */
const treeEntries = computed(() => {
  const keyword = state.search.trim().toLowerCase();
  let list = entries.value;
  if (keyword) {
    list = list.filter((entry) => entry.name.toLowerCase().includes(keyword) || entry.path.toLowerCase().includes(keyword));
  }
  if (state.kindFilter !== 'all') list = list.filter((entry) => entry.kind === state.kindFilter);
  return list;
});

const treeRoot = computed(() => {
  const searching = Boolean(state.search.trim());
  return buildResourceTree(treeEntries.value, {
    root: searching ? '' : state.currentDir,
    // 搜索或类型筛选时只保留命中的文件及其祖先目录，不显示无关的空文件夹
    folders: searching || state.kindFilter !== 'all' ? [] : folders.value,
    compareFiles: compareEntries,
  });
});

const treeRows = computed(() => flattenResourceTree(treeRoot.value, collapsed.value));

/** 选中的图片，按当前列表的可见顺序排列（树形视图包含子树里的图片）。 */
const selectedImages = computed(() => {
  const selected = selectedSet.value;
  if (state.browseMode === 'tree') {
    return treeRows.value
      .filter((row) => row.type === 'file' && row.entry.kind === 'image' && selected.has(row.path))
      .map((row) => row.entry);
  }
  return currentEntries.value.filter((entry) => entry.kind === 'image' && selected.has(entry.path));
});

/** 轮播层状态：打开时把选中的图片拍成快照，播放过程中不受资源库刷新影响。 */
const slideshowOpen = ref(false);
const slideshowImages = ref([]);
const slideshowStart = ref('');

function openSlideshow() {
  const images = selectedImages.value;
  if (images.length < 2) return;
  slideshowImages.value = images;
  // 接着上次看到的那张继续；它已不在本次选中集合时退回第一张
  const last = slideshowPrefs.lastPath;
  slideshowStart.value = images.some((entry) => entry.path === last) ? last : images[0].path;
  slideshowOpen.value = true;
}

/** 当前可见行的路径顺序（文件夹 + 文件），决定 Shift 连选的范围。 */
const visibleRowPaths = computed(() => {
  if (state.browseMode === 'tree') return treeRows.value.map((row) => row.path);
  return [...currentFolders.value.map((folder) => folder.path), ...currentEntries.value.map((entry) => entry.path)];
});

/** 上一次单击的行，Shift 连选以它为起点；标准行为下连选不改起点。 */
const selectionAnchor = ref('');

/** 当前树中的所有文件夹路径，用于「全部展开 / 全部折叠」。 */
const treeFolderPaths = computed(() => {
  const paths = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.type !== 'folder') continue;
      paths.push(child.path);
      walk(child);
    }
  };
  walk(treeRoot.value);
  return paths;
});

const allCollapsed = computed(() => {
  const paths = treeFolderPaths.value;
  return paths.length > 0 && paths.every((path) => collapsed.value.has(path));
});

const hasVisible = computed(() => (state.browseMode === 'tree' ? treeRoot.value.children.length > 0 : totalVisible.value > 0));

const visibleCount = computed(() => (state.browseMode === 'tree' ? treeRoot.value.count : totalVisible.value));

function toggleFolder(path) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

/** 展开当前树中的全部文件夹。 */
function expandAllTree() {
  collapsed.value = new Set();
}

/** 折叠全部文件夹，只保留最外层目录行。 */
function collapseAllTree() {
  collapsed.value = new Set(treeFolderPaths.value);
}

function openTreeFolder(row) {
  actions.setDir(row.path);
}

/** 树形视图的「全选」包含当前子树里的文件夹与文件；已选中的不重复切换。 */
function selectAllVisible() {
  if (state.browseMode !== 'tree') {
    actions.selectAllVisible();
    return;
  }
  const selected = new Set(state.selected);
  const walk = (node) => {
    for (const child of node.children) {
      if (!selected.has(child.path)) actions.toggleSelect(child.path);
      if (child.type === 'folder') walk(child);
    }
  };
  walk(treeRoot.value);
}

// 切换目录或搜索条件后回到默认全展开，避免残留的折叠状态藏着搜索结果
watch([() => state.currentDir, () => state.search], () => {
  collapsed.value = new Set();
});

function select(event, item) {
  const path = item.path;
  if (!path) return;
  const additive = event.ctrlKey || event.metaKey || event.altKey;
  if (event.shiftKey) {
    const paths = visibleRowPaths.value;
    const from = paths.indexOf(selectionAnchor.value);
    const to = paths.indexOf(path);
    if (from >= 0 && to >= 0) {
      const range = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (additive) actions.addSelection(range);
      else actions.setSelection(range);
      return;
    }
  }
  if (additive) actions.toggleSelect(path);
  else actions.selectOnly(path);
  selectionAnchor.value = path;
}

function openEntry(entry) {
  if (entry.kind === 'image') {
    actions.openPreview(entry.path);
    return;
  }
  if (entry.kind === 'video') {
    void openVideo(entry);
    return;
  }
  if (entry.kind === 'audio') void openAudio(entry);
}

async function openVideo(entry) {
  setMode('video');
  await videoActions.selectVideo(entry);
}

async function openAudio(entry) {
  setMode('audio');
  await audioActions.selectAudio(entry);
}

function onThumbError(path) {
  failedThumbs.value = new Set([...failedThumbs.value, path]);
}

/** 卡片 / 树形行上的快捷入口：打开全局重命名弹窗。 */
function startRename(item, isFolder = false) {
  renameActions.open(item, isFolder);
}

/** 整个文件夹连同子目录一起移入回收站。 */
async function removeFolder(folder) {
  const ok = await confirm({
    title: '删除文件夹',
    message: `将文件夹「${folder.name}」及其中的全部内容移入回收站？`,
    detail: folder.path,
    confirmText: '移入回收站',
    danger: true,
  });
  if (ok) void actions.deleteFolder(folder);
}

function thumbOf(entry) {
  return failedThumbs.value.has(entry.path) ? '' : libraryThumbUrl(entry);
}

function entryMeta(entry) {
  const parts = [formatSize(entry.bytes)];
  if (entry.kind === 'image' && entry.width) parts.unshift(`${entry.width}×${entry.height}`);
  if (entry.kind === 'video') {
    if (entry.width) parts.unshift(`${entry.width}×${entry.height}`);
    if (entry.duration) parts.push(formatDuration(entry.duration));
  }
  if (entry.kind === 'audio' && entry.duration) parts.push(formatDuration(entry.duration));
  return parts.join(' · ');
}

/** 缩略图左上角的尺寸徽标：图片/视频始终能看到真实分辨率，不受文本截断影响。 */
function entrySize(entry) {
  return entry.width && entry.height ? `${entry.width}×${entry.height}` : '';
}

function onPreviewKey(event) {
  if (!state.previewPath) return;
  if (event.key === 'Escape') actions.closePreview();
  else if (event.key === 'ArrowLeft') actions.stepPreview(-1);
  else if (event.key === 'ArrowRight') actions.stepPreview(1);
}

watch(
  () => state.previewPath,
  () => {
    previewError.value = false;
  },
);

onMounted(() => window.addEventListener('keydown', onPreviewKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKey));
</script>

<template>
  <section class="stage">
    <div class="toolbar">
      <button class="icon-btn" type="button" title="上一级" :disabled="!canGoUp" @click="actions.goUp()">←</button>
      <nav class="crumbs">
        <button
          v-for="(crumb, index) in breadcrumbs"
          :key="crumb.path || '__root__'"
          class="crumb"
          type="button"
          @click="actions.setDir(crumb.path)"
        >
          {{ crumb.name }}<span v-if="index < breadcrumbs.length - 1" class="crumb-sep">/</span>
        </button>
      </nav>
      <input
        class="search"
        type="search"
        placeholder="搜索文件名 / 路径"
        :value="state.search"
        @input="actions.setSearch($event.target.value)"
      />
      <ViewToggle :model-value="state.browseMode" @update:model-value="actions.setBrowseMode($event)" />
    </div>

    <div class="subbar">
      <div class="segmented">
        <button
          v-for="item in KIND_FILTERS"
          :key="item.value"
          class="seg"
          :class="{ 'is-active': state.kindFilter === item.value }"
          type="button"
          @click="actions.setKindFilter(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
      <label class="sort">
        <span>排序</span>
        <select class="select" :value="state.sort" @change="actions.setSort($event.target.value)">
          <option v-for="item in SORTS" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <span class="count mono">{{ visibleCount }} 项</span>
      <div class="spacer" />
      <template v-if="state.browseMode === 'tree'">
        <button
          class="btn is-mini is-ghost"
          type="button"
          :disabled="!treeFolderPaths.length || collapsed.size === 0"
          @click="expandAllTree"
        >
          全部展开
        </button>
        <button
          class="btn is-mini is-ghost"
          type="button"
          :disabled="!treeFolderPaths.length || allCollapsed"
          @click="collapseAllTree"
        >
          全部折叠
        </button>
      </template>
      <button
        v-if="selectedImages.length >= 2"
        class="btn is-mini is-primary"
        type="button"
        :title="`用幻灯片播放选中的 ${selectedImages.length} 张图片`"
        @click="openSlideshow"
      >
        ▶ 轮播 ({{ selectedImages.length }})
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="!hasVisible" @click="selectAllVisible">
        全选
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="!state.selected.length" @click="actions.clearSelection()">
        清除选择
      </button>
      <button class="btn is-mini is-ghost" type="button" :disabled="state.refreshing" @click="actions.refresh()">刷新</button>
      <button
        class="btn is-mini is-ghost"
        type="button"
        title="在当前文件夹内按内容 hash 查找相同的资源（只做高亮标记，不移动/删除文件）"
        :disabled="state.duplicates.scanning"
        @click="actions.scanDuplicates()"
      >
        {{ state.duplicates.scanning ? '查重中…' : '查重' }}
      </button>
      <button
        v-if="duplicateGroups.length"
        class="btn is-mini is-ghost"
        type="button"
        title="清除重复标记"
        @click="actions.clearDuplicates()"
      >
        清除标记
      </button>
      <button class="btn is-mini is-ghost" type="button" title="查看已删除的资源" @click="trashOpen = true">
        回收站
      </button>
    </div>

    <div class="grid-wrap">
      <div v-if="state.loading && !state.initialized" class="placeholder">正在读取资源库…</div>
      <div v-else-if="!hasVisible" class="placeholder">
        <div class="placeholder-title">{{ state.search ? '没有匹配的文件' : '这个目录还是空的' }}</div>
        <div class="placeholder-hint">
          上传图片或视频，或在视频工作区截取关键帧 —— 关键帧会默认保存到「关键帧/视频名/」。
        </div>
      </div>
      <div v-else-if="state.browseMode === 'flat'" class="grid">
        <button
          v-for="folder in currentFolders"
          :key="`folder:${folder.path}`"
          class="card is-folder"
          :class="{ 'is-selected': selectedSet.has(folder.path) }"
          type="button"
          @click="select($event, folder)"
          @dblclick="actions.openFolder(folder)"
        >
          <span class="folder-thumb">
            <svg class="folder-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M3 6.4c0-.9.7-1.6 1.6-1.6h4.5l1.9 2.1h8.4c.9 0 1.6.7 1.6 1.6v8.9c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V6.4Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            </svg>
            <span
              class="folder-rename"
              role="button"
              title="重命名文件夹"
              @click.stop="startRename(folder, true)"
              @dblclick.stop
              >✎</span
            >
            <span
              class="folder-delete"
              role="button"
              title="删除文件夹（移入回收站）"
              @click.stop="removeFolder(folder)"
              @dblclick.stop
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.4 4.5l.6 8h6l.6-8"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
          </span>
          <span class="card-name is-folder-name" :title="folder.name">{{ folder.name }}</span>
          <span class="card-meta">文件夹</span>
        </button>

        <button
          v-for="entry in currentEntries"
          :key="entry.path"
          class="card"
          :class="{
            'is-selected': selectedSet.has(entry.path),
            'is-editing': editingPaths.has(entry.path),
            'is-duplicate': duplicatePaths.has(entry.path),
          }"
          type="button"
          :title="entry.path"
          @click="select($event, entry)"
          @dblclick="openEntry(entry)"
        >
          <span class="thumb">
            <img
              v-if="thumbOf(entry)"
              :src="thumbOf(entry)"
              alt=""
              loading="lazy"
              @error="onThumbError(entry.path)"
            />
            <span v-else class="thumb-icon">{{ KIND_ICON[entry.kind] ?? '▤' }}</span>
            <span v-if="entrySize(entry)" class="badge-size mono">{{ entrySize(entry) }}</span>
            <span v-if="editingPaths.has(entry.path)" class="badge-editing">编辑中</span>
            <span v-if="duplicatePaths.has(entry.path)" class="badge-dup">重复 {{ duplicateGroupOf.get(entry.path) }}</span>
            <span v-if="entry.kind === 'video'" class="badge-video">▶</span>
            <span
              class="thumb-rename"
              role="button"
              title="重命名文件"
              @click.stop="startRename(entry)"
              @dblclick.stop
              >✎</span
            >
          </span>
          <span class="card-name" :title="entry.name">{{ entry.name }}</span>
          <span class="card-meta mono">{{ entryMeta(entry) }}</span>
        </button>
      </div>

      <!-- 树形视图：箭头展开/折叠，单击选中，双击进入目录；文件双击打开 -->
      <div v-else class="tree-list">
        <template v-for="row in treeRows" :key="row.key">
          <button
            v-if="row.type === 'folder'"
            class="tree-row is-folder"
            :class="{ 'is-selected': selectedSet.has(row.path) }"
            type="button"
            :title="row.path"
            :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
            @click="select($event, row)"
            @dblclick="openTreeFolder(row)"
          >
            <span
              class="chev"
              :class="{ 'is-open': !collapsed.has(row.path) }"
              role="button"
              :title="collapsed.has(row.path) ? '展开' : '折叠'"
              @click.stop="toggleFolder(row.path)"
              >›</span
            >
            <svg class="tree-folder-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M1.8 4.1c0-.6.5-1.1 1.1-1.1h3l1.3 1.4h5.9c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.1Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
            <span class="tree-row-name">{{ row.name }}</span>
            <span
              class="row-rename"
              role="button"
              title="重命名文件夹"
              @click.stop="startRename(row, true)"
              @dblclick.stop
              >✎</span
            >
            <span
              class="folder-delete"
              role="button"
              title="删除文件夹（移入回收站）"
              @click.stop="removeFolder(row)"
              @dblclick.stop
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 4.5h10M6.2 4.5V3.2h3.6v1.3M4.4 4.5l.6 8h6l.6-8"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
            <span class="tree-row-count mono">{{ row.count }}</span>
          </button>

          <button
            v-else
            class="tree-row is-file"
            :class="{
              'is-selected': selectedSet.has(row.path),
              'is-editing': editingPaths.has(row.path),
              'is-duplicate': duplicatePaths.has(row.path),
            }"
            type="button"
            :title="row.path"
            :style="{ paddingLeft: `${8 + row.depth * 16 + 14}px` }"
            @click="select($event, row.entry)"
            @dblclick="openEntry(row.entry)"
          >
            <span class="tree-thumb">
              <img
                v-if="thumbOf(row.entry)"
                :src="thumbOf(row.entry)"
                alt=""
                loading="lazy"
                @error="onThumbError(row.entry.path)"
              />
              <span v-else class="tree-kind">{{ KIND_ICON[row.entry.kind] ?? '▤' }}</span>
            </span>
            <span class="tree-file-body">
              <span class="tree-row-name">{{ row.name }}</span>
              <span class="tree-row-meta mono">{{ entryMeta(row.entry) }}</span>
            </span>
            <span v-if="editingPaths.has(row.path)" class="edit-flag">编辑中</span>
            <span v-if="duplicatePaths.has(row.path)" class="dup-flag">重复 {{ duplicateGroupOf.get(row.path) }}</span>
            <span
              class="row-rename"
              role="button"
              title="重命名文件"
              @click.stop="startRename(row.entry)"
              @dblclick.stop
              >✎</span
            >
          </button>
        </template>
      </div>
    </div>

    <!-- 预览层 -->
    <div v-if="previewEntry" class="preview">
      <div class="preview-head">
        <span class="preview-name" :title="previewEntry.path">{{ previewEntry.name }}</span>
        <span class="preview-count mono">{{ previewIndex + 1 }} / {{ previewCount }}</span>
        <button class="icon-btn" type="button" title="关闭 (Esc)" @click="actions.closePreview()">×</button>
      </div>
      <div class="preview-body">
        <button class="nav-btn prev" type="button" title="上一张 (←)" @click="actions.stepPreview(-1)">‹</button>
        <img
          v-if="previewEntry.kind === 'image' && !previewError"
          class="preview-media"
          :src="libraryFileUrl(previewEntry)"
          alt=""
          @error="previewError = true"
        />
        <video
          v-else-if="previewEntry.kind === 'video'"
          class="preview-media"
          :src="libraryFileUrl(previewEntry)"
          controls
          autoplay
        />
        <audio v-else-if="previewEntry.kind === 'audio'" class="preview-audio" :src="libraryFileUrl(previewEntry)" controls autoplay />
        <div v-else class="preview-fallback">无法预览这个文件</div>
        <button class="nav-btn next" type="button" title="下一张 (→)" @click="actions.stepPreview(1)">›</button>
      </div>
      <div class="preview-foot">
        <span class="mono">{{ entryMeta(previewEntry) }}</span>
        <button
          v-if="previewEntry.kind === 'image'"
          class="btn is-mini"
          type="button"
          @click="actions.openInEditor(previewEntry)"
        >
          转入编辑
        </button>
        <button v-else-if="previewEntry.kind === 'video'" class="btn is-mini" type="button" @click="openVideo(previewEntry)">
          在视频工作区打开
        </button>
        <button v-else-if="previewEntry.kind === 'audio'" class="btn is-mini" type="button" @click="openAudio(previewEntry)">
          在音频工作区打开
        </button>
      </div>
    </div>
    <!-- 多选图片轮播：关闭后回到资源库，原选择保留 -->
    <LibrarySlideshow
      v-if="slideshowOpen"
      :images="slideshowImages"
      :start-path="slideshowStart"
      @close="slideshowOpen = false"
    />
    <!-- 回收站：删除的资源先放这里，可预览、恢复或彻底删除 -->
    <TrashDialog v-if="trashOpen" :open="trashOpen" @close="trashOpen = false" />
  </section>
</template>

<style scoped>
.stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

.crumb {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.crumb:hover {
  color: var(--accent);
}

.crumb-sep {
  margin: 0 3px;
  color: var(--text-muted);
}

.search {
  margin-left: auto;
  width: 200px;
  height: 24px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11px;
}

.subbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 10px;
  color: var(--text-muted);
}

.segmented {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.seg {
  padding: 3px 9px;
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

.sort {
  display: flex;
  align-items: center;
  gap: 5px;
}

.select {
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-2);
  font-size: 10px;
}

.spacer {
  flex: 1;
}

.grid-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  /* Shift / Alt 多选时不要连带选中文字，避免出现蓝色选区 */
  user-select: none;
}

.tree-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 同上：树形行多选时屏蔽原生的文字选区 */
  user-select: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.tree-row:hover {
  background: var(--hover);
}

.tree-row.is-selected {
  background: var(--accent-soft);
  border-color: rgba(13, 153, 255, 0.45);
}

.tree-row.is-folder .tree-row-name {
  color: var(--text-2);
}

.chev {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  transition: transform 0.12s ease, color 0.12s ease;
}

.chev:hover {
  color: var(--text);
  background: var(--panel-3);
}

.chev.is-open {
  transform: rotate(90deg);
}

.tree-folder-icon {
  flex: none;
  color: var(--accent);
}

.tree-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 11px;
}

.tree-row-count {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
  font-size: 9px;
}

.tree-thumb {
  display: grid;
  place-items: center;
  width: 32px;
  height: 20px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
}

.tree-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.tree-kind {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
}

.tree-file-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.tree-row-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 9px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.card:hover {
  border-color: var(--text-muted);
}

.card.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.card.is-folder {
  background: var(--panel-2);
}

/* 文件夹卡片：与文件卡片同构，顶部一块图标区，下方完整名称 */
.folder-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
}

.folder-icon {
  width: 34px;
  height: 34px;
  color: var(--accent);
  opacity: 0.9;
}

/* 平铺视图下文件夹名称完整显示：允许换行，不再省略 */
.card.is-folder .is-folder-name {
  overflow: visible;
  white-space: normal;
  text-overflow: clip;
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  border-radius: 4px;
  background: repeating-conic-gradient(var(--panel-3) 0% 25%, var(--panel-2) 0% 50%) 50% / 12px 12px;
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  /* 完整显示缩略图，不裁切上下/左右 */
  object-fit: contain;
}

.thumb-icon {
  font-size: 22px;
  color: var(--text-muted);
}

.badge-size {
  position: absolute;
  left: 4px;
  top: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
}

.badge-video {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
}

/* 正在编辑：卡片/树形行上的蓝色徽标，区别于多选高亮 */
.badge-editing {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
}

.card.is-editing {
  border-color: rgba(13, 153, 255, 0.7);
}

/* 查重标记：同文件夹内内容相同的资源，用琥珀色区分（只标记，不做处理） */
.card.is-duplicate {
  border-color: rgba(240, 160, 40, 0.8);
  box-shadow: inset 0 0 0 1px rgba(240, 160, 40, 0.35);
}

.badge-dup {
  position: absolute;
  right: 4px;
  top: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(240, 160, 40, 0.92);
  color: #2b1a00;
  font-size: 9px;
  line-height: 14px;
  font-weight: 600;
}

.tree-row.is-duplicate {
  box-shadow: inset 2px 0 #f0a028;
}

.dup-flag {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(240, 160, 40, 0.18);
  color: #f0a028;
  font-size: 10px;
  line-height: 16px;
}

.tree-row.is-editing {
  box-shadow: inset 2px 0 var(--accent);
}

.edit-flag {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  line-height: 14px;
}

.card-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 11px;
}

.card-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 9px;
}

/* 卡片 / 树形行上的重命名与删除快捷入口：常驻但低调，悬停放大可点区域 */
.folder-rename,
.row-rename,
.folder-delete {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}

.folder-rename:hover,
.row-rename:hover,
.folder-delete:hover {
  opacity: 1;
  background: var(--panel-3);
  color: var(--accent);
}

.folder-delete:hover {
  color: var(--danger);
}

/* 平铺视图：文件夹的重命名 / 删除浮在图标区右上角 */
.card.is-folder .folder-rename,
.card.is-folder .folder-delete {
  position: absolute;
  top: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  opacity: 0.6;
}

.card.is-folder .folder-rename {
  right: 26px;
}

.card.is-folder .folder-delete {
  right: 4px;
}

.card.is-folder:hover .folder-rename,
.card.is-folder:hover .folder-delete {
  opacity: 1;
}

.thumb-rename {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  opacity: 0.6;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease;
}

.card:hover .thumb-rename {
  opacity: 1;
}

.thumb-rename:hover {
  background: var(--accent);
  opacity: 1;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
  font-size: 11px;
  text-align: center;
  padding: 24px;
}

.placeholder-title {
  color: var(--text-2);
  font-size: 13px;
}

.placeholder-hint {
  max-width: 360px;
  line-height: 1.6;
}

.preview {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.86);
  z-index: 20;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: #eee;
  font-size: 11px;
}

.preview-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-count {
  color: #aaa;
}

.preview-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 48px;
}

.preview-media {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.preview-audio {
  width: min(520px, 90%);
}

.preview-fallback {
  color: #aaa;
  font-size: 12px;
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 34px;
  height: 56px;
  border: 0;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 22px;
  cursor: pointer;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.nav-btn.prev {
  left: 8px;
}

.nav-btn.next {
  right: 8px;
}

.preview-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  color: #bbb;
  font-size: 10px;
}
</style>
