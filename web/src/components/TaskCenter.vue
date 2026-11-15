<script setup>
/**
 * 应用级任务中心（多用户 / 并发 / 日志）
 * ---------------------------------------
 * - 普通用户只看自己的任务；管理员可勾选「全部用户」查看所有人的任务；
 * - 任务有 queued / running / done / failed / cancelled 状态，排队时显示队列位置；
 * - 点任意任务可查看它的完整日志尾部（JSONL 解析成可读行）；运行中的任务自动刷新。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { useJobs } from '../composables/useJobs.js';
import { fetchJobLog } from '../lib/jobs.js';

const { state, actions } = useJobs();

const selectedId = ref('');
const log = ref({ jobId: '', file: '', lines: [], loading: false, error: '' });
let logTimer = 0;

const mergedJobs = computed(() => state.jobs);

const running = computed(() => {
  const jobs = mergedJobs.value
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .map((job) => ({ ...job, kind: 'server' }));
  const locals = state.localTasks.filter((task) => task.status === 'running').map((task) => ({ ...task, kind: 'local' }));
  return [...jobs, ...locals].sort((a, b) => (a.enqueuedAt || a.startedAt) - (b.enqueuedAt || b.startedAt));
});

const finished = computed(() => {
  const hidden = new Set(state.hiddenFinished);
  const jobs = mergedJobs.value
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .map((job) => ({ ...job, kind: 'server' }));
  const locals = state.localTasks.filter((task) => task.status !== 'running').map((task) => ({ ...task, kind: 'local' }));
  return [...jobs, ...locals]
    .filter((item) => !hidden.has(item.id))
    .sort((a, b) => (b.finishedAt || b.startedAt) - (a.finishedAt || a.startedAt))
    .slice(0, 30);
});

const runningCount = computed(() => running.value.length);

function timeText(at) {
  if (!at) return '';
  const date = new Date(at);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}

function statusText(item) {
  if (item.status === 'queued') return `排队中${item.queuePosition ? ` · 第 ${item.queuePosition} 位` : ''}`;
  if (item.status === 'running') return item.detail || '进行中…';
  if (item.status === 'cancelled') return item.detail || '已取消';
  if (item.status === 'failed') return item.error || item.detail || '失败';
  return item.detail || '已完成';
}

function resultSum(item) {
  const result = item.result;
  if (!result) return '';
  if (item.type === 'video.frames') return `${result.extracted ?? 0}/${result.requested ?? 0} 帧 → 资源库/${result.folder ?? ''}`;
  return '';
}

function clearFinished() {
  actions.hideFinished([]);
}

/** 选中任务并加载日志；运行中的任务每 1.5s 刷新一次。 */
async function selectJob(item) {
  if (item.kind !== 'server') return;
  selectedId.value = item.id;
  await loadLog(item.id);
  if (logTimer) clearInterval(logTimer);
  logTimer = 0;
  const stillRunning = () => {
    const job = mergedJobs.value.find((entry) => entry.id === item.id);
    return job && (job.status === 'running' || job.status === 'queued');
  };
  if (stillRunning()) {
    logTimer = window.setInterval(async () => {
      if (!stillRunning()) {
        clearInterval(logTimer);
        logTimer = 0;
      }
      await loadLog(item.id);
    }, 1500);
  }
}

async function loadLog(id) {
  log.value = { ...log.value, jobId: id, loading: true, error: '' };
  try {
    const data = await fetchJobLog(id, { limit: 300 });
    const lines = (data.lines ?? []).map((raw) => {
      try {
        const line = JSON.parse(raw);
        return { t: line.t, level: line.level, msg: line.msg, scope: line.scope, extra: line };
      } catch {
        return { t: '', level: 'info', msg: raw, scope: '' };
      }
    });
    log.value = { jobId: id, file: data.file, lines, loading: false, error: '' };
  } catch (err) {
    log.value = { jobId: id, file: '', lines: [], loading: false, error: err.message };
  }
}

function closeLog() {
  selectedId.value = '';
  if (logTimer) clearInterval(logTimer);
  logTimer = 0;
}

function formatLogTime(t) {
  if (!t) return '';
  const date = new Date(t);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

onBeforeUnmount(() => {
  if (logTimer) clearInterval(logTimer);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="state.centerOpen" class="tc-mask" @click.self="actions.toggleCenter(false)">
      <aside class="tc-panel" role="dialog" aria-label="任务中心">
        <header class="tc-head">
          <div class="tc-title">
            任务中心
            <span v-if="runningCount" class="tc-badge">{{ runningCount }} 个进行中</span>
          </div>
          <button class="tc-close" type="button" title="关闭 (Esc)" @click="actions.toggleCenter(false)">×</button>
        </header>

        <div class="tc-body">
          <section class="tc-section">
            <h3 class="tc-section-title">进行中</h3>
            <p v-if="!running.length" class="tc-empty muted">没有正在运行的任务</p>
            <div
              v-for="item in running"
              :key="item.id"
              class="tc-item is-running"
              :class="{ 'is-selected': item.id === selectedId, 'is-queued': item.status === 'queued' }"
              @click="selectJob(item)"
            >
              <div class="tc-item-head">
                <span class="tc-dot" :class="{ 'is-queued': item.status === 'queued' }"></span>
                <span class="tc-label" :title="item.label">{{ item.label }}</span>
                <span class="tc-time mono">{{ timeText(item.enqueuedAt || item.startedAt) }}</span>
              </div>
              <div class="tc-bar">
                <span :style="{ width: `${Math.round((item.progress ?? 0) * 100)}%` }"></span>
              </div>
              <div class="tc-detail mono">{{ statusText(item) }}</div>
            </div>
          </section>

          <section class="tc-section">
            <div class="tc-section-head">
              <h3 class="tc-section-title">历史任务</h3>
              <button class="btn is-mini is-ghost" type="button" :disabled="!finished.length" @click="clearFinished">清空列表</button>
            </div>
            <p v-if="!finished.length" class="tc-empty muted">暂无历史任务</p>
            <div
              v-for="item in finished"
              :key="item.id"
              class="tc-item"
              :class="[`is-${item.status}`, { 'is-selected': item.id === selectedId }]"
              @click="selectJob(item)"
            >
              <div class="tc-item-head">
                <span class="tc-icon">{{ item.status === 'done' ? '✓' : item.status === 'cancelled' ? '–' : '!' }}</span>
                <span class="tc-label" :title="item.label">{{ item.label }}</span>
                <span class="tc-time mono">{{ timeText(item.finishedAt || item.startedAt) }}</span>
              </div>
              <div class="tc-detail mono">{{ resultSum(item) || statusText(item) }}</div>
            </div>
          </section>

          <section v-if="selectedId" class="tc-log">
            <div class="tc-section-head">
              <h3 class="tc-section-title">
                任务日志
                <span class="muted mono tc-log-file">{{ log.file }}</span>
              </h3>
              <span class="tc-log-actions">
                <button class="btn is-mini is-ghost" type="button" :disabled="log.loading" @click="loadLog(selectedId)">刷新</button>
                <button class="btn is-mini is-ghost" type="button" @click="closeLog">关闭</button>
              </span>
            </div>
            <p v-if="log.error" class="tc-log-error">{{ log.error }}</p>
            <p v-else-if="log.loading && !log.lines.length" class="tc-empty muted">读取日志…</p>
            <p v-else-if="!log.lines.length" class="tc-empty muted">这个任务还没有日志（可能刚创建）。</p>
            <pre v-else class="tc-log-body">{{ log.lines.map((line) => `${formatLogTime(line.t)} ${String(line.level).toUpperCase().padEnd(5)} ${line.msg}${line.extra?.detail ? ` · ${line.extra.detail}` : ''}${line.extra?.error ? ` · ${line.extra.error}` : ''}`).join('\n') }}</pre>
          </section>
        </div>

        <footer class="tc-foot muted">历史任务保留最近 200 条（服务端持久化）；任务日志按天+按任务落盘，可在数据目录 data/logs 查看</footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.tc-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.35);
}

.tc-panel {
  display: flex;
  flex-direction: column;
  width: min(460px, 94vw);
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--border-strong);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.4);
}

.tc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}

.tc-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tc-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.tc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.tc-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9px;
}

.tc-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
}

.tc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
}

.tc-section {
  margin-bottom: 14px;
}

.tc-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tc-section-title {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tc-empty {
  margin: 6px 2px 10px;
  font-size: 10px;
}

.tc-item {
  padding: 7px 8px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  cursor: pointer;
}

.tc-item.is-running {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}

.tc-item.is-queued {
  border-style: dashed;
}

.tc-item.is-selected {
  outline: 1px solid var(--accent);
}

.tc-item.is-failed {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}

.tc-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tc-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text);
}

.tc-time {
  flex: none;
  font-size: 9px;
  color: var(--text-muted);
}

.tc-user {
  flex: none;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 9px;
  color: var(--text-muted);
}

.tc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: tc-pulse 1.2s ease-in-out infinite;
}

.tc-dot.is-queued {
  background: var(--text-muted);
  animation: none;
}

.tc-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: var(--text-muted);
}

.tc-item.is-done .tc-icon {
  background: #14ae5c;
}

.tc-item.is-failed .tc-icon {
  background: var(--danger);
}

.tc-item.is-cancelled .tc-icon {
  background: #8a8f98;
}

@keyframes tc-pulse {
  50% {
    opacity: 0.35;
  }
}

.tc-bar {
  margin-top: 6px;
  height: 3px;
  border-radius: 999px;
  background: var(--panel-3);
  overflow: hidden;
}

.tc-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}

.tc-detail {
  margin-top: 4px;
  font-size: 9px;
  color: var(--text-muted);
  word-break: break-all;
}

.tc-log {
  margin-top: 4px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.tc-log-file {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  font-size: 8px;
  font-weight: 400;
}

.tc-log-actions {
  display: flex;
  gap: 4px;
}

.tc-log-body {
  max-height: 260px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #15161a;
  color: #c9d1d9;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 9px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.tc-log-error {
  margin: 6px 0;
  font-size: 10px;
  color: var(--danger);
}

.tc-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 9px;
}
</style>
