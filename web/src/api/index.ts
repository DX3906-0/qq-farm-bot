import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { useToastStore } from '@/stores/toast'
import { installRequestMonitor } from '@/utils/requestMonitor'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')

const api = axios.create({
  baseURL: '/',
  timeout: 20000,
})

let lastNetworkToastAt = 0
function showNetworkToast(message: string) {
  const now = Date.now()
  if (now - lastNetworkToastAt < 5000)
    return
  lastNetworkToastAt = now
  useToastStore().error(message)
}

api.interceptors.request.use((config) => {
  const token = tokenRef.value
  if (token) {
    config.headers['x-admin-token'] = token
  }
  const accountId = accountIdRef.value
  if (accountId) {
    config.headers['x-account-id'] = accountId
  }
  return config
}, error => Promise.reject(error))

api.interceptors.response.use((response) => {
  return response
}, (error) => {
  if (axios.isCancel(error) || error?.code === 'ERR_CANCELED') {
    return Promise.reject(error)
  }

  const toast = useToastStore()
  // 轮询类请求可传 skipErrorToast 抑制弹窗，避免短间隔轮询失败时刷屏
  const silent = (error.config as any)?.skipErrorToast === true

  if (error.response) {
    if (error.response.status === 401) {
      if (!window.location.pathname.includes('/login')) {
        tokenRef.value = ''
        window.location.href = '/login'
        toast.warning('登录已过期，请重新登录')
      }
    }
    else if (error.response.status >= 500) {
      const backendError = String(error.response.data?.error || error.response.data?.message || '')
      if (backendError === '账号未运行' || backendError === 'API Timeout' || backendError === 'Request Timeout') {
        return Promise.reject(error)
      }
      if (!silent)
        toast.error(`服务器错误 ${error.response.status} ${error.response.statusText}`)
    }
    else {
      if (!silent)
        toast.error('请求失败，请联系管理员')
    }
  }
  else if (error.request) {
    if (!silent) {
      if (error.code === 'ECONNABORTED') {
        showNetworkToast('请求超时，请稍后重试')
      }
      else {
        showNetworkToast('网络错误，无法连接到服务器')
      }
    }
  }
  else {
    if (!silent)
      toast.error(`错误: ${error.message}`)
  }

  return Promise.reject(error)
})

// 只读请求观测：定位「谁在往网关打请求」。不发起新请求、不改 timeout/频次/重试。
// 明细：window.__reqMonitor.dumpToConsole() / dumpTopUrls()；角标可点可隐藏。
installRequestMonitor(api)

export default api
