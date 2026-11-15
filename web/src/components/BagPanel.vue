<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { readAccountUiState, writeAccountUiState } from '@/composables/useAccountUiState'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'
import { actualSaleRewards, resultIsUnknown } from '@/utils/operation-result'
import type { OperationFeedback } from '@/utils/operation-result'
import { formatCurrencyAmountByLabel } from '@/utils/number-format'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const statusStore = useStatusStore()
const toastStore = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { items, loading: bagLoading, originalItems, readError, lastUpdatedAt, mutationStates } = storeToRefs(bagStore)
const { status, loading: statusLoading, error: statusError, realtimeConnected, currentStatusReady } = storeToRefs(statusStore)
const imageErrors = ref<Record<string, boolean>>({})
const bagLoaded = ref(false)
let disposed = false
let viewEpoch = 0
let loadFlight: { id: string, epoch: number, promise: Promise<void> } | null = null

const CATEGORY_OPTIONS = [
  { label: '全部', value: 'all' }, { label: '果实', value: 'fruit' },
  { label: '种子', value: 'seed' }, { label: '道具', value: 'tool' }, { label: '其他', value: 'other' },
] as const
type CategoryValue = typeof CATEGORY_OPTIONS[number]['value']
const selectedCategory = ref<CategoryValue>('fruit')
const search = ref('')
const sort = ref<'default' | 'count' | 'name'>('default')
const density = ref<'standard' | 'compact'>('standard')
let restoringUi = false
function restoreUi(id: string) {
  const saved = readAccountUiState(id, 'bag')
  restoringUi = true
  selectedCategory.value = CATEGORY_OPTIONS.some(item => item.value === saved.category) ? saved.category as CategoryValue : 'fruit'
  search.value = typeof saved.search === 'string' ? saved.search.slice(0, 100) : ''
  sort.value = saved.sort === 'count' || saved.sort === 'name' ? saved.sort : 'default'
  density.value = saved.density === 'compact' ? 'compact' : 'standard'
  restoringUi = false
}
restoreUi(String(currentAccountId.value))
watch([selectedCategory, search, sort, density], () => {
  if (!restoringUi)
    writeAccountUiState(String(currentAccountId.value), 'bag', { category: selectedCategory.value,
      search: search.value, sort: sort.value, density: density.value })
}, { flush: 'sync' })
function getItemCategory(item: any): CategoryValue {
  const type = Number(item?.itemType || 0)
  if (type === 17 || type === 6) return 'fruit'
  if (type === 5) return 'seed'
  if (type === 11 || type === 33) return 'tool'
  return 'other'
}
const filteredItems = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  const list = items.value.filter((item: any) => (selectedCategory.value === 'all' || getItemCategory(item) === selectedCategory.value)
    && (!keyword || `${item.name || ''} ${item.id}`.toLowerCase().includes(keyword)))
  if (sort.value === 'count') return [...list].sort((a, b) => Number(b.count) - Number(a.count))
  if (sort.value === 'name') return [...list].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
  return list
})
const categoryCounts = computed(() => {
  const counts: Record<CategoryValue, number> = { all: items.value.length, fruit: 0, seed: 0, tool: 0, other: 0 }
  for (const item of items.value) counts[getItemCategory(item)]++
  return counts
})
const batchMode = ref(false)
const selectedForBatch = ref<Set<number>>(new Set())
const feedback = ref<OperationFeedback | null>(null)
const detailItemKey = ref('')
const itemKey = (item: any) => String(item.groupKey || `${item.id}:${item.uid || 0}`)
const detailItem = computed(() => items.value.find(item => itemKey(item) === detailItemKey.value))
const dialogAction = ref<{
  action: 'sell' | 'use' | 'batchSell' | 'lock' | 'unlock'
  accountId: string
  epoch: number
  item: any
  selectedItems: any[]
  title: string
  message: string
} | null>(null)
const sending = ref(false)
const operationState = computed(() => mutationStates.value?.[String(currentAccountId.value)] || 'idle')
const readableError = computed(() => readError.value || statusError.value)
const actionsEnabled = computed(() => !!currentAccountId.value && currentStatusReady.value
  && status.value?.connection?.connected === true && !readableError.value && !bagLoading.value
  && operationState.value === 'idle' && !sending.value)
const pending = computed(() => operationState.value === 'pending' || sending.value)
const uncertain = computed(() => operationState.value === 'unknown')
const updatedLabel = computed(() => lastUpdatedAt.value ? new Date(lastUpdatedAt.value).toLocaleTimeString('zh-CN', {
  hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
}) : '尚未读取')
const showInitialLoading = computed(() => !bagLoaded.value && (bagLoading.value || statusLoading.value))
const quantityText = (item: any) => item.hoursText || `×${String(item.count || 0)}`
const operationTitle = computed(() => dialogAction.value?.action === 'lock' ? '确认锁定'
  : dialogAction.value?.action === 'unlock' ? '确认解锁' : dialogAction.value?.action === 'use' ? '确认使用' : '确认出售')
function canSell(item: any) { return [17, 6].includes(Number(item.itemType)) && item.locked !== true }
function canBatchSell(item: any) { return canSell(item) && Number(item.count) > 0 }
function canUse(item: any) { return ([11, 33].includes(Number(item.itemType)) || Number(item.id) === 6001) && item.locked !== true && Number(item.count) > 0 }
function canLock(item: any) { return [5, 6, 17].includes(Number(item.itemType)) && String(item.uid || '0') !== '0' }
function dismissDialog() {
  if (!sending.value) dialogAction.value = null
}
function showDetail(item: any) {
  detailItemKey.value = itemKey(item)
}
function prepareLock(item: any) {
  if (!actionsEnabled.value) return
  const action = item.locked ? 'unlock' : 'lock'
  dialogAction.value = { action, accountId: String(currentAccountId.value), epoch: viewEpoch, item: { ...item }, selectedItems: [],
    title: item.locked ? '确认解锁' : '确认锁定',
    message: `${item.locked ? '解锁' : '锁定'}「${item.name}」当前实例？\n实例 UID：${String(item.uid)}\n锁定后自动种植和出售将跳过该实例。` }
}
function estimatedRewards(requested: any[]) {
  const sums = new Map<string, number>()
  for (const item of requested) {
    const matching = items.value.find(entry => Number(entry.id) === Number(item.id)
      && (!item.uid || String(item.uid) === '0' || String(entry.uid) === String(item.uid)))
    if (!matching || !(Number(matching.price) > 0)) continue
    const label = matching.priceUnit || '金币'
    sums.set(label, (sums.get(label) || 0) + Number(matching.price) * Number(item.count || 0))
  }
  return [...sums].map(([label, count]) => `${formatCurrencyAmountByLabel(count, label)} ${label}`).join('、')
}
function handleSellClick(item: any) {
  if (batchMode.value) {
    if (!canBatchSell(item) || !actionsEnabled.value) return
    const next = new Set(selectedForBatch.value)
    if (next.has(Number(item.id))) next.delete(Number(item.id)); else next.add(Number(item.id))
    selectedForBatch.value = next
    return
  }
  if (!actionsEnabled.value || !canSell(item)) return
  const requested = originalItems.value.filter(entry => Number(entry.id) === Number(item.id) && entry.locked !== true
    && (!item.uid || String(item.uid) === String(entry.uid))).map(entry => ({ id: Number(entry.id), count: entry.count, uid: entry.uid || 0 }))
  const estimate = estimatedRewards(requested)
  dialogAction.value = { action: 'sell', accountId: String(currentAccountId.value), epoch: viewEpoch, item: { ...item }, selectedItems: requested,
    title: '确认出售', message: `出售「${item.name}」的当前未锁定实例？\n数量：${item.count || 0}${estimate ? `\n预计收益：${estimate}` : ''}\n预计值仅供参考，实际到账以游戏回包为准。只提交一次。` }
}
function handleUseClick(item: any) {
  if (!actionsEnabled.value || !canUse(item)) return
  dialogAction.value = { action: 'use', accountId: String(currentAccountId.value), epoch: viewEpoch, item: { ...item }, selectedItems: [],
    title: '确认使用', message: `使用 1 个「${item.name}」？\n实例 UID：${String(item.uid || 0)}\n只发送一次请求，奖励以实际回包为准；结果未确认不重试。` }
}
function toggleBatchMode() {
  if (!actionsEnabled.value) return
  batchMode.value = !batchMode.value
  selectedForBatch.value.clear()
}
function selectAllSellable() {
  if (!actionsEnabled.value) return
  selectedForBatch.value = new Set(filteredItems.value.filter(canBatchSell).map(item => Number(item.id)))
}
function handleBatchSellClick() {
  if (!actionsEnabled.value || !selectedForBatch.value.size) return
  const requested = originalItems.value.filter(item => item.locked !== true && selectedForBatch.value.has(Number(item.id)))
    .map(item => ({ id: Number(item.id), count: item.count, uid: item.uid || 0 }))
  if (!requested.length) return
  const estimate = estimatedRewards(requested)
  dialogAction.value = { action: 'batchSell', accountId: String(currentAccountId.value), epoch: viewEpoch, item: null, selectedItems: requested,
    title: '确认批量出售', message: `出售选中的 ${selectedForBatch.value.size} 种物品、${requested.length} 个未锁定实例？\n选择范围：当前账号的已选物品，不包含锁定实例。${estimate ? `\n预计收益：${estimate}` : ''}\n预计不是实际到账；只提交一次。` }
}
async function handleConfirm() {
  const action = dialogAction.value
  if (!action || !actionsEnabled.value || sending.value || action.accountId !== String(currentAccountId.value) || action.epoch !== viewEpoch) return
  const current = () => !disposed && action.epoch === viewEpoch && action.accountId === String(currentAccountId.value)
  sending.value = true
  feedback.value = { state: 'pending', message: `${action.title.replace('确认', '')}处理中，请等待回包。` }
  try {
    let result: any
    if (action.action === 'use') result = await bagStore.useItem(action.accountId, Number(action.item.id), 1, action.item.uid)
    else if (action.action === 'lock' || action.action === 'unlock') result = await bagStore.setItemsLocked(action.accountId, [String(action.item.uid)], action.action === 'lock')
    else result = await bagStore.sellItems(action.accountId, action.selectedItems)
    if (!current() || result?.stale) return
    if (resultIsUnknown(result)) {
      feedback.value = { state: 'unknown', message: `${result?.error || '操作结果未确认'}；仅刷新核对，不重复提交。` }
      return
    }
    if (result?.ok !== true) {
      feedback.value = { state: 'error', message: result?.error || '操作未完成' }
      return
    }
    let message: string
    if (action.action === 'sell' || action.action === 'batchSell') {
      const rewards = actualSaleRewards(result.data)
      message = rewards.length ? `出售已确认，实际获得：${rewards.map(item => `${item.name} ×${item.count}`).join('、')}`
        : '出售消耗已确认，回包未提供可核实收益；不将预计值当作到账。'
      selectedForBatch.value.clear()
      batchMode.value = false
    }
    else if (action.action === 'use') {
      const rewards = result.data?.rewards || []
      message = rewards.length ? `使用已确认，实际获得：${rewards.map((item: any) => `${item.name || item.id} ×${item.count}`).join('、')}` : '物品使用已确认，未返回额外奖励。'
    }
    else message = result.data?.skipped ? '实例已处于目标锁定状态' : action.action === 'lock' ? '已确认锁定此实例' : '已确认解锁此实例'
    feedback.value = { state: 'success', message }
    toastStore.success(message)
    await loadBag()
  }
  catch (error: any) {
    if (current()) feedback.value = { state: 'unknown', message: `${error?.message || '操作结果未确认'}；只刷新核对，不重复提交。` }
  }
  finally {
    if (current()) { sending.value = false; dialogAction.value = null }
  }
}
function loadBag(): Promise<void> {
  const id = String(currentAccountId.value || ''), epoch = viewEpoch
  if (!id || !currentAccount.value || disposed || operationState.value === 'pending') return Promise.resolve()
  if (loadFlight?.id === id && loadFlight.epoch === epoch) return loadFlight.promise
  const running = currentAccount.value.running
  const current = () => !disposed && epoch === viewEpoch && id === String(currentAccountId.value)
  const flight = (async () => {
    if (!realtimeConnected.value) await statusStore.fetchStatus(id)
    if (current() && running) await bagStore.fetchBag(id)
  })().finally(() => {
    if (current()) bagLoaded.value = true
    if (loadFlight?.promise === flight) loadFlight = null
  })
  loadFlight = { id, epoch, promise: flight }
  return flight
}
watch(currentAccountId, (newId, oldId) => {
  viewEpoch++
  if (oldId !== undefined && newId !== oldId) {
    bagLoaded.value = false
    sending.value = false
    dialogAction.value = null
    selectedForBatch.value.clear()
    batchMode.value = false
    detailItemKey.value = ''
    feedback.value = null
    imageErrors.value = {}
    bagStore.clearBag()
    statusStore.clearAccountScopedData()
  }
  restoreUi(String(newId))
  void loadBag().catch(() => {})
}, { immediate: true, flush: 'sync' })
watch(() => currentAccount.value?.running, () => { void loadBag().catch(() => {}) })
watch([selectedCategory, search], () => {
  // Selection is temporary and never restored across views or filters.
  selectedForBatch.value.clear()
  batchMode.value = false
  detailItemKey.value = ''
})
useIntervalFn(() => { if (!sending.value) void loadBag().catch(() => {}) }, 60000)
onBeforeUnmount(() => { disposed = true; viewEpoch++ })
</script>

<template>
  <div class="bag-view space-y-4" :data-density="density">
    <header class="bag-heading">
      <div><h2>我的背包</h2><p>{{ items.length }} 项物品<span v-if="items.some(item => item.locked)"> · {{ items.filter(item => item.locked).length }} 项已锁定</span></p></div>
      <div class="bag-sync"><span role="status">{{ bagLoading ? '更新中…' : `更新于 ${updatedLabel}` }}</span><BaseButton variant="secondary" :loading="bagLoading" :disabled="pending" @click="loadBag">刷新</BaseButton></div>
    </header>
    <div v-if="pending || uncertain || feedback" class="bag-feedback" :data-state="uncertain ? 'unknown' : feedback?.state || 'pending'" role="status">
      {{ uncertain ? '上次操作结果未确认，本账号背包操作已暂停；仅刷新核对，不重复提交。' : feedback?.message || '操作处理中，请等待结果。' }}
    </div>
    <div v-if="readableError" class="bag-feedback" data-state="error" role="status">{{ readableError }}<span v-if="items.length">；以下保留上次读取内容，暂不可操作。</span></div>
    <div v-if="!currentAccountId" class="bag-empty">请先选择账号后查看背包。</div>
    <div v-else-if="showInitialLoading && !items.length" class="bag-skeleton" aria-label="正在读取背包"><span v-for="n in 6" :key="n" /></div>
    <div v-else-if="currentStatusReady && !status?.connection?.connected && !items.length" class="bag-empty">游戏连接未就绪，请先确认账号在线。</div>
    <template v-else>
      <div class="bag-toolbar">
        <nav class="bag-categories" aria-label="背包分类">
          <button v-for="cat in CATEGORY_OPTIONS" :key="cat.value" type="button" :data-active="selectedCategory === cat.value" :aria-pressed="selectedCategory === cat.value" @click="selectedCategory = cat.value">{{ cat.label }}<span>{{ categoryCounts[cat.value] }}</span></button>
        </nav>
        <div class="bag-filters">
          <label class="bag-search"><span class="i-carbon-search" aria-hidden="true" /><input v-model="search" type="search" aria-label="搜索背包物品" placeholder="搜索物品名称或编号" maxlength="100"></label>
          <label class="bag-sort"><span class="sr-only">排序</span><select v-model="sort" aria-label="背包排序"><option value="default">默认排序</option><option value="count">数量最多</option><option value="name">名称排序</option></select></label>
          <div class="bag-density" aria-label="显示密度"><button type="button" :aria-pressed="density === 'standard'" @click="density = 'standard'">标准</button><button type="button" :aria-pressed="density === 'compact'" @click="density = 'compact'">紧凑</button></div>
        </div>
      </div>
      <div class="bag-batch-toolbar">
        <span>显示 {{ filteredItems.length }} 项<span v-if="search"> · 搜索中</span></span>
        <div v-if="selectedCategory === 'fruit' || selectedCategory === 'all'" class="bag-batch-actions">
          <BaseButton size="sm" variant="secondary" :disabled="!actionsEnabled" @click="toggleBatchMode">{{ batchMode ? '取消批量' : '批量出售' }}</BaseButton>
          <template v-if="batchMode"><BaseButton size="sm" variant="secondary" :disabled="!actionsEnabled" @click="selectAllSellable">选择当前可售项</BaseButton><BaseButton size="sm" variant="danger" :disabled="!actionsEnabled || !selectedForBatch.size" @click="handleBatchSellClick">出售所选 ({{ selectedForBatch.size }})</BaseButton></template>
        </div>
      </div>
      <div v-if="!filteredItems.length" class="bag-empty">{{ items.length ? '当前筛选没有匹配物品，可切换分类或清空搜索。' : readableError ? '未取得有效背包数据。' : '本次读取没有可展示物品。' }}</div>
      <div v-else class="bag-grid">
        <article v-for="item in filteredItems" :key="itemKey(item)" class="bag-item" :data-item-id="item.id" :data-selected="batchMode && selectedForBatch.has(Number(item.id))" :data-locked="item.locked === true">
          <div class="bag-item-media"><img v-if="item.image && !imageErrors[itemKey(item)]" :src="item.image" :alt="item.name" loading="lazy" width="56" height="56" @error="imageErrors[itemKey(item)] = true"><span v-else class="bag-item-fallback">{{ (item.name || '物').slice(0, 1) }}</span></div>
          <div class="bag-item-info"><h3 :title="item.name">{{ item.name || `物品${item.id}` }}</h3><div class="bag-item-meta"><span>{{ CATEGORY_OPTIONS.find(cat => cat.value === getItemCategory(item))?.label }}</span><span v-if="item.level">Lv.{{ item.level }}</span><span v-if="item.plantSize === 2" class="bag-tag">2×2</span><span v-if="item.locked" class="bag-lock"><span class="i-carbon-locked" aria-hidden="true" />已锁定</span></div><span class="bag-count">{{ quantityText(item) }}</span></div>
          <div class="bag-item-actions">
            <template v-if="batchMode && canBatchSell(item)"><label class="bag-select"><input type="checkbox" :checked="selectedForBatch.has(Number(item.id))" :disabled="!actionsEnabled" @change="handleSellClick(item)"><span>选择物品</span></label></template>
            <template v-else>
              <BaseButton v-if="canSell(item)" size="sm" variant="outline" :disabled="!actionsEnabled" @click="handleSellClick(item)">出售</BaseButton>
              <BaseButton v-if="canUse(item)" size="sm" variant="primary" :disabled="!actionsEnabled" @click="handleUseClick(item)">使用 1 个</BaseButton>
              <BaseButton v-if="canLock(item)" size="sm" variant="ghost" :disabled="!actionsEnabled" :aria-label="item.locked ? '解锁此实例' : '锁定此实例'" @click="prepareLock(item)">{{ item.locked ? '解锁' : '锁定' }}</BaseButton>
            </template>
            <button type="button" class="bag-detail-button" :aria-label="`查看${item.name}实例详情`" @click="showDetail(item)">详情</button>
          </div>
        </article>
      </div>
    </template>
    <ConfirmModal :show="!!dialogAction" :title="dialogAction?.title" :message="dialogAction?.message" :type="dialogAction?.action === 'sell' || dialogAction?.action === 'batchSell' ? 'danger' : 'primary'" :loading="sending" :confirm-text="operationTitle" @confirm="handleConfirm" @cancel="dismissDialog" @close="dismissDialog" />
    <ConfirmModal :show="!!detailItem" :title="detailItem?.name || '实例详情'" :message="detailItem ? `物品编号：${detailItem.id}\n实例 UID：${String(detailItem.uid || 0)}\n类型编号：${detailItem.itemType || 0}\n数量：${detailItem.count || 0}\n锁定状态：${detailItem.locked ? '已锁定' : '未锁定'}${detailItem.price > 0 ? `\n单价参考：${detailItem.price} ${detailItem.priceUnit || '金币'}` : ''}` : ''" is-alert confirm-text="关闭" @confirm="detailItemKey = ''" @cancel="detailItemKey = ''" @close="detailItemKey = ''" />
  </div>
</template>

<style scoped>
.bag-view { color: var(--theme-text, #2c2a22); min-width: 0; }
.bag-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.bag-heading h2 { margin: 0; font-size: 22px; font-weight: 600; }
.bag-heading p { margin: 5px 0 0; font-size: 13px; color: var(--muted-text, #706857); }
.bag-sync { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; color: var(--muted-text, #706857); font-size: 12px; }
.bag-feedback { border: 1px solid var(--surface-border); border-left: 3px solid var(--status-info); border-radius: var(--radius-control); padding: 12px 14px; background: var(--surface-1); font-size: 13px; line-height: 1.6; }
.bag-feedback[data-state='unknown'] { border-left-color: var(--status-warning); }
.bag-feedback[data-state='error'] { border-left-color: var(--status-danger); }
.bag-feedback[data-state='success'] { border-left-color: var(--status-success); }
.bag-toolbar { padding: 12px; background: var(--surface-1); border: 1px solid var(--surface-border); border-radius: var(--radius-card); }
.bag-categories, .bag-filters, .bag-density, .bag-batch-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bag-categories button { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 12px; border: 0; border-radius: var(--radius-control); color: var(--muted-text); background: transparent; font-size: 14px; font-weight: 500; cursor: pointer; }
.bag-categories button { transition: background-color 150ms ease, color 150ms ease; }
.bag-categories button:active { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--theme-primary) 24%, transparent); }
.bag-density button:active, .bag-detail-button:active { background: var(--surface-3); }
.bag-categories button span { min-width: 20px; font-variant-numeric: tabular-nums; }
.bag-categories button[data-active='true'] { color: var(--action-text, #fff); background: var(--action-bg, #416d3b); }
.bag-filters { margin-top: 12px; border-top: 1px solid var(--surface-border); padding-top: 12px; gap: 10px; }
.bag-search { display: flex; align-items: center; flex: 1; gap: 8px; min-width: 170px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control); padding: 0 10px; color: var(--muted-text); background: var(--input-bg); }
.bag-search input { width: 100%; min-width: 0; height: 40px; outline: none; border: 0; color: var(--theme-text); background: transparent; font: inherit; font-size: 14px; }
.bag-search:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.bag-sort select { min-height: 40px; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control); padding: 0 10px; font: inherit; font-size: 13px; background: var(--surface-1); color: var(--theme-text); }
.bag-density { flex-wrap: nowrap; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control); padding: 3px; }
.bag-density button { min-height: 32px; padding: 4px 9px; background: transparent; border: 0; border-radius: 5px; font-size: 12px; color: var(--muted-text); cursor: pointer; }
.bag-density button[aria-pressed='true'] { background: var(--surface-3); color: var(--theme-text); }
.bag-batch-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; color: var(--muted-text); font-size: 13px; }
.bag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.bag-item { display: flex; flex-direction: column; position: relative; padding: 16px; border: 1px solid var(--surface-border); border-radius: var(--radius-card); background: var(--surface-1); transition: border-color 120ms ease; }
.bag-item:hover { border-color: var(--surface-border-strong); }
.bag-item[data-selected='true'] { border-color: var(--theme-primary); outline: 1px solid var(--theme-primary); }
.bag-item-media { display: flex; align-items: center; justify-content: center; height: 72px; margin-bottom: 12px; background: var(--surface-2); border-radius: var(--radius-control); }
.bag-item-media img { width: 56px; height: 56px; object-fit: contain; }
.bag-item-fallback { font-size: 26px; color: var(--muted-text); }
.bag-item h3 { margin: 0; min-height: 40px; font-size: 14px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.bag-item-meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted-text); font-size: 12px; min-height: 24px; margin-top: 6px; }
.bag-tag, .bag-lock { display: inline-flex; align-items: center; gap: 4px; color: var(--theme-text); }
.bag-lock { color: var(--status-warning); }
.bag-count { display: block; margin-top: 10px; font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums; }
.bag-item-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: auto; padding-top: 16px; }
.bag-detail-button { min-height: 34px; margin-left: auto; padding: 6px; color: var(--muted-text); background: transparent; border: 0; border-radius: var(--radius-control); font-size: 12px; cursor: pointer; }
.bag-select { display: flex; align-items: center; min-height: 40px; gap: 8px; font-size: 13px; cursor: pointer; }
.bag-select input { width: 18px; height: 18px; accent-color: var(--action-bg); }
.bag-empty { padding: 40px 16px; text-align: center; border: 1px dashed var(--surface-border-strong); border-radius: var(--radius-card); color: var(--muted-text); font-size: 14px; }
.bag-skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.bag-skeleton span { min-height: 228px; border-radius: var(--radius-card); background: var(--surface-2); }
.bag-view[data-density='compact'] .bag-grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.bag-view[data-density='compact'] .bag-item { display: grid; grid-template-columns: 48px minmax(0, 1fr); column-gap: 12px; padding: 12px; }
.bag-view[data-density='compact'] .bag-item-media { height: 48px; margin: 0; }
.bag-view[data-density='compact'] .bag-item-media img { width: 40px; height: 40px; }
.bag-view[data-density='compact'] .bag-item h3 { min-height: 0; }
.bag-view[data-density='compact'] .bag-item-meta { min-height: 0; }
.bag-view[data-density='compact'] .bag-count { margin-top: 4px; font-size: 14px; }
.bag-view[data-density='compact'] .bag-item-actions { grid-column: 1 / -1; padding-top: 10px; }
@media (max-width: 520px) { .bag-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } .bag-item { padding: 12px; } .bag-filters { gap: 8px; } .bag-heading h2 { font-size: 20px; } .bag-sync { width: 100%; justify-content: space-between; } .bag-search { flex-basis: 100%; } .bag-density { margin-left: auto; } .bag-item-actions :deep(.base-button), .bag-detail-button { min-height: 44px; } .bag-categories button { padding: 8px 10px; min-height: 44px; } }
@media (pointer: coarse) { .bag-sort select, .bag-search input { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .bag-item { transition: none; } }
</style>
