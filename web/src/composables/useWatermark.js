/**
 * 水印模式的状态与动作。
 *
 * 与 useWorkspace 相同的单例约定：模块级 reactive state + readonly 暴露 + actions，
 * 这样 TopBar / WatermarkPanel / WatermarkStage 三个组件共享同一份掩膜与参数，
 * 不必层层透传 props。
 *
 * 掩膜（Uint8Array，4000×3000 就是 12M 个元素）有三条铁律：
 *  1) 赋值时 markRaw，撤销栈里的副本也要 markRaw，否则 Vue 会逐元素建代理；
 *  2) 覆盖面积用增量计数维护，绝不放进 computed —— 每画一笔重扫全图会直接掉帧；
 *  3) maskVersion 这类计数器放在 markRaw 对象里，涂抹期间不触发任何全局重算。
 */
import { computed, markRaw, reactive, readonly, watch } from 'vue';

import {
  SERVER_HINT,
  WatermarkApiError,
  createMask,
  decodeMaskFromDataUrl,
  decodeMaskFromRle,
  detectWatermark,
  encodeMaskToDataUrl,
  fetchHealth,
  removeWatermark,
  strokeMask,
} from '../lib/watermark.js';
import { blobToBytes, createZip } from '../lib/zip.js';
import { downloadBlob, formatBytes } from '../lib/imaging.js';
import { useWorkspace } from './useWorkspace.js';

const workspace = useWorkspace();

/**
 * 掩膜相关的“热”字段单独放一个 markRaw 盒子：Uint8Array 绝不能被 Vue 逐元素代理。
 * 但它也是响应式的“盲区”，所以凡是界面要读的状态（ready / version / coverage）
 * 都镜像到 entry 的普通字段上，由它们触发重渲染。
 */
function createMaskState() {
  return {
    mask: null, // Uint8Array，0=保留 255=去除
    width: 0,
    height: 0,
    version: 0, // 每次变化自增，供画布做增量重绘
    padded: 0, // 覆盖像素数（增量维护）
    total: 0,
  };
}

/** 每个素材一份水印工作区（结果按 id 存，切换素材不会丢已涂抹的掩膜）。 */
function createEntry() {
  return {
    maskState: markRaw(createMaskState()),
    history: [], // 画笔撤销栈（markRaw 的掩膜快照）
    redo: [],
    detect: null, // 服务端检测摘要 { method, usedMethods, confidence, elapsedMs, boxes, diagnostics }
    result: null, // { blob, url, mime, engine, elapsedMs, alpha, filename }
    maskReady: false, // maskState.mask 是否可用（响应式镜像）
    maskVersion: 0, // maskState.version 的响应式镜像
    coverage: 0, // maskState.padded / maskState.total 的响应式镜像
    dirty: false, // 掩膜是否被本地画笔改过（界面提示“需重新去除”）
    error: '',
  };
}

const state = reactive({
  mode: 'crop', // crop | watermark
  /** 每个素材的检测/编辑结果，键是素材 id。 */
  entries: {},
  options: {
    method: 'auto',
    sensitivity: 55,
    dilate: 2,
    minArea: 24,
    maxCoverage: 0.6,
    // 水印极性：auto = 先亮后暗（亮极性仅在拿不出可信结果时才回退暗极性）。
    // 白底浅灰角标这类必须显式选 dark 才能测出来。
    polarity: 'auto',
    engine: 'auto',
    watermarkColor: 'auto',
    inpaintRadius: 6,
    feather: 2,
    format: 'png',
    quality: 92,
    // 仅 method=template 用得到；没有上传模板时后端会用原图当模板（界面已提示）
    templateDataUrl: '',
    templateName: '',
  },
  brush: { tool: 'paint', radius: 16, strength: 255, showOverlay: true },
  view: { mode: 'source', compare: false, split: 0.5, zoom: 'fit' },
  busy: false,
  progress: { done: 0, total: 0, label: '' },
  status: '',
  error: '',
  // 服务端能力（GET /api/watermark/health）
  health: { checked: false, ok: false, opencv: false, lama: false, lamaBytes: null, engines: [], detectMethods: [] },
});

const selectedEntry = computed(() => (workspace.state.selectedId ? state.entries[workspace.state.selectedId] ?? null : null));

const hasMask = computed(() => Boolean(selectedEntry.value?.maskReady));

/** 覆盖面积取增量维护的镜像值——绝不能在这里重扫掩膜（见文件头注释）。 */
const coverage = computed(() => selectedEntry.value?.coverage ?? 0);

const serverReady = computed(() => state.health.checked && state.health.ok);

// --------------------------------------------------------------- 内部工具

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

function entryFor(id) {
  // 只对重负载字段 markRaw（掩膜/结果 blob），entry 外壳保持响应式：
  // 否则 dirty/error 这些界面要读的小字段也跟着失去响应。
  if (!state.entries[id]) state.entries[id] = createEntry();
  return state.entries[id];
}

/** 组装 detect / remove 共用的 query 参数。 */
function optionSnapshot() {
  const o = state.options;
  return {
    method: o.method,
    sensitivity: o.sensitivity,
    polarity: o.polarity,
    dilate: o.dilate,
    minArea: o.minArea,
    maxCoverage: o.maxCoverage,
  };
}

function removeSnapshot() {
  const o = state.options;
  return {
    ...optionSnapshot(),
    engine: o.engine,
    watermarkColor: o.watermarkColor,
    inpaintRadius: o.inpaintRadius,
    feather: o.feather,
    format: o.format,
    quality: o.quality,
  };
}

/**
 * 把"检测阶段"得到的先验（不透明度 α 与极性）带回给去除接口。
 *
 * 为什么要这么做：反混合引擎要解 B=(I−αW)/(1−α)，而 α 由边界能量最小化估出；
 * 掩膜是细笔画时这个判据并不稳（实测同一个水印：带先验 α=0.553、不带先验 α=0.02），
 * 于是 auto 会退化成 LaMa 修补——慢十几倍，而且对半透明水印属于**错误**的处理方式
 * （修补是把内容糊掉，反混合才是真正还原）。
 */
function withDetectPrior(item, snapshot) {
  const detect = state.entries[item.id]?.detect;
  if (!detect) return snapshot;
  const out = { ...snapshot };
  if (Number.isFinite(detect.estimatedAlpha)) out.alphaHint = detect.estimatedAlpha;
  if (detect.polarity) out.polarity = detect.polarity;
  return out;
}

/** 把素材转成后端要的两种形态之一（二进制优先，模板场景才升级为 dataURL）。 */
function imageSource(item) {
  if (!item) throw new WatermarkApiError('没有可上传的素材');
  if (item.buffer) {
    return { blob: new Blob([item.buffer], { type: item.type || 'application/octet-stream' }) };
  }
  if (item.bitmap) {
    // 少数素材（示例图走 fetch）没有保留原始字节，只能现场编码
    return { dataUrl: encodeBitmapToDataUrl(item) };
  }
  throw new WatermarkApiError('素材缺少可上传的图片数据');
}

/**
 * JSON 体里必须同时带上图片与掩膜/模板，所以这里一律升级成 dataURL。
 * 坑：不能直接复用 imageSource() —— 它在有原始字节时只给 blob，
 * 那样 JSON.stringify 会把 image 变成 undefined，服务端会以 MISSING_IMAGE 拒收。
 * 另外 item.buffer 可能是 fetch 响应留下的分离（detached）ArrayBuffer，
 * 所以这里从已经解码好的 bitmap 重新编码，而不是再碰原始字节。
 */
function imagePayloadForJson(item) {
  if (!item) throw new WatermarkApiError('没有可上传的素材');
  return { dataUrl: encodeBitmapToDataUrl(item), template: state.options.templateDataUrl || '' };
}

/** 把解码后的 bitmap 重新编码成 PNG dataURL（仅在没有原始字节时使用）。 */
function encodeBitmapToDataUrl(item) {
  const canvas = document.createElement('canvas');
  canvas.width = item.width;
  canvas.height = item.height;
  canvas.getContext('2d').drawImage(item.bitmap, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * 模板模式要传两张图，二进制请求体装不下，只能统一升级成 dataURL。
 * 用户没上传模板时退回“用自身当模板”——占位而已，界面上会明确提示。
 */
function templateSource(item) {
  return imagePayloadForJson(item);
}

function revokeResult(entry) {
  if (entry?.result?.url) URL.revokeObjectURL(entry.result.url);
}

function describeError(err) {
  if (err instanceof WatermarkApiError) return err.message;
  return err?.message || '未知错误';
}

// --------------------------------------------------------------- 服务端能力

/** health 的并发去重：切模式与画布挂载会在同一帧各调一次，没必要打两次请求。 */
let healthPromise = null;

export async function checkHealth() {
  if (healthPromise) return healthPromise;
  healthPromise = (async () => {
    try {
      const health = await fetchHealth();
      state.health = { checked: true, ...health };
      if (!health.ok) setError(`${SERVER_HINT}：服务端未就绪`);
      return health;
    } catch (err) {
      state.health = {
        checked: true,
        ok: false,
        opencv: false,
        lama: false,
        lamaBytes: null,
        engines: [],
        detectMethods: [],
      };
      setError(describeError(err));
      return null;
    } finally {
      healthPromise = null;
    }
  })();
  return healthPromise;
}

// --------------------------------------------------------------- 模式切换

export function setMode(mode) {
  state.mode = mode === 'watermark' ? 'watermark' : 'crop';
  if (state.mode === 'watermark' && !state.health.checked) void checkHealth();
}

export function setOption(key, value) {
  state.options[key] = value;
}

export function setBrush(key, value) {
  state.brush[key] = value;
}

export function setView(key, value) {
  state.view[key] = value;
}

/** 键盘 R 键的循环：原图 → 掩膜 → 结果 → 原图。 */
const VIEW_CYCLE = ['source', 'mask', 'result'];

export function cycleView() {
  const index = VIEW_CYCLE.indexOf(state.view.mode);
  state.view.mode = VIEW_CYCLE[(index + 1) % VIEW_CYCLE.length];
}

// --------------------------------------------------------------- 检测

export async function detectFor(item = workspace.selected.value) {
  if (!item) {
    setError('请先在左侧选择一张素材');
    return null;
  }
  state.busy = true;
  state.progress = { done: 0, total: 0, label: `检测 ${item.name}` };
  try {
    const useTemplate = state.options.method === 'template';
    const source = useTemplate ? templateSource(item) : imageSource(item);
    const raw = await detectWatermark(source, {
      ...optionSnapshot(),
      template: useTemplate ? source.template : undefined,
    });

    const entry = entryFor(item.id);
    entry.detect = markRaw({
      method: raw.method,
    // 区域提议信息（哪几个语义模型参与了）：界面上要能看出"这次用的哪个模型"
    textGate: raw.textGate ?? null,
      usedMethods: raw.usedMethods ?? [],
      confidence: raw.confidence ?? 0,
      elapsedMs: raw.elapsedMs ?? 0,
      boxes: raw.boxes ?? [],
      rle: raw.rle ?? null,
      diagnostics: raw.diagnostics ?? {},
      // 服务端在检测阶段估出的不透明度与极性。去除时要作为**先验**回传：
      // 反混合引擎的边界能量判据在"细笔画掩膜"上并不可靠（实测同一个水印，
      // 带先验 α=0.553、不带先验 α=0.02），没有先验就会退化成慢得多的 LaMa 修补。
      estimatedAlpha: raw.estimatedAlpha ?? null,
      polarity: raw.diagnostics?.overlay?.polarity ?? null,
    });
    entry.redo = [];
    entry.error = '';

    if (raw.rle?.runs?.length) {
      // 首选 RLE：解码确定、不依赖 canvas（详见 decodeMaskFromRle 的说明）
      const decoded = decodeMaskFromRle(raw.rle);
      applyMask(item, entry, decoded.mask, decoded.width, decoded.height);
    } else if (raw.mask?.dataUrl) {
      const decoded = await decodeMaskFromDataUrl(raw.mask.dataUrl);
      applyMask(item, entry, decoded.mask, decoded.width, decoded.height);
    } else {
      // 后端没给掩膜（例如灵敏度下没检测到）：仍然建一张空掩膜，让用户可以直接手涂
      applyMask(item, entry, createMask(item.width, item.height), item.width, item.height);
    }

    if (!state.health.checked) void checkHealth();
    setStatus(
      `检测完成 · ${entry.detect.usedMethods.join('+') || entry.detect.method} · 置信度 ${(
        entry.detect.confidence * 100
      ).toFixed(0)}% · ${entry.detect.elapsedMs}ms`,
    );
    return entry.detect;
  } catch (err) {
    setError(`检测失败：${describeError(err)}`);
    return null;
  } finally {
    state.busy = false;
    state.progress = { done: 0, total: 0, label: '' };
  }
}

/** 掩膜尺寸必须与素材一致，服务端偶尔会返回缩放后的掩膜，这里按最近邻对齐。 */
function applyMask(item, entry, mask, width, height) {
  const { maskState } = entry;
  if (width === item.width && height === item.height) {
    maskState.mask = mask;
  } else {
    const scaled = new Uint8Array(item.width * item.height);
    for (let y = 0; y < item.height; y += 1) {
      const sy = Math.min(height - 1, Math.floor((y * height) / item.height));
      for (let x = 0; x < item.width; x += 1) {
        const sx = Math.min(width - 1, Math.floor((x * width) / item.width));
        scaled[y * item.width + x] = mask[sy * width + sx];
      }
    }
    maskState.mask = scaled;
  }
  maskState.width = item.width;
  maskState.height = item.height;
  maskState.total = item.width * item.height;
  maskState.version += 1;
  recountCoverage(entry);
  entry.maskReady = true;
  entry.maskVersion = maskState.version;
  entry.dirty = false;
  revokeResult(entry);
  entry.result = null;
  entry.coverage = maskState.total ? maskState.padded / maskState.total : 0;
  state.view.compare = false;
}

/** 全量重算覆盖率：只在“新掩膜/清空/反选/撤销”这类整层变化时调用。 */
function recountCoverage(entry) {
  const { mask } = entry.maskState;
  let hits = 0;
  if (mask) {
    for (let i = 0; i < mask.length; i += 1) if (mask[i] > 127) hits += 1;
  }
  entry.maskState.padded = hits;
  entry.coverage = entry.maskState.total ? hits / entry.maskState.total : 0;
}

// --------------------------------------------------------------- 本地掩膜编辑

/** 涂抹一段；坐标是图片像素坐标（画布组件负责屏幕 → 图片的换算）。 */
export function paintSegment(item, from, to, { erase = false } = {}) {
  const entry = entryFor(item.id);
  const { maskState } = entry;
  if (!maskState.mask) return null;
  const box = strokeMask(maskState.mask, maskState.width, maskState.height, from, to, {
    radius: state.brush.radius,
    erase,
  });
  if (!box) return null;

  // 增量维护覆盖面积：只回看被涂抹的那一小块，避免每笔重扫全图。
  // strokeMask 已把区域写成 0/255，所以这里只需要和当前值比对一次。
  const mask = maskState.mask;
  const target = erase ? 0 : 255;
  let delta = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    const row = y * maskState.width;
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (mask[row + x] > 127 !== target > 127) delta += target > 127 ? 1 : -1;
    }
  }
  maskState.padded += delta;
  maskState.version += 1;
  entry.maskVersion = maskState.version;
  entry.coverage = maskState.total ? Math.max(0, maskState.padded) / maskState.total : 0;
  entry.dirty = true;
  return box;
}

/** 撤销栈只在画笔层面回滚（保存掩膜副本），服务端检测结果不受影响。 */
function pushHistory(entry) {
  if (!entry.maskState.mask) return;
  // markRaw 副本：撤销栈里的大数组同样不能被 Vue 代理
  entry.history.push(markRaw(entry.maskState.mask.slice()));
  if (entry.history.length > 12) entry.history.shift();
  entry.redo = [];
}

export function beginStroke(item) {
  const entry = entryFor(item?.id);
  if (entry?.maskState.mask) pushHistory(entry);
}

export function undoMask(item = workspace.selected.value) {
  const entry = entryFor(item?.id);
  if (!entry?.maskState.mask || entry.history.length === 0) {
    setStatus('没有可撤销的涂抹');
    return false;
  }
  entry.redo.push(markRaw(entry.maskState.mask.slice()));
  entry.maskState.mask = entry.history.pop();
  entry.maskState.version += 1;
  entry.maskVersion = entry.maskState.version;
  recountCoverage(entry);
  entry.dirty = true;
  revokeResult(entry);
  entry.result = null;
  setStatus('已撤销上一笔涂抹');
  return true;
}

export function redoMask(item = workspace.selected.value) {
  const entry = entryFor(item?.id);
  if (!entry?.maskState.mask || entry.redo.length === 0) return false;
  entry.history.push(markRaw(entry.maskState.mask.slice()));
  entry.maskState.mask = entry.redo.pop();
  entry.maskState.version += 1;
  entry.maskVersion = entry.maskState.version;
  recountCoverage(entry);
  entry.dirty = true;
  revokeResult(entry);
  entry.result = null;
  setStatus('已重做涂抹');
  return true;
}

export function clearMask(item = workspace.selected.value) {
  const entry = entryFor(item?.id);
  if (!entry?.maskState.mask) return;
  pushHistory(entry);
  entry.maskState.mask.fill(0);
  entry.maskState.version += 1;
  entry.maskVersion = entry.maskState.version;
  recountCoverage(entry);
  entry.dirty = true;
  revokeResult(entry);
  entry.result = null;
  setStatus('已清空掩膜');
}

export function invertMask(item = workspace.selected.value) {
  const entry = entryFor(item?.id);
  if (!entry?.maskState.mask) return;
  pushHistory(entry);
  const { mask } = entry.maskState;
  for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] > 127 ? 0 : 255;
  entry.maskState.version += 1;
  entry.maskVersion = entry.maskState.version;
  recountCoverage(entry);
  entry.dirty = true;
  revokeResult(entry);
  entry.result = null;
  setStatus('已反选掩膜');
}

// --------------------------------------------------------------- 去除与导出

/** 把当前编辑后的掩膜编码成灰度 PNG；feather 在本地完成，服务端只需按原样处理。 */
export async function maskDataUrl(item = workspace.selected.value, { withFeather = true } = {}) {
  const entry = entryFor(item?.id);
  const { maskState } = entry;
  if (!maskState.mask) return '';
  return encodeMaskToDataUrl(maskState.mask, maskState.width, maskState.height, {
    feather: withFeather ? state.options.feather : 0,
  });
}

export function servedFilename(item, format = state.options.format) {
  const base = String(item?.name ?? 'image').replace(/\.[^./\\]+$/, '') || 'image';
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `${base}-watermark-removed.${ext}`;
}

export async function removeFor(item = workspace.selected.value, { silent = false } = {}) {
  if (!item) {
    if (!silent) setError('请先在左侧选择一张素材');
    return null;
  }
  const entry = entryFor(item.id);
  if (!entry.maskState.mask) {
    if (!silent) setError('请先执行「自动检测」或手动涂抹掩膜');
    return null;
  }

  if (!silent) {
    state.busy = true;
    state.progress = { done: 0, total: 0, label: `去除 ${item.name}` };
  }
  try {
    const mask = await maskDataUrl(item);
    // 带掩膜时必须走 JSON 体；此时图片也必须是 dataURL（不能用二进制那份）
    const result = await removeWatermark(imagePayloadForJson(item), withDetectPrior(item, removeSnapshot()), mask);
    revokeResult(entry);
    entry.result = markRaw({
      blob: result.blob,
      url: result.blob ? URL.createObjectURL(result.blob) : '',
      mime: result.mime,
      engine: result.engine,
      elapsedMs: result.elapsedMs,
      alpha: result.alpha,
      patches: result.patches,
      filename: servedFilename(item, state.options.format),
    });
    entry.dirty = false;
    entry.error = '';
    state.view.compare = true;
    if (!silent) {
      setStatus(
        `已去除水印 · ${result.engine ?? state.options.engine} · ${result.elapsedMs || '—'}ms · ${formatBytes(
          result.blob?.size ?? 0,
        )}`,
      );
    }
    return entry.result;
  } catch (err) {
    const message = describeError(err);
    entry.error = message;
    if (!silent) setError(`去除失败：${message}`);
    return null;
  } finally {
    if (!silent) {
      state.busy = false;
      state.progress = { done: 0, total: 0, label: '' };
    }
  }
}

export function downloadResult(item = workspace.selected.value) {
  const entry = entryFor(item?.id);
  if (!entry?.result?.url) {
    setError('当前素材还没有去除结果');
    return;
  }
  downloadBlob(entry.result.blob, entry.result.filename);
  setStatus(`已导出 ${entry.result.filename}`);
}

/**
 * 批量去除：素材列表里所有已检测（或有本地掩膜）的图依次走一遍 remove。
 *
 * 刻意串行而不是并发：inpaint（尤其 LaMa）在服务端是重 CPU/显存任务，
 * 并发只会互相拖慢甚至把服务端打挂；单张失败也不中断整批，最后汇总报错。
 */
export async function removeBatch() {
  const targets = workspace.state.items.filter((item) => state.entries[item.id]?.maskState.mask);
  if (targets.length === 0) {
    setError('没有可处理的素材：请先对素材执行自动检测');
    return;
  }
  state.busy = true;
  let ok = 0;
  const failures = [];
  try {
    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      state.progress = { done: i, total: targets.length, label: `去除 ${item.name}` };
      // 串行是刻意选择（见函数注释），因此这里必须 await 而不是 Promise.all
      const result = await removeFor(item, { silent: true });
      if (result) ok += 1;
      else failures.push(item.name);
    }
  } finally {
    state.busy = false;
    state.progress = { done: 0, total: 0, label: '' };
  }
  if (failures.length) setError(`批量去除：成功 ${ok} 张，失败 ${failures.length} 张（${failures.join('、')}）`);
  else setStatus(`批量去除完成：${ok} 张`);
}

export async function exportBatchZip() {
  const entries = [];
  for (const item of workspace.state.items) {
    const entry = state.entries[item.id];
    if (!entry?.result?.blob) continue;
    entries.push({ name: entry.result.filename, data: await blobToBytes(entry.result.blob) });
  }
  if (entries.length === 0) {
    setError('没有可打包的去除结果');
    return;
  }
  const zip = createZip(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(zip, `image-clip-watermark-${stamp}.zip`);
  setStatus(`已打包 ${entries.length} 张（${formatBytes(zip.size)}）`);
}

// --------------------------------------------------------------- 素材联动

/** 素材被移除时释放 URL 与内存，避免长时间使用后页面积压大图。 */
watch(
  () => workspace.state.items.map((item) => item.id).join(','),
  (ids) => {
    const alive = new Set(ids ? ids.split(',') : []);
    for (const id of Object.keys(state.entries)) {
      if (alive.has(id)) continue;
      revokeResult(state.entries[id]);
      delete state.entries[id];
    }
  },
);

export function useWatermark() {
  return {
    state: readonly(state),
    selectedEntry,
    hasMask,
    coverage,
    serverReady,
    actions: {
      setMode,
      setOption,
      setBrush,
      setView,
      cycleView,
      checkHealth,
      detectFor,
      beginStroke,
      paintSegment,
      undoMask,
      redoMask,
      clearMask,
      invertMask,
      removeFor,
      removeBatch,
      exportBatchZip,
      downloadResult,
      servedFilename,
      maskDataUrl,
    },
    meta: { SERVER_HINT },
  };
}
