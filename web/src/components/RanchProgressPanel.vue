<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import RanchItemImage from '@/components/RanchItemImage.vue'
import type { RanchProgressReward, RanchCoreProgressSection } from '@/stores/ranch'
import { ranchItemLabel, useRanchStore } from '@/stores/ranch'
import { formatIntegerAmount } from '@/utils/number-format'

const props = defineProps<{ section: RanchCoreProgressSection }>()
const emit = defineEmits<{ (e: 'request', action: string, input: Record<string, unknown>, title: string): void, (e: 'refresh'): void }>()
const { progressViews, progressLoading, progressErrors, writeBlocked, operations, operationsError } = storeToRefs(useRanchStore())
const taskCategory = ref<'daily' | 'growth' | 'other'>('daily')
const bookKind = ref<'normal' | 'giant'>('normal')
const showClaimed = ref(false)
const sharedInGame = ref(false)
const titles = { tasks: '成长手册与每日任务', book: '动物与巨大重量图鉴', share: '每日首次分享' }
const currentView = computed(() => progressViews.value[props.section])
const blocked = computed(() => writeBlocked.value || progressLoading.value[props.section] || !!progressErrors.value[props.section])
function pendingTarget(target: string) { return operations.value.some(row => row.target === target) }
function taskPending(taskId: string) {
  return operations.value.some(row => row.target === `ranch:claimTasks:${taskId}` || row.target === 'ranch:claimTasks:all')
}
const pendingTaskSummary = computed(() => {
  const count = operations.value.filter(row => row.target.startsWith('ranch:claimTasks:')).length
  return count ? `有 ${count} 项任务领取待核对；仅相同任务暂不能重领，其他操作仍可继续。` : ''
})
const visibleTasks = computed(() => (progressViews.value.tasks?.tasks || [])
  .filter(row => row.category === taskCategory.value && (showClaimed.value || !row.claimed)))
const ordinaryAnimals = computed(() => progressViews.value.book?.animals || [])
const giantAnimals = computed(() => ordinaryAnimals.value.filter(animal => !!animal.giantItem))
const visibleBookAnimals = computed(() => bookKind.value === 'giant' ? giantAnimals.value : ordinaryAnimals.value)
function amount(value: string | number | null | undefined) {
  if (value == null) return '未确认'
  const formatted = formatIntegerAmount(value)
  return formatted === '—' ? '未确认' : formatted
}
function rewardText(items: RanchProgressReward[]) {
  return items.map(item => `${item.name || ranchItemLabel(item.id)} ×${amount(item.count)}`).join('、') || '奖励未确认'
}
function taskPercent(progress: string, total: string) {
  if (!/^\d+$/.test(progress) || !/^[1-9]\d*$/.test(total)) return 0
  const percent = BigInt(progress) * 100n / BigInt(total)
  return Number(percent > 100n ? 100n : percent)
}
function requestReport() {
  if (blocked.value || !sharedInGame.value || !progressViews.value.share?.canReport) return
  emit('request', 'reportDailyShare', { sharedInGame: true }, '确认上报已完成的牧场分享')
}
</script>

<template>
  <section class="ranch-progress space-y-4">
    <div class="ui-card rounded-lg p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold">{{ titles[section] }}</h2>
        <BaseButton variant="secondary" size="sm" :loading="progressLoading[section]" @click="emit('refresh')">刷新专区</BaseButton>
      </div>
      <p v-if="currentView" class="progress-muted mt-3 text-xs">游戏日期 {{ currentView.dateKey }} · {{ new Date(currentView.observedAt).toLocaleString('zh-CN', { hour12: false }) }} · {{ currentView.cache?.hit ? '短时缓存' : '本次读取' }}</p>
    </div>
    <div v-if="operationsError" class="market-error rounded-lg border border-[var(--surface-border)] p-3 text-sm" role="status">操作安全状态暂不可读取，所有写操作已暂停：{{ operationsError }}</div>
    <p v-else-if="operations.length" class="progress-muted rounded-lg border border-[var(--surface-border)] p-3 text-xs" role="status">{{ pendingTaskSummary || `有 ${operations.length} 项操作待核对；只阻止同一目标或冲突资源的操作。` }}</p>
    <div v-if="progressLoading[section] && !currentView" class="ui-card rounded-lg p-8 progress-muted">正在读取当前牧场专区…</div>
    <div v-else-if="!currentView" class="ui-empty-state">暂无数据</div>

    <template v-else-if="section === 'tasks' && progressViews.tasks">
      <div class="grid gap-4 sm:grid-cols-3">
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">当前任务</span><strong class="progress-number">{{ amount(progressViews.tasks.summary.total) }}</strong></article>
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">可普通领取</span><strong class="progress-number">{{ progressViews.tasks.summary.claimable }}</strong></article>
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">已确认领取</span><strong class="progress-number">{{ progressViews.tasks.summary.claimed }}</strong></article>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-2">
          <BaseButton v-for="category in ([['daily', '每日任务'], ['growth', '成长手册'], ['other', '未确认任务']] as const)" :key="category[0]" size="sm" :variant="taskCategory === category[0] ? 'primary' : 'secondary'" @click="taskCategory = category[0]">{{ category[1] }}</BaseButton>
          <label class="progress-muted flex items-center gap-2 text-xs"><input v-model="showClaimed" type="checkbox">显示已领取</label>
        </div>
        <BaseButton size="sm" :disabled="blocked || !progressViews.tasks.summary.claimable || operations.some(row => row.target.startsWith('ranch:claimTasks:'))" title="批量领取会包含所有可领任务；存在任务待核对时请逐项处理其他无冲突操作" @click="emit('request', 'claimTasks', { all: true, double: false }, '领取所有可领任务')">全部领取</BaseButton>
      </div>
      <div v-if="visibleTasks.length" class="grid gap-3 lg:grid-cols-2">
        <article v-for="task in visibleTasks" :key="task.id" class="ui-card rounded-lg p-5">
          <div class="flex items-start justify-between gap-3"><h3 class="text-sm font-semibold">{{ task.description }}</h3><span class="progress-chip">{{ task.stateReason }}</span></div>
          <p class="progress-muted mt-2 text-xs">任务 {{ task.id }} · {{ amount(task.progress) }} / {{ amount(task.total) }}</p>
          <div class="progress-track mt-3"><div :style="{ width: `${taskPercent(task.progress, task.total)}%` }" /></div>
          <p class="mt-3 text-sm">{{ rewardText(task.rewards) }}</p>
          <p v-if="task.extraRewards.length" class="progress-muted mt-2 text-xs">附加奖励仅展示：{{ rewardText(task.extraRewards) }}</p>
          <p v-if="task.condition === '客户端上报进度' && !task.claimed" class="progress-muted mt-2 text-xs">请在游戏内实际完成此引导，本面板不代报进度。</p>
          <BaseButton class="mt-4" size="sm" variant="secondary" :disabled="blocked || !task.canClaim || taskPending(task.id)" :title="taskPending(task.id) ? '这项领取结果待核对，不能重复提交' : ''" @click="emit('request', 'claimTasks', { taskId: task.id, double: false }, `领取：${task.description}`)">{{ task.claimed ? '已领取' : taskPending(task.id) ? '结果待核对' : '领取' }}</BaseButton>
        </article>
      </div>
      <p v-else class="ui-empty-state">当前分类暂无任务</p>
    </template>

    <template v-else-if="section === 'book' && progressViews.book">
      <div class="grid gap-4 sm:grid-cols-3">
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">动物图鉴等级</span><strong class="progress-number">Lv.{{ progressViews.book.normal.currentLevel }}</strong></article>
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">图鉴进度</span><strong class="progress-number">{{ progressViews.book.normal.totalProgress }}<small> / {{ progressViews.book.normal.nextProgress }}</small></strong></article>
        <article class="ui-card metric-card rounded-lg p-5"><span class="progress-muted text-xs">巨大重量总分</span><strong class="progress-number">{{ amount(progressViews.book.giant.totalScore) }}</strong></article>
      </div>
      <div class="ui-card rounded-lg p-5">
        <div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="text-sm font-semibold">动物图鉴奖励</h3><p class="progress-muted mt-2 text-xs">{{ progressViews.book.normal.stateReason || rewardText(progressViews.book.normal.rewards) }}</p></div><BaseButton size="sm" :disabled="blocked || !progressViews.book.normal.canClaim || pendingTarget('ranch:claimIllustrated:101')" :title="pendingTarget('ranch:claimIllustrated:101') ? '图鉴奖励结果待核对，不能重复领取' : ''" @click="emit('request', 'claimIllustrated', { kind: 'normal' }, '领取动物图鉴奖励')">{{ pendingTarget('ranch:claimIllustrated:101') ? '结果待核对' : '领取奖励' }}</BaseButton></div>
      </div>
      <div class="ui-card rounded-lg p-5">
        <h3 class="text-sm font-semibold">巨大重量奖励 · 逐档确认</h3>
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <article v-for="level in progressViews.book.giant.levels" :key="level.id" class="progress-inset">
            <div class="flex items-center justify-between gap-3"><strong class="text-sm">档位 {{ level.id }}</strong><span class="progress-chip">{{ level.claimed ? '已领取' : level.canClaim ? '可领取' : '未达标或未确认' }}</span></div>
            <p class="progress-muted mt-2 text-xs">需总分 {{ amount(level.need) }}</p><p class="mt-2 text-sm">{{ rewardText(level.rewards) }}</p>
            <BaseButton size="sm" variant="secondary" class="mt-3" :disabled="blocked || !level.canClaim || pendingTarget(`ranch:claimWeight:${level.id}`)" :title="pendingTarget(`ranch:claimWeight:${level.id}`) ? '此档结果待核对，不能重复领取' : ''" @click="emit('request', 'claimWeight', { levelId: level.id }, `领取巨大重量档位 ${level.id}`)">{{ pendingTarget(`ranch:claimWeight:${level.id}`) ? '结果待核对' : '领取本档' }}</BaseButton>
          </article>
        </div>
        <p v-if="!progressViews.book.giant.levels.length" class="progress-muted mt-3 text-xs">暂无重量奖励档位</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton size="sm" :variant="bookKind === 'normal' ? 'primary' : 'secondary'" @click="bookKind = 'normal'">普通动物（{{ ordinaryAnimals.length }}）</BaseButton>
        <BaseButton size="sm" :variant="bookKind === 'giant' ? 'primary' : 'secondary'" @click="bookKind = 'giant'">巨大动物（{{ giantAnimals.length }}）</BaseButton>
      </div>
      <div v-if="visibleBookAnimals.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="animal in visibleBookAnimals" :key="`${bookKind}-${animal.id}`" class="ui-card rounded-lg p-5">
          <div class="flex items-start justify-between gap-3"><div class="flex items-center gap-2"><RanchItemImage :src="bookKind === 'giant' ? animal.giantItem!.image : animal.image" :alt="bookKind === 'giant' ? animal.giantItem!.name : animal.name" /><h3 class="text-sm font-semibold">{{ bookKind === 'giant' ? animal.giantItem!.name : animal.name }}</h3></div><span class="progress-chip">{{ bookKind === 'giant' ? animal.giant?.unlocked ? '已点亮巨大记录' : '尚无重量记录' : animal.unlocked ? '已点亮' : '未点亮' }}</span></div>
          <template v-if="bookKind === 'normal'"><p class="progress-muted mt-2 text-xs">进度 {{ animal.progress }} · 层数 {{ animal.layer }}</p><p v-if="!animal.image" class="progress-muted mt-2 text-xs">暂无图片</p></template>
          <div v-else-if="animal.giant?.unlocked" class="progress-inset mt-3"><strong class="text-sm">巨大 · {{ animal.giant.tierName }}</strong><p class="mt-2 text-sm">最高 {{ animal.giant.bestWeightKg.toFixed(2) }} kg</p><p class="progress-muted mt-1 text-xs">范围 {{ animal.giant.minWeightKg.toFixed(2) }}–{{ animal.giant.maxWeightKg.toFixed(2) }} kg · 收获 {{ amount(animal.giant.harvestCount) }} 次</p></div>
          <p v-else class="progress-muted mt-3 text-xs">尚无已点亮的巨大重量记录</p>
          <p v-if="bookKind === 'giant' && !animal.giantItem!.image" class="progress-muted mt-2 text-xs">暂无图片</p>
        </article>
      </div>
      <p v-else class="ui-empty-state">当前图鉴分类没有条目。</p>
      <p v-for="mutation in progressViews.book.mutations" :key="mutation.type" class="ui-notice">{{ mutation.name }}：{{ mutation.description }}。基础配置概率 {{ mutation.baseProbabilityPercent }}%，实际状态以游戏为准。</p>
    </template>

    <template v-else-if="section === 'share' && progressViews.share">
      <div class="ui-card rounded-lg p-5">
        <div class="flex flex-wrap items-center justify-between gap-3"><h3 class="text-base font-semibold">牧场分享礼包</h3><span class="progress-chip">{{ progressViews.share.stateReason }}</span></div>
        <p class="mt-3 text-sm">奖励：{{ rewardText(progressViews.share.rewards) }}</p>
        <div class="progress-share-steps mt-5">
          <article class="progress-inset"><span class="progress-step">1</span><h4 class="mt-3 text-sm font-semibold">在游戏内完成分享</h4><p class="progress-muted mt-2 text-xs">{{ progressViews.share.shared ? '游戏侧已返回分享次数。' : '先完成实际分享，再勾选确认；本面板不代发社交消息。' }}</p><label v-if="progressViews.share.canReport" class="mt-3 flex items-start gap-2 text-sm"><input v-model="sharedInGame" type="checkbox" class="mt-1">我已在游戏内完成本次分享</label></article>
          <article class="progress-inset"><span class="progress-step">2</span><h4 class="mt-3 text-sm font-semibold">确认上报分享</h4><p class="progress-muted mt-2 text-xs">只确认分享次数，不把上报当作领取礼包。</p><BaseButton size="sm" variant="secondary" class="mt-4" :disabled="blocked || !sharedInGame || !progressViews.share.canReport || pendingTarget('ranch:reportDailyShare:102') || pendingTarget('ranch:claimDailyShare:102')" @click="requestReport">登记分享状态</BaseButton></article>
          <article class="progress-inset"><span class="progress-step">3</span><h4 class="mt-3 text-sm font-semibold">独立确认领奖</h4><p class="progress-muted mt-2 text-xs">分享已确认且尚未领取时，才开放本步骤。</p><BaseButton size="sm" class="mt-4" :disabled="blocked || !progressViews.share.canClaim || pendingTarget('ranch:reportDailyShare:102') || pendingTarget('ranch:claimDailyShare:102')" :title="pendingTarget('ranch:reportDailyShare:102') || pendingTarget('ranch:claimDailyShare:102') ? '分享礼包结果待核对，不能重复提交' : ''" @click="emit('request', 'claimDailyShare', {}, '领取牧场每日首次分享礼包')">{{ progressViews.share.claimed === true ? '今日已领取' : pendingTarget('ranch:reportDailyShare:102') || pendingTarget('ranch:claimDailyShare:102') ? '结果待核对' : '领取礼包' }}</BaseButton></article>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ranch-progress { color: var(--theme-text); }
.progress-muted { color: var(--muted-text); }
.progress-number { display: block; margin-top: 12px; font-size: 26px; font-variant-numeric: tabular-nums; }
.progress-number small { font-size: 13px; color: var(--muted-text); font-weight: 400; }
.progress-chip { flex: none; border-radius: 999px; padding: 4px 9px; color: var(--muted-text); background: var(--surface-2); font-size: 11px; }
.progress-track { height: 5px; overflow: hidden; border-radius: 999px; background: var(--surface-3); }
.progress-track > div { height: 100%; border-radius: inherit; background: var(--theme-primary); }
.progress-inset { min-width: 0; border: 1px solid var(--surface-border); border-radius: var(--radius-card); padding: 16px; background: var(--surface-2); }
.progress-error { border-left-color: var(--status-warning); color: var(--status-warning); }
.progress-share-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.progress-step { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--theme-primary) 14%, transparent); color: var(--theme-primary); font-size: 12px; font-weight: 600; }
@media (max-width: 800px) { .progress-share-steps { grid-template-columns: 1fr; }.progress-chip { max-width: 55%; white-space: normal; line-height: 1.5; } }
</style>
