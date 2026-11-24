import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { copySettings, settingsPatchMatches } from '@/composables/settings/useSettingsDraft'
import { operationFailure, resultIsUnknown } from '@/utils/operation-result'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

type UserConfigKind = 'device' | 'offline' | 'default-plan'
type UserWriteKey = UserConfigKind | 'password' | 'notification'
interface UserConfigResult {
  ok: boolean
  error?: string
  config?: any
  data?: any
  outcomeUnknown?: boolean
  sent?: boolean
  resultState?: string
}

export interface AutomationConfig {
  farm?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  task?: boolean
  ranch?: boolean
  ranch_harvest?: boolean
  ranch_produce?: boolean
  ranch_clean?: boolean
  ranch_sell?: boolean
  ranch_grass?: boolean
  ranch_grass_buy?: boolean
  ranch_feed_normal?: boolean
  ranch_feed_organic?: boolean
  ranch_complete_upgrade?: boolean
  ranch_place?: boolean
  ranch_friend_steal?: boolean
  ranch_friend_clean?: boolean
  ranch_friend_stroke?: boolean
  ranch_friend_mosquito?: boolean
  ranch_check_minutes?: number
  star_passport_claim?: boolean
  star_record_claim?: boolean
  solar_terms_claim?: boolean
  solar_terms_quiz_notify?: boolean
  solar_terms_auto_answer?: boolean
  qingmei_seed_claim?: boolean
  qingmei_wine_brew?: boolean
  qixi_dew_use?: boolean
  qixi_bridge_build?: boolean
  qixi_sachet_gift?: boolean
  qixi_friend_priority?: number[]
  rain_poem_bottle_buy?: boolean
  rain_poem_weather_collect?: boolean
  rain_poem_summon_use?: boolean
  rain_poem_prank_use?: boolean
  rain_poem_research_unlock?: boolean
  honghua_share_claim?: boolean
  honghua_tiers_claim?: boolean
  honghua_love_donate?: boolean
  wish_sign_draw?: boolean
  wish_sign_choice?: number
  wish_sign_claim?: boolean
  share_reward_share?: boolean
  share_reward_daily?: boolean
  share_reward_milestones?: boolean
  sell?: boolean
  fertilizer_gift?: boolean
  fertilizer_buy_organic?: boolean
  fertilizer_buy_normal?: boolean
  mystery_shop_auto_buy?: boolean
  mystery_shop_allow_gold?: boolean
  mystery_shop_allow_coupon?: boolean
  mystery_shop_allow_gold_bean?: boolean
  mystery_shop_push?: boolean
  daily_report_push?: boolean
  daily_report_hour?: number
  fertilizer?: string
  fertilizer_multi_season?: boolean
  harvest_delay_min?: number
  pet_food_auto_feed?: boolean
  pet_food_auto_feed_threshold_min?: number
  pet_food_auto_feed_buy_count?: number
  fertilizer_land_types?: string[]
  fertilizer_smart_seconds?: number
  friend_steal?: boolean
  friend_steal_only_gids?: number[]
  friend_help?: boolean
  friend_bad?: boolean
  friend_golden_bug?: boolean
  friend_help_exp_limit?: boolean
  golden_bug_clear?: boolean
  skip_own_weed_bug?: boolean
  skip_own_weed_bug_when_exp_full?: boolean
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
  exemptGids?: number[]
}

export interface OfflineConfig {
  channel: string
  reloginUrlMode: string
  endpoint: string
  token: string
  title: string
  msg: string
  offlineDeleteSec: number
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  senderName: string
  recipientEmail: string
  emailContent: string
}

export interface OfflineConfigSavePayload extends OfflineConfig {
  confirmed?: boolean
  confirmText?: string
}

export interface UIConfig {
  theme?: string
}

export interface AutoCodeRefreshConfig {
  enabled: boolean
  intervalMinutes: number
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  prioritize2x2Crops: boolean
  bagSeedPriority: number[]
  bagSeedKnownIds: number[]
  bagSeedFallbackStrategy: string
  autoAcceptFriendMinLevel: number
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  autoCodeRefresh: AutoCodeRefreshConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  goldenBugKeepCount: number
  goldenBugRoundLimit: number
  friendBadTargets: number[]
}

function createDefaultOfflineReminder(): OfflineConfig {
  return {
    channel: 'smtp',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
    offlineDeleteSec: 0,
    smtpHost: '',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    senderName: '',
    recipientEmail: '',
    emailContent: '',
  }
}

function createDefaultAutoCodeRefresh(): AutoCodeRefreshConfig {
  return {
    enabled: false,
    intervalMinutes: 60,
  }
}

function normalizeOfflineReminder(input: Partial<OfflineConfig> | null | undefined): OfflineConfig {
  return {
    ...createDefaultOfflineReminder(),
    ...(input || {}),
  }
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>({
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [],
    bagSeedKnownIds: [],
    bagSeedFallbackStrategy: 'level',
    autoAcceptFriendMinLevel: 0,
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', exemptGids: [10001] },
    automation: {},
    autoCodeRefresh: createDefaultAutoCodeRefresh(),
    ui: {},
    offlineReminder: createDefaultOfflineReminder(),
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    friendBadTargets: [],
  })
  const loading = ref(false)
  const settingsAccountId = ref('')
  const confirmedAutomation = ref<Record<string, unknown> | null>(null)
  const readError = ref('')
  const mutationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  const lastConfirmedSave = ref<{ accountId: string, payload: unknown } | null>(null)
  const pendingSaveSnapshots = new Map<string, { payload: Record<string, unknown>, submitted: any }>()
  let fetchRequestId = 0
  let settingsEpoch = 0
  const defaultPlanApplications = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  const defaultPlanApplicationErrors = ref<Record<string, string>>({})
  const uncertainPlanApplications = new Map<string, Record<string, unknown>>()
  let lastRawRead: { accountId: string, data: Record<string, unknown> } | null = null
  // Per-session result locks survive editor remounts, but never reach storage.
  const userMutationStates = ref<Record<string, 'pending' | 'unknown' | 'idle'>>({})
  const userMutationErrors = ref<Record<string, string>>({})
  const uncertainUserWrites = new Map<string, { expected: unknown, prior: unknown }>()
  watch(() => String(useAccountStore().currentAccountId || ''), () => {
    settingsEpoch++
    lastRawRead = null
    fetchRequestId++
    settingsAccountId.value = ''
    confirmedAutomation.value = null
    lastConfirmedSave.value = null
    readError.value = ''
    loading.value = false
  }, { flush: 'sync' })

  function isCurrentAccount(accountId: string) {
    const accountStore = useAccountStore()
    const currentId = String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
    return currentId === String(accountId)
  }

  function clearSettingsState() {
    settingsEpoch++
    lastRawRead = null
    fetchRequestId++
    settingsAccountId.value = ''
    confirmedAutomation.value = null
    lastConfirmedSave.value = null
    readError.value = ''
    settings.value = {
      plantingStrategy: 'max_exp',
      preferredSeedId: 0,
      prioritize2x2Crops: false,
      bagSeedPriority: [],
      bagSeedKnownIds: [],
      bagSeedFallbackStrategy: 'level',
      autoAcceptFriendMinLevel: 0,
      intervals: {},
      friendQuietHours: { enabled: false, start: '23:00', end: '07:00', exemptGids: [10001] },
      automation: {},
      autoCodeRefresh: createDefaultAutoCodeRefresh(),
      ui: {},
      offlineReminder: createDefaultOfflineReminder(),
      stealDelaySeconds: 0,
      plantOrderRandom: false,
      plantDelaySeconds: 0,
      fertilizerBuyOrganicCount: 10,
      fertilizerBuyOrganicThresholdHours: 10,
      fertilizerBuyNormalCount: 10,
      fertilizerBuyNormalThresholdHours: 10,
      fertilizerBuyCheckIntervalMinutes: 30,
      goldenBugKeepCount: 0,
      goldenBugRoundLimit: 24,
      friendBadTargets: [],
    }
    loading.value = false
  }

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++fetchRequestId
    loading.value = true
    readError.value = ''
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== fetchRequestId || !isCurrentAccount(requestedId))
        return false
      if (data?.ok !== true || !data.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
        readError.value = String(data?.error || '设置读取失败')
        return false
      }
      if (data && data.ok && data.data) {
        const d = data.data
        settings.value.plantingStrategy = d.plantingStrategy || d.strategy || 'max_exp'
        settings.value.preferredSeedId = d.preferredSeedId || d.preferredSeed || 0
        settings.value.prioritize2x2Crops = d.prioritize2x2Crops === true
        settings.value.intervals = d.intervals || {}
        settings.value.friendQuietHours = d.friendQuietHours || { enabled: false, start: '23:00', end: '07:00' }
        settings.value.automation = d.automation || {}
        settingsAccountId.value = requestedId
        confirmedAutomation.value = d.automation && typeof d.automation === 'object' && !Array.isArray(d.automation)
          ? { ...d.automation } : null
        settings.value.autoCodeRefresh = {
          ...createDefaultAutoCodeRefresh(),
          ...(d.autoCodeRefresh || {}),
        }
        settings.value.ui = d.ui || {}
        settings.value.autoAcceptFriendMinLevel = d.autoAcceptFriendMinLevel ?? 0
        settings.value.offlineReminder = normalizeOfflineReminder(d.offlineReminder)
        settings.value.stealDelaySeconds = d.stealDelaySeconds ?? 0
        settings.value.plantOrderRandom = d.plantOrderRandom ?? false
        settings.value.plantDelaySeconds = d.plantDelaySeconds ?? 0
        settings.value.fertilizerBuyOrganicCount = d.fertilizerBuyOrganicCount ?? 10
        settings.value.fertilizerBuyOrganicThresholdHours = d.fertilizerBuyOrganicThresholdHours ?? 10
        settings.value.fertilizerBuyNormalCount = d.fertilizerBuyNormalCount ?? 10
        settings.value.fertilizerBuyNormalThresholdHours = d.fertilizerBuyNormalThresholdHours ?? 10
        settings.value.fertilizerBuyCheckIntervalMinutes = d.fertilizerBuyCheckIntervalMinutes ?? 30
        settings.value.goldenBugKeepCount = d.goldenBugKeepCount ?? 0
        settings.value.goldenBugRoundLimit = d.goldenBugRoundLimit ?? 24
        settings.value.bagSeedPriority = d.bagSeedPriority ?? []
        settings.value.bagSeedKnownIds = d.bagSeedKnownIds ?? []
        settings.value.bagSeedFallbackStrategy = d.bagSeedFallbackStrategy ?? 'level'
        settings.value.friendBadTargets = Array.isArray(d.friendBadTargets)
          ? d.friendBadTargets.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
          : []
      }
      readError.value = ''
      lastRawRead = { accountId: requestedId, data: copySettings(data.data) }
      const uncertain = pendingSaveSnapshots.get(requestedId)
      if (mutationStates.value[requestedId] === 'unknown' && uncertain
        && settingsPatchMatches(data.data, uncertain.payload)
        && (!uncertain.submitted.automation || settingsPatchMatches(data.data.automation, uncertain.submitted.automation))) {
        mutationStates.value[requestedId] = 'idle'
        lastConfirmedSave.value = { accountId: requestedId, payload: uncertain.submitted }
        pendingSaveSnapshots.delete(requestedId)
      }
      const expectedPlan = uncertainPlanApplications.get(requestedId)
      if (defaultPlanApplications.value[requestedId] === 'unknown' && expectedPlan && settingsPatchMatches(data.data, expectedPlan)) {
        defaultPlanApplications.value[requestedId] = 'idle'
        defaultPlanApplicationErrors.value[requestedId] = ''
        uncertainPlanApplications.delete(requestedId)
      }
      return true
    }
    catch (error: any) {
      if (requestId === fetchRequestId && isCurrentAccount(requestedId)) readError.value = error?.message || '设置读取失败'
      return false
    }
    finally {
      if (requestId === fetchRequestId)
        loading.value = false
    }
  }

  async function saveSettings(accountId: string, newSettings: any) {
    if (!accountId)
      return { ok: false, error: '未选择账号', outcomeUnknown: false }
    const id = String(accountId)
    const epoch = settingsEpoch
    if (!isCurrentAccount(id) || settingsAccountId.value !== id || readError.value)
      return { ok: false, error: '请先读取并确认当前账号设置', outcomeUnknown: false }
    if (mutationStates.value[id] === 'pending') return { ok: false, error: '设置保存中，请等待结果', outcomeUnknown: false }
    if (mutationStates.value[id] === 'unknown') return { ok: false, error: '上次设置保存结果未确认，请先读取核对，不重复提交', outcomeUnknown: true }
    const submitted = copySettings(newSettings)
    newSettings = submitted
    mutationStates.value[id] = 'pending'
    lastConfirmedSave.value = null
    loading.value = true
    let wrote = false
    let stage = 'settings'
    try {
      const keys = ['plantingStrategy', 'preferredSeedId', 'prioritize2x2Crops', 'bagSeedPriority', 'bagSeedKnownIds',
        'bagSeedFallbackStrategy', 'autoAcceptFriendMinLevel', 'autoCodeRefresh', 'intervals', 'friendQuietHours',
        'stealDelaySeconds', 'plantOrderRandom', 'plantDelaySeconds', 'fertilizerBuyOrganicCount',
        'fertilizerBuyOrganicThresholdHours', 'fertilizerBuyNormalCount', 'fertilizerBuyNormalThresholdHours',
        'fertilizerBuyCheckIntervalMinutes', 'goldenBugKeepCount', 'goldenBugRoundLimit', 'friendBadTargets']
      // A section sends only its explicitly edited keys. No synthesized defaults
      // or full snapshot can reset a neighbouring editor or unknown new setting.
      const settingsPayload = Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(submitted, key) && submitted[key] !== undefined)
        .map(key => [key, submitted[key]]))

      pendingSaveSnapshots.set(id, { payload: copySettings(settingsPayload), submitted })
      const first = await api.post('/api/settings/save', settingsPayload, { headers: { 'x-account-id': id } })
      if (first.data?.ok !== true || first.data?.outcomeUnknown === true || first.data?.resultState === 'unknown')
        throw { ...(first.data || {}), error: first.data?.error || '设置保存回包未确认' }
      wrote = true
      if (epoch !== settingsEpoch || !isCurrentAccount(id)) {
        mutationStates.value[id] = 'unknown'
        return { ok: false, error: '账号上下文已变化；已发送设置仅读取核对，不继续发送后续操作', outcomeUnknown: true }
      }
      if (submitted.automation) {
        stage = 'automation'
        const second = await api.post('/api/automation', submitted.automation, { headers: { 'x-account-id': id } })
        if (second.data?.ok !== true || second.data?.outcomeUnknown === true || second.data?.resultState === 'unknown') {
          mutationStates.value[id] = 'unknown'
          return { ok: false, error: second.data?.error || '部分设置已保存，自动控制未确认；请读取核对', outcomeUnknown: true }
        }
      }
      stage = 'readback'
      const readback = epoch === settingsEpoch && isCurrentAccount(id) ? await fetchSettings(id) : false
      if (readback !== true || epoch !== settingsEpoch || settingsAccountId.value !== id || lastRawRead?.accountId !== id) {
        mutationStates.value[id] = 'unknown'
        return { ok: false, error: '保存请求已受理，但读回未确认；请核对，不重复提交', outcomeUnknown: true }
      }
      if (!settingsPatchMatches(lastRawRead.data, settingsPayload)
        || submitted.automation && !settingsPatchMatches(lastRawRead.data.automation, submitted.automation)) {
        mutationStates.value[id] = 'unknown'
        return { ok: false, error: '服务器读回与提交内容不一致，保留未保存修改供核对', outcomeUnknown: true }
      }
      mutationStates.value[id] = 'idle'
      pendingSaveSnapshots.delete(id)
      lastConfirmedSave.value = { accountId: id, payload: submitted }
      return { ok: true, outcomeUnknown: false }
    }
    catch (error: any) {
      const result = operationFailure(error, '设置保存结果未确认')
      const uncertain = result.outcomeUnknown || wrote || stage === 'readback'
      mutationStates.value[id] = uncertain ? 'unknown' : 'idle'
      if (!uncertain) pendingSaveSnapshots.delete(id)
      return { ...result, outcomeUnknown: uncertain, error: uncertain ? `${result.error}；仅读取核对，不重复提交。` : result.error }
    }
    finally {
      if (isCurrentAccount(id)) loading.value = false
    }
  }

  function userReadPath(kind: UserConfigKind) {
    return kind === 'device' ? '/api/user/device-protocol' : kind === 'default-plan' ? '/api/settings/default-plan' : '/api/settings'
  }
  function extractUserConfig(kind: UserConfigKind, body: any) {
    const config = kind === 'device' ? body?.config : kind === 'offline' ? body?.data?.offlineReminder : body?.data
    if (body?.ok !== true || !config || typeof config !== 'object' || Array.isArray(config)) return null
    if (kind === 'default-plan' && (!config.config || typeof config.config !== 'object' || typeof config.exists !== 'boolean')) return null
    return copySettings(config)
  }
  async function fetchUserConfig(kind: UserConfigKind): Promise<UserConfigResult> {
    if (LOCAL_UI_READONLY) return { ok: false, sent: false, error: '本地只读浏览，不读取用户配置' }
    try {
      const { data } = await api.get(userReadPath(kind))
      const config = extractUserConfig(kind, data)
      if (!config) return { ok: false, error: data?.error || '用户配置回包未确认' }
      const uncertain = uncertainUserWrites.get(kind)
      if (userMutationStates.value[kind] === 'unknown' && uncertain?.expected !== undefined && settingsPatchMatches(config, uncertain.expected)) {
        userMutationStates.value[kind] = 'idle'
        userMutationErrors.value[kind] = ''
        uncertainUserWrites.delete(kind)
      }
      return { ok: true, config }
    }
    catch (error: any) { return { ok: false, error: error?.message || '用户配置读取失败' } }
  }
  function mutationBlocked(key: UserWriteKey) {
    if (LOCAL_UI_READONLY) return { ok: false, error: '本地只读浏览，不发送操作', outcomeUnknown: false, sent: false }
    if (userMutationStates.value[key] === 'pending') return { ok: false, error: '请求仍在处理中，请等待结果', outcomeUnknown: false, sent: false }
    if (userMutationStates.value[key] === 'unknown') return { ok: false, error: userMutationErrors.value[key] || '上次结果未确认，请先核对，不重复操作', outcomeUnknown: true }
    return null
  }
  async function saveUserConfig(kind: UserConfigKind, send: () => Promise<any>, expected: unknown, prior: unknown): Promise<UserConfigResult> {
    const blocked = mutationBlocked(kind)
    if (blocked) return blocked
    userMutationStates.value[kind] = 'pending'
    userMutationErrors.value[kind] = ''
    uncertainUserWrites.set(kind, { expected: copySettings(expected), prior: copySettings(prior) })
    let accepted = false
    try {
      const { data } = await send()
      if (data?.ok !== true || resultIsUnknown(data)) throw { ...(data || {}), error: data?.error || '保存回包未确认' }
      accepted = true
      const read = await fetchUserConfig(kind)
      if (!read.ok || !settingsPatchMatches(read.config, expected)) throw { outcomeUnknown: true, error: read.error || '保存已受理，但读回内容不一致' }
      userMutationStates.value[kind] = 'idle'
      uncertainUserWrites.delete(kind)
      return { ok: true, config: read.config, outcomeUnknown: false }
    }
    catch (error: any) {
      const failure = operationFailure(error, '配置保存结果未确认')
      const uncertain = accepted || failure.outcomeUnknown
      userMutationStates.value[kind] = uncertain ? 'unknown' : 'idle'
      userMutationErrors.value[kind] = `${failure.error}${uncertain ? '；先读取核对，不自动重试。' : ''}`
      if (!uncertain) uncertainUserWrites.delete(kind)
      return { ...failure, error: userMutationErrors.value[kind], outcomeUnknown: uncertain }
    }
  }
  async function applyDefaultAccountPlan(accountId: string): Promise<UserConfigResult> {
    const id = String(accountId), epoch = settingsEpoch
    if (LOCAL_UI_READONLY) return { ok: false, sent: false, error: '本地只读浏览' }
    if (defaultPlanApplications.value[id] === 'pending') return { ok: false, sent: false, error: '默认方案应用中' }
    if (defaultPlanApplications.value[id] === 'unknown') return { ok: false, outcomeUnknown: true, error: defaultPlanApplicationErrors.value[id] }
    defaultPlanApplications.value[id] = 'pending'
    let accepted = false
    try {
      const plan = await fetchUserConfig('default-plan')
      if (!plan.ok || plan.config?.exists !== true) return { ok: false, sent: false, error: plan.error || '尚未保存默认方案' }
      if (epoch !== settingsEpoch) return { ok: false, sent: false, error: '账号上下文已变化，未应用默认方案' }
      // /api/settings exposes this editable subset, not capitalMode or other
      // internal plan metadata. Verify only fields the existing read contract
      // can actually confirm, never UI defaults or guessed hidden fields.
      const expected = Object.fromEntries(Object.entries(copySettings(plan.config.config)).filter(([key]) => key in settings.value && key !== 'ui' && key !== 'offlineReminder'))
      uncertainPlanApplications.set(id, expected)
      const { data } = await api.post('/api/settings/default-plan/apply', {}, { headers: { 'x-account-id': id } })
      if (data?.ok !== true || resultIsUnknown(data)) throw { ...(data || {}), error: data?.error || '默认方案应用回包未确认' }
      accepted = true
      const { data: readback } = await api.get('/api/settings', { headers: { 'x-account-id': id } })
      if (readback?.ok !== true || !settingsPatchMatches(readback.data, expected)) throw { outcomeUnknown: true, error: '应用请求已受理，设置读回未确认' }
      defaultPlanApplications.value[id] = 'idle'
      defaultPlanApplicationErrors.value[id] = ''
      uncertainPlanApplications.delete(id)
      return { ok: true, config: readback.data, outcomeUnknown: false }
    }
    catch (error: any) {
      const failure = operationFailure(error, '默认方案应用结果未确认')
      const unknown = accepted || failure.outcomeUnknown
      defaultPlanApplications.value[id] = unknown ? 'unknown' : 'idle'
      defaultPlanApplicationErrors.value[id] = `${failure.error}${unknown ? '；仅读取核对，不重复应用。' : ''}`
      if (!unknown) uncertainPlanApplications.delete(id)
      return { ...failure, outcomeUnknown: unknown, error: defaultPlanApplicationErrors.value[id] }
    }
    finally { if (defaultPlanApplications.value[id] === 'pending') defaultPlanApplications.value[id] = 'idle' }
  }
  async function saveOfflineConfig(config: OfflineConfigSavePayload) {
    const submitted = copySettings(config)
    const expected = Object.fromEntries(Object.entries(submitted).filter(([key]) => !['confirmed', 'confirmText'].includes(key)))
    const prior = copySettings(settings.value.offlineReminder)
    const result = await saveUserConfig('offline', () => api.post('/api/settings/offline-reminder', submitted), expected, prior)
    if (result.ok && result.config) settings.value.offlineReminder = normalizeOfflineReminder(result.config)
    return result
  }
  async function sendUserAction(key: 'password' | 'notification', send: () => Promise<any>): Promise<UserConfigResult> {
    const blocked = mutationBlocked(key)
    if (blocked) return blocked
    userMutationStates.value[key] = 'pending'
    userMutationErrors.value[key] = ''
    try {
      const { data } = await send()
      if (data?.ok !== true || resultIsUnknown(data)) throw { ...(data || {}), error: data?.error || '操作回包未确认' }
      userMutationStates.value[key] = 'idle'
      return { ok: true, data: data.data, outcomeUnknown: false }
    }
    catch (error: any) {
      const failure = operationFailure(error, '操作结果未确认')
      userMutationStates.value[key] = failure.outcomeUnknown ? 'unknown' : 'idle'
      userMutationErrors.value[key] = `${failure.error}${failure.outcomeUnknown ? '；不重复发送，请先核对。' : ''}`
      return { ...failure, error: userMutationErrors.value[key] }
    }
  }

  async function saveAutoCodeRefresh(accountId: string, config: AutoCodeRefreshConfig) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    loading.value = true
    try {
      const { data } = await api.post('/api/settings/auto-code-refresh', config, {
        headers: { 'x-account-id': accountId },
      })
      if (data && data.ok) {
        settings.value.autoCodeRefresh = {
          ...createDefaultAutoCodeRefresh(),
          ...(data.data?.autoCodeRefresh || config),
        }
        return { ok: true }
      }
      return { ok: false, error: data?.error || '保存失败' }
    }
    catch (e: any) {
      return { ok: false, error: e.response?.data?.error || e.message }
    }
    finally {
      loading.value = false
    }
  }

  async function runAutoCodeRefresh(accountId: string) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    try {
      const { data } = await api.post('/api/settings/auto-code-refresh/run', {}, {
        headers: { 'x-account-id': accountId },
      })
      if (data && data.ok)
        return { ok: true }
      return { ok: false, error: data?.error || '刷新失败' }
    }
    catch (e: any) {
      return { ok: false, error: e.response?.data?.error || e.message }
    }
  }

  return {
    settings,
    settingsAccountId,
    confirmedAutomation,
    readError,
    mutationStates,
    lastConfirmedSave,
    loading,
    clearSettingsState,
    fetchSettings,
    saveSettings,
    saveOfflineConfig,
    userMutationStates,
    userMutationErrors,
    defaultPlanApplications,
    defaultPlanApplicationErrors,
    applyDefaultAccountPlan,
    fetchUserConfig,
    saveUserConfig,
    sendUserAction,
    saveAutoCodeRefresh,
    runAutoCodeRefresh,
  }
})
