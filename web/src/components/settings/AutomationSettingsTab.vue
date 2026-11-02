<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import SettingToggle from '@/components/settings/SettingToggle.vue'
import { isActivityHidden } from '@/config/activityVisibility'
import { isWithinActivityWindowMs, MILK_TEA_BUSINESS_WINDOW } from '@/constants/activity-windows'
import { useFriendStore } from '@/stores/friend'
import friendIcon from '@/assets/qqfarm/default_head.png'

interface AutomationSettings {
  automation: {
    farm: boolean
    task: boolean
    sell: boolean
    friend: boolean
    farm_push: boolean
    land_upgrade: boolean
    friend_steal: boolean
    friend_steal_only_gids: number[]
    friend_help: boolean
    friend_bad: boolean
    friend_golden_bug: boolean
    friend_help_exp_limit: boolean
    star_passport_claim: boolean
    star_record_claim: boolean
    solar_terms_claim: boolean
    qingmei_seed_claim: boolean
    qingmei_wine_brew: boolean
    qixi_dew_use: boolean
    qixi_bridge_build: boolean
    qixi_sachet_gift: boolean
    qixi_friend_priority: number[]
    rain_poem_bottle_buy: boolean
    rain_poem_weather_collect: boolean
    rain_poem_summon_use: boolean
    rain_poem_prank_use: boolean
    rain_poem_research_unlock: boolean
    golden_bug_clear: boolean
    fertilizer_gift: boolean
    fertilizer_buy_organic: boolean
    fertilizer_buy_normal: boolean
    mystery_shop_auto_buy: boolean
    mystery_shop_allow_gold: boolean
    mystery_shop_allow_coupon: boolean
    mystery_shop_allow_gold_bean: boolean
    mystery_shop_push: boolean
    daily_report_push: boolean
    daily_report_hour: number
    fertilizer: string
    skip_own_weed_bug: boolean
    skip_own_weed_bug_when_exp_full: boolean
    fertilizer_multi_season: boolean
    harvest_delay_min: number
    // 宠物狗粮自动化
    pet_food_auto_feed: boolean
    pet_food_auto_feed_threshold_min: number
    pet_food_auto_feed_buy_count: number
    fertilizer_land_types: string[]
    fertilizer_smart_seconds: number
    fertilizer_rain_poem_end_seconds: number
    fertilizer_rain_poem_organic_gap: number
    fertilizer_rain_poem_wait_gap: number
    // 秋祈良愿（wish_sign 中秋祈愿）＋ 快乐不独享（share_reward 分享奖励）自动化开关
    wish_sign_draw: boolean
    wish_sign_choice: number
    wish_sign_claim: boolean
    share_reward_share: boolean
    share_reward_daily: boolean
    share_reward_milestones: boolean
    // 萌宠成长日记（pet-diary）自动化开关
    pet_diary_adopt: boolean
    pet_diary_feed: boolean
    pet_diary_draw: boolean
    pet_diary_story_claim: boolean
    pet_diary_seed_claim: boolean
    pet_diary_solar_claim: boolean
    pet_diary_treasure_open: boolean
    pet_diary_compensation_claim: boolean
    pet_diary_battle: boolean
    pet_diary_charm_equip: boolean
    // 奶茶热销中（S4 店铺经营）自动化开关
    milk_tea_cashier: boolean
    milk_tea_wages: boolean
    milk_tea_upgrade: boolean
    milk_tea_craft: boolean
    milk_tea_boost: boolean
    milk_tea_hire: boolean
    milk_tea_seed_buy: boolean
    milk_tea_hire_duration: number
    milk_tea_hire_talent: number
    milk_tea_share_daily: boolean
    milk_tea_share_rewards: boolean
    milk_tea_fund_rewards: boolean
    mall_coupon_gift_buy: boolean
  }
  autoAcceptFriendMinLevel: number
  fertilizerBuyOrganicCount: number
  fertilizerBuyOrganicThresholdHours: number
  fertilizerBuyNormalCount: number
  fertilizerBuyNormalThresholdHours: number
  fertilizerBuyCheckIntervalMinutes: number
  goldenBugKeepCount: number
  goldenBugRoundLimit: number
  friendBadTargets: number[]
}

interface AutoCodeRefreshConfig {
  enabled: boolean
  intervalMinutes: number
}

const props = withDefaults(defineProps<{
  currentAccountName: string | null
  currentAccountId: string | number | null | undefined
  loading: boolean
  saving: boolean
  autoCodeRefreshing: boolean
  fertilizerLandTypeOptions: { label: string, value: string }[]
  fertilizerOptions: { label: string, value: string | number }[]
  title?: string
  saveLabel?: string
  showRunAutoCodeRefresh?: boolean
}>(), {
  title: '自动控制',
  saveLabel: '保存自动控制',
  showRunAutoCodeRefresh: true,
})

const emit = defineEmits<{
  save: []
  runAutoCodeRefresh: []
}>()

const settings = defineModel<AutomationSettings>('settings', { required: true })
const autoCodeRefresh = defineModel<AutoCodeRefreshConfig>('autoCodeRefresh', { required: true })

function isFastMatureFertilizerMode(mode: string) {
  return mode === 'smart' || mode === 'smart_only' || mode === 'smart_normal'
}

const nowMs = ref(Date.now())
let nowTimer: ReturnType<typeof window.setInterval> | null = null
// ⚠️ 活动在期判定统一走 isActivityHidden（内部含 activity-windows.ts 时间窗），
// 不再各自硬编码窗口常量，避免与 core/src/models/store.js 口径分叉。
const showRainPoemActivity = computed(() => !isActivityHidden('rain-poem'))
const showWishSignActivity = computed(() => !isActivityHidden('wish-sign'))
const showShareRewardActivity = computed(() => !isActivityHidden('share-reward'))

const qixiPickerVisible = ref(false)
const badPickerVisible = ref(false)
const stealPickerVisible = ref(false)
const friendSearch = ref('')

const friendStore = useFriendStore()

const filteredFriends = computed(() => {
  const q = friendSearch.value.trim().toLowerCase()
  const list = friendStore.friends
  if (!q)
    return list
  return list.filter((f: any) => {
    const name = String(f?.name || '').toLowerCase()
    const gid = String(f?.gid || '')
    return name.includes(q) || gid.includes(q)
  })
})

function friendName(gid: number) {
  const f = friendStore.friends.find((x: any) => Number(x?.gid) === Number(gid))
  return f ? `${f.name} (${f.gid})` : String(gid)
}

function toggleQixiFriend(gid: number) {
  const arr = settings.value.automation.qixi_friend_priority || []
  const i = arr.indexOf(gid)
  if (i >= 0)
    arr.splice(i, 1)
  else
    arr.push(gid)
}

function isQixiSelected(gid: number) {
  return (settings.value.automation.qixi_friend_priority || []).includes(gid)
}

// 「仅偷取指定好友」白名单：空数组 = 不限制（偷所有好友）
function toggleStealOnlyFriend(gid: number) {
  if (!Array.isArray(settings.value.automation.friend_steal_only_gids))
    settings.value.automation.friend_steal_only_gids = []
  const arr = settings.value.automation.friend_steal_only_gids!
  const i = arr.indexOf(gid)
  if (i >= 0)
    arr.splice(i, 1)
  else
    arr.push(gid)
}

function isStealOnlySelected(gid: number) {
  return (settings.value.automation.friend_steal_only_gids || []).includes(gid)
}

function toggleBadFriend(gid: number) {
  const arr = settings.value.friendBadTargets || []
  const i = arr.indexOf(gid)
  if (i >= 0)
    arr.splice(i, 1)
  else
    arr.push(gid)
}

function isBadSelected(gid: number) {
  return (settings.value.friendBadTargets || []).includes(gid)
}

function ensureFriends() {
  const id = props.currentAccountId
  if (id && friendStore.friends.length === 0)
    friendStore.fetchFriends(String(id))
}

onMounted(() => {
  ensureFriends()
  nowTimer = window.setInterval(() => { nowMs.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (nowTimer) window.clearInterval(nowTimer)
  nowTimer = null
})
watch(() => props.currentAccountId, ensureFriends)

const activeCategory = ref<string | null>(null)
function openCategory(key: string) {
  activeCategory.value = key
}
function closeCategory() {
  activeCategory.value = null
}

// 活动控制分类的介绍文案动态反映当前「活动控制」弹窗里实际可见的开关，
// 不再硬编码已结束的活动，始终包含现有在跑的活动内容。
const activityControlDesc = computed(() => {
  const labels = visibleActivityToggles.value.map(t => t.label.replace(/^自动领取/, '').replace(/^自动/, '').replace(/^[^·]+·/, ''))
  if (!isActivityHidden('qingmei')) labels.push('青梅')
  if (!isActivityHidden('qixi')) labels.push('七夕')
  // 去重（奶茶经营类与领奖类共 11 个开关，逐个列出会过长）
  return labels.length ? [...new Set(labels)].join('·') : '当前无进行中的活动'
})

const categories = computed(() => [
  { key: 'core', label: '核心自动化', icon: 'i-carbon-settings-adjust', iconBg: 'bg-indigo-50 dark:bg-indigo-900/30', iconText: 'text-indigo-600 dark:text-indigo-300', desc: '种植收获·卖果实·升级土地·填化肥·清黄金虫' },
  { key: 'activity', label: '活动控制', icon: 'i-carbon-star', iconBg: 'bg-indigo-50 dark:bg-indigo-900/30', iconText: 'text-indigo-600 dark:text-indigo-300', desc: activityControlDesc.value },
  { key: 'friend', label: '好友互动', icon: 'i-carbon-group', iconBg: 'bg-indigo-50 dark:bg-indigo-900/30', iconText: 'text-indigo-600 dark:text-indigo-300', desc: '偷菜·帮忙·放虫·捣乱·好友任务' },
  { key: 'fertilizer', label: '化肥策略', icon: 'i-carbon-chemistry', iconBg: 'bg-green-50 dark:bg-green-900/30', iconText: 'text-green-600 dark:text-green-300', desc: '有机/无机购买·施肥范围·多季补肥' },
  { key: 'mystery', label: '神秘商人', icon: 'i-carbon-store', iconBg: 'bg-amber-50 dark:bg-amber-900/30', iconText: 'text-amber-600 dark:text-amber-300', desc: '自动购买·上新推送·货币选择' },
  { key: 'pet', label: '宠物狗粮', icon: 'i-carbon-dog-walker', iconBg: 'bg-orange-50 dark:bg-orange-900/30', iconText: 'text-orange-600 dark:text-orange-300', desc: '守护时长不足时自动喂食·点券补购狗粮礼包' },
  { key: 'monitor', label: '监控与推送', icon: 'i-carbon-notification', iconBg: 'bg-teal-50 dark:bg-teal-900/30', iconText: 'text-teal-600 dark:text-teal-300', desc: '每日日报·自动刷新 Code' },
])

const activeCat = computed(() => categories.value.find(c => c.key === activeCategory.value) || null)

const coreToggles = [
  { key: 'farm', label: '自动种植收获', icon: 'i-carbon-sprout', color: 'green' },
  { key: 'task', label: '自动做任务', icon: 'i-carbon-task', color: 'blue' },
  { key: 'sell', label: '自动卖果实', icon: 'i-carbon-currency', color: 'amber' },
  { key: 'farm_push', label: '推送触发巡田', icon: 'i-carbon-notification', color: 'teal' },
  { key: 'land_upgrade', label: '自动升级土地', icon: 'i-carbon-building', color: 'slate' },
  { key: 'fertilizer_gift', label: '自动填充化肥', icon: 'i-carbon-tree', color: 'lime' },
  { key: 'skip_own_weed_bug', label: '不除自己草虫', icon: 'i-carbon-close', color: 'gray' },
  { key: 'skip_own_weed_bug_when_exp_full', label: '经验满不除自己草虫', icon: 'i-carbon-close', color: 'gray' },
  { key: 'golden_bug_clear', label: '自动清除黄金虫', icon: 'i-carbon-bee', color: 'orange' },
]

const rainPoemToggles = [
  { key: 'rain_poem_bottle_buy', label: '雨落成诗·购买天气采集瓶', icon: 'i-carbon-windy', color: 'sky' },
  { key: 'rain_poem_weather_collect', label: '雨落成诗·采集好友雷雨', icon: 'i-carbon-rain-drop', color: 'cyan' },
  { key: 'rain_poem_summon_use', label: '雨落成诗·使用雷雨召唤瓶', icon: 'i-carbon-lightning', color: 'amber' },
  { key: 'rain_poem_prank_use', label: '雨落成诗·使用使坏瓶', icon: 'i-carbon-thunderstorm-severe', color: 'purple' },
  { key: 'rain_poem_research_unlock', label: '雨落成诗·解锁气象研究', icon: 'i-carbon-data-unstructured', color: 'violet' },
]

const wishShareToggles = [
  { key: 'wish_sign_draw', label: '秋祈良愿·自动祈愿', icon: 'i-carbon-humidity-alt', color: 'amber' },
  { key: 'wish_sign_claim', label: '秋祈良愿·自动领祈愿奖励', icon: 'i-carbon-gift', color: 'amber' },
  { key: 'share_reward_share', label: '快乐不独享·自动分享', icon: 'i-carbon-share', color: 'orange' },
  { key: 'share_reward_daily', label: '快乐不独享·领每日快乐值', icon: 'i-carbon-calendar', color: 'orange' },
  { key: 'share_reward_milestones', label: '快乐不独享·领档位奖励', icon: 'i-carbon-trophy', color: 'orange' },
]

// 奶茶热销中（S4 店铺经营）自动化开关。
// 经营类（升级/制作/加速/雇佣/买种子）只在「经营期」窗口内可见可用；
// 领奖类（领收银台/领工资/分享/基金/点券礼包）延续到结算期末。
const milkTeaBusinessToggles = [
  { key: 'milk_tea_upgrade', label: '奶茶·自动升级店铺', icon: 'i-carbon-arrow-up', color: 'teal' },
  { key: 'milk_tea_craft', label: '奶茶·自动制作补货', icon: 'i-carbon-cafe', color: 'teal' },
  { key: 'milk_tea_boost', label: '奶茶·自动使用加速', icon: 'i-carbon-lightning', color: 'teal' },
  { key: 'milk_tea_hire', label: '奶茶·自动雇佣店员', icon: 'i-carbon-user-multiple', color: 'teal' },
  { key: 'milk_tea_seed_buy', label: '奶茶·自动购买种子', icon: 'i-carbon-seedling', color: 'teal' },
]
const milkTeaClaimToggles = [
  { key: 'milk_tea_cashier', label: '奶茶·自动领收银台收益', icon: 'i-carbon-currency', color: 'amber' },
  { key: 'milk_tea_wages', label: '奶茶·自动领工资', icon: 'i-carbon-wallet', color: 'amber' },
  { key: 'milk_tea_share_daily', label: '奶茶·自动分享领每日奖励', icon: 'i-carbon-share', color: 'amber' },
  { key: 'milk_tea_share_rewards', label: '奶茶·自动领分享档位奖励', icon: 'i-carbon-trophy', color: 'amber' },
  { key: 'milk_tea_fund_rewards', label: '奶茶·自动领成长基金', icon: 'i-carbon-finance', color: 'amber' },
  { key: 'mall_coupon_gift_buy', label: '奶茶·自动购买点券礼包', icon: 'i-carbon-shopping-cart', color: 'amber' },
]

const activityToggles = [
  { key: 'solar_terms_claim', label: '自动领取节令小札', icon: 'i-carbon-calendar', color: 'rose' },
  { key: 'star_passport_claim', label: '自动领取千星游记', icon: 'i-carbon-star', color: 'violet' },
  { key: 'star_record_claim', label: '自动领取观星礼录', icon: 'i-carbon-trophy', color: 'amber' },
  { key: 'qixi_bridge_build', label: '七夕自动建鹊桥', icon: 'i-carbon-link', color: 'pink' },
  { key: 'qixi_dew_use', label: '七夕自动使用灵露', icon: 'i-carbon-rain', color: 'sky' },
  { key: 'qixi_sachet_gift', label: '七夕自动赠香囊', icon: 'i-carbon-gift', color: 'red' },
  { key: 'honghua_share_claim', label: '公益小红花·领分享', icon: 'i-carbon-favorite', color: 'rose' },
  { key: 'honghua_tiers_claim', label: '公益小红花·领档位', icon: 'i-carbon-trophy', color: 'rose' },
  { key: 'honghua_love_donate', label: '公益小红花·送爱心值', icon: 'i-carbon-favorite', color: 'rose' },
  // 萌宠成长日记（萌宠日记活动）自动化开关
  { key: 'pet_diary_adopt', label: '萌宠日记·自动领养', icon: 'i-carbon-dog-walker', color: 'emerald' },
  { key: 'pet_diary_feed', label: '萌宠日记·自动喂养', icon: 'i-carbon-paw-heart', color: 'emerald' },
  { key: 'pet_diary_draw', label: '萌宠日记·自动召唤', icon: 'i-carbon-pedestrian', color: 'emerald' },
  { key: 'pet_diary_seed_claim', label: '萌宠日记·领种子', icon: 'i-carbon-seedling', color: 'emerald' },
  { key: 'pet_diary_solar_claim', label: '萌宠日记·领节令小礼', icon: 'i-carbon-calendar', color: 'emerald' },
  { key: 'pet_diary_story_claim', label: '萌宠日记·领爪印手记', icon: 'i-carbon-bookmark', color: 'emerald' },
  { key: 'pet_diary_treasure_open', label: '萌宠日记·开启拾物箱', icon: 'i-carbon-box', color: 'emerald' },
  { key: 'pet_diary_compensation_claim', label: '萌宠日记·领补偿奖励', icon: 'i-carbon-gift', color: 'emerald' },
  { key: 'pet_diary_battle', label: '萌宠日记·自动对战', icon: 'i-carbon-flag', color: 'emerald' },
  { key: 'pet_diary_charm_equip', label: '萌宠日记·自动穿戴装扮', icon: 'i-carbon-favorite', color: 'emerald' },
]

// 各活动开关随对应活动下架而隐藏（key 出现在 HIDDEN_ACTIVITIES 即隐藏，活动返厂时移除该 key 即自动恢复）：
//  - qixi*（七夕） → 'qixi'
//  - star_passport_claim（千星游记） → 'journey'
//  - star_record_claim（观星礼录） → 'records'
//  - solar_terms_claim（节令小札） → 'notes'
//  - pet_diary_*（萌宠成长日记） → 'pet-diary'
// 「心许千灯星垂野」整活动于 2026-08-28 0 点下线，上述子活动开关一并静默。
const toggleHiddenBy: Record<string, string> = {
  star_passport_claim: 'journey',
  star_record_claim: 'records',
  solar_terms_claim: 'notes',
  honghua_share_claim: 'honghua',
  honghua_tiers_claim: 'honghua',
  honghua_love_donate: 'honghua',
}
// 前缀 → 可见性 key 的映射：用于成组的活动开关（萌宠日记 10 个开关、秋祈/快乐不独享 5 个开关）。
const toggleHiddenByPrefix: Array<[string, string]> = [
  ['pet_diary_', 'pet-diary'],
  ['wish_sign_', 'wish-sign'],
  ['share_reward_', 'share-reward'],
  ['milk_tea_', 'milk-tea'],
]
// 奶茶活动可见性：经营类与领奖类各自独立判定（经营期先结束）。
const showMilkTeaActivity = computed(() => !isActivityHidden('milk-tea'))
const showMilkTeaBusiness = computed(() => isWithinActivityWindowMs(MILK_TEA_BUSINESS_WINDOW, nowMs.value))
const visibleActivityToggles = computed(() => {
  const toggles = activityToggles.filter((t) => {
    if (String(t.key).startsWith('qixi') && isActivityHidden('qixi')) return false
    const hiddenKey = toggleHiddenBy[t.key]
    if (hiddenKey && isActivityHidden(hiddenKey)) return false
    for (const [prefix, key] of toggleHiddenByPrefix) {
      if (String(t.key).startsWith(prefix) && isActivityHidden(key)) return false
    }
    return true
  })
  const showWishShare = showWishSignActivity.value || showShareRewardActivity.value
  return [
    ...toggles,
    ...(showRainPoemActivity.value ? rainPoemToggles : []),
    ...(showWishShare ? wishShareToggles : []),
    ...(showMilkTeaBusiness.value ? milkTeaBusinessToggles : []),
    ...(showMilkTeaActivity.value ? milkTeaClaimToggles : []),
  ]
})

const friendToggles = [
  { key: 'friend_steal', label: '自动偷菜', icon: 'i-carbon-download', color: 'indigo' },
  { key: 'friend_help', label: '自动帮忙', icon: 'i-carbon-help', color: 'indigo' },
  { key: 'friend_golden_bug', label: '自动放黄金虫', icon: 'i-carbon-bee', color: 'indigo' },
  { key: 'friend_help_exp_limit', label: '经验满只帮护主犬', icon: 'i-carbon-group', color: 'indigo' },
]

// 各分类开关键列表，用于卡片「种子行」逐颗渲染
const categoryToggleKeys: Record<string, () => string[]> = {
  core: () => [...coreToggles.map(t => t.key), 'friend'],
  activity: () => [
    ...visibleActivityToggles.value.map(t => t.key),
    ...(isActivityHidden('qingmei') ? [] : ['qingmei_seed_claim', 'qingmei_wine_brew']),
  ],
  friend: () => [...friendToggles.map(t => t.key), 'friend_bad'],
  fertilizer: () => ['fertilizer_buy_organic', 'fertilizer_buy_normal', 'fertilizer_multi_season', 'fertilizer_gift'],
  mystery: () => ['mystery_shop_auto_buy', 'mystery_shop_push', 'mystery_shop_allow_gold', 'mystery_shop_allow_coupon', 'mystery_shop_allow_gold_bean'],
  pet: () => ['pet_food_auto_feed'],
  monitor: () => ['daily_report_push', autoCodeRefresh.value.enabled ? 'autoCodeRefresh.enabled' : ''],
}
function categoryToggleList(key: string): string[] {
  return (categoryToggleKeys[key]?.() || []).filter(Boolean)
}
function isToggleOn(k: string): boolean {
  if (k === 'autoCodeRefresh.enabled') return autoCodeRefresh.value.enabled
  return !!(settings.value.automation as any)[k]
}
function categoryEnabledCount(key: string) {
  return categoryToggleList(key).filter(isToggleOn).length
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h3 class="text-lg font-bold text-gray-900 dark:text-gray-100">
        {{ title }}
        <span v-if="currentAccountName" class="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">({{ currentAccountName }})</span>
      </h3>
    </div>

    <div v-if="loading" class="py-4 text-center text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else-if="!currentAccountId" class="py-8 text-center text-gray-500">
      <div class="i-carbon-settings-adjust mx-auto mb-2 text-3xl text-gray-400" />
      <p>请先选择账号</p>
    </div>

    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <button
        v-for="(cat, idx) in categories"
        :key="cat.key"
        type="button"
        class="auto-card farm-card group relative flex flex-col gap-5 overflow-hidden rounded-[1.75rem] border border-[#ECE5D6] bg-[#FCFBF6] p-6 text-left shadow-[0_1px_2px_rgba(60,50,30,0.04),0_10px_28px_-14px_rgba(60,50,30,0.18)] transition-[transform,box-shadow] duration-300 hover:-translate-y-1.5 hover:shadow-[0_20px_44px_-16px_rgba(60,50,30,0.30)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5E8C5A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FBF7EE] active:scale-[0.975] dark:border-[#32362B] dark:bg-[#1E211A] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_10px_28px_-14px_rgba(0,0,0,0.55)] dark:hover:shadow-[0_20px_44px_-16px_rgba(0,0,0,0.6)] dark:focus-visible:ring-[#84B572] dark:focus-visible:ring-offset-[#14160F]"
        :style="{ '--delay': (idx * 70) + 'ms' }"
        @click="openCategory(cat.key)"
      >
        <div class="relative flex items-start justify-between gap-3">
          <span class="plot-icon h-14 w-14 inline-flex shrink-0 items-center justify-center rounded-2xl text-2xl">
            <i :class="cat.icon" />
          </span>
          <span
            v-if="categoryEnabledCount(cat.key) > 0"
            class="inline-flex items-center gap-1 rounded-full bg-[#E7F0DF] px-2.5 py-1 text-xs font-semibold text-[#3F6B3C] dark:bg-[#243022] dark:text-[#A7C957]"
          >
            <span class="i-carbon-checkmark-outline text-sm" />
            {{ categoryEnabledCount(cat.key) }} 项开启
          </span>
        </div>

        <div class="relative">
          <span class="block text-xl font-bold tracking-tight text-[#2C2A22] dark:text-[#ECE9DE]">{{ cat.label }}</span>
          <span class="mt-1.5 block text-sm leading-relaxed text-[#8C8472] dark:text-[#9C9A88]">{{ cat.desc }}</span>
        </div>

        <!-- 签名元素：种子行（每个开关一颗，开启=发芽变绿） -->
        <div
          class="relative mt-auto flex items-center gap-1.5 pt-1"
          :title="categoryEnabledCount(cat.key) + ' / ' + categoryToggleList(cat.key).length + ' 已开启'"
        >
          <span
            v-for="tk in categoryToggleList(cat.key)"
            :key="tk"
            class="seed h-2.5 w-2.5 rounded-full transition-all duration-300"
            :class="isToggleOn(tk)
              ? 'bg-[#7FB069] shadow-[0_0_0_3px_rgba(127,176,105,0.18)] dark:bg-[#8FBF6B] dark:shadow-[0_0_0_3px_rgba(143,191,107,0.22)]'
              : 'bg-transparent shadow-[inset_0_0_0_1.5px_#D8D0BF] dark:shadow-[inset_0_0_0_1.5px_#4A4E3E]'"
          />
          <span class="ml-1 text-xs tabular-nums text-[#8C8472] dark:text-[#9C9A88]">{{ categoryEnabledCount(cat.key) }}/{{ categoryToggleList(cat.key).length }}</span>
        </div>
      </button>
    </div>

    <div class="mt-4 px-1">
      <BaseButton variant="primary" class="w-full rounded-2xl py-3 text-sm font-semibold shadow-md" :loading="saving" @click="emit('save')">
        {{ saveLabel }}
      </BaseButton>
    </div>

    <!-- 分类设置弹窗 -->
    <Transition name="harmony">
      <div v-if="activeCategory" class="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
        <div class="absolute inset-0 bg-gray-950/45 backdrop-blur-[2px]" @click="closeCategory" />
        <div class="modal-card relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800 sm:rounded-3xl">
          <div class="flex items-center justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
            <div class="flex items-center gap-3">
              <span class="h-10 w-10 inline-grid place-items-center rounded-full" :class="[activeCat?.iconBg || '', activeCat?.iconText || '']">
                <i :class="activeCat?.icon" class="text-xl" />
              </span>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ activeCat?.label }}</h3>
            </div>
            <button class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" type="button" aria-label="关闭" @click="closeCategory"><span class="i-carbon-close text-xl" /></button>
          </div>

          <div class="flex-1 space-y-3 overflow-auto px-6 py-5">
            <template v-if="activeCategory === 'core'">
              <SettingToggle v-for="t in coreToggles" :key="t.key" :model-value="(settings.automation as any)[t.key]" :label="t.label" :icon="t.icon" :color="t.color" @update:model-value="(v: boolean) => (settings.automation as any)[t.key] = v" />
              <SettingToggle :model-value="settings.automation.friend" label="自动好友互动" :img="friendIcon" color="indigo" @update:model-value="settings.automation.friend = $event" />
            </template>

            <template v-else-if="activeCategory === 'activity'">
              <div v-if="!visibleActivityToggles.length && isActivityHidden('qingmei')" class="rounded-2xl border border-dashed border-gray-300 px-4 py-8 text-center dark:border-gray-600">
                <i class="i-carbon-calendar-heat mb-2 inline-block text-2xl text-gray-400" />
                <p class="text-sm font-medium text-gray-600 dark:text-gray-300">
                  当前无在期活动的自动化开关
                </p>
                <p class="mt-1 text-xs text-gray-400">
                  已适配的活动（雨落成诗·公益小红花·秋祈良愿·快乐不独享·萌宠日记）均已过活动窗口，<br>
                  换皮返厂或新活动上线后开关会自动出现。
                </p>
              </div>
              <SettingToggle v-for="t in visibleActivityToggles" :key="t.key" :model-value="(settings.automation as any)[t.key]" :label="t.label" :icon="t.icon" :color="t.color" @update:model-value="(v: boolean) => (settings.automation as any)[t.key] = v" />
              <div v-if="showMilkTeaBusiness && settings.automation.milk_tea_hire" class="space-y-3 rounded-2xl border border-teal-200 bg-teal-50/60 p-3 dark:border-teal-900 dark:bg-teal-900/20">
                <div class="text-sm font-medium text-teal-700 dark:text-teal-400">雇佣偏好</div>
                <BaseSelect v-model.number="settings.automation.milk_tea_hire_duration" label="雇佣时长" :options="[
                  { label: '1 小时', value: 1 }, { label: '2 小时', value: 2 }, { label: '4 小时', value: 3 },
                ]" />
                <BaseSelect v-model.number="settings.automation.milk_tea_hire_talent" label="天赋偏好" :options="[
                  { label: '不限（先到先得）', value: 0 }, { label: '天赋 9001', value: 9001 },
                  { label: '天赋 9002', value: 9002 }, { label: '天赋 9003', value: 9003 },
                  { label: '天赋 9004（仅机器人）', value: 9004 },
                ]" />
                <p class="text-xs text-gray-500 dark:text-gray-400">优先雇佣空闲好友，无可用好友时回落到机器人。</p>
              </div>
              <template v-if="!isActivityHidden('qingmei')">
                <SettingToggle v-model="settings.automation.qingmei_seed_claim" label="自动领取青梅种子" icon="i-carbon-sprout" color="green" />
                <SettingToggle v-model="settings.automation.qingmei_wine_brew" label="自动酿造青梅酿" icon="i-carbon-apple" color="rose" />
              </template>
              <div v-if="showWishSignActivity && settings.automation.wish_sign_draw" class="rounded-2xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                <BaseSelect v-model="settings.automation.wish_sign_choice" label="自动祈愿方向" :options="[
                  { label: '财运', value: 1 }, { label: '感情', value: 2 }, { label: '前程', value: 3 },
                  { label: '生活', value: 4 }, { label: '农耕', value: 5 }, { label: '人际', value: 6 },
                ]" />
              </div>
              <div v-if="!isActivityHidden('qixi') && settings.automation.qixi_sachet_gift" class="rounded-2xl border border-rose-200 bg-rose-50/60 p-3 dark:border-rose-900 dark:bg-rose-900/20">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-gray-900 dark:text-gray-100">香囊优先赠送好友</span>
                  <button type="button" class="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700" @click="qixiPickerVisible = true">选择好友</button>
                </div>
                <div v-if="(settings.automation.qixi_friend_priority || []).length" class="flex flex-wrap gap-1.5">
                  <span v-for="gid in (settings.automation.qixi_friend_priority || [])" :key="gid" class="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-rose-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-rose-900">
                    {{ friendName(gid) }}
                    <button type="button" class="text-rose-500 hover:text-rose-700" @click="toggleQixiFriend(gid)">×</button>
                  </span>
                </div>
                <p v-else class="text-xs text-gray-500 dark:text-gray-400">未指定，则随机赠送。</p>
              </div>
            </template>

            <template v-else-if="activeCategory === 'friend'">
              <SettingToggle v-for="t in friendToggles" :key="t.key" :model-value="(settings.automation as any)[t.key]" :label="t.label" :img="friendIcon" color="indigo" @update:model-value="(v: boolean) => (settings.automation as any)[t.key] = v" />
              <div v-if="settings.automation.friend_steal" class="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-900/20">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-gray-900 dark:text-gray-100">仅偷取指定好友</span>
                  <button type="button" class="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700" @click="stealPickerVisible = true">选择好友</button>
                </div>
                <div v-if="(settings.automation.friend_steal_only_gids || []).length" class="flex flex-wrap gap-1.5">
                  <span v-for="gid in (settings.automation.friend_steal_only_gids || [])" :key="gid" class="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-emerald-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-emerald-900">
                    {{ friendName(gid) }}
                    <button type="button" class="text-emerald-500 hover:text-emerald-700" @click="toggleStealOnlyFriend(gid)">×</button>
                  </span>
                </div>
                <p v-else class="text-xs text-gray-500 dark:text-gray-400">未指定，则偷取所有好友。</p>
              </div>
              <SettingToggle v-model="settings.automation.friend_bad" label="自动捣乱" :img="friendIcon" color="indigo" />
              <div v-if="settings.automation.friend && settings.automation.friend_bad" class="rounded-2xl border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-900/20">
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-gray-900 dark:text-gray-100">仅捣乱指定好友</span>
                  <button type="button" class="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700" @click="badPickerVisible = true">选择好友</button>
                </div>
                <div v-if="(settings.friendBadTargets || []).length" class="flex flex-wrap gap-1.5">
                  <span v-for="gid in (settings.friendBadTargets || [])" :key="gid" class="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-blue-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-blue-900">
                    {{ friendName(gid) }}
                    <button type="button" class="text-blue-500 hover:text-blue-700" @click="toggleBadFriend(gid)">×</button>
                  </span>
                </div>
                <p v-else class="text-xs text-gray-500 dark:text-gray-400">未指定，则捣乱所有可捣乱好友。</p>
              </div>
              <div v-if="settings.automation.friend && settings.automation.friend_golden_bug" class="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                <div class="text-sm font-medium text-gray-900 dark:text-gray-100">黄金虫策略</div>
                <BaseInput v-model.number="settings.goldenBugKeepCount" label="黄金虫保留数量" type="number" min="0" max="9999" />
                <BaseInput v-model.number="settings.goldenBugRoundLimit" label="黄金虫单轮上限" type="number" min="1" max="100" />
              </div>
              <div v-if="settings.automation.friend" class="rounded-2xl border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900 dark:bg-sky-900/20">
                <BaseInput v-model.number="settings.autoAcceptFriendMinLevel" label="自动通过好友最低等级" type="number" min="0" max="200" />
                <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">设为 0 表示不限制等级；启用好友自动化后按最低等级自动通过好友申请。</p>
              </div>
            </template>

            <template v-else-if="activeCategory === 'fertilizer'">
              <SettingToggle v-model="settings.automation.fertilizer_buy_organic" label="自动购买有机化肥" icon="i-carbon-leaf" color="green" />
              <SettingToggle v-model="settings.automation.fertilizer_buy_normal" label="自动购买无机化肥" icon="i-carbon-chemistry" color="cyan" />
              <div v-if="settings.automation.fertilizer_buy_organic || settings.automation.fertilizer_buy_normal" class="space-y-3 rounded-2xl border border-green-200 bg-green-50/60 p-3 dark:border-green-900 dark:bg-green-900/20">
                <div v-if="settings.automation.fertilizer_buy_organic" class="space-y-2">
                  <div class="text-sm font-medium text-green-700 dark:text-green-400">有机化肥设置</div>
                  <div class="flex flex-wrap gap-4">
                    <BaseInput v-model.number="settings.fertilizerBuyOrganicCount" label="购买数量" type="number" min="1" max="10000" />
                    <BaseInput v-model.number="settings.fertilizerBuyOrganicThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
                  </div>
                </div>
                <div v-if="settings.automation.fertilizer_buy_normal" class="space-y-2">
                  <div class="text-sm font-medium text-green-700 dark:text-green-400">无机化肥设置</div>
                  <div class="flex flex-wrap gap-4">
                    <BaseInput v-model.number="settings.fertilizerBuyNormalCount" label="购买数量" type="number" min="1" max="10000" />
                    <BaseInput v-model.number="settings.fertilizerBuyNormalThresholdHours" label="触发阈值 (小时)" type="number" min="1" max="990" />
                  </div>
                </div>
                <BaseInput v-model.number="settings.fertilizerBuyCheckIntervalMinutes" label="检测间隔 (分钟)" type="number" min="1" max="1440" />
              </div>
              <div class="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                <div class="text-sm font-medium text-amber-800 dark:text-amber-300">施肥范围</div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                  <label v-for="option in fertilizerLandTypeOptions" :key="option.value" class="flex cursor-pointer items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    <input v-model="settings.automation.fertilizer_land_types" :value="option.value" type="checkbox" class="h-3.5 w-3.5">
                    <span>{{ option.label }}</span>
                  </label>
                </div>
                <BaseSelect v-model="settings.automation.fertilizer" label="施肥策略" :options="fertilizerOptions" />
                <SettingToggle v-model="settings.automation.fertilizer_multi_season" label="多季补肥" icon="i-carbon-renew" color="lime" />
                <div v-if="isFastMatureFertilizerMode(settings.automation.fertilizer)" class="flex flex-wrap items-end gap-4">
                  <BaseInput v-model.number="settings.automation.fertilizer_smart_seconds" label="快成熟判定秒数" type="number" min="30" max="3600" class="w-40" />
                  <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">≤此秒数时施肥（默认300秒）</span>
                </div>
                <div v-if="settings.automation.fertilizer === 'rain_poem'" class="space-y-3 rounded-xl bg-white p-3 dark:bg-gray-800">
                  <p class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                    雷雨天专用：闪电变异只在「生长阶段变换瞬间」判定，因此仅在雷雨期间施肥。中段反应式监测阶段变换——作物一旦触发下一阶段（不区分是否成熟，成熟地块由巡田补种后接管）且未闪电变异，立即施普通肥制造又一次变换；收尾段为未触发变换的地块保底补普通肥；有机肥仅收尾段、未闪电变异、且按生长时间临近下阶段时施。
                  </p>
                  <div class="flex flex-wrap items-end gap-4">
                    <BaseInput v-model.number="settings.automation.fertilizer_rain_poem_end_seconds" label="雷雨收尾判定秒数" type="number" min="60" max="3600" class="w-40" />
                    <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">雷雨剩余≤此秒数进入收尾（默认300秒）</span>
                  </div>
                  <div class="flex flex-wrap items-end gap-4">
                    <BaseInput v-model.number="settings.automation.fertilizer_rain_poem_organic_gap" label="有机肥临门秒数" type="number" min="30" max="3600" class="w-40" />
                    <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">收尾时距下阶段≤此秒数且未闪电变异才用有机肥（默认180秒，有机肥稀缺）</span>
                  </div>
                  <div class="flex flex-wrap items-end gap-4">
                    <BaseInput v-model.number="settings.automation.fertilizer_rain_poem_wait_gap" label="中段反应式·雷雨剩余下限" type="number" min="15" max="600" class="w-40" />
                    <span class="pb-2 text-xs text-gray-500 dark:text-gray-400">作物触发下一阶段时立即补普通肥；若雷雨剩余已不足此秒数则留到收尾保底（默认60秒）</span>
                  </div>
                </div>
              </div>
            </template>

            <template v-else-if="activeCategory === 'mystery'">
              <SettingToggle v-model="settings.automation.mystery_shop_auto_buy" label="自动购买商品" icon="i-carbon-store" color="amber" />
              <SettingToggle v-model="settings.automation.mystery_shop_push" label="上新推送" icon="i-carbon-notification" color="rose" />
              <div class="space-y-1.5 rounded-2xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-900/20">
                <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><BaseSwitch v-model="settings.automation.mystery_shop_allow_gold" /><span>金币</span></label>
                <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><BaseSwitch v-model="settings.automation.mystery_shop_allow_coupon" /><span>点券</span></label>
                <label class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><BaseSwitch v-model="settings.automation.mystery_shop_allow_gold_bean" /><span>金豆豆</span></label>
              </div>
            </template>

            <template v-else-if="activeCategory === 'pet'">
              <SettingToggle v-model="settings.automation.pet_food_auto_feed" label="自动购买并喂食狗粮" icon="i-carbon-dog-walker" color="orange" />
              <div v-if="settings.automation.pet_food_auto_feed" class="space-y-3 rounded-2xl border border-orange-200 bg-orange-50/60 p-3 dark:border-orange-900 dark:bg-orange-900/20">
                <div class="text-sm font-medium text-orange-700 dark:text-orange-400">补粮策略</div>
                <div class="flex flex-wrap gap-4">
                  <BaseInput v-model.number="settings.automation.pet_food_auto_feed_threshold_min" label="守护剩余低于 (分钟)" type="number" min="1" max="1440" />
                  <BaseInput v-model.number="settings.automation.pet_food_auto_feed_buy_count" label="每次购买礼包数" type="number" min="1" max="10" />
                </div>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  守护剩余时长低于阈值时：背包有狗粮会直接喂（优先时长最长的档位）；没有则用点券在道具商城买「狗粮礼包」再喂。两次补粮最小间隔 10 分钟，喂食上限 30 天。
                </p>
              </div>
            </template>

            <template v-else-if="activeCategory === 'monitor'">
              <SettingToggle v-model="settings.automation.daily_report_push" label="每日收益日报" icon="i-carbon-notification" color="teal" />
              <div v-if="settings.automation.daily_report_push" class="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
                <label class="text-sm text-gray-600 dark:text-gray-300">推送时间</label>
                <input v-model.number="settings.automation.daily_report_hour" type="number" min="0" max="23" class="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white">
                <span class="text-sm text-gray-500 dark:text-gray-400">点</span>
              </div>
              <div class="rounded-2xl border border-gray-200 bg-gray-50/70 p-3 dark:border-gray-700 dark:bg-gray-900/20">
                <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span class="inline-flex items-center gap-1.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <span class="i-carbon-renew text-base text-gray-500 dark:text-gray-400" />
                        自动刷新获取 Code
                      </span>
                      <BaseSwitch v-model="autoCodeRefresh.enabled" label="启用" />
                    </div>
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                      <span class="font-semibold text-amber-700 dark:text-amber-300">仅微信账号可用。</span>
                      到点后自动获取新 Code 并重启当前账号；QQ 账号和缺少 wxid 的手动填码账号会跳过。
                    </p>
                  </div>
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <BaseInput v-model.number="autoCodeRefresh.intervalMinutes" class="sm:w-36" label="间隔(分钟)" type="number" min="1" max="1440" placeholder="60" />
                    <BaseButton v-if="showRunAutoCodeRefresh" variant="secondary" size="sm" class="h-9 whitespace-nowrap" :loading="autoCodeRefreshing" :disabled="saving" @click="emit('runAutoCodeRefresh')">
                      <span class="i-carbon-renew mr-1" />
                      立即刷新
                    </BaseButton>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
            <BaseButton class="min-w-24" size="sm" @click="closeCategory">完成</BaseButton>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 香囊优先赠送好友选择弹窗 -->
    <Transition name="fade">
      <div v-if="qixiPickerVisible" class="fixed inset-0 z-[60] grid place-items-center bg-gray-950/45 p-4 backdrop-blur-[2px]" @click.self="qixiPickerVisible = false">
        <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">选择香囊优先赠送好友</h3>
            <button class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" type="button" aria-label="关闭" @click="qixiPickerVisible = false"><span class="i-carbon-close text-xl" /></button>
          </div>
          <div class="border-b border-gray-100 px-6 py-3 dark:border-gray-700">
            <input v-model="friendSearch" type="text" placeholder="搜索昵称或 GID" class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white">
          </div>
          <div class="flex-1 space-y-1 overflow-auto px-6 py-3">
            <label v-for="f in filteredFriends" :key="f.gid" class="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <span class="flex min-w-0 items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <span class="truncate">{{ f.name }}</span>
                <span class="shrink-0 text-xs text-gray-400">{{ f.gid }}<span v-if="f.level"> · Lv.{{ f.level }}</span></span>
              </span>
              <input type="checkbox" class="h-4 w-4" :checked="isQixiSelected(Number(f.gid))" @change="toggleQixiFriend(Number(f.gid))">
            </label>
            <p v-if="!filteredFriends.length" class="py-6 text-center text-sm text-gray-400">暂无可选择的好友</p>
          </div>
          <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
            <BaseButton class="min-w-24" size="sm" @click="qixiPickerVisible = false">完成</BaseButton>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 仅捣乱指定好友选择弹窗 -->
    <Transition name="fade">
      <div v-if="badPickerVisible" class="fixed inset-0 z-[60] grid place-items-center bg-gray-950/45 p-4 backdrop-blur-[2px]" @click.self="badPickerVisible = false">
        <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">选择仅捣乱好友</h3>
            <button class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" type="button" aria-label="关闭" @click="badPickerVisible = false"><span class="i-carbon-close text-xl" /></button>
          </div>
          <div class="border-b border-gray-100 px-6 py-3 dark:border-gray-700">
            <input v-model="friendSearch" type="text" placeholder="搜索昵称或 GID" class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white">
          </div>
          <div class="flex-1 space-y-1 overflow-auto px-6 py-3">
            <label v-for="f in filteredFriends" :key="f.gid" class="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <span class="flex min-w-0 items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <span class="truncate">{{ f.name }}</span>
                <span class="shrink-0 text-xs text-gray-400">{{ f.gid }}<span v-if="f.level"> · Lv.{{ f.level }}</span></span>
              </span>
              <input type="checkbox" class="h-4 w-4" :checked="isBadSelected(Number(f.gid))" @change="toggleBadFriend(Number(f.gid))">
            </label>
            <p v-if="!filteredFriends.length" class="py-6 text-center text-sm text-gray-400">暂无可选择的好友</p>
          </div>
          <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
            <BaseButton class="min-w-24" size="sm" @click="badPickerVisible = false">完成</BaseButton>
          </div>
        </div>
      </div>
      <div v-if="stealPickerVisible" class="fixed inset-0 z-[60] grid place-items-center bg-gray-950/45 p-4 backdrop-blur-[2px]" @click.self="stealPickerVisible = false">
        <div class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <div class="flex items-center justify-between border-b border-gray-100 px-6 py-5 dark:border-gray-700">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">选择仅偷取好友</h3>
            <button class="h-8 w-8 inline-grid shrink-0 place-items-center rounded-lg text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200" type="button" aria-label="关闭" @click="stealPickerVisible = false"><span class="i-carbon-close text-xl" /></button>
          </div>
          <div class="border-b border-gray-100 px-6 py-3 dark:border-gray-700">
            <input v-model="friendSearch" type="text" placeholder="搜索昵称或 GID" class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white">
          </div>
          <div class="flex-1 space-y-1 overflow-auto px-6 py-3">
            <label v-for="f in filteredFriends" :key="f.gid" class="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <span class="flex min-w-0 items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
                <span class="truncate">{{ f.name }}</span>
                <span class="shrink-0 text-xs text-gray-400">{{ f.gid }}<span v-if="f.level"> · Lv.{{ f.level }}</span></span>
              </span>
              <input type="checkbox" class="h-4 w-4" :checked="isStealOnlySelected(Number(f.gid))" @change="toggleStealOnlyFriend(Number(f.gid))">
            </label>
            <p v-if="!filteredFriends.length" class="py-6 text-center text-sm text-gray-400">暂无可选择的好友</p>
          </div>
          <div class="flex justify-end border-t border-gray-100 bg-gray-50/70 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/20">
            <BaseButton class="min-w-24" size="sm" @click="stealPickerVisible = false">完成</BaseButton>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.farm-card {
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
}
/* 图标：泥块底色 + 鼠尾草绿，hover 时轻微放大旋转（发芽感） */
.plot-icon {
  color: #5E8C5A;
  background: #F0ECDD;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), color 0.3s, background 0.3s;
}
:global(.dark) .plot-icon {
  color: #84B572;
  background: #2A2E22;
}
.farm-card:hover .plot-icon {
  transform: scale(1.08) rotate(-4deg);
}
/* 种子：开启点 hover 微微上浮放大 */
.seed {
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.3s, background 0.3s;
}
.farm-card:hover .seed--on {
  transform: translateY(-1px) scale(1.14);
}

/* 分类大卡片入场缩放动画：错峰淡入 + 由小放大 */
.auto-card {
  animation: cardIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: var(--delay, 0ms);
  will-change: transform, opacity;
}
@keyframes cardIn {
  from {
    opacity: 0;
    transform: scale(0.9) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.harmony-enter-active,
.harmony-leave-active {
  transition: opacity 0.25s ease;
}
.harmony-enter-active .modal-card,
.harmony-leave-active .modal-card {
  transition: transform 0.34s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
}
.harmony-enter-from,
.harmony-leave-to {
  opacity: 0;
}
.harmony-enter-from .modal-card,
.harmony-leave-to .modal-card {
  transform: scale(0.94);
  opacity: 0;
}
.harmony-enter-to .modal-card,
.harmony-leave-from .modal-card {
  transform: scale(1);
  opacity: 1;
}

/* 弹窗顶部鼠尾草色条 */
.modal-card::before {
  content: "";
  display: block;
  height: 4px;
  background: linear-gradient(90deg, #5E8C5A, #7FB069);
}
:global(.dark) .modal-card::before {
  background: linear-gradient(90deg, #84B572, #A7C957);
}
.modal-card {
  border-radius: 1.25rem;
  overflow: hidden;
}

/* 尊重减弱动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .auto-card,
  .farm-card,
  .plot-icon,
  .seed {
    animation: none !important;
    transition: none !important;
  }
}
</style>
