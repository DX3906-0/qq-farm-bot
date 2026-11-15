<script setup lang="ts">
import type { AxiosRequestConfig } from 'axios'
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import api, { isReadCanceled } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useSlidingTabs, vSlidingTabs, vFoldMotion } from '@/composables/useContentMotion'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import type { EffectFilter, MutationCatalog } from '@/utils/mutation-catalog'
import { bundledMutationCatalog, cropRarityLabel, filterMutationEffects, filterMutationSeries, parseMutationCatalog } from '@/utils/mutation-catalog'
import BaseInput from '@/components/ui/BaseInput.vue'
import { readAccountUiState, writeAccountUiState } from '@/composables/useAccountUiState'
const TABS = [
  { key: 'normal', label: '常规变异', icon: 'i-carbon-sprout' },
  { key: 'decoration', label: '装扮变异', icon: 'i-carbon-paint-brush' },
  { key: 'collections', label: '藏品变异', icon: 'i-carbon-cube' },
] as const
type CatalogTab = typeof TABS[number]['key']
const bundled = bundledMutationCatalog()
const data = ref<MutationCatalog | null>(bundled)
const error = ref('')
const loading = ref(false)
const origin = ref<'bundle' | 'read'>('bundle')
const saved = readAccountUiState('catalog-rules', 'mutation-catalog')
const tab = ref<CatalogTab>(TABS.some(entry => entry.key === saved.tab) ? saved.tab as CatalogTab : 'normal')
const search = ref(typeof saved.search === 'string' ? saved.search : '')
const filter = ref<EffectFilter>('all')
const filterOptions = computed(() => tab.value === 'collections'
  ? [{ value: 'all', label: '全部规则' }, { value: 'public', label: '公开概率' }, { value: 'unpublished', label: '未公开概率' }]
  : [{ value: 'all', label: '全部效果' }, { value: 'yield', label: '增加产量' }, { value: 'price', label: '提高售价' }, { value: 'produce', label: '特殊产出' }, { value: 'other', label: '其他效果' }, { value: 'public', label: '公开概率' }, { value: 'unpublished', label: '未公开概率' }])
if (filterOptions.value.some(entry => entry.value === saved.filter)) filter.value = saved.filter as EffectFilter
watch(tab, () => { if (!filterOptions.value.some(entry => entry.value === filter.value)) filter.value = 'all' })
watch([tab, search, filter], () => writeAccountUiState('catalog-rules', 'mutation-catalog', { tab: tab.value, search: search.value, filter: filter.value }))
const list = computed(() => !data.value || tab.value === 'collections' ? [] : filterMutationEffects(data.value[tab.value], search.value, filter.value))
const seriesList = computed(() => filterMutationSeries(data.value?.collections || [], search.value, filter.value))
const activeLabel = computed(() => TABS.find(entry => entry.key === tab.value)?.label || '')
const activeCount = computed(() => data.value ? data.value[tab.value].length : null)
const resultCount = computed(() => tab.value === 'collections' ? seriesList.value.length : list.value.length)
const filtering = computed(() => !!search.value.trim() || filter.value !== 'all')
function resetFilters() { search.value = ''; filter.value = 'all' }
const sourceLabel = computed(() => origin.value === 'bundle' ? `本地规则 · ${data.value?.bundle?.revision || '版本未标注'}` : `最近读取 · ${data.value?.source?.commit?.slice(0, 8) || '版本未标注'}`)
const panelId = useId()
const content = ref<HTMLElement | null>(null)
const tabNav = ref<HTMLElement | null>(null)
const imageErrors = ref<Record<string, boolean>>({})
const { select: selectTab, selected: selectedTab } = useSlidingTabs(tab, () => content.value, () => TABS.map(entry => entry.key))
function moveTabFocus(event: KeyboardEvent, index: number) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
  tabNav.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}
let disposed = false
const controller = new AbortController()
let flight: Promise<void> | null = null
function refresh(): Promise<void> {
  if (LOCAL_UI_READONLY || disposed) return Promise.resolve()
  if (flight) return flight
  loading.value = true
  error.value = ''
  const pending = (async () => {
    try {
      const response = await api.get('/api/illustrated/mutations', {
        signal: controller.signal, skipErrorToast: true,
      } as AxiosRequestConfig)
      if (disposed) return
      const value = parseMutationCatalog(response.data?.data)
      if (response.data?.ok !== true || !value)
        throw new Error(response.data?.error || '规则资料暂时不可用，请稍后刷新。')
      data.value = { ...value, rarityNames: value.rarityNames || bundled?.rarityNames }
      origin.value = 'read'
      imageErrors.value = {}
    }
    catch (cause: any) {
      if (!disposed && !isReadCanceled(cause)) error.value = cause?.response?.data?.error || cause?.message || '读取规则资料失败。'
    }
    finally { if (!disposed) loading.value = false }
  })().finally(() => { if (flight === pending) flight = null })
  flight = pending
  return pending
}
onMounted(() => { void refresh() })
onBeforeUnmount(() => { disposed = true; controller.abort() })
</script>

<template>
  <section class="mutation-catalog space-y-4">
    <header class="ui-page-heading">
      <div><h1>变异宝典</h1><p>查阅变异效果、公开概率与藏品保底规则。</p></div>
      <BaseButton v-if="!LOCAL_UI_READONLY" variant="secondary" :loading="loading" @click="refresh">
        <span class="i-carbon-renew mr-1.5" aria-hidden="true" />刷新
      </BaseButton>
    </header>
    <nav ref="tabNav" v-sliding-tabs class="mutation-tabs ui-tabs" role="tablist" aria-label="变异分类">
      <button
        v-for="(entry, index) in TABS" :id="`${panelId}-${entry.key}`" :key="entry.key"
        type="button" role="tab" class="ui-tab ui-tab-counted" :data-active="selectedTab === entry.key"
        :aria-selected="selectedTab === entry.key" :aria-controls="`${panelId}-panel`" :tabindex="selectedTab === entry.key ? 0 : -1"
        data-motion-nav @click="selectTab(entry.key)" @keydown="moveTabFocus($event, index)"
      >
        <span class="ui-tab-icon" aria-hidden="true"><span :class="entry.icon" /></span><span class="ui-tab-label">{{ entry.label }}</span>
        <span class="mutation-tab-count ui-tab-count" :class="{ invisible: !data }" :aria-hidden="!data">{{ data ? data[entry.key].length : '—' }}</span>
      </button>
    </nav>
    <div v-if="data" class="mutation-toolbar ui-card">
      <BaseInput v-model="search" label="搜索规则" placeholder="名称、效果、作物或藏品名称" type="search" clearable />
      <label class="mutation-filter"><span>筛选</span><select v-model="filter" aria-label="筛选变异效果"><option v-for="option in filterOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
      <BaseButton v-if="filtering" variant="ghost" @click="resetFilters">重置</BaseButton>
    </div>
    <details v-if="data" v-fold-motion class="mutation-source ui-card">
      <summary><span class="i-carbon-book" aria-hidden="true" />{{ sourceLabel }}<span class="mutation-source-caption">资料说明</span></summary>
      <p>{{ data.note }}</p>
      <p v-if="origin === 'bundle'">随前端打包的本地规则快照，无需账号；不是实时游戏状态。藏品规则已与所记录版本的文件摘要核对，变异与物品名称保留本地文件摘要，后续游戏更新仍需核验。</p>
      <p v-else>来自最近一次成功读取的规则资料，不包含账号进度。</p>
      <p v-if="data.source?.repository">来源版本：{{ data.source.repository }} · {{ data.source.commit?.slice(0, 8) || '未标注' }}</p>
    </details>
    <div v-if="error && data" class="ui-notice" data-tone="danger" role="status">
      <p>{{ error }} {{ origin === 'bundle' ? '以下保留有版本标记的本地规则。' : '以下保留上次成功读取的资料。' }}</p>
    </div>
    <div :id="`${panelId}-panel`" ref="content" class="tab-motion-viewport" role="tabpanel" :aria-labelledby="`${panelId}-${tab}`" tabindex="0" :aria-busy="loading">
      <div data-motion-entry class="space-y-4">
        <div v-if="loading && !data" class="mutation-skeleton" aria-label="正在加载变异资料" role="status">
          <span v-for="n in 4" :key="n" />
        </div>
        <div v-else-if="!data" class="ui-empty-state mutation-empty" role="status">
          <span :class="error ? 'i-carbon-warning-alt' : 'i-carbon-catalog'" aria-hidden="true" />
          <h3>{{ error ? '暂时无法读取变异资料' : '变异资料未加载' }}</h3>
          <p>{{ error || (LOCAL_UI_READONLY ? '本地规则未随本次构建提供；当前只查看界面，不会连接账号。' : '刷新后查看变异效果与公开概率。') }}</p>
        </div>
        <template v-else>
          <div class="mutation-list-heading"><h2>{{ activeLabel }}</h2><span role="status" aria-live="polite">{{ filtering ? `找到 ${resultCount} / ${activeCount}` : activeCount }} {{ tab === 'collections' ? '个系列' : '种变异' }}</span></div>
          <div v-if="resultCount === 0" class="ui-empty-state" role="status"><span class="i-carbon-search" aria-hidden="true" /><h3>{{ filtering ? '没有匹配的规则' : '此分类暂无规则' }}</h3><p>{{ filtering ? '试试其他名称或效果，或清除筛选查看全部。' : '当前分类没有可展示的规则资料。' }}</p><BaseButton v-if="filtering" variant="secondary" @click="resetFilters">清除筛选</BaseButton></div>
          <div v-else-if="tab !== 'collections'" class="mutation-grid">
            <article v-for="item in list" :key="item.id" class="mutation-card ui-card">
              <div class="mutation-card-identity">
                <div class="mutation-image">
                  <img v-if="item.image && !imageErrors[`effect-${item.id}`]" :src="item.image" :alt="item.name" width="40" height="40" loading="lazy" @error="imageErrors[`effect-${item.id}`] = true">
                  <span v-else class="i-carbon-sprout" aria-hidden="true" />
                </div>
                <h3>{{ item.name }}</h3>
              </div>
              <p v-if="item.effect" class="mutation-effect">{{ item.effect }}</p>
              <details v-if="item.description && (item.description.length > 48 || item.description.includes('\n'))" v-fold-motion class="mutation-details"><summary>触发说明</summary><p class="mutation-description">{{ item.description }}</p></details>
              <p v-else-if="item.description" class="mutation-description">{{ item.description }}</p>
              <dl v-if="item.probabilities.length" class="mutation-probabilities">
                <div v-for="probability in item.probabilities" :key="String(probability.rarity)">
                  <dt>{{ cropRarityLabel(probability.rarity, data.rarityNames) }}</dt><dd>{{ probability.percent }}<span>%</span></dd>
                </div>
              </dl>
              <p v-else class="mutation-unpublished">未提供公开概率</p>
            </article>
          </div>
          <div v-else class="mutation-series-grid">
            <article v-for="series in seriesList" :key="series.id" class="mutation-series ui-card">
              <div class="mutation-series-heading"><span class="i-carbon-cube" aria-hidden="true" /><h3>{{ series.name }}</h3></div>
              <details v-if="series.description && series.description.length > 48" v-fold-motion class="mutation-details"><summary>获取说明</summary><p class="mutation-description">{{ series.description }}</p></details>
              <p v-else-if="series.description" class="mutation-description">{{ series.description }}</p>
              <dl class="mutation-groups">
                <div v-for="group in series.groups" :key="group.name">
                  <dt>{{ group.name }}</dt><dd><strong>{{ group.probability }}%</strong><span>保底 <strong>{{ group.guarantee }}</strong> 次</span></dd>
                </div>
              </dl>
              <details v-fold-motion class="mutation-details mutation-items-details"><summary>系列藏品 · {{ series.items.length }} 款</summary>
                <div class="mutation-series-items">
                  <span v-for="item in series.items" :key="item.id">
                    <img v-if="item.image && !imageErrors[`collection-${item.id}`]" :src="item.image" :alt="item.name" width="24" height="24" loading="lazy" @error="imageErrors[`collection-${item.id}`] = true">
                    {{ item.name }}
                  </span>
                </div>
              </details>
            </article>
          </div>
        </template>
      </div>
    </div>
    <p class="mutation-footnote"><span class="i-carbon-book" aria-hidden="true" />仅供查阅，不消耗道具或进行游戏操作。</p>
  </section>
</template>

<style scoped>
.mutation-catalog { min-width: 0; color: var(--theme-text); }
.mutation-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 200px) auto; align-items: end; gap: 12px; padding: 16px; }
.mutation-filter { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.mutation-filter > span { font-weight: 500; }.mutation-filter select { min-height: 40px; width: 100%; border: 1px solid var(--surface-border-strong); border-radius: var(--radius-control); padding: 8px 10px; background: var(--input-bg); color: var(--theme-text); font: inherit; }
.mutation-source { padding: 12px 16px; font-size: 12px; line-height: 1.7; color: var(--muted-text); }
.mutation-source > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; min-height: 28px; }
.mutation-source-caption { margin-left: auto; }.mutation-source-caption::after { content: ' ›'; }.mutation-source[open] .mutation-source-caption::after { content: ' ⌄'; }
.mutation-source p { margin: 8px 0 0; overflow-wrap: anywhere; }
.mutation-details { margin: 10px 0 12px; font-size: 12px; color: var(--muted-text); }
.mutation-details > summary { cursor: pointer; min-height: 28px; padding: 3px 0; color: var(--theme-text); }
.mutation-items-details { margin: 14px 0 0; }
@media (max-width: 640px) { .mutation-toolbar { grid-template-columns: minmax(0, 1fr); padding: 14px; gap: 10px; }.mutation-filter select { min-height: 44px; }.mutation-source { padding: 12px 14px; } }
.mutation-tab-count { min-width: 24px; font-size: 11px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }
.mutation-list-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 2px; }
.mutation-list-heading h2 { margin: 0; font-size: 14px; font-weight: 600; }.mutation-list-heading > span { font-size: 12px; color: var(--muted-text); }
.mutation-grid, .mutation-skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.mutation-card { display: flex; flex-direction: column; min-width: 0; padding: 16px; }
.mutation-card-identity { display: flex; align-items: center; gap: 12px; }
.mutation-image { display: grid; flex-shrink: 0; place-items: center; width: 52px; height: 52px; border-radius: var(--radius-control); background: var(--surface-2); color: var(--muted-text); }
.mutation-image img { width: 40px; height: 40px; object-fit: contain; }.mutation-image > span { font-size: 24px; }
.mutation-card h3, .mutation-series h3 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.mutation-effect { margin: 14px 0 0; color: var(--theme-text); font-size: 16px; font-weight: 600; line-height: 1.5; }
.mutation-description { margin: 8px 0 14px; color: var(--muted-text); font-size: 13px; line-height: 1.8; white-space: pre-line; overflow-wrap: anywhere; }
.mutation-probabilities { margin: auto 0 0; border-top: 1px solid var(--surface-border); padding-top: 10px; }
.mutation-probabilities > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 12px; }
.mutation-probabilities dt { color: var(--muted-text); }.mutation-probabilities dd { margin: 0; color: var(--theme-text); font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }.mutation-probabilities dd span { margin-left: 2px; font-size: 12px; font-weight: 400; color: var(--muted-text); }
.mutation-unpublished { margin: auto 0 0; padding-top: 12px; font-size: 12px; color: var(--muted-text); }
.mutation-series-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 16px; }
.mutation-series { min-width: 0; padding: 20px; }.mutation-series-heading { display: flex; align-items: center; gap: 10px; }.mutation-series-heading > span { font-size: 20px; color: var(--theme-primary); }
.mutation-groups { margin: 0; border: 1px solid var(--surface-border); border-radius: var(--radius-control); background: var(--surface-2); padding: 4px 12px; }
.mutation-groups > div { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 0; font-size: 12px; }.mutation-groups > div + div { border-top: 1px solid var(--surface-border); }
.mutation-groups dd { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 0; font-variant-numeric: tabular-nums; }.mutation-groups dd strong { color: var(--theme-text); font-size: 14px; font-weight: 600; }.mutation-groups dd span { color: var(--muted-text); }
.mutation-series-items { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }.mutation-series-items > span { display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; border: 1px solid var(--surface-border); border-radius: var(--radius-control); color: var(--muted-text); font-size: 12px; line-height: 1.5; }.mutation-series-items img { width: 24px; height: 24px; object-fit: contain; }
.mutation-footnote { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 0; color: var(--muted-text); font-size: 12px; line-height: 1.7; }
.mutation-skeleton > span { min-height: 208px; border-radius: var(--radius-card); background: var(--surface-2); }
@media (max-width: 640px) { .mutation-card { padding: 14px; }.mutation-series { padding: 16px; }.mutation-footnote { justify-content: flex-start; }.mutation-grid { gap: 10px; } }
</style>
