const { getAutomation } = require('../models/store');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');
const { getPetOverview, feedDog, withPetCommand, FOOD_DURATIONS, MAX_PROTECT_SECONDS } = require('./pets');
const { decodeDogReply } = require('./dog-skill-gifts');
const { getBag, getBagItems } = require('./warehouse');

const DOG_FOOD_MALL_GOODS_ID = 1006;
const FEED_COOLDOWN_MS = 10 * 60 * 1000;
const SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;
let lastFeedAt = 0;
let lastSkipLogAt = 0;
let pendingFeed = null;

function readConfig() {
  const automation = getAutomation() || {};
  const thresholdMin = Math.max(1, Math.min(1440, Math.trunc(toNum(automation.pet_food_auto_feed_threshold_min) || 120)));
  const buyCount = Math.max(1, Math.min(10, Math.trunc(toNum(automation.pet_food_auto_feed_buy_count) || 1)));
  return { enabled: automation.pet_food_auto_feed === true, thresholdMin, buyCount };
}

async function readBagFoodCounts(lease) {
  const items = getBagItems(await lease.read(getBag));
  const counts = new Map();
  for (const item of items) {
    const id = toNum(item && item.id);
    if (!FOOD_DURATIONS.has(id) || item.locked === true || item.locked === 1) continue;
    counts.set(id, (counts.get(id) || 0) + Math.max(0, toNum(item.count)));
  }
  return counts;
}

function pickFeedableFood(counts, currentSeconds, maxSeconds) {
  const candidates = [...FOOD_DURATIONS.entries()]
    .filter(([id, duration]) => (counts.get(id) || 0) > 0 && currentSeconds + duration <= maxSeconds)
    .sort((left, right) => right[1] - left[1]);
  return candidates.length > 0 ? candidates[0][0] : 0;
}

function logSkip(reason, detail = {}) {
  const now = Date.now();
  if (now - lastSkipLogAt < SKIP_LOG_INTERVAL_MS) return;
  lastSkipLogAt = now;
  log('宠物', `自动狗粮：${reason}`, { module: 'pet', event: 'pet_food_auto_feed', result: 'skipped', reason, ...detail });
}

async function buyDogFoodPack(count, lease) {
  const request = types.GetMallListBySlotTypeRequest.encode(
    types.GetMallListBySlotTypeRequest.create({ slot_type: 1 })
  ).finish();
  const reply = decodeDogReply(types.GetMallListBySlotTypeResponse,
    await lease.read(() => sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request)));
  const rawList = reply.goods_list ?? reply.goodsList;
  if (!Array.isArray(rawList)) throw new Error('商城响应缺少商品列表');
  const goodsList = rawList.filter(Boolean).map(raw =>
    Buffer.isBuffer(raw) || raw instanceof Uint8Array ? types.MallGoods.decode(raw) : raw);
  const goods = goodsList.find(item => toNum(item.goods_id ?? item.goodsId) === DOG_FOOD_MALL_GOODS_ID);
  if (!goods || goods.is_available === false || goods.isAvailable === false) return 0;
  const priceItem = Buffer.isBuffer(goods.price) || goods.price instanceof Uint8Array
    ? types.CoreItem.decode(goods.price) : goods.price;
  const currencyId = toNum(priceItem?.id);
  const unitPrice = toNum(priceItem?.count);
  if (![1002, 1004, 1005].includes(currencyId) || unitPrice <= 0) return 0;
  const bagItems = getBagItems(await lease.read(getBag));
  const balance = bagItems.filter(item => toNum(item?.id) === currencyId && item.locked !== true && item.locked !== 1)
    .reduce((sum, item) => sum + Math.max(0, toNum(item.count)), 0);
  if (balance < unitPrice * count) {
    logSkip('购买狗粮余额不足', { currencyId, price: unitPrice * count, balance });
    return 0;
  }
  // force 只绕过冷却；配置关闭绝不能新增花钱购买。
  lease.assertCurrent();
  if (!readConfig().enabled) return 0;
  const purchase = types.PurchaseRequest.encode(types.PurchaseRequest.create({ goods_id: DOG_FOOD_MALL_GOODS_ID, count })).finish();
  return lease.write('gamepb.mallpb.MallService', 'Purchase', purchase, response => {
    const result = decodeDogReply(types.PurchaseResponse, response);
    const goodsId = result.goods_id ?? result.goodsId;
    const rewards = result.reward_items ?? result.rewardItems ?? result.get_items ?? result.getItems;
    // proto3 未下发的 ID/success 是原型缺省值，不是购买失败；请求已绑定已知商品。
    if (goodsId != null && toNum(goodsId) > 0 && toNum(goodsId) !== DOG_FOOD_MALL_GOODS_ID) {
      throw new Error('狗粮购买响应返回不同商品');
    }
    const explicitSuccess = Object.hasOwn(result, 'success') ? result.success : undefined;
    if (explicitSuccess === false || explicitSuccess === 0) {
      lease.confirm('failed');
      return 0;
    }
    if (!Array.isArray(rewards)) throw new Error('狗粮购买响应缺少实际奖励');
    const got = rewards.filter(item => FOOD_DURATIONS.has(toNum(item?.id)))
      .reduce((sum, item) => sum + Math.max(0, toNum(item.count)), 0);
    if (got <= 0) return 0;
    const completion = lease.confirm();
    log('宠物', `自动狗粮：购买响应确认狗粮 x${got}`, {
      module: 'pet', event: 'pet_food_auto_feed', result: 'ok', goodsId: DOG_FOOD_MALL_GOODS_ID, count: got, ...completion,
    });
    return got;
  });
}

function checkAndFeedPetFood(options = {}) {
  if (pendingFeed) return pendingFeed;
  if (!readConfig().enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
  const request = withPetCommand(async (lease) => {
    const { enabled, thresholdMin, buyCount } = readConfig();
    if (!enabled) return { skipped: true, reason: 'disabled' };
    const now = Date.now();
    if (options.force !== true && now - lastFeedAt < FEED_COOLDOWN_MS) return { skipped: true, reason: 'cooldown' };
    const overview = await getPetOverview({ lease });
    if (!overview.dogs.some(dog => dog.owned === true)) return { skipped: true, reason: 'no_owned_pet' };
    const currentSeconds = toNum(overview.foodSeconds);
    const maxSeconds = Math.min(MAX_PROTECT_SECONDS, toNum(overview.protectSeconds));
    if (currentSeconds >= thresholdMin * 60) return { skipped: true, reason: 'above_threshold', protectSeconds: currentSeconds };
    let counts = await readBagFoodCounts(lease);
    let foodId = pickFeedableFood(counts, currentSeconds, maxSeconds);
    let bought = 0;
    if (!foodId) {
      if (currentSeconds + Math.min(...FOOD_DURATIONS.values()) > maxSeconds) return { skipped: true, reason: 'no_feedable_food' };
      bought = await buyDogFoodPack(buyCount, lease);
      if (!bought) return { skipped: true, reason: 'buy_none', protectSeconds: currentSeconds };
      counts = await readBagFoodCounts(lease);
      foodId = pickFeedableFood(counts, currentSeconds, maxSeconds);
      if (!foodId) return { skipped: true, reason: 'insufficient_food', bought, protectSeconds: currentSeconds };
    }
    lease.assertCurrent();
    if (!readConfig().enabled) return { skipped: true, reason: 'disabled', bought };
    const fed = await feedDog(foodId, 1, { lease, source: 'food', validate: () => readConfig().enabled });
    if (fed.skipped) return { ...fed, bought };
    lastFeedAt = Date.now();
    return { skipped: false, fed: 1, bought, foodId, protectSeconds: toNum(fed.foodSeconds) };
  }, { source: 'food', timeoutMs: options.timeoutMs });
  // 真正的未知写入错误必须保留元数据并抛出，不能伪装成普通 skipped。
  pendingFeed = request.catch(error => {
    logWarn('宠物', `自动狗粮失败: ${error.message}`, {
      module: 'pet', event: 'pet_food_auto_feed', result: 'error', outcome: error.outcome, error: error.message,
      errorCode: error.errorCode, sent: error.sent, resultState: error.resultState, outcomeUnknown: error.outcomeUnknown,
    });
    if (error.writeSent) lastFeedAt = Date.now();
    throw error;
  }).finally(() => { pendingFeed = null; });
  return pendingFeed;
}

module.exports = { DOG_FOOD_MALL_GOODS_ID, FEED_COOLDOWN_MS, checkAndFeedPetFood };
