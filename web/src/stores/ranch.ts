import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useAccountStore } from '@/stores/account'
import { operationFailure, resultIsUnknown } from '@/utils/operation-result'

export interface RanchAnimal {
  instanceId: number
  animalId: string
  slot: number
  name: string
  image: string
  imageRole?: string
  stage: number
  stageName?: string
  maxProduceCount?: number | null
  limitedCanUsed?: boolean
  expectedHarvest?: { exp: string, items: RanchProgressReward[] }
  expectedProduce?: { exp: string, items: RanchProgressReward[] }
  produceCount: number
  canHarvest: boolean
  canProduce: boolean
  canFeed: boolean
  canRelease: boolean
  grassBlocked: boolean
  producing: boolean
  nextAtMs: number | null
  mutation: null | { type: number, tier: number, weightX10: number, strokable: boolean }
}

export interface RanchFacility {
  id: string
  facilityId: number
  moduleType: number
  name: string
  image: string
  level: number
  capacity: number
  state: number
  upgradeState: number
  upgradeEndAtMs: number | null
  nextUpgrade: null | { facilityId: number, level: number, capacity: number, requiredLevel: number, durationSec: number }
  position: { x: number, y: number }
  feedMachine: null | { count: number, consumeRate: number, remainingSec: number, status: number }
  ranch: null | {
    id: string
    husbandryType: number
    capacity: number
    animalCount: number
    grass: { amount: string, emptyAtMs: number | null }
    hazardCount: number
    shelfCount: number
    shelves?: Array<{ slot: number, totalRemain: string, canCollect: boolean, products: RanchProgressReward[] }>
    hazards?: Array<{ id: string, type: number, ownerGid: string }>
    animals: RanchAnimal[]
  }
}

export interface RanchOverview {
  readOnly: true
  actionsEnabled: true
  sceneId: number
  observedAt: number
  serverTimeMs: number | null
  source: { repository: string, commit: string }
  grid: { width: number, height: number, cellCount: number, openCellCount: number, regionOccupied: number, regionQuota: number }
  summary: { facilityCount: number, ranchCount: number, animalCount: number, harvestableCount: number, grassBlockedCount: number }
  facilities: RanchFacility[]
  cells?: Array<{ id: string, x: number, y: number, status: number, regionId: number, occupiedBy: string, unlockEndAtMs: number | null }>
  buildingItems?: Array<{ id: string, facilityId: number, level: number, upgradeState: number, image: string }>
  layoutActionsEnabled?: false
  cache: { hit: boolean, receivedAt: number }
}

export interface RanchFriendAnimal {
  instanceId: number
  animalId: string
  name: string
  stage: number
  stroked: boolean
  canStroke: boolean
  mutation: null | { type: number, tier: number, strokable: boolean }
}

export interface RanchFriendShelf {
  slot: number
  canSteal: boolean
  products: Array<{ id: string, count: string, canSteal: boolean }>
}

export interface RanchFriendPen {
  id: string
  husbandryType: number
  name: string
  capacity: number
  animalCount: number
  mosquitoes: number
  mosquitoLimit: number
  mosquitoRoom: number
  canPutMosquito: boolean
  hazardCount: number
  cleanableHazardCount: number
  animals: RanchFriendAnimal[]
  shelves: RanchFriendShelf[]
}

export interface RanchFriendOverview {
  gid: string
  name: string
  level: number
  hostAtHome: boolean
  tourist: boolean
  observedAt: number
  remaining: { stroke: number, putMosquito: number }
  summary: { ranchCount: number, animalCount: number, stealableShelfCount: number, cleanableHazardCount: number, strokableCount: number, mosquitoRoom: number }
  ranches: RanchFriendPen[]
  cache: { hit: boolean, receivedAt: number }
}

export interface RanchQuote {
  action: string
  label: string
  count: number
  skipped: boolean
  costs: Array<{ id: string, count: string, name?: string, unit?: string }>
  rewards: Array<{ id: string, count: string, name?: string, unit?: string }>
  expected: { signature: string }
  message: string
  pendingBlocked: boolean
}

export interface RanchCatalogGood {
  id: number
  itemId: number
  itemCount: number
  name: string
  image?: string
  currencyId: number
  currencyBalance: string
  unitPrice: number
  maxCount: number
  remaining: number | null
  available: boolean
  unlocked: boolean
  owned: boolean
  valid: boolean
  discounted: boolean
}

export interface RanchBagItem {
  id: string
  uid: string
  name: string
  image?: string
  count: string
  availableCount: string
  availableTypeCount: string
  type: number
  locked: boolean
  category: 'can' | 'cub' | 'product' | 'grass' | 'other'
  can: null | { bucketId: number, seconds: number, family: string }
  animal: null | { id: number, husbandryType: number, giantCub: boolean }
  canUseCan: boolean
  canPlace: boolean
  product: null | { weightX10: number, tier: number }
}

export interface RanchBagOverview {
  readOnly: true
  sceneId: number
  receivedAt: number
  cacheHit: boolean
  level: null | { level: number, exp: string, currentExp: string, neededExp: string | null }
  items: RanchBagItem[]
  goldVoucherBalance: string
  pens: Array<{ id: string, name: string, husbandryType: number, capacity: number, animalCount: number, room: number }>
  buckets: { normal: string, organic: string }
}

export interface RanchCanGood {
  id: string
  name: string
  rewards: Array<{ id: string, count: string, name?: string }>
  currencyId: number
  unitPrice: string
  currencyBalance: string | null
  free: boolean
  remaining: number | null
  maxCount: number
  available: boolean
  stateReason: string
}

export type RanchCoreProgressSection = 'tasks' | 'book' | 'share'
export type RanchProgressSection = RanchCoreProgressSection | 'market' | 'activities'
export interface RanchProgressBase {
  readOnly: true
  sceneId: 2
  ownerGid: string
  observedAt: number
  dateKey: string
  serverTimeMs: number
  sourceCommit: string
  cache: { hit: boolean, receivedAt: number }
}
export interface RanchProgressReward { id: string, count: string, name?: string, image?: string }
export interface RanchTaskView extends RanchProgressBase {
  tasks: Array<{ id: string, category: 'growth' | 'daily' | 'other', description: string, progress: string, total: string,
    group: string, claimed: boolean, unlocked: boolean, configConfirmed: boolean, shareMultiple: string, condition: string,
    rewards: RanchProgressReward[], extraRewards: RanchProgressReward[], canClaim: boolean, stateReason: string }>
  summary: { total: number, claimable: number, claimed: number, daily: number }
  guideReportingEnabled: false
  automaticClaimEnabled: false
}
export interface RanchBookLevel { id: number, need: number | string, claimed: boolean, canClaim: boolean, rewards: RanchProgressReward[] }
export interface RanchBookView extends RanchProgressBase {
  type: 101
  animals: Array<{ id: string, name: string, image?: string, rarity: number, layer: number, progress: number, unlocked: boolean, isNew: boolean,
    giant: null | { unlocked: boolean, tier: number, tierName: string, bestWeightKg: number, minWeightKg: number, maxWeightKg: number, harvestCount: string, isNew: boolean },
    giantItem: null | { id: string, name: string, image: string } }>
  normal: { currentLevel: number, totalProgress: number, nextProgress: number, levels: RanchBookLevel[],
    rewards: RanchProgressReward[], rewardStatusConfirmed: boolean, canClaim: boolean, stateReason: string }
  giant: { totalScore: string, currentId: number, calculationMode: number, levels: RanchBookLevel[] }
  mutations: Array<{ type: number, name: string, description: string, baseProbabilityPercent: number }>
}
export interface RanchShareView extends RanchProgressBase {
  shareId: '102'
  docId: string
  known: boolean
  shareCount: string | null
  claimed: boolean | null
  shared: boolean
  canReport: boolean
  canClaim: boolean
  rewards: RanchProgressReward[]
  automaticShareEnabled: false
  stateReason: string
}
export interface RanchMarketGood {
  id: string
  shelfId: number
  slot: number
  name: string
  reward: RanchProgressReward & { image?: string }
  currencyId: string
  currencyName: string
  currencyImage: string
  unitPrice: string
  currencyBalance: string
  remaining: string | null
  maxCount: number
  limitUsed: string
  available: boolean
  discounted: boolean
  priceValidUntilMs: number | null
  requiredLevel: number | null
  stateReason: string
}
export interface RanchMarketView extends RanchProgressBase {
  shopId: 7
  opened: boolean
  present: boolean
  periodDay: string
  roundIndex: number
  shelves: Array<{ id: number, name: string, sort: number }>
  goods: RanchMarketGood[]
  automaticExchangeEnabled: false
}
export interface RanchActivityNode {
  id: string
  name: string
  parentId: string
  groupId: string
  type: string
  beginTimeMs: number | null
  endTimeMs: number | null
  actionsEnabled: false
  progressState: 'unconfirmed'
  children: RanchActivityNode[]
}
export interface RanchMugeReward { id: string, count: string, name: string, image: string }
export interface RanchMugeTier { id: string, threshold: string, status: number, rewards: RanchMugeReward[] }
export interface RanchMugeTask { id: string, description: string, progress: string, target: string, status: number, unlockDay: number, points: number, rewards: RanchMugeReward[] }
export interface RanchMugeActivity {
  activityId: string, title: string, serverTime: number, startTime: number, endTime: number, active: boolean, rules: string[]
  sections: Record<string, string>
  celebration: null | { total: string, tiers: RanchMugeTier[] }
  friends: null | { count: number, tiers: RanchMugeTier[] }
  handbook: null | { points: string, tiers: RanchMugeTier[], tasks: RanchMugeTask[] }
  personality: null | { answers: Record<string, string>, personalityId: string, settleCount: string, image: string, shareRewardClaimed: boolean }
  questions: Array<{ id: number, title: string, options: Array<{ value: number, text: string, label: string }> }>
}
export interface RanchActivitiesView extends RanchProgressBase {
  activities: RanchActivityNode[]
  detail: RanchActivityNode | null
  actionsEnabled: false
  notice: string
  muge: RanchMugeActivity | null
  mugeError: string
  guide: { title: string, description: string, begin: string, endExclusive: string, bulletinId: number,
    sections: Array<{ name: string, description: string }>, notice: string }
}
export interface RanchProgressViews { tasks: RanchTaskView, book: RanchBookView, share: RanchShareView, market: RanchMarketView, activities: RanchActivitiesView }
export interface RanchLastSummary { accountId: string, observedAt: number, stale: boolean, summary: RanchOverview['summary'] }

export interface RanchOperationRecord {
  id: string
  target: string
  label: string
  costs: Array<{ resourceKey: string, amount: string }>
  createdAt: number
  message: string
}

type RanchOperationState = 'idle' | 'pending' | 'unknown'
export interface RanchActionResponse {
  ok: boolean
  error?: string
  stale?: boolean
  data?: any
  quote?: RanchQuote
  resultState?: string
  sent?: boolean
  outcomeUnknown?: boolean
}

export const RANCH_CURRENCY_NAMES: Record<string, string> = {
  '1001': '金币', '1002': '点券', '1004': '钻石', '1005': '金豆豆', '1007': '金券',
  '1008': '松果', '1102': '牧场经验', '7001': '牧草', '7002': '便便', '7003': '普通罐头桶', '7004': '有机罐头桶',
}

export function ranchItemLabel(id: string) {
  return RANCH_CURRENCY_NAMES[String(id)] || `物品 #${id}`
}

export const useRanchStore = defineStore('ranch', () => {
  const accountStore = useAccountStore()
  const overview = ref<RanchOverview | null>(null)
  const loading = ref(false)
  const error = ref('')
  const loadedAccountId = ref('')
  const friendOverview = ref<RanchFriendOverview | null>(null)
  const friendLoading = ref(false)
  const friendError = ref('')
  const operations = ref<RanchOperationRecord[]>([])
  const operationsLoading = ref(false)
  const operationsReady = ref(false)
  const operationsError = ref('')
  const catalogs = ref<Record<number, RanchCatalogGood[]>>({})
  const catalogLoading = ref<Record<number, boolean>>({})
  const catalogErrors = ref<Record<number, string>>({})
  const bagOverview = ref<RanchBagOverview | null>(null)
  const bagLoading = ref(false)
  const bagError = ref('')
  const canCatalogs = ref<Record<number, RanchCanGood[]>>({})
  const canLoading = ref<Record<number, boolean>>({})
  const canErrors = ref<Record<number, string>>({})
  const progressViews = ref<Partial<RanchProgressViews>>({})
  const progressLoading = ref<Partial<Record<RanchProgressSection, boolean>>>({})
  const progressErrors = ref<Partial<Record<RanchProgressSection, string>>>({})
  // Overview displays only a labelled last observation, never a fabricated live ranch state.
  const lastSummaries = ref<Record<string, RanchLastSummary>>({})
  const progressControllers = new Map<RanchProgressSection, AbortController>()
  let progressGeneration = 0
  let bagRequestId = 0
  let canGeneration = 0
  let bagController: AbortController | null = null
  const notice = ref('')
  const interfaceLogsByAccount = ref<Record<string, Array<{ ts: number, tag: string, msg: string, isWarn: boolean, recordId?: string, meta: { module: string, event: string, result: string, source: string } }>>>({})
  const interfaceLogs = computed(() => interfaceLogsByAccount.value[String(accountStore.currentAccountId || '')] || [])
  function appendInterfaceLog(accountId: string, event: string, message: string, result = 'error', recordId?: string) {
    if (!accountId || !isCurrentAccount(accountId) || !message) return
    const msg = String(message).replace(/([?&](?:token|password|code|ticket)=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 500)
    const entries = interfaceLogsByAccount.value[accountId] || []
    if (entries.some(entry => entry.meta.event === event && entry.msg === msg && entry.recordId === recordId)) return
    interfaceLogsByAccount.value = { ...interfaceLogsByAccount.value, [accountId]: [...entries, {
      ts: Date.now(), tag: '牧场', msg, isWarn: result === 'error' || result === 'unknown', recordId,
      meta: { module: 'ranch', event, result, source: 'frontend' },
    }].slice(-100) }
    const ids = Object.keys(interfaceLogsByAccount.value)
    if (ids.length > 20) delete interfaceLogsByAccount.value[ids.find(id => id !== accountId)!]
  }
  const operationStates = ref<Record<string, RanchOperationState>>({})
  const operationFlights = new Map<string, Promise<RanchActionResponse>>()
  const acknowledgementFlights = new Set<string>()
  const clientUnknown = new Set<string>()
  const serverBlocked = new Map<string, boolean>()
  const currentState = computed(() => {
    const id = String(accountStore.currentAccountId || '')
    const local = operationStates.value[id] || 'idle'
    return local === 'idle' && operationsReady.value && operations.value.length > 0 ? 'unknown' : local
  })
  const operating = computed(() => currentState.value === 'pending')
  // Known ledger records are target/resource-scoped on the server. Do not
  // disable unrelated purchases just because another operation is unknown.
  // Keep account writes disabled only while a write is live, the safety
  // snapshot is unread/unavailable, or the scene/friend session needs recovery.
  const writeBlocked = computed(() => {
    const id = String(accountStore.currentAccountId || '')
    return operationStates.value[id] === 'pending' || !operationsReady.value || serverBlocked.get(id) === true
        || clientUnknown.has(id) && operations.value.length === 0
  })
  function hasPendingConflict(target: string, resourceKeys: string[] = []) {
    const keys = new Set(resourceKeys.map(String))
    return operations.value.some(row => row.target === target || row.costs?.some(cost => keys.has(cost.resourceKey)))
  }
  let viewEpoch = 0
  let requestId = 0
  let friendRequestId = 0
  const friends = ref<Array<{ gid: number, name: string, avatarUrl: string }>>([])
  const friendsLoading = ref(false)
  const friendsError = ref('')
  let rosterRequestId = 0
  let rosterController: AbortController | null = null
  let operationsRequestId = 0
  let catalogGeneration = 0
  let quoteRequestId = 0
  let controller: AbortController | null = null
  let friendController: AbortController | null = null
  let quoteController: AbortController | null = null

  function isCurrentAccount(id: string) {
    return String(accountStore.currentAccountId || '') === String(id)
  }

  function current(id: string, epoch: number) {
    return epoch === viewEpoch && isCurrentAccount(id)
  }

  function setOperationState(id: string, state: RanchOperationState) {
    operationStates.value = { ...operationStates.value, [id]: state }
  }

  function refreshOperationState(id: string) {
    setOperationState(id, operationFlights.has(id) ? 'pending'
      : clientUnknown.has(id) || serverBlocked.get(id) === true ? 'unknown' : 'idle')
  }

  function clearFriend() {
    friendRequestId++
    friendController?.abort()
    friendController = null
    friendOverview.value = null
    friendLoading.value = false
    friendError.value = ''
  }

  function cancelQuote() {
    quoteRequestId++
    quoteController?.abort()
    quoteController = null
  }

  function invalidateGameReads() {
    requestId++
    friendRequestId++
    rosterRequestId++
    rosterController?.abort()
    rosterController = null
    friendsLoading.value = false
    operationsRequestId++
    operationsReady.value = false
    catalogGeneration++
    bagRequestId++
    canGeneration++
    progressGeneration++
    for (const pending of progressControllers.values()) pending.abort()
    progressControllers.clear()
    progressLoading.value = {}
    controller?.abort()
    friendController?.abort()
    bagController?.abort()
    controller = null
    friendController = null
    loading.value = false
    friendLoading.value = false
    operationsLoading.value = false
    catalogLoading.value = {}
    bagLoading.value = false
    canLoading.value = {}
    bagController = null
    invalidateSafeReads()
  }

  // 清的是当前页面快照，不清每账号在途写和未知状态。
  function clear() {
    viewEpoch++
    invalidateGameReads()
    cancelQuote()
    overview.value = null
    friendOverview.value = null
    loading.value = false
    error.value = ''
    friendError.value = ''
    friends.value = []
    friendsError.value = ''
    loadedAccountId.value = ''
    operations.value = []
    operationsReady.value = false
    operationsError.value = ''
    catalogs.value = {}
    catalogErrors.value = {}
    bagOverview.value = null
    bagError.value = ''
    canCatalogs.value = {}
    canErrors.value = {}
    progressViews.value = {}
    progressErrors.value = {}
    notice.value = ''
  }

  watch(() => String(accountStore.currentAccountId || ''), clear, { flush: 'sync' })

  async function fetchOverview(accountId: string) {
    if (!accountId || !isCurrentAccount(accountId)) return
    const requestedId = String(accountId)
    const epoch = viewEpoch
    const rid = ++requestId
    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    loading.value = true
    error.value = ''
    try {
      const { data } = await safeGet<{ ok: boolean, accountId: string, data: RanchOverview, error?: string }>('/api/ranch', {
        headers: { 'x-account-id': requestedId }, timeout: 165000,
        signal: requestController.signal, skipErrorToast: true,
      } as any, rid)
      if (rid !== requestId || !current(requestedId, epoch)) return
      if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.readOnly !== true || data.data?.actionsEnabled !== true
        || data.data?.sceneId !== 2 || !data.data?.summary || !Array.isArray(data.data?.facilities)
        || !Number.isFinite(data.data?.observedAt))
        throw new Error(data?.error || '牧场只读数据未确认')
      overview.value = data.data
      loadedAccountId.value = requestedId
      lastSummaries.value = { ...lastSummaries.value, [requestedId]: { accountId: requestedId,
        observedAt: data.data.observedAt, stale: false, summary: { ...data.data.summary } } }
    }
    catch (cause: any) {
      if (rid !== requestId || !current(requestedId, epoch) || isReadCanceled(cause)) return
      error.value = cause?.response?.data?.error || cause?.message || '获取牧场数据失败'
    }
    finally {
      if (rid === requestId && current(requestedId, epoch)) {
        loading.value = false
        if (controller === requestController) controller = null
      }
    }
  }

  async function fetchFriends(accountId: string) {
    if (!accountId || !isCurrentAccount(accountId)) return
    const requestedId = String(accountId), epoch = viewEpoch, rid = ++rosterRequestId
    rosterController?.abort()
    const requestController = new AbortController()
    rosterController = requestController
    friendsLoading.value = true
    friendsError.value = ''
    try {
      const { data } = await api.get('/api/ranch/friends', { headers: { 'x-account-id': requestedId }, timeout: 165000,
        signal: requestController.signal, skipErrorToast: true } as any)
      if (rid !== rosterRequestId || !current(requestedId, epoch)) return
      const value = data?.data
      if (!data?.ok || String(data.accountId || '') !== requestedId || value?.sceneId !== 2 || !/^[1-9]\d*$/.test(String(value.ownerGid || ''))
        || !Number.isFinite(value.observedAt) || !Array.isArray(value.friends)
        || value.friends.some((row: any) => !Number.isSafeInteger(row.gid) || row.gid <= 0 || typeof row.name !== 'string')
        || new Set(value.friends.map((row: any) => row.gid)).size !== value.friends.length)
        throw new Error('牧场好友名单场景或结构未确认')
      friends.value = value.friends
    }
    catch (cause: any) {
      if (rid !== rosterRequestId || !current(requestedId, epoch) || isReadCanceled(cause)) return
      friends.value = []
      friendsError.value = cause?.response?.data?.error || cause?.message || '获取牧场好友名单失败'
    }
    finally {
      if (rid === rosterRequestId && current(requestedId, epoch)) {
        friendsLoading.value = false
        if (rosterController === requestController) rosterController = null
      }
    }
  }

  async function fetchFriend(accountId: string, gid: number) {
    if (!accountId || !isCurrentAccount(accountId) || !Number.isSafeInteger(gid) || gid <= 0) return
    const requestedId = String(accountId)
    const requestedGid = String(gid)
    const epoch = viewEpoch
    const rid = ++friendRequestId
    friendController?.abort()
    const requestController = new AbortController()
    friendController = requestController
    if (friendOverview.value?.gid !== requestedGid) friendOverview.value = null
    friendLoading.value = true
    friendError.value = ''
    try {
      const { data } = await api.get('/api/ranch/friend', {
        headers: { 'x-account-id': requestedId }, params: { gid }, timeout: 165000,
        signal: requestController.signal, skipErrorToast: true,
      } as any)
      if (rid !== friendRequestId || !current(requestedId, epoch)) return
      if (!data?.ok || String(data.accountId || '') !== requestedId || String(data.data?.gid || '') !== requestedGid)
        throw new Error(data?.error || '好友牧场数据未确认')
      friendOverview.value = data.data as RanchFriendOverview
    }
    catch (cause: any) {
      if (rid !== friendRequestId || !current(requestedId, epoch) || isReadCanceled(cause)) return
      friendError.value = cause?.response?.data?.error || cause?.message || '获取好友牧场失败'
    }
    finally {
      if (rid === friendRequestId && current(requestedId, epoch)) {
        friendLoading.value = false
        if (friendController === requestController) friendController = null
      }
    }
  }

  async function fetchOperations(accountId: string) {
    if (!accountId || !isCurrentAccount(accountId)) return { ok: false, safe: false }
    const requestedId = String(accountId)
    const epoch = viewEpoch
    const rid = ++operationsRequestId
    operationsLoading.value = true
    operationsError.value = ''
    try {
      const { data } = await safeGet<any>('/api/ranch/operations', {
        headers: { 'x-account-id': requestedId }, timeout: 30000, skipErrorToast: true,
      } as any, rid)
      if (rid !== operationsRequestId || !current(requestedId, epoch)) return { ok: false, safe: false }
      if (!data?.ok || String(data.accountId || '') !== requestedId || !Array.isArray(data.data?.pending)
        || typeof data.data?.scene?.recoveryRequired !== 'boolean'
        || typeof data.data?.friendSession?.recoveryRequired !== 'boolean') {
        throw new Error(data?.error || '待核对记录或离场状态未完整返回')
      }
      operations.value = data.data.pending
      operationsReady.value = true
      const blocked = data.data.scene.recoveryRequired || data.data.friendSession.recoveryRequired
      serverBlocked.set(requestedId, blocked)
      refreshOperationState(requestedId)
      return { ok: true, safe: !blocked && data.data.scene.phase === 'home' && data.data.friendSession.phase === 'idle' }
    }
    catch (cause: any) {
      if (rid === operationsRequestId && current(requestedId, epoch) && !isReadCanceled(cause)) {
        operationsReady.value = false
        operationsError.value = cause?.response?.data?.error || cause?.message || '待核对记录读取失败'
      }
      return { ok: false, safe: false }
    }
    finally {
      if (rid === operationsRequestId && current(requestedId, epoch)) operationsLoading.value = false
    }
  }

  async function fetchCatalog(accountId: string, shopId: 5 | 6) {
    if (!accountId || !isCurrentAccount(accountId) || ![5, 6].includes(shopId) || catalogLoading.value[shopId]) return
    const requestedId = String(accountId)
    const epoch = viewEpoch
    const generation = catalogGeneration
    catalogLoading.value = { ...catalogLoading.value, [shopId]: true }
    catalogErrors.value = { ...catalogErrors.value, [shopId]: '' }
    try {
      const { data } = await safeGet<any>('/api/ranch/catalog', {
        headers: { 'x-account-id': requestedId }, params: { shopId }, timeout: 165000, skipErrorToast: true,
      } as any, generation)
      if (generation !== catalogGeneration || !current(requestedId, epoch)) return
      if (!data?.ok || String(data.accountId || '') !== requestedId || !Array.isArray(data.data?.goods))
        throw new Error(data?.error || '牧场商品目录未确认')
      catalogs.value = { ...catalogs.value, [shopId]: data.data.goods }
    }
    catch (cause: any) {
      if (generation !== catalogGeneration || !current(requestedId, epoch) || isReadCanceled(cause)) return
      catalogErrors.value = { ...catalogErrors.value, [shopId]: cause?.response?.data?.error || cause?.message || '牧场商品目录读取失败' }
    }
    finally {
      if (generation === catalogGeneration && current(requestedId, epoch))
        catalogLoading.value = { ...catalogLoading.value, [shopId]: false }
    }
  }

  async function fetchBag(accountId: string) {
    if (!accountId || !isCurrentAccount(accountId) || bagLoading.value) return
    const requestedId = String(accountId)
    const epoch = viewEpoch
    const rid = ++bagRequestId
    bagController?.abort()
    const requestController = new AbortController()
    bagController = requestController
    bagLoading.value = true
    bagError.value = ''
    try {
      const { data } = await api.get('/api/ranch/bag', {
        headers: { 'x-account-id': requestedId }, timeout: 165000, signal: requestController.signal, skipErrorToast: true,
      } as any)
      if (rid !== bagRequestId || !current(requestedId, epoch)) return
      if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.sceneId !== 2 || data.data?.readOnly !== true
        || !Array.isArray(data.data?.items) || !Array.isArray(data.data?.pens)
        || typeof data.data?.goldVoucherBalance !== 'string' || !/^\d+$/.test(data.data.goldVoucherBalance)
        || typeof data.data?.buckets?.normal !== 'string' || !/^\d+$/.test(data.data.buckets.normal)
        || typeof data.data?.buckets?.organic !== 'string' || !/^\d+$/.test(data.data.buckets.organic))
        throw new Error(data?.error || '牧场背包数据未确认')
      bagOverview.value = data.data as RanchBagOverview
    }
    catch (cause: any) {
      if (rid !== bagRequestId || !current(requestedId, epoch) || isReadCanceled(cause)) return
      bagError.value = cause?.response?.data?.error || cause?.message || '牧场背包读取失败'
    }
    finally {
      if (rid === bagRequestId && current(requestedId, epoch)) {
        bagLoading.value = false
        if (bagController === requestController) bagController = null
      }
    }
  }

  async function fetchCanCatalog(accountId: string, slotType: 6 | 7) {
    if (!accountId || !isCurrentAccount(accountId) || ![6, 7].includes(slotType) || canLoading.value[slotType]) return
    const requestedId = String(accountId)
    const epoch = viewEpoch
    const generation = canGeneration
    canLoading.value = { ...canLoading.value, [slotType]: true }
    canErrors.value = { ...canErrors.value, [slotType]: '' }
    try {
      const { data } = await api.get('/api/ranch/cans', {
        headers: { 'x-account-id': requestedId }, params: { slotType }, timeout: 165000, skipErrorToast: true,
      } as any)
      if (generation !== canGeneration || !current(requestedId, epoch)) return
      if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.slotType !== slotType
        || !Array.isArray(data.data?.goods)) throw new Error(data?.error || '罐头商城数据未确认')
      canCatalogs.value = { ...canCatalogs.value, [slotType]: data.data.goods }
    }
    catch (cause: any) {
      if (generation !== canGeneration || !current(requestedId, epoch) || isReadCanceled(cause)) return
      canErrors.value = { ...canErrors.value, [slotType]: cause?.response?.data?.error || cause?.message || '罐头商城读取失败' }
    }
    finally {
      if (generation === canGeneration && current(requestedId, epoch)) canLoading.value = { ...canLoading.value, [slotType]: false }
    }
  }

  async function fetchProgress(accountId: string, section: RanchProgressSection, groupId = '') {
    if (!accountId || !isCurrentAccount(accountId) || !['tasks', 'book', 'share', 'market', 'activities'].includes(section) || progressLoading.value[section]) return
    const requestedId = String(accountId), epoch = viewEpoch, generation = progressGeneration
    const requestController = new AbortController()
    progressControllers.set(section, requestController)
    progressLoading.value = { ...progressLoading.value, [section]: true }
    progressErrors.value = { ...progressErrors.value, [section]: '' }
    try {
      const { data } = await api.get(`/api/ranch/${section}`, {
        headers: { 'x-account-id': requestedId }, params: section === 'activities' && groupId ? { groupId } : undefined,
        timeout: 165000, signal: requestController.signal, skipErrorToast: true,
      } as any)
      if (generation !== progressGeneration || !current(requestedId, epoch) || progressControllers.get(section) !== requestController) return
      const value = data?.data
      const validBase = data?.ok && String(data.accountId || '') === requestedId && value?.readOnly === true
        && value.sceneId === 2 && typeof value.ownerGid === 'string' && /^[1-9]\d*$/.test(value.ownerGid)
        && typeof value.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.dateKey) && Number.isFinite(value.observedAt)
        && Number.isFinite(value.serverTimeMs) && value.serverTimeMs > 0
      const validSection = section === 'tasks'
        ? Array.isArray(value?.tasks) && value.guideReportingEnabled === false && value.automaticClaimEnabled === false
          && Number.isSafeInteger(value.summary?.claimable)
        : section === 'book' ? value?.type === 101 && Array.isArray(value.animals)
          && value.animals.every((row: any) => row.giantItem === null || typeof row.giantItem?.id === 'string'
            && typeof row.giantItem?.name === 'string' && typeof row.giantItem?.image === 'string')
          && Array.isArray(value.normal?.levels) && Array.isArray(value.giant?.levels) && typeof value.giant.totalScore === 'string'
          : section === 'market' ? value?.shopId === 7 && typeof value.opened === 'boolean' && typeof value.present === 'boolean'
            && Array.isArray(value.goods) && Array.isArray(value.shelves) && typeof value.periodDay === 'string'
            && Number.isSafeInteger(value.roundIndex) && value.roundIndex >= 0 && value.automaticExchangeEnabled === false
            && value.goods.every((row: any) => typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id)
              && typeof row.unitPrice === 'string' && /^\d+$/.test(row.unitPrice)
              && typeof row.currencyBalance === 'string' && /^\d+$/.test(row.currencyBalance)
              && typeof row.currencyId === 'string' && /^\d+$/.test(row.currencyId)
              && typeof row.reward?.id === 'string' && /^[1-9]\d*$/.test(row.reward.id)
              && typeof row.reward?.count === 'string' && /^[1-9]\d*$/.test(row.reward.count)
              && typeof row.available === 'boolean' && Number.isSafeInteger(row.maxCount) && row.maxCount >= 0 && row.maxCount <= 999
              && (!row.available || row.unitPrice !== '0'))
            : section === 'activities' ? Array.isArray(value?.activities) && value.actionsEnabled === false && !!value.guide
              && ((value.muge === null && typeof value.mugeError === 'string')
                || value.muge?.activityId === '2026111700' && typeof value.muge.active === 'boolean'
                  && Number.isFinite(value.muge.startTime) && Number.isFinite(value.muge.endTime)
                  && Array.isArray(value.muge.questions) && value.muge.questions.every((question: any) => Number.isSafeInteger(question.id)
                    && typeof question.title === 'string' && Array.isArray(question.options)
                    && question.options.every((option: any) => Number.isSafeInteger(option.value) && typeof option.text === 'string')))
              && (!groupId || value.detail?.id === groupId)
          : value?.shareId === '102' && typeof value.known === 'boolean' && value.automaticShareEnabled === false
            && typeof value.canClaim === 'boolean' && typeof value.canReport === 'boolean'
            && (value.known ? typeof value.claimed === 'boolean' && typeof value.shareCount === 'string' && /^\d+$/.test(value.shareCount)
              && (!value.canClaim || !value.claimed && BigInt(value.shareCount) > 0n)
              && (!value.canReport || !value.claimed && value.shareCount === '0')
              : value.claimed === null && value.shareCount === null && !value.canClaim && !value.canReport)
      if (!validBase || !validSection) throw new Error(data?.error || '牧场专区的数据归属或结构未确认')
      progressViews.value = { ...progressViews.value, [section]: value }
    }
    catch (cause: any) {
      if (generation !== progressGeneration || !current(requestedId, epoch) || isReadCanceled(cause)) return
      progressErrors.value = { ...progressErrors.value, [section]: cause?.response?.data?.error || cause?.message || '牧场专区读取失败' }
    }
    finally {
      if (generation === progressGeneration && current(requestedId, epoch) && progressControllers.get(section) === requestController) {
        progressLoading.value = { ...progressLoading.value, [section]: false }
        progressControllers.delete(section)
      }
    }
  }

  let mugeMutationFlight: Promise<{ ok: boolean, error?: string, unknown?: boolean }> | null = null
  async function operateMugeActivity(accountId: string, action: string, input: Record<string, unknown> = {}) {
    const requestedId = String(accountId || '')
    if (!requestedId || !isCurrentAccount(requestedId)) return { ok: false, error: '请先选择当前账号' }
    if (mugeMutationFlight) return { ok: false, error: '活动操作正在处理中，请等待结果' }
    const epoch = viewEpoch
    const currentActivity = progressViews.value.activities
    if (!currentActivity?.muge || progressLoading.value.activities) return { ok: false, error: '请先刷新牧歌初启活动进度' }
    const flight = (async () => {
      try {
        const { data } = await api.post('/api/ranch/activities/operate', { action, input: JSON.parse(JSON.stringify(input)) }, {
          headers: { 'x-account-id': requestedId }, timeout: 180000, skipErrorToast: true,
        } as any)
        if (!current(requestedId, epoch)) return { ok: false, error: '账号已切换，旧操作结果未应用' }
        if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.activity?.activityId !== '2026111700'
          || !Array.isArray(data.data?.rewards)) return { ok: false, unknown: resultIsUnknown(data) || data?.resultState === 'unknown', error: data?.error || '活动操作回包未确认，请刷新核对' }
        const latest = progressViews.value.activities
        if (latest && current(requestedId, epoch)) progressViews.value = { ...progressViews.value, activities: { ...latest, muge: data.data.activity } }
        progressErrors.value = { ...progressErrors.value, activities: '' }
        return { ok: true }
      }
      catch (cause: any) {
        if (!current(requestedId, epoch)) return { ok: false, error: '账号已切换，旧操作结果未应用' }
        const payload = cause?.response?.data
        const unknown = resultIsUnknown(payload) || payload?.resultState === 'unknown' || !cause?.response
        return { ok: false, unknown, error: payload?.error || cause?.message || '活动操作失败，请刷新核对' }
      }
    })()
    mugeMutationFlight = flight
    try { return await flight }
    finally { if (mugeMutationFlight === flight) mugeMutationFlight = null }
  }

  async function quote(accountId: string, action: string, input: Record<string, unknown>): Promise<RanchActionResponse> {
    const requestedId = String(accountId || '')
    if (!requestedId || !isCurrentAccount(requestedId)) return { ok: false, error: '请先选择当前账号', sent: false, resultState: 'not_sent' }
    const epoch = viewEpoch
    const rid = ++quoteRequestId
    quoteController?.abort()
    const requestController = new AbortController()
    quoteController = requestController
    try {
      const { data } = await api.post('/api/ranch/quote', { action, input: JSON.parse(JSON.stringify(input)) }, {
        headers: { 'x-account-id': requestedId }, timeout: 165000, signal: requestController.signal, skipErrorToast: true,
      } as any)
      if (rid !== quoteRequestId || !current(requestedId, epoch)) return { ok: false, stale: true }
      if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.action !== action
        || typeof data.data?.expected?.signature !== 'string')
        return { ok: false, error: data?.error || '报价与当前账号或操作不匹配' }
      return { ok: true, quote: data.data as RanchQuote }
    }
    catch (cause: any) {
      if (rid !== quoteRequestId || !current(requestedId, epoch)) return { ok: false, stale: true }
      return { ok: false, error: cause?.response?.data?.error || cause?.message || '报价未确认' }
    }
    finally {
      if (rid === quoteRequestId && quoteController === requestController) quoteController = null
    }
  }

  function execute(accountId: string, action: string, input: Record<string, unknown>, expected: { signature: string }): Promise<RanchActionResponse> {
    const requestedId = String(accountId || '')
    if (!requestedId || !isCurrentAccount(requestedId)) return Promise.resolve({ ok: false, error: '请先选择当前账号', sent: false, resultState: 'not_sent' })
    if (operationFlights.has(requestedId)) return Promise.resolve({ ok: false, error: '本账号牧场操作正在结算，未重复提交', sent: false, resultState: 'not_sent' })
    if (!operationsReady.value || serverBlocked.get(requestedId) === true
      || clientUnknown.has(requestedId) && operations.value.length === 0) {
      return Promise.resolve({ ok: false, error: '牧场场景或待核对状态尚未安全确认，本次未发送', sent: false, resultState: 'unknown', outcomeUnknown: false })
    }
    let submittedInput: Record<string, unknown>
    try { submittedInput = JSON.parse(JSON.stringify(input)) }
    catch { return Promise.resolve({ ok: false, error: '操作参数无法序列化', sent: false, resultState: 'not_sent' }) }
    if (!expected?.signature) return Promise.resolve({ ok: false, error: '缺少有效报价', sent: false, resultState: 'not_sent' })
    const epoch = viewEpoch
    invalidateGameReads()
    if (lastSummaries.value[requestedId]) lastSummaries.value = { ...lastSummaries.value,
      [requestedId]: { ...lastSummaries.value[requestedId]!, stale: true } }
    setOperationState(requestedId, 'pending')
    const flight = Promise.resolve().then(async (): Promise<RanchActionResponse> => {
      try {
        const { data } = await api.post('/api/ranch/operate', { action, input: submittedInput, expected: { signature: expected.signature } }, {
          headers: { 'x-account-id': requestedId }, timeout: 165000, skipErrorToast: true,
        } as any)
        if (!data?.ok) {
          const failure = operationFailure(data, '操作未完成')
          if (resultIsUnknown(failure)) clientUnknown.add(requestedId)
          return { ...failure, stale: !current(requestedId, epoch) }
        }
        const result = data.data
        if (String(data.accountId || '') !== requestedId || result?.action !== action || !['confirmed', 'skipped'].includes(result?.status)
          || !Number.isSafeInteger(result?.completed) || result.completed < 0
          || result.status === 'confirmed' && result.completed === 0) {
          throw new Error('牧场写回包归属或实际完成数量未确认')
        }
        if (current(requestedId, epoch)) {
          catalogs.value = {}
          canCatalogs.value = {}
          progressViews.value = {}
          if (['place', 'useCan', 'buyCan', 'upgrade', 'completeUpgrade'].includes(action)) bagOverview.value = null
          if (['steal', 'cleanFriend', 'stroke', 'putMosquito'].includes(action)) friendOverview.value = null
          notice.value = result.status === 'skipped' ? '本次没有产生实际操作' : `${result.label || '牧场操作'}：实际完成 ${result.completed} 项`
        }
        return { ok: true, data: result, stale: !current(requestedId, epoch) }
      }
      catch (cause: any) {
        const failure = operationFailure(cause, '牧场操作结果未确认')
        if (resultIsUnknown(failure)) clientUnknown.add(requestedId)
        return { ...failure, stale: !current(requestedId, epoch) }
      }
      finally {
        operationFlights.delete(requestedId)
        refreshOperationState(requestedId)
        if (current(requestedId, epoch)) invalidateGameReads()
      }
    })
    operationFlights.set(requestedId, flight)
    return flight
  }

  async function acknowledge(accountId: string, id: string): Promise<RanchActionResponse> {
    const requestedId = String(accountId || '')
    if (!requestedId || !isCurrentAccount(requestedId) || operating.value) return { ok: false, error: '账号无效或操作仍在结算', sent: false, resultState: 'not_sent' }
    const key = `${requestedId}:${id}`
    if (acknowledgementFlights.has(key)) return { ok: false, error: '该记录正在核对', sent: false, resultState: 'not_sent' }
    acknowledgementFlights.add(key)
    const epoch = viewEpoch
    invalidateGameReads()
    try {
      const { data } = await api.post('/api/ranch/operations/acknowledge', { id }, {
        headers: { 'x-account-id': requestedId }, timeout: 30000, skipErrorToast: true,
      } as any)
      if (!data?.ok || String(data.accountId || '') !== requestedId || data.data?.ok !== true)
        return { ok: false, error: data?.error || '核对回包未确认', stale: !current(requestedId, epoch) }
      clientUnknown.delete(requestedId)
      return { ok: true, stale: !current(requestedId, epoch) }
    }
    catch (cause: any) {
      return { ok: false, error: cause?.response?.data?.error || cause?.message || '核对未确认', stale: !current(requestedId, epoch) }
    }
    finally {
      acknowledgementFlights.delete(key)
      if (current(requestedId, epoch)) invalidateGameReads()
    }
  }

  // 仅供用户在游戏内人工核对后点击；空pending响应本身不清客户端unknown。
  async function confirmClientOutcome(accountId: string): Promise<RanchActionResponse> {
    const id = String(accountId || '')
    const epoch = viewEpoch
    if (!id || !isCurrentAccount(id) || operationFlights.has(id)) return { ok: false, error: '操作仍在结算或账号已变化' }
    const result = await fetchOperations(id)
    if (!current(id, epoch)) return { ok: false, stale: true }
    if (!result.ok || !result.safe) return { ok: false, error: '尚有服务端待核对记录或未知离场状态，不能解除保护' }
    clientUnknown.delete(id)
    refreshOperationState(id)
    notice.value = '已人工核对已有结果；没有补发任何游戏操作'
    return { ok: true }
  }

  return {
    overview, loading, error, loadedAccountId, friendOverview, friendLoading, friendError,
    friends, friendsLoading, friendsError, fetchFriends,
    interfaceLogs, appendInterfaceLog,
    operations, operationsLoading, operationsReady, operationsError, catalogs, catalogLoading, catalogErrors,
    bagOverview, bagLoading, bagError, canCatalogs, canLoading, canErrors, progressViews, progressLoading, progressErrors, lastSummaries,
    operating, writeBlocked, currentState, operationStates, hasPendingConflict, notice,
    fetchOverview, fetchFriend, fetchOperations, fetchCatalog, fetchBag, fetchCanCatalog, fetchProgress, operateMugeActivity, quote, execute, acknowledge, confirmClientOutcome, cancelQuote, clearFriend, clear,
  }
})
