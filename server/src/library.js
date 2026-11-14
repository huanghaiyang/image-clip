/**
 * 资源库（Library）
 * -----------------
 * 把 `data/library` 目录当作一个真实的文件系统来管理：子目录就是文件夹，
 * 图片/视频/音频就是文件。这样做的好处是用户随时可以在资源管理器里
 * 往目录里丢素材，刷新页面就能看到；导出结果也直接落到磁盘，不会被浏览器清缓存清掉。
 *
 * 目录约定（都相对于资源库根目录）：
 *   - `视频/`            从外部导入的视频
 *   - `关键帧/<视频名>/` 视频工作区默认的关键帧输出位置
 *   - `裁剪结果/`        批量/单张裁剪结果
 *   - `抠图结果/`        背景去除、橡皮擦结果
 *
 * API 见 `createLibraryRouter()` 顶部注释。所有路径参数都经过 `resolve()`
 * 的穿越校验，任何 `..`、绝对路径、盘符都会被拒绝。
 *
 * 元数据缓存：
 *   图片尺寸用 sharp 读，视频时长用 ffprobe 读，两者都可能比较慢，
 *   因此按「相对路径 + mtime + size」缓存在 `.library-meta.json`。
 *   文件被外部替换后 mtime 变化，会自动重新探测。
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { VideoError, makeVideoPoster, probeVideo } from './ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpg', '.mpeg', '.ogv', '.ts']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);

const META_FILE = '.library-meta.json';
/** 回收站与历史版本都放在资源库内的隐藏目录：scan() 会跳过以 . 开头的目录，不会出现在列表里。 */
const TRASH_DIR = '.trash';
const VERSIONS_DIR = '.versions';
const MAX_VERSIONS_PER_FILE = 30;
const MAX_UPLOAD_BYTES = Number(process.env.IMAGE_CLIP_MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024 * 1024);
const MAX_FILES = Number(process.env.IMAGE_CLIP_LIBRARY_MAX_FILES ?? 20000);

/**
 * @param {{root?:string, thumbnailRoot?:string, cacheRoot?:string}} [options]
 */
export function createLibrary(options = {}) {
  const root = path.resolve(options.root ?? process.env.IMAGE_CLIP_LIBRARY_DIR ?? path.join(ROOT_DIR, 'data/library'));
  const thumbnailRoot = path.resolve(
    options.thumbnailRoot ?? process.env.IMAGE_CLIP_THUMB_DIR ?? path.join(ROOT_DIR, 'data/library-thumbs'),
  );
  const cacheRoot = path.resolve(options.cacheRoot ?? path.join(ROOT_DIR, 'data/cache'));

  let meta = null;
  let metaDirty = false;
  let metaTimer = null;
  let sharpModule = null;
  const scanPromises = { light: null, full: null };
  /**
   * 扫描结果短缓存。
   *
   * 资源库是本地目录，一次 light 扫描要为每个文件做 stat（Windows 上 1000+ 文件要几百毫秒），
   * 而前端在启动、切换工作区、保存后刷新时会连续请求 tree/list。这里把整轮扫描结果缓存
   * 一小段时间（TTL 内直接复用），并在任何写操作后立刻失效，避免重复扫盘。
   * 外部直接往目录里拷文件时最多滞后 SCAN_TTL_MS；前端「刷新」会带 refresh=1 强制重扫。
   */
  const scanCache = { light: null, full: null };
  const SCAN_TTL_MS = 1500;
  let scanVersion = 0;
  /** 扫描时 fs.stat 的并发度：Windows 上单线程串行 stat 是主瓶颈。 */
  const STAT_CONCURRENCY = 16;
  let initPromise = null;

  async function init() {
    if (!initPromise) {
      initPromise = (async () => {
        await fs.mkdir(root, { recursive: true });
        await fs.mkdir(thumbnailRoot, { recursive: true });
        await loadMeta();
        return api;
      })();
    }
    return initPromise;
  }

  async function loadMeta() {
    if (meta) return meta;
    try {
      const text = await fs.readFile(path.join(root, META_FILE), 'utf8');
      const parsed = JSON.parse(text);
      meta = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      meta = {};
    }
    return meta;
  }

  function scheduleMetaSave() {
    metaDirty = true;
    if (metaTimer) return;
    metaTimer = setTimeout(async () => {
      metaTimer = null;
      if (!metaDirty || !meta) return;
      metaDirty = false;
      try {
        await fs.writeFile(path.join(root, META_FILE), JSON.stringify(meta), 'utf8');
      } catch (err) {
        console.warn('[library] 写入元数据失败:', err.message);
      }
    }, 800);
    metaTimer.unref?.();
  }

  /** 相对路径 → 绝对路径；拒绝任何越出资源库根目录的写法。 */
  function resolve(rel, { allowRoot = true } = {}) {
    const raw = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (raw.split('/').some((part) => part === '..')) {
      throw new LibraryError('路径不合法：不允许 ..', 'BAD_PATH', 400);
    }
    const abs = path.resolve(root, raw);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new LibraryError('路径不合法：超出资源库范围', 'BAD_PATH', 400);
    }
    if (!allowRoot && abs === root) throw new LibraryError('该操作不能针对资源库根目录', 'BAD_PATH', 400);
    return { abs, rel: toRel(abs) };
  }

  function toRel(abs) {
    return path.relative(root, abs).split(path.sep).join('/');
  }

  /** 把用户输入的文件名清洗成 Windows 也合法的名字，保留中文与扩展名。 */
  function sanitizeName(input) {
    let name = String(input ?? '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .trim()
      .replace(/[. ]+$/g, '');
    if (!name || name === '.' || name === '..') {
      throw new LibraryError('文件名不合法', 'BAD_NAME', 400);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
    const ext = path.extname(name);
    if (name.length > 180) {
      const base = name.slice(0, name.length - ext.length).slice(0, 180 - ext.length);
      name = `${base}${ext}`;
    }
    return name;
  }

  async function uniqueTarget(dirAbs, name, ignoreAbs = new Set()) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    let index = 1;
    while (true) {
      const abs = path.join(dirAbs, candidate);
      const normalized = path.resolve(abs);
      if (!ignoreAbs.has(normalized) && !(await exists(abs))) return { abs, name: candidate };
      index += 1;
      candidate = `${base} (${index})${ext}`;
      if (index > 9999) throw new LibraryError('同名文件过多，无法生成唯一文件名', 'NAME_COLLISION', 409);
    }
  }

  function classify(name) {
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', ext };
    if (VIDEO_EXTENSIONS.has(ext)) return { kind: 'video', ext };
    if (AUDIO_EXTENSIONS.has(ext)) return { kind: 'audio', ext };
    return { kind: 'file', ext };
  }

  async function getSharp() {
    if (sharpModule) return sharpModule;
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpModule = null;
    }
    return sharpModule;
  }

  /**
   * 扫描整个资源库。
   * 返回扁平的 entries + folders，由前端拼成树（这样搜索、跨目录批量操作都简单）。
   * light=true 时只读目录与 stat，不解析图片尺寸/视频时长，用于首屏索引与统计；
   * 单个文件的尺寸等元数据由 describePath 按需补齐。
   * @param {{light?:boolean, force?:boolean}} [options]
   *   force=true 时跳过短缓存，强制重新扫盘（用户点「刷新」时用）。
   */
  async function scan({ light = false, force = false } = {}) {
    const cacheKey = light ? 'light' : 'full';
    const cached = scanCache[cacheKey];
    if (!force && cached && cached.version === scanVersion && Date.now() - cached.at < SCAN_TTL_MS) {
      return cached.data;
    }
    if (scanPromises[cacheKey]) return scanPromises[cacheKey];

    // 记下开始时的版本号：扫描过程中若发生写操作，结果不会被当成新数据缓存
    const versionAtStart = scanVersion;
    scanPromises[cacheKey] = (async () => {
      await loadMeta();
      const folders = [];
      const fileQueue = [];
      let truncated = false;

      /** 先只收集文件清单（readdir 的 dirent 不带 size/mtime），stat 统一并发做。 */
      async function walk(dirAbs, depth) {
        const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
        dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        const subdirs = [];
        for (const dirent of dirents) {
          if (dirent.name.startsWith('.')) continue;
          const abs = path.join(dirAbs, dirent.name);
          if (dirent.isDirectory()) {
            folders.push({ path: toRel(abs), name: dirent.name, parent: toRel(dirAbs), depth });
            subdirs.push(abs);
          } else if (dirent.isFile()) {
            if (fileQueue.length >= MAX_FILES) {
              truncated = true;
              continue;
            }
            fileQueue.push({ abs, name: dirent.name });
          }
        }
        // 目录递归保持顺序（结构简单），文件 stat 的并发留给下一步
        for (const abs of subdirs) await walk(abs, depth + 1);
      }

      await walk(root, 0);

      const statList = await mapLimit(fileQueue, STAT_CONCURRENCY, async (record) => {
        const stat = await fs.stat(record.abs).catch(() => null);
        return stat ? { abs: record.abs, rel: toRel(record.abs), name: record.name, stat } : null;
      });
      const fileRecords = statList.filter(Boolean);

      const entries = light
        ? fileRecords.map((record) => basicEntry(record))
        : await mapLimit(fileRecords, 6, (record) => describeEntry(record));
      const stats = {
        files: entries.length,
        folders: folders.length,
        images: entries.filter((e) => e.kind === 'image').length,
        videos: entries.filter((e) => e.kind === 'video').length,
        audios: entries.filter((e) => e.kind === 'audio').length,
        bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
        truncated,
      };

      const data = {
        root: '',
        folders: folders.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN')),
        entries,
        stats,
      };
      scanCache[cacheKey] = { at: Date.now(), version: versionAtStart, data };
      return data;
    })()
      .catch((err) => {
        throw err;
      })
      .finally(() => {
        scanPromises[cacheKey] = null;
      });
    return scanPromises[cacheKey];
  }

  /** 任何写操作后调用：让下一次扫描（以及 HTTP 304 判断）立刻反映磁盘现状。 */
  function invalidateScan() {
    scanVersion += 1;
    scanCache.light = null;
    scanCache.full = null;
  }

  /** 只含 stat 信息的条目：不读图片/视频内容，供目录列表与轻量索引使用。 */
  function basicEntry({ rel, name, stat }) {
    const { kind, ext } = classify(name);
    return {
      path: rel,
      name,
      dir: posixDir(rel),
      kind,
      ext,
      bytes: stat.size,
      mtime: Math.round(stat.mtimeMs),
      url: `/api/library/file?path=${encodeURIComponent(rel)}`,
      thumbUrl: kind === 'image' || kind === 'video' || kind === 'audio'
        ? `/api/library/thumb?path=${encodeURIComponent(rel)}&v=${Math.round(stat.mtimeMs)}`
        : null,
    };
  }

  async function describeEntry({ abs, rel, name, stat }) {
    const base = basicEntry({ rel, name, stat });
    const cached = meta[rel];
    if (cached && cached.size === stat.size && cached.mtime === Math.round(stat.mtimeMs)) {
      return { ...base, ...cached.meta };
    }

    const info = {};
    if (base.kind === 'image') {
      const sharp = await getSharp();
      if (sharp) {
        try {
          // 重要：不要把磁盘路径直接交给 sharp。libvips 会为“按路径打开”的图片一直
          // 持有文件句柄，Windows 上表现为后续 rename / unlink 报 EBUSY（改名、删除、
          // 移动全部失败）。先读成 Buffer 再解析，readFile 结束句柄立刻释放。
          // 超过 64MB 的图片跳过尺寸探测，避免扫描时6路并发读造成内存峰值。
          if (stat.size <= 64 * 1024 * 1024) {
            const buffer = await fs.readFile(abs);
            const metaInfo = await sharp(buffer, { animated: false }).metadata();
            info.width = metaInfo.width ?? null;
            info.height = metaInfo.height ?? null;
            info.format = metaInfo.format ?? null;
            if (typeof metaInfo.pages === 'number' && metaInfo.pages > 1) info.pages = metaInfo.pages;
          }
        } catch {
          /* 损坏的图片仍然允许在列表中出现 */
        }
      }
    } else if (base.kind === 'video' || base.kind === 'audio') {
      try {
        const probe = await probeVideo(abs);
        Object.assign(info, {
          width: probe.width || null,
          height: probe.height || null,
          duration: probe.duration || null,
          fps: probe.fps || null,
          hasAudio: probe.hasAudio,
          codec: probe.codec || null,
          audioCodec: probe.audioCodec || null,
        });
      } catch {
        /* ffmpeg 未安装或文件损坏时，列表仍可用 */
      }
    }

    meta[rel] = { size: stat.size, mtime: Math.round(stat.mtimeMs), meta: info };
    scheduleMetaSave();
    return { ...base, ...info };
  }

  const FOLDER_PREVIEW_LIMIT = 4;
  /** 直接子项里没有图片/视频时继续往子目录找，但限制层数与目录数，避免大目录拖慢列表。 */
  const FOLDER_PREVIEW_MAX_DEPTH = 2;
  const FOLDER_PREVIEW_MAX_DIRS = 12;

  /** 读取文件夹内最多 4 个图片 / 视频，供文件夹卡片拼缩略图。 */
  async function peekFolderPreview(absDir, limit = FOLDER_PREVIEW_LIMIT) {
    const previews = [];
    const queue = [{ abs: absDir, depth: 0 }];
    let visited = 0;
    while (queue.length && previews.length < limit && visited < FOLDER_PREVIEW_MAX_DIRS) {
      const { abs, depth } = queue.shift();
      visited += 1;
      const dirents = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        if (dirent.isDirectory()) {
          if (depth < FOLDER_PREVIEW_MAX_DEPTH) {
            queue.push({ abs: path.join(abs, dirent.name), depth: depth + 1 });
          }
          continue;
        }
        if (!dirent.isFile() || previews.length >= limit) continue;
        const { kind } = classify(dirent.name);
        // 音频没有缩略图，跳过
        if (kind !== 'image' && kind !== 'video') continue;
        const fileAbs = path.join(abs, dirent.name);
        const stat = await fs.stat(fileAbs).catch(() => null);
        if (!stat) continue;
        const rel = toRel(fileAbs);
        previews.push({
          path: rel,
          name: dirent.name,
          kind,
          thumbUrl: `/api/library/thumb?path=${encodeURIComponent(rel)}&v=${Math.round(stat.mtimeMs)}`,
        });
      }
    }
    return previews;
  }

  /**
   * 只列一个目录的直接子项（文件夹 + 文件），不递归、不解析元数据。
   * 前端进入目录时调用，避免为了一个目录读取整个资源库。
   * 文件夹会附带最多 4 个图片/视频缩略图，用于列表卡片预览。
   */
  async function listDirectory(dirRel = '') {
    const { abs: dirAbs, rel: dir } = resolve(dirRel || '');
    const stat = await fs.stat(dirAbs).catch(() => null);
    if (!stat?.isDirectory()) throw new LibraryError('目录不存在', 'NOT_FOUND', 404);

    const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const folderRecords = [];
    const fileRecords = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, dirent.name);
      if (dirent.isDirectory()) {
        folderRecords.push({ abs, rel: toRel(abs), name: dirent.name });
      } else if (dirent.isFile()) {
        fileRecords.push({ abs, name: dirent.name });
      }
    }

    // stat 并发做：目录里几百个文件时，串行 stat 会把列表拖到几百毫秒
    const fileEntries = await mapLimit(fileRecords, STAT_CONCURRENCY, async (record) => {
      const fileStat = await fs.stat(record.abs).catch(() => null);
      return fileStat ? basicEntry({ rel: toRel(record.abs), name: record.name, stat: fileStat }) : null;
    });
    const entries = [];
    for (const entry of fileEntries) if (entry) entries.push(entry);
    const folders = await mapLimit(folderRecords, 8, async (folder) => ({
      path: folder.rel,
      name: folder.name,
      parent: dir,
      depth: relDepth(folder.rel) - 1,
      previews: await peekFolderPreview(folder.abs),
    }));
    return { dir, folders, entries };
  }

  /** 按需解析单个文件的元数据（尺寸 / 时长等），结果写入 meta 缓存。 */
  async function describePath(rel) {
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new LibraryError('文件不存在', 'NOT_FOUND', 404);
    const entry = await describeEntry({ abs, rel: relPath, name: path.basename(abs), stat });
    const { url, thumbUrl, path: entryPath, name, dir, kind, ext, bytes, mtime, ...info } = entry;
    return { path: entryPath, ...info };
  }

  /**
   * 在系统文件管理器中打开资源库路径：
   * 文件 → 定位并选中；文件夹 / 根目录 → 直接打开。
   * 只在服务端本机执行，路径仍走 resolve() 的穿越校验。
   */
  async function reveal(rel = '') {
    const { abs } = resolve(rel || '');
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new LibraryError('路径不存在', 'NOT_FOUND', 404);

    const detached = { detached: true, stdio: 'ignore' };
    let opened = abs;
    let selected = false;
    if (process.platform === 'win32') {
      selected = stat.isFile();
      spawn('explorer.exe', selected ? [`/select,${abs}`] : [abs], detached).unref();
    } else if (process.platform === 'darwin') {
      selected = stat.isFile();
      spawn('open', selected ? ['-R', abs] : [abs], detached).unref();
    } else {
      // Linux 无法可靠地“选中文件”，退化为打开所在目录
      opened = stat.isDirectory() ? abs : path.dirname(abs);
      spawn('xdg-open', [opened], detached).unref();
    }
    return { opened, selected };
  }

  /** 上传前准备目标路径（带唯一化），返回绝对/相对路径。 */
  async function prepareUpload(dirRel, fileName) {
    const targetDir = resolve(dirRel || '').abs;
    await fs.mkdir(targetDir, { recursive: true });
    const name = sanitizeName(fileName || `upload-${Date.now()}.bin`);
    const { abs, name: finalName } = await uniqueTarget(targetDir, name);
    return { abs, rel: toRel(abs), dir: toRel(targetDir), name: finalName };
  }

  /** 覆盖上传：目标路径已存在时先留历史版本，再写入新内容。 */
  async function prepareOverwrite(rel) {
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (stat?.isDirectory()) throw new LibraryError('目标路径是一个文件夹，不能覆盖', 'BAD_PATH', 400);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    return { abs, rel: relPath, dir: posixDir(relPath), name: path.basename(abs), existing: Boolean(stat) };
  }

  async function mkdir(dirRel, name) {
    invalidateScan();
    const base = resolve(dirRel || '').abs;
    const clean = sanitizeName(name);
    const abs = path.join(base, clean);
    if (await exists(abs)) throw new LibraryError('同名文件夹已存在', 'EXISTS', 409);
    await fs.mkdir(abs, { recursive: false });
    const rel = toRel(abs);
    return { path: rel, name: clean, parent: toRel(base), depth: rel.split('/').length - 1 };
  }

  async function entryByRel(rel) {
    await loadMeta();
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new LibraryError('文件不存在', 'NOT_FOUND', 404);
    return describeEntry({ abs, rel: relPath, name: path.basename(abs), stat });
  }

  /**
   * 缩略图：按「路径 + mtime + 尺寸 + 宽度」缓存成 webp。
   *
   * 前端不同位置需要的尺寸差很多（网格卡片 ~132px、树/文件夹小图 ~32px），
   * 统一按 480px 生成既慢又费流量，所以支持 `w` 参数：
   *  - 宽度夹到 [64, 480]，默认 320（卡片在 2× 屏上也够清晰）；
   *  - 宽度参与缓存键，换尺寸不会串图；
   *  - 同一张图并发请求会复用同一个生成任务，生成并发限制在 4 个以内。
   */
  const THUMB_CONCURRENCY = 4;
  const THUMB_DEFAULT_WIDTH = 320;
  let thumbActive = 0;
  const thumbWaiters = [];
  const thumbInflight = new Map();
  /** 视频封面生成任务（与宽度无关），避免同一视频并发跑多次 ffmpeg。 */
  const posterInflight = new Map();

  async function withThumbSlot(task) {
    if (thumbActive >= THUMB_CONCURRENCY) {
      // 等到有槽位；释放时直接把计数移交给等待者，避免新请求插队导致瞬时超限
      await new Promise((resolve) => thumbWaiters.push(resolve));
    } else {
      thumbActive += 1;
    }
    try {
      return await task();
    } finally {
      const next = thumbWaiters.shift();
      if (next) next();
      else thumbActive -= 1;
    }
  }

  async function thumbnail(rel, { width = THUMB_DEFAULT_WIDTH } = {}) {
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new LibraryError('文件不存在', 'NOT_FOUND', 404);

    const w = Math.min(480, Math.max(64, Math.round(Number(width) || THUMB_DEFAULT_WIDTH)));
    const { kind } = classify(abs);
    const hash = crypto
      .createHash('sha1')
      .update(`${relPath}|${stat.mtimeMs}|${stat.size}|w${w}`)
      .digest('hex')
      .slice(0, 24);
    const out = path.join(thumbnailRoot, `${hash}.webp`);
    if (await exists(out)) return out;
    // 同一张缩略图被多点触发（例如网格 + 文件夹预览）时只生成一次
    if (thumbInflight.has(out)) return thumbInflight.get(out);

    const sharp = await getSharp();
    if (!sharp) throw new VideoError('服务端缺少 sharp，无法生成缩略图', 'SHARP_MISSING', 503);

    const task = withThumbSlot(async () => {
      if (await exists(out)) return out;
      try {
        if (kind === 'image') {
          // 与 describeEntry 同样的原因：读 Buffer 而不是把路径交给 libvips，
          // 否则生成过缩略图的图片会被锁住，后续改名/删除报 EBUSY。
          const buffer = await fs.readFile(abs);
          await sharp(buffer, { animated: false })
            .rotate()
            .resize({ width: w, height: Math.round(w * 0.75), fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(out);
        } else if (kind === 'video') {
          // 视频封面与目标宽度无关：先按「路径+mtime+size」缓存一张 JPEG，
          // 再按需要的宽度缩成 webp —— 否则同一个视频在文件夹预览（160）和
          // 卡片（320）里会各跑一次 ffmpeg，抽帧又慢又费 CPU。
          const posterDir = path.join(cacheRoot, 'posters');
          await fs.mkdir(posterDir, { recursive: true });
          const posterHash = crypto
            .createHash('sha1')
            .update(`${relPath}|${stat.mtimeMs}|${stat.size}`)
            .digest('hex')
            .slice(0, 24);
          const poster = path.join(posterDir, `${posterHash}.jpg`);
          if (!(await exists(poster))) {
            const generating = posterInflight.get(poster);
            if (generating) {
              // 同一个视频的其他宽度请求正在抽帧，等它完成即可
              await generating;
            } else {
              const task = (async () => {
                const info = await probeVideo(abs).catch(() => null);
                // 临时文件必须以 .jpg 结尾：ffmpeg 靠扩展名推断输出格式
                const tmp = path.join(posterDir, `${posterHash}.${process.pid}-${crypto.randomBytes(3).toString('hex')}.part.jpg`);
                try {
                  await makeVideoPoster(abs, tmp, info);
                  await fs.rename(tmp, poster);
                } finally {
                  await fs.rm(tmp, { force: true }).catch(() => {});
                }
              })();
              posterInflight.set(poster, task);
              try {
                await task;
              } finally {
                posterInflight.delete(poster);
              }
            }
          }
          await sharp(await fs.readFile(poster))
            .resize({ width: w, height: Math.round(w * 0.75), fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(out);
        } else {
          throw new LibraryError('该类型暂不支持缩略图', 'NO_THUMB', 404);
        }
      } catch (err) {
        await fs.rm(out, { force: true }).catch(() => {});
        if (err instanceof VideoError || err instanceof LibraryError) throw err;
        throw new VideoError(`生成缩略图失败：${err.message}`, 'THUMB_FAILED', 422);
      }
      return out;
    }).finally(() => {
      thumbInflight.delete(out);
    });

    thumbInflight.set(out, task);
    return task;
  }

  /**
   * 批量重命名。
   * 两阶段执行：先把所有需要改名的项改成临时名，再改成目标名，
   * 这样 `a.png ↔ b.png` 的互换、`1.jpg → 2.jpg`（2 已存在但也要改名）都不会互相覆盖。
   */
  async function renameItems(items) {
    invalidateScan();
    if (!Array.isArray(items) || !items.length) throw new LibraryError('没有需要重命名的项目', 'BAD_INPUT', 400);
    if (items.length > 1000) throw new LibraryError('单次最多重命名 1000 项', 'TOO_MANY', 413);

    const prepared = [];
    for (const item of items) {
      const { abs, rel } = resolve(item?.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) {
        prepared.push({ error: '文件不存在', from: item?.path, ok: false });
        continue;
      }
      let name;
      try {
        name = sanitizeName(item?.name);
      } catch (err) {
        prepared.push({ error: err.message, from: item?.path, ok: false });
        continue;
      }
      prepared.push({
        abs,
        fromRel: rel,
        parent: path.dirname(abs),
        name,
        isDir: stat.isDirectory(),
        changed: path.basename(abs) !== name,
        ok: true,
      });
    }

    const valid = prepared.filter((p) => p.ok !== false && p.changed);
    const sourceSet = new Set(valid.map((p) => path.resolve(p.abs)));

    // 同一目录内重名 → 自动加序号
    const groups = new Map();
    for (const item of valid) {
      const key = path.dirname(item.abs);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [dirAbs, group] of groups) {
      const used = new Map();
      for (const item of group) {
        let name = item.name;
        let index = 1;
        const ext = path.extname(name);
        const base = name.slice(0, name.length - ext.length);
        while (used.has(name.toLowerCase()) || (await isForeignExisting(path.join(dirAbs, name), sourceSet))) {
          index += 1;
          name = `${base} (${index})${ext}`;
        }
        used.set(name.toLowerCase(), true);
        item.finalName = name;
      }
    }

    // 阶段 1/2：按目录深度「从深到浅」分批处理。
    // 同一深度内仍然先全部改成临时名、再改成目标名，保证互换名字不会互相覆盖；
    // 子项必须先于父文件夹完成，否则父目录改名后子文件的临时路径会失效，
    // 回滚失败时文件停在 `.rename-` 隐藏名下，在资源库里看起来就像丢失了。
    const token = crypto.randomBytes(4).toString('hex');
    const results = [];
    const depths = [...new Set(valid.map((item) => relDepth(item.fromRel)))].sort((a, b) => b - a);
    let tempIndex = 0;
    for (const depth of depths) {
      const batch = valid.filter((item) => relDepth(item.fromRel) === depth);

      // 阶段 1：源 → 临时
      for (const item of batch) {
        item.tempName = `.rename-${token}-${tempIndex++}`;
        item.tempPath = path.join(item.parent, item.tempName);
        try {
          await fs.rename(item.abs, item.tempPath);
        } catch (err) {
          item.ok = false;
          item.error = `无法重命名：${err.message}`;
          item.tempPath = null;
        }
      }

      // 阶段 2：临时 → 目标
      for (const item of batch) {
        if (!item.ok || !item.tempPath) {
          results.push({ from: item.fromRel, ok: false, error: item.error ?? '重命名失败' });
          continue;
        }
        let target = path.join(item.parent, item.finalName);
        try {
          // 目标名被意外占用（例如同名项阶段 1 失败）时改用唯一名。
          // Windows 上 rename 会直接覆盖已存在的文件，这里必须先避让，避免丢文件。
          if (await exists(target)) {
            const unique = await uniqueTarget(item.parent, item.finalName);
            target = unique.abs;
          }
          await fs.rename(item.tempPath, target);
          item.result = { from: item.fromRel, to: toRel(target), ok: true, name: path.basename(target) };
          results.push(item.result);
        } catch (err) {
          // 尽力回滚到原名，避免文件停在临时名上。
          // 原路径可能已被本批其他项占用（互换名字），此时回滚到唯一名，绝不能覆盖。
          try {
            let restore = item.abs;
            if (await exists(restore)) {
              const unique = await uniqueTarget(item.parent, path.basename(item.abs));
              restore = unique.abs;
            }
            await fs.rename(item.tempPath, restore);
            item.result = { from: item.fromRel, ok: false, error: err.message, temporary: toRel(restore), name: path.basename(restore) };
          } catch {
            /* 回滚失败时把临时路径返回给前端，方便用户手动处理 */
            item.result = { from: item.fromRel, ok: false, error: err.message, temporary: toRel(item.tempPath) };
          }
          results.push(item.result);
        }
      }
    }

    // 父文件夹也在本批改名时，子项结果里的 to 仍带旧父路径。
    // 按深度从浅到深重算文件夹的最终路径，再校正所有成功项，供前端同步选中状态
    // 以及迁移历史版本索引 / 元数据缓存使用。
    const folderFinal = new Map();
    for (const item of valid.filter((entry) => entry.ok && entry.result && entry.isDir).sort((a, b) => relDepth(a.fromRel) - relDepth(b.fromRel))) {
      const parentRel = posixDir(item.fromRel);
      const parentFinal = folderFinal.get(parentRel) ?? parentRel;
      folderFinal.set(item.fromRel, parentFinal ? `${parentFinal}/${item.result.name}` : item.result.name);
    }

    const moved = [];
    for (const item of valid) {
      const result = item.result;
      if (!item.ok || !result) continue;
      const parentRel = posixDir(item.fromRel);
      const parentFinal = folderFinal.get(parentRel) ?? parentRel;
      const to = item.isDir ? folderFinal.get(item.fromRel) ?? result.to : parentFinal ? `${parentFinal}/${result.name}` : result.name;
      result.to = to;
      if (item.fromRel !== to) moved.push({ from: item.fromRel, to });
    }

    // 整批改名完成后再迁移关联索引（文件夹会连子文件一起迁移）
    await moveVersions(moved);
    await moveMeta(moved);

    const failures = prepared.filter((p) => p.ok === false && !p.fromRel);
    for (const failure of failures) results.push({ from: failure.from, ok: false, error: failure.error });
    return results;
  }

  async function isForeignExisting(target, sourceSet) {
    const normalized = path.resolve(target);
    if (sourceSet.has(normalized)) return false; // 它本身也在本批改名队列里
    return exists(target);
  }

  /**
   * 去掉被同批祖先目录包含的路径：整体移动 / 复制文件夹时，子项会跟着父目录一起走，
   * 重复处理不仅没有意义，还会因为父目录先被搬走而报「项目不存在」。
   */
  function dropNestedPaths(paths) {
    const items = paths
      .map((rel) => resolve(rel, { allowRoot: false }))
      .sort((a, b) => a.rel.length - b.rel.length);
    const kept = [];
    for (const item of items) {
      if (kept.some((parent) => item.abs === parent.abs || item.abs.startsWith(parent.abs + path.sep))) continue;
      kept.push(item);
    }
    return kept;
  }

  /** 移动文件/文件夹到目标目录；跨盘时自动退回“复制 + 删除”。 */
  async function movePaths(paths, targetDirRel) {
    invalidateScan();
    if (!Array.isArray(paths) || !paths.length) throw new LibraryError('没有需要移动的项目', 'BAD_INPUT', 400);
    const { abs: targetDir, rel: targetRel } = resolve(targetDirRel || '');
    await fs.mkdir(targetDir, { recursive: true });
    const results = [];
    const moved = [];

    for (const { abs, rel } of dropNestedPaths(paths)) {
      try {
        if (!(await exists(abs))) throw new Error('项目不存在');
        if (path.resolve(abs) === path.resolve(targetDir)) {
          results.push({ from: rel, ok: true, to: targetRel || '', skipped: true });
          continue;
        }
        if (path.resolve(targetDir).startsWith(path.resolve(abs) + path.sep)) {
          throw new Error('不能把文件夹移动到它自己的子目录');
        }
        const name = path.basename(abs);
        const { abs: dest, name: finalName } = await uniqueTarget(targetDir, name);
        try {
          await fs.rename(abs, dest);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fs.cp(abs, dest, { recursive: true });
          await fs.rm(abs, { recursive: true, force: true });
        }
        results.push({ from: rel, ok: true, to: toRel(dest), name: finalName });
        moved.push({ from: rel, to: toRel(dest) });
      } catch (err) {
        results.push({ from: rel, ok: false, error: err.message });
      }
    }

    // 移动完成后统一迁移历史版本索引与元数据缓存（文件夹会连子文件一起迁移）
    await moveVersions(moved);
    await moveMeta(moved);
    return results;
  }

  /**
   * 复制文件/文件夹到目标目录（保留原件）。
   * 文件夹递归复制；重名自动加序号，复制到自身子目录会被拒绝。
   */
  async function copyPaths(paths, targetDirRel) {
    invalidateScan();
    if (!Array.isArray(paths) || !paths.length) throw new LibraryError('没有需要复制的项目', 'BAD_INPUT', 400);
    const { abs: targetDir } = resolve(targetDirRel || '');
    await fs.mkdir(targetDir, { recursive: true });
    const results = [];

    for (const { abs, rel } of dropNestedPaths(paths)) {
      try {
        if (!(await exists(abs))) throw new Error('项目不存在');
        if (path.resolve(targetDir) === path.resolve(abs)) {
          throw new Error('不能把文件夹复制到它自己里面');
        }
        if (path.resolve(targetDir).startsWith(path.resolve(abs) + path.sep)) {
          throw new Error('不能把文件夹复制到它自己的子目录');
        }
        const { abs: dest, name: finalName } = await uniqueTarget(targetDir, path.basename(abs));
        await fs.cp(abs, dest, { recursive: true });
        results.push({ from: rel, ok: true, to: toRel(dest), name: finalName });
      } catch (err) {
        results.push({ from: rel, ok: false, error: err.message });
      }
    }
    return results;
  }

  // ------------------------------------------------------------- 回收站

  /** 删除前统计目录的真实占用（回收站列表里文件夹不再是 0 B）。 */
  async function pathBytes(abs, stat) {
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    let dirents = [];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      const childStat = await fs.lstat(childAbs).catch(() => null);
      if (!childStat) continue;
      total += childStat.isDirectory() ? await pathBytes(childAbs, childStat) : childStat.size;
    }
    return total;
  }

  /**
   * 删除 = 移入回收站。
   * 每项单独放进 `.trash/<id>/`：`item.<ext>` 保存原文件（目录则整体移动），
   * `meta.json` 记录原始路径与删除时间，恢复时按原路径搬回去。
   */
  async function trashPaths(paths) {
    invalidateScan();
    if (!Array.isArray(paths) || !paths.length) throw new LibraryError('没有需要删除的项目', 'BAD_INPUT', 400);
    if (paths.length > 2000) throw new LibraryError('单次最多删除 2000 项', 'TOO_MANY', 413);
    const results = [];
    for (const rel of paths) {
      let itemDir = '';
      try {
        const { abs } = resolve(rel, { allowRoot: false });
        const stat = await fs.stat(abs);
        const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        itemDir = path.join(root, TRASH_DIR, id);
        await fs.mkdir(itemDir, { recursive: true });
        const isDir = stat.isDirectory();
        const payload = `item${isDir ? '' : path.extname(abs)}`;
        const record = {
          id,
          path: rel,
          name: path.basename(abs),
          payload,
          isDir,
          bytes: await pathBytes(abs, stat),
          deletedAt: Date.now(),
        };
        await fs.writeFile(path.join(itemDir, 'meta.json'), JSON.stringify(record, null, 2), 'utf8');
        try {
          await fs.rename(abs, path.join(itemDir, payload));
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fs.cp(abs, path.join(itemDir, payload), { recursive: true });
          await fs.rm(abs, { recursive: true, force: true });
        }
        results.push({ path: rel, ok: true, id });
      } catch (err) {
        if (itemDir) await fs.rm(itemDir, { recursive: true, force: true }).catch(() => {});
        results.push({ path: rel, ok: false, error: err.message });
      }
    }
    return results;
  }

  /** 读取一条回收站记录；目录结构与 meta 不同步时返回 null。 */
  async function readTrashRecord(id) {
    const clean = String(id ?? '');
    if (!/^[a-z0-9-]+$/i.test(clean)) throw new LibraryError('回收站项目 ID 不合法', 'BAD_INPUT', 400);
    const itemDir = path.join(root, TRASH_DIR, clean);
    const text = await fs.readFile(path.join(itemDir, 'meta.json'), 'utf8').catch(() => '');
    if (!text) throw new LibraryError('回收站项目不存在', 'NOT_FOUND', 404);
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw new LibraryError('回收站项目元数据损坏', 'BAD_TRASH_META', 422);
    }
    record.payload = record.payload || `item${record.isDir ? '' : path.extname(record.name || '')}`;
    const abs = path.join(itemDir, record.payload);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new LibraryError('回收站项目文件已丢失', 'NOT_FOUND', 404);
    return { id: clean, itemDir, record, abs, stat };
  }

  /**
   * 回收站文件夹内容预览：递归列出文件（最多 200 个，避免大目录拖慢接口）。
   * 返回的条目带原文件 URL 与缩略图 URL，前端可直接展示或在文件夹内继续预览。
   */
  async function trashContents(id) {
    const { record, abs } = await readTrashRecord(id);
    if (!record.isDir) throw new LibraryError('该项目不是文件夹', 'BAD_INPUT', 400);
    const MAX_FILES = 200;
    const items = [];
    let fileCount = 0;
    let folderCount = 0;
    let truncated = false;

    async function walk(dirAbs, prefix) {
      const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const childAbs = path.join(dirAbs, dirent.name);
        const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          folderCount += 1;
          await walk(childAbs, relativePath);
          continue;
        }
        if (!dirent.isFile()) continue;
        fileCount += 1;
        if (items.length >= MAX_FILES) {
          truncated = true;
          continue;
        }
        const stat = await fs.stat(childAbs).catch(() => null);
        if (!stat) continue;
        const info = await describeEntry({ abs: childAbs, rel: toRel(childAbs), name: dirent.name, stat });
        items.push({ ...info, relativePath });
      }
    }

    await walk(abs, '');
    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN', { numeric: true }));
    return {
      id,
      name: record.name,
      originalPath: record.path,
      count: fileCount,
      folderCount,
      truncated,
      items,
    };
  }

  /** 回收站列表：带缩略图/尺寸/时长，前端可以直接预览。 */
  async function listTrash() {
    const dirents = await fs.readdir(path.join(root, TRASH_DIR), { withFileTypes: true }).catch(() => []);
    const items = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      try {
        const { id, record, abs, stat } = await readTrashRecord(dirent.name);
        const info = await describeEntry({ abs, rel: toRel(abs), name: record.name, stat });
        items.push({
          id,
          name: record.name,
          originalPath: record.path,
          dir: posixDir(record.path),
          isDir: Boolean(record.isDir),
          deletedAt: record.deletedAt ?? null,
          kind: record.isDir ? 'folder' : info.kind,
          bytes: record.isDir ? record.bytes ?? 0 : stat.size,
          width: info.width ?? null,
          height: info.height ?? null,
          duration: info.duration ?? null,
          url: record.isDir ? null : info.url,
          thumbUrl: record.isDir ? null : info.thumbUrl,
        });
      } catch {
        /* 单条损坏不影响整个回收站列表 */
      }
    }
    items.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    return {
      items,
      count: items.length,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    };
  }

  /** 恢复回收站项目；原位置已有同名文件时自动加序号。 */
  async function restoreTrash(ids) {
    invalidateScan();
    if (!Array.isArray(ids) || !ids.length) throw new LibraryError('没有需要恢复的项目', 'BAD_INPUT', 400);
    const results = [];
    for (const id of ids) {
      try {
        const { itemDir, record, abs } = await readTrashRecord(id);
        const parentAbs = resolve(posixDir(record.path) || '').abs;
        await fs.mkdir(parentAbs, { recursive: true });
        const { abs: dest, name: finalName } = await uniqueTarget(parentAbs, record.name);
        try {
          await fs.rename(abs, dest);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fs.cp(abs, dest, { recursive: true });
          await fs.rm(abs, { recursive: true, force: true });
        }
        await fs.rm(itemDir, { recursive: true, force: true });
        // 恢复时如果因重名改了路径，历史版本与缓存跟着回迁
        const restoredRel = toRel(dest);
        await moveVersions([{ from: record.path, to: restoredRel }]);
        await moveMeta([{ from: record.path, to: restoredRel }]);
        results.push({ id, ok: true, path: restoredRel, name: finalName });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    return results;
  }

  /** 彻底删除（不可恢复）。all=true 清空整个回收站。 */
  async function purgeTrash(ids = [], { all = false } = {}) {
    invalidateScan();
    if (all) {
      const current = await listTrash().catch(() => ({ items: [] }));
      await fs.rm(path.join(root, TRASH_DIR), { recursive: true, force: true }).catch(() => {});
      return { ok: true, removed: current.items.length, results: current.items.map((item) => ({ id: item.id, ok: true })) };
    }
    if (!Array.isArray(ids) || !ids.length) throw new LibraryError('没有需要清理的项目', 'BAD_INPUT', 400);
    const results = [];
    for (const id of ids) {
      try {
        const { itemDir } = await readTrashRecord(id);
        await fs.rm(itemDir, { recursive: true, force: true });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    return { ok: results.every((r) => r.ok !== false), removed: results.filter((r) => r.ok).length, results };
  }

  // ------------------------------------------------------------- 历史版本

  const versionsRoot = path.join(root, VERSIONS_DIR);
  const versionsIndexFile = path.join(versionsRoot, 'index.json');
  let versionsIndex = null;

  async function loadVersions() {
    if (versionsIndex) return versionsIndex;
    try {
      const text = await fs.readFile(versionsIndexFile, 'utf8');
      const parsed = JSON.parse(text);
      versionsIndex = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      versionsIndex = {};
    }
    return versionsIndex;
  }

  async function saveVersions() {
    if (!versionsIndex) return;
    try {
      await fs.mkdir(versionsRoot, { recursive: true });
      await fs.writeFile(versionsIndexFile, JSON.stringify(versionsIndex), 'utf8');
    } catch (err) {
      console.warn('[library] 写入历史版本索引失败:', err.message);
    }
  }

  function versionUrl(file) {
    return `/api/library/file?path=${encodeURIComponent(`${VERSIONS_DIR}/${file}`)}`;
  }

  /**
   * 为当前文件拍一张历史版本快照。
   * 覆盖上传 / 恢复旧版本前都会调用，保证“每一次编辑都能找回上一版”。
   */
  async function snapshotVersion(rel) {
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) return null;
    await loadVersions();
    await fs.mkdir(versionsRoot, { recursive: true });
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const file = `${id}${path.extname(relPath)}`;
    await fs.copyFile(abs, path.join(versionsRoot, file));
    const list = versionsIndex[relPath] ?? [];
    list.unshift({ id, file, at: Date.now(), bytes: stat.size, name: path.basename(relPath) });
    const keep = list.slice(0, MAX_VERSIONS_PER_FILE);
    for (const dropped of list.slice(MAX_VERSIONS_PER_FILE)) {
      await fs.rm(path.join(versionsRoot, dropped.file), { force: true }).catch(() => {});
    }
    versionsIndex[relPath] = keep;
    await saveVersions();
    return keep[0] ?? null;
  }

  async function listVersions(rel) {
    const { rel: relPath } = resolve(rel, { allowRoot: false });
    await loadVersions();
    const list = versionsIndex[relPath] ?? [];
    return {
      path: relPath,
      versions: list.map((item) => {
        const kind = classify(item.name).kind;
        return {
          ...item,
          url: versionUrl(item.file),
          thumbUrl: kind === 'image'
            ? `/api/library/thumb?path=${encodeURIComponent(`${VERSIONS_DIR}/${item.file}`)}&v=${item.at}`
            : null,
        };
      }),
    };
  }

  /** 恢复某个历史版本：先把当前内容也存成一版，再覆盖回去。 */
  async function restoreVersion(rel, versionId) {
    invalidateScan();
    await loadVersions();
    const { rel: relPath } = resolve(rel, { allowRoot: false });
    const version = (versionsIndex[relPath] ?? []).find((item) => item.id === versionId);
    if (!version) throw new LibraryError('历史版本不存在', 'NOT_FOUND', 404);
    const source = path.join(versionsRoot, version.file);
    if (!(await exists(source))) throw new LibraryError('历史版本文件已丢失', 'NOT_FOUND', 404);
    await snapshotVersion(relPath);
    const { abs } = resolve(relPath, { allowRoot: false });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.copyFile(source, abs);
    return entryByRel(relPath);
  }

  /**
   * 把旧索引键映射到本次变更后的最终路径。
   * 按「源路径」直接对应「最终路径」，而不是逐条串行改写：
   * a.png ↔ b.png 互换时，两边的版本记录会跟着各自的文件内容互换位置。
   * 文件夹改名/移动时取最长的前缀匹配，子文件整体迁到新目录。
   */
  function remapIndexKey(key, changes) {
    let best = null;
    for (const change of changes) {
      if (key === change.from) return change.to;
      if (key.startsWith(`${change.from}/`) && (!best || change.from.length > best.from.length)) best = change;
    }
    if (!best) return key;
    return `${best.to}/${key.slice(best.from.length + 1)}`;
  }

  /**
   * 改名/移动后迁移历史版本索引。
   * 一次性处理整批变更（先算好每个旧键的最终路径再重建），
   * 避免 a.png ↔ b.png 互换时把两边的版本记录混在一起。
   */
  async function moveVersions(changes) {
    const list = (Array.isArray(changes) ? changes : [changes]).filter((item) => item?.from && item?.to && item.from !== item.to);
    if (!list.length) return;
    await loadVersions();
    const next = {};
    for (const key of Object.keys(versionsIndex)) {
      const target = remapIndexKey(key, list);
      const merged = [...(versionsIndex[key] ?? []), ...(next[target] ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      next[target] = merged.slice(0, MAX_VERSIONS_PER_FILE);
    }
    versionsIndex = next;
    await saveVersions();
  }

  /** 元数据缓存同样按相对路径做键，改名后迁移前缀，缩略图尺寸不用重新探测。 */
  async function moveMeta(changes) {
    const list = (Array.isArray(changes) ? changes : [changes]).filter((item) => item?.from && item?.to && item.from !== item.to);
    if (!list.length) return;
    await loadMeta();
    const next = { ...meta };
    for (const key of Object.keys(meta)) {
      const target = remapIndexKey(key, list);
      if (target === key) continue;
      delete next[key];
      next[target] = meta[key];
    }
    meta = next;
    scheduleMetaSave();
  }

  // ------------------------------------------------------------- 内容校验

  function hashFile(abs) {
    return new Promise((resolveHash, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(abs);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolveHash(hash.digest('hex')));
    });
  }

  /** 取文件 sha256，命中缓存（同 size + mtime）时直接返回。 */
  async function checksumOf(rel, abs, stat) {
    await loadMeta();
    const cached = meta[rel];
    if (cached && cached.size === stat.size && cached.mtime === Math.round(stat.mtimeMs) && cached.meta?.checksum) {
      return cached.meta.checksum;
    }
    const checksum = await hashFile(abs);
    const prev = meta[rel];
    const reusable = prev && prev.size === stat.size && prev.mtime === Math.round(stat.mtimeMs);
    meta[rel] = {
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      meta: { ...(reusable ? prev.meta : {}), checksum },
    };
    scheduleMetaSave();
    return checksum;
  }

  /**
   * 上传完成后把校验值写入元数据缓存，下次查重不必重新读盘。
   * knownChecksum：上传流已经算好的 sha256，传入可避免对大文件重复读一遍。
   */
  async function rememberChecksum(rel, knownChecksum = null) {
    await loadMeta();
    const { abs } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) return null;
    const checksum = knownChecksum || (await hashFile(abs));
    const prev = meta[rel];
    const reusable = prev && prev.size === stat.size && prev.mtime === Math.round(stat.mtimeMs);
    meta[rel] = {
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      meta: { ...(reusable ? prev.meta : {}), checksum },
    };
    scheduleMetaSave();
    return checksum;
  }

  /**
   * 按内容查重：只对「大小相同」的文件计算 sha256，避免每次上传都全库读一遍。
   * 回收站与历史版本目录不参与比较。
   */
  async function findDuplicateByChecksum(checksum, size, { excludeRel = '' } = {}) {
    if (!checksum || !size) return null;
    const candidates = [];
    let stopped = false;
    async function walk(dirAbs) {
      if (stopped) return;
      const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (stopped) return;
        if (dirent.name.startsWith('.')) continue;
        // 跳过历史遗留的上传临时文件（旧命名不以「.」开头），防止它们被当成重复内容
        if (dirent.name.includes('.part-')) continue;
        const abs = path.join(dirAbs, dirent.name);
        if (dirent.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!dirent.isFile()) continue;
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat || stat.size !== size) continue;
        const rel = toRel(abs);
        if (rel === excludeRel) continue;
        candidates.push({ abs, rel, stat });
        if (candidates.length >= 200) {
          stopped = true;
          return;
        }
      }
    }
    await walk(root);
    for (const candidate of candidates) {
      if ((await checksumOf(candidate.rel, candidate.abs, candidate.stat)) === checksum) return candidate.rel;
    }
    return null;
  }

  /**
   * 在**同一个文件夹内**按内容 hash（sha256）查找重复资源。
   * 只有大小相同的文件才会读盘算哈希，结果仅供前端高亮标记，不改动任何文件。
   */
  async function findDuplicates(dir = '') {
    const target = String(dir || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const { entries: allEntries } = await scan({ light: true });
    const files = allEntries.filter((entry) => entry.dir === target);

    const bySize = new Map();
    for (const entry of files) {
      const bucket = bySize.get(entry.bytes);
      if (bucket) bucket.push(entry);
      else bySize.set(entry.bytes, [entry]);
    }

    const groups = [];
    for (const [size, list] of bySize) {
      if (list.length < 2) continue;
      const byHash = new Map();
      for (const entry of list) {
        const { abs } = resolve(entry.path, { allowRoot: false });
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat?.isFile()) continue;
        const checksum = await checksumOf(entry.path, abs, stat);
        const bucket = byHash.get(checksum);
        if (bucket) bucket.push(entry.path);
        else byHash.set(checksum, [entry.path]);
      }
      for (const [checksum, paths] of byHash) {
        if (paths.length > 1) groups.push({ checksum, size, paths });
      }
    }

    groups.sort((a, b) => b.paths.length - a.paths.length || a.paths[0].localeCompare(b.paths[0], 'zh-Hans-CN'));
    return {
      dir: target,
      groups,
      files: files.length,
      duplicateFiles: groups.reduce((sum, group) => sum + group.paths.length, 0),
    };
  }

  const api = {
    root,
    thumbnailRoot,
    cacheRoot,
    init,
    scan,
    invalidateScan,
    listDirectory,
    describePath,
    reveal,
    resolve,
    sanitizeName,
    prepareUpload,
    prepareOverwrite,
    mkdir,
    entryByRel,
    thumbnail,
    renameItems,
    movePaths,
    copyPaths,
    trashPaths,
    listTrash,
    trashContents,
    restoreTrash,
    purgeTrash,
    snapshotVersion,
    listVersions,
    restoreVersion,
    moveVersions,
    rememberChecksum,
    findDuplicateByChecksum,
    findDuplicates,
    invalidate() {
      meta = null;
      versionsIndex = null;
      invalidateScan();
    },
  };

  return api;
}

export class LibraryError extends Error {
  constructor(message, code = 'LIBRARY_ERROR', status = 400) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 挂载资源库 HTTP API：
 *
 *   GET  /api/library/tree?light=1         目录树 + 全部文件（light=1 跳过尺寸/时长解析）
 *   GET  /api/library/list?dir=            只列单个目录的直接子项（懒加载）
 *   GET  /api/library/meta?path=           单个文件的尺寸/时长等元数据
 *   GET  /api/library/reveal?path=        在系统文件管理器中打开/定位路径
 *   GET  /api/library/file?path=           原文件（支持 Range，视频可拖动播放）
 *   GET  /api/library/thumb?path=          缩略图（webp）
 *   POST /api/library/upload               原始二进制上传；X-File-Name / X-File-Dir 头
 *                                          X-Dedup=1 按 sha256 查重；X-Overwrite-Path 覆盖并保留旧版本
 *   POST /api/library/mkdir                { dir, name }
 *   POST /api/library/rename               { items:[{path,name}] } 批量改名
 *   POST /api/library/move                 { paths, target }
 *   POST /api/library/delete               { paths } 移入回收站
 *   GET  /api/library/trash                回收站列表（含缩略图/尺寸）
 *   GET  /api/library/trash/contents?id=   回收站文件夹内容预览
 *   POST /api/library/trash/restore        { ids }
 *   POST /api/library/trash/purge          { ids } 或 { all:true }
 *   GET  /api/library/versions?path=       历史版本列表
 *   POST /api/library/versions/restore     { path, id }
 */
export function createLibraryRouter(library) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '4mb' });
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  // 每个请求先确保根目录/缩略图目录存在，且元数据已加载（init 内部做了单例缓存）。
  router.use((req, res, next) => {
    library.init().then(() => next(), next);
  });

  /**
   * 列表类 JSON 统一加 `no-cache`：允许浏览器存一份但每次用之前必须重验证。
   * Express 自动生成 ETag，内容没变时返回 304（无 body），
   * 大资源库反复刷新/切目录时不用再传整份索引。
   */
  const sendListJson = (res, payload) => {
    // 注意别写 no-cache：Express 的 fresh 判断遇到 no-cache 会直接判定“不新鲜”，
    // 永远回 200 而拿不到 304。max-age=0 + must-revalidate 才是“可存、每次重验证”。
    res.set('Cache-Control', 'private, max-age=0, must-revalidate');
    res.json(payload);
  };

  router.get(
    '/tree',
    wrap(async (req, res) => {
      const data = await library.scan({
        light: String(req.query.light ?? '') === '1',
        // 「刷新」按钮带 refresh=1：绕过短缓存，强制重扫磁盘
        force: String(req.query.refresh ?? '') === '1',
      });
      sendListJson(res, data);
    }),
  );

  // 懒加载：只返回某个目录的直接子项，进入目录时再请求
  router.get(
    '/list',
    wrap(async (req, res) => {
      sendListJson(res, await library.listDirectory(req.query.dir ?? ''));
    }),
  );

  // 懒加载：单个文件的尺寸/时长等元数据，供列表卡片进入视口后补齐
  router.get(
    '/meta',
    wrap(async (req, res) => {
      sendListJson(res, await library.describePath(req.query.path ?? ''));
    }),
  );

  // 在系统文件资源管理器中打开 / 定位资源库路径
  router.get(
    '/reveal',
    wrap(async (req, res) => {
      res.json(await library.reveal(String(req.query.path ?? '')));
    }),
  );

  // 同文件夹内按内容 hash 查重（只返回分组，供前端高亮）
  router.get(
    '/duplicates',
    wrap(async (req, res) => {
      res.json(await library.findDuplicates(req.query.dir ?? ''));
    }),
  );

  router.get(
    '/file',
    wrap(async (req, res) => {
      const { abs } = library.resolve(req.query.path, { allowRoot: false });
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat?.isFile()) throw new LibraryError('文件不存在', 'NOT_FOUND', 404);
      res.set('Cache-Control', 'private, max-age=0, must-revalidate');
      res.sendFile(abs, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 404).end();
      });
    }),
  );

  router.get(
    '/thumb',
    wrap(async (req, res) => {
      // w：期望宽度（64–480，默认 320）。URL 里带 v=mtime，内容变了 URL 就变，
      // 所以可以直接长缓存，滚动列表时不再重复回源。
      const file = await library.thumbnail(req.query.path, { width: req.query.w });
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp').sendFile(file);
    }),
  );

  // 大文件上传：流式落盘 + sha256 校验；先写 .part 临时文件，成功后原子改名，
  // 避免列表里出现半截文件。X-Dedup=1 时拒绝内容完全相同的重复文件。
  router.post(
    '/upload',
    wrap(async (req, res) => {
      const name = decodeHeader(req.headers['x-file-name']) || fallbackName(req.headers['content-type']);
      const dir = decodeHeader(req.headers['x-file-dir']);
      const overwriteRel = decodeHeader(req.headers['x-overwrite-path']);
      const dedup = String(req.headers['x-dedup'] ?? '') === '1';
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD_BYTES) {
        throw new LibraryError(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`, 'TOO_LARGE', 413);
      }

      const target = overwriteRel
        ? await library.prepareOverwrite(overwriteRel)
        : await library.prepareUpload(dir, name);
      // 临时文件用「.」开头：scan() 与查重都会跳过隐藏文件，避免把正在上传的
      // 半成品当成资源库里的文件（查重时甚至会把它自己当成重复项）。
      const temp = path.join(
        path.dirname(target.abs),
        `.${path.basename(target.abs)}.part-${crypto.randomBytes(4).toString('hex')}`,
      );
      await fs.mkdir(path.dirname(target.abs), { recursive: true });

      const hash = crypto.createHash('sha256');
      let received = 0;
      let failed = false;
      await new Promise((resolve, reject) => {
        const stream = createWriteStream(temp, { flags: 'wx' });
        req.on('data', (chunk) => {
          received += chunk.length;
          hash.update(chunk);
          if (received > MAX_UPLOAD_BYTES) {
            failed = true;
            req.destroy();
            stream.destroy(new LibraryError('文件过大', 'TOO_LARGE', 413));
          }
        });
        req.on('error', (err) => {
          failed = true;
          stream.destroy(err);
        });
        stream.on('error', reject);
        stream.on('finish', resolve);
        req.pipe(stream);
      }).catch(async (err) => {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw err;
      });

      if (failed) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new LibraryError('上传中断', 'UPLOAD_ABORTED', 400);
      }

      const checksum = hash.digest('hex');
      if (dedup) {
        const duplicate = await library.findDuplicateByChecksum(checksum, received, { excludeRel: target.rel });
        if (duplicate) {
          await fs.rm(temp, { force: true }).catch(() => {});
          throw new LibraryError(`资源库中已存在相同文件「${duplicate}」，已跳过本次上传`, 'DUPLICATE', 409);
        }
      }

      // 覆盖上传：旧内容先留一版历史，再写入新文件
      if (target.existing) await library.snapshotVersion(target.rel);
      await fs.rename(temp, target.abs);
      // 落盘后立刻让扫描缓存失效，刷新时能看到新文件
      library.invalidateScan();
      const entry = await library.entryByRel(target.rel);
      await library.rememberChecksum(target.rel, checksum);
      res.status(201).json({
        ok: true,
        entry: { ...entry, checksum },
        bytes: received,
        checksum,
        replaced: Boolean(target.existing),
      });
    }),
  );

  router.post(
    '/mkdir',
    jsonBody,
    wrap(async (req, res) => {
      const folder = await library.mkdir(req.body?.dir ?? '', req.body?.name ?? '');
      res.status(201).json({ ok: true, folder });
    }),
  );

  router.post(
    '/rename',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.renameItems(req.body?.items);
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
    }),
  );

  router.post(
    '/copy',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.copyPaths(req.body?.paths, req.body?.target ?? '');
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
    }),
  );

  router.post(
    '/move',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.movePaths(req.body?.paths, req.body?.target ?? '');
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
    }),
  );

  // 删除一律进回收站，用户可以在回收站里预览、恢复或彻底删除
  router.post(
    '/delete',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.trashPaths(req.body?.paths);
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
    }),
  );

  router.get(
    '/trash/contents',
    wrap(async (req, res) => {
      res.json(await library.trashContents(req.query.id));
    }),
  );

  router.get(
    '/trash',
    wrap(async (_req, res) => {
      res.json(await library.listTrash());
    }),
  );

  router.post(
    '/trash/restore',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.restoreTrash(req.body?.ids);
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
    }),
  );

  router.post(
    '/trash/purge',
    jsonBody,
    wrap(async (req, res) => {
      res.json(await library.purgeTrash(req.body?.ids, { all: Boolean(req.body?.all) }));
    }),
  );

  router.get(
    '/versions',
    wrap(async (req, res) => {
      res.json(await library.listVersions(req.query.path));
    }),
  );

  router.post(
    '/versions/restore',
    jsonBody,
    wrap(async (req, res) => {
      const entry = await library.restoreVersion(req.body?.path, req.body?.id);
      res.json({ ok: true, entry });
    }),
  );

  return router;
}

function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function fallbackName(contentType) {
  const ext = String(contentType ?? '').includes('video') ? '.mp4' : '.png';
  return `upload-${Date.now()}${ext}`;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 相对路径的层级深度：根目录下的文件/文件夹为 1，子目录内再加 1。 */
function relDepth(rel) {
  return String(rel ?? '').split('/').filter(Boolean).length;
}

/** 取 POSIX 风格的父目录；返回空串表示资源库根目录。 */
function posixDir(rel) {
  const value = String(rel ?? '').replace(/\\/g, '/');
  const cut = value.lastIndexOf('/');
  return cut === -1 ? '' : value.slice(0, cut);
}

/** 简单并发池：控制 sharp/ffprobe 的并发数量，避免一次扫描把 CPU 打满。 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
