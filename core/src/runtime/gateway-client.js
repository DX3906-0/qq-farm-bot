/**
 * 网关客户端（worker 侧）
 *
 * 在 FARM_NETWORK_MODE=gateway 时，worker 不再直连游戏服务器，而是通过本地
 * Unix Socket 把请求转发给独立的「连接网关进程」(gateway-process.js)。网关进程
 * 唯一持有 WebSocket 连接、心跳、加密与登录态。worker 重启/热更不会断开连接。
 *
 * 服务端推送（notify）由网关回传原始二进制帧，本客户端交给 worker 本地
 * network.js 的 handleNotify 解码（逻辑不重复）。业务请求由本客户端分配本地
 * seq 匹配网关回传的 response。
 */

const net = require('net');
const { EventEmitter } = require('events');
const { encodeFrame, decodeFrame, toBase64, fromBase64 } = require('./gateway-protocol');
const { createRequestGate, getRequestPriority } = require('../utils/request-priority');
const { log, logWarn } = require('../utils/utils');

const DEFAULT_SOCK = process.env.FARM_GATEWAY_SOCK || '/tmp/qq-farm-gateway.sock';

let sock = null;
let buf = '';
let loggedIn = false;
let nextSeq = 1;
const pending = new Map();
// 请求优先级闸门（移植自上游）：按优先级排序、限制并发，避免业务请求洪峰挤占关键请求
const requestGate = createRequestGate({ maxActive: 8, maxQueued: 100 });
const pendingStartedAt = new Map();
const networkEvents = new EventEmitter();
let handleNotifyFn = null;
let onLoginReady = null;
let onLoginCb = null;
const userState = { gid: 0, name: '', level: 0, gold: 0, exp: 0, openId: '', avatar: '' };

// ============ ⭐ 网关亚健康退避闸门（2026-11-01 统一收口）============
// 背景缺陷：网关侧在"业务请求连续超时 2 次"时会发 connection_degraded，通知 worker 暂停业务
// 请求、把带宽留给心跳自愈。但 worker 侧原来的实现只在 `runUnifiedTick` 一处检查
// isGatewayHealthyBackoffActive()，而 worker 有 10+ 个独立业务入口
// （runDailyRoutines / runFarmTick / runHelpTick / runStealTick / runEmailAutoClaim /
//   runPetFoodAutoFeed / runMysteryShopAutoBuy / runStarActivityAutoClaims ...），
// 这些入口**完全无视退避**，继续往一条已假死的连接上打请求 →
//   pendingCallbacks 堆积 → 网关侧 requestTimeoutStreak 继续累加 → 更快判死重连 →
//   重连消耗一次性 Code → 1006。这正是"判死阈值调大反而更容易判死"的间接成因。
//
// 修法：把闸门下沉到**所有 gateway 请求的唯一必经之路**（sendMsgAsync），
// 逐个改 10 个业务入口既易漏又易回退，收口在传输层才能真正全覆盖。
//
// 设计要点（避免误伤）：
//   1. **只拦业务请求**：心跳/登录/ACE 等关键路径优先级为 critical，永远放行；
//      退避的意义就是"给心跳让路"，把心跳也拦住就本末倒置了。
//   2. **快速失败不排队**：退避期内直接 reject（带明确原因），让调用方按既有
//      `catch` 走 `skipped` 分支；绝不入队等待，否则退避结束会瞬间涌出一批陈旧请求。
//   3. **默认放行**：backoffUntil=0 时零开销，不影响正常路径。
let healthBackoffUntil = 0;
let healthBackoffReason = '';

/** 由 worker 的 connection_degraded 处理器调用，进入退避窗口 */
function setHealthBackoff(ms, reason) {
    const dur = Number(ms) || 0;
    if (dur <= 0) return;
    const until = Date.now() + dur;
    // 只延长不缩短：多次 degraded 信号叠加时取最晚到期时间
    if (until > healthBackoffUntil) healthBackoffUntil = until;
    healthBackoffReason = String(reason || '业务请求连续超时');
}

/** 由 connection_recovered 处理器调用，立即解除退避 */
function clearHealthBackoff() {
    healthBackoffUntil = 0;
    healthBackoffReason = '';
}

/** 当前是否处于退避窗口（过期自动解除，无需外部 timer） */
function isHealthBackoffActive() {
    if (!healthBackoffUntil) return false;
    if (Date.now() >= healthBackoffUntil) {
        healthBackoffUntil = 0;
        healthBackoffReason = '';
        return false;
    }
    return true;
}

function getHealthBackoffState() {
    return {
        active: isHealthBackoffActive(),
        remainingMs: healthBackoffUntil ? Math.max(0, healthBackoffUntil - Date.now()) : 0,
        reason: healthBackoffReason,
    };
}

/**
 * 关键请求白名单：退避期内仍然放行。
 * 判定依据是「这条请求是否服务于连接存活本身」——退避的目的就是给它们让路，
 * 把它们也拦掉等于自断生路。
 *
 * 实测核对（2026-11-01）：
 *   - 网关侧真正的心跳由 gateway-process.js 自己发（sendMsg(..., 'Heartbeat', {isHeartbeat:true})），
 *     走的是 gameserver WebSocket，**不经过本函数**，因此这里不列也不会被误拦。
 *   - 但 network.js:753 在**直连模式**下也会用 sendMsgAsync 发 Heartbeat，
 *     为兼容该分支，这里仍列入白名单。
 */
const _CRITICAL_METHODS = new Set([
    'Heartbeat',
    'Login',
    'Logout',
    'Kickout',
    'Reconnect',
]);
const _CRITICAL_SERVICE_HINTS = /UserService|LoginService|AceService|SecurityService/i;

function _isCriticalRequest(service, method) {
    const m = String(method || '');
    if (_CRITICAL_METHODS.has(m)) return true;
    const s = String(service || '');
    // 只对明确属于连接/安全链路的 Service 放行；业务 Service（farm/friend/shop 等）一律拦
    if (_CRITICAL_SERVICE_HINTS.test(s) && /login|heartbeat|ace|security/i.test(m)) return true;
    return false;
}

function isConnected() { return loggedIn; }
function getWs() { return null; }

function ensureSocket() {
    if (sock && !sock.destroyed) return sock;
    buf = '';
    sock = net.connect(DEFAULT_SOCK, () => {
        log('网关', '已连接本地连接网关进程');
    });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.trim()) handleFrame(decodeFrame(line));
        }
    });
    sock.on('close', () => {
        sock = null;
        loggedIn = false;
        pendingStartedAt.clear();
        networkEvents.emit('disconnect', { code: 'gateway_close' });
    });
    sock.on('error', (e) => {
        logWarn('网关', `socket 错误: ${e.message}`);
    });
    return sock;
}

function sendFrame(obj) {
    const s = ensureSocket();
    if (!s || s.destroyed) return false;
    s.write(encodeFrame(obj) + '\n');
    return true;
}

function handleFrame(frame) {
    if (!frame) return;
    const { accountId } = frame;
    switch (frame.t) {
        case 'login':
            loggedIn = true;
            if (onLoginCb && frame.userState) onLoginCb(frame.userState);
            if (onLoginReady) onLoginReady();
            break;
        case 'response': {
            const p = pending.get(frame.seq);
            if (p) {
                pending.delete(frame.seq);
                pendingStartedAt.delete(frame.seq);
                if (p.timer) clearTimeout(p.timer);
                if (frame.error) p.reject(new Error(frame.error));
                else p.resolve({ body: fromBase64(frame.body), meta: frame.meta || {} });
            }
            break;
        }
        case 'notify':
            if (handleNotifyFn && frame.body) {
                try { handleNotifyFn(fromBase64(frame.body)); } catch (e) { logWarn('网关', `notify 解码失败: ${e.message}`); }
            }
            break;
        case 'event':
            networkEvents.emit(frame.name, frame.payload || {});
            break;
        case 'error':
            logWarn('网关', `account ${accountId} 错误: ${frame.message}`);
            networkEvents.emit('ws_error', { code: 0, message: frame.message });
            break;
        case 'pong':
            break;
        default:
            break;
    }
}

function connect(accountId, code, onReady) {
    onLoginReady = onReady;
    sendFrame({
        t: 'connect',
        accountId: String(accountId),
        code: String(code || ''),
        platform: process.env.FARM_PLATFORM || 'android',
        os: process.env.FARM_OS || 'android',
        clientVersion: process.env.FARM_CLIENT_VERSION || '',
    });
    // 心跳保持 socket 活跃
    sendFrame({ t: 'ping' });
}

// 兜底超时：网关侧 30s 超时会先回错误帧，这里是第二道保险（防网关侧帧丢失/进程异常）
const WORKER_REQUEST_TIMEOUT_MS = 60000;

async function sendMsgAsync(service, method, bodyBytes, meta, serviceObj) {
    // ⭐ 亚健康退避闸门（2026-11-01）：退避窗口内拒绝业务请求，把连接让给心跳自愈。
    // 必须放在 requestGate.acquire 之前——否则请求会先占住并发槽位再被拒，
    // 8 个槽位在退避期内被快速空转占满，反而挤掉了心跳这类 critical 请求。
    // 关键路径白名单：心跳/登录/登出/ACE 永不放行拦截，退避的目的就是给它们让路。
    if (healthBackoffUntil) {
        const isCritical = _isCriticalRequest(service, method);
        if (!isCritical && isHealthBackoffActive()) {
            const remainS = Math.ceil((healthBackoffUntil - Date.now()) / 1000);
            throw new Error(`网关亚健康退避中(${healthBackoffReason})，剩余 ${remainS}s，暂停业务请求给心跳让路`);
        }
    }
    // 优先级闸门：先排队（critical 优于 farm/friend/background），再占用并发槽位。
    // 优先级由调用方通过 runWithRequestPriority() 在异步上下文中传递，故此处签名无需变更。
    const release = await requestGate.acquire(getRequestPriority());
    try {
        const seq = nextSeq++;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(seq);
                pendingStartedAt.delete(seq);
                reject(new Error('网关请求超时'));
            }, WORKER_REQUEST_TIMEOUT_MS);
            pending.set(seq, { resolve, reject, timer });
            pendingStartedAt.set(seq, Date.now());
            const ok = sendFrame({
                t: 'request',
                accountId: String(process.env.FARM_ACCOUNT_ID),
                seq,
                service,
                method,
                body: toBase64(bodyBytes),
            });
            if (!ok) {
                clearTimeout(timer);
                pending.delete(seq);
                pendingStartedAt.delete(seq);
                reject(new Error('网关连接不可用'));
            }
        });
    } finally {
        release();
    }
}

/** 请求队列快照（供健康检查/诊断使用） */
function getRequestQueueSnapshot() {
    return requestGate.snapshot();
}

/** 最老的在途请求开始时间戳（毫秒），无在途请求返回 0 */
function getOldestPendingStartedAt() {
    if (pendingStartedAt.size === 0) return 0;
    return Math.min(...pendingStartedAt.values());
}

function stop(accountId) {
    sendFrame({ t: 'stop', accountId: String(accountId) });
    loggedIn = false;
}

function getUserState() { return userState; }
function getAceStatus() { return { running: false, runtime: 'gateway' }; }

function attach({ handleNotify, onLogin } = {}) {
    handleNotifyFn = handleNotify;
    onLoginCb = onLogin;
}

module.exports = {
    attach,
    connect,
    sendMsgAsync,
    stop,
    networkEvents,
    getUserState,
    getAceStatus,
    getWs,
    isConnected,
    getRequestQueueSnapshot,
    getOldestPendingStartedAt,
    // 亚健康退避闸门（2026-11-01）：所有业务请求的统一收口点
    setHealthBackoff,
    clearHealthBackoff,
    isHealthBackoffActive,
    getHealthBackoffState,
};
