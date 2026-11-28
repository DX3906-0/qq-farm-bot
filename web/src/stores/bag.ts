import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { integerText, operationFailure, resultIsUnknown, saleConsumptionConfirmed, useConsumptionConfirmed } from '@/utils/operation-result'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const originalItems = ref<any[]>([])
  const loading = ref(false)
  const readError = ref('')
  const bagAccountId = ref('')
  const lastUpdatedAt = ref(0)
  const mutationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  let revision = 0
  let readNumber = 0
  let bagFlight: { id: string, revision: number, promise: Promise<boolean> } | null = null
  const mutationFlights = new Map<string, Promise<any>>()
  const current = (id: string, rid: number) => String(useAccountStore().currentAccountId || '') === id && rid === revision

  function clearBag() {
    revision++
    allItems.value = []
    originalItems.value = []
    bagAccountId.value = ''
    lastUpdatedAt.value = 0
    readError.value = ''
    loading.value = false
    // Already-sent writes and unknown results retain their account-scoped lock.
  }
  watch(() => String(useAccountStore().currentAccountId || ''), clearBag, { flush: 'sync' })

  const items = computed(() => {
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => !hiddenIds.has(Number(it.id || 0)))
  })
  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })

  function fetchBag(accountId: string): Promise<boolean> {
    const id = String(accountId || '')
    const rid = revision
    if (!id || !current(id, rid) || mutationStates.value[id] === 'pending')
      return Promise.resolve(false)
    if (bagFlight?.id === id && bagFlight.revision === rid)
      return bagFlight.promise
    const request = ++readNumber
    loading.value = true
    readError.value = ''
    const pending = api.get('/api/bag', { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      .then(({ data }) => {
        if (!current(id, rid) || request !== readNumber)
          return false
        if (!data?.ok || !Array.isArray(data?.data?.items) || !Array.isArray(data?.data?.originalItems))
          throw new Error(data?.error || '背包响应不完整')
        allItems.value = data.data.items
        originalItems.value = data.data.originalItems
        bagAccountId.value = id
        lastUpdatedAt.value = Date.now()
        return true
      }).catch((error) => {
        if (current(id, rid) && request === readNumber)
          readError.value = error?.response?.data?.error || error?.message || '读取背包失败'
        // A same-account refresh error leaves the last display intact, but the
        // UI disables mutations until a new valid snapshot is obtained.
        return false
      }).finally(() => {
        if (current(id, rid) && request === readNumber)
          loading.value = false
        if (bagFlight?.promise === pending)
          bagFlight = null
      })
    bagFlight = { id, revision: rid, promise: pending }
    return pending
  }

  function mutate(accountId: string, path: string, body: any, confirmResult?: (data: any) => boolean, timeout?: number): Promise<any> {
    const id = String(accountId || '')
    if (mutationFlights.has(id))
      return mutationFlights.get(id)!
    if (mutationStates.value[id] === 'unknown')
      return Promise.resolve({ ok: false, outcomeUnknown: true, resultState: 'unknown', error: '上次背包操作结果未确认；刷新只读取当前库存' })
    const rid = revision
    if (!id || !current(id, rid))
      return Promise.resolve({ ok: false, stale: true, sent: false, resultState: 'not_sent' })
    mutationStates.value[id] = 'pending'
    // Invalidate only pre-write same-account reads; do not mutate the account
    // revision, which guards the real write result against account switches.
    readNumber++
    bagFlight = null
    loading.value = false
    const pending = api.post(path, body, { headers: { 'x-account-id': id }, ...(timeout ? { timeout } : {}), skipErrorToast: true } as any)
      .then(({ data }) => {
        let result = data
        if (resultIsUnknown(result) || resultIsUnknown(result?.data))
          result = { ...result, ok: false, outcomeUnknown: true, resultState: 'unknown', error: result?.error || result?.data?.error || '操作回包结果未确认' }
        else if (result?.data?.ok === false)
          result = { ...result.data, ok: false }
        if (result?.ok === true && confirmResult && !confirmResult(result.data))
          result = { ok: false, resultState: 'unknown', outcomeUnknown: true, error: '回包未确认本次消耗，暂不重复使用；刷新只读取当前库存' }
        else if (result?.ok !== true)
          result = operationFailure(result, '背包操作未确认')
        mutationStates.value[id] = resultIsUnknown(result) ? 'unknown' : 'idle'
        return { ...result, stale: !current(id, rid) }
      }).catch((error) => {
        const result = operationFailure(error, '背包操作结果未确认')
        mutationStates.value[id] = result.outcomeUnknown ? 'unknown' : 'idle'
        return { ...result, stale: !current(id, rid) }
      }).finally(() => {
        if (mutationFlights.get(id) === pending)
          mutationFlights.delete(id)
      })
    mutationFlights.set(id, pending)
    return pending
  }
  function useItem(accountId: string, itemId: number, count = 1, uid?: string | number) {
    const amount = integerText(count), instance = uid == null ? '0' : integerText(uid)
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || amount === null || instance === null
      || BigInt(amount) <= 0n || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Promise.resolve({ ok: false, sent: false, resultState: 'not_sent', error: '物品编号、实例或使用数量无效' })
    }
    const requestedCount = Number(amount)
    return mutate(accountId, '/api/bag/use', { itemId, count: requestedCount, uid }, reply => useConsumptionConfirmed(reply, itemId, requestedCount))
  }
  function setItemsLocked(accountId: string, itemUids: Array<string | number>, locked: boolean) {
    return mutate(accountId, '/api/bag/lock', { itemUids, locked, confirmed: true }, undefined, 70000)
  }
  function sellItems(accountId: string, requested: Array<{ id: number, count: number, uid?: string | number }>) {
    return mutate(accountId, '/api/bag/sell', { items: requested }, reply => saleConsumptionConfirmed(reply, requested))
  }
  return { items, allItems, originalItems, dashboardItems, loading, readError, bagAccountId, lastUpdatedAt,
    mutationStates, fetchBag, clearBag, useItem, sellItems, setItemsLocked }
})
