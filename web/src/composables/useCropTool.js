/**
 * 图片裁剪状态（单例）
 * --------------------
 * 设计目标：
 *  - 常用比例一键切换（1:1 / 4:3 / 3:2 / 16:9 / 9:16 / 4:5 …）；
 *  - 支持指定输出像素尺寸，并把尺寸保存为可复用预设（localStorage）；
 *  - 批量裁剪：把当前裁剪框按**归一化坐标**套用到素材列表里的每一张图。
 *    视频关键帧通常尺寸一致，归一化后得到完全相同的构图，便于做序列帧。
 */
import { computed, reactive } from 'vue';

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
});

const activeItem = computed(() => workspace.selected.value ?? null);
const imageSize = computed(() => ({
  width: activeItem.value?.width ?? 0,
  height: activeItem.value?.height ?? 0,
}));
const outputSize = computed(() => resolveOutputSize(state.rect, state.output));
const normalizedRect = computed(() => {
  const { width, height } = imageSize.value;
  if (!width || !height) return { x: 0, y: 0, width: 1, height: 1 };
  return normalizeRect(state.rect, width, height);
});
const aspectLabel = computed(() => CROP_RATIOS.find((item) => Math.abs(item.value - state.aspect) < 0.001)?.label ?? state.aspect.toFixed(2));
const canApply = computed(() => Boolean(activeItem.value) && state.rect.width >= 1 && state.rect.height >= 1);

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

/** 选中素材变化时初始化裁剪框；切到相同素材则保留用户调整。 */
export function syncCrop() {
  const item = activeItem.value;
  if (!item) {
    state.imageId = null;
    return null;
  }
  if (state.imageId === item.id) return item;
  state.imageId = item.id;
  state.rect = fitAspectRect(item.width, item.height, state.aspect);
  return item;
}

export function setAspect(ratio) {
  const value = Number(ratio) || 0;
  state.aspect = value;
  const item = syncCrop();
  if (!item) return;
  if (value > 0) {
    state.rect = rectToAspect(state.rect, value, item.width, item.height);
  }
  setStatus(value > 0 ? `裁剪比例已切换为 ${aspectLabel.value}` : '裁剪比例已切换为自由');
}

export function setRect(next) {
  const { width, height } = imageSize.value;
  if (!width || !height) return;
  const clamped = clampRect(next, width, height);
  state.rect = {
    x: clamped.x,
    y: clamped.y,
    width: Math.max(1, clamped.width),
    height: Math.max(1, clamped.height),
  };
}

export function resetRect() {
  const item = syncCrop();
  if (!item) return;
  state.rect = fitAspectRect(item.width, item.height, state.aspect);
  setStatus('裁剪框已重置');
}

export function setOutputMode(mode) {
  state.output.mode = mode === 'resize' ? 'resize' : 'natural';
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
  state.output = { mode: 'resize', width, height };
  state.aspect = width / height;
  if (item) state.rect = fitAspectRect(item.width, item.height, state.aspect);
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
 * 批量裁剪：以当前裁剪框为模板，按归一化比例套用到所有素材。
 *
 * @param {{saveToLibrary?:boolean,download?:boolean}} [options]
 */
export async function batchCrop(options = {}) {
  const template = syncCrop();
  const all = [...workspace.state.items];
  if (!template || all.length === 0) {
    setError('素材列表为空，无法批量裁剪');
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
    actions: {
      syncCrop,
      setAspect,
      setRect,
      resetRect,
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
