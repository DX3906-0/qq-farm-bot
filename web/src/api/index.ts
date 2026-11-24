import { useStorage } from '@vueuse/core'
import type { AxiosRequestConfig } from 'axios'
import axios, { AxiosHeaders, CanceledError } from 'axios'
import { watch } from 'vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import { useToastStore } from '@/stores/toast'
import { installRequestMonitor } from '@/utils/requestMonitor'

const tokenRef = useStorage('admin_token', '')
const accountIdRef = useStorage('current_account_id', '')
let accountEpoch = 0
let sessionEpoch = 0
watch(accountIdRef, () => { accountEpoch++ }, { flush: 'sync' })
watch(tokenRef, () => { sessionEpoch++ }, { flush: 'sync' })

const api = new Proxy(axios.create({
  baseURL: '/',
  timeout: 20000,
  ...(LOCAL_UI_READONLY ? {
    adapter: (config: any) => Promise.reject(Object.assign(new CanceledError('本地只读浏览未连接任何账号或后端', config), { localReadonly: true })),
  } : {}),
}), {
  apply(target, thisArg, args: [AxiosRequestConfig | string, AxiosRequestConfig?]) {
    const [config, options] = args
    return Reflect.apply(target, thisArg, [snapshotConfig(typeof config === 'string' ? { ...options, url: config } : config)])
  },
})

let lastNetworkToastAt = 0
function showNetworkToast(message: string) {
  const now = Date.now()
  if (now - lastNetworkToastAt < 5000)
    return
  lastNetworkToastAt = now
  useToastStore().error(message)
}

function snapshotConfig(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  const headers = AxiosHeaders.from(config.headers as AxiosHeaders | undefined).concat()
  if (!headers.has('x-admin-token'))
    headers.set('x-admin-token', tokenRef.value || '')
  if (!headers.has('x-account-id'))
    headers.set('x-account-id', accountIdRef.value || '')
  return { ...config, headers, ...{
    requestAccountEpoch: (config as any).requestAccountEpoch ?? accountEpoch,
    requestSessionEpoch: (config as any).requestSessionEpoch ?? sessionEpoch,
  } }
}

// 在调用时冻结账号与会话，而不是等异步拦截器执行时再读当前账号。
for (const method of ['get', 'delete', 'head', 'options'] as const) {
  const original = api[method].bind(api)
  api[method] = ((url: string, config?: AxiosRequestConfig) => original(url, snapshotConfig(config))) as typeof original
}
for (const method of ['post', 'put', 'patch'] as const) {
  const original = api[method].bind(api)
  api[method] = ((url: string, data?: unknown, config?: AxiosRequestConfig) => original(url, data, snapshotConfig(config))) as typeof original
}
const originalRequest = api.request.bind(api)
api.request = ((config: AxiosRequestConfig | string, options?: AxiosRequestConfig) =>
  originalRequest(snapshotConfig(typeof config === 'string' ? { ...options, url: config } : config))) as typeof originalRequest
api.interceptors.request.use(config => {
  config.headers = AxiosHeaders.from(snapshotConfig(config).headers as AxiosHeaders)
  return config
}, undefined, { synchronous: true })

export function isReadCanceled(error: any) {
  return axios.isCancel(error) || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError'
}

export function cloneRead<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

// 只保留在途工作；一次状态应用、每个订阅者独立取消和独立返回值。
export function createReadCoordinator() {
  type Flight = { controller: AbortController, promise: Promise<any>, settled: boolean, users: number }
  const flights = new Map<string, Flight>()
  // 已取消但 adapter 尚未结束的请求也占容量，不能删除后无限繁殖。
  const live = new Set<Flight>()
  const maxEntries = 64
  const maxWaiters = 128
  let waiters = 0
  let epoch = 0
  return {
    get epoch() { return epoch },
    get size() { return live.size },
    get waiters() { return waiters },
    invalidate() {
      epoch++
      for (const flight of live) flight.controller.abort()
      flights.clear()
    },
    run<T>(key: string, job: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      key = JSON.stringify([key, tokenRef.value, sessionEpoch])
      if (signal?.aborted) return Promise.reject(new CanceledError())
      if (waiters >= maxWaiters) return Promise.reject(new CanceledError('读取订阅已达上限'))
      let flight = flights.get(key)
      if (flight?.controller.signal.aborted) return Promise.reject(new CanceledError('旧读取尚未结束'))
      if (!flight) {
        if (live.size >= maxEntries) return Promise.reject(new CanceledError('在途读取已达上限'))
        const controller = new AbortController()
        flight = { controller, promise: Promise.resolve(), settled: false, users: 0 }
        flights.set(key, flight)
        live.add(flight)
        const active = flight
        const session = tokenRef.value
        const version = sessionEpoch
        try { active.promise = job(controller.signal) }
        catch (error) { active.promise = Promise.reject(error) }
        active.promise = active.promise.then(value => {
          if (tokenRef.value !== session || version !== sessionEpoch) throw new CanceledError('会话已切换')
          return value
        }).finally(() => {
          active.settled = true
          live.delete(active)
          if (flights.get(key) === active) flights.delete(key)
        })
      }
      const active = flight
      active.users++
      waiters++
      return new Promise<T>((resolve, reject) => {
        let done = false
        const release = () => {
          done = true
          signal?.removeEventListener('abort', cancel)
          if (--active.users === 0 && !active.settled) active.controller.abort()
        }
        const cancel = () => {
          if (done) return
          release()
          reject(new CanceledError())
        }
        signal?.addEventListener('abort', cancel, { once: true })
        active.promise.then(value => {
          waiters--
          if (done) return
          release()
          try { resolve(cloneRead(value)) }
          catch (error) { reject(error) }
        }, error => {
          waiters--
          if (done) return
          release()
          reject(error)
        })
      })
    },
  }
}

const safeReadPaths = new Set([
  '/api/dog/info', '/api/dog/protect-logs', '/api/dog/capital-mode',
  '/api/lands', '/api/ranch/operations', '/api/seeds', '/api/farm/unified-harvest', '/api/bag/seeds',
  '/api/shop/seed', '/api/shop/pet', '/api/shop/decoration', '/api/shop/mall', '/api/shop/mystery',
  '/api/activity/star', '/api/activity/qixi',
  // 节令小札/荷风游记：活动页读取与「领取后刷新」都走这里，纳入只读合并避免切页重复请求。
  '/api/activity/helu',
  '/api/activity/honghua', '/api/activity/wish-sign', '/api/activity/share-reward',
  ...['shop', 'upgrade', 'fund', 'exchange', 'work', 'hireList', 'rank', 'logs'].map(page => `/api/activity/milk-tea/${page}`),
])
const reads = createReadCoordinator()
let writeGeneration = 0
export function invalidateSafeReads() { writeGeneration++ }
let unsharedRead = 0
function canonical(value: any): any {
  if (value instanceof URLSearchParams)
    return new URLSearchParams([...value.entries()].sort(([a], [b]) => a.localeCompare(b)))
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export function readParamsKey(params?: Record<string, unknown>): string {
  return api.getUri({ url: '/', params: canonical(params) })
}
export function safeGet<T = any>(path: string, config: AxiosRequestConfig = {}, epoch = 0): Promise<{ data: T }> {
  const snapshot = snapshotConfig(config)
  const generation = writeGeneration
  // 不合并未知路径、自定义序列化器或非本站 baseURL。
  if (!safeReadPaths.has(path) || snapshot.paramsSerializer || snapshot.adapter || snapshot.cancelToken || snapshot.data !== undefined
    || snapshot.transformResponse || snapshot.transformRequest || snapshot.validateStatus || (snapshot.baseURL && snapshot.baseURL !== '/')) {
    return reads.run(`unshared:${++unsharedRead}`, async (signal) => {
      const { data } = await api.get<T>(path, { ...snapshot, signal })
      return { data }
    }, snapshot.signal as AbortSignal | undefined)
  }
  snapshot.params = canonical(snapshot.params)
  const headers = AxiosHeaders.from(snapshot.headers as AxiosHeaders)
  const sessionHeaders = Object.fromEntries(Object.entries(headers.toJSON()).map(([key, value]) => [key.toLowerCase(), value]))
  const key = JSON.stringify([generation, api.getUri(snapshotConfig({ ...snapshot, url: path })), headers.get('x-account-id'), canonical(sessionHeaders), epoch, snapshot.timeout, snapshot.responseType, snapshot.withCredentials, snapshot.auth])
  return reads.run(key, async (signal) => {
    const { data } = await api.get<T>(path, { ...snapshot, signal })
    return { data }
  }, snapshot.signal as AbortSignal | undefined)
}

api.interceptors.response.use((response) => {
  return response
}, (error) => {
  if (isReadCanceled(error)) {
    return Promise.reject(error)
  }

  const toast = useToastStore()
  // 轮询类请求可传 skipErrorToast 抑制弹窗，避免短间隔轮询失败时刷屏
  const silent = (error.config as any)?.skipErrorToast === true

  if (error.response) {
    if (error.response.status === 401) {
      const requestToken = AxiosHeaders.from(error.config?.headers).get('x-admin-token')
      if (requestToken !== tokenRef.value || error.config?.requestSessionEpoch !== sessionEpoch
        || error.config?.requestAccountEpoch !== accountEpoch) return Promise.reject(error)
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
