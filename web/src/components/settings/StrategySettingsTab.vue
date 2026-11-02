<script setup lang="ts">
import BagSeedPriorityPanel from '@/components/settings/BagSeedPriorityPanel.vue'
import StrategyTimingPanel from '@/components/settings/StrategyTimingPanel.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

interface SelectOption<T = string | number> {
  label: string
  value: T
  disabled?: boolean
}

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

interface StrategySettings {
  plantingStrategy: string
  preferredSeedId: number
  prioritize2x2Crops: boolean
  bagSeedPriority: number[]
  bagSeedFallbackStrategy: string
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  intervals: {
    farmMin: number
    farmMax: number
    helpMin: number
    helpMax: number
    stealMin: number
    stealMax: number
  }
  friendQuietHours: {
    enabled: boolean
    start: string
    end: string
    exemptGids: number[]
  }
}

// 延迟收获是 automation 字段（存于 localAutomationSettings.automation），
// 由 Settings.vue 把整个 automation 对象传入本组件，输入框直接改 harvest_delay_min。
interface AutomationSubset {
  harvest_delay_min: number
}

withDefaults(defineProps<{
  currentAccountName: string | null
  currentAccountId: string | number | null | undefined
  loading: boolean
  saving: boolean
  plantingStrategyOptions: SelectOption[]
  preferredSeedOptions: SelectOption<number>[]
  bagFallbackStrategyOptions: SelectOption[]
  strategyPreviewLabel: string | null
  bagSeeds: BagSeedItem[]
  sortedBagSeeds: BagSeedItem[]
  bagSeedsLoading: boolean
  bagSeedsError: string | null
  automation?: AutomationSubset
  title?: string
  saveLabel?: string
}>(), {
  title: '策略设置',
  saveLabel: '保存策略设置',
  automation: () => ({ harvest_delay_min: 0 }),
})

const emit = defineEmits<{
  resetBagSeedPriority: []
  moveBagSeed: [seedId: number, direction: -1 | 1]
  removeBagSeed: [seedId: number]
  startBagSeedDrag: [seedId: number, event: DragEvent]
  dragOverBagSeed: [seedId: number, event: DragEvent]
  dropBagSeed: [seedId: number, event: DragEvent]
  save: []
}>()

const settings = defineModel<StrategySettings>('settings', { required: true })
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="flex items-center gap-2.5 text-lg text-[#2C2A22] font-bold dark:text-[#ECE9DE]">
        <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
          <i class="i-fas-cog" />
        </span>
        {{ title }}
        <span v-if="currentAccountName" class="ml-1 text-sm text-[#8C8472] font-normal dark:text-[#9C9A88]">
          ({{ currentAccountName }})
        </span>
      </h3>
    </div>

    <div v-if="loading" class="py-4 text-center text-[#8C8472]">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else-if="!currentAccountId" class="py-8 text-center text-[#8C8472]">
      <div class="i-carbon-settings-adjust mx-auto mb-2 text-3xl opacity-50" />
      <p>请先选择账号</p>
    </div>

    <div v-else class="space-y-4">
      <!-- 种植策略 -->
      <section class="farm-card p-5 space-y-4">
        <div class="section-head">
          <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
            <i class="i-carbon-sprout" />
          </span>
          <div>
            <h4 class="text-base font-bold text-[#2C2A22] dark:text-[#ECE9DE]">种植策略</h4>
            <p class="text-xs text-[#8C8472] dark:text-[#9C9A88]">选种方式与优先级</p>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseSelect
            v-model="settings.plantingStrategy"
            label="种植策略"
            :options="plantingStrategyOptions"
          />
          <BaseSelect
            v-if="settings.plantingStrategy === 'preferred'"
            v-model="settings.preferredSeedId"
            label="优先种植种子"
            :options="preferredSeedOptions"
          />
          <BaseSelect
            v-else-if="settings.plantingStrategy === 'bag_priority' && settings.bagSeedFallbackStrategy === 'preferred'"
            v-model="settings.preferredSeedId"
            label="优先种植种子"
            :options="preferredSeedOptions"
          />
          <div v-else class="flex flex-col gap-1.5">
            <label class="text-sm text-[#2C2A22] font-medium dark:text-[#ECE9DE]">
              {{ settings.plantingStrategy === 'bag_priority' ? '第二优先策略预览' : '策略选种预览' }}
            </label>
            <div
              class="w-full flex items-center justify-between border border-[#ECE5D6] rounded-lg bg-[#F7F2E7] px-3 py-2 text-[#8C8472] dark:border-[#32362B] dark:bg-[#262B20] dark:text-[#9C9A88]"
            >
              <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
              <div class="i-carbon-chevron-down shrink-0 text-lg opacity-60" />
            </div>
          </div>
        </div>
      </section>

      <!-- 优先 2×2 作物 -->
      <section class="farm-card sage-tint p-5 space-y-3">
        <div class="section-head">
          <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
            <i class="i-carbon-grid" />
          </span>
          <h4 class="text-base font-bold text-[#2C2A22] dark:text-[#ECE9DE]">优先 2×2 作物</h4>
        </div>
        <BaseSwitch
          v-model="settings.prioritize2x2Crops"
          label="优先种植 2×2 作物"
        />
        <p class="text-xs leading-5 text-[#5E8C5A] dark:text-[#A7C957]">
          开启后会根据背包中的四格种子预留完整 2×2 区域；预留区收获后暂不补种普通作物，四块全部空闲时自动种植。四格种子不会从商城购买。
        </p>
      </section>

      <!-- 背包种子优先级 -->
      <section v-if="settings.plantingStrategy === 'bag_priority'" class="farm-card p-5 space-y-4">
        <div class="section-head">
          <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
            <i class="i-carbon-tree" />
          </span>
          <div>
            <h4 class="text-base font-bold text-[#2C2A22] dark:text-[#ECE9DE]">背包种子优先级</h4>
            <p class="text-xs text-[#8C8472] dark:text-[#9C9A88]">拖拽排序，越靠前越优先</p>
          </div>
        </div>
        <BaseSelect
          v-model="settings.bagSeedFallbackStrategy"
          label="第二优先策略"
          :options="bagFallbackStrategyOptions"
        />
        <BagSeedPriorityPanel
          :seeds="bagSeeds"
          :sorted-seeds="sortedBagSeeds"
          :loading="bagSeedsLoading"
          :error="bagSeedsError"
          @reset="emit('resetBagSeedPriority')"
          @move="(seedId, direction) => emit('moveBagSeed', seedId, direction)"
          @remove="seedId => emit('removeBagSeed', seedId)"
          @drag-start="(seedId, event) => emit('startBagSeedDrag', seedId, event)"
          @drag-over="(seedId, event) => emit('dragOverBagSeed', seedId, event)"
          @drop="(seedId, event) => emit('dropBagSeed', seedId, event)"
        />
      </section>

      <!-- 时间策略 -->
      <section class="farm-card p-5 space-y-4">
        <div class="section-head">
          <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
            <i class="i-carbon-time" />
          </span>
          <div>
            <h4 class="text-base font-bold text-[#2C2A22] dark:text-[#ECE9DE]">时间策略</h4>
            <p class="text-xs text-[#8C8472] dark:text-[#9C9A88]">巡查间隔与静默时段</p>
          </div>
        </div>
        <StrategyTimingPanel v-model:settings="settings" :current-account-id="currentAccountId" />
      </section>

      <!-- 延迟收获 -->
      <section class="farm-card p-5 space-y-3">
        <div class="section-head">
          <span class="plot-icon h-9 w-9 inline-grid place-items-center rounded-xl text-lg">
            <i class="i-carbon-basketball" />
          </span>
          <div>
            <h4 class="text-base font-bold text-[#2C2A22] dark:text-[#ECE9DE]">延迟收获</h4>
            <p class="text-xs text-[#8C8472] dark:text-[#9C9A88]">成熟作物静默片刻后统一一键收，更像真人</p>
          </div>
        </div>
        <div class="flex flex-wrap items-end gap-4">
          <BaseInput
            v-model.number="automation.harvest_delay_min"
            label="延迟收获 (分钟)"
            type="number"
            min="0"
            max="1440"
            class="w-40"
          />
          <p class="text-xs leading-5 text-[#8C8472] dark:text-[#9C9A88]" style="max-width: 420px">
            设为 &gt;0 时，作物成熟后不再立即收，而是「静默 N 分钟（在你设值附近抖动）无新成熟 → 一键收全部」；
            期间若又有新成熟则重新计时。另设「设置值 + 30min」上限强制收，防止拖到枯死。填 0 表示成熟立即收。
            浇水 / 除草 / 除虫不受影响。
          </p>
        </div>
      </section>

      <!-- 保存 -->
      <div class="flex justify-end">
        <BaseButton
          variant="primary"
          size="sm"
          class="rounded-2xl px-7 py-2.5 text-sm font-semibold shadow-md"
          :loading="saving"
          @click="emit('save')"
        >
          {{ saveLabel }}
        </BaseButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.farm-card {
  border: 1px solid #ECE5D6;
  background: #FCFBF6;
  border-radius: 1.25rem;
  box-shadow: 0 1px 2px rgba(60, 50, 30, 0.04), 0 12px 30px -16px rgba(60, 50, 30, 0.20);
  transition: box-shadow .3s ease, transform .3s ease;
}
.dark .farm-card {
  border-color: #32362B;
  background: #1E211A;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 12px 30px -16px rgba(0, 0, 0, 0.55);
}
.farm-card:hover {
  box-shadow: 0 16px 40px -18px rgba(60, 50, 30, 0.28);
}

.sage-tint {
  background: linear-gradient(180deg, #F3F7EE, #FCFBF6);
}
.dark .sage-tint {
  background: linear-gradient(180deg, #1F261C, #1E211A);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.plot-icon {
  color: #5E8C5A;
  background: #F0ECDD;
  transition: transform .3s cubic-bezier(.22, 1, .36, 1), color .3s ease, background .3s ease;
}
.dark .plot-icon {
  color: #84B572;
  background: #2A2E22;
}
.farm-card:hover .plot-icon {
  transform: scale(1.08) rotate(-4deg);
}
</style>
