<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useFriendStore } from '@/stores/friend'

interface StrategyTimingSettings {
  plantOrderRandom: boolean
  plantDelaySeconds: number
  stealDelaySeconds: number
  intervals: {
    farmMin: number
    farmMax: number
    helpMin: number
    helpMax: number
    stealMin: number
    stealMax: number
  }
  friendQuietHours: {
    enabled: boolean
    start: string
    end: string
    exemptGids: number[]
  }
}

const props = withDefaults(defineProps<{
  currentAccountId?: string | number | null
}>(), {})

const settings = defineModel<StrategyTimingSettings>('settings', { required: true })

const friendStore = useFriendStore()
const friendSearch = ref('')
const exemptPickerVisible = ref(false)

const filteredFriends = computed(() => {
  const q = friendSearch.value.trim().toLowerCase()
  const list = (friendStore.friends as any[]) || []
  if (!q) return list
  return list.filter((f) => {
    const name = String(f?.name || '').toLowerCase()
    const gid = String(f?.gid ?? '')
    return name.includes(q) || gid.includes(q)
  })
})

function friendName(gid: number) {
  const f = (friendStore.friends as any[]).find((x) => Number(x?.gid) === Number(gid))
  return f ? `${f.name} (${f.gid})` : String(gid)
}

// 选中的好友豁免（不含系统 NPC 小果 10001，它始终豁免）
const selectedExemptGids = computed<number[]>({
  get: () => (settings.value.friendQuietHours.exemptGids || []).filter((g: number) => g !== 10001),
  set: (gids: number[]) => {
    // 始终保留系统 NPC 小果 10001 的豁免
    settings.value.friendQuietHours.exemptGids = [10001, ...gids]
  },
})

function isExemptSelected(gid: number) {
  return selectedExemptGids.value.includes(gid)
}

function toggleExemptFriend(gid: number) {
  const arr = selectedExemptGids.value
  const next = arr.includes(gid) ? arr.filter((g) => g !== gid) : [...arr, gid]
  selectedExemptGids.value = next
}

function ensureFriends() {
  const id = props.currentAccountId
  if (id && (friendStore.friends as any[]).length === 0)
    friendStore.fetchFriends(String(id))
}

onMounted(ensureFriends)
watch(() => props.currentAccountId, ensureFriends)
</script>

<template>
  <div class="space-y-3">
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <BaseInput
        v-model.number="settings.intervals.farmMin"
        label="农场巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="settings.intervals.farmMax"
        label="农场巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="settings.intervals.helpMin"
        label="帮助巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="settings.intervals.helpMax"
        label="帮助巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="grid grid-cols-2 gap-3 md:grid-cols-2">
      <BaseInput
        v-model.number="settings.intervals.stealMin"
        label="偷菜巡查最小 (秒)"
        type="number"
        min="1"
      />
      <BaseInput
        v-model.number="settings.intervals.stealMax"
        label="偷菜巡查最大 (秒)"
        type="number"
        min="1"
      />
    </div>

    <div class="flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
      <BaseSwitch
        v-model="settings.friendQuietHours.enabled"
        label="启用静默时段"
      />
      <div class="flex items-center gap-2">
        <input
          v-model="settings.friendQuietHours.start"
          type="time"
          class="w-20 border border-[#ECE5D6] rounded-lg bg-[#FCFBF6] px-2 py-1 text-xs dark:border-[#32362B] dark:bg-[#1E211A] dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
        <span class="text-xs text-gray-500">-</span>
        <input
          v-model="settings.friendQuietHours.end"
          type="time"
          class="w-20 border border-[#ECE5D6] rounded-lg bg-[#FCFBF6] px-2 py-1 text-xs dark:border-[#32362B] dark:bg-[#1E211A] dark:text-white"
          :disabled="!settings.friendQuietHours.enabled"
        >
      </div>
    </div>

    <div v-if="settings.friendQuietHours.enabled" class="space-y-2 rounded-2xl border border-[#ECE5D6] bg-[#F7F2E7]/70 p-3 dark:border-[#32362B] dark:bg-[#262B20]/70">
      <div class="flex items-center justify-between gap-2">
        <span class="text-sm font-medium text-gray-900 dark:text-gray-100">静默时段豁免好友</span>
        <button
          type="button"
          class="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-teal-700"
          @click="exemptPickerVisible = true"
        >
          选择好友
        </button>
      </div>
      <div v-if="selectedExemptGids.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="gid in selectedExemptGids"
          :key="gid"
          class="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-teal-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-teal-900"
        >
          {{ friendName(gid) }}
          <button type="button" class="text-teal-500 transition-colors hover:text-teal-700" @click="toggleExemptFriend(gid)">×</button>
        </span>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">
        系统 NPC 小果 (10001) 默认豁免，无需选择；勾选的好友在静默时段内仍会被操作。
      </p>
    </div>

    <div class="border-t pt-3 space-y-3 dark:border-gray-700">
      <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
        种植与偷菜延迟设置
      </h4>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <BaseSwitch
          v-model="settings.plantOrderRandom"
          label="种植顺序随机"
        />
        <BaseInput
          v-model.number="settings.plantDelaySeconds"
          label="种植延迟 (秒)"
          type="number"
          min="0"
        />
        <BaseInput
          v-model.number="settings.stealDelaySeconds"
          label="偷菜延迟 (秒)"
          type="number"
          min="0"
        />
      </div>
    </div>

    <!-- 静默时段豁免好友选择弹窗 -->
    <Transition name="fade">
      <div
        v-if="exemptPickerVisible"
        class="fixed inset-0 z-50 grid place-items-center bg-gray-950/45 p-4 backdrop-blur-[2px]"
        @click.self="exemptPickerVisible = false"
      >
        <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">选择豁免好友</h3>
            <button
              type="button"
              aria-label="关闭"
              class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              @click="exemptPickerVisible = false"
            >
              <span class="i-carbon-close text-xl" />
            </button>
          </div>
          <div class="border-b border-gray-100 px-6 py-3 dark:border-gray-700">
            <input
              v-model="friendSearch"
              type="text"
              placeholder="搜索昵称或 GID"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
          </div>
          <div class="flex-1 space-y-1 overflow-auto px-6 py-3">
            <label
              v-for="f in filteredFriends"
              :key="f.gid"
              class="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              <span class="flex min-w-0 items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <span class="truncate">{{ f.name }}</span>
                <span class="shrink-0 text-xs text-gray-400">{{ f.gid }}<span v-if="f.level"> · Lv.{{ f.level }}</span></span>
              </span>
              <input
                type="checkbox"
                class="h-4 w-4"
                :checked="isExemptSelected(Number(f.gid))"
                @change="toggleExemptFriend(Number(f.gid))"
              >
            </label>
            <p v-if="!filteredFriends.length" class="py-6 text-center text-sm text-gray-400">暂无可选择的好友</p>
          </div>
          <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
            <BaseButton class="min-w-24" size="sm" @click="exemptPickerVisible = false">完成</BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
