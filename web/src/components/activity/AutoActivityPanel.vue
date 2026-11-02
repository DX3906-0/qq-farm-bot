<script setup lang="ts">
import { onMounted } from 'vue'
import { useActivityDiscoveryStore } from '@/stores/activityDiscovery'

const discovery = useActivityDiscoveryStore()

onMounted(() => {
  discovery.fetchDiscovery()
})
</script>

<template>
  <section v-if="discovery.newActivity" class="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-800">
    <div class="bg-gradient-to-r from-sky-500 to-indigo-500 px-5 py-4 text-white">
      <div class="flex items-center gap-3">
        <div class="i-carbon-star text-3xl" />
        <div>
          <h2 class="text-lg font-bold">
            发现新活动
          </h2>
          <p class="mt-0.5 text-sm text-white/85">
            检测到未适配的新活动，等待 bot 后续接入
          </p>
        </div>
      </div>
    </div>

    <div class="p-5">
      <div class="flex h-32 w-full items-center justify-center rounded-lg bg-gradient-to-r from-sky-100 to-indigo-100 dark:from-sky-900/20 dark:to-indigo-900/20">
        <span class="i-carbon-star text-4xl text-sky-400" />
      </div>
      <div class="mt-4 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="text-base font-semibold text-gray-900 dark:text-gray-100">
            {{ discovery.newActivity.title || `活动 #${discovery.newActivity.id}` }}
          </div>
          <div class="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
            ID：{{ discovery.newActivity.id }} · 尚未适配专属面板，自动化入口在「设置-自动化-活动任务」中配置
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
