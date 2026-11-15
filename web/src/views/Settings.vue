<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, provide, ref, shallowReactive, useId, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import ConfirmModal from '@/components/ConfirmModal.vue'
import AccountSettingsTab from '@/components/settings/AccountSettingsTab.vue'
import AutomationSettingsTab from '@/components/settings/AutomationSettingsTab.vue'
import DefaultPlanSettingsTab from '@/components/settings/DefaultPlanSettingsTab.vue'
import StrategySettingsTab from '@/components/settings/StrategySettingsTab.vue'
import UserSettingsTab from '@/components/settings/UserSettingsTab.vue'
import { useAccountSettings } from '@/composables/settings/useAccountSettings'
import { useAutomationSettings } from '@/composables/settings/useAutomationSettings'
import { useStrategySettings } from '@/composables/settings/useStrategySettings'
import { useUserSettings } from '@/composables/settings/useUserSettings'
import { useSettingStore } from '@/stores/setting'
import { useSlidingTabs, vSlidingTabs } from '@/composables/useContentMotion'
import BaseButton from '@/components/ui/BaseButton.vue'
import { createSettingsDraft, SETTINGS_DRAFT_REGISTRY } from '@/composables/settings/useSettingsDraft'
import type { SettingsDraftParticipant } from '@/composables/settings/useSettingsDraft'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

const settingStore = useSettingStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const route = useRoute()
const settingsId = useId()
let disposed = false
let accountEpoch = 0
onScopeDispose(() => { disposed = true; accountEpoch++ })

type SettingsTabKey = 'account' | 'strategy' | 'automation' | 'default-plan' | 'user'

function getInitialSettingsTab(): SettingsTabKey {
  const requested = String(route.query.tab || '')
  if (requested === 'account' || requested === 'strategy' || requested === 'automation' || requested === 'default-plan' || requested === 'user')
    return requested
  let saved: string | null = null
  try { saved = localStorage.getItem('settings-active-tab') }
  catch { /* Default tab stays accessible without storage. */ }
  return saved === 'strategy' || saved === 'automation' || saved === 'default-plan' || saved === 'user'
    ? saved
    : 'account'
}

const activeTab = ref<SettingsTabKey>(getInitialSettingsTab())
const settingsTabsNav = ref<HTMLElement | null>(null)
const participants = shallowReactive(new Map<string, SettingsDraftParticipant>())
const draftRegistry = { register(key: string, participant: SettingsDraftParticipant) {
  participants.set(key, participant)
  return () => { if (participants.get(key) === participant) participants.delete(key) }
} }
provide(SETTINGS_DRAFT_REGISTRY, draftRegistry)
const leaveVisible = ref(false)
const leaveMessage = ref('')
let leaveWaiter: ((allowed: boolean) => void) | null = null
let leaveAffected: SettingsDraftParticipant[] = []
const unsaved = computed(() => [...participants.values()].filter(item => item.dirty()))
const anySaving = computed(() => !!defaultPlanApplyingId.value || [...participants.values()].some(item => item.saving()))
function confirmDiscard(scope?: 'account' | 'user' | 'page') {
  const changed = unsaved.value.filter(item => !scope || item.scope === scope)
  if (anySaving.value) { showAlert('设置请求仍在处理中，请等待结果；离开不会取消已发请求。'); return Promise.resolve(false) }
  if (!changed.length) return Promise.resolve(true)
  leaveWaiter?.(false)
  leaveAffected = changed
  leaveMessage.value = `「${changed.map(item => item.label).join('、')}」有未保存修改。继续将放弃这些修改，不会自动保存或改变服务器设置。`
  leaveVisible.value = true
  return new Promise<boolean>(resolve => { leaveWaiter = resolve })
}
function finishDiscard(allowed: boolean) {
  if (allowed) leaveAffected.forEach(item => item.reset())
  leaveAffected = []
  leaveVisible.value = false
  const resolve = leaveWaiter
  leaveWaiter = null
  resolve?.(allowed)
}
onBeforeRouteLeave(() => confirmDiscard())
const selectionOwner = Symbol('settings-selection')
const unregisterSelection = accountStore.registerSelectionGuard(selectionOwner, () => confirmDiscard('account'))
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (unsaved.value.length || anySaving.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onScopeDispose(() => {
  unregisterSelection()
  window.removeEventListener('beforeunload', onBeforeUnload)
  leaveWaiter?.(false)
  leaveWaiter = null
  participants.clear()
})

async function scrollActiveTabIntoView() {
  await nextTick()
  if (disposed) return
  const button = settingsTabsNav.value?.querySelector<HTMLElement>(`[data-settings-tab="${activeTab.value}"]`)
  button?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' })
}

watch(activeTab, (newTab) => {
  try { localStorage.setItem('settings-active-tab', newTab) }
  catch { /* A tab remains usable when storage is unavailable. */ }
  void scrollActiveTabIntoView()
})

const tabs = [
  { key: 'account', label: '账号管理', icon: 'i-carbon-user-settings' },
  { key: 'strategy', label: '策略设置', icon: 'i-carbon-settings' },
  { key: 'automation', label: '自动控制', icon: 'i-carbon-toggle-on' },
  { key: 'default-plan', label: '默认方案', icon: 'i-carbon-settings-adjust' },
  { key: 'user', label: '用户管理', icon: 'i-carbon-user' },
] as const

const modalVisible = ref(false)
const defaultPlanApplyingId = ref('')
const defaultPlanUnknown = computed<Record<string, string>>(() => Object.fromEntries(Object.entries(settingStore.defaultPlanApplications)
  .filter(([, state]) => state === 'unknown').map(([id]) => [id, settingStore.defaultPlanApplicationErrors[id] || '默认方案应用结果未确认，仅读取核对'])))
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

const {
  passwordSaving,
  offlineSaving,
  offlineTesting,
  deviceProtocolLoading,
  deviceProtocolSaving,
  deviceProtocolReadError,
  offlineReadError,
  deviceProtocolReady,
  offlineReady,
  userMutationStates,
  userMutationErrors,
  passwordForm,
  deviceProtocolPresetOptions,
  selectedDevicePreset,
  deviceProtocolForm,
  localOffline,
  channelOptions,
  currentChannelDocUrl,
  openChannelDocs,
  fillRandomDeviceMac,
  fillRandomDeviceId,
  fillRandomImei,
  applyDevicePreset,
  fetchDeviceProtocol,
  fetchOfflineSettings,
  syncLocalOfflineSettings,
  handleSaveDeviceProtocol,
  handleChangePassword,
  handleSaveOffline,
  handleTestOffline,
} = useUserSettings(showAlert, draftRegistry)

const {
  accounts,
  accountsLoading,
  currentAccountId,
  currentAccountName,
  userIsAdmin,
  showModal,
  showDeleteConfirm,
  deleteLoading,
  editingAccount,
  accountToDelete,
  showClearStoppedConfirm,
  clearStoppedLoading,
  refreshWxCodesLoading,
  accountTogglePending,
  accountToggleUnknown,
  stoppedAccountsCount,
  isAddAccountDisabled,
  addAccountDisabledReason,
  isAccountOpsDisabled,
  fetchAccounts,
  selectFirstAccountIfNeeded,
  openSettings,
  openAddModal,
  openEditModal,
  handleDelete,
  confirmDelete,
  toggleAccount,
  refreshWxCodesNow,
  handleSaved,
  selectAccount,
  openClearStoppedConfirm,
  confirmClearStopped,
} = useAccountSettings(showAlert)
const settingsContent = ref<HTMLElement | null>(null)
const { select: selectSettingsTab, selected: selectedSettingsTab } = useSlidingTabs(activeTab, () => settingsContent.value,
  () => tabs.map(tab => tab.key), () => currentAccountId.value)

const {
  localAutomationSettings,
  localAutoCodeRefresh,
  automationSaving,
  autoCodeRefreshing,
  fertilizerLandTypeOptions,
  fertilizerOptions,
  syncLocalAutomationSettings,
  saveAutomationSettings,
  runAutoCodeRefreshNow,
} = useAutomationSettings({
  currentAccountId,
  showAlert,
})

const {
  settingsLoading,
  strategySaving,
  localStrategySettings,
  plantingStrategyOptions,
  bagFallbackStrategyOptions,
  bagSeeds,
  bagSeedsLoading,
  bagSeedsError,
  sortedBagSeeds,
  preferredSeedOptions,
  strategyPreviewLabel,
  resetBagSeedPriority,
  moveBagSeed,
  removeBagSeedPriority,
  startBagSeedDrag,
  dragOverBagSeed,
  dropBagSeed,
  loadStrategyData,
  saveStrategySettings,
  resetStrategyState,
} = useStrategySettings({
  currentAccountId,
  activeTab,
  getAutomationSettings: () => localAutomationSettings.value,
  showAlert,
})

const strategyDraft = createSettingsDraft(
  () => ({ strategy: localStrategySettings.value, harvestDelay: localAutomationSettings.value.automation.harvest_delay_min }),
  value => { localStrategySettings.value = value.strategy; localAutomationSettings.value.automation.harvest_delay_min = value.harvestDelay },
)
const automationDraft = createSettingsDraft(
  () => ({ automation: localAutomationSettings.value, autoCode: localAutoCodeRefresh.value }),
  value => { localAutomationSettings.value = value.automation; localAutoCodeRefresh.value = value.autoCode },
)
const unregisterStrategyDraft = (() => {
  const item: SettingsDraftParticipant = { label: '策略设置', scope: 'account', dirty: () => strategyDraft.dirty.value,
    saving: () => strategySaving.value, reset: strategyDraft.reset }
  participants.set('strategy', item)
  return () => participants.delete('strategy')
})()
const unregisterAutomationDraft = (() => {
  const item: SettingsDraftParticipant = { label: '自动控制', scope: 'account', dirty: () => automationDraft.dirty.value,
    saving: () => automationSaving.value, reset: automationDraft.reset }
  participants.set('automation', item)
  return () => participants.delete('automation')
})()
onScopeDispose(() => { unregisterStrategyDraft(); unregisterAutomationDraft(); strategyDraft.clear(); automationDraft.clear() })
const currentDraft = computed(() => activeTab.value === 'strategy' ? strategyDraft : activeTab.value === 'automation' ? automationDraft : null)
const currentDraftDirty = computed(() => currentDraft.value?.dirty.value === true)
const saveUnknown = computed(() => settingStore.mutationStates[String(currentAccountId.value || '')] === 'unknown')
const initializingEditor = ref(false)
const editorReady = computed(() => !!currentAccountId.value && !!accountStore.currentAccount && !initializingEditor.value
  && settingStore.settingsAccountId === String(currentAccountId.value) && !settingStore.readError)
async function changeSettingsTab(next: SettingsTabKey) {
  if (next === activeTab.value) return
  if (anySaving.value) { showAlert('设置正在保存，请等待结果。'); return }
  // Account strategy/automation drafts share in-memory fields and stay mounted
  // in Settings. Child default-plan/user editors do not; guard their dismissal.
  if (['default-plan', 'user'].includes(activeTab.value) && !(await confirmDiscard(activeTab.value === 'user' ? 'user' : 'page'))) return
  selectSettingsTab(next)
}
function onSettingsTabKeydown(event: KeyboardEvent, key: SettingsTabKey) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = tabs.findIndex(item => item.key === key)
  const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
  if (!next) return
  void changeSettingsTab(next.key).then(() => nextTick(() => settingsTabsNav.value?.querySelector<HTMLElement>(`[data-settings-tab="${selectedSettingsTab.value}"]`)?.focus()))
}
async function saveCurrentSettings() {
  if (LOCAL_UI_READONLY || anySaving.value || saveUnknown.value || !editorReady.value) return
  const form = settingsContent.value
  const originalAccount = String(currentAccountId.value)
  if (activeTab.value === 'strategy') {
    const intervals = localStrategySettings.value.intervals
    for (const prefix of ['farm', 'help', 'steal'] as const) {
      if (Number(intervals[`${prefix}Min`]) > Number(intervals[`${prefix}Max`])) { showAlert('巡查最小间隔不能大于最大间隔，请先调整。', 'danger'); return }
    }
  }
  const strategyAtSubmission = JSON.parse(JSON.stringify({ strategy: localStrategySettings.value, harvestDelay: localAutomationSettings.value.automation.harvest_delay_min }))
  const automationAtSubmission = JSON.parse(JSON.stringify({ automation: localAutomationSettings.value, autoCode: localAutoCodeRefresh.value }))
  const invalid = form?.querySelector<HTMLInputElement>('input:invalid') || document.querySelector<HTMLInputElement>('.modal-card input:invalid')
  if (invalid) { invalid.closest('details')?.setAttribute('open', ''); invalid.reportValidity(); invalid.focus(); return }
  const section = activeTab.value
  const saved = section === 'strategy' ? await saveStrategySettings() : await saveAutomationSettings()
  if (!saved || disposed || originalAccount !== String(currentAccountId.value) || settingStore.lastConfirmedSave?.accountId !== originalAccount) return
  // Rebase only fields actually sent and read back. Unsaved values in the
  // other editor must never be cleared by a neighbouring section's save.
  if (section === 'strategy') {
    strategyDraft.rebase(strategyAtSubmission)
    const baseline = automationDraft.confirmed()
    if (baseline) { baseline.automation.automation.harvest_delay_min = automationAtSubmission.automation.automation.harvest_delay_min; automationDraft.rebase(baseline) }
  }
  else {
    automationDraft.rebase(automationAtSubmission)
    const baseline = strategyDraft.confirmed()
    if (baseline) { baseline.harvestDelay = automationAtSubmission.automation.automation.harvest_delay_min; strategyDraft.rebase(baseline) }
  }
}
async function reloadUnknownSettings() {
  if (anySaving.value || !currentAccountId.value) return
  await settingStore.fetchSettings(String(currentAccountId.value))
  if (!settingStore.readError) {
    if (!saveUnknown.value && settingStore.lastConfirmedSave?.accountId === String(currentAccountId.value)) {
      const payload = settingStore.lastConfirmedSave.payload as any
      const strategyBaseline = strategyDraft.confirmed()
      const automationBaseline = automationDraft.confirmed()
      if (strategyBaseline) {
        for (const key of Object.keys(strategyBaseline.strategy)) if (payload[key] !== undefined) (strategyBaseline.strategy as any)[key] = payload[key]
        if (payload.automation?.harvest_delay_min !== undefined) strategyBaseline.harvestDelay = payload.automation.harvest_delay_min
        strategyDraft.rebase(strategyBaseline)
      }
      if (automationBaseline) {
        for (const key of Object.keys(automationBaseline.automation)) {
          if (key === 'automation' && payload.automation) Object.assign(automationBaseline.automation.automation, payload.automation)
          else if (payload[key] !== undefined) (automationBaseline.automation as any)[key] = payload[key]
        }
        if (payload.autoCodeRefresh) automationBaseline.autoCode = payload.autoCodeRefresh
        automationDraft.rebase(automationBaseline)
      }
    }
    showAlert(saveUnknown.value ? '已读取服务器设置供核对，仍与提交不同；不会自动重试。' : '已读回确认服务器设置，不重放保存请求。')
  }
}

async function applyDefaultPlan(account: any) {
  if (LOCAL_UI_READONLY || !account?.id || defaultPlanApplyingId.value || defaultPlanUnknown.value[String(account.id)] || anySaving.value) return
  const accountId = String(account.id)
  if (String(currentAccountId.value) === accountId && !(await confirmDiscard('account'))) return
  const epoch = accountEpoch
  defaultPlanApplyingId.value = accountId
  try {
    const result = await settingStore.applyDefaultAccountPlan(accountId)
    if (disposed || epoch !== accountEpoch) return
    if (!result.ok) { showAlert(result.error || '默认方案应用未确认', 'danger'); return }
    if (String(currentAccountId.value) === accountId) await initializeAccountEditor()
    showAlert(`已将默认方案应用到 ${account.name || account.id}，设置读回已确认`)
  }
  finally { defaultPlanApplyingId.value = '' }
}

watch(() => route.query.tab, (requested) => {
  const tab = String(requested || '') as SettingsTabKey
  if (tabs.some(item => item.key === tab)) void changeSettingsTab(tab)
})

async function initializeAccountEditor() {
  const epoch = ++accountEpoch
  initializingEditor.value = true
  strategyDraft.clear()
  automationDraft.clear()
  settingStore.clearSettingsState()
  resetStrategyState()
  try {
    if (!currentAccountId.value || !accountStore.currentAccount || LOCAL_UI_READONLY) return
    const applied = await loadStrategyData()
    if (applied === false || disposed || epoch !== accountEpoch) return
    syncLocalAutomationSettings()
    syncLocalOfflineSettings()
    strategyDraft.rebase()
    automationDraft.rebase()
  }
  finally { if (!disposed && epoch === accountEpoch) initializingEditor.value = false }
}
watch(currentAccountId, () => { void initializeAccountEditor() }, { flush: 'sync' })

onMounted(async () => {
  await fetchAccounts()
  if (disposed) return
  await Promise.all([fetchDeviceProtocol(), fetchOfflineSettings()])
  if (disposed) return
  selectFirstAccountIfNeeded()
  if (!initializingEditor.value) await initializeAccountEditor()
  await scrollActiveTabIntoView()
})
</script>

<template>
  <div class="settings-page">
    <header class="ui-page-heading">
      <div><h1 class="ui-page-title">设置</h1><p class="ui-page-subtitle">按账号调整策略与自动控制，修改后手动保存。</p></div>
    </header>

    <div class="ui-card overflow-hidden">
      <div class="settings-tab-header">
        <nav ref="settingsTabsNav" v-sliding-tabs class="ui-tabs settings-tabs" role="tablist" aria-label="设置分类">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            :data-settings-tab="tab.key"
            :id="`${settingsId}-${tab.key}`" role="tab" class="ui-tab settings-tab"
            :data-active="selectedSettingsTab === tab.key" :aria-selected="selectedSettingsTab === tab.key"
            :aria-controls="`${settingsId}-panel`" :tabindex="selectedSettingsTab === tab.key ? 0 : -1"
            @click="changeSettingsTab(tab.key)"
            @keydown="onSettingsTabKeydown($event, tab.key)"
          >
            <div :class="tab.icon" />
            {{ tab.label }}
          </button>
        </nav>
      </div>

      <div :id="`${settingsId}-panel`" ref="settingsContent" class="tab-motion-viewport" role="tabpanel" :aria-labelledby="`${settingsId}-${activeTab}`">
        <div class="settings-panel" data-motion-entry>
        <p v-if="settingStore.readError && currentAccountId && (activeTab === 'strategy' || activeTab === 'automation')" class="ui-notice" role="status">{{ settingStore.readError }}；未确认的设置不能保存。</p>
        <p v-if="unsaved.length && !currentDraft" class="ui-notice" role="status">有未保存修改：{{ unsaved.map(item => item.label).join('、') }}。切换账号或离开前会提醒，不自动保存。</p>
        <fieldset class="settings-account-editors" :disabled="anySaving">
        <!-- 账号管理 -->
        <AccountSettingsTab
          v-if="activeTab === 'account'"
          :accounts="accounts"
          :accounts-loading="accountsLoading"
          :current-account-id="currentAccountId"
          :user-is-admin="userIsAdmin"
          :stopped-accounts-count="stoppedAccountsCount"
          :is-add-account-disabled="isAddAccountDisabled"
          :add-account-disabled-reason="addAccountDisabledReason"
          :is-account-ops-disabled="isAccountOpsDisabled"
          :show-modal="showModal"
          :editing-account="editingAccount"
          :show-delete-confirm="showDeleteConfirm"
          :delete-loading="deleteLoading"
          :account-to-delete="accountToDelete"
          :show-clear-stopped-confirm="showClearStoppedConfirm"
          :clear-stopped-loading="clearStoppedLoading"
          :refresh-wx-codes-loading="refreshWxCodesLoading"
          :default-plan-applying-id="defaultPlanApplyingId"
          :default-plan-unknown="defaultPlanUnknown"
          :account-read-error="LOCAL_UI_READONLY ? '' : accountStore.readError"
          :account-toggle-pending="accountTogglePending"
          :account-toggle-unknown="accountToggleUnknown"
          :status-snapshot="statusStore.status"
          :status-ready="statusStore.currentStatusReady"
          :status-stale="statusStore.currentStatusStale"
          @add="openAddModal"
          @clear-stopped="openClearStoppedConfirm"
          @refresh-wx-codes="refreshWxCodesNow"
          @select="selectAccount"
          @toggle="toggleAccount"
          @settings="openSettings"
          @apply-default-plan="applyDefaultPlan"
          @edit="openEditModal"
          @delete="handleDelete"
          @saved="handleSaved"
          @close-modal="showModal = false"
          @close-delete-confirm="showDeleteConfirm = false"
          @confirm-delete="confirmDelete"
          @close-clear-stopped-confirm="showClearStoppedConfirm = false"
          @confirm-clear-stopped="confirmClearStopped"
        />

        <StrategySettingsTab
          v-else-if="activeTab === 'strategy'"
          v-model:settings="localStrategySettings"
          :current-account-name="currentAccountName"
          :current-account-id="editorReady ? currentAccountId : ''"
          :loading="settingsLoading || initializingEditor"
          :saving="strategySaving"
          :planting-strategy-options="plantingStrategyOptions"
          :preferred-seed-options="preferredSeedOptions"
          :bag-fallback-strategy-options="bagFallbackStrategyOptions"
          :strategy-preview-label="strategyPreviewLabel"
          :bag-seeds="bagSeeds"
          :sorted-bag-seeds="sortedBagSeeds"
          :bag-seeds-loading="bagSeedsLoading"
          :bag-seeds-error="bagSeedsError"
          :automation="localAutomationSettings.automation"
          @reset-bag-seed-priority="resetBagSeedPriority"
          @move-bag-seed="moveBagSeed"
          @remove-bag-seed="removeBagSeedPriority"
          @start-bag-seed-drag="startBagSeedDrag"
          @drag-over-bag-seed="dragOverBagSeed"
          @drop-bag-seed="dropBagSeed"
          :show-save="false"
          @save="saveCurrentSettings"
        />

        <!-- 自动控制 -->
        <AutomationSettingsTab
          v-else-if="activeTab === 'automation'"
          v-model:settings="localAutomationSettings"
          v-model:auto-code-refresh="localAutoCodeRefresh"
          :current-account-name="currentAccountName"
          :current-account-id="editorReady ? currentAccountId : ''"
          :loading="settingsLoading || initializingEditor"
          :saving="automationSaving"
          :auto-code-refreshing="autoCodeRefreshing"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @run-auto-code-refresh="runAutoCodeRefreshNow"
          :show-save="false"
          @save="saveCurrentSettings"
        />

        <DefaultPlanSettingsTab
          v-else-if="activeTab === 'default-plan'"
          :current-account-id="currentAccountId"
          :current-account-name="currentAccountName"
          :planting-strategy-options="plantingStrategyOptions"
          :preferred-seed-options="preferredSeedOptions"
          :bag-fallback-strategy-options="bagFallbackStrategyOptions"
          :bag-seeds="bagSeeds"
          :bag-seeds-loading="bagSeedsLoading"
          :bag-seeds-error="bagSeedsError"
          :fertilizer-land-type-options="fertilizerLandTypeOptions"
          :fertilizer-options="fertilizerOptions"
          @notify="showAlert"
        />

        <UserSettingsTab
          v-else-if="activeTab === 'user'"
          v-model:device-protocol-form="deviceProtocolForm"
          v-model:selected-device-preset="selectedDevicePreset"
          v-model:password-form="passwordForm"
          v-model:offline-config="localOffline"
          :device-protocol-loading="deviceProtocolLoading"
          :device-protocol-saving="deviceProtocolSaving"
          :device-protocol-ready="deviceProtocolReady"
          :offline-ready="offlineReady"
          :device-protocol-read-error="deviceProtocolReadError"
          :offline-read-error="offlineReadError"
          :user-mutation-states="userMutationStates"
          :user-mutation-errors="userMutationErrors"
          @read-device-protocol="fetchDeviceProtocol"
          @read-offline="fetchOfflineSettings"
          :device-protocol-preset-options="deviceProtocolPresetOptions"
          :password-saving="passwordSaving"
          :channel-options="channelOptions"
          :current-channel-doc-url="currentChannelDocUrl"
          :offline-saving="offlineSaving"
          :offline-testing="offlineTesting"
          @apply-device-preset="applyDevicePreset"
          @random-mac="fillRandomDeviceMac"
          @random-device-id="fillRandomDeviceId"
          @random-imei="fillRandomImei"
          @save-device-protocol="handleSaveDeviceProtocol"
          @change-password="handleChangePassword"
          @open-docs="openChannelDocs"
          @test-offline="handleTestOffline"
          @save-offline="handleSaveOffline"
        />
        </fieldset>
        </div>
      </div>
    </div>

    <div v-if="currentDraft && currentAccountId" class="settings-savebar" aria-label="设置保存">
      <div><strong>{{ anySaving ? '正在保存，等待服务器确认' : saveUnknown ? '保存结果未确认' : currentDraftDirty ? '有未保存修改' : '当前无待保存修改' }}</strong><p>{{ saveUnknown ? '先读取核对，不重复提交。' : LOCAL_UI_READONLY ? '本地只读浏览，不能保存或改变账号设置。' : '仅保存当前设置页；不会自动保存。' }}</p></div>
      <div class="settings-savebar-actions">
        <BaseButton v-if="saveUnknown" variant="outline" :disabled="anySaving || LOCAL_UI_READONLY" @click="reloadUnknownSettings">读取核对</BaseButton>
        <BaseButton v-else variant="outline" :disabled="anySaving || !currentDraftDirty" @click="currentDraft.reset()">放弃修改</BaseButton>
        <BaseButton variant="primary" :loading="anySaving" :disabled="LOCAL_UI_READONLY || !currentDraftDirty || !editorReady || saveUnknown" @click="saveCurrentSettings">{{ activeTab === 'strategy' ? '保存策略设置' : '保存自动控制' }}</BaseButton>
      </div>
    </div>
    <ConfirmModal :show="leaveVisible" title="保留未保存修改？" :message="leaveMessage" type="danger" confirm-text="放弃修改并继续" cancel-text="留在当前页面"
      @confirm="finishDiscard(true)" @cancel="finishDiscard(false)" @close="finishDiscard(false)" />

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @close="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>

<style scoped>
.settings-page { min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.settings-tab-header { border-bottom: 1px solid var(--surface-border); }
.settings-tabs { padding: 8px; overflow-x: auto; flex-wrap: nowrap; border: 0; border-radius: 0; }
.settings-tab { flex-shrink: 0; white-space: nowrap; }
.settings-panel { padding: 20px; }
.settings-account-editors { margin: 0; min-width: 0; padding: 0; border: 0; }
.settings-savebar { position: sticky; bottom: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-card); background: var(--surface-1); color: var(--theme-text); box-shadow: var(--surface-shadow); }
.settings-savebar strong { font-size: 14px; }
.settings-savebar p { margin: 5px 0 0; color: var(--muted-text); font-size: 12px; line-height: 1.6; }
.settings-savebar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 640px) { .settings-panel { padding: 14px; } .settings-savebar { padding: 12px; } .settings-savebar-actions { width: 100%; } .settings-savebar-actions > * { flex: 1; } }
</style>
