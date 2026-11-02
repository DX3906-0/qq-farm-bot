<script setup lang="ts">
import type {
  MilkTeaActivityData,
  MilkTeaFundTier,
  MilkTeaGoodsItem,
  MilkTeaHireFriend,
  MilkTeaLevelConfig,
  MilkTeaRecipe,
  MilkTeaShopSlot,
} from '@/stores/activity'
import { computed, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'

const props = defineProps<{
  activity?: MilkTeaActivityData | null
  page?: string
  loading?: boolean
  operateLoading?: boolean
}>()

const emit = defineEmits<{
  navigate: [page: string]
  operate: [action: string, input?: Record<string, unknown>]
}>()

// 面板内二级页签（对应后端 page 参数）
const TABS: Array<{ key: string, label: string, icon: string }> = [
  { key: 'shop', label: '奶茶店', icon: 'i-carbon-store' },
  { key: 'workshop', label: '制作台', icon: 'i-carbon-tool-kit' },
  { key: 'hireList', label: '雇佣', icon: 'i-carbon-user-multiple' },
  { key: 'upgrade', label: '升级', icon: 'i-carbon-arrow-up' },
  { key: 'work', label: '打工', icon: 'i-carbon-briefcase' },
  { key: 'exchange', label: '兑换商店', icon: 'i-carbon-shopping-cart' },
  { key: 'fund', label: '成长基金', icon: 'i-carbon-growth' },
  { key: 'rank', label: '排行榜', icon: 'i-carbon-trophy' },
  { key: 'logs', label: '销售日志', icon: 'i-carbon-document' },
]

const currentTab = ref(props.page && TABS.some(t => t.key === props.page) ? props.page : 'shop')
watch(() => props.page, (p) => {
  if (p && TABS.some(t => t.key === p)) currentTab.value = p
})

const activity = computed(() => props.activity || null)
const summary = computed(() => activity.value?.summary || null)
const opened = computed(() => Number(summary.value?.shopOpenAt || 0) > 0)
const active = computed(() => !!activity.value?.active)
const settling = computed(() => !!activity.value?.settling)
const activityEnded = computed(() => {
  const a = activity.value
  if (!a) return false
  if (a.active === false) return true
  return a.endTime > 0 && a.endTime * 1000 < Date.now()
})

function switchTab(key: string) {
  if (key === currentTab.value) return
  currentTab.value = key
  emit('navigate', key)
}

function fmtTime(value?: number) {
  if (!value) return '—'
  return new Date(value * 1000).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
function fmtNum(value?: number) {
  return Number(value || 0).toLocaleString('zh-CN')
}
function fmtDuration(sec?: number) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  if (!s) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分`
}
function itemImage(item?: { image?: string, itemId?: number }) {
  if (item?.image) return item.image
  const id = Number(item?.itemId)
  return id ? `/game-config/seed_images_named/${id}.png` : ''
}
function itemName(item?: { itemName?: string, itemId?: number }) {
  return item?.itemName || (item?.itemId ? `物品#${item.itemId}` : '奖励')
}
function itemText(item?: { itemName?: string, itemId?: number, itemCount?: number, count?: number }) {
  if (!item) return ''
  const n = Number(item.itemCount ?? item.count ?? 0)
  return n > 1 ? `${itemName(item)} ×${n}` : itemName(item)
}

// —— 开店 / 改名 ——
const shopNameInput = ref('')
const renaming = ref(false)
const nameRule = computed(() => {
  const names = activity.value?.recommendedNames || []
  return names
})
watch(activity, (a) => {
  if (a && !shopNameInput.value)
    shopNameInput.value = a.summary?.shopName || a.recommendedNames?.[0] || ''
}, { immediate: true })

function doCreate() {
  const name = shopNameInput.value.trim()
  if (!name) return
  emit('operate', 'create', { name })
}
function doRename() {
  const name = shopNameInput.value.trim()
  if (!name) return
  renaming.value = false
  emit('operate', 'rename', { name })
}

// —— 升级 ——
const currentLevelConfig = computed<MilkTeaLevelConfig | null>(() => {
  const lv = Number(activity.value?.shop?.level || summary.value?.level || 0)
  return (activity.value?.levels || []).find(l => l.level === lv) || null
})
const nextLevelConfig = computed<MilkTeaLevelConfig | null>(() => {
  const lv = Number(activity.value?.shop?.level || summary.value?.level || 0)
  return (activity.value?.levels || []).find(l => l.level === lv + 1) || null
})
const levelProgress = computed(() => {
  const shop = activity.value?.shop
  if (!shop) return 0
  const next = Number(shop.nextLevelRevenue || 0)
  if (!next) return 100
  return Math.min(100, Math.round((Number(shop.totalRevenue || 0) / next) * 100))
})

// —— 员工位 ——
const slots = computed<MilkTeaShopSlot[]>(() => activity.value?.shop?.slots || [])
const slotCount = computed(() => currentLevelConfig.value?.employeeSlotCount || 0)
const slotRows = computed(() => {
  const nowSec = Math.floor(Date.now() / 1000)
  const rows: Array<{ index: number, slot: MilkTeaShopSlot | null, expired: boolean }> = []
  const max = Math.max(slotCount.value, slots.value.length, 1)
  for (let i = 0; i < max; i++) {
    const slot = slots.value.find(s => s.slotIndex === i) || null
    rows.push({ index: i, slot, expired: !!slot && slot.endAt > 0 && slot.endAt <= nowSec })
  }
  return rows
})

// —— 制作台 ——
const recipes = computed<MilkTeaRecipe[]>(() => activity.value?.recipes || [])
const cupMap = computed(() => activity.value?.shop?.drinkCups || {})
function stockOf(recipeId: number) {
  return Number(cupMap.value[String(recipeId)] || 0)
}

// —— 雇佣 ——
const durationId = ref(1)
watch(activity, (a) => {
  if (a?.hire?.durationId) durationId.value = a.hire.durationId
})
function switchDuration(id: number) {
  if (id === durationId.value) return
  durationId.value = id
  emit('navigate', 'hireList')
  emit('operate', '__fetchHire', { durationId: id })
}
const hireFriends = computed<MilkTeaHireFriend[]>(() => [
  ...(activity.value?.hire?.friends || []),
  ...(activity.value?.hire?.robots || []),
])
function hireStateLabel(item: MilkTeaHireFriend) {
  const nowSec = Math.floor(Date.now() / 1000)
  if (item.rehireAvailableAt > nowSec) return `冷却至 ${fmtTime(item.rehireAvailableAt)}`
  if (item.state === 0) return '可雇佣'
  if (item.state === 1) return '已雇佣'
  return `状态 ${item.state}`
}
function canHire(item: MilkTeaHireFriend) {
  const nowSec = Math.floor(Date.now() / 1000)
  return item.state === 0 && item.rehireAvailableAt <= nowSec
}
function doHire(item: MilkTeaHireFriend) {
  const gid = Number(item.friend?.gid || 0)
  if (!gid) return
  emit('operate', 'hire', { targetGid: gid })
}

// —— 打工 ——
const work = computed(() => activity.value?.work || null)
const claimableSlips = computed(() => (work.value?.slips || []).filter(s => s.wageStatus === 1))

// —— 兑换商店 ——
const goods = computed<MilkTeaGoodsItem[]>(() => activity.value?.goods || [])
// 兑换货币余额（1041=奶茶券、1001=金币），让面板直接告诉用户「我有多少」
const balances = computed(() => activity.value?.balances || null)
// 该商品为何不可兑换（置灰原因），available 为 true 时无原因
function goodsBlockReason(g: MilkTeaGoodsItem): string {
  if (g.available) return ''
  const reasons: string[] = []
  if (settling.value) reasons.push('结算期不可兑换')
  if (g.unlocked === false) reasons.push('未解锁')
  if (g.unlocked !== false && Number(g.remaining ?? 0) <= 0) reasons.push('限购已买满')
  if (g.affordable === false) reasons.push('余额不足')
  if (reasons.length === 0) reasons.push('暂不可兑换')
  return reasons.join('、')
}
const goodsCount = ref<Record<string, number>>({})
function goodsCountOf(id: string) {
  return goodsCount.value[id] ?? 1
}
function setGoodsCount(id: string, value: number) {
  goodsCount.value = { ...goodsCount.value, [id]: Math.max(1, Math.min(999, Number(value) || 1)) }
}
function doExchange(item: MilkTeaGoodsItem) {
  emit('operate', 'exchange', { goodsId: Number(item.id), count: goodsCountOf(item.id) })
}

// —— 成长基金 ——
const fund = computed(() => activity.value?.fund || null)
const fundCostText = computed(() => (fund.value?.costs || []).map(itemText).filter(Boolean).join('、'))
function fundStateLabel(tier: MilkTeaFundTier) {
  if (!fund.value?.unlocked) return '未解锁'
  if (tier.state === 2) return '可领取'
  if (tier.state === 1) return '进行中'
  return '已领取'
}
function fundStateClass(tier: MilkTeaFundTier) {
  if (!fund.value?.unlocked) return 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500'
  if (tier.state === 2) return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200'
  if (tier.state === 1) return 'border-sky-200 bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-200'
  return 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400'
}

// —— 升级预览（下一档解锁的配方）——
const newRecipes = computed(() => {
  const cur = new Set(currentLevelConfig.value?.recipes || [])
  return (nextLevelConfig.value?.recipes || []).filter(r => !cur.has(r))
})
</script>

<template>
  <div class="space-y-4">
    <template v-if="activityEnded && !opened">
      <div class="rounded-xl bg-white p-5 text-center shadow-sm dark:bg-gray-800">
        <p class="text-sm font-semibold text-gray-900 dark:text-white">奶茶热销中活动已结束</p>
        <p class="mt-1 text-xs text-gray-500">已结束的活动不可再经营店铺。</p>
      </div>
    </template>

    <template v-else>
      <!-- 头部：店铺概览 -->
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <div class="min-w-0">
          <h3 class="flex items-center gap-2 font-semibold text-gray-900 dark:text-white">
            <span class="i-carbon-cafe text-amber-500" />
            {{ activity?.title || '奶茶热销中' }}
            <span v-if="opened" class="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              Lv.{{ summary?.level || 0 }} {{ summary?.shopName }}
            </span>
          </h3>
          <p class="mt-1 text-xs text-gray-500">
            {{ fmtTime(activity?.startTime) }} — {{ fmtTime(activity?.endTime) }}
            <span v-if="settling" class="ml-2 text-orange-500">结算期</span>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-4 text-right">
          <div>
            <div class="text-lg font-bold text-amber-600 dark:text-amber-300">{{ fmtNum(summary?.totalRevenue) }}</div>
            <div class="text-xs text-gray-500">累计营业额</div>
          </div>
          <div v-if="balances" class="flex items-center gap-4">
            <div>
              <div class="text-lg font-bold text-orange-600 dark:text-orange-300">{{ fmtNum(balances.milkTeaToken) }}</div>
              <div class="text-xs text-gray-500">奶茶券 (1041)</div>
            </div>
            <div>
              <div class="text-lg font-bold text-yellow-600 dark:text-yellow-300">{{ fmtNum(balances.goldCoin) }}</div>
              <div class="text-xs text-gray-500">金币 (1001)</div>
            </div>
          </div>
          <div v-if="summary?.hasUnclaimedWage">
            <div class="text-lg font-bold text-emerald-600 dark:text-emerald-300">待领</div>
            <div class="text-xs text-gray-500">打工工资</div>
          </div>
        </div>
      </div>

      <!-- 未开业：开店引导 -->
      <div v-if="!opened" class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
        <h4 class="font-semibold text-gray-900 dark:text-white">开启你的奶茶店</h4>
        <p class="mt-1 text-xs text-gray-500">开业可获得礼包奖励，店铺名可在开业后 24 小时内修改一次。</p>
        <div v-if="summary?.openingGiftPreview?.length" class="mt-3 flex flex-wrap gap-3">
          <div
            v-for="(item, idx) in summary.openingGiftPreview"
            :key="idx"
            class="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-900/10"
          >
            <img v-if="itemImage(item)" :src="itemImage(item)" alt="" class="h-7 w-7 object-contain">
            <span class="text-gray-800 dark:text-gray-100">{{ itemText(item) }}</span>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <input
            v-model="shopNameInput"
            maxlength="12"
            placeholder="输入店铺名称"
            class="w-52 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          >
          <BaseButton variant="primary" :loading="operateLoading" :disabled="operateLoading || !active" @click="doCreate">
            立即开业
          </BaseButton>
        </div>
        <div v-if="nameRule.length" class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
          <span>推荐店名：</span>
          <button
            v-for="n in nameRule"
            :key="n"
            class="rounded-md border border-gray-200 px-2 py-0.5 transition hover:border-amber-400 hover:text-amber-600 dark:border-gray-700"
            @click="shopNameInput = n"
          >
            {{ n }}
          </button>
        </div>
      </div>

      <template v-else>
        <!-- 店铺快捷操作 -->
        <div class="flex flex-wrap items-center gap-2 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <BaseButton
            variant="primary"
            :loading="operateLoading"
            :disabled="operateLoading || !active || settling || summary?.cashierFull"
            @click="emit('operate', 'claim')"
          >
            领取收益
          </BaseButton>
          <BaseButton
            variant="secondary"
            :loading="operateLoading"
            :disabled="operateLoading || !active || settling || !summary?.canUpgrade"
            @click="emit('operate', 'upgrade')"
          >
            升级店铺
          </BaseButton>
          <BaseButton
            variant="secondary"
            :loading="operateLoading"
            :disabled="operateLoading || !active || settling"
            @click="emit('operate', 'boost', { count: 1 })"
          >
            加速营业
          </BaseButton>
          <BaseButton
            variant="secondary"
            :loading="operateLoading"
            :disabled="operateLoading || !active"
            @click="emit('operate', 'hireSetting', { disabled: !summary?.hireDisabled })"
          >
            {{ summary?.hireDisabled ? '开启被雇佣' : '关闭被雇佣' }}
          </BaseButton>
          <BaseButton
            variant="secondary"
            :disabled="operateLoading || !active"
            @click="renaming = !renaming"
          >
            修改店名
          </BaseButton>
          <div v-if="renaming" class="flex items-center gap-2">
            <input
              v-model="shopNameInput"
              maxlength="12"
              class="w-44 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            >
            <BaseButton variant="primary" :loading="operateLoading" :disabled="operateLoading" @click="doRename">
              确认改名
            </BaseButton>
          </div>
          <span v-if="summary?.hireDisabled" class="text-xs text-gray-400">已关闭被雇佣，好友无法雇佣你</span>
        </div>

        <!-- 面板内页签 -->
        <div class="inline-flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-white p-1.5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <button
            v-for="tab in TABS"
            :key="tab.key"
            class="rounded-lg px-3 py-1 text-sm whitespace-nowrap transition"
            :class="currentTab === tab.key
              ? 'text-white font-medium'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'"
            :style="currentTab === tab.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
            @click="switchTab(tab.key)"
          >
            <span :class="tab.icon" class="mr-1" />{{ tab.label }}
          </button>
        </div>

        <!-- 店铺 -->
        <div v-if="currentTab === 'shop'" class="space-y-4">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg bg-amber-50 px-4 py-3 dark:bg-amber-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">当前等级</div>
              <div class="mt-1 text-2xl font-bold text-amber-600 dark:text-amber-300">Lv.{{ activity?.shop?.level || summary?.level || 0 }}</div>
            </div>
            <div class="rounded-lg bg-orange-50 px-4 py-3 dark:bg-orange-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">累计营业额</div>
              <div class="mt-1 text-2xl font-bold text-orange-600 dark:text-orange-300">{{ fmtNum(activity?.shop?.totalRevenue) }}</div>
            </div>
            <div class="rounded-lg bg-sky-50 px-4 py-3 dark:bg-sky-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">每小时杯数</div>
              <div class="mt-1 text-2xl font-bold text-sky-600 dark:text-sky-300">{{ activity?.shop?.effectiveCupsPerHour || 0 }}</div>
            </div>
            <div class="rounded-lg bg-emerald-50 px-4 py-3 dark:bg-emerald-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">收银台进度</div>
              <div class="mt-1 text-2xl font-bold text-emerald-600 dark:text-emerald-300">{{ activity?.shop?.cashierElapsedSec || 0 }}s</div>
              <div class="mt-0.5 text-xs text-gray-500">/ {{ activity?.shop?.cashierCapacitySec || 0 }}s</div>
            </div>
          </div>

          <div>
            <div class="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>距离下一级营业额</span>
              <span>{{ fmtNum(activity?.shop?.totalRevenue) }} / {{ fmtNum(activity?.shop?.nextLevelRevenue) }}</span>
            </div>
            <div class="h-2.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div class="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" :style="{ width: levelProgress + '%' }" />
            </div>
          </div>

          <div v-if="activity?.shop?.pendingRewards?.length" class="rounded-lg bg-emerald-50 p-4 dark:bg-emerald-900/10">
            <h4 class="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-200">待领取收益</h4>
            <div class="flex flex-wrap gap-2">
              <div v-for="(item, idx) in activity.shop.pendingRewards" :key="idx" class="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm dark:bg-gray-800">
                <img v-if="itemImage(item)" :src="itemImage(item)" alt="" class="h-6 w-6 object-contain">
                <span class="text-gray-800 dark:text-gray-100">{{ itemText(item) }}</span>
              </div>
            </div>
          </div>

          <div>
            <h4 class="mb-2 text-sm font-semibold text-gray-900 dark:text-white">员工位（{{ slotCount }} 个）</h4>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div
                v-for="row in slotRows"
                :key="row.index"
                class="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                :class="row.slot && !row.expired
                  ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/10'
                  : 'border-dashed border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800'"
              >
                <div class="min-w-0">
                  <div class="font-medium text-gray-800 dark:text-gray-100">
                    {{ row.slot?.employee?.name || (row.slot?.isRobot ? '机器人' : '空闲') }}
                  </div>
                  <div class="mt-0.5 text-xs text-gray-500">
                    <template v-if="row.slot">
                      {{ row.slot.talentName || '无天赋' }} · {{ row.expired ? '已结束' : `至 ${fmtTime(row.slot.endAt)}` }}
                    </template>
                    <template v-else>可雇佣员工</template>
                  </div>
                </div>
                <span class="shrink-0 text-xs" :class="row.slot && !row.expired ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400'">
                  位 {{ row.index + 1 }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 制作台 -->
        <div v-else-if="currentTab === 'workshop'" class="space-y-3">
          <p class="text-xs text-gray-500">
            用活动果实制作奶茶补充库存。库存杯数会在营业中被自动消耗，缺货会拖慢收银速度。
          </p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="r in recipes"
              :key="r.recipeId"
              class="rounded-lg border px-3 py-3"
              :class="r.unlocked
                ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
                : 'border-dashed border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60'"
            >
              <div class="flex items-center justify-between">
                <div class="font-medium text-gray-900 dark:text-white">
                  {{ r.recipeName }}
                  <span v-if="r.isAdvanced" class="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-700 dark:bg-purple-900/30 dark:text-purple-200">进阶</span>
                </div>
                <span class="text-sm font-bold" :class="stockOf(r.recipeId) > 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400'">
                  {{ stockOf(r.recipeId) }} 杯
                </span>
              </div>
              <div class="mt-1 text-xs text-gray-500">
                {{ r.description || '—' }}
              </div>
              <div class="mt-1 text-xs text-gray-400">
                <template v-if="!r.unlocked">未解锁</template>
                <template v-else>
                  补货 {{ fmtNum(r.tokenPrice) }} 券 / {{ fmtNum(r.coinPrice) }} 金币
                </template>
              </div>
            </div>
          </div>
          <p v-if="!recipes.length" class="text-xs text-gray-400">暂未读取到配方数据。</p>
        </div>

        <!-- 雇佣 -->
        <div v-else-if="currentTab === 'hireList'" class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="d in [1, 2, 3]"
              :key="d"
              class="rounded-lg border px-3 py-1 text-sm transition"
              :class="durationId === d
                ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
                : 'border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300'"
              @click="switchDuration(d)"
            >
              {{ d }} 档时长
            </button>
            <span class="text-xs text-gray-500">
              工资合计 {{ fmtNum(activity?.hire?.wageTotal) }} · 最短营业剩余 {{ fmtDuration(activity?.hire?.minRemainBizSec) }}
            </span>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="(f, idx) in hireFriends"
              :key="f.friend?.gid ?? idx"
              class="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
            >
              <div class="min-w-0">
                <div class="truncate font-medium text-gray-900 dark:text-white">
                  {{ f.friend?.name || (f.isRobot ? '机器人' : '未知') }}
                  <span v-if="f.isRobot" class="ml-1 rounded bg-sky-100 px-1 text-[10px] text-sky-700 dark:bg-sky-900/30 dark:text-sky-200">机器人</span>
                </div>
                <div class="mt-0.5 text-xs text-gray-500">
                  {{ f.talentName || '无天赋' }} · Lv.{{ f.friend?.level || 0 }}
                </div>
                <div class="mt-0.5 text-xs" :class="canHire(f) ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400'">
                  {{ hireStateLabel(f) }}
                </div>
              </div>
              <BaseButton
                variant="primary"
                :loading="operateLoading"
                :disabled="operateLoading || !canHire(f) || settling"
                @click="doHire(f)"
              >
                雇佣
              </BaseButton>
            </div>
          </div>
          <p v-if="!hireFriends.length" class="text-xs text-gray-400">暂未读取到可雇佣好友。</p>
        </div>

        <!-- 升级 -->
        <div v-else-if="currentTab === 'upgrade'" class="space-y-3">
          <div class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 class="font-semibold text-gray-900 dark:text-white">
                  Lv.{{ currentLevelConfig?.level || 0 }} → Lv.{{ nextLevelConfig?.level || '满级' }}
                </h4>
                <p class="mt-1 text-xs text-gray-500">
                  <template v-if="nextLevelConfig">
                    升级需营业额 {{ fmtNum(nextLevelConfig.revenueRequired) }}，当前 {{ fmtNum(activity?.shop?.totalRevenue) }}
                  </template>
                  <template v-else>已达最高等级。</template>
                </p>
              </div>
              <BaseButton
                variant="primary"
                :loading="operateLoading"
                :disabled="operateLoading || !summary?.canUpgrade || settling"
                @click="emit('operate', 'upgrade')"
              >
                升级店铺
              </BaseButton>
            </div>
            <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>当前人气 {{ currentLevelConfig?.basePopularity || 0 }}</span>
              <span>下一级人气 {{ nextLevelConfig?.basePopularity || '—' }}</span>
              <span>下一级员工位 {{ nextLevelConfig?.employeeSlotCount ?? '—' }}</span>
            </div>
            <div v-if="newRecipes.length" class="mt-3">
              <div class="text-xs text-gray-500">下一级解锁配方</div>
              <div class="mt-1 flex flex-wrap gap-1.5">
                <span v-for="r in newRecipes" :key="r" class="rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-200">{{ r }}</span>
              </div>
            </div>
          </div>

          <div class="overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900/40">
                <tr>
                  <th class="px-3 py-2 text-left">等级</th>
                  <th class="px-3 py-2 text-right">所需营业额</th>
                  <th class="px-3 py-2 text-right">人气</th>
                  <th class="px-3 py-2 text-right">员工位</th>
                  <th class="px-3 py-2 text-left">配方</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="l in activity?.levels || []"
                  :key="l.level"
                  class="border-t border-gray-100 dark:border-gray-700"
                  :class="l.level === (activity?.shop?.level || summary?.level) ? 'bg-amber-50 dark:bg-amber-900/10' : ''"
                >
                  <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">Lv.{{ l.level }}</td>
                  <td class="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{{ fmtNum(l.revenueRequired) }}</td>
                  <td class="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{{ l.basePopularity }}</td>
                  <td class="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{{ l.employeeSlotCount }}</td>
                  <td class="px-3 py-2 text-xs text-gray-500">{{ l.recipes.join('、') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 打工 -->
        <div v-else-if="currentTab === 'work'" class="space-y-3">
          <div v-if="work?.myShift" class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
            <h4 class="font-semibold text-gray-900 dark:text-white">我的班次</h4>
            <p class="mt-1 text-xs text-gray-500">
              在「{{ work.myShift.shopName }}」为 {{ work.myShift.employer?.name || '店主' }} 打工 ·
              {{ fmtTime(work.myShift.beginAt) }} — {{ fmtTime(work.myShift.endAt) }}
            </p>
            <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>天赋 {{ work.myShift.talentName || '无' }}</span>
              <span>互动 {{ work.myShift.interactCount }} / {{ work.myShift.interactLimit }}</span>
              <span>预计工资 {{ fmtNum(work.myShift.wageTotal) }}</span>
            </div>
            <div class="mt-3">
              <BaseButton
                variant="primary"
                :loading="operateLoading"
                :disabled="operateLoading || work.interactDone || settling"
                @click="emit('operate', 'interact', { interactionType: 1 })"
              >
                {{ work.interactDone ? '今日已互动' : '与店主互动' }}
              </BaseButton>
            </div>
          </div>
          <div v-else class="rounded-xl bg-white p-5 text-sm text-gray-500 shadow-sm dark:bg-gray-800">
            当前没有进行中的打工班次。
          </div>

          <div class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 class="font-semibold text-gray-900 dark:text-white">工资单</h4>
                <p class="mt-1 text-xs text-gray-500">共 {{ (work?.slips || []).length }} 条，{{ claimableSlips.length }} 条可领取。</p>
              </div>
              <BaseButton
                variant="primary"
                :loading="operateLoading"
                :disabled="operateLoading || !claimableSlips.length"
                @click="emit('operate', 'wages')"
              >
                领取工资
              </BaseButton>
            </div>
            <div v-if="work?.slips?.length" class="mt-3 space-y-1.5">
              <div
                v-for="(s, idx) in work.slips"
                :key="idx"
                class="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 text-xs dark:border-gray-700"
              >
                <span class="text-gray-600 dark:text-gray-300">
                  {{ s.shopName }} · {{ fmtTime(s.beginAt) }} — {{ fmtTime(s.endAt) }} · {{ fmtDuration(s.workSec) }}
                </span>
                <span :class="s.wageStatus === 1 ? 'text-emerald-600 dark:text-emerald-300' : 'text-gray-400'">
                  {{ fmtNum(s.finalWage) }} 券 {{ s.wageStatus === 1 ? '（可领）' : '（已领）' }}
                </span>
              </div>
            </div>
            <p v-else class="mt-3 text-xs text-gray-400">暂无工资单。</p>
          </div>
        </div>

        <!-- 兑换商店 -->
        <div v-else-if="currentTab === 'exchange'" class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/40">
            <span class="text-gray-500">共 {{ goods.length }} 件商品，可用金币或奶茶券兑换。</span>
            <span v-if="balances" class="text-gray-600 dark:text-gray-300">
              奶茶券 <b class="text-orange-600 dark:text-orange-300">{{ fmtNum(balances.milkTeaToken) }}</b>
              · 金币 <b class="text-yellow-600 dark:text-yellow-300">{{ fmtNum(balances.goldCoin) }}</b>
            </span>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="g in goods"
              :key="g.id"
              class="flex flex-col justify-between rounded-lg border px-3 py-3"
              :class="g.available
                ? 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
                : 'border-dashed border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60'"
            >
              <div>
                <div class="flex items-center gap-2">
                  <img v-if="itemImage(g.rewards?.[0])" :src="itemImage(g.rewards?.[0])" alt="" class="h-7 w-7 object-contain">
                  <div class="min-w-0">
                    <div class="truncate font-medium text-gray-900 dark:text-white">{{ g.name }}</div>
                    <div class="text-xs text-gray-500">{{ (g.rewards || []).map(itemText).join('、') }}</div>
                  </div>
                </div>
                <div class="mt-2 text-xs text-gray-500">
                  花费：{{ (g.costs || []).map(itemText).join('、') || '—' }}
                  <template v-if="g.purchaseLimit && g.purchaseLimit > 0">
                    · 限购余 <b class="text-gray-700 dark:text-gray-200">{{ fmtNum(g.remaining ?? 0) }}</b>
                  </template>
                </div>
                <div v-if="goodsBlockReason(g)" class="mt-1 text-xs text-rose-500">
                  {{ goodsBlockReason(g) }}
                </div>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <input
                  :value="goodsCountOf(g.id)"
                  type="number"
                  min="1"
                  class="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  @input="setGoodsCount(g.id, Number(($event.target as HTMLInputElement).value))"
                >
                <BaseButton
                  variant="primary"
                  :loading="operateLoading"
                  :disabled="operateLoading || !g.available || settling"
                  @click="doExchange(g)"
                >
                  兑换
                </BaseButton>
              </div>
            </div>
          </div>
          <p v-if="!goods.length" class="text-xs text-gray-400">暂未读取到兑换商品。</p>
        </div>

        <!-- 成长基金 -->
        <div v-else-if="currentTab === 'fund'" class="space-y-3">
          <div class="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 class="font-semibold text-gray-900 dark:text-white">
                  成长基金
                  <span class="ml-2 rounded-md px-1.5 py-0.5 text-xs" :class="fund?.unlocked
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
                    {{ fund?.unlocked ? '已解锁' : '未解锁' }}
                  </span>
                </h4>
                <p class="mt-1 text-xs text-gray-500">
                  <template v-if="fund?.unlocked">累计营业额达标即可领取对应档位奖励。</template>
                  <template v-else>解锁费用 {{ fundCostText || '—' }}，解锁后可领取全部达标档位。</template>
                </p>
              </div>
              <div class="flex items-center gap-2">
                <BaseButton
                  v-if="!fund?.unlocked"
                  variant="primary"
                  :loading="operateLoading"
                  :disabled="operateLoading || settling"
                  @click="emit('operate', 'unlock')"
                >
                  解锁基金
                </BaseButton>
                <BaseButton
                  variant="primary"
                  :loading="operateLoading"
                  :disabled="operateLoading || !fund?.unlocked || !(fund?.tiers || []).some(t => t.state === 2)"
                  @click="emit('operate', 'fundClaim')"
                >
                  领取奖励
                </BaseButton>
              </div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <div
              v-for="t in fund?.tiers || []"
              :key="t.id"
              class="rounded-lg border px-3 py-2 text-center text-xs"
              :class="fundStateClass(t)"
            >
              <div class="font-bold">档位 {{ t.id }}</div>
              <div class="mt-0.5 text-[10px] leading-tight">
                {{ t.conditions.map(c => `${c.current}/${c.target}`).join('、') || '—' }}
              </div>
              <div class="mt-1 text-[10px] leading-tight">
                {{ (t.rewards || []).map(itemText).join('、') }}
              </div>
              <div class="mt-1 font-medium">{{ fundStateLabel(t) }}</div>
            </div>
          </div>
          <p v-if="!(fund?.tiers || []).length" class="text-xs text-gray-400">暂未读取到基金档位。</p>
        </div>

        <!-- 排行榜 -->
        <div v-else-if="currentTab === 'rank'" class="space-y-3">
          <div class="rounded-xl bg-white p-4 text-xs text-gray-500 shadow-sm dark:bg-gray-800">
            我的排名：{{ activity?.rank?.myRank || '未上榜' }} · 第 {{ activity?.rank?.page || 1 }} 页
          </div>
          <div class="overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900/40">
                <tr>
                  <th class="px-3 py-2 text-left">名次</th>
                  <th class="px-3 py-2 text-left">店铺</th>
                  <th class="px-3 py-2 text-left">店主</th>
                  <th class="px-3 py-2 text-right">等级</th>
                  <th class="px-3 py-2 text-right">营业额</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, idx) in activity?.rank?.ranks || []" :key="idx" class="border-t border-gray-100 dark:border-gray-700">
                  <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">{{ r.rank }}</td>
                  <td class="px-3 py-2 text-gray-600 dark:text-gray-300">{{ r.shopName }}</td>
                  <td class="px-3 py-2 text-gray-600 dark:text-gray-300">{{ r.owner?.name || '—' }}</td>
                  <td class="px-3 py-2 text-right text-gray-600 dark:text-gray-300">Lv.{{ r.level }}</td>
                  <td class="px-3 py-2 text-right text-gray-600 dark:text-gray-300">{{ fmtNum(r.totalRevenue) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!(activity?.rank?.ranks || []).length" class="px-3 py-4 text-center text-xs text-gray-400">暂无排行数据。</p>
          </div>
        </div>

        <!-- 销售日志 -->
        <div v-else-if="currentTab === 'logs'" class="space-y-3">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-lg bg-amber-50 px-4 py-3 dark:bg-amber-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">当日营业额</div>
              <div class="mt-1 text-xl font-bold text-amber-600 dark:text-amber-300">{{ fmtNum(activity?.logs?.coin) }}</div>
            </div>
            <div class="rounded-lg bg-orange-50 px-4 py-3 dark:bg-orange-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">奶茶券收入</div>
              <div class="mt-1 text-xl font-bold text-orange-600 dark:text-orange-300">{{ fmtNum(activity?.logs?.token) }}</div>
            </div>
            <div class="rounded-lg bg-sky-50 px-4 py-3 dark:bg-sky-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">售出杯数</div>
              <div class="mt-1 text-xl font-bold text-sky-600 dark:text-sky-300">{{ fmtNum(activity?.logs?.cups) }}</div>
            </div>
            <div class="rounded-lg bg-gray-50 px-4 py-3 dark:bg-gray-900/20">
              <div class="text-xs text-gray-500 dark:text-gray-400">统计日</div>
              <div class="mt-1 text-sm font-bold text-gray-700 dark:text-gray-200">{{ fmtTime(activity?.logs?.day) }}</div>
            </div>
          </div>
          <div v-if="activity?.logs?.items?.length" class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <h4 class="mb-2 text-sm font-semibold text-gray-900 dark:text-white">当日产出</h4>
            <div class="flex flex-wrap gap-2">
              <div v-for="(item, idx) in activity.logs.items" :key="idx" class="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5 text-sm dark:bg-gray-900/40">
                <img v-if="itemImage(item)" :src="itemImage(item)" alt="" class="h-6 w-6 object-contain">
                <span class="text-gray-800 dark:text-gray-100">{{ itemText(item) }}</span>
              </div>
            </div>
          </div>
          <p v-else class="text-xs text-gray-400">当日暂无销售记录。</p>
        </div>
      </template>
    </template>
  </div>
</template>
