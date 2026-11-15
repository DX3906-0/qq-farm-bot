<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MysteryMerchantBanner from '@/components/shop/MysteryMerchantBanner.vue'
import Sidebar from '@/components/Sidebar.vue'
import TopAccountMenu from '@/components/TopAccountMenu.vue'
import { cancelContentMotion, primeContentCompositor, useContentMotion } from '@/composables/useContentMotion'
import { menuRoutes, warmMenuCode } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

const appStore = useAppStore()
const { loginPageConfig, sidebarOpen } = storeToRefs(appStore)
const headerLogoFailed = ref(false)
const { currentAccountId } = storeToRefs(useAccountStore())
const router = useRouter()
const route = useRoute()
const pageContext = computed(() => menuRoutes.find(item => item.name === route.name) || menuRoutes[0]!)
const pageViewport = ref<HTMLElement | null>(null)
const pageMotion = useContentMotion(() => pageViewport.value)
let navigationEpoch = 0
let pendingNavigation: {
  to: object
  releaseGuard: (allowed?: boolean) => void
  painted: () => void
} | null = null

function releaseNavigation(allowed = false) {
  const pending = pendingNavigation
  pendingNavigation = null
  pending?.releaseGuard(allowed)
  pending?.painted()
}
const removeBefore = router.beforeEach(() => {
  navigationEpoch++
  cancelContentMotion('navigation')
  releaseNavigation()
})
const removeResolve = router.beforeResolve((to, from) => {
  // Lazy imports and authorization have already finished. Query-only updates
  // stay in place; entering/leaving this layout is not an internal page motion.
  if (to.path === from.path || !pageViewport.value || to.matched[0] !== from.matched[0])
    return
  const epoch = navigationEpoch
  let releaseGuard!: (allowed?: boolean) => void
  let painted!: () => void
  const guard = new Promise<boolean | void>((resolve) => { releaseGuard = resolve })
  const paint = new Promise<void>((resolve) => { painted = resolve })
  const pending = { to, releaseGuard, painted }
  pendingNavigation = pending
  const order = (name: unknown) => menuRoutes.findIndex(item => item.name === name)
  void pageMotion.change(() => {
    releaseGuard()
    // Only wait for route commit/DOM flush, never for the visual animation.
    return paint
  }, {
    direction: order(to.name) < order(from.name) ? -1 : 1,
    fromKey: from.path, toKey: to.path,
    valid: () => epoch === navigationEpoch,
    onAbort: () => {
      releaseGuard(false)
      painted()
      if (pendingNavigation === pending) pendingNavigation = null
    },
  }).catch(() => {
    releaseGuard()
    painted()
    if (pendingNavigation === pending) pendingNavigation = null
  })
  return guard
})
const removeAfter = router.afterEach((to, _from, failure) => {
  if (pendingNavigation?.to !== to)
    return
  if (failure) pageMotion.cancel('superseded')
  releaseNavigation(!failure)
})
const removeError = router.onError(() => {
  pageMotion.cancel('superseded')
  releaseNavigation()
})
watch(currentAccountId, () => {
  cancelContentMotion('context')
  releaseNavigation()
}, { flush: 'sync' })
watch(sidebarOpen, (open) => {
  if (open) cancelContentMotion('overlay')
}, { flush: 'sync' })

onMounted(() => {
  appStore.fetchLoginPageConfig()
  const index = menuRoutes.findIndex(item => item.name === router.currentRoute.value.name)
  // Warm at most adjacent navigation code, not account/game responses.
  for (const item of menuRoutes.slice(Math.max(0, index - 1), index + 2))
    warmMenuCode(`/${item.path}`)
  void primeContentCompositor(() => pageViewport.value)
})
onBeforeUnmount(() => {
  navigationEpoch++
  cancelContentMotion('unmount')
  releaseNavigation()
  removeBefore(); removeResolve(); removeAfter(); removeError()
})

watch(() => loginPageConfig.value.logoUrl, () => {
  headerLogoFailed.value = false
})
</script>

<template>
  <div class="w-screen flex overflow-hidden bg-gray-50 dark:bg-gray-900" style="height: 100dvh;">
    <!-- Mobile Sidebar Overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-gray-950/55 backdrop-blur-md transition-opacity lg:hidden"
      @click="appStore.closeSidebar"
    />

    <Sidebar />

    <main class="relative h-full min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
      <header class="glass-panel relative z-30 mx-2 mt-2 h-16 flex shrink-0 items-center justify-between rounded-lg px-4 md:mx-4 md:mt-4 md:px-5">
        <div class="min-w-0 flex items-center gap-3">
          <button
            class="h-11 w-11 flex items-center justify-center rounded-lg text-gray-500 transition lg:hidden hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            type="button"
            aria-label="打开导航"
            :aria-expanded="sidebarOpen"
            @click="appStore.toggleSidebar"
          >
            <div class="i-carbon-menu text-xl" />
          </button>
          <div class="h-8 w-8 flex flex-none items-center justify-center overflow-hidden rounded-lg lg:hidden" :style="{ background: 'var(--theme-gradient)' }">
            <img
              v-if="loginPageConfig.logoUrl && !headerLogoFailed"
              :src="loginPageConfig.logoUrl"
              :alt="`${loginPageConfig.title || 'QQ农场智能助手'}图标`"
              class="h-full w-full object-cover"
              @error="headerLogoFailed = true"
            >
            <div v-else class="i-carbon-sprout text-base text-white" />
          </div>
          <div class="truncate text-base text-gray-900 font-semibold md:text-lg dark:text-gray-100 lg:hidden">
            {{ loginPageConfig.title || 'QQ农场智能助手' }}
          </div>
          <div class="layout-page-context hidden min-w-0 items-center gap-2 lg:flex" aria-label="当前页面">
            <span :class="pageContext.icon" aria-hidden="true" /><span>{{ pageContext.label }}</span>
          </div>
        </div>

        <span v-if="LOCAL_UI_READONLY" class="layout-readonly-status"><span class="i-carbon-view" aria-hidden="true" />本地浏览 · 无账号</span>
        <TopAccountMenu v-else />
      </header>

      <!-- Main Content Area -->
      <div class="min-h-0 flex flex-1 flex-col overflow-hidden">
        <MysteryMerchantBanner />
        <div ref="pageViewport" class="custom-scrollbar page-viewport min-h-0 flex flex-1 flex-col overflow-y-auto p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] md:p-6 sm:p-4 md:pb-6 sm:pb-[calc(1rem+env(safe-area-inset-bottom))]" data-page-viewport>
          <RouterView v-slot="{ Component, route }">
            <!-- Painted snapshots provide the exit/entry. Real old components
                 are still unmounted immediately when the route commits. -->
            <div :key="route.path" class="page-view min-h-0 flex flex-1 flex-col" data-page-content data-motion-entry>
              <component :is="Component" />
            </div>
          </RouterView>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.layout-page-context { color: var(--theme-text); font-size: 14px; font-weight: 500; }
.layout-page-context > span:first-child { color: var(--muted-text); font-size: 18px; }
.layout-readonly-status { display: inline-flex; flex-shrink: 0; align-items: center; gap: 6px; color: var(--muted-text); font-size: 12px; }
@media (max-width: 640px) { .layout-readonly-status { font-size: 11px; } }
/* 弹窗动画 */
.modal-fade-enter-active {
  animation: modal-in 0.4s ease-out;
}

.modal-fade-leave-active {
  animation: modal-out 0.3s ease-in;
}

@keyframes modal-in {
  0% {
    opacity: 0;
    transform: scale(0.9);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes modal-out {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(0.9);
  }
}

/* 弹窗样式 */
.warning-modal {
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

/* 水波纹背景 */
.ripple-bg {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}

.ripple {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle, rgba(239, 68, 68, 0.1) 0%, transparent 70%);
  animation: ripple-effect 4s ease-out infinite;
}

.ripple-1 {
  width: 200px;
  height: 200px;
  animation-delay: 0s;
}

.ripple-2 {
  width: 300px;
  height: 300px;
  animation-delay: 1.3s;
}

.ripple-3 {
  width: 400px;
  height: 400px;
  animation-delay: 2.6s;
}

/* Snapshot names are assigned only for a single transition, not on mount. */
.page-viewport { overflow-x: clip; contain: paint; }
/* Fixed overlays must retain their viewport positioning, even when an older
   page has not yet migrated its modal into the native top layer/Teleport. */
.page-viewport:has(dialog[open], [role='dialog'], .fixed) { contain: none; }
.page-view { transform-origin: 50% 32%; }

.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 3px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}

.custom-scrollbar {
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  /* 切换长/短活动内容时保留滚动条占位，避免视口变宽导致横幅和tab重新换行。 */
  scrollbar-gutter: stable;
}
</style>
