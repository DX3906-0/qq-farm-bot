import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import type { Ref } from 'vue'

const PREFIX = 'farm-ui-v1:'
const MAX_ENTRIES = 64
const MAX_BYTES = 8192
const memory = new Map<string, Record<string, unknown>>()
const positions = new Map<string, number>()
let storageScope: string | null = null

// Only allow explicitly named presentation fields. No game snapshots, request
// confirmations, selections or credentials ever belong in this storage.
export function readAccountUiState(accountId: string, page: string): Record<string, unknown> {
  syncStorageScope()
  const key = stateKey(accountId, page)
  if (!key)
    return {}
  try {
    const raw = sessionStorage.getItem(key)
    if (raw && raw.length <= MAX_BYTES) {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value))
        return presentationFields(value)
    }
  }
  catch { /* Memory fallback, including restricted/private browsing. */ }
  return { ...(memory.get(key) || {}) }
}

export function writeAccountUiState(accountId: string, page: string, fields: Record<string, unknown>) {
  syncStorageScope()
  const key = stateKey(accountId, page)
  if (!key)
    return
  const safe = presentationFields(fields)
  memory.delete(key)
  memory.set(key, safe)
  trim(memory)
  try {
    sessionStorage.setItem(key, JSON.stringify(safe))
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((item): item is string => !!item?.startsWith(PREFIX) && item !== `${PREFIX}scope`)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
      sessionStorage.removeItem(old)
  }
  catch { /* Do not block UI when session storage is disabled/full. */ }
}
function presentationFields(fields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).filter(([name, value]) =>
    ['tab', 'category', 'search', 'sort', 'density', 'filter', 'page'].includes(name)
    && (typeof value === 'string' && value.length <= 200 || typeof value === 'number' && Number.isFinite(value))))
}
function syncStorageScope() {
  let scope = ''
  try { scope = String(JSON.parse(localStorage.getItem('user_info') || 'null')?.username || '').slice(0, 100) }
  catch { /* No credential is read or persisted; anonymous UI uses its own scope. */ }
  if (storageScope !== scope) {
    storageScope = scope
    memory.clear()
    positions.clear()
    try {
      // Only a public username scopes presentation preferences. Reopening the
      // same session retains UI, changing login identity clears it.
      const previous = sessionStorage.getItem(`${PREFIX}scope`)
      if (previous !== null && previous !== scope) {
        const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
          .filter((item): item is string => !!item?.startsWith(PREFIX))
        keys.forEach(item => sessionStorage.removeItem(item))
      }
      sessionStorage.setItem(`${PREFIX}scope`, scope)
    }
    catch { /* Storage is optional. */ }
  }
}
function stateKey(accountId: string, page: string) {
  if (!accountId || !page)
    return ''
  return `${PREFIX}${encodeURIComponent(accountId)}:${page}`
}
function trim(map: Map<string, unknown>) {
  while (map.size > MAX_ENTRIES)
    map.delete(map.keys().next().value!)
}

export function useAccountScroll(accountId: Ref<string>, view: Ref<string>, container: Ref<HTMLElement | null>) {
  let disposed = false
  let restoring = false
  let ticket = 0
  let pendingPosition: number | null = null
  let resize: ResizeObserver | undefined
  const key = () => stateKey(String(accountId.value || ''), `scroll:${view.value}`)
  function save(customKey = key()) {
    syncStorageScope()
    if (!customKey || !container.value || restoring || pendingPosition !== null)
      return
    positions.delete(customKey)
    positions.set(customKey, Math.max(0, container.value.scrollTop))
    trim(positions)
  }
  function applyPosition() {
    const element = container.value
    if (!element || pendingPosition === null)
      return
    element.scrollTop = Math.min(pendingPosition, Math.max(0, element.scrollHeight - element.clientHeight))
    // Data/initial skeleton may not yet be tall enough. ResizeObserver retries
    // only on local layout changes, never by polling or asking the game again.
    if (element.scrollHeight - element.clientHeight >= pendingPosition - 1)
      pendingPosition = null
  }
  async function restore() {
    syncStorageScope()
    const version = ++ticket
    const wanted = positions.get(key()) || 0
    restoring = true
    pendingPosition = wanted
    await nextTick()
    if (disposed || version !== ticket)
      return
    applyPosition()
    await nextTick()
    if (version === ticket)
      restoring = false
  }
  function cancelRestore() {
    pendingPosition = null
    restoring = false
  }
  function onUserScroll() {
    if (!restoring && pendingPosition === null)
      save()
  }
  watch([accountId, view], (_next, previous) => {
    if (previous && previous[0])
      save(stateKey(String(previous[0]), `scroll:${previous[1]}`))
    void restore()
  }, { flush: 'pre' })
  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(() => {
        if (pendingPosition !== null && !disposed) {
          restoring = true
          applyPosition()
          void nextTick(() => { restoring = false })
        }
      })
      if (container.value)
        resize.observe(container.value)
      if (container.value?.firstElementChild)
        resize.observe(container.value.firstElementChild)
    }
    void restore()
  })
  onBeforeUnmount(() => {
    save()
    disposed = true
    ticket++
    resize?.disconnect()
  })
  return { onUserScroll, cancelRestore, restore }
}
