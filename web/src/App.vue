<script setup lang="ts">
import type { Theme } from '@/stores/app'
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import ToastContainer from '@/components/ToastContainer.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

// 立即应用保存的主题（在组件挂载前）
const savedTheme = localStorage.getItem('ui_theme') as Theme
if (savedTheme && appStore.themes[savedTheme]) {
  appStore.applyTheme(savedTheme)
}

onMounted(() => {
  appStore.fetchTheme()
})
</script>

<template>
  <div class="h-screen w-screen overflow-hidden app-root" :style="{ color: 'var(--theme-text)' }">
    <!-- 背景装饰层：晨雾底图 + 底部山丘剪影；植物装饰改为只贴边的淡色边纹，绝不压内容 -->
    <div class="farm-decor" aria-hidden="true">
      <div class="decor-mist" />
      <div class="decor-hills" />
      <div class="decor-edge decor-edge-l" />
      <div class="decor-edge decor-edge-r" />
    </div>
    <RouterView />
    <ToastContainer />
  </div>
</template>

<style>
/* Global styles */
body {
  margin: 0;
  font-family: 'DM Sans', sans-serif;
  background: var(--app-bg);
  color: var(--theme-text);
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
}

/* Color theme variables */
:root {
  /* 农场·昼：暖米白 + 鼠尾草绿，与「自动控制」页面视觉语言保持一致 */
  --theme-bg: #f7f3ea;
  --theme-text: #2c2a22;
  --theme-primary: #5E8C5A;
  --theme-secondary: #7FB069;
  --theme-gradient: linear-gradient(135deg, #7FB069 0%, #5E8C5A 100%);
  --app-bg: linear-gradient(180deg, #faf7ef 0%, #efe9dc 100%);
  --surface-1: #FCFBF6;
  --surface-2: #F7F2E7;
  --surface-3: #F0ECDD;
  --surface-border: #ECE5D6;
  --surface-border-strong: #E1D9C5;
  --surface-shadow: 0 18px 48px rgba(70, 58, 34, 0.10);
  --surface-shadow-soft: 0 8px 24px rgba(70, 58, 34, 0.07);
  --muted-text: #8b8270;
  --input-bg: rgba(255, 255, 255, 0.92);
  --panel-glow: color-mix(in srgb, var(--theme-primary) 16%, transparent);
}

.dark {
  /* 农场·夜：深林绿黑，与「自动控制」页面暗色基调一致 */
  --app-bg: radial-gradient(circle at top left, color-mix(in srgb, var(--theme-primary) 14%, transparent) 0, transparent 28rem), linear-gradient(180deg, #181b15 0%, #11130d 100%);
  --surface-1: #1E211A;
  --surface-2: #262B20;
  --surface-3: #2E3427;
  --surface-border: rgba(255, 255, 255, 0.08);
  --surface-border-strong: rgba(255, 255, 255, 0.13);
  --surface-shadow: 0 20px 55px rgba(0, 0, 0, 0.40);
  --surface-shadow-soft: 0 10px 28px rgba(0, 0, 0, 0.30);
  --muted-text: #9aa089;
  --input-bg: rgba(18, 22, 14, 0.6);
  --panel-glow: color-mix(in srgb, var(--theme-primary) 20%, transparent);
}

/* SaaS surface system */
.bg-white {
  background-color: var(--surface-1) !important;
}

.dark .bg-gray-800,
.dark .bg-gray-900 {
  background-color: var(--surface-1) !important;
}

.bg-gray-50 {
  background-color: var(--surface-2) !important;
}

.dark .bg-gray-700 {
  background-color: var(--surface-3) !important;
}

.ui-card {
  border: 1px solid var(--surface-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 96%, #ffffff 4%), var(--surface-1));
  box-shadow: var(--surface-shadow-soft);
  border-radius: 1.25rem;
}

.ui-card-elevated {
  border: 1px solid var(--surface-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 92%, #ffffff 8%), var(--surface-1));
  box-shadow: var(--surface-shadow);
  border-radius: 1.25rem;
}

.ui-subtle-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  border-radius: 1rem;
}

.glass-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-1) 78%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: var(--surface-shadow-soft);
}

/* 统一卡片圆角为农场大圆角，使全站与「自动控制」页面视觉一致 */
.rounded-lg {
  border-radius: 1.25rem !important;
}

/* ===== 农场律动层：让静止的卡片拥有自然的呼吸与流动 ===== */

/* 卡片轻柔上浮淡入（切换标签/加载时重播，营造节奏感） */
@keyframes card-reveal {
  from { opacity: 0; transform: translateY(16px) scale(0.992); }
  to   { opacity: 1; transform: none; }
}

.ui-card,
.ui-card-elevated {
  animation: card-reveal 0.55s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  transition: box-shadow 0.35s ease, border-color 0.35s ease;
}

/* hover 时只柔化阴影与边框，不再整体上移：避免弹窗/卡片在鼠标移入移出时产生"闪一下"的位移跳动 */
.ui-card:hover,
.ui-card-elevated:hover {
  box-shadow: var(--surface-shadow);
  border-color: color-mix(in srgb, var(--theme-primary) 32%, var(--surface-border));
}

/* 弹窗/二维码等固定层自身不做入场动画与 hover 位移，避免覆盖层内容跳动 */
.fixed .ui-card,
.fixed .ui-card-elevated,
[role="dialog"] .ui-card,
[role="dialog"] .ui-card-elevated {
  animation: none;
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

/* 内容层：显式高于装饰层（z-index:0），避免依赖脆弱的负 z-index 堆叠 */
.app-root {
  position: relative;
  z-index: 1;
}

/* ===== 农场背景装饰层 =====
   作为独立的固定层（z-index:0）置于内容之下、body 农场渐变底色之上。
   内部的晨雾/柔光/山丘/植物用真实元素按 DOM 顺序叠放，不用伪元素+负 z-index，
   这样不会被 app-root 的堆叠上下文或任何父级背景裁剪/覆盖。 */
.farm-decor {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

/* 晨雾田野底图：极淡的水彩农场晨景，给单一米白底色增加冷暖层次 */
.decor-mist {
  position: absolute;
  inset: 0;
  background: url("/decorations/mist.png") center / cover no-repeat;
  opacity: 0.16;
  mix-blend-mode: soft-light;
}

/* 背景柔光：鼠尾草色光斑极缓漂移，制造自然律动而不干扰阅读 */
.farm-decor::before {
  content: "";
  position: absolute;
  inset: -25%;
  background:
    radial-gradient(42rem 42rem at 16% 10%, color-mix(in srgb, var(--theme-secondary) 16%, transparent), transparent 60%),
    radial-gradient(38rem 38rem at 86% 82%, color-mix(in srgb, var(--theme-primary) 13%, transparent), transparent 60%);
  animation: aurora-drift 28s ease-in-out infinite alternate;
}

.decor-hills {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 20vh;
  background: url("/decorations/hills.svg") no-repeat center bottom / 100% 100%;
  opacity: 0.35;
}

/* 左右贴边淡纹：只在屏幕最边缘留一条极淡的植物色带，不压内容、只丰富背景层次 */
.decor-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  pointer-events: none;
  opacity: 0.04;
  background: linear-gradient(to right, var(--theme-primary), transparent);
}
.decor-edge-l {
  left: 0;
}
.decor-edge-r {
  right: 0;
  transform: scaleX(-1);
}

@keyframes aurora-drift {
  from { transform: translate3d(-2%, -1%, 0) scale(1); }
  to   { transform: translate3d(3%, 2%, 0) scale(1.08); }
}

@keyframes plant-sway {
  from { transform: rotate(-2.5deg) translateY(0); }
  to   { transform: rotate(2.5deg) translateY(-6px); }
}

@media (prefers-reduced-motion: reduce) {
  .farm-decor::before { animation: none; }
  .ui-card,
  .ui-card-elevated { animation: none; }
}

.metric-card {
  position: relative;
  overflow: hidden;
}

.metric-card::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, var(--panel-glow), transparent 42%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent 34%);
}

.metric-card > * {
  position: relative;
}

.shadow,
.shadow-sm,
.shadow-md {
  box-shadow: var(--surface-shadow-soft) !important;
}

/* Use CSS variables for theme colors */
.btn-primary {
  background: var(--theme-gradient);
  border-color: var(--theme-primary);
}

.btn-primary:hover {
  background: var(--theme-secondary);
}

.text-primary {
  color: var(--theme-primary);
}

.bg-primary {
  background-color: var(--theme-primary);
}

.border-primary {
  border-color: var(--theme-primary);
}

.bg-gradient-primary {
  background: var(--theme-gradient);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--theme-primary) 50%, #94a3b8);
  border-radius: 999px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--theme-secondary);
  opacity: 0.8;
}
</style>
