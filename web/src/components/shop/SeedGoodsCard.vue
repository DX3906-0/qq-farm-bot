<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { formatCurrencyAmountByLabel } from '@/utils/number-format'

const props = defineProps<{
  item: any
  currentLevel: number
  canAfford: boolean
  statusLabel: string
  hint: string
}>()
const emit = defineEmits<{ (e: 'buy', item: any): void }>()
const imageFailed = ref(false)
watch(() => props.item.image, () => { imageFailed.value = false })
</script>

<template>
  <article class="min-h-[216px] min-w-0 flex flex-col overflow-hidden border border-gray-200 rounded-lg bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div class="relative grid h-24 place-items-center bg-gray-50 dark:bg-gray-900/40">
      <span class="absolute left-0 top-0 rounded-br-lg bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600 font-semibold dark:bg-gray-700 dark:text-gray-300">#{{ item.itemId }}</span>
      <span class="absolute right-0 top-0 rounded-bl-lg bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700 font-semibold dark:bg-emerald-900/20 dark:text-emerald-300">
        {{ item.isForage ? '牧草' : `Lv.${item.seedLevel ?? '—'}` }}
      </span>
      <img v-if="item.image && !imageFailed" :src="item.image" :alt="item.name" class="max-h-14 max-w-14 object-contain" @error="imageFailed = true">
      <div v-else class="grid h-14 w-14 place-items-center rounded-lg bg-white text-sm text-gray-500 font-semibold dark:bg-gray-800">{{ String(item.name || '?').slice(0, 1) }}</div>
    </div>
    <div class="min-h-[120px] flex flex-1 flex-col p-3">
      <div class="line-clamp-2 text-center text-sm text-gray-900 font-semibold dark:text-gray-100">{{ item.name }}</div>
      <div class="mt-1 text-center text-xs text-amber-600 font-semibold dark:text-amber-400">
        <template v-if="item.priceKnown === false || item.price == null">售价待确认</template>
        <template v-else>价格 {{ formatCurrencyAmountByLabel(item.price, item.currencyName || '') }} {{ item.currencyKnown === false ? '币种待确认' : item.currencyName || '金币' }}</template>
      </div>
      <div class="mt-2 text-[11px] text-gray-500 leading-5 dark:text-gray-400">
        <div v-if="item.isForage">种植后可收获牧草</div>
        <div v-if="item.requiredLevel != null">需求等级 {{ item.requiredLevel }}</div>
        <div v-if="item.harvestKnown !== false && item.seasons != null && item.expPerSeason != null" class="truncate">
          季数 {{ item.seasons }} / 每季经验 {{ item.expPerSeason.toLocaleString() }}
        </div>
        <div v-else>生长与收获数据待确认</div>
      </div>
      <p class="line-clamp-2 mt-1 text-[11px] text-gray-500 leading-5 dark:text-gray-400">{{ hint }}</p>
      <BaseButton class="mt-auto w-full" variant="primary"
        :disabled="item.catalogOnly || item.canBuy === false || item.currencyKnown === false || item.resultUnknown || !item.unlocked || item.isSoldOut || item.expired || currentLevel < (item.requiredLevel || 0) || !canAfford"
        @click="emit('buy', item)">
        {{ statusLabel === '可购买' ? '立即购买' : statusLabel }}
      </BaseButton>
    </div>
  </article>
</template>
