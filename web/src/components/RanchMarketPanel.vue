<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import RanchItemImage from '@/components/RanchItemImage.vue'
import RanchMugeActivityPanel from '@/components/RanchMugeActivityPanel.vue'
import type { RanchActivityNode, RanchMarketGood } from '@/stores/ranch'
import { useRanchStore } from '@/stores/ranch'
import { formatIntegerAmount } from '@/utils/number-format'
const props = defineProps<{ section: 'market' | 'activities', accountId?: string, readOnlyReason?: string,
  automaticClaimEnabled?: boolean | null, automaticClaimSummary?: string }>()
const emit = defineEmits<{ (e: 'request', action: string, input: Record<string, unknown>, title: string): void, (e: 'refresh', groupId?: string): void }>()
const ranchStore = useRanchStore()
const { progressViews, progressLoading, progressErrors, writeBlocked, operations, operationsError } = storeToRefs(ranchStore)
function operateMuge(action: string, input: Record<string, unknown> = {}) {
  return ranchStore.operateMugeActivity(String(props.accountId || ''), action, input)
}
const counts = ref<Record<string, number>>({})
const selectedShelf = ref<number | 'all'>('all')
const market = computed(() => progressViews.value.market)
const activity = computed(() => progressViews.value.activities)
const activityEvents = computed(() => (activity.value?.activities || []).map(event => activity.value?.detail?.id === event.id ? activity.value.detail : event))
const otherActivityEvents = computed(() => activityEvents.value.filter(event => event.id !== '2026111700'))
function activityChildLabel(child: RanchActivityNode, parent: RanchActivityNode) {
  return child.name && child.name !== parent.name ? child.name : `子活动 · 类型 ${child.type}`
}
const blocked = computed(() => writeBlocked.value || progressLoading.value[props.section] || !!progressErrors.value[props.section])
const goods = computed(() => (market.value?.goods || []).filter(row => selectedShelf.value === 'all' || row.shelfId === selectedShelf.value))
const purchaseBlockedReason = computed(() => writeBlocked.value
  ? operationsError.value ? `安全状态读取失败：${operationsError.value}。在核实前暂停写操作。`
    : '牧场场景或好友访问状态待核实；为避免误切场，暂不能购买。'
  : progressErrors.value.market ? `商品读取失败：${progressErrors.value.market}。请刷新后再试。` : '')
const conflictingPendingMessage = computed(() => operations.value.length
  ? `有 ${operations.value.length} 项操作结果待核对；同一商品或使用同一余额的购买会暂缓，其他购买仍可进行。`
  : '')
function quantity(value: string | number | null | undefined) {
  if (value == null) return '未确认'
  const formatted = formatIntegerAmount(value)
  return formatted === '—' ? '未确认' : formatted
}
function amount(good: RanchMarketGood) { return Math.min(good.maxCount, Math.max(1, Math.floor(Number(counts.value[good.id]) || 1))) }
function pendingConflict(good: RanchMarketGood) {
  return ranchStore.hasPendingConflict(`ranch:exchange:${good.id}`, [`item:${good.currencyId}`])
}
function exchange(good: RanchMarketGood) {
  if (blocked.value || !good.available || amount(good) <= 0) return
  const current = market.value
  const now = current ? current.serverTimeMs + Math.max(0, Date.now() - current.observedAt) : Number.NaN
  if (!Number.isFinite(now) || now <= 0) { emit('refresh'); return }
  if (good.priceValidUntilMs !== null && now >= good.priceValidUntilMs) { emit('refresh'); return }
  emit('request', 'exchange', { goodsId: good.id, count: amount(good) }, `兑换${good.name}`)
}
function phase(begin: number | null, end: number | null) {
  const value = activity.value
  if (!value || !begin || !end || begin >= end) return '时间未确认'
  const now = value.serverTimeMs + Math.max(0, Date.now() - value.observedAt)
  if (!Number.isFinite(now) || now <= 0) return '时间未确认'
  return now < begin ? '尚未开始' : now >= end ? '已结束' : '活动时间内'
}
function range(begin: number | null, end: number | null) {
  if (!begin || !end) return '时间未确认'
  return `${new Date(begin).toLocaleString('zh-CN', { hour12: false })} – ${new Date(end).toLocaleString('zh-CN', { hour12: false })}`
}
</script>
<template>
  <section class="ranch-market-panel space-y-4">
    <div class="ui-card rounded-lg p-5">
      <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="text-base font-semibold">{{ section === 'market' ? '仓鼠集市' : '牧场活动' }}</h2><BaseButton size="sm" variant="secondary" :loading="progressLoading[section]" @click="emit('refresh')">刷新专区</BaseButton></div>
    </div>
    <p v-if="progressLoading[section]" class="market-muted text-sm">正在读取当前专区…</p>
    <p v-if="progressErrors[section]" class="market-error rounded-lg border border-[var(--surface-border)] p-3 text-sm" role="alert">{{ progressErrors[section] }}</p>
    <p v-if="section === 'market' && purchaseBlockedReason" class="market-error rounded-lg border border-[var(--surface-border)] p-3 text-sm" role="status">{{ purchaseBlockedReason }}</p>
    <p v-else-if="section === 'market' && conflictingPendingMessage" class="market-muted rounded-lg border border-[var(--surface-border)] p-3 text-xs" role="status">{{ conflictingPendingMessage }}</p>
    <template v-if="section === 'market' && market">
      <p class="market-muted text-xs">周期 {{ market.periodDay }} · 轮次 {{ market.roundIndex }} · {{ new Date(market.observedAt).toLocaleString('zh-CN', { hour12: false }) }}</p>
      <div class="flex flex-wrap gap-2"><BaseButton size="sm" :variant="selectedShelf === 'all' ? 'primary' : 'secondary'" @click="selectedShelf = 'all'">全部货架</BaseButton><BaseButton v-for="shelf in market.shelves" :key="shelf.id" size="sm" :variant="selectedShelf === shelf.id ? 'primary' : 'secondary'" @click="selectedShelf = shelf.id">{{ shelf.name || `货架 ${shelf.id}` }}</BaseButton></div>
      <div v-if="goods.length" class="grid gap-3 lg:grid-cols-2">
        <article v-for="good in goods" :key="good.id" class="ui-card rounded-lg p-5">
          <div class="flex items-start gap-3"><RanchItemImage :src="good.reward.image" :alt="good.name" /><div class="min-w-0 flex-1"><h3 class="text-sm font-semibold">{{ good.name }}</h3><p class="market-muted mt-1 text-xs">每份 {{ quantity(good.reward.count) }}</p><p v-if="good.stateReason" class="market-warning mt-2 text-xs">{{ good.stateReason }}</p></div><div class="flex shrink-0 flex-col items-end gap-1"><span v-if="good.discounted" class="market-chip">折扣</span><span class="market-chip">{{ good.available ? '可购买' : '暂不可购买' }}</span></div></div>
          <div class="market-detail mt-4"><span>单价</span><strong>{{ good.currencyName }} ×{{ quantity(good.unitPrice) }}</strong></div>
          <div class="market-detail"><span>未锁定余额</span><strong>{{ quantity(good.currencyBalance) }}</strong></div>
          <div class="market-detail"><span>本轮剩余额度</span><strong>{{ good.remaining === null ? '不限额' : quantity(good.remaining) }}</strong></div>
          <p v-if="pendingConflict(good)" class="market-warning mt-3 text-xs">有购买结果待核对，且使用相同余额；这件商品暂不能重复购买。</p>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><label class="market-muted flex items-center gap-2 text-xs">份数<input v-model.number="counts[good.id]" type="number" min="1" :max="good.maxCount" placeholder="1" class="market-count" :disabled="blocked || !good.available || pendingConflict(good)"></label><BaseButton size="sm" :disabled="blocked || !good.available || pendingConflict(good)" :title="blocked ? purchaseBlockedReason || '正在处理上一项操作' : pendingConflict(good) ? '该余额有购买结果待核对' : !good.available ? good.stateReason || '当前暂不可购买' : ''" @click="exchange(good)">购买</BaseButton></div>
        </article>
      </div>
      <p v-else-if="!progressLoading.market" class="ui-empty-state">当前货架暂无商品</p>
    </template>
    <template v-else-if="section === 'activities' && activity">
      <RanchMugeActivityPanel v-if="activity.muge" :activity="activity.muge" :account-id="props.accountId" :read-only="writeBlocked" :read-only-reason="props.readOnlyReason" :automatic-claim-enabled="props.automaticClaimEnabled" :automatic-claim-summary="props.automaticClaimSummary" :operate="operateMuge" @refresh="emit('refresh')" />
      <div v-if="otherActivityEvents.length" class="space-y-3">
        <article v-for="event in otherActivityEvents" :key="event.id" class="ui-card rounded-lg p-5">
          <div class="flex flex-wrap items-start justify-between gap-3"><h3 class="text-base font-semibold">{{ event.name }}</h3><span class="market-chip">{{ phase(event.beginTimeMs, event.endTimeMs) }}</span></div>
          <p class="market-muted mt-3 break-words text-xs">{{ range(event.beginTimeMs, event.endTimeMs) }}</p>
          <div v-if="event.children.length" class="mt-4 grid gap-3 sm:grid-cols-2">
            <section v-for="child in event.children" :key="child.id" class="min-w-0 rounded-lg border border-[var(--surface-border)] bg-[var(--surface-2)] p-4" :aria-label="activityChildLabel(child, event)">
              <h4 class="break-words text-sm font-semibold">{{ activityChildLabel(child, event) }}</h4>
              <p class="market-muted mt-3 break-all text-xs">活动 ID {{ child.id }}</p>
            </section>
          </div>
          <BaseButton size="sm" variant="secondary" class="mt-4" :disabled="progressLoading.activities" @click="emit('refresh', event.id)">刷新活动</BaseButton>
        </article>
      </div>
      <p v-if="!activity.muge && activity.mugeError" class="market-error rounded-lg border border-[var(--surface-border)] p-3 text-sm" role="status">牧歌初启进度暂不可用：{{ activity.mugeError }}。刷新可重试，未确认时不显示领取入口。</p>
      <p v-else-if="!activity.muge && !otherActivityEvents.length" class="ui-empty-state">牧歌初启进度暂不可用；刷新后可重试，未确认时不显示领取入口。</p>
      <details v-if="activity.guide?.sections?.length" class="ui-card rounded-lg p-5"><summary class="cursor-pointer text-sm font-semibold">活动说明</summary><div class="mt-3 space-y-3"><div v-for="part in activity.guide.sections" :key="part.name"><h4 class="text-sm font-semibold">{{ part.name }}</h4><p class="market-muted mt-1 text-sm">{{ part.description }}</p></div></div></details>
    </template>
    <p v-else-if="!progressLoading[section]" class="ui-empty-state">暂无数据</p>
  </section>
</template>
<style scoped>
.ranch-market-panel { color: var(--theme-text); }.market-muted { color: var(--muted-text); }.market-warning,.market-error { color: var(--status-warning); }.market-error { border-left-color: var(--status-warning); }
.market-chip { flex: none; border-radius: 999px; padding: 4px 9px; color: var(--theme-primary); background: color-mix(in srgb,var(--theme-primary) 10%,transparent); font-size: 11px; }
.market-detail { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 8px 0; font-size: 12px; }.market-detail span { color: var(--muted-text); }.market-count { width: 75px; min-height: 34px; border: 1px solid var(--surface-border); border-radius: var(--radius-control); padding: 5px 8px; background: var(--surface-2); color: var(--theme-text); }
</style>
