import { storeToRefs } from 'pinia'
import { computed, inject, onScopeDispose, ref, watch } from 'vue'
import api from '@/api'
import { useSettingStore } from '@/stores/setting'
import { useUserStore } from '@/stores/user'
import { copySettings, createSettingsDraft, SETTINGS_DRAFT_REGISTRY, settingsFingerprint } from '@/composables/settings/useSettingsDraft'
import type { SettingsDraftRegistry } from '@/composables/settings/useSettingsDraft'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

interface DeviceProtocolConfig {
  enabled: boolean
  userAgent: string
  deviceModel: string
  deviceBrand: string
  deviceMac: string
  deviceId: string
  imei: string
}

type AlertType = 'primary' | 'danger'

const DEFAULT_DEVICE_PROTOCOL: DeviceProtocolConfig = {
  enabled: false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
  deviceModel: 'iPhone 15 Pro Max',
  deviceBrand: 'Apple',
  deviceMac: '',
  deviceId: '',
  imei: '',
}

const DEVICE_PROTOCOL_PRESETS = [
  {
    label: 'iPhone 17',
    value: 'iphone_17',
    config: {
      userAgent: '',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17',
    },
  },
  {
    label: 'iPhone 17 Pro',
    value: 'iphone_17_pro',
    config: {
      userAgent: '',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17 Pro',
    },
  },
  {
    label: 'iPhone 15 Pro Max',
    value: 'iphone_15_pm',
    config: {
      userAgent: DEFAULT_DEVICE_PROTOCOL.userAgent,
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 15 Pro Max',
    },
  },
  {
    label: 'Huawei Mate 60 Pro',
    value: 'mate_60_pro',
    config: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; HUAWEI Mate 60 Pro Build/HUAWEIMate60Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560(0x28002F39) NetType/WIFI Language/zh_CN',
      deviceBrand: 'Huawei',
      deviceModel: 'Mate 60 Pro',
    },
  },
  {
    label: 'Xiaomi 14 Ultra',
    value: 'xiaomi_14_ultra',
    config: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; 24031PN0DC Build/UKQ1.231003.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560(0x28002F39) NetType/WIFI Language/zh_CN',
      deviceBrand: 'Xiaomi',
      deviceModel: 'Xiaomi 14 Ultra',
    },
  },
] as const

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/group/custom-robot-access',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
}

export function useUserSettings(showAlert: (message: string, type?: AlertType) => void, draftRegistry?: SettingsDraftRegistry) {
  const userStore = useUserStore()
  const settingStore = useSettingStore()
  const { settings } = storeToRefs(settingStore)

  const passwordSaving = ref(false)
  const offlineSaving = ref(false)
  const offlineTesting = ref(false)
  const deviceProtocolLoading = ref(false)
  const deviceProtocolSaving = ref(false)
  const deviceProtocolReadError = ref('')
  const offlineReadError = ref('')
  const userMutationStates = computed(() => settingStore.userMutationStates)
  const userMutationErrors = computed(() => settingStore.userMutationErrors)
  let disposed = false

  const passwordForm = ref({
    old: '',
    new: '',
    confirm: '',
  })

  const deviceProtocolPresetOptions = computed(() =>
    DEVICE_PROTOCOL_PRESETS.map(item => ({ label: item.label, value: item.value })),
  )

  const selectedDevicePreset = ref('')
  const deviceProtocolForm = ref<DeviceProtocolConfig>({ ...DEFAULT_DEVICE_PROTOCOL })

  const localOffline = ref({
    channel: 'smtp',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '',
    msg: '',
    offlineDeleteSec: 0,
    smtpHost: '',
    smtpPort: 465,
    smtpUser: '',
    smtpPass: '',
    senderName: '',
    recipientEmail: '',
    emailContent: '',
  })

  const deviceDraft = createSettingsDraft(() => deviceProtocolForm.value, value => { deviceProtocolForm.value = value })
  const offlineDraft = createSettingsDraft(() => localOffline.value, value => { localOffline.value = value })
  const passwordDraft = createSettingsDraft(() => passwordForm.value, value => { passwordForm.value = value })
  passwordDraft.rebase()
  // Vue inject reads ancestors, not provide() on this same Settings instance.
  const registry = draftRegistry || inject(SETTINGS_DRAFT_REGISTRY, null)
  const unregister = [
    registry?.register('device-protocol', { label: '设备协议', scope: 'user', dirty: () => deviceDraft.dirty.value, saving: () => deviceProtocolSaving.value, reset: deviceDraft.reset }),
    registry?.register('offline-reminder', { label: '下线提醒', scope: 'user', dirty: () => offlineDraft.dirty.value, saving: () => offlineSaving.value, reset: offlineDraft.reset }),
    registry?.register('password', { label: '密码输入', scope: 'user', dirty: () => passwordDraft.dirty.value, saving: () => passwordSaving.value, reset: passwordDraft.reset }),
  ]
  onScopeDispose(() => {
    disposed = true
    unregister.forEach(remove => remove?.())
    deviceDraft.clear(); offlineDraft.clear(); passwordDraft.clear()
    passwordForm.value = { old: '', new: '', confirm: '' }
    localOffline.value.smtpPass = ''; localOffline.value.token = ''
  })

  const channelOptions = [
    { label: 'SMTP 邮件', value: 'smtp' },
    { label: 'Webhook(自定义接口)', value: 'webhook' },
    { label: 'Qmsg 酱', value: 'qmsg' },
    { label: 'Server 酱', value: 'serverchan' },
    { label: 'Push Plus', value: 'pushplus' },
    { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
    { label: '钉钉', value: 'dingtalk' },
    { label: '企业微信', value: 'wecom' },
    { label: 'Bark', value: 'bark' },
    { label: 'Go-cqhttp', value: 'gocqhttp' },
    { label: 'OneBot', value: 'onebot' },
    { label: 'Atri', value: 'atri' },
    { label: 'PushDeer', value: 'pushdeer' },
    { label: 'iGot', value: 'igot' },
    { label: 'Telegram', value: 'telegram' },
    { label: '飞书', value: 'feishu' },
    { label: 'IFTTT', value: 'ifttt' },
    { label: '企业微信群机器人', value: 'wecombot' },
    { label: 'Discord', value: 'discord' },
    { label: 'WxPusher', value: 'wxpusher' },
  ]

  const reloginUrlModeOptions = [
    { label: '不附带', value: 'none' },
    { label: 'QQ 直链', value: 'qq_link' },
    { label: '二维码链接', value: 'qr_link' },
  ]

  const currentChannelDocUrl = computed(() => {
    const key = String(localOffline.value.channel || '').trim().toLowerCase()
    return CHANNEL_DOCS[key] || ''
  })

  function openChannelDocs() {
    const url = currentChannelDocUrl.value
    if (!url)
      return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  function applyDeviceProtocolConfig(config?: Partial<DeviceProtocolConfig>) {
    deviceProtocolForm.value = {
      ...DEFAULT_DEVICE_PROTOCOL,
      ...config,
      enabled: config?.enabled === true,
    }
  }

  function randomDigits(length: number) {
    let result = ''
    while (result.length < length) {
      const bytes = crypto.getRandomValues(new Uint8Array(length - result.length))
      for (const byte of bytes) {
        // Discard the upper six values so modulo 10 remains unbiased.
        if (byte < 250)
          result += String(byte % 10)
      }
    }
    return result
  }

  function formatHexByte(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase()
  }

  function generateRandomMac() {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    // Locally administered (bit 1), unicast (bit 0 cleared): no real vendor OUI.
    bytes[0] = ((bytes[0] ?? 0) & 0xFC) | 0x02
    return Array.from(bytes, formatHexByte).join(':')
  }

  function generateRandomDeviceId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    return Array.from(bytes, formatHexByte).join('')
  }

  function generateRandomImei() {
    const digits = randomDigits(14).split('').map(Number)
    let sum = 0
    digits.forEach((digit, index) => {
      const value = index % 2 === 1 ? digit * 2 : digit
      sum += value > 9 ? value - 9 : value
    })
    const checkDigit = (10 - (sum % 10)) % 10
    return `${digits.join('')}${checkDigit}`
  }

  function fillRandomDeviceMac() {
    deviceProtocolForm.value.deviceMac = generateRandomMac()
  }

  function fillRandomDeviceId() {
    deviceProtocolForm.value.deviceId = generateRandomDeviceId()
  }

  function fillRandomImei() {
    deviceProtocolForm.value.imei = generateRandomImei()
  }

  function applyDevicePreset(value: string | number | undefined) {
    if (value === undefined)
      return
    const preset = DEVICE_PROTOCOL_PRESETS.find(item => item.value === value)
    if (!preset)
      return
    deviceProtocolForm.value.userAgent = preset.config.userAgent
    deviceProtocolForm.value.deviceBrand = preset.config.deviceBrand
    deviceProtocolForm.value.deviceModel = preset.config.deviceModel
  }

  async function fetchDeviceProtocol() {
    if (LOCAL_UI_READONLY || disposed || deviceProtocolLoading.value) return false
    deviceProtocolLoading.value = true
    deviceProtocolReadError.value = ''
    try {
      const result = await settingStore.fetchUserConfig('device')
      if (disposed) return false
      if (!result.ok) { deviceProtocolReadError.value = result.error || '设备配置读取失败'; return false }
      const editing = deviceDraft.dirty.value
      if (!editing) applyDeviceProtocolConfig(result.config)
      deviceDraft.rebase(result.config)
      return true
    }
    finally { deviceProtocolLoading.value = false }
  }
  async function fetchOfflineSettings() {
    if (LOCAL_UI_READONLY || disposed) return false
    const result = await settingStore.fetchUserConfig('offline')
    if (disposed) return false
    if (!result.ok) { offlineReadError.value = result.error || '下线提醒读取失败'; return false }
    offlineReadError.value = ''
    if (!offlineDraft.dirty.value) localOffline.value = copySettings(result.config)
    offlineDraft.rebase(result.config)
    return true
  }

  async function handleSaveDeviceProtocol() {
    if (LOCAL_UI_READONLY || disposed || deviceProtocolSaving.value || !deviceDraft.ready.value || deviceProtocolReadError.value) return false
    const submitted = copySettings(deviceProtocolForm.value)
    const payload = Object.fromEntries(Object.entries(submitted).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]))
    deviceProtocolSaving.value = true
    try {
      const result = await settingStore.saveUserConfig('device', () => api.post('/api/user/device-protocol', payload), payload, deviceDraft.confirmed())
      if (disposed) return false
      if (result.ok) {
        if (settingsFingerprint(deviceProtocolForm.value) === settingsFingerprint(submitted)) applyDeviceProtocolConfig(result.config)
        deviceDraft.rebase(result.config)
        showAlert('设备协议配置已读回确认', 'primary')
      }
      else showAlert(result.error || '保存结果未确认', 'danger')
      return result.ok === true
    }
    finally { deviceProtocolSaving.value = false }
  }

  function syncLocalOfflineSettings() {
    if (settingStore.settingsAccountId && settings.value?.offlineReminder && !offlineDraft.dirty.value) {
      localOffline.value = copySettings(settings.value.offlineReminder)
      offlineDraft.rebase()
    }
  }

  watch(settings, () => {
    syncLocalOfflineSettings()
  }, { deep: true })

  async function handleChangePassword() {
    if (LOCAL_UI_READONLY || disposed || passwordSaving.value || settingStore.userMutationStates.password === 'unknown') return false
    if (!passwordForm.value.old || !passwordForm.value.new) {
      showAlert('请填写完整', 'danger')
      return
    }
    if (passwordForm.value.new !== passwordForm.value.confirm) {
      showAlert('两次密码输入不一致', 'danger')
      return
    }
    if (passwordForm.value.new.length < 4) {
      showAlert('密码长度至少4位', 'danger')
      return
    }

    const submitted = copySettings(passwordForm.value)
    passwordSaving.value = true
    try {
      const res = await settingStore.sendUserAction('password', () => api.post('/api/user/change-password', { oldPassword: submitted.old, newPassword: submitted.new }))
      if (disposed) return false
      if (res.ok) {
        showAlert('密码修改成功，请重新登录', 'primary')
        passwordForm.value = { old: '', new: '', confirm: '' }
        passwordDraft.rebase()
        setTimeout(() => {
          userStore.logout()
          window.location.href = '/login'
        }, 1500)
      }
      else {
        showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
      }
    }
    finally {
      passwordSaving.value = false
    }
  }

  async function handleSaveOffline() {
    if (LOCAL_UI_READONLY || disposed || offlineSaving.value || offlineTesting.value || !offlineDraft.ready.value) return false
    // Enabling automatic deletion is a separate destructive capability. This
    // frontend improvement never supplies its confirmation implicitly.
    if (Number(localOffline.value.offlineDeleteSec) > 0 && Number(offlineDraft.confirmed()?.offlineDeleteSec || 0) <= 0) {
      showAlert('启用离线自动删除需要单独确认；本次不会自动提交该危险设置。', 'danger'); return false
    }
    const submitted = copySettings(localOffline.value)
    offlineSaving.value = true
    try {
      const res = await settingStore.saveOfflineConfig(submitted)
      if (disposed) return false
      if (res.ok) {
        if (settingsFingerprint(localOffline.value) === settingsFingerprint(submitted)) localOffline.value = copySettings(res.config)
        offlineDraft.rebase(res.config)
        showAlert('下线提醒设置已读回确认', 'primary')
      }
      else showAlert(res.error || '保存结果未确认', 'danger')
      return res.ok === true
    }
    finally { offlineSaving.value = false }
  }

  async function handleTestOffline() {
    if (LOCAL_UI_READONLY || disposed || offlineTesting.value || offlineSaving.value) return
    const submitted = copySettings(localOffline.value)
    offlineTesting.value = true
    try {
      const result = await settingStore.sendUserAction('notification', () => api.post('/api/settings/offline-reminder/test', submitted))
      if (disposed) return
      showAlert(result.ok ? '测试通知请求已受理；是否收到请在接收端确认。' : result.error || '测试通知结果未确认', result.ok ? 'primary' : 'danger')
    }
    finally { offlineTesting.value = false }
  }

  return {
    passwordSaving,
    offlineSaving,
    offlineTesting,
    deviceProtocolLoading,
    deviceProtocolSaving,
    deviceProtocolReadError,
    offlineReadError,
    deviceProtocolReady: deviceDraft.ready,
    offlineReady: offlineDraft.ready,
    userMutationStates,
    userMutationErrors,
    passwordForm,
    deviceProtocolPresetOptions,
    selectedDevicePreset,
    deviceProtocolForm,
    localOffline,
    channelOptions,
    reloginUrlModeOptions,
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
  }
}
