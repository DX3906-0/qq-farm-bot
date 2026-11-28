<script setup lang="ts">
import { vSlidingTabs } from '@/composables/useContentMotion'
export type FriendTabKey = 'friends' | 'blacklist' | 'visitors'

export interface FriendTabItem {
  key: FriendTabKey
  label: string
  icon: string
}

defineProps<{
  tabs: readonly FriendTabItem[]
  blacklistCount: number
}>()

const activeTab = defineModel<FriendTabKey>('activeTab', { required: true })
</script>

<template>
  <div v-sliding-tabs class="ui-tabs mb-4" aria-label="好友分类">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      data-motion-nav
      type="button" class="ui-tab"
      :data-active="activeTab === tab.key" :aria-pressed="activeTab === tab.key"
      @click="activeTab = tab.key"
    >
      <div :class="tab.icon" />
      {{ tab.label }}
      <span
        v-if="tab.key === 'blacklist' && blacklistCount > 0"
        class="rounded-full bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400"
      >
        {{ blacklistCount }}
      </span>
    </button>
  </div>
</template>
