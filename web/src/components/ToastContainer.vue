<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useToastStore } from '@/stores/toast'

const toastStore = useToastStore()
const { toasts } = storeToRefs(toastStore)

function getIcon(type: string) {
  switch (type) {
    case 'success': return 'i-carbon-checkmark'
    case 'error': return 'i-carbon-error'
    case 'warning': return 'i-carbon-warning'
    case 'info': return 'i-carbon-information'
    default: return 'i-carbon-information'
  }
}

function closeToast(id: number) {
  toastStore.remove(id)
}
</script>

<template>
  <div class="toast-stack pointer-events-none fixed right-3 top-20 z-[9997] flex max-w-[calc(100vw-1.5rem)] flex-col gap-2 md:right-4 md:top-24">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="toast-item pointer-events-auto w-80 max-w-full flex items-start gap-3 p-4"
        :role="toast.type === 'error' ? 'alert' : 'status'"
        :data-tone="toast.type"
      >
        <div :class="getIcon(toast.type)" class="toast-icon mt-0.5 shrink-0 text-xl" aria-hidden="true" />
        <div class="flex-1 break-words text-sm text-[var(--theme-text)]">
          {{ toast.message }}
        </div>
        <button
          class="toast-close h-8 w-8 shrink-0"
          type="button"
          aria-label="关闭通知"
          @click="closeToast(toast.id)"
        >
          <div class="i-carbon-close text-lg" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack { position: fixed; width: min(320px, calc(100vw - 24px)); }
.toast-item { border: 1px solid var(--surface-border-strong); border-left: 3px solid var(--status-info); border-radius: var(--radius-card, 12px); background: var(--surface-1); color: var(--theme-text); box-shadow: var(--surface-shadow); }
.toast-item[data-tone='success'] { border-left-color: var(--status-success); }
.toast-item[data-tone='warning'] { border-left-color: var(--status-warning); }
.toast-item[data-tone='error'] { border-left-color: var(--status-danger); }
.toast-icon { color: var(--status-info); }
.toast-item[data-tone='success'] .toast-icon { color: var(--status-success); }
.toast-item[data-tone='warning'] .toast-icon { color: var(--status-warning); }
.toast-item[data-tone='error'] .toast-icon { color: var(--status-danger); }
.toast-close { color: var(--muted-text); border-radius: var(--radius-control); transition: background-color 120ms ease, color 120ms ease; }
.toast-close:hover { color: var(--theme-text); background: var(--surface-2); }
.toast-close:focus-visible { outline: 2px solid var(--focus-ring, var(--theme-primary)); outline-offset: 2px; }
.toast-move { transition: transform 220ms cubic-bezier(.2, .65, .25, 1); }
.toast-leave-active { position: absolute; width: 100%; }
.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(8px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(8px);
}
@media (prefers-reduced-motion: reduce) { .toast-enter-active, .toast-leave-active, .toast-move, .toast-close { transition: none; } }
</style>
