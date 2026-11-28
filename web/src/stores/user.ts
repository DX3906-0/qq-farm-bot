import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api from '@/api'

export interface User {
  username: string
  role: 'admin' | 'super_admin' | 'user'
  accountLimit: number
  avatar?: string
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials'
  remainingMs?: number
  data?: { token: string, role: User['role'], accountLimit: number, user: { username: string }, mustChangePassword?: boolean }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  const userInfo = useStorage<User | null>('user_info', null)
  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => userInfo.value?.role === 'admin' || userInfo.value?.role === 'super_admin')
  const isSuperAdmin = computed(() => userInfo.value?.role === 'super_admin')
  const username = computed(() => userInfo.value?.username || '')
  const accountLimit = computed(() => userInfo.value?.accountLimit ?? 2)
  const avatar = computed(() => userInfo.value?.avatar || '')

  async function login(usernameInput: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username: usernameInput, password })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          username: res.data.data.user.username,
          role: res.data.data.role,
          accountLimit: res.data.data.accountLimit ?? 2,
          mustChangePassword: res.data.data.mustChangePassword,
        }
        const { useWxLoginStore } = await import('./wx-login')
        await useWxLoginStore().loadConfigFromServer()
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data ? { ok: false, error: data.error, errorType: data.errorType, remainingMs: data.remainingMs } : { ok: false, error: error.message || '网络错误' }
    }
  }

  async function logout() {
    try { await api.post('/api/logout') }
    finally { token.value = ''; userInfo.value = null }
  }
  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok) userInfo.value = res.data.data
      return res.data
    }
    catch { return { ok: false } }
  }
  async function changePassword(oldPassword: string, newPassword: string) {
    return (await api.post('/api/user/change-password', { oldPassword, newPassword })).data
  }
  async function getAllUsers() { return (await api.get('/api/admin/users')).data }
  async function getLoginLogs(limit = 100, offset = 0) { return (await api.get('/api/admin/login-logs', { params: { limit, offset } })).data }
  async function clearLoginLogs(payload?: { confirmed?: boolean, confirmText?: string }) { return (await api.delete('/api/admin/login-logs', { data: payload })).data }
  async function deleteUser(name: string, payload?: { confirmed?: boolean, confirmText?: string }) { return (await api.delete(`/api/admin/users/${encodeURIComponent(name)}`, { data: payload })).data }

  return { token, userInfo, isLoggedIn, isAdmin, isSuperAdmin, username, accountLimit, avatar, login, logout, fetchUserInfo, changePassword, getAllUsers, getLoginLogs, clearLoginLogs, deleteUser }
})
