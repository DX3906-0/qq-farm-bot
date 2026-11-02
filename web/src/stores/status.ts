import type { Socket } from 'socket.io-client'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

// Define interfaces for better type checking
interface DailyGift {
  key: string
  label: string
  enabled?: boolean
  doneToday: boolean
  lastAt?: number
  completedCount?: number
  totalCount?: number
  tasks?: any[]
}

interface DailyGiftsResponse {
  date: string
  growth: DailyGift
  gifts: DailyGift[]
}

export const useStatusStore = defineStore('status', () => {
  const status = ref<any>(null)
  const logs = ref<any[]>([])
  const accountLogs = ref<any[]>([])
  const dailyGifts = ref<DailyGiftsResponse | null>(null)
  const statusAccountId = ref('')
  const loading = ref(false)
  const error = ref('')
  const realtimeConnected = ref(false)
  const realtimeLogsEnabled = ref(true)
  const currentRealtimeAccountId = ref('')
  // 服务端当前已确认订阅的账号（由 subscribed 事件回填）。
  // 用于避免重复 subscribe —— 服务端每次 subscribe 都会重发 logs:snapshot（未过滤全量），
  // 会把运行日志的筛选结果冲成全量。
  const subscribedAccountId = ref('')

  // 当前生效的日志筛选条件（由 Dashboard 同步进来）。
  // ⭐ 必须放在 store 里而不是只留在 Dashboard：运行日志的实时通道有两路
  //    （HTTP /api/logs 轮询 + socket.io 推送），socket 推送/快照是**未过滤**的全量，
  //    若不在推送侧重新套用筛选，只要 socket 重连一次（服务端在 subscribe 时必发快照），
  //    筛选结果就会被全量日志冲掉——表现为「选了好友，过一会儿自己跳回全部日志」。
  const logFilter = ref({ module: '', event: '', keyword: '', isWarn: '' })
  const tokenRef = useStorage('admin_token', '')

  let socket: Socket | null = null

  function getCurrentAccountId() {
    const accountStore = useAccountStore()
    return String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
  }

  function isCurrentAccount(accountId: string) {
    return getCurrentAccountId() === String(accountId)
  }

  const currentStatusReady = computed(() => {
    const currentId = getCurrentAccountId()
    return !!currentId && !!status.value && statusAccountId.value === currentId
  })

  function normalizeStatusPayload(input: any) {
    return (input && typeof input === 'object') ? { ...input } : {}
  }

  function clearAccountScopedData() {
    status.value = null
    statusAccountId.value = ''
    logs.value = []
    accountLogs.value = []
    dailyGifts.value = null
    error.value = ''
  }

  function normalizeLogEntry(input: any) {
    const entry = (input && typeof input === 'object') ? { ...input } : {}
    const ts = Number(entry.ts) || Date.parse(String(entry.time || '')) || Date.now()
    return {
      ...entry,
      ts,
      time: entry.time || new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    }
  }

  function shouldHideLogEntryInFrontend(entry: any) {
    const text = [
      entry?.tag,
      entry?.msg,
      entry?.reason,
      entry?.action,
      entry?.meta ? JSON.stringify(entry.meta) : '',
    ].filter(Boolean).join(' ')
    return /\b(?:ACE|TSDK)\b/i.test(text)
  }

  /** 由 Dashboard 同步当前筛选条件（module/event/keyword/isWarn） */
  function setLogFilter(next: any) {
    logFilter.value = {
      module: String(next?.module || ''),
      event: String(next?.event || ''),
      keyword: String(next?.keyword || ''),
      isWarn: String(next?.isWarn || ''),
    }
  }

  /** 与服务端 filterLogs 保持一致的客户端筛选（用于 socket 推送/快照） */
  function matchesLogFilter(entry: any) {
    const f = logFilter.value
    if (!f.module && !f.event && !f.keyword && !f.isWarn)
      return true

    if (f.module) {
      const entryModule = String((entry?.meta || {}).module || '')
      if (f.module === 'system') {
        const tag = String(entry?.tag || '')
        if (entryModule !== 'system' && tag !== '系统' && tag !== '错误')
          return false
      }
      else if (entryModule !== f.module) {
        return false
      }
    }

    if (f.event && String((entry?.meta || {}).event || '') !== f.event)
      return false

    if (f.isWarn) {
      const targetIsWarn = f.isWarn === 'warn'
      if (!!entry?.isWarn !== targetIsWarn)
        return false
    }

    if (f.keyword) {
      const keywords = f.keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (keywords.length > 0) {
        const searchText = `${entry?.msg || ''} ${entry?.tag || ''}`.toLowerCase()
        for (const kw of keywords) {
          if (!searchText.includes(kw))
            return false
        }
      }
    }

    return true
  }

  function pushRealtimeLog(entry: any) {
    const next = normalizeLogEntry(entry)
    if (shouldHideLogEntryInFrontend(next))
      return
    // 启用筛选时，实时推送也要过同一套筛选，否则会把「全部日志」混进筛选结果
    if (!matchesLogFilter(next))
      return
    logs.value.push(next)
    if (logs.value.length > 1000)
      logs.value = logs.value.slice(-1000)
  }

  function pushRealtimeAccountLog(entry: any) {
    const next = (entry && typeof entry === 'object') ? entry : {}
    if (shouldHideLogEntryInFrontend(next))
      return
    accountLogs.value.push(next)
    if (accountLogs.value.length > 300)
      accountLogs.value = accountLogs.value.slice(-300)
  }

  function handleRealtimeStatus(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId !== currentRealtimeAccountId.value)
      return
    if (body.status && typeof body.status === 'object') {
      status.value = normalizeStatusPayload(body.status)
      statusAccountId.value = accountId || currentRealtimeAccountId.value || getCurrentAccountId()
      error.value = ''
    }
  }

  function handleRealtimeLog(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || body.id || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    pushRealtimeLog(payload)
  }

  function handleRealtimeAccountLog(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    pushRealtimeAccountLog(payload)
  }

  function handleRealtimeLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== 'all' && accountId !== currentRealtimeAccountId.value)
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    // ⭐ 快照是**未过滤**的全量日志（服务端在 socket subscribe / 清空日志时下发）。
    // 这里必须重新套用当前筛选，否则每次 socket 重连都会把筛选结果冲成全量，
    // 表现为「选了好友筛选，过一会儿自己跳回全部日志」。
    logs.value = list
      .map((item: any) => normalizeLogEntry(item))
      .filter((item: any) => !shouldHideLogEntryInFrontend(item))
      .filter((item: any) => matchesLogFilter(item))
  }

  function handleRealtimeAccountLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const list = Array.isArray(body.logs) ? body.logs : []
    accountLogs.value = currentRealtimeAccountId.value
      ? list
          .filter((item: any) => String(item?.accountId || item?.id || '') === currentRealtimeAccountId.value)
          .filter((item: any) => !shouldHideLogEntryInFrontend(item))
      : list.filter((item: any) => !shouldHideLogEntryInFrontend(item))
  }

  function ensureRealtimeSocket() {
    if (socket)
      return socket

    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket', 'polling'],
      upgrade: true,
      timeout: 10000,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: {
        token: tokenRef.value,
      },
    })

    socket.on('connect', () => {
      realtimeConnected.value = true
      subscribedAccountId.value = ''
      if (currentRealtimeAccountId.value) {
        socket?.emit('subscribe', { accountId: currentRealtimeAccountId.value })
      }
      else {
        socket?.emit('subscribe', { accountId: 'all' })
      }
    })

    socket.on('disconnect', () => {
      realtimeConnected.value = false
      subscribedAccountId.value = ''
    })

    socket.on('subscribed', (payload: any) => {
      subscribedAccountId.value = String(payload?.accountId || 'all')
    })

    socket.on('connect_error', (err) => {
      realtimeConnected.value = false
      console.error('[realtime] 连接失败:', err.message)
    })

    socket.on('status:update', handleRealtimeStatus)
    socket.on('log:new', handleRealtimeLog)
    socket.on('account-log:new', handleRealtimeAccountLog)
    socket.on('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.on('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    return socket
  }

  function connectRealtime(accountId: string) {
    currentRealtimeAccountId.value = String(accountId || '').trim()
    if (!tokenRef.value)
      return

    const client = ensureRealtimeSocket()
    client.auth = {
      token: tokenRef.value,
      accountId: currentRealtimeAccountId.value || 'all',
    }

    if (client.connected) {
      // ⭐ 同一账号已订阅时不要重复 subscribe：服务端每次 subscribe 都会重发
      // logs:snapshot（未过滤全量），会把「运行日志」的筛选结果冲回全部日志。
      // Sidebar 每 30s 调一次本函数，正是「选了筛选、过一会儿自己跳回全部日志」的元凶。
      const target = currentRealtimeAccountId.value || 'all'
      if (subscribedAccountId.value === target)
        return
      client.emit('subscribe', { accountId: target })
      return
    }
    client.connect()
  }

  function disconnectRealtime() {
    if (!socket)
      return
    socket.off('connect')
    socket.off('disconnect')
    socket.off('connect_error')
    socket.off('status:update', handleRealtimeStatus)
    socket.off('log:new', handleRealtimeLog)
    socket.off('account-log:new', handleRealtimeAccountLog)
    socket.off('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.off('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    socket.off('subscribed')
    socket.disconnect()
    socket = null
    realtimeConnected.value = false
    subscribedAccountId.value = ''
  }

  async function fetchStatus(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    loading.value = true
    try {
      const { data } = await api.get('/api/status', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data.ok) {
        status.value = normalizeStatusPayload(data.data)
        statusAccountId.value = requestedId
        error.value = ''
      }
      else {
        error.value = data.error
      }
    }
    catch (e: any) {
      error.value = e.message
    }
    finally {
      loading.value = false
    }
  }

  async function fetchLogs(accountId: string, options: any = {}) {
    if (!accountId && options.accountId !== 'all')
      return
    const requestedId = String(accountId || options.accountId || '')
    const params: any = { limit: 100, ...options }
    const headers: any = {}
    if (accountId && accountId !== 'all') {
      headers['x-account-id'] = accountId
    }
    else {
      params.accountId = 'all'
    }

    try {
      const { data } = await api.get('/api/logs', { headers, params })
      if (requestedId && requestedId !== 'all' && !isCurrentAccount(requestedId))
        return
      if (data.ok) {
        logs.value = Array.isArray(data.data)
          ? data.data
              .map((item: any) => normalizeLogEntry(item))
              .filter((item: any) => !shouldHideLogEntryInFrontend(item))
          : []
        error.value = ''
      }
    }
    catch (e: any) {
      console.error(e)
    }
  }

  async function fetchDailyGifts(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const { data } = await api.get('/api/daily-gifts', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data.ok) {
        dailyGifts.value = data.data
      }
    }
    catch (e) {
      console.error('获取每日奖励失败', e)
    }
  }

  async function fetchAccountLogs(accountId = '', limit = 100) {
    const requestedId = String(accountId || '')
    try {
      const headers: Record<string, string> = {}
      if (requestedId)
        headers['x-account-id'] = requestedId
      const res = await api.get(`/api/account-logs?limit=${Math.max(1, Number(limit) || 100)}`, { headers })
      if (Array.isArray(res.data)) {
        if (requestedId && !isCurrentAccount(requestedId))
          return
        accountLogs.value = requestedId
          ? res.data
              .filter((item: any) => String(item?.accountId || item?.id || '') === requestedId)
              .filter((item: any) => !shouldHideLogEntryInFrontend(item))
          : res.data.filter((item: any) => !shouldHideLogEntryInFrontend(item))
      }
    }
    catch (e) {
      console.error(e)
    }
  }

  function setRealtimeLogsEnabled(enabled: boolean) {
    realtimeLogsEnabled.value = !!enabled
  }

  return {
    status,
    statusAccountId,
    currentStatusReady,
    logs,
    accountLogs,
    dailyGifts,
    loading,
    error,
    realtimeConnected,
    realtimeLogsEnabled,
    clearAccountScopedData,
    fetchStatus,
    fetchLogs,
    fetchAccountLogs,
    fetchDailyGifts,
    setRealtimeLogsEnabled,
    setLogFilter,
    connectRealtime,
    disconnectRealtime,
  }
})
