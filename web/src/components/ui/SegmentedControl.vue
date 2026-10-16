<script setup>
/** Figma 风格分段控件（引擎切换、视图模式、导出格式）。 */
defineProps({
  modelValue: { type: [String, Number], required: true },
  options: { type: Array, required: true }, // [{ value, label, hint? }]
  size: { type: String, default: 'md' },
  block: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div class="segmented" :class="[`is-${size}`, { 'is-block': block }]" role="tablist">
    <button
      v-for="option in options"
      :key="option.value"
      class="segmented-item"
      :class="{ 'is-active': option.value === modelValue }"
      :title="option.hint || option.label"
      role="tab"
      :aria-selected="option.value === modelValue"
      type="button"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  /* 选项多（例如 5 个引擎）时换行，而不是把最后一项挤出容器裁掉。
     配合 .segmented-item 的 min-width: max-content，标签永远不会被压扁或截断。 */
  flex-wrap: wrap;
  padding: 2px;
  gap: 2px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.segmented.is-block {
  display: flex;
  width: 100%;
}

.segmented-item {
  flex: 1 1 auto;
  /* 标签按内容定最小宽度：宁可换行，也不挤压/截断文字 */
  min-width: max-content;
  height: 22px;
  padding: 0 10px;
  border-radius: 4px;
  color: var(--text-muted);
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}

.segmented-item:hover {
  color: var(--text);
}

.segmented-item.is-active {
  background: var(--accent);
  color: #fff;
  font-weight: 500;
}

.segmented.is-sm .segmented-item {
  height: 18px;
  padding: 0 8px;
  font-size: 11px;
}

.segmented.is-sm {
  padding: 1px;
}
</style>
