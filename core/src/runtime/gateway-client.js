const net = require('net');
const { EventEmitter } = require('events');
const { encodeFrame, decodeFrame, toBase64, fromBase64 } = require('./gateway-protocol');
const {
    createRequestGate, getRequestOptions, throwIfRequestCancelled, requestError,
    isCriticalRequest, isSafeReadRequest, createSafeReadFlights, createWriteDrain,
} = require('../utils/request-priority');
const { log, logWarn } = require('../utils/utils');
const { assertGameRequestAllowed, isSceneRequestOwned } = require('../services/account-operation-barrier');

const DEFAULT_SOCK = process.env.FARM_GATEWAY_SOCK || '/tmp/qq-farm-gateway.sock';
const WORKER_REQUEST_TIMEOUT_MS = 60000;
let sock = null;
let loggedIn = false;
let businessSuspended = false;
let detached = false;
let accountId = String(process.env.FARM_ACCOUNT_ID || '');
let connectionEpoch = 0;
let remoteGeneration;
let nextSeq = 1;
let requestGate = createRequestGate({ maxActive: 8, maxCritical: 1, maxQueued: 100 });
const safeFlights = createSafeReadFlights();
const pending = new Map();
const pendingStartedAt = new Map();
let quiescing = false;
const writeDrain = createWriteDrain(getPendingWriteCount);
const networkEvents = new EventEmitter();
let handleNotifyFn = null;
let onLoginReady = null;
let onLoginCb = null;
const userState = { gid: 0, name: '', level: 0, gold: 0, exp: 0, openId: '', avatar: '' };
let healthBackoffUntil = 0;
let healthBackoffReason = '';

function setHealthBackoff(ms, reason) {
    const dur = Number(ms) || 0;
    if (!Number.isFinite(dur) || dur <= 0) return;
    healthBackoffUntil = Math.max(healthBackoffUntil, Date.now() + dur);
    healthBackoffReason = String(reason || '业务请求连续超时');
    cancelQueued(backoffError());
}
function clearHealthBackoff() { healthBackoffUntil = 0; healthBackoffReason = ''; }
function isHealthBackoffActive() {
    if (healthBackoffUntil && Date.now() >= healthBackoffUntil) clearHealthBackoff();
    return healthBackoffUntil > 0;
}
function getHealthBackoffState() {
    return { active: isHealthBackoffActive(), remainingMs: Math.max(0, healthBackoffUntil - Date.now()), reason: healthBackoffReason };
}
function backoffError() {
    return requestError(`网关亚健康退避中(${healthBackoffReason})，暂停业务请求给心跳让路`, {
        errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: Math.max(0, healthBackoffUntil - Date.now()),
    });
}
function isConnected() { return !!(loggedIn && !businessSuspended && sock && !sock.destroyed && !detached); }
function suspendedError() {
    return requestError('网关链路暂停业务请求', { errorCode: 'CONNECTION_SUSPENDED', stage: 'queue' });
}
function getWs() { return null; }
function cancelQueued(reason = '业务请求已取消') { return requestGate.cancelQueued(reason); }
function quiescingError() { return requestError('业务传输正在静默排空', { errorCode: 'TRANSPORT_QUIESCING', stage: 'queue' }); }
function getPendingWriteCount() {
    let count = 0;
    for (const item of pending.values()) if (!item.read && !item.critical) count++;
    return count;
}
function quiesceAndDrain({ timeoutMs = 155000 } = {}) {
    quiescing = true;
    cancelQueued(quiescingError());
    safeFlights.cancelUnsent();
    for (const item of [...pending.values()]) if (item.read) item.cancelPendingRead();
    return writeDrain.wait(timeoutMs);
}

function rejectPending(reason) {
    for (const item of [...pending.values()]) {
        item.finish(requestError(reason, { errorCode: 'CONNECTION_CLOSED', stage: 'transport', sent: item.sent,
            resultState: item.sent && !item.read ? 'unknown' : item.sent ? 'failed' : 'not_sent' }));
    }
}
function advanceEpoch(reason, closeGate = false) {
    connectionEpoch++;
    safeFlights.invalidate();
    if (closeGate) requestGate.close(reason);
    else requestGate.cancelQueued(reason, () => true);
    rejectPending(reason);
}

// 只有显式 connect 创建 IPC；业务请求、stop 和断开清理均不能隐式重连。
function ensureSocket() {
    if (detached) return null;
    if (sock && !sock.destroyed) return sock;
    const current = net.connect(DEFAULT_SOCK, () => {
        if (sock === current) log('网关', '已连接本地连接网关进程');
    });
    sock = current;
    let buffer = '';
    current.setEncoding('utf8');
    current.on('data', chunk => {
        if (sock !== current || detached) return;
        buffer += chunk;
        let index;
        while (sock === current && !detached && (index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.trim()) handleFrame(decodeFrame(line), current);
        }
    });
    current.on('close', () => {
        if (sock !== current) return;
        sock = null;
        loggedIn = false;
        buffer = '';
        advanceEpoch('网关 IPC 已断开', true);
        if (!detached) networkEvents.emit('disconnect', { code: 'gateway_close' });
    });
    current.on('error', error => {
        if (sock === current) logWarn('网关', `socket 错误: ${error.message}`);
    });
    return current;
}
function sendFrame(obj, current = sock) {
    if (!current || current !== sock || current.destroyed || detached) return false;
    current.write(encodeFrame(obj) + '\n');
    return true;
}
function frameGeneration(frame) { return frame.connectionEpoch ?? frame.sessionEpoch ?? frame.epoch ?? frame.generation; }
function handleFrame(frame, current) {
    if (!frame || sock !== current || detached) return;
    if (frame.accountId != null && String(frame.accountId) !== accountId) return;
    const generation = frameGeneration(frame);
    const terminal = frame.t === 'event' && ['disconnect', 'login_error', 'connection_dead', 'game_dead'].includes(frame.name);
    const numericGenerations = generation != null && remoteGeneration != null
        && Number.isFinite(Number(generation)) && Number.isFinite(Number(remoteGeneration));
    const sameGeneration = generation === remoteGeneration || (numericGenerations && Number(generation) === Number(remoteGeneration));
    let advancedTerminal = false;
    if (frame.t !== 'login' && generation != null && remoteGeneration != null && !sameGeneration) {
        advancedTerminal = terminal && frame.accountId != null && numericGenerations && Number(generation) > Number(remoteGeneration);
        if (!advancedTerminal) return;
        remoteGeneration = generation;
    }
    switch (frame.t) {
        case 'login': {
            if (generation != null && remoteGeneration != null && Number.isFinite(Number(generation))
                && Number.isFinite(Number(remoteGeneration)) && Number(generation) < Number(remoteGeneration)) return;
            const gid = Number(frame.userState?.gid);
            if (!Number.isSafeInteger(gid) || gid <= 0) {
                loggedIn = false;
                advanceEpoch('网关登录身份无效');
                networkEvents.emit('login_error', { message: '网关登录身份无效' });
                break;
            }
            const newLogin = !loggedIn || gid !== Number(userState.gid) || (generation != null && !sameGeneration);
            if (newLogin) {
                advanceEpoch('网关登录代际已更新');
                clearHealthBackoff();
                businessSuspended = false;
            }
            if (generation != null) remoteGeneration = generation;
            loggedIn = true;
            Object.assign(userState, frame.userState);
            if (onLoginCb) onLoginCb(frame.userState);
            if (newLogin && onLoginReady) onLoginReady();
            break;
        }
        case 'request_sent': {
            const item = pending.get(frame.seq);
            if (!item || !item.sent || item.socket !== current || item.epoch !== connectionEpoch || item.accountId !== accountId
                || String(frame.accountId) !== accountId || generation == null || !sameGeneration || item.actualSent
                || !Number.isFinite(frame.sentAt) || !Number.isFinite(frame.settlementDeadline)
                || frame.settlementDeadline < frame.sentAt) break;
            // readOnly 仅诊断，权限由本地精确 service/method 判定，不信任远端分类覆盖。
            item.actualSent = true;
            item.sentAt = frame.sentAt;
            item.settlementDeadline = frame.settlementDeadline;
            const budget = Math.min(125000, Math.max(0, frame.settlementDeadline - Date.now()) + 5000);
            if (!item.read) item.armTimeout(budget);
            networkEvents.emit('request_sent', { accountId, seq: frame.seq, connectionEpoch: generation,
                sentAt: item.sentAt, settlementDeadline: item.settlementDeadline, readOnly: item.read, actualSent: true });
            break;
        }
        case 'response': {
            const item = pending.get(frame.seq);
            if (!item || item.socket !== current || item.epoch !== connectionEpoch || item.accountId !== accountId) break;
            const nonFinal = frame.settled === false || frame.meta?.settled === false;
            if (frame.error) {
                const details = {};
                for (const key of ['errorCode', 'stage', 'retryAfterMs', 'sent', 'resultState', 'outcomeUnknown', 'retryable', 'settled']) {
                    if (frame[key] !== undefined) details[key] = frame[key];
                    else if (frame.meta?.[key] !== undefined) details[key] = frame.meta[key];
                    else if (frame.error?.[key] !== undefined) details[key] = frame.error[key];
                }
                const sent = details.sent ?? item.sent;
                const resultState = !sent ? 'not_sent' : item.read ? 'failed'
                    : details.outcomeUnknown === true ? 'unknown' : details.resultState || 'failed';
                const error = requestError(typeof frame.error === 'string' ? frame.error : frame.error.message || '网关请求失败', {
                    stage: 'remote', ...details, sent, resultState,
                });
                if (nonFinal && !item.read && item.sent && sent) {
                    item.progressError = error;
                    safeFlights.invalidate();
                    networkEvents.emit('request_progress', { seq: frame.seq, accountId, connectionEpoch: remoteGeneration,
                        error: error.message, meta: { ...error } });
                } else item.finish(error);
            } else {
                if (nonFinal && !item.read && item.sent) break;
                try { item.finish(null, { body: fromBase64(frame.body), meta: frame.meta || {}, resultState: 'completed' }); }
                catch (error) { item.finish(requestError(error.message, { sent: item.sent, stage: 'decode', resultState: item.read ? 'failed' : 'unknown' })); }
            }
            break;
        }
        case 'notify':
            if (loggedIn && handleNotifyFn && frame.body) {
                safeFlights.invalidate();
                try { handleNotifyFn(fromBase64(frame.body)); } catch (error) { logWarn('网关', `notify 解码失败: ${error.message}`); }
            }
            break;
        case 'event': {
            if (terminal && (advancedTerminal || frame.name !== 'connection_dead')) {
                loggedIn = false;
                businessSuspended = false;
                advanceEpoch(`网关事件: ${frame.name}`);
            } else if (frame.name === 'connection_dead') {
                // 同一 WS 暂时判死不等于身份丢失，不丢在途写回包。
                businessSuspended = true;
                safeFlights.invalidate();
                cancelQueued(suspendedError());
            }
            if (frame.name === 'connection_degraded') setHealthBackoff(frame.payload?.retryAfterMs || frame.payload?.backoffMs || 30000, frame.payload?.reason);
            if (frame.name === 'connection_recovered') {
                if (sameGeneration && generation != null && frame.payload?.linkRecovered === true) businessSuspended = false;
                if (frame.payload?.businessHealthy === true && !businessSuspended && loggedIn) clearHealthBackoff();
            }
            networkEvents.emit(frame.name, frame.payload || {});
            break;
        }
        case 'error':
            networkEvents.emit('ws_error', { code: 0, message: frame.message });
            break;
        default: break;
    }
}
function connect(id, code, onReady, options = {}) {
    loggedIn = false;
    businessSuspended = false;
    advanceEpoch('网关连接代际已更新', true);
    quiescing = false;
    const previous = sock;
    sock = null;
    if (previous && !previous.destroyed) previous.destroy();
    requestGate = createRequestGate({ maxActive: 8, maxCritical: 1, maxQueued: 100 });
    detached = false;
    accountId = String(id);
    remoteGeneration = undefined;
    userState.gid = 0;
    clearHealthBackoff();
    onLoginReady = onReady;
    const current = ensureSocket();
    sendFrame({
        t: 'connect', accountId,
        ...(options.resumeSession === true ? {} : { code: String(code || '') }),
        platform: process.env.FARM_PLATFORM || 'android', os: process.env.FARM_OS || 'android',
        clientVersion: process.env.FARM_CLIENT_VERSION || '',
    }, current);
    sendFrame({ t: 'ping' }, current);
}

async function sendRequest(service, method, body, options, read, markSent = () => {}, session = {}) {
    const critical = isCriticalRequest(service, method);
    const current = session.socket ?? sock;
    const epoch = session.epoch ?? connectionEpoch;
    const id = session.accountId ?? accountId;
    const gate = session.gate ?? requestGate;
    const remoteEpoch = session.remoteGeneration ?? remoteGeneration;
    function validate() {
        assertGameRequestAllowed(service, method);
        throwIfRequestCancelled(options);
        if (options.validateWaiters) options.validateWaiters();
        if (quiescing && (!critical || method !== 'Heartbeat')) throw quiescingError();
        if (!critical && businessSuspended) throw suspendedError();
        if (!critical && isHealthBackoffActive()) throw backoffError();
        if (detached || !current || current.destroyed || current !== sock || epoch !== connectionEpoch || id !== accountId || (!loggedIn && !(critical && method === 'Login'))) {
            throw requestError('网关连接或登录代际不可用', { errorCode: 'CONNECTION_UNAVAILABLE', stage: 'queue' });
        }
    }
    validate();
    const release = await gate.acquire(critical ? 'critical' : options.priority === 'critical' ? 'foreground' : options.priority, { ...options, validate });
    try {
        validate();
        const seq = nextSeq++;
        return await new Promise((resolve, reject) => {
            const item = { socket: current, epoch, accountId: id, read, critical, sent: false,
                actualSent: false, sentAt: 0, settlementDeadline: 0, timeoutDeadline: 0 };
            let timer;
            let settled = false;
            let cancelSent = false;
            function cancelPendingRead() {
                if (!read || !item.sent || settled || cancelSent || current !== sock || current.destroyed
                    || epoch !== connectionEpoch || id !== accountId) return;
                cancelSent = true;
                try {
                    sendFrame({ t: 'cancel', accountId: id, seq,
                        ...(remoteEpoch == null ? {} : { connectionEpoch: remoteEpoch }) }, current);
                } catch (error) { logWarn('网关', `只读取消帧发送失败: ${error.message}`); }
                // 不提前 settle：IPC cancel 只撤销网关尚未发送的读，仍等待响应或原期限。
            }
            item.cancelPendingRead = cancelPendingRead;
            if (read) {
                options.signal?.addEventListener('abort', cancelPendingRead, { once: true });
                if (options.setOnNoWaiters) options.setOnNoWaiters(cancelPendingRead);
            }
            item.finish = (error, value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (read) {
                    options.signal?.removeEventListener('abort', cancelPendingRead);
                    if (options.setOnNoWaiters) options.setOnNoWaiters(null);
                }
                pending.delete(seq);
                pendingStartedAt.delete(seq);
                if (error) reject(error);
                else resolve(value);
                writeDrain.notify();
            };
            function armTimeout(budgetMs) {
                if (timer) clearTimeout(timer);
                item.timeoutDeadline = Date.now() + Math.max(0, budgetMs);
                timer = setTimeout(() => item.finish(requestError('网关请求超时', {
                    ...item.progressError, errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: item.sent,
                    ...(item.progressError ? { settled: true } : {}),
                    resultState: item.sent && !read ? 'unknown' : item.sent ? 'failed' : 'not_sent',
                })), Math.max(0, budgetMs));
            }
            item.armTimeout = armTimeout;
            armTimeout(options.deadline - Date.now() + (read ? 0 : 5000));
            pending.set(seq, item);
            pendingStartedAt.set(seq, Date.now());
            try {
                validate();
                const frame = { t: 'request', accountId: id, seq, service, method, body: toBase64(body),
                    ...(remoteEpoch == null ? {} : { connectionEpoch: remoteEpoch }),
                    meta: { priority: critical ? 'critical' : options.priority === 'critical' ? 'foreground' : options.priority,
                        timeoutMs: options.wireTimeoutMs, deadline: options.deadline,
                        ...(!read && !critical ? { settlementTimeoutMs: options.settlementTimeoutMs } : {}) } };
                // 发送给网关前最后复查；回调只在 worker 内执行，不进入 IPC 帧。
                options.assertCanSend?.();
                if (!read) safeFlights.invalidate();
                // write 调用即视为可能发送，异常也不重试；页面 signal 在此之后不再中断写。
                item.sent = true;
                markSent();
                if (!sendFrame(frame, current)) {
                    item.sent = false;
                    item.finish(requestError('网关连接不可用', { errorCode: 'CONNECTION_UNAVAILABLE', stage: 'send' }));
                }
            } catch (error) {
                item.finish(requestError(error.message, { ...error, stage: error.stage || 'send',
                    sent: error.sent ?? item.sent,
                    resultState: error.resultState || (item.sent && !read ? 'unknown' : item.sent ? 'failed' : 'not_sent') }));
            }
        });
    } finally {
        if (!read) safeFlights.invalidate();
        release();
    }
}
async function sendMsgAsync(service, method, bodyBytes, meta) {
    assertGameRequestAllowed(service, method);
    const options = getRequestOptions(meta, WORKER_REQUEST_TIMEOUT_MS, 30000);
    const body = Buffer.from(bodyBytes || []);
    if (!isSafeReadRequest(service, method) && !isCriticalRequest(service, method)) {
        options.deadline = Math.min(options.deadline, Date.now() + 30000);
    }
    if (quiescing && !(isCriticalRequest(service, method) && method === 'Heartbeat')) throw quiescingError();
    if (!isCriticalRequest(service, method) && businessSuspended) throw suspendedError();
    if (!isCriticalRequest(service, method) && isHealthBackoffActive()) throw backoffError();
    throwIfRequestCancelled(options);
    if (!(loggedIn && sock && !sock.destroyed && !detached)
        && !(isCriticalRequest(service, method) && method === 'Login' && sock && !sock.destroyed && !detached)) {
        throw requestError('网关连接不可用', { errorCode: 'CONNECTION_UNAVAILABLE', stage: 'queue' });
    }
    if (!isSafeReadRequest(service, method)) {
        return sendRequest(service, method, body, { ...options, assertCanSend: meta?.assertCanSend }, false);
    }
    // 场景租约拥有原始结算Promise，不能被普通只读订阅者提前取消/到期后误触发恢复。
    if (isSceneRequestOwned()) return sendRequest(service, method, body, options, true);
    const session = { socket: sock, epoch: connectionEpoch, accountId, gate: requestGate, remoteGeneration };
    return safeFlights.run({ accountId, epoch: connectionEpoch, service, method, body, context: options,
        execute: ({ signal, markSent, validateWaiters, deadline, setOnNoWaiters }) => sendRequest(service, method, body,
            { ...options, signal, validateWaiters, deadline, setOnNoWaiters }, true, markSent, session) });
}
function getRequestQueueSnapshot() { return requestGate.snapshot(); }
function getOldestPendingStartedAt() { return pendingStartedAt.size ? Math.min(...pendingStartedAt.values()) : 0; }
function getDiagnosticSnapshot() {
    return { accountId, connectionEpoch, remoteGeneration, remoteGenerationSource: 'gateway', loggedIn, businessSuspended,
        connected: isConnected(), detached, quiescing, pending: pending.size,
        pendingWrites: getPendingWriteCount(), actualSent: [...pending.values()].filter(item => item.actualSent).length,
        pendingActualWrites: [...pending.values()].filter(item => !item.read && !item.critical && item.actualSent).length,
        deadlines: [...pending.entries()].map(([seq, item]) => ({ seq, readOnly: item.read, critical: item.critical,
            actualSent: item.actualSent, sentAt: item.sentAt, settlementDeadline: item.settlementDeadline, timeoutDeadline: item.timeoutDeadline })),
        oldestPendingStartedAt: getOldestPendingStartedAt(), queue: requestGate.snapshot(),
        reads: safeFlights.snapshot(), healthBackoff: getHealthBackoffState() };
}
function detach() {
    detached = true;
    loggedIn = false;
    businessSuspended = false;
    onLoginReady = null;
    advanceEpoch('业务 worker 已脱离网关，会话保持', true);
    const current = sock;
    sock = null;
    if (current && !current.destroyed) current.destroy();
}
function stop(id) {
    try { sendFrame({ t: 'stop', accountId: String(id) }); }
    finally { detach(); }
}
function getUserState() { return userState; }
function getAceStatus() { return { running: false, runtime: 'gateway' }; }
function attach({ handleNotify, onLogin } = {}) { handleNotifyFn = handleNotify; onLoginCb = onLogin; }

module.exports = {
    attach, connect, sendMsgAsync, stop, detach, networkEvents, getUserState, getAceStatus, getWs, isConnected,
    getRequestQueueSnapshot, getOldestPendingStartedAt, getDiagnosticSnapshot, cancelQueued,
    getPendingWriteCount, quiesceAndDrain,
    setHealthBackoff, clearHealthBackoff, isHealthBackoffActive, getHealthBackoffState,
};
