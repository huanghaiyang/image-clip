/**
 * 视频特效 / 变速（AE 侧的 filtergraph 能力）
 * ------------------------------------------
 * 现有 video.js 只做探测、抽帧、提音轨，没有「滤镜」这一层。
 * 这里把 FFmpeg 的滤镜链包装成参数化接口：前端只传 {type, ...params}，
 * 服务端负责校验、拼图、编码，产物直接落到资源库并返回 entry。
 *
 * 支持的效果（都是 FFmpeg 原生滤镜，不引第三方）：
 *   eq           亮度 / 对比度 / 饱和度
 *   colorTemp    色温
 *   blur         高斯模糊
 *   sharpen      锐化
 *   glow         发光（split + gblur + screen 混合）
 *   vignette     暗角
 *   invert       反相
 *   lut          .cube 3D LUT（路径相对资源库）
 *   retime       变速 / 改帧率 / 补帧（setpts + fps / minterpolate）
 *
 * 纯函数 buildFilterChain 单独导出，测试不需要真的跑 FFmpeg。
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { LibraryError } from './library.js';
import { VideoError, probeVideo, resolveBinaries, ffmpegStatus } from './ffmpeg.js';

const EXEC_TIMEOUT_MS = 45 * 60 * 1000;

function clamp(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fmt(value) {
  return Number(value.toFixed(4)).toString();
}

/** 每个效果允许的参数与范围；未列出的键一律丢弃，避免把任意字符串塞进 filtergraph。 */
const EFFECT_SPECS = {
  eq: {
    brightness: [-1, 1, 0],
    contrast: [0, 4, 1],
    saturation: [0, 3, 1],
    gamma: [0.1, 10, 1],
  },
  colorTemp: { temperature: [1000, 40000, 6500] },
  blur: { sigma: [0.1, 50, 2] },
  sharpen: { amount: [0, 5, 1], size: [3, 13, 5] },
  glow: { radius: [1, 60, 16], opacity: [0, 1, 0.35], threshold: [0, 1, 0] },
  vignette: { angle: [0, 3.14, 0.6] },
  invert: {},
  lut: {},
  retime: { speed: [0.1, 10, 1], fps: [1, 240, 0], interpolate: [0, 1, 0] },
};

export const EFFECT_TYPES = Object.keys(EFFECT_SPECS);

export function normalizeEffect(effect) {
  const type = String(effect?.type ?? '');
  const spec = EFFECT_SPECS[type];
  if (!spec) throw new VideoError(`不支持的效果：${type}`, 'UNKNOWN_EFFECT', 422);
  const out = { type };
  for (const [key, [min, max, fallback]] of Object.entries(spec)) {
    if (effect[key] === undefined || effect[key] === null) continue;
    out[key] = clamp(effect[key], min, max, fallback);
  }
  return out;
}

function escapeFilterPath(file) {
  return String(file).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * 把效果列表编译成滤镜链。
 * @returns {{chain:string, complex:string|null, needsAudioTempo:number|null}}
 *   chain 可直接用于 -vf；complex 存在时要用 -filter_complex 并通过 [vout] 映射。
 */
export function buildFilterChain(effects = [], { lutPath = null } = {}) {
  const list = effects.map(normalizeEffect);
  const simple = [];
  let glow = null;
  let retime = null;

  for (const effect of list) {
    switch (effect.type) {
      case 'eq':
        simple.push(
          `eq=brightness=${fmt(effect.brightness ?? 0)}:contrast=${fmt(effect.contrast ?? 1)}:saturation=${fmt(
            effect.saturation ?? 1,
          )}:gamma=${fmt(effect.gamma ?? 1)}`,
        );
        break;
      case 'colorTemp':
        simple.push(`colortemperature=temperature=${Math.round(effect.temperature ?? 6500)}`);
        break;
      case 'blur':
        simple.push(`gblur=sigma=${fmt(effect.sigma ?? 2)}`);
        break;
      case 'sharpen':
        simple.push(`unsharp=${Math.round(effect.size ?? 5)}:${Math.round(effect.size ?? 5)}:${fmt(effect.amount ?? 1)}`);
        break;
      case 'vignette':
        simple.push(`vignette=angle=${fmt(effect.angle ?? 0.6)}`);
        break;
      case 'invert':
        simple.push('negate');
        break;
      case 'lut':
        if (lutPath) simple.push(`lut3d=file='${escapeFilterPath(lutPath)}'`);
        break;
      case 'glow':
        glow = { radius: effect.radius ?? 16, opacity: effect.opacity ?? 0.35 };
        break;
      case 'retime':
        retime = effect;
        break;
      default:
        break;
    }
  }

  // 变速放到最前：先改时间轴再改画面，避免补帧把速度也一起补掉
  const timeFilters = [];
  if (retime) {
    const speed = retime.speed ?? 1;
    if (Math.abs(speed - 1) > 1e-3) timeFilters.push(`setpts=${fmt(1 / speed)}*PTS`);
    if (retime.fps > 0) {
      if (retime.interpolate) timeFilters.push(`minterpolate=fps=${Math.round(retime.fps)}:mi_mode=mci`);
      else timeFilters.push(`fps=${Math.round(retime.fps)}`);
    }
  }

  const head = [...timeFilters, ...simple];
  if (!glow) {
    return {
      chain: head.join(','),
      complex: null,
      needsAudioTempo: retime && Math.abs((retime.speed ?? 1) - 1) > 1e-3 ? retime.speed : null,
    };
  }

  const base = head.length ? `[0:v]${head.join(',')}[base];` : '[0:v]split=2[b1][b2];';
  const splitTail = head.length
    ? '[base]split=2[b1][b2];[b2]gblur=sigma=' + fmt(glow.radius) + '[gl];[b1][gl]blend=all_mode=screen:all_opacity=' + fmt(glow.opacity) + '[vout]'
    : '[b2]gblur=sigma=' + fmt(glow.radius) + '[gl];[b1][gl]blend=all_mode=screen:all_opacity=' + fmt(glow.opacity) + '[vout]';
  return {
    chain: head.join(','),
    complex: `${base}${splitTail}`,
    needsAudioTempo: retime && Math.abs((retime.speed ?? 1) - 1) > 1e-3 ? retime.speed : null,
  };
}

/** 编码参数：mp4(h264/aac) 与 webm(vp9/opus)。 */
function codecArgs(format) {
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '96k'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
}

export function buildArgs({ input, output, start = 0, duration = 0, graph, format = 'mp4', speed = null, hasAudio = true }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (start > 0) args.push('-ss', fmt(start));
  args.push('-i', input);
  if (duration > 0) args.push('-t', fmt(duration));

  if (graph.complex) {
    args.push('-filter_complex', graph.complex, '-map', '[vout]');
    if (hasAudio) args.push('-map', '0:a?');
  } else {
    if (graph.chain) args.push('-vf', graph.chain);
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a?');
  }

  if (graph.needsAudioTempo && hasAudio && speed && Math.abs(speed - 1) > 1e-3) {
    // atempo 单次只吃 0.5~2，超出范围就串联
    let rest = speed;
    const parts = [];
    while (rest > 2) {
      parts.push('atempo=2');
      rest /= 2;
    }
    while (rest < 0.5) {
      parts.push('atempo=0.5');
      rest *= 2;
    }
    parts.push(`atempo=${fmt(rest)}`);
    args.push('-filter:a', parts.join(','));
  }

  args.push(...codecArgs(format));
  args.push(output);
  return args;
}

function exec(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('视频处理超时'));
    }, EXEC_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(stderr || `ffmpeg 退出码 ${code}`);
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function uniqueRel(library, folder, name, ext) {
  const prepared = await library.prepareUpload(folder, name);
  if (!prepared?.rel) throw new LibraryError('无法准备输出目录', 'PREPARE_FAILED', 500);
  return prepared;
}

function ensureExt(name, format) {
  const ext = format === 'webm' ? '.webm' : '.mp4';
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '') || 'effect';
  return `${base}${ext}`;
}

/**
 * 真正渲染：探测 → 拼参数 → 执行 → 返回产物 entry。
 * @param {import('./library.js').createLibrary} library
 */
export async function renderVideoEffects(library, body = {}) {
  const { abs, rel } = library.resolve(body.path, { allowRoot: false });
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new LibraryError('视频不存在', 'NOT_FOUND', 404);

  const meta = await probeVideo(abs);
  const effects = Array.isArray(body.effects) ? body.effects : [];
  let lutPath = null;
  if (body.lut) {
    const resolved = library.resolve(body.lut, { allowRoot: false });
    lutPath = resolved.abs;
  }
  const format = body.format === 'webm' ? 'webm' : 'mp4';
  const start = clamp(body.start, 0, Math.max(0, (meta.duration ?? 0) - 0.01), 0);
  const duration = clamp(body.duration, 0, Math.max(0, (meta.duration ?? 0) - start), 0);
  const graph = buildFilterChain(effects, { lutPath });
  if (!graph.chain && !graph.complex) throw new VideoError('没有可应用的画面效果', 'EMPTY_EFFECTS', 422);

  const speed = effects.find((effect) => effect.type === 'retime')?.speed ?? null;
  const folder = String(body.dir || '视频特效').trim() || '视频特效';
  const target = await uniqueRel(library, folder, ensureExt(body.name, format), format);
  const args = buildArgs({
    input: abs,
    output: target.abs,
    start,
    duration,
    graph,
    format,
    speed,
    hasAudio: Boolean(meta.hasAudio),
  });

  const binaries = await resolveBinaries();
  try {
    await exec(binaries.ffmpeg, args);
  } catch (err) {
    await fs.rm(target.abs, { force: true }).catch(() => {});
    throw new VideoError(`视频特效渲染失败：${(err.stderr || err.message || '').slice(-400)}`, 'RENDER_FAILED', 422);
  }

  const entry = await library.entryByRel(target.rel);
  return {
    ok: true,
    sourcePath: rel,
    format,
    effects: effects.map((effect) => effect.type),
    output: target.rel,
    entry,
    graph: { chain: graph.chain, complex: graph.complex },
  };
}

export function createEffectsRouter(library, { jobs } = {}) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '2mb' });
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.use((req, res, next) => {
    library.init().then(() => next(), next);
  });

  router.get(
    '/health',
    wrap(async (_req, res) => {
      res.json({
        ok: true,
        service: 'image-clip-effects',
        ffmpeg: await ffmpegStatus(),
        types: EFFECT_TYPES,
        specs: EFFECT_SPECS,
        formats: ['mp4', 'webm'],
      });
    }),
  );

  router.post(
    '/render',
    jsonBody,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const background = body.background !== false;
      if (background && jobs) {
        const job = jobs.run(
          {
            type: 'video-effects',
            label: `视频特效 · ${path.basename(String(body.path ?? 'video'))}`,
            meta: { path: body.path, effects: (body.effects ?? []).map((effect) => effect.type) },
            userId: req.user?.id ?? null,
          },
          async (ctx) => {
            ctx.log('开始渲染特效', { effects: body.effects?.length ?? 0 });
            const payload = await renderVideoEffects(library, body);
            ctx.progress(1, '渲染完成');
            ctx.log('特效渲染完成', { output: payload.output });
            return payload;
          },
        );
        res.status(202).json({ ok: true, background: true, job });
        return;
      }
      res.json(await renderVideoEffects(library, body));
    }),
  );

  return router;
}
