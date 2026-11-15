<script setup>
/**
 * Emoji 标记选择器：一个入口按钮 + 弹出常用 emoji 面板；支持清除。
 * 只负责选择，实际写入由父组件的 actions 完成（单文件或批量）。
 */
import { computed, ref } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: null },
  label: { type: String, default: '标记' },
  title: { type: String, default: '设置 emoji 标记' },
});
const emit = defineEmits(['pick']);

const EMOJIS = ['⭐', '❤️', '🔥', '✅', '⚡', '🎯', '📌', '💡', '🎬', '🖼️', '🎨', '🧩', '🚀', '💎', '👍', '⚠️'];
const open = ref(false);
const current = computed(() => props.modelValue || '');

function choose(mark) {
  emit('pick', mark);
  open.value = false;
}
</script>

<template>
  <span class="emp">
    <button
      class="btn is-mini is-ghost emp-trigger"
      type="button"
      :title="title"
      :class="{ 'is-active': open }"
      @click="open = !open"
    >
      <span v-if="current" class="emp-current">{{ current }}</span>
      <span v-else class="emp-label">{{ label }}</span>
      <span class="emp-caret">▾</span>
    </button>
    <div v-if="open" class="emp-pop" @click.stop>
      <button
        v-for="emoji in EMOJIS"
        :key="emoji"
        class="emp-cell"
        :class="{ 'is-on': current === emoji }"
        type="button"
        :title="`标记为 ${emoji}`"
        @click="choose(emoji)"
      >
        {{ emoji }}
      </button>
      <button class="emp-cell is-clear" type="button" title="清除标记" @click="choose(null)">清除</button>
    </div>
  </span>
</template>

<style scoped>
.emp {
  position: relative;
  display: inline-flex;
}

.emp-trigger {
  gap: 4px;
  min-width: 60px;
}

.emp-trigger.is-active {
  background: var(--hover);
}

.emp-current {
  font-size: 13px;
  line-height: 1;
}

.emp-label {
  color: var(--text-2);
}

.emp-caret {
  font-size: 8px;
  color: var(--text-muted);
}

.emp-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 60;
  display: grid;
  grid-template-columns: repeat(4, 28px);
  gap: 3px;
  padding: 6px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow-panel);
}

.emp-cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border-radius: 4px;
  font-size: 15px;
  line-height: 1;
}

.emp-cell:hover {
  background: var(--hover);
}

.emp-cell.is-on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.emp-cell.is-clear {
  grid-column: span 4;
  width: auto;
  font-size: 10px;
  color: var(--text-muted);
}
</style>
