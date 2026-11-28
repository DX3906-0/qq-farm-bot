<script setup lang="ts">
import DeviceProtocolCard from '@/components/settings/DeviceProtocolCard.vue'
import OfflineReminderCard from '@/components/settings/OfflineReminderCard.vue'
import PasswordChangeCard from '@/components/settings/PasswordChangeCard.vue'
import { ref } from 'vue'
import { isRequestDiagnosticsEnabled, setRequestDiagnosticsEnabled } from '@/utils/requestMonitor'
const diagnosticsEnabled = ref(isRequestDiagnosticsEnabled())
function toggleDiagnostics() {
  diagnosticsEnabled.value = !diagnosticsEnabled.value
  setRequestDiagnosticsEnabled(diagnosticsEnabled.value)
}

interface SelectOption<T = string | number> {
  label: string
  value: T
}

interface DeviceProtocolConfig {
  enabled: boolean
  userAgent: string
  deviceModel: string
  deviceBrand: string
  deviceMac: string
  deviceId: string
  imei: string
}

interface PasswordForm {
  old: string
  new: string
  confirm: string
}

interface OfflineReminderConfig {
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

defineProps<{
  deviceProtocolLoading: boolean
  deviceProtocolSaving: boolean
  deviceProtocolReady?: boolean
  offlineReady?: boolean
  deviceProtocolReadError?: string
  offlineReadError?: string
  userMutationStates?: Record<string, string>
  userMutationErrors?: Record<string, string>
  deviceProtocolPresetOptions: SelectOption[]
  passwordSaving: boolean
  channelOptions: SelectOption[]
  currentChannelDocUrl: string
  offlineSaving: boolean
  offlineTesting: boolean
}>()

const emit = defineEmits<{
  applyDevicePreset: [value: string | number | undefined]
  randomMac: []
  randomDeviceId: []
  randomImei: []
  saveDeviceProtocol: []
  changePassword: []
  openDocs: []
  testOffline: []
  saveOffline: []
  readDeviceProtocol: []
  readOffline: []
}>()

const deviceProtocolForm = defineModel<DeviceProtocolConfig>('deviceProtocolForm', { required: true })
const selectedDevicePreset = defineModel<string>('selectedDevicePreset', { required: true })
const passwordForm = defineModel<PasswordForm>('passwordForm', { required: true })
const offlineConfig = defineModel<OfflineReminderConfig>('offlineConfig', { required: true })
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
      用户管理
    </h3>

    <div class="space-y-4">
      <section class="ui-card p-4 sm:p-5" aria-label="本地诊断">
        <div class="flex items-center justify-between gap-4">
          <div><h4 class="m-0 text-sm font-semibold">请求诊断角标</h4><p class="diagnostics-caption">默认隐藏，仅排查时开启；不发起额外请求，不影响游戏操作。</p></div>
          <button type="button" role="switch" :aria-checked="diagnosticsEnabled" aria-label="请求诊断角标" class="diagnostics-toggle" :data-enabled="diagnosticsEnabled" @click="toggleDiagnostics">{{ diagnosticsEnabled ? '已开启' : '已关闭' }}</button>
        </div>
      </section>
      <DeviceProtocolCard
        v-model:form="deviceProtocolForm"
        v-model:selected-preset="selectedDevicePreset"
        :loading="deviceProtocolLoading"
        :saving="deviceProtocolSaving"
        :ready="deviceProtocolReady"
        :read-error="deviceProtocolReadError"
        :unknown="userMutationStates?.device === 'unknown'"
        :mutation-error="userMutationErrors?.device"
        @read="emit('readDeviceProtocol')"
        :preset-options="deviceProtocolPresetOptions"
        @apply-preset="value => emit('applyDevicePreset', value)"
        @random-mac="emit('randomMac')"
        @random-device-id="emit('randomDeviceId')"
        @random-imei="emit('randomImei')"
        @save="emit('saveDeviceProtocol')"
      />

      <PasswordChangeCard
        v-model:form="passwordForm"
        :saving="passwordSaving"
        :unknown="userMutationStates?.password === 'unknown'"
        :mutation-error="userMutationErrors?.password"
        @save="emit('changePassword')"
      />

      <OfflineReminderCard
        v-model:config="offlineConfig"
        :channel-options="channelOptions"
        :current-channel-doc-url="currentChannelDocUrl"
        :saving="offlineSaving"
        :testing="offlineTesting"
        :ready="offlineReady"
        :read-error="offlineReadError"
        :unknown="userMutationStates?.offline === 'unknown'"
        :test-unknown="userMutationStates?.notification === 'unknown'"
        :mutation-error="userMutationErrors?.offline || userMutationErrors?.notification"
        @read="emit('readOffline')"
        @open-docs="emit('openDocs')"
        @test="emit('testOffline')"
        @save="emit('saveOffline')"
      />
    </div>
  </div>
</template>

<style scoped>
.diagnostics-caption { margin: 6px 0 0; color: var(--muted-text); font-size: 12px; line-height: 1.7; }
.diagnostics-toggle { flex-shrink: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control); background: var(--surface-2); color: var(--theme-text); font-size: 12px; cursor: pointer; }
.diagnostics-toggle[data-enabled='true'] { background: var(--action-bg); color: var(--action-text); border-color: transparent; }
</style>
