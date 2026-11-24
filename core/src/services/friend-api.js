const protobuf = require('protobufjs/minimal');
const { parentPort } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const {
  getConfigSnapshot,
  applyConfigSnapshot,
  getFriendBlacklist,
  removeFriendFromCache,
} = require('../models/store');
const network = require('../utils/network');
const { sendMsgAsync, getUserState } = network;
const { AsyncLocalStorage } = require('node:async_hooks');
const { getRequestContext, runWithRequestContext, requestError, throwIfRequestCancelled } = require('../utils/request-priority');
const {
  acquireFriendVisitSession, releaseFriendVisitSession, markFriendVisitSessionUnknown,
  getFriendVisitSessionSnapshot, observeFriendVisitTransport, confirmFriendVisitSessionLeft,
  getLegacyFriendVisitRecoveryPlan, beginLegacyFriendVisitRecovery, finishLegacyFriendVisitRecovery,
} = require('./friend-visit-session');
const { runAccountOperation, validateOperationSession } = require('./account-operation-coordinator');
const { getCurrentOperation } = require('./account-operation-barrier');
const visitContext = new AsyncLocalStorage();

function getFriendTransportEpoch() {
  // 只采用网关公开的真实游戏代际；connectionEpoch/sessionEpoch可能只是IPC detach代际。
  const value = network.getDiagnosticSnapshot?.()?.remoteGeneration;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

function isFriendCleanupTransportCurrent(token) {
  if (token.operationSession) validateOperationSession(token.operationSession, { ignoreCancellation: true });
  const snapshot = network.getDiagnosticSnapshot?.();
  const accountId = String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '');
  return accountId === token.accountId && token.epoch != null
    && getFriendTransportEpoch() === token.epoch
    && snapshot.detached !== true && snapshot.loggedIn !== false && snapshot.connected === true;
}

function assertFriendVisitActive(gid = visitContext.getStore()?.token.gid) {
  const session = visitContext.getStore();
  if (!session || session.token.released || session.finalizing || !session.reply || session.token.gid !== toNum(gid)
    || session.token.accountId !== String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '')) {
    throw requestError('好友访问必须通过 withFriendVisitSession(gid, operation)', { errorCode: 'VISIT_SESSION_REQUIRED', stage: 'visit' });
  }
  if (session.token.operationSession) validateOperationSession(session.token.operationSession);
  const epoch = getFriendTransportEpoch();
  if (epoch != null && session.token.epoch != null && epoch !== session.token.epoch) {
    throw requestError('好友访问游戏连接代际已变化', { errorCode: 'VISIT_EPOCH_CHANGED', stage: 'visit' });
  }
  if (session.failure) throw session.failure;
  throwIfRequestCancelled(session.context);
  return session;
}

function isUncertainFriendVisitError(error) {
  if (error.resultState === 'unknown' || error.outcomeUnknown === true) return true;
  if (error.sent === false || error.resultState === 'not_sent') return false;
  // 仅可信服务端拒绝阶段是结算证据；decode/transport上的false标志不能确认写副作用。
  return !['remote', 'game_request'].includes(error.stage);
}

async function runFriendVisitOperation(gid, operation) {
  const session = assertFriendVisitActive(gid);
  const pending = Promise.resolve().then(() => {
    assertFriendVisitActive(gid);
    return operation();
  });
  session.pending.add(pending);
  let result;
  try {
    result = await pending;
  } catch (error) {
    session.failure ||= error;
    if (error !== session.context.signal?.reason && isUncertainFriendVisitError(error)) {
      session.uncertain = true;
    }
    throw error;
  } finally {
    session.pending.delete(pending);
  }
  assertFriendVisitActive(gid);
  return result;
}

async function withFriendVisitSession(gid, operation) {
  const numericGid = toNum(gid);
  if (!numericGid || typeof operation !== 'function') throw new TypeError('好友 GID 和访问操作无效');
  const inherited = visitContext.getStore();
  if (inherited) {
    const operationContext = getCurrentOperation();
    if (inherited.token.operationSession && operationContext?.descriptor?.name !== 'farm-friend-visit') {
      throw requestError('好友访问不能借用其他账号场景租约', { errorCode: 'ACCOUNT_OPERATION_SCOPE_CONFLICT', stage: 'visit' });
    }
    assertFriendVisitActive(numericGid);
    return runFriendVisitOperation(numericGid, () => operation(inherited.reply));
  }
  let resolveCaller;
  let rejectCaller;
  const caller = new Promise((resolve, reject) => { resolveCaller = resolve; rejectCaller = reject; });
  // 租约属于完整底层事务，而不是可取消的HTTP等待；唯一Leave结算前牧场只能排队。
  const holding = runAccountOperation('farm-friend-visit', async (operationSession) => {
    const transaction = await startFriendVisitTransaction(numericGid, operation, operationSession);
    Promise.race([transaction.processing, transaction.cancelled]).then(resolveCaller, rejectCaller);
    return transaction.processing;
  }, { sceneSensitive: true, exclusive: true, requirePersistentSceneReady: true,
    timeoutMs: 120000, priority: getRequestContext().priority || 'friend' });
  holding.catch(rejectCaller);
  return caller;
}

async function startFriendVisitTransaction(numericGid, operation, operationSession) {
  const context = getRequestContext();
  const accountId = String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '');
  const token = await acquireFriendVisitSession(numericGid, {
    accountId, epoch: getFriendTransportEpoch(), signal: context.signal, deadline: context.deadline,
  });
  token.operationSession = operationSession;
  // HostType只取服务端好友列表，未知沿用官方REAL=0；同次Enter/Leave固定同值。
  token.hostType = friendHostTypes.get(`${accountId}:${numericGid}`) ?? 0;
  token.reason = 2;
  const controller = new AbortController();
  const sessionContext = { ...context, signal: controller.signal, deadline: token.deadline };
  const session = { token, context: sessionContext, reply: null, failure: null, uncertain: false, pending: new Set(), finalizing: false };
  const abort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) abort();
  let rejectCaller;
  const cancelled = new Promise((_, reject) => { rejectCaller = reject; });
  const onAbort = () => {
    const originalReason = controller.signal.reason;
    const reason = originalReason?.resultState !== undefined ? originalReason
      : requestError(originalReason?.message || '好友访问已取消', {
        errorCode: 'VISIT_CANCELLED', stage: 'visit', resultState: 'unknown', processing: true, cause: originalReason,
      });
    markFriendVisitSessionUnknown(token, reason);
    reportUnknownVisit(reason, token);
    rejectCaller(reason);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(requestError('好友访问事务超时，底层仍执行时保持互斥', {
    errorCode: 'VISIT_TIMEOUT', stage: 'visit', resultState: 'unknown', processing: true, holdUntilTransportEpochChanged: true,
  })), Math.max(0, token.deadline - Date.now()));
  const processing = visitContext.run(session, () => runWithRequestContext(sessionContext, async () => {
    let entered = false;
    let error;
    try {
      throwIfRequestCancelled(session.context);
      if (token.operationSession) validateOperationSession(token.operationSession);
      const epoch = getFriendTransportEpoch();
      if (epoch != null && token.epoch != null && epoch !== token.epoch) {
        throw requestError('排队后好友访问游戏代际已变化', { errorCode: 'VISIT_EPOCH_CHANGED', stage: 'visit', sent: false });
      }
      try {
        session.reply = await enterFriendFarmRpc(numericGid);
        entered = true;
      } catch (enterError) {
        enterError.visitStage = 'enter';
        enterError.friendEnterHandling ||= handleFriendEnterError(numericGid, '', enterError);
        if (!session.entered && isUncertainFriendVisitError(enterError)) session.uncertain = true;
        throw enterError;
      }
      assertFriendVisitActive(numericGid);
      const result = await operation(session.reply);
      assertFriendVisitActive(numericGid);
      return result;
    } catch (caught) {
      error = caught;
      if (caught !== controller.signal.reason && (caught.resultState === 'unknown' || caught.outcomeUnknown === true)) session.uncertain = true;
      throw caught;
    } finally {
      session.finalizing = true;
      await Promise.allSettled([...session.pending]);
      entered ||= session.entered === true;
      try {
        if (entered && !session.uncertain && isFriendCleanupTransportCurrent(token)) {
          // 已确认 Enter 后必须独立清理；页面取消不会取消 Leave，且只发送一次。
          const cleanupDeadline = Date.now() + 30000;
          await runWithRequestContext({ signal: undefined, deadline: cleanupDeadline }, () => leaveFriendFarmRpc(numericGid));
          confirmFriendVisitSessionLeft(token);
        } else if (entered || session.uncertain) {
          const unknownError = error || session.failure || requestError('访问连接状态不可确认', { resultState: 'unknown', stage: 'visit' });
          markFriendVisitSessionUnknown(token, unknownError);
          reportUnknownVisit(unknownError, token);
          if (!error) throw unknownError;
        } else {
          confirmFriendVisitSessionLeft(token, 'not_entered');
        }
      } catch (leaveError) {
        leaveError.visitStage = 'leave';
        markFriendVisitSessionUnknown(token, leaveError);
        reportUnknownVisit(leaveError, token);
        if (error) {
          error.leaveError = leaveError;
          error.holdUntilTransportEpochChanged = true;
        } else throw leaveError;
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onAbort);
        token.settled = true;
        releaseFriendVisitSession(token);
      }
    }
  }));
  return { processing, cancelled };
}

async function recoverLegacyFriendVisit(options = {}) {
  if (options.dryRun !== false) return recoverLegacyFriendVisitTransaction(options);
  return runAccountOperation('farm-friend-visit', operationSession =>
    recoverLegacyFriendVisitTransaction(options, operationSession), {
    sceneSensitive: true, exclusive: true,
    timeoutMs: 60000, priority: 'foreground',
  });
}

async function recoverLegacyFriendVisitTransaction(options, operationSession = null) {
  const accountId = String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '');
  const epoch = getFriendTransportEpoch();
  const snapshot = network.getDiagnosticSnapshot?.() || {};
  throwIfRequestCancelled(getRequestContext());
  if (snapshot.connected !== true || snapshot.detached === true || snapshot.loggedIn === false || snapshot.quiescing === true
    || Number(snapshot.pending || 0) > 0 || Number(snapshot.pendingWrites || 0) > 0 || Number(snapshot.queue?.queued || 0) > 0) {
    throw requestError('游戏连接或在途写不满足旧场景恢复条件', { errorCode: 'VISIT_RECOVERY_TRANSPORT_BUSY', stage: 'visit' });
  }
  const plan = getLegacyFriendVisitRecoveryPlan(accountId, epoch);
  if (plan.eligible && plan.ownerGid !== toNum(getUserState()?.gid)) {
    throw requestError('恢复证据的游戏用户不匹配', { errorCode: 'VISIT_RECOVERY_OWNER_MISMATCH', stage: 'visit' });
  }
  if (options.dryRun !== false || !plan.eligible) return { ...plan, dryRun: true, gameRpcSent: false };
  if (visitContext.getStore()) throw requestError('不能在访友事务中恢复旧场景', { errorCode: 'VISIT_RECOVERY_BUSY', stage: 'visit' });
  const token = beginLegacyFriendVisitRecovery(accountId, epoch, options);
  if (!token) return { skipped: true, reason: 'already_left', gameRpcSent: false };
  token.operationSession = operationSession;
  try {
    if (!isFriendCleanupTransportCurrent(token)) throw requestError('恢复前真实游戏代际变化，未发送Leave', {
      errorCode: 'VISIT_EPOCH_CHANGED', stage: 'visit', sent: false,
    });
    // 只补完证据中尚未发送的唯一Leave，绝不重放Enter/Harvest；HTTP取消不打断已发清理。
    await runWithRequestContext({ signal: undefined, deadline: token.deadline }, () => leaveFriendFarmRpc(token.gid, token.hostType));
    if (!isFriendCleanupTransportCurrent(token)) throw requestError('Leave确认时真实游戏代际变化，保留未知', {
      errorCode: 'VISIT_EPOCH_CHANGED', stage: 'visit', resultState: 'unknown',
    });
    finishLegacyFriendVisitRecovery(token);
    return { recovered: true, accountId, gid: token.gid, epoch, proof: 'leave_confirmed',
      leaveSentOnce: true, enterSent: false };
  } catch (error) {
    error.visitStage = 'leave';
    finishLegacyFriendVisitRecovery(token, error);
    throw error;
  }
}

async function enterFriendFarm(gid) {
  const reply = await Promise.resolve(assertFriendVisitActive(gid).reply);
  assertFriendVisitActive(gid);
  return reply;
}

async function leaveFriendFarm(gid) {
  // 访问入口的 finally 是 Leave 唯一所有者，子调用不能提前退出会话。
  assertFriendVisitActive(gid);
  await Promise.resolve();
  assertFriendVisitActive(gid);
}

const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
function reportUnknownVisit(error, token) {
  error.holdUntilTransportEpochChanged = true;
  logWarn('好友', `好友访问状态未知，暂停后续访问: ${error.message}`, {
    module: 'friend', event: 'visit_state_unknown', result: 'unknown', friendGid: token.gid,
    transportEpoch: token.epoch, errorCode: error.errorCode, holdUntilTransportEpochChanged: true,
    stage: error.stage, visitStage: error.visitStage, sent: error.sent, outcomeUnknown: error.outcomeUnknown,
  });
}
const { getInteractRecords } = require('./interact');

// ===== Constants =====
const QQ_FRIEND_LIST_BATCH_SIZE = 35;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// 系统 NPC 好友（官方人机号），始终在好友列表中可用
const SYSTEM_NPC_FRIENDS = [
  { gid: 10001, name: '小果', remark: '小果', level: 1 },
];
const SYSTEM_NPC_GIDS = new Set(SYSTEM_NPC_FRIENDS.map(f => f.gid));
const friendHostTypes = new Map();

// ===== Dog names mapping =====
// ⚠️ 这只是**兜底小表**。狗名以游戏配置（ItemInfo，type=8 为宠物）为准——
// 该表曾缺 90031（比熊犬），导致养比熊犬的好友被显示成「无狗」（2026-10-22 实测）。
const DOG_NAMES = {
  '90001': '田园犬',
  '90002': '牧羊犬',
  '90003': '斑点狗',
  '90011': '柯基',
  '90021': '护主犬',
  '90031': '比熊犬',
};

// ===== State =====
let hasInitializedFromVisitors = false;
// 访客 GID 同步节流：普通调用受此间隔限制，显式刷新（force）可绕过。
// 参考上游 `syncKnownFriendGidsFromRecentVisitors` 的 10 分钟节奏。
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS = 2 * 60 * 1000;
let lastVisitorGidSyncAt = 0;
// QQ（尤其 NapCat 扫码）登录后仅引导同步一次好友 GID
let hasBootstrappedQqFriendGids = false;
const invalidKnownFriendGidCooldownUntil = new Map();
const removedGidsByAccount = new Map();
const observedGidsByAccount = new Map();
let visitorSyncFlight = null;
const allFriendsFlights = new Map();
const friendMutationGeneration = new Map();

function getFriendMutationGeneration(accountId = process.env.FARM_ACCOUNT_ID || '') {
  getCurrentKnownGids(accountId);
  return friendMutationGeneration.get(accountId) || 0;
}

function noteFriendGidDeleted(gid, accountId = process.env.FARM_ACCOUNT_ID || '') {
  getCurrentKnownGids(accountId);
  removedGidsByAccount.get(accountId).add(toNum(gid));
  friendMutationGeneration.set(accountId, (friendMutationGeneration.get(accountId) || 0) + 1);
}

function sameFriendGids(left, right) {
  return left.length === right.length && left.every((gid, index) => gid === right[index]);
}

function getCurrentKnownGids(accountId = process.env.FARM_ACCOUNT_ID || '') {
  const current = normalizeFriendGids(getConfigSnapshot(accountId).knownFriendGids);
  const previous = observedGidsByAccount.get(accountId) || current;
  const removed = removedGidsByAccount.get(accountId) || new Set();
  if (!sameFriendGids(previous, current)) {
    friendMutationGeneration.set(accountId, (friendMutationGeneration.get(accountId) || 0) + 1);
  }
  for (const gid of previous) if (!current.includes(gid)) removed.add(gid);
  removedGidsByAccount.set(accountId, removed);
  observedGidsByAccount.set(accountId, current);
  return current;
}

function filterCurrentFriendGids(friends, startedGids = []) {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const current = new Set(getCurrentKnownGids(accountId));
  const removed = removedGidsByAccount.get(accountId);
  const blacklist = new Set(getFriendBlacklist(accountId));
  return friends.filter(friend => {
    const gid = toNum(friend.gid);
    return SYSTEM_NPC_GIDS.has(gid) || (!blacklist.has(gid) && !removed?.has(gid)
      && (!startedGids.includes(gid) || current.has(gid)));
  });
}

// ===== Dog Name =====
/**
 * 取狗名：**优先查游戏配置**（ItemInfo 里宠物 type=8），它含全部狗；
 * DOG_NAMES 小表仅作配置未就绪时的兜底，避免再出现「表里没有就当成无狗」。
 */
function getDogName(dogId) {
  const id = toNum(dogId);
  if (!id) return '';
  try {
    const { getItemById } = require('../config/gameConfig');
    const info = getItemById(id);
    if (info && info.name) return String(info.name);
  } catch { /* 配置未就绪 → 回退小表 */ }
  return DOG_NAMES[id] || '';
}

// ===== Protobuf helpers =====

/**
 * Check if a buffer is mostly printable UTF-8 text (>= 85% printable).
 * Used to decide whether to treat bytes as a nested protobuf or as a string.
 */
function isMostlyPrintableUtf8(buf) {
  if (!buf || buf.length === 0) return false;
  const text = Buffer.from(buf).toString('utf8');
  if (!text) return false;
  let printableCount = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // TAB(9), LF(10), CR(13), or printable (32-126)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
      printableCount++;
    }
  }
  return printableCount / text.length >= 0.85;
}

/**
 * Decode raw protobuf bytes into an array of {no, wire, value/length/fields} objects.
 * Recursively decodes nested messages up to `maxDepth` (default 2).
 */
function decodeProtoFields(rawBytes, depth = 0, maxDepth = 2) {
  const reader = protobuf.Reader.create(Buffer.from(rawBytes || []));
  const fields = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    const entry = { no: fieldNo, wire: wireType };

    if (wireType === 0) {
      // Varint
      const val = reader.uint64();
      entry.value = Number(val.toString());
    } else if (wireType === 1) {
      // Fixed64
      entry.value = String(reader.fixed64());
    } else if (wireType === 2) {
      // Length-delimited (bytes / string / nested message)
      const bytes = reader.bytes();
      entry.length = bytes.length;
      if (isMostlyPrintableUtf8(bytes)) {
        entry.text = Buffer.from(bytes).toString('utf8');
      } else if (depth < maxDepth) {
        try {
          const nested = decodeProtoFields(bytes, depth + 1, maxDepth);
          if (nested.length > 0) {
            entry.fields = nested;
          }
        } catch (_) {
          // Ignore nested decode errors
        }
      }
    } else if (wireType === 5) {
      // Fixed32
      entry.value = reader.fixed32();
    } else {
      reader.skipType(wireType);
      continue;
    }
    fields.push(entry);
  }
  return fields;
}

/**
 * Recursively collect all varint (wireType === 0) integer values from decoded fields.
 */
function collectVarints(decodedFields, result = []) {
  for (const field of Array.isArray(decodedFields) ? decodedFields : []) {
    if (field && field.wire === 0 && Number.isFinite(field.value)) {
      result.push(Math.max(0, Math.floor(field.value)));
    }
    if (field && Array.isArray(field.fields)) {
      collectVarints(field.fields, result);
    }
  }
  return result;
}

/**
 * Parse the brief_dog_info protobuf bytes from VisitEnterReply.
 * Returns { dogId, numbers, rawLen, fields } or null.
 */
function parseBriefDogInfoBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  let fields = [];
  try {
    fields = decodeProtoFields(bytes);
  } catch (_) {
    fields = [];
  }
  const varints = collectVarints(fields).filter(v => v > 0);
  const dogId = varints.find(id => Object.hasOwn(DOG_NAMES, id)) || 0;
  return {
    dogId,
    numbers: varints.slice(-3),   // last 3 varints
    rawLen: bytes.length,
    fields,
  };
}

/**
 * Extract dog info from VisitEnter reply raw bytes.
 * Looks for field number 3, wire type 2 (length-delimited).
 */
function extractVisitEnterBriefDogInfo(rawBytes) {
  if (!rawBytes || rawBytes.length === 0) return null;
  const reader = protobuf.Reader.create(Buffer.from(rawBytes));
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 3 && wireType === 2) {
      const bytes = reader.bytes();
      return parseBriefDogInfoBytes(bytes);
    }
    reader.skipType(wireType);
  }
  return null;
}

// ===== IPC to master process =====
function postToMaster(msg) {
  try {
    if (process.send) {
      process.send(msg);
      return true;
    }
    if (parentPort && typeof parentPort.postMessage === 'function') {
      parentPort.postMessage(msg);
      return true;
    }
  } catch (_) {
    // Ignore IPC errors
  }
  return false;
}

// ===== Invalid known friend GID cooldown management =====

/** Remove expired cooldown entries. */
function pruneInvalidKnownFriendGidCooldown(now = Date.now()) {
  for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
    if (!gid || until <= now) {
      invalidKnownFriendGidCooldownUntil.delete(gid);
    }
  }
}

/** Clear invalid marks for specific GIDs. */
function clearInvalidKnownFriendGidMarks(gids) {
  for (const gid of normalizeFriendGids(gids)) {
    invalidKnownFriendGidCooldownUntil.delete(gid);
  }
}

/** Mark a friend GID as invalid with a cooldown period. */
function markKnownFriendGidInvalid(gid, now = Date.now()) {
  const numericGid = toNum(gid);
  if (!numericGid) return;
  invalidKnownFriendGidCooldownUntil.set(numericGid, now + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}

/** Get the set of currently invalid GIDs (prune first). */
function getInvalidKnownFriendGidSet(now = Date.now()) {
  pruneInvalidKnownFriendGidCooldown(now);
  return new Set(invalidKnownFriendGidCooldownUntil.keys());
}

/** Normalize an array of GIDs: convert to numbers, remove zeros and duplicates. */
function normalizeFriendGids(rawGids) {
  const result = [];
  for (const raw of Array.isArray(rawGids) ? rawGids : []) {
    const num = toNum(raw);
    if (num <= 0) continue;
    if (result.includes(num)) continue;
    result.push(num);
  }
  return result;
}

/** Extract game_friends array from the reply object (supports both snake_case and camelCase). */
function extractReplyFriends(reply) {
  const friends = Array.isArray(reply?.game_friends) ? reply.game_friends
    : Array.isArray(reply?.gameFriends) ? reply.gameFriends : [];
  for (const friend of friends) {
    const gid = toNum(friend?.gid);
    const hostType = friend?.host_type ?? friend?.hostType;
    const accountId = String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '');
    if (gid > 0 && [0, 1, 3].includes(hostType)) friendHostTypes.set(`${accountId}:${gid}`, hostType);
  }
  return friends;
}

/** Deduplicate friend list by GID, keeping first occurrence. */
function dedupeFriendsByGid(friends) {
  const result = [];
  const seen = new Set();
  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    if (gid <= 0 || seen.has(gid)) continue;
    seen.add(gid);
    result.push(friend);
  }
  return result;
}

/** Wrap deduplicated friends into a reply-shaped object. */
function buildFriendReply(friends) {
  const deduped = dedupeFriendsByGid(friends);
  return { game_friends: deduped, gameFriends: deduped };
}

/** Sync known friend GIDs into config and notify master process. */
function syncKnownFriendGidsFromFriends(friends, options = {}) {
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const latestGids = getCurrentKnownGids(accountId);
  if (options.baseGids && (!sameFriendGids(options.baseGids, latestGids)
    || (options.generation !== undefined && options.generation !== getFriendMutationGeneration(accountId)))) {
    return latestGids;
  }
  const newGids = normalizeFriendGids(
    filterCurrentFriendGids(Array.isArray(friends) ? friends : []).map(f => f && f.gid)
  );
  if (newGids.length === 0) return [];

  clearInvalidKnownFriendGidMarks(newGids);

  const currentGids = getCurrentKnownGids();
  const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

  // No change
  if (mergedGids.length === currentGids.length &&
      mergedGids.every((gid, i) => gid === currentGids[i])) {
    return mergedGids;
  }

  // Persist (non-blocking via IPC)
  applyConfigSnapshot({ knownFriendGids: mergedGids }, { persist: false });
  const synced = postToMaster({
    type: 'known_friend_gids_merge', addedGids: newGids.filter(gid => !currentGids.includes(gid)),
    baseGids: currentGids, requiresRemoveEpoch: true,
  });

  if (!synced && options.persist === true) {
    applyConfigSnapshot({ knownFriendGids: mergedGids }, { persist: true, accountId });
  }
  return mergedGids;
}

/**
 * Get known QQ friend GIDs, excluding invalid and blacklisted ones.
 */
function getEffectiveKnownQqFriendGids() {
  const gids = getCurrentKnownGids();
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const invalidSet = getInvalidKnownFriendGidSet();
  const blacklist = new Set(getFriendBlacklist(accountId));
  return normalizeFriendGids(gids).filter(
    gid => !invalidSet.has(gid) && !blacklist.has(gid)
  );
}

/**
 * 同步「最近访客」里的 GID 到 knownFriendGids。
 *
 * 关键语义（对齐上游 `syncKnownFriendGidsFromRecentVisitors`）：
 * - **不是一次性**：每次调用都会尝试拉访客记录并合并（普通调用受 10 分钟间隔节流，
 *   `force=true` 时立即同步）。好友列表接口只按 knownFriendGids 拉取，
 *   若这里只跑一次，之后新增/遗漏的好友 GID 永远不会被发现。
 * - 只做「并集」，绝不因访客为空而收缩已知 GID。
 * - 失败时按退避重试（30s~2min），避免把节流窗口顶满导致长时间不再重试。
 */
function syncKnownFriendGidsFromRecentVisitorsOnce(force = false) {
  if (visitorSyncFlight) return visitorSyncFlight;
  const flight = syncKnownFriendGidsFromRecentVisitors(force).finally(() => {
    if (visitorSyncFlight === flight) visitorSyncFlight = null;
  });
  visitorSyncFlight = flight;
  return flight;
}

async function syncKnownFriendGidsFromRecentVisitors(force = false) {
  const now = Date.now();
  if (!force && lastVisitorGidSyncAt > 0
      && now - lastVisitorGidSyncAt < DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS) {
    return getEffectiveKnownQqFriendGids();
  }

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const existingGids = getCurrentKnownGids();
  const generation = getFriendMutationGeneration(accountId);

  try {
    if (!hasInitializedFromVisitors) {
      log('好友', '首次登录，尝试从访客记录获取好友GID...', {
        module: 'friend',
        event: '首次获取好友GID',
      });
    }

    const interactRecords = await getInteractRecords();
    throwIfRequestCancelled();
    const invalidSet = getInvalidKnownFriendGidSet(now);
    const visitorGids = normalizeFriendGids(
      (Array.isArray(interactRecords) ? interactRecords : [])
        .map(r => r && r.visitorGid)
    ).filter(gid => !invalidSet.has(gid));

    hasInitializedFromVisitors = true;
    lastVisitorGidSyncAt = now;

    if (visitorGids.length === 0) {
      log('好友', '访客记录为空，无法获取好友GID', {
        module: 'friend',
        event: '获取访客好友GID',
        result: 'empty',
      });
      return getEffectiveKnownQqFriendGids();
    }

    const latestGids = getCurrentKnownGids(accountId);
    if (!sameFriendGids(existingGids, latestGids) || generation !== getFriendMutationGeneration(accountId)) {
      return getEffectiveKnownQqFriendGids();
    }
    const mergedGids = syncKnownFriendGidsFromFriends(visitorGids.map(gid => ({ gid })), { baseGids: existingGids, generation });
    const addedCount = mergedGids.length - latestGids.length;
    if (addedCount > 0) {

      log('好友', `已从最近访客补充 ${addedCount} 个好友GID，当前已知好友 GID 共 ${mergedGids.length} 个`, {
        module: 'friend',
        event: '访客补充好友GID',
        result: 'ok',
        addedFromVisitors: addedCount,
        totalKnownGids: mergedGids.length,
      });
    }

    return getEffectiveKnownQqFriendGids();
  } catch (err) {
    hasInitializedFromVisitors = true;
    // 失败退避：把上次同步时间往前挪，使下次在 30s~2min 后即可重试
    const retryMs = Math.max(MIN_QQ_VISITOR_GID_SYNC_RETRY_MS,
      Math.min(DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS, MAX_QQ_VISITOR_GID_SYNC_RETRY_MS));
    lastVisitorGidSyncAt = now - (DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS - retryMs);
    logWarn('好友', `同步最近访客 GID 失败: ${err.message}`, {
      module: 'friend',
      event: '同步好友GID',
      result: 'error',
    });
    throw err;
  }
}

/**
 * QQ 好友 GID 引导同步；每个来源出错即停止，不以网络超时触发后续探测。
 *
 * 好友列表接口（GetGameFriends）只按「已知 GID」拉取，因此新增好友必须先被发现
 * 并写进 knownFriendGids，否则永远不出现在好友列表里。这里把三条发现路径
 * （好友全量/待处理申请/最近访客）合并成一次引导同步。
 */
async function bootstrapQqFriendGids() {
  if (CONFIG.platform !== 'qq') return { skipped: true, reason: 'not_qq' };
  if (hasBootstrappedQqFriendGids) return { skipped: true, reason: 'already_bootstrapped' };
  hasBootstrappedQqFriendGids = true;

  const startedGids = getCurrentKnownGids();
  const generation = getFriendMutationGeneration();
  const discovered = [];
  const sourceCounts = { legacy: 0, applications: 0, visitors: 0 };
  const errors = [];

  try {
    const friends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
    sourceCounts.legacy = friends.length;
    discovered.push(...friends.map(friend => toNum(friend && friend.gid)));
  } catch (err) {
    hasBootstrappedQqFriendGids = false;
    throw err;
  }

  try {
    const reply = await getApplications();
    const applications = Array.isArray(reply && reply.applications) ? reply.applications : [];
    sourceCounts.applications = applications.length;
    discovered.push(...applications.map(application => toNum(application && application.gid)));
  } catch (err) {
    hasBootstrappedQqFriendGids = false;
    throw err;
  }

  try {
    const records = await getInteractRecords();
    const visitorGids = normalizeFriendGids(
      (Array.isArray(records) ? records : []).map(record => record && record.visitorGid)
    );
    sourceCounts.visitors = visitorGids.length;
    discovered.push(...visitorGids);
    hasInitializedFromVisitors = true;
  } catch (err) {
    hasBootstrappedQqFriendGids = false;
    throw err;
  }

  const ownGid = toNum(getUserState().gid);
  const gids = filterCurrentFriendGids(normalizeFriendGids(discovered).filter(gid => gid !== ownGid).map(gid => ({ gid })), startedGids).map(friend => friend.gid);
  const before = getEffectiveKnownQqFriendGids();
  if (gids.length > 0) syncKnownFriendGidsFromFriends(gids.map(gid => ({ gid })), { baseGids: startedGids, generation });
  const after = getEffectiveKnownQqFriendGids();

  let verifiedCount = 0;
  if (after.length > 0) {
    try {
      const verified = await fetchQqFriendsByKnownGids();
      verifiedCount = verified.length;
      // 验证只更新返回值，不把旧验证快照重新提交到 store。
    } catch (err) {
      hasBootstrappedQqFriendGids = false;
      throw err;
    }
  }

  const addedCount = Math.max(0, after.length - before.length);
  log('好友', `QQ 好友GID引导同步完成：发现 ${gids.length} 个，新增 ${addedCount} 个`, {
    module: 'friend',
    event: 'QQ好友GID引导同步',
    result: errors.length > 0 ? 'partial' : 'ok',
    sourceCounts,
    discoveredCount: gids.length,
    addedCount,
    verifiedCount,
    errors,
  });

  return { skipped: false, sourceCounts, discoveredCount: gids.length, addedCount, verifiedCount, errors };
}

// ===== Friend management APIs =====

/** Remove a known friend GID and mark it as invalid. */
function removeKnownFriendGid(gid, friendName, reason = '') {
  const numericGid = toNum(gid);
  if (!numericGid) return false;

  const currentGids = getCurrentKnownGids();
  const filteredGids = currentGids.filter(g => g !== numericGid);
  markKnownFriendGidInvalid(numericGid);
  noteFriendGidDeleted(numericGid);

  if (filteredGids.length !== currentGids.length) {
    applyConfigSnapshot({ knownFriendGids: filteredGids }, { persist: false });
  }

  const synced = postToMaster({
    type: 'known_friend_gid_remove',
    gid: numericGid,
    friendName: friendName || `GID:${numericGid}`,
    reason: String(reason || ''),
  });

  if (!synced && filteredGids.length !== currentGids.length) {
    applyConfigSnapshot({ knownFriendGids: filteredGids }, { persist: true });
  }

  logWarn('好友', `检测到失效好友 GID，已自动移除: ${friendName || `GID:${numericGid}`}`, {
    module: 'friend',
    event: '检测失效好友GID',
    result: 'auto_removed',
    friendName: friendName || `GID:${numericGid}`,
    friendGid: numericGid,
    reason: String(reason || ''),
  });

  return true;
}

/** 只采用真实服务端失败回执；日志文案或 transport 上的同码不是拒绝证据。 */
function isConfirmedFriendRefusal(error) {
  return error?.sent !== false && error?.outcomeUnknown !== true && error?.resultState === 'failed'
    && ['remote', 'game_request'].includes(error?.stage)
    && !error?.holdUntilTransportEpochChanged && !error?.leaveError;
}

/** Extract the exact RPC error code, preferring transport metadata. */
function parseRpcErrorCode(err) {
  const raw = err?.errorCode;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  const msg = String((err && err.message) || err || '');
  const match = msg.match(/\bcode\s*=\s*(\d+)\b/i);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

/** Official ErrorCode.VisitAccountBanned. */
function isEnterFarmBannedError(err) {
  return isConfirmedFriendRefusal(err) && parseRpcErrorCode(err) === 1002003;
}

/** Check if the error is a transient network error (retryable). */
function isTransientNetworkError(err) {
  const msg = String((err && err.message) || err || '');
  if (!msg) return false;
  return [
    '连接未打开',
    '请求超时',
    '请求已中断',
    '连接关闭',
    '连接已在加密途中关闭',
    'worker exited',
  ].some(keyword => msg.includes(keyword));
}

/** Official VisitNotFriend / VisitAccountDeleted / VisitNotPlatFriend. */
function isInvalidFriendAccessError(err) {
  return isConfirmedFriendRefusal(err) && [1002002, 1002004, 1002005].includes(parseRpcErrorCode(err));
}

/** Add a friend to the blacklist via IPC to master process. */
function addFriendToBlacklist(gid, friendName, reason = '') {
  const numericGid = toNum(gid);
  if (!numericGid) return false;

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const blacklist = getFriendBlacklist(accountId);
  const list = Array.isArray(blacklist) ? blacklist : [];
  if (list.includes(numericGid)) return false;

  const synced = postToMaster({
    type: 'friend_blacklist_add',
    gid: numericGid,
    friendName: friendName || `GID:${numericGid}`,
    reason: String(reason || ''),
  });
  if (!synced) return false;

  logWarn('好友', `检测到封禁好友，已自动加入黑名单: ${friendName || `GID:${numericGid}`}`, {
    module: 'friend',
    event: '加黑名单',
    result: 'auto_blocked',
    friendName: friendName || `GID:${numericGid}`,
    friendGid: numericGid,
    reason: String(reason || ''),
  });
  return true;
}

/** Handle errors encountered while entering a friend's farm. */
function handleFriendEnterError(gid, friendName, error) {
  const numericGid = toNum(gid);
  const name = String(friendName || '').trim() || `GID:${numericGid}`;
  const errMsg = String((error && error.message) || error || '');

  // 系统 NPC（如小果 10001）不应被加入黑名单或从好友列表中移除
  if (SYSTEM_NPC_GIDS.has(numericGid)) {
    return { handled: false, kind: 'npc_error' };
  }

  if (isEnterFarmBannedError(error)) {
    addFriendToBlacklist(numericGid, name, errMsg);
    return { handled: true, kind: 'blacklist' };
  }

  if (isInvalidFriendAccessError(error)) {
    removeKnownFriendGid(numericGid, name, errMsg);
    return { handled: true, kind: 'invalid_removed' };
  }

  return { handled: false, kind: 'error' };
}

// ===== QQ friend APIs =====

/** Fetch QQ friends by batch-requesting known GIDs via GetGameFriends. */
async function fetchQqFriendsByKnownGids() {
  if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
    throw new Error('GetGameFriends 接口类型未加载');
  }

  const gids = getEffectiveKnownQqFriendGids();
  if (gids.length === 0) return [];

  const allFriends = [];
  for (let i = 0; i < gids.length; i += QQ_FRIEND_LIST_BATCH_SIZE) {
    throwIfRequestCancelled();
    const batch = gids.slice(i, i + QQ_FRIEND_LIST_BATCH_SIZE);
    const payload = types.GetGameFriendsRequest.encode(
      types.GetGameFriendsRequest.create({ gids: batch.map(g => toLong(g)), global_scene_id: 1 })
    ).finish();

    try {
      const { body } = await sendMsgAsync(
        'gamepb.friendpb.FriendService',
        'GetGameFriends',
        payload
      );
      throwIfRequestCancelled();
      const reply = types.GetAllFriendsReply.decode(body);
      allFriends.push(...extractReplyFriends(reply).filter(friend => batch.includes(toNum(friend.gid))));
    } catch (err) {
      logWarn('好友',
        `QQ 新好友接口分批请求失败(${i + 1}-${i + batch.length}/${gids.length}): ${err.message}`,
        {
          module: 'friend',
          event: '好友列表接口',
          result: 'error',
          method: 'GetGameFriends',
          batchSize: batch.length,
        }
      );
      throw err;
    }

    if (i + QQ_FRIEND_LIST_BATCH_SIZE < gids.length) {
      await randomDelay(500, 1500);
    }
  }

  return filterCurrentFriendGids(dedupeFriendsByGid(allFriends), gids);
}

/** 旧版引导来源只发一次 SyncAll；未知错误不尝试 GetAll。 */
async function fetchQqFriendsByLegacyMethod() {
  const SyncAllReq = types.SyncAllRequest || types.SyncAllFriendsRequest;
  const SyncAllRep = types.SyncAllReply || types.SyncAllFriendsReply;
  if (!SyncAllReq || !SyncAllRep) throw new Error('SyncAll 接口类型未加载');
  const startedGids = getCurrentKnownGids();
  const payload = SyncAllReq.encode(SyncAllReq.create({ open_ids: [], global_scene_id: 1 })).finish();
  const { body } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', payload);
  return filterCurrentFriendGids(extractReplyFriends(SyncAllRep.decode(body)), startedGids);
}

/**
 * 获取好友列表：QQ 固定使用 GetGameFriends，微信固定使用 GetAll；失败不切方法。
 */
function getAllFriends(forceRefresh = false) {
  const options = typeof forceRefresh === 'object' && forceRefresh !== null
    ? { ...forceRefresh } : { force: forceRefresh === true, discover: forceRefresh === true };
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const key = JSON.stringify([accountId, options.discover === true]);
  let flight = allFriendsFlights.get(key);
  if (!flight) {
    flight = getAllFriendsOnce(options).finally(() => {
      if (allFriendsFlights.get(key) === flight) allFriendsFlights.delete(key);
    });
    allFriendsFlights.set(key, flight);
  }
  return flight.then(reply => buildFriendReply(filterCurrentFriendGids(extractReplyFriends(reply)).map(friend => ({ ...friend }))));
}

async function getAllFriendsOnce(options = {}) {
  const isQQ = CONFIG.platform === 'qq';

  /** 将系统 NPC 合并到好友列表中，已有真实数据的优先保留 */
  function mergeSystemNpcs(friends) {
    const list = Array.isArray(friends) ? friends : [];
    const existingGids = new Set(list.map(f => toNum(f && f.gid)).filter(g => g > 0));
    const npcsToAdd = SYSTEM_NPC_FRIENDS.filter(npc => !existingGids.has(npc.gid));
    return dedupeFriendsByGid([...list, ...npcsToAdd]);
  }

  if (isQQ) {
    if (options.discover === true) await syncKnownFriendGidsFromRecentVisitorsOnce(options.force === true);

    // 普通 GET 只查询 owned GID，不发现访客、不提交 store、不持久化。
    const friends = await fetchQqFriendsByKnownGids();
    return buildFriendReply(mergeSystemNpcs(friends));

  }

  // WeChat platform: direct GetAll
  const payload = types.GetAllFriendsRequest.encode(
    types.GetAllFriendsRequest.create({ global_scene_id: 1 })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'GetAll',
    payload
  );
  const wxFriends = extractReplyFriends(types.GetAllFriendsReply.decode(body));
  return buildFriendReply(mergeSystemNpcs(wxFriends));
}

/** Get pending friend applications. */
async function getApplications() {
  const payload = types.GetApplicationsRequest.encode(
    types.GetApplicationsRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'GetApplications',
    payload
  );
  return types.GetApplicationsReply.decode(body);
}

/** Accept friend requests by GID list. */
async function acceptFriends(gids) {
  const payload = types.AcceptFriendsRequest.encode(
    types.AcceptFriendsRequest.create({
      friend_gids: gids.map(g => toLong(g)),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'AcceptFriends',
    payload
  );
  return types.AcceptFriendsReply.decode(body);
}

/** Delete a friend by GID. */
async function delFriend(gid) {
  const numericGid = toNum(gid);
  if (!numericGid) throw new Error('无效的好友 GID');

  const payload = types.DelFriendRequest.encode(
    types.DelFriendRequest.create({ friend_gid: toLong(numericGid) })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'DelFriend',
    payload
  );
  const reply = types.DelFriendReply.decode(body);
  const currentGids = getCurrentKnownGids();
  noteFriendGidDeleted(numericGid);
  applyConfigSnapshot({ knownFriendGids: currentGids.filter(id => id !== numericGid) }, { persist: false, accountId: process.env.FARM_ACCOUNT_ID || '' });

  // Remove from local cache
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  if (accountId) {
    removeFriendFromCache(accountId, numericGid);
  }

  log('好友', `已删除好友 GID: ${numericGid}`, {
    module: 'friend',
    event: '删除好友',
    result: 'ok',
    friendGid: numericGid,
  });
  return reply;
}

/** Enter a friend's farm. Visit reason = 2 (general visit). */
async function enterFriendFarmRpc(gid) {
  const payload = types.VisitEnterRequest.encode(
    types.VisitEnterRequest.create({ host_gid: toLong(gid), reason: visitContext.getStore().token.reason, host_type: visitContext.getStore().token.hostType })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.visitpb.VisitService',
    'Enter',
    payload
  );
  // RPC 已明确成功，即使解码失败也需按实际已进入状态清理，而不是静默漏 Leave。
  visitContext.getStore().entered = true;
  const reply = types.VisitEnterReply.decode(body);

  // 狗信息：proto 里 brief_dog_info 是结构化 BriefDogInfo，直接读 dog_id。
  // ⚠️ 旧实现把该字段当 bytes、从原始字节里猜 varint 再比对 DOG_NAMES 小表，
  // 只要狗 id 不在表里（或猜错）就得到 dogId=0 → 上层判成「无狗」
  // （2026-10-22 用户实测：除小果外 13 个好友全显示无狗）。
  // 现在：有上场狗就一定拿到 id（名字查不到时退化成 `狗#<id>`，而不是「无狗」）。
  const briefDog = reply && reply.brief_dog_info;
  const dogId = toNum(briefDog && briefDog.dog_id);
  reply.__briefDogInfo = dogId > 0
    ? { dogId, dogName: getDogName(dogId) || `狗#${dogId}` }
    : null; // 无上场狗

  return reply;
}

/** Leave a friend's farm. */
async function leaveFriendFarmRpc(gid, hostType = visitContext.getStore()?.token.hostType ?? 0) {
  const payload = types.VisitLeaveRequest.encode(
    types.VisitLeaveRequest.create({ host_gid: toLong(gid), host_type: hostType })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', payload, { timeoutMs: 30000 });
  // LeaveReply为空消息也必须有合法回包；不能把解码失败视作离场确认。
  types.VisitLeaveReply.decode(body);
}

/** Check whether we can perform a remote operation on a friend's farm. */
async function checkCanOperateRemote(gid, operationId) {
  if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) {
    throw requestError('好友操作预检查类型未加载', { errorCode: 'FRIEND_CHECK_TYPE_MISSING', stage: 'visit' });
  }

  try {
    const payload = types.CheckCanOperateRequest.encode(
      types.CheckCanOperateRequest.create({
        host_gid: toLong(gid),
        operation_id: toLong(operationId),
        // Official CheckCanOperateRequest field 3; freeze the same host type
        // used by this visit's Enter/Leave rather than guessing from nickname.
        host_type: visitContext.getStore()?.token.hostType ?? 0,
      })
    ).finish();
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'CheckCanOperate',
      payload
    );
    const reply = types.CheckCanOperateReply.decode(body);
    return {
      canOperate: !!reply.can_operate,
      canStealNum: toNum(reply.can_steal_num),
    };
  } catch (error) {
    throw error;
  }
}

async function friendFarming(gid, landIds, checkExpLimit = false) {
  return runFriendVisitOperation(gid, () => require('./friend-operation-limits').helpFarming(gid, landIds, checkExpLimit));
}

async function friendHarvestDetailed(gid, landIds) {
  const reply = await runFriendVisitOperation(gid, () => require('./friend-operation-limits').stealHarvest(gid, landIds));
  const harvested = [...new Set((reply.land || []).map(land => toNum(land.id)).filter(id => landIds.includes(id)))];
  return { ok: harvested.length, harvested, error: '' };
}

function classifyBadOperationFailure(error) {
  if (!isConfirmedFriendRefusal(error)) return null;
  const code = parseRpcErrorCode(error);
  // 官方 PlantCannotPut*/PlantAlreadyHas*/PlantMax*：仅本地块不可放。
  // PlantOpreateTimesLimit 也不能误作全账号每日99；坏操作总上限另有1001047。
  if ([1001034, 1001035, 1001036, 1001037, 1001038, 1001039].includes(code)) return 'target_unavailable';
  if (code === 1001046) return 'operation_limit';
  if ([1001041, 1001042].includes(code)) return 'no_eligible_land';
  if (code === 1001048) return 'friend_unavailable';
  if (code === 1001047) return 'daily_limit';
  return null;
}

async function putFriendItemsDetailed(gid, landIds, method) {
  if (method !== 'PutInsects' && method !== 'PutWeeds') throw new TypeError('不支持的好友捣乱方法');
  const requestType = method === 'PutInsects' ? types.PutInsectsRequest : types.PutWeedsRequest;
  const replyType = method === 'PutInsects' ? types.PutInsectsReply : types.PutWeedsReply;
  const limits = require('./friend-operation-limits');
  if (typeof limits.recordBadOperationSuccess !== 'function') {
    throw requestError('捣乱预算所有者需导出 recordBadOperationSuccess 后才可安全写入', { errorCode: 'FRIEND_BUDGET_INTERFACE_REQUIRED', stage: 'visit' });
  }
  const ids = [...new Set((Array.isArray(landIds) ? landIds : []).map(toNum).filter(id => Number.isSafeInteger(id) && id > 0))];
  const opType = method === 'PutInsects' ? 'putBug' : 'putWeed';
  const token = assertFriendVisitActive(gid).token;
  if (token.badFriendUnavailable) return { ok: 0, failed: [], skipped: true, reason: 'friend_unavailable' };
  let ok = 0;
  const failed = [];
  for (const landId of ids) {
    if (limits.getBadRemainingTimes() <= 0) break;
    const result = await runFriendVisitOperation(gid, async () => {
      const token = assertFriendVisitActive(gid).token;
      const payload = requestType.encode(requestType.create({ land_ids: [toLong(landId)], host_gid: toLong(gid),
        host_type: token.hostType, reason: token.reason })).finish();
      let response;
      try { response = await sendMsgAsync('gamepb.plantpb.PlantService', method, payload); }
      catch (error) {
        const reason = classifyBadOperationFailure(error);
        if (reason) {
          // Handle the definitive refusal inside the owned sub-operation, so
          // a full target does not poison Leave or the next eligible target.
          if (reason === 'daily_limit') limits.markBadDailyLimitReached?.();
          if (reason === 'friend_unavailable') token.badFriendUnavailable = true;
          return { refused: true, reason, errorCode: parseRpcErrorCode(error), message: error.message };
        }
        error.confirmedBadCounts = { ...(error.confirmedBadCounts || {}), [opType]: ok };
        throw error;
      }
      const reply = replyType.decode(response.body);
      limits.updateOperationLimits(reply.operation_limits);
      const confirmed = (reply.land || []).some(land => toNum(land.id) === landId);
      if (!confirmed) throw requestError('放虫放草回包未确认目标土地，请只核对，不重复提交', {
        errorCode: 'FRIEND_BAD_RESULT_UNKNOWN', stage: 'response', sent: true,
        resultState: 'unknown', outcomeUnknown: true, retryable: false, confirmedBadCounts: { [opType]: ok },
      });
      // Count each confirmed land immediately. A later rejection/Leave failure
      // must not erase an earlier real placement from today's statistics.
      require('./stats').recordOperation(opType, 1);
      require('./stats').saveStats?.();
      ok++;
      try { limits.recordBadOperationSuccess(1); }
      catch (cause) {
        throw requestError('投放已确认，但预算保存失败，暂停后续写入', {
          errorCode: 'FRIEND_BAD_BUDGET_SAVE_FAILED', stage: 'response', sent: true,
          resultState: 'unknown', outcomeUnknown: true, retryable: false,
          confirmedBadCounts: { [opType]: ok }, cause,
        });
      }
      return { refused: false };
    });
    if (result.refused) {
      failed.push({ landId, reason: result.message, kind: result.reason, errorCode: result.errorCode });
      // 确认拒绝且只涉及本地块时，跳过它，不重发；其它已选地块和虫草类型仍独立。
      // 全好友不可放/账号总额度拒绝则结束此类型，不能把后续地块作为重试。
      if (result.reason !== 'target_unavailable') break;
      if (landId !== ids.at(-1)) await require('../utils/utils').randomDelay(500, 1000);
      continue;
    }
    if (ok > 0 && landId !== ids.at(-1)) await require('../utils/utils').randomDelay(500, 1000);
  }
  return { ok, failed };
}

// ===== Quiet hours =====

/** Parse a "HH:MM" time string to total minutes. Returns null if invalid. */
function parseTimeToMinutes(timeStr) {
  const match = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** Check if the current time falls within the friend quiet hours.
 *  If a GID is provided, checks if that specific GID is exempt from quiet hours
 *  (NPC gids like 10001 and user-configured exempt gids are always exempt).
 *  Without a GID, returns the global quiet hours status. */
function inFriendQuietHours(gid, now = new Date()) {
  const { getFriendQuietHours, getFriendQuietHoursExemptGids } = require('../models/store');
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const quietHours = getFriendQuietHours(accountId);
  if (!quietHours || !quietHours.enabled) return false;

  // If a specific GID is provided, check if it is exempt
  if (gid !== undefined && gid !== null) {
    const numericGid = toNum(gid);
    if (numericGid <= 0) return false;
    // NPC GIDs are always exempt
    if (SYSTEM_NPC_GIDS.has(numericGid)) return false;
    // Check user-configured exempt GIDs
    const exemptGids = getFriendQuietHoursExemptGids(accountId);
    if (exemptGids.includes(numericGid)) return false;
    // GID is not exempt — check if we are in quiet hours
  }

  const startMin = parseTimeToMinutes(quietHours.start);
  const endMin = parseTimeToMinutes(quietHours.end);
  if (startMin === null || endMin === null) return false;

  const currentMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return true; // All-day quiet
  if (startMin < endMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  // Crosses midnight (e.g. 23:00 - 03:00)
  return currentMin >= startMin || currentMin < endMin;
}

/** Clear all cooldown marks for invalid friend GIDs. */
function clearAllInvalidKnownFriendGidCooldown() {
  invalidKnownFriendGidCooldownUntil.clear();
}

// ===== Exports =====
module.exports = {
  DOG_NAMES,
  SYSTEM_NPC_FRIENDS,
  SYSTEM_NPC_GIDS,
  getDogName,
  getCurrentKnownGids,
  getFriendMutationGeneration,
  noteFriendGidDeleted,
  filterCurrentFriendGids,
  postToMaster,
  normalizeFriendGids,
  extractReplyFriends,
  dedupeFriendsByGid,
  buildFriendReply,
  syncKnownFriendGidsFromFriends,
  getEffectiveKnownQqFriendGids,
  getInvalidKnownFriendGidSet,
  isEnterFarmBannedError,
  parseRpcErrorCode,
  isConfirmedFriendRefusal,
  classifyBadOperationFailure,
  isTransientNetworkError,
  isInvalidFriendAccessError,
  addFriendToBlacklist,
  handleFriendEnterError,
  removeKnownFriendGid,
  parseTimeToMinutes,
  inFriendQuietHours,
  getAllFriends,
  bootstrapQqFriendGids,
  getApplications,
  acceptFriends,
  delFriend,
  enterFriendFarm,
  leaveFriendFarm,
  withFriendVisitSession,
  runFriendVisitOperation,
  recoverLegacyFriendVisit,
  assertFriendVisitActive,
  getFriendTransportEpoch,
  getFriendVisitSessionSnapshot: (options = {}) => {
    const accountId = String(process.env.FARM_ACCOUNT_ID || getUserState()?.accountId || '');
    // 被动面板诊断不推进状态机/写盘；实际访问才观察真实代际并处理恢复。
    if (options.observeTransport !== false) observeFriendVisitTransport(accountId, getFriendTransportEpoch());
    return getFriendVisitSessionSnapshot(accountId);
  },
  observeFriendVisitTransport,
  putFriendItemsDetailed,
  friendFarming,
  friendHarvestDetailed,
  checkCanOperateRemote: (gid, operationId) => runFriendVisitOperation(gid, () => checkCanOperateRemote(gid, operationId)),
  parseBriefDogInfoBytes,
  extractVisitEnterBriefDogInfo,
  clearAllInvalidKnownFriendGidCooldown,
};
