import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useAppStore } from '@/stores/app'
import { useToastStore } from '@/stores/toast'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import App from './App.vue'
import router from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './style.css'

if (LOCAL_UI_READONLY) {
  // This origin is reserved for viewing: no saved authentication/account is
  // loaded, generated or impersonated. Production origins are never touched.
  for (const key of ['admin_token', 'user_info', 'current_account_id']) {
    try { localStorage.removeItem(key) }
    catch { /* Restricted storage still starts with an empty account. */ }
  }
  window.fetch = () => Promise.reject(new Error('本地只读浏览不允许网络操作'))
}

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

// The store owns theme definitions and applies the saved theme before mount.
// Do not keep a second color table here: it caused a pink/green first-frame flash.
const appStore = useAppStore()

// Global Error Handling
const toast = useToastStore()

app.config.errorHandler = (err: any, _instance, info) => {
  console.error('全局 Vue 错误:', err, info)
  const message = err.message || String(err)
  if (message.includes('ResizeObserver loop'))
    return
  toast.error(`应用错误: ${message}`)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (reason && typeof reason === 'object' && 'isAxiosError' in reason)
    return

  console.error('Unhandled Rejection:', reason)
  const message = reason?.message || String(reason)
  toast.error(`异步错误: ${message}`)
})

window.onerror = (message, _source, _lineno, _colno, error) => {
  console.error('Global Error:', message, error)
  if (String(message).includes('Script error'))
    return
  toast.error(`系统错误: ${message}`)
}

// One background sync; App.vue does not issue another settings read.
if (!LOCAL_UI_READONLY) void appStore.fetchTheme()

app.mount('#app')
