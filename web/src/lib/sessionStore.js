/**
 * 临时会话存储层
 * --------------
 * localStorage 只放轻量会话文档（结构、路径、参数、标记点），
 * IndexedDB 放大对象（素材原图、橡皮擦/像素画布、水印掩膜与结果、模板）。
 *
 * 这样做的原因：
 *  - localStorage 单键约 5MB，一张 4000×3000 的 PNG 就可能超限；
 *  - IndexedDB 直接存 Blob，不需要 base64 转换，读写都更快；
 *  - 文档与二进制分开后，自动保存（高频）只写文档，图片只在首次/编辑后写一次。
 *
 * 所有函数都做了降级：IndexedDB 不可用（隐私模式、浏览器限制）时返回空结果，
 * 会话仍能保存文本部分，只是图片无法恢复。
 */

export const SESSION_DOC_KEY = 'image-clip:session:v1';

const DB_NAME = 'image-clip-sessions';
const DB_VERSION = 1;
const BLOB_STORE = 'blobs';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB !== 'object' || !indexedDB) {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

// --------------------------------------------------------------- 会话文档

export function loadSessionDoc() {
  try {
    const raw = localStorage.getItem(SESSION_DOC_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || doc.version !== 1) return null;
    return doc;
  } catch {
    return null;
  }
}

export function saveSessionDoc(doc) {
  try {
    localStorage.setItem(SESSION_DOC_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

export function clearSessionDoc() {
  try {
    localStorage.removeItem(SESSION_DOC_KEY);
  } catch {
    /* 隐私模式下可能不支持，忽略 */
  }
}

// --------------------------------------------------------------- Blob 存储

export async function writeSessionBlobs(entries) {
  const list = [...(entries ?? [])].filter(([, blob]) => blob instanceof Blob);
  if (!list.length) return false;
  const db = await openDatabase();
  if (!db) return false;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(BLOB_STORE, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    const store = tx.objectStore(BLOB_STORE);
    for (const [key, blob] of list) store.put(blob, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export async function readSessionBlobs(keys) {
  const out = {};
  const wanted = [...new Set((keys ?? []).filter(Boolean))];
  if (!wanted.length) return out;
  const db = await openDatabase();
  if (!db) return out;
  await Promise.all(
    wanted.map(
      (key) =>
        new Promise((resolve) => {
          let request;
          try {
            request = db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE).get(key);
          } catch {
            resolve();
            return;
          }
          request.onsuccess = () => {
            if (request.result instanceof Blob) out[key] = request.result;
            resolve();
          };
          request.onerror = () => resolve();
        }),
    ),
  );
  return out;
}

/** 只保留文档引用到的键，避免已移除素材/旧掩膜长期占用磁盘。 */
export async function pruneSessionBlobs(keepKeys) {
  const keep = new Set((keepKeys ?? []).map(String));
  const db = await openDatabase();
  if (!db) return false;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(BLOB_STORE, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    const store = tx.objectStore(BLOB_STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (!keep.has(String(cursor.key))) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export async function clearSessionBlobs() {
  const db = await openDatabase();
  if (!db) return false;
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(BLOB_STORE, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    tx.objectStore(BLOB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}
