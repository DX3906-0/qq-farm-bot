import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ActivityExchangeShopItem {
  id: number
  sort: number
  status: number
  owned: boolean
  isRepeatable?: boolean
  exchangeLimit?: number
  ownedBlocksExchange?: boolean
  statusLabel: string
  name: string
  itemId: number
  itemCount: number
  itemName: string
  image?: string
  itemType: number
  itemTypeLabel: string
  isDecoration: boolean
  currencyId: number
  currencyName: string
  price: number
  desc: string
  extra: string
}

export interface HeluDrawReward {
  itemId: number
  itemCount: number
  count?: number
  itemName: string
  name?: string
  image?: string
}

export interface HeluDrawCost {
  itemId?: number
  itemName?: string
  itemCount?: number
  image?: string
}

export interface HeluDrawResult {
  rewards?: HeluDrawReward[]
  items?: HeluDrawReward[]
  cost?: HeluDrawCost | null
}

export interface HeluSeasonRewardTier {
  level: number
  freeRewards: HeluDrawReward[]
  premiumRewards: HeluDrawReward[]
}

export interface HeluSeasonPassport {
  uid?: string
  title: string
  seasonTitle?: string
  currentLevel: number
  score?: number
  currentProgress?: number
  nextLevelNeed?: number
  maxLevel?: number
  freeClaimedLevel?: number
  premiumClaimedLevel?: number
  claimableLevels: number
  rewardTierCount?: number
  levelRewardTiers?: HeluSeasonRewardTier[]
  rewards?: HeluDrawReward[]
  configText?: string
  startTime?: number
  endTime?: number
  nowTime?: number
  warning?: string
}

export interface HeluSolarTerm {
  id: number
  title: string
  status: number
  statusLabel: string
  claimable: boolean
  claimStatusKnown?: boolean
  startTime: number
  endTime: number
  rewards: HeluDrawReward[]
}

export interface HeluSolarTerms {
  nowTime?: number
  terms: HeluSolarTerm[]
  claimableCount: number
  currentTerm?: HeluSolarTerm | null
  tipsText?: string
  warning?: string
}

export interface StarRecordItem {
  id: number
  title: string
  category: string
  explain: string
  graph: string
  featured: boolean
  unlocked: boolean
  claimed: boolean
  claimable: boolean
  rewards: HeluDrawReward[]
}

export interface StarActivityData {
  uid: string
  title: string
  activityId: number
  startTime?: number
  endTime?: number
  starRecord: {
    status: number
    openedDays: number
    records: StarRecordItem[]
    totalCount: number
    unlockedCount: number
    claimedCount: number
    claimableCount: number
  }
  exchangeShop: ActivityExchangeShopItem[]
  shopReadOnly: boolean
  shopWarning?: string
  starSandCurrencyId: number
  starSandBalance: number
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  warning?: string
}

export type HeluSubActivityKey = 'giftLotus' | 'shop' | 'journey' | 'notes'

export interface QixiItem { itemId: number, itemCount: number, itemName: string, image?: string }
export interface QixiFriend { gid: number, name: string, avatar?: string, level?: number }
export interface QixiActivityData {
  uid: string
  title: string
  activityId: number
  startTime: number
  endTime: number
  active: boolean
  ended?: boolean
  items: { feather: QixiItem, dew: QixiItem, sachet: QixiItem }
  dewUsage: { dailyLimit: number, limitReached: boolean }
  bridge: {
    stages: Array<{ id: number, status: number, claimed: boolean, cost: QixiItem, rewards: QixiItem[] }>
    completedCount: number
    nextStage?: { id: number, status: number, claimed: boolean, cost: QixiItem, rewards: QixiItem[] } | null
    canBuild: boolean
  }
  gift: {
    sentCount: number
    receivedCount: number
    maxCount: number
    remainingCount: number
    cost: QixiItem
    reward: QixiItem
    enabled: boolean
  }
}

export interface RainPoemActivityData {
  title: string
  startTime: number
  endTime: number
  active: boolean
  items: { collectionBottles: number, summonBottles: number, frogPrankBottles: number, cloudPrankBottles: number, badges: number }
  shop: { purchasedToday: boolean, available: boolean, dailyLimit: number, cost: QixiItem, item: QixiItem }
  collection: { remainingUseCount: number, dailyUseLimit: number, reward: QixiItem }
  summon: { itemId: number, dailyUseLimit: number, durationSeconds: number, usedToday: number }
  weather?: { type: number, status: number, startTime?: number, endTime?: number, rainstorm: boolean, error?: string }
  tasks: Array<{ id: number, itemId: number, desc: string, target: number, progress: number, reward: QixiItem }>
  research: { currentStage: number, stages: Array<{ id: number, status: number, available: boolean, completed: boolean, claimed: boolean, cost: QixiItem, reward: QixiItem, repeatable: boolean, limit: number }> }
}

export interface QingmeiActivity {
  uid: string
  title: string
  activityId: number
  claimActivityId: number
  claimCommand: number
  wineActivityId?: number
  wineTitle?: string
  winePreviewCommand?: number
  wineBrewCommand?: number
  wineSellCommand?: number
  startTime?: number
  endTime?: number
  status?: number
  claimed: boolean
  claimable: boolean
  reward: HeluDrawReward
  material?: HeluDrawReward
  warning?: string
}

export interface QingmeiBrewResult {
  wineType: number
  cost: number
  price: number
  canDouble: boolean
}

export interface RedFlowerActivityData {
  title: string
  activityId: number
  available: boolean
  progress?: {
    loveValue: number
    serverProgress: number
    serverGoal?: number
    serverPercent?: number
    tiers: Array<{
      tier: number
      claimed: boolean
      reached: boolean
      reward?: { id: number, count: number } | null
    }>
    dailyGift?: { id: number, count: number } | null
    serverGift?: { id: number, count: number } | null
    holdingItem?: { id: number, count: number } | null
    settleTime?: number
    fundDonated: boolean
  } | null
  fundDonated?: boolean
  warning?: string
}

// 秋祈良愿（wish_sign）—— 服务端 normalizeWishSignActivity 的结构对齐
export interface WishSignRewardItem {
  itemId: number
  itemName?: string
  itemCount?: number
  count?: number
  image?: string
  dayId?: number
}
export interface WishSignActivityData {
  title: string
  activityId: number
  startTime: number
  endTime: number
  active: boolean
  remainingCount: number
  activityDay: number
  pending: {
    chooseId: number
    textId: number
    dayId: number
    rewards: WishSignRewardItem[]
  } | null
  choices: Array<{ id: number, name: string }>
  rewardPool: Array<{ dayId: number, itemId: number, count: number, itemName?: string, image?: string }>
}

// 快乐不独享（share_reward）—— 服务端 normalizeShareRewardActivity 的结构对齐
export interface ShareMilestoneTier {
  id: number
  threshold: number
  state: number
  rewards: Array<{ itemId?: number, itemName?: string, itemCount?: number, count?: number, image?: string }>
}
export interface ShareRewardActivityData {
  title: string
  activityId: number
  startTime: number
  endTime: number
  active: boolean
  scoreItemId: number
  currentScore: number
  daily: {
    claimedCount: number
    claimLimit: number
    rewardClaimed: boolean
    firstShareAwarded: boolean
    dailyReward: number
    firstShareReward: number
    poolClaimed: number
    poolLimit: number
  }
  milestones: ShareMilestoneTier[]
}

export interface QingmeiSellResult {
  multiple: number
  gold: number
  item?: HeluDrawReward
}

// 奶茶热销中（milk-tea）—— 服务端 getMilkTeaActivity 的结构对齐
export interface MilkTeaSummary {
  shopOpenAt: number
  shopName: string
  renameCdUntilAt: number
  level: number
  totalRevenue: number
  hireDisabled: boolean
  cashierFull: boolean
  cashierWarning: boolean
  canUpgrade: boolean
  hasWorkerShift: boolean
  hasUnclaimedWage: boolean
  nextCupAt: number
  openingGiftPreview: HeluDrawReward[]
}

export interface MilkTeaLevelConfig {
  level: number
  revenueRequired: number
  basePopularity: number
  employeeSlotCount: number
  recipes: string[]
}

export interface MilkTeaGoodsItem {
  id: string
  name: string
  description: string
  rewards: HeluDrawReward[]
  costs: HeluDrawReward[]
  remaining: number | null
  available: boolean
  // 后端 normalizeMilkTeaGood 实际下发、用于「为什么不能兑」标注
  unlocked?: boolean
  paid?: boolean
  categoryTag?: string
  purchaseLimit?: number
  purchasedCount?: number
  affordable?: boolean
  maxPurchasable?: number
}

export interface MilkTeaFundCondition {
  type: string
  current: number
  target: number
  reached: boolean
}

export interface MilkTeaFundTier {
  id: number
  state: number
  rewards: HeluDrawReward[]
  conditions: MilkTeaFundCondition[]
}

export interface MilkTeaFund {
  unlocked: boolean
  costs: HeluDrawReward[]
  tiers: MilkTeaFundTier[]
}

export interface MilkTeaRecipe {
  recipeId: number
  recipeName: string
  unlocked: boolean
  isAdvanced: boolean
  tokenPrice: number
  coinPrice: number
  stockCups: number
  clearCoinPrice: number
  clearCoinTotal: number
  description: string
  fruitItemId: number
}

export interface MilkTeaShopSlot {
  slotIndex: number
  isRobot: boolean
  shiftId: number
  beginAt: number
  endAt: number
  talentId: number
  talentName: string
  employee: { gid: number, name: string, level: number } | null
}

export interface MilkTeaShopView {
  level: number
  totalRevenue: number
  nextLevelRevenue: number
  cashierCapacitySec: number
  cashierElapsedSec: number
  salesItemId: number
  salesDurationSec: number
  isSettling: boolean
  boostCupsPerUse: number
  effectiveCupsPerHour: number
  secPerCup: number
  nextFullAt: number
  slots: MilkTeaShopSlot[]
  drinkCups: Record<string, number>
  pendingCupsByRecipe: Record<string, number>
  pendingCupsBySource: Record<string, number>
  boostCoinPrice: Record<string, number>
  pendingRewards: HeluDrawReward[]
  boostPreviewRewards: HeluDrawReward[]
}

export interface MilkTeaHireFriend {
  friend: { gid: number, name: string, level: number } | null
  isRobot: boolean
  talentId: number
  talentName: string
  state: number
  stateUntilAt: number
  rehireAvailableAt: number
}

export interface MilkTeaHire {
  durationId: number
  wageTotal: number
  minRemainBizSec: number
  inviteEntry: boolean
  friends: MilkTeaHireFriend[]
  robots: MilkTeaHireFriend[]
}

export interface MilkTeaWorkShift {
  employer: { gid: number, name: string } | null
  shopName: string
  shiftId: number
  talentId: number
  talentName: string
  beginAt: number
  endAt: number
  interactCount: number
  interactLimit: number
  wageTotal: number
  interactPreviews: Array<{ interactionType: number, promoteCups: number }>
}

export interface MilkTeaWorkSlip {
  employer: { gid: number, name: string } | null
  shopName: string
  shiftId: number
  beginAt: number
  endAt: number
  workSec: number
  wageStatus: number
  baseWage: number
  finalWage: number
}

export interface MilkTeaWork {
  talentId: number
  talentName: string
  interactDone: boolean
  myShift: MilkTeaWorkShift | null
  slips: MilkTeaWorkSlip[]
}

export interface MilkTeaActivityData {
  activityId: number
  groupId?: number
  title: string
  serverTime: number
  startTime: number
  endTime: number
  settleStartTime: number
  active: boolean
  settling: boolean
  page: string
  summary: MilkTeaSummary
  recommendedNames: string[]
  levels: MilkTeaLevelConfig[]
  goods?: MilkTeaGoodsItem[]
  // 兑换货币余额（1041=奶茶券、1001=金币），面板显示「我有多少」用
  balances?: {
    milkTeaToken: number
    goldCoin: number
  }
  fund?: MilkTeaFund
  shop?: MilkTeaShopView
  recipes?: MilkTeaRecipe[]
  hire?: MilkTeaHire
  durations?: Array<{ duration_id?: number, id?: number, duration_sec?: number, cost?: number, name?: string }>
  work?: MilkTeaWork
  rank?: {
    myRank: number
    page: number
    hasMore: boolean
    ranks: Array<{ rank: number, shopName: string, level: number, totalRevenue: number, owner: { gid: number, name: string } | null }>
  }
  logs?: {
    day: number
    token: number
    coin: number
    cups: number
    cupsByRecipe: Record<string, number>
    cupsBySource: Record<string, number>
    items: HeluDrawReward[]
  }
}

export interface HeluSubActivity {
  key: HeluSubActivityKey
  id: number
  parentId: number
  title: string
  icon: string
  type: number
  sort: number
  status: number
  visible: boolean
  enabled: boolean
  startTime: number
  endTime: number
  payload?: Record<string, unknown> | null
  payloadSummary: Array<{ key: string, value: string }>
  hasDraw: boolean
  hasExchangeShop: boolean
  available: boolean
  source: string
}

export interface HeluActivityData {
  uid: string
  title: string
  activityId: number
  drawActivityId: number
  drawCommand: number
  draw: {
    freeMax: number
    freeUsed: number
    freeRemaining: number
    paidMax: number
    paidUsed: number
    paidRemaining: number
    paidPrice: number
    paidCurrencyId: number
    rewardPool: HeluDrawReward[]
    actions?: {
      one?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
      batch?: { count: number, available: boolean, cost: number, currencyId: number, type: string, label: string }
    }
    dailyMax: number
    dailyUsed: number
    dailyRemaining: number
  }
  exchangeActivityId: number
  exchangeShop: ActivityExchangeShopItem[]
  subActivities: HeluSubActivity[]
  passport?: HeluSeasonPassport | null
  solarTerms?: HeluSolarTerms | null
  qingmei?: QingmeiActivity | null
  heluBalance: number
  lastDrawResult?: HeluDrawResult | null
  warning?: string
  summary: {
    rewardPoolCount: number
    exchangeShopCount: number
    activityCount: number
    subActivityCount?: number
    dailyUsed: number
    dailyRemaining: number
  }
  raw?: {
    activityCount?: number
    activityTitles?: string[]
    activityIds?: number[]
  }
}

export const useActivityStore = defineStore('activity', () => {
  const heluActivity = ref<StarActivityData | null>(null)

  const qixiActivity = ref<QixiActivityData | null>(null)
  const rainPoemActivity = ref<RainPoemActivityData | null>(null)
  const rainPoemLoading = ref(false)
  const rainPoemFriends = ref<{ gid: number, name: string, remark?: string, level?: number }[]>([])
  const rainPoemPrankLoading = ref(false)
  const rainPoemResearchLoading = ref(false)
  const rainPoemResearchNodeId = ref<number | null>(null)
  const qixiFriends = ref<QixiFriend[]>([])
  const qixiLoading = ref(false)
  const qixiBuildLoading = ref(false)
  const qixiGiftLoading = ref(false)
  const qixiDewLoading = ref(false)

  const heluLoading = ref(false)
  const drawLoading = ref(false)
  const exchangeLoading = ref(false)
  const passportClaimLoading = ref(false)
  const solarClaimLoading = ref(false)
  const starRecordClaimLoading = ref(false)
  const qingmeiClaimLoading = ref(false)
  const qingmeiSellLoading = ref(false)

  const redFlowerActivity = ref<RedFlowerActivityData | null>(null)
  const redFlowerLoading = ref(false)
  const wishSignActivity = ref<WishSignActivityData | null>(null)
  const wishSignLoading = ref(false)
  const wishSignOperateLoading = ref(false)
  const shareRewardActivity = ref<ShareRewardActivityData | null>(null)
  const shareRewardLoading = ref(false)
  const shareRewardOperateLoading = ref(false)
  const redFlowerLoveLoading = ref(false)
  const redFlowerFundLoading = ref(false)
  const redFlowerShareLoading = ref(false)
  const redFlowerTiersLoading = ref(false)

  // 奶茶热销中（S4）—— 按页缓存，避免切 tab 重复请求
  const milkTeaPages = ref<Record<string, MilkTeaActivityData>>({})
  const milkTeaLoading = ref(false)
  const milkTeaOperateLoading = ref(false)

  const heluError = ref('')

  let heluRequestId = 0

  function clearActivityData() {
    heluActivity.value = null
    qixiActivity.value = null
    rainPoemActivity.value = null
    qixiFriends.value = []
    qixiLoading.value = false
    qixiBuildLoading.value = false
    qixiGiftLoading.value = false
    qixiDewLoading.value = false
    rainPoemLoading.value = false
    rainPoemPrankLoading.value = false
    rainPoemResearchLoading.value = false
    rainPoemResearchNodeId.value = null
    heluLoading.value = false
    drawLoading.value = false
    exchangeLoading.value = false
    passportClaimLoading.value = false
    solarClaimLoading.value = false
    starRecordClaimLoading.value = false
    qingmeiClaimLoading.value = false
    qingmeiSellLoading.value = false
    redFlowerActivity.value = null
    redFlowerLoading.value = false
    redFlowerLoveLoading.value = false
    redFlowerFundLoading.value = false
    redFlowerShareLoading.value = false
    redFlowerTiersLoading.value = false
    milkTeaPages.value = {}
    milkTeaLoading.value = false
    milkTeaOperateLoading.value = false
    heluError.value = ''
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  async function fetchQixiActivity(accountId: string) {
    qixiLoading.value = true
    try {
      const { data } = await api.get('/api/activity/qixi', { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId))) {
        qixiActivity.value = data.activity || null
        qixiFriends.value = data.friends || []
      }
      return data
    }
    finally { qixiLoading.value = false }
  }

  async function fetchRainPoemActivity(accountId: string) {
    rainPoemLoading.value = true
    try {
      const { data } = await api.get('/api/activity/rain-poem', { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        rainPoemActivity.value = data.activity || null
      return data
    }
    finally { rainPoemLoading.value = false }
  }

  async function fetchRainPoemFriends(accountId: string) {
    try {
      const { data } = await api.get<{ ok: boolean, friends: { gid: number, name: string, remark?: string, level?: number }[] }>(
        '/api/activity/rain-poem/friends',
        { headers: { 'x-account-id': accountId } }
      )
      if (data.ok) rainPoemFriends.value = data.friends || []
      return data
    } catch (err) {
      rainPoemFriends.value = []
      return { ok: false, friends: [], error: (err as Error)?.message || '获取好友失败' }
    }
  }

  async function fetchRedFlowerActivity(accountId: string) {
    redFlowerLoading.value = true
    try {
      const { data } = await api.get('/api/activity/honghua', { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        redFlowerActivity.value = data.activity || null
      return data
    }
    finally { redFlowerLoading.value = false }
  }

  async function donateRedFlowerLove(accountId: string) {
    redFlowerLoveLoading.value = true
    try {
      const { data } = await api.post('/api/activity/honghua/love', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        await fetchRedFlowerActivity(accountId)
      return data
    }
    finally { redFlowerLoveLoading.value = false }
  }

  async function donateRedFlowerFund(accountId: string) {
    redFlowerFundLoading.value = true
    try {
      const { data } = await api.post('/api/activity/honghua/fund', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        await fetchRedFlowerActivity(accountId)
      return data
    }
    finally { redFlowerFundLoading.value = false }
  }

  async function claimRedFlowerShare(accountId: string) {
    redFlowerShareLoading.value = true
    try {
      const { data } = await api.post('/api/activity/honghua/share/claim', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        await fetchRedFlowerActivity(accountId)
      return data
    }
    finally { redFlowerShareLoading.value = false }
  }

  async function claimRedFlowerTiers(accountId: string) {
    redFlowerTiersLoading.value = true
    try {
      const { data } = await api.post('/api/activity/honghua/tiers/claim', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && isCurrentAccount(String(accountId)))
        await fetchRedFlowerActivity(accountId)
      return data
    }
    finally { redFlowerTiersLoading.value = false }
  }

  // 秋祈良愿
  async function fetchWishSignActivity(accountId: string) {
    wishSignLoading.value = true
    try {
      const { data } = await api.get('/api/activity/wish-sign', { headers: { 'x-account-id': accountId } })
      if (data.ok) wishSignActivity.value = data.data || null
      return data
    }
    catch (err) {
      wishSignActivity.value = null
      return { ok: false, error: (err as Error)?.message || '获取秋祈良愿活动失败' }
    }
    finally { wishSignLoading.value = false }
  }

  async function operateWishSignActivity(accountId: string, action: 'draw' | 'claim', chooseId = 1) {
    wishSignOperateLoading.value = true
    try {
      const { data } = await api.post('/api/activity/wish-sign/operate',
        { action, chooseId },
        { headers: { 'x-account-id': accountId } })
      if (data.ok && data.data) await fetchWishSignActivity(accountId)
      return data.data || data
    }
    catch (err) {
      return { ok: false, error: (err as Error)?.message || '操作失败' }
    }
    finally { wishSignOperateLoading.value = false }
  }

  // 快乐不独享
  async function fetchShareRewardActivity(accountId: string) {
    shareRewardLoading.value = true
    try {
      const { data } = await api.get('/api/activity/share-reward', { headers: { 'x-account-id': accountId } })
      if (data.ok) shareRewardActivity.value = data.data || null
      return data
    }
    catch (err) {
      shareRewardActivity.value = null
      return { ok: false, error: (err as Error)?.message || '获取快乐不独享活动失败' }
    }
    finally { shareRewardLoading.value = false }
  }

  async function operateShareRewardActivity(accountId: string, action: 'daily' | 'share' | 'milestones') {
    shareRewardOperateLoading.value = true
    try {
      const { data } = await api.post('/api/activity/share-reward/operate',
        { action },
        { headers: { 'x-account-id': accountId } })
      if (data?.ok) await fetchShareRewardActivity(accountId)
      return data.data || data
    }
    catch (err) {
      return { ok: false, error: (err as Error)?.message || '操作失败' }
    }
    finally { shareRewardOperateLoading.value = false }
  }

  // 奶茶热销中（S4）
  async function fetchMilkTeaActivity(accountId: string, page = 'shop', input: Record<string, unknown> = {}) {
    milkTeaLoading.value = true
    try {
      const { data } = await api.get('/api/activity/milk-tea/' + encodeURIComponent(page), {
        headers: { 'x-account-id': accountId },
        params: input,
      })
      const payload = (data?.data || null) as MilkTeaActivityData | null
      if (data?.ok && payload && isCurrentAccount(String(accountId)))
        milkTeaPages.value = { ...milkTeaPages.value, [page]: payload }
      return { ok: !!data?.ok, data: payload, error: data?.error }
    }
    catch (err) {
      return { ok: false, data: null, error: (err as Error)?.message || '获取奶茶热销中活动失败' }
    }
    finally { milkTeaLoading.value = false }
  }

  async function operateMilkTeaActivity(accountId: string, action: string, input: Record<string, unknown> = {}) {
    milkTeaOperateLoading.value = true
    try {
      const { data } = await api.post('/api/activity/milk-tea/operate',
        { action, input },
        { headers: { 'x-account-id': accountId } })
      return data?.data || data
    }
    catch (err) {
      return { ok: false, error: (err as Error)?.message || '操作失败' }
    }
    finally { milkTeaOperateLoading.value = false }
  }

  async function useRainPoemPrankOnFriend(accountId: string, friendGid: number, itemId: number, landId = 0) {
    rainPoemPrankLoading.value = true
    try {
      const { data } = await api.post<{ ok: boolean, itemId?: number, friendGid?: number, landId?: number, placed?: boolean, error?: string }>(
        '/api/activity/rain-poem/prank',
        { friendGid, itemId, landId },
        { headers: { 'x-account-id': accountId } }
      )
      if (data.ok) await fetchRainPoemActivity(accountId)
      return data
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || '使用失败' }
    } finally {
      rainPoemPrankLoading.value = false
    }
  }

  async function unlockRainPoemResearch(accountId: string, nodeId?: number) {
    rainPoemResearchLoading.value = true
    rainPoemResearchNodeId.value = nodeId ?? null
    try {
      const { data } = await api.post<{ ok: boolean, unlocked?: boolean, stageId?: number, error?: string }>(
        '/api/activity/rain-poem/research/unlock',
        { nodeId: nodeId ?? 0 },
        { headers: { 'x-account-id': accountId } }
      )
      if (data.ok) await fetchRainPoemActivity(accountId)
      return data
    } catch (err) {
      return { ok: false, error: (err as Error)?.message || '解锁失败' }
    } finally {
      rainPoemResearchLoading.value = false
      rainPoemResearchNodeId.value = null
    }
  }

  async function buildQixiBridge(accountId: string) {
    qixiBuildLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qixi/bridge/build', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && data.activity && isCurrentAccount(String(accountId)))
        qixiActivity.value = data.activity
      return data
    }
    finally { qixiBuildLoading.value = false }
  }
  async function useQixiDew(accountId: string) {
    qixiDewLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qixi/dew/use', {}, { headers: { 'x-account-id': accountId } })
      if (data.ok && data.activity && isCurrentAccount(String(accountId)))
        qixiActivity.value = data.activity
      return data
    }
    finally { qixiDewLoading.value = false }
  }

  async function sendQixiSachet(accountId: string, friendGid: number, count: number) {
    qixiGiftLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qixi/gift', { friendGid, count }, { headers: { 'x-account-id': accountId } })
      if (data.ok && data.activity && isCurrentAccount(String(accountId)))
        qixiActivity.value = data.activity
      return data
    }
    finally { qixiGiftLoading.value = false }
  }

  async function fetchHeluActivity(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++heluRequestId
    heluLoading.value = true
    heluError.value = ''
    try {
      const { data } = await api.get('/api/activity/star', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== heluRequestId || !isCurrentAccount(requestedId))
        return
      if (data.ok)
        heluActivity.value = data.activity || null
      else
        heluError.value = data.error || '获取心许千灯星垂野失败'
    }
    catch (err: any) {
      if (requestId === heluRequestId && isCurrentAccount(requestedId))
        heluError.value = err.message || '获取心许千灯星垂野失败'
    }
    finally {
      if (requestId === heluRequestId)
        heluLoading.value = false
    }
  }

  async function claimStarRecords(accountId: string) {
    const requestedId = String(accountId)
    starRecordClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/records/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      starRecordClaimLoading.value = false
    }
  }

  async function drawHelu(accountId: string, payload: { mode?: string, count?: number } = {}) {
    const requestedId = String(accountId)
    drawLoading.value = true
    try {
      const { data } = await api.post('/api/activity/helu/draw', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      drawLoading.value = false
    }
  }

  async function exchangeHelu(accountId: string, slotId: number, count: number) {
    const requestedId = String(accountId)
    exchangeLoading.value = true
    try {
      const { data } = await api.post('/api/activity/helu/exchange', {
        slotId,
        count,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      exchangeLoading.value = false
    }
  }

  async function exchangeStarSand(accountId: string, slotId: number, count: number) {
    const requestedId = String(accountId)
    exchangeLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/exchange', {
        slotId,
        count,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      exchangeLoading.value = false
    }
  }

  async function claimHeluPassport(accountId: string) {
    const requestedId = String(accountId)
    passportClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/passport/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      passportClaimLoading.value = false
    }
  }

  async function claimHeluSolar(accountId: string, termId?: number) {
    const requestedId = String(accountId)
    solarClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/star/solar/claim', {
        termId,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      solarClaimLoading.value = false
    }
  }

  async function claimQingmeiSeeds(accountId: string) {
    const requestedId = String(accountId)
    qingmeiClaimLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/claim', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity) {
        heluActivity.value = data.activity
      }
      return data
    }
    finally {
      qingmeiClaimLoading.value = false
    }
  }

  async function brewAndSellQingmeiWine(accountId: string) {
    const requestedId = String(accountId)
    qingmeiSellLoading.value = true
    try {
      const { data } = await api.post('/api/activity/qingmei/wine/sell', {
        share: true,
      }, {
        headers: { 'x-account-id': accountId },
      })
      if (isCurrentAccount(requestedId) && data.ok && data.activity)
        heluActivity.value = data.activity
      return data
    }
    finally {
      qingmeiSellLoading.value = false
    }
  }

  return {
    heluActivity,
    qixiActivity,
    rainPoemActivity,
    rainPoemLoading,
    rainPoemFriends,
    rainPoemPrankLoading,
    rainPoemResearchLoading,
    rainPoemResearchNodeId,
    qixiFriends,
    qixiLoading,
    qixiBuildLoading,
    qixiGiftLoading,
    qixiDewLoading,
    heluLoading,
    drawLoading,
    exchangeLoading,
    passportClaimLoading,
    solarClaimLoading,
    starRecordClaimLoading,
    qingmeiClaimLoading,
    qingmeiSellLoading,
    heluError,
    clearActivityData,
    fetchHeluActivity,
    fetchQixiActivity,
    fetchRainPoemActivity,
    fetchRainPoemFriends,
    useRainPoemPrankOnFriend,
    unlockRainPoemResearch,
    buildQixiBridge,
    useQixiDew,
    sendQixiSachet,
    claimStarRecords,
    drawHelu,
    exchangeHelu,
    exchangeStarSand,
    claimHeluPassport,
    claimHeluSolar,
    claimQingmeiSeeds,
    brewAndSellQingmeiWine,
    redFlowerActivity,
    redFlowerLoading,
    redFlowerLoveLoading,
    redFlowerFundLoading,
    redFlowerShareLoading,
    redFlowerTiersLoading,
    fetchRedFlowerActivity,
    donateRedFlowerLove,
    donateRedFlowerFund,
    claimRedFlowerShare,
    claimRedFlowerTiers,
    wishSignActivity,
    wishSignLoading,
    wishSignOperateLoading,
    fetchWishSignActivity,
    operateWishSignActivity,
    shareRewardActivity,
    shareRewardLoading,
    shareRewardOperateLoading,
    fetchShareRewardActivity,
    operateShareRewardActivity,
    milkTeaPages,
    milkTeaLoading,
    milkTeaOperateLoading,
    fetchMilkTeaActivity,
    operateMilkTeaActivity,
  }
})
