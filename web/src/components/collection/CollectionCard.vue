<script setup lang="ts">
import type { CollectionItem } from '@/stores/collection'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  item: CollectionItem
  upgrading?: boolean
}>()

const emit = defineEmits<{
  (e: 'upgrade', item: CollectionItem): void
  (e: 'display', item: CollectionItem): void
}>()

const imageIndex = ref(0)

/** 图片只影响展示：旧接口 image 为空时，沿用真实资源名，不按藏品 ID 猜编号。 */
const imageCandidates = computed(() => {
  const image = typeof props.item.image === 'string' ? props.item.image.trim() : ''
  const resource = typeof props.item.iconRes === 'string'
    ? props.item.iconRes.trim().replace(/\/(?:spriteFrame|texture)\/?$/, '')
    : ''
  const resourceKey = resource.startsWith('gui/texture/collectIcon/')
    ? resource.split('/').pop() || ''
    : ''
  const keys = [props.item.iconKey, resourceKey]
    .filter((key): key is string => typeof key === 'string' && /^icon_collect_\w+$/.test(key))
  return [...new Set([image, ...keys.map(key => `/game-config/deco_icons/${key}.png`)].filter(Boolean))]
})
const imageSrc = computed(() => imageCandidates.value[imageIndex.value] || '')

// 换藏品或获得新地址后重新加载；拥有数/星级更新不会重试已失败的图。
watch([() => props.item.collectionId, () => imageCandidates.value.join('\n')], () => {
  imageIndex.value = 0
}, { flush: 'sync' })

function onImageError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null
  // 上一个地址的延迟错误不能把当前图片也判为失败。
  if (image?.getAttribute('src') !== imageSrc.value)
    return
  imageIndex.value++
}

const MAX_STAR = 5

/** 稀有度配色：1 普通 / 2 精良 / 3 稀有 / 4 史诗 */
interface RarityStyle { label: string, border: string, badge: string }

const RARITY_FALLBACK: RarityStyle = {
  label: '普通',
  border: 'border-gray-200 dark:border-gray-700',
  badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
}

const RARITY_STYLE: Record<number, RarityStyle> = {
  1: RARITY_FALLBACK,
  2: { label: '精良', border: 'border-sky-300 dark:border-sky-700', badge: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
  3: { label: '稀有', border: 'border-violet-300 dark:border-violet-700', badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  4: { label: '史诗', border: 'border-amber-300 dark:border-amber-700', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
}

const rarity = computed<RarityStyle>(() => RARITY_STYLE[Number(props.item.rarity) || 1] ?? RARITY_FALLBACK)
const owned = computed(() => props.item.owned ?? (props.item.ownCount > 0 || props.item.starLevel > 0))
const star = computed(() => Math.max(0, Math.min(MAX_STAR, Number(props.item.starLevel) || 0)))
const maxed = computed(() => star.value >= MAX_STAR)
/** Eligibility and costs come from the per-series, per-star configuration, including first activation. */
const canUpgrade = computed(() => props.item.canUpgrade === true && !maxed.value)
const activated = computed(() => props.item.activated ?? star.value > 0)

const showImage = computed(() => !!imageSrc.value)

/** 稀有度色条（用配置里的 rarity_color 覆盖默认色） */
const accentColor = computed(() => {
  const c = String(props.item.rarityColor || '').replace('#', '')
  return /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : ''
})
</script>

<template>
  <article
    class="min-w-0 flex flex-col overflow-hidden border rounded-xl bg-white shadow-sm transition hover:shadow-md dark:bg-gray-800"
    :class="[rarity.border, !owned && 'opacity-70']"
  >
    <!-- 图片区 -->
    <div class="relative grid h-28 place-items-center bg-gray-50 dark:bg-gray-900/40">
      <span
        v-if="accentColor"
        class="absolute inset-x-0 top-0 h-0.5"
        :style="{ backgroundColor: accentColor }"
      />
      <span class="absolute left-0 top-0 rounded-br-lg px-2 py-0.5 text-[10px] font-semibold" :class="rarity.badge">
        {{ rarity.label }}
      </span>
      <span
        v-if="item.isNew"
        class="absolute right-0 top-0 rounded-bl-lg bg-rose-500 px-2 py-0.5 text-[10px] text-white font-bold"
      >
        NEW
      </span>

      <img
        v-if="showImage"
        :key="`${item.collectionId}:${imageSrc}`"
        :src="imageSrc"
        :alt="item.name"
        class="max-h-20 max-w-20 object-contain"
        loading="lazy"
        @error="onImageError"
      >
      <!-- 图标缺失占位：用稀有度色做底 + 名称首字，避免图裂 -->
      <div
        v-else
        class="h-20 w-20 flex flex-col items-center justify-center gap-1 rounded-lg"
        :style="accentColor ? { backgroundColor: `${accentColor}22` } : {}"
        :class="!accentColor && 'bg-white dark:bg-gray-800'"
      >
        <span class="text-2xl font-bold" :style="accentColor ? { color: accentColor } : {}">
          {{ String(item.name || '?').slice(0, 1) }}
        </span>
        <span class="text-[9px] text-gray-400">图标待补</span>
      </div>
    </div>

    <!-- 信息区 -->
    <div class="flex flex-1 flex-col gap-1.5 p-3">
      <div class="line-clamp-1 text-center text-sm text-gray-900 font-semibold dark:text-gray-100">
        {{ item.name }}
      </div>

      <!-- 星级 -->
      <div class="flex items-center justify-center gap-0.5">
        <span
          v-for="i in MAX_STAR"
          :key="i"
          class="text-[11px] leading-none"
          :class="i <= star ? 'text-amber-400' : 'text-gray-300 dark:text-gray-600'"
        >★</span>
      </div>

      <p class="line-clamp-2 min-h-[28px] text-center text-[10px] text-gray-500 leading-4 dark:text-gray-400">
        {{ item.desc || '暂无描述' }}
      </p>

      <div class="mt-auto flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400">
        <span>拥有 {{ item.ownCount }}</span>
        <span v-if="maxed" class="text-amber-500 font-semibold">已满星</span>
      </div>

      <p v-if="item.seriesName" class="text-center text-[10px] text-gray-500">{{ item.seriesName }} · {{ activated ? '已激活' : owned ? '待激活' : '未获得' }}</p>
      <p v-if="item.nextStarCosts?.length && !maxed" class="text-center text-[10px] text-gray-500">{{ item.nextStarCosts.map(cost => `${cost.name} ×${Number(cost.count).toLocaleString()}`).join('、') }}</p>
      <button v-if="activated" class="mt-1 w-full rounded-lg border border-blue-200 px-3 py-1.5 text-xs text-blue-700 dark:border-blue-700 dark:text-blue-200" :disabled="upgrading" @click="emit('display', item)">{{ item.displayed ? '取消展示' : '展示藏品' }}</button>
      <button
        v-if="owned && !maxed"
        class="mt-1 w-full rounded-lg px-3 py-1.5 text-xs text-white font-medium transition disabled:opacity-50"
        :style="{ backgroundColor: 'var(--theme-primary)' }"
        :disabled="!canUpgrade || upgrading"
        :title="canUpgrade ? (activated ? '确认真实材料后升星' : '激活此藏品') : '未满足解锁条件或副本不足'"
        type="button"
        @click="emit('upgrade', item)"
      >
        {{ upgrading ? '处理中…' : (canUpgrade ? activated ? '升星' : '激活' : '条件未满足') }}
      </button>
      <div
        v-else-if="!owned"
        class="mt-1 w-full rounded-lg bg-gray-100 px-3 py-1.5 text-center text-xs text-gray-400 dark:bg-gray-700 dark:text-gray-500"
      >
        未获得
      </div>
    </div>
  </article>
</template>
