import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface DiscoveredActivity {
  id: number
  title?: string
  startTime?: number
  endTime?: number
  visible?: boolean
  enabled?: boolean
  groups?: Array<{
    id: number
    title?: string
    type?: number
    status?: number
    startTime?: number
    endTime?: number
    visible?: boolean
    enabled?: boolean
    children?: DiscoveredActivity[]
  }>
}

export const useActivityDiscoveryStore = defineStore('activityDiscovery', () => {
  // 新发现的未适配活动，null 表示没有
  const newActivity = ref<DiscoveredActivity | null>(null)
  const loading = ref(false)

  async function fetchDiscovery() {
    loading.value = true
    try {
      // 复用活动更新扫描的在线分组结果，取第一个未知活动作为待适配提示
      const { data } = await api.get('/api/activity/update/status')
      const groups = data?.report?.online?.groups
      const unknownIds: number[] = data?.report?.online?.unknownActivityIds || []
      if (!Array.isArray(groups) || !groups.length || !unknownIds.length) {
        newActivity.value = null
        return
      }
      const first = unknownIds[0]
      const found = groups.find(g => Number(g?.id) === Number(first))
      newActivity.value = found || { id: Number(first) }
    }
    catch {
      newActivity.value = null
    }
    finally {
      loading.value = false
    }
  }

  function clear() {
    newActivity.value = null
  }

  return {
    newActivity,
    loading,
    fetchDiscovery,
    clear,
  }
})
