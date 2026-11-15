<script setup>
/**
 * 应用级任务中心
 * --------------
 * 从顶栏「任务」打开，集中展示：
 *  - 正在运行的后台任务（视频截帧等，服务端 job）与本地任务（上传、批量抠图…），带进度；
 *  - 历史任务：已结束的服务端任务（持久化在 data/cache/jobs-history.json，重启后仍在）
 *    与本地任务（localStorage 留存）。
 * 切换工作区不会丢：任务在服务端/本地存储里，面板随时可查。
 */
import { computed } from 'vue';

import { useJobs } from '../composables/useJobs.js';

const { state, actions } = useJobs();

const running = computed(() => {
  const jobs = state.jobs.filter((job) => job.status === 'running').map((job) => ({ ...job, kind: 'server' }));
  const locals = state.localTasks.filter((task) => task.status === 'running').map((task) => ({ ...task, kind: 'local' }));
  return [...jobs, ...locals].sort((a, b) => b.startedAt - a.startedAt);
});

const finished = computed(() => {
  const hidden = new Set(state.hiddenFinished);
  const jobs = state.jobs.filter((job) => job.status !== 'running').map((job) => ({ ...job, kind: 'server' }));
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
  if (item.status === 'running') return item.detail || '进行中…';
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
            <div v-for="item in running" :key="item.id" class="tc-item is-running">
              <div class="tc-item-head">
                <span class="tc-dot"></span>
                <span class="tc-label" :title="item.label">{{ item.label }}</span>
                <span class="tc-time mono">{{ timeText(item.startedAt) }}</span>
              </div>
              <div class="tc-bar"><span :style="{ width: `${Math.round((item.progress ?? 0) * 100)}%` }"></span></div>
              <div class="tc-detail mono">{{ statusText(item) }}</div>
            </div>
          </section>

          <section class="tc-section">
            <div class="tc-section-head">
              <h3 class="tc-section-title">历史任务</h3>
              <button class="btn is-mini is-ghost" type="button" :disabled="!finished.length" @click="clearFinished">清空列表</button>
            </div>
            <p v-if="!finished.length" class="tc-empty muted">暂无历史任务</p>
            <div v-for="item in finished" :key="item.id" class="tc-item" :class="`is-${item.status}`">
              <div class="tc-item-head">
                <span class="tc-icon">{{ item.status === 'done' ? '✓' : '!' }}</span>
                <span class="tc-label" :title="item.label">{{ item.label }}</span>
                <span class="tc-time mono">{{ timeText(item.finishedAt || item.startedAt) }}</span>
              </div>
              <div class="tc-detail mono">{{ resultSum(item) || statusText(item) }}</div>
            </div>
          </section>
        </div>

        <footer class="tc-foot muted">历史任务会保留最近 50 条（服务端持久化），本地任务保存在浏览器里</footer>
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
  width: min(380px, 92vw);
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
}

.tc-section-title {
  margin: 0 0 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
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
}

.tc-item.is-running {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
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

.tc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: tc-pulse 1.2s ease-in-out infinite;
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

.tc-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 9px;
}
</style>
