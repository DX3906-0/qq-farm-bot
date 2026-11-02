const { CONFIG } = require('../config/config');
const {
  isAutomationOn,
  getAutomation,
  getFriendBlacklist,
  getFriendBadTargets,
  getAutoAcceptFriendMinLevel,
  getKnownFriendGids,
  applyConfigSnapshot,
  getFriendBadRetryDate,
  readFriendDogInfoCache,
  getFriendQuietHours,
  getStealPlans,
  setStealPlans,
} = require('../models/store');
const { getUserState, isConnected, networkEvents } = require('../utils/network');
const { toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { setOperationLimitsCallback } = require('./farm');
const { createScheduler } = require('./scheduler');
const {
  getAllFriends,
  extractReplyFriends,
  inFriendQuietHours,
  postToMaster,
  normalizeFriendGids,
  syncKnownFriendGidsFromFriends,
  acceptFriends,
  getApplications,
  clearAllInvalidKnownFriendGidCooldown,
  SYSTEM_NPC_FRIENDS,
  SYSTEM_NPC_GIDS,
} = require('./friend-api');
const {
  checkDailyReset,
  canOperate,
  canOperateBad,
  getCanGetHelpExp,
  getHelpAutoDisabledByLimit,
  updateOperationLimits,
} = require('./friend-operation-limits');
const {
  visitFriend,
  visitFriendForSteal,
  visitFriendForHelp,
} = require('./friend-visit');
const { buildFriendVisitPlan } = require('./friend-visit-plan');
const { selectFriendVisitBatch } = require('./friend-visit-pacing');
const { sellAllFruits } = require('./warehouse');
const {
  getFriendsList,
  fetchFriendsDogInfo,
  setFriendsListCache,
  getFriendsListCache,
} = require('./friend-land-analyzer');

// ===== State =====
let isCheckingFriends = false;
// 节流日志：把"静默跳过"变成"可诊断"。好友 tick 每 ~30s 一轮，
// 若不节流会把真错误淹掉（MEMORY.md 第 40 条：无事可做≠出错，但必须留一条可查痕迹）。
const skipLogAt = new Map();
function logSkipThrottled(key, msg, meta, intervalMs = 120000) {
  const now = Date.now();
  const last = skipLogAt.get(key) || 0;
  if (now - last < intervalMs) return;
  skipLogAt.set(key, now);
  log('好友', msg, meta);
}
let friendLoopRunning = false;
let externalSchedulerMode = false;
const friendScheduler = createScheduler('friend');
let badExecutedOnStartup = false;
let consecutiveBadFailureCount = 0;
let dogInfoBootstrapAttempted = false;
let dogInfoBootstrapReadyAt = 0;

const BAD_FAILURE_LIMIT = 3;

// ===== Helpers =====

function isTransientNetworkError(err) {
  const msg = String((err && err.message) || '');
  if (!msg) return false;
  return [
    '连接未打开',
    '请求超时',
    '请求已中断',
    '连接关闭',
    '发送失败',
    '请求队列已满',
  ].some(kw => msg.includes(kw));
}

function clearFriendsListCache() {
  setFriendsListCache(null);
}

async function bootstrapFriendDogInfoCacheIfNeeded() {
  if (dogInfoBootstrapAttempted) return;
  if (Date.now() < dogInfoBootstrapReadyAt) return;

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  if (!accountId) return;
  if (!isAutomationOn('friend', accountId) || !isConnected()) return;

  const dogInfoCache = readFriendDogInfoCache(accountId);
  if (dogInfoCache && Object.keys(dogInfoCache).length > 0) return;

  dogInfoBootstrapAttempted = true;
  try {
    log('好友', '护主犬缓存为空，上号稳定后自动获取一次好友狗信息', {
      module: 'friend',
      event: '自动获取好友狗信息',
      source: 'friend_loop_bootstrap',
    });
    await fetchFriendsDogInfo();
  } catch (err) {
    logWarn('好友', `自动获取好友狗信息失败: ${err.message}`);
  }
}

function syncAutomationPatchToMaster(patch) {
  postToMaster({
    type: 'automation_patch',
    patch,
  });
}

function resetBadFailureCount() {
  consecutiveBadFailureCount = 0;
}

function getLocalDateKey(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pauseFriendBadUntilTomorrow(reason) {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const retryDate = getLocalDateKey(1);
  // persist:false —— worker 侧不落盘（store.js 的进程守卫也会拦），只更新内存后上报主进程
  applyConfigSnapshot(
    { friendBadRetryDate: retryDate },
    { accountId, persist: false }
  );
  syncAutomationPatchToMaster({ friendBadRetryDate: retryDate });
  resetBadFailureCount();
  log('好友', `捣乱连续失败 ${BAD_FAILURE_LIMIT} 次，已暂停至 ${retryDate} 再尝试。最后错误: ${reason || '未知'}`, {
    module: 'friend',
    event: '自动暂停捣乱',
    result: 'paused',
    failureCount: BAD_FAILURE_LIMIT,
    retryDate,
    reason,
  });
}

function isFriendBadPaused() {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const retryDate = getFriendBadRetryDate(accountId);
  if (!retryDate) return false;
  if (getLocalDateKey() < retryDate) return true;

  applyConfigSnapshot({ friendBadRetryDate: '' }, { accountId });
  syncAutomationPatchToMaster({ friendBadRetryDate: '' });
  resetBadFailureCount();
  return false;
}

function recordBadFailure(reason, context = {}) {
  consecutiveBadFailureCount += 1;
  log('好友', `捣乱失败 ${consecutiveBadFailureCount}/${BAD_FAILURE_LIMIT}: ${reason || '未知错误'}`, {
    module: 'friend',
    event: '捣乱失败计数',
    result: 'error',
    failureCount: consecutiveBadFailureCount,
    failureLimit: BAD_FAILURE_LIMIT,
    reason,
    ...context,
  });

  if (consecutiveBadFailureCount >= BAD_FAILURE_LIMIT) {
    pauseFriendBadUntilTomorrow(reason);
    return true;
  }

  return false;
}

function isIgnorableBadFailureMessage(message) {
  const text = String(message || '');
  if (!text) return true;
  return [
    '??',
    'No target',
    '?????',
    '1001046',
    '1001039',
    'used up',
    'no target',
    '没有可捣乱土地',
    '捣乱失败或今日次数已用完',
    '今日次数已用完',
    '次数已用完',
    '已经放过',
    '来晚一步',
    '植物虫子数量已达上限',
    '植物杂草数量已达上限',
    '已达上限',
  ].some(kw => text.includes(kw));
}

function trackBadVisitResult(result, target, context = {}) {
  const count = Number(
    result && (
      result.count
      || (Number(result.bugCount || 0) + Number(result.weedCount || 0))
    ) || 0
  );
  if (count > 0) {
    resetBadFailureCount();
    return false;
  }

  const message = String(result && result.message || '').trim();
  if (isIgnorableBadFailureMessage(message)) return false;

  return recordBadFailure(message, {
    friendName: target && target.name,
    friendGid: target && target.gid,
    ...context,
  });
}

// ===== Main friend check routine =====

/**
 * 收集可捣乱好友候选：农场空闲（无可偷、无需浇水/除草/除虫）的好友。
 * badTargetSet 非空时仅保留指定好友（仅捣乱指定好友模式）。
 */
function collectBadCandidates(rawFriends, userGid, blacklist, badTargetSet) {
  const candidates = [];
  const visited = new Set();
  const candidateGids = new Set();

  for (const friend of rawFriends) {
    const gid = toNum(friend.gid);
    if (gid === userGid) continue;
    if (visited.has(gid)) continue;
    if (blacklist.has(gid)) continue;
    if (badTargetSet.size > 0 && !badTargetSet.has(gid)) continue;

    const name = friend.remark || friend.name || `GID:${gid}`;
    const plant = friend.plant;
    const stealNum = plant ? toNum(plant.steal_plant_num) : 0;
    const dryNum = plant ? toNum(plant.dry_num) : 0;
    const weedNum = plant ? toNum(plant.weed_num) : 0;
    const insectNum = plant ? toNum(plant.insect_num) : 0;

    // Target friends with empty farms (no crops, no issues)
    // NPC GID 的 plant 数据缺失（不在好友列表 API 中返回），始终加入捣乱候选，
    // 执行层（visitFriend）会按 canPutBug/canPutWeed 精确判断，放不了不会硬放。
    // 静默时段内仅豁免GID进入候选列表
    if ((stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0 && !inFriendQuietHours(gid))
      || SYSTEM_NPC_GIDS.has(gid)) {
      const level = toNum(friend.level);
      candidates.push({ gid, name, level });
      candidateGids.add(gid);
    }
    visited.add(gid);
  }

  // 将 badTargetSet 中不在候选中的 GID 也加入候选（如系统 NPC 小果 10001）；
  // 同时始终纳入所有系统 NPC 好友（它们常不在好友列表 API 返回中，但农场可放虫草）。
  // 使用 candidateGids 而非 visited，确保即使 NPC 在 rawFriends 中但 plant 数据非空，仍能被兜底添加。
  const extraGids = new Set(badTargetSet);
  for (const npc of SYSTEM_NPC_FRIENDS) extraGids.add(toNum(npc.gid));
  if (extraGids.size > 0) {
    for (const gid of extraGids) {
      if (candidateGids.has(gid)) continue;  // 已在候选中，跳过
      if (gid === userGid) continue;
      if (blacklist.has(gid)) continue;
      // 系统 NPC 使用预定义名称，否则显示 GID
      const npcInfo = SYSTEM_NPC_GIDS.has(gid)
        ? SYSTEM_NPC_FRIENDS.find(n => n.gid === gid)
        : null;
      candidates.push({
        gid,
        name: npcInfo ? npcInfo.name : `GID:${gid}`,
        level: npcInfo ? npcInfo.level : 1,
      });
      candidateGids.add(gid);
    }
  }

  return candidates;
}

/**
 * 执行到期的"预约偷取"计划。
 * 用户选择好友后设定延迟，bot 在该好友作物成熟后等待指定时长再偷取。
 * 在偷菜 tick 中调用；到期计划执行完毕后移除，并通过 automation_patch 同步到 master。
 */
async function runDueStealPlans() {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const userState = getUserState();
  if (!userState.gid || !isConnected()) return 0;

  const plans = getStealPlans(accountId);
  if (!Array.isArray(plans) || plans.length === 0) return 0;

  // 「仅偷取指定好友」白名单是**准入**（谁能被偷），预约偷取只是**排期**（什么时候偷），
  // 排期不能绕过准入。否则会出现"白名单只放了小果+希恩斯，小脆骨却因预约计划被偷"
  // （2026-10-24 用户反馈）。白名单为空数组 = 不限制，此时预约计划照常全量执行。
  const stealOnlyGids = new Set(
    (getAutomation(accountId)?.friend_steal_only_gids || [])
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
  );
  let effectivePlans = plans;
  if (stealOnlyGids.size > 0) {
    const blockedByWhitelist = plans.filter(p => !stealOnlyGids.has(Number(p.gid)));
    if (blockedByWhitelist.length > 0) {
      const blockedKey = `steal_plan_whitelist_${blockedByWhitelist.map(p => Number(p.gid)).sort((a, b) => a - b).join(',')}`;
      logSkipThrottled(blockedKey,
        `预约偷取有 ${blockedByWhitelist.length} 个好友不在「仅偷取指定好友」白名单内，已跳过: ${blockedByWhitelist.map(p => p.name || p.gid).join(', ')}`,
        {
          module: 'friend', event: '预约偷取白名单过滤', result: 'skipped',
          count: blockedByWhitelist.length,
          blockedGids: blockedByWhitelist.map(p => Number(p.gid)),
        },
        30 * 60 * 1000); // 这是长期存在的配置不匹配，30 分钟提示一次足够（白名单状态在面板设置里可见）
    }
    effectivePlans = plans.filter(p => stealOnlyGids.has(Number(p.gid)));
    if (effectivePlans.length === 0) return 0;
  }

  const now = Date.now();
  const due = effectivePlans.filter(p => Number(p.executeAt) > 0 && Number(p.executeAt) <= now);
  if (due.length === 0) return 0;

  const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
  const blacklist = new Set(getFriendBlacklist(accountId));
  // 「预约偷取」盯守策略：到点没偷到（作物还没熟 / 被补种 / 施肥提前成熟 / 成熟时间算偏）
  // 不再直接放弃，而是重新探测好友土地成熟时间后再排队，直到 expireAt 才结束。
  // 这样任何时候都能预约，不需要用户盯着。
  const STEAL_PLAN_RECHECK_MIN_MS = 10 * 60 * 1000;        // 探测不到成熟时间时的兜底间隔
  const STEAL_PLAN_RECHECK_MAX_MS = 2 * 60 * 60 * 1000;    // 单次等待上限
  const STEAL_PLAN_WATCH_MS = 24 * 60 * 60 * 1000;         // 未显式指定 expireAt 时的盯守时长
  const STEAL_PLAN_PROBE_MAX_TRIES = 20;                   // 超过后不再探测，只做保守等待

  /** 重新探测好友「最早成熟剩余秒数」，拿不到返回 -1 */
  const probeFriendMatureInSec = async (gid) => {
    let detailFn = null;
    for (const modPath of ['./friend', '../services/friend', './index']) {
      try {
        const mod = require(modPath);
        if (mod && typeof mod.getFriendLandsDetail === 'function') {
          detailFn = mod.getFriendLandsDetail;
          break;
        }
      } catch {
        /* 路径不存在，继续尝试下一个 */
      }
    }
    if (!detailFn) return -1;
    try {
      const detail = await detailFn(gid);
      const lands = (detail && detail.lands) || [];
      let minSec = -1;
      for (const land of lands) {
        const sec = Number(land && land.matureInSec);
        if (Number.isFinite(sec) && sec > 0 && (minSec < 0 || sec < minSec)) {
          minSec = sec;
        }
      }
      return minSec;
    } catch {
      return -1;
    }
  };

  /**
   * 为一个「到点未偷到」的一次性计划重新排期。
   * 返回 null = 已到盯守截止时间，计划应当结束。
   */
  const rearmMissedPlan = (plan, freshMatureInSec) => {
    const tried = Number(plan.triedTimes) || 0;
    const delayMs = Math.max(0, Number(plan.delaySeconds) || 0) * 1000;
    const createdAt = Number(plan.createdAt) || Date.now();
    const rawExpire = Number(plan.expireAt);
    const expireAt = rawExpire > 0 ? rawExpire : createdAt + STEAL_PLAN_WATCH_MS;

    let waitMs;
    if (Number.isFinite(freshMatureInSec) && freshMatureInSec > 0) {
      // 已知成熟倒计时 → 精确到点（成熟时间 + 用户设定的延迟）
      waitMs = freshMatureInSec * 1000 + delayMs;
    } else {
      // 未知（空地/接口异常）→ 随重试次数缓慢退避，避免高频访问好友农场触发风控
      const backoff = Math.min(6, 1 + Math.floor(tried / 3));
      waitMs = Math.max(delayMs, STEAL_PLAN_RECHECK_MIN_MS * backoff);
    }
    waitMs = Math.min(Math.max(waitMs, 30 * 1000), STEAL_PLAN_RECHECK_MAX_MS);

    const executeAt = Date.now() + waitMs;
    if (executeAt > expireAt) return null;
    return {
      ...plan,
      triedTimes: tried + 1,
      executeAt,
      expireAt,
    };
  };
  /**
   * 统一的「预约偷取排期」日志。
   * 每次为好友重新排定偷取时间时输出一条，让用户清楚看到：
   * 「谁的菜地大概什么时候熟 / 还有几分钟动手偷」。
   */
  const logStealSchedule = (plan, gid, nextExecuteAt, matureInSec) => {
    const waitMin = Math.max(1, Math.round((nextExecuteAt - Date.now()) / 60000));
    const knownMature = Number.isFinite(matureInSec) && matureInSec > 0;
    const matureTip = knownMature
      ? `，菜地约 ${Math.max(1, Math.round(matureInSec / 60))} 分钟后成熟`
      : '，菜地尚未成熟';
    // 未成熟时用「等待」措辞，成熟时才说「开始执行偷取」，避免误导刷屏
    const verb = knownMature ? '将' : '正等待';
    log('好友', `预约偷取：${plan.name || `GID:${gid}`}${matureTip}${verb}于 ${waitMin} 分钟后执行偷取`, {
      module: 'friend',
      event: '预约偷取排期',
      result: 'rearm',
      friendGid: gid,
      waitMinutes: waitMin,
      matureInSec: knownMature ? matureInSec : -1,
    });
  };

  let executed = 0;
  const doneGids = new Set();
  const keepPlans = [];

  // 循环（永久）偷取计划：保留计划，按「延迟秒数（至少 5 分钟）」作为循环间隔重新排期
  const rearmRecurringPlan = (plan) => {
    const intervalSec = Math.max(Number(plan.delaySeconds) || 0, 300);
    return {
      ...plan,
      triedTimes: 0,
      executeAt: Date.now() + intervalSec * 1000,
    };
  };

  for (const plan of plans) {
    const gid = Number(plan.gid);
    if (!gid) continue;
    // 白名单外的计划：**原样保留、不执行**。白名单是「谁能被偷」的准入，
    // 预约偷取只是「什么时候偷」的排期，排期不能绕过准入（2026-10-24 用户反馈）。
    if (stealOnlyGids.size > 0 && !stealOnlyGids.has(gid)) {
      keepPlans.push(plan);
      continue;
    }
    // 未到期的计划保留
    if (Number(plan.executeAt) > now) {
      keepPlans.push(plan);
      continue;
    }
    // 黑名单内的计划移除
    if (blacklist.has(gid)) continue;

    // 关键改动：不再"到期就真实访问好友农场投一次"。而是复用主巡查已维护的好友列表缓存
    // （checkFriends 的 getAllFriends 每轮低开销刷新，**不产生额外请求**）来预判该好友当前
    // 是否有可偷的菜（plant.steal_plant_num > 0）。只有缓存明确判到"确有可偷"才去 visit；
    // 缓存判"无可偷"(未熟/被偷空/空地) 时**根本不去触达好友农场**，直接从源头避免
    // 「未成熟时反复探测好友农场」的风控隐患。
    const friendsCache = getFriendsListCache() || [];
    const cachedFriend = friendsCache.find(f => toNum(f.gid) === gid);

    // 好友已从列表消失（被删/失效）→ 移除计划。否则每轮都会徒劳 visit 一个不存在的好友。
    if (friendsCache.length > 0 && !cachedFriend) {
      log('好友', `预约偷取：${plan.name || `GID:${gid}`} 已不在好友列表，移除该计划`, {
        module: 'friend',
        event: '预约偷取清理',
        result: 'removed',
        friendGid: gid,
      });
      continue; // 不入 keepPlans = 计划被移除
    }

    // ⚠️ 这里曾用「缓存里该好友的 steal_plant_num > 0」来决定要不要真去偷。实测定案
    // （2026-10-22）：该字段在真实环境**普遍为 0**（连一直能正常被偷的 NPC 小果也是 0），
    // 于是跳过条件恒成立 → **预约计划永远跳过 visit**，表现为「设了延迟偷取也从来偷不到」。
    // 现在改为：到点就真去访问，由 visitFriendForSteal 内部的实时分析
    // （analyzeFriendLands.stealable）判定；偷不到时按 (好友, 成熟土地快照) 记 10 分钟短时记忆，
    // 不会每轮空打 Harvest（CheckCanOperate(0x2714) 预检查已于 10-23 废除：实测对偷取也不可靠）。
    let stolenThisPlan = 0;
    try {
      const fakeTally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
      await visitFriendForSteal(
        { gid, name: plan.name || `GID:${gid}` },
        fakeTally,
        userState.gid,
        userState.accountId
      );
      stolenThisPlan = fakeTally.steal;
    } catch {
      // 单次失败不影响其他计划
    }
    tally.steal += stolenThisPlan;
    executed++;

    if (stolenThisPlan > 0) {
      // 偷到即完成；循环（永久）计划则重新排期，继续盯下一轮成熟
      if (plan.recurring) {
        // 刚偷到，下一轮从零起算；成熟时间未知，按循环间隔静默排期（不刷日志）
        keepPlans.push(rearmRecurringPlan(plan));
      } else {
        doneGids.add(gid);
      }
    } else {
      // 到点但未偷到（作物未熟/已被他人偷）
      if (plan.recurring) {
        // 循环（永久）计划：到期打不到（说明主巡查 cache 也判其无可偷）→ 纯指数退避 + 静默续盯。
        // 关键变化：不再在这里 probe 好友农场——那是真实访问，会让「还没熟/被人偷空」时频繁
        // 骚扰好友农场（既刷屏又风控风险）。这轮能否偷，完全由主巡查数据（visit 前的
        // getFriendCache / steal_plant_num 判定）决定；本分支只负责「等到下一轮到期再复查」。
        // 退避：10→20→40→80min，封顶 STEAL_PLAN_RECHECK_MAX_MS (2h)。访问被压到极低频，
        // 只有「主巡查发现又可偷（steal_plant_num>0）」才会真正触发 visit——这才符合
        // 「等主好友轮询侦察到菜熟了再动手」的预期，无风控隐患也不刷屏。
        const tried = Number(plan.triedTimes) || 0;
        const backoffMs = Math.min(
          STEAL_PLAN_RECHECK_MAX_MS,
          STEAL_PLAN_RECHECK_MIN_MS * Math.pow(2, Math.min(tried, 3))
        );
        const nextRecurring = {
          ...plan,
          triedTimes: tried + 1,
          executeAt: Date.now() + backoffMs,
        };
        keepPlans.push(nextRecurring);
        // 静默续盯：无提示价值，避免「菜地还没熟/偷不到」反复刷「预约偷取」日志。
      } else {
        // 一次性计划：有限重试，避免永久遗漏
        // 一次性计划：到点没偷到不再放弃，重新探测好友成熟时间后继续盯守，直到 expireAt。
        // 覆盖「作物还没熟 / 被补种 / 施肥提前成熟 / 成熟时间算偏」等所有情况。
        const freshMatureInSec = (Number(plan.triedTimes) || 0) < STEAL_PLAN_PROBE_MAX_TRIES
          ? await probeFriendMatureInSec(gid)
          : -1;
        const rearmed = rearmMissedPlan(plan, freshMatureInSec);
        if (rearmed) {
          keepPlans.push(rearmed);
          logStealSchedule(plan, gid, rearmed.executeAt, freshMatureInSec);
        } else {
          doneGids.add(gid);
          log('好友', `预约偷取：${plan.name || `GID:${gid}`} 盯守超时仍未偷到，结束计划`, {
            module: 'friend',
            event: '预约偷取结束',
            result: 'timeout',
            friendGid: gid,
          });
        }
      }
    }
    await randomDelay(400, 900);
  }

  // 移除已完成的计划，保留需重试/未到期的计划
  // ⚠️ lost-update 防护：worker 侧只更新自己内存（persist:false，store.js 另有进程守卫兜底），
  // 然后**始终**上报主进程落盘。原先「仅长度变化才上报」会让
  // executeAt 等字段的变更丢掉持久化。
  const next = keepPlans;
  setStealPlans(accountId, next, { persist: false });
  syncAutomationPatchToMaster({ stealPlans: next });

  // 仅在实际偷到菜时才记录汇总日志。循环（永久）计划在作物未成熟时每轮轮询都「共偷 0」，
  // 若每轮都打日志会刷屏，故 0 偷取时不输出；一次性计划连续未偷到会在放弃时单独记录。
  if (executed > 0 && tally.steal > 0) {
    log('好友', `预约偷取：执行 ${executed} 个到期计划，共偷 ${tally.steal}`, {
      module: 'friend',
      event: '预约偷取执行',
      result: 'ok',
      count: executed,
      stolen: tally.steal,
    });
  }
  return executed;
}

/**
 * Main friend check routine: visits friends to steal, help, and/or put weeds/bugs.
 * Called by the loop or triggered externally.
 */
async function checkFriends(options = {}) {
  const userState = getUserState();
  const accountId = process.env.FARM_ACCOUNT_ID || '';

  if (!isAutomationOn('friend', accountId)) {
    logSkipThrottled('friend_off', '好友自动化总开关关闭，本轮跳过', {
      module: 'friend', event: '好友巡查跳过', result: 'skipped', reason: 'friend_off',
    });
    return false;
  }
  if (!isConnected()) {
    logSkipThrottled('not_connected', '网关连接未就绪，好友巡查本轮跳过', {
      module: 'friend', event: '好友巡查跳过', result: 'skipped', reason: 'not_connected',
    });
    return false;
  }

  await bootstrapFriendDogInfoCacheIfNeeded();

  const helpEnabled = !!isAutomationOn('friend_help', accountId);
  const stealEnabled = !!isAutomationOn('friend_steal', accountId);
  const badEnabled = !!isAutomationOn('friend_bad', accountId);

  const onlyHelp = options.onlyHelp || false;
  const onlySteal = options.onlySteal || false;
  const onlyBad = options.onlyBad || false;
  const ignoreExpLimit = options.ignoreExpLimit || false;

  const doHelp = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
  const doSteal = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
  const doBad = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

  const shouldRun = doHelp || doSteal || doBad;

  if (isCheckingFriends || !userState.gid || !shouldRun) {
    const reason = isCheckingFriends ? 'lock_busy' : (!userState.gid ? 'no_gid' : 'nothing_enabled');
    logSkipThrottled(`early_${reason}`, `好友巡查提前返回（${reason}），本轮不访问`, {
      module: 'friend', event: '好友巡查跳过', result: 'skipped', reason,
    });
    return false;
  }

  isCheckingFriends = true;
  checkDailyReset();

  try {
    const allFriendsReply = await getAllFriends();
    const rawFriends = extractReplyFriends(allFriendsReply);

    if (rawFriends.length === 0) {
      log('好友', '没有好友', {
        module: 'friend',
        event: '好友扫描',
        result: 'empty',
      });
      return false;
    }

    const blacklist = new Set(getFriendBlacklist(accountId));
    const dogInfoCache = readFriendDogInfoCache(accountId);
    const guardDogGidSet = dogInfoCache
      ? new Set(Object.keys(dogInfoCache).map(Number))
      : new Set();
    const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit', accountId);
    const helpExpReached = expLimitEnabled && !getCanGetHelpExp();

    // 有"预约偷取"计划的好友：留给预约计划独占执行，主巡查循环跳过偷取，
    // 避免主循环先把菜偷光导致预约计划到点偷 0。
    const planGids = new Set(
      (getStealPlans(accountId) || [])
        .filter(p => Number(p.executeAt) > 0)
        .map(p => Number(p.gid))
    );

    // 「仅偷取指定好友」白名单：非空时只偷这些 gid（空数组 = 不限制）
    // 注意：白名单状态不要每轮打日志——偷取 tick 每 ~30s 一轮，会严重刷屏。
    // 白名单本身可在面板设置里看到；真正有价值的时机是「偷到了」，那由偷取成功日志体现。
    const stealOnlyGids = new Set(
      (getAutomation(accountId)?.friend_steal_only_gids || [])
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0)
    );

    // ---- Build target lists ----
    const stealTargets = [];
    const helpTargets = [];
    const visitedGids = new Set();

    // Steal targets: friends with stealable crops
    if (doSteal) {
      for (const friend of rawFriends) {
        const gid = toNum(friend.gid);
        if (gid === userState.gid) continue;
        if (visitedGids.has(gid)) continue;
        if (blacklist.has(gid)) continue;
        if (planGids.has(gid)) continue;
        // 白名单模式：不在名单内的好友不偷（注意 NPC 也受此限制，名单为空时才不限制）
        if (stealOnlyGids.size > 0 && !stealOnlyGids.has(gid)) continue;

        const name = friend.remark || friend.name || `GID:${gid}`;
        const plant = friend.plant;
        const stealNum = plant ? toNum(plant.steal_plant_num) : 0;
        const level = toNum(friend.level);

        // ⚠️ 不再用 `stealNum > 0` 做**硬准入**（2026-10-22 实测定案）：
        // 好友列表接口的 `steal_plant_num` 在真实环境**普遍为 0**——连一直能正常被偷的
        // NPC 小果也是 0（实测 14 个好友全 0）。拿它筛选 → 真实好友永远进不了偷取目标，
        // 只剩 NPC 因下面的 SYSTEM_NPC_GIDS 豁免被偷，表现为「只有小果的菜被偷」。
        // 现在改为：未被过滤的好友都进候选，进农场后由 analyzeFriendLands 的
        // `plant.stealable`（实时数据）做精确判定；访问密度交给 Pacing
        // （friend_visit_max_per_run + friend_visit_cooldown_min）控制。
        // stealNum 仅保留作**排序优先级**：有明确信号的先访问。
        if (!inFriendQuietHours(gid)) {
          stealTargets.push({ gid, name, stealNum, level });
        }
        else {
          logSkipThrottled(`quiet_${gid}`, `好友 ${name} 处于安静时段，本轮不访问`, {
            module: 'friend', event: '安静时段跳过', result: 'skipped', friendName: name, friendGid: gid,
          });
        }
        visitedGids.add(gid);
      }
    }

    // Help targets
    if (doHelp) {
      if (helpExpReached && guardDogGidSet.size > 0) {
        // Experience limit reached — only help guard dog friends
        for (const friend of rawFriends) {
          const gid = toNum(friend.gid);
          if (gid === userState.gid) continue;
          if (!guardDogGidSet.has(gid)) continue;
          if (blacklist.has(gid)) continue;

          const name = friend.remark || friend.name || `GID:${gid}`;
          const plant = friend.plant;
          const dryNum = plant ? toNum(plant.dry_num) : 0;
          const weedNum = plant ? toNum(plant.weed_num) : 0;
          const insectNum = plant ? toNum(plant.insect_num) : 0;

          // NPC GID 的 plant 数据缺失，始终加入帮助目标（静默时段内仅豁免GID进入）
          if ((dryNum > 0 || weedNum > 0 || insectNum > 0 || SYSTEM_NPC_GIDS.has(gid)) && !inFriendQuietHours(gid)) {
            helpTargets.push({
              gid,
              name,
              dryNum,
              weedNum,
              insectNum,
              dogId: 0x15FA5, // 90021
              hasGuardDog: true,
            });
          }
        }

        if (helpTargets.length > 0) {
          log('好友', `找到 ${helpTargets.length} 个需要帮助的护主犬好友`, {
            module: 'friend',
            event: '护主犬好友巡查',
            helpCount: helpTargets.length,
          });
        }
      } else {
        for (const friend of rawFriends) {
          const gid = toNum(friend.gid);
          if (gid === userState.gid) continue;
          if (blacklist.has(gid)) continue;

          const name = friend.remark || friend.name || `GID:${gid}`;
          const plant = friend.plant;
          const dryNum = plant ? toNum(plant.dry_num) : 0;
          const weedNum = plant ? toNum(plant.weed_num) : 0;
          const insectNum = plant ? toNum(plant.insect_num) : 0;

          // NPC GID 的 plant 数据缺失，始终加入帮助目标（静默时段内仅豁免GID进入）
          if ((dryNum > 0 || weedNum > 0 || insectNum > 0 || SYSTEM_NPC_GIDS.has(gid)) && !inFriendQuietHours(gid)) {
            const dogId = toNum(friend.dogId);
            const hasGuardDog = guardDogGidSet.has(gid) || dogId === 90021;
            helpTargets.push({
              gid,
              name,
              dryNum,
              weedNum,
              insectNum,
              dogId,
              hasGuardDog,
            });
          }
        }
      }
    }

    // Sort: steal 优先有明确偷取信号的，其次等级；help 按需求度（护主犬优先）
    stealTargets.sort((a, b) => (b.stealNum - a.stealNum) || (b.level - a.level));
    helpTargets.sort((a, b) => {
      if (a.hasGuardDog !== b.hasGuardDog) return a.hasGuardDog ? -1 : 1;
      const aTotal = a.dryNum + a.weedNum + a.insectNum;
      const bTotal = b.dryNum + b.weedNum + b.insectNum;
      return bTotal - aTotal;
    });

    // ---- Execute ----
    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };

    // ---- Pacing：降低请求密度（每轮最多访问 N 个好友，冷却期内不重复 + 游标轮转） ----
    // 目标：把"每轮全量刷一遍好友"改为"每轮挑一批没访问过的"，契合拟人化、降低风控风险。
    const automation = getAutomation() || {};
    const maxVisitsPerRun = Math.max(
      1,
      Math.min(Number(automation.friend_visit_max_per_run) || 12, 30)
    );
    const visitCooldownMs = Math.max(
      0,
      (Number(automation.friend_visit_cooldown_min) || 10) * 60 * 1000
    );
    const pacingOptions = { accountId, maxVisits: maxVisitsPerRun, cooldownMs: visitCooldownMs };

    // 合并访问：同一好友若同时"可偷 + 可帮"，只进一次农场，直接减半 Enter/Leave 请求。
    const combinedPlanRaw = doSteal && doHelp && !helpExpReached
      ? buildFriendVisitPlan({ stealTargets, helpTargets })
      : [];
    const combinedPlan = selectFriendVisitBatch(combinedPlanRaw, { ...pacingOptions, mode: 'combined' });

    if (combinedPlan.length > 0) {
      log('好友', `合并访问：候选 ${combinedPlanRaw.length} → 本轮 ${combinedPlan.length}`, {
        module: 'friend',
        event: '好友访问节流',
        mode: 'combined',
        candidates: combinedPlanRaw.length,
        planned: combinedPlan.length,
      });
      for (const target of combinedPlan) {
        try {
          await visitFriend(target, tally, userState.gid, userState.accountId);
        } catch {
          // Skip individual failures
        }
        await randomDelay(500, 1200);
      }
    } else {
      // Steal-only
      if (stealTargets.length > 0 && doSteal) {
        const visitBatch = selectFriendVisitBatch(stealTargets, { ...pacingOptions, mode: 'steal' });
        if (visitBatch.length < stealTargets.length) {
          log('好友', `偷取节流：候选 ${stealTargets.length} → 本轮 ${visitBatch.length}`, {
            module: 'friend',
            event: '好友访问节流',
            mode: 'steal',
            candidates: stealTargets.length,
            planned: visitBatch.length,
          });
        }
        for (const target of visitBatch) {
          if (!canOperate(0x2714)) break; // 10004 = steal
          try {
            await visitFriendForSteal(target, tally, userState.gid, userState.accountId);
          } catch {
            // Skip individual failures
          }
          await randomDelay(500, 1500);
        }
      }

      // Help-only
      if (helpTargets.length > 0 && doHelp) {
        const visitBatch = selectFriendVisitBatch(helpTargets, { ...pacingOptions, mode: 'help' });
        if (visitBatch.length < helpTargets.length) {
          log('好友', `帮助节流：候选 ${helpTargets.length} → 本轮 ${visitBatch.length}`, {
            module: 'friend',
            event: '好友访问节流',
            mode: 'help',
            candidates: helpTargets.length,
            planned: visitBatch.length,
          });
        }
        for (const target of visitBatch) {
          try {
            await visitFriendForHelp(
              target, tally, userState.gid, userState.accountId,
              ignoreExpLimit, helpExpReached
            );
          } catch {
            // Skip individual failures
          }
          await randomDelay(
            helpExpReached ? 300 : 500,
            helpExpReached ? 700 : 1000
          );
        }
      }
    }

    // Auto-sell after stealing
    if (tally.steal > 0) {
      try {
        await sellAllFruits();
      } catch {
        // Ignore sell errors
      }
    }

    // 放虫放草不再在好友主循环执行，改由 runBadHourly / runBadOnceOnStartup 驱动。

    // ---- Summary ----
    const summary = [];
    if (tally.steal > 0) summary.push(`偷${tally.steal}`);
    if (tally.weed > 0) summary.push(`除草${tally.weed}`);
    if (tally.bug > 0) summary.push(`除虫${tally.bug}`);
    if (tally.water > 0) summary.push(`浇水${tally.water}`);
    if (tally.putBug > 0) summary.push(`放虫${tally.putBug}`);
    if (tally.putWeed > 0) summary.push(`放草${tally.putWeed}`);

    const visited = stealTargets.length + helpTargets.length;
    if (summary.length > 0) {
      log('好友', `巡查完成 → ${summary.join('/')}`, {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
        visited,
        summary,
      });
    }

    return summary.length > 0;
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('好友', `巡查异常: ${err.message}`);
    }
    return false;
  } finally {
    isCheckingFriends = false;
  }
}

// ===== Friend check loop =====

async function friendCheckLoop() {
  if (externalSchedulerMode) return;
  if (!friendLoopRunning) return;

  await bootstrapFriendDogInfoCacheIfNeeded();

  await checkFriends();

  if (!friendLoopRunning) return;

  const interval = Math.max(30000, CONFIG.friendCheckInterval);
  friendScheduler.setTimeoutTask('friend_check_loop', interval, () => friendCheckLoop());
}

function startFriendCheckLoop(opts = {}) {
  if (friendLoopRunning) return;

  externalSchedulerMode = !!opts.externalScheduler;
  friendLoopRunning = true;
  dogInfoBootstrapAttempted = false;
  dogInfoBootstrapReadyAt = Date.now() + (2 * 60 * 1000);

  // Sync operation limits callback
  setOperationLimitsCallback(updateOperationLimits);

  // Listen for friend application events
  networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);
  networkEvents.on('friendAdded', onFriendAdded);

  if (!externalSchedulerMode) {
    // Start after a 2-minute delay
    const initialDelay = 2 * 60 * 1000;
    log('好友', '好友巡查循环将在 2 分钟后启动', {
      module: 'friend',
      event: '好友巡查延迟启动',
      delayMs: initialDelay,
    });
    friendScheduler.setTimeoutTask('friend_check_loop', initialDelay, () => friendCheckLoop());
  }

  // Bootstrap: periodically check for pending applications
  friendScheduler.setTimeoutTask(
    'friend_check_bootstrap_applications',
    30 * 1000,
    () => checkAndAcceptApplications()
  );
}

function stopFriendCheckLoop() {
  friendLoopRunning = false;
  externalSchedulerMode = false;
  dogInfoBootstrapAttempted = false;
  dogInfoBootstrapReadyAt = 0;
  clearAllInvalidKnownFriendGidCooldown();
  networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
  networkEvents.off('friendAdded', onFriendAdded);
  friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 0) {
  if (!friendLoopRunning || externalSchedulerMode) return;
  friendScheduler.setTimeoutTask(
    'friend_check_loop',
    Math.max(0, delayMs),
    () => friendCheckLoop()
  );
}

// ===== Friend application handling =====

/**
 * 好友添加成功推送：把新好友 GID 写入 knownFriendGids 并刷新好友列表缓存。
 * 好友列表接口（GetGameFriends）按已知 GID 拉取，不写进来前端就永远看不到新好友。
 */
function onFriendAdded(friends) {
  const list = Array.isArray(friends) ? friends : [];
  const gids = list.map(f => toNum(f && f.gid)).filter(g => g > 0);
  if (gids.length === 0) return;

  try {
    syncKnownFriendGidsFromFriends(list);
    clearFriendsListCache();
    log('好友', `检测到 ${gids.length} 个新好友，已加入同步列表`, {
      module: 'friend',
      event: '新好友加入列表',
      result: 'ok',
      addedCount: gids.length,
    });
  } catch (err) {
    logWarn('好友', `新好友加入列表失败: ${err.message}`);
  }
}

function onFriendApplicationReceived(applications) {
  const names = applications
    .map(app => app.name || `GID:${toNum(app.gid)}`)
    .join(', ');
  log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

  for (const app of applications) {
    log('申请',
      `申请详情: name=${app.name}, gid=${toNum(app.gid)}, level=${app.level}, levelType=${typeof app.level}`
    );
  }

  const minLevel = getAutoAcceptFriendMinLevel();
  let toAccept = applications;

  if (minLevel > 0) {
    toAccept = applications.filter(app => {
      const level = toNum(app.level) || 0;
      const name = app.name || `GID:${toNum(app.gid)}`;
      log('申请', `${name} 等级: ${level}, 最低要求: ${minLevel}级`);
      if (level >= minLevel) return true;
      log('申请', `${name} 等级 ${level} < ${minLevel}，跳过`);
      return false;
    });
  }

  if (toAccept.length === 0) return;

  const gids = toAccept.map(app => toNum(app.gid));
  acceptFriendsWithRetry(gids);
}

async function checkAndAcceptApplications() {
  try {
    const reply = await getApplications();
    const apps = reply.applications || [];
    if (apps.length === 0) return;

    const names = apps
      .map(app => app.name || `GID:${toNum(app.gid)}`)
      .join(', ');
    log('申请', `发现 ${apps.length} 个待处理申请: ${names}`);

    const minLevel = getAutoAcceptFriendMinLevel();
    let toAccept = apps;

    if (minLevel > 0) {
      toAccept = apps.filter(app => {
        const level = toNum(app.level) || 0;
        const name = app.name || `GID:${toNum(app.gid)}`;
        log('申请', `${name} 等级: ${level}, 最低要求: ${minLevel}级`);
        if (level >= minLevel) return true;
        log('申请', `${name} 等级 ${level} < ${minLevel}，跳过`);
        return false;
      });
    }

    if (toAccept.length === 0) return;

    const gids = toAccept.map(app => toNum(app.gid));
    await acceptFriendsWithRetry(gids);
  } catch {
    // Ignore application check errors
  }
}

async function acceptFriendsWithRetry(gids) {
  if (gids.length === 0) return;

  try {
    const reply = await acceptFriends(gids);
    const friends = reply.friends || [];

    if (friends.length > 0) {
      const names = friends
        .map(f => f.name || f.remark || `GID:${toNum(f.gid)}`)
        .join(', ');
      log('申请', `已同意 ${friends.length} 人: ${names}`);

      // Sync accepted GIDs to known friends list
      const newGids = friends
        .map(f => toNum(f.gid))
        .filter(g => g > 0);

      if (newGids.length > 0) {
        const currentGids = normalizeFriendGids(getKnownFriendGids());
        const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

        if (mergedGids.length !== currentGids.length) {
          const accountId = process.env.FARM_ACCOUNT_ID || '';
          applyConfigSnapshot(
            { knownFriendGids: mergedGids },
            { persist: false, accountId }
          );

          const synced = postToMaster({
            type: 'known_friend_gids_sync',
            gids: mergedGids,
          });

          if (!synced) {
            applyConfigSnapshot(
              { knownFriendGids: mergedGids },
              { persist: true, accountId }
            );
          }

          log('申请', `已将 ${newGids.length} 人加入好友列表`, {
            module: 'friend',
            event: '好友加入列表',
            result: 'ok',
          });
        }

        // Refresh friends list cache
        clearFriendsListCache();
        try {
          await getFriendsList(true);
          log('申请', '已刷新好友列表', {
            module: 'friend',
            event: '刷新好友列表',
            result: 'ok',
          });
        } catch (err) {
          logWarn('申请', `刷新好友列表失败: ${err.message}`);
        }
      }
    }
  } catch (err) {
    logWarn('申请', `同意失败: ${err.message}`);
  }
}

// ===== Bad on startup =====

/**
 * Run a one-time "bad" operation on startup to put weeds/insects on friends' farms.
 */
async function runBadOnceOnStartup(force = false) {
  if (!force && badExecutedOnStartup) return;

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const badEnabled = isAutomationOn('friend_bad', accountId);
  if (!badEnabled) return;
  if (isFriendBadPaused()) return;

  const userState = getUserState();
  if (!userState.gid) {
    log('好友', '用户未登录，无法执行放虫放草', {
      module: 'friend',
      event: '放虫放草未登录',
    });
    return;
  }

  const label = force ? '开启自动捣乱后立即执行' : '启动时放虫放草';

  log('好友', `========== ${label}开始 ==========`, {
    module: 'friend',
    event: `${label}开始`,
  });

  try {
    const allFriendsReply = await getAllFriends();
    const rawFriends = extractReplyFriends(allFriendsReply);

    if (rawFriends.length === 0) {
      log('好友', '没有好友，放虫放草结束', {
        module: 'friend',
        event: '没有游戏好友',
      });
      return;
    }

    const blacklist = new Set(getFriendBlacklist(accountId));
    const badTargetSet = new Set(getFriendBadTargets(accountId));
    const badCandidates = collectBadCandidates(rawFriends, userState.gid, blacklist, badTargetSet);

    badCandidates.sort((a, b) => b.level - a.level);

    const topCount = Math.min(20, badCandidates.length);
    const topTargets = badCandidates.slice(0, topCount);

    log('好友',
      `找到 ${badCandidates.length} 个可捣乱的好友${badTargetSet.size > 0 ? `（仅限指定 ${badTargetSet.size} 人）` : ''}，处理等级最高的前${topTargets.length}个`,
      {
        module: 'friend',
        event: '放虫放草好友列表',
        totalCount: badCandidates.length,
        topCount: topTargets.length,
      }
    );

    const tally = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
    let processedCount = 0;

    for (let i = 0; i < topTargets.length; i++) {
      const target = topTargets[i];
      if (!canOperateBad()) {
        log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, {
          module: 'friend',
          event: '放虫放草次数用完',
          processedCount,
        });
        break;
      }

      log('好友',
        `${label} ${i + 1}/${topTargets.length}: ${target.name} (等级${target.level})`,
        {
          module: 'friend',
          event: '处理好友',
          index: i + 1,
          total: topTargets.length,
          friendName: target.name,
          level: target.level,
        }
      );

      try {
        const result = await visitFriend(target, tally, userState.gid, accountId);
        processedCount++;
        if (trackBadVisitResult(result, target, { source: 'startup_bad' })) {
          break;
        }
      } catch (err) {
        log('好友', `放虫放草失败: ${target.name}, 错误: ${err.message}`, {
          module: 'friend',
          event: '放虫放草失败',
          friendName: target.name,
          error: err.message,
        });
        if (recordBadFailure(err && err.message, {
          friendName: target.name,
          friendGid: target.gid,
          source: 'startup_bad',
        })) {
          break;
        }
      }
      await randomDelay(500, 1500);
    }

    badExecutedOnStartup = true;

    const summary = [];
    if (tally.putBug > 0) summary.push(`放虫${tally.putBug}`);
    if (tally.putWeed > 0) summary.push(`放草${tally.putWeed}`);

    log('好友',
      `========== ${label}结束 ========== 处理${processedCount}人${ 
        summary.length > 0 ? ` → ${summary.join('/')}` : ''}`,
      {
        module: 'friend',
        event: `${label}结束`,
        processedCount,
        summary,
      }
    );
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('好友', `${label}异常: ${err.message}`);
    }
  }
}

// ===== Status queries =====

function isHelpExpLimitReached() {
  return getHelpAutoDisabledByLimit();
}

function isCheckingFriendsRunning() {
  return isCheckingFriends;
}

// ===== Sync friends from external GID list =====

async function syncFriendsFromGids(gids) {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const newGids = normalizeFriendGids(gids);
  if (newGids.length === 0) return [];

  const currentGids = normalizeFriendGids(getKnownFriendGids(accountId));
  const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

  if (mergedGids.length !== currentGids.length) {
    applyConfigSnapshot(
      { knownFriendGids: mergedGids },
      { persist: false, accountId }
    );

    const synced = postToMaster({
      type: 'known_friend_gids_sync',
      gids: mergedGids,
    });

    if (!synced) {
      applyConfigSnapshot(
        { knownFriendGids: mergedGids },
        { persist: true, accountId }
      );
    }

    log('好友',
      `批量添加 ${newGids.length} 个好友GID，当前共 ${mergedGids.length} 个`,
      {
        module: 'friend',
        event: '批量添加好友GID',
        result: 'ok',
        addedCount: newGids.length,
        totalKnownGids: mergedGids.length,
      }
    );
  }

  clearFriendsListCache();
  return await getFriendsList(true);
}

/**
 * 每小时定时放虫放草：次数用完则直接跳过，不进入 runBadOnceOnStartup（避免空跑刷日志）。
 */
async function runBadHourly() {
  if (!canOperateBad()) {
    log('好友', '每小时放虫放草：今日次数已用完，本次跳过', {
      module: 'friend',
      event: '每小时放虫放草跳过',
    });
    return;
  }
  try {
    await runBadOnceOnStartup(true);
  } catch (err) {
    log('好友', `每小时放虫放草失败: ${err && err.message}`, {
      module: 'friend',
      event: '每小时放虫放草失败',
      error: err && err.message,
    });
  }
}

// ===== Exports =====
module.exports = {
  checkFriends,
  runDueStealPlans,
  startFriendCheckLoop,
  stopFriendCheckLoop,
  refreshFriendCheckLoop,
  runBadOnceOnStartup,
  runBadHourly,
  isHelpExpLimitReached,
  isCheckingFriendsRunning,
  clearFriendsListCache,
  syncFriendsFromGids,
};
