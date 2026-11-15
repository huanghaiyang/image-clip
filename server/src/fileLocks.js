/**
 * 资源库文件锁定
 * --------------
 * 锁定只保护文件不被删除：改名 / 移动 / 复制仍然允许（id 不变）。
 * 按文件 id 存储，所以改名、移动后锁定状态不会丢。
 *
 * 持久化文件：`<cacheRoot>/file-locks.json`
 *   { version: 1, locked: ["f_xxx", ...] }
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFileLockStore({ file } = {}) {
  const locked = new Set();
  let ready = false;
  let dirty = false;
  let timer = null;

  async function init() {
    if (ready) return;
    ready = true;
    if (!file) return;
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const id of data?.locked ?? []) {
        if (typeof id === 'string' && id) locked.add(id);
      }
    } catch {
      // 首次运行 / 文件损坏：从空集合开始
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
      const data = { version: 1, updatedAt: Date.now(), locked: [...locked] };
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn('[file-locks] 写入失败:', err.message);
    }
  }

  function has(id) {
    return Boolean(id) && locked.has(String(id));
  }

  function set(ids, value) {
    for (const id of ids ?? []) {
      if (!id) continue;
      if (value) locked.add(String(id));
      else locked.delete(String(id));
    }
    scheduleSave();
  }

  function forget(ids) {
    set(ids, false);
  }

  function size() {
    return locked.size;
  }

  return { init, has, set, forget, size, persist, get file() { return file; } };
}
