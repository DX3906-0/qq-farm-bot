const { fork } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { getRuntimeConfig, updateRuntimeConfig } = require('../config/config');
const { sendPushooMessage, sendSmtpEmail } = require('../services/push');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { createAutoCodeRefreshService } = require('./auto-code-refresh');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');

/** 操作类型键列表 */
const OPERATION_KEYS = [
    'harvest', 'water', 'weed', 'bug', 'farming', 'fertilize', 'plant',
    'steal', 'helpWater', 'helpWeed', 'helpBug',
    'taskClaim', 'sell', 'upgrade', 'mysteryMerchant'
];

/**
 * 创建运行时引擎
 * @param {object} options
 * @param {object} options.processRef - process 引用
 * @param {string} options.mainEntryPath - 主入口文件路径
 * @param {string} options.workerScriptPath - Worker 脚本路径
 * @param {string} options.runtimeMode - 运行模式 'thread' | 'fork'
 * @param {Function} options.onStatusSync - 状态同步回调
 * @param {Function} options.onLog - 日志回调
 * @param {Function} options.onAccountLog - 账号日志回调
 * @param {Function} options.startAdminServer - 启动管理服务器回调
 */
function createRuntimeEngine(options = {}) {
    const processRef = options.processRef || process;
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, '../../client.js');
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, '../core/worker.js');
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    // Worker 启动/重启的引用占位
    const engine = { startWorker: null, restartWorker: null };

    // 创建运行时状态
    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS
    });

    const {
        workers,
        globalLogs,
        accountLogs,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs
    } = runtimeState;

    // 创建重登提醒服务
    const reloginReminder = createReloginReminderService({
        store,
        miniProgramLoginSession: MiniProgramLoginSession,
        sendPushooMessage,
        sendSmtpEmail,
        log,
        addAccountLog,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => engine
    });
    const { getOfflineAutoDeleteMs, triggerOfflineReminder } = reloginReminder;

    const autoCodeRefresh = createAutoCodeRefreshService({
        store,
        getAccounts: store.getAccounts,
        addOrUpdateAccount: store.addOrUpdateAccount,
        resolveWorkerControls: () => engine,
        log,
        addAccountLog
    });

    // 创建 Worker 管理器
    const {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi
    } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        store,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        onStatusSync: (accountId, status, accountName) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry, accountId, accountName) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        }
    });

    engine.startWorker = startWorker;
    engine.restartWorker = restartWorker;

    // 创建数据提供器
    const dataProviderDeps = {
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        scheduleAutoCodeRefresh: autoCodeRefresh.scheduleAccount,
        refreshAccountCode: autoCodeRefresh.refreshAccountCode
    };
    const dataProvider = createDataProvider(dataProviderDeps);

    // 绑定全局日志事件
    runtimeEvents.on('log', (entry) => {
        if (onLog) {
            onLog(
                entry,
                entry && entry.accountId ? entry.accountId : '',
                entry && entry.accountName ? entry.accountName : ''
            );
        }
    });

    runtimeEvents.on('account_log', (entry) => {
        if (onAccountLog) onAccountLog(entry);
    });

    /** 广播配置到所有/指定 Worker */
    function broadcastConfigToWorkers(accountId = '') {
        const targetId = String(accountId || '').trim();
        for (const [id, worker] of Object.entries(workers)) {
            if (targetId && String(id) !== targetId) continue;
            const config = buildConfigSnapshotForAccount(id);
            try {
                worker.process.send({ type: 'config_sync', config });
            } catch { }
        }
    }

    /** 启动所有账号 */
    function startAllAccounts() {
        const accounts = store.getAccounts().accounts || [];
        if (accounts.length > 0) {
            log('系统', `发现 ${  accounts.length  } 个账号，正在启动...`);
            accounts.forEach(acc => startWorker(acc));
        } else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    /**
     * 按环境变量恢复指定账号（主容器重启后自动重连）
     *
     * 配合外部网关（FARM_GATEWAY_EXTERNAL=1）使用：网关容器持有 WebSocket，
     * 主容器重启后 worker 重新连入并复用已有连接，不废 Code、无需重新抓包。
     * 非网关模式下慎用——自动启动会用掉一次性 Code。
     *
     * FARM_AUTO_START_ACCOUNTS: 逗号分隔的账号 id（如 "1,2,10"），或 "all" 表示全部
     */
    function resumeConfiguredAccounts() {
        const raw = (process.env.FARM_AUTO_START_ACCOUNTS || '').trim();
        if (!raw) return;
        const accounts = store.getAccounts().accounts || [];
        if (!accounts.length) return;

        let targets;
        if (raw === 'all') {
            targets = accounts;
        } else {
            const ids = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
            targets = accounts.filter(a => ids.has(String(a.id)));
        }
        if (!targets.length) {
            log('系统', `FARM_AUTO_START_ACCOUNTS=${raw} 未匹配到任何账号，跳过自动恢复`);
            return;
        }

        const externalGateway = process.env.FARM_GATEWAY_EXTERNAL === '1';
        log('系统', `将在 3 秒后自动恢复 ${targets.length} 个账号 (${targets.map(a => a.id).join(', ')})${externalGateway ? ' [外部网关模式：复用已有连接]' : ' [警告：非网关模式会消耗 Code]'}`);
        // 延迟启动，等待面板与网关就绪
        setTimeout(() => {
            for (const acc of targets) {
                try {
                    startWorker(acc);
                } catch (err) {
                    log('系统', `自动恢复账号 ${acc.id} 失败: ${err && err.message ? err.message : String(err)}`);
                }
            }
        }, 3000);
    }

    /** 在 gateway 模式下 fork 独立连接网关进程（持有 WebSocket，worker 重启不掉线） */
    let gatewayChild = null;
    let gatewayShuttingDown = false;
    let gatewayRestartTimer = null;
    function startConnectionGateway() {
        return new Promise((resolve) => {
            if (process.env.FARM_NETWORK_MODE !== 'gateway') return resolve();
            const sockPath = process.env.FARM_GATEWAY_SOCK || '/tmp/qq-farm-gateway.sock';
            process.env.FARM_GATEWAY_SOCK = sockPath;
            // 外部网关模式：连接由独立容器持有，本地不 fork 网关进程
            // 这样主容器重启（更新面板代码）不会销毁 WebSocket，账号不掉线
            if (process.env.FARM_GATEWAY_EXTERNAL === '1') {
                log('网关', `使用外部连接网关 (sock=${sockPath})，本地不启动网关进程`);
                resolve();
                return;
            }
            log('网关', `启动连接网关进程 (sock=${sockPath})`);
            gatewayChild = fork(path.join(__dirname, 'gateway-process.js'), [], {
                env: { ...process.env, FARM_GATEWAY_SOCK: sockPath, FARM_GATEWAY_PROCESS: '1' },
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            });
            gatewayChild.on('message', (msg) => {
                if (msg && msg.type === 'gateway_listening') resolve();
            });
            gatewayChild.on('error', (e) => log('网关', `进程错误: ${e.message}`));
            gatewayChild.on('exit', (code) => {
                // 守护：网关是连接持有者，异常退出必须自动拉起，否则所有账号掉线
                log('网关', `进程退出 code=${code}${gatewayShuttingDown ? '' : '，2 秒后自动重启'}`);
                if (gatewayShuttingDown) return;
                if (gatewayRestartTimer) clearTimeout(gatewayRestartTimer);
                gatewayRestartTimer = setTimeout(() => {
                    if (gatewayShuttingDown) return;
                    log('网关', '重新拉起连接网关进程');
                    startConnectionGateway();
                }, 2000);
            });
            setTimeout(() => resolve(), 3000); // 兜底：3s 后继续启动 worker
        });
    }
    // 容器/引擎停止时标记，避免网关退出触发无限重启
    process.on('SIGTERM', () => { gatewayShuttingDown = true; });
    process.on('SIGINT', () => { gatewayShuttingDown = true; });

    /** 引擎启动入口 */
    async function start(startOpts = {}) {
        const shouldStartAdmin = startOpts.startAdminServer !== false;
        const shouldAutoStart = startOpts.autoStartAccounts !== false;

        // 加载系统配置
        const sysConfig = store.getSystemConfig();
        if (sysConfig) {
            updateRuntimeConfig(sysConfig);
            const runtimeSystemConfig = getRuntimeConfig();
            if (runtimeSystemConfig.clientVersion !== sysConfig.clientVersion) {
                store.setSystemConfig({ ...sysConfig, clientVersion: runtimeSystemConfig.clientVersion });
            }
            log('系统', `已加载系统配置: serverUrl=${  sysConfig.serverUrl
                 }, clientVersion=${  runtimeSystemConfig.clientVersion
                 }, platform=${  sysConfig.platform}`);
        }

        if (shouldStartAdmin && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (process.env.FARM_NETWORK_MODE === 'gateway') {
            await startConnectionGateway();
        }
        if (shouldAutoStart) {
            startAllAccounts();
        } else {
            resumeConfiguredAccounts();
        }
        autoCodeRefresh.rescheduleAll();
    }

    /** 停止所有账号 */
    function stopAllAccounts() {
        for (const id of Object.keys(workers)) {
            stopWorker(id);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog
    };
}

module.exports = { createRuntimeEngine };
