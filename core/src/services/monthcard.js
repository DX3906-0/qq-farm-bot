/**
 * 月卡服务 - 每日自动领取月卡礼包
 *
 * 功能：
 * - 查询月卡状态（是否拥有、是否可领取）
 * - 自动领取月卡每日奖励
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');

const DAILY_KEY = 'month_card_gift';

// 两次检查最小间隔：10分钟
const CHECK_COOLDOWN_MS = 10 * 60 * 1000;

// 每日状态追踪
// doneDateKey：**真的领到**月卡礼包才算「今日已完成」（驱动面板状态文案）
// checkedDateKey：今天已经查过了（驱动短路节流，避免无月卡时每 10 分钟重复发 RPC）
// ⚠️ 二者必须分开：以前只有一个 doneDateKey，导致「服务端下发月卡记录但 can_claim 全 false
// （即未购买/已过期）」也被 markDoneToday() → 面板显示「月卡礼包 今日已完成」，
// 而用户根本没买过月卡（2026-10-22 用户实测反馈）。
let doneDateKey = '';
let checkedDateKey = '';
let lastCheckAt = 0;
let lastClaimAt = 0;
let lastResult = '';
let lastHasCard = null;
let lastHasClaimable = null;

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
// 1001→金币, 1002→经验, 200→点券

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
    } else if (id === 200) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : `物品#${id}`;
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

// ---- RPC 调用 ----

async function getMonthCardInfos() {
  const request = types.GetMonthCardInfosRequest.encode(
    types.GetMonthCardInfosRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'GetMonthCardInfos', request);
  return types.GetMonthCardInfosReply.decode(body);
}

async function claimMonthCardReward(goodsId) {
  const request = types.ClaimMonthCardRewardRequest.encode(
    types.ClaimMonthCardRewardRequest.create({ goods_id: Number(goodsId) || 0 })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.mallpb.MallService', 'ClaimMonthCardReward', request);
  return types.ClaimMonthCardRewardReply.decode(body);
}

// ---- 主逻辑 ----

/**
 * 执行每日月卡礼包领取
 * @param {boolean} force - 强制检查
 */
async function performDailyMonthCardGift(force = false) {
  const now = Date.now();

  // 短路用「今天查过」而不是「今天领过」：无月卡时也要能到达下面的分支把状态写成「未开通」，
  // 同时仍保证一天只查一次（force 时忽略）。
  if (!force && isCheckedToday()) return false;
  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return false;

  lastCheckAt = now;

  try {
    const reply = await getMonthCardInfos();
    const infos = Array.isArray(reply && reply.infos) ? reply.infos : [];

    // 筛选可领取的月卡
    const claimable = infos.filter(
      (info) => info && info.can_claim && Number(info.goods_id || 0) > 0
    );

    lastHasClaimable = claimable.length > 0;

    // ⚠️ proto 的 MonthCardInfo 只有 goods_id/reward/can_claim，**没有持有/过期字段**，
    // 所以「infos 非空」不等于「持有月卡」——服务端对没买月卡的账号也会下发记录（can_claim=false）。
    // 判「是否持有月卡」只看：今天还能领（claimable）或是今天我们确实领到过（doneToday && ok）。
    const claimedToday = isDoneToday() && lastResult === 'ok';
    lastHasCard = claimable.length > 0 || claimedToday;

    if (!infos.length || !claimable.length) {
      // 没月卡 / 已过期 / 今日已领完：只记「今天查过」，**不标完成**
      markCheckedToday();
      lastResult = claimedToday ? 'ok' : 'none';
      log('月卡', infos.length ? '今日暂无可领取月卡礼包' : '当前没有月卡或已过期', {
        module: 'task', event: DAILY_KEY, result: lastResult,
        hasCard: lastHasCard,
      });
      return false;
    }

    let claimed = 0;
    for (const card of claimable) {
      try {
        const result = await claimMonthCardReward(Number(card.goods_id || 0));
        const items = Array.isArray(result && result.items) ? result.items : [];
        const summary = getRewardSummary(items);
        // ⚠️ 与 qqvip 同理：必须按「真的拿到物品」计数，不能因为没抛错就算成功
        // （服务端可能对无资格账号返回空 items，若计成功会让面板误显示「今日已完成」）
        if (items.length > 0) {
          claimed += 1;
          log('月卡', `领取成功 → ${summary}`,
            { module: 'task', event: DAILY_KEY, result: 'ok', goodsId: Number(card.goods_id || 0), count: items.length });
        } else {
          log('月卡', `领取返回为空，未计入成功 (gid=${Number(card.goods_id || 0)})`,
            { module: 'task', event: DAILY_KEY, result: 'none', goodsId: Number(card.goods_id || 0), count: 0 });
        }
      } catch (err) {
        log('月卡',
          `领取失败(gid=${Number(card.goods_id || 0)}): ${err.message}`,
          { module: 'task', event: DAILY_KEY, result: 'error', goodsId: Number(card.goods_id || 0) }
        );
      }
    }

    if (claimed > 0) {
      lastClaimAt = Date.now();
      lastHasCard = true;
      markDoneToday();
      lastResult = 'ok';
      return true;
    }

    log('月卡', '本次未成功领取月卡礼包', { module: 'task', event: DAILY_KEY, result: 'none' });
    markCheckedToday();
    lastResult = 'none';
    return false;
  } catch (err) {
    lastResult = 'error';
    log('月卡', `查询月卡礼包失败: ${err.message}`, {
      module: 'task', event: DAILY_KEY, result: 'error',
    });
    return false;
  }
}

module.exports = {
  performDailyMonthCardGift,
  getMonthCardDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
    lastClaimAt,
    result: lastResult,
    hasCard: lastHasCard,
    hasClaimable: lastHasClaimable,
  }),
};
