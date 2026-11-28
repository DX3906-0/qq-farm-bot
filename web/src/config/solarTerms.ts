import type { HeluSolarTerm } from '@/stores/activity'

// 官方 delayRes/config.943e2.json -> config/SolarTerms (GUID 4793f84e...).
// 403由当前服务器11/07~11/13发放窗口及本轮立冬奖励核实；未知ID不猜节令名。
export const SOLAR_TERM_NAMES: Readonly<Record<number, string>> = {
  101: '端午', 102: '夏至', 103: '小暑',
  201: '大暑', 202: '立秋', 203: '七夕', 204: '处暑',
  301: '白露', 302: '秋分', 303: '中秋', 304: '寒露',
  401: '重阳', 402: '霜降', 403: '立冬',
}

// 官方 SolarTermsInfoModel.ts 的 V1 枚举；V2的window_status是另一组值，不能混用。
// 4=SOLAR_TERMS_STATUS_EXPIRED_UNCLAIMED，5=...EXPIRED_CLAIMED。
const STATUS_LABELS: Readonly<Record<number, string>> = {
  0: '状态未知', 1: '尚未开放', 2: '可领取', 3: '已领取',
  4: '已过期未领取', 5: '已过期已领取',
}

export function solarTermName(term?: Pick<HeluSolarTerm, 'id' | 'title'> | null): string {
  if (!term) return '暂无当前节令'
  return term.title?.trim() || SOLAR_TERM_NAMES[term.id] || `节令 ${term.id}`
}

export function solarTermStatusLabel(term: Pick<HeluSolarTerm, 'status' | 'statusLabel'>): string {
  return STATUS_LABELS[term.status] || term.statusLabel || '状态未知'
}

interface SolarTermWindow { id: number, startTime: number, endTime: number }

export function orderSolarTerms<T extends SolarTermWindow>(terms: readonly T[] = [], serverTime = 0): T[] {
  // Current windows first, then latest started events, future previews, unknown.
  // Sort a copy: presentation must never mutate the server snapshot or infer open.
  const group = (term: T) => !Number.isFinite(term.startTime) || term.startTime <= 0 ? 3
    : serverTime > 0 && term.startTime > serverTime ? 2
      : serverTime > 0 && term.endTime >= serverTime ? 0 : 1
  return [...terms].sort((a, b) => group(a) - group(b)
    || (Number.isFinite(b.startTime) ? b.startTime : 0) - (Number.isFinite(a.startTime) ? a.startTime : 0)
    || b.id - a.id)
}

export function currentSolarTerm(terms?: HeluSolarTerm[], serverTime = 0, nowMs = Date.now()): HeluSolarTerm | null {
  const now = serverTime > 0 ? serverTime : nowMs / 1000
  return orderSolarTerms(terms || [], now).find(term => term.startTime > 0 && term.startTime <= now) || null
}

export const SOLAR_TERM_ASSETS = {
  background: '/activity/jieling/img_jieling_draw_bg.png',
  winter: '/activity/jieling/2026winter.png',
} as const

export function solarTermIllustration(term?: Pick<HeluSolarTerm, 'id'> | null): string {
  // 已核实冬季通用插画，不伪称是立冬专属立绘，也不拿其他节气图冒充当前节令。
  return term?.id === 403 ? SOLAR_TERM_ASSETS.winter : ''
}
