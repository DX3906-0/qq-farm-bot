<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'
const { currentAccountId } = storeToRefs(useAccountStore())
const toast = useToastStore()
const packets = ref<Array<{ id: number, canClaim: boolean }>>([])
const message = ref('')
const busy = ref(false)
const pending = ref<{ id: number, accountId: string } | null>(null)
let revision = 0
let disposed = false
const valid = (id: string, rid: number) => !disposed && String(currentAccountId.value) === id && rid === revision
async function refresh() {
  const id = String(currentAccountId.value || '')
  if (!id) return
  const rid = ++revision
  busy.value = true
  try {
    const { data } = await api.get('/api/open-server-gifts', { headers: { 'x-account-id': id } })
    if (!valid(id, rid)) return
    if (!data?.ok || String(data.data?.accountId) !== id) throw new Error(data.error || '红包状态未确认')
    packets.value = data.data.packets || []
    message.value = data.data.message || ''
  }
  catch (cause: any) { if (valid(id, rid)) message.value = cause?.response?.data?.error || cause.message || '读取失败' }
  finally { if (valid(id, rid)) busy.value = false }
}
async function claim() {
  const target = pending.value
  if (!target || busy.value || target.accountId !== String(currentAccountId.value)) return
  const rid = revision
  busy.value = true
  try {
    const { data } = await api.post('/api/open-server-gifts/claim', { id: target.id, confirmed: true }, { headers: { 'x-account-id': target.accountId }, timeout: 70000 })
    if (!valid(target.accountId, rid)) return
    if (!data?.ok || data.data?.resultState !== 'completed') throw new Error(data.error || '红包结果未确认')
    toast.success(`获得：${data.data.rewards.map((item: any) => `${item.name} ×${item.count}`).join('、')}`)
    pending.value = null
    await refresh()
  }
  catch (cause: any) { if (valid(target.accountId, rid)) { message.value = cause?.response?.data?.error || cause.message; pending.value = null } }
  finally { if (String(currentAccountId.value) === target.accountId) busy.value = false }
}
watch(currentAccountId, () => { revision++; packets.value = []; pending.value = null; message.value = ''; busy.value = false }, { immediate: true })
onUnmounted(() => { disposed = true; revision++ })
</script>
<template>
  <section class="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
    <header class="flex items-center justify-between gap-3"><h3 class="font-semibold">开服红包</h3><button class="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-900/20 dark:text-blue-200" :disabled="busy || !currentAccountId" @click="refresh">{{ busy ? '处理中…' : '查询状态' }}</button></header>
    <p class="mt-2 text-xs text-gray-500">按服务器实际状态领取，不推断活动开放，不自动领奖。</p>
    <p v-if="message" class="mt-3 text-xs text-amber-700 dark:text-amber-200">{{ message }}</p>
    <div v-for="packet in packets" :key="packet.id" class="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 text-sm dark:border-gray-700"><span>红包 #{{ packet.id }}</span><button class="rounded-lg bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-40" :disabled="busy || !packet.canClaim" @click="pending = { id: packet.id, accountId: String(currentAccountId) }">{{ packet.canClaim ? '领取' : '当前不可领' }}</button></div>
    <ConfirmModal :show="!!pending" title="确认领取红包" message="将只发送一次领取请求，奖励以实际游戏回包为准；结果不明时不会重复提交；刷新只读取当前状态。" :loading="busy" @confirm="claim" @cancel="!busy && (pending = null)" />
  </section>
</template>
