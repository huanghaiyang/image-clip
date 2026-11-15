/**
 * 资源库文件收藏 / emoji 标记
 * --------------------------
 * 与文件 id 绑定，改名 / 移动后不丢。持久化：`<cacheRoot>/file-marks.json`
 *   { version: 1, favorites: ["f_xxx"], marks: { "f_xxx": "⭐" } }
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** 去掉首尾空白；emoji 允许 1–8 个码点（兼容肤色 / 组合 emoji）。 */
export function normalizeMark(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const points = [...text];
  if (points.length > 8) throw new Error('标记最多 8 个字符');
  return text;
}

export function createFileMarkStore({ file } = {}) {
  const favorites = new Set();
  const marks = new Map();
  let ready = false;
  let dirty = false;
  let timer = null;

  async function init() {
    if (ready) return;
    ready = true;
    if (!file) return;
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const id of data?.favorites ?? []) {
        if (typeof id === 'string' && id) favorites.add(id);
      }
      for (const [id, mark] of Object.entries(data?.marks ?? {})) {
        if (typeof id === 'string' && id && typeof mark === 'string' && mark) marks.set(id, mark);
      }
    } catch {
      // 首次运行 / 文件损坏：从空状态开始
    }
  }

  function scheduleSave() {
    if (!file) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void persist();
    }, 250);
    timer.unref?.();
  }

  async function persist() {
    if (!file || !dirty) return;
    dirty = false;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const data = {
        version: 1,
        updatedAt: Date.now(),
        favorites: [...favorites],
        marks: Object.fromEntries(marks),
      };
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn('[file-marks] 写入失败:', err.message);
    }
  }

  function isFavorite(id) {
    return Boolean(id) && favorites.has(String(id));
  }

  function markOf(id) {
    return (id && marks.get(String(id))) || null;
  }

  /** 设置收藏；value 为 true/false。 */
  function setFavorite(id, value) {
    if (!id) return;
    if (value) favorites.add(String(id));
    else favorites.delete(String(id));
    scheduleSave();
  }

  /** 设置 / 清除 emoji 标记；mark 为 null 表示清除。 */
  function setMark(id, mark) {
    if (!id) return;
    if (mark) marks.set(String(id), mark);
    else marks.delete(String(id));
    scheduleSave();
  }

  /** 文件被删除 / 移入回收站时清理。 */
  function forget(ids) {
    for (const id of ids ?? []) {
      favorites.delete(String(id));
      marks.delete(String(id));
    }
    scheduleSave();
  }

  function size() {
    return { favorites: favorites.size, marks: marks.size };
  }

  return { init, isFavorite, markOf, setFavorite, setMark, forget, size, persist, get file() { return file; } };
}
