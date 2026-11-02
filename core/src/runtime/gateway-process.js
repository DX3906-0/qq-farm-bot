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

// 微信 loginBuffer 持久化目录：扫码后落盘，断线重连时据此重新 issueCode 换新一次性 code
const WX_LOGIN_DIR = path.join(getDataDir(), 'wx-login');
const WX_APP_ID = 'wx5306c5978fdb76e4';

// 延迟加载 store 模块避免循环依赖（与 network.js 同款实现）
let storeModule = null;
function getStoreModule() {
    if (!storeModule) storeModule = require('../models/store');
    return storeModule;
}

const SOCK_PATH = process.env.FARM_GATEWAY_SOCK || '/tmp/qq-farm-gateway.sock';
const HEARTBEAT_TIMEOUT = 30000;
const MAX_HEARTBEAT_MISS = 6; // 更宽容：连续 6 次心跳超时（约 3 分钟）才判死，避免误杀活连接
const RECONNECT_ALERT_AFTER = 30; // 重连达此次数发一次告警（Code 可能失效），但仍持续重试不放弃
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Code 一次性：连续失效达此次数后停止自动重连，避免反复重复登录把仍存活的旧 session 顶下线
const CODE_INVALID_MAX = 6;
// 【亚健康退避】连接亚健康（业务请求开始连续超时，但还没到判死阈值）时，通知 worker 暂停发业务请求、
// 给心跳让路自愈。核心思路来自上游社区（health-backoff gate）：凌晨服务端一静默，请求会一个接一个
// 挂十几十秒；若 worker 仍按固定间隔发农场/好友任务，pending 队列会被打满、连心跳都排不上，最终判死掉线。
// 这里在 requestTimeoutStreak 达到判死阈值(DEAD_REQUEST_TIMEOUT_STREAK=5)之前，先送出 degraded 信号，
// 让 worker 主动退避、把连接留给心跳+ACE，从根上避免"假死→判死→重连被拒→崩溃停拉"的恶性链条。
const HEALTH_DEGRADED_STREAK = 2;          // 业务请求连续 N 次超时视为"亚健康"（远低于判死的 5 次/150s）
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
// 假死判死阈值（业务级，取代早期的心跳级误杀）：连续 N 次业务请求全部超时，才判定连接真死并主动重连。
// 为何用"业务请求连续超时"而非"心跳超时"：
//   - 心跳超时：服务器可能只是暂不回心跳包，业务请求仍能正常回包；早期 HEARTBEAT_DEAD_MISS 按心跳判死，
//     会在网络抖动时误杀活连接、白白消耗一次性 Code，是账号无故掉线的根因（已移除）。
//   - 业务请求连续超时：说明该连接已完全无法干活（土地/种子/商店/好友全部取不到数据，前端一片空白），
//     继续保活毫无价值，此时重连是唯一出路，且不会比"永久假死"更差。
// ⭐ 2026-10-31 由 5 提到 7（150s → 210s）。依据 72h 实测数据：
//   - 假死重连 115 次（≈每天 38 次），其中第 1 次重连后仍需第 2 次的占 42/66 = 64%，
//     **首次重连成功率只有 36%** —— 说明大量"假死"其实是服务端短时静默，连接本身没坏，
//     重连反而白白消耗一次 Code（微信一次一码，QQ code 也被反复消耗）。
//   - 心跳超时全部集中在 174.9s（6×25s+检测延迟，跨度仅 15ms），证明这是本地阈值判定，
//     不是真实网络时长；真实抖动可能远短于判死阈值。
//   - 210s 仍能保证"真死"的连接在 3.5 分钟内被发现，对农场收益无实质影响。
// 连续 7 次 × 30s：单次网络抖动通常只影响 1~2 个请求，不会误触发。
const DEAD_REQUEST_TIMEOUT_STREAK = 7;
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
        lastHeartbeatResponse: Date.now(),
        heartbeatMissCount: 0,
        heartbeatTimer: null,
        workerSock: null,
        deviceProtocol: null,
        // 微信 loginBuffer 换码连续失败计数：ManualAuth 被拒（登录态失效）后重试无意义，
        // 累计达阈值即停止自动重连并告警，避免无限 1006 刷屏把日志打爆
        wxCodeFailCount: 0,
        wxBufferAlerted: false,
        // ⭐ 2026-11-01 排查补充：以下三个字段由 10-31 的改动引入，必须在此显式初始化。
        // 缺省会依赖 `undefined || 0` 的隐式兜底，一旦某处写成 `account.x += 1` 就变 NaN 且永久污染。
        // wxTempFailCount：临时性换码失败计数（40188/超时/网络），与 wxCodeFailCount 分开，
        //   避免网络抖动被误判成"凭证失效、必须扫码"。
        wxTempFailCount: 0,
        // wxLastCodeError：最近一次换码失败原因，供 classifyWxCodeError 判定临时/永久。
        wxLastCodeError: '',
        // connectingAt：建连闸门时间戳。>0 且距今 <5s 时拒绝重复 connect，
        //   防止同一账号并发建连产生"孤儿 socket"（服务器侧同 code 多连接 → 顶号/1006）。
        connectingAt: 0,
    };
}

// ============ 编码与发送 ============
async function encodeMsg(account, service, method, bodyBytes, clientSeqValue) {
    cryptoWasm.setRuntime(account.tsdkRuntime);
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) finalBody = await cryptoWasm.encryptBuffer(finalBody);
    const gatewayToken = account.initialGamePackInfo || createGatewayToken();
    account.initialGamePackInfo = '';
    const msg = types.GateMessage.create({
        meta: {
            service_name: service,
            method_name: method,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(account.serverSeq),
        },
        body: finalBody,
        auth_token: gatewayToken,
    });
    return types.GateMessage.encode(msg).finish();
}

// callback 为对象：可含 { workerSeq, workerSock, isLogin, onLoginSuccess, isHeartbeat, resolve, reject, timer }
async function sendMsg(account, service, method, bodyBytes, callback) {
    if (!account.ws || account.ws.readyState !== account.ws.OPEN) {
        if (callback && callback.reject) { try { clearTimeout(callback.timer); } catch { } callback.reject(new Error('WebSocket 未连接')); }
        return -1;
    }
    const seq = account.clientSeq + 1;
    account.clientSeq = seq;
    if (callback) account.pendingCallbacks.set(seq, callback);
    try {
        const encoded = await encodeMsg(account, service, method, bodyBytes, seq);
        account.ws.send(encoded);
        return seq;
    } catch (err) {
        if (callback) { account.pendingCallbacks.delete(seq); if (callback.reject) { try { clearTimeout(callback.timer); } catch { } callback.reject(err); } }
        return -1;
    }
}

function gatewaySendRequest(account, service, method, bodyBytes, timeout = 20000) {
    return new Promise((resolve, reject) => {
        const cb = {
            resolve,
            reject,
            timer: setTimeout(() => {
                account.pendingCallbacks.forEach((v, k) => { if (v === cb) account.pendingCallbacks.delete(k); });
                reject(new Error('网关请求超时'));
            }, timeout),
        };
        sendMsg(account, service, method, bodyBytes, cb).then((seq) => {
            if (seq < 0) { try { clearTimeout(cb.timer); } catch { } reject(new Error('WebSocket 未连接')); }
        });
    });
}

// 清空待回调队列：对带 reject 的回调先拒绝再清，避免假死/重连时请求永久挂起
function rejectAllPending(account, reason) {
    account.pendingCallbacks.forEach((cb) => {
        if (cb && typeof cb.reject === 'function') {
            try { clearTimeout(cb.timer); } catch { }
            try { cb.reject(new Error(reason)); } catch { }
        }
    });
    account.pendingCallbacks.clear();
}

// ============ 安全运行时 / ACE ============
function createTsdkRuntime(accountId, deviceProtocol) {
    const customDevice = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    return new TsdkRuntime({
        accountId: String(accountId),
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
        logger: logAce,
    });
}

async function startSecurityRuntime(account, deviceProtocol) {
    stopSecurityRuntime(account, '重新初始化');
    if (!CONFIG.tsdkAceEnabled) throw new Error('TSDK/ACE 已通过 FARM_TSDK_ACE_ENABLED=false 关闭');
    account.tsdkRuntime = createTsdkRuntime(account.accountId, deviceProtocol);
    account.initialGamePackInfo = '';
    cryptoWasm.setRuntime(account.tsdkRuntime);
    await account.tsdkRuntime.init();
}

function startAceService(account) {
    if (!account.tsdkRuntime || !account.tsdkRuntime.ready) return;
    try {
        if (account.aceService) account.aceService.stop('重新启动');
        account.aceService = new AceService({
            runtime: account.tsdkRuntime,
            sendRequest: (svc, method, body, timeout) => gatewaySendRequest(account, svc, method, body, timeout),
            isConnected: () => !!(account.ws && account.ws.readyState === account.ws.OPEN),
            types,
            logger: logAce,
        });
        account.aceService.start();
    } catch (e) {
        logWarn('ACE', `启动失败: ${e.message}`);
    }
}

function stopSecurityRuntime(account, reason) {
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
    try {
        const reply = types.LoginReply.decode(decryptedBody);
        if (reply.basic) {
            const b = reply.basic;
            account.userState.gid = toNum(b.gid);
            account.userState.name = String(b.name || '');
            account.userState.level = toNum(b.level);
            account.userState.gold = toNum(b.gold);
            account.userState.exp = toNum(b.exp);
            account.userState.openId = String(b.open_id || '');
            account.userState.avatar = String(b.avatar_url || '');
            if (account.tsdkRuntime && account.userState.openId) {
                account.tsdkRuntime.bindUser(account.userState.openId);
                account.initialGamePackInfo = account.tsdkRuntime.getEncryptedInitInfo();
            }
        }
    } catch (e) {
        logWarn('gateway', `登录解码失败: ${e.message}`);
    }
}

async function sendLogin(account, onLoginSuccess) {
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
    await sendMsg(account, 'gamepb.userpb.UserService', 'Login', body, { isLogin: true, onLoginSuccess });
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
    account.networkStopped = false;
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
    const now = Date.now();
    const prevWsAlive = !!(account.ws && account.ws.readyState === account.ws.OPEN);
    if (prevWsAlive && account.connectingAt && now - account.connectingAt < 5000) {
        logWarn('gateway', `account ${account.accountId} 建连进行中(${now - account.connectingAt}ms)且旧连接仍活，跳过重复 connect，避免孤儿 socket 顶号`);
        return;
    }
    account.connectingAt = now;
    const plat = account.platform || CONFIG.platform;
    const url = `${CONFIG.serverUrl}?platform=${plat}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${account.savedCode}&openID=`;
    closeCurrentWs(account, { terminate: true });
    // 记录本次建连时间：风控熔断据此判断会话是"短命被踢"还是"稳定健康"
    account.connectedAt = Date.now();

    let deviceProtocol = null;
    try {
        const store = getStoreModule();
        deviceProtocol = store.getDeviceProtocolForAccount(account.accountId);
    } catch (e) {
        log('gateway', `account ${account.accountId} 加载设备协议失败: ${e.message}`);
    }
    account.deviceProtocol = deviceProtocol;

    const socket = new WebSocket(url, { headers: buildWebSocketHeaders(deviceProtocol) });
    account.ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.on('open', async () => {
        account.reconnectAttempts = 0;
        try {
            await startSecurityRuntime(account, deviceProtocol);
            await sendLogin(account, () => onAccountLogin(account));
        } catch (error) {
            logWarn('gateway', `account ${account.accountId} 安全运行时启动失败: ${error.message}`);
            closeCurrentWs(account, { terminate: true });
        }
    });
    socket.on('message', (data) => {
        handleMessage(account, Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on('close', (code) => {
        // 只处理"当前连接"的关闭：reconnect 时旧 ws 会被异步关闭，其延迟 close 事件到达时
        // account.ws 已是新连接，必须忽略，否则会额外排一次重连 → 连锁重连风暴（重复建连被服务器顶号）
        const isCurrent = account.ws === socket;
        if (isCurrent) account.ws = null;
        logWarn('gateway', `account ${account.accountId} 连接关闭 (code=${code})${isCurrent ? '' : ' [旧连接延迟关闭，忽略]'}`);
        if (isCurrent) {
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
                // 微信：1006 几乎必然是 loginBuffer 过期被服务器拒绝（ManualAuth rejected）。
                // issueCode 只是本地编码、永不抛错，快路径无法感知过期，会反复用废 buffer 生成 code → 永久 1006。
                // 这里显式置位，让下次重连的 issueWxCodeFromBuffer 跳过快路径、直接走 refreshtoken 续期。
                if (account.platform === 'wx') account.wxNeedsRefresh = true;
            }
            emitEvent(account, 'disconnect', { code });
            scheduleReconnect(account, `close:${code}`);
        }
    });
    socket.on('error', (err) => {
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
    if (!current) return;
    account.ws = null;
    try { current.removeAllListeners(); } catch { }
    try {
        if (terminate && typeof current.terminate === 'function') current.terminate();
        else current.close();
    } catch { }
}

// ============ 消息处理 ============
function handleMessage(account, buffer) {
    try {
        cryptoWasm.setRuntime(account.tsdkRuntime);
        const gateMessage = types.GateMessage.decode(buffer);
        const meta = gateMessage.meta || {};
        const msgType = meta.message_type;
        const body = gateMessage.body || Buffer.alloc(0);
        // 注意：响应体为明文（network.js 从不 decrypt），直接透传 GateMessage.body

        if (msgType === 2) {
            const clientSeq = toNum(meta.client_seq);
            const cb = account.pendingCallbacks.get(clientSeq);
            if (cb) {
                account.pendingCallbacks.delete(clientSeq);
                // 收到任何回包 = 连接仍在工作，清空"业务请求连续超时"计数（假死判死依据）
                account.requestTimeoutStreak = 0;
                // 亚健康恢复：若之前发过 connection_degraded（健康退避），现在业务已恢复，
                // 通知 worker 立刻解除退避，别白白静默满整个退避窗口
                if (account.healthBackoffChanging) {
                    account.healthBackoffChanging = false;
                    account.degradedStreak = 0;
                    emitEvent(account, 'connection_recovered', {});
                    log('gateway', `account ${account.accountId} 亚健康已恢复，通知 worker 结束退避`);
                }
                // 收到回包 = 连接在干活。但**只有会话稳定存活足够久**才清零故障计数：
                // 否则"连上→3 秒后 1006"的循环里每次登录成功都会清零，
                // DEAD_RECONNECT_MAX 上限永远触发不了（2026-09-09 三账号封禁的直接教训）。
                clearFaultsIfSessionStable(account);
                account.serverSeq = toNum(meta.server_seq) || account.serverSeq;
                if (cb.isLogin) {
                    decodeLoginReply(account, body);
                    if (cb.onLoginSuccess) cb.onLoginSuccess();
                } else if (cb.resolve) {
                    try { clearTimeout(cb.timer); } catch { }
                    cb.resolve({ body, meta: { serverSeq: account.serverSeq } });
                } else if (cb.isHeartbeat) {
                    account.lastHeartbeatResponse = Date.now();
                    account.heartbeatMissCount = 0;
                    // 心跳恢复：清掉告警标记，下次再超时还能重新告警
                    if (account.heartbeatWarned) {
                        account.heartbeatWarned = false;
                        log('gateway', `account ${account.accountId} 心跳已恢复`);
                    }
                } else if (cb.workerSock && cb.workerSeq != null) {
                    try { clearTimeout(cb.timer); } catch { }
                    sendFrame(cb.workerSock, {
                        t: 'response',
                        accountId: account.accountId,
                        seq: cb.workerSeq,
                        error: '',
                        body: Buffer.from(body).toString('base64'),
                        meta: { serverSeq: account.serverSeq },
                    });
                }
            }
        } else if (msgType === 3) {
            if (account.workerSock) {
                sendFrame(account.workerSock, {
                    t: 'notify',
                    accountId: account.accountId,
                    body: Buffer.from(buffer).toString('base64'),
                });
            }
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
    account.wxCodeFailCount = 0;
    account.wxBufferAlerted = false;
    account.networkStopped = false;
    // 标记"已成功登录过"：QQ 一次性 Code 登录即用即废，之后断链重连绝不能再拿同一 Code 冲服务器（否则被顶号）
    account.loggedInOnce = true;
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
    account.lastHeartbeatResponse = Date.now();
    account.heartbeatMissCount = 0;
    account.heartbeatTimer = setInterval(() => {
        if (!account.userState.gid) return;
        const timeSince = Date.now() - account.lastHeartbeatResponse;
        if (timeSince > HEARTBEAT_TIMEOUT) {
            account.heartbeatMissCount += 1;
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
        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(account.userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        sendMsg(account, 'gamepb.userpb.UserService', 'Heartbeat', body, { isHeartbeat: true });
    }, CONFIG.heartbeatInterval || 30000);
}

// ============ 重连 ============
function getReconnectDelayMs(account) {
    const delay = RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, account.reconnectAttempts - 1));
    return Math.min(RECONNECT_MAX_DELAY_MS, delay);
}

function scheduleReconnect(account, reason) {
    if (account.networkStopped || !account.savedCode) return;
    // 全局风控熔断：暂停期内连 timer 都不排，避免暂停结束时一次性涌出堆积的重连
    if (globalReconnectPaused(account)) return;
    account.reconnectAttempts += 1;
    // 达到次数阈值时仅发一次告警（Code 可能已失效），但不放弃：
    // 网关会持续以最大间隔重试，gameserver 恢复或用户重抓 Code 后 /start 即可重新连上，已登录的号不会因重连策略激进而被踢下线。
    if (account.reconnectAttempts === RECONNECT_ALERT_AFTER) {
        emitEvent(account, 'reconnect_failed', { attempts: account.reconnectAttempts, reason: reason || '' });
    }
    const delay = getReconnectDelayMs(account) + Math.floor(Math.random() * 3000); // jitter 避免同批账号齐重连
    // 必须先清掉上一次的待执行 timer：否则每次 close 都新建一个，多 timer 并存时
    // 即使 reconnect 判定"Code 失效已停止"，其余 timer 仍会继续重连（实测 1006 停不下来）。
    if (account.reconnectTimer) clearTimeout(account.reconnectTimer);
    account.reconnectTimer = setTimeout(() => {
        account.reconnectTimer = null;
        if (account.networkStopped) return;
        reconnect(account, null);
    }, delay);
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
    return acc ? String(acc.wxid || acc.openId || '') : '';
}

// 从 store 补全账号 platform：platform 原先只在 /start 命令路径赋值，网关重启后为空
// 会导致微信换码分支永远不触发（仍用已作废的一次性 Code 重连 → 重复登录顶下线）
function syncAccountPlatform(account) {
    if (account.platform) return;
    const acc = getStoreAccount(account.accountId);
    if (acc && acc.platform) account.platform = acc.platform;
}

// 扫描 wx-login 目录，取最近修改的 loginBuffer 文件作为兜底
// （落盘 key 是扫码时的微信 openid，可能与 userState.openId 不是同一个 ID）
function findLatestWxBufferFile() {
    try {
        if (!fs.existsSync(WX_LOGIN_DIR)) return null;
        const files = fs.readdirSync(WX_LOGIN_DIR).filter(f => f.endsWith('.json'));
        if (!files.length) return null;
        files.sort((a, b) =>
            fs.statSync(path.join(WX_LOGIN_DIR, b)).mtimeMs -
            fs.statSync(path.join(WX_LOGIN_DIR, a)).mtimeMs);
        return path.join(WX_LOGIN_DIR, files[0]);
    } catch { return null; }
}

// 微信 code 一次性：用持久化的 loginBuffer 重新 issueCode 换新 code。
// 【保活关键】loginBuffer 有效期很短（实测仅数分钟），断线重连时往往已经过期，
// 直接拿它换码会被微信拒绝（ManualAuth rejected）；此时必须凭落盘的 refreshtoken
// 续期出新的 loginBuffer 再换码 —— 这才是微信账号真正的"保活"路径。
// 早期实现只落盘 loginBuffer、注释还写着"不依赖 refreshtoken"，
// 导致 loginBuffer 一过期就彻底无法自愈，只能重新扫码（用户反馈"扫码没 5 分钟就掉线"的根因）。
async function issueWxCodeFromBuffer(account) {
    // 落盘 key = 扫码 session.openid = 账号的 wxid；openId/userState.openId 是游戏侧的另一个 ID，仅作兜底
    const openid = readStoreWxBufferKey(account.accountId) || account.userState.openId;
    let file = openid ? path.join(WX_LOGIN_DIR, `${openid}.json`) : null;
    if (!file || !fs.existsSync(file)) {
        // openid 对不上时退化为取最新文件（单微信账号场景可正常自愈；多微信账号会取到别人的，故打 warn）
        const latest = findLatestWxBufferFile();
        if (!latest) {
            logWarn('gateway', `account ${account.accountId} 微信换码跳过：loginBuffer 文件不存在 ${file || '(无 openid)'}（需重新扫码）`);
            account.wxLastCodeError = 'loginBuffer 文件不存在';
            return null;
        }
        logWarn('gateway', `account ${account.accountId} 微信 openid 未精确匹配（${openid || '空'}），改用最新 loginBuffer 文件 ${path.basename(latest)}`);
        file = latest;
    }
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        logWarn('gateway', `account ${account.accountId} 微信换码失败：loginBuffer 解析异常 ${e.message}`);
        account.wxLastCodeError = `loginBuffer 解析异常 ${e.message}`;
        return null;
    }
    if (!rec || !rec.loginBuffer) {
        logWarn('gateway', `account ${account.accountId} 微信换码失败：loginBuffer 为空`);
        account.wxLastCodeError = 'loginBuffer 为空';
        return null;
    }
    try {
        const { WxLoginService } = require('../services/wx-login/service');
        const svc = new WxLoginService();
        // 超时兜底见下方模块级 withTimeout（保活定时器与换码逻辑共用）

        // 微信换码策略：loginBuffer 实际有效期 > 2h（长效），refreshtoken 约 2h 绝对失效。
        // 网关改为低频（120min）兜底续期（而非 30min 高频轮询），故重连仍默认走快路径用
        // loginBuffer 换码；仅当连接被 1006 拒绝（buffer 确已废，close 处理器置 wxNeedsRefresh）
        // 才回退 refreshtoken 续期。与旧 worker 直连一致且更稳，且不触发腾讯风控频率特征。
        const preferRefresh = !!account.wxNeedsRefresh;
        if (!preferRefresh) {
            // 1) 快路径：loginBuffer 仍在有效期内，直接换码
            try {
                return await withTimeout(
                    svc.issueCode({ loginBuffer: rec.loginBuffer }, WX_APP_ID),
                    WX_ISSUE_TIMEOUT_MS, '换码');
            } catch (firstErr) {
                log('gateway', `account ${account.accountId} loginBuffer 直接换码失败（${String(firstErr.message).slice(0, 80)}），尝试 refreshtoken 续期`);
            }
        } else {
            log('gateway', `account ${account.accountId} loginBuffer 被 1006 拒绝过（wxNeedsRefresh），跳过快路径直接 refreshtoken 续期`);
        }

        // 2) 保活路径：loginBuffer 已过期 → 用 refreshtoken 续期后重试
        if (!rec.refreshtoken) {
            logWarn('gateway', `account ${account.accountId} loginBuffer 已失效且无 refreshtoken（旧版落盘未保存凭证），请重新扫码一次以启用自动保活`);
            account.wxLastCodeError = '无 refreshtoken（旧版落盘未保存凭证）';
            return null;
        }
        const session = {
            openid: rec.openid || openid,
            loginBuffer: rec.loginBuffer,
            refreshtoken: rec.refreshtoken,
            accesstoken: rec.accesstoken || '',
        };
        const refreshed = await withTimeout(
            svc.refreshLoginBuffer(session), WX_REFRESH_TIMEOUT_MS, '刷新 loginBuffer');
        if (!refreshed || !refreshed.loginBuffer) {
            logWarn('gateway', `account ${account.accountId} refreshtoken 续期未返回有效 loginBuffer（需重新扫码）`);
            return null;
        }

        // 滚动凭证：必须把新的 loginBuffer/refreshtoken/accesstoken 回写，
        // 否则下次仍用旧凭证，必然再次失败（refreshtoken 刷新后旧值即失效）
        persistRefreshedWxBuffer(file, rec, refreshed);
        log('gateway', `account ${account.accountId} 微信 loginBuffer 已通过 refreshtoken 续期（保活成功）`);
        return await withTimeout(
            svc.issueCode({ loginBuffer: refreshed.loginBuffer }, WX_APP_ID),
            WX_ISSUE_TIMEOUT_MS, '换码');
    } catch (e) {
        // ⭐ 同上：第1步 refresh 成功、第2步换 loginBuffer 失败时，error 上带着**已轮换**的新 token。
        // 这里不回写，磁盘就永久停留在已作废的旧 refreshtoken —— 正是"换码成功却立即 1006"与
        // "40188 永远好不了"的共同根因。
        const saved = persistRotatedCredentialsOnError(file, rec, e);
        // ⭐ 记录失败原因到 account，供调用方 classifyWxCodeError 判定临时/永久
        account.wxLastCodeError = String(e && e.message || '');
        logWarn('gateway', `account ${account.accountId} 微信换码/续期失败${saved ? '（已回写新 refreshtoken）' : ''}: ${e.message}`);
        return null;
    }
}

// 回写续期后的微信凭证（滚动凭证必须持久化，否则下次必然失败）
function persistRefreshedWxBuffer(file, oldRec, refreshed) {
    try {
        fs.writeFileSync(file, JSON.stringify({
            ...(oldRec || {}),
            loginBuffer: refreshed.loginBuffer,
            refreshtoken: refreshed.refreshtoken || (oldRec && oldRec.refreshtoken) || '',
            accesstoken: refreshed.accesstoken || (oldRec && oldRec.accesstoken) || '',
            updatedAt: Date.now(),
        }));
    } catch (e) {
        logWarn('gateway', `微信 loginBuffer 续期回写失败: ${e.message}`);
    }
}

// 模块级通用超时兜底（保活定时器与换码逻辑共用）：MMTLS 握手在服务器环境可能长时间不返回，
// 若 await 卡死会拖累整个重连/保活流程——比失败更糟，故一律加超时。
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label}超时 ${ms}ms`)), ms)),
    ]);
}

// ============ 微信凭证主动保活（移植上游 keepWxCredentialAlive）============
// 关键事实：loginBuffer 实际有效期 > 2h，但 refreshtoken 约 2h 绝对失效。
// 历史教训：重启时 refreshtoken 静置过期 → 断线后无法续期只能重扫（约 80 分钟必退的根因）。
//
// ⚠️ 2026-09-05 行为调整（回撤高频轮询，按用户 8 月无 gateway 能长期在线的实证）：
//   原来 30 分钟无条件轮询 refreshLoginBuffer → 腾讯对「同一 openid 每 30 分钟固定调用
//   应用宝授权接口」判为高危频率特征，触发了 account 2 的 [40188 invalid scope] 频发。
//   改为低频兜底（对齐 refreshtoken ~2h 失效窗口，临界期前才刷新一次）：
//   - 不再高频打授权接口 → 大幅降低被风控打标签的概率；
//   - 保留"refreshtoken 不落到过期临界"的兜底，不会因彻底停轮询而在 2h 后断线必重扫；
//   - 真正换码续期仍由【重连路径 640-714 行】按需触发，与连接生命周期绑定。
const WX_KEEPALIVE_INTERVAL_MS = 120 * 60 * 1000;
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
//   - refreshtoken 刷新本身失败 / RefreshToken empty：第 1 步就死了，凭证真的失效
//   - 凭证文件缺失、loginBuffer 为空、openid 无对应文件：本地状态问题，重试无意义
// 临时性失败（网络/腾讯侧限流，应退避后重试，不计入 scan-needed）：
//   - 40188 invalid scope：临时 scope 拒绝
//   - 换码超时 / 刷新超时（withTimeout 抛出）
//   - ECONNRESET / ETIMEDOUT / socket hang up / network 等网络类错误
//   - ManualAuth rejected：服务端拒绝但凭证未必失效，多为瞬时
const WX_TEMP_FAIL_MAX = 5;                        // 临时性失败累计上限（超过才认为可能有真问题）
const WX_TEMP_FAIL_BACKOFF_BASE_MS = 5 * 60 * 1000; // 临时失败退避基数 5 分钟
const WX_TEMP_FAIL_BACKOFF_MAX_MS = 30 * 60 * 1000; // 临时失败退避封顶 30 分钟

/**
 * 判定微信换码失败是"临时性"（可自愈）还是"永久性"（需重新扫码）。
 * @param {string} msg 错误信息
 * @returns {{temporary:boolean, reason:string}}
 */
function classifyWxCodeError(msg) {
    const s = String(msg || '');
    // —— 永久性：本机凭证文件/字段问题，重试无意义 ——
    if (/loginBuffer 文件不存在|loginBuffer 为空|loginBuffer 解析异常/i.test(s)) {
        return { temporary: false, reason: 'local_credential_missing' };
    }
    if (/无 refreshtoken|旧版落盘未保存凭证/i.test(s)) {
        return { temporary: false, reason: 'no_refreshtoken' };
    }
    // —— 永久性：refreshtoken 本身失效（第 1 步 refresh 失败）——
    if (/WeChat token refresh failed|RefreshToken empty|missing access_token/i.test(s)) {
        return { temporary: false, reason: 'refreshtoken_dead' };
    }
    // —— 临时性 ——
    if (/40188|invalid scope/i.test(s)) {
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

// ⭐ 关键：刷新 refreshtoken 是**两步**请求（service.js::refreshLoginBuffer）：
//   第1步 POST REFRESH_TOKEN_URL → 成功即轮换出新 refreshtoken（旧 token 当场作废）
//   第2步 GET  LOGIN_BUFFER      → 可能失败（如 [40188]）
// 第2步失败时，新 token 只挂在 error.refreshtoken 上。若调用方只打日志不落盘，
// 磁盘上那份旧 token 已经作废，下一次保活必然再用废 token → 40188 永久复现。
// 实测 2026-10-27：账号2 连续 8 次保活全部 40188，而凭证文件 23h 从未被写过，即此因。
// 因此任何 catch 分支都**必须**尝试回写 rotated 凭证（service.js 注释亦明确要求调用方持久化）。
function persistRotatedCredentialsOnError(file, rec, err) {
    try {
        const nextRefresh = err && err.refreshtoken;
        const nextAccess = err && err.accesstoken;
        if (!nextRefresh && !nextAccess) return false;
        // 只更新 token，保留原 loginBuffer（它仍是当前连接在用的那个）
        fs.writeFileSync(file, JSON.stringify({
            ...(rec || {}),
            ...(nextRefresh ? { refreshtoken: nextRefresh } : {}),
            ...(nextAccess ? { accesstoken: nextAccess } : {}),
            updatedAt: Date.now(),
        }));
        return true;
    } catch (e) {
        logWarn('gateway', `微信 rotated 凭证回写失败: ${e.message}`);
        return false;
    }
}

async function keepWxCredentialAlive(accountId) {
    const acc = getStoreAccount(accountId);
    if (!acc || acc.platform !== 'wx') return;
    const openid = String(acc.wxid || acc.openId || '');
    if (!openid) return;
    const file = path.join(WX_LOGIN_DIR, `${openid}.json`);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    if (!rec || !rec.loginBuffer || !rec.refreshtoken) return; // 无 refreshtoken 无法主动续期（旧版落盘未存凭证），走被动 refresh

    // ⭐ 2026-10-31 新增「按凭证年龄跳过」：
    // 旧实现是无条件每 120 分钟打一次授权接口，实测日志出现精确的 `xx:17:34` 重复，
    // 说明它完全不看凭证是否刚被刷新过——而重连路径（issueWxCodeFromBuffer）本来就会
    // 轮换 refreshtoken 并回写 updatedAt。于是保活经常在"凭证才 5 分钟新"的情况下
    // 又去刷一次，既无收益，又平白多一次被腾讯风控打标签的机会（8 月 40188 频发的成因之一）。
    // 改为：仅当凭证距上次写入已超过 WX_KEEPALIVE_MIN_AGE_MS 时才刷新。
    // 取 90 分钟（< refreshtoken 约 2h 失效窗），既留足余量，又避免与重连刷新重复做功。
    const ageMs = Number(rec.updatedAt) > 0 ? (Date.now() - Number(rec.updatedAt)) : Infinity;
    if (ageMs < WX_KEEPALIVE_MIN_AGE_MS) {
        return; // 凭证足够新，本次保活无事可做（静默跳过，不打接口）
    }

    try {
        const { WxLoginService } = require('../services/wx-login/service');
        const svc = new WxLoginService();
        const session = {
            openid: rec.openid || openid,
            loginBuffer: rec.loginBuffer,
            refreshtoken: rec.refreshtoken,
            accesstoken: rec.accesstoken || '',
        };
        const refreshed = await withTimeout(svc.refreshLoginBuffer(session), WX_REFRESH_TIMEOUT_MS, '保活刷新');
        if (refreshed && refreshed.loginBuffer) {
            persistRefreshedWxBuffer(file, rec, refreshed);
            // 主动续期成功 → 当前 loginBuffer 有效，清除 1006 失效标志，下次重连走快路径
            const live = getAccount(accountId);
            if (live) live.wxNeedsRefresh = false;
            log('gateway', `account ${accountId} 微信凭证主动保活成功（refreshtoken 已滚动续期，长效保活）`);
        } else {
            logWarn('gateway', `account ${accountId} 微信主动保活未返回有效 loginBuffer`);
        }
    } catch (e) {
        // ⭐ 必须先回写 rotated 凭证再判定失败：第1步 refresh 成功但第2步换 loginBuffer 失败时，
        // error 上带着已经轮换成功的新 refreshtoken；不落盘就等于每次保活报废一次凭证。
        const saved = persistRotatedCredentialsOnError(file, rec, e);
        // 判断失败落在哪一步，决定是否值得重试：
        //   - 'WeChat token refresh failed' / 'RefreshToken empty' → 第1步就死了，refreshtoken 真失效，需重扫
        //   - 'login buffer refresh failed' / 'Unable to obtain WeChat login buffer' → 第1步成功，
        //     凭证其实是好的，只是换 loginBuffer 被拒；下一轮很可能自愈，不该按"凭证废了"处理
        const msg = String(e && e.message || '');
        const tokenDead = /WeChat token refresh failed|RefreshToken empty|missing access_token/i.test(msg);
        if (saved && !tokenDead) {
            logWarn('gateway', `account ${accountId} 微信保活第2步失败但已回写新 refreshtoken（凭证未废，下轮重试）: ${msg.slice(0, 90)}`);
        } else if (tokenDead) {
            logWarn('gateway', `account ${accountId} 微信 refreshtoken 已失效（需重新扫码）: ${msg.slice(0, 90)}`);
        } else {
            // 滚动续期失败保持静默（可能 refreshtoken 已彻底失效），不告警避免误杀；等真正断线时再提示重扫
            logWarn('gateway', `account ${accountId} 微信主动保活失败(静默): ${msg.slice(0, 100)}`);
        }
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
                if (acc.platform === 'wx') keepWxCredentialAlive(acc.id).catch(() => {});
            }
        } catch (e) {
            logWarn('gateway', `微信主动保活定时器异常: ${String(e.message).slice(0, 100)}`);
        }
    };
    wxKeepaliveTimer = setInterval(tick, WX_KEEPALIVE_INTERVAL_MS);
    tick(); // 启动立即跑一次，尽快锁定长效凭证（不等满 120 分钟；此后低频若 refreshtoken 未被腾讯回收则自然持续）
}

async function reconnect(account, newCode) {
    if (account.networkStopped) return false;
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
    if (account.platform === 'wx') {
        try {
            const fresh = await issueWxCodeFromBuffer(account);
            if (fresh) {
                code = fresh;
                account.savedCode = fresh;
                // 换码成功即视为 Code 有效，清零失效计数，避免被 CODE_INVALID_MAX 误拦（否则微信号会卡在停止态无法自愈）
                account.codeInvalidCount = 0;
                account.wxCodeFailCount = 0;
                account.wxBufferAlerted = false;
                account.wxNeedsRefresh = false; // 重连成功说明当前 loginBuffer 有效，清除 1006 失效标志
                account.networkStopped = false; // 恢复正常：允许后续断链重连，不再因本次失效被永久阻止
                log('gateway', `account ${account.accountId} 微信已从 loginBuffer 换新 Code 重连`);
            } else {
                // 换码失败：issueWxCodeFromBuffer 内部已尝试"refreshtoken 续期"保活。
                // ⭐ 2026-10-31 改造：不再一律按"凭证已失效"处理，先分类——
                //   临时性（40188 / 超时 / 网络）：网络恢复后同一份凭证往往能直接换成功，
                //     退避 5~30 分钟再试，**不计入 networkStopped**，避免几次抖动就把号打成必须扫码；
                //   永久性（refreshtoken 真死 / 本地凭证缺失）：立即停止，等人工扫码。
                // 关键：失败绝不再用旧 code 建连（否则必然 1006 → 反复死循环风暴，且 connect 帧每次
                // 重置 deadReconnectCount 绕过 DEAD_RECONNECT_MAX 总闸，拖累同网关其它账号）。直接返回，不建连。
                const cls = classifyWxCodeError(account.wxLastCodeError);
                if (cls.temporary) {
                    account.wxTempFailCount = (account.wxTempFailCount || 0) + 1;
                    // 临时失败不算凭证失效：清掉永久失败计数，避免历史累积把号误判成需要扫码
                    account.wxCodeFailCount = 0;
                    // 指数退避：5min → 10min → 20min → 封顶 30min
                    const backoffMs = Math.min(
                        WX_TEMP_FAIL_BACKOFF_MAX_MS,
                        WX_TEMP_FAIL_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, account.wxTempFailCount - 1))
                    );
                    // 只有连续临时失败超过上限，才认为"可能真有问题"，此时才允许进入停止态
                    if (account.wxTempFailCount >= WX_TEMP_FAIL_MAX) {
                        if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                        account.networkStopped = true;
                        if (!account.wxBufferAlerted) {
                            account.wxBufferAlerted = true;
                            logWarn('gateway', `account ${account.accountId} 微信换码连续临时失败 ${account.wxTempFailCount} 次（原因=${cls.reason}），已停止自动重连，请重新扫码`);
                            emitEvent(account, 'code_invalid', { reason: 'wx_temp_fail_exhausted', needRescan: true, attempts: account.wxTempFailCount, detail: cls.reason });
                        }
                        return false;
                    }
                    logWarn('gateway', `account ${account.accountId} 微信换码临时失败（${cls.reason}，第 ${account.wxTempFailCount}/${WX_TEMP_FAIL_MAX} 次），退避 ${Math.round(backoffMs / 60000)} 分钟后重试（凭证未判定失效）`);
                    // 主动排一次退避重连，而不是干等外层调度
                    if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                    account.reconnectTimer = setTimeout(() => {
                        account.reconnectTimer = null;
                        if (account.networkStopped) return;
                        reconnect(account).catch(() => {});
                    }, backoffMs);
                    if (account.reconnectTimer.unref) account.reconnectTimer.unref();
                    return false; // 本轮不建连
                }
                // —— 永久性失败：凭证确实废了 ——
                account.wxCodeFailCount = (account.wxCodeFailCount || 0) + 1;
                if (account.wxCodeFailCount >= 3) {
                    if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                    account.networkStopped = true; // 彻底停止自动重连，等用户重新扫码
                    if (!account.wxBufferAlerted) {
                        account.wxBufferAlerted = true;
                        logWarn('gateway', `account ${account.accountId} 微信 loginBuffer 换码连续失败 ${account.wxCodeFailCount} 次（原因=${cls.reason}，登录态已失效），已停止自动重连，请重新扫码获取 loginBuffer`);
                        emitEvent(account, 'code_invalid', { reason: 'wx_buffer_expired', needRescan: true, attempts: account.wxCodeFailCount, detail: cls.reason });
                    }
                } else {
                    logWarn('gateway', `account ${account.accountId} 微信换码失败第 ${account.wxCodeFailCount} 次（${cls.reason}，登录态已失效），将在下次重连重试`);
                }
                return false; // 不建连，避免 1006 风暴
            }
        } catch (e) {
            // ⭐ 2026-10-31：原先这里只要抛异常就 networkStopped=true ——
            // 而 withTimeout 的"换码超时 20000ms / 刷新超时 30000ms"也会走到这，
            // 等于**网络卡一下就永久停号**，这是比 40188 更致命的缺陷。
            // 改为同样按分类处理：临时异常退避重试，只有永久性才停。
            const cls = classifyWxCodeError(e && e.message);
            if (cls.temporary) {
                account.wxTempFailCount = (account.wxTempFailCount || 0) + 1;
                const backoffMs = Math.min(
                    WX_TEMP_FAIL_BACKOFF_MAX_MS,
                    WX_TEMP_FAIL_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, account.wxTempFailCount - 1))
                );
                if (account.wxTempFailCount >= WX_TEMP_FAIL_MAX) {
                    logWarn('gateway', `account ${account.accountId} 微信换码异常连续 ${account.wxTempFailCount} 次（${cls.reason}），停止重连: ${e.message}`);
                    account.networkStopped = true;
                    if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                } else {
                    logWarn('gateway', `account ${account.accountId} 微信换码异常（${cls.reason}，第 ${account.wxTempFailCount}/${WX_TEMP_FAIL_MAX} 次），退避 ${Math.round(backoffMs / 60000)} 分钟后重试: ${e.message}`);
                    if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                    account.reconnectTimer = setTimeout(() => {
                        account.reconnectTimer = null;
                        if (account.networkStopped) return;
                        reconnect(account).catch(() => {});
                    }, backoffMs);
                    if (account.reconnectTimer.unref) account.reconnectTimer.unref();
                }
                return false;
            }
            logWarn('gateway', `account ${account.accountId} 微信换码异常（永久性 ${cls.reason}），停止重连: ${e.message}`);
            account.networkStopped = true;
            if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
            return false;
        }
    }
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
    account.networkStopped = true;
    stopSecurityRuntime(account, reason);
    rejectAllPending(account, '网络已停止');
    closeCurrentWs(account, { terminate: true });
    account.userState.gid = 0;
}

// ============ worker 事件回传 ============
function emitEvent(account, name, payload) {
    if (account.workerSock) {
        sendFrame(account.workerSock, { t: 'event', accountId: account.accountId, name, payload });
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
function sendFrame(sock, obj) {
    if (!sock || sock.destroyed) return;
    sock.write(JSON.stringify(obj) + '\n');
}

function startIpcServer() {
    try { fs.unlinkSync(SOCK_PATH); } catch { }
    const server = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.trim()) {
                    try { handleWorkerFrame(sock, JSON.parse(line)); } catch { }
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

async function handleWorkerFrame(sock, frame) {
    if (!frame) return;
    if (frame.t === 'ping') { sendFrame(sock, { t: 'pong' }); return; }
    const accountId = String(frame.accountId || '');
    if (!accountId) return;
    let account = getAccount(accountId);
    if (!account) { account = createConn(accountId); accounts.set(accountId, account); }
    account.workerSock = sock;
    // 从 store 读取账号真实 platform（微信账号为 wx，QQ 为 qq），用于建连 URL 参数
    try {
        const store = getStoreModule();
        const list = (store.getAccounts() || {}).accounts || [];
        const acc = list.find(a => String(a.id) === accountId);
        if (acc && acc.platform) account.platform = String(acc.platform);
    } catch (e) { /* 读不到时保持默认 */ }

    switch (frame.t) {
        case 'connect': {
            // 活连接：网关已持有 gameserver WebSocket 且已登录
            const liveWs = !!(account.ws && account.ws.readyState === account.ws.OPEN && account.userState && account.userState.gid);
            const incomingCode = frame.code;
            // 重抓/重启可能发生在上一次重连风暴期间：先清掉已排队的旧 timer，
            // 否则它稍后会用废 Code 冲服务器，把刚重抓好的新连接顶掉（"抓了好几次仍被顶"的根因）
            if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
            // 收到 connect 即视为一次新的登录尝试，清除"Code 已失效"告警标记与重连计数，允许重新判定
            account.codeInvalidAlerted = false;
            account.reconnectAttempts = 0;
            account.requestTimeoutStreak = 0;
            // 注意：此处**不再**无条件清零 deadReconnectCount / shortSessionCount。
            // worker 每次重启都会发 connect 帧，无条件清零等于"重启即绕过风控熔断"
            // （2026-09-09 微信每 14 秒一次 1006 循环就是这么来的）。
            // 只有用户带来**全新 Code**（真人工重抓/扫码）才重置，见下方 codeChanged 分支。
            // 用户显式带了新 Code（重抓后 /start）：与已存 savedCode 不同即视为换号/换登录态
            const codeChanged = !!(incomingCode && String(incomingCode) !== String(account.savedCode || ''));
            if (liveWs && !codeChanged) {
                // worker 重启/重连场景：网关 WebSocket 仍存活，直接复用，不重新登录（不消耗新 Code）
                log('gateway', `account ${accountId} 复用已有网关连接（worker 重启免 Code）`);
                sendFrame(sock, { t: 'login', accountId, userState: account.userState });
            } else {
                // 无活连接，或用户提供了新 Code：关旧建新，用新 Code（或已存 savedCode）重建
                let code = codeChanged ? incomingCode : account.savedCode;
                // 微信：code 必须以网关持有的 wx-login 文件为准，绝不能用主容器带来的过期 code 直接建连，
                // 否则反复 1006 死循环且 refreshtoken 续期路径永远走不到（微信掉线无法自愈的根因）。
                // 始终由网关从 loginBuffer 派生（过期则 refreshtoken 续期），与主容器带来的 code 无关。
                if (account.platform === 'wx') {
                    try {
                        const fresh = await issueWxCodeFromBuffer(account);
                        if (fresh) {
                            code = fresh;
                            account.savedCode = fresh;
                            account.codeInvalidCount = 0;
                            account.wxCodeFailCount = 0;
                            account.wxBufferAlerted = false;
                            account.wxNeedsRefresh = false;
                            account.networkStopped = false; // 换新 Code 成功：恢复自动重连能力
                        } else {
                            // 换码失败（loginBuffer/refreshtoken 均失效）：绝不用旧 code 建连，
                            // 否则必然 1006 死循环，且 connect 帧每次会重置 deadReconnectCount 绕过总闸 → 风暴。
                            // 直接返回，累计失败计数达上限后彻底停止；用户重新扫码落盘新文件后下次 connect 帧即可自愈。
                            logWarn('gateway', `account ${accountId} 微信换码/续期失败，仍需重新扫码`);
                            account.wxCodeFailCount = (account.wxCodeFailCount || 0) + 1;
                            if (account.wxCodeFailCount >= 3) {
                                account.networkStopped = true;
                                if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                                if (!account.wxBufferAlerted) {
                                    account.wxBufferAlerted = true;
                                    emitEvent(account, 'code_invalid', { reason: 'wx_buffer_expired', needRescan: true, attempts: account.wxCodeFailCount });
                                }
                            }
                            return; // 不走到 connect(account, code)，避免 1006 风暴
                        }
                    } catch (e) {
                        logWarn('gateway', `account ${accountId} 微信换码/续期异常: ${e.message}`);
                        return;
                    }
                }
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
                }
                connect(account, code);
            }
            break;
        }
        case 'request': {
            const body = Buffer.from(frame.body || '', 'base64');
            const cb = {
                workerSeq: frame.seq,
                workerSock: sock,
                timer: setTimeout(() => {
                    // 假死兜底：请求发到死连接永不回包，超时快速失败，避免 worker 侧永久挂起
                    account.pendingCallbacks.forEach((v, k) => { if (v === cb) account.pendingCallbacks.delete(k); });
                    sendFrame(sock, { t: 'response', accountId, seq: frame.seq, error: '网关请求超时（连接可能假死）', body: '', meta: {} });

                    // 业务级假死判死：连续 N 次业务请求全部超时 → 该连接已无法干活，主动断开重连。
                    // 不会比现状更差（现状是永久假死、前端永远取不到数据）；微信自动换码自愈，
                    // QQ 用保存的 savedCode 复用重连（已验证 code 可复用）；若 code 真过期，
                    // 连续判死重连仍不通时由分平台上限（getDeadReconnectMax：微信3/QQ10）兜底停止并发告警，提醒用户重抓。
                    account.requestTimeoutStreak = (account.requestTimeoutStreak || 0) + 1;

                    // ===== 亚健康退避信号（防判死在源头） =====
                    // 未到判死阈值(DEAD_REQUEST_TIMEOUT_STREAK=5)前，若已连续 HEALTH_DEGRADED_STREAK 次超时
                    // （约 2×30s），说明服务端开始变慢/静默。立即通知 worker 暂停业务请求、给心跳让路自愈，
                    // 避免 pending 队列被固定频率的农场/好友任务打满、连心跳都排不上而最终判死掉线。
                    // 注意：这里不清零 requestTimeoutStreak——若连接真死，会继续累加走到下方判死重连；若只是
                    // 短暂变慢，worker 退避后心跳/业务恢复，收到回包会清空 requestTimeoutStreak(见 handleMessage)。
                    if (account.requestTimeoutStreak === HEALTH_DEGRADED_STREAK && !account.healthBackoffChanging) {
                        account.healthBackoffChanging = true;
                        const backoffMs = Math.min(
                            HEALTH_BACKOFF_BASE_MS * Math.pow(2, account.degradedStreak),
                            HEALTH_BACKOFF_MAX_MS
                        );
                        account.degradedStreak += 1;
                        logWarn('gateway', `account ${account.accountId} 业务请求连续超时 ${HEALTH_DEGRADED_STREAK} 次，判定亚健康，通知 worker 退避 ${Math.round(backoffMs / 1000)}s 给心跳让路（第 ${account.degradedStreak} 次健康退避）`);
                        emitEvent(account, 'connection_degraded', { backoffMs, degradedStreak: account.degradedStreak });
                        // 退避窗口结束后解除节流，允许下次亚健康再次发出信号
                        setTimeout(() => { try { account.healthBackoffChanging = false; } catch (_e) { } }, backoffMs);
                    }

                    if (account.requestTimeoutStreak >= DEAD_REQUEST_TIMEOUT_STREAK) {
                        account.requestTimeoutStreak = 0; // 清零节流，避免每个超时请求都触发一次重连
                        // 连续判死重连计数：重连成功且有业务回包时清零（见 handleMessage / onAccountLogin）；
                        // 若重连后仍不通，计数持续累加，达上限即停止 —— 防止无限重连风暴拖垮网关。
                        account.deadReconnectCount = (account.deadReconnectCount || 0) + 1;
                        logWarn('gateway', `account ${account.accountId} 业务请求连续超时 ${DEAD_REQUEST_TIMEOUT_STREAK} 次（约 ${Math.round(DEAD_REQUEST_TIMEOUT_STREAK * WORKER_REQUEST_TIMEOUT_MS / 1000)}s），判定连接假死，主动断开重连（第 ${account.deadReconnectCount} 次）`);
                        emitEvent(account, 'connection_dead', { timeoutStreak: DEAD_REQUEST_TIMEOUT_STREAK, deadReconnectCount: account.deadReconnectCount });

                        // 分平台判死重连上限：微信 3（loginBuffer 自愈强），QQ 10（code 可复用，给足自动续命机会，
                        // 仍由 QQ_CODE_INVALID_MAX=20 兜底防风暴）。连续多次判死重连后业务仍不通：
                        // 凭证（Code/loginBuffer）多半已失效，再重试只会形成风暴并拖垮同一网关下的其它账号——
                        // 停止并告警，等人工处理。
                        const drMax = getDeadReconnectMax(account);
                        if (account.deadReconnectCount > drMax) {
                            // 连续多次判死重连后业务仍不通：凭证（Code/loginBuffer）多半已失效，
                            // 再重试只会形成风暴并拖垮同一网关下的其它账号 —— 停止并告警，等人工处理。
                            if (!account.deadReconnectAlerted) {
                                account.deadReconnectAlerted = true;
                                logWarn('gateway', `account ${account.accountId}${account.platform === 'wx' ? '' : '(QQ)'} 连续 ${account.deadReconnectCount} 次假死重连后仍无法恢复（凭证可能已失效，上限 ${drMax}），停止自动重连，请重新抓包或扫码`);
                                emitEvent(account, 'dead_reconnect_exhausted', { deadReconnectCount: account.deadReconnectCount, needed: drMax });
                            }
                            // 清掉已排队的重连 timer，否则它稍后还会再拉起一次重连
                            if (account.reconnectTimer) { clearTimeout(account.reconnectTimer); account.reconnectTimer = null; }
                            // 关掉死连接，避免面板显示"在线"却取不到数据（假在线）误导排查
                            if (account.ws) { try { account.ws.close(); } catch (_e) { /* ignore */ } }
                            return;
                        }

                        // 第 1 次立即重连（网络抖动场景快速自愈）；之后递增退避，避免密集冲击 gameserver
                        // 【2026-09-05 QQ 降频】改用分平台退避：QQ 首次也避且节奏慢（见 getDeadReconnectBackoffMs），
                        // 微信保持原"第 1 次立即 + 60s 递增"，避免 QQ 高频重建 WS 加速 code 失效。
                        const backoffMs = getDeadReconnectBackoffMs(account, account.deadReconnectCount || 1);
                        if (backoffMs > 0) {
                            log('gateway', `account ${account.accountId} 假死重连退避 ${Math.round(backoffMs / 1000)}s 后重试`);
                            setTimeout(() => {
                                if (account.networkStopped) return;
                                reconnect(account, null).catch(() => { });
                            }, backoffMs);
                        } else {
                            reconnect(account, null).catch(() => { });
                        }
                    }
                }, WORKER_REQUEST_TIMEOUT_MS),
            };
            try {
                const seq = await sendMsg(account, frame.service, frame.method, body, cb);
                if (seq < 0) {
                    try { clearTimeout(cb.timer); } catch { }
                    sendFrame(sock, { t: 'response', accountId, seq: frame.seq, error: 'WebSocket 未连接', body: '', meta: {} });
                }
            } catch (e) {
                try { clearTimeout(cb.timer); } catch { }
                sendFrame(sock, { t: 'response', accountId, seq: frame.seq, error: e.message, body: '', meta: {} });
            }
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
        startIpcServer();
        startWxKeepalive(); // 微信凭证低频（120min）兜底续期：仅在 refreshtoken 过期临界前刷新一次，避免高频调授权接口触发腾讯风控（回撤 30min 高频轮询）
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
    process.on('SIGTERM', () => { accounts.forEach((a) => stopNetwork(a)); process.exit(0); });
    process.on('SIGINT', () => { accounts.forEach((a) => stopNetwork(a)); process.exit(0); });
}

module.exports = { startIpcServer, connect };
