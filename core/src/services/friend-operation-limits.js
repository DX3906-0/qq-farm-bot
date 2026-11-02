const { toNum, log, sleep } = require('../utils/utils');
const { getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { sendMsgAsync } = require('../utils/network');
const { toLong } = require('../utils/utils');
const { recordOperation: recordStatOp } = require('./stats');
const fs = require('fs');
const path = require('path');

// ===== Operation limits state =====
const operationLimits = new Map();
let lastResetDate = '';
let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
let localBadOperationCount = 0;
let currentBadAccountId = null;
let currentHelpExpAccountId = null;

const PUT_BUG_OPERATION_ID = 10005;
const PUT_WEED_OPERATION_ID = 10006;
const GOLDEN_BUG_OPERATION_ID = 10015;
const BAD_DAILY_LIMIT = 99;

// ===== Operation type names =====
const OP_NAMES = {
  '10001': '帮好友浇水',
  '10002': '帮好友除草',
  '10003': '帮好友除虫',
  '10004': '偷取好友作物',
  '10005': '给好友放虫',
  '10006': '给好友放草',
  '10007': '帮好友复活',
  '10008': '好友帮忙浇水',
  '10015': '给好友放黄金虫',
};

// ===== localBadOperationCount 持久化（跨 worker 重启保留每日捣乱预算）=====

function getTodayKey() {
  const { getServerTimeSec } = require('../utils/utils');
  const serverSec = getServerTimeSec();
  const serverMs = serverSec > 0 ? serverSec * 1000 : Date.now();
  const chinaDate = new Date(serverMs + 8 * 3600 * 1000);
  const y = chinaDate.getUTCFullYear();
  const m = String(chinaDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(chinaDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getBadCountPath(accountId) {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, 'bad-count', `${accountId}.json`);
}

function persistBadCount() {
  if (!currentBadAccountId) return;
  try {
    const fp = getBadCountPath(currentBadAccountId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ date: getTodayKey(), count: localBadOperationCount }));
  } catch { /* 持久化失败不影响运行 */ }
}

/**
 * worker 启动时调用：恢复今日已用捣乱预算。
 * 优先读自身持久化文件；若无今日记录，则用 stats 已放虫草之和兜底
 * （虫草共享 99 预算），避免重连/重启后预算归零导致叠加超放。
 */
function initLocalBadCount(accountId) {
  currentBadAccountId = accountId;
  if (!accountId) return;
  try {
    const data = JSON.parse(fs.readFileSync(getBadCountPath(accountId), 'utf-8'));
    if (data.date === getTodayKey() && typeof data.count === 'number') {
      localBadOperationCount = data.count;
      return;
    }
  } catch { /* 无持久化或格式错误，走兜底 */ }
  try {
    const stats = require('./stats');
    localBadOperationCount = (stats.getOperationCount('putBug') || 0)
      + (stats.getOperationCount('putWeed') || 0);
  } catch {
    localBadOperationCount = 0;
  }
  persistBadCount();
}

// ===== Daily reset =====

/**
 * Check if a new day has started (China timezone UTC+8) and reset limits.
 */
function checkDailyReset() {
  const { getServerTimeSec } = require('../utils/utils');
  const serverSec = getServerTimeSec();
  const serverMs = serverSec > 0
    ? serverSec * 1000
    : Date.now();

  // UTC+8 timezone offset: 8 hours in milliseconds
  const UTC_PLUS_8_OFFSET_MS = 8 * 3600 * 1000;
  const chinaDate = new Date(serverMs + UTC_PLUS_8_OFFSET_MS);
  const year = chinaDate.getUTCFullYear();
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(chinaDate.getUTCDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;

  if (lastResetDate !== today) {
    operationLimits.clear();
    canGetHelpExp = true;
    if (lastResetDate !== '') {
      log('系统', '跨日重置，清空操作限制缓存');
      localBadOperationCount = 0;
      persistBadCount();
      persistHelpExpLimit();
      if (helpAutoDisabledByLimit) {
        helpAutoDisabledByLimit = false;
        log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
          module: 'friend',
          event: '好友巡查循环',
          result: 'ok',
        });
      }
    }
    lastResetDate = today;
  }
}

/**
 * Disable help when daily experience limit is reached.
 * After this, only guard-dog (护主犬) friends will still be helped.
 */
function autoDisableHelpByExpLimit() {
  if (!canGetHelpExp) return;
  canGetHelpExp = false;
  helpAutoDisabledByLimit = true;
  persistHelpExpLimit();
  log('好友', '今日帮助经验已达上限，自动停止普通帮忙，开启仅帮助护主犬好友模式', {
    module: 'friend',
    event: '好友巡查循环',
    result: 'ok',
  });
}

// ===== Operation limits =====

/**
 * Update operation limits from server response (after each RPC call).
 */
function updateOperationLimits(limits) {
  if (!limits || limits.length === 0) return;
  checkDailyReset();
  for (const limit of limits) {
    const id = toNum(limit.id);
    if (id > 0) {
      operationLimits.set(id, {
        dayTimes: toNum(limit.day_times),
        dayTimesLimit: toNum(limit.day_times_lt),
        dayExpTimes: toNum(limit.day_exp_times),
        dayExpTimesLimit: toNum(limit.day_ex_times_lt),
      });
    }
  }
}

/**
 * Check if we can still gain experience from a specific operation.
 */
function canGetExp(operationId) {
  const limit = operationLimits.get(operationId);
  if (!limit) return true;
  // No experience limit set -> can get exp
  if (limit.dayExpTimesLimit <= 0) return true;
  return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * Check if we can gain experience from any of the given operation candidates.
 */
function canGetExpByCandidates(expIds = []) {
  const ids = Array.isArray(expIds) ? expIds : [expIds];
  for (const id of ids) {
    if (canGetExp(toNum(id))) return true;
  }
  return false;
}

/**
 * Check if an operation can still be performed (by operation count limit).
 */
function canOperate(operationId, fallbackLimit = 0) {
  const limit = operationLimits.get(operationId);
  const fallback = Math.max(0, Number(fallbackLimit) || 0);
  if (!limit) return true; // No limit known -> assume allowed
  const dayTimesLimit = limit.dayTimesLimit > 0 ? limit.dayTimesLimit : fallback;
  if (dayTimesLimit <= 0) return true; // No limit set
  return limit.dayTimes < dayTimesLimit;
}

/**
 * Get remaining times for an operation. Returns 999 if unlimited.
 */
function getRemainingTimes(operationId, fallbackLimit = 0) {
  const limit = operationLimits.get(operationId);
  const fallback = Math.max(0, Number(fallbackLimit) || 0);
  if (!limit) return fallback > 0 ? fallback : 999;
  const dayTimesLimit = limit.dayTimesLimit > 0 ? limit.dayTimesLimit : fallback;
  if (dayTimesLimit <= 0) return 999;
  return Math.max(0, dayTimesLimit - limit.dayTimes);
}

function getOperationDayTimes(operationId) {
  const limit = operationLimits.get(operationId);
  return limit ? Math.max(0, toNum(limit.dayTimes)) : 0;
}

function getBadOperationUsedCount() {
  // 放虫(10005)与放草(10006)共享每日 99 次"捣乱"预算（放一次虫或一次草都各消耗虫+草额度 1 点），
  // 用本地共享每日计数 localBadOperationCount 统计（已在 putInsectsDetailed/putWeedsDetailed 内按真实成功数累加）。
  return localBadOperationCount;
}

// 游戏每日虫(10005)/草(10006)共享 99 次"捣乱"预算：放一次虫或一次草，虫与草额度各减 1。
// 因此 bot 用本地共享每日计数 localBadOperationCount 统一计次（放虫与放草都累加 result.ok），
// 上限 BAD_DAILY_LIMIT=99，天然实现"放一次虫/草，虫草共同减少"的联动约束。
// 不依赖服务器回包的 operation_limits.day_times——实测其语义混乱（历史累计、虫草不相等），不可作为每日剩余判定。
function getBadRemainingTimes() {
  return Math.max(0, BAD_DAILY_LIMIT - localBadOperationCount);
}

function canOperateBad() {
  return getBadRemainingTimes() > 0;
}

function recordBadOperationSuccess(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n > 0) {
    localBadOperationCount += n;
    persistBadCount();
  }
}

/**
 * Get all operation limits as a key-value map with names.
 */
function getOperationLimits() {
  const result = {};
  const allIds = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10015];
  for (const id of allIds) {
    const limit = operationLimits.get(id);
    if (limit) {
      result[id] = {
        name: OP_NAMES[id] || `#${id}`,
        ...limit,
        remaining: getRemainingTimes(id),
      };
    }
  }
  return result;
}

// ===== Help exp limit state =====

// 「今日帮助经验已满」持久化（跨 worker 重启保留）。
// ⚠️ 不持久化的坑（2026-10-22 实测）：canGetHelpExp 是内存态，worker 重启后重置 true，
// 但服务端的「今日帮满」限制仍在 → 手动一键务农被服务端拒绝，而本地以为还能帮，
// 只能给用户笼统的"暂时帮不上"提示，无法告知真实原因（帮忙经验已达上限）。
function getHelpExpLimitPath(accountId) {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, 'help-exp-limit', `${accountId}.json`);
}

function persistHelpExpLimit() {
  if (!currentHelpExpAccountId) return;
  try {
    const fp = getHelpExpLimitPath(currentHelpExpAccountId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ date: getTodayKey(), exhausted: !canGetHelpExp }));
  } catch { /* 持久化失败不影响运行 */ }
}

/** worker 启动时调用：恢复今日「帮忙经验已满」状态（跨重启准确）。 */
function restoreHelpExpLimit(accountId) {
  currentHelpExpAccountId = accountId || null;
  if (!accountId) return;
  try {
    const data = JSON.parse(fs.readFileSync(getHelpExpLimitPath(accountId), 'utf-8'));
    if (data && data.date === getTodayKey() && data.exhausted === true) {
      canGetHelpExp = false;
      helpAutoDisabledByLimit = true;
      log('好友', '今日帮助经验已达上限（跨重启恢复），继续仅帮助护主犬好友模式', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
      });
    }
  } catch { /* 无持久化或跨日，默认还能帮 */ }
}

function getCanGetHelpExp() {
  return canGetHelpExp;
}

function setCanGetHelpExp(value) {
  canGetHelpExp = !!value;
  persistHelpExpLimit();
}

function getHelpAutoDisabledByLimit() {
  return helpAutoDisabledByLimit;
}

// ===== Friend operation RPC calls =====

/**
 * Help water a friend's lands.
 * If `checkExpLimit` is true, sleeps 200ms after the call and checks if exp increased
 * to determine if the help exp limit is reached.
 */
async function helpWater(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.WaterLandRequest.encode(
    types.WaterLandRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.plantpb.PlantService',
    'WaterLand',
    payload
  );
  const reply = types.WaterLandReply.decode(body);
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Help weed a friend's lands.
 */
async function helpWeed(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.WeedOutRequest.encode(
    types.WeedOutRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.plantpb.PlantService',
    'WeedOut',
    payload
  );
  const reply = types.WeedOutReply.decode(body);
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Help insecticide a friend's lands.
 */
async function helpInsecticide(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.InsecticideRequest.encode(
    types.InsecticideRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.plantpb.PlantService',
    'Insecticide',
    payload
  );
  const reply = types.InsecticideReply.decode(body);
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * 对好友农场执行「一键务农」：与游戏内一键务农按钮同源，单次 Farming RPC
 * 同时完成浇水/除草/除虫（host_gid 传好友 GID）。
 * 若 `checkExpLimit` 为 true，调用后 sleep 200ms 比对经验是否增长，
 * 以此判断帮助经验是否已达上限（与 helpWater/helpWeed/helpInsecticide 一致）。
 */
async function helpFarming(gid, landIds, checkExpLimit = false) {
  const expBefore = toNum((getUserState() || {}).exp);
  const payload = types.FarmingRequest.encode(
    types.FarmingRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.plantpb.PlantService',
    'Farming',
    payload
  );
  const reply = types.FarmingReply.decode(body);
  updateOperationLimits(reply.operation_limits);

  if (checkExpLimit) {
    await sleep(200);
    const expAfter = toNum((getUserState() || {}).exp);
    if (expAfter <= expBefore) autoDisableHelpByExpLimit();
  }

  return reply;
}

/**
 * Steal harvest from a friend's lands (bulk or single).
 */
async function stealHarvest(gid, landIds) {
  const payload = types.HarvestRequest.encode(
    types.HarvestRequest.create({
      land_ids: landIds,
      host_gid: toLong(gid),
      is_all: true,
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.plantpb.PlantService',
    'Harvest',
    payload
  );
  const reply = types.HarvestReply.decode(body);
  updateOperationLimits(reply.operation_limits);
  return reply;
}

/**
 * 偷取并**校验回包**：HarvestReply.land 会回带真正被收下的土地。
 *
 * ⚠️ 不能只靠"没抛异常"算成功（MEMORY.md 第 39 条反模式）：服务端拒绝时也可能正常返回、
 * 只是 land 为空。这里以"回包里的土地"为唯一成功判据，失败时带上真实错误信息，
 * 让上层能区分「来晚一步」/「今日额度用完」/「网络超时」。
 *
 * @returns {Promise<{ok:number, harvested:number[], error:string}>}
 */
async function stealHarvestDetailed(gid, landIds) {
  const ids = (Array.isArray(landIds) ? landIds : []).map(toNum).filter(id => id > 0);
  if (ids.length === 0) return { ok: 0, harvested: [], error: '' };
  try {
    const reply = await stealHarvest(gid, ids);
    const harvested = [...new Set((Array.isArray(reply && reply.land) ? reply.land : [])
      .map(land => toNum(land && land.id))
      .filter(id => id > 0))];
    return { ok: harvested.length, harvested, error: '' };
  } catch (err) {
    return { ok: 0, harvested: [], error: (err && err.message) ? err.message : String(err) };
  }
}

/**
 * Generic helper to put items (weeds/insects) on friend's lands one by one.
 * Returns the number of successful operations.
 */
async function putPlantItems(gid, landIds, RequestType, ReplyType, rpcMethod) {
  let ok = 0;
  const ids = Array.isArray(landIds) ? landIds : [];

  for (const landId of ids) {
    try {
      const payload = RequestType.encode(
        RequestType.create({
          land_ids: [toLong(landId)],
          host_gid: toLong(gid),
        })
      ).finish();
      const { body } = await sendMsgAsync(
        'gamepb.plantpb.PlantService',
        rpcMethod,
        payload
      );
      const reply = ReplyType.decode(body);
      updateOperationLimits(reply.operation_limits);
      ok++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : '未知错误';
      if (msg.includes('1001046')) {
        // Already done - silently skip
      } else {
        log('好友', `放虫/放草失败: landId=${landId}, 错误: ${msg}`, {
          module: 'friend',
          event: '放虫放草失败',
          landId,
          error: msg,
        });
      }
      await require('../utils/utils').randomDelay(500, 1500);
    }

    if (ok > 0) {
      await require('../utils/utils').randomDelay(500, 1000);
    }
  }

  return ok;
}

/**
 * Detailed version of putPlantItems that returns failure details.
 * Returns: { ok: number, failed: [{landId, reason}] }
 */
async function putPlantItemsDetailed(gid, landIds, RequestType, ReplyType, rpcMethod) {
  let ok = 0;
  const failed = [];
  const ids = Array.isArray(landIds) ? landIds : [];

  for (const landId of ids) {
    try {
      const payload = RequestType.encode(
        RequestType.create({
          land_ids: [toLong(landId)],
          host_gid: toLong(gid),
        })
      ).finish();
      const { body } = await sendMsgAsync(
        'gamepb.plantpb.PlantService',
        rpcMethod,
        payload
      );
      const reply = ReplyType.decode(body);
      updateOperationLimits(reply.operation_limits);
      ok++;
    } catch (err) {
      const msg = (err && err.message) ? err.message : '未知错误';
      failed.push({
        landId,
        reason: msg,
      });
      if (!msg.includes('1001046') && !msg.includes('1001039') && !msg.includes('已达上限')) {
        log('好友', `放虫/放草失败: landId=${landId}, 错误: ${msg}`, {
          module: 'friend',
          event: '放虫放草失败',
          landId,
          error: msg,
          detailed: true,
        });
      }
    }
    if (ok > 0) {
      await require('../utils/utils').randomDelay(500, 1000);
    }
  }

  return { ok, failed };
}

// ===== Specific put operations =====

async function putInsects(gid, landIds) {
  const ok = await putPlantItems(gid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
  recordBadOperationSuccess(ok);
  if (ok > 0) recordStatOp('putBug', ok);
  return ok;
}

async function putWeeds(gid, landIds) {
  const ok = await putPlantItems(gid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
  recordBadOperationSuccess(ok);
  if (ok > 0) recordStatOp('putWeed', ok);
  return ok;
}

async function putInsectsDetailed(gid, landIds) {
  const result = await putPlantItemsDetailed(gid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
  recordBadOperationSuccess(result.ok);
  return result;
}

async function putWeedsDetailed(gid, landIds) {
  const result = await putPlantItemsDetailed(gid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
  recordBadOperationSuccess(result.ok);
  return result;
}

// ===== Exports =====
module.exports = {
  OP_NAMES,
  PUT_BUG_OPERATION_ID,
  PUT_WEED_OPERATION_ID,
  GOLDEN_BUG_OPERATION_ID,
  BAD_DAILY_LIMIT,
  checkDailyReset,
  initLocalBadCount,
  autoDisableHelpByExpLimit,
  updateOperationLimits,
  canGetExp,
  canGetExpByCandidates,
  canOperate,
  canOperateBad,
  getRemainingTimes,
  getBadRemainingTimes,
  getOperationDayTimes,
  getOperationLimits,
  getCanGetHelpExp,
  setCanGetHelpExp,
  restoreHelpExpLimit,
  getHelpAutoDisabledByLimit,
  helpWater,
  helpWeed,
  helpInsecticide,
  helpFarming,
  stealHarvest,
  stealHarvestDetailed,
  putPlantItems,
  putPlantItemsDetailed,
  putInsects,
  putWeeds,
  putInsectsDetailed,
  putWeedsDetailed,
};
