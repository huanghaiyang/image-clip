/**
 * 视频水印去除
 * -------------
 * 复用图片水印的检测 / 反混合算法（`server/src/watermark.js` + `shared/watermark`），
 * 但把「静态水印」当成跨帧共享的一张掩膜来处理 —— 这也是 Concat 处理视频遮罩的思路：
 * 只在少量帧上做推理，其余帧直接复用同一遮罩，避免逐帧检测的开销。
 *
 * 两种去除路径：
 *
 *   1. **unblend（逐帧反混合）**：水印是半透明的（平台 logo/文字最常见）。
 *      在样本帧上一次性估出 (α, W)，之后每帧只做逐像素反混合，
 *      1080p 也就几毫秒一帧；用 FFmpeg 解码成 rawvideo 管道流式处理，不落临时帧文件。
 *   2. **removelogo（空间插值）**：水印不透明或反混合不可信时，交给 FFmpeg 的
 *      `removelogo` 滤镜，按掩膜边界插值填充；同样一次 ffmpeg 调用完成并保留音轨。
 *
 * 坐标约定：所有掩膜/裁剪坐标都是**旋转后**画面（用户看到的方向）的像素坐标。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  countMask,
  encodeRle,
  erode,
  estimateWatermarkParams,
  isUnblendPlausible,
  overlayRgba,
} from '../../shared/watermark/index.js';
import {
  VideoError,
  displaySizeOf,
  exportVideo,
  extractFrame,
  normalizeCrop,
  probeVideo,
  resolveBinaries,
} from './ffmpeg.js';
import { decodeRgba } from './imaging.js';
import { analyzeWatermark, decodeMaskInput, maskToPng } from './watermark.js';

const PREVIEW_MAX_EDGE = 1280;

export async function detectVideoWatermark({ input, time = null, cacheDir, analyze = {} }) {
  const meta = await probeVideo(input);
  const size = displaySizeOf(meta);
  if (!size.width || !size.height) throw new VideoError('无法读取视频尺寸', 'NO_DIMENSIONS', 422);

  const duration = Math.max(0, Number(meta.duration) || 0);
  const at = clamp(
    Number.isFinite(Number(time)) ? Number(time) : Math.min(1, duration * 0.1),
    0,
    Math.max(0, duration - 0.02),
  );

  const stat = await fs.stat(input).catch(() => ({ size: 0, mtimeMs: 0 }));
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(input)}|${stat.size}|${stat.mtimeMs}|${size.width}x${size.height}|${at.toFixed(3)}`)
    .digest('hex')
    .slice(0, 20);
  await fs.mkdir(cacheDir, { recursive: true });
  const framePath = path.join(cacheDir, `sample-${key}.png`);
  const exists = await fs.stat(framePath).catch(() => null);
  if (!exists?.isFile()) {
    await extractFrame(input, at, framePath);
  }

  const buffer = await fs.readFile(framePath);
  const started = Date.now();
  const detection = await analyzeWatermark(buffer, analyze);

  const { data, width, height } = await decodeRgba(buffer);
  const image = { width, height, data };
  const preview = await renderPreview(image, detection.mask);

  // 检测掩膜默认外扩 1px（覆盖抗锯齿边），拿它估参会把干净像素算进来、把 α/颜色估淡；
  // 估参前先腐蚀掉这圈边缘，反混合本身仍然用完整掩膜。
  const estimateMask = erode(detection.mask, 1);
  const estimateSource = countMask(estimateMask) > 0 ? estimateMask : detection.mask;
  // 检测阶段的极性（亮水印/暗水印）比"白→灰→黑"全搜更可靠，直接把颜色锁成纯白或纯黑，
  // 否则半透明水印可能被估成中灰，反混合后会留下一层灰影。
  const polarity = detection.diagnostics?.overlay?.polarity ?? null;
  const watermarkColor = polarity === 'bright' ? 'white' : polarity === 'dark' ? 'black' : 'auto';
  const params = estimateWatermarkParams(image, estimateSource, {
    watermarkColor,
    alphaHint: detection.estimatedAlpha ?? null,
    preferHint: Number.isFinite(detection.estimatedAlpha),
    alphaHintWindow: 0.06,
  });
  const plausible = isUnblendPlausible(params);

  return {
    time: at,
    width,
    height,
    preview,
    mask: encodeRle(detection.mask),
    coverage: detection.coverage,
    estimatedAlpha: detection.estimatedAlpha ?? null,
    method: detection.method,
    boxes: detection.boxes?.slice(0, 24) ?? [],
    engineHint: plausible ? 'unblend' : 'removelogo',
    params: plausible
      ? { alpha: params.alpha, color: params.color, confidence: params.confidence }
      : null,
    elapsedMs: Date.now() - started,
  };
}

/**
 * 去除视频水印。
 * @param {{
 *  input:string, output:string,
 *  mask:object, engine?:'auto'|'unblend'|'removelogo',
 *  params?:{alpha:number,color:number[]}|null,
 *  start?:number, duration?:number,
 *  crop?:{x:number,y:number,width:number,height:number}|null,
 *  cacheDir:string, meta?:object, sampleTime?:number,
 * }} options
 */
export async function removeVideoWatermark(options) {
  const meta = options.meta ?? (await probeVideo(options.input));
  const size = displaySizeOf(meta);
  if (!size.width || !size.height) throw new VideoError('无法读取视频尺寸', 'NO_DIMENSIONS', 422);

  const started = Date.now();
  const mask = await decodeMaskInput(options.mask, size.width, size.height);
  if (!mask) throw new VideoError('缺少水印掩膜，请先检测水印区域', 'MISSING_MASK', 422);
  if (countMask(mask) <= 0) throw new VideoError('掩膜为空：没有需要去除的水印区域', 'EMPTY_MASK', 422);

  let params = normalizeParams(options.params);
  let engine = ['auto', 'unblend', 'removelogo'].includes(options.engine) ? options.engine : 'auto';

  if (engine === 'auto') {
    if (!params) params = await estimateFromSample(options, mask, meta);
    engine = params && isUnblendPlausible(params) ? 'unblend' : 'removelogo';
  }
  if (engine === 'unblend' && !params) {
    params = await estimateFromSample(options, mask, meta);
    if (!params || !isUnblendPlausible(params)) engine = 'removelogo';
  }

  const common = {
    input: options.input,
    output: options.output,
    start: Math.max(0, Number(options.start) || 0),
    duration: Math.max(0, Number(options.duration) || 0),
    crop: options.crop ?? null,
    meta,
  };

  let frames = 0;
  if (engine === 'unblend') {
    frames = await streamUnblend({ ...common, mask, params });
  } else {
    await runRemovelogo({ ...common, mask, cacheDir: options.cacheDir });
  }

  const outMeta = await probeVideo(options.output).catch(() => null);
  return {
    engine,
    alpha: params?.alpha ?? null,
    color: params?.color ?? null,
    frames,
    width: outMeta?.width ?? size.width,
    height: outMeta?.height ?? size.height,
    start: common.start,
    duration: outMeta?.duration ?? common.duration,
    elapsedMs: Date.now() - started,
  };
}

function normalizeParams(params) {
  const alpha = Number(params?.alpha);
  const color = Array.isArray(params?.color) ? params.color.map(Number) : null;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null;
  if (!color || color.length < 3 || color.some((c) => !Number.isFinite(c))) return null;
  return { alpha, color: color.slice(0, 3), confidence: Number(params?.confidence) || 0 };
}

/** 用样本帧重新估一次 (α, W)，供用户手动改掩膜或前端没带参数时兜底。 */
async function estimateFromSample(options, mask, meta) {
  try {
    const duration = Math.max(0, Number(meta.duration) || 0);
    const at = clamp(
      Number.isFinite(Number(options.sampleTime)) ? Number(options.sampleTime) : Math.min(1, duration * 0.1),
      0,
      Math.max(0, duration - 0.02),
    );
    await fs.mkdir(options.cacheDir, { recursive: true });
    const tmp = path.join(options.cacheDir, `estimate-${Date.now()}.png`);
    await extractFrame(options.input, at, tmp);
    const buffer = await fs.readFile(tmp);
    await fs.rm(tmp, { force: true }).catch(() => {});
    const { data, width, height } = await decodeRgba(buffer);
    const image = { width, height, data };
    const params = estimateWatermarkParams(image, mask, { watermarkColor: 'auto' });
    return isUnblendPlausible(params) ? { alpha: params.alpha, color: params.color, confidence: params.confidence } : null;
  } catch {
    return null;
  }
}

/** removelogo 只接受「文件名」，把掩膜写进 cacheDir 后用 cwd 相对引用，避开 Windows 路径转义。 */
async function runRemovelogo({ input, output, start, duration, crop, mask, meta, cacheDir }) {
  await fs.mkdir(cacheDir, { recursive: true });
  const png = await maskToPng(mask);
  const name = `mask-${crypto.createHash('sha1').update(png).digest('hex').slice(0, 16)}.png`;
  await fs.writeFile(path.join(cacheDir, name), png);

  await exportVideo({
    input,
    output,
    start,
    duration,
    crop,
    meta,
    filters: [`removelogo=${name}`],
    cwd: cacheDir,
  });
}

/**
 * 解码 → 逐帧反混合 → 重编码，全程管道流式处理，不产生临时帧文件。
 * 返回实际处理的帧数。
 */
async function streamUnblend({ input, output, start, duration, crop, mask, params, meta }) {
  const binaries = await resolveBinaries();
  if (!binaries.ffmpeg) throw new VideoError('未找到 FFmpeg，无法导出视频', 'FFMPEG_MISSING', 503);

  const displaySize = displaySizeOf(meta);
  const rect = crop ? normalizeCrop(crop, displaySize) : null;
  const width = rect ? rect.width : displaySize.width;
  const height = rect ? rect.height : displaySize.height;
  const maskData = rect ? cropMask(mask, rect) : mask.data;
  const fps = clamp(Number(meta.fps) || 30, 1, 120);
  const span = Math.max(0, duration > 0 ? duration : (Number(meta.duration) || 0) - start);
  const frameSize = width * height * 4;

  const decoderArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (start > 0) decoderArgs.push('-ss', start.toFixed(3));
  decoderArgs.push('-i', input);
  if (span > 0) decoderArgs.push('-t', span.toFixed(3));
  if (rect) decoderArgs.push('-vf', `crop=${width}:${height}:${rect.x}:${rect.y}`);
  decoderArgs.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-an', 'pipe:1');

  const encoderArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    fps.toFixed(3),
    '-i',
    'pipe:0',
  ];
  if (start > 0) encoderArgs.push('-ss', start.toFixed(3));
  encoderArgs.push('-i', input);
  if (span > 0) encoderArgs.push('-t', span.toFixed(3));
  encoderArgs.push('-map', '0:v:0', '-map', '1:a?');
  encoderArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  encoderArgs.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', output);

  await fs.mkdir(path.dirname(output), { recursive: true });

  const decoder = spawn(binaries.ffmpeg, decoderArgs, { windowsHide: true });
  const encoder = spawn(binaries.ffmpeg, encoderArgs, { windowsHide: true });

  let decoderErr = '';
  let encoderErr = '';
  decoder.stderr.on('data', (chunk) => {
    decoderErr += chunk;
  });
  encoder.stderr.on('data', (chunk) => {
    encoderErr += chunk;
  });

  let frames = 0;
  let offset = 0;
  const frame = Buffer.alloc(frameSize);
  let writeError = null;

  const decoderDone = new Promise((resolve, reject) => {
    decoder.on('error', reject);
    decoder.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new VideoError(`解码视频失败：${tail(decoderErr)}`, 'DECODE_FAILED', 422));
    });
  });

  const encoderDone = new Promise((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new VideoError(`编码视频失败：${tail(encoderErr)}`, 'ENCODE_FAILED', 422));
    });
  });

  decoder.stdout.on('data', (chunk) => {
    if (writeError) return;
    let pos = 0;
    while (pos < chunk.length) {
      const take = Math.min(frameSize - offset, chunk.length - pos);
      chunk.copy(frame, offset, pos, pos + take);
      offset += take;
      pos += take;
      if (offset < frameSize) continue;

      // 管道写入会持有引用，必须复制一帧出去，不能复用 frame
      const out = Buffer.from(frame);
      applyUnblendInPlace(out, maskData, params);
      frames += 1;
      offset = 0;
      if (!encoder.stdin.write(out)) {
        decoder.stdout.pause();
        encoder.stdin.once('drain', () => decoder.stdout.resume());
      }
    }
  });

  decoder.stdout.on('end', () => {
    encoder.stdin.end();
  });
  // 编码器提前退出时（例如参数非法）解码端还可能在写管道，及时停掉避免 EPIPE 卡住
  encoder.stdin.on('error', () => {
    if (!writeError) writeError = new VideoError('编码进程提前退出', 'ENCODE_FAILED', 422);
    decoder.kill();
  });

  try {
    await decoderDone;
    await encoderDone;
  } catch (err) {
    writeError = err;
    decoder.kill();
    encoder.kill();
    await fs.rm(output, { force: true }).catch(() => {});
    throw err;
  }

  return frames;
}

/** 只处理掩膜内像素；与 shared/watermark/unblend.js 的 unblendImage 等价，但原地改写以避免每帧复制整图。 */
function applyUnblendInPlace(rgba, maskData, params) {
  const { alpha, color } = params;
  const k = 1 / (1 - alpha);
  for (let i = 0, p = 0; i < maskData.length; i += 1, p += 4) {
    const m = maskData[i];
    if (m <= 0) continue;
    const a = m >= 255 ? alpha : alpha * (m / 255);
    rgba[p] = clampByte((rgba[p] - a * color[0]) * k);
    rgba[p + 1] = clampByte((rgba[p + 1] - a * color[1]) * k);
    rgba[p + 2] = clampByte((rgba[p + 2] - a * color[2]) * k);
  }
}

function cropMask(mask, rect) {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const from = (rect.y + y) * mask.width + rect.x;
    out.set(mask.data.subarray(from, from + rect.width), y * rect.width);
  }
  return out;
}

async function renderPreview(image, mask) {
  const tinted = overlayRgba(image, mask, [255, 64, 64], 0.45);
  let pipeline = sharp(Buffer.from(tinted.data), {
    raw: { width: tinted.width, height: tinted.height, channels: 4 },
  });
  if (Math.max(tinted.width, tinted.height) > PREVIEW_MAX_EDGE) {
    pipeline = pipeline.resize(PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE, { fit: 'inside' });
  }
  const png = await pipeline.png({ compressionLevel: 6 }).toBuffer();
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: tinted.width,
    height: tinted.height,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function tail(text, limit = 800) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  return value.length > limit ? value.slice(-limit) : value;
}
