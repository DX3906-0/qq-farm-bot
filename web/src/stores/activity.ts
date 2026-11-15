import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import transport, { createReadCoordinator, isReadCanceled, invalidateSafeReads, readParamsKey, safeGet } from '@/api'
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
  active: boolean | null
  settling: boolean
  phase?: 'unknown' | 'upcoming' | 'business' | 'settling' | 'ended'
  page: string
  summary: MilkTeaSummary
  share?: {
    currentScore: number
    daily: { claimed: boolean, claimedCount: number, claimLimit: number, firstShareAwarded: boolean }
    redDots: { daily: boolean, milestone: boolean, firstShare: boolean }
    milestones: Array<{ tierId: number, state: number, claimable: boolean, rewards: HeluDrawReward[] }>
  }
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

  // 仅保存展示快照；每次重新进入页签仍读取，不把快照当健康缓存。
  const milkTeaPages = ref<Record<string, MilkTeaActivityData>>({})
  const milkTeaLoading = ref(false)
  const milkTeaOperateLoading = ref(false)

  const heluError = ref('')

  const accountStore = useAccountStore()
  const reads = createReadCoordinator()
  let accountEpoch = 0
  const loadingReaders = new Map<object, number>()
  function invalidateReads() {
    reads.invalidate()
    loadingReaders.clear()
    heluLoading.value = qixiLoading.value = rainPoemLoading.value = redFlowerLoading.value = wishSignLoading.value = shareRewardLoading.value = milkTeaLoading.value = false
  }
  let readSignal: AbortSignal | undefined
  const currentId = () => String(accountStore.currentAccountId || '')
  const valid = (id: string, epoch: number, version: number) => !!id && id === currentId() && epoch === accountEpoch && version === reads.epoch
  // 各函数的现有结果语义保留；读取消必须中断应用与后续阶段。
  const api = {
    async get<T = any>(path: string, config: any) {
      const id = String(config.headers['x-account-id'])
      const epoch = accountEpoch
      const version = reads.epoch
      const signal = config.signal || readSignal
      const response = await safeGet<T>(path, { ...config, signal }, version)
      if (!valid(id, epoch, version) || signal?.aborted)
        throw Object.assign(new Error('读取已取消'), { code: 'ERR_CANCELED' })
      return response
    },
  }
  function setReadSignal(signal?: AbortSignal) { readSignal = signal }
  watch(currentId, () => { accountEpoch++; clearActivityData() }, { flush: 'sync' })

  function clearActivityData() {
    invalidateReads()
    operatingCounts.clear()
    wishSignActivity.value = null
    shareRewardActivity.value = null
    wishSignLoading.value = false
    shareRewardLoading.value = false
    wishSignOperateLoading.value = false
    shareRewardOperateLoading.value = false
    rainPoemFriends.value = []
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

  let unsharedRead = 0
  function readActivity(accountId: string, path: string, loading: { value: boolean }, apply: (data: any) => void, params?: Record<string, unknown>, signal = readSignal): Promise<any> {
    const epoch = accountEpoch
    const version = reads.epoch
    const id = String(accountId)
    if (!valid(id, epoch, version)) return Promise.resolve({ ok: false, canceled: true })
    const unique = path.startsWith('/api/activity/rain-poem') ? ++unsharedRead : 0
    return reads.run(`${path}:${id}:${epoch}:${version}:${readParamsKey(params)}:${unique}`, async (shared) => {
      loadingReaders.set(loading, (loadingReaders.get(loading) || 0) + 1)
      loading.value = true
      try {
        const { data } = await api.get(path, { headers: { 'x-account-id': id }, params, signal: shared })
        if (!valid(id, epoch, version) || shared.aborted) return { ok: false, canceled: true, error: undefined }
        if (!data?.ok) throw new Error(data?.error || '获取活动失败')
        apply(data)
        return data
      }
      finally {
        if (valid(id, epoch, version)) {
          const count = Math.max(0, (loadingReaders.get(loading) || 1) - 1)
          loadingReaders.set(loading, count)
          loading.value = count > 0
        }
      }
    }, signal)
  }
  function fetchQixiActivity(accountId: string, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/qixi', qixiLoading, (data) => {
      if (!data.activity) throw new Error('鹊桥响应不完整')
      qixiActivity.value = data.activity
      qixiFriends.value = data.friends || []
    }, undefined, signal || readSignal)
  }

  function fetchRainPoemActivity(accountId: string, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/rain-poem', rainPoemLoading, (data) => {
      if (!data.activity) throw new Error('雨落成诗响应不完整')
      rainPoemActivity.value = data.activity
    }, undefined, signal || readSignal)
  }

  async function fetchRainPoemFriends(accountId: string) {
    const epoch = accountEpoch
    try {
      const { data } = await api.get<{ ok: boolean, friends: { gid: number, name: string, remark?: string, level?: number }[] }>(
        '/api/activity/rain-poem/friends',
        { headers: { 'x-account-id': accountId } }
      )
      if (!data?.ok || !Array.isArray(data.friends)) throw new Error('好友响应不完整')
      rainPoemFriends.value = data.friends
      return data
    } catch (err) {
      if (isReadCanceled(err)) return { ok: false, friends: [], canceled: true }
      if (epoch === accountEpoch && isCurrentAccount(accountId)) rainPoemFriends.value = []
      return { ok: false, friends: [], error: (err as Error)?.message || '获取好友失败' }
    }
  }

  function fetchRedFlowerActivity(accountId: string, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/honghua', redFlowerLoading, (data) => {
      if (!data.activity) throw new Error('小红花响应不完整')
      redFlowerActivity.value = data.activity
    }, undefined, signal || readSignal)
  }

  const operatingCounts = new Map<object, number>()
  let writeEpoch = 0
  async function operate(accountId: string, path: string, body: unknown, loading: { value: boolean }, apply?: (data: any) => void, refresh?: (signal?: AbortSignal) => Promise<any>, unwrap = false): Promise<any> {
    const id = String(accountId)
    const epoch = accountEpoch
    const signal = readSignal
    const current = () => !!id && id === currentId() && epoch === accountEpoch
    const active = () => current() && !signal?.aborted
    if (!active()) return { ok: false, canceled: true }
    const count = (operatingCounts.get(loading) || 0) + 1
    operatingCounts.set(loading, count)
    loading.value = true
    const write = ++writeEpoch
    invalidateSafeReads()
    invalidateReads()
    try {
      // 只取消后续读与展示，绝不取消已经提交的写。
      const { data } = await transport.post(path, body, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!active()) return { ok: false, canceled: true }
      if (write !== writeEpoch) return data?.ok ? { ...data, stale: true } : { ok: false, error: data?.error || '操作失败' }
      invalidateReads()
      if (data?.ok) {
        apply?.(data)
        if (refresh && active()) await refresh(signal)
      }
      const result = unwrap && data?.ok ? data.data || data : data
      return result && typeof result.ok === 'boolean' ? result : { ok: false, error: data?.error || '操作响应不完整' }
    }
    catch (error: any) {
      if (!active() || isReadCanceled(error)) return { ok: false, canceled: true }
      return { ok: false, error: error?.response?.data?.error || error?.message || '操作失败' }
    }
    finally {
      invalidateSafeReads()
      if (current()) {
        if (write === writeEpoch) invalidateReads()
        const remaining = Math.max(0, (operatingCounts.get(loading) || 1) - 1)
        operatingCounts.set(loading, remaining)
        loading.value = remaining > 0
      }
    }
  }
  const donateRedFlowerLove = (id: string) => operate(id, '/api/activity/honghua/love', {}, redFlowerLoveLoading, undefined, signal => fetchRedFlowerActivity(id, signal))
  const donateRedFlowerFund = (id: string) => operate(id, '/api/activity/honghua/fund', {}, redFlowerFundLoading, undefined, signal => fetchRedFlowerActivity(id, signal))
  const claimRedFlowerShare = (id: string) => operate(id, '/api/activity/honghua/share/claim', {}, redFlowerShareLoading, undefined, signal => fetchRedFlowerActivity(id, signal))
  const claimRedFlowerTiers = (id: string) => operate(id, '/api/activity/honghua/tiers/claim', {}, redFlowerTiersLoading, undefined, signal => fetchRedFlowerActivity(id, signal))

  // 秋祈良愿
  function fetchWishSignActivity(accountId: string, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/wish-sign', wishSignLoading, (data) => {
      if (!data.data) throw new Error('秋祈良愿响应不完整')
      wishSignActivity.value = data.data
    }, undefined, signal || readSignal)
  }

  const operateWishSignActivity = (id: string, action: 'draw' | 'claim', chooseId = 1) =>
    operate(id, '/api/activity/wish-sign/operate', { action, chooseId }, wishSignOperateLoading, undefined, signal => fetchWishSignActivity(id, signal), true)

  // 快乐不独享
  function fetchShareRewardActivity(accountId: string, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/share-reward', shareRewardLoading, (data) => {
      if (!data.data) throw new Error('分享活动响应不完整')
      shareRewardActivity.value = data.data
    }, undefined, signal || readSignal)
  }

  const operateShareRewardActivity = (id: string, action: 'daily' | 'share' | 'milestones') =>
    operate(id, '/api/activity/share-reward/operate', { action }, shareRewardOperateLoading, undefined, signal => fetchShareRewardActivity(id, signal), true)

  // 奶茶热销中（S4）
  function fetchMilkTeaActivity(accountId: string, page = 'shop', input: Record<string, unknown> = {}, signal?: AbortSignal) {
    return readActivity(accountId, '/api/activity/milk-tea/' + encodeURIComponent(page), milkTeaLoading, (data) => {
      if (!data.data) throw new Error('奶茶响应不完整')
      milkTeaPages.value = { ...milkTeaPages.value, [page]: data.data }
    }, input, signal || readSignal)
  }

  const operateMilkTeaActivity = (id: string, action: string, input: Record<string, unknown> = {}) =>
    operate(id, '/api/activity/milk-tea/operate', { action, input }, milkTeaOperateLoading, undefined, undefined, true)

  const useRainPoemPrankOnFriend = (id: string, friendGid: number, itemId: number, landId = 0) =>
    operate(id, '/api/activity/rain-poem/prank', { friendGid, itemId, landId }, rainPoemPrankLoading, undefined, signal => fetchRainPoemActivity(id, signal))

  let researchRequest = 0
  async function unlockRainPoemResearch(id: string, nodeId?: number) {
    const epoch = accountEpoch
    const request = ++researchRequest
    rainPoemResearchNodeId.value = nodeId ?? null
    try {
      return await operate(id, '/api/activity/rain-poem/research/unlock', { nodeId: nodeId ?? 0 }, rainPoemResearchLoading, undefined, signal => fetchRainPoemActivity(id, signal))
    }
    finally {
      if (epoch === accountEpoch && request === researchRequest) rainPoemResearchNodeId.value = null
    }
  }
  const applyQixi = (data: any) => { if (data.activity) qixiActivity.value = data.activity }
  const buildQixiBridge = (id: string) => operate(id, '/api/activity/qixi/bridge/build', {}, qixiBuildLoading, applyQixi)
  const useQixiDew = (id: string) => operate(id, '/api/activity/qixi/dew/use', {}, qixiDewLoading, applyQixi)
  const sendQixiSachet = (id: string, friendGid: number, count: number) => operate(id, '/api/activity/qixi/gift', { friendGid, count }, qixiGiftLoading, applyQixi)

  function fetchHeluActivity(accountId: string, signal?: AbortSignal) {
    const epoch = accountEpoch
    const version = reads.epoch
    heluError.value = ''
    // 【2026-11-08】原先请求 /api/activity/star（心许千灯星垂野）。该活动已于 2026-08-28
    // 整树下线，接口只会回 warning + 空 solarTerms（terms=0），页面因此显示
    // 「活动已结束或不存在」且节令面板「暂无数据」。
    // 节令小札实际由独立的 SolarTermsService 提供，挂在荷风游记(helu)接口上，改读 /api/activity/helu。
    return readActivity(accountId, '/api/activity/helu', heluLoading, (data) => {
      if (!data.activity) throw new Error('荷风游记响应不完整')
      heluActivity.value = data.activity
    }, undefined, signal || readSignal).catch((err) => {
      if (valid(accountId, epoch, version) && !isReadCanceled(err)) heluError.value = err.message || '获取节令小札失败'
      throw err
    })
  }

  const applyStar = (data: any) => { if (data.activity) heluActivity.value = data.activity }
  const claimStarRecords = (id: string) => operate(id, '/api/activity/star/records/claim', {}, starRecordClaimLoading, applyStar)
  const drawHelu = (id: string, payload: { mode?: string, count?: number } = {}) => operate(id, '/api/activity/helu/draw', payload, drawLoading, applyStar)
  const exchangeHelu = (id: string, slotId: number, count: number) => operate(id, '/api/activity/helu/exchange', { slotId, count }, exchangeLoading, applyStar)
  const exchangeStarSand = (id: string, slotId: number, count: number) => operate(id, '/api/activity/star/exchange', { slotId, count }, exchangeLoading, applyStar)
  const claimHeluPassport = (id: string) => operate(id, '/api/activity/star/passport/claim', {}, passportClaimLoading, applyStar)
  // 节令领取同步改走 helu 路由：/api/activity/star/* 属于已下线的千灯活动，
  // 与读取（fetchHeluActivity）必须指向同一活动，否则面板能显示却点不动。
  const claimHeluSolar = (id: string, termId?: number) => operate(id, '/api/activity/helu/solar/claim', { termId }, solarClaimLoading, applyStar)
  const claimQingmeiSeeds = (id: string) => operate(id, '/api/activity/qingmei/claim', {}, qingmeiClaimLoading, applyStar)
  const brewAndSellQingmeiWine = (id: string) => operate(id, '/api/activity/qingmei/wine/sell', { share: true }, qingmeiSellLoading, applyStar)

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
    setReadSignal,
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
