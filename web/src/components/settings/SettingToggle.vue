<script setup lang="ts">
import { computed } from 'vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

const props = defineProps<{
  modelValue: boolean
  label: string
  sub?: string
  icon?: string
  color?: string
  img?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const colorMap: Record<string, string> = {
  green: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-300',
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300',
  indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300',
  teal: 'bg-teal-50 text-teal-600 dark:bg-teal-900/30 dark:text-teal-300',
  slate: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300',
  lime: 'bg-lime-50 text-lime-600 dark:bg-lime-900/30 dark:text-lime-300',
  cyan: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-300',
  gray: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300',
  orange: 'bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300',
  rose: 'bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300',
  pink: 'bg-pink-50 text-pink-600 dark:bg-pink-900/30 dark:text-pink-300',
  sky: 'bg-sky-50 text-sky-600 dark:bg-sky-900/30 dark:text-sky-300',
  red: 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300',
}

const colorClass = computed(() => colorMap[props.color || 'gray'] || colorMap.gray)
</script>

<template>
  <div class="flex items-center gap-3 rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm transition-colors hover:border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600">
    <div v-if="img" class="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-700">
      <img :src="img" alt="" class="h-full w-full object-cover">
    </div>
    <div
      v-else
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl"
      :class="colorClass"
    >
      <i :class="icon" />
    </div>
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
        {{ label }}
      </div>
      <div v-if="sub" class="truncate text-xs text-gray-400 dark:text-gray-500">
        {{ sub }}
      </div>
    </div>
    <BaseSwitch
      :model-value="modelValue ?? false"
      @update:model-value="emit('update:modelValue', $event ?? false)"
    />
  </div>
</template>
