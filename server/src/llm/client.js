/**
 * OpenAI 兼容的聊天客户端。
 *
 * 只依赖 `/v1/chat/completions`（含 function calling）这一条通用协议，
 * 于是"本地 DeepSeek-VL2 侧车 / Ollama / 云端服务"共用同一份代码 ——
 * 切换提供方只是换 baseUrl+model（见 providers.js）。
 */

const DEFAULT_TIMEOUT_MS = 180000;

function normalizeToolCalls(raw) {
  const calls = raw?.choices?.[0]?.message?.tool_calls ?? [];
  return calls.map((c, i) => ({
    id: c.id ?? `call_${i}`,
    name: c.function?.name ?? '',
    arguments: c.function?.arguments ?? '{}',
  }));
}

/**
 * 发一次 chat completion。
 * @param {{baseUrl:string, model:string, apiKey?:string}} provider
 * @param {{messages:Array, tools?:Array, temperature?:number, maxTokens?:number, timeoutMs?:number}} req
 */
export async function chatCompletion(provider, req) {
  if (!provider) throw new Error('没有可用的模型提供方');
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: provider.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.2,
    max_tokens: req.maxTokens ?? 1024,
    stream: false,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? 'auto';
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // 连接失败几乎总是"端点没起/地址不对"，给出能直接行动的提示
    throw new Error(
      `连接模型服务失败（${provider.baseUrl}）：${err.message}。` +
        '本地模型请先启动侧车（npm run llm:serve）或在设置里改 baseUrl。',
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint =
      res.status === 401
        ? 'API key 无效'
        : res.status === 404
          ? '端点不存在或模型名不对（检查 baseUrl 是否带 /v1、model 是否已 pull）'
          : '';
    throw new Error(`模型服务返回 HTTP ${res.status}${hint ? `：${hint}` : ''} ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const message = json?.choices?.[0]?.message ?? {};
  return {
    content: message.content ?? '',
    toolCalls: normalizeToolCalls(json),
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
    usage: json?.usage ?? null,
    model: json?.model ?? provider.model,
    elapsedMs: Date.now() - started,
    raw: json,
  };
}

/** 组装一条带图片的用户消息（OpenAI 多模态内容数组）。 */
export function userMessageWithImage(text, imageDataUrl) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  };
}

export function toDataUrl(mime, buffer) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
