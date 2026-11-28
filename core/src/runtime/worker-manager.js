const { createScheduler } = require('../services/scheduler');
const { getRequestContext, requestError } = require('../utils/request-priority');

// 只列顶层明确安全读；强制刷新好友、好友农场和可能 Visit 的活动不在此列。
const SAFE_TOPLEVEL_READ = new Set([
    'getLands', 'getSeeds', 'getBag', 'getBagSeeds',
    'getPetOverview', 'getUnifiedHarvest', 'getFriends', 'getSchedulers',
    'getDecorationShop', 'getTransportDiagnostics', 'getRanchPendingOperations', 'getRanchSceneAccessInfo',
]);
const READ_RPC_TIMEOUT_MS = 65000;
const COMPOSITE_READ_RPC_TIMEOUT_MS = 90000;
const MAX_PENDING_RPC = 100;
const MAX_LATE_RESULTS = 50;
const WORKER_STOP_TIMEOUT_MS = 160000;
const MAX_WORKER_DRAIN_MS = 155000;
const MAX_RETIRED_DIAGNOSTICS = 100;

function canonicalArgs(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalArgs(value[key])}`).join(',')}}`;
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function rpcError(message, details = {}) {
    const error = requestError(String(message), details);
    for (const key of ['errorCode', 'stage', 'retryAfterMs', 'sent', 'resultState', 'outcomeUnknown',
        'holdUntilTransportEpochChanged', 'friendGid', 'processing']) {
        if (details[key] !== undefined) error[key] = details[key];
    }
    return error;
}

/**
 * 下线提醒触发阈值（毫秒）。
 * 60s 太敏感：网络抖动 1 分钟就会自愈，却每次都推送一次，形成刷屏。
 * 10 分钟内的掉线属于自愈范围，不该打扰用户。
 */
const OFFLINE_REMIND_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * 创建 Worker 管理器
 * 负责账号 Worker 进程/线程的启动、停止、重启、消息处理和 RPC 调用
 */
function createWorkerManager(deps) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog
    } = deps;

    const scheduler = createScheduler('worker_manager');
    const rpcStates = new WeakMap();
    let workerIdentity = 0;
    let shuttingDown = false;
    let shutdownComplete = false;
    let drainPromise = null;
    const retiredDiagnostics = new Map();

    function rpcState(wrk) {
        let state = rpcStates.get(wrk);
        if (!state) {
            state = { identity: ++workerIdentity, generation: 0, flights: new Map(), subscribers: 0, lateResults: [] };
            rpcStates.set(wrk, state);
        }
        return state;
    }

    function invalidateReads(wrk) {
        const state = rpcState(wrk);
        state.generation += 1;
        state.flights.clear();
    }

    function cleanupWorkerRequests(accountId, wrk, message = 'Worker exited') {
        if (!wrk) return;
        for (const pending of wrk.requests.values()) {
            pending.settle(rpcError(message, {
                errorCode: 'WORKER_EXITED', stage: 'worker_rpc', sent: pending.sent,
                resultState: pending.sent && !pending.readOnly ? 'unknown' : 'not_completed',
                outcomeUnknown: pending.sent && !pending.readOnly,
            }));
        }
        wrk.requests.clear();
        rpcState(wrk).flights.clear();
    }

    function pendingWriteCount(wrk) {
        let count = 0;
        for (const pending of wrk.requests.values()) {
            if (pending.sent && !pending.readOnly) count += 1;
        }
        return count;
    }

    function retainDiagnostics(accountId, wrk) {
        const state = rpcState(wrk);
        retiredDiagnostics.delete(String(accountId));
        retiredDiagnostics.set(String(accountId), cloneJson({ pending: 0, subscribers: 0, flights: 0,
            writeCount: 0, mutationGeneration: state.generation, lateResults: state.lateResults,
            quiesceAck: wrk.quiesceAck || null, stopOutcome: wrk.stopOutcome || null }));
        if (retiredDiagnostics.size > MAX_RETIRED_DIAGNOSTICS) retiredDiagnostics.delete(retiredDiagnostics.keys().next().value);
    }

    function emergencyCleanup() {
        if (shutdownComplete) return;
        shutdownComplete = true;
        shuttingDown = true;
        for (const [accountId, wrk] of Object.entries(workers)) {
            cleanupWorkerRequests(accountId, wrk);
            retainDiagnostics(accountId, wrk);
            wrk.restartCleanup?.();
            wrk.detachProcessListeners?.();
            wrk.finishStop?.();
        }
        scheduler.clearAll();
        processRef.removeListener?.('exit', emergencyCleanup);
        processRef.removeListener?.('disconnect', emergencyCleanup);
    }

    function shutdown(options = {}) {
        if (options.drain !== true) { emergencyCleanup(); return; }
        if (drainPromise) return drainPromise;
        if (shutdownComplete) return Promise.resolve();
        shuttingDown = true;
        const stops = Object.keys(workers).map(id => stopWorker(id, { preserveSession: options.preserveSession === true }));
        drainPromise = Promise.all(stops).then(outcomes => { emergencyCleanup(); return outcomes; });
        return drainPromise;
    }
    // 进程已退出时无法异步等待，仅做兜底清理；正常关闭走 drain。
    processRef.once?.('exit', emergencyCleanup);
    processRef.once?.('disconnect', emergencyCleanup);

    // 活动自动化「过期压关」的持久化钩子。
    // 读取侧（getAutomation/getConfigSnapshot）只能骗过面板与运行时判断，
    // 盘上残留的 true 不会被清理；这里在启动时 + 跨期定时把已出窗口的开关真正落盘为 false，
    // 并把新配置推给运行中的 worker，避免「活动已过期、后台还在跑」。
    const INACTIVE_ACTIVITY_CHECK_MS = 30 * 60 * 1000;
    function persistInactiveActivities() {
        try {
            const storeModule = require('../models/store');
            const changed = storeModule.persistInactiveActivityAutomation();
            for (const accountId of changed) {
                const wrk = workers[accountId];
                if (wrk?.process && !wrk.stopping) {
                    wrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
            if (changed.length > 0) {
                log('系统', `已压关过期活动自动化开关（账号 ${changed.join(', ')}）`);
            }
        } catch (error) {
            log('系统', `活动过期开关保存失败：${error && error.message ? error.message : error}`);
        }
    }
    persistInactiveActivities();
    scheduler.setIntervalTask('inactive_activity_config', INACTIVE_ACTIVITY_CHECK_MS, persistInactiveActivities);

    /** 是否支持 Thread 模式（非 pkg 打包 + Worker 可用） */
    const threadMode = runtimeMode === 'thread' && !processRef.pkg && typeof WorkerThread === 'function';

    function cleanText(value) {
        return String(value || '').trim();
    }

    function buildQqAvatarUrl(qq) {
        const value = cleanText(qq);
        if (!/^\d+$/.test(value)) return '';
        return `https://q1.qlogo.cn/g?b=qq&nk=${  value  }&s=100`;
    }

    function resolveLoginProfile(status, worker) {
        const data = status && typeof status === 'object' ? status : {};
        const info = data.status && typeof data.status === 'object' ? data.status : {};
        const platform = cleanText(info.platform || data.platform || worker.platform || 'qq').toLowerCase();
        const gid = cleanText(info.gid || data.gid);
        const openId = cleanText(info.openId || info.open_id || data.openId || data.open_id);
        const avatar = cleanText(info.avatar || info.avatarUrl || info.avatar_url || data.avatar || data.avatarUrl || data.avatar_url);
        const qq = cleanText(info.qq || info.uin || data.qq || data.uin || worker.qq || worker.uin);
        const fallbackAvatar = platform === 'qq' ? buildQqAvatarUrl(qq) : '';

        return {
            platform,
            gid,
            openId,
            qq,
            avatar: avatar || fallbackAvatar
        };
    }

    function syncAccountProfile(accountId, msgData, worker) {
        const profile = resolveLoginProfile(msgData, worker);
        const update = { id: accountId };

        if (profile.openId && worker.openId !== profile.openId) {
            update.openId = profile.openId;
        }
        if (profile.gid && worker.gid !== profile.gid) {
            update.gid = profile.gid;
        }
        if (profile.qq && worker.qq !== profile.qq) {
            update.qq = profile.qq;
            update.uin = profile.qq;
        }
        if (profile.avatar && worker.avatar !== profile.avatar) {
            update.avatar = profile.avatar;
        }

        if (Object.keys(update).length <= 1) return;

        addOrUpdateAccount(update);
        if (update.openId) worker.openId = update.openId;
        if (update.gid) worker.gid = update.gid;
        if (update.qq) {
            worker.qq = update.qq;
            worker.uin = update.uin;
        }
        if (update.avatar) worker.avatar = update.avatar;
    }

    /**
     * 创建 Thread Worker
     */
    function workerEnvironment(account) {
        const { resolveAccountGatewaySocket } = require('./gateway-routing');
        const route = resolveAccountGatewaySocket(account.id, processRef.env);
        if (route.blocked) throw new Error('微信网关凭据交接中，暂不启动账号');
        return {
            ...processRef.env,
            FARM_ACCOUNT_ID: String(account.id || ''),
            ...(route.delegated ? {
                FARM_NETWORK_MODE: 'gateway',
                FARM_GATEWAY_ACCOUNTS: String(account.id),
                FARM_GATEWAY_EXTERNAL: '1',
                FARM_GATEWAY_SOCK: route.socketPath,
            } : {}),
        };
    }

    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
            env: workerEnvironment(account),
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread'
            }
        });
        // 统一 send/kill 接口
        worker.send = (msg) => worker.postMessage(msg);
        worker.kill = () => worker.terminate();
        return worker;
    }

    /**
     * 创建 Fork Worker
     */
    function createForkWorker(account) {
        if (processRef.pkg) {
            // pkg 打包模式：fork 主入口而不是 worker 脚本
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: {
                    ...workerEnvironment(account),
                    FARM_WORKER: '1',
                }
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: workerEnvironment(account)
        });
    }

    /**
     * 根据运行模式创建 Worker
     */
    function createWorker(account) {
        if (threadMode) return createThreadWorker(account);
        return createForkWorker(account);
    }

    /**
     * 启动账号 Worker
     */
    function startWorker(account, options = {}) {
        if (shuttingDown || !account || !account.id) return false;
        if (require('../services/account-maintenance-hold').isAccountMaintenanceHeld(account.id)) {
            log('系统', '账号处于维护停运状态，未启动', { accountId: String(account.id), event: 'maintenance_hold' });
            return false;
        }
        if (workers[account.id]) return false;

        log('系统', `正在启动账号: ${  account.name}`, {
            accountId: String(account.id),
            accountName: account.name
        });

        let proc = null;
        try {
            proc = createWorker(account);
        } catch (err) {
            const errorMsg = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${  account.name  } 启动失败: ${  errorMsg}`, {
                accountId: String(account.id),
                accountName: account.name
            });
            addAccountLog('start_failed', `账号 ${  account.name  } 启动失败`,
                account.id, account.name, { reason: errorMsg });
            return false;
        }

        // 注册 Worker 记录
        workers[account.id] = {
            process: proc,
            status: null,
            resumeSession: options.resumeSession === true,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            username: account.username || '',
            platform: account.platform || 'qq',
            loginCode: account.code,
            gid: account.gid || '',
            openId: account.openId || account.open_id || '',
            qq: account.qq || account.uin || '',
            uin: account.uin || account.qq || '',
            avatar: account.avatar || account.avatarUrl || '',
            stopping: false,
            disconnectedSince: 0,
            offlineReminderTriggered: false,
            offlineReminderNextRetryAt: 0,
            autoDeleteTriggered: false,
            wsError: null
        };

        const registeredWorker = workers[account.id];
        const onMessage = (msg) => {
            if (workers[account.id]?.process !== proc) return;
            handleWorkerMessage(account.id, msg);
        };

        const onError = (err) => {
            if (workers[account.id]?.process === proc) {
                workers[account.id].rpcFailed = true;
                if (!workers[account.id].stopping && !shuttingDown) cleanupWorkerRequests(account.id, workers[account.id]);
            }
            log('系统', `账号 ${  account.name  } 子进程启动失败: ${ 
                err && err.message ? err.message : err}`, {
                accountId: String(account.id),
                accountName: account.name
            });
        };

        const onExit = (code, signal) => {
            if (registeredWorker.stopping && !registeredWorker.stopOutcome) {
                const graceful = code === 0 && !signal;
                registeredWorker.stopOutcome = { graceful, resultState: graceful ? 'worker_exited' : 'unknown',
                    outcomeUnknown: !graceful, at: Date.now() };
            }
            registeredWorker.detachProcessListeners();
            cleanupWorkerRequests(account.id, registeredWorker);
            retainDiagnostics(account.id, registeredWorker);
            registeredWorker.finishStop?.();
            const wrk = workers[account.id];
            const displayName = wrk && wrk.name ? wrk.name : account.name;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code 
                }, signal=${  signal || 'none'  })`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            // 超时强杀后旧进程的 exit 可能迟到，不能清掉新 worker 的计时器或请求。
            if (wrk && wrk.process !== proc) return;

            scheduler.clear(`force_kill_${  account.id}`);
            scheduler.clear(`restart_fallback_${  account.id}`);

            cleanupWorkerRequests(account.id, wrk);

            const wasStopping = !!(wrk && wrk.stopping);
            if (wrk && wrk.process === proc) {
                delete workers[account.id];
            }

            // 自动拉起：仅当非主动停止（非 stop/restart 触发）时重启 worker。
            // gateway 模式下 worker 重启由网关进程保活连接，不消耗新 Code，可安全自动拉起。
            if (!shuttingDown && !wasStopping && !threadMode) {
                scheduleWorkerAutoRestart(account.id, displayName);
            }
        };
        registeredWorker.detachProcessListeners = () => {
            proc.removeListener('message', onMessage);
            proc.removeListener('error', onError);
            proc.removeListener('exit', onExit);
        };
        proc.on('message', onMessage);
        proc.on('error', onError);
        proc.once('exit', onExit);
        try {
            proc.send({
                type: 'start',
                config: { code: account.code, platform: account.platform, loginType: account.loginType || 'manual', resumeSession: options.resumeSession === true },
            }, error => { if (error) onError(error); });
            proc.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) }, error => { if (error) onError(error); });
        } catch (error) {
            onError(error);
            stopWorker(account.id);
            return false;
        }

        return true;
    }

    // ============ worker 崩溃自动拉起（含防风暴） ============
    const autoRestartState = new Map(); // accountId -> { count, firstTs }
    function scheduleWorkerAutoRestart(accountId, displayName) {
        const now = Date.now();
        let st = autoRestartState.get(accountId);
        if (!st || now - st.firstTs > 30000) {
            st = { count: 0, firstTs: now };
        }
        st.count += 1;
        autoRestartState.set(accountId, st);

        // 防风暴：30 秒内连续崩溃超过 3 次则停止自动拉起，需人工介入
        if (st.count > 3) {
            log('系统', `账号 ${  displayName  } 连续崩溃超过 3 次，已停止自动拉起（请检查 Code 或手动重启）`, {
                accountId: String(accountId),
            });
            autoRestartState.delete(accountId);
            return;
        }

        const delayMs = Math.min(3000, 1000 * st.count);
        scheduler.setTimeoutTask(`auto_restart_${  accountId}`, delayMs, () => {
            // 若已被手动启动/重启则跳过
            if (workers[accountId]) return;
            try {
                const store = require('../models/store');
                const accs = store.getAccounts() || {};
                const acc = (accs.accounts || []).find((a) => String(a.id) === String(accountId));
                if (!acc) {
                    log('系统', `账号 ${  displayName  } 已删除，跳过自动拉起`, { accountId: String(accountId) });
                    return;
                }
                log('系统', `账号 ${  displayName  } 已自动拉起（worker 崩溃恢复）`, { accountId: String(accountId) });
                const gatewayIds = String(processRef.env.FARM_GATEWAY_ACCOUNTS || '').trim();
                const resumeSession = processRef.env.FARM_NETWORK_MODE === 'gateway'
                    && (!gatewayIds || gatewayIds.split(',').map(s => s.trim()).includes(String(accountId)));
                startWorker(acc, { resumeSession });
            } catch (e) {
                log('错误', `自动拉起账号 ${  displayName  } 失败: ${  e.message  }`, { accountId: String(accountId) });
            }
        });
    }

    /**
     * 停止账号 Worker
     */
    function stopWorker(accountId, options = {}) {
        const wrk = workers[accountId];
        if (!wrk) return Promise.resolve();
        if (wrk.stopPromise) return wrk.stopPromise;
        const targetProc = wrk.process;
        wrk.stopping = true;
        wrk.stopDeadline = Date.now() + WORKER_STOP_TIMEOUT_MS;
        wrk.stopPromise = new Promise(resolve => {
            wrk.finishStop = () => {
                scheduler.clear(`force_kill_${accountId}`);
                wrk.finishStop = null;
                resolve({ accountId: String(accountId), ...(wrk.stopOutcome || {
                    graceful: false, resultState: 'unknown', outcomeUnknown: true,
                }) });
            };
        });
        const forceStop = () => {
            if (workers[accountId]?.process !== targetProc) { wrk.finishStop?.(); return; }
            // raw 自动化写不在 RPC Map 中，超时只记未知结果，不推断已排空。
            wrk.stopOutcome = { graceful: false, sent: true, resultState: 'unknown', outcomeUnknown: true,
                errorCode: 'WORKER_DRAIN_TIMEOUT', at: Date.now() };
            log('系统', 'Worker 排空超时，结果未知', { accountId: String(accountId), ...wrk.stopOutcome });
            cleanupWorkerRequests(accountId, wrk);
            retainDiagnostics(accountId, wrk);
            wrk.detachProcessListeners?.();
            try { targetProc.kill(); } catch { }
            if (workers[accountId]?.process === targetProc) delete workers[accountId];
            wrk.finishStop?.();
        };
        // stop 必须等 worker 自身的 raw 传输排空，不按 RPC 计数或状态快照提前强杀。
        scheduler.setTimeoutTask(`force_kill_${accountId}`, WORKER_STOP_TIMEOUT_MS, forceStop);
        // 只取消明确安全读，保留消息监听和所有 pending，写由 worker stop 等待结算。
        for (const pending of [...wrk.requests.values()]) if (pending.readOnly) pending.cancel();
        try {
            targetProc.send({ type: 'stop', preserveSession: options.preserveSession === true });
        } catch { }
        return wrk.stopPromise;
    }

    /**
     * 重启账号 Worker
     */
    function restartWorker(account, options = {}) {
        if (!account) return;
        const accountId = account.id;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account, options);

        const targetProc = wrk.process;
        const gatewayIds = String(processRef.env.FARM_GATEWAY_ACCOUNTS || '').trim();
        const usesGateway = processRef.env.FARM_NETWORK_MODE === 'gateway'
            && (!gatewayIds || gatewayIds.split(',').map(s => s.trim()).includes(String(accountId)));
        const startOptions = {
            ...options,
            resumeSession: options.resumeSession === true
                || (usesGateway && options.replaceSession !== true && account.code === wrk.loginCode),
        };
        if (wrk.restartPromise) return wrk.restartPromise;
        const doRestart = () => {
            if (shuttingDown) return false;
            const current = workers[accountId];
            if (current && current.process !== targetProc) return false;
            if (current) {
                cleanupWorkerRequests(accountId, current);
                retainDiagnostics(accountId, current);
                current.detachProcessListeners?.();
                delete workers[accountId];
            }
            return startWorker(account, startOptions);
        };
        if (typeof targetProc.exitCode === 'number' || targetProc.signalCode) return doRestart();
        // 重复重启复用同一排空 Promise；不再有独立 1500ms 强杀回退。
        wrk.restartPromise = stopWorker(accountId, {
            preserveSession: processRef.env.FARM_NETWORK_MODE === 'gateway',
        }).then(doRestart);
        return wrk.restartPromise;
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;

        if (msg.type === 'worker_quiescing') {
            if (!wrk.stopping || wrk.quiesceAck) return;
            if (!Number.isInteger(msg.pendingWrites) || msg.pendingWrites < 0
                || !Number.isFinite(msg.maxDrainMs) || msg.maxDrainMs < 0) return;
            const maxDrainMs = Math.min(MAX_WORKER_DRAIN_MS, msg.maxDrainMs);
            wrk.quiesceAck = { pendingWrites: msg.pendingWrites, maxDrainMs,
                at: Date.now(), deadline: Math.min(wrk.stopDeadline, Date.now() + maxDrainMs + 1000) };
            // ack 是计数快照，不代表 raw 写已经排空；不能据此缩短统一退出保护。
            log('系统', 'Worker 已进入传输排空', { accountId: String(accountId), ...wrk.quiesceAck });
        } else if (msg.type === 'status_sync') {
            // 状态同步
            wrk.status = normalizeStatusForPanel(msg.data, accountId, wrk.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, wrk.status, wrk.name);
            }

            syncAccountProfile(accountId, msg.data, wrk);

            // 同步昵称
            if (msg.data && msg.data.status && msg.data.status.name) {
                const nick = String(msg.data.status.name).trim();
                if (nick && nick !== '未知' && nick !== '未登录') {
                    if (wrk.nick !== nick) {
                        const oldNick = wrk.nick;
                        wrk.nick = nick;
                        addOrUpdateAccount({ id: accountId, nick });
                        if (oldNick !== nick) {
                            log('系统', `已同步账号昵称: ${  oldNick || 'None'  } -> ${  nick}`, {
                                accountId, accountName: wrk.name
                            });
                        }
                    }
                }
            }

            // 连接状态追踪和离线提醒
            const isConnected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (isConnected) {
                wrk.disconnectedSince = 0;
                wrk.offlineReminderTriggered = false;
                wrk.offlineReminderNextRetryAt = 0;
                wrk.autoDeleteTriggered = false;
                wrk.wsError = null;
            } else if (!wrk.stopping) {
                const now = Date.now();
                if (!wrk.disconnectedSince) wrk.disconnectedSince = now;

                const offlineDuration = now - wrk.disconnectedSince;
                // 提醒成功才置 triggered；失败则进入冷却重试（避免"配置缺失→静默丢弃→永不重推"）
                const canRetry = !wrk.offlineReminderNextRetryAt || now >= wrk.offlineReminderNextRetryAt;
                // ⭐ 阈值 60s → 10min（2026-10-31）
                // 原因：微信/QQ 网络抖动极常见，掉线 1 分钟就会自动重连回来。
                // 旧阈值 60s 配合「一连上就重置 offlineReminderTriggered」，
                // 会形成「掉线→满1分钟推送→重连→重置→再掉线→再推送」的连环刷屏
                // （实测 10-30 下午 3 点后连推 3~5 条，全是同一账号的抖动）。
                // 10 分钟内的短暂掉线属于自愈范围，不该打扰用户。
                if (!wrk.offlineReminderTriggered && canRetry && offlineDuration >= OFFLINE_REMIND_THRESHOLD_MS) {
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 已离线 ${  offlineMinutes  } 分钟，发送下线提醒`);

                    Promise.resolve(triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline',
                        offlineMs: offlineDuration
                    })).then((sent) => {
                        const cur = workers[accountId];
                        if (!cur || cur.process !== (wrk && wrk.process)) return;
                        if (sent) {
                            cur.offlineReminderTriggered = true;
                            cur.offlineReminderNextRetryAt = 0;
                            addAccountLog('offline_reminder',
                                `账号 ${  cur.name  } 已离线 ${  offlineMinutes  } 分钟，已发送下线提醒`,
                                accountId, cur.name, { reason: 'offline', offlineMs: offlineDuration });
                        } else {
                            // 未成功发送：30 分钟后重试（下一轮离线检查会再尝试）
                            cur.offlineReminderNextRetryAt = Date.now() + 30 * 60 * 1000;
                            log('错误', `账号 ${  cur.name  } 下线提醒发送失败，30 分钟后重试`);
                        }
                    }).catch(() => {
                        const cur = workers[accountId];
                        if (cur) cur.offlineReminderNextRetryAt = Date.now() + 30 * 60 * 1000;
                    });
                }

                const autoDeleteMs = typeof getOfflineAutoDeleteMs === 'function'
                    ? getOfflineAutoDeleteMs(wrk.username)
                    : Infinity;
                if (!wrk.autoDeleteTriggered && offlineDuration >= autoDeleteMs) {
                    wrk.autoDeleteTriggered = true;
                    const offlineMinutes = Math.floor(offlineDuration / 60000);
                    log('系统', `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，自动删除账号信息`, {
                        accountId: String(accountId),
                        accountName: wrk.name
                    });
                    triggerOfflineReminder({
                        accountId,
                        accountName: wrk.name,
                        username: wrk.username,
                        reason: 'offline_timeout',
                        offlineMs: offlineDuration
                    });
                    addAccountLog('offline_delete',
                        `账号 ${  wrk.name  } 持续离线 ${  offlineMinutes  } 分钟，已自动删除`,
                        accountId, wrk.name, { reason: 'offline_timeout', offlineMs: offlineDuration });
                    stopWorker(accountId);
                    try {
                        if (typeof deleteAccount === 'function') deleteAccount(accountId);
                    } catch (err) {
                        log('错误', `删除离线账号失败: ${  err.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            // 日志消息
            const entry = {
                ...msg.data,
                accountId,
                accountName: wrk.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {}
            };
            entry._searchText = (`${entry.msg || ''  } ${  entry.tag || '' 
                } ${  JSON.stringify(entry.meta || {})}`).toLowerCase();

            wrk.logs.push(entry);
            if (wrk.logs.length > 1000) wrk.logs.shift();

            globalLogs.push(entry);
            if (globalLogs.length > 2000) globalLogs.shift();

            if (typeof onWorkerLog === 'function') {
                onWorkerLog(entry, accountId, wrk.name);
            }
        } else if (msg.type === 'error') {
            log('错误', `账号[${  accountId  }]进程报错: ${  msg.error}`, {
                accountId: String(accountId),
                accountName: wrk.name
            });
        } else if (msg.type === 'ws_error') {
            // WebSocket 错误
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            wrk.wsError = { code, message, at: Date.now() };

            // Code 400 = 登录失效
            if (code === 400) {
                addAccountLog('ws_400', `账号 ${  wrk.name  } 登录失效，请更新 Code`,
                    accountId, wrk.name);
            }
        } else if (msg.type === 'account_kicked') {
            // 被踢下线
            const reason = msg.reason || '未知';
            log('系统', `账号 ${  wrk.name  } 被踢下线，已自动停止账号`, {
                accountId: String(accountId),
                accountName: wrk.name
            });

            triggerOfflineReminder({
                accountId,
                accountName: wrk.name,
                reason: `kickout:${  reason}`,
                offlineMs: 0
            });
            addAccountLog('kickout_stop',
                `账号 ${  wrk.name  } 被踢下线，已自动停止`,
                accountId, wrk.name, { reason });

            stopWorker(accountId);
        } else if (msg.type === 'ws_reconnect_failed') {
            const reason = msg.reason || '未知';
            log('系统', `账号 ${  wrk.name  } 网关重连中，等待自动恢复（不停止账号）`, {
                accountId: String(accountId),
                accountName: wrk.name
            });
            addAccountLog('ws_reconnect_failed',
                `账号 ${  wrk.name  } 网关重连中，等待自动恢复`,
                accountId, wrk.name, { reason });
            // 不再 stopWorker：网关进程会持续重连，worker 保持存活；
            // 只有 Code 真失效（ws_error 400）或被踢下线（kickout）才真正停止账号。
        } else if (msg.type === 'automation_patch') {
            const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
            if ((patch.automation && typeof patch.automation === 'object')
                || patch.friendBadRetryDate !== undefined
                || patch.stealPlans !== undefined) {
                const store = require('../models/store');
                store.applyConfigSnapshot(patch, { accountId });
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        } else if (msg.type === 'known_friend_gids_sync') {
            // worker 发现的已知好友 GID：由主进程代写 store.json。
            // ⚠️ 这个分支以前不存在，导致 worker 的 knownFriendGids 只能靠
            // 「worker 自己 saveGlobalConfig 全量 dump」这个 bug 意外落盘；
            // 现在 store.js 已加进程守卫拦住 worker 落盘，必须在这里补上接收端，
            // 否则好友列表会彻底丢持久化。
            const gids = Array.isArray(msg.gids) ? msg.gids.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
            if (gids.length > 0) {
                const { setKnownFriendGids } = require('../models/store');
                setKnownFriendGids(accountId, gids);
                log('好友', `已同步 ${gids.length} 位已知好友 GID 到主进程`, {
                    accountId: String(accountId),
                    accountName: wrk.name,
                    count: gids.length
                });

                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        } else if (msg.type === 'known_friend_gid_remove') {
            // worker 检测到失效好友 GID：由主进程代写 store.json。
            // 与 known_friend_gids_sync 同理——以前没有接收端，只能靠 worker 全量 dump 意外落盘。
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { removeKnownFriendGid } = require('../models/store');
                const removed = removeKnownFriendGid(accountId, gid, msg.friendName, msg.reason);
                if (removed) {
                    log('好友', `主进程已移除失效好友 GID ${msg.friendName || `GID:${gid}`}`, {
                        accountId: String(accountId),
                        accountName: wrk.name,
                        friendGid: gid,
                        friendName: msg.friendName,
                        reason: msg.reason
                    });

                    const currentWrk = workers[accountId];
                    if (currentWrk && currentWrk.process) {
                        currentWrk.process.send({
                            type: 'config_sync',
                            config: buildConfigSnapshotForAccount(accountId)
                        });
                    }
                }
            }
        } else if (msg.type === 'api_response') {
            const { id, result, error, errorMeta } = msg;
            const pending = wrk.requests.get(id);
            if (pending) {
                pending.settle(error ? rpcError(error, {
                    stage: 'worker_rpc', sent: pending.sent,
                    resultState: pending.readOnly ? 'not_completed' : 'unknown', outcomeUnknown: !pending.readOnly,
                    ...(errorMeta || {}),
                }) : null, result);
            } else {
                const record = rpcState(wrk).lateResults.find(item => item.id === id);
                if (record && record.resultState === 'unknown') {
                    record.completedAt = Date.now();
                    record.resultState = error ? (errorMeta?.resultState || 'unknown') : 'completed';
                    record.outcomeUnknown = error ? (errorMeta?.outcomeUnknown ?? record.resultState === 'unknown') : false;
                    record.errorCode = errorMeta?.errorCode;
                    // 只留状态，不保存结果、参数或可能含凭据的错误文本。
                    log('系统', record.late !== false ? 'Worker 写请求迟到结果已结算' : 'Worker 写请求终态状态已更新', {
                        accountId: String(accountId), ...record,
                    });
                }
            }
        } else if (msg.type === 'friend_blacklist_add') {
            // 好友黑名单添加
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist } = require('../models/store');
                addFriendToBlacklist(accountId, gid);
                log('好友', `已将好友 ${  msg.friendName || `GID:${  gid}`  } 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: wrk.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason
                });

                // 同步黑名单到 Worker
                const currentWrk = workers[accountId];
                if (currentWrk && currentWrk.process) {
                    currentWrk.process.send({
                        type: 'config_sync',
                        config: buildConfigSnapshotForAccount(accountId)
                    });
                }
            }
        }
    }

    /**
     * 调用 Worker API（RPC）
     */
    function callWorkerApi(accountId, method, ...args) {
        const wrk = workers[accountId];
        const proc = wrk?.process;
        if (shuttingDown || !wrk || wrk.stopping || wrk.rpcFailed || !proc
            || proc.connected === false || typeof proc.exitCode === 'number' || proc.signalCode) {
            return Promise.reject(rpcError('账号未运行', { errorCode: 'WORKER_NOT_RUNNING', stage: 'worker_rpc', sent: false, resultState: 'not_sent' }));
        }
        const context = getRequestContext();
        const lastArg = args.at(-1);
        const customTimeout = lastArg && typeof lastArg === 'object' && lastArg._timeoutMs;
        const actualArgs = customTimeout ? args.slice(0, -1) : args.slice();
        while (actualArgs.length && actualArgs.at(-1) === undefined) actualArgs.pop();
        const readOnly = SAFE_TOPLEVEL_READ.has(method)
            && (method === 'getFriends'
                ? actualArgs.length <= 1 && (actualArgs.length === 0 || actualArgs[0] === false)
                : actualArgs.length === 0);
        const readBudget = ['getLands', 'getBagSeeds', 'getPetOverview'].includes(method)
            ? COMPOSITE_READ_RPC_TIMEOUT_MS : READ_RPC_TIMEOUT_MS;
        const timeoutMs = customTimeout ? Number(lastArg._timeoutMs) || 10000 : (readOnly ? readBudget : 10000);
        const now = Date.now();
        const contextDeadline = Number.isFinite(context.deadline) ? context.deadline : Infinity;
        const subscriberDeadline = Math.min(now + Math.max(1, timeoutMs), contextDeadline);
        // 短订阅者只限制自己的等待；共享安全读具有覆盖线端和排队的固定有界预算。
        const deadline = readOnly ? now + readBudget : subscriberDeadline;
        if (context.signal?.aborted || subscriberDeadline <= Date.now()) {
            return Promise.reject(rpcError(context.signal?.aborted ? 'Request Cancelled' : 'API Timeout', {
                errorCode: context.signal?.aborted ? 'CANCELLED' : 'DEADLINE', stage: 'worker_rpc', sent: false, resultState: 'not_sent',
            }));
        }
        const state = rpcState(wrk);
        const transport = wrk.status?.stats?.gatewayTransport || wrk.status?.gatewayTransport || {};
        const diagnosticSession = transport.transport || transport;
        const directSession = diagnosticSession.direct || {};
        let key;
        try {
            key = readOnly ? canonicalArgs(JSON.parse(JSON.stringify([state.identity,
                diagnosticSession.currentGID ?? diagnosticSession.currentGid ?? directSession.currentGID ?? directSession.currentGid ?? wrk.status?.status?.gid ?? wrk.gid ?? '',
                diagnosticSession.sessionEpoch ?? directSession.sessionEpoch ?? wrk.sessionEpoch ?? '',
                diagnosticSession.connectionEpoch ?? '', directSession.connectionEpoch ?? '', method, actualArgs, state.generation]))) : null;
        } catch {
            return Promise.reject(rpcError('Invalid RPC arguments', { errorCode: 'INVALID_ARGUMENT', sent: false, resultState: 'not_sent' }));
        }
        let pending = key && state.flights.get(key);
        if (state.subscribers >= MAX_PENDING_RPC || (!pending && wrk.requests.size >= MAX_PENDING_RPC)) {
            return Promise.reject(rpcError('Worker API queue full', { errorCode: 'QUEUE_FULL', stage: 'worker_rpc', sent: false, resultState: 'not_sent' }));
        }
        if (pending?.draining) {
            return Promise.reject(rpcError('API Timeout', { errorCode: 'DEADLINE', stage: 'worker_rpc', sent: false, resultState: 'not_sent' }));
        }
        const isNew = !pending;
        if (isNew) {
            if (!readOnly) invalidateReads(wrk);
            const id = wrk.reqId++;
            pending = { id, method, readOnly, key, deadline, sent: false, subscribers: new Set(), subscriberId: 0, draining: false, cancelSent: false };
            pending.cancel = () => {
                if (!pending.readOnly || !pending.sent || pending.cancelSent) return;
                pending.cancelSent = true;
                const onCancelSendError = () => {
                    // 取消消息发送失败不能证明底层已停止，封闭此 worker 的新 RPC 防止重复读。
                    wrk.rpcFailed = true;
                    // 停机排空期间不能因读取消 IPC 失败丢弃仍待结算的写。
                    if (!wrk.stopping && !shuttingDown) cleanupWorkerRequests(accountId, wrk);
                };
                try {
                    proc.send({ type: 'api_cancel', id }, error => { if (error) onCancelSendError(); });
                } catch {
                    onCancelSendError();
                }
            };
            pending.recordLate = (late = true) => {
                if (readOnly || !pending.sent || pending.lateRecord) return;
                pending.lateRecord = { id, method, at: Date.now(), sent: true, resultState: 'unknown', outcomeUnknown: true, late };
                state.lateResults.push(pending.lateRecord);
                if (state.lateResults.length > MAX_LATE_RESULTS) state.lateResults.shift();
                if (late) log('系统', 'Worker 写请求等待迟到结算', { accountId: String(accountId), ...pending.lateRecord });
            };
            pending.settle = (error, result) => {
                if (wrk.requests.get(id) !== pending) return;
                // IPC已派发不等于游戏写已发送；立即终态unknown不是订阅超时后的迟到回包。
                if (error?.outcomeUnknown === true && error.sent !== false) pending.recordLate(false);
                scheduler.clear(`api_timeout_${accountId}_${id}`);
                wrk.requests.delete(id);
                if (key && state.flights.get(key) === pending) state.flights.delete(key);
                if (!readOnly) {
                    invalidateReads(wrk);
                    if (pending.outcomeContext) pending.outcomeContext.pendingWrites -= 1;
                }
                if (pending.lateRecord) {
                    pending.lateRecord.completedAt = Date.now();
                    pending.lateRecord.resultState = error ? (error.resultState || 'failed') : 'completed';
                    pending.lateRecord.outcomeUnknown = error?.outcomeUnknown === true;
                    pending.lateRecord.errorCode = error?.errorCode;
                    log('系统', pending.lateRecord.late ? 'Worker 写请求迟到结果已结算' : 'Worker 写请求终态结果未知', {
                        accountId: String(accountId), ...pending.lateRecord,
                    });
                }
                for (const subscriber of [...pending.subscribers]) {
                    if (error) subscriber.finish(rpcError(error.message, {
                        errorCode: error.errorCode, stage: error.stage, retryAfterMs: error.retryAfterMs,
                        sent: error.sent, resultState: error.resultState, outcomeUnknown: error.outcomeUnknown,
                        holdUntilTransportEpochChanged: error.holdUntilTransportEpochChanged,
                        friendGid: error.friendGid, processing: error.processing,
                    }));
                    else {
                        try { subscriber.finish(null, cloneJson(result)); }
                        catch { subscriber.finish(rpcError('Invalid RPC response', { errorCode: 'INVALID_RESPONSE', stage: 'worker_rpc' })); }
                    }
                }
            };
            wrk.requests.set(id, pending);
            if (key) state.flights.set(key, pending);
            scheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, Math.max(1, deadline - Date.now()), () => {
                pending.draining = true;
                pending.recordLate();
                pending.cancel();
                for (const subscriber of [...pending.subscribers]) subscriber.finish(rpcError('API Timeout', {
                    errorCode: 'DEADLINE', stage: 'worker_rpc', sent: pending.sent,
                    resultState: !readOnly && pending.sent ? 'unknown' : 'not_completed', outcomeUnknown: !readOnly && pending.sent,
                }));
                // 无终态仍占有名额，防止取消后重复发起底层请求；只由回包/退出释放。
            });
        }
        return new Promise((resolve, reject) => {
            const subscriberKey = `api_subscriber_${accountId}_${pending.id}_${++pending.subscriberId}`;
            const subscriber = {
                finish(error, result) {
                    if (!pending.subscribers.delete(subscriber)) return;
                    state.subscribers -= 1;
                    scheduler.clear(subscriberKey);
                    context.signal?.removeEventListener('abort', onAbort);
                    if (error) reject(error); else resolve(result);
                },
            };
            const onAbort = () => {
                subscriber.finish(rpcError('Request Cancelled', {
                    errorCode: 'CANCELLED', stage: 'worker_rpc', sent: pending.sent,
                    resultState: !readOnly && pending.sent ? 'unknown' : 'not_completed', outcomeUnknown: !readOnly && pending.sent,
                }));
                if (!pending.subscribers.size) {
                    pending.draining = true;
                    pending.recordLate();
                    pending.cancel();
                }
            };
            state.subscribers += 1;
            pending.subscribers.add(subscriber);
            context.signal?.addEventListener('abort', onAbort, { once: true });
            scheduler.setTimeoutTask(subscriberKey, Math.max(1, subscriberDeadline - Date.now()), () => {
                subscriber.finish(rpcError('API Timeout', {
                    errorCode: 'DEADLINE', stage: 'worker_rpc', sent: pending.sent,
                    resultState: !readOnly && pending.sent ? 'unknown' : 'not_completed', outcomeUnknown: !readOnly && pending.sent,
                }));
                if (!pending.subscribers.size) {
                    pending.draining = true;
                    pending.recordLate();
                    pending.cancel();
                }
            });
            if (context.signal?.aborted) onAbort();
            if (!isNew || !pending.subscribers.size) {
                if (isNew) pending.settle(rpcError('Request Cancelled', { errorCode: 'CANCELLED', sent: false, resultState: 'not_sent' }));
                return;
            }
            try {
                pending.sent = true;
                if (!readOnly && context.rpcOutcome) {
                    pending.outcomeContext = context.rpcOutcome;
                    context.rpcOutcome.pendingWrites += 1;
                }
                proc.send({ type: 'api_call', id: pending.id, method, args: actualArgs, deadline, readOnly }, error => {
                    if (error) pending.settle(rpcError('Worker send failed', {
                        errorCode: 'WORKER_SEND_FAILED', stage: 'worker_rpc', sent: true,
                        resultState: readOnly ? 'not_completed' : 'unknown', outcomeUnknown: !readOnly,
                    }));
                });
            } catch {
                pending.sent = false;
                pending.settle(rpcError('Worker send failed', { errorCode: 'WORKER_SEND_FAILED', stage: 'worker_rpc', sent: false, resultState: 'not_sent' }));
            }
        });
    }

    function getDiagnostics(accountId) {
        const wrk = workers[accountId];
        if (!wrk) return cloneJson(retiredDiagnostics.get(String(accountId))
            || { pending: 0, subscribers: 0, flights: 0, writeCount: 0, lateResults: [] });
        const state = rpcState(wrk);
        return cloneJson({ pending: wrk.requests.size, subscribers: state.subscribers, flights: state.flights.size,
            writeCount: pendingWriteCount(wrk),
            mutationGeneration: state.generation, lateResults: state.lateResults,
            quiesceAck: wrk.quiesceAck || null, stopOutcome: wrk.stopOutcome || null });
    }

    // runtime-engine 已将同一函数传给 provider，沿此引用附带本地诊断，避免改动引擎注入结构。
    callWorkerApi.getDiagnostics = getDiagnostics;

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        getDiagnostics,
        shutdown,
        emergencyCleanup
    };
}

module.exports = { createWorkerManager };
