/**
 * 图集透明裁剪：取景框尺寸约束
 * ----------------------------
 * 图集模式下所有帧共用一个相对取景框，裁出来再按比例放进统一尺寸。
 * 统一尺寸如果小于「最大 AABB」，内容会被缩小/裁掉——所以必须 ≥ 各帧裁剪后的最大宽高。
 *
 * 这里只放纯函数，方便单测；UI / composable 都复用同一套约束。
 */

export const MAX_ATLAS_SIDE = 8192;

function normalizeSide(value, fallback = 1) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return Math.max(1, Math.round(fallback));
  return Math.min(MAX_ATLAS_SIDE, number);
}

/** 最大 AABB：各帧裁剪后的像素宽高最大值。 */
export function normalizeMinSize(min) {
  return {
    width: normalizeSide(min?.width, 1),
    height: normalizeSide(min?.height, 1),
  };
}

/**
 * 把用户输入 / 预设 / 自定义尺寸夹到合法范围。
 * 返回 clamped 标记，UI 用来提示「不能小于最大 AABB」。
 */
export function clampAtlasSize(min, frame) {
  const limit = normalizeMinSize(min);
  const width = normalizeSide(frame?.width, limit.width);
  const height = normalizeSide(frame?.height, limit.height);
  return {
    width: Math.max(limit.width, width),
    height: Math.max(limit.height, height),
    clamped: {
      width: width < limit.width,
      height: height < limit.height,
    },
    min: limit,
  };
}

/** 自动模式：直接用最小尺寸（= 最大 AABB）。 */
export function resolveAtlasFrameSize(min, frame) {
  const limit = normalizeMinSize(min);
  if (!frame || frame.mode !== 'custom') return { width: limit.width, height: limit.height, min: limit, clamped: false };
  return { ...clampAtlasSize(limit, frame), min: limit };
}

/** 预设命名：没填名字就用「宽×高」。 */
/**
 * 拖动把手计算新尺寸。
 * 画布里输出框居中显示，所以拖动右/下边缘时两侧对称扩张：
 * 屏幕位移 d 对应总尺寸变化 2d（这样把手会跟着光标走）。
 *
 * @param {{start:{width:number,height:number}, dx?:number, dy?:number, scale?:number, handle?:string}} input
 *   handle: 由 n/s/e/w 组合，例如 'se' / 'e' / 'n' / 'nw'
 */
/**
 * 单张图片的自定义尺寸框（固定大小，只移动位置）。
 *
 * 尺寸由「自定义输出尺寸的宽高比」决定：取能完整包住 AABB 的最大同比例矩形
 * （再限制在图片范围内），所以用户改尺寸预设时框尺寸会跟着变，但界面上不能拖大拖小。
 * 位置用归一化中心点保存，每张图片各自独立；不传 center 时默认套在 AABB 中心。
 */
export function customFrameRect({ imageWidth, imageHeight, bounds, outSize, center } = {}) {
  const imageW = Math.max(1, Math.round(Number(imageWidth) || 1));
  const imageH = Math.max(1, Math.round(Number(imageHeight) || 1));
  const aspect = Math.max(0.0001, (Number(outSize?.width) || 1) / (Number(outSize?.height) || 1));
  const content =
    bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0
      ? { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, width: Number(bounds.width), height: Number(bounds.height) }
      : { x: 0, y: 0, width: imageW, height: imageH };

  // 完整包住内容
  let width = Math.max(content.width, content.height * aspect);
  let height = width / aspect;
  if (width > imageW) {
    width = imageW;
    height = width / aspect;
  }
  if (height > imageH) {
    height = imageH;
    width = height * aspect;
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width > imageW) width = imageW;
  if (height > imageH) height = imageH;

  const defaultCx = (content.x + content.width / 2) / imageW;
  const defaultCy = (content.y + content.height / 2) / imageH;
  const halfX = width / 2 / imageW;
  const halfY = height / 2 / imageH;
  const clampAxis = (value, half) => Math.min(1 - half, Math.max(half, Number(value)));
  const cx = clampAxis(center?.cx ?? defaultCx, halfX);
  const cy = clampAxis(center?.cy ?? defaultCy, halfY);
  return {
    x: Math.max(0, Math.min(imageW - width, Math.round(cx * imageW - width / 2))),
    y: Math.max(0, Math.min(imageH - height, Math.round(cy * imageH - height / 2))),
    width,
    height,
    cx,
    cy,
  };
}

export function resizeAtlasFrame({ start, dx = 0, dy = 0, scale = 1, handle = 'se' } = {}) {
  const factor = 2 / Math.max(0.0001, Number(scale) || 1);
  const horizontal = /[ew]/.test(handle);
  const vertical = /[ns]/.test(handle);
  let width = Number(start?.width) || 1;
  let height = Number(start?.height) || 1;
  if (horizontal) width += (handle.includes('w') ? -dx : dx) * factor;
  if (vertical) height += (handle.includes('n') ? -dy : dy) * factor;
  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function atlasSizeName(name, width, height) {
  const text = String(name ?? '').trim().slice(0, 40);
  return text || `${normalizeSide(width)}×${normalizeSide(height)}`;
}

/** 生成一个合法的尺寸预设（至少不小于最大 AABB）。 */
export function makeAtlasSizePreset({ name, width, height }, min, id) {
  const size = clampAtlasSize(min, { width, height });
  return {
    id: id || `atlas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: atlasSizeName(name, size.width, size.height),
    width: size.width,
    height: size.height,
    clamped: size.clamped,
  };
}

/** 快速预设：最大 AABB / 1.5 倍 / 2 倍 / 以最大边为正方形的 1 倍。 */
export function quickAtlasSizes(min) {
  const limit = normalizeMinSize(min);
  const side = Math.max(limit.width, limit.height);
  return [
    { id: 'max', label: '最大 AABB', width: limit.width, height: limit.height },
    { id: 'square', label: '正方形', width: side, height: side },
    { id: 'x1.5', label: '×1.5', width: Math.round(limit.width * 1.5), height: Math.round(limit.height * 1.5) },
    { id: 'x2', label: '×2', width: limit.width * 2, height: limit.height * 2 },
  ];
}
