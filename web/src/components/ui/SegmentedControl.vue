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
  flex: 1;
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
