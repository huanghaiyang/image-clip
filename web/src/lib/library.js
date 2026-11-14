/**
 * 资源库 / 视频 API 客户端。
 *
 * 这里集中处理三件事，避免各个组件里散落 fetch 细节：
 *  1. JSON 请求与错误信息归一化（服务端统一返回 { error: { code, message } }）；
 *  2. 大文件上传走 XMLHttpRequest，因为 fetch 至今没有可靠的上传进度事件；
 *  3. 上传头里中文文件名必须 encodeURIComponent，否则浏览器会拒绝设置非 ASCII 头。
 */

export class LibraryApiError extends Error {
  constructor(message, code = 'LIBRARY_API_ERROR', status = 0) {
    super(message);
    this.name = 'LibraryApiError';
    this.code = code;
    this.status = status;
  }
}

async function parseError(res) {
  let message = `HTTP ${res.status}`;
  let code = 'HTTP_ERROR';
  try {
    const body = await res.json();
    if (body?.error) {
      message = body.error.message || message;
      code = body.error.code || code;
    }
  } catch {
    /* 非 JSON 错误体：保留 HTTP 状态文本 */
  }
  return new LibraryApiError(message, code, res.status);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw await parseError(res);
  return res.json();
}

/**
 * 资源库索引。light=true 时服务端只读目录/stat，不解析图片尺寸与视频时长，
 * 用于首屏统计与跨目录搜索；具体文件的元数据走 fetchLibraryEntryMeta 懒加载。
 * force=true 带 refresh=1，跳过服务端的扫描短缓存（「刷新」按钮用）。
 *
 * 列表接口统一用 `no-cache`：浏览器存一份，但每次使用前用 ETag 重验证；
 * 内容没变时服务端回 304（空 body），大图库反复刷新/切目录时不再重复传输整份索引。
 */
export function fetchLibraryTree({ light = false, force = false } = {}) {
  const params = new URLSearchParams();
  if (light) params.set('light', '1');
  if (force) params.set('refresh', '1');
  const query = params.toString();
  return requestJson(`/api/library/tree${query ? `?${query}` : ''}`, { cache: 'no-cache' });
}

/** 只列一个目录的直接子项（懒加载）。 */
export function fetchLibraryDirectory(dir = '', { force = false } = {}) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (force) params.set('refresh', '1');
  const query = params.toString();
  return requestJson(`/api/library/list${query ? `?${query}` : ''}`, { cache: 'no-cache' });
}

/** 单个文件的尺寸 / 时长等元数据。 */
export function fetchLibraryEntryMeta(path) {
  return requestJson(`/api/library/meta?path=${encodeURIComponent(path)}`, { cache: 'no-cache' });
}

/** 在系统文件资源管理器中打开目录 / 定位并选中文件。 */
export function revealLibraryPath(path = '') {
  return requestJson(`/api/library/reveal?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
}

/** 同文件夹内按内容 hash 查重；仅返回分组用于高亮，不改动文件。 */
export function fetchLibraryDuplicates(dir = '') {
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return requestJson(`/api/library/duplicates${query}`, { cache: 'no-store' });
}

/**
 * 上传一个 File/Blob 到资源库。
 * @param {File|Blob} file
 * @param {{
 *   dir?:string,
 *   name?:string,
 *   dedup?:boolean,
 *   overwritePath?:string,
 *   onProgress?:(percent:number, loaded:number, total:number)=>void,
 * }} [options]
 *   dedup：由服务端按 sha256 查重，内容相同直接拒绝（用户手动上传默认开启）；
 *   overwritePath：覆盖资源库中的指定文件，服务端会先保存旧内容为历史版本。
 */
export function uploadLibraryFile(file, options = {}) {
  const name = options.name || file.name || `upload-${Date.now()}`;
  const dir = options.dir || '';
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/library/upload');
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.setRequestHeader('X-File-Dir', encodeURIComponent(dir));
    if (options.dedup) xhr.setRequestHeader('X-Dedup', '1');
    if (options.overwritePath) xhr.setRequestHeader('X-Overwrite-Path', encodeURIComponent(options.overwritePath));

    if (typeof options.onProgress === 'function') {
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        options.onProgress(Math.round((event.loaded / event.total) * 100), event.loaded, event.total);
      };
    }

    xhr.onerror = () => reject(new LibraryApiError('上传失败：网络错误', 'NETWORK_ERROR'));
    xhr.onabort = () => reject(new LibraryApiError('上传已取消', 'ABORTED'));
    xhr.onload = () => {
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }
      reject(
        new LibraryApiError(
          body?.error?.message || `上传失败：HTTP ${xhr.status}`,
          body?.error?.code || 'UPLOAD_FAILED',
          xhr.status,
        ),
      );
    };
    xhr.send(file);
  });
}

/**
 * 「就地保存」的目标文件：编辑器输出的都是保留 alpha 的 PNG，
 * 所以目标统一成 `.png`；原文件是 JPG/WebP 时，服务端会先改名再覆盖（旧内容进历史版本）。
 *
 * @param {string} path 当前素材在资源库里的相对路径；空字符串表示还没进资源库
 * @param {string} fallbackName 没有 path 时用来起名的素材名（允许带扩展名）
 * @returns {{path:string, dir:string, name:string, renamed:boolean}}
 *   path 为空表示要新建文件；renamed 表示需要先把现有文件改名成 .png
 */
export function resolveInPlaceTarget(path, fallbackName = 'image') {
  const baseOf = (value) => String(value ?? '').replace(/\.[^./\\]+$/, '').replace(/[/\\]+$/, '') || 'image';
  const cleanPath = String(path ?? '').trim();

  if (!cleanPath) {
    const name = `${baseOf(fallbackName)}.png`;
    return { path: '', dir: '', name, renamed: false };
  }

  const slash = cleanPath.lastIndexOf('/');
  const dir = slash >= 0 ? cleanPath.slice(0, slash) : '';
  const currentName = cleanPath.slice(slash + 1);
  const name = `${baseOf(currentName)}.png`;
  return { path: cleanPath, dir, name, renamed: name !== currentName };
}

export function uploadBlobToLibrary(blob, name, dir = '') {
  return uploadLibraryFile(blob, { name, dir });
}

export function createLibraryFolder(dir, name) {
  return requestJson('/api/library/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, name }),
  });
}

export function renameLibraryItems(items) {
  return requestJson('/api/library/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

export function moveLibraryItems(paths, target) {
  return requestJson('/api/library/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, target }),
  });
}

export function copyLibraryItems(paths, target) {
  return requestJson('/api/library/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, target }),
  });
}

export function deleteLibraryItems(paths) {
  return requestJson('/api/library/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
}

// --------------------------------------------------------------- 回收站

export function fetchLibraryTrash() {
  return requestJson('/api/library/trash', { cache: 'no-store' });
}

export function fetchLibraryTrashContents(id) {
  return requestJson(`/api/library/trash/contents?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
}

export function restoreLibraryTrash(ids) {
  return requestJson('/api/library/trash/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export function purgeLibraryTrash(ids, all = false) {
  return requestJson('/api/library/trash/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(all ? { all: true } : { ids }),
  });
}

// --------------------------------------------------------------- 历史版本

export function fetchLibraryVersions(path) {
  return requestJson(`/api/library/versions?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
}

export function restoreLibraryVersion(path, id) {
  return requestJson('/api/library/versions/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, id }),
  });
}

export function probeLibraryVideo(path) {
  return requestJson(`/api/video/probe?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
}

/**
 * 视频某一时刻的单帧图片 URL（服务端 ffmpeg 解码成 JPEG）。
 *
 * 逐帧比对用它而不是直接播放 <video>：容器/编码（HEVC、ProRes…）浏览器可能解不了，
 * 但 JPEG 一定显示得出来；帧画面也天然可放进 canvas 做像素差。
 * version 建议传文件 mtime：换版本后 URL 变化，配合服务端长缓存不会串图。
 */
export function videoFrameUrl(path, time, { width = 640, version = 0 } = {}) {
  const params = new URLSearchParams();
  params.set('path', path);
  params.set('t', Math.max(0, Number(time) || 0).toFixed(3));
  params.set('w', String(Math.max(240, Math.min(1280, Math.round(width) || 640))));
  if (version) params.set('v', String(version));
  return `/api/video/frame?${params.toString()}`;
}

export function fetchFilmstrip(path, { count = 16, width = 160 } = {}) {
  return requestJson('/api/video/filmstrip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, count, width }),
  });
}

export function extractVideoFrames(payload) {
  return requestJson('/api/video/frames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function extractVideoAudio(payload) {
  return requestJson('/api/video/audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function fetchVideoHealth() {
  return requestJson('/api/video/health', { cache: 'no-store' });
}

/** 在视频的某个时间点检测水印，返回预览图 + RLE 掩膜 + 建议引擎。 */
export function detectVideoWatermark(payload) {
  return requestJson('/api/video/watermark/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 按掩膜去除视频水印，结果写入资源库。 */
export function removeVideoWatermark(payload) {
  return requestJson('/api/video/watermark/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 视频切断 + 裁剪导出，结果写入资源库。 */
export function cutVideo(payload) {
  return requestJson('/api/video/cut', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 通过资源库 URL 下载成 Blob（供“转入编辑”使用）。 */
export async function fetchLibraryBlob(entryOrUrl) {
  const url = typeof entryOrUrl === 'string' ? entryOrUrl : entryOrUrl?.url;
  if (!url) throw new LibraryApiError('缺少文件 URL', 'MISSING_URL');
  const res = await fetch(url);
  if (!res.ok) throw await parseError(res);
  return res.blob();
}

export function libraryFileUrl(entry) {
  return entry?.url ?? (entry?.path ? `/api/library/file?path=${encodeURIComponent(entry.path)}` : '');
}

/**
 * 缩略图 URL。
 * @param {object} entry 资源库条目（服务端也会带 thumbUrl，但宽度固定）
 * @param {number} [width] 期望宽度（64–480）。不传则用服务端默认（320）；
 *   网格卡片用 320、树/文件夹小图用 160，避免为了 32px 的图标解码 480px 的图。
 */
export function libraryThumbUrl(entry, width) {
  const w = Number(width);
  const hasWidth = Number.isFinite(w) && w > 0;
  if (entry?.path && hasWidth) {
    return `/api/library/thumb?path=${encodeURIComponent(entry.path)}&v=${entry.mtime ?? 0}&w=${Math.round(w)}`;
  }
  if (entry?.thumbUrl) {
    if (!hasWidth) return entry.thumbUrl;
    // 回收站 / 历史版本的条目只有服务端拼好的 thumbUrl，直接补一个 w 参数
    return `${entry.thumbUrl}${entry.thumbUrl.includes('?') ? '&' : '?'}w=${Math.round(w)}`;
  }
  if (!entry?.path) return '';
  return `/api/library/thumb?path=${encodeURIComponent(entry.path)}&v=${entry.mtime ?? 0}`;
}

// --------------------------------------------------------------- 展示格式

/** 秒 → mm:ss（超过 1 小时用 h:mm:ss）。 */
export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '00:00';
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 秒 → mm:ss.ms，用于逐帧显示的精确时间。 */
export function formatTimecode(seconds, fps = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  const totalSeconds = Math.floor(value);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const decimals = fps >= 1 ? 1 : 1;
  const rest = (value - totalSeconds).toFixed(decimals).slice(1);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${rest}`;
}

/** 给文件大小加上合适的单位。 */
export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

// --------------------------------------------------------------- 指纹索引（相似检索用）

/** 指纹索引状态：{ running, queued, indexed, totalImages, done, failed, ... }。 */
export async function fetchPhashStatus() {
  const res = await fetch('/api/library/similar/index');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `读取指纹索引状态失败（HTTP ${res.status}）`);
  return body;
}

/**
 * 为资源库里缺指纹的图片补建索引（幂等）。
 * @param {{force?:boolean}} [options] force=true 整库重算
 */
export async function startPhashIndex({ force = false } = {}) {
  const res = await fetch('/api/library/similar/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: Boolean(force) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `启动指纹索引失败（HTTP ${res.status}）`);
  return body;
}

// --------------------------------------------------------------- 相似资源检索（智能识图）

/**
 * 相似资源检索：以资源库里已有的图片为查询。
 * @param {string} path 相对资源库的路径
 * @param {{limit?:number, minScore?:number}} [options]
 */
export async function fetchSimilarByPath(path, { limit = 60, minScore = 0.55 } = {}) {
  const query = new URLSearchParams({ path: String(path ?? ''), limit: String(limit), minScore: String(minScore) });
  const res = await fetch(`/api/library/similar?${query}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `相似检索失败（HTTP ${res.status}）`);
  return body;
}

/**
 * 智能识图：上传一张图片（本地文件 / 剪贴板 / 未入库素材）作为查询。
 * @param {Blob} blob 图片字节
 * @param {{fileName?:string, limit?:number, minScore?:number}} [options]
 */
export async function fetchSimilarByImage(blob, { fileName = 'query.png', limit = 60, minScore = 0.55 } = {}) {
  const query = new URLSearchParams({ limit: String(limit), minScore: String(minScore), name: fileName });
  const res = await fetch(`/api/library/similar?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `识图失败（HTTP ${res.status}）`);
  return body;
}
