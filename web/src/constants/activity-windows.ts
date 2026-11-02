// 活动时间窗常量（前端侧）。
//
// ⚠️ 与 core/src/models/store.js 的 TIMED_ACTIVITY_AUTOMATION_GROUPS 是**手工同步的两份字面量**
// （core 是 CommonJS、web 是 TS，无法共享模块）。改一处必须改另一处，
// 否则前端会显示后端已强制关闭的开关，或隐藏后端仍在跑的活动。
//
// 时间窗口径与服务端一致：UTC+8 秒级时间戳的**闭区间**——
//   now >= startTime 且 now <= endTime 才算窗口内。
//
// 单一事实来源原则：活动「是否在期」优先由本文件的时间窗判定，
// 窗口外自动隐藏 tab / 开关、窗口内自动恢复（换皮返厂零人工）。
// 仅「无窗口数据的永久下线活动」才需要进 activityVisibility.ts 的 HIDDEN_ACTIVITIES。

export interface ActivityWindow {
  /** 窗口开始（UTC+8 秒级时间戳） */
  startTime: number
  /** 窗口结束（UTC+8 秒级时间戳，闭区间） */
  endTime: number
  /** 可读备注，仅用于维护（不参与计算） */
  note?: string
}

/** 雨落成诗：2026-08-26 10:00 ~ 2026-09-08 23:59 */
export const RAIN_POEM_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1787709600,
  endTime: 1788883199,
  note: '2026-08-26 10:00 ~ 2026-09-08 23:59',
}

/** 公益小红花：2026-09-01 00:00 ~ 2026-09-09 23:59 */
export const CHARITY_FLOWER_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1788192000,
  endTime: 1788969599,
  note: '2026-09-01 00:00 ~ 2026-09-09 23:59',
}

/** 秋祈良愿（中秋祈愿）：2026-09-24 00:00 ~ 2026-10-07 23:59 */
export const WISH_SIGN_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1790179200,
  endTime: 1791388799,
  note: '2026-09-24 00:00 ~ 2026-10-07 23:59',
}

/** 快乐不独享（分享奖励）：2026-09-24 00:00 ~ 2026-10-12 23:59 */
export const SHARE_REWARD_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1790179200,
  endTime: 1791820799,
  note: '2026-09-24 00:00 ~ 2026-10-12 23:59',
}

/** 萌宠成长日记：2026-09-10 10:00 ~ 2026-10-12 23:59 */
export const PET_DIARY_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1789005600,
  endTime: 1791820799,
  note: '2026-09-10 10:00 ~ 2026-10-12 23:59',
}

/**
 * 奶茶热销中（S4 店铺经营）：2026-10-15 10:00 ~ 2026-11-16 23:59
 * 含领奖期（结算期）的完整窗口——领收银台/领工资/分享/基金/点券礼包在整个窗口内都可用。
 */
export const MILK_TEA_ACTIVITY_WINDOW: ActivityWindow = {
  startTime: 1792029600,
  endTime: 1794844799,
  note: '2026-10-15 10:00 ~ 2026-11-16 23:59',
}

/**
 * 奶茶热销中「经营期」：2026-10-15 10:00 ~ 2026-11-14 23:59:58
 * 经营类操作（升级/制作/加速/雇佣/买种子）只在经营期内有效，结算期执行会被服务端拒绝。
 */
export const MILK_TEA_BUSINESS_WINDOW: ActivityWindow = {
  startTime: 1792029600,
  endTime: 1794671998,
  note: '2026-10-15 10:00 ~ 2026-11-14 23:59:58（经营期）',
}

/** 别名：兼容历史命名（小红花旧称 RED_FLOWER） */
export const RED_FLOWER_ACTIVITY_WINDOW = CHARITY_FLOWER_ACTIVITY_WINDOW

/** 活动 key → 时间窗。新增活动窗口时在此登记，前端即自动获得显隐能力。 */
export const ACTIVITY_WINDOWS: Record<string, ActivityWindow> = {
  'rain-poem': RAIN_POEM_ACTIVITY_WINDOW,
  honghua: CHARITY_FLOWER_ACTIVITY_WINDOW,
  'wish-sign': WISH_SIGN_ACTIVITY_WINDOW,
  'share-reward': SHARE_REWARD_ACTIVITY_WINDOW,
  'pet-diary': PET_DIARY_ACTIVITY_WINDOW,
  'milk-tea': MILK_TEA_ACTIVITY_WINDOW,
}

/**
 * 判断某活动窗口当前是否在期（闭区间）。
 * @param win 窗口（缺省 start/end 视为不限，恒在期）
 * @param nowMs 当前时间毫秒戳（默认 Date.now()）
 */
export function isWithinActivityWindowMs(
  win: { startTime?: number, endTime?: number },
  nowMs = Date.now(),
): boolean {
  const nowSec = Math.floor(nowMs / 1000)
  const start = Number(win?.startTime) || 0
  const end = Number(win?.endTime) || 0
  return (!start || nowSec >= start) && (!end || nowSec <= end)
}

/**
 * 按活动 key 判断是否在期。
 * 未登记时间窗的 key 一律视为「无窗口信息」→ 返回 true（交由 HIDDEN_ACTIVITIES 收口），
 * 避免误隐藏尚未登记窗口的活动。
 */
export function isActivityInSeason(key: string, nowMs = Date.now()): boolean {
  const win = ACTIVITY_WINDOWS[key]
  if (!win)
    return true
  return isWithinActivityWindowMs(win, nowMs)
}
