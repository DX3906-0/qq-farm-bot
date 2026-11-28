<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

interface Frame {
  frameId: number; itemId: number; frameType: number; name: string; desc: string; image: string
  owned: boolean; equipped: boolean | null; resultUnknown?: boolean; rawExpiry?: string | null
}
interface Group { frameType: number; label: string; items: Frame[]; equippedIds: number[]; stateKnown: boolean; warning?: string }
const accountStore = useAccountStore()
const { currentAccountId } = storeToRefs(accountStore)
const toast = useToastStore()
const groups = ref<Group[]>([])
const activeType = ref(1)
const loading = ref(false)
const sending = ref(false)
const error = ref('')
const warning = ref('')
const pending = ref<{ item: Frame; action: 'equip' | 'unequip'; accountId: string } | null>(null)
const uncertain = ref(new Set<string>())
const selected = computed(() => groups.value.find(group => group.frameType === activeType.value))
let revision = 0
let disposed = false
let controller: AbortController | null = null
const confirmText = computed(() => pending.value
  ? `${pending.value.action === 'equip' ? '换上' : '卸下'}「${pending.value.item.name}」？\n仅对当前账号发送一次。结果未确认时只刷新核对，不自动重试。` : '')
const current = (id: string, rid: number) => !disposed && id === String(currentAccountId.value) && rid === revision
const key = (item: Frame) => `${currentAccountId.value}:${item.frameType}`
function disabled(item: Frame) { return sending.value || !item.owned || item.resultUnknown || selected.value?.stateKnown !== true || uncertain.value.has(key(item)) }
async function refresh() {
  const id = String(currentAccountId.value || '')
  if (!id) return
  const rid = ++revision
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const snapshot = await accountStore.fetchAvatarFrames(id)
    if (!current(id, rid)) return
    if (!snapshot || String(snapshot.accountId) !== id || !Array.isArray(snapshot.groups)) throw new Error('挂件列表响应不完整')
    groups.value = snapshot.groups
    warning.value = snapshot.warning || ''
  }
  catch (cause: any) { if (current(id, rid)) error.value = cause?.response?.data?.error || cause.message || '读取失败' }
  finally { if (current(id, rid)) loading.value = false }
}
function prepare(item: Frame, action: 'equip' | 'unequip') {
  if (disabled(item)) return
  pending.value = { item: { ...item }, action, accountId: String(currentAccountId.value) }
}
async function confirm() {
  const target = pending.value
  if (!target || sending.value || target.accountId !== String(currentAccountId.value)) return
  const rid = revision
  sending.value = true
  try {
    const { data } = await api.post(`/api/avatar-frames/${target.action}`, {
      frameId: target.item.frameId, frameType: target.item.frameType, confirmed: true,
      expectedEquippedIds: selected.value?.stateKnown ? selected.value.equippedIds : undefined,
    }, { headers: { 'x-account-id': target.accountId }, timeout: 70000 })
    if (!current(target.accountId, rid)) return
    if (!data?.ok) throw Object.assign(new Error(data.error || '操作未完成'), { response: { data } })
    if (data.data?.skipped) toast.info('已处于目标状态')
    else if (data.data?.resultState === 'completed') toast.success(target.action === 'equip' ? '已确认换上挂件' : '已确认卸下挂件')
    else throw new Error('游戏结果未确认，请只刷新核对')
    pending.value = null
    accountStore.clearAvatarFrame()
    if (data.data?.snapshot) accountStore.applyAvatarFrameSnapshot(data.data.snapshot, target.accountId)
    await refresh()
  }
  catch (cause: any) {
    if (!current(target.accountId, rid)) return
    const result = cause?.response?.data
    if (result?.outcomeUnknown || result?.resultState === 'unknown' || !result) {
      uncertain.value.add(key(target.item))
      if (target.item.frameType === 1) accountStore.clearAvatarFrame()
    }
    toast.error(result?.error || cause.message || '操作结果未确认，请只刷新核对')
    pending.value = null
  }
  finally { sending.value = false }
}
watch(currentAccountId, () => {
  revision++
  controller?.abort()
  groups.value = []
  pending.value = null
  warning.value = ''
  loading.value = false
  void refresh()
}, { immediate: true })
onUnmounted(() => { disposed = true; revision++; controller?.abort() })
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 class="text-xl font-bold">头像框与铭牌</h2><p class="mt-1 text-xs text-gray-500">头像框、铭牌各显示一款当前佩戴；仅手动换装，不会自动改动你的外观。</p></div>
      <button class="rounded-lg bg-blue-50 px-4 py-2 text-sm text-blue-700 dark:bg-blue-900/30 dark:text-blue-200" :disabled="loading || sending" @click="refresh">{{ loading ? '读取中…' : '刷新状态' }}</button>
    </header>
    <p v-if="!currentAccountId" class="rounded-xl bg-white p-8 text-center text-gray-500 dark:bg-gray-800">请选择账号</p>
    <p v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-200">{{ error }}</p>
    <p v-if="warning" class="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">{{ warning }}</p>
    <nav class="flex gap-2">
      <button v-for="group in groups" :key="group.frameType" class="rounded-lg px-4 py-2 text-sm" :class="activeType === group.frameType ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 dark:bg-gray-800 dark:text-gray-300'" @click="activeType = group.frameType">{{ group.label }} · {{ group.items.filter(item => item.owned).length }}</button>
    </nav>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-5">
      <article v-for="item in selected?.items || []" :key="item.frameId" class="min-w-0 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800" :class="!item.owned && 'opacity-60'">
        <div class="relative flex h-28 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-900/30">
          <img v-if="item.image" :src="item.image" :alt="item.name" class="max-h-24 max-w-full object-contain" loading="lazy">
          <span v-else class="text-2xl text-gray-400">{{ item.name.slice(0, 1) }}</span>
          <span v-if="item.equipped === true" class="absolute right-1 top-1 rounded bg-blue-100 px-2 py-1 text-[10px] text-blue-700">佩戴中</span>
        </div>
        <h3 class="mt-3 truncate text-sm font-semibold" :title="item.name">{{ item.name }}</h3>
        <p class="mt-1 text-[11px] text-gray-500">{{ !item.owned ? '未拥有' : item.equipped === null ? '佩戴状态待确认' : item.equipped ? '已佩戴' : '未佩戴' }}</p>
        <p v-if="item.resultUnknown || uncertain.has(key(item))" class="mt-2 text-[11px] text-amber-700 dark:text-amber-200">上次结果未确认，仅刷新核对</p>
        <div v-else class="mt-3 flex gap-2">
          <button class="flex-1 rounded-lg bg-blue-600 py-2 text-xs text-white disabled:opacity-40" :disabled="disabled(item) || item.equipped === true" @click="prepare(item, 'equip')">换上</button>
          <button v-if="item.owned && item.equipped !== false" class="rounded-lg border border-gray-200 px-3 py-2 text-xs disabled:opacity-40 dark:border-gray-600" :disabled="disabled(item)" @click="prepare(item, 'unequip')">卸下</button>
        </div>
      </article>
    </div>
    <ConfirmModal :show="!!pending" title="确认更换外观" :message="confirmText" :loading="sending" @confirm="confirm" @cancel="!sending && (pending = null)" />
  </section>
</template>
