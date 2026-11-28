import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUserStore } from './user'

export interface WxLoginConfig {
  enabled: boolean
  // 登录模式：local = 仅本地直连微信开放平台；proxy = 仅第三方代理 API；auto = 本地优先、失败回退第三方
  mode: 'auto' | 'local' | 'proxy'
  apiBase: string
  apiKey: string
  proxyApiUrl: string
  appId: string
  autoAddAccount: boolean
  userIsolation: boolean
}

export const useWxLoginStore = defineStore('wx-login', () => {
  // 默认配置
  const defaultConfig: WxLoginConfig = {
    enabled: true,
    mode: 'auto',
    apiBase: 'https://code.z74d.top/api',
    apiKey: '',
    proxyApiUrl: 'https://code.z74d.top/api',
    appId: 'wx5306c5978fdb76e4',
    autoAddAccount: true,
    userIsolation: true,
  }

  // 获取当前用户ID
  const userStore = useUserStore()
  const currentUserId = computed(() => userStore.username || 'default')

  // 使用 ref 存储配置
  const rawConfig = ref<WxLoginConfig>({ ...defaultConfig })

  // 初始化时从服务器加载
  async function loadConfig() {
    await loadConfigFromServer()
  }

  // 从服务器加载配置
  async function loadConfigFromServer() {
    try {
      const response = await fetch('/api/user/wxlogin-config', {
        headers: {
          'x-admin-token': localStorage.getItem('admin_token') || '',
        },
      })
      const result = await response.json()
      if (result.ok && result.config) {
        // 合并服务器配置（服务器配置优先）
        rawConfig.value = { ...defaultConfig, ...result.config }
      }
      else {
        rawConfig.value = { ...defaultConfig }
      }
    }
    catch (e) {
      console.error('从服务器加载配置失败:', e)
      rawConfig.value = { ...defaultConfig }
    }
  }

  // 初始化加载
  loadConfig()

  // 合并配置：确保新字段有默认值
  const config = computed<WxLoginConfig>(() => ({
    ...defaultConfig,
    ...rawConfig.value,
  }))

  // 扫码登录状态
  const isLoading = ref(false)
  const qrCode = ref<string | null>(null)
  const qrCreatedAt = ref(0)
  const uuid = ref('')
  const wxid = ref('')
  const status = ref<'idle' | 'qr_loading' | 'qr_ready' | 'scanning' | 'confirming' | 'code_loading' | 'success' | 'error'>('idle')
  const statusMessage = ref('')
  const errorMessage = ref('')

  // 本地直连登录任务状态（/api/wx-login）
  const localTaskId = ref('')
  const localCode = ref('')
  let localPollInFlight: Promise<{ success: boolean, wxid?: string, nickname?: string, avatar?: string }> | null = null

  // 获取二维码接口地址
  const qrEndpoint = 'LoginGetQRCar'

  function authHeaders(): Record<string, string> {
    return { 'x-admin-token': localStorage.getItem('admin_token') || '' }
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('读取二维码失败'))
      reader.readAsDataURL(blob)
    })
  }

  // 取消本地登录任务
  async function cancelLocalTask() {
    const taskId = localTaskId.value
    localTaskId.value = ''
    localCode.value = ''
    if (taskId) {
      try {
        await fetch(`/api/wx-login/tasks/${taskId}`, { method: 'DELETE', headers: authHeaders() })
      }
      catch {}
    }
  }

  // 重置登录状态
  function resetState() {
    void cancelLocalTask()
    qrCode.value = null
    qrCreatedAt.value = 0
    uuid.value = ''
    wxid.value = ''
    status.value = 'idle'
    statusMessage.value = ''
    errorMessage.value = ''
  }

  // 判断是否需要使用代理模式（api_key 不为空）
  const useProxyMode = computed(() => !!config.value.apiKey)

  // 获取代理API URL（确保有默认值）
  const proxyApiUrl = computed(() =>
    (useProxyMode.value ? config.value.proxyApiUrl : config.value.apiBase)
    || defaultConfig.proxyApiUrl,
  )

  function buildProxyHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-proxy-api-url': proxyApiUrl.value,
      'x-proxy-app-id': config.value.appId,
    }
    if (config.value.apiKey)
      headers['x-proxy-api-key'] = config.value.apiKey
    return headers
  }

  async function requestProxy(body: Record<string, any>) {
    const response = await fetch('/api/proxy', {
      method: 'POST',
      headers: buildProxyHeaders(),
      body: JSON.stringify(body),
    })
    return response.json()
  }

  async function requestPublicApi(path: string, init?: RequestInit) {
    const base = String(config.value.apiBase || defaultConfig.apiBase).replace(/\/+$/, '')
    const response = await fetch(`${base}${path}`, init)
    return response.json()
  }

  // 本地直连：创建扫码任务并获取二维码图片
  async function getLocalQRCode(): Promise<boolean> {
    await cancelLocalTask()
    const createRes = await fetch('/api/wx-login/tasks', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.value.appId || defaultConfig.appId }),
    })
    const createData = await createRes.json()
    if (!createData.ok || !createData.data) {
      throw new Error(createData.error || '创建微信扫码任务失败')
    }
    localTaskId.value = String(createData.data.task_id || '')
    const qrRes = await fetch(createData.data.qr_url, { headers: authHeaders() })
    if (!qrRes.ok)
      throw new Error(`下载二维码失败 (HTTP ${qrRes.status})`)
    const blob = await qrRes.blob()
    qrCode.value = await blobToDataUrl(blob)
    qrCreatedAt.value = Date.now()
    return true
  }

  // 本地直连：轮询状态并完成确认、换取 Code
  async function checkLocalLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string, avatar?: string }> {
    if (localPollInFlight)
      return localPollInFlight
    localPollInFlight = (async () => {
      const taskId = localTaskId.value
      if (!taskId)
        return { success: false }

      status.value = 'scanning'
      statusMessage.value = '正在检查登录状态...'

      const statusRes = await fetch(`/api/wx-login/tasks/${taskId}/status`, { headers: authHeaders() })
      const statusData = await statusRes.json()
      const taskStatus = statusData?.data?.status
      if (!statusData.ok)
        throw new Error(statusData.error || '登录状态查询失败')

      if (taskStatus === 'waiting') {
        status.value = 'qr_ready'
        statusMessage.value = '等待扫码中'
        return { success: false }
      }
      if (taskStatus === 'scanned') {
        status.value = 'confirming'
        statusMessage.value = '已扫码，请在手机上确认登录'
        return { success: false }
      }
      if (taskStatus === 'cancelled' || taskStatus === 'expired' || taskStatus === 'failed') {
        throw new Error('二维码已失效，请重新获取')
      }
      if (taskStatus !== 'authorized' && taskStatus !== 'ready_for_code') {
        return { success: false }
      }

      // 已授权：确认会话并换取 Code
      status.value = 'confirming'
      statusMessage.value = '正在建立登录会话...'
      if (taskStatus === 'authorized') {
        const confirmRes = await fetch(`/api/wx-login/tasks/${taskId}/confirm`, {
          method: 'POST',
          headers: authHeaders(),
        })
        const confirmData = await confirmRes.json()
        if (!confirmData.ok)
          throw new Error(confirmData.error || '登录确认失败')
      }

      status.value = 'code_loading'
      statusMessage.value = '正在获取QQ农场Code...'
      const codeRes = await fetch(`/api/wx-login/tasks/${taskId}/code`, {
        method: 'POST',
        headers: authHeaders(),
      })
      const codeData = await codeRes.json()
      const code = String(codeData?.data?.code || '').trim()
      if (!codeData.ok || !code)
        throw new Error(codeData.error || '获取QQ农场Code失败')

      localCode.value = code
      localTaskId.value = ''
      status.value = 'success'
      statusMessage.value = '登录成功！'
      return { success: true, wxid: codeData.data.openid || '', nickname: '', avatar: '' }
    })().finally(() => {
      localPollInFlight = null
    })
    return localPollInFlight
  }

  // 获取二维码（第三方 API，原逻辑）
  async function getThirdPartyQRCode(): Promise<boolean> {
    let data: any

    if (useProxyMode.value) {
      const result = await requestProxy({ action: 'getqr' })
      if (result.code === 0 && result.data) {
        data = {
          Success: true,
          Data: {
            Uuid: result.data.Uuid || result.data.uuid,
            QrBase64: result.data.QrBase64 || result.data.qrBase64,
          },
        }
      }
      else if (result.Success !== undefined) {
        data = result
      }
      else {
        data = { Success: false, Message: result.msg || '获取二维码失败' }
      }
    }
    else {
      data = await requestPublicApi(`/Login/${qrEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    }

    if (data.Success && data.Data) {
      uuid.value = data.Data.Uuid
      qrCode.value = data.Data.QrBase64 || data.Data.qrBase64 || ''
      qrCreatedAt.value = Date.now()
      return true
    }
    throw new Error(data.Message || '获取二维码失败')
  }

  // 获取二维码（按模式分发：local 本地直连 / auto 本地优先回退 / proxy 第三方）
  async function getQRCode(): Promise<boolean> {
    isLoading.value = true
    status.value = 'qr_loading'
    statusMessage.value = '正在获取二维码...'
    errorMessage.value = ''

    try {
      if (config.value.mode !== 'proxy') {
        try {
          if (await getLocalQRCode()) {
            status.value = 'qr_ready'
            statusMessage.value = '请使用微信扫码登录'
            return true
          }
        }
        catch (e: any) {
          await cancelLocalTask()
          if (config.value.mode === 'local')
            throw e
          // auto 模式：本地失败回退第三方 API
        }
      }
      await cancelLocalTask()

      if (await getThirdPartyQRCode()) {
        status.value = 'qr_ready'
        statusMessage.value = '请使用微信扫码登录'
        return true
      }
      return false
    }
    catch (e: any) {
      status.value = 'error'
      qrCreatedAt.value = 0
      errorMessage.value = `请求失败: ${e.message}`
      return false
    }
    finally {
      isLoading.value = false
    }
  }

  // 检查登录状态（第三方 API，原逻辑）
  async function checkThirdPartyLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string, avatar?: string }> {
    if (!uuid.value) {
      return { success: false }
    }

    status.value = 'scanning'
    statusMessage.value = '正在检查登录状态...'

    let data: any

    if (useProxyMode.value) {
      const result = await requestProxy({
        action: 'checkqr',
        uuid: uuid.value,
      })
      // 尝试从不同字段获取wxid
      const resultData = result.data || result.Data || {}
      const wxid = resultData.wxid || resultData.Wxid || resultData.userName || resultData.UserName || ''
      const nickname = resultData.nickname || resultData.Nickname || resultData.nickName || resultData.NickName || '微信用户'
      const avatar = resultData.avatar || resultData.Avatar || resultData.avatarUrl || resultData.AvatarUrl || resultData.headImgUrl || resultData.HeadImgUrl || ''

      if (result.code === 0 && wxid) {
        // 真正登录成功（有wxid）
        data = {
          Success: true,
          Data: {
            acctSectResp: {
              userName: wxid,
              nickName: nickname,
              avatar,
            },
          },
        }
      }
      else if (result.code === -1 || result.code === -2 || (result.code === 0 && !wxid)) {
        // 等待扫码或等待确认，不是错误
        // 注意：有些API在code===0但wxid为空时也表示等待中
        data = {
          Success: true,
          Data: {
            status: result.code === -2 ? 1 : 0, // -2表示已扫码待确认，-1表示等待扫码
          },
        }
      }
      else if (result.Success !== undefined) {
        data = result
      }
      else {
        data = { Success: false, Message: result.msg || '登录检查失败' }
      }
    }
    else {
      data = await requestPublicApi(`/Login/LoginCheckQR?uuid=${encodeURIComponent(uuid.value)}`, {
        method: 'POST',
      })
    }

    const acctResp = data?.Data?.acctSectResp || data?.Data?.AcctSectResp
    const userName = acctResp?.userName || acctResp?.UserName
    const nickName = acctResp?.nickName || acctResp?.NickName || '微信用户'
    const avatar = acctResp?.avatar || acctResp?.Avatar || acctResp?.avatarUrl || acctResp?.AvatarUrl || acctResp?.headImgUrl || acctResp?.HeadImgUrl || ''
    const qrStatus = data?.Data?.status

    if (data.Success && userName) {
      wxid.value = userName
      status.value = 'success'
      statusMessage.value = `登录成功！欢迎 ${nickName}`
      return { success: true, wxid: userName, nickname: nickName, avatar }
    }
    else if (data.Success && (qrStatus === 1 || qrStatus === 0)) {
      status.value = qrStatus === 1 ? 'confirming' : 'qr_ready'
      statusMessage.value = qrStatus === 1 ? '已扫码，请在手机确认登录' : '等待扫码中'
      return { success: false }
    }
    throw new Error(data.Message || '登录检查失败')
  }

  // 检查登录状态（按当前激活的登录方式分发）
  async function checkLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string, avatar?: string }> {
    if (localTaskId.value) {
      try {
        return await checkLocalLogin()
      }
      catch (e: any) {
        status.value = 'error'
        errorMessage.value = `请求失败: ${e.message}`
        return { success: false }
      }
    }
    return checkThirdPartyLogin()
  }

  // 获取QQ农场Code
  async function getFarmCode(wxidParam?: string): Promise<{ success: boolean, code?: string }> {
    // 本地直连模式下 Code 已在轮询阶段获取
    if (localCode.value) {
      status.value = 'success'
      statusMessage.value = '已获取QQ农场Code'
      return { success: true, code: localCode.value }
    }

    const targetWxid = wxidParam || wxid.value
    if (!targetWxid) {
      return { success: false }
    }

    isLoading.value = true
    status.value = 'code_loading'
    statusMessage.value = '正在获取QQ农场Code...'
    errorMessage.value = ''

    try {
      let data: any

      if (useProxyMode.value) {
        const result = await requestProxy({
          action: 'jslogin',
          wxid: targetWxid,
        })
        const resultData = result.data || result.Data || {}
        if (result.code === 0 && resultData) {
          data = {
            Success: true,
            Data: {
              code: resultData.code || resultData.Code,
            },
          }
        }
        else if (result.Success !== undefined) {
          data = result
        }
        else {
          data = { Success: false, Message: result.msg || '获取Code失败' }
        }
      }
      else {
        data = await requestPublicApi('/Wxapp/JSLogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Wxid: targetWxid,
            Appid: config.value.appId || defaultConfig.appId,
          }),
        })
      }

      if (data.Success && data.Data && data.Data.code) {
        status.value = 'success'
        statusMessage.value = '已获取QQ农场Code'
        return { success: true, code: data.Data.code }
      }
      else {
        const errMsg = data.Data?.jsapiBaseresponse?.errmsg || data.Message || '获取Code失败'
        status.value = 'error'
        errorMessage.value = errMsg
        return { success: false }
      }
    }
    catch (e: any) {
      status.value = 'error'
      errorMessage.value = `请求失败: ${e.message}`
      return { success: false }
    }
    finally {
      isLoading.value = false
    }
  }

  return {
    config,
    isLoading,
    qrCode,
    qrCreatedAt,
    uuid,
    wxid,
    status,
    statusMessage,
    errorMessage,
    qrEndpoint,
    currentUserId,
    useProxyMode,
    resetState,
    getQRCode,
    checkLogin,
    getFarmCode,
    loadConfigFromServer,
    getLocalQRCode,
    checkLocalLogin,
    cancelLocalTask,
  }
})
