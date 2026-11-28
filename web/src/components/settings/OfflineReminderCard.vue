<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

interface OfflineReminderConfig {
  channel: string
  reloginUrlMode: string
  endpoint: string
  token: string
  title: string
  msg: string
  offlineDeleteSec: number
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string
  senderName: string
  recipientEmail: string
  emailContent: string
}

defineProps<{
  channelOptions: { label: string, value: string | number }[]
  currentChannelDocUrl: string
  saving: boolean
  testing: boolean
  ready?: boolean
  readError?: string
  unknown?: boolean
  testUnknown?: boolean
  mutationError?: string
}>()

const emit = defineEmits<{
  openDocs: []
  test: []
  save: []
  read: []
}>()

const config = defineModel<OfflineReminderConfig>('config', { required: true })
</script>

<template>
  <section class="ui-card p-4 sm:p-5">
    <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
      <div class="i-carbon-notification" />
      下线提醒
    </h4>

    <p v-if="LOCAL_UI_READONLY" class="ui-notice">本地只读浏览不读取或保存推送配置，也不发送通知。</p>
    <p v-if="!LOCAL_UI_READONLY && (readError || mutationError || !ready)" class="ui-notice" role="status">{{ mutationError || readError || '推送设置尚未读取，不能用默认占位保存。' }}</p>
    <BaseButton v-if="!LOCAL_UI_READONLY && (unknown || readError || !ready)" variant="outline" size="sm" :disabled="saving || testing" @click="emit('read')">重新读取</BaseButton>
    <fieldset class="space-y-3 border-0 p-0 m-0" :disabled="saving || testing || !ready || !!readError || LOCAL_UI_READONLY">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
            <BaseButton
              variant="text"
              size="sm"
              :disabled="!currentChannelDocUrl"
              @click="emit('openDocs')"
            >
              官网
            </BaseButton>
          </div>
          <BaseSelect
            v-model="config.channel"
            :options="channelOptions"
            aria-label="推送渠道"
          />
        </div>
        <BaseInput
          v-if="config.channel !== 'smtp'"
          v-model.number="config.offlineDeleteSec"
          label="离线删除账号 (秒)"
          type="number"
          min="0"
          placeholder="0 表示不删除"
        />
        <BaseInput
          v-else
          v-model.number="config.smtpPort"
          label="SMTP 端口"
          type="number"
          min="1"
          max="65535"
          placeholder="465"
        />
      </div>

      <template v-if="config.channel === 'smtp'">
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.smtpHost"
            label="SMTP 服务器地址"
            type="text"
            placeholder="如 smtp.qq.com"
          />
          <BaseInput
            v-model="config.smtpUser"
            label="邮箱账号"
            type="text"
            placeholder="发件人邮箱地址"
          />
        </div>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.smtpPass"
            label="授权码"
            type="password"
            placeholder="SMTP 授权码"
          />
          <BaseInput
            v-model="config.recipientEmail"
            label="收件人邮箱"
            type="text"
            placeholder="接收通知的邮箱地址"
          />
        </div>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.senderName"
            label="发件人名称"
            type="text"
            placeholder="发件人显示名称"
          />
          <BaseInput
            v-model="config.emailContent"
            label="发信内容"
            type="text"
            placeholder="掉线提醒的自定义内容"
          />
        </div>
      </template>

      <template v-else>
        <BaseInput
          v-model="config.endpoint"
          label="接口地址"
          type="text"
          :disabled="config.channel !== 'webhook'"
          placeholder="Webhook 渠道填写接口地址"
        />

        <BaseInput
          v-model="config.token"
          label="Token"
          type="text"
          placeholder="接收端 token"
        />

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <BaseInput
            v-model="config.title"
            label="标题"
            type="text"
            placeholder="提醒标题"
          />
        </div>

        <BaseInput
          v-model="config.msg"
          label="内容"
          type="text"
          placeholder="提醒内容"
        />
      </template>
    </fieldset>

    <div class="mt-4 flex justify-end gap-2 border-t pt-3 dark:border-gray-700">
      <BaseButton
        variant="secondary"
        size="sm"
        :loading="testing"
        :disabled="saving || !ready || testUnknown || LOCAL_UI_READONLY"
        @click="emit('test')"
      >
        测试通知
      </BaseButton>
      <BaseButton
        variant="primary"
        size="sm"
        :loading="saving"
        :disabled="testing || !ready || unknown || !!readError || LOCAL_UI_READONLY"
        @click="emit('save')"
      >
        保存下线提醒设置
      </BaseButton>
    </div>
  </section>
</template>
