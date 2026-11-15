<script setup>
/**
 * 临时用户面板
 * ------------
 * 不需要登录：每个标签页就是一个临时用户。这里可以改名、在同一/新标签页换一个新临时用户。
 * 资源库是所有人共享的；工作区现场（会话 + 素材）按临时用户分开，互不混淆。
 */
import { ref, watch } from 'vue';

import { useGuest } from '../composables/useGuest.js';

const { state, actions } = useGuest();
const draft = ref('');

watch(
  () => state.dialogOpen,
  (open) => {
    if (open) draft.value = state.name;
  },
);

function save() {
  actions.rename(draft.value);
  actions.closeDialog();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state.dialogOpen" class="guest-mask" @click.self="actions.closeDialog()">
      <div class="guest-card" role="dialog" aria-label="临时用户">
        <header class="guest-head">
          <div>
            <div class="guest-title">临时用户</div>
            <div class="guest-sub muted">无需登录。每个标签页一个临时身份，工作区互不混淆，素材库共享。</div>
          </div>
          <button class="guest-close" type="button" title="关闭" @click="actions.closeDialog()">×</button>
        </header>

        <div class="guest-row">
          <span class="guest-key">当前名称</span>
          <span class="guest-value mono">{{ state.name }}</span>
        </div>
        <div class="guest-row">
          <span class="guest-key">会话标识</span>
          <span class="guest-value mono guest-id">{{ state.id }}（仅本标签页有效）</span>
        </div>

        <label class="guest-field">
          <span>改个名字（仅本标签页显示）</span>
          <div class="guest-inline">
            <input v-model="draft" class="text-input" maxlength="32" placeholder="例如：设计-小王" @keydown.enter="save" />
            <button class="btn is-mini" type="button" :disabled="!draft.trim() || draft.trim() === state.name" @click="save">保存</button>
          </div>
        </label>

        <div class="guest-actions">
          <button class="btn is-ghost" type="button" @click="actions.openNewTab()">新标签页开一个临时用户</button>
          <button class="btn is-ghost is-danger" type="button" @click="actions.startNew()">本标签页换新用户</button>
          <button class="btn" type="button" @click="actions.closeDialog()">关闭</button>
        </div>

        <p class="guest-note muted">
          说明：临时用户不是安全账号，只用于把「工作区现场 + 任务列表」分开。资源库、回收站、指纹索引由所有人共享。
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.guest-mask {
  position: fixed;
  inset: 0;
  z-index: 160;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(3px);
}

.guest-card {
  width: min(520px, 94vw);
  padding: 18px 20px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
}

.guest-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.guest-title {
  font-size: 15px;
  font-weight: 600;
}

.guest-sub {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.5;
}

.guest-close {
  width: 24px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 17px;
  cursor: pointer;
}

.guest-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-top: 10px;
  font-size: 11px;
}

.guest-key {
  flex: none;
  width: 64px;
  color: var(--text-muted);
}

.guest-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.guest-id {
  font-size: 9px;
  color: var(--text-muted);
}

.guest-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 14px;
  font-size: 10px;
  color: var(--text-2);
}

.guest-inline {
  display: flex;
  gap: 6px;
}

.guest-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.guest-note {
  margin: 12px 0 0;
  font-size: 9px;
  line-height: 1.6;
}
</style>
