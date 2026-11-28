<script setup lang="ts">
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'

interface DeviceProtocolConfig {
  enabled: boolean
  userAgent: string
  deviceModel: string
  deviceBrand: string
  deviceMac: string
  deviceId: string
  imei: string
}

defineProps<{
  loading: boolean
  saving: boolean
  ready?: boolean
  readError?: string
  unknown?: boolean
  mutationError?: string
  presetOptions: { label: string, value: string | number }[]
}>()

const emit = defineEmits<{
  applyPreset: [value: string | number | undefined]
  randomMac: []
  randomDeviceId: []
  randomImei: []
  save: []
  read: []
}>()

const form = defineModel<DeviceProtocolConfig>('form', { required: true })
const selectedPreset = defineModel<string | number>('selectedPreset', { required: true })
</script>

<template>
  <section class="ui-card p-4 sm:p-5">
    <h4 class="mb-3 flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
      <div class="i-carbon-mobile" />
      设备协议配置
    </h4>

    <div v-if="loading" class="py-6 text-center text-sm text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else-if="LOCAL_UI_READONLY" class="ui-empty-state"><p>本地只读浏览不读取用户设备配置。</p></div>
    <div v-else class="space-y-3">
      <p v-if="readError || mutationError || !ready" class="ui-notice" role="status">{{ mutationError || readError || '设备配置尚未读取，不能保存默认占位内容。' }}</p>
      <BaseButton v-if="unknown || readError || !ready" variant="outline" size="sm" :disabled="saving || loading" @click="emit('read')">重新读取</BaseButton>
      <fieldset class="space-y-3 m-0 border-0 p-0" :disabled="saving || !ready || !!readError">
      <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-700/40">
        <BaseSwitch
          v-model="form.enabled"
          label="启用自定义设备协议"
        />
        <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
          启用后会使用这里配置的设备参数发起登录。修改后建议重新登录相关账号。
        </p>
      </div>

      <BaseSelect
        v-model="selectedPreset"
        label="快速选择热门机型"
        :options="presetOptions"
        @update:model-value="emit('applyPreset', $event)"
      />

      <BaseInput
        v-model="form.userAgent"
        label="协议头 (User-Agent，可留空)"
        type="text"
        placeholder="手机 QQ 预设留空，不发送此请求头"
      />

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <BaseInput
          v-model="form.deviceBrand"
          label="设备品牌"
          type="text"
          placeholder="如 Apple / Huawei / Xiaomi"
        />
        <BaseInput
          v-model="form.deviceModel"
          label="设备型号"
          type="text"
          placeholder="如 iPhone 15 Pro Max"
        />
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="flex items-end gap-2">
          <BaseInput
            v-model="form.deviceMac"
            class="flex-1"
            label="设备 MAC 地址"
            type="text"
            placeholder="XX:XX:XX:XX:XX:XX"
          />
          <BaseButton variant="secondary" size="sm" @click="emit('randomMac')">
            随机
          </BaseButton>
        </div>
        <div class="flex items-end gap-2">
          <BaseInput
            v-model="form.deviceId"
            class="flex-1"
            label="设备 ID"
            type="text"
            placeholder="16位设备 ID"
          />
          <BaseButton variant="secondary" size="sm" @click="emit('randomDeviceId')">
            随机
          </BaseButton>
        </div>
        <div class="flex items-end gap-2">
          <BaseInput
            v-model="form.imei"
            class="flex-1"
            label="IMEI 编码"
            type="text"
            placeholder="15位 IMEI"
          />
          <BaseButton variant="secondary" size="sm" @click="emit('randomImei')">
            随机
          </BaseButton>
        </div>
      </div>

      <p class="text-xs text-gray-500 dark:text-gray-400">
        这组配置按当前用户保存，不区分单个账号。仅在登录兼容性或风控需要时启用即可。
      </p>

      <div class="flex justify-end border-t pt-3 dark:border-gray-700">
        <BaseButton
          variant="primary"
          size="sm"
          :loading="saving"
          :disabled="unknown || !ready || !!readError"
          @click="emit('save')"
        >
          保存设备协议配置
        </BaseButton>
      </div>
      </fieldset>
    </div>
  </section>
</template>
