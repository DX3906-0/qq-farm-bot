import type { Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { computed, onScopeDispose, ref, watch, watchEffect } from 'vue'
import api, { createReadCoordinator, invalidateSafeReads, isReadCanceled, safeGet } from '@/api'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

interface AutomationSettingsSnapshot {
  automation: Record<string, unknown>
}

type AlertType = 'primary' | 'danger'

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

export function useStrategySettings({
  currentAccountId,
  activeTab,
  getAutomationSettings,
  showAlert,
}: {
  currentAccountId: Ref<string | number | null | undefined>
  activeTab?: Ref<string>
  getAutomationSettings: () => AutomationSettingsSnapshot
  showAlert: (message: string, type?: AlertType) => void
}) {
  const settingStore = useSettingStore()
  const farmStore = useFarmStore()
  const { settings, loading: settingsLoading } = storeToRefs(settingStore)
  const { seeds } = storeToRefs(farmStore)

  const strategySaving = ref(false)

  const localStrategySettings = ref({
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [] as number[],
    bagSeedKnownIds: [] as number[],
    bagSeedFallbackStrategy: 'level',
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    intervals: { farmMin: 2, farmMax: 5, helpMin: 10, helpMax: 15, stealMin: 10, stealMax: 15 },
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00', exemptGids: [10001] },
  })

  const plantingStrategyOptions = [
    { label: '优先种植种子', value: 'preferred' },
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '背包种子优先', value: 'bag_priority' },
  ]

  const bagFallbackStrategyOptions = [
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '优先种植种子', value: 'preferred' },
  ]

  const bagSeeds = ref<BagSeedItem[]>([])
  const bagSeedsLoading = ref(false)
  const bagSeedsError = ref<string | null>(null)
  const draggingBagSeedId = ref<number | null>(null)
  let bagSeedsRequestId = 0
  let strategyPreviewRequestId = 0
  let disposed = false
  let dataEpoch = 0
  const reads = createReadCoordinator()
  const visible = () => !disposed && (!activeTab || activeTab.value === 'strategy') && !document.hidden
  watch([currentAccountId, () => activeTab?.value], () => {
    dataEpoch++
    reads.invalidate()
    bagSeedsRequestId++
    strategyPreviewRequestId++
    bagSeedsLoading.value = false
    // Changing visible tabs invalidates reads only, never an already-sent save.
  }, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    dataEpoch++
    reads.invalidate()
    bagSeedsRequestId++
    strategyPreviewRequestId++
  })

  const sortedBagSeeds = computed(() => {
    const priority = localStrategySettings.value.bagSeedPriority || []
    const seedMap = new Map(bagSeeds.value.map(seed => [Number(seed.seedId), seed]))
    const orderedSeeds: BagSeedItem[] = []
    const seen = new Set<number>()

    for (const rawSeedId of priority) {
      const seedId = Number(rawSeedId)
      if (!seedId || seen.has(seedId))
        continue
      const seed = seedMap.get(seedId)
      if (!seed)
        continue
      seen.add(seedId)
      orderedSeeds.push(seed)
    }

    return orderedSeeds
  })

  function fetchBagSeeds() {
    if (!visible()) return Promise.resolve()
    return reads.run(`bag:${currentAccountId.value}:${dataEpoch}`, signal => readBagSeeds(signal))
  }
  async function readBagSeeds(signal: AbortSignal) {
    const accountId = currentAccountId.value
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++bagSeedsRequestId
    bagSeedsLoading.value = true
    bagSeedsError.value = null
    try {
      const res = await safeGet('/api/bag/seeds', {
        headers: { 'x-account-id': accountId }, signal,
      }, dataEpoch)
      if (!visible() || signal.aborted || requestId !== bagSeedsRequestId || String(currentAccountId.value || '') !== requestedId)
        return
      if (!res.data?.ok) throw new Error(res.data?.error || '背包种子读取失败')
      if (res.data.ok) {
        bagSeeds.value = res.data.data || []
        const currentIds = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
        const priority = localStrategySettings.value.bagSeedPriority || []
        const knownIds = localStrategySettings.value.bagSeedKnownIds || []

        if (knownIds.length === 0) {
          // Migration: remember the current inventory without restoring seeds that
          // the user deliberately removed from an existing priority list.
          if (priority.length === 0)
            localStrategySettings.value.bagSeedPriority = [...currentIds]
          localStrategySettings.value.bagSeedKnownIds = [...new Set([...priority, ...currentIds])]
        }
        else {
          const knownSet = new Set(knownIds.map(Number))
          const newIds = currentIds.filter(seedId => !knownSet.has(seedId))
          if (newIds.length > 0)
            localStrategySettings.value.bagSeedPriority = [...priority, ...newIds]
          localStrategySettings.value.bagSeedKnownIds = [...new Set([...knownIds, ...currentIds])]
        }
      }
    }
    catch (e: any) {
      if (isReadCanceled(e) || signal.aborted || !visible()) return
      if (requestId === bagSeedsRequestId && String(currentAccountId.value || '') === requestedId)
        bagSeedsError.value = e.message || '加载失败'
    }
    finally {
      if (requestId === bagSeedsRequestId)
        bagSeedsLoading.value = false
    }
  }

  function resetBagSeedPriority() {
    localStrategySettings.value.bagSeedPriority = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
  }

  function getCurrentBagSeedOrder() {
    return sortedBagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
  }

  function moveBagSeed(seedId: number, direction: -1 | 1) {
    const nextOrder = getCurrentBagSeedOrder()
    const index = nextOrder.indexOf(seedId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length)
      return

    const temp = nextOrder[index]!
    nextOrder[index] = nextOrder[targetIndex]!
    nextOrder[targetIndex] = temp
    localStrategySettings.value.bagSeedPriority = nextOrder
  }

  function removeBagSeedPriority(seedId: number) {
    localStrategySettings.value.bagSeedPriority = getCurrentBagSeedOrder()
      .filter(itemSeedId => itemSeedId !== Number(seedId))
  }

  function startBagSeedDrag(seedId: number, event: DragEvent) {
    draggingBagSeedId.value = seedId
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(seedId))
    }
  }

  function dragOverBagSeed(_seedId: number, event: DragEvent) {
    if (draggingBagSeedId.value === null)
      return
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = 'move'
  }

  function dropBagSeed(seedId: number, event: DragEvent) {
    event.preventDefault()
    const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
    if (!sourceSeedId || sourceSeedId === seedId) {
      draggingBagSeedId.value = null
      return
    }

    const nextOrder = getCurrentBagSeedOrder()
    const sourceIndex = nextOrder.indexOf(sourceSeedId)
    const targetIndex = nextOrder.indexOf(seedId)

    if (sourceIndex < 0 || targetIndex < 0) {
      draggingBagSeedId.value = null
      return
    }

    const [moved] = nextOrder.splice(sourceIndex, 1)
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    nextOrder.splice(newTargetIndex, 0, moved!)

    localStrategySettings.value.bagSeedPriority = nextOrder
    draggingBagSeedId.value = null
  }

  watchEffect(() => {
    if (visible() && localStrategySettings.value.plantingStrategy === 'bag_priority' && currentAccountId.value) {
      void fetchBagSeeds().catch(() => {})
    }
  })

  const bagSeedsRefreshTimer = window.setInterval(() => {
    if (visible() && localStrategySettings.value.plantingStrategy === 'bag_priority' && currentAccountId.value && !bagSeedsLoading.value)
      void fetchBagSeeds().catch(() => {})
  }, 15_000)
  onScopeDispose(() => window.clearInterval(bagSeedsRefreshTimer))

  const preferredSeedOptions = computed(() => {
    const options: { label: string, value: number, disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
    if (seeds.value) {
      options.push(...seeds.value.map(seed => ({
        label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
        value: seed.seedId,
        disabled: seed.locked || seed.soldOut,
      })))
    }
    return options
  })

  const strategyPreviewLabel = ref<string | null>(null)

  watchEffect(async (onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const requestId = ++strategyPreviewRequestId
    if (!visible()) return
    let strategy = localStrategySettings.value.plantingStrategy
    if (strategy === 'preferred') {
      strategyPreviewLabel.value = null
      return
    }
    if (strategy === 'bag_priority') {
      strategy = localStrategySettings.value.bagSeedFallbackStrategy || 'level'
      if (strategy === 'preferred') {
        const preferredId = localStrategySettings.value.preferredSeedId
        if (preferredId > 0 && seeds.value) {
          const seed = seeds.value.find(s => s.seedId === preferredId)
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '未选择优先种子'
        }
        else {
          strategyPreviewLabel.value = '未选择优先种子'
        }
        return
      }
    }
    if (!seeds.value || seeds.value.length === 0) {
      strategyPreviewLabel.value = null
      return
    }
    const available = seeds.value.filter(s => !s.locked && !s.soldOut)
    if (available.length === 0) {
      strategyPreviewLabel.value = '暂无可用种子'
      return
    }
    if (strategy === 'level') {
      const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
      strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
      return
    }
    const sortBy = analyticsSortByMap[strategy]
    if (sortBy) {
      try {
        const accountId = currentAccountId.value
        if (!accountId) {
          strategyPreviewLabel.value = null
          return
        }
        const requestedId = String(accountId)
        const res = await api.get(`/api/analytics?sort=${sortBy}`, {
          headers: { 'x-account-id': accountId }, signal: controller.signal,
        })
        if (!visible() || requestId !== strategyPreviewRequestId || String(currentAccountId.value || '') !== requestedId)
          return
        const rankings: any[] = res.data.ok ? (res.data.data || []) : []
        const availableIds = new Set(available.map(s => s.seedId))
        const match = rankings.find(r => availableIds.has(Number(r.seedId)))
        if (match) {
          const seed = available.find(s => s.seedId === Number(match.seedId))
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
        }
        else {
          strategyPreviewLabel.value = '暂无匹配种子'
        }
      }
      catch {
        if (requestId === strategyPreviewRequestId)
          strategyPreviewLabel.value = null
      }
    }
  })

  function syncLocalStrategySettings() {
    if (settings.value) {
      localStrategySettings.value = JSON.parse(JSON.stringify({
        plantingStrategy: settings.value.plantingStrategy,
        preferredSeedId: settings.value.preferredSeedId,
        prioritize2x2Crops: settings.value.prioritize2x2Crops === true,
        bagSeedPriority: settings.value.bagSeedPriority ?? [],
        bagSeedKnownIds: settings.value.bagSeedKnownIds ?? [],
        bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
        stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
        plantOrderRandom: !!settings.value.plantOrderRandom,
        plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
        intervals: settings.value.intervals,
        friendQuietHours: settings.value.friendQuietHours,
      }))
    }
  }

  function loadStrategyData() {
    if (disposed) return Promise.resolve()
    return reads.run(`strategy:${currentAccountId.value}:${dataEpoch}`, signal => readStrategyData(signal)).catch((error) => {
      if (!disposed && !isReadCanceled(error)) showAlert(error?.message || '策略加载失败', 'danger')
      return false
    })
  }
  async function readStrategyData(signal: AbortSignal) {
    if (currentAccountId.value) {
      const accountId = String(currentAccountId.value)
      const epoch = dataEpoch
      const loaded = await settingStore.fetchSettings(accountId)
      if (loaded === false || disposed || signal.aborted || epoch !== dataEpoch || String(currentAccountId.value) !== accountId) return false
      syncLocalStrategySettings()
      if (visible()) await farmStore.fetchSeeds(accountId, signal)
      return !disposed && !signal.aborted && epoch === dataEpoch && String(currentAccountId.value) === accountId
    }
  }

  watch(() => activeTab?.value, (tab) => {
    if (tab === 'strategy' && currentAccountId.value && visible())
      void reads.run(`seeds:${currentAccountId.value}:${dataEpoch}`, signal => farmStore.fetchSeeds(String(currentAccountId.value), signal)).catch(() => {})
  })

  async function saveStrategySettings() {
    if (!currentAccountId.value || strategySaving.value)
      return false
    const id = String(currentAccountId.value)
    const epoch = dataEpoch
    const current = () => !disposed && epoch === dataEpoch && id === String(currentAccountId.value)
    strategySaving.value = true
    invalidateSafeReads()
    try {
      // Save this editor only. The neighbouring automation editor may contain
      // unsaved switches; clicking "保存策略" must never apply those switches.
      const fullSettings = {
        ...localStrategySettings.value,
        automation: { harvest_delay_min: getAutomationSettings().automation.harvest_delay_min },
      }
      reads.invalidate()
      const res = await settingStore.saveSettings(id, fullSettings)
      if (!current()) return false
      if (res.ok) {
        showAlert('策略设置已保存', 'primary')
      }
      else {
        showAlert(`保存失败: ${res.error}`, 'danger')
      }
      return res.ok === true
    }
    catch (error: any) {
      if (current() && !isReadCanceled(error)) showAlert(error?.message || '策略保存失败', 'danger')
      return false
    }
    finally {
      invalidateSafeReads()
      if (current()) reads.invalidate()
      strategySaving.value = false
    }
  }

  function resetStrategyState() {
    dataEpoch++
    reads.invalidate()
    bagSeedsRequestId++
    strategyPreviewRequestId++
    bagSeeds.value = []
    bagSeedsError.value = null
    bagSeedsLoading.value = false
    draggingBagSeedId.value = null
    strategyPreviewLabel.value = null
  }

  return {
    settings,
    settingsLoading,
    strategySaving,
    localStrategySettings,
    plantingStrategyOptions,
    bagFallbackStrategyOptions,
    bagSeeds,
    bagSeedsLoading,
    bagSeedsError,
    sortedBagSeeds,
    preferredSeedOptions,
    strategyPreviewLabel,
    resetBagSeedPriority,
    moveBagSeed,
    removeBagSeedPriority,
    startBagSeedDrag,
    dragOverBagSeed,
    dropBagSeed,
    syncLocalStrategySettings,
    loadStrategyData,
    saveStrategySettings,
    resetStrategyState,
  }
}
