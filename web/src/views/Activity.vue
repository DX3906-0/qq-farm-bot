<script setup lang="ts">
import type { ActivityLabels, ActivitySection, ActivitySectionKey } from '@/components/activity/types'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import HeluExchangePanel from '@/components/activity/HeluExchangePanel.vue'
import HeluPassportPanel from '@/components/activity/HeluPassportPanel.vue'
import HeluSolarTermsPanel from '@/components/activity/HeluSolarTermsPanel.vue'
import QingmeiActivityPanel from '@/components/activity/QingmeiActivityPanel.vue'
import RedFlowerActivityPanel from '@/components/activity/RedFlowerActivityPanel.vue'
import QixiActivityPanel from '@/components/activity/QixiActivityPanel.vue'
import RainPoemActivityPanel from '@/components/activity/RainPoemActivityPanel.vue'
import StarRecordPanel from '@/components/activity/StarRecordPanel.vue'
import PetDiaryActivityPanel from '@/components/activity/PetDiaryActivityPanel.vue'
import WishSignActivityPanel from '@/components/activity/WishSignActivityPanel.vue'
import ShareRewardActivityPanel from '@/components/activity/ShareRewardActivityPanel.vue'
import MilkTeaActivityPanel from '@/components/activity/MilkTeaActivityPanel.vue'
import AdminActivityUpdatePanel from '@/components/admin/AdminActivityUpdatePanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { isActivityHidden } from '@/config/activityVisibility'
import { useActivityDiscoveryStore } from '@/stores/activityDiscovery'
import AutoActivityPanel from '@/components/activity/AutoActivityPanel.vue'
import api from '@/api'

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
  notesTab: '节令小札',
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
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const {
  heluActivity: activity,
  heluLoading,
  passportClaimLoading,
  solarClaimLoading,
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
let nowTimer: ReturnType<typeof window.setInterval> | null = null
// ⚠️ 活动「是否在期」统一由 isActivityHidden（内部走 activity-windows.ts 时间窗）判定，
// 此处不再各自硬编码窗口常量，避免与 core/src/models/store.js 口径分叉。
const rainPoemActivityActive = computed(() => !isActivityHidden('rain-poem'))
const redFlowerActivityActive = computed(() => !isActivityHidden('honghua'))
const gameBulletinPic = ref('')
const bulletinLoading = ref(false)
const headerBgSrc = computed(() => {
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

const activeSection = ref<ActivitySectionKey | ''>('journey')
const showActivityAnalysis = ref(false)

const sections = computed<ActivitySection[]>(() => ([
  { key: 'qixi' as const, label: '鹊桥寄情', icon: 'i-carbon-favorite', count: qixiActivity.value?.gift.remainingCount || 0 },
  { key: 'journey' as const, label: '千星游记', icon: 'i-carbon-map', count: activity.value?.passport?.claimableLevels || 0 },
  { key: 'records' as const, label: '观星礼录', icon: 'i-carbon-star', count: activity.value?.starRecord?.claimableCount || 0 },
  { key: 'shop' as const, label: '星砂兑换商店', icon: 'i-carbon-store', count: activity.value?.exchangeShop?.length || 0 },
  { key: 'notes' as const, label: '节令小札', icon: 'i-carbon-notebook', count: activity.value?.solarTerms?.claimableCount || 0 },
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
  // 奶茶热销中（S4，2026-10-15 上线）：当前在期的常规活动 tab。
  { key: 'milk-tea' as const, label: '奶茶热销中', icon: 'i-carbon-cafe', count: milkTeaActivity.value?.summary?.hasUnclaimedWage ? 1 : 0 },
]).filter(section => !isActivityHidden(section.key)))

async function fetchGameBulletinBanner() {
  try {
    bulletinLoading.value = true
    const res = await api.get('/api/announcement/game')
    if (res.data?.ok && res.data?.data?.bulletins?.length) {
      gameBulletinPic.value = res.data.data.bulletins[0].pic || ''
    }
    else {
      gameBulletinPic.value = ''
    }
  }
  catch {
    gameBulletinPic.value = ''
  }
  finally {
    bulletinLoading.value = false
  }
}

async function refreshAll() {
  if (currentAccountId.value) {
    const requests = []
    // 心许千灯星垂野（journey/records/shop/notes）整体下线后这些 tab 不再展示，
    // 相应请求会返回「活动已结束」，无需再拉取。
    const starSectionsVisible = sections.value.some(s => ['journey', 'records', 'shop', 'notes'].includes(s.key))
    if (starSectionsVisible) requests.push(activityStore.fetchHeluActivity(currentAccountId.value))
    if (!isActivityHidden('qixi'))
      requests.push(activityStore.fetchQixiActivity(String(currentAccountId.value)))
    if (rainPoemActivityActive.value)
      requests.push(activityStore.fetchRainPoemActivity(String(currentAccountId.value)))
    if (redFlowerActivityActive.value)
      requests.push(activityStore.fetchRedFlowerActivity(String(currentAccountId.value)))
    // 秋祈良愿 / 快乐不独享：仅在活动可见时拉取（过期活动已进 HIDDEN_ACTIVITIES，
    // 不再无条件请求，避免为已下线活动持续轮询后端）。
    if (!isActivityHidden('wish-sign'))
      requests.push(activityStore.fetchWishSignActivity(String(currentAccountId.value)))
    if (!isActivityHidden('share-reward'))
      requests.push(activityStore.fetchShareRewardActivity(String(currentAccountId.value)))
    if (!isActivityHidden('milk-tea'))
      requests.push(activityStore.fetchMilkTeaActivity(String(currentAccountId.value), milkTeaPage.value))
    // 同步取最新游戏公告头图作为活动页 header 背景（当前活动 banner）。
    requests.push(fetchGameBulletinBanner())
    // 用 allSettled 避免雨落成诗 fetch（可能进入好友农场，耗时较久）把其它请求一起拖崩。
    await Promise.allSettled(requests)
  }
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

async function buildQixi() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.buildQixiBridge(String(currentAccountId.value))
  result?.ok ? toast.success(result.completed ? '鹊桥已全部完成' : '驻建鹊桥成功') : toast.error(result?.error || '驻建鹊桥失败')
}
async function useQixiDew() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.useQixiDew(String(currentAccountId.value))
  result?.ok
    ? toast.success(result.usedCount ? `已使用 ${result.usedCount} 个鹊羽灵露` : result.reason === 'daily_limit' ? '今日使用次数已达上限' : '暂无符合条件的土地')
    : toast.error(result?.error || '使用鹊羽灵露失败')
}

async function giftQixi(friendGid: number, count: number) {
  if (!currentAccountId.value)
    return
  const result = await activityStore.sendQixiSachet(String(currentAccountId.value), friendGid, count)
  result?.ok ? toast.success(`已赠送 ${result.sentCount || count} 个鹊羽香囊`) : toast.error(result?.error || '香囊赠送失败')
}

async function claimRecords() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimStarRecords(currentAccountId.value)
  if (result?.ok) {
    const count = result.recordIds?.length || 0
    toast.success(count ? `已点亮并领取 ${count} 个星宿奖励` : '观星礼录领取完成')
  }
  else {
    toast.error(result?.error || '观星礼录领取失败')
  }
}

async function claimPassport() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimHeluPassport(currentAccountId.value)
  result?.ok ? toast.success('千星游记奖励领取完成') : toast.error(result?.error || '千星游记领取失败')
}

async function claimSolar(term: { id: number, title?: string }) {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimHeluSolar(currentAccountId.value, term.id)
  result?.ok
    ? toast.success(`节令小札领取完成：${term.title || term.id}`)
    : toast.error(result?.error || '节令小札领取失败')
}

async function claimQingmei() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.claimQingmeiSeeds(currentAccountId.value)
  result?.ok
    ? toast.success(result.alreadyClaimed ? '今日青梅种子已领取' : `已领取青梅种子 ×${result.claimedCount || 24}`)
    : toast.error(result?.error || '青梅种子领取失败')
}

async function sellQingmeiWine() {
  if (!currentAccountId.value)
    return
  const result = await activityStore.brewAndSellQingmeiWine(currentAccountId.value)
  result?.ok
    ? toast.success(`青梅酿售卖完成，获得金币 ${Number(result.sell?.gold || 0).toLocaleString()}`)
    : toast.error(result?.error || '青梅酿售卖失败')
}

// —— 秋祈良愿（中秋祈愿）——
async function drawWishSign() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.operateWishSignActivity(String(currentAccountId.value), 'draw')
  r?.ok ? toast.success(r.message || '祈愿成功') : toast.error(r?.error || '祈愿失败')
}

async function claimWishSign() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.operateWishSignActivity(String(currentAccountId.value), 'claim')
  r?.ok ? toast.success(r.message || '签文奖励领取成功') : toast.error(r?.error || '签文领取失败')
}

// —— 快乐不独享（分享奖励）——
async function shareRewardShare() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.operateShareRewardActivity(String(currentAccountId.value), 'share')
  r?.ok ? toast.success(r.message || '首次分享成功') : toast.error(r?.message || '分享失败')
}

async function claimShareDaily() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.operateShareRewardActivity(String(currentAccountId.value), 'daily')
  r?.ok ? toast.success(r.message || '每日奖励领取成功') : toast.error(r?.message || '每日领取失败')
}

async function claimShareMilestones() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.operateShareRewardActivity(String(currentAccountId.value), 'milestones')
  r?.ok ? toast.success(r.message || '里程碑奖励领取成功') : toast.error(r?.message || '里程碑领取失败')
}

async function onRedFlowerDonateLove() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.donateRedFlowerLove(String(currentAccountId.value))
  r?.ok ? toast.success(r.message || '送爱心值成功') : toast.error(r?.message || '送爱心值失败')
}

async function onRedFlowerDonateFund() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.donateRedFlowerFund(String(currentAccountId.value))
  r?.ok ? toast.success(r.message || '公益金捐赠成功') : toast.error(r?.message || '公益金捐赠失败')
}

async function onRedFlowerClaimShare() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.claimRedFlowerShare(String(currentAccountId.value))
  r?.ok ? toast.success(r.message || '分享奖励领取成功') : toast.error(r?.message || '领取失败')
}

async function onRedFlowerClaimTiers() {
  if (!currentAccountId.value)
    return
  const r = await activityStore.claimRedFlowerTiers(String(currentAccountId.value))
  r?.ok ? toast.success(r.message || '档位奖励领取成功') : toast.error(r?.message || '领取失败')
}

// —— 奶茶热销中（S4）——
async function onMilkTeaNavigate(page: string) {
  if (!currentAccountId.value)
    return
  milkTeaPage.value = page
  // 已有缓存则直接用，否则拉取该页
  if (!milkTeaPages.value[page])
    await activityStore.fetchMilkTeaActivity(String(currentAccountId.value), page)
}

async function onMilkTeaOperate(action: string, input: Record<string, unknown> = {}) {
  if (!currentAccountId.value)
    return
  const accountId = String(currentAccountId.value)
  // 内部动作：仅切档位后重新拉取雇佣列表，不属于真实操作
  if (action === '__fetchHire') {
    await activityStore.fetchMilkTeaActivity(accountId, 'hireList', input)
    return
  }
  const result = await activityStore.operateMilkTeaActivity(accountId, action, input)
  if (result?.ok) {
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
    await Promise.allSettled([...refreshPages].map(p => activityStore.fetchMilkTeaActivity(accountId, p)))
  }
  else {
    toast.error(result?.error || '奶茶活动操作失败')
  }
}

async function exchangeStarSand(item: { id: number, itemName?: string, name?: string }, count: number) {
  if (!currentAccountId.value)
    return
  const result = await activityStore.exchangeStarSand(currentAccountId.value, item.id, count)
  result?.ok
    ? toast.success(`${L.exchangeDone}${item.itemName || item.name || item.id} ×${count}`)
    : toast.error(result?.error || L.exchangeFail)
}

function selectSection(key: ActivitySectionKey) {
  // 所有活动（含萌宠日记）均作为常规 tab 在主体区切换展示；不再进入独立沉浸式全屏视图。
  activeSection.value = key
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
  activityStore.clearActivityData()
  refreshAll()
})
onMounted(() => {
  // 若默认 tab（千星游记）已下线，回退到首个可见 tab；
  // 若所有常规活动都被隐藏（sections 为空），则置空显示「暂无进行中的活动」空态，
  // 避免面板残留渲染已隐藏的下线活动（如之前残留的千星游记）。
  if (isActivityHidden(activeSection.value)) {
    const first = sections.value[0]
    activeSection.value = first?.key ?? ''
  }
  // 先取最新游戏公告头图作为活动页 header 背景，无账号时也要展示。
  fetchGameBulletinBanner()
  refreshAll()
  nowTimer = window.setInterval(() => { nowMs.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (nowTimer) window.clearInterval(nowTimer)
  nowTimer = null
})
</script>

<template>
  <section class="space-y-4">
    <header
      class="relative min-h-40 overflow-hidden rounded-lg shadow-sm"
      :class="activeSection === 'honghua' ? 'bg-black' : activeSection === 'pet-diary' ? 'bg-[#123a1c]' : activeSection === 'wish-sign' ? 'bg-[#3a2b14]' : activeSection === 'share-reward' ? 'bg-[#2a160f]' : activeSection === 'milk-tea' ? 'bg-[#3a2415]' : 'bg-[#071b43]'"
    >
      <img
        v-if="headerBgSrc"
        :src="headerBgSrc"
        alt=""
        class="absolute inset-0 h-full w-full object-cover object-center"
        :class="gameBulletinPic || activeSection === 'honghua' ? 'opacity-100' : activeSection === 'pet-diary' ? 'opacity-70' : 'opacity-80'"
      >
      <div
        class="absolute inset-0"
        :class="(activeSection === 'honghua' || (gameBulletinPic && activeSection !== 'pet-diary'))
          ? 'bg-gradient-to-r from-black/55 via-black/20 to-transparent'
          : activeSection === 'rain-poem'
            ? 'bg-gradient-to-r from-[#081824]/95 via-[#102b3c]/80 to-[#173445]/35'
            : activeSection === 'pet-diary'
              ? 'bg-gradient-to-r from-[#08260f]/95 via-[#0f3d1f]/75 to-[#123a1c]/25'
              : activeSection === 'wish-sign'
                ? 'bg-gradient-to-r from-[#2a1d0a]/95 via-[#4a3411]/80 to-[#5c4214]/25'
                : activeSection === 'share-reward'
                  ? 'bg-gradient-to-r from-[#331209]/95 via-[#5c2411]/80 to-[#7a3014]/25'
                  : activeSection === 'milk-tea'
                    ? 'bg-gradient-to-r from-[#2f1b0d]/95 via-[#5a3418]/80 to-[#7d4a1f]/25'
                    : 'bg-gradient-to-r from-[#061632]/95 via-[#0b2e61]/80 to-[#0b2e61]/25'"
      />
      <img
        v-if="activeSection !== 'qixi' && activeSection !== 'rain-poem' && activeSection !== 'honghua' && activeSection !== 'pet-diary' && activeSection !== 'wish-sign' && activeSection !== 'share-reward' && activeSection !== 'milk-tea'"
        src="/activity/star-festival/star-farm.png"
        alt=""
        class="pointer-events-none absolute -bottom-32 right-0 hidden h-96 w-96 object-contain opacity-85 lg:block"
      >
      <!-- 萌宠成长日记主题活动装饰：上游本活动的比熊立绘，替换已下线的千星游记星空装饰。 -->
      <img
        v-else-if="activeSection === 'pet-diary'"
        src="/activity/pet-diary/img_s3BattlePass_pet.png"
        alt=""
        class="pointer-events-none absolute bottom-1 right-6 hidden h-36 w-36 object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.45)] lg:block"
      >

      <div class="relative flex min-h-40 flex-col justify-between gap-4 p-4 xl:flex-row xl:items-center">
        <div class="min-w-0">
          <img
            v-if="activeSection === 'qixi'"
            src="/activity/qixi/event-banner.png"
            :alt="qixiActivity?.title || '鹊桥寄情'"
            class="h-auto w-72 max-w-full object-contain object-left"
          >
          <h1
            v-else-if="activeSection === 'rain-poem'"
            class="text-3xl font-semibold tracking-wide text-white drop-shadow"
          >
            {{ rainPoemActivity?.title || '雨落成诗' }}
          </h1>
          <h1
            v-else-if="activeSection === 'honghua'"
            class="flex items-center gap-2 text-3xl font-semibold tracking-wide text-white drop-shadow"
          >
            <span class="i-carbon-favorite-filled text-rose-200" />
            {{ redFlowerActivity?.title || '公益小红花' }}
          </h1>
          <img
            v-else-if="activeSection === 'pet-diary'"
            src="/activity/pet-diary/img_s3main_title.png"
            alt="萌宠成长日记"
            class="h-auto w-72 max-w-full object-contain object-left drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"
          >
          <h1
            v-else-if="activeSection === 'wish-sign'"
            class="flex items-center gap-2 text-3xl font-semibold tracking-wide text-amber-100 drop-shadow"
          >
            <span class="i-carbon-launch text-amber-200" />
            {{ wishSignActivity?.title || '秋祈良愿' }}
          </h1>
          <h1
            v-else-if="activeSection === 'share-reward'"
            class="flex items-center gap-2 text-3xl font-semibold tracking-wide text-orange-100 drop-shadow"
          >
            <span class="i-carbon-favorite-filled text-orange-200" />
            {{ shareRewardActivity?.title || '快乐不独享' }}
          </h1>
          <h1
            v-else-if="activeSection === 'milk-tea'"
            class="flex items-center gap-2 text-3xl font-semibold tracking-wide text-amber-100 drop-shadow"
          >
            <span class="i-carbon-cafe text-amber-200" />
            {{ milkTeaActivity?.title || '奶茶热销中' }}
          </h1>
          <img
            v-else
            src="/activity/star-festival/event-title.png"
            :alt="activity?.title || L.heluTitle"
            class="h-auto w-72 max-w-full object-contain object-left"
          >
          <div class="mt-1 text-xs text-sky-100/75">
            活动中心 · {{ L.currentAccount }} {{ currentAccount?.name || L.none }}
          </div>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-2 xl:max-w-[68%] xl:justify-end">
          <span
            v-if="activeSection !== 'rain-poem' && activeSection !== 'honghua' && activeSection !== 'pet-diary' && activeSection !== 'wish-sign' && activeSection !== 'share-reward' && activeSection !== 'milk-tea'"
            class="inline-flex items-center rounded-lg border border-sky-200/20 bg-[#071b43]/70 px-3 py-1.5 text-xs text-sky-50 backdrop-blur-sm"
          >
            <img src="/activity/star-festival/star-token.png" alt="" class="mr-1.5 h-5 w-7 object-contain">
            {{ L.heluBalance }} {{ Number(activity?.starSandBalance || 0).toLocaleString() }}
          </span>
          <div class="min-w-0 max-w-full">
                    <div class="inline-flex flex-wrap gap-1.5 p-1 border border-sky-200/20 rounded-xl bg-[#071b43]/70 backdrop-blur-sm">
                      <button
                        v-for="section in sections"
                        :key="section.key"
                        class="px-3 py-1 text-sm transition whitespace-nowrap rounded-lg"
                        :class="activeSection === section.key ? 'text-white font-medium' : 'text-sky-100/80 hover:text-white'"
                        :style="activeSection === section.key ? { backgroundColor: 'var(--theme-primary)' } : {}"
                        @click="selectSection(section.key)"
                      >
                        {{ section.label }}
                        <span v-if="section.count" class="ml-1 opacity-80">{{ section.count }}</span>
                      </button>
                    </div>
                  </div>
          <BaseButton variant="primary" :loading="heluLoading || rainPoemLoading" :disabled="!currentAccountId" @click="refreshAll">
            {{ L.refresh }}
          </BaseButton>
          <BaseButton v-if="userStore.isAdmin" variant="secondary" @click="showActivityAnalysis = true">
            <span class="i-carbon-analytics mr-1.5" />
            活动分析
          </BaseButton>
        </div>
      </div>
    </header>

    <div v-if="!currentAccountId" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
      {{ L.needAccount }}
    </div>
    <template v-else>
      <!-- 星许千灯系的全局提示只属于该主活动，切到萌宠日记 / 秋祈良愿 / 快乐不独享 / 奶茶热销中时不再展示，避免串台。 -->
      <template v-if="activeSection !== 'pet-diary' && activeSection !== 'wish-sign' && activeSection !== 'share-reward' && activeSection !== 'milk-tea'">
        <div v-if="heluError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
          {{ heluError }}
        </div>
        <div v-if="activity?.warning" class="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
          {{ activity.warning }}
        </div>
        <div v-if="heluLoading && !activity" class="rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-900/20 dark:text-sky-100">
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
        <div v-if="activity?.shopWarning" class="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
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
      <HeluSolarTermsPanel
        v-else-if="activeSection === 'notes'"
        :solar-terms="activity?.solarTerms"
        :loading="solarClaimLoading"
        :labels="L"
        @claim="claimSolar"
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
        v-else-if="!isActivityHidden('qingmei')"
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
        :page="milkTeaPage"
        :loading="milkTeaLoading"
        :operate-loading="milkTeaOperateLoading"
        @navigate="onMilkTeaNavigate"
        @operate="onMilkTeaOperate"
      />
      <!-- 当所有常规活动都被下架、无可见 tab 时，展示空态，不再残留渲染已下线的默认面板。 -->
      <div v-if="sections.length === 0" class="rounded-lg bg-white p-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800">
        <p class="text-sm">当前没有进行中的活动，请耐心等待新版活动上线。</p>
      </div>
    </template>

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
