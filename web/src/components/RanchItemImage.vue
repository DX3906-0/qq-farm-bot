<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ src?: string, alt: string, label?: string }>()
const failed = ref(false)
const element = ref<HTMLImageElement | null>(null)
watch(() => props.src, () => { failed.value = false })
function onError(event: Event) {
  if (event.currentTarget === element.value && element.value?.getAttribute('src') === props.src) failed.value = true
}
</script>
<template>
  <span class="ranch-item-image" :title="src && !failed ? (label || '已核验官方图标') : '暂无已核验图标'">
    <img v-if="src && !failed" :key="src" ref="element" :src="src" :alt="alt" loading="lazy" decoding="async" @error="onError">
    <span v-else class="ranch-image-placeholder" role="img" :aria-label="`${alt}：图标未确认`"><span class="i-carbon-image" aria-hidden="true" /><span class="ranch-image-caption" aria-hidden="true">未确认</span></span>
  </span>
</template>
<style scoped>
.ranch-item-image { display: inline-flex; width: 52px; height: 52px; flex: none; align-items: center; justify-content: center; border-radius: var(--radius-card); background: var(--surface-2); color: var(--muted-text); overflow: hidden; }
.ranch-item-image img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
.ranch-image-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
.ranch-image-placeholder > .i-carbon-image { font-size: 19px; opacity: .6; }
.ranch-image-caption { color: var(--muted-text); font-size: 9px; line-height: 1.2; }
</style>
