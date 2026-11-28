import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import api from '@/api'
import { operationFailure } from '@/utils/operation-result'

export interface Account {
  id: string
  name: string
  nick?: string
  uin?: number
  qq?: string | number
  wxid?: string
  gid?: string | number
  openId?: string
  avatar?: string
  avatarUrl?: string
  username?: string
  platform?: string
  running?: boolean
  // Add other fields as discovered
}

export interface RefreshWxCodesResult {
  total: number
  success: number
  failed: number
  skipped: number
  results: Array<{
    accountId: string
    name: string
    ok: boolean
    error?: string
  }>
}

export interface AccountLog {
  time: string
  action: string
  msg: string
  reason?: string
}

export function getPlatformLabel(p?: string) {
  if (p === 'qq')
    return 'QQ'
  if (p === 'wx')
    return '微信'
  return ''
}

export function getPlatformClass(p?: string) {
  if (p === 'qq')
    return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
  if (p === 'wx')
    return 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
  return ''
}

// Also defend against an older/malformed backend snapshot. Do not let multiple
// ownership rows marked true turn into multiple "佩戴中" badges in the panel.
export function normalizeAvatarFrameSnapshot(payload: any) {
  const groups = (Array.isArray(payload?.groups) ? payload.groups : []).map((group: any) => {
    const items = Array.isArray(group?.items) ? group.items : []
    const active = items.filter((item: any) => item.equipped === true)
    const ids = Array.isArray(group?.equippedIds) ? group.equippedIds.map(Number) : active.map((item: any) => Number(item.frameId))
    const conflict = active.length > 1 || ids.length > 1 || active.some((item: any) => item.owned !== true)
      || (active.length === 1 && ids.length === 1 && ids[0] !== Number(active[0].frameId))
    const stateKnown = group?.stateKnown === true && !conflict
      && !items.some((item: any) => item.owned && item.equipped !== true && item.equipped !== false)
    return { ...group, stateKnown, stateConflict: conflict, equippedIds: stateKnown ? ids : [],
      items: items.map((item: any) => ({ ...item, equipped: stateKnown ? item.equipped === true : null })) }
  })
  const conflict = groups.some((group: any) => group.stateConflict)
  return { ...payload, groups, warning: conflict ? '当前佩戴状态存在冲突，请刷新确认；不把已拥有当作已佩戴。' : payload?.warning || '' }
}

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([])
  const currentAccountId = useStorage('current_account_id', '')
  const loading = ref(false)
  const readError = ref('')
  let accountsFlight: Promise<void> | null = null
  const logs = ref<AccountLog[]>([])
  const operationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  const operationErrors = ref<Record<string, string>>({})
  const desiredProcess = new Map<string, boolean | 'deleted'>()
  // Scene appearance result locks are account/slot scoped and session-only.
  // They outlive a SkinPanel remount, not the login session; never cached to disk.
  const skinMutationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  function skinMutationKey(accountId: string, slotType: number) { return JSON.stringify([accountId, slotType]) }
  function skinMutationState(accountId: string, slotType: number) { return skinMutationStates.value[skinMutationKey(accountId, slotType)] || 'idle' }
  function hasPendingSkinMutation(accountId: string) {
    return Object.entries(skinMutationStates.value).some(([key, state]) => state === 'pending' && JSON.parse(key)[0] === accountId)
  }
  function setSkinMutationState(accountId: string, slotType: number, state: 'pending' | 'unknown' | 'idle') {
    skinMutationStates.value[skinMutationKey(accountId, slotType)] = state
  }

  // The header and appearance panel share one account-scoped read. Nothing is
  // persisted or polled; unknown/error/changed-account responses clear the art.
  const equippedAvatarFrame = ref<{ frameId: number, name: string, image: string } | null>(null)
  const avatarFrameAccountId = ref('')
  let avatarFrameRevision = 0
  let avatarFrameFlight: { accountId: string, revision: number, promise: Promise<any> } | null = null
  function clearAvatarFrame() {
    avatarFrameRevision++
    equippedAvatarFrame.value = null
    avatarFrameAccountId.value = ''
  }
  function applyAvatarFrameSnapshot(payload: any, accountId = String(currentAccountId.value)) {
    if (String(currentAccountId.value) !== accountId || String(payload?.accountId) !== accountId)
      return false
    const groups = Array.isArray(payload?.groups) ? payload.groups : []
    const group = groups.find((entry: any) => Number(entry.frameType) === 1)
    const items = Array.isArray(group?.items) ? group.items : []
    const equipped = items.filter((item: any) => item.owned === true && item.equipped === true)
    const equippedIds = Array.isArray(group?.equippedIds) ? group.equippedIds.map(Number) : []
    const uncertain = group?.stateKnown !== true || equipped.length > 1 || equippedIds.length > 1
      || (equipped.length === 1 && equippedIds.length === 1 && equippedIds[0] !== Number(equipped[0].frameId))
      || items.some((item: any) => item.resultUnknown === true
      || (item.owned && item.equipped !== true && item.equipped !== false))
    const item = !uncertain && equipped.length === 1 ? equipped[0] : null
    equippedAvatarFrame.value = item?.image && Number.isSafeInteger(Number(item.frameId)) && Number(item.frameId) > 0
      ? { frameId: Number(item.frameId), name: String(item.name || '当前头像框'), image: String(item.image) } : null
    avatarFrameAccountId.value = accountId
    return true
  }
  function fetchAvatarFrames(accountId = String(currentAccountId.value)) {
    if (!accountId || accountId !== String(currentAccountId.value)) return Promise.resolve(null)
    const revision = avatarFrameRevision
    if (avatarFrameFlight?.accountId === accountId && avatarFrameFlight.revision === revision)
      return avatarFrameFlight.promise
    const flight = { accountId, revision, promise: Promise.resolve<any>(null) }
    flight.promise = api.get('/api/avatar-frames', { headers: { 'x-account-id': accountId }, timeout: 70000 })
      .then(({ data }) => {
        if (revision !== avatarFrameRevision || accountId !== String(currentAccountId.value)) return null
        if (!data?.ok || !Array.isArray(data.data?.groups)) throw new Error(data?.error || '头像框状态未确认')
        const snapshot = normalizeAvatarFrameSnapshot(data.data)
        if (!applyAvatarFrameSnapshot(snapshot, accountId)) throw new Error('头像框账号不匹配')
        return snapshot
      }).catch((error: any) => {
        if (revision === avatarFrameRevision && accountId === String(currentAccountId.value)) {
          equippedAvatarFrame.value = null
          avatarFrameAccountId.value = ''
        }
        throw error
      }).finally(() => { if (avatarFrameFlight === flight) avatarFrameFlight = null })
    avatarFrameFlight = flight
    return flight.promise
  }
  watch(currentAccountId, clearAvatarFrame, { flush: 'sync' })

  function applyAccounts(nextAccounts: Account[]) {
    accounts.value = nextAccounts
    for (const [id, desired] of desiredProcess) {
      const account = nextAccounts.find(item => String(item.id) === id)
      if (operationStates.value[id] === 'unknown' && (desired === 'deleted' ? !account : account?.running === desired)) {
        operationStates.value[id] = 'idle'
        operationErrors.value[id] = ''
        desiredProcess.delete(id)
      }
    }

    // Background list refresh must not discard a Settings editor by silently
    // changing its account. Keep the selection until an explicit guarded choice.
    if (selectionGuard && currentAccountId.value) return
    if (accounts.value.length === 0) {
      currentAccountId.value = ''
      return
    }
    const found = accounts.value.find(a => String(a.id) === currentAccountId.value)
    if (!found && accounts.value[0]) currentAccountId.value = String(accounts.value[0].id)
  }

  const currentAccount = computed(() =>
    accounts.value.find(a => String(a.id) === currentAccountId.value),
  )

  function fetchAccounts(): Promise<void> {
    if (accountsFlight) return accountsFlight
    const promise = readAccounts().finally(() => { if (accountsFlight === promise) accountsFlight = null })
    accountsFlight = promise
    return promise
  }
  async function readAccounts() {
    loading.value = true
    readError.value = ''
    try {
      // api interceptor adds x-admin-token
      const res = await api.get('/api/accounts')
      if (res.data?.ok === true && Array.isArray(res.data.data?.accounts)
        && res.data.data.accounts.every((account: any) => account && account.id != null)) {
        applyAccounts(res.data.data.accounts)
      }
      else {
        readError.value = res.data?.error || '账号列表回包未确认，保留上次列表'
      }
    }
    catch (e: any) {
      readError.value = e?.message || '账号列表读取失败'
      console.error('获取账号失败', e)
      // Keep the last usable account selection to avoid blanking the app on transient failures.
    }
    finally {
      loading.value = false
    }
  }

  let selectionGuard: { owner: symbol, allow: (id: string) => Promise<boolean> } | null = null
  let selectionIntent = 0
  function registerSelectionGuard(owner: symbol, allow: (id: string) => Promise<boolean>) {
    selectionGuard = { owner, allow }
    return () => { if (selectionGuard?.owner === owner) { selectionGuard = null; selectionIntent++ } }
  }
  function selectAccount(id: string): Promise<boolean> {
    const next = String(id)
    const intent = ++selectionIntent
    if (next === currentAccountId.value) return Promise.resolve(true)
    if (!selectionGuard) { currentAccountId.value = next; return Promise.resolve(true) }
    const guard = selectionGuard
    return guard.allow(next).then(allowed => {
      if (!allowed || intent !== selectionIntent || selectionGuard !== guard) return false
      if (next && !accounts.value.some(account => String(account.id) === next)) return false
      currentAccountId.value = next
      return true
    }).catch(() => false)
  }

  function setCurrentAccount(acc: Account) {
    return selectAccount(acc.id)
  }

  async function mutateAccount(id: string, desired: boolean | 'deleted', send: () => Promise<any>) {
    id = String(id)
    if (operationStates.value[id] === 'pending') throw { sent: false, resultState: 'not_sent', error: '账号请求处理中，请等待结果' }
    if (operationStates.value[id] === 'unknown') throw { outcomeUnknown: true, resultState: 'unknown', error: operationErrors.value[id] || '账号操作结果未确认，仅读取核对' }
    operationStates.value[id] = 'pending'
    operationErrors.value[id] = ''
    desiredProcess.set(id, desired)
    let accepted = false
    const earlierRead = accountsFlight
    try {
      const { data } = await send()
      if (data?.ok !== true || data?.outcomeUnknown === true || data?.resultState === 'unknown') throw { ...(data || {}), error: data?.error || '账号请求回包未确认' }
      accepted = true
      // A list request already in flight predates this mutation and cannot
      // confirm its effect. Finish it, then issue one fresh readback.
      if (earlierRead) await earlierRead
      await fetchAccounts()
      const actual = accounts.value.find(item => String(item.id) === id)
      if (readError.value || (desired === 'deleted' ? !!actual : actual?.running !== desired)) throw { outcomeUnknown: true, error: '请求已受理，但账号状态读回未确认' }
      operationStates.value[id] = 'idle'
      desiredProcess.delete(id)
    }
    catch (error: any) {
      const failure = operationFailure(error, '账号操作结果未确认')
      const uncertain = accepted || failure.outcomeUnknown
      operationStates.value[id] = uncertain ? 'unknown' : 'idle'
      operationErrors.value[id] = `${failure.error}${uncertain ? '；仅读取核对，不重复操作。' : ''}`
      if (!uncertain) desiredProcess.delete(id)
      throw { ...failure, error: operationErrors.value[id], outcomeUnknown: uncertain }
    }
  }
  async function startAccount(id: string) {
    return mutateAccount(id, true, () => api.post(`/api/accounts/${id}/start`))
  }
  async function stopAccount(id: string) {
    return mutateAccount(id, false, () => api.post(`/api/accounts/${id}/stop`))
  }

  async function refreshWxCodes() {
    const res = await api.post('/api/accounts/refresh-wx-codes', {}, { timeout: 120000 })
    await fetchAccounts()
    return res.data as { ok: boolean, error?: string, data?: RefreshWxCodesResult }
  }

  async function deleteAccount(id: string) {
    return mutateAccount(id, 'deleted', () => api.delete(`/api/accounts/${id}`))
  }

  async function fetchLogs() {
    try {
      const res = await api.get('/api/account-logs?limit=100')
      if (Array.isArray(res.data)) {
        logs.value = res.data
      }
    }
    catch (e) {
      console.error('获取账号日志失败', e)
    }
  }

  async function addAccount(payload: any) {
    try {
      await api.post('/api/accounts', payload)
      await fetchAccounts()
    }
    catch (e) {
      console.error('添加账号失败', e)
      throw e
    }
  }

  async function updateAccount(id: string, payload: any) {
    try {
      // core uses POST /api/accounts for both add and update (if id is present)
      await api.post('/api/accounts', { ...payload, id })
      await fetchAccounts()
    }
    catch (e) {
      console.error('更新账号失败', e)
      throw e
    }
  }

  return {
    accounts,
    currentAccountId,
    currentAccount,
    loading,
    readError,
    logs,
    fetchAccounts,
    selectAccount,
    registerSelectionGuard,
    operationStates,
    operationErrors,
    skinMutationState,
    hasPendingSkinMutation,
    setSkinMutationState,
    startAccount,
    stopAccount,
    refreshWxCodes,
    deleteAccount,
    fetchLogs,
    addAccount,
    updateAccount,
    setCurrentAccount,
    equippedAvatarFrame,
    avatarFrameAccountId,
    fetchAvatarFrames,
    applyAvatarFrameSnapshot,
    clearAvatarFrame,
  }
})
