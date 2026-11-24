import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ObjectDirective, Ref } from 'vue'

type MotionKind = 'page' | 'panel'
type CancelReason = 'superseded' | 'navigation' | 'context' | 'unmount' | 'overlay' | 'hidden' | 'reduced' | 'capture-timeout'
interface NativeTransition {
  ready: Promise<void>
  updateCallbackDone: Promise<void>
  finished: Promise<void>
  skipTransition: () => void
}
interface MotionOptions {
  direction?: number
  valid?: () => boolean
  onAbort?: () => void
  fromKey?: string
  toKey?: string
}
interface MotionJob {
  owner: symbol
  cancel: (reason: CancelReason) => void
  navigate?: () => void
  retarget?: (update: () => void | Promise<void>, options: MotionOptions, valid: () => boolean) => Promise<boolean> | null
  finish?: () => Promise<void> | null
}

// One ephemeral painted transition for the whole document. These are browser
// rendering snapshots, never cloned game DOM, cached components or saved data.
let activeJob: MotionJob | null = null
export function cancelContentMotion(reason: CancelReason = 'overlay') {
  if (reason === 'navigation' && activeJob?.navigate) activeJob.navigate()
  else activeJob?.cancel(reason)
}

function hasVisibleOverlay() {
  if (typeof document === 'undefined')
    return false
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"], [data-motion-overlay], .fixed')]
    .some((element) => {
      if (element.tagName === 'ASIDE')
        return false
      const box = element.getBoundingClientRect()
      const css = getComputedStyle(element)
      return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0'
        && box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0
        && box.left < window.innerWidth && box.top < window.innerHeight
    })
}

let compositorPrimed = false
// The first native snapshot may compile GPU pipelines/upload surface textures.
// Prime the current painted viewport once without mounting anything or changing
// its pixels. It is cancelable before any real navigation/input/account change.
export async function primeContentCompositor(target: () => HTMLElement | null) {
  if (compositorPrimed || typeof document === 'undefined' || document.hidden || activeJob
    || typeof document.startViewTransition !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return
  await nextTick()
  if (activeJob) return
  const element = target()
  if (!element?.isConnected || hasVisibleOverlay()) return
  compositorPrimed = true
  const root = document.documentElement
  const previousName = element.style.viewTransitionName
  const previousRootName = root.style.viewTransitionName
  const previousKind = root.getAttribute('data-content-motion')
  let native: NativeTransition | undefined
  const job: MotionJob = { owner: Symbol('prime'), cancel: () => { native?.skipTransition(); cleanup() } }
  function cleanup() {
    if (activeJob !== job) return
    element!.style.viewTransitionName = previousName
    root.style.viewTransitionName = previousRootName
    if (previousKind === null) root.removeAttribute('data-content-motion')
    else root.setAttribute('data-content-motion', previousKind)
    document.removeEventListener('pointerdown', onInput, true)
    document.removeEventListener('keydown', onInput, true)
    activeJob = null
  }
  function onInput() { job.cancel('overlay') }
  activeJob = job
  root.style.viewTransitionName = 'none'
  element.style.viewTransitionName = 'farm-content'
  root.setAttribute('data-content-motion', 'prime')
  document.addEventListener('pointerdown', onInput, true)
  document.addEventListener('keydown', onInput, true)
  try {
    native = (document.startViewTransition as unknown as (callback: () => Promise<void>) => NativeTransition).call(document, () => nextTick())
    native.ready.catch(() => {})
    native.updateCallbackDone.catch(() => {})
    native.finished.then(cleanup, cleanup)
  }
  catch { cleanup() }
}

// Dialog animation is presentation only: native modality, pending RPCs and
// focus restoration remain the owner's responsibility. Rapid reversal starts
// at the current painted matrix rather than replaying an old opening frame.
export function createModalPresenceMotion(target: () => HTMLElement | null, onHidden: () => void) {
  const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)')
  let animation: Animation | null = null
  let revision = 0
  let visible = true
  let disposed = false
  function settle() {
    revision++
    animation?.cancel(); animation = null
    const element = target()
    if (element) { element.style.opacity = ''; element.style.transform = '' }
    if (!visible && !disposed) onHidden()
  }
  function change(next: boolean, initial = false) {
    if (disposed) return
    const element = target()
    const current = element && animation ? getComputedStyle(element) : null
    const from = current ? { opacity: current.opacity, transform: current.transform } : null
    animation?.cancel(); animation = null
    visible = next
    const request = ++revision
    if (!element?.isConnected || document.hidden || media?.matches || typeof element.animate !== 'function') { settle(); return }
    const mobile = window.matchMedia('(max-width: 640px)').matches
    const away = mobile ? 'translate3d(0, 24px, 0)' : 'translate3d(0, 6px, 0) scale(.99)'
    animation = element.animate([
      from || (next && initial ? { opacity: '0', transform: away } : { opacity: '1', transform: 'none' }),
      next ? { opacity: '1', transform: 'none' } : { opacity: '0', transform: away },
    ], { duration: next ? 240 : 150, easing: next ? 'cubic-bezier(.2, .65, .25, 1)' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'both' })
    const currentAnimation = animation
    currentAnimation.finished.then(() => {
      if (disposed || request !== revision) return
      currentAnimation.cancel(); animation = null
      if (!visible) onHidden()
    }, () => {})
  }
  function onPreference() { if (media?.matches) settle() }
  function onVisibility() { if (document.hidden) settle() }
  media?.addEventListener('change', onPreference)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  function dispose() {
    disposed = true; revision++; animation?.cancel(); animation = null
    media?.removeEventListener('change', onPreference)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }
  return { change, settle, dispose }
}

// Vue transitions for non-native overlays share the dialog's restrained
// desktop/mobile vocabulary. Cancellation owns only these visual animations.
export function createOverlayTransition() {
  const jobs = new Map<HTMLElement, { stop: () => void }>()
  const lastPaint = new WeakMap<HTMLElement, { opacity: string, transform: string }>()
  function run(element: Element, done: () => void, visible: boolean) {
    const root = element as HTMLElement
    const panel = root.querySelector<HTMLElement>('[data-overlay-panel]') || root.firstElementChild as HTMLElement | null
    const rootOpacity = getComputedStyle(root).opacity
    const matrix = panel ? getComputedStyle(panel).transform : 'none'
    const continuing = jobs.has(root) || lastPaint.has(root)
    const prior = lastPaint.get(root)
    jobs.get(root)?.stop()
    lastPaint.delete(root)
    // Exiting pixels may remain for 150ms, but stale controls cannot accept
    // clicks. Reopening releases only this presentation guard, not any RPC.
    root.inert = !visible
    cancelContentMotion('overlay')
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !panel || typeof root.animate !== 'function') { done(); return }
    const mobile = window.matchMedia('(max-width: 640px)').matches
    const away = mobile ? 'translate3d(0, 24px, 0)' : 'translate3d(0, 6px, 0) scale(.99)'
    const options: KeyframeAnimationOptions = { duration: visible ? 240 : 150, easing: visible ? 'cubic-bezier(.2, .65, .25, 1)' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'both' }
    const animations = [root.animate([{ opacity: continuing ? prior?.opacity || rootOpacity : visible ? '0' : '1' }, { opacity: visible ? '1' : '0' }], options),
      panel.animate([{ transform: continuing ? prior?.transform || matrix : visible ? away : 'none' }, { transform: visible ? 'none' : away }], options)]
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let active = true
    function stop() { active = false; animations.forEach(animation => animation.cancel()); media.removeEventListener('change', changed); document.removeEventListener('visibilitychange', changed); jobs.delete(root) }
    function finish() { if (!active) return; stop(); done() }
    function changed() { if (media.matches || document.hidden) finish() }
    jobs.set(root, { stop })
    media.addEventListener('change', changed); document.addEventListener('visibilitychange', changed)
    void Promise.all(animations.map(animation => animation.finished)).then(finish, () => {})
  }
  return { enter: (element: Element, done: () => void) => run(element, done, true),
    leave: (element: Element, done: () => void) => run(element, done, false),
    cancelled: (element: Element) => {
      const root = element as HTMLElement, panel = root.querySelector<HTMLElement>('[data-overlay-panel]') || root.firstElementChild
      if (jobs.has(root)) lastPaint.set(root, { opacity: getComputedStyle(root).opacity, transform: panel ? getComputedStyle(panel).transform : 'none' })
      jobs.get(root)?.stop()
    },
    dispose: () => { for (const job of jobs.values()) job.stop() },
  }
}

// The sidebar owns one small live selection surface. A critically damped
// spring keeps its current position AND velocity when a newer link is pressed;
// it never restarts at an old row or holds navigation behind an animation.
export function createNavigationIndicatorMotion(target: () => HTMLElement | null) {
  const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let previousTime: number | null = null
  let current = 0
  let destination = 0
  let velocity = 0
  let initialized = false
  let disposed = false

  function stop() {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    previousTime = null
  }
  function paint() {
    const element = target()
    if (!element?.isConnected) return false
    element.style.transform = `translate3d(0, ${current.toFixed(3)}px, 0)`
    return true
  }
  function settle() {
    stop()
    current = destination
    velocity = 0
    paint()
  }
  function tick(now: number) {
    frame = 0
    if (disposed || !target()?.isConnected) { stop(); return }
    if (document.hidden || media?.matches) { settle(); return }
    const delta = previousTime === null ? 1 / 60 : Math.min(Math.max((now - previousTime) / 1000, 0), .05)
    previousTime = now
    // Exact critical-damping solution, independent of display refresh rate.
    // No numerical-integration bounce on a delayed frame or rapid reversal.
    const omega = 26
    const offset = current - destination
    const momentum = velocity + omega * offset
    const decay = Math.exp(-omega * delta)
    current = destination + (offset + momentum * delta) * decay
    velocity = (velocity - omega * momentum * delta) * decay
    if (Math.abs(current - destination) < .16 && Math.abs(velocity) < 3) { settle(); return }
    if (paint()) frame = window.requestAnimationFrame(tick)
  }
  function move(position: number, height: number, immediate = false) {
    if (disposed || !Number.isFinite(position) || !Number.isFinite(height) || height <= 0)
      return false
    const element = target()
    if (!element?.isConnected) return false
    element.style.height = `${height}px`
    destination = position
    if (!initialized || immediate || document.hidden || media?.matches || typeof window.requestAnimationFrame !== 'function') {
      initialized = true
      settle()
    }
    else if (!frame) frame = window.requestAnimationFrame(tick)
    return true
  }
  function onPreference() { if (media?.matches) settle() }
  function onVisibility() { if (document.hidden) settle() }
  media?.addEventListener('change', onPreference)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  function dispose() {
    disposed = true
    stop()
    media?.removeEventListener('change', onPreference)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  }
  return { move, settle, dispose }
}

// A single decorative surface per horizontal tab strip. Only geometry is
// animated; actual tab/content state stays owned by the existing component.
// Position, size AND velocity survive new intent, including wrapped rows.
export const vSlidingTabs: ObjectDirective<HTMLElement> = (() => {
  const instances = new WeakMap<HTMLElement, { update: (immediate?: boolean) => void, dispose: () => void }>()
  return {
    mounted(element) {
      const surface = document.createElement('span')
      surface.className = 'ui-tab-selection'
      surface.setAttribute('aria-hidden', 'true')
      element.append(surface)
      element.setAttribute('data-sliding-tabs', '')
      const media = window.matchMedia('(prefers-reduced-motion: reduce)')
      let frame = 0, measuring = 0, time: number | null = null, initialized = false, disposed = false
      const current = [0, 0, 0, 0], destination = [0, 0, 0, 0], velocity = [0, 0, 0, 0]
      function paint() {
        surface.style.transform = `translate3d(${current[0]!.toFixed(3)}px, ${current[1]!.toFixed(3)}px, 0)`
        surface.style.width = `${Math.max(0, current[2]!).toFixed(3)}px`
        surface.style.height = `${Math.max(0, current[3]!).toFixed(3)}px`
      }
      function settle() {
        if (frame) window.cancelAnimationFrame(frame)
        frame = 0; time = null
        destination.forEach((value, i) => { current[i] = value; velocity[i] = 0 })
        paint()
      }
      function tick(now: number) {
        frame = 0
        if (disposed || !element.isConnected) return
        if (media.matches || document.hidden) { settle(); return }
        const dt = time === null ? 1 / 60 : Math.max(0, Math.min((now - time) / 1000, .05)); time = now
        const omega = 28, decay = Math.exp(-omega * dt)
        for (let i = 0; i < 4; i++) {
          const offset = current[i]! - destination[i]!, momentum = velocity[i]! + omega * offset
          current[i] = destination[i]! + (offset + momentum * dt) * decay
          velocity[i] = (velocity[i]! - omega * momentum * dt) * decay
        }
        if (current.every((value, i) => Math.abs(value - destination[i]!) < .16 && Math.abs(velocity[i]!) < 3)) { settle(); return }
        paint(); frame = window.requestAnimationFrame(tick)
      }
      function update(immediate = false) {
        measuring = 0
        if (disposed) return
        const active = element.querySelector<HTMLElement>(':scope > .ui-tab[data-active="true"]')
        if (!active || !active.getClientRects().length) { surface.removeAttribute('data-ready'); return }
        const parent = element.getBoundingClientRect(), box = active.getBoundingClientRect()
        const values = [box.left - parent.left + element.scrollLeft - element.clientLeft,
          box.top - parent.top + element.scrollTop - element.clientTop, box.width, box.height]
        values.forEach((value, index) => { destination[index] = value })
        surface.setAttribute('data-ready', 'true')
        if (!initialized || immediate || media.matches || document.hidden) { initialized = true; settle() }
        else if (!frame) frame = window.requestAnimationFrame(tick)
      }
      // ResizeObserver also delivers an initial notification for newly observed
      // tabs. It must retarget the spring, not settle it at the destination and
      // erase the first click's travel (or a resize during rapid reversal).
      function queue() { if (!measuring && !disposed) measuring = window.requestAnimationFrame(() => update()) }
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue)
      const observedTabs = new Set<HTMLElement>()
      function observeTabs() {
        const tabs = new Set(element.querySelectorAll<HTMLElement>(':scope > .ui-tab'))
        for (const tab of observedTabs) if (!tabs.has(tab)) { resize?.unobserve(tab); observedTabs.delete(tab) }
        for (const tab of tabs) if (!observedTabs.has(tab)) { resize?.observe(tab); observedTabs.add(tab) }
      }
      resize?.observe(element)
      observeTabs()
      const observer = new MutationObserver(records => {
        if (records.every(record => record.target === surface || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node === surface))) return
        if (records.some(record => record.type === 'childList')) observeTabs()
        update()
      })
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active', 'class'] })
      function onPreference() { if (media.matches) update(true) }
      function onVisibility() { if (document.hidden) settle() }
      media.addEventListener('change', onPreference)
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('resize', queue)
      instances.set(element, { update, dispose() {
        disposed = true; if (frame) window.cancelAnimationFrame(frame); if (measuring) window.cancelAnimationFrame(measuring)
        observer.disconnect(); resize?.disconnect(); media.removeEventListener('change', onPreference)
        document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('resize', queue)
        surface.remove(); element.removeAttribute('data-sliding-tabs')
      } })
      update(true)
    },
    updated(element) { instances.get(element)?.update() },
    beforeUnmount(element) { instances.get(element)?.dispose(); instances.delete(element) },
  }
})()

// Enhance only explicitly opted-in native details. No content is cloned or
// cached; hidden panels retain the browser's original details semantics.
export const vFoldMotion: ObjectDirective<HTMLDetailsElement> = (() => {
  const instances = new WeakMap<HTMLDetailsElement, () => void>()
  return {
    mounted(element) {
      const summary = element.querySelector<HTMLElement>(':scope > summary')
      if (!summary) return
      const media = window.matchMedia('(prefers-reduced-motion: reduce)')
      const originalOverflow = element.style.overflow
      let animation: Animation | null = null, revision = 0, desired = element.open, disposed = false
      function clear() { animation?.cancel(); animation = null; element.style.overflow = originalOverflow }
      function complete() {
        revision++; clear(); element.open = desired
        summary!.setAttribute('aria-expanded', String(desired))
      }
      function toggle(event: MouseEvent) {
        const clicked = (event.target as Element).closest('summary')
        if (clicked !== summary || event.defaultPrevented) return
        event.preventDefault()
        const start = element.getBoundingClientRect().height
        desired = !desired
        const request = ++revision
        clear()
        summary!.setAttribute('aria-expanded', String(desired))
        if (!desired && element.contains(document.activeElement) && !summary!.contains(document.activeElement)) summary!.focus({ preventScroll: true })
        if (media.matches || document.hidden || typeof element.animate !== 'function') { element.open = desired; return }
        // Measure both real native states synchronously in one task. Native
        // toggle events coalesce and no hidden game component is kept alive.
        element.open = desired
        const end = element.getBoundingClientRect().height
        element.open = true
        element.style.overflow = 'hidden'
        animation = element.animate([{ height: `${start}px` }, { height: `${end}px` }],
          { duration: desired ? 220 : 160, easing: 'cubic-bezier(.2, .65, .25, 1)', fill: 'both' })
        animation.finished.then(() => { if (!disposed && request === revision) complete() }, () => {})
      }
      function onToggle() { if (!animation) { desired = element.open; summary!.setAttribute('aria-expanded', String(desired)) } }
      function changed() { if (media.matches || document.hidden) complete() }
      summary.setAttribute('aria-expanded', String(desired))
      element.addEventListener('click', toggle)
      element.addEventListener('toggle', onToggle)
      media.addEventListener('change', changed)
      document.addEventListener('visibilitychange', changed)
      instances.set(element, () => {
        disposed = true; revision++; clear()
        element.removeEventListener('click', toggle); element.removeEventListener('toggle', onToggle)
        media.removeEventListener('change', changed); document.removeEventListener('visibilitychange', changed)
        summary.removeAttribute('aria-expanded')
      })
    },
    beforeUnmount(element) { instances.get(element)?.(); instances.delete(element) },
  }
})()

// A workspace journey finishes only when both the authorized route has painted
// and its decorative animation has ended. Late/canceled events cannot release
// another journey or any account/game operation state.
export function createWorkspaceTravel(onComplete: () => void = () => {}) {
  const active = ref<{ id: number, destination: 'farm' | 'ranch', path: string, arrived: boolean, painted: boolean } | null>(null)
  let disposed = false
  function finish() {
    if (!active.value?.arrived || !active.value.painted) return
    active.value = null
    onComplete()
  }
  return {
    active,
    begin(id: number, destination: 'farm' | 'ranch', path: string) {
      if (disposed || !Number.isSafeInteger(id) || id < 1) return
      active.value = { id, destination, path, arrived: false, painted: false }
    },
    painted(id: number, path: string) {
      if (active.value?.id !== id || active.value.path !== path) return
      active.value.painted = true
      finish()
    },
    arrived(id: number) {
      if (active.value?.id !== id) return
      active.value.arrived = true
      finish()
    },
    cancel() { active.value = null },
    dispose() { disposed = true; active.value = null },
  }
}

// Optimistic navigation feedback is separate from committed page state.
// Only the newest request may restore it on a redirect/rejection; a stale
// completion never steals selection from a newer click or browser navigation.
export function createNavigationSelection(
  currentPath: () => string, navigate: (path: string) => Promise<unknown>, feedback: () => void,
) {
  const selected = ref(currentPath())
  let intent = 0
  let pending: string | null = null
  let disposed = false
  function show(path: string) { selected.value = path; feedback() }
  function restore(request: number) {
    if (disposed || request !== intent) return
    pending = null
    show(currentPath())
  }
  function select(path: string): Promise<void> {
    if (disposed) return Promise.resolve()
    const request = ++intent
    pending = path
    show(path)
    // Duplicate-current navigation also cancels an older importing intent.
    try { return navigate(path).then(() => restore(request), () => restore(request)) }
    catch { restore(request); return Promise.resolve() }
  }
  function sync(path: string) {
    if (!disposed && (!pending || path === pending)) show(path)
  }
  function dispose() { disposed = true; intent++; pending = null }
  return { selected, select, sync, dispose }
}

export function createContentMotion(target: () => HTMLElement | null, kind: MotionKind = 'page') {
  const owner = Symbol(kind)
  const panelScroll = kind === 'panel' ? createPanelScrollContinuity(target) : null
  let disposed = false
  let intent = 0

  function change(update: () => void | Promise<void>, options: MotionOptions = {}): Promise<boolean> {
    const version = ++intent
    const valid = () => !disposed && version === intent && (options.valid?.() ?? true)
    async function applyUpdate(commit: () => void | Promise<void>) {
      panelScroll?.capture()
      try { await commit(); await nextTick() }
      finally { panelScroll?.release() }
    }
    if (!valid()) {
      options.onAbort?.()
      return Promise.resolve(false)
    }
    const retargeted = activeJob?.owner === owner ? activeJob.retarget?.(update, options, valid) : null
    if (retargeted) return retargeted
    // A third destination cannot reuse the two native snapshot surfaces. Finish
    // the current visual from its current position before capturing the latest
    // intent, instead of skipping to a full-frame endpoint on every new click.
    const queuedFinish = activeJob?.owner === owner ? activeJob.finish?.() : null
    if (queuedFinish) return queuedFinish.then(() => {
      if (!valid()) { options.onAbort?.(); return false }
      return change(update, options)
    })
    cancelContentMotion('superseded')
    const candidate = target()
    const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    if (!candidate?.isConnected || typeof document === 'undefined' || document.hidden || media?.matches || hasVisibleOverlay())
      return Promise.resolve().then(() => valid() ? applyUpdate(update) : options.onAbort?.()).then(valid)

    const element = candidate
    const root = document.documentElement
    const previousName = element.style.viewTransitionName
    const previousRootName = root.style.viewTransitionName
    const previousKind = root.getAttribute('data-content-motion')
    const previousDirection = root.getAttribute('data-content-direction')
    let namesOwned = false
    let native: NativeTransition | undefined
    let animation: Animation | undefined
    let observer: MutationObserver | undefined
    let retargeting = false
    let retargetRequest = 0
    let currentFrom = options.fromKey
    let currentTo = options.toKey
    let retargetAbort: (() => void) | undefined
    let continuation: Promise<void> | null = null
    const snapshotEndpoints = new Map<Animation, { from: string, to: string }>()
    let snapshotReversed = false
    let captureTimer: ReturnType<typeof setTimeout> | undefined
    let canceled = false
    let committed = false
    let commitPromise: Promise<void> | undefined
    let resolveDone!: (value: boolean) => void
    let rejectDone!: (reason: unknown) => void
    const done = new Promise<boolean>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })

    function snapshotAnimations() {
      return document.getAnimations().filter(item => ['content-snapshot-in', 'content-snapshot-out'].includes((item as CSSAnimation).animationName)
        && Number(item.currentTime) > 0 && Number(item.currentTime) < Number(item.effect?.getTiming().duration))
    }
    function continueSnapshots(animations: Animation[], reverse: boolean, duration: number) {
      const destinations = animations.map(item => {
        const effect = item.effect as KeyframeEffect | null
        if (!effect || typeof effect.setKeyframes !== 'function' || typeof effect.updateTiming !== 'function') return null
        if (!snapshotEndpoints.has(item)) {
          const frames = effect.getKeyframes()
          snapshotEndpoints.set(item, { from: String(frames[0]!.transform || 'none'), to: String(frames[frames.length - 1]!.transform || 'none') })
        }
        const endpoints = snapshotEndpoints.get(item)!
        const toOriginalFrom = reverse ? !snapshotReversed : snapshotReversed
        const pseudo = (item as CSSAnimation).animationName === 'content-snapshot-in' ? '::view-transition-new(farm-content)' : '::view-transition-old(farm-content)'
        return { item, effect, start: getComputedStyle(root, pseudo).transform, end: toOriginalFrom ? endpoints.from : endpoints.to }
      })
      if (destinations.some(value => value === null)) return null
      // Snapshot both exact current transforms before changing either timeline.
      // The same two surfaces remain joined, without a recapture or game DOM.
      for (const value of destinations) {
        const { item, effect, start, end } = value!
        effect.setKeyframes([{ transform: start || 'none' }, { transform: end }])
        effect.updateTiming({ duration, easing: 'cubic-bezier(.24, .08, .2, 1)', fill: 'both' })
        item.currentTime = 0
        item.playbackRate = 1
        item.play()
      }
      if (reverse) snapshotReversed = !snapshotReversed
      return Promise.all(animations.map(item => item.finished.catch(() => {}))).then(() => {})
    }
    const job: MotionJob = { owner, cancel,
      navigate: () => { if (!committed || retargeting) cancel('superseded') },
      finish: () => {
        if (!native || !committed || retargeting || canceled) return null
        if (continuation) return continuation
        const animations = snapshotAnimations()
        if (animations.length !== 2) return null
        const pending = continueSnapshots(animations, false, 110)
        if (!pending) return null
        continuation = pending.then(() => { if (activeJob === job) { native?.skipTransition(); cleanup() } })
        return continuation
      },
      retarget: (nextUpdate, next, nextValid) => {
        if (!native || !committed || retargeting || continuation || canceled || !currentFrom || !currentTo
          || next.fromKey !== currentTo || next.toKey !== currentFrom)
          return null
        const animations = document.getAnimations().filter(item => ['content-snapshot-in', 'content-snapshot-out'].includes((item as CSSAnimation).animationName)
          && Number(item.currentTime) > 0 && Number(item.currentTime) < Number(item.effect?.getTiming().duration))
        if (animations.length !== 2) return null
        const request = ++retargetRequest
        retargeting = true
        retargetAbort = next.onAbort
        animations.forEach(item => item.pause())
        return (async () => {
          if (!nextValid()) { cancel('superseded'); return false }
          await applyUpdate(nextUpdate)
          if (canceled || activeJob !== job) return true
          currentFrom = next.fromKey
          currentTo = next.toKey
          retargeting = false
          retargetAbort = undefined
          // Both page and panel reversals resume from their exact painted
          // position with forward damping, never a reversed ease-out brake.
          const dampedReturn = continueSnapshots(animations, true, 260)
          if (!dampedReturn) animations.forEach(item => item.reverse())
          ;(dampedReturn || Promise.all(animations.map(item => item.finished.catch(() => {})))).then(() => {
            if (request === retargetRequest && activeJob === job) { native?.skipTransition(); cleanup() }
          })
          return true
        })().catch((error) => { cancel('superseded'); throw error })
      },
    }
    activeJob = job
    function releasePaintNames() {
      if (activeJob !== job || !namesOwned)
        return
      namesOwned = false
      element.style.viewTransitionName = previousName
      root.style.viewTransitionName = previousRootName
      if (previousKind === null) root.removeAttribute('data-content-motion')
      else root.setAttribute('data-content-motion', previousKind)
      if (previousDirection === null) root.removeAttribute('data-content-direction')
      else root.setAttribute('data-content-direction', previousDirection)
    }
    function cleanup() {
      if (captureTimer) clearTimeout(captureTimer)
      observer?.disconnect()
      media?.removeEventListener('change', onPreference)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('pointerdown', onInteraction, true)
      document.removeEventListener('wheel', onInteraction, true)
      document.removeEventListener('keydown', onInteraction, true)
      releasePaintNames()
      if (activeJob === job)
        activeJob = null
    }
    function commit(): Promise<void> {
      if (commitPromise)
        return commitPromise
      if (!valid() || canceled) {
        options.onAbort?.()
        resolveDone(false)
        return Promise.resolve()
      }
      committed = true
      if (captureTimer) clearTimeout(captureTimer)
      try {
        // Invoke once. A skipped native transition still invokes its callback;
        // neither an animation failure nor a newer navigation may replay it.
        commitPromise = applyUpdate(update).then(() => { resolveDone(true) })
      }
      catch (error) { commitPromise = Promise.reject(error) }
      commitPromise.catch((error) => { rejectDone(error); cleanup() })
      return commitPromise
    }
    function cancel(reason: CancelReason) {
      if (canceled)
        return
      const invalidate = ['superseded', 'context', 'unmount'].includes(reason)
      // Visual-only interruption must not strand a router guard. Newer intent,
      // account changes and disposal instead invalidate an uncommitted update.
      if (!invalidate && !committed)
        void commit()
      canceled = true
      retargetRequest++
      native?.skipTransition()
      animation?.cancel()
      if (invalidate) {
        retargetAbort?.()
        options.onAbort?.()
        if (!committed) resolveDone(false)
      }
      cleanup()
    }
    function onPreference() { if (media?.matches) cancel('reduced') }
    function onVisibility() { if (document.hidden) cancel('hidden') }
    function onResize() { cancel('overlay') }
    function checkOverlay(records: MutationRecord[]) {
      // The live sidebar spring paints one transform each frame. It cannot
      // create an overlay; don't scan/layout the entire page for these pixels.
      if (records.every(record => record.type === 'attributes' && record.attributeName === 'style'
        && ((record.target as Element).classList?.contains('sidebar-nav-indicator') || (record.target as Element).classList?.contains('ui-tab-selection')))) return
      if (hasVisibleOverlay()) cancel('overlay')
    }
    function onInteraction(event: Event) {
      const target = event.target as Element | null
      // Navigation presses can retarget/reverse a painted transition. Other
      // interactions reveal live controls immediately before they run.
      if ((event.type === 'pointerdown' || event.type === 'keydown')
        && target?.closest?.('.sidebar-nav-link, [role="tab"], [data-settings-tab], [data-motion-nav]')) return
      cancel('overlay')
    }
    function fallback() {
      if (activeJob !== job || canceled || !valid() || hasVisibleOverlay()) {
        cleanup()
        return
      }
      const entry = element.querySelector<HTMLElement>('[data-motion-entry]') || element
      if (typeof entry.animate !== 'function') {
        cleanup()
        return
      }
      try {
        const offset = (options.direction || 1) < 0 ? '-100%' : '100%'
        animation = entry.animate([
          { transform: kind === 'page' ? `translate3d(0, ${offset}, 0)` : `translate3d(${offset}, 0, 0)` },
          { transform: 'none' },
        ], { duration: kind === 'page' ? 460 : 420, easing: 'cubic-bezier(.24, .08, .2, 1)' })
        animation.finished.then(cleanup, cleanup)
      }
      catch { cleanup() /* Animation is optional; the update already ran once. */ }
    }

    media?.addEventListener('change', onPreference)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', onResize)
    // A new press/scroll/key always reveals the live page before handling the
    // interaction; painted snapshots must not hide real-time input feedback.
    document.addEventListener('pointerdown', onInteraction, true)
    document.addEventListener('wheel', onInteraction, { capture: true, passive: true })
    document.addEventListener('keydown', onInteraction, true)
    if (typeof MutationObserver !== 'undefined' && document.body) {
      observer = new MutationObserver(checkOverlay)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'open', 'hidden', 'aria-modal'] })
    }
    const start = (document as Document & { startViewTransition?: (callback: () => Promise<void>) => NativeTransition }).startViewTransition
    if (typeof start !== 'function') {
      void commit().then(fallback, cleanup)
      return done
    }

    // Only the stable, clipped content viewport is named. Header/sidebar remain
    // live, and there is no default whole-document snapshot above their controls.
    namesOwned = true
    root.style.viewTransitionName = 'none'
    element.style.viewTransitionName = 'farm-content'
    root.setAttribute('data-content-motion', kind)
    root.setAttribute('data-content-direction', (options.direction || 1) < 0 ? 'back' : 'forward')
    try {
      native = start.call(document, commit)
      native.ready.then(() => { if (captureTimer) clearTimeout(captureTimer) }, () => {
        // Capture can be unavailable in a background/embedded browser. Release
        // the update once and fall back on its new DOM, never replay the update.
        if (canceled || activeJob !== job) return
        releasePaintNames()
        void commit().then(fallback, cleanup)
      })
      native.updateCallbackDone.catch(() => { /* Rejection is handled by commit. */ })
      native.finished.then(cleanup, cleanup)
      // Do not let an unavailable compositor indefinitely hold a navigation.
      if (!committed) captureTimer = setTimeout(() => cancel('capture-timeout'), 120)
    }
    catch {
      releasePaintNames()
      void commit().then(fallback, cleanup)
    }
    return done
  }

  function cancel(reason: CancelReason = 'superseded') {
    if (reason === 'context') panelScroll?.dispose()
    if (activeJob?.owner === owner) {
      if (reason === 'navigation' && activeJob.navigate) activeJob.navigate()
      else activeJob.cancel(reason)
    }
  }
  function dispose() {
    disposed = true
    intent++
    cancel('unmount')
    panelScroll?.dispose()
  }
  return { change, cancel, dispose }
}

export function useContentMotion(target: () => HTMLElement | null, kind: MotionKind = 'page') {
  const motion = createContentMotion(target, kind)
  onBeforeUnmount(motion.dispose)
  return motion
}

// Keep an outer page's reading position while a real panel is replaced by its
// loading/shorter state. Hold geometry only, never old DOM or game responses.
// The remaining height floor is just enough for the current viewport; it is
// released once an intentional scroll fits the new natural content height.
const panelScrollOwners = new WeakMap<HTMLElement, { minHeight: string, anchor: string, handoff: () => void }>()
export function createPanelScrollContinuity(target: () => HTMLElement | null) {
  let element: HTMLElement | null = null
  let scroller: HTMLElement | null = null
  let originalMinHeight = ''
  let originalAnchor = ''
  let holding = false
  let resize: ResizeObserver | null = null
  const owner = { minHeight: '', anchor: '', handoff: () => clear(false) }
  function clear(restore = true) {
    resize?.disconnect(); resize = null
    scroller?.removeEventListener('scroll', onScroll)
    if (element && restore && panelScrollOwners.get(element) === owner) {
      element.style.minHeight = originalMinHeight; element.style.overflowAnchor = originalAnchor
      panelScrollOwners.delete(element)
    }
    element = scroller = null
    holding = false
  }
  function attach() {
    const next = target()
    const parent = next?.closest?.<HTMLElement>('[data-page-viewport]') || null
    if (!next?.isConnected || !parent?.isConnected) return false
    if (next !== element || parent !== scroller) {
      clear()
      // Category and filter strips may share this exact viewport. Transfer its
      // geometry lease without restoring/shrinking between measurements, so a
      // second controller never mistakes an old temporary floor for CSS state.
      const previous = panelScrollOwners.get(next)
      originalMinHeight = previous ? previous.minHeight : next.style.minHeight
      originalAnchor = previous ? previous.anchor : next.style.overflowAnchor
      previous?.handoff()
      element = next; scroller = parent
      owner.minHeight = originalMinHeight; owner.anchor = originalAnchor
      panelScrollOwners.set(next, owner)
      parent.addEventListener('scroll', onScroll, { passive: true })
      const entry = next.querySelector<HTMLElement>(':scope > [data-motion-entry]')
      if (entry && typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(onScroll)
        resize.observe(entry)
      }
    }
    return true
  }
  function visibleHeight() {
    if (!element || !scroller) return 0
    return Math.max(0, scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight - element.getBoundingClientRect().top)
  }
  function capture() {
    if (!attach() || !element) return
    holding = true
    element.style.overflowAnchor = 'none'
    element.style.minHeight = `${Math.ceil(Math.max(element.getBoundingClientRect().height, visibleHeight()))}px`
  }
  function release() {
    if (!holding || !element?.isConnected || !scroller?.isConnected) return
    element.style.minHeight = `${Math.ceil(visibleHeight())}px`
    onScroll()
  }
  function onScroll() {
    if (!holding || !element || !scroller) return
    const entry = element.querySelector<HTMLElement>(':scope > [data-motion-entry]')
    if (!entry) return
    const extra = Math.max(0, element.getBoundingClientRect().height - entry.getBoundingClientRect().height)
    const naturalMaximum = Math.max(0, scroller.scrollHeight - extra - scroller.clientHeight)
    if (scroller.scrollTop <= naturalMaximum + 1) {
      element.style.minHeight = originalMinHeight
      element.style.overflowAnchor = originalAnchor
      holding = false
    }
  }
  return { capture, release, dispose: clear }
}

// Manual activation keeps keyboard focus separate from network-backed content.
// Arrow keys move within this tablist without scrolling the outer page.
export function moveSlidingTabFocus(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const button = event.currentTarget as HTMLElement | null
  const list = button?.closest<HTMLElement>('[role="tablist"]')
  const tabs = [...(list?.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]:not(:disabled)') || [])]
  const current = tabs.indexOf(button as HTMLButtonElement)
  if (current < 0 || !tabs.length) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus({ preventScroll: true })
}

// Horizontal tab selection only changes the caller's state. Existing watchers
// still own their original read/cleanup contract; there are no extra reads.
export function useSlidingTabs<T extends string | number>(
  selection: Ref<T>, target: () => HTMLElement | null, order: () => readonly T[],
  context?: () => unknown,
) {
  const motion = useContentMotion(target, 'panel')
  // Navigation feedback updates immediately; the real content selection still
  // changes only once inside capture/commit, so no old game panel stays mounted.
  const selected = ref(selection.value) as Ref<T>
  let intent = 0
  let pendingSelection = false
  let committingSelection = false
  watch(selection, value => {
    if (!committingSelection && pendingSelection) { intent++; motion.cancel('context') }
    selected.value = value
    pendingSelection = false
  }, { flush: 'sync' })
  if (context) watch(context, () => { intent++; pendingSelection = false; selected.value = selection.value; motion.cancel('context') }, { flush: 'sync' })
  function select(next: T) {
    if (next === selection.value && next === selected.value) return
    const request = ++intent
    pendingSelection = true
    selected.value = next
    if (next === selection.value) { pendingSelection = false; motion.cancel('superseded'); return }
    const snapshot = context?.()
    const previous = selection.value
    const keys = order()
    let applied = false
    void motion.change(() => {
      applied = true
      committingSelection = true
      try { selection.value = next }
      finally { committingSelection = false; pendingSelection = false }
    }, {
      direction: keys.indexOf(next) < keys.indexOf(previous) ? -1 : 1,
      fromKey: String(previous), toKey: String(next),
      valid: () => request === intent && (applied || selection.value === previous) && (!context || context() === snapshot),
      onAbort: () => { if (request === intent) { pendingSelection = false; selected.value = selection.value } },
    }).catch(() => { if (request === intent) { pendingSelection = false; selected.value = selection.value } })
  }
  return { select, selected, cancel: motion.cancel }
}
