<script setup lang="ts">
// 虫/草贴图：从 QQ 农场游戏内纹理图集（extraRes/1d2606245.png）裁剪的真实素材：
// - weed.png : pushGrass 的草丛顶部（去掉了 "放草" 文字）
// - bug.png  : img_operate_bug 的绿色毛毛虫/害虫图标
const props = withDefaults(defineProps<{
  type: 'weed' | 'bug'
}>(), {
  type: 'weed',
})

const spriteUrl = props.type === 'weed'
  ? '/game-config/pest_images/weed.png'
  : '/game-config/pest_images/bug.png'
</script>

<template>
  <img
    class="pest-img"
    :class="type === 'weed' ? 'pest-weed' : 'pest-bug'"
    :src="spriteUrl"
    :alt="type === 'weed' ? '杂草' : '害虫'"
    aria-hidden="true"
  >
</template>

<style scoped>
.pest-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: auto;
}

.pest-weed {
  transform-origin: 50% 100%;
  animation: pest-weed-sway 2.6s ease-in-out infinite;
}

.pest-bug {
  transform-origin: 50% 62%;
  animation: pest-bug-wiggle 1s ease-in-out infinite;
}

@keyframes pest-weed-sway {
  0%,
  100% {
    transform: rotate(-7deg);
  }
  50% {
    transform: rotate(7deg);
  }
}

@keyframes pest-bug-wiggle {
  0%,
  100% {
    transform: rotate(-8deg) translateY(0);
  }
  50% {
    transform: rotate(8deg) translateY(-1.5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pest-weed,
  .pest-bug {
    animation: none;
  }
}
</style>
