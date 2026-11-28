import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api, { createReadCoordinator, invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ShopSeedItem {
  id: number | null
  itemId: number
  name: string
  image?: string
  desc?: string
  price: number | null
  priceKnown?: boolean
  canBuy?: boolean
  seedLevel: number | null
  requiredLevel: number | null
  seasons?: number | null
  incomePerSeason?: number | null
  expPerSeason?: number | null
  harvestKnown?: boolean
  isForage?: boolean
  catalogOnly?: boolean
  shopId?: number
  itemCount?: number | null
  currencyId?: number | null
  currencyName?: string
  currencyKnown?: boolean
  resultUnknown?: boolean
  contentKnown?: boolean
  availability?: string
  unavailableReason?: string
  expired?: boolean
  unlocked?: boolean
  isSoldOut?: boolean
  limitCount?: number
  boughtNum?: number
}

export interface ShopPetItem {
  id: number
  itemId: number
  name: string
  image?: string
  desc?: string
  price: number
  requiredLevel: number
  unlocked?: boolean
  isSoldOut?: boolean
  isGoldenBean?: boolean
}

export interface ShopDecorationItem {
  id: number | null
  itemId: number
  itemCount: number | null
  itemType?: number | null
  category?: string
  isSeed?: boolean
  isForage?: boolean
  seedLevel?: number | null
  shopId: number
  name: string
  image?: string
  desc?: string
  effectDesc?: string
  price: number | null
  basePrice?: number | null
  originalPrice?: number | null
  currencyId: number | null
  currencyName?: string
  currencyKnown?: boolean
  priceKnown: boolean
  contentKnown?: boolean
  isFree?: boolean
  owned?: boolean
  unlocked?: boolean
  requiredLevel?: number
  limitCount?: number
  boughtNum?: number
  remaining?: number | null
  isSoldOut?: boolean
  isDiscounted?: boolean
  endTime?: number
  expired?: boolean
  resultUnknown?: boolean
  availability?: string
  unavailableReason?: string
  canBuy?: boolean
}

export interface ShopMallItem {
  goodsId: number
  name: string
  images?: string[]
  price: number
  isFree?: boolean
  canBuy?: boolean
  isSoldOut?: boolean
  discount?: string
  /** 商品类型（服务端 MallGoods.type），用于前端品类筛选 */
  type?: number
  /** 限购周期：1=每日 2=每周 3=每月 4=永久（对齐 mallpb.PurchaseLimit.limit_type） */
  limitType?: number
  limitCount?: number
  boughtNum?: number
}

export interface MysteryShopOffer {
  active: boolean
  skipped?: boolean
  reason?: 'inactive' | 'expired' | 'purchased' | 'upcoming'
  statusLabel?: string
  npcId: number
  itemId: number
  itemName: string
  itemImage?: string
  itemCount: number
  currencyId: number
  currencyName: string
  price: number
  originalPrice: number
  discount: number
  purchased: boolean
  startTime: number
  endTime: number
}

export const useShopStore = defineStore('shop', () => {
  const seeds = ref<ShopSeedItem[]>([])
  const pets = ref<ShopPetItem[]>([])
  const decorations = ref<ShopDecorationItem[]>([])
  const mallGoods = ref<ShopMallItem[]>([])
  /** 商品分类（按服务端 type 汇总），供分类筛选使用 */
  const mallCategories = ref<Array<{ type: number, count: number }>>([])
  const mysteryOffer = ref<MysteryShopOffer | null>(null)
  const mysteryOfferAccountId = ref('')

  const loading = ref(false)
  const petLoading = ref(false)
  const decorationLoading = ref(false)
  const mallLoading = ref(false)
  const mysteryLoading = ref(false)

  const error = ref('')
  const petError = ref('')
  const decorationError = ref('')
  const mallError = ref('')
  const mysteryError = ref('')

  const userGold = ref(0)
  const userGoldBean = ref(0)
  const userTicket = ref(0)

  const accountStore = useAccountStore()
  const reads = createReadCoordinator()
  let accountEpoch = 0
  watch(() => String(accountStore.currentAccountId || ''), () => {
    accountEpoch++
    clearShopData()
  }, { flush: 'sync' })
  function invalidateReads() {
    reads.invalidate()
    seedRequestId++
    petRequestId++
    decorationRequestId++
    mallRequestId++
    mysteryRequestId++
    loading.value = petLoading.value = decorationLoading.value = mallLoading.value = mysteryLoading.value = false
  }
  let seedRequestId = 0
  let petRequestId = 0
  let decorationRequestId = 0
  let mallRequestId = 0
  let mysteryRequestId = 0
  const pendingWrites = new Set<string>()
  const unknownDecorations = new Set<string>()
  const isCatalogSeed = (item: ShopDecorationItem) => item.itemType === 5 || item.isSeed === true || item.itemId === 20040
  const displayDecorations = computed(() => decorations.value.filter(item => !isCatalogSeed(item)
    && (item.category == null || item.category === 'decoration')))
  const displaySeeds = computed(() => {
    const result = [...seeds.value]
    for (const item of decorations.value.filter(isCatalogSeed)) {
      const index = result.findIndex(row => row.itemId === item.itemId)
      // A real offer in the ordinary seed shop takes precedence over its catalog hint.
      const existing = index >= 0 ? result[index] : undefined
      if (existing?.catalogOnly === false && existing.shopId === 2) continue
      // Do not carry the old wardrobe-wide 1005 assumption into the seed tab.
      // No separate ledger/API is created: this keeps the original SKU's unknown.
      const seed: ShopSeedItem = {
        ...item, shopId: 4, isForage: item.itemId === 20040, catalogOnly: false,
        seedLevel: item.seedLevel ?? null, requiredLevel: item.requiredLevel ?? null,
        currencyId: null, currencyName: '', currencyKnown: false, canBuy: false,
        harvestKnown: false, seasons: null, incomePerSeason: null, expPerSeason: null,
        availability: item.resultUnknown ? 'unknown' : 'unverified',
        unavailableReason: item.resultUnknown
          ? '上次购买结果未确认，请先核对背包，不要重复购买'
          : '种子商品已列出，但扣费币种和生长数据尚未确认',
      }
      if (index >= 0) result[index] = seed
      else result.push(seed)
    }
    return result
  })

  function clearShopData() {
    invalidateReads()
    mallCategories.value = []
    seeds.value = []
    pets.value = []
    decorations.value = []
    mallGoods.value = []
    mysteryOffer.value = null
    mysteryOfferAccountId.value = ''
    loading.value = false
    petLoading.value = false
    decorationLoading.value = false
    mallLoading.value = false
    mysteryLoading.value = false
    error.value = ''
    petError.value = ''
    decorationError.value = ''
    mallError.value = ''
    mysteryError.value = ''
    userGold.value = 0
    userGoldBean.value = 0
    userTicket.value = 0
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function fetchSeeds(accountId: string, signal?: AbortSignal) {
    return reads.run(`seed:${accountId}:${accountEpoch}:${reads.epoch}`, shared => readSeeds(accountId, shared), signal)
  }
  async function readSeeds(accountId: string, signal: AbortSignal) {
    if (!accountId)
      return false
    if (!isCurrentAccount(accountId)) return false
    const requestedId = String(accountId)
    const requestId = ++seedRequestId
    loading.value = true
    error.value = ''
    try {
      const { data } = await safeGet('/api/shop/seed', {
        headers: { 'x-account-id': accountId }, signal,
      }, reads.epoch)
      if (requestId !== seedRequestId || !isCurrentAccount(requestedId) || signal.aborted)
        return false
      if (!data?.ok || !Array.isArray(data.data) || Number(data.shopId) !== 2 || String(data.accountId) !== requestedId)
        throw new Error(data?.error || '种子商店响应不完整或账号不一致')
      seeds.value = data.data
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === seedRequestId && isCurrentAccount(requestedId)) {
        error.value = err.message || '获取种子商店失败'
        seeds.value = seeds.value.map(item => ({ ...item, canBuy: false, availability: 'unverified' }))
      }
      return { ok: false, error: err.message || '商店读取失败' }
    }
    finally {
      if (requestId === seedRequestId)
        loading.value = false
    }
  }

  function fetchPets(accountId: string, signal?: AbortSignal) {
    return reads.run(`pet:${accountId}:${accountEpoch}:${reads.epoch}`, shared => readPets(accountId, shared), signal)
  }
  async function readPets(accountId: string, signal: AbortSignal) {
    if (!accountId)
      return false
    if (!isCurrentAccount(accountId)) return false
    const requestedId = String(accountId)
    const requestId = ++petRequestId
    petLoading.value = true
    petError.value = ''
    try {
      const { data } = await safeGet('/api/shop/pet', {
        headers: { 'x-account-id': accountId }, signal,
      }, reads.epoch)
      if (requestId !== petRequestId || !isCurrentAccount(requestedId) || signal.aborted)
        return false
      if (!data?.ok || !Array.isArray(data.data)) throw new Error(data?.error || '宠物商店响应不完整')
      if (data.ok) {
        pets.value = data.data || []
        userGold.value = data.userGold || 0
        userGoldBean.value = data.userGoldBean || 0
      }
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === petRequestId && isCurrentAccount(requestedId))
        petError.value = err.message || '获取宠物商店失败'
      return { ok: false, error: err.message || '商店读取失败' }
    }
    finally {
      if (requestId === petRequestId)
        petLoading.value = false
    }
  }

  function fetchDecorations(accountId: string, signal?: AbortSignal) {
    return reads.run(`decoration:${accountId}:${accountEpoch}:${reads.epoch}`, shared => readDecorations(accountId, shared), signal)
  }
  async function readDecorations(accountId: string, signal: AbortSignal) {
    if (!accountId)
      return false
    if (!isCurrentAccount(accountId)) return false
    const requestedId = String(accountId)
    const requestId = ++decorationRequestId
    decorationLoading.value = true
    decorationError.value = ''
    try {
      const { data } = await safeGet('/api/shop/decoration', {
        headers: { 'x-account-id': accountId }, signal,
      }, reads.epoch)
      if (requestId !== decorationRequestId || !isCurrentAccount(requestedId) || signal.aborted)
        return false
      if (!data?.ok || !Array.isArray(data.data) || Number(data.shopId) !== 4
        || String(data.accountId) !== requestedId) throw new Error(data?.error || '装扮商店响应不完整，需配套的商店服务')
      decorations.value = data.data.map((item: ShopDecorationItem) => unknownDecorations.has(`${requestedId}:${item.id}`)
        ? { ...item, canBuy: false, resultUnknown: true, availability: 'unknown', unavailableReason: '上次购买结果未确认，请只刷新核对' }
        : item)
      userGoldBean.value = data.userGoldBean ?? 0
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === decorationRequestId && isCurrentAccount(requestedId)) {
        decorationError.value = err.message || '获取装扮商城失败'
        decorations.value = decorations.value.map(item => ({ ...item, canBuy: false, availability: item.resultUnknown ? 'unknown' : 'unverified' }))
      }
      return { ok: false, error: err.message || '商店读取失败' }
    }
    finally {
      if (requestId === decorationRequestId)
        decorationLoading.value = false
    }
  }

  function fetchMall(accountId: string, signal?: AbortSignal) {
    return reads.run(`mall:${accountId}:${accountEpoch}:${reads.epoch}`, shared => readMall(accountId, shared), signal)
  }
  async function readMall(accountId: string, signal: AbortSignal) {
    if (!accountId)
      return false
    if (!isCurrentAccount(accountId)) return false
    const requestedId = String(accountId)
    const requestId = ++mallRequestId
    mallLoading.value = true
    mallError.value = ''
    try {
      const { data } = await safeGet('/api/shop/mall', {
        headers: { 'x-account-id': accountId }, signal,
      }, reads.epoch)
      if (requestId !== mallRequestId || !isCurrentAccount(requestedId) || signal.aborted)
        return false
      if (!data?.ok || (!Array.isArray(data.data) && !Array.isArray(data.data?.goods))) throw new Error(data?.error || '道具商店响应不完整')
      if (data.ok) {
        // 2026-11-02：后端改为动态分类，返回 { goods, categories, userTicket }
        const payload = data.data || {}
        mallGoods.value = Array.isArray(payload) ? payload : (payload.goods || [])
        mallCategories.value = Array.isArray(payload) ? [] : (payload.categories || [])
        userTicket.value = payload.userTicket ?? data.userTicket ?? 0
      }
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === mallRequestId && isCurrentAccount(requestedId))
        mallError.value = err.message || '获取道具商城失败'
      return { ok: false, error: err.message || '商店读取失败' }
    }
    finally {
      if (requestId === mallRequestId)
        mallLoading.value = false
    }
  }

  function fetchMysteryShop(accountId: string, signal?: AbortSignal) {
    return reads.run(`mystery:${accountId}:${accountEpoch}:${reads.epoch}`, shared => readMysteryShop(accountId, shared), signal)
  }
  async function readMysteryShop(accountId: string, signal: AbortSignal) {
    if (!accountId)
      return false
    if (!isCurrentAccount(accountId)) return false
    const requestedId = String(accountId)
    const requestId = ++mysteryRequestId
    mysteryLoading.value = true
    mysteryError.value = ''
    try {
      const { data } = await safeGet('/api/shop/mystery', {
        headers: { 'x-account-id': accountId }, signal, timeout: 65000,
      }, reads.epoch)
      if (requestId !== mysteryRequestId || !isCurrentAccount(requestedId) || signal.aborted)
        return false
      if (!data?.ok) throw new Error(data?.error || '神秘商店读取失败')
      if (data.ok) {
        mysteryOffer.value = data.data || null
        mysteryOfferAccountId.value = requestedId
      }
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      const message = err?.response?.data?.error || err.message || '获取神秘商人失败'
      if (requestId === mysteryRequestId && isCurrentAccount(requestedId))
        mysteryError.value = message
      return { ok: false, error: message }
    }
    finally {
      if (requestId === mysteryRequestId)
        mysteryLoading.value = false
    }
  }

  async function write(path: string, body: unknown, config: any) {
    const requestedId = String(config?.headers?.['x-account-id'] || '')
    if (!requestedId || !isCurrentAccount(requestedId)) throw Object.assign(new Error('账号已切换，本次购买已取消'), { sent: false, resultState: 'not_sent' })
    const target = body as { goodsId?: unknown, npcId?: unknown } | null
    const key = `${requestedId}:${path}:${target?.goodsId ?? target?.npcId ?? ''}`
    if (pendingWrites.has(key)) throw Object.assign(new Error('该商品购买正在确认，请勿重复点击'), { sent: false, resultState: 'not_sent' })
    const epoch = accountEpoch
    pendingWrites.add(key)
    invalidateSafeReads()
    invalidateReads()
    try { return await api.post(path, body, config) }
    finally {
      pendingWrites.delete(key)
      invalidateSafeReads()
      if (epoch === accountEpoch) invalidateReads()
    }
  }
  async function buyGoods(accountId: string, goodsId: number, num: number, price: number) {
    const { data } = await write('/api/shop/buy', {
      goodsId,
      num,
      price,
    }, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }

  async function buyDecorationGoods(accountId: string, item: ShopDecorationItem, count = 1) {
    const requestedId = String(accountId)
    const key = `${requestedId}:${item.id}`
    if (!isCurrentAccount(requestedId) || !item.canBuy || item.resultUnknown || item.owned
      || item.expired || item.currencyKnown !== true || item.priceKnown !== true
      || !Number.isSafeInteger(item.id) || Number(item.id) <= 0
      || !Number.isSafeInteger(item.price) || Number(item.price) < 0
      || !Number.isSafeInteger(count) || count < 1 || count > 9999 || unknownDecorations.has(key)) {
      return { ok: false, error: '商品状态或账号已变化，请先刷新核对', sent: false, resultState: 'not_sent' }
    }
    const epoch = accountEpoch
    let result: any
    try {
      const { data } = await write('/api/shop/decoration/buy', {
        goodsId: item.id, count,
        expectedOffer: { itemId: item.itemId, itemCount: item.itemCount, currencyId: item.currencyId, price: item.price },
      }, { headers: { 'x-account-id': requestedId } })
      result = data
      if (result?.ok) {
        const received = Array.isArray(result.data?.getItems)
          ? result.data.getItems.filter((row: any) => Number(row.id) === item.itemId)
            .reduce((sum: number, row: any) => sum + Number(row.count || 0), 0) : 0
        if (String(result.data?.accountId) !== requestedId || result.data?.outcome !== 'completed'
          || received !== Number(item.itemCount) * count || received <= 0) {
          result = { ok: false, error: '购买结果未完整确认，请只刷新核对', outcomeUnknown: true, resultState: 'unknown' }
        }
      }
    }
    catch (error: any) {
      result = error?.response?.data || { ok: false, error: error.message || '购买结果未确认',
        outcomeUnknown: error.sent !== false, resultState: error.sent === false ? 'not_sent' : 'unknown' }
    }
    if (result?.outcomeUnknown === true || result?.resultState === 'unknown') unknownDecorations.add(key)
    if (epoch !== accountEpoch || !isCurrentAccount(requestedId)) return { ok: false, canceled: true }
    if (unknownDecorations.has(key)) {
      decorations.value = decorations.value.map(row => row.id === item.id
        ? { ...row, canBuy: false, resultUnknown: true, availability: 'unknown', unavailableReason: '上次购买结果未确认，请只刷新核对' }
        : row)
    }
    return result || { ok: false, error: '购买未返回结果' }
  }

  async function buySeedGoods(accountId: string, item: ShopSeedItem, count = 1) {
    if (item.shopId === 4) {
      // Preserve the existing decoration-shop/BuyGoods:<SKU> operation record.
      // Moving a seed to a different tab must not create a way to replay it.
      return buyDecorationGoods(accountId, item as ShopDecorationItem, count)
    }
    if (item.catalogOnly || item.canBuy === false || item.resultUnknown || item.currencyKnown === false
      || item.priceKnown === false || !Number.isSafeInteger(item.id) || Number(item.id) <= 0
      || !Number.isSafeInteger(item.price) || Number(item.price) < 0
      || !Number.isSafeInteger(count) || count < 1 || count > 9999) {
      return { ok: false, error: '种子商品或扣费信息未确认，请先刷新核对', sent: false, resultState: 'not_sent' }
    }
    return buyGoods(accountId, Number(item.id), count, Number(item.price))
  }

  async function buyMallGoods(accountId: string, goodsId: number, count: number) {
    const { data } = await write('/api/shop/mall/buy', {
      goodsId,
      count,
    }, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }

  async function buyMysteryShopGoods(accountId: string, npcId: number) {
    const { data } = await write('/api/shop/mystery/buy', {
      npcId,
    }, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }

  async function abandonMysteryShop(accountId: string) {
    const { data } = await write('/api/shop/mystery/abandon', {}, {
      headers: { 'x-account-id': accountId },
    })
    return data
  }

  async function refreshAll(accountId: string, signal?: AbortSignal) {
    const results = await Promise.all([
      fetchSeeds(accountId, signal),
      fetchPets(accountId, signal),
      fetchDecorations(accountId, signal),
      fetchMall(accountId, signal),
      fetchMysteryShop(accountId, signal),
    ])
    return { ok: results.every(result => !!result && typeof result === 'object' && result.ok === true) }
  }

  return {
    seeds,
    displaySeeds,
    pets,
    decorations,
    displayDecorations,
    mallGoods,
    mallCategories,
    mysteryOffer,
    mysteryOfferAccountId,
    loading,
    petLoading,
    decorationLoading,
    mallLoading,
    mysteryLoading,
    error,
    petError,
    decorationError,
    mallError,
    mysteryError,
    userGold,
    userGoldBean,
    userTicket,
    clearShopData,
    fetchSeeds,
    fetchPets,
    fetchDecorations,
    fetchMall,
    fetchMysteryShop,
    refreshAll,
    buyGoods,
    buyDecorationGoods,
    buySeedGoods,
    buyMallGoods,
    buyMysteryShopGoods,
    abandonMysteryShop,
  }
})
