import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api, { createReadCoordinator, invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useAccountStore } from '@/stores/account'

export interface Land {
  id: number
  plantName?: string
  phaseName?: string
  phase?: number
  imagePhase?: number
  seedImage?: string
  plantImage?: string
  status: string
  matureInSec: number
  phaseStartTime?: number
  phaseEndTime?: number
  needWater?: boolean
  needWeed?: boolean
  needBug?: boolean
  [key: string]: any
}

export interface FarmOperationResponse {
  ok: boolean
  skipped?: boolean
  success?: boolean
  hadWork?: boolean
  actions?: string[]
  harvestedLands?: number[]
  errors?: { operation: string, message: string }[]
  error?: string
  refreshError?: string
}

export const useFarmStore = defineStore('farm', () => {
  const accountStore = useAccountStore()
  const lands = ref<Land[]>([])
  const seeds = ref<any[]>([])
  const summary = ref<any>({})
  const weather = ref<any>(null)
  const loading = ref(false)
  const unifiedHarvest = ref(false)
  const reads = createReadCoordinator()
  let accountEpoch = 0
  const currentId = () => String(accountStore.currentAccountId || '')
  const current = (id: string, epoch: number) => !!id && currentId() === id && epoch === accountEpoch

  function clearFarmData() {
    accountEpoch++
    reads.invalidate()
    lands.value = []
    seeds.value = []
    summary.value = {}
    weather.value = null
    loading.value = false
    unifiedHarvest.value = false
  }
  watch(currentId, clearFarmData, { flush: 'sync' })

  function read(accountId: string, path: string, apply: (data: any) => void, signal?: AbortSignal): Promise<boolean> {
    const id = String(accountId)
    const epoch = accountEpoch
    const version = reads.epoch
    if (!current(id, epoch)) return Promise.resolve(false)
    return reads.run(`${path}:${id}:${epoch}:${version}`, async (shared) => {
      const valid = () => current(id, epoch) && version === reads.epoch && !shared.aborted
      if (path === '/api/lands') loading.value = true
      try {
        const { data } = await safeGet(path, { headers: { 'x-account-id': id }, signal: shared }, version)
        if (!valid()) return false
        if (!data?.ok) throw new Error(data?.error || '获取农场数据失败')
        apply(data)
        return true
      }
      catch (error) {
        if (!valid() || isReadCanceled(error)) return false
        throw error
      }
      finally {
        if (current(id, epoch) && version === reads.epoch && path === '/api/lands') loading.value = false
      }
    }, signal)
  }
  const fetchLands = (id: string, signal?: AbortSignal) => read(id, '/api/lands', (data) => {
    if (!Array.isArray(data.data?.lands)) throw new Error('土地响应不完整')
    lands.value = data.data.lands
    summary.value = data.data.summary || {}
    weather.value = data.data.weather || null
  }, signal)
  const fetchSeeds = (id: string, signal?: AbortSignal) => read(id, '/api/seeds', (data) => {
    if (!Array.isArray(data.data)) throw new Error('种子响应不完整')
    seeds.value = data.data
  }, signal)
  const fetchUnifiedHarvest = (id: string, signal?: AbortSignal) => read(id, '/api/farm/unified-harvest', (data) => {
    unifiedHarvest.value = !!data.data?.active
  }, signal)

  function invalidateReads() {
    reads.invalidate()
    loading.value = false
  }
  async function write(id: string, path: string, body: unknown, timeout?: number) {
    const epoch = accountEpoch
    invalidateSafeReads()
    invalidateReads()
    try {
      const { data } = await api.post(path, body, { headers: { 'x-account-id': id }, timeout })
      return { data, current: current(id, epoch) }
    }
    finally {
      invalidateSafeReads()
      if (current(id, epoch)) invalidateReads()
    }
  }
  async function operate(accountId: string, opType: string, signal?: AbortSignal): Promise<FarmOperationResponse> {
    if (!accountId) return { ok: false, error: '未选择账号' }
    const response = await write(accountId, '/api/farm/operate', { opType }, 120000)
    const result: FarmOperationResponse = response.data && typeof response.data.ok === 'boolean'
      ? response.data : { ok: false, error: '未返回农场操作结果' }
    if (response.current && !signal?.aborted) {
      try { await fetchLands(accountId, signal) }
      catch (error) {
        if (!isReadCanceled(error)) result.refreshError = '操作结果已返回，但土地刷新失败，请手动刷新'
      }
    }
    return result
  }
  async function writeLand(id: string, path: string, body: unknown, signal?: AbortSignal) {
    if (!id) return
    const response = await write(id, path, body)
    if (response.current && !signal?.aborted) await fetchLands(id, signal)
    return response.data
  }
  const fertilizeLand = (id: string, landId: number, signal?: AbortSignal) => writeLand(id, '/api/land/fertilize', { landId }, signal)
  const removePlant = (id: string, landId: number, signal?: AbortSignal) => writeLand(id, '/api/land/remove', { landId }, signal)
  const removeAllPlants = (id: string, signal?: AbortSignal) => writeLand(id, '/api/land/remove-all', {}, signal)
  async function setUnifiedHarvest(id: string, enabled: boolean) {
    if (!id) return null
    const response = await write(id, '/api/farm/unified-harvest', { enabled })
    if (response.current && response.data?.ok) unifiedHarvest.value = !!response.data.data?.active
    return response.data
  }

  return {
    lands, summary, weather, seeds, loading, unifiedHarvest, clearFarmData,
    fetchLands, fetchSeeds, operate, fertilizeLand, removePlant, removeAllPlants,
    setUnifiedHarvest, fetchUnifiedHarvest,
  }
})
