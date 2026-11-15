import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api, { createReadCoordinator, invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useAccountStore } from '@/stores/account'

export interface PetDog { id: number, name: string, image: string, desc: string, rarity: number, owned: boolean | null, activated: boolean | null, activatable: boolean, deployed: boolean | null }
export interface PetFood { id: number, name: string, image: string, count: number, days: number, duration: number }
export interface CapitalMode { enabled: boolean, dogId: number, leadSeconds: number }
interface PetOverview { dogs: PetDog[], foods: PetFood[], deployedId: number, foodSeconds: number, protectSeconds: number, warnings?: string[] }

export const usePetStore = defineStore('pet', () => {
  const accountStore = useAccountStore()
  const emptyOverview = (): PetOverview => ({ dogs: [], foods: [], deployedId: 0, foodSeconds: 0, protectSeconds: 2592000 })
  const overview = ref<PetOverview>(emptyOverview())
  const logs = ref<any[]>([])
  const capitalMode = ref<CapitalMode>({ enabled: false, dogId: 0, leadSeconds: 10 })
  const capitalReady = ref(false)
  const loading = ref(false)
  const mutating = ref(false)
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const error = ref('')
  let accountId = ''
  let epoch = 0
  let overviewRequest = 0
  let logsRequest = 0
  let capitalRequest = 0
  let mutationRequest = 0
  let capitalWrites = 0
  let capitalSaveRequest = 0
  const reads = createReadCoordinator()
  function invalidateReads() {
    reads.invalidate()
    overviewRequest++
    logsRequest++
    capitalRequest++
    loading.value = false
    if (status.value === 'loading') status.value = 'idle'
  }

  watch(() => String(accountStore.currentAccountId || ''), (id) => {
    accountId = id
    epoch++
    invalidateReads()
    overview.value = emptyOverview()
    logs.value = []
    capitalMode.value = { enabled: false, dogId: 0, leadSeconds: 10 }
    capitalReady.value = false
    loading.value = false
    mutating.value = false
    capitalWrites = 0
    status.value = 'idle'
    error.value = ''
  }, { immediate: true, flush: 'sync' })

  const headers = (id: string) => ({ 'x-account-id': id })
  const current = (id: string, version: number) => !!id && id === accountId && version === epoch
  function fetchOverview(id: string, signal?: AbortSignal): Promise<boolean> {
    if (!id || id !== accountId || mutating.value)
      return Promise.resolve(false)
    return reads.run(`overview:${id}:${epoch}:${reads.epoch}`, shared => readOverview(id, shared), signal)
  }
  async function readOverview(id: string, signal: AbortSignal) {
    if (!id || id !== accountId)
      return false
    const version = epoch
    const request = ++overviewRequest
    const valid = () => current(id, version) && request === overviewRequest && !signal.aborted
    loading.value = true
    status.value = 'loading'
    error.value = ''
    try {
      const { data } = await safeGet('/api/dog/info', { headers: headers(id), timeout: 60000, signal }, reads.epoch)
      if (!valid())
        return false
      if (!data?.ok)
        throw new Error(data?.error || '获取宠物信息失败')
      const next = data.data
      if (!Array.isArray(next?.dogs) || !next.dogs.length || !Array.isArray(next.foods)
        || next.dogs.some((dog: PetDog) => !dog || !Number.isFinite(dog.id) || dog.id <= 0 || ![true, false, null].includes(dog.owned) || ![true, false, null].includes(dog.activated) || ![true, false, null].includes(dog.deployed))
        || next.dogs.every((dog: PetDog) => dog.owned === null)
        || ![next.deployedId, next.foodSeconds, next.protectSeconds].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0))
        throw new Error('宠物响应不完整，无法确认拥有状态')
      overview.value = next
      status.value = 'ready'
      return true
    }
    catch (e: any) {
      if (!valid() || isReadCanceled(e)) {
        if (current(id, version) && request === overviewRequest && status.value === 'loading') status.value = 'idle'
        return false
      }
      overview.value = emptyOverview()
      error.value = e?.response?.data?.error || e?.message || '获取宠物信息失败'
      status.value = 'error'
      throw e
    }
    finally {
      if (current(id, version) && request === overviewRequest) {
        loading.value = false
        if (signal.aborted && status.value === 'loading') status.value = 'idle'
      }
    }
  }
  function fetchLogs(id: string, signal?: AbortSignal): Promise<boolean> {
    return reads.run(`logs:${id}:${epoch}:${reads.epoch}`, shared => readLogs(id, shared), signal)
  }
  async function readLogs(id: string, signal: AbortSignal) {
    if (!id || id !== accountId)
      return false
    const version = epoch
    const request = ++logsRequest
    try {
      const { data } = await safeGet('/api/dog/protect-logs', { headers: headers(id), timeout: 60000, signal }, reads.epoch)
      if (!current(id, version) || request !== logsRequest || signal.aborted)
        return false
      if (!data?.ok || !Array.isArray(data?.data?.logs))
        throw new Error(data?.error || '获取守护记录失败')
      logs.value = data.data.logs
      return true
    }
    catch (e) {
      if (!current(id, version) || request !== logsRequest || signal.aborted)
        return false
      throw e
    }
  }
  function fetchCapitalMode(id: string, signal?: AbortSignal): Promise<boolean> {
    if (capitalWrites) return Promise.resolve(false)
    return reads.run(`capital:${id}:${epoch}:${reads.epoch}`, shared => readCapitalMode(id, shared), signal)
  }
  async function readCapitalMode(id: string, signal: AbortSignal) {
    if (!id || id !== accountId)
      return false
    const version = epoch
    const request = ++capitalRequest
    try {
      const { data } = await safeGet('/api/dog/capital-mode', { headers: headers(id), signal }, reads.epoch)
      if (!current(id, version) || request !== capitalRequest || signal.aborted)
        return false
      if (!data?.ok || !data.data)
        throw new Error(data?.error || '获取资本模式失败')
      capitalMode.value = data.data
      capitalReady.value = true
      return true
    }
    catch (e) {
      if (!current(id, version) || request !== capitalRequest || signal.aborted || isReadCanceled(e))
        return false
      capitalReady.value = false
      throw e
    }
  }
  async function mutate(id: string, path: string, body = {}, signal?: AbortSignal) {
    if (!id || id !== accountId || mutating.value)
      return false
    const version = epoch
    const request = ++mutationRequest
    mutating.value = true
    invalidateSafeReads()
    invalidateReads()
    try {
      const { data } = await api.post(path, body, { headers: headers(id), timeout: 60000 })
      if (!current(id, version) || request !== mutationRequest)
        return false
      if (!data?.ok)
        throw new Error(data?.error || '操作失败')
      invalidateReads()
      if (signal?.aborted) return true
      return await reads.run(`overview:${id}:${epoch}:${reads.epoch}`, shared => readOverview(id, shared), signal)
    }
    catch (e) {
      if (!current(id, version) || request !== mutationRequest || isReadCanceled(e))
        return false
      throw e
    }
    finally {
      invalidateSafeReads()
      if (current(id, version) && request === mutationRequest) {
        invalidateReads()
        mutating.value = false
      }
    }
  }
  const deploy = (id: string, dogId: number, signal?: AbortSignal) => mutate(id, '/api/dog/deploy', { dogId }, signal)
  const withdraw = (id: string, signal?: AbortSignal) => mutate(id, '/api/dog/withdraw', {}, signal)
  const feed = (id: string, foodId: number, count: number, signal?: AbortSignal) => mutate(id, '/api/dog/feed', { foodId, count }, signal)
  async function saveCapitalMode(id: string, config: CapitalMode) {
    if (!id || id !== accountId)
      return false
    const version = epoch
    invalidateSafeReads()
    invalidateReads()
    capitalWrites++
    const request = ++capitalSaveRequest
    try {
      const { data } = await api.post('/api/dog/capital-mode', { ...config }, { headers: headers(id) })
      if (!current(id, version) || request !== capitalSaveRequest)
        return false
      if (!data?.ok)
        throw new Error(data?.error || '保存失败')
      capitalMode.value = data.data.capitalMode
      capitalReady.value = true
      return true
    }
    catch (e) {
      if (!current(id, version) || request !== capitalSaveRequest)
        return false
      throw e
    }
    finally {
      invalidateSafeReads()
      if (current(id, version)) {
        capitalWrites--
        invalidateReads()
      }
    }
  }
  return { overview, logs, capitalMode, capitalReady, loading, mutating, status, error, fetchOverview, fetchLogs, fetchCapitalMode, deploy, withdraw, feed, saveCapitalMode }
})
