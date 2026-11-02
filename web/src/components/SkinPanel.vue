<script setup lang="ts">
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { computed, onMounted, ref, watch } from 'vue'

interface SkinItem {
  skinId: number
  slotType: number
  name: string
  image: string
  partName: string
  equipped: boolean
  isNew: boolean
  desc: string
}
interface SkinSlot {
  slotType: number
  label: string
  equippedSkinId: number
}

const accountStore = useAccountStore()

const loading = ref(false)
const error = ref('')
const slots = ref<SkinSlot[]>([])
const items = ref<SkinItem[]>([])
const ownedCount = ref(0)
const switchingId = ref(0)
const toast = ref('')
/** 放大预览 */
const preview = ref<SkinItem | null>(null)

const accountId = computed(() => accountStore.currentAccountId)

/** 当前装备（用于顶部"当前外观"速览） */
const equippedItems = computed(() => items.value.filter(i => i.equipped))

/** 按槽位分组；每组内已装备的排最前 */
const grouped = computed(() => {
  const map = new Map<number, SkinItem[]>()
  for (const it of items.value) {
    if (!map.has(it.slotType))
      map.set(it.slotType, [])
    map.get(it.slotType)!.push(it)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slotType, list]) => ({
      slotType,
      label: slots.value.find(s => s.slotType === slotType)?.label || `槽位${slotType}`,
      list: [...list].sort((a, b) => (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) || a.skinId - b.skinId),
    }))
})

async function load() {
  if (!accountId.value) {
    error.value = '请先选择账号'
    return
  }
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/skins', { timeout: 120000 })
    const payload = data?.data || {}
    slots.value = payload.slots || []
    items.value = payload.items || []
    ownedCount.value = payload.ownedCount || (payload.items || []).length
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '读取装扮失败'
  }
  finally {
    loading.value = false
  }
}

async function equip(item: SkinItem) {
  if (item.equipped || switchingId.value)
    return
  switchingId.value = item.skinId
  try {
    const { data } = await api.post('/api/skins/equip', {
      skinId: item.skinId,
      slotType: item.slotType,
    }, { timeout: 60000 })
    if (data?.ok) {
      // 同一槽位只能装一件：本地先把旧的取消高亮，再点亮新的
      for (const it of items.value) {
        if (it.slotType === item.slotType)
          it.equipped = it.skinId === item.skinId
      }
      toast.value = `已换上「${item.name}」`
    }
    else {
      toast.value = data?.error || '换装失败'
    }
  }
  catch (e: any) {
    toast.value = e?.response?.data?.error || e?.message || '换装失败'
  }
  finally {
    switchingId.value = 0
    setTimeout(() => (toast.value = ''), 2600)
  }
}

function openPreview(item: SkinItem) {
  if (item.image)
    preview.value = item
}

onMounted(load)
// 切换账号时重新读取（装扮是账号级数据）
watch(accountId, () => load())
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <h3 class="text-base font-semibold text-gray-900 dark:text-white">
        装扮
      </h3>
      <span class="text-xs text-gray-500">已拥有 {{ ownedCount }} 件 · {{ slots.length }} 个槽位</span>
      <button
        class="ml-auto rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
        :disabled="loading" @click="load"
      >
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <p v-if="error" class="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-900/20 dark:text-rose-300">
      {{ error }}
    </p>

    <!-- 当前外观速览 -->
    <div v-if="equippedItems.length" class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 text-xs font-medium text-gray-500">
        当前外观
      </div>
      <div class="flex flex-wrap gap-3">
        <button
          v-for="it in equippedItems" :key="it.skinId"
          class="flex w-16 flex-col items-center rounded-lg p-1 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          :title="it.name" @click="openPreview(it)"
        >
          <img
            v-if="it.image" :src="it.image" :alt="it.name"
            class="h-12 w-12 rounded-lg border border-gray-200 object-contain dark:border-gray-600"
          >
          <div v-else class="h-12 w-12 flex items-center justify-center rounded-lg border border-dashed border-gray-300 text-[10px] text-gray-400 dark:border-gray-600">
            暂无图
          </div>
          <span class="mt-1 w-full truncate text-center text-[10px] text-gray-500">{{ it.name }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading && !items.length" class="py-10 text-center text-sm text-gray-400">
      读取中…
    </div>

    <div v-for="g in grouped" :key="g.slotType" class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      <div class="mb-2 flex items-center gap-2">
        <span class="text-sm font-medium text-gray-900 dark:text-white">{{ g.label }}</span>
        <span class="text-xs text-gray-400">槽位{{ g.slotType }} · {{ g.list.length }} 款</span>
      </div>
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <button
          v-for="it in g.list" :key="it.skinId"
          class="group flex flex-col items-center rounded-lg border p-2 text-center transition"
          :class="it.equipped
            ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-500/70 dark:bg-emerald-900/20'
            : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'"
          :disabled="switchingId !== 0" @click="equip(it)"
        >
          <img
            v-if="it.image" :src="it.image" :alt="it.name"
            class="h-12 w-12 object-contain" @click.stop="openPreview(it)"
          >
          <div v-else class="h-12 w-12 flex items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400 dark:border-gray-600">
            暂无图
          </div>
          <span class="mt-1 w-full truncate text-[11px]" :class="it.equipped ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-gray-600 dark:text-gray-300'">
            {{ it.name }}
          </span>
          <span v-if="it.equipped" class="mt-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">使用中</span>
          <span v-else-if="switchingId === it.skinId" class="mt-0.5 text-[10px] text-gray-400">换装中…</span>
        </button>
      </div>
    </div>

    <div
      v-if="toast"
      class="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
    >
      {{ toast }}
    </div>

    <!-- 放大预览：图标原始只有 100x100，放大后看细节 -->
    <div
      v-if="preview"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      @click="preview = null"
    >
      <div class="max-h-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-2xl dark:bg-gray-800" @click.stop>
        <div class="mb-3 flex items-start gap-3">
          <div class="min-w-0">
            <div class="truncate text-base font-semibold text-gray-900 dark:text-white">
              {{ preview.name }}
            </div>
            <div class="text-xs text-gray-500">
              {{ preview.partName || `槽位${preview.slotType}` }} · ID {{ preview.skinId }}
              <span v-if="preview.equipped" class="ml-1 text-emerald-600 dark:text-emerald-400">使用中</span>
            </div>
          </div>
          <button class="ml-auto text-sm text-gray-400 hover:text-gray-600" @click="preview = null">
            ✕
          </button>
        </div>
        <img
          :src="preview.image" :alt="preview.name"
          class="mx-auto block w-[320px] max-w-full rounded-xl border border-gray-200 bg-gray-50 object-contain dark:border-gray-600 dark:bg-gray-900"
        >
        <p v-if="preview.desc" class="mt-3 text-xs text-gray-500">
          {{ preview.desc }}
        </p>
        <button
          v-if="!preview.equipped"
          class="mt-4 w-full rounded-lg px-4 py-2 text-sm text-white"
          :style="{ backgroundColor: 'var(--theme-primary)' }"
          :disabled="switchingId !== 0"
          @click="() => { equip(preview!); preview = null }"
        >
          {{ switchingId === preview.skinId ? '换装中…' : '换上这件' }}
        </button>
      </div>
    </div>
  </div>
</template>
