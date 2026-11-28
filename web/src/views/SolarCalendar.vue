<script setup lang="ts">
import type { AxiosRequestConfig } from 'axios'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import HeluSolarTermsPanel from '@/components/activity/HeluSolarTermsPanel.vue'
import type { HeluSolarTerm, HeluSolarTerms } from '@/stores/activity'
import { orderSolarTerms } from '@/config/solarTerms'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { useSettingStore } from '@/stores/setting'
import ActivityOverviewPanel from '@/components/activity/ActivityOverviewPanel.vue'
import { solarOverview } from '@/utils/activity-overview'

interface Reward { id: number, count: number, name: string, image: string }
interface ConfigSource { repository?: string, commit?: string, config?: string, kind?: string, url?: string, sha256?: string, bundleVersion?: string, questionOriginVerified?: boolean, answerOriginVerified?: boolean }
interface MetadataSync { status: string, checkedAt: number, officialCurrent: boolean, officialStatus?: string, referenceStatus?: string, missingQuestionIds?: number[], warnings?: string[] }
interface SolarEvent {
  id: number, name: string, description: string, startTime: number, endTime: number, status: number, open: boolean
  directClaimed: boolean, quizClaimed: boolean, quizWrongToday: boolean, wrongOptions: number[]
  question: string, options: string[], answerIndex: number | null, answerSource: ConfigSource | null
  questionSource?: ConfigSource | null, questionRevision?: string | null, questionStatus?: 'available' | 'metadata_missing' | 'no_quiz'
  rewards: Reward[], questionRewards: Reward[], rules: string[], errorTips: string
  canClaim: boolean, canAnswer: boolean, claimResultUnknown?: boolean, answerResultUnknown?: boolean, answerCompletedLocally?: boolean
}
interface Season {
  id: number, name: string, year: string, description: string, eventIds: number[], litCount: number, totalCount: number
  claimed: boolean, canClaim: boolean, rewards: Reward[], resultUnknown?: boolean
}
interface Calendar { accountId: string, serverTime: number, defaultEventId: number, events: SolarEvent[], seasons: Season[], configSources: ConfigSource, metadataSync?: MetadataSync | null }
type Action = 'claim' | 'answer' | 'season'
interface Pending { accountId: string, action: Action, id: number, name: string, optionIndex?: number, expectedQuestion?: string,
  expectedOptions?: string[], expectedStartTime?: number, expectedEndTime?: number, expectedQuestionRevision?: string }
interface Operation { accountId: string, resultState: string, rewards: Reward[], correct?: boolean, calendar: Calendar | null, refreshRequired?: boolean }

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const emit = defineEmits<{ summary: [value: { accountId: string, claimable: number, loading: boolean, current?: { id: number, title: string, statusLabel: string } }] }>()
const { currentAccountId } = storeToRefs(useAccountStore())
const { settingsAccountId, confirmedAutomation } = storeToRefs(useSettingStore())
const automationSnapshot = computed(() => settingsAccountId.value === String(currentAccountId.value) ? confirmedAutomation.value : null)
const { status, currentStatusReady } = storeToRefs(useStatusStore())
const connected = computed(() => currentStatusReady.value && status.value?.connection?.connected === true)
const toast = useToastStore()
const data = ref<Calendar | null>(null)
const busy = ref(false)
const legacyOpen = ref(false)
const legacy = ref<HeluSolarTerms | null>(null)
const legacyLoading = ref(false)
const legacySending = ref(false)
const legacyError = ref('')
const legacyPending = ref<HeluSolarTerm | null>(null)
const legacyUncertain = ref(new Set<string>())
let legacySequence = 0
let legacyController: AbortController | null = null
const legacyLabels = { notesTab: '旧版节令记录', empty: '旧版未下发节令记录' }
const overlappingLegacyIds = computed(() => new Set((data.value?.events || []).map(event => event.id)))
const legacyDisplay = computed(() => legacy.value ? { ...legacy.value, terms: legacy.value.terms.map(term => ({ ...term,
  claimable: term.claimable && !overlappingLegacyIds.value.has(term.id) && !legacyUncertain.value.has(`${currentAccountId.value}:${term.id}`),
})), claimableCount: legacy.value.terms.filter(term => term.claimable && !overlappingLegacyIds.value.has(term.id)).length } : null)
const error = ref('')
const seasonId = ref(0)
const questionId = ref(0)
const answer = ref<number | null>(null)
const showAnswerHint = ref(false)
const pending = ref<Pending | null>(null)
const receivedAt = ref(0)
const tick = ref(Date.now())
const uncertain = ref(new Set<string>())
let sequence = 0
let controller: AbortController | null = null
let refreshedBoundary = 0
let metadataRefreshAt = Date.now() + 10 * 60000
const timer = setInterval(() => {
  tick.value = Date.now()
  // While this page is actually mounted, discover new server events through
  // the existing read. No KeepAlive/background page or quiz submission.
  if (tick.value >= metadataRefreshAt && !busy.value && connected.value) {
    metadataRefreshAt = tick.value + 10 * 60000
    void refresh()
  }
}, 1000)
// 本地经过时间仅压关及提示刷新，不能将服务端未开放的条目推算为已开放。
const now = computed(() => data.value ? data.value.serverTime + Math.max(0, tick.value - receivedAt.value) / 1000 : 0)
const solarTodo = computed(() => solarOverview(data.value?.events || null, data.value?.seasons || [], now.value,
  automationSnapshot.value, new Set([...uncertain.value].filter(value => value.startsWith(`${currentAccountId.value}:`))
    .map(value => value.slice(String(currentAccountId.value).length + 1)))))
const summaryCount = computed(() => solarTodo.value.ready || 0)
watch([summaryCount, busy, currentAccountId, data], () => {
  const current = orderSolarTerms(data.value?.events || [], now.value).find(event => event.startTime > 0 && event.startTime <= now.value)
  emit('summary', { accountId: String(currentAccountId.value), claimable: summaryCount.value, loading: busy.value,
    ...(current ? { current: { id: current.id, title: current.name, statusLabel: phaseText(current) } } : {}) })
})
function navigateTodo(target: string) {
  const [kind, rawId] = target.split(':')
  const id = Number(rawId)
  if (kind === 'season') { seasonId.value = id; return }
  const event = data.value?.events.find(value => value.id === id)
  if (!event) return
  seasonId.value = data.value?.seasons.find(value => value.eventIds.includes(id))?.id || 0
  if (kind === 'question') openQuestion(event)
}
const season = computed(() => data.value?.seasons.find(value => value.id === seasonId.value))
const events = computed(() => orderSolarTerms((data.value?.events || []).filter(value => !season.value || season.value.eventIds.includes(value.id)), now.value))
const featuredEvent = computed(() => events.value.find(event => event.startTime > 0 && event.startTime <= now.value) || events.value[0])
const seasonEntries = computed(() => [...(data.value?.seasons || [])].sort((a, b) => b.id - a.id))
const completedEventCount = computed(() => events.value.filter(event => event.directClaimed && (!event.question || event.quizClaimed)).length)
const question = computed(() => data.value?.events.find(value => value.id === questionId.value))
const nextBoundary = computed(() => {
  if (!data.value) return Infinity
  const times = data.value.events.flatMap(value => [value.startTime, value.endTime + 1])
  if (data.value.events.some(value => value.quizWrongToday))
    times.push((Math.floor((data.value.serverTime + 28800) / 86400) + 1) * 86400 - 28800)
  return Math.min(...times.filter(value => value > data.value!.serverTime))
})
const confirmMessage = computed(() => {
  const value = pending.value
  if (!value) return ''
  const option = value.action === 'answer' ? question.value?.options[value.optionIndex ?? -1] : ''
  return `${value.name}${option ? `\n答案：${option}\n每题只有一次机会，题库参考未独立核验，请确认你自己的选择。` : ''}\n提交前将重新读取并核验当前账号进度。只发送一次；结果不确定时只能刷新，不能重提。`
})
function key(action: Action, id: number) { return `${currentAccountId.value}:${action}:${id}` }
function available(event: SolarEvent, quiz = false) {
  return connected.value && !busy.value && !legacySending.value && !uncertain.value.has(key(quiz ? 'answer' : 'claim', event.id))
    && (quiz ? event.canAnswer : event.canClaim) && now.value >= event.startTime && now.value <= event.endTime
}
function seasonAvailable(value: Season) {
  return connected.value && !busy.value && !legacySending.value && value.canClaim && !uncertain.value.has(key('season', value.id))
}
function phaseText(event: SolarEvent) {
  if (!event.startTime || !event.endTime) return '服务端窗口未确认'
  if (event.directClaimed && (!event.question || event.quizClaimed)) return '已完成'
  if (event.status === 3 || now.value > event.endTime) return '已结束'
  if (now.value < event.startTime) return '尚未开始'
  return event.open ? '进行中' : '服务端尚未开放'
}
function claimText(event: SolarEvent, quiz = false) {
  if ((quiz ? event.answerResultUnknown : event.claimResultUnknown) || uncertain.value.has(key(quiz ? 'answer' : 'claim', event.id))) return '仅刷新确认'
  if (quiz ? event.quizClaimed : event.directClaimed) return '已领取'
  if (quiz && event.quizWrongToday) return '已答错，不再提交'
  if (quiz && event.answerCompletedLocally) return '本题已提交'
  return quiz ? '查看题目' : '领取'
}
function eventStamp(event: SolarEvent) {
  if (!event.startTime) return { month: '—', day: '—' }
  const date = new Date(event.startTime * 1000)
  const parts = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).formatToParts(date)
  return { month: `${parts.find(part => part.type === 'month')?.value || '—'}月`, day: parts.find(part => part.type === 'day')?.value || '—' }
}
function seasonProgress(value: Season) {
  return value.totalCount > 0 ? Math.max(0, Math.min(100, value.litCount / value.totalCount * 100)) : 0
}
function featuredLabel(event: SolarEvent) {
  return event.startTime > now.value ? '即将到来' : event.open && now.value <= event.endTime ? '当前节令' : '最新节令'
}
function period(event: SolarEvent) {
  if (!event.startTime || !event.endTime) return '未下发有效时间窗口'
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
  return `${formatter.format(event.startTime * 1000)} — ${formatter.format(event.endTime * 1000)}`
}
function openQuestion(event: SolarEvent) {
  questionId.value = event.id
  answer.value = null
  showAnswerHint.value = false
}
function prepare(action: Action, id: number, name: string) {
  if (busy.value || legacySending.value || !connected.value || !currentAccountId.value) return
  pending.value = { accountId: currentAccountId.value, action, id, name,
    ...(action === 'answer' ? { optionIndex: answer.value ?? undefined, expectedQuestion: question.value?.question,
      expectedOptions: question.value ? [...question.value.options] : undefined,
      expectedStartTime: question.value?.startTime, expectedEndTime: question.value?.endTime,
      expectedQuestionRevision: question.value?.questionRevision || undefined } : {}) }
}
function messageOf(cause: unknown, fallback: string) {
  const value = cause as { response?: { data?: { error?: string, message?: string } }, message?: string }
  return value?.response?.data?.error || value?.response?.data?.message || value?.message || fallback
}
function applyCalendar(value: Calendar, accountId: string) {
  if (!value || String(value.accountId) !== accountId || !Number.isSafeInteger(value.serverTime) || value.serverTime <= 0
    || !Array.isArray(value.events) || !Array.isArray(value.seasons)) throw new Error('节令回包不完整或账号不匹配')
  const previous = data.value?.events.find(event => event.id === questionId.value)
  const latest = value.events.find(event => event.id === questionId.value)
  if (questionId.value && (!latest || latest.questionRevision !== previous?.questionRevision
    || latest.question !== previous?.question || JSON.stringify(latest.options) !== JSON.stringify(previous?.options))) {
    answer.value = null
    pending.value = null
    showAnswerHint.value = false
  }
  data.value = value
  receivedAt.value = Date.now()
  tick.value = receivedAt.value
  if (!value.seasons.some(entry => entry.id === seasonId.value)) {
    const target = orderSolarTerms(value.events, value.serverTime).find(entry => entry.startTime > 0 && entry.startTime <= value.serverTime)?.id || value.defaultEventId
    seasonId.value = value.seasons.find(entry => entry.eventIds.includes(target))?.id || [...value.seasons].sort((a, b) => b.id - a.id)[0]?.id || 0
  }
}
async function refresh() {
  if (!currentAccountId.value || !connected.value || busy.value) return
  const accountId = currentAccountId.value
  const revision = ++sequence
  controller = new AbortController()
  busy.value = true
  error.value = ''
  try {
    const options = { headers: { 'x-account-id': accountId }, signal: controller.signal, timeout: 70000, skipErrorToast: true } as AxiosRequestConfig
    const response = await api.get('/api/solar-calendar', options)
    if (revision !== sequence || accountId !== currentAccountId.value) return
    if (response.data?.ok !== true) throw new Error(response.data?.error || '读取节令日历失败')
    applyCalendar(response.data.data, accountId)
  }
  catch (cause) {
    if (revision === sequence) { error.value = messageOf(cause, '读取节令日历失败'); data.value = null }
  }
  finally { if (revision === sequence) { busy.value = false; controller = null } }
}
async function submit() {
  const operation = pending.value
  if (!operation || busy.value || legacySending.value || !connected.value || operation.accountId !== currentAccountId.value) return
  pending.value = null
  const accountId = operation.accountId
  const revision = ++sequence
  controller = new AbortController()
  busy.value = true
  error.value = ''
  const operationKey = `${accountId}:${operation.action}:${operation.id}`
  try {
    const options = { headers: { 'x-account-id': accountId }, signal: controller.signal, timeout: 140000, skipErrorToast: true } as AxiosRequestConfig
    const response = await api.post(`/api/solar-calendar/${operation.action}`, {
      id: operation.id, confirmed: true, ...(operation.action === 'answer' ? { optionIndex: operation.optionIndex, expectedQuestion: operation.expectedQuestion,
        expectedOptions: operation.expectedOptions, expectedStartTime: operation.expectedStartTime,
        expectedEndTime: operation.expectedEndTime, expectedQuestionRevision: operation.expectedQuestionRevision } : {}),
    }, options)
    if (revision !== sequence || accountId !== currentAccountId.value) return
    if (response.data?.ok !== true) throw new Error(response.data?.error || '操作未确认')
    const result = response.data.data as Operation
    if (!result || result.resultState !== 'completed' || String(result.accountId) !== accountId) throw new Error('操作回包未确认')
    questionId.value = 0
    answer.value = null
    const rewardText = result.rewards?.map(value => `${value.name} ×${value.count}`).join('、')
    const text = operation.action === 'answer' && result.correct !== true ? '答案错误，本题不再提交' : rewardText || '服务端已确认本次操作'
    if (result.refreshRequired || !result.calendar) {
      data.value = null
      error.value = '操作已确认，但最新进度未读取成功，请刷新，不要重复提交'
      toast.warning(`${text}。请刷新确认进度`)
    }
    else { applyCalendar(result.calendar, accountId); toast.success(text) }
  }
  catch (cause) {
    // 无确认的写入不提供“重试”按钮；即使切回旧账号，也不重发旧操作。
    const details = (cause as { response?: { data?: { sent?: boolean, resultState?: string, data?: { sent?: boolean, resultState?: string } } } })?.response?.data
    if (details?.sent !== false && details?.resultState !== 'not_sent'
      && details?.data?.sent !== false && details?.data?.resultState !== 'not_sent') uncertain.value.add(operationKey)
    if (revision === sequence) {
      data.value = null
      questionId.value = 0
      error.value = `${messageOf(cause, '操作未确认')}。请只刷新确认进度，勿重复提交`
      toast.warning(error.value)
    }
  }
  finally { if (revision === sequence) { busy.value = false; controller = null } }
}
async function refreshLegacy() {
  if (!legacyOpen.value || !connected.value || !currentAccountId.value || legacyLoading.value || legacySending.value) return
  const accountId = String(currentAccountId.value)
  const revision = ++legacySequence
  legacyController?.abort()
  legacyController = new AbortController()
  legacyLoading.value = true
  legacyError.value = ''
  try {
    const response = await api.get('/api/solar-terms', { headers: { 'x-account-id': accountId }, signal: legacyController.signal, timeout: 70000 })
    if (revision !== legacySequence || accountId !== String(currentAccountId.value)) return
    if (response.data?.ok !== true || !Array.isArray(response.data.data?.terms)) throw new Error('旧版节令回包不完整')
    legacy.value = response.data.data
  }
  catch (cause) { if (revision === legacySequence) { legacy.value = null; legacyError.value = messageOf(cause, '读取旧版节令失败') } }
  finally { if (revision === legacySequence) { legacyLoading.value = false; legacyController = null } }
}
function toggleLegacy(event: Event) {
  legacyOpen.value = (event.target as HTMLDetailsElement).open
  if (legacyOpen.value && !legacy.value) void refreshLegacy()
}
function prepareLegacy(term: HeluSolarTerm) {
  if (!connected.value || busy.value || legacyLoading.value || legacySending.value || !term.claimable
    || overlappingLegacyIds.value.has(term.id) || legacyUncertain.value.has(`${currentAccountId.value}:${term.id}`)) return
  legacyPending.value = { ...term }
}
async function claimLegacy() {
  const term = legacyPending.value
  if (!term || busy.value || legacySending.value || !connected.value || overlappingLegacyIds.value.has(term.id)) return
  const accountId = String(currentAccountId.value)
  const revision = ++legacySequence
  legacyPending.value = null
  legacySending.value = true
  const operationKey = `${accountId}:${term.id}`
  try {
    const response = await api.post('/api/solar-terms/claim', { termId: term.id, confirmed: true }, { headers: { 'x-account-id': accountId }, timeout: 70000 })
    if (revision !== legacySequence || accountId !== String(currentAccountId.value)) return
    const result = response.data?.data
    if (response.data?.ok !== true || result?.ok !== true || !Array.isArray(result.solarTerms?.terms)) throw new Error(response.data?.error || '旧版领奖结果未确认')
    legacy.value = result.solarTerms
    const state = legacy.value!.terms.find(value => value.id === term.id)
    if (state?.status !== 3 && state?.status !== 5) throw new Error('旧版领奖进度未确认')
    toast.success('旧版节令奖励已确认领取')
  }
  catch (cause) {
    const details = (cause as any)?.response?.data
    if (details?.sent !== false && details?.resultState !== 'not_sent') legacyUncertain.value.add(operationKey)
    if (revision === legacySequence) legacyError.value = `${messageOf(cause, '旧版领奖未确认')}。只刷新确认，不重复提交`
  }
  finally { if (revision === legacySequence) legacySending.value = false }
}
defineExpose({ refresh })
watch([now, busy], () => {
  const boundary = nextBoundary.value
  if (connected.value && !busy.value && now.value >= boundary && refreshedBoundary !== boundary) {
    refreshedBoundary = boundary
    void refresh()
  }
})
watch([currentAccountId, connected], () => {
  sequence++
  controller?.abort()
  controller = null
  data.value = null
  busy.value = false
  pending.value = null
  questionId.value = 0
  seasonId.value = 0
  answer.value = null
  error.value = ''
  refreshedBoundary = 0
  legacySequence++
  legacyController?.abort()
  legacyController = null
  legacy.value = null
  legacyLoading.value = false
  legacySending.value = false
  legacyPending.value = null
  legacyError.value = ''
  void refresh()
  if (legacyOpen.value) void refreshLegacy()
}, { immediate: true, flush: 'sync' })
onUnmounted(() => { sequence++; legacySequence++; controller?.abort(); legacyController?.abort(); clearInterval(timer) })
</script>

<template>
  <div class="solar space-y-4">
    <header v-if="!props.embedded" class="solar-page-heading">
      <div>
        <p class="solar-eyebrow">四时有序 · 耕耘有礼</p>
        <h1 class="m-0 text-2xl font-bold">节令小礼</h1>
      </div>
      <BaseButton variant="secondary" :loading="busy" :disabled="!currentAccountId || !connected" @click="refresh">刷新</BaseButton>
    </header>
    <ActivityOverviewPanel v-if="data" :overview="solarTodo" :loading="busy || legacySending" @navigate="navigateTodo" />
    <div class="solar-notice">
      <span class="i-carbon-notification solar-notice-icon" aria-hidden="true" />
      <p>基础小礼沿用自动领取设置；答题提醒通过 <strong>PushPlus 微信订阅</strong>（同农场日报）。答题与基础奖独立，自动答题开关单独控制。</p>
    </div>
    <div v-if="!currentAccountId || !connected" class="solar-card solar-empty">
      <span class="i-carbon-connect" aria-hidden="true" />
      <p>{{ !currentAccountId ? '请先选择账号' : '当前游戏连接未就绪，请先确认账号在线' }}</p>
    </div>
    <div v-else-if="error || !data" class="solar-card solar-empty" role="status">
      <span :class="busy ? 'i-carbon-circle-dash' : 'i-carbon-calendar'" aria-hidden="true" />
      <p>{{ error || (busy ? '正在读取节令日历…' : '暂无服务端节令数据') }}</p>
    </div>
    <template v-if="data">
      <div class="solar-browse">
        <div>
          <p class="solar-eyebrow">节令时序</p>
          <p class="solar-browse-caption">当前 / 最新置顶 <span>·</span> 历史由近及远</p>
        </div>
        <nav class="solar-quarter-tabs" aria-label="节令季度">
          <BaseButton :variant="seasonId === 0 ? 'primary' : 'secondary'" size="sm" :disabled="busy" @click="seasonId = 0">全部节令</BaseButton>
          <BaseButton v-for="entry in seasonEntries" :key="entry.id" :variant="seasonId === entry.id ? 'primary' : 'secondary'" size="sm" :disabled="busy" @click="seasonId = entry.id">
            {{ entry.name }} <span class="solar-tab-count">{{ entry.litCount }}/{{ entry.totalCount }}</span>
          </BaseButton>
        </nav>
      </div>
      <section v-if="season" class="solar-card solar-season" aria-label="季度集册">
        <div class="solar-season-icon"><span class="i-carbon-notebook" aria-hidden="true" /></div>
        <div class="solar-season-body">
          <div class="solar-season-title">
            <h2>{{ season.year }} {{ season.name }}集册</h2>
            <span>{{ season.litCount }} / {{ season.totalCount }} 已点亮</span>
          </div>
          <div class="solar-progress" role="progressbar" :aria-valuenow="season.litCount" :aria-valuemax="season.totalCount" :aria-valuemin="0" aria-label="季度点亮进度">
            <span :style="{ width: `${seasonProgress(season)}%` }" />
          </div>
          <p>集齐奖励：{{ season.rewards.map(value => `${value.name} ×${value.count}`).join('、') || '服务端未下发奖励' }}</p>
        </div>
        <BaseButton size="sm" variant="secondary" :disabled="!seasonAvailable(season)" @click="prepare('season', season.id, season.name)">
          {{ season.resultUnknown || uncertain.has(key('season', season.id)) ? '仅刷新确认' : season.claimed ? '已领取' : season.canClaim ? '领取季度奖励' : '当前不可领取' }}
        </BaseButton>
      </section>
      <div class="solar-list-heading">
        <span>{{ season ? season.name : '全部节令' }} <span class="solar-list-count">{{ events.length }}</span></span>
        <span>{{ completedEventCount }} 个已完成 · 北京时间</span>
      </div>
      <p v-if="!events.length" class="solar-card solar-muted">服务端未下发当前季度节令，不使用本地配置补造开放状态。</p>
      <ol class="solar-events">
        <li v-for="event in events" :key="event.id" :data-event-id="event.id" class="solar-card solar-event" :class="{ 'solar-event--featured': event.id === featuredEvent?.id, 'solar-event--open': event.open }">
          <div class="solar-event-top">
            <div class="solar-date" aria-hidden="true">
              <span>{{ eventStamp(event).month }}</span><strong>{{ eventStamp(event).day }}</strong>
            </div>
            <div class="solar-event-identity">
              <p v-if="event.id === featuredEvent?.id" class="solar-eyebrow">{{ featuredLabel(event) }} <span class="solar-live-dot" v-if="event.open" /></p>
              <h2>{{ event.name }}</h2>
              <p class="solar-period">{{ period(event) }} <span>（北京时间）</span></p>
            </div>
            <span class="solar-phase" :class="{ 'solar-phase--active': event.open }">{{ phaseText(event) }}</span>
          </div>
          <p class="solar-description">{{ event.description }}</p>
          <div class="solar-reward-lanes">
            <div class="solar-reward-lane">
              <div class="solar-lane-title">
                <span class="i-carbon-gift" aria-hidden="true" /><strong>基础小礼</strong>
                <span class="solar-lane-state">{{ event.directClaimed ? '已领取' : event.canClaim ? '可直接领取' : '当前不可领' }}</span>
              </div>
              <div class="solar-lane-bottom">
                <div class="solar-rewards">
                  <span v-for="item in event.rewards" :key="item.id" class="solar-reward">
                    <img v-if="item.image" :src="item.image" :alt="item.name" loading="lazy">
                    <span v-else class="solar-reward-placeholder i-carbon-gift" aria-hidden="true" />
                    <span>{{ item.name }} <strong>×{{ item.count }}</strong></span>
                  </span>
                  <span v-if="!event.rewards.length" class="solar-muted">服务端未下发基础奖励</span>
                </div>
                <BaseButton size="sm" :variant="available(event) ? 'primary' : 'secondary'" :disabled="!available(event)" @click="prepare('claim', event.id, event.name)">{{ claimText(event) }}</BaseButton>
              </div>
            </div>
            <div v-if="event.question || event.questionRewards.length" class="solar-reward-lane solar-reward-lane--quiz">
              <div class="solar-lane-title">
                <span class="i-carbon-help" aria-hidden="true" /><strong>答题加赠</strong>
                <span class="solar-lane-state">{{ event.quizClaimed ? '已领取' : '仅一次机会' }}</span>
              </div>
              <div class="solar-lane-bottom">
                <div class="solar-rewards">
                  <span v-for="item in event.questionRewards" :key="item.id" class="solar-reward">
                    <img v-if="item.image" :src="item.image" :alt="item.name" loading="lazy">
                    <span v-else class="solar-reward-placeholder i-carbon-gift" aria-hidden="true" />
                    <span>{{ item.name }} <strong>×{{ item.count }}</strong></span>
                  </span>
                  <span v-if="!event.questionRewards.length" class="solar-muted">服务端未下发答题奖励</span>
                </div>
                <BaseButton size="sm" variant="secondary" :disabled="busy || !connected" @click="openQuestion(event)">{{ claimText(event, true) }}</BaseButton>
              </div>
            </div>
          </div>
          <p v-if="event.quizWrongToday && event.errorTips" class="solar-wrong-tip">{{ event.errorTips }}</p>
          <section v-if="question?.id === event.id" class="solar-question" aria-label="节令问答">
            <div class="solar-question-heading">
              <h3>{{ question.name }} · 节令问答</h3>
              <BaseButton size="sm" variant="ghost" :disabled="busy" @click="questionId = 0">关闭</BaseButton>
            </div>
            <p class="solar-question-warning"><span class="i-carbon-warning-alt" aria-hidden="true" />每题只有一次机会；答错不影响已领取的基础小礼。</p>
            <p class="solar-question-text">{{ question.question || '服务端已下发答题奖励，但最新题干与选项尚未取得。系统会自动检查配置更新，不使用旧题猜测。' }}</p>
            <p v-if="question.questionSource" class="solar-footnote">{{ question.questionSource.questionOriginVerified ? '题干与选项来自官方资源快照' : '题干与选项为上游参考，未独立核验' }}；不会自动提交答案。</p>
            <fieldset class="solar-options" :disabled="!available(question, true)">
              <legend class="sr-only">请选择答案</legend>
              <label v-for="(option, index) in question.options" :key="index" class="solar-option" :class="{ 'solar-option--selected': answer === index }">
                <input v-model="answer" type="radio" name="solar-answer" :value="index" :disabled="question.wrongOptions.includes(index)">
                <span>{{ option }}</span>
                <span v-if="question.wrongOptions.includes(index)" class="text-xs text-red-500">已答错</span>
              </label>
            </fieldset>
            <label v-if="question.answerIndex !== null && question.answerSource" class="solar-answer-hint">
              <input v-model="showAnswerHint" type="checkbox">显示上游题库参考（不自动提交）
            </label>
            <p v-if="showAnswerHint && question.answerIndex !== null && question.answerSource" class="solar-answer-source">
              上游题库参考：{{ question.options[question.answerIndex] }}（{{ question.answerSource.answerOriginVerified ? '已独立核验' : '未与当前官方题库独立核验' }}）<br>
              来源：{{ question.answerSource.url || `${question.answerSource.repository} / ${question.answerSource.config}` }}<br>
              版本：{{ question.answerSource.bundleVersion || question.answerSource.commit || question.answerSource.sha256 || '本地参考' }}
            </p>
            <BaseButton class="mt-4" :disabled="answer === null || !available(question, true)" @click="prepare('answer', question.id, question.name)">确认提交答案</BaseButton>
          </section>
          <details v-if="event.rules.length" class="solar-rules">
            <summary>活动说明</summary>
            <p class="solar-muted">官方配置说明不作为当前开放判据。</p>
            <p v-for="(rule, index) in event.rules" :key="index" class="whitespace-pre-line">{{ rule }}</p>
          </details>
        </li>
      </ol>
      <p class="solar-footnote">节令与窗口随服务端更新；题干和选项自动同步静态配置，缺失时明确显示未取得。{{ data.metadataSync?.officialCurrent ? '本轮已读取官方版本入口指向的配置快照。' : '官方版本入口尚未覆盖当前题库时，保留并标明历史快照或上游参考。' }} 页面不自动选答，结果未知只刷新、不重提。</p>
    </template>
    <details class="solar-card solar-legacy" @toggle="toggleLegacy">
      <summary><span class="i-carbon-archive" aria-hidden="true" />旧版节令记录与兼容领奖<span class="solar-legacy-tag">按需查看</span></summary>
      <template v-if="legacyOpen">
        <p class="solar-footnote">仅展开时读取旧版记录，不加载已下线的荷风活动树。同编号已在新日历展示时，旧版入口仅查看，不重复领奖；现有自动领奖仍按原设置运行。</p>
        <p v-if="legacyError" class="text-xs text-red-600 dark:text-red-300" role="status">{{ legacyError }}</p>
        <BaseButton class="mb-3" size="sm" variant="secondary" :loading="legacyLoading" :disabled="!connected || legacySending" @click="refreshLegacy">刷新旧版记录</BaseButton>
        <HeluSolarTermsPanel :solar-terms="legacyDisplay" :loading="legacySending" :labels="legacyLabels" @claim="prepareLegacy" />
      </template>
    </details>
    <ConfirmModal :show="!!legacyPending" title="确认旧版节令领奖" message="只对未在新日历重复展示的旧版节令发送一次；结果未确认时只刷新，不重提。" :loading="legacySending" confirm-text="只提交一次" @confirm="claimLegacy" @cancel="legacyPending = null" />
    <ConfirmModal :show="!!pending" :title="pending?.action === 'answer' ? '确认手动答题' : '确认手动领奖'" :message="confirmMessage" :loading="busy" confirm-text="只提交一次" @confirm="submit" @cancel="pending = null" @close="pending = null" />
  </div>
</template>

<style scoped>
.solar { min-width: 0; color: var(--theme-text, #2c2a22); --solar-muted: var(--muted-text, #625b4d); --solar-accent: var(--theme-primary, #5e8c5a); --solar-accent-text: var(--theme-text, #2c2a22); }
.solar-card { margin: 0; min-width: 0; padding: 22px; border: 1px solid var(--surface-border, #ece5d6); border-radius: var(--radius-card, 12px); background: var(--surface-1, #fcfbf6); box-shadow: var(--surface-shadow-soft); }
.solar-page-heading, .solar-browse, .solar-list-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.solar-eyebrow { margin: 0 0 6px; font-size: 11px; font-weight: 650; letter-spacing: .14em; color: var(--solar-accent-text); }
.solar-notice { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: color-mix(in srgb, var(--solar-accent) 7%, var(--surface-1, #fcfbf6)); color: var(--solar-muted); font-size: 12px; line-height: 1.8; }
.solar-notice p { margin: 0; }.solar-notice strong { font-weight: 600; color: var(--theme-text, #2c2a22); }.solar-notice-icon { flex-shrink: 0; font-size: 16px; color: var(--solar-accent); }
.solar-browse { flex-wrap: wrap; padding: 5px 1px 0; }.solar-browse-caption { margin: 0; color: var(--solar-muted); font-size: 12px; }.solar-browse-caption span { padding: 0 5px; }
.solar-quarter-tabs { display: flex; flex-wrap: wrap; gap: 7px; }.solar-tab-count { display: inline-block; min-width: 26px; margin-left: 6px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.solar-season { display: flex; align-items: center; gap: 16px; padding: 18px 20px; box-shadow: none; background: color-mix(in srgb, var(--surface-2, #f7f2e7) 65%, var(--surface-1, #fcfbf6)); }
.solar-season-icon { display: grid; width: 40px; height: 44px; place-items: center; border: 1px solid var(--surface-border, #ece5d6); border-radius: 10px; background: var(--surface-1, #fcfbf6); color: var(--solar-accent); font-size: 22px; flex-shrink: 0; }
.solar-season-body { flex: 1; min-width: 0; }.solar-season-title { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; justify-content: space-between; }.solar-season h2 { margin: 0; font-size: 14px; font-weight: 650; }.solar-season-title > span { font-size: 11px; color: var(--solar-muted); font-variant-numeric: tabular-nums; }.solar-season p { margin: 8px 0 0; color: var(--solar-muted); font-size: 11px; line-height: 1.6; }
.solar-progress { overflow: hidden; height: 4px; margin-top: 10px; border-radius: 6px; background: color-mix(in srgb, var(--solar-accent) 12%, var(--surface-2, #f7f2e7)); }.solar-progress > span { display: block; height: 100%; border-radius: inherit; background: var(--solar-accent); }
.solar-list-heading { padding: 2px 2px 0; color: var(--solar-muted); font-size: 11px; }.solar-list-heading > span:first-child { font-size: 12px; font-weight: 600; color: var(--theme-text, #2c2a22); }.solar-list-count { margin-left: 6px; padding: 2px 6px; border-radius: 5px; background: var(--surface-3, #f0ecdd); font-variant-numeric: tabular-nums; }
.solar-events { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin: 0; padding: 0; list-style: none; }
.solar-event { position: relative; display: flex; flex-direction: column; }.solar-event--featured { grid-column: 1 / -1; border-color: color-mix(in srgb, var(--solar-accent) 38%, var(--surface-border, #ece5d6)); background: linear-gradient(118deg, color-mix(in srgb, var(--solar-accent) 5%, var(--surface-1, #fcfbf6)), var(--surface-1, #fcfbf6)); box-shadow: var(--surface-shadow-soft, 0 8px 24px rgba(70, 58, 34, .07)); }.solar-event--featured::before { content: ''; position: absolute; top: 24px; bottom: 24px; left: -1px; width: 3px; border-radius: 3px; background: var(--solar-accent); }
.solar-event-top { display: flex; align-items: flex-start; gap: 14px; }.solar-date { display: flex; flex-shrink: 0; flex-direction: column; align-items: center; justify-content: center; width: 47px; min-height: 56px; border: 1px solid var(--surface-border, #ece5d6); border-radius: 10px; background: var(--surface-2, #f7f2e7); }.solar-date span { margin-top: 3px; color: var(--solar-muted); font-size: 10px; letter-spacing: .05em; }.solar-date strong { font-size: 23px; font-weight: 550; line-height: 1.5; font-variant-numeric: tabular-nums; color: var(--solar-accent-text); }
.solar-event-identity { min-width: 0; flex: 1; }.solar-event h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: .06em; }.solar-event--featured h2 { font-size: 27px; letter-spacing: .14em; font-family: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'SimSun', serif; }.solar-live-dot { display: inline-block; width: 5px; height: 5px; margin-left: 5px; border-radius: 50%; background: var(--solar-accent); vertical-align: 2px; }
.solar-period { margin: 5px 0 0; color: var(--solar-accent-text); font-size: 12px; font-weight: 500; line-height: 1.7; font-variant-numeric: tabular-nums; }.solar-period span { color: var(--solar-muted); font-weight: 400; white-space: nowrap; }
.solar-phase { flex-shrink: 0; padding: 5px 9px; border: 1px solid var(--surface-border, #ece5d6); border-radius: 20px; color: var(--solar-muted); background: var(--surface-2, #f7f2e7); font-size: 10px; font-weight: 500; white-space: nowrap; }.solar-phase--active { color: var(--solar-accent-text); border-color: color-mix(in srgb, var(--solar-accent) 22%, transparent); background: color-mix(in srgb, var(--solar-accent) 9%, var(--surface-1, #fcfbf6)); }
.solar-description { white-space: pre-line; margin: 15px 0 18px; color: var(--solar-muted); font-size: 13px; line-height: 1.85; }.solar-event--featured .solar-description { margin-left: 61px; font-size: 13px; letter-spacing: .025em; }
.solar-reward-lanes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; margin-top: auto; }.solar-reward-lane { min-width: 0; padding: 13px 14px; border-radius: 12px; border: 1px solid var(--surface-border, #ece5d6); background: var(--surface-1, #fcfbf6); }.solar-reward-lane--quiz { background: color-mix(in srgb, var(--surface-2, #f7f2e7) 52%, var(--surface-1, #fcfbf6)); }.solar-lane-title { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; font-size: 12px; }.solar-lane-title > span:first-child { color: var(--solar-accent); font-size: 14px; }.solar-lane-title strong { font-weight: 600; }.solar-lane-state { margin-left: auto; color: var(--solar-muted); font-size: 10px; }
.solar-lane-bottom { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }.solar-rewards { display: flex; min-width: 0; flex-wrap: wrap; gap: 9px 12px; }.solar-reward { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1.6; }.solar-reward img { width: 27px; height: 27px; flex-shrink: 0; object-fit: contain; }.solar-reward strong { font-weight: 600; font-variant-numeric: tabular-nums; }.solar-reward-placeholder { flex-shrink: 0; width: 22px; height: 22px; color: var(--solar-muted); opacity: .65; }
.solar-rules { margin-top: 14px; color: var(--solar-muted); font-size: 11px; line-height: 1.75; }.solar-rules summary { cursor: pointer; }.solar-rules p { margin: 10px 0 0; }.solar-wrong-tip { color: var(--solar-muted); font-size: 12px; line-height: 1.7; }
.solar-question { margin-top: 18px; padding: 18px; border: 1px solid color-mix(in srgb, var(--solar-accent) 28%, var(--surface-border, #ece5d6)); border-radius: 14px; background: var(--surface-1, #fcfbf6); }.solar-question-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.solar-question h3 { margin: 0; font-size: 14px; font-weight: 600; }.solar-question-warning { display: flex; gap: 6px; align-items: flex-start; color: var(--solar-muted); font-size: 11px; line-height: 1.8; }.solar-question-warning > span { margin-top: 3px; flex-shrink: 0; }.solar-question-text { font-size: 14px; font-weight: 600; line-height: 1.8; }
.solar-options { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin: 0; border: 0; padding: 0; }.solar-option { display: flex; align-items: center; gap: 10px; border: 1px solid var(--surface-border, #ece5d6); border-radius: 10px; padding: 12px 14px; background: var(--surface-2, #f7f2e7); font-size: 13px; cursor: pointer; }.solar-option input { accent-color: var(--solar-accent); }.solar-option--selected { border-color: var(--solar-accent); background: color-mix(in srgb, var(--solar-accent) 7%, var(--surface-1, #fcfbf6)); }.solar-option:has(input:focus-visible) { outline: 2px solid var(--solar-accent); outline-offset: 2px; }.solar-options:disabled .solar-option { cursor: default; opacity: .75; }
.solar-answer-hint { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 11px; color: var(--solar-muted); }.solar-answer-source { overflow-wrap: anywhere; font-size: 11px; color: var(--solar-muted); line-height: 1.8; }.solar-footnote { margin: 0; font-size: 11px; line-height: 1.8; color: var(--solar-muted); }
.solar-legacy { padding: 16px 20px; box-shadow: none; font-size: 12px; }.solar-legacy summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; cursor: pointer; color: var(--solar-muted); }.solar-legacy summary > span:first-child { color: var(--solar-accent); font-size: 16px; }.solar-legacy-tag { margin-left: auto; font-size: 10px; }.solar-legacy .solar-footnote { margin: 14px 0; }.solar-empty { display: grid; gap: 10px; place-items: center; padding: 40px 20px; color: var(--solar-muted); font-size: 13px; }.solar-empty > span { font-size: 28px; }.solar-empty p { margin: 0; }.solar-muted { color: var(--solar-muted); }
@media (min-width: 780px) { .solar-events { grid-template-columns: repeat(2, minmax(0, 1fr)); }.solar-event--featured .solar-reward-lanes { grid-template-columns: repeat(2, minmax(0, 1fr)); }.solar-event--featured .solar-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .solar-card { padding: 16px; border-radius: var(--radius-card, 12px); }.solar-season { gap: 10px; flex-wrap: wrap; }.solar-season-body { min-width: calc(100% - 54px); }.solar-season > button { margin-left: 50px; }.solar-event-top { gap: 10px; flex-wrap: wrap; }.solar-event--featured h2 { font-size: 24px; }.solar-event--featured .solar-description { margin-left: 0; }.solar-date { width: 42px; min-height: 52px; }.solar-period { font-size: 12px; }.solar-phase { margin-left: auto; }.solar-lane-bottom { align-items: flex-start; }.solar-lane-bottom > button { margin-left: auto; }.solar-question { padding: 14px; }.solar-list-heading { gap: 10px; }.solar-list-heading > span:last-child { font-size: 10px; } }
</style>
