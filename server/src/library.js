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
import { createWriteStream } from 'node:fs';
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
  let scanPromise = null;
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
   */
  async function scan() {
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      await loadMeta();
      const folders = [];
      const fileRecords = [];
      let truncated = false;

      async function walk(dirAbs, depth) {
        const dirents = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
        dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        for (const dirent of dirents) {
          if (dirent.name.startsWith('.')) continue;
          const abs = path.join(dirAbs, dirent.name);
          if (dirent.isDirectory()) {
            const rel = toRel(abs);
            folders.push({ path: rel, name: dirent.name, parent: toRel(dirAbs), depth });
            await walk(abs, depth + 1);
          } else if (dirent.isFile()) {
            if (fileRecords.length >= MAX_FILES) {
              truncated = true;
              continue;
            }
            const rel = toRel(abs);
            const stat = await fs.stat(abs).catch(() => null);
            if (stat) fileRecords.push({ abs, rel, name: dirent.name, stat });
          }
        }
      }

      await walk(root, 0);
      const entries = await mapLimit(fileRecords, 6, (record) => describeEntry(record));
      const stats = {
        files: entries.length,
        folders: folders.length,
        images: entries.filter((e) => e.kind === 'image').length,
        videos: entries.filter((e) => e.kind === 'video').length,
        audios: entries.filter((e) => e.kind === 'audio').length,
        bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
        truncated,
      };

      return { root: '', folders: folders.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN')), entries, stats };
    })()
      .catch((err) => {
        throw err;
      })
      .finally(() => {
        scanPromise = null;
      });
    return scanPromise;
  }

  async function describeEntry({ abs, rel, name, stat }) {
    const { kind, ext } = classify(name);
    const base = {
      path: rel,
      name,
      dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      kind,
      ext,
      bytes: stat.size,
      mtime: Math.round(stat.mtimeMs),
      url: `/api/library/file?path=${encodeURIComponent(rel)}`,
      thumbUrl: kind === 'image' || kind === 'video' || kind === 'audio'
        ? `/api/library/thumb?path=${encodeURIComponent(rel)}&v=${Math.round(stat.mtimeMs)}`
        : null,
    };

    const cached = meta[rel];
    if (cached && cached.size === stat.size && cached.mtime === Math.round(stat.mtimeMs)) {
      return { ...base, ...cached.meta };
    }

    const info = {};
    if (kind === 'image') {
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
    } else if (kind === 'video' || kind === 'audio') {
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

  /** 上传前准备目标路径（带唯一化），返回绝对/相对路径。 */
  async function prepareUpload(dirRel, fileName) {
    const targetDir = resolve(dirRel || '').abs;
    await fs.mkdir(targetDir, { recursive: true });
    const name = sanitizeName(fileName || `upload-${Date.now()}.bin`);
    const { abs, name: finalName } = await uniqueTarget(targetDir, name);
    return { abs, rel: toRel(abs), dir: toRel(targetDir), name: finalName };
  }

  async function mkdir(dirRel, name) {
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

  async function thumbnail(rel) {
    const { abs, rel: relPath } = resolve(rel, { allowRoot: false });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new LibraryError('文件不存在', 'NOT_FOUND', 404);

    const { kind } = classify(abs);
    const hash = crypto
      .createHash('sha1')
      .update(`${relPath}|${stat.mtimeMs}|${stat.size}`)
      .digest('hex')
      .slice(0, 24);
    const out = path.join(thumbnailRoot, `${hash}.webp`);
    if (await exists(out)) return out;

    const sharp = await getSharp();
    if (!sharp) throw new VideoError('服务端缺少 sharp，无法生成缩略图', 'SHARP_MISSING', 503);

    try {
      if (kind === 'image') {
        // 与 describeEntry 同样的原因：读 Buffer 而不是把路径交给 libvips，
        // 否则生成过缩略图的图片会被锁住，后续改名/删除报 EBUSY。
        const buffer = await fs.readFile(abs);
        await sharp(buffer, { animated: false })
          .rotate()
          .resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(out);
      } else if (kind === 'video') {
        const tmpDir = path.join(cacheRoot, 'posters');
        await fs.mkdir(tmpDir, { recursive: true });
        const tmp = path.join(tmpDir, `${hash}.jpg`);
        const info = await probeVideo(abs).catch(() => null);
        await makeVideoPoster(abs, tmp, info);
        await sharp(await fs.readFile(tmp))
          .resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(out);
        await fs.rm(tmp, { force: true }).catch(() => {});
      } else {
        throw new LibraryError('该类型暂不支持缩略图', 'NO_THUMB', 404);
      }
    } catch (err) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (err instanceof VideoError || err instanceof LibraryError) throw err;
      throw new VideoError(`生成缩略图失败：${err.message}`, 'THUMB_FAILED', 422);
    }
    return out;
  }

  /**
   * 批量重命名。
   * 两阶段执行：先把所有需要改名的项改成临时名，再改成目标名，
   * 这样 `a.png ↔ b.png` 的互换、`1.jpg → 2.jpg`（2 已存在但也要改名）都不会互相覆盖。
   */
  async function renameItems(items) {
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

    // 阶段 1：源 → 临时
    const token = crypto.randomBytes(4).toString('hex');
    for (const [index, item] of valid.entries()) {
      item.tempName = `.rename-${token}-${index}`;
      try {
        await fs.rename(item.abs, path.join(item.parent, item.tempName));
        item.tempPath = path.join(item.parent, item.tempName);
      } catch (err) {
        item.ok = false;
        item.error = `无法重命名：${err.message}`;
      }
    }

    // 阶段 2：临时 → 目标
    const results = [];
    for (const item of valid) {
      if (!item.ok || !item.tempPath) {
        results.push({ from: item.fromRel, ok: false, error: item.error ?? '重命名失败' });
        continue;
      }
      const target = path.join(item.parent, item.finalName);
      try {
        await fs.rename(item.tempPath, target);
        results.push({ from: item.fromRel, to: toRel(target), ok: true, name: path.basename(target) });
      } catch (err) {
        // 尽力回滚到原名，避免文件停在临时名上
        try {
          await fs.rename(item.tempPath, item.abs);
        } catch {
          /* 回滚失败时把临时路径返回给前端，方便用户手动处理 */
        }
        results.push({ from: item.fromRel, ok: false, error: err.message, temporary: toRel(item.tempPath) });
      }
    }

    const failures = prepared.filter((p) => p.ok === false && !p.fromRel);
    for (const failure of failures) results.push({ from: failure.from, ok: false, error: failure.error });
    return results;
  }

  async function isForeignExisting(target, sourceSet) {
    const normalized = path.resolve(target);
    if (sourceSet.has(normalized)) return false; // 它本身也在本批改名队列里
    return exists(target);
  }

  /** 移动文件/文件夹到目标目录；跨盘时自动退回“复制 + 删除”。 */
  async function movePaths(paths, targetDirRel) {
    if (!Array.isArray(paths) || !paths.length) throw new LibraryError('没有需要移动的项目', 'BAD_INPUT', 400);
    const { abs: targetDir, rel: targetRel } = resolve(targetDirRel || '');
    await fs.mkdir(targetDir, { recursive: true });
    const results = [];

    for (const rel of paths) {
      try {
        const { abs } = resolve(rel, { allowRoot: false });
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
      } catch (err) {
        results.push({ from: rel, ok: false, error: err.message });
      }
    }
    return results;
  }

  /** 删除文件或整个子目录（前端会二次确认）。 */
  async function removePaths(paths) {
    if (!Array.isArray(paths) || !paths.length) throw new LibraryError('没有需要删除的项目', 'BAD_INPUT', 400);
    if (paths.length > 2000) throw new LibraryError('单次最多删除 2000 项', 'TOO_MANY', 413);
    const results = [];
    for (const rel of paths) {
      try {
        const { abs } = resolve(rel, { allowRoot: false });
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
        else await fs.unlink(abs);
        results.push({ path: rel, ok: true });
      } catch (err) {
        results.push({ path: rel, ok: false, error: err.message });
      }
    }
    return results;
  }

  const api = {
    root,
    thumbnailRoot,
    cacheRoot,
    init,
    scan,
    resolve,
    sanitizeName,
    prepareUpload,
    mkdir,
    entryByRel,
    thumbnail,
    renameItems,
    movePaths,
    removePaths,
    invalidate() {
      meta = null;
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
 *   GET  /api/library/tree                 目录树 + 全部文件
 *   GET  /api/library/file?path=           原文件（支持 Range，视频可拖动播放）
 *   GET  /api/library/thumb?path=          缩略图（webp）
 *   POST /api/library/upload               原始二进制上传；X-File-Name / X-File-Dir 头
 *   POST /api/library/mkdir                { dir, name }
 *   POST /api/library/rename               { items:[{path,name}] } 批量改名
 *   POST /api/library/move                 { paths, target }
 *   POST /api/library/delete               { paths }
 */
export function createLibraryRouter(library) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '4mb' });
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  // 每个请求先确保根目录/缩略图目录存在，且元数据已加载（init 内部做了单例缓存）。
  router.use((req, res, next) => {
    library.init().then(() => next(), next);
  });

  router.get(
    '/tree',
    wrap(async (_req, res) => {
      res.json(await library.scan());
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
      const file = await library.thumbnail(req.query.path);
      res.set('Cache-Control', 'private, max-age=3600');
      res.type('image/webp').sendFile(file);
    }),
  );

  // 大文件上传：流式落盘，先写 .part 临时文件，成功后原子改名，避免列表里出现半截文件。
  router.post(
    '/upload',
    wrap(async (req, res) => {
      const name = decodeHeader(req.headers['x-file-name']) || fallbackName(req.headers['content-type']);
      const dir = decodeHeader(req.headers['x-file-dir']);
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD_BYTES) {
        throw new LibraryError(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`, 'TOO_LARGE', 413);
      }

      const target = await library.prepareUpload(dir, name);
      const temp = `${target.abs}.part-${crypto.randomBytes(4).toString('hex')}`;
      await fs.mkdir(path.dirname(target.abs), { recursive: true });

      let received = 0;
      let failed = false;
      await new Promise((resolve, reject) => {
        const stream = createWriteStream(temp, { flags: 'wx' });
        req.on('data', (chunk) => {
          received += chunk.length;
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
      await fs.rename(temp, target.abs);
      const entry = await library.entryByRel(target.rel);
      res.status(201).json({ ok: true, entry, bytes: received });
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

  router.post(
    '/delete',
    jsonBody,
    wrap(async (req, res) => {
      const results = await library.removePaths(req.body?.paths);
      res.json({
        ok: results.every((r) => r.ok !== false),
        total: results.length,
        succeeded: results.filter((r) => r.ok !== false).length,
        results,
      });
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
