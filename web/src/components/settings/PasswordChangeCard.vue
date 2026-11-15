<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

interface PasswordForm {
  old: string
  new: string
  confirm: string
}

defineProps<{
  saving: boolean
  unknown?: boolean
  mutationError?: string
}>()

const emit = defineEmits<{
  save: []
}>()

const form = defineModel<PasswordForm>('form', { required: true })
</script>

<template>
  <section class="ui-card p-4 sm:p-5">
    <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
      <div class="i-carbon-password" />
      修改用户密码
    </h4>

    <p v-if="LOCAL_UI_READONLY" class="ui-notice">本地只读浏览不能修改密码。</p>
    <p v-if="mutationError" class="ui-notice" role="status">{{ mutationError }}{{ unknown ? ' 请另行确认新旧密码，不自动再次提交。' : '' }}</p>
    <fieldset class="space-y-3 border-0 p-0 m-0" :disabled="saving || unknown || LOCAL_UI_READONLY">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <BaseInput
          v-model="form.old"
          label="当前密码"
          type="password"
          placeholder="当前用户密码"
          autocomplete="current-password"
          required
        />
        <BaseInput
          v-model="form.new"
          label="新密码"
          type="password"
          placeholder="至少 4 位"
          autocomplete="new-password"
          minlength="4"
          required
        />
        <BaseInput
          v-model="form.confirm"
          label="确认新密码"
          type="password"
          placeholder="再次输入新密码"
          autocomplete="new-password"
          required
          :error="form.confirm && form.new !== form.confirm ? '两次密码输入不一致' : ''"
        />
      </div>

      <div class="flex items-center justify-end pt-1">
        <BaseButton
          variant="primary"
          size="sm"
          :loading="saving"
          @click="emit('save')"
        >
          修改用户密码
        </BaseButton>
      </div>
    </fieldset>
  </section>
</template>
