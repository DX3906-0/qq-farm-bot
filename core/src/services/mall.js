/**
 * 商城服务 - 化肥购买、免费礼包领取
 *
 * 功能：
 * - 获取商城商品列表
 * - 购买商品（含价格/限购解析）
 * - 自动购买有机/无机化肥（按余额自适应）
 * - 每日免费礼包领取
 * - 根据化肥容器剩余时间阈值自动补货
 */
const { Buffer } = require('node:buffer');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, sleep } = require('../utils/utils');

// ---- 商品 ID 常量 ----

const ORGANIC_FERTILIZER_MALL_GOODS_ID = 1002;   // 有机化肥
const INORGANIC_FERTILIZER_MALL_GOODS_ID = 1003;  // 无机化肥

// 两次购买最小间隔：10分钟
const BUY_COOLDOWN_MS = 10 * 60 * 1000;

// 购买轮次：100轮（防止无限循环）
const MAX_ROUNDS = 100;

// 每轮购买数量：10个
const BUY_PER_ROUND = 10;

// 每日免费礼包 Key
const FREE_GIFTS_DAILY_KEY = 'mall_free_gifts';

// ---- 状态追踪 ----

let lastBuyAt = 0;
let buyDoneDateKey = '';
let buyLastSuccessAt = 0;
let buyPausedNoGoldDateKey = '';

let freeGiftDoneDateKey = '';
let freeGiftLastAt = 0;
let freeGiftLastCheckAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- RPC 调用 ----

async function getMallListBySlotType(slotType = 1, options = {}) {
  // 2026-11-03：官方 request 有 is_manual_open(2) / global_scene_id(3, 1=农场)。
  // ⚠️ 实测：这两个字段**不传**时服务端正常返回商品；显式传 global_scene_id=1
  // 会导致列表变空（服务端把未开启的场景过滤掉了）。所以只在明确指定时才带上。
  const payload = { slot_type: Number(slotType) || 1 };
  if (options.globalSceneId != null) payload.global_scene_id = Number(options.globalSceneId) || 0;
  if (options.manualOpen === true) payload.is_manual_open = true;

  const request = types.GetMallListBySlotTypeRequest.encode(
    types.GetMallListBySlotTypeRequest.create(payload)
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMallListBySlotType', request);
  return types.GetMallListBySlotTypeResponse.decode(body);
}

async function purchaseMallGoods(goodsId, count = 1) {
  const request = types.PurchaseRequest.encode(
    types.PurchaseRequest.create({
      goods_id: Number(goodsId) || 0,
      count: Number(count) || 1,
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'Purchase', request);
  return types.PurchaseResponse.decode(body);
}

/**
 * 获取指定槽位的商品列表
 */
async function getMallGoodsList(slotType = 1) {
  const reply = await getMallListBySlotType(slotType);
  const rawList = Array.isArray(reply && reply.goods_list) ? reply.goods_list : [];

  // 2026-11-03：官方 proto 里 goods_list 已经是 repeated MallGoods（结构化），
  // protobufjs 解码时已递归解成对象。旧代码把它当 bytes 再 decode 一次 →
  // 必然抛错 → 被 catch 静默吞掉 → 商城永远返回空数组（"没有商品"的真凶）。
  const goodsList = [];
  for (const raw of rawList) {
    if (!raw) continue;
    // 兼容两种形态：已是对象直接用；旧版可能是 bytes
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      try {
        goodsList.push(types.MallGoods.decode(raw));
      } catch {
        // 单条解码失败不影响其余
      }
    } else {
      goodsList.push(raw);
    }
  }
  return goodsList;
}

// ---- 字节解析工具 ----

function bytesToBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || (value.constructor && value.constructor.name === 'Uint8Array')) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'object') {
    const numKeys = Object.keys(value).filter((k) => /^\d+$/.test(k));
    numKeys.sort((a, b) => Number(a) - Number(b));
    if (numKeys.length === 0) return null;
    return Buffer.from(numKeys.map((k) => value[k]));
  }
  return null;
}

/**
 * 读取一个 varint（用乘法而非位运算，避免 32 位截断导致大数值变负）。
 * @returns {{value: number, pos: number}}
 */
function readVarint(buf, pos) {
  let value = 0;
  let mul = 1;
  while (pos < buf.length) {
    const b = buf[pos++];
    value += (b & 0x7F) * mul;
    if ((b & 0x80) === 0) break;
    mul *= 128;
  }
  return { value, pos };
}

/**
 * 解析商城价格字段。
 *
 * `MallGoods.price` 在 proto 里是 `bytes`，实际内容是 PriceInfo 结构：
 *   field 1 = 货币道具 id（1001=金币 1002=点券 1005=金豆 …）
 *   field 2 = 数量
 *   field 3 = balance（余额，通常不下发）
 *
 * ⚠️ 2026-11-02 修正：旧实现只读了 field 1 就当成价格返回，
 * 于是「价格」实际是货币 id（1/2/3…），除少数巧合外全部错。
 * 现在返回数量（field 2）；若只有单个裸 varint（非嵌套结构）则原样返回。
 */
function parseMallPriceValue(raw) {
  if (raw == null) return 0;
  if (typeof raw === 'number') return Math.max(0, Math.floor(raw));

  const buf = bytesToBuffer(raw);
  if (!buf || !buf.length) return 0;

  let pos = 0;
  let single = 0;
  let fieldCount = 0;
  let currencyId = 0;
  let count = 0;

  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (wireType !== 0) break; // 只处理 varint 字段
    const r = readVarint(buf, pos);
    pos = r.pos;
    fieldCount += 1;
    if (fieldNum === 1) currencyId = r.value;
    else if (fieldNum === 2) count = r.value;
    single = r.value;
  }

  // 多字段：标准 PriceInfo，价格取 field 2（数量）
  if (count > 0) return Math.floor(count);
  // 只有 field 1（货币 id）没有数量 → 未定价
  // 单字段同样按官方 PriceInfo 语义理解：field 1 是货币 id，不是价格
  return 0;
}

/**
 * 解析限购信息
 */
function parseMallLimitInfo(raw) {
  const empty = { limitCount: 0, boughtNum: 0, limitType: 0 };
  if (raw == null) return empty;

  const buf = bytesToBuffer(raw);
  if (!buf || !buf.length) return empty;

  // PurchaseLimit 的官方字段编号（mallpb.proto）：
  //   1 = limit_type   (1=每日 2=每周 3=每月 4=永久)
  //   2 = bought_count
  //   3 = limit_count
  // ⚠️ 2026-11-02 修正：旧实现把 field 1 当成 limitCount、且完全没读 field 3，
  //    导致「限购总数」实际是「限购类型」（1~4），前端限购进度全部错乱。
  let pos = 0;
  let limitType = 0;
  let boughtNum = 0;
  let limitCount = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    const fieldNum = byte >> 3;
    const wireType = byte & 0x7;
    if (wireType !== 0) break;
    let value = 0; let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      value |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (fieldNum === 1) limitType = value;
    else if (fieldNum === 2) boughtNum = value;
    else if (fieldNum === 3) limitCount = value;
  }
  return {
    limitCount: Math.max(0, limitCount),
    boughtNum: Math.max(0, boughtNum),
    limitType: Math.max(0, limitType),
  };
}

/**
 * 解析商城物品 ID 列表
 */
function parseMallItemIds(raw) {
  if (raw == null) return [];
  const buf = bytesToBuffer(raw);
  if (!buf || !buf.length) return [];

  const ids = [];
  let pos = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    const fieldNum = byte >> 3;
    const wireType = byte & 0x7;
    if (wireType !== 0) break;
    let value = 0; let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      value |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (fieldNum === 1) ids.push(value);
  }
  return ids;
}

// ---- 商品查找 ----

function findOrganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === ORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findInorganicFertilizerMallGoods(goodsList) {
  const list = Array.isArray(goodsList) ? goodsList : [];
  return list.find((g) => toNum(g && g.goods_id) === INORGANIC_FERTILIZER_MALL_GOODS_ID) || null;
}

function findFertilizerMallGoods(goodsList, type = 'organic') {
  if (type === 'normal') return findInorganicFertilizerMallGoods(goodsList);
  return findOrganicFertilizerMallGoods(goodsList);
}

// ---- 自动购买 ----

/**
 * 通过商城自动购买有机化肥
 */
async function autoBuyOrganicFertilizerViaMall() {
  const goodsList = await getMallGoodsList(1);
  const goods = findOrganicFertilizerMallGoods(goodsList);
  if (!goods) return 0;

  const goodsId = toNum(goods.goods_id);
  if (goodsId <= 0) return 0;

  const price = parseMallPriceValue(goods.price);
  let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
  let totalBought = 0;
  let perRound = BUY_PER_ROUND;

  // 根据余额调整每轮购买量
  if (price > 0 && ticket > 0) {
    perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / price) || 1));
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (price > 0 && ticket > 0 && ticket < price) {
      buyPausedNoGoldDateKey = getDateKey();
      break;
    }

    try {
      await purchaseMallGoods(goodsId, perRound);
      totalBought += perRound;

      if (price > 0 && ticket > 0) {
        ticket = Math.max(0, ticket - price * perRound);
        if (ticket < price) break;
      }
      await sleep(300);
    } catch (err) {
      const msg = String(err && err.message || '');
      log('商城', `购买化肥失败: ${msg}`, {
        module: 'warehouse', event: '购买化肥', result: 'error', error: msg,
      });

      if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
        if (perRound > 1) {
          perRound = 1;
          continue;
        }
        buyPausedNoGoldDateKey = getDateKey();
      }
      break;
    }
  }

  if (totalBought > 0) {
    log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
      module: 'warehouse', event: '购买化肥', result: 'ok', count: totalBought, type: 'organic',
    });
  }
  return totalBought;
}

/**
 * 通过商城自动购买指定类型化肥
 */
async function autoBuyFertilizerViaMall(type = 'organic', targetCount = 0) {
  const typeLabel = type === 'normal' ? '无机化肥' : '有机化肥';
  log('商城', `开始购买化肥, 类型: ${typeLabel}, 数量: ${targetCount || '不限'}`, {
    module: 'warehouse', event: '购买化肥', type, targetCount,
  });

  const goodsList = await getMallGoodsList(1);
  const goods = findFertilizerMallGoods(goodsList, type);
  if (!goods) {
    log('商城', '未找到化肥商品', {
      module: 'warehouse', event: '购买化肥', result: 'error', type, error: '商品不存在',
    });
    return 0;
  }

  const goodsId = toNum(goods.goods_id);
  if (goodsId <= 0) return 0;

  const price = parseMallPriceValue(goods.price);
  let ticket = Math.max(0, toNum((getUserState() || {}).ticket));
  let totalBought = 0;
  let perRound = BUY_PER_ROUND;

  if (price > 0 && ticket > 0) {
    perRound = Math.max(1, Math.min(BUY_PER_ROUND, Math.floor(ticket / price) || 1));
  }

  log('商城', `准备购买化肥: goodsId=${goodsId}, 单价=${price}`, {
    module: 'warehouse', event: '购买化肥', goodsId, singlePrice: price, ticket, perRound,
  });

  const limit = targetCount > 0 ? targetCount : Infinity;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (targetCount > 0 && totalBought >= limit) break;

    if (price > 0 && ticket > 0 && ticket < price) {
      buyPausedNoGoldDateKey = getDateKey();
      break;
    }

    const buyCount = targetCount > 0 ? Math.min(perRound, limit - totalBought) : perRound;

    try {
      await purchaseMallGoods(goodsId, buyCount);
      totalBought += buyCount;

      if (price > 0 && ticket > 0) {
        ticket = Math.max(0, ticket - price * buyCount);
        if (ticket < price) break;
      }
      await sleep(300);
    } catch (err) {
      const msg = String(err && err.message || '');
      log('商城', `购买化肥失败: ${msg}`, {
        module: 'warehouse', event: '购买化肥', result: 'error', error: msg, type,
      });

      if (msg.includes('余额不足') || msg.includes('点券不足') || msg.includes('code=1000019')) {
        if (perRound > 1) {
          perRound = 1;
          continue;
        }
        buyPausedNoGoldDateKey = getDateKey();
      }
      break;
    }
  }

  if (totalBought > 0) {
    log('商城', `购买化肥成功，共购买 ${totalBought} 个`, {
      module: 'warehouse', event: '购买化肥', result: 'ok', count: totalBought, type,
    });
  }

  return totalBought;
}

/**
 * 自动购买有机化肥（带冷却检查）
 */
async function autoBuyOrganicFertilizer(force = false) {
  const now = Date.now();
  if (!force && now - lastBuyAt < BUY_COOLDOWN_MS) return 0;

  lastBuyAt = now;

  try {
    const bought = await autoBuyOrganicFertilizerViaMall();
    if (bought > 0) {
      buyDoneDateKey = getDateKey();
      buyLastSuccessAt = Date.now();
      log('商城', `自动购买有机化肥 x${bought}`, {
        module: 'warehouse', event: '购买化肥', result: 'ok', count: bought,
      });
    }
    return bought;
  } catch {
    return 0;
  }
}

/**
 * 自动购买化肥（带冷却检查，通用版）
 */
async function autoBuyFertilizer(force = false, type = 'organic', targetCount = 0) {
  const now = Date.now();
  if (!force && now - lastBuyAt < BUY_COOLDOWN_MS) return 0;

  lastBuyAt = now;

  try {
    const bought = await autoBuyFertilizerViaMall(type, targetCount);
    if (bought > 0) {
      buyDoneDateKey = getDateKey();
      buyLastSuccessAt = Date.now();
      const label = type === 'normal' ? '无机化肥' : '有机化肥';
      log('商城', `自动购买${label} x${bought}`, {
        module: 'warehouse', event: '购买化肥', result: 'ok', count: bought, type,
      });
    }
    return bought;
  } catch {
    return 0;
  }
}

// ---- 免费礼包 ----

function isDoneTodayByKey(dateKey) {
  return String(dateKey || '') === getDateKey();
}

/**
 * 自动购买免费礼包
 */
async function buyFreeGifts(force = false) {
  const now = Date.now();

  if (!force && isDoneTodayByKey(freeGiftDoneDateKey)) return 0;
  if (!force && now - freeGiftLastCheckAt < BUY_COOLDOWN_MS) return 0;

  freeGiftLastCheckAt = now;

  try {
    // 抓包显示“每日福利”(goodsId=1001)位于 slot_type=1。
    // 旧实现请求 slot_type=2，导致自动任务无法找到免费商品。
    const reply = await getMallListBySlotType(1);
    const rawList = Array.isArray(reply && reply.goods_list) ? reply.goods_list : [];
    const goodsList = [];

    // 2026-11-03：goods_list 已是 repeated MallGoods（结构化），不能再当 bytes decode
    for (const raw of rawList) {
      if (!raw) continue;
      if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
        try { goodsList.push(types.MallGoods.decode(raw)); } catch { /* skip */ }
      } else {
        goodsList.push(raw);
      }
    }

    const freeGoods = goodsList.filter(
      (g) => !!g && g.is_free === true && Number(g.goods_id || 0) > 0
    );

    if (!freeGoods.length) {
      freeGiftDoneDateKey = getDateKey();
      log('商城', '今日暂无可领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
      return 0;
    }

    let claimed = 0;
    for (const goods of freeGoods) {
      try {
        await purchaseMallGoods(Number(goods.goods_id || 0), 1);
        claimed += 1;
      } catch {
        // skip failed
      }
    }

    freeGiftDoneDateKey = getDateKey();

    if (claimed > 0) {
      freeGiftLastAt = Date.now();
      log('商城', `自动购买免费礼包 x${claimed}`, {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'ok', count: claimed,
      });
    } else {
      log('商城', '本次未成功领取免费礼包', {
        module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'none',
      });
    }

    return claimed;
  } catch (err) {
    log('商城', `领取免费礼包失败: ${err.message}`, {
      module: 'task', event: FREE_GIFTS_DAILY_KEY, result: 'error',
    });
    return 0;
  }
}

// ---- 按阈值补货 ----

/**
 * 根据化肥容器剩余时间阈值自动补货
 */
async function checkAndBuyFertilizerByThreshold(type, count, thresholdHours) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  if (count <= 0 || thresholdHours <= 0) {
    return { bought: 0, message: '参数无效' };
  }

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);
    const currentHours = type === 'normal' ? hours.normal : hours.organic;
    const label = type === 'normal' ? '无机化肥' : '有机化肥';

    log('商城', `检测${label}容器: 剩余 ${currentHours.toFixed(1)} 小时，阈值 ${thresholdHours} 小时`, {
      module: 'mall', event: 'check_fertilizer', type, currentHours, thresholdHours,
    });

    if (currentHours < thresholdHours) {
      const bought = await autoBuyFertilizer(true, type, count);
      return { bought, currentHours, thresholdHours, needed: true };
    }

    return { bought: 0, currentHours, thresholdHours, needed: false };
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    return { bought: 0, error: err.message };
  }
}

/**
 * 同时检查并补充两种化肥
 */
async function checkAndBuyFertilizerBoth(options = {}) {
  const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');

  const {
    buyOrganic = false,
    buyNormal = false,
    organicCount = 0,
    organicThresholdHours = 0,
    normalCount = 0,
    normalThresholdHours = 0,
  } = options || {};

  const result = { organicBought: 0, normalBought: 0, organicCurrentHours: 0, normalCurrentHours: 0 };

  if (!buyOrganic && !buyNormal) return result;

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const hours = getContainerHoursFromBagItems(items);

    result.organicCurrentHours = hours.organic;
    result.normalCurrentHours = hours.normal;

    // 有机化肥
    if (buyOrganic && organicCount > 0 && organicThresholdHours > 0) {
      log('商城', `检测有机化肥容器: 剩余 ${hours.organic.toFixed(1)} 小时，阈值 ${organicThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_organic', currentHours: hours.organic, thresholdHours: organicThresholdHours,
      });

      if (hours.organic < organicThresholdHours) {
        result.organicBought = await autoBuyFertilizer(true, 'organic', organicCount);
      }
    }

    // 两次购买之间随机间隔 1~3 秒
    if (buyOrganic && buyNormal && result.organicBought > 0) {
      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);
    }

    // 无机化肥
    if (buyNormal && normalCount > 0 && normalThresholdHours > 0) {
      log('商城', `检测无机化肥容器: 剩余 ${hours.normal.toFixed(1)} 小时，阈值 ${normalThresholdHours} 小时`, {
        module: 'mall', event: 'check_fertilizer_normal', currentHours: hours.normal, thresholdHours: normalThresholdHours,
      });

      if (hours.normal < normalThresholdHours) {
        result.normalBought = await autoBuyFertilizer(true, 'normal', normalCount);
      }
    }

    return result;
  } catch (err) {
    log('商城', `检测化肥容器失败: ${err.message}`, {
      module: 'mall', event: 'check_fertilizer', result: 'error', error: err.message,
    });
    return { ...result, error: err.message };
  }
}

// ---- 导出 ----

module.exports = {
  autoBuyOrganicFertilizer,
  autoBuyFertilizer,
  checkAndBuyFertilizerByThreshold,
  checkAndBuyFertilizerBoth,
  buyFreeGifts,
  getMallGoodsList,
  purchaseMallGoods,
  parseMallPriceValue,
  parseMallLimitInfo,
  parseMallItemIds,

  getFertilizerBuyDailyState: () => ({
    key: 'fertilizer_buy',
    doneToday: buyDoneDateKey === getDateKey(),
    pausedNoGoldToday: buyPausedNoGoldDateKey === getDateKey(),
    lastSuccessAt: buyLastSuccessAt,
  }),

  getFreeGiftDailyState: () => ({
    key: FREE_GIFTS_DAILY_KEY,
    doneToday: freeGiftDoneDateKey === getDateKey(),
    lastCheckAt: freeGiftLastCheckAt,
    lastClaimAt: freeGiftLastAt,
  }),
};
