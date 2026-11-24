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
function endDate(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value * 1000))
}
</script>

<template>
  <article class="min-h-[216px] min-w-0 flex flex-col overflow-hidden border border-gray-200 rounded-lg bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
    <div class="relative grid h-24 place-items-center bg-gray-50 dark:bg-gray-900/40">
      <span class="absolute left-0 top-0 rounded-br-lg bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600 font-semibold dark:bg-gray-700 dark:text-gray-300">
        #{{ item.itemId }}
      </span>
      <span class="absolute right-0 top-0 rounded-bl-lg bg-purple-50 px-2 py-0.5 text-[10px] text-purple-700 font-semibold dark:bg-purple-900/20 dark:text-purple-300">
        {{ statusLabel }}
      </span>
      <img v-if="item.image && !imageFailed" :src="item.image" :alt="item.name" class="max-h-14 max-w-14 object-contain" @error="imageFailed = true">
      <div v-else class="grid h-14 w-14 place-items-center rounded-lg bg-white text-sm text-gray-500 font-semibold dark:bg-gray-800">
        {{ String(item.name || '?').slice(0, 1) }}
      </div>
    </div>
    <div class="min-h-[120px] flex flex-1 flex-col p-3">
      <div class="line-clamp-2 text-center text-sm text-gray-900 font-semibold dark:text-gray-100">{{ item.name }}</div>
      <div class="mt-1 text-center text-xs text-amber-600 font-semibold dark:text-amber-400">
        <template v-if="item.priceKnown !== true || item.price == null">售价待确认</template>
        <template v-else-if="item.isFree">免费</template>
        <template v-else>{{ formatCurrencyAmountByLabel(item.price, item.currencyName || '') }} {{ item.currencyName || '币种待确认' }}</template>
      </div>
      <div v-if="item.isDiscounted && item.originalPrice != null" class="mt-1 text-center text-[10px] text-gray-400">
        限时优惠 · 原价 <span class="line-through">{{ formatCurrencyAmountByLabel(item.originalPrice, item.currencyName || '') }}</span>
      </div>
      <p class="line-clamp-2 mt-2 text-[11px] text-gray-500 leading-5 dark:text-gray-400">{{ item.effectDesc || item.desc || '暂无描述' }}</p>
      <div v-if="item.limitCount > 0" class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">限购 {{ item.boughtNum || 0 }} / {{ item.limitCount }}</div>
      <div v-if="item.endTime > 0" class="mt-1 text-[11px] text-gray-500 dark:text-gray-400">售卖至 {{ endDate(item.endTime) }}（北京时间）</div>
      <p class="line-clamp-2 mt-1 text-[11px] text-gray-500 leading-5 dark:text-gray-400">{{ hint }}</p>
      <BaseButton class="mt-auto w-full" variant="primary"
        :disabled="item.canBuy !== true || !canAfford || item.owned || item.resultUnknown || item.priceKnown !== true || currentLevel < (item.requiredLevel || 0)"
        @click="emit('buy', item)">
        {{ item.canBuy && canAfford && !item.owned && !item.resultUnknown && currentLevel >= (item.requiredLevel || 0) ? (item.isFree ? '免费领取' : '立即购买') : statusLabel }}
      </BaseButton>
    </div>
  </article>
</template>
