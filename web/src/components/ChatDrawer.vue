<script setup>
/**
 * 大模型对话抽屉：第 4 条需求的界面入口。
 *
 * 设计取舍：
 *  - 做成**右侧浮层**而不是新开一个"模式"：切模式会打断当前的裁剪/去水印工作流，
 *    而对话常常是"边看边问"；
 *  - 工具调用轨迹直接展示（叫了什么工具、参数、成功与否）——本地模型慢，
 *    让用户看到"它在干什么"比转圈更有用，也便于排查；
 *  - 提供方切换放在头部：这就是"大模型切换"的入口，切换后立即生效（下一轮对话用新端点）。
 */
import { computed, onMounted, ref, watch } from 'vue';

import { useLlmChat } from '../composables/useLlmChat.js';

const { state, activeProvider, actions } = useLlmChat();

const input = ref('');
const fileInput = ref(null);
const scroller = ref(null);

const QUICK = [
  { label: '检测并去除水印', text: '请检测这张图里的水印并去除，检测优先用 method=model；如果怀疑把画面内容误检成水印，改用 method=yolo。' },
  { label: '裁掉透明边', text: '帮我裁掉这张图四周的透明/纯色区域。' },
  { label: '缩放到 800 宽', text: '把这张图缩放到 800 像素宽。' },
  { label: '转成 webp', text: '把这张图转成 webp 格式（质量 90）。' },
];

const statusText = computed(() => {
  if (state.loading) return '检测中…';
  if (state.activeError) return `不可达：${state.activeError}`;
  return state.activeReachable ? '已连接' : '未连接';
});

const statusClass = computed(() => {
  if (state.loading) return 'pending';
  if (state.activeError) return 'bad';
  return state.activeReachable ? 'ok' : 'idle';
});

function scrollToBottom() {
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => [state.messages.length, state.busy],
  () => requestAnimationFrame(scrollToBottom),
);

onMounted(() => {
  if (!state.providers.length) void actions.refresh();
});

function pickFile() {
  fileInput.value?.click();
}

async function onFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const asset = await actions.attachImage(file, file.name);
    state.messages.push({
      id: `m_local_${Date.now()}`,
      role: 'system',
      text: `已上传：${file.name}（${asset.width}×${asset.height}），接下来可以直接说要对它做什么。`,
      artifacts: [asset],
      trace: [],
    });
  } catch (err) {
    state.messages.push({ id: `m_err_${Date.now()}`, role: 'system', text: `上传失败：${err.message}`, artifacts: [], trace: [] });
  }
}

async function submit(text) {
  const content = (text ?? input.value).trim();
  if (!content || state.busy) return;
  input.value = '';
  await actions.send(content);
}

function argsSummary(args) {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v).slice(0, 18)}`)
    .join(' ');
}

function toolResultSummary(trace) {
  const r = trace.result;
  if (!r) return '';
  if (r.ok === false) return r.error ?? '失败';
  if (typeof r.coverage === 'number') return `覆盖 ${r.coverage}%`;
  if (r.engine) return `引擎 ${r.engine}`;
  if (r.artifact?.label) return r.artifact.label;
  if (r.trimmed !== undefined) return r.trimmed ? '已裁剪' : '无需裁剪';
  return '完成';
}
</script>

<template>
  <div v-if="state.open" class="drawer-mask" @click.self="actions.close()">
    <aside class="drawer">
      <header class="drawer-head">
        <div class="title-row">
          <span class="dot" :class="statusClass" />
          <h3>AI 对话</h3>
          <span class="status">{{ statusText }}</span>
        </div>
        <div class="provider-row">
          <select :value="state.activeId" :disabled="state.busy" @change="actions.switchProvider($event.target.value)">
            <option v-for="p in state.providers" :key="p.id" :value="p.id">
              {{ p.label }}{{ p.kind === 'remote' ? ' ⚠️云端' : '' }}
            </option>
          </select>
          <button class="ghost" title="刷新连接状态" :disabled="state.busy" @click="actions.refresh()">刷新</button>
          <button class="ghost" title="关闭" @click="actions.close()">✕</button>
        </div>
        <p v-if="activeProvider?.note" class="note">{{ activeProvider.note }}</p>
        <p v-if="!state.providers.length && !state.loading" class="note warn">
          还没有可用的模型端点。先在设置里配置，或启动本地侧车：<code>npm run llm:serve</code>
        </p>
      </header>

      <div ref="scroller" class="drawer-body">
        <div v-if="!state.messages.length" class="empty">
          <p class="empty-title">用自然语言操作图片</p>
          <p class="empty-hint">
            所有像素操作都在本机完成（检测/去除/裁剪/缩放都是本地算法）；模型只负责理解你的意图并调用工具。
          </p>
          <div class="quick">
            <button v-for="q in QUICK" :key="q.label" class="quick-btn" :disabled="state.busy" @click="submit(q.text)">
              {{ q.label }}
            </button>
          </div>
        </div>

        <template v-for="message in state.messages" :key="message.id">
          <div class="msg" :class="message.role">
            <div class="bubble">
              <p v-if="message.text" class="text">{{ message.text }}</p>
              <p v-if="message.pending" class="text muted">思考中…</p>
              <p v-if="message.modelInfo" class="meta">{{ message.modelInfo }}</p>

              <ul v-if="message.trace?.length" class="trace">
                <li v-for="t in message.trace" :key="t.id" :class="t.status">
                  <span class="tool-name">{{ t.name }}</span>
                  <span v-if="argsSummary(t.args)" class="tool-args">{{ argsSummary(t.args) }}</span>
                  <span class="tool-status">
                    {{ t.status === 'running' ? '执行中…' : t.status === 'ok' ? `✓ ${toolResultSummary(t)}` : `✗ ${toolResultSummary(t)}` }}
                  </span>
                </li>
              </ul>

              <div v-if="message.artifacts?.length" class="artifacts">
                <a v-for="a in message.artifacts" :key="a.id" :href="a.url" target="_blank" rel="noreferrer" class="artifact">
                  <img :src="a.url" :alt="a.label || a.id" loading="lazy" />
                  <span class="artifact-label">{{ a.label || a.kind }}</span>
                </a>
              </div>
            </div>
          </div>
        </template>
      </div>

      <footer class="drawer-foot">
        <div class="foot-row">
          <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
          <button class="ghost" :disabled="state.busy" title="上传一张图片给 AI 处理" @click="pickFile">＋ 图片</button>
          <span class="hint">本地模型推理较慢（CPU 常见 30~120s），期间可继续操作画布</span>
        </div>
        <div class="input-row">
          <textarea
            v-model="input"
            :disabled="state.busy"
            placeholder="例如：把右下角的水印去掉；裁掉透明边；缩放到 800 宽…"
            rows="2"
            @keydown.enter.exact.prevent="submit()"
          />
          <button class="primary" :disabled="state.busy || !input.trim()" @click="submit()">
            {{ state.busy ? '处理中…' : '发送' }}
          </button>
        </div>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.35);
}

.drawer {
  display: flex;
  flex-direction: column;
  width: min(440px, 92vw);
  height: 100%;
  background: var(--panel, #1b1b1e);
  border-left: 1px solid var(--line, #2e2e33);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.35);
}

.drawer-head {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line, #2e2e33);
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-row h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.status {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted, #8a8a93);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
}

.dot.ok { background: #34d399; }
.dot.bad { background: #f87171; }
.dot.pending { background: #fbbf24; animation: pulse 1s infinite alternate; }

@keyframes pulse { from { opacity: 0.35; } to { opacity: 1; } }

.provider-row {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.provider-row select {
  flex: 1;
  min-width: 0;
  background: var(--bg, #131316);
  color: inherit;
  border: 1px solid var(--line, #2e2e33);
  border-radius: 6px;
  padding: 5px 7px;
  font-size: 12px;
}

.note {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted, #8a8a93);
}

.note.warn { color: #fbbf24; }
.note code { font-size: 11px; }

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty { padding: 8px 2px; }
.empty-title { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.empty-hint { margin: 0 0 12px; font-size: 12px; line-height: 1.6; color: var(--muted, #8a8a93); }

.quick { display: flex; flex-wrap: wrap; gap: 6px; }

.quick-btn {
  background: var(--bg, #131316);
  border: 1px solid var(--line, #2e2e33);
  color: inherit;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.quick-btn:hover { border-color: var(--accent, #3b82f6); }

.msg { display: flex; }
.msg.user { justify-content: flex-end; }

.bubble {
  max-width: 92%;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--bg, #131316);
  border: 1px solid var(--line, #2e2e33);
  font-size: 12.5px;
  line-height: 1.6;
}

.msg.user .bubble {
  background: var(--accent, #3b82f6);
  border-color: transparent;
  color: #fff;
}

.msg.system .bubble { background: transparent; border-style: dashed; color: var(--muted, #8a8a93); }

.text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.text.muted { color: var(--muted, #8a8a93); }
.meta { margin: 6px 0 0; font-size: 10.5px; color: var(--muted, #8a8a93); }

.trace { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }

.trace li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.03);
}

.trace li.running { color: #fbbf24; }
.trace li.ok .tool-status { color: #34d399; }
.trace li.fail .tool-status { color: #f87171; }
.tool-name { font-family: ui-monospace, monospace; color: var(--accent, #3b82f6); }
.tool-args { color: var(--muted, #8a8a93); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-status { margin-left: auto; }

.artifacts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }

.artifact {
  display: block;
  width: 96px;
  border: 1px solid var(--line, #2e2e33);
  border-radius: 6px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  background: #0d0d10;
}

.artifact img { display: block; width: 100%; height: 66px; object-fit: contain; }
.artifact-label { display: block; padding: 3px 5px; font-size: 10.5px; color: var(--muted, #8a8a93); }

.drawer-foot {
  border-top: 1px solid var(--line, #2e2e33);
  padding: 10px 12px 12px;
}

.foot-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.hint { font-size: 10.5px; color: var(--muted, #8a8a93); }

.input-row { display: flex; gap: 8px; align-items: flex-end; }

textarea {
  flex: 1;
  resize: none;
  background: var(--bg, #131316);
  color: inherit;
  border: 1px solid var(--line, #2e2e33);
  border-radius: 8px;
  padding: 7px 9px;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
}

textarea:focus { outline: none; border-color: var(--accent, #3b82f6); }

.ghost,
.primary {
  border-radius: 7px;
  padding: 6px 11px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--line, #2e2e33);
  background: transparent;
  color: inherit;
  white-space: nowrap;
}

.ghost:hover { border-color: var(--accent, #3b82f6); }

.primary {
  background: var(--accent, #3b82f6);
  border-color: transparent;
  color: #fff;
}

.primary:disabled,
.ghost:disabled { opacity: 0.5; cursor: default; }
</style>
