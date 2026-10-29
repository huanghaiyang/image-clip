/**
 * FFmpeg 集成层
 * -------------
 * 视频工作区的所有能力（探测元信息、截取关键帧、提取音频、生成时间轴缩略图）
 * 都通过这里调用本机 FFmpeg。设计要点：
 *
 *  1. **可配置定位**：优先读 `FFMPEG_PATH` / `FFPROBE_PATH` / `FFMPEG_DIR`，
 *     然后依次查找 `D:\thirdparty\ffmpeg\bin`（本项目约定的三方软件目录）、
 *     `models/ffmpeg/bin` 和几个常见安装位置，最后才回退到 PATH 里的 `ffmpeg`。
 *     这样开发机、CI 和打包环境都不需要改代码。
 *  2. **失败可诊断**：任何一个二进制缺失都会返回明确的中文提示，
 *     `/api/health` 与 `/api/video/health` 会把搜索过的路径一起返回。
 *  3. **按帧精确**：单帧截取使用 `-ss <时间> -i <输入>`，FFmpeg 会先定位到关键帧
 *     再解码到目标时间，比把 `-ss` 放在输入之后更准确，且速度更快。
 *  4. **缓存**：时间轴缩略图按「路径 + mtime + 数量 + 宽度」做哈希缓存，
 *     同一个视频来回切换不会反复跑 FFmpeg。
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const IS_WIN = process.platform === 'win32';
const FFMPEG_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
const FFPROBE_NAME = IS_WIN ? 'ffprobe.exe' : 'ffprobe';

/** 按优先级排列的 FFmpeg 搜索目录；可在 .env / 启动命令里通过环境变量覆盖。 */
const SEARCH_DIRS = [
  process.env.FFMPEG_DIR,
  path.join(ROOT, 'models/ffmpeg/bin'),
  path.join(ROOT, 'models/ffmpeg'),
  'D:/thirdparty/ffmpeg/bin',
  'D:/thirdparty/ffmpeg',
  'C:/ffmpeg/bin',
  'C:/Program Files/ffmpeg/bin',
  'C:/ProgramData/chocolatey/bin',
].filter(Boolean);

const EXEC_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 10 * 60 * 1000);

export class VideoError extends Error {
  constructor(message, code = 'VIDEO_ERROR', status = 400) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
    this.status = status;
  }
}

let cachedBinaries = null;
let cachedVersion = null;

/** 返回 { ffmpeg, ffprobe, searched, source }；找不到时 ffmpeg 为 null，不抛异常。 */
export async function resolveBinaries({ refresh = false } = {}) {
  if (cachedBinaries && !refresh) return cachedBinaries;

  const searched = [];

  // 1) 显式环境变量
  if (process.env.FFMPEG_PATH) {
    searched.push(process.env.FFMPEG_PATH);
    if (await isExecutable(process.env.FFMPEG_PATH)) {
      const ffprobe =
        (process.env.FFPROBE_PATH && (await isExecutable(process.env.FFPROBE_PATH)) && process.env.FFPROBE_PATH) ||
        path.join(path.dirname(process.env.FFMPEG_PATH), FFPROBE_NAME);
      cachedBinaries = {
        ffmpeg: process.env.FFMPEG_PATH,
        ffprobe: (await isExecutable(ffprobe)) ? ffprobe : null,
        searched,
        source: 'env:FFMPEG_PATH',
      };
      return cachedBinaries;
    }
  }

  // 2) 约定目录
  for (const dir of SEARCH_DIRS) {
    const ffmpeg = path.join(dir, FFMPEG_NAME);
    if (!searched.includes(ffmpeg)) searched.push(ffmpeg);
    if (await isExecutable(ffmpeg)) {
      const ffprobe = path.join(dir, FFPROBE_NAME);
      if (await isExecutable(ffprobe)) {
        cachedBinaries = { ffmpeg, ffprobe, searched, source: dir };
        return cachedBinaries;
      }
      cachedBinaries = { ffmpeg, ffprobe: null, searched, source: dir };
      return cachedBinaries;
    }
  }

  // 3) PATH（spawn 时由系统解析）
  if (await commandWorks('ffmpeg')) {
    const ffprobeOk = await commandWorks('ffprobe');
    cachedBinaries = { ffmpeg: 'ffmpeg', ffprobe: ffprobeOk ? 'ffprobe' : null, searched, source: 'PATH' };
    return cachedBinaries;
  }

  cachedBinaries = { ffmpeg: null, ffprobe: null, searched, source: null };
  return cachedBinaries;
}

/** `/api/health`、`/api/video/health` 共用；版本只取一次。 */
export async function ffmpegStatus({ refresh = false } = {}) {
  const binaries = await resolveBinaries({ refresh });
  if (!binaries.ffmpeg) {
    return {
      available: false,
      ffmpeg: null,
      ffprobe: null,
      version: null,
      searched: binaries.searched,
      hint: '未找到 FFmpeg。请把 FFmpeg 解压到 D:\\thirdparty\\ffmpeg（bin 目录下包含 ffmpeg.exe 与 ffprobe.exe），或设置环境变量 FFMPEG_PATH。',
    };
  }

  if (!cachedVersion || refresh) {
    try {
      const { stdout } = await exec(binaries.ffmpeg, ['-version'], { timeout: 15000 });
      cachedVersion = String(stdout).split(/\r?\n/)[0].trim();
    } catch (err) {
      return {
        available: false,
        ffmpeg: binaries.ffmpeg,
        ffprobe: binaries.ffprobe,
        version: null,
        searched: binaries.searched,
        hint: `FFmpeg 存在但无法执行：${err.message}`,
      };
    }
  }

  return {
    available: true,
    ffmpeg: binaries.ffmpeg,
    ffprobe: binaries.ffprobe,
    version: cachedVersion,
    source: binaries.source,
    searched: binaries.searched,
  };
}

/**
 * 读取视频/音频元信息。
 * @param {string} file 绝对路径
 * @returns {Promise<{duration:number,width:number,height:number,fps:number,rotation:number,codec:string,bitrate:number,hasAudio:boolean,audioCodec:string|null,format:string,size:number}>}
 */
export async function probeVideo(file) {
  const binaries = await requireBinaries();
  if (!binaries.ffprobe) {
    throw new VideoError(
      '缺少 ffprobe，无法读取视频元信息。请确认 D:\\thirdparty\\ffmpeg\\bin\\ffprobe.exe 存在。',
      'FFPROBE_MISSING',
      503,
    );
  }

  let stdout;
  try {
    ({ stdout } = await exec(
      binaries.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (err) {
    throw new VideoError(`读取视频信息失败：${tail(err.stderr || err.message)}`, 'PROBE_FAILED', 422);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new VideoError('ffprobe 返回了无法解析的 JSON', 'PROBE_BAD_JSON', 500);
  }

  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const format = info.format ?? {};
  const stat = await fs.stat(file).catch(() => null);

  const duration = firstFinite([format.duration, video?.duration, audio?.duration], 0);
  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate) || 0;
  const rotation = readRotation(video);

  return {
    duration,
    width: Math.round(firstFinite([video?.width, 0], 0)),
    height: Math.round(firstFinite([video?.height, 0], 0)),
    fps,
    rotation,
    codec: video?.codec_name ?? null,
    profile: video?.profile ?? null,
    bitrate: Math.round(firstFinite([format.bit_rate, video?.bit_rate, 0], 0)),
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    format: format.format_name ?? null,
    size: stat?.size ?? 0,
    mtimeMs: stat?.mtimeMs ?? 0,
  };
}

/**
 * 截取单帧到 output。
 * @param {string} input
 * @param {number} time 秒
 * @param {string} output 绝对路径（扩展名决定编码：png/jpg/webp）
 * @param {{width?:number, quality?:number}} [options]
 */
export async function extractFrame(input, time, output, options = {}) {
  const binaries = await requireBinaries();
  await fs.mkdir(path.dirname(output), { recursive: true });

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const t = Number.isFinite(Number(time)) ? Math.max(0, Number(time)) : 0;
  args.push('-ss', t.toFixed(3), '-i', input, '-frames:v', '1');

  const width = Math.round(Number(options.width) || 0);
  if (width > 0) args.push('-vf', `scale=${Math.max(2, width)}:-2`);

  const ext = path.extname(output).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    args.push('-q:v', String(Math.min(31, Math.max(1, Number(options.quality) || 2))));
  }

  args.push(output);

  try {
    await exec(binaries.ffmpeg, args, { timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    await fs.rm(output, { force: true }).catch(() => {});
    throw new VideoError(`截取第 ${t.toFixed(2)}s 画面失败：${tail(err.stderr || err.message)}`, 'FRAME_FAILED', 422);
  }
  return output;
}

/**
 * 批量截取关键帧（顺序执行，避免同时开太多 FFmpeg 进程把 CPU 打满）。
 *
 * @param {{input:string,times:number[],outputDir:string,prefix:string,format?:'png'|'jpg'|'webp',width?:number,pad?:number,onProgress?:(done:number,total:number)=>void}} options
 * @returns {Promise<{files:{path:string,time:number,name:string}[], errors:{time:number,message:string}[]}>}
 */
export async function extractFrames(options) {
  const times = (options.times ?? []).map((t) => Math.max(0, Number(t) || 0));
  if (!times.length) throw new VideoError('没有需要截取的时间点', 'NO_TIMES');
  if (times.length > 120) throw new VideoError('单次最多截取 120 帧', 'TOO_MANY_FRAMES', 413);

  const format = normalizeImageFormat(options.format);
  const prefix = sanitizePrefix(options.prefix || 'frame');
  const pad = Math.max(2, Math.min(6, Math.round(Number(options.pad) || 3)));
  await fs.mkdir(options.outputDir, { recursive: true });

  const files = [];
  const errors = [];
  for (let i = 0; i < times.length; i += 1) {
    const name = `${prefix}-${String(i + 1).padStart(pad, '0')}.${format}`;
    const output = await uniquePath(path.join(options.outputDir, name));
    try {
      await extractFrame(options.input, times[i], output, { width: options.width });
      files.push({ path: output, time: times[i], name: path.basename(output) });
    } catch (err) {
      errors.push({ time: times[i], message: err.message });
    }
    options.onProgress?.(i + 1, times.length);
  }

  if (!files.length) {
    throw new VideoError(errors[0]?.message || '所有帧都截取失败', 'FRAME_BATCH_FAILED', 422);
  }
  return { files, errors };
}

/**
 * 提取音轨。
 * @param {{input:string,output:string,format?:'mp3'|'m4a'|'wav'|'flac'}} options
 */
export async function extractAudio({ input, output, format = 'mp3' }) {
  const binaries = await requireBinaries();
  const meta = await probeVideo(input);
  if (!meta.hasAudio) throw new VideoError('该视频没有音轨，无法提取音频', 'AUDIO_MISSING', 422);

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-vn'];
  switch (String(format).toLowerCase()) {
    case 'wav':
      args.push('-c:a', 'pcm_s16le');
      break;
    case 'flac':
      args.push('-c:a', 'flac');
      break;
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
      break;
    case 'mp3':
    default:
      args.push('-c:a', 'libmp3lame', '-q:a', '2');
      break;
  }
  args.push(output);

  await fs.mkdir(path.dirname(output), { recursive: true });
  try {
    await exec(binaries.ffmpeg, args, { timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    await fs.rm(output, { force: true }).catch(() => {});
    throw new VideoError(`提取音频失败：${tail(err.stderr || err.message)}`, 'AUDIO_FAILED', 422);
  }
  return { output, format: String(format).toLowerCase() };
}

const filmstripCache = new Map();

/**
 * 生成“完整时间轴”所需的胶片缩略图。
 *
 * 利用 `fps = count / duration` 让 FFmpeg 在整段视频上均匀抽帧，
 * 再用 `tile` 之外的逐帧读取交给前端拼成时间轴；返回 dataURL 数组，
 * 前端不用再发 N 个请求。
 */
export async function filmstrip({ input, duration, count = 16, width = 160, cacheDir }) {
  const binaries = await requireBinaries();
  const meta = await probeVideo(input);
  const total = Math.max(4, Math.min(48, Math.round(Number(count) || 16)));
  const thumbWidth = Math.max(48, Math.min(480, Math.round(Number(width) || 160)));
  const seconds = Math.max(Number(duration) || meta.duration || 0, 0.1);

  const stat = await fs.stat(input).catch(() => ({ mtimeMs: 0, size: 0 }));
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(input)}|${stat.mtimeMs}|${stat.size}|${total}|${thumbWidth}`)
    .digest('hex')
    .slice(0, 20);

  const cached = filmstripCache.get(key);
  if (cached) return cached;

  const dir = path.join(cacheDir || path.join(ROOT, 'data/cache/filmstrip'), key);
  await fs.mkdir(dir, { recursive: true });

  let names = await listFiles(dir);
  if (!names.length) {
    const fps = Math.min(30, Math.max(0.01, total / seconds));
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-vf',
      `fps=${fps.toFixed(6)},scale=${thumbWidth}:-2`,
      '-frames:v',
      String(total),
      '-q:v',
      '5',
      path.join(dir, 'frame-%03d.jpg'),
    ];
    try {
      await exec(binaries.ffmpeg, args, { timeout: EXEC_TIMEOUT_MS });
    } catch (err) {
      throw new VideoError(`生成时间轴缩略图失败：${tail(err.stderr || err.message)}`, 'FILMSTRIP_FAILED', 422);
    }
    names = await listFiles(dir);
  }

  const step = names.length ? seconds / names.length : 0;
  const frames = [];
  for (let i = 0; i < names.length; i += 1) {
    const buffer = await fs.readFile(path.join(dir, names[i]));
    frames.push({
      time: Math.min(seconds, i * step),
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    });
  }

  const payload = { frames, count: frames.length, width: thumbWidth, duration: seconds, cached: Boolean(cached) };
  filmstripCache.set(key, payload);
  return payload;
}

/** 视频抽帧生成资源库封面（JPEG），返回输出路径。 */
export async function makeVideoPoster(input, output, meta) {
  const t = Math.min(1, Math.max(0, (meta?.duration || 0) / 2));
  await extractFrame(input, t, output, { width: 480, quality: 3 });
  return output;
}

// ---------------------------------------------------------------- 内部工具

async function requireBinaries() {
  const bins = await resolveBinaries();
  if (!bins.ffmpeg) {
    throw new VideoError(
      '未找到 FFmpeg。请把 FFmpeg 解压到 D:\\thirdparty\\ffmpeg（确保 bin\\ffmpeg.exe 与 bin\\ffprobe.exe 存在），或设置 FFMPEG_PATH 环境变量。',
      'FFMPEG_MISSING',
      503,
    );
  }
  return bins;
}

function normalizeImageFormat(format) {
  const value = String(format || 'png').toLowerCase();
  if (value === 'jpg' || value === 'jpeg') return 'jpg';
  if (value === 'webp') return 'webp';
  return 'png';
}

/** 去掉文件名里的路径分隔符与非法字符，保留中文、空格、括号。 */
export function sanitizePrefix(prefix) {
  return (
    String(prefix ?? '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/^\.+$/, '')
      .trim()
      .slice(0, 80) || 'frame'
  );
}

async function uniquePath(target) {
  let file = target;
  let index = 1;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  while (await exists(file)) {
    file = `${base}-${index}${ext}`;
    index += 1;
  }
  return file;
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
}

function readRotation(video) {
  if (!video) return 0;
  const side = Array.isArray(video.side_data_list) ? video.side_data_list : [];
  const rotation = side.find((item) => item.rotation !== undefined)?.rotation;
  if (Number.isFinite(Number(rotation))) return Math.round(Number(rotation));
  const tag = video.tags?.rotate;
  if (Number.isFinite(Number(tag))) return Math.round(Number(tag));
  return 0;
}

function parseRate(rate) {
  if (!rate) return 0;
  const [num, den] = String(rate).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return Math.round((num / den) * 100) / 100;
}

function firstFinite(values, fallback = 0) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function tail(text, limit = 500) {
  const value = String(text ?? '').trim();
  if (!value) return '未知错误';
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(file) {
  if (!file) return false;
  try {
    await fs.access(file, process.platform === 'win32' ? FS_CONSTANTS.F_OK : FS_CONSTANTS.X_OK);
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function commandWorks(command) {
  try {
    await exec(command, ['-version'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeout ?? 30000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
