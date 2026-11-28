<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, useId, watch } from 'vue'
import { moveSlidingTabFocus, useSlidingTabs, vFoldMotion, vSlidingTabs } from '@/composables/useContentMotion'
import CollectionCard from '@/components/collection/CollectionCard.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import type { CollectionItem } from '@/stores/collection'
import { useCollectionStore } from '@/stores/collection'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const collectionStore = useCollectionStore()
const toast = useToastStore()

const { currentAccountId } = storeToRefs(accountStore)
const { categories, userLevel, loading, error, upgrading, claiming } = storeToRefs(collectionStore)

/** 藏品解锁等级（公告 26110102：等级 125 级解锁） */
const UNLOCK_LEVEL = 125

// 等级优先随藏品接口返回；兼容旧后端时 store 显式读取同账号的状态快照。
// 未同步/读取失败以 null 表示，不能显示 Lv.0 或错误的“还差 125 级”。
const levelKnown = computed(() => userLevel.value !== null)
const levelEnough = computed(() => userLevel.value !== null && userLevel.value >= UNLOCK_LEVEL)
const levelGap = computed(() => userLevel.value === null ? null : Math.max(0, UNLOCK_LEVEL - userLevel.value))

type FilterKey = 'all' | 'owned' | 'missing'

const filter = ref<FilterKey>('all')
const rarityFilter = ref<number>(0)

const filterTabs: Array<{ value: FilterKey, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'owned', label: '已获得' },
  { value: 'missing', label: '未获得' },
]

/** 当前分类（目前服务端只返回 category=1，保留多分类扩展） */
const activeCategory = computed(() => categories.value[0] || null)
const allItems = computed<CollectionItem[]>(() => activeCategory.value?.collections || [])

const currentScore = computed(() => Number(activeCategory.value?.currentScore || 0))
const claimedScore = computed(() => Number(activeCategory.value?.claimedRewardScore || 0))
const canClaim = computed(() => currentScore.value > claimedScore.value)

const ownedCount = computed(() => allItems.value.filter(i => i.owned).length)
const totalCount = computed(() => allItems.value.length)

/** 稀有度分布，用于筛选条 */
const rarityOptions = computed(() => {
  const set = new Map<number, number>()
  for (const it of allItems.value) {
    const r = Number(it.rarity) || 0
    if (!r)
      continue
    set.set(r, (set.get(r) || 0) + 1)
  }
  return Array.from(set.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rarity, count]) => ({ rarity, count, label: rarityLabel(rarity) }))
})

function rarityLabel(r: number) {
  return ({ 1: '普通', 2: '精良', 3: '稀有', 4: '史诗' } as Record<number, string>)[r] || `R${r}`
}

const filteredItems = computed(() => {
  let list = allItems.value
  if (filter.value === 'owned')
    list = list.filter(i => i.owned)
  else if (filter.value === 'missing')
    list = list.filter(i => !i.owned)
  if (rarityFilter.value)
    list = list.filter(i => Number(i.rarity) === rarityFilter.value)
  return list
})

// ------- 确认弹窗 -------
const showConfirm = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmLoading = ref(false)
const pendingAction = ref<null | (() => Promise<void>)>(null)

function openConfirm(title: string, message: string, action: () => Promise<void>) {
  if (!levelKnown.value) {
    toast.error('角色等级尚未同步，请刷新后再操作')
    return
  }
  if (!levelEnough.value) {
    toast.error(`藏品需 ${UNLOCK_LEVEL} 级解锁，当前 ${userLevel.value} 级，还差 ${levelGap.value} 级`)
    return
  }
  confirmTitle.value = title
  confirmMessage.value = message
  pendingAction.value = action
  showConfirm.value = true
}

async function runConfirmedAction() {
  if (!pendingAction.value)
    return
  confirmLoading.value = true
  try {
    await pendingAction.value()
    showConfirm.value = false
  }
  finally {
    confirmLoading.value = false
    pendingAction.value = null
  }
}

function closeConfirm() {
  if (confirmLoading.value)
    return
  showConfirm.value = false
  pendingAction.value = null
}

// ------- 操作 -------
async function refresh(force = true) {
  if (!currentAccountId.value)
    return
  await collectionStore.fetchCollections(currentAccountId.value)
  if (force && !error.value)
    toast.success('已刷新藏品数据')
}

function confirmUpgrade(item: CollectionItem) {
  const cat = activeCategory.value?.category || 1
  const accountId = String(currentAccountId.value)
  const costs = item.nextStarCosts || []
  const star = item.starLevel
  openConfirm(
    star > 0 ? '升星藏品' : '激活藏品',
    `「${item.name}」${star} 星 → ${Math.min(5, star + 1)} 星\n消耗：${costs.map(cost => `${cost.name} ×${Number(cost.count).toLocaleString()}`).join('、')}\n提交前重新核对材料，结果未知不重放。`,
    async () => {
      if (accountId !== String(currentAccountId.value)) return
      const r = await collectionStore.upgrade(accountId, cat, item.collectionId, {
        expectedStarLevel: star, expectedCosts: costs.map(cost => ({ itemId: cost.itemId, count: cost.count })),
      })
      if (r.stale || accountId !== String(currentAccountId.value)) return
      if (r.ok)
        toast.success(`${item.name} ${star > 0 ? '升星' : '激活'}成功`)
      else
        toast.error(r.error || '升星失败')
    },
  )
}

function confirmDisplay(item: CollectionItem) {
  const accountId = String(currentAccountId.value)
  const current = collectionStore.displaySlots.find(slot => slot.slotType === 1)?.itemId || 0
  openConfirm(item.displayed ? '取消展示' : '展示藏品', `确定${item.displayed ? '取消展示' : '展示'}「${item.name}」吗？场景只能展示一款藏品，切换会替换原藏品。`, async () => {
    if (accountId !== String(currentAccountId.value)) return
    const r = await collectionStore.setDisplay(accountId, { collectionId: item.collectionId, displayed: !item.displayed, expectedDisplayItemId: current })
    if (r.stale || accountId !== String(currentAccountId.value)) return
    if (r.ok) toast.success('展示状态已确认')
    else toast.error(r.error || '展示结果未确认')
  })
}

function confirmClaim() {
  const cat = activeCategory.value?.category || 1
  const accountId = String(currentAccountId.value)
  openConfirm(
    '领取评分奖励',
    `当前评分 ${currentScore.value}，已领 ${claimedScore.value}。\n确定领取所有达标奖励吗？`,
    async () => {
      if (accountId !== String(currentAccountId.value)) return
      const r = await collectionStore.claimReward(accountId, cat)
      if (r.stale || accountId !== String(currentAccountId.value)) return
      if (r.ok) {
        const n = (r.data as any)?.totalRewards?.length || 0
        toast.success(n ? `领取成功，获得 ${n} 项奖励` : '领取成功')
      }
      else {
        toast.error(r.error || '领取失败')
      }
    },
  )
}

const collectionContent = ref<HTMLElement | null>(null)
const collectionPanelId = useId()
const { select: selectCollectionFilter, selected: selectedCollectionFilter } = useSlidingTabs(filter, () => collectionContent.value, () => filterTabs.map(item => item.value), () => currentAccountId.value)

watch(currentAccountId, (v) => {
  showConfirm.value = false
  pendingAction.value = null
  collectionStore.clear()
  if (v)
    collectionStore.fetchCollections(v)
})

onMounted(() => {
  if (currentAccountId.value)
    collectionStore.fetchCollections(currentAccountId.value)
})
</script>

<template>
  <section class="space-y-4">
    <div class="rounded-lg bg-white p-4 shadow-sm dark:bg-gray-800">
      <!-- 头部 -->
      <div class="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div class="min-w-0 flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <div class="i-carbon-cube text-2xl text-violet-500" />
            <h1 class="text-xl font-bold">
              藏品
            </h1>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="h-8 flex items-center rounded-lg bg-violet-50 px-3 text-xs text-violet-700 dark:bg-violet-900/20 dark:text-violet-300">
              {{ ownedCount }}/{{ totalCount }} 已获得
            </span>
            <span class="h-8 flex items-center rounded-lg bg-blue-50 px-3 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
              评分 {{ currentScore }}
            </span>
            <span
              v-if="canClaim"
              class="h-8 flex items-center rounded-lg bg-amber-50 px-3 text-xs text-amber-700 font-semibold dark:bg-amber-900/20 dark:text-amber-300"
            >
              有奖励可领
            </span>
            <span class="h-8 flex items-center rounded-lg bg-gray-50 px-3 text-xs text-gray-600 dark:bg-gray-900/40 dark:text-gray-300">
              {{ levelKnown ? `Lv.${userLevel}` : '等级待同步' }}
            </span>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <div v-sliding-tabs class="ui-tabs !gap-1 !rounded-lg !p-1" role="tablist" aria-label="藏品获得筛选">
            <button
              v-for="t in filterTabs"
              :id="`${collectionPanelId}-${t.value}`"
              :key="t.value"
              type="button"
              class="ui-tab min-w-16 !min-h-8 !px-3 !py-1 !text-sm"
              role="tab"
              :data-active="selectedCollectionFilter === t.value"
              :aria-selected="selectedCollectionFilter === t.value"
              :aria-controls="`${collectionPanelId}-content`"
              :tabindex="selectedCollectionFilter === t.value ? 0 : -1"
              @click="selectCollectionFilter(t.value)"
              @keydown="moveSlidingTabFocus"
            >
              <span class="ui-tab-label">{{ t.label }}</span>
            </button>
          </div>
          <BaseButton
            v-if="canClaim"
            class="w-28"
            variant="primary"
            :loading="claiming"
            @click="confirmClaim"
          >
            领取奖励
          </BaseButton>
          <BaseButton class="w-20" variant="primary" :loading="loading" @click="refresh(true)">
            刷新
          </BaseButton>
        </div>
      </div>

      <div :id="`${collectionPanelId}-content`" ref="collectionContent" class="tab-motion-viewport" role="tabpanel" :aria-labelledby="`${collectionPanelId}-${filter}`" :aria-busy="loading">
        <div data-motion-entry>
      <!-- 稀有度筛选 -->
      <div v-if="rarityOptions.length > 1" class="mb-3 flex flex-wrap items-center gap-2">
        <button
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="rarityFilter === 0
            ? 'bg-[var(--action-bg)] text-[var(--action-text)]'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'"
          type="button"
          @click="rarityFilter = 0"
        >
          全部稀有度 {{ totalCount }}
        </button>
        <button
          v-for="r in rarityOptions"
          :key="r.rarity"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="rarityFilter === r.rarity
            ? 'bg-[var(--action-bg)] text-[var(--action-text)]'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300'"
          type="button"
          @click="rarityFilter = rarityFilter === r.rarity ? 0 : r.rarity"
        >
          {{ r.label }} {{ r.count }}
        </button>
      </div>

      <div v-if="activeCategory?.currentBuffs?.length" class="mb-4 flex flex-wrap gap-2 text-xs">
        <span v-for="buff in activeCategory.currentBuffs" :key="buff.name" class="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200">{{ buff.description }}</span>
      </div>
      <details v-if="activeCategory?.seriesRules?.length" v-fold-motion class="mb-4 rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900/30">
        <summary class="cursor-pointer font-medium">系列概率、保底与评分奖励</summary>
        <div v-for="series in activeCategory.seriesRules" :key="series.seriesId" class="mt-3"><b>{{ series.name }}</b> · {{ series.description }}
          <p v-for="group in series.groups" :key="group.name" class="mt-1 text-gray-500">{{ group.name }}：{{ group.probability }}%，保底 {{ group.guarantee }} 次（独立档位）</p>
        </div>
        <div v-for="step in activeCategory.milestones || []" :key="step.score" class="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">{{ step.score }} 分 · {{ step.claimed ? '已领' : step.reached ? '可领' : '未达成' }} · {{ step.buffs.map((buff: any) => buff.description).join('、') }}</div>
      </details>
      <!-- 提示与错误 -->
      <div v-if="error" class="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
        {{ error }}
      </div>

      <div
        v-if="levelKnown && !levelEnough && currentAccountId"
        class="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
      >
        藏品系统需 <b>Lv.{{ UNLOCK_LEVEL }}</b> 解锁，当前 Lv.{{ userLevel }}，还差 <b>{{ levelGap }}</b> 级。
        解锁后可通过特惠商城的【金豆豆藏品礼包】【钻石藏品礼包】获取，或在蓝晶土地种植时触发藏品变异。
      </div>

      <div
        v-else-if="currentAccountId && !levelKnown && !loading"
        class="mb-4 rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:bg-gray-900/40 dark:text-gray-300"
      >
        角色等级尚未同步，请确认账号在线后刷新。藏品需 Lv.{{ UNLOCK_LEVEL }} 解锁，当前等级暂不可确认。
      </div>

      <!-- 状态分支 -->
      <div v-if="!currentAccountId" class="rounded-lg bg-gray-50 p-8 text-center text-sm text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
        请先选择账号，再查看藏品。
      </div>

      <div
        v-else-if="loading && allItems.length === 0"
        class="rounded-lg bg-gray-50 p-8 text-center text-sm text-gray-500 dark:bg-gray-900/40 dark:text-gray-400"
      >
        正在加载藏品数据…
      </div>

      <div v-else class="space-y-4">
        <div
          v-if="filteredItems.length === 0"
          class="border border-gray-200 rounded-lg border-dashed bg-white px-6 py-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
        >
          {{ allItems.length === 0 ? '暂无可展示的藏品（可能尚未解锁该系统）' : '当前筛选下没有藏品' }}
        </div>

        <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          <CollectionCard
            v-for="item in filteredItems"
            :key="item.collectionId"
            :item="item"
            :upgrading="upgrading"
            @upgrade="confirmUpgrade"
            @display="confirmDisplay"
          />
        </div>
      </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="showConfirm"
      :title="confirmTitle"
      :message="confirmMessage"
      :loading="confirmLoading"
      @confirm="runConfirmedAction"
      @close="closeConfirm"
      @cancel="closeConfirm"
    />
  </section>
</template>