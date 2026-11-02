<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '@/api'

const loading = ref(false)
const error = ref('')
const content = ref('')
const updatedAt = ref(0)

const gameLoading = ref(false)
const gameError = ref('')
const gameAvailable = ref(true)
const gameAccount = ref('')
type GameBulletin = { id: number; title: string; type: number; pic: string; content?: string; detailLoading?: boolean; detailError?: string }
const gameBulletins = ref<GameBulletin[]>([])
const selectedBulletin = ref<GameBulletin | null>(null)

async function openBulletin(b: GameBulletin) {
  selectedBulletin.value = { ...b, detailLoading: true, detailError: '' }
  try {
    const res = await api.get(`/api/announcement/detail/${b.id}`)
    const decoded = res.data?.data?.decoded
    if (decoded) {
      selectedBulletin.value = { ...b, ...decoded, detailLoading: false, detailError: '' }
    } else {
      selectedBulletin.value = { ...b, detailLoading: false }
    }
  } catch {
    selectedBulletin.value = { ...b, detailLoading: false, detailError: '公告详情加载失败（账号可能未在线）' }
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await api.get('/api/announcement')
    if (data.ok) {
      content.value = data.data?.content || ''
      updatedAt.value = Number(data.data?.updatedAt) || 0
    } else {
      error.value = data.error || '获取公告失败'
    }
  } catch (e) {
    error.value = (e as Error)?.message || '获取公告失败'
  } finally {
    loading.value = false
  }
}

async function loadGame() {
  gameLoading.value = true
  gameError.value = ''
  try {
    const { data } = await api.get('/api/announcement/game')
    if (data.ok) {
      const d = data.data || {}
      gameAvailable.value = d.available !== false
      gameAccount.value = d.accountName || ''
      gameBulletins.value = Array.isArray(d.bulletins) ? d.bulletins : []
      if (!gameAvailable.value) gameError.value = d.error || '暂无法获取游戏公告'
    } else {
      gameError.value = data.error || '获取游戏公告失败'
    }
  } catch {
    gameAvailable.value = false
    gameError.value = '暂无法获取游戏公告（账号可能未在线）'
  } finally {
    gameLoading.value = false
  }
}

function formatTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(() => { load(); loadGame() })
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-semibold text-gray-900 dark:text-white">系统公告</h2>
        <button
          class="text-xs text-gray-400 transition hover:text-gray-600 disabled:opacity-50"
          :disabled="loading"
          @click="load"
        >
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div v-if="loading" class="py-8 text-center text-sm text-gray-400">加载中…</div>
      <div v-else-if="error" class="py-8 text-center text-sm text-red-500">{{ error }}</div>
      <div v-else-if="!content" class="py-8 text-center text-sm text-gray-400">暂无公告</div>
      <div v-else>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700 dark:text-gray-200">{{ content }}</p>
        <div v-if="updatedAt" class="mt-3 text-right text-xs text-gray-400">更新于 {{ formatTime(updatedAt) }}</div>
      </div>
    </div>

    <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-semibold text-gray-900 dark:text-white">游戏公告</h2>
        <button
          class="text-xs text-gray-400 transition hover:text-gray-600 disabled:opacity-50"
          :disabled="gameLoading"
          @click="loadGame"
        >
          {{ gameLoading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div v-if="gameLoading" class="py-8 text-center text-sm text-gray-400">加载中…</div>
      <div v-else-if="!gameAvailable" class="py-8 text-center text-sm text-gray-400">{{ gameError || '暂无游戏公告' }}</div>
      <div v-else-if="!gameBulletins.length" class="py-8 text-center text-sm text-gray-400">暂无游戏公告</div>
      <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div
          v-for="b in gameBulletins"
          :key="b.id"
          role="button"
          tabindex="0"
          class="cursor-pointer overflow-hidden rounded-lg border border-gray-100 transition hover:ring-2 hover:ring-[var(--theme-primary)] dark:border-gray-700"
          @click="openBulletin(b)"
          @keydown.enter.prevent="openBulletin(b)"
          @keydown.space.prevent="openBulletin(b)"
        >
          <img v-if="b.pic" :src="b.pic" :alt="b.title" class="h-32 w-full object-cover" loading="lazy" />
          <div class="p-3">
            <p class="text-sm font-medium text-gray-800 dark:text-gray-100">{{ b.title || '（无标题）' }}</p>
            <p class="mt-1 text-xs text-gray-400">ID: {{ b.id }}<span v-if="b.type"> · 类型 {{ b.type }}</span></p>
            <p class="mt-1 text-xs text-[var(--theme-primary)]">点击查看内容 ›</p>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="selectedBulletin"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        @click.self="selectedBulletin = null"
      >
        <div class="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-800">
          <button
            class="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
            aria-label="关闭"
            @click="selectedBulletin = null"
          >
            <div class="i-carbon-close text-lg" />
          </button>
          <div class="flex-1 overflow-y-auto p-4">
            <p class="mb-3 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedBulletin.title || '（无标题）' }}</p>
            <img
              v-if="selectedBulletin.pic"
              :src="selectedBulletin.pic"
              :alt="selectedBulletin.title"
              class="mb-3 max-h-64 w-full rounded-lg bg-black/5 object-contain"
            />
            <p v-if="selectedBulletin.detailLoading" class="py-4 text-center text-sm text-gray-400">正在加载公告详情…</p>
            <p v-else-if="selectedBulletin.detailError" class="rounded-lg bg-red-50 p-3 text-sm text-red-500 dark:bg-red-900/20">{{ selectedBulletin.detailError }}</p>
            <div
              v-else-if="selectedBulletin.content"
              class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900"
            >
              <div class="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700 dark:text-gray-200">{{ selectedBulletin.content }}</div>
            </div>
            <p v-else class="text-sm text-gray-400">该公告以图片形式发布，请查看上方配图。</p>
          </div>
          <div class="border-t border-gray-100 p-4 dark:border-gray-700">
            <p class="text-xs text-gray-400">ID: {{ selectedBulletin.id }}<span v-if="selectedBulletin.type"> · 类型 {{ selectedBulletin.type }}</span></p>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
