const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn } = require('../utils/utils');
const { getAutomation } = require('../models/store');
const { pushAlertMessage } = require('./friend-alert');
const { recordMysteryMerchant } = require('./stats');

const SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';
const CURRENCY_NAMES = {
  1001: '金币',
  1002: '点券',
  1005: '金豆豆',
};

// 商人可能在登录完成后才出现，不能只依赖登录时的一次检查。
// 每两分钟一次只读查询：既能保证限时商品进入自动购买，也能及时捕获"中途出现"的
// 神秘商人用于计数与推送（旧值 10 分钟太稀，商人在两次轮询之间出现又消失会被漏掉，导致计数恒为 0）。
const AUTO_BUY_CHECK_INTERVAL_MS = 2 * 60 * 1000;

function normalizeNPC(reply) {
  const npc = reply?.npc;
  const itemId = toNum(npc?.item_id);
  const itemInfo = getItemById(itemId);
  const endTime = toNum(reply?.end_time);
  const purchased = !!npc?.purchased;

  return {
    active: !!reply?.active && !purchased && (!endTime || endTime * 1000 > Date.now()),
    npcId: toNum(npc?.npc_id),
    itemId,
    itemType: toNum(npc?.item_type),
    itemName: itemInfo?.name || `物品${itemId}`,
    itemImage: getItemImageById(itemId),
    itemCount: toNum(npc?.item_count),
    currencyId: toNum(npc?.currency_id),
    currencyName: CURRENCY_NAMES[toNum(npc?.currency_id)] || `货币${toNum(npc?.currency_id)}`,
    price: toNum(npc?.price),
    originalPrice: toNum(npc?.original_price),
    discount: toNum(npc?.discount),
    purchased,
    startTime: toNum(reply?.start_time),
    endTime,
  };
}

async function getActiveMysteryShop() {
  const request = types.GetActiveMysteryNPCRequest.encode(
    types.GetActiveMysteryNPCRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'GetActiveNPC', request);
  return normalizeNPC(types.GetActiveMysteryNPCReply.decode(body));
}

async function buyMysteryShopGoods(npcId) {
  const id = toNum(npcId);
  if (id <= 0) throw new Error('无效的神秘商人 ID');

  const request = types.BuyMysteryShopRequest.encode(
    types.BuyMysteryShopRequest.create({ npc_id: id })
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'Buy', request);
  const reply = types.BuyMysteryShopReply.decode(body);
  return {
    reward: {
      itemId: toNum(reply?.reward?.item_id),
      count: toNum(reply?.reward?.count),
    },
    purchased: !!reply?.npc?.purchased,
  };
}

async function abandonMysteryShop() {
  const request = types.AbandonMysteryShopRequest.encode(
    types.AbandonMysteryShopRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(SERVICE, 'Abandon', request);
  types.AbandonMysteryShopReply.decode(body);
  return { abandoned: true };
}

function isCurrencyAllowed(currencyId, automation = getAutomation() || {}) {
  const keyByCurrency = {
    1001: 'mystery_shop_allow_gold',
    1002: 'mystery_shop_allow_coupon',
    1005: 'mystery_shop_allow_gold_bean',
  };
  const key = keyByCurrency[toNum(currencyId)];
  return !!key && automation[key] === true;
}

// 记录最近遇到的 npcId：同一商人只计 1 次"遇到"，避免轮询重复计数
let lastMysteryNpcId = null;
// 跨天重置去重：神秘商人可能在次日以相同 npcId 再次出现，若不清零会导致次日漏计（日报显示 0）
let lastMysteryDateKey = null;
function getBeijingDateKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function resetMysteryDailyDedupIfNeeded() {
  const today = getBeijingDateKey();
  if (today !== lastMysteryDateKey) {
    lastMysteryDateKey = today;
    lastMysteryNpcId = null;
    lastMysteryPushNpcId = null;
  }
}
function recordMysteryMerchantEncounter(npcId) {
  resetMysteryDailyDedupIfNeeded();
  const id = toNum(npcId);
  if (!id || id === lastMysteryNpcId) return;
  lastMysteryNpcId = id;
  try {
    recordMysteryMerchant(1);
  } catch { /* 统计失败不影响购买流程 */ }
}

// 同一商人只推送一次提醒（无论出现/购买），避免轮询重复刷屏
let lastMysteryPushNpcId = null;

/** 按账号 ID 反查账号名称（用于推送备注是哪一个账号） */
function getAccountName(accountId) {
  try {
    const { getAccounts } = require('../models/store');
    const { accounts = [] } = getAccounts() || {};
    const acc = accounts.find(a => String(a.id) === String(accountId));
    return acc && acc.name ? acc.name : '';
  } catch {
    return '';
  }
}

/** 神秘商人推送（标题即正文，开头备注账号名），按 npcId 去重 */
function maybePushMystery(offer, accountId, accountName, kind) {
  resetMysteryDailyDedupIfNeeded();
  const automation = getAutomation() || {};
  if (automation.mystery_shop_push !== true) return;
  const npcId = toNum(offer.npcId);
  if (!npcId || npcId === lastMysteryPushNpcId) return;
  lastMysteryPushNpcId = npcId;
  const who = accountName || `账号${accountId || '未知'}`;
  const goods = `${offer.itemName} x${offer.itemCount}（${offer.price} ${offer.currencyName}）`;
  let title;
  let content;
  if (kind === 'bought') {
    title = `🛒 ${who} 神秘商人已自动购入`;
    content = goods;
  } else if (kind === 'currency_not_allowed') {
    title = `🔔 ${who} 神秘商人出现（未自动购买）`;
    content = `${goods}｜货币「${offer.currencyName}」未开启自动购买`;
  } else {
    title = `🔔 ${who} 神秘商人出现（待手动）`;
    content = `${goods}｜未开启神秘商人自动购买`;
  }
  pushAlertMessage(title, content).catch(() => {});
}

async function checkAndAutoBuyMysteryShop(accountId) {
  const automation = getAutomation() || {};
  const accountName = getAccountName(accountId);

  try {
    const offer = await getActiveMysteryShop();
    if (!offer.active) {
      lastMysteryNpcId = null;
      lastMysteryPushNpcId = null;
      if (automation.mystery_shop_auto_buy !== true) return { skipped: true, reason: 'disabled' };
      return { skipped: true, reason: 'inactive' };
    }
    // 遇到神秘商人即计数（与自动购买开关无关，用于面板今日统计/日报）
    recordMysteryMerchantEncounter(offer.npcId);

    if (automation.mystery_shop_auto_buy !== true) {
      // 未开启自动购买：仅计数 + 推送"出现"提醒（带账号备注）
      maybePushMystery(offer, accountId, accountName, 'manual');
      return { skipped: true, reason: 'disabled', offer };
    }
    if (!isCurrencyAllowed(offer.currencyId, automation)) {
      maybePushMystery(offer, accountId, accountName, 'currency_not_allowed');
      log('商城', `神秘商人自动购买已跳过：未允许使用${offer.currencyName}`, {
        module: 'shop', event: '神秘商人自动购买', result: 'skip', currencyId: offer.currencyId
      });
      return { skipped: true, reason: 'currency_not_allowed', offer };
    }

    const result = await buyMysteryShopGoods(offer.npcId);
    maybePushMystery(offer, accountId, accountName, 'bought');
    log('商城', `神秘商人自动购买成功：${offer.itemName} x${offer.itemCount}，花费 ${offer.price} ${offer.currencyName}`, {
      module: 'shop', event: '神秘商人自动购买', result: 'success', itemId: offer.itemId,
      count: offer.itemCount, currencyId: offer.currencyId, price: offer.price
    });
    return { ...result, offer };
  } catch (err) {
    logWarn('商城', `神秘商人自动购买检查失败: ${err.message}`, {
      module: 'shop', event: '神秘商人自动购买', result: 'error', error: err.message
    });
    return { skipped: true, reason: 'error', error: err.message };
  }
}

module.exports = {
  AUTO_BUY_CHECK_INTERVAL_MS,
  getActiveMysteryShop,
  buyMysteryShopGoods,
  abandonMysteryShop,
  checkAndAutoBuyMysteryShop,
  isCurrencyAllowed,
  normalizeNPC,
};
