<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import GameViewSwitch from '@/components/GameViewSwitch.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import { useAccountStore } from '@/stores/account'
import { useRanchStore } from '@/stores/ranch'
import { useStatusStore } from '@/stores/status'
import { deriveAccountPresentation, integerText } from '@/utils/operation-result'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const ranchStore = useRanchStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { operations, operationsReady, operationsLoading, operationsError } = storeToRefs(ranchStore)
const { status, currentStatusReady, currentStatusMetadata, currentStatusStale, loading: statusLoading, error: statusError, logs: statusLogs, accountLogs } = storeToRefs(statusStore)
const id = computed(() => String(currentAccountId.value || ''))
const presentation = computed(() => deriveAccountPresentation({
  accountId: id.value, account: currentAccount.value,
  snapshot: currentStatusReady.value ? { ...status.value, metadata: currentStatusMetadata.value } : null,
  snapshotReady: currentStatusReady.value, stale: currentStatusStale.value,
  loading: statusStore.loading, error: statusStore.error, readonly: LOCAL_UI_READONLY,
}))
const farmLevel = computed(() => currentStatusReady.value ? integerText(status.value?.status?.level) : null)
const dataUpdatedAt = computed(() => currentStatusMetadata.value?.updatedAt || 0)
const freshnessText = computed(() => {
  if (!dataUpdatedAt.value) return '尚无有效数据'
  const age = Math.max(0, Date.now() - dataUpdatedAt.value)
  return age < 60_000 ? '刚刚更新' : `${Math.floor(age / 60_000)} 分钟前更新`
})
const recentEvents = computed(() => [ ...(statusLogs.value || []), ...(accountLogs.value || []) ]
  .filter((row: any) => row && (row.msg || row.message))
  .sort((a: any, b: any) => new Date(b.time || b.ts || 0).getTime() - new Date(a.time || a.ts || 0).getTime())
  .slice(0, 5))
function refreshOverview() {
  if (!LOCAL_UI_READONLY && id.value) {
    void statusStore.fetchStatus(id.value)
    void ranchStore.fetchOperations(id.value)
  }
}
watch(id, value => { if (value && !LOCAL_UI_READONLY) refreshOverview() })
onMounted(() => { if (id.value && !LOCAL_UI_READONLY) refreshOverview() })
const pendingRanchOperations = computed(() => operationsReady.value ? operations.value : [])
const ranchSafetyStatus = computed(() => !id.value || LOCAL_UI_READONLY ? '不可用'
  : operationsLoading.value && !operationsReady.value ? '检查中…'
    : operationsError.value ? '读取失败' : !operationsReady.value ? '尚未检查'
      : pendingRanchOperations.value.length ? `${pendingRanchOperations.value.length} 条待核对` : '没有待核对记录')
const accountName = computed(() => LOCAL_UI_READONLY ? '本地浏览 · 无账号'
  : currentAccount.value?.name || currentAccount.value?.nick || (id.value ? `账号 ${id.value}` : '未选择账号'))
function observedAt(value: number) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
function amount(value: unknown) {
  const text = integerText(value)
  return text === null ? '—' : Number(text).toLocaleString('zh-CN')
}
// The shared layout owns status subscriptions. This view never fetches ranch,
// inventory, tasks or game scenes, and never creates a new poller on navigation.
</script>

<template>
  <section class="overview-page flex flex-col gap-5 pt-1 md:pt-2">
    <GameViewSwitch view="overview" description="先看账号状态和需要留意的事项，再进入农场或牧场继续处理。" />
    <div class="overview-toolbar ui-card flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
      <div class="flex items-center gap-2 text-sm"><span class="overview-live-dot" :data-stale="currentStatusStale" /><strong>{{ currentStatusReady ? (currentStatusStale ? '数据可能已过期' : '账号数据已连接') : statusLoading ? '正在读取账号状态' : '账号状态未读取' }}</strong><span class="overview-muted">{{ freshnessText }}</span></div>
      <BaseButton v-if="!LOCAL_UI_READONLY && id" size="sm" variant="outline" :disabled="statusLoading || operationsLoading" @click="refreshOverview">{{ statusLoading || operationsLoading ? '读取中…' : '刷新' }}</BaseButton>
    </div>
    <p v-if="statusError" class="ui-notice" role="alert">状态读取失败：{{ statusError }}<button class="ml-2 underline" type="button" @click="refreshOverview">重试</button></p>
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <article class="ui-card metric-card min-h-[168px] rounded-lg p-5">
        <p class="overview-kicker"><span class="i-carbon-user" aria-hidden="true" />当前账号</p>
        <h2 class="mt-3 truncate text-xl font-bold">{{ accountName }}</h2>
        <p class="mt-3 text-sm overview-muted">{{ LOCAL_UI_READONLY ? '仅查看界面，不加载账号或游戏数据' : id ? `ID ${id}` : '在顶部选择账号后查看状态' }}</p>
      </article>
      <article class="ui-card metric-card min-h-[168px] rounded-lg p-5">
        <p class="overview-kicker"><span class="i-carbon-connection-signal" aria-hidden="true" />游戏会话</p>
        <h2 class="mt-3 text-xl font-bold" :data-tone="presentation.tone">{{ presentation.label }}</h2>
        <p class="mt-3 text-sm overview-muted">{{ presentation.detail }}</p>
      </article>
      <article class="ui-card metric-card min-h-[168px] rounded-lg p-5">
        <p class="overview-kicker"><span class="i-carbon-task" aria-hidden="true" />牧场待核对</p>
        <h2 class="mt-3 text-xl font-bold" :data-tone="operationsError ? 'warning' : pendingRanchOperations.length ? 'warning' : undefined">{{ ranchSafetyStatus }}</h2>
        <p class="mt-3 text-sm overview-muted">{{ operationsError ? operationsError : pendingRanchOperations.length ? '只影响相关领取或花费，不会自动重发。' : '读取账号操作记录，不切换游戏场景。' }}</p>
      </article>
    </div>

    <section class="ui-card rounded-lg p-5" aria-label="农场账户资源">
      <div class="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h2 class="text-base font-bold">账户资源</h2><p class="overview-muted mt-1 text-xs">读取自当前账号状态；牧场数据不会在总览里自动切场读取</p></div><span class="overview-muted text-xs">{{ currentStatusReady ? freshnessText : '等待账号状态' }}</span></div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="overview-resource"><span>农场等级</span><strong>{{ farmLevel !== null ? `Lv.${farmLevel}` : '—' }}</strong></div>
        <div class="overview-resource"><span>金币</span><strong>{{ currentStatusReady ? amount(status?.status?.gold) : '—' }}</strong></div>
        <div class="overview-resource"><span>点券</span><strong>{{ currentStatusReady ? amount(status?.status?.coupon) : '—' }}</strong></div>
        <div class="overview-resource"><span>金豆</span><strong>{{ currentStatusReady ? amount(status?.status?.goldBean) : '—' }}</strong></div>
      </div>
    </section>
    <section class="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <article class="ui-card rounded-lg p-5">
        <div class="mb-4 flex items-center justify-between"><div><h2 class="text-base font-bold">最近动态</h2><p class="overview-muted mt-1 text-xs">当前账号最近收到的状态与事件</p></div><BaseButton to="/dashboard" size="sm" variant="outline">查看详情</BaseButton></div>
        <ol v-if="recentEvents.length" class="overview-events">
          <li v-for="(event, index) in recentEvents" :key="`${event.time || event.ts || index}-${index}`"><time>{{ event.time || observedAt(Number(event.ts)) }}</time><span>{{ event.msg || event.message }}</span></li>
        </ol>
        <p v-else class="overview-muted py-5 text-sm">{{ currentStatusReady ? '暂时没有新的动态' : '状态读取后会显示最近动态' }}</p>
      </article>
      <article class="ui-card rounded-lg p-5">
        <h2 class="text-base font-bold">快速进入</h2>
        <p v-if="presentation.kind === 'offline' || presentation.kind === 'stale' || presentation.kind === 'error'" class="mt-3 rounded-lg border border-[var(--surface-border)] p-3 text-sm">{{ presentation.detail }}</p>
        <p v-else-if="operationsError" class="mt-3 rounded-lg border border-[var(--surface-border)] p-3 text-sm">牧场记录暂时读不到；进入牧场后可以重试。</p>
        <div class="mt-4 flex flex-wrap gap-2"><BaseButton to="/" size="sm" variant="secondary">打开农场</BaseButton><BaseButton to="/ranch" size="sm">打开牧场</BaseButton></div>
      </article>
    </section>
    <article v-if="operationsError" class="ui-notice" role="alert">
      牧场操作记录读取失败：{{ operationsError }}。总览不会猜测为“没有待核对记录”。
      <button class="ml-2 underline" type="button" @click="refreshOverview">重试</button>
    </article>
    <article v-else-if="pendingRanchOperations.length" class="ui-card rounded-lg p-5" aria-label="牧场待核对操作">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div><h2 class="text-base font-bold">牧场待核对</h2><p class="overview-muted mt-1 text-xs">这些记录不会自动重发；到牧场查看每条结果。</p></div>
        <BaseButton to="/ranch" size="sm">查看记录</BaseButton>
      </div>
      <ul class="overview-pending-list">
        <li v-for="item in pendingRanchOperations.slice(0, 3)" :key="item.id"><strong>{{ item.label || '牧场操作' }}</strong><span>{{ item.target }}</span></li>
      </ul>
      <p v-if="pendingRanchOperations.length > 3" class="overview-muted mt-2 text-xs">另有 {{ pendingRanchOperations.length - 3 }} 条记录，进入牧场查看。</p>
    </article>
  </section>
</template>

<style scoped>
.overview-page { color: var(--theme-text); }
.overview-muted, .overview-kicker { color: var(--muted-text); }
.overview-kicker { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 12px; }
.overview-kicker > span { color: var(--theme-primary); font-size: 16px; }
.overview-pending-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.overview-pending-list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; border-top: 1px solid var(--surface-border); padding-top: 9px; font-size: 13px; }
.overview-pending-list li span { color: var(--muted-text); font-size: 12px; overflow-wrap: anywhere; }
.overview-live-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--status-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-success) 15%, transparent); }
.overview-live-dot[data-stale='true'] { background: var(--status-warning); }
.overview-resource { display: flex; min-height: 82px; flex-direction: column; justify-content: center; gap: 8px; border-radius: var(--radius-card); background: var(--surface-2); padding: 12px; }
.overview-resource span, .overview-events time { color: var(--muted-text); font-size: 12px; }
.overview-resource strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.overview-events { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.overview-events li { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; border-top: 1px solid var(--surface-border); padding: 12px 0; font-size: 13px; }
.overview-events li span { overflow-wrap: anywhere; }
[data-tone='error'] { color: var(--status-danger); }[data-tone='warning'] { color: var(--status-warning); }
</style>
