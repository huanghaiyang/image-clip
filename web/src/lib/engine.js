/**
 * 引擎桥接：把“浏览器本地检测/裁剪”和“Node 服务端检测/裁剪”包装成同一个契约。
 *
 * 两边都调用同一份 shared/aabb.js，因此结果应当逐像素一致；
 * 界面上可以随时切换引擎做对照（也用于验证前后端一致性）。
 */
import { analyzeLocally, renderCrop } from './imaging.js';

export const ENGINES = [
  { value: 'client', label: '浏览器引擎', hint: '本地 canvas 即时计算，不上传图片' },
  { value: 'server', label: 'Node 引擎', hint: 'POST 到 Node + sharp，服务端计算' },
];

function optionsToQuery(options, extra = {}) {
  const params = new URLSearchParams();
  params.set('alphaThreshold', String(options.alphaThreshold));
  params.set('padding', String(options.padding));
  params.set('matchColor', options.matchColor ? 'true' : 'false');
  params.set('backgroundColor', options.backgroundColor);
  params.set('colorTolerance', String(options.colorTolerance));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params;
}

async function readError(res) {
  try {
    const body = await res.json();
    return body?.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** 让服务端分析一张图；item.buffer 是原始文件字节（ArrayBuffer）。 */
export async function analyzeOnServer(item, options) {
  const res = await fetch(`/api/analyze?${optionsToQuery(options)}`, {
    method: 'POST',
    headers: { 'Content-Type': item.type || 'application/octet-stream' },
    body: item.buffer.slice(0), // 复制一份，避免请求体与后续调用共享内存
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** 服务端裁剪 → 直接拿到 Blob（与浏览器端 renderCrop 的返回结构一致）。 */
export async function cropOnServer(item, options, { format, quality }) {
  const res = await fetch(`/api/crop?${optionsToQuery(options, { format, quality, response: 'json' })}`, {
    method: 'POST',
    headers: { 'Content-Type': item.type || 'application/octet-stream' },
    body: item.buffer.slice(0),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = await res.json();
  const blob = await fetch(body.dataUrl).then((r) => r.blob());
  return { blob, mime: body.mime, bounds: body.bounds, source: body.source, elapsedMs: body.elapsedMs };
}

/**
 * 统一的“检测”入口。
 * @returns 与 detectBounds 相同的结构 + { engine, algorithm, elapsedMs }
 */
export async function analyzeWith(engine, item, options) {
  if (engine === 'server') {
    const result = await analyzeOnServer(item, options);
    return result;
  }
  return analyzeLocally(item, options);
}

/** 统一的“裁剪”入口，返回 { blob, mime, filename }。 */
export async function cropWith(engine, item, options, { format, quality, filename }) {
  if (engine === 'server') {
    const result = await cropOnServer(item, options, { format, quality });
    return { ...result, filename };
  }
  const { blob, mime } = await renderCrop(item.bitmap, item.bounds, { format, quality });
  return { blob, mime, filename };
}
