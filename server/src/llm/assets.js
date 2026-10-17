/**
 * 对话/大模型侧的文件仓库：把图片、掩膜、处理结果都落成带 id 的 artifact。
 *
 * 为什么不在内存里攒 buffer：对话是多轮的（"再帮我裁一下刚才那张"），
 * artifact 必须能跨轮次、跨请求引用；落盘 + 一个 meta json 最简单，也方便直接
 * 用 GET /api/llm/artifact/:id 返回图片给界面。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ARTIFACT_DIR = path.join(ROOT, 'data', 'artifacts');

const MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

function ensureDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function newId(prefix = 'a') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 保存一个 artifact。
 * @param {Buffer} buffer
 * @param {{ext?:string,kind?:string,label?:string,width?:number,height?:number,sessionId?:string,meta?:object}} info
 */
export function saveArtifact(buffer, info = {}) {
  ensureDir();
  const ext = (info.ext || 'png').replace(/^\./, '').toLowerCase();
  const id = newId(info.kind === 'mask' ? 'm' : info.kind === 'source' ? 's' : 'a');
  const file = path.join(ARTIFACT_DIR, `${id}.${ext}`);
  fs.writeFileSync(file, buffer);
  const meta = {
    id,
    ext,
    kind: info.kind ?? 'result',
    label: info.label ?? '',
    width: info.width ?? null,
    height: info.height ?? null,
    bytes: buffer.length,
    sessionId: info.sessionId ?? null,
    createdAt: new Date().toISOString(),
    ...(info.meta ?? {}),
  };
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return { ...meta, url: `/api/llm/artifact/${id}` };
}

export function getArtifact(id) {
  if (!/^[a-z]+_[0-9a-f]{16}$/.test(String(id))) return null;
  ensureDir();
  const metaFile = path.join(ARTIFACT_DIR, `${id}.json`);
  if (!fs.existsSync(metaFile)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const file = path.join(ARTIFACT_DIR, `${id}.${meta.ext}`);
  if (!fs.existsSync(file)) return null;
  return { meta, buffer: fs.readFileSync(file), mime: MIME[meta.ext] ?? 'application/octet-stream' };
}

/** 只允许读取当前会话产生的 artifact（避免凭 id 猜别人的图）。 */
export function getSessionArtifact(sessionId, id) {
  const found = getArtifact(id);
  if (!found) return null;
  if (found.meta.sessionId && sessionId && found.meta.sessionId !== sessionId) return null;
  return found;
}

export function artifactView(meta) {
  return {
    id: meta.id,
    url: `/api/llm/artifact/${meta.id}`,
    kind: meta.kind,
    label: meta.label,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
  };
}

export function exportArtifact(id, filename) {
  const found = getArtifact(id);
  if (!found) throw new Error(`artifact 不存在：${id}`);
  const dir = path.join(ROOT, 'data', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || `${id}.${found.meta.ext}`).replace(/[\\/:*?"<>|]/g, '_');
  const dest = path.join(dir, safe);
  fs.writeFileSync(dest, found.buffer);
  return { id: fs.existsSync(dest) ? path.relative(ROOT, dest) : dest, filename: safe, bytes: found.buffer.length };
}
