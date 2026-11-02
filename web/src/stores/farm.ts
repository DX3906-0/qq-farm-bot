import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
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

export const useFarmStore = defineStore('farm', () => {
  const lands = ref<Land[]>([])
  const seeds = ref<any[]>([])
  const summary = ref<any>({})
  const weather = ref<any>(null)
  const loading = ref(false)
  // 「统一时间收获」是否正在等待最后一块地成熟
  const unifiedHarvest = ref(false)

  function clearFarmData() {
    lands.value = []
    seeds.value = []
    summary.value = {}
    weather.value = null
    unifiedHarvest.value = false
  }

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  async function fetchLands(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    loading.value = true
    try {
      const { data } = await api.get('/api/lands', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data && data.ok) {
        lands.value = data.data.lands || []
        summary.value = data.data.summary || {}
        weather.value = data.data.weather || null
      }
    }
    finally {
      loading.value = false
    }
  }

  async function fetchSeeds(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const { data } = await api.get('/api/seeds', {
      headers: { 'x-account-id': accountId },
    })
    if (!isCurrentAccount(requestedId))
      return
    if (data && data.ok)
      seeds.value = data.data || []
  }

  async function operate(accountId: string, opType: string) {
    if (!accountId)
      return
    await api.post('/api/farm/operate', { opType }, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId)
  }

  async function fertilizeLand(accountId: string, landId: number) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/fertilize', { landId }, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId)
    return data
  }

  async function removePlant(accountId: string, landId: number) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/remove', { landId }, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId)
    return data
  }

  async function removeAllPlants(accountId: string) {
    if (!accountId)
      return
    const { data } = await api.post('/api/land/remove-all', {}, {
      headers: { 'x-account-id': accountId },
    })
    await fetchLands(accountId)
    return data
  }

  /** 开启/取消「统一时间收获」：等最后一块地成熟后再统一一键收取 */
  async function setUnifiedHarvest(accountId: string, enabled: boolean) {
    if (!accountId)
      return null
    const { data } = await api.post('/api/farm/unified-harvest', { enabled }, {
      headers: { 'x-account-id': accountId },
    })
    if (data && data.ok)
      unifiedHarvest.value = !!data.data?.active
    return data
  }

  async function fetchUnifiedHarvest(accountId: string) {
    if (!accountId)
      return
    const { data } = await api.get('/api/farm/unified-harvest', {
      headers: { 'x-account-id': accountId },
    })
    if (data && data.ok)
      unifiedHarvest.value = !!data.data?.active
  }

  return {
    lands, summary, weather, seeds, loading, unifiedHarvest, clearFarmData,
    fetchLands, fetchSeeds, operate, fertilizeLand, removePlant, removeAllPlants,
    setUnifiedHarvest, fetchUnifiedHarvest
  }
})
