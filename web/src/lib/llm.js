/**
 * 大模型接口的前端客户端。
 *
 * 注意：对话用的是 **SSE**（后端逐条推事件：工具调用轨迹、结果、最终回答），
 * 所以这里手写一个流式解析，而不是等整包 JSON —— 否则一次 30~120s 的本地模型推理
 * 期间界面会完全没有反馈。
 */

const BASE = '/api/llm';

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  return payload;
}

export function llmHealth() {
  return jsonFetch(`${BASE}/health`);
}

export function llmProviders() {
  return jsonFetch(`${BASE}/providers`);
}

export function llmActivate(id) {
  return jsonFetch(`${BASE}/providers/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

export function llmUpdateProvider(id, patch) {
  return jsonFetch(`${BASE}/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function llmProbe(id) {
  return jsonFetch(`${BASE}/providers/${encodeURIComponent(id)}/probe`, { method: 'POST' });
}

export function llmCreateSession(payload = {}) {
  return jsonFetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 上传图片（直接发二进制），返回 { session, asset }。 */
export function llmUpload(blob, name = 'image.png', sessionId = undefined) {
  const query = new URLSearchParams({ name });
  if (sessionId) query.set('sessionId', sessionId);
  return jsonFetch(`${BASE}/assets?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
}

/**
 * 发起对话，逐个事件回调。
 * @param {{sessionId:string, message:string, providerId?:string}} payload
 * @param {(event:object)=>void} onEvent
 */
export async function llmChat(payload, onEvent) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('服务端未返回流（可能不支持 SSE）');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (block.startsWith('data:')) {
        const data = block.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          onEvent(JSON.parse(data));
        } catch {
          // 忽略非 JSON
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}
