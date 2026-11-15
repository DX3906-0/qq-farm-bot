<script setup lang="ts">
// 仅负责操作栏展示；请求、确认和单次写锁仍由 FarmPanel 持有。
const props = defineProps<{
  operating: boolean
  unifiedHarvest: boolean
  summary?: { harvestable?: number, growing?: number, empty?: number, dead?: number } | null
}>()
const emit = defineEmits<{
  operate: [type: string]
  removeAll: []
  unifiedHarvest: []
}>()

const operations = [
  { type: 'harvest', label: '收获', icon: 'i-carbon-wheat', color: 'bg-blue-600 hover:bg-blue-700' },
  { type: 'clear', label: '一键务农', icon: 'i-carbon-clean', color: 'bg-teal-600 hover:bg-teal-700' },
  { type: 'plant', label: '种植', icon: 'i-carbon-sprout', color: 'bg-green-600 hover:bg-green-700' },
  { type: 'upgrade', label: '升级土地', icon: 'i-carbon-upgrade', color: 'bg-purple-600 hover:bg-purple-700' },
  { type: 'all', label: '一键全收', icon: 'i-carbon-flash', color: 'bg-orange-600 hover:bg-orange-700' },
]
</script>

<template>
  <div class="farm-toolbar">
    <div class="farm-toolbar-heading">
      <h3 class="farm-toolbar-title">
        <span class="i-carbon-grid" aria-hidden="true" />
        土地详情
      </h3>
      <div class="farm-toolbar-actions" role="group" aria-label="农场操作" :aria-busy="props.operating ? 'true' : undefined">
        <button
          v-for="op in operations"
          :key="op.type"
          type="button"
          class="farm-toolbar-button"
          :class="op.color"
          :disabled="props.operating"
          @click="emit('operate', op.type)"
        >
          <span :class="op.icon" aria-hidden="true" />
          <span>{{ op.label }}</span>
        </button>
        <button
          type="button"
          class="farm-toolbar-button bg-red-600 hover:bg-red-700"
          :disabled="props.operating"
          @click="emit('removeAll')"
        >
          <span class="i-carbon-trash-can" aria-hidden="true" />
          一键铲除
        </button>
        <button
          type="button"
          class="farm-toolbar-button"
          :class="props.unifiedHarvest ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'"
          :disabled="props.operating"
          :title="props.unifiedHarvest ? '正在等待最后一块地成熟，点击取消' : '等待最后一块地成熟后统一一键收取'"
          @click="emit('unifiedHarvest')"
        >
          <span :class="props.unifiedHarvest ? 'i-carbon-close' : 'i-carbon-timer'" aria-hidden="true" />
          {{ props.unifiedHarvest ? '取消统一收获' : '统一时间收获' }}
        </button>
      </div>
    </div>

    <div class="farm-toolbar-summary" role="group" aria-label="土地统计">
      <div class="farm-toolbar-stat bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
        <span class="i-carbon-clean" aria-hidden="true" />
        <span>可收: {{ props.summary?.harvestable || 0 }}</span>
      </div>
      <div class="farm-toolbar-stat bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <span class="i-carbon-sprout" aria-hidden="true" />
        <span>生长: {{ props.summary?.growing || 0 }}</span>
      </div>
      <div class="farm-toolbar-stat bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400">
        <span class="i-carbon-checkbox" aria-hidden="true" />
        <span>空闲: {{ props.summary?.empty || 0 }}</span>
      </div>
      <div class="farm-toolbar-stat bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <span class="i-carbon-warning" aria-hidden="true" />
        <span>枯萎: {{ props.summary?.dead || 0 }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.farm-toolbar {
  /* 位于土地卡片内，跟随 Personal 的实际滚动容器；卡片结束即自然退出。 */
  position: sticky;
  top: 0;
  z-index: 20;
  min-width: 0;
  color: var(--theme-text);
  background: var(--surface-1, #fcfbf6);
  border-radius: var(--radius-card, 8px) var(--radius-card, 8px) 0 0;
  box-shadow: 0 4px 8px rgb(0 0 0 / 0.05);
}

.farm-toolbar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--surface-border);
}

.farm-toolbar-title {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.5;
}

.farm-toolbar-title > span { font-size: 20px; }

.farm-toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.farm-toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 12px;
  border: 0;
  border-radius: 4px;
  color: #fff;
  font-size: 14px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 150ms ease, opacity 150ms ease;
}

.farm-toolbar-button:disabled { opacity: 0.5; cursor: not-allowed; }
.farm-toolbar-button:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: 2px; }

.farm-toolbar-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface-2, #f7f3ea);
  font-size: 14px;
}

.farm-toolbar-stat {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 639px) {
  .farm-toolbar-heading { gap: 8px; padding: 10px 12px; }
  .farm-toolbar-title { font-size: 16px; }
  .farm-toolbar-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; gap: 6px; }
  .farm-toolbar-button { min-height: 36px; gap: 4px; padding: 6px 4px; font-size: 12px; }
  .farm-toolbar-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 10px 12px; font-size: 11px; }
  .farm-toolbar-stat { gap: 4px; padding: 4px; }
}

@media (pointer: coarse) { .farm-toolbar-button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .farm-toolbar-button { transition: none; } }
</style>
