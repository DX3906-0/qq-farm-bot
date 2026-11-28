<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { GameWorkspace } from '@/router/menu'

const props = defineProps<{ destination: GameWorkspace, requestId: number }>()
const emit = defineEmits<{ (e: 'arrived', requestId: number): void }>()
const illustration = ref<SVGGElement | null>(null)
const id = useId()
let completed = false
let media: MediaQueryList | null = null
function arrive() {
  if (completed) return
  completed = true
  emit('arrived', props.requestId)
}
function animationFinished(event: AnimationEvent) {
  if (event.animationName.startsWith('workspace-journey-move')) arrive()
}
function preferenceChanged() { if (media?.matches) arrive() }
function visibilityChanged() { if (document.hidden) arrive() }
onMounted(async () => {
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', preferenceChanged)
  document.addEventListener('visibilitychange', visibilityChanged)
  await nextTick()
  // Disabled/unsupported motion must never leave the underlying UI inert.
  const journey = illustration.value?.getAnimations?.().find(animation =>
    'animationName' in animation && String(animation.animationName).startsWith('workspace-journey-move'))
  if (media.matches || document.hidden || !journey) arrive()
  // The Web Animations promise also settles on cancellation, even when the
  // browser does not dispatch a CSS animationcancel event to the SVG element.
  else void journey.finished.then(arrive, arrive)
})
onBeforeUnmount(() => {
  completed = true
  media?.removeEventListener('change', preferenceChanged)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <div class="workspace-travel-mask" :data-travel-destination="destination" role="status" aria-live="polite" aria-atomic="true">
    <section class="workspace-travel-card" :style="{ '--journey-direction': destination === 'ranch' ? 1 : -1 }">
      <p class="workspace-travel-eyebrow">农牧场 · 工作区切换</p>
      <h2>{{ destination === 'ranch' ? '正在前往牧场' : '正在返回农场' }}<span class="workspace-travel-dots" aria-hidden="true"><i /><i /><i /></span></h2>
      <svg viewBox="0 0 560 270" class="workspace-travel-art" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient :id="`${id}-sky`" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--theme-primary)" stop-opacity=".09" /><stop offset="1" stop-color="var(--surface-1)" stop-opacity="0" /></linearGradient>
        </defs>
        <rect x="0" y="0" width="560" height="245" rx="30" :fill="`url(#${id}-sky)`" />
        <circle cx="452" cy="58" r="26" fill="#efc76b" opacity=".8" />
        <circle cx="452" cy="58" r="35" fill="#efc76b" opacity=".12" />
        <g class="workspace-cloud" fill="var(--surface-1)" opacity=".9"><ellipse cx="108" cy="58" rx="31" ry="10" /><circle cx="99" cy="48" r="13" /><circle cx="116" cy="45" r="17" /><ellipse cx="356" cy="80" rx="26" ry="8" /><circle cx="348" cy="72" r="11" /><circle cx="363" cy="72" r="12" /></g>
        <path d="M0 184C70 117 154 134 229 171C333 102 436 130 560 169V245H0Z" fill="var(--theme-primary)" opacity=".09" />
        <path d="M0 209C96 165 160 183 256 213C367 171 454 171 560 201V249H0Z" fill="var(--theme-primary)" opacity=".1" />
        <g stroke="#b99a70" stroke-width="6" stroke-linecap="round" opacity=".5"><path d="M34 164V204M66 156V197M98 151V192M130 153V193M162 159V198M34 177L162 172M34 193L162 187" /><path d="M457 154V193M488 158V197M519 168V202M457 165L519 179M457 182L519 194" /></g>
        <path d="M38 235C159 214 384 212 527 235" fill="none" stroke="#c8ad87" stroke-width="11" stroke-linecap="round" opacity=".2" />
        <g class="workspace-grass" fill="none" stroke="var(--theme-primary)" stroke-width="2.5" stroke-linecap="round" opacity=".38"><path d="M46 227l-5-9m5 9l5-12M112 235l-4-8m4 8l6-10M453 235l-5-12m5 12l7-8M517 222l-3-11m3 11l5-9" /></g>
        <g ref="illustration" class="workspace-journey" @animationend.self="animationFinished" @animationcancel.self="animationFinished">
          <g :transform="destination === 'farm' ? 'translate(560 0) scale(-1 1)' : undefined">
            <ellipse cx="176" cy="226" rx="34" ry="5" fill="#594b3b" opacity=".12" />
            <ellipse cx="337" cy="224" rx="88" ry="7" fill="#594b3b" opacity=".1" />
            <g class="workspace-child">
              <g class="workspace-leg-one"><path d="M161 182L158 214" fill="none" stroke="#4f7293" stroke-width="13" stroke-linecap="round" /><path d="M157 215L168 216" stroke="#806955" stroke-width="8" stroke-linecap="round" /></g>
              <g class="workspace-leg-two"><path d="M186 181L189 215" fill="none" stroke="#4f7293" stroke-width="13" stroke-linecap="round" /><path d="M189 216L200 218" stroke="#806955" stroke-width="8" stroke-linecap="round" /></g>
              <path d="M157 174H190V190H157Z" fill="#4f7293" />
              <path d="M149 143L140 164L129 171" fill="none" stroke="#efbd98" stroke-width="8" stroke-linecap="round" />
              <g class="workspace-child-arm"><path d="M194 142L210 126L230 132" fill="none" stroke="#efbd98" stroke-width="8" stroke-linecap="round" /><path d="M229 130Q248 142 260 157L278 174" fill="none" stroke="#a48661" stroke-width="3.5" stroke-linecap="round" /></g>
              <path d="M155 133Q171 128 190 134L199 172Q175 183 149 173Z" fill="var(--theme-primary)" stroke="#5e7957" stroke-width="2" />
              <path d="M161 132L173 144L183 132" fill="#fff4d9" />
              <path d="M172 145V172" fill="none" stroke="#fff4d9" stroke-width="2" opacity=".65" />
              <circle cx="174" cy="111" r="20" fill="#f4c6a3" stroke="#967453" stroke-width="2" />
              <path d="M154 105Q151 91 165 92L190 97L194 113L185 102L156 101Z" fill="#7e6045" />
              <ellipse cx="158" cy="118" rx="4" ry="3" fill="#df9b82" opacity=".7" />
              <g class="workspace-child-eye" fill="#5b5148"><circle cx="167" cy="110" r="2" /><circle cx="183" cy="111" r="2" /></g>
              <path d="M171 121Q178 128 185 120" fill="none" stroke="#9d6b52" stroke-width="2" stroke-linecap="round" />
              <path d="M152 91L155 76Q174 66 193 78L196 94Z" fill="#f1d386" stroke="#b19354" stroke-width="2" />
              <path d="M155 85L193 88" stroke="#dbab63" stroke-width="5" />
              <ellipse cx="174" cy="95" rx="31" ry="6" fill="#f5d98f" stroke="#b19354" stroke-width="2" />
              <path d="M165 78L164 82M177 76V81M188 80L187 84" stroke="#c3a563" stroke-width="2" stroke-linecap="round" />
            </g>
            <g v-if="destination === 'ranch'" class="workspace-cow">
              <path class="workspace-cow-tail" d="M276 159Q254 145 255 173" fill="none" stroke="#85715b" stroke-width="4" stroke-linecap="round" />
              <ellipse cx="254" cy="176" rx="4" ry="7" fill="#7e6450" />
              <g class="workspace-hoof-one"><path d="M293 184L289 215" stroke="#f8f3e7" stroke-width="12" stroke-linecap="round" /><path d="M286 216H299" stroke="#66584b" stroke-width="8" stroke-linecap="round" /></g>
              <g class="workspace-hoof-two"><path d="M349 185L354 215" stroke="#f8f3e7" stroke-width="12" stroke-linecap="round" /><path d="M351 216H364" stroke="#66584b" stroke-width="8" stroke-linecap="round" /></g>
              <g class="workspace-hoof-two"><path d="M310 190L308 219" stroke="#f8f3e7" stroke-width="12" stroke-linecap="round" /><path d="M305 220H318" stroke="#66584b" stroke-width="8" stroke-linecap="round" /></g>
              <g class="workspace-hoof-one"><path d="M368 183L378 215" stroke="#f8f3e7" stroke-width="12" stroke-linecap="round" /><path d="M375 216H388" stroke="#66584b" stroke-width="8" stroke-linecap="round" /></g>
              <path d="M278 154Q286 127 326 132Q366 128 388 152L384 185Q369 203 315 197Q273 195 278 154Z" fill="#fffaf0" stroke="#85715b" stroke-width="2.5" />
              <path d="M298 136Q311 129 324 135L323 158Q309 169 296 155Z" fill="#8c7259" />
              <path d="M340 177Q350 160 365 171L374 193L348 199Z" fill="#9b7d5e" />
              <path d="M379 139L381 126L386 137M405 138L410 126L411 143" fill="#e6d29b" stroke="#a88d64" stroke-width="2" stroke-linejoin="round" />
              <ellipse cx="375" cy="147" rx="10" ry="6" fill="#91775c" transform="rotate(-24 375 147)" />
              <ellipse cx="416" cy="146" rx="10" ry="6" fill="#91775c" transform="rotate(22 416 146)" />
              <path d="M383 138Q400 133 413 146L417 174Q401 189 385 174L379 153Z" fill="#fffaf0" stroke="#85715b" stroke-width="2.5" />
              <path d="M385 140L395 137L398 157L385 162Z" fill="#9b7d5e" />
              <circle class="workspace-cow-eye" cx="408" cy="153" r="3" fill="#594d42" />
              <ellipse cx="409" cy="177" rx="23" ry="14" fill="#eebfa6" stroke="#a98770" stroke-width="2" />
              <ellipse cx="401" cy="176" rx="2.5" ry="3" fill="#a77f68" /><ellipse cx="416" cy="176" rx="2.5" ry="3" fill="#a77f68" />
              <path d="M399 184Q408 189 416 184" fill="none" stroke="#a77f68" stroke-width="2" stroke-linecap="round" />
              <path d="M386 160L394 166" fill="none" stroke="var(--theme-primary)" stroke-width="5" stroke-linecap="round" /><path d="M392 170L394 178L401 176L399 169Z" fill="#e8c26c" />
            </g>
            <g v-else class="workspace-seed-cart">
              <g class="workspace-cart-shaft">
                <path d="M230 150L281 179" fill="none" stroke="#846747" stroke-width="6" stroke-linecap="round" />
                <path d="M230 150L281 179" fill="none" stroke="#d6b68a" stroke-width="2.5" stroke-linecap="round" />
                <circle cx="229" cy="149" r="4" fill="#f1d89f" stroke="#8f704c" stroke-width="1.5" />
              </g>
              <g class="workspace-cart-body">
                <path d="M279 170H362L352 210H289Z" fill="#d6a66f" stroke="#795f42" stroke-width="3" stroke-linejoin="round" />
                <path d="M284 179H360M286 188H358M288 198H355" stroke="#efcd98" stroke-width="2" opacity=".8" />
                <path d="M296 173Q287 142 301 139Q317 141 316 173Z" fill="#f0d391" stroke="#9a794c" stroke-width="2.5" />
                <path d="M320 173Q314 146 332 143Q350 147 349 173Z" fill="#dce2b6" stroke="#7f9867" stroke-width="2.5" />
                <path d="M300 142L296 132M295 143L291 136M308 141L310 131" stroke="#92744b" stroke-width="3" stroke-linecap="round" />
                <path d="M333 145V132M333 137Q320 130 322 125Q335 124 333 137M333 139Q345 127 350 132Q347 143 333 139" fill="#72a76b" stroke="#507a4e" stroke-width="1.5" stroke-linejoin="round" />
                <path d="M302 173V180M332 173V180" stroke="#795f42" stroke-width="2" />
              </g>
              <g class="workspace-cart-wheel workspace-cart-wheel-rear">
                <circle cx="294" cy="215" r="13" fill="#7b5e43" opacity=".18" />
                <circle cx="294" cy="211" r="11" fill="#f7e8c4" stroke="#72583f" stroke-width="4" />
                <circle class="workspace-wheel-hub" cx="294" cy="211" r="3.5" fill="#c18a4c" />
                <path d="M294 201V221M284 211H304M287 204L301 218M301 204L287 218" stroke="#aa855a" stroke-width="1.5" />
              </g>
              <g class="workspace-cart-wheel workspace-cart-wheel-front">
                <circle cx="348" cy="215" r="13" fill="#7b5e43" opacity=".18" />
                <circle cx="348" cy="211" r="11" fill="#f7e8c4" stroke="#72583f" stroke-width="4" />
                <circle class="workspace-wheel-hub" cx="348" cy="211" r="3.5" fill="#c18a4c" />
                <path d="M348 201V221M338 211H358M341 204L355 218M355 204L341 218" stroke="#aa855a" stroke-width="1.5" />
              </g>
            </g>
            <g class="workspace-dust" fill="#bca17d" opacity=".28"><ellipse cx="134" cy="222" rx="6" ry="2" /><ellipse cx="252" cy="220" rx="7" ry="2" /></g>
          </g>
        </g>
      </svg>
      <p class="workspace-travel-caption">{{ destination === 'ranch' ? '沿着草坡小路，和奶牛一起前往牧场。' : '带上种子小车，回到熟悉的农场。' }}</p>
      <p class="workspace-travel-note"><span class="i-carbon-locked" aria-hidden="true" />账号与待核对记录保持不变</p>
    </section>
  </div>
</template>

<style scoped>
.workspace-travel-mask { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 22px; background: color-mix(in srgb, var(--surface-2) 94%, transparent); }
.workspace-travel-card { width: min(100%, 620px); padding: 30px 28px 24px; overflow: hidden; border: 1px solid var(--surface-border); border-radius: 24px; background: var(--surface-1); box-shadow: var(--surface-shadow-card); text-align: center; color: var(--theme-text); }
.workspace-travel-eyebrow { margin: 0 0 10px; color: var(--muted-text); font-size: 11px; letter-spacing: .12em; }
.workspace-travel-card h2 { display: inline-flex; align-items: center; gap: 9px; margin: 0; font-size: 23px; font-weight: 650; }
.workspace-travel-dots { display: inline-flex; gap: 4px; align-items: center; }
.workspace-travel-dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--theme-primary); animation: workspace-dot 900ms ease-in-out infinite; }
.workspace-travel-dots i:nth-child(2) { animation-delay: 120ms; }.workspace-travel-dots i:nth-child(3) { animation-delay: 240ms; }
.workspace-travel-art { display: block; width: 100%; margin: 17px 0 3px; overflow: visible; contain: layout paint; }
.workspace-travel-caption { margin: 0; color: var(--theme-text); font-size: 13px; line-height: 1.8; }
.workspace-travel-note { display: inline-flex; align-items: center; gap: 6px; margin: 12px 0 0; color: var(--muted-text); font-size: 11px; }
.workspace-journey { will-change: transform; transform-origin: 280px 205px; animation: workspace-journey-move 1080ms cubic-bezier(.22,.72,.28,1) both; }
.workspace-child { transform-origin: 176px 206px; animation: workspace-child-bob 360ms ease-in-out infinite; }
.workspace-child-arm { transform-origin: 194px 142px; animation: workspace-push 720ms cubic-bezier(.4,0,.2,1) infinite; }
.workspace-leg-one { transform-origin: 163px 182px; animation: workspace-step 360ms cubic-bezier(.37,0,.63,1) infinite alternate; }
.workspace-leg-two { transform-origin: 185px 182px; animation: workspace-step 360ms cubic-bezier(.37,0,.63,1) infinite alternate-reverse; }
.workspace-hoof-one { transform-box: fill-box; transform-origin: 50% 0; animation: workspace-hoof 420ms cubic-bezier(.37,0,.63,1) infinite alternate; }
.workspace-hoof-two { transform-box: fill-box; transform-origin: 50% 0; animation: workspace-hoof 420ms cubic-bezier(.37,0,.63,1) infinite alternate-reverse; }
.workspace-cow-tail { transform-origin: 276px 159px; animation: workspace-tail 820ms ease-in-out infinite alternate; }
.workspace-child-eye,.workspace-cow-eye { transform-box: fill-box; transform-origin: center; animation: workspace-blink 2400ms ease-in-out infinite; }
.workspace-cart-body { transform-box: fill-box; transform-origin: 50% 100%; animation: workspace-cart-bounce 360ms ease-in-out infinite; }
.workspace-cart-shaft { transform-box: fill-box; transform-origin: 0 50%; animation: workspace-shaft 720ms ease-in-out infinite; }
.workspace-cart-wheel { transform-box: fill-box; transform-origin: center; animation: workspace-wheel 600ms linear infinite; }
.workspace-cart-wheel-front { animation-duration: 570ms; }
.workspace-wheel-hub { transform-box: fill-box; transform-origin: center; }
.workspace-dust { transform-box: fill-box; transform-origin: center; animation: workspace-puff 520ms ease-out infinite; }.workspace-cloud { animation: workspace-cloud-drift 3s ease-in-out infinite alternate; }
.workspace-grass { animation: workspace-grass-sway 1100ms ease-in-out infinite alternate; }
@keyframes workspace-journey-move { 0% { transform: translate3d(calc(-70px * var(--journey-direction)), 0, 0) rotate(-.6deg); } 24% { transform: translate3d(calc(-42px * var(--journey-direction)), -2px, 0) rotate(0deg); } 72% { transform: translate3d(calc(38px * var(--journey-direction)), -1px, 0) rotate(.35deg); } 100% { transform: translate3d(calc(70px * var(--journey-direction)), 0, 0) rotate(0deg); } }
@keyframes workspace-child-bob { 0%,100% { transform: translateY(0) rotate(0); } 48% { transform: translateY(-2.5px) rotate(-.45deg); } }
@keyframes workspace-push { 0%,100% { transform: rotate(-1.5deg) translateY(0); } 50% { transform: rotate(2deg) translateY(1px); } }
@keyframes workspace-shaft { 0%,100% { transform: rotate(0); } 50% { transform: rotate(1.3deg); } }
@keyframes workspace-cart-bounce { 0%,100% { transform: translateY(0) rotate(0); } 48% { transform: translateY(-1.5px) rotate(.35deg); } }
@keyframes workspace-grass-sway { from { transform: translateX(0); } to { transform: translateX(2px); } }
@keyframes workspace-wave { 0%,100% { transform: rotate(-3deg); } 50% { transform: rotate(4deg); } }
@keyframes workspace-step { from { transform: rotate(-12deg); } to { transform: rotate(12deg); } }
@keyframes workspace-hoof { from { transform: rotate(-7deg); } to { transform: rotate(8deg); } }
@keyframes workspace-tail { from { transform: rotate(-8deg); } to { transform: rotate(8deg); } }
@keyframes workspace-blink { 0%,88%,100% { transform: scaleY(1); } 92% { transform: scaleY(.15); } }
@keyframes workspace-wheel { to { transform: rotate(360deg); } }
@keyframes workspace-puff { from { transform: translateX(0) scale(.7); opacity: .2; } to { transform: translateX(-12px) scale(1.3); opacity: 0; } }
@keyframes workspace-cloud-drift { to { transform: translateX(-9px); } }
@keyframes workspace-dot { 0%,80%,100% { transform: translateY(0); opacity: .45; } 40% { transform: translateY(-3px); opacity: 1; } }
@media (max-width: 480px) { .workspace-travel-mask { padding: 18px; }.workspace-travel-card { padding: 24px 16px 22px; border-radius: 20px; }.workspace-travel-card h2 { font-size: 20px; }.workspace-travel-caption { font-size: 12px; }.workspace-travel-art { margin-top: 19px; } }
@media (prefers-reduced-motion: reduce) { .workspace-travel-art *,.workspace-travel-dots i { animation: none !important; transform: none; } }
</style>
