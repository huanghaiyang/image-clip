<script setup>
/**
 * 临时会话弹窗
 * ------------
 * 展示当前会被暂存的现场（素材 / 资源库位置 / 视频 / 音频 / AI 对话），
 * 提供「立即暂存」与「清空并丢弃」。丢弃会二次确认，且不删除资源库里的文件。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';

import { useWorkSession } from '../composables/useWorkSession.js';
import { useConfirm } from '../composables/useConfirm.js';

const emit = defineEmits(['close']);

const { state, summary, actions } = useWorkSession();
const { confirm } = useConfirm();

const savedText = computed(() => {
  if (state.saving) return '正在暂存…';
  if (!state.savedAt) return state.hasSession ? '已有临时会话' : '尚未暂存';
  const time = new Date(state.savedAt).toLocaleString('zh-CN', { hour12: false });
  return `上次暂存 ${time}`;
});

async function discard() {
  const ok = await confirm({
    title: '清空临时会话？',
    message: '素材、图片工具现场、资源库选择、视频/音频位置与 AI 对话都会被清空，且无法撤销。',
    detail: '资源库里的文件不会被删除。',
    confirmText: '清空并丢弃',
    danger: true,
  });
  if (!ok) return;
  await actions.discard();
  emit('close');
}

/** 会话弹窗是模态层：Esc 关闭，同时截断数字键切换工作区等全局快捷键。 */
function onWindowKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    emit('close');
    return;
  }
  event.stopImmediatePropagation();
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div class="session-backdrop" @click.self="emit('close')">
      <div class="session-dialog" role="dialog" aria-modal="true" aria-label="临时会话">
        <header class="session-head">
          <span class="session-dot" :class="{ 'is-saving': state.saving, 'is-saved': !state.saving && state.hasSession }" />
          <div class="session-titles">
            <h2>临时会话</h2>
            <p class="session-sub">{{ savedText }}</p>
          </div>
        </header>

        <ul v-if="summary.parts.length" class="session-list">
          <li v-for="part in summary.parts" :key="part">{{ part }}</li>
        </ul>
        <p v-else class="session-empty">当前还没有可暂存的操作。</p>

        <p class="session-tip">
          自动暂存未提交的现场，刷新页面或重新打开应用后原地恢复；同一时间只保留一个临时会话。
        </p>
        <p v-if="state.error" class="session-error">{{ state.error }}</p>

        <footer class="session-foot">
          <button
            class="btn is-mini is-danger"
            type="button"
            :disabled="state.saving || !summary.parts.length"
            @click="discard"
          >
            清空并丢弃
          </button>
          <span class="session-spacer" />
          <button class="btn is-mini is-ghost" type="button" @click="emit('close')">关闭</button>
          <button class="btn is-mini is-primary" type="button" :disabled="state.saving" @click="actions.saveNow()">
            {{ state.saving ? '正在暂存…' : '立即暂存' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.session-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
}

.session-dialog {
  width: min(440px, 100%);
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  animation: session-in 0.14s ease-out;
}

@keyframes session-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.session-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 18px 18px 10px;
}

.session-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--text-muted);
}

.session-dot.is-saved {
  background: var(--accent);
}

.session-dot.is-saving {
  background: #e8a33d;
}

.session-titles h2 {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.session-sub {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 11px;
}

.session-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0 18px;
  list-style: none;
}

.session-list li {
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 11px;
}

.session-empty {
  margin: 0;
  padding: 0 18px;
  color: var(--text-muted);
  font-size: 12px;
}

.session-tip {
  margin: 12px 0 0;
  padding: 0 18px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.session-error {
  margin: 8px 0 0;
  padding: 0 18px;
  color: var(--danger);
  font-size: 11px;
}

.session-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px 16px;
}

.session-spacer {
  flex: 1;
}
</style>
