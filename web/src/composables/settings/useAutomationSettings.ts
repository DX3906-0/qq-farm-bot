import type { Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { useSettingStore } from '@/stores/setting'

type AlertType = 'primary' | 'danger'

const allFertilizerLandTypes = ['purple', 'gold', 'black', 'red', 'normal']

/**
 * automation 默认值唯一来源。
 * 导出给 DefaultPlanSettingsTab.vue 复用，避免出现「两份手工同步的字面量」——
 * 曾因该文件内嵌了第二份默认值、漏加奶茶字段导致 vue-tsc 报 AutomationSettings 缺 13 个属性。
 */
export const defaultAutomation = {
  farm: false,
  task: false,
  email: false,
  sell: false,
  friend: false,
  farm_push: false,
  land_upgrade: false,
  friend_steal: false,
  friend_steal_only_gids: [] as number[],
  friend_help: false,
  friend_bad: false,
  friend_golden_bug: false,
  friend_help_exp_limit: false,
  star_passport_claim: false,
  star_record_claim: false,
  solar_terms_claim: false,
  qingmei_seed_claim: false,
  qingmei_wine_brew: false,
  qixi_dew_use: false,
  qixi_dew_use_on_friend: false,
  qixi_dew_use_on_friend_limit: 5,
  qixi_bridge_build: false,
  qixi_sachet_gift: false,
  qixi_friend_priority: [] as number[],
  rain_poem_bottle_buy: false,
  rain_poem_weather_collect: false,
  rain_poem_summon_use: false,
  rain_poem_prank_use: false,
  rain_poem_research_unlock: false,
  honghua_share_claim: false,
  honghua_tiers_claim: false,
  honghua_love_donate: false,
  golden_bug_clear: true,
  fertilizer_gift: false,
  fertilizer_buy_organic: false,
  fertilizer_buy_normal: false,
  mystery_shop_auto_buy: false,
  mystery_shop_allow_gold: true,
  mystery_shop_allow_coupon: false,
  mystery_shop_allow_gold_bean: false,
  mystery_shop_push: false,
  daily_report_push: false,
  daily_report_hour: 8,
  fertilizer: 'none',
  skip_own_weed_bug: false,
  skip_own_weed_bug_when_exp_full: false,
  fertilizer_multi_season: false,
  // 延迟收获：>0 时成熟作物满 N 分钟才自动收，0=立即收
  harvest_delay_min: 0,
  // 宠物狗粮：守护剩余时长低于阈值时自动喂食，没有狗粮则用点券买狗粮礼包再喂
  pet_food_auto_feed: false,
  pet_food_auto_feed_threshold_min: 120,
  pet_food_auto_feed_buy_count: 1,
  fertilizer_land_types: [...allFertilizerLandTypes],
  fertilizer_smart_seconds: 300,
  fertilizer_rain_poem_end_seconds: 300,
  fertilizer_rain_poem_organic_gap: 180,
  fertilizer_rain_poem_wait_gap: 60,
  // 秋祈良愿（wish_sign 中秋祈愿）＋ 快乐不独享（share_reward 分享奖励）自动化开关
  wish_sign_draw: false,
  wish_sign_choice: 1,
  wish_sign_claim: false,
  share_reward_share: false,
  share_reward_daily: false,
  share_reward_milestones: false,
  // 萌宠成长日记（萌宠日记活动）自动化开关默认值（全部默认关闭，按需开启）
  pet_diary_adopt: false,
  pet_diary_feed: false,
  pet_diary_draw: false,
  pet_diary_story_claim: false,
  pet_diary_seed_claim: false,
  pet_diary_solar_claim: false,
  pet_diary_treasure_open: false,
  pet_diary_compensation_claim: false,
  pet_diary_battle: false,
  pet_diary_charm_equip: false,
  // 奶茶热销中（S4 店铺经营）：默认全部关闭，按需开启
  milk_tea_upgrade: false,
  milk_tea_craft: false,
  milk_tea_boost: false,
  milk_tea_hire: false,
  milk_tea_seed_buy: false,
  milk_tea_hire_duration: 1,
  milk_tea_hire_talent: 0,
  milk_tea_cashier: false,
  milk_tea_wages: false,
  milk_tea_share_daily: false,
  milk_tea_share_rewards: false,
  milk_tea_fund_rewards: false,
  mall_coupon_gift_buy: false,
}

export function useAutomationSettings({
  currentAccountId,
  showAlert,
}: {
  currentAccountId: Ref<string | number | null | undefined>
  showAlert: (message: string, type?: AlertType) => void
}) {
  const settingStore = useSettingStore()
  const { settings } = storeToRefs(settingStore)

  const localAutomationSettings = ref({
    automation: {
      ...defaultAutomation,
      fertilizer: 'normal',
    },
    autoAcceptFriendMinLevel: 0,
    fertilizerBuyOrganicCount: 10,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 10,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 30,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
    friendBadTargets: [] as number[],
  })

  const localAutoCodeRefresh = ref({
    enabled: false,
    intervalMinutes: 60,
  })

  const automationSaving = ref(false)
  const autoCodeRefreshing = ref(false)

  const fertilizerLandTypeOptions = [
    { label: '紫土地', value: 'purple' },
    { label: '金土地', value: 'gold' },
    { label: '黑土地', value: 'black' },
    { label: '红土地', value: 'red' },
    { label: '普通土地', value: 'normal' },
  ]

  const fertilizerOptions = [
    { label: '普通 + 有机', value: 'both' },
    { label: '普通 + 快成熟有机', value: 'smart' },
    { label: '快成熟有机', value: 'smart_only' },
    { label: '快成熟普通', value: 'smart_normal' },
    { label: '最终阶段普通肥', value: 'final_normal' },
    { label: '最终阶段有机肥', value: 'final_organic' },
    { label: '雷雨天联动（雨落成诗活动）', value: 'rain_poem' },
    { label: '仅普通化肥', value: 'normal' },
    { label: '仅有机化肥', value: 'organic' },
    { label: '不施肥', value: 'none' },
  ]

  function normalizeFertilizerLandTypes(input: unknown) {
    const source = Array.isArray(input) ? input : allFertilizerLandTypes
    const normalized: string[] = []
    for (const item of source) {
      const value = String(item || '').trim().toLowerCase()
      if (!allFertilizerLandTypes.includes(value))
        continue
      if (normalized.includes(value))
        continue
      normalized.push(value)
    }
    return normalized
  }

  function normalizeQixiFriendPriority(value: unknown) {
    if (!Array.isArray(value))
      return []
    return [...new Set(value.map(Number).filter(gid => Number.isSafeInteger(gid) && gid > 0))]
  }

  function syncLocalAutomationSettings() {
    if (settings.value) {
      localAutomationSettings.value.automation = settings.value.automation
        ? {
            ...defaultAutomation,
            ...settings.value.automation,
          }
        : { ...defaultAutomation }

      localAutomationSettings.value.automation.fertilizer_land_types = normalizeFertilizerLandTypes(localAutomationSettings.value.automation.fertilizer_land_types)
      localAutomationSettings.value.automation.qixi_friend_priority = normalizeQixiFriendPriority(localAutomationSettings.value.automation.qixi_friend_priority)
      if (localAutomationSettings.value.automation.fertilizer_smart_seconds === undefined) {
        localAutomationSettings.value.automation.fertilizer_smart_seconds = 300
      }
      if (localAutomationSettings.value.automation.fertilizer_rain_poem_end_seconds === undefined) {
        localAutomationSettings.value.automation.fertilizer_rain_poem_end_seconds = 300
      }
      if (localAutomationSettings.value.automation.fertilizer_rain_poem_organic_gap === undefined) {
        localAutomationSettings.value.automation.fertilizer_rain_poem_organic_gap = 180
      }
      if (localAutomationSettings.value.automation.fertilizer_rain_poem_wait_gap === undefined) {
        localAutomationSettings.value.automation.fertilizer_rain_poem_wait_gap = 60
      }
      localAutomationSettings.value.autoAcceptFriendMinLevel = settings.value.autoAcceptFriendMinLevel ?? 0
      localAutomationSettings.value.fertilizerBuyOrganicCount = settings.value.fertilizerBuyOrganicCount ?? 10
      localAutomationSettings.value.fertilizerBuyOrganicThresholdHours = settings.value.fertilizerBuyOrganicThresholdHours ?? 10
      localAutomationSettings.value.fertilizerBuyNormalCount = settings.value.fertilizerBuyNormalCount ?? 10
      localAutomationSettings.value.fertilizerBuyNormalThresholdHours = settings.value.fertilizerBuyNormalThresholdHours ?? 10
      localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes = settings.value.fertilizerBuyCheckIntervalMinutes ?? 30
      localAutomationSettings.value.goldenBugKeepCount = settings.value.goldenBugKeepCount ?? 0
      localAutomationSettings.value.goldenBugRoundLimit = settings.value.goldenBugRoundLimit ?? 24
      localAutomationSettings.value.friendBadTargets = Array.isArray(settings.value.friendBadTargets)
        ? settings.value.friendBadTargets.map(Number).filter(n => Number.isFinite(n) && n > 0)
        : []
      localAutoCodeRefresh.value = {
        enabled: settings.value.autoCodeRefresh?.enabled === true,
        intervalMinutes: normalizeAutoCodeRefreshInterval(settings.value.autoCodeRefresh?.intervalMinutes),
      }
    }
  }

  function normalizeAutoCodeRefreshInterval(value: unknown) {
    const minutes = Number(value)
    if (!Number.isFinite(minutes))
      return 60
    return Math.max(1, Math.min(1440, Math.round(minutes)))
  }

  async function saveAutomationSettings() {
    if (!currentAccountId.value)
      return
    const accountId = String(currentAccountId.value)
    automationSaving.value = true
    try {
      localAutoCodeRefresh.value.intervalMinutes = normalizeAutoCodeRefreshInterval(localAutoCodeRefresh.value.intervalMinutes)
      localAutomationSettings.value.automation.qixi_friend_priority = normalizeQixiFriendPriority(localAutomationSettings.value.automation.qixi_friend_priority)
      const fullSettings = {
        ...settings.value,
        automation: localAutomationSettings.value.automation,
        autoCodeRefresh: localAutoCodeRefresh.value,
        autoAcceptFriendMinLevel: localAutomationSettings.value.autoAcceptFriendMinLevel,
        fertilizerBuyOrganicCount: localAutomationSettings.value.fertilizerBuyOrganicCount,
        fertilizerBuyOrganicThresholdHours: localAutomationSettings.value.fertilizerBuyOrganicThresholdHours,
        fertilizerBuyNormalCount: localAutomationSettings.value.fertilizerBuyNormalCount,
        fertilizerBuyNormalThresholdHours: localAutomationSettings.value.fertilizerBuyNormalThresholdHours,
        fertilizerBuyCheckIntervalMinutes: localAutomationSettings.value.fertilizerBuyCheckIntervalMinutes,
        goldenBugKeepCount: localAutomationSettings.value.goldenBugKeepCount,
        goldenBugRoundLimit: localAutomationSettings.value.goldenBugRoundLimit,
        friendBadTargets: localAutomationSettings.value.friendBadTargets,
      }
      // 记录保存前的化肥购买开关状态，仅当开关从关变开时才立即触发检测购买
      // （避免每次保存设置都触发购买，导致误买化肥）
      const prevBuyOrganic = !!settings.value?.automation?.fertilizer_buy_organic
      const prevBuyNormal = !!settings.value?.automation?.fertilizer_buy_normal
      const res = await settingStore.saveSettings(accountId, fullSettings)
      if (res.ok) {
        showAlert('自动控制设置已保存', 'primary')

        // 仅当化肥购买开关从关变开时，立即检测并购买一次
        const newBuyOrganic = !!localAutomationSettings.value.automation.fertilizer_buy_organic
        const newBuyNormal = !!localAutomationSettings.value.automation.fertilizer_buy_normal
        if ((newBuyOrganic && !prevBuyOrganic) || (newBuyNormal && !prevBuyNormal)) {
          try {
            const buyRes = await api.post('/api/fertilizer/check-and-buy', {
              buyOrganic: localAutomationSettings.value.automation.fertilizer_buy_organic,
              buyNormal: localAutomationSettings.value.automation.fertilizer_buy_normal,
              organicCount: localAutomationSettings.value.fertilizerBuyOrganicCount,
              organicThresholdHours: localAutomationSettings.value.fertilizerBuyOrganicThresholdHours,
              normalCount: localAutomationSettings.value.fertilizerBuyNormalCount,
              normalThresholdHours: localAutomationSettings.value.fertilizerBuyNormalThresholdHours,
            }, {
              headers: { 'x-account-id': accountId },
            })
            if (buyRes.data?.ok) {
              const totalBought = (buyRes.data.organicBought || 0) + (buyRes.data.normalBought || 0)
              if (totalBought > 0) {
                showAlert(`已自动购买 ${totalBought} 个化肥`, 'primary')
              }
            }
          }
          catch (e) {
            console.error('检测购买化肥失败', e)
          }
        }
      }
      else {
        showAlert(`保存失败: ${res.error}`, 'danger')
      }
    }
    finally {
      automationSaving.value = false
    }
  }

  async function runAutoCodeRefreshNow() {
    if (!currentAccountId.value)
      return
    const accountId = String(currentAccountId.value)
    autoCodeRefreshing.value = true
    try {
      const res = await settingStore.runAutoCodeRefresh(accountId)
      if (res.ok)
        showAlert('已触发刷新 Code，完成后会自动重启账号', 'primary')
      else
        showAlert(`刷新失败: ${res.error}`, 'danger')
    }
    finally {
      autoCodeRefreshing.value = false
    }
  }

  return {
    localAutomationSettings,
    localAutoCodeRefresh,
    automationSaving,
    autoCodeRefreshing,
    fertilizerLandTypeOptions,
    fertilizerOptions,
    syncLocalAutomationSettings,
    saveAutomationSettings,
    runAutoCodeRefreshNow,
  }
}
