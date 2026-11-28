<script setup lang="ts">
import type { ActivityOverview, ActivityTodo } from '@/utils/activity-overview'
import BaseButton from '@/components/ui/BaseButton.vue'

defineProps<{ overview: ActivityOverview, loading?: boolean }>()
const emit = defineEmits<{ navigate: [target: string] }>()
const labels: Record<ActivityTodo['status'], string> = { ready: '待处理', done: '已领取', idle: '当前状态', unknown: '待确认' }
</script>

<template>
  <section class="activity-overview ui-card" aria-label="当前活动待办" :aria-busy="loading">
    <div class="activity-overview-heading">
      <h3><span class="i-carbon-task" aria-hidden="true" />当前待办</h3>
      <div class="activity-overview-count" role="status"><strong>{{ overview.ready ?? '—' }}</strong><span>{{ overview.known ? '项可处理' : loading ? '正在确认' : '进度待确认' }}</span></div>
    </div>
    <p class="activity-overview-note">{{ overview.note }}</p>
    <ul v-if="overview.tasks.length" class="activity-overview-list">
      <li v-for="task in overview.tasks" :key="task.id" :data-state="task.status">
        <span class="activity-overview-marker" aria-hidden="true" :class="task.status === 'done' ? 'i-carbon-checkmark-filled' : task.status === 'ready' ? 'i-carbon-notification' : 'i-carbon-information'" />
        <div class="activity-overview-copy"><h4>{{ task.label }}<span class="activity-overview-state">{{ labels[task.status] }}</span></h4><p>{{ task.detail }}</p></div>
        <span v-if="task.automated === true" class="activity-overview-auto">自动处理已开启</span>
        <span v-else-if="task.automated === null && task.status === 'ready'" class="activity-overview-auto">自动设置待确认</span>
        <span v-else-if="task.automated === false && task.status === 'ready'" class="activity-overview-auto">{{ task.target ? '需手动查看处理' : '自动处理未开启' }}</span>
        <BaseButton v-if="task.target" variant="secondary" size="sm" :disabled="loading" :aria-label="`${task.actionLabel || '查看'} · ${task.label}`" @click="emit('navigate', task.target)">{{ task.actionLabel || '查看' }}<span class="i-carbon-chevron-right ml-1" aria-hidden="true" /></BaseButton>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.activity-overview { min-width: 0; padding: 18px 20px; color: var(--theme-text); }
.activity-overview-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.activity-overview-heading h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 600; }
.activity-overview-heading h3 > span { font-size: 18px; color: var(--muted-text); }
.activity-overview-count { display: flex; align-items: baseline; gap: 6px; flex-shrink: 0; }
.activity-overview-count strong { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.activity-overview-count > span { font-size: 12px; color: var(--muted-text); }
.activity-overview-note { margin: 8px 0 0; color: var(--muted-text); font-size: 12px; line-height: 1.7; }
.activity-overview-list { list-style: none; margin: 12px 0 0; padding: 0; }
.activity-overview-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--surface-border); }
.activity-overview-marker { flex-shrink: 0; font-size: 18px; color: var(--muted-text); }
li[data-state='ready'] .activity-overview-marker { color: var(--status-warning); }
li[data-state='done'] .activity-overview-marker { color: var(--status-success); }
.activity-overview-copy { flex: 1; min-width: min(200px, 100%); }
.activity-overview-copy h4 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; }
.activity-overview-copy p { margin: 4px 0 0; color: var(--muted-text); font-size: 12px; line-height: 1.7; }
.activity-overview-state, .activity-overview-auto { font-size: 11px; color: var(--muted-text); font-weight: 400; }
.activity-overview-state { padding: 2px 6px; border-radius: 6px; background: var(--surface-2); }
@media (max-width: 640px) { .activity-overview { padding: 16px; }.activity-overview-copy { min-width: 0; flex-basis: calc(100% - 30px); }.activity-overview-auto { margin-left: 28px; } }
</style>
