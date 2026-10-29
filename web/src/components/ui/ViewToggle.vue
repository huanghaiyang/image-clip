<script setup>
/**
 * 资源列表的「平铺 / 树形」切换按钮。
 * 只发 modelValue，不持有状态，列表自己决定怎么渲染。
 */
defineProps({
  modelValue: { type: String, default: 'flat' },
});

defineEmits(['update:modelValue']);
</script>

<template>
  <div class="view-toggle" role="group" aria-label="列表视图">
    <button
      class="view-btn"
      :class="{ 'is-active': modelValue === 'flat' }"
      type="button"
      title="平铺展示"
      aria-label="平铺展示"
      @click="$emit('update:modelValue', 'flat')"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="4.6" height="4.6" rx="1" stroke="currentColor" stroke-width="1.2" />
        <rect x="7.9" y="1.5" width="4.6" height="4.6" rx="1" stroke="currentColor" stroke-width="1.2" />
        <rect x="1.5" y="7.9" width="4.6" height="4.6" rx="1" stroke="currentColor" stroke-width="1.2" />
        <rect x="7.9" y="7.9" width="4.6" height="4.6" rx="1" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button
      class="view-btn"
      :class="{ 'is-active': modelValue === 'tree' }"
      type="button"
      title="树形展示"
      aria-label="树形展示"
      @click="$emit('update:modelValue', 'tree')"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="4" height="3.4" rx="1" stroke="currentColor" stroke-width="1.2" />
        <path d="M6.2 3.2h1.6v4.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        <rect x="6.2" y="7.3" width="4.6" height="3.4" rx="1" stroke="currentColor" stroke-width="1.2" />
        <rect x="6.2" y="2.2" width="6.3" height="3.4" rx="1" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.view-toggle {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.view-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 20px;
  border-radius: 3px;
  color: var(--text-muted);
  transition: background 0.12s ease, color 0.12s ease;
}

.view-btn:hover {
  color: var(--text);
  background: var(--hover);
}

.view-btn.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
