<script setup lang="ts">
import { RouterView } from 'vue-router'
import ToastContainer from '@/components/ToastContainer.vue'
import { LOCAL_UI_READONLY } from '@/config/localReadonly'
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
    <div class="app-content-shell" :class="{ 'app-local-readonly': LOCAL_UI_READONLY }">
      <div class="app-route-host"><RouterView /></div>
    </div>
    <ToastContainer />
  </div>
</template>

<style>
/* Global styles */
.app-content-shell, .app-route-host { height: 100%; min-height: 0; }
.app-local-readonly { display: flex; flex-direction: column; }
.app-local-readonly .app-route-host { flex: 1; min-height: 0; height: auto; }
.app-local-readonly .app-route-host > div { height: 100% !important; }
.tab-motion-viewport { min-width: 0; overflow: clip; }
body {
  margin: 0;
  font-family: 'DM Sans', 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
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
  --surface-shadow: 0 12px 32px rgba(70, 58, 34, 0.14);
  --surface-shadow-card: 0 2px 8px rgba(70, 58, 34, 0.07);
  --surface-shadow-soft: 0 1px 4px rgba(70, 58, 34, 0.06);
  --muted-text: #625b4d;
  --radius-control: 8px;
  --radius-card: 12px;
  --radius-panel: 16px;
  --action-bg: #416d3b;
  --action-hover: #355b31;
  --action-text: #ffffff;
  --status-success: #327047;
  --status-danger: #b4232c;
  --status-warning: #875719;
  --status-info: #245b96;
  --focus-ring: color-mix(in srgb, var(--theme-primary) 65%, #1d4ed8);
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
  --surface-shadow: 0 14px 36px rgba(0, 0, 0, 0.40);
  --surface-shadow-card: 0 3px 10px rgba(0, 0, 0, 0.26);
  --surface-shadow-soft: 0 1px 4px rgba(0, 0, 0, 0.24);
  --muted-text: #c1c8b7;
  --status-success: #98d7a8;
  --status-danger: #ffaaaa;
  --status-warning: #f1c980;
  --status-info: #9ac7f6;
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

/* Page headings, navigation and read states share one theme-aware vocabulary. */
.ui-page-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 0 2px; }
.ui-page-heading h1 { margin: 0; color: var(--theme-text); font-size: 24px; line-height: 1.35; font-weight: 600; }
.ui-page-heading p { margin: 6px 0 0; color: var(--muted-text); font-size: 13px; line-height: 1.6; }
.ui-tabs { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; padding: 8px; border: 1px solid var(--surface-border); border-radius: var(--radius-card); background: var(--surface-1); }
.ui-tab { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 14px; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--theme-text); font: inherit; font-size: 14px; font-weight: 500; line-height: 1.5; cursor: pointer; transition: background-color 150ms ease, color 150ms ease, box-shadow 150ms ease; }
.ui-tab:hover { background: var(--surface-2); color: var(--theme-text); }
.ui-tab[data-active='true'] { background: var(--action-bg); color: var(--action-text); }
[data-sliding-tabs] { position: relative; isolation: isolate; }
[data-sliding-tabs] > .ui-tab { position: relative; z-index: 1; }
[data-sliding-tabs] > .ui-tab[data-active='true'] { background: transparent !important; color: var(--theme-text) !important; }
[data-sliding-tabs] > .ui-tab[data-active='true'] > .ui-tab-icon,
[data-sliding-tabs] > .ui-tab[data-active='true'] > [aria-hidden='true'] { color: var(--theme-primary); }
.ui-tab-selection { position: absolute; top: 0; left: 0; z-index: 0; border-radius: var(--radius-control); pointer-events: none; opacity: 0; background: color-mix(in srgb, var(--theme-primary) 15%, var(--surface-1)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 16%, transparent); }
.ui-tab-selection[data-ready='true'] { opacity: 1; }
.ui-tab-label { transition: transform 90ms ease; }
/* Equal side rails center the label itself, not an asymmetric icon/badge group.
   The badge rail is always reserved, including zero/unknown counts. */
.ui-tab.ui-tab-counted { display: inline-grid; grid-template-columns: 24px auto 24px; column-gap: 8px; }
.ui-tab-counted > .ui-tab-icon { display: grid; place-items: center; width: 24px; height: 24px; font-size: 14px; }
.ui-tab-counted > .ui-tab-count { width: 24px; min-width: 24px; text-align: center; font-variant-numeric: tabular-nums; }
.ui-tab-counted > .ui-tab-label { text-align: center; }
.ui-tab:active .ui-tab-label { transform: scale(.97); }
.ui-empty-state { display: grid; place-items: center; align-content: center; gap: 10px; min-height: 176px; padding: 32px 18px; border: 1px dashed var(--surface-border-strong); border-radius: var(--radius-card); background: color-mix(in srgb, var(--surface-1) 72%, transparent); color: var(--muted-text); text-align: center; font-size: 13px; line-height: 1.7; }
.ui-empty-state > span { font-size: 28px; }
.ui-empty-state h2, .ui-empty-state h3 { margin: 0; color: var(--theme-text); font-size: 15px; font-weight: 600; }
.ui-empty-state p { max-width: 42em; margin: 0; }
.ui-notice { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--surface-border); border-left: 3px solid var(--theme-primary); border-radius: var(--radius-control); background: var(--surface-1); color: var(--muted-text); font-size: 13px; line-height: 1.7; }
.ui-notice > span:first-child { flex-shrink: 0; margin-top: 3px; font-size: 16px; color: var(--theme-primary); }
.ui-notice p { margin: 0; }
.ui-notice[data-tone='danger'] { border-left-color: var(--status-danger); color: var(--status-danger); }
.ui-notice[data-tone='warning'] { border-left-color: var(--status-warning); color: var(--status-warning); }
@media (max-width: 640px) { .ui-page-heading h1 { font-size: 20px; } .ui-tabs { gap: 4px; padding: 6px; } .ui-tab { min-height: 44px; padding: 8px 10px; font-size: 13px; } .ui-empty-state { min-height: 156px; padding: 28px 16px; } }
@media (pointer: coarse) { .ui-tab { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .ui-tab, .ui-tab-label { transition: none; } .ui-tab:active .ui-tab-label { transform: none; } }

.ui-card {
  border: 1px solid var(--surface-border);
  background: var(--surface-1);
  box-shadow: var(--surface-shadow-soft);
  border-radius: var(--radius-card);
}

.ui-card-elevated {
  border: 1px solid var(--surface-border);
  background: var(--surface-1);
  box-shadow: var(--surface-shadow-card);
  border-radius: var(--radius-panel);
}

.ui-subtle-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  border-radius: var(--radius-card);
}

.glass-panel {
  border: 1px solid var(--surface-border);
  background: color-mix(in srgb, var(--surface-1) 78%, transparent);
  backdrop-filter: blur(20px);
  box-shadow: var(--surface-shadow-soft);
}

/* Controls keep their small utility radius; surfaces own their explicit tier. */
.ui-card.rounded-lg,
.ui-subtle-panel.rounded-lg,
.glass-panel.rounded-lg { border-radius: var(--radius-card); }
.ui-card-elevated.rounded-lg { border-radius: var(--radius-panel); }

.ui-card,
.ui-card-elevated {
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

/* hover 时只柔化阴影与边框，不再整体上移：避免弹窗/卡片在鼠标移入移出时产生"闪一下"的位移跳动 */
button.ui-card:hover,
a.ui-card:hover,
.ui-card[data-interactive='true']:hover,
.ui-card-elevated[data-interactive='true']:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 26%, var(--surface-border));
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

/* One clipped, compositor-painted content snapshot; navigation/header and
   buttons stay live. No DOM exit transition, duplicate page or blurred text. */
:root[data-content-motion] { --content-slide-x: 0%; --content-slide-y: 100%; --content-duration: 460ms; --content-easing: cubic-bezier(.24, .08, .2, 1); }
:root[data-content-motion='panel'] { --content-slide-x: 100%; --content-slide-y: 0%; --content-duration: 420ms; --content-easing: cubic-bezier(.24, .08, .2, 1); }
:root[data-content-direction='back'] { --content-slide-y: -100%; }
:root[data-content-motion='panel'][data-content-direction='back'] { --content-slide-x: -100%; --content-slide-y: 0%; }
:root::view-transition,
:root::view-transition-group(farm-content),
:root::view-transition-image-pair(farm-content),
:root::view-transition-old(farm-content),
:root::view-transition-new(farm-content) { pointer-events: none; }
:root::view-transition-group(farm-content) {
  animation: none;
  clip-path: inset(0 round var(--radius-card, 12px));
}
:root::view-transition-image-pair(farm-content) { isolation: isolate; overflow: clip; }
:root[data-content-motion='prime']::view-transition-old(farm-content) { animation: none; opacity: 0; }
:root[data-content-motion='prime']::view-transition-new(farm-content) { animation: none; }
:root::view-transition-old(farm-content),
:root::view-transition-new(farm-content) {
  width: 100%; height: 100%;
  object-fit: none; object-position: top left;
  transform-origin: 50% 32%;
  mix-blend-mode: normal;
}
:root::view-transition-old(farm-content) {
  z-index: 1;
  animation: content-snapshot-out var(--content-duration, 460ms) var(--content-easing) both;
}
:root::view-transition-new(farm-content) {
  z-index: 2;
  animation: content-snapshot-in var(--content-duration, 460ms) var(--content-easing) both;
}
/* Equal distances, timing and easing keep the two opaque painted pages joined
   edge-to-edge, with no zoom/fade and no content escaping the viewport clip. */
@keyframes content-snapshot-out {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(calc(var(--content-slide-x) * -1), calc(var(--content-slide-y) * -1), 0); }
}
@keyframes content-snapshot-in {
  from { transform: translate3d(var(--content-slide-x), var(--content-slide-y), 0); }
  to { transform: translate3d(0, 0, 0); }
}

@media (prefers-reduced-motion: reduce) {
  :root::view-transition-old(farm-content), :root::view-transition-new(farm-content) { animation: none; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
  .farm-decor::before { animation: none; }
}

:focus-visible {
  outline: 2px solid var(--focus-ring, #416d3b);
  outline-offset: 3px;
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
