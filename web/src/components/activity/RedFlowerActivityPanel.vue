<script setup lang="ts">
import type { RedFlowerActivityData } from '@/stores/activity'
import { computed, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity?: RedFlowerActivityData | null
  loading?: boolean
  loveLoading?: boolean
  fundLoading?: boolean
  shareLoading?: boolean
  tiersLoading?: boolean
}>()

const emit = defineEmits<{
  donateLove: []
  donateFund: []
  claimShare: []
  claimTiers: []
}>()

const ITEM_NAMES: Record<number, string> = {
  1002: '点券',
  2158: '做好事头像框',
  20883: '小红花',
  80001: '化肥(1小时)',
  80013: '有机化肥(8小时)',
  101604: '全服公益礼包',
}

function itemLabel(item?: { id: number, count: number } | null) {
  if (!item?.id) return ''
  const name = ITEM_NAMES[item.id] || `道具#${item.id}`
  return item.count > 1 ? `${name}×${item.count}` : name
}

const loveValue = computed(() => Number(props.activity?.progress?.loveValue || 0))
const tiers = computed(() => (props.activity?.progress?.tiers || []).map(t => ({
  threshold: Number(t.tier) || 0,
  claimed: !!t.claimed,
  reached: !!t.reached,
  reward: itemLabel(t.reward),
})))
const maxLove = computed(() => tiers.value.reduce((max, t) => (t.threshold > max ? t.threshold : max), 0) || 150)
const lovePercent = computed(() => Math.min(100, Math.round((loveValue.value / maxLove.value) * 100)))
const serverProgress = computed(() => Number(props.activity?.progress?.serverProgress || 0))
const serverGoal = computed(() => Number(props.activity?.progress?.serverGoal || 0))
const serverPercent = computed(() => {
  const raw = Number(props.activity?.progress?.serverPercent)
  if (Number.isFinite(raw) && raw > 0) return Math.min(100, raw)
  return serverGoal.value > 0 ? Math.min(100, (serverProgress.value / serverGoal.value) * 100) : 0
})
const dailyGift = computed(() => itemLabel(props.activity?.progress?.dailyGift))
const serverGift = computed(() => itemLabel(props.activity?.progress?.serverGift))
const holdingItem = computed(() => itemLabel(props.activity?.progress?.holdingItem))

function formatNumber(value: number) {
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value)
}
const showProgress = computed(() => !!props.activity?.progress)
const fundConfirm = ref(false)

function onDonateFund() {
  if (!fundConfirm.value) {
    fundConfirm.value = true
    return
  }
  fundConfirm.value = false
  emit('donateFund')
}
</script>

<template>
  <section class="overflow-hidden rounded-lg bg-white shadow-sm dark:bg-gray-800">
    <div class="from-rose-500 to-red-500 bg-gradient-to-r px-5 py-4 text-white">
      <div class="flex items-center gap-3">
        <div class="i-carbon-favorite text-3xl" />
        <div>
          <h2 class="text-lg font-bold">
            {{ activity?.title || '公益小红花' }}
          </h2>
          <p class="mt-0.5 text-sm text-white/85">
            累计爱心值解锁档位好礼，全服爱心助力公益目标
          </p>
        </div>
      </div>
    </div>

    <div class="p-5">
      <div v-if="activity?.warning" class="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
        {{ activity.warning }}
      </div>

      <div v-if="showProgress" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg bg-rose-50 px-4 py-3 dark:bg-rose-900/20">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              我的累计爱心值
            </div>
            <div class="mt-1 text-2xl font-bold text-rose-600 dark:text-rose-300">
              {{ loveValue }}
            </div>
          </div>
          <div class="rounded-lg bg-red-50 px-4 py-3 dark:bg-red-900/20">
            <div class="text-xs text-gray-500 dark:text-gray-400">
              全服公益进度
            </div>
            <div class="mt-1 text-2xl font-bold text-red-600 dark:text-red-300">
              {{ serverPercent.toFixed(2) }}%
            </div>
            <div v-if="serverGoal" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {{ formatNumber(serverProgress) }} / {{ formatNumber(serverGoal) }}
            </div>
          </div>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>爱心值档位进度</span><span>{{ loveValue }} / {{ maxLove }}</span>
          </div>
          <div class="h-2.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-gradient-to-r from-rose-400 to-red-500"
              :style="{ width: lovePercent + '%' }"
            />
          </div>
        </div>

        <div class="grid grid-cols-5 gap-2">
          <div
            v-for="t in tiers"
            :key="t.threshold"
            class="rounded-lg border px-2 py-2 text-center text-xs"
            :class="t.claimed || t.reached
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200'
              : 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500'"
          >
            <div class="font-bold">
              {{ t.threshold }}
            </div>
            <div v-if="t.reward" class="mt-0.5 text-[10px] leading-tight">
              {{ t.reward }}
            </div>
            <div class="mt-0.5">
              {{ t.claimed ? '已领' : (t.reached ? '已达档位' : '未达成') }}
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span v-if="holdingItem">持有：{{ holdingItem }}</span>
          <span v-if="dailyGift">每日公益礼包：{{ dailyGift }}</span>
          <span v-if="serverGift">全服达标礼包：{{ serverGift }}</span>
        </div>
        <p class="text-xs text-gray-400 dark:text-gray-500">
          档位奖励由 Bot 自动领取：爱心值达标后即显示绿色「已达档位」，无需手动点击。
          重复点击「领档位奖励」会返回已领取，不会重复发放；未达标档位显示「未达成」。
        </p>
      </div>

      <div class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <BaseButton
          variant="primary"
          :loading="loveLoading"
          :disabled="loveLoading || !activity?.available"
          @click="emit('donateLove')"
        >
          送爱心值
        </BaseButton>
        <BaseButton
          variant="primary"
          :loading="shareLoading"
          :disabled="shareLoading || !activity?.available"
          @click="emit('claimShare')"
        >
          领分享奖励
        </BaseButton>
        <BaseButton
          variant="primary"
          :loading="tiersLoading"
          :disabled="tiersLoading || !activity?.available"
          @click="emit('claimTiers')"
        >
          领档位奖励
        </BaseButton>
        <BaseButton
          :variant="fundConfirm ? 'danger' : 'secondary'"
          :loading="fundLoading"
          :disabled="fundLoading || !activity?.available || activity?.fundDonated"
          @click="onDonateFund"
        >
          {{
            activity?.fundDonated
              ? '本号已捐公益金'
              : fundConfirm
                ? '确认捐赠（真实扣款1元）'
                : '送公益金（真实扣款）'
          }}
        </BaseButton>
      </div>
      <p v-if="fundConfirm" class="mt-2 text-xs text-red-500">
        ⚠️ 送公益金为真实 1 元微信扣款，单账号活动期仅 1 次，点击「确认捐赠」即发起支付。请谨慎操作！
      </p>
    </div>
  </section>
</template>
