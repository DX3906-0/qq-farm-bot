<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch } from 'vue'
import { cancelContentMotion } from '@/composables/useContentMotion'

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  label?: string
  options?: { label: string, value: string | number, disabled?: boolean }[]
  disabled?: boolean
  placeholder?: string
  hint?: string
  error?: string
  disabledReason?: string
}>()
const emit = defineEmits<{ (e: 'change', value: string | number): void }>()
const model = defineModel<string | number>()
const attrs = useAttrs()
const generatedId = useId()
const controlId = computed(() => String(attrs.id || generatedId))
const isOpen = ref(false)
const container = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)
const nativePopover = ref(typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype)
const menuStyle = ref<Record<string, string>>({ visibility: 'hidden' })
const selectedLabel = computed(() => props.options?.find(option => option.value === model.value)?.label || props.placeholder || '请选择')
const message = computed(() => props.error || (props.disabled ? props.disabledReason : '') || props.hint || '')
const describedBy = computed(() => [attrs['aria-describedby'], message.value ? `${controlId.value}-help` : ''].filter(Boolean).join(' ') || undefined)
let positionFrame = 0
let search = ''
let searchTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
function triggerAttrs() {
  return Object.fromEntries(Object.entries(attrs).filter(([name]) => !['class', 'style', 'id', 'aria-describedby', 'aria-invalid'].includes(name)))
}
function enabledIndices() { return (props.options || []).flatMap((option, index) => option.disabled ? [] : [index]) }
function initialIndex(last = false) {
  const indices = enabledIndices()
  const selected = props.options?.findIndex(option => option.value === model.value && !option.disabled) ?? -1
  return selected >= 0 ? selected : (last ? indices[indices.length - 1] : indices[0]) ?? -1
}
function positionMenu() {
  const button = trigger.value, panel = menu.value
  if (!isOpen.value || !button || !panel) return
  const box = button.getBoundingClientRect(), viewport = window.visualViewport
  if (box.bottom <= 0 || box.top >= window.innerHeight || !box.width) { close(); return }
  const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0
  const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
  const margin = 8, gap = 6
  const panelWidth = Math.min(Math.max(box.width, 160), Math.max(0, width - margin * 2))
  const below = Math.max(0, topEdge + height - margin - box.bottom - gap)
  const above = Math.max(0, box.top - topEdge - margin - gap)
  const wanted = Math.min(panel.scrollHeight || 240, 240)
  const upwards = below < wanted && above > below
  const maxHeight = Math.min(240, upwards ? above : below)
  const actualHeight = Math.min(wanted, maxHeight)
  menuStyle.value = {
    position: 'fixed', width: `${panelWidth}px`, maxHeight: `${maxHeight}px`,
    left: `${Math.max(leftEdge + margin, Math.min(box.left, leftEdge + width - panelWidth - margin))}px`,
    top: `${Math.max(topEdge + margin, Math.min(upwards ? box.top - gap - actualHeight : box.bottom + gap, topEdge + height - margin - actualHeight))}px`,
    visibility: 'visible',
  }
}
function queuePosition() {
  if (isOpen.value && !positionFrame) positionFrame = window.requestAnimationFrame(() => { positionFrame = 0; positionMenu() })
}
function scrollActive() {
  void nextTick(() => menu.value?.querySelector<HTMLElement>(`[data-option-index="${activeIndex.value}"]`)?.scrollIntoView({ block: 'nearest' }))
}
async function open(last = false) {
  if (props.disabled || trigger.value?.matches(':disabled') || disposed) return
  cancelContentMotion('overlay')
  activeIndex.value = initialIndex(last)
  isOpen.value = true
  menuStyle.value = { visibility: 'hidden' }
  await nextTick()
  if (disposed || !isOpen.value || !menu.value) return
  if (nativePopover.value) {
    try { menu.value.showPopover() }
    catch { nativePopover.value = false; await nextTick() }
  }
  positionMenu()
  scrollActive()
}
function close(restoreFocus = false) {
  if (nativePopover.value && menu.value?.matches(':popover-open')) menu.value.hidePopover()
  isOpen.value = false
  if (positionFrame) window.cancelAnimationFrame(positionFrame)
  positionFrame = 0
  search = ''
  if (searchTimer) clearTimeout(searchTimer)
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}
function selectOption(index: number) {
  const option = props.options?.[index]
  if (props.disabled || trigger.value?.matches(':disabled') || !option || option.disabled) return
  // Preserve the option's actual string/number type, including numeric zero.
  model.value = option.value
  emit('change', option.value)
  close(true)
}
function move(delta: number) {
  const indices = enabledIndices()
  if (!indices.length) { activeIndex.value = -1; return }
  const position = indices.indexOf(activeIndex.value)
  activeIndex.value = indices[Math.max(0, Math.min(indices.length - 1, position < 0 ? delta > 0 ? 0 : indices.length - 1 : position + delta))]!
  scrollActive()
}
function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return
  if (event.key === 'Tab') { close(); return }
  if (event.key === 'Escape') { if (isOpen.value) { event.preventDefault(); close(true) }; return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    if (!isOpen.value) {
      void open(event.key === 'End' || event.key === 'ArrowUp')
      if (event.key === 'Home' || event.key === 'End') {
        const indices = enabledIndices()
        activeIndex.value = (event.key === 'Home' ? indices[0] : indices[indices.length - 1]) ?? -1
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') { selectOption(activeIndex.value); return }
    if (event.key === 'Home' || event.key === 'End') {
      const indices = enabledIndices()
      activeIndex.value = (event.key === 'Home' ? indices[0] : indices[indices.length - 1]) ?? -1
      scrollActive()
    }
    else move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    search += event.key.toLocaleLowerCase()
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { search = '' }, 700)
    const index = props.options?.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(search)) ?? -1
    if (index >= 0) { if (!isOpen.value) void open(); activeIndex.value = index; scrollActive() }
  }
}
function onOutside(event: Event) {
  const target = event.target as Node | null
  if (isOpen.value && target && !container.value?.contains(target) && !menu.value?.contains(target)) close()
}
watch(() => props.disabled, disabled => { if (disabled) close() })
watch(() => props.options, () => { if (isOpen.value) { activeIndex.value = initialIndex(); queuePosition() } }, { deep: true })
onMounted(() => {
  document.addEventListener('pointerdown', onOutside, true)
  document.addEventListener('focusin', onOutside)
  window.addEventListener('resize', queuePosition)
  document.addEventListener('scroll', queuePosition, true)
  window.visualViewport?.addEventListener('resize', queuePosition)
  window.visualViewport?.addEventListener('scroll', queuePosition)
})
onBeforeUnmount(() => {
  disposed = true
  close()
  document.removeEventListener('pointerdown', onOutside, true)
  document.removeEventListener('focusin', onOutside)
  window.removeEventListener('resize', queuePosition)
  document.removeEventListener('scroll', queuePosition, true)
  window.visualViewport?.removeEventListener('resize', queuePosition)
  window.visualViewport?.removeEventListener('scroll', queuePosition)
})
</script>

<template>
  <div ref="container" class="base-select-field" :class="attrs.class" :style="attrs.style as any">
    <label v-if="label" :for="controlId" class="base-select-label">{{ label }}</label>
    <button :id="controlId" ref="trigger" v-bind="triggerAttrs()" type="button" class="base-select-trigger" :data-open="isOpen"
      :disabled="disabled" role="combobox" aria-haspopup="listbox" :aria-expanded="isOpen"
      :aria-controls="`${controlId}-list`" :aria-activedescendant="isOpen && activeIndex >= 0 ? `${controlId}-option-${activeIndex}` : undefined"
      :aria-invalid="error ? 'true' : attrs['aria-invalid'] as any" :aria-describedby="describedBy"
      @click="isOpen ? close() : open()" @keydown="onKeydown">
      <span class="base-select-value">{{ selectedLabel }}</span>
      <span class="i-carbon-chevron-down base-select-chevron" aria-hidden="true" />
    </button>
    <p v-if="message" :id="`${controlId}-help`" class="base-select-help" :data-error="!!error" :role="error ? 'status' : undefined">{{ message }}</p>
    <Teleport to="body">
      <div v-if="isOpen" :id="`${controlId}-list`" ref="menu" class="base-select-menu" :popover="nativePopover ? 'manual' : undefined"
        role="listbox" :aria-label="label || attrs['aria-label'] as string || '选项'" :style="menuStyle" data-motion-overlay>
        <div v-for="(option, index) in options" :id="`${controlId}-option-${index}`" :key="`${typeof option.value}:${option.value}`"
          class="base-select-option" role="option" :aria-selected="model === option.value" :aria-disabled="!!option.disabled"
          :data-option-index="index" :data-active="activeIndex === index" @pointerdown.prevent
          @pointermove="!option.disabled && (activeIndex = index)" @click="selectOption(index)">
          <span class="base-select-option-label"><slot name="option" :option="option" :selected="model === option.value">{{ option.label }}</slot></span>
          <span v-if="model === option.value" class="i-carbon-checkmark" aria-hidden="true" />
        </div>
        <div v-if="!options?.length" class="base-select-empty" role="status">暂无选项</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.base-select-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.base-select-label { color: var(--theme-text); font-size: 14px; font-weight: 500; }
.base-select-trigger { display: flex; width: 100%; min-height: 40px; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control, 8px); padding: 8px 12px; background: var(--input-bg); color: var(--theme-text); text-align: left; font-size: 14px; cursor: pointer; transition: border-color 120ms ease, box-shadow 120ms ease; }
.base-select-trigger:focus-visible, .base-select-trigger[data-open='true'] { outline: none; border-color: var(--theme-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-primary) 18%, transparent); }
.base-select-trigger[aria-invalid='true'] { border-color: var(--status-danger, #b4232c); }
.base-select-trigger:disabled { background: var(--surface-2); color: var(--muted-text); cursor: not-allowed; }
.base-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.base-select-chevron { flex-shrink: 0; color: var(--muted-text); transition: transform 180ms ease; }
.base-select-trigger[data-open='true'] .base-select-chevron { transform: rotate(180deg); }
.base-select-menu { inset: auto; z-index: 100; margin: 0; overflow: auto; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-card); padding: 4px; background: var(--surface-1); color: var(--theme-text); box-shadow: var(--surface-shadow); overscroll-behavior: contain; scrollbar-gutter: stable; animation: select-menu-in 140ms ease; }
.base-select-option { display: flex; min-height: 40px; align-items: center; justify-content: space-between; gap: 10px; border-radius: var(--radius-control); padding: 8px; color: var(--theme-text); font-size: 14px; cursor: pointer; }
.base-select-option[data-active='true']:not([aria-disabled='true']), .base-select-option[aria-selected='true'] { background: color-mix(in srgb, var(--theme-primary) 12%, var(--surface-1)); }
.base-select-option-label { min-width: 0; overflow-wrap: anywhere; }
.base-select-option[aria-disabled='true'] { color: var(--muted-text); cursor: not-allowed; }
.base-select-empty, .base-select-help { margin: 0; color: var(--muted-text); font-size: 12px; line-height: 1.6; }
.base-select-empty { padding: 12px; text-align: center; }
.base-select-help[data-error='true'] { color: var(--status-danger, #b4232c); }
@keyframes select-menu-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@media (pointer: coarse) { .base-select-trigger, .base-select-option { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .base-select-trigger, .base-select-chevron { transition: none; } .base-select-menu { animation: none; } }
</style>
