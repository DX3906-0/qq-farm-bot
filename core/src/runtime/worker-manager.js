const { createScheduler } = require('../services/scheduler');

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
    function createThreadWorker(account) {
        const worker = new WorkerThread(workerScriptPath, {
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
                    ...processRef.env,
                    FARM_WORKER: '1',
                    FARM_ACCOUNT_ID: String(account.id || '')
                }
            });
        }
        return fork(workerScriptPath, [], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: {
                ...processRef.env,
                FARM_ACCOUNT_ID: String(account.id || '')
            }
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
    function startWorker(account) {
        if (!account || !account.id) return false;
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
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            username: account.username || '',
            platform: account.platform || 'qq',
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

        // 发送启动配置
        proc.send({
            type: 'start',
            config: { code: account.code, platform: account.platform, loginType: account.loginType || 'manual' }
        });

        // 发送配置快照
        proc.send({
            type: 'config_sync',
            config: buildConfigSnapshotForAccount(account.id)
        });

        // 监听 Worker 消息
        proc.on('message', (msg) => {
            handleWorkerMessage(account.id, msg);
        });

        // 监听 Worker 错误
        proc.on('error', (err) => {
            log('系统', `账号 ${  account.name  } 子进程启动失败: ${ 
                err && err.message ? err.message : err}`, {
                accountId: String(account.id),
                accountName: account.name
            });
        });

        // 监听 Worker 退出
        proc.on('exit', (code, signal) => {
            const wrk = workers[account.id];
            const displayName = wrk && wrk.name ? wrk.name : account.name;

            log('系统', `账号 ${  displayName  } 进程退出 (code=${  code 
                }, signal=${  signal || 'none'  })`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: threadMode ? 'thread' : 'fork'
            });

            scheduler.clear(`force_kill_${  account.id}`);
            scheduler.clear(`restart_fallback_${  account.id}`);

            // 清理所有未完成的 API 请求
            if (wrk && wrk.requests && wrk.requests.size > 0) {
                for (const [reqId, pending] of wrk.requests.entries()) {
                    scheduler.clear(`api_timeout_${  account.id  }_${  reqId}`);
                    try { pending.reject(new Error('Worker exited')); } catch { }
                }
                wrk.requests.clear();
            }

            const wasStopping = !!(wrk && wrk.stopping);
            if (wrk && wrk.process === proc) {
                delete workers[account.id];
            }

            // 自动拉起：仅当非主动停止（非 stop/restart 触发）时重启 worker。
            // gateway 模式下 worker 重启由网关进程保活连接，不消耗新 Code，可安全自动拉起。
            if (!wasStopping && !threadMode) {
                scheduleWorkerAutoRestart(account.id, displayName);
            }
        });

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
                startWorker(acc);
            } catch (e) {
                log('错误', `自动拉起账号 ${  displayName  } 失败: ${  e.message  }`, { accountId: String(accountId) });
            }
        });
    }

    /**
     * 停止账号 Worker
     */
    function stopWorker(accountId) {
        const wrk = workers[accountId];
        if (!wrk) return;

        const targetProc = wrk.process;
        wrk.stopping = true;

        // 发送停止指令
        wrk.process.send({ type: 'stop' });

        // 1 秒后强制杀死
        scheduler.setTimeoutTask(`force_kill_${  accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === targetProc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    /**
     * 重启账号 Worker
     */
    function restartWorker(account) {
        if (!account) return;
        const accountId = account.id;
        const wrk = workers[accountId];

        // 如果未运行，直接启动
        if (!wrk) return startWorker(account);

        const targetProc = wrk.process;
        let restarted = false;

        const doRestart = () => {
            if (restarted) return;
            restarted = true;
            scheduler.clear(`restart_fallback_${  accountId}`);

            const current = workers[accountId];
            if (!current) return startWorker(account);
            if (current.process !== targetProc) return;

            delete workers[accountId];
            startWorker(account);
        };

        const forceKill = () => {
            const current = workers[accountId];
            if (!current || current.process !== targetProc) return false;
            try { current.process.kill(); } catch { }
            delete workers[accountId];
            return true;
        };

        // 如果进程已退出，直接重启
        if (typeof targetProc.exitCode === 'number' || targetProc.signalCode) {
            return doRestart();
        }

        // 先尝试正常停止，再等待退出事件
        targetProc.once('exit', doRestart);
        stopWorker(accountId);

        // 1500ms 超时回退
        scheduler.setTimeoutTask(`restart_fallback_${  accountId}`, 1500, () => {
            if (restarted) return;
            forceKill();
            doRestart();
        });
    }

    /**
     * 处理 Worker 消息
     */
    function handleWorkerMessage(accountId, msg) {
        const wrk = workers[accountId];
        if (!wrk) return;

        if (msg.type === 'status_sync') {
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
            // API 响应
            const { id, result, error } = msg;
            scheduler.clear(`api_timeout_${  accountId  }_${  id}`);

            const pending = wrk.requests.get(id);
            if (pending) {
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
                wrk.requests.delete(id);
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
        if (!wrk) return Promise.reject(new Error('账号未运行'));

        // 检查最后一个参数是否包含 _timeoutMs
        const lastArg = args.at(-1);
        const customTimeout = lastArg && typeof lastArg === 'object' && lastArg._timeoutMs;
        const timeoutMs = customTimeout
            ? Number(lastArg._timeoutMs) || 10000
            : 10000;

        const actualArgs = customTimeout ? args.slice(0, -1) : args;

        return new Promise((resolve, reject) => {
            const reqId = wrk.reqId++;
            wrk.requests.set(reqId, { resolve, reject });

            // API 超时保护
            scheduler.setTimeoutTask(`api_timeout_${  accountId  }_${  reqId}`, timeoutMs, () => {
                if (wrk.requests.has(reqId)) {
                    wrk.requests.delete(reqId);
                    reject(new Error('API Timeout'));
                }
            });

            wrk.process.send({
                type: 'api_call',
                id: reqId,
                method,
                args: actualArgs
            });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi
    };
}

module.exports = { createWorkerManager };
