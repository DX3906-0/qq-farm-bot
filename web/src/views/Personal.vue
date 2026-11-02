<script setup lang="ts">
import { ref } from 'vue'
import BagPanel from '@/components/BagPanel.vue'
import EmailPanel from '@/components/EmailPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import SkinPanel from '@/components/SkinPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'
import AnnouncementPanel from '@/components/AnnouncementPanel.vue'

const currentTab = ref<'farm' | 'skin' | 'bag' | 'task' | 'email' | 'announcement'>('farm')

/** 装扮面板：按 tab 懒挂载，避免一进个人页就打装扮接口 */
const panelOf = (tab: string) => {
  if (tab === 'farm')
    return FarmPanel
  if (tab === 'skin')
    return SkinPanel
  if (tab === 'bag')
    return BagPanel
  if (tab === 'task')
    return TaskPanel
  if (tab === 'email')
    return EmailPanel
  return AnnouncementPanel
}
</script>

<template>
  <div class="h-full flex flex-col p-3 sm:p-4">
    <!--
      移动端适配（2026-10-31）：
      原写法 `flex space-x-2` 是 nowrap，6 个按钮总宽远超手机屏宽，
      flex 不会换行、只会把父容器撑宽 → 整个页面被横向拉出滚动条。
      修法：
        1. flex-wrap + gap-y：窄屏自动折行（用 gap 替代 space-x，折行后行间距也正确）
        2. 按钮收缩：px-3 → sm:px-4，图标/文字在极窄屏略缩，保证两列也放得下
        3. min-w-0 + shrink-0：允许按钮收缩但不压扁图标
        4. 外层 overflow-x-hidden：兜底，绝不让 tab 区把页面撑宽
    -->
    <div class="mb-4 flex flex-wrap gap-2 overflow-x-hidden">
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'farm'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'farm' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'farm'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-sprout text-base sm:text-lg" />
          <span class="whitespace-nowrap">我的农场</span>
        </div>
      </button>
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'bag'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'bag' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'bag'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-box text-base sm:text-lg" />
          <span class="whitespace-nowrap">我的背包</span>
        </div>
      </button>
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'task'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'task' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'task'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-task text-base sm:text-lg" />
          <span class="whitespace-nowrap">我的任务</span>
        </div>
      </button>
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'skin'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'skin' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'skin'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-paint-brush text-base sm:text-lg" />
          <span class="whitespace-nowrap">装扮</span>
        </div>
      </button>
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'email'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'email' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'email'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-mail-all text-base sm:text-lg" />
          <span class="whitespace-nowrap">我的邮箱</span>
        </div>
      </button>
      <button
        class="shrink-0 rounded-lg px-3 py-2 font-medium transition-colors sm:px-4"
        :class="currentTab === 'announcement'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'announcement' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'announcement'"
      >
        <div class="flex items-center space-x-1.5 sm:space-x-2">
          <div class="i-carbon-notification text-base sm:text-lg" />
          <span class="whitespace-nowrap">公告</span>
        </div>
      </button>
    </div>

    <div class="min-w-0 flex-1 overflow-hidden overflow-y-auto">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="transform opacity-0 scale-95"
        enter-to-class="transform opacity-100 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="transform opacity-100 scale-100"
        leave-to-class="transform opacity-0 scale-95"
      >
        <component :is="panelOf(currentTab)" :key="currentTab" />
      </Transition>
    </div>
  </div>
</template>
