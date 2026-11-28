const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { assertSceneOperationAvailable } = require('./account-operation-coordinator');
const { requestError } = require('../utils/request-priority');

const accounts = new Map();
const MAX_QUEUED = 32;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
let nextId = 1;

function sessionError(message, errorCode, details = {}) {
  return requestError(message, { errorCode, stage: 'visit', ...details });
}

function visitEpoch(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

function safeErrorMeta(error) {
  const meta = {};
  for (const key of ['stage', 'visitStage', 'method', 'resultState']) {
    if (typeof error?.[key] === 'string' && /^[a-zA-Z0-9_:-]{1,64}$/.test(error[key])) meta[key] = error[key];
  }
  if (Number.isSafeInteger(error?.errorCode)) meta.errorCode = error.errorCode;
  else if (typeof error?.errorCode === 'string' && /^[a-zA-Z0-9_:-]{1,64}$/.test(error.errorCode)) meta.errorCode = error.errorCode;
  for (const key of ['sent', 'outcomeUnknown']) if (typeof error?.[key] === 'boolean') meta[key] = error[key];
  return meta;
}

function stateFile(accountId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) throw sessionError('好友访问账号标识无效', 'VISIT_ACCOUNT_INVALID');
  return getDataFile(path.join('friend-visit-state', `${accountId}.json`));
}

function assertPlainStatePath(file) {
  for (const candidate of [path.dirname(file), file]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
      throw sessionError('好友访问安全状态路径不能是符号链接', 'VISIT_STATE_PATH_INVALID');
    }
  }
}

function readSavedState(state) {
  try {
    assertPlainStatePath(state.file);
    if (!fs.existsSync(state.file)) throw sessionError('缺少好友访问离场证据，不能因业务重载认定已离场', 'VISIT_STATE_BASELINE_MISSING');
    const record = JSON.parse(fs.readFileSync(state.file, 'utf8'));
    const epoch = visitEpoch(record?.epoch);
    const gid = Number(record?.gid);
    if (record?.version !== 1 || record.accountId !== state.accountId || !['active', 'unknown', 'left'].includes(record.phase)
      || !Number.isSafeInteger(gid) || gid < 0 || !Number.isFinite(record.updatedAt)
      || (record.phase === 'left' && (epoch == null || !['leave_confirmed', 'not_entered', 'transport_epoch_changed', 'home_scene_confirmed'].includes(record.proof)))) {
      throw sessionError('好友访问安全状态记录不完整', 'VISIT_STATE_RECORD_INVALID');
    }
    state.recoveryAttempt = record.recoveryAttempt && typeof record.recoveryAttempt === 'object' ? record.recoveryAttempt : null;
    if (record.phase !== 'left') {
      state.unknown = { gid, epoch, observedEpoch: visitEpoch(record.observedEpoch), tokenId: null,
        error: sessionError('上次好友访问未确认离场，业务重载不能清除',
          'VISIT_STATE_UNCONFIRMED', { resultState: 'unknown', ...safeErrorMeta(record.errorMeta) }) };
    }
  } catch (error) {
    state.unknown = { gid: 0, epoch: null, tokenId: null, error: sessionError('好友访问安全状态无法确认',
      error.errorCode || 'VISIT_STATE_RECORD_INVALID', { sent: false, outcomeUnknown: false, resultState: 'unknown' }) };
  }
}

function accountState(accountId) {
  const key = String(accountId || '');
  if (!accounts.has(key)) {
    const state = { accountId: key, file: stateFile(key), active: null, queue: [], unknown: null, storageError: null, recoveryAttempt: null };
    readSavedState(state);
    accounts.set(key, state);
  }
  return accounts.get(key);
}

function persistState(state, phase, token, error, proof) {
  try {
    assertPlainStatePath(state.file);
    writeJsonFileAtomic(state.file, { version: 1, accountId: state.accountId, gid: token?.gid || 0,
      epoch: visitEpoch(token?.epoch), observedEpoch: visitEpoch(token?.observedEpoch),
      phase, proof: proof || undefined, updatedAt: Date.now(),
      errorMeta: error ? safeErrorMeta(error) : null,
      recoveryAttempt: state.recoveryAttempt || undefined });
    state.storageError = null;
  } catch (error) {
    state.storageError = sessionError('好友访问安全状态保存失败，暂停新访问', 'VISIT_STATE_PERSIST_FAILED', {
      sent: false, outcomeUnknown: false, resultState: 'unknown', holdUntilTransportEpochChanged: true,
    });
    throw state.storageError;
  }
}

function clearWaiter(entry) {
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener('abort', entry.onAbort);
}

function drain(state) {
  if (state.active || state.unknown || !state.queue.length) return;
  const entry = state.queue.shift();
  clearWaiter(entry);
  const token = {
    id: nextId++, gid: entry.gid, accountId: entry.accountId, epoch: entry.epoch,
    deadline: entry.deadline, released: false, settled: false, leftConfirmed: false, state,
  };
  try {
    // 先持久化保守的active标记再允许Enter；崩溃或业务重载不能抹掉服务器场景风险。
    persistState(state, 'active', token);
  } catch (error) {
    state.unknown = { gid: token.gid, epoch: token.epoch, error, tokenId: token.id };
    entry.reject(error);
    for (const waiter of state.queue.splice(0)) { clearWaiter(waiter); waiter.reject(error); }
    return;
  }
  state.active = token;
  entry.resolve(token);
}

function observeFriendVisitTransport(accountId, epoch) {
  const state = accountState(accountId);
  const currentEpoch = visitEpoch(epoch);
  // 缺少旧代际时，第一次观测只建立仍未知的基线，绝不能将首个login当恢复证据。
  if (!state.active && state.unknown && currentEpoch != null && state.unknown.epoch == null && state.unknown.observedEpoch == null) {
    const unknown = state.unknown;
    try {
      persistState(state, 'unknown', { gid: unknown.gid, epoch: null, observedEpoch: currentEpoch }, unknown.error);
      unknown.observedEpoch = currentEpoch;
    } catch { /* 保存失败继续闭锁，不能以新内存基线绕过落盘失败。 */ }
  }
  // 原真实epoch或已持久化的观测epoch之后确实发生游戏代际变化，才有离场复位证据。
  const priorEpoch = state.unknown?.epoch ?? state.unknown?.observedEpoch;
  if (!state.active && state.unknown && currentEpoch != null && priorEpoch != null && currentEpoch > priorEpoch) {
    try {
      persistState(state, 'left', { gid: 0, epoch: currentEpoch }, null, 'transport_epoch_changed');
      state.unknown = null;
    } catch { /* 存储失败已明确写入storageError，原unknown继续闭锁。 */ }
  }
  drain(state);
}

function reconcileFriendVisitAtHome(accountId, evidence) {
  const state = accountState(String(accountId || ''));
  const current = evidence || {};
  const diagnostic = current.diagnostic || {};
  const gid = Number(current.gid);
  const epoch = visitEpoch(diagnostic.remoteGeneration);
  const priorEpoch = state.unknown?.epoch ?? state.unknown?.observedEpoch;
  if (!state.unknown || state.active || state.queue.length || state.storageError
    || current.activeSceneId !== 1 || current.accountId !== state.accountId
    || !Number.isSafeInteger(gid) || gid <= 0 || Number(current.currentGid) !== gid
    || String(diagnostic.accountId || '') !== state.accountId
    || diagnostic.connected !== true || diagnostic.loggedIn !== true
    || diagnostic.detached === true || diagnostic.quiescing === true
    || diagnostic.remoteGenerationSource !== 'gateway' || epoch == null
    || priorEpoch == null || epoch !== priorEpoch) return false;
  // 只接受同一账号/用户/真实网关代际下，服务端明确报告的当前HOME场景；不发送Leave、不借用IPC代际。
  persistState(state, 'left', { gid: 0, epoch }, null, 'home_scene_confirmed');
  state.unknown = null;
  drain(state);
  return true;
}

function blockedSessionError(state) {
  return sessionError('好友访问状态未知，等待真实游戏连接代际改变', 'VISIT_STATE_UNKNOWN', {
    sent: false, outcomeUnknown: false, resultState: 'unknown', holdUntilTransportEpochChanged: true,
    friendGid: state.unknown.gid, cause: state.unknown.error,
  });
}

function acquireFriendVisitSession(gid, options = {}) {
  // 牧场场景租约持有期间禁止新的好友 Enter；已有访问会在牧场切场前被快照门禁拦截。
  try { assertSceneOperationAvailable('好友访问'); }
  catch (error) { return Promise.reject(error); }
  const accountId = String(options.accountId ?? process.env.FARM_ACCOUNT_ID ?? '');
  const ranchVisit = require('./ranch-friend-session').getRanchFriendSessionSnapshot(accountId);
  if (ranchVisit?.resultState && ranchVisit.resultState !== 'idle') {
    return Promise.reject(sessionError('好友牧场访问尚未确认离场，暂不能进入好友农场', 'VISIT_RANCH_FRIEND_BUSY', {
      sent: false, outcomeUnknown: false, resultState: 'unknown',
      holdUntilTransportEpochChanged: ranchVisit.holdUntilTransportEpochChanged === true,
      friendGid: ranchVisit.hostGid,
    }));
  }
  const state = accountState(accountId);
  observeFriendVisitTransport(accountId, options.epoch);
  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const deadline = Math.min(Date.now() + timeoutMs, Number.isFinite(options.deadline) ? options.deadline : Infinity);
  if (state.unknown) return Promise.reject(blockedSessionError(state));
  if (state.queue.length >= MAX_QUEUED) return Promise.reject(sessionError('好友访问队列已满', 'VISIT_QUEUE_FULL'));
  if (options.signal?.aborted || Date.now() >= deadline) {
    return Promise.reject(options.signal?.reason instanceof Error ? options.signal.reason
      : sessionError('好友访问等待已取消或超时', 'VISIT_WAIT_CANCELLED'));
  }
  return new Promise((resolve, reject) => {
    const entry = { gid: Number(gid) || 0, accountId, epoch: visitEpoch(options.epoch), deadline, signal: options.signal, resolve, reject };
    const remove = error => {
      const index = state.queue.indexOf(entry);
      if (index < 0) return;
      state.queue.splice(index, 1);
      clearWaiter(entry);
      reject(error);
    };
    entry.onAbort = () => remove(entry.signal.reason instanceof Error ? entry.signal.reason
      : sessionError('好友访问等待已取消', 'VISIT_WAIT_CANCELLED'));
    entry.timer = setTimeout(() => remove(sessionError('好友访问等待超时', 'VISIT_WAIT_TIMEOUT')), Math.max(0, deadline - Date.now()));
    entry.signal?.addEventListener('abort', entry.onAbort, { once: true });
    state.queue.push(entry);
    drain(state);
  });
}

function markFriendVisitSessionUnknown(token, error) {
  if (!token || token.released) return;
  token.state.unknown = { gid: token.gid, epoch: token.epoch, error, tokenId: token.id };
  try { persistState(token.state, 'unknown', token, error); }
  catch { /* 预先保存的active仍会让下次启动闭锁，不把写盘失败当离场成功。 */ }
  for (const entry of token.state.queue.splice(0)) {
    clearWaiter(entry);
    entry.reject(blockedSessionError(token.state));
  }
}

function confirmFriendVisitSessionLeft(token, proof = 'leave_confirmed') {
  if (!token || token.released || token.state.active !== token) return;
  // 空代际不能成为跨worker离场凭据；仍由调用方保留unknown并报告原因。
  if (token.epoch == null) throw sessionError('缺少真实游戏代际，无法保存离场证据', 'VISIT_EPOCH_UNCONFIRMED', { resultState: 'unknown' });
  persistState(token.state, 'left', token, null, proof);
  token.leftConfirmed = true;
  if (token.state.unknown?.tokenId === token.id) token.state.unknown = null;
}

function releaseFriendVisitSession(token) {
  // watchdog/调用方超时不能释放仍在执行的事务；仅底层finally标记完成后可释放。
  if (!token || token.released || !token.settled) return false;
  if (!token.leftConfirmed && !token.state.unknown) {
    markFriendVisitSessionUnknown(token, sessionError('好友访问完成但未确认离场', 'VISIT_SETTLEMENT_UNCONFIRMED', { resultState: 'unknown' }));
  }
  token.released = true;
  if (token.state.active === token) token.state.active = null;
  drain(token.state);
  return true;
}

const LEGACY_VISIT_SOURCE_SHA256 = 'de37fb128953ddbf2d5b2389b3fab52a0698d088246aa8fbb0387f9376f3e57d';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function getLegacyFriendVisitRecoveryPlan(accountId, epoch) {
  const state = accountState(String(accountId || ''));
  const currentEpoch = visitEpoch(epoch);
  if (!state.unknown) return { eligible: false, skipped: true, reason: 'already_left' };
  if (state.active || state.queue.length) throw sessionError('好友访问仍在处理中，不能恢复', 'VISIT_RECOVERY_BUSY');
  const claimPath = getDataFile(path.join('friend-visit-recovery', `${state.accountId}.attempt.json`));
  assertPlainStatePath(claimPath);
  if (state.recoveryAttempt || fs.existsSync(claimPath)) throw sessionError('旧访问离场已经尝试，不能重放Leave', 'VISIT_RECOVERY_ALREADY_ATTEMPTED', {
    resultState: 'unknown', holdUntilTransportEpochChanged: true,
  });
  const code = safeErrorMeta(state.unknown.error).errorCode;
  if (code !== 'VISIT_LEGACY_STATE_UNCONFIRMED') throw sessionError('只允许补完有证据的旧业务拒绝漏发离场', 'VISIT_RECOVERY_UNSUPPORTED');
  const file = getDataFile(path.join('friend-visit-recovery', `${state.accountId}.json`));
  assertPlainStatePath(file);
  if (!fs.existsSync(file)) throw sessionError('缺少已核验的旧事务证据，未发送Leave', 'VISIT_RECOVERY_EVIDENCE_MISSING');
  let ticket;
  try { ticket = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw sessionError('旧事务恢复证据无法读取', 'VISIT_RECOVERY_EVIDENCE_INVALID'); }
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const evidence = ticket?.evidence;
  let recordRaw;
  let record;
  try { recordRaw = fs.readFileSync(state.file); record = JSON.parse(recordRaw.toString()); }
  catch { throw sessionError('当前好友访问记录无法确认', 'VISIT_RECOVERY_STATE_INVALID'); }
  const recordHash = sha256(recordRaw);
  if (record.version !== 1 || record.accountId !== state.accountId || record.phase !== 'unknown'
    || record.errorMeta?.errorCode !== 'VISIT_LEGACY_STATE_UNCONFIRMED' || record.recoveryAttempt
    || ticket?.version !== 1 || ticket.kind !== 'legacy_harvest_rejection_cleanup'
    || ticket.accountId !== state.accountId || !Number.isSafeInteger(ticket.gid) || ticket.gid <= 0
    || ![0, 1, 3].includes(ticket.hostType) || currentEpoch == null || ticket.epoch !== currentEpoch
    || (state.unknown.epoch ?? state.unknown.observedEpoch) !== currentEpoch
    || !Number.isSafeInteger(ticket.ownerGid) || ticket.ownerGid <= 0
    || !hex(ticket.id) || !hex(ticket.stateSha256) || !hex(ticket.evidenceSha256)
    || ticket.stateSha256 !== recordHash || ticket.sourceSha256 !== LEGACY_VISIT_SOURCE_SHA256
    || !evidence || ticket.evidenceSha256 !== sha256(JSON.stringify(evidence))
    || evidence?.service !== 'gamepb.plantpb.PlantService' || evidence.method !== 'Harvest'
    || evidence.errorCode !== 1001040 || evidence.enterConfirmed !== true || evidence.leaveSent !== false
    || evidence.outcomeUnknown !== false || evidence.friendGid !== ticket.gid || evidence.transportEpoch !== currentEpoch
    || !Number.isFinite(ticket.issuedAt) || !Number.isFinite(ticket.expiresAt)
    || ticket.issuedAt > Date.now() || ticket.expiresAt <= Date.now()
    || ticket.expiresAt <= ticket.issuedAt || ticket.expiresAt - ticket.issuedAt > 10 * 60 * 1000) {
    throw sessionError('旧事务证据与账号、GID、真实代际或当前锁不一致', 'VISIT_RECOVERY_EVIDENCE_INVALID');
  }
  return { eligible: true, accountId: state.accountId, ownerGid: ticket.ownerGid, gid: ticket.gid, hostType: ticket.hostType,
    epoch: currentEpoch, evidenceId: ticket.id, stateSha256: recordHash, expiresAt: ticket.expiresAt,
    action: 'complete_original_leave_once', enterWillBeSent: false };
}

function beginLegacyFriendVisitRecovery(accountId, epoch, expected = {}) {
  const plan = getLegacyFriendVisitRecoveryPlan(accountId, epoch);
  if (!plan.eligible) return null;
  if (expected.evidenceId !== plan.evidenceId || expected.stateSha256 !== plan.stateSha256) {
    throw sessionError('恢复确认已过期或状态发生变化', 'VISIT_RECOVERY_CONFIRMATION_STALE');
  }
  const state = accountState(accountId);
  const claimPath = getDataFile(path.join('friend-visit-recovery', `${state.accountId}.attempt.json`));
  assertPlainStatePath(claimPath);
  let fd;
  try {
    // 跨worker排他占位；占位失败/崩溃也不删除或重试，保证旧Leave最多发送一次。
    fd = fs.openSync(claimPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ id: plan.evidenceId, accountId: state.accountId, gid: plan.gid, epoch: plan.epoch }));
    fs.fsyncSync(fd);
  } catch (error) {
    throw sessionError('旧事务清理预算已占用或无法持久化，未发送Leave',
      error.code === 'EEXIST' ? 'VISIT_RECOVERY_ALREADY_ATTEMPTED' : 'VISIT_STATE_PERSIST_FAILED');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const token = { id: nextId++, gid: plan.gid, hostType: plan.hostType, epoch: plan.epoch,
    accountId: state.accountId, state, deadline: Date.now() + 30000,
    released: false, settled: false, leftConfirmed: false, recovery: true };
  state.recoveryAttempt = { id: plan.evidenceId, gid: plan.gid, epoch: plan.epoch, phase: 'attempted', at: Date.now() };
  // 发送Leave之前持久化一次性预算；崩溃/重载/HTTP取消不得再次发送。
  persistState(state, 'unknown', token, state.unknown.error);
  state.unknown = { ...state.unknown, gid: token.gid, epoch: token.epoch, tokenId: token.id };
  state.active = token;
  return token;
}

function finishLegacyFriendVisitRecovery(token, error) {
  if (!token?.recovery || token.released || token.state.active !== token) return false;
  token.state.recoveryAttempt = { ...token.state.recoveryAttempt, phase: error ? 'unconfirmed' : 'completed', at: Date.now() };
  if (error) markFriendVisitSessionUnknown(token, error);
  else confirmFriendVisitSessionLeft(token);
  token.settled = true;
  return releaseFriendVisitSession(token);
}

function getFriendVisitSessionSnapshot(accountId = process.env.FARM_ACCOUNT_ID || '') {
  const state = accountState(accountId);
  const meta = safeErrorMeta(state.unknown?.error);
  return {
    activeGid: state.active ? state.active.gid : 0, queued: state.queue.length,
    processing: !!state.active, resultState: state.unknown ? 'unknown' : state.active ? 'processing' : 'idle',
    holdUntilTransportEpochChanged: !!state.unknown, unknownGid: state.unknown?.gid || 0,
    transportEpoch: state.unknown?.epoch ?? state.active?.epoch ?? null,
    observedTransportEpoch: state.unknown?.observedEpoch ?? null,
    deadline: state.active?.deadline ?? null, recoveryRequired: !!state.unknown,
    errorCode: meta.errorCode || '', unknownStage: meta.stage || '', unknownVisitStage: meta.visitStage || '',
    unknownSent: meta.sent ?? null, unknownOutcomeUnknown: meta.outcomeUnknown ?? null, unknownResultState: meta.resultState || '',
    triggerOperation: meta.method || '', persistenceErrorCode: state.storageError?.errorCode || '',
    recoveryAttempted: !!state.recoveryAttempt, recoveryAttemptState: state.recoveryAttempt?.phase || '',
    recoveryReason: state.unknown ? '访问状态未确认；缓存或业务重启不代表服务端已经离开好友农场' : '',
  };
}

module.exports = {
  acquireFriendVisitSession, releaseFriendVisitSession, markFriendVisitSessionUnknown,
  observeFriendVisitTransport, getFriendVisitSessionSnapshot, confirmFriendVisitSessionLeft,
  reconcileFriendVisitAtHome,
  getLegacyFriendVisitRecoveryPlan, beginLegacyFriendVisitRecovery, finishLegacyFriendVisitRecovery,
};
