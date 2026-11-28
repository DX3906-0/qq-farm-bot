import type { MilkTeaActivityData } from '@/stores/activity'

export interface ActivityTodo {
  id: string
  label: string
  detail: string
  target?: string
  actionLabel?: string
  status: 'ready' | 'done' | 'idle' | 'unknown'
  automated: boolean | null
}
export interface ActivityOverview {
  known: boolean
  ready: number | null
  done: number | null
  tasks: ActivityTodo[]
  note: string
}
// Allowlisted presentation destinations only. Navigation never sends a write.
export function milkTeaNavigationTarget(target: string): { page: string, anchor: string } | null {
  const [page, anchor, extra] = target.split(':')
  const anchors: Record<string, string[]> = { shop: ['shop', 'opening', 'cashier'], workshop: ['workshop'], hireList: ['hireList'],
    upgrade: ['upgrade'], work: ['work', 'wages'], exchange: ['exchange'], fund: ['fund'], rank: ['rank'], logs: ['logs'] }
  if (!page || !Object.prototype.hasOwnProperty.call(anchors, page) || extra !== undefined) return null
  const action = anchor || page
  return anchors[page]!.includes(action) ? { page, anchor: action } : null
}

const auto = (settings: Record<string, unknown> | null, key: string) => typeof settings?.[key] === 'boolean' ? settings[key] as boolean : null
const hasRewards = (items: Array<{ itemCount?: number, count?: number }> | undefined) => Array.isArray(items)
  && items.some(item => Number(item.itemCount ?? item.count) > 0)

// Presentation-only derivation: no requests, game operations, defaults-as-health
// or new cached snapshots. A visible task navigates to the existing panel.
export function milkTeaOverview(state: MilkTeaActivityData | null, automation: Record<string, unknown> | null, uncertain = false, now = state?.serverTime || 0): ActivityOverview {
  if (!state?.summary || typeof state.active !== 'boolean' || !Number.isFinite(state.serverTime) || state.serverTime <= 0
    || !Number.isFinite(now) || now <= 0 || !state.startTime || !state.endTime || state.endTime <= state.startTime || uncertain)
    return { known: false, ready: null, done: null, tasks: [], note: uncertain ? '进度正在确认，不能把上次结果当作已完成。' : '当前进度尚未确认，请读取本活动后查看。' }
  if (!state.active || now < state.startTime || now >= state.endTime) return { known: true, ready: 0, done: null, tasks: [], note: '活动当前不在开放期，历史进度不作为可领取事项。' }
  if (Math.abs(now - state.serverTime) > 300) return { known: false, ready: null, done: null, tasks: [], note: '上次进度已过时，请刷新当前活动后确认。' }
  const settling = state.settling || state.settleStartTime > 0 && now >= state.settleStartTime
  const tasks: ActivityTodo[] = []
  const add = (id: string, label: string, detail: string, target: string, status: ActivityTodo['status'], key = '') => {
    const actionLabels: Record<string, string> = { opening: '前往开店', cashier: '查看收益', wages: '前往领工资', upgrade: '查看升级', fund: '查看基金', exchange: '前往兑换' }
    tasks.push({ id, label, detail, target, actionLabel: actionLabels[id] || '前往查看', status, automated: key ? auto(automation, key) : false })
  }
  if (state.summary.shopOpenAt <= 0 && !settling)
    add('opening', '开启奶茶店', '开业后可开始经营；奖励以实际到账为准。', 'shop:opening', 'ready')
  if (state.summary.shopOpenAt > 0) {
    if (state.shop && Array.isArray(state.shop.pendingRewards)) add('cashier', '收银台收益', hasRewards(state.shop.pendingRewards) ? '有收益可领，进入奶茶店核对。' : '本次读取暂无待领收益。', 'shop:cashier', hasRewards(state.shop.pendingRewards) ? 'ready' : 'idle', 'milk_tea_cashier')
    else add('cashier', '收银台收益', '进入奶茶店后确认待领收益。', 'shop:cashier', 'unknown', 'milk_tea_cashier')
    const wageKnown = typeof state.summary.hasUnclaimedWage === 'boolean'
    add('wages', '打工工资', state.summary.hasUnclaimedWage ? '有工资待领，进入打工页核对。' : wageKnown ? '本次读取暂无待领工资。' : '工资状态尚未下发。', 'work:wages', wageKnown ? state.summary.hasUnclaimedWage ? 'ready' : 'idle' : 'unknown', 'milk_tea_wages')
    if (!settling && state.summary.canUpgrade === true)
      add('upgrade', '店铺可升级', '先查看升级条件，不会自动消耗材料。', 'upgrade', 'ready', 'milk_tea_upgrade')
  }
  if (state.fund) {
    const claimable = state.fund.unlocked && state.fund.tiers.some(tier => tier.state === 2 && hasRewards(tier.rewards))
    add('fund', '成长基金', claimable ? '有已达成档位可领。' : state.fund.unlocked ? '本次读取尚无可领取档位，不将未知档位当作已领取。' : '未解锁；请先查看成本与条件。', 'fund', claimable ? 'ready' : 'idle', 'milk_tea_fund_rewards')
  }
  if (Array.isArray(state.goods)) {
    const available = state.goods.filter(item => item.available === true && hasRewards(item.rewards)).length
    add('exchange', '兑换商店', available ? `${available} 件商品当前可兑换；进入后确认成本与数量。` : '本次读取暂无可兑换商品，仍可查看商店与解锁条件。', 'exchange', available ? 'ready' : 'idle')
  }
  else add('exchange', '兑换商店', '商品与余额需要进入商店确认，不额外预读。', 'exchange', 'unknown')
  const share = state.share
  if (share) {
    const dailyReady = share.daily.claimed === false && share.redDots.daily === true
    tasks.push({ id: 'share-daily', label: '分享每日奖励', detail: dailyReady ? '活动已提示可领取。' : share.daily.claimed ? '本次读取每日奖励已领取。' : '暂无可领取提示。', status: dailyReady ? 'ready' : share.daily.claimed ? 'done' : 'idle', automated: auto(automation, 'milk_tea_share_daily') })
    const milestones = share.milestones.filter(tier => tier.state === 2 && hasRewards(tier.rewards)).length
    tasks.push({ id: 'share-milestones', label: '分享档位奖励', detail: milestones ? `${milestones} 个档位可领；按已有自动设置处理。` : '本次读取暂无可领取档位。', status: milestones ? 'ready' : 'idle', automated: auto(automation, 'milk_tea_share_rewards') })
  }
  const ready = tasks.filter(task => task.status === 'ready').length
  const unknown = tasks.some(task => task.status === 'unknown')
  return { known: true, ready, done: tasks.filter(task => task.status === 'done').length,
    tasks: tasks.sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready')),
    note: `仅统计已读取的当前状态${unknown ? '；部分事项仍待确认' : ''}。开启自动处理不代表已经领取。` }
}

export interface SolarOverviewEvent {
  id: number, name: string, startTime: number, endTime: number, open: boolean,
  canClaim: boolean, canAnswer: boolean, directClaimed: boolean, quizClaimed: boolean, question: string,
  rewards: Array<{ count?: number }>, questionRewards: Array<{ count?: number }>,
  claimResultUnknown?: boolean, answerResultUnknown?: boolean, answerCompletedLocally?: boolean, quizWrongToday?: boolean,
}
export interface SolarOverviewSeason {
  id: number, name: string, claimed: boolean, canClaim: boolean, rewards: Array<{ count?: number }>, resultUnknown?: boolean,
}
export function solarOverview(events: SolarOverviewEvent[] | null, seasons: SolarOverviewSeason[], now: number,
  automation: Record<string, unknown> | null, uncertain = new Set<string>()): ActivityOverview {
  if (!events || !Number.isFinite(now) || now <= 0) return { known: false, ready: null, done: null, tasks: [], note: '节令进度尚未读取，基础礼与答题分别确认。' }
  const tasks: ActivityTodo[] = []
  for (const event of events) {
    const within = !!event.startTime && event.endTime > event.startTime && now >= event.startTime && now <= event.endTime && event.open === true
    if (!within) continue
    const basicUnknown = event.claimResultUnknown || uncertain.has(`claim:${event.id}`)
    tasks.push({ id: `claim:${event.id}`, label: `${event.name} · 基础小礼`, detail: basicUnknown ? '结果待确认，只刷新，不重复提交。' : event.directClaimed ? '本次读取已领取。' : event.canClaim && hasRewards(event.rewards) ? '基础奖励可领取。' : '当前不可领取。',
      target: `event:${event.id}`, status: basicUnknown ? 'unknown' : event.directClaimed ? 'done' : event.canClaim && hasRewards(event.rewards) ? 'ready' : 'idle', automated: auto(automation, 'solar_terms_claim') })
    if (event.question) {
      const quizUnknown = event.answerResultUnknown || uncertain.has(`answer:${event.id}`)
      const ready = event.canAnswer && hasRewards(event.questionRewards) && !event.quizWrongToday && !event.answerCompletedLocally
      tasks.push({ id: `answer:${event.id}`, label: `${event.name} · 答题`, detail: quizUnknown ? '提交结果待确认，不重答。' : event.quizClaimed ? '本次读取答题奖励已领取。' : event.quizWrongToday || event.answerCompletedLocally ? '本题已经提交，不再作答。' : ready ? '每题仅一次机会，先查看题目。' : '当前不可作答。', target: `question:${event.id}`,
        status: quizUnknown ? 'unknown' : event.quizClaimed ? 'done' : ready ? 'ready' : 'idle', automated: auto(automation, 'solar_terms_auto_answer') })
    }
  }
  for (const season of seasons.filter(value => value.canClaim && !value.claimed && hasRewards(value.rewards) || value.resultUnknown || uncertain.has(`season:${value.id}`))) {
    const unknown = season.resultUnknown || uncertain.has(`season:${season.id}`)
    tasks.push({ id: `season:${season.id}`, label: `${season.name} · 集齐奖励`, detail: unknown ? '领取结果待确认，只刷新。' : '已满足集齐条件，可查看奖励。', target: `season:${season.id}`, status: unknown ? 'unknown' : 'ready', automated: false })
  }
  return { known: true, ready: tasks.filter(task => task.status === 'ready').length, done: tasks.filter(task => task.status === 'done').length,
    tasks: tasks.sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready')),
    note: '只统计当前开放的节令；基础礼、答题、集齐奖励互相独立。自动设置不是完成凭据。' }
}
