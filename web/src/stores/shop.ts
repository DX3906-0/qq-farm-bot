import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api, { createReadCoordinator, invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useAccountStore } from '@/stores/account'

export interface ShopSeedItem {
  id: number
  itemId: number
  name: string
  image?: string
  price: number
  seedLevel: number
  requiredLevel: number
  seasons?: number
  incomePerSeason?: number
  expPerSeason?: number
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
  id: number
  itemId: number
  name: string
  image?: string
  desc?: string
  effectDesc?: string
  price: number
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
      if (!data?.ok || !Array.isArray(data.data)) throw new Error(data?.error || '种子商店响应不完整')
      seeds.value = data.data
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === seedRequestId && isCurrentAccount(requestedId))
        error.value = err.message || '获取种子商店失败'
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
      if (!data?.ok || !Array.isArray(data.data)) throw new Error(data?.error || '装扮商店响应不完整')
      if (data.ok) {
        decorations.value = data.data || []
        userGoldBean.value = data.userGoldBean || 0
      }
      return { ok: true }
    }
    catch (err: any) {
      if (signal.aborted || isReadCanceled(err)) return false
      if (requestId === decorationRequestId && isCurrentAccount(requestedId))
        decorationError.value = err.message || '获取装扮商城失败'
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
    const epoch = accountEpoch
    invalidateSafeReads()
    invalidateReads()
    try { return await api.post(path, body, config) }
    finally { invalidateSafeReads(); if (epoch === accountEpoch) invalidateReads() }
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
    pets,
    decorations,
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
    buyMallGoods,
    buyMysteryShopGoods,
    abandonMysteryShop,
  }
})
