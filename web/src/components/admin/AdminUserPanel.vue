<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'

interface UserInfo { username: string, role: string, accountLimit: number }
interface EditForm { newUsername: string, password: string, accountLimit: number }
defineProps<{ users: UserInfo[], filteredUsers: UserInfo[], usersLoading: boolean, currentUsername: string, adminUsersCount: number, userManagementSummary: string, editLoading: boolean }>()
defineEmits<{ refresh: [], openEditUser: [user: UserInfo], deleteUser: [user: UserInfo], editUser: [] }>()
const userSearchQuery = defineModel<string>('userSearchQuery', { required: true })
const showEditModal = defineModel<boolean>('showEditModal', { required: true })
const editForm = defineModel<EditForm>('editForm', { required: true })
</script>
<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between"><h3 class="text-lg font-bold">用户与账号管理</h3><BaseButton variant="primary" size="sm" @click="$emit('refresh')">刷新</BaseButton></div>
    <div class="grid gap-3 sm:grid-cols-3">
      <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm">用户总数<div class="mt-1 font-semibold">{{ users.length }} 人</div></div>
      <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm">管理员<div class="mt-1 font-semibold">{{ adminUsersCount }} 人</div></div>
      <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm">当前账号<div class="mt-1 font-semibold">{{ currentUsername || '未登录' }}</div></div>
    </div>
    <div class="rounded-2xl bg-gray-50 px-4 py-3 text-sm">{{ userManagementSummary }}</div>
    <div class="w-full sm:max-w-sm"><BaseInput v-model="userSearchQuery" label="搜索用户" type="search" placeholder="输入用户名" clearable /></div>
    <div v-if="usersLoading" class="py-8 text-center text-gray-500">加载中...</div>
    <div v-else class="overflow-x-auto border rounded-lg dark:border-gray-700">
      <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-700"><tr><th class="px-3 py-2 text-left text-xs">用户名</th><th class="px-3 py-2 text-left text-xs">角色</th><th class="px-3 py-2 text-left text-xs">账号额度</th><th class="px-3 py-2 text-right text-xs">操作</th></tr></thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr v-for="user in filteredUsers" :key="user.username"><td class="px-3 py-2 text-sm font-medium">{{ user.username }}</td><td class="px-3 py-2 text-sm">{{ user.role === 'admin' || user.role === 'super_admin' ? '管理员' : '用户' }}</td><td class="px-3 py-2 text-sm">{{ user.accountLimit < 0 ? '不限制' : `${user.accountLimit || 2} 个` }}</td><td class="px-3 py-2 text-right text-sm"><button class="mr-3 text-blue-600" @click="$emit('openEditUser', user)">编辑</button><button v-if="user.username !== currentUsername" class="text-red-600" @click="$emit('deleteUser', user)">删除</button></td></tr>
          <tr v-if="filteredUsers.length === 0"><td colspan="4" class="px-3 py-8 text-center text-gray-500">没有找到用户</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="showEditModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="showEditModal = false">
      <div class="max-w-lg w-full rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-800" @click.stop>
        <h2 class="mb-4 text-lg font-bold">编辑用户</h2>
        <div class="space-y-4"><BaseInput v-model="editForm.newUsername" label="用户名" placeholder="输入新用户名" /><BaseInput v-model="editForm.password" label="新密码" type="password" placeholder="留空则不修改" /><BaseInput v-model.number="editForm.accountLimit" label="可添加账号数" type="number" min="1" /></div>
        <div class="mt-5 flex justify-end gap-3"><BaseButton variant="secondary" size="sm" @click="showEditModal = false">取消</BaseButton><BaseButton variant="primary" size="sm" :disabled="editLoading" @click="$emit('editUser')">{{ editLoading ? '保存中...' : '保存' }}</BaseButton></div>
      </div>
    </div>
  </div>
</template>
