<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import type { ExpRateInfo } from '@/stores/status'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { formatCouponAmount, formatGoldAmount, formatGoldBeanAmount } from '@/utils/number-format'
import { deriveAccountPresentation, integerText } from '@/utils/operation-result'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import { useSettingStore } from '@/stores/setting'
import { vFoldMotion } from '@/composables/useContentMotion'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const toastStore = useToastStore()
const settingStore = useSettingStore()

const {
  status,
  logs: statusLogs,
  accountLogs: statusAccountLogs,
  realtimeConnected,
  currentStatusReady,
  currentStatusMetadata,
  currentStatusStale,
  loading: statusLoading,
  error: statusError,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { dashboardItems, bagAccountId, lastUpdatedAt: bagUpdatedAt, mutationStates: bagMutationStates } = storeToRefs(bagStore)
const presentation = computed(() => deriveAccountPresentation({
  accountId: currentAccountId.value, account: currentAccount.value,
  snapshot: currentStatusReady.value ? { ...status.value, metadata: currentStatusMetadata.value } : null,
  snapshotReady: currentStatusReady.value, loading: statusLoading.value, error: statusError.value,
  stale: currentStatusStale.value, readonly: LOCAL_UI_READONLY,
}))
const readableStatus = computed(() => currentStatusReady.value ? status.value : null)
const readableBag = computed(() => !!currentAccountId.value && bagAccountId.value === String(currentAccountId.value) && bagUpdatedAt.value > 0 && !bagStore.readError)
const lastStatusTime = computed(() => currentStatusMetadata.value?.updatedAt
  ? new Date(currentStatusMetadata.value.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '')
function statusAmount(value: unknown, format: (value: any) => string) {
  return currentStatusReady.value && integerText(value) !== null ? format(value) : '—'
}
const dashboardNotice = computed(() => {
  if (LOCAL_UI_READONLY) return { text: '本地只读浏览 · 未登录账号，不读取实时数据。', path: '', action: '' }
  if (presentation.value.kind === 'unselected') return { text: '未选择账号；选择后才能确认游戏状态。', path: '/settings?tab=account', action: '查看账号' }
  if (accountStore.operationStates[String(currentAccountId.value)] === 'unknown') return { text: accountStore.operationErrors[String(currentAccountId.value)] || '账号操作结果未确认；相关操作暂缓，刷新可读取当前状态。', path: '/settings?tab=account', action: '查看账号' }
  if (bagMutationStates.value[String(currentAccountId.value)] === 'unknown') return { text: '背包操作结果未确认，相关目标暂缓；刷新可读取当前状态。', path: '/personal', action: '查看背包' }
  if (settingStore.mutationStates[String(currentAccountId.value)] === 'unknown') return { text: '设置保存结果未确认，暂不重复提交；重新读取设置可查看当前状态。', path: '/settings', action: '查看设置' }
  if (settingStore.defaultPlanApplications[String(currentAccountId.value)] === 'unknown') return { text: '默认方案应用结果未确认，暂不重复应用；重新读取可查看当前设置。', path: '/settings?tab=account', action: '查看账号' }
  if (['offline', 'stale', 'error', 'unknown', 'loading'].includes(presentation.value.kind)) return { text: presentation.value.detail, path: '/settings?tab=account', action: '查看账号' }
  return null
})

const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const lastBagFetchAt = ref(0)
const clearingLogs = ref(false)
let disposed = false
let accountEpoch = 0
let refreshInFlight: Promise<void> | null = null
let bagInFlight: Promise<void> | null = null
let refreshQueued = false
let forceLogsQueued = false

function isRefreshCurrent(accountId: string, epoch: number) {
  return !disposed && accountEpoch === epoch && currentAccountId.value === accountId
}

watch(currentAccountId, () => { accountEpoch += 1 }, { flush: 'sync' })

const filter = reactive({
  module: '',
  event: '',
  keyword: '',
  isWarn: '',
})

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keyword || filter.isWarn),
)
const currentAccountDisconnected = computed(() => presentation.value.kind === 'offline' || presentation.value.kind === 'stopped')

const allLogs = computed(() => {
  const sLogs = statusLogs.value || []
  const aLogs = (statusAccountLogs.value || [])
    // 账号级日志（登录/掉线等）**没有 module/event 字段**，无法参与模块/事件筛选：
    // 启用这两类筛选时直接不展示，避免「筛了好友却混进系统日志」。
    .filter((log: any) => {
      if (filter.module && filter.module !== 'system')
        return false
      if (filter.event)
        return false
      if (filter.isWarn === 'warn' && log?.action !== 'Error')
        return false
      if (filter.isWarn === 'info' && log?.action === 'Error')
        return false
      if (filter.keyword) {
        const kw = filter.keyword.trim().toLowerCase()
        if (kw && !`${log?.msg || ''}`.toLowerCase().includes(kw))
          return false
      }
      return true
    })
    .map((log: any) => ({
      ts: new Date(log.time).getTime(),
      time: log.time,
      tag: log.action === 'Error' ? '错误' : '系统',
      msg: log.reason ? `${log.msg} (${log.reason})` : log.msg,
      isAccountLog: true,
    }))

  return [...sLogs, ...aLogs]
    .sort((a: any, b: any) => a.ts - b.ts)
})

const modules = [
  { label: '全部模块', value: '' },
  { label: '农场', value: 'farm' },
  { label: '好友', value: 'friend' },
  { label: '仓库', value: 'warehouse' },
  { label: '任务', value: 'task' },
  { label: '活动', value: 'activity' },
  { label: '系统', value: 'system' },
]

const events = [
  { label: '全部事件', value: '' },
  { label: '农场巡查', value: 'farm_cycle' },
  { label: '收获作物', value: 'harvest_crop' },
  { label: '清理枯枝', value: 'remove_plant' },
  { label: '种植种子', value: 'plant_seed' },
  { label: '施加化肥', value: 'fertilize' },
  { label: '土地提醒', value: 'lands_notify' },
  { label: '选择种子', value: 'seed_pick' },
  { label: '购买种子', value: 'seed_buy' },
  { label: '购买化肥', value: 'fertilizer_buy' },
  { label: '开启礼盒', value: 'fertilizer_gift_open' },
  { label: '获取任务', value: 'task_scan' },
  { label: '完成任务', value: 'task_claim' },
  { label: '免费礼包', value: 'mall_free_gifts' },
  { label: '分享奖励', value: 'daily_share' },
  { label: '会员礼包', value: 'vip_daily_gift' },
  { label: '月卡礼包', value: 'month_card_gift' },
  { label: '图鉴奖励', value: 'illustrated_rewards' },
  { label: '邮箱领取', value: 'email_rewards' },
  { label: '出售成功', value: 'sell_success' },
  { label: '土地升级', value: 'upgrade_land' },
  { label: '土地解锁', value: 'unlock_land' },
  { label: '好友巡查', value: 'friend_cycle' },
  { label: '访问好友', value: 'visit_friend' },
]

const logLevels = [
  { label: '全部级别', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
]

const eventLabelMap: Record<string, string> = Object.fromEntries(
  events.filter(event => event.value).map(event => [event.value, event.label]),
)

const displayName = computed(() => {
  const account = accountStore.currentAccount
  if (!currentAccountId.value) return LOCAL_UI_READONLY ? '本地浏览 · 无账号' : '未选择账号'
  const gameName = readableStatus.value?.status?.name

  if (gameName) {
    if (account?.name)
      return `${gameName} (${account.name})`
    return gameName
  }

  if (currentAccountDisconnected.value) {
    if (account) {
      if (account.name && account.nick)
        return `${account.nick} (${account.name})`
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }

  if (account) {
    if (account.name && account.nick)
      return `${account.nick} (${account.name})`
    return account.name || account.nick || '未命名'
  }

  return '账号资料尚未读取'
})

// 只展示后端真实区间估计；每日收益不能除以滚动样本时长或进程 uptime。
const expRateInfo = computed<ExpRateInfo | null>(() => readableStatus.value?.expRate || null)
const validExpRate = computed(() => {
  const info = expRateInfo.value
  const rate = Number(info?.expPerHour)
  return info && !info.stale && info.reason !== 'clock-regression' && Number.isFinite(rate) && rate > 0 ? rate : 0
})
const expRate = computed(() => {
  const rate = validExpRate.value
  if (rate > 0)
    return `${rate < 1 ? rate.toFixed(2) : Math.round(rate)}/小时`
  if (expRateInfo.value?.reason === 'idle')
    return '0/小时'
  return '--/小时'
})

const timeToLevel = computed(() => {
  const current = Number(readableStatus.value?.levelProgress?.current || 0)
  const needed = Number(readableStatus.value?.levelProgress?.needed || 0)
  if (!Number.isFinite(current) || !Number.isFinite(needed) || needed <= 0)
    return '暂无法预测'
  const expNeeded = Math.max(0, needed - current)
  if (expNeeded <= 0)
    return '即将升级'
  const rate = validExpRate.value
  if (rate <= 0)
    return '暂无法预测'
  // 含等待时间的综合速率已经折算 idle，不能再乘 activeRatio 二次折损。
  const hours = expNeeded / rate
  if (!Number.isFinite(hours))
    return '暂无法预测'
  const duration = hours < 1
    ? `${Math.max(1, Math.ceil(hours * 60))} 分钟`
    : hours < 24 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`
  return `约 ${duration}后升级`
})

const fertilizerNormal = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 3002))

const nextFarmCheck = ref('--:--:--')
const nextHelpCheck = ref('--:--:--')
const nextStealCheck = ref('--:--:--')
const localUptime = ref(0)

let localNextFarmRemainSec = 0
let localNextHelpRemainSec = 0
let localNextStealRemainSec = 0

function resetDashboardState() {
  lastBagFetchAt.value = 0
  localUptime.value = 0
  localNextFarmRemainSec = 0
  localNextHelpRemainSec = 0
  localNextStealRemainSec = 0
  nextFarmCheck.value = '--:--:--'
  nextHelpCheck.value = '--:--:--'
  nextStealCheck.value = '--:--:--'
}

const OP_META: Record<string, { label: string, icon: string, color: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-pest', color: 'text-red-400' },
  farming: { label: '一键务农', icon: 'i-carbon-clean', color: 'text-teal-500' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  goldenBugClear: { label: '清黄金虫', icon: 'i-carbon-clean', color: 'text-amber-500' },
  goldenBugPut: { label: '放黄金虫', icon: 'i-carbon-pest', color: 'text-yellow-500' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-pest', color: 'text-red-300' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
  putBug: { label: '放虫', icon: 'i-carbon-pest', color: 'text-red-600' },
  putWeed: { label: '放草', icon: 'i-carbon-sprout', color: 'text-green-600' },
  dewOnFriend: { label: '友灵露', icon: 'i-carbon-rain-drop', color: 'text-cyan-600' },
  mysteryMerchant: { label: '神秘商人', icon: 'i-carbon-gift', color: 'text-rose-500' },
}

const badTaskText = computed(() => {
  const task = readableStatus.value?.badTask
  if (!task) return ''
  const remaining = Number.isSafeInteger(task.budget?.remaining) ? task.budget.remaining : null
  if (!task.enabled) return '自动放虫放草已关闭；计数仅记录已确认成功的投放。'
  if (task.paused) return `放虫放草因连续错误暂停至 ${task.retryDate}${remaining === null ? '' : `，今日预算仍剩 ${remaining}`}；暂停不代表已达上限。`
  if (task.running) return '正在检查可投放目标；逐地块确认后计入统计。'
  if (remaining === 0) return '今日捣乱预算已用完。'
  if (task.lastRun?.reason === 'unknown_operation') return '有投放结果未确认，已保留访问锁，不重复提交。'
  return remaining === null ? '投放预算尚未确认。' : `今日捣乱预算剩余 ${remaining}；目标装不下时跳过，等待下一轮，不算完成。`
})

const filteredOperations = computed(() => {
  const operations = readableStatus.value?.operations || {}
  const result: Record<string, number> = {}

  for (const key of Object.keys(operations)) {
    if (key !== 'upgrade' && key !== 'levelUp')
      result[key] = operations[key]
  }

  return result
})

function getEventLabel(event: string) {
  return eventLabelMap[event] || event
}

function formatBucketTime(item: any) {
  if (!readableBag.value) return '—'
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  return `${(Number(item.count || 0) / 3600).toFixed(1)}h`
}

function updateCountdowns() {
  if (presentation.value.kind !== 'online') {
    const label = ['unselected', 'readonly'].includes(presentation.value.kind) ? '未选择账号' : presentation.value.label
    nextFarmCheck.value = label
    nextHelpCheck.value = label
    nextStealCheck.value = label
    return
  }

  if (Number.isFinite(readableStatus.value?.uptime)) localUptime.value++

  if (localNextFarmRemainSec > 0) {
    localNextFarmRemainSec--
    nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
  }
  else {
    nextFarmCheck.value = '检查中...'
  }

  if (localNextHelpRemainSec > 0) {
    localNextHelpRemainSec--
    nextHelpCheck.value = formatDuration(localNextHelpRemainSec)
  }
  else {
    nextHelpCheck.value = '检查中...'
  }

  if (localNextStealRemainSec > 0) {
    localNextStealRemainSec--
    nextStealCheck.value = formatDuration(localNextStealRemainSec)
  }
  else {
    nextStealCheck.value = '检查中...'
  }
}

watch(readableStatus, (newVal) => {
  if (newVal?.nextChecks) {
    localNextFarmRemainSec = newVal.nextChecks.farmRemainSec || 0
    localNextHelpRemainSec = newVal.nextChecks.helpRemainSec || 0
    localNextStealRemainSec = newVal.nextChecks.stealRemainSec || 0
    updateCountdowns()
  }

  if (newVal?.uptime !== undefined)
    localUptime.value = newVal.uptime
}, { deep: true })

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainSeconds = Math.floor(seconds % 60)
  const pad = (value: number) => value.toString().padStart(2, '0')

  if (days > 0)
    return `${days}天 ${pad(hours)}:${pad(minutes)}:${pad(remainSeconds)}`
  return `${pad(hours)}:${pad(minutes)}:${pad(remainSeconds)}`
}

function getLogTagClass(tag: string) {
  if (tag === '错误')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (tag === '系统')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (tag === '活动')
    return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
  if (tag === '警告')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}

function getLogMsgClass(tag: string) {
  if (tag === '错误')
    return 'text-red-600 dark:text-red-400'
  return 'text-gray-700 dark:text-gray-300'
}

function formatLogTime(timeStr: string) {
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}

function getOpIcon(key: string | number) {
  return OP_META[String(key)]?.icon || 'i-carbon-circle-dash'
}

function getOpColor(key: string | number) {
  return OP_META[String(key)]?.color || 'text-gray-400'
}

function getExpPercent(progress: any) {
  if (!progress || !progress.needed)
    return 0
  return Math.min(100, Math.max(0, (progress.current / progress.needed) * 100))
}

async function refreshBag(force = false, accountId = currentAccountId.value, epoch = accountEpoch) {
  if (!isRefreshCurrent(accountId, epoch) || !accountId || !currentAccount.value?.running
    || !currentStatusReady.value || !status.value?.connection?.connected)
    return
  if (bagInFlight) {
    await bagInFlight.catch(() => undefined)
    if (isRefreshCurrent(accountId, epoch) && force)
      await refreshBag(false, accountId, epoch)
    return
  }
  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 10000)
    return
  lastBagFetchAt.value = now
  // Reuse the existing one-reader store contract so the account attribution and
  // actual successful update time accompany the items. No extra game request.
  const pending = bagStore.fetchBag(accountId).then(() => undefined)
  bagInFlight = pending
  try {
    await pending
  }
  catch (error) {
    if (isRefreshCurrent(accountId, epoch))
      console.error('刷新背包失败', error)
  }
  finally {
    if (bagInFlight === pending)
      bagInFlight = null
  }
}

async function refreshData(forceReloadLogs: boolean, accountId: string, epoch: number) {
  if (!isRefreshCurrent(accountId, epoch) || !accountId || !currentAccount.value)
    return
  // 首次加载、断线回退时走 HTTP；实时连接正常时优先依赖 WS 推送。
  if (!realtimeConnected.value || !currentStatusReady.value) {
    await statusStore.fetchStatus(accountId)
    if (!isRefreshCurrent(accountId, epoch))
      return
    await statusStore.fetchAccountLogs(accountId)
    if (!isRefreshCurrent(accountId, epoch))
      return
  }
  if (forceReloadLogs || hasActiveLogFilter.value || !realtimeConnected.value) {
    await statusStore.fetchLogs(accountId, {
      module: filter.module || undefined,
      event: filter.event || undefined,
      keyword: filter.keyword || undefined,
      isWarn: filter.isWarn === 'warn' ? true : filter.isWarn === 'info' ? false : undefined,
    })
    if (!isRefreshCurrent(accountId, epoch))
      return
  }
  await refreshBag(false, accountId, epoch)
}

function refresh(forceReloadLogs = false): Promise<void> {
  if (disposed)
    return Promise.resolve()
  if (refreshInFlight) {
    if (forceReloadLogs) {
      refreshQueued = true
      forceLogsQueued = true
    }
    return refreshInFlight
  }
  const accountId = currentAccountId.value
  const epoch = accountEpoch
  const pending = refreshData(forceReloadLogs, accountId, epoch)
    .catch((error) => {
      if (isRefreshCurrent(accountId, epoch))
        console.error('刷新面板失败', error)
    })
    .finally(() => {
      if (refreshInFlight === pending)
        refreshInFlight = null
      if (!disposed && refreshQueued) {
        const forceLogs = forceLogsQueued
        refreshQueued = false
        forceLogsQueued = false
        void refresh(forceLogs)
      }
    })
  refreshInFlight = pending
  return pending
}

function syncRealtimeAccount() {
  if (currentAccountId.value)
    statusStore.connectRealtime(currentAccountId.value)
}

function onLogFilterChange() {
  refresh(true)
}

// 把筛选条件同步给 store：运行日志的 socket 快照/推送是**未过滤**的全量，
// 需要由 store 侧按同一条件再筛一遍，否则 socket 重连（服务端 subscribe 时必发快照）
// 会把筛选结果冲成全量，表现为「选了好友，过一会儿自己跳回全部日志」。
watch(filter, next => statusStore.setLogFilter(next), { deep: true, immediate: true })

function onLogSearchTrigger() {
  refresh(true)
}

watch(currentAccountId, async (newId, oldId) => {
  const epoch = accountEpoch
  if (oldId !== undefined && newId !== oldId) {
    statusStore.clearAccountScopedData()
    bagStore.clearBag()
    resetDashboardState()
  }
  syncRealtimeAccount()
  await refresh(true)
  if (isRefreshCurrent(newId, epoch))
    scrollToBottom()
})

watch(() => status.value?.connection?.connected, (connected) => {
  if (connected)
    refreshBag(true)
})

watch(() => JSON.stringify(status.value?.operations || {}), (next, prev) => {
  if (!realtimeConnected.value || next === prev)
    return
  refreshBag()
})

watch(hasActiveLogFilter, (enabled) => {
  statusStore.setRealtimeLogsEnabled(!enabled)
  refresh()
})

function onLogScroll(event: Event) {
  const element = event.target as HTMLElement
  if (!element)
    return
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight < 50
}

async function clearLogs() {
  if (!currentAccountId.value)
    return

  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await refresh(true)
    }
    else {
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (error: any) {
    const message = error?.response?.data?.error || error?.message || '请求失败'
    toastStore.error(`清空失败: ${message}`)
  }
  finally {
    clearingLogs.value = false
  }
}

watch(allLogs, () => {
  nextTick(() => {
    if (logContainer.value && autoScroll.value)
      logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}, { deep: true })

function resumeLiveLogs() { autoScroll.value = true; scrollToBottom() }
function scrollToBottom() {
  nextTick(() => {
    if (logContainer.value && autoScroll.value)
      logContainer.value.scrollTop = logContainer.value.scrollHeight
  })
}

onMounted(async () => {
  const accountId = currentAccountId.value
  const epoch = accountEpoch
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  syncRealtimeAccount()
  await refresh()
  if (isRefreshCurrent(accountId, epoch))
    scrollToBottom()
})

onUnmounted(() => {
  disposed = true
  accountEpoch += 1
  refreshQueued = false
  forceLogsQueued = false
})

// 每10秒回退刷新，未完成的请求不重叠。
useIntervalFn(() => refresh(), 10000)
// Countdown timer (every 1s)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="flex flex-col gap-5 pt-1 md:pt-2">
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2">
      <div class="ui-card metric-card min-h-[168px] flex flex-col rounded-lg p-5">
        <div class="mb-2 flex items-start justify-between">
          <div class="flex items-center gap-1.5 text-sm text-gray-500">
            <div class="i-fas-user-circle" />
            账号
          </div>
          <div class="rounded-lg bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            {{ currentStatusReady && integerText(readableStatus?.status?.level) !== null ? `Lv.${readableStatus.status.level}` : '等级未读取' }}
          </div>
        </div>
        <div class="mb-1 truncate text-xl font-bold" :title="displayName">
          {{ displayName }}
        </div>
        <div class="mt-auto">
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <div class="flex items-center gap-1">
              <div class="i-fas-bolt text-blue-400" />
              <span>EXP</span>
            </div>
            <span>{{ currentStatusReady && readableStatus?.levelProgress ? `${readableStatus.levelProgress.current ?? '—'} / ${readableStatus.levelProgress.needed ?? '—'}` : '尚未读取' }}</span>
          </div>
          <div class="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: `${getExpPercent(readableStatus?.levelProgress)}%` }"
            />
          </div>
          <div class="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-gray-400">
            <span>效率 {{ expRate }}</span>
            <span>{{ timeToLevel }}</span>
          </div>
        </div>
      </div>

      <div class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5">
        <div class="flex justify-between">
          <div>
            <div class="flex items-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-coins text-yellow-500" />
              金币
            </div>
            <div class="text-2xl text-yellow-600 font-bold dark:text-yellow-500">
              {{ statusAmount(readableStatus?.status?.gold, formatGoldAmount) }}
            </div>
            <div
              v-if="(readableStatus?.sessionGoldGained || 0) !== 0"
              class="dashboard-amount-change"
              :class="(readableStatus?.sessionGoldGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (readableStatus?.sessionGoldGained || 0) > 0 ? '+' : '' }}{{ formatGoldAmount(readableStatus?.sessionGoldGained || 0) }}
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-fas-ticket-alt text-emerald-400" />
              点券
            </div>
            <div class="text-2xl text-emerald-500 font-bold dark:text-emerald-400">
              {{ statusAmount(readableStatus?.status?.coupon, formatCouponAmount) }}
            </div>
            <div
              v-if="(readableStatus?.sessionCouponGained || 0) !== 0"
              class="dashboard-amount-change"
              :class="(readableStatus?.sessionCouponGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (readableStatus?.sessionCouponGained || 0) > 0 ? '+' : '' }}{{ formatCouponAmount(readableStatus?.sessionCouponGained || 0) }}
            </div>
          </div>
          <div class="text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-carbon-circle text-amber-500" />
              金豆
            </div>
            <div class="text-2xl text-amber-500 font-bold dark:text-amber-400">
              {{ statusAmount(readableStatus?.status?.goldBean, formatGoldBeanAmount) }}
            </div>
            <div
              v-if="(readableStatus?.sessionGoldBeanGained || 0) !== 0"
              class="dashboard-amount-change"
              :class="(readableStatus?.sessionGoldBeanGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (readableStatus?.sessionGoldBeanGained || 0) > 0 ? '+' : '' }}{{ formatGoldBeanAmount(readableStatus?.sessionGoldBeanGained || 0) }}
            </div>
          </div>
        </div>
        <div class="mt-4 border-t border-gray-100/80 pt-3 dark:border-gray-700/80">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="dashboard-status-dot h-2.5 w-2.5 rounded-full" :data-tone="presentation.tone" />
              <span class="text-xs font-bold">{{ presentation.label }}</span>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-gray-400">
              <div class="i-fas-clock text-purple-400" />
              {{ currentStatusReady && Number.isFinite(readableStatus?.uptime) ? formatDuration(localUptime) : '尚未读取' }}
            </div>
          </div>
        </div>
      </div>

      <div class="ui-card metric-card min-h-[168px] flex flex-col justify-between rounded-lg p-5">
        <div class="mb-2 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-flask text-emerald-400" />
          化肥容器
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-flask text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerNormal) }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-vial text-emerald-400" />
              有机
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerOrganic) }}
            </div>
          </div>
        </div>
        <div class="my-3 border-t border-gray-100/80 dark:border-gray-700/80" />
        <div class="mb-1 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-star text-emerald-400" />
          收藏点
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-bookmark text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ readableBag ? collectionNormal?.count ?? 0 : '—' }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-gem text-emerald-400" />
              典藏
            </div>
            <div class="font-bold">
              {{ readableBag ? collectionRare?.count ?? 0 : '—' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="dashboardNotice" class="dashboard-notice ui-notice" role="status">
      <div><strong>{{ dashboardNotice.text }}</strong><span v-if="lastStatusTime">上次确认 {{ lastStatusTime }}{{ currentStatusStale ? ' · 非实时状态' : '' }}</span></div>
      <BaseButton v-if="dashboardNotice.path" variant="outline" size="sm" :to="dashboardNotice.path">{{ dashboardNotice.action }}</BaseButton>
    </div>

    <div class="flex flex-1 flex-col items-stretch gap-5 md:flex-row">
      <div class="flex flex-1 flex-col gap-5 md:w-3/4">
        <div class="ui-card-elevated flex flex-1 flex-col rounded-lg p-5 md:overflow-hidden">
          <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="flex items-center gap-2 text-lg font-medium">
              <div class="i-carbon-document" />
              <span>运行日志</span>
              <span
                v-if="hasActiveLogFilter"
                class="rounded bg-blue-50 px-2 py-0.5 text-xs font-normal text-blue-600 dark:bg-blue-900/30 dark:text-blue-300"
              >筛选中 · {{ allLogs.length }} 条</span>
            </h3>

            <details v-fold-motion class="dashboard-log-filters" :open="hasActiveLogFilter || undefined">
              <summary>筛选日志{{ hasActiveLogFilter ? ' · 已筛选' : '' }}</summary>
              <div class="flex flex-wrap items-center gap-2 text-sm">
              <BaseSelect
                v-model="filter.module"
                :options="modules"
                aria-label="日志模块"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.event"
                :options="events"
                aria-label="日志事件"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.isWarn"
                :options="logLevels"
                aria-label="日志级别"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseInput
                v-model="filter.keyword"
                placeholder="关键词..."
                aria-label="日志关键词"
                class="w-32"
                clearable
                @keyup.enter="onLogSearchTrigger"
                @clear="onLogSearchTrigger"
              />

              <BaseButton
                variant="primary"
                size="sm"
                aria-label="搜索日志"
                @click="onLogSearchTrigger"
              >
                <div class="i-carbon-search" />
              </BaseButton>

              <BaseButton
                variant="secondary"
                size="sm"
                :loading="clearingLogs"
                @click="clearLogs"
              >
                <div class="i-carbon-trash-can mr-1" />
                清空
              </BaseButton>
              </div>
            </details>
          </div>
          <div v-if="!autoScroll && allLogs.length" class="dashboard-reading-note"><span>正在查看历史，新日志不会打断阅读。</span><BaseButton variant="text" @click="resumeLiveLogs">回到最新</BaseButton></div>

          <div ref="logContainer" class="ui-subtle-panel max-h-[50vh] min-h-0 flex-1 overflow-y-auto rounded-lg p-4 text-sm leading-relaxed font-mono" @scroll="onLogScroll">
            <div v-if="!allLogs.length" class="py-8 text-center text-gray-400">
              <div class="i-carbon-document-blank mx-auto mb-3 text-3xl text-gray-300" />
              <div class="text-sm text-gray-500 dark:text-gray-400">
                暂无日志
              </div>
              <div class="mt-1 text-xs text-gray-400">
                {{ LOCAL_UI_READONLY ? '本地只读浏览不读取日志。' : hasActiveLogFilter ? '没有符合当前筛选条件的记录。' : '尚未取得日志；不会据此判定任务未执行。' }}
              </div>
            </div>
            <div v-for="log in allLogs" :key="log.ts + log.msg" class="mb-1 break-all">
              <span class="mr-2 select-none text-gray-400">[{{ formatLogTime(log.time) }}]</span>
              <span class="mr-2 rounded px-1.5 py-0.5 text-xs font-bold" :class="getLogTagClass(log.tag)">{{ log.tag }}</span>
              <span v-if="log.meta?.event" class="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 dark:bg-blue-900/20 dark:text-blue-400">{{ getEventLabel(log.meta.event) }}</span>
              <span :class="getLogMsgClass(log.tag)">{{ log.msg }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-5 md:w-1/4">
        <div class="ui-card flex flex-col rounded-lg p-5">
          <h3 class="mb-4 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-hourglass" />
            <span>下次检查倒计时</span>
          </h3>
          <div class="flex flex-col justify-center gap-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-sprout text-lg text-green-500" />
                <span>农场</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextFarmCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-user-multiple text-lg text-blue-500" />
                <span>帮助</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextHelpCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-run text-lg text-orange-500" />
                <span>偷菜</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextStealCheck }}
              </div>
            </div>
          </div>
        </div>

        <div class="ui-card flex-1 rounded-lg p-5">
          <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-chart-column" />
            <span>今日统计</span>
          </h3>
          <div v-if="currentAccountDisconnected" class="ui-subtle-panel flex flex-col items-center justify-center gap-4 rounded-lg p-10 text-center text-gray-500">
            <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
            <div class="flex flex-col">
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                {{ presentation.label }}
              </div>
              <div class="mt-1 text-sm text-gray-400">
                {{ presentation.detail }}
              </div>
            </div>
          </div>
          <div v-else-if="!currentStatusReady" class="ui-empty-state"><p>统计尚未读取</p><p>{{ LOCAL_UI_READONLY ? '本地浏览不读取账号数据。' : '选择账号并确认状态后显示，不把未读取当成零次操作。' }}</p></div>
          <div v-else-if="!Object.keys(filteredOperations).length" class="ui-subtle-panel flex flex-col items-center justify-center gap-3 rounded-lg p-8 text-center">
            <div class="i-carbon-chart-column text-3xl text-gray-300" />
            <div class="text-sm text-gray-600 font-medium dark:text-gray-300">
              暂无主动作统计
            </div>
            <div class="text-xs text-gray-400">
              通常是刚启动、刚切换账号，或本轮巡查尚未完成。
            </div>
          </div>
          <div v-else class="grid grid-cols-2 gap-2 2xl:gap-3">
            <div
              v-for="(val, key) in filteredOperations"
              :key="key"
              class="ui-subtle-panel flex items-center justify-between rounded-lg px-3 py-2"
            >
              <div class="flex items-center gap-2">
                <div class="text-base 2xl:text-lg" :class="[getOpIcon(key), getOpColor(key)]" />
                <div class="text-xs text-gray-500 2xl:text-sm">
                  {{ getOpName(key) }}
                </div>
              </div>
              <div class="text-sm font-bold 2xl:text-base">
                {{ val }}
              </div>
            </div>
          </div>
          <p v-if="currentStatusReady && badTaskText" class="mt-3 text-xs leading-6 text-[var(--muted-text)]" role="status">{{ badTaskText }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.metric-card { font-variant-numeric: tabular-nums; }
.dashboard-amount-change { font-size: 12px; line-height: 1.6; font-variant-numeric: tabular-nums; }
.dashboard-status-dot { background: var(--muted-text); }
.dashboard-status-dot[data-tone='success'] { background: var(--status-success, #327047); }
.dashboard-status-dot[data-tone='warning'], .dashboard-status-dot[data-tone='error'] { background: var(--status-danger, #b4232c); }
.dashboard-notice { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.dashboard-notice strong { display: block; font-size: 13px; font-weight: 500; }
.dashboard-notice span { display: block; margin-top: 5px; color: var(--muted-text); font-size: 12px; }
.dashboard-log-filters { min-width: 0; max-width: 100%; }
.dashboard-log-filters summary { padding: 8px 10px; color: var(--muted-text); font-size: 13px; cursor: pointer; }
.dashboard-log-filters[open] > div { margin-top: 10px; }
.dashboard-reading-note { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 10px; color: var(--muted-text); font-size: 12px; }
</style>
