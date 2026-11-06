/**
 * 图片裁剪状态（单例）
 * --------------------
 * 设计目标：
 *  - 常用比例一键切换（1:1 / 4:3 / 3:2 / 16:9 / 9:16 / 4:5 …）；
 *  - 支持指定输出像素尺寸，并把尺寸保存为可复用预设（localStorage）；
 *  - 批量裁剪：把当前裁剪框按**归一化坐标**套用到「当前素材」里勾选的每一张图。
 *    视频关键帧通常尺寸一致，归一化后得到完全相同的构图，便于做序列帧。
 */
import { computed, reactive, watch } from 'vue';

import {
  clampRect,
  fitAspectRect,
  normalizeRect,
  rectFromNormalized,
  rectToAspect,
  resolveOutputSize,
} from '@shared/selection.js';
import { blobToBytes, createZip } from '../lib/zip.js';
import { downloadBlob } from '../lib/imaging.js';
import { cropToBlob, stripExtension } from '../lib/imageops.js';
import { uploadBlobToLibrary } from '../lib/library.js';
import { useWorkspace } from './useWorkspace.js';
import { refreshLibrary, saveBlobToLibrary } from './useLibrary.js';

const PRESET_KEY = 'image-clip:crop-sizes:v1';

export const CROP_RATIOS = [
  { value: 0, label: '自由' },
  { value: 1, label: '1:1' },
  { value: 4 / 3, label: '4:3' },
  { value: 3 / 2, label: '3:2' },
  { value: 16 / 9, label: '16:9' },
  { value: 9 / 16, label: '9:16' },
  { value: 4 / 5, label: '4:5' },
  { value: 2.35, label: '2.35:1' },
];

export const BUILTIN_SIZES = [
  { name: '1080p', width: 1920, height: 1080 },
  { name: '720p', width: 1280, height: 720 },
  { name: '方形 1080', width: 1080, height: 1080 },
  { name: '竖屏 1080', width: 1080, height: 1920 },
];

const workspace = useWorkspace();

function loadPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && Number(item.width) > 0 && Number(item.height) > 0)
      .map((item) => ({
        id: String(item.id || item.name || `${item.width}x${item.height}`),
        name: String(item.name || `${item.width}×${item.height}`),
        width: Math.round(Number(item.width)),
        height: Math.round(Number(item.height)),
      }));
  } catch {
    return [];
  }
}

const state = reactive({
  imageId: null,
  aspect: 0,
  rect: { x: 0, y: 0, width: 1, height: 1 },
  output: { mode: 'natural', width: 0, height: 0 },
  sizePresets: loadPresets(),
  busy: false,
  status: '',
  error: '',
  batch: { running: false, done: 0, total: 0, saveToLibrary: false },
  /**
   * 图集模式：素材像纸一样叠在一起，一个裁剪框按归一化坐标作用到每一层。
   * atlasNorm 是唯一的“真值”，state.rect 只是它在当前层上的像素投影。
   */
  atlas: { enabled: false, layer: 0 },
  atlasNorm: null,
});

// 图集 / 批量裁剪只作用于「当前素材」里勾选的项目
const atlasItems = computed(() => workspace.checkedItems.value ?? []);
const atlasCount = computed(() => atlasItems.value.length);
const atlasIndex = computed(() => Math.min(Math.max(0, state.atlas.layer), Math.max(0, atlasCount.value - 1)));

// 勾选被清空时自动退出图集，避免舞台停在空列表上
watch(atlasCount, (count) => {
  if (count || !state.atlas.enabled) return;
  state.atlas.enabled = false;
  state.atlasNorm = null;
  setError('已取消全部勾选，图集模式已退出');
});

const activeItem = computed(() => {
  if (state.atlas.enabled) return atlasItems.value[atlasIndex.value] ?? null;
  return workspace.selected.value ?? null;
});
const imageSize = computed(() => ({
  width: activeItem.value?.width ?? 0,
  height: activeItem.value?.height ?? 0,
}));
const outputSize = computed(() => resolveOutputSize(state.rect, state.output));
const normalizedRect = computed(() => {
  // 图集模式下归一化裁剪框是唯一真值，不随层切换重算
  if (state.atlas.enabled && state.atlasNorm) return state.atlasNorm;
  const { width, height } = imageSize.value;
  if (!width || !height) return { x: 0, y: 0, width: 1, height: 1 };
  return normalizeRect(state.rect, width, height);
});
const aspectLabel = computed(() => CROP_RATIOS.find((item) => Math.abs(item.value - state.aspect) < 0.001)?.label ?? state.aspect.toFixed(2));
const canApply = computed(() => Boolean(activeItem.value) && state.rect.width >= 1 && state.rect.height >= 1);

// --------------------------------------------------------------- 历史

const HISTORY_LIMIT = 30;
const RECORD_GAP = 500;
const history = reactive([]);
const redo = reactive([]);
/** 拖动裁剪框时先记下起点，松开后确认真的变了才入栈。 */
let pendingEdit = null;
let lastRecord = { key: '', group: '', at: 0 };

function currentKey() {
  return state.atlas.enabled ? '__atlas__' : state.imageId;
}

function cropSnapshot() {
  return {
    key: currentKey(),
    imageId: state.imageId,
    aspect: state.aspect,
    rect: { ...state.rect },
    output: { ...state.output },
    atlasEnabled: state.atlas.enabled,
    atlasLayer: state.atlas.layer,
    atlasNorm: state.atlasNorm ? { ...state.atlasNorm } : null,
  };
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushHistory(snapshot) {
  history.push(snapshot);
  if (history.length > HISTORY_LIMIT) history.shift();
  redo.splice(0, redo.length);
}

/**
 * 记录一次裁剪编辑。
 * 切换素材后旧图的撤销栈没有意义，直接清空，避免撤销时套用错图的框。
 */
function recordCropHistory(group = '') {
  const now = performance.now();
  if (group && lastRecord.key === currentKey() && lastRecord.group === group && now - lastRecord.at < RECORD_GAP) {
    lastRecord.at = now;
    return;
  }
  const snapshot = cropSnapshot();
  if (snapshot.key !== lastRecord.key) {
    history.splice(0, history.length);
    redo.splice(0, redo.length);
  }
  lastRecord = { key: snapshot.key, group, at: now };
  pushHistory(snapshot);
}

/** 指针按下：暂存编辑前状态；指针抬起由 endCropEdit 决定是否入栈。 */
export function beginCropEdit() {
  if (!pendingEdit) pendingEdit = cropSnapshot();
}

export function endCropEdit() {
  if (!pendingEdit) return;
  const before = pendingEdit;
  pendingEdit = null;
  if (sameSnapshot(before, cropSnapshot())) return;
  if (before.key !== currentKey()) {
    history.splice(0, history.length);
    redo.splice(0, redo.length);
  }
  lastRecord = { key: before.key, group: '', at: performance.now() };
  pushHistory(before);
}

function applyCropSnapshot(snapshot) {
  state.aspect = snapshot.aspect;
  state.output = { ...snapshot.output };
  state.rect = { ...snapshot.rect };
  state.atlas.enabled = snapshot.atlasEnabled;
  state.atlas.layer = snapshot.atlasLayer;
  state.atlasNorm = snapshot.atlasNorm ? { ...snapshot.atlasNorm } : null;
  state.imageId = snapshot.imageId;
}

export function undoCrop() {
  const snapshot = history[history.length - 1];
  if (!snapshot) return false;
  if (snapshot.key !== currentKey()) {
    history.splice(0, history.length);
    redo.splice(0, redo.length);
    return false;
  }
  history.pop();
  redo.push(cropSnapshot());
  applyCropSnapshot(snapshot);
  setStatus('已撤销裁剪操作');
  return true;
}

export function redoCrop() {
  const snapshot = redo[redo.length - 1];
  if (!snapshot) return false;
  if (snapshot.key !== currentKey()) {
    redo.splice(0, redo.length);
    return false;
  }
  redo.pop();
  history.push(cropSnapshot());
  applyCropSnapshot(snapshot);
  setStatus('已重做裁剪操作');
  return true;
}

const canUndoCrop = computed(() => history.length > 0 && history[history.length - 1].key === currentKey());
const canRedoCrop = computed(() => redo.length > 0 && redo[redo.length - 1].key === currentKey());

/** 恢复临时会话后清空：历史栈不持久化，避免撤销时套用到旧现场。 */
export function resetCropHistory() {
  history.splice(0, history.length);
  redo.splice(0, redo.length);
  pendingEdit = null;
  lastRecord = { key: '', group: '', at: 0 };
}

function persistPresets() {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(state.sizePresets));
  } catch {
    /* 隐私模式或存储已满时忽略 */
  }
}

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

/**
 * 选中素材变化时初始化裁剪框；切到相同素材则保留用户调整。
 * 图集模式下切层：只把归一化裁剪框投影到新层的像素尺寸上，取景保持不变。
 */
export function syncCrop() {
  const item = activeItem.value;
  if (!item) {
    state.imageId = null;
    return null;
  }
  if (state.atlas.enabled) {
    if (!state.atlasNorm) {
      const fitted = fitAspectRect(item.width, item.height, state.aspect);
      state.atlasNorm = normalizeRect(fitted, item.width, item.height);
    }
    if (state.imageId !== item.id) {
      state.imageId = item.id;
      state.rect = rectFromNormalized(state.atlasNorm, item.width, item.height);
    }
    return item;
  }
  if (state.imageId === item.id) return item;
  state.imageId = item.id;
  state.rect = fitAspectRect(item.width, item.height, state.aspect);
  return item;
}

/** 写入像素裁剪框；图集模式下同步更新归一化真值。 */
function commitRect(rect, width, height) {
  state.rect = rect;
  if (state.atlas.enabled && width && height) {
    state.atlasNorm = normalizeRect(rect, width, height);
  }
}

export function setAspect(ratio) {
  const value = Number(ratio) || 0;
  if (value === state.aspect) return;
  recordCropHistory();
  state.aspect = value;
  const item = syncCrop();
  if (!item) return;
  if (value > 0) {
    commitRect(rectToAspect(state.rect, value, item.width, item.height), item.width, item.height);
  }
  setStatus(value > 0 ? `裁剪比例已切换为 ${aspectLabel.value}` : '裁剪比例已切换为自由');
}

export function setRect(next) {
  const { width, height } = imageSize.value;
  if (!width || !height) return;
  const clamped = clampRect(next, width, height);
  commitRect(
    {
      x: clamped.x,
      y: clamped.y,
      width: Math.max(1, clamped.width),
      height: Math.max(1, clamped.height),
    },
    width,
    height,
  );
}

export function resetRect() {
  const item = syncCrop();
  if (!item) return;
  // 裁剪框本来就在默认位置时不产生可撤销步骤
  beginCropEdit();
  commitRect(fitAspectRect(item.width, item.height, state.aspect), item.width, item.height);
  endCropEdit();
  setStatus('裁剪框已重置');
}

// --------------------------------------------------------------- 图集模式

/** 进入图集模式：以当前裁剪框为初始取景；退出时选中当前停留的层。 */
export function toggleAtlas(force) {
  const next = typeof force === 'boolean' ? force : !state.atlas.enabled;
  if (next === state.atlas.enabled) return;
  if (next && !atlasCount.value) {
    setError('请先在左侧「当前素材」中勾选要图集处理的图片');
    return;
  }
  recordCropHistory();
  if (next) {
    const selectedIndex = atlasItems.value.findIndex((item) => item.id === workspace.state.selectedId);
    state.atlas.layer = selectedIndex >= 0 ? selectedIndex : 0;
    state.atlas.enabled = true;
    const item = activeItem.value;
    if (item) {
      // 当前裁剪框还属于这张图就直接沿用，否则按当前比例适配
      const base =
        state.imageId === item.id && state.rect.width >= 1
          ? state.rect
          : fitAspectRect(item.width, item.height, state.aspect);
      state.atlasNorm = normalizeRect(base, item.width, item.height);
      state.imageId = null;
      syncCrop();
    }
    setStatus(`图集模式：${atlasCount.value} 层（已勾选素材），一个裁剪框作用到全部`);
  } else {
    const current = activeItem.value;
    state.atlas.enabled = false;
    state.atlasNorm = null;
    state.imageId = null;
    if (current) workspace.actions.selectItem(current.id);
    setStatus('已退出图集模式');
  }
}

/** 图集模式下切换到指定层（循环）。 */
export function setAtlasLayer(index) {
  if (!state.atlas.enabled || !atlasCount.value) return;
  const count = atlasCount.value;
  state.atlas.layer = ((Math.round(Number(index) || 0) % count) + count) % count;
  state.imageId = null; // 强制把归一化裁剪框投影到新层
  syncCrop();
}

export function stepLayer(delta) {
  setAtlasLayer(state.atlas.layer + (Number(delta) || 0));
}

export function setOutputMode(mode) {
  const next = mode === 'resize' ? 'resize' : 'natural';
  if (next === state.output.mode) return;
  recordCropHistory();
  state.output.mode = next;
  if (state.output.mode === 'natural') {
    state.output.width = 0;
    state.output.height = 0;
  } else if (!state.output.width && !state.output.height) {
    const size = resolveOutputSize(state.rect, {});
    state.output.width = size.width;
    state.output.height = size.height;
  }
}

export function setOutputDimension(key, value) {
  if (key !== 'width' && key !== 'height') return;
  const parsed = Math.max(0, Math.round(Number(value) || 0));
  if (state.output.mode === 'resize' && state.output[key] === parsed) return;
  recordCropHistory(`output:${key}`);
  state.output[key] = parsed;
  state.output.mode = 'resize';
}

/** 保存当前输出尺寸为预设（不填名字时用「宽×高」）。 */
export function saveSizePreset(name) {
  const { width, height } = outputSize.value;
  if (width < 1 || height < 1) {
    setError('当前输出尺寸无效，无法保存');
    return null;
  }
  const preset = {
    id: `size-${Date.now()}`,
    name: String(name || `${width}×${height}`).trim().slice(0, 40),
    width,
    height,
  };
  state.sizePresets.push(preset);
  persistPresets();
  setStatus(`已保存尺寸预设：${preset.name}（${width}×${height}）`);
  return preset;
}

export function deleteSizePreset(id) {
  const index = state.sizePresets.findIndex((item) => item.id === id);
  if (index < 0) return;
  state.sizePresets.splice(index, 1);
  persistPresets();
  setStatus('已删除尺寸预设');
}

/** 应用一个尺寸预设：设置输出尺寸，同时把裁剪框调成该比例。 */
export function applySizePreset(preset) {
  if (!preset) return;
  const item = syncCrop();
  const width = Math.max(1, Math.round(Number(preset.width) || 0));
  const height = Math.max(1, Math.round(Number(preset.height) || 0));
  beginCropEdit();
  state.output = { mode: 'resize', width, height };
  state.aspect = width / height;
  if (item) commitRect(fitAspectRect(item.width, item.height, state.aspect), item.width, item.height);
  endCropEdit();
  setStatus(`已应用尺寸 ${width}×${height}`);
}

function uniqueName(base, used) {
  let name = base;
  let index = 2;
  while (used.has(name.toLowerCase())) {
    name = `${stripExtension(base)}-${index}${base.slice(stripExtension(base).length)}`;
    index += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * 裁剪当前素材。
 * @param {{addToWorkspace?:boolean,saveToLibrary?:boolean,download?:boolean}} [options]
 */
export async function applyCurrentCrop(options = {}) {
  const item = syncCrop();
  if (!item) {
    setError('请先选择一张素材');
    return null;
  }
  const { addToWorkspace = true, saveToLibrary = false, download = false } = options;
  state.busy = true;
  try {
    const blob = await cropToBlob(item.bitmap, state.rect, outputSize.value);
    const filename = `${stripExtension(item.name)}-裁剪.png`;
    let newItem = null;
    if (addToWorkspace) newItem = await workspace.actions.addImageBlob(blob, filename);
    if (saveToLibrary) await saveBlobToLibrary(blob, filename, '裁剪结果');
    if (download) downloadBlob(blob, filename);
    setStatus(
      `已裁剪 ${state.rect.width}×${state.rect.height} → ${outputSize.value.width}×${outputSize.value.height}` +
        `${addToWorkspace ? '（新素材）' : ''}${saveToLibrary ? '（资源库）' : ''}`,
    );
    return { blob, newItem, size: outputSize.value };
  } catch (err) {
    setError(`裁剪失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/**
 * 批量裁剪：以当前裁剪框为模板，按归一化比例套用到**勾选的素材**。
 *
 * @param {{saveToLibrary?:boolean,download?:boolean}} [options]
 */
export async function batchCrop(options = {}) {
  const template = syncCrop();
  const all = [...workspace.checkedItems.value];
  if (!template || all.length === 0) {
    setError('请先在左侧「当前素材」中勾选要批量裁剪的图片');
    return null;
  }
  if (state.batch.running) return null;
  const { saveToLibrary = false, download = true } = options;
  const normal = normalizedRect.value;
  const started = Date.now();

  state.batch.running = true;
  state.batch.done = 0;
  state.batch.total = all.length;
  state.batch.saveToLibrary = saveToLibrary;
  state.busy = true;
  setStatus(`正在批量裁剪 ${all.length} 张…`);

  const entries = [];
  const usedNames = new Set();
  let failed = 0;
  try {
    for (const item of all) {
      try {
        const rect = rectFromNormalized(normal, item.width, item.height);
        const size = resolveOutputSize(rect, state.output);
        const blob = await cropToBlob(item.bitmap, rect, size);
        const name = uniqueName(`${stripExtension(item.name)}-裁剪.png`, usedNames);
        entries.push({ name, blob, size });
      } catch (err) {
        failed += 1;
        console.warn('[crop] 批量裁剪失败:', item.name, err.message);
      }
      state.batch.done += 1;
      // 让出一帧，进度条与界面不会因为连续同步计算而卡死
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (saveToLibrary && entries.length) {
      for (const entry of entries) {
        await uploadBlobToLibrary(entry.blob, entry.name, '裁剪结果');
      }
      await refreshLibrary({ quiet: true });
    }

    if (download && entries.length) {
      const zipEntries = [];
      for (const entry of entries) zipEntries.push({ name: entry.name, data: await blobToBytes(entry.blob) });
      const zip = createZip(zipEntries);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(zip, `crop-batch-${stamp}.zip`);
    }

    setStatus(
      `批量裁剪完成：${entries.length}/${all.length} 张 · ${Date.now() - started}ms` +
        `${saveToLibrary ? ' · 已保存到资源库/裁剪结果' : ''}${download ? ' · 已下载 ZIP' : ''}${failed ? ` · 失败 ${failed}` : ''}`,
    );
    return { results: entries, failed, total: all.length };
  } catch (err) {
    setError(`批量裁剪失败：${err.message}`);
    return null;
  } finally {
    state.batch.running = false;
    state.busy = false;
  }
}

export function useCropTool() {
  return {
    state,
    activeItem,
    imageSize,
    outputSize,
    normalizedRect,
    aspectLabel,
    canApply,
    atlasItems,
    atlasCount,
    atlasIndex,
    canUndoCrop,
    canRedoCrop,
    actions: {
      syncCrop,
      beginCropEdit,
      endCropEdit,
      undoCrop,
      redoCrop,
      resetCropHistory,
      setAspect,
      setRect,
      resetRect,
      toggleAtlas,
      setAtlasLayer,
      stepLayer,
      setOutputMode,
      setOutputDimension,
      saveSizePreset,
      deleteSizePreset,
      applySizePreset,
      applyCurrentCrop,
      batchCrop,
    },
  };
}
