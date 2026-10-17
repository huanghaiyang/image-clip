/**
 * 对话编排（agent loop）：模型决策 → 本地工具执行 → 结果回灌 → 直到给出回答。
 *
 * 这一层是"大模型实现水印识别与去除 / 任意图片操作"的核心：
 *   - 工具全部在本机执行（见 tools.js），图片不出机；
 *   - 支持多轮会话：artifact 落在 data/artifacts，靠 id 跨轮引用；
 *   - 每一轮最多 maxToolSteps 次工具调用，防止模型自己绕圈。
 */
import crypto from 'node:crypto';

import { artifactView, getSessionArtifact, saveArtifact } from './assets.js';
import { chatCompletion, toDataUrl, userMessageWithImage } from './client.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { getActiveProvider, getProvider } from './providers.js';

const MAX_TOOL_STEPS = 6;
const MAX_HISTORY_MESSAGES = 24;

/** 会话表（进程内；重启后历史丢失，artifact 仍在磁盘上可继续引用）。 */
const sessions = new Map();

const SYSTEM_PROMPT = `你是 image-clip 的图片处理助手，运行在用户本机。

规则：
1. 你**没有**直接看/改图片的能力，只能通过工具操作。先 list_assets 看有哪些素材，必要时 image_info 了解尺寸/透明占比。
2. 用户说"去水印/识别水印"时：先 detect_watermark（优先 method="model"；若内容是插画/照片且怀疑误检，改用 method="yolo"），把 coverage、boxes、mask 的 id 告诉用户；再去 remove_watermark（传 maskId）。
3. 用户说"裁掉透明边/缩放/转格式/导出"时，调用对应工具，然后报告 artifact 的 id 与 url。
4. 不要编造像素级结果：数字一律来自工具返回值。工具返回 ok:false 时如实说明原因并给出下一步建议。
5. 回答用中文、简短；涉及图片时给出 markdown 图片链接（用工具返回的 url）。
6. 所有处理都在本机完成；除非用户明确要求，不要建议上传到云端。

工具调用协议（重要）：
- 如果你能直接发起 function calling，就用它；
- 否则**必须**只输出一个 JSON 对象、不要任何其他文字，格式：
  {"tool": "<工具名>", "arguments": { ... }}
  可用的工具名与参数：list_assets、image_info{assetId}、crop_transparent{assetId}、
  resize_image{assetId,width?,height?}、convert_image{assetId,format,quality?}、
  detect_watermark{assetId,method?,sensitivity?}、remove_watermark{assetId,maskId?,engine?}、
  save_artifact{artifactId,filename?}。
- 系统会把工具结果以 "【工具结果】" 开头的消息发回给你；拿到结果后再决定下一步或直接回答用户。`;

export function createSession({ providerId = null, title = '' } = {}) {
  const id = `c_${crypto.randomBytes(8).toString('hex')}`;
  const session = {
    id,
    title,
    providerId,
    messages: [],
    assets: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

export function listSessions() {
  return [...sessions.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((s) => ({ id: s.id, title: s.title, providerId: s.providerId, assets: s.assets.length, messages: s.messages.length, updatedAt: s.updatedAt }));
}

/** 把上传的图片挂到会话上（同时记进 assets 列表，供 list_assets 使用）。 */
export function attachImage(sessionId, buffer, { mime = 'image/png', width = null, height = null, label = '上传图片' } = {}) {
  let session = sessions.get(sessionId);
  if (!session) session = createSession({ title: label });
  const ext = mime.includes('jpeg') ? 'jpeg' : mime.includes('webp') ? 'webp' : 'png';
  const meta = saveArtifact(buffer, {
    ext,
    kind: 'source',
    label,
    width,
    height,
    sessionId: session.id,
    meta: { mime },
  });
  session.assets.push({ ...meta, mime });
  session.updatedAt = new Date().toISOString();
  return { session, asset: { ...meta, url: `/api/llm/artifact/${meta.id}` } };
}

/** 从自由文本里解析"提示式工具调用"（给不支持 function calling 的模型用）。 */
function parsePromptedToolCall(content, knownTools) {
  if (!content || typeof content !== 'string') return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const name = parsed?.tool ?? parsed?.name ?? parsed?.function?.name;
  if (!name || !knownTools.has(name)) return null;
  let args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { name, arguments: args };
}

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

function trimmedForModel(result) {
  // 回灌给模型的工具结果要精简（别把整张掩膜塞进去）
  const clone = JSON.parse(JSON.stringify(result));
  return clone;
}

/**
 * 跑一轮对话（含工具调用循环）。
 * @param {{sessionId:string, message:string, providerId?:string, attachLatestImage?:boolean, onEvent?:(e:object)=>void}} params
 */
export async function runChat({ sessionId, message, providerId = null, attachLatestImage = true, onEvent }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);
  const provider = providerId ? getProvider(providerId) : getActiveProvider();
  if (!provider) throw new Error('没有可用的模型提供方，请先在设置里配置');

  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // 事件回调（SSE 写失败等）不应中断整个对话
    }
  };

  const history = session.messages.slice(-MAX_HISTORY_MESSAGES);
  const userContent = message?.trim() || '（无文字，请直接处理当前图片）';
  const latestAsset = session.assets[session.assets.length - 1] ?? null;
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  if (attachLatestImage && latestAsset && provider.vision !== false) {
    const found = getSessionArtifact(session.id, latestAsset.id);
    if (found) {
      messages.push(userMessageWithImage(userContent, toDataUrl(found.mime, found.buffer)));
      emit({ type: 'image_attached', artifact: artifactView(found.meta) });
    } else {
      messages.push({ role: 'user', content: userContent });
    }
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  const producedArtifacts = [];
  const toolTraces = [];
  let finalText = '';

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const reply = await chatCompletion(provider, { messages, tools: TOOL_DEFINITIONS });
    emit({ type: 'model_reply', elapsedMs: reply.elapsedMs, model: reply.model });

    // 原生 function calling 优先；模型只会说文字时，退回到"提示式工具调用"
    let calls = reply.toolCalls;
    if (!calls.length) {
      const prompted = parsePromptedToolCall(reply.content, TOOL_NAMES);
      if (prompted) {
        calls = [{ id: `prompted_${step}`, name: prompted.name, arguments: JSON.stringify(prompted.arguments) }];
        emit({ type: 'prompted_tool_call', name: prompted.name, args: prompted.arguments });
      }
    }

    if (calls.length) {
      messages.push({
        role: 'assistant',
        content: reply.content || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of calls) {
        let args = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          args = {};
        }
        emit({ type: 'tool_call', id: call.id, name: call.name, args });
        let result;
        try {
          result = await executeTool(call.name, args, { sessionId: session.id, assets: session.assets });
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        toolTraces.push({ name: call.name, args, ok: result.ok !== false, result });
        for (const key of ['artifact', 'mask']) {
          if (result?.[key]?.id) producedArtifacts.push(result[key]);
        }
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: result.ok !== false, result: trimmedForModel(result) });
        if (call.id.startsWith('prompted_')) {
          messages.push({ role: 'user', content: `【工具结果】${call.name}: ${JSON.stringify(trimmedForModel(result))}` });
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(trimmedForModel(result)) });
        }
      }
      continue;
    }

    finalText = reply.content ?? '';
    messages.push({ role: 'assistant', content: finalText });
    break;
  }

  if (!finalText) {
    finalText = '（模型未给出最终回答；可能是工具调用步数达到上限）';
  }

  // 持久化：把本次往返写进会话历史（只留文字，避免历史里塞图片撑爆上下文）
  session.messages.push({ role: 'user', content: userContent });
  for (const trace of toolTraces) {
    session.messages.push({ role: 'tool_trace', content: JSON.stringify({ name: trace.name, ok: trace.ok }) });
  }
  session.messages.push({ role: 'assistant', content: finalText });
  session.updatedAt = new Date().toISOString();

  emit({ type: 'done', text: finalText, artifacts: producedArtifacts, toolCalls: toolTraces.length, provider: { id: provider.id, model: provider.model } });
  return { text: finalText, artifacts: producedArtifacts, toolTraces, provider };
}
