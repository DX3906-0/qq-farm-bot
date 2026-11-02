// 活动可见性配置：控制活动在前端活动页 tab/面板与自动化设置开关中的展示。
// 隐藏的活动后端逻辑保留，仅前端不展示。
//
// ⚠️ 分工（与 core/src/models/store.js 对齐）：
//   A. 有明确时间窗的活动 → **不进本集合**，一律由 activity-windows.ts 的
//      ACTIVITY_WINDOWS + isActivityInSeason() 判定：窗口外自动隐藏、
//      换皮返厂（更新窗口常量）自动复活，零人工。
//   B. 无窗口数据（永久下线 / 窗口未知）的活动 → 才登记到本集合，恒隐藏。
// 本集合只作为「无窗口活动」的兜底，不再承担「过期活动」的职责。
import { isActivityInSeason } from '@/constants/activity-windows'

export const HIDDEN_ACTIVITIES: ReadonlySet<string> = new Set([
  'qingmei',
  // 七夕（鹊桥寄情）活动已结束，且**缺官方窗口数据**（getQixiActivity 返回 active:false，
  // 无法推断下次开放时间）→ 归入无窗口兜底；后端逻辑保留，返厂时移除本 key 即恢复。
  'qixi',
  // 千星游记（通行令 / SeasonPassport）已于 2026-08-28 0 点结束，缺窗口数据 → 兜底隐藏；
  // 后端 getSeasonPassport 逻辑保留，活动返厂时移除本 key 即恢复。
  'journey',
  // 日志确认「心许千灯星垂野」整棵活动树（含 观星礼录 records / 星砂兑换商店 shop / 节令小札 notes）
  // 在 2026-08-28 0 点整体下线（getStarActivity 找不到根节点），缺窗口数据 → 一并兜底隐藏；
  // 后端 getStarActivity 已优雅降级返回 warning，活动返厂时移除这些 key 即恢复。
  'records',
  'shop',
  'notes',
])
// 已按时间窗自动收口的活动（**不再列在此处**，窗口外由 isActivityInSeason 自动隐藏）：
//   honghua      公益小红花  窗口 2026-09-01 ~ 2026-09-09 23:59
//   rain-poem    雨落成诗    窗口 2026-08-26 10:00 ~ 2026-09-08 23:59
//   wish-sign    秋祈良愿    窗口 2026-09-24 00:00 ~ 2026-10-07 23:59
//   share-reward 快乐不独享  窗口 2026-09-24 00:00 ~ 2026-10-12 23:59
//   pet-diary    萌宠日记    窗口 2026-09-10 10:00 ~ 2026-10-12 23:59

export function isActivityHidden(key: string): boolean {
  // 有窗口的活动：窗口内视为可见（false），窗口外视为隐藏（true）
  if (!isActivityInSeason(key))
    return true
  return HIDDEN_ACTIVITIES.has(key)
}
