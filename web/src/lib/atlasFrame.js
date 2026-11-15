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
