<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AdminAlertModal from '@/components/admin/AdminAlertModal.vue'
import AdminLoginLogConfirmModal from '@/components/admin/AdminLoginLogConfirmModal.vue'
import AdminLoginLogPanel from '@/components/admin/AdminLoginLogPanel.vue'
import AdminPanelHeader from '@/components/admin/AdminPanelHeader.vue'
import AdminPanelTabs from '@/components/admin/AdminPanelTabs.vue'
import AdminSystemConfigConfirmModals from '@/components/admin/AdminSystemConfigConfirmModals.vue'
import AdminSystemPanel from '@/components/admin/AdminSystemPanel.vue'
import AdminUserConfirmModals from '@/components/admin/AdminUserConfirmModals.vue'
import AdminUserPanel from '@/components/admin/AdminUserPanel.vue'
import { useAdminLoginLogs } from '@/composables/useAdminLoginLogs'
import { useAdminSystemConfig } from '@/composables/useAdminSystemConfig'
import { useAdminUsers } from '@/composables/useAdminUsers'
import { useToastStore } from '@/stores/toast'

const toast = useToastStore()
const tabs = [
  { key: 'user', label: '用户', icon: 'i-carbon-user-admin' },
  { key: 'log', label: '登录日志', icon: 'i-carbon-document' },
  { key: 'system', label: '系统', icon: 'i-carbon-settings' },
] as const
type Tab = typeof tabs[number]['key']
const saved = localStorage.getItem('admin-active-tab')
const activeTab = ref<Tab>(['user', 'log', 'system'].includes(saved || '') ? saved as Tab : 'user')
const modalVisible = ref(false)
const modalConfig = ref({ title: '', message: '', type: 'primary' as 'primary' | 'danger', isAlert: true })
function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = { title: type === 'danger' ? '错误' : '提示', message, type, isAlert: true }
  modalVisible.value = true
}
const userState = useAdminUsers()
const { users, showEditModal, editForm, userSearchQuery, filteredUsers, usersLoading, currentUsername, adminUsersCount, userManagementSummary, editLoading, showDeleteUserConfirm, pendingDeleteUser, deleteUserLoading, showEditUserConfirm, selectedUser, fetchUsers, openEditModal, requestDeleteUser, handleEdit, confirmDeleteUser, confirmEditUser } = userState
const logState = useAdminLoginLogs()
const { loginLogs, loginLogsLoading, loginLogsTotal, loginSuccessCount, loginFailedCount, loginLogSummary, clearLogsLoading, fetchLoginLogs } = logState
const systemState = useAdminSystemConfig({ showAlert })
const { localSystemConfig, localWxConfig, localCaptureConfig, localLoginLinks, defaultSystemConfig, platformOptions, osOptions, systemConfigSaving, wxConfigSaving, captureConfigSaving, captureConfigTesting, loginLinksSaving, loginLogoUploading, showResetSystemConfirm, showSaveSystemConfirm, showResetLoginLinksConfirm, showResetWxConfigConfirm, showSaveWxConfigConfirm, openResetSystemConfirm, openSaveSystemConfirm, openResetLoginLinksConfirm, openResetWxConfigConfirm, openSaveWxConfigConfirm, handleTestCaptureConfig, handleSaveCaptureConfig, handleSaveLoginLinks, handleUploadLoginLogo, handleResetLoginLinks, handleResetSystemConfig, handleSaveSystemConfig, handleResetWxConfig, handleSaveWxConfig } = systemState
const showClearLogsConfirm = ref(false)
function openClearLogsConfirm() {
  if (!logState.loginLogsTotal.value) { toast.warning('暂无日志可清空'); return }
  showClearLogsConfirm.value = true
}
async function confirmClearLogs() {
  if (await logState.clearLoginLogs()) showClearLogsConfirm.value = false
}
onMounted(() => {
  localStorage.setItem('admin-active-tab', activeTab.value)
  userState.fetchUsers()
  logState.fetchLoginLogs()
  systemState.loadSystemConfig()
  systemState.loadWxConfig()
  systemState.loadCaptureConfig()
  systemState.loadLoginLinks()
})
</script>

<template>
  <div class="admin-panel">
    <AdminPanelHeader :total-users="users.length" :login-logs-total="loginLogsTotal" />
    <AdminPanelTabs v-model:active-tab="activeTab" :tabs="tabs">
      <AdminUserPanel
        v-if="activeTab === 'user'"
        v-model:show-edit-modal="showEditModal"
        v-model:edit-form="editForm"
        v-model:user-search-query="userSearchQuery"
        :users="users"
        :filtered-users="filteredUsers"
        :users-loading="usersLoading"
        :current-username="currentUsername"
        :admin-users-count="adminUsersCount"
        :user-management-summary="userManagementSummary"
        :edit-loading="editLoading"
        @refresh="fetchUsers"
        @open-edit-user="openEditModal"
        @delete-user="requestDeleteUser"
        @edit-user="handleEdit"
      />
      <AdminLoginLogPanel
        v-else-if="activeTab === 'log'"
        :logs="loginLogs"
        :loading="loginLogsLoading"
        :total="loginLogsTotal"
        :success-count="loginSuccessCount"
        :failed-count="loginFailedCount"
        :summary="loginLogSummary"
        @refresh="fetchLoginLogs"
        @clear="openClearLogsConfirm"
      />
      <AdminSystemPanel
        v-else
        v-model:local-system-config="localSystemConfig"
        v-model:local-wx-config="localWxConfig"
        v-model:local-capture-config="localCaptureConfig"
        v-model:local-login-links="localLoginLinks"
        :default-system-config="defaultSystemConfig"
        :platform-options="platformOptions"
        :os-options="osOptions"
        :system-config-saving="systemConfigSaving"
        :wx-config-saving="wxConfigSaving"
        :capture-config-saving="captureConfigSaving"
        :capture-config-testing="captureConfigTesting"
        :login-links-saving="loginLinksSaving"
        :login-logo-uploading="loginLogoUploading"
        @reset-system="openResetSystemConfirm"
        @save-system="openSaveSystemConfirm"
        @reset-login-links="openResetLoginLinksConfirm"
        @reset-wx="openResetWxConfigConfirm"
        @save-wx="openSaveWxConfigConfirm"
        @test-capture="handleTestCaptureConfig"
        @save-capture="handleSaveCaptureConfig"
        @save-login-links="handleSaveLoginLinks"
        @upload-login-logo="handleUploadLoginLogo"
      />
    </AdminPanelTabs>
    <AdminLoginLogConfirmModal v-model:show="showClearLogsConfirm" :total="loginLogsTotal" :loading="clearLogsLoading" @clear="confirmClearLogs" />
    <AdminUserConfirmModals
      v-model:show-delete-user-confirm="showDeleteUserConfirm"
      v-model:pending-delete-user="pendingDeleteUser"
      v-model:show-edit-user-confirm="showEditUserConfirm"
      v-model:selected-user="selectedUser"
      :delete-user-loading="deleteUserLoading"
      :edit-form="editForm"
      :edit-loading="editLoading"
      @delete-user="confirmDeleteUser"
      @edit-user="confirmEditUser"
    />
    <AdminSystemConfigConfirmModals
      v-model:show-reset-system-confirm="showResetSystemConfirm"
      v-model:show-save-system-confirm="showSaveSystemConfirm"
      v-model:show-reset-login-links-confirm="showResetLoginLinksConfirm"
      v-model:show-reset-wx-config-confirm="showResetWxConfigConfirm"
      v-model:show-save-wx-config-confirm="showSaveWxConfigConfirm"
      :system-config-saving="systemConfigSaving"
      :wx-config-saving="wxConfigSaving"
      :login-links-saving="loginLinksSaving"
      @reset-login-links="handleResetLoginLinks"
      @reset-system="handleResetSystemConfig"
      @save-system="handleSaveSystemConfig"
      @reset-wx="handleResetWxConfig"
      @save-wx="handleSaveWxConfig"
    />
    <AdminAlertModal v-model:show="modalVisible" :config="modalConfig" />
  </div>
</template>
