<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  land: any
  playerLevel?: number | null
  connected?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const info = computed(() => props.land?.landInfo)
const metrics = [
  { key: 'yieldBonus', label: '产量加成', unit: '%' },
  { key: 'growthReduction', label: '成长提速', unit: '%' },
  { key: 'expBonus', label: '经验加成', unit: '%' },
  { key: 'mutantMultiplier', label: '变异概率', unit: '倍' },
  { key: 'resonanceBonus', label: '共鸣加成', unit: '%' },
]

function metric(level: any, key: string, unit: string) {
  if (!level)
    return '—'
  const value = Number(level[key]) || 0
  return key === 'mutantMultiplier' && !value ? '无' : `${value}${unit}`
}

function integer(value: unknown): bigint | null {
  const text = String(value ?? '')
  return /^\d+$/.test(text) ? BigInt(text) : null
}

const levelMet = computed(() => {
  if (props.connected === false)
    return false
  if (props.playerLevel == null || info.value?.needLevel == null)
    return null
  return Number(props.playerLevel) >= Number(info.value.needLevel)
})

function format(value: unknown) {
  const parsed = integer(value)
  return parsed === null ? '—' : parsed.toLocaleString('zh-CN')
}
</script>

<template>
  <Transition name="land-detail-fade">
    <div v-if="land" class="land-detail-overlay" @click.self="emit('close')">
      <div class="land-detail-modal" role="dialog" aria-modal="true" aria-label="土地详情">
        <header class="land-detail-header">
          <span class="land-detail-title">
            土地详情 <span class="land-detail-id">#{{ land?.id }}</span>
          </span>
          <button type="button" class="land-detail-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </header>

        <div v-if="info" class="land-detail-body">
          <div class="land-detail-levels" :class="{ 'land-detail-levels--compare': info.next && info.current }">
            <div v-if="info.current" class="land-detail-soil">
              <img :src="info.current.image" :alt="info.current.name" width="84" height="70">
              <strong>{{ info.current.name }}</strong>
            </div>
            <span v-if="info.next && info.current" class="land-detail-arrow" aria-hidden="true">→</span>
            <div v-if="info.next" class="land-detail-soil">
              <img :src="info.next.image" :alt="info.next.name" width="84" height="70">
              <strong>{{ info.next.name }}</strong>
            </div>
          </div>

          <table class="land-detail-metrics">
            <thead>
              <tr>
                <th>土地加成</th>
                <th>{{ info.current ? '当前' : '解锁后' }}</th>
                <th v-if="info.current && info.next">
                  升级后
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in metrics" :key="row.key">
                <th>{{ row.label }}</th>
                <td>{{ metric(info.current || info.next, row.key, row.unit) }}</td>
                <td
                  v-if="info.current && info.next"
                  :class="{ 'land-detail-improved': info.next[row.key] > info.current[row.key] }"
                >
                  {{ metric(info.next, row.key, row.unit) }}<span v-if="info.next[row.key] > info.current[row.key]" aria-label="提升"> ↑</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="info.mode === 'max'" class="land-detail-max">
            当前已满级
          </div>
          <section v-else class="land-detail-requirements">
            <h3>{{ info.mode === 'unlock' ? '解锁条件' : '升级条件' }}</h3>

            <div v-if="info.needLevel !== null" class="land-detail-condition">
              <span>种植等级达到 {{ info.needLevel }} 级</span>
              <strong :class="levelMet === false ? 'land-detail-missing' : 'land-detail-improved'">
                {{ levelMet === null ? '待确认' : (levelMet ? '已满足' : '未满足') }}
              </strong>
            </div>

            <div v-if="info.prerequisite" class="land-detail-condition">
              <span>解锁第 {{ info.prerequisite.landId }} 块土地</span>
              <strong :class="info.prerequisite.met ? 'land-detail-improved' : 'land-detail-missing'">
                {{ info.prerequisite.met ? '已满足' : '未满足' }}
              </strong>
            </div>

            <div v-if="info.current && info.next" class="land-detail-condition">
              <span>当前地块为{{ info.current.name }}</span>
              <strong class="land-detail-improved">已满足</strong>
            </div>

            <div v-for="cost in info.costs" :key="cost.id" class="land-detail-cost">
              <div class="land-detail-cost-name">
                <img v-if="cost.image" :src="cost.image" alt="" width="28" height="28">
                <span>{{ cost.name }}</span>
              </div>
              <div class="land-detail-cost-amount">
                <strong>{{ format(cost.count) }}</strong>
              </div>
            </div>

            <p v-if="info.unknown" class="land-detail-missing">
              部分条件暂未获取
            </p>
            <p v-else-if="info.serverAllowed" class="land-detail-improved">
              当前可{{ info.mode === 'unlock' ? '解锁' : '升级' }}
            </p>
          </section>
        </div>

        <p v-else class="land-detail-empty">
          土地详情暂未获取，请刷新农场。
        </p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.land-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: 12px;
}
.land-detail-modal {
  width: min(480px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  border-radius: 20px;
  background: var(--wb-surface, #fff);
  color: var(--wb-text, #1f2937);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
}
.land-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.land-detail-title {
  font-weight: 700;
}
.land-detail-id {
  font-size: 13px;
  opacity: 0.5;
}
.land-detail-close {
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  color: inherit;
}
.land-detail-close:hover {
  opacity: 1;
}
.land-detail-body {
  padding: 0 18px 18px;
}
.land-detail-levels {
  display: grid;
  justify-content: center;
  align-items: center;
  gap: 12px;
  padding: 0 0 18px;
}
.land-detail-levels--compare {
  grid-template-columns: 1fr auto 1fr;
}
.land-detail-soil {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.land-detail-soil img {
  object-fit: contain;
}
.land-detail-arrow {
  font-size: 22px;
  opacity: 0.4;
}
.land-detail-metrics {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.land-detail-metrics th,
.land-detail-metrics td {
  padding: 9px 4px;
  text-align: right;
}
.land-detail-metrics th:first-child {
  text-align: left;
  font-weight: 500;
  opacity: 0.7;
}
.land-detail-metrics thead {
  font-size: 12px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.25);
  opacity: 0.65;
}
.land-detail-requirements {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.25);
}
.land-detail-requirements h3 {
  margin: 0 0 12px;
  font-weight: 700;
}
.land-detail-condition {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 8px 0;
}
.land-detail-cost {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.land-detail-cost-name {
  display: flex;
  align-items: center;
  gap: 10px;
}
.land-detail-cost-name img {
  object-fit: contain;
}
.land-detail-cost-amount {
  display: flex;
  flex-direction: column;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.land-detail-improved {
  color: #278452;
}
.land-detail-missing {
  color: #c87138;
}
.land-detail-max {
  margin-top: 20px;
  padding: 10px;
  text-align: center;
  border-radius: 12px;
  background: rgba(69, 155, 93, 0.12);
  color: #278452;
  font-weight: 600;
}
.land-detail-empty {
  padding: 0 18px 18px;
  opacity: 0.7;
}
.land-detail-fade-enter-active,
.land-detail-fade-leave-active {
  transition: opacity 0.18s ease;
}
.land-detail-fade-enter-from,
.land-detail-fade-leave-to {
  opacity: 0;
}
@media (max-width: 360px) {
  .land-detail-metrics th,
  .land-detail-metrics td {
    padding: 8px 2px;
  }
  .land-detail-modal {
    font-size: 13px;
  }
}
</style>
