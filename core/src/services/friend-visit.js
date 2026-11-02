const { PlantPhase } = require('../config/config');
const { getPlantBlacklist, isAutomationOn, getAutomation } = require('../models/store');
const { getUserState } = require('../utils/network');
const { toNum, log, logWarn, randomDelay, sleep } = require('../utils/utils');
const { recordOperation, getOperationCount } = require('./stats');
const { notifyCrossAccountSteal } = require('./friend-alert');
const { sellAllFruits } = require('./warehouse');
const {
  enterFriendFarm,
  leaveFriendFarm,
  checkCanOperateRemote,
  handleFriendEnterError,
  SYSTEM_NPC_GIDS,
} = require('./friend-api');
const { analyzeFriendLands } = require('./friend-land-analyzer');
const { getCurrentPhase } = require('./farm-land-analyzer');
const {
  getRemainingTimes,
  getBadRemainingTimes,
  PUT_BUG_OPERATION_ID,
  PUT_WEED_OPERATION_ID,
  BAD_DAILY_LIMIT,
  canGetExpByCandidates,
  getCanGetHelpExp,
  setCanGetHelpExp,
  helpWater,
  helpWeed,
  helpInsecticide,
  helpFarming,
  stealHarvest,
  stealHarvestDetailed,
  putInsectsDetailed,
  putWeedsDetailed,
} = require('./friend-operation-limits');

// ===== Batch helper =====

/**
 * 偷取"没拿到东西"的节流记忆。
 *
 * 背景（2026-10-23 实测）：删掉 CheckCanOperate 预检查后，服务端在**对方收菜之前**会一直
 * 把作标记为 `plant.stealable=true`，但 Harvest 回包的 `land` 是空的（今天已偷过/等对方收菜）。
 * 若不节流，就会出现两种浪费：① 每轮巡查都白打一次 Harvest；② 每轮都刷一条 warning。
 * 这里按 (好友, 成熟土地快照) 记 10 分钟短时记忆：快照不变就跳过attempt，
 * 对方一收菜/换种，快照 key 变化立刻恢复尝试。
 */
const STEAL_NOOP_MEMORY_MS = 10 * 60 * 1000;
const stealNoopMemory = new Map(); // gid -> { key, at }
const stealNoopLogAt = new Map();  // gid -> at

function stealSnapshotKey(stealableInfo) {
  return (Array.isArray(stealableInfo) ? stealableInfo : [])
    .map(i => `${i.landId}:${i.plantId}`)
    .sort()
    .join(',');
}

function shouldSkipStealAttempt(gid, stealableInfo) {
  const key = stealSnapshotKey(stealableInfo);
  if (!key) return false;
  const prev = stealNoopMemory.get(gid);
  return !!prev && prev.key === key && Date.now() - prev.at < STEAL_NOOP_MEMORY_MS;
}

function rememberStealNoop(gid, stealableInfo) {
  stealNoopMemory.set(gid, { key: stealSnapshotKey(stealableInfo), at: Date.now() });
}

/** 偷不到时的节流日志：真实 RPC 错误 2 分钟一条 warn，"服务端没收下" 10 分钟一条 info */
function logStealNoop(gid, name, stealableCount, failDetails) {
  const now = Date.now();
  const last = stealNoopLogAt.get(gid) || 0;
  const hasError = failDetails.length > 0;
  const interval = hasError ? 2 * 60 * 1000 : STEAL_NOOP_MEMORY_MS;
  if (now - last < interval) return;
  stealNoopLogAt.set(gid, now);
  const reason = hasError
    ? failDetails.slice(0, 2).join(' | ').slice(0, 160)
    : '服务端未返回已收下的土地（今日已偷过该好友/等待对方收菜）';
  const payload = {
    module: 'friend', event: '偷取跳过',
    result: hasError ? 'error' : 'skipped',
    friendName: name || `GID:${gid}`, friendGid: toNum(gid),
    stealable: stealableCount,
  };
  if (hasError) logWarn('好友', `偷取 ${name || gid} 未生效（可偷 ${stealableCount} 块）: ${reason}`, payload);
  else log('好友', `${name || gid} 有 ${stealableCount} 块成熟作物暂无法收下：${reason}`, payload);
}

/**
 * Run an operation on multiple land IDs. Falls back to single-ID calls if batch fails.
 * Returns the number of successful operations.
 */
async function runBatchWithFallback(landIds, batchFn, singleFn) {
  const ids = Array.isArray(landIds) ? landIds.filter(Boolean) : [];
  if (ids.length === 0) return 0;

  try {
    await batchFn(ids);
    return ids.length;
  } catch (_) {
    // Fallback: one by one
    let ok = 0;
    for (const id of ids) {
      try {
        await singleFn([id]);
        ok++;
      } catch (_) {
        // Skip individual failures
      }
      await sleep(100);
    }
    return ok;
  }
}

// ===== One-key farming for friend farms =====

// 帮忙类型表：顺序即旧版执行顺序（草 → 虫 → 水）
//
// ⚠️ 关于 CheckCanOperate 预检查（2026-10-22 实测定案，已彻底移除该调用）：
// 上游老版 friend-visit.js 对帮忙传 0x2717/0x2715/0x2716 做预检查；实测对同一好友
// 传 0x2712(除草)/0x2713(除虫)/0x2715/0x2716 **全部返回 canOperate=false**，
// 而放行后一键务农**立即成功**（草3/虫6、草1 两次实测），CheckCanOperateRequest 也确实
// 只有 host_gid + operation_id（没有漏传参数）=> 该接口对「帮忙」类操作不可用。
// 拿它做硬拦截会 100% 误杀真实好友的帮忙；NPC 好友因走 skipPrecheck 跳过预检查而一直正常,
// 这正好解释了「NPC 一键务农好用、真实好友却提示没有可务农土地」。
// **上游最新版（main，已重写为 TS）的帮忙分支已完全不调用 CheckCanOperate，直接执行**，
// 与本实现一致；真正的「来晚一步」等拒绝由帮忙 RPC 自身返回错误兜底
// （runBatchWithFallback 已做「批量失败 → 逐块回退」）。
//
// 帮忙经验候选 ID：与上游最新版一致用 [10005, 10006, 10007] 做**整体**判断
// （任一还能拿经验就照帮），而非逐类型——更贴近「经验满也不影响帮忙」的实际表现。
const HELP_EXP_IDS = [0x2715, 0x2716, 0x2717];
const FRIEND_HELP_GROUPS = [
  { key: 'weed', listKey: 'needWeed', fn: helpWeed, name: '草', record: 'helpWeed' },
  { key: 'bug', listKey: 'needBug', fn: helpInsecticide, name: '虫', record: 'helpBug' },
  { key: 'water', listKey: 'needWater', fn: helpWater, name: '水', record: 'helpWater' },
];

/**
 * 对好友农场执行「一键务农」：浇水/除草/除虫一次搞定。
 *
 * 与游戏内一键务农按钮同源——优先走**合并的 Farming RPC**（host_gid=好友GID），
 * 一次请求代替原先的 WaterLand + WeedOut + Insecticide 三次请求（以及其间的随机延迟）。
 * 服务端不接受合并务农时，自动回退为旧的逐类型 RPC，行为不降级。
 *
 * **不做 CheckCanOperate 预检查**（上游在此处传了语义错误的操作 ID，且该接口对帮忙类
 * 操作实测恒返回 false；详见 FRIEND_HELP_GROUPS 上方注释）。真正的「来晚一步」等
 * 服务端拒绝由帮忙 RPC 自身返回错误兜底，行为不会降级。
 *
 * @param {object} opts
 * @param {boolean} [opts.expGateEnabled] 是否启用「帮忙经验闸」（任一帮忙类型还能拿经验就照帮，整体判断）
 * @param {boolean} [opts.checkExpLimit]  是否把经验上限校验下传给 RPC（调用后比对经验增长）
 * @param {boolean} [opts.ignoreExpGate]  强制忽略经验闸（护主犬好友：经验满也照帮）
 * @returns {{water:number, weed:number, bug:number, total:number, blocked:boolean, oneKey:boolean, reason:string}}
 *          oneKey=true 表示走了合并 Farming；false 表示走了逐类型回退。
 */
async function runFriendFarming(gid, analysis, opts = {}) {
  const {
    expGateEnabled = false,
    checkExpLimit = false,
    ignoreExpGate = false,
    skipPrecheck = null,
    onlyKeys = null,
  } = opts;
  // reason 区分 total=0 的真实原因，供面板给出准确提示：
  //  - no_target  好友农场确实没有草/虫/干旱（analysis 三个列表全空）
  //  - gated      有活，但全被闸门挡下（帮忙经验闸，或 NPC 预检查兜底）
  //  - all_failed 真的发了 RPC 但全部没成功（合并 + 逐类型回退都失败）
  const empty = (reason) => ({ water: 0, weed: 0, bug: 0, total: 0, blocked: false, oneKey: false, reason });

  const numericGid = toNum(gid);

  // 0) 先看好友农场到底有没有可帮的活
  const hasAnyTarget = FRIEND_HELP_GROUPS.some((group) => {
    const list = Array.isArray(analysis?.[group.listKey]) ? analysis[group.listKey] : [];
    return list.length > 0;
  });
  if (!hasAnyTarget)
    return empty('no_target');

  // 1) 逐类型收集目标 + 经验闸（与旧逻辑一致；不再做 CheckCanOperate 预检查，
  //    原因见 FRIEND_HELP_GROUPS 上方注释：该接口对帮忙类操作恒 false，做了只会误杀）
  // 经验闸为**整体**判断（与上游最新版一致）：任一帮忙类型还能拿经验就三样都照帮。
  const expAllowed = !expGateEnabled || ignoreExpGate || canGetExpByCandidates(HELP_EXP_IDS);
  const keyFilter = Array.isArray(onlyKeys) && onlyKeys.length > 0 ? new Set(onlyKeys) : null;
  const allowed = [];
  for (const group of FRIEND_HELP_GROUPS) {
    if (keyFilter && !keyFilter.has(group.key))
      continue;
    const list = Array.isArray(analysis?.[group.listKey]) ? analysis[group.listKey] : [];
    if (list.length === 0)
      continue;
    if (!expAllowed)
      continue;
    // 显式传入的兜底预检查（旧调用点对 NPC 农场用它跳过服务端检查）
    if (skipPrecheck && !skipPrecheck().canOperate)
      continue;
    allowed.push({ ...group, list });
  }

  if (allowed.length === 0)
    return empty('gated');

  const targets = [...new Set(allowed.flatMap(group => group.list))];
  if (targets.length === 0)
    return empty('no_target');

  // 2) 合并 Farming 一次打完
  try {
    await helpFarming(numericGid, targets, checkExpLimit);
    const counts = {
      water: 0,
      weed: 0,
      bug: 0,
      total: targets.length,
      blocked: false,
      oneKey: true,
      reason: '',
    };
    for (const group of allowed) {
      counts[group.key] = group.list.length;
    }
    return counts;
  }
  catch (err) {
    logWarn('好友', `一键务农(Farming)未被服务端接受，回退逐类型: ${err.message}`, {
      module: 'friend',
      event: '好友一键务农',
      result: 'error',
      friendGid: numericGid,
      context,
      error: err.message,
    });
  }

  // 3) 回退：逐类型 RPC（保留原有的批量+单条兜底）
  const counts = { water: 0, weed: 0, bug: 0, total: 0, blocked: false, oneKey: false, reason: '' };
  for (const group of allowed) {
    const ok = await runBatchWithFallback(
      group.list,
      ids => group.fn(numericGid, ids, checkExpLimit),
      id => group.fn(numericGid, id, checkExpLimit),
    );
    counts[group.key] = ok;
    counts.total += ok;
  }
  if (counts.total === 0)
    counts.reason = 'all_failed';
  return counts;
}

// ===== Single friend operation =====

/**
 * Perform a single operation on a friend's farm (steal/water/weed/bug/bad).
 * Handles entering/leaving the farm and error classification.
 */
async function doFriendOperation(gid, opType) {
  const numericGid = toNum(gid);
  if (!numericGid) {
    return { ok: false, message: '无效好友ID', opType };
  }

  // Enter friend's farm
  let enterReply;
  try {
    enterReply = await enterFriendFarm(numericGid);
  } catch (err) {
    const handled = handleFriendEnterError(numericGid, `GID:${numericGid}`, err);
    if (handled.handled && handled.kind === 'blacklist') {
      return { ok: true, opType, count: 0, message: '好友已自动加入黑名单' };
    }
    if (handled.handled && handled.kind === 'invalid_removed') {
      return { ok: true, opType, count: 0, message: '好友 GID 已失效，已自动移出已知列表' };
    }
    return { ok: false, message: `进入好友农场失败: ${err.message}`, opType };
  }

  try {
    const lands = enterReply.lands || [];
    const userState = getUserState();
    const plantBlacklist = getPlantBlacklist(userState.accountId);
    const analysis = analyzeFriendLands(lands, userState.gid, '', { plantBlacklist });

    let okCount = 0;

    // ---- Steal ----
    if (opType === 'steal') {
      if (!analysis.stealable.length) {
        return { ok: true, opType, count: 0, message: '没有可偷取土地' };
      }

      // ⭐ 2026-10-23：**删掉 CheckCanOperate(0x2714) 预检查**（同自动路径）。
      // 上游最新版无此预检查，直接打 Harvest；实测该接口会误判（罗辑宠物守护日志证实
      // 希恩斯从未偷到过罗辑，却每次被判"额度已用完"）。真正的拒绝由 Harvest 自身兜底。
      let okCount = 0;
      const failDetails = [];
      const batch = await stealHarvestDetailed(numericGid, analysis.stealable);
      okCount = batch.ok;
      if (okCount === 0 && batch.error) failDetails.push(batch.error);
      const remaining = analysis.stealable.filter(id => !batch.harvested.includes(id));
      for (const landId of remaining) {
        const r = await stealHarvestDetailed(numericGid, [landId]);
        if (r.ok > 0) okCount += r.ok;
        else if (r.error) failDetails.push(`#${landId}:${r.error}`);
        await randomDelay(150, 400);
      }

      if (okCount === 0) {
        logWarn('好友', `手动偷取 ${numericGid} 未生效（可偷 ${analysis.stealable.length} 块）: ${failDetails.slice(0, 2).join(' | ').slice(0, 160) || '服务端未返回已收下的土地'}`, {
          module: 'friend', event: '偷取未生效', result: 'error',
          friendGid: numericGid, stealable: analysis.stealable.length, manual: true,
        });
        return {
          ok: true, opType, count: 0,
          message: failDetails.length ? `偷取失败: ${failDetails[0].slice(0, 60)}` : '偷取未生效，可能来晚一步',
        };
      }

      recordOperation('steal', okCount);
      notifyCrossAccountSteal({
        myAccountId: userState.accountId,
        friendGid: numericGid,
        stolen: okCount,
      });

      try {
        await sellAllFruits();
      }
      catch (sellErr) {
        logWarn('仓库', `手动偷取后自动出售失败: ${sellErr.message}`, {
          module: 'warehouse',
          event: '偷菜后出售',
          result: 'error',
          mode: 'manual',
        });
      }

      return { ok: true, opType, count: okCount, message: `偷取完成 ${okCount} 块` };
    }

    // NPC（如官方人机号小果 10001）的 CheckCanOperate 预检查可能返回错误的 false，
    // 与偷菜一致：NPC 跳过预检查，直接执行操作，以服务器实际响应为准。
    const isNpc = SYSTEM_NPC_GIDS && SYSTEM_NPC_GIDS.has(numericGid);
    const skipPrecheck = isNpc ? () => ({ canOperate: true, canStealNum: 0 }) : null;

    // ---- 单类型帮忙（water/weed/bug）：与一键务农共用同一条 runFriendFarming 链路 ----
    // 前端已把三个按钮合并成「一键务农」，这里保留单类型入口只为兼容旧调用。
    // ⚠️ 旧实现各自带 CheckCanOperate 预检查（0x2717/0x2715/0x2716），实测该接口对帮忙类
    // 操作恒返回 false，会让单类型帮忙 100% 被误杀——所以统一走 runFriendFarming
    // （内部不做该预检查，真正的拒绝由帮忙 RPC 兜底）。见 FRIEND_HELP_GROUPS 上方注释。
    if (opType === 'water' || opType === 'weed' || opType === 'bug') {
      const listKey = opType === 'water' ? 'needWater' : opType === 'weed' ? 'needWeed' : 'needBug';
      if (!analysis[listKey].length) {
        const emptyMsg = opType === 'water' ? '没有可浇水土地' : opType === 'weed' ? '没有可除草土地' : '没有可除虫土地';
        return { ok: true, opType, count: 0, message: emptyMsg };
      }

      const result = await runFriendFarming(numericGid, analysis, {
        skipPrecheck,
        context: 'manual-single',
        onlyKeys: [opType],
      });
      if (result.total === 0) {
        return { ok: true, opType, count: 0, message: '帮忙未生效，可能来晚一步，可惜' };
      }
      // 只上报本次类型对应的计数
      if (result[opType] > 0) recordOperation({ water: 'helpWater', weed: 'helpWeed', bug: 'helpBug' }[opType], result[opType]);
      const label = { water: '浇水', weed: '除草', bug: '除虫' }[opType];
      return { ok: true, opType, count: result[opType], message: `${label}完成 ${result[opType]} 块` };
    }

    // ---- One-key farming (water + weed + bug in a single Farming RPC) ----
    if (opType === 'farming') {
      const result = await runFriendFarming(numericGid, analysis, {
        checkExpLimit: false,
        skipPrecheck,
        context: 'manual',
      });

      if (result.blocked) {
        return { ok: true, opType, count: 0, message: '务农失败，来晚一步，可惜' };
      }
      if (result.total === 0) {
        // 区分「真没活干」和「RPC 全失败」——不能都报"没有可务农土地"，
        // 否则用户明明看到好友有草/虫却提示没有，误以为分析器坏了（2026-10-22 用户反馈）。
        // 注：已不再用 CheckCanOperate 预检查拦截（该接口对帮忙操作恒 false，
        // 参考 FRIEND_HELP_GROUPS 上方注释），因此 total=0 只可能来自下面几种原因。
        const messages = {
          no_target: 'Ta 的农场暂时没有草、虫或干旱（列表徽标有延迟，可能刚被自动巡查或别人帮过）',
          gated: '本类型的帮忙已跳过（帮忙经验已拿满，或该好友被判定不可操作）',
          all_failed: '务农请求未生效，可能来晚一步，可惜',
        };
        return { ok: true, opType, count: 0, message: messages[result.reason] || '暂时没有可务农的土地' };
      }

      const parts = [];
      if (result.weed > 0) { parts.push(`草${result.weed}`); recordOperation('helpWeed', result.weed); }
      if (result.bug > 0) { parts.push(`虫${result.bug}`); recordOperation('helpBug', result.bug); }
      if (result.water > 0) { parts.push(`水${result.water}`); recordOperation('helpWater', result.water); }

      return {
        ok: true,
        opType,
        count: result.total,
        message: `一键务农完成 ${parts.join('/')}`,
      };
    }

    // ---- Bad (put weeds & insects) ----
    if (opType === 'bad') {
      let bugCount = 0;
      let weedCount = 0;

      if (!analysis.canPutBug.length && !analysis.canPutWeed.length) {
        return {
          ok: true,
          opType,
          count: 0,
          bugCount: 0,
          weedCount: 0,
          message: '没有可捣乱土地',
        };
      }

      let failedMsgs = [];

      // Put insects
      if (analysis.canPutBug.length && getBadRemainingTimes() > 0) {
        // NPC 跳过 CheckCanOperate 预检查（可能错误返回 false），直接放虫
        const canPutBug = skipPrecheck
          ? skipPrecheck()
          : await checkCanOperateRemote(numericGid, PUT_BUG_OPERATION_ID);
        const remainingBug = Math.min(
          getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = canPutBug.canOperate ? analysis.canPutBug.slice(0, remainingBug) : [];
        const result = targets.length > 0
          ? await putInsectsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        bugCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`)
        );
        if (bugCount > 0) recordOperation('putBug', bugCount);
      }

      // Put weeds
      if (analysis.canPutWeed.length && getBadRemainingTimes() > 0) {
        // NPC 跳过 CheckCanOperate 预检查（可能错误返回 false），直接放草
        const canPutWeed = skipPrecheck
          ? skipPrecheck()
          : await checkCanOperateRemote(numericGid, PUT_WEED_OPERATION_ID);
        const remainingWeed = Math.min(
          getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
          getBadRemainingTimes()
        );
        const targets = canPutWeed.canOperate ? analysis.canPutWeed.slice(0, remainingWeed) : [];
        const result = targets.length > 0
          ? await putWeedsDetailed(numericGid, targets)
          : { ok: 0, failed: [] };
        weedCount = result.ok;
        failedMsgs = failedMsgs.concat(
          (result.failed || []).map(f => `放草#${f.landId}:${f.reason}`)
        );
        if (weedCount > 0) recordOperation('putWeed', weedCount);
      }

      okCount = bugCount + weedCount;

      if (okCount <= 0) {
        const errSummary = failedMsgs.slice(-3).join(' | ');
        return {
          ok: true,
          opType,
          count: 0,
          bugCount,
          weedCount,
          message: errSummary ? `捣乱失败: ${errSummary}` : '捣乱失败或今日次数已用完',
        };
      }

      return {
        ok: true,
        opType,
        count: okCount,
        bugCount,
        weedCount,
        message: `捣乱完成 虫${bugCount}/草${weedCount}`,
      };
    }

    return { ok: false, opType, count: 0, message: '未知操作类型' };
  } catch (err) {
    return { ok: false, opType, count: 0, message: err.message || '操作失败' };
  } finally {
    try {
      await leaveFriendFarm(numericGid);
    } catch (_) {
      // Ignore leave errors
    }
  }
}

// ===== Full friend visit =====

/**
 * Visit a friend and perform all enabled operations (help + steal + bad).
 * Tracks per-operation counts in the `tally` object.
 * Returns: { acted, entered }
 */
async function visitFriend(friend, tally, myGid, accountId) {
  const { gid, name } = friend;
  let enterReply;

  // Enter friend's farm
  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }

  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];

  // NPC（如官方人机号小果 10001）的 CheckCanOperate 预检查可能错误返回 false，跳过预检查
  const npcGid = toNum(gid);
  const isNpcFriend = SYSTEM_NPC_GIDS && SYSTEM_NPC_GIDS.has(npcGid);
  const skipPrecheck = isNpcFriend ? () => ({ canOperate: true, canStealNum: 0 }) : null;

  // ---- Help (weed / bug / water) ----
  const helpEnabled = !!isAutomationOn('friend_help');
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');

  if (!expLimitEnabled) setCanGetHelpExp(true);

  if (helpEnabled) {
    // Skip help if exp limit is reached and we haven't been overridden
    if (!expLimitEnabled || getCanGetHelpExp()) {
      // 一键务农：浇水/除草/除虫合并为一次 Farming RPC（与游戏内一键务农按钮同源），
      // 服务端不接受时内部自动回退逐类型 RPC。
      const farmingResult = await runFriendFarming(gid, analysis, {
        expGateEnabled: expLimitEnabled,
        checkExpLimit: expLimitEnabled,
        skipPrecheck,
        context: 'auto',
      });

      if (farmingResult.total > 0) {
        const parts = [];
        if (farmingResult.weed > 0) {
          parts.push(`草${farmingResult.weed}`);
          tally.weed += farmingResult.weed;
          recordOperation('helpWeed', farmingResult.weed);
        }
        if (farmingResult.bug > 0) {
          parts.push(`虫${farmingResult.bug}`);
          tally.bug += farmingResult.bug;
          recordOperation('helpBug', farmingResult.bug);
        }
        if (farmingResult.water > 0) {
          parts.push(`水${farmingResult.water}`);
          tally.water += farmingResult.water;
          recordOperation('helpWater', farmingResult.water);
        }
        actionLogs.push(`一键务农${parts.join('/')}`);
        await randomDelay(500, 1000);
      }
    }
  }

  // ---- Steal ----
  if (isAutomationOn('friend_steal') && analysis.stealable.length > 0) {
    // ⭐ 2026-10-23：同 visitFriendForSteal —— 删掉 CheckCanOperate(0x2714) 预检查，
    // 直接打 Harvest 并以回包 land 为成功判据（上游最新版即此做法）。
    if (shouldSkipStealAttempt(gid, analysis.stealableInfo)) {
      // 同一批成熟土地刚试过且服务端没收下 → 跳过attempt，只留节流日志
      logStealNoop(gid, name, analysis.stealable.length, []);
    }
    else {
      let stolen = 0;
      const stolenNames = [];
      const failDetails = [];

      const batch = await stealHarvestDetailed(gid, analysis.stealable);
      if (batch.ok > 0) {
        stolen = batch.ok;
        for (const landId of batch.harvested) {
          const info = analysis.stealableInfo.find(s => s.landId === landId);
          if (info) stolenNames.push(info.name);
        }
      }
      else if (batch.error) {
        failDetails.push(batch.error);
      }

      const remaining = analysis.stealable.filter(id => !batch.harvested.includes(id));
      for (const landId of remaining) {
        const r = await stealHarvestDetailed(gid, [landId]);
        if (r.ok > 0) {
          stolen++;
          const info = analysis.stealableInfo.find(s => s.landId === landId);
          if (info) stolenNames.push(info.name);
        }
        else if (r.error) {
          failDetails.push(`#${landId}:${r.error}`);
        }
        await randomDelay(500, 1000);
      }

      if (stolen > 0) {
        stealNoopMemory.delete(gid);
        const namesStr = [...new Set(stolenNames)].join('/');
        actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
        tally.steal += stolen;
        recordOperation('steal', stolen);
        notifyCrossAccountSteal({ myAccountId: accountId, friendGid: gid, stolen, cropNames: stolenNames });
        await randomDelay(500, 1500);
      }
      else {
        rememberStealNoop(gid, analysis.stealableInfo);
        logStealNoop(gid, name, analysis.stealable.length, failDetails);
      }
    }
  }

  // ---- Bad (put weeds & insects) ----
  const badEnabled = isAutomationOn('friend_bad');
  let badCount = 0;
  let putBugCount = 0;
  let putWeedCount = 0;
  const badFailedMsgs = [];

  if (badEnabled) {
    const canPutBug = skipPrecheck
      ? skipPrecheck()
      : await checkCanOperateRemote(gid, PUT_BUG_OPERATION_ID);
    const canPutWeed = skipPrecheck
      ? skipPrecheck()
      : await checkCanOperateRemote(gid, PUT_WEED_OPERATION_ID);

    // Put insects
    if (analysis.canPutBug.length > 0 && canPutBug.canOperate && getBadRemainingTimes() > 0) {
      const remainingBug = Math.min(
        getRemainingTimes(PUT_BUG_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutBug.slice(0, remainingBug);
      const result = targets.length > 0
        ? await putInsectsDetailed(gid, targets)
        : { ok: 0, failed: [] };
      const okCount = result.ok || 0;
      badFailedMsgs.push(...(result.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放虫${okCount}`);
        tally.putBug += okCount;
        putBugCount += okCount;
        badCount += okCount;
        recordOperation('putBug', okCount);
      }
      await randomDelay(500, 1500);
    }

    // Put weeds
    if (analysis.canPutWeed.length > 0 && canPutWeed.canOperate && getBadRemainingTimes() > 0) {
      const remainingWeed = Math.min(
        getRemainingTimes(PUT_WEED_OPERATION_ID, BAD_DAILY_LIMIT),
        getBadRemainingTimes()
      );
      const targets = analysis.canPutWeed.slice(0, remainingWeed);
      const result = targets.length > 0
        ? await putWeedsDetailed(gid, targets)
        : { ok: 0, failed: [] };
      const okCount = result.ok || 0;
      badFailedMsgs.push(...(result.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
      if (okCount > 0) {
        actionLogs.push(`放草${okCount}`);
        tally.putWeed += okCount;
        putWeedCount += okCount;
        badCount += okCount;
        recordOperation('putWeed', okCount);
      }
      await randomDelay(500, 1500);
    }
  }

  // ---- 对好友使用鹊羽灵露（策略：先自用满每日 15 次，再对好友使用） ----
  // 本地 isQixiDewLimitReachedToday 标记仅在 bot 捕获到"每日上限"错误码时写入；
  // 手动在游戏里用完自用次数时该标记为空。因此在自用未满时先尝试自用一次：
  // useQixiDew 会用掉剩余自用次数并在达到上限后写入标记（手动已用完时首次尝试即
  // 收到每日上限错误，同样写入标记），确认自用已满后才对好友使用灵露。
  if (isAutomationOn('qixi_dew_use_on_friend')) {
    const activityDew = require('./activity');
    // 好友名单复用香囊的 qixi_friend_priority：名单非空时只对名单内好友使用灵露
    const dewPriority = (Array.isArray((getAutomation() || {}).qixi_friend_priority)
      ? (getAutomation() || {}).qixi_friend_priority.map(Number).filter(g => g > 0)
      : []);
    if (dewPriority.length > 0 && !dewPriority.includes(Number(gid))) {
      // 不在名单内：跳过灵露
    } else {
      // 自用是否已达上限：本地无标记时尝试一次自用，将剩余自用次数用尽并确认状态
      let selfLimitReached = activityDew.isQixiDewLimitReachedToday();
      if (!selfLimitReached) {
        try {
          const selfResult = await activityDew.useQixiDew();
          const selfUsed = Number(selfResult?.usedCount || 0);
          if (selfUsed > 0) {
            actionLogs.push(`灵露自用${selfUsed}`);
          }
          // 自用已达上限（标记写入），或已无可用的自用地块（自用无法再推进）→ 放行好友使用
          selfLimitReached = activityDew.isQixiDewLimitReachedToday()
            || selfResult?.reason === 'daily_limit'
            || selfResult?.reason === 'no_eligible_land';
        } catch (err) {
          // 自用尝试失败（活动不可用/网络错误），本轮不做好友灵露
          log('好友', `尝试自用灵露失败，跳过好友灵露: ${err.message}`);
        }
      }
      if (selfLimitReached) {
        // 灵露目标 = 好友生长中的已种植地块（灵露加速成熟，成熟后可偷），
        // 无生长中地块时回退到虫/草地（老逻辑）。
        const growing = Array.isArray(analysis.growing) ? analysis.growing : [];
        const planted = growing.length > 0
          ? growing
          : [...new Set([
              ...(Array.isArray(analysis.canPutWeed) ? analysis.canPutWeed : []),
              ...(Array.isArray(analysis.canPutBug) ? analysis.canPutBug : []),
              ...(Array.isArray(analysis.needWeed) ? analysis.needWeed : []),
              ...(Array.isArray(analysis.needBug) ? analysis.needBug : []),
            ])];
        // 每日对好友使用灵露上限（设置 qixi_dew_use_on_friend_limit，0 = 不限）
        const limit = Math.max(0, Number((getAutomation() || {}).qixi_dew_use_on_friend_limit) || 0);
        const remaining = limit > 0
          ? Math.max(0, limit - (getOperationCount('dewOnFriend') || 0))
          : planted.length;
        const targets = planted.slice(0, remaining);
        if (targets.length > 0) {
          try {
            const r = await activityDew.useQixiDewOnFriend(gid, targets);
            const used = Number(r && r.usedCount) || 0;
            if (used > 0) {
              actionLogs.push(`友灵露${used}`);
              tally.dewOnFriend = (tally.dewOnFriend || 0) + used;
              recordOperation('dewOnFriend', used);
            }
            if (r && Array.isArray(r.errors) && r.errors.length > 0) {
              log('好友', `对好友(${gid})使用灵露部分失败: ${r.errors.map(e => `#${e.landId}:${e.reason}`).join(', ')}`);
            }
          } catch (e) {
            log('好友', `对好友(${gid})使用灵露失败: ${e.message}`);
          }
          await randomDelay(400, 1000);
        }
      }
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '照顾好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return {
    acted: actionLogs.length > 0,
    entered: true,
    count: badCount,
    bugCount: putBugCount,
    weedCount: putWeedCount,
    message: badCount > 0
      ? `捣乱完成 虫${putBugCount}/草${putWeedCount}`
      : badFailedMsgs.slice(-3).join(' | '),
  };
}

// ===== Visit friend for steal only =====

/**
 * Visit a friend specifically to steal crops.
 */
async function visitFriendForSteal(friend, tally, myGid, accountId) {
  const { gid, name } = friend;
  let enterReply;

  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }

  const isNpc = SYSTEM_NPC_GIDS && SYSTEM_NPC_GIDS.has(gid);
  const plantBlacklist = getPlantBlacklist(accountId);
  const analysis = analyzeFriendLands(lands, myGid, name, { plantBlacklist });
  const actionLogs = [];

  // Check if any stealable land still has remaining steal slots for us
  const hasStealSlot = lands.some(land => {
    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) return false;
    const phase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!phase || phase.phase !== PlantPhase.MATURE) return false;
    if (!plant.stealable) return false;

    const stealPlayers = plant.steal_player;
    if (!stealPlayers || stealPlayers.length === 0) return true;

    const mySteal = stealPlayers.find(s => toNum(s.gid) === myGid);
    const myStealCount = mySteal ? toNum(mySteal.num) : 0;
    const maxSteal = toNum(plant.steal_num, 0);
    return myStealCount < maxSteal;
  });

  if (!hasStealSlot && analysis.stealable.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }

  // Steal
  if (analysis.stealable.length > 0) {
    // ⭐ 2026-10-23：**删掉 CheckCanOperate(0x2714) 预检查**（与昨天删掉帮忙类预检查同一理由）。
    // 上游最新版（liyangpengs/qq-farm-bot main，TS 重写）的偷取分支**完全没有这个预检查**，
    // 直接打 Harvest；而实测该预检查会误判——罗辑的宠物守护日志证实希恩斯从未偷到过罗辑，
    // 却每次返回 canOperate=false / canStealNum=0（"额度已用完"），真实好友被 100% 误杀。
    // 现在：批量 Harvest → 未拿全逐块补 → 全失败才打 warn 并汇总真实错误原因。
    if (shouldSkipStealAttempt(gid, analysis.stealableInfo)) {
      logStealNoop(gid, name, analysis.stealable.length, []);
      await leaveFriendFarm(gid);
      return { acted: false, entered: true };
    }

    let stolen = 0;
    const stolenNames = [];
    const failDetails = [];

    const batch = await stealHarvestDetailed(gid, analysis.stealable);
    if (batch.ok > 0) {
      stolen = batch.ok;
      for (const landId of batch.harvested) {
        const info = analysis.stealableInfo.find(s => s.landId === landId);
        if (info) stolenNames.push(info.name);
      }
    }
    else if (batch.error) {
      failDetails.push(batch.error);
    }

    const remaining = analysis.stealable.filter(id => !batch.harvested.includes(id));
    for (const landId of remaining) {
      const r = await stealHarvestDetailed(gid, [landId]);
      if (r.ok > 0) {
        stolen++;
        const info = analysis.stealableInfo.find(s => s.landId === landId);
        if (info) stolenNames.push(info.name);
      }
      else if (r.error) {
        failDetails.push(`#${landId}:${r.error}`);
      }
      await randomDelay(200, 600);
    }

    if (stolen > 0) {
      stealNoopMemory.delete(gid);
      const namesStr = [...new Set(stolenNames)].join('/');
      actionLogs.push(`偷${stolen}${namesStr ? `(${namesStr})` : ''}`);
      tally.steal += stolen;
      recordOperation('steal', stolen);
      notifyCrossAccountSteal({ myAccountId: accountId, friendGid: gid, stolen, cropNames: stolenNames });
      await randomDelay(500, 1000);
    }
    else {
      // 偷不到也必须留痕：这是"好友熟了却不偷"唯一的诊断入口
      rememberStealNoop(gid, analysis.stealableInfo);
      logStealNoop(gid, name, analysis.stealable.length, failDetails);
    }
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '偷好友菜',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return { acted: actionLogs.length > 0, entered: true };
}

// ===== Visit friend for help only =====

/**
 * Visit a friend specifically to help (water/weed/bug).
 * Honors experience limit. Guard dog friends bypass the limit.
 */
async function visitFriendForHelp(friend, tally, myGid, accountId, ignoreExpLimit = false, expLimitMode = false) {
  const { gid, name } = friend;
  const expLimitEnabled = !!isAutomationOn('friend_help_exp_limit');
  const checkExpLimit = expLimitEnabled && !ignoreExpLimit;
  const hasGuardDog = !!friend.hasGuardDog;

  if (!checkExpLimit) setCanGetHelpExp(true);

  // Skip if exp limit reached and no guard dog
  if (checkExpLimit && !getCanGetHelpExp() && !hasGuardDog) {
    return { acted: false, entered: false };
  }

  let enterReply;
  try {
    enterReply = await enterFriendFarm(gid);
  } catch (err) {
    const handled = handleFriendEnterError(gid, name, err);
    if (handled.handled) {
      return { acted: false, entered: false };
    }
    logWarn('好友', `进入 ${name} 农场失败: ${err.message}`, {
      module: 'friend',
      event: '进入农场',
      result: 'error',
      friendName: name,
      friendGid: gid,
    });
    return { acted: false, entered: false };
  }

  const lands = enterReply.lands || [];
  if (lands.length === 0) {
    await leaveFriendFarm(gid);
    return { acted: false, entered: true };
  }

  const analysis = analyzeFriendLands(lands, myGid, name, {});
  const actionLogs = [];

  // NPC（如官方人机号小果 10001）跳过 CheckCanOperate 预检查，直接操作
  const npcGid = toNum(gid);
  const isNpcFriend = SYSTEM_NPC_GIDS && SYSTEM_NPC_GIDS.has(npcGid);
  const skipPrecheck = isNpcFriend ? () => ({ canOperate: true, canStealNum: 0 }) : null;

  // 一键务农：浇水/除草/除虫合并为一次 Farming RPC（与游戏内一键务农按钮同源）。
  // 护主犬好友忽略经验闸（经验满也照帮），且不做经验增长校验。
  const farmingResult = await runFriendFarming(gid, analysis, {
    expGateEnabled: checkExpLimit,
    checkExpLimit: hasGuardDog ? false : checkExpLimit,
    ignoreExpGate: hasGuardDog,
    skipPrecheck,
    context: expLimitMode ? 'guard-dog' : 'help',
  });

  if (farmingResult.total > 0) {
    const parts = [];
    if (farmingResult.weed > 0) {
      parts.push(`草${farmingResult.weed}`);
      tally.weed += farmingResult.weed;
      recordOperation('helpWeed', farmingResult.weed);
      if (expLimitMode && hasGuardDog) {
        log('好友', `[护主犬好友] ✅ ${name}: 除草${farmingResult.weed}`, {
          module: 'friend',
          event: '护主犬好友帮助成功',
          friendName: name,
          operation: '草',
          count: farmingResult.weed,
        });
      }
    }
    if (farmingResult.bug > 0) {
      parts.push(`虫${farmingResult.bug}`);
      tally.bug += farmingResult.bug;
      recordOperation('helpBug', farmingResult.bug);
      if (expLimitMode && hasGuardDog) {
        log('好友', `[护主犬好友] ✅ ${name}: 除虫${farmingResult.bug}`, {
          module: 'friend',
          event: '护主犬好友帮助成功',
          friendName: name,
          operation: '虫',
          count: farmingResult.bug,
        });
      }
    }
    if (farmingResult.water > 0) {
      parts.push(`水${farmingResult.water}`);
      tally.water += farmingResult.water;
      recordOperation('helpWater', farmingResult.water);
      if (expLimitMode && hasGuardDog) {
        log('好友', `[护主犬好友] ✅ ${name}: 浇水${farmingResult.water}`, {
          module: 'friend',
          event: '护主犬好友帮助成功',
          friendName: name,
          operation: '水',
          count: farmingResult.water,
        });
      }
    }
    actionLogs.push(`一键务农${parts.join('/')}`);
    await randomDelay(300, 900);
  }

  if (actionLogs.length > 0) {
    log('好友', `${name}: ${actionLogs.join('/')}`, {
      module: 'friend',
      event: '帮助好友',
      result: 'ok',
      friendName: name,
      friendGid: gid,
      actions: actionLogs,
    });
  }

  await leaveFriendFarm(gid);
  return { acted: actionLogs.length > 0, entered: true };
}

// ===== Exports =====
module.exports = {
  runBatchWithFallback,
  doFriendOperation,
  visitFriend,
  visitFriendForSteal,
  visitFriendForHelp,
};
