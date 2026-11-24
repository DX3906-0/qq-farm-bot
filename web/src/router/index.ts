import { useStorage } from '@vueuse/core'
import axios from 'axios'
import NProgress from 'nprogress'
import { createRouter, createWebHistory } from 'vue-router'
import { allMenuRoutes } from './menu'
import { cancelContentMotion } from '@/composables/useContentMotion'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import 'nprogress/nprogress.css'

NProgress.configure({ showSpinner: false })

const adminToken = useStorage('admin_token', '')
let validatedToken = ''
let validatingPromise: Promise<boolean> | null = null

async function ensureTokenValid() {
  const token = String(adminToken.value || '').trim()
  if (!token)
    return false

  if (validatedToken && validatedToken === token)
    return true

  if (validatingPromise)
    return validatingPromise

  validatingPromise = axios.get('/api/auth/validate', {
    headers: { 'x-admin-token': token },
    timeout: 6000,
  }).then((res) => {
    const ok = !!(res.data && res.data.ok)
    if (ok)
      validatedToken = token
    return ok
  }).catch(() => false).finally(() => {
    validatingPromise = null
  })

  return validatingPromise
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/layouts/DefaultLayout.vue'),
      children: [
        ...allMenuRoutes.map(route => ({
          path: route.path,
          name: route.name,
          component: route.component,
          props: route.props,
          meta: { gameWorkspace: route.workspace || 'farm', gamePage: route.pageKey || route.name.toLowerCase() },
        })),
        // Old farm bookmarks lead to their original pages, not a second farm tab.
        { path: 'farm', name: 'farm', redirect: { name: 'personal' } },
        { path: 'farm/status', name: 'farm-status', redirect: { name: 'dashboard' } },
        // Preserve bookmarks without mounting a second solar component/read.
        { path: 'solar-calendar', name: 'solar-calendar', redirect: { name: 'activity', query: { section: 'notes' } } },
      ],
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
    },
    {
      path: '/renewal',
      name: 'renewal',
      component: () => import('@/views/Renewal.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  // Stop the previous painted transition before auth/lazy navigation can wait.
  cancelContentMotion('navigation')
  NProgress.start()

  if (LOCAL_UI_READONLY) {
    if (to.name === 'login' || to.name === 'renewal')
      return { name: 'dashboard' }
    return true
  }

  if (to.name === 'renewal') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const valid = await ensureTokenValid()
    if (!valid) {
      adminToken.value = ''
      validatedToken = ''
    }
    return true
  }

  if (to.name === 'login') {
    if (!adminToken.value) {
      validatedToken = ''
      return true
    }
    const valid = await ensureTokenValid()
    if (valid)
      return { name: 'dashboard' }
    adminToken.value = ''
    validatedToken = ''
    return true
  }

  if (!adminToken.value) {
    validatedToken = ''
    return { name: 'login' }
  }

  const valid = await ensureTokenValid()
  if (!valid) {
    adminToken.value = ''
    validatedToken = ''
    return { name: 'login' }
  }

  return true
})

router.afterEach(() => {
  NProgress.done()
})

export default router
