import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

/** 单个藏品 */
export interface CollectionItem {
  collectionId: number
  starLevel: number
  isNew: boolean
  ownCount: number
  firstObtainedTime: number
  /** 配置富化字段（后端可能取不到配置，全部需要兜底） */
  name: string
  desc?: string
  image?: string
  iconRes?: string
  iconKey?: string
  rarity?: number
  rarityColor?: string
  owned?: boolean
  activated?: boolean
  canUpgrade?: boolean
  displayed?: boolean
  unlocked?: boolean
  seriesName?: string
  nextStarCosts?: Array<{ itemId: number, count: number | string, name: string, image?: string }>
  requirements?: Array<{ met: boolean, text: string, supported?: boolean }>
  score?: number
}

/** 分类详情 */
export interface CollectionCategory {
  category: number
  currentScore: number
  claimedRewardScore: number
  collectionLikeCount: number
  pedestalLikeCount: number
  collections: CollectionItem[]
  pedestals: Array<{ pedestalId: number, isNew: boolean }>
  wished: Array<{ seriesId: number, collectionId: number, cooldownUntil: number }>
  currentBuffs?: Array<{ name: string, description: string }>
  milestones?: Array<{ score: number, reached: boolean, claimed: boolean, rewards: any[], buffs: any[] }>
  seriesRules?: Array<{ seriesId: number, name: string, description: string, groups: Array<{ name: string, probability: number, guarantee: number }> }>
}

export interface CollectionDisplaySlot {
  slotType: number
  itemId: number
  pedestalId: number
}

export function normalizeCollectionLevel(value: unknown): number | null {
  if (value == null || typeof value === 'boolean')
    return null
  const level = Number(value)
  return Number.isSafeInteger(level) && level > 0 ? level : null
}

export const useCollectionStore = defineStore('collection', () => {
  const accountStore = useAccountStore()

  const categories = ref<CollectionCategory[]>([])
  const displaySlots = ref<CollectionDisplaySlot[]>([])
  /** 后端随藏品数据一起返回的角色等级（优先于前端自读 status） */
  const userLevel = ref<number | null>(null)
  const loading = ref(false)
  const error = ref('')
  const upgrading = ref(false)
  const claiming = ref(false)
  /** 上次成功拉取数据所属的账号，用于切换账号时清缓存 */
  const loadedAccountId = ref('')

  let requestId = 0

  function isCurrentAccount(id: string) {
    return String(accountStore.currentAccountId || '') === String(id)
  }

  function accountHeader(accountId: string) {
    return { headers: { 'x-account-id': accountId } }
  }

  function clear() {
    // 切换账号或离开页面后，旧请求不得把旧等级写回来。
    requestId++
    categories.value = []
    displaySlots.value = []
    userLevel.value = null
    loading.value = false
    error.value = ''
    loadedAccountId.value = ''
  }

  async function fetchCollections(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const rid = ++requestId
    loading.value = true
    error.value = ''
    try {
      const { data } = await api.get('/api/collection', accountHeader(requestedId))
      if (rid !== requestId || !isCurrentAccount(requestedId))
        return
      if (data.ok) {
        const payload = data.data || {}
        categories.value = Array.isArray(payload.details) ? payload.details : []
        displaySlots.value = Array.isArray(payload.displaySlots) ? payload.displaySlots : []
        userLevel.value = normalizeCollectionLevel(payload.userLevel)
        loadedAccountId.value = requestedId

        // 兼容尚未重载的新后端：显式请求当前账号状态，不依赖 Dashboard 缓存。
        // /api/status 是面板内存快照，不会新增游戏 RPC 或影响登录会话。
        if (userLevel.value === null) {
          try {
            const { data: statusResponse } = await api.get('/api/status', accountHeader(requestedId))
            if (rid !== requestId || !isCurrentAccount(requestedId))
              return
            if (statusResponse?.ok) {
              userLevel.value = normalizeCollectionLevel(
                statusResponse.data?.status?.level ?? statusResponse.data?.level,
              )
            }
          }
          catch {
            // 目录仍可展示，但等级必须保持未知，不能误报为 Lv.0。
            if (rid !== requestId || !isCurrentAccount(requestedId))
              return
          }
        }
      }
      else {
        error.value = data.error || '获取藏品失败'
      }
    }
    catch (err: any) {
      if (rid === requestId && isCurrentAccount(requestedId))
        error.value = err?.message || '获取藏品失败'
    }
    finally {
      if (rid === requestId)
        loading.value = false
    }
  }

  /** 激活 / 升星 */
  async function upgrade(accountId: string, category: number, collectionId: number, expected: Record<string, unknown> = {}) {
    if (!accountId)
      return { ok: false, error: '请先选择账号' }
    const revision = requestId
    const requestedId = String(accountId)
    upgrading.value = true
    try {
      const { data } = await api.post(
        '/api/collection/upgrade',
        { category, collectionId, ...expected, confirmed: true },
        accountHeader(accountId),
      )
      if (revision !== requestId || !isCurrentAccount(requestedId)) return { ok: false, stale: true }
      if (data?.ok) {
        await fetchCollections(accountId)
        return { ok: true, data: data.data }
      }
      return { ok: false, error: data?.error || '操作失败' }
    }
    catch (err: any) {
      if (!isCurrentAccount(requestedId)) return { ok: false, stale: true }
      return { ok: false, error: err?.response?.data?.error || err?.message || '操作失败' }
    }
    finally {
      if (isCurrentAccount(requestedId)) upgrading.value = false
    }
  }

  /** 领取评分奖励 */
  async function claimReward(accountId: string, category: number) {
    if (!accountId)
      return { ok: false, error: '请先选择账号' }
    const revision = requestId
    const requestedId = String(accountId)
    claiming.value = true
    try {
      const { data } = await api.post(
        '/api/collection/claim',
        { category, confirmed: true },
        accountHeader(accountId),
      )
      if (revision !== requestId || !isCurrentAccount(requestedId)) return { ok: false, stale: true }
      if (data?.ok) {
        await fetchCollections(accountId)
        return { ok: true, data: data.data }
      }
      return { ok: false, error: data?.error || '领取失败' }
    }
    catch (err: any) {
      if (!isCurrentAccount(requestedId)) return { ok: false, stale: true }
      return { ok: false, error: err?.response?.data?.error || err?.message || '领取失败' }
    }
    finally {
      if (isCurrentAccount(requestedId)) claiming.value = false
    }
  }

  async function setDisplay(accountId: string, input: Record<string, unknown>) {
    const revision = requestId
    const { data } = await api.post('/api/collection/display', { ...input, confirmed: true }, accountHeader(accountId))
    if (revision !== requestId || !isCurrentAccount(accountId)) return { ok: false, stale: true }
    if (data?.ok) await fetchCollections(accountId)
    return data
  }

  return {
    setDisplay,
    categories,
    displaySlots,
    userLevel,
    loading,
    error,
    upgrading,
    claiming,
    loadedAccountId,
    fetchCollections,
    upgrade,
    claimReward,
    clear,
  }
})