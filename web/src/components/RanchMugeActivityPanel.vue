<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import type { RanchMugeActivity, RanchMugeTier } from '@/stores/ranch'
import { formatIntegerAmount } from '@/utils/number-format'

const props = defineProps<{ activity: RanchMugeActivity | null, accountId?: string, readOnly?: boolean, readOnlyReason?: string,
  automaticClaimEnabled?: boolean | null, automaticClaimSummary?: string,
  operate: (action: string, input?: Record<string, unknown>) => Promise<{ ok: boolean, error?: string, unknown?: boolean }> }>()
const emit = defineEmits<{ (e: 'refresh'): void }>()
const tab = ref<'celebration' | 'friends' | 'handbook' | 'personality'>('celebration')
const busy = ref(false)
const blockedUnknown = ref(false)
const blockedUnknownAccount = ref('')
const unknownBlockedForCurrentAccount = computed(() => blockedUnknown.value && blockedUnknownAccount.value === String(props.accountId || ''))
const retaking = ref(false)
const error = ref('')
const savedMessage = ref('')
const savingQuestion = ref<number | null>(null)
const answerDraft = ref<Record<string, string>>({})
const queuedAnswers = new Map<number, number>()
const queuedQuestionIds = ref(new Set<number>())
const drainingAnswers = ref(false)
const oneClickBusy = ref(false)
const answerQueueBusy = computed(() => drainingAnswers.value || queuedQuestionIds.value.size > 0)
const imagePreviewOpen = ref(false)
function onPreviewKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && imagePreviewOpen.value) imagePreviewOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onPreviewKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown))

const sections = [
  { key: 'celebration', label: '兴牧庆典' },
  { key: 'friends', label: '牧友同行' },
  { key: 'handbook', label: '成长手册' },
  { key: 'personality', label: '牧场人格' },
] as const
const current = computed(() => props.activity)
const readOnly = computed(() => props.readOnly === true || unknownBlockedForCurrentAccount.value)
const claimableCount = (tiers?: RanchMugeTier[]) => (tiers || []).filter(row => row.status === 2).length
function statusText(status: number) { return status === 3 ? '已领取' : status === 2 ? '可领取' : status === 4 ? '未解锁' : '进行中' }
function displayTime(ms: number) { return ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '时间未确认' }
function percentage(value: string, target: string) {
  const a = BigInt(value || '0'), b = BigInt(target || '0')
  if (b <= 0n) return 0
  return Number(a >= b ? 100n : a * 100n / b)
}
function formatAmount(value: string | number) { return formatIntegerAmount(value) }
function selectRandomAnswers(questions: RanchMugeActivity['questions'], random: () => number = Math.random) {
  return questions.map(question => {
    if (!question.options.length) throw new Error(`第 ${question.id} 题没有可用选项`)
    const index = Math.max(0, Math.min(question.options.length - 1, Math.floor(random() * question.options.length)))
    const option = question.options[index]
    if (!option) throw new Error(`第 ${question.id} 题随机选项无效`)
    return { id: question.id, value: option.value }
  })
}
function answerValue(questionId: number) {
  const key = String(questionId)
  return answerDraft.value[key] ?? current.value?.personality?.answers[key] ?? ''
}
function syncQueuedIds() { queuedQuestionIds.value = new Set(queuedAnswers.keys()) }
watch(() => props.activity, () => {
  // A newer read can update visible progress, but cannot erase an unknown-write lock.
  if (!unknownBlockedForCurrentAccount.value) error.value = ''
  savedMessage.value = ''
})
watch(() => props.accountId, () => {
  retaking.value = false
  answerDraft.value = {}
  queuedAnswers.clear()
  syncQueuedIds()
}, { flush: 'sync' })
async function operate(action: string, input: Record<string, unknown> = {}): Promise<boolean> {
  if (busy.value || !current.value || unknownBlockedForCurrentAccount.value) return false
  busy.value = true
  error.value = ''
  savedMessage.value = ''
  try {
    const result = await props.operate(action, input)
    if (!result.ok) {
      error.value = result.error || '活动操作结果未确认，暂不重复提交；刷新只读取当前活动状态'
      blockedUnknown.value = result.unknown === true
      if (blockedUnknown.value) {
        blockedUnknownAccount.value = String(props.accountId || '')
        queuedAnswers.clear()
        syncQueuedIds()
        emit('refresh')
      }
      return false
    }
    if (action === 'settle') retaking.value = false
    savedMessage.value = action === 'saveAnswers' ? '答案已保存' : action === 'settle' ? '人格结果已更新' : '活动状态已更新'
    emit('refresh')
    return true
  } catch (cause: any) {
    error.value = cause?.message || '活动操作结果未确认，暂不重复提交；刷新只读取当前活动状态'
    blockedUnknown.value = cause?.unknown === true
    if (blockedUnknown.value) {
      blockedUnknownAccount.value = String(props.accountId || '')
      queuedAnswers.clear()
      syncQueuedIds()
      emit('refresh')
    }
    return false
  } finally { busy.value = false }
}
async function drainAnswerQueue() {
  if (drainingAnswers.value || busy.value || unknownBlockedForCurrentAccount.value) return
  drainingAnswers.value = true
  try {
    while (queuedAnswers.size && !unknownBlockedForCurrentAccount.value && current.value?.active) {
      const [questionId, value] = queuedAnswers.entries().next().value as [number, number]
      queuedAnswers.delete(questionId)
      syncQueuedIds()
      savingQuestion.value = questionId
      const confirmed = await operate('saveAnswers', { answers: { [questionId]: value }, clear: false })
      if (!confirmed) {
        queuedAnswers.clear()
        syncQueuedIds()
        break
      }
    }
  } finally {
    savingQuestion.value = null
    drainingAnswers.value = false
    syncQueuedIds()
  }
}
async function startRetake() {
  if (answerQueueBusy.value) return
  if (await operate('saveAnswers', { answers: {}, clear: true })) {
    answerDraft.value = {}
    retaking.value = true
  }
}
async function randomAnswerAndSettle() {
  if (oneClickBusy.value || answerQueueBusy.value || busy.value || !current.value?.active || props.readOnly || unknownBlockedForCurrentAccount.value) return
  const owner = String(props.accountId || '')
  const activityId = String(current.value.activityId)
  let questions: Array<{ id: number, value: number }>
  try { questions = selectRandomAnswers(current.value.questions) }
  catch (cause: any) { error.value = cause?.message || '题目或选项未完整加载，无法一键答题'; return }
  if (!owner || !questions.length || questions.some(question => !Number.isSafeInteger(question.value))) {
    error.value = '题目或选项未完整加载，无法一键答题'
    return
  }
  oneClickBusy.value = true
  try {
    const result = await props.operate('saveAnswers', { answers: {}, clear: true })
    if (!result.ok) {
      error.value = result.error || '清空旧答案未确认，已停止一键答题'
      blockedUnknown.value = result.unknown === true
      if (blockedUnknown.value) blockedUnknownAccount.value = owner
      if (result.unknown) emit('refresh')
      return
    }
    retaking.value = true
    answerDraft.value = {}
    for (const question of questions) {
      if (String(props.accountId || '') !== owner || String(current.value?.activityId || '') !== activityId
        || !current.value?.active || unknownBlockedForCurrentAccount.value) return
      const saved = await props.operate('saveAnswers', { answers: { [question.id]: question.value }, clear: false })
      if (!saved.ok) {
        error.value = saved.error || `第 ${question.id} 题保存未确认，已停止后续答题`
        blockedUnknown.value = saved.unknown === true
        if (blockedUnknown.value) blockedUnknownAccount.value = owner
        queuedAnswers.clear()
        syncQueuedIds()
        emit('refresh')
        return
      }
      answerDraft.value = { ...answerDraft.value, [String(question.id)]: String(question.value) }
      savingQuestion.value = question.id
    }
    if (String(props.accountId || '') !== owner || String(current.value?.activityId || '') !== activityId
      || !current.value?.active || unknownBlockedForCurrentAccount.value) return
    if (await operate('settle')) savedMessage.value = '已随机完成全部题目并结算人格'
  } catch (cause: any) {
    error.value = cause?.message || '一键答题未完成；刷新可读取当前活动状态'
    if (cause?.unknown === true) {
      blockedUnknown.value = true
      blockedUnknownAccount.value = owner
      emit('refresh')
    }
  } finally {
    oneClickBusy.value = false
    savingQuestion.value = null
  }
}
function tierButton(action: string, tiers?: RanchMugeTier[]) {
  if (!answerQueueBusy.value && claimableCount(tiers) > 0) void operate(action)
}
function saveAnswer(questionId: number, value: number) {
  const key = String(questionId)
  const valueText = String(value)
  const saved = current.value?.personality?.answers[key] || ''
  const inFlightSameAnswer = savingQuestion.value === questionId && answerDraft.value[key] === valueText
  if ((saved === valueText || inFlightSameAnswer) && !queuedAnswers.has(questionId)) return
  answerDraft.value = { ...answerDraft.value, [key]: String(value) }
  queuedAnswers.set(questionId, value)
  syncQueuedIds()
  void drainAnswerQueue()
}
</script>

<template>
  <section class="muge-panel space-y-4">
    <header class="ui-card flex flex-wrap items-center justify-between gap-3 rounded-lg p-4">
      <div class="flex items-center gap-3"><img src="/activity/muge/icon.png" alt="" width="38" height="38" class="h-[38px] w-[38px] object-contain"><div><h3 class="font-semibold">牧歌初启 · 活动进度</h3><p class="muge-muted mt-1 text-xs">{{ current ? `${displayTime(current.startTime)} – ${displayTime(current.endTime)}` : '正在等待活动数据' }}</p></div></div>
      <span v-if="current" class="muge-badge" :class="current.active ? 'is-active' : ''">{{ current.active ? '活动进行中' : '暂不可操作' }}</span>
    </header>
    <p v-if="error" class="muge-error" role="alert">{{ error }}</p>
    <p v-else-if="savedMessage" class="muge-success" role="status">{{ savedMessage }}</p>
    <section class="ui-subtle-panel rounded-lg p-3 text-xs" aria-label="活动领取状态">
      <p v-if="readOnly" class="muge-warning" role="status">领取按钮暂不可用：{{ readOnlyReason || '牧场操作状态未确认' }}。系统不会自动重发操作；刷新只读取当前活动状态。</p>
      <p v-else-if="current && !current.active" class="muge-warning" role="status">活动当前不在可操作时间，领奖按钮已暂停。请刷新活动状态确认是否已结束。</p>
      <p v-else-if="busy" class="muge-muted" role="status">活动操作正在等待服务端确认…</p>
      <p v-else class="muge-muted">自动领取：{{ automaticClaimEnabled === null || automaticClaimEnabled === undefined ? '设置状态未读取' : automaticClaimEnabled ? `已开启${automaticClaimSummary ? ` · ${automaticClaimSummary}` : ''}` : '未开启' }}。具体奖励是否到账以各档状态显示“已领取”为准。</p>
    </section>
    <nav class="relative z-10 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="牧歌初启活动分区">
      <button v-for="section in sections" :key="section.key" type="button" class="muge-tab" :class="{ 'is-active': tab === section.key }" :aria-pressed="tab === section.key" @click.stop="tab = section.key">{{ section.label }}</button>
    </nav>
    <p v-if="!current" class="ui-empty-state">暂未读取到活动数据，请刷新活动专区。</p>
    <template v-else>
      <section v-if="tab === 'celebration'" class="space-y-3">
        <div v-if="current.celebration" class="ui-card rounded-lg p-4">
          <div class="flex flex-wrap items-center justify-between gap-3"><div><p class="muge-muted text-xs">全服累计饲养</p><strong class="text-xl">{{ formatAmount(current.celebration.total) }} 只</strong></div><BaseButton size="sm" :disabled="readOnly || busy || answerQueueBusy || !current.active || !claimableCount(current.celebration.tiers)" :loading="busy" @click="tierButton('claimCelebration', current.celebration.tiers)">{{ claimableCount(current.celebration.tiers) ? `领取 ${claimableCount(current.celebration.tiers)} 档奖励` : '暂无可领取奖励' }}</BaseButton></div>
        </div>
        <div v-if="current.celebration?.tiers.length" class="grid gap-2 sm:grid-cols-2">
          <article v-for="tier in current.celebration.tiers" :key="tier.id" class="ui-subtle-panel rounded-lg p-3"><div class="flex items-center justify-between gap-2"><strong>{{ formatAmount(tier.threshold) }} 只</strong><span class="muge-status" :class="`status-${tier.status}`">{{ statusText(tier.status) }}</span></div><p class="muge-muted mt-2 text-xs">奖励：{{ tier.rewards.map(item => `${item.name} ×${formatAmount(item.count)}`).join('、') || '未返回奖励' }}</p></article>
        </div>
        <p v-if="!current.celebration" class="ui-empty-state">庆典进度数据未返回。</p>
      </section>

      <section v-else-if="tab === 'friends'" class="space-y-3">
        <div v-if="current.friends" class="ui-card rounded-lg p-4"><div class="flex flex-wrap items-center justify-between gap-3"><div><p class="muge-muted text-xs">已开启牧场的好友</p><strong class="text-xl">{{ current.friends.count }} 位</strong></div><BaseButton size="sm" :disabled="readOnly || busy || answerQueueBusy || !current.active || !claimableCount(current.friends.tiers)" :loading="busy" @click="tierButton('claimFriends', current.friends.tiers)">{{ claimableCount(current.friends.tiers) ? `领取 ${claimableCount(current.friends.tiers)} 档奖励` : '暂无可领取奖励' }}</BaseButton></div></div>
        <div v-if="current.friends?.tiers.length" class="grid gap-2 sm:grid-cols-2"><article v-for="tier in current.friends.tiers" :key="tier.id" class="ui-subtle-panel rounded-lg p-3"><div class="flex items-center justify-between"><strong>{{ Number(tier.threshold).toLocaleString('zh-CN') }} 位好友</strong><span class="muge-status" :class="`status-${tier.status}`">{{ statusText(tier.status) }}</span></div><p class="muge-muted mt-2 text-xs">奖励：{{ tier.rewards.map(item => `${item.name} ×${formatAmount(item.count)}`).join('、') || '未返回奖励' }}</p></article></div>
        <p v-if="!current.friends" class="ui-empty-state">牧友同行进度数据未返回。</p>
      </section>

      <section v-else-if="tab === 'handbook'" class="space-y-3">
        <template v-if="current.handbook">
          <div class="ui-card flex flex-wrap items-center justify-between gap-3 rounded-lg p-4"><div><p class="muge-muted text-xs">成长积分</p><strong class="text-xl tabular-nums">{{ formatAmount(current.handbook.points) }}</strong></div><div class="flex flex-wrap gap-2"><BaseButton size="sm" :disabled="readOnly || busy || answerQueueBusy || !current.active || !current.handbook.tasks.some(task => task.status === 2)" :loading="busy" @click="operate('claimTask')">领取任务奖励</BaseButton><BaseButton size="sm" :disabled="readOnly || busy || answerQueueBusy || !current.active || !claimableCount(current.handbook.tiers)" :loading="busy" @click="operate('claimHandbook')">领取积分奖励</BaseButton></div></div>
          <div v-if="current.handbook.tiers.length" class="grid gap-2 sm:grid-cols-2"><article v-for="tier in current.handbook.tiers" :key="tier.id" class="ui-subtle-panel rounded-lg p-3"><div class="flex items-center justify-between"><strong>{{ formatAmount(tier.threshold) }} 积分</strong><span class="muge-status" :class="`status-${tier.status}`">{{ statusText(tier.status) }}</span></div><p class="muge-muted mt-2 text-xs">{{ tier.rewards.map(item => `${item.name} ×${formatAmount(item.count)}`).join('、') }}</p></article></div>
          <article v-for="task in current.handbook.tasks" :key="task.id" class="ui-card rounded-lg p-3"><div class="flex flex-wrap items-start justify-between gap-2"><div><strong class="text-sm">{{ task.description || `任务 ${task.id}` }}</strong><p class="muge-muted mt-1 text-xs">第 {{ formatAmount(task.unlockDay) }} 天 · {{ formatAmount(task.progress) }} / {{ formatAmount(task.target) }} · {{ formatAmount(task.points) }} 积分</p><p class="muge-muted mt-1 text-xs">{{ task.rewards.map(item => `${item.name} ×${formatAmount(item.count)}`).join('、') || '无奖励明细' }}</p></div><span class="muge-status" :class="`status-${task.status}`">{{ statusText(task.status) }}</span></div><div class="muge-track mt-3"><i :style="{ width: `${percentage(task.progress, task.target)}%` }" /></div></article>
        </template>
        <p v-else class="ui-empty-state">成长手册进度数据未返回。</p>
      </section>

      <section v-else class="space-y-3">
        <template v-if="current.personality">
          <div class="ui-card flex flex-wrap items-center gap-4 rounded-lg p-4"><button v-if="current.personality.personalityId !== '0' && current.personality.image" type="button" class="muge-personality-preview rounded-lg" :aria-label="`放大查看牧场人格 ${current.personality.personalityId}`" @click="imagePreviewOpen = true"><img :src="current.personality.image" :alt="`牧场人格 ${current.personality.personalityId}`" class="max-h-44 max-w-36 rounded-lg object-contain"><span class="muge-preview-hint">点击放大</span></button><div class="min-w-0 flex-1"><strong>{{ current.personality.personalityId !== '0' ? `牧场人格 #${current.personality.personalityId}` : '牧场人格测试' }}</strong><p class="muge-muted mt-1 text-xs">已保存 {{ Object.keys(current.personality.answers).length }} / {{ current.questions.length }} 题 · 已测试 {{ current.personality.settleCount }} 次</p></div><div class="flex flex-wrap gap-2"><BaseButton v-if="current.personality.personalityId !== '0'" size="sm" :disabled="readOnly || busy || oneClickBusy || answerQueueBusy || !current.active" :loading="busy && !oneClickBusy" @click="startRetake">重新测试</BaseButton><BaseButton v-if="current.personality.personalityId !== '0' && !current.personality.shareRewardClaimed" size="sm" :disabled="readOnly || busy || oneClickBusy || answerQueueBusy || !current.active" :loading="busy && !oneClickBusy" @click="operate('claimShare')">领取首次分享奖励</BaseButton><BaseButton size="sm" variant="secondary" :disabled="readOnly || busy || oneClickBusy || answerQueueBusy || !current.active || !current.questions.length" :loading="oneClickBusy" @click="randomAnswerAndSettle">随机答题并结算</BaseButton></div><p class="muge-muted mt-3 basis-full text-xs">将逐题随机选项、依次保存并自动结算；不同账号的答案不保证对应不同人格结果。</p></div>
          <article v-for="question in current.questions" :key="question.id" class="ui-card space-y-3 rounded-lg p-4"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-sm">{{ question.id }}. {{ question.title }}</strong><span class="muge-muted text-xs">{{ savingQuestion === question.id ? '保存中…' : queuedQuestionIds.has(question.id) ? '等待保存…' : answerValue(question.id) ? current.personality.answers[String(question.id)] === answerValue(question.id) ? '已保存' : '已选择' : '未作答' }}</span></div><div class="grid gap-2 sm:grid-cols-2"><button v-for="option in question.options" :key="option.value" type="button" class="muge-option" :class="{ 'is-selected': answerValue(question.id) === String(option.value) }" :disabled="readOnly || !current.active || busy && !drainingAnswers || current.personality.personalityId !== '0' && !retaking" @click="saveAnswer(question.id, option.value)"><b>{{ option.label }}</b><span>{{ option.text }}</span></button></div></article>
          <div class="flex justify-end"><BaseButton variant="primary" :disabled="readOnly || busy || answerQueueBusy || !current?.active || current?.personality?.personalityId !== '0' && !retaking || current?.questions?.some(q => !answerValue(q.id))" :loading="busy" @click="operate('settle')">结算人格结果</BaseButton></div>
        </template>
        <p v-else class="ui-empty-state">牧场人格进度数据未返回。</p>
      </section>
    </template>
    <div v-if="imagePreviewOpen && current?.personality?.image" class="muge-preview-backdrop" role="presentation" @click.self="imagePreviewOpen = false">
      <section class="muge-preview-dialog" role="dialog" aria-modal="true" :aria-label="`牧场人格 ${current.personality.personalityId} 图片预览`">
        <button type="button" class="muge-preview-close" aria-label="关闭图片预览" @click="imagePreviewOpen = false">关闭</button>
        <img :src="current.personality.image" :alt="`牧场人格 ${current.personality.personalityId}`" class="muge-preview-image">
      </section>
    </div>
  </section>
</template>

<style scoped>
.muge-panel { color: var(--theme-text); }
.muge-personality-preview { position:relative; display:flex; min-height:176px; min-width:144px; align-items:center; justify-content:center; border:1px solid var(--surface-border); background:var(--surface-2); cursor:zoom-in; }
.muge-personality-preview:focus-visible,.muge-preview-close:focus-visible { outline:2px solid var(--focus-ring); outline-offset:3px; }
.muge-preview-hint { position:absolute; inset:auto 0 0; padding:4px 6px; color:var(--theme-text); background:color-mix(in srgb,var(--surface-1) 88%,transparent); font-size:11px; text-align:center; }
.muge-preview-backdrop { position:fixed; inset:0; z-index:80; display:flex; align-items:center; justify-content:center; padding:20px; background:rgb(0 0 0 / 72%); }
.muge-preview-dialog { position:relative; display:flex; max-width:min(92vw,760px); max-height:90vh; align-items:center; justify-content:center; border:1px solid var(--surface-border); border-radius:var(--radius-panel); background:var(--surface-1); padding:16px; box-shadow:var(--surface-shadow-card); }
.muge-preview-image { display:block; max-width:calc(92vw - 32px); max-height:calc(90vh - 32px); object-fit:contain; }
.muge-preview-close { position:absolute; z-index:1; top:8px; right:8px; border:1px solid var(--surface-border); border-radius:var(--radius-control); background:var(--surface-1); color:var(--theme-text); padding:6px 10px; cursor:pointer; }
.muge-muted { color: var(--muted-text); }
.muge-badge,.muge-status { display:inline-flex; border-radius:999px; background:var(--surface-2); color:var(--muted-text); padding:3px 9px; font-size:11px; }
.muge-badge.is-active,.muge-status.status-2 { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 12%,transparent); }
.muge-status.status-3 { color:var(--muted-text); }
.muge-status.status-4 { color:var(--status-warning); }
.muge-tab { position:relative; z-index:1; min-height:38px; border:1px solid var(--surface-border); border-radius:var(--radius-control); color:var(--muted-text); background:var(--surface-2); padding:7px 10px; font-size:12px; cursor:pointer; pointer-events:auto; }
.muge-tab.is-active { color:var(--theme-primary); border-color:var(--theme-primary); background:color-mix(in srgb,var(--theme-primary) 10%,var(--surface-1)); }
.muge-track { height:5px; border-radius:999px; background:var(--surface-border); overflow:hidden; }
.muge-track i { display:block; height:100%; border-radius:inherit; background:var(--theme-primary); }
.muge-option { display:flex; align-items:flex-start; gap:8px; border:1px solid var(--surface-border); border-radius:8px; background:var(--surface-2); color:var(--theme-text); padding:9px; text-align:left; font-size:12px; }
.muge-option b { color:var(--theme-primary); }
.muge-option.is-selected { border-color:var(--theme-primary); background:color-mix(in srgb,var(--theme-primary) 10%,var(--surface-1)); }
.muge-warning { border-radius:8px; background:color-mix(in srgb,var(--status-warning) 10%,transparent); color:var(--status-warning); padding:9px 12px; line-height:1.6; }
.muge-error { border-radius:8px; background:color-mix(in srgb,var(--status-warning) 10%,transparent); color:var(--status-warning); padding:9px 12px; font-size:12px; }
.muge-success { color:var(--status-success); padding:4px 2px; font-size:12px; }
</style>
