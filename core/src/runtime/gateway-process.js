/**
 * 连接网关进程 (gateway-process)
 *
 * 独立长期运行的进程，唯一持有游戏 WebSocket 连接、心跳、加密与登录态。
 * 每个账号一个 Conn 对象（按 accountId 索引）。worker 进程通过本地 Unix Socket
 * 把请求转发过来，网关代发游戏并把响应/服务端推送回传 worker。
 *
 * 这样 worker 进程（业务逻辑）可随意重启/热更而不会断开游戏连接 —— 部署零掉线。
 *
 * 入口由 runtime-engine 在 FARM_NETWORK_MODE=gateway 时 fork 启动。
 * 连接层协议严格对齐 network.js（GateMessage/LoginRequest/TsdkRuntime/AceService）。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { log, logWarn, toLong, toNum } = require('../utils/utils');
const cryptoWasm = require('../utils/crypto-wasm');
const { types, loadProto } = require('../utils/proto');
const { TsdkRuntime } = require('../utils/tsdk-runtime');
const { AceService } = require('../services/ace-service');
const { createGatewayToken } = require('../utils/gateway-token');
const { getDataDir } = require('../config/runtime-paths');
const { getOldestPendingAgeMs, evaluateGatewayHealth } = require('../utils/gateway-health');
const { isSafeReadRequest } = require('../utils/request-priority');

// 独立微信实例使用专属凭据目录；主网关不得读写其滚动 token。
const ISOLATED_WX_GATEWAY = process.env.FARM_WX_GATEWAY === '1';
const WX_LOGIN_DIR = path.join(getDataDir(), ISOLATED_WX_GATEWAY ? 'wx-gateway' : 'wx-login');
const WX_APP_ID = 'wx5306c5978fdb76e4';

// 延迟加载 store 模块避免循环依赖（与 network.js 同款实现）
let storeModule = null;
function getStoreModule() {
    if (!storeModule) storeModule = require('../models/store');
    return storeModule;
}

const SOCK_PATH = process.env.FARM_GATEWAY_SOCK || '/tmp/qq-farm-gateway.sock';

/** 隔离实例只托管微信2号；主网关重启后也不得重新抢占委托账号。 */
function gatewayOwnsAccount(accountId, requireActive = true) {
    if (requireActive && require('../services/account-maintenance-hold').isAccountMaintenanceHeld(accountId)) return false;
    const { readGatewayDelegation } = require('./gateway-routing');
    const delegation = readGatewayDelegation();
    if (ISOLATED_WX_GATEWAY) {
        return SOCK_PATH === '/sock/qq-farm-wx.sock'
            && String(accountId) === '2'
            && !!delegation
            && delegation.accountIds.includes('2')
            && (!requireActive || delegation.phase === 'active');
    }
    return !delegation || String(accountId) !== '2';
}
const HEARTBEAT_TIMEOUT = 30000;
const MAX_HEARTBEAT_MISS = 6; // 有界告警计数，绝不单凭 HB miss 判死
const RECONNECT_ALERT_AFTER = 30; // 重连达此次数发一次告警（Code 可能失效），但仍持续重试不放弃
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Code 一次性：连续失效达此次数后停止自动重连，避免反复重复登录把仍存活的旧 session 顶下线
const CODE_INVALID_MAX = 6;
// 【亚健康退避】连接亚健康（业务请求开始连续超时，但还没到判死阈值）时，通知 worker 暂停发业务请求、
// 给心跳让路自愈。核心思路来自上游社区（health-backoff gate）：凌晨服务端一静默，请求会一个接一个
// 挂十几十秒；若 worker 仍按固定间隔发农场/好友任务，pending 队列会被打满、连心跳都排不上，最终判死掉线。
// 业务超时先送出 degraded 信号；次数只控制退避，不作为判死时长，
// 让 worker 主动退避、把连接留给心跳+ACE，从根上避免"假死→判死→重连被拒→崩溃停拉"的恶性链条。
const HEALTH_DEGRADED_STREAK = 2;          // 已发送业务超时达到两次即通知退避
const HEALTH_BACKOFF_BASE_MS = 30000;      // 亚健康退避基数（首次退避时长）
const HEALTH_BACKOFF_MAX_MS = 180000;      // 亚健康退避上限（指数退避封顶 3 分钟）
// QQ Code 失效防风暴策略：QQ code 可复用，存储/重连的短暂重试放宽至不断（且成功即清零，不误伤）；
// 但若 code 真已失效（如抓包后长时间未用、登录态被删），会持续 1006/建连失败。若无上限，
// 单账号会在网关里无限重连冲撞 gameserver、拖垮同网关其它账号。故设一个宽松上限兜底，超限即停并告警。
const QQ_CODE_INVALID_MAX = 20;
// 微信换码（MMTLS 握手）超时：服务器环境实测可能长时间挂起，超时即放弃换码走原逻辑
const WX_ISSUE_TIMEOUT_MS = 20000;
// 微信 loginBuffer 续期（refreshtoken → 新 loginBuffer）超时：这是 HTTP 接口，通常很快，
// 但仍需兜底避免卡死整个 reconnect（海外服务器连国内接口可能很慢）
const WX_REFRESH_TIMEOUT_MS = 30000;
// 心跳超时处理原则：绝不主动断开 / 重连。
// code 一次性，连接一旦被 bot 主动退出就要再消耗一个 code 才能重连；QQ 账号无自动换码能力，
// 若没及时抓包就永久掉线——这远比"前端暂时看不了数据"严重。因此只要底层 ws 仍 OPEN（连接未断）
// 就保持连接，网络 / 服务器恢复后心跳会自动续上；只有真正断链（ws close/error 事件）才由
// scheduleReconnect 驱动重连。早期"判死自愈主动断开"（HEARTBEAT_DEAD_MISS）已彻底移除：它会在网络
// 抖动时误杀活连接、消耗一次性 code，是导致账号无故掉线的根因。
// worker 业务请求在网关侧的超时：假死时请求发到死连接永不回包，必须超时快速失败，
// 否则 worker 侧 Promise 永久挂起，前端表现为"什么都加载不出来"
const WORKER_REQUEST_TIMEOUT_MS = 30000;
// 判死使用真实 210 秒静默窗口，不能把并发 RPC 的超时次数相乘当作时间。
// 还须业务无响应、HB/ACE 未恢复且同一 WS 连接稳定；具体见 isTrulySilent。
// 【假死重连风暴防护】判死后重连若仍不通（Code/loginBuffer 已失效：连得上但服务器不回业务包），
// 会在约 150s 后再次判死并再次重连，若无上限即形成"每 2 分钟重连一次"的无限风暴
// （实测 3 小时内单个账号触发 100 次）。gateway 是单进程 Node，风暴会拖垮事件循环，
// 使同一网关下其它账号的业务请求全部超时 → 被连带判死 → 无辜掉线（2026-09-02 QQ 号被微信账号风暴拖死）。
// 故：连续判死重连超过上限即停止并告警（需人工重抓/扫码），不再无限重试。
// 判死重连上限（分平台）：
//   - 微信：靠 loginBuffer 自动换码（refreshtoken 续期），重连路径自愈能力强，3 次足够区分"抖动/真失效"。
//   - QQ：code 可复用（已实测验证），断线后只要能拿 savedCode 重连成功就能自愈；腾讯侧判死/回收又相对频繁
//     （约 4 小时一次，且抖动误判也不少）。若沿用微信共享的 3 次上限，QQ 会在"只是短暂抖动/服务器瞬时限流"
//     时而早早停拉，错失靠 savedCode 自动续命的机会，只能回到人工重抓。故对 QQ 放大该上限，
//     它仍被 QQ_CODE_INVALID_MAX(20) 这个真正的防风暴闸门兜底（码真失效累计 20 次 1006/建连失败才会停），
//     不会因此形成重连风暴拖垮同网关其它账号。微信保持不变。
const WX_DEAD_RECONNECT_MAX = 3;
const QQ_DEAD_RECONNECT_MAX = 10;
// 取当前账号适用的判死重连上限
function getDeadReconnectMax(account) {
    return account.platform === 'wx' ? WX_DEAD_RECONNECT_MAX : QQ_DEAD_RECONNECT_MAX;
}
// 多次判死重连之间的递增退避基数（第 1 次立即重连，之后每次多等 60s），避免密集冲击 gameserver
// 【2026-09-05 QQ 降频】原"第 1 次立即重连 + 60s 递增"在客户端断线时会立刻重建 WS、再判再重连，
// 形成"几分钟内高频反复建连冲撞 gameserver"的机器特征，加速 QQ code 失效（8 月无 gateway 时
// 连接层"安静挂着"反而更稳）。故 QQ 改走 getDeadReconnectBackoffMs 的专属慢节奏：
//   首次也要退避（不再立即冲），且基数拉大到 3 分钟、上线 10 分钟，断线→重连节奏显著放缓。
const DEAD_RECONNECT_BACKOFF_MS = 60000;
// QQ 判死重连退避节奏：首次即退避（不再立即冲），保底不密集冲击 gameserver
const QQ_DEAD_BACKOFF_BASE_MS = 180000;   // QQ 判死重连退避基数（3 分钟）
const QQ_DEAD_BACKOFF_MAX_MS = 600000;    // QQ 判死重连退避上限（10 分钟）
function getDeadReconnectBackoffMs(account, nth) {
    // nth: 本次是第几次判死重连（1 起）
    if (account && account.platform === 'wx') {
        // 微信：自愈强（loginBuffer 自动换码），保持原节奏
        return DEAD_RECONNECT_BACKOFF_MS * Math.max(1, nth - 1);
    }
    // QQ：首次也要避、基数大 → 慢节奏，降低高频重连对 code 存续的伤害
    const extra = Math.max(0, nth - 2); // 首次用基数，之后逐步累加
    const ms = QQ_DEAD_BACKOFF_BASE_MS * (1 + extra);
    return Math.min(QQ_DEAD_BACKOFF_MAX_MS, ms);
}

// ===== 全局风控熔断（2026-09-09 三账号被封 7 天复盘后新增）=====
// 背景：close code=1006 = 连接被服务器异常关闭，绝大多数情况是**腾讯风控拒连/封禁**，
// 而不是"网络抖动"。旧逻辑有两个致命缺陷：
//   ① 清零过松：登录成功 / 收到任意回包即 deadReconnectCount=0。于是"连上→3 秒后 1006"
//      的循环里计数永远归零，DEAD_RECONNECT_MAX 上限形同虚设（实测微信每 14 秒一次、持续数小时）。
//   ② 只有单账号维度：三号同网关互相拖累，没有全局视角。
// 新增两层防护：
//   A. 短命会话检测：连接存活不足 SHORT_SESSION_MS 就被 1006 → 记一次"短命会话"；
//      连续多次即判定疑似风控，停止该账号自动重连（宁可等人来处理，也不继续冲撞）。
//   B. 全局 1006 风暴：跨账号统计窗口内 1006 次数，超阈值 → 整个网关暂停重连，避免多号互相拖累。
// 另：故障计数只在"会话稳定存活 STABLE_SESSION_MS 以上"时才清零（真健康才算恢复）。
const SHORT_SESSION_MS = 90000;       // 会话存活不足 90 秒即视为"短命"（风控秒踢的典型特征）
const SHORT_SESSION_MAX = 3;          // 连续短命会话上限，达到即停止该账号自动重连并告警
const STABLE_SESSION_MS = 300000;     // 会话稳定存活 5 分钟以上才算"真健康"，才清零故障计数
const GLOBAL_1006_WINDOW_MS = 600000; // 全局 1006 统计窗口（10 分钟）
const GLOBAL_1006_MAX = 12;           // 窗口内 1006 次数上限（三号同网关 ≈ 每号 4 次）
const GLOBAL_PAUSE_MS = 3600000;      // 触发全局风暴后暂停重连时长（1 小时）
const GLOBAL_PAUSE_ALERT_COOLDOWN_MS = 600000; // 暂停期间的告警节流

const globalStorm = {
    events: [],      // 最近一次 1006 的时间戳数组（滑动窗口）
    pausedUntil: 0,  // 全局暂停截止时间
    lastAlertAt: 0
};

// 记录一次全局 1006，并检查是否触发全局熔断
function noteGlobal1006() {
    const now = Date.now();
    globalStorm.events.push(now);
    globalStorm.events = globalStorm.events.filter(t => now - t <= GLOBAL_1006_WINDOW_MS);
    if (globalStorm.events.length >= GLOBAL_1006_MAX && now >= globalStorm.pausedUntil) {
        globalStorm.pausedUntil = now + GLOBAL_PAUSE_MS;
        globalStorm.events = [];
        logWarn('gateway', `[风控熔断] ${Math.round(GLOBAL_1006_WINDOW_MS / 60000)} 分钟内全网累计 ${GLOBAL_1006_MAX} 次 1006（疑似腾讯风控/封禁），全局暂停自动重连 ${Math.round(GLOBAL_PAUSE_MS / 60000)} 分钟，请人工确认账号状态`);
        emitEventToAll('global_reconnect_paused', {
            until: globalStorm.pausedUntil,
            pauseMs: GLOBAL_PAUSE_MS,
            reason: 'global_1006_storm'
        });
    }
}

// 当前是否处于全局重连暂停期（含告警节流日志）
function globalReconnectPaused(account) {
    const now = Date.now();
    if (now >= globalStorm.pausedUntil) return false;
    if (now - globalStorm.lastAlertAt > GLOBAL_PAUSE_ALERT_COOLDOWN_MS) {
        globalStorm.lastAlertAt = now;
        const leftMin = Math.round((globalStorm.pausedUntil - now) / 60000);
        logWarn('gateway', `[风控熔断] 全局重连暂停中（剩余 ${leftMin} 分钟），account ${account ? account.accountId : '-'} 跳过本次重连`);
    }
    return true;
}

// 会话已稳定存活足够久 → 认定真健康，清零故障计数（否则保留，避免"秒连秒断"绕过熔断）
function clearFaultsIfSessionStable(account) {
    if (!account.connectedAt) return;
    if (Date.now() - account.connectedAt < STABLE_SESSION_MS) return;
    if (account.deadReconnectCount || account.shortSessionCount) {
        log('gateway', `account ${account.accountId} 会话已稳定 ${Math.round(STABLE_SESSION_MS / 60000)} 分钟，清零故障计数（判死重连 ${account.deadReconnectCount} / 短命会话 ${account.shortSessionCount}）`);
    }
    account.deadReconnectCount = 0;
    account.deadReconnectAlerted = false;
    account.shortSessionCount = 0;
    account.shortSessionAlerted = false;
}

function logAce(level, message) {
    if (level === 'error') logWarn('ACE', message);
    else log('ACE', message);
}

// accountId -> Conn
const accounts = new Map();
let gatewayShuttingDown = false;
let gatewayShutdownFlight = null;
const shutdownWrites = new Set();
let finishShutdownDrain = null;

function getAccount(accountId) { return accounts.get(String(accountId)); }

function ensureAccountDir(accountId) {
    const dir = path.join(process.env.DATA_DIR || '/app/data', 'accounts', String(accountId));
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    return dir;
}

function createConn(accountId) {
    return {
        accountId: String(accountId),
        ws: null,
        tsdkRuntime: null,
        aceService: null,
        clientSeq: 0,
        serverSeq: 0,
        pendingCallbacks: new Map(), // clientSeq -> callback 对象
        userState: { gid: 0, name: '', level: 0, gold: 0, exp: 0, openId: '', avatar: '' },
        initialGamePackInfo: '',
        savedCode: null,
        platform: '',
        networkStopped: false,
        reconnectAttempts: 0,
        // 连续 Code 失效计数：Code 一次性，失效后反复重连等于反复登录，会把仍存活的旧 session 顶下线
        codeInvalidCount: 0,
        // 亚健康退避计数：通知 worker 退避让心跳自愈的次数（用于指数退避时长与日志）
        degradedStreak: 0,
        healthBackoffChanging: false,    // 防止同一安抚期间重复连发 degraded（节流）
        // 连续"判死重连"计数：假死后重连若仍不通会再次判死，达上限即停止（防重连风暴拖垮网关）
        deadReconnectCount: 0,
        deadReconnectAlerted: false,
        // 风控熔断：短命会话（建连后很快被 1006）连续次数，达上限即停止自动重连并告警
        shortSessionCount: 0,
        shortSessionAlerted: false,
        // 本次连接建立时间：用于判断会话是否"短命"、是否已稳定存活（决定能否清零故障计数）
        connectedAt: 0,
        // 是否已成功登录过：QQ 一次性 Code 登录即用即废，置位后断链重连不能再拿同一 Code 冲服务器（否则被顶号）
        loggedInOnce: false,
        lastHeartbeatResponse: 0,
        heartbeatMissCount: 0,
        heartbeatTimer: null,
        workerSock: null,
        deviceProtocol: null,
        // 微信 loginBuffer 换码连续失败计数：ManualAuth 被拒（登录态失效）后重试无意义，
        // 累计达阈值即停止自动重连并告警，避免无限 1006 刷屏把日志打爆
        wxCodeFailCount: 0,
        wxBufferAlerted: false,
        // 票据陈旧需扫码告警：只发一次，登录成功/新扫码后复位，避免每轮重试都刷屏。
        wxRescanAlerted: false,
        // ⭐ 2026-11-01 排查补充：以下三个字段由 10-31 的改动引入，必须在此显式初始化。
        // 缺省会依赖 `undefined || 0` 的隐式兜底，一旦某处写成 `account.x += 1` 就变 NaN 且永久污染。
        // wxTempFailCount：临时性换码失败计数（40188/超时/网络），与 wxCodeFailCount 分开，
        //   避免网络抖动被误判成"凭证失效、必须扫码"。
        wxTempFailCount: 0,
        wxRetryAfter: 0,
        // wxLastCodeError：最近一次换码失败原因，供 classifyWxCodeError 判定临时/永久。
        wxLastCodeError: '',
        // connectingAt：建连闸门时间戳。>0 且距今 <5s 时拒绝重复 connect，
        //   防止同一账号并发建连产生"孤儿 socket"（服务器侧同 code 多连接 → 顶号/1006）。
        connectingAt: 0,
        connectionEpoch: 0,
        wxConnectFlight: null,
        wxConnectController: null,
        wxIssueFlight: null,
        wxCredentialGeneration: '',
        loginPromise: null,
        finishLogin: null,
        lastGameResponseAt: 0,
        connectionDead: false,
        sendQueue: [],
        operations: new Set(),
        criticalFlights: new Map(),
        sendDraining: false,
        requestTimeoutStreak: 0,
        businessNoResponseSince: 0,
        lastInboundAt: 0,
        lastBusinessReplyAt: 0,
        lastBusinessSuccessAt: 0,
        lastAceResponseAt: 0,
        healthBackoffTimer: null,
        healthBackoffUntil: 0,
        healthEpoch: 0,
        deadConfirmTimer: null,
        deadReconnectTimer: null,
        reconnectTimer: null,
        reconnectGeneration: 0,
        workerSession: 0,
        workerSocketSerial: 0,
    };
}

// ============ 编码与发送 ============
const BUSINESS_REQUEST_LIMIT = 32;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const DEAD_SILENCE_MS = 210000;
const MAX_REQUEST_TIMEOUT_MS = 60000;
const WRITE_SETTLEMENT_TIMEOUT_MS = 120000;

function boundedRequestTimeoutMs(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(value))) : WORKER_REQUEST_TIMEOUT_MS;
}

function armOperationTimeout(account, op, at) {
    clearTimeout(op.timer);
    const timer = setTimeout(() => {
        if (op.timer !== timer || op.done) return;
        const current = operationCurrent(account, op);
        finishOperation(account, op, requestError('网关请求超时', 'REQUEST_TIMEOUT', op));
        if (current && op.sent && op.kind === 'business') noteBusinessTimeout(account, op.sentAt);
    }, Math.max(1, at - Date.now()));
    op.timer = timer;
}

function requestKind(service, method) {
    if (service === 'gamepb.userpb.UserService' && method === 'Heartbeat') return 'heartbeat';
    if (service === 'gamepb.acepb.AceService' && method === 'AntiData') return 'ace';
    if (service === 'gamepb.userpb.UserService' && ['Login', 'PlayerLogin'].includes(method)) return 'login';
    return 'business';
}

function operationCurrent(account, op) {
    return !op.done && !account.networkStopped && account.ws === op.socket
        && account.tsdkRuntime === op.runtime && account.connectionEpoch === op.epoch
        && op.socket && op.socket.readyState === op.socket.OPEN;
}

function requestError(message, code, op) {
    const outcomeUnknown = !!op?.sent && !op.read;
    return Object.assign(new Error(message), {
        code, errorCode: code, stage: op?.sent ? 'response' : 'queue_or_encoding',
        sent: !!op?.sent, outcomeUnknown, retryable: false,
        resultState: !op?.sent ? 'not_sent' : outcomeUnknown ? 'unknown' : 'failed',
        connectionEpoch: op?.epoch,
    });
}

function respondOperationError(account, op, error) {
    if (op.waiterDetached) return;
    const cb = op.callback;
    if (cb.reject) cb.reject(error);
    else if (cb.workerSock && cb.workerSeq != null) sendFrame(cb.workerSock, {
        t: 'response', accountId: account.accountId, seq: cb.workerSeq,
        error: error.message, body: '', meta: {
            errorCode: error.code, stage: error.stage, sent: error.sent,
            outcomeUnknown: error.outcomeUnknown, retryable: false, resultState: error.resultState,
            timeoutMs: op.timeoutMs, settlementTimeoutMs: op.settlementTimeoutMs || 0,
            sentAt: op.sentAt || 0,
            ...(error.retryAfterMs != null ? { retryAfterMs: error.retryAfterMs } : {}),
            ...(error.serverSeq != null ? { serverSeq: error.serverSeq } : {}),
            ...(error.service ? { service: error.service, method: error.method } : {}),
        },
    }, op.epoch);
}

function finishOperation(account, op, error) {
    if (op.done) return;
    op.done = true;
    clearTimeout(op.timer);
    account.operations.delete(op);
    account.sendQueue = account.sendQueue.filter(value => value !== op);
    if (account.pendingCallbacks.get(op.seq) === op.callback) account.pendingCallbacks.delete(op.seq);
    if (account.criticalFlights.get(op.kind) === op) account.criticalFlights.delete(op.kind);
    op.cancelEncoding();
    op.finishSend(op.sent ? op.seq : -1);
    try {
        if (error) respondOperationError(account, op, error);
    } finally {
        if (shutdownWrites.delete(op) && shutdownWrites.size === 0 && finishShutdownDrain) finishShutdownDrain();
    }
}

function rejectBusinessDuringBackoff(account, op) {
    if (op.sent) return false;
    if (gatewayShuttingDown) {
        finishOperation(account, op, requestError('网关正在排空关闭，未发送请求已取消', 'GATEWAY_SHUTTING_DOWN', op));
        return true;
    }
    if (op.kind !== 'business' || Date.now() >= account.healthBackoffUntil) return false;
    const error = requestError('网关业务健康退避中', 'HEALTH_BACKOFF', op);
    error.retryAfterMs = account.healthBackoffUntil - Date.now();
    finishOperation(account, op, error);
    return true;
}

function cancelWorkerOperation(account, sock, frame) {
    const op = Array.from(account.operations).find(value => value.callback.workerSock === sock
        && value.callback.workerSeq === frame.seq && value.epoch === account.connectionEpoch);
    if (!op || op.done || op.waiterDetached) return;
    if (!op.sent) {
        finishOperation(account, op, requestError('尚未发送的网关请求已取消', 'REQUEST_CANCELLED', op));
    } else if (isSafeReadRequest(op.service, op.method)) {
        // 已发只读仅解绑等待者；保留实际在途席位和原 deadline，防 cancel 被用来突破上限。
        respondOperationError(account, op, requestError('只读请求等待已取消', 'REQUEST_CANCELLED', op));
        op.waiterDetached = true;
    }
}

async function encodeMsg(account, service, method, bodyBytes, clientSeqValue, op) {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) finalBody = await cryptoWasm.encryptBuffer(finalBody, op.runtime,
        () => operationCurrent(account, op) && Date.now() < op.deadline);
    if (Date.now() >= op.deadline) throw requestError('网关请求超时', 'REQUEST_TIMEOUT', op);
    if (!operationCurrent(account, op)) throw requestError('连接世代已变更，请求已取消', 'STALE_CONNECTION', op);
    const msg = types.GateMessage.create({
        meta: {
            service_name: service, method_name: method, message_type: 1,
            client_seq: toLong(clientSeqValue), server_seq: toLong(account.serverSeq),
        },
        body: finalBody,
        auth_token: account.initialGamePackInfo || createGatewayToken(),
    });
    return types.GateMessage.encode(msg).finish();
}

async function drainSendQueue(account) {
    if (account.sendDraining) return;
    account.sendDraining = true;
    try {
        while (account.sendQueue.length) {
            const criticalIndex = account.sendQueue.findIndex(op => op.kind !== 'business');
            const [op] = account.sendQueue.splice(criticalIndex < 0 ? 0 : criticalIndex, 1);
            if (op.done) continue;
            try {
                if (!operationCurrent(account, op)) throw requestError('WebSocket 未连接或世代已变更', 'STALE_CONNECTION', op);
                if (rejectBusinessDuringBackoff(account, op)) continue;
                op.seq = ++account.clientSeq;
                const encoded = await Promise.race([
                    encodeMsg(account, op.service, op.method, op.body, op.seq, op),
                    op.encodingCancelled,
                ]);
                if (op.done) continue;
                if (Date.now() >= op.deadline) throw requestError('网关请求超时', 'REQUEST_TIMEOUT', op);
                if (!operationCurrent(account, op)) throw requestError('连接世代已变更，请求已取消', 'STALE_CONNECTION', op);
                if (rejectBusinessDuringBackoff(account, op)) continue;
                // 串行只覆盖编码至实际 send，绝不等待游戏回复；超时后的写入绝不重放。
                account.pendingCallbacks.set(op.seq, op.callback);
                op.sent = true;
                op.sentAt = Date.now();
                // 排队期限只约束尚未 wire；发送后读/critical 重新计时，业务写固定保留真实结算窗口。
                op.settlementTimeoutMs = op.kind === 'business' && !op.read
                    ? WRITE_SETTLEMENT_TIMEOUT_MS : op.timeoutMs;
                op.deadline = op.sentAt + op.settlementTimeoutMs;
                armOperationTimeout(account, op, op.deadline);
                op.socket.send(encoded);
                account.initialGamePackInfo = '';
                op.finishSend(op.seq);
                if (op.callback.workerSock && op.callback.workerSeq != null) {
                    try {
                        sendFrame(op.callback.workerSock, {
                            t: 'request_sent', accountId: account.accountId, seq: op.callback.workerSeq,
                            sentAt: op.sentAt, settlementDeadline: op.deadline, readOnly: op.read,
                        }, op.epoch);
                    } catch {
                        // IPC确认丢失不能取消已发游戏写；仍保留原结算timer与席位。
                        logWarn('gateway', `account ${account.accountId} epoch=${op.epoch} 发送确认回传失败，保留游戏请求结算`);
                    }
                }
            } catch (error) {
                finishOperation(account, op, requestError(error.message, error.code || 'SEND_FAILED', op));
            }
        }
    } finally {
        account.sendDraining = false;
    }
}

function sendMsg(account, service, method, bodyBytes, callback = {}) {
    const kind = callback.loginScene === true ? 'login-scene' : requestKind(service, method);
    const op = {
        service, method, body: bodyBytes || Buffer.alloc(0), callback, kind,
        socket: account.ws, runtime: account.tsdkRuntime, epoch: account.connectionEpoch,
        startedAt: Date.now(), sent: false, done: false, read: isSafeReadRequest(service, method),
    };
    op.timeoutMs = boundedRequestTimeoutMs(callback.timeoutMs);
    op.queueDeadline = Math.min(op.startedAt + op.timeoutMs,
        typeof callback.deadline === 'number' && Number.isFinite(callback.deadline) ? callback.deadline : Infinity);
    op.deadline = op.queueDeadline;
    callback.operation = op;
    clearTimeout(callback.timer);
    const sent = new Promise(resolve => { op.finishSend = resolve; });
    op.encodingCancelled = new Promise(resolve => { op.cancelEncoding = () => resolve(null); });
    const businessCount = Array.from(account.operations).filter(value => value.kind === 'business').length;
    if (!operationCurrent(account, op)) {
        finishOperation(account, op, requestError('WebSocket 未连接', 'DISCONNECTED', op));
    } else if (Date.now() >= op.queueDeadline) {
        finishOperation(account, op, requestError('网关请求等待期限已到', 'REQUEST_TIMEOUT', op));
    } else if (rejectBusinessDuringBackoff(account, op)) {
        return sent;
    } else if (op.body.length > MAX_REQUEST_BODY_BYTES || (kind === 'business' && businessCount >= BUSINESS_REQUEST_LIMIT)
        || (kind !== 'business' && account.criticalFlights.has(kind))) {
        finishOperation(account, op, requestError('网关队列已满或关键请求正在执行', 'QUEUE_FULL', op));
    } else {
        account.operations.add(op);
        if (kind !== 'business') account.criticalFlights.set(kind, op);
        armOperationTimeout(account, op, op.queueDeadline);
        account.sendQueue.push(op);
        void drainSendQueue(account);
    }
    return sent;
}

function gatewaySendRequest(account, service, method, bodyBytes, timeout = 20000) {
    return new Promise((resolve, reject) => {
        void sendMsg(account, service, method, bodyBytes, { resolve, reject, timeoutMs: timeout });
    });
}

function rejectAllPending(account, reason) {
    for (const op of Array.from(account.operations)) {
        finishOperation(account, op, requestError(reason, 'REQUEST_CANCELLED', op));
    }
    account.pendingCallbacks.clear();
}

function cancelReconnectTimers(account) {
    account.reconnectGeneration += 1;
    for (const name of ['reconnectTimer', 'deadReconnectTimer']) {
        clearTimeout(account[name]);
        account[name] = null;
    }
}

function clearHealthTimers(account) {
    account.healthEpoch += 1;
    clearTimeout(account.healthBackoffTimer);
    clearTimeout(account.deadConfirmTimer);
    account.healthBackoffTimer = null;
    account.deadConfirmTimer = null;
    account.healthBackoffChanging = false;
    account.healthBackoffUntil = 0;
    account.connectionDead = false;
}

function isTrulySilent(account) {
    const now = Date.now();
    const inbound = account.lastInboundAt || account.connectedAt;
    return !account.networkStopped && !!account.userState.gid && account.ws?.readyState === 1
        && account.businessNoResponseSince > 0 && now - account.businessNoResponseSince >= DEAD_SILENCE_MS
        && now - inbound >= DEAD_SILENCE_MS && now - account.connectedAt >= DEAD_SILENCE_MS
        && (!account.lastHeartbeatResponse || now - account.lastHeartbeatResponse >= DEAD_SILENCE_MS)
        && (!account.lastAceResponseAt || now - account.lastAceResponseAt >= DEAD_SILENCE_MS);
}

function armDeadConfirmation(account) {
    if (gatewayShuttingDown || account.deadConfirmTimer || account.connectionDead || !account.businessNoResponseSince || account.networkStopped
        || !account.userState.gid || account.ws?.readyState !== 1) return;
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    const healthEpoch = account.healthEpoch;
    const due = Math.max(account.businessNoResponseSince, account.lastInboundAt || account.connectedAt,
        account.connectedAt, account.lastHeartbeatResponse, account.lastAceResponseAt) + DEAD_SILENCE_MS;
    const timer = setTimeout(() => {
        if (account.deadConfirmTimer !== timer || account.ws !== socket || account.connectionEpoch !== epoch
            || account.healthEpoch !== healthEpoch || account.networkStopped) return;
        account.deadConfirmTimer = null;
        if (isTrulySilent(account)) confirmDeadConnection(account);
        else if (account.businessNoResponseSince && socket?.readyState === 1) armDeadConfirmation(account);
    }, Math.max(1, due - Date.now()));
    account.deadConfirmTimer = timer;
}

function confirmDeadConnection(account) {
    if (account.connectionDead || !isTrulySilent(account)) return;
    account.connectionDead = true;
    account.deadReconnectCount = Math.min(getDeadReconnectMax(account) + 1, account.deadReconnectCount + 1);
    logWarn('gateway', `account ${account.accountId} epoch=${account.connectionEpoch} 真实静默判死：入站静默 ${Math.floor((Date.now() - (account.lastInboundAt || account.connectedAt)) / 1000)}s，业务无响应 ${Math.floor((Date.now() - account.businessNoResponseSince) / 1000)}s，判死恢复第 ${account.deadReconnectCount} 次`);
    emitEvent(account, 'connection_dead', {
        timeoutStreak: account.requestTimeoutStreak, deadReconnectCount: account.deadReconnectCount,
        lastInboundAt: account.lastInboundAt, businessNoResponseSince: account.businessNoResponseSince,
        silenceMs: Date.now() - (account.lastInboundAt || account.connectedAt),
    });
    cancelReconnectTimers(account);
    if (account.deadReconnectCount > getDeadReconnectMax(account)) {
        account.deadReconnectAlerted = true;
        emitEvent(account, 'dead_reconnect_exhausted', { deadReconnectCount: account.deadReconnectCount });
        stopNetwork(account, '真实静默重连预算已耗尽');
        return;
    }
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    const generation = account.reconnectGeneration;
    const timer = setTimeout(() => {
        if (account.deadReconnectTimer !== timer || account.reconnectGeneration !== generation
            || account.ws !== socket || account.connectionEpoch !== epoch || !account.connectionDead
            || !isTrulySilent(account)) return;
        account.deadReconnectTimer = null;
        reconnect(account, null).catch(error => logWarn('gateway', `account ${account.accountId} 静默恢复失败: ${error.message}`));
    }, getDeadReconnectBackoffMs(account, account.deadReconnectCount));
    account.deadReconnectTimer = timer;
}

function noteBusinessTimeout(account, sentAt) {
    if (gatewayShuttingDown) return;
    account.requestTimeoutStreak = Math.min(BUSINESS_REQUEST_LIMIT, account.requestTimeoutStreak + 1);
    account.businessNoResponseSince = account.businessNoResponseSince || Math.max(sentAt, account.lastBusinessReplyAt);
    if (account.requestTimeoutStreak >= HEALTH_DEGRADED_STREAK && !account.healthBackoffChanging) {
        account.healthBackoffChanging = true;
        const backoffMs = Math.min(HEALTH_BACKOFF_BASE_MS * (2 ** Math.min(16, account.degradedStreak)), HEALTH_BACKOFF_MAX_MS);
        account.degradedStreak = Math.min(16, account.degradedStreak + 1);
        account.healthBackoffUntil = Date.now() + backoffMs;
        for (const op of Array.from(account.operations)) rejectBusinessDuringBackoff(account, op);
        const socket = account.ws;
        const epoch = account.connectionEpoch;
        const healthEpoch = account.healthEpoch;
        const timer = setTimeout(() => {
            if (account.healthBackoffTimer !== timer || account.ws !== socket || account.connectionEpoch !== epoch
                || account.healthEpoch !== healthEpoch) return;
            account.healthBackoffTimer = null;
            account.healthBackoffChanging = false;
            account.healthBackoffUntil = 0;
        }, backoffMs);
        account.healthBackoffTimer = timer;
        logWarn('gateway', `account ${account.accountId} epoch=${account.connectionEpoch} 业务亚健康：真实入站静默 ${Math.floor((Date.now() - (account.lastInboundAt || account.connectedAt)) / 1000)}s，业务无响应 ${Math.floor((Date.now() - account.businessNoResponseSince) / 1000)}s，超时计数 ${account.requestTimeoutStreak}，退避 ${Math.floor(backoffMs / 1000)}s（次数不作判死时长）`);
        emitEvent(account, 'connection_degraded', { backoffMs, degradedStreak: account.degradedStreak });
    }
    armDeadConfirmation(account);
}

function noteInbound(account, meta, cb) {
    const now = Date.now();
    const inboundSilenceSeconds = Math.floor((now - (account.lastInboundAt || account.connectedAt)) / 1000);
    const businessSilenceSeconds = account.businessNoResponseSince ? Math.floor((now - account.businessNoResponseSince) / 1000) : 0;
    account.lastInboundAt = now;
    account.serverSeq = Math.max(account.serverSeq, toNum(meta.server_seq) || 0);
    const wasDead = account.connectionDead || !!account.deadReconnectTimer;
    const wasBusinessDegraded = wasDead || account.requestTimeoutStreak > 0 || account.degradedStreak > 0
        || account.healthBackoffChanging || account.businessNoResponseSince > 0;
    if (wasDead) {
        cancelReconnectTimers(account);
        account.connectionDead = false;
        log('gateway', `account ${account.accountId} epoch=${account.connectionEpoch} 链路入站恢复：此前静默 ${inboundSilenceSeconds}s，已取消静默重连，业务健康尚未确认`);
        emitEvent(account, 'connection_recovered', { linkRecovered: true, businessHealthy: false });
    }
    if (cb?.operation?.kind === 'heartbeat' && !toNum(meta.error_code)) {
        account.lastHeartbeatResponse = now;
        account.heartbeatMissCount = 0;
        account.heartbeatWarned = false;
    }
    if (cb?.operation?.kind === 'ace' && !toNum(meta.error_code)) account.lastAceResponseAt = now;
    if (cb?.operation?.kind === 'business') {
        account.lastBusinessReplyAt = now;
        // 错误证明此刻链路有回包，但既有无响应观察不能丢失，否则退避后再无 RPC 会永久僵死。
        account.businessNoResponseSince = toNum(meta.error_code)
            && (account.businessNoResponseSince || account.requestTimeoutStreak) ? now : 0;
        if (!toNum(meta.error_code)) {
            account.lastBusinessSuccessAt = now;
            account.lastGameResponseAt = now;
            account.requestTimeoutStreak = 0;
            clearHealthTimers(account);
            account.degradedStreak = 0;
            if (wasBusinessDegraded) {
                log('gateway', `account ${account.accountId} epoch=${account.connectionEpoch} 业务回复恢复：此前无响应 ${businessSilenceSeconds}s，解除业务退避`);
                emitEvent(account, 'connection_recovered', { linkRecovered: true, businessHealthy: true });
            }
        }
    }
    clearTimeout(account.deadConfirmTimer);
    account.deadConfirmTimer = null;
    armDeadConfirmation(account);
}

// ============ 安全运行时 / ACE ============
function createTsdkRuntime(accountId, deviceProtocol) {
    const customDevice = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    return new TsdkRuntime({
        accountId: String(accountId),
        ...(ISOLATED_WX_GATEWAY ? { dataDir: path.join(WX_LOGIN_DIR, 'tsdk', String(accountId)) } : {}),
        gameId: CONFIG.tsdkGameId,
        appKey: CONFIG.tsdkAppKey,
        deviceInfo: {
            deviceModel: customDevice && customDevice.deviceModel,
            deviceBrand: customDevice && customDevice.deviceBrand,
            deviceId: customDevice && customDevice.deviceId,
            deviceMac: customDevice && customDevice.deviceMac,
            imei: customDevice && customDevice.imei,
            platform: CONFIG.os,
        },
        logger: (level, message) => logAce(level, `account ${accountId} ${message}`),
    });
}

async function startSecurityRuntime(account, deviceProtocol) {
    stopSecurityRuntime(account, '重新初始化');
    if (!CONFIG.tsdkAceEnabled) throw new Error('TSDK/ACE 已通过 FARM_TSDK_ACE_ENABLED=false 关闭');
    const runtime = createTsdkRuntime(account.accountId, deviceProtocol);
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    account.tsdkRuntime = runtime;
    account.initialGamePackInfo = '';
    await runtime.init();
    if (account.tsdkRuntime !== runtime || account.ws !== socket || account.connectionEpoch !== epoch || account.networkStopped) {
        runtime.destroy();
        throw new Error('安全运行时所属连接已失效');
    }
}

function startAceService(account) {
    if (!account.tsdkRuntime || !account.tsdkRuntime.ready) return;
    try {
        if (account.aceService) account.aceService.stop('重新启动');
        const runtime = account.tsdkRuntime;
        const socket = account.ws;
        const epoch = account.connectionEpoch;
        const current = () => account.tsdkRuntime === runtime && account.ws === socket
            && account.connectionEpoch === epoch && !account.networkStopped && socket?.readyState === 1;
        account.aceService = new AceService({
            runtime,
            sendRequest: (svc, method, body, timeout) => current()
                ? gatewaySendRequest(account, svc, method, body, timeout)
                : Promise.reject(new Error('ACE 所属连接已失效')),
            isConnected: current,
            types,
            logger: (level, message) => logAce(level, `account ${account.accountId} ${message}`),
        });
        account.aceService.start();
    } catch (e) {
        logWarn('ACE', `account ${account.accountId} 启动失败: ${e.message}`);
    }
}

function stopSecurityRuntime(account, reason) {
    rejectAllPending(account, reason || '安全运行时已停止');
    try { if (account.aceService) account.aceService.stop(reason); } catch { }
    try { if (account.tsdkRuntime) account.tsdkRuntime.destroy(); } catch { }
    account.aceService = null;
    account.tsdkRuntime = null;
}

// ============ 登录 ============
function buildLoginDeviceInfo(deviceProtocol) {
    const customDevice = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    if (!customDevice) {
        return {
            client_version: CONFIG.clientVersion,
            sys_software: 'iOS 26.2.1',
            network: 'wifi',
            memory: '7672',
            device_id: 'iPhone X<iPhone18,3>',
        };
    }
    const brand = String(customDevice.deviceBrand || '').trim();
    const model = String(customDevice.deviceModel || '').trim();
    const deviceId = String(customDevice.deviceId || '').trim();
    const imei = String(customDevice.imei || '').trim();
    const mac = String(customDevice.deviceMac || '').trim();
    return {
        client_version: CONFIG.clientVersion,
        sys_software: /android/i.test(customDevice.userAgent || '') ? 'Android' : CONFIG.os,
        sys_hardware: [brand, model].filter(Boolean).join(' '),
        network: 'wifi',
        memory: '7672',
        device_id: deviceId || mac || imei || [brand, model].filter(Boolean).join(' '),
    };
}

function decodeLoginReply(account, decryptedBody) {
    const reply = types.LoginReply.decode(decryptedBody);
    return applyLoginBasic(account, reply && reply.basic);
}

function applyLoginBasic(account, b, { bindSecurity = true } = {}) {
    const gid = b && toNum(b.gid);
    if (!Number.isSafeInteger(gid) || gid <= 0) {
        throw new Error('登录回复缺少有效 GID，未建立游戏会话');
    }
    // 只接受本次成功回复的身份，不能借用上一条连接残留的 gid。
    account.userState.gid = gid;
    account.userState.name = String(b.name || '');
    account.userState.level = toNum(b.level);
    account.userState.gold = toNum(b.gold);
    account.userState.exp = toNum(b.exp);
    account.userState.openId = String(b.open_id || '');
    account.userState.avatar = String(b.avatar_url || '');
    if (bindSecurity && account.tsdkRuntime && account.userState.openId) {
        account.tsdkRuntime.bindUser(account.userState.openId);
        account.initialGamePackInfo = account.tsdkRuntime.getEncryptedInitInfo();
    }
    return true;
}

async function sendLogin(account, onLoginSuccess) {
    const profile = process.env.FARM_LOGIN_PROFILE || 'player';
    if (!['legacy', 'player'].includes(profile)) throw new Error('未知登录协议配置，未发送登录请求');
    if (profile === 'player') {
        const protocol = require('../services/player-login-protocol');
        const socket = account.ws;
        const epoch = account.connectionEpoch;
        const current = () => {
            if (account.ws !== socket || account.connectionEpoch !== epoch || account.networkStopped || gatewayShuttingDown) {
                throw new Error('全局登录期间连接已变化，拒绝沿用旧回复');
            }
        };
        const request = protocol.buildRequest(types, buildLoginDeviceInfo(account.deviceProtocol), 'player', {
            sharer_id: toLong(0), sharer_open_id: '', share_cfg_id: toLong(0),
            scene_id: '1256', game_scene_id: 1,
            report_data: { callback: '', cd_extend_info: '', click_id: '', clue_token: '',
                minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '' },
        });
        const response = await new Promise((resolve, reject) => {
            sendMsg(account, request.service, request.method, request.body,
                { resolve, reject, playerLogin: true, timeoutMs: WORKER_REQUEST_TIMEOUT_MS }).catch(reject);
        });
        current();
        const login = protocol.validateLoginReply('player', request.replyDecoder(response.body));
        // Prepare security binding for the scene request without publishing a GID
        // or a login event before the required HOME reply is confirmed.
        const openId = String(login.basic.open_id || '');
        if (account.tsdkRuntime && openId) {
            account.tsdkRuntime.bindUser(openId);
            account.initialGamePackInfo = account.tsdkRuntime.getEncryptedInitInfo();
        }
        if (!types.PlayerSceneLoginRequest || !types.PlayerSceneLoginReply) throw new Error('全局场景登录协议未加载');
        const homeBody = types.PlayerSceneLoginRequest.encode(types.PlayerSceneLoginRequest.create({ global_scene_id: 1 })).finish();
        const homeResponse = await new Promise((resolve, reject) => {
            sendMsg(account, 'gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin', homeBody,
                { resolve, reject, loginScene: true, timeoutMs: WORKER_REQUEST_TIMEOUT_MS }).catch(reject);
        });
        current();
        const confirmed = protocol.confirmHomeScene(login, types.PlayerSceneLoginReply.decode(homeResponse.body));
        if (!confirmed.canBroadcastLoggedIn) throw new Error('全局登录尚未完成HOME确认');
        applyLoginBasic(account, login.basic, { bindSecurity: false });
        account.loginProfile = 'player';
        account.globalSceneId = 1;
        account.unlockedSceneIds = [...login.globalScene.unlockedSceneIds];
        onLoginSuccess();
        return;
    }
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: buildLoginDeviceInfo(account.deviceProtocol),
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    })).finish();
    await new Promise((resolve, reject) => {
        const cb = {
            isLogin: true,
            reject,
            onLoginSuccess() { onLoginSuccess(); resolve(true); },
            timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
        };
        sendMsg(account, 'gamepb.userpb.UserService', 'Login', body, cb).catch(reject);
    });
}

// ============ WebSocket ============
function buildWebSocketHeaders(deviceProtocol) {
    const resourceVersion = String(CONFIG.clientVersion || '').split('_')[0];
    const headers = {
        Origin: 'https://gate-obt.nqf.qq.com',
        Referer: `https://appservice.qq.com/1112386029/${resourceVersion}/page-frame.html`,
    };
    const userAgent = deviceProtocol && deviceProtocol.enabled ? String(deviceProtocol.userAgent || '').trim() : '';
    if (userAgent) headers['User-Agent'] = userAgent;
    return headers;
}

function connect(account, code) {
    if (!gatewayOwnsAccount(account.accountId)) return;
    if (account.networkStopped || gatewayShuttingDown) return false;
    if (account.ws && (account.ws.readyState === 0 || account.ws.readyState === 1)) return false;
    if (code) account.savedCode = code;
    if (!account.savedCode) {
        logWarn('gateway', `account ${account.accountId} 无有效 code，跳过建连（需重新抓包）`);
        return;
    }
    // ⭐ 并发保护（2026-11-01 排查补充，同日修正过一次）：防止同一账号重复建连。
    // 背景：connect 可被多条路径触发（scheduleReconnect 定时器、假死重连、worker connect 帧、
    // 启动时 reconnect）。若两次调用在同一个 tick 内先后进入，会各自 new WebSocket，
    // 后者的 closeCurrentWs 只清理 account.ws 指向的那一个，**先建的那个 socket 成为孤儿**：
    // 它仍连着 gameserver（服务器侧看到同 code 多连接 → 顶号/1006），但本地已无引用、
    // 永不 close 也永不回收。这是典型的连接泄漏 + 顶号来源。
    //
    // ⚠️ 2026-11-01 修正（首版有缺陷，实测误杀）：
    // 首版只按「5 秒内有过 connect」就拦截，结果 worker 崩溃被 worker-manager 重新拉起后，
    // 新 worker 发的第一个 connect 正好落在窗口内而被跳过 →
    //   `account 1 建连进行中(2407ms)，跳过重复 connect`
    // 账号就此再也连不上（新 worker 只发一次 connect 帧）。
    // 正确语义：**只有在"上一次建连的 socket 仍然活着"时才需要拦截**。
    // 若 account.ws 已为 null / 已 CLOSED，说明上次建连已经结束（无论成功或失败），
    // 此时的 connect 是合法的新尝试，必须放行。
    account.connectingAt = Date.now();
    const plat = account.platform || CONFIG.platform;
    const url = `${CONFIG.serverUrl}?platform=${plat}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${account.savedCode}&openID=`;
    closeCurrentWs(account, { terminate: true });
    account.userState.gid = 0;
    account.loginProfile = null;
    account.unlockedSceneIds = [];
    account.globalSceneId = 0;
    // 记录本次建连时间：风控熔断据此判断会话是"短命被踢"还是"稳定健康"
    account.connectionEpoch += 1;
    account.connectedAt = Date.now();
    account.lastInboundAt = 0;
    account.lastHeartbeatResponse = 0;
    account.lastAceResponseAt = 0;
    account.lastBusinessReplyAt = 0;
    account.lastBusinessSuccessAt = 0;
    account.lastGameResponseAt = 0;
    account.businessNoResponseSince = 0;
    account.requestTimeoutStreak = 0;

    let deviceProtocol = null;
    try {
        const store = getStoreModule();
        deviceProtocol = store.getDeviceProtocolForAccount(account.accountId);
    } catch (e) {
        log('gateway', `account ${account.accountId} 加载设备协议失败: ${e.message}`);
    }
    account.deviceProtocol = deviceProtocol;

    const socket = new WebSocket(url, {
        headers: buildWebSocketHeaders(deviceProtocol), handshakeTimeout: WORKER_REQUEST_TIMEOUT_MS,
    });
    account.ws = socket;
    socket.binaryType = 'arraybuffer';

    const epoch = account.connectionEpoch || 0;
    account.loginPromise = new Promise(resolve => { account.finishLogin = resolve; });
    socket.on('open', async () => {
        if (account.ws !== socket || account.networkStopped || (account.connectionEpoch || 0) !== epoch) return;
        try {
            await startSecurityRuntime(account, deviceProtocol);
            if (account.ws !== socket || account.networkStopped || (account.connectionEpoch || 0) !== epoch) return;
            await sendLogin(account, () => onAccountLogin(account));
        } catch (error) {
            if (account.ws !== socket || account.connectionEpoch !== epoch) return;
            logWarn('gateway', `account ${account.accountId} 游戏登录失败: ${error.message}`);
            emitEvent(account, 'login_error', { message: error.message, code: error.code ?? null });
            closeCurrentWs(account, { terminate: true });
            stopSecurityRuntime(account, '登录失败');
            rejectAllPending(account, '游戏登录失败');
            account.userState.gid = 0;
            if (account.platform === 'wx') handleWxCodeFailure(account, error);
            else scheduleReconnect(account, 'login_failed');
        }
    });
    socket.on('message', (data) => {
        if (account.ws === socket && account.connectionEpoch === epoch) handleMessage(account, Buffer.isBuffer(data) ? data : Buffer.from(data), socket, epoch);
    });
    socket.on('close', (code) => {
        // 只处理"当前连接"的关闭：reconnect 时旧 ws 会被异步关闭，其延迟 close 事件到达时
        // account.ws 已是新连接，必须忽略，否则会额外排一次重连 → 连锁重连风暴（重复建连被服务器顶号）
        const isCurrent = account.ws === socket;
        if (isCurrent) account.ws = null;
        logWarn('gateway', `account ${account.accountId} 连接关闭 (code=${code})${isCurrent ? '' : ' [旧连接延迟关闭，忽略]'}`);
        if (isCurrent) {
            account.connectionEpoch += 1;
            clearHealthTimers(account);
            cancelReconnectTimers(account);
            if (account.finishLogin) { account.finishLogin(false); account.finishLogin = null; }
            stopSecurityRuntime(account, '连接已关闭');
            rejectAllPending(account, '游戏连接已关闭');
            if (account.heartbeatTimer) { clearInterval(account.heartbeatTimer); account.heartbeatTimer = null; }
            account.userState.gid = 0;
            // 1006 表示 Code 被拒（一次性 Code 已失效）；计数用于在连续失败后停止重连，避免重复登录顶下线
            // 【风控视角】1006 更常见的成因是腾讯风控拒连/封禁，而非网络抖动 —— 越重连封得越久。
            if (Number(code) === 1006) {
                account.codeInvalidCount += 1;
                // 短命会话检测：刚建连就被踢 = 典型风控特征（健康会话应以小时计）。
                // 连续多次短命即停止该账号自动重连，不再无脑冲撞服务器。
                const sessionMs = account.connectedAt ? Date.now() - account.connectedAt : -1;
                if (sessionMs >= 0 && sessionMs < SHORT_SESSION_MS) {
                    account.shortSessionCount = (account.shortSessionCount || 0) + 1;
                    logWarn('gateway', `[风控熔断] account ${account.accountId} 会话仅存活 ${Math.round(sessionMs / 1000)}s 即被 1006（短命第 ${account.shortSessionCount}/${SHORT_SESSION_MAX} 次）`);
                } else if (sessionMs >= SHORT_SESSION_MS) {
                    // 熬过短命门槛：本次会话不算短命，重置连续短命计数（真网络抖动不算风控）
                    account.shortSessionCount = 0;
                    account.shortSessionAlerted = false;
                }
                // 计入全局 1006 窗口统计（跨账号），达到阈值触发全局暂停
                noteGlobal1006();
                // 1006 只表示游戏 WebSocket 非正常断开，不能推断 OAuth 或原生票据过期。
                // 微信恢复先复用已认证原生会话，授权刷新只由其自身期限/明确票据拒绝触发。
            }
            emitEvent(account, 'disconnect', { code }, epoch);
            scheduleReconnect(account, `close:${code}`);
        }
    });
    socket.on('error', (err) => {
        if (account.ws !== socket || account.connectionEpoch !== epoch) return;
        const message = err && err.message ? String(err.message) : '';
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const c = Number.parseInt(match[1], 10) || 0;
            if (c) emitEvent(account, 'ws_error', { code: c, message });
        }
    });
}

function closeCurrentWs(account, { terminate = false } = {}) {
    const current = account.ws;
    account.connectionEpoch += 1;
    clearHealthTimers(account);
    cancelReconnectTimers(account);
    rejectAllPending(account, '连接已重置');
    if (account.finishLogin) { account.finishLogin(false); account.finishLogin = null; }
    if (account.heartbeatTimer) { clearInterval(account.heartbeatTimer); account.heartbeatTimer = null; }
    if (!current) return;
    account.ws = null;
    try { current.removeAllListeners(); } catch { }
    try {
        if (terminate && typeof current.terminate === 'function') current.terminate();
        else current.close();
    } catch { }
}

// ============ 消息处理 ============
function handleMessage(account, buffer, socket = account.ws, epoch = account.connectionEpoch) {
    if (socket !== account.ws || epoch !== account.connectionEpoch || account.networkStopped) return;
    try {
        const gateMessage = types.GateMessage.decode(buffer);
        const meta = gateMessage.meta || {};
        const msgType = toNum(meta.message_type);
        if (msgType !== 2 && msgType !== 3) return;
        const body = gateMessage.body || Buffer.alloc(0);
        const candidate = msgType === 2 ? account.pendingCallbacks.get(toNum(meta.client_seq)) : null;
        const cb = candidate?.operation?.sent && operationCurrent(account, candidate.operation) ? candidate : null;
        // 包括 notify、超时后的迟到回复及错误回复：事实入站与业务成功分开记录。
        noteInbound(account, meta, cb);
        if (msgType === 3) {
            sendFrame(account.workerSock, { t: 'notify', accountId: account.accountId, body: Buffer.from(buffer).toString('base64') });
            return;
        }
        if (!cb) return;
        const op = cb.operation;
        const errorCode = toNum(meta.error_code);
        if (errorCode) {
            const error = requestError(`${meta.service_name || op.service}.${meta.method_name || op.method} 错误: code=${errorCode} ${meta.error_message || ''}`, errorCode, op);
            error.stage = cb.isLogin || cb.playerLogin || cb.loginScene ? 'game_login' : 'game_request';
            error.outcomeUnknown = false;
            error.resultState = 'failed';
            error.serverSeq = account.serverSeq;
            error.service = meta.service_name || op.service;
            error.method = meta.method_name || op.method;
            if (cb.isLogin) account.userState.gid = 0;
            finishOperation(account, op, error);
            return;
        }
        if (cb.isLogin) {
            try { decodeLoginReply(account, body); }
            catch (error) {
                account.userState.gid = 0;
                const failure = requestError(error.message, 'INVALID_LOGIN_REPLY', op);
                failure.stage = 'game_login';
                failure.resultState = 'failed';
                failure.outcomeUnknown = false;
                finishOperation(account, op, failure);
                return;
            }
        }
        finishOperation(account, op);
        clearFaultsIfSessionStable(account);
        if (op.waiterDetached) return;
        if (cb.isLogin) {
            if (cb.onLoginSuccess) cb.onLoginSuccess();
        } else if (cb.resolve) {
            cb.resolve({ body, meta: { serverSeq: account.serverSeq, connectionEpoch: op.epoch,
                sent: true, resultState: 'completed', outcomeUnknown: false, retryable: false,
                timeoutMs: op.timeoutMs, settlementTimeoutMs: op.settlementTimeoutMs, sentAt: op.sentAt } });
        } else if (cb.workerSock && cb.workerSeq != null) {
            sendFrame(cb.workerSock, {
                t: 'response', accountId: account.accountId, seq: cb.workerSeq, error: '',
                body: Buffer.from(body).toString('base64'), meta: { serverSeq: account.serverSeq,
                    sent: true, resultState: 'completed', outcomeUnknown: false, retryable: false,
                    timeoutMs: op.timeoutMs, settlementTimeoutMs: op.settlementTimeoutMs, sentAt: op.sentAt },
            }, op.epoch);
        }
    } catch (e) {
        logWarn('gateway', `account ${account.accountId} 消息解码失败: ${e.message}`);
    }
}

function onAccountLogin(account) {
    // 登录成功说明当前 Code 有效，清空失效计数与告警标记，恢复自动重连能力
    account.codeInvalidCount = 0;
    account.codeInvalidAlerted = false;
    account.reconnectAttempts = 0;
    // 登录成功只说明"码有效"，**不等于连接健康**（实测连上 3 秒就被 1006）。
    // 判死重连计数改由 clearFaultsIfSessionStable 在会话稳定 5 分钟后清零，
    // 避免"登录成功即清零"让上限形同虚设。
    clearFaultsIfSessionStable(account);
    // 登录成功说明当前 Code/凭证有效：清除"微信登录态失效"终态，恢复自动重连能力
    account.wxRescanAlerted = false;
    if (account.platform === 'wx') clearWxTemporaryFailures(account);
    else { account.wxCodeFailCount = 0; account.wxBufferAlerted = false; }
    account.networkStopped = false;
    // 标记"已成功登录过"：QQ 一次性 Code 登录即用即废，之后断链重连绝不能再拿同一 Code 冲服务器（否则被顶号）
    account.loggedInOnce = true;
    account.connectionDead = false;
    cancelReconnectTimers(account);
    if (account.finishLogin) { account.finishLogin(true); account.finishLogin = null; }
    // 本次用 refreshtoken 续期换码已成功登录，清零"需刷新"标记，下次正常断链重连仍可先试快路径
    account.wxNeedsRefresh = false;
    if (account.workerSock) {
        sendFrame(account.workerSock, { t: 'login', accountId: account.accountId, userState: account.userState });
    }
    startHeartbeat(account);
    startAceService(account);
}

// ============ 心跳 ============
function startHeartbeat(account) {
    if (account.heartbeatTimer) clearInterval(account.heartbeatTimer);
    account.heartbeatMissCount = 0;
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    account.heartbeatTimer = setInterval(() => {
        if (account.ws !== socket || account.connectionEpoch !== epoch || account.networkStopped || !account.userState.gid) return;
        const timeSince = Date.now() - (account.lastHeartbeatResponse || account.connectedAt);
        if (timeSince > HEARTBEAT_TIMEOUT) {
            account.heartbeatMissCount = Math.min(MAX_HEARTBEAT_MISS, account.heartbeatMissCount + 1);
            if (account.heartbeatMissCount >= MAX_HEARTBEAT_MISS) {
                // 【关键】绝不主动 close / 重连 —— 这是账号"自己下线"的元凶。
                // 心跳超时往往只是网络抖动，底层连接其实还活着；此时主动断开等于 bot
                // 自己把自己踢下线，而重连要再消耗一个一次性 Code
                // （微信无法自动换 Code → 1006 → 彻底掉线，必须人工扫码）。
                // 连接真断时 ws 会自行触发 close 事件 → scheduleReconnect 处理，无需这里代劳。
                if (!account.heartbeatWarned) {
                    account.heartbeatWarned = true;
                    logWarn('gateway', `account ${account.accountId} 心跳超时 ${timeSince}ms（仅告警，保持连接，等网络/服务器恢复）`);
                    emitEvent(account, 'heartbeat_timeout', { timeSince });
                }
                // 绝不主动断开 / 重连：只要底层 ws 仍 OPEN 就保活，心跳恢复后自动续上；
                // 真正断链由 ws 的 close/error 事件 → scheduleReconnect 驱动，而非 bot 自行判定"假死"误杀活连接。
                // 继续往下发心跳，给连接恢复的机会（不 return）
            }
        }
        if (account.criticalFlights.has('heartbeat')) return;
        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(account.userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        void sendMsg(account, 'gamepb.userpb.UserService', 'Heartbeat', body, { isHeartbeat: true, timeoutMs: HEARTBEAT_TIMEOUT });
    }, CONFIG.heartbeatInterval || 30000);
}

// ============ 重连 ============
function getReconnectDelayMs(account) {
    const delay = RECONNECT_BASE_DELAY_MS * (2 ** Math.min(16, Math.max(0, account.reconnectAttempts - 1)));
    return Math.min(RECONNECT_MAX_DELAY_MS, delay);
}

function scheduleReconnect(account, reason) {
    if (gatewayShuttingDown || account.networkStopped || !account.savedCode || account.reconnectTimer || account.deadReconnectTimer) return;
    if (account.ws && (account.ws.readyState === 0 || account.ws.readyState === 1)) return;
    // 全局风控熔断：暂停期内连 timer 都不排，避免暂停结束时一次性涌出堆积的重连
    if (globalReconnectPaused(account)) return;
    account.reconnectAttempts = Math.min(1000000, account.reconnectAttempts + 1);
    // 达到次数阈值时仅发一次告警（Code 可能已失效），但不放弃：
    // 网关会持续以最大间隔重试，gameserver 恢复或用户重抓 Code 后 /start 即可重新连上，已登录的号不会因重连策略激进而被踢下线。
    if (account.reconnectAttempts === RECONNECT_ALERT_AFTER) {
        emitEvent(account, 'reconnect_failed', { attempts: account.reconnectAttempts, reason: reason || '' });
    }
    const delay = Math.max(getReconnectDelayMs(account) + Math.floor(Math.random() * 3000),
        account.platform === 'wx' ? (account.wxRetryAfter || 0) - Date.now() : 0); // 尊重微信冷却
    // 必须先清掉上一次的待执行 timer：否则每次 close 都新建一个，多 timer 并存时
    // 即使 reconnect 判定"Code 失效已停止"，其余 timer 仍会继续重连（实测 1006 停不下来）。
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    const generation = account.reconnectGeneration;
    const timer = setTimeout(() => {
        if (account.reconnectTimer !== timer || account.ws !== socket || account.connectionEpoch !== epoch
            || account.reconnectGeneration !== generation || account.networkStopped) return;
        account.reconnectTimer = null;
        reconnect(account, null).catch(error => logWarn('gateway', `account ${account.accountId} 重连失败: ${error.message}`));
    }, delay);
    account.reconnectTimer = timer;
}

// 从 store 取账号对象（兼容 getAccounts() 返回数组或 {accounts:[...]}）
function getStoreAccount(accountId) {
    try {
        const store = getStoreModule();
        const res = store.getAccounts();
        const list = Array.isArray(res) ? res : ((res && res.accounts) || []);
        return list.find(a => String(a.id) === String(accountId)) || null;
    } catch { return null; }
}

// 微信 loginBuffer 的落盘 key 是“扫码 session.openid”，它被存进账号的 wxid 字段
// （注意不是 openId —— openId 是游戏侧返回的另一个 ID，用作 key 会永远查不到文件）
function readStoreWxBufferKey(accountId) {
    const acc = getStoreAccount(accountId);
    return acc ? String(acc.wxid || '') : '';
}

// 从 store 补全账号 platform：platform 原先只在 /start 命令路径赋值，网关重启后为空
// 会导致微信换码分支永远不触发（仍用已作废的一次性 Code 重连 → 重复登录顶下线）
function syncAccountPlatform(account) {
    if (account.platform) return;
    const acc = getStoreAccount(account.accountId);
    if (acc && acc.platform) account.platform = acc.platform;
}

function wxCredentialFile(accountId) {
    const key = readStoreWxBufferKey(accountId);
    return key && path.basename(key) === key && !/[\\/]/.test(key)
        ? path.join(WX_LOGIN_DIR, `${key}.json`) : null;
}

function readWxCredential(accountId) {
    const file = wxCredentialFile(accountId);
    if (!file || !fs.existsSync(file)) return null;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = readStoreWxBufferKey(accountId);
    if (!rec || (rec.openid && rec.openid !== key)) {
        throw Object.assign(new Error('wxid 对应凭证不匹配'), { stage: 'local_credential_missing' });
    }
    return { file, rec, key };
}

function wxSessionBinding(rec, key) {
    return `wx-login:${key}:${rec.credentialGeneration}`;
}

function wxCredentialStatus(accountId) {
    try {
        const source = readWxCredential(accountId);
        if (!source) return { available: false };
        const rec = source.rec;
        const { hasNativeSession } = require('../services/wx-login/native-protocol');
        return {
            available: true, refreshBusinessId: rec.refreshBusinessId || rec.refresh_business_id || 'pc_yyb',
            credentialSource: rec.credentialSource || 'legacy_pc_yyb',
            tokenCheckedAt: rec.tokenCheckedAt || null, accessTokenExpiresAt: rec.accessTokenExpiresAt || null,
            accessTokenExpirySource: rec.accessTokenExpirySource || (rec.accessTokenExpiresAt ? 'legacy_unverified' : 'unknown'),
            accessTokenCookieExpiresAt: rec.accessTokenCookieExpiresAt || null,
            accessTokenCookieExpirySource: rec.accessTokenCookieExpirySource || 'unknown',
            nativeReverify: rec.nativeReverify ? { attemptedAt: rec.nativeReverify.attemptedAt, state: rec.nativeReverify.state } : null,
            tokenLastSuccessAt: rec.tokenLastSuccessAt || null,
            tokenRetryAfter: rec.tokenRetryAfter || 0, tokenError: rec.tokenError || null,
            bufferRetryAfter: rec.bufferRetryAfter || 0, bufferError: rec.bufferError || null,
            codeRetryAfter: rec.codeRetryAfter || 0, codeError: rec.codeError || null,
            nativeSessionUsable: hasNativeSession(rec.nativeSession, wxSessionBinding(rec, source.key)),
            nativeSessionExpiresAt: rec.nativeSession?.expiresAt || null,
            scannedAt: rec.scannedAt || null,
        };
    } catch { return { available: false, reason: 'credential_unavailable' }; }
}

function wxFailureState(error) {
    const classification = classifyWxCodeError(error);
    return {
        stage: String(error?.stage || 'unknown'), reason: classification.reason,
        code: typeof error?.code === 'number' || typeof error?.code === 'string' ? error.code : null,
        serverCode: typeof error?.serverCode === 'number' ? error.serverCode : null,
        wechatCode: typeof error?.wechatCode === 'number' ? error.wechatCode : null,
        at: Date.now(),
    };
}

function wxLayerBackoff(count) {
    return Math.min(WX_TEMP_FAIL_ACCOUNT_MAX_MS, WX_TEMP_FAIL_BACKOFF_BASE_MS * (2 ** Math.min(15, Math.max(0, count - 1))));
}

function wxLayerCooling(rec, layer) {
    const at = Number(rec[`${layer}RetryAfter`]) || 0;
    if (at <= Date.now()) return;
    const error = new Error(`微信 ${layer} 操作处于冷却期`);
    error.stage = `${layer}_cooldown`;
    error.retryAfter = at;
    throw error;
}

function wxTokenDue(rec) {
    if (rec.tokenRefreshPending === true) return true;
    const expiresAt = Number(rec.accessTokenExpiresAt);
    if (Number.isSafeInteger(expiresAt) && expiresAt > 0) return Date.now() + WX_TOKEN_REFRESH_SKEW_MS >= expiresAt;
    // 旧凭据没有服务端有效期时沿用运营兜底窗口，不能据此宣称 token 保证有效两小时。
    const checked = Number(rec.tokenCheckedAt || rec.scannedAt || rec.loginBufferUpdatedAt || 0);
    return checked <= 0 || Date.now() - checked >= WX_KEEPALIVE_MIN_AGE_MS;
}

const wxCredentialFlights = new Map();
function withWxCredentialContext(file, snapshot, operation, options = {}) {
    const previous = wxCredentialFlights.get(file) || Promise.resolve();
    const flight = previous.catch(() => {}).then(async () => {
        if (options.signal?.aborted) throw options.signal.reason;
        const { withWxCredentialOperation } = require('../services/wx-login/credential-storage');
        return withWxCredentialOperation(file, undefined, async current => {
            const key = path.basename(file, '.json');
            if ((current.openid && current.openid !== key)
                || (snapshot.credentialGeneration && current.credentialGeneration !== snapshot.credentialGeneration)
                || (!snapshot.credentialGeneration && JSON.stringify(current) !== JSON.stringify(snapshot))) {
                throw Object.assign(new Error('微信凭据世代已变更，拒绝旧授权操作'), { stage: 'credential_conflict' });
            }
            const context = {
                rec: current, file, key,
                save(patch) {
                    context.rec = persistWxCredentials(file, context.rec, patch);
                    return context.rec;
                },
                session() { return { ...context.rec, openid: key }; },
                check() {
                    if (options.signal?.aborted) throw options.signal.reason;
                    if (options.deadline && Date.now() >= options.deadline) throw new Error('微信凭据操作超时');
                    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(context.rec)) {
                        throw Object.assign(new Error('微信凭据已被并发更新'), { stage: 'credential_conflict' });
                    }
                },
            };
            if (!current.credentialGeneration) {
                context.save({ credentialGeneration: require('node:crypto').randomBytes(16).toString('hex'), nativeSession: null, pendingCode: null });
            }
            context.check();
            return operation(context);
        });
    });
    wxCredentialFlights.set(file, flight);
    const clear = () => { if (wxCredentialFlights.get(file) === flight) wxCredentialFlights.delete(file); };
    flight.then(clear, clear);
    return flight;
}

// 恢复顺序：一次性扫码 Code → 已认证原生会话 → 保存票据；
// 只有原生票据明确拒绝才获取新 buffer。token-only 续期独立调度，不由游戏1006推断。
function issueWxCodeFromBuffer(account) {
    if (account.wxIssueFlight) return account.wxIssueFlight;
    const flight = issueWxCodeFromBufferOnce(account);
    account.wxIssueFlight = flight;
    const clear = () => { if (account.wxIssueFlight === flight) account.wxIssueFlight = null; };
    flight.then(clear, clear);
    return flight;
}

async function issueWxCodeFromBufferOnce(account) {
    if (!gatewayOwnsAccount(account.accountId)) return null;
    try {
        const source = readWxCredential(account.accountId);
        if (!source) throw Object.assign(new Error('loginBuffer 文件不存在'), { stage: 'local_credential_missing' });
        const { file, rec } = source;
        const { WxLoginService } = require('../services/wx-login/service');
        const svc = new WxLoginService();
        const options = { signal: account.wxConnectController?.signal, deadline: Date.now() + WX_CREDENTIAL_OPERATION_TIMEOUT_MS };
        return await withWxCredentialContext(file, rec, async context => {
            const pending = context.rec.pendingCode;
            const now = Date.now();
            if (pending && pending.generation === context.rec.credentialGeneration && pending.consumed === false
                && typeof pending.value === 'string' && pending.value
                && Number.isSafeInteger(pending.issuedAt) && pending.issuedAt <= now
                && Number.isSafeInteger(pending.expiresAt) && pending.expiresAt > now
                && pending.expiresAt <= pending.issuedAt + 60000) {
                const code = pending.value;
                context.save({ pendingCode: { ...pending, value: null, consumed: true, consumedAt: now } });
                context.check();
                log('gateway', `account ${account.accountId} 领取同世代扫码 Code（一次性交接）`);
                return code;
            }
            wxLayerCooling(context.rec, 'code');
            const binding = wxSessionBinding(context.rec, context.key);
            // 短链失败不会证明缓存票无效；仅当本次实际复用旧会话时，才允许有预算的重建。
            let dropCachedTicket = false;
            let lastIssueCachedSession = null;
            const issue = async (forceNew = false) => {
                context.check();
                const cached = !forceNew && !dropCachedTicket && svc.hasNativeSession(context.rec.nativeSession, binding)
                    ? context.rec.nativeSession : null;
                lastIssueCachedSession = cached;
                if (!cached && !context.rec.loginBuffer) {
                    throw Object.assign(new Error('loginBuffer 为空且无可用原生会话'), { stage: 'local_credential_missing' });
                }
                return svc.issueCode(context.session(), WX_APP_ID, {
                    signal: options.signal, deadline: options.deadline, timeoutMs: WX_ISSUE_TIMEOUT_MS,
                    session: cached, sessionBinding: binding,
                    onSession(nativeSession) {
                        if (nativeSession.binding !== binding) throw Object.assign(new Error('原生会话世代不匹配'), { stage: 'credential_conflict' });
                        context.save({ nativeSession, nativeSessionUpdatedAt: Date.now(), nativeReverify: null });
                        context.check();
                    },
                });
            };
            // 短链解码/认证失败不能证明缓存票被拒。ManualAuth只能验证当前loginBuffer，
            // 其-10也不能反向证明旧PSK票过期。单票预算先落盘，跨调用/进程不反复认证。
            const reverifyTicketOnce = async (error, cached) => {
                context.check();
                const ticketFingerprint = require('node:crypto').createHash('sha256')
                    .update(`${binding}:${cached.ticket}`).digest('hex');
                const previous = context.rec.nativeReverify;
                if (previous?.generation === context.rec.credentialGeneration
                    && previous.ticketFingerprint === ticketFingerprint) throw error;
                context.save({ nativeReverify: {
                    generation: context.rec.credentialGeneration, ticketFingerprint,
                    attemptedAt: Date.now(), state: 'attempted', failure: wxFailureState(error)
                } });
                const marker = context.rec.nativeReverify;
                dropCachedTicket = true;
                const age = Number(cached.createdAt) > 0
                    ? ((Date.now() - Number(cached.createdAt)) / 3600000).toFixed(1) : 'unknown';
                const expiresAt = Number(cached.expiresAt);
                log('gateway', `account ${account.accountId} 短链响应无法解码，ticket=${ticketFingerprint.slice(0, 12)} age=${age}h `
                    + `expires=${Number.isSafeInteger(expiresAt) ? new Date(expiresAt).toISOString() : 'unknown'}，`
                    + '用loginBuffer重建一次，不判旧票失效');
                try {
                    return await issue(true);
                } catch (retryError) {
                    // onSession若已保存新票则清旧预算；仅失败于保存新会话前才保留旧票失败记录。
                    if (context.rec.nativeReverify?.ticketFingerprint === marker.ticketFingerprint
                        && retryError.stage !== 'credential_conflict' && retryError.stage !== 'persist_native_session') {
                        context.check();
                        context.save({ nativeReverify: { ...marker, state: 'failed', failure: wxFailureState(retryError) } });
                    }
                    retryError.ticketRebuildAttempted = true;
                    throw retryError;
                }
            };
            const issueVerified = async () => {
                try { return await issue(); }
                catch (error) {
                    // 冷启动onSession写入的是本次的新票，不能拿它当成复用了旧票再认证一次。
                    if (!error?.ticketUnverified || error.stage !== 'shortlink' || !lastIssueCachedSession
                        || !context.rec.loginBuffer) throw error;
                    return reverifyTicketOnce(error, lastIssueCachedSession);
                }
            };
            try {
                let code;
                try { code = await issueVerified(); }
                catch (error) {
                    context.check();
                    // 只有ManualAuth明确拒绝当前loginBuffer时才更新缓冲，不把它误写成缓存票失效。
                    if (error.code !== 'WX_MANUAL_AUTH_REJECTED' || error.serverCode !== -10) throw error;
                    log('gateway', `account ${account.accountId} 当前loginBuffer认证被拒（ManualAuth -10），按需更新缓冲`);
                    await refreshWxBufferInContext(context, svc, options);
                    try {
                        code = await issue(true);
                    } catch (finalError) {
                        // 换新 buffer 后仍被拒：这才是可对外告警的"需要重新扫码"，不贴临时故障标签。
                        if (finalError.code === 'WX_MANUAL_AUTH_REJECTED' && finalError.serverCode === -10) {
                            finalError.ticketRejected = true; // 兼容旧调用，只代表当前buffer恢复未成功
                            finalError.needRescan = true;
                            finalError.recoveryExhausted = true;
                        }
                        throw finalError;
                    }
                }
                context.check();
                if (typeof code !== 'string' || !code) throw Object.assign(new Error('微信换码返回空 Code'), { stage: 'js_login' });
                context.save({ codeFailureCount: 0, codeRetryAfter: 0, codeError: null });
                return code;
            } catch (error) {
                if (options.signal?.aborted) throw options.signal.reason;
                if (error.stage !== 'credential_conflict' && error.stage !== 'persist_native_session'
                    && error.stage !== 'persist_rotated' && error.stage !== 'local_credential_missing') {
                    if (error.stage === 'token_refresh' || error.stage === 'token_cooldown') error.retryAfter = context.rec.tokenRetryAfter;
                    else if (error.stage === 'login_buffer' || error.stage === 'buffer_cooldown') error.retryAfter = context.rec.bufferRetryAfter;
                    else if (error.stage !== 'code_cooldown') {
                        const count = Math.min(16, (Number(context.rec.codeFailureCount) || 0) + 1);
                        context.save({ codeFailureCount: count, codeRetryAfter: Date.now() + wxLayerBackoff(count), codeError: wxFailureState(error) });
                        error.retryAfter = context.rec.codeRetryAfter;
                    }
                }
                throw error;
            }
        }, options);
    } catch (error) {
        account.wxLastCodeError = error;
        logWarn('gateway', `account ${account.accountId} 微信恢复失败 stage=${error.stage || 'unknown'} reason=${classifyWxCodeError(error).reason}`);
        return null;
    }
}

function persistWxCredentials(file, expected, patch) {
    const { writeWxCredential } = require('../services/wx-login/credential-storage');
    return writeWxCredential(file, patch, expected);
}

function persistRefreshedWxBuffer(file, oldRec, refreshed) {
    return persistWxCredentials(file, oldRec, {
        loginBuffer: refreshed.loginBuffer,
        refreshtoken: refreshed.refreshtoken || oldRec.refreshtoken || '',
        accesstoken: refreshed.accesstoken || oldRec.accesstoken || '',
        loginBufferUpdatedAt: Date.now(),
        bufferRefreshPending: false,
        bufferRetryAfter: 0,
        bufferFailureCount: 0,
        bufferError: null,
        bufferLastSuccessAt: Date.now(),
    });
}

async function refreshWxTokenInContext(context, svc, options = {}) {
    context.check();
    wxLayerCooling(context.rec, 'token');
    let rotatedSaved = false;
    try {
        const credentials = await svc.refreshCredentials(context.session(), {
            ...options, timeoutMs: WX_REFRESH_TIMEOUT_MS,
            onCredentialsRotated(rotated) {
                // token 响应已产生副作用，先 CAS 保存，再检查取消；不动 buffer/原生会话。
                context.save(rotated);
                rotatedSaved = true;
                context.check();
            },
        });
        if (!rotatedSaved || !credentials?.accesstoken) throw Object.assign(new Error('微信 token 响应未保存'), { stage: 'persist_rotated' });
        context.check();
        context.save({ tokenRetryAfter: 0, tokenFailureCount: 0, tokenError: null,
            tokenRefreshPending: false, tokenLastSuccessAt: Date.now() });
        return credentials;
    } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (error.stage !== 'credential_conflict' && error.stage !== 'persist_rotated') {
            const failures = Math.min(16, (Number(context.rec.tokenFailureCount) || 0) + 1);
            context.save({ tokenFailureCount: failures, tokenRetryAfter: Date.now() + wxLayerBackoff(failures),
                tokenRefreshPending: true, tokenError: wxFailureState(error) });
            error.retryAfter = context.rec.tokenRetryAfter;
        }
        throw error;
    }
}

async function refreshWxBufferInContext(context, svc, options = {}) {
    context.check();
    wxLayerCooling(context.rec, 'buffer');
    // buffer 按需恢复优先当前 access；只在真实到期/独立token调度到期时才续token。
    if (wxTokenDue(context.rec) || !context.rec.accesstoken) {
        await refreshWxTokenInContext(context, svc, options);
    }
    try {
        const refreshed = await svc.refreshBufferWithAccessToken(context.session(), {
            ...options, timeoutMs: WX_REFRESH_TIMEOUT_MS,
        });
        context.check();
        if (!refreshed?.loginBuffer) throw Object.assign(new Error('未收到有效 loginBuffer'), { stage: 'login_buffer' });
        context.rec = persistRefreshedWxBuffer(context.file, context.rec, refreshed);
        return refreshed;
    } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (error.stage !== 'credential_conflict' && error.stage !== 'persist_rotated') {
            const failures = Math.min(16, (Number(context.rec.bufferFailureCount) || 0) + 1);
            context.save({ bufferRefreshPending: true, bufferFailureCount: failures,
                bufferRetryAfter: Date.now() + wxLayerBackoff(failures), bufferError: wxFailureState(error) });
            error.retryAfter = context.rec.bufferRetryAfter;
        }
        throw error;
    }
}

// 完整授权操作串行；相同层的并发调用共享结果，跨层则排队后重读当前世代。
const wxRefreshFlights = new Map();
const wxTokenFlights = new Map();
function refreshWxBufferSingleFlight(file, rec, session, svc, options = {}) {
    if (wxRefreshFlights.has(file)) return wxRefreshFlights.get(file);
    const flight = withWxCredentialContext(file, rec, context => refreshWxBufferInContext(context, svc, options), options);
    wxRefreshFlights.set(file, flight);
    const clear = () => { if (wxRefreshFlights.get(file) === flight) wxRefreshFlights.delete(file); };
    flight.then(clear, clear);
    return flight;
}
function refreshWxTokenSingleFlight(file, rec, svc, options = {}) {
    if (wxTokenFlights.has(file)) return wxTokenFlights.get(file);
    const flight = withWxCredentialContext(file, rec, async context => {
        // 排队期间前一操作可能已续期成功；不能再次远端轮换。
        if (!wxTokenDue(context.rec)) return { skipped: true, reason: 'token_not_due' };
        return refreshWxTokenInContext(context, svc, options);
    }, options);
    wxTokenFlights.set(file, flight);
    const clear = () => { if (wxTokenFlights.get(file) === flight) wxTokenFlights.delete(file); };
    flight.then(clear, clear);
    return flight;
}

// 模块级通用超时兜底（保活定时器与换码逻辑共用）：MMTLS 握手在服务器环境可能长时间不返回，
// 若 await 卡死会拖累整个重连/保活流程——比失败更糟，故一律加超时。
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时 ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ============ 授权层独立续期 ============
// 每两分钟只检查本地有效期，服务端声明到期前四分钟才发 token 请求；
// 未下发期限的旧记录保留90分钟运营兜底，不伪造服务器期限。
// 40188 是授权范围拒绝；仅凭历史日志不能断言由固定轮询、网络或风控导致。
const WX_KEEPALIVE_INTERVAL_MS = 2 * 60 * 1000; // 只读本地检查频率，不是授权请求频率
const WX_TOKEN_REFRESH_SKEW_MS = 4 * 60 * 1000;
const WX_CREDENTIAL_OPERATION_TIMEOUT_MS = WX_ISSUE_TIMEOUT_MS * 2 + WX_REFRESH_TIMEOUT_MS * 2;
// 保活"最小凭证年龄"：凭证比这更新就跳过本轮保活（见 keepWxCredentialAlive 注释）。
// 取 90 分钟，留 30 分钟余量给 refreshtoken 的约 2h 失效窗。
const WX_KEEPALIVE_MIN_AGE_MS = 90 * 60 * 1000;

// ============ ⭐ 微信换码失败分类（2026-10-31）============
// 背景问题：旧逻辑把所有换码失败一视同仁，累计 3 次即 networkStopped（必须人工扫码）。
// 但实测 72 小时数据表明这个判定过严、且方向错了：
//   - 保活成功 70 次 vs 失败 6 次，凭证维护本身是健康的（32:2 → 70:6）；
//   - 6 次失败**全部是 40188 invalid scope**，且**全部发生在网络抖动期间**
//     （10-30 10:27 那次明确有"业务请求连续超时 2 次→假死"在前，10:28 心跳超时 174928ms）；
//   - 40188 是腾讯对授权接口的**临时性 scope 拒绝**，不是凭证过期。网络恢复后同一份凭证
//     往往下一轮就能换码成功（10-28 已实测：静默 3h 后自然恢复）。
// 结论：必须把"临时性失败"与"凭证真失效"分开计数，否则几次网络抖动就把账号打成必须扫码的状态。
//
// 永久性失败（凭证确实废了，等下一轮也没用）：
//   - 仅明确本地凭据缺失需要扫码；token 阶段拒绝不证明凭据失效
//   - 凭证文件缺失、loginBuffer 为空、openid 无对应文件：本地状态问题，重试无意义
// 临时性失败（网络/腾讯侧限流，应退避后重试，不计入 scan-needed）：
//   - 40188 invalid scope：临时 scope 拒绝
//   - 换码超时 / 刷新超时（withTimeout 抛出）
//   - ECONNRESET / ETIMEDOUT / socket hang up / network 等网络类错误
//   - ManualAuth rejected：服务端拒绝但凭证未必失效，多为瞬时
const WX_TEMP_FAIL_BACKOFF_BASE_MS = 5 * 60 * 1000;
// 各层分别落盘指数退避，不互相禁用。12小时仅是本地请求预算，不保证授权最终恢复。
const WX_TEMP_FAIL_ACCOUNT_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * 判定微信换码失败是"临时性"（可自愈）还是"永久性"（需重新扫码）。
 * @param {Error|string} error 服务实际错误或旧调用的错误消息
 * @returns {{temporary:boolean, reason:string}}
 */
function classifyWxCodeError(error) {
    const s = String(error && error.message || error || '');
    if (error && error.stage === 'local_credential_missing') {
        return { temporary: false, reason: 'local_credential_missing' };
    }
    // —— 永久性：本机凭证文件/字段问题，重试无意义 ——
    if (!(error && error.stage) && /loginBuffer 文件不存在|loginBuffer 为空|wxid 对应凭证不匹配/i.test(s)) {
        return { temporary: false, reason: 'local_credential_missing' };
    }
    if (!(error && error.stage) && /无 refreshtoken|旧版落盘未保存凭证/i.test(s)) {
        return { temporary: false, reason: 'no_refreshtoken' };
    }
    // token 阶段失败或服务返回 empty 也可能是临时拒绝，不能由阶段/累计次数推断凭据失效。
    if (error && (error.stage === 'persist_rotated' || error.stage === 'credential_conflict')) {
        return { temporary: true, reason: error.stage };
    }
    // —— 临时性 ——
    if (error?.wechatCode === 40188 || error?.code === 40188 || error?.serverCode === 40188 || /40188|invalid scope/i.test(s)) {
        return { temporary: true, reason: '40188_scope' };
    }
    if (/超时|timeout/i.test(s)) {
        return { temporary: true, reason: 'timeout' };
    }
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(s)) {
        return { temporary: true, reason: 'network' };
    }
    if (/ManualAuth reje/i.test(s)) {
        return { temporary: true, reason: 'manualauth_rejected' };
    }
    // 未知错误：保守按临时处理（宁可多重试几次，也不要误判成"必须扫码"）
    return { temporary: true, reason: 'unknown' };
}

// 兼容旧服务错误携带的新凭据；正式链路由 token 响应回调立即 CAS 保存。
// 成功响应不代表 token 必然变化，也不能仅从响应推断旧 token 当场失效。
function persistRotatedCredentialsOnError(file, rec, err) {
    const nextRefresh = err && err.refreshtoken;
    const nextAccess = err && err.accesstoken;
    if (!nextRefresh && !nextAccess) return false;
    persistWxCredentials(file, rec, {
        ...(nextRefresh ? { refreshtoken: nextRefresh } : {}),
        ...(nextAccess ? { accesstoken: nextAccess } : {}),
    });
    return true;
}

function clearWxTemporaryFailures(account, { cancelReconnect = true } = {}) {
    account.wxTempFailCount = 0;
    account.wxRetryAfter = 0;
    account.wxLastCodeError = '';
    account.wxCodeFailCount = 0;
    account.wxBufferAlerted = false;
    account.wxRescanAlerted = false;
    if (cancelReconnect && account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
}

function armWxReconnectAt(account, at) {
    if (gatewayShuttingDown || account.networkStopped || !gatewayOwnsAccount(account.accountId)) return;
    if (!account.connectionDead && account.ws && account.ws.readyState === 1 && account.userState.gid) return;
    cancelReconnectTimers(account);
    const socket = account.ws;
    const epoch = account.connectionEpoch;
    const generation = account.reconnectGeneration;
    const timer = setTimeout(() => {
        if (account.reconnectTimer !== timer || account.ws !== socket || account.connectionEpoch !== epoch
            || account.reconnectGeneration !== generation || account.networkStopped) return;
        account.reconnectTimer = null;
        reconnect(account).catch(error => {
            logWarn('gateway', `account ${account.accountId} 微信恢复任务异常: ${error.message}`);
        });
    }, Math.max(1, at - Date.now()));
    account.reconnectTimer = timer;
    if (timer.unref) timer.unref();
}

function readWxCredentialGeneration(account) {
    try {
        const key = readStoreWxBufferKey(account.accountId);
        if (!key || path.basename(key) !== key || /[\\/]/.test(key)) return '';
        const record = JSON.parse(fs.readFileSync(path.join(WX_LOGIN_DIR, `${key}.json`), 'utf8'));
        return record.credentialGeneration || '';
    } catch { return ''; }
}

function connectWxSingleFlight(account) {
    if (account.wxConnectFlight) return account.wxConnectFlight;
    const epoch = account.connectionEpoch || 0;
    const controller = new AbortController();
    account.wxConnectController = controller;
    const flight = (async () => {
        if (gatewayShuttingDown || !gatewayOwnsAccount(account.accountId) || account.networkStopped) return false;
        if (globalReconnectPaused(account) || account.shortSessionCount >= SHORT_SESSION_MAX || account.deadReconnectCount > WX_DEAD_RECONNECT_MAX) return false;
        if (!account.connectionDead && account.ws && (account.ws.readyState === 0 || account.ws.readyState === 1)) {
            return account.userState.gid > 0 || await (account.loginPromise || Promise.resolve(false));
        }
        const fresh = await issueWxCodeFromBuffer(account);
        if (gatewayShuttingDown || (account.connectionEpoch || 0) !== epoch || !gatewayOwnsAccount(account.accountId) || account.networkStopped) return false;
        // 静默退避已进入换码时旧 WS 仍可能恢复；恢复入站优先，不能拿新码顶掉恢复的会话。
        if (!account.connectionDead && account.ws?.readyState === 1 && account.userState.gid) return true;
        if (!fresh) return handleWxCodeFailure(account, account.wxLastCodeError);
        // 取到 code 不等于登录成功。故障计数直到真实 LoginReply 才清零。
        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
        stopSecurityRuntime(account, '微信重连');
        closeCurrentWs(account, { terminate: true });
        account.userState.gid = 0;
        account.clientSeq = 0;
        account.serverSeq = 0;
        rejectAllPending(account, '连接重置，请求已取消');
        account.savedCode = fresh;
        connect(account, fresh);
        return account.loginPromise ? await account.loginPromise : true;
    })().catch(error => {
        if ((account.connectionEpoch || 0) !== epoch || account.networkStopped || controller.signal.aborted) return false;
        return handleWxCodeFailure(account, error);
    });
    account.wxConnectFlight = flight;
    const clear = () => {
        if (account.wxConnectFlight === flight) account.wxConnectFlight = null;
        if (account.wxConnectController === controller) account.wxConnectController = null;
    };
    flight.then(clear, clear);
    return flight;
}

function handleWxCodeFailure(account, error, { schedule = true } = {}) {
    account.wxLastCodeError = error;
    const cls = classifyWxCodeError(error);
    if (schedule && account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
    // 仅在缓冲更新后再次收到ManualAuth -10、且恢复链明确完成时建议重扫码。
    // 单个旧ticketRejected标签或任何解码失败均不是扫码依据，仍保持退避不停止游戏网关。
    if (error?.needRescan === true && error?.recoveryExhausted === true
        && error.code === 'WX_MANUAL_AUTH_REJECTED' && error.serverCode === -10 && !account.wxRescanAlerted) {
        account.wxRescanAlerted = true;
        // worker 可能尚未连接；无论是否送达，都保留一条账号级记录可供面板查看。
        emitEvent(account, 'code_invalid', {
            reason: 'wx_buffer_auth_rejected', needRescan: true, networkStopped: false,
            detail: 'loginBuffer刷新后ManualAuth仍拒绝，建议面板扫码；自动恢复继续按预算退避',
        });
    }
    if (!cls.temporary) {
        account.wxCodeFailCount += 1;
        account.networkStopped = true;
        if (!account.wxBufferAlerted) {
            account.wxBufferAlerted = true;
            emitEvent(account, 'code_invalid', { reason: 'wx_buffer_expired', needRescan: true, attempts: account.wxCodeFailCount, detail: cls.reason });
        }
        return false;
    }
    account.wxCodeFailCount = 0;
    const cooled = Number(error?.retryAfter) > Date.now();
    if (!cooled) account.wxTempFailCount = Math.min(16, (account.wxTempFailCount || 0) + 1);
    const backoffMs = cooled ? Number(error.retryAfter) - Date.now() : wxLayerBackoff(account.wxTempFailCount || 1);
    account.wxRetryAfter = Date.now() + backoffMs;
    logWarn('gateway', `account ${account.accountId} 微信临时失败（${cls.reason}），冷却 ${Math.round(backoffMs / 60000)} 分钟，未判定需扫码`);
    if (schedule && !account.networkStopped) armWxReconnectAt(account, account.wxRetryAfter);
    return false;
}

async function keepWxCredentialAlive(accountId) {
    if (!gatewayOwnsAccount(accountId)) return;
    const acc = getStoreAccount(accountId);
    if (!acc || acc.platform !== 'wx') return;
    let source;
    try { source = readWxCredential(accountId); }
    catch { return; }
    if (!source || !source.rec.refreshtoken || !wxTokenDue(source.rec)) return;
    if (Number(source.rec.tokenRetryAfter) > Date.now()) return;
    try {
        const { WxLoginService } = require('../services/wx-login/service');
        const credentials = await refreshWxTokenSingleFlight(source.file, source.rec, new WxLoginService(), {
            deadline: Date.now() + WX_REFRESH_TIMEOUT_MS,
        });
        if (!credentials.skipped) {
            log('gateway', `account ${accountId} 微信 token-only 续期并落盘成功 business=${credentials.refreshBusinessId || 'pc_yyb'} `
                + `expirySource=${credentials.accessTokenExpirySource || 'unknown'} tokenExpiresAt=${credentials.accessTokenExpiresAt ?? 'unknown'} `
                + `cookieExpirySource=${credentials.accessTokenCookieExpirySource || 'unknown'}（未换码、未重连游戏）`);
        }
    } catch (error) {
        // token 独立调度，绝不影响游戏WS、原生会话或已有的重连计数/计时器。
        logWarn('gateway', `account ${accountId} 微信 token-only 续期失败 stage=${error.stage || 'unknown'} reason=${classifyWxCodeError(error).reason}`);
    }
}

let wxKeepaliveTimer = null;
function startWxKeepalive() {
    if (wxKeepaliveTimer) clearInterval(wxKeepaliveTimer);
    const tick = () => {
        try {
            const res = getStoreModule().getAccounts();
            const list = Array.isArray(res) ? res : ((res && res.accounts) || []);
            for (const acc of list) {
                if (acc.platform === 'wx') keepWxCredentialAlive(acc.id).catch(error => {
                    logWarn('gateway', `account ${acc.id} 微信凭据调度异常 stage=${error.stage || 'unknown'}`);
                });
            }
        } catch (e) {
            logWarn('gateway', `微信主动保活定时器异常: ${String(e.message).slice(0, 100)}`);
        }
    };
    wxKeepaliveTimer = setInterval(tick, WX_KEEPALIVE_INTERVAL_MS);
    tick(); // 启动立即做本地年龄检查，实际授权仍受 90min 最小年龄约束
}

async function reconnect(account, newCode) {
    if (!gatewayOwnsAccount(account.accountId)) return false;
    if (gatewayShuttingDown || account.networkStopped) return false;
    syncAccountPlatform(account);
    if (!account.connectionDead && account.ws && (account.ws.readyState === 0 || account.ws.readyState === 1)) {
        return account.userState.gid > 0 || await (account.loginPromise || Promise.resolve(false));
    }
    if (account.platform === 'wx' && account.wxRetryAfter > Date.now()) {
        armWxReconnectAt(account, account.wxRetryAfter);
        return false;
    }
    // 【风控熔断·全局】全网 1006 风暴期间一律不重连（1006 多半是腾讯风控，越重连封得越久）
    if (globalReconnectPaused(account)) {
        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
        return false;
    }
    // 【风控熔断·短命会话】连续多次"刚建连就被 1006" → 疑似风控/封禁特征，停止该账号自动重连。
    // 用户重新抓码（newCode）时不拦截，由 connect 帧决定是否清零。
    if (!newCode && (account.shortSessionCount || 0) >= SHORT_SESSION_MAX) {
        if (!account.shortSessionAlerted) {
            account.shortSessionAlerted = true;
            logWarn('gateway', `[风控熔断] account ${account.accountId} 连续 ${account.shortSessionCount} 次会话均在 ${Math.round(SHORT_SESSION_MS / 1000)}s 内被 1006，判定疑似风控/封禁，停止自动重连（请人工确认账号状态或重新抓包）`);
            emitEvent(account, 'risk_control_suspected', { shortSessionCount: account.shortSessionCount, threshold: SHORT_SESSION_MAX, reason: 'short_session_1006' });
        }
        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
        return false;
    }
    // 【重连风暴总闸】判死重连已判定"凭证失效、停止自动重连"后，任何路径都不得再发起重连，
    // 除非用户带来新 Code（newCode）或重新 connect（此时计数已被清零）。
    // 背景：微信 loginBuffer 失效后，换码逻辑虽已停止，但"业务请求超时判死"路径仍会无脑调用
    // reconnect —— 它不看凭证状态、也不更新 codeInvalidCount/reconnectAttempts，
    // 于是绕过所有既有停止条件空转重连（实测每小时 33 次、持续 10 小时），
    // 最终拖垮单进程 gateway 的事件循环，把同网关下其它账号全部连带判死掉线。
    const deadReconnectMax = getDeadReconnectMax(account);
    if (!newCode && account.deadReconnectCount > deadReconnectMax) {
        if (!account.deadReconnectAlerted) {
            account.deadReconnectAlerted = true;
            logWarn('gateway', `account ${account.accountId}${account.platform === 'wx' ? '' : '(QQ)'} 判死重连已达上限（${account.deadReconnectCount} 次 / ${deadReconnectMax}），拒绝再次重连以免风暴影响其它账号；请重新抓包/扫码后由 connect 帧重置`);
            emitEvent(account, 'dead_reconnect_exhausted', { deadReconnectCount: account.deadReconnectCount, source: 'reconnect_guard' });
        }
        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
        return false;
    }
    // 先补全 platform，确保微信换码分支能命中（网关重启后 platform 可能为空）
    syncAccountPlatform(account);

    // 【QQ Code 可复用 —— 2026-09-03 实测验证】
    // 不再把 QQ 判定为"一次性 Code、断线复用必失败"。
    // 用新鲜 QQ code 实测（_verify_qq_code_reuse.js 两轮登录均成功）：同一 Code 断开后
    // 全新建 WS 可再次登录成功（gid 完全一致），与上游 xxxscarlxrd404/1079多 等实现一致。
    // 因此 QQ 账号断线后必须复用保存的 savedCode 自动重连 + 心跳保活，而不是 1006 就判失效、
    // 停止重连（那会让 QQ 一掉线就永久残废、只能人工重抓包）。
    // 原"QQ 重连 >=2 次即停止自动重连"的分支已删除，改为：
    //   断线 → ws close/error → scheduleReconnect → 下面用 savedCode 直接重连（不换码）。
    //   code 真过期 → 连不上后由业务超时判死路径累积 deadReconnectCount，到分平台上限
    //   （微信 getDeadReconnectMax=3 / QQ=10）时兜底停止并告警"请重新抓包"，不会无限风暴拖垮同网关其它账号。
    // 微信账号走下方 loginBuffer 自动换码（refreshtoken 续期）分支，不受影响。

    // Code 连续失效防风暴闸门：基于 codeInvalidCount（连接 close=1006 时递增，登录成功时清零）。
//   - 微信：code 一次性，过期后反复 1006，达 CODE_INVALID_MAX(6) 即停并告警重扫。
//   - QQ：code 可复用，正常断线重连成功即清零（不误伤；达到 QQ_CODE_INVALID_MAX(20)）——
//     仅当 code 真已失效（如抓后长时间未用、登录态被删、持续 1006/建连失败）时才触发停止，
//     并由 connect 新 code/重新登录清零。作为防无限重连风暴的最后兜底（保护同网关其它账号）。
    const invalidCap = account.platform === 'wx' ? CODE_INVALID_MAX : QQ_CODE_INVALID_MAX;
    if (!newCode && account.codeInvalidCount >= invalidCap) {
        // 一并清掉已排队的重连 timer，否则它还会再拉起一次重连（实测停不住）
        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
        if (!account.codeInvalidAlerted) {
            account.codeInvalidAlerted = true;
            const reason = account.platform === 'wx' ? 'wx_code_expired' : 'qq_code_expired';
            logWarn('gateway', `account ${account.accountId}${account.platform === 'wx' ? '' : '(QQ)'} Code 连续失效 ${account.codeInvalidCount} 次，已停止自动重连（避免重连风暴影响其它账号），请重新抓包/扫码获取新 Code`);
            emitEvent(account, 'code_invalid', { reason, attempts: account.codeInvalidCount });
        }
        return false;
    }
    let code = newCode || account.savedCode;
    // 微信：code 一次性，断线重连必须用 loginBuffer 重新换码；否则用旧 code 会被 gameserver 判异常并顶下线。
    // 注意：主容器 worker 每次重连都会自带一个（可能已过期的）wx code 作为 newCode 发来，
    // 若此处仍写 `&& !newCode`，则主容器一带 code 就跳过本分支、直接用过期 code → 1006 死循环，
    // refreshtoken 续期路径永远走不到。故微信**始终**由网关自行从 wx-login 文件派生 code
    // （快路径用 buffer，过期则 refreshtoken 续期），不信任主容器带来的过期 code。
    if (account.platform === 'wx') return await connectWxSingleFlight(account);
    stopSecurityRuntime(account, '重连');
    closeCurrentWs(account, { terminate: true });
    account.userState.gid = 0;
    account.clientSeq = 0;
    account.serverSeq = 0;
    rejectAllPending(account, '连接重置，请求已取消');
    connect(account, code);
    return true;
}

function stopNetwork(account, reason = '停止网络') {
    account.connectionEpoch = (account.connectionEpoch || 0) + 1;
    account.networkStopped = true;
    if (account.wxConnectController) account.wxConnectController.abort(new Error(reason));
    cancelReconnectTimers(account);
    clearHealthTimers(account);
    stopSecurityRuntime(account, reason);
    rejectAllPending(account, '网络已停止');
    closeCurrentWs(account, { terminate: true });
    account.userState.gid = 0;
}

function shutdownGateway() {
    if (gatewayShutdownFlight) return gatewayShutdownFlight;
    gatewayShuttingDown = true;
    if (wxKeepaliveTimer) { clearInterval(wxKeepaliveTimer); wxKeepaliveTimer = null; }
    for (const account of accounts.values()) {
        for (const op of account.operations) {
            if (op.sent && op.kind === 'business' && !op.read) shutdownWrites.add(op);
        }
    }
    const deadline = Math.min(Date.now() + WRITE_SETTLEMENT_TIMEOUT_MS,
        Math.max(Date.now(), ...Array.from(shutdownWrites, op => op.deadline))) + 5000;
    let drainTimer;
    const drained = new Promise(resolve => {
        finishShutdownDrain = resolve;
        if (shutdownWrites.size === 0) resolve();
        else drainTimer = setTimeout(() => {
            for (const account of accounts.values()) {
                for (const op of Array.from(account.operations)) {
                    if (shutdownWrites.has(op)) finishOperation(account, op,
                        requestError('关闭排空结算期限已到', 'REQUEST_TIMEOUT', op));
                }
            }
            resolve();
        }, Math.max(1, deadline - Date.now()));
    });
    gatewayShutdownFlight = drained.then(() => {
        clearTimeout(drainTimer);
        finishShutdownDrain = null;
        for (const account of accounts.values()) stopNetwork(account, '网关已完成写入排空');
        log('gateway', '网关写入排空完成，关闭连接并退出');
        process.exit(0);
    });
    // 不提前停止 runtime/WS；只停止新上报及恢复，原 operation timer/reply 负责结算唤醒。
    for (const account of accounts.values()) {
        cancelReconnectTimers(account);
        clearHealthTimers(account);
        if (account.heartbeatTimer) { clearInterval(account.heartbeatTimer); account.heartbeatTimer = null; }
        if (account.aceService) account.aceService.stop('网关排空');
        if (account.wxConnectController) account.wxConnectController.abort(new Error('网关排空'));
        for (const op of Array.from(account.operations)) {
            if (!shutdownWrites.has(op)) finishOperation(account, op,
                requestError('网关排空，非写入结算请求已取消', 'GATEWAY_SHUTTING_DOWN', op));
        }
    }
    log('gateway', `网关进入排空：已发业务写 ${shutdownWrites.size} 个，剩余最多 ${Math.ceil((deadline - Date.now()) / 1000)}s`);
    return gatewayShutdownFlight;
}

// ============ worker 事件回传 ============
function emitEvent(account, name, payload, epoch = account.connectionEpoch) {
    if (account.workerSock) {
        sendFrame(account.workerSock, { t: 'event', accountId: account.accountId, name, payload }, epoch);
    }
}

// 广播给所有已连接 worker（用于全局级事件，如风控熔断暂停）
function emitEventToAll(name, payload) {
    accounts.forEach((account) => {
        if (account && account.workerSock) {
            sendFrame(account.workerSock, { t: 'event', accountId: account.accountId, name, payload });
        }
    });
}

// ============ IPC 服务器 ============
function sendFrame(sock, obj, epoch = obj.connectionEpoch ?? getAccount(obj.accountId)?.connectionEpoch) {
    if (!sock || sock.destroyed) return;
    // 新事件用当前账号世代；旧 operation 的回复显式传旧 epoch，不得被重新标成新会话。
    const frame = epoch == null ? obj : {
        ...obj, connectionEpoch: epoch,
        ...(obj.meta ? { meta: { ...obj.meta, connectionEpoch: epoch } } : {}),
    };
    sock.write(JSON.stringify(frame) + '\n');
}

function startIpcServer() {
    try { fs.unlinkSync(SOCK_PATH); } catch { }
    const server = net.createServer((sock) => {
        registerWorkerSocket(sock);
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.trim()) {
                    try {
                        handleWorkerFrame(sock, JSON.parse(line)).catch(error => {
                            logWarn('gateway', `IPC请求失败: ${error.message}`);
                        });
                    } catch (error) { logWarn('gateway', `IPC帧无效: ${error.message}`); }
                }
            }
        });
        sock.on('close', () => { /* worker 断开：保留游戏连接，等待 worker 重连 */ });
        sock.on('error', () => { });
    });
    server.listen(SOCK_PATH, () => {
        log('gateway', `连接网关进程已启动，监听 ${SOCK_PATH}`);
        if (process.send) process.send({ type: 'gateway_listening' });
    });
}

function gatewayHealthStatus(account) {
    const now = Date.now();
    const age = at => at > 0 ? Math.max(0, now - at) : null;
    const connected = !!(account?.ws?.readyState === 1 && account.userState.gid);
    const ops = account ? Array.from(account.operations) : [];
    const business = ops.filter(op => op.kind === 'business');
    const heartbeatAgeMs = age(account?.lastHeartbeatResponse);
    const businessAgeMs = age(account?.lastBusinessSuccessAt);
    const oldestPendingAgeMs = getOldestPendingAgeMs(business.map(op => op.startedAt), now);
    const health = evaluateGatewayHealth({
        connected, heartbeatAgeMs: heartbeatAgeMs ?? Infinity,
        oldestPendingAgeMs, businessAgeMs, businessObserved: !!account?.lastBusinessSuccessAt,
        businessDegraded: !!account?.requestTimeoutStreak,
    });
    return {
        ...health, connectionDead: !!account?.connectionDead,
        lastInboundAt: account?.lastInboundAt || 0, inboundAgeMs: age(account?.lastInboundAt),
        heartbeatAgeMs, aceAgeMs: age(account?.lastAceResponseAt), businessAgeMs,
        businessReplyAgeMs: age(account?.lastBusinessReplyAt), oldestPendingAgeMs,
        queueLength: account?.sendQueue.length || 0, pendingCount: account?.pendingCallbacks.size || 0,
        businessPendingCount: business.length, criticalPendingCount: ops.length - business.length,
        businessLimit: BUSINESS_REQUEST_LIMIT, criticalLimit: 3,
        requestTimeoutLimitMs: MAX_REQUEST_TIMEOUT_MS, writeSettlementTimeoutMs: WRITE_SETTLEMENT_TIMEOUT_MS,
        writePendingCount: business.filter(op => op.sent && !op.read).length,
        quiescing: gatewayShuttingDown,
        requestTimeoutStreak: account?.requestTimeoutStreak || 0,
        businessNoResponseSince: account?.businessNoResponseSince || 0,
        healthBackoffUntil: account?.healthBackoffUntil || 0, connectionEpoch: account?.connectionEpoch || 0,
    };
}

const workerBindings = new WeakMap();
let workerSocketSerial = 0;
function registerWorkerSocket(sock) {
    if (!workerBindings.has(sock)) workerBindings.set(sock, {
        accountId: '', session: null, generation: null, socketSerial: ++workerSocketSerial,
    });
}
async function handleWorkerFrame(sock, frame) {
    if (!frame || typeof frame !== 'object' || !['ping', 'status', 'connect', 'request', 'cancel', 'stop'].includes(frame.t)) return;
    registerWorkerSocket(sock);
    const accountId = String(frame.accountId || '');
    const binding = workerBindings.get(sock);
    if (binding.accountId && accountId && binding.accountId !== accountId) {
        sendFrame(sock, { t: 'error', accountId, message: '同一 IPC 连接不得混用账号' });
        return;
    }
    if (frame.t === 'ping') { sendFrame(sock, { t: 'pong', ...(accountId ? { accountId } : {}) }); return; }
    if (!accountId) return;
    if (!binding.accountId) {
        binding.accountId = accountId;
        binding.generation = frame.generation ?? null;
    }
    if (frame.generation != null && binding.generation != null && frame.generation !== binding.generation) {
        sendFrame(sock, { t: 'error', accountId, message: 'IPC worker 世代不匹配' });
        return;
    }
    if (frame.t === 'status') {
        if (!gatewayOwnsAccount(accountId, false)) {
            sendFrame(sock, { t: 'error', accountId, message: '此账号不由当前网关托管' });
            return;
        }
        const current = getAccount(accountId);
        sendFrame(sock, { t: 'status', accountId, state: {
            connected: !!(current?.ws && current.ws.readyState === current.ws.OPEN && current.userState.gid),
            ...gatewayHealthStatus(current),
            credentialDirectory: ISOLATED_WX_GATEWAY ? 'wx-gateway' : 'wx-login',
            clientVersion: CONFIG.clientVersion,
            loginProfile: current?.loginProfile || null,
            loginHomeConfirmed: current?.loginProfile === 'player' && Number(current.userState.gid) > 0,
            loginUnlockedSceneIds: current?.unlockedSceneIds || [],
            temporaryFailures: current?.wxTempFailCount || 0,
            retryAfter: current?.wxRetryAfter || 0,
            errorStage: current?.wxLastCodeError?.stage || '',
            errorReason: current?.wxLastCodeError ? classifyWxCodeError(current.wxLastCodeError).reason : '',
            errorCode: current?.wxLastCodeError?.code ?? null,
            networkStopped: !!current?.networkStopped,
            lastGameResponseAt: current?.lastGameResponseAt || 0,
            connecting: !!current?.wxConnectFlight || !!(current?.ws && current.ws.readyState === 0),
            ...(getStoreAccount(accountId)?.platform === 'wx' ? { credential: wxCredentialStatus(accountId) } : {}),
        } });
        return; // 只读诊断不得创建账号或抢占正在工作的 workerSock。
    }
    if (!gatewayOwnsAccount(accountId)) {
        sendFrame(sock, { t: 'error', accountId, message: '此账号不由当前网关托管或正在交接' });
        return;
    }
    if (!['connect', 'request', 'cancel', 'stop'].includes(frame.t)) return;
    let account = getAccount(accountId);
    if (!account && frame.t !== 'connect') {
        sendFrame(sock, { t: 'error', accountId, message: 'worker 必须先发送 connect' });
        return;
    }
    if (gatewayShuttingDown && frame.t === 'connect') {
        sendFrame(sock, { t: 'error', accountId, message: '网关正在排空，拒绝新worker接管' });
        return;
    }
    if (!account) { account = createConn(accountId); accounts.set(accountId, account); }
    if (binding.session === null && frame.t === 'connect') {
        if (binding.socketSerial < account.workerSocketSerial) {
            sendFrame(sock, { t: 'error', accountId, message: '旧 IPC 连接不得接管新 worker' });
            return;
        }
        account.workerSocketSerial = binding.socketSerial;
        binding.session = ++account.workerSession;
        binding.generation = frame.generation ?? binding.generation;
        account.workerSock = sock;
    }
    if (account.workerSock !== sock || account.workerSession !== binding.session) {
        sendFrame(sock, { t: 'error', accountId, message: '旧 worker 会话已被替换' });
        return;
    }
    if ((frame.t === 'request' || frame.t === 'cancel') && frame.connectionEpoch != null
        && frame.connectionEpoch !== account.connectionEpoch) {
        sendFrame(sock, { t: 'response', accountId, seq: frame.seq,
            error: '请求连接世代已过期，未发送', body: '', meta: {
                errorCode: 'STALE_CONNECTION', stage: 'queue', sent: false,
                resultState: 'not_sent', outcomeUnknown: false, retryable: false,
            } }, frame.connectionEpoch);
        return;
    }
    if (frame.t === 'cancel') {
        cancelWorkerOperation(account, sock, frame);
        return;
    }
    if (gatewayShuttingDown && frame.t !== 'request') {
        sendFrame(sock, { t: 'error', accountId, message: '网关正在排空，拒绝重建或提前停止连接' });
        return;
    }
    // 从 store 读取账号真实 platform（微信账号为 wx，QQ 为 qq），用于建连 URL 参数
    try {
        const store = getStoreModule();
        const list = (store.getAccounts() || {}).accounts || [];
        const acc = list.find(a => String(a.id) === accountId);
        if (acc && acc.platform) account.platform = String(acc.platform);
    } catch (e) { /* 读不到时保持默认 */ }

    switch (frame.t) {
        case 'connect': {
            syncAccountPlatform(account);
            if (account.platform === 'wx') {
                if (!account.connectionDead && account.ws && account.ws.readyState === account.ws.OPEN && account.userState.gid) {
                    sendFrame(sock, { t: 'login', accountId, userState: account.userState });
                    return;
                }
                const generation = readWxCredentialGeneration(account);
                const firstGeneration = !!generation && !account.wxCredentialGeneration;
                const renewed = !!generation && !!account.wxCredentialGeneration && generation !== account.wxCredentialGeneration;
                if (firstGeneration) account.wxCredentialGeneration = generation;
                if (renewed) {
                    account.connectionEpoch = (account.connectionEpoch || 0) + 1;
                    cancelReconnectTimers(account);
                    clearHealthTimers(account);
                    closeCurrentWs(account, { terminate: true });
                    stopSecurityRuntime(account, '已收到新扫码凭据');
                    account.userState.gid = 0;
                    account.businessNoResponseSince = 0;
                    if (account.wxConnectController) account.wxConnectController.abort(new Error('已收到新扫码凭据'));
                    account.wxCredentialGeneration = generation;
                    clearWxTemporaryFailures(account);
                    account.codeInvalidCount = 0;
                    account.deadReconnectCount = 0;
                    account.shortSessionCount = 0;
                    account.wxNeedsRefresh = false;
                    account.networkStopped = false;
                    if (account.wxConnectFlight) await account.wxConnectFlight;
                    if (account.workerSock !== sock || account.workerSession !== binding.session || account.networkStopped) return;
                }
                // 任意不同的旧磁盘 code 都不能代表新扫码或绕过冷却。
                if (account.wxRetryAfter > Date.now()) {
                    armWxReconnectAt(account, account.wxRetryAfter);
                    return;
                }
                if (account.networkStopped) {
                    if (account.wxConnectFlight) return; // stop前的操作必须先结算，不能被新帧复活。
                    account.networkStopped = false; // 新的一次start；冷却与新扫码世代检查已在上方完成。
                }
                await connectWxSingleFlight(account);
                return;
            }
            // 活连接：网关已持有 gameserver WebSocket 且已登录
            const liveWs = !!(account.ws && account.ws.readyState === account.ws.OPEN && account.userState && account.userState.gid);
            const incomingCode = frame.code;
            const codeChanged = !!(incomingCode && String(incomingCode) !== String(account.savedCode || ''));
            if ((account.reconnectTimer || account.deadReconnectTimer || account.connectionDead) && !codeChanged) return; // watchdog不得吞掉合法退避。
            // 重抓/重启可能发生在上一次重连风暴期间：先清掉已排队的旧 timer，
            // 否则它稍后会用废 Code 冲服务器，把刚重抓好的新连接顶掉（"抓了好几次仍被顶"的根因）
            if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
            // 收到 connect 即视为一次新的登录尝试，清除"Code 已失效"告警标记与重连计数，允许重新判定
            account.codeInvalidAlerted = false;
            account.reconnectAttempts = 0;
            // 注意：此处**不再**无条件清零 deadReconnectCount / shortSessionCount。
            // worker 每次重启都会发 connect 帧，无条件清零等于"重启即绕过风控熔断"
            // （2026-09-09 微信每 14 秒一次 1006 循环就是这么来的）。
            // 只有用户带来**全新 Code**（真人工重抓/扫码）才重置，见下方 codeChanged 分支。
            // 用户显式带了新 Code（重抓后 /start）：与已存 savedCode 不同即视为换号/换登录态
            if (liveWs && !codeChanged) {
                // worker 重启/重连场景：网关 WebSocket 仍存活，直接复用，不重新登录（不消耗新 Code）
                log('gateway', `account ${accountId} 复用已有网关连接（worker 重启免 Code）`);
                sendFrame(sock, { t: 'login', accountId, userState: account.userState });
            } else {
                // 无活连接，或用户提供了新 Code：关旧建新，用新 Code（或已存 savedCode）重建
                // gateway维护重启后内存savedCode为空；resume帧不带旧code，按本账号读取落盘code。
                const code = codeChanged ? incomingCode : (account.savedCode || getStoreAccount(accountId)?.code);
                if (!codeChanged && account.ws && (account.ws.readyState === 0 || account.ws.readyState === 1)) return;
                account.networkStopped = false;
                if (codeChanged) {
                    log('gateway', `account ${accountId} 收到新 Code，重建连接（启用新登录态）`);
                    // 用户重抓/扫码后下发新 Code：清空失效计数与告警，恢复自动重连
                    account.codeInvalidCount = 0;
                    account.codeInvalidAlerted = false;
                    // 全新 Code = 人工介入确认过账号可用，此时才重置风控熔断计数
                    account.deadReconnectCount = 0;
                    account.deadReconnectAlerted = false;
                    account.shortSessionCount = 0;
                    account.shortSessionAlerted = false;
                    account.connectionEpoch = (account.connectionEpoch || 0) + 1;
                    closeCurrentWs(account, { terminate: true });
                    stopSecurityRuntime(account, '收到新Code');
                    rejectAllPending(account, '已更换登录态');
                    account.userState.gid = 0;
                    account.clientSeq = 0;
                    account.serverSeq = 0;
                }
                connect(account, code);
            }
            break;
        }
        case 'request': {
            if (typeof frame.service !== 'string' || typeof frame.method !== 'string' || typeof (frame.body || '') !== 'string'
                || (frame.body || '').length > Math.ceil(MAX_REQUEST_BODY_BYTES / 3) * 4
                || Buffer.byteLength(frame.body || '', 'base64') > MAX_REQUEST_BODY_BYTES) {
                sendFrame(sock, { t: 'response', accountId, seq: frame.seq, error: '无效网关请求', body: '', meta: { errorCode: 'INVALID_REQUEST', stage: 'queue',
                    sent: false, retryable: false, outcomeUnknown: false, resultState: 'not_sent' } });
                return;
            }
            const body = Buffer.from(frame.body || '', 'base64');
            await sendMsg(account, frame.service, frame.method, body, {
                workerSeq: frame.seq, workerSock: sock,
                timeoutMs: frame.meta?.timeoutMs, deadline: frame.meta?.deadline,
            });
            break;
        }
        case 'stop':
            stopNetwork(account);
            break;
        default:
            break;
    }
}

if (require.main === module || process.env.FARM_GATEWAY_PROCESS === '1') {
    // 网关进程必须先加载 Proto 定义（types.LoginRequest 等）再启动 IPC 服务，否则建连/登录时 encode 会报 undefined
    loadProto().then(() => {
        if (gatewayShuttingDown) return;
        if (ISOLATED_WX_GATEWAY && (!gatewayOwnsAccount('2', false) || SOCK_PATH !== '/sock/qq-farm-wx.sock')) {
            throw new Error('独立微信网关托管登记不存在或 Socket 配置错误');
        }
        startIpcServer();
        startWxKeepalive(); // 每 10min 本地检查，90min 最小年龄控制实际主动授权频率
    }).catch((e) => {
        logWarn('gateway', `Protobuf 加载失败，网关无法建连: ${e.message}`);
        process.exit(1);
    });
    // 兜底：网关是连接持有者，单个异常绝不能让它整个进程崩掉（崩 = 所有账号掉线）
    process.on('uncaughtException', (err) => {
        logWarn('gateway', `未捕获异常(兜底不退出): ${err && err.stack ? err.stack.split('\n')[0] : err}`);
    });
    process.on('unhandledRejection', (reason) => {
        logWarn('gateway', `未捕获的 Promise 拒绝(兜底不退出): ${reason && reason.message ? reason.message : reason}`);
    });
    process.on('SIGTERM', () => { void shutdownGateway(); });
    process.on('SIGINT', () => { void shutdownGateway(); });
}

module.exports = { startIpcServer, connect, shutdownGateway };
