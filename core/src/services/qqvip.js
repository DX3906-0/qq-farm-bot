/**
 * QQ会员服务 - 每日自动领取VIP礼包
 *
 * 功能：
 * - 查询每日VIP礼包状态
 * - 自动领取每日VIP礼包
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

const DAILY_KEY = 'vip_daily_gift';

// 两次检查最小间隔：10分钟
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// 每日状态追踪
// doneDateKey：**真的领到**会员礼包才算「今日已完成」（驱动面板状态文案）
// checkedDateKey：今天已经查过了（驱动短路节流）
// ⚠️ 二者必须分开：原先只有一个 doneDateKey，「服务端下发奖励配置但本账号无可领类型
// （即未开通 QQ 会员）」也被 markDoneToday() → 面板显示「会员礼包 今日已完成」，
// 而用户根本没充值会员（2026-10-22 用户实测反馈，月卡礼包同因）。
let doneDateKey = '';
let checkedDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasGift = null;
let lastCanClaim = null;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function markDoneToday() {
  doneDateKey = getDateKey();
  checkedDateKey = doneDateKey;
}

function markCheckedToday() {
  checkedDateKey = getDateKey();
}

function isDoneToday() {
  return doneDateKey === getDateKey();
}

function isCheckedToday() {
  return checkedDateKey === getDateKey();
}

// ---- 奖励摘要 ----
// 1001→金币, 1002→经验, 500→点券

function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    if (id === 1001 || id === 500001) {
      parts.push(`金币${count}`);
    } else if (id === 1002 || id === 500002) {
      parts.push(`经验${count}`);
    } else if (id === 500) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : `物品#${id}`;
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

/**
 * 判断是否"已领取"错误
 */
function isAlreadyClaimedError(err) {
  const msg = String(err && err.message || '');
  return msg.includes('code=1021002') || msg.includes('今日已领取') || msg.includes('已领取');
}

// ---- RPC 调用 ----

async function refreshVipInfo() {
  const request = types.RefreshVipInfoRequest.encode(
    types.RefreshVipInfoRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'RefreshVipInfo', request);
  return types.RefreshVipInfoReply.decode(body);
}

async function getDailyGiftStatus() {
  const request = types.GetQQVipRewardsStatusRequest.encode(
    types.GetQQVipRewardsStatusRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.qqvippb.QQVipService', 'GetQQVipRewardsStatus', request);
  return types.GetQQVipRewardsStatusReply.decode(body);
}

function getAvailableVipTypes(status) {
  const configs = Array.isArray(status && status.reward_configs)
    ? status.reward_configs
    : [];
  return configs
    .map(config => toNum(config && config.vip_type))
    .filter((vipType, index, list) => (
      (vipType === 1 || vipType === 2) && list.indexOf(vipType) === index
    ));
}

function getVipRewardLabels(vipTypes) {
  const labels = {
    1: 'VIP奖励',
    2: 'SVIP奖励',
  };
  return (Array.isArray(vipTypes) ? vipTypes : [])
    .map(vipType => labels[toNum(vipType)])
    .filter(Boolean);
}

async function claimDailyGift(vipTypes) {
  const request = types.ClaimQQVipRewardsRequest.encode(
    types.ClaimQQVipRewardsRequest.create({ vip_types: vipTypes })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.qqvippb.QQVipService',
    'ClaimQQVipRewards',
    request
  );
  return types.ClaimQQVipRewardsReply.decode(body);
}

// ---- 主逻辑 ----

/**
 * 执行每日VIP礼包领取
 * @param {boolean} force - 强制检查
 */
async function performDailyVipGift(force = false) {
  const now = Date.now();

  // 短路用「今天查过」而不是「今天领过」：未开通会员时也要能到达下面的分支把状态写成「未开通」，
  // 同时仍保证一天只查一次（force 时忽略）。
  if (!force && isCheckedToday()) return false;
  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;

  lastCheckAt = now;

  try {
    await refreshVipInfo();
    const status = await getDailyGiftStatus();
    const availableVipTypes = getAvailableVipTypes(status);

    lastCanClaim = availableVipTypes.length > 0;
    // ⚠️ reward_configs 是**奖励配置表**，未开通会员时服务端同样会下发，
    // 所以「配置非空」≠「本账号有会员」。判「是否开通」只看：类型里真能领，
    // 或今天我们确实领到过（doneToday && ok）。
    const claimedToday = isDoneToday() && lastResult === 'ok';
    lastHasGift = availableVipTypes.length > 0 || claimedToday;

    if (!availableVipTypes.length) {
      // 未开通会员：只记「今天查过」，**不标完成**（否则面板会误显示「今日已完成」）
      markCheckedToday();
      lastResult = claimedToday ? 'ok' : 'none';
      log('会员', '今日暂无可领取会员礼包', {
        module: 'task', event: DAILY_KEY, result: lastResult, hasGift: lastHasGift,
      });
      return false;
    }

    const reply = await claimDailyGift(availableVipTypes);
    const items = Array.isArray(reply && reply.items) ? reply.items : [];
    const summary = getRewardSummary(items);
    const vipRewards = getVipRewardLabels(availableVipTypes);
    const rewardLabel = vipRewards.join('、') || '会员礼包';

    // ⚠️ 服务端对「未开通 QQ 会员」的账号**不报错但也不给任何物品**（items 为空 / count=0）。
    // 旧代码把「没抛错」直接当成功 → lastResult='ok' + markDoneToday() → 面板显示「今日已完成」，
    // 而用户根本没开通会员、什么都没领到（2026-10-22 用户实测：日志 count=0 却写「领取成功」）。
    // 判据必须看**是否真拿到物品**，而不是看有没有抛异常。
    if (items.length === 0) {
      markCheckedToday();
      lastHasGift = claimedToday;
      lastResult = claimedToday ? 'ok' : 'none';
      log('会员', '今日暂无可领取会员礼包（服务端返回空，通常为未开通 QQ 会员）', {
        module: 'task', event: DAILY_KEY, result: lastResult, count: 0, hasGift: lastHasGift,
        vipTypes: availableVipTypes,
      });
      return false;
    }

    log('会员',
      `${rewardLabel}领取成功 → ${summary}`,
      {
        module: 'task',
        event: DAILY_KEY,
        result: 'ok',
        count: items.length,
        vipTypes: availableVipTypes,
        vipRewards,
      }
    );

    lastClaimAt = Date.now();
    lastHasGift = true;
    markDoneToday();
    lastResult = 'ok';
    return true;
  } catch (err) {
    // 如果已经领取过，也标记完成（说明确实开通了会员）
    if (isAlreadyClaimedError(err)) {
      markDoneToday();
      lastClaimAt = Date.now();
      lastHasGift = true;
      lastResult = 'ok';
      log('会员', '今日会员礼包已领取', { module: 'task', event: DAILY_KEY, result: 'ok' });
      return false;
    }

    lastResult = 'error';
    log('会员', `领取会员礼包失败: ${err.message}`, {
      module: 'task', event: DAILY_KEY, result: 'error',
    });
    return false;
  }
}

module.exports = {
  performDailyVipGift,
  getAvailableVipTypes,
  getVipRewardLabels,
  getVipDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
    lastClaimAt,
    result: lastResult,
    hasGift: lastHasGift,
    canClaim: lastCanClaim,
  }),
};
