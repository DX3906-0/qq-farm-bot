/**
 * 宠物狗粮自动化 —— 守护时长不足时自动购买并喂食
 *
 * 触发条件：当前守护剩余时长（protect_time）低于设定阈值。
 * 动作：
 *   1. 背包里已有狗粮 → 直接喂食（优先喂时长最长的档位，只要不超 30 天上限）；
 *   2. 背包没有 → 用点券在道具商城买「狗粮礼包」(mall goodsId=1006)，买完立即喂。
 *
 * 设计要点：
 *   - 与化肥补货同一套思路（阈值触发 + 冷却），避免每轮都打 RPC；
 *   - 「无事可做」不 throw：未开开关/时长充足/点券不足都走 skipped 分支并节流记日志，
 *     绝不每轮刷 error（否则真错误会被淹没）。
 */
const { getAutomation } = require('../models/store');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn, sleep } = require('../utils/utils');
const { getPetOverview, feedDog, FOOD_DURATIONS, MAX_PROTECT_SECONDS } = require('./pets');
const { getBag, getBagItems } = require('./warehouse');

// 道具商城「狗粮礼包」
const DOG_FOOD_MALL_GOODS_ID = 1006;
// 两次自动补粮的最小间隔：10 分钟（喂一次够撑好几天，没必要频繁打 RPC）
const FEED_COOLDOWN_MS = 10 * 60 * 1000;
// 「无事可做」类日志的节流间隔：10 分钟
const SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;

// 默认每次购买的礼包数
const DEFAULT_BUY_COUNT = 1;

let lastFeedAt = 0;
let lastSkipLogAt = 0;

/** 读配置（阈值分钟、购买数量）。 */
function readConfig() {
  const automation = getAutomation() || {};
  const thresholdMin = Math.max(1, Math.min(1440, Math.trunc(toNum(automation.pet_food_auto_feed_threshold_min) || 120)));
  const buyCount = Math.max(1, Math.min(10, Math.trunc(toNum(automation.pet_food_auto_feed_buy_count) || DEFAULT_BUY_COUNT)));
  return { thresholdMin, buyCount };
}

/** 背包里各档狗粮的可用数量（排除上锁物品）。 */
function readBagFoodCounts() {
  const items = getBagItems(getBag());
  const counts = new Map();
  for (const item of items) {
    const id = toNum(item && item.id);
    if (!FOOD_DURATIONS.has(id)) continue;
    if (item.locked === true || item.locked === 1) continue;
    counts.set(id, (counts.get(id) || 0) + toNum(item.count));
  }
  return counts;
}

/** 挑一个「喂得下」的档位：优先时长最长的，只要不超过 30 天上限。 */
function pickFeedableFood(counts, currentSeconds, maxSeconds) {
  const candidates = [...FOOD_DURATIONS.entries()]
    .filter(([id, duration]) => (counts.get(id) || 0) > 0 && currentSeconds + duration <= maxSeconds)
    .sort((left, right) => right[1] - left[1]);
  return candidates.length > 0 ? candidates[0][0] : 0;
}

/** 节流打一条「无事可做」日志（不刷屏、不掩盖真错误）。 */
function logSkip(reason, detail = {}) {
  const now = Date.now();
  if (now - lastSkipLogAt < SKIP_LOG_INTERVAL_MS) return;
  lastSkipLogAt = now;
  log('宠物', `自动狗粮：${reason}`, {
    module: 'pet', event: 'pet_food_auto_feed', result: 'skipped', reason, ...detail,
  });
}

/** 在道具商城购买狗粮礼包，返回实际买到的份数。 */
async function buyDogFoodPack(count) {
  const goodsList = await (async () => {
    const request = types.GetMallListBySlotTypeRequest.encode(
      types.GetMallListBySlotTypeRequest.create({ slot_type: 1 })
    ).finish();
    const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request);
    const reply = types.GetMallListBySlotTypeResponse.decode(body);
    const rawList = Array.isArray(reply && reply.goods_list) ? reply.goods_list : [];
    const list = [];
    for (const raw of rawList) {
      try { list.push(types.MallGoods.decode(raw)); } catch { /* 跳过解码失败的 */ }
    }
    return list;
  })();

  const goods = goodsList.find((item) => toNum(item && item.goods_id) === DOG_FOOD_MALL_GOODS_ID);
  if (!goods) {
    logWarn('宠物', '自动狗粮：商城内没有狗粮礼包，可能已下架', {
      module: 'pet', event: 'pet_food_auto_feed', result: 'error', reason: 'goods_missing',
    });
    return 0;
  }

  const ticket = Math.max(0, toNum((getUserState() || {}).ticket));
  const price = Math.max(0, toNum(goods.price));
  if (price > 0 && ticket < price) {
    logSkip(`点券不足（需 ${price}，余 ${ticket}），无法购买狗粮礼包`, { price, ticket });
    return 0;
  }

  const request = types.PurchaseRequest.encode(
    types.PurchaseRequest.create({ goods_id: DOG_FOOD_MALL_GOODS_ID, count })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', request);
  const reply = types.PurchaseResponse.decode(body);
  const got = (reply && Array.isArray(reply.get_items) && reply.get_items.length > 0) ? 1 : 1;
  log('宠物', `自动狗粮：已购买狗粮礼包 x${count}`, {
    module: 'pet', event: 'pet_food_auto_feed', result: 'ok', goodsId: DOG_FOOD_MALL_GOODS_ID, count,
  });
  return got > 0 ? count : 0;
}

/**
 * 检查并在需要时补粮。
 * @returns {Promise<{skipped:boolean, reason?:string, fed?:number, bought?:number, protectSeconds?:number}>}
 */
async function checkAndFeedPetFood(options = {}) {
  const force = options.force === true;
  const now = Date.now();
  if (!force && now - lastFeedAt < FEED_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown' };
  }

  const { thresholdMin, buyCount } = readConfig();

  let overview;
  try {
    overview = await getPetOverview();
  } catch (err) {
    logWarn('宠物', `自动狗粮：获取宠物信息失败 ${err.message}`, {
      module: 'pet', event: 'pet_food_auto_feed', result: 'error', error: err.message,
    });
    return { skipped: true, reason: 'overview_failed' };
  }

  const currentSeconds = toNum(overview.foodSeconds);
  const maxSeconds = toNum(overview.protectSeconds) || MAX_PROTECT_SECONDS;
  const thresholdSeconds = thresholdMin * 60;

  if (currentSeconds >= thresholdSeconds) {
    logSkip(`守护剩余 ${Math.round(currentSeconds / 3600)}h，高于阈值 ${thresholdMin}min`, {
      currentSeconds, thresholdSeconds,
    });
    return { skipped: true, reason: 'above_threshold', protectSeconds: currentSeconds };
  }

  // 冷却计时从「真的开始动手」起算，避免失败也白等 10 分钟
  lastFeedAt = now;

  // 1) 背包有粮 → 直接喂
  const counts = readBagFoodCounts();
  let foodId = pickFeedableFood(counts, currentSeconds, maxSeconds);
  if (!foodId) {
    // 2) 背包没粮 → 商城买
    let bought = 0;
    try {
      bought = await buyDogFoodPack(buyCount);
    } catch (err) {
      logWarn('宠物', `自动狗粮：购买狗粮礼包失败 ${err.message}`, {
        module: 'pet', event: 'pet_food_auto_feed', result: 'error', error: err.message,
      });
      return { skipped: true, reason: 'buy_failed', protectSeconds: currentSeconds };
    }
    if (bought <= 0) {
      return { skipped: true, reason: 'buy_none', protectSeconds: currentSeconds };
    }
    // 买完重新读背包
    const afterCounts = readBagFoodCounts();
    foodId = pickFeedableFood(afterCounts, currentSeconds, maxSeconds);
    if (!foodId) {
      logSkip('已购买狗粮礼包但背包内暂无可喂档位（可能超出30天上限）', {
        currentSeconds, maxSeconds,
      });
      return { skipped: true, reason: 'no_feedable_after_buy', bought, protectSeconds: currentSeconds };
    }
  }

  try {
    const fed = await feedDog(foodId, 1);
    log('宠物', `自动狗粮：守护剩余 ${Math.round(currentSeconds / 3600)}h 低于阈值，已喂食（当前 ${Math.round(toNum(fed.foodSeconds) / 3600)}h）`, {
      module: 'pet', event: 'pet_food_auto_feed', result: 'ok',
      foodId, protectSeconds: toNum(fed.foodSeconds), thresholdSeconds,
    });
    return { skipped: false, fed: 1, foodId, protectSeconds: toNum(fed.foodSeconds) };
  } catch (err) {
    logWarn('宠物', `自动狗粮：喂食失败 ${err.message}`, {
      module: 'pet', event: 'pet_food_auto_feed', result: 'error', error: err.message, foodId,
    });
    return { skipped: true, reason: 'feed_failed', protectSeconds: currentSeconds };
  }
}

module.exports = {
  DOG_FOOD_MALL_GOODS_ID,
  FEED_COOLDOWN_MS,
  checkAndFeedPetFood,
};
