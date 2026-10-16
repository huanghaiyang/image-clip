/**
 * 工作区状态与全部业务动作。
 *
 * 说明：这是一个单窗口应用，因此状态以模块级单例维护（useWorkspace() 返回同一份），
 * 避免在 4 个面板之间层层透传 props。重负载对象（ImageBitmap / ImageData / ArrayBuffer）
 * 一律 markRaw，避免 Vue 深度代理带来的额外开销。
 */
import { computed, markRaw, reactive, readonly } from 'vue';
import { ALGORITHM, DEFAULT_OPTIONS } from '@shared/aabb.js';

import {
  ImageDecodeError,
  croppedFilename,
  decodeToRgba,
  downloadBlob,
  formatBytes,
  makeThumbnail,
} from '../lib/imaging.js';
import { analyzeWith, cropWith } from '../lib/engine.js';
import { blobToBytes, createZip } from '../lib/zip.js';

let uid = 0;

const state = reactive({
  items: [],
  selectedId: null,
  engine: 'client',
  output: { format: 'png', quality: 92 },
  options: {
    alphaThreshold: DEFAULT_OPTIONS.alphaThreshold,
    padding: DEFAULT_OPTIONS.padding,
    matchColor: DEFAULT_OPTIONS.matchColor,
    backgroundColor: DEFAULT_OPTIONS.backgroundColor,
    colorTolerance: DEFAULT_OPTIONS.colorTolerance,
  },
  view: { mode: 'source', showBox: true, zoom: 'fit' },
  theme: 'dark',
  busy: false,
  status: '',
  error: '',
  server: { checked: false, ok: false, sharp: null, algorithm: null },
});

const selected = computed(() => state.items.find((item) => item.id === state.selectedId) ?? null);
const stats = computed(() => {
  const total = state.items.length;
  const ready = state.items.filter((item) => item.bounds && !item.empty).length;
  const empty = state.items.filter((item) => item.resultEmpty).length;
  const sourceBytes = state.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  return { total, ready, empty, sourceBytes };
});

// --------------------------------------------------------------- 内部工具

let recomputeTimer = null;

function optionsSnapshot() {
  return {
    alphaThreshold: state.options.alphaThreshold,
    padding: state.options.padding,
    matchColor: state.options.matchColor,
    backgroundColor: state.options.backgroundColor,
    colorTolerance: state.options.colorTolerance,
  };
}

function scheduleRecompute({ immediate = false } = {}) {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  if (immediate) {
    void recomputeAll();
    return;
  }
  // 拖动滑块时合并计算，避免每一帧都跑全图扫描
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    void recomputeAll();
  }, 90);
}

/** 检测单张图片；服务端失败时自动回退到浏览器引擎并提示。 */
export async function recomputeItem(item) {
  if (!item.imageData) return;
  const options = optionsSnapshot();
  try {
    const result = await analyzeWith(state.engine, item, options);
    item.bounds = result.bounds;
    item.trimmed = result.trimmed;
    item.resultEmpty = result.empty;
    item.contentPixels = result.contentPixels;
    item.contentRatio = result.contentRatio;
    item.engine = result.engine;
    item.elapsedMs = result.elapsedMs;
    item.detectedAt = Date.now();
    item.error = '';
    if (state.engine === 'server') {
      item.serverSource = result.source ?? null;
      item.isPalette = Boolean(result.source?.isPalette);
    }
  } catch (err) {
    item.error = err.message;
    if (state.engine === 'server') {
      const fallback = await analyzeWith('client', item, options);
      item.bounds = fallback.bounds;
      item.trimmed = fallback.trimmed;
      item.resultEmpty = fallback.empty;
      item.contentPixels = fallback.contentPixels;
      item.contentRatio = fallback.contentRatio;
      item.engine = `${fallback.engine} (服务端不可用，已回退)`;
      item.elapsedMs = fallback.elapsedMs;
    }
  }
}

export async function recomputeAll() {
  if (state.items.length === 0) return;
  await Promise.all(state.items.map((item) => recomputeItem(item)));
}

// --------------------------------------------------------------- 动作

export async function addFiles(fileList) {
  const files = [...(fileList ?? [])].filter((file) => file && /^image\//.test(file.type || '') );
  const fallbackFiles = [...(fileList ?? [])].filter((file) => file && !/^image\//.test(file.type || ''));
  const all = [...files, ...fallbackFiles];
  if (all.length === 0) return;

  state.busy = true;
  state.error = '';
  for (const file of all) {
    try {
      const buffer = await file.arrayBuffer();
      const { bitmap, imageData, width, height } = await decodeToRgba(file);
      const item = reactive({
        id: `img-${++uid}`,
        name: file.name || `image-${uid}`,
        type: file.type || 'application/octet-stream',
        bytes: buffer.byteLength,
        width,
        height,
        thumbnail: markRaw(makeThumbnail(bitmap, 160)),
        bitmap: markRaw(bitmap),
        imageData: markRaw(imageData),
        buffer: markRaw(buffer),
        bounds: null,
        trimmed: null,
        resultEmpty: false,
        contentPixels: 0,
        contentRatio: 0,
        engine: '',
        elapsedMs: 0,
        error: '',
        detectedAt: 0,
      });
      state.items.push(item);
      state.selectedId = item.id;
      await recomputeItem(item);
      setStatus(`已导入 ${item.name}（${width}×${height}）`);
    } catch (err) {
      const message = err instanceof ImageDecodeError ? err.message : `无法读取「${file.name}」：${err.message}`;
      setError(message);
    }
  }
  state.busy = false;
}

/** 从 Node 服务端拉取 samples/ 里的示例图片。 */
export async function loadSamples() {
  state.busy = true;
  state.error = '';
  try {
    const res = await fetch('/api/samples');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { samples } = await res.json();
    if (!samples?.length) throw new Error('服务端 samples/ 目录为空');

    for (const sample of samples) {
      if (state.items.some((item) => item.name === sample.name)) continue;
      const imageRes = await fetch(sample.url);
      if (!imageRes.ok) throw new Error(`示例图下载失败：${sample.name}`);
      const blob = await imageRes.blob();
      const file = new File([blob], sample.name, { type: blob.type || 'image/webp' });
      await addFiles([file]);
    }
    setStatus(`已载入 ${samples.length} 张示例图片`);
  } catch (err) {
    setError(`载入示例失败：${err.message}（请确认 Node 服务已启动: npm run dev:server）`);
  } finally {
    state.busy = false;
  }
}

export function removeItem(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = state.items.splice(index, 1);
  if (state.selectedId === id) {
    state.selectedId = state.items[Math.min(index, state.items.length - 1)]?.id ?? null;
  }
  setStatus(`已移除 ${removed.name}`);
}

export function clearItems() {
  state.items.splice(0, state.items.length);
  state.selectedId = null;
  setStatus('已清空素材');
}

export function selectItem(id) {
  state.selectedId = id;
}

export function resetOptions() {
  Object.assign(state.options, {
    alphaThreshold: DEFAULT_OPTIONS.alphaThreshold,
    padding: DEFAULT_OPTIONS.padding,
    matchColor: DEFAULT_OPTIONS.matchColor,
    backgroundColor: DEFAULT_OPTIONS.backgroundColor,
    colorTolerance: DEFAULT_OPTIONS.colorTolerance,
  });
  scheduleRecompute({ immediate: true });
  setStatus('检测参数已重置为默认值');
}

export async function setEngine(engine) {
  state.engine = engine;
  await recomputeAll();
  setStatus(engine === 'server' ? '已切换到 Node 引擎（服务端 sharp 计算）' : '已切换到浏览器引擎（本地即时计算）');
}

export function setOption(key, value) {
  state.options[key] = value;
  scheduleRecompute();
}

export function setOutput(key, value) {
  state.output[key] = value;
}

export function setView(key, value) {
  state.view[key] = value;
}

export function setStatus(message) {
  state.status = message;
  state.error = '';
}

export function setError(message) {
  state.error = message;
  state.status = '';
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
}

// --------------------------------------------------------------- 导出

export async function exportItem(item) {
  if (!item?.bounds || item.resultEmpty) {
    setError('这张图片没有可裁剪的内容');
    return;
  }
  state.busy = true;
  try {
    const filename = croppedFilename(item.name, state.output.format);
    const { blob } = await cropWith(state.engine, item, optionsSnapshot(), {
      format: state.output.format,
      quality: state.output.quality,
      filename,
    });
    downloadBlob(blob, filename);
    setStatus(`已导出 ${filename}（${formatBytes(blob.size)}）`);
  } catch (err) {
    setError(`导出失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

export async function exportAll() {
  const targets = state.items.filter((item) => item.bounds && !item.resultEmpty);
  if (targets.length === 0) {
    setError('没有可导出的图片');
    return;
  }
  state.busy = true;
  try {
    const entries = [];
    for (const item of targets) {
      const filename = croppedFilename(item.name, state.output.format);
      const { blob } = await cropWith(state.engine, item, optionsSnapshot(), {
        format: state.output.format,
        quality: state.output.quality,
        filename,
      });
      entries.push({ name: filename, data: await blobToBytes(blob) });
    }
    const zip = createZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(zip, `image-clip-${stamp}.zip`);
    setStatus(`已打包导出 ${entries.length} 张（${formatBytes(zip.size)}）`);
  } catch (err) {
    setError(`批量导出失败：${err.message}`);
  } finally {
    state.busy = false;
  }
}

export async function copyBounds(item) {
  if (!item?.bounds || item.resultEmpty) return;
  const text = JSON.stringify({ ...item.bounds, source: { width: item.width, height: item.height } });
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`已复制裁剪框坐标 ${text}`);
  } catch {
    setError('浏览器拒绝了剪贴板写入');
  }
}

/** 挂载时检查 Node 服务端能力（状态栏展示）。 */
export async function checkServer() {
  try {
    const res = await fetch('/api/health');
    const body = await res.json();
    state.server = {
      checked: true,
      ok: Boolean(body.ok),
      sharp: body.sharp ?? null,
      algorithm: body.algorithm ?? null,
      engine: body.engine ?? null,
      outputFormats: body.outputFormats ?? [],
    };
  } catch {
    state.server = { checked: true, ok: false, sharp: null, algorithm: null };
  }
  return state.server;
}

export function useWorkspace() {
  return {
    state: readonly(state),
    selected,
    stats,
    actions: {
      addFiles,
      loadSamples,
      removeItem,
      clearItems,
      selectItem,
      setEngine,
      setOption,
      setOutput,
      setView,
      resetOptions,
      exportItem,
      exportAll,
      copyBounds,
      checkServer,
      toggleTheme,
      recomputeAll,
    },
    meta: { ALGORITHM },
  };
}
