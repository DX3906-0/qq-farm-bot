<script setup lang="ts">
import api, { isReadCanceled } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { operationFailure, resultIsUnknown } from '@/utils/operation-result'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

interface SkinItem {
  skinId: number
  slotType: number
  name: string
  image: string
  partName: string
  equipped: boolean
  isNew: boolean
  desc: string
  resultUnknown?: boolean
}
interface SkinSlot {
  slotType: number
  label: string
  equippedSkinId: number
  resultUnknown?: boolean
}
interface SkinPartItem {
  partId: number
  skinId: number
  parentSlotType: number
  partSlotType: number
  name: string
  image: string
  owned: boolean
  enabled: boolean
  isDefault: boolean
  isNew: boolean
  selected: boolean
}
interface SkinCustomization {
  skinId: number
  slotType: number
  name: string
  image: string
  equipped: boolean
  stateKnown: boolean
  stateError?: string
  resultUnknown: boolean
  partIds: number[]
  groups: Array<{ partSlotType: number, label: string, selectedPartId: number, parts: SkinPartItem[] }>
}

const accountStore = useAccountStore()

const loading = ref(false)
const error = ref('')
const slots = ref<SkinSlot[]>([])
const items = ref<SkinItem[]>([])
const ownedCount = ref(0)
const switchingId = ref(0)
const toast = ref('')
const stateReady = ref(false)
const warnings = ref<string[]>([])
const confirmItem = ref<SkinItem | null>(null)
const customizations = ref<SkinCustomization[]>([])
const partImageErrors = ref<Record<number, boolean>>({})
const confirmPart = ref<{ part: SkinPartItem, house: SkinCustomization, expectedPartIds: number[] } | null>(null)
let disposed = false
let accountEpoch = 0
let readRevision = 0
let readFlight: { accountId: string, epoch: number, promise: Promise<void> } | null = null
let readController: AbortController | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
/** 放大预览 */
const preview = ref<SkinItem | null>(null)

const accountId = computed(() => String(accountStore.currentAccountId || ''))
const pending = computed(() => switchingId.value !== 0 || accountStore.hasPendingSkinMutation(accountId.value))
const unknownSlots = computed(() => slots.value.filter(slot => slot.resultUnknown === true || accountStore.skinMutationState(accountId.value, slot.slotType) === 'unknown'))
function canEquip(item: SkinItem) {
  return !!accountId.value && stateReady.value && !loading.value && !pending.value && !item.equipped
    && item.resultUnknown !== true && accountStore.skinMutationState(accountId.value, item.slotType) === 'idle'
}
function currentContext(id: string, epoch: number) { return !disposed && id === accountId.value && epoch === accountEpoch }

/** 当前装备（用于顶部"当前外观"速览） */
const equippedItems = computed(() => items.value.filter(i => i.equipped))

/** 按槽位分组；每组内已装备的排最前 */
const grouped = computed(() => {
  const map = new Map<number, SkinItem[]>()
  for (const it of items.value) {
    if (!map.has(it.slotType))
      map.set(it.slotType, [])
    map.get(it.slotType)!.push(it)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slotType, list]) => ({
      slotType,
      label: slots.value.find(s => s.slotType === slotType)?.label || `槽位${slotType}`,
      list: [...list].sort((a, b) => (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) || a.skinId - b.skinId),
    }))
})

function canApplyPart(house: SkinCustomization, part: SkinPartItem) {
  return !!accountId.value && stateReady.value && !loading.value && !pending.value && house.equipped
    && house.stateKnown && !house.resultUnknown && part.enabled === true && part.owned === true && !part.selected
    && accountStore.skinMutationState(accountId.value, house.slotType) === 'idle'
}
function applyEquippedState(equipped: any[]) {
  const current = new Map(equipped.map(row => [Number(row.slotType), row]))
  for (const item of items.value) item.equipped = Number(current.get(item.slotType)?.skinId) === item.skinId
  for (const slot of slots.value) slot.equippedSkinId = Number(current.get(slot.slotType)?.skinId) || 0
  for (const house of customizations.value) {
    const row = current.get(house.slotType)
    house.equipped = Number(row?.skinId) === house.skinId
    if (!house.equipped) continue
    const allParts = house.groups.flatMap(group => group.parts)
    if (!Array.isArray(row.partIds) || row.partIds.some((id: unknown) => !allParts.some(part => part.partId === Number(id)))) {
      house.stateKnown = false
      house.stateError = '当前小屋搭配尚未完整返回，请刷新核对'
      continue
    }
    house.partIds = row.partIds.map(Number).filter((id: number) => !allParts.find(part => part.partId === id)?.isDefault)
    for (const group of house.groups) {
      group.selectedPartId = house.partIds.find(id => group.parts.some(part => part.partId === id))
        || group.parts.find(part => part.isDefault)!.partId
      for (const part of group.parts) part.selected = part.partId === group.selectedPartId
    }
  }
}
function requestPart(house: SkinCustomization, part: SkinPartItem) {
  if (!canApplyPart(house, part)) return
  confirmItem.value = null
  preview.value = null
  confirmPart.value = { part: { ...part }, house: { ...house }, expectedPartIds: [...house.partIds] }
}
function closePartConfirmation() { if (!pending.value) confirmPart.value = null }
async function confirmPartEquip() {
  const action = confirmPart.value
  if (!action || !canApplyPart(action.house, action.part)) return
  const id = accountId.value, epoch = accountEpoch
  const target = { ...action.part }, house = action.house
  const expectedAfter = action.expectedPartIds.filter(partId => !house.groups.find(group => group.partSlotType === target.partSlotType)?.parts.some(part => part.partId === partId))
  if (!target.isDefault) expectedAfter.push(target.partId)
  const sameIds = (ids: any) => Array.isArray(ids) && ids.length === expectedAfter.length
    && new Set(ids.map(Number)).size === ids.length
    && [...ids].map(Number).sort((a, b) => a - b).every((value, index) => value === [...expectedAfter].sort((a, b) => a - b)[index])
  switchingId.value = target.partId
  accountStore.setSkinMutationState(id, house.slotType, 'pending')
  readRevision++
  readController?.abort()
  loading.value = false
  let finalState: 'unknown' | 'idle' = 'unknown'
  try {
    const { data } = await api.post('/api/skins/parts/equip', {
      skinId: house.skinId, partId: target.partId, expectedPartIds: action.expectedPartIds, confirmed: true,
    }, { timeout: 70000, headers: { 'x-account-id': id } })
    if (data?.ok !== true || resultIsUnknown(data) || resultIsUnknown(data.data)) throw { response: { data } }
    const result = data.data
    if (result?.accountId !== id) throw new Error('部件回复的账号未确认')
    if (result.skipped === true && result.reason === 'already_in_target_state') {
      finalState = 'idle'
      if (currentContext(id, epoch)) { stateReady.value = false; showFeedback('服务端已是此搭配，请刷新查看') }
      return
    }
    if (result.resultState !== 'completed' || result.confirmation !== 'SkinsEquipped' || result.method !== 'EquipSkinPart'
      || Number(result.skinId) !== house.skinId || Number(result.partId) !== target.partId || Number(result.slotType) !== house.slotType
      || Number(result.operate) !== (target.isDefault ? 2 : 1) || !sameIds(result.partIds)
      || !Array.isArray(result.equipped) || new Set(result.equipped.map((row: any) => Number(row.slotType))).size !== result.equipped.length
      || !sameIds(result.equipped.find((row: any) => Number(row.slotType) === house.slotType && Number(row.skinId) === house.skinId)?.partIds?.filter((partId: number) => !house.groups.some(group => group.parts.some(part => part.partId === Number(partId) && part.isDefault))))) {
      throw new Error('当前装备未确认目标小屋搭配')
    }
    finalState = 'idle'
    if (!currentContext(id, epoch)) return
    applyEquippedState(result.equipped)
    showFeedback(`已${target.isDefault ? '恢复默认' : '应用'}「${target.name}」`)
  } catch (error: any) {
    const result = operationFailure(error, '部件结果未确认')
    finalState = result.outcomeUnknown ? 'unknown' : 'idle'
    if (currentContext(id, epoch)) {
      if (finalState === 'unknown') stateReady.value = false
      showFeedback(finalState === 'unknown' ? `${result.error}；仅刷新核对，不重复提交。` : result.error)
    }
  } finally {
    accountStore.setSkinMutationState(id, house.slotType, finalState)
    if (currentContext(id, epoch)) { switchingId.value = 0; confirmPart.value = null }
  }
}

function showFeedback(message: string) {
  clearTimeout(toastTimer)
  toast.value = message
  toastTimer = setTimeout(() => { if (!disposed) toast.value = '' }, 4200)
}
function load(): Promise<void> {
  const id = accountId.value
  const epoch = accountEpoch
  if (!id || disposed || pending.value) return Promise.resolve()
  if (readFlight?.accountId === id && readFlight.epoch === epoch) return readFlight.promise
  const controller = new AbortController()
  readController = controller
  const revision = ++readRevision
  confirmItem.value = null
  loading.value = true
  stateReady.value = false
  error.value = ''
  const flight = { accountId: id, epoch, promise: Promise.resolve() }
  flight.promise = api.get('/api/skins', { timeout: 120000, signal: controller.signal, headers: { 'x-account-id': id } }).then(({ data }) => {
    if (!currentContext(id, epoch) || revision !== readRevision || controller.signal.aborted) return
    const payload = data?.data
    if (data?.ok !== true || payload?.accountId != null && String(payload.accountId) !== id
      || !Array.isArray(payload?.slots) || !Array.isArray(payload?.items)) throw new Error(data?.error || '装扮状态未返回完整列表')
    const validId = (value: unknown) => typeof value !== 'boolean' && Number.isSafeInteger(Number(value)) && Number(value) > 0
    const nextSlots = payload.slots as SkinSlot[], nextItems = payload.items as SkinItem[]
    if (nextSlots.some(slot => !validId(slot.slotType) || typeof slot.equippedSkinId === 'boolean' || !Number.isSafeInteger(Number(slot.equippedSkinId)) || Number(slot.equippedSkinId) < 0)
      || new Set(nextSlots.map(slot => Number(slot.slotType))).size !== nextSlots.length
      || nextItems.some(item => !validId(item.skinId) || !validId(item.slotType) || typeof item.equipped !== 'boolean')
      || new Set(nextItems.map(item => `${item.slotType}:${item.skinId}`)).size !== nextItems.length
      || nextSlots.some(slot => {
        const worn = nextItems.filter(item => Number(item.slotType) === Number(slot.slotType) && item.equipped === true)
        return worn.length > 1 || worn.length === 1 && Number(worn[0]!.skinId) !== Number(slot.equippedSkinId)
      })) throw new Error('当前装扮列表存在冲突，请刷新核对，不猜测当前外观')
    const nextCustomizations = (payload.customizations === undefined ? [] : payload.customizations) as SkinCustomization[]
    if (!Array.isArray(nextCustomizations) || new Set(nextCustomizations.map(house => house.skinId)).size !== nextCustomizations.length
      || nextCustomizations.some(house => !validId(house.skinId) || !validId(house.slotType)
        || typeof house.equipped !== 'boolean' || typeof house.stateKnown !== 'boolean'
        || !Array.isArray(house.partIds) || house.partIds.some(id => !validId(id))
        || new Set(house.partIds).size !== house.partIds.length || !Array.isArray(house.groups)
        || new Set(house.groups.map(group => group.partSlotType)).size !== house.groups.length
        || house.groups.some(group => !validId(group.partSlotType) || !validId(group.selectedPartId) || !Array.isArray(group.parts)
          || group.parts.some(part => !validId(part.partId) || Number(part.skinId) !== Number(house.skinId)
            || Number(part.parentSlotType) !== Number(house.slotType) || Number(part.partSlotType) !== Number(group.partSlotType)
            || typeof part.owned !== 'boolean' || typeof part.isDefault !== 'boolean' || typeof part.selected !== 'boolean')))) {
      throw new Error('小屋部件状态不完整，请刷新核对')
    }
    customizations.value = nextCustomizations
    partImageErrors.value = {}
    slots.value = nextSlots
    items.value = nextItems
    ownedCount.value = nextItems.length
    warnings.value = Array.isArray(payload.warnings) ? payload.warnings.map(String) : []
    stateReady.value = payload.stateKnown !== false
    for (const slot of nextSlots) if (slot.resultUnknown === true) accountStore.setSkinMutationState(id, slot.slotType, 'unknown')
    // A successful overview read is not proof that an earlier unknown write
    // completed. Neither remount nor refresh clears its session/durable lock.
  }).catch((e: any) => {
    if (currentContext(id, epoch) && revision === readRevision && !controller.signal.aborted && !isReadCanceled(e)) {
      error.value = e?.response?.data?.error || e?.message || '读取装扮失败'
      stateReady.value = false
    }
  }).finally(() => {
    if (currentContext(id, epoch) && revision === readRevision) loading.value = false
    if (readFlight === flight) readFlight = null
    if (readController === controller) readController = null
  })
  readFlight = flight
  return flight.promise
}
function requestEquip(item: SkinItem) {
  if (!canEquip(item)) return
  preview.value = null
  confirmItem.value = { ...item }
}
function closeConfirmation() { if (!pending.value) confirmItem.value = null }
async function confirmEquip() {
  const item = confirmItem.value
  if (!item || !canEquip(item)) return
  const id = accountId.value, epoch = accountEpoch
  const slot = slots.value.find(entry => entry.slotType === item.slotType)
  if (!slot) return
  const target = { ...item }
  switchingId.value = target.skinId
  accountStore.setSkinMutationState(id, target.slotType, 'pending')
  readRevision++
  readController?.abort()
  loading.value = false
  let finalState: 'unknown' | 'idle' = 'unknown'
  try {
    const { data } = await api.post('/api/skins/equip', {
      skinId: target.skinId, slotType: target.slotType, confirmed: true,
      expectedEquippedSkinId: slot.equippedSkinId,
    }, { timeout: 70000, headers: { 'x-account-id': id } })
    if (data?.ok !== true || resultIsUnknown(data) || resultIsUnknown(data.data)) throw { response: { data } }
    const result = data.data
    if (result?.accountId !== id) throw new Error('换装回复的账号未确认')
    if (result.skipped === true && result.reason === 'already_in_target_state') {
      finalState = 'idle'
      if (currentContext(id, epoch)) { stateReady.value = false; showFeedback('服务端已是目标外观，请刷新查看，不再重复换装') }
      return
    }
    const equipped = result.equipped
    if (result.resultState !== 'completed' || result.confirmation !== 'SkinsEquipped'
      || Number(result.skinId) !== target.skinId || Number(result.slotType) !== target.slotType
      || !Array.isArray(equipped) || equipped.some(row => !Number.isSafeInteger(Number(row.skinId)) || Number(row.skinId) < 0 || !Number.isSafeInteger(Number(row.slotType)) || Number(row.slotType) <= 0)
      || new Set(equipped.map(row => Number(row.slotType))).size !== equipped.length
      || equipped.find(row => Number(row.slotType) === target.slotType)?.skinId !== target.skinId) throw new Error('当前装备未确认目标装扮')
    finalState = 'idle'
    if (!currentContext(id, epoch)) return
    applyEquippedState(equipped)
    showFeedback(`已确认换上「${target.name}」`)
  }
  catch (e: any) {
    const result = operationFailure(e, '换装结果未确认')
    finalState = result.outcomeUnknown ? 'unknown' : 'idle'
    if (currentContext(id, epoch)) {
      if (finalState === 'unknown') stateReady.value = false
      showFeedback(finalState === 'unknown' ? `${result.error}；仅刷新核对，不重复提交。` : result.error)
    }
  }
  finally {
    accountStore.setSkinMutationState(id, target.slotType, finalState)
    if (currentContext(id, epoch)) { switchingId.value = 0; confirmItem.value = null }
  }
}

function openPreview(item: SkinItem) {
  if (item.image)
    preview.value = item
}

watch(accountId, () => {
  accountEpoch++
  readRevision++
  readController?.abort()
  loading.value = false
  stateReady.value = false
  slots.value = []
  items.value = []
    ownedCount.value = 0
    customizations.value = []
    confirmPart.value = null
    partImageErrors.value = {}
    warnings.value = []
    switchingId.value = 0
  confirmItem.value = null
  preview.value = null
  toast.value = ''
  error.value = ''
  clearTimeout(toastTimer)
  void load()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  accountEpoch++
  readRevision++
  readController?.abort()
  clearTimeout(toastTimer)
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        装扮
      </h3>
      <span class="text-xs text-gray-500">{{ stateReady ? `已拥有 ${ownedCount} 件 · ${slots.length} 个槽位` : pending ? '换装结果正在确认' : loading ? '正在读取装扮' : '装扮状态待核对' }}</span>
      <BaseButton class="ml-auto" variant="secondary" size="sm" :loading="loading" :disabled="pending || !accountId" @click="load">
        刷新
      </BaseButton>
    </div>

    <p v-if="error" class="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-900/20 dark:text-rose-300">
      {{ error }}
    </p>

    <p v-if="unknownSlots.length" class="ui-notice" role="status">{{ unknownSlots.length }} 个装扮槽位有未确认操作；可刷新查看当前外观，但不会重复提交换装。</p>
    <p v-if="warnings.length" class="text-xs text-[var(--muted-text)]" role="status">{{ warnings.join('；') }}</p>
    <p v-if="!accountId" class="ui-empty-state">请选择账号后查看装扮。</p>
    <p v-else-if="!loading && !stateReady && !items.length" class="ui-empty-state" role="status">{{ pending ? '换装仍在确认中，不会重复提交。' : '当前装扮尚未读取，请刷新核对。' }}</p>
    <!-- 当前外观速览 -->
    <div v-if="equippedItems.length" class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 text-xs font-medium text-gray-500">
        {{ stateReady ? '当前外观' : '上次读取的外观 · 待核对' }}
      </div>
      <div class="flex flex-wrap gap-3">
        <button
          v-for="it in equippedItems" :key="it.skinId"
          class="flex w-16 flex-col items-center rounded-lg p-1 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          :title="it.name" @click="openPreview(it)"
        >
          <img
            v-if="it.image" :src="it.image" :alt="it.name"
            class="h-12 w-12 rounded-lg border border-gray-200 object-contain dark:border-gray-600"
          >
          <div v-else class="h-12 w-12 flex items-center justify-center rounded-lg border border-dashed border-gray-300 text-[10px] text-gray-400 dark:border-gray-600">
            暂无图
          </div>
          <span class="mt-1 w-full truncate text-center text-[10px] text-gray-500">{{ it.name }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading && !items.length" class="py-10 text-center text-sm text-gray-400">
      读取中…
    </div>

    <details v-for="house in customizations" :key="house.skinId" class="skin-customization ui-card" :data-customization-skin-id="house.skinId">
      <summary><span>{{ house.name }} · 自定义组件</span><span class="skin-customization-status">{{ house.equipped ? '小屋使用中' : '搭配已保存 · 小屋未穿戴' }}</span></summary>
      <div class="skin-customization-body">
        <div class="skin-customization-intro">
          <p>屋顶、门窗、墙面、地板、桌椅和装饰可以分别搭配。切换一个部位，其余部件保持不变。</p>
          <BaseButton v-if="!house.equipped" variant="secondary" size="sm" :disabled="pending || !stateReady || !items.find(item => item.skinId === house.skinId) || !canEquip(items.find(item => item.skinId === house.skinId)!)" @click="requestEquip(items.find(item => item.skinId === house.skinId)!)">换上小屋</BaseButton>
        </div>
        <p v-if="!house.equipped" class="ui-notice">先换上这件小屋，再应用组件；展开查看不会改变当前外观。</p>
        <p v-if="!house.stateKnown || house.resultUnknown" class="ui-notice">{{ house.stateError || '小屋搭配存在未确认状态，请刷新核对，不重复提交。' }}</p>
        <section v-for="group in house.groups" :key="group.partSlotType" class="skin-part-group">
          <h4>{{ group.label }}<span>{{ group.parts.filter(part => part.owned && !part.isDefault).length }} 款已获得</span></h4>
          <div class="skin-parts-grid">
            <button v-for="part in group.parts" :key="part.partId" type="button" class="skin-part-card" :data-part-id="part.partId" :data-selected="part.selected" :disabled="!canApplyPart(house, part)" @click="requestPart(house, part)">
              <img v-if="part.image && !partImageErrors[part.partId]" :src="part.image" :alt="part.name" loading="lazy" width="64" height="64" @error="partImageErrors[part.partId] = true">
              <span v-else class="skin-part-fallback">{{ part.isDefault && group.label === '装饰' ? '无装饰' : part.name.slice(0, 1) }}</span>
              <strong>{{ part.name }}</strong>
              <small>{{ part.selected ? (house.equipped ? '使用中' : '已保存') : part.isDefault ? '恢复默认' : part.owned ? '可应用' : '未拥有' }}</small>
            </button>
          </div>
        </section>
      </div>
    </details>

    <div v-for="g in grouped" :key="g.slotType" class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 flex items-center gap-2">
        <span class="text-sm font-medium text-gray-900 dark:text-white">{{ g.label }}</span>
        <span class="text-xs text-gray-400">槽位{{ g.slotType }} · {{ g.list.length }} 款</span>
      </div>
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <button
          v-for="it in g.list" :key="it.skinId"
          class="group flex flex-col items-center rounded-lg border p-2 text-center transition"
          :class="it.equipped
            ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-500/70 dark:bg-emerald-900/20'
            : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'"
          :disabled="!canEquip(it)" :aria-label="`${it.equipped ? '使用中' : '更换为'} · ${it.name}`" @click="requestEquip(it)"
        >
          <img
            v-if="it.image" :src="it.image" :alt="it.name"
            class="h-12 w-12 object-contain" @click.stop="openPreview(it)"
          >
          <div v-else class="h-12 w-12 flex items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400 dark:border-gray-600">
            暂无图
          </div>
          <span class="mt-1 w-full truncate text-[11px]" :class="it.equipped ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-gray-600 dark:text-gray-300'">
            {{ it.name }}
          </span>
          <span v-if="it.equipped" class="mt-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">{{ stateReady ? '使用中' : '上次使用' }}</span>
          <span v-else-if="switchingId === it.skinId" class="mt-0.5 text-[10px] text-gray-400">正在确认…</span>
          <span v-else-if="it.resultUnknown || accountStore.skinMutationState(accountId, it.slotType) === 'unknown'" class="mt-0.5 text-[10px] text-[var(--status-warning)]">结果待核对</span>
        </button>
      </div>
    </div>

    <div
      v-if="toast"
      class="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
    >
      {{ toast }}
    </div>

    <ConfirmModal :show="!!confirmPart" :title="confirmPart?.part.isDefault ? '确认恢复默认部件' : '确认应用部件'" :message="confirmPart ? `将${confirmPart.house.groups.find(group => group.partSlotType === confirmPart?.part.partSlotType)?.label || '此部位'}改为「${confirmPart.part.name}」。\n其余搭配保持不变，确认当前装备后才显示成功。` : ''" :loading="pending" @confirm="confirmPartEquip" @cancel="closePartConfirmation" @close="closePartConfirmation" />
    <ConfirmModal :show="!!confirmItem" title="确认更换装扮" :message="confirmItem ? `将当前${confirmItem.partName || '槽位'}更换为「${confirmItem.name}」。\n只提交一次，读取当前装备确认后才标记成功。` : ''" :loading="pending" @confirm="confirmEquip" @close="closeConfirmation" @cancel="closeConfirmation" />
    <!-- 放大预览：图标原始只有 100x100，放大后看细节 -->
    <div
      v-if="preview"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      @click="preview = null"
    >
      <div class="max-h-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-2xl dark:bg-gray-800" @click.stop>
        <div class="mb-3 flex items-start gap-3">
          <div class="min-w-0">
            <div class="truncate text-base font-semibold text-gray-900 dark:text-white">
              {{ preview.name }}
            </div>
            <div class="text-xs text-gray-500">
              {{ preview.partName || `槽位${preview.slotType}` }} · ID {{ preview.skinId }}
              <span v-if="preview.equipped" class="ml-1 text-emerald-600 dark:text-emerald-400">使用中</span>
            </div>
          </div>
          <button class="ml-auto text-sm text-gray-400 hover:text-gray-600" @click="preview = null">
            ✕
          </button>
        </div>
        <img
          :src="preview.image" :alt="preview.name"
          class="mx-auto block w-[320px] max-w-full rounded-xl border border-gray-200 bg-gray-50 object-contain dark:border-gray-600 dark:bg-gray-900"
        >
        <p v-if="preview.desc" class="mt-3 text-xs text-gray-500">
          {{ preview.desc }}
        </p>
        <BaseButton v-if="!preview.equipped" class="mt-4 w-full" variant="primary" :disabled="!canEquip(preview)" @click="requestEquip(preview)">
          换上这件
        </BaseButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skin-customization { overflow: hidden; color: var(--theme-text); }
.skin-customization summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 16px; cursor: pointer; font-size: 14px; font-weight: 600; list-style: none; }
.skin-customization summary::-webkit-details-marker { display: none; }
.skin-customization summary::after { content: '+'; margin-left: auto; color: var(--muted-text); font-size: 18px; }
.skin-customization[open] summary::after { content: '−'; }
.skin-customization-status { color: var(--muted-text); font-size: 12px; font-weight: 400; }
.skin-customization-body { display: grid; gap: 16px; padding: 0 16px 16px; border-top: 1px solid var(--surface-border); }
.skin-customization-intro { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding-top: 14px; }
.skin-customization-intro p { flex: 1; min-width: 180px; margin: 0; color: var(--muted-text); font-size: 13px; line-height: 1.6; }
.skin-part-group h4 { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.skin-part-group h4 span { color: var(--muted-text); font-size: 12px; font-weight: 400; }
.skin-parts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.skin-part-card { display: flex; flex-direction: column; align-items: center; gap: 5px; min-height: 125px; padding: 10px 8px; border: 1px solid var(--surface-border); border-radius: var(--radius-control); background: var(--surface-1); color: var(--theme-text); cursor: pointer; }
.skin-part-card img { width: 64px; height: 64px; object-fit: contain; }
.skin-part-card strong { font-size: 12px; font-weight: 500; line-height: 1.4; }
.skin-part-card small { color: var(--muted-text); font-size: 11px; }
.skin-part-card[data-selected='true'] { border-color: var(--theme-primary); background: color-mix(in srgb, var(--theme-primary) 8%, var(--surface-1)); }
.skin-part-card:disabled { cursor: default; }
.skin-part-card:disabled:not([data-selected='true']) { opacity: .65; }
.skin-part-card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.skin-part-fallback { display: grid; place-items: center; width: 64px; height: 64px; border-radius: var(--radius-control); background: var(--surface-2); color: var(--muted-text); font-size: 14px; }
@media (max-width: 520px) { .skin-parts-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .skin-customization summary { padding: 12px; } .skin-customization-body { padding: 0 12px 12px; } }
</style>
