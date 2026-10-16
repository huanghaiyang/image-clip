<script setup>
/** 底部状态栏：Node 服务端连接状态、当前操作提示、素材统计。 */
import { computed } from 'vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { formatBytes } from '../lib/imaging.js';

const { state, stats, meta } = useWorkspace();

const serverText = computed(() => {
  if (!state.server.checked) return '正在检查 Node 服务端…';
  if (!state.server.ok) return 'Node 服务端未连接 · 当前使用浏览器引擎（npm run dev:server 可启用）';
  const sharp = state.server.sharp ? `sharp ${state.server.sharp}` : 'sharp 版本未知';
  return `Node 服务端已连接 · ${sharp} · 算法 ${state.server.algorithm ?? meta.ALGORITHM}`;
});

const message = computed(() => state.error || state.status || '就绪');
</script>

<template>
  <footer class="statusbar">
    <div class="status-left">
      <span class="status-dot" :class="{ 'is-ok': state.server.ok, 'is-bad': state.server.checked && !state.server.ok }" />
      <span class="status-text" :title="serverText">{{ serverText }}</span>
    </div>
    <div class="status-message" :class="{ 'is-error': Boolean(state.error) }">{{ message }}</div>
    <div class="status-right">
      <span v-if="state.busy" class="busy">处理中…</span>
      <span class="mono">{{ stats.total }} 张 · {{ stats.ready }} 可裁剪 · {{ formatBytes(stats.sourceBytes) }}</span>
      <span class="chip mono">{{ state.engine === 'server' ? 'node-sharp' : 'browser-canvas' }}</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 26px;
  padding: 0 12px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.status-right {
  justify-content: flex-end;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  flex: none;
}

.status-dot.is-ok {
  background: var(--ok);
}

.status-dot.is-bad {
  background: var(--warn);
}

.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-message {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.status-message.is-error {
  color: var(--danger);
}

.busy {
  color: var(--accent);
}
</style>
