<script setup lang="ts">
import { computed, inject, onMounted, onScopeDispose, ref } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import AutomationSettingsTab from '@/components/settings/AutomationSettingsTab.vue'
import StrategySettingsTab from '@/components/settings/StrategySettingsTab.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { defaultAutomation } from '@/composables/settings/useAutomationSettings'
import { copySettings, createSettingsDraft, SETTINGS_DRAFT_REGISTRY, settingsFingerprint } from '@/composables/settings/useSettingsDraft'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import { vSlidingTabs } from '@/composables/useContentMotion'
import { useSettingStore } from '@/stores/setting'

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

const props = defineProps<{
  currentAccountId: string | number | null | undefined
  currentAccountName: string | null
  plantingStrategyOptions: { label: string, value: string }[]
  preferredSeedOptions: { label: string, value: number }[]
  bagFallbackStrategyOptions: { label: string, value: string }[]
  bagSeeds: BagSeedItem[]
  bagSeedsLoading: boolean
  bagSeedsError: string | null
  fertilizerLandTypeOptions: { label: string, value: string }[]
  fertilizerOptions: { label: string, value: string | number }[]
}>()

const emit = defineEmits<{
  notify: [message: string, type?: 'primary' | 'danger']
}>()

const settingStore = useSettingStore()
const planReadError = ref('')
const planUnknown = computed(() => settingStore.userMutationStates['default-plan'] === 'unknown')
const planError = computed(() => settingStore.userMutationErrors['default-plan'] || planReadError.value)
const activeSection = ref<'strategy' | 'automation'>('strategy')
const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const resetting = ref(false)
const showResetConfirm = ref(false)
const exists = ref(false)
const enabled = ref(true)
const updatedAt = ref(0)
let draggedSeedId: number | null = null

const strategySettings = ref(createStrategySettings())
const automationSettings = ref(createAutomationSettings())
const autoCodeRefresh = ref({ enabled: false, intervalMinutes: 60 })
let disposed = false
const draft = createSettingsDraft(() => ({ enabled: enabled.value, strategy: strategySettings.value, automation: automationSettings.value, autoCode: autoCodeRefresh.value }),
  value => { enabled.value = value.enabled; strategySettings.value = value.strategy; automationSettings.value = value.automation; autoCodeRefresh.value = value.autoCode })
const registry = inject(SETTINGS_DRAFT_REGISTRY, null)
const unregister = registry?.register('default-plan', { label: '默认方案', scope: 'page', dirty: () => draft.dirty.value,
  saving: () => saving.value || importing.value || resetting.value, reset: draft.reset })
onScopeDispose(() => { disposed = true; unregister?.(); draft.clear() })

function createStrategySettings() {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [] as number[],
    bagSeedFallbackStrategy: 'level',
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    intervals: { farmMin: 2, farmMax: 5, helpMin: 30, helpMax: 35, stealMin: 25, stealMax: 30 },
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', exemptGids: [10001] },
  }
}

function createAutomationSettings() {
  return {
    // 复用 composable 的默认值，避免第二份字面量与奶茶等新增字段不同步
    automation: copySettings(defaultAutomation),
    autoAcceptFriendMinLevel: 0,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    friendBadTargets: [] as number[],
  }
}

function applyPlan(data: any) {
  const config = data?.config || {}
  exists.value = data?.exists === true
  enabled.value = data?.enabled !== false
  updatedAt.value = Number(data?.updatedAt) || 0
  strategySettings.value = {
    ...createStrategySettings(),
    ...config,
    intervals: { ...createStrategySettings().intervals, ...(config.intervals || {}) },
    friendQuietHours: { ...createStrategySettings().friendQuietHours, ...(config.friendQuietHours || {}) },
    bagSeedPriority: Array.isArray(config.bagSeedPriority) ? [...config.bagSeedPriority] : [],
  }
  const automationDefaults = createAutomationSettings()
  automationSettings.value = {
    ...automationDefaults,
    ...config,
    automation: { ...automationDefaults.automation, ...(config.automation || {}) },
    friendBadTargets: Array.isArray(config.friendBadTargets) ? [...config.friendBadTargets] : [],
  }
  autoCodeRefresh.value = {
    enabled: config.autoCodeRefresh?.enabled === true,
    intervalMinutes: Number(config.autoCodeRefresh?.intervalMinutes) || 60,
  }
}

const sortedBagSeeds = computed(() => {
  const byId = new Map(props.bagSeeds.map(seed => [seed.seedId, seed]))
  return strategySettings.value.bagSeedPriority
    .map(id => byId.get(id))
    .filter((seed): seed is BagSeedItem => !!seed)
})

const strategyPreviewLabel = computed(() => {
  const option = props.plantingStrategyOptions.find(item => item.value === strategySettings.value.plantingStrategy)
  return option?.label || '默认策略'
})

const updatedAtLabel = computed(() => {
  if (!updatedAt.value)
    return '尚未保存'
  return new Date(updatedAt.value).toLocaleString('zh-CN', { hour12: false })
})

function pickPlanConfig(config: any) {
  const keys = ['automation', 'autoCodeRefresh', 'plantingStrategy', 'preferredSeedId', 'prioritize2x2Crops',
    'intervals', 'friendQuietHours', 'stealDelaySeconds', 'plantOrderRandom', 'plantDelaySeconds',
    'fertilizerBuyOrganicCount', 'fertilizerBuyOrganicThresholdHours', 'fertilizerBuyNormalCount',
    'fertilizerBuyNormalThresholdHours', 'fertilizerBuyCheckIntervalMinutes', 'goldenBugKeepCount',
    'goldenBugRoundLimit', 'friendBadTargets', 'autoAcceptFriendMinLevel', 'bagSeedPriority', 'bagSeedFallbackStrategy', 'capitalMode']
  return Object.fromEntries(keys.filter(key => config[key] !== undefined).map(key => [key, config[key]]))
}
function buildConfig() {
  const strategy = Object.fromEntries(Object.keys(createStrategySettings()).map(key => [key, (strategySettings.value as any)[key]]))
  const automation = Object.fromEntries(Object.keys(createAutomationSettings()).map(key => [key, (automationSettings.value as any)[key]]))
  return pickPlanConfig({ ...strategySettings.value, ...automationSettings.value, ...strategy, ...automation, autoCodeRefresh: autoCodeRefresh.value })
}

function rebasePlan(data: any, priorEditing: boolean) {
  const previous = copySettings({ enabled: enabled.value, strategy: strategySettings.value, automation: automationSettings.value, autoCode: autoCodeRefresh.value })
  applyPlan(data)
  const confirmed = copySettings({ enabled: enabled.value, strategy: strategySettings.value, automation: automationSettings.value, autoCode: autoCodeRefresh.value })
  if (priorEditing) { enabled.value = previous.enabled; strategySettings.value = previous.strategy; automationSettings.value = previous.automation; autoCodeRefresh.value = previous.autoCode }
  draft.rebase(confirmed)
}
async function fetchPlan() {
  if (LOCAL_UI_READONLY || disposed || loading.value) return
  loading.value = true
  planReadError.value = ''
  try {
    const result = await settingStore.fetchUserConfig('default-plan')
    if (disposed) return
    if (!result.ok) { planReadError.value = result.error || '默认方案加载失败'; return }
    rebasePlan(result.config, draft.dirty.value)
  }
  finally { loading.value = false }
}

async function savePlan() {
  if (LOCAL_UI_READONLY || disposed || saving.value || importing.value || resetting.value || planUnknown.value || !draft.ready.value || planReadError.value) return
  const intervals = strategySettings.value.intervals
  if (intervals.farmMin > intervals.farmMax || intervals.helpMin > intervals.helpMax || intervals.stealMin > intervals.stealMax) { emit('notify', '巡查最小间隔不能大于最大间隔', 'danger'); return }
  const submission = copySettings({ enabled: enabled.value, strategy: strategySettings.value, automation: automationSettings.value, autoCode: autoCodeRefresh.value })
  const payload = copySettings({ enabled: enabled.value, config: buildConfig() })
  saving.value = true
  try {
    const result = await settingStore.saveUserConfig('default-plan', () => api.put('/api/settings/default-plan', payload), { exists: true, ...payload }, {})
    if (disposed) return
    if (!result.ok) { emit('notify', result.error || '默认方案保存未确认', 'danger'); return }
    const changedAfterSubmit = settingsFingerprint(submission) !== settingsFingerprint({ enabled: enabled.value, strategy: strategySettings.value, automation: automationSettings.value, autoCode: autoCodeRefresh.value })
    rebasePlan(result.config, changedAfterSubmit)
    emit('notify', '默认方案已读回确认')
  }
  finally { saving.value = false }
}

async function importCurrentAccount() {
  if (!props.currentAccountId || LOCAL_UI_READONLY || disposed || importing.value || saving.value || resetting.value || planUnknown.value || !draft.ready.value) return
  const accountId = String(props.currentAccountId), accountName = props.currentAccountName || '当前账号'
  importing.value = true
  try {
    const { data } = await api.get('/api/settings', { headers: { 'x-account-id': accountId } })
    if (disposed || accountId !== String(props.currentAccountId)) return
    if (data?.ok !== true || !data.data) { emit('notify', data?.error || '账号配置读取失败，未导入', 'danger'); return }
    const before = await settingStore.fetchUserConfig('default-plan')
    if (!before.ok || disposed || accountId !== String(props.currentAccountId)) return
    const expected = { exists: true, enabled: before.config.enabled, config: pickPlanConfig(data.data) }
    const result = await settingStore.saveUserConfig('default-plan', () => api.post('/api/settings/default-plan/import', {}, { headers: { 'x-account-id': accountId } }), expected, before.config)
    if (disposed) return
    if (!result.ok) { emit('notify', result.error || '导入结果未确认', 'danger'); return }
    rebasePlan(result.config, false)
    emit('notify', `已从 ${accountName} 导入并读回确认默认方案`)
  }
  finally { importing.value = false }
}

async function resetPlan() {
  if (LOCAL_UI_READONLY || disposed || resetting.value || saving.value || importing.value || planUnknown.value || !draft.ready.value) return
  resetting.value = true
  try {
    const { data } = await api.get('/api/settings/default')
    if (disposed || data?.ok !== true || !data.data) { emit('notify', '系统默认配置读取失败，未发送恢复请求', 'danger'); return }
    const before = await settingStore.fetchUserConfig('default-plan')
    if (!before.ok || disposed) return
    const expected = { exists: true, enabled: before.config.enabled, config: pickPlanConfig(data.data) }
    const result = await settingStore.saveUserConfig('default-plan', () => api.post('/api/settings/default-plan/reset'), expected, before.config)
    if (disposed) return
    showResetConfirm.value = false
    if (!result.ok) { emit('notify', result.error || '恢复结果未确认', 'danger'); return }
    rebasePlan(result.config, false)
    emit('notify', '默认方案已恢复并读回确认')
  }
  finally { resetting.value = false }
}

function resetBagSeedPriority() {
  strategySettings.value.bagSeedPriority = props.bagSeeds.map(seed => seed.seedId)
}

function moveBagSeed(seedId: number, direction: -1 | 1) {
  const list = strategySettings.value.bagSeedPriority
  const index = list.indexOf(seedId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= list.length) {
    return
  }
  const current = list[index]!
  list[index] = list[target]!
  list[target] = current
}

function removeBagSeedPriority(seedId: number) {
  strategySettings.value.bagSeedPriority = strategySettings.value.bagSeedPriority.filter(id => id !== seedId)
}

function startBagSeedDrag(seedId: number) {
  draggedSeedId = seedId
}

function dropBagSeed(seedId: number) {
  if (!draggedSeedId || draggedSeedId === seedId)
    return
  const list = strategySettings.value.bagSeedPriority
  const from = list.indexOf(draggedSeedId)
  const to = list.indexOf(seedId)
  if (from < 0 || to < 0)
    return
  const [moved] = list.splice(from, 1)
  if (moved !== undefined)
    list.splice(to, 0, moved)
  draggedSeedId = null
}

onMounted(fetchPlan)
</script>

<template>
  <div class="space-y-4">
    <p v-if="LOCAL_UI_READONLY" class="ui-notice">默认方案属于用户配置，本地只读浏览不读取或保存此配置。</p>
    <p v-else-if="planError" class="ui-notice" role="status">{{ planError }}{{ planUnknown ? ' 保留修改，不重复保存、导入或恢复。' : '' }}</p>
    <p v-else-if="draft.dirty.value" class="ui-notice" role="status">默认方案有未保存修改；离开前会提醒，不自动保存。</p>
    <BaseButton v-if="!LOCAL_UI_READONLY && (planUnknown || planReadError || !draft.ready.value)" variant="outline" size="sm" :disabled="loading || saving || importing || resetting" @click="fetchPlan">读取核对</BaseButton>
    <div class="flex flex-col gap-3 border-b border-gray-200 pb-4 lg:flex-row lg:items-center lg:justify-between dark:border-gray-700">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="flex items-center gap-2 text-lg text-gray-900 font-bold dark:text-gray-100">
            <span class="i-carbon-settings-adjust" />
            默认方案
          </h3>
          <BaseSwitch v-model="enabled" label="新账号自动应用" :disabled="LOCAL_UI_READONLY || saving || importing || resetting || !draft.ready.value" />
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ exists ? `最后保存：${updatedAtLabel}` : '尚未保存默认方案' }}
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <BaseButton
          variant="outline"
          size="sm"
          :loading="importing"
          :disabled="!currentAccountId || loading || saving || resetting || planUnknown || !draft.ready.value || LOCAL_UI_READONLY"
          :title="currentAccountId ? `从 ${currentAccountName || '当前账号'} 导入` : '请先选择账号'"
          @click="importCurrentAccount"
        >
          <span class="i-carbon-document-import mr-1.5" />
          从当前账号导入
        </BaseButton>
        <BaseButton variant="ghost" size="sm" :disabled="loading || saving || importing || resetting || planUnknown || !draft.ready.value || LOCAL_UI_READONLY" @click="showResetConfirm = true">
          <span class="i-carbon-reset mr-1.5" />
          恢复系统默认
        </BaseButton>
      </div>
    </div>

    <div v-if="!LOCAL_UI_READONLY" v-sliding-tabs class="ui-tabs" aria-label="默认方案分类">
      <button
        data-testid="default-plan-strategy-section"
        class="ui-tab" :data-active="activeSection === 'strategy'"
        @click="activeSection = 'strategy'"
      >
        <span class="i-carbon-settings" />
        策略设置
      </button>
      <button
        data-testid="default-plan-automation-section"
        class="ui-tab" :data-active="activeSection === 'automation'"
        @click="activeSection = 'automation'"
      >
        <span class="i-carbon-toggle-on" />
        自动控制
      </button>
    </div>

    <div v-if="loading" class="py-10 text-center text-gray-500">
      <span class="i-svg-spinners-ring-resize mb-2 inline-block text-2xl" />
      <div>加载中...</div>
    </div>

    <div v-else-if="LOCAL_UI_READONLY" class="ui-empty-state"><span class="i-carbon-settings-adjust" aria-hidden="true" /><p>未读取用户默认方案</p><p>本地浏览只检查界面，不使用模拟账号或配置。</p></div>

    <fieldset v-else class="m-0 min-w-0 border-0 p-0" :disabled="saving || importing || resetting || !draft.ready.value">
    <StrategySettingsTab
      v-if="activeSection === 'strategy'"
      v-model:settings="strategySettings"
      :current-account-id="draft.ready.value && !planReadError ? 'default-plan' : ''"
      :current-account-name="null"
      :loading="false"
      :saving="saving || importing || resetting"
      :show-save="false"
      title="默认策略"
      save-label="保存默认方案"
      :planting-strategy-options="plantingStrategyOptions"
      :preferred-seed-options="preferredSeedOptions"
      :bag-fallback-strategy-options="bagFallbackStrategyOptions"
      :strategy-preview-label="strategyPreviewLabel"
      :bag-seeds="bagSeeds"
      :sorted-bag-seeds="sortedBagSeeds"
      :bag-seeds-loading="bagSeedsLoading"
      :bag-seeds-error="bagSeedsError"
      :automation="automationSettings.automation"
      @reset-bag-seed-priority="resetBagSeedPriority"
      @move-bag-seed="moveBagSeed"
      @remove-bag-seed="removeBagSeedPriority"
      @start-bag-seed-drag="startBagSeedDrag"
      @drag-over-bag-seed="() => {}"
      @drop-bag-seed="dropBagSeed"
      @save="savePlan"
    />

    <AutomationSettingsTab
      v-else
      v-model:settings="automationSettings"
      v-model:auto-code-refresh="autoCodeRefresh"
      :current-account-id="draft.ready.value && !planReadError ? 'default-plan' : ''"
      :current-account-name="null"
      :loading="false"
      :saving="saving || importing || resetting"
      :show-save="false"
      :auto-code-refreshing="false"
      :show-run-auto-code-refresh="false"
      title="默认自动控制"
      save-label="保存默认方案"
      :fertilizer-land-type-options="fertilizerLandTypeOptions"
      :fertilizer-options="fertilizerOptions"
      @save="savePlan"
    />
    </fieldset>

    <div v-if="!LOCAL_UI_READONLY && draft.ready.value" class="default-plan-savebar ui-subtle-panel">
      <span>{{ saving || importing || resetting ? '请求处理中，请等待确认' : planUnknown ? '结果未确认，先读取核对' : draft.dirty.value ? '有未保存修改' : '当前无待保存修改' }}</span>
      <BaseButton variant="primary" :loading="saving" :disabled="importing || resetting || planUnknown || !!planReadError || !draft.dirty.value" @click="savePlan">保存默认方案</BaseButton>
    </div>
    <ConfirmModal
      :show="showResetConfirm"
      :loading="resetting"
      title="恢复系统默认"
      message="确定要用系统默认设置覆盖当前默认方案吗？"
      confirm-text="确认恢复"
      @close="!resetting && (showResetConfirm = false)"
      @cancel="!resetting && (showResetConfirm = false)"
      @confirm="resetPlan"
    />
  </div>
</template>

<style scoped>
.default-plan-savebar { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; z-index: 10; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-card); color: var(--theme-text); background: var(--surface-1); }
.default-plan-savebar > span { font-size: 14px; }
</style>
