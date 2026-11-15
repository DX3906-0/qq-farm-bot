export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
  adminOnly?: boolean
  showInNav?: boolean
}

export const menuRoutes: MenuItem[] = [
  {
    path: '',
    name: 'dashboard',
    label: '概览',
    icon: 'i-carbon-chart-pie',
    component: () => import('@/views/Dashboard.vue'),
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

const warmedCode = new Map<string, Promise<unknown>>()
// Load only the code/CSS for a likely destination. Importing never mounts a
// component or executes its setup/watchers, and never asks the game for data.
export function warmMenuCode(path: string) {
  const page = menuRoutes.find(item => `/${item.path}` === path)
  if (!page || page.adminOnly || warmedCode.has(path))
    return
  const pending = page.component().catch(() => { warmedCode.delete(path) })
  warmedCode.set(path, pending)
}
