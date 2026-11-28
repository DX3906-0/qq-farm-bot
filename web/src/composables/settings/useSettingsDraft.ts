import { computed, shallowRef } from 'vue'
import type { InjectionKey } from 'vue'

export function settingsFingerprint(value: unknown): string {
  function ordered(input: any): any {
    if (Array.isArray(input)) return input.map(ordered)
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, ordered(input[key])]))
    return input
  }
  return JSON.stringify(ordered(value)) ?? ''
}
export function copySettings<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

// Readback may include server-derived keys (for example interval aliases).
// Every submitted key must actually be present and equal; missing fields must
// not be "confirmed" by a UI default. Arrays retain their order and identity.
export function settingsPatchMatches(actual: unknown, submitted: unknown): boolean {
  if (submitted === undefined) return true
  if (Array.isArray(submitted)) return Array.isArray(actual) && settingsFingerprint(actual) === settingsFingerprint(submitted)
  if (submitted && typeof submitted === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(submitted).every(([key, value]) => value === undefined
      || Object.prototype.hasOwnProperty.call(actual, key) && settingsPatchMatches((actual as Record<string, unknown>)[key], value))
  }
  return Object.is(actual, submitted)
}

// Only the current editor's in-memory baseline, never disk/session storage,
// account/game caches or persisted passwords. A save acknowledgement alone
// must not rebase a draft; the owner passes its confirmed readback instead.
export function createSettingsDraft<T>(read: () => T, apply: (value: T) => void) {
  const baseline = shallowRef<T | null>(null)
  const ready = shallowRef(false)
  const dirty = computed(() => ready.value && baseline.value !== null && settingsFingerprint(read()) !== settingsFingerprint(baseline.value))
  function rebase(value = read()) { baseline.value = copySettings(value); ready.value = true }
  function reset() { if (baseline.value !== null) apply(copySettings(baseline.value)) }
  function clear() { baseline.value = null; ready.value = false }
  function confirmed() { return baseline.value === null ? null : copySettings(baseline.value) }
  return { dirty, ready, rebase, reset, clear, confirmed }
}

export interface SettingsDraftParticipant {
  label: string
  scope: 'account' | 'user' | 'page'
  dirty: () => boolean
  saving: () => boolean
  reset: () => void
}
export interface SettingsDraftRegistry {
  register: (key: string, participant: SettingsDraftParticipant) => () => void
}
export const SETTINGS_DRAFT_REGISTRY: InjectionKey<SettingsDraftRegistry> = Symbol('settings-draft-registry')
