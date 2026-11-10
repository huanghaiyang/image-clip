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
 */
export function fetchLibraryTree({ light = false } = {}) {
  return requestJson(`/api/library/tree${light ? '?light=1' : ''}`, { cache: 'no-store' });
}

/** 只列一个目录的直接子项（懒加载）。 */
export function fetchLibraryDirectory(dir = '') {
  const query = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return requestJson(`/api/library/list${query}`, { cache: 'no-store' });
}

/** 单个文件的尺寸 / 时长等元数据。 */
export function fetchLibraryEntryMeta(path) {
  return requestJson(`/api/library/meta?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
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

export function libraryThumbUrl(entry) {
  if (entry?.thumbUrl) return entry.thumbUrl;
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
