<script setup lang="ts">
import { ref, useId } from 'vue'
import { moveSlidingTabFocus, useSlidingTabs, vSlidingTabs } from '@/composables/useContentMotion'

export type AdminTabKey = 'card' | 'user' | 'log' | 'system'

export interface AdminTabItem {
  key: AdminTabKey
  label: string
  icon: string
}

const props = defineProps<{
  tabs: readonly AdminTabItem[]
}>()

const activeTab = defineModel<AdminTabKey>('activeTab', { required: true })
const adminContent = ref<HTMLElement | null>(null)
const adminPanelId = useId()
const { select: selectAdminTab, selected: selectedAdminTab } = useSlidingTabs(activeTab, () => adminContent.value, () => props.tabs.map(tab => tab.key))
</script>

<template>
  <div class="border border-gray-200 rounded-lg bg-white shadow dark:border-gray-700 dark:bg-gray-800">
    <div class="border-b border-gray-200 dark:border-gray-700">
      <nav v-sliding-tabs class="ui-tabs !border-0 !rounded-none" role="tablist" aria-label="后台管理功能">
        <button
          v-for="tab in tabs"
          :id="`${adminPanelId}-${tab.key}`"
          :key="tab.key"
          type="button"
          class="ui-tab"
          role="tab"
          :data-active="selectedAdminTab === tab.key"
          :aria-selected="selectedAdminTab === tab.key"
          :aria-controls="`${adminPanelId}-content`"
          :tabindex="selectedAdminTab === tab.key ? 0 : -1"
          @click="selectAdminTab(tab.key)"
          @keydown="moveSlidingTabFocus"
        >
          <span :class="tab.icon" aria-hidden="true" /><span class="ui-tab-label">{{ tab.label }}</span>
        </button>
      </nav>
    </div>

    <div :id="`${adminPanelId}-content`" ref="adminContent" class="tab-motion-viewport" role="tabpanel" :aria-labelledby="`${adminPanelId}-${activeTab}`">
      <div class="p-4" data-motion-entry>
        <slot />
      </div>
    </div>
  </div>
</template>
