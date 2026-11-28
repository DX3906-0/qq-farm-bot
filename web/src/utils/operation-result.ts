export type AccountPresentationKind = 'readonly' | 'unselected' | 'loading' | 'stopped' | 'offline' | 'online' | 'stale' | 'unknown' | 'error'
export type AccountPresentationTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'
export interface AccountSnapshotMetadata {
  accountId: string
  updatedAt: number
  source: 'http' | 'ws'
}
export interface AccountPresentationInput {
  accountId?: string | number | null
  account?: { id?: string | number, uin?: string | number, running?: boolean | null } | null
  running?: boolean | null
  snapshot?: {
    accountId?: string | number | null
    connection?: { connected?: boolean | null }
    stale?: boolean
    metadata?: AccountSnapshotMetadata | null
  } | null
  snapshotReady?: boolean
  loading?: boolean
  error?: string | { message?: string } | null
  transportConnected?: boolean | null
  readonly?: boolean
  stale?: boolean
}
export interface AccountPresentation {
  kind: AccountPresentationKind
  label: string
  detail: string
  tone: AccountPresentationTone
  snapshotReady: boolean
  stale: boolean
  pulse: boolean
  updatedAt: number | null
  source: 'http' | 'ws' | null
}

// snapshotReady 必须由调用方按当前账号归属确认；显式冲突的账号标识仍会被拒绝。
export function deriveAccountPresentation({ accountId, account, running, snapshot, snapshotReady, loading, error, transportConnected, readonly, stale }: AccountPresentationInput): AccountPresentation {
  const selectedId = String(accountId ?? '')
  const accountRef = account?.id || account?.uin
  const accountMatches = accountRef === undefined || String(accountRef) === selectedId
  const hasSnapshot = !!selectedId && accountMatches && snapshotReady === true && !!snapshot
    && (snapshot.accountId == null || String(snapshot.accountId) === selectedId)
    && (snapshot.metadata?.accountId == null || snapshot.metadata.accountId === selectedId)
  const metadata = hasSnapshot && snapshot?.metadata?.accountId === selectedId
    && Number.isFinite(snapshot.metadata.updatedAt) && snapshot.metadata.updatedAt > 0
    && ['http', 'ws'].includes(snapshot.metadata.source) ? snapshot.metadata : null
  const transportInterrupted = transportConnected === false && metadata?.source === 'ws'
  const isStale = hasSnapshot && (stale === true || snapshot?.stale === true || transportInterrupted)
  const processRunning = accountMatches ? (running === undefined ? account?.running : running) : null
  const connected = hasSnapshot ? snapshot?.connection?.connected : null
  const errorText = typeof error === 'string' ? error : error?.message
  const present = (kind: AccountPresentationKind, label: string, detail: string, tone: AccountPresentationTone): AccountPresentation => ({
    kind, label, detail, tone, snapshotReady: hasSnapshot, stale: isStale, pulse: kind === 'online',
    updatedAt: metadata?.updatedAt ?? null, source: metadata?.source ?? null,
  })

  if (readonly === true)
    return present('readonly', '本地只读 · 未登录', '本地只读预览，不读取实时账号状态。', 'neutral')
  if (!selectedId)
    return present('unselected', '未选择账号', '请选择账号后查看状态。', 'neutral')
  if (loading === true && !hasSnapshot)
    return present('loading', '加载中', '正在获取当前账号状态，尚未确认游戏连接。', 'info')
  if (errorText)
    return present('error', '状态获取失败', `${errorText}${hasSnapshot ? '；保留上次成功获取的数据，不代表实时在线。' : '；尚未确认当前账号状态。'}`, 'error')
  if (isStale)
    return present('stale', '数据已过时', transportInterrupted
      ? '实时状态通道已断开；当前显示上次成功获取的数据，不能确认实时连接。'
      : '当前账号状态已标记过时，不能确认实时连接。', 'warning')
  if (processRunning === false)
    return present('stopped', '已停止', '账号进程已停止，不代表游戏连接在线。', 'neutral')
  if (connected === true)
    return present('online', '在线', '当前账号状态快照已确认游戏连接正常。', 'success')
  if (connected === false)
    return present('offline', '离线', processRunning === true ? '已确认游戏连接断开；账号进程仍在运行。' : '当前账号状态快照已确认游戏连接断开。', 'warning')
  if (loading === true)
    return present('loading', '加载中', '正在更新当前账号状态，尚未确认游戏连接。', 'info')
  return present('unknown', '状态待确认', processRunning === true
    ? '账号进程运行中，尚未确认游戏连接状态。'
    : '尚未取得可确认的当前账号游戏连接状态。', 'neutral')
}

export type FeedbackState = 'pending' | 'success' | 'info' | 'error' | 'unknown'
export interface OperationFeedback {
  state: FeedbackState
  message: string
  action?: string
  target?: string
}

/** A transport failure is not evidence that an irreversible action failed. */
export function operationFailure(error: any, fallback = '操作结果未确认') {
  const body = error?.response?.data || error || {}
  const message = String(body.error || body.message || fallback)
  const explicitlyUnknown = body.outcomeUnknown === true || body.resultState === 'unknown' || body.processing === true
  const notSent = !explicitlyUnknown && (body.sent === false || body.resultState === 'not_sent'
    || body.sent !== true && !['failed', 'completed'].includes(body.resultState)
      && [400, 401, 403, 404].includes(Number(error?.response?.status)))
  const unknown = explicitlyUnknown || !notSent && !['failed', 'completed'].includes(body.resultState)
  return { ok: false, error: message, message, sent: notSent ? false : body.sent,
    resultState: notSent ? 'not_sent' : unknown ? 'unknown' : 'failed', outcomeUnknown: unknown }
}
export function resultIsUnknown(result: any) {
  return result?.outcomeUnknown === true || result?.resultState === 'unknown' || result?.processing === true
}
export function feedbackForResult(result: any, fallback: string): OperationFeedback {
  if (resultIsUnknown(result))
    return { state: 'unknown', message: `${result?.message || result?.error || fallback}；仅刷新核对，不重复提交。` }
  if (result?.ok !== true)
    return { state: 'error', message: result?.message || result?.error || fallback }
  if (result?.skipped === true || Number(result?.count) === 0)
    return { state: 'info', message: result?.message || '本次没有产生实际操作' }
  if (result?.count === undefined && result?.resultState !== 'completed')
    return { state: 'info', message: result?.message || '请求已返回，未提供可确认的效果数量' }
  return { state: 'success', message: result?.message || fallback }
}
const currencyNames: Record<number, string> = { 1001: '金币', 1002: '点券', 1004: '金豆', 1005: '金豆豆' }
export function integerText(value: any): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'bigint' && value >= 0n) return value.toString()
  // protobufjs int64 is sometimes serialized through the worker as Long's
  // {low, high, unsigned}. Decode its bits, never round through Number.
  if (value && Number.isInteger(value.low) && Number.isInteger(value.high)
    && value.low >= -2147483648 && value.low <= 4294967295
    && value.high >= -2147483648 && value.high <= 4294967295) {
    let result = BigInt(value.high >>> 0) * (1n << 32n) + BigInt(value.low >>> 0)
    if (value.unsigned !== true && value.high < 0) result -= 1n << 64n
    return result >= 0n ? result.toString() : null
  }
  return null
}
/** 数量只针对当前未锁定实例；烟花仍受官方单枚燃放限制。 */
export function itemUseLimit(item: any): number {
  if (!item || [true, 1, '1'].includes(item.locked)) return 0
  const text = integerText(item.count)
  if (text === null || BigInt(text) <= 0n || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) return 0
  return Number(item.id) === 6001 ? 1 : Number(text)
}
export function validateItemUseQuantity(item: any, value: unknown): { count: number, limit: number, error: string } {
  const limit = itemUseLimit(item), text = integerText(value)
  if (!limit) return { count: 0, limit, error: '当前实例不存在、已锁定或可用数量尚未确认，请刷新背包。' }
  if (text === null || BigInt(text) <= 0n || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER))
    return { count: 0, limit, error: '请输入大于零的整数数量。' }
  const count = Number(text)
  if (count > limit) return { count: 0, limit, error: Number(item.id) === 6001 ? '烟花每次只能燃放一枚。' : `当前实例最多可使用 ${limit} 个。` }
  return { count, limit, error: '' }
}
export function useConsumptionConfirmed(reply: any, itemId: number, count: number): boolean {
  return reply?.resultState === 'completed' && integerText(reply.usedCount) === integerText(count)
    && (reply.usedItemId == null || integerText(reply.usedItemId) === integerText(itemId))
    && Number.isSafeInteger(count) && count > 0
}
export function actualSaleRewards(reply: any): Array<{ id: number, count: string, name: string }> {
  const list = reply?.get_items ?? reply?.getItems
  if (!Array.isArray(list)) return []
  return list.flatMap(item => {
    const id = Number(integerText(item?.id)), count = integerText(item?.count)
    return Number.isSafeInteger(id) && id > 0 && count !== null && BigInt(count) > 0n
      ? [{ id, count, name: currencyNames[id] || item.name || `物品${id}` }] : []
  })
}
export function saleConsumptionConfirmed(reply: any, requested: Array<{ id: number, count: number | string, uid?: string | number }>) {
  const sold = reply?.sell_items ?? reply?.sellItems
  if (!Array.isArray(sold) || !requested.length)
    return false
  try {
    const required = new Map<string, bigint>()
    for (const item of requested) {
      const id = integerText(item.id), uid = integerText(item.uid ?? 0), count = integerText(item.count)
      if (!id || !uid || !count || BigInt(count) <= 0n) return false
      const key = JSON.stringify([id, uid])
      required.set(key, (required.get(key) || 0n) + BigInt(count))
    }
    return [...required].every(([key, count]) => {
      const [id, uid] = JSON.parse(key)
      const amount = sold.filter(entry => integerText(entry.id) === id && (uid === '0' || integerText(entry.uid) === uid))
        .reduce((sum, entry) => sum + BigInt(integerText(entry.count) || '0'), 0n)
      return amount >= count
    })
  }
  catch { return false }
}
