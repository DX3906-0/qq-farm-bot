<script setup lang="ts">
import { computed, ref, useAttrs, useId } from 'vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  type?: string
  placeholder?: string
  label?: string
  disabled?: boolean
  clearable?: boolean
  hint?: string
  error?: string
  disabledReason?: string
}>()
const emit = defineEmits<{ (e: 'clear'): void }>()
const model = defineModel<string | number>()
const attrs = useAttrs()
const generatedId = useId()
const input = ref<HTMLInputElement | null>(null)
const touched = ref(false)
const nativeError = ref('')
const showPassword = ref(false)
const inputId = computed(() => String(attrs.id || generatedId))
const inputType = computed(() => props.type === 'password' && showPassword.value ? 'text' : props.type || 'text')
const message = computed(() => props.error || nativeError.value || (props.disabled ? props.disabledReason : '') || props.hint || '')
const invalid = computed(() => !!(props.error || nativeError.value))
const describedBy = computed(() => [attrs['aria-describedby'], message.value ? `${inputId.value}-help` : ''].filter(Boolean).join(' ') || undefined)
// Dimensions belong to the wrapper; native constraints, autocomplete/name,
// accessibility attributes and input/key events belong to the actual input.
function inputAttrs() {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => !['class', 'style', 'id', 'aria-describedby', 'aria-invalid'].includes(name)))
}
function checkValidity() {
  if (!input.value || props.disabled) { nativeError.value = ''; return }
  nativeError.value = touched.value && !input.value.validity.valid ? input.value.validationMessage : ''
}
function onBlur() { touched.value = true; checkValidity() }
function clear() {
  if (props.disabled) return
  model.value = ''
  nativeError.value = ''
  emit('clear')
  input.value?.focus({ preventScroll: true })
}
defineExpose({ focus: () => input.value?.focus(), checkValidity: () => input.value?.checkValidity() ?? true })
</script>

<template>
  <div class="base-input-field" :class="attrs.class" :style="attrs.style as any">
    <label v-if="label" :for="inputId" class="base-input-label">{{ label }}</label>
    <div class="base-input-shell">
      <input
        :id="inputId"
        ref="input"
        v-model="model"
        v-bind="inputAttrs()"
        :type="inputType"
        :placeholder="placeholder"
        :disabled="disabled"
        :aria-invalid="invalid ? 'true' : attrs['aria-invalid'] as any"
        :aria-describedby="describedBy"
        class="base-input"
        :class="{ 'has-action': type === 'password' || (clearable && model), 'is-invalid': invalid }"
        @input="checkValidity"
        @blur="onBlur"
        @invalid="touched = true; checkValidity()"
      >
      <button v-if="type === 'password'" type="button" class="base-input-action"
        :aria-label="showPassword ? '隐藏密码' : '显示密码'" :disabled="disabled" @click="showPassword = !showPassword">
        <span :class="showPassword ? 'i-carbon-view-off' : 'i-carbon-view'" aria-hidden="true" />
      </button>
      <button v-else-if="clearable && model" type="button" class="base-input-action" aria-label="清空输入" :disabled="disabled" @click="clear">
        <span class="i-carbon-close" aria-hidden="true" />
      </button>
    </div>
    <p v-if="message" :id="`${inputId}-help`" class="base-input-help" :data-error="invalid" :role="invalid ? 'status' : undefined">{{ message }}</p>
  </div>
</template>

<style scoped>
.base-input-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.base-input-label { color: var(--theme-text); font-size: 14px; font-weight: 500; }
.base-input-shell { position: relative; }
.base-input { width: 100%; min-height: 40px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control, 8px); padding: 8px 12px; background: var(--input-bg); color: var(--theme-text); font-size: 14px; outline: none; transition: border-color 120ms ease, box-shadow 120ms ease; }
.base-input::placeholder { color: var(--muted-text); opacity: 1; }
.base-input.has-action { padding-right: 44px; }
.base-input:disabled { background: var(--surface-2); color: var(--muted-text); cursor: not-allowed; }
.base-input:focus { border-color: var(--theme-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 18%, transparent); }
.base-input.is-invalid { border-color: var(--status-danger, #b4232c); }
.base-input-action { position: absolute; top: 50%; right: 2px; display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; transform: translateY(-50%); border: 0; border-radius: var(--radius-control); background: transparent; color: var(--muted-text); cursor: pointer; }
.base-input-action:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: -3px; }
.base-input-action:disabled { cursor: not-allowed; }
.base-input-help { margin: 0; color: var(--muted-text); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.base-input-help[data-error='true'] { color: var(--status-danger, #b4232c); }
.base-input::-ms-reveal, .base-input::-ms-clear { display: none; }
@media (pointer: coarse) { .base-input { min-height: 44px; } .base-input-action { width: 40px; height: 40px; } }
@media (prefers-reduced-motion: reduce) { .base-input { transition: none; } }
</style>
