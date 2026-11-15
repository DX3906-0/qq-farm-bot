<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { cancelContentMotion, createModalPresenceMotion } from '@/composables/useContentMotion'

type ModalType = 'primary' | 'danger' | 'success' | 'secondary'
const props = withDefaults(defineProps<{
  show: boolean
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
  loading?: boolean
  isAlert?: boolean
  type?: ModalType
  confirmationCode?: string
}>(), {
  title: '确认操作', message: '确定要执行此操作吗？', confirmText: '确定', cancelText: '取消',
  loading: false, isAlert: false, type: 'primary', confirmationCode: '',
})
const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'close'): void
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const dialogId = useId()
let previousFocus: HTMLElement | null = null
let disposed = false
let presenceRevision = 0
const rendered = ref(props.show)
const leaving = ref(false)
function finishHidden() {
  if (props.show || disposed) return
  dialog.value?.close()
  rendered.value = false
  leaving.value = false
  restoreFocus()
}
const presence = createModalPresenceMotion(() => dialog.value, finishHidden)
const confirmDisabled = computed(() => props.loading || leaving.value)
const iconClass = computed(() => props.type === 'danger'
  ? 'i-carbon-warning-alt' : props.type === 'success' ? 'i-carbon-checkmark'
    : props.isAlert ? 'i-carbon-information' : 'i-carbon-help')

function restoreFocus() {
  const target = previousFocus
  previousFocus = null
  if (target?.isConnected)
    target.focus({ preventScroll: true })
}
function focusSafely() {
  const element = dialog.value
  if (!element?.open)
    return
  // Never initially focus an irreversible action. A pending request has no
  // active controls: focus the dialog itself, without implying cancellation.
  const target = props.loading ? element : element.querySelector<HTMLElement>(props.isAlert
    ? '.confirm-modal-actions button' : '[data-modal-cancel]') || element
  target.focus({ preventScroll: true })
}
watch(() => props.show, async (visible) => {
  if (typeof document === 'undefined' || disposed) return
  const request = ++presenceRevision
  if (!visible) {
    leaving.value = true
    if (!dialog.value?.open) { finishHidden(); return }
    // Keep native modality until the short exit ends; invisible stale controls
    // cannot confirm, and focus returns only after the top layer is released.
    presence.change(false)
    return
  }
  cancelContentMotion('overlay')
  const wasOpen = dialog.value?.open === true
  if (!wasOpen) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  rendered.value = true
  leaving.value = false
  await nextTick()
  if (disposed || request !== presenceRevision || !props.show || !dialog.value) return
  if (!dialog.value.open) dialog.value.showModal()
  focusSafely()
  presence.change(true, !wasOpen)
}, { immediate: true, flush: 'pre' })
watch(() => props.loading, () => { void nextTick(focusSafely) })
onBeforeUnmount(() => {
  disposed = true
  presenceRevision++
  presence.dispose()
  dialog.value?.close()
  restoreFocus()
})

function cancel() {
  if (props.show && !props.loading && !leaving.value)
    emit('cancel')
}
function closeModal() {
  if (!props.show || props.loading || leaving.value)
    return
  // Existing callers may listen to either event. Both are dismissals only;
  // neither changes nor cancels the already-sent request.
  emit('cancel')
  emit('close')
}
function onNativeCancel(event: Event) {
  event.preventDefault()
  closeModal()
}
function onDialogKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialog.value)
    return
  const controls = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
    .filter(element => !element.hidden && element.getClientRects().length > 0)
  if (!controls.length) {
    event.preventDefault()
    dialog.value.focus({ preventScroll: true })
    return
  }
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault()
    last?.focus({ preventScroll: true })
  }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) {
    event.preventDefault()
    first?.focus({ preventScroll: true })
  }
}
function onBackdropClick(event: MouseEvent) {
  const element = dialog.value
  if (!element || event.target !== element)
    return
  const bounds = element.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom)
    closeModal()
}
function confirm() {
  if (!confirmDisabled.value)
    emit('confirm')
}
</script>

<template>
    <dialog
      v-if="rendered"
      ref="dialog"
      class="confirm-modal"
      :data-tone="type"
      :data-leaving="leaving"
      :aria-labelledby="`${dialogId}-title`"
      :aria-describedby="`${dialogId}-message`"
      :aria-busy="loading ? 'true' : undefined"
      aria-modal="true"
      tabindex="-1"
      @cancel="onNativeCancel"
      @keydown="onDialogKeydown"
      @click="onBackdropClick"
    >
      <div class="confirm-modal-icon" aria-hidden="true"><div :class="iconClass" /></div>
      <div class="confirm-modal-content">
        <h3 :id="`${dialogId}-title`" class="confirm-modal-title">{{ title }}</h3>
        <p :id="`${dialogId}-message`" class="confirm-modal-message">{{ message }}</p>
        <p v-if="loading" class="confirm-modal-progress" role="status">请求处理中，请等待结果；已发送的请求不会因关闭窗口而取消。</p>
      </div>
      <div class="confirm-modal-actions" :class="{ 'is-alert': isAlert }">
        <BaseButton v-if="!isAlert" class="confirm-modal-button" data-modal-cancel variant="secondary" :disabled="loading || leaving" @click="cancel">{{ cancelText }}</BaseButton>
        <BaseButton class="confirm-modal-button" :variant="type" :loading="loading" :disabled="confirmDisabled" @click="confirm">{{ confirmText }}</BaseButton>
      </div>
    </dialog>
</template>

<style scoped>
.confirm-modal {
  --modal-tone: var(--theme-primary, #416d3b);
  width: min(430px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  margin: auto;
  padding: 24px;
  overflow-y: auto;
  border: 1px solid var(--surface-border-strong, #e1d9c5);
  border-radius: var(--radius-panel, 16px);
  background: var(--surface-1, #fcfbf6);
  color: var(--theme-text, #2c2a22);
  box-shadow: var(--surface-shadow, 0 12px 32px rgba(0,0,0,.16));
  text-align: left;
}
.confirm-modal::backdrop { background: rgba(15, 23, 42, .38); }
.confirm-modal[data-tone='danger'] { --modal-tone: var(--status-danger, #b4232c); }
.confirm-modal[data-tone='success'] { --modal-tone: var(--status-success, #327047); }
.confirm-modal-icon {
  display: flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-card, 12px);
  color: var(--modal-tone);
  background: color-mix(in srgb, var(--modal-tone) 11%, var(--surface-1, #fcfbf6));
  font-size: 22px;
}
.confirm-modal-content { margin-top: 16px; }
.confirm-modal-title { margin: 0; color: var(--theme-text, #2c2a22); font-size: 20px; font-weight: 600; line-height: 1.4; }
.confirm-modal-message { margin: 10px 0 0; white-space: pre-line; color: var(--muted-text, #706857); font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.confirm-modal-progress { margin: 12px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted-text, #706857); }
.confirm-modal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 24px; }
.confirm-modal-actions.is-alert { grid-template-columns: 1fr; }
.confirm-modal-button { min-height: 44px; }
.confirm-modal[data-leaving='true'] { pointer-events: none; }
.confirm-modal::backdrop { transition: background-color 150ms ease; }
.confirm-modal[data-leaving='true']::backdrop { background: transparent; }
@media (max-width: 480px) { .confirm-modal { margin: auto auto max(16px, env(safe-area-inset-bottom)); padding: 20px; } }
@media (prefers-reduced-motion: reduce) { .confirm-modal::backdrop { transition: none; } }
</style>
