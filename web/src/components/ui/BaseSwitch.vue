<script setup lang="ts">
import { computed, useAttrs, useId } from 'vue'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ label?: string, disabled?: boolean, disabledReason?: string }>()
const model = defineModel<boolean>()
const attrs = useAttrs()
const generatedId = useId()
const controlId = computed(() => String(attrs.id || generatedId))
function inputAttrs() { return Object.fromEntries(Object.entries(attrs).filter(([name]) => !['class', 'style', 'id'].includes(name))) }
</script>

<template>
  <div class="base-switch-field" :class="attrs.class" :style="attrs.style as any">
    <label :for="controlId" class="base-switch-label" :data-disabled="disabled">
      <span class="base-switch-shell">
        <input :id="controlId" v-model="model" v-bind="inputAttrs()" type="checkbox" class="base-switch-input"
          role="switch" :aria-checked="!!model" :disabled="disabled"
          :aria-describedby="[attrs['aria-describedby'], disabled && disabledReason ? `${controlId}-help` : ''].filter(Boolean).join(' ') || undefined">
        <span class="base-switch-track" aria-hidden="true" />
      </span>
      <span v-if="label" class="base-switch-text">{{ label }}</span>
    </label>
    <p v-if="disabled && disabledReason" :id="`${controlId}-help`" class="base-switch-help">{{ disabledReason }}</p>
  </div>
</template>

<style scoped>
.base-switch-field { display: inline-flex; flex-direction: column; gap: 5px; }
.base-switch-label { display: inline-flex; min-height: 40px; align-items: center; gap: 12px; cursor: pointer; }
.base-switch-label[data-disabled='true'] { cursor: not-allowed; }
.base-switch-shell { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; }
.base-switch-input { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
.base-switch-track { position: relative; width: 44px; height: 24px; border: 1px solid var(--surface-border-strong); border-radius: 999px; background: var(--surface-3); transition: background-color 160ms ease; }
.base-switch-track::after { content: ''; position: absolute; top: 1px; left: 1px; width: 20px; height: 20px; border-radius: 50%; background: var(--surface-1); box-shadow: 0 1px 3px #0003; transition: transform 180ms cubic-bezier(.2,.65,.25,1); }
.base-switch-input:checked + .base-switch-track { background: var(--action-bg); border-color: transparent; }
.base-switch-input:checked + .base-switch-track::after { transform: translateX(20px); background: #fff; }
.base-switch-input:focus-visible + .base-switch-track { outline: 2px solid var(--theme-primary); outline-offset: 3px; }
.base-switch-input:disabled + .base-switch-track { opacity: .65; }
.base-switch-text { color: var(--theme-text); font-size: 14px; font-weight: 500; }
.base-switch-help { margin: 0; color: var(--muted-text); font-size: 12px; line-height: 1.6; }
@media (pointer: coarse) { .base-switch-label { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .base-switch-track, .base-switch-track::after { transition: none; } }
</style>
