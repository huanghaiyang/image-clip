<script setup>
/**
 * 全局确认弹窗
 * ------------
 * 由 useConfirm 的 confirm(options) 驱动，替代 window.confirm。
 * 支持 Esc / 点击遮罩取消，确认按钮自动聚焦，可用 Enter 直接确认。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useConfirm } from '../composables/useConfirm.js';

const { state, actions } = useConfirm();
const confirmBtn = ref(null);

watch(
  () => state.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    confirmBtn.value?.focus();
  },
);

/**
 * 确认框可能叠在回收站等自带 Esc 监听的弹窗之上。
 * 在 window 捕获阶段处理 Esc，阻止事件继续传播，避免连带关闭下层弹窗。
 */
function onWindowKeydown(event) {
  if (!state.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  actions.cancel();
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="confirm-backdrop" @click.self="actions.cancel()">
      <div
        class="confirm-dialog"
        :class="{ 'is-danger': state.danger }"
        role="alertdialog"
        aria-modal="true"
        :aria-label="state.title"
      >
        <div class="confirm-body">
          <span class="confirm-icon" aria-hidden="true">{{ state.danger ? '!' : '?' }}</span>
          <div class="confirm-text">
            <h2>{{ state.title }}</h2>
            <p v-if="state.message" class="confirm-message">{{ state.message }}</p>
            <p v-if="state.detail" class="confirm-detail mono" :title="state.detail">{{ state.detail }}</p>
          </div>
        </div>
        <div class="confirm-foot">
          <button class="btn is-mini is-ghost" type="button" @click="actions.cancel()">
            {{ state.cancelText }}
          </button>
          <button
            ref="confirmBtn"
            class="btn is-mini"
            :class="{ 'is-danger': state.danger }"
            type="button"
            @click="actions.accept()"
          >
            {{ state.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 96;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
}

.confirm-dialog {
  width: min(400px, 100%);
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  animation: confirm-in 0.14s ease-out;
}

@keyframes confirm-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.confirm-body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 18px 14px;
}

.confirm-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.confirm-dialog.is-danger .confirm-icon {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}

.confirm-text {
  flex: 1;
  min-width: 0;
}

.confirm-text h2 {
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.confirm-message {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-line;
}

.confirm-detail {
  margin: 6px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 10px;
}

.confirm-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 18px 16px;
}

.mono {
  font-family: var(--mono);
}
</style>
