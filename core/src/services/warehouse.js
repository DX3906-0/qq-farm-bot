/**
 * 仓库服务 - 背包管理、果实出售、化肥使用
 *
 * 功能：
 * - 获取背包/背包详情
 * - 批量/单个出售作物果实
 * - 使用物品（含 protobuf raw 回退）
 * - 自动使用化肥礼包
 * - 化肥容器时间计算
 */
const {
  getFruitName,
  getPlantByFruitId,
  getPlantBySeedId,
  getItemById,
  getItemImageById,
  getSeedLevel,
  getSeedImageBySeedId,
  isSeedItem,
} = require('../config/gameConfig');
const { isAutomationOn } = require('../models/store');
const { sendMsgAsync, networkEvents, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, sleep } = require('../utils/utils');
const { updateStatusGold } = require('./status');
const { createGameCommandScope, quantity, positiveId, validation, unknown } = require('./game-command');
const itemCommands = createGameCommandScope('warehouse');
const isItemLocked = item => item?.locked === true || item?.locked === 1 || item?.locked === '1';

// ---- 常量 ----

// 批量出售大小
const SELL_BATCH_SIZE = 15;

// 化肥容器上限（小时）
const FERTILIZER_CONTAINER_LIMIT_HOURS = 990;

// 容器物品 ID
const NORMAL_CONTAINER_ID = 1011;
const ORGANIC_CONTAINER_ID = 1012;

// 化肥相关物品 ID 集合
const FERTILIZER_RELATED_IDS = new Set([
  100003, 100004, 100005, 100006, 100007, 100008, 100009, 100010, 100011, 100012,
]);

// 普通化肥每小时提供时间（按物品 ID）
// 79873→1h, 80514→4h, 80003→8h, 80132→12h
const NORMAL_FERTILIZER_ITEM_HOURS = new Map([
  [79873, 1],
  [80514, 4],
  [80003, 8],
  [80132, 12],
]);

// 有机化肥每小时提供时间（按物品 ID）
// 80011→1h, 80012→4h, 80013→8h, 80014→12h
const ORGANIC_FERTILIZER_ITEM_HOURS = new Map([
  [80011, 1],
  [80012, 4],
  [80013, 8],
  [80014, 12],
]);

// ---- 状态追踪 ----

let fertilizerGiftDoneDateKey = '';
let fertilizerGiftLastOpenAt = 0;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---- RPC 调用 ----

async function getBag() {
  const request = types.BagRequest.encode(types.BagRequest.create({})).finish();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', request);
  return types.BagReply.decode(body);
}

function toSellItem(raw) {
  const id = positiveId(raw?.id, '物品编号');
  const count = quantity(raw?.count);
  const uid = quantity(raw?.uid);
  if (BigInt(count) <= 0n) throw validation('出售数量必须大于零');
  const item = { id: String(id), count };
  if (uid !== '0') item.uid = uid;
  return item;
}

async function sellItems(items) {
  const normalized = items.map(toSellItem);
  const latest = getBagItems(await getBag());
  for (const request of normalized) {
    const candidates = latest.filter(item => String(item.id) === request.id && (!request.uid || quantity(item.uid) === request.uid));
    if (!candidates.length || candidates.some(isItemLocked)) throw validation('待售物品不存在或已锁定，禁止出售');
  }
  const request = types.SellRequest.encode(types.SellRequest.fromObject({ items: normalized })).finish();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', request);
  return types.SellReply.decode(body);
}

/** 使用当前官方嵌套协议，只发送一次，锁定实例不参与使用。 */
async function useItem(itemId, count = 1, landIds = [], requestedUid) {
  const id = positiveId(itemId, '物品编号');
  const amount = quantity(count);
  if (BigInt(amount) <= 0n) throw validation('使用数量必须大于零');
  if (id === 6001) return require('./firework-use').useFirework(Number(amount), requestedUid);
  return itemCommands.execute(async session => {
    const bag = await getBag();
    const candidates = getBagItems(bag).filter(item => toNum(item.id) === id && !isItemLocked(item));
    const item = requestedUid == null
      ? candidates.find(entry => BigInt(quantity(entry.count)) >= BigInt(amount))
      : candidates.find(entry => quantity(entry.uid) === quantity(requestedUid));
    if (!item || BigInt(quantity(item.count)) < BigInt(amount)) throw validation('物品不存在、已锁定或可用数量不足');
    const uid = quantity(item.uid);
    const key = `use:${uid}:${id}`;
    const reply = await itemCommands.rpc(session, 'gamepb.itempb.ItemService', 'Use', 'UseRequest', 'UseReply', {
      item: { id: String(id), count: amount, uid },
      target: { host_gid: session.gid, land_ids: (landIds || []).map(value => String(positiveId(value, '土地编号'))), use_config_id: 0 },
    }, { write: true, key });
    const confirmed = (reply.used_items || []).some(entry => toNum(entry.id) === id && BigInt(quantity(entry.count)) === BigInt(amount));
    if (!confirmed) throw unknown('物品使用回包未确认本次消耗，请只刷新背包核对');
    itemCommands.confirm(session, key);
    const rewards = (reply.items || []).filter(entry => toNum(entry.id) > 0 && toNum(entry.count) > 0).map(entry => ({
      id: toNum(entry.id), count: toNum(entry.count), name: getItemById(toNum(entry.id))?.name || `物品${toNum(entry.id)}`,
      image: getItemImageById(toNum(entry.id)) || '',
    }));
    return { ...reply, rewards, resultState: 'completed', usedItemId: id, usedCount: Number(amount), accountId: session.accountId };
  });
}

/** Locks are instance-specific, never inferred from an item name or an aggregated count. */
async function setItemsLocked(itemUids, locked) {
  if (typeof locked !== 'boolean' || !Array.isArray(itemUids) || itemUids.length === 0 || itemUids.length > 50) throw validation('请选择1至50个物品实例并指定锁定状态');
  const uids = itemUids.map(value => quantity(value, '物品UID'));
  if (uids.some(uid => uid === '0') || new Set(uids).size !== uids.length) throw validation('物品UID无效或重复');
  return itemCommands.execute(async session => {
    const items = getBagItems(await getBag());
    const actionable = [];
    for (const uid of uids) {
      const item = items.find(entry => quantity(entry.uid) === uid);
      if (!item || ![5, 6, 17].includes(Number(getItemById(toNum(item.id))?.type))) throw validation('物品不存在或该类型不能锁定');
      if (isItemLocked(item) !== locked) actionable.push(uid);
    }
    if (!actionable.length) return { skipped: true, reason: 'already_in_target_state', changed: 0 };
    const method = locked ? 'LockItems' : 'UnlockItems';
    const key = 'lock-state';
    const reply = await itemCommands.rpc(session, 'gamepb.itempb.ItemService', method, `${method}Request`, `${method}Reply`,
      { item_uids: actionable }, { write: true, key, allowEmpty: true });
    let confirmed = new Set((reply.item_uids || []).map(value => quantity(value)));
    if (!actionable.every(uid => confirmed.has(uid))) {
      const after = getBagItems(await getBag());
      confirmed = new Set(after.filter(item => isItemLocked(item) === locked).map(item => quantity(item.uid)));
    }
    if (!actionable.every(uid => confirmed.has(uid))) throw unknown('物品锁定状态未全部确认，请只刷新背包核对');
    itemCommands.confirm(session, key);
    return { changed: actionable.length, itemUids: actionable, locked, resultState: 'completed', accountId: session.accountId };
  });
}

async function batchUseItems(entries) {
  const items = (entries || []).map((e) => ({
    id: toLong(e.itemId),
    count: toLong(e.count || 1),
    uid: toLong(e.uid || 0),
  }));

  const request = types.BatchUseRequest.encode(
    types.BatchUseRequest.create({ items })
  ).finish();

  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'BatchUse', request);
  return types.BatchUseReply.decode(body);
}

// ---- 数据解析 ----

function isFruitItemId(id) {
  return !!getPlantByFruitId(Number(id));
}

/**
 * 从背包回复中提取物品列表
 */
function getBagItems(reply) {
  if (reply && reply.item_bag && reply.item_bag.items && reply.item_bag.items.length) {
    return reply.item_bag.items;
  }
  return reply && reply.items ? reply.items : [];
}

/**
 * 判断是否为化肥相关物品
 */
function isFertilizerRelatedItemId(itemId) {
  const id = Number(itemId) || 0;
  if (id <= 0) return false;
  if (id === 1001 || id === 1002) return false;
  if (FERTILIZER_RELATED_IDS.has(id)) return true;

  const info = getItemById(id);
  if (!info || typeof info !== 'object') return false;
  const interactionType = String(info.interaction_type || '').toLowerCase();
  return interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
}

/**
 * 从背包物品中收集化肥类物品的使用负载
 */
function collectFertilizerUsePayload(items) {
  const map = new Map();
  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = Math.max(0, toNum(item && item.count));
    if (id <= 0 || count <= 0 || isItemLocked(item)) continue;
    if (!isFertilizerRelatedItemId(id)) continue;
    map.set(id, (map.get(id) || 0) + count);
  }
  return Array.from(map.entries()).map(([id, count]) => ({ id, count }));
}

/**
 * 从背包物品计算化肥容器剩余时间（小时）
 */
function getContainerHoursFromBagItems(items) {
  let normal = 0;
  let organic = 0;

  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = Math.max(0, toNum(item && item.count));
    if (id === NORMAL_CONTAINER_ID) normal = count;
    if (id === ORGANIC_CONTAINER_ID) organic = count;
  }

  // 容器值存储为秒，转换为小时
  return {
    normal: normal / 3600,
    organic: organic / 3600,
  };
}

/**
 * 获取化肥物品类型和每小时提供时间
 */
function getFertilizerItemTypeAndHours(itemId) {
  const id = Number(itemId) || 0;

  if (NORMAL_FERTILIZER_ITEM_HOURS.has(id)) {
    return { type: 'normal', perItemHours: NORMAL_FERTILIZER_ITEM_HOURS.get(id) };
  }
  if (ORGANIC_FERTILIZER_ITEM_HOURS.has(id)) {
    return { type: 'organic', perItemHours: ORGANIC_FERTILIZER_ITEM_HOURS.get(id) };
  }

  const info = getItemById(id) || {};
  const interactionType = String(info.interaction_type || '').toLowerCase();
  const name = String(info.name || '');

  // 从名称解析真实时长（如 "化肥(4小时)" -> 4），避免 fallback 写死成 1 小时
  const hourMatch = name.match(/(\d+)\s*小时/);
  const hours = hourMatch ? Number(hourMatch[1]) : 1;

  if (interactionType === 'fertilizer') return { type: 'normal', perItemHours: hours };
  if (interactionType === 'fertilizerpro') return { type: 'organic', perItemHours: hours };

  return { type: 'other', perItemHours: 0 };
}

/**
 * 判断是否为容器已满错误
 */
function isFertilizerContainerFullError(err) {
  const msg = String(err && err.message || '');
  return (
    msg.includes('code=1003002') ||
    msg.includes('普通化肥容器已达到上限') ||
    msg.includes('普通化肥容器已满') ||
    msg.includes('有机化肥容器已达到上限') ||
    msg.includes('有机化肥容器已满')
  );
}

// ---- 自动使用化肥 ----

/**
 * 从批量使用回包里统计某个物品实际被使用掉的数量
 * BatchUseReply: used_items(1) / items(2)，二者均为 corepb.Item
 */
function sumUsedFromReply(reply, itemId) {
  if (!reply) return 0;
  const arr = reply.used_items || reply.items || [];
  let sum = 0;
  for (const it of arr) {
    const id = toNum(it && (it.id != null ? it.id : it.item_id));
    if (Number(id) === Number(itemId)) sum += Math.max(0, toNum(it.count));
  }
  return sum;
}

async function autoOpenFertilizerGiftPacks() {
  try {
    // 幂等保护：当天已经成功处理过则跳过，避免高频 tick（每 3~5 秒）反复触发刷屏
    if (fertilizerGiftDoneDateKey === getDateKey()) return 0;

    const bag = await getBag();
    const items = getBagItems(bag);
    const payloads = collectFertilizerUsePayload(items);

    if (payloads.length <= 0) return 0;

    const containerHours = getContainerHoursFromBagItems(items);
    let totalUsed = 0;
    const usedLabels = [];

    for (const payload of payloads) {
      const itemId = Number(payload.id) || 0;
      let count = Math.max(0, Number(payload.count) || 0);
      const { type, perItemHours } = getFertilizerItemTypeAndHours(itemId);

      // 自适应调整使用量（不超过容器上限）
      if (type === 'normal' || type === 'organic') {
        const current = type === 'normal' ? containerHours.normal : containerHours.organic;
        if (current >= FERTILIZER_CONTAINER_LIMIT_HOURS) continue;

        if (perItemHours > 0) {
          const maxNeeded = Math.max(0, FERTILIZER_CONTAINER_LIMIT_HOURS - current);
          const maxByHours = Math.floor(maxNeeded / perItemHours);
          count = Math.max(0, Math.min(count, maxByHours));
          if (count <= 0) continue;
        }
      }

      const info = getItemById(itemId);
      const label = info && info.name ? String(info.name) : `物品#${itemId}`;

      let used = 0;
      try {
        const reply = await batchUseItems([{ itemId, count, uid: 0 }]);
        used = sumUsedFromReply(reply, itemId);
      } catch (e) {
        // 容器已满等明确错误：停止后续循环，避免无效重试刷屏
        if (isFertilizerContainerFullError(e)) {
          fertilizerGiftDoneDateKey = getDateKey();
          fertilizerGiftLastOpenAt = Date.now();
          return totalUsed;
        }
        used = 0;
      }

      if (used > 0) {
        totalUsed += used;
        usedLabels.push(`${label}x${used}`);

        if (type === 'normal' && perItemHours > 0) containerHours.normal += used * perItemHours;
        if (type === 'organic' && perItemHours > 0) containerHours.organic += used * perItemHours;
      } else {
        // 实际未消耗（容器已满/请求无效）：当天不再重试，避免高频无效请求刷屏
        fertilizerGiftDoneDateKey = getDateKey();
        fertilizerGiftLastOpenAt = Date.now();
        break;
      }

      await sleep(100);
    }

    if (totalUsed > 0) {
      fertilizerGiftDoneDateKey = getDateKey();
      fertilizerGiftLastOpenAt = Date.now();
      log('仓库', `自动使用化肥类道具 x${totalUsed}${usedLabels.length ? ` [${usedLabels.join('，')}]` : ''}`, {
        module: 'warehouse', event: '开启化肥礼包', result: 'ok', count: totalUsed,
      });
    }

    return totalUsed;
  } catch (err) {
    if (isFertilizerContainerFullError(err)) return 0;
    logWarn('仓库', `开启化肥礼包失败: ${err.message}`, {
      module: 'warehouse', event: '开启化肥礼包', result: 'error',
    });
    return 0;
  }
}

async function openFertilizerGiftPacksSilently() {
  return autoOpenFertilizerGiftPacks();
}

// ---- 金币计算 ----

/**
 * 从物品列表获取金币数量（ID=1001）
 */
function getGoldFromItems(items) {
  for (const item of items || []) {
    const id = toNum(item.id);
    if (id === 1001 || id === 500001) {
      const count = toNum(item.count);
      if (count > 0) return count;
    }
  }
  return 0;
}

/**
 * 从出售回复推导金币变动
 */
function deriveGoldGainFromSellReply(reply, prevGold) {
  // 尝试 get_items 字段
  const getItemsGold = getGoldFromItems(reply && reply.get_items || []);
  if (getItemsGold > 0) {
    return { gain: getItemsGold, nextKnownGold: prevGold };
  }

  // 回退：items / sell_items
  const itemsGold = getGoldFromItems(reply && (reply.items || reply.sell_items) || []);
  if (itemsGold <= 0) return { gain: 0, nextKnownGold: prevGold };

  if (prevGold > 0 && itemsGold >= prevGold) {
    return { gain: itemsGold - prevGold, nextKnownGold: itemsGold };
  }

  return { gain: itemsGold, nextKnownGold: prevGold };
}

function getCurrentTotals() {
  const state = getUserState() || {};
  return {
    gold: Number(state.gold || 0),
    exp: Number(state.exp || 0),
  };
}

async function getCurrentTotalsFromBag() {
  const bag = await getBag();
  const items = getBagItems(bag);
  let gold = null;
  let exp = null;
  for (const item of items) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (id === 1001 || id === 500001) gold = count;
    if (id === 1002 || id === 500002) exp = count;
  }
  return { gold, exp };
}

// ---- 背包详情 ----

async function getBagDetail() {
  const bag = await getBag();
  const items = getBagItems(bag);

  // 原始物品列表
  const originalItems = [];
  for (const item of items || []) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    const uid = toNum(item.uid);
    if (id <= 0 || count <= 0) continue;
    originalItems.push({ id, count, uid: quantity(item.uid), locked: isItemLocked(item) });
  }

  // 按 ID 去重合并
  const merged = new Map();
  for (const item of items || []) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (id <= 0 || count <= 0) continue;

    const info = getItemById(id) || null;
    const seedPlant = getPlantBySeedId(id);
    let name = info && info.name ? String(info.name) : '';
    let category = 'item';

    if (id === 1001 || id === 500001) { name = '金币'; category = 'gold'; }
    else if (id === 1002 || id === 500002) { name = '经验'; category = 'exp'; }
    else if (getPlantByFruitId(id)) {
      if (!name) name = `${getFruitName(id)  }果实`;
      category = 'fruit';
    } else if (seedPlant) {
      if (!name) name = `${seedPlant.name || '未知'  }种子`;
      category = 'seed';
    }

    if (!name) name = `物品${  id}`;

    const interactionType = info && info.interaction_type ? String(info.interaction_type) : '';
    const priceId = info ? Number(info.price_id) || 0 : 0;
    const priceUnit =
      priceId === 1005 ? '金豆豆' :
      priceId === 200 ? '点券' : '金';

    // Keep locked/unlocked stacks separate; UID is retained for instance actions.
    const groupKey = quantity(item.uid) !== '0' ? `uid:${quantity(item.uid)}` : `id:${id}:${isItemLocked(item)}`;
    if (!merged.has(groupKey)) {
      merged.set(groupKey, {
        id,
        uid: quantity(item.uid),
        groupKey,
        locked: isItemLocked(item),
        count: 0,
        name,
        image: getItemImageById(id),
        category,
        itemType: info ? Number(info.type) || 0 : 0,
        priceId,
        price: info ? Number(info.price) || 0 : 0,
        priceUnit,
        level: info ? Number(info.level) || 0 : 0,
        plantSize: seedPlant ? Math.max(1, Number(seedPlant.size || 1)) : 1,
        interactionType,
        hoursText: '',
      });
    }
    merged.get(groupKey).count += count;
  }

  // 计算容器时间显示
  const resultItems = Array.from(merged.values()).map((entry) => {
    if (entry.interactionType === 'fertilizerbucket' && entry.count > 0) {
      const hours = Math.floor(entry.count / 3600 * 10) / 10;
      entry.hoursText = `${hours.toFixed(1)  }小时`;
    }
    return entry;
  });

  // 排序：按物品类型排序，同类型按数量降序
  const typeOrder = new Map([[1, 1], [2, 2], [4, 3]]);
  resultItems.sort((a, b) => {
    const typeA = Number(a.itemType || 0);
    const typeB = Number(b.itemType || 0);
    const orderA = typeOrder.has(typeA) ? typeOrder.get(typeA) : (typeA > 0 ? 1000 + typeA : Number.MAX_SAFE_INTEGER);
    const orderB = typeOrder.has(typeB) ? typeOrder.get(typeB) : (typeB > 0 ? 1000 + typeB : Number.MAX_SAFE_INTEGER);
    if (orderA !== orderB) return orderA - orderB;
    const countB = Number(b.count || 0);
    const countA = Number(a.count || 0);
    if (countB !== countA) return countB - countA;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  return {
    totalKinds: resultItems.length,
    items: resultItems,
    originalItems,
  };
}

// ---- 出售果实 ----

/**
 * 出售所有果实
 */
async function sellAllFruits() {
  const sellEnabled = isAutomationOn('sell');
  if (!sellEnabled) return;

  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    const fruits = [];

    for (const item of items) {
      const id = toNum(item.id);
      const count = toNum(item.count);
      if (isFruitItemId(id) && count > 0 && !isItemLocked(item)) {
        fruits.push(item);
      }
    }

    if (fruits.length === 0) {
      log('仓库', '无果实可出售');
      return;
    }

    const totalsBefore = getCurrentTotals();
    const prevGold = totalsBefore.gold;
    let totalGoldFromReply = 0;
    let derivedGold = prevGold;
    const soldLabels = [];
    let soldKindCount = 0;
    let soldTotalCount = 0;
    let skippedKindCount = 0;

    function recordSoldFruit(item) {
      const id = toNum(item.id);
      const count = toNum(item.count);
      soldLabels.push(`${getFruitName(id)  }x${  count}`);
      soldKindCount += 1;
      soldTotalCount += count;
    }

    // 批量出售
    for (let i = 0; i < fruits.length; i += SELL_BATCH_SIZE) {
      const batch = fruits.slice(i, i + SELL_BATCH_SIZE);
      try {
        const sellResult = await sellItems(batch);
        const derived = deriveGoldGainFromSellReply(sellResult, derivedGold);
        const gain = Math.max(0, toNum(derived.gain));
        derivedGold = derived.nextKnownGold;
        if (gain > 0) totalGoldFromReply += gain;
        batch.forEach(recordSoldFruit);
      } catch (err) {
        // 批量失败，逐个重试
        logWarn('仓库', `批量出售失败，改为逐个重试: ${err.message}`);
        for (const fruit of batch) {
          try {
            const result = await sellItems([fruit]);
            const derived = deriveGoldGainFromSellReply(result, derivedGold);
            const gain = Math.max(0, toNum(derived.gain));
            derivedGold = derived.nextKnownGold;
            if (gain > 0) totalGoldFromReply += gain;
            recordSoldFruit(fruit);
          } catch (innerErr) {
            const fid = toNum(fruit.id);
            const fcount = toNum(fruit.count);
            skippedKindCount += 1;
            logWarn('仓库', `跳过不可售物品: ID=${fid} x${fcount} (${innerErr.message})`, {
              module: 'warehouse', event: '跳过不可售物品', result: 'skip', itemId: fid, count: fcount,
            });
          }
        }
      }
      if (i + SELL_BATCH_SIZE < fruits.length) await sleep(300);
    }

    // 等待金币更新
    let finalGold = prevGold;
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
      const state = getUserState();
      const stateGold = state && state.gold ? state.gold : finalGold;
      if (stateGold !== prevGold) { finalGold = stateGold; break; }
      await sleep(200);
    }

    const totalsAfter = getCurrentTotals();
    const goldByState = finalGold > prevGold ? finalGold - prevGold : 0;
    const goldDelta = totalsAfter.gold - totalsBefore.gold;
    const expDelta = totalsAfter.exp - totalsBefore.exp;

    // 金币结算：优先用状态差值，回退到出售响应
    let bagGoldGain = 0;
    if (goldByState <= 0 && totalGoldFromReply <= 0) {
      try {
        const bagAfter = await getBag();
        const bagGold = getGoldFromItems(getBagItems(bagAfter));
        if (bagGold > prevGold) bagGoldGain = bagGold - prevGold;
      } catch (_) {}
    }

    const totalGoldGain = Math.max(totalGoldFromReply, goldByState, bagGoldGain);

    // 若状态未更新但出售有响应，手动修正状态
    if (goldByState <= 0 && totalGoldGain > 0) {
      const state = getUserState();
      if (state) {
        state.gold = Number(state.gold || 0) + totalGoldGain;
        updateStatusGold(state.gold);
      }
    }

    if (soldLabels.length === 0) {
      logWarn('仓库', `本轮果实出售未成功${skippedKindCount > 0 ? `，已跳过 ${skippedKindCount} 个不可售物品` : ''}`, {
        module: 'warehouse',
        event: 'sell_done',
        result: 'skipped',
        count: 0,
        skippedCount: skippedKindCount,
        totalsBefore,
        totalsAfter,
        totalsDeltaGold: goldDelta,
        totalsDeltaExp: expDelta,
      });
      return;
    }

    log('仓库', `出售 ${soldLabels.join(', ')}${skippedKindCount > 0 ? `，跳过 ${skippedKindCount} 个不可售物品` : ''}${totalGoldGain > 0 ? `，获得 ${totalGoldGain} 金币` : ''}`, {
      module: 'warehouse',
      event: totalGoldGain > 0 ? 'sell_success' : 'sell_done',
      result: totalGoldGain > 0 ? 'ok' : 'unknown_gain',
      count: soldKindCount,
      soldCount: soldTotalCount,
      skippedCount: skippedKindCount,
      gold: totalGoldGain,
      totalsBefore,
      totalsAfter,
      totalsDeltaGold: goldDelta,
      totalsDeltaExp: expDelta,
    });

    if (totalGoldGain > 0) {
      networkEvents.emit('sell', { gold: totalGoldGain, count: soldTotalCount });
    }
  } catch (err) {
    logWarn('仓库', `出售失败: ${err.message}`);
  }
}

// ---- 种子列表 ----

/**
 * 获取背包中的种子列表
 */
async function getBagSeeds() {
  const bag = await getBag();
  const items = getBagItems(bag);
  const seedMap = new Map();
  const fallbackSeedIds = [];

  for (const item of items || []) {
    const id = toNum(item && item.id);
    const count = toNum(item && item.count);
    if (id <= 0 || count <= 0 || isItemLocked(item)) continue;

    const plant = getPlantBySeedId(id);
    const info = getItemById(id) || null;
    const interactionType = String(info && info.interaction_type || '').toLowerCase();
    const seedLike = !!plant || isSeedItem(id) || interactionType === 'plant';
    if (!seedLike) continue;

    if (!plant && fallbackSeedIds.length < 20) fallbackSeedIds.push(id);

    const rawName = plant && plant.name ? String(plant.name) : String(info && info.name || `??#${id}`);
    const name = rawName.endsWith('??') ? rawName.slice(0, -2) : rawName;
    const requiredLevel = plant
      ? Math.max(0, Number(plant.land_level_need || 0))
      : Math.max(0, Number(info && info.level || getSeedLevel(id) || 0));
    const plantSize = plant ? Math.max(1, Number(plant.size || 1)) : 1;

    const existing = seedMap.get(id) || {
      seedId: id,
      name,
      count: 0,
      requiredLevel,
      image: getSeedImageBySeedId(id) || getItemImageById(id),
      plantSize,
    };
    existing.count += count;
    seedMap.set(id, existing);
  }

  if (fallbackSeedIds.length > 0) {
    log('warehouse', `bag seed fallback detection: ${fallbackSeedIds.join(',')}`, {
      module: 'warehouse', event: 'bag_seed_detect', result: 'fallback', count: fallbackSeedIds.length,
    });
  }

  return Array.from(seedMap.values());
}

// ---- ?? ----
module.exports = {
  getBag,
  getBagDetail,
  sellItems,
  useItem,
  setItemsLocked,
  isItemLocked,
  batchUseItems,
  openFertilizerGiftPacksSilently,
  getFertilizerGiftDailyState: () => ({
    key: 'fertilizer_gift_open',
    doneToday: fertilizerGiftDoneDateKey === getDateKey(),
    lastOpenAt: fertilizerGiftLastOpenAt,
  }),
  sellAllFruits,
  getBagItems,
  getCurrentTotalsFromBag,
  getBagSeeds,
  getContainerHoursFromBagItems,
};
