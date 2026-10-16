<script setup>
/** Figma 风格开关行。 */
defineProps({
  label: { type: String, required: true },
  modelValue: { type: Boolean, default: false },
  hint: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue']);
</script>

<template>
  <div class="switch-row" :class="{ 'is-disabled': disabled }">
    <div class="switch-text">
      <span class="switch-label">{{ label }}</span>
      <p v-if="hint" class="switch-hint">{{ hint }}</p>
    </div>
    <button
      class="switch"
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      @click="emit('update:modelValue', !modelValue)"
    >
      <span class="switch-knob" :class="{ 'is-on': modelValue }" />
    </button>
  </div>
</template>

<style scoped>
.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.switch-row.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.switch-label {
  color: var(--text-2);
}

.switch-hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.switch {
  flex: none;
  width: 32px;
  height: 18px;
  margin-top: 1px;
  padding: 2px;
  border-radius: 9px;
  background: var(--panel-3);
  transition: background 0.15s ease;
}

.switch[aria-checked='true'] {
  background: var(--accent);
}

.switch-knob {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s ease;
}

.switch-knob.is-on {
  transform: translateX(14px);
}
</style>
