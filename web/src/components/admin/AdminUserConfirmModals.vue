<script setup lang="ts">
import type { UserInfo } from '@/composables/useAdminUsers'
import ConfirmModal from '@/components/ConfirmModal.vue'
const props = defineProps<{ deleteUserLoading: boolean, editForm: { newUsername: string, password: string, accountLimit: number }, editLoading: boolean }>()
const emit = defineEmits<{ deleteUser: [], editUser: [] }>()
const showDeleteUserConfirm = defineModel<boolean>('showDeleteUserConfirm', { required: true })
const pendingDeleteUser = defineModel<UserInfo | null>('pendingDeleteUser', { required: true })
const showEditUserConfirm = defineModel<boolean>('showEditUserConfirm', { required: true })
const selectedUser = defineModel<UserInfo | null>('selectedUser', { required: true })
</script>
<template>
  <ConfirmModal :show="showDeleteUserConfirm" title="确认删除用户" :message="`确定删除用户 ${pendingDeleteUser?.username || ''} 吗？此操作会使其登录失效。`" type="danger" :loading="deleteUserLoading" confirm-text="删除" @confirm="emit('deleteUser')" @close="!deleteUserLoading && (showDeleteUserConfirm = false)" @cancel="!deleteUserLoading && (showDeleteUserConfirm = false)" />
  <ConfirmModal :show="showEditUserConfirm" title="确认保存用户信息" :message="`确定保存用户 ${selectedUser?.username || ''} 的账号设置吗？`" type="primary" :loading="editLoading" confirm-text="保存" @confirm="emit('editUser')" @close="!editLoading && (showEditUserConfirm = false)" @cancel="!editLoading && (showEditUserConfirm = false)" />
</template>
