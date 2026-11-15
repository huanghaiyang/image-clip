/**
 * 资源库文件唯一 ID
 * -----------------
 * 路径会变（改名/移动），但它不是文件的身份。给每个文件分配一个稳定 id，
 * 改名、移动之后 id 不变；前端和接口都可以用 id 引用文件，避免：
 *  - 改名后用旧路径操作失败（路径已失效）；
 *  - 两个操作抢同一个名字/路径（例如先改名再删除）；
 *  - 前端列表刷新与操作之间路径不一致。
 *
 * 持久化：`<cacheRoot>/file-ids.json`
 *   { version: 1, ids: { "f_xxx": "相对路径" }, paths: { "相对路径": "f_xxx" } }
 *
 * 设计取舍：
 *  - 随机 id（f_ + 12 位 hex），不依赖路径，改名不换 id；
 *  - 文件被删除/移出资源库时清理映射；回收站恢复会分配新 id（回收站本身已有条目 id）；
 *  - 缓存文件丢失时会给现有文件重新分配 id（前端拿旧 id 会 404，需回退到路径）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function randomId() {
  return `f_${crypto.randomBytes(6).toString('hex')}`;
}

export function createFileIdStore({ file, prefix = 'f_', now = () => Date.now() } = {}) {
  const ids = new Map(); // id -> rel path
  const paths = new Map(); // rel path -> id
  let ready = false;
  let dirty = false;
  let saveTimer = null;

  async function init() {
    if (ready) return;
    ready = true;
    if (!file) return;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      for (const [id, rel] of Object.entries(data?.ids ?? {})) {
        if (typeof id === 'string' && typeof rel === 'string') {
          ids.set(id, rel);
          paths.set(rel, id);
        }
      }
    } catch {
      // 首次运行 / 文件损坏：从空映射开始
    }
  }

  function scheduleSave() {
    if (!file) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 300);
    saveTimer.unref?.();
  }

  async function persist() {
    if (!file || !dirty) return;
    dirty = false;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const data = {
        version: 1,
        updatedAt: now(),
        ids: Object.fromEntries(ids),
        paths: Object.fromEntries(paths),
      };
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn('[file-ids] 写入失败:', err.message);
    }
  }

  function idFor(rel) {
    if (!rel) return null;
    const existing = paths.get(rel);
    if (existing) return existing;
    let id = `${prefix}${randomId().slice(prefix.length)}`;
    // 极端碰撞时重新生成
    while (ids.has(id)) id = `${prefix}${randomId().slice(prefix.length)}`;
    paths.set(rel, id);
    ids.set(id, rel);
    scheduleSave();
    return id;
  }

  function pathFor(id) {
    return ids.get(String(id ?? '')) ?? null;
  }

  function idOrNull(rel) {
    return paths.get(rel) ?? null;
  }

  /** 批量确保路径有 id；返回 rel → id。 */
  function ensureMany(rels) {
    const out = {};
    for (const rel of rels ?? []) {
      if (!rel) continue;
      out[rel] = idFor(rel);
    }
    return out;
  }

  /** 改名 / 移动：id 跟着文件走。 */
  function remap(moves) {
    for (const move of moves ?? []) {
      if (!move?.from || !move?.to || move.from === move.to) continue;
      const id = paths.get(move.from) ?? null;
      paths.delete(move.from);
      if (id) {
        ids.set(id, move.to);
        paths.set(move.to, id);
      } else {
        // 没有旧 id（比如外部拷进来的文件）就为新路径补一个
        idFor(move.to);
      }
    }
    scheduleSave();
  }

  /** 文件被删除 / 移入回收站：释放映射。 */
  function forget(rels) {
    for (const rel of rels ?? []) {
      if (!rel) continue;
      const id = paths.get(rel);
      if (!id) continue;
      paths.delete(rel);
      ids.delete(id);
    }
    scheduleSave();
  }

  /**
   * 扫描后同步：给新文件补 id；清理已经不存在的旧路径。
   * 只处理当前可见（非隐藏）路径；回收站/历史版本目录不参与。
   */
  function sync(existingRels, { prune = true } = {}) {
    const existing = new Set(existingRels);
    for (const rel of existing) idFor(rel);
    if (!prune) return;
    for (const [id, rel] of [...ids]) {
      if (existing.has(rel)) continue;
      // 保留隐藏目录里的映射（回收站恢复可能仍需要它），只清理真正消失的普通路径
      if (rel.split('/').some((part) => part.startsWith('.'))) continue;
      ids.delete(id);
      paths.delete(rel);
    }
    scheduleSave();
  }

  function size() {
    return ids.size;
  }

  return {
    init,
    idFor,
    idOrNull,
    pathFor,
    ensureMany,
    remap,
    forget,
    sync,
    size,
    persist,
    get file() {
      return file;
    },
  };
}
