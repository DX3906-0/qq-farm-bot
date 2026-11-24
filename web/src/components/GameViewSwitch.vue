<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { warmMenuCode } from '@/router/menu'

const props = withDefaults(defineProps<{ view: 'overview' | 'farm' | 'ranch', title?: string, description?: string, navigation?: boolean }>(), { navigation: true })
const titles = { overview: '总概览', farm: '农场', ranch: '牧场' }
const icons = { overview: 'i-carbon-chart-pie', farm: 'i-carbon-growth', ranch: 'i-carbon-sprout' }
const destinations = computed(() => props.navigation === false ? [] : props.view === 'overview'
  ? [{ path: '/', label: '进入农场', icon: icons.farm }, { path: '/ranch', label: '去牧场', icon: icons.ranch }]
  : [{ path: props.view === 'ranch' ? '/ranch/overview' : '/overview', label: '总概览', icon: icons.overview }, props.view === 'farm'
      ? { path: '/ranch', label: '去牧场', icon: icons.ranch }
      : { path: '/', label: '回农场', icon: icons.farm }])
</script>

<template>
  <header class="ui-card game-view-switch rounded-lg p-5" :data-game-view="view">
    <div class="min-w-0">
      <p class="game-view-eyebrow">农牧场管理 <span aria-hidden="true">/</span> {{ titles[view] }}</p>
      <div class="mt-2 flex items-center gap-2.5">
        <span :class="icons[view]" class="game-view-icon" aria-hidden="true" />
        <h1 class="text-xl font-bold">{{ title || titles[view] }}</h1>
      </div>
      <p v-if="description" class="game-view-description">{{ description }}</p>
    </div>
    <nav v-if="navigation !== false || $slots.default" class="game-view-actions" :aria-label="navigation === false ? '页面操作' : '农场与牧场工作区切换'">
      <BaseButton
        v-for="(destination, index) in destinations" :key="destination.path" :to="destination.path"
        :variant="index === destinations.length - 1 ? 'primary' : 'secondary'"
        @mouseenter="warmMenuCode(destination.path)" @focus="warmMenuCode(destination.path)"
      >
        <span :class="destination.icon" aria-hidden="true" />{{ destination.label }}
        <span v-if="index === destinations.length - 1" class="i-carbon-arrow-right" aria-hidden="true" />
      </BaseButton>
      <slot />
    </nav>
  </header>
</template>

<style scoped>
.game-view-switch { display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--theme-text); }
.game-view-eyebrow { margin: 0; color: var(--muted-text); font-size: 11px; letter-spacing: .04em; }
.game-view-eyebrow span { padding: 0 6px; opacity: .5; }
.game-view-icon { color: var(--theme-primary); font-size: 24px; }
.game-view-description { margin: 8px 0 0; max-width: 52rem; color: var(--muted-text); font-size: 13px; line-height: 1.7; }
.game-view-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; gap: 8px; }
@media (max-width: 820px) { .game-view-switch { align-items: flex-start; flex-direction: column; gap: 16px; }.game-view-actions { width: 100%; } }
@media (max-width: 420px) { .game-view-actions :deep(.base-button) { flex: 1; white-space: nowrap; } }
</style>
