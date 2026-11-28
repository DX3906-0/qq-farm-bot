<script setup lang="ts">
import { computed } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import type { WishSignActivityData, WishSignRewardItem } from '@/stores/activity'

const props = defineProps<{
  activity?: WishSignActivityData | null
  loading?: boolean
  operateLoading?: boolean
}>()
// 主操作：draw（祈愿抽签）或 claim（领取已抽签文）；refresh 表示成功后重新拉取
const emit = defineEmits<{ draw: [], claim: [], refresh: [] }>()

const activityEnded = computed(() => {
  const a = props.activity
  if (!a) return false
  if (a.active === false) return true
  if (a.endTime > 0 && a.endTime * 1000 < Date.now()) return true
  return false
})
const dayProgress = computed(() => `第 ${Math.min(props.activity?.activityDay || 0, 14)} / 14 天`)
const hasPending = computed(() => !!props.activity?.pending)
const canDraw = computed(() => (props.activity?.remainingCount || 0) > 0)
const pendingRewardText = computed(() => {
  const r = props.activity?.pending?.rewards
  if (!r?.length) return ''
  return r.map(x => `${x.itemName || (x.itemId ? `物品#${x.itemId}` : '奖励')}${Number(x.itemCount ?? x.count ?? 0) > 1 ? ` ×${Number(x.itemCount ?? x.count ?? 0)}` : ''}`).join('、')
})

function timeText(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
}
function rewardImage(item?: WishSignRewardItem): string {
  if (item?.image) return item.image
  const id = Number(item?.itemId)
  return id ? `/game-config/seed_images_named/${id}.png` : ''
}
function rewardName(item?: WishSignRewardItem): string {
  return item?.itemName || (item?.itemId ? `物品#${item.itemId}` : '活动奖励')
}
function rewardCount(item?: WishSignRewardItem): string {
  const n = Number(item?.itemCount ?? item?.count ?? 0)
  return n > 1 ? ` ×${n}` : ''
}
function mainActionText() {
  if (hasPending.value) return '领取签文奖励'
  return canDraw.value ? '开始祈愿' : '今日祈愿次数已用完'
}
function mainDisabled() {
  if (activityEnded.value || props.operateLoading) return true
  if (hasPending.value) return false
  return !canDraw.value
}
function onMainAction() {
  if (hasPending.value) emit('claim')
  else if (canDraw.value) emit('draw')
}
</script>

<template>
  <div class="space-y-4">
    <template v-if="activityEnded">
      <div class="rounded-xl bg-white p-5 text-center shadow-sm dark:bg-gray-800">
        <p class="text-sm font-semibold text-gray-900 dark:text-white">秋祈良愿活动已结束</p>
        <p class="mt-1 text-xs text-gray-500">已结束的活动不可再祈愿或领取。</p>
      </div>
    </template>
    <template v-else>
      <!-- 头部信息条 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div>
          <h3 class="font-semibold text-gray-900 dark:text-white">秋祈良愿 · 中秋祈愿</h3>
          <p class="mt-1 text-xs text-gray-500">{{ timeText(activity?.startTime) }} — {{ timeText(activity?.endTime) }} · {{ dayProgress }}</p>
        </div>
        <div class="text-right">
          <div class="text-lg font-bold text-amber-600 dark:text-amber-300">{{ activity?.remainingCount || 0 }}</div>
          <div class="text-xs text-gray-500">剩余祈愿次数</div>
        </div>
      </div>

      <!-- 祈愿 / 领取主操作 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white">{{ hasPending ? '有已抽签文待领取' : '祈愿抽签' }}</h4>
          <p class="mt-1 text-xs text-gray-500">
            {{ hasPending
              ? `已抽到签文奖励，点击领取。${pendingRewardText}`
              : (activity?.remainingCount || 0) > 0
                ? '每次祈愿消耗一次次数，抽取一份签文奖励。'
                : '今日祈愿次数已用完，明天再来。' }}
          </p>
        </div>
        <BaseButton :loading="operateLoading" :disabled="mainDisabled()" @click="onMainAction()">
          {{ mainActionText() }}
        </BaseButton>
      </div>

      <!-- 已抽签文奖励预览 -->
      <div v-if="hasPending && activity?.pending?.rewards?.length"
        class="rounded-xl bg-amber-50 p-5 shadow-sm dark:bg-amber-900/10">
        <h4 class="mb-3 text-sm font-semibold text-amber-700 dark:text-amber-300">本次签文奖励</h4>
        <div class="flex flex-wrap gap-3">
          <div v-for="(item, idx) in activity.pending.rewards" :key="idx"
            class="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-sm dark:bg-gray-800">
            <img v-if="rewardImage(item)" :src="rewardImage(item)" alt="" class="h-8 w-8 object-contain">
            <div>
              <div class="text-gray-900 dark:text-white">{{ rewardName(item) }}{{ rewardCount(item) }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>