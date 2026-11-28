<script setup lang="ts">
import { ref } from 'vue'
import AccountModal from '@/components/AccountModal.vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { getPlatformClass, getPlatformLabel } from '@/stores/account'
import { deriveAccountPresentation } from '@/utils/operation-result'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
import { vFoldMotion } from '@/composables/useContentMotion'

const props = defineProps<{
  accounts: any[]
  accountsLoading: boolean
  currentAccountId: string | number | null | undefined
  userIsAdmin: boolean
  stoppedAccountsCount: number
  isAddAccountDisabled: boolean
  addAccountDisabledReason: string
  isAccountOpsDisabled: boolean
  showModal: boolean
  editingAccount: any
  showDeleteConfirm: boolean
  deleteLoading: boolean
  accountToDelete: any
  showClearStoppedConfirm: boolean
  clearStoppedLoading: boolean
  refreshWxCodesLoading: boolean
  defaultPlanApplyingId: string
  defaultPlanUnknown?: Record<string, string>
  accountReadError?: string
  accountTogglePending?: Record<string, boolean>
  accountToggleUnknown?: Record<string, string>
  statusSnapshot?: any
  statusReady?: boolean
  statusStale?: boolean
}>()
const emit = defineEmits<{
  add: [], clearStopped: [], refreshWxCodes: [], select: [account: any], toggle: [account: any], settings: [account: any],
  applyDefaultPlan: [account: any], edit: [account: any], delete: [account: any], saved: [], closeModal: [],
  closeDeleteConfirm: [], confirmDelete: [], closeClearStoppedConfirm: [], confirmClearStopped: [],
}>()
const failedAvatars = ref(new Set<string>())
const planAccount = ref<any>(null)
function accountAvatar(account: any) {
  if (LOCAL_UI_READONLY || failedAvatars.value.has(String(account.id))) return ''
  const direct = String(account?.avatar || account?.avatarUrl || account?.avatar_url || '').trim()
  if (direct) return direct
  const qq = String(account?.uin || account?.qq || '').trim()
  return /^\d+$/.test(qq) ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100` : ''
}
function avatarFailed(account: any) { failedAvatars.value = new Set([...failedAvatars.value, String(account.id)]) }
function presentation(account: any) {
  const current = String(props.currentAccountId || '') === String(account.id)
  return deriveAccountPresentation({ accountId: String(account.id), account,
    snapshot: current ? props.statusSnapshot : null, snapshotReady: current && props.statusReady,
    stale: current && props.statusStale })
}
function operationDisabled(account: any) {
  if (LOCAL_UI_READONLY) return '本地只读浏览，不能启停账号。'
  if (props.accountReadError) return '账号列表尚未加载完整，请先重新读取再操作。'
  if (account.running !== true && account.running !== false) return '进程状态尚未确认，不能据此启停。'
  if (props.accountToggleUnknown?.[String(account.id)]) return props.accountToggleUnknown[String(account.id)]!
  if (props.accountTogglePending?.[String(account.id)]) return '请求处理中，请等待结果。'
  if (!account.running && props.isAccountOpsDisabled) return '账号已到期，不能启动。'
  return ''
}
function applyPlan() {
  const account = planAccount.value
  if (!account || LOCAL_UI_READONLY || props.defaultPlanApplyingId) return
  planAccount.value = null
  emit('applyDefaultPlan', account)
}
</script>

<template>
  <section class="account-settings">
    <header class="account-settings-heading">
      <div><h2>账号管理</h2><p>选择账号只切换查看对象；启停、编辑和删除分别操作。</p></div>
      <BaseButton variant="primary" size="sm" :disabled="isAddAccountDisabled" :title="addAccountDisabledReason" @click="emit('add')"><span class="i-carbon-add" aria-hidden="true" />添加账号</BaseButton>
    </header>
    <p v-if="isAddAccountDisabled && addAccountDisabledReason" class="account-settings-note">{{ addAccountDisabledReason }}</p>
    <p v-if="accountReadError" class="ui-notice" role="status">账号列表读取失败：{{ accountReadError }}{{ accounts.length ? '；保留上次列表供查看。' : '；尚未确认是否有账号。' }}</p>
    <div v-if="accountsLoading && !accounts.length" class="ui-empty-state" role="status"><span class="i-svg-spinners-ring-resize" aria-hidden="true" /><p>正在读取账号列表</p></div>
    <div v-else-if="!accounts.length" class="ui-empty-state">
      <span class="i-carbon-user-avatar" aria-hidden="true" />
      <p>{{ LOCAL_UI_READONLY ? '本地浏览 · 无账号' : accountReadError ? '账号列表尚未确认' : '暂无账号' }}</p>
      <p>{{ LOCAL_UI_READONLY ? '可以查看界面，但不会读取、添加或登录任何账号。' : '添加账号后再选择查看；不会自动启动。' }}</p>
      <BaseButton v-if="!isAddAccountDisabled && !accountReadError" variant="outline" @click="emit('add')">添加账号</BaseButton>
    </div>
    <div v-else class="account-card-grid">
      <article v-for="account in accounts" :key="account.id" class="ui-card account-card" :data-selected="String(currentAccountId) === String(account.id)">
        <button type="button" class="account-select" :aria-pressed="String(currentAccountId) === String(account.id)" :aria-label="`选择查看账号 ${account.name || account.nick || account.id}`" @click.stop="emit('select', account)">
          <span class="account-portrait"><img v-if="accountAvatar(account)" :src="accountAvatar(account)" alt="" @error="avatarFailed(account)"><span v-else class="i-carbon-user" aria-hidden="true" /></span>
          <span class="account-identity"><strong>{{ account.name || account.nick || account.id }}</strong><span class="account-subtitle"><span v-if="account.platform" class="account-platform" :class="getPlatformClass(account.platform)">{{ getPlatformLabel(account.platform) }}</span>{{ account.uin || account.wxid || '未绑定' }}</span></span>
          <span v-if="String(currentAccountId) === String(account.id)" class="i-carbon-checkmark account-selected-icon" aria-hidden="true" />
        </button>
        <div class="account-status" :data-tone="presentation(account).tone"><span class="account-status-dot" aria-hidden="true" /><span>{{ presentation(account).label }}</span><span v-if="account.running === true" class="account-process-label">进程运行中</span></div>
        <p class="account-card-caption">{{ presentation(account).detail }}</p>
        <div class="account-main-actions">
          <BaseButton variant="outline" size="sm" @click.stop="emit('settings', account)"><span class="i-carbon-settings" aria-hidden="true" />查看配置</BaseButton>
          <BaseButton :variant="account.running ? 'outline' : 'primary'" size="sm" :loading="!!accountTogglePending?.[String(account.id)]" :disabled="!!operationDisabled(account)" @click.stop="emit('toggle', account)"><span :class="account.running ? 'i-carbon-stop-filled' : 'i-carbon-play-filled'" aria-hidden="true" />{{ account.running ? '停止' : '启动' }}</BaseButton>
        </div>
        <p v-if="operationDisabled(account)" class="account-settings-note" role="status">{{ operationDisabled(account) }}</p>
        <p v-if="defaultPlanUnknown?.[String(account.id)]" class="account-settings-note" role="status">{{ defaultPlanUnknown[String(account.id)] }}</p>
        <details v-fold-motion class="account-more-actions">
          <summary>更多操作</summary>
          <div class="account-secondary-actions">
            <BaseButton variant="ghost" size="sm" :disabled="LOCAL_UI_READONLY || !!accountTogglePending?.[String(account.id)] || !!accountToggleUnknown?.[String(account.id)]" @click.stop="emit('edit', account)">编辑资料</BaseButton>
            <BaseButton variant="outline" size="sm" :data-testid="`apply-default-plan-${account.id}`" :loading="defaultPlanApplyingId === String(account.id)" :disabled="!!defaultPlanApplyingId || LOCAL_UI_READONLY || !!defaultPlanUnknown?.[String(account.id)] || !!accountTogglePending?.[String(account.id)] || !!accountToggleUnknown?.[String(account.id)]" @click.stop="planAccount = account">应用默认方案</BaseButton>
            <BaseButton variant="danger" size="sm" :disabled="deleteLoading || !!accountTogglePending?.[String(account.id)] || !!accountToggleUnknown?.[String(account.id)] || LOCAL_UI_READONLY" @click.stop="emit('delete', account)">删除账号</BaseButton>
          </div>
        </details>
      </article>
    </div>
    <details v-if="accounts.length" v-fold-motion class="account-maintenance ui-subtle-panel">
      <summary>账号维护</summary>
      <p class="account-settings-note">这些操作会改变账号状态或记录，不是普通刷新。</p>
      <div class="account-secondary-actions">
        <BaseButton variant="outline" size="sm" :loading="refreshWxCodesLoading" :disabled="accountsLoading || LOCAL_UI_READONLY" @click="emit('refreshWxCodes')">{{ userIsAdmin ? '刷新全部微信 Code' : '刷新我的微信 Code' }}</BaseButton>
        <BaseButton v-if="userIsAdmin" variant="danger" size="sm" :disabled="stoppedAccountsCount === 0 || LOCAL_UI_READONLY" @click="emit('clearStopped')">清理已停止账号（{{ stoppedAccountsCount }}）</BaseButton>
      </div>
    </details>
    <AccountModal :show="showModal" :edit-data="editingAccount" @close="emit('closeModal')" @saved="emit('saved')" />
    <ConfirmModal :show="!!planAccount" type="danger" title="应用默认方案" :message="`将用默认方案覆盖 ${planAccount?.name || planAccount?.id || ''} 的现有策略和自动控制；这不是只读操作。`" confirm-text="确认应用" @confirm="applyPlan" @cancel="planAccount = null" @close="planAccount = null" />
    <ConfirmModal :show="showDeleteConfirm" :loading="deleteLoading" title="删除账号" :message="accountToDelete ? `确定删除 ${accountToDelete.name || accountToDelete.id}？删除记录不可恢复，停止账号不需要删除。` : ''" confirm-text="删除" type="danger" @close="!deleteLoading && emit('closeDeleteConfirm')" @cancel="!deleteLoading && emit('closeDeleteConfirm')" @confirm="emit('confirmDelete')" />
    <ConfirmModal :show="showClearStoppedConfirm" :loading="clearStoppedLoading" title="清理已停止账号" :message="`将删除 ${stoppedAccountsCount} 个已停止账号的记录，不可恢复。保留停止记录无需清理。`" confirm-text="确认删除记录" type="danger" @close="!clearStoppedLoading && emit('closeClearStoppedConfirm')" @cancel="!clearStoppedLoading && emit('closeClearStoppedConfirm')" @confirm="emit('confirmClearStopped')" />
  </section>
</template>

<style scoped>
.account-settings { display: flex; min-width: 0; flex-direction: column; gap: 16px; }
.account-settings-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.account-settings-heading h2 { margin: 0; color: var(--theme-text); font-size: 18px; font-weight: 600; }
.account-settings-heading p, .account-card-caption, .account-settings-note { margin: 6px 0 0; color: var(--muted-text); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.account-card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.account-card { display: flex; min-width: 0; flex-direction: column; padding: 16px; }
.account-card[data-selected='true'] { border-color: var(--theme-primary); box-shadow: inset 0 0 0 1px var(--theme-primary); }
.account-select { display: flex; width: 100%; min-width: 0; align-items: center; gap: 12px; border: 0; border-radius: var(--radius-control); padding: 4px; background: transparent; color: var(--theme-text); text-align: left; cursor: pointer; }
.account-select:focus-visible { outline: 2px solid var(--theme-primary); outline-offset: 3px; }
.account-portrait { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; flex-shrink: 0; overflow: hidden; border-radius: 50%; background: var(--surface-2); color: var(--muted-text); font-size: 24px; }
.account-portrait img { width: 100%; height: 100%; object-fit: cover; }
.account-identity { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
.account-identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.account-subtitle { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted-text); font-size: 12px; }
.account-platform { padding: 1px 5px; border-radius: 4px; font-size: 11px; }
.account-selected-icon { color: var(--theme-primary); }
.account-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 14px; color: var(--muted-text); font-size: 12px; }
.account-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.account-status[data-tone='success'] { color: var(--status-success, #327047); }
.account-status[data-tone='warning'], .account-status[data-tone='error'] { color: var(--status-danger, #b4232c); }
.account-process-label { margin-left: auto; color: var(--muted-text); }
.account-main-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.account-main-actions > * { flex: 1; }
.account-more-actions { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--surface-border); }
.account-more-actions summary, .account-maintenance summary { min-height: 36px; color: var(--muted-text); font-size: 12px; cursor: pointer; }
.account-secondary-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.account-maintenance { padding: 12px 16px; border-radius: var(--radius-card); }
</style>
