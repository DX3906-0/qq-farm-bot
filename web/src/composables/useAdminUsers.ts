import { computed, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

export interface UserInfo { username: string, role: string, accountLimit: number }
export interface EditForm { newUsername: string, password: string, accountLimit: number }

export function useAdminUsers() {
  const userStore = useUserStore()
  const toast = useToastStore()
  const showDeleteUserConfirm = ref(false)
  const pendingDeleteUser = ref<UserInfo | null>(null)
  const deleteUserLoading = ref(false)
  const showEditUserConfirm = ref(false)
  const users = ref<UserInfo[]>([])
  const usersLoading = ref(false)
  const userSearchQuery = ref('')
  const showEditModal = ref(false)
  const selectedUser = ref<UserInfo | null>(null)
  const editForm = ref<EditForm>({ newUsername: '', password: '', accountLimit: 2 })
  const editLoading = ref(false)
  const currentUsername = computed(() => userStore.username)
  const adminUsersCount = computed(() => users.value.filter(user => user.role === 'admin' || user.role === 'super_admin').length)
  const filteredUsers = computed(() => {
    const query = userSearchQuery.value.trim().toLowerCase()
    return query ? users.value.filter(user => user.username.toLowerCase().includes(query)) : users.value
  })
  const userManagementSummary = computed(() => `${users.value.length} 个账号；普通登录与账号权限由管理员在此管理。`)

  async function fetchUsers() {
    usersLoading.value = true
    try {
      const result = await userStore.getAllUsers()
      if (result.ok) users.value = result.data
      else toast.error(result.error || '获取用户列表失败')
    } catch (error: any) { toast.error(error.message || '获取用户列表失败') }
    finally { usersLoading.value = false }
  }
  function requestDeleteUser(user: UserInfo) { pendingDeleteUser.value = user; showDeleteUserConfirm.value = true }
  async function confirmDeleteUser() {
    if (!pendingDeleteUser.value) return
    deleteUserLoading.value = true
    try {
      const result = await userStore.deleteUser(pendingDeleteUser.value.username, { confirmed: true })
      if (result.ok) { toast.success('用户删除成功'); showDeleteUserConfirm.value = false; pendingDeleteUser.value = null; await fetchUsers() }
      else toast.error(result.error || '删除用户失败')
    } catch (error: any) { toast.error(error.message || '删除用户失败') }
    finally { deleteUserLoading.value = false }
  }
  function openEditModal(user: UserInfo) {
    selectedUser.value = user
    editForm.value = { newUsername: user.username, password: '', accountLimit: user.accountLimit || 2 }
    showEditModal.value = true
  }
  function handleEdit() { if (selectedUser.value) showEditUserConfirm.value = true }
  async function confirmEditUser() {
    if (!selectedUser.value) return
    editLoading.value = true
    try {
      const payload: Record<string, unknown> = { accountLimit: editForm.value.accountLimit, confirmed: true }
      if (editForm.value.newUsername && editForm.value.newUsername !== selectedUser.value.username) payload.newUsername = editForm.value.newUsername
      if (editForm.value.password) payload.password = editForm.value.password
      const res = await api.post(`/api/admin/users/${encodeURIComponent(selectedUser.value.username)}/edit`, payload)
      if (res.data.ok) { toast.success('用户信息已更新'); showEditUserConfirm.value = false; showEditModal.value = false; await fetchUsers() }
      else toast.error(res.data.error || '更新失败')
    } catch (error: any) { toast.error(error?.response?.data?.error || error?.message || '更新失败') }
    finally { editLoading.value = false }
  }
  return {
    showDeleteUserConfirm, pendingDeleteUser, deleteUserLoading, showEditUserConfirm,
    users, usersLoading, userSearchQuery, filteredUsers, showEditModal, selectedUser, editForm, editLoading,
    currentUsername, adminUsersCount, userManagementSummary, fetchUsers, requestDeleteUser, confirmDeleteUser,
    openEditModal, handleEdit, confirmEditUser,
  }
}
