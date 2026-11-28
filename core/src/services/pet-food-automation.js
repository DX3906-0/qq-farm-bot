const fs = require('node:fs');
const process = require('node:process');
const { createHash, randomUUID } = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { getAutomation } = require('../models/store');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');
const { getPetOverview, feedDog, withPetCommand, FOOD_DURATIONS, MAX_PROTECT_SECONDS } = require('./pets');
const { decodeDogReply } = require('./dog-skill-gifts');

const DOG_FOOD_MALL_GOODS_ID = 1006;
const FEED_COOLDOWN_MS = 10 * 60 * 1000;
const SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;
let lastFeedAt = 0;
let lastSkipLogAt = 0;
let pendingFeed = null;
let durableState = null;
let lastCheck = null;

function readConfig() {
  const automation = getAutomation() || {};
  const thresholdMin = Math.max(1, Math.min(1440, Math.trunc(toNum(automation.pet_food_auto_feed_threshold_min) || 120)));
  const buyCount = Math.max(1, Math.min(10, Math.trunc(toNum(automation.pet_food_auto_feed_buy_count) || 1)));
  return { enabled: automation.pet_food_auto_feed === true, thresholdMin, buyCount };
}
function stateFile() {
  const accountId = String(process.env.FARM_ACCOUNT_ID || '').trim();
  if (!accountId) throw Object.assign(new Error('狗粮操作缺少账号归属'), { sent: false, resultState: 'not_sent' });
  return getDataFile(`pet-food-auto-${createHash('sha256').update(accountId).digest('hex').slice(0, 24)}.json`);
}
function readState() {
  if (!durableState) {
    const file = stateFile();
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, lastFeedAt: 0, operation: null };
    if (!data || data.version !== 1 || typeof data !== 'object' || Array.isArray(data)
      || !Number.isSafeInteger(data.lastFeedAt) || data.lastFeedAt < 0
      || data.operation != null && (!data.operation.id || !['purchase', 'feed'].includes(data.operation.kind))) {
      throw Object.assign(new Error('狗粮操作记录不完整，请保留记录并核对'), { sent: false, resultState: 'not_sent' });
    }
    durableState = data;
    lastFeedAt = Math.max(lastFeedAt, data.lastFeedAt);
  }
  return durableState;
}
function writeState(data, sent = false) {
  try { writeJsonFileAtomic(stateFile(), data); durableState = data; }
  catch (cause) {
    throw Object.assign(new Error(sent ? '狗粮结果已返回，但操作记录保存失败；禁止重复提交' : '狗粮单次记录保存失败，未发送操作'), {
      sent, resultState: sent ? 'unknown' : 'not_sent', outcomeUnknown: sent, retryable: false, cause,
    });
  }
}
function beginOperation(kind, detail) {
  const state = readState();
  if (state.operation) throw Object.assign(new Error('上次狗粮操作结果未确认，禁止重放'), {
    sent: true, resultState: 'unknown', outcomeUnknown: true, retryable: false,
  });
  const operation = { id: randomUUID(), kind, at: Date.now(), ...detail };
  writeState({ ...state, operation });
  return operation;
}
function completeOperation(operation, patch = {}) {
  const state = readState();
  if (state.operation?.id !== operation.id) throw Object.assign(new Error('狗粮操作记录归属已变化，禁止清除未知记录'), {
    sent: true, resultState: 'unknown', outcomeUnknown: true, retryable: false,
  });
  writeState({ ...state, ...patch, operation: null }, true);
}
function settleDefinitiveFailure(operation, error) {
  if (operation && (error?.sent === false || error?.resultState === 'not_sent'
    || error?.resultState === 'failed' && error?.outcomeUnknown !== true)) completeOperation(operation);
}
function unknownFoodResult(message) {
  return Object.assign(new Error(message), { sent: true, resultState: 'unknown', outcomeUnknown: true, retryable: false });
}
function getPetFoodAutomationState() {
  try {
    const state = readState();
    return { ...readConfig(), pending: !!pendingFeed, blocked: !!state.operation && !pendingFeed,
      pendingOperation: state.operation?.kind || null, lastFeedAt, lastCheck };
  } catch (error) {
    return { ...readConfig(), pending: !!pendingFeed, blocked: true, error: error.message, lastCheck };
  }
}
function recordCheck(result) {
  lastCheck = { checkedAt: Date.now(), ...result };
  return result;
}
async function readBagFoodCounts(lease) {
  const { getBag, getBagItems } = require('./warehouse');
  const items = getBagItems(await lease.read(getBag));
  const counts = new Map();
  for (const item of items) {
    const id = toNum(item && item.id);
    if (!FOOD_DURATIONS.has(id) || [true, 1, '1'].includes(item.locked)) continue;
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
  const request = types.GetMallListBySlotTypeRequest.encode(types.GetMallListBySlotTypeRequest.create({ slot_type: 1 })).finish();
  const reply = decodeDogReply(types.GetMallListBySlotTypeResponse,
    await lease.read(() => sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request)));
  const rawList = reply.goods_list ?? reply.goodsList;
  if (!Array.isArray(rawList)) throw new Error('商城响应缺少商品列表');
  const goodsList = rawList.filter(Boolean).map(raw => Buffer.isBuffer(raw) || raw instanceof Uint8Array ? types.MallGoods.decode(raw) : raw);
  const goods = goodsList.find(item => toNum(item.goods_id ?? item.goodsId) === DOG_FOOD_MALL_GOODS_ID);
  if (!goods) { logSkip('当前商城未返回狗粮礼包', { goodsId: DOG_FOOD_MALL_GOODS_ID, goodsCount: goodsList.length }); return 0; }
  // 未下发的 proto3 bool 继承默认 false；只有显式下发的 false 才是下架。
  // 主进程 JSON 传输会丢弃原型默认值，因此不能拿商城DTO的行为替代这里的判定。
  if (['is_available', 'isAvailable'].some(key => Object.hasOwn(goods, key) && (goods[key] === false || goods[key] === 0))) {
    logSkip('狗粮礼包当前不可购买', { goodsId: DOG_FOOD_MALL_GOODS_ID });
    return 0;
  }
  const priceItem = Buffer.isBuffer(goods.price) || goods.price instanceof Uint8Array ? types.CoreItem.decode(goods.price) : goods.price;
  const currencyId = toNum(priceItem?.id), unitPrice = toNum(priceItem?.count);
  if (![1002, 1004, 1005].includes(currencyId)) { logSkip('狗粮礼包价格币种不在当前允许范围', { goodsId: DOG_FOOD_MALL_GOODS_ID, currencyId }); return 0; }
  if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) { logSkip('狗粮礼包未返回有效价格', { goodsId: DOG_FOOD_MALL_GOODS_ID, currencyId, unitPrice }); return 0; }
  const { getBag, getBagItems } = require('./warehouse');
  const bagItems = getBagItems(await lease.read(getBag));
  const balance = bagItems.filter(item => toNum(item?.id) === currencyId && ![true, 1, '1'].includes(item.locked))
    .reduce((sum, item) => sum + Math.max(0, toNum(item.count)), 0);
  if (balance < unitPrice * count) { logSkip('购买狗粮余额不足', { currencyId, price: unitPrice * count, balance }); return 0; }
  lease.assertCurrent();
  if (!readConfig().enabled) return 0;
  const purchase = types.PurchaseRequest.encode(types.PurchaseRequest.create({ goods_id: DOG_FOOD_MALL_GOODS_ID, count })).finish();
  const operation = beginOperation('purchase', { goodsId: DOG_FOOD_MALL_GOODS_ID, count, currencyId, unitPrice });
  try {
    return await lease.write('gamepb.mallpb.MallService', 'Purchase', purchase, response => {
      const result = decodeDogReply(types.PurchaseResponse, response);
      const goodsId = result.goods_id ?? result.goodsId;
      const rewards = result.reward_items ?? result.rewardItems ?? result.get_items ?? result.getItems;
      if (goodsId != null && toNum(goodsId) > 0 && toNum(goodsId) !== DOG_FOOD_MALL_GOODS_ID) throw unknownFoodResult('狗粮购买响应返回不同商品');
      const explicitSuccess = Object.hasOwn(result, 'success') ? result.success : undefined;
      if (explicitSuccess === false || explicitSuccess === 0) { lease.confirm('failed'); completeOperation(operation); return 0; }
      if (!Array.isArray(rewards)) throw unknownFoodResult('狗粮购买响应缺少实际奖励');
      const got = rewards.filter(item => FOOD_DURATIONS.has(toNum(item?.id)))
        .reduce((sum, item) => sum + Math.max(0, toNum(item.count)), 0);
      if (got <= 0) throw unknownFoodResult('狗粮购买回包未确认实际狗粮，禁止重买');
      const completion = lease.confirm();
      completeOperation(operation);
      log('宠物', `自动狗粮：购买响应确认狗粮 x${got}`, { module: 'pet', event: 'pet_food_auto_feed', result: 'ok',
        goodsId: DOG_FOOD_MALL_GOODS_ID, count: got, ...completion });
      return got;
    });
  } catch (error) { settleDefinitiveFailure(operation, error); throw error; }
}
function checkAndFeedPetFood(options = {}) {
  if (pendingFeed) return pendingFeed;
  if (!readConfig().enabled) return Promise.resolve(recordCheck({ skipped: true, reason: 'disabled' }));
  let request;
  try {
    if (readState().operation) throw unknownFoodResult('上次狗粮操作结果未确认，保留单次记录，不自动重放');
    request = withPetCommand(async lease => {
      const { enabled, thresholdMin, buyCount } = readConfig();
      if (!enabled) return { skipped: true, reason: 'disabled' };
      if (options.force !== true && Date.now() - lastFeedAt < FEED_COOLDOWN_MS) return { skipped: true, reason: 'cooldown' };
      const overview = await getPetOverview({ lease });
      if (!overview.dogs.some(dog => dog.owned === true)) return { skipped: true, reason: 'no_owned_pet' };
      const currentSeconds = toNum(overview.foodSeconds), maxSeconds = Math.min(MAX_PROTECT_SECONDS, toNum(overview.protectSeconds));
      if (currentSeconds >= thresholdMin * 60) return { skipped: true, reason: 'above_threshold', protectSeconds: currentSeconds };
      let counts = await readBagFoodCounts(lease), foodId = pickFeedableFood(counts, currentSeconds, maxSeconds), bought = 0;
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
      let operation;
      try {
        const fed = await feedDog(foodId, 1, { lease, source: 'food', validate: () => readConfig().enabled,
          onBeforeWrite: () => { operation = beginOperation('feed', { foodId, count: 1 }); } });
        if (fed.skipped) return { ...fed, bought };
        if (!operation) throw unknownFoodResult('喂食单次记录未建立，请保留现场核对');
        lastFeedAt = Date.now();
        completeOperation(operation, { lastFeedAt });
        return { skipped: false, fed: 1, bought, foodId, protectSeconds: toNum(fed.foodSeconds) };
      } catch (error) { settleDefinitiveFailure(operation, error); throw error; }
    }, { source: 'food', timeoutMs: options.timeoutMs, validate: options.validate, detached: options.detached === true });
  } catch (error) { request = Promise.reject(error); }
  pendingFeed = request.then(recordCheck).catch(error => {
    recordCheck({ result: 'error', error: error.message, errorCode: error.errorCode, resultState: error.resultState,
      sent: error.sent, outcomeUnknown: error.outcomeUnknown });
    logWarn('宠物', `自动狗粮失败: ${error.message}`, { module: 'pet', event: 'pet_food_auto_feed', result: 'error', outcome: error.outcome,
      error: error.message, errorCode: error.errorCode, sent: error.sent, resultState: error.resultState, outcomeUnknown: error.outcomeUnknown });
    if (error.writeSent || error.sent) lastFeedAt = Date.now();
    throw error;
  }).finally(() => { pendingFeed = null; });
  return pendingFeed;
}
module.exports = { DOG_FOOD_MALL_GOODS_ID, FEED_COOLDOWN_MS, checkAndFeedPetFood, getPetFoodAutomationState };
