<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import type { ShareRewardActivityData, ShareMilestoneTier } from '@/stores/activity'

const props = defineProps<{
  activity?: ShareRewardActivityData | null
  loading?: boolean
  operateLoading?: boolean
}>()
// 主操作：share（首次分享）、daily（领每日）、milestones（领里程碑）
const emit = defineEmits<{ share: [], daily: [], milestones: [], refresh: [] }>()

const activityEnded = computed(() => {
  const a = props.activity
  if (!a) return false
  if (a.active === false) return true
  if (a.endTime > 0 && a.endTime * 1000 < Date.now()) return true
  return false
})
const score = computed(() => Math.max(0, Number(props.activity?.currentScore) || 0))
const milestones = computed<ShareMilestoneTier[]>(() => [...(props.activity?.milestones || [])].sort((a, b) => a.threshold - b.threshold))
const maxThreshold = computed(() => milestones.value[milestones.value.length - 1]?.threshold || 0)
const claimableMilestones = computed(() => milestones.value.filter(m => m.state === 2 && m.threshold <= score.value))
const overallProgress = computed(() => {
  if (maxThreshold.value <= 0) return 0
  return Math.min(100, Math.round(score.value / maxThreshold.value * 100))
})

function timeText(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
}
function rewardText(tier: ShareMilestoneTier) {
  return (tier.rewards || []).map(r => `${r.itemName || (r.itemId ? `物品#${r.itemId}` : '奖励')}${Number(r.itemCount ?? r.count ?? 0) > 1 ? ` ×${Number(r.itemCount ?? r.count ?? 0)}` : ''}`).join('、') || '未配置结算'
}
function stateText(s: number) {
  if (s === 3) return '已领取'
  if (s === 2) return '可领取'
  return '未达成'
}
function stateClass(s: number) {
  if (s === 3) return 'text-emerald-600 dark:text-emerald-300'
  if (s === 2) return 'text-amber-600 dark:text-amber-300'
  return 'text-gray-400'
}
function segmentProgress(index: number) {
  const start = milestones.value[index - 1]?.threshold || 0
  const end = milestones.value[index]?.threshold || 0
  if (end <= start) return score.value >= end ? 100 : 0
  return Math.min(100, Math.max(0, (score.value - start) / (end - start) * 100))
}
</script>

<template>
  <div class="space-y-4">
    <template v-if="activityEnded">
      <div class="rounded-xl bg-white p-5 text-center shadow-sm dark:bg-gray-800">
        <p class="text-sm font-semibold text-gray-900 dark:text-white">快乐不独享活动已结束</p>
        <p class="mt-1 text-xs text-gray-500">已结束的活动不可再操作。</p>
      </div>
    </template>
    <template v-else>
      <!-- 头部信息 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div>
          <h3 class="font-semibold text-gray-900 dark:text-white">快乐不独享 · 分享奖励</h3>
          <p class="mt-1 text-xs text-gray-500">{{ timeText(activity?.startTime) }} — {{ timeText(activity?.endTime) }}</p>
        </div>
        <div class="text-right">
          <div class="text-lg font-bold text-amber-600 dark:text-amber-300">{{ score }}</div>
          <div class="text-xs text-gray-500">当前快乐值 / 目标 {{ maxThreshold }}</div>
        </div>
      </div>

      <!-- 每日操作三卡 -->
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <div class="text-xs text-gray-500">首次分享</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{{ activity?.daily.firstShareAwarded ? '已完成' : '待完成' }}</div>
          <BaseButton class="mt-3 w-full" :loading="operateLoading" :disabled="activity?.daily.firstShareAwarded === true || activityEnded" @click="emit('share')">
            {{ activity?.daily.firstShareAwarded ? '已完成' : '去分享' }}
          </BaseButton>
        </div>
        <div class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <div class="text-xs text-gray-500">今日奖励</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{{ activity?.daily.rewardClaimed ? '已领取' : '可领取' }}</div>
          <BaseButton class="mt-3 w-full" :loading="operateLoading" :disabled="activity?.daily.rewardClaimed === true || activityEnded" @click="emit('daily')">
            {{ activity?.daily.rewardClaimed ? '已领取' : '领取每日' }}
          </BaseButton>
        </div>
        <div class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <div class="text-xs text-gray-500">里程碑</div>
          <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{{ claimableMilestones.length ? `${claimableMilestones.length} 档可领` : '暂无可领' }}</div>
          <BaseButton class="mt-3 w-full" :loading="operateLoading" :disabled="!claimableMilestones.length || activityEnded" @click="emit('milestones')">
            {{ claimableMilestones.length ? '领取里程碑' : '暂无可领' }}
          </BaseButton>
        </div>
      </div>

      <!-- 总进度 -->
      <div class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div class="mb-2 flex items-center justify-between text-sm">
          <span class="font-semibold text-gray-900 dark:text-white">活动总进度</span>
          <span class="text-gray-500">{{ overallProgress }}%</span>
        </div>
        <div class="h-2.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
          <div class="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" :style="{ width: overallProgress + '%' }" />
        </div>
      </div>

      <!-- 里程碑列表 -->
      <div class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <h4 class="mb-4 font-semibold text-gray-900 dark:text-white">快乐值里程碑</h4>
        <div class="space-y-3">
          <div v-for="(tier, index) in milestones" :key="tier.id" class="rounded-lg border border-gray-100 p-4 dark:border-gray-700">
            <div class="flex items-center justify-between gap-3">
              <div class="text-sm font-semibold text-gray-900 dark:text-white">{{ tier.threshold }} 快乐值</div>
              <div :class="stateClass(tier.state)" class="text-xs font-medium">{{ stateText(tier.state) }}</div>
            </div>
            <div class="mt-2 text-xs text-gray-500">奖励：{{ rewardText(tier) }}</div>
            <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div class="h-full rounded-full bg-amber-400" :style="{ width: segmentProgress(index) + '%' }" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>