/**
 * 视频工作区 API
 * --------------
 * 所有接口都只操作**资源库内已有**的视频（视频先通过 `/api/library/upload` 上传），
 * 这样播放器可以直接用 `GET /api/library/file` 支持 Range 的 URL 拖动播放，
 * 关键帧与音频也能直接落盘到资源库，刷新页面不丢。
 *
 *   GET  /api/video/health             FFmpeg 是否可用、搜索过哪些路径
 *   GET  /api/video/probe?path=        视频元信息（时长/宽高/帧率/音轨）
 *   POST /api/video/frames             { path, mode:'interval'|'count'|'times', ... } → 截取关键帧
 *   POST /api/video/audio              { path, format:'mp3'|'m4a'|'wav'|'flac' } → 提取音轨
 *   POST /api/video/filmstrip          { path, count, width } → 时间轴缩略图 dataURL
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  VideoError,
  exportVideo,
  extractAudio,
  extractFrames,
  ffmpegStatus,
  filmstrip,
  probeVideo,
  sanitizePrefix,
} from './ffmpeg.js';
import { LibraryError } from './library.js';
import { detectVideoWatermark, removeVideoWatermark } from './video-watermark.js';

const MAX_FRAMES = 120;

/**
 * @param {import('./library.js').createLibrary} library
 */
export function createVideoRouter(library) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '4mb' });
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.use((req, res, next) => {
    library.init().then(() => next(), next);
  });

  router.get(
    '/health',
    wrap(async (_req, res) => {
      res.json({
        ok: true,
        service: 'image-clip-video',
        ffmpeg: await ffmpegStatus(),
        limits: { maxFrames: MAX_FRAMES },
        modes: ['interval', 'count', 'times'],
        audioFormats: ['mp3', 'm4a', 'wav', 'flac'],
      });
    }),
  );

  router.get(
    '/probe',
    wrap(async (req, res) => {
      const { abs, rel } = library.resolve(req.query.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);
      const meta = await probeVideo(abs);
      res.json({
        ok: true,
        path: rel,
        name: path.basename(abs),
        bytes: stat.size,
        url: `/api/library/file?path=${encodeURIComponent(rel)}`,
        ...meta,
      });
    }),
  );

  router.post(
    '/filmstrip',
    jsonBody,
    wrap(async (req, res) => {
      const { abs, rel } = library.resolve(req.body?.path, { allowRoot: false });
      const meta = await probeVideo(abs);
      const strip = await filmstrip({
        input: abs,
        duration: meta.duration,
        count: req.body?.count ?? 16,
        width: req.body?.width ?? 160,
        cacheDir: path.join(library.cacheRoot, 'filmstrip'),
      });
      res.json({ ok: true, path: rel, ...strip });
    }),
  );

  router.post(
    '/frames',
    jsonBody,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const { abs, rel } = library.resolve(body.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

      const meta = await probeVideo(abs);
      if (!meta.duration) throw new VideoError('无法读取视频时长，不能按时间截帧', 'NO_DURATION', 422);

      const started = Date.now();
      const times = resolveTimes(body, meta.duration);
      const videoBase = path.basename(abs, path.extname(abs));
      const folderRel = normalizeFolder(body.dir || path.posix.join('关键帧', videoBase));
      const { abs: outputDir } = library.resolve(folderRel);
      await fs.mkdir(outputDir, { recursive: true });

      const prefix = sanitizePrefix(body.prefix || videoBase);
      const result = await extractFrames({
        input: abs,
        times,
        outputDir,
        prefix,
        format: body.format,
        width: body.width,
        pad: body.pad,
      });

      const entries = [];
      for (const file of result.files) {
        try {
          entries.push(await library.entryByRel(path.relative(library.root, file.path).split(path.sep).join('/')));
        } catch {
          /* 单条元数据读取失败不影响整体结果 */
        }
      }

      res.json({
        ok: true,
        sourcePath: rel,
        sourceName: path.basename(abs),
        duration: meta.duration,
        mode: resolveMode(body),
        folder: folderRel,
        requested: times.length,
        extracted: result.files.length,
        failed: result.errors.length,
        errors: result.errors.slice(0, 20),
        entries,
        elapsedMs: Date.now() - started,
      });
    }),
  );

  router.post(
    '/audio',
    jsonBody,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const { abs, rel } = library.resolve(body.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

      const meta = await probeVideo(abs);
      if (!meta.hasAudio) throw new VideoError('该视频没有音轨', 'AUDIO_MISSING', 422);

      const format = normalizeAudioFormat(body.format);
      const videoBase = path.basename(abs, path.extname(abs));
      const folderRel = normalizeFolder(body.dir || '音频');
      const requestedName = String(body.name ?? '').trim() || `${videoBase}.${format}`;
      const target = await library.prepareUpload(folderRel, ensureExtension(requestedName, format));

      await extractAudio({ input: abs, output: target.abs, format });
      const entry = await library.entryByRel(target.rel);
      res.status(201).json({
        ok: true,
        sourcePath: rel,
        format,
        entry,
      });
    }),
  );

  /**
   * 在某一帧上检测水印，返回预览图 + RLE 掩膜 + 建议的去除引擎。
   * 视频是静态水印，检测一次即可复用到所有帧（Concat 的遮罩网格思路）。
   */
  router.post(
    '/watermark/detect',
    express.json({ limit: '16mb' }),
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const { abs, rel } = library.resolve(body.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

      const meta = await probeVideo(abs);
      const detection = await detectVideoWatermark({
        input: abs,
        time: body.time,
        cacheDir: path.join(library.cacheRoot, 'video-watermark'),
        analyze: body.analyze ?? {},
      });

      res.json({
        ok: true,
        sourcePath: rel,
        sourceName: path.basename(abs),
        duration: meta.duration,
        fps: meta.fps,
        ...detection,
      });
    }),
  );

  /**
   * 去除视频水印：unblend 走逐帧反混合流，removelogo 走 FFmpeg 空间插值。
   * 结果写入资源库（默认「视频处理」目录），返回新的视频条目。
   */
  router.post(
    '/watermark/remove',
    express.json({ limit: '16mb' }),
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const { abs, rel } = library.resolve(body.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

      const meta = await probeVideo(abs);
      const base = path.basename(abs, path.extname(abs));
      const folderRel = normalizeFolder(body.dir || '视频处理');
      const requested = String(body.name ?? '').trim() || `${base}-去水印.mp4`;
      const target = await library.prepareUpload(folderRel, ensureExtension(requested, 'mp4'));

      const started = Date.now();
      const result = await removeVideoWatermark({
        input: abs,
        output: target.abs,
        mask: body.mask,
        engine: body.engine,
        params: body.params,
        start: body.start,
        duration: body.duration,
        crop: body.crop,
        sampleTime: body.time,
        cacheDir: path.join(library.cacheRoot, 'video-watermark'),
        meta,
      });
      const entry = await library.entryByRel(target.rel);

      res.status(201).json({
        ok: true,
        sourcePath: rel,
        entry,
        ...result,
        elapsedMs: Date.now() - started,
      });
    }),
  );

  /** 视频切断（trim）与裁剪（crop），一次重编码导出，保留音轨。 */
  router.post(
    '/cut',
    jsonBody,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const { abs, rel } = library.resolve(body.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

      const meta = await probeVideo(abs);
      const start = Math.max(0, Number(body.start) || 0);
      const duration = Math.max(0, Number(body.duration) || 0);
      const crop = body.crop ?? null;
      if (!start && !duration && !crop) {
        throw new VideoError('请先设置切断区间或裁剪范围', 'NOTHING_TO_CUT', 422);
      }

      const base = path.basename(abs, path.extname(abs));
      const folderRel = normalizeFolder(body.dir || '视频处理');
      const requested = String(body.name ?? '').trim() || `${base}-裁剪.mp4`;
      const target = await library.prepareUpload(folderRel, ensureExtension(requested, 'mp4'));

      const result = await exportVideo({
        input: abs,
        output: target.abs,
        start,
        duration,
        crop,
        meta,
      });
      const entry = await library.entryByRel(target.rel);

      res.status(201).json({ ok: true, sourcePath: rel, entry, ...result });
    }),
  );

  return router;
}

/** 把 interval/count/times 三种模式统一换算成秒列表。 */
function resolveTimes(body, duration) {
  const mode = resolveMode(body);
  const maxDuration = Math.max(0, duration - 0.02);
  let times = [];

  if (mode === 'times') {
    if (!Array.isArray(body.times) || !body.times.length) {
      throw new VideoError('手动模式需要 times 数组', 'MISSING_TIMES');
    }
    times = body.times.map((t) => clamp(Number(t) || 0, 0, maxDuration));
    times.sort((a, b) => a - b);
    times = times.filter((t, i) => i === 0 || Math.abs(t - times[i - 1]) > 0.01);
  } else if (mode === 'count') {
    const count = clamp(Math.round(Number(body.count) || 10), 1, MAX_FRAMES);
    for (let i = 0; i < count; i += 1) {
      times.push(count === 1 ? 0 : (i * maxDuration) / (count - 1));
    }
  } else {
    const interval = clamp(Number(body.interval) || 2, 0.05, 3600);
    for (let t = 0; t <= maxDuration + 1e-6; t += interval) {
      times.push(t);
      if (times.length > MAX_FRAMES) break;
    }
    if (!times.length) times.push(0);
  }

  if (times.length > MAX_FRAMES) {
    throw new VideoError(`单次最多截取 ${MAX_FRAMES} 帧，请增大间隔或减少数量`, 'TOO_MANY_FRAMES', 413);
  }
  return times.map((t) => Math.round(t * 1000) / 1000);
}

function resolveMode(body) {
  const mode = String(body?.mode ?? 'interval');
  return ['interval', 'count', 'times'].includes(mode) ? mode : 'interval';
}

function normalizeFolder(input) {
  const raw = String(input ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!raw) return '';
  if (raw.split('/').some((part) => part === '..' || part === '.')) {
    throw new LibraryError('目标目录不合法', 'BAD_PATH', 400);
  }
  return raw;
}

function normalizeAudioFormat(input) {
  const format = String(input ?? 'mp3').toLowerCase();
  return ['mp3', 'm4a', 'wav', 'flac'].includes(format) ? format : 'mp3';
}

function ensureExtension(name, format) {
  const clean = String(name).trim();
  if (clean.toLowerCase().endsWith(`.${format}`)) return clean;
  return `${clean.replace(/\.[^./\\]+$/, '')}.${format}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
