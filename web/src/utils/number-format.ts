export type ResourceCurrency = 'gold' | 'coupon' | 'goldBean' | 'goldVoucher'

const WAN_UNIT = '\u4E07'
const YI_UNIT = '\u4EBF'
const WAN_THRESHOLD = 10000n
const YI_THRESHOLD = 100000000n

function toFiniteNumber(value: unknown) {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function compactInteger(value: bigint, divisor: bigint, unit: string) {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const hundredths = (absolute * 100n + divisor / 2n) / divisor
  const whole = hundredths / 100n
  const fraction = (hundredths % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole.toLocaleString('zh-CN')}.${fraction}${unit}`
}

function integerValue(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    try { return BigInt(value.trim()) }
    catch { return null }
  }
  return null
}

function formatCompactAmount(value: unknown) {
  const exact = integerValue(value)
  if (exact !== null) {
    const absolute = exact < 0n ? -exact : exact
    if (absolute >= YI_THRESHOLD) return compactInteger(exact, YI_THRESHOLD, YI_UNIT)
    if (absolute >= WAN_THRESHOLD) return compactInteger(exact, WAN_THRESHOLD, WAN_UNIT)
    return exact.toLocaleString('zh-CN')
  }
  const amount = toFiniteNumber(value)
  const absAmount = Math.abs(amount)
  if (absAmount >= Number(YI_THRESHOLD))
    return `${(amount / Number(YI_THRESHOLD)).toFixed(2)}${YI_UNIT}`
  if (absAmount >= Number(WAN_THRESHOLD))
    return `${(amount / Number(WAN_THRESHOLD)).toFixed(2)}${WAN_UNIT}`
  return amount.toLocaleString('zh-CN')
}

export function formatIntegerAmount(value: unknown) {
  const exact = integerValue(value)
  if (exact !== null) return exact.toLocaleString('zh-CN')
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toLocaleString('zh-CN') : '—'
}

export function formatGoldAmount(value: unknown) {
  return formatWanAmount(value)
}

export function formatWanAmount(value: unknown) {
  return formatCompactAmount(value)
}

export function formatCouponAmount(value: unknown) {
  return formatWanAmount(value)
}

export function formatGoldBeanAmount(value: unknown) {
  return formatWanAmount(value)
}

export function formatCurrencyAmount(value: unknown, currency: ResourceCurrency) {
  if (currency === 'gold')
    return formatGoldAmount(value)
  return formatWanAmount(value)
}

export function formatCurrencyAmountByLabel(value: unknown, label: string) {
  const text = String(label || '')
  if (text.includes('\u91D1\u5E01'))
    return formatGoldAmount(value)
  if (text.includes('\u70B9\u5238') || text.includes('\u91D1\u8C46\u8C46') || text.includes('\u91D1\u8C46') || text.includes('\u91D1\u5238'))
    return formatWanAmount(value)
  return formatIntegerAmount(value)
}
