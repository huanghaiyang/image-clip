/**
 * 大模型对话的全局状态（单例）：TopBar 的入口按钮和 ChatDrawer 共用同一份。
 *
 * 只做三件事：管提供方（接入/切换）、管会话、把 SSE 事件翻译成可渲染的消息流。
 */
import { computed, reactive } from 'vue';

import { llmActivate, llmChat, llmCreateSession, llmHealth, llmUpload } from '../lib/llm.js';

const state = reactive({
  open: false,
  loading: false,
  providers: [],
  activeId: '',
  activeReachable: false,
  activeError: null,
  sessionId: '',
  messages: [], // { id, role: 'user'|'assistant'|'system', text, artifacts:[], trace:[] }
  busy: false,
  error: null,
});

let seq = 0;
const nextId = () => `m_${(seq += 1)}`;

function pushMessage(message) {
  state.messages.push({ id: nextId(), text: '', artifacts: [], trace: [], ...message });
  return state.messages[state.messages.length - 1];
}

async function refresh() {
  state.loading = true;
  state.error = null;
  try {
    const health = await llmHealth();
    state.providers = health.providers ?? [];
    state.activeId = health.active ?? '';
    state.activeReachable = Boolean(health.activeReachable);
    state.activeError = health.activeError ?? null;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
  }
}

async function switchProvider(id) {
  state.error = null;
  try {
    const next = await llmActivate(id);
    state.providers = next.providers ?? state.providers;
    state.activeId = next.activeId ?? id;
    await refresh();
  } catch (err) {
    state.error = err.message;
  }
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const session = await llmCreateSession({ title: '对话' });
  state.sessionId = session.id;
  return state.sessionId;
}

/** 把一张图片挂到当前会话（也可作为"带图提问"的第一步）。 */
async function attachImage(blob, name) {
  const sessionId = await ensureSession();
  const { session, asset } = await llmUpload(blob, name, sessionId);
  state.sessionId = session?.id ?? sessionId;
  return asset;
}

/**
 * 发一条消息：把 SSE 事件渲染成"助手气泡 + 工具轨迹"。
 */
async function send(text) {
  const content = String(text ?? '').trim();
  if (!content || state.busy) return;
  state.error = null;
  state.busy = true;
  pushMessage({ role: 'user', text: content });
  const assistant = pushMessage({ role: 'assistant', text: '', pending: true });

  try {
    const sessionId = await ensureSession();
    await llmChat({ sessionId, message: content }, (event) => {
      switch (event.type) {
        case 'image_attached':
          assistant.attachedImage = event.artifact;
          break;
        case 'model_reply':
          assistant.modelInfo = `${event.model} · ${(event.elapsedMs / 1000).toFixed(1)}s`;
          break;
        case 'tool_call':
          assistant.trace.push({ id: event.id, name: event.name, args: event.args, status: 'running' });
          break;
        case 'tool_result': {
          const trace = assistant.trace.find((t) => t.id === event.id);
          if (trace) {
            trace.status = event.ok ? 'ok' : 'fail';
            trace.result = event.result;
          }
          const artifact = event.result?.mask ?? event.result?.artifact;
          if (artifact) assistant.artifacts.push(artifact);
          break;
        }
        case 'done':
          assistant.text = event.text ?? '';
          assistant.pending = false;
          if (Array.isArray(event.artifacts)) {
            for (const artifact of event.artifacts) {
              if (!assistant.artifacts.some((a) => a.id === artifact.id)) assistant.artifacts.push(artifact);
            }
          }
          break;
        case 'error':
          assistant.text = `⚠️ ${event.error}`;
          assistant.pending = false;
          state.error = event.error;
          break;
        default:
          break;
      }
    });
    if (assistant.pending) {
      assistant.pending = false;
      assistant.text = assistant.text || '（无输出）';
    }
  } catch (err) {
    assistant.pending = false;
    assistant.text = `⚠️ ${err.message}`;
    state.error = err.message;
  } finally {
    state.busy = false;
  }
}

const activeProvider = computed(() => state.providers.find((p) => p.id === state.activeId) ?? null);

export function useLlmChat() {
  return {
    state,
    activeProvider,
    actions: { refresh, switchProvider, attachImage, send, open: () => (state.open = true), close: () => (state.open = false), toggle: () => (state.open = !state.open) },
  };
}
