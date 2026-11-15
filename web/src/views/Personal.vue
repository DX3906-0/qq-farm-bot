<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref, useId, watch } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import EmailPanel from '@/components/EmailPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import SkinPanel from '@/components/SkinPanel.vue'
import AvatarFramePanel from '@/components/AvatarFramePanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'
import AnnouncementPanel from '@/components/AnnouncementPanel.vue'
import { readAccountUiState, useAccountScroll, writeAccountUiState } from '@/composables/useAccountUiState'
import { useSlidingTabs, vSlidingTabs } from '@/composables/useContentMotion'
import { useAccountStore } from '@/stores/account'

const { currentAccountId } = storeToRefs(useAccountStore())
const tabs = [
  { key: 'farm', label: '我的农场', icon: 'i-carbon-sprout', component: FarmPanel },
  { key: 'bag', label: '我的背包', icon: 'i-carbon-box', component: BagPanel },
  { key: 'task', label: '我的任务', icon: 'i-carbon-task', component: TaskPanel },
  { key: 'skin', label: '装扮', icon: 'i-carbon-paint-brush', component: SkinPanel },
  { key: 'avatar', label: '头像框 / 铭牌', icon: 'i-carbon-user-avatar', component: AvatarFramePanel },
  { key: 'email', label: '我的邮箱', icon: 'i-carbon-mail-all', component: EmailPanel },
  { key: 'announcement', label: '公告', icon: 'i-carbon-notification', component: AnnouncementPanel },
] as const
type PersonalTab = typeof tabs[number]['key']
function rememberedTab(accountId: string): PersonalTab {
  const saved = readAccountUiState(accountId, 'personal').tab
  return tabs.some(tab => tab.key === saved) ? saved as PersonalTab : 'farm'
}
const currentTab = ref<PersonalTab>(rememberedTab(String(currentAccountId.value)))
const panelOf = (tab: PersonalTab) => tabs.find(item => item.key === tab)?.component || FarmPanel
let restoringTab = false
watch(currentAccountId, id => {
  panelMotion.cancel('context')
  restoringTab = true
  currentTab.value = rememberedTab(String(id))
  restoringTab = false
}, { flush: 'sync' })
watch(currentTab, tab => {
  if (!restoringTab)
    writeAccountUiState(String(currentAccountId.value), 'personal', { tab })
}, { flush: 'sync' })

const panelId = useId()
const content = ref<HTMLElement | null>(null)
const tabNav = ref<HTMLElement | null>(null)
const panelMotion = useSlidingTabs(currentTab, () => content.value, () => tabs.map(tab => tab.key), () => currentAccountId.value)
const { select: selectTab, selected: selectedTab } = panelMotion
const scrollView = computed(() => `personal:${currentTab.value}`)
const { onUserScroll, cancelRestore } = useAccountScroll(currentAccountId, scrollView, content)
function moveTabFocus(event: KeyboardEvent, index: number) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key))
    return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  // Focus only; Enter/Space activates. Arrow navigation never starts a game read.
  tabNav.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}
</script>

<template>
  <div class="personal-view h-full min-h-0 min-w-0 flex flex-col">
    <div class="personal-heading ui-page-heading">
      <div><h1>个人中心</h1><p>照料农场，管理物品与装扮。</p></div>
    </div>
    <nav ref="tabNav" v-sliding-tabs class="personal-tabs ui-tabs" role="tablist" aria-label="个人功能">
      <button
        v-for="(tab, index) in tabs" :id="`${panelId}-${tab.key}`" :key="tab.key"
        type="button" role="tab" class="personal-tab ui-tab"
        :aria-selected="selectedTab === tab.key" :aria-controls="`${panelId}-panel`"
        :tabindex="selectedTab === tab.key ? 0 : -1" :data-active="selectedTab === tab.key"
        @click="selectTab(tab.key)" @keydown="moveTabFocus($event, index)"
      >
        <span :class="tab.icon" aria-hidden="true" /><span class="ui-tab-label">{{ tab.label }}</span>
      </button>
    </nav>
    <section
      :id="`${panelId}-panel`" ref="content" class="personal-content min-w-0 flex-1 overflow-y-auto"
      role="tabpanel" :aria-labelledby="`${panelId}-${currentTab}`" tabindex="0"
      @scroll="onUserScroll" @wheel.passive="cancelRestore" @touchstart.passive="cancelRestore"
      @pointerdown="cancelRestore" @keydown="cancelRestore"
    >
      <div class="personal-panel">
        <!-- No KeepAlive: hidden game panels must not continue their timers. -->
        <div :key="currentTab" class="personal-panel-entry" data-motion-entry><component :is="panelOf(currentTab)" /></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.personal-heading { display: flex; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 0 2px 18px; }
.personal-heading h1 { margin: 0; font-size: 24px; font-weight: 600; color: var(--theme-text); }
.personal-heading p { margin: 6px 0 0; font-size: 13px; color: var(--muted-text); }
.personal-panel-entry { transform-origin: 50% 30%; }
.personal-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; margin-bottom: 16px; border: 1px solid var(--surface-border); border-radius: var(--radius-card, 12px); background: var(--surface-1); }
.personal-tab { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 14px; border: 1px solid transparent; border-radius: var(--radius-control, 8px); background: transparent; color: var(--theme-text); font-size: 14px; font-weight: 500; cursor: pointer; transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease; }
.personal-tab span:last-child { transition: transform 90ms ease; }
.personal-tab:active span:last-child { transform: scale(.97); }
.personal-tab:hover { background: var(--surface-2); color: var(--theme-text); }
.personal-tab[data-active='true'] { background: var(--action-bg, #416d3b); color: var(--action-text, #fff); }
.personal-content { overflow-x: clip; scrollbar-gutter: stable; overscroll-behavior: contain; }
.personal-panel { min-width: 0; padding: 0 2px 16px; }
@media (max-width: 640px) { .personal-heading { padding-bottom: 14px; } .personal-heading h1 { font-size: 20px; } .personal-tabs { gap: 4px; padding: 6px; } .personal-tab { min-height: 44px; padding: 8px 10px; font-size: 13px; } }
@media (prefers-reduced-motion: reduce) { .personal-tab, .personal-tab span { transition: none; } .personal-tab:active span:last-child { transform: none; } .personal-panel-entry { transform: none; } }
</style>
