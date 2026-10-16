<script setup>
/** 带数值输入的滑块（透明度阈值 / 边距 / 容差 / 导出质量）。 */
import { computed } from 'vue';

const props = defineProps({
  label: { type: String, required: true },
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  suffix: { type: String, default: '' },
  hint: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue']);

const percent = computed(() => ((props.modelValue - props.min) / (props.max - props.min)) * 100);

function onInput(event) {
  emit('update:modelValue', Number(event.target.value));
}

function onNumber(event) {
  const raw = Number(event.target.value);
  if (!Number.isFinite(raw)) return;
  const clamped = Math.min(props.max, Math.max(props.min, Math.round(raw / props.step) * props.step));
  emit('update:modelValue', Number(clamped.toFixed(4)));
}
</script>

<template>
  <div class="field" :class="{ 'is-disabled': disabled }">
    <div class="field-head">
      <label class="field-label" :title="hint">{{ label }}</label>
      <div class="field-value">
        <input
          class="field-number mono"
          type="number"
          :min="min"
          :max="max"
          :step="step"
          :value="modelValue"
          :disabled="disabled"
          @change="onNumber"
        />
        <span v-if="suffix" class="field-suffix">{{ suffix }}</span>
      </div>
    </div>
    <input
      class="range"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :style="{ '--percent': `${percent}%` }"
      @input="onInput"
    />
    <p v-if="hint" class="field-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.field {
  margin-bottom: 12px;
}

.field.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.field-label {
  color: var(--text-2);
}

.field-value {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.field-number {
  width: 48px;
  height: 22px;
  padding: 0 4px;
  text-align: right;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.field-number:focus {
  outline: none;
  border-color: var(--accent);
}

.field-suffix {
  color: var(--text-muted);
  font-size: 10px;
}

.range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent) 0%,
    var(--accent) var(--percent, 0%),
    var(--panel-3) var(--percent, 0%),
    var(--panel-3) 100%
  );
  cursor: pointer;
}

.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.25);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}

.range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid rgba(0, 0, 0, 0.25);
  border-radius: 50%;
  background: #fff;
}

.field-hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.5;
}
</style>
