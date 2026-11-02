/**
 * 临时会话（单会话自动续作）
 * -------------------------
 * 目标：把“还没写入资源库、也还没提交”的操作现场自动暂存下来，
 * 刷新页面或重启应用后原地恢复，不需要用户手动保存。
 *
 * 分工：
 *  - 轻量文档（结构、路径、参数、标记点、对话）写 localStorage；
 *  - 大对象（素材原图、橡皮擦/像素画布、水印掩膜与结果）写 IndexedDB；
 *  - 各图片工具的内部 entries 不能被 watch，靠 sessionSignals 的脏信号触发；
 *  - 视频/音频/资源库/对话是普通响应式状态，直接 watch。
 *
 * 单会话策略：始终只有一个当前会话，恢复后继续覆盖同一个存储键。
 */
import { computed, nextTick, reactive, readonly, watch } from 'vue';

import { useWorkspace } from './useWorkspace.js';
import { useCropTool } from './useCropTool.js';
import { useBgRemoval } from './useBgRemoval.js';
import { useEraser } from './useEraser.js';
import { usePixelPaint } from './usePixelPaint.js';
import { useWatermark } from './useWatermark.js';
import { useLibrary } from './useLibrary.js';
import { useVideo } from './useVideo.js';
import { useAudio } from './useAudio.js';
import { useLlmChat } from './useLlmChat.js';
import { useAppMode } from './useAppMode.js';
import { onSessionDirty } from '../lib/sessionSignals.js';
import {
  clearSessionBlobs,
  clearSessionDoc,
  loadSessionDoc,
  pruneSessionBlobs,
  readSessionBlobs,
  saveSessionDoc,
  writeSessionBlobs,
} from '../lib/sessionStore.js';

const SAVE_DELAY_MS = 900;

/** 工具现场：都有私有 entries，只能按需 export/import。 */
const TOOL_SCOPES = ['eraser', 'pixel', 'watermark'];

/** 会话文档包含的全部现场。 */
const ALL_SCOPES = ['workspace', 'crop', 'bgremove', ...TOOL_SCOPES, 'library', 'video', 'audio', 'chat', 'app'];

const workspace = useWorkspace();
const crop = useCropTool();
const bg = useBgRemoval();
const eraser = useEraser();
const pixel = usePixelPaint();
const watermark = useWatermark();
const library = useLibrary();
const video = useVideo();
const audio = useAudio();
const chat = useLlmChat();
const appMode = useAppMode();

/** 工具现场的导出入口：返回 { doc, blobs }。 */
const scopeActions = {
  eraser: () => eraser.actions.exportSession(),
  pixel: () => pixel.actions.exportSession(),
  watermark: () => watermark.actions.exportSession(),
};

const state = reactive({
  initialized: false,
  restoring: false,
  saving: false,
  open: false,
  hasSession: false,
  savedAt: 0,
  error: '',
  /** 恢复后显示的提示条文案；空字符串表示没有需要提示的内容。 */
  restoreHint: '',
  hintDismissed: false,
});

// --------------------------------------------------------------- 保存缓存
/** 各现场最近一次导出结果，未变化的现场直接沿用，避免反复序列化大对象。 */
let docs = {};
/** 已经导出过、内容不会再变的素材 Blob 键（素材原图不参与编辑）。 */
const assetKeys = new Set();
/** 每个工具现场上一次导出产生的 Blob 键。 */
let scopeBlobKeys = {};

const pendingScopes = new Set();
let timer = null;
let flushPromise = null;
let initPromise = null;
let watchersRegistered = false;

// --------------------------------------------------------------- 快照工具

function cropDoc() {
  return {
    imageId: crop.state.imageId,
    aspect: crop.state.aspect,
    rect: { ...crop.state.rect },
    output: { ...crop.state.output },
    atlas: { ...crop.state.atlas },
    atlasNorm: crop.state.atlasNorm ? { ...crop.state.atlasNorm } : null,
  };
}

function libraryDoc() {
  return {
    currentDir: library.state.currentDir,
    search: library.state.search,
    kindFilter: library.state.kindFilter,
    sort: library.state.sort,
    browseMode: library.state.browseMode,
    selected: [...library.state.selected],
    previewPath: library.state.previewPath,
  };
}

function videoDoc() {
  return {
    activePath: video.state.activePath,
    currentTime: video.state.currentTime,
    playbackRate: video.state.playbackRate,
    volume: video.state.volume,
    muted: video.state.muted,
    marks: [...video.state.marks],
    options: { ...video.state.options },
    audio: { ...video.state.audio },
  };
}

function audioDoc() {
  return {
    activePath: audio.state.activePath,
    playhead: audio.state.playhead,
    selection: { ...audio.state.selection },
    loopSelection: audio.state.loopSelection,
    volume: audio.state.volume,
    outputDir: audio.state.outputDir,
    lastExport: audio.state.lastExport
      ? {
          path: audio.state.lastExport.path,
          name: audio.state.lastExport.name,
          bytes: audio.state.lastExport.bytes,
          dir: audio.state.lastExport.dir,
        }
      : null,
  };
}

function blobScopeOf(key) {
  if (key.startsWith('eraser:')) return 'eraser';
  if (key.startsWith('pixel:')) return 'pixel';
  if (key.startsWith('watermark-mask:') || key.startsWith('watermark-result:') || key === 'watermark-template') {
    return 'watermark';
  }
  return null;
}

function keepScopeKeys(scope, keys) {
  scopeBlobKeys[scope] = new Set(keys);
}

// --------------------------------------------------------------- 脏信号与防抖

function schedule(scope) {
  if (!state.initialized || state.restoring) return;
  pendingScopes.add(scope);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, SAVE_DELAY_MS);
}

function scheduleAll() {
  for (const scope of ALL_SCOPES) pendingScopes.add(scope);
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

onSessionDirty((scope) => schedule(scope));

// --------------------------------------------------------------- 落盘

async function flush() {
  if (!state.initialized || state.restoring) return;
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    const scopes = new Set(pendingScopes);
    pendingScopes.clear();
    if (!scopes.size) return;

    state.saving = true;
    const blobsToWrite = new Map();

    try {
      if (scopes.has('workspace')) {
        const { doc } = await workspace.actions.exportSession({ withBlobs: false });
        docs.workspace = doc;
        const liveKeys = new Set(doc.items.map((item) => `asset:${item.id}`));
        for (const key of [...assetKeys]) {
          if (!liveKeys.has(key)) assetKeys.delete(key);
        }
        for (const item of doc.items) {
          const key = `asset:${item.id}`;
          if (assetKeys.has(key)) continue;
          const blob = await workspace.actions.exportItemBlob(item.id);
          if (!blob) continue;
          assetKeys.add(key);
          blobsToWrite.set(key, blob);
        }
      }

      if (scopes.has('bgremove')) {
        docs.bgremove = bg.actions.exportSession();
        keepScopeKeys('bgremove', []);
      }

      for (const scope of TOOL_SCOPES) {
        if (!scopes.has(scope)) continue;
        const exported = await scopeActions[scope]();
        docs[scope] = exported?.doc ?? null;
        keepScopeKeys(scope, []);
        for (const [key, blob] of exported?.blobs ?? []) {
          scopeBlobKeys[scope].add(key);
          blobsToWrite.set(key, blob);
        }
      }

      if (scopes.has('crop')) docs.crop = cropDoc();
      if (scopes.has('library')) docs.library = libraryDoc();
      if (scopes.has('video')) docs.video = videoDoc();
      if (scopes.has('audio')) docs.audio = audioDoc();
      if (scopes.has('chat')) docs.chat = chat.actions.exportSession();

      const blobKeys = [...assetKeys, ...Object.values(scopeBlobKeys).flatMap((set) => [...set])];

      const doc = {
        version: 1,
        updatedAt: Date.now(),
        mode: appMode.state.mode,
        imageTool: appMode.state.imageTool,
        ...docs,
        blobKeys,
      };

      if (!hasContent(doc)) {
        // 现场已经清空：连同存储一起丢掉，避免恢复一个空会话
        clearSessionDoc();
        await clearSessionBlobs();
        resetCaches();
        state.hasSession = false;
        state.savedAt = 0;
        return;
      }

      // 文档先落盘：即使图片写到一半页面被关掉，恢复时也能跳过缺失的 Blob
      saveSessionDoc(doc);
      if (blobsToWrite.size) await writeSessionBlobs([...blobsToWrite]);
      await pruneSessionBlobs(blobKeys);
      state.hasSession = true;
      state.savedAt = doc.updatedAt;
      state.error = '';
    } catch (err) {
      state.error = `暂存失败：${err?.message ?? err}`;
      console.warn('[session] 暂存失败:', err);
    } finally {
      state.saving = false;
      flushPromise = null;
      // 保存过程中又有新变更：重新排一次防抖
      if (pendingScopes.size && state.initialized && !state.restoring) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, SAVE_DELAY_MS);
      }
    }
  })();

  return flushPromise;
}

function resetCaches() {
  docs = {};
  assetKeys.clear();
  scopeBlobKeys = {};
}

/** 只要能恢复出任何一个现场，就值得保留会话文档。 */
function hasContent(doc) {
  if ((doc.workspace?.items?.length ?? 0) > 0) return true;
  if (doc.video?.activePath || doc.audio?.activePath) return true;
  if ((doc.chat?.messages?.length ?? 0) > 0) return true;
  const libraryDoc = doc.library ?? {};
  if (libraryDoc.currentDir || libraryDoc.search || libraryDoc.previewPath) return true;
  if ((libraryDoc.selected?.length ?? 0) > 0) return true;
  return false;
}

// --------------------------------------------------------------- 恢复

function restoreCrop(doc) {
  if (!doc) return;
  const target = crop.state;
  target.aspect = Number(doc.aspect) || 0;
  target.output = { ...(doc.output ?? target.output) };
  target.atlas = { enabled: Boolean(doc.atlas?.enabled), layer: Number(doc.atlas?.layer) || 0 };
  target.atlasNorm = doc.atlasNorm ? { ...doc.atlasNorm } : null;

  if (target.atlas.enabled) {
    // 图集模式的真值是归一化框，交给 syncCrop 投影到当前层
    target.imageId = null;
    crop.actions.syncCrop();
    return;
  }

  const item = workspace.state.items.find((entry) => entry.id === doc.imageId);
  if (!item) return;
  // 先对齐 imageId，再写 rect：否则下一次 syncCrop 会把裁剪框重置成整图
  target.imageId = item.id;
  if (doc.rect) target.rect = { ...doc.rect };
}

function restoreVideo(doc) {
  video.actions.clearMarks();
  for (const mark of doc.marks ?? []) video.actions.addMark(mark);
  for (const [key, value] of Object.entries(doc.options ?? {})) video.actions.setOption(key, value);
  for (const [key, value] of Object.entries(doc.audio ?? {})) video.actions.setAudioOption(key, value);
  video.actions.setPlaybackRate(Number(doc.playbackRate) || 1);
  video.actions.setVolume(Number.isFinite(Number(doc.volume)) ? Number(doc.volume) : 0.9);
  if (doc.muted && Number(doc.volume) !== 0 && !video.state.muted) video.actions.toggleMute();
  video.actions.seekTo(Number(doc.currentTime) || 0);
}

function restoreLibrary(doc) {
  if (!doc) return;
  library.actions.setSort(doc.sort ?? 'name');
  library.actions.setKindFilter(doc.kindFilter ?? 'all');
  library.actions.setSearch(doc.search ?? '');
  library.actions.setBrowseMode(doc.browseMode ?? library.state.browseMode);

  const dir = doc.currentDir ?? '';
  const dirExists = dir && library.folders.value.some((folder) => folder.path === dir);
  // setDir 会清空选择与预览，必须先做
  library.actions.setDir(dirExists ? dir : '');

  const paths = (doc.selected ?? []).filter(
    (path) =>
      library.actions.entryByPath(path) || library.folders.value.some((folder) => folder.path === path),
  );
  library.actions.setSelection(paths);
  if (doc.previewPath && library.actions.entryByPath(doc.previewPath)) {
    library.actions.openPreview(doc.previewPath);
  }
}

async function restoreFromDoc(doc) {
  const blobs = await readSessionBlobs(doc.blobKeys ?? []);

  // 资源库目录/选择依赖最新的磁盘列表，先刷新
  await library.actions.refresh({ quiet: true });

  // 素材必须先恢复：所有工具 entries 都以素材 id 为键
  await workspace.actions.importSession(doc.workspace, blobs);
  bg.actions.importSession(doc.bgremove);
  await eraser.actions.importSession(doc.eraser, blobs);
  await pixel.actions.importSession(doc.pixel, blobs);
  await watermark.actions.importSession(doc.watermark, blobs);

  restoreCrop(doc.crop);
  // 恢复写入的是“当前现场”，不该变成可撤销步骤
  crop.actions.resetCropHistory();
  restoreLibrary(doc.library);

  chat.actions.restoreSession(doc.chat);

  if (doc.video?.activePath) {
    const meta = await video.actions.selectVideo(doc.video.activePath);
    if (meta) {
      restoreVideo(doc.video);
      // 标记恢复过程本身会入栈，清掉后从干净的撤销起点开始
      video.actions.resetMarkHistory();
    }
  }

  if (doc.audio?.activePath) {
    // selectAudio 会重置选区/播放头，必须在解码完成后再写回
    const buffer = await audio.actions.selectAudio(doc.audio.activePath);
    if (buffer) audio.actions.restoreSession(doc.audio);
  }

  // 模式放最后：各 Stage 挂载时直接读到已恢复的现场
  // imageTool 兼容旧会话里记录的 lastImageMode（旧版每个图片工具是独立工作区）
  if (doc.imageTool || doc.lastImageMode) {
    appMode.actions.setImageTool(doc.imageTool || doc.lastImageMode);
  }
  appMode.actions.setMode(doc.mode || 'image');
}

function describeSession(doc) {
  const parts = [];
  const items = doc.workspace?.items?.length ?? 0;
  if (items) parts.push(`${items} 个素材`);
  const dir = doc.library?.currentDir;
  if (dir) parts.push(`资源库 / ${dir}`);
  const selected = doc.library?.selected?.length ?? 0;
  if (selected) parts.push(`选中 ${selected} 项`);
  if (doc.video?.activePath) parts.push(`视频 ${doc.video.activePath.split('/').pop()}`);
  if (doc.audio?.activePath) parts.push(`音频 ${doc.audio.activePath.split('/').pop()}`);
  const messages = doc.chat?.messages?.length ?? 0;
  if (messages) parts.push(`AI 对话 ${messages} 条`);
  return parts.length ? `已恢复上次临时会话：${parts.join(' · ')}` : '';
}

// --------------------------------------------------------------- 监听注册

function registerWatchers() {
  if (watchersRegistered) return;
  watchersRegistered = true;

  // 素材元数据、工作区参数与结果（markRaw 的位图会被跳过，不会深度遍历）
  watch(
    () => [
      workspace.state.selectedId,
      workspace.state.engine,
      workspace.state.output,
      workspace.state.options,
      workspace.state.view,
      workspace.state.theme,
      workspace.state.items.length,
    ],
    () => schedule('workspace'),
    { deep: true },
  );
  watch(() => workspace.state.items, () => schedule('workspace'), { deep: true });

  watch(
    () => [
      crop.state.imageId,
      crop.state.aspect,
      crop.state.rect,
      crop.state.output,
      crop.state.atlas,
      crop.state.atlasNorm,
    ],
    () => schedule('crop'),
    { deep: true },
  );

  watch(
    () => [
      library.state.currentDir,
      library.state.search,
      library.state.kindFilter,
      library.state.sort,
      library.state.browseMode,
      library.state.selected,
      library.state.previewPath,
    ],
    () => schedule('library'),
    { deep: true },
  );

  watch(
    () => [
      video.state.activePath,
      video.state.currentTime,
      video.state.playbackRate,
      video.state.volume,
      video.state.muted,
      video.state.marks,
      video.state.options,
      video.state.audio,
    ],
    () => schedule('video'),
    { deep: true },
  );

  watch(
    () => [
      audio.state.activePath,
      audio.state.selection,
      audio.state.loopSelection,
      audio.state.volume,
      audio.state.outputDir,
      audio.state.lastExport,
    ],
    () => schedule('audio'),
    { deep: true },
  );
  // 播放中播放头每帧都在变：只在暂停/停止时记位置，避免持续推迟其他现场的落盘
  watch(
    () => (audio.state.playing ? 0 : audio.state.playhead),
    () => schedule('audio'),
  );

  watch(() => chat.state.messages, () => schedule('chat'), { deep: true });

  watch(
    () => [appMode.state.mode, appMode.state.imageTool],
    () => schedule('app'),
  );
}

// --------------------------------------------------------------- 生命周期
function onPageHide() {
  if (!state.initialized || state.restoring) return;
  scheduleAll();
  void flush();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onPageHide();
}

/**
 * 启动时恢复会话。App 挂载后调用一次；没有会话时只注册监听。
 */
export async function initSession() {
  if (state.initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const doc = loadSessionDoc();
    if (doc) {
      state.restoring = true;
      try {
        // 恢复前先把文档结构接过来：后续增量保存只更新变化的现场
        docs = {
          workspace: doc.workspace,
          crop: doc.crop,
          bgremove: doc.bgremove,
          eraser: doc.eraser,
          pixel: doc.pixel,
          watermark: doc.watermark,
          library: doc.library,
          video: doc.video,
          audio: doc.audio,
          chat: doc.chat,
        };
        for (const key of doc.blobKeys ?? []) {
          if (key.startsWith('asset:')) assetKeys.add(key);
          else {
            const scope = blobScopeOf(key);
            if (scope) keepScopeKeys(scope, [...(scopeBlobKeys[scope] ?? []), key]);
          }
        }

        await restoreFromDoc(doc);
        state.hasSession = true;
        state.savedAt = doc.updatedAt || 0;
        state.restoreHint = describeSession(doc);
      } catch (err) {
        state.error = `恢复临时会话失败：${err?.message ?? err}`;
        console.warn('[session] 恢复失败:', err);
      } finally {
        state.restoring = false;
      }
    }

    state.initialized = true;
    registerWatchers();
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/** 立即把当前全部现场写盘（弹窗里的「立即暂存」）。 */
export async function saveNow() {
  if (!state.initialized || state.restoring) return;
  scheduleAll();
  await flush();
}

/**
 * 清空并丢弃临时会话：停止自动保存 → 清存储 → 清各现场 → 恢复监听。
 */
export async function discardSession() {
  if (state.restoring) return;
  state.restoring = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingScopes.clear();

  try {
    clearSessionDoc();
    await clearSessionBlobs();
    resetCaches();

    state.hasSession = false;
    state.savedAt = 0;
    state.error = '';
    state.restoreHint = '';
    state.hintDismissed = false;

    workspace.actions.clearItems();
    bg.actions.clearSession();
    eraser.actions.clearSession();
    pixel.actions.clearSession();
    watermark.actions.clearSession();
    resetCrop();
    library.actions.setDir('');
    library.actions.setSearch('');
    library.actions.closePreview();
    video.actions.resetSession();
    audio.actions.resetSession();
    chat.actions.clearSession();

    await nextTick();
  } finally {
    state.restoring = false;
  }
}

function resetCrop() {
  const target = crop.state;
  target.imageId = null;
  target.aspect = 0;
  target.rect = { x: 0, y: 0, width: 1, height: 1 };
  target.output = { mode: 'natural', width: 0, height: 0 };
  target.atlas = { enabled: false, layer: 0 };
  target.atlasNorm = null;
}

function dismissHint() {
  state.hintDismissed = true;
}

function openDialog() {
  state.open = true;
}

function closeDialog() {
  state.open = false;
}

// --------------------------------------------------------------- 展示摘要

/** 当前现场概览：弹窗按这个列表展示“会被暂存的内容”。 */
const summary = computed(() => {
  const parts = [];
  const items = workspace.state.items.length;
  if (items) parts.push(`${items} 个素材`);
  if (library.state.currentDir) parts.push(`资源库 / ${library.state.currentDir}`);
  if (library.state.selected.length) parts.push(`选中 ${library.state.selected.length} 项`);
  if (library.state.previewPath) parts.push('资源库预览中');
  if (video.state.activePath) parts.push(`视频 ${video.state.activePath.split('/').pop()}`);
  if (audio.state.activePath) parts.push(`音频 ${audio.state.activePath.split('/').pop()}`);
  if (chat.state.messages.length) parts.push(`AI 对话 ${chat.state.messages.length} 条`);
  return { parts, items };
});

export function useWorkSession() {
  return {
    state: readonly(state),
    summary,
    actions: {
      init: initSession,
      saveNow,
      discard: discardSession,
      dismissHint,
      openDialog,
      closeDialog,
    },
  };
}
