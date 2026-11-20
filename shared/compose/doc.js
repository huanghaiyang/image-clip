/**
 * 合成文档模型 —— 纯数据 + 纯函数，浏览器与 Node 共用
 * ----------------------------------------------------
 * 这是把「九个工具各自一块画布」升级成「一个文档」的地基：
 *   doc = { width, height, layers: [...], animation, selection }
 *
 * 图层只有四种类型，够用且不会失控：
 *   image  —— 图片层（bitmap 由 web 侧挂上，这里不碰 canvas）
 *   adjust —— 调整图层，作用于它下面的合成结果（和 PS 一致）
 *   text   —— 文字层
 *   group  —— 预留，暂不参与渲染
 *
 * 蒙版是 shared/maskops.js 的灰度掩膜；掩膜对象一经创建就不再原地修改，
 * 所以撤销快照可以直接共享引用，不需要每次复制几 MB。
 */

import { createAnimation } from '../anim/keyframes.js';

/** PS 的混合模式 → canvas globalCompositeOperation。canvas 缺的几种直接拒绝。 */
export const BLEND_MODES = [
  { value: 'normal', label: '正常', op: 'source-over' },
  { value: 'multiply', label: '正片叠底', op: 'multiply' },
  { value: 'screen', label: '滤色', op: 'screen' },
  { value: 'overlay', label: '叠加', op: 'overlay' },
  { value: 'add', label: '相加', op: 'lighter' },
  { value: 'darken', label: '变暗', op: 'darken' },
  { value: 'lighten', label: '变亮', op: 'lighten' },
  { value: 'colorDodge', label: '颜色减淡', op: 'color-dodge' },
  { value: 'colorBurn', label: '颜色加深', op: 'color-burn' },
  { value: 'hardLight', label: '强光', op: 'hard-light' },
  { value: 'softLight', label: '柔光', op: 'soft-light' },
  { value: 'difference', label: '差值', op: 'difference' },
  { value: 'exclusion', label: '排除', op: 'exclusion' },
  { value: 'hue', label: '色相', op: 'hue' },
  { value: 'saturation', label: '饱和度', op: 'saturation' },
  { value: 'color', label: '颜色', op: 'color' },
  { value: 'luminosity', label: '明度', op: 'luminosity' },
];

export const BLEND_MAP = Object.fromEntries(BLEND_MODES.map((mode) => [mode.value, mode]));

export function blendOperation(value) {
  return (BLEND_MAP[value] ?? BLEND_MAP.normal).op;
}

export const LAYER_KINDS = [
  { value: 'image', label: '图片层' },
  { value: 'adjust', label: '调整层' },
  { value: 'text', label: '文字层' },
];

let sequence = 0;
function nextId(prefix = 'l') {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export function defaultTransform() {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, flipX: false, flipY: false };
}

export function createDoc({ width = 512, height = 512, name = '未命名合成' } = {}) {
  return {
    id: nextId('doc'),
    name,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    layers: [],
    animation: createAnimation({ fps: 24, duration: 2, loop: 'loop' }),
    selection: null,
  };
}

export function createLayer(kind = 'image', { name, width, height, itemId = '', text = null } = {}) {
  return {
    id: nextId(kind === 'adjust' ? 'adj' : 'l'),
    kind,
    name: name || (kind === 'adjust' ? '调整层' : kind === 'text' ? '文字层' : '图层'),
    visible: true,
    locked: false,
    opacity: 100,
    blend: 'normal',
    transform: defaultTransform(),
    /** 图片层的像素：web 侧挂 ImageBitmap，纯数据层只记录来源与尺寸 */
    bitmap: null,
    itemId,
    width: Math.max(1, Math.round(width || 1)),
    height: Math.max(1, Math.round(height || 1)),
    mask: null,
    /** 调整层参数，结构同 shared/color/lut.js 的 DEFAULT_ADJUST */
    adjust: null,
    /** 文字层内容 */
    text: text || {
      content: '文字',
      font: 'system-ui',
      size: 64,
      weight: '600',
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.2,
      strokeWidth: 0,
      strokeColor: '#000000',
    },
    /** 是否能动（关键帧只对可动属性有意义；文字层同样支持 transform） */
    animatable: true,
  };
}

export function findLayer(doc, id) {
  return doc?.layers?.find((layer) => layer.id === id) ?? null;
}

export function findLayerIndex(doc, id) {
  return doc?.layers?.findIndex((layer) => layer.id === id) ?? -1;
}

/** 新图层加到最上层；at 用于「插到当前图层上方」。 */
export function addLayer(doc, layer, { at = null } = {}) {
  if (!doc || !layer) return null;
  if (at === null) doc.layers.push(layer);
  else {
    const index = Math.max(0, Math.min(doc.layers.length, Number(at)));
    doc.layers.splice(index, 0, layer);
  }
  return layer;
}

export function removeLayer(doc, id) {
  const index = findLayerIndex(doc, id);
  if (index < 0) return null;
  const [removed] = doc.layers.splice(index, 1);
  if (doc.animation?.tracks) delete doc.animation.tracks[id];
  return removed;
}

/** delta > 0 向上（更靠前）移动。 */
export function moveLayer(doc, id, delta) {
  const index = findLayerIndex(doc, id);
  if (index < 0) return false;
  const target = Math.max(0, Math.min(doc.layers.length - 1, index + Math.sign(delta)));
  if (target === index) return false;
  const [layer] = doc.layers.splice(index, 1);
  doc.layers.splice(target, 0, layer);
  return true;
}

export function duplicateLayer(doc, id) {
  const source = findLayer(doc, id);
  if (!source) return null;
  const copy = {
    ...source,
    id: nextId(source.kind === 'adjust' ? 'adj' : 'l'),
    name: `${source.name} 副本`,
    transform: { ...source.transform },
    adjust: source.adjust ? { ...source.adjust, curves: { ...source.adjust.curves } } : null,
    text: source.text ? { ...source.text } : null,
    // 位图与蒙版是不可变对象，可以安全共享
  };
  const index = findLayerIndex(doc, id);
  doc.layers.splice(index + 1, 0, copy);
  return copy;
}

/** 合并式更新：transform / text / adjust 里传对象时做浅合并，不会丢字段。 */
export function patchLayer(doc, id, patch = {}) {
  const layer = findLayer(doc, id);
  if (!layer) return null;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'transform' && value && typeof value === 'object') Object.assign(layer.transform, value);
    else if (key === 'text' && value && typeof value === 'object') Object.assign(layer.text, value);
    else if (key === 'adjust' && value && typeof value === 'object') Object.assign(layer.adjust, value);
    else layer[key] = value;
  }
  return layer;
}

export function setLayerOrder(doc, id, targetIndex) {
  const index = findLayerIndex(doc, id);
  if (index < 0) return false;
  const target = Math.max(0, Math.min(doc.layers.length - 1, Math.round(targetIndex)));
  if (target === index) return false;
  const [layer] = doc.layers.splice(index, 1);
  doc.layers.splice(target, 0, layer);
  return true;
}

/**
 * 把关键帧采样结果合并进图层 transform（不动原图层，返回一个新 transform）。
 * sample 为 null 时直接用图层自身的静态值。
 */
export function resolveTransform(layer, sample = null) {
  const base = layer?.transform ?? defaultTransform();
  const out = { ...base };
  if (!sample) return out;
  for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']) {
    if (Number.isFinite(sample[key])) {
      if (key === 'opacity') continue; // 不透明度走图层属性，不进 transform
      out[key] = sample[key];
    }
  }
  return out;
}

/**
 * 图层包围盒（文档坐标系，未旋转时的轴对齐近似：用四角变换后的 AABB）。
 * 选中框、命中测试、导出 trim 都用它。
 */
export function layerBounds(layer, sample = null) {
  if (!layer) return null;
  const t = resolveTransform(layer, sample);
  const w = layer.width;
  const h = layer.height;
  const cx = w / 2;
  const cy = h / 2;
  const angle = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [ux, uy] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const lx = (ux - cx) * Math.abs(t.scaleX) * (t.flipX ? -1 : 1);
    const ly = (uy - cy) * Math.abs(t.scaleY) * (t.flipY ? -1 : 1);
    const x = cx + lx * cos - ly * sin + t.x;
    const y = cy + lx * sin + ly * cos + t.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 文档坐标 → 图层本地坐标（用于在画布上定位拖拽、取色）。 */
export function toLayerLocal(layer, x, y, sample = null) {
  const t = resolveTransform(layer, sample);
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const angle = (-t.rotation * Math.PI) / 180;
  const dx = x - t.x - cx;
  const dy = y - t.y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let lx = dx * cos - dy * sin;
  let ly = dx * sin + dy * cos;
  lx = lx / (Math.abs(t.scaleX) * (t.flipX ? -1 : 1));
  ly = ly / (Math.abs(t.scaleY) * (t.flipY ? -1 : 1));
  return { x: lx + cx, y: ly + cy };
}

/** 命中测试：从最上层往下找（跳过隐藏层与调整层）。 */
export function hitTest(doc, x, y, sampleFor = () => null) {
  for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
    const layer = doc.layers[i];
    if (!layer.visible || layer.kind === 'adjust' || layer.kind === 'group') continue;
    const local = toLayerLocal(layer, x, y, sampleFor(layer));
    if (local.x >= 0 && local.y >= 0 && local.x <= layer.width && local.y <= layer.height) return layer;
  }
  return null;
}

/** 文档级像素 → 图层本地像素（给魔棒用）。 */
export function documentToLayer(doc, layer, x, y, sample = null) {
  const local = toLayerLocal(layer, x, y, sample);
  return {
    x: Math.max(0, Math.min(layer.width - 1, Math.round(local.x))),
    y: Math.max(0, Math.min(layer.height - 1, Math.round(local.y))),
  };
}

// --------------------------------------------------------------- 序列化

function maskToJson(mask) {
  if (!mask) return null;
  if (typeof Buffer !== 'undefined') {
    return { width: mask.width, height: mask.height, data: Buffer.from(mask.data).toString('base64') };
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < mask.data.length; i += chunk) {
    binary += String.fromCharCode(...mask.data.subarray(i, i + chunk));
  }
  return { width: mask.width, height: mask.height, data: btoa(binary) };
}

function maskFromJson(json) {
  if (!json?.data) return null;
  let bytes;
  if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(json.data, 'base64'));
  else {
    const binary = atob(json.data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  }
  return { width: json.width, height: json.height, data: bytes };
}

/** 可存盘的 JSON（bitmap 不序列化，靠 itemId 在下次打开时重新取）。 */
export function serializeDoc(doc) {
  return {
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    animation: JSON.parse(JSON.stringify(doc.animation ?? {})),
    layers: (doc.layers ?? []).map((layer) => ({
      ...layer,
      bitmap: null,
      mask: maskToJson(layer.mask),
      transform: { ...layer.transform },
      adjust: layer.adjust ? JSON.parse(JSON.stringify(layer.adjust)) : null,
      text: layer.text ? { ...layer.text } : null,
    })),
  };
}

export function deserializeDoc(json, doc = null) {
  const target = doc ?? createDoc({ width: json.width, height: json.height, name: json.name });
  target.id = json.id || target.id;
  target.name = json.name || target.name;
  target.width = Math.max(1, Math.round(json.width));
  target.height = Math.max(1, Math.round(json.height));
  target.animation = json.animation ? JSON.parse(JSON.stringify(json.animation)) : createAnimation();
  target.layers = (json.layers ?? []).map((layer) => ({
    ...layer,
    bitmap: null,
    mask: maskFromJson(layer.mask),
  }));
  return target;
}

// --------------------------------------------------------------- 撤销栈

/**
 * 撤销栈：快照共享 bitmap 与 mask 引用（可变字段全部复制），
 * 所以一步的开销只有几十个对象，不是一张图。
 */
export function createHistory(doc, { limit = 40 } = {}) {
  const past = [];
  const future = [];
  let current = snapshotDoc(doc);
  let label = '';

  function snapshotDoc(source) {
    return {
      width: source.width,
      height: source.height,
      name: source.name,
      selection: source.selection ? { ...source.selection } : null,
      animation: JSON.parse(JSON.stringify(source.animation ?? {})),
      layers: source.layers.map((layer) => ({
        ...layer,
        transform: { ...layer.transform },
        adjust: layer.adjust ? JSON.parse(JSON.stringify(layer.adjust)) : null,
        text: layer.text ? { ...layer.text } : null,
      })),
    };
  }

  function restore(snap) {
    doc.name = snap.name;
    doc.width = snap.width;
    doc.height = snap.height;
    doc.selection = snap.selection;
    doc.animation = snap.animation;
    // 图层原地改写：保持外层拿到的 reactive 数组引用
    doc.layers.splice(0, doc.layers.length, ...snap.layers);
  }

  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get label() {
      return label;
    },
    /** 在任何会改动文档的操作之前调用，记录「改之前」的状态。 */
    record(nextLabel = '编辑') {
      // 直接快照「此刻」的文档：调用方在改动前调用 record，这样不会因为
      // 上一次操作忘了 commit 而回退到过期快照（建立合成 / 导入图层尤其明显）。
      current = snapshotDoc(doc);
      past.push(current);
      if (past.length > limit) past.shift();
      future.length = 0;
      label = nextLabel;
    },
    /** 一次拖动结束再提交：把「改之后」的状态收进当前快照。 */
    commit(nextLabel = '编辑') {
      current = snapshotDoc(doc);
      label = nextLabel;
      return past.length > 0;
    },
    undo() {
      if (!past.length) return false;
      const snap = past.pop();
      // 以「撤销前」的真实文档作为重做目标，避免依赖调用方是否 commit
      future.push(snapshotDoc(doc));
      current = snap;
      restore(snap);
      return true;
    },
    redo() {
      if (!future.length) return false;
      const snap = future.pop();
      past.push(snapshotDoc(doc));
      current = snap;
      restore(snap);
      return true;
    },
    reset() {
      past.length = 0;
      future.length = 0;
      current = snapshotDoc(doc);
    },
  };
}

/** 文档里所有非空蒙版的并集包围盒（导出 trim 用）。 */
export function contentBounds(doc, sampleFor = () => null) {
  let box = null;
  for (const layer of doc.layers) {
    if (!layer.visible || layer.kind === 'adjust' || layer.kind === 'group') continue;
    const bounds = layerBounds(layer, sampleFor(layer));
    if (!bounds) continue;
    if (!box) box = { ...bounds };
    else {
      const right = Math.max(box.x + box.width, bounds.x + bounds.width);
      const bottom = Math.max(box.y + box.height, bounds.y + bounds.height);
      box.x = Math.min(box.x, bounds.x);
      box.y = Math.min(box.y, bounds.y);
      box.width = right - box.x;
      box.height = bottom - box.y;
    }
  }
  return box;
}
