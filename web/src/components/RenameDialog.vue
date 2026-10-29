<script setup>
/**
 * 重命名弹窗
 * ----------
 * 资源库里的文件与文件夹共用：输入新名字后调用 renameOne，
 * 服务端会一并迁移历史版本索引、尺寸缓存，前端同步选中项与当前目录。
 */
import { nextTick, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import { useRenamePrompt } from '../composables/useRenamePrompt.js';

const { state, actions } = useRenamePrompt();
const { state: libraryState, actions: libraryActions } = useLibrary();

const input = ref(null);
const name = ref('');
const error = ref('');
const busy = ref(false);

watch(
  () => state.open,
  async (open) => {
    if (!open) return;
    name.value = state.name;
    error.value = '';
    await nextTick();
    input.value?.focus();
    input.value?.select();
  },
);

async function submit() {
  if (busy.value) return;
  const target = name.value.trim();
  if (!target) {
    error.value = '名称不能为空';
    return;
  }
  if (/[\\/]/.test(target)) {
    error.value = '名称不能包含斜杠';
    return;
  }
  if (target === state.name) {
    actions.close();
    return;
  }
  busy.value = true;
  error.value = '';
  const ok = await libraryActions.renameOne({ path: state.path, name: state.name }, target);
  busy.value = false;
  if (ok) actions.close();
  else error.value = libraryState.error || '重命名失败';
}
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="rename-backdrop" @click.self="actions.close()">
      <div class="rename-dialog" role="dialog" aria-modal="true" @keydown.esc.prevent="actions.close()">
        <div class="rename-head">
          <div>
            <h2>重命名{{ state.isFolder ? '文件夹' : '文件' }}</h2>
            <p class="rename-path mono" :title="state.path">{{ state.path }}</p>
          </div>
          <button class="rename-close" type="button" title="关闭 (Esc)" @click="actions.close()">×</button>
        </div>

        <div class="rename-body">
          <label class="rename-label" for="rename-input">新名称</label>
          <input
            id="rename-input"
            ref="input"
            v-model="name"
            class="rename-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="submit"
            @keydown.esc.prevent="actions.close()"
          />
          <p v-if="error" class="rename-error">{{ error }}</p>
        </div>

        <div class="rename-foot">
          <button class="btn is-mini is-ghost" type="button" :disabled="busy" @click="actions.close()">取消</button>
          <button class="btn is-mini" type="button" :disabled="busy" @click="submit">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rename-backdrop {
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

.rename-dialog {
  width: min(420px, 100%);
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  outline: none;
}

.rename-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 16px 12px 18px;
  border-bottom: 1px solid var(--border);
}

.rename-head > div {
  flex: 1;
  min-width: 0;
}

.rename-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.rename-path {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 10px;
}

.rename-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 15px;
  cursor: pointer;
}

.rename-close:hover {
  background: var(--hover);
  color: var(--text);
}

.rename-body {
  padding: 14px 18px 4px;
}

.rename-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-muted);
  font-size: 10px;
}

.rename-input {
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
}

.rename-input:focus {
  outline: none;
  border-color: var(--accent);
}

.rename-error {
  margin: 8px 0 0;
  color: var(--danger);
  font-size: 11px;
}

.rename-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 16px;
}

.mono {
  font-family: var(--mono);
}
</style>
