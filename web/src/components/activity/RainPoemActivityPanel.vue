<script setup lang="ts">
import type { RainPoemActivityData } from '@/stores/activity'
import { computed, onMounted, ref, watch } from 'vue'
import { useActivityStore } from '@/stores/activity'
import { useAccountStore } from '@/stores/account'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{ activity?: RainPoemActivityData | null, loading?: boolean }>()
const emit = defineEmits<{ refresh: [] }>()

const activityStore = useActivityStore()
const accountStore = useAccountStore()

const completedResearchCount = computed(() => props.activity?.research.stages.filter(stage => stage.completed).length || 0)
const totalResearchCount = computed(() => props.activity?.research.stages.length || 0)
const collectionLimit = computed(() => props.activity?.collection.dailyUseLimit || 0)
const collectionRemaining = computed(() => props.activity?.collection.remainingUseCount || 0)
const collectionUsed = computed(() => Math.max(0, collectionLimit.value - collectionRemaining.value))
const collectionProgress = computed(() => collectionLimit.value ? Math.min(100, collectionUsed.value / collectionLimit.value * 100) : 0)

const currentAccountId = computed(() => {
  const raw = (accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId
  return String(raw ?? '')
})

const selectedFriend = ref<number | null>(null)
const selectedPrankItem = ref<number>(5005)
const prankMessage = ref('')
const prankOk = ref(false)

const frogBottleCount = computed(() => Number(props.activity?.items?.frogPrankBottles || 0))
const cloudBottleCount = computed(() => Number(props.activity?.items?.cloudPrankBottles || 0))

function loadFriends() {
  const id = currentAccountId.value
  if (id) activityStore.fetchRainPoemFriends(id)
}

onMounted(loadFriends)
watch(currentAccountId, loadFriends)

async function handleUsePrank() {
  prankMessage.value = ''
  const id = currentAccountId.value
  if (!id) { prankMessage.value = '请先选择账号'; return }
  if (!selectedFriend.value) { prankMessage.value = '请选择好友'; return }
  const res = await activityStore.useRainPoemPrankOnFriend(id, selectedFriend.value, selectedPrankItem.value)
  prankOk.value = !!res?.ok
  prankMessage.value = res?.ok
    ? `已对好友投放${selectedPrankItem.value === 5005 ? '青蛙瓶' : '乌云瓶'}`
    : (res?.error || '使用失败')
  if (res?.ok) emit('refresh')
}

type ResearchStage = RainPoemActivityData['research']['stages'][number]

const badgeCount = computed(() => Number(props.activity?.items?.badges || 0))
const availableStageCount = computed(
  () => (props.activity?.research.stages || []).filter(stage => stage.available && !stage.completed).length
)
const researchMessage = ref('')
const researchOk = ref(false)

function canUnlockStage(stage: ResearchStage) {
  return badgeCount.value >= Number(stage.cost?.itemCount || 0)
}

function badgeShortage(stage: ResearchStage) {
  return Math.max(0, Number(stage.cost?.itemCount || 0) - badgeCount.value)
}

function isStageUnlocking(stage: ResearchStage) {
  return activityStore.rainPoemResearchLoading && activityStore.rainPoemResearchNodeId === stage.id
}

async function handleUnlockResearch(stage: ResearchStage) {
  researchMessage.value = ''
  const id = currentAccountId.value
  if (!id) { researchMessage.value = '请先选择账号'; researchOk.value = false; return }
  const res = await activityStore.unlockRainPoemResearch(id, stage.id)
  researchOk.value = !!res?.ok
  researchMessage.value = res?.ok
    ? `已解锁节点 ${stage.id}${stage.reward?.itemName ? `，获得 ${stage.reward.itemName} ×${stage.reward.itemCount}` : ''}`
    : (res?.error || '解锁失败')
  if (res?.ok) emit('refresh')
}

function taskProgress(task: RainPoemActivityData['tasks'][number]) {
  if (!task.target)
    return task.progress > 0 ? 100 : 0
  return Math.min(100, Math.max(0, task.progress / task.target * 100))
}

function formatDateTime(seconds?: number) {
  if (!seconds)
    return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000))
}
</script>

<template>
  <section class="space-y-4">
    <header class="storm-header relative overflow-hidden rounded-lg p-4 text-white shadow-sm sm:p-5">
      <img src="/activity/rain-poem/day-rain-bg.jpg" alt="" class="pointer-events-none absolute inset-0 h-full w-full object-cover object-center">
      <div class="rain-veil" aria-hidden="true" />
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#081824]/90 via-[#102b3c]/72 to-[#173445]/45" />
      <div class="relative flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs text-cyan-100/80">
            <span class="inline-flex items-center gap-1.5 font-medium"><span class="i-carbon-events" />限时天气活动</span>
            <span v-if="activity?.endTime" class="text-white/55">至 {{ formatDateTime(activity.endTime) }}</span>
          </div>
          <h2 class="mt-1 text-2xl font-semibold">
            {{ activity?.title || '雨落成诗' }}
          </h2>
        </div>
      </div>

      <div class="relative grid grid-cols-2 mt-4 gap-2 sm:grid-cols-4">
        <div class="status-tile col-span-2 sm:col-span-1">
          <div class="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-white/10">
            <span :class="activity?.weather?.rainstorm ? 'i-carbon-rain-heavy text-cyan-200' : 'i-carbon-cloud text-white/70'" class="text-2xl" />
          </div>
          <div class="min-w-0">
            <div class="status-label">
              当前天气
            </div>
            <div class="truncate font-semibold">
              {{ activity?.weather?.rainstorm ? '雷雨中' : '非雷雨' }}
            </div>
            <div v-if="activity?.weather?.endTime" class="truncate text-[11px] text-white/55">
              至 {{ formatDateTime(activity.weather.endTime) }}
            </div>
          </div>
        </div>
        <div class="status-tile">
          <img src="/activity/rain-poem/weather-collection-bottle.png" class="h-10 w-10 shrink-0 object-contain" alt="">
          <div>
            <div class="status-label">
              采集瓶
            </div><div class="text-lg font-semibold">
              {{ activity?.items.collectionBottles || 0 }}
            </div>
          </div>
        </div>
        <div class="status-tile">
          <img src="/activity/rain-poem/rainstorm-summon-bottle.png" class="h-10 w-10 shrink-0 object-contain" alt="">
          <div>
            <div class="status-label">
              召唤瓶
            </div><div class="text-lg font-semibold">
              {{ activity?.items.summonBottles || 0 }}
            </div>
          </div>
        </div>
        <div class="status-tile">
          <img src="/activity/rain-poem/lightning-badge.svg" class="h-10 w-10 shrink-0 object-contain" alt="">
          <div>
            <div class="status-label">
              雷电徽章
            </div><div class="text-lg font-semibold">
              {{ activity?.items.badges || 0 }}
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
      <article class="ui-card p-4 sm:p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-gray-900 font-semibold dark:text-white">
              今日雷雨采集
            </h3>
            <p class="mt-0.5 text-xs text-gray-500">
              使用采集瓶后可获得 {{ activity?.collection.reward.itemName || '雷雨召唤瓶' }}
            </p>
          </div>
          <strong class="shrink-0 text-xl text-gray-900 dark:text-white">{{ collectionRemaining }}<span class="text-sm text-gray-400 font-normal">/{{ collectionLimit }}</span></strong>
        </div>
        <div class="mt-4 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
          <div class="h-full rounded-full bg-cyan-500 transition-all" :style="{ width: `${collectionProgress}%` }" />
        </div>
        <div class="mt-2 flex justify-between text-xs text-gray-500">
          <span>已采集 {{ collectionUsed }} 次</span>
          <span>单次奖励 ×{{ activity?.collection.reward.itemCount || 0 }}</span>
        </div>
      </article>

      <article class="ui-card p-4 sm:p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-gray-900 font-semibold dark:text-white">
              每日补给
            </h3>
            <p class="mt-0.5 text-xs text-gray-500">
              天气采集瓶每日限购 {{ activity?.shop.dailyLimit || 0 }} 个
            </p>
          </div>
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium"
            :class="activity?.shop.purchasedToday ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : activity?.shop.available ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700'"
          >
            <span :class="activity?.shop.purchasedToday ? 'i-carbon-checkmark-filled' : 'i-carbon-time'" />
            {{ activity?.shop.purchasedToday ? '今日已购买' : activity?.shop.available ? '今日可购买' : '暂不可购买' }}
          </span>
        </div>
        <div class="mt-4 flex items-center justify-between border-t border-[#ECE5D6] pt-3 text-sm dark:border-[#32362B]">
          <span class="text-gray-500">持有数量</span>
          <strong class="text-gray-900 dark:text-white">{{ activity?.items.collectionBottles || 0 }}</strong>
        </div>
      </article>
    </div>

    <article class="ui-card p-4 sm:p-5">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-gray-900 font-semibold dark:text-white">
          气象任务
        </h3>
        <span class="text-xs text-gray-500">每日进度</span>
      </div>
      <div class="grid mt-3 gap-3 md:grid-cols-3">
        <div v-for="task in activity?.tasks || []" :key="task.id" class="min-h-32 border border-[#ECE5D6] rounded-lg p-4 dark:border-[#32362B]">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 text-gray-900 font-medium dark:text-white">
              {{ task.desc }}
            </div>
            <span v-if="taskProgress(task) >= 100" class="i-carbon-checkmark-filled shrink-0 text-lg text-emerald-500" aria-label="已完成" />
          </div>
          <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div class="h-full rounded-full transition-all" :class="taskProgress(task) >= 100 ? 'bg-emerald-500' : 'bg-cyan-500'" :style="{ width: `${taskProgress(task)}%` }" />
          </div>
          <div class="mt-2 flex items-center justify-between gap-2 text-xs">
            <span class="text-gray-500">{{ task.progress }}<template v-if="task.target">/{{ task.target }}</template></span>
            <span class="truncate text-amber-600 dark:text-amber-400">{{ task.reward.itemName }} ×{{ task.reward.itemCount }}</span>
          </div>
        </div>
        <div v-if="!activity?.tasks?.length" class="border border-[#ECE5D6] rounded-lg border-dashed p-6 text-center text-sm text-gray-500 dark:border-[#32362B]">
          暂无任务状态
        </div>
      </div>
    </article>

    <article class="ui-card p-4 sm:p-5">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 class="text-gray-900 font-semibold dark:text-white">
            气象研究
          </h3>
          <p class="mt-0.5 text-xs text-gray-500">
            研究节点为分支结构，同一层可解锁节点可自行选择顺序，解锁后获得对应奖励
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-md bg-gray-100 px-2.5 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">{{ completedResearchCount }}/{{ totalResearchCount }} 已解锁</span>
          <span class="rounded-md bg-amber-100 px-2.5 py-1 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">雷电徽章 {{ badgeCount }}</span>
          <span v-if="availableStageCount" class="rounded-md bg-cyan-100 px-2.5 py-1 text-xs text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">{{ availableStageCount }} 个节点待解锁</span>
        </div>
      </div>
      <p v-if="researchMessage" class="mt-3 rounded-md px-3 py-2 text-xs" :class="researchOk ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400'">
        {{ researchMessage }}
      </p>
      <div class="grid mt-5 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="(stage, index) in activity?.research.stages || []"
          :key="stage.id"
          class="research-stage relative border rounded-lg p-3.5"
          :class="stage.completed ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20' : stage.available ? 'border-cyan-400 bg-cyan-50 ring-2 ring-cyan-100 dark:border-cyan-600 dark:bg-cyan-950/20 dark:ring-cyan-950' : 'border-[#ECE5D6] bg-[#F7F2E7] dark:border-[#32362B] dark:bg-[#262B20]'"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium" :class="stage.completed ? 'text-emerald-700 dark:text-emerald-300' : stage.available ? 'text-cyan-700 dark:text-cyan-300' : 'text-gray-400'">阶段 {{ index + 1 }}</span>
            <span :class="stage.completed ? 'i-carbon-checkmark-filled text-emerald-500' : stage.available ? 'i-carbon-unlocked text-cyan-600' : 'i-carbon-locked text-gray-400'" />
          </div>
          <div class="mt-3 flex items-center gap-2.5">
            <div class="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-[#FCFBF6] shadow-sm dark:bg-[#262B20]">
              <img v-if="stage.reward.image" :src="stage.reward.image" class="h-9 w-9 object-contain" alt="">
              <span v-else class="i-carbon-gift text-xl text-gray-400" />
            </div>
            <div class="min-w-0">
              <div class="truncate text-sm text-gray-900 font-medium dark:text-white">
                {{ stage.reward.itemName }}
              </div>
              <div class="text-xs text-gray-500">
                奖励 ×{{ stage.reward.itemCount }}
              </div>
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between border-t border-[#ECE5D6]/60 pt-2.5 text-xs dark:border-white/10">
            <span class="text-gray-500">消耗 {{ stage.cost.itemName }} ×{{ stage.cost.itemCount }}</span>
            <span class="font-medium" :class="stage.completed ? 'text-emerald-600' : stage.available ? 'text-cyan-600' : 'text-gray-400'">{{ stage.completed ? '已解锁' : stage.available ? '当前可解锁' : '需解锁前置节点' }}</span>
          </div>
          <div v-if="stage.available && !stage.completed" class="mt-2.5">
            <BaseButton
              size="sm"
              class="w-full"
              :disabled="!canUnlockStage(stage) || isStageUnlocking(stage)"
              @click="handleUnlockResearch(stage)"
            >
              <span v-if="isStageUnlocking(stage)">解锁中…</span>
              <span v-else-if="!canUnlockStage(stage)">徽章不足（还差 {{ badgeShortage(stage) }}）</span>
              <span v-else>解锁此节点</span>
            </BaseButton>
          </div>
        </div>
        <div v-if="!activity?.research.stages?.length" class="border border-[#ECE5D6] rounded-lg border-dashed p-6 text-center text-sm text-gray-500 dark:border-[#32362B]">
          暂无研究状态
        </div>
        </div>
        </article>

        <article class="ui-card p-4 sm:p-5">
        <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 class="text-gray-900 font-semibold dark:text-white">
            对好友使用使坏瓶
          </h3>
          <p class="mt-0.5 text-xs text-gray-500">
            选择好友与瓶类型后投放（青蛙瓶落到好友默认地块，乌云瓶落到好友空地）
          </p>
        </div>
        <span class="rounded-md bg-gray-100 px-2.5 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          青蛙 {{ frogBottleCount }} · 乌云 {{ cloudBottleCount }}
        </span>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <label class="block text-xs text-gray-500">
          选择好友
          <select
            v-model.number="selectedFriend"
            class="mt-1.5 w-full rounded-md border border-[#ECE5D6] bg-[#FCFBF6] px-3 py-2 text-sm text-gray-900 dark:border-[#32362B] dark:bg-[#1E211A] dark:text-white"
          >
            <option :value="null" disabled>请选择好友</option>
            <option
              v-for="f in activityStore.rainPoemFriends"
              :key="f.gid"
              :value="f.gid"
            >
              {{ f.remark || f.name || f.gid }}<template v-if="f.level">（Lv.{{ f.level }}）</template>
            </option>
          </select>
        </label>

        <div class="block text-xs text-gray-500">
          瓶类型
          <div class="mt-1.5 flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition"
              :class="selectedPrankItem === 5005 ? 'bg-[var(--theme-gradient)] text-white shadow-sm' : 'bg-[#F0ECDD] text-[#2C2A22] dark:bg-[#2A2E22] dark:text-[#ECE9DE]'"
              :disabled="frogBottleCount <= 0"
              @click="selectedPrankItem = 5005"
            >
              青蛙瓶 ×{{ frogBottleCount }}
            </button>
            <button
              type="button"
              class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition"
              :class="selectedPrankItem === 5006 ? 'bg-[var(--theme-gradient)] text-white shadow-sm' : 'bg-[#F0ECDD] text-[#2C2A22] dark:bg-[#2A2E22] dark:text-[#ECE9DE]'"
              :disabled="cloudBottleCount <= 0"
              @click="selectedPrankItem = 5006"
            >
              乌云瓶 ×{{ cloudBottleCount }}
            </button>
          </div>
        </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-3">
        <BaseButton
          variant="primary"
          :loading="activityStore.rainPoemPrankLoading"
          :disabled="!selectedFriend || activityStore.rainPoemPrankLoading"
          @click="handleUsePrank"
        >
          投放使坏瓶
        </BaseButton>
        <span v-if="prankMessage" class="text-xs" :class="prankOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'">
          {{ prankMessage }}
        </span>
        </div>
        </article>
        </section>
</template>

<style scoped>
.storm-header {
  background-color: #173445;
}

/* 雨丝氛围：在天气图之上叠加缓落的细雨，呼应「雨落成诗」主题 */
.rain-veil {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 0.55;
  background-image:
    repeating-linear-gradient(102deg, transparent 0 14px, rgba(255, 255, 255, 0.16) 14px 15px),
    repeating-linear-gradient(102deg, transparent 0 22px, rgba(255, 255, 255, 0.10) 22px 23px);
  background-size: 200% 200%, 200% 200%;
  animation: rainfall 0.9s linear infinite;
}
.rain-veil::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(102deg, transparent 0 30px, rgba(255, 255, 255, 0.08) 30px 31px);
  animation: rainfall 1.5s linear infinite;
}
@keyframes rainfall {
  from { background-position: 0 0; }
  to { background-position: -40px 120px; }
}
@media (prefers-reduced-motion: reduce) {
  .rain-veil,
  .rain-veil::after { animation: none; }
}

.status-tile {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.625rem;
  min-height: 3.75rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.08);
  padding: 0.5rem 0.625rem;
}

.status-label {
  color: rgba(207, 250, 254, 0.7);
  font-size: 0.6875rem;
  line-height: 1rem;
}

@media (min-width: 1280px) {
  .research-stage:not(:last-child)::after {
    position: absolute;
    top: 50%;
    right: -0.8125rem;
    z-index: 2;
    width: 0.625rem;
    height: 2px;
    background: #cbd5e1;
    content: '';
  }
}
</style>
