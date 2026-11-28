<script setup lang="ts">
import type { ActivityLabels, ActivitySection, ActivitySectionKey } from '@/components/activity/types'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onScopeDispose, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute } from 'vue-router'
import HeluExchangePanel from '@/components/activity/HeluExchangePanel.vue'
import HeluPassportPanel from '@/components/activity/HeluPassportPanel.vue'
import SolarCalendar from '@/views/SolarCalendar.vue'
import QingmeiActivityPanel from '@/components/activity/QingmeiActivityPanel.vue'
import RedFlowerActivityPanel from '@/components/activity/RedFlowerActivityPanel.vue'
import QixiActivityPanel from '@/components/activity/QixiActivityPanel.vue'
import RainPoemActivityPanel from '@/components/activity/RainPoemActivityPanel.vue'
import StarRecordPanel from '@/components/activity/StarRecordPanel.vue'
import PetDiaryActivityPanel from '@/components/activity/PetDiaryActivityPanel.vue'
import WishSignActivityPanel from '@/components/activity/WishSignActivityPanel.vue'
import ShareRewardActivityPanel from '@/components/activity/ShareRewardActivityPanel.vue'
import MilkTeaActivityPanel from '@/components/activity/MilkTeaActivityPanel.vue'
import { milkTeaOverview } from '@/utils/activity-overview'
import { accountDataEmptyState, LOCAL_UI_READONLY } from '@/config/localReadonly'
import { useSettingStore } from '@/stores/setting'
import AdminActivityUpdatePanel from '@/components/admin/AdminActivityUpdatePanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useSlidingTabs, vSlidingTabs } from '@/composables/useContentMotion'
import { useActivityStore } from '@/stores/activity'
import { isActivityHidden } from '@/config/activityVisibility'
import { formatActivityDeadline } from '@/constants/activity-windows'
import { SOLAR_TERM_ASSETS, solarTermIllustration, solarTermName, solarTermStatusLabel } from '@/config/solarTerms'
import { useActivityDiscoveryStore } from '@/stores/activityDiscovery'
import AutoActivityPanel from '@/components/activity/AutoActivityPanel.vue'
import api, { isReadCanceled } from '@/api'

const discovery = useActivityDiscoveryStore()
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const L: ActivityLabels = {
  title: '活动中心',
  currentAccount: '当前账号',
  none: '未选择',
  needAccount: '请先选择账号，再查看活动数据。',
  refresh: '刷新',
  loading: '正在加载活动数据...',
  empty: '暂无数据',
  warningTitle: '活动提示',
  heluTitle: '心许千灯星垂野',
  giftLotusTab: '观星礼录',
  shopTab: '星砂兑换商店',
  journeyTab: '千星游记',
  notesTab: '节令小礼',
  pool: '奖池',
  recent: '最近结果',
  freeRemain: '免费剩余',
  paidRemain: '点券剩余',
  dailyUsed: '今日已用',
  dailyRemain: '今日剩余',
  helu: '星砂',
  heluBalance: '星砂余额',
  exchangeGoods: '兑换奖励',
  drawOne: '点亮',
  drawBatch: '一键点亮',
  drawDone: '点亮完成',
  batchDone: '点亮完成',
  drawFail: '点亮失败',
  exchangeDone: '兑换成功：',
  exchangeFail: '兑换失败',
  canExchange: '立即兑换',
  unavailable: '暂不可用',
  owned: '已拥有',
  noHelu: '星砂不足',
  unsupportedCurrency: '暂不支持该货币',
  priceLabel: '价格',
  stateLabel: '状态',
  drawCostLabel: '操作说明',
  freeDraw: '免费',
  paidDraw: '消耗',
  recentCost: '本次消耗',
  rewardPoolCount: '星宿奖励',
  exchangeCount: '兑换奖励',
  typeFallback: '活动奖励',
  gold: '金币',
  coupon: '点券',
  activityCurrency: '星砂',
  defaultHeluTitle: '心许千灯星垂野',
  decorationLabel: '装扮',
  subActivityUnavailable: '暂未读取到活动数据。',
  activityStatus: '活动状态',
}

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const toast = useToastStore()
const userStore = useUserStore()
const { currentAccountId } = storeToRefs(accountStore)
const { settingsAccountId, confirmedAutomation } = storeToRefs(useSettingStore())
const automationSnapshot = computed(() => settingsAccountId.value === String(currentAccountId.value) ? confirmedAutomation.value : null)
const accountEmptyState = computed(() => accountDataEmptyState(LOCAL_UI_READONLY, currentAccountId.value))
const {
  heluActivity: activity,
  heluLoading,
  passportClaimLoading,
  starRecordClaimLoading,
  qingmeiClaimLoading,
  qingmeiSellLoading,
  exchangeLoading,
  heluError,
  qixiActivity,
  qixiFriends,
  qixiLoading,
  qixiBuildLoading,
  qixiGiftLoading,
  qixiDewLoading,
  rainPoemActivity,
  rainPoemLoading,
  redFlowerActivity,
  redFlowerLoading,
  redFlowerLoveLoading,
  redFlowerFundLoading,
  redFlowerShareLoading,
  redFlowerTiersLoading,
  wishSignActivity,
  wishSignLoading,
  wishSignOperateLoading,
  shareRewardActivity,
  shareRewardLoading,
  shareRewardOperateLoading,
  milkTeaPages,
  milkTeaLoading,
  milkTeaOperateLoading,
} = storeToRefs(activityStore)

// 奶茶热销中（S4）：面板内二级页签，按页缓存
const milkTeaPage = ref('shop')
const milkTeaActivity = computed(() => milkTeaPages.value[milkTeaPage.value] || null)
const nowMs = ref(Date.now())
const milkTeaProgressUncertain = ref(false)
// Derive from the current already-read page only. No extra pre-reads or
// merging old subpage snapshots into a newer summary.
const milkTeaTodo = computed(() => milkTeaOverview(milkTeaActivity.value, automationSnapshot.value,
  milkTeaProgressUncertain.value || milkTeaLoading.value || milkTeaOperateLoading.value, Math.floor(nowMs.value / 1000)))
const milkTeaSchedule = computed(() => {
  // 子页共享同一服务端活动头；切页加载时保留已确认时间，不能拿星砂/旧活动字段兜底。
  const state = milkTeaActivity.value || Object.values(milkTeaPages.value).find(page => page.endTime > 0)
  return { businessEnd: formatActivityDeadline(state?.settleStartTime), rewardEnd: formatActivityDeadline(state?.endTime) }
})

let nowTimer: ReturnType<typeof window.setInterval> | null = null
// ⚠️ 活动「是否在期」统一由 isActivityHidden（内部走 activity-windows.ts 时间窗）判定，
// 此处不再各自硬编码窗口常量，避免与 core/src/models/store.js 口径分叉。
const rainPoemActivityActive = computed(() => !isActivityHidden('rain-poem'))
const redFlowerActivityActive = computed(() => !isActivityHidden('honghua'))
const gameBulletinPic = ref('')
const bulletinLoading = ref(false)
const isSolarSection = computed(() => activeSection.value === 'notes')
const showStarTheme = computed(() => ['journey', 'records', 'shop'].includes(activeSection.value))
const solarHeaderTerm = computed(() => solarSummary.value.current
  ? { ...solarSummary.value.current, status: 0, startTime: 0, endTime: 0, rewards: [], claimable: false }
  : null)
const solarHeaderLabel = computed(() => solarSummary.value.current?.statusLabel || (solarHeaderTerm.value ? solarTermStatusLabel(solarHeaderTerm.value) : ''))
const solarHeaderIllustration = computed(() => solarTermIllustration(solarHeaderTerm.value))
const headerBgSrc = computed(() => {
  if (isSolarSection.value) return SOLAR_TERM_ASSETS.background
  // 公益小红花：游戏公告图本身就是该活动的主题头图，必须使用，
  // 否则切换到本活动时头图会空（深色背景），体验割裂。
  // 注意：雨落成诗 / 鹊桥各自有专属背景图，不能被公告图覆盖。
  if (activeSection.value === 'honghua') return gameBulletinPic.value || ''
  if (activeSection.value === 'rain-poem') return '/activity/rain-poem/day-rain-bg.jpg'
  if (activeSection.value === 'qixi') return '/activity/qixi/event-banner.png'
  // 萌宠成长日记：用上游本活动的草地场景作主题横幅（替换已下线的千星游记星空图）。
  if (activeSection.value === 'pet-diary') return '/activity/pet-diary/img_s3Open_bg.png'
  // 秋祈良愿（中秋祈愿）/ 快乐不独享（分享奖励）：上游没有各自的主题 banner 图，
  // 沿用本地「无横幅、纯渐变背景 + 文字标题」的展示方式（与 rain-poem/honghua 一致），
  // 不强行套用，避免头图为空造成体验割裂。
  if (activeSection.value === 'wish-sign') return ''
  if (activeSection.value === 'share-reward') return ''
  // 奶茶热销中（S4）：上游没有独立主题 banner，沿用纯渐变 + 文字标题的展示方式。
  if (activeSection.value === 'milk-tea') return ''
  // 默认（主活动·星许千灯）：用其专属主题图，避免与小红花公告图串台
  return '/activity/star-festival/star-sky.png'
})

const activeSection = ref<ActivitySectionKey | ''>('milk-tea')
const route = useRoute()
const solarPanel = ref<{ refresh: () => Promise<void> } | null>(null)
interface SolarSummary { accountId: string, claimable: number, loading: boolean, current?: { id: number, title: string, statusLabel: string } }
const solarSummary = ref<SolarSummary>({ accountId: '', claimable: 0, loading: false })
function updateSolarSummary(value: SolarSummary) {
  if (value.accountId === String(currentAccountId.value)) solarSummary.value = value
}
watch(() => route.query.section, (value) => {
  if (value === 'notes') activeSection.value = 'notes'
}, { immediate: true })
const showActivityAnalysis = ref(false)
const activityPanelId = useId()
const activityTabNav = ref<HTMLElement | null>(null)
const activityHeading = computed(() => {
  if (activeSection.value === 'milk-tea') return milkTeaActivity.value?.title || '奶茶热销中'
  if (isSolarSection.value) return '节令小礼'
  return sections.value.find(section => section.key === activeSection.value)?.label || '活动一览'
})
const refreshingActivity = computed(() => isSolarSection.value ? solarSummary.value.loading
  : heluLoading.value || qixiLoading.value || rainPoemLoading.value || redFlowerLoading.value
    || wishSignLoading.value || shareRewardLoading.value || milkTeaLoading.value)
function moveActivityTabFocus(event: KeyboardEvent, index: number) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const length = sections.value.length
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + length) % length
  activityTabNav.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

const sections = computed<ActivitySection[]>(() => ([
  // 主活动优先，进入页面先展示奶茶；高度自动化的节令小礼放到列表最后。
  { key: 'milk-tea' as const, label: '奶茶热销中', icon: 'i-carbon-cafe', count: milkTeaActivity.value?.summary?.hasUnclaimedWage ? 1 : 0 },
  { key: 'qixi' as const, label: '鹊桥寄情', icon: 'i-carbon-favorite', count: qixiActivity.value?.gift.remainingCount || 0 },
  { key: 'journey' as const, label: '千星游记', icon: 'i-carbon-map', count: activity.value?.passport?.claimableLevels || 0 },
  { key: 'records' as const, label: '观星礼录', icon: 'i-carbon-star', count: activity.value?.starRecord?.claimableCount || 0 },
  { key: 'shop' as const, label: '星砂兑换商店', icon: 'i-carbon-store', count: activity.value?.exchangeShop?.length || 0 },
  { key: 'qingmei' as const, label: '青酿换万金', icon: 'i-carbon-fruit-bowl', count: activity.value?.qingmei?.claimable ? 1 : 0 },
  // 新活动统一放在列表末尾，避免与「星许千灯」主活动主题在视觉上叠压。
  ...(rainPoemActivityActive.value ? [{ key: 'rain-poem' as const, label: '雨落成诗', icon: 'i-carbon-rain-heavy', count: rainPoemActivity.value?.items?.badges || 0 }] : []),
  ...(redFlowerActivityActive.value ? [{ key: 'honghua' as const, label: '公益小红花', icon: 'i-carbon-favorite', count: redFlowerActivity.value?.progress?.loveValue || 0 }] : []),
  // 萌宠成长日记：常规活动 tab（受 HIDDEN_ACTIVITIES 控制，活动结束后随 key 隐藏）。
  // 未来有新活动上线时，通过 header 的 tab 切换按钮在「萌宠日记」与新活动之间切换。
  { key: 'pet-diary' as const, label: '萌宠日记', icon: 'i-carbon-dog-walker', count: 0 },
  // 秋祈良愿（中秋祈愿）/ 快乐不独享（分享奖励）：9/24 新上线的常规活动 tab。
  // 二者均已进 HIDDEN_ACTIVITIES（活动已结束），下架状态由 .filter(isActivityHidden) 统一收口；
  // 返厂时从 HIDDEN_ACTIVITIES 移除对应 key 即自动恢复展示。
  { key: 'wish-sign' as const, label: '秋祈良愿', icon: 'i-carbon-moon', count: wishSignActivity.value?.remainingCount || 0 },
  { key: 'share-reward' as const, label: '快乐不独享', icon: 'i-carbon-favorite-filled', count: shareRewardActivity.value?.milestones?.some(m => m.state === 2) ? shareRewardActivity.value.milestones.filter(m => m.state === 2).length : 0 },
  { key: 'notes' as const, label: '节令小礼', icon: 'i-carbon-notebook', count: solarSummary.value.accountId === String(currentAccountId.value) ? solarSummary.value.claimable : 0 },
]).filter(section => !isActivityHidden(section.key)))

let disposed = false
let pageEpoch = 0
let readController = new AbortController()
const scopeController = new AbortController()
let pageFlight: { key: string, promise: Promise<void> } | undefined
let queued: Promise<void> | undefined
let dirty = false
let bulletinOnce: Promise<void> | undefined
onScopeDispose(() => {
  disposed = true
  pageEpoch++
  dirty = false
  readController.abort()
  scopeController.abort()
})
function fetchGameBulletinBanner() {
  if (!bulletinOnce) bulletinOnce = readGameBulletinBanner()
  return bulletinOnce
}
async function readGameBulletinBanner() {
  try {
    bulletinLoading.value = true
    const res = await api.get('/api/announcement/game', { signal: scopeController.signal })
    if (disposed) return
    if (res.data?.ok && res.data?.data?.bulletins?.length) {
      gameBulletinPic.value = res.data.data.bulletins[0].pic || ''
    }
    else {
      gameBulletinPic.value = ''
    }
  }
  catch {
    if (!disposed) gameBulletinPic.value = ''
  }
  finally {
    if (!disposed) bulletinLoading.value = false
  }
}

function refreshAll(): Promise<void> {
  const id = String(currentAccountId.value || '')
  const section = activeSection.value
  const key = `${id}:${pageEpoch}:${section}:${milkTeaPage.value}`
  if (disposed || !id || !section || isActivityHidden(section)) return Promise.resolve()
  // The unified solar child owns its single read, quiz and reward flow. Never
  // fetch the retired Helu tree as another copy of the same calendar.
  if (section === 'notes') return solarPanel.value?.refresh() || Promise.resolve()
  if (pageFlight?.key === key) return pageFlight.promise
  if (pageFlight) return queueRefresh()
  const signal = readController.signal
  const page = milkTeaPage.value
  activityStore.setReadSignal(signal)
  const flight = { key, promise: (async () => {
    try {
      if (signal.aborted || disposed) return
      if (['journey', 'records', 'shop', 'qingmei'].includes(section)) await activityStore.fetchHeluActivity(id, signal)
      else if (section === 'qixi') await activityStore.fetchQixiActivity(id, signal)
      else if (section === 'rain-poem') await activityStore.fetchRainPoemActivity(id, signal)
      else if (section === 'honghua') await activityStore.fetchRedFlowerActivity(id, signal)
      else if (section === 'wish-sign') await activityStore.fetchWishSignActivity(id, signal)
      else if (section === 'share-reward') await activityStore.fetchShareRewardActivity(id, signal)
      else if (section === 'milk-tea') {
        const result = await activityStore.fetchMilkTeaActivity(id, page, {}, signal)
        if (result?.ok && !disposed && !signal.aborted && id === String(currentAccountId.value)) milkTeaProgressUncertain.value = false
      }
      // 萌宠日记由子组件自行读取。
    }
    catch (error: any) {
      if (!disposed && !signal.aborted && key === `${currentAccountId.value}:${pageEpoch}:${activeSection.value}:${milkTeaPage.value}` && !isReadCanceled(error)) toast.error(error?.message || '活动加载失败')
    }
  })().finally(() => {
    if (pageFlight === flight) pageFlight = undefined
  }) }
  pageFlight = flight
  return flight.promise
}
function queueRefresh(): Promise<void> {
  if (disposed) return Promise.resolve()
  const key = `${currentAccountId.value}:${pageEpoch}:${activeSection.value}:${milkTeaPage.value}`
  if (pageFlight?.key === key) {
    dirty = false
    return pageFlight.promise
  }
  dirty = true
  if (!queued) {
    const previous = pageFlight?.promise
    queued = Promise.resolve().then(async () => {
      await previous
      queued = undefined
      if (!disposed && dirty) {
        dirty = false
        if (readController.signal.aborted) readController = new AbortController()
        await refreshAll()
      }
    }).catch(() => { queued = undefined })
  }
  return queued
}

function handleRainPoemWindowChange() {
  if (!rainPoemActivityActive.value)
    return
  refreshAll()
}

watch(rainPoemActivityActive, handleRainPoemWindowChange)
watch(redFlowerActivityActive, () => {
  if (redFlowerActivityActive.value)
    refreshAll()
})

async function runOperation(run: (id: string) => Promise<any>, success: (result: any) => string, failure: string) {
  const id = String(currentAccountId.value || '')
  const epoch = pageEpoch
  if (!id || disposed) return
  const current = () => !disposed && epoch === pageEpoch && id === String(currentAccountId.value)
  try {
    const result = await run(id)
    if (!current() || result?.canceled || result?.stale) return
    if (result?.ok) toast.success(success(result))
    else toast.error(result?.error || result?.message || failure)
  }
  catch (error: any) {
    if (current() && !isReadCanceled(error)) toast.error(error?.response?.data?.error || error?.message || failure)
  }
}
const buildQixi = () => runOperation(id => activityStore.buildQixiBridge(id), r => r.completed ? '鹊桥已全部完成' : '驻建鹊桥成功', '驻建鹊桥失败')
const useQixiDew = () => runOperation(id => activityStore.useQixiDew(id), r => r.usedCount ? `已使用 ${r.usedCount} 个鹊羽灵露` : r.reason === 'daily_limit' ? '今日使用次数已达上限' : '暂无符合条件的土地', '使用鹊羽灵露失败')
const giftQixi = (friendGid: number, count: number) => runOperation(id => activityStore.sendQixiSachet(id, friendGid, count), r => `已赠送 ${r.sentCount || count} 个鹊羽香囊`, '香囊赠送失败')
const claimRecords = () => runOperation(id => activityStore.claimStarRecords(id), r => r.recordIds?.length ? `已点亮并领取 ${r.recordIds.length} 个星宿奖励` : '观星礼录领取完成', '观星礼录领取失败')
const claimPassport = () => runOperation(id => activityStore.claimHeluPassport(id), () => '千星游记奖励领取完成', '千星游记领取失败')
const claimQingmei = () => runOperation(id => activityStore.claimQingmeiSeeds(id), r => r.alreadyClaimed ? '今日青梅种子已领取' : `已领取青梅种子 ×${r.claimedCount || 24}`, '青梅种子领取失败')
const sellQingmeiWine = () => runOperation(id => activityStore.brewAndSellQingmeiWine(id), r => `青梅酿售卖完成，获得金币 ${Number(r.sell?.gold || 0).toLocaleString()}`, '青梅酿售卖失败')
const drawWishSign = () => runOperation(id => activityStore.operateWishSignActivity(id, 'draw'), r => r.message || '祈愿成功', '祈愿失败')
const claimWishSign = () => runOperation(id => activityStore.operateWishSignActivity(id, 'claim'), r => r.message || '签文奖励领取成功', '签文领取失败')
const shareRewardShare = () => runOperation(id => activityStore.operateShareRewardActivity(id, 'share'), r => r.message || '首次分享成功', '分享失败')
const claimShareDaily = () => runOperation(id => activityStore.operateShareRewardActivity(id, 'daily'), r => r.message || '每日奖励领取成功', '每日领取失败')
const claimShareMilestones = () => runOperation(id => activityStore.operateShareRewardActivity(id, 'milestones'), r => r.message || '里程碑奖励领取成功', '里程碑领取失败')
const onRedFlowerDonateLove = () => runOperation(id => activityStore.donateRedFlowerLove(id), r => r.message || '送爱心值成功', '送爱心值失败')
const onRedFlowerDonateFund = () => runOperation(id => activityStore.donateRedFlowerFund(id), r => r.message || '公益金捐赠成功', '公益金捐赠失败')
const onRedFlowerClaimShare = () => runOperation(id => activityStore.claimRedFlowerShare(id), r => r.message || '分享奖励领取成功', '领取失败')
const onRedFlowerClaimTiers = () => runOperation(id => activityStore.claimRedFlowerTiers(id), r => r.message || '档位奖励领取成功', '领取失败')

// —— 奶茶热销中（S4）——
async function onMilkTeaNavigate(page: string) {
  if (!currentAccountId.value)
    return
  milkTeaPage.value = page
}

async function onMilkTeaOperate(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value)
    return
  const accountId = String(currentAccountId.value)
  const epoch = pageEpoch
  const signal = readController.signal
  const valid = () => !disposed && !signal.aborted && epoch === pageEpoch && accountId === String(currentAccountId.value)
  try {
  // 内部动作：仅切档位后重新拉取雇佣列表，不属于真实操作
  if (action === '__fetchHire') {
    await activityStore.fetchMilkTeaActivity(accountId, 'hireList', input, signal)
    return
  }
  const result = await activityStore.operateMilkTeaActivity(accountId, action, input)
  if (!valid() || result?.canceled || result?.stale) return
  if (result?.ok) {
    milkTeaProgressUncertain.value = true
    const gain = (result.rewards || []).length
    const labels: Record<string, string> = {
      create: '店铺已开业', rename: '店名已修改', claim: '收益已领取', boost: '加速成功',
      upgrade: '店铺已升级', craft: '制作成功', hire: '雇佣成功', exchange: '兑换成功',
      unlock: '成长基金已解锁', fundClaim: '基金奖励已领取', wages: '工资已领取',
      interact: '互动成功', hireSetting: '设置已更新',
    }
    toast.success(`${labels[action] || '操作成功'}${gain ? `，获得 ${gain} 项奖励` : ''}`)
    // 操作后刷新当前页与相关页（收益/等级/基金状态会跨页变化）
    const refreshPages = new Set([milkTeaPage.value, 'shop', 'upgrade'])
    if (['exchange', 'unlock', 'fundClaim'].includes(action)) refreshPages.add('fund')
    if (action === 'exchange') refreshPages.add('exchange')
    if (['wages', 'interact'].includes(action)) refreshPages.add('work')
    const refreshed = await Promise.allSettled([...refreshPages].map(p => activityStore.fetchMilkTeaActivity(accountId, p, {}, signal)))
    if (valid() && refreshed.every(reply => reply.status === 'fulfilled' && reply.value?.ok)) milkTeaProgressUncertain.value = false
  }
  else {
    milkTeaProgressUncertain.value = true
    toast.error(result?.error || '奶茶活动操作失败')
  }
  }
  catch (error: any) {
    if (valid()) milkTeaProgressUncertain.value = true
    if (valid() && !isReadCanceled(error)) toast.error(error?.message || '奶茶活动操作失败')
  }
}

const exchangeStarSand = (item: { id: number, itemName?: string, name?: string }, count: number) =>
  runOperation(id => activityStore.exchangeStarSand(id, item.id, count), () => `${L.exchangeDone}${item.itemName || item.name || item.id} ×${count}`, L.exchangeFail)

const activityContent = ref<HTMLElement | null>(null)
const { select: slideActivitySection, selected: selectedSection } = useSlidingTabs(activeSection, () => activityContent.value,
  () => sections.value.map(section => section.key), () => currentAccountId.value)
function selectSection(key: ActivitySectionKey) {
  slideActivitySection(key)
}

function backToList() {
  // 从活动返回后回落到首个可见常规活动 tab；若均下架则显示空态。
  if (sections.value.length === 0) {
    activeSection.value = ''
    return
  }
  if (!sections.value.some(s => s.key === activeSection.value)) {
    activeSection.value = sections.value[0]?.key ?? ''
  }
}

watch(currentAccountId, () => {
  pageEpoch++
  readController.abort()
  readController = new AbortController()
  activityStore.clearActivityData()
  solarSummary.value = { accountId: '', claimable: 0, loading: false }
  milkTeaProgressUncertain.value = false
  if (activeSection.value !== 'notes') void queueRefresh()
}, { flush: 'sync' })
watch([activeSection, milkTeaPage], () => {
  // Mounting SolarCalendar triggers exactly its own account-scoped read.
  if (activeSection.value !== 'notes') void queueRefresh()
})
onMounted(() => {
  // 若默认主活动（奶茶）已下线，回退到首个可见 tab；
  // 若所有常规活动都被隐藏（sections 为空），则置空显示「暂无进行中的活动」空态，
  // 避免面板残留渲染已隐藏的下线活动（如之前残留的千星游记）。
  if (isActivityHidden(activeSection.value)) {
    const first = sections.value[0]
    activeSection.value = first?.key ?? ''
  }
  // 先取最新游戏公告头图作为活动页 header 背景，无账号时也要展示。
  void fetchGameBulletinBanner()
  if (activeSection.value !== 'notes') void queueRefresh()
  nowTimer = window.setInterval(() => { nowMs.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (nowTimer) window.clearInterval(nowTimer)
  nowTimer = null
})
</script>

<template>
  <section class="activity-page space-y-4">
    <header class="activity-header space-y-4">
      <div class="ui-page-heading">
        <div><h1>{{ L.title }}</h1><p>参与当期活动，查看经营进度与节令奖励。</p></div>
        <div class="activity-header-controls">
          <BaseButton class="activity-header-refresh w-24 shrink-0" variant="secondary" :loading="refreshingActivity" :disabled="!currentAccountId" @click="refreshAll">
            <span class="i-carbon-renew mr-1.5" aria-hidden="true" />{{ L.refresh }}
          </BaseButton>
          <BaseButton v-if="userStore.isAdmin" variant="secondary" @click="showActivityAnalysis = true">
            <span class="i-carbon-analytics mr-1.5" aria-hidden="true" />活动分析
          </BaseButton>
        </div>
      </div>
      <nav ref="activityTabNav" v-sliding-tabs class="activity-tabs ui-tabs" role="tablist" aria-label="活动分类">
        <button
          v-for="(section, index) in sections" :id="`${activityPanelId}-${section.key}`" :key="section.key"
          type="button" role="tab" class="ui-tab ui-tab-counted font-medium"
          :data-active="selectedSection === section.key" :aria-selected="selectedSection === section.key"
          :aria-controls="`${activityPanelId}-panel`" :tabindex="selectedSection === section.key ? 0 : -1"
          data-motion-nav @click="selectSection(section.key)" @keydown="moveActivityTabFocus($event, index)"
        >
          <span class="ui-tab-icon" aria-hidden="true"><span :class="section.icon" /></span><span class="ui-tab-label">{{ section.label }}</span>
          <span
            class="activity-tab-count ui-tab-count inline-block w-6 shrink-0 text-center tabular-nums"
            :class="{ invisible: !section.count }" :aria-hidden="!section.count"
          >{{ (section.count || 0) > 99 ? '99+' : section.count || 0 }}</span>
        </button>
      </nav>
      <!-- Official art belongs only to this small banner; page navigation never changes theme. -->
      <div v-if="sections.length" class="activity-banner ui-card">
        <img v-if="headerBgSrc" :src="headerBgSrc" alt="" class="activity-banner-art" aria-hidden="true">
        <div class="activity-header-identity min-w-0">
          <h2>{{ activityHeading }}</h2>
          <p class="activity-banner-description">
            <template v-if="isSolarSection && solarHeaderTerm">{{ solarTermName(solarHeaderTerm) }} · {{ solarHeaderLabel }}</template>
            <template v-else-if="isSolarSection">节令小礼与答题奖励，随四时一同收集。</template>
            <template v-else-if="activeSection === 'milk-tea'">经营店铺，制作奶茶与领取活动奖励。</template>
            <template v-else>查看当前活动进度与可领取奖励。</template>
          </p>
          <!-- Keep the same schedule row in both tabs so switching never shifts navigation. -->
          <p
            class="activity-header-schedule"
            :class="{ invisible: activeSection !== 'milk-tea' }" :aria-hidden="activeSection !== 'milk-tea'"
          >
            <span>经营至 <strong>{{ milkTeaSchedule.businessEnd }}</strong></span><span>领奖至 <strong>{{ milkTeaSchedule.rewardEnd }}</strong></span><span>北京时间</span>
          </p>
        </div>
        <img
          v-if="isSolarSection && solarHeaderIllustration" :src="solarHeaderIllustration"
          alt="QQ农场官方冬季节令插画" width="337" height="239"
          class="activity-solar-art h-14 w-auto shrink-0 object-contain sm:h-16" aria-hidden="true"
        >
        <span v-if="showStarTheme && activity" class="activity-balance">
          <img src="/activity/star-festival/star-token.png" alt="" class="h-5 w-7 object-contain">
          {{ L.heluBalance }} {{ Number(activity.starSandBalance || 0).toLocaleString() }}
        </span>
      </div>
    </header>

    <div :id="`${activityPanelId}-panel`" ref="activityContent" class="tab-motion-viewport" role="tabpanel" :aria-labelledby="`${activityPanelId}-${activeSection}`" tabindex="0">
      <div class="space-y-4" data-motion-entry>
    <div v-if="!currentAccountId" class="ui-empty-state activity-empty" role="status">
      <span class="i-carbon-gift" aria-hidden="true" />
      <h3>{{ accountEmptyState.title }}</h3><p>{{ accountEmptyState.description }}</p>
    </div>
    <template v-else>
      <!-- 星许千灯系的全局提示只属于该主活动，切到萌宠日记 / 秋祈良愿 / 快乐不独享 / 奶茶热销中时不再展示，避免串台。 -->
      <template v-if="activeSection !== 'notes' && activeSection !== 'pet-diary' && activeSection !== 'wish-sign' && activeSection !== 'share-reward' && activeSection !== 'milk-tea'">
        <div v-if="heluError" class="ui-notice" data-tone="danger" role="status">
          {{ heluError }}
        </div>
        <div v-if="activity?.warning" class="ui-notice" data-tone="warning" role="status">
          {{ activity.warning }}
        </div>
        <div v-if="heluLoading && !activity" class="ui-notice" role="status">
          {{ L.loading }}
        </div>
      </template>

      <StarRecordPanel
        v-if="activeSection === 'records'"
        :record="activity?.starRecord"
        :loading="starRecordClaimLoading"
        @claim="claimRecords"
      />
      <div v-else-if="activeSection === 'shop'" class="space-y-3">
        <div v-if="activity?.shopWarning" class="ui-notice" data-tone="warning" role="status">
          {{ activity.shopWarning }}
        </div>
        <HeluExchangePanel
          :items="activity?.exchangeShop || []"
          :balance="activity?.starSandBalance || 0"
          :exchange-loading="exchangeLoading"
          :read-only="activity?.shopReadOnly"
          :labels="L"
          @exchange="exchangeStarSand"
        />
      </div>
      <HeluPassportPanel
        v-else-if="activeSection === 'journey'"
        :passport="activity?.passport"
        :loading="passportClaimLoading"
        :labels="L"
        @claim="claimPassport"
      />
      <SolarCalendar
        v-else-if="activeSection === 'notes'"
        ref="solarPanel"
        embedded
        @summary="updateSolarSummary"
      />
      <QixiActivityPanel
        v-else-if="activeSection === 'qixi'"
        :activity="qixiActivity"
        :friends="qixiFriends"
        :build-loading="qixiBuildLoading || qixiLoading"
        :gift-loading="qixiGiftLoading"
        :dew-loading="qixiDewLoading"
        @build="buildQixi"
        @dew="useQixiDew"
        @gift="giftQixi"
      />
      <QingmeiActivityPanel
        v-else-if="activeSection === 'qingmei' && !isActivityHidden('qingmei')"
        :activity="activity?.qingmei"
        :loading="qingmeiClaimLoading"
        :sell-loading="qingmeiSellLoading"
        @claim="claimQingmei"
        @sell-wine="sellQingmeiWine"
      />
      <RainPoemActivityPanel
        v-else-if="activeSection === 'rain-poem'"
        :activity="rainPoemActivity"
        :loading="rainPoemLoading"
        @refresh="refreshAll"
      />
      <RedFlowerActivityPanel
        v-else-if="activeSection === 'honghua'"
        :activity="redFlowerActivity"
        :loading="redFlowerLoading"
        :love-loading="redFlowerLoveLoading"
        :fund-loading="redFlowerFundLoading"
        :share-loading="redFlowerShareLoading"
        :tiers-loading="redFlowerTiersLoading"
        @donate-love="onRedFlowerDonateLove"
        @donate-fund="onRedFlowerDonateFund"
        @claim-share="onRedFlowerClaimShare"
        @claim-tiers="onRedFlowerClaimTiers"
      />
      <!-- 萌宠成长日记：与其它活动一样作为常规 tab 在主体区展示（不再走沉浸式全屏切换），
           保留 header 的 tab 切换按钮，便于未来新活动上线后在 header 中切换。 -->
      <PetDiaryActivityPanel
        v-else-if="activeSection === 'pet-diary'"
        @back="backToList"
      />
      <!-- 秋祈良愿（中秋祈愿）/ 快乐不独享（分享奖励）：9/24 新移植的常驻活动面板，
           与其它活动一样作为常规 tab 在主体区展示，风格与本地卡片样式保持一致。 -->
      <WishSignActivityPanel
        v-else-if="activeSection === 'wish-sign'"
        :activity="wishSignActivity"
        :loading="wishSignLoading"
        :operate-loading="wishSignOperateLoading"
        @draw="drawWishSign"
        @claim="claimWishSign"
        @refresh="refreshAll"
      />
      <ShareRewardActivityPanel
        v-else-if="activeSection === 'share-reward'"
        :activity="shareRewardActivity"
        :loading="shareRewardLoading"
        :operate-loading="shareRewardOperateLoading"
        @share="shareRewardShare"
        @daily="claimShareDaily"
        @milestones="claimShareMilestones"
        @refresh="refreshAll"
      />
      <!-- 奶茶热销中（S4）：与其它活动一致的常规 tab，面板内再分二级页签。 -->
      <MilkTeaActivityPanel
        v-else-if="activeSection === 'milk-tea'"
        :activity="milkTeaActivity"
        :account-id="String(currentAccountId || '')"
        :overview="milkTeaTodo"
        :page="milkTeaPage"
        :loading="milkTeaLoading"
        :operate-loading="milkTeaOperateLoading"
        embedded
        @navigate="onMilkTeaNavigate"
        @operate="onMilkTeaOperate"
      />
      <!-- 当所有常规活动都被下架、无可见 tab 时，展示空态，不再残留渲染已下线的默认面板。 -->
      <div v-if="sections.length === 0" class="ui-empty-state" role="status">
        <span class="i-carbon-calendar" aria-hidden="true" /><h3>暂无进行中的活动</h3>
        <p>当前没有进行中的活动，请耐心等待新版活动上线。</p>
      </div>
    </template>
      </div>
    </div>

    <AutoActivityPanel v-if="discovery.newActivity" class="mt-4" />

    <Teleport to="body">
      <div
        v-if="showActivityAnalysis"
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/55 p-3 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="活动分析"
        @click.self="showActivityAnalysis = false"
      >
        <div class="flex max-h-[92vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800">
          <header class="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div>
              <h2 class="font-semibold text-gray-900 dark:text-white">活动分析</h2>
              <p class="mt-0.5 text-xs text-gray-500">在线发现未适配活动并读取只读活动树</p>
            </div>
            <button
              class="grid h-9 w-9 place-items-center rounded-lg text-gray-500 transition hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="关闭活动分析"
              @click="showActivityAnalysis = false"
            >
              <span class="i-carbon-close text-xl" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <AdminActivityUpdatePanel />
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.activity-page { min-width: 0; color: var(--theme-text); }
.activity-header-controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.activity-tabs { position: relative; z-index: 1; }
.activity-tab-count { font-size: 11px; font-weight: 600; }
.activity-banner { position: relative; display: flex; align-items: center; gap: 18px; min-height: 128px; padding: 16px 20px; overflow: hidden; background: var(--surface-1); isolation: isolate; }
.activity-banner-art { position: absolute; top: 0; right: 0; width: 40%; height: 100%; object-fit: cover; object-position: center; opacity: .12; pointer-events: none; z-index: 0; mask-image: linear-gradient(to right, transparent, #000); }
.activity-header-identity { position: relative; z-index: 1; flex: 1; }
.activity-header-identity h2 { margin: 0; color: var(--theme-text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.activity-banner-description { margin: 4px 0 0; color: var(--muted-text); font-size: 13px; line-height: 1.7; }
.activity-header-schedule { display: flex; flex-wrap: wrap; gap: 2px 12px; min-height: 18px; margin: 8px 0 0; color: var(--muted-text); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.activity-header-schedule strong { color: var(--theme-text); font-weight: 600; }
.activity-solar-art { position: relative; z-index: 1; pointer-events: none; }
.activity-balance { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid var(--surface-border); border-radius: var(--radius-control); background: var(--surface-2); color: var(--theme-text); font-size: 12px; white-space: nowrap; }
@media (max-width: 640px) { .activity-header-controls { gap: 8px; } .activity-banner { gap: 12px; min-height: 128px; padding: 16px; } .activity-header-schedule { min-height: 36px; } .activity-header-identity h2 { font-size: 16px; } .activity-banner-art { width: 48%; } .activity-solar-art { position: absolute; top: 18px; right: 14px; opacity: .2; z-index: 0; } .activity-balance { position: absolute; right: 12px; top: 12px; } }
/*
 * 萌宠成长日记面板上游原本按「自带视口高度 + 面板内部 .pet-scroll 滚动」设计
 * （.pet-diary 为 max(520px, calc(100dvh - 128px))，内部滚动）。
 * 现在它内嵌在活动页主体中，若再扣减活动页 header 的高度会把它压得很扁，
 * 卡片内容被压缩、展示不完整。
 * 因此这里通过 :deep 覆盖为「高度随内容自适应、面板不在内部滚动」的页面滚动模式：
 *   - .pet-diary 高度放开为 auto、overflow 可见；
 *   - .pet-scroll 从内部滚动（overflow-y auto + container size/cqh）改为自然向下展开
 *     （container 只保留 inline-size，cqh 失效，内部各 section 的 height:100cqh /
 *       flex:1 布局随之自动展开，由各自 min-height 兜底），
 *   - 整个活动页借助外层 DefaultLayout 的 .custom-scrollbar（页面右侧滚动条）整体滚动。
 * 效果：卡片保持原始自然长度，内容不被压缩，用右侧页面滚动条下拉查看全部内容。
 */
:deep(.pet-diary.pet-diary) {
  height: auto !important;
  overflow: visible !important;
}
:deep(.pet-diary .pet-scroll) {
  overflow: visible !important;
  overscroll-behavior: auto;
  container: pet-viewport / inline-size !important;
}
:deep(.pet-diary .pet-content) {
  min-height: 0 !important;
}

/*
 * 萌宠日记面板原本自带「返回活动列表」按钮（沉浸式二级视图的设计）。
 * 现在它已是活动页的一个常规 tab，header 的 tab 切换按钮承担了活动间跳转，
 * 该返回按钮点击只会回落到自身、语义误导，故隐藏。
 */
:deep(.pet-diary .pet-header .pet-brand > .pet-icon-button) {
  display: none;
}
</style>
