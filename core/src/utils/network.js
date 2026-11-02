const { Buffer } = require('node:buffer');
const EventEmitter = require('node:events');
/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 */

const process = require('node:process');
const WebSocket = require('ws');
const { CONFIG, applyServerVersion } = require('../config/config');
const { AceService } = require('../services/ace-service');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { createGatewayToken } = require('./gateway-token');
const { TsdkRuntime } = require('./tsdk-runtime');
const { createRequestGate, getRequestPriority, runWithRequestPriority } = require('./request-priority');

// 延迟加载 warehouse 模块避免循环依赖
let warehouseModule = null;
function getWarehouseModule() {
    if (!warehouseModule) {
        warehouseModule = require('../services/warehouse');
    }
    return warehouseModule;
}

// 延迟加载 store 模块避免循环依赖
let storeModule = null;
function getStoreModule() {
    if (!storeModule) {
        storeModule = require('../models/store');
    }
    return storeModule;
}

// ============ 事件发射器 (用于推送通知) ============
// 注：gateway 模式下本引用会被重定向到 gateway-client 的 emitter（见文件末尾导出分支）
let networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws = null;
let clientSeq = 1;
let serverSeq = 0;
const pendingCallbacks = new Map();
const pendingStartedAt = new Map();
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');
// 请求优先级闸门（移植自上游）：按优先级排序、限制并发，避免业务请求洪峰挤占关键请求
const requestGate = createRequestGate({ maxActive: 8, maxQueued: 100 });
let tsdkRuntime = null;
let aceService = null;
let initialGamePackInfo = '';

function logAce(level, message) {
    if (level === 'warn' || level === 'error') logWarn('ACE', message);
    else log('ACE', message);
}

/**
 * 解析设备指纹：启用自定义设备协议时校验一致性并归一化。
 * - Android UA 不得与 Apple/iOS 品牌混用（矛盾）
 * - 启用自定义设备必须同时给出品牌、型号与稳定设备 ID（不完整）
 */
function resolveDeviceFingerprint(deviceProtocol) {
    const custom = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    if (!custom) return { os: CONFIG.os, sysSoftware: CONFIG.os, userAgent: '' };

    const userAgent = String(custom.userAgent || '').trim();
    const isAndroid = /android/i.test(userAgent);
    const isApple = /iphone|ipad|ios/i.test(userAgent)
        || /apple/i.test(String(custom.deviceBrand || ''));
    if (isAndroid && isApple) {
        throw new Error('设备协议矛盾：Android UA 不能与 Apple/iOS 设备信息混用');
    }

    const deviceBrand = String(custom.deviceBrand || '').trim();
    const deviceModel = String(custom.deviceModel || '').trim();
    const deviceId = String(custom.deviceId || custom.deviceMac || custom.imei || '').trim();
    if (!deviceBrand || !deviceModel || !deviceId) {
        throw new Error('设备协议不完整：启用自定义设备时必须设置品牌、型号和稳定设备ID');
    }

    const osName = isAndroid ? 'Android' : 'iOS';
    return { os: osName, sysSoftware: osName, deviceBrand, deviceModel, deviceId, userAgent };
}

/**
 * 构建 TSDK/ACE 身份。默认登录指纹（Windows/iOS 等合成值）不得注入 TSDK，
 * 否则会为每个加密请求改变 ACE 身份；仅在启用自定义设备协议时透传。
 */
function buildTsdkDeviceInfo(deviceProtocol) {
    const custom = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    if (!custom) return { platform: CONFIG.os };

    const device = resolveDeviceFingerprint(custom);
    return {
        deviceModel: device.deviceModel,
        deviceBrand: device.deviceBrand,
        deviceId: device.deviceId,
        deviceMac: String(custom.deviceMac || '').trim(),
        imei: String(custom.imei || '').trim(),
        platform: device.os,
        system: device.sysSoftware,
    };
}

function createTsdkRuntime(deviceProtocol) {
    return new TsdkRuntime({
        accountId: process.env.FARM_ACCOUNT_ID,
        gameId: CONFIG.tsdkGameId,
        appKey: CONFIG.tsdkAppKey,
        deviceInfo: buildTsdkDeviceInfo(deviceProtocol),
        logger: logAce,
    });
}

async function startSecurityRuntime(deviceProtocol) {
    stopSecurityRuntime('重新初始化');
    if (!CONFIG.tsdkAceEnabled) {
        throw new Error('TSDK/ACE 已通过 FARM_TSDK_ACE_ENABLED=false 关闭，网关请求不会使用伪造 Token');
    }
    tsdkRuntime = createTsdkRuntime(deviceProtocol);
    initialGamePackInfo = '';
    cryptoWasm.setRuntime(tsdkRuntime);
    await tsdkRuntime.init();
}

function startAceService() {
    if (!tsdkRuntime || !tsdkRuntime.ready) throw new Error('TSDK 尚未就绪');
    if (aceService) aceService.stop('重新启动');
    aceService = new AceService({
        runtime: tsdkRuntime,
        sendRequest: sendMsgAsync,
        isConnected,
        types,
        logger: logAce,
    });
    aceService.start();
}

function stopSecurityRuntime(reason = '停止') {
    if (aceService) {
        aceService.stop(reason);
        aceService = null;
    }
    if (tsdkRuntime) {
        tsdkRuntime.destroy();
        tsdkRuntime = null;
    }
    initialGamePackInfo = '';
    cryptoWasm.setRuntime(null);
}

function rejectAllPendingRequests(reason = '请求被中断') {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    pendingStartedAt.clear();
    for (const [, callback] of entries) {
        try {
            callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0, // 点券(ID:1002)
    goldBean: 0, // 金豆豆(ID:1005)
    openId: '',
    avatar: '',
};

function getUserState() { return userState; }
/**
 * ⭐ 主动写入经验/等级（供 exp-refresh 使用）。
 * 背景：面板的 status.exp 取自 userState.exp，而 exp 原本只在登录回包/ItemNotify 时被动更新，
 * 导致「经验长期冻结在登录那一刻」。exp-refresh 通过 CareerInfoGet 主动查到真实经验后，
 * 必须走这个入口写回 userState 并同步 level，面板才会真正变化
 * （只更新 stats 模块内部是看不到的 —— 实测 logs 显示已同步但面板不变，即此原因）。
 * @param {{exp?:number, level?:number}} patch
 * @returns {boolean} 是否实际发生更新
 */
function applyUserExpPatch(patch) {
    const p = patch || {};
    const nextExp = Number(p.exp);
    const nextLevel = Number(p.level);
    let changed = false;
    if (Number.isFinite(nextExp) && nextExp > 0 && nextExp !== Number(userState.exp)) {
        userState.exp = nextExp;
        changed = true;
    }
    if (Number.isFinite(nextLevel) && nextLevel > 0 && nextLevel !== Number(userState.level)) {
        userState.level = nextLevel;
        changed = true;
    }
    if (changed) {
        try { updateStatusLevel(userState.level, userState.exp); } catch { /* status 未就绪时忽略 */ }
    }
    return changed;
}
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code, message) {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState() {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function logLoginSummary(loginTimeMs) {
    const lines = [
        `GID: ${userState.gid}`,
        `昵称: ${userState.name}`,
        `等级: ${userState.level}`,
        `金币: ${userState.gold}`,
    ];
    if (loginTimeMs) {
        lines.push(`时间: ${new Date(loginTimeMs).toLocaleString()}`);
    }
    log('系统', `登录摘要\n${lines.join('\n')}`);
}

// 登录后从背包获取金豆豆数量
async function fetchGoldBeanFromBag() {
    try {
        const warehouse = getWarehouseModule();
        const bagReply = await warehouse.getBag();
        const items = warehouse.getBagItems(bagReply);
        for (const item of (items || [])) {
            const id = toNum(item && item.id);
            const count = toNum(item && item.count);
            if (id === 1005 && count > 0) {
                userState.goldBean = count;
                log('系统', `金豆豆数量: ${count}`);
                break;
            }
        }
    // eslint-disable-next-line unused-imports/no-unused-vars
    } catch (e) {
        // 忽略获取失败
    }
}

function hasOwn(obj, key) {
    return !!obj && Object.hasOwn(obj, key);
}

// ============ 消息编解码 ============
// async function encodeMsg(serviceName, methodName, bodyBytes) {
async function encodeMsg(serviceName, methodName, bodyBytes, clientSeqValue) {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    const gatewayToken = initialGamePackInfo || createGatewayToken();
    initialGamePackInfo = '';
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            // client_seq: toLong(clientSeq),
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
        auth_token: gatewayToken,
    });
    // clientSeq++;
    return types.GateMessage.encode(msg).finish();
}

async function sendMsg(serviceName, methodName, bodyBytes, callback) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
    if (callback) pendingCallbacks.set(seq, callback);
    // ws.send(encoded);
    try {
        ws.send(encoded);
    } catch (err) {
        if (callback) {
            pendingCallbacks.delete(seq);
            pendingStartedAt.delete(seq);
            callback(err);
        }
        return false;
    }
    return true;
}

/** Promise 版发送 */
async function sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 20000) {
    // 优先级闸门：按优先级排队、限制并发（替换原先"队列满即拒绝"的粗暴策略）。
    // 优先级经 runWithRequestPriority() 在异步上下文中传递，故本函数签名保持不变。
    const release = await requestGate.acquire(getRequestPriority());
    try {
        return await new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error(`连接未打开: ${methodName}`));
                return;
            }

            if (pendingCallbacks.size >= 100) {
                reject(new Error(`请求队列已满: ${methodName} (pending=${pendingCallbacks.size})`));
                return;
            }

            const seq = clientSeq;
            const timeoutKey = `request_timeout_${seq}`;
            let settled = false;

            networkScheduler.setTimeoutTask(timeoutKey, timeout, () => {
                if (settled) return;
                settled = true;
                pendingCallbacks.delete(seq);
                pendingStartedAt.delete(seq);
                const pending = pendingCallbacks.size;
                reject(new Error(`请求超时: ${methodName} (seq=${seq}, pending=${pending})`));
            });

            pendingStartedAt.set(seq, Date.now());

            sendMsg(serviceName, methodName, bodyBytes, (err, body, meta) => {
                networkScheduler.clear(timeoutKey);
                pendingStartedAt.delete(seq);
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve({ body, meta });
            }).then((sent) => {
                if (sent || settled) return;
                networkScheduler.clear(timeoutKey);
                pendingStartedAt.delete(seq);
                settled = true;
                reject(new Error(`发送失败: ${methodName}`));
            }).catch((error) => {
                if (settled) return;
                networkScheduler.clear(timeoutKey);
                pendingCallbacks.delete(seq);
                pendingStartedAt.delete(seq);
                settled = true;
                reject(error);
            });
        });
    } finally {
        release();
    }
}

// ============ 消息处理 ============
function handleMessage(data) {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const cb = pendingCallbacks.get(clientSeqVal);
            if (cb) {
                pendingCallbacks.delete(clientSeqVal);
                pendingStartedAt.delete(clientSeqVal);
                if (errorCode !== 0) {
                    cb(new Error(`${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ''}`));
                } else {
                    cb(null, msg.body, meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch { }
            return;
        }

        // 土地状态变化 (被放虫/放草/偷菜等)
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    // 如果是自己的农场，触发事件
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch { }
            return;
        }

        // 物品变化通知 (经验/金币等)
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);
                    
                    // 仅使用 ID=1101 作为经验值标准
                    if (id === 1101) {
                        // 优先使用总量；若仅有 delta 也可累加
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        // 这里调用 updateStatusLevel 会触发 status.js -> worker.js -> stats.js 的更新流程
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        // 金币通知有时只有 delta 没有总量，避免把未提供总量误当 0 覆盖
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        // 点券
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        // 金豆豆
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch { }
            return;
        }

        // 基本信息变化 (升级等)
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch { }
            return;
        }

        // 好友申请通知 (微信同玩)
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch { }
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                    // 新增好友必须写入 knownFriendGids，否则好友列表接口（按已知 GID 拉取）
                    // 永远不会返回它，前端也就看不到新好友。
                    networkEvents.emit('friendAdded', friends);
                }
            } catch { }
            return;
        }

        // 商品解锁通知 (升级后解锁新种子等)
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch { }
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch { }
            
        }

        // 其他未处理的推送类型 (调试用)
        // log('推送', `未处理类型: ${type}`);
    } catch (e) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
function buildLoginDeviceInfo(deviceProtocol) {
    const customDevice = deviceProtocol && deviceProtocol.enabled ? deviceProtocol : null;
    if (!customDevice) {
        return {
            client_version: CONFIG.clientVersion,
            sys_software: 'Windows',
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

function buildLoginBody(deviceProtocol) {
    return Buffer.from(types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: buildLoginDeviceInfo(deviceProtocol),
        share_cfg_id: toLong(0),
        scene_id: '1234567',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other-qq', minigame_platid: 2, req_id: '', trackid: '',
        },
        extra: Buffer.alloc(0),
    })).finish());
}

async function sendLogin(onLoginSuccess, deviceProtocol) {
    const body = buildLoginBody(deviceProtocol);

    await sendMsg('gamepb.userpb.UserService', 'Login', body, (err, bodyBytes, _meta) => {
        if (err) {
            log('登录', `失败: ${err.message}`);
            // 如果是验证失败，直接退出进程
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }
        try {
            const reply = types.LoginReply.decode(bodyBytes);
            if (reply.basic) {
                clearWsErrorState();
                userState.gid = toNum(reply.basic.gid);
                userState.name = reply.basic.name || '未知';
                userState.level = toNum(reply.basic.level);
                userState.gold = toNum(reply.basic.gold);
                userState.exp = toNum(reply.basic.exp);
                userState.openId = String(reply.basic.open_id || '').trim();
                userState.avatar = String(reply.basic.avatar_url || '').trim();
                if (tsdkRuntime && userState.openId) {
                    tsdkRuntime.bindUser(userState.openId);
                    initialGamePackInfo = tsdkRuntime.getEncryptedInitInfo();
                    logAce('info', `ACE 用户身份已绑定：初始化凭据长度 ${initialGamePackInfo.length}`);
                }

                // 更新状态栏
                updateStatusFromLogin({
                    gid: userState.gid,
                    name: userState.name,
                    level: userState.level,
                    gold: userState.gold,
                    exp: userState.exp,
                    openId: userState.openId,
                    avatar: userState.avatar,
                });

                log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

                let loginTimeMs = 0;
                if (reply.time_now_millis) {
                    const loginTime = toNum(reply.time_now_millis);
                    loginTimeMs = loginTime > 1e12 ? loginTime : loginTime * 1000;
                    syncServerTime(loginTimeMs);
                }
                logLoginSummary(loginTimeMs);

                // 登录后主动获取背包中的金豆豆数量
                fetchGoldBeanFromBag();

                // P0: 客户端版本自动校准 —— 服务器可能在登录回复 version_info 下发推荐/强制版本，
                // 差异化升级到服务器侧接受的新版本，避免因版本过期被服务器判定非法而掉连。
                try {
                    const vinfo = reply.version_info;
                    if (vinfo && (vinfo.version_force || vinfo.version_recommend)) {
                        const applied = applyServerVersion({
                            version_force: vinfo.version_force,
                            version_recommend: vinfo.version_recommend,
                        });
                        if (applied.changed) {
                            log('系统', applied.force
                                ? `服务器强制要求客户端版本 ${applied.target}，已自动对齐生效`
                                : `服务器推荐客户端版本，已静默升级至 ${applied.target}`);
                        } else if (applied.force) {
                            logWarn('系统', `服务器强制版本 ${applied.target} 与当前一致或受基线保护，保持当前版本`);
                        }
                    }
                } catch (e) {
                    // 版本校准失败不影响登录，仅记录
                    logWarn('系统', `版本校准异常: ${e.message}`);
                }

            }

            startHeartbeat();
            startAceService();
            if (onLoginSuccess) onLoginSuccess();
        } catch (e) {
            log('登录', `解码失败: ${e.message}`);
        }
    });
}

// ============ 心跳 ============
let lastHeartbeatResponse = Date.now();
let heartbeatMissCount = 0;
const HEARTBEAT_TIMEOUT = 30000;
const MAX_HEARTBEAT_MISS = 3;

function startHeartbeat() {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = Date.now();
    heartbeatMissCount = 0;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!userState.gid) return;

        const timeSinceLastResponse = Date.now() - lastHeartbeatResponse;
        if (timeSinceLastResponse > HEARTBEAT_TIMEOUT) {
            heartbeatMissCount++;
            logWarn('心跳', `连接可能已断开 (${Math.round(timeSinceLastResponse/1000)}s 无响应, miss=${heartbeatMissCount}/${MAX_HEARTBEAT_MISS}, pending=${pendingCallbacks.size})`);
            if (heartbeatMissCount >= MAX_HEARTBEAT_MISS) {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    log('心跳', '连接已关闭，立即重连...');
                } else {
                    log('心跳', '心跳超时，关闭连接并重连...');
                    try { ws.close(); } catch { }
                }
                networkEvents.emit('disconnect', { code: 'heartbeat_timeout' });
                rejectAllPendingRequests('连接超时，已清理');
                reconnect(null);
                return;
            }
        }

        const body = buildHeartbeatBody(userState.gid);
        // 心跳是保活关键请求，用 critical 优先级，确保在 requestGate 里永远排在
        // 前端读请求（foreground=1）之前，不会被"快速切换页面"产生的批量读请求饿死。
        runWithRequestPriority('critical', () =>
            sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body)
        ).then(({ body: replyBody }) => {
            lastHeartbeatResponse = Date.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) {
                    const serverTime = toNum(reply.server_time);
                    const serverTimeMs = serverTime > 1e12 ? serverTime : serverTime * 1000;
                    syncServerTime(serverTimeMs);
                }
            } catch { }
        }).catch(() => { });
    });
}

function buildHeartbeatBody(gid) {
    return Buffer.from(types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
        gid: toLong(gid),
        client_version: CONFIG.clientVersion,
        field_3: toLong(0),
    })).finish());
}

// ============ WebSocket 连接 ============
let savedLoginCallback = null;
let savedCode = null;
let reconnectAttempts = 0;
let networkStopped = false;

function buildWebSocketHeaders(deviceProtocol) {
    const resourceVersion = String(CONFIG.clientVersion || '').split('_')[0];
    const headers = {
        'Origin': 'https://gate-obt.nqf.qq.com',
        'Referer': `https://appservice.qq.com/1112386029/${resourceVersion}/page-frame.html`,
    };
    const userAgent = deviceProtocol && deviceProtocol.enabled
        ? String(deviceProtocol.userAgent || '').trim()
        : '';
    if (userAgent) headers['User-Agent'] = userAgent;
    return headers;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;

function closeCurrentWs({ terminate = false } = {}) {
    const current = ws;
    if (!current) return;
    ws = null;
    current.removeAllListeners();
    try {
        if (terminate && typeof current.terminate === 'function') current.terminate();
        else current.close();
    } catch { }
}

function getReconnectDelayMs() {
    const delay = RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, reconnectAttempts - 1));
    return Math.min(RECONNECT_MAX_DELAY_MS, delay);
}

function scheduleReconnect(reason) {
    if (networkStopped || !savedLoginCallback) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        const message = `自动重连失败次数过多，已停止重连${reason ? ` (${reason})` : ''}`;
        logWarn('系统', `[WS] ${message}`);
        networkEvents.emit('reconnect_failed', {
            attempts: reconnectAttempts,
            reason: reason || '',
        });
        return;
    }

    reconnectAttempts += 1;
    const delayMs = getReconnectDelayMs();
    networkScheduler.setTimeoutTask('auto_reconnect', delayMs, () => {
        if (networkStopped || !savedLoginCallback) return;
        log('系统', `[WS] 尝试自动重连... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnect(null);
    });
}

function connect(code, onLoginSuccess) {
    networkStopped = false;
    savedLoginCallback = onLoginSuccess;
    if (code) savedCode = code;
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${savedCode}&openID=`;
    closeCurrentWs({ terminate: true });

    // 获取设备协议配置
    let deviceProtocol = null;
    try {
        const store = getStoreModule();
        deviceProtocol = store.getDeviceProtocolForAccount(process.env.FARM_ACCOUNT_ID);
    // eslint-disable-next-line unused-imports/no-unused-vars
    } catch (e) {
        log('system', `failed to load device protocol config: ${e.message}`, {
            module: 'network',
            event: 'device_protocol',
            isWarn: true,
        });
    }

    // 输出自定义设备信息日志
    if (deviceProtocol && deviceProtocol.enabled) {
        const deviceInfo = [
            `品牌: ${deviceProtocol.deviceBrand || '未设置'}`,
            `型号: ${deviceProtocol.deviceModel || '未设置'}`,
            `MAC: ${deviceProtocol.deviceMac || '未设置'}`,
            `设备ID: ${deviceProtocol.deviceId || '未设置'}`,
            `IMEI: ${deviceProtocol.imei || '未设置'}`,
        ].join(' | ');
        const userAgent = String(deviceProtocol.userAgent || '').trim();
        log('系统', `使用自定义设备协议登录\n${deviceInfo}\nUA: ${userAgent ? `${userAgent.substring(0, 100)}...` : '不发送'}`, {
            module: 'network',
            event: '设备协议',
        });
    }

    const socket = new WebSocket(url, {
        headers: buildWebSocketHeaders(deviceProtocol),
    });
    ws = socket;

    socket.binaryType = 'arraybuffer';

    socket.on('open', async () => {
        reconnectAttempts = 0;
        try {
            await startSecurityRuntime(deviceProtocol);
            await sendLogin(onLoginSuccess, deviceProtocol);
        } catch (error) {
            logWarn('ACE', `安全运行时启动失败，已中止登录：${error.message}`);
            networkEvents.emit('security_error', { message: error.message });
            stopSecurityRuntime('初始化失败');
            closeCurrentWs({ terminate: true });
        }
    });

    socket.on('message', (data) => {
        handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    socket.on('close', (code, _reason) => {
        if (ws === socket) ws = null;
        logWarn('系统', `[WS] 连接关闭 (code=${code})`);
        networkEvents.emit('disconnect', { code });
        cleanup();
        scheduleReconnect(`close:${code}`);
    });

    socket.on('error', (err) => {
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number.parseInt(match[1], 10) || 0;
            if (code) {
                setWsErrorState(code, message);
                networkEvents.emit('ws_error', { code, message });
            }
        }
    });
}

function cleanup(reason = '网络清理') {
    stopSecurityRuntime(reason);
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    // pendingCallbacks.clear();
}

function reconnect(newCode) {
    if (networkStopped || !savedLoginCallback) return false;
    cleanup('主动重连');
    closeCurrentWs({ terminate: true });
    userState.gid = 0;
    connect(newCode || savedCode, savedLoginCallback);
    return true;
}

function stopNetwork(reason = '停止网络') {
    networkStopped = true;
    savedLoginCallback = null;
    reconnectAttempts = 0;
    stopSecurityRuntime(reason);
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    closeCurrentWs({ terminate: true });
    userState.gid = 0;
}

function getWs() { return ws; }
function isConnected() { return !!(ws && ws.readyState === WebSocket.OPEN); }
function getAceStatus() {
    if (aceService) return aceService.getStatus();
    return tsdkRuntime ? { running: false, runtime: tsdkRuntime.getStatus() } : null;
}

// ============ 网络模式：local（默认，直连） / gateway（独立网关进程持有连接） ============
// 灰度控制：FARM_GATEWAY_ACCOUNTS 指定走网关的账号 id 列表（逗号分隔）；未设置则全部走网关
const NETWORK_MODE = (process.env.FARM_NETWORK_MODE || 'local').toLowerCase();
// 账号 id：优先环境变量（fork worker 由 worker-manager 注入），其次 worker_threads.workerData（thread worker）
// 注意：必须在模块加载时确定，不能依赖 worker.js 后续才设置的 FARM_ACCOUNT_ID
let gwAccountId = process.env.FARM_ACCOUNT_ID || '';
try {
    const { workerData } = require('node:worker_threads');
    if (workerData && workerData.accountId) gwAccountId = String(workerData.accountId);
} catch (e) { /* 主进程/普通 require 场景忽略 */ }
function accountUsesGateway() {
    if (NETWORK_MODE !== 'gateway') return false;
    const list = process.env.FARM_GATEWAY_ACCOUNTS;
    if (!list) return true;
    return String(list).split(',').map(s => s.trim()).includes(gwAccountId);
}
let networkApi;
if (accountUsesGateway()) {
    // 连接层委托给独立网关进程：worker 重启/热更不再断开游戏 WebSocket（部署零掉线）
    const gatewayClient = require('../runtime/gateway-client');
    networkEvents = gatewayClient.networkEvents;
    gatewayClient.attach({
        handleNotify,
        onLogin: (us) => { if (us) Object.assign(userState, us); },
    });
    networkApi = {
        connect: (code, onReady) => gatewayClient.connect(gwAccountId, code, onReady),
        reconnect: () => false,
        cleanup: () => {},
        stopNetwork: () => gatewayClient.stop(gwAccountId),
        getWs: () => gatewayClient.getWs(),
        isConnected: () => gatewayClient.isConnected(),
        sendMsg: (service, method, bodyBytes, meta, serviceObj) =>
            gatewayClient.sendMsgAsync(service, method, bodyBytes, meta, serviceObj).then(() => {}),
        sendMsgAsync: (service, method, bodyBytes, meta, serviceObj) =>
            gatewayClient.sendMsgAsync(service, method, bodyBytes, meta, serviceObj),
        getUserState: () => userState,
        applyUserExpPatch,
        // ⭐ 亚健康退避闸门（2026-11-01）：由 worker 的 connection_degraded/recovered 处理器调用，
        // 在传输层统一拦截业务请求，解决"10+ 个业务入口只有 1 个检查退避"的缺陷。
        setHealthBackoff: (ms, reason) => gatewayClient.setHealthBackoff(ms, reason),
        clearHealthBackoff: () => gatewayClient.clearHealthBackoff(),
        isHealthBackoffActive: () => gatewayClient.isHealthBackoffActive(),
        getHealthBackoffState: () => gatewayClient.getHealthBackoffState(),
        getWsErrorState: () => ({ code: 0, message: '', time: 0 }),
        getAceStatus: () => gatewayClient.getAceStatus(),
        buildLoginDeviceInfo,
        buildLoginBody,
        buildHeartbeatBody,
        buildWebSocketHeaders,
        networkEvents: gatewayClient.networkEvents,
    };
    log('network', '已启用 gateway 模式（连接由独立网关进程持有）');
} else {
    networkApi = {
        connect, reconnect, cleanup, stopNetwork, getWs, isConnected,
        sendMsg, sendMsgAsync,
        getUserState,
        getWsErrorState,
        getAceStatus,
        buildLoginDeviceInfo,
        buildLoginBody,
        buildHeartbeatBody,
        buildWebSocketHeaders,
        buildTsdkDeviceInfo,
        resolveDeviceFingerprint,
        networkEvents,
    };
}
module.exports = networkApi;
