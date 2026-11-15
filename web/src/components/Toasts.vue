<script setup>
/**
 * 右下角通知气泡栈
 * ----------------
 * 多个任务同时进行时纵向堆叠，最新的在最上面；进度型通知原地更新（同一 id），
 * 结束后变成成功/失败样式并自动消失。每条都可以手动关闭。
 */
import { useToasts } from '../composables/useToasts.js';

const { state, actions } = useToasts();

function icon(kind) {
  if (kind === 'success') return '✓';
  if (kind === 'error') return '!';
  if (kind === 'progress') return '…';
  return 'i';
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <div v-for="toast in state.items" :key="toast.id" class="toast" :class="`is-${toast.kind}`">
          <span class="toast-icon" aria-hidden="true">{{ icon(toast.kind) }}</span>
          <div class="toast-body">
            <div v-if="toast.title" class="toast-title">{{ toast.title }}</div>
            <div v-if="toast.message" class="toast-message">{{ toast.message }}</div>
            <div v-if="toast.detail" class="toast-detail mono">{{ toast.detail }}</div>
            <div v-if="toast.kind === 'progress'" class="toast-bar">
              <span class="toast-bar-fill" :style="{ width: `${Math.round((toast.progress ?? 0) * 100)}%` }"></span>
            </div>
            <button v-if="toast.action" class="toast-action" type="button" @click="toast.action.onClick">
              {{ toast.action.label }}
            </button>
          </div>
          <button class="toast-close" type="button" title="关闭" @click="actions.dismiss(toast.id)">×</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 42px;
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100vw - 32px));
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(6px);
  font-size: 11px;
  color: var(--text);
}

.toast.is-success {
  border-color: color-mix(in srgb, #14ae5c 55%, var(--border));
}

.toast.is-error {
  border-color: color-mix(in srgb, var(--danger) 60%, var(--border));
}

.toast.is-progress {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.toast-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 10px;
  font-weight: 700;
}

.toast.is-success .toast-icon {
  background: #14ae5c;
  color: #fff;
}

.toast.is-error .toast-icon {
  background: var(--danger);
  color: #fff;
}

.toast.is-progress .toast-icon {
  background: var(--accent);
  color: #fff;
}

.toast-body {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}

.toast-message {
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-2);
  word-break: break-word;
}

.toast-detail {
  margin-top: 3px;
  font-size: 9px;
  color: var(--text-muted);
  word-break: break-all;
}

.toast-bar {
  margin-top: 6px;
  height: 3px;
  border-radius: 999px;
  background: var(--panel-3);
  overflow: hidden;
}

.toast-bar-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}

.toast-action {
  margin-top: 6px;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 10px;
  cursor: pointer;
}

.toast-action:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.toast-close {
  flex: none;
  width: 16px;
  height: 16px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.toast-close:hover {
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
