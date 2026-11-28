export type GameWorkspace = 'farm' | 'ranch'
export type RanchPage = 'overview' | 'personal' | 'friends' | 'activity' | 'shop' | 'illustrated'

export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
  adminOnly?: boolean
  showInNav?: boolean
  props?: Record<string, unknown>
  workspace?: GameWorkspace
  pageKey?: string
}

export const menuRoutes: MenuItem[] = [
  {
    path: '',
    name: 'dashboard',
    label: '概览',
    icon: 'i-carbon-chart-pie',
    component: () => import('@/views/Dashboard.vue'),
    pageKey: 'overview',
  },
  {
    path: 'personal',
    name: 'personal',
    label: '个人',
    icon: 'i-carbon-user',
    component: () => import('@/views/Personal.vue'),
  },
  {
    path: 'friends',
    name: 'friends',
    label: '好友',
    icon: 'i-carbon-user-multiple',
    component: () => import('@/views/Friends.vue'),
  },
  {
    path: 'pet',
    name: 'pet',
    label: '宠物',
    icon: 'i-carbon-dog-walker',
    component: () => import('@/views/Pet.vue'),
  },
  {
    path: 'activity',
    name: 'activity',
    label: '活动',
    icon: 'i-carbon-gift',
    component: () => import('@/views/Activity.vue'),
  },
  {
    path: 'shop',
    name: 'shop',
    label: '商城',
    icon: 'i-carbon-shopping-cart',
    component: () => import('@/views/Shop.vue'),
  },
  {
    path: 'illustrated',
    name: 'illustrated',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Illustrated.vue'),
  },
  {
    // 藏品（2026-11-02 上线的果冻花园系统，公告 26110102）
    path: 'collection',
    name: 'collection',
    label: '藏品',
    icon: 'i-carbon-cube',
    component: () => import('@/views/Collection.vue'),
  },
  {
    path: 'mutation-catalog',
    name: 'mutation-catalog',
    label: '变异宝典',
    icon: 'i-carbon-catalog',
    component: () => import('@/components/MutationCatalogPanel.vue'),
  },
  {
    path: 'analytics',
    name: 'analytics',
    label: '分析',
    icon: 'i-carbon-analytics',
    component: () => import('@/views/Analytics.vue'),
  },
  {
    path: 'settings',
    name: 'Settings',
    label: '设置',
    icon: 'i-carbon-settings',
    component: () => import('@/views/Settings.vue'),
  },
  {
    path: 'admin',
    name: 'admin',
    label: '后台',
    icon: 'i-carbon-settings-adjust',
    component: () => import('@/views/AdminPanel.vue'),
    adminOnly: true,
  },
]

// Each workspace owns a complete navigation tree. A matching label does not
// route ranch users to a farm business component or borrow its game writes.
export const ranchMenuRoutes: MenuItem[] = [
  { path: 'ranch', name: 'ranch', label: '概览', icon: 'i-carbon-chart-pie', workspace: 'ranch', pageKey: 'overview',
    component: () => import('@/views/Ranch.vue'), props: { page: 'overview' } },
  { path: 'ranch/personal', name: 'ranch-personal', label: '个人', icon: 'i-carbon-user', workspace: 'ranch', pageKey: 'personal',
    component: () => import('@/views/Ranch.vue'), props: { page: 'personal' } },
  { path: 'ranch/friends', name: 'ranch-friends', label: '好友', icon: 'i-carbon-user-multiple', workspace: 'ranch', pageKey: 'friends',
    component: () => import('@/views/Ranch.vue'), props: { page: 'friends' } },
  { path: 'ranch/activity', name: 'ranch-activity', label: '活动', icon: 'i-carbon-gift', workspace: 'ranch', pageKey: 'activity',
    component: () => import('@/views/Ranch.vue'), props: { page: 'activity' } },
  { path: 'ranch/shop', name: 'ranch-shop', label: '商城', icon: 'i-carbon-shopping-cart', workspace: 'ranch', pageKey: 'shop',
    component: () => import('@/views/Ranch.vue'), props: { page: 'shop' } },
  { path: 'ranch/illustrated', name: 'ranch-illustrated', label: '图鉴', icon: 'i-carbon-book', workspace: 'ranch', pageKey: 'illustrated',
    component: () => import('@/views/Ranch.vue'), props: { page: 'illustrated' } },
  { path: 'ranch/settings', name: 'ranch-settings', label: '设置', icon: 'i-carbon-settings', workspace: 'ranch', pageKey: 'settings',
    component: () => import('@/views/Settings.vue') },
  { path: 'ranch/admin', name: 'ranch-admin', label: '后台', icon: 'i-carbon-settings-adjust', workspace: 'ranch', pageKey: 'admin', adminOnly: true,
    component: () => import('@/views/AdminPanel.vue') },
]

// The cross-account overview is auxiliary; it does not replace the original
// farm Dashboard or masquerade as either workspace's business overview.
const summaryRoutes: MenuItem[] = [
  { path: 'overview', name: 'overview', label: '总概览', icon: 'i-carbon-chart-pie', pageKey: 'summary', showInNav: false,
    component: () => import('@/views/Overview.vue') },
  { path: 'ranch/overview', name: 'ranch-overview', label: '总概览', icon: 'i-carbon-chart-pie', workspace: 'ranch', pageKey: 'summary', showInNav: false,
    component: () => import('@/views/Overview.vue') },
]
export const allMenuRoutes = [...menuRoutes, ...ranchMenuRoutes, ...summaryRoutes]

export function workspaceForRoute(route: { path?: string, meta?: Record<string, unknown> }): GameWorkspace {
  return route.meta?.gameWorkspace === 'ranch' || /^\/ranch(?:\/|$)/.test(route.path || '') ? 'ranch' : 'farm'
}
export function workspaceMenuRoutes(workspace: GameWorkspace) {
  return workspace === 'ranch' ? ranchMenuRoutes : menuRoutes
}
export function workspaceHomePath(workspace: GameWorkspace) { return workspace === 'ranch' ? '/ranch' : '/' }
export function workspaceSummaryPath(workspace: GameWorkspace) { return workspace === 'ranch' ? '/ranch/overview' : '/overview' }
function canonicalMenuPath(value: string) {
  const path = value.split(/[?#]/)[0] || '/'
  return path === '/farm' ? '/personal' : path === '/farm/status' ? '/' : path
}
export function menuForRoute(route: { path: string }) {
  return allMenuRoutes.find(item => `/${item.path}` === canonicalMenuPath(route.path))
}
export function workspaceSwitchPath(route: { path: string, meta?: Record<string, unknown> }) {
  const target: GameWorkspace = workspaceForRoute(route) === 'ranch' ? 'farm' : 'ranch'
  const current = menuForRoute(route)
  const role = current?.pageKey || current?.name.toLowerCase()
  const counterpart = [...workspaceMenuRoutes(target), ...summaryRoutes.filter(item => (item.workspace || 'farm') === target)]
    .find(item => (item.pageKey || item.name.toLowerCase()) === role)
  return counterpart ? `/${counterpart.path}` : workspaceHomePath(target)
}

const warmedCode = new Map<string, Promise<unknown>>()
// Load only the code/CSS for a likely destination. Importing never mounts a
// component or executes its setup/watchers, and never asks the game for data.
export function warmMenuCode(path: string) {
  const canonical = canonicalMenuPath(path)
  const page = allMenuRoutes.find(item => `/${item.path}` === canonical)
  if (!page || page.adminOnly || warmedCode.has(canonical))
    return
  const pending = page.component().catch(() => { warmedCode.delete(canonical) })
  warmedCode.set(canonical, pending)
}
