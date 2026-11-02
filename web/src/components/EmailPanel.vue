<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
import api from '@/api'

interface EmailItem {
  id: string
  mail_type?: number
  title?: string
  subtitle?: string
  claimed?: boolean
  has_reward?: boolean
  box_type?: number | null
}

const accountStore = useAccountStore()
const toastStore = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)

const emails = ref<EmailItem[]>([])
const loading = ref(false)
const claiming = ref<Record<string, boolean>>({})
const claimingAll = ref(false)
const loaded = ref(false)

const claimableCount = computed(() => emails.value.filter(e => e.has_reward && !e.claimed).length)

async function fetchEmails() {
  const accountId = currentAccountId.value
  if (!accountId) return
  loading.value = true
  try {
    const { data } = await api.get('/api/account/email', { params: { boxType: 0 } })
    emails.value = data?.data?.emails || []
    loaded.value = true
  }
  catch (_) {
    // 拦截器已提示
  }
  finally {
    loading.value = false
  }
}

async function claimOne(email: EmailItem) {
  const accountId = currentAccountId.value
  if (!accountId) return
  claiming.value[email.id] = true
  try {
    const boxType = Number(email.box_type) || 1
    const { data } = await api.post('/api/account/email/claim', { boxType, emailId: email.id })
    const items = data?.data?.items || []
    email.claimed = true
    if (items.length > 0) {
      const summary = items.map((it: any) => {
        const name = it?.name || it?.itemName || `物品#${it?.id ?? ''}`
        return `${name}x${it?.count ?? 1}`
      }).join('、')
      toastStore.success(`领取成功：${summary}`)
    }
    else {
      toastStore.success('领取成功')
    }
  }
  catch (_) {
    // 拦截器已提示
  }
  finally {
    claiming.value[email.id] = false
  }
}

async function claimAll() {
  const accountId = currentAccountId.value
  if (!accountId) return
  claimingAll.value = true
  try {
    const { data } = await api.post('/api/account/email/claim-all')
    const result = data?.data
    const count = result?.total ?? 0
    if (count > 0) {
      toastStore.success(`已领取 ${count} 封邮件`)
      await fetchEmails()
    }
    else {
      toastStore.info('没有可领取的邮件')
    }
  }
  catch (_) {
    // 拦截器已提示
  }
  finally {
    claimingAll.value = false
  }
}

function emailBoxLabel(email: EmailItem) {
  if (Number(email.box_type) === 2) return '玩家'
  if (Number(email.box_type) === 1) return '系统'
  const mailType = Number(email.mail_type)
  return mailType === 2 ? '玩家' : '系统'
}

watch(currentAccountId, (newId, oldId) => {
  if (oldId !== undefined && newId !== oldId) {
    emails.value = []
    loaded.value = false
  }
  if (newId) fetchEmails()
}, { immediate: true })

onMounted(() => {
  if (currentAccountId.value) fetchEmails()
})
</script>

<template>
  <div class="space-y-4">
    <!-- 头部：未领计数 + 一键领取 -->
    <div class="flex flex-col rounded-lg bg-white p-4 shadow dark:bg-gray-800">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="flex items-center gap-2 font-medium">
          <div class="i-carbon-mail-all text-blue-500" />
          <span>我的邮箱</span>
          <span
            v-if="claimableCount > 0"
            class="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-600 dark:bg-blue-900/20 dark:text-blue-300"
          >
            {{ claimableCount }} 封待领取
          </span>
        </h3>
        <button
          class="rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
          style="background-color: var(--theme-primary)"
          :disabled="claimingAll || claimableCount === 0"
          @click="claimAll"
        >
          {{ claimingAll ? '领取中...' : '一键领取全部' }}
        </button>
      </div>

      <!-- 未登录 -->
      <div
        v-if="!currentAccountId"
        class="flex flex-col items-center justify-center gap-3 rounded-lg bg-gray-50 py-8 text-center text-gray-500 dark:bg-gray-900/40 dark:text-gray-400"
      >
        <div class="i-carbon-user-offline text-3xl text-gray-400" />
        <div>
          <div class="text-sm font-medium text-gray-600 dark:text-gray-300">未登录账号</div>
          <div class="mt-1 text-xs text-gray-400">请先添加农场账号</div>
        </div>
      </div>

      <!-- 加载中 -->
      <div
        v-else-if="loading && !loaded"
        class="flex flex-col items-center justify-center gap-3 rounded-lg bg-gray-50 py-8 text-center text-gray-400 dark:bg-gray-900/40"
      >
        <div class="i-carbon-circle-dash h-6 w-6 animate-spin text-lg" />
        <div class="text-xs">正在获取邮箱...</div>
      </div>

      <!-- 邮件列表 -->
      <div v-else class="space-y-2">
        <div
          v-if="emails.length === 0"
          class="flex flex-col items-center justify-center gap-2 rounded-lg bg-gray-50 py-8 text-center text-gray-400 dark:bg-gray-900/40"
        >
          <div class="i-carbon-mail-all text-3xl text-gray-300 dark:text-gray-600" />
          <div class="text-xs">邮箱是空的</div>
        </div>

        <div
          v-for="email in emails"
          :key="email.id"
          class="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700"
          :class="{ 'bg-gray-50 dark:bg-gray-900/40 opacity-70': email.claimed, 'bg-white dark:bg-gray-800': !email.claimed }"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold"
                :class="emailBoxLabel(email) === '系统'
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-300'
                  : 'bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-300'"
              >
                {{ emailBoxLabel(email) }}
              </span>
              <span class="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                {{ email.title || '（无标题）' }}
              </span>
            </div>
            <div v-if="email.subtitle" class="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
              {{ email.subtitle }}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span
              v-if="email.claimed"
              class="text-xs text-gray-400 dark:text-gray-500"
            >
              已领取
            </span>
            <span
              v-else-if="email.has_reward"
              class="text-xs font-medium text-amber-600 dark:text-amber-400"
            >
              有奖励
            </span>
            <button
              v-if="!email.claimed && email.has_reward"
              class="rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40"
              style="background-color: var(--theme-primary)"
              :disabled="claiming[email.id]"
              @click="claimOne(email)"
            >
              {{ claiming[email.id] ? '领取中...' : '领取' }}
            </button>
          </div>
        </div>

        <!-- 刷新 -->
        <div class="flex justify-center pt-1">
          <button
            class="text-xs text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            :disabled="loading"
            @click="fetchEmails"
          >
            {{ loading ? '刷新中...' : '↻ 刷新' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
