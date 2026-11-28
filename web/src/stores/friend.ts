import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api, { isReadCanceled } from '@/api'
import { useAccountStore } from '@/stores/account'
import { operationFailure, resultIsUnknown } from '@/utils/operation-result'

export interface BlacklistItem {
  gid: number
  name: string
  avatarUrl: string
}

export interface KnownFriendSettings {
  knownFriendGids: number[]
  knownFriendGidSyncCooldownSec: number
  friendsListCacheTtlSec: number
}

export const useFriendStore = defineStore('friend', () => {
  const friends = ref<any[]>([])
  const loading = ref(false)
  const dogInfoLoading = ref(false)
  const friendLands = ref<Record<string, any[]>>({})
  const friendLandsLoading = ref<Record<string, boolean>>({})
  const friendLandsError = ref<Record<string, string>>({})
  const friendLandFlights = new Map<string, Promise<void>>()
  const operationFlights = new Map<string, Promise<any>>()
  const operationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  let friendDataEpoch = 0
  const blacklist = ref<BlacklistItem[]>([])
  const interactRecords = ref<any[]>([])
  const interactLoading = ref(false)
  const interactError = ref('')

  const knownFriendGids = ref<number[]>([])
  const knownFriendGidSyncCooldownSec = ref(600)
  const friendsListCacheTtlSec = ref(60)
  const knownFriendSettingsLoading = ref(false)
  const knownFriendSettingsSaving = ref(false)

  function clearFriendData() {
    friendDataEpoch++
    friends.value = []
    friendLands.value = {}
    friendLandsLoading.value = {}
    friendLandsError.value = {}
    blacklist.value = []
    interactRecords.value = []
    interactError.value = ''
    knownFriendGids.value = []
    knownFriendGidSyncCooldownSec.value = 600
    friendsListCacheTtlSec.value = 60
  }

  const accountStore = useAccountStore()
  watch(() => String(accountStore.currentAccountId || ''), () => clearFriendData(), { flush: 'sync' })

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function buildPlantSummaryFromDetail(lands: any[], summary: any) {
    let stealNum = 0
    let dryNum = 0
    let weedNum = 0
    let insectNum = 0

    const detailLands = Array.isArray(lands) ? lands : []
    if (detailLands.length > 0) {
      for (const land of detailLands) {
        if (!land || !land.unlocked)
          continue
        if (land.status === 'stealable')
          stealNum++
        if (land.needWater)
          dryNum++
        if (land.needWeed)
          weedNum++
        if (land.needBug)
          insectNum++
      }
    }
    else {
      stealNum = Array.isArray(summary?.stealable) ? summary.stealable.length : 0
      dryNum = Array.isArray(summary?.needWater) ? summary.needWater.length : 0
      weedNum = Array.isArray(summary?.needWeed) ? summary.needWeed.length : 0
      insectNum = Array.isArray(summary?.needBug) ? summary.needBug.length : 0
    }

    return {
      stealNum: Number(stealNum) || 0,
      dryNum: Number(dryNum) || 0,
      weedNum: Number(weedNum) || 0,
      insectNum: Number(insectNum) || 0,
    }
  }

  function syncFriendPlantSummary(friendId: string, lands: any[], summary: any) {
    const key = String(friendId)
    const idx = friends.value.findIndex(f => String(f?.gid || '') === key)
    if (idx < 0)
      return

    const nextPlant = buildPlantSummaryFromDetail(lands, summary)
    friends.value[idx] = {
      ...friends.value[idx],
      plant: nextPlant,
    }
  }

  async function fetchFriends(accountId: string, forceSync = false) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const epoch = friendDataEpoch
    const current = () => epoch === friendDataEpoch && isCurrentAccount(requestedId)
    loading.value = true
    try {
      const res = await api.get('/api/friends', {
        headers: { 'x-account-id': accountId },
        params: forceSync ? { forceSync: 'true' } : {},
      })
      if (!current())
        return
      if (res.data.ok) {
        friends.value = res.data.data || []
      }
    }
    finally {
      if (current()) loading.value = false
    }
  }

  async function fetchFriendsDogInfo(accountId: string) {
    if (!accountId)
      return { ok: false, error: '账号ID无效' }
    const requestedId = String(accountId)
    dogInfoLoading.value = true
    try {
      const res = await api.post('/api/friends/fetch-dog-info', {}, {
        headers: { 'x-account-id': accountId },
        timeout: 600000,
      })
      if (res.data.ok && Array.isArray(res.data.friends) && isCurrentAccount(requestedId)) {
        friends.value = res.data.friends
      }
      return {
        ok: !!res.data.ok,
        failCount: res.data.failCount || 0,
        blacklistCount: res.data.blacklistCount || 0,
        guardDogCount: res.data.guardDogCount || 0,
        error: res.data.error || '',
      }
    }
    catch (e: any) {
      return {
        ok: false,
        error: e?.response?.data?.error || e?.message || '获取狗信息失败',
      }
    }
    finally {
      dogInfoLoading.value = false
    }
  }

  async function fetchFriendDogInfo(accountId: string, gid: string | number) {
    if (!accountId || !gid)
      return null
    try {
      const res = await api.get(`/api/friend/${gid}/dog`, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok)
        return res.data.data
    }
    catch {
      // ignore
    }
    return null
  }
  async function fetchInteractRecords(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    interactLoading.value = true
    interactError.value = ''

    try {
      const res = await api.get('/api/interact-records', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        interactRecords.value = Array.isArray(res.data.data) ? res.data.data : []
      }
      else {
        interactError.value = res.data.error || '加载访客记录失败'
      }
    }
    catch (error: any) {
      interactError.value = error?.response?.data?.error || error?.message || '加载访客记录失败'
    }
    finally {
      interactLoading.value = false
    }
  }

  async function fetchBlacklist(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const res = await api.get('/api/friend-blacklist', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        blacklist.value = res.data.data || []
      }
    }
    catch { /* ignore */ }
  }

  async function toggleBlacklist(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    const res = await api.post('/api/friend-blacklist/toggle', { gid }, {
      headers: { 'x-account-id': accountId },
    })
    if (res.data.ok) {
      blacklist.value = res.data.data || []
    }
  }

  function fetchFriendLands(accountId: string, friendId: string): Promise<void> {
    if (!accountId || !friendId)
      return Promise.resolve()
    // 同一账号/GID的在途访问不重复发起Enter；清缓存或切页也不取消已发送的访问事务。
    const key = JSON.stringify([String(accountId), String(friendId)])
    const existing = friendLandFlights.get(key)
    if (existing) return existing
    const flight = readFriendLands(String(accountId), String(friendId)).finally(() => {
      if (friendLandFlights.get(key) === flight) friendLandFlights.delete(key)
    })
    friendLandFlights.set(key, flight)
    return flight
  }

  async function readFriendLands(accountId: string, friendId: string) {
    const epoch = friendDataEpoch
    const current = () => epoch === friendDataEpoch && isCurrentAccount(accountId)
    if (!current()) return
    friendLandsLoading.value[friendId] = true
    friendLandsError.value[friendId] = ''
    try {
      const res = await api.get(`/api/friend/${friendId}/lands`, {
        headers: { 'x-account-id': accountId }, timeout: 95000,
      })
      if (!current()) return
      if (!res.data?.ok || !Array.isArray(res.data?.data?.lands)) {
        throw new Error(res.data?.error || '好友土地响应不完整')
      }
      const lands = res.data.data.lands
      friendLands.value[friendId] = lands
      syncFriendPlantSummary(friendId, lands, res.data.data.summary || null)
    }
    catch (error: any) {
      if (!current() || isReadCanceled(error)) return
      friendLandsError.value[friendId] = error?.response?.data?.error || error?.message || '读取好友土地失败'
    }
    finally {
      if (current()) friendLandsLoading.value[friendId] = false
    }
  }

  async function fetchStealPlans(accountId: string) {
    if (!accountId)
      return []
    try {
      const res = await api.get('/api/steal-plans', {
        headers: { 'x-account-id': accountId },
      })
      return res.data?.ok && Array.isArray(res.data.data) ? res.data.data : []
    }
    catch {
      return []
    }
  }

  async function addStealPlan(accountId: string, gid: number, delaySeconds: number, name?: string, recurring = false) {
    if (!accountId || !gid)
      return { ok: false, error: '参数无效' }
    try {
      const res = await api.post('/api/steal-plans', { gid, delaySeconds, name, recurring }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data?.ok) {
        return { ok: true, plan: res.data.plan || null, matureInSec: res.data.matureInSec }
      }
      return { ok: false, error: res.data?.error || '添加失败' }
    }
    catch (e: any) {
      return { ok: false, error: e?.response?.data?.error || e?.message || '添加失败' }
    }
  }

  async function removeStealPlan(accountId: string, gid: number) {
    if (!accountId || !gid)
      return { ok: false, error: '参数无效' }
    try {
      const res = await api.delete(`/api/steal-plans/${gid}`, {
        headers: { 'x-account-id': accountId },
      })
      return { ok: !!res.data?.ok }
    }
    catch {
      return { ok: false, error: '取消失败' }
    }
  }

  function operate(accountId: string, friendId: string, opType: string): Promise<any> {
    const id = String(accountId || '')
    if (!id || !friendId)
      return Promise.resolve({ ok: false, sent: false, resultState: 'not_sent', message: '参数无效' })
    // One manual visit transaction per account. A second click can subscribe
    // to the existing result, never send another Enter or an operation.
    if (operationFlights.has(id))
      return operationFlights.get(id)!
    if (operationStates.value[id] === 'unknown')
      return Promise.resolve({ ok: false, resultState: 'unknown', outcomeUnknown: true, message: '上次好友操作结果未确认，请只核对已有日志，不重复提交' })
    if (!isCurrentAccount(id))
      return Promise.resolve({ ok: false, stale: true, sent: false, resultState: 'not_sent' })
    const epoch = friendDataEpoch
    const current = () => epoch === friendDataEpoch && isCurrentAccount(id)
    operationStates.value[id] = 'pending'
    const flight = api.post(`/api/friend/${friendId}/op`, { opType }, {
      headers: { 'x-account-id': id }, skipErrorToast: true,
    } as any).then(({ data }) => {
      let result = data?.ok === true ? data.data || data : operationFailure(data, '好友操作未确认')
      if (resultIsUnknown(data) || resultIsUnknown(result))
        result = { ...result, ok: false, outcomeUnknown: true, resultState: 'unknown' }
      operationStates.value[id] = resultIsUnknown(result) ? 'unknown' : 'idle'
      return { ...result, stale: !current() }
    }).catch((error) => {
      const result = operationFailure(error, '好友操作结果未确认')
      operationStates.value[id] = result.outcomeUnknown ? 'unknown' : 'idle'
      return { ...result, stale: !current() }
    }).finally(() => {
      if (operationFlights.get(id) === flight)
        operationFlights.delete(id)
    })
    operationFlights.set(id, flight)
    return flight
  }

  function applyKnownFriendSettings(data: KnownFriendSettings | null | undefined) {
    if (!data)
      return
    knownFriendGids.value = Array.isArray(data.knownFriendGids) ? data.knownFriendGids : []
    knownFriendGidSyncCooldownSec.value = Number.isFinite(data.knownFriendGidSyncCooldownSec)
      ? Math.max(30, Math.min(86400, data.knownFriendGidSyncCooldownSec))
      : 600
    friendsListCacheTtlSec.value = Number.isFinite(data.friendsListCacheTtlSec)
      ? Math.max(10, Math.min(86400, data.friendsListCacheTtlSec))
      : 60
  }

  async function fetchKnownFriendSettings(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    knownFriendSettingsLoading.value = true
    try {
      const res = await api.get('/api/friend-known-gids', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsLoading.value = false
    }
  }

  async function saveKnownFriendSettings(accountId: string, payload: Partial<KnownFriendSettings>) {
    if (!accountId)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids', payload, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeKnownFriendGid(accountId: string, gid: number) {
    if (!accountId || !gid)
      return
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/remove', { gid }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function batchAddKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, addedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-add', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, addedCount: res.data.addedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  async function removeUnsyncedKnownFriendGids(accountId: string, gids: number[]) {
    if (!accountId || !gids || gids.length === 0)
      return { ok: false, removedCount: 0 }
    knownFriendSettingsSaving.value = true
    try {
      const res = await api.post('/api/friend-known-gids/batch-remove', { gids }, {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        applyKnownFriendSettings(res.data.data)
      }
      return { ok: res.data.ok, removedCount: res.data.removedCount || 0 }
    }
    finally {
      knownFriendSettingsSaving.value = false
    }
  }

  return {
    friends,
    loading,
    dogInfoLoading,
    friendLands,
    friendLandsLoading,
    friendLandsError,
    blacklist,
    interactRecords,
    interactLoading,
    interactError,
    knownFriendGids,
    knownFriendGidSyncCooldownSec,
    friendsListCacheTtlSec,
    knownFriendSettingsLoading,
    knownFriendSettingsSaving,
    clearFriendData,
    fetchFriends,
    fetchFriendsDogInfo,
    fetchFriendDogInfo,
    fetchBlacklist,
    toggleBlacklist,
    fetchInteractRecords,
    fetchFriendLands,
    fetchStealPlans,
    addStealPlan,
    removeStealPlan,
    operate,
    operationStates,
    fetchKnownFriendSettings,
    saveKnownFriendSettings,
    removeKnownFriendGid,
    batchAddKnownFriendGids,
    removeUnsyncedKnownFriendGids,
  }
})
