/**
 * 关联资源索引（资源库 / 回收站之外）
 * ------------------------------------
 * 资源库只索引 `data/library`，回收站只覆盖 `.trash`。AI 对话产物
 * (`data/artifacts`) 和导出文件 (`data/exports`) 不属于这两者，但仍然是
 * 用户在项目里产生、需要回看和检索的素材。
 *
 * 这里把它们统一建成一份可持久化的轻量索引：
 *  - 每条记录都有稳定 id、来源、尺寸/大小、原文件 URL 和缩略图 URL；
 *  - 索引文件落在 `data/cache/external-assets-index.json`，重启后直接复用；
 *  - 目录 mtime 变化时自动重建，保证新增产物不用重启就能检索到；
 *  - 缩略图按「绝对路径 + mtime + size + 宽度」缓存，图片 / 视频都支持。
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { makeVideoPoster, probeVideo } from './ffmpeg.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '../..');
const INDEX_VERSION = 1;
const MAX_FILES = 20000;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpg', '.mpeg', '.ogv', '.ts']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);

const SOURCE_LABEL = { artifact: 'AI 产物', export: '导出文件' };

class ExternalAssetError extends Error {
  constructor(message, code = 'EXTERNAL_ASSET_ERROR', status = 400) {
    super(message);
    this.name = 'ExternalAssetError';
    this.code = code;
    this.status = status;
  }
}

function classify(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', ext };
  if (VIDEO_EXTENSIONS.has(ext)) return { kind: 'video', ext };
  if (AUDIO_EXTENSIONS.has(ext)) return { kind: 'audio', ext };
  return { kind: 'file', ext };
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function statMtime(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return stat?.mtimeMs ?? 0;
}

/**
 * @param {{
 *   artifactDir?:string,
 *   exportDir?:string,
 *   indexFile?:string,
 *   thumbnailDir?:string,
 * }} [options]
 */
export function createExternalAssets(options = {}) {
  const artifactDir = path.resolve(options.artifactDir ?? path.join(ROOT_DIR, 'data/artifacts'));
  const exportDir = path.resolve(options.exportDir ?? path.join(ROOT_DIR, 'data/exports'));
  const indexFile = path.resolve(options.indexFile ?? path.join(ROOT_DIR, 'data/cache/external-assets-index.json'));
  const thumbnailDir = path.resolve(options.thumbnailDir ?? path.join(ROOT_DIR, 'data/asset-thumbs'));

  let data = null;
  let buildPromise = null;
  let saveTimer = null;

  function publicEntry(entry) {
    const { abs, ...rest } = entry;
    return rest;
  }

  function makeEntry(record) {
    return {
      ...record,
      thumbUrl: (record.kind === 'image' || record.kind === 'video')
        ? `/api/assets/external/thumb?id=${encodeURIComponent(record.id)}&v=${record.mtime}`
        : null,
    };
  }

  async function readArtifacts() {
    const entries = [];
    const dirents = await fs.readdir(artifactDir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.json') || dirent.name.startsWith('.')) continue;
      const metaFile = path.join(artifactDir, dirent.name);
      let meta = null;
      try {
        meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      } catch {
        continue;
      }
      if (!meta?.id || !meta?.ext) continue;
      const file = path.join(artifactDir, `${meta.id}.${meta.ext}`);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      const { kind, ext } = classify(file);
      const name = String(meta.label || `${meta.id}${path.extname(file)}`);
      entries.push(makeEntry({
        id: `artifact:${meta.id}`,
        source: 'artifact',
        sourceLabel: SOURCE_LABEL.artifact,
        name,
        label: meta.label || '',
        kind,
        ext,
        bytes: stat.size,
        mtime: Math.round(stat.mtimeMs),
        createdAt: meta.createdAt || new Date(stat.mtimeMs).toISOString(),
        width: meta.width ?? null,
        height: meta.height ?? null,
        duration: meta.duration ?? null,
        sessionId: meta.sessionId ?? null,
        path: `AI 产物/${meta.id}${ext}`,
        url: `/api/llm/artifact/${meta.id}`,
        abs: file,
      }));
    }
    return entries;
  }

  async function readExports() {
    const entries = [];
    const queue = [{ abs: exportDir, rel: '' }];
    let count = 0;
    while (queue.length && count < MAX_FILES) {
      const { abs, rel } = queue.shift();
      const dirents = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const childAbs = path.join(abs, dirent.name);
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          queue.push({ abs: childAbs, rel: childRel });
          continue;
        }
        if (!dirent.isFile() || count >= MAX_FILES) continue;
        const { kind, ext } = classify(dirent.name);
        if (kind === 'file') continue;
        const stat = await fs.stat(childAbs).catch(() => null);
        if (!stat?.isFile()) continue;
        count += 1;
        entries.push(makeEntry({
          id: `export:${crypto.createHash('sha1').update(childRel).digest('hex').slice(0, 20)}`,
          source: 'export',
          sourceLabel: SOURCE_LABEL.export,
          name: dirent.name,
          label: '',
          kind,
          ext,
          bytes: stat.size,
          mtime: Math.round(stat.mtimeMs),
          createdAt: new Date(stat.mtimeMs).toISOString(),
          width: null,
          height: null,
          duration: null,
          sessionId: null,
          path: `导出/${toPosix(childRel)}`,
          url: `/api/assets/external/file?id=${encodeURIComponent(`export:${crypto.createHash('sha1').update(childRel).digest('hex').slice(0, 20)}`)}`,
          abs: childAbs,
        }));
      }
    }
    return entries;
  }

  async function build() {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.mkdir(exportDir, { recursive: true });
    await fs.mkdir(thumbnailDir, { recursive: true });
    await fs.mkdir(path.dirname(indexFile), { recursive: true });

    const roots = {
      artifacts: await statMtime(artifactDir),
      exports: await statMtime(exportDir),
    };
    const entries = [...(await readArtifacts()), ...(await readExports())]
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));

    // 导出文件的 URL 需要在读到稳定 id 后再补一次，避免拼接时重复算出不同结果
    for (const entry of entries) {
      if (entry.source === 'export') {
        entry.url = `/api/assets/external/file?id=${encodeURIComponent(entry.id)}`;
      }
    }

    data = {
      version: INDEX_VERSION,
      generatedAt: new Date().toISOString(),
      roots,
      entries,
      stats: {
        total: entries.length,
        artifacts: entries.filter((entry) => entry.source === 'artifact').length,
        exports: entries.filter((entry) => entry.source === 'export').length,
        images: entries.filter((entry) => entry.kind === 'image').length,
        videos: entries.filter((entry) => entry.kind === 'video').length,
        audios: entries.filter((entry) => entry.kind === 'audio').length,
      },
    };
    await save();
    return data;
  }

  async function save() {
    if (!data) return;
    await fs.writeFile(indexFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8').catch(() => {});
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save();
    }, 300);
    saveTimer.unref?.();
  }

  async function load() {
    if (data) return data;
    try {
      const parsed = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      if (parsed?.version === INDEX_VERSION && Array.isArray(parsed.entries)) {
        data = parsed;
        return data;
      }
    } catch {
      /* 没有索引或索引损坏：重建 */
    }
    return rebuild();
  }

  async function ensureFresh() {
    const current = await load();
    const roots = {
      artifacts: await statMtime(artifactDir),
      exports: await statMtime(exportDir),
    };
    if (current.roots?.artifacts !== roots.artifacts || current.roots?.exports !== roots.exports) {
      return rebuild();
    }
    return current;
  }

  async function rebuild() {
    if (buildPromise) return buildPromise;
    buildPromise = build().finally(() => {
      buildPromise = null;
    });
    return buildPromise;
  }

  function findByQuery(id) {
    return data?.entries.find((entry) => entry.id === id) ?? null;
  }

  async function findById(id) {
    if (!id) return null;
    await ensureFresh();
    return findByQuery(String(id));
  }

  async function search({ q = '', kind = 'all', source = 'all', limit = 200, offset = 0 } = {}) {
    await ensureFresh();
    const keyword = String(q ?? '').trim().toLowerCase();
    const sourceFilter = String(source ?? 'all');
    const kindFilter = String(kind ?? 'all');
    let list = data.entries;
    if (sourceFilter !== 'all') list = list.filter((entry) => entry.source === sourceFilter);
    if (kindFilter !== 'all') list = list.filter((entry) => entry.kind === kindFilter);
    if (keyword) {
      list = list.filter((entry) =>
        [entry.name, entry.path, entry.label, entry.sessionId, entry.sourceLabel]
          .some((value) => String(value ?? '').toLowerCase().includes(keyword)),
      );
    }
    const total = list.length;
    const pageSize = Math.max(1, Math.min(500, Number(limit) || 200));
    const start = Math.max(0, Number(offset) || 0);
    return {
      total,
      limit: pageSize,
      offset: start,
      generatedAt: data.generatedAt,
      stats: data.stats,
      entries: list.slice(start, start + pageSize).map(publicEntry),
    };
  }

  async function status() {
    await ensureFresh();
    return {
      generatedAt: data.generatedAt,
      stats: data.stats,
      indexFile,
      roots: data.roots,
    };
  }

  async function thumbnail(id, { width = 320 } = {}) {
    const entry = await findById(id);
    if (!entry) throw new ExternalAssetError('关联资源不存在或索引已更新', 'NOT_FOUND', 404);
    if (entry.kind !== 'image' && entry.kind !== 'video') {
      throw new ExternalAssetError('该类型暂不支持缩略图', 'NO_THUMB', 404);
    }
    const w = Math.min(480, Math.max(64, Math.round(Number(width) || 320)));
    const hash = crypto.createHash('sha1')
      .update(`${entry.abs}|${entry.mtime}|${entry.bytes}|w${w}`)
      .digest('hex')
      .slice(0, 24);
    const out = path.join(thumbnailDir, `${hash}.webp`);
    if (await exists(out)) return out;

    const sharp = (await import('sharp')).default;
    await fs.mkdir(thumbnailDir, { recursive: true });
    try {
      if (entry.kind === 'image') {
        const buffer = await fs.readFile(entry.abs);
        await sharp(buffer, { animated: false })
          .rotate()
          .resize({ width: w, height: Math.round(w * 0.75), fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(out);
      } else {
        const poster = path.join(thumbnailDir, `${hash}-poster.jpg`);
        if (!(await exists(poster))) {
          const info = await probeVideo(entry.abs).catch(() => null);
          await makeVideoPoster(entry.abs, poster, info);
        }
        await sharp(await fs.readFile(poster))
          .resize({ width: w, height: Math.round(w * 0.75), fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(out);
      }
      return out;
    } catch (err) {
      await fs.rm(out, { force: true }).catch(() => {});
      if (err instanceof ExternalAssetError) throw err;
      throw new ExternalAssetError(`生成缩略图失败：${err.message}`, 'THUMB_FAILED', 422);
    }
  }

  async function init() {
    await load();
    return api;
  }

  const api = {
    init,
    search,
    status,
    rebuild,
    findById,
    thumbnail,
    get roots() {
      return { artifactDir, exportDir, indexFile, thumbnailDir };
    },
  };
  return api;
}

/** 挂载关联资源 HTTP API。 */
export function createExternalAssetsRouter(assets) {
  const router = express.Router();
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.use((req, res, next) => {
    assets.init().then(() => next(), next);
  });

  // 索引状态：条目数量、来源分布、生成时间
  router.get(
    '/index',
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await assets.status());
    }),
  );

  // 强制重建索引（用户点「刷新索引」时用）
  router.post(
    '/reindex',
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const data = await assets.rebuild();
      res.json({ generatedAt: data.generatedAt, stats: data.stats });
    }),
  );

  // 检索：q / kind / source / limit / offset
  router.get(
    '/',
    wrap(async (req, res) => {
      res.set('Cache-Control', 'private, max-age=0, must-revalidate');
      res.json(await assets.search({
        q: req.query.q ?? '',
        kind: req.query.kind ?? 'all',
        source: req.query.source ?? 'all',
        limit: req.query.limit ?? 200,
        offset: req.query.offset ?? 0,
      }));
    }),
  );

  // 原文件（支持 Range，浏览器可直接预览视频/音频）
  router.get(
    '/file',
    wrap(async (req, res) => {
      const entry = await assets.findById(req.query.id);
      if (!entry) throw new ExternalAssetError('关联资源不存在或索引已更新', 'NOT_FOUND', 404);
      const stat = await fs.stat(entry.abs).catch(() => null);
      if (!stat?.isFile()) throw new ExternalAssetError('文件不存在', 'NOT_FOUND', 404);
      res.set('Cache-Control', 'private, max-age=0, must-revalidate');
      res.sendFile(entry.abs, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 404).end();
      });
    }),
  );

  // 缩略图（webp，按 w 参数缓存）
  router.get(
    '/thumb',
    wrap(async (req, res) => {
      const file = await assets.thumbnail(String(req.query.id ?? ''), { width: req.query.w });
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('image/webp').sendFile(file);
    }),
  );

  return router;
}

export { ExternalAssetError };
