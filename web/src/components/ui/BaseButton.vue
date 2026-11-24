<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'outline' | 'text'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  to?: string
  href?: string
  type?: 'button' | 'submit' | 'reset'
}>()

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void
}>()
const blocked = computed(() => props.disabled || props.loading)
const clicked = ref(false)
let clickTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => { if (clickTimer) clearTimeout(clickTimer) })
const componentTag = computed(() => props.to ? RouterLink : props.href ? 'a' : 'button')
const sizeClasses = computed(() => props.variant === 'text' ? 'base-button--text' : props.size === 'lg'
  ? 'px-6 text-base base-button--lg' : props.size === 'sm' ? 'px-3 text-sm base-button--sm' : 'px-4 text-sm')

function guardClick(event: MouseEvent) {
  if (!blocked.value)
    return
  // disabled is not a native constraint on anchors or RouterLink. Capture runs
  // before RouterLink's navigation handler, which respects defaultPrevented.
  event.preventDefault()
  event.stopImmediatePropagation()
}
function handleClick(event: MouseEvent) {
  if (blocked.value)
    return
  // This pulse acknowledges the click, not the outcome of the operation.
  clicked.value = true
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = setTimeout(() => { clicked.value = false }, 180)
  emit('click', event)
}
</script>

<template>
  <component
    :is="componentTag"
    :to="to"
    :type="!to && !href ? (type || 'button') : undefined"
    :disabled="!to && !href ? blocked : undefined"
    :aria-disabled="blocked ? 'true' : undefined"
    :aria-busy="loading ? 'true' : undefined"
    :tabindex="blocked && (to || href) ? -1 : undefined"
    :data-variant="variant || 'primary'"
    :data-loading="!!loading"
    :data-clicked="clicked"
    :class="['base-button inline-flex items-center justify-center font-medium', sizeClasses, { 'w-full': block }]"
    v-bind="to ? $attrs : { ...$attrs, href: blocked ? undefined : href }"
    @click.capture="guardClick"
    @click="handleClick"
  >
    <span v-if="loading" class="base-button-spinner i-svg-spinners-ring-resize animate-spin" aria-hidden="true" />
    <span class="base-button-label inline-flex items-center justify-center"><slot /></span>
  </component>
</template>

<style scoped>
.base-button {
  position: relative;
  min-height: 40px;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-control, 8px);
  color: var(--action-text, #fff);
  background: var(--action-bg, #416d3b);
  line-height: 1.4;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.base-button::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: currentColor; opacity: 0; pointer-events: none; }
.base-button:not([aria-disabled='true']):active::after { opacity: .12; }
.base-button[data-clicked='true']::after { animation: button-acknowledge 180ms ease-out; }
@keyframes button-acknowledge { from { opacity: .16; } to { opacity: 0; } }
.base-button:not([aria-disabled='true']):active .base-button-label { transform: scale(.97); }
.base-button:not([aria-disabled='true']):hover { background: var(--action-hover, #355b31); }
.base-button:focus-visible { outline: 2px solid var(--focus-ring, #416d3b); outline-offset: 3px; }
.base-button[aria-disabled='true'] { opacity: .6; cursor: not-allowed; }
.base-button--sm { min-height: 34px; }
.base-button--lg { min-height: 46px; }
.base-button-label { transition: opacity 100ms ease, transform 90ms ease; }
.base-button[data-loading='true'] .base-button-label { opacity: 0; }
.base-button-spinner { position: absolute; left: calc(50% - 8px); top: calc(50% - 8px); width: 16px; height: 16px; }
.base-button[data-variant='secondary'], .base-button[data-variant='outline'] {
  color: var(--theme-text, #2c2a22);
  border-color: var(--surface-border-strong, #d9d2c2);
  background: var(--surface-1, #fcfbf6);
}
.base-button[data-variant='outline'] { background: transparent; }
.base-button[data-variant='secondary']:not([aria-disabled='true']):hover,
.base-button[data-variant='outline']:not([aria-disabled='true']):hover { background: var(--surface-2, #f7f2e7); }
.base-button[data-variant='danger'] { background: #b4232c; color: #fff; }
.base-button[data-variant='danger']:not([aria-disabled='true']):hover { background: #971d25; }
.base-button[data-variant='success'] { background: #327047; color: #fff; }
.base-button[data-variant='success']:not([aria-disabled='true']):hover { background: #285c39; }
.base-button[data-variant='ghost'], .base-button[data-variant='text'] { background: transparent; color: var(--theme-text, #2c2a22); }
.base-button[data-variant='ghost']:not([aria-disabled='true']):hover { background: var(--surface-2, #f7f2e7); }
.base-button--text { min-height: unset; padding: 0; border: 0; color: var(--theme-primary, #416d3b) !important; }
.base-button[data-variant='text']:not([aria-disabled='true']):hover { background: transparent; text-decoration: underline; }
@media (pointer: coarse) { .base-button:not(.base-button--text) { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .base-button, .base-button-label { transition: none; } .base-button-spinner, .base-button::after { animation: none !important; } .base-button:active .base-button-label { transform: none; } }
</style>
