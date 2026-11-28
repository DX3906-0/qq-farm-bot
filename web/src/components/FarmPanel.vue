<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch } from 'vue'
import { isReadCanceled } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import FarmToolbar from '@/components/FarmToolbar.vue'
import LandCard from '@/components/LandCard.vue'
import LandDetailModal from '@/components/LandDetailModal.vue'
import { useAccountStore } from '@/stores/account'
import type { FarmOperationResponse } from '@/stores/farm'
import { useFarmStore } from '@/stores/farm'
import { useToastStore } from '@/stores/toast'
import { useStatusStore } from '@/stores/status'

const farmStore = useFarmStore()
const toast = useToastStore()

function showFarmOperationResult(result: FarmOperationResponse) {
  const harvested = result.harvestedLands?.length || 0
  if (!result.ok) {
    const partial = harvested > 0 ? `已收获 ${harvested} 块土地；` : result.hadWork ? '部分操作已完成；' : ''
    toast.error(`${partial}${result.error || '农场操作失败'}`)
  }
  else if (result.skipped || result.hadWork === false) {
    toast.info('当前没有可执行的农场操作，已跳过')
  }
  else if (result.success === true) {
    toast.success(harvested > 0 ? `已收获 ${harvested} 块土地` : `农场操作完成${result.actions?.length ? `：${result.actions.join('/')}` : ''}`)
  }
  else {
    toast.info('操作请求已返回，尚未确认完成')
  }
  if (result.refreshError)
    toast.warning(result.refreshError)
}
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { lands, summary, weather, loading, unifiedHarvest } = storeToRefs(farmStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected, currentStatusReady } = storeToRefs(statusStore)

let disposed = false
let refreshEpoch = 0
let readController = new AbortController()
let refreshFlight: { id: string, epoch: number, promise: Promise<void> } | undefined
let queuedRefresh: Promise<void> | undefined
onScopeDispose(() => {
  disposed = true
  refreshEpoch++
  readController.abort()
})
let operationRequest = 0
const operating = ref(false)
const farmLoaded = ref(false)
const confirmVisible = ref(false)
const selectedLandId = ref<number | null>(null)
const detailLandId = ref<number | null>(null)
const detailLand = computed(() => (lands.value as any[]).find(land => Number(land.id) === detailLandId.value) || null)

function openLandDetail(land: any) {
  detailLandId.value = Number(land?.id) || null
}

watch(currentAccountId, () => {
  detailLandId.value = null
})
const farmCanvas = ref<HTMLCanvasElement | null>(null)
const FARM_CANVAS_WIDTH = 1200
const FARM_CANVAS_HEIGHT = 650
const SINGLE_LAND_WIDTH = 210
const SINGLE_LAND_HEIGHT = 125
const LAND_STEP_X = 115
const LAND_STEP_Y = 59
const MERGED_LAND_WIDTH = SINGLE_LAND_WIDTH + LAND_STEP_X * 2
const MERGED_LAND_HEIGHT = SINGLE_LAND_HEIGHT + LAND_STEP_Y * 2
const FIELD_BACKGROUND_SCALE = 1.16
const FIELD_BACKGROUND_OFFSET_X = 10
const FIELD_BACKGROUND_OFFSET_Y = 8
const imageCache = new Map<string, HTMLImageElement>()
type PendingLandAction = 'fertilize' | 'remove'

const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
  bulkAction: '' as 'removeAll' | 'unifiedOn' | 'unifiedOff' | '',
  landAction: '' as PendingLandAction | '',
  land: null as any | null,
  type: 'primary' as 'primary' | 'danger',
})

async function executeOperate() {
  if (!currentAccountId.value || operating.value)
    return
  const operationAccountId = currentAccountId.value
  const request = ++operationRequest
  refreshEpoch++
  readController.abort()
  readController = new AbortController()
  const signal = readController.signal

  const config = confirmConfig.value
  if (!config.opType && !config.bulkAction && (!config.landAction || !config.land))
    return

  confirmVisible.value = false
  operating.value = true
  try {
    if (config.opType) {
      const result = await farmStore.operate(operationAccountId, config.opType, signal)
      if (!disposed && !signal.aborted && currentAccountId.value === operationAccountId)
        showFarmOperationResult(result)
    }
    else if (config.bulkAction === 'removeAll') {
      await farmStore.removeAllPlants(operationAccountId, signal)
    }
    else if (config.landAction === 'fertilize') {
      await farmStore.fertilizeLand(operationAccountId, Number(config.land.id), signal)
    }
    else if (config.landAction === 'remove') {
      await farmStore.removePlant(operationAccountId, Number(config.land.id), signal)
    }
    else if (config.bulkAction === 'unifiedOn') {
      await farmStore.setUnifiedHarvest(operationAccountId, true)
    }
    else if (config.bulkAction === 'unifiedOff') {
      await farmStore.setUnifiedHarvest(operationAccountId, false)
    }
  }
  catch (error: any) {
    if (!disposed && !signal.aborted && !isReadCanceled(error)) toast.error(error?.message || '农场操作失败')
  }
  finally {
    if (!disposed && currentAccountId.value === operationAccountId && request === operationRequest) operating.value = false
  }
}

function handleOperate(opType: string) {
  if (!currentAccountId.value || operating.value)
    return

  if (opType === 'all' || opType === 'harvest') {
    // 手动全收/收获点击即执行；危险的铲除、升级仍保留确认。
    confirmConfig.value = { ...confirmConfig.value, opType, bulkAction: '', landAction: '', land: null }
    void executeOperate().catch(() => {}) // 网络错误由请求层提示，避免未处理拒绝。
    return
  }

  const confirmMap: Record<string, string> = {
    harvest: '确定要收获所有成熟作物吗？',
    clear: '确定要执行一键务农吗？将自动浇水、除草、除虫。',
    plant: '确定要一键种植吗？(根据策略配置)',
    upgrade: '确定要升级所有可升级的土地吗？会按游戏条件消耗金币和对应道具；当前可升级的蓝晶优先，其余不等待。',
    all: '确定要执行一键全收吗？将依次执行收获、务农、种植与升级。',
  }

  confirmConfig.value = {
    title: '确认操作',
    message: confirmMap[opType] || '确定执行此操作吗？',
    opType,
    bulkAction: '',
    landAction: '',
    land: null,
    type: 'primary',
  }
  confirmVisible.value = true
}

function handleRemoveAllPlants() {
  if (!currentAccountId.value)
    return

  confirmConfig.value = {
    title: '确认一键铲除',
    message: '确定要铲除全部已种植作物吗？此操作不可恢复。',
    opType: '',
    bulkAction: 'removeAll',
    landAction: '',
    land: null,
    type: 'danger',
  }
  confirmVisible.value = true
}

/** 统一时间收获：等当前所有土地中最后一块地成熟，再统一一键收取 */
function handleUnifiedHarvest() {
  if (!currentAccountId.value)
    return

  const turningOn = !unifiedHarvest.value
  confirmConfig.value = {
    title: turningOn ? '确认开启统一时间收获' : '确认取消统一时间收获',
    message: turningOn
      ? '将等待当前所有土地中最后一块地成熟后再统一一键收取；若已开启「延迟收获」，还会再静默设定时间。最多等待 6 小时。'
      : '取消后将恢复常规的自动收获节奏。',
    opType: '',
    bulkAction: turningOn ? 'unifiedOn' : 'unifiedOff',
    landAction: '',
    land: null,
    type: 'primary',
  }
  confirmVisible.value = true
}

function getLandActionName(land: any) {
  return `#${land?.id ?? '-'} ${land?.plantName || '该作物'}`
}

function handleLandFertilize(land: any) {
  if (!currentAccountId.value)
    return

  confirmConfig.value = {
    title: '确认催熟',
    message: `确定要对 ${getLandActionName(land)} 使用有机肥料催熟吗？`,
    opType: '',
    bulkAction: '',
    landAction: 'fertilize',
    land,
    type: 'primary',
  }
  confirmVisible.value = true
}

function handleLandRemove(land: any) {
  if (!currentAccountId.value)
    return

  confirmConfig.value = {
    title: '确认铲除',
    message: `确定要铲除 ${getLandActionName(land)} 吗？此操作不可恢复。`,
    opType: '',
    bulkAction: '',
    landAction: 'remove',
    land,
    type: 'danger',
  }
  confirmVisible.value = true
}

function refresh(): Promise<void> {
  const id = String(currentAccountId.value || '')
  const epoch = refreshEpoch
  if (disposed || document.hidden || !id || !currentAccount.value) return Promise.resolve()
  if (refreshFlight?.id === id && refreshFlight.epoch === epoch) return refreshFlight.promise
  if (refreshFlight) {
    if (!queuedRefresh) queuedRefresh = refreshFlight.promise.catch(() => {}).then(async () => {
      queuedRefresh = undefined
      if (!disposed) await refresh()
    })
    return queuedRefresh
  }
  const signal = readController.signal
  const valid = () => !disposed && !signal.aborted && !document.hidden && epoch === refreshEpoch && String(currentAccountId.value) === id
  const flight = { id, epoch, promise: (async () => {
    try {
      if (!realtimeConnected.value) await statusStore.fetchStatus(id)
      if (!valid()) return
      if (currentAccount.value?.running) {
        const applied = await farmStore.fetchLands(id, signal)
        if (applied === false || !valid()) return
        await farmStore.fetchUnifiedHarvest(id, signal)
      }
    }
    catch (error) {
      if (valid() && !isReadCanceled(error)) throw error
    }
    finally {
      if (valid()) farmLoaded.value = true
    }
  })().finally(() => {
    if (refreshFlight === flight) refreshFlight = undefined
  }) }
  refreshFlight = flight
  return flight.promise
}

const showInitialLoading = computed(() =>
  !farmLoaded.value && (loading.value || statusLoading.value),
)

function selectLand(land: any) {
  const id = Number(land?.id) || null
  selectedLandId.value = selectedLandId.value === id ? null : id
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (selectedLandId.value === null)
    return
  const target = event.target
  if (target instanceof Element && target.closest('.land-card, .land-bubble'))
    return
  selectedLandId.value = null
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape')
    selectedLandId.value = null
}

function getLandAnchorId(land: any) {
  const occupiedIds = Array.isArray(land?.occupiedLandIds)
    ? land.occupiedLandIds.map(Number).filter((id: number) => id > 0)
    : []
  return occupiedIds.length > 1 ? Math.min(...occupiedIds) : Number(land?.id) || 0
}

function getCanvasPosition(land: any) {
  const occupiedIds = Array.isArray(land?.occupiedLandIds)
    ? land.occupiedLandIds.map(Number).filter((id: number) => id > 0)
    : []
  const ids = occupiedIds.length > 1 ? occupiedIds : [getLandAnchorId(land)]
  const points = ids.map((id: number) => {
    const column = (id - 1) % 4
    const row = Math.floor((id - 1) / 4)
    return { x: 700 + column * LAND_STEP_X - row * LAND_STEP_X, y: 86 + (column + row) * LAND_STEP_Y }
  })
  return {
    x: points.reduce((sum: number, point: { x: number }) => sum + point.x, 0) / points.length,
    y: points.reduce((sum: number, point: { y: number }) => sum + point.y, 0) / points.length,
  }
}

const displayLands = computed(() =>
  (Array.isArray(lands.value) ? lands.value : []).filter(land => !land?.occupiedByMaster),
)

function getLandTextureUrl(land: any) {
  const level = Math.min(6, Math.max(1, Number(land?.level) || 1))
  if (land?.status === 'locked')
    return '/game-config/land_images/land_locked.png'
  // 与卡片共用同源清晰小格/四格资源，保留各自尺寸；不使用旧缩略图或降为紫晶。
  if (level === 6)
    return Number(land?.plantSize) > 1
      ? '/game-config/land_images/land_valid6_2x2.png'
      : '/game-config/land_images/land_valid6.png'
  if (Number(land?.plantSize) > 1)
    return `/game-config/land_images/land_valid${level}_2x2.png`
  return `/game-config/land_images/${land?.needWater ? `land_dry${level}` : `land_valid${level}`}.png`
}

function loadCanvasImage(src: string) {
  const cached = imageCache.get(src)
  if (cached)
    return Promise.resolve(cached)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      imageCache.set(src, image)
      resolve(image)
    }
    image.onerror = reject
    image.src = src
  })
}

async function drawFarmCanvas() {
  await nextTick()
  const context = farmCanvas.value?.getContext('2d')
  if (!context)
    return
  context.clearRect(0, 0, FARM_CANVAS_WIDTH, FARM_CANVAS_HEIGHT)
  const field = await loadCanvasImage('/game-config/scene_images/farm-field-base.png').catch(() => null)
  if (field) {
    const fieldWidth = FARM_CANVAS_WIDTH * FIELD_BACKGROUND_SCALE
    const fieldHeight = FARM_CANVAS_HEIGHT * FIELD_BACKGROUND_SCALE
    context.drawImage(
      field,
      (FARM_CANVAS_WIDTH - fieldWidth) / 2 + FIELD_BACKGROUND_OFFSET_X,
      (FARM_CANVAS_HEIGHT - fieldHeight) / 2 + FIELD_BACKGROUND_OFFSET_Y,
      fieldWidth,
      fieldHeight,
    )
  }

  const visibleLands = displayLands.value
    .sort((a, b) => getCanvasPosition(a).y - getCanvasPosition(b).y)
  const textures = await Promise.all(visibleLands.map(land => loadCanvasImage(getLandTextureUrl(land)).catch(() => null)))
  visibleLands.forEach((land, index) => {
    if (selectedLandId.value === Number(land?.id))
      return
    const texture = textures[index]
    if (!texture)
      return
    const { x, y } = getCanvasPosition(land)
    const large = Number(land?.plantSize) > 1
    const width = large ? MERGED_LAND_WIDTH : SINGLE_LAND_WIDTH
    const height = large ? MERGED_LAND_HEIGHT : SINGLE_LAND_HEIGHT
    context.drawImage(texture, x - width / 2, y - height / 2, width, height)
  })
}

function getIsometricStyle(land: any) {
  const { x, y } = getCanvasPosition(land)
  const size = Math.max(1, Number(land?.plantSize) || 1)
  const width = size > 1 ? MERGED_LAND_WIDTH : SINGLE_LAND_WIDTH
  const height = size > 1 ? MERGED_LAND_HEIGHT : SINGLE_LAND_HEIGHT

  return {
    left: `${x / FARM_CANVAS_WIDTH * 100}%`,
    top: `${(y - height / 2) / FARM_CANVAS_HEIGHT * 100}%`,
    width: `${width / FARM_CANVAS_WIDTH * 100}%`,
    height: `${height / FARM_CANVAS_HEIGHT * 100}%`,
    zIndex: Math.round(y) + size,
  }
}

watch(lands, () => {
  drawFarmCanvas()
}, { flush: 'post' })

watch(selectedLandId, () => {
  drawFarmCanvas()
})

watch(currentAccountId, (newId, oldId) => {
  refreshEpoch++
  readController.abort()
  readController = new AbortController()
  if (oldId !== undefined && newId !== oldId) {
    farmLoaded.value = false
    operationRequest++
    operating.value = false
    confirmVisible.value = false
    farmStore.clearFarmData()
    statusStore.clearAccountScopedData()
    selectedLandId.value = null
  }
  void refresh().catch(() => {})
}, { immediate: true, flush: 'sync' })

watch(() => currentAccount.value?.running, () => {
  void refresh().catch(() => {})
})

watch(confirmVisible, (visible) => {
  if (visible)
    selectedLandId.value = null
})

const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(() => { void refresh().catch(() => {}) }, 60000, { immediate: false })
function syncRefreshVisibility() {
  if (document.hidden) {
    pauseRefresh()
    refreshEpoch++
    readController.abort()
    readController = new AbortController()
  }
  else if (!disposed) resumeRefresh()
}
syncRefreshVisibility()
onMounted(() => {
  document.addEventListener('visibilitychange', syncRefreshVisibility)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  drawFarmCanvas()
})
onUnmounted(() => {
  pauseRefresh()
  document.removeEventListener('visibilitychange', syncRefreshVisibility)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
})
</script>

<template>
  <div
    class="space-y-4"
    :class="{
      'farm-panel-modal-open': confirmVisible,
      'farm-has-selected-land': selectedLandId !== null,
    }"
  >
    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <FarmToolbar
        :operating="operating"
        :unified-harvest="unifiedHarvest"
        :summary="summary"
        @operate="handleOperate"
        @remove-all="handleRemoveAllPlants"
        @unified-harvest="handleUnifiedHarvest"
      />

      <!-- Grid -->
      <div class="p-2 sm:p-4">
        <div v-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-user-offline text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              未登录账号
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先添加农场账号
            </div>
          </div>
        </div>

        <template v-else>
          <div class="farm-land-viewport rounded-2xl">
            <div class="iso-farm-stage">
              <canvas
                ref="farmCanvas"
                class="farm-scene-canvas"
                :width="FARM_CANVAS_WIDTH"
                :height="FARM_CANVAS_HEIGHT"
                aria-hidden="true"
              />
              <div v-if="weather?.rainstorm" class="farm-rainstorm-effect" aria-hidden="true">
                <img class="farm-rain-fog" src="/game-config/effect_images/rain-poem/rain-fog.png" alt="">
                <div class="farm-rain-streaks farm-rain-streaks-a" />
                <div class="farm-rain-streaks farm-rain-streaks-b" />
                <div class="farm-thunder-flash" />
              </div>
              <LandCard
                v-for="land in displayLands"
                :key="land.id"
                :land="land"
                isometric
                show-details
                :style="getIsometricStyle(land)"
                :selected="selectedLandId === Number(land.id)"
                :selection-active="selectedLandId !== null"
                :show-actions="false"
                @select="selectLand"
                @details="openLandDetail"
                @fertilize="handleLandFertilize"
                @remove="handleLandRemove"
              />
            </div>
          </div>

          <div v-if="showInitialLoading" class="mt-3 flex items-center justify-center gap-2 text-sm text-gray-400">
            <div class="i-svg-spinners-90-ring-with-bg text-lg text-blue-500" />
            加载土地中…
          </div>
          <div v-else-if="!currentAccount?.running" class="mt-3 rounded-lg bg-amber-50 p-3 text-center text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            账号未运行，请在「账号管理」中启动该账号
          </div>
          <div v-else-if="currentStatusReady && !status?.connection?.connected" class="mt-3 rounded-lg bg-orange-50 p-3 text-center text-sm text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
            账号未登录，请先运行账号或检查网络连接
          </div>
          <div v-else-if="lands.length === 0" class="mt-3 text-center text-sm text-gray-400">
            暂无土地数据
          </div>
        </template>
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      :type="confirmConfig.type"
      @confirm="executeOperate"
      @close="confirmVisible = false"
      @cancel="confirmVisible = false"
    />

    <LandDetailModal
      :land="detailLand"
      :connected="!!status?.connection?.connected"
      @close="detailLandId = null"
    />
  </div>
</template>

<style scoped>
.farm-land-viewport {
  /* 由卡片内容宽度决定大小；不再为塞进剩余屏高而缩小土地与作物。 */
  width: 100%;
  max-width: 1200px;
  container-type: inline-size;
  overflow: hidden;
  margin-inline: auto;
  background: #a8d85d;
  box-shadow: inset 0 0 0 1px rgb(53 101 37 / 0.18);
}

.farm-panel-modal-open :deep(.land-bubble) {
  display: none !important;
}

.farm-panel-modal-open :deep(.land-card) {
  z-index: 0 !important;
}

.farm-has-selected-land :deep(.land-card:not(.land-card-selected) .land-bubble) {
  display: none !important;
}

.iso-farm-stage {
  position: relative;
  isolation: isolate;
  width: 100%;
  aspect-ratio: 1200 / 650;
  margin: 0 auto;
}

.farm-scene-canvas {
  position: absolute;
  z-index: 0;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.farm-rainstorm-effect {
  position: absolute;
  z-index: 1000;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background: rgb(15 32 55 / 0.18);
}

.farm-rain-fog,
.farm-rain-streaks,
.farm-thunder-flash {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.farm-rain-fog {
  object-fit: cover;
  opacity: 0.18;
  mix-blend-mode: screen;
  animation: farm-rain-fog-drift 8s ease-in-out infinite alternate;
}

.farm-rain-streaks {
  inset: -24%;
  width: 148%;
  height: 148%;
  background-image: url('/game-config/effect_images/rain-poem/rain-streaks.png');
  background-repeat: repeat;
  background-size: 36% auto;
  opacity: 0.52;
  filter: drop-shadow(1px 2px 1px rgb(155 211 255 / 0.42));
  transform: rotate(4deg);
  animation: farm-rain-fall 0.78s linear infinite;
}

.farm-rain-streaks-b {
  background-size: 25% auto;
  opacity: 0.28;
  transform: rotate(7deg) scaleX(-1);
  animation-delay: -0.4s;
  animation-duration: 1.08s;
}

.farm-thunder-flash {
  background: rgb(208 235 255 / 0.72);
  opacity: 0;
  animation: farm-thunder-flash 7.5s steps(1, end) infinite;
}

@keyframes farm-rain-fall {
  from {
    background-position: 0 -45%;
  }
  to {
    background-position: -5% 0;
  }
}

@keyframes farm-rain-fog-drift {
  from {
    transform: translateX(-4%) scale(1.08);
  }
  to {
    transform: translateX(4%) scale(1.12);
  }
}

@keyframes farm-thunder-flash {
  0%,
  3%,
  5%,
  48%,
  51%,
  100% {
    opacity: 0;
  }
  2%,
  4% {
    opacity: 0.75;
  }
  49% {
    opacity: 0.42;
  }
}

@media (prefers-reduced-motion: reduce) {
  .farm-rain-fog,
  .farm-rain-streaks,
  .farm-thunder-flash {
    animation: none;
  }
}

.iso-farm-stage :deep(.land-card) {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.iso-farm-stage :deep(.land-card-image) {
  position: absolute;
  left: 50%;
  top: 35%;
  width: 42%;
  height: 68%;
  margin: 0;
  transform: translate(-50%, -50%);
}

/* 通用种子贴图的内容锚点在图片中央，单格种子应落在土地几何中心。 */
.iso-farm-stage :deep(.land-card-image-seed-single) {
  top: 50%;
}

/* SpriteFrame 已裁掉透明画布；保持它在原 150px 画布中的官方视觉尺寸。 */
.iso-farm-stage :deep(.land-card-image-seed img) {
  width: 23%;
  max-width: none;
}

.iso-farm-stage :deep(.land-isometric-size-2 .land-card-image) {
  left: 50%;
  /* 2x2 作物通常是高图，客户端按根部/花盆底部落在四格土地中心，而不是按图片中心。 */
  top: auto;
  bottom: 42%;
  width: 56%;
  /* 顶排四格土地距离场景上沿较近，必须给高株成熟图保留完整显示空间。 */
  height: 54%;
  align-items: flex-end;
  transform: translateX(-50%);
}

.iso-farm-stage :deep(.land-isometric-size-2 .land-card-image-seed) {
  top: 50%;
  bottom: auto;
  align-items: center;
  transform: translate(-50%, -50%);
}

.iso-farm-stage :deep(.land-isometric-size-2 .land-card-image-seed img) {
  width: 13%;
}

/* 乐园变异（4 格）官方立绘需要放大并对齐根部，避免在 2x2 卡位里显得过小。 */
.iso-farm-stage :deep(.land-isometric-size-2 .land-card-image-paradise .land-crop-image) {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  transform: scale(1.35);
  transform-origin: 50% 82%;
  object-fit: contain;
}

.iso-farm-stage :deep(.land-card-name),
.iso-farm-stage :deep(.land-card-meta),
.iso-farm-stage :deep(.land-card-season) {
  display: none;
}

.iso-farm-stage :deep(.land-card-flags),
.iso-farm-stage :deep(.land-mutant-effects) {
  display: none;
}

.iso-farm-stage :deep(.land-ground-single),
.iso-farm-stage :deep(.land-ground-merged) {
  display: none;
}

.iso-farm-stage :deep(.land-card-selected .land-ground-single),
.iso-farm-stage :deep(.land-card-selected .land-ground-merged) {
  display: block;
  left: 50%;
  top: 50%;
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: fill;
  opacity: 1;
  transform: translate(-50%, -50%);
  filter: saturate(1.08) brightness(1.06) drop-shadow(0 10px 7px rgb(62 46 27 / 0.35));
}

.iso-farm-stage :deep(.land-card-selected .land-ground-layer) {
  inset: 0;
}

.iso-farm-stage :deep(.land-isometric-size-2 .land-ground-merged) {
  width: 100%;
  max-height: none;
}

.iso-farm-stage :deep(.land-isometric-size-2 .land-ground-layer) {
  inset: 0;
}

@media (max-width: 639px) {
  .iso-farm-stage {
    width: 100%;
  }

  .iso-farm-stage :deep(.land-card) {
    padding: 1px;
  }

  .iso-farm-stage :deep(.land-card-image) {
    width: 42%;
    height: 68%;
    margin: 0;
  }

  .iso-farm-stage :deep(.land-isometric-size-2 .land-card-image) {
    width: 56%;
    height: 54%;
    margin: 0;
  }

  .iso-farm-stage :deep(.land-card-id) {
    font-size: 8px;
  }
}
</style>
