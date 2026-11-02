/**
 * 面板请求观测器（只读）
 *
 * 目的：定位「谁在往网关打请求」。网关侧只有超时/判死日志、没有访问日志，
 *       所以面板并发到底是谁发起的一直无法归因。这里在客户端记录：
 *       路径 / 账号 / 页面路由 / 发起时刻 / 耗时 / 同时在途数 / 是否有超时。
 *
 * ⚠️ 防封原则（务必保持）：
 *   - 不发起任何新请求，不改 timeout，不改请求频次，不重试，不改请求体/头。
 *   - 只做时间与计数的本地记录，不写网络、不落敏感数据（query 里的 token/key 一律脱敏）。
 */

import type { AxiosInstance, AxiosResponse } from 'axios'

export interface ReqRecord {
  id: number
  via: 'axios' | 'fetch'
  method: string
  url: string
  accountId: string
  page: string
  caller: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: number | 'pending' | 'timeout' | 'error' | 'canceled'
}

export interface Summary {
  now: number
  inflightTotal: number
  inflightByAccount: Record<string, number>
  window: {
    total: number
    byAccount: Record<string, number>
    byPage: Record<string, number>
    byUrl: Record<string, number>
    peakInflight: number
    timeouts: number
  }
}

const MAX_RECORDS = 400
const WINDOW_MS = 60_000
const SENSITIVE = /token|key|secret|password|passwd|auth/i

const records: ReqRecord[] = []
const inflight = new Map<number, ReqRecord>()
let seq = 0
/** 并发采样点，用于算「近 60s 并发峰值」 */
const samples: { t: number, n: number }[] = []

function maskQuery(url: string): string {
  const q = url.indexOf('?')
  if (q < 0)
    return url
  const path = url.slice(0, q)
  const parts = url.slice(q + 1).split('&').map((kv) => {
    const eq = kv.indexOf('=')
    if (eq < 0)
      return kv
    const k = kv.slice(0, eq)
    return SENSITIVE.test(k) ? `${k}=***` : kv
  })
  return `${path}?${parts.join('&')}`
}

function normUrl(raw: string): string {
  let s = String(raw || '')
  // 相对路径直接用；绝对 URL 只保留 path+query
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      s = `${u.pathname}${u.search}`
    }
    catch { /* 保持原样 */ }
  }
  return maskQuery(s)
}

function currentAccountId(): string {
  try {
    const raw = localStorage.getItem('current_account_id') || '""'
    const v = JSON.parse(raw)
    return v ? String(v) : ''
  }
  catch {
    return ''
  }
}

function currentPage(): string {
  const hash = (location.hash || '').replace(/^#/, '')
  return hash || location.pathname || '/'
}

/** 仅对 window.fetch 有意义：调用栈上第一帧非本模块的代码位置 */
function callerFromStack(): string {
  try {
    const stack = (new Error().stack || '').split('\n')
    for (let i = 1; i < stack.length; i++) {
      const raw = stack[i]
      if (!raw)
        continue
      const line = raw.replace(/^\s*at\s+/, '').trim()
      if (!line || line.includes('requestMonitor'))
        continue
      const m = /([^\s()]+):(\d+):(\d+)/.exec(line)
      if (!m || !m[1])
        continue
      const file = m[1].split('/').pop()!.split('\\').pop()!
      return `${file}:${m[2]}`
    }
  }
  catch { /* ignore */ }
  return ''
}

function snapshotInflight() {
  samples.push({ t: Date.now(), n: inflight.size })
  if (samples.length > 2000)
    samples.splice(0, samples.length - 2000)
}

function begin(via: 'axios' | 'fetch', method: string, rawUrl: string): ReqRecord {
  const rec: ReqRecord = {
    id: ++seq,
    via,
    method: (method || 'GET').toUpperCase(),
    url: normUrl(rawUrl),
    accountId: currentAccountId(),
    page: currentPage(),
    caller: via === 'fetch' ? callerFromStack() : '',
    startedAt: Date.now(),
    endedAt: 0,
    durationMs: 0,
    status: 'pending',
  }
  records.push(rec)
  if (records.length > MAX_RECORDS)
    records.splice(0, records.length - MAX_RECORDS)
  inflight.set(rec.id, rec)
  snapshotInflight()
  return rec
}

function finish(rec: ReqRecord | undefined, status: ReqRecord['status'], accountIdFromHeader?: string) {
  if (!rec)
    return
  if (accountIdFromHeader)
    rec.accountId = accountIdFromHeader
  rec.endedAt = Date.now()
  rec.durationMs = rec.endedAt - rec.startedAt
  rec.status = status
  inflight.delete(rec.id)
  snapshotInflight()
}

function tally(map: Record<string, number>, key: string) {
  if (!key)
    return
  map[key] = (map[key] || 0) + 1
}

export function summarize(): Summary {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const byAccount: Record<string, number> = {}
  const byPage: Record<string, number> = {}
  const byUrl: Record<string, number> = {}
  const inflightByAccount: Record<string, number> = {}
  let total = 0
  let timeouts = 0

  for (const r of inflight.values())
    tally(inflightByAccount, r.accountId || '(未知)')

  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || r.startedAt < cutoff)
      break
    total++
    tally(byAccount, r.accountId || '(未知)')
    tally(byPage, r.page)
    tally(byUrl, `${r.method} ${r.url}`)
    if (r.status === 'timeout')
      timeouts++
  }

  let peakInflight = 0
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (!s || s.t < cutoff)
      break
    if (s.n > peakInflight)
      peakInflight = s.n
  }

  return {
    now,
    inflightTotal: inflight.size,
    inflightByAccount,
    window: { total, byAccount, byPage, byUrl, peakInflight, timeouts },
  }
}

export function dumpRecords(limit = 60): ReqRecord[] {
  return records.slice(-limit)
}

/** 打印最近请求明细 + 汇总（排查时用） */
export function dumpToConsole(limit = 60) {
  const rows = dumpRecords(limit).map(r => ({
    time: new Date(r.startedAt).toLocaleTimeString(),
    via: r.via,
    account: r.accountId || '-',
    page: r.page,
    method: r.method,
    url: r.url,
    ms: r.durationMs,
    status: r.status,
    caller: r.caller,
  }))
  // eslint-disable-next-line no-console
  console.table(rows)
  // eslint-disable-next-line no-console
  console.log('[面板请求观测] 汇总(近60s)', summarize())
}

/** 按 URL 聚合打印，用于找「谁在刷屏」 */
export function dumpTopUrls(limit = 60) {
  const s = summarize()
  const top = Object.entries(s.window.byUrl)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([url, count]) => ({ url, count }))
  // eslint-disable-next-line no-console
  console.table(top)
  // eslint-disable-next-line no-console
  console.log('[面板请求观测] 汇总(近60s)', s)
  void limit
}

/** 挂到 axios 实例上（只读拦截，绝不修改 config 行为） */
export function attachAxiosMonitor(instance: AxiosInstance) {
  const idMap = new WeakMap<object, ReqRecord>()

  instance.interceptors.request.use((config) => {
    try {
      const url = `${config.baseURL || ''}${config.url || ''}`
      const rec = begin('axios', String(config.method || 'get'), url)
      idMap.set(config as object, rec)
    }
    catch { /* 观测失败绝不影响请求 */ }
    return config
  })

  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      try {
        const rec = idMap.get(response.config as object)
        const headerAccount = String((response.config?.headers as any)?.['x-account-id'] || '')
        finish(rec, response.status, headerAccount)
      }
      catch { /* ignore */ }
      return response
    },
    (error: any) => {
      try {
        const rec = error?.config ? idMap.get(error.config as object) : undefined
        const headerAccount = String((error?.config?.headers as any)?.['x-account-id'] || '')
        let status: ReqRecord['status'] = 'error'
        if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || '')))
          status = 'timeout'
        else if (error?.code === 'ERR_CANCELED')
          status = 'canceled'
        else if (typeof error?.response?.status === 'number')
          status = error.response.status
        finish(rec, status, headerAccount)
      }
      catch { /* ignore */ }
      return Promise.reject(error)
    },
  )
}

/** 包装 window.fetch（wx-login 等裸 fetch 路径不走 axios，必须单独覆盖） */
export function patchFetchMonitor() {
  const w = window as any
  if (w.__reqMonitorFetchPatched)
    return
  w.__reqMonitorFetchPatched = true

  const orig = window.fetch.bind(window)
  window.fetch = ((input: any, init?: any) => {
    let rec: ReqRecord | undefined
    let url = ''
    let method = 'GET'
    try {
      url = typeof input === 'string' ? input : String(input?.url || '')
      method = String(init?.method || input?.method || 'GET').toUpperCase()
      rec = begin('fetch', method, url)
    }
    catch { /* ignore */ }

    return orig(input, init).then(
      (res: Response) => {
        finish(rec, res.status)
        return res
      },
      (err: any) => {
        finish(rec, err?.name === 'AbortError' ? 'canceled' : 'error')
        throw err
      },
    )
  }) as typeof window.fetch
}

const BADGE_ID = 'panel-req-monitor'
const HIDE_KEY = 'panel_req_monitor_hidden'

/** 左下角小角标：只读显示，点击打印明细，× 隐藏（持久化） */
export function mountMonitorBadge() {
  const attach = () => {
    if (document.getElementById(BADGE_ID) || localStorage.getItem(HIDE_KEY) === '1')
      return

    const box = document.createElement('div')
    box.id = BADGE_ID
    box.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:99999',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'padding:3px 6px',
      'border-radius:6px',
      'background:rgba(17,24,39,.78)',
      'color:#e5e7eb',
      'cursor:pointer',
      'user-select:none',
      'white-space:nowrap',
      'letter-spacing:0',
    ].join(';')

    const close = document.createElement('span')
    close.textContent = '×'
    close.title = '隐藏（如需恢复：localStorage.removeItem("panel_req_monitor_hidden")）'
    close.style.cssText = 'margin-left:6px;opacity:.65;padding:0 2px'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      localStorage.setItem(HIDE_KEY, '1')
      box.remove()
    })

    box.addEventListener('click', () => dumpToConsole(60))
    box.title = '点击打印最近请求明细；× 隐藏'
    document.body.appendChild(box)

    const render = () => {
      const s = summarize()
      const acc = Object.entries(s.window.byAccount)
        .map(([k, v]) => `${k}:${v}`)
        .join(',') || '-'
      box.textContent = ''
      const main = document.createElement('span')
      main.textContent = `面板req 在途 ${s.inflightTotal} | 60s ${s.window.total}次 (${acc}) | 峰值 ${s.window.peakInflight} | 超时 ${s.window.timeouts}`
      box.appendChild(main)
      box.appendChild(close)

      let level = 'rgba(17,24,39,.78)'
      if (s.window.peakInflight >= 6 || s.window.timeouts >= 5)
        level = 'rgba(153,27,27,.92)'
      else if (s.window.peakInflight >= 3 || s.window.timeouts > 0)
        level = 'rgba(120,53,15,.92)'
      box.style.background = level
    }

    render()
    setInterval(render, 1000)
  }

  if (document.body)
    attach()
  else
    document.addEventListener('DOMContentLoaded', attach, { once: true })
}

/** 统一出口 */
export function installRequestMonitor(axiosInstance?: AxiosInstance) {
  patchFetchMonitor()
  if (axiosInstance)
    attachAxiosMonitor(axiosInstance)
  mountMonitorBadge()
  ;(window as any).__reqMonitor = { summarize, dumpRecords, dumpToConsole, dumpTopUrls }
}
