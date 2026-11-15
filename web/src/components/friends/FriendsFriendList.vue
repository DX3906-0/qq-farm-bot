<script setup lang="ts">
import LandCard from '@/components/LandCard.vue'

type FriendActionType = 'steal' | 'farming' | 'bad'

const props = defineProps<{
  friends: any[]
  totalFriends: number
  totalPages: number
  pageSize: number
  blacklistGidSet: Set<number>
  knownFriendGidSet: Set<number>
  expandedFriends: Set<string>
  friendLands: Record<string, any[]>
  friendLandsLoading: Record<string, boolean>
  friendLandsError?: Record<string, string>
  isQqAccount: boolean
  canShowFriendAvatar: (friend: any) => boolean
  getFriendAvatar: (friend: any) => string
  getFriendLevel: (friend: any) => number
  getFriendGold: (friend: any) => number
  formatFriendGold: (value: unknown) => string
  getFriendStatusText: (friend: any) => string
  getFriendStatusHint: (friend: any) => string
  stealPlans: Record<string, any>
  operationLocked?: boolean
  operationTarget?: string
}>()

const emit = defineEmits<{
  (e: 'toggleFriend', friendId: string): void
  (e: 'operate', friendId: string, type: FriendActionType, event: Event): void
  (e: 'scheduleSteal', friend: any, event: Event): void
  (e: 'toggleBlacklist', friend: any, event: Event): void
  (e: 'removeKnownFriendGid', friend: any, event: Event): void
  (e: 'friendAvatarError', friend: any): void
}>()

const currentPage = defineModel<number>('currentPage', { required: true })

function goToPage(page: number) {
  currentPage.value = Math.max(1, Math.min(page, props.totalPages))
}
</script>

<template>
  <div
    v-for="friend in friends"
    :key="friend.gid"
    class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800"
  >
    <div
      class="friend-row flex flex-col cursor-pointer justify-between gap-4 p-4 transition sm:flex-row sm:items-center hover:bg-gray-50 dark:hover:bg-gray-700/50"
      :class="blacklistGidSet.has(Number(friend.gid)) ? 'opacity-50' : ''"
      @click="emit('toggleFriend', friend.gid)"
    >
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
          <img
            v-if="canShowFriendAvatar(friend)"
            :src="getFriendAvatar(friend)"
            class="h-full w-full object-cover"
            loading="lazy"
            @error="emit('friendAvatarError', friend)"
          >
          <div v-else class="i-carbon-user text-gray-400" />
        </div>
        <div>
          <div class="flex items-center gap-2 font-bold">
            {{ friend.name }} ({{ friend.gid }})
            <span v-if="operationTarget === String(friend.gid)" class="text-xs font-normal" role="status">处理中</span>

            <span v-if="blacklistGidSet.has(Number(friend.gid))" class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">已屏蔽</span>
            <span v-if="Number(friend?.dogId) === 90021" class="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400">护主犬</span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span
              v-if="getFriendLevel(friend) > 0"
              class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
            >
              Lv.{{ getFriendLevel(friend) }}
            </span>
            <span
              v-if="getFriendGold(friend) > 0"
              class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
            >
              金币 {{ formatFriendGold(friend.gold) }}
            </span>
            <span
              v-if="friend.dogName"
              class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
            >
              {{ friend.dogName }}
            </span>
          </div>
          <div class="text-sm" :class="getFriendStatusText(friend) !== '无操作' ? 'text-green-500 font-medium' : 'text-gray-400'">
            {{ getFriendStatusText(friend) }}
          </div>
          <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ getFriendStatusHint(friend) }}
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          class="rounded bg-blue-100 px-3 py-2 text-sm text-blue-700 transition hover:bg-blue-200"
          :disabled="operationLocked"
          @click="emit('operate', friend.gid, 'steal', $event)"
        >
          偷取
        </button>
        <button
          class="rounded px-3 py-2 text-sm transition"
          :class="props.stealPlans[friend.gid]
            ? 'bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300'
            : 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300'"
          :disabled="operationLocked"
          @click="emit('scheduleSteal', friend, $event)"
        >
          {{ props.stealPlans[friend.gid] ? (props.stealPlans[friend.gid].recurring ? '永久偷取✓' : '预约偷取✓') : '预约偷取' }}
        </button>
        <button
          class="rounded bg-emerald-100 px-3 py-2 text-sm text-emerald-700 transition hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
          title="一键务农：浇水、除草、除虫一次完成（与游戏内一键务农同源）"
          :disabled="operationLocked"
          @click="emit('operate', friend.gid, 'farming', $event)"
        >
          一键务农
        </button>
        <button
          class="rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition hover:bg-red-200"
          :disabled="operationLocked"
          @click="emit('operate', friend.gid, 'bad', $event)"
        >
          捣乱
        </button>
        <button
          class="rounded px-3 py-2 text-sm transition"
          :class="blacklistGidSet.has(Number(friend.gid))
            ? 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-400 dark:hover:bg-gray-700'"
          @click="emit('toggleBlacklist', friend, $event)"
        >
          {{ blacklistGidSet.has(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
        </button>
        <button
          v-if="isQqAccount && knownFriendGidSet.has(Number(friend.gid))"
          class="rounded bg-amber-100 px-3 py-2 text-sm text-amber-700 transition dark:bg-amber-900/30 hover:bg-amber-200 dark:text-amber-400 dark:hover:bg-amber-900/50"
          @click="emit('removeKnownFriendGid', friend, $event)"
        >
          移出同步列表
        </button>
      </div>
    </div>

    <div v-if="expandedFriends.has(String(friend.gid))" class="border-t bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
      <div v-if="friendLandsLoading[friend.gid]" class="flex justify-center py-4">
        <div class="i-svg-spinners-90-ring-with-bg text-2xl text-blue-500" />
      </div>
      <template v-else>
        <div v-if="friendLandsError?.[friend.gid]" class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300" role="alert">
          读取好友土地失败：{{ friendLandsError[friend.gid] }}
          <span v-if="friendLands[friend.gid]?.length" class="ml-1">以下保留上次成功读取的数据。</span>
        </div>
        <div v-if="!friendLandsError?.[friend.gid] && !friendLands[friend.gid]" class="py-4 text-center text-gray-500">
          尚未读取该好友的土地数据，请确认账号在线后展开查看。
        </div>
        <div v-else-if="!friendLandsError?.[friend.gid] && friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
          本次访问成功，但该好友没有返回可展示的土地。
        </div>
        <div v-if="friendLands[friend.gid]?.length" class="grid grid-cols-2 gap-2 lg:grid-cols-8 md:grid-cols-5 sm:grid-cols-4">
          <LandCard
            v-for="land in friendLands[friend.gid]"
            :key="land.id"
            :land="land"
            :show-actions="false"
          />
        </div>
      </template>
    </div>
  </div>

  <div v-if="totalFriends > pageSize" class="mt-4 flex flex-wrap items-center justify-center gap-2">
    <button
      class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
      :disabled="currentPage === 1"
      @click="goToPage(1)"
    >
      首页
    </button>
    <button
      class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
      :disabled="currentPage === 1"
      @click="goToPage(currentPage - 1)"
    >
      上一页
    </button>
    <div class="flex items-center gap-1">
      <template v-for="p in totalPages" :key="p">
        <button
          v-if="p === 1 || p === totalPages || (p >= currentPage - 1 && p <= currentPage + 1)"
          class="h-8 w-8 rounded text-sm transition"
          :class="p === currentPage
            ? 'text-white'
            : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
          :style="p === currentPage ? { backgroundColor: 'var(--theme-primary)' } : {}"
          @click="goToPage(p)"
        >
          {{ p }}
        </button>
        <span
          v-else-if="p === currentPage - 2 || p === currentPage + 2"
          class="px-1 text-gray-400"
        >...</span>
      </template>
    </div>
    <button
      class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
      :disabled="currentPage === totalPages"
      @click="goToPage(currentPage + 1)"
    >
      下一页
    </button>
    <button
      class="border border-gray-200 rounded bg-white px-3 py-1.5 text-sm text-gray-600 transition dark:border-gray-600 dark:bg-gray-800 hover:bg-gray-50 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
      :disabled="currentPage === totalPages"
      @click="goToPage(totalPages)"
    >
      末页
    </button>
    <span class="text-sm text-gray-500 dark:text-gray-400">
      共 {{ totalFriends }} 位好友
    </span>
  </div>
</template>

<style scoped>
.friend-row button { transition: background-color 150ms ease, transform 90ms ease; }
.friend-row button:not(:disabled):active { transform: scale(.97); filter: brightness(.96); }
.friend-row button:disabled { cursor: not-allowed; opacity: .55; }
@media (max-width: 640px), (pointer: coarse) { .friend-row button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .friend-row, .friend-row button { transition: none; } .friend-row button:active { transform: none; } }
</style>
