<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import UpdateLogModal from '@/components/login/UpdateLogModal.vue'
import PasswordStrengthMeter from '@/components/login/PasswordStrengthMeter.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { getPasswordStrength } from '@/composables/usePasswordStrength'
import { useAppStore } from '@/stores/app'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const appStore = useAppStore()
const route = useRoute()
const loginLinks = computed(() => appStore.loginPageConfig)
const username = ref('')
const password = ref('')
const error = ref('')
const success = ref('')
const loading = ref(false)
const showPasswordStrength = ref(false)
const lockoutRemaining = ref(0)
const rateLimitRemaining = ref(0)
const showUpdateLog = ref(false)
const logoLoadFailed = ref(false)
const routeUsername = computed(() => String(route.query.username || '').trim())
const passwordStrength = computed(() => getPasswordStrength(password.value))
watch(password, value => { showPasswordStrength.value = !!value })
watch(routeUsername, value => { if (value && !username.value.trim()) username.value = value }, { immediate: true })
watch(() => loginLinks.value.logoUrl, () => { logoLoadFailed.value = false })

async function handleSubmit() {
  if (!username.value.trim()) { error.value = '请输入用户名'; return }
  if (!password.value) { error.value = '请输入密码'; return }
  loading.value = true
  error.value = ''
  success.value = ''
  try {
    const result = await userStore.login(username.value.trim(), password.value)
    if (result.ok) {
      success.value = result.data?.mustChangePassword ? '登录成功！请修改默认密码以确保账户安全' : '登录成功'
      setTimeout(() => { window.location.href = '/' }, 500)
    }
    else {
      error.value = result.error || '登录失败'
      if (result.errorType === 'rate_limit' && result.remainingMs) rateLimitRemaining.value = Math.ceil(result.remainingMs / 1000)
      if (result.errorType === 'locked' && result.remainingMs) lockoutRemaining.value = Math.ceil(result.remainingMs / 60000)
    }
  }
  catch (e: any) {
    const data = e.response?.data
    error.value = data?.error || e.message || '登录异常'
    if (data?.errorType === 'rate_limit' && data.remainingMs) rateLimitRemaining.value = Math.ceil(data.remainingMs / 1000)
    if (data?.errorType === 'locked' && data.remainingMs) lockoutRemaining.value = Math.ceil(data.remainingMs / 60000)
  }
  finally { loading.value = false }
}

onMounted(() => { appStore.fetchLoginPageConfig() })
</script>

<template>
  <div class="login-container">
    <main class="login-card">
      <div class="logo-area">
        <div class="logo-icon">
          <img v-if="loginLinks.logoUrl && !logoLoadFailed" :src="loginLinks.logoUrl" :alt="`${loginLinks.title || 'QQ农场智能助手'}图标`" class="logo-image" @error="logoLoadFailed = true">
          <div v-else class="i-carbon-home text-3xl" />
        </div>
        <h1 class="logo-title">{{ loginLinks.title || 'QQ农场智能助手' }}</h1>
        <p class="logo-subtitle">{{ loginLinks.loginSubtitle || '欢迎回来，开启智慧农耕之旅' }}</p>
      </div>
      <form class="form-area" @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label" for="username">用户名</label>
          <BaseInput id="username" v-model="username" type="text" placeholder="请输入用户名" required autocomplete="username" />
        </div>
        <div class="form-group">
          <label class="form-label" for="password">密码</label>
          <BaseInput id="password" v-model="password" type="password" placeholder="请输入密码" required autocomplete="current-password" />
          <PasswordStrengthMeter v-if="showPasswordStrength && password" :strength="passwordStrength" compact />
          <div v-if="error" class="message error-message">
            {{ error }}
            <span v-if="lockoutRemaining > 0">（{{ lockoutRemaining }} 分钟后解锁）</span>
            <span v-if="rateLimitRemaining > 0">（{{ rateLimitRemaining }} 秒后可重试）</span>
          </div>
          <div v-if="success" class="message success-message">{{ success }}</div>
        </div>
        <BaseButton type="submit" variant="primary" block :loading="loading" class="submit-btn">登录</BaseButton>
      </form>
      <div class="card-footer">
        <div class="footer-info">
          <a v-if="loginLinks.qqGroupUrl" :href="loginLinks.qqGroupUrl" target="_blank" rel="noopener noreferrer" class="footer-link qq-group-link">加入QQ群</a>
          <button type="button" class="footer-link update-log-link" @click="showUpdateLog = true">更新日志</button>
        </div>
      </div>
    </main>
    <UpdateLogModal :show="showUpdateLog" @close="showUpdateLog = false" />
  </div>
</template>

<style scoped>
.login-container { min-height: 100vh; width: 100%; display: flex; align-items: center; justify-content: center; background: linear-gradient(180deg, #cfe8f9 0%, #edf7f9 48%, #fef9e8 55%, #eff8df 100%); font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; position: relative; overflow: hidden; padding: 24px; }
.login-card { width: 100%; max-width: 420px; padding: 46px 36px 34px; background: rgba(255,255,255,.94); border: 1px solid rgba(102,187,106,.22); border-radius: 18px; box-shadow: 0 18px 56px rgba(46,125,50,.12), 0 8px 28px rgba(15,23,42,.08); position: relative; z-index: 10; backdrop-filter: blur(18px); }
.logo-area { display: flex; flex-direction: column; align-items: center; text-align: center; margin-bottom: 34px; }
.logo-icon { display: inline-flex; align-items: center; justify-content: center; width: 74px; height: 74px; background: #e8f5e9; border: 3px solid #66bb6a; border-radius: 50%; color: #43a047; margin-bottom: 24px; }
.logo-image { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.logo-title { color: #2e7d32; font-size: 1.82rem; font-weight: 700; margin: 0; }
.logo-subtitle { color: #757575; font-size: .9rem; margin: 10px 0 0; }
.form-area { display: flex; flex-direction: column; gap: 22px; }
.form-group { display: flex; flex-direction: column; gap: 8px; }
.form-label { font-size: .875rem; font-weight: 700; color: #558b2f; }
.message { padding: 10px 12px; border-radius: 10px; font-size: .875rem; line-height: 1.45; }
.error-message { background: #fef2f2; color: #c62828; border: 1px solid #fecaca; }
.success-message { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.submit-btn { margin-top: 6px; height: 52px; font-size: 1rem; font-weight: 700; border-radius: 10px; }
.card-footer { text-align: center; margin-top: 28px; color: #94a3b8; font-size: .8rem; }
.footer-info { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: .75rem; }
.footer-link { border-radius: 6px; padding: 5px 10px; font-weight: 700; text-decoration: none; cursor: pointer; }
.qq-group-link { color: #075985; background: #e0f2fe; border: 1px solid #bae6fd; }
.update-log-link { color: #854d0e; background: #fef9c3; border: 1px solid #fde047; font-size: inherit; }
@media (max-width: 480px) { .login-container { align-items: flex-start; padding: 16px; } .login-card { padding: 24px; border-radius: 14px; } .logo-icon { width: 46px; height: 46px; } .logo-title { font-size: 1.25rem; } }
</style>
