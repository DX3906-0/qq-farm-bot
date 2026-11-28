<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { deriveAccountPresentation } from '@/utils/operation-result'
import { formatCurrencyAmountByLabel, formatIntegerAmount } from '@/utils/number-format'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import type { RanchPage } from '@/router/menu'
import { readAccountUiState, writeAccountUiState } from '@/composables/useAccountUiState'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import GameViewSwitch from '@/components/GameViewSwitch.vue'
import RanchProgressPanel from '@/components/RanchProgressPanel.vue'
import RanchMarketPanel from '@/components/RanchMarketPanel.vue'
import RanchItemImage from '@/components/RanchItemImage.vue'
import { useSlidingTabs, vSlidingTabs } from '@/composables/useContentMotion'
import { accountDataEmptyState, LOCAL_UI_READONLY } from '@/config/localReadonly'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useSettingStore } from '@/stores/setting'
import type { RanchAnimal, RanchBagItem, RanchCanGood, RanchCatalogGood, RanchFacility, RanchCoreProgressSection, RanchProgressSection, RanchQuote } from '@/stores/ranch'
import { ranchItemLabel, useRanchStore } from '@/stores/ranch'

const props = withDefaults(defineProps<{ page?: RanchPage }>(), { page: 'overview' })
const route = useRoute()
const router = useRouter()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const settingStore = useSettingStore()
const ranchStore = useRanchStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const panelStatus = computed(() => statusStore.currentStatusReady ? statusStore.status : null)
const presentation = computed(() => deriveAccountPresentation({
  accountId: currentAccountId.value, account: currentAccount.value,
  snapshot: panelStatus.value ? { ...panelStatus.value, metadata: statusStore.currentStatusMetadata } : null,
  snapshotReady: statusStore.currentStatusReady, loading: statusStore.loading, error: statusStore.error,
  stale: statusStore.currentStatusStale, readonly: LOCAL_UI_READONLY,
}))
const accountName = computed(() => currentAccount.value?.name || panelStatus.value?.status?.name || currentAccount.value?.nick || '账号资料尚未读取')
const { friends, friendsLoading, friendsError } = storeToRefs(ranchStore)
const { overview, loading, error, friendOverview, friendLoading, friendError, operations, operationsError, catalogs, catalogLoading, catalogErrors, bagOverview, bagLoading, bagError, canCatalogs, canLoading, canErrors, progressViews, progressLoading, operating, writeBlocked, currentState, notice } = storeToRefs(ranchStore)
const currencyRows = computed(() => [
  { label: '金券', icon: 'i-fas-ticket-alt', color: 'text-amber-600 dark:text-amber-400', value: bagOverview.value?.goldVoucherBalance },
  { label: '点券', icon: 'i-fas-ticket-alt', color: 'text-emerald-600 dark:text-emerald-400', value: panelStatus.value?.status?.coupon },
  { label: '金豆', icon: 'i-carbon-circle', color: 'text-amber-600 dark:text-amber-400', value: panelStatus.value?.status?.goldBean },
])
const emptyState = computed(() => accountDataEmptyState(LOCAL_UI_READONLY, currentAccountId.value))
const sectionDefinitions = [
  { key: 'home', label: '我的牧场', icon: 'i-carbon-sprout' },
  { key: 'bag', label: '我的背包', icon: 'i-carbon-box' },
  { key: 'tasks', label: '成长手册', icon: 'i-carbon-task' },
  { key: 'book', label: '牧场图鉴', icon: 'i-carbon-book' },
  { key: 'share', label: '每日分享', icon: 'i-carbon-gift' },
  { key: 'friends', label: '好友牧场', icon: 'i-carbon-user-multiple' },
  { key: 'catalog', label: '幼崽与饲料', icon: 'i-carbon-shopping-cart' },
  { key: 'cans', label: '罐头商城', icon: 'i-carbon-box' },
  { key: 'market', label: '仓鼠集市', icon: 'i-carbon-shopping-cart' },
  { key: 'activities', label: '牧场活动', icon: 'i-carbon-calendar' },
] as const
type RanchSection = typeof sectionDefinitions[number]['key']
const pageSections: Record<RanchPage, readonly RanchSection[]> = {
  overview: ['home'], personal: ['home', 'bag', 'tasks', 'share'], friends: ['friends'],
  activity: ['activities'], shop: ['catalog', 'cans', 'market'], illustrated: ['book'],
}
const sections = computed(() => pageSections[props.page].map(key => sectionDefinitions.find(section => section.key === key)!))
const pageTitle = computed(() => ({ overview: '牧场概览', personal: '个人中心', friends: '好友牧场',
  activity: '牧场活动', shop: '牧场商城', illustrated: '牧场图鉴' })[props.page])
const pageDescription = computed(() => ({ overview: '查看动物、待收获产物和牧草库存。',
  personal: '照料动物，管理背包、成长手册与每日分享。', friends: '查看好友牧场，帮忙照料与收取产物。',
  activity: '查看正在进行的牧场活动与开放时间。',
  shop: '选购幼崽、饲料与罐头，逛逛仓鼠集市。',
  illustrated: '查看收集进度、动物图鉴与巨大动物纪录。' })[props.page])
function initialSection(): RanchSection {
  const saved = route.query.section || readAccountUiState(String(currentAccountId.value || ''), `ranch:${props.page}`).tab
  return sections.value.some(section => section.key === saved) ? saved as RanchSection : sections.value[0]!.key
}
const ranchSection = ref<RanchSection>(initialSection())
const ranchContent = ref<HTMLElement | null>(null)
const sectionNav = ref<HTMLElement | null>(null)
const sectionId = useId()
const sectionMotion = useSlidingTabs(ranchSection, () => ranchContent.value, () => sections.value.map(section => section.key), () => `${currentAccountId.value}:${props.page}`)
const { select: selectSection, selected: selectedSection } = sectionMotion
// Scroll only the local tab strip; never move the page or trigger a scene read.
function alignSectionTabs(immediate = false) {
  const nav = sectionNav.value
  const selected = nav?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!nav || !selected || nav.scrollWidth <= nav.clientWidth) return
  const margin = 8
  const left = selected.offsetLeft < nav.scrollLeft + margin ? selected.offsetLeft - margin
    : selected.offsetLeft + selected.offsetWidth > nav.scrollLeft + nav.clientWidth - margin
      ? selected.offsetLeft + selected.offsetWidth - nav.clientWidth + margin : nav.scrollLeft
  nav.scrollTo({ left: Math.max(0, left), behavior: immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
}
watch(sectionNav, () => alignSectionTabs(true), { flush: 'post' })
watch(selectedSection, () => alignSectionTabs(), { flush: 'post' })
const isProgressSection = computed(() => ['tasks', 'book', 'share'].includes(ranchSection.value))
const isCommerceSection = computed(() => ['market', 'activities'].includes(ranchSection.value))
const refreshLoading = computed(() => bagLoading.value || (isProgressSection.value || isCommerceSection.value ? progressLoading.value[ranchSection.value as RanchProgressSection]
  : ranchSection.value === 'catalog' ? catalogLoading.value[catalogShopId.value]
    : ranchSection.value === 'cans' ? canLoading.value[canSlotType.value]
      : ranchSection.value === 'bag' ? bagLoading.value : ranchSection.value === 'friends' ? friendLoading.value : loading.value))
let resettingSection = false
function moveSectionFocus(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const count = sections.value.length
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count
  sectionNav.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

const ranchFacilities = computed(() => (overview.value?.facilities || []).filter(item => item.ranch))
const ranchLevelProgress = computed(() => {
  const level = bagOverview.value?.level
  if (!level || level.neededExp == null || !/^\d+$/.test(String(level.currentExp)) || !/^\d+$/.test(String(level.neededExp))) return null
  const current = BigInt(level.currentExp)
  const needed = BigInt(level.neededExp)
  return { current: current.toString(), needed: needed.toString(), percent: needed > 0n ? Number(current * 10000n / needed) / 100 : 100 }
})
const otherFacilities = computed(() => (overview.value?.facilities || []).filter(item => !item.ranch))
interface RanchLog { time?: number | string, ts?: number, tag?: string, msg?: string, isWarn?: boolean, recordId?: string, meta?: { event?: string, result?: string } }
const logSnapshot = ref<{ accountId: string, entries: RanchLog[], readAt: number } | null>(null)
const logLoading = ref(false)
const logError = ref(false)
let logRequest: AbortController | undefined
const readableLogs = computed(() => logSnapshot.value?.accountId === String(currentAccountId.value) ? logSnapshot.value : null)
const ranchLogEntries = computed<RanchLog[]>(() => [...(readableLogs.value?.entries || []), ...(ranchStore.interfaceLogs || [])].sort((a, b) => (logTimestamp(a) || 0) - (logTimestamp(b) || 0)))
const savedAutomation = computed(() => panelStatus.value?.automation
  ?? (settingStore.settingsAccountId === String(currentAccountId.value) && !settingStore.readError ? settingStore.confirmedAutomation : null))
const routineState = computed(() => panelStatus.value?.ranchAutomation)
const ranchMugeAutoClaimEnabled = computed<boolean | null>(() => {
  const automation = savedAutomation.value
  if (!automation) return null
  return automation.ranch === true && automation.ranch_activity_claim === true
})
const ranchMugeAutoClaimSummary = computed(() => {
  const state = routineState.value
  if (ranchMugeAutoClaimEnabled.value !== true) return ''
  if (!state) return '巡查状态未读取'
  if (operations.value.length || currentState.value === 'unknown' || state.lastResult === 'unknown') return '等待服务端状态更新，系统不会要求人工确认或重复提交'
  if (state.running) return '巡查正在运行'
  if (state.lastResult === 'confirmed') return '最近巡查有确认操作'
  if (state.lastResult === 'error') return `最近巡查失败：${state.lastError || '原因未返回'}`
  if (state.lastResult === 'yielded') return '巡查让路，等待下次调度'
  return state.enabled ? '等待下次巡查' : '牧场总开关未运行'
})
const activityReadOnlyReason = computed(() => {
  if (!writeBlocked.value) return ''
  if (currentState.value === 'pending') return '另一项牧场操作仍在等待服务端返回'
  if (operations.value.length) return '等待服务端状态更新；无需人工确认'
  if (operationsError.value) return `安全状态读取失败：${operationsError.value}`
  return '牧场场景或好友离场状态尚未确认'
})
const routineClock = ref(Date.now())
const ranchCycleText = computed(() => {
  const min = Number(routineState.value?.farmMin)
  const max = Number(routineState.value?.farmMax)
  return min > 0 && max >= min ? `${min === max ? min : `${min}–${max}`} 秒（同农场）` : '跟随农场设置'
})
const ranchRoutineText = computed(() => {
  if (currentState.value === 'pending') return '操作中'
  const state = routineState.value
  if (!state || presentation.value.kind !== 'online') return '—'
  if (state.running) return '巡查中'
  if (operations.value.length) return '部分目标等待服务端状态更新'
  if (currentState.value === 'unknown') return '等待服务端状态更新'
  if (state.lastResult === 'unknown') return '等待服务端状态更新'
  if (state.lastResult === 'error') return '等待巡查'
  if (state.lastResult === 'yielded') return '等待下一次巡查'
  return state.enabled ? '等待巡查' : '未启用'
})
function countdownText(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds === 0) return '检查中…'
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':')
}
const ranchCountdownText = computed(() => {
  const state = routineState.value
  if (!state || presentation.value.kind !== 'online') return '—'
  if (currentState.value === 'pending') return '操作中'
  if (currentState.value === 'unknown') return '—'
  if (state.running) return '巡查中'
  if (state.lastResult === 'unknown' && !operations.value.length) return '—'
  if (!state.enabled) return '未安排巡查'
  const at = Number(state.nextCheckAt)
  if (!Number.isFinite(at) || at <= 0) return '等待调度'
  const seconds = Math.ceil((at - routineClock.value) / 1000)
  if (seconds <= 0) return '等待调度'
  return countdownText(seconds)
})
const farmCountdownRows = computed(() => {
  const checks = panelStatus.value?.nextChecks
  const updatedAt = Number(statusStore.currentStatusMetadata?.updatedAt || 0)
  const elapsed = updatedAt > 0 ? Math.max(0, Math.floor((routineClock.value - updatedAt) / 1000)) : 0
  const remaining = (key: 'helpRemainSec' | 'stealRemainSec') => {
    const value = Number(checks?.[key])
    return Number.isFinite(value) && value >= 0 ? Math.max(0, value - elapsed) : null
  }
  return [
    { label: '牧场', icon: 'i-carbon-sprout', color: 'text-green-500', text: ranchCountdownText.value },
    { label: '帮助', icon: 'i-carbon-user-multiple', color: 'text-blue-500', text: countdownText(remaining('helpRemainSec')) },
    { label: '偷取', icon: 'i-carbon-run', color: 'text-orange-500', text: countdownText(remaining('stealRemainSec')) },
  ]
})
const ranchTodayStats = computed(() => {
  const rows = [
    { label: '收获', event: 'ranch_harvest', count: 0, icon: 'i-carbon-crop-growth', color: 'text-green-500' },
    { label: '生产', event: 'ranch_produce', count: 0, icon: 'i-carbon-growth', color: 'text-blue-500' },
    { label: '清理', event: 'ranch_clean', count: 0, icon: 'i-carbon-clean', color: 'text-teal-500' },
    { label: '出售', event: 'ranch_sell', count: 0, icon: 'i-carbon-shopping-cart', color: 'text-orange-500' },
    { label: '投放蚊子', event: 'ranch_friend_putMosquito', count: 0, icon: 'i-carbon-pest', color: 'text-red-500' },
    { label: '好友互动', event: 'ranch_friend_', count: 0, icon: 'i-carbon-user-multiple', color: 'text-violet-500' },
  ]
  const start = new Date(routineClock.value).setHours(0, 0, 0, 0)
  for (const entry of ranchLogEntries.value) {
    const at = logTimestamp(entry)
    if (!Number.isFinite(at) || at < start || entry.meta?.result !== 'ok') continue
    const event = entry.meta.event || ''
    const row = rows.find(item => item.event === event || (item.event === 'ranch_friend_' && event.startsWith(item.event)))
    if (row) row.count++
  }
  return rows
})
function logTimestamp(entry: RanchLog) {
  const value = entry.ts ?? entry.time
  return typeof value === 'number' ? value : value ? Date.parse(value) : NaN
}
function ranchLogTime(entry: RanchLog) {
  const at = logTimestamp(entry)
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
}
function ranchLogTagClass(entry: RanchLog) {
  if (entry.tag === '错误' || entry.meta?.result === 'error') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (entry.isWarn || entry.meta?.result === 'unknown') return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  if (entry.tag === '系统') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (entry.tag === '活动') return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}
function ranchLogEventLabel(event: string) {
  const labels: Record<string, string> = {
    ranch_harvest: '收获', ranch_produce: '催产', ranch_clean: '清理', ranch_sell: '出售', ranch_addGrass: '补草',
    ranch_buy: '购买', ranch_place: '放养', ranch_feed: '喂养', ranch_completeUpgrade: '完成升级',
    ranch_friend_steal: '好友偷取', ranch_friend_cleanFriend: '好友清理', ranch_friend_stroke: '抚摸', ranch_friend_putMosquito: '放蚊',
    ranch_patrol_complete: '巡查完成', ranch_patrol_paused: '巡查暂停', ranch_automation: '自动巡查',
    ranch_ui_read: '界面读取', ranch_ui_notice: '界面记录',
  }
  return labels[event] || event
}
async function readRanchLogs(accountId: string) {
  if (logRequest || !accountId || accountId !== String(currentAccountId.value) || props.page !== 'overview' || LOCAL_UI_READONLY
    || typeof document !== 'undefined' && document.hidden) return
  const request = new AbortController()
  logRequest = request
  logLoading.value = true
  logError.value = false
  try {
    const { data } = await api.get('/api/logs', {
      headers: { 'x-account-id': accountId }, params: { accountId, module: 'ranch', limit: 100 }, signal: request.signal,
    })
    if (request.signal.aborted || accountId !== String(currentAccountId.value) || props.page !== 'overview') return
    if (data?.ok !== true || !Array.isArray(data.data)) throw new Error('日志读取失败')
    logSnapshot.value = { accountId, entries: data.data, readAt: Date.now() }
  }
  catch {
    if (!request.signal.aborted) logError.value = true
  }
  finally {
    if (logRequest === request) {
      logRequest = undefined
      logLoading.value = false
    }
  }
}
function resetRanchLogs() {
  logRequest?.abort()
  logRequest = undefined
  logSnapshot.value = null
  logLoading.value = false
  logError.value = false
}
function readOverviewPanel(accountId: string) {
  return Promise.all([statusStore.fetchStatus(accountId), settingStore.fetchSettings(accountId), readRanchLogs(accountId)])
}
async function loadRanchPage(accountId: string, force = false) {
  if (!accountId || LOCAL_UI_READONLY) return
  const page = props.page
  const sceneReads = async () => {
    if (page === 'overview') await ranchStore.fetchBag(accountId)
    if (accountId !== String(currentAccountId.value) || page !== props.page) return
    await readVisibleSection(accountId, '', force)
  }
  await Promise.all([
    ranchStore.fetchOperations(accountId),
    page === 'overview' ? readOverviewPanel(accountId) : Promise.resolve(),
    sceneReads(),
  ])
}
let logTimer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  if (LOCAL_UI_READONLY) return
  clockTimer = setInterval(() => {
    if (props.page === 'overview' && !document.hidden) routineClock.value = Date.now()
  }, 1000)
  logTimer = setInterval(() => {
    if (props.page === 'overview' && currentAccountId.value && !document.hidden) {
      void readRanchLogs(String(currentAccountId.value))
      void statusStore.fetchStatus(String(currentAccountId.value))
    }
  }, 15000)
})

// ------- 购买与操作：读取价格/状态 → 用户确认 → 执行 -------
interface PendingAction { action: string, input: Record<string, unknown>, title: string }

const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmLoading = ref(false)
const confirmError = ref('')
const confirmQuote = ref<RanchQuote | null>(null)
const pendingAction = ref<PendingAction | null>(null)
const confirmPrimaryLabel = computed(() => {
  if (confirmQuote.value?.pendingBlocked) return '当前服务端状态未更新，暂不能执行'
  if (confirmQuote.value?.skipped) return '当前不能操作'
  if (['buy', 'buyCan'].includes(pendingAction.value?.action || '')) return '确认购买'
  if (pendingAction.value?.action === 'exchange') return '确认兑换'
  if (pendingAction.value?.action === 'upgrade') return '确认升级'
  return '确认操作'
})
let dialogEpoch = 0
const catalogShopId = ref<5 | 6>(5)
const purchaseCounts = ref<Record<number, number>>({})
const catalogGoods = computed(() => catalogs.value[catalogShopId.value] || [])
const bagOpen = ref(false)
const canSlotType = ref<6 | 7>(6)
const bagCounts = ref<Record<string, number>>({})
const placeChoices = ref<Record<string, string>>({})
const canPurchaseCounts = ref<Record<string, number>>({})
const currentCanGoods = computed(() => canCatalogs.value[canSlotType.value] || [])
const selectedFriendGid = ref<number | null>(null)
const friendSearch = ref('')
const friendAvatarErrors = ref(new Set<number>())
const filteredRanchFriends = computed(() => {
  const query = friendSearch.value.trim().toLocaleLowerCase()
  return query ? friends.value.filter(friend => friend.name.toLocaleLowerCase().includes(query) || String(friend.gid).includes(query)) : friends.value
})

function itemKey(item: RanchBagItem) {
  return `${item.id}:${item.uid}`
}

function safeStock(value: string, maximum = 2147483647) {
  if (!/^\d+$/.test(value || '')) return 0
  const count = BigInt(value)
  return Number(count > BigInt(maximum) ? BigInt(maximum) : count)
}

function compatiblePens(item: RanchBagItem) {
  return (bagOverview.value?.pens || []).filter(pen => pen.husbandryType === item.animal?.husbandryType && pen.room > 0)
}

function penChoice(item: RanchBagItem) {
  const pens = compatiblePens(item)
  return pens.find(pen => pen.id === placeChoices.value[itemKey(item)]) || pens[0] || null
}

function bagQuantityLimit(item: RanchBagItem) {
  if (item.locked) return 0
  return item.category === 'cub' ? Math.min(safeStock(item.availableTypeCount, 999), penChoice(item)?.room || 0)
    : safeStock(item.availableCount)
}

function selectedBagQuantity(item: RanchBagItem) {
  return Math.min(bagQuantityLimit(item), Math.max(1, Math.floor(Number(bagCounts.value[itemKey(item)]) || 1)))
}

async function openBag() {
  bagOpen.value = true
  const id = String(currentAccountId.value || '')
  if (id) await ranchStore.fetchBag(id)
}

async function openCanShop(slotType: 6 | 7 = 6) {
  canSlotType.value = slotType
  const id = String(currentAccountId.value || '')
  if (id) await ranchStore.fetchCanCatalog(id, slotType)
}

function useBagItem(item: RanchBagItem) {
  const count = selectedBagQuantity(item)
  if (count <= 0) return
  if (item.category === 'can' && item.canUseCan) {
    requestAction('useCan', { uid: item.uid, count }, `添加${item.name}入桶`)
  }
  else if (item.category === 'cub' && item.canPlace && penChoice(item)) {
    requestAction('place', { ranchId: penChoice(item)!.id, itemId: item.id, count }, `放养${item.name}至${penChoice(item)!.name}`)
  }
}

function buyCanGood(good: RanchCanGood) {
  const count = Math.max(1, Math.min(good.maxCount, good.remaining ?? 999, Math.floor(Number(canPurchaseCounts.value[good.id]) || 1)))
  requestAction('buyCan', { slotType: canSlotType.value, goodsId: good.id, count }, `${good.free ? '领取' : '购买'}${good.name}`)
}

async function loadFriendRanch() {
  const accountId = String(currentAccountId.value || '')
  const gid = Number(selectedFriendGid.value)
  if (!accountId || !Number.isSafeInteger(gid) || gid <= 0)
    return
  await ranchStore.fetchFriend(accountId, gid)
}

async function selectRanchFriend(gid: number) {
  if (operating.value || !friends.value.some(friend => Number(friend.gid) === gid)) return
  if (selectedFriendGid.value === gid) {
    selectedFriendGid.value = null
    return
  }
  selectedFriendGid.value = gid
  if (!LOCAL_UI_READONLY) await loadFriendRanch()
}
async function refreshRanchFriends() {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || LOCAL_UI_READONLY || friendsLoading.value) return
  await ranchStore.fetchFriends(accountId)
  if (accountId !== String(currentAccountId.value) || friendsError.value) return
  if (selectedFriendGid.value && !friends.value.some(friend => Number(friend.gid) === selectedFriendGid.value)) selectedFriendGid.value = null
}

async function selectCatalog(shopId: 5 | 6) {
  catalogShopId.value = shopId
  const accountId = String(currentAccountId.value || '')
  if (accountId && !catalogs.value[shopId])
    await ranchStore.fetchCatalog(accountId, shopId)
}

function purchaseCount(goodsId: number, maxCount: number, remaining: number | null) {
  const upper = Math.max(1, Math.min(maxCount || 1, remaining ?? Number.MAX_SAFE_INTEGER))
  const value = Math.floor(Number(purchaseCounts.value[goodsId]) || 1)
  return Math.max(1, Math.min(upper, value))
}
function catalogPurchaseBlockedReason(good: RanchCatalogGood) {
  if (writeBlocked.value) return operationsError.value || '牧场场景暂不可操作'
  if (ranchStore.hasPendingConflict(`ranch:buy:${good.id}`, [`item:${good.currencyId}`])) return '当前购买状态尚未同步，暂不可使用相同余额'
  if (good.owned) return '已拥有'
  if (!good.valid) return '商品信息未确认'
  if (!good.unlocked) return '暂未解锁'
  if (good.remaining === 0) return '本轮已买完'
  return '暂不可购买'
}
function canPurchaseCatalogGood(good: RanchCatalogGood) {
  return good.available && !writeBlocked.value
    && !ranchStore.hasPendingConflict(`ranch:buy:${good.id}`, [`item:${good.currencyId}`])
}

function buyCatalogGood(good: RanchCatalogGood) {
  if (!canPurchaseCatalogGood(good) || catalogLoading.value[catalogShopId.value]) return
  const count = purchaseCount(good.id, good.maxCount, good.remaining)
  requestAction('buy', {
    shopId: catalogShopId.value,
    goodsId: good.id,
    count,
    autoPlace: catalogShopId.value === 5,
  }, `购买${good.name}`)
}

function requestAction(action: string, input: Record<string, unknown>, title: string) {
  if (LOCAL_UI_READONLY || !currentAccountId.value || writeBlocked.value) {
    if (writeBlocked.value) confirmError.value = '服务端状态正在同步，系统已暂停可能重复的操作。'
    return
  }
  dialogEpoch++
  confirmTitle.value = title
  confirmError.value = ''
  confirmQuote.value = null
  pendingAction.value = { action, input, title }
  confirmOpen.value = true
  void loadQuote()
}

async function loadQuote() {
  const pending = pendingAction.value
  const accountId = String(currentAccountId.value)
  if (!pending || !accountId)
    return
  const epoch = dialogEpoch
  confirmLoading.value = true
  const result = await ranchStore.quote(accountId, pending.action, pending.input)
  if (result.stale || epoch !== dialogEpoch || pendingAction.value !== pending || accountId !== String(currentAccountId.value))
    return
  confirmLoading.value = false
  if (!result.ok || !result.quote) {
    confirmError.value = result.error || '操作信息未确认'
    return
  }
  confirmQuote.value = result.quote
}

function closeConfirm() {
  if (operating.value)
    return
  dialogEpoch++
  ranchStore.cancelQuote()
  confirmLoading.value = false
  confirmOpen.value = false
  pendingAction.value = null
  confirmQuote.value = null
  confirmError.value = ''
}

async function runConfirmed() {
  const pending = pendingAction.value
  const quote = confirmQuote.value
  const accountId = String(currentAccountId.value)
  if (!pending || !quote || quote.skipped || quote.pendingBlocked || writeBlocked.value)
    return
  const epoch = dialogEpoch
  confirmLoading.value = true
  confirmError.value = ''
  const result = await ranchStore.execute(accountId, pending.action, pending.input, quote.expected)
  if (result.stale || epoch !== dialogEpoch || pendingAction.value !== pending || accountId !== String(currentAccountId.value))
    return
  confirmLoading.value = false
  if (!result.ok) {
    confirmError.value = result.error || '操作未完成'
    await ranchStore.fetchOperations(accountId)
    return
  }
  const completedAction = pending.action
  const completedHost = Number(pending.input.hostGid)
  confirmOpen.value = false
  pendingAction.value = null
  confirmQuote.value = null
  const refreshes: Array<Promise<unknown>> = [ranchStore.fetchOperations(accountId)]
  if (ranchSection.value === 'friends' && ['steal', 'cleanFriend', 'stroke', 'putMosquito'].includes(completedAction)
    && Number.isSafeInteger(completedHost) && completedHost > 0) {
    refreshes.push(ranchStore.fetchFriend(accountId, completedHost))
  }
  else {
    // The successful write invalidates all old snapshots; refresh only the
    // page still visible, not hidden tasks, shops or the former home panel.
    refreshes.push(readVisibleSection(accountId, '', true))
  }
  await Promise.all(refreshes)
}

function formatNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '待确认'
  const formatted = formatIntegerAmount(value)
  return formatted === '—' ? '待确认' : formatted
}

function formatTime(value: number | null | undefined) {
  if (!value)
    return '暂无到期时间'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function animalState(animal: RanchAnimal) {
  if (animal.canHarvest)
    return '可收获'
  if (animal.canProduce)
    return '可生产'
  if (animal.grassBlocked)
    return '缺少牧草'
  if (animal.canFeed)
    return '可投喂'
  return animal.stageName || `阶段 ${animal.stage}`
}

function facilityLabel(facility: RanchFacility) {
  if (facility.ranch?.husbandryType === 1)
    return '动物窝'
  if (facility.ranch?.husbandryType === 2)
    return '动物棚'
  if (facility.feedMachine)
    return '牧草机'
  return facility.name
}

function feedMachineFacility() {
  return otherFacilities.value.find(item => item.feedMachine) || null
}
function feedMachineRemainingText(facility: RanchFacility) {
  const seconds = Number(facility.feedMachine?.remainingSec)
  return Number.isSafeInteger(seconds) && seconds >= 0 ? formatNumber(seconds) : '暂不可用'
}
function facilityFallbackIcon(facility: RanchFacility) {
  const label = facilityLabel(facility)
  if (label.includes('留言') || /board/i.test(label)) return 'i-carbon-notebook text-violet-500'
  if (facility.feedMachine) return 'i-carbon-wheat text-lime-600'
  if (facility.ranch) return 'i-carbon-user-multiple text-emerald-600'
  return 'i-carbon-building text-blue-500'
}
async function retryOverviewRead() {
  const accountId = String(currentAccountId.value || '')
  if (!LOCAL_UI_READONLY && accountId && !loading.value) await ranchStore.fetchOverview(accountId)
}

function canQuoteUpgrade(facility: RanchFacility) {
  return facility.state === 1 && facility.upgradeState === 0 && !!facility.nextUpgrade
}

function hasReadyUpgrade(facility: RanchFacility) {
  if (![6, 7, 8].includes(facility.moduleType)) return false
  return facility.upgradeState === 2
    || (facility.upgradeState !== 0 && facility.upgradeEndAtMs !== null && facility.upgradeEndAtMs <= Date.now())
}

function prepareVisibleSection() {
  bagOpen.value = ranchSection.value === 'bag'
}
async function readVisibleSection(accountId: string, groupId = '', force = false) {
  const section = ranchSection.value
  if (LOCAL_UI_READONLY || !accountId) return
  if (['tasks', 'book', 'share', 'market', 'activities'].includes(section)) {
    const target = section as RanchProgressSection
    if (force || !progressViews.value[target]) await ranchStore.fetchProgress(accountId, target, groupId)
  }
  else if (section === 'bag') { if (force || !bagOverview.value) await ranchStore.fetchBag(accountId) }
  else if (section === 'catalog') { if (force || !catalogs.value[catalogShopId.value]) await ranchStore.fetchCatalog(accountId, catalogShopId.value) }
  else if (section === 'cans') { if (force || !canCatalogs.value[canSlotType.value]) await ranchStore.fetchCanCatalog(accountId, canSlotType.value) }
  else if (section === 'friends') {
    if (selectedFriendGid.value) await loadFriendRanch()
    else await ranchStore.fetchFriends(accountId)
  }
  else if (force || !overview.value || ranchStore.lastSummaries[accountId]?.stale) await ranchStore.fetchOverview(accountId)
}
async function refresh(groupId: string | MouseEvent = '') {
  const accountId = String(currentAccountId.value || '')
  if (LOCAL_UI_READONLY || !accountId) return
  prepareVisibleSection()
  const section = ranchSection.value
  await Promise.all([ranchStore.fetchOperations(accountId),
    props.page === 'overview' ? readOverviewPanel(accountId) : undefined])
  if (accountId !== String(currentAccountId.value) || section !== ranchSection.value) return
  if (props.page === 'overview') await ranchStore.fetchBag(accountId)
  if (accountId !== String(currentAccountId.value) || section !== ranchSection.value) return
  await readVisibleSection(accountId, typeof groupId === 'string' ? groupId : '', true)
}
function goToShop(section: 'catalog' | 'cans' = 'catalog') {
  void router.push({ path: '/ranch/shop', query: { section } })
}
watch(ranchSection, section => {
  if (resettingSection) return
  prepareVisibleSection()
  const accountId = String(currentAccountId.value || '')
  if (accountId) writeAccountUiState(accountId, `ranch:${props.page}`, { tab: section })
  void readVisibleSection(accountId)
}, { flush: 'sync' })
watch(() => route.query.section, key => {
  if (sections.value.some(section => section.key === key) && key !== ranchSection.value) void selectSection(key as RanchSection)
})

// 诊断只进入当前账号的界面日志；不决定开关、写权限或重试策略。
watch(() => [String(currentAccountId.value || ''), error.value, friendsError.value, friendError.value, operationsError.value,
  bagError.value, JSON.stringify(catalogErrors.value), JSON.stringify(canErrors.value), JSON.stringify(ranchStore.progressErrors),
  confirmError.value, logError.value, notice.value,
  currentState.value, JSON.stringify(operations.value)], () => {
  const accountId = String(currentAccountId.value || '')
  if (!accountId || LOCAL_UI_READONLY) return
  const errors = [error.value, friendsError.value, friendError.value, operationsError.value, bagError.value,
    ...Object.values(catalogErrors.value), ...Object.values(canErrors.value), ...Object.values(ranchStore.progressErrors || {}),
    confirmError.value, logError.value ? '牧场日志刷新失败' : '']
  for (const message of errors) if (message) ranchStore.appendInterfaceLog?.(accountId, 'ranch_ui_read', message)
  if (notice.value) ranchStore.appendInterfaceLog?.(accountId, 'ranch_ui_notice', notice.value, 'info')
}, { flush: 'post' })

watch(selectedFriendGid, () => {
  ranchStore.clearFriend()
}, { flush: 'sync' })

watch([currentAccountId, () => props.page], ([value]) => {
  sectionMotion.cancel('context')
  resettingSection = true
  ranchSection.value = initialSection()
  resettingSection = false
  dialogEpoch++
  confirmOpen.value = false
  pendingAction.value = null
  confirmQuote.value = null
  confirmError.value = ''
  confirmLoading.value = false
  bagOpen.value = false
  bagCounts.value = {}
  placeChoices.value = {}
  canPurchaseCounts.value = {}
  purchaseCounts.value = {}
  selectedFriendGid.value = null
  friendSearch.value = ''
  friendAvatarErrors.value = new Set()
  ranchStore.clear()
  resetRanchLogs()
  prepareVisibleSection()
  if (value && !LOCAL_UI_READONLY) void loadRanchPage(String(value))
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => {
  clearInterval(logTimer)
  clearInterval(clockTimer)
  resetRanchLogs()
  ranchStore.clear()
})
</script>

<template>
  <section class="ranch-page space-y-4" :data-ranch-page="page">
    <GameViewSwitch view="ranch" :title="pageTitle" :description="pageDescription" :navigation="false">
      <BaseButton variant="secondary" :loading="refreshLoading" :disabled="LOCAL_UI_READONLY || !currentAccountId" @click="refresh"><span class="i-carbon-renew" aria-hidden="true" />刷新</BaseButton>
    </GameViewSwitch>
    <nav v-if="sections.length > 1" ref="sectionNav" v-sliding-tabs class="ui-tabs ranch-tabs" role="tablist" :aria-label="`${pageTitle}功能`">
      <button v-for="(section, index) in sections" :id="`${sectionId}-${section.key}`" :key="section.key" type="button" role="tab" class="ui-tab"
        :aria-selected="selectedSection === section.key" :aria-controls="`${sectionId}-panel`" :tabindex="selectedSection === section.key ? 0 : -1"
        :data-active="selectedSection === section.key" @click="selectSection(section.key)" @keydown="moveSectionFocus($event, index)">
        <span :class="section.icon" aria-hidden="true" /><span class="ui-tab-label">{{ section.label }}</span>
      </button>
    </nav>

    <div :id="`${sectionId}-panel`" ref="ranchContent" class="ranch-content space-y-4" :role="sections.length > 1 ? 'tabpanel' : 'region'" :aria-labelledby="sections.length > 1 ? `${sectionId}-${ranchSection}` : undefined" :aria-label="sections.length > 1 ? undefined : pageTitle" tabindex="0">
    <div v-if="!currentAccountId" class="ui-card ui-empty-state p-10 text-center text-sm text-[var(--muted-text)]">
      <h2 class="text-base font-semibold">{{ emptyState.title }}</h2>
      <p class="mt-2">{{ emptyState.description }}</p>
    </div>

    <div v-else-if="page !== 'overview' && ranchSection === 'home' && loading && !overview" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="index in 4" :key="index" class="ui-card h-24 animate-pulse bg-[var(--surface-2)]" />
    </div>

    <div v-else-if="page !== 'overview' && ranchSection === 'home' && !overview" class="ui-card ui-empty-state p-10 text-center text-sm text-[var(--muted-text)]">暂无牧场数据</div>

    <template v-else-if="page === 'overview'">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <article class="ui-card metric-card ranch-account-exp-card min-h-[248px] min-w-0 flex flex-col rounded-lg p-5" aria-label="账号等级与经验">
          <div class="flex items-start justify-between gap-3">
            <h2 class="flex items-center gap-2 text-sm text-[var(--muted-text)]"><span class="i-fas-user-circle" aria-hidden="true" />账号</h2>
            <span v-if="bagOverview?.level" class="ranch-level-badge">Lv.{{ bagOverview.level.level }}</span>
            <span v-else-if="bagLoading" class="ranch-level-badge">读取中</span>
          </div>
          <p class="mt-3 truncate text-xl font-bold" :title="accountName">{{ accountName }}</p>
          <p class="mt-1 text-xs text-[var(--muted-text)]">{{ presentation.label }}</p>
          <div class="mt-auto pt-6">
            <div class="mb-1 flex items-center justify-between gap-3 text-xs text-[var(--muted-text)]">
              <span class="flex items-center gap-1"><span class="i-fas-bolt text-blue-400" aria-hidden="true" />EXP</span>
              <span v-if="ranchLevelProgress" class="tabular-nums">{{ formatIntegerAmount(ranchLevelProgress.current) }} / {{ formatIntegerAmount(ranchLevelProgress.needed) }}</span>
              <span v-else>{{ bagLoading ? '读取中…' : bagError ? '读取失败' : bagOverview?.level?.neededExp === null ? '已达最高等级' : '经验暂不可用' }}</span>
            </div>
            <div class="ranch-level-track" role="progressbar" :aria-valuenow="ranchLevelProgress?.percent ?? 0" aria-valuemin="0" aria-valuemax="100" :aria-label="ranchLevelProgress ? `牧场经验 ${ranchLevelProgress.current} / ${ranchLevelProgress.needed}` : '牧场经验进度不可用'"><span :style="{ width: `${ranchLevelProgress?.percent ?? 0}%` }" /></div>
            <div class="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[var(--muted-text)]">
              <span>效率 {{ ranchLevelProgress ? '暂不可用' : '—' }}</span>
              <span>{{ statusStore.currentStatusStale ? '状态可能已过期' : ranchLevelProgress ? '升级时间暂不可估算' : '等待经验数据' }}</span>
            </div>
          </div>
        </article>
        <article class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5" aria-label="账号资源">
          <dl class="grid grid-cols-3 gap-2">
            <div v-for="resource in currencyRows" :key="resource.label" class="min-w-0 first:text-left last:text-right text-center">
              <dt class="flex items-center gap-1 text-xs text-[var(--muted-text)]" :class="resource.label === '点券' ? 'justify-center' : resource.label === '金豆' ? 'justify-end' : 'justify-start'"><span :class="[resource.icon, resource.color]" aria-hidden="true" /> {{ resource.label }}</dt>
              <dd class="break-all text-xl font-bold tabular-nums sm:text-2xl" :class="resource.color">
                <template v-if="resource.value != null">{{ formatCurrencyAmountByLabel(resource.value, resource.label) }}</template>
                <button v-else-if="resource.label === '金券' && bagError" type="button" class="text-sm font-medium underline underline-offset-2 disabled:cursor-wait disabled:opacity-60" :disabled="LOCAL_UI_READONLY || bagLoading || !currentAccountId" :aria-label="`金券读取失败：${bagError}，点击重试`" @click="ranchStore.fetchBag(String(currentAccountId))">{{ bagLoading ? '读取中…' : '读取失败 · 重试' }}</button>
                <span v-else-if="resource.label === '金券' && bagLoading" class="text-sm font-medium">读取中…</span>
                <span v-else>—</span>
              </dd>
            </div>
          </dl>
          <div class="mt-4 flex items-center justify-between gap-2 border-t border-[var(--surface-border)] pt-3 text-xs">
            <strong>{{ presentation.label }}</strong><span v-if="statusStore.currentStatusStale" class="text-[var(--muted-text)]">上次确认</span>
          </div>
        </article>
        <article class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5">
          <h2 class="flex items-center gap-2 text-sm text-[var(--muted-text)]"><span class="i-carbon-growth" aria-hidden="true" />牧场资源</h2>
          <dl class="my-2 grid grid-cols-3 gap-2">
            <div><dt class="flex items-center gap-1 text-xs text-[var(--muted-text)]"><span class="i-carbon-wheat text-lime-600" aria-hidden="true" />牧草机存量</dt><dd class="font-bold">{{ feedMachineFacility()?.feedMachine?.count == null ? loading ? '读取中…' : error ? '读取失败' : '—' : formatNumber(feedMachineFacility()?.feedMachine?.count) }}</dd></div>
            <div><dt class="flex items-center gap-1 text-xs text-[var(--muted-text)]"><span class="i-carbon-user-multiple text-emerald-600" aria-hidden="true" />可收获动物</dt><dd class="font-bold">{{ overview ? formatNumber(overview.summary.harvestableCount) : loading ? '读取中…' : error ? '读取失败' : '—' }}</dd></div>
          </dl>
          <div v-if="error" class="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--muted-text)]">
            <span class="truncate" :title="error">{{ error }}</span>
            <BaseButton size="sm" variant="text" :loading="loading" :disabled="LOCAL_UI_READONLY || loading || !currentAccountId" @click="retryOverviewRead">重试</BaseButton>
          </div>
          <div class="flex flex-wrap justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-[var(--muted-text)] dark:border-gray-700">
            <span>{{ overview ? `${overview.summary.animalCount} 只动物 · ${overview.summary.ranchCount} 个栏舍` : loading ? '读取中…' : '尚未读取' }}</span>
            <RouterLink to="/ranch/personal" class="text-[var(--theme-primary)] hover:underline">查看牧场</RouterLink>
          </div>
        </article>
      </div>
      <div class="flex flex-col items-stretch gap-5 md:flex-row" data-ranch-dashboard-body>
          <section class="ui-card-elevated min-w-0 flex flex-1 flex-col rounded-lg p-5 md:w-3/4 md:overflow-hidden" aria-label="运行日志">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 class="flex items-center gap-2 text-lg font-medium"><span class="i-carbon-document" aria-hidden="true" />运行日志</h2>
            <BaseButton size="sm" variant="text" class="text-[var(--muted-text)]" :loading="logLoading" :disabled="LOCAL_UI_READONLY" @click="readRanchLogs(String(currentAccountId))"><span class="i-carbon-renew" aria-hidden="true" />刷新日志</BaseButton>
          </div>
          <ol v-if="ranchLogEntries.length" class="ranch-log-list ui-subtle-panel max-h-[50vh] min-h-[320px] flex-1 overflow-y-auto rounded-lg p-4 text-sm leading-relaxed font-mono" tabindex="0" aria-label="牧场日志列表">
            <li v-for="(entry, index) in ranchLogEntries" :key="index" class="mb-1 break-all">
              <time class="mr-2 select-none text-gray-400 tabular-nums">[{{ ranchLogTime(entry) }}]</time>
              <span class="mr-2 rounded px-1.5 py-0.5 text-xs font-bold" :class="ranchLogTagClass(entry)">{{ entry.tag || '牧场' }}</span>
              <span v-if="entry.meta?.event" class="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 dark:bg-blue-900/20 dark:text-blue-400">{{ ranchLogEventLabel(entry.meta.event) }}</span>
              <span :class="entry.meta?.result === 'error' || entry.tag === '错误' ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-300'">{{ entry.msg || entry.tag || '牧场记录' }}</span>
            </li>
          </ol>
          <div v-else class="ui-subtle-panel min-h-[320px] flex flex-1 flex-col items-center justify-center rounded-lg p-4 text-center text-sm text-gray-400">
            <span class="i-carbon-document-blank mb-3 text-3xl text-gray-300" aria-hidden="true" />
            {{ logLoading ? '正在读取牧场日志…' : readableLogs ? '暂无牧场运行日志' : '尚未读取牧场日志' }}
          </div>
        </section>
        <aside class="min-w-0 flex flex-col gap-5 md:w-1/4" aria-label="牧场检查与统计">
          <section class="ui-card min-w-0 flex flex-col rounded-lg p-5">
            <h2 class="mb-4 flex items-center gap-2 text-lg font-medium"><span class="i-carbon-hourglass" aria-hidden="true" />下次检查倒计时</h2>
            <div class="flex flex-col justify-center gap-4" aria-label="下次检查倒计时">
              <div v-for="row in farmCountdownRows" :key="row.label" class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300"><span :class="[row.icon, row.color, 'text-lg']" aria-hidden="true" /><span>{{ row.label }}</span></div>
                <strong class="ranch-countdown text-lg font-bold font-mono tabular-nums">{{ row.text }}</strong>
              </div>
            </div>
            <dl class="mt-4 space-y-2 border-t border-[var(--surface-border)] pt-3 text-xs text-[var(--muted-text)]">
              <div class="flex flex-wrap justify-between gap-2"><dt>自动化</dt><dd>{{ savedAutomation?.ranch === true ? '已开启' : savedAutomation?.ranch === false ? '已关闭' : '尚未读取' }}</dd></div>
              <div class="flex flex-wrap justify-between gap-2"><dt>检查间隔</dt><dd>{{ ranchCycleText }}</dd></div>
              <div class="flex flex-wrap justify-between gap-2"><dt>运行状态</dt><dd>{{ ranchRoutineText }}</dd></div>
              <div v-if="routineState?.lastStartedAt" class="flex flex-wrap justify-between gap-2"><dt>最近巡查</dt><dd>{{ formatTime(routineState.lastStartedAt) }}</dd></div>
              <div v-if="routineState?.lastFinishedAt" class="flex flex-wrap justify-between gap-2"><dt>最近完成</dt><dd>{{ formatTime(routineState.lastFinishedAt) }}</dd></div>
            </dl>
          </section>
          <section class="ui-card min-w-0 flex-1 rounded-lg p-5">
            <h2 class="mb-3 flex items-center gap-2 text-lg font-medium"><span class="i-carbon-chart-column" aria-hidden="true" />今日统计</h2>
            <dl class="grid grid-cols-2 gap-2 2xl:gap-3">
              <div v-for="row in ranchTodayStats" :key="row.event" class="ranch-stat-tile ui-subtle-panel min-w-0 flex items-center justify-between gap-2 rounded-lg px-3 py-2 last:col-span-2">
                <dt class="min-w-0 flex items-center gap-2"><span class="shrink-0 text-base 2xl:text-lg" :class="[row.icon, row.color]" aria-hidden="true" /><span class="text-xs text-gray-500 2xl:text-sm">{{ row.label }}</span></dt>
                <dd class="shrink-0 text-sm font-bold tabular-nums 2xl:text-base">{{ readableLogs ? formatNumber(row.count) : '—' }}</dd>
              </div>
            </dl>
            <p class="mt-3 text-xs leading-relaxed text-[var(--muted-text)]">近100条日志中的今日成功记录</p>
          </section>
        </aside>
      </div>
    </template>

    <template v-else-if="overview && ranchSection === 'home'">
      <div class="ranch-metrics grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <article class="ranch-stat ui-card metric-card rounded-lg p-4">
          <span class="flex items-center gap-2"><i class="i-carbon-building text-blue-500" aria-hidden="true" />设施</span><strong>{{ formatNumber(overview.summary.facilityCount) }}</strong>
        </article>
        <article class="ranch-stat ui-card metric-card rounded-lg p-4">
          <span class="flex items-center gap-2"><i class="i-carbon-home text-violet-500" aria-hidden="true" />栏舍</span><strong>{{ formatNumber(overview.summary.ranchCount) }}</strong>
        </article>
        <article class="ranch-stat ui-card metric-card rounded-lg p-4">
          <span class="flex items-center gap-2"><i class="i-carbon-user-multiple text-emerald-500" aria-hidden="true" />动物</span><strong>{{ formatNumber(overview.summary.animalCount) }}</strong>
        </article>
        <article class="ranch-stat ui-card metric-card rounded-lg p-4">
          <span class="flex items-center gap-2"><i class="i-carbon-crop-growth text-orange-500" aria-hidden="true" />可收获</span><strong>{{ formatNumber(overview.summary.harvestableCount) }}</strong>
        </article>
        <article class="ranch-stat ui-card metric-card rounded-lg p-4">
          <span class="flex items-center gap-2"><i class="i-carbon-warning text-amber-500" aria-hidden="true" />缺草</span><strong>{{ formatNumber(overview.summary.grassBlockedCount) }}</strong>
        </article>
      </div>

      <div class="ui-card p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-semibold">牧场状态</h2>
          <span class="text-xs text-[var(--muted-text)]">
            {{ overview.cache.hit ? '短时缓存' : '实时读取' }} · {{ formatTime(overview.observedAt) }}
          </span>
        </div>
        <div class="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div class="ranch-field"><span>网格</span><b>{{ overview.grid.width }} × {{ overview.grid.height }}</b></div>
          <div class="ranch-field"><span>地块</span><b>{{ overview.grid.openCellCount }}/{{ overview.grid.cellCount }}</b></div>
          <div class="ranch-field"><span>区域额度</span><b>{{ overview.grid.regionOccupied }}/{{ overview.grid.regionQuota }}</b></div>
          <div class="ranch-field"><span>服务端时间</span><b>{{ formatTime(overview.serverTimeMs) }}</b></div>
        </div>
      </div>

      <div v-if="page === 'personal'" class="ui-card p-4">
        <h2 class="text-base font-semibold">手动操作</h2>
        <p class="mt-1 text-xs text-[var(--muted-text)]">收获产物、补充牧草，照料你的动物。</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked || !overview.summary.harvestableCount" @click="requestAction('harvest', { all: true }, '一键收获')">
            收获全部（{{ formatNumber(overview.summary.harvestableCount) }}）
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('produce', { all: true }, '一键催产')">
            催产
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('clean', {}, '清理牧场')">
            清理
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('sell', { all: true }, '出售牧场产物')">
            出售全部产物
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('feed', { all: true, bucketType: 2 }, '喂养（普通罐头）')">
            喂养（普通）
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('feed', { all: true, bucketType: 1 }, '喂养（有机罐头）')">
            喂养（有机）
          </BaseButton>
          <BaseButton
            v-if="feedMachineFacility()" size="sm" variant="secondary" :disabled="writeBlocked"
            @click="requestAction('addGrass', { facilityId: feedMachineFacility()!.id }, '补充牧草')"
          >
            补草
          </BaseButton>
          <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="goToShop('catalog')">
            牧场商店
          </BaseButton>
        </div>
      </div>

      <section v-if="page === 'personal' && ranchFacilities.length" class="space-y-3">
        <div class="px-1"><h2 class="text-base font-semibold">栏舍与动物</h2></div>
        <article v-for="facility in ranchFacilities" :key="facility.id" class="ui-card p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-3"><RanchItemImage :src="facility.image" :alt="facilityLabel(facility)" label="官方设施图标" /><h3 class="font-semibold">{{ facilityLabel(facility) }} · Lv.{{ facility.level }}</h3></div>
              <p class="mt-1 text-xs text-[var(--muted-text)]">设施 {{ facility.facilityId }} · 实例 {{ facility.id }}</p>
            </div>
            <span class="ranch-badge">{{ facility.ranch?.animalCount || 0 }}/{{ facility.ranch?.capacity || facility.capacity }}</span>
          </div>

          <div class="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div class="ranch-field"><span>牧草库存</span><b>{{ formatNumber(facility.ranch?.grass.amount) }}</b></div>
            <div class="ranch-field"><span>牧草耗尽</span><b>{{ formatTime(facility.ranch?.grass.emptyAtMs) }}</b></div>
            <div class="ranch-field"><span>货架 / 异常</span><b>{{ facility.ranch?.shelfCount || 0 }} / {{ facility.ranch?.hazardCount || 0 }}</b></div>
          </div>

          <div v-if="hasReadyUpgrade(facility)" class="mt-2">
            <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('completeUpgrade', { facilityId: facility.id }, '完成设施升级')">
              完成升级
            </BaseButton>
          </div>
          <div v-else-if="canQuoteUpgrade(facility)" class="mt-2 flex flex-wrap items-center gap-2">
            <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('upgrade', { facilityId: facility.id }, '升级设施')">查看价格</BaseButton>
            <span class="text-xs text-[var(--muted-text)]">目标 Lv.{{ facility.nextUpgrade?.level }} · 容量 {{ facility.nextUpgrade?.capacity }} · 需牧场 Lv.{{ facility.nextUpgrade?.requiredLevel }}</span>
          </div>

          <div v-if="facility.ranch?.animals.length" class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="animal in facility.ranch.animals" :key="`${facility.id}-${animal.instanceId}`" class="ui-subtle-panel rounded-lg p-3">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <div class="flex items-center gap-2"><RanchItemImage :src="animal.image" :alt="animal.name" :label="animal.imageRole" /><strong>{{ animal.name }}</strong></div>
                  <p class="mt-1 text-xs text-[var(--muted-text)]">槽位 {{ animal.slot }} · 实例 {{ animal.instanceId }}</p>
                </div>
                <span class="ranch-status" :data-alert="animal.grassBlocked || animal.canHarvest">{{ animalState(animal) }}</span>
              </div>
              <p class="mt-2 text-xs text-[var(--muted-text)]">下一阶段：{{ formatTime(animal.nextAtMs) }}</p>
              <p class="mt-1 text-xs text-[var(--muted-text)]">生产 {{ animal.produceCount }} / {{ animal.maxProduceCount ?? '未确认' }} · {{ animal.limitedCanUsed ? '普通罐头本阶段已用' : '普通罐头使用标记未置位' }}</p>
              <p v-if="animal.expectedHarvest?.items.length" class="mt-1 text-xs text-[var(--muted-text)]">游戏预计收获收益：{{ animal.expectedHarvest.items.map(item => `${item.name || ranchItemLabel(item.id)} ×${formatNumber(item.count)}`).join('、') }}</p>
              <BaseButton
                v-if="animal.canRelease" size="sm" variant="text" class="mt-2"
                :disabled="writeBlocked"
                @click="requestAction('release', { ranchId: facility.ranch!.id, animalId: animal.instanceId }, `放生${animal.name}`)"
              >
                放生
              </BaseButton>
            </div>
          </div>
          <p v-else class="mt-3 text-sm text-[var(--muted-text)]">当前栏舍没有动物。</p>
          <div v-if="facility.ranch?.shelves?.length" class="mt-3 space-y-2"><div v-for="shelf in facility.ranch.shelves" :key="shelf.slot" class="ranch-field text-xs"><span>货架 {{ shelf.slot }} · {{ shelf.canCollect ? '可收集' : '不可收集' }}</span><b>{{ shelf.products.map(item => `${item.name || ranchItemLabel(item.id)} ×${formatNumber(item.count)}`).join('、') || '当前为空' }}</b></div></div>
        </article>
      </section>

      <section v-if="page === 'personal' && otherFacilities.length" class="space-y-3">
        <h2 class="px-1 text-base font-semibold">其他设施</h2>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="facility in otherFacilities" :key="facility.id" class="ui-card p-4">
            <div class="flex items-center justify-between gap-2">
              <div class="min-w-0 flex items-center gap-3"><RanchItemImage v-if="facility.image" :src="facility.image" :alt="facilityLabel(facility)" label="官方设施图标" /><span v-else :class="[facilityFallbackIcon(facility), 'text-2xl']" aria-hidden="true" /><h3 class="font-semibold">{{ facilityLabel(facility) }}</h3></div>
              <span class="text-xs text-[var(--muted-text)]">Lv.{{ facility.level }}</span>
            </div>
            <div v-if="facility.feedMachine" class="mt-3 space-y-2 text-sm">
              <div class="ranch-field"><span class="flex items-center gap-1"><span class="i-carbon-wheat text-lime-600" aria-hidden="true" />牧草</span><b>{{ formatNumber(facility.feedMachine.count) }}</b></div>
              <div class="ranch-field"><span>可维持</span><b>{{ feedMachineRemainingText(facility) }}{{ feedMachineRemainingText(facility) === '暂不可用' ? '' : ' 秒' }}</b></div>
            </div>
            <p v-else class="mt-3 text-xs text-[var(--muted-text)]">设施 {{ facility.facilityId }} · 实例 {{ facility.id }}</p>
            <BaseButton v-if="hasReadyUpgrade(facility)" size="sm" variant="secondary" class="mt-3" :disabled="writeBlocked" @click="requestAction('completeUpgrade', { facilityId: facility.id }, '完成设施升级')">完成升级</BaseButton>
            <div v-else-if="canQuoteUpgrade(facility)" class="mt-3">
              <BaseButton size="sm" variant="secondary" :disabled="writeBlocked" @click="requestAction('upgrade', { facilityId: facility.id }, '升级设施')">查看价格</BaseButton>
              <p class="mt-1 text-xs text-[var(--muted-text)]">目标 Lv.{{ facility.nextUpgrade?.level }} · 需牧场 Lv.{{ facility.nextUpgrade?.requiredLevel }}</p>
            </div>
          </article>
        </div>
      </section>

      <details v-if="page === 'personal'" class="ui-card p-4"><summary class="cursor-pointer text-sm font-semibold">地块与待放置设施</summary><div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"><div v-for="cell in overview.cells || []" :key="cell.id" class="ranch-field text-xs"><span>地块 {{ cell.id }} · ({{ cell.x }}, {{ cell.y }})</span><b>区域 {{ cell.regionId }} · 状态码 {{ cell.status }}</b></div></div><div v-if="overview.buildingItems?.length" class="mt-3 flex flex-wrap gap-3"><div v-for="building in overview.buildingItems" :key="building.id" class="flex items-center gap-2 text-xs"><RanchItemImage :src="building.image" :alt="`设施 ${building.facilityId}`" label="官方设施图标" /><span>设施 {{ building.facilityId }} · Lv.{{ building.level }} · 实例 {{ building.id }}</span></div></div></details>

      <p v-if="!overview.facilities.length" class="ui-card p-10 text-center text-sm text-[var(--muted-text)]">
        暂无牧场设施。
      </p>
    </template>

    <section v-if="currentAccountId && page === 'shop' && ranchSection === 'catalog'" class="ui-card p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div><h2 class="text-base font-semibold">幼崽与饲料</h2><p class="mt-1 text-xs text-[var(--muted-text)]">选择幼崽或饲料，查看价格后购买。</p></div>
        <BaseButton size="sm" variant="secondary" :loading="catalogLoading[catalogShopId]" @click="refresh">刷新目录</BaseButton>
      </div>
      <div class="mt-3 flex gap-2">
        <BaseButton size="sm" :variant="catalogShopId === 5 ? 'primary' : 'secondary'" @click="selectCatalog(5)">幼崽</BaseButton>
        <BaseButton size="sm" :variant="catalogShopId === 6 ? 'primary' : 'secondary'" @click="selectCatalog(6)">饲料</BaseButton>
      </div>
      <p v-if="catalogLoading[catalogShopId]" class="mt-4 text-sm text-[var(--muted-text)]">正在读取当前目录…</p>
      <div v-else-if="catalogGoods.length" class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="good in catalogGoods" :key="good.id" class="ui-subtle-panel rounded-lg p-3">
          <div class="flex items-start justify-between gap-2"><div class="min-w-0"><div class="flex items-center gap-2"><RanchItemImage :src="good.image" :alt="good.name" /><strong>{{ good.name }}</strong></div><p class="mt-1 text-xs text-[var(--muted-text)]">每份 {{ good.itemCount }}</p></div><span class="ranch-status" :data-alert="!canPurchaseCatalogGood(good)">{{ !good.available ? good.owned ? '已拥有' : !good.valid ? '商品信息未确认' : !good.unlocked ? '暂未解锁' : good.remaining === 0 ? '本轮已买完' : '暂不可购买' : !canPurchaseCatalogGood(good) ? '暂不可购买' : '可购买' }}</span></div>
          <div class="mt-3 space-y-1 text-xs text-[var(--muted-text)]"><p>价格：{{ ranchItemLabel(String(good.currencyId)) }} ×{{ formatNumber(good.unitPrice) }}</p><p>可用余额：{{ formatNumber(good.currencyBalance) }} · 剩余：{{ good.remaining === null ? '不限' : good.remaining }}</p></div>
          <p v-if="writeBlocked" class="mt-2 text-xs text-amber-700 dark:text-amber-300">服务端状态正在同步，系统已暂停可能重复的操作。</p>
          <div class="mt-3 flex flex-wrap items-center gap-2"><input v-model.number="purchaseCounts[good.id]" type="number" min="1" :max="Math.min(good.maxCount || 1, good.remaining ?? Number.MAX_SAFE_INTEGER)" class="h-9 w-20 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-1)] px-2 text-sm" :disabled="!canPurchaseCatalogGood(good) || catalogLoading[catalogShopId]"><BaseButton size="sm" :disabled="!canPurchaseCatalogGood(good) || catalogLoading[catalogShopId]" :title="canPurchaseCatalogGood(good) ? '' : catalogPurchaseBlockedReason(good)" @click="buyCatalogGood(good)">购买{{ catalogShopId === 5 ? '并放养' : '' }}</BaseButton></div>
        </article>
      </div>
      <p v-else class="ui-empty-state mt-4">当前目录暂无商品。</p>
    </section>

    <section v-if="currentAccountId && ranchSection === 'bag'" class="ui-card p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold">牧场背包与补给</h2>
          <p class="mt-1 text-xs text-[var(--muted-text)]">选择幼崽放养，或将罐头加入对应罐头桶。</p>
          <details class="mt-2 text-xs text-[var(--muted-text)]"><summary class="cursor-pointer">自动补栏规则</summary><p class="mt-2 max-w-prose leading-relaxed">自动购买默认关闭，需同时开启库存补栏。库存不足时仅用金券购买普通幼崽，单价不超过1080金券，每轮最多3只，保留10000金券；不使用钻石、点券，不购买或消耗巨大幼崽。</p></details>
        </div>
        <div class="flex gap-2">
          <BaseButton size="sm" variant="secondary" :loading="bagLoading" @click="openBag">{{ bagOpen ? '刷新背包' : '打开背包' }}</BaseButton>
          <BaseButton size="sm" variant="secondary" @click="goToShop('cans')">前往罐头商城</BaseButton>
          <BaseButton v-if="bagOpen" size="sm" variant="text" @click="bagOpen = false">收起</BaseButton>
        </div>
      </div>
      <template v-if="bagOpen">
        <p v-if="bagLoading && !bagOverview" class="mt-4 text-sm text-[var(--muted-text)]">正在读取牧场背包和可用栏舍…</p>
        <template v-else-if="bagOverview">
          <div class="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div class="ranch-field"><span>牧场等级</span><b>{{ bagOverview.level ? `Lv.${bagOverview.level.level}` : '未确认' }}</b></div>
            <div class="ranch-field"><span>普通罐头桶</span><b>{{ formatNumber(bagOverview.buckets.normal) }} 秒</b></div>
            <div class="ranch-field"><span>有机罐头桶</span><b>{{ formatNumber(bagOverview.buckets.organic) }} 秒</b></div>
          </div>
          <p class="mt-2 text-xs text-[var(--muted-text)]">{{ bagOverview.cacheHit ? '短时缓存' : '实时读取' }} · {{ formatTime(bagOverview.receivedAt) }}</p>
          <div v-if="bagOverview.items.length" class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <article v-for="item in bagOverview.items" :key="itemKey(item)" class="ui-subtle-panel rounded-lg p-3">
              <div class="flex items-start justify-between gap-2">
                <div><div class="flex items-center gap-2"><RanchItemImage :src="item.image" :alt="item.name" /><strong>{{ item.name }}</strong></div><p class="mt-1 text-xs text-[var(--muted-text)]">库存 {{ formatNumber(item.count) }} · {{ item.locked ? '已锁定' : '未锁定' }}</p></div>
                <span class="ranch-status">{{ item.category === 'cub' ? '幼崽' : item.category === 'can' ? '罐头' : item.category === 'product' ? '产物' : '物品' }}</span>
              </div>
              <p v-if="item.can" class="mt-2 text-xs text-[var(--muted-text)]">{{ item.can.family }} · 每个 {{ formatNumber(item.can.seconds) }} 秒</p>
              <p v-if="item.animal" class="mt-2 text-xs text-[var(--muted-text)]">{{ item.animal.giantCub ? '巨大幼崽' : '普通幼崽' }} · 同类可放养 {{ formatNumber(item.availableTypeCount) }}</p>
              <p v-if="item.product" class="mt-2 text-xs text-[var(--muted-text)]">原始重量码 {{ formatNumber(item.product.weightX10) }} · 档位 {{ item.product.tier }}</p>
              <template v-if="item.category === 'cub' || item.category === 'can'">
                <select
                  v-if="item.category === 'cub'" :value="penChoice(item)?.id || ''"
                  class="mt-3 h-9 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface-1)] px-2 text-sm"
                  :disabled="writeBlocked || !compatiblePens(item).length"
                  @change="placeChoices[itemKey(item)] = ($event.target as HTMLSelectElement).value"
                >
                  <option v-if="!compatiblePens(item).length" value="">无适合栏舍或空位</option>
                  <option v-for="pen in compatiblePens(item)" :key="pen.id" :value="pen.id">{{ pen.name }} {{ pen.id }} · 空位 {{ pen.room }}</option>
                </select>
                <div class="mt-3 flex items-center gap-2">
                  <input v-model.number="bagCounts[itemKey(item)]" type="number" min="1" :max="bagQuantityLimit(item)" placeholder="1"
                    class="h-9 w-20 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-1)] px-2 text-sm"
                    :disabled="writeBlocked || bagQuantityLimit(item) <= 0 || item.locked">
                  <BaseButton size="sm" variant="secondary" :disabled="writeBlocked || selectedBagQuantity(item) <= 0 || (item.category === 'can' ? !item.canUseCan : !item.canPlace)" @click="useBagItem(item)">
                    {{ item.category === 'can' ? '添加入桶' : '放养' }}
                  </BaseButton>
                </div>
              </template>
            </article>
          </div>
          <p v-else class="mt-4 text-sm text-[var(--muted-text)]">已读取牧场背包，目前没有实体物品。</p>
        </template>
      </template>
    </section>

    <section v-if="currentAccountId && page === 'shop' && ranchSection === 'cans'" class="ui-card p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div><h2 class="text-base font-semibold">罐头商城</h2><p class="mt-1 text-xs text-[var(--muted-text)]">查看价格和奖励，按提示购买。</p></div>
        <BaseButton size="sm" variant="secondary" :loading="canLoading[canSlotType]" @click="refresh">刷新罐头</BaseButton>
      </div>
      <div class="mt-3 flex gap-2">
        <BaseButton size="sm" :variant="canSlotType === 6 ? 'primary' : 'secondary'" @click="openCanShop(6)">专区一</BaseButton>
        <BaseButton size="sm" :variant="canSlotType === 7 ? 'primary' : 'secondary'" @click="openCanShop(7)">专区二</BaseButton>
      </div>
      <p v-if="canLoading[canSlotType]" class="mt-4 text-sm text-[var(--muted-text)]">正在读取当前罐头商品…</p>
      <div v-else-if="currentCanGoods.length" class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="good in currentCanGoods" :key="good.id" class="ui-subtle-panel rounded-lg p-3">
          <div class="flex items-start justify-between gap-2"><strong>{{ good.name }}</strong><span class="ranch-status">{{ good.available ? '可购买' : good.remaining === 0 ? '本轮已买完' : '暂不可购买' }}</span></div>
          <p class="mt-2 text-sm">{{ good.free ? '免费' : `${ranchItemLabel(String(good.currencyId))} ×${formatNumber(good.unitPrice)}` }} / 份</p>
          <p class="mt-1 text-xs text-[var(--muted-text)]">奖励：{{ good.rewards.map(item => `${item.name || ranchItemLabel(item.id)} ×${formatNumber(item.count)}`).join('、') }}</p>
          <p class="mt-1 text-xs text-[var(--muted-text)]">余额：{{ good.free ? '无需消耗' : formatNumber(good.currencyBalance) }} · 剩余限购：{{ good.remaining === null ? '不限' : good.remaining }}</p>
          <p v-if="good.stateReason" class="mt-1 text-xs text-[var(--muted-text)]">{{ good.stateReason }}</p>
          <p v-if="writeBlocked" class="mt-2 text-xs text-amber-700 dark:text-amber-300">服务端状态正在同步，系统已暂停可能重复的操作。</p>
          <div class="mt-3 flex items-center gap-2">
            <input v-model.number="canPurchaseCounts[good.id]" type="number" min="1" :max="good.maxCount" placeholder="1"
              class="h-9 w-20 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-1)] px-2 text-sm" :disabled="writeBlocked || !good.available">
            <BaseButton size="sm" variant="secondary" :disabled="writeBlocked || !good.available" :title="writeBlocked ? operationsError || '服务端状态正在同步，系统已暂停可能重复的操作' : !good.available ? good.stateReason || '暂不可购买' : ''" @click="buyCanGood(good)">{{ good.free ? '领取' : '购买' }}</BaseButton>
          </div>
        </article>
      </div>
      <p v-else class="mt-4 text-sm text-[var(--muted-text)]">当前入口没有已核实类型的罐头商品。</p>
    </section>

    <RanchProgressPanel v-if="currentAccountId && isProgressSection" :key="ranchSection" :section="ranchSection as RanchCoreProgressSection" @request="requestAction" @refresh="refresh" />

    <RanchMarketPanel v-if="currentAccountId && isCommerceSection" :key="ranchSection" :section="ranchSection as 'market' | 'activities'" :account-id="currentAccountId" :read-only-reason="activityReadOnlyReason" :automatic-claim-enabled="ranchMugeAutoClaimEnabled" :automatic-claim-summary="ranchMugeAutoClaimSummary" @request="requestAction" @refresh="refresh" />

    <section v-if="currentAccountId && ranchSection === 'friends'" class="ui-card p-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="flex items-center gap-2 text-lg font-medium"><span class="i-carbon-user-multiple" aria-hidden="true" />好友列表 <span class="text-sm font-normal text-[var(--muted-text)]">{{ friends.length }} 位</span></h2>
        <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <BaseInput v-model="friendSearch" placeholder="搜索昵称或 GID" aria-label="搜索牧场好友" clearable class="w-full sm:w-56" />
          <BaseButton size="sm" variant="secondary" :loading="friendsLoading" :disabled="LOCAL_UI_READONLY || operating" @click="refreshRanchFriends">
            <span class="i-carbon-renew" aria-hidden="true" />刷新列表
          </BaseButton>
        </div>
      </div>
      <p class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted-text)]">
        <span>这里是牧场好友名册，不含最近访客；游戏未提供可核验的牧场访客列表。</span>
        <RouterLink to="/friends" class="shrink-0 text-[var(--theme-primary)] hover:underline">农场好友页查看访客</RouterLink>
      </p>

      <div v-if="friendsLoading && !friends.length" class="mt-4 space-y-3" aria-label="正在读取好友列表" aria-busy="true">
        <div v-for="index in 3" :key="index" class="ui-subtle-panel h-20 animate-pulse rounded-lg" />
      </div>
      <ul v-else-if="filteredRanchFriends.length" class="mt-4 space-y-3" aria-label="牧场好友列表">
        <li v-for="friend in filteredRanchFriends" :key="friend.gid" class="ui-card overflow-hidden rounded-lg">
          <button type="button" class="ranch-friend-row w-full flex items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[-2px]"
            :class="selectedFriendGid === Number(friend.gid) ? 'bg-[var(--surface-2)]' : ''" :disabled="operating"
            :aria-expanded="selectedFriendGid === Number(friend.gid)" :aria-controls="selectedFriendGid === Number(friend.gid) ? `${sectionId}-friend-${friend.gid}` : undefined" @click="selectRanchFriend(Number(friend.gid))">
            <span class="min-w-0 flex items-center gap-3">
              <span class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-2)] ring-1 ring-[var(--surface-border)]">
                <img v-if="friend.avatarUrl && !friendAvatarErrors.has(Number(friend.gid))" :src="friend.avatarUrl" alt="" class="h-full w-full object-cover" loading="lazy" referrerpolicy="no-referrer" @error="friendAvatarErrors.add(Number(friend.gid))">
                <span v-else class="i-carbon-user text-lg text-[var(--muted-text)]" aria-hidden="true" />
              </span>
              <span class="min-w-0"><strong class="block break-words text-sm font-semibold">{{ friend.name || '未命名好友' }}</strong><span class="mt-1 block text-xs text-[var(--muted-text)]">GID {{ friend.gid }}</span></span>
            </span>
            <span class="shrink-0 flex items-center gap-1 text-xs text-[var(--theme-primary)]"><span>{{ selectedFriendGid === Number(friend.gid) && friendLoading ? '读取中…' : selectedFriendGid === Number(friend.gid) ? '收起' : '查看牧场' }}</span><span :class="selectedFriendGid === Number(friend.gid) ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'" aria-hidden="true" /></span>
          </button>
          <div v-if="selectedFriendGid === Number(friend.gid)" :id="`${sectionId}-friend-${friend.gid}`" class="border-t border-[var(--surface-border)] p-4">
      <p v-if="friendLoading && !friendOverview" class="mt-4 text-sm text-[var(--muted-text)]">正在读取好友牧场…</p>
      <p v-else-if="!friendOverview" class="mt-4 text-sm text-[var(--muted-text)]">
        —
      </p>

      <template v-else>
        <div class="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="font-semibold">{{ friendOverview.name }} · 牧场 Lv.{{ friendOverview.level }}</h3>
            <p class="mt-1 text-xs text-[var(--muted-text)]">
              更新于 {{ formatTime(friendOverview.observedAt) }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <BaseButton
              size="sm" variant="secondary" :disabled="writeBlocked || !friendOverview.summary.stealableShelfCount"
              @click="requestAction('steal', { hostGid: Number(friendOverview.gid) }, '偷取好友牧场产物')"
            >
              偷取货架（{{ friendOverview.summary.stealableShelfCount }}）
            </BaseButton>
            <BaseButton
              size="sm" variant="secondary" :disabled="writeBlocked || !friendOverview.summary.cleanableHazardCount"
              @click="requestAction('cleanFriend', { hostGid: Number(friendOverview.gid) }, '清理好友牧场')"
            >
              清理异常（{{ friendOverview.summary.cleanableHazardCount }}）
            </BaseButton>
          </div>
        </div>

        <div class="mt-3 grid gap-2 text-sm sm:grid-cols-3 xl:grid-cols-6">
          <div class="ranch-field"><span>栏舍</span><b>{{ friendOverview.summary.ranchCount }}</b></div>
          <div class="ranch-field"><span>动物</span><b>{{ friendOverview.summary.animalCount }}</b></div>
          <div class="ranch-field"><span>可抚摸</span><b>{{ friendOverview.summary.strokableCount }}</b></div>
          <div class="ranch-field"><span>抚摸余次</span><b>{{ friendOverview.remaining.stroke }}</b></div>
          <div class="ranch-field"><span>蚊子空位</span><b>{{ friendOverview.summary.mosquitoRoom }}</b></div>
          <div class="ranch-field"><span>放蚊余次</span><b>{{ friendOverview.remaining.putMosquito }}</b></div>
        </div>

        <div v-if="friendOverview.ranches.length" class="mt-3 grid gap-3 lg:grid-cols-2">
          <article v-for="pen in friendOverview.ranches" :key="pen.id" class="ui-subtle-panel rounded-lg p-3">
            <div class="flex items-start justify-between gap-2">
              <div>
                <strong>{{ pen.name }}</strong>
                <p class="mt-1 text-xs text-[var(--muted-text)]">动物 {{ pen.animalCount }}/{{ pen.capacity }}</p>
              </div>
              <BaseButton
                size="sm" variant="text" :disabled="writeBlocked || !pen.canPutMosquito"
                @click="requestAction('putMosquito', { hostGid: Number(friendOverview.gid), ranchId: pen.id }, `向好友${pen.name}放蚊子`)"
              >
                放蚊 {{ pen.mosquitoes }}/{{ pen.mosquitoLimit }}
              </BaseButton>
            </div>
            <div v-if="pen.animals.length" class="mt-3 space-y-2">
              <div v-for="animal in pen.animals" :key="animal.instanceId" class="ranch-field">
                <span>{{ animal.name }} · 阶段 {{ animal.stage }}</span>
                <BaseButton
                  size="sm" variant="text" :disabled="writeBlocked || !animal.canStroke"
                  @click="requestAction('stroke', { hostGid: Number(friendOverview.gid), ranchId: pen.id, animalId: animal.instanceId }, `抚摸${animal.name}`)"
                >
                  {{ animal.stroked ? '已抚摸' : '抚摸' }}
                </BaseButton>
              </div>
            </div>
            <div v-if="pen.shelves.length" class="mt-3 space-y-1 text-xs text-[var(--muted-text)]">
              <p v-for="shelf in pen.shelves" :key="shelf.slot">
                货架 {{ shelf.slot }}：{{ shelf.products.length ? shelf.products.map(item => `${ranchItemLabel(item.id)} ×${formatNumber(item.count)}`).join('、') : '空' }}
                <span v-if="shelf.canSteal" class="text-[var(--theme-primary)]"> · 可偷取</span>
              </p>
            </div>
          </article>
        </div>
        <p v-else class="mt-4 text-sm text-[var(--muted-text)]">暂无栏舍</p>
      </template>
          </div>
        </li>
      </ul>
      <div v-else-if="!friendsError" class="ui-empty-state mt-4 p-8 text-center text-sm text-[var(--muted-text)]">{{ friendSearch.trim() ? '没有找到匹配的好友' : '暂无牧场好友' }}</div>
    </section>

    </div>

    <div v-if="confirmOpen" class="ranch-confirm-mask" @click.self="closeConfirm">
      <div class="ranch-confirm" role="dialog" aria-modal="true" :aria-label="confirmTitle">
        <h3 class="text-base font-semibold">{{ confirmTitle }}</h3>
        <div v-if="confirmLoading && !confirmQuote" class="mt-4 flex items-center gap-2 text-sm text-[var(--muted-text)]">
          <span class="i-svg-spinners-ring-resize animate-spin" aria-hidden="true" />
          正在检查价格和条件…
        </div>
        <template v-else-if="confirmQuote">
          <p class="mt-2 text-sm">{{ confirmQuote.label }}</p>
          <div class="mt-3 grid gap-2 text-sm">
            <div class="ranch-field"><span>数量</span><b>{{ confirmQuote.count }}</b></div>
            <div class="ranch-field">
              <span>消耗</span>
              <b>{{ confirmQuote.costs.length ? confirmQuote.costs.map(item => `${item.name || ranchItemLabel(item.id)} ×${formatNumber(item.count)}${item.unit || ''}`).join('、') : '无' }}</b>
            </div>
            <div class="ranch-field">
              <span>预期奖励</span>
              <b>{{ confirmQuote.rewards.length ? confirmQuote.rewards.map(item => `${item.name || ranchItemLabel(item.id)} ×${formatNumber(item.count)}${item.unit || ''}`).join('、') : '以回包为准' }}</b>
            </div>
          </div>
          <p v-if="confirmQuote.message" class="mt-3 text-sm text-[var(--muted-text)]">{{ confirmQuote.message }}</p>
          <p class="mt-3 text-xs text-[var(--muted-text)]">
            请核对数量和费用；系统会读取服务端状态并避免重复提交。
          </p>
        </template>
        <div class="mt-4 flex justify-end gap-2">
          <BaseButton variant="ghost" :disabled="operating" @click="closeConfirm">取消</BaseButton>
          <BaseButton
            variant="primary" :loading="confirmLoading"
            :disabled="writeBlocked || !confirmQuote || confirmQuote.skipped || confirmQuote.pendingBlocked"
            @click="runConfirmed"
          >
            {{ confirmPrimaryLabel }}
          </BaseButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ranch-page { color: var(--theme-text); }
.ranch-content { min-width: 0; transform-origin: 50% 30%; }
.ranch-tabs { flex: none; }
@media (max-width: 820px) {
  .ranch-tabs { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; scroll-padding-inline: 8px; }
  .ranch-tabs :deep(.ui-tab) { flex: none; white-space: nowrap; }
}
.ranch-badge { display: inline-flex; min-height: 26px; align-items: center; border: 1px solid color-mix(in srgb, var(--theme-primary, #416d3b) 22%, transparent); border-radius: 999px; padding: 0 10px; color: var(--theme-primary, #416d3b); background: color-mix(in srgb, var(--theme-primary, #416d3b) 9%, transparent); font-size: 12px; }
.ranch-stat { display: flex; min-height: 112px; flex-direction: column; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
@media (max-width: 639px) { .ranch-metrics .ranch-stat:last-child { grid-column: 1 / -1; } }
.ranch-stat span { color: var(--muted-text); font-size: 12px; }
.ranch-stat strong { color: var(--theme-text); font-size: 24px; font-weight: 700; }
.ranch-level-badge { flex: none; border-radius: 999px; padding: 3px 10px; color: #2563eb; background: #dbeafe; font-size: 12px; line-height: 1.5; }
.ranch-level-track { height: 8px; overflow: hidden; border-radius: 999px; background: var(--surface-2, #f3f4f6); }
.ranch-level-track > span { display: block; height: 100%; border-radius: inherit; background: #3b82f6; transition: width 240ms ease; }
.ranch-field { display: flex; min-height: 38px; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--surface-border); border-radius: var(--radius-card); padding: 8px 10px; background: var(--surface-2); }
.ranch-field span { color: var(--muted-text); }
.ranch-field b { font-weight: 600; text-align: right; }
.ranch-status { flex: none; border-radius: 999px; padding: 3px 8px; color: var(--theme-primary, #416d3b); background: color-mix(in srgb, var(--theme-primary, #416d3b) 10%, transparent); font-size: 11px; }
.ranch-status[data-alert='true'] { color: var(--status-warning); background: color-mix(in srgb, #f59e0b 14%, transparent); }
.ranch-confirm-mask { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / 35%); padding: 16px; }
.ranch-confirm { width: 100%; max-width: 420px; border: 1px solid var(--surface-border, #e7e1d3); border-radius: var(--radius-card, 12px); background: var(--surface-1, #fcfbf6); padding: 18px; box-shadow: var(--shadow-card, 0 8px 24px rgb(0 0 0 / 12%)); }
</style>
