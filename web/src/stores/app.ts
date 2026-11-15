import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

const THEME_KEY = 'ui_theme'
// A startup-written legacy palette is not an explicit user choice. Store that
// intent separately so a generic server light/dark flag cannot erase it.
const THEME_CHOICE_KEY = 'ui_theme_choice_v1'

export type Theme = 'light-blue' | 'light-green' | 'light-pink' | 'dark-blue' | 'dark-purple' | 'dark-teal' | 'dark-orange' | 'dark-red'

export interface LoginPageConfig {
  logoUrl: string
  title: string
  loginSubtitle: string
  registerSubtitle: string
  purchaseUrl: string
  qqGroupUrl: string
}

const defaultLoginPageConfig: LoginPageConfig = {
  logoUrl: '',
  title: 'QQ农场智能助手',
  loginSubtitle: '欢迎回来，开启智慧农耕之旅',
  registerSubtitle: '创建账号，开启智慧农耕之旅',
  purchaseUrl: '',
  qqGroupUrl: '',
}

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  const currentTheme = ref<Theme>('light-green')
  let themeRevision = 0
  let explicitThemeChoice = false
  let themeFlight: Promise<void> | null = null
  const showThemePanel = ref(false)
  const loginPageConfig = ref<LoginPageConfig>({ ...defaultLoginPageConfig })
  let loginPageConfigPromise: Promise<void> | null = null

  const themes: Record<Theme, {
    name: string
    isDark: boolean
    bg: string
    text: string
    primary: string
    secondary: string
    gradient: string
    icon: string
  }> = {
    'light-blue': {
      name: '晴空蓝',
      isDark: false,
      bg: '#f6f8fb',
      text: '#172033',
      primary: '#2563eb',
      secondary: '#0f766e',
      gradient: 'linear-gradient(135deg, #2563eb 0%, #0f766e 100%)',
      icon: 'i-carbon-sun',
    },
    'dark-blue': {
      name: '深海蓝',
      isDark: true,
      bg: '#0b1020',
      text: '#e5e7eb',
      primary: '#60a5fa',
      secondary: '#2dd4bf',
      gradient: 'linear-gradient(135deg, #60a5fa 0%, #2dd4bf 100%)',
      icon: 'i-carbon-moon',
    },
    'light-pink': {
      name: '樱花粉',
      isDark: false,
      bg: '#fff0f5',
      text: '#831843',
      primary: '#ec4899',
      secondary: '#be185d',
      gradient: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)',
      icon: 'i-carbon-favorite',
    },
    'light-green': {
      name: '清新绿',
      isDark: false,
      bg: '#f7f3ea',
      text: '#2c2a22',
      primary: '#5E8C5A',
      secondary: '#7FB069',
      gradient: 'linear-gradient(135deg, #7FB069 0%, #5E8C5A 100%)',
      icon: 'i-fas-leaf',
    },
    'dark-purple': {
      name: '紫罗兰',
      isDark: true,
      bg: '#1e1b4b',
      text: '#e9d5ff',
      primary: '#a855f7',
      secondary: '#9333ea',
      gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)',
      icon: 'i-fas-crown',
    },
    'dark-orange': {
      name: '暖阳橙',
      isDark: true,
      bg: '#292524',
      text: '#fef3c7',
      primary: '#f59e0b',
      secondary: '#d97706',
      gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
      icon: 'i-carbon-sun',
    },
    'dark-teal': {
      name: '青空青',
      isDark: true,
      bg: '#134e4a',
      text: '#ccfbf1',
      primary: '#06b6d4',
      secondary: '#0891b2',
      gradient: 'linear-gradient(135deg, #22d3ee 0%, #06b6d4 100%)',
      icon: 'i-carbon-tree',
    },
    'dark-red': {
      name: '绯红夜',
      isDark: true,
      bg: '#18181b',
      text: '#fda4af',
      primary: '#f43f5e',
      secondary: '#e11d48',
      gradient: 'linear-gradient(135deg, #fb7185 0%, #f43f5e 100%)',
      icon: 'i-carbon-close-filled',
    },
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function openSidebar() {
    sidebarOpen.value = true
  }

  function fetchTheme(): Promise<void> {
    if (themeFlight)
      return themeFlight
    const revision = themeRevision
    const pending = api.get('/api/settings').then((res) => {
      const rawTheme = res.data?.data?.ui?.theme
      const theme = rawTheme === 'light' ? 'light-green' : rawTheme === 'dark' ? 'dark-blue' : rawTheme
      // Generic backend light/dark flags are a fallback, never a color choice.
      // A chosen local palette and choices made during this read win the race.
      if (!explicitThemeChoice && revision === themeRevision && res.data?.ok === true
        && typeof theme === 'string' && Object.prototype.hasOwnProperty.call(themes, theme))
        applyTheme(theme as Theme, false)
    }).catch(() => {
      // Keep the local theme while offline or not logged in.
    }).finally(() => {
      if (themeFlight === pending)
        themeFlight = null
    })
    themeFlight = pending
    return pending
  }

  async function fetchLoginPageConfig() {
    if (loginPageConfigPromise)
      return loginPageConfigPromise

    loginPageConfigPromise = api.get('/api/public/login-links').then((res) => {
      if (res.data?.ok && res.data.data) {
        loginPageConfig.value = { ...defaultLoginPageConfig, ...res.data.data }
        document.title = loginPageConfig.value.title || defaultLoginPageConfig.title
      }
    }).catch(() => {
      // 保留默认品牌，页面仍可正常使用。
    }).finally(() => {
      loginPageConfigPromise = null
    })
    return loginPageConfigPromise
  }

  function applyTheme(theme: Theme, rememberChoice = true) {
    if (!Object.prototype.hasOwnProperty.call(themes, theme))
      theme = 'light-green'

    const t = themes[theme]
    themeRevision++
    currentTheme.value = theme
    if (rememberChoice) explicitThemeChoice = true
    try {
      localStorage.setItem(THEME_KEY, theme)
      if (rememberChoice) localStorage.setItem(THEME_CHOICE_KEY, theme)
    }
    catch { /* Theme selection must still work when storage is unavailable. */ }

    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('--theme-bg', t.bg)
      document.documentElement.style.setProperty('--theme-text', t.text)
      document.documentElement.style.setProperty('--theme-primary', t.primary)
      document.documentElement.style.setProperty('--theme-secondary', t.secondary)
      document.documentElement.style.setProperty('--theme-gradient', t.gradient)
      // Accessible solid actions are separate from decorative brand gradients.
      const actionColors: Record<Theme, string> = {
        'light-green': '#416d3b', 'light-blue': '#1d4ed8', 'light-pink': '#a61b59',
        'dark-blue': '#1d4ed8', 'dark-purple': '#7e22ce', 'dark-orange': '#92400e',
        'dark-teal': '#0e7490', 'dark-red': '#be123c',
      }
      document.documentElement.style.setProperty('--action-bg', actionColors[theme])
      document.documentElement.style.setProperty('--action-hover', `color-mix(in srgb, ${actionColors[theme]} 88%, #000000)`)
      document.documentElement.style.setProperty('--action-text', '#ffffff')
      document.documentElement.style.setProperty('color-scheme', t.isDark ? 'dark' : 'light')

      if (t.isDark) {
        document.documentElement.classList.add('dark')
      }
      else {
        document.documentElement.classList.remove('dark')
      }
    }
  }

  function toggleThemePanel() {
    showThemePanel.value = !showThemePanel.value
  }

  function toggleDark() {
    const current = currentTheme.value
    if (themes[current]?.isDark) {
      applyTheme('light-green')
    }
    else {
      applyTheme('dark-blue')
    }
  }

  const isDark = computed(() => themes[currentTheme.value]?.isDark ?? false)

  let savedTheme: Theme = 'light-green'
  try {
    const chosen = localStorage.getItem(THEME_CHOICE_KEY)
    const legacy = localStorage.getItem(THEME_KEY)
    if (chosen && Object.prototype.hasOwnProperty.call(themes, chosen)) {
      savedTheme = chosen as Theme
      explicitThemeChoice = true
    }
    else if (legacy && Object.prototype.hasOwnProperty.call(themes, legacy)) {
      // The old startup wrote its default blue as though it were a choice.
      // Migrate only that unmarked default to green; retain every alternative
      // and any marked blue selected through the current theme picker.
      savedTheme = legacy === 'light-blue' ? 'light-green' : legacy as Theme
      explicitThemeChoice = legacy !== 'light-blue' && legacy !== 'light-green'
    }
    else if (legacy === 'dark') savedTheme = 'dark-blue'
  }
  catch { /* Use the default without blocking app startup. */ }
  applyTheme(savedTheme, false)

  return {
    sidebarOpen,
    isDark,
    currentTheme,
    showThemePanel,
    loginPageConfig,
    themes,
    applyTheme,
    toggleThemePanel,
    toggleDark,
    toggleSidebar,
    closeSidebar,
    openSidebar,
    fetchTheme,
    fetchLoginPageConfig,
  }
})
