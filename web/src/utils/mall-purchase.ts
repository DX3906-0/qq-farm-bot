/**
 * 商城购买相关的前端工具函数。
 *
 * 2026-11-02 同步上游：`mallpb.PurchaseLimit.limit_type` 的语义被官方更正为
 *   1=每日 / 2=每周 / 3=每月 / 4=永久
 * 旧注释曾写作 "1=daily, 4=activity-period"，导致「永久限购」被误显示成「活动期限购」。
 *
 * 字段说明（对应 stores/shop.ts 的 ShopMallGoods）：
 *   limitCount  限购总数
 *   boughtNum   已购数量
 *   limitType   限购周期类型（后端透传 PurchaseLimit.limit_type）
 */

const MALL_LIMIT_LABELS: Record<number, string> = {
  1: '每日限购',
  2: '每周限购',
  3: '每月限购',
  4: '永久限购',
}

/** 把 limit_type 映射成中文标签；未知类型回退为「限购」。 */
export function getMallLimitLabel(type?: number | null): string {
  return MALL_LIMIT_LABELS[Number(type)] || '限购'
}

/**
 * 生成限购进度文案，例如「每日限购 2/3」。
 * 数据不全时返回空串，由调用方决定是否隐藏。
 */
export function getMallLimitText(goods: {
  limitType?: number
  boughtNum?: number
  boughtCount?: number
  limitCount?: number
}): string {
  const limit = Number(goods?.limitCount ?? 0)
  if (!limit) return ''
  const bought = Number(goods?.boughtNum ?? goods?.boughtCount ?? 0)
  return `${getMallLimitLabel(goods?.limitType)} ${bought}/${limit}`
}

/** 是否已买满（limitCount 存在且已购已达上限）。 */
export function isMallSoldOut(goods: {
  boughtNum?: number
  boughtCount?: number
  limitCount?: number
}): boolean {
  const limit = Number(goods?.limitCount ?? 0)
  if (!limit) return false
  const bought = Number(goods?.boughtNum ?? goods?.boughtCount ?? 0)
  return bought >= limit
}