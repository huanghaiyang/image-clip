/**
 * 灰度着色（单色映射）状态（单例）
 * --------------------------------
 * 先把图片转成灰度，再让“灰度色阶”落到任意颜色上：
 *   亮度 L = 0.2126R + 0.7152G + 0.0722B
 *   着色 = L × 所选颜色 / 255
 * 所以选白色就是纯灰度（黑→黑、白→白），选其他颜色则把灰度映射到该色，
 * 颜色越深，整幅图越暗；透明度完全保留，不做任何背景处理。
 *
 * 预览在最长边 1600px 的副本上实时计算，导出时再按原图分辨率重算。
 */
import { computed, markRaw, reactive, readonly } from 'vue';

import { useWorkspace } from './useWorkspace.js';
import { saveBlobToLibrary } from './useLibrary.js';
import { canvasToBlob, createCanvas, stripExtension } from '../lib/imageops.js';
import { downloadBlob } from '../lib/imaging.js';

/** 预览分辨率上限：再大就会拖慢颜色/强度滑块的实时反馈。 */
const PREVIEW_MAX_SIDE = 1600;

const DEFAULT_OPTIONS = {
  /** 着色颜色；白色 = 纯灰度。 */
  color: '#ffffff',
  /** 着色强度 0-100：0 显示原图，100 完全灰度并着色。 */
  strength: 100,
};

const workspace = useWorkspace();

const state = reactive({
  busy: false,
  status: '',
  error: '',
  options: { ...DEFAULT_OPTIONS },
  /** 参数变化时自增，舞台据此重新取预览并重绘。 */
  version: 0,
});

const selected = workspace.selected;
const checkedItems = workspace.checkedItems;
const checkedCount = computed(() => checkedItems.value.length);

/** 每张素材只保留一份预览画布，参数变化时覆盖。 */
const previews = new Map();

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
}

/** '#rgb' / '#rrggbb' / 'rgb' / 'rrggbb' → '#rrggbb'；非法输入返回 null。 */
function normalizeHex(value) {
  let text = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(text)) {
    text = text[0] + text[0] + text[1] + text[1] + text[2] + text[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toLowerCase()}`;
}

function parseRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

/**
 * 就地改写 RGBA 像素：先算亮度，再乘着色颜色，最后按强度与原色混合。
 * @param {ImageData} image
 * @param {{r:number,g:number,b:number}} color
 * @param {number} strength 0-100
 */
function tintPixels(image, color, strength) {
  const data = image.data;
  const s = Math.max(0, Math.min(100, Number(strength) || 0)) / 100;
  if (s === 0) return image;

  const cr = color.r / 255;
  const cg = color.g / 255;
  const cb = color.b / 255;

  for (let i = 0; i < data.length; i += 4) {
    // 全透明像素没有颜色意义，原样保留（也避免给透明底色染上颜色）
    if (data[i + 3] === 0) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // sRGB 亮度权重：人眼对绿色最敏感，对蓝色最不敏感
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    data[i] = r + (luma * cr - r) * s;
    data[i + 1] = g + (luma * cg - g) * s;
    data[i + 2] = b + (luma * cb - b) * s;
  }
  return image;
}

/** 当前参数下的预览画布；参数没变时直接复用缓存。 */
function ensurePreview(item = selected.value) {
  if (!item?.bitmap) return null;

  const key = `${state.options.color}|${state.options.strength}`;
  const cached = previews.get(item.id);
  if (cached && cached.key === key && cached.bitmap === item.bitmap) return cached;

  const maxSide = Math.max(item.width, item.height);
  const scale = maxSide > PREVIEW_MAX_SIDE ? PREVIEW_MAX_SIDE / maxSide : 1;
  const width = Math.max(1, Math.round(item.width * scale));
  const height = Math.max(1, Math.round(item.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(item.bitmap, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  tintPixels(image, parseRgb(state.options.color) ?? { r: 255, g: 255, b: 255 }, state.options.strength);
  ctx.putImageData(image, 0, 0);

  const preview = {
    key,
    bitmap: item.bitmap,
    canvas: markRaw(canvas),
    width,
    height,
    scale,
  };
  previews.set(item.id, preview);
  return preview;
}

/** 修改着色参数并让舞台重绘。 */
export function setOption(key, value) {
  if (key === 'color') {
    const hex = normalizeHex(value);
    if (!hex) return;
    state.options.color = hex;
  } else if (key === 'strength') {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return;
    state.options.strength = Math.min(100, Math.max(0, n));
  } else {
    return;
  }
  state.version += 1;
}

export function resetOptions() {
  Object.assign(state.options, DEFAULT_OPTIONS);
  state.version += 1;
}

/** 按原图分辨率渲染一张着色结果。 */
function renderFull(item) {
  const canvas = createCanvas(item.width, item.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(item.bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, item.width, item.height);
  tintPixels(image, parseRgb(state.options.color) ?? { r: 255, g: 255, b: 255 }, state.options.strength);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * 导出当前素材的灰度着色结果。
 * @param {{addToWorkspace?:boolean,saveToLibrary?:boolean,download?:boolean,inPlace?:boolean}} [options]
 *   inPlace=true 时把结果写回当前素材（覆盖资源库文件），不新增素材。
 */
export async function exportTint(options = {}) {
  const item = selected.value;
  if (!item?.bitmap) {
    setError('请先选择一张素材');
    return null;
  }
  if (state.busy) return null;

  const { addToWorkspace = true, saveToLibrary = false, download = false, inPlace = false } = options;
  state.busy = true;
  try {
    const blob = await canvasToBlob(renderFull(item), 'image/png');
    const filename = `${stripExtension(item.name)}-灰度.png`;
    if (inPlace) {
      const saved = await workspace.actions.saveEditedItem(item, blob);
      if (!saved) return null;
      setStatus(`已保存到当前素材：${saved.path}（灰度 → ${state.options.color.toUpperCase()} · ${state.options.strength}%）`);
      return { blob, item: saved.item };
    }
    if (addToWorkspace) await workspace.actions.addImageBlob(blob, filename);
    if (saveToLibrary) await saveBlobToLibrary(blob, filename, '灰度结果');
    if (download) downloadBlob(blob, filename);
    setStatus(
      `已生成 ${filename}（${Math.round(blob.size / 1024)} KB）` +
        `${saveToLibrary ? ' · 已保存到资源库/灰度结果' : ''}`,
    );
    return { blob };
  } catch (err) {
    setError(`导出灰度结果失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

/** 批量处理左侧勾选的素材，结果写入资源库/灰度结果。 */
export async function applyTintBatch({ saveToLibrary = true } = {}) {
  const items = checkedItems.value.filter((item) => item.bitmap);
  if (!items.length) {
    setError('请先在左侧「当前素材」勾选要处理的图片');
    return null;
  }
  if (state.busy) return null;

  state.busy = true;
  let done = 0;
  try {
    for (const item of items) {
      const blob = await canvasToBlob(renderFull(item), 'image/png');
      const filename = `${stripExtension(item.name)}-灰度.png`;
      if (saveToLibrary) await saveBlobToLibrary(blob, filename, '灰度结果');
      done += 1;
    }
    setStatus(`灰度着色完成：${done}/${items.length} 张${saveToLibrary ? '，已存入资源库/灰度结果' : ''}`);
    return { done, total: items.length };
  } catch (err) {
    setError(`批量灰度着色失败（已完成 ${done}/${items.length}）：${err.message}`);
    return null;
  } finally {
    state.busy = false;
  }
}

export function useGrayscale() {
  return {
    state: readonly(state),
    preview: computed(() => ensurePreview()),
    checkedCount,
    actions: {
      setOption,
      resetOptions,
      ensurePreview,
      exportTint,
      applyTintBatch,
    },
  };
}
