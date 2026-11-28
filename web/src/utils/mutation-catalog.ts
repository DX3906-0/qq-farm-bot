export interface MutationEffect {
  id: number
  name: string
  image: string
  effect: string
  description: string
  effectType?: 'yield' | 'price' | 'produce' | 'other'
  probabilities: Array<{ rarity: number | null, percent: number }>
}
export interface MutationSeries {
  id: number
  name: string
  description: string
  groups: Array<{ name: string, probability: number, guarantee: number }>
  items: Array<{ id: number, name: string, image: string }>
}
export interface MutationCatalog {
  normal: MutationEffect[]
  decoration: MutationEffect[]
  collections: MutationSeries[]
  note: string
  rarityNames?: Record<string, string>
  source?: { repository?: string, commit?: string }
  bundle?: { revision: string, collectionsCommit: string, origin: string, files: Record<string, { sha256: string, origin: string }> }
}
export type EffectFilter = 'all' | 'yield' | 'price' | 'produce' | 'other' | 'public' | 'unpublished'
export function parseMutationCatalog(value: unknown): MutationCatalog | null {
  if (!value || typeof value !== 'object') return null
  const input = value as MutationCatalog
  if (!Array.isArray(input.normal) || !Array.isArray(input.decoration) || !Array.isArray(input.collections)
    || input.normal.length + input.decoration.length + input.collections.length === 0) return null
  const named = (item: { id: number, name: string }) => Number.isSafeInteger(item?.id) && item.id > 0 && typeof item.name === 'string' && !!item.name.trim()
  const percent = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100
  if ([...input.normal, ...input.decoration].some(item => !named(item) || typeof item.image !== 'string'
    || typeof item.effect !== 'string' || typeof item.description !== 'string' || !Array.isArray(item.probabilities)
    || item.probabilities.some(probability => !probability || !percent(probability.percent) || probability.rarity != null && (!Number.isInteger(probability.rarity) || probability.rarity <= 0)))) return null
  if (input.collections.some(series => !named(series) || !Array.isArray(series.groups) || !Array.isArray(series.items)
    || series.items.some(item => !named(item)) || series.groups.some(group => !group || typeof group.name !== 'string' || !percent(group.probability)
      || !Number.isSafeInteger(group.guarantee) || group.guarantee < 0))) return null
  return input
}
export function bundledMutationCatalog() {
  return parseMutationCatalog(typeof __MUTATION_CATALOG__ === 'undefined' ? null : __MUTATION_CATALOG__)
}
export function effectCategory(item: MutationEffect): Exclude<EffectFilter, 'all' | 'public' | 'unpublished'> {
  if (item.effectType) return item.effectType
  if (item.effect?.startsWith('产量×')) return 'yield'
  if (item.effect?.startsWith('售价×')) return 'price'
  if (item.effect?.startsWith('产出')) return 'produce'
  return 'other'
}
const words = (query: string) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
const includesAll = (text: string, query: string) => words(query).every(word => text.toLocaleLowerCase().includes(word))
export function filterMutationEffects(items: MutationEffect[], query: string, category: EffectFilter) {
  return items.filter(item => includesAll(`${item.name} ${item.effect || ''} ${item.description || ''}`, query)
    && (category === 'all' || category === 'public' && item.probabilities.length > 0
      || category === 'unpublished' && item.probabilities.length === 0 || effectCategory(item) === category))
}
export function filterMutationSeries(items: MutationSeries[], query: string, category: EffectFilter) {
  return items.filter(item => includesAll(`${item.name} ${item.description || ''} ${item.groups.map(group => group.name).join(' ')} ${item.items.map(value => value.name).join(' ')}`, query)
    && (category === 'all' || category === 'public' && item.groups.length > 0 || category === 'unpublished' && item.groups.length === 0))
}
export function cropRarityLabel(rarity: number | null, names: Record<string, string> | undefined) {
  if (rarity == null) return '公开概率'
  const name = names && Object.prototype.hasOwnProperty.call(names, String(rarity)) ? names[String(rarity)] : ''
  return name ? `${name}作物` : `作物品质 ${rarity}`
}
