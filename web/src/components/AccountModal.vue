<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useWxLoginStore } from '@/stores/wx-login'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const CODE_QUERY_RE = /[?&]code=([^&]+)/i
const QR_AUTO_REFRESH_MS = 110_000
const QQ_QR_AUTO_REFRESH_MS = 100_000
const CAPTURE_SUCCESS_STORAGE_KEY = 'capture_login_succeeded'

const wxLoginStore = useWxLoginStore()

interface CaptureFlowState {
  id: string
  platform: 'qq' | 'wx'
  codeCaptured: boolean
  accountGid: string
  friendCount: number
  captureStatus: string
  proxy: {
    running: boolean
    status: string
    error: string
  }
  publicInfo: {
    host: string
    addresses: { address: string, kind: string }[]
    mitmPort: number
    remainingSec: number
    certificateUrl: string
  }
}

const activeTab = ref<'qq' | 'wx' | 'capture' | 'manual'>('manual')
const loading = ref(false)
const wxChecking = ref(false)
const errorMessage = ref('')
const wxAccountName = ref('')
const captureEnabled = ref(false)
const captureLoading = ref(false)
const captureChecking = ref(false)
const captureCompleting = ref(false)
const captureError = ref('')
const captureCopiedField = ref<'host' | 'port' | ''>('')
const captureAccountName = ref('')
const capturePlatform = ref<'qq' | 'wx'>('qq')
const showCaptureHelp = ref(false)
const captureHelpMode = ref<'first' | 'daily'>('first')
const captureHelpDevice = ref<'ios' | 'android' | 'pc'>('ios')
const captureFlow = ref<CaptureFlowState | null>(null)
const captureDeviceMode = ref<'pc' | 'phone'>('phone')

// ---- QQ 扫码登录 ----
// 契约仍是 /api/qr/create + /api/qr/check，但服务端已改为「NapCat 中转」：
// 任务由运行 NapCat 的那台电脑上的补码守护轮询领取并出码，服务器只做中转。
// 因此本机守护不在线时 create 会明确报错（会直接显示在 qqError 上）。
const qqAccountName = ref('')
const qqLoginCode = ref('')
const qqQrImage = ref('')
const qqStatus = ref('点击获取二维码')
const qqError = ref('')
const qqLoading = ref(false)
const qqChecking = ref(false)
const qqQrCreatedAt = ref(0)
const qqGuardOnline = ref(true)

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

const capturePcHelpSteps = computed(() => captureHelpMode.value === 'first'
  ? [
      '点击开始抓取，系统代理自动设置，无需手动操作',
      '打开 CA 证书，在 Windows 中双击安装到"受信任的根证书颁发机构"',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '彻底关闭后重新打开 PC 端 QQ 农场',
      'Code 获取后账号会立即添加；QQ 好友 GID 将在后台继续同步',
      'QQ 农场保持打开，完整好友列表同步后会自动释放代理并恢复原始代理设置',
    ]
  : [
      '点击开始抓取，系统代理自动设置',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '重新打开 PC 端 QQ 农场，并保持页面打开',
      '账号添加后，QQ 农场继续保持打开，最迟约 15 秒完成后台同步',
      '后台同步结束后，系统代理自动恢复',
    ])

const capturePhoneHelpSteps = computed(() => captureHelpMode.value === 'first'
  ? [
      '点击开始抓取，获取本次代理地址和端口',
      '打开 CA 证书，并在手机系统中安装和信任',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '将手机 Wi-Fi 代理设置为页面显示的地址和端口',
      '彻底关闭后重新打开对应的 QQ 或微信农场',
      'Code 获取后账号会立即添加；QQ 好友 GID 将在后台继续同步',
      'QQ 农场保持打开，完整好友列表同步后会立即释放代理，最迟约 15 秒',
    ]
  : [
      '点击开始抓取，确认本次代理地址和端口',
      '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
      '将手机 Wi-Fi 代理更新为本次显示的地址和端口',
      '重新打开对应农场，并保持页面打开',
      '账号添加后，QQ 农场继续保持打开，最迟约 15 秒完成后台同步',
      '后台同步结束后，将手机 Wi-Fi 代理改回关闭',
    ])

const captureHelpSteps = computed(() => captureDeviceMode.value === 'pc'
  ? capturePcHelpSteps.value
  : capturePhoneHelpSteps.value)

const captureDeviceSteps = computed(() => {
  if (captureDeviceMode.value === 'pc') {
    return [
      '点击"打开证书"下载 .cer 文件',
      '双击证书文件，选择"本地计算机" → 下一步',
      '选择"将所有证书放入下列存储" → 浏览 → "受信任的根证书颁发机构"',
      '完成导入，确认安全警告',
    ]
  }
  return captureHelpDevice.value === 'ios'
    ? [
        '在 Safari 中点击"打开证书"并允许下载描述文件',
        '进入"设置 → 通用 → VPN 与设备管理"安装描述文件',
        '进入"设置 → 通用 → 关于本机 → 证书信任设置"启用完全信任',
      ]
    : [
        '点击"打开证书"下载 CA 文件',
        '进入系统安全设置中的"安装证书"或"凭据存储"',
        '选择 CA 证书并确认安装；不同品牌的菜单名称可能不同',
      ]
})

const captureCurrentStep = computed(() => {
  if (!captureFlow.value)
    return '开始新的抓取任务'
  if (!captureFlow.value.codeCaptured) {
    const target = captureFlow.value.platform === 'qq' ? ' QQ' : '微信'
    return captureDeviceMode.value === 'pc'
      ? `系统代理已自动设置，请打开${target}农场`
      : `设置 Wi-Fi 代理并打开${target}农场`
  }
  return '已获取 Code，正在立即完成账号操作'
})

const captureNextStep = computed(() => {
  if (!captureFlow.value) {
    return captureDeviceMode.value === 'pc'
      ? '开始后系统代理自动配置，直接打开 PC 端 QQ 农场即可'
      : '开始后按本次显示的代理信息设置手机 Wi-Fi'
  }
  if (!captureFlow.value.codeCaptured)
    return '重新打开小程序，并保持农场页面打开'
  if (captureFlow.value.platform === 'qq')
    return `即将自动${props.editData ? '更新' : '添加'}账号，好友 GID 将在后台同步`
  return `即将自动${props.editData ? '更新' : '添加'}账号`
})

const { pause: stopWxCheck, resume: startWxCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'wx' || wxLoginStore.isLoading || wxChecking.value)
    return
  if (shouldRefreshWxQr()) {
    await loadWxQRCode()
    return
  }
  if (wxLoginStore.status !== 'qr_ready' && wxLoginStore.status !== 'confirming')
    return

  wxChecking.value = true
  try {
    const result = await wxLoginStore.checkLogin()
    if (result.success && result.wxid) {
      stopWxCheck()
      const codeResult = await wxLoginStore.getFarmCode(result.wxid)
      if (codeResult.success && codeResult.code) {
        const name = wxAccountName.value.trim() || result.nickname || `微信账号${Date.now()}`
        if (wxLoginStore.config.autoAddAccount) {
          await addAccount({
            id: props.editData?.id,
            name: props.editData ? (props.editData.name || name) : name,
            code: codeResult.code,
            platform: 'wx',
            loginType: 'wx_qr',
            wxid: result.wxid,
            avatar: result.avatar,
          })
        }
        else {
          form.code = codeResult.code
          form.platform = 'wx'
          activeTab.value = 'manual'
        }
      }
    }
  }
  finally {
    wxChecking.value = false
  }
}, 2000, { immediate: false })

// ---- QQ 扫码登录 ----
async function loadQqGuardStatus() {
  try {
    const { data } = await api.get('/api/qr/guard-status', { skipErrorToast: true } as any)
    qqGuardOnline.value = Boolean(data?.data?.enabled && data?.data?.online)
  }
  catch {
    qqGuardOnline.value = false
  }
}

function resetQq() {
  stopQqCheck()
  qqLoginCode.value = ''
  qqQrImage.value = ''
  qqQrCreatedAt.value = 0
  qqStatus.value = '点击获取二维码'
  qqError.value = ''
  qqLoading.value = false
  qqChecking.value = false
}

async function loadQqQrCode() {
  if (activeTab.value !== 'qq' || qqLoading.value)
    return
  stopQqCheck()
  qqLoading.value = true
  qqError.value = ''
  // 保留旧图直到新图返回，避免高度跳动闪屏
  qqStatus.value = '正在获取二维码…'
  try {
    const { data } = await api.post('/api/qr/create', {}, { timeout: 30000, skipErrorToast: true } as any)
    if (!data?.ok || !data.data?.code)
      throw new Error(data?.error || '获取二维码失败')
    qqLoginCode.value = data.data.code
    qqQrImage.value = data.data.image || ''
    qqQrCreatedAt.value = Date.now()
    qqStatus.value = '请使用 QQ 扫码并确认登录'
    startQqCheck()
  }
  catch (e: any) {
    qqLoginCode.value = ''
    qqQrImage.value = ''
    qqQrCreatedAt.value = 0
    qqStatus.value = '点击获取二维码'
    qqError.value = e.response?.data?.error || e.message || '获取二维码失败'
  }
  finally {
    qqLoading.value = false
  }
}

const { pause: stopQqCheck, resume: startQqCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'qq' || !qqLoginCode.value || qqLoading.value || qqChecking.value)
    return
  if (qqQrCreatedAt.value && Date.now() - qqQrCreatedAt.value >= QQ_QR_AUTO_REFRESH_MS) {
    await loadQqQrCode()
    return
  }
  qqChecking.value = true
  try {
    const { data } = await api.post('/api/qr/check', { code: qqLoginCode.value }, { timeout: 20000, skipErrorToast: true } as any)
    if (!data?.ok)
      throw new Error(data?.error || '查询扫码状态失败')
    const status = data.data?.status
    // 中转模式下二维码由本机守护异步产出，轮询期间同步刷新图，避免面板长时间空白
    if (data.data?.image && data.data.image !== qqQrImage.value) {
      qqQrImage.value = data.data.image
      qqQrCreatedAt.value = Date.now()
    }
    if (status === 'Wait') {
      qqStatus.value = '请使用 QQ 扫码并确认登录'
      return
    }
    if (status === 'Used') {
      await loadQqQrCode()
      return
    }
    if (status === 'OK') {
      stopQqCheck()
      qqLoading.value = true
      qqStatus.value = '已扫码，正在获取农场 Code…'
      if (!data.data?.code)
        throw new Error('未获取到农场 Code，请刷新二维码重试')
      const name = props.editData?.name
        || qqAccountName.value.trim()
        || data.data.nickname
        || `QQ账号${data.data.uin || Date.now()}`
      await addAccount({
        id: props.editData?.id,
        name,
        code: data.data.code,
        platform: 'qq',
        loginType: 'qq_qr',
        qq: data.data.uin || '',
        uin: data.data.uin || '',
        avatar: data.data.avatar || '',
      })
      return
    }
    throw new Error(data.data?.error || '二维码已失效，请刷新重试')
  }
  catch (e: any) {
    stopQqCheck()
    qqStatus.value = '二维码已失效，请刷新重试'
    qqError.value = e.response?.data?.error || e.message || 'QQ 扫码登录失败'
  }
  finally {
    qqChecking.value = false
  }
}, 2000, { immediate: false })

const { pause: stopCaptureCheck, resume: startCaptureCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'capture' || !captureFlow.value || captureCompleting.value || captureChecking.value)
    return
  captureChecking.value = true
  try {
    const { data } = await api.get(`/api/capture/sessions/${captureFlow.value.id}`, { timeout: 20000 })
    if (!data?.ok || !data.data)
      return
    captureFlow.value = data.data
    captureError.value = data.data.proxy?.error || ''
    if (data.data.codeCaptured)
      await completeCaptureAccount()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '查询抓取状态失败'
  }
  finally {
    captureChecking.value = false
  }
}, 1500, { immediate: false })

async function loadCaptureConfig() {
  try {
    const { data } = await api.get('/api/capture/config')
    captureEnabled.value = data?.ok && data.data?.enabled === true
  }
  catch {
    captureEnabled.value = false
  }
}

async function cancelCaptureSession() {
  stopCaptureCheck()
  const flowId = captureFlow.value?.id
  captureFlow.value = null
  if (flowId) {
    try {
      await api.delete(`/api/capture/sessions/${flowId}`)
    }
    catch {}
  }
}

async function startCaptureSession() {
  captureLoading.value = true
  captureError.value = ''
  await cancelCaptureSession()
  try {
    const { data } = await api.post('/api/capture/sessions', {
      platform: capturePlatform.value,
      accountId: props.editData?.id || '',
      deviceMode: captureDeviceMode.value,
    }, { timeout: 35000 })
    if (!data?.ok || !data.data)
      throw new Error(data?.error || '启动抓取失败')
    captureFlow.value = data.data
    startCaptureCheck()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '启动抓取失败'
  }
  finally {
    captureLoading.value = false
  }
}

async function completeCaptureAccount() {
  if (!captureFlow.value || captureCompleting.value)
    return
  captureCompleting.value = true
  captureError.value = ''
  try {
    const { data } = await api.post(`/api/capture/sessions/${captureFlow.value.id}/complete`, {
      name: captureAccountName.value.trim(),
    }, { timeout: 35000 })
    if (!data?.ok)
      throw new Error(data?.error || (props.editData ? '更新账号失败' : '添加账号失败'))
    localStorage.setItem(CAPTURE_SUCCESS_STORAGE_KEY, '1')
    stopCaptureCheck()
    captureFlow.value = null
    emit('saved')
    close()
  }
  catch (e: any) {
    if (e.response?.data?.code === 'DUPLICATE_CAPTURE_ACCOUNT') {
      stopCaptureCheck()
      captureFlow.value = null
    }
    captureError.value = e.response?.data?.error || e.message || (props.editData ? '更新账号失败' : '添加账号失败')
  }
  finally {
    captureCompleting.value = false
  }
}

function openCaptureHelp() {
  captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
  showCaptureHelp.value = true
}

async function copyCaptureValue(field: 'host' | 'port') {
  const host = captureDeviceMode.value === 'pc' ? '127.0.0.1' : (captureFlow.value?.publicInfo.host || '')
  const port = captureFlow.value?.publicInfo.mitmPort || 0
  if (!host || !port)
    return
  const value = field === 'host' ? host : String(port)
  try {
    let copied = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        copied = true
      }
      catch {}
    }
    if (!copied) {
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand('copy')
      textarea.remove()
    }
    if (!copied)
      throw new Error('copy failed')
    captureCopiedField.value = field
    setTimeout(() => {
      if (captureCopiedField.value === field)
        captureCopiedField.value = ''
    }, 1800)
  }
  catch {
    captureError.value = '复制失败，请手动填写代理地址和端口'
  }
}

function shouldRefreshWxQr() {
  return !!wxLoginStore.qrCreatedAt
    && (wxLoginStore.status === 'qr_ready' || wxLoginStore.status === 'confirming')
    && Date.now() - wxLoginStore.qrCreatedAt > QR_AUTO_REFRESH_MS
}

async function loadWxQRCode() {
  if (activeTab.value !== 'wx')
    return
  stopWxCheck()
  // 刷新二维码时不主动清空旧图：避免图片从无到有的高度跳动造成闪屏；新码返回后自然覆盖
  wxLoginStore.errorMessage = ''
  wxLoginStore.status = 'qr_loading'
  wxLoginStore.statusMessage = '正在获取二维码...'
  const success = await wxLoginStore.getQRCode()
  if (success)
    startWxCheck()
}

async function addAccount(data: any, _isRelogin = false) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入 Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(CODE_QUERY_RE)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  const payload: any = {
    name: form.name,
    code,
    platform: props.editData ? (props.editData.platform || 'qq') : form.platform,
    loginType: 'manual',
  }

  await addAccount(payload, !!props.editData)
}

const wxQrImageSrc = computed(() => {
  if (!wxLoginStore.qrCode)
    return ''
  if (wxLoginStore.qrCode.startsWith('data:'))
    return wxLoginStore.qrCode
  if (wxLoginStore.qrCode.startsWith('http'))
    return wxLoginStore.qrCode
  return `data:image/png;base64,${wxLoginStore.qrCode}`
})

function close() {
  stopWxCheck()
  stopCaptureCheck()
  resetQq()
  void cancelCaptureSession()
  wxLoginStore.resetState()
  showCaptureHelp.value = false
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    captureError.value = ''
    captureCopiedField.value = ''
    resetQq()
    captureAccountName.value = props.editData?.name || ''
    capturePlatform.value = props.editData?.platform === 'wx' ? 'wx' : 'qq'
    captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
    void loadCaptureConfig()
    if (props.editData) {
      activeTab.value = 'manual'
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
      wxAccountName.value = props.editData.name || ''
      qqAccountName.value = props.editData.name || ''
    }
    else {
      activeTab.value = 'manual'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
      wxAccountName.value = ''
      qqAccountName.value = ''
    }
  }
  else {
    stopWxCheck()
    stopCaptureCheck()
    resetQq()
    void cancelCaptureSession()
    wxLoginStore.resetState()
  }
})

watch(activeTab, (tab) => {
  if (tab === 'wx') {
    // 同一弹窗 session 内已有二维码则复用，避免重复加载造成闪屏；过期或没有才重新拉
    if (!wxLoginStore.qrCode || wxLoginStore.status === 'error' || wxLoginStore.status === 'idle') {
      loadWxQRCode()
    }
    else {
      startWxCheck()
    }
  }
  if (tab === 'qq') {
    void loadQqGuardStatus()
    if (!qqQrImage.value)
      void loadQqQrCode()
    else
      startQqCheck()
  }
  else {
    stopQqCheck()
  }
  if (tab !== 'capture')
    void cancelCaptureSession()
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <div class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'qq' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'qq' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'qq'"
          >
            QQ 扫码
          </button>
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            v-if="wxLoginStore.config.enabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'wx' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'wx' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'wx'"
          >
            微信扫码
          </button>
          <button
            v-if="captureEnabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'capture' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'capture' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'capture'"
          >
            抓包登录
          </button>
        </div>

        <div v-if="activeTab === 'qq'" class="space-y-4">
          <BaseInput
            v-model="qqAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用 QQ 昵称"
          />

          <div class="flex flex-col items-center justify-center py-4 space-y-4">
            <div
              v-if="qqQrImage"
              class="border rounded-lg bg-white p-2 transition-opacity"
              :class="qqLoading ? 'cursor-wait opacity-60' : 'cursor-pointer hover:opacity-80'"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)' }"
              title="点击刷新二维码"
              role="button"
              tabindex="0"
              @click="!qqLoading && loadQqQrCode()"
              @keydown.enter.prevent="!qqLoading && loadQqQrCode()"
              @keydown.space.prevent="!qqLoading && loadQqQrCode()"
            >
              <img :src="qqQrImage" class="h-48 w-48" alt="QQ 登录二维码">
            </div>
            <div
              v-else
              class="h-52 w-52 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-2 text-center"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)' }"
            >
              <div v-if="qqLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
              <i v-else class="i-carbon-qr-code text-3xl opacity-40" :style="{ color: 'var(--theme-text)' }" />
              <span class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                {{ qqLoading ? '正在获取二维码…' : '点击下方按钮获取二维码' }}
              </span>
            </div>

            <div class="h-10 text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              <p>{{ qqStatus }}</p>
              <p v-if="qqError" class="text-red-600">{{ qqError }}</p>
            </div>

            <BaseButton variant="secondary" size="sm" :loading="qqLoading" @click="loadQqQrCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用手机 QQ 扫描二维码并确认登录，成功后会自动获取 Code 并添加账号
          </div>
          <div class="text-center text-xs opacity-50" :style="{ color: 'var(--theme-text)' }">
            二维码由本机 NapCat 守护实时生成（需在运行 NapCat 的电脑上启动守护）
          </div>
          <div
            v-if="!qqGuardOnline"
            class="mt-3 rounded-md border px-3 py-2 text-xs leading-relaxed"
            :style="{
              borderColor: 'color-mix(in srgb, #f59e0b 40%, transparent)',
              background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
              color: 'var(--theme-text)',
            }"
          >
            ⚠️ 本机补码守护未在线，无法生成二维码。请在运行 NapCat 的电脑上启动
            <code>napcat-code-guard</code> 守护后，点击下方「刷新二维码」。
          </div>
        </div>

        <div v-if="activeTab === 'wx'" class="wx-qr-panel space-y-4">
          <BaseInput
            v-model="wxAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用微信昵称"
          />

          <div class="wx-qr-stage flex flex-col items-center justify-center py-4 space-y-4">
            <!-- 固定 208×208 的二维码舞台：加载/刷新时保持骨架占位，避免容器高度跳动导致闪屏 -->
            <div class="wx-qr-card grid h-52 w-52 place-items-center rounded-2xl border-2 border-dashed p-2">
              <img
                v-if="wxQrImageSrc"
                :src="wxQrImageSrc"
                class="h-48 w-48 rounded-xl object-contain"
                alt="微信登录二维码"
              >
              <div v-else class="flex flex-col items-center justify-center gap-2 text-center">
                <div v-if="wxLoginStore.isLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
                <i v-else class="i-carbon-qr-code text-3xl opacity-40" :style="{ color: 'var(--theme-text)' }" />
                <span class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                  {{ wxLoginStore.isLoading ? '正在获取二维码...' : '点击刷新二维码' }}
                </span>
              </div>
            </div>

            <!-- 状态文案固定两行高，避免文字变化时高度跳动 -->
            <div class="wx-status-line h-10 text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              <p>{{ wxLoginStore.statusMessage || '&nbsp;' }}</p>
              <p v-if="wxLoginStore.errorMessage" class="text-red-600">{{ wxLoginStore.errorMessage }}</p>
            </div>

            <BaseButton variant="secondary" size="sm" :loading="wxLoginStore.isLoading" @click="loadWxQRCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用微信扫描二维码登录，成功后会自动添加账号
          </div>
        </div>

        <div v-if="activeTab === 'capture'" class="space-y-4">
          <BaseInput
            v-model="captureAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
            :disabled="!!captureFlow"
          />

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" :style="{ color: 'var(--theme-text)' }">抓包设备</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureDeviceMode === 'pc' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureDeviceMode === 'pc' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="captureDeviceMode = 'pc'"
              >
                💻 PC 本地
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureDeviceMode === 'phone' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureDeviceMode === 'phone' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="captureDeviceMode = 'phone'"
              >
                📱 手机代理
              </button>
            </div>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" :style="{ color: 'var(--theme-text)' }">平台</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'qq' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'qq' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'qq'"
              >
                QQ 小程序
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'wx' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'wx' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'wx'"
              >
                微信小程序
              </button>
            </div>
          </div>

          <button
            v-if="!captureFlow"
            type="button"
            class="h-11 w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 text-left text-sm dark:border-gray-700"
            :style="{ color: 'var(--theme-text)' }"
            @click="openCaptureHelp"
          >
            <span class="flex items-center gap-2">
              <span class="i-carbon-help" :style="{ color: 'var(--theme-primary)' }" />
              使用说明
            </span>
            <span class="i-carbon-chevron-right opacity-60" />
          </button>

          <div v-if="captureError" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
            {{ captureError }}
          </div>

          <div v-if="!captureFlow" class="flex flex-col items-center gap-3 py-4">
            <div class="h-16 w-16 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <div class="i-carbon-data-connected text-3xl" :style="{ color: 'var(--theme-primary)' }" />
            </div>
            <BaseButton variant="primary" :loading="captureLoading" @click="startCaptureSession">
              开始抓取
            </BaseButton>
          </div>

          <template v-else>
            <div class="rounded-lg px-3 py-3 text-sm" style="background-color: color-mix(in srgb, var(--theme-primary) 10%, transparent); color: var(--theme-text);">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60">
                    当前步骤
                  </div>
                  <div class="mt-1 break-words font-semibold">
                    {{ captureCurrentStep }}
                  </div>
                  <div class="mt-1 break-words text-xs opacity-70">
                    下一步：{{ captureNextStep }}
                  </div>
                </div>
                <button
                  type="button"
                  class="h-8 w-8 flex flex-none items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
                  title="使用说明"
                  @click="openCaptureHelp"
                >
                  <span class="i-carbon-help text-lg" />
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="min-w-0 flex items-center justify-between gap-1 border border-gray-200 rounded-lg px-3 py-3 dark:border-gray-700">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理服务器
                  </div>
                  <div class="mt-1 break-all font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureDeviceMode === 'pc' ? '127.0.0.1' : (captureFlow.publicInfo.host || '-') }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'host' ? '已复制' : '复制代理服务器'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('host')"
                >
                  <span :class="captureCopiedField === 'host' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
              <div class="min-w-0 flex items-center justify-between gap-1 border border-gray-200 rounded-lg px-3 py-3 dark:border-gray-700">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理端口
                  </div>
                  <div class="mt-1 font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureFlow.publicInfo.mitmPort || '-' }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'port' ? '已复制' : '复制代理端口'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('port')"
                >
                  <span :class="captureCopiedField === 'port' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
            </div>

            <div v-if="captureFlow.publicInfo.addresses?.length > 1" class="border border-gray-200 rounded-lg p-3 text-sm dark:border-gray-700">
              <div class="mb-2 text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                全部可用地址（按当前网络环境选择，代理端口相同）
              </div>
              <div class="space-y-1.5">
                <div
                  v-for="item in captureFlow.publicInfo.addresses"
                  :key="item.address"
                  class="flex items-center justify-between gap-2"
                >
                  <span class="min-w-0 break-all text-xs font-mono" :style="{ color: 'var(--theme-text)' }">
                    {{ item.address }}:{{ captureFlow.publicInfo.mitmPort }}
                  </span>
                  <span
                    class="flex-none rounded px-1.5 py-0.5 text-[10px] font-medium"
                    :style="{
                      color: item.kind === 'tailscale' ? '#0ea5e9' : item.kind === 'lan' ? '#10b981' : item.kind === 'local' ? '#8b5cf6' : 'var(--theme-text)',
                      background: 'color-mix(in srgb, currentColor 10%, transparent)',
                    }"
                  >
                    {{ item.kind === 'tailscale' ? 'Tailscale' : item.kind === 'lan' ? '局域网' : item.kind === 'local' ? '本地' : '其他' }}
                  </span>
                </div>
              </div>
            </div>

            <div class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
              <div class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">Code</span>
                <span :class="captureFlow.codeCaptured ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                  {{ captureFlow.codeCaptured ? '已获取' : '等待中' }}
                </span>
              </div>
              <div v-if="captureFlow.platform === 'qq'" class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">好友 GID</span>
                <span :style="{ color: 'var(--theme-primary)' }">{{ captureFlow.friendCount }} 个</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">剩余时间</span>
                <span :style="{ color: 'var(--theme-text)' }">{{ captureFlow.publicInfo.remainingSec }} 秒</span>
              </div>
            </div>

            <div class="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t border-gray-200 px-4 py-3 -mx-4 dark:border-gray-700" :style="{ background: 'var(--theme-bg)' }">
              <BaseButton
                variant="secondary"
                size="sm"
                :href="captureFlow.publicInfo.certificateUrl"
              >
                <span class="i-carbon-certificate" />
                打开证书
              </BaseButton>
              <BaseButton variant="outline" size="sm" @click="cancelCaptureSession">
                取消抓取
              </BaseButton>
              <BaseButton
                v-if="captureFlow.codeCaptured"
                variant="primary"
                size="sm"
                :loading="captureCompleting"
                @click="completeCaptureAccount"
              >
                {{ editData ? '立即更新' : '立即添加' }}
              </BaseButton>
            </div>
          </template>
        </div>

        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ 小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="showCaptureHelp"
      class="fixed inset-0 z-[10001] flex items-end justify-center bg-black/50 md:items-center"
      @click.self="showCaptureHelp = false"
    >
      <div class="max-h-[78vh] max-w-md w-full flex flex-col overflow-hidden rounded-t-lg shadow-2xl md:rounded-lg" :style="{ background: 'var(--theme-bg)' }">
        <div class="h-14 flex flex-none items-center justify-between border-b border-gray-200 px-4 dark:border-gray-700">
          <h4 class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
            抓包登录使用说明
          </h4>
          <BaseButton variant="ghost" class="!h-9 !w-9 !p-0" title="关闭使用说明" @click="showCaptureHelp = false">
            <span class="i-carbon-close text-lg" />
          </BaseButton>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'first' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'first' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'first'"
            >
              首次使用
            </button>
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'daily' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'daily' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'daily'"
            >
              已装证书
            </button>
          </div>

          <div class="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
            <div v-for="(step, index) in captureHelpSteps" :key="step" class="flex items-start gap-3 py-3 first:pt-0">
              <span class="h-6 w-6 flex flex-none items-center justify-center rounded-full text-xs text-white font-semibold" :style="{ background: 'var(--theme-primary)' }">
                {{ index + 1 }}
              </span>
              <span class="min-w-0 break-words text-sm leading-6" :style="{ color: 'var(--theme-text)' }">
                {{ step }}
              </span>
            </div>
          </div>

          <template v-if="captureHelpMode === 'first'">
            <div class="mt-3 border-t border-gray-200 pt-4 dark:border-gray-700">
              <div class="mb-3 text-sm font-semibold" :style="{ color: 'var(--theme-text)' }">
                证书安装帮助
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button
                  v-if="captureDeviceMode === 'pc'"
                  type="button"
                  class="h-9 rounded-lg px-3 text-sm transition-colors col-span-2"
                  :class="captureHelpDevice === 'pc' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                  :style="captureHelpDevice === 'pc' ? { background: 'var(--theme-gradient)' } : {}"
                  @click="captureHelpDevice = 'pc'"
                >
                  💻 Windows PC
                </button>
                <template v-else>
                  <button
                    type="button"
                    class="h-9 rounded-lg px-3 text-sm transition-colors"
                    :class="captureHelpDevice === 'ios' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                    :style="captureHelpDevice === 'ios' ? { background: 'var(--theme-gradient)' } : {}"
                    @click="captureHelpDevice = 'ios'"
                  >
                    iPhone / iPad
                  </button>
                  <button
                    type="button"
                    class="h-9 rounded-lg px-3 text-sm transition-colors"
                    :class="captureHelpDevice === 'android' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                    :style="captureHelpDevice === 'android' ? { background: 'var(--theme-gradient)' } : {}"
                    @click="captureHelpDevice = 'android'"
                  >
                    Android
                  </button>
                </template>
              </div>
              <div class="mt-3 space-y-2">
                <div v-for="(step, index) in captureDeviceSteps" :key="step" class="flex items-start gap-2 text-xs leading-5" :style="{ color: 'var(--theme-text)' }">
                  <span class="flex-none opacity-60">{{ index + 1 }}.</span>
                  <span class="break-words">{{ step }}</span>
                </div>
              </div>
            </div>
          </template>

          <div class="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-xs text-amber-800 leading-5 dark:bg-amber-900/20 dark:text-amber-200">
            <div>每次任务的代理端口可能变化，请以当前页面显示为准。</div>
            <div class="mt-1">
              <template v-if="captureDeviceMode === 'pc'">
                系统代理由服务端自动管理，抓取开始自动设置、结束自动恢复，无需手动操作。
              </template>
              <template v-else>
                服务端会自动释放代理，但账号完成后仍需在手机上手动关闭 Wi-Fi 代理。
              </template>
            </div>
            <div v-if="capturePlatform === 'wx'" class="mt-1">
              微信抓取成功后无法继续进入农场属于正常现象。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wx-qr-card {
  border: 2px dashed var(--surface-border, #ECE5D6);
  background: var(--surface-card, #FCFBF6);
  box-shadow: inset 0 0 24px rgba(94, 140, 90, 0.06);
  /* 强制 GPU 层 + 禁止 hover 位移，避免鼠标移出时任何父级动画导致闪屏 */
  transform: translateZ(0);
  will-change: transform;
}
.wx-qr-card:hover,
.wx-qr-card img {
  transform: translateZ(0);
}
.dark .wx-qr-card {
  background: var(--surface-card, #1E211A);
  box-shadow: inset 0 0 24px rgba(132, 181, 114, 0.05);
}
</style>
