/**
 * 图集（序列帧）统一输出尺寸
 * --------------------------
 * 「图集透明裁剪」先用一个归一化取景框裁每一帧。如果勾选的源图尺寸不同，
 * 同一个相对框裁出来的像素尺寸也会不同（例：400×300 → 280×190，800×600 → 560×380），
 * 直接导出会得到一堆尺寸不一的帧，既没法拼精灵图，也没法像 GIF 那样播放。
 *
 * 这里把「统一尺寸」的规则收敛成两个纯函数，预览与真正批量裁剪共用：
 *  1. computeAtlasOutputSize：取所有帧裁剪矩形的最大宽/高作为统一输出尺寸；
 *  2. fitInto：把某一帧按比例居中放进统一尺寸（contain），空出的部分留透明，
 *     不做拉伸 —— 尺寸一定统一，画面比例也不会变形。
 */

/**
 * 由各帧的裁剪矩形算出统一输出尺寸（取最大宽、最大高）。
 * @param {Array<{width:number,height:number}>} rects
 * @returns {{width:number, height:number}}
 */
export function computeAtlasOutputSize(rects) {
  let width = 1;
  let height = 1;
  for (const rect of rects ?? []) {
    const w = Math.max(1, Math.round(Number(rect?.width) || 0));
    const h = Math.max(1, Math.round(Number(rect?.height) || 0));
    if (w > width) width = w;
    if (h > height) height = h;
  }
  return { width, height };
}

/**
 * 把源矩形按比例居中放进目标尺寸（contain），返回绘制参数。
 *
 * 宽高比一致时 dw/dh 正好填满目标；比例不同则留出透明边，
 * 偏移用 Math.floor 取整，避免半像素累积造成帧与帧之间轻微抖动。
 *
 * @param {{width:number,height:number}} rect 源裁剪矩形（像素）
 * @param {{width:number,height:number}} size 统一输出尺寸
 * @returns {{dx:number, dy:number, dw:number, dh:number, scale:number}}
 */
export function fitInto(rect, size) {
  const sourceWidth = Math.max(1, Math.round(Number(rect?.width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(rect?.height) || 0));
  const targetWidth = Math.max(1, Math.round(Number(size?.width) || 0));
  const targetHeight = Math.max(1, Math.round(Number(size?.height) || 0));
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const dw = Math.max(1, Math.min(targetWidth, Math.round(sourceWidth * scale)));
  const dh = Math.max(1, Math.min(targetHeight, Math.round(sourceHeight * scale)));
  return {
    scale,
    dw,
    dh,
    dx: Math.floor((targetWidth - dw) / 2),
    dy: Math.floor((targetHeight - dh) / 2),
  };
}
