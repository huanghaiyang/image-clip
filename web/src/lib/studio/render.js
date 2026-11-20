/**
 * 合成渲染器（仅浏览器）
 * ----------------------
 * 把 shared/compose/doc.js 的文档画成一帧画面。
 * 图层混合用 canvas 的 globalCompositeOperation（PS 的混合模式几乎都能直接映射），
 * 调色用 shared/color/lut.js 编译出来的 3D LUT，蒙版用 destination-in。
 *
 * 关键取舍：渲染严格按文档分辨率算（预览时传 scale 缩小），
 * 所以「预览看到的位置」和「导出的像素」是同一套坐标，不存在两边对不上。
 */
import { blendOperation, resolveTransform } from '@shared/compose/doc.js';
import { applyLutToRgba, isAdjustActive, lutFromAdjust } from '@shared/color/lut.js';
import { applyMaskToAlpha } from '@shared/maskops.js';
import { planSheet, nineSliceMeta } from '@shared/atlas/meta.js';

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas, readFrequently = false) {
  const ctx = canvas.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('无法创建 canvas 2D 上下文');
  return ctx;
}

/** 调色结果缓存：只有参数或底图变了才重新跑 LUT。 */
const adjustCache = new WeakMap();

function layerKey(layer) {
  return JSON.stringify({ adjust: layer.adjust ?? null, cube: layer.cubeLut?.id ?? null });
}

/** 图层上的完整 LUT 链：参数化调色 + 导入的 .cube（后者叠加在前者之上）。 */
function colorLuts(layer) {
  const list = [];
  if (isAdjustActive(layer.adjust)) {
    list.push({ lut: lutFromAdjust(layer.adjust), strength: layer.adjust.strength ?? 1 });
  }
  if (layer.cubeLut?.data) list.push({ lut: layer.cubeLut, strength: 1 });
  return list;
}

/** 图片层的底图（调色已烘焙），返回 canvas；没有底图返回 null。 */
export function layerSourceCanvas(layer) {
  if (!layer?.bitmap) return null;
  const key = layerKey(layer);
  const cached = adjustCache.get(layer);
  if (cached && cached.key === key && cached.bitmap === layer.bitmap) return cached.canvas;

  const width = layer.bitmap.width || layer.width;
  const height = layer.bitmap.height || layer.height;
  const canvas = createCanvas(width, height);
  const luts = colorLuts(layer);
  const ctx = context2d(canvas, luts.length > 0);
  ctx.drawImage(layer.bitmap, 0, 0);
  if (luts.length) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (const item of luts) applyLutToRgba(image, item.lut, item.strength);
    ctx.putImageData(image, 0, 0);
  }
  adjustCache.set(layer, { key, bitmap: layer.bitmap, canvas });
  return canvas;
}

function renderText(layer) {
  const text = layer.text ?? {};
  const canvas = createCanvas(layer.width, layer.height);
  const ctx = context2d(canvas);
  const size = Math.max(1, Number(text.size) || 64);
  const lineHeight = size * (Number(text.lineHeight) || 1.2);
  ctx.font = `${text.weight || 400} ${size}px ${text.font || 'system-ui'}`;
  ctx.fillStyle = text.color || '#ffffff';
  ctx.strokeStyle = text.strokeColor || '#000000';
  ctx.lineWidth = Number(text.strokeWidth) || 0;
  ctx.textBaseline = 'top';
  ctx.textAlign = text.align === 'center' ? 'center' : text.align === 'right' ? 'right' : 'left';
  const x = text.align === 'center' ? layer.width / 2 : text.align === 'right' ? layer.width : 0;
  String(text.content ?? '')
    .split('\n')
    .forEach((line, index) => {
      const y = index * lineHeight;
      if (ctx.lineWidth > 0) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    });
  return canvas;
}

/** 蒙版 → 用于 destination-in 的画布（尺寸与图层一致）。 */
function maskCanvas(mask, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, true);
  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  for (let y = 0; y < canvas.height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / canvas.height));
    for (let x = 0; x < canvas.width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / canvas.width));
      const value = mask.data[my * mask.width + mx];
      const i = (y * canvas.width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = value;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 生成一个图层自己的画布（底图 + 蒙版），与文档尺寸无关。 */
export function renderLayerSurface(layer) {
  const width = layer.width;
  const height = layer.height;
  let canvas;
  if (layer.kind === 'text') canvas = renderText(layer);
  else canvas = layerSourceCanvas(layer) ?? createCanvas(width, height);

  if (canvas.width !== width || canvas.height !== height) {
    const fitted = createCanvas(width, height);
    context2d(fitted).drawImage(canvas, 0, 0, width, height);
    canvas = fitted;
  }

  if (layer.mask) {
    const scratch = createCanvas(width, height);
    const ctx = context2d(scratch);
    ctx.drawImage(canvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas(layer.mask, width, height), 0, 0);
    canvas = scratch;
  }
  return canvas;
}

/** 调整图层：把 LUT 施加到「下面已经合成好的结果」上（和 PS 的调整层语义一致）。 */
function applyAdjustLayer(accumulator, layer, scale) {
  const luts = colorLuts(layer);
  if (!luts.length) return;
  const ctx = context2d(accumulator, true);
  const image = ctx.getImageData(0, 0, accumulator.width, accumulator.height);
  for (const item of luts) applyLutToRgba(image, item.lut, item.strength * (layer.opacity / 100));

  if (layer.mask) {
    // 蒙版按文档坐标采样：调整层只影响选区内的像素
    const data = image.data;
    const w = accumulator.width;
    const h = accumulator.height;
    for (let y = 0; y < h; y += 1) {
      const my = Math.min(layer.mask.height - 1, Math.floor((y / scale / layer.mask.height) * layer.mask.height));
      for (let x = 0; x < w; x += 1) {
        const mx = Math.min(layer.mask.width - 1, Math.floor((x / scale / layer.mask.width) * layer.mask.width));
        const k = layer.mask.data[my * layer.mask.width + mx] / 255;
        const i = (y * w + x) * 4;
        data[i + 3] = Math.round(data[i + 3] * k);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * 渲染整份文档。
 * @param {object} doc shared/compose/doc.js 的文档
 * @param {{time?:number, sampleFor?:(layer:object)=>(object|null), scale?:number, background?:string|null,
 *          onlyLayerId?:string, opacityOf?:(layer:object)=>number}} options
 * @returns {HTMLCanvasElement}
 */
export function renderDoc(doc, { time = 0, sampleFor = null, scale = 1, background = null, onlyLayerId = null } = {}) {
  const s = Math.max(0.01, Number(scale) || 1);
  const width = Math.max(1, Math.round(doc.width * s));
  const height = Math.max(1, Math.round(doc.height * s));
  const out = createCanvas(width, height);
  const ctx = context2d(out, true);

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    if (onlyLayerId && layer.id !== onlyLayerId) continue;

    if (layer.kind === 'adjust') {
      applyAdjustLayer(out, layer, s);
      continue;
    }

    const sample = sampleFor ? sampleFor(layer) : null;
    const t = resolveTransform(layer, sample);
    const surface = renderLayerSurface(layer);
    // 关键帧里的 opacity 是「绝对不透明度」，没有轨道时采样回退到图层自身值
    const opacity = sample && Number.isFinite(sample.opacity) ? sample.opacity : layer.opacity ?? 100;

    ctx.save();
    ctx.globalAlpha = opacity / 100;
    ctx.globalCompositeOperation = blendOperation(layer.blend);
    ctx.translate((t.x + layer.width / 2) * s, (t.y + layer.height / 2) * s);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.scale(t.scaleX * (t.flipX ? -1 : 1) * s, t.scaleY * (t.flipY ? -1 : 1) * s);
    ctx.drawImage(surface, -layer.width / 2, -layer.height / 2);
    ctx.restore();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return out;
}

/** 单层缩略图（图层面板用）。 */
export function renderLayerThumb(layer, size = 64) {
  const surface = renderLayerSurface(layer);
  const scale = Math.min(1, size / Math.max(surface.width, surface.height));
  const canvas = createCanvas(surface.width * scale, surface.height * scale);
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(surface, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 找出画布上非透明内容的包围盒（导出 trim 用）。 */
export function trimBounds(canvas, threshold = 8) {
  const ctx = context2d(canvas, true);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (data[(y * canvas.width + x) * 4 + 3] < threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function cropCanvas(canvas, rect) {
  const out = createCanvas(rect.width, rect.height);
  context2d(out).drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return out;
}

/** 外扩：把一张帧的边缘像素拉伸 e px，输出 (w+2e)×(h+2e) 的画布。 */
function expandFrame(canvas, e) {
  if (e <= 0) return { canvas, offset: 0 };
  const w = canvas.width;
  const h = canvas.height;
  const out = createCanvas(w + e * 2, h + e * 2);
  const ctx = context2d(out);
  // 四角各画一次、四边各拉伸一次，避免边缘 1px 直接透明
  ctx.drawImage(canvas, 0, 0, 1, 1, 0, 0, e, e);
  ctx.drawImage(canvas, w - 1, 0, 1, 1, e + w, 0, e, e);
  ctx.drawImage(canvas, 0, h - 1, 1, 1, 0, e + h, e, e);
  ctx.drawImage(canvas, w - 1, h - 1, 1, 1, e + w, e + h, e, e);
  ctx.drawImage(canvas, 0, 0, w, 1, e, 0, w, e);
  ctx.drawImage(canvas, 0, h - 1, w, 1, e, e + h, w, e);
  ctx.drawImage(canvas, 0, 0, 1, h, 0, e, e, h);
  ctx.drawImage(canvas, w - 1, 0, 1, h, e + w, e, e, h);
  ctx.drawImage(canvas, e, e);
  return { canvas: out, offset: e };
}

/**
 * 把一组帧画成图集，并按 planSheet 的排版落位。
 * @returns {{canvas:HTMLCanvasElement, plan:object}}
 */
export function composeSheet(frames, options = {}) {
  const plan = planSheet(frames, options);
  const extrude = Math.max(0, Math.round(Number(options.extrude) || 0));
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = context2d(canvas);
  for (const frame of frames) {
    const placement = plan.placements.find((item) => item.name === frame.name) ?? null;
    if (!placement || !frame.canvas) continue;
    const expanded = expandFrame(frame.canvas, extrude);
    ctx.drawImage(expanded.canvas, placement.x - expanded.offset, placement.y - expanded.offset);
  }
  return { canvas, plan };
}

/**
 * 动画 → 帧序列 → 图集。
 * @param {object} doc
 * @param {{count?:number, columns?:number, gap?:number, padding?:number, extrude?:number, pow2?:boolean,
 *          trim?:boolean, scale?:number}} options
 */
export function renderAnimationSheet(doc, { count = 12, sampleFor, scale = 1, trim = true, ...sheetOptions } = {}) {
  const duration = doc.animation?.duration ?? 2;
  const total = Math.max(1, Math.round(count));
  const rendered = [];
  const union = { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity };
  for (let i = 0; i < total; i += 1) {
    const time = (i * duration) / total;
    const canvas = renderDoc(doc, { time, sampleFor, scale });
    rendered.push(canvas);
    if (trim) {
      const rect = trimBounds(canvas);
      if (rect) {
        union.x = Math.min(union.x, rect.x);
        union.y = Math.min(union.y, rect.y);
        union.right = Math.max(union.right, rect.x + rect.width);
        union.bottom = Math.max(union.bottom, rect.y + rect.height);
      }
    }
  }

  // 所有帧用同一个裁切框：逐帧单独 trim 会让播放时角色抖动
  const sharedRect =
    trim && union.right > union.x
      ? { x: union.x, y: union.y, width: union.right - union.x, height: union.bottom - union.y }
      : null;

  const frames = rendered.map((canvas, i) => {
    const cropped = sharedRect ? cropCanvas(canvas, sharedRect) : canvas;
    return {
      name: `frame_${String(i).padStart(4, '0')}`,
      canvas: cropped,
      width: cropped.width,
      height: cropped.height,
      trimmed: Boolean(sharedRect),
      trimX: sharedRect?.x ?? 0,
      trimY: sharedRect?.y ?? 0,
      sourceWidth: Math.round(doc.width * scale),
      sourceHeight: Math.round(doc.height * scale),
    };
  });
  const { canvas, plan } = composeSheet(frames, sheetOptions);
  return { canvas, plan, frames };
}

/** 九宫格元数据（导出 UI 切图时一并给出）。 */
export function makeNineSlice(width, height, border = 8) {
  return nineSliceMeta({ left: border, right: border, top: border, bottom: border, width, height });
}

export async function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, type === 'image/png' ? undefined : quality));
}

export async function canvasToBytes(canvas, type = 'image/png') {
  const blob = await canvasToBlob(canvas, type);
  return new Uint8Array(await blob.arrayBuffer());
}
