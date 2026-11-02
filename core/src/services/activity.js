/**
 * 活动服务 - 活动商店与限时抽奖
 *
 * 功能：
 * - 获取活动分组信息
 * - 操作活动（购买/刷新随机商店）
 * - 解析随机商店与活动抽奖数据
 * - 原始 protobuf 回退解码
 */
const protobuf = require('protobufjs/minimal');
const fs = require('node:fs');
const path = require('node:path');
const { sendMsgAsync, getUserState, isConnected } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, toLong } = require('../utils/utils');
const { getItemImageById, getItemById } = require('../config/gameConfig');
const { getDataFile, getDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const { createModuleLogger } = require('./logger');
const { getBag, getBagItems } = require('./warehouse');
const wishSignRewards = require('../gameConfig/WishSignRewards.json');
const milkTeaConfig = require('../activity-data/milk-tea-20261015.json');

const activityLogger = createModuleLogger('activity');

const HELU_DRAW_REQUEST_GAP_MS = 450;
const HELU_DRAW_REFRESH_DELAY_MS = 350;
const QINGMEI_WINE_STEP_DELAY_MS = 1000;
const qingmeiClaimedDateByAccount = new Map();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getLocalDateKey() {
  // 游戏每日结算按北京时间（UTC+8）计算，与服务器时区无关。
  // Azure VM 默认 UTC，直接用服务器本地日期会导致"今日上限"跨天误判（见灵露自动使用 bug）。
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getQingmeiClaimStateKey() {
  const state = getUserState();
  return String(state?.gid || state?.openid || 'current');
}

function markQingmeiClaimedToday() {
  qingmeiClaimedDateByAccount.set(getQingmeiClaimStateKey(), getLocalDateKey());
}

function isQingmeiClaimedToday() {
  return qingmeiClaimedDateByAccount.get(getQingmeiClaimStateKey()) === getLocalDateKey();
}

function assertActivityConnection(action) {
  if (!isConnected()) {
    throw new Error(`${action || '活动操作'}失败: 连接已断开，请等待自动重连后重试`);
  }
}

// ---- 活动常量 ----

// 南瓜活动标识
const NANGUA_ACTIVITY_UID = 'NanGua';
const HELU_ACTIVITY_UID = 'SAIJI';
const QINGMEI_ACTIVITY_UID = 'QingMeiActivity';

// 活动 ID（通过 proto 文件 reflect，脱混淆为可读命名）
const NANGUA_SHOP_ACTIVITY_ID = 2026030200;
const NANGUA_RANDOM_SHOP_ACTIVITY_ID = 2026030201;
const HELU_ACTIVITY_ID = 2026060100;
const HELU_DRAW_ACTIVITY_ID = 2026060101;
const HELU_EXCHANGE_ACTIVITY_ID = 2026060102;
const HELU_JOURNEY_ACTIVITY_ID = 2026060103;
const HELU_NOTES_ACTIVITY_ID = 2026060104;
const HELU_CURRENCY_ITEM_ID = 1018;
const STAR_ACTIVITY_UID = 'SAIJI_MEGA_EVENT';
const STAR_ACTIVITY_ID = 2026072700;
const STAR_RECORD_ACTIVITY_ID = 2026072701;
const STAR_SHOP_ACTIVITY_ID = 2026072702;
const STAR_SAND_ITEM_ID = 1023;
const STAR_RECORD_CLAIM_CMD = 21;
const STAR_SHOP_OPEN_CMD = 7;
const STAR_SHOP_EXCHANGE_CMD = 1;
const QINGMEI_ACTIVITY_ID = 2026081200;
const QINGMEI_SEED_CLAIM_ACTIVITY_ID = 2026081201;
const QINGMEI_WINE_ACTIVITY_ID = 2026081202;
const QINGMEI_SEED_CLAIM_CMD = 4;
const QINGMEI_WINE_PREVIEW_CMD = 14;
const QINGMEI_WINE_BREW_CMD = 15;
const QINGMEI_WINE_SELL_CMD = 16;
const QINGMEI_SEED_ITEM_ID = 21221;
const QINGMEI_FRUIT_ITEM_ID = 41221;
const QINGMEI_SEED_REWARD_COUNT = 24;
const QINGMEI_FINE_BREW_STEPS = 3;
// 青梅活动结束时间（秒级时间戳，来自上游抓包）：种子领取 08-17 23:59:59、酿酒 08-18 23:59:59。
// 活动结束后服务端下架节点，getQingmeiActivity 会走 catch 分支返回缺 endTime 的对象，
// 导致 worker 的 qingmeiExpired 误判为未结束而继续自动化刷 1034004；这里兜底补上结束时间。
const QINGMEI_SEED_CLAIM_END_TIME = 1786809599;
const QINGMEI_WINE_END_TIME = 1786895999;
// 秋祈良愿（中秋祈愿）活动：同组含签到主节点，走通用 ActivityGroup 协议
const WISH_SIGN_GROUP_ID = 2026092400;
const WISH_SIGN_ACTIVITY_ID = 2026092401;
const WISH_SIGN_ACTIVITY_UID = 'WishSignMainUI';
const WISH_SIGN_START_TIME = 1790179200;
const WISH_SIGN_END_TIME = 1791388799;
const WISH_SIGN_DRAW_CMD = 51;
const WISH_SIGN_CLAIM_CMD = 52;
const WISH_SIGN_CHOICES = ['财运', '感情', '前程', '生活', '农耕', '人际'];
// 快乐不独享（中秋分享）活动
const SHARE_REWARD_GROUP_ID = 2026092500;
const SHARE_REWARD_ACTIVITY_ID = 2026092501;
const SHARE_REWARD_ACTIVITY_UID = 'HappySharePanel';
const SHARE_REWARD_START_TIME = 1790179200;
const SHARE_REWARD_END_TIME = 1791820799;
const SHARE_REWARD_DAILY_CMD = 73;
const SHARE_REWARD_SHARE_CMD = 69;
const SHARE_REWARD_MILESTONES_CMD = 70;
// 奶茶热销中（S4 赛季，2026-10-15 上线）
// 活动组 2026110100，子活动：奶茶店 2026110101 / 兑换商店 2026110102 / 成长基金 2026110103。
// 命令号来自上游 milk-tea.ts operations 表（与官方客户端 1.15.0.1_20261001 对齐）。
const MILK_TEA_GROUP_ID = 2026110100;
const MILK_TEA_ACTIVITY_ID = 2026110101;
const MILK_TEA_SHOP_ACTIVITY_ID = 2026110102;
const MILK_TEA_FUND_ACTIVITY_ID = 2026110103;
// S4 快乐分享（快乐值/分享面板，同组兄弟节点，uid=S4HappySharePanel）
const MILK_TEA_SHARE_ACTIVITY_ID = 2026110104;
const MILK_TEA_ACTIVITY_UID = 'MilkTeaMainUI';
// 操作命令号（OperateRequest.operate_type）
const MILK_TEA_CMD = {
  create: 53, rename: 54, shop: 55, hireList: 56, hire: 57, workshop: 58,
  claim: 59, boost: 60, upgrade: 61, craft: 62, work: 63, wages: 64,
  interact: 65, rank: 66, logs: 67, hireSetting: 68,
  exchange: 1, unlock: 75, fundClaim: 76,
  // S4 快乐分享（子活动 2026110104）：与「快乐不独享」共用 ShareReward 消息
  shareRewards: 71, shareDaily: 74,
};
const HELU_PASSPORT_UID = 'SAIJI_PASSPORT';
const HELU_TITLE = '荷风十里蝉初鸣';
const HELU_SUB_ACTIVITY_KEYS = {
  giftLotus: 'giftLotus',
  shop: 'shop',
  journey: 'journey',
  notes: 'notes',
};
const HELU_SUB_ACTIVITY_DEFS = [
  { key: HELU_SUB_ACTIVITY_KEYS.giftLotus, title: '奇遇礼莲', icon: 'i-carbon-gift' },
  { key: HELU_SUB_ACTIVITY_KEYS.shop, title: '荷露商店', icon: 'i-carbon-store' },
  { key: HELU_SUB_ACTIVITY_KEYS.journey, title: '荷风游记', icon: 'i-carbon-map' },
  { key: HELU_SUB_ACTIVITY_KEYS.notes, title: '节令小札', icon: 'i-carbon-notebook' },
];

// 操作命令
const NANGUA_SHOP_BUY_CMD = 2;     // 购买
const NANGUA_SHOP_REFRESH_CMD = 3; // 刷新
const HELU_EXCHANGE_CMD = 1;
const HELU_DRAW_CMD = 9;

// ---- RPC 调用 ----

/**
 * 获取活动分组信息
 */
async function getActivityGroup(activityId = NANGUA_SHOP_ACTIVITY_ID, uid = NANGUA_ACTIVITY_UID) {
  const request = types.ActivityGetGroupRequest.encode(
    types.ActivityGetGroupRequest.create({
      id: Number(activityId) || NANGUA_SHOP_ACTIVITY_ID,
      uid: String(uid || ''),
    })
  ).finish();

  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', request);
  const decoded = types.ActivityGetGroupReply.decode(body);

  // 附加原始字节供回退解析
  Object.defineProperty(decoded, '__rawBody', {
    value: Buffer.from(body || []),
    enumerable: false,
  });

  return decoded;
}

async function listActivityGroups() {
  const request = types.ActivityListRequest.encode(
    types.ActivityListRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', request);
  return types.ActivityListReply.decode(body);
}

function normalizeDiscoveryActivity(node) {
  const raw = node?.activity || node || {};
  const payloadText = String(raw.payload || '').trim();
  let payload = null;
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = { text: payloadText.slice(0, 2000) };
    }
  }
  return {
    id: toNum(raw.id),
    parentId: toNum(raw.parent_id),
    type: toNum(raw.type),
    title: String(raw.title || ''),
    startTime: toNum(raw.start_time),
    endTime: toNum(raw.end_time),
    sort: toNum(raw.sort),
    visible: !!raw.visible,
    enabled: !!raw.enabled,
    status: toNum(raw.status),
    payload,
    features: {
      randomShop: !!(node?.random_shop || raw.random_shop),
      exchangeShop: !!(node?.exchange_shop || raw.exchange_shop),
      draw: !!(node?.draw_info || raw.draw_info),
      starRecord: !!node?.star_record,
    },
    children: (node?.children || []).map(normalizeDiscoveryActivity),
  };
}

function flattenDiscoveryActivities(nodes, output = []) {
  for (const node of nodes || []) {
    const activity = normalizeDiscoveryActivity(node);
    if (activity.id > 0) output.push({ ...activity, children: undefined });
    flattenDiscoveryActivities(node?.children, output);
  }
  return output;
}

async function getActivityDiscoveryList() {
  const reply = await listActivityGroups();
  return flattenDiscoveryActivities(reply?.groups).sort((a, b) => b.id - a.id);
}

async function getActivityGroupSnapshot(activityId, uid = '') {
  const reply = await getActivityGroup(activityId, uid);
  return normalizeDiscoveryActivity(reply?.group);
}

/**
 * 操作活动
 */
async function operateActivity(activityId, cmd, options = {}) {
  assertActivityConnection('活动操作');

  const payload = {
    id: Number(activityId) || NANGUA_SHOP_ACTIVITY_ID,
    cmd: Number(cmd) || 0,
  };

  if (options?.randomShopOperate && typeof options.randomShopOperate === 'object') {
    payload.random_shop_operate = {
      id: Number(options.randomShopOperate.id) || 0,
      count: Number(options.randomShopOperate.count) || 1,
    };
  } else if (options?.exchangeShopOperate && typeof options.exchangeShopOperate === 'object') {
    payload.exchange_shop_operate = {
      id: Number(options.exchangeShopOperate.id) || 0,
      count: Number(options.exchangeShopOperate.count) || 1,
    };
  } else if (options?.draw && typeof options.draw === 'object') {
    payload.draw = options.draw;
  }
  if (options?.helu_paid_draw && typeof options.helu_paid_draw === 'object') {
    payload.helu_paid_draw = options.helu_paid_draw;
  }
  if (options?.qingmeiClaim && typeof options.qingmeiClaim === 'object') {
    payload.qingmei_claim_params = {
      type: Math.max(0, toNum(options.qingmeiClaim.type)),
    };
  }
  if (options?.qingmeiWineStart && typeof options.qingmeiWineStart === 'object') {
    payload.qingmei_wine_start = {
      items: (options.qingmeiWineStart.items || []).map(item => ({
        id: toNum(item?.id),
        count: toNum(item?.count),
      })),
    };
  }
  if (options?.qingmeiWineBrew) {
    payload.qingmei_wine_brew = {};
  }
  if (options?.qingmeiWineSell && typeof options.qingmeiWineSell === 'object') {
    payload.qingmei_wine_sell = {
      multiple: Math.max(1, toNum(options.qingmeiWineSell.multiple) || 1),
    };
  }
  if (options?.qixiGift && typeof options.qixiGift === 'object') {
    payload.qixi_gift = {
      friend_gid: toNum(options.qixiGift.friendGid),
      gift_id: Math.max(1, toNum(options.qixiGift.giftId)),
    };
  }
  if (options?.techTreeSubmitNode && typeof options.techTreeSubmitNode === 'object') {
    payload.tech_tree_submit_node = {
      node_id: Math.max(0, toNum(options.techTreeSubmitNode.nodeId)),
    };
  }
  // 秋祈良愿：wish-sign draw=51 / claim=52（proto tag 151 / 152）
  if (options?.wishSignDraw && typeof options.wishSignDraw === 'object') {
    payload.wish_sign_draw = { choose_id: toNum(options.wishSignDraw.chooseId) };
  }
  if (options?.wishSignClaim && typeof options.wishSignClaim === 'object') {
    payload.wish_sign_claim = { choose_id: toNum(options.wishSignClaim.chooseId) };
  }
  // 快乐不独享：share=69(153) / claim_milestones=70(154) / claim_daily=73(157)
  if (options?.shareRewardShare) {
    payload.share_reward_share = {};
  }
  if (options?.shareRewardClaimMilestones) {
    payload.share_reward_claim_milestones = {};
  }
  if (options?.shareRewardClaimDaily) {
    payload.share_reward_claim_daily = {};
  }
  if (options?.payload && typeof options.payload === 'object') {
    Object.assign(payload, options.payload);
  }

  activityLogger.info('活动操作请求', {
    activityId: payload.id,
    cmd: payload.cmd,
    draw: payload.draw,
    exchangeShopOperate: payload.exchange_shop_operate,
    randomShopOperate: payload.random_shop_operate,
    heluPaidDraw: payload.helu_paid_draw,
    qingmeiClaim: payload.qingmei_claim_params,
    qingmeiWineStartCount: payload.qingmei_wine_start?.items?.length || 0,
    qingmeiWineBrew: !!payload.qingmei_wine_brew,
    qingmeiWineSell: payload.qingmei_wine_sell,
    qixiGift: payload.qixi_gift,
    techTreeSubmitNode: payload.tech_tree_submit_node,
  });

  const request = types.ActivityOperateRequest.encode(
    types.ActivityOperateRequest.create(payload)
  ).finish();

  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
  return body;
}

async function operateActivityReply(activityId, cmd, options = {}) {
  const body = await operateActivity(activityId, cmd, options);
  return types.ActivityOperateReply.decode(body);
}

function normalizeCoreItem(item) {
  const itemId = toNum(item?.id);
  const count = toNum(item?.count);
  const info = getItemById(itemId);
  return {
    itemId,
    itemCount: count,
    count,
    itemName: info?.name || (itemId ? `物品#${itemId}` : ''),
    image: getItemImageById(itemId) || '',
  };
}

function normalizeQingmeiPreviewResult(result) {
  if (!result) return null;
  return {
    price: toNum(result?.price),
  };
}

function normalizeQingmeiBrewResult(result) {
  if (!result) return null;
  return {
    wineType: toNum(result?.wine_type ?? result?.wineType),
    cost: toNum(result?.cost),
    price: toNum(result?.price),
    canDouble: !!(result?.can_double ?? result?.canDouble),
  };
}

function normalizeQingmeiSellResult(result) {
  if (!result) return null;
  const item = normalizeCoreItem(result?.item || {});
  return {
    multiple: toNum(result?.multiple),
    gold: toNum(result?.gold) || item.itemCount,
    item,
  };
}

function normalizeQingmeiClaimResult(result) {
  const items = (Array.isArray(result?.items) ? result.items : [])
    .map(normalizeCoreItem)
    .filter(item => item.itemId > 0 && item.itemCount > 0);
  const seed = items.find(item => item.itemId === QINGMEI_SEED_ITEM_ID);
  return {
    items,
    claimedCount: seed?.itemCount || 0,
  };
}

function isAlreadyClaimedError(err) {
  const message = String(err?.message || err || '');
  return message.includes('已领取')
    || message.includes('已经领取')
    || message.includes('重复领取')
    || message.includes('already')
    || message.includes('1009001');
}

function createQingmeiWineError(stage, message, cause) {
  const err = new Error(message || cause?.message || '青梅酿操作失败');
  err.stage = stage;
  err.cause = cause;
  err.qingmeiWine = true;
  return err;
}

function isNoOngoingQingmeiBrewError(err) {
  const message = String(err?.message || err || '');
  return message.includes('1034027') || message.includes('无进行中的酿造记录');
}

async function reportQingmeiShareForDouble() {
  const checkRequest = types.CheckCanShareRequest.encode(
    types.CheckCanShareRequest.create({})
  ).finish();
  const { body: checkBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', checkRequest);
  const checkResult = types.CheckCanShareReply.decode(checkBody);

  if (!checkResult?.can_share) {
    throw new Error('当前不可分享，无法执行青梅酿售卖翻倍');
  }

  const reportRequest = types.ReportShareRequest.encode(
    types.ReportShareRequest.create({ shared: true })
  ).finish();
  const { body: reportBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportRequest);
  const reportResult = types.ReportShareReply.decode(reportBody);

  if (reportResult && Object.hasOwn(reportResult, 'success') && !reportResult.success) {
    throw new Error('青梅酿分享上报失败');
  }

  return {
    canShare: !!checkResult?.can_share,
    shared: true,
    success: reportResult?.success !== false,
  };
}

async function getSeasonInfoRaw() {
  const { body } = await sendMsgAsync('gamepb.seasonpb.SeasonService', 'GetSeasonInfo', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function claimSeasonRewardsRaw() {
  assertActivityConnection('荷风游记领取');
  const { body } = await sendMsgAsync('gamepb.seasonpb.SeasonService', 'ClaimBattlePassRewards', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function getSolarTermsRaw() {
  const { body } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'GetSolarTerms', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function claimSolarTermsRaw(termId) {
  assertActivityConnection('节令小札领取');
  const request = protobuf.Writer.create()
    .uint32((1 << 3) | 0)
    .uint32(Math.max(0, Number(termId) || 0))
    .finish();
  const { body } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'ClaimSolarTerms', request);
  return Buffer.from(body || []);
}

// ---- 商品购买 ----

/**
 * 购买南瓜商店商品
 */
async function buyNanguaShopItem(slotId, defaultCount = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的活动商店槽位');

  const shop = await getNanguaShop();
  const slotItems = Array.isArray(shop?.randomShop) ? shop.randomShop : [];
  const slot = slotItems.find((item) => toNum(item?.id) === slotIdNum);

  if (!slot) throw new Error(`活动商店未找到槽位: ${slotIdNum}`);
  if (!slot.purchasable) throw new Error(`活动商店槽位不可购买: ${slot.statusLabel || '不可购买'}`);

  const price = toNum(slot?.price) || Number(defaultCount) || 0;
  if (price <= 0) throw new Error('缺少有效的活动商店价格');

  const remaining = Math.max(0,
    toNum(slot?.remainingCount) ||
    toNum(slot?.stockCount) - toNum(slot?.boughtCount) ||
    0
  );

  try {
    await operateActivity(NANGUA_RANDOM_SHOP_ACTIVITY_ID, NANGUA_SHOP_BUY_CMD, {
      randomShopOperate: { id: slotIdNum, count: remaining },
    });
  } catch (err) {
    throw new Error(
      `活动商店购买失败: activityId=${NANGUA_RANDOM_SHOP_ACTIVITY_ID}, slotId=${slotIdNum}, count=${remaining}, cost=${price}: ${err.message}`
    );
  }

  return getNanguaShop();
}

/**
 * 刷新南瓜商店
 */
async function refreshNanguaShop() {
  const before = await getNanguaShop();
  await operateActivity(NANGUA_RANDOM_SHOP_ACTIVITY_ID, NANGUA_SHOP_REFRESH_CMD);
  const after = await getNanguaShop();

  if (getRandomShopStateSignature(before) === getRandomShopStateSignature(after)) {
    throw new Error('活动商店刷新请求已返回，但商店内容和刷新次数未变化，请检查剩余刷新次数或协议字段');
  }

  return after;
}

// ---- 数据解析 ----

/**
 * 生成随机商店状态签名（用于检测刷新是否生效）
 */
function getRandomShopStateSignature(group) {
  const refresh = group?.randomShopRefresh || {};
  const items = Array.isArray(group?.randomShop) ? group.randomShop : [];
  return JSON.stringify({
    nextRefreshTime: toNum(refresh.nextRefreshTime),
    manualRefreshUsedCount: toNum(refresh.manualRefreshUsedCount),
    items: items.map((it) => [
      toNum(it?.id),
      toNum(it?.itemId),
      toNum(it?.stockCount),
      toNum(it?.boughtCount),
      !!it?.special,
    ]),
  });
}

/**
 * 解析活动 payload（JSON 字符串）
 */
function getField(raw, ...names) {
  if (!raw) return undefined;
  for (const name of names) {
    if (raw[name] !== undefined) return raw[name];
    const numeric = String(name).replace(/^field_/, '');
    if (/^\d+$/.test(numeric) && raw[numeric] !== undefined) return raw[numeric];
  }
  return undefined;
}

function parsePayload(rawPayload) {
  if (!rawPayload) return null;
  if (typeof rawPayload === 'object') return rawPayload;
  if (typeof rawPayload !== 'string') return null;
  const text = rawPayload.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeItemHex(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]+$/i.test(raw) || raw.length < 4) return null;
  try {
    return types.CoreItem ? types.CoreItem.decode(Buffer.from(raw, 'hex')) : null;
  } catch {
    return null;
  }
}

function readProtoFields(rawBytes) {
  const buf = Buffer.from(rawBytes || []);
  const reader = protobuf.Reader.create(buf);
  const entries = [];

  while (reader.pos < reader.len) {
    let tag = 0;
    try {
      tag = reader.uint32();
    } catch {
      break;
    }

    const field = tag >>> 3;
    const wire = tag & 0x7;
    try {
      if (wire === 0) {
        entries.push({ field, wire, value: toNum(reader.uint64()) });
      } else if (wire === 2) {
        entries.push({ field, wire, value: Buffer.from(reader.bytes()) });
      } else if (wire === 5) {
        entries.push({ field, wire, value: reader.uint32() });
      } else if (wire === 1) {
        entries.push({ field, wire, value: reader.fixed64() });
      } else {
        reader.skipType(wire);
      }
    } catch {
      break;
    }
  }

  return entries;
}

function getProtoNumber(entries, field, fallback = 0) {
  const hit = (entries || []).find((entry) => entry.field === field && entry.wire === 0);
  return hit ? toNum(hit.value) : fallback;
}

function getProtoBytes(entries, field) {
  const hit = (entries || []).find((entry) => entry.field === field && entry.wire === 2);
  return hit ? Buffer.from(hit.value || []) : null;
}

function getProtoBytesAll(entries, field) {
  return (entries || [])
    .filter((entry) => entry.field === field && entry.wire === 2)
    .map((entry) => Buffer.from(entry.value || []));
}

function getProtoString(entries, field, fallback = '') {
  const bytes = getProtoBytes(entries, field);
  if (!bytes || bytes.length === 0) return fallback;
  try {
    return bytes.toString('utf8');
  } catch {
    return fallback;
  }
}

function parseActivityItemMessage(rawBytes) {
  const entries = readProtoFields(rawBytes);
  const itemId = getProtoNumber(entries, 1);
  const count = Math.max(0, getProtoNumber(entries, 2) || 1);
  if (itemId <= 0) return null;

  const info = getItemById(itemId);
  return {
    itemId,
    itemCount: count,
    count,
    itemName: (info && info.name) || `物品${itemId}`,
    name: (info && info.name) || `物品${itemId}`,
    image: getItemImageById(itemId) || '',
  };
}

function getSubActivityKey(activity) {
  const id = toNum(activity?.id);
  const title = String(activity?.title || '');
  if (id === HELU_DRAW_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.giftLotus;
  if (id === HELU_EXCHANGE_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.shop;
  if (id === HELU_JOURNEY_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.journey;
  if (id === HELU_NOTES_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.notes;
  if (/奇遇礼莲/.test(title)) return HELU_SUB_ACTIVITY_KEYS.giftLotus;
  if (/荷露商店/.test(title)) return HELU_SUB_ACTIVITY_KEYS.shop;
  if (/荷风游记/.test(title)) return HELU_SUB_ACTIVITY_KEYS.journey;
  if (/节令小札/.test(title)) return HELU_SUB_ACTIVITY_KEYS.notes;
  return '';
}

function summarizeActivityPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    }));
}

function normalizeHeluSubActivities(activities) {
  const byKey = new Map();
  for (const activity of activities || []) {
    const key = getSubActivityKey(activity);
    if (!key || byKey.has(key)) continue;
    const payload = parsePayload(activity?.payload);
    byKey.set(key, {
      key,
      id: toNum(activity?.id),
      parentId: toNum(activity?.parent_id ?? activity?.parentId),
      title: String(activity?.title || ''),
      type: toNum(activity?.type),
      sort: toNum(activity?.sort),
      status: toNum(activity?.status),
      visible: activity?.visible !== false,
      enabled: activity?.enabled !== false,
      startTime: toNum(activity?.start_time ?? activity?.startTime),
      endTime: toNum(activity?.end_time ?? activity?.endTime),
      payload,
      payloadSummary: summarizeActivityPayload(payload),
      hasDraw: !!(activity?.draw_info || activity?.drawInfo),
      hasExchangeShop: !!(activity?.exchange_shop || activity?.exchangeShop),
      source: 'activity_tree',
    });
  }

  return HELU_SUB_ACTIVITY_DEFS.map((def) => {
    const found = byKey.get(def.key);
    return {
      ...def,
      id: found?.id || 0,
      parentId: found?.parentId || 0,
      type: found?.type || 0,
      sort: found?.sort || 0,
      status: found?.status || 0,
      visible: found?.visible ?? true,
      enabled: found?.enabled ?? true,
      startTime: found?.startTime || 0,
      endTime: found?.endTime || 0,
      payload: found?.payload || null,
      payloadSummary: found?.payloadSummary || [],
      hasDraw: found?.hasDraw || def.key === HELU_SUB_ACTIVITY_KEYS.giftLotus,
      hasExchangeShop: found?.hasExchangeShop || def.key === HELU_SUB_ACTIVITY_KEYS.shop,
      available: !!found || def.key === HELU_SUB_ACTIVITY_KEYS.giftLotus || def.key === HELU_SUB_ACTIVITY_KEYS.shop,
      source: found?.source || 'configured',
    };
  });
}

/**
 * 标准化活动物品
 */
function normalizeActivityItem(raw) {
  if (!raw) return null;
  const decoded = decodeItemHex(raw) || raw;
  const itemId = toNum(getField(decoded, 'id', 'field_1', 1));
  const count = Math.max(0, toNum(getField(decoded, 'count', 'field_2', 2)) || 1);
  if (itemId <= 0) return null;

  const info = getItemById(itemId);
  const image = getItemImageById(itemId) || '';

  return {
    itemId,
    count,
    name: (info && info.name) || `物品${itemId}`,
    image,
  };
}

function normalizeDrawPoolItem(raw) {
  const item = normalizeActivityItem(getField(raw, 'item', 'field_3', 3));
  if (!item) return null;
  return {
    id: toNum(getField(raw, 'id', 'field_1', 1)),
    rarity: toNum(getField(raw, 'rarity', 'field_2', 2)),
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
    probability: String(getField(raw, 'probability', 'field_6', 6) || ''),
  };
}

function normalizeDrawReward(raw) {
  const item = normalizeActivityItem(getField(raw, 'item', 'field_2', 2));
  if (!item) return null;
  return {
    slotId: toNum(getField(raw, 'slot_id', 'slotId', 'field_1', 1)),
    rarityFlag: toNum(getField(raw, 'flag', 'field_4', 4)),
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
  };
}

function normalizeDrawInfo(raw) {
  if (!raw) return null;

  const freeMax = toNum(getField(raw, 'max_free_count', 'maxFreeCount', 'field_2', 2)) || 4;
  const paidMax = toNum(getField(raw, 'max_paid_count', 'maxPaidCount', 'field_4', 4)) || 4;
  const freeRemainingRaw = getField(raw, 'free_remaining_count', 'freeRemainingCount', 'field_1', 1);
  const paidRemainingRaw = getField(raw, 'paid_remaining_count', 'paidRemainingCount', 'free_used_count', 'freeUsedCount', 'field_3', 3);
  const hasFreeRemaining = freeRemainingRaw !== undefined;
  const hasPaidRemaining = paidRemainingRaw !== undefined;
  const freeRemaining = Math.max(0, Math.min(freeMax,
    hasFreeRemaining ? toNum(freeRemainingRaw) : hasPaidRemaining ? 0 : freeMax
  ));
  // 抓包显示：field_3 是点券剩余次数；点券 4 次全部用完后 field_3 会直接省略。
  // 初始配置也会省略 field_3，但此时免费次数未用完，所以仍应展示点券上限。
  const paidRemaining = Math.max(0, Math.min(paidMax,
    hasPaidRemaining ? toNum(paidRemainingRaw) : freeRemaining <= 0 ? 0 : paidMax
  ));
  const freeUsed = Math.max(0, freeMax - freeRemaining);
  const paidUsed = Math.max(0, paidMax - paidRemaining);
  const paidCurrencyId = toNum(getField(raw, 'paid_currency_id', 'paidCurrencyId', 'field_5', 5)) || 1002;
  const paidPrice = toNum(getField(raw, 'paid_price', 'paidPrice', 'field_6', 6)) || 30;
  const fallbackPrice = toNum(getField(raw, 'fallback_price', 'fallbackPrice', 'field_7', 7)) || paidPrice;
  const rewardPoolRaw = getField(raw, 'rewards', 'field_8', 8);
  const rewardPool = (Array.isArray(rewardPoolRaw) ? rewardPoolRaw : [])
    .map(normalizeDrawPoolItem)
    .filter(Boolean);

  return {
    freeMax,
    freeUsed,
    freeRemaining,
    paidMax,
    paidUsed,
    paidRemaining,
    paidCurrencyId,
    paidPrice,
    fallbackPrice,
    rewardPool,
    _hasFreeRemaining: hasFreeRemaining,
    _hasPaidRemaining: hasPaidRemaining,
  };
}

function normalizeDrawResult(raw) {
  if (!raw) return null;
  const rewardsRaw = getField(raw, 'rewards', 'field_1', 1);
  const itemsRaw = getField(raw, 'items', 'field_2', 2);
  const costRaw = getField(raw, 'cost', 'field_3', 3);
  return {
    rewards: (Array.isArray(rewardsRaw) ? rewardsRaw : [])
      .map(normalizeDrawReward)
      .filter(Boolean),
    items: (Array.isArray(itemsRaw) ? itemsRaw : [])
      .map(normalizeActivityItem)
      .filter(Boolean),
    cost: normalizeActivityItem(costRaw),
  };
}

/**
 * 标准化随机商店单品
 */
function normalizeRandomShopItem(raw) {
  const item = normalizeActivityItem(raw?.item);
  const cost = normalizeActivityItem(raw?.cost);
  if (!item) return null;

  const name = String(raw?.name || item.name || '').trim() || item.name;
  const stockCount = toNum(raw?.stock_count ?? raw?.stockCount ?? raw?.limit_count ?? raw?.limitCount);
  const boughtCount = toNum(raw?.bought_count ?? raw?.boughtCount);
  const hasStock = stockCount > 0;
  const isSpecial = !!raw?.special;
  const noStock = !isSpecial;
  const soldOut = isSpecial && hasStock && boughtCount >= stockCount;
  const purchasable = isSpecial && hasStock && !soldOut;
  const remainingCount = purchasable ? Math.max(0, stockCount - boughtCount) : 0;

  return {
    id: toNum(raw?.id),
    name,
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
    currencyId: cost?.itemId || 1001,
    price: cost?.count || 0,
    priceUnitId: cost?.itemId || 1001,
    stockCount,
    boughtCount,
    remainingCount,
    special: !!raw?.special,
    stockStatus: noStock ? 'no_stock' : soldOut ? 'sold_out' : 'available',
    noStock,
    soldOut,
    purchasable,
    statusLabel: noStock ? '无库存' : soldOut ? '售罄' : purchasable ? '可购买' : '不可购买',
    source: 'random',
  };
}

/**
 * 标准化随机商店信息
 */
function normalizeRandomShopInfo(raw) {
  if (!raw) return null;

  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .map(normalizeRandomShopItem)
    .filter(Boolean);

  return {
    items,
    nextRefreshTime: toNum(raw?.next_refresh_time ?? raw?.nextRefreshTime),
    manualRefreshCost: toNum(raw?.manual_refresh_cost ?? raw?.manualRefreshCost),
    manualRefreshCurrencyId: toNum(raw?.manual_refresh_currency_id ?? raw?.manualRefreshCurrencyId),
    manualRefreshExtraValue: toNum(
      raw?.manual_refresh_extra_value ??
      raw?.manualRefreshExtraValue ??
      raw?.fallback_refresh_cost ??
      raw?.fallbackRefreshCost ??
      raw?.manual_refresh_count ??
      raw?.manualRefreshCount ??
      0
    ),
    maxManualRefreshCount: 6,
    manualRefreshUsedCount: toNum(raw?.manual_refresh_used_count ?? raw?.manualRefreshUsedCount),
  };
}

/**
 * 标准化兑换商店单品
 */
function normalizeExchangeShopItem(raw) {
  if (!raw) return null;

  const item = normalizeActivityItem(raw?.item);
  const cost = normalizeActivityItem(raw?.cost);
  if (!item) return null;

  const itemInfo = getItemById(item.itemId) || {};
  const itemType = toNum(itemInfo.type);
  const interactionType = String(itemInfo.interaction_type || itemInfo.interactionType || '');
  const name = String(raw?.name || item.name || '').trim() || item.name;
  const status = toNum(raw?.status);
  const owned = raw?.owned === true;
  const isRepeatable = itemType === 7 || interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
  const exchangeLimit = isRepeatable && status > 1 ? status : 0;
  const ownedBlocksExchange = owned && !isRepeatable;
  const isDecoration = itemType === 18
    || /装扮/.test(String(itemInfo.desc || ''))
    || /装扮/.test(String(itemInfo.effectDesc || ''))
    || /(?:小屋|街道|狗屋|木牌|仓库|栅栏|围栏|头像框)$/.test(name)
    || name.startsWith('枕水听荷');

  return {
    id: toNum(raw?.id),
    sort: toNum(raw?.sort),
    status,
    owned,
    isRepeatable,
    exchangeLimit,
    ownedBlocksExchange,
    statusLabel: ownedBlocksExchange
      ? '已拥有'
      : status === 1 || exchangeLimit > 0
        ? '可兑换'
        : status === 5
          ? '特殊商品'
          : status === 120 || status === 130
            ? '可兑换'
            : `状态${status}`,
    name,
    itemId: item.itemId,
    itemCount: item.count,
    itemName: name,
    image: item.image || '',
    itemType,
    itemTypeLabel: isDecoration ? '装扮' : itemType === 7 ? '道具' : `类型${itemType || 0}`,
    isDecoration,
    currencyId: cost?.itemId || 0,
    currencyName: cost?.name || '',
    price: cost?.count || 0,
    desc: String(getItemById(item.itemId)?.desc || getItemById(item.itemId)?.effectDesc || ''),
    extra: String(raw?.extra || ''),
  };
}

// ---- 活动树遍历 ----

function flattenActivityNode(node, result = []) {
  if (!node) return result;
  if (node.activity) {
    if (!node.activity.random_shop && node.random_shop) node.activity.random_shop = node.random_shop;
    if (!node.activity.exchange_shop && node.exchange_shop) node.activity.exchange_shop = node.exchange_shop;
    if (!node.activity.draw_info && node.draw_info) node.activity.draw_info = node.draw_info;
    result.push(node.activity);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    flattenActivityNode(child, result);
  }
  return result;
}

function flattenActivityChildren(reply) {
  const list = flattenActivityNode(reply?.group, []);
  for (const group of Array.isArray(reply?.groups) ? reply.groups : []) {
    flattenActivityNode(group, list);
  }
  if (Array.isArray(reply?.activities)) list.push(...reply.activities);
  return list.filter(Boolean);
}

// ---- 原始 Protobuf 扫描（回退方案） ----

function skipUnknown(reader, wireType) {
  try {
    reader.skipType(wireType);
  } catch {
    reader.pos = reader.len;
  }
}

/**
 * 扫描长度分隔字段
 */
function scanLengthDelimitedFields(rawBytes, targetFieldNum, maxDepth = 3, results = []) {
  const buf = Buffer.from(rawBytes || []);
  if (buf.length === 0 || maxDepth <= 0) return results;

  const reader = protobuf.Reader.create(buf);
  while (reader.pos < reader.len) {
    let tag = 0;
    try {
      tag = reader.uint32();
    } catch {
      break;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 2) {
      let bytes = null;
      try {
        bytes = reader.bytes();
      } catch {
        break;
      }
      if (fieldNum === targetFieldNum) results.push(Buffer.from(bytes));
      scanLengthDelimitedFields(bytes, targetFieldNum, maxDepth - 1, results);
      continue;
    }

    skipUnknown(reader, wireType);
  }
  return results;
}

/**
 * 从原始 body 中扫描随机商店信息
 */
function scanRandomShopInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const RandomShopInfo = types.ActivityRandomShopInfo;
  if (!RandomShopInfo) return null;

  let best = null;
  const seen = new Set();

  for (const chunk of scanLengthDelimitedFields(rawBody, 7)) {
    try {
      const decoded = RandomShopInfo.decode(chunk);
      const normalized = normalizeRandomShopInfo(decoded);
      if (!normalized || normalized.items.length === 0) continue;

      const deduped = [];
      for (const item of normalized.items) {
        if (!item) continue;
        const key = `${item.id}:${item.itemId}:${item.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      normalized.items = deduped;

      if (!best || normalized.items.length > best.items.length) {
        best = normalized;
      }
    } catch {
      // 跳过解码失败的块
    }
  }

  return best;
}

/**
 * 从原始 body 中扫描兑换商店信息
 */
function scanExchangeShopInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const ExchangeShopInfo = types.ActivityExchangeShopInfo;
  if (!ExchangeShopInfo) return null;

  let best = null;
  const seen = new Set();

  for (const chunk of scanLengthDelimitedFields(rawBody, 102)) {
    try {
      const decoded = ExchangeShopInfo.decode(chunk);
      const items = (Array.isArray(decoded?.items) ? decoded.items : [])
        .map(normalizeExchangeShopItem)
        .filter(Boolean);
      if (items.length === 0) continue;

      const deduped = [];
      for (const item of items) {
        const key = `${item.id}:${item.itemId}:${item.currencyId}:${item.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      const normalized = {
        items: deduped.sort((a, b) => {
          if (a.sort !== b.sort) return a.sort - b.sort;
          return a.id - b.id;
        }),
      };

      if (!best || normalized.items.length > best.items.length) best = normalized;
    } catch {
      // skip
    }
  }

  return best;
}

function scanDrawInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const DrawInfo = types.ActivityDrawInfo;
  if (!DrawInfo) return null;

  let best = null;
  for (const chunk of scanLengthDelimitedFields(rawBody, 105)) {
    try {
      const decoded = DrawInfo.decode(chunk);
      const normalized = normalizeDrawInfo(decoded);
      if (!normalized || normalized.rewardPool.length === 0) continue;
      if (!best || normalized.rewardPool.length > best.rewardPool.length) best = normalized;
    } catch {
      // skip
    }
  }
  return best;
}

function getHeluActivityUidCandidates() {
  return [HELU_ACTIVITY_UID, 'SAIJI_DRAW', 'SaiJi', 'HeLu', 'Helu', ''];
}

async function getActivityGroupWithUidFallback(activityId, uidCandidates) {
  let lastErr = null;
  for (const uid of uidCandidates) {
    try {
      const reply = await getActivityGroup(activityId, uid);
      const activities = flattenActivityChildren(reply);
      if (activities.length > 0) {
        Object.defineProperty(reply, '__activityUid', {
          value: uid,
          enumerable: false,
          configurable: true,
        });
        return reply;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return getActivityGroup(activityId, uidCandidates[0]);
}

async function getHeluBalance() {
  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    for (const item of items || []) {
      if (toNum(item?.id) === HELU_CURRENCY_ITEM_ID) {
        return Math.max(0, toNum(item?.count));
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

async function getBagItemCount(itemId) {
  try {
    const bag = await getBag();
    return (getBagItems(bag) || [])
      .filter(entry => toNum(entry?.id) === toNum(itemId))
      .reduce((sum, item) => sum + Math.max(0, toNum(item?.count)), 0);
  } catch {
    return 0;
  }
}

async function getQingmeiWineMaterialItems() {
  const bag = await getBag();
  return (getBagItems(bag) || [])
    .map(item => ({
      id: toNum(item?.id),
      uid: toNum(item?.uid),
      count: Math.max(0, toNum(item?.count)),
      mutantType: Array.isArray(item?.mutant_types) && item.mutant_types.length
        ? Math.min(...item.mutant_types.map(toNum).filter(value => value > 0))
        : 0,
    }))
    .filter(item => item.id === QINGMEI_FRUIT_ITEM_ID && item.uid > 0 && item.count > 0)
    .sort((a, b) => {
      const aOrder = a.mutantType > 0 ? a.mutantType : Number.MAX_SAFE_INTEGER;
      const bOrder = b.mutantType > 0 ? b.mutantType : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.uid - b.uid;
    })
    .map(item => ({
      id: item.uid,
      count: item.count,
    }));
}

/** 活动节点是否仍在有效期（end_time 缺失视为有效；兼容秒/毫秒时间戳） */
function isQingmeiNodeActive(item, nowSec) {
  const endTime = toNum(item?.end_time ?? item?.endTime);
  if (endTime <= 0) return true;
  const endSec = endTime > 1e12 ? Math.floor(endTime / 1000) : endTime;
  return endSec >= nowSec;
}

/**
 * 从活动组子节点中解析青梅活动的 root/领取/酿酒节点。
 * 节点编号规则：主活动 YYYYMMDD00、领取 +1、酿酒 +2；节点 ID 在活动期内稳定，
 * 每日轮换的是领取参数 type（见 getDateBasedQingmeiClaimType）。
 * 服务端可能同时下发已过期的旧期节点，必须按 end_time 过滤。
 */
function resolveQingmeiNodesFromChildren(activities) {
  const list = Array.isArray(activities) ? activities : [];
  const byId = new Map();
  for (const item of list) {
    const id = toNum(item?.id);
    if (id > 0 && !byId.has(id)) byId.set(id, item);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const activeOf = item => (item && isQingmeiNodeActive(item, nowSec) ? item : null);

  // 活动组查询针对青梅活动，子节点都属于同一活动族，直接按编号族规则匹配
  const rootCandidates = [...byId.keys()]
    .filter(id => id % 100 === 0)
    .sort((a, b) => b - a);
  for (const rootId of rootCandidates) {
    const claim = activeOf(byId.get(rootId + 1));
    const wine = activeOf(byId.get(rootId + 2));
    if (claim || wine) {
      return { root: byId.get(rootId) || null, claim, wine };
    }
  }

  return {
    root: byId.get(QINGMEI_ACTIVITY_ID) || null,
    claim: activeOf(byId.get(QINGMEI_SEED_CLAIM_ACTIVITY_ID)),
    wine: activeOf(byId.get(QINGMEI_WINE_ACTIVITY_ID)),
  };
}

/** 按近期日期推导“YYYYMMDD00”主活动 ID 候选（仅作为探测，服务端未开始时返回 1034001） */
function getDateDerivedQingmeiRootIds() {
  const ids = [];
  for (const offset of [0, 1, 2]) {
    const day = new Date(Date.now() - offset * 24 * 60 * 60 * 1000);
    const ymd = day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate();
    ids.push(ymd * 100);
  }
  return ids;
}

const qingmeiResolvedIdsCache = { dateKey: '', expiresAt: 0, ids: null };
// 被 Operate 以 1034005 拒绝过的节点 ID，下次解析时跳过
const rejectedQingmeiNodeIds = new Set();

function summarizeQingmeiNodes(activities) {
  return (Array.isArray(activities) ? activities : [])
    .map(item => ({
      id: toNum(item?.id),
      status: item?.status ?? null,
      startTime: toNum(item?.start_time ?? item?.startTime),
      endTime: toNum(item?.end_time ?? item?.endTime),
      enabled: item?.enabled ?? null,
      title: item?.title || '',
      payload: String(item?.payload || '').slice(0, 300),
    }))
    .filter(node => node.id > 0)
    .slice(0, 30);
}

/** 在候选活动列表中按编号族+有效期解析青梅节点，跳过被拒绝过的 ID */
function pickActiveQingmeiNodes(activities) {
  const list = Array.isArray(activities) ? activities : [];
  const byId = new Map();
  for (const item of list) {
    const id = toNum(item?.id);
    if (id > 0 && !byId.has(id)) byId.set(id, item);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const usable = item => item
    && !rejectedQingmeiNodeIds.has(toNum(item?.id))
    && isQingmeiNodeActive(item, nowSec);

  const rootCandidates = [...byId.keys()]
    .filter(id => id % 100 === 0)
    .sort((a, b) => b - a);
  for (const rootId of rootCandidates) {
    const claim = usable(byId.get(rootId + 1)) ? byId.get(rootId + 1) : null;
    const wine = usable(byId.get(rootId + 2)) ? byId.get(rootId + 2) : null;
    if (claim || wine) {
      return { root: byId.get(rootId) || null, claim, wine };
    }
  }
  return null;
}

/**
 * 查询活动组并返回当前有效的青梅活动 ID。
 * 汇总日期推导 ID、写死基线和 List 全量枚举三个来源的节点后统一解析，
 * 避免旧期节点短路导致永远查不到新期；成功结果缓存 30 分钟；
 * 解析不到领取节点时必须记录服务端节点详情便于排查。
 */
async function resolveQingmeiActivityIds() {
  const fallback = {
    rootId: QINGMEI_ACTIVITY_ID,
    claimId: QINGMEI_SEED_CLAIM_ACTIVITY_ID,
    wineId: QINGMEI_WINE_ACTIVITY_ID,
  };
  const dateKey = getLocalDateKey();
  const cached = qingmeiResolvedIdsCache;
  if (cached.ids && cached.dateKey === dateKey && cached.expiresAt > Date.now()) {
    return { ...cached.ids };
  }

  const result = { ...fallback };
  const rootIds = [...new Set([...getDateDerivedQingmeiRootIds(), QINGMEI_ACTIVITY_ID])];
  let lastErr = null;
  const collected = [];

  for (const rootId of rootIds) {
    try {
      const reply = await getActivityGroupWithUidFallback(rootId, [QINGMEI_ACTIVITY_UID, '']);
      collected.push(...flattenActivityChildren(reply));
    } catch (err) {
      lastErr = err;
    }
  }

  // List 枚举全部活动组，避免遗漏服务端当期节点
  try {
    collected.push(...flattenActivityChildren(await listActivityGroups()));
  } catch (err) {
    lastErr = lastErr || err;
  }

  const nodes = summarizeQingmeiNodes(collected);
  const resolved = pickActiveQingmeiNodes(collected);
  const resolvedRootId = toNum(resolved?.root?.id);
  const claimId = toNum(resolved?.claim?.id);
  const wineId = toNum(resolved?.wine?.id);
  if (resolvedRootId > 0) result.rootId = resolvedRootId;
  if (claimId > 0) result.claimId = claimId;
  if (wineId > 0) result.wineId = wineId;

  if (claimId > 0 || wineId > 0) {
    if (claimId > 0 && claimId !== QINGMEI_SEED_CLAIM_ACTIVITY_ID) {
      activityLogger.info('青梅活动 ID 已轮换，使用服务端最新领取/酿酒节点', {
        event: 'qingmei_id_rotation',
        rootId: result.rootId,
        claimId: result.claimId,
        wineId: result.wineId,
      });
    }
    if (!claimId) {
      // 只命中酿酒节点：领取节点缺失，输出全部节点详情供排查
      activityLogger.warn('青梅活动仅解析到酿酒节点，缺少有效领取节点', {
        event: 'qingmei_claim_missing',
        wineId: result.wineId,
        rejectedIds: [...rejectedQingmeiNodeIds],
        nodes,
        lastError: lastErr?.message || '',
      });
    }
    cached.dateKey = dateKey;
    cached.expiresAt = Date.now() + 30 * 60 * 1000;
    cached.ids = { ...result };
    return { ...result };
  }

  activityLogger.warn('青梅活动组未解析到有效领取/酿酒节点，回退写死常量', {
    event: 'qingmei_resolve_miss',
    rootIds,
    rejectedIds: [...rejectedQingmeiNodeIds],
    nodes,
    lastError: lastErr?.message || '',
  });
  return result;
}

function normalizeQingmeiActivity(reply) {
  const activities = flattenActivityChildren(reply);
  const resolved = resolveQingmeiNodesFromChildren(activities);
  const root = reply?.group?.activity || resolved.root || {};
  const claim = resolved.claim || {};
  const wine = resolved.wine || {};
  const status = toNum(claim?.status);
  const claimedToday = isQingmeiClaimedToday();
  const hasServerClaimStatus = claim?.status !== undefined && claim?.status !== null;
  const materialInfo = getItemById(QINGMEI_FRUIT_ITEM_ID);

  return {
    uid: reply?.__activityUid || QINGMEI_ACTIVITY_UID,
    title: '青酿换万金',
    activityId: toNum(root?.id) || QINGMEI_ACTIVITY_ID,
    claimActivityId: toNum(claim?.id) || QINGMEI_SEED_CLAIM_ACTIVITY_ID,
    claimCommand: QINGMEI_SEED_CLAIM_CMD,
    wineActivityId: toNum(wine?.id) || QINGMEI_WINE_ACTIVITY_ID,
    wineTitle: wine?.title || '青酿换万金',
    winePreviewCommand: QINGMEI_WINE_PREVIEW_CMD,
    wineBrewCommand: QINGMEI_WINE_BREW_CMD,
    wineSellCommand: QINGMEI_WINE_SELL_CMD,
    startTime: toNum(root?.start_time ?? root?.startTime ?? claim?.start_time ?? claim?.startTime),
    endTime: toNum(root?.end_time ?? root?.endTime ?? claim?.end_time ?? claim?.endTime),
    status,
    claimed: claimedToday || (hasServerClaimStatus && status === 3),
    // 领取节点通常不下发每日领取状态；未知时允许用户点击，由 Operate
    // 的“已领取”响应校准本进程当天状态。
    claimable: !claimedToday && (!hasServerClaimStatus || status !== 3) && claim?.enabled !== false,
    claimStatusKnown: claimedToday || hasServerClaimStatus,
    reward: {
      itemId: QINGMEI_SEED_ITEM_ID,
      itemCount: QINGMEI_SEED_REWARD_COUNT,
      itemName: getItemById(QINGMEI_SEED_ITEM_ID)?.name || '青梅种子',
      image: getItemImageById(QINGMEI_SEED_ITEM_ID) || '',
    },
    material: {
      itemId: QINGMEI_FRUIT_ITEM_ID,
      itemCount: 0,
      itemName: materialInfo?.name || '青梅',
      image: getItemImageById(QINGMEI_FRUIT_ITEM_ID) || '',
    },
    payload: parsePayload(root?.payload || wine?.payload || claim?.payload),
  };
}

async function getQingmeiActivity() {
  try {
    const { rootId } = await resolveQingmeiActivityIds();
    const reply = await getActivityGroupWithUidFallback(rootId, [QINGMEI_ACTIVITY_UID, '']);
    const activity = normalizeQingmeiActivity(reply);
    activity.material.itemCount = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID);
    return activity;
  } catch (err) {
    const materialInfo = getItemById(QINGMEI_FRUIT_ITEM_ID);
    return {
      uid: QINGMEI_ACTIVITY_UID,
      title: '青酿换万金',
      activityId: QINGMEI_ACTIVITY_ID,
      claimActivityId: QINGMEI_SEED_CLAIM_ACTIVITY_ID,
      claimCommand: QINGMEI_SEED_CLAIM_CMD,
      wineActivityId: QINGMEI_WINE_ACTIVITY_ID,
      wineTitle: '青酿换万金',
      winePreviewCommand: QINGMEI_WINE_PREVIEW_CMD,
      wineBrewCommand: QINGMEI_WINE_BREW_CMD,
      wineSellCommand: QINGMEI_WINE_SELL_CMD,
      // 活动组查询失败（节点下架）时，用写死结束时间兜底，确保 worker 判为已过期。
      startTime: 0,
      endTime: QINGMEI_WINE_END_TIME,
      claimed: false,
      claimable: false,
      reward: {
        itemId: QINGMEI_SEED_ITEM_ID,
        itemCount: QINGMEI_SEED_REWARD_COUNT,
        itemName: getItemById(QINGMEI_SEED_ITEM_ID)?.name || '青梅种子',
        image: getItemImageById(QINGMEI_SEED_ITEM_ID) || '',
      },
      material: {
        itemId: QINGMEI_FRUIT_ITEM_ID,
        itemCount: await getBagItemCount(QINGMEI_FRUIT_ITEM_ID),
        itemName: materialInfo?.name || '青梅',
        image: getItemImageById(QINGMEI_FRUIT_ITEM_ID) || '',
      },
      warning: err?.message || String(err),
    };
  }
}

function isActivityParamError(err) {
  return String(err?.message || err || '').includes('1034005');
}

function invalidateQingmeiResolvedCache() {
  qingmeiResolvedIdsCache.ids = null;
  qingmeiResolvedIdsCache.expiresAt = 0;
}

/**
 * 青梅领取参数 type 按天轮换：主活动 ID 内嵌起始日期（2026081200 → 2026-08-12），
 * 自起始日第 N 天的有效 type = N（8-12→1、8-13→2、8-14→3……）。
 * 写死固定 type 会在跨天后被服务端以 1034005「活动参数错误」拒绝。
 */
function getDateBasedQingmeiClaimType(rootId) {
  const ymd = Math.floor((toNum(rootId) || QINGMEI_ACTIVITY_ID) / 100);
  const year = Math.floor(ymd / 10000);
  const month = Math.floor((ymd % 10000) / 100);
  const day = ymd % 100;
  if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31) return 1;
  const base = new Date(year, month - 1, day).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const elapsedDays = Math.round((today - base) / (24 * 60 * 60 * 1000));
  return Math.max(1, elapsedDays + 1);
}

// 记录当天服务端实际接受的领取 type（日期推导值不匹配时探测到的值）
const qingmeiClaimTypeByDate = new Map();

function getQingmeiClaimTypeCandidates(rootId) {
  const candidates = [];
  const confirmed = qingmeiClaimTypeByDate.get(getLocalDateKey());
  if (confirmed > 0) candidates.push(confirmed);
  candidates.push(getDateBasedQingmeiClaimType(rootId));
  for (let type = 1; type <= 6; type += 1) candidates.push(type);
  return [...new Set(candidates)];
}

async function claimQingmeiSeeds() {
  const beforeCount = await getBagItemCount(QINGMEI_SEED_ITEM_ID);
  const resolved = await resolveQingmeiActivityIds();
  const claimId = resolved.claimId;
  const typeCandidates = getQingmeiClaimTypeCandidates(resolved.rootId);
  let reply = null;
  let lastErr = null;

  for (const [index, claimType] of typeCandidates.entries()) {
    try {
      reply = await operateActivityReply(claimId, QINGMEI_SEED_CLAIM_CMD, {
        qingmeiClaim: { type: claimType },
      });
      if (index > 0) {
        activityLogger.warn('青梅领取参数 type 已轮换，探测到服务端接受的 type', {
          event: 'qingmei_claim_type_resolved',
          claimId,
          claimType,
          rejectedTypes: typeCandidates.slice(0, index),
        });
      }
      qingmeiClaimTypeByDate.set(getLocalDateKey(), claimType);
      break;
    } catch (err) {
      if (isAlreadyClaimedError(err)) {
        markQingmeiClaimedToday();
        return {
          ok: true,
          alreadyClaimed: true,
          claimedCount: 0,
          beforeCount,
          afterCount: beforeCount,
          qingmei: await getQingmeiActivity(),
        };
      }
      // 参数错误说明该 type 不是当天有效值，继续尝试下一个候选
      if (isActivityParamError(err)) {
        lastErr = err;
        activityLogger.info('青梅领取参数 type 被服务端拒绝，尝试下一个候选', {
          event: 'qingmei_claim_type_rejected',
          claimId,
          claimType,
        });
        continue;
      }
      throw err;
    }
  }

  // 全部 type 被拒才认定节点失效：拉黑后重新解析并换节点重试一次
  if (!reply) {
    rejectedQingmeiNodeIds.add(claimId);
    invalidateQingmeiResolvedCache();
    const retry = await resolveQingmeiActivityIds();
    if (retry.claimId > 0 && retry.claimId !== claimId) {
      activityLogger.warn('青梅领取节点已失效，使用新节点重试', {
        event: 'qingmei_claim_retry',
        rejectedClaimId: claimId,
        claimId: retry.claimId,
      });
      try {
        reply = await operateActivityReply(retry.claimId, QINGMEI_SEED_CLAIM_CMD, {
          qingmeiClaim: { type: getQingmeiClaimTypeCandidates(retry.rootId)[0] },
        });
      } catch (retryErr) {
        if (isActivityParamError(retryErr)) markQingmeiClaimedToday();
        throw retryErr;
      }
    } else {
      // 无可用新节点：标记今日已领取，避免自动任务当天反复探测无效 type
      markQingmeiClaimedToday();
      throw lastErr || new Error('领取青梅种子失败: 服务端拒绝全部领取参数 type');
    }
  }

  const claimResult = normalizeQingmeiClaimResult(reply?.qingmei_claim);
  await delay(HELU_DRAW_REFRESH_DELAY_MS);
  const afterCount = await getBagItemCount(QINGMEI_SEED_ITEM_ID);
  const claimedCount = claimResult.claimedCount || Math.max(0, afterCount - beforeCount);
  if (claimedCount <= 0) {
    throw new Error('领取青梅种子失败: 服务端未返回奖励，背包数量也未增加');
  }
  if (claimedCount > 0) markQingmeiClaimedToday();

  activityLogger.info('领取青梅种子完成', {
    event: 'qingmei_seed_claim',
    itemId: QINGMEI_SEED_ITEM_ID,
    beforeCount,
    afterCount,
    claimedCount,
    rewardItems: claimResult.items,
  });

  return {
    ok: true,
    claimedCount,
    beforeCount,
    afterCount,
    rewards: claimResult.items,
    qingmei: await getQingmeiActivity(),
  };
}

async function brewAndSellQingmeiWine(options = {}) {
  const share = options?.share !== false;
  const brewSteps = Math.max(1, Number(options?.brewSteps) || QINGMEI_FINE_BREW_STEPS);
  const { wineId: wineActivityId } = await resolveQingmeiActivityIds();
  const materialItems = await getQingmeiWineMaterialItems();
  const beforeMaterialCount = materialItems.reduce((sum, item) => sum + Math.max(0, toNum(item?.count)), 0);
  if (beforeMaterialCount <= 0) {
    throw createQingmeiWineError('material', '青梅不足，无法精酿');
  }

  let previewReply = null;
  let previewWarning = '';
  try {
    previewReply = await operateActivityReply(wineActivityId, QINGMEI_WINE_PREVIEW_CMD, {
      qingmeiWineStart: { items: materialItems },
    });
  } catch (err) {
    previewWarning = `打开青梅酿售卖失败，已尝试直接精酿: ${err.message}`;
  }
  const preview = normalizeQingmeiPreviewResult(previewReply?.qingmei_preview);
  await delay(QINGMEI_WINE_STEP_DELAY_MS);

  const brews = [];
  for (let index = 0; index < brewSteps; index += 1) {
    let brewReply = null;
    try {
      brewReply = await operateActivityReply(wineActivityId, QINGMEI_WINE_BREW_CMD, {
        qingmeiWineBrew: true,
      });
    } catch (err) {
      if (index === 0 && isNoOngoingQingmeiBrewError(err)) {
        try {
          const retryMaterialItems = await getQingmeiWineMaterialItems();
          previewReply = await operateActivityReply(wineActivityId, QINGMEI_WINE_PREVIEW_CMD, {
            qingmeiWineStart: { items: retryMaterialItems },
          });
          await delay(QINGMEI_WINE_STEP_DELAY_MS);
          brewReply = await operateActivityReply(wineActivityId, QINGMEI_WINE_BREW_CMD, {
            qingmeiWineBrew: true,
          });
        } catch (retryErr) {
          throw createQingmeiWineError('brew', `青梅酿精酿失败: ${retryErr.message}`, retryErr);
        }
      } else {
        throw createQingmeiWineError('brew', `青梅酿精酿失败: ${err.message}`, err);
      }
    }
    const brew = normalizeQingmeiBrewResult(brewReply?.qingmei_brew);
    if (brew) brews.push(brew);
    await delay(QINGMEI_WINE_STEP_DELAY_MS);
  }

  const finalBrew = brews[brews.length - 1] || null;
  if (!finalBrew) {
    throw createQingmeiWineError('brew', beforeMaterialCount <= 0
      ? '青梅不足，无法精酿'
      : '精酿未返回有效结果，请稍后重试');
  }

  let shareResult = { canShare: false, shared: false, success: false };
  if (share && finalBrew?.canDouble) {
    try {
      shareResult = await reportQingmeiShareForDouble();
    } catch (err) {
      throw createQingmeiWineError('share', `青梅酿分享翻倍失败: ${err.message}`, err);
    }
    await delay(HELU_DRAW_REFRESH_DELAY_MS);
  }

  let sellReply = null;
  const sellMultiple = shareResult.shared ? 2 : 1;
  try {
    sellReply = await operateActivityReply(wineActivityId, QINGMEI_WINE_SELL_CMD, {
      qingmeiWineSell: { multiple: sellMultiple },
    });
  } catch (err) {
    throw createQingmeiWineError('sell', `青梅酿售卖失败: ${err.message}`, err);
  }
  const sell = normalizeQingmeiSellResult(sellReply?.qingmei_sell);
  if (!sell || sell.gold <= 0) {
    throw createQingmeiWineError('sell', '售卖未返回金币收益，请稍后刷新活动状态');
  }
  await delay(HELU_DRAW_REFRESH_DELAY_MS);
  const afterMaterialCount = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID);

  activityLogger.info('青梅酿售卖完成', {
    event: 'qingmei_wine_sell',
    beforeMaterialCount,
    afterMaterialCount,
    materialBatchCount: materialItems.length,
    brewSteps: brews.length,
    wineType: finalBrew?.wineType,
    price: finalBrew?.price,
    shared: shareResult.shared,
    sellMultiple,
    gold: sell?.gold,
  });

  return {
    ok: true,
    beforeMaterialCount,
    afterMaterialCount,
    consumedCount: Math.max(0, beforeMaterialCount - afterMaterialCount),
    materialBatchCount: materialItems.length,
    preview,
    previewWarning,
    brews,
    brew: finalBrew,
    share: shareResult,
    sell,
    activity: await getStarActivity().catch(() => null),
  };
}

function computeHeluDrawActions(drawInfo) {
  const freeRemaining = Math.max(0, toNum(drawInfo?.freeRemaining));
  const paidRemaining = Math.max(0, toNum(drawInfo?.paidRemaining));
  const paidPrice = Math.max(0, toNum(drawInfo?.paidPrice));
  const paidCurrencyId = toNum(drawInfo?.paidCurrencyId) || 1002;

  const drawOneIsFree = freeRemaining > 0;
  const drawOnePaid = !drawOneIsFree && paidRemaining > 0;
  const drawOneCount = drawOneIsFree || drawOnePaid ? 1 : 0;

  let batchCount = 0;
  let batchCost = 0;
  let batchType = 'none';
  if (freeRemaining > 0) {
    batchCount = Math.min(4, freeRemaining);
    batchType = 'free';
  } else if (paidRemaining > 0) {
    batchCount = Math.min(4, paidRemaining);
    batchCost = batchCount * paidPrice;
    batchType = 'paid';
  }

  return {
    one: {
      count: drawOneCount,
      available: drawOneCount > 0,
      cost: drawOnePaid ? paidPrice : 0,
      currencyId: drawOnePaid ? paidCurrencyId : 0,
      type: drawOneIsFree ? 'free' : drawOnePaid ? 'paid' : 'none',
      label: drawOneIsFree ? '免费1次' : drawOnePaid ? `${paidPrice}点券1次` : '已抽完',
    },
    batch: {
      count: batchCount,
      available: batchCount > 0,
      cost: batchCost,
      currencyId: batchType === 'paid' ? paidCurrencyId : 0,
      type: batchType,
      label: batchType === 'free'
        ? `免费${batchCount}次`
        : batchType === 'paid'
          ? `${batchCost}点券${batchCount}次`
          : '已抽完',
    },
  };
}

function normalizeSeasonRewardTier(rawBytes) {
  const entries = readProtoFields(rawBytes);
  return {
    level: getProtoNumber(entries, 1),
    freeRewards: getProtoBytesAll(entries, 2).map(parseActivityItemMessage).filter(Boolean),
    premiumRewards: getProtoBytesAll(entries, 3).map(parseActivityItemMessage).filter(Boolean),
  };
}

function normalizeSeasonPassport(rawBytes, rewardItems = []) {
  const entries = readProtoFields(rawBytes);
  const currentLevel = getProtoNumber(entries, 2);
  const score = getProtoNumber(entries, 3);
  const currentProgress = getProtoNumber(entries, 4);
  const nextLevelNeed = getProtoNumber(entries, 5);
  const maxLevel = getProtoNumber(entries, 6);
  const freeClaimedLevel = getProtoNumber(entries, 9);
  const premiumClaimedLevel = getProtoNumber(entries, 11);
  const levelRewardTiers = getProtoBytesAll(entries, 8)
    .map(normalizeSeasonRewardTier)
    .filter((tier) => tier.level > 0);

  return {
    uid: HELU_PASSPORT_UID,
    title: getProtoString(entries, 16, '荷风游记'),
    activityId: getProtoNumber(entries, 1) || HELU_ACTIVITY_ID,
    currentLevel,
    score,
    currentProgress,
    nextLevelNeed,
    maxLevel,
    freeClaimedLevel,
    premiumClaimedLevel,
    claimableLevels: Math.max(0, currentLevel - freeClaimedLevel),
    rewardTierCount: levelRewardTiers.length,
    levelRewardTiers,
    rewards: rewardItems,
    configText: getProtoString(entries, 17, ''),
  };
}

function normalizeSeasonInfo(rawBody) {
  const replyEntries = readProtoFields(rawBody);
  const seasonBytes = getProtoBytes(replyEntries, 1);
  if (!seasonBytes) {
    return {
      uid: HELU_PASSPORT_UID,
      title: '荷风游记',
      currentLevel: 0,
      claimableLevels: 0,
      rewards: [],
      levelRewardTiers: [],
    };
  }

  const seasonEntries = readProtoFields(seasonBytes);
  const passportBytes = getProtoBytes(seasonEntries, 10);
  const passport = normalizeSeasonPassport(passportBytes, []);

  return {
    ...passport,
    seasonTitle: getProtoString(seasonEntries, 2, HELU_TITLE),
    seasonStatus: getProtoNumber(seasonEntries, 3),
    startTime: getProtoNumber(seasonEntries, 5),
    endTime: getProtoNumber(seasonEntries, 6),
    nowTime: getProtoNumber(seasonEntries, 7),
  };
}

function normalizeSeasonClaimResult(rawBody) {
  const entries = readProtoFields(rawBody);
  const rewards = getProtoBytesAll(entries, 1).map(parseActivityItemMessage).filter(Boolean);
  const passportBytes = getProtoBytes(entries, 3);
  return {
    rewards,
    passport: passportBytes ? normalizeSeasonPassport(passportBytes, rewards) : null,
  };
}

function solarStatusLabel(status) {
  if (status === 2) return '可领取';
  if (status === 3) return '已领取';
  if (status === 1) return '未开启';
  if (status === 5) return '已结束';
  return `状态${status}`;
}

function normalizeSolarTerm(rawBytes) {
  const entries = readProtoFields(rawBytes);
  const status = getProtoNumber(entries, 2);
  return {
    id: getProtoNumber(entries, 1),
    status,
    statusLabel: solarStatusLabel(status),
    claimable: status === 2,
    startTime: getProtoNumber(entries, 3),
    endTime: getProtoNumber(entries, 4),
    rewards: getProtoBytesAll(entries, 5).map(parseActivityItemMessage).filter(Boolean),
    title: getProtoString(entries, 6, ''),
  };
}

function normalizeSolarTermsInfo(rawBody) {
  const entries = readProtoFields(rawBody);
  const terms = getProtoBytesAll(entries, 1)
    .map(normalizeSolarTerm)
    .filter((term) => term.id > 0);
  const configEntries = readProtoFields(getProtoBytes(entries, 3));

  return {
    nowTime: getProtoNumber(entries, 2),
    terms,
    claimableCount: terms.filter((term) => term.claimable).length,
    currentTerm: terms.find((term) => term.claimable) || terms.find((term) => term.status === 3) || terms[0] || null,
    tipsText: getProtoString(configEntries, 3, ''),
  };
}

function normalizeSolarTermsClaimResult(rawBody) {
  const entries = readProtoFields(rawBody);
  const termBytes = getProtoBytes(entries, 2);
  return {
    rewards: getProtoBytesAll(entries, 1).map(parseActivityItemMessage).filter(Boolean),
    term: termBytes ? normalizeSolarTerm(termBytes) : null,
  };
}

async function getSeasonPassport() {
  return normalizeSeasonInfo(await getSeasonInfoRaw());
}

async function claimSeasonPassportRewards() {
  const before = await getSeasonPassport();
  const result = normalizeSeasonClaimResult(await claimSeasonRewardsRaw());
  const after = await getSeasonPassport();

  activityLogger.info('荷风游记领取成功', {
    event: 'season_passport_claim',
    beforeLevel: before.currentLevel,
    beforeClaimedLevel: before.freeClaimedLevel,
    afterLevel: after.currentLevel,
    afterClaimedLevel: after.freeClaimedLevel,
    rewardCount: result.rewards.length,
  });

  return {
    ok: true,
    rewards: result.rewards,
    passport: after,
    claimedLevels: Math.max(0, after.freeClaimedLevel - before.freeClaimedLevel),
  };
}

async function getSolarTermsInfo() {
  return normalizeSolarTermsInfo(await getSolarTermsRaw());
}

async function claimSolarTermsReward(termId = 0) {
  const before = await getSolarTermsInfo();
  const resolvedTermId = Number(termId) || toNum(before?.currentTerm?.id);
  if (resolvedTermId <= 0) throw new Error('未找到可领取的节令奖励');

  const target = (before.terms || []).find((term) => term.id === resolvedTermId) || null;
  if (target && !target.claimable) {
    throw new Error(`${target.title || '该节令'}当前不可领取`);
  }

  const result = normalizeSolarTermsClaimResult(await claimSolarTermsRaw(resolvedTermId));
  const after = await getSolarTermsInfo();

  activityLogger.info('节令小札领取成功', {
    event: 'solar_terms_claim',
    termId: resolvedTermId,
    termTitle: target?.title || result.term?.title || '',
    rewardCount: result.rewards.length,
  });

  return {
    ok: true,
    termId: resolvedTermId,
    rewards: result.rewards,
    term: result.term,
    solarTerms: after,
  };
}

function parseStarRecordExtra(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStarRecord(node) {
  const info = node?.star_record || node?.starRecord || {};
  const configs = Array.isArray(info?.configs) ? info.configs : [];
  const states = new Map(
    (Array.isArray(info?.records) ? info.records : [])
      .map(record => [toNum(record?.id), record])
  );

  const records = configs.map((config) => {
    const id = toNum(config?.id);
    const state = states.get(id) || {};
    const extra = parseStarRecordExtra(config?.extra);
    return {
      id,
      title: String(config?.title || `星宿${id}`),
      category: String(extra?.category || ''),
      explain: String(extra?.explain || ''),
      graph: String(config?.graph || ''),
      featured: !!config?.featured,
      unlocked: !!state?.unlocked,
      claimed: !!state?.claimed,
      claimable: !!state?.unlocked && !state?.claimed,
      rewards: (state?.rewards || []).map(normalizeCoreItem).filter(item => item.itemId > 0),
    };
  });

  return {
    status: toNum(info?.status),
    openedDays: toNum(info?.opened_days ?? info?.openedDays),
    records,
    totalCount: records.length,
    unlockedCount: records.filter(record => record.unlocked).length,
    claimedCount: records.filter(record => record.claimed).length,
    claimableCount: records.filter(record => record.claimable).length,
  };
}

function findActivityNode(nodes, activityId) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (toNum(node?.activity?.id) === toNum(activityId)) return node;
    const child = findActivityNode(node?.children, activityId);
    if (child) return child;
  }
  return null;
}

async function getStarActivity() {
  if (!getUserState()) {
    return {
      uid: STAR_ACTIVITY_UID,
      title: '心许千灯星垂野',
      activityId: STAR_ACTIVITY_ID,
      starRecord: normalizeStarRecord(null),
      exchangeShop: [],
      starSandBalance: 0,
      passport: null,
      solarTerms: null,
      qingmei: await getQingmeiActivity(),
      warning: 'runtime connection is not open',
    };
  }

  const listed = await listActivityGroups();
  const rootNode = findActivityNode(listed?.groups, STAR_ACTIVITY_ID);
  const recordNode = findActivityNode(listed?.groups, STAR_RECORD_ACTIVITY_ID);
  if (!rootNode || !recordNode) {
    // 活动已结束/下架：优雅降级返回带 warning 的对象，避免 /api/activity/star 抛 500、
    // 也避免 worker 自动领取每轮刷错误日志。前端据此展示「活动已结束」，活动返厂时自动恢复。
    return {
      uid: STAR_ACTIVITY_UID,
      title: '心许千灯星垂野',
      activityId: STAR_ACTIVITY_ID,
      recordActivityId: STAR_RECORD_ACTIVITY_ID,
      recordClaimCommand: STAR_RECORD_CLAIM_CMD,
      shopActivityId: STAR_SHOP_ACTIVITY_ID,
      shopOpenCommand: STAR_SHOP_OPEN_CMD,
      startTime: 0,
      endTime: 0,
      starRecord: normalizeStarRecord(null),
      exchangeShop: [],
      shopReadOnly: true,
      shopWarning: '活动已结束',
      starSandCurrencyId: STAR_SAND_ITEM_ID,
      starSandBalance: 0,
      passport: { title: '千星游记', claimableLevels: 0, warning: '活动已结束' },
      solarTerms: { terms: [], claimableCount: 0, nowTime: 0 },
      qingmei: null,
      summary: { starCount: 0, exchangeShopCount: 0 },
      warning: '心许千灯星垂野活动已结束或不存在',
    };
  }

  let shopItems = [];
  let shopWarning = '';
  try {
    const shopReply = await operateActivityReply(STAR_SHOP_ACTIVITY_ID, STAR_SHOP_OPEN_CMD);
    const shopNode = shopReply?.group || null;
    const shop = shopNode?.exchange_shop || shopNode?.exchangeShop || null;
    shopItems = (shop?.items || []).map(normalizeExchangeShopItem).filter(Boolean).map(item => ({
      ...item,
      currencyName: item.currencyId === STAR_SAND_ITEM_ID ? '星砂' : item.currencyName,
    }));
  } catch (err) {
    shopWarning = err?.message || String(err);
  }

  const currencyId = toNum(shopItems.find(item => item.currencyId > 0)?.currencyId) || STAR_SAND_ITEM_ID;
  const [passport, solarTerms, starSandBalance, qingmei] = await Promise.all([
    getSeasonPassport().catch(err => ({ title: '千星游记', warning: err?.message || String(err), claimableLevels: 0 })),
    getSolarTermsInfo().catch(err => ({ terms: [], claimableCount: 0, warning: err?.message || String(err) })),
    currencyId > 0 ? getBagItemCount(currencyId) : Promise.resolve(0),
    getQingmeiActivity(),
  ]);

  return {
    uid: STAR_ACTIVITY_UID,
    title: String(rootNode?.activity?.title || '心许千灯星垂野'),
    activityId: STAR_ACTIVITY_ID,
    recordActivityId: STAR_RECORD_ACTIVITY_ID,
    recordClaimCommand: STAR_RECORD_CLAIM_CMD,
    shopActivityId: STAR_SHOP_ACTIVITY_ID,
    shopOpenCommand: STAR_SHOP_OPEN_CMD,
    startTime: toNum(rootNode?.activity?.start_time),
    endTime: toNum(rootNode?.activity?.end_time),
    starRecord: normalizeStarRecord(recordNode),
    exchangeShop: shopItems,
    shopReadOnly: false,
    shopWarning,
    starSandCurrencyId: currencyId,
    starSandBalance,
    passport,
    solarTerms,
    qingmei,
    summary: {
      starCount: normalizeStarRecord(recordNode).totalCount,
      exchangeShopCount: shopItems.length,
    },
  };
}

async function claimStarRecordRewards() {
  assertActivityConnection('观星礼录领取');
  const before = await getStarActivity();
  if (before?.starRecord?.claimableCount <= 0) {
    throw new Error('当前没有可点亮或领取的星宿');
  }

  const reply = await operateActivityReply(STAR_RECORD_ACTIVITY_ID, STAR_RECORD_CLAIM_CMD);
  const result = reply?.star_record_claim || reply?.starRecordClaim || {};
  const recordIds = (result?.record_ids || result?.recordIds || []).map(toNum).filter(id => id > 0);
  const rewards = (result?.rewards || []).map(normalizeCoreItem).filter(item => item.itemId > 0);
  const after = await getStarActivity();

  activityLogger.info('观星礼录领取成功', {
    event: 'star_record_claim',
    recordIds,
    rewardCount: rewards.length,
  });

  return {
    ok: true,
    recordIds,
    rewards,
    activity: after,
  };
}

async function exchangeStarShopItem(slotId, count = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的星砂商店槽位');

  const exchangeCount = Math.floor(Number(count) || 0);
  if (exchangeCount <= 0) throw new Error('兑换数量必须大于 0');

  const before = await getStarActivity();
  const slots = Array.isArray(before?.exchangeShop) ? before.exchangeShop : [];
  const slot = slots.find(item => toNum(item?.id) === slotIdNum);
  if (!slot) throw new Error(`星砂商店未找到槽位: ${slotIdNum}`);

  const price = Math.max(0, toNum(slot?.price));
  const balance = Math.max(0, toNum(before?.starSandBalance));
  const exchangeLimit = Math.max(0, toNum(slot?.exchangeLimit));
  const totalPrice = price * exchangeCount;
  const ownedBlocksExchange = slot?.ownedBlocksExchange !== false
    && slot?.owned
    && !slot?.isRepeatable;

  if (toNum(slot?.currencyId) !== STAR_SAND_ITEM_ID) {
    throw new Error(`暂不支持非星砂货币兑换: slotId=${slotIdNum}`);
  }
  if (ownedBlocksExchange) throw new Error(`该商品已拥有，不能重复兑换: slotId=${slotIdNum}`);
  if (!slot?.isRepeatable && exchangeCount > 1) throw new Error('该商品每次只能兑换 1 个');
  if (exchangeLimit > 0 && exchangeCount > exchangeLimit) {
    throw new Error(`兑换数量超过上限: 最多可兑换 ${exchangeLimit} 个`);
  }
  if (totalPrice > balance) throw new Error(`星砂不足: 需要 ${totalPrice}, 当前 ${balance}`);

  activityLogger.info('星砂商店兑换开始', {
    slotId: slotIdNum,
    itemId: toNum(slot?.itemId),
    itemName: slot?.itemName || slot?.name || '',
    price,
    count: exchangeCount,
    totalPrice,
    balance,
    activityId: STAR_SHOP_ACTIVITY_ID,
    cmd: STAR_SHOP_EXCHANGE_CMD,
  });

  try {
    await operateActivity(STAR_SHOP_ACTIVITY_ID, STAR_SHOP_EXCHANGE_CMD, {
      exchangeShopOperate: {
        id: slotIdNum,
        count: exchangeCount,
      },
    });
  } catch (err) {
    throw new Error(
      `星砂商店兑换失败: slotId=${slotIdNum}, itemId=${toNum(slot?.itemId)}, price=${price}: ${err.message}`
    );
  }

  return {
    ok: true,
    slotId: slotIdNum,
    price,
    count: exchangeCount,
    totalPrice,
    currencyId: STAR_SAND_ITEM_ID,
    item: slot,
    activity: await getStarActivity(),
  };
}

function normalizeHeluGroup(reply, lastDrawResult = null) {
  const activities = flattenActivityChildren(reply);
  const getDrawInfo = (act) => act?.draw_info || act?.drawInfo || null;
  const getExchangeShop = (act) => act?.exchange_shop || act?.exchangeShop || null;

  const drawAct = activities.find((a) => toNum(a?.id) === HELU_DRAW_ACTIVITY_ID)
    || activities.find((a) => /奇遇礼莲/.test(String(a?.title || '')))
    || activities.find((a) => getDrawInfo(a))
    || null;

  const exchangeAct = activities.find(
    (a) => /荷露商店/.test(String(a?.title || ''))
      || (getExchangeShop(a) && Array.isArray(getExchangeShop(a).items) && getExchangeShop(a).items.length > 0)
  ) || null;

  // draw_info 是否真来自服务端。空数据（活动没下发/已下架）时 normalizeDrawInfo({}) 会
  // 兜底造出 freeMax=4/paidMax=4 → dailyMax=8，**不能**用 dailyMax>0 判在期，
  // 否则已下架的活动会天天出现在日报里（2026-10-22 用户实测：没参加过荷风却天天见）。
  const rawDrawFromNode = getDrawInfo(drawAct);
  const hasNodeDraw = !!rawDrawFromNode && (typeof rawDrawFromNode !== 'object' || Object.keys(rawDrawFromNode).length > 0);
  const scannedDraw = hasNodeDraw ? null : scanDrawInfoFromRawBody(reply?.__rawBody);
  let drawInfo = normalizeDrawInfo(rawDrawFromNode) || scannedDraw;
  let exchangeItems = (getExchangeShop(exchangeAct)?.items || [])
    .map(normalizeExchangeShopItem)
    .filter(Boolean);
  const rawExchange = scanExchangeShopInfoFromRawBody(reply?.__rawBody);
  if (exchangeItems.length === 0 && rawExchange) {
    exchangeItems = rawExchange.items;
  }
  if (!drawInfo) drawInfo = normalizeDrawInfo({});
  // hasServerData：true=服务端真下发；false=纯兜底（活动不在期）
  drawInfo.hasServerData = hasNodeDraw || !!scannedDraw;
  if (!drawInfo._hasPaidRemaining && drawInfo.freeRemaining <= 0) {
    drawInfo.paidUsed = drawInfo.paidMax;
    drawInfo.paidRemaining = 0;
  }
  drawInfo.actions = computeHeluDrawActions(drawInfo);
  drawInfo.dailyMax = drawInfo.freeMax + drawInfo.paidMax;
  drawInfo.dailyUsed = drawInfo.freeUsed + drawInfo.paidUsed;
  drawInfo.dailyRemaining = drawInfo.freeRemaining + drawInfo.paidRemaining;

  const root = reply?.group?.activity || {};
  const subActivities = normalizeHeluSubActivities(activities);
  return {
    uid: reply?.__activityUid || HELU_ACTIVITY_UID,
    title: String(root?.title || '荷风十里蝉初鸣'),
    activityId: toNum(root?.id) || HELU_ACTIVITY_ID,
    drawActivityId: toNum(drawAct?.id) || HELU_DRAW_ACTIVITY_ID,
    drawCommand: HELU_DRAW_CMD,
    draw: drawInfo,
    exchangeActivityId: toNum(exchangeAct?.id),
    exchangeShop: exchangeItems,
    subActivities,
    lastDrawResult,
    summary: {
      rewardPoolCount: drawInfo.rewardPool.length,
      exchangeShopCount: exchangeItems.length,
      activityCount: activities.length,
      subActivityCount: subActivities.length,
      dailyUsed: drawInfo.dailyUsed,
      dailyRemaining: drawInfo.dailyRemaining,
    },
    raw: {
      activityCount: activities.length,
      activityTitles: activities.map((a) => String(a?.title || '')).filter(Boolean),
      activityIds: activities.map((a) => toNum(a?.id)).filter((id) => id > 0),
    },
  };
}

async function getHeluActivity() {
  const state = getUserState();
  if (!state) {
    return {
      uid: HELU_ACTIVITY_UID,
      title: '荷风十里蝉初鸣',
      draw: {
        ...normalizeDrawInfo({}),
        actions: computeHeluDrawActions(normalizeDrawInfo({})),
      },
      heluBalance: 0,
      subActivities: normalizeHeluSubActivities([]),
      passport: {
        uid: HELU_PASSPORT_UID,
        title: '荷风游记',
        currentLevel: 0,
        claimableLevels: 0,
        rewards: [],
        levelRewardTiers: [],
      },
      solarTerms: {
        terms: [],
        claimableCount: 0,
        currentTerm: null,
      },
      summary: { rewardPoolCount: 0, subActivityCount: HELU_SUB_ACTIVITY_DEFS.length },
      qingmei: await getQingmeiActivity(),
      warning: 'runtime connection is not open',
    };
  }

  const activity = normalizeHeluGroup(
    await getActivityGroupWithUidFallback(HELU_ACTIVITY_ID, getHeluActivityUidCandidates())
  );
  activity.heluBalance = await getHeluBalance();
  try {
    activity.passport = await getSeasonPassport();
  } catch (err) {
    activity.passport = {
      uid: HELU_PASSPORT_UID,
      title: '荷风游记',
      currentLevel: 0,
      claimableLevels: 0,
      rewards: [],
      levelRewardTiers: [],
      warning: err?.message || String(err),
    };
  }
  try {
    activity.solarTerms = await getSolarTermsInfo();
  } catch (err) {
    activity.solarTerms = {
      terms: [],
      claimableCount: 0,
      currentTerm: null,
      warning: err?.message || String(err),
    };
  }
  activity.qingmei = await getQingmeiActivity();
  return activity;
}

function resolveHeluDrawCount(activity, options = {}) {
  const draw = activity?.draw || {};
  const mode = String(options?.mode || '').toLowerCase();
  const requestedCount = Math.max(0, toNum(options?.count));

  if (mode === 'batch' || mode === 'four' || mode === 'max') {
    return draw.actions?.batch?.count || 0;
  }
  if (mode === 'one') return draw.actions?.one?.count || 0;
  if (requestedCount > 0) {
    if (draw.freeRemaining > 0) return Math.min(requestedCount, draw.freeRemaining);
    return Math.min(requestedCount, draw.paidRemaining);
  }
  return draw.actions?.one?.count || 0;
}

async function drawHeluGiftLotus(options = {}) {
  const before = await getHeluActivity();
  const count = resolveHeluDrawCount(before, options);
  if (count <= 0) throw new Error('奇遇礼莲今日次数已用完');

  const usingFree = toNum(before?.draw?.freeRemaining) > 0;
  const expectedCost = usingFree ? 0 : count * toNum(before?.draw?.paidPrice);

  let drawResult = null;
  const drawPayload = { id: HELU_DRAW_ACTIVITY_ID, count };
  const paidPayload = { type: 0, count };
  if (!usingFree && expectedCost > 0) {
    drawPayload.cost = {
      id: toNum(before?.draw?.paidCurrencyId) || 1002,
      count: expectedCost,
    };
  }

  const drawContext = {
    requestedMode: options?.mode || '',
    requestedCount: toNum(options?.count) || 0,
    resolvedCount: count,
    mode: usingFree ? 'free' : 'paid',
    expectedCost,
    paidCurrencyId: toNum(before?.draw?.paidCurrencyId) || 1002,
    before: {
      freeUsed: toNum(before?.draw?.freeUsed),
      freeMax: toNum(before?.draw?.freeMax),
      freeRemaining: toNum(before?.draw?.freeRemaining),
      paidUsed: toNum(before?.draw?.paidUsed),
      paidMax: toNum(before?.draw?.paidMax),
      paidRemaining: toNum(before?.draw?.paidRemaining),
      paidPrice: toNum(before?.draw?.paidPrice),
    },
    payload: usingFree ? drawPayload : paidPayload,
    legacyDrawPayload: usingFree ? null : drawPayload,
  };
  activityLogger.info('奇遇礼莲抽奖开始', drawContext);

  try {
    if (usingFree && count > 1) {
      const merged = { rewards: [], items: [], cost: null };
      for (let i = 0; i < count; i += 1) {
        assertActivityConnection('奇遇礼莲抽奖');
        if (i > 0) await delay(HELU_DRAW_REQUEST_GAP_MS);

        const body = await operateActivity(HELU_DRAW_ACTIVITY_ID, HELU_DRAW_CMD, {
          draw: { id: HELU_DRAW_ACTIVITY_ID, count: 1 },
        });
        const decoded = types.ActivityOperateReply.decode(body);
        const result = normalizeDrawResult(decoded?.draw_result || decoded?.drawResult);
        if (Array.isArray(result?.rewards)) merged.rewards.push(...result.rewards);
        if (Array.isArray(result?.items)) merged.items.push(...result.items);
        if (!merged.cost && result?.cost) merged.cost = result.cost;
      }
      drawResult = merged;
    } else {
      assertActivityConnection('奇遇礼莲抽奖');
      const params = usingFree
        ? { draw: drawPayload }
        : { helu_paid_draw: paidPayload };
      const body = await operateActivity(HELU_DRAW_ACTIVITY_ID, HELU_DRAW_CMD, params);
      const decoded = types.ActivityOperateReply.decode(body);
      drawResult = normalizeDrawResult(decoded?.draw_result || decoded?.drawResult);
    }
  } catch (err) {
    activityLogger.error('奇遇礼莲抽奖失败', {
      ...drawContext,
      error: err?.message || String(err),
    });
    throw new Error(
      `奇遇礼莲抽奖失败: activityId=${HELU_DRAW_ACTIVITY_ID}, count=${count}, expectedCost=${expectedCost}: ${err.message}`
    );
  }

  await delay(HELU_DRAW_REFRESH_DELAY_MS);
  assertActivityConnection('刷新奇遇礼莲活动');
  const after = await getHeluActivity();
  activityLogger.info('奇遇礼莲抽奖成功', {
    ...drawContext,
    cost: drawResult?.cost || null,
    rewardCount: (Array.isArray(drawResult?.items) ? drawResult.items.length : 0)
      + (Array.isArray(drawResult?.rewards) ? drawResult.rewards.length : 0),
    after: {
      freeUsed: toNum(after?.draw?.freeUsed),
      freeMax: toNum(after?.draw?.freeMax),
      freeRemaining: toNum(after?.draw?.freeRemaining),
      paidUsed: toNum(after?.draw?.paidUsed),
      paidMax: toNum(after?.draw?.paidMax),
      paidRemaining: toNum(after?.draw?.paidRemaining),
    },
  });

  return {
    ok: true,
    count,
    expectedCost,
    costCurrencyId: usingFree ? 0 : toNum(before?.draw?.paidCurrencyId) || 1002,
    mode: usingFree ? 'free' : 'paid',
    result: drawResult,
    activity: {
      ...after,
      lastDrawResult: drawResult,
    },
  };
}

async function exchangeHeluShopItem(slotId, count = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的荷露商店槽位');

  const exchangeCount = Math.floor(Number(count) || 0);
  if (exchangeCount <= 0) throw new Error('兑换数量必须大于 0');

  const before = await getHeluActivity();
  const exchangeItems = Array.isArray(before?.exchangeShop) ? before.exchangeShop : [];
  const slot = exchangeItems.find((item) => toNum(item?.id) === slotIdNum);
  if (!slot) throw new Error(`荷露商店未找到槽位: ${slotIdNum}`);

  const price = Math.max(0, toNum(slot?.price));
  const balance = Math.max(0, toNum(before?.heluBalance));
  const isHeluCurrency = toNum(slot?.currencyId) === HELU_CURRENCY_ITEM_ID;
  const ownedBlocksExchange = slot?.ownedBlocksExchange !== false && slot?.owned && !slot?.isRepeatable;
  const exchangeLimit = Math.max(0, toNum(slot?.exchangeLimit));
  const totalPrice = price * exchangeCount;

  if (!isHeluCurrency) throw new Error(`暂不支持非荷露货币兑换: slotId=${slotIdNum}`);
  if (ownedBlocksExchange) throw new Error(`该商品已拥有，不能重复兑换: slotId=${slotIdNum}`);
  if (!slot?.isRepeatable && exchangeCount > 1) throw new Error('该商品每次只能兑换 1 个');
  if (exchangeLimit > 0 && exchangeCount > exchangeLimit) {
    throw new Error(`兑换数量超过上限: 最多可兑换 ${exchangeLimit} 个`);
  }
  if (totalPrice > balance) throw new Error(`荷露不足: 需要 ${totalPrice}, 当前 ${balance}`);

  activityLogger.info('荷露商店兑换开始', {
    slotId: slotIdNum,
    itemId: toNum(slot?.itemId),
    itemName: slot?.itemName || slot?.name || '',
    price,
    count: exchangeCount,
    totalPrice,
    balance,
    exchangeActivityId: HELU_EXCHANGE_ACTIVITY_ID,
    cmd: HELU_EXCHANGE_CMD,
  });

  try {
    await operateActivity(HELU_EXCHANGE_ACTIVITY_ID, HELU_EXCHANGE_CMD, {
      exchangeShopOperate: {
        id: slotIdNum,
        count: exchangeCount,
      },
    });
  } catch (err) {
    activityLogger.error('荷露商店兑换失败', {
      slotId: slotIdNum,
      itemId: toNum(slot?.itemId),
      price,
      count: exchangeCount,
      totalPrice,
      balance,
      error: err?.message || String(err),
    });
    throw new Error(`荷露商店兑换失败: slotId=${slotIdNum}, itemId=${toNum(slot?.itemId)}, price=${price}: ${err.message}`);
  }

  const after = await getHeluActivity();
  return {
    ok: true,
    slotId: slotIdNum,
    price,
    count: exchangeCount,
    totalPrice,
    currencyId: HELU_CURRENCY_ITEM_ID,
    item: slot,
    activity: after,
  };
}

// ---- 南瓜活动标准化 ----

function normalizeNanguaGroup(reply) {
  const activities = flattenActivityChildren(reply);

  const getRandomShop = (act) => act?.random_shop || act?.randomShop || null;
  const getExchangeShop = (act) => act?.exchange_shop || act?.exchangeShop || null;

  const randomAct = activities.find(
    (a) => getRandomShop(a) && Array.isArray(getRandomShop(a).items) && getRandomShop(a).items.length > 0
  ) || null;

  const exchangeAct = activities.find(
    (a) => getExchangeShop(a) && Array.isArray(getExchangeShop(a).items) && getExchangeShop(a).items.length > 0
  ) || null;

  // 优先使用 proto 解码
  let randomShop = normalizeRandomShopInfo(getRandomShop(randomAct));

  // 原始 body 扫描作为回退
  const rawRandomShop = scanRandomShopInfoFromRawBody(reply?.__rawBody);
  if (!randomShop || randomShop.items.length === 0) {
    randomShop = rawRandomShop;
  } else if (rawRandomShop) {
    randomShop = {
      ...randomShop,
      nextRefreshTime: randomShop.nextRefreshTime || rawRandomShop.nextRefreshTime,
      manualRefreshCost: randomShop.manualRefreshCost || rawRandomShop.manualRefreshCost,
      manualRefreshCurrencyId: randomShop.manualRefreshCurrencyId || rawRandomShop.manualRefreshCurrencyId,
      manualRefreshExtraValue: randomShop.manualRefreshExtraValue || rawRandomShop.manualRefreshExtraValue,
      maxManualRefreshCount: 6,
      manualRefreshUsedCount: randomShop.manualRefreshUsedCount || rawRandomShop.manualRefreshUsedCount,
    };
  }

  const randomItems = randomShop?.items || [];

  let exchangeItems = (getExchangeShop(exchangeAct)?.items || [])
    .map(normalizeExchangeShopItem)
    .filter(Boolean);

  const rawExchange = scanExchangeShopInfoFromRawBody(reply?.__rawBody);
  if (exchangeItems.length === 0 && rawExchange) {
    exchangeItems = rawExchange.items;
  }

  const refreshInfo = {
    nextRefreshTime: randomShop?.nextRefreshTime || 0,
    manualRefreshCost: randomShop?.manualRefreshCost || 0,
    manualRefreshCurrencyId: randomShop?.manualRefreshCurrencyId || 1001,
    manualRefreshExtraValue: randomShop?.manualRefreshExtraValue || 0,
    maxManualRefreshCount: 6,
    manualRefreshUsedCount: randomShop?.manualRefreshUsedCount || 0,
  };

  return {
    uid: NANGUA_ACTIVITY_UID,
    title: String(reply?.group?.activity?.title || '南瓜乐翻天'),
    randomActivityId: toNum(randomAct?.id),
    exchangeActivityId: toNum(exchangeAct?.id),
    randomShop: randomItems,
    randomShopRefresh: refreshInfo,
    exchangeShop: exchangeItems,
    summary: {
      randomShopCount: randomItems.length,
      exchangeShopCount: exchangeItems.length,
      activityCount: activities.length,
    },
    raw: {
      activityCount: activities.length,
      activityTitles: activities.map((a) => String(a?.title || '')).filter(Boolean),
      activityIds: activities.map((a) => toNum(a?.id)).filter((id) => id > 0),
    },
  };
}

/**
 * 获取南瓜商店
 */
async function getNanguaShop() {
  const state = getUserState();
  if (!state) {
    return {
      uid: NANGUA_ACTIVITY_UID,
      title: '南瓜乐翻天',
      randomShop: [],
      exchangeShop: [],
      summary: { randomShopCount: 0, exchangeShopCount: 0 },
      warning: 'runtime connection is not open',
    };
  }

  return normalizeNanguaGroup(await getActivityGroup(NANGUA_SHOP_ACTIVITY_ID));
}

// ---- 鹊桥寄情（七夕）活动 ----
const QIXI_ACTIVITY_UID = 'QiXiActivity';
const QIXI_ACTIVITY_ID = 2026081800;
const QIXI_BRIDGE_ACTIVITY_ID = 2026081801;
const QIXI_GIFT_ACTIVITY_ID = 2026081802;
const QIXI_BRIDGE_CMD = 25;
const QIXI_GIFT_OPEN_CMD = 7;
const QIXI_GIFT_SEND_CMD = 26;
const QIXI_FEATHER_ITEM_ID = 1024;
const QIXI_SACHET_ITEM_ID = 1025;
const QIXI_DEW_ITEM_ID = 301103;
const QIXI_DEW_DAILY_LIMIT = 15;

// ---- 雨落成诗活动 ----
const RAIN_POEM_ACTIVITY_UID = 'WeatherBottleUI';
const RAIN_POEM_ACTIVITY_ID = 2026070300;
const RAIN_POEM_SHOP_ACTIVITY_ID = 2026070301;
const RAIN_POEM_COLLECTION_ACTIVITY_ID = 2026070303;
const RAIN_POEM_COLLECTION_CMD = 9;
const RAIN_POEM_RESEARCH_ACTIVITY_ID = 2026070304;
const RAIN_POEM_RESEARCH_UNLOCK_CMD = 40;
const RAIN_POEM_BOTTLE_ITEM_ID = 5001;
const RAIN_POEM_SUMMON_ITEM_ID = 5002;
const RAIN_POEM_FROG_PRANK_ITEM_ID = 5005;
const RAIN_POEM_CLOUD_PRANK_ITEM_ID = 5006;
const RAIN_POEM_BADGE_ITEM_ID = 1027;
const RAIN_POEM_START_TIME = 1787709600;
const RAIN_POEM_END_TIME = 1788883199;
const LIGHTNING_MUTANT_TYPE = 12;
const RAIN_POEM_SUMMON_DAILY_LIMIT = 50;
const RAIN_POEM_ITEM_NAMES = new Map([
  [1027, '雷电徽章'], [5001, '天气采集瓶'], [5002, '雷雨召唤瓶'],
  [5005, '青蛙使坏瓶'], [5006, '乌云使坏瓶'],
  [80013, '有机化肥（8小时）'], [100003, '化肥礼包'],
  [4002, '闪电感应'], [4003, '闪电感应'], [2159, '雨落成诗头像框'],
]);

const qixiDewLimitDateByAccount = new Map();
// 记录鹊羽灵露对土地生效的状态（accountKey -> Object<landId, { at, plantId }>）。
// 协议层没有灵露字段（服务端不持久化），只能由 bot 本地记录；持久化到磁盘，重启/重登不丢失。
// 记录使用灵露时的 plantId：作物收获重种后 plantId 变化，视为效果失效自动清除。
const QIXI_DEW_STATE_FILE = getDataFile('qixi-dew-state.json');
const QIXI_DEW_EFFECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const qixiDewAppliedByAccount = new Map();

function loadQixiDewState() {
  try {
    const data = readJsonFile(QIXI_DEW_STATE_FILE, () => ({}));
    if (!data || typeof data !== 'object') return;
    for (const [key, lands] of Object.entries(data)) {
      if (!lands || typeof lands !== 'object') continue;
      const map = new Map();
      for (const [landId, raw] of Object.entries(lands)) {
        const record = raw && typeof raw === 'object'
          ? { at: Number(raw.at) || 0, plantId: Number(raw.plantId) || 0 }
          : { at: Number(raw) || 0, plantId: 0 }; // 兼容旧格式：纯时间戳
        if (record.at > 0 && Date.now() - record.at < QIXI_DEW_EFFECT_TTL_MS) {
          map.set(Number(landId), record);
        }
      }
      if (map.size > 0) qixiDewAppliedByAccount.set(key, map);
    }
  } catch { /* 忽略损坏状态文件 */ }
}

function saveQixiDewState() {
  try {
    const data = {};
    const now = Date.now();
    for (const [key, map] of qixiDewAppliedByAccount.entries()) {
      const lands = {};
      for (const [landId, record] of map.entries()) {
        if (now - record.at < QIXI_DEW_EFFECT_TTL_MS) {
          lands[String(landId)] = { at: record.at, plantId: record.plantId || 0 };
        }
      }
      if (Object.keys(lands).length > 0) data[key] = lands;
    }
    writeJsonFileAtomic(QIXI_DEW_STATE_FILE, data);
  } catch { /* 写盘失败忽略 */ }
}

loadQixiDewState();

function getQixiDewAppliedMap() {
  const key = getQixiDewLimitStateKey();
  let map = qixiDewAppliedByAccount.get(key);
  if (!map) {
    map = new Map();
    qixiDewAppliedByAccount.set(key, map);
  }
  return map;
}

function markQixiDewApplied(landId, plantId = 0) {
  const id = toNum(landId);
  const map = getQixiDewAppliedMap();
  const current = map.get(id);
  // 同一块地已对相同作物标记过则跳过；收获重种（plantId 变化）时更新为新作物。
  if (current && current.plantId && toNum(plantId) && current.plantId === toNum(plantId)) return;
  map.set(id, { at: Date.now(), plantId: toNum(plantId) || (current ? current.plantId : 0) });
  saveQixiDewState();
}

function clearQixiDewApplied(landId) {
  const id = toNum(landId);
  const map = getQixiDewAppliedMap();
  if (!map.has(id)) return;
  map.delete(id);
  saveQixiDewState();
}

/**
 * 判断土地是否仍处于灵露生效中。
 * @param {number} landId 土地 ID
 * @param {number} [plantId] 当前土地的作物 ID；提供且与记录不一致时视为已重种，返回 false
 */
function isQixiDewApplied(landId, plantId = 0) {
  const record = getQixiDewAppliedMap().get(toNum(landId));
  if (!record) return false;
  if (Date.now() - record.at >= QIXI_DEW_EFFECT_TTL_MS) return false;
  // 记录过作物且当前作物不同（收获重种）→ 效果已失效。
  if (record.plantId && toNum(plantId) && record.plantId !== toNum(plantId)) return false;
  return true;
}

function getQixiDewLimitStateKey() {
  const state = getUserState();
  return String(state?.gid || state?.openid || 'current');
}

function isQixiDewLimitReachedToday() {
  return qixiDewLimitDateByAccount.get(getQixiDewLimitStateKey()) === getLocalDateKey();
}

function markQixiDewLimitReachedToday() {
  qixiDewLimitDateByAccount.set(getQixiDewLimitStateKey(), getLocalDateKey());
}

function isQixiDewDailyLimitError(err) {
  const message = String(err?.message || '');
  // 注意：code=1000020 是"请求参数错误"（warehouse.js 回退逻辑已证实），
  // 不是每日上限！误把 1000020 当上限会导致活动页错误显示 15/15。
  // 真正的每日上限错误码待抓包确认（此前用 1003008 与文案识别）。
  return Number(err?.code) === 1003008
    || message.includes('1003008')
    || message.includes('item use daily limit')
    || message.includes('今日使用次数已达上限');
}

function isQixiDewDuplicateError(err) {
  // 真实灵露协议（field1 带 UID + field2 gid/土地）在土地已生效过灵露时会报
  // code=1001065 "不能重复触发效果"。应把该地标记为已用并跳过，而不是中断整轮。
  const message = String(err?.message || '');
  return Number(err?.code) === 1001065
    || message.includes('1001065')
    || message.includes('不能重复触发效果')
    || message.includes('重复触发');
}

function isQixiGoldPlant(plantId) {
  // QQ 农场官方公告：只有黄金作物能获得两倍效果。
  // 黄金变异作物 ID 段为 1120000-1129999，名称以「黄金·」开头。
  const id = toNum(plantId);
  return id >= 1120000 && id < 1130000;
}

function normalizeQixiItem(item, fallbackId = 0, fallbackName = '') {
  const normalized = normalizeCoreItem(item || { id: fallbackId, count: 0 });
  if (fallbackName && (!normalized.itemName || normalized.itemName.startsWith('物品#'))) {
    normalized.itemName = fallbackName;
  }
  return normalized;
}

function findActivityNodeById(nodes, id) {
  for (const node of nodes || []) {
    if (toNum(node?.activity?.id) === id) return node;
    const found = findActivityNodeById(node?.children, id);
    if (found) return found;
  }
  return null;
}

function normalizeQixiActivity(reply) {
  const root = reply?.group || null;
  const bridgeNode = findActivityNodeById([root], QIXI_BRIDGE_ACTIVITY_ID);
  const giftNode = findActivityNodeById([root], QIXI_GIFT_ACTIVITY_ID);
  const bridge = bridgeNode?.qixi_bridge || bridgeNode?.qixiBridge || {};
  const gift = giftNode?.qixi_gift || giftNode?.qixiGift || {};
  const balances = (bridge?.balances || []).map(item => normalizeQixiItem(item));
  const balanceById = new Map(balances.map(item => [item.itemId, item.itemCount]));
  const stages = (bridge?.stages || []).map(stage => ({
    id: toNum(stage?.id),
    status: toNum(stage?.status),
    claimed: toNum(stage?.status) >= 2,
    cost: normalizeQixiItem(stage?.cost, QIXI_FEATHER_ITEM_ID, '鹊羽'),
    rewards: (stage?.rewards || []).map(item => normalizeQixiItem(item)),
  }));
  const nextStage = stages.find(stage => !stage.claimed) || null;
  const giftRule = gift?.rule || {};
  return {
    uid: QIXI_ACTIVITY_UID,
    title: String(root?.activity?.title || bridgeNode?.activity?.title || '鹊桥寄情'),
    activityId: QIXI_ACTIVITY_ID,
    startTime: toNum(root?.activity?.start_time || bridgeNode?.activity?.start_time),
    endTime: toNum(root?.activity?.end_time || bridgeNode?.activity?.end_time),
    active: !!bridgeNode?.activity?.visible && bridgeNode?.activity?.enabled !== false,
    items: {
      feather: normalizeQixiItem({ id: QIXI_FEATHER_ITEM_ID, count: balanceById.get(QIXI_FEATHER_ITEM_ID) || 0 }, QIXI_FEATHER_ITEM_ID, '鹊羽'),
      sachet: normalizeQixiItem({ id: QIXI_SACHET_ITEM_ID, count: balanceById.get(QIXI_SACHET_ITEM_ID) || 0 }, QIXI_SACHET_ITEM_ID, '鹊羽香囊'),
      dew: normalizeQixiItem({ id: QIXI_DEW_ITEM_ID, count: balanceById.get(QIXI_DEW_ITEM_ID) || 0 }, QIXI_DEW_ITEM_ID, '鹊羽灵露'),
    },
    bridge: {
      activityId: QIXI_BRIDGE_ACTIVITY_ID,
      command: QIXI_BRIDGE_CMD,
      stages,
      completedCount: stages.filter(stage => stage.claimed).length,
      lastBuiltStageId: toNum(bridge?.last_built_stage_id),
      nextStage,
      canBuild: !!nextStage && nextStage.cost.itemCount > 0
        && (balanceById.get(nextStage.cost.itemId) || 0) >= nextStage.cost.itemCount,
    },
    gift: {
      activityId: QIXI_GIFT_ACTIVITY_ID,
      command: QIXI_GIFT_SEND_CMD,
      sentCount: toNum(gift?.sent_count),
      receivedCount: toNum(gift?.received_count),
      maxCount: toNum(gift?.max_count),
      remainingCount: Math.max(0, toNum(gift?.max_count) - toNum(gift?.sent_count)),
      cost: normalizeQixiItem(giftRule?.cost, QIXI_SACHET_ITEM_ID, '鹊羽香囊'),
      reward: normalizeQixiItem(giftRule?.reward, 0, '获赠香囊'),
      enabled: giftRule?.enabled !== false,
    },
  };
}

async function getQixiActivity() {
  try {
    const reply = await getActivityGroup(QIXI_ACTIVITY_ID, QIXI_ACTIVITY_UID);
    const activity = normalizeQixiActivity(reply);
    const counts = await Promise.all([
      getBagItemCount(QIXI_FEATHER_ITEM_ID),
      getBagItemCount(QIXI_SACHET_ITEM_ID),
      getBagItemCount(QIXI_DEW_ITEM_ID),
    ]);
    // 活动节点中的 balances 会保留阶段奖励/配置值，真实可用库存以背包为准。
    activity.items.feather.itemCount = counts[0];
    activity.items.sachet.itemCount = counts[1];
    activity.items.dew.itemCount = counts[2];
    activity.dewUsage = {
      dailyLimit: QIXI_DEW_DAILY_LIMIT,
      limitReached: isQixiDewLimitReachedToday(),
    };
    if (activity.bridge.nextStage) {
      activity.bridge.canBuild = activity.bridge.nextStage.cost.itemCount > 0
        && activity.items.feather.itemCount >= activity.bridge.nextStage.cost.itemCount;
    }
    return activity;
  } catch (error) {
    // 鹊桥活动已于 2026-08-22 结束，服务端不再下发活动节点 → 此分支属「预期内」的常态路径，
    // 不应按 error 级别刷屏。降级为 debug，并保留原始信息便于排查真实异常。
    activityLogger.debug('鹊桥寄情活动节点未下发（活动已结束，属预期）:', error?.message || error);
    // 活动节点已下架/接口异常：返回带 active:false 的缺省对象，
    // 让前端识别「活动已结束」隐藏操作入口，worker 也据此拦截灵露/驻桥/香囊自动化。
    return {
      uid: QIXI_ACTIVITY_UID,
      title: '鹊桥寄情',
      activityId: QIXI_ACTIVITY_ID,
      startTime: 0,
      endTime: 0,
      active: false,
      items: {
        feather: { itemId: QIXI_FEATHER_ITEM_ID, itemName: '鹊羽', itemCount: 0 },
        sachet: { itemId: QIXI_SACHET_ITEM_ID, itemName: '鹊羽香囊', itemCount: 0 },
        dew: { itemId: QIXI_DEW_ITEM_ID, itemName: '鹊羽灵露', itemCount: 0 },
      },
      dewUsage: { dailyLimit: QIXI_DEW_DAILY_LIMIT, limitReached: true },
      bridge: { stages: [], completedCount: 0, canBuild: false, nextStage: null },
      gift: { remainingCount: 0, sentCount: 0, maxCount: 0 },
      ended: true,
    };
  }
}

async function useQixiDew(options = {}) {
  const activity = await getQixiActivity();
  if (activity.dewUsage.limitReached) {
    return { ok: true, usedCount: 0, reason: 'daily_limit', activity };
  }
  const available = activity.items.dew.itemCount;
  if (available <= 0) return { ok: true, usedCount: 0, reason: 'no_dew', activity };
  const { getLandsDetail } = require('./farm-land-analyzer');
  const lands = (await getLandsDetail())?.lands || [];
  const candidates = lands
    .filter(land => land?.plantId && ['growing', 'harvestable'].includes(land.status))
    // 已应用过灵露的土地（本地持久化记录）不再重复触发，避免黄金地反复被选后 1001065 中断整轮。
    // 必须带 plantId：收获重种后作物 ID 变化，isQixiDewApplied 判定效果已失效，才能再次使用灵露。
    .filter(land => !isQixiDewApplied(land.id, toNum(land.plantId) || toNum(land.displayPlantId) || 0))
    // 官方公告：只有黄金作物能获得两倍效果，优先对黄金作物使用灵露。
    .map(land => ({ land, isGold: isQixiGoldPlant(land.plantId) || isQixiGoldPlant(land.displayPlantId) }))
    .sort((a, b) => Number(b.isGold) - Number(a.isGold));
  const limit = Math.min(available, Math.max(1, toNum(options.limit) || available), candidates.length);
  if (limit <= 0) return { ok: true, usedCount: 0, reason: 'no_eligible_land', activity };
  let usedCount = 0;
  let goldUsedCount = 0;
  let dailyLimitReached = false;
  for (const { land, isGold } of candidates.slice(0, limit)) {
    const plantId = toNum(land.plantId) || toNum(land.displayPlantId) || 0;
    try {
      await useQixiDewOnLand(land.id);
      markQixiDewApplied(land.id, plantId);
      usedCount++;
      if (isGold) goldUsedCount++;
    } catch (err) {
      if (isQixiDewDailyLimitError(err)) {
        markQixiDewLimitReachedToday();
        dailyLimitReached = true;
        activityLogger.info('鹊羽灵露今日使用次数已达上限', {
          itemId: QIXI_DEW_ITEM_ID,
          dailyLimit: QIXI_DEW_DAILY_LIMIT,
        });
        break;
      }
      if (isQixiDewDuplicateError(err)) {
        // 该地已在服务端生效过灵露：本地补齐标记后跳过，继续下一块地。
        markQixiDewApplied(land.id, plantId);
        activityLogger.info('鹊羽灵露已在土地生效，跳过', { landId: land.id });
        continue;
      }
      activityLogger.warn('鹊羽灵露使用失败', { landId: land.id, error: err.message });
      break;
    }
    if (usedCount < limit) await delay(450);
  }
  return {
    ok: true,
    usedCount,
    goldUsedCount,
    reason: dailyLimitReached ? 'daily_limit' : undefined,
    activity: await getQixiActivity(),
  };
}

async function useQixiDewOnLand(landId, targetGid = null) {
  // 官方 ItemService.Use 的真实结构（上游抓包确认）：
  //   field 1 = Item { item_id(1), count(2), uid(6) } —— 必须携带背包 UID
  //   field 2 = { gid(1), land_ids(2) } —— 目标账号 GID 与目标土地
  //   targetGid 缺省时对自己使用；传入好友 GID 即"对好友使用灵露"（field2.gid 填好友 GID）。
  // proto 里 UseRequest{item_id,count,land_ids} 的扁平定义与服务器不匹配，
  // warehouse.useItem 的 field1={item_id,count} 回退对灵露也会报 1000020。
  const bag = await getBag();
  const dew = (getBagItems(bag) || []).find(item =>
    toNum(item?.id) === QIXI_DEW_ITEM_ID && toNum(item?.count) > 0
  );
  if (!dew) throw new Error('鹊羽灵露不足');
  const gid = targetGid ? toNum(targetGid) : toNum(getUserState()?.gid);
  if (!gid) throw new Error('尚未获取目标账号 GID');

  const writer = protobuf.Writer.create();
  writer.uint32(10).fork()
    .uint32(8).int64(QIXI_DEW_ITEM_ID)
    .uint32(16).int64(1)
    .uint32(48).int64(toLong(toNum(dew.uid)))
    .ldelim();
  writer.uint32(18).fork()
    .uint32(8).int64(gid)
    .uint32(18).fork().int64(toLong(toNum(landId))).ldelim()
    .ldelim();
  const { body } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', writer.finish());
  return types.UseReply.decode(body);
}

/**
 * 对好友使用鹊羽灵露（field2.gid 填好友 GID，目标土地为好友已种植地块）。
 * 调用方（friend-visit）须自行把关：仅当"自用 15 次达到上限后"才启用（设置 qixi_dew_use_on_friend）。
 * @returns {{ok:boolean, usedCount:number, errors:Array<{landId:number, reason:string}>}}
 */
async function useQixiDewOnFriend(friendGid, landIds = []) {
  const gid = toNum(friendGid);
  if (!gid) throw new Error('无效好友 GID');
  const targets = [...new Set((Array.isArray(landIds) ? landIds : []).map(id => toNum(id)).filter(id => id > 0))];
  if (targets.length === 0) return { ok: true, usedCount: 0, errors: [] };
  const errors = [];
  let usedCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const landId = targets[i];
    try {
      await useQixiDewOnLand(landId, gid);
      usedCount++;
    } catch (err) {
      if (isQixiDewDailyLimitError(err)) {
        errors.push({ landId, reason: 'daily_limit' });
        break; // 达到每日上限即停，不再尝试后续土地
      }
      if (isQixiDewDuplicateError(err)) {
        errors.push({ landId, reason: 'duplicate' });
        continue;
      }
      errors.push({ landId, reason: err.message || 'unknown' });
    }
    if (i + 1 < targets.length) await delay(350);
  }
  return { ok: usedCount > 0, usedCount, errors };
}

async function buildQixiBridge(options = {}) {
  const before = await getQixiActivity();
  if (!before.bridge.nextStage) return { ok: true, completed: true, built: false, activity: before };
  if (!before.bridge.canBuild && !options.force) throw new Error('鹊羽不足，暂时无法驻建鹊桥');
  await operateActivityReply(QIXI_BRIDGE_ACTIVITY_ID, QIXI_BRIDGE_CMD);
  return { ok: true, built: true, stageId: before.bridge.nextStage.id, activity: await getQixiActivity() };
}

async function sendQixiSachet(friendGid, count = 1) {
  const gid = toNum(friendGid);
  const sendCount = Math.max(1, Math.floor(toNum(count) || 1));
  if (!gid) throw new Error('请选择有效好友');
  const before = await getQixiActivity();
  if (!before.gift.enabled || before.gift.remainingCount <= 0) throw new Error('今日香囊赠送次数已用完');
  const actual = Math.min(sendCount, before.gift.remainingCount, before.items.sachet.itemCount || sendCount);
  if (actual <= 0) throw new Error('鹊羽香囊不足');
  for (let i = 0; i < actual; i++) {
    // 官方界面没有款式选项，抓包中该内部编号由客户端在 1-13 间自动选择。
    const giftId = 1 + Math.floor(Math.random() * 13);
    await operateActivityReply(QIXI_GIFT_ACTIVITY_ID, QIXI_GIFT_SEND_CMD, {
      qixiGift: { friendGid: gid, giftId },
    });
    if (i + 1 < actual) await delay(450);
  }
  return { ok: true, friendGid: gid, sentCount: actual, activity: await getQixiActivity() };
}

// ============================================================
// 鹊桥活动结束态缓存
// 活动一旦结束（endTime 已过或 active === false），无需每轮巡查重复请求/打日志。
// 已结束判定缓存较长时间（6h，仍保留返厂探活）；未结束判定缓存较短（15min，确保中途下架/结束能被及时感知）。
// ============================================================
let qixiEndedCache = null; // { date: 'YYYY-MM-DD', ended: boolean, activity: object|null }
let qixiEndedCacheAt = 0;

async function getQixiEndedState() {
    const now = Date.now();
    const ttl = qixiEndedCache && qixiEndedCache.ended ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000;
    if (qixiEndedCache && (now - qixiEndedCacheAt) < ttl) {
        return qixiEndedCache;
    }
    let activity = null;
    let ended = false;
    try {
        activity = await getQixiActivity();
        const nowSec = Math.floor(now / 1000);
        ended = !!activity && ((activity.endTime > 0 && activity.endTime < nowSec) || activity.active === false);
    } catch {
        // 探活异常（网络抖动）保守视为「未结束」，交由调用方原有逻辑处理
        ended = false;
    }
    // 兜底：getActivityGroup 抛错/返回空（活动节点已下架）时，用活动发现列表判断鹊桥活动是否还在列表中且仍有效。
    // 列表里找不到鹊桥节点 = 活动已下架；节点仍在但 endTime 已过 / enabled=false / visible=false = 活动已结束。
    // 两种情况都视为已结束（worker 停止灵露自动化、今日统计隐藏友灵露等）。
    if (!activity && !ended) {
        try {
            const list = await getActivityDiscoveryList();
            const nodes = (list || []).filter(a =>
                toNum(a.id) === QIXI_BRIDGE_ACTIVITY_ID
                || toNum(a.id) === QIXI_ACTIVITY_ID
                || toNum(a.parentId) === QIXI_ACTIVITY_ID
            );
            if (nodes.length === 0) {
                ended = true;
            } else {
                // 任一鹊桥相关节点仍有效（endTime 未过 且 enabled 且 visible）则视为未结束；
                // 全部无效则视为已结束。
                const nowSec = Math.floor(now / 1000);
                const anyActive = nodes.some(a => {
                    const end = toNum(a.endTime);
                    const endSec = end > 1e12 ? Math.floor(end / 1000) : end;
                    const timeOk = end <= 0 || endSec > nowSec;
                    return timeOk && a.enabled !== false && a.visible !== false;
                });
                if (!anyActive) ended = true;
            }
        } catch { /* 列表也失败则保持原判定 */ }
    }
    qixiEndedCache = { date: getLocalDateKey(), ended, activity };
    qixiEndedCacheAt = now;
    return qixiEndedCache;
}

// 同步取缓存（不阻塞）：返回当前缓存值（可能为 null），并后台异步刷新（TTL 过期时）。
function getQixiEndedStateCached() {
    if (!qixiEndedCache) {
        getQixiEndedState().catch(() => {});
        return null;
    }
    const ttl = qixiEndedCache.ended ? 6 * 60 * 60 * 1000 : 15 * 60 * 1000;
    if (Date.now() - qixiEndedCacheAt >= ttl) {
        getQixiEndedState().catch(() => {});
    }
    return qixiEndedCache;
}

// ============================================================
// 雨落成诗活动
// ============================================================
function getRainPoemSummonUsageFile() {
    const state = getUserState();
    const accountKey = String(state?.gid || 'current').replace(/[^\w-]/gi, '_');
    return path.join(getDataDir(), 'rain_poem_summon_usage', `${accountKey}.json`);
}

function getRainPoemSummonUsedToday() {
    const usage = readJsonFile(getRainPoemSummonUsageFile(), () => ({}));
    return usage?.date === getLocalDateKey() ? Math.max(0, toNum(usage.count)) : 0;
}

function incrementRainPoemSummonUsedToday() {
    const count = Math.min(RAIN_POEM_SUMMON_DAILY_LIMIT, getRainPoemSummonUsedToday() + 1);
    writeJsonFileAtomic(getRainPoemSummonUsageFile(), { date: getLocalDateKey(), count });
    return count;
}

function mergeRainPoemTaskUsage(activity, summonUsedToday) {
    const collectionLimit = Math.max(0, toNum(activity?.collection?.dailyUseLimit));
    const collectionRemaining = Math.min(collectionLimit, Math.max(0, toNum(activity?.collection?.remainingUseCount)));
    const collectionTask = activity.tasks.find(item => toNum(item?.itemId) === RAIN_POEM_BOTTLE_ITEM_ID);
    if (collectionTask) {
        collectionTask.progress = collectionLimit - collectionRemaining;
        collectionTask.target = collectionLimit;
    }

    const count = Math.min(RAIN_POEM_SUMMON_DAILY_LIMIT, Math.max(0, toNum(summonUsedToday)));
    activity.summon.usedToday = count;
    const task = activity.tasks.find(item => toNum(item?.itemId) === RAIN_POEM_SUMMON_ITEM_ID);
    if (task) {
        task.progress = Math.max(toNum(task.progress), count);
        task.target = RAIN_POEM_SUMMON_DAILY_LIMIT;
    }
    return activity;
}

function normalizeRainPoemActivity(reply, nowSeconds = Math.floor(Date.now() / 1000)) {
    const root = reply?.group || null;
    const shopNode = findActivityNodeById([root], 2026070301);
    const drawNode = findActivityNodeById([root], 2026070303);
    const researchNode = findActivityNodeById([root], 2026070304);
    const taskNode = findActivityNodeById([root], 2026070305);
    const startTime = toNum(root?.activity?.start_time) || RAIN_POEM_START_TIME;
    const endTime = toNum(root?.activity?.end_time) || RAIN_POEM_END_TIME;
    // type=3 天气商店的数据位于 ActivityInfo 内；部分旧响应则直接挂在 ActivityNode。
    const shopInfo = shopNode?.exchange_shop || shopNode?.activity?.exchange_shop || {};
    const shopItem = (shopInfo?.items || [])[0] || {};
    const draw = drawNode?.draw_info || drawNode?.activity?.draw_info || {};
    const research = (researchNode?.weather_research || researchNode?.activity?.weather_research)?.progress || {};
    const weatherTasks = taskNode?.weather_tasks || taskNode?.activity?.weather_tasks || {};
    const tasks = (weatherTasks?.tasks || []).map(task => ({
        id: toNum(task?.id), itemId: toNum(task?.item_id), desc: String(task?.desc || ''),
        target: toNum(task?.target), progress: toNum(task?.progress),
        reward: normalizeRainPoemItem(task?.reward, RAIN_POEM_BADGE_ITEM_ID),
    }));
    const lightningHarvestTask = tasks.find(task => /雷电|闪电/.test(task.desc) && /变异/.test(task.desc) && /收集|收获/.test(task.desc));
    const lightningHarvestTarget = Math.max(0, toNum(lightningHarvestTask?.target));
    const lightningHarvestProgress = Math.max(0, toNum(lightningHarvestTask?.progress));
    return {
        uid: RAIN_POEM_ACTIVITY_UID,
        title: String(root?.activity?.title || '雨落成诗'),
        activityId: RAIN_POEM_ACTIVITY_ID,
        startTime,
        endTime,
        active: nowSeconds >= startTime && nowSeconds <= endTime && root?.activity?.visible !== false,
        shop: {
            activityId: RAIN_POEM_SHOP_ACTIVITY_ID,
            slotId: toNum(shopItem?.id) || 200,
            item: normalizeRainPoemItem(shopItem?.item, RAIN_POEM_BOTTLE_ITEM_ID),
            cost: normalizeQixiItem(shopItem?.cost, 1005, '金豆豆'),
            purchasedToday: !!shopItem?.owned,
            available: toNum(shopItem?.status) === 1 && !shopItem?.owned,
            dailyLimit: 1,
        },
        collection: {
            remainingUseCount: toNum(draw?.paid_remaining_count),
            dailyUseLimit: toNum(draw?.max_paid_count) || 10,
            bottleItemId: toNum(draw?.paid_currency_id) || RAIN_POEM_BOTTLE_ITEM_ID,
            bottleCost: toNum(draw?.paid_price) || 1,
            reward: normalizeRainPoemItem(draw?.rewards?.[0]?.item, RAIN_POEM_SUMMON_ITEM_ID),
        },
        summon: {
            itemId: RAIN_POEM_SUMMON_ITEM_ID,
            dailyUseLimit: RAIN_POEM_SUMMON_DAILY_LIMIT,
            durationSeconds: 2 * 60 * 60,
        },
        tasks,
        lightningHarvest: {
            progress: lightningHarvestProgress,
            target: lightningHarvestTarget,
            remaining: Math.max(0, lightningHarvestTarget - lightningHarvestProgress),
            complete: lightningHarvestTarget > 0 && lightningHarvestProgress >= lightningHarvestTarget,
            confirmed: !!lightningHarvestTask,
        },
        research: {
            currentStage: toNum(research?.current_stage),
            stages: (research?.stages || []).map(stage => ({
                id: toNum(stage?.id), status: toNum(stage?.status),
                available: toNum(stage?.status) === 2,
                completed: toNum(stage?.status) === 4,
                claimed: toNum(stage?.status) === 4,
                cost: normalizeRainPoemItem(stage?.cost, RAIN_POEM_BADGE_ITEM_ID), reward: normalizeRainPoemItem(stage?.reward),
                repeatable: !!stage?.repeatable, limit: toNum(stage?.limit),
            })),
        },
    };
}

function normalizeRainPoemItem(item, fallbackId = 0) {
    const itemId = toNum(item?.id) || fallbackId;
    return normalizeQixiItem(item, itemId, RAIN_POEM_ITEM_NAMES.get(itemId) || '未知物品');
}

function normalizeWeatherStatus(weather, nowSeconds = Math.floor(Date.now() / 1000)) {
    // 字段 1 是雷雨阶段而非天气 ID。兼容修复前按 weather_id 解码的对象，
    // 避免测试夹具或运行中的旧对象在热更新期间被误判。
    const type = toNum(weather?.type ?? weather?.weather_id);
    const status = toNum(weather?.status);
    const startTime = toNum(weather?.start_time);
    const endTime = toNum(weather?.end_time);
    return {
        type, status, startTime, endTime,
        // type=1（30 分钟）和 type=2（2 小时）是同一次雷雨的两个有效阶段。
        rainstorm: (type === 1 || type === 2) && status > 0
            && (!startTime || nowSeconds >= startTime) && (!endTime || nowSeconds <= endTime),
    };
}

function isLightningMutantPlant(plant) {
    if (!plant) return false;
    // 1) Plant 顶层的便捷列表 mutant_config_ids（field 20）
    if ((plant.mutant_config_ids || []).map(toNum).includes(toNum(LIGHTNING_MUTANT_TYPE))) return true;
    // 2) 兼容：变异明细放在各生长阶段 phases[].mutants 里（PlantPhaseInfo.mutants，field 10），
    //    每条 MutantInfo.mutant_config_id === 12 即闪电变异。游戏服务器通常只填这里。
    if (Array.isArray(plant.phases)) {
        for (const ph of plant.phases) {
            const ms = ph && ph.mutants;
            if (Array.isArray(ms) && ms.some(m => toNum(m && m.mutant_config_id) === toNum(LIGHTNING_MUTANT_TYPE))) return true;
        }
    }
    return false;
}

async function getOwnWeatherStatus() {
    const request = types.GetWeatherStatusRequest.encode(types.GetWeatherStatusRequest.create({})).finish();
    const { body } = await sendMsgAsync('gamepb.weatherpb.WeatherService', 'GetWeatherStatus', request);
    return normalizeWeatherStatus(types.GetWeatherStatusReply.decode(body)?.weather);
}

async function getRainPoemActivity() {
    const activity = normalizeRainPoemActivity(await getActivityGroup(RAIN_POEM_ACTIVITY_ID, RAIN_POEM_ACTIVITY_UID));
    const [collectionBottles, summonBottles, frogPrankBottles, cloudPrankBottles, badges] = await Promise.all([
        getBagItemCount(RAIN_POEM_BOTTLE_ITEM_ID), getBagItemCount(RAIN_POEM_SUMMON_ITEM_ID),
        getBagItemCount(RAIN_POEM_FROG_PRANK_ITEM_ID), getBagItemCount(RAIN_POEM_CLOUD_PRANK_ITEM_ID),
        getBagItemCount(RAIN_POEM_BADGE_ITEM_ID),
    ]);
    activity.items = { collectionBottles, summonBottles, frogPrankBottles, cloudPrankBottles, badges };
    mergeRainPoemTaskUsage(activity, getRainPoemSummonUsedToday());
    try {
        activity.weather = await getOwnWeatherStatus();
    } catch (err) {
        activity.weather = { type: 0, status: 0, rainstorm: false, error: err.message };
    }
    return activity;
}

async function buyRainPoemCollectionBottle() {
    const before = await getRainPoemActivity();
    if (!before.active) throw new Error('雨落成诗活动当前不在有效期内');
    if (before.shop.purchasedToday || !before.shop.available) {
        return { ok: true, purchased: false, reason: 'daily_limit', activity: before };
    }
    await operateActivityReply(RAIN_POEM_SHOP_ACTIVITY_ID, 1, {
        exchangeShopOperate: { id: 200, count: 1 },
    });
    return { ok: true, purchased: true, count: 1, activity: await getRainPoemActivity() };
}

function encodeRainPoemSummonUseRequest(gid, itemUid) {
    const writer = protobuf.Writer.create();
    writer.uint32(10).fork().uint32(8).int64(RAIN_POEM_SUMMON_ITEM_ID)
        .uint32(16).int64(1).uint32(48).int64(toNum(itemUid)).ldelim();
    writer.uint32(18).fork().uint32(8).int64(toNum(gid)).uint32(24).int64(0).ldelim();
    return writer.finish();
}


async function useRainPoemSummonBottle() {
    const before = await getRainPoemActivity();
    if (!before.active) throw new Error('雨落成诗活动当前不在有效期内');
    if (before.weather?.rainstorm) return { ok: true, used: false, reason: 'already_rainstorm', activity: before };
    if (before.summon.usedToday >= RAIN_POEM_SUMMON_DAILY_LIMIT) {
        return { ok: true, used: false, reason: 'daily_limit', activity: before };
    }
    if (before.items.summonBottles < 1) throw new Error('雷雨召唤瓶不足');
    const bag = await getBag();
    const bottle = getBagItems(bag).find(item => toNum(item?.id) === RAIN_POEM_SUMMON_ITEM_ID && toNum(item?.count) > 0);
    if (!bottle) throw new Error('雷雨召唤瓶不足');
    const gid = toNum(getUserState()?.gid);
    if (!gid) throw new Error('尚未获取当前账号 GID');
    await sendMsgAsync('gamepb.itempb.ItemService', 'Use', encodeRainPoemSummonUseRequest(gid, bottle.uid));
    incrementRainPoemSummonUsedToday();
    return { ok: true, used: true, activity: await getRainPoemActivity() };
}

async function collectRainPoemWeather() {
    const before = await getRainPoemActivity();
    if (!before.active) throw new Error('雨落成诗活动当前不在有效期内');
    if (before.items.collectionBottles < 1) throw new Error('天气采集瓶不足');
    if (before.collection.remainingUseCount <= 0) throw new Error('天气采集瓶今日使用次数已达上限');

    const { enterFriendFarm, leaveFriendFarm } = require('./friend-api');
    const { getFriendsList } = require('./friend-land-analyzer');
    const friends = await getFriendsList();
    let checkedCount = 0;
    let visitFailureCount = 0;

    for (const friend of friends) {
        const gid = toNum(friend?.gid);
        if (!gid) continue;
        let entered = false;
        try {
            const visit = await enterFriendFarm(gid);
            entered = true;
            checkedCount++;
            const weather = normalizeWeatherStatus(visit?.weather);
            if (!weather.rainstorm) continue;
            await operateActivityReply(RAIN_POEM_COLLECTION_ACTIVITY_ID, RAIN_POEM_COLLECTION_CMD, {
                // 抓包确认 field 107.3 承载目标好友 GID；沿用现有消息字段名 item_uid。
                helu_paid_draw: { item_uid: gid },
            });
            return {
                ok: true, friendGid: gid, friendName: String(friend?.name || ''), weather,
                checkedCount, visitFailureCount, activity: await getRainPoemActivity(),
            };
        } catch (err) {
            if (entered) throw err;
            visitFailureCount++;
            activityLogger.warn('检查好友雷雨天气失败，继续下一位', { friendGid: gid, error: err.message });
        } finally {
            if (entered) await leaveFriendFarm(gid);
        }
    }
    return { ok: true, collected: false, reason: 'no_rainstorm_friend', checkedCount, visitFailureCount, activity: await getRainPoemActivity() };
}

/**
 * 解锁气象研究节点
 *
 * 研究节点是分支结构（同一层可有多个节点同时可解锁），玩家可以自行决定先解锁哪个。
 * @param {number} [nodeId] 指定要解锁的节点 id；不传则自动取第一个可解锁节点（自动任务使用）
 */
async function unlockRainPoemResearch(nodeId) {
    const before = await getRainPoemActivity();
    if (!before.active) throw new Error('雨落成诗活动当前不在有效期内');
    const targetId = toNum(nodeId);
    const stage = targetId > 0
        ? before.research.stages.find(item => toNum(item.id) === targetId)
        : before.research.stages.find(item => item.available);
    if (!stage) {
        return { ok: true, unlocked: false, reason: targetId > 0 ? 'stage_not_found' : 'no_available_stage', activity: before };
    }
    // 手动指定节点时必须处于可解锁状态（分支节点需先解锁其前置节点）
    if (targetId > 0 && !stage.available) {
        throw new Error(`节点 ${targetId} 当前不可解锁，需先解锁其前置节点`);
    }
    if (before.items.badges < stage.cost.itemCount) {
        throw new Error(`雷电徽章不足，需要 ${stage.cost.itemCount}，当前 ${before.items.badges}`);
    }
    try {
        await operateActivityReply(RAIN_POEM_RESEARCH_ACTIVITY_ID, RAIN_POEM_RESEARCH_UNLOCK_CMD, {
            techTreeSubmitNode: { nodeId: stage.id },
        });
    } catch (err) {
        // 并发任务可能已经推进该节点，刷新后将该错误视为状态竞争。
        if (!String(err?.message || '').includes('code=1034101')) throw err;
        const refreshed = await getRainPoemActivity();
        const stillAvailable = (refreshed?.research?.stages || []).some(item => item.available);
        if (stillAvailable) throw err;
        return { ok: true, unlocked: false, reason: 'state_already_advanced', activity: refreshed };
    }
    return {
        ok: true, unlocked: true, stageId: stage.id, cost: stage.cost, reward: stage.reward,
        activity: await getRainPoemActivity(),
    };
}

// ==================== 萌宠成长日记（S3 比熊赛季）====================
// 上游 activity-center/pet-diary.ts 的本地装配（见 activity-pet-diary.js）。
// 命令字与响应选择器来自官方小程序 1.14.0.1 编码器，不按响应长度推断。
const petDiaryHelpers = require('./activity-center-helpers');
const { createPetDiaryService } = require('./activity-pet-diary');

let petDiaryServiceInstance = null;

function getPetDiaryService() {
  if (petDiaryServiceInstance) return petDiaryServiceInstance;
  const { getServerTimeSec } = require('../utils/utils');
  petDiaryServiceInstance = createPetDiaryService({
    types,
    sendMsgAsync,
    getBag,
    getBagItems,
    getServerTimeSec,
    itemDto: petDiaryHelpers.itemDto,
    int64String: petDiaryHelpers.int64String,
    int64Number: petDiaryHelpers.int64Number,
    textContent: petDiaryHelpers.textContent,
    businessError: petDiaryHelpers.businessError,
    positiveDecimal: petDiaryHelpers.positiveDecimal,
    serializeMutation: petDiaryHelpers.serializeMutation,
    // 本地节令模型字段为 claimable / 数字 id，适配成上游期望的 canClaim / 字符串 id
    getCurrentSolarTerms: async () => {
      const info = await getSolarTermsInfo();
      return {
        ...info,
        terms: (Array.isArray(info?.terms) ? info.terms : []).map(term => ({
          ...term,
          id: String(term.id),
          canClaim: term.claimable === true,
          // 上游页面按 name / statusCode 取值，本地模型是 title / status，补别名避免改页面。
          // statusCode 必须是字符串：页面里是 term.statusCode === '1' / '3' 的严格比较。
          name: String(term.title || ''),
          statusCode: String(term.status),
        })),
      };
    },
    claimSolarTerm: async (termId) => claimSolarTermsReward(Number(termId)),
  });
  return petDiaryServiceInstance;
}

const getPetDiary = () => getPetDiaryService().getPetDiary();
const operatePetDiary = (action, params, options) => getPetDiaryService().operatePetDiary(action, params, options);
const getPetDiaryRecords = (kind) => getPetDiaryService().getPetDiaryRecords(kind);
const getPetDiaryFriend = (gid) => getPetDiaryService().getPetDiaryFriend(gid);

// ---- 秋祈良愿（祈愿签到） + 快乐不独享（分享）活动 ----
// 移植自上游 2026-09-24。二者均走通用 ActivityGroup 协议，无新增 proto 依赖。

function isWishSignActive(nowSeconds = Math.floor(Date.now() / 1000)) {
  return nowSeconds >= WISH_SIGN_START_TIME && nowSeconds <= WISH_SIGN_END_TIME;
}

function isShareRewardActive(nowSeconds = Math.floor(Date.now() / 1000)) {
  return nowSeconds >= SHARE_REWARD_START_TIME && nowSeconds <= SHARE_REWARD_END_TIME;
}

function normalizeWishSignActivity(node, nowSeconds = Math.floor(Date.now() / 1000)) {
  const body = node?.wish_sign || {};
  const pending = body.pending;
  return {
    title: '秋祈良愿', activityId: WISH_SIGN_ACTIVITY_ID,
    startTime: WISH_SIGN_START_TIME, endTime: WISH_SIGN_END_TIME,
    active: isWishSignActive(nowSeconds),
    remainingCount: toNum(body.remaining_count),
    activityDay: toNum(body.activity_day),
    pending: pending ? {
      chooseId: toNum(pending.choose_id), textId: toNum(pending.text_id),
      dayId: toNum(pending.day_id), rewards: (pending.rewards || []).map(normalizeCoreItem),
    } : null,
    choices: WISH_SIGN_CHOICES.map((name, index) => ({ id: index + 1, name })),
    rewardPool: wishSignRewards.map(({ dayId, itemId, count }) => ({
      dayId, ...normalizeCoreItem({ id: itemId, count }),
    })),
  };
}

function normalizeShareRewardActivity(node, nowSeconds = Math.floor(Date.now() / 1000)) {
  const summary = node?.share_reward?.summary || {};
  const daily = summary.daily || {};
  return {
    title: '快乐不独享', activityId: SHARE_REWARD_ACTIVITY_ID,
    startTime: SHARE_REWARD_START_TIME, endTime: SHARE_REWARD_END_TIME,
    active: isShareRewardActive(nowSeconds),
    scoreItemId: toNum(summary.score_item_id), currentScore: toNum(summary.current_score),
    daily: {
      claimedCount: toNum(daily.claimed_count), claimLimit: toNum(daily.claim_limit),
      rewardClaimed: !!daily.daily_reward_claimed,
      firstShareAwarded: !!daily.first_share_awarded,
      dailyReward: toNum(summary.daily_reward), firstShareReward: toNum(summary.first_share_reward),
      poolClaimed: toNum(summary.my_pool?.claimed_count), poolLimit: toNum(summary.my_pool?.claim_limit),
    },
    milestones: (summary.milestones || []).map(tier => ({
      id: toNum(tier.tier_id), threshold: toNum(tier.threshold), state: toNum(tier.state),
      rewards: (tier.rewards || []).map(normalizeCoreItem),
    })),
  };
}

async function getWishSignActivity() {
  const group = await getActivityGroup(WISH_SIGN_GROUP_ID, WISH_SIGN_ACTIVITY_UID);
  const node = findActivityNodeById([group?.group], WISH_SIGN_ACTIVITY_ID);
  // 活动已下线（服务端不再下发 wish_sign 节点）时返回非 active 空结构，
  // 与快乐不独享保持一致：避免自动任务每轮抛错刷屏，由 active 字段驱动跳过。
  if (!node?.wish_sign) {
    return { ...normalizeWishSignActivity({}), active: false };
  }
  return normalizeWishSignActivity(node);
}

async function getShareRewardActivity() {
  const group = await getActivityGroup(SHARE_REWARD_GROUP_ID, SHARE_REWARD_ACTIVITY_UID);
  const node = findActivityNodeById([group?.group], SHARE_REWARD_ACTIVITY_ID);
  if (!node?.share_reward?.summary) throw new Error('快乐不独享活动数据未下发');
  return normalizeShareRewardActivity(node);
}

async function operateWishSign(action, chooseId) {
  if (!isWishSignActive()) throw new Error('秋祈良愿未开始或已结束');
  const choice = Number(chooseId);
  if (!Number.isInteger(choice) || choice < 1 || choice > WISH_SIGN_CHOICES.length) throw new Error('祈愿选择无效');
  assertActivityConnection('祈愿');
  const before = await getWishSignActivity();
  if (action === 'draw') {
    if (before.pending || before.remainingCount <= 0) throw new Error('当前没有可祈愿次数，或尚有奖励待领取');
  } else if (action === 'claim') {
    if (!before.pending || before.pending.chooseId !== choice) throw new Error('没有与该签文匹配的待领奖励');
  } else throw new Error('不支持的祈愿操作');
  const reply = await operateActivityReply(WISH_SIGN_ACTIVITY_ID, action === 'draw' ? WISH_SIGN_DRAW_CMD : WISH_SIGN_CLAIM_CMD,
    action === 'draw' ? { wishSignDraw: { chooseId: choice } } : { wishSignClaim: { chooseId: choice } });
  const rewards = action === 'draw' ? reply.wish_sign_draw?.rewards : reply.wish_sign_claim?.awards;
  return { ok: true, rewards: (rewards || []).map(normalizeCoreItem) };
}

async function operateShareReward(action) {
  if (!isShareRewardActive()) throw new Error('快乐不独享未开始或已结束');
  assertActivityConnection();
  const before = await getShareRewardActivity();
  if (action === 'daily' && before.daily.rewardClaimed) throw new Error('今日快乐值已领取');
  if (action === 'share' && before.daily.firstShareAwarded) throw new Error('今日首次分享奖励已领取');
  if (action === 'milestones' && !before.milestones.some(tier => tier.state === 2 && before.currentScore >= tier.threshold)) {
    throw new Error('没有可领取的快乐值档位');
  }
  const commands = { daily: SHARE_REWARD_DAILY_CMD, share: SHARE_REWARD_SHARE_CMD, milestones: SHARE_REWARD_MILESTONES_CMD };
  if (!commands[action]) throw new Error('不支持的快乐不独享操作');
  const reply = await operateActivityReply(SHARE_REWARD_ACTIVITY_ID, commands[action]);
  const result = action === 'daily' ? reply.share_reward_claim_daily
    : action === 'share' ? reply.share_reward_share : reply.share_reward_claim_milestones;
  return {
    ok: true, grantedScore: toNum(result?.granted_score),
    claimedTierIds: (result?.claimed_tier_ids || []).map(toNum),
    rewards: (result?.rewards || []).map(normalizeCoreItem),
  };
}

// ==================== 奶茶热销中（S4，2026-10-15） ====================
// 上游 liyangpengs/qq-farm-bot 对照官方客户端 1.15.0.1_20261001 编码器实现。
// 本地为 Node CJS 移植：读操作走 GetGroup（复用 ActivityNode.milk_tea / growth_fund），
// 写操作走 Operate（MilkTeaOperateRequest / Reply），字段号与上游 milk-tea.proto 对齐。

const MILK_TEA_SERVICE = 'gamepb.activitypb.ActivityService';

// 操作 → [cmd, 请求字段名, 归属子活动ID]
const MILK_TEA_OPERATIONS = {
  create: [MILK_TEA_CMD.create, 'milk_tea_create_shop', MILK_TEA_ACTIVITY_ID],
  rename: [MILK_TEA_CMD.rename, 'milk_tea_rename_shop', MILK_TEA_ACTIVITY_ID],
  shop: [MILK_TEA_CMD.shop, 'milk_tea_get_shop', MILK_TEA_ACTIVITY_ID],
  hireList: [MILK_TEA_CMD.hireList, 'milk_tea_get_hire_list', MILK_TEA_ACTIVITY_ID],
  hire: [MILK_TEA_CMD.hire, 'milk_tea_hire', MILK_TEA_ACTIVITY_ID],
  workshop: [MILK_TEA_CMD.workshop, 'milk_tea_get_workshop', MILK_TEA_ACTIVITY_ID],
  claim: [MILK_TEA_CMD.claim, 'milk_tea_claim_cashier', MILK_TEA_ACTIVITY_ID],
  boost: [MILK_TEA_CMD.boost, 'milk_tea_boost', MILK_TEA_ACTIVITY_ID],
  upgrade: [MILK_TEA_CMD.upgrade, 'milk_tea_upgrade', MILK_TEA_ACTIVITY_ID],
  craft: [MILK_TEA_CMD.craft, 'milk_tea_craft', MILK_TEA_ACTIVITY_ID],
  work: [MILK_TEA_CMD.work, 'milk_tea_get_work_page', MILK_TEA_ACTIVITY_ID],
  wages: [MILK_TEA_CMD.wages, 'milk_tea_claim_wages', MILK_TEA_ACTIVITY_ID],
  interact: [MILK_TEA_CMD.interact, 'milk_tea_interact', MILK_TEA_ACTIVITY_ID],
  rank: [MILK_TEA_CMD.rank, 'milk_tea_get_rank', MILK_TEA_ACTIVITY_ID],
  logs: [MILK_TEA_CMD.logs, 'milk_tea_get_sales_log', MILK_TEA_ACTIVITY_ID],
  hireSetting: [MILK_TEA_CMD.hireSetting, 'milk_tea_set_hire_disable', MILK_TEA_ACTIVITY_ID],
  exchange: [MILK_TEA_CMD.exchange, 'shop_buy', MILK_TEA_SHOP_ACTIVITY_ID],
  // 种子购买与兑换同走 shop_buy(cmd 1) + 子活动 2026110102，仅商品筛选不同（category_tag === 'seed'）
  seedBuy: [MILK_TEA_CMD.exchange, 'shop_buy', MILK_TEA_SHOP_ACTIVITY_ID],
  unlock: [MILK_TEA_CMD.unlock, 'growth_fund_unlock', MILK_TEA_FUND_ACTIVITY_ID],
  fundClaim: [MILK_TEA_CMD.fundClaim, 'growth_fund_claim', MILK_TEA_FUND_ACTIVITY_ID],
  // S4 快乐分享（子活动 2026110104），与「快乐不独享」共用 ShareReward 消息
  shareDaily: [MILK_TEA_CMD.shareDaily, 'share_reward_claim_daily', MILK_TEA_SHARE_ACTIVITY_ID],
  shareRewards: [MILK_TEA_CMD.shareRewards, 'share_reward_claim_milestones', MILK_TEA_SHARE_ACTIVITY_ID],
};
const MILK_TEA_READ_ACTIONS = new Set(['shop', 'hireList', 'workshop', 'work', 'rank', 'logs']);

let milkTeaTail = Promise.resolve();

function milkTeaPlain(type, value) {
  return type.toObject(type.create(value), { longs: String, bytes: String, defaults: false });
}

/**
 * 规范化 protobuf map 的 int64 key。
 *
 * ⚠️ protobufjs 对 `map<int64, X>` 的 key 在 JS 对象里是「原始字节字符串」，
 * 不是十进制数字：线上实测 `shop.boost_coin_price` 的 8 个 key 全是
 * `'\x03\x00\x00\x00\x00\x00\x00\x00'` 这种控制字符（= longFromHash 的逆）。
 * 直接把它当字符串下发到前端，面板上就是乱码 key，且按等级取值永远取不到。
 * 404 上游用 normalizeWireMaps + util.longFromHash 处理，此处对齐。
 */
function milkTeaNormalizeMapKey(key) {
  const text = String(key);
  // 仅当 key 含控制字符（原始 8 字节 long）时才需要还原
  if (![...text].some(ch => ch.charCodeAt(0) < 32)) return text;
  try {
    return protobuf.util.longFromHash(text, false).toString();
  } catch {
    return text;
  }
}

function milkTeaCupMap(values) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    out[milkTeaNormalizeMapKey(key)] = toNum(value);
  }
  return out;
}

function milkTeaRecipeConfig(recipeId) {
  return (milkTeaConfig.MilkTeaRecipeConfig || []).find(v => toNum(v.recipe_id) === toNum(recipeId)) || null;
}

function milkTeaRecipeName(recipeId) {
  return milkTeaRecipeConfig(recipeId)?.recipe_name || '';
}

// 走 Operate 的奶茶子操作，返回解码后的对应字段
async function milkTeaRpc(action, params = {}) {
  const op = MILK_TEA_OPERATIONS[action];
  if (!op) throw new Error(`不支持的奶茶操作: ${action}`);
  const [cmd, field, activityId] = op;
  assertActivityConnection('奶茶活动');
  const request = types.MilkTeaOperateRequest.encode(
    types.MilkTeaOperateRequest.create({
      activity_id: Number(activityId),
      operate_type: cmd,
      [field]: params,
    })
  ).finish();
  const { body } = await sendMsgAsync(MILK_TEA_SERVICE, 'Operate', request);
  const decoded = types.MilkTeaOperateReply.decode(body);
  if (toNum(decoded.activity_id) !== Number(activityId) || toNum(decoded.operate_type) !== cmd) {
    throw new Error('奶茶操作回包不匹配，请刷新后重试');
  }
  return decoded[field] || null;
}

// 读取奶茶活动组。
// ⚠️ 必须用独立的 MilkTeaGroup/MilkTeaNode 解码，不能复用 ActivityNode：
//   1) ActivityNode.activity 是 ActivityInfo（字段只到 105），没有 settle_start_time(24)，
//      奶茶的结算期时间只下发在 MilkTeaActivityHead.settle_start_time → 用 ActivityInfo 解恒为 0，
//      导致「结算期判定永久失效」（settling 恒 false）。
//   2) ActivityNode.exchange_shop = 102 被既有活动占用为 ExchangeShopInfo（items 列表），
//      奶茶子活动 2026110102 在同一字段号下发 ActivityBodyShop{goods}，
//      形状不同 → purchase_limit / category_tag / cond_hints 全部解不出，种子筛选与限购失效。
//   3) share_reward 挂在子活动 2026110104 上，需按 head.id 定位后单独取 summary。
// 故照上游做法用 MilkTeaGetGroupReply 独立解码。
async function getMilkTeaGroup() {
  const request = types.ActivityGetGroupRequest.encode(
    types.ActivityGetGroupRequest.create({
      id: Number(MILK_TEA_GROUP_ID),
      uid: String(MILK_TEA_ACTIVITY_UID || ''),
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', request);
  return types.MilkTeaGetGroupReply.decode(body);
}

// 在 MilkTeaGroup 树中按 head 的活动 ID 查找子节点。
// ⚠️ 结构与 ActivityNode 不同：节点是 `head`（非 `activity`），
//    且本地 MilkTeaActivityHead 的 ID 字段名是 `activity_id`（对应上游 ActivityHead.id，同为字段 1）。
function findMilkTeaNodeById(nodes, id) {
  for (const node of nodes || []) {
    const nodeId = toNum(node?.head?.activity_id ?? node?.head?.id);
    if (nodeId === id) return node;
    const found = findMilkTeaNodeById(node?.children, id);
    if (found) return found;
  }
  return null;
}

function normalizeMilkTeaSummary(node) {
  const body = node?.milk_tea || {};
  const summary = body.summary || {};
  return {
    shopOpenAt: toNum(summary.shop_open_at),
    shopName: String(summary.shop_name || ''),
    renameCdUntilAt: toNum(summary.rename_cd_until_at),
    level: toNum(summary.level),
    totalRevenue: toNum(summary.total_revenue),
    hireDisabled: !!summary.hire_disabled,
    cashierFull: !!summary.cashier_full,
    cashierWarning: !!summary.cashier_warning,
    canUpgrade: !!summary.can_upgrade,
    hasWorkerShift: !!summary.has_worker_shift,
    hasUnclaimedWage: !!summary.has_unclaimed_wage,
    nextCupAt: toNum(summary.next_cup_at),
    openingGiftPreview: (summary.opening_gift_preview || []).map(normalizeCoreItem),
  };
}

function normalizeMilkTeaShop(rawShop) {
  const shop = rawShop || {};
  return {
    level: toNum(shop.level),
    totalRevenue: toNum(shop.total_revenue),
    nextLevelRevenue: toNum(shop.next_level_revenue),
    cashierCapacitySec: toNum(shop.cashier_capacity_sec),
    cashierElapsedSec: toNum(shop.cashier_elapsed_sec),
    salesItemId: toNum(shop.sales_item_id),
    salesDurationSec: toNum(shop.sales_duration_sec),
    isSettling: !!shop.is_settling,
    boostCupsPerUse: toNum(shop.boost_cups_per_use),
    effectiveCupsPerHour: toNum(shop.effective_cups_per_hour),
    secPerCup: Number(shop.sec_per_cup) || 0,
    nextFullAt: toNum(shop.next_full_at),
    // 收银台待领收益（claim 前置条件依赖：至少一项 count > 0 才可领）
    pendingRewards: (shop.pending_rewards || []).map(normalizeCoreItem),
    slots: (shop.slots || []).map(slot => ({
      slotIndex: toNum(slot.slot_index),
      isRobot: !!slot.is_robot,
      shiftId: toNum(slot.shift_id),
      beginAt: toNum(slot.begin_at),
      endAt: toNum(slot.end_at),
      talentId: toNum(slot.talent_id),
      talentName: String(slot.talent_name || ''),
      employee: slot.employee ? {
        gid: toNum(slot.employee.gid),
        name: String(slot.employee.name || ''),
        level: toNum(slot.employee.level),
      } : null,
    })),
    drinkCups: milkTeaCupMap(shop.drink_cups),
    pendingCupsByRecipe: milkTeaCupMap(shop.pending_cups_by_recipe),
    pendingCupsBySource: milkTeaCupMap(shop.pending_cups_by_source),
    boostCoinPrice: milkTeaCupMap(shop.boost_coin_price),
    pendingRewards: (shop.pending_rewards || []).map(normalizeCoreItem),
    boostPreviewRewards: (shop.boost_preview_rewards || []).map(normalizeCoreItem),
  };
}

function normalizeMilkTeaRecipes(recipes) {
  return (recipes || []).map(recipe => {
    const row = milkTeaRecipeConfig(recipe.recipe_id);
    return {
      recipeId: toNum(recipe.recipe_id),
      recipeName: String(recipe.recipe_name || ''),
      unlocked: !!recipe.unlocked,
      isAdvanced: !!recipe.is_advanced,
      tokenPrice: toNum(recipe.token_price),
      coinPrice: toNum(recipe.coin_price),
      stockCups: toNum(recipe.stock_cups),
      clearCoinPrice: toNum(recipe.clear_coin_price),
      clearCoinTotal: toNum(recipe.clear_coin_total),
      description: String(row?.drink_desc || ''),
      fruitItemId: Number(String(row?.fruit_item_id || '0').split(':')[0] || 0),
    };
  });
}

function normalizeMilkTeaHire(value) {
  const v = value || {};
  const mapFriend = item => ({
    friend: item.friend ? {
      gid: toNum(item.friend.gid), name: String(item.friend.name || ''), level: toNum(item.friend.level),
    } : null,
    isRobot: !!item.is_robot,
    talentId: toNum(item.talent_id),
    talentName: String(item.talent_name || ''),
    state: toNum(item.state),
    stateUntilAt: toNum(item.state_until_at),
    rehireAvailableAt: toNum(item.rehire_available_at),
  });
  return {
    durationId: toNum(v.duration_id),
    wageTotal: toNum(v.wage_total),
    minRemainBizSec: toNum(v.min_remain_biz_sec),
    inviteEntry: !!v.invite_entry,
    friends: (v.friends || []).map(mapFriend),
    robots: (v.robots || []).map(mapFriend),
  };
}

function normalizeMilkTeaWork(value) {
  const v = value || {};
  const shift = v.my_shift;
  return {
    talentId: toNum(v.talent_id),
    talentName: String(v.talent_name || ''),
    interactDone: !!v.interact_done,
    myShift: shift ? {
      employer: shift.employer ? {
        gid: toNum(shift.employer.gid), name: String(shift.employer.name || ''),
      } : null,
      shopName: String(shift.shop_name || ''),
      shiftId: toNum(shift.shift_id),
      beginAt: toNum(shift.begin_at),
      endAt: toNum(shift.end_at),
      interactCount: toNum(shift.interact_count),
      interactLimit: toNum(shift.interact_limit),
      wageTotal: toNum(shift.wage_total),
      interactPreviews: (shift.interact_previews || []).map(p => ({
        interactionType: toNum(p.interaction_type), promoteCups: toNum(p.promote_cups),
      })),
    } : null,
    slips: (v.slips || []).map(slip => ({
      employer: slip.employer ? { gid: toNum(slip.employer.gid), name: String(slip.employer.name || '') } : null,
      shopName: String(slip.shop_name || ''),
      shiftId: toNum(slip.shift_id),
      beginAt: toNum(slip.begin_at),
      endAt: toNum(slip.end_at),
      workSec: toNum(slip.work_sec),
      wageStatus: toNum(slip.wage_status),
      baseWage: toNum(slip.wages?.base_wage),
      finalWage: toNum(slip.wages?.final_wage),
    })),
  };
}

/**
 * S4 快乐分享（子活动 2026110104）归一化。
 * 复用 ShareRewardSummary 消息（与「快乐不独享」同构），milestones 的 state：
 *   2 = 可领取，>2 = 已领取，其它 = 未达成。
 */
function normalizeMilkTeaShare(body) {
  const summary = body?.summary || {};
  const daily = summary.daily || {};
  return {
    scoreItemId: toNum(summary.score_item_id),
    currentScore: toNum(summary.current_score),
    dailyReward: toNum(summary.daily_reward),
    firstShareReward: toNum(summary.first_share_reward),
    daily: {
      claimed: !!daily.daily_reward_claimed,
      claimedCount: toNum(daily.claimed_count),
      claimLimit: toNum(daily.claim_limit),
      firstShareAwarded: !!daily.first_share_awarded,
    },
    redDots: {
      daily: !!summary.red_dots?.daily,
      milestone: !!summary.red_dots?.milestone,
      firstShare: !!summary.red_dots?.first_share,
    },
    milestones: (summary.milestones || []).map(tier => ({
      tierId: toNum(tier.tier_id),
      threshold: toNum(tier.threshold),
      state: toNum(tier.state),
      claimable: toNum(tier.state) === 2,
      rewards: (tier.rewards || []).map(normalizeCoreItem),
    })),
  };
}

/** 读取背包（含金币兜底，与 404 的 bag() 同口径）。 */
async function getMilkTeaInventory() {
  const inventory = [...(getBagItems(await getBag()) || [])];
  const account = getUserState() || {};
  if (!inventory.some(item => toNum(item?.id) === 1001) && account.gold != null) {
    inventory.push({ id: 1001, count: String(account.gold) });
  }
  return inventory;
}

/**
 * 取成本项的物品 id。
 * ⚠️ 必须同时兼容两种形状：原始 protobuf 项（`id`）与 normalizeCoreItem 输出（`itemId`）。
 * 曾经只读 `cost.id`，而 normalizeMilkTeaGood 用 normalizeCoreItem 生成 costs（只有 itemId），
 * 导致 toNum(undefined) === 0 → 与背包任意物品 id 都比不中 → affordable 恒 false、
 * maxPurchasable 恒 0，表现为「种子/兑换商品永远不可购买」。
 */
function milkTeaCostItemId(cost) {
  return toNum(cost?.itemId ?? cost?.id);
}

/** 库存是否够付（count 份）；钻石(1004)购买一律视为不可用。 */
function milkTeaCanAfford(costs, inventory, count = 1) {
  const list = (costs || []).filter(c => toNum(c?.count) > 0);
  if (!list.length) return false;
  return list.every(cost => {
    const costId = milkTeaCostItemId(cost);
    if (costId === 1004) return false;
    const owned = inventory
      .filter(x => toNum(x?.id) === costId)
      .reduce((sum, x) => sum + BigInt(String(x.count || 0)), 0n);
    return owned >= BigInt(toNum(cost.count)) * BigInt(count);
  });
}

/** 某商品在给定库存下最多可买多少（受限购与资源双约束）。 */
function milkTeaMaxPurchasable(good, inventory) {
  if (!good.unlocked || good.paid || !good.costs.length) return 0;
  let maximum = BigInt(good.remaining);
  for (const cost of good.costs) {
    const costId = milkTeaCostItemId(cost);
    if (costId === 1004 || BigInt(toNum(cost.count)) <= 0n) return 0;
    const owned = inventory
      .filter(item => toNum(item?.id) === costId)
      .reduce((sum, item) => sum + BigInt(String(item.count || 0)), 0n);
    const affordable = owned / BigInt(toNum(cost.count));
    if (affordable < maximum) maximum = affordable;
  }
  return Number(maximum);
}

/** 求某物品在库存里的总量（count 可能为字符串，用 BigInt 累加）。 */
function milkTeaInventoryCount(inventory, itemId) {
  const total = (inventory || [])
    .filter(x => toNum(x?.id) === itemId)
    .reduce((sum, x) => sum + BigInt(String(x.count || 0)), 0n);
  return Number(total);
}

/**
 * 兑换商店商品归一化（ActivityBodyShop.goods[]）。
 * 结算期不允许购买活动种子（与 404 同规则）。
 */
function normalizeMilkTeaGood(good, inventory, phase = 'business') {
  const costs = (good.cost || []).map(c => normalizeCoreItem({ id: c.id, count: c.count, uid: c.uid }));
  const remaining = Math.max(0, toNum(good.purchase_limit) - toNum(good.purchased_count));
  const unlocked = (good.cond_hints || []).every(hint => !!hint.satisfied);
  const paid = toNum(good.diamond_cost_count) > 0 || (good.cost || []).some(c => toNum(c.id) === 1004);
  const categoryTag = String(good.category_tag || '');
  const normalized = {
    id: String(toNum(good.id)),
    name: String(good.name || ''),
    description: String(good.desc || ''),
    categoryTag,
    order: toNum(good.order),
    purchaseLimit: toNum(good.purchase_limit),
    purchasedCount: toNum(good.purchased_count),
    remaining,
    unlocked,
    paid,
    rewards: (good.item || []).map(i => normalizeCoreItem({ id: i.id, count: i.count, uid: i.uid })),
    costs,
    condHints: (good.cond_hints || []).map(hint => ({
      type: String(hint.cond_type || ''),
      params: String(hint.params || ''),
      satisfied: !!hint.satisfied,
      current: toNum(hint.current),
      target: toNum(hint.target),
    })),
  };
  normalized.affordable = milkTeaCanAfford(costs, inventory, 1);
  normalized.maxPurchasable = (phase !== 'business' && categoryTag === 'seed')
    ? 0
    : milkTeaMaxPurchasable(normalized, inventory);
  // ⚠️ 前端兑换按钮绑定 `g.available`（MilkTeaActivityPanel.vue:693 `:disabled="!g.available"`），
  //    但后端此前从未下发该字段 → `!undefined` 恒为 true → 按钮永久置灰，用户「根本点不了兑换」。
  //    语义 = 当前是否可兑换（至少 1 份）：已解锁 + 非钻石支付 + 有限购余量 + 资源足够。
  //    直接复用 maxPurchasable（它已含上述全部判定，且结算期活动种子自动归 0），保证前后端口径一致。
  normalized.available = normalized.maxPurchasable > 0;
  return normalized;
}

// 官方 S4ShopUI 排序：可购买 → 售罄 → 未解锁，同级按 order。
function compareMilkTeaGoods(a, b) {
  const group = g => (!g.unlocked ? 3 : g.remaining === 0 ? 2 : 1);
  return group(a) - group(b) || a.order - b.order;
}

function normalizeMilkTeaFund(node) {
  const fund = node?.growth_fund || {};
  return {
    unlocked: !!fund.unlocked,
    costs: (fund.unlock_cost || []).map(normalizeCoreItem),
    tiers: (fund.tiers || []).map(tier => ({
      id: toNum(tier.tier_id),
      state: toNum(tier.state),
      rewards: (tier.reward || []).map(normalizeCoreItem),
      conditions: (tier.conditions || []).map(c => ({
        type: String(c.type || ''),
        current: toNum(c.current_value),
        target: toNum(c.target_value),
        reached: !!c.reached,
      })),
    })),
  };
}

/**
 * 获取奶茶热销中活动状态。
 * @param {string} page 页面：shop/settings/upgrade/workshop/hireList/exchange/fund/work/rank/logs
 * @param {object} input 附加参数（durationId/pageNumber/day/name 等）
 */
async function getMilkTeaActivity(page = 'shop', input = {}) {
  const validPages = ['shop', 'settings', 'upgrade', 'workshop', 'hireList', 'exchange', 'fund', 'work', 'rank', 'logs'];
  if (!validPages.includes(page)) throw new Error('未知的奶茶活动页面');
  const group = await getMilkTeaGroup();
  const root = group?.group;
  const node = findMilkTeaNodeById([root], MILK_TEA_ACTIVITY_ID);
  // 活动未上线/已下线：返回 inactive 空结构，避免自动化每轮抛错刷屏
  if (!node?.milk_tea?.summary) {
    return { activityId: MILK_TEA_ACTIVITY_ID, title: '奶茶热销中', active: false, settling: false, phase: 'ended', page };
  }
  const head = node.head || {};
  const now = Math.floor(Date.now() / 1000);
  const beginTime = toNum(head.begin_time || head.start_time);
  const endTime = toNum(head.end_time);
  const settleStartTime = toNum(head.settle_start_time);
  const active = now >= beginTime && now < endTime;
  const settling = settleStartTime > 0 && now >= settleStartTime;
  const phase = now < beginTime ? 'upcoming' : now >= endTime ? 'ended' : settling ? 'settling' : 'business';
  const summary = normalizeMilkTeaSummary(node);

  const result = {
    activityId: MILK_TEA_ACTIVITY_ID,
    groupId: MILK_TEA_GROUP_ID,
    title: String(head.name || '奶茶热销中'),
    rules: String(head.extra || ''),
    serverTime: now,
    startTime: beginTime,
    endTime,
    settleStartTime,
    active,
    settling,
    phase,
    page,
    summary,
    recommendedNames: String(milkTeaConfig.MilkTeaActivityConfig?.[0]?.recommend_names || '').split(';').filter(Boolean),
    levels: (milkTeaConfig.MilkTeaStoreLevelConfig || []).map(level => ({
      level: toNum(level.level),
      revenueRequired: toNum(level.revenue_required),
      basePopularity: toNum(level.base_popularity),
      employeeSlotCount: toNum(level.employee_slot_count),
      recipes: String(level.recipe_ids_string || '').split(';').filter(Boolean).map(id => milkTeaRecipeName(id)),
    })),
  };

  // 成长基金（不依赖店铺是否开业）
  const fundNode = findMilkTeaNodeById([root], MILK_TEA_FUND_ACTIVITY_ID);
  if (fundNode?.growth_fund) result.fund = normalizeMilkTeaFund(fundNode);

  // S4 快乐分享（子活动 2026110104，share_reward.summary）
  const shareNode = findMilkTeaNodeById([root], MILK_TEA_SHARE_ACTIVITY_ID);
  if (shareNode?.share_reward) result.share = normalizeMilkTeaShare(shareNode.share_reward);

  // 兑换商店（子活动 2026110102，独立 schema 下为 ActivityBodyShop.goods）
  const shopNode = findMilkTeaNodeById([root], MILK_TEA_SHOP_ACTIVITY_ID);
  const rawGoods = shopNode?.shop?.goods || [];
  const inventory = await getMilkTeaInventory();
  result.goods = rawGoods
    .map(good => normalizeMilkTeaGood(good, inventory, phase))
    .sort(compareMilkTeaGoods);

  // 兑换货币余额（供面板显示「我有多少奶茶券/金币」）：
  // 1041=奶茶券（活动专属兑换货币）、1001=金币。取自背包（金币兜底 state.gold）。
  result.balances = {
    milkTeaToken: milkTeaInventoryCount(inventory, 1041),
    goldCoin: milkTeaInventoryCount(inventory, 1001),
  };

  // 店铺相关（需已开业且活动在期）
  if (active && summary.shopOpenAt > 0) {
    if (['shop', 'upgrade', 'workshop', 'hireList'].includes(page)) {
      const shopReply = await milkTeaRpc('shop');
      result.shop = normalizeMilkTeaShop(shopReply?.shop);
    }
    if (page === 'shop' || page === 'workshop') {
      const wsReply = await milkTeaRpc('workshop');
      result.recipes = normalizeMilkTeaRecipes(wsReply?.recipes);
    }
    if (page === 'hireList') {
      const durationId = Math.max(1, Math.min(3, toNum(input.durationId) || 1));
      const hireReply = await milkTeaRpc('hireList', { duration_id: durationId });
      result.hire = normalizeMilkTeaHire(hireReply);
      result.durations = milkTeaConfig.MilkTeaHireDurationConfig || [];
    }
    if (page === 'work') {
      const workReply = await milkTeaRpc('work');
      result.work = normalizeMilkTeaWork(workReply);
    }
    if (page === 'rank') {
      const rankReply = await milkTeaRpc('rank', { page: Math.max(1, toNum(input.pageNumber) || 1) });
      result.rank = {
        myRank: toNum(rankReply?.my_rank),
        page: toNum(rankReply?.page),
        hasMore: !!rankReply?.has_more,
        ranks: (rankReply?.ranks || []).map(r => ({
          rank: toNum(r.rank), shopName: String(r.shop_name || ''), level: toNum(r.level),
          totalRevenue: toNum(r.total_revenue),
          owner: r.owner ? { gid: toNum(r.owner.gid), name: String(r.owner.name || '') } : null,
        })),
      };
    }
    if (page === 'logs') {
      const today = Math.floor((now + 8 * 3600) / 86400) * 86400 - 8 * 3600;
      const day = toNum(input.day) || today;
      const logReply = await milkTeaRpc('logs', { day });
      result.logs = {
        day: toNum(logReply?.day),
        token: toNum(logReply?.token),
        coin: toNum(logReply?.coin),
        cups: toNum(logReply?.cups),
        cupsByRecipe: milkTeaCupMap(logReply?.cups_by_recipe),
        cupsBySource: milkTeaCupMap(logReply?.cups_by_source),
        items: (logReply?.items || []).map(normalizeCoreItem),
      };
    }
  }

  return result;
}

/**
 * 执行奶茶活动操作（串行化，避免并发写）。
 * @param {string} action 见 MILK_TEA_OPERATIONS
 * @param {object} input 参数
 */
function operateMilkTeaActivity(action, input = {}) {
  const task = milkTeaTail.then(() => performMilkTeaOperation(action, input));
  milkTeaTail = task.catch(() => {});
  return task;
}

// 结算期允许的操作（其余一律拒绝）。对齐上游 activity-milk-tea.js 的结算期白名单：
// 只允许领奖类 + 兑换，不允许经营类（升级/制作/加速/雇佣/互动/开业/改名）。
// 注：seedBuy 不在白名单内 —— 它虽走 shop_buy(cmd 1) 兑换通道，但官方 S4ShopUI 明确
// 结算期禁止购买活动种子，故单独给出更精确的错误信息（见下方检查）。
const MILK_TEA_SETTLING_ALLOWED = new Set([
  'claim', 'wages', 'exchange', 'shareDaily', 'shareRewards', 'fundClaim',
]);
// 无需店铺已开业的操作
const MILK_TEA_NO_SHOP_REQUIRED = new Set(['create', 'shareDaily', 'shareRewards', 'fundClaim']);

async function performMilkTeaOperation(action, input = {}) {
  const op = MILK_TEA_OPERATIONS[action];
  if (!op || MILK_TEA_READ_ACTIONS.has(action)) throw new Error('未知的奶茶活动操作');
  const state = await getMilkTeaActivity(milkTeaPageForAction(action), input);
  if (!state.active) throw new Error('奶茶活动尚未开放或已结束');
  if (!MILK_TEA_NO_SHOP_REQUIRED.has(action) && !state.summary.shopOpenAt) throw new Error('请先开业');
  // 结算期不允许购买活动种子（与官方 S4ShopUI 同规则）——先于通用白名单检查，
  // 以便给出「结算期不能购买活动种子」这一更精确的提示。
  if (action === 'seedBuy' && state.phase !== 'business') {
    throw new Error('结算期不能购买活动种子');
  }
  if (state.phase && state.phase !== 'business' && !MILK_TEA_SETTLING_ALLOWED.has(action)) {
    throw new Error('结算期不可进行此操作');
  }

  let params = {};
  if (action === 'create' || action === 'rename') {
    const rule = milkTeaConfig.MilkTeaActivityConfig?.[0] || {};
    const name = String(input.name || '').trim();
    const len = [...name].length;
    if (len < toNum(rule.name_min_length) || len > toNum(rule.name_max_length)) {
      throw new Error(`店名需为 ${toNum(rule.name_min_length)}—${toNum(rule.name_max_length)} 个字`);
    }
    if (action === 'create' && state.summary.shopOpenAt > 0) throw new Error('店铺已经开业');
    params = { shop_name: name };
  } else if (action === 'boost') {
    // ⚠️ 必须先查「宣传喇叭」库存，否则每轮都发请求被服务端拒绝，
    //    而拒绝回包不含 activity_id/operate_type → 被 milkTeaRpc 误报成
    //    「奶茶操作回包不匹配，请刷新后重试」，日志里表现为 boost 永久失败刷屏。
    //    404 参考实现有这一步（available([{ id: state.shop.sales_item_id, count: 1 }], inventory)）。
    //    线上实测：salesItemId=1042，账号 1 持有 0 个 → 本应静默跳过。
    const salesItemId = toNum(state.shop?.salesItemId);
    if (salesItemId > 0) {
      const inventory = await getMilkTeaInventory();
      if (!milkTeaCanAfford([{ itemId: salesItemId, count: 1 }], inventory, 1)) {
        return { ok: true, action, skipped: true, reason: '宣传喇叭不足', rewards: [] };
      }
    }
    params = { count: Math.max(1, Math.min(9999, toNum(input.count) || 1)) };
  } else if (action === 'upgrade') {
    if (!state.summary.canUpgrade) throw new Error('尚未达到店铺升级条件');
  } else if (action === 'craft') {
    const explicit = Array.isArray(input.fruits) ? input.fruits : [];
    let uids = [...new Set(explicit.map(f => String(f.uid)).filter(Boolean))];
    if (!uids.length && input.auto === true) {
      // 自动挑选：已解锁的高级配方对应果实，从背包里取 uid > 0 且数量 > 0 的
      const eligible = new Set(
        (state.recipes || []).filter(r => r.unlocked && r.isAdvanced).map(r => r.fruitItemId).filter(Boolean)
      );
      const inventory = await getMilkTeaInventory();
      uids = inventory
        .filter(x => eligible.has(toNum(x.id)) && toNum(x.uid) > 0 && toNum(x.count) > 0)
        .map(x => String(x.uid));
    }
    // 「配方已解锁但没有果实」属正常无事可做（果实要先去农场种/收），
    // 返回 skipped 而不是 throw —— 否则 worker 每轮都记一条 error 刷屏。
    // 线上实测：账号 1 已解锁配方 2/9，但对应果实 40525/49005 背包均为 0。
    if (!uids.length) return { ok: true, action, skipped: true, reason: '没有可加工的已解锁活动果实', rewards: [] };
    if (uids.length > 200) throw new Error('一次最多加工 200 个果实');
    params = { fruit_uids: uids.map(Number).filter(Number.isFinite) };
  } else if (action === 'hire') {
    const levelCfg = (milkTeaConfig.MilkTeaStoreLevelConfig || [])
      .find(v => toNum(v.level) === toNum(state.shop?.level));
    const slotCount = toNum(levelCfg?.employee_slot_count);
    const now = Math.floor(Date.now() / 1000);
    const usedSlots = new Set((state.shop?.slots || []).filter(s => s.endAt > now).map(s => s.slotIndex));
    let slotIndex = input.slotIndex != null ? toNum(input.slotIndex) : -1;
    if (slotIndex < 0 || usedSlots.has(slotIndex)) {
      slotIndex = -1;
      for (let i = 0; i < slotCount; i++) if (!usedSlots.has(i)) { slotIndex = i; break; }
    }
    if (slotIndex < 0) throw new Error('员工位置已满');

    const durationId = [1, 2, 3].includes(toNum(input.durationId)) ? toNum(input.durationId) : 1;
    const talentId = [0, 9001, 9002, 9003, 9004].includes(toNum(input.talentId)) ? toNum(input.talentId) : 0;

    let candidate = null;
    if (input.autoSelect === true) {
      // 优先空闲好友（按天赋偏好），无可用时回落机器人；talentId=9004 只选机器人
      const idle = e => e?.friend?.gid && e.state === 0
        && e.stateUntilAt <= now && e.rehireAvailableAt <= now;
      const friends = (state.hire?.friends || []).filter(e => !e.isRobot && idle(e));
      const robots = (state.hire?.robots || []).filter(idle);
      candidate = talentId === 9004
        ? robots[0]
        : friends.find(e => !talentId || e.talentId === talentId) || friends[0] || robots[0];
      if (!candidate) return { ok: true, action, skipped: true, reason: '没有符合策略的空闲员工', rewards: [] };
    } else {
      const targetGid = toNum(input.targetGid);
      candidate = [...(state.hire?.friends || []), ...(state.hire?.robots || [])]
        .find(v => toNum(v.friend?.gid) === targetGid);
      if (!candidate || candidate.state !== 0 || candidate.rehireAvailableAt > now) throw new Error('该员工当前不可雇佣');
    }
    params = {
      hires: [{ slot_index: slotIndex, duration_id: durationId, target_gid: toNum(candidate.friend?.gid) }],
    };
  } else if (action === 'exchange' || action === 'seedBuy') {
    const wantSeed = action === 'seedBuy';
    const count = Math.max(1, toNum(input.count) || 1);
    const goodsList = state.goods || [];
    let good = input.goodsId != null
      ? goodsList.find(g => g.id === String(toNum(input.goodsId)))
      : null;
    if (wantSeed) {
      // 自动挑选：未售罄、已解锁、非钻石购买、资源足够，优先 order 小的
      if (!good || good.categoryTag !== 'seed') {
        good = goodsList
          .filter(g => g.categoryTag === 'seed' && g.unlocked && !g.paid && g.remaining > 0 && g.affordable)
          .sort(compareMilkTeaGoods)[0] || null;
      }
      if (!good) throw new Error('暂无可购买的活动种子（未解锁/售罄/资源不足）');
      if (!good.unlocked) throw new Error('该商品尚未解锁');
      if (good.remaining <= 0) throw new Error('该商品已售罄');
    }
    if (!good) throw new Error('商品不存在或已下架');
    if (good.paid) throw new Error('不支持钻石购买');
    if (good.remaining < count) throw new Error('超出限购数量');
    if (!milkTeaCanAfford(good.costs, await getMilkTeaInventory(), count)) throw new Error('资源不足');
    params = { goods_id: toNum(good.id), count };
  } else if (action === 'wages') {
    if (!(state.work?.slips || []).some(s => s.wageStatus === 1)) throw new Error('暂无可领取工资');
  } else if (action === 'interact') {
    const shift = state.work?.myShift;
    const now = Math.floor(Date.now() / 1000);
    if (!shift || state.work?.interactDone || shift.endAt <= now || shift.interactCount >= shift.interactLimit) {
      throw new Error('当前班次不可互动');
    }
    params = {
      target_gid: toNum(shift.employer?.gid),
      interaction_type: Math.max(1, Math.min(5, toNum(input.interactionType) || 1)),
    };
  } else if (action === 'hireSetting') {
    params = { hire_disabled: !!input.disabled };
  } else if (action === 'unlock') {
    if (state.fund?.unlocked) throw new Error('成长基金已解锁');
  } else if (action === 'fundClaim') {
    if (!state.fund?.unlocked || !(state.fund?.tiers || []).some(t => t.state === 2)) {
      throw new Error('暂无可领取的成长基金奖励');
    }
  } else if (action === 'shareDaily') {
    if (!state.share?.daily || state.share.daily.claimed) throw new Error('今日已领取每日快乐值');
  } else if (action === 'shareRewards') {
    if (!(state.share?.milestones || []).some(t => t.claimable)) throw new Error('暂无可领取的分享档位奖励');
  } else if (action === 'claim') {
    if (!(state.shop?.pendingRewards || []).some(r => toNum(r.count) > 0)) throw new Error('暂无可领取收益');
  }

  const reply = await milkTeaRpc(action, params);
  if (action === 'hire' && !(reply?.results || []).some(r => r.success)) {
    throw new Error(reply?.results?.[0]?.error_msg || '雇佣未成功，请刷新确认');
  }
  const rewards = ((reply?.awards || reply?.items || reply?.rewards || reply?.opening_gift || reply?.items_gained) || [])
    .map(normalizeCoreItem);
  if (action === 'boost') {
    const gain = [];
    if (toNum(reply?.token_gain) > 0) gain.push(normalizeCoreItem({ id: 1041, count: toNum(reply.token_gain) }));
    if (toNum(reply?.coin_gain) > 0) gain.push(normalizeCoreItem({ id: 1001, count: toNum(reply.coin_gain) }));
    rewards.push(...gain);
  }
  // 分享每日回包额外带 granted_score（快乐值），档位回包的 rewards 已被上方通用分支收集
  if (action === 'shareDaily' && toNum(reply?.granted_score) > 0) {
    rewards.push(normalizeCoreItem({ id: toNum(state.share?.scoreItemId) || 1042, count: toNum(reply.granted_score) }));
  }
  return { ok: true, action, rewards };
}

function milkTeaPageForAction(action) {
  if (action === 'exchange' || action === 'seedBuy') return 'exchange';
  if (action === 'unlock' || action === 'fundClaim') return 'fund';
  if (action === 'hire') return 'hireList';
  if (action === 'craft') return 'workshop';
  if (action === 'wages' || action === 'interact') return 'work';
  if (action === 'rename' || action === 'hireSetting') return 'settings';
  if (action === 'upgrade') return 'upgrade';
  return 'shop';
}

module.exports = {
  NANGUA_ACTIVITY_UID,
  HELU_ACTIVITY_UID,
  STAR_ACTIVITY_UID,
  QINGMEI_ACTIVITY_UID,
  NANGUA_SHOP_ACTIVITY_ID,
  NANGUA_RANDOM_SHOP_ACTIVITY_ID,
  HELU_ACTIVITY_ID,
  STAR_ACTIVITY_ID,
  STAR_RECORD_ACTIVITY_ID,
  STAR_SHOP_ACTIVITY_ID,
  STAR_SHOP_EXCHANGE_CMD,
  HELU_DRAW_ACTIVITY_ID,
  HELU_EXCHANGE_ACTIVITY_ID,
  QINGMEI_ACTIVITY_ID,
  QINGMEI_SEED_CLAIM_ACTIVITY_ID,
  QINGMEI_WINE_ACTIVITY_ID,
  HELU_SUB_ACTIVITY_KEYS,
  NANGUA_SHOP_BUY_CMD,
  NANGUA_SHOP_REFRESH_CMD,
  HELU_EXCHANGE_CMD,
  HELU_DRAW_CMD,
  getActivityGroup,
  getActivityDiscoveryList,
  getActivityGroupSnapshot,
  getNanguaShop,
  getHeluActivity,
  getStarActivity,
  claimStarRecordRewards,
  exchangeStarShopItem,
  getQingmeiActivity,
  claimQingmeiSeeds,
  brewAndSellQingmeiWine,
  QIXI_ACTIVITY_UID,
  QIXI_ACTIVITY_ID,
  QIXI_BRIDGE_ACTIVITY_ID,
  QIXI_GIFT_ACTIVITY_ID,
  getQixiActivity,
  useQixiDew,
  useQixiDewOnFriend,
  isQixiDewLimitReachedToday,
  buildQixiBridge,
  sendQixiSachet,
  getQixiEndedState,
  getQixiEndedStateCached,
  RAIN_POEM_ACTIVITY_UID,
  RAIN_POEM_ACTIVITY_ID,
  RAIN_POEM_COLLECTION_ACTIVITY_ID,
  RAIN_POEM_RESEARCH_ACTIVITY_ID,
  getRainPoemActivity,
  buyRainPoemCollectionBottle,
  collectRainPoemWeather,
  useRainPoemSummonBottle,
  unlockRainPoemResearch,
  normalizeRainPoemActivity,
  mergeRainPoemTaskUsage,
  normalizeWeatherStatus,
  getOwnWeatherStatus,
  encodeRainPoemSummonUseRequest,
  isLightningMutantPlant,
  normalizeQixiActivity,
  markQixiDewApplied,
  clearQixiDewApplied,
  isQixiDewApplied,
  isQixiDewDailyLimitError,
  QINGMEI_WINE_END_TIME,
  getSeasonPassport,
  claimSeasonPassportRewards,
  getSolarTermsInfo,
  claimSolarTermsReward,
  exchangeHeluShopItem,
  drawHeluGiftLotus,
  buyNanguaShopItem,
  refreshNanguaShop,
  normalizeNanguaGroup,
  normalizeHeluGroup,
  getPetDiary,
  operatePetDiary,
  getPetDiaryRecords,
  getPetDiaryFriend,
  isWishSignActive,
  isShareRewardActive,
  normalizeWishSignActivity,
  normalizeShareRewardActivity,
  getWishSignActivity,
  getShareRewardActivity,
  operateWishSign,
  operateShareReward,
  // 奶茶热销中（S4，2026-10-15）
  MILK_TEA_GROUP_ID,
  MILK_TEA_ACTIVITY_ID,
  MILK_TEA_SHOP_ACTIVITY_ID,
  MILK_TEA_FUND_ACTIVITY_ID,
  MILK_TEA_SHARE_ACTIVITY_ID,
  MILK_TEA_ACTIVITY_UID,
  MILK_TEA_CMD,
  MILK_TEA_OPERATIONS,
  getMilkTeaActivity,
  operateMilkTeaActivity,
};
