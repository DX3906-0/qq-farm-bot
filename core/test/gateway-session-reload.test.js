const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 宿主磁盘只读取声明的源码；VM 无真实 require、环境、存储、网络或进程。
const sourceFiles = {
    client: 'runtime/gateway-client.js',
    gateway: 'runtime/gateway-process.js',
    manager: 'runtime/worker-manager.js',
    engine: 'runtime/runtime-engine.js',
    refresh: 'runtime/auto-code-refresh.js',
    credential: 'services/wx-login/credential-storage.js',
    wxRoutes: 'controllers/admin-wx-login-routes.js',
    wxService: 'services/wx-login/service.js',
    network: 'utils/network.js',
    worker: 'core/worker.js',
    priority: 'utils/request-priority.js',
    health: 'utils/gateway-health.js',
    stats: 'services/stats.js',
    friendApi: 'services/friend-api.js',
    friendSession: 'services/friend-visit-session.js',
    friendVisit: 'services/friend-visit.js',
    friendAnalyzer: 'services/friend-land-analyzer.js',
    friendOrchestrator: 'services/friend-orchestrator.js',
    friendLimits: 'services/friend-operation-limits.js',
    accountBarrier: 'services/account-operation-barrier.js',
    accountCoordinator: 'services/account-operation-coordinator.js',
    interact: 'services/interact.js',
};
const sources = Object.fromEntries(Object.entries(sourceFiles).map(([name, file]) => [
    name, fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'),
]));
const plain = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const forbidden = name => () => { throw new Error(`禁止真实或未声明依赖: ${name}`); };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fakeClock() {
    let now = 1000000;
    let seq = 0;
    const timers = new Map();
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const set = (fn, ms = 0, interval = false) => {
        const id = { id: ++seq, unref: noop };
        timers.set(id, { fn, at: now + ms, ms, interval });
        return id;
    };
    return {
        Date: FakeDate, timers,
        setTimeout: (fn, ms) => set(fn, ms), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => set(fn, ms, true), clearInterval: id => timers.delete(id),
        setImmediate: fn => set(fn, 0), clearImmediate: id => timers.delete(id),
        async advance(ms) {
            const end = now + ms;
            await flush();
            let iterations = 0;
            while (true) {
                const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                assert.ok(++iterations < 500, '模拟时钟不得无限循环');
                const [id, timer] = next;
                now = timer.at;
                if (timer.interval) timer.at += timer.ms;
                else timers.delete(id);
                timer.fn();
                await flush();
            }
            now = end;
            await flush();
        },
    };
}

function fakeProcess(env = {}) {
    const proc = new EventEmitter();
    Object.assign(proc, {
        env: { ...env }, pid: 123, execPath: '/memory/node', exits: [], sent: [],
        uptime: () => 0,
        exit(code) { proc.exits.push(code); },
        send(msg) { proc.sent.push(plain(msg)); },
    });
    return proc;
}

function fakeFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const reads = [];
    const writes = [];
    return new Proxy({
        files, reads, writes,
        existsSync: name => files.has(name),
        readFileSync(name) {
            reads.push(name);
            if (!files.has(name)) throw new Error(`ENOENT 模拟文件不存在: ${name}`);
            return files.get(name);
        },
        writeFileSync(name, text) { files.set(name, String(text)); writes.push(name); },
        mkdirSync: noop,
        unlinkSync(name) { files.delete(name); },
        renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); writes.push(to); },
    }, { get(target, name) { return name in target ? target[name] : forbidden(`fs.${String(name)}`); } });
}

function fakeScheduler(time) {
    const tasks = new Map();
    const calls = [];
    const clear = name => {
        const id = tasks.get(name);
        if (id) time.clearTimeout(id);
        tasks.delete(name);
    };
    const set = (kind, name, ms, fn) => {
        clear(name);
        calls.push({ kind, name, ms });
        const id = kind === 'interval'
            ? time.setInterval(fn, ms)
            : time.setTimeout(() => { tasks.delete(name); return fn(); }, ms);
        tasks.set(name, id);
        return id;
    };
    return {
        tasks, calls, clear,
        clearAll() { for (const name of tasks.keys()) clear(name); },
        setTimeoutTask: (name, ms, fn) => set('timeout', name, ms, fn),
        setIntervalTask: (name, ms, fn) => set('interval', name, ms, fn),
    };
}

function requestPriority(time = fakeClock()) {
    return loadSource('priority', {
        'node:async_hooks': { AsyncLocalStorage: require('node:async_hooks').AsyncLocalStorage },
        'node:crypto': { createHash: require('node:crypto').createHash },
    }, { time }).api;
}

function loadSource(name, mocks, { time = fakeClock(), processRef = fakeProcess(), extra = {}, append = '', transform = source => source } = {}) {
    const module = { exports: {} };
    const context = vm.createContext({
        module, exports: module.exports, Buffer, Error, AbortController, console: { log: noop, warn: noop, error: noop },
        process: processRef, ...time, __dirname: '/memory/src/runtime',
        fetch: forbidden('fetch'), ...extra,
        require(id) {
            if (id === '../services/account-maintenance-hold') return { isAccountMaintenanceHeld: () => extra.maintenanceHeld === true };
            if (!Object.hasOwn(mocks, id)) throw new Error(`禁止真实 require: ${id}`);
            return mocks[id];
        },
    });
    vm.runInContext(transform(sources[name]) + append, context, { filename: sourceFiles[name] });
    return { api: module.exports, context, time, processRef };
}

function loadClient(env = {}, time = fakeClock()) {
    const sockets = [];
    const frames = [];
    const priority = requestPriority(time);
    class Socket extends EventEmitter {
        constructor() { super(); this.destroyed = false; this.destroyCalls = 0; }
        setEncoding() {}
        write(text) {
            assert.equal(this.destroyed, false, '不得向已销毁 IPC 写入');
            frames.push(JSON.parse(text));
        }
        destroy() { this.destroyCalls++; this.destroyed = true; this.emit('close'); }
    }
    const h = loadSource('client', {
        net: { connect() { const socket = new Socket(); sockets.push(socket); return socket; } },
        events: { EventEmitter },
        './gateway-protocol': {
            encodeFrame: JSON.stringify, decodeFrame: JSON.parse,
            toBase64: bytes => Buffer.from(bytes).toString('base64'),
            fromBase64: text => Buffer.from(text, 'base64'),
        },
        '../utils/request-priority': priority,
        '../utils/utils': { log: noop, logWarn: noop },
        '../services/account-operation-barrier': { assertGameRequestAllowed: noop, isSceneRequestOwned: () => false },
    }, { time, processRef: fakeProcess({ FARM_ACCOUNT_ID: '2', ...env }), append: '\n;globalThis.pendingState = { pending, pendingStartedAt };' });
    return { ...h, sockets, frames, priority, pendingState: h.context.pendingState };
}

function loadGateway(time = fakeClock(), maintenanceHeld = false) {
    const storage = fakeFs();
    const mocks = {
        net: { createServer: forbidden('net.createServer') }, fs: storage, path: path.posix,
        ws: class { constructor() { throw new Error('禁止构造游戏 WebSocket'); } },
        '../config/config': { CONFIG: {} },
        '../utils/utils': { log: noop, logWarn: noop },
        '../config/runtime-paths': { getDataDir: () => '/memory/data' },
        '../models/store': { getAccounts: () => ({ accounts: [{ id: '2', platform: 'wx' }] }) },
        './gateway-routing': { readGatewayDelegation: () => null },
        '../utils/gateway-health': loadSource('health', {}, { time }).api,
        '../utils/request-priority': requestPriority(time),
    };
    for (const id of ['../utils/crypto-wasm', '../utils/proto', '../utils/tsdk-runtime', '../services/ace-service', '../utils/gateway-token']) mocks[id] = {};
    const h = loadSource('gateway', mocks, {
        time, append: '\n;globalThis.gatewayApi = { createConn, accounts, handleWorkerFrame, gatewayOwnsAccount };',
        extra: { forbiddenConnect: forbidden('gateway.connect'), maintenanceHeld },
    });
    vm.runInContext('connect = forbiddenConnect;', h.context);
    const api = h.context.gatewayApi;
    const account = api.createConn('2');
    account.platform = 'wx';
    account.savedCode = 'gateway-rotated-code';
    account.userState.gid = 42;
    const ws = { OPEN: 1, readyState: 1, close: forbidden('关闭在线 WS'), terminate: forbidden('终止在线 WS') };
    account.ws = ws;
    api.accounts.set('2', account);
    const frames = [];
    const sock = { destroyed: false, write: text => frames.push(JSON.parse(text)) };
    return { ...h, api, account, ws, sock, frames, storage };
}

const account = (id = '2', code = 'disk-old-code') => ({ id, code, name: `模拟账号${id}`, platform: 'wx', wxid: `memory-wx-${id}` });

function loadManager({ env = { FARM_NETWORK_MODE: 'gateway' }, time = fakeClock(), workers = {}, accounts = [account()], scheduler = fakeScheduler(time), route = null, maintenanceHeld = false } = {}) {
    const children = [];
    function fork(...args) {
        const proc = new EventEmitter();
        proc.forkOptions = args[2];
        Object.assign(proc, { messages: [], killed: 0, send(msg) { proc.messages.push(plain(msg)); }, kill() { proc.killed++; } });
        children.push(proc);
        return proc;
    }
    const store = { getAccounts: () => ({ accounts }), persistInactiveActivityAutomation: () => [] };
    const h = loadSource('manager', {
        '../services/scheduler': { createScheduler: () => scheduler }, '../models/store': store,
        '../utils/request-priority': requestPriority(time),
        './gateway-routing': { resolveAccountGatewaySocket: route || ((_id, environment) => ({ socketPath: environment.FARM_GATEWAY_SOCK, blocked: false, delegated: false })) },
    }, { time, processRef: fakeProcess(env), extra: { maintenanceHeld } });
    const deps = {
        fork, runtimeMode: 'fork', processRef: h.processRef,
        mainEntryPath: '/memory/client.js', workerScriptPath: '/memory/worker.js', workers, globalLogs: [],
        log: noop, addAccountLog: noop, normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({}), getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder: noop, addOrUpdateAccount: noop, deleteAccount: noop,
    };
    return { ...h, api: h.api.createWorkerManager(deps), factory: h.api.createWorkerManager, deps, children, workers, scheduler, store };
}

test('维护停号标记阻止worker及网关建连/续期，但保留只读诊断所有权', () => {
    const manager = loadManager({ maintenanceHeld: true });
    assert.equal(manager.api.startWorker(account()), false);
    assert.equal(manager.children.length, 0);
    const gateway = loadGateway(fakeClock(), true);
    assert.equal(gateway.api.gatewayOwnsAccount('2'), false);
    assert.equal(gateway.api.gatewayOwnsAccount('2', false), true);
});

function loadEngine(env, initial = {}) {
    const time = fakeClock();
    const manager = loadManager({ env, time });
    const storage = fakeFs(initial);
    const accounts = [account('2'), account('9'), account('10')];
    const store = { ...manager.store, getAccounts: () => ({ accounts }), getSystemConfig: () => null };
    const rescheduled = [];
    const h = loadSource('engine', {
        'node:child_process': { fork: manager.deps.fork }, 'node:path': path.posix,
        'node:fs': storage, 'node:process': manager.processRef,
        'node:worker_threads': { Worker: undefined },
        '../config/runtime-paths': { getDataFile: name => `/memory/data/${name}` },
        '../models/store': store, '../config/config': {}, '../services/push': {}, '../services/qrlogin': {},
        './auto-code-refresh': { createAutoCodeRefreshService: () => ({ rescheduleAll: () => rescheduled.push(true), scheduleAccount: noop, refreshAccountCode: noop }) },
        './data-provider': { createDataProvider: () => ({}) },
        './relogin-reminder': { createReloginReminderService: () => ({ getOfflineAutoDeleteMs: () => Infinity, triggerOfflineReminder: noop }) },
        './runtime-state': { createRuntimeState: () => ({
            workers: manager.workers, globalLogs: [], accountLogs: [], runtimeEvents: new EventEmitter(),
            log: noop, addAccountLog: noop, buildConfigSnapshotForAccount: () => ({}),
            normalizeStatusForPanel: value => value,
        }) },
        './worker-manager': { createWorkerManager: manager.factory },
        '../services/scheduler': { createScheduler: () => manager.scheduler },
    }, { time, processRef: manager.processRef });
    const engine = h.api.createRuntimeEngine({ processRef: manager.processRef, runtimeMode: 'fork' });
    return { ...h, api: engine, storage, children: manager.children, scheduler: manager.scheduler, rescheduled };
}

function credentialMemory(initial = {}) {
    const files = new Map(Object.entries(initial));
    const dirs = new Set(['/memory/data/wx-login']);
    const fds = new Map();
    const writes = [];
    let sequence = 0;
    const missing = () => Object.assign(new Error('模拟 ENOENT'), { code: 'ENOENT' });
    const api = {
        files, dirs, writes, failWrite: false, beforeRename: null,
        existsSync: name => files.has(name) || dirs.has(name),
        mkdirSync(name, options) {
            if (dirs.has(name) && !options?.recursive) throw Object.assign(new Error('模拟 EEXIST'), { code: 'EEXIST' });
            dirs.add(name);
        },
        rmdirSync(name) {
            assert.equal([...files.keys()].some(file => path.posix.dirname(file) === name), false);
            assert.ok(dirs.delete(name));
        },
        readdirSync(name) {
            if (!dirs.has(name)) throw missing();
            return [...files.keys()].filter(file => path.posix.dirname(file) === name).map(file => path.posix.basename(file));
        },
        readFileSync(name) { if (!files.has(name)) throw missing(); return files.get(name); },
        readlinkSync: () => { throw missing(); },
        openSync(name, flags, mode) {
            assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
            assert.equal(files.has(name), false);
            files.set(name, ''); fds.set(++sequence, name); return sequence;
        },
        writeFileSync(fd, text) {
            if (api.failWrite) throw new Error('模拟 ENOSPC');
            assert.ok(fds.has(fd), '必须经过 writer 的临时文件');
            files.set(fds.get(fd), String(text));
        },
        fsyncSync: noop,
        closeSync: fd => fds.delete(fd),
        unlinkSync(name) { if (!files.delete(name)) throw missing(); },
        renameSync(from, to) {
            if (api.beforeRename) api.beforeRename();
            files.set(to, files.get(from)); files.delete(from); writes.push(plain(JSON.parse(files.get(to))));
        },
    };
    return api;
}

function loadCredential(storage, time = fakeClock()) {
    return loadSource('credential', { 'node:fs': storage, 'node:crypto': require('node:crypto') }, { time });
}

function loadRefresh(env, accounts = [account('2')], { Service, initial, credentialFs, log = noop } = {}) {
    const time = fakeClock();
    const scheduler = fakeScheduler(time);
    const storage = credentialFs || (Service ? credentialMemory(initial) : fakeFs(initial));
    const fetchCalls = [];
    const restarts = [];
    const updates = [];
    const h = loadSource('refresh', {
        'node-fetch': async (...args) => {
            fetchCalls.push(args);
            return { json: async () => ({ Success: true, Data: { code: 'memory-new-code' } }) };
        },
        fs: storage, path: path.posix, 'node:crypto': require('node:crypto'),
        '../services/scheduler': { createScheduler: () => scheduler },
        '../config/runtime-paths': { getDataDir: () => '/memory/data' },
        '../services/wx-login/service': { WxLoginService: Service },
        '../services/wx-login/credential-storage': loadCredential(storage, time).api,
    }, { time, processRef: fakeProcess(env) });
    const api = h.api.createAutoCodeRefreshService({
        store: { getAutoCodeRefresh: () => ({ enabled: true, intervalMinutes: 1 }), getGlobalWxConfig: () => ({ enabled: true }) },
        getAccounts: () => ({ accounts }), addOrUpdateAccount: acc => updates.push(plain(acc)),
        resolveWorkerControls: () => ({ restartWorker: acc => restarts.push(plain(acc)) }),
        log, addAccountLog: noop,
    });
    return { ...h, api, scheduler, storage, fetchCalls, restarts, updates };
}

function loadNetwork(client, { env = { FARM_NETWORK_MODE: 'gateway', FARM_ACCOUNT_ID: '2' }, workerData = null, status = {} } = {}) {
    const time = client.time;
    const mocks = {
        'node:buffer': { Buffer }, 'node:events': EventEmitter, 'node:process': fakeProcess(env),
        'node:worker_threads': { workerData },
        ws: class { constructor() { throw new Error('禁止 network 真实 WebSocket'); } },
        '../config/config': { CONFIG: {} },
        '../services/scheduler': { createScheduler: () => fakeScheduler(time) },
        './request-priority': client.priority, './utils': { log: noop, logWarn: noop },
        '../runtime/gateway-client': client.api,
        '../services/account-operation-barrier': { assertGameRequestAllowed: noop, isSceneRequestOwned: () => false },
    };
    for (const id of ['../services/ace-service', '../services/status', '../services/stats', './proto', './crypto-wasm', './gateway-token', './tsdk-runtime']) mocks[id] = {};
    mocks['../services/status'] = status;
    return loadSource('network', mocks, { time, processRef: mocks['node:process'] });
}

// 截取真实函数/状态声明，不重写判断；完整 startBot 闭包包含 onReady 初始化。
function sourceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `真实源码片段不存在: ${start}`);
    return source.slice(from, to);
}

function loadWorker(network, time, { mocks = {}, extra: overrides = {}, env = {} } = {}) {
    const processRef = fakeProcess({ FARM_ACCOUNT_ID: '2', ...env });
    const scheduler = fakeScheduler(time);
    const effects = [];
    const extra = {
        CONFIG: {}, parentPort: null, workerScheduler: scheduler,
        getPendingWriteCount: () => 0, quiesceAndDrain: async () => {},
        ...network,
        loadProto: async () => {}, getConfigSnapshot: () => ({}), applyRuntimeConfig: noop,
        initStatusBar: noop, setStatusPlatform: noop, log: noop, syncStatus: noop,
        ranchAutomation: { getRoutineState: () => ({ enabled: false, running: false, nextCheckAt: 0 }) },
        getFriendVisitSessionSnapshot: () => ({ resultState: 'idle', recoveryRequired: false }),
        onKickout: noop, onReconnectFailed: noop,
        saveStats: () => effects.push('saveStats'),
        pauseExpObservations: () => { effects.push('pauseExpObservations'); effects.push('saveStats'); },
        setExpConnectionReady: () => effects.push('setExpConnectionReady'),
        resumeExpObservations: undefined,
        Math: Object.assign(Object.create(Math), { random: () => 0 }),
    };
    for (const name of [
        'stopUnifiedScheduler', 'stopMysteryShopAutoBuyTimer', 'stopEmailClaimTimer',
        'stopDailyReportTimer', 'stopBadHourlyTimer', 'stopPetFoodTimer', 'stopFarmCheckLoop',
        'stopFriendCheckLoop', 'stopDailyRoutineTimer', 'stopStarActivityClaimTimer', 'cleanupTaskSystem',
    ]) extra[name] = () => effects.push(name);
    const required = [];
    const module = { exports: {} };
    const context = vm.createContext({
        module, Buffer, Error, AbortController, process: processRef, ...time, ...extra, ...overrides,
        fetch: forbidden('worker.fetch'),
        require(id) {
            required.push(id);
            if (id === '../services/account-maintenance-hold') return { isAccountMaintenanceHeld: () => extra.maintenanceHeld === true };
            if (!Object.hasOwn(mocks, id)) throw new Error(`禁止真实 require: ${id}`);
            return mocks[id];
        },
        console: { log: noop, warn: noop, error: noop },
    });
    const code = [
        sourceBetween(sources.worker, 'function sendToMaster(message)', '\n// ==================== 日志/统计钩子'),
        sourceBetween(sources.worker, 'let isRunning = false;', '\nconst MILK_TEA_AUTO_ACTIONS'),
        ...(overrides.setRecordGoldExpHook ? [sourceBetween(sources.worker, 'setRecordGoldExpHook(', '\n// ==================== 全局状态')] : []),
        sourceBetween(sources.worker, 'async function startBot(config)', '\nasync function stopBot('),
        sourceBetween(sources.worker, 'async function stopBot(', '\nfunction onKickout('),
        sourceBetween(sources.worker, 'async function handleApiCall(msg)', '\n// ==================== 每日礼包总览'),
        sourceBetween(sources.worker, 'onMasterMessage(async (msg)', '\n// ==================== 每日收益日报'),
        'globalThis.workerApi = { startBot, stopBot, getTransportDiagnostics, state: () => ({ isRunning, loginReady, statsObservationsReady, loginInitializationEpoch, friendSyncPaused, apiControlCount: apiControls.size, statsConnectionPaused }) };',
    ].join('\n');
    vm.runInContext(code, context, { filename: 'core/worker.js（真实函数提取）' });
    const handler = processRef.listeners('message')[0];
    assert.equal(typeof handler, 'function');
    return { api: context.workerApi, context, processRef, scheduler, effects, required, message: handler };
}

// 仅记录 stats API 合约，不实现 stats 算法或加载其磁盘持久化；算法由独立 stats 测试验证。
function loadReadyWorker({ career = async () => ({ gid: 42, exp: 400, level: 8, expAvailable: true }), bag, env = {}, realStats = false } = {}) {
    const client = loadClient();
    const calls = [];
    const readyPromises = [];
    let goldHook;
    let worker;
    const record = (name, ...args) => calls.push({ name, args: plain(args) });
    const dependency = name => (...args) => { record(name, ...args); };
    const asyncDependency = name => async (...args) => { record(name, ...args); };
    const actualStats = realStats ? loadStats(client.time) : null;
    const stats = actualStats ? actualStats.api : {
        initStatsWithPersistence: dependency('stats.init'),
        saveStats: dependency('stats.flush'),
        pauseExpObservations() { record('stats.pause'); stats.saveStats(); },
        recordOperation: dependency('stats.operation'),
        recordGoldExp: dependency('stats.gold'),
        noteExpObservation: dependency('stats.note'),
        setExpConnectionReady: dependency('stats.connectionReady'),
        resumeExpObservations(at) { record('stats.resume', at); return true; },
    };
    const status = {
        updateStatusLevel(level, exp) { record('status.level', level, exp); goldHook(900, exp); },
    };
    const network = loadNetwork(client, { status }).api;
    const wrappedNetwork = {
        ...network,
        connect(code, onReady, options) {
            record('network.connect', code, options);
            // 客户端依旧处理真实 login 帧；只收集真实 onReady 返回的 Promise，避免未处理 rejection。
            network.connect(code, () => {
                const completion = onReady();
                completion.catch(noop);
                readyPromises.push(completion);
            }, options);
        },
        applyUserExpPatch(patch) { record('network.patch', patch); return network.applyUserExpPatch(patch); },
        stopNetwork(reason, options) { record('network.stop', reason, options); return network.stopNetwork(reason, options); },
    };
    const mocks = {
        '../services/stats': stats,
        '../services/friend': { getOperationLimits: () => ({}) },
        '../services/career': { async getCareerInfo(gid) { record('career.query', gid); return career(gid); } },
        '../services/activity': { getQixiEndedState: asyncDependency('activity.warmup') },
        '../services/friend-operation-limits': { restoreHelpExpLimit: dependency('limits.restore') },
        '../services/dog-skill-gifts': { checkAndClaimDogSkillGifts: asyncDependency('dog.claim') },
    };
    const extra = {
        ...stats,
        loadProto: asyncDependency('proto.load'),
        getConfigSnapshot: () => { record('config.snapshot'); return {}; },
        applyRuntimeConfig: dependency('config.apply'),
        initStatusBar: dependency('status.init'), setStatusPlatform: dependency('status.platform'),
        setRecordGoldExpHook(fn) { goldHook = fn; },
        log: dependency('log'), toNum: Number,
        getAutomation: () => ({ fertilizer_gift: true }),
        async getBag() { record('bag.get'); return bag ? bag() : { items: [{ id: 1002, count: 17 }, { id: 1005, count: 23 }] }; },
        getBagItems: value => { record('bag.items'); return value.items; },
        initLocalBadCount: dependency('limits.init'),
        processInviteCodes: asyncDependency('invite.process'),
        openFertilizerGiftPacksSilently: asyncDependency('bag.openGifts'),
        bootstrapQqFriendGids: asyncDependency('friend.bootstrap'),
        runBadOnceOnStartup: asyncDependency('friend.badStartup'),
        sellAllFruits: asyncDependency('bag.sell'),
        runStarActivityAutoClaims: asyncDependency('activity.claim'),
        notifyCodeExpired: asyncDependency('alert.codeExpired'),
        syncStatus: dependency('status.sync'),
        startUnifiedScheduler() { record('startUnifiedScheduler'); vm.runInContext('unifiedSchedulerRunning = true;', worker.context); },
        resetUnifiedSchedule: dependency('resetUnifiedSchedule'),
        scheduleUnifiedNextTick: dependency('scheduleUnifiedNextTick'),
    };
    for (const name of [
        'startFarmCheckLoop', 'startFriendCheckLoop', 'startDailyRoutineTimer', 'startStarActivityClaimTimer',
        'startMysteryShopAutoBuyTimer', 'startEmailClaimTimer', 'startDailyReportTimer', 'startBadHourlyTimer', 'startPetFoodTimer',
        'stopUnifiedScheduler', 'stopMysteryShopAutoBuyTimer', 'stopEmailClaimTimer', 'stopDailyReportTimer',
        'stopBadHourlyTimer', 'stopPetFoodTimer', 'stopFarmCheckLoop', 'stopFriendCheckLoop',
        'stopDailyRoutineTimer', 'stopStarActivityClaimTimer', 'cleanupTaskSystem',
    ]) extra[name] = dependency(name);
    worker = loadWorker(wrappedNetwork, client.time, { mocks, extra, env: { FARM_NETWORK_MODE: 'gateway', ...env } });
    const schedulerSet = worker.scheduler.setTimeoutTask;
    worker.scheduler.setTimeoutTask = (name, ms, ...args) => {
        record('scheduler.timeout', name, ms);
        return schedulerSet(name, ms, ...args);
    };
    return {
        ...worker, client, network, calls, readyPromises, stats, actualStats,
        named: name => calls.filter(call => call.name === name),
        gold: (gold, exp) => goldHook(gold, exp),
        async start(config = {}) {
            await worker.message({ type: 'start', config: { code: 'disk-stale-code', platform: 'wx', resumeSession: true, ...config } });
            assert.deepEqual(worker.processRef.sent.filter(msg => msg.type === 'error'), [], '真实 startBot 不得吞错');
            assert.deepEqual(worker.scheduler.calls, [{ kind: 'interval', name: 'status_sync', ms: 5000 }]);
        },
        login(userState = {}) {
            const before = readyPromises.length;
            client.sockets.at(-1).emit('data', JSON.stringify({ t: 'login', accountId: '2', userState: {
                gid: 42, exp: 100, level: 3, gold: 900, coupon: 0, goldBean: 0, ...userState,
            } }) + '\n');
            assert.equal(readyPromises.length, before + 1, 'login 必须执行真实 onReady');
            return readyPromises.at(-1);
        },
        event(name, payload) {
            client.sockets.at(-1).emit('data', JSON.stringify({ t: 'event', accountId: '2', name, payload }) + '\n');
        },
    };
}

test('detach：已有 IPC 仅销毁，拒绝在途请求并清除 pending timer，不发送 stop 或重新连接', async () => {
    const h = loadClient();
    h.api.connect('2', 'disk-old-code', noop);
    h.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', userState: { gid: 42 } }) + '\n');
    assert.equal(h.api.isConnected(), true);
    let disconnects = 0;
    h.api.networkEvents.on('disconnect', () => { disconnects++; });
    const pending = h.api.sendMsgAsync('farm', 'GetAllLands', Buffer.from('memory'));
    const rejected = assert.rejects(pending, /脱离网关|会话保持/);
    await flush();
    assert.equal(h.pendingState.pending.size, 1);
    assert.equal(h.time.timers.size, 1);
    const before = h.frames.length;
    h.api.detach();
    await rejected;
    h.api.detach();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].destroyCalls, 1);
    assert.equal(h.frames.length, before);
    assert.ok(!h.frames.some(frame => frame.t === 'stop'));
    assert.equal(h.api.isConnected(), false);
    assert.equal(disconnects, 0);
    assert.equal(h.pendingState.pending.size, 0);
    assert.equal(h.pendingState.pendingStartedAt.size, 0);
    assert.equal(h.time.timers.size, 0);
    assert.equal(h.api.getRequestQueueSnapshot().active, 0);
});

test('detach：未连接时不得创建 IPC，后续业务请求不得偷偷新连', async () => {
    const h = loadClient();
    h.api.detach();
    await assert.rejects(h.api.sendMsgAsync('farm', 'GetAllLands', Buffer.alloc(0)), /连接不可用/);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.frames.length, 0);
    assert.equal(h.time.timers.size, 0);
});

test('客户端拒绝空gid的login帧，真实断线事件清除在线标志', () => {
    const h = loadClient(); h.api.connect('2', 'unused', noop);
    for (const userState of [undefined, {}, { gid: 0 }, { gid: -1 }, { gid: 'bad' }]) {
        h.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', userState }) + '\n');
        assert.equal(h.api.isConnected(), false);
    }
    h.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', userState: { gid: 42 } }) + '\n');
    assert.equal(h.api.isConnected(), true);
    h.sockets[0].emit('data', JSON.stringify({ t: 'event', name: 'disconnect', payload: { code: 1006 } }) + '\n');
    assert.equal(h.api.isConnected(), false);
});

test('显式 stop：已有 IPC 发送账号 stop 并 detach；detach 后不得隐式重连，显式 connect 后仍可 stop', () => {
    const h = loadClient();
    h.api.connect('2', 'disk-old-code', noop);
    h.api.stop('2');
    assert.deepEqual(h.frames.at(-1), { t: 'stop', accountId: '2' });
    assert.equal(h.sockets.length, 1);
    h.api.detach();
    const before = h.frames.length;
    h.api.stop('2');
    assert.equal(h.sockets.length, 1);
    assert.equal(h.frames.length, before);
    assert.equal(h.sockets[0].destroyed, true);
    h.api.connect('2', 'manual-new-code', noop);
    h.api.stop('2');
    assert.equal(h.sockets.length, 2);
    assert.deepEqual(h.frames.at(-1), { t: 'stop', accountId: '2' });
});

test('resumeSession connect：省略 code 但保留 accountId，人工 newCode 仍带 code', () => {
    const h = loadClient();
    h.api.connect(2, 'disk-stale-code', noop, { resumeSession: true });
    assert.equal(h.frames[0].accountId, '2');
    assert.equal(Object.hasOwn(h.frames[0], 'code'), false);
    assert.equal(h.frames[1].t, 'ping');
    h.api.connect('2', 'manual-new-code', noop);
    assert.equal(h.frames[2].code, 'manual-new-code');
    assert.equal(h.frames[2].accountId, '2');
});

test('resumeSession 只接受布尔 true，普通连接不能意外丢失人工 code', () => {
    const h = loadClient();
    h.api.connect('2', 'manual-new-code', noop, { resumeSession: 'true' });
    assert.equal(h.frames[0].code, 'manual-new-code');
});

test('真实 handleWorkerFrame：liveWs 无 incomingCode 只返 login，不 connect/关闭 WS/读凭据', async () => {
    const h = loadGateway();
    h.account.heartbeatTimer = h.time.setInterval(noop, 10000);
    const heartbeat = h.account.heartbeatTimer;
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    assert.deepEqual(h.frames, [{ t: 'login', accountId: '2', userState: plain(h.account.userState), connectionEpoch: h.account.connectionEpoch }]);
    assert.equal(h.account.ws, h.ws);
    assert.equal(h.account.workerSock, h.sock);
    assert.equal(h.account.savedCode, 'gateway-rotated-code');
    assert.equal(h.account.networkStopped, false);
    assert.equal(h.account.heartbeatTimer, heartbeat);
    assert.ok(h.time.timers.has(heartbeat));
    assert.deepEqual(h.storage.reads, []);
    assert.deepEqual(h.storage.writes, []);
});

for (const env of [
    { FARM_NETWORK_MODE: 'gateway' },
    { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_ACCOUNTS: ' 10, 2 ' },
]) {
    test(`restartWorker 同 code：stop preserveSession，exit 后 start resumeSession（列表=${env.FARM_GATEWAY_ACCOUNTS || '全部'}）`, async () => {
        const h = loadManager({ env });
        h.api.startWorker(account());
        const old = h.children[0];
        h.api.restartWorker(account());
        assert.deepEqual(old.messages.at(-1), { type: 'stop', preserveSession: true });
        assert.equal(h.children.length, 1, '必须等待旧 worker 退出');
        old.emit('exit', 0, null);
        await flush();
        assert.equal(h.children.length, 2);
        assert.deepEqual(h.children[1].messages[0].config, {
            code: 'disk-old-code', platform: 'wx', loginType: 'manual', resumeSession: true,
        });
        assert.ok(!h.scheduler.tasks.has('force_kill_2'));
        assert.ok(!h.scheduler.tasks.has('restart_fallback_2'));
        assert.ok(!h.scheduler.tasks.has('auto_restart_2'));
        assert.equal(old.killed, 0);
    });
}

test('委托账号只覆盖自己的fork Socket，排空阻止启动，QQ环境不变', () => {
    const env = { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_SOCK: '/sock/qq-farm-gateway.sock', FARM_GATEWAY_ACCOUNTS: '1,2,10' };
    let phase = 'draining';
    const h = loadManager({ env, route: (id, e) => String(id) === '2'
        ? { blocked: phase !== 'active', delegated: true, socketPath: '/sock/qq-farm-wx.sock' }
        : { blocked: false, delegated: false, socketPath: e.FARM_GATEWAY_SOCK } });
    assert.equal(h.api.startWorker(account('2')), false);
    assert.equal(h.children.length, 0);
    phase = 'active';
    h.api.startWorker(account('2'));
    assert.equal(h.children[0].forkOptions.env.FARM_GATEWAY_SOCK, '/sock/qq-farm-wx.sock');
    h.api.startWorker({ ...account('1'), platform: 'qq' });
    assert.equal(h.children[1].forkOptions.env.FARM_GATEWAY_SOCK, env.FARM_GATEWAY_SOCK);
    assert.equal(env.FARM_GATEWAY_SOCK, '/sock/qq-farm-gateway.sock');
});

test('restartWorker 人工 newCode：保留退出前会话，但新启动不 resume', async () => {
    const h = loadManager();
    h.api.startWorker(account());
    h.api.restartWorker(account('2', 'manual-new-code'));
    assert.equal(h.children[0].messages.at(-1).preserveSession, true);
    h.children[0].emit('exit', 0, null);
    await flush();
    assert.equal(h.children[1].messages[0].config.code, 'manual-new-code');
    assert.equal(h.children[1].messages[0].config.resumeSession, false);
});

test('restartWorker 显式 replaceSession：同 code 也不 resume', async () => {
    const h = loadManager();
    h.api.startWorker(account());
    h.api.restartWorker(account(), { replaceSession: true });
    h.children[0].emit('exit', 0, null);
    await flush();
    assert.equal(h.children[1].messages[0].config.resumeSession, false);
});

test('restartWorker 强杀回退：只拉起一次，并恢复同 code 会话', async () => {
    const h = loadManager();
    h.api.startWorker(account());
    h.api.restartWorker(account());
    const old = h.children[0];
    await h.time.advance(130000);
    assert.equal(old.killed, 0); assert.equal(h.children.length, 1);
    await h.time.advance(30000);
    assert.equal(old.killed, 1);
    assert.equal(h.children.length, 2);
    assert.equal(h.children[1].messages[0].config.resumeSession, true);
    old.emit('exit', 0, null);
    assert.equal(h.children.length, 2, '迟到 exit 不能再拉起第三个 worker');
});

test('restartWorker 非 gateway：stop 不 preserve，start 不 resume', async () => {
    const h = loadManager({ env: { FARM_NETWORK_MODE: 'local' } });
    h.api.startWorker(account());
    h.api.restartWorker(account());
    assert.equal(h.children[0].messages.at(-1).preserveSession, false);
    h.children[0].emit('exit', 0, null);
    await flush();
    assert.equal(h.children[1].messages[0].config.resumeSession, false);
});

test('restartWorker 灰度列表外账号：同 code 不得 resume', async () => {
    const h = loadManager({ env: { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_ACCOUNTS: '10' } });
    h.api.startWorker(account());
    h.api.restartWorker(account());
    h.children[0].emit('exit', 0, null);
    await flush();
    assert.equal(h.children[1].messages[0].config.resumeSession, false);
});

test('stopWorker 用户默认/显式 false：均发送 preserveSession false 且不自动拉起', () => {
    for (const options of [undefined, { preserveSession: false }]) {
        const h = loadManager();
        h.api.startWorker(account());
        h.api.stopWorker('2', options);
        assert.deepEqual(h.children[0].messages.at(-1), { type: 'stop', preserveSession: false });
        h.children[0].emit('exit', 0, null);
        assert.equal(h.children.length, 1);
        assert.equal(Object.keys(h.workers).length, 0);
        assert.ok(!h.scheduler.tasks.has('auto_restart_2'));
    }
});

const externalEnv = { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_EXTERNAL: '1', FARM_AUTO_START_ACCOUNTS: '' };
const resumeFile = '/memory/data/deployment-resume.json';
const resumeRecord = ids => JSON.stringify({ accountIds: ids, expiresAt: 2000000 });

test('runtime-engine：deployment-resume + 空 env 仅恢复记录在线 ID，不启动已停用 ID', async () => {
    const h = loadEngine(externalEnv, { [resumeFile]: resumeRecord([2, '10', 'missing']) });
    await h.api.start({ startAdminServer: false, autoStartAccounts: false });
    assert.equal(h.children.length, 0);
    await h.time.advance(3000);
    assert.deepEqual(Object.keys(h.api.workers).sort(), ['10', '2']);
    assert.ok(!h.api.workers['9'], '未在在线恢复集合内的停用账号不能被启动');
    assert.equal(h.children.length, 2, '外部网关不 fork 新的 gateway');
    for (const child of h.children) assert.equal(child.messages[0].config.resumeSession, true);
    assert.deepEqual(h.storage.reads, [resumeFile]);
    assert.deepEqual(h.storage.writes, [], '恢复文件只能读取，不能写凭据或删除个人数据');
    assert.equal(h.storage.files.size, 1);
    assert.equal(h.rescheduled.length, 1);
});

test('runtime-engine：有效部署记录优先于 env，空在线集合不变成 all', async () => {
    const h = loadEngine({ ...externalEnv, FARM_AUTO_START_ACCOUNTS: 'all' }, { [resumeFile]: resumeRecord([]) });
    await h.api.start({ autoStartAccounts: false });
    await h.time.advance(3000);
    assert.equal(h.children.length, 0);
});

test('runtime-engine：过期部署记录回退指定 env，外部 gateway 恢复仍 resume', async () => {
    const h = loadEngine({ ...externalEnv, FARM_AUTO_START_ACCOUNTS: '10' }, {
        [resumeFile]: JSON.stringify({ accountIds: ['2'], expiresAt: 999999 }),
    });
    await h.api.start({ autoStartAccounts: false });
    await h.time.advance(3000);
    assert.deepEqual(Object.keys(h.api.workers), ['10']);
    assert.equal(h.children[0].messages[0].config.resumeSession, true);
});

test('runtime-engine：非外部网关不读取部署记录，空 env 不恢复账号', async () => {
    const h = loadEngine({ FARM_NETWORK_MODE: 'local', FARM_AUTO_START_ACCOUNTS: '' }, { [resumeFile]: resumeRecord(['2']) });
    await h.api.start({ autoStartAccounts: false });
    await h.time.advance(3000);
    assert.equal(h.children.length, 0);
    assert.deepEqual(h.storage.reads, []);
});

for (const [label, env, preserveSession] of [
    ['外部 gateway', externalEnv, true],
    ['内置 gateway', { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_EXTERNAL: '0' }, false],
    ['local', { FARM_NETWORK_MODE: 'local' }, false],
]) {
    test(`runtime-engine SIGTERM/SIGINT：${label} preserveSession=${preserveSession}，只关闭一次业务`, async () => {
        const h = loadEngine(env);
        h.api.startWorker(account());
        h.processRef.emit('SIGTERM');
        h.processRef.emit('SIGINT');
        assert.deepEqual(h.children[0].messages.filter(msg => msg.type === 'stop'), [{ type: 'stop', preserveSession }]);
        assert.deepEqual(h.processRef.exits, []);
        h.children[0].emit('exit', 0, null);
        await h.time.advance(1200);
        assert.deepEqual(h.processRef.exits, [0]);
        assert.deepEqual(h.storage.reads, []);
        assert.deepEqual(h.storage.writes, []);
    });
}

test('runtime-engine 用户 stopAllAccounts：外部 gateway 也必须 preserveSession false', () => {
    const h = loadEngine(externalEnv);
    h.api.startWorker(account());
    h.api.stopAllAccounts();
    assert.deepEqual(h.children[0].messages.at(-1), { type: 'stop', preserveSession: false });
});

for (const gatewayIds of [undefined, ' 10, 2 ']) {
    test(`auto-code-refresh 实际 gateway：不 fetch/restart/写存储/排 timer（列表=${gatewayIds || '全部'}）`, async () => {
        const env = { FARM_NETWORK_MODE: 'gateway' };
        if (gatewayIds !== undefined) env.FARM_GATEWAY_ACCOUNTS = gatewayIds;
        const h = loadRefresh(env);
        h.api.scheduleAccount('2');
        h.api.rescheduleAll();
        assert.equal(await h.api.refreshAccountCode('2', 'manual'), false);
        await h.time.advance(120000);
        assert.equal(h.fetchCalls.length, 0);
        assert.equal(h.restarts.length, 0);
        assert.equal(h.updates.length, 0);
        assert.equal(h.scheduler.calls.length, 0);
        assert.equal(h.time.timers.size, 0);
        assert.deepEqual(h.storage.reads, []);
        assert.deepEqual(h.storage.writes, []);
    });
}

for (const [label, env] of [
    ['local', { FARM_NETWORK_MODE: 'local' }],
    ['gateway 灰度列表外', { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_ACCOUNTS: '10' }],
]) {
    test(`auto-code-refresh ${label}：保留原定时、本机缺失后远程 fake fetch 与 restart 路径`, async () => {
        const h = loadRefresh(env);
        h.api.scheduleAccount('2');
        assert.equal(h.scheduler.tasks.size, 1);
        await h.time.advance(60000);
        assert.equal(h.fetchCalls.length, 1);
        assert.equal(h.restarts.length, 1);
        assert.equal(h.updates[0].code, 'memory-new-code');
        assert.equal(h.restarts[0].code, 'memory-new-code');
        assert.equal(h.fetchCalls[0][1].method, 'POST');
        assert.equal(JSON.parse(h.fetchCalls[0][1].body).Wxid, 'memory-wx-2');
        h.api.stopAccount('2');
        assert.equal(h.time.timers.size, 0);
    });
}

test('utils/network 真实导出：转发 connectionOptions/accountId，preserveSession 分流 detach 与 stop', () => {
    const client = loadClient();
    const network = loadNetwork(client).api;
    network.connect('disk-old-code', noop, { resumeSession: true });
    assert.equal(client.frames[0].accountId, '2');
    assert.equal(Object.hasOwn(client.frames[0], 'code'), false);
    network.stopNetwork('业务重载', { preserveSession: true });
    assert.equal(client.sockets[0].destroyed, true);
    assert.ok(!client.frames.some(frame => frame.t === 'stop'));
    network.connect('manual-new-code', noop, { resumeSession: false });
    assert.equal(client.frames.find(frame => frame.code === 'manual-new-code').accountId, '2');
    network.stopNetwork('用户停止', { preserveSession: false });
    assert.deepEqual(client.frames.at(-1), { t: 'stop', accountId: '2' });
});

test('utils/network thread workerData：加载时确定 ID，恢复帧保留 thread 的 accountId', () => {
    const client = loadClient();
    const network = loadNetwork(client, {
        env: { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_ACCOUNTS: '10' }, workerData: { accountId: '10' },
    }).api;
    network.connect('disk-old-code', noop, { resumeSession: true });
    assert.equal(client.frames[0].accountId, '10');
    assert.equal(Object.hasOwn(client.frames[0], 'code'), false);
});

test('worker 真实 IPC → startBot → utils/network → client → gateway：恢复不带 code，在线 WS 只返 login', async () => {
    const client = loadClient();
    const network = loadNetwork(client).api;
    const worker = loadWorker(network, client.time);
    const gateway = loadGateway(client.time);
    await worker.message({ type: 'start', config: { code: 'disk-stale-code', platform: 'wx', resumeSession: true } });
    assert.equal(worker.processRef.sent.length, 0, '不能用 worker catch 吞错冒充成功');
    assert.equal(client.frames[0].accountId, '2');
    assert.equal(Object.hasOwn(client.frames[0], 'code'), false);
    await gateway.api.handleWorkerFrame(gateway.sock, client.frames[0]);
    assert.equal(gateway.frames.length, 1);
    assert.equal(gateway.frames[0].t, 'login');
    assert.equal(gateway.account.ws, gateway.ws);
    await worker.message({ type: 'stop', preserveSession: true });
    assert.ok(!client.frames.some(frame => frame.t === 'stop'));
    assert.equal(client.sockets[0].destroyed, true);
    assert.ok(worker.effects.includes('saveStats'));
    assert.ok(worker.effects.includes('stopFarmCheckLoop'));
    assert.equal(worker.scheduler.tasks.size, 0);
    await client.time.advance(0);
    assert.deepEqual(worker.processRef.exits, [0]);
});

test('worker 真实重连闭包：重发 connect 仍转发 resumeSession，stop 清掉重连与 watchdog timer', async () => {
    const client = loadClient();
    const worker = loadWorker(loadNetwork(client).api, client.time);
    await worker.message({ type: 'start', config: { code: 'disk-stale-code', platform: 'wx', resumeSession: true } });
    vm.runInContext('loginReady = true;', worker.context);
    client.api.networkEvents.emit('disconnect');
    assert.ok(worker.effects.includes('pauseExpObservations'), '断线必须即时保存并暂停经验观测');
    await client.time.advance(1000);
    const connects = client.frames.filter(frame => frame.t === 'connect');
    assert.equal(connects.length, 2);
    for (const frame of connects) assert.equal(Object.hasOwn(frame, 'code'), false);
    assert.ok([...client.time.timers.values()].some(timer => timer.ms === 25000));
    await worker.message({ type: 'stop', preserveSession: true });
    await client.time.advance(60000);
    assert.equal(client.frames.filter(frame => frame.t === 'connect').length, 2);
    assert.equal(client.time.timers.size, 0);
    assert.deepEqual(worker.processRef.sent, [{ type: 'worker_quiescing', pendingWrites: 0, maxDrainMs: 155000 }]);
});

test('manager → worker → network → client：同 code 重载 stop 只 detach，exit 后 resume 不发旧 code', async () => {
    const manager = loadManager();
    manager.api.startWorker(account());
    const oldClient = loadClient();
    const oldWorker = loadWorker(loadNetwork(oldClient).api, oldClient.time);
    await oldWorker.message(manager.children[0].messages[0]);
    manager.api.restartWorker(account());
    await oldWorker.message(manager.children[0].messages.at(-1));
    assert.equal(oldClient.sockets[0].destroyed, true);
    assert.ok(!oldClient.frames.some(frame => frame.t === 'stop'));
    await oldClient.time.advance(0);
    assert.deepEqual(oldWorker.processRef.exits, [0]);
    manager.children[0].emit('exit', 0, null);
    await flush();
    const newClient = loadClient();
    const newWorker = loadWorker(loadNetwork(newClient).api, newClient.time);
    await newWorker.message(manager.children[1].messages[0]);
    assert.equal(newClient.frames[0].t, 'connect');
    assert.equal(newClient.frames[0].accountId, '2');
    assert.equal(Object.hasOwn(newClient.frames[0], 'code'), false);
    assert.equal(newWorker.processRef.sent.length, 0);
    assert.deepEqual(oldWorker.processRef.sent, [{ type: 'worker_quiescing', pendingWrites: 0, maxDrainMs: 155000 }]);
});

function pendingReply() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function assertReadyStartup(h) {
    assert.deepEqual(h.named('stats.init').map(call => call.args[0]), ['2']);
    assert.equal(h.named('limits.init').length, 1);
    assert.equal(h.named('limits.restore').length, 1);
    assert.equal(h.named('invite.process').length, 1);
    assert.equal(h.named('bag.openGifts').length, 1);
    assert.deepEqual(h.named('startFarmCheckLoop')[0].args, [{ externalScheduler: true }]);
    assert.deepEqual(h.named('startFriendCheckLoop')[0].args, [{ externalScheduler: true }]);
    for (const name of [
        'startUnifiedScheduler', 'startDailyRoutineTimer', 'startStarActivityClaimTimer', 'startMysteryShopAutoBuyTimer',
        'startEmailClaimTimer', 'startDailyReportTimer', 'startBadHourlyTimer', 'startPetFoodTimer', 'status.sync',
    ]) assert.equal(h.named(name).length, 1, `必须执行到启动末尾: ${name}`);
    assert.deepEqual(h.scheduler.calls.map(call => call.name), ['status_sync', 'bad_startup_once']);
    assert.equal(h.api.state().statsObservationsReady, true);
    assert.equal(h.calls.at(-1).name, 'status.sync');
    assert.equal(h.client.frames.filter(frame => frame.t === 'request').length, 0, '所有业务依赖均为内存 mock');
    assert.deepEqual(h.processRef.sent.filter(msg => msg.type === 'error'), []);
}

async function stopReadyWorker(h) {
    const before = h.calls.length;
    await h.message({ type: 'stop', preserveSession: true });
    const stopped = h.calls.slice(before);
    assert.deepEqual(stopped.slice(0, 2).map(call => call.name), ['stats.pause', 'stats.flush'], '停止必须先暂停并同步 flush');
    assert.deepEqual(h.named('network.stop').at(-1).args, ['业务重载', { preserveSession: true }]);
    assert.equal(h.client.sockets.at(-1).destroyed, true);
    assert.ok(!h.client.frames.some(frame => frame.t === 'stop'), '保留网关会话不能发送 stop 帧');
    assert.equal(h.scheduler.tasks.size, 0);
    assert.equal(h.network.networkEvents.listenerCount('experienceObserved'), 0);
    assert.equal(h.api.state().statsObservationsReady, false);
    await h.client.time.advance(0);
    assert.deepEqual(h.processRef.exits, [0]);
}

test('worker 完整 onReady：旧 login exp 低于已存余额，查询自身 42/400 → 真实 patch → snapshotOnly=false init → 启动末尾', async () => {
    const persisted = { confirmed: { exp: 350 }, intervals: [{ start: 970000, end: 990000, gain: 50 }] };
    const h = loadReadyWorker();
    h.gold(900, 100);
    assert.equal(h.named('stats.gold').length, 0, '未启动时不能记录缓存');
    await h.start();
    assert.equal(Object.hasOwn(h.client.frames[0], 'code'), false);
    const ready = h.login();
    assert.equal(h.network.getUserState().exp, 100);
    assert.ok(h.network.getUserState().exp < persisted.confirmed.exp);
    await ready;
    assert.deepEqual(h.named('career.query').map(call => call.args), [[42]]);
    assert.deepEqual(h.named('network.patch').map(call => call.args), [[{ exp: 400, level: 8 }]]);
    assert.deepEqual(h.named('stats.init').map(call => call.args), [['2', 900, 400, 17, 23, { snapshotOnly: false }]]);
    assert.equal(h.network.getUserState().gid, 42, '使用真实网关状态对象，不伪造只读 gid');
    assert.equal(h.network.getUserState().exp, 400);
    assert.equal(h.network.getUserState().level, 8);
    assert.equal(h.named('activity.warmup').length, 1);
    assert.equal(h.named('status.level').length, 1, '真实 applyUserExpPatch 必须触发 status hook');
    assert.equal(h.named('stats.gold').length, 0, 'patch 在 stats init 前不能记录旧缓存');
    assert.equal(h.named('stats.note').length, 0, 'patch/status hook 不是实际经验观测事件');
    const names = h.calls.map(call => call.name);
    assert.ok(names.indexOf('career.query') < names.indexOf('network.patch'));
    assert.ok(names.indexOf('network.patch') < names.indexOf('stats.init'));
    assert.ok(names.indexOf('stats.init') < names.indexOf('startFarmCheckLoop'));
    assertReadyStartup(h);
    h.gold(901, 400);
    assert.deepEqual(h.named('stats.gold').map(call => call.args), [[901, 400]]);
    assert.equal(h.named('stats.note').length, 0, 'gold hook 不调用 noteExpObservation');
    assert.deepEqual(h.required, ['../services/stats', '../services/activity', '../services/career', '../services/stats', '../services/friend-operation-limits', '../services/stats']);
    await stopReadyWorker(h);
});

for (const [label, response] of [
    ['query false', false],
    ['expAvailable false', { gid: 42, exp: 400, level: 8, expAvailable: false }],
    ['corrupt exp', { gid: 42, exp: 'corrupt', level: 8, expAvailable: true }],
    ['negative exp', { gid: 42, exp: -1, expAvailable: true }],
    ['unsafe exp', { gid: 42, exp: Number.MAX_SAFE_INTEGER + 1, expAvailable: true }],
    ['mismatched gid', { gid: 99, exp: 400, level: 8, expAvailable: true }],
    ['query rejected', new Error('模拟 CareerQuery 失败，无网络')],
]) {
    test(`worker 完整 onReady：${label} 只传 snapshotOnly=true 保留历史合约，不 patch 旧 login，仍执行启动末尾`, async () => {
        const h = loadReadyWorker({ career: async () => { if (response instanceof Error) throw response; return response; } });
        await h.start();
        await h.login();
        assert.deepEqual(h.named('career.query').map(call => call.args), [[42]]);
        assert.equal(h.named('network.patch').length, 0);
        assert.equal(h.network.getUserState().exp, 100);
        // 历史不重置由真实 stats 的 snapshotOnly 合约保证，这里仅验证集成传参，不复制清历史算法。
        assert.deepEqual(h.named('stats.init').map(call => call.args), [['2', 900, 100, 17, 23, { snapshotOnly: true }]]);
        assert.equal(h.named('stats.note').length, 0);
        assert.equal(h.named('log').filter(call => call.args[0] === '统计').length, 1);
        assertReadyStartup(h);
        await stopReadyWorker(h);
    });
}

for (const interruptedBy of ['disconnect', 'stop', 'gid changed']) {
    for (const rejected of interruptedBy === 'gid changed' ? [false] : [false, true]) {
        test(`worker CareerQuery await：${interruptedBy} 后迟到${rejected ? '拒绝' : '成功'}回包不得 patch/init/启动业务任务`, async () => {
            const deferred = pendingReply();
            const h = loadReadyWorker({ career: () => deferred.promise });
            await h.start();
            const ready = h.login();
            await flush();
            assert.equal(h.named('career.query').length, 1);
            assert.equal(h.api.state().loginReady, true);
            assert.equal(h.api.state().statsObservationsReady, false);
            const epoch = h.api.state().loginInitializationEpoch;
            h.gold(950, 100);
            h.event('experienceObserved', { gid: 42, exp: 400, at: 1000001 });
            assert.equal(h.named('stats.gold').length, 0);
            assert.equal(h.named('stats.note').length, 0);
            const beforeInterrupt = h.calls.length;
            if (interruptedBy === 'disconnect') h.event('disconnect', { code: 1006 });
            else if (interruptedBy === 'stop') await h.message({ type: 'stop', preserveSession: true });
            else h.network.getUserState().gid = 99;
            if (interruptedBy !== 'gid changed') {
                assert.ok(h.api.state().loginInitializationEpoch > epoch);
                assert.deepEqual(h.calls.slice(beforeInterrupt, beforeInterrupt + 2).map(call => call.name), ['stats.pause', 'stats.flush']);
            }
            if (rejected) deferred.reject(new Error('模拟迟到查询拒绝'));
            else deferred.resolve({ gid: 42, exp: 400, level: 8, expAvailable: true });
            await ready;
            assert.equal(h.named('network.patch').length, 0);
            assert.equal(h.named('stats.init').length, 0);
            assert.equal(h.named('invite.process').length, 0);
            assert.equal(h.calls.filter(call => call.name.startsWith('start')).length, 0);
            assert.equal(h.named('scheduler.timeout').length, 0, '不启动 bad_startup_once 等业务任务');
            assert.equal(h.api.state().statsObservationsReady, false);
            assert.equal(h.network.getUserState().exp, 100);
            assert.ok(!h.client.frames.some(frame => frame.t === 'stop'));
            if (interruptedBy !== 'stop') await stopReadyWorker(h);
            else {
                assert.deepEqual(h.named('network.stop')[0].args, ['业务重载', { preserveSession: true }]);
                assert.equal(h.scheduler.tasks.size, 0);
                await h.client.time.advance(0);
                assert.deepEqual(h.processRef.exits, [0]);
            }
            assert.equal(h.client.time.timers.size, 0);
        });
    }
}

test('worker 重连 epoch：新 onReady 完成后，旧 CareerQuery 回包不得覆盖新 patch/init 或重复启动任务', async () => {
    const oldReply = pendingReply();
    const newReply = pendingReply();
    let queries = 0;
    const h = loadReadyWorker({ career: () => ++queries === 1 ? oldReply.promise : newReply.promise });
    await h.start();
    const oldReady = h.login();
    await flush();
    const oldEpoch = h.api.state().loginInitializationEpoch;
    h.event('disconnect', { code: 1006 });
    await h.client.time.advance(1000);
    assert.equal(h.client.frames.filter(frame => frame.t === 'connect').length, 2);
    const newReady = h.login();
    await flush();
    assert.ok(h.api.state().loginInitializationEpoch > oldEpoch);
    assert.deepEqual(h.named('career.query').map(call => call.args), [[42], [42]]);
    newReply.resolve({ gid: 42, exp: 500, level: 9, expAvailable: true });
    await newReady;
    const afterNewReady = h.calls.length;
    oldReply.resolve({ gid: 42, exp: 400, level: 8, expAvailable: true });
    await oldReady;
    assert.equal(h.calls.length, afterNewReady, '旧 epoch 成功回包必须直接丢弃');
    assert.deepEqual(h.named('network.patch').map(call => call.args), [[{ exp: 500, level: 9 }]]);
    assert.deepEqual(h.named('stats.init').map(call => call.args), [['2', 900, 500, 17, 23, { snapshotOnly: false }]]);
    assert.equal(h.network.getUserState().exp, 500);
    assertReadyStartup(h);
    await stopReadyWorker(h);
    assert.equal(h.client.time.timers.size, 0);
});

test('worker Bag await：断线立即改变 epoch，旧初始化连 CareerQuery 都不能发起', async () => {
    const deferred = pendingReply();
    const h = loadReadyWorker({ bag: () => deferred.promise });
    await h.start();
    const ready = h.login();
    await flush();
    h.event('disconnect', { code: 1006 });
    deferred.resolve({ items: [] });
    await ready;
    assert.equal(h.named('career.query').length, 0);
    assert.equal(h.named('stats.init').length, 0);
    assert.equal(h.named('network.patch').length, 0);
    assert.equal(h.calls.filter(call => call.name.startsWith('start')).length, 0);
    await stopReadyWorker(h);
});

test('微信需扫码建议保留真实payload，不误说网关停止或需要抓包', async () => {
    const h = loadReadyWorker();
    await h.start();
    await h.login();
    h.event('code_invalid', { reason: 'wx_buffer_auth_rejected', needRescan: true, networkStopped: false });
    await flush();
    const logs = h.named('log').map(call => String(call.args[1] || ''));
    assert.ok(logs.some(text => text.includes('建议在面板重新扫码') && text.includes('预算退避重试')));
    assert.ok(!logs.some(text => text.includes('网关已停止自动重连')));
    const alert = h.named('alert.codeExpired').at(-1).args[0];
    assert.equal(alert.platform, 'wx');
    assert.equal(alert.needRescan, true);
    assert.equal(alert.networkStopped, false);
    await stopReadyWorker(h);
});

test('worker experienceObserved：同有效 gid 的真实同值也 note，异 gid/未 ready/离线/已停拒绝', async () => {
    const h = loadReadyWorker();
    await h.start();
    h.event('experienceObserved', { gid: 42, exp: 400, at: 1000001 });
    assert.equal(h.named('stats.note').length, 0);
    await h.login();
    for (const [gid, at] of [[42, 1000002], ['42', 1000003]]) {
        h.event('experienceObserved', { gid, exp: 400, at, source: 'item-notify' });
    }
    assert.deepEqual(h.named('stats.note').map(call => call.args), [[400, 1000002], [400, 1000003]]);
    for (const gid of [99, undefined, null, 0, -1, 1.5, 'corrupt', Number.MAX_SAFE_INTEGER + 1]) {
        h.event('experienceObserved', { gid, exp: 999, at: 1000004 });
    }
    assert.equal(h.named('stats.note').length, 2);
    vm.runInContext('statsObservationsReady = false;', h.context);
    h.event('experienceObserved', { gid: 42, exp: 400, at: 1000005 });
    h.gold(999, 400);
    assert.equal(h.named('stats.note').length, 2);
    assert.equal(h.named('stats.gold').length, 0);
    vm.runInContext('statsObservationsReady = true;', h.context);
    h.client.api.detach();
    h.network.networkEvents.emit('experienceObserved', { gid: 42, exp: 400, at: 1000006 });
    assert.equal(h.named('stats.note').length, 2, 'isConnected=false 时即使状态 gate 真也拒绝');
    await stopReadyWorker(h);
    h.network.networkEvents.emit('experienceObserved', { gid: 42, exp: 400, at: 1000007 });
    h.gold(999, 400);
    assert.equal(h.named('stats.note').length, 2);
    assert.equal(h.named('stats.gold').length, 0);
});

test('worker experienceObserved：两个相同但无效的 gid 也必须拒绝（源码回归检查）', async () => {
    const h = loadReadyWorker();
    await h.start();
    await h.login();
    const accepted = [];
    try {
        for (const gid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            h.network.getUserState().gid = gid;
            const before = h.named('stats.note').length;
            h.event('experienceObserved', { gid, exp: 400, at: 1000008 });
            if (h.named('stats.note').length !== before) accepted.push(gid);
        }
        assert.deepEqual(accepted, [], '源码只比较 Number(gid) 相等，不能代替正安全整数身份校验');
    } finally {
        await stopReadyWorker(h);
    }
});

test('worker VM：未知 require 明确失败，不得回退到宿主 require 或真实依赖', () => {
    const h = loadReadyWorker();
    assert.throws(() => vm.runInContext("require('node:fs')", h.context), /禁止真实 require: node:fs/);
    assert.throws(() => vm.runInContext("require('node:https')", h.context), /禁止真实 require: node:https/);
    assert.throws(() => vm.runInContext("require('../services/undeclared')", h.context), /禁止真实 require/);
    assert.throws(() => vm.runInContext("fetch('memory-only')", h.context), /禁止真实或未声明依赖: worker.fetch/);
    assert.equal(h.client.sockets.length, 0);
});

test('worker 崩溃自动拉起：gateway 不再带磁盘旧 Code，local 保持原行为', async () => {
    for (const [env, expected] of [
        [{ FARM_NETWORK_MODE: 'gateway' }, true],
        [{ FARM_NETWORK_MODE: 'local' }, false],
        [{ FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_ACCOUNTS: '10' }, false],
    ]) {
        const h = loadManager({ env });
        h.api.startWorker(account());
        h.children[0].emit('exit', 1, null);
        await h.time.advance(1000);
        assert.equal(h.children.length, 2);
        assert.equal(h.children[1].messages[0].config.resumeSession, expected);
    }
});

test('迟到旧 worker 消息/退出：不得覆盖新状态或拒绝新请求', async () => {
    const h = loadManager();
    h.api.startWorker(account());
    const old = h.children[0];
    h.api.restartWorker(account());
    await h.time.advance(160000);
    const current = h.workers['2'];
    const request = h.api.callWorkerApi('2', 'readOnlyMock');
    const rejected = assert.rejects(request, /模拟清理/);
    assert.equal(current.requests.size, 1);
    old.emit('message', { type: 'status', data: { status: { level: 999 } } });
    old.emit('exit', 1, null);
    assert.equal(h.workers['2'], current);
    assert.equal(current.status, null);
    assert.equal(current.requests.size, 1);
    assert.equal(h.children.length, 2);
    for (const pending of [...current.requests.values()]) pending.settle(new Error('模拟清理'));
    await rejected;
    assert.equal(current.requests.size, 0);
    assert.ok(![...h.scheduler.tasks.keys()].some(name => name.startsWith('api_')));
});

test('manager → worker 真实函数链：人工 newCode 不 resume，用户 stop 发真实 stop 帧', async () => {
    const manager = loadManager();
    manager.api.startWorker(account());
    manager.api.restartWorker(account('2', 'manual-new-code'));
    manager.children[0].emit('exit', 0, null);
    await flush();
    const client = loadClient();
    const worker = loadWorker(loadNetwork(client).api, client.time);
    await worker.message(manager.children[1].messages[0]);
    assert.equal(client.frames[0].code, 'manual-new-code');
    manager.api.stopWorker('2');
    await worker.message(manager.children[1].messages.at(-1));
    assert.deepEqual(client.frames.at(-1), { t: 'stop', accountId: '2' });
    assert.deepEqual(worker.processRef.sent, [{ type: 'worker_quiescing', pendingWrites: 0, maxDrainMs: 155000 }]);
    await client.time.advance(0);
    assert.deepEqual(worker.processRef.exits, [0]);
});

test('扫码confirm立即保存凭据，native换码失败也保留已授权登录态', async () => {
    const time = fakeClock(); const storage = credentialMemory();
    let refreshed = 0;
    class Service {
        async confirm(session) { Object.assign(session, { openid: 'wx-scan', loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh', accesstoken: 'scan-access' }); }
        async issueCode() { throw new Error('network timeout'); }
        async refreshLoginBuffer() { refreshed++; throw new Error('刚扫码不应无条件刷新'); }
    }
    const h = loadSource('wxRoutes', {
        'node:crypto': require('node:crypto'), 'node:fs': storage, 'node:path': path.posix,
        '../config/runtime-paths': { getDataDir: () => '/memory/data' },
        '../services/wx-login/service': { WxLoginService: Service },
        '../services/wx-login/credential-storage': loadCredential(storage, time).api,
        '../services/logger': { createModuleLogger: () => ({ warn: noop }) },
        '../runtime/gateway-routing': { readGatewayDelegation: () => null },
    }, { time, append: '\n;globalThis.routeApi = { tasks, confirm, consumeCode };' });
    const task = { id: 'synthetic-task', status: 'authorized', createdAt: time.Date.now(), session: { cookies: new Map() } };
    h.context.routeApi.tasks.set(task.id, task);
    await h.context.routeApi.confirm(task, {});
    assert.equal(task.status, 'ready_for_code');
    const file = '/memory/data/wx-login/wx-scan.json';
    assert.equal(JSON.parse(storage.files.get(file)).loginBuffer, 'scan-buffer');
    assert.ok(JSON.parse(storage.files.get(file)).credentialGeneration);
    await assert.rejects(h.context.routeApi.consumeCode(task, {}), /network timeout/);
    assert.equal(refreshed, 0);
    assert.equal(JSON.parse(storage.files.get(file)).refreshtoken, 'scan-refresh');
});

function loadScan(Service, initial = {}) {
    const time = fakeClock(); const storage = credentialMemory(initial);
    const h = loadSource('wxRoutes', {
        'node:crypto': require('node:crypto'), 'node:fs': storage, 'node:path': path.posix,
        '../config/runtime-paths': { getDataDir: () => '/memory/data' },
        '../services/wx-login/service': { WxLoginService: Service },
        '../services/wx-login/credential-storage': loadCredential(storage, time).api,
        '../services/logger': { createModuleLogger: () => ({ warn: noop }) },
        '../runtime/gateway-routing': { readGatewayDelegation: () => null },
    }, { time, append: '\n;globalThis.routeApi = { tasks, confirm, consumeCode, destroy, runStage };' });
    const task = { id: 'memory-scan', owner: 'tester', status: 'authorized', createdAt: time.Date.now(), session: { cookies: new Map() } };
    h.context.routeApi.tasks.set(task.id, task);
    return { ...h, storage, task, route: h.context.routeApi };
}
const scanFile = '/memory/data/wx-login/wx-scan.json';
const scanCredentials = { openid: 'wx-scan', loginBuffer: 'scan-buffer', refreshtoken: 'scan-refresh', accesstoken: 'scan-access', refreshBusinessId: 'pc_yyb', credentialSource: 'pc_yyb', appId: 'host-oauth', scope: 'memory-scope', loginType: 'WX', scannedAt: 990000, tokenCheckedAt: 995000, accessTokenExpiresAt: null };
const recordAt = (storage, file = scanFile) => JSON.parse(storage.files.get(file));
const nativeRecord = (binding, now) => ({ version: 1, binding, uin: '18446744073709551615', createdAt: now, expiresAt: now + 3600000, sendKey: 'a2V5', recvKey: 'a2V5', f9: '', deviceId: 'a2V5', hostAppId: 'a2V5', psk: 'a2V5', ticket: 'a2V5' });

for (const source of ['pc_yyb', 'pc_yyb_auth']) {
    test(`扫码新世代清旧metadata并保留真实source/OAUTH/期限（${source}）`, async () => {
        class Service { async confirm(session) { Object.assign(session, scanCredentials, { refreshBusinessId: source, credentialSource: source }); } }
        const old = { ...scanCredentials, credentialGeneration: 'old', nativeSession: { binding: 'old' }, pendingCode: { value: 'old' }, refreshTokenChangedAt: 5, accessTokenExpiresAt: 123, tokenFailureCount: 4, tokenRetryAfter: 9999999, bufferFailureCount: 3, bufferRetryAfter: 9999999, tokenLastError: 'old', lastBufferFailureAt: 9, scanRetryAfter: 9999999, codeCooldownUntil: 9999999 };
        const h = loadScan(Service, { [scanFile]: JSON.stringify(old) });
        await h.route.confirm(h.task, {});
        const rec = recordAt(h.storage);
        assert.notEqual(rec.credentialGeneration, 'old');
        for (const field of ['nativeSession', 'pendingCode', 'refreshTokenChangedAt', 'accessTokenExpiresAt', 'tokenLastError', 'lastBufferFailureAt', 'scanRetryAfter', 'codeCooldownUntil']) assert.equal(rec[field], null, field);
        for (const field of ['tokenFailureCount', 'tokenRetryAfter', 'bufferFailureCount', 'bufferRetryAfter']) assert.equal(rec[field], 0, field);
        assert.equal(rec.appId, 'wx5306c5978fdb76e4'); assert.equal(rec.oauthAppId, 'host-oauth');
        for (const field of ['scope', 'loginType', 'scannedAt', 'tokenCheckedAt']) assert.equal(rec[field], scanCredentials[field]);
        assert.equal(rec.refreshBusinessId, source); assert.equal(rec.credentialSource, source);
    });
}

test('扫码/code回调会话与pending先落盘，响应后destroy只清task', async () => {
    let h; let native;
    class Service {
        async confirm(session) { Object.assign(session, scanCredentials); }
        async issueCode(_session, appId, options) {
            assert.equal(appId, 'wx5306c5978fdb76e4'); assert.equal(options.session, null);
            native = nativeRecord(options.sessionBinding, h.time.Date.now());
            await options.onSession(native);
            assert.deepEqual(recordAt(h.storage).nativeSession, native);
            return 'memory-fresh-code';
        }
        destroy(session) { session.loginBuffer = undefined; session.refreshtoken = undefined; }
    }
    h = loadScan(Service); await h.route.confirm(h.task, {});
    const routes = new Map();
    const app = { post: (name, fn) => routes.set(name, fn), get: noop, delete: noop };
    h.api.registerAdminWxLoginRoutes({ app, provider: {} });
    let response;
    const res = { status() { return this; }, json(value) {
        response = plain(value);
        assert.equal(recordAt(h.storage).pendingCode.value, 'memory-fresh-code');
        assert.equal(h.route.tasks.has(h.task.id), true, '先响应再销毁task');
    } };
    await routes.get('/api/wx-login/tasks/:taskId/code')({ params: { taskId: h.task.id }, currentUser: { username: 'tester' } }, res);
    assert.equal(response.ok, true); assert.equal(response.data.code, 'memory-fresh-code');
    const rec = recordAt(h.storage);
    assert.deepEqual(rec.nativeSession, native);
    assert.deepEqual(rec.pendingCode, { value: 'memory-fresh-code', generation: rec.credentialGeneration, issuedAt: h.time.Date.now(), expiresAt: h.time.Date.now() + 60000, consumed: false });
    assert.equal(rec.loginBuffer, 'scan-buffer'); assert.equal(rec.refreshtoken, 'scan-refresh');
    assert.equal(h.task.credential, undefined); assert.equal(h.task.session, undefined);
});

test('首code失败仍存native session，再次取码复用session而不刷新', async () => {
    let h; let calls = 0;
    class Service {
        async confirm(session) { Object.assign(session, scanCredentials); }
        async issueCode(_session, _app, options) {
            if (++calls === 1) { await options.onSession(nativeRecord(options.sessionBinding, h.time.Date.now())); throw new Error('native response timeout'); }
            assert.deepEqual(plain(options.session), recordAt(h.storage).nativeSession);
            return 'second-fresh-code';
        }
    }
    h = loadScan(Service); await h.route.confirm(h.task, {});
    await assert.rejects(h.route.consumeCode(h.task, {}), /timeout/);
    assert.ok(recordAt(h.storage).nativeSession); assert.equal(recordAt(h.storage).pendingCode, null);
    await h.route.consumeCode(h.task, {}); assert.equal(recordAt(h.storage).pendingCode.value, 'second-fresh-code');
});

test('取消confirm和并发新scan均不得覆盖后来的世代', async () => {
    for (const cancelled of [true, false]) {
        let finish;
        class Service { async confirm(session) { await new Promise(resolve => { finish = resolve; }); Object.assign(session, scanCredentials); } destroy() {} }
        const h = loadScan(Service); const promise = h.route.confirm(h.task, {});
        const rejected = assert.rejects(promise, error => cancelled ? /取消/.test(error.message) : error.stage === 'credential_conflict');
        await flush();
        if (cancelled) h.route.destroy(h.task);
        else h.storage.files.set(scanFile, JSON.stringify({ ...scanCredentials, credentialGeneration: 'newer-scan' }));
        finish(); await rejected;
        if (cancelled) assert.equal(h.storage.files.has(scanFile), false);
        else assert.equal(recordAt(h.storage).credentialGeneration, 'newer-scan');
    }
});

test('取消code可保留同世代已建立session，迟到回调不可覆盖并发新scan', async () => {
    for (const newer of [false, true]) {
        let finish; let options;
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials); }
            async issueCode(_session, _app, value) { options = value; await new Promise(resolve => { finish = resolve; }); await options.onSession(nativeRecord(options.sessionBinding, 1000000)); return 'late-code'; }
            destroy() {}
        }
        const h = loadScan(Service); await h.route.confirm(h.task, {});
        const promise = h.route.consumeCode(h.task, {});
        const rejected = assert.rejects(promise, error => newer ? error.stage === 'credential_conflict' : /取消/.test(error.message));
        await flush(); h.route.destroy(h.task);
        if (newer) h.storage.files.set(scanFile, JSON.stringify({ ...scanCredentials, credentialGeneration: 'newer', nativeSession: null, pendingCode: null }));
        finish(); await rejected;
        const rec = recordAt(h.storage); assert.equal(rec.pendingCode, null);
        if (newer) { assert.equal(rec.credentialGeneration, 'newer'); assert.equal(rec.nativeSession, null); }
        else assert.ok(rec.nativeSession);
    }
});

for (const failure of [
    new Error('Unable to establish network timeout'),
    Object.assign(new Error('ManualAuth rejected'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -9 }),
    Object.assign(new Error('response invalid'), { code: 'WX_MANUAL_AUTH_RESPONSE_INVALID' }),
    Object.assign(new Error('ticket unknown'), { code: 'WX_NATIVE_SESSION_INVALID' }),
]) {
    test(`扫码和后台保守触发：${failure.code || 'unknown/timeout'}不续期/不远程`, async () => {
        let refreshes = 0;
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials); }
            async issueCode() { throw failure; }
            async refreshCredentials() { refreshes++; throw new Error('不该触发'); }
            async refreshBufferWithAccessToken() { refreshes++; throw new Error('不该触发'); }
        }
        const h = loadScan(Service); await h.route.confirm(h.task, {});
        await assert.rejects(h.route.consumeCode(h.task, {}), error => error === failure);
        const background = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { '/memory/data/wx-login/memory-wx-2.json': JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'generation' }) } });
        assert.equal(await background.api.refreshAccountCode('2'), false);
        assert.equal(background.fetchCalls.length, 0); assert.equal(refreshes, 0);
    });
}

for (const expiresAt of [null, 2000000, 999999]) {
    test(`明确-10恢复：真实deadline=${expiresAt}决定token-only，否则access-first`, async () => {
        let h; let attempts = 0; const calls = [];
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials, { accessTokenExpiresAt: expiresAt }); }
            async issueCode(_session, _app, options) {
                if (++attempts === 1) throw Object.assign(new Error('明确授权拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
                assert.equal(options.session, null); return 'recovered-code';
            }
            async refreshCredentials(session, options) {
                calls.push('token'); assert.equal(session.refreshBusinessId, 'pc_yyb');
                const value = { refreshtoken: 'rotated', accesstoken: 'new-access', accessTokenExpiresAt: 3000000, refreshTokenChangedAt: 1000000 };
                await options.onCredentialsRotated(value);
                assert.equal(recordAt(h.storage).refreshtoken, 'rotated'); return value;
            }
            async refreshBufferWithAccessToken(session) { calls.push('buffer'); return { loginBuffer: 'new-buffer', accesstoken: session.accesstoken, refreshtoken: session.refreshtoken }; }
        }
        h = loadScan(Service); await h.route.confirm(h.task, {}); await h.route.consumeCode(h.task, {});
        assert.deepEqual(calls, expiresAt === 999999 ? ['token', 'buffer'] : ['buffer']);
        assert.equal(recordAt(h.storage).refreshBusinessId, 'pc_yyb');
        assert.equal(recordAt(h.storage).credentialSource, 'pc_yyb');
        assert.equal(recordAt(h.storage).pendingCode.value, 'recovered-code');
    });
}

for (const serverCode of [40030, 42007]) {
    test(`buffer服务端${serverCode}拒绝后不探测其他source/token/remote`, async () => {
        let token = 0; let buffer = 0;
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials); }
            async issueCode() { throw Object.assign(new Error('拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 }); }
            async refreshCredentials() { token++; }
            async refreshBufferWithAccessToken() { buffer++; throw Object.assign(new Error('服务端拒绝'), { stage: 'login_buffer', serverCode }); }
        }
        const h = loadScan(Service); await h.route.confirm(h.task, {});
        await assert.rejects(h.route.consumeCode(h.task, {}), error => error.serverCode === serverCode);
        assert.equal(buffer, 1); assert.equal(token, 0);
    });
}

test('后台cached native回调CAS、token轮换先落盘、source全保留且Code不缓存复用', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json';
    const initialRec = { ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'background-generation', accessTokenExpiresAt: 999999, refreshBusinessId: 'pc_yyb_auth', credentialSource: 'pc_yyb_auth' };
    const cached = nativeRecord('wx-login:memory-wx-2:background-generation', 1000000); initialRec.nativeSession = cached;
    let h; let attempts = 0; let token = 0; let buffer = 0;
    class Service {
        async issueCode(session, _app, options) {
            assert.equal(session.refreshBusinessId, 'pc_yyb_auth'); assert.equal(session.credentialSource, 'pc_yyb_auth');
            if (++attempts === 1) { assert.deepEqual(plain(options.session), cached); throw Object.assign(new Error('拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 }); }
            assert.equal(options.session, null); await options.onSession(nativeRecord(options.sessionBinding, h.time.Date.now()));
            assert.ok(recordAt(h.storage, file).nativeSession); return `code-${attempts}`;
        }
        async refreshCredentials(session, options) {
            token++; const value = { refreshtoken: 'bg-rotated', accesstoken: 'bg-access', accessTokenExpiresAt: 3000000 };
            await options.onCredentialsRotated(value); assert.equal(recordAt(h.storage, file).refreshtoken, 'bg-rotated');
            return value;
        }
        async refreshBufferWithAccessToken(session) { buffer++; assert.equal(session.accesstoken, 'bg-access'); return { loginBuffer: 'bg-buffer' }; }
    }
    h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify(initialRec) } });
    assert.equal(await h.api.refreshAccountCode('2'), true);
    assert.equal(await h.api.refreshAccountCode('2'), false, '不可返回上一枚Code供再次重连');
    assert.equal(h.restarts.length, 1); assert.equal(token, 1); assert.equal(buffer, 1); assert.equal(attempts, 2); assert.equal(h.fetchCalls.length, 0);
    const rec = recordAt(h.storage, file); assert.equal(rec.refreshBusinessId, 'pc_yyb_auth'); assert.equal(rec.credentialSource, 'pc_yyb_auth');
});

test('后台取消保持operations单飞直到真实收尾，并发新扫码阻止旧回调写入', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let finish; let attempts = 0; let h;
    class Service { async issueCode(_session, _app, options) {
        attempts++; await new Promise(resolve => { finish = resolve; });
        await options.onSession(nativeRecord(options.sessionBinding, h.time.Date.now())); return 'late-code';
    } }
    h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'old' }) } });
    let settled = false;
    const first = h.api.refreshAccountCode('2').then(value => { settled = true; return value; }); await flush();
    h.api.stopAccount('2'); await flush(); assert.equal(settled, false);
    const second = h.api.refreshAccountCode('2'); await flush(); assert.equal(attempts, 1);
    h.storage.files.set(file, JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'new', nativeSession: null }));
    finish(); assert.equal(await first, false); assert.equal(await second, false);
    assert.equal(recordAt(h.storage, file).credentialGeneration, 'new'); assert.equal(recordAt(h.storage, file).nativeSession, null);
    assert.equal(h.fetchCalls.length, 0); assert.equal(h.restarts.length, 0); assert.equal(h.time.timers.size, 0);
});

test('后台legacy无source明确沿用pc_yyb，过期native只重新握手而不轮换token', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let h; let calls = 0;
    const rec = { openid: 'memory-wx-2', appId: 'wx5306c5978fdb76e4', loginBuffer: 'legacy-buffer', refreshtoken: 'legacy-refresh', accesstoken: 'legacy-access', credentialGeneration: 'legacy' };
    rec.nativeSession = nativeRecord('wx-login:memory-wx-2:legacy', 1); rec.nativeSession.expiresAt = 999999;
    class Service { async issueCode(session, _app, options) {
        calls++; assert.equal(session.refreshBusinessId, 'pc_yyb'); assert.equal(session.credentialSource, 'legacy_pc_yyb');
        assert.equal(options.session, null); await options.onSession(nativeRecord(options.sessionBinding, h.time.Date.now())); return 'legacy-fresh';
    } }
    h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify(rec) } });
    assert.equal(await h.api.refreshAccountCode('2'), true); assert.equal(calls, 1); assert.equal(h.fetchCalls.length, 0);
    assert.equal(recordAt(h.storage, file).nativeSession.binding, 'wx-login:memory-wx-2:legacy');
});

test('后台同openid不同账号并发单飞，但一次性Code只交付一个重连', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let finish; let calls = 0;
    class Service { async issueCode() { calls++; await new Promise(resolve => { finish = resolve; }); return 'only-once'; } }
    const h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account(), { ...account('9'), wxid: 'memory-wx-2' }], { Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'shared' }) } });
    const first = h.api.refreshAccountCode('2'); await flush();
    const second = h.api.refreshAccountCode('9'); await flush(); assert.equal(calls, 1);
    finish(); assert.equal(await first, true); assert.equal(await second, false);
    assert.equal(h.restarts.length, 1); assert.equal(h.fetchCalls.length, 0);
});

test('后台超时先取消但不释放operations，真实下层结束后才可收尾', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let finish; let calls = 0;
    class Service { async issueCode() { calls++; await new Promise(resolve => { finish = resolve; }); return 'late'; } }
    const h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'slow' }) } });
    let settled = false; const first = h.api.refreshAccountCode('2').then(value => { settled = true; return value; }); await flush();
    await h.time.advance(45000); assert.equal(settled, false);
    const second = h.api.refreshAccountCode('2'); await flush(); assert.equal(calls, 1);
    finish(); assert.equal(await first, false); assert.equal(await second, false);
    assert.equal(h.restarts.length, 0); assert.equal(h.fetchCalls.length, 0); assert.equal(h.time.timers.size, 0);
});

test('扫码和后台token轮换回调遇到取消先保存，不能继续buffer/Code', async () => {
    for (const background of [false, true]) {
        let h; let buffer = 0;
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials, { accessTokenExpiresAt: 999999 }); }
            async issueCode() { throw Object.assign(new Error('拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 }); }
            async refreshCredentials(_session, options) {
                if (background) h.api.stopAccount('2'); else h.route.destroy(h.task);
                await options.onCredentialsRotated({ refreshtoken: 'cancel-rotated', accesstoken: 'cancel-access', accessTokenExpiresAt: null });
                throw new Error('回调应检查取消');
            }
            async refreshBufferWithAccessToken() { buffer++; }
            destroy() {}
        }
        if (background) {
            const file = '/memory/data/wx-login/memory-wx-2.json';
            h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'cancel-generation', accessTokenExpiresAt: 999999 }) } });
            assert.equal(await h.api.refreshAccountCode('2'), false); assert.equal(recordAt(h.storage, file).refreshtoken, 'cancel-rotated');
            assert.equal(h.fetchCalls.length, 0); assert.equal(h.restarts.length, 0);
        } else {
            h = loadScan(Service); await h.route.confirm(h.task, {});
            await assert.rejects(h.route.consumeCode(h.task, {}), /取消/); assert.equal(recordAt(h.storage).refreshtoken, 'cancel-rotated');
        }
        assert.equal(buffer, 0);
    }
});

test('扫码native/pending writer失败不可继续响应成功或丢失已有session', async () => {
    for (const failPending of [false, true]) {
        let h;
        class Service {
            async confirm(session) { Object.assign(session, scanCredentials); }
            async issueCode(_session, _app, options) {
                if (!failPending) h.storage.failWrite = true;
                await options.onSession(nativeRecord(options.sessionBinding, h.time.Date.now()));
                if (failPending) h.storage.failWrite = true;
                return 'must-not-respond';
            }
        }
        h = loadScan(Service); await h.route.confirm(h.task, {});
        await assert.rejects(h.route.consumeCode(h.task, {}), /ENOSPC/);
        assert.equal(h.task.code, undefined); assert.equal(recordAt(h.storage).pendingCode, null);
        assert.equal(Boolean(recordAt(h.storage).nativeSession), failPending);
    }
});

test('后台交付前发生并发新scan则禁止restart旧世代Code', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let h;
    class Service { async issueCode() { return 'old-generation-code'; } }
    h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], {
        Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'old' }) },
        log(_kind, message) {
            if (message.startsWith('本机换码成功')) h.storage.files.set(file, JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'new' }));
        },
    });
    assert.equal(await h.api.refreshAccountCode('2'), false);
    assert.equal(h.restarts.length, 0); assert.equal(h.updates.length, 0); assert.equal(recordAt(h.storage, file).credentialGeneration, 'new');
});

test('后台新扫码世代清旧退避，旧世代Code不得交付给新世代', async () => {
    const file = '/memory/data/wx-login/memory-wx-2.json'; let attempts = 0;
    class Service { async issueCode() { if (++attempts === 1) throw new Error('unknown'); return 'new-generation-code'; } }
    const h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { Service, initial: { [file]: JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'old' }) } });
    assert.equal(await h.api.refreshAccountCode('2'), false);
    h.storage.files.set(file, JSON.stringify({ ...scanCredentials, openid: 'memory-wx-2', credentialGeneration: 'new' }));
    assert.equal(await h.api.refreshAccountCode('2'), true); assert.equal(attempts, 2); assert.equal(h.restarts[0].code, 'new-generation-code');
});

for (const text of ['{invalid', JSON.stringify({ openid: 'memory-wx-2' })]) {
    test('后台仅本地缺文件才可远程，损坏/缺buffer凭据禁远程', async () => {
        const h = loadRefresh({ FARM_NETWORK_MODE: 'local' }, [account()], { initial: { '/memory/data/wx-login/memory-wx-2.json': text } });
        assert.equal(await h.api.refreshAccountCode('2'), false); assert.equal(h.fetchCalls.length, 0); assert.equal(h.restarts.length, 0);
    });
}

test('writer仅回收同namespace已退出owner；活owner和跨容器未知owner不能删锁', () => {
    const recordFile = '/memory/data/wx-login/wx-test.json';
    for (const kind of ['exited', 'live', 'other-namespace']) {
        const storage = credentialMemory({ [recordFile]: JSON.stringify({ loginBuffer: 'old' }) });
        const lock = recordFile + '.write-lock'; storage.dirs.add(lock);
        const nonce = 'a'.repeat(32);
        const stat = pid => `${pid} (node) ${['S', ...Array(18).fill('0'), '100', ...Array(5).fill('0')].join(' ')}`;
        storage.files.set('/proc/sys/kernel/random/boot_id', 'synthetic-boot');
        storage.files.set('/proc/self/stat', stat(123)); storage.files.set('/proc/self/status', 'NSpid:\t123');
        storage.files.set('/proc/123/stat', stat(123)); storage.files.set('/proc/123/status', 'NSpid:\t123');
        storage.readlinkSync = () => 'pid:[synthetic]';
        if (kind === 'live') { storage.files.set('/proc/7/stat', stat(7)); storage.files.set('/proc/7/status', 'NSpid:\t7'); }
        storage.files.set(`${lock}/owner-${nonce}.json`, JSON.stringify({ nonce, identity: { version: 2, bootId: 'synthetic-boot', pidNamespace: kind === 'other-namespace' ? 'pid:[other]' : 'pid:[synthetic]', pid: '7', startTime: '100', nspid: ['7'] } }));
        const writer = loadCredential(storage).api;
        if (kind === 'exited') {
            writer.writeWxCredential(recordFile, { loginBuffer: 'new' });
            assert.equal(JSON.parse(storage.files.get(recordFile)).loginBuffer, 'new');
            assert.equal(storage.dirs.has(lock), false);
        } else {
            assert.throws(() => writer.writeWxCredential(recordFile, { loginBuffer: 'bad' }), error => error.stage === 'credential_conflict');
            assert.ok(storage.files.has(`${lock}/owner-${nonce}.json`));
            assert.equal(JSON.parse(storage.files.get(recordFile)).loginBuffer, 'old');
        }
    }
});

function loadApiWorker({ extra = {}, mocks = {} } = {}) {
    const client = loadClient();
    const network = loadNetwork(client).api;
    const worker = loadWorker(network, client.time, { extra, mocks });
    client.api.connect('2', '', noop);
    client.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', userState: { gid: 42 } }) + '\n');
    return {
        ...worker, client, network,
        call: (id, method, args = [], readOnly = true, deadline = client.time.Date.now() + 60000) =>
            worker.message({ type: 'api_call', id, method, args, readOnly, deadline }),
        response: id => worker.processRef.sent.find(msg => msg.type === 'api_response' && msg.id === id),
    };
}
const allLandsService = 'gamepb.plantpb.PlantService';
const replyTo = (client, frame, extra = {}) => client.sockets.at(-1).emit('data', JSON.stringify({
    t: 'response', accountId: '2', seq: frame.seq, body: Buffer.alloc(0).toString('base64'), ...extra,
}) + '\n');

test('worker API：AllLands await 后取消不会继续 weather，ALS 在真实 client 生效且 finally 清控制/timer', async () => {
    let h; let weather = 0;
    h = loadApiWorker({
        extra: { getLandsDetail: async () => { await h.network.sendMsgAsync(allLandsService, 'AllLands', Buffer.alloc(0)); return { lands: [] }; } },
        mocks: { '../services/activity': { getOwnWeatherStatus: async () => { weather++; return {}; } } },
    });
    const promise = h.call(1, 'getLands'); await flush();
    const frame = h.client.frames.find(value => value.t === 'request');
    assert.equal(frame.method, 'AllLands'); assert.equal(frame.meta.priority, 'foreground');
    await h.message({ type: 'api_cancel', id: 1 }); replyTo(h.client, frame); await promise; await flush();
    assert.equal(weather, 0); assert.equal(h.response(1).result, null);
    assert.equal(h.response(1).errorMeta.errorCode, 'REQUEST_CANCELLED');
    assert.equal(h.api.state().apiControlCount, 0); assert.equal(h.client.time.timers.size, 0);
    assert.deepEqual(plain(h.client.priority.getRequestContext()), {});
});

test('worker API：真实 gate 排队读取消不发送下一 RPC，8 并发上限不由 fixture 放宽', async () => {
    const h = loadApiWorker();
    const blockers = Array.from({ length: 8 }, () => h.network.sendMsgAsync('write-service', 'Write', Buffer.alloc(0)));
    await flush(); assert.equal(h.client.api.getRequestQueueSnapshot().active, 8);
    h.context.getAvailableSeeds = async () => h.network.sendMsgAsync(allLandsService, 'AllLands', Buffer.alloc(0));
    const promise = h.call(2, 'getSeeds'); await flush();
    assert.equal(h.client.api.getRequestQueueSnapshot().queued, 1);
    await h.message({ type: 'api_cancel', id: 2 }); await promise;
    for (const frame of h.client.frames.filter(value => value.t === 'request')) replyTo(h.client, frame);
    await Promise.all(blockers); await flush();
    assert.equal(h.client.frames.filter(value => value.t === 'request').length, 8);
    assert.equal(h.client.api.getRequestQueueSnapshot().active, 0);
    assert.equal(h.client.time.timers.size, 0); assert.equal(h.api.state().apiControlCount, 0);
});

for (const [method, args, readOnly] of [
    ['getFriends', [true], true], ['getFriends', [{ force: true }], true],
    ['getSeeds', ['unexpected'], true], ['getSeeds', [], 'true'], ['getSeeds', [], false],
    ['doFarmOp', [], true],
]) {
    test(`worker API：调用方不能伪造安全读 ${method}/${JSON.stringify(args)}/${readOnly}`, async () => {
        const deferred = pendingReply(); let signal; let h;
        const run = () => { signal = h.network.getRequestContext().signal; return deferred.promise; };
        h = loadApiWorker({ extra: { getFriendsList: run, getAvailableSeeds: run, runFarmOperation: run } });
        const promise = h.call(3, method, args, readOnly); await flush();
        await h.message({ type: 'api_cancel', id: 3 }); assert.equal(signal.aborted, false);
        deferred.resolve({ ok: true }); await promise;
        assert.equal(h.response(3).error, null); assert.equal(h.api.state().apiControlCount, 0);
        assert.equal(h.client.time.timers.size, 0);
    });
}

for (const method of ['getLands', 'getSeeds', 'getBag', 'getBagSeeds', 'getSkins', 'getPetOverview', 'getFriends']) {
    test(`worker API：白名单安全读 ${method} await 边界拒绝取消后的成功`, async () => {
        const deferred = pendingReply(); const read = () => deferred.promise;
        const h = loadApiWorker({ extra: { getLandsDetail: read, getAvailableSeeds: read, getFriendsList: read }, mocks: {
            '../services/warehouse': { getBagDetail: read, getBagSeeds: read },
            '../services/skin': { getSkinOverview: read }, '../services/pets': { getPetOverview: read },
        } });
        const promise = h.call(4, method); await h.message({ type: 'api_cancel', id: 4 });
        deferred.resolve({ lands: [] }); await promise;
        assert.equal(h.response(4).errorMeta.errorCode, 'REQUEST_CANCELLED');
        assert.equal(h.response(4).result, null); assert.equal(h.client.time.timers.size, 0);
    });
}

test('worker API：写已发后页面取消不拒绝，deadline 前原回包正常结算且仅发送一次', async () => {
    let h; h = loadApiWorker({ extra: { runFarmOperation: () => h.network.sendMsgAsync('write-service', 'Write', Buffer.alloc(0)) } });
    const promise = h.call(5, 'doFarmOp', [], true); await flush();
    const frame = h.client.frames.find(value => value.t === 'request');
    await h.message({ type: 'api_cancel', id: 5 });
    assert.equal(h.response(5), undefined); replyTo(h.client, frame); await promise;
    assert.equal(h.response(5).error, null);
    assert.equal(h.client.frames.filter(value => value.t === 'request').length, 1);
    assert.equal(h.client.time.timers.size, 0);
});

test('worker API：复合写期限到达后禁止下一个未发写，不重试已发步骤', async () => {
    let h; h = loadApiWorker({ extra: { runFarmOperation: async () => {
        await h.network.sendMsgAsync('write-service', 'WriteFirst', Buffer.alloc(0));
        await h.network.sendMsgAsync('write-service', 'WriteSecond', Buffer.alloc(0));
    } } });
    const promise = h.call(6, 'doFarmOp', [], false, h.client.time.Date.now() + 100);
    let finished = false;
    promise.then(() => { finished = true; });
    await flush(); await h.client.time.advance(100);
    assert.equal(finished, false, '业务期限不能提前结算仍在途的写');
    assert.equal(h.api.state().apiControlCount, 1);
    await h.client.time.advance(119900); await promise;
    const frames = h.client.frames.filter(value => value.t === 'request');
    assert.equal(frames.length, 1); assert.equal(frames[0].method, 'WriteFirst');
    assert.equal(h.response(6).errorMeta.sent, true); assert.equal(h.response(6).errorMeta.outcomeUnknown, true);
    await h.client.time.advance(60000); assert.equal(h.client.frames.filter(value => value.t === 'request').length, 1);
    assert.equal(h.client.time.timers.size, 0);
});

test('worker API：100 条控制上限快速拒绝，第101条不执行 handler，重复ID不覆盖旧控制', async () => {
    const deferred = pendingReply(); let calls = 0;
    const h = loadApiWorker({ extra: { getAvailableSeeds: () => { calls++; return deferred.promise; } } });
    const requests = Array.from({ length: 100 }, (_, id) => h.call(id, 'getSeeds'));
    assert.equal(h.api.state().apiControlCount, 100);
    await h.call(101, 'getSeeds'); await h.call(0, 'getSeeds');
    assert.equal(calls, 100); assert.equal(h.response(101).errorMeta.errorCode, 'API_QUEUE_FULL');
    assert.equal(h.response(0).errorMeta.errorCode, 'API_DUPLICATE_ID');
    assert.equal(h.api.state().apiControlCount, 100);
    deferred.resolve({ ok: true }); await Promise.all(requests);
    assert.equal(h.api.state().apiControlCount, 0); assert.equal(h.client.time.timers.size, 0);
});

test('worker API：所有异常保持 error string 并透传 errorMeta，未知方法不返回空成功', async () => {
    const failure = Object.assign(new Error('原始错误文本'), { errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: 321,
        sent: false, resultState: 'not_sent', outcomeUnknown: false });
    const h = loadApiWorker({ extra: { runFarmOperation: async () => { throw failure; } } });
    await h.call(7, 'doFarmOp', [], false);
    assert.equal(h.response(7).error, '原始错误文本');
    assert.deepEqual(h.response(7).errorMeta, { errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: 321,
        sent: false, resultState: 'not_sent', outcomeUnknown: false });
    await h.call(8, 'unknown'); assert.equal(h.response(8).error, 'Unknown method');
    assert.equal(h.response(8).errorMeta.errorCode, 'API_UNKNOWN_METHOD');
    await h.call(9, 'getSeeds', [], true, 0); assert.equal(h.response(9).errorMeta.sent, false);
    assert.equal(h.api.state().apiControlCount, 0); assert.equal(h.client.time.timers.size, 0);
});

test('worker API：并发好友同步引用计数，一条finally不能解除另一条暂停', async () => {
    const first = pendingReply(); const second = pendingReply(); let calls = 0;
    const h = loadApiWorker({ extra: { getFriendsList: () => ++calls === 1 ? first.promise : second.promise } });
    const a = h.call(10, 'getFriends', [true], false); const b = h.call(11, 'getFriends', [true], false);
    assert.equal(h.api.state().friendSyncPaused, 2);
    first.reject(new Error('同步失败')); await a; assert.equal(h.api.state().friendSyncPaused, 1);
    second.resolve([]); await b; assert.equal(h.api.state().friendSyncPaused, 0);
});

test('worker API：disconnect取消安全读但不取消写controller，preserve stop等已发写结算不杀游戏', async () => {
    const client = loadClient(); const network = loadNetwork(client).api;
    const readReply = pendingReply(); const writeReply = pendingReply(); let writeSignal;
    const h = loadWorker(network, client.time, { extra: {
        getAvailableSeeds: () => readReply.promise,
        runFarmOperation: () => { writeSignal = network.getRequestContext().signal; return writeReply.promise; },
    } });
    await h.message({ type: 'start', config: { platform: 'wx', resumeSession: true } });
    vm.runInContext('loginReady = true;', h.context);
    const a = h.message({ type: 'api_call', id: 12, method: 'getSeeds', args: [], readOnly: true, deadline: client.time.Date.now() + 60000 });
    const b = h.message({ type: 'api_call', id: 13, method: 'doFarmOp', args: [], readOnly: false, deadline: client.time.Date.now() + 60000 });
    network.networkEvents.emit('disconnect'); readReply.resolve({}); await a;
    assert.equal(writeSignal.aborted, false);
    const stop = h.message({ type: 'stop', preserveSession: true }); await flush();
    assert.deepEqual(h.processRef.exits, []); assert.equal(client.sockets[0].destroyed, false);
    writeReply.resolve({ ok: true }); await b; await stop; await client.time.advance(0);
    assert.ok(!client.frames.some(frame => frame.t === 'stop')); assert.equal(client.time.timers.size, 0);
    assert.equal(h.api.state().apiControlCount, 0);
});

test('worker health：业务未恢复不解退避，remaining正确，不把degradedStreak当timeoutStreak', async () => {
    const h = loadReadyWorker(); await h.start(); await h.login();
    h.event('connection_degraded', { retryAfterMs: 12000, timeoutStreak: 2, degradedStreak: 99 });
    await h.client.time.advance(2000);
    h.event('connection_recovered', { businessHealthy: false, linkHealthy: true });
    const diagnostic = h.api.getTransportDiagnostics();
    assert.deepEqual(plain(diagnostic.healthBackoff), { active: true, remainingMs: 10000 });
    assert.equal(h.client.api.getDiagnosticSnapshot().healthBackoff.active, true);
    assert.equal(diagnostic.health.linkHealthy, true);
    assert.equal(diagnostic.health.businessHealthy, false);
    assert.equal(diagnostic.health.timeoutStreak, 2);
    const event = h.processRef.sent.find(msg => msg.data?.meta?.event === 'connection_degraded');
    assert.equal(event.data.meta.timeoutStreak, 2); assert.equal(event.data.meta.retryAfterMs, 12000);
    h.event('connection_recovered', { businessHealthy: true });
    assert.equal(h.api.getTransportDiagnostics().healthBackoff.active, false);
    await stopReadyWorker(h);
});

test('worker health：旧payload兼容恢复，heartbeat_timeout/connection_dead暂停且不发stop/connect', async () => {
    const h = loadReadyWorker(); await h.start(); await h.login();
    const frames = h.client.frames.length;
    for (const event of ['heartbeat_timeout', 'connection_dead']) {
        h.event(event, {}); assert.equal(h.api.state().statsConnectionPaused, true);
    }
    assert.equal(h.client.api.isConnected(), false);
    h.event('connection_recovered', {}); assert.equal(h.api.state().statsConnectionPaused, true, '无真实ready不能用缓存恢复stats');
    assert.equal(h.client.frames.length, frames);
    await stopReadyWorker(h);
});

test('worker diagnostics：只读native队列/health并加sessionEpoch/currentGid，无游戏RPC或凭据泄漏', async () => {
    const h = loadApiWorker();
    h.context.getDiagnosticSnapshot = () => ({ connectionEpoch: 7, gid: 42, pending: 2, pendingWrites: 1, quiescing: true, connected: true,
        token: 'secret', healthBackoff: { active: true, remainingMs: 1234, reason: 'secret' },
        queue: { active: 2, maxActive: 8, queued: 3, token: 'secret', byPriority: { friend: 3, secret: 4 } },
        reads: { waiters: 2, raw: 'secret' } });
    await h.call(14, 'getTransportDiagnostics'); const diagnostic = h.response(14).result;
    assert.equal(diagnostic.sessionEpoch, 7); assert.equal(diagnostic.currentGid, 42);
    assert.equal(diagnostic.queue.queued, 3); assert.equal(diagnostic.reads.waiters, 2);
    assert.equal(diagnostic.healthBackoff.remainingMs, 1234);
    assert.equal(diagnostic.pendingWrites, 1); assert.equal(diagnostic.quiescing, true);
    assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
    assert.equal(h.client.frames.filter(value => value.t === 'request').length, 0);
});

function loadStats(time = fakeClock()) {
    const storage = fakeFs();
    const h = loadSource('stats', {
        'node:process': fakeProcess({ FARM_DATA_DIR: '/memory/data' }), 'node:fs': storage, 'node:path': path.posix,
        './json-db': { writeJsonFileAtomic: (file, value) => storage.writeFileSync(file, JSON.stringify(value)) },
        './activity': { getQixiEndedStateCached: () => ({ ended: true }) },
    }, { time, append: '\n;globalThis.statsState = () => ({ enabled: expObservationEnabled, ready: connectionReady, intervals: rateState.intervals, confirmedExp });' });
    return { ...h, storage, state: h.context.statsState };
}

test('真实stats：旧缓存snapshotOnly不清历史样本，暂停停止online尾段而不丢已确认actual增益', async () => {
    const h = loadStats(); h.api.initStatsWithPersistence('2', 900, 100);
    h.api.setExpConnectionReady(true);
    await h.time.advance(300000); assert.equal(h.api.noteExpObservation(150), true);
    const before = plain(h.state()); assert.equal(before.confirmedExp.exp, 150);
    await h.time.advance(10000); h.api.pauseExpObservations();
    const paused = plain(h.state());
    assert.equal(paused.intervals.reduce((sum, item) => sum + item.gain, 0), 50);
    const atPause = plain(h.api.computeExpRate()); await h.time.advance(120000);
    assert.deepEqual(plain(h.api.computeExpRate()), atPause, '暂停后的离线时间不扩充online尾段');
    h.api.initStatsWithPersistence('2', 900, 1, 0, 0, { snapshotOnly: true });
    const restored = plain(h.state());
    assert.equal(restored.confirmedExp.exp, 150);
    assert.equal(restored.intervals.reduce((sum, item) => sum + item.gain, 0), 50);
    assert.ok(restored.intervals.length >= before.intervals.length);
    h.api.pauseExpObservations(); assert.equal(h.time.timers.size, 0);
});

test('真实stats协作验收：同epoch暂停后恢复不得重新init/seed清样本，下一actual增益必须可记录', async () => {
    const h = loadStats(); h.api.initStatsWithPersistence('2', 900, 100); h.api.setExpConnectionReady(true);
    await h.time.advance(300000); h.api.noteExpObservation(150); h.api.pauseExpObservations();
    const before = plain(h.state()); await h.time.advance(1000);
    assert.equal(typeof h.api.resumeExpObservations, 'function', 'main/stats需提供resumeExpObservations(at)：不reset/seed且重新允许actual观测');
    h.api.resumeExpObservations(h.time.Date.now()); h.api.setExpConnectionReady(true);
    assert.equal(h.api.noteExpObservation(175), true);
    assert.equal(h.state().confirmedExp.exp, 175);
    assert.ok(h.state().intervals.reduce((sum, item) => sum + item.gain, 0) >= 75);
    assert.ok(h.state().intervals.length >= before.intervals.length);
    h.api.pauseExpObservations(); assert.equal(h.time.timers.size, 0);
});

test('worker syncStatus真实函数：gatewayTransport进入stats并只读诊断，不新增游戏RPC', async () => {
    const h = loadApiWorker({ mocks: {
        '../services/friend': { getOperationLimits: () => ({}) },
        '../services/stats': { getStats: () => ({ status: { level: 0, exp: 0 } }) },
    }, extra: { statusData: {}, getAutomation: () => ({}), getPreferredSeed: () => 0, nextHelpRunAt: 0, nextStealRunAt: 0 } });
    vm.runInContext(sourceBetween(sources.worker, 'function syncStatus()', '\n}').concat('\n}'), h.context);
    h.context.syncStatus();
    const snapshot = h.processRef.sent.find(msg => msg.type === 'status_sync').data.gatewayTransport;
    assert.equal(snapshot.currentGid, 42); assert.equal(snapshot.sessionEpoch, h.client.api.getDiagnosticSnapshot().connectionEpoch);
    assert.equal(snapshot.queue.maxActive, 8); assert.equal(snapshot.queue.maxQueued, 100);
    assert.equal(h.client.frames.filter(frame => frame.t === 'request').length, 0);
});

test('worker→真实stats协作验收：degrade后同epoch实际成功经验恢复记录，不永久停采也不重init', async () => {
    const h = loadReadyWorker({ realStats: true }); await h.start(); await h.login();
    await h.client.time.advance(300000); h.event('experienceObserved', { gid: 42, exp: 450, at: h.client.time.Date.now() });
    assert.equal(h.actualStats.state().confirmedExp.exp, 450);
    h.event('connection_degraded', { backoffMs: 1000, timeoutStreak: 2 });
    assert.equal(h.actualStats.state().ready, false);
    await h.client.time.advance(1000);
    h.event('experienceObserved', { gid: 42, exp: 475, at: h.client.time.Date.now() });
    try {
        assert.equal(h.actualStats.state().confirmedExp.exp, 475, 'stats缺resume API时worker不能把未恢复的note当成功');
        assert.equal(h.actualStats.state().intervals.reduce((sum, item) => sum + item.gain, 0), 75);
    } finally {
        await h.message({ type: 'stop', preserveSession: true }); await h.client.time.advance(0);
    }
});

test('worker API：AllLands已返回后同tick取消仍在await边界阻止weather，不依赖transport拒绝', async () => {
    const deferred = pendingReply(); let weather = 0;
    const h = loadApiWorker({ extra: { getLandsDetail: () => deferred.promise }, mocks: {
        '../services/activity': { getOwnWeatherStatus: async () => { weather++; return {}; } },
    } });
    const promise = h.call(15, 'getLands');
    deferred.resolve({ lands: [] }); await h.message({ type: 'api_cancel', id: 15 }); await promise;
    assert.equal(weather, 0); assert.equal(h.response(15).errorMeta.errorCode, 'REQUEST_CANCELLED');
    assert.equal(h.client.time.timers.size, 0);
});

test('worker API：deadline已到但首个写已成功，下一步骤尚未发只能abort不能自动重复写', async () => {
    let h; const first = pendingReply(); let writes = 0;
    h = loadApiWorker({ extra: { runFarmOperation: async () => {
        writes++; await first.promise;
        await h.network.sendMsgAsync('write-service', 'WriteSecond', Buffer.alloc(0));
    } } });
    const promise = h.call(16, 'doFarmOp', [], false, h.client.time.Date.now() + 100);
    await h.client.time.advance(100); first.resolve({ ok: true }); await promise;
    assert.equal(writes, 1); assert.equal(h.client.frames.filter(frame => frame.t === 'request').length, 0);
    assert.equal(h.response(16).errorMeta.sent, false); assert.equal(h.api.state().apiControlCount, 0);
});

test('worker API：安全读weather结构化异常不能被可选天气catch吞掉', async () => {
    const failure = Object.assign(new Error('天气退避原文'), { errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: 3000, sent: false, resultState: 'not_sent' });
    const h = loadApiWorker({ extra: { getLandsDetail: async () => ({ lands: [] }) }, mocks: {
        '../services/activity': { getOwnWeatherStatus: async () => { throw failure; } },
    } });
    await h.call(17, 'getLands'); assert.equal(h.response(17).error, '天气退避原文');
    assert.equal(h.response(17).errorMeta.retryAfterMs, 3000);
    assert.equal(h.response(17).result, null); assert.equal(h.client.time.timers.size, 0);
});

test('manager→worker→client真实请求链：安全读取消传api_cancel，weather不继续且两层pending全清', async () => {
    const manager = loadManager(); manager.api.startWorker(account());
    let worker;
    worker = loadApiWorker({ extra: { getLandsDetail: async () => {
        await worker.network.sendMsgAsync(allLandsService, 'AllLands', Buffer.alloc(0)); return { lands: [] };
    } }, mocks: { '../services/activity': { getOwnWeatherStatus: forbidden('取消后的weather RPC') } } });
    const proc = manager.children[0];
    const recordSend = worker.processRef.send;
    worker.processRef.send = msg => { recordSend(msg); proc.emit('message', plain(msg)); };
    const controller = new AbortController();
    const request = manager.context.require('../utils/request-priority').runWithRequestContext({ signal: controller.signal },
        () => manager.api.callWorkerApi('2', 'getLands'));
    const rejected = assert.rejects(request, error => error.errorCode === 'CANCELLED');
    const call = proc.messages.at(-1);
    assert.equal(call.type, 'api_call'); assert.equal(call.readOnly, true); assert.ok(call.deadline > manager.time.Date.now());
    const completion = worker.message(call); await flush();
    controller.abort(); const cancel = proc.messages.at(-1);
    assert.deepEqual(cancel, { type: 'api_cancel', id: call.id });
    await worker.message(cancel); await completion; await rejected; await flush();
    for (const frame of worker.client.frames.filter(value => value.t === 'request')) replyTo(worker.client, frame);
    await flush();
    assert.equal(manager.workers['2'].requests.size, 0); assert.equal(worker.api.state().apiControlCount, 0);
    assert.equal(worker.client.time.timers.size, 0); assert.equal(worker.client.api.getRequestQueueSnapshot().active, 0);
    assert.ok(![...manager.scheduler.tasks.keys()].some(name => name.startsWith('api_')));
});

test('worker API：pet复合Promise继承transport context，取消后不会新增后续raw RPC', async () => {
    let h; h = loadApiWorker({ mocks: { '../services/pets': { getPetOverview: async () => {
        await Promise.all([
            h.network.sendMsgAsync(allLandsService, 'AllLands', Buffer.from('one')),
            h.network.sendMsgAsync('gamepb.itempb.ItemService', 'Bag', Buffer.from('two')),
        ]);
        return h.network.sendMsgAsync('unsafe-service', 'Visit', Buffer.alloc(0));
    } } } });
    const promise = h.call(18, 'getPetOverview'); await flush();
    assert.equal(h.client.frames.filter(frame => frame.t === 'request').length, 2);
    await h.message({ type: 'api_cancel', id: 18 }); await promise; await flush();
    assert.equal(h.response(18).errorMeta.errorCode, 'REQUEST_CANCELLED');
    assert.equal(h.client.frames.filter(frame => frame.t === 'request').length, 2);
    for (const frame of h.client.frames.filter(value => value.t === 'request')) replyTo(h.client, frame);
    await flush();
    assert.equal(h.client.time.timers.size, 0);
});

test('worker API：安全读自身deadline取消后await边界无下一RPC，绝对ms不是相对时长', async () => {
    const deferred = pendingReply(); let weather = 0;
    const h = loadApiWorker({ extra: { getLandsDetail: () => deferred.promise }, mocks: {
        '../services/activity': { getOwnWeatherStatus: async () => { weather++; } },
    } });
    const deadline = h.client.time.Date.now() + 50;
    const promise = h.call(19, 'getLands', [], true, deadline); await h.client.time.advance(50);
    deferred.resolve({ lands: [] }); await promise;
    assert.equal(weather, 0); assert.equal(h.response(19).errorMeta.sent, false);
    assert.equal(h.api.state().apiControlCount, 0); assert.equal(h.client.time.timers.size, 0);
});

function friendVisitMemory(initial) {
    // 夹具明确提供已经验证的离场基线；生产缺失记录不得沿用测试假设自动放行。
    const baseline = { '/memory/data/friend-visit-state/2.json': JSON.stringify({ version: 1, accountId: '2',
        phase: 'left', gid: 0, epoch: 7, proof: 'leave_confirmed', updatedAt: 1000000 }) };
    const files = new Map(Object.entries(initial === undefined ? baseline : initial));
    const writes = [];
    const storage = {
        files, writes, failRead: false, failWrite: false,
        openSync(name) {
            if (storage.failWrite) throw new Error('模拟ENOSPC');
            if (files.has(name)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
            files.set(name, ''); return name;
        },
        writeFileSync(name, value) { if (storage.failWrite) throw new Error('模拟ENOSPC'); files.set(name, value); },
        fsyncSync: noop, closeSync: noop,
        existsSync: name => files.has(name),
        lstatSync: () => ({ isSymbolicLink: () => false }),
        readFileSync(name) {
            if (storage.failRead) throw new Error('模拟安全状态读取失败');
            if (!files.has(name)) throw new Error('ENOENT');
            return files.get(name);
        },
        write(file, value) {
            if (storage.failWrite) throw new Error('模拟ENOSPC安全状态保存失败');
            files.set(file, JSON.stringify(value)); writes.push(plain(value));
        },
    };
    return storage;
}

function loadFriendHarness(options = {}) {
    const time = options.client?.time || fakeClock();
    const priority = options.client?.priority || requestPriority(time);
    const processRef = fakeProcess({ FARM_ACCOUNT_ID: '2', FARM_NETWORK_MODE: 'gateway' });
    let snapshot = { accountId: '2', remoteGeneration: 7, connectionEpoch: 1, connected: true, loggedIn: true };
    let gids = [11, 22];
    let rpc;
    const calls = []; const commits = []; const messages = []; const placementStats = [];
    let badBudget = 99;
    const type = { create: value => value, encode: value => ({ finish: () => value }), decode: value => value };
    const types = new Proxy({}, { get: () => type });
    const store = {
        getConfigSnapshot: () => ({ knownFriendGids: [...gids] }), getFriendBlacklist: () => [],
        getPlantBlacklist: () => [], isAutomationOn: key => options.automation ? options.automation[key] === true : true,
        getAutomation: () => options.automation || {},
        applyConfigSnapshot(patch, options) { commits.push({ patch: plain(patch), options: plain(options) }); if (patch.knownFriendGids) gids = [...patch.knownFriendGids]; },
        removeFriendFromCache: noop, readFriendDogInfoCache: () => null, writeFriendDogInfoCache: forbidden('真实狗缓存落盘'),
    };
    let barrier = null;
    let coordinator = null;
    let fakeCurrentOperation = null;
    const network = {
        getDiagnosticSnapshot: () => options.client ? options.client.api.getDiagnosticSnapshot() : snapshot,
        getUserState: () => ({ gid: 42, accountId: '2' }),
        sendMsgAsync: async (service, method, payload, meta) => {
            if (barrier) barrier.assertGameRequestAllowed(service, method);
            calls.push({ service, method, payload, meta, context: priority.getRequestContext() });
            if (options.client) {
                const response = await options.client.api.sendMsgAsync(service, method, Buffer.from(JSON.stringify(payload)), meta);
                return { ...response, body: JSON.parse(response.body.toString() || '{}') };
            }
            return rpc(service, method, payload, meta);
        },
    };
    rpc = async (_service, method, payload) => ({ body: method === 'Enter' ? { lands: [] }
        : method === 'GetGameFriends' ? { game_friends: payload.gids.map(gid => ({ gid, name: String(gid) })) }
        : method === 'InteractRecords' ? { records: [] } : {} });
    const utils = { toNum: value => Number(value) || 0, toLong: value => value, toTimeSec: value => Number(value) || 0,
        getServerTimeSec: () => time.Date.now() / 1000, log: noop, logWarn: noop, randomDelay: async () => {}, sleep: async () => {} };
    const limits = { getCanGetHelpExp: () => true, setCanGetHelpExp: noop, canGetExpByCandidates: () => true,
        getRemainingTimes: () => 99, BAD_DAILY_LIMIT: 99, PUT_BUG_OPERATION_ID: 10004, PUT_WEED_OPERATION_ID: 10003,
        getBadRemainingTimes: () => badBudget, recordBadOperationSuccess: count => { badBudget -= count; },
        markBadDailyLimitReached: () => { badBudget = 0; }, updateOperationLimits: noop,
        helpFarming: (gid, ids) => network.sendMsgAsync('plant', 'Farming', { gid, ids }),
        stealHarvest: async (gid, ids) => (await network.sendMsgAsync('plant', 'Harvest', { gid, ids })).body };
    const common = {
        '../utils/request-priority': priority, '../utils/network': network, '../models/store': store,
        '../utils/proto': { types }, '../utils/utils': utils,
        '../config/config': { CONFIG: { platform: 'qq' }, PlantPhase: { MATURE: 6, DEAD: 7 }, PHASE_NAMES: {} },
        '../config/gameConfig': { getItemById: () => null, getPlantById: () => null, getPlantByFruitId: () => null, getPlantName: () => '', getFruitName: () => '' },
    };
    if (options.realCoordinator) {
        barrier = loadSource('accountBarrier', {
            'node:async_hooks': require('node:async_hooks'),
        }, { time, processRef }).api;
        coordinator = loadSource('accountCoordinator', { ...common,
            'node:crypto': require('node:crypto'), './account-operation-barrier': barrier,
        }, { time, processRef }).api;
    }
    const barrierApi = barrier || { getCurrentOperation: () => fakeCurrentOperation };
    const visitCoordinator = coordinator || { assertSceneOperationAvailable: noop, validateOperationSession: noop,
        runAccountOperation: async (name, task) => {
            const previous = fakeCurrentOperation;
            fakeCurrentOperation = { descriptor: { name } };
            try { return await task({ accountId: '2', gid: 42, connectionEpoch: 1,
                remoteGeneration: '7', remoteGenerationSource: 'gateway' }); }
            finally { fakeCurrentOperation = previous; }
        } };
    const visitStorage = options.visitStorage || friendVisitMemory();
    const session = loadSource('friendSession', { ...common,
        'node:fs': visitStorage, 'node:path': path.posix, 'node:crypto': { createHash: require('node:crypto').createHash },
        '../config/runtime-paths': { getDataFile: name => `/memory/data/${name}` },
        './json-db': { writeJsonFileAtomic: (file, value) => visitStorage.write(file, value) },
        // 默认夹具只测好友锁；并发回归显式加载真实协调器与屏障，不接触真实网络。
        './account-operation-coordinator': visitCoordinator,
        './ranch-friend-session': { getRanchFriendSessionSnapshot: () => ({ resultState: 'idle' }) },
    }, { time, processRef }).api;
    const interact = loadSource('interact', common, { time, processRef }).api;
    const api = loadSource('friendApi', { ...common, 'protobufjs/minimal': {}, 'node:worker_threads': { parentPort: { postMessage: message => messages.push(message) } },
        'node:async_hooks': { AsyncLocalStorage: require('node:async_hooks').AsyncLocalStorage }, './friend-visit-session': session,
        './account-operation-coordinator': visitCoordinator,
        './account-operation-barrier': barrierApi,
        './interact': interact, './friend-operation-limits': limits,
        './stats': { recordOperation: (...args) => placementStats.push(args) } }, { time, processRef, transform: options.sourceTransform }).api;
    const analyzer = loadSource('friendAnalyzer', { ...common, './friend-api': api,
        './farm-land-analyzer': { getCurrentPhase: phases => phases[0], buildLandMap: lands => new Map(lands.map(land => [Number(land.id), land])),
            getDisplayLandContext: land => ({ sourceLand: land, occupiedByMaster: false, masterLandId: Number(land.id), occupiedLandIds: [Number(land.id)] }),
            isOccupiedSlaveLand: () => false } }, { time, processRef }).api;
    const visit = loadSource('friendVisit', { ...common, './friend-api': api, './friend-land-analyzer': analyzer,
        './friend-operation-limits': limits, './farm-land-analyzer': {}, './stats': { recordOperation: noop, getOperationCount: () => 0 },
        './friend-alert': { notifyCrossAccountSteal: noop }, './warehouse': { sellAllFruits: async () => {} } }, { time, processRef }).api;
    return { time, priority, api, session, analyzer, visit, interact, calls, commits, messages, visitStorage, placementStats, barrier, coordinator, network,
        badBudget: () => badBudget,
        setRpc(value) { rpc = value; }, setGids(value) { gids = [...value]; },
        setSnapshot(patch) { snapshot = { ...snapshot, ...patch }; },
        state: () => session.getFriendVisitSessionSnapshot('2'),
    };
}

test('访友事务必须持有同账号场景租约直到唯一Leave完成，牧场不能抢占', async () => {
    const h = loadFriendHarness({ realCoordinator: true });
    h.setSnapshot({ remoteGenerationSource: 'gateway' });
    const enter = pendingReply(); const leave = pendingReply(); const ranchEnd = pendingReply();
    const order = [];
    h.setRpc(async (_service, method) => {
        if (method === 'Enter') { order.push('Enter'); return enter.promise; }
        if (method === 'Leave') { order.push('Leave'); return leave.promise; }
        return { body: {} };
    });
    const friend = h.api.withFriendVisitSession(11, reply => { order.push('work'); return reply.lands.length; });
    const friendResult = friend.then(value => ({ value }), error => ({ error }));
    let ranch; let ranchResult;
    try {
        await flush(); assert.deepEqual(h.calls.map(call => call.method), ['Enter']);
        ranch = h.coordinator.runAccountOperation('ranch-scene', async () => {
            order.push('ranch'); await ranchEnd.promise; return 'ranch-confirmed';
        }, { sceneSensitive: true, priority: 'foreground' });
        ranchResult = ranch.then(value => ({ value }), error => ({ error }));
        await flush();
        assert.equal(h.barrier.getBarrierSnapshot()?.name, 'farm-friend-visit');
        assert.equal(h.coordinator.getAccountOperationSnapshot().queue.queued, 1);
        assert.equal(order.includes('ranch'), false);
        await assert.rejects(h.network.sendMsgAsync('gamepb.plantpb.PlantService', 'GetAll', {}), {
            errorCode: 'ACCOUNT_SCENE_BUSY', sent: false,
        });
        await h.network.sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', {});
        enter.resolve({ body: { lands: [{ id: 1 }] } }); await flush();
        assert.equal(h.calls.filter(call => call.method === 'Leave').length, 1);
        assert.equal(order.includes('ranch'), false, '已发Leave未确认时仍持有租约');
        leave.resolve({ body: {} });
        const result = await friendResult; assert.equal(result.error, undefined); assert.equal(result.value, 1);
        await flush(); assert.equal(h.state().resultState, 'idle');
        assert.deepEqual(order, ['Enter', 'work', 'Leave', 'ranch']);
        ranchEnd.resolve(); assert.equal((await ranchResult).value, 'ranch-confirmed');
        assert.equal(h.calls.filter(call => call.method === 'Enter').length, 1);
        assert.equal(h.calls.filter(call => call.method === 'Leave').length, 1);
    } finally {
        enter.resolve({ body: { lands: [{ id: 1 }] } }); leave.resolve({ body: {} }); ranchEnd.resolve();
        await Promise.allSettled([friendResult, ...(ranchResult ? [ranchResult] : [])]);
    }
});

test('访友取消不能提前释放协调器，Leave真实终态之后牧场才可开始', async () => {
    const h = loadFriendHarness({ realCoordinator: true });
    h.setSnapshot({ remoteGenerationSource: 'gateway' });
    const leave = pendingReply(); const controller = new AbortController();
    let ranchStarted = false; let ranch;
    h.setRpc(async (_service, method) => method === 'Enter' ? { body: { lands: [{ id: 1 }] } }
        : method === 'Leave' ? leave.promise : { body: {} });
    const friend = h.priority.runWithRequestContext({ signal: controller.signal,
        deadline: h.time.Date.now() + 60000 }, () => h.api.withFriendVisitSession(11, () => 'work-confirmed'));
    const friendResult = friend.then(value => ({ value }), error => ({ error }));
    try {
        await flush(); assert.equal(h.calls.filter(call => call.method === 'Leave').length, 1);
        ranch = h.coordinator.runAccountOperation('ranch-scene', async () => {
            ranchStarted = true; assert.equal(h.state().resultState, 'idle'); return 'confirmed';
        }, { sceneSensitive: true });
        const ranchResult = ranch.then(value => ({ value }), error => ({ error }));
        controller.abort(new Error('页面已关闭'));
        const cancelled = await friendResult; assert.match(cancelled.error?.message || '', /页面已关闭/);
        await flush();
        assert.equal(ranchStarted, false);
        assert.equal(h.barrier.getBarrierSnapshot()?.name, 'farm-friend-visit');
        assert.equal(h.coordinator.getAccountOperationSnapshot().queue.queued, 1);
        leave.resolve({ body: {} }); await flush();
        const result = await ranchResult; assert.equal(result.error, undefined); assert.equal(result.value, 'confirmed');
        assert.equal(h.calls.filter(call => call.method === 'Leave').length, 1);
        assert.equal(h.state().resultState, 'idle');
        assert.equal(h.barrier.getBarrierSnapshot(), null);
    } finally {
        leave.resolve({ body: {} });
        await Promise.allSettled([friendResult, ...(ranch ? [ranch] : [])]);
    }
});

test('好友土地worker→client：Enter11秒+Leave11秒正常非空回包必须交付，进度unknown不吞终态', async () => {
    const client = loadClient(); client.api.connect('2', '', noop);
    client.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', generation: 7, userState: { gid: 42 } }) + '\n');
    const friends = loadFriendHarness({ client });
    const worker = loadWorker(loadNetwork(client).api, client.time, { extra: { getFriendLandsDetail: friends.analyzer.getFriendLandsDetail } });
    const completion = worker.message({ type: 'api_call', id: 501, method: 'getFriendLands', args: [11], readOnly: false,
        deadline: client.time.Date.now() + 90000 });
    await flush();
    const enter = client.frames.find(frame => frame.t === 'request');
    longWriteSent(client, enter);
    replyTo(client, enter, { settled: false, error: '仍在等待', meta: { sent: true, resultState: 'unknown', outcomeUnknown: true, settled: false } });
    await flush();
    assert.equal(worker.processRef.sent.some(message => message.id === 501), false);
    await client.time.advance(11000);
    replyTo(client, enter, { body: Buffer.from(JSON.stringify({ lands: [
        { id: 1, level: 6, unlocked: true }, { id: 2, level: 0, unlocked: false },
    ] })).toString('base64') });
    await flush();
    const leave = client.frames.filter(frame => frame.t === 'request').at(-1);
    assert.equal(leave.method, 'Leave');
    longWriteSent(client, leave);
    await client.time.advance(11000);
    replyTo(client, leave, { body: Buffer.from('{}').toString('base64') });
    await completion;
    const response = worker.processRef.sent.find(message => message.type === 'api_response' && message.id === 501);
    assert.equal(response.error, null);
    assert.deepEqual(response.result.lands.map(land => [land.id, land.status, land.level]), [[1, 'empty', 6], [2, 'locked', 0]]);
    assert.deepEqual(client.frames.filter(frame => frame.t === 'request').map(frame => frame.method), ['Enter', 'Leave']);
    assert.equal(friends.state().resultState, 'idle');
    assert.equal(worker.api.state().apiControlCount, 0);
    assert.equal(client.time.timers.size, 0);
});

test('friend Visit：已确认game_request业务拒绝只失败该次操作，正常Leave后不锁后续土地读取', async () => {
    const assertConfirmedFailure = async h => {
        const failure = Object.assign(new Error('Harvest code=1001040 果实被人摘走'), {
            errorCode: 1001040, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
        });
        h.setRpc(async (_service, method) => {
            if (method === 'Harvest') throw failure;
            return { body: { lands: [{ id: 1, unlocked: true, level: 6 }] } };
        });
        await assert.rejects(h.api.withFriendVisitSession(11, () => h.api.friendHarvestDetailed(11, [1])), error => error === failure);
        assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Harvest', 'Leave']);
        assert.equal(h.state().resultState, 'idle');
        assert.equal(h.state().recoveryRequired, false);
        const lands = await h.analyzer.getFriendLandsDetail(22);
        assert.equal(lands.lands.length, 1);
        assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Harvest', 'Leave', 'Enter', 'Leave']);
        assert.equal(h.time.timers.size, 0);
    };
    await assertConfirmedFailure(loadFriendHarness());
    // 旧stage判据只在内存中复现；旧实现会漏Leave且锁unknown，不能改生产文件反复试。
    const old = loadFriendHarness({ sourceTransform: source => source
        .replace("if (error.resultState === 'failed' && error.outcomeUnknown === false) return false;", '')
        .replace("return !['remote', 'game_request'].includes(error.stage);", "return error.stage !== 'remote';") });
    await assert.rejects(assertConfirmedFailure(old), { name: 'AssertionError' });
});

test('friend Visit→真实client：Harvest明确失败false终态必须单次Leave，错误原样交付不当未知写', async () => {
    const client = loadClient(); client.api.connect('2', '', noop);
    client.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', generation: 7, userState: { gid: 42 } }) + '\n');
    const h = loadFriendHarness({ client });
    const operation = h.api.withFriendVisitSession(11, () => h.api.runFriendVisitOperation(11, () =>
        client.api.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0))));
    const rejected = assert.rejects(operation, error => error.errorCode === 1001040 && error.stage === 'game_request'
        && error.resultState === 'failed' && error.outcomeUnknown === false);
    await flush();
    const enter = client.frames.find(frame => frame.t === 'request');
    replyTo(client, enter, { body: Buffer.from('{"lands":[]}').toString('base64') });
    await flush();
    const harvest = client.frames.filter(frame => frame.t === 'request').at(-1);
    assert.equal(harvest.method, 'Harvest');
    replyTo(client, harvest, { error: 'Harvest code=1001040 果实被人摘走', meta: {
        errorCode: 1001040, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
    } });
    await flush();
    const leave = client.frames.filter(frame => frame.t === 'request').at(-1);
    assert.equal(leave.method, 'Leave');
    replyTo(client, leave, { body: Buffer.from('{}').toString('base64') });
    await rejected;
    assert.equal(h.state().recoveryRequired, false);
    assert.equal(h.state().resultState, 'idle');
    assert.deepEqual(client.frames.filter(frame => frame.t === 'request').map(frame => frame.method), ['Enter', 'Harvest', 'Leave']);
    assert.equal(client.time.timers.size, 0);
});

test('friend Visit：game_request不能掩盖真实unknown，未确认写依旧闭锁不Leave不重放', async () => {
    const h = loadFriendHarness();
    const failure = Object.assign(new Error('Harvest结果仍未知'), {
        stage: 'game_request', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    h.setRpc(async (_service, method) => { if (method === 'Harvest') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, () => h.api.friendHarvestDetailed(11, [1])), error => error === failure);
    assert.equal(h.state().recoveryRequired, true);
    const blocked = await h.analyzer.getFriendLandsDetail(22).catch(error => error);
    assert.equal(blocked.errorCode, 'VISIT_STATE_UNKNOWN');
    assert.equal(blocked.sent, false, '已有unknown阻断的新调用并未发出Enter');
    assert.equal(blocked.outcomeUnknown, false, '旧访问未知不等于本次新调用发生未知写');
    assert.equal(blocked.resultState, 'unknown', '仍明确告知已有访问状态未知，绝不清锁冒充恢复');
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Harvest']);
    assert.equal(h.time.timers.size, 0);
});

test('好友土地Leave真失败继续阻断访问，不为显示数据吞unknown或补发Enter', async () => {
    const h = loadFriendHarness();
    const failure = Object.assign(new Error('离开失败'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
    h.setRpc(async (_service, method) => {
        if (method === 'Leave') throw failure;
        return { body: { lands: [{ id: 1, unlocked: true, level: 6 }] } };
    });
    await assert.rejects(h.analyzer.getFriendLandsDetail(11), error => error === failure);
    assert.equal(h.state().recoveryRequired, true);
    await assert.rejects(h.analyzer.getFriendLandsDetail(22), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
    assert.equal(h.time.timers.size, 0);
});

test('friend Visit：真实epoch数字字符串规范化，不把同代际字符串误判为断链或跳过Leave', async () => {
    const h = loadFriendHarness(); h.setSnapshot({ remoteGeneration: '7' });
    await h.api.withFriendVisitSession(11, noop);
    assert.equal(h.api.getFriendTransportEpoch(), 7);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
    assert.equal(h.state().resultState, 'idle');
});

test('friend Visit：明确false但stage是decode不能冒充服务端拒绝，仍锁unknown', async () => {
    const h = loadFriendHarness();
    const failure = Object.assign(new Error('写响应解码失败'), { errorCode: 'INVALID_RESPONSE',
        stage: 'decode', sent: true, resultState: 'failed', outcomeUnknown: false });
    h.setRpc(async (_service, method) => { if (method === 'Harvest') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, () => h.api.friendHarvestDetailed(11, [1])), error => error === failure);
    assert.equal(h.state().recoveryRequired, true);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Harvest']);
});

test('部署首次保守迁移：真实隔离文件只创建unknown、不覆盖旧记录、不解除访问锁', () => {
    const { execFileSync } = require('node:child_process');
    const tmpRoot = process.env.TMPDIR || path.join(__dirname, '../../.workbuddy/tests-deploy-20261109/tmp');
    assert.ok(fs.statSync(tmpRoot).isDirectory());
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'friend-migration-'));
    const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
    const script = String.raw`
import ast, pathlib, sys, json, io, contextlib, os
source = pathlib.Path(sys.argv[1])
tree = ast.parse(source.read_text(encoding='utf-8'))
constants = {node.targets[0].id: node.value.value for node in tree.body
             if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
             and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}
root = pathlib.Path(sys.argv[2]) / 'data' / 'friend-visit-state'
root.parent.mkdir()
remote_root = '/home/azureuser/data/friend-visit-state'
if not hasattr(os, 'chown'): os.chown = lambda *args: None
payload = {'accountIds': ['1', '2', '10'], 'gatewayId': 'fixture-gateway', 'gatewayStartedAt': 'fixture-start'}
def run(name, data=payload):
    saved_in = sys.stdin
    capture = io.StringIO()
    sys.stdin = io.StringIO(json.dumps(data))
    try:
        with contextlib.redirect_stdout(capture):
            exec(constants[name].replace(remote_root, root.as_posix()), {})
        return json.loads(capture.getvalue())
    finally: sys.stdin = saved_in
preflight = 'FRIEND_VISIT_MIGRATION_PREFLIGHT'
preserve = 'FRIEND_VISIT_PRESERVE_UNKNOWN_SCRIPT'
assert run(preflight)['ok'] is False
first = run(preserve)
assert set(first['createdUnknownAccountIds']) == {'1', '2', '10'}
assert first['noLeaveProofCreated'] and not first['gameRpcSent'] and not first['gatewayRestarted']
original = {file.name: file.read_bytes() for file in root.glob('*.json')}
for raw in original.values():
    record = json.loads(raw)
    assert record['phase'] == 'unknown' and record['epoch'] is None and 'proof' not in record
assert run(preflight)['ok'] is True
assert run(preserve)['createdUnknownAccountIds'] == []
assert original == {file.name: file.read_bytes() for file in root.glob('*.json')}
left = {'version': 1, 'accountId': '10', 'gid': 0, 'phase': 'left', 'epoch': 7,
        'proof': 'leave_confirmed', 'updatedAt': 1000}
(root / '10.json').write_text(json.dumps(left))
left_raw = (root / '10.json').read_bytes()
run(preserve)
assert (root / '10.json').read_bytes() == left_raw
(root / '2.json').write_text('{broken')
try:
    run(preserve)
    raise AssertionError('畸形旧状态不得放行或覆盖')
except json.JSONDecodeError: pass
assert (root / '2.json').read_text() == '{broken'
(root / '2.json').write_bytes(original['2.json'])
try:
    run(preserve, {**payload, 'accountIds': ['../escape']})
    raise AssertionError('非法账号不得创建文件')
except RuntimeError: pass
concurrent = {'version': 1, 'accountId': '3', 'gid': 99, 'phase': 'unknown', 'epoch': 7, 'updatedAt': 1234}
real_link = os.link
def racing_link(src, dst):
    pathlib.Path(dst).write_text(json.dumps(concurrent))
    real_link(src, dst)
os.link = racing_link
try:
    run(preserve, {**payload, 'accountIds': ['3']})
    raise AssertionError('并发记录不得覆盖')
except FileExistsError: pass
finally: os.link = real_link
assert json.loads((root / '3.json').read_text()) == concurrent
assert not list(root.glob('.preserve-unknown-*'))
assert not (root.parent / 'accounts.json').exists() and not (root.parent / 'store.json').exists()
print(json.dumps({'ok': True, 'cases': 7, 'createdPhase': 'unknown', 'noGameRpc': True}))
`;
    const output = execFileSync(python, ['-c', script, path.join(__dirname, '../../cloudbase/.ref/deploy.py'), dir], {
        // 本机现有 Python 的独立进程启动已测得约30秒；仍保留有界超时。
        encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    assert.equal(JSON.parse(output).ok, true);
    const time = fakeClock();
    const session = loadSource('friendSession', { 'node:fs': fs, 'node:path': path,
        'node:crypto': { createHash: require('node:crypto').createHash },
        '../config/runtime-paths': { getDataFile: name => path.join(dir, 'data', name) },
        './json-db': require('../src/services/json-db'), '../utils/request-priority': requestPriority(time),
        './account-operation-coordinator': { assertSceneOperationAvailable: noop },
    }, { time, processRef: fakeProcess({ FARM_ACCOUNT_ID: '1' }) }).api;
    assert.equal(session.getFriendVisitSessionSnapshot('1').recoveryRequired, true);
});

test('好友运维链路隔离回归：日志归档校验、仅过期未尝试票刷新、SFTP标准输入和no-deps切换', () => {
    const { execFileSync } = require('node:child_process');
    const tmpRoot = process.env.TMPDIR || path.join(__dirname, '../../.workbuddy/tests-deploy-20261109/tmp');
    assert.ok(fs.statSync(tmpRoot).isDirectory());
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'friend-recovery-ops-'));
    const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
    const script = String.raw`
import ast, pathlib, sys, json, io, contextlib, hashlib, time, types, tarfile, shlex, re
from unittest.mock import patch
source = pathlib.Path(sys.argv[1]); tree = ast.parse(source.read_text(encoding='utf-8'))
constants = {node.targets[0].id: node.value.value for node in tree.body
             if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
             and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)}
root = pathlib.Path(sys.argv[2]); releases = root / 'releases'; releases.mkdir()
stage = releases / 'fixture-v6'; stage.mkdir(); data = root / 'data'; data.mkdir()
locks = data / 'friend-visit-state'; locks.mkdir(); tickets = data / 'friend-visit-recovery'
old = stage / 'backup/core/src/services/friend-api.js'; old.parent.mkdir(parents=True); old.write_bytes(b'fixture-old-source')
source_sha = 'de37fb128953ddbf2d5b2389b3fab52a0698d088246aa8fbb0387f9376f3e57d'
state = {'manifestName': 'business-friend-layout-20261109-v6', 'reloadCount': 1,
         'baseline': {'containers': {'qq-farm-bot': {'id': 'old-container', 'startedAt': 'fixture-since'}}},
         'reloadRequestedAt': 'fixture-until'}
(stage / 'state.json').write_text(json.dumps(state))
expected = [('2', '2026-11-09T09:20:06.852Z', 10001, 3), ('1', '2026-11-09T09:20:29.814Z', 10001, 4),
            ('10', '2026-11-09T12:21:13.100Z', 1235385310, 4)]
logs = '\n'.join(['正在启动账号: {"accountId":"' + aid + '"}' for aid, _, _, _ in expected] +
    [stamp + ' {"event":"visit_state_unknown","friendGid":' + str(gid) + ',"transportEpoch":' + str(epoch)
     + ',"message":"gamepb.plantpb.PlantService.Harvest 错误: code=1001040 果实被人摘走"}' for aid, stamp, gid, epoch in expected]).encode()
for aid, _, _, epoch in expected:
    (locks / (aid + '.json')).write_text(json.dumps({'version': 1, 'accountId': aid, 'phase': 'unknown',
        'observedEpoch': epoch, 'errorMeta': {'errorCode': 'VISIT_LEGACY_STATE_UNCONFIRMED'}}))
payload = {'stage': stage.as_posix(), 'accounts': [{'id': aid, 'connected': True} for aid, _, _, _ in expected],
           'ownerGids': {'1': 42, '2': 43, '10': 44}}
real_sha = hashlib.sha256
raw_script = constants['FRIEND_VISIT_RECOVERY_EVIDENCE_SCRIPT'].replace('/home/azureuser/qq-farm-bot-main/.workbuddy/releases', releases.as_posix()).replace('/home/azureuser/data', data.as_posix())
def digest(value=b''):
    return types.SimpleNamespace(hexdigest=lambda: source_sha) if value == b'fixture-old-source' else real_sha(value)
def run(**kwargs):
    saved = sys.stdin; output = io.StringIO(); sys.stdin = io.StringIO(json.dumps({**payload, **kwargs}))
    try:
        with contextlib.redirect_stdout(output), patch('hashlib.sha256', digest), \
             patch('subprocess.check_output', return_value=json.dumps([{'Id': 'old-container'}]).encode()), \
             patch('subprocess.run', return_value=types.SimpleNamespace(stdout=logs)):
            exec(raw_script, {})
        return json.loads(output.getvalue())
    finally: sys.stdin = saved
assert run()['readOnly'] is True and not tickets.exists()
assert run(archiveLogs=True)['logsArchived'] is True
archive = stage / 'friend-visit-evidence.log'; archive_raw = archive.read_bytes(); assert archive_raw == logs
assert run(prepare=True)['ok']; saved_tickets = {aid: json.loads((tickets / (aid + '.json')).read_bytes()) for aid, _, _, _ in expected}
now = time.time_ns() // 1000000
for aid, ticket in saved_tickets.items():
    ticket['issuedAt'] = now - 1200000; ticket['expiresAt'] = now - 600001
    (tickets / (aid + '.json')).write_text(json.dumps(ticket))
original = {file.name: file.read_bytes() for file in tickets.iterdir()}
def denied(**kwargs):
    try: run(**kwargs)
    except RuntimeError: return
    raise AssertionError('不满足门控不能刷新')
# 任一已占用预算或持久attempt都必须全局拒绝，所有票字节不变。
attempt = tickets / '2.attempt.json'; attempt.write_text('{}'); denied(prepare=True); attempt.unlink()
assert original == {file.name: file.read_bytes() for file in tickets.iterdir()}
lock = locks / '2.json'; lock_raw = lock.read_bytes(); changed = json.loads(lock_raw); changed['recoveryAttempt'] = {'phase': 'unconfirmed'}
lock.write_text(json.dumps(changed)); denied(prepare=True); lock.write_bytes(lock_raw)
assert original == {file.name: file.read_bytes() for file in tickets.iterdir()}
for field, value in [('ownerGid', 999), ('stateSha256', 'f' * 64), ('expiresAt', now + 1000)]:
    ticket = {**saved_tickets['2'], field: value}; file = tickets / '2.json'; old_raw = file.read_bytes()
    file.write_text(json.dumps(ticket)); denied(prepare=True); file.write_bytes(old_raw)
refreshed = run(prepare=True); assert set(refreshed['refreshedExpiredUnattemptedAccountIds']) == {'1', '2', '10'}
assert len(list(tickets.glob('*.expired-*.json'))) == 3
fresh = {file.name: file.read_bytes() for file in tickets.glob('[0-9]*.json')}
denied(prepare=True); assert fresh == {file.name: file.read_bytes() for file in tickets.glob('[0-9]*.json')}
# recreate 后只用sha一致归档；不读取新容器日志。
with patch('subprocess.run', side_effect=AssertionError('不能读取新容器日志')), \
     patch('subprocess.check_output', side_effect=AssertionError('归档不需旧容器inspect')):
    saved = sys.stdin; output = io.StringIO(); sys.stdin = io.StringIO(json.dumps(payload))
    try:
        with patch('hashlib.sha256', digest), contextlib.redirect_stdout(output): exec(raw_script, {})
    finally: sys.stdin = saved
assert json.loads(output.getvalue())['logsArchived'] is True
archive.write_bytes(archive_raw + b'changed'); denied(); archive.write_bytes(archive_raw)
# AST加载纯本地helper，不import部署模块、不连接服务器、不读取任何真实凭据。
def load_functions(names, env):
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), env)
env = {'pathlib': pathlib, 'io': io, 'json': json, 'shlex': shlex, 'REMOTE': '/fixture/project', 'BASE': str(root),
       'tarfile': tarfile, 'hashlib': hashlib, 'RELEASE_BACKEND_ALLOWLIST': {'core/src/services/friend-api.js', 'core/src/runtime/data-provider.js'},
       'RELEASE_STATIC_ALLOWLIST': set(), 'RELEASE_COMBINED_MIGRATION': constants['RELEASE_COMBINED_MIGRATION']}
load_functions({'app_only_compose_command', 'load_panel_credentials', 'remote_file_json', 'registered_release_artwork', 'load_release_manifest'}, env)
assert "-f /fixture/project/docker-compose.yml build qq-farm-bot" in env['app_only_compose_command']('build', 'qq-farm-bot')
command = env['app_only_compose_command']('up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'qq-farm-bot')
assert '--no-deps' in command and 'farm-gateway' not in command
for args in [('restart', 'farm-gateway'), ('build', 'farm-gateway'), ('up', '-d', 'qq-farm-bot'),
             ('build', 'farm-gateway', 'qq-farm-bot'),
             ('up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never', 'farm-gateway', 'qq-farm-bot')]:
    try: env['app_only_compose_command'](*args)
    except RuntimeError: pass
    else: raise AssertionError('非法compose动作未拦截')
(root / 'HANDOVER.md').write_text('| 面板管理员 | ' + chr(96) + 'fixture-user' + chr(96) + ' / ' + chr(96) + 'fixture-pass' + chr(96) + '\n', encoding='utf-8')
with patch.dict('os.environ', {'FARM_ADMIN_USER': 'wrong', 'FARM_ADMIN_PASS': 'wrong'}):
    assert env['load_panel_credentials']() == {'username': 'fixture-user', 'password': 'fixture-pass'}
class Channel:
    def shutdown_write(self): pass
    def recv_exit_status(self): return 0
class Stream(io.BytesIO):
    channel = Channel()
class Input(io.StringIO):
    channel = Channel()
class Sftp:
    def stat(self, path): return types.SimpleNamespace(st_size=len(self.raw) if hasattr(self, 'raw') else 0)
    def putfo(self, file, path, file_size): self.raw = file.read(); self.path = path
    def chmod(self, path, mode): assert mode == 0o600
    def close(self): pass
class Client:
    def __init__(self): self.sftp = Sftp(); self.input = Input(); self.calls = []
    def open_sftp(self): return self.sftp
    def exec_command(self, command, timeout):
        self.calls.append(command)
        return self.input, Stream(b'progress output\n[{"ok":true}]\n'), Stream(b'')
client = Client(); response = env['remote_file_json'](client, 'print("safe")', {'credentials': {'username': 'fixture'}}, script_name='fixture_step.py')
assert response == [{'ok': True}] and len(client.calls) == 1
assert ' -c ' not in client.calls[0] and 'credentials' not in client.calls[0]
assert json.loads(client.input.getvalue())['credentials']['username'] == 'fixture'
# 发布包遗漏provider必须阻断，加入真实接线才放行。
def package(provider):
    files = {'core/src/services/friend-api.js': b'async function recoverLegacyFriendVisit() {}'}
    if provider: files['core/src/runtime/data-provider.js'] = b'recoverLegacyFriendVisit: () => {}'
    manifest = {'name': 'fixture', 'files': [{'path': k, 'size': len(v), 'sha256': real_sha(v).hexdigest()} for k, v in files.items()]}
    file = root / ('complete.tar.gz' if provider else 'omitted.tar.gz')
    with tarfile.open(file, 'w:gz') as tar:
        for name, raw in {**files, 'release-manifest.json': json.dumps(manifest).encode()}.items():
            item = tarfile.TarInfo(name); item.size = len(raw); tar.addfile(item, io.BytesIO(raw))
    return str(file)
try: env['load_release_manifest'](package(False))
except RuntimeError: pass
else: raise AssertionError('遗漏provider接线未阻断')
assert env['load_release_manifest'](package(True))['name'] == 'fixture'
# 恢复执行脚本用假HTTP验证成功判据/单次预算，不读真实凭据、不连服务器。
import runpy
execute = runpy.run_path(str(source.parents[2] / '.workbuddy/recover_execute.py'))['run_recovery']
def simulate(mode, enabled=True):
    calls = []
    plan = {'eligible': True, 'dryRun': True, 'gameRpcSent': False, 'enterWillBeSent': False,
            'accountId': '1', 'gid': 10001, 'epoch': 4, 'action': 'complete_original_leave_once',
            'evidenceId': 'a' * 64, 'stateSha256': 'b' * 64}
    def api(url, body=None, account=None):
        calls.append((url, body))
        if url == '/api/status':
            return 200, {'ok': True, 'data': {'running': True, 'connection': {'connected': mode != 'running_only'}, 'status': {'level': 106}}}
        if url == '/api/friends/visit/recover' and body['dryRun']:
            return 200, {'ok': True, 'data': plan}
        if url == '/api/friends/visit/recover':
            if mode == 'leave_timeout': return 0, {'ok': False, 'error': 'TimeoutError'}
            return 200, {'ok': True, 'data': {'accountId': '1', 'gid': 10001, 'epoch': 4, 'recovered': True,
                'proof': 'wrong' if mode == 'wrong_proof' else 'leave_confirmed', 'leaveSentOnce': True, 'enterSent': False}}
        if url == '/api/friend/10001/lands':
            return 200, {'ok': True, 'data': {'lands': [] if mode == 'empty_lands' else [{'id': 1, 'status': 'empty'}]}}
        if url == '/api/runtime/transport':
            return 200, {'ok': True, 'data': {'worker': {'connected': True, 'friendVisit': {'recoveryRequired': False}}}}
        raise AssertionError('错误路由: ' + url)
    results = execute({'accountIds': ['1'], 'execute': enabled}, api)
    posts = [body for url, body in calls if url == '/api/friends/visit/recover' and not body['dryRun']]
    assert len(posts) <= 1 and all(url != '/api/friends/lands' for url, _ in calls)
    return results[0], calls, posts
for mode in ['leave_timeout', 'wrong_proof']:
    result, calls, posts = simulate(mode)
    assert result['result'] == 'FAILED_UNCONFIRMED_NO_RETRY' and len(posts) == 1
    assert not any(url.endswith('/lands') for url, _ in calls)
assert simulate('success')[0]['result'] == 'RECOVERED_AND_LANDS_CONFIRMED'
assert simulate('empty_lands')[0]['result'] == 'LEAVE_CONFIRMED_LANDS_NOT_CONFIRMED'
assert not simulate('running_only')[2]
assert simulate('success', enabled=False)[0]['result'] == 'DRY_RUN_ELIGIBLE'
assert not simulate('success', enabled=False)[2]
print(json.dumps({'ok': True, 'cases': 22, 'noGameRpc': True}))
`;
    const output = execFileSync(python, ['-c', script, path.join(__dirname, '../../cloudbase/.ref/deploy.py'), dir], {
        encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    assert.equal(JSON.parse(output).ok, true);
});

test('friend Visit本地隔离实盘：使用真实原子JSON写入，两模块重载保留unknown不覆盖账号配置', async () => {
    const tmpRoot = process.env.TMPDIR || path.join(__dirname, '../../.workbuddy/tests-deploy-20261109/tmp');
    assert.ok(fs.statSync(tmpRoot).isDirectory());
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'friend-visit-persistence-'));
    const jsonDb = require('../src/services/json-db');
    const file = path.join(dir, 'friend-visit-state', '2.json');
    jsonDb.writeJsonFileAtomic(file, { version: 1, accountId: '2', gid: 0, epoch: 7, phase: 'left',
        proof: 'leave_confirmed', updatedAt: 1000000 });
    const time = fakeClock();
    const load = () => loadSource('friendSession', { 'node:fs': fs, 'node:path': path,
        'node:crypto': { createHash: require('node:crypto').createHash },
        '../config/runtime-paths': { getDataFile: name => path.join(dir, name) },
        './json-db': jsonDb, '../utils/request-priority': requestPriority(time),
        './account-operation-coordinator': { assertSceneOperationAvailable: noop },
        './ranch-friend-session': { getRanchFriendSessionSnapshot: () => ({ resultState: 'idle' }) },
    }, { time, processRef: fakeProcess({ FARM_ACCOUNT_ID: '2' }) }).api;
    const first = load();
    const token = await first.acquireFriendVisitSession(11, { accountId: '2', epoch: 7 });
    first.markFriendVisitSessionUnknown(token, Object.assign(new Error('不保存的原始secret'), {
        errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, resultState: 'unknown', outcomeUnknown: true,
    }));
    token.settled = true; first.releaseFriendVisitSession(token);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(raw).phase, 'unknown');
    assert.ok(!raw.includes('secret'));
    const restarted = load();
    await assert.rejects(restarted.acquireFriendVisitSession(22, { accountId: '2', epoch: 7 }), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.equal(restarted.getFriendVisitSessionSnapshot('2').recoveryRequired, true);
    assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'store.json')), false);
    assert.ok(fs.readdirSync(path.dirname(file)).every(name => !name.endsWith('.tmp')));
});

test('friend Visit持久化：未Leave或unknown跨worker保留，同epoch/IPC重连不能清除', async () => {
    const storage = friendVisitMemory();
    const h = loadFriendHarness({ visitStorage: storage });
    const failure = Object.assign(new Error('Leave真实失败'), { errorCode: 'REQUEST_TIMEOUT', stage: 'transport',
        sent: true, resultState: 'unknown', outcomeUnknown: true, privateToken: '不得写入记录' });
    h.setRpc(async (_service, method) => { if (method === 'Leave') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop));
    assert.equal(storage.writes.at(-1).phase, 'unknown');
    assert.ok(!JSON.stringify(storage.writes).includes('不得写入记录'));
    const restarted = loadFriendHarness({ visitStorage: storage });
    const blocked = await restarted.analyzer.getFriendLandsDetail(22).catch(error => error);
    assert.equal(blocked.errorCode, 'VISIT_STATE_UNKNOWN');
    assert.equal(restarted.calls.length, 0);
    assert.equal(restarted.state().unknownStage, 'transport');
    assert.equal(restarted.state().unknownResultState, 'unknown');
    restarted.setSnapshot({ connectionEpoch: 100, sessionEpoch: 300 });
    await assert.rejects(restarted.analyzer.getFriendLandsDetail(22));
    restarted.setSnapshot({ remoteGeneration: 6 });
    await assert.rejects(restarted.analyzer.getFriendLandsDetail(22), '旧代际不能清掉新代际的未知锁');
    restarted.setSnapshot({ remoteGeneration: 8 });
    await restarted.analyzer.getFriendLandsDetail(22);
    assert.equal(restarted.state().resultState, 'idle');
    assert.equal(storage.writes.at(-1).phase, 'left');
    assert.deepEqual(restarted.calls.map(call => call.method), ['Enter', 'Leave']);
});

test('friend Visit持久化：active崩溃记录封闭新worker，缺失旧证据不从null epoch猜测恢复', async () => {
    const storage = friendVisitMemory();
    const h = loadFriendHarness({ visitStorage: storage });
    const token = await h.session.acquireFriendVisitSession(11, { accountId: '2', epoch: 7 });
    assert.equal(storage.writes.at(-1).phase, 'active');
    const restarted = loadFriendHarness({ visitStorage: storage });
    await assert.rejects(restarted.analyzer.getFriendLandsDetail(22), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.equal(restarted.calls.length, 0);
    token.settled = true; h.session.releaseFriendVisitSession(token);
    assert.equal(storage.writes.at(-1).phase, 'unknown', '无真实Leave不能因finally就写成idle');
    storage.files.clear();
    const missing = loadFriendHarness({ visitStorage: storage });
    await assert.rejects(missing.api.withFriendVisitSession(22, noop), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.equal(missing.state().observedTransportEpoch, 7, '第一真实观测仍闭锁，只保存未知基线');
    const same = loadFriendHarness({ visitStorage: storage });
    await assert.rejects(same.api.withFriendVisitSession(22, noop));
    assert.equal(same.calls.length, 0);
    same.setSnapshot({ connectionEpoch: 100 });
    await assert.rejects(same.api.withFriendVisitSession(22, noop));
    same.setSnapshot({ remoteGeneration: 100 });
    await same.api.withFriendVisitSession(22, noop);
    assert.equal(same.state().resultState, 'idle', '只有后续真实游戏代际改变才可恢复');
    assert.deepEqual(same.calls.map(call => call.method), ['Enter', 'Leave']);
});

test('friend Visit持久化：缺失/畸形/错账号/错epoch记录闭锁，保存失败不发送Enter', async () => {
    const file = '/memory/data/friend-visit-state/2.json';
    for (const record of [undefined, '', '{broken', { version: 1, accountId: 'wrong', phase: 'left', epoch: 7 },
        { version: 1, accountId: '2', phase: 'left', epoch: null }]) {
        const initial = record === undefined ? {} : { [file]: typeof record === 'string' ? record : JSON.stringify(record) };
        const h = loadFriendHarness({ visitStorage: friendVisitMemory(initial) });
        await assert.rejects(h.analyzer.getFriendLandsDetail(11), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
        assert.equal(h.calls.length, 0);
    }
    const storage = friendVisitMemory(); const h = loadFriendHarness({ visitStorage: storage });
    storage.failWrite = true;
    await assert.rejects(h.api.withFriendVisitSession(11, noop), error => error.errorCode === 'VISIT_STATE_PERSIST_FAILED');
    assert.equal(h.calls.length, 0);
    assert.equal(h.state().recoveryRequired, true);
});

test('friend Visit持久化：Leave回包成功但保存离场证据失败仍保留锁，新worker不得回到idle', async () => {
    const storage = friendVisitMemory(); const h = loadFriendHarness({ visitStorage: storage });
    h.setRpc(async (_service, method) => {
        if (method === 'Leave') storage.failWrite = true;
        return { body: { lands: [] } };
    });
    await assert.rejects(h.api.withFriendVisitSession(11, noop), error => error.errorCode === 'VISIT_STATE_PERSIST_FAILED');
    assert.equal(h.state().recoveryRequired, true);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
    storage.failWrite = false;
    const restarted = loadFriendHarness({ visitStorage: storage });
    await assert.rejects(restarted.api.withFriendVisitSession(22, noop), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.equal(restarted.calls.length, 0);
});

test('friend Visit→worker：已有旧锁的本次未发送调用保留hold元数据，不误标真实游戏未知写', async () => {
    const h = loadFriendHarness();
    h.setRpc(async (_service, method) => {
        if (method === 'Leave') throw Object.assign(new Error('Leave未确认'), {
            errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, resultState: 'unknown', outcomeUnknown: true,
        });
        return { body: { lands: [] } };
    });
    await assert.rejects(h.api.withFriendVisitSession(11, noop));
    const before = h.calls.length;
    const worker = loadWorker({ ...h.priority, getUserState: () => ({ gid: 42 }) }, h.time, { extra: {
        getFriendLandsDetail: h.analyzer.getFriendLandsDetail,
    } });
    await worker.message({ type: 'api_call', id: 601, method: 'getFriendLands', args: [22],
        readOnly: false, deadline: h.time.Date.now() + 90000 });
    const response = worker.processRef.sent.find(value => value.id === 601 && value.type === 'api_response');
    assert.equal(response.errorMeta.errorCode, 'VISIT_STATE_UNKNOWN');
    assert.equal(response.errorMeta.sent, false); assert.equal(response.errorMeta.outcomeUnknown, false);
    assert.equal(response.errorMeta.holdUntilTransportEpochChanged, true);
    assert.equal(response.errorMeta.friendGid, 11);
    assert.equal(h.calls.length, before);
});

test('friend Visit诊断→worker：只读诊断透传持久锁，不发送Enter/Leave或返回凭据', async () => {
    const h = loadFriendHarness();
    const failure = Object.assign(new Error('Leave失败 credential=secret'), { errorCode: 'REQUEST_TIMEOUT',
        stage: 'transport', sent: true, resultState: 'unknown', outcomeUnknown: true });
    h.setRpc(async (_service, method) => { if (method === 'Leave') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop));
    const count = h.calls.length;
    const worker = loadWorker({ getDiagnosticSnapshot: () => ({ connectionEpoch: 2, remoteGeneration: 7 }),
        getUserState: () => ({ gid: 42 }) }, h.time, { extra: {
        getFriendVisitSessionSnapshot: h.api.getFriendVisitSessionSnapshot,
    } });
    const diagnostics = worker.api.getTransportDiagnostics();
    assert.equal(diagnostics.friendVisit.recoveryRequired, true);
    assert.equal(diagnostics.friendVisit.unknownStage, 'transport');
    assert.equal(diagnostics.friendVisit.unknownVisitStage, 'leave');
    assert.equal(h.calls.length, count);
    assert.ok(!JSON.stringify(diagnostics).includes('secret'));
    const writes = h.visitStorage.writes.length;
    h.setSnapshot({ remoteGeneration: 8 });
    assert.equal(worker.api.getTransportDiagnostics().friendVisit.recoveryRequired, true, '诊断不能当恢复动作');
    assert.equal(h.visitStorage.writes.length, writes, '被动诊断不写盘推进状态');
    assert.equal(h.state().recoveryRequired, true);
});

test('friend Visit诊断只含有界元数据，blocked新调用和原unknown错误分开保留', async () => {
    const h = loadFriendHarness(); const failure = Object.assign(new Error('Leave失败 token=secret'), {
        stage: 'transport', visitStage: 'leave', sent: true, resultState: 'unknown', outcomeUnknown: true,
        errorCode: 'REQUEST_TIMEOUT', method: 'Leave', secret: 'private-value',
    });
    h.setRpc(async (_service, method) => { if (method === 'Leave') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop));
    const state = h.state();
    assert.equal(state.unknownStage, 'transport'); assert.equal(state.unknownVisitStage, 'leave');
    assert.equal(state.unknownSent, true); assert.equal(state.unknownOutcomeUnknown, true);
    assert.ok(!JSON.stringify(state).includes('secret')); assert.ok(!JSON.stringify(state).includes('private-value'));
    const blocked = await h.analyzer.getFriendLandsDetail(22).catch(error => error);
    assert.equal(blocked.sent, false); assert.equal(blocked.outcomeUnknown, false);
    assert.equal(blocked.holdUntilTransportEpochChanged, true);
});

function legacyRecoveryHarness({ storage, ticketPatch = {}, statePatch = {}, client } = {}) {
    const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
    const record = { version: 1, accountId: '2', gid: 0, epoch: null, observedEpoch: client ? 7 : 7,
        phase: 'unknown', updatedAt: 1000000, errorMeta: { errorCode: 'VISIT_LEGACY_STATE_UNCONFIRMED',
            stage: 'migration', resultState: 'unknown' }, ...statePatch };
    const visitStorage = storage || friendVisitMemory({ '/memory/data/friend-visit-state/2.json': JSON.stringify(record) });
    const evidence = { service: 'gamepb.plantpb.PlantService', method: 'Harvest', errorCode: 1001040,
        enterConfirmed: true, leaveSent: false, outcomeUnknown: false, friendGid: 11, transportEpoch: 7 };
    const ticket = { version: 1, kind: 'legacy_harvest_rejection_cleanup', accountId: '2', ownerGid: 42,
        gid: 11, hostType: 0, epoch: 7, id: digest('fixture-evidence'),
        sourceSha256: 'de37fb128953ddbf2d5b2389b3fab52a0698d088246aa8fbb0387f9376f3e57d',
        stateSha256: digest(visitStorage.files.get('/memory/data/friend-visit-state/2.json')),
        evidenceSha256: digest(JSON.stringify(evidence)), evidence, issuedAt: 999900, expiresAt: 1500000, ...ticketPatch };
    visitStorage.files.set('/memory/data/friend-visit-recovery/2.json', JSON.stringify(ticket));
    return { ...loadFriendHarness({ visitStorage, client }), ticket };
}

test('friend旧锁恢复：dry-run没有游戏请求或写盘；执行只补单次Leave，确认后才解锁', async () => {
    const h = legacyRecoveryHarness();
    const writes = h.visitStorage.writes.length;
    const plan = await h.api.recoverLegacyFriendVisit({ dryRun: true });
    assert.equal(plan.eligible, true); assert.equal(plan.enterWillBeSent, false); assert.equal(plan.gameRpcSent, false);
    assert.equal(h.calls.length, 0); assert.equal(h.visitStorage.writes.length, writes);
    assert.equal(h.state().recoveryRequired, true);
    const result = await h.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 });
    assert.equal(result.recovered, true); assert.equal(result.enterSent, false);
    assert.deepEqual(h.calls.map(call => call.method), ['Leave']);
    assert.deepEqual(plain(h.calls[0].payload), { host_gid: 11, host_type: 0 });
    assert.equal(h.calls[0].context.signal, undefined);
    const record = JSON.parse(h.visitStorage.files.get('/memory/data/friend-visit-state/2.json'));
    assert.equal(record.phase, 'left'); assert.equal(record.proof, 'leave_confirmed');
    assert.equal(record.recoveryAttempt.phase, 'completed'); assert.equal(h.state().recoveryRequired, false);
    const replay = await h.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 });
    assert.equal(replay.reason, 'already_left'); assert.equal(h.calls.length, 1);
});

test('friend旧锁恢复：证据缺失/篡改/过期/跨账号跨代际及CAS陈旧都不能发送Leave', async () => {
    for (const ticketPatch of [{ accountId: '1' }, { ownerGid: 999 }, { gid: 22 }, { epoch: 8 }, { hostType: 2 },
        { stateSha256: 'f'.repeat(64) }, { evidenceSha256: 'f'.repeat(64) }, { expiresAt: 900000 },
        { issuedAt: 1001000 }, { expiresAt: 2000000 }, { sourceSha256: 'f'.repeat(64) }]) {
        const h = legacyRecoveryHarness({ ticketPatch });
        await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: true }));
        assert.equal(h.calls.length, 0); assert.equal(h.state().recoveryRequired, true);
    }
    const h = legacyRecoveryHarness(); const plan = await h.api.recoverLegacyFriendVisit({ dryRun: true });
    await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: 'stale', stateSha256: plan.stateSha256 }), {
        errorCode: 'VISIT_RECOVERY_CONFIRMATION_STALE',
    });
    assert.equal(h.calls.length, 0);
    h.visitStorage.files.delete('/memory/data/friend-visit-recovery/2.json');
    await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: true }), { errorCode: 'VISIT_RECOVERY_EVIDENCE_MISSING' });
    assert.equal(h.calls.length, 0);
});

test('friend旧锁恢复：旧模块保守锁复现失败，补丁不能靠丢内存标志当恢复', async () => {
    const h = legacyRecoveryHarness();
    await assert.rejects(h.analyzer.getFriendLandsDetail(22), { errorCode: 'VISIT_STATE_UNKNOWN' });
    assert.equal(h.calls.length, 0);
    const second = loadFriendHarness({ visitStorage: h.visitStorage });
    await assert.rejects(second.analyzer.getFriendLandsDetail(22), { errorCode: 'VISIT_STATE_UNKNOWN' });
    assert.equal(second.calls.length, 0);
    const plan = await second.api.recoverLegacyFriendVisit({ dryRun: true });
    assert.equal(second.state().recoveryRequired, true);
    await second.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 });
    assert.deepEqual(second.calls.map(call => call.method), ['Leave']);
    assert.equal(second.state().recoveryRequired, false);
});

test('friend旧锁恢复：真正未知Leave/在途写不能借旧迁移入口清锁', async () => {
    for (const errorMeta of [{ errorCode: 'REQUEST_TIMEOUT', stage: 'transport', visitStage: 'leave', resultState: 'unknown' },
        { errorCode: 'VISIT_STATE_BASELINE_MISSING', resultState: 'unknown' }]) {
        const h = legacyRecoveryHarness({ statePatch: { errorMeta } });
        await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: true }), { errorCode: 'VISIT_RECOVERY_UNSUPPORTED' });
        assert.equal(h.calls.length, 0);
    }
    const h = legacyRecoveryHarness(); h.setSnapshot({ pendingWrites: 1 });
    await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: true }), { errorCode: 'VISIT_RECOVERY_TRANSPORT_BUSY' });
    assert.equal(h.calls.length, 0);
});

test('friend旧锁恢复：失败或重载保留一次性预算，取消及并发不得重放Leave', async () => {
    const h = legacyRecoveryHarness(); const leave = pendingReply(); const controller = new AbortController();
    const plan = await h.api.recoverLegacyFriendVisit({ dryRun: true });
    h.setRpc(async (_service, method) => { assert.equal(method, 'Leave'); return leave.promise; });
    const options = { dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 };
    const request = h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.recoverLegacyFriendVisit(options));
    const rejected = assert.rejects(request, { errorCode: 'REQUEST_TIMEOUT' });
    await flush(); controller.abort();
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].context.signal, undefined);
    assert.equal(JSON.parse(h.visitStorage.files.get('/memory/data/friend-visit-state/2.json')).recoveryAttempt.phase, 'attempted');
    await assert.rejects(h.api.recoverLegacyFriendVisit(options), { errorCode: 'VISIT_RECOVERY_BUSY' });
    await assert.rejects(h.api.withFriendVisitSession(22, noop), { errorCode: 'VISIT_STATE_UNKNOWN' });
    leave.reject(Object.assign(new Error('Leave结果未知'), { errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, resultState: 'unknown' }));
    await rejected;
    assert.equal(h.state().recoveryRequired, true); assert.equal(h.state().processing, false);
    const restarted = loadFriendHarness({ visitStorage: h.visitStorage });
    await assert.rejects(restarted.api.recoverLegacyFriendVisit({ dryRun: true }), { errorCode: 'VISIT_RECOVERY_ALREADY_ATTEMPTED' });
    assert.equal(restarted.calls.length, 0);
});

test('friend旧锁恢复：worker→client实际回包才确认，随后好友土地非空并由唯一Leave收口', async () => {
    const client = loadClient(); client.api.connect('2', '', noop);
    client.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', generation: 7, userState: { gid: 99 } }) + '\n');
    const friends = legacyRecoveryHarness({ client });
    const worker = loadWorker(loadNetwork(client).api, client.time, { extra: {
        recoverLegacyFriendVisit: friends.api.recoverLegacyFriendVisit, getFriendLandsDetail: friends.analyzer.getFriendLandsDetail,
    } });
    const plan = await friends.api.recoverLegacyFriendVisit({ dryRun: true });
    const recovery = worker.message({ type: 'api_call', id: 850, method: 'recoverLegacyFriendVisit',
        args: [{ dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 }],
        readOnly: false, deadline: client.time.Date.now() + 90000 });
    await flush();
    const frame = client.frames.find(value => value.t === 'request');
    assert.equal(frame.method, 'Leave'); assert.equal(friends.state().recoveryRequired, true);
    replyTo(client, frame, { body: Buffer.from('{}').toString('base64') }); await recovery;
    const response = worker.processRef.sent.find(value => value.id === 850 && value.type === 'api_response');
    assert.equal(response.error, null); assert.equal(response.result.recovered, true);
    assert.equal(friends.state().recoveryRequired, false);
    const landsRequest = friends.analyzer.getFriendLandsDetail(22); await flush();
    const enter = client.frames.filter(value => value.t === 'request').at(-1);
    assert.equal(enter.method, 'Enter');
    replyTo(client, enter, { body: Buffer.from(JSON.stringify({ lands: [{ id: 1, level: 6, unlocked: true }] })).toString('base64') });
    await flush(); const leave = client.frames.filter(value => value.t === 'request').at(-1);
    assert.equal(leave.method, 'Leave'); replyTo(client, leave, { body: Buffer.from('{}').toString('base64') });
    assert.equal((await landsRequest).lands.length, 1);
    assert.deepEqual(client.frames.filter(value => value.t === 'request').map(value => value.method), ['Leave', 'Enter', 'Leave']);
    assert.equal(friends.state().recoveryRequired, false); assert.equal(client.time.timers.size, 0);
});

test('friend旧锁恢复：保存预算失败不发送；Leave成功但离场落盘失败仍保持unknown', async () => {
    const h = legacyRecoveryHarness(); const plan = await h.api.recoverLegacyFriendVisit({ dryRun: true });
    h.visitStorage.failWrite = true;
    await assert.rejects(h.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: plan.evidenceId, stateSha256: plan.stateSha256 }), {
        errorCode: 'VISIT_STATE_PERSIST_FAILED',
    });
    assert.equal(h.calls.length, 0); assert.equal(h.state().recoveryRequired, true);
    const second = legacyRecoveryHarness(); const next = await second.api.recoverLegacyFriendVisit({ dryRun: true });
    second.setRpc(async () => { second.visitStorage.failWrite = true; return { body: {} }; });
    await assert.rejects(second.api.recoverLegacyFriendVisit({ dryRun: false, evidenceId: next.evidenceId, stateSha256: next.stateSha256 }), {
        errorCode: 'VISIT_STATE_PERSIST_FAILED',
    });
    assert.equal(second.calls.length, 1); assert.equal(second.state().recoveryRequired, true);
    assert.equal(second.state().processing, false);
});

test('虫草官方候选：已有一份虫草不可再放，虫草独立且成熟死亡排除', () => {
    const h = loadFriendHarness();
    const land = (id, weedOwners, bugOwners, phase = 2) => ({ id, plant: { id: 2, phases: [{ phase }],
        weed_owners: weedOwners, insect_owners: bugOwners } });
    const analysis = h.analyzer.analyzeFriendLands([
        land(1, [], []), land(2, [0], []), land(3, [], [77]), land(4, [42], [42]),
        land(5, [77, 88], [77, 88]), land(6, [], [], 6), land(7, [], [], 7),
    ], 42);
    assert.deepEqual(plain(analysis.canPutBug), [1, 2]);
    assert.deepEqual(plain(analysis.canPutWeed), [1, 3]);
});

test('虫草官方放置请求带host_type与reason，编号与除草杀虫不能混用', async () => {
    const h = loadFriendHarness();
    h.api.extractReplyFriends({ game_friends: [{ gid: 11, host_type: 1 }] });
    h.setRpc(async (_service, method, payload) => ({ body: method.startsWith('Put')
        ? { land: [{ id: payload.land_ids[0] }] } : { lands: [] } }));
    await h.api.withFriendVisitSession(11, async () => {
        await h.api.putFriendItemsDetailed(11, [1], 'PutInsects');
        await h.api.putFriendItemsDetailed(11, [2], 'PutWeeds');
    });
    for (const call of h.calls.filter(call => call.method.startsWith('Put'))) {
        assert.equal(call.payload.host_type, 1); assert.equal(call.payload.reason, 2);
    }
    const h2 = loadFriendHarness({ automation: { friend_bad: true } });
    h2.setRpc(async (_service, method, payload) => {
        if (method === 'CheckCanOperate') throw new Error('官方坏操作不得发预检查');
        return { body: method === 'Enter' ? { lands: [{ id: 1, plant: { id: 2, phases: [{ phase: 2 }], weed_owners: [], insect_owners: [] } }] }
            : method.startsWith('Put') ? { land: [{ id: payload.land_ids[0] }] } : {} };
    });
    const result = await h2.visit.doFriendOperation(11, 'bad');
    assert.equal(result.bugCount, 1); assert.equal(result.weedCount, 1);
    assert.deepEqual(h2.calls.map(call => call.method), ['Enter', 'PutInsects', 'PutWeeds', 'Leave']);
    assert.equal(h2.badBudget(), 97);
});

test('虫草自动轮次只做捣乱：开启帮助偷取也不先帮助或偷取、空土地不发预检查', async () => {
    const h = loadFriendHarness({ automation: { friend_bad: true, friend_help: true, friend_steal: true } });
    h.setRpc(async (_service, method, payload) => {
        if (['CheckCanOperate', 'Farming', 'Harvest'].includes(method)) throw new Error('坏操作不应串入帮助偷取');
        return { body: method === 'Enter' ? { lands: [{ id: 1, plant: { id: 2, phases: [{ phase: 2 }], dry_num: 1, weed_owners: [], insect_owners: [] } }] }
            : method.startsWith('Put') ? { land: [{ id: payload.land_ids[0] }] } : {} };
    });
    const tally = { putBug: 0, putWeed: 0, weed: 0, bug: 0, water: 0, steal: 0 };
    const result = await h.visit.visitFriend({ gid: 11, name: '目标' }, tally, 42, '2', { onlyBad: true });
    assert.equal(result.count, 2); assert.equal(tally.putBug, 1); assert.equal(tally.putWeed, 1);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'PutInsects', 'PutWeeds', 'Leave']);
    const empty = loadFriendHarness({ automation: { friend_bad: true } });
    await empty.visit.visitFriend({ gid: 11, name: '目标' }, { putBug: 0, putWeed: 0 }, 42, '2', { onlyBad: true });
    assert.deepEqual(empty.calls.map(call => call.method), ['Enter', 'Leave']);
});

test('虫草1001036地块满草跳过后继续不同地块，不清共享预算、不重放拒绝地块', async () => {
    const h = loadFriendHarness();
    h.setRpc(async (_service, method, payload) => {
        if (method === 'PutWeeds' && payload.land_ids[0] === 1) throw Object.assign(new Error('当前植物野草次数达到上限'), {
            errorCode: 1001036, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
        });
        return { body: method === 'PutWeeds' ? { land: [{ id: payload.land_ids[0] }] } : { lands: [] } };
    });
    const result = await h.api.withFriendVisitSession(11, () => h.api.putFriendItemsDetailed(11, [1, 2, 2, 3], 'PutWeeds'));
    assert.equal(result.ok, 2); assert.equal(result.failed[0].kind, 'target_unavailable');
    assert.deepEqual(h.calls.filter(call => call.method === 'PutWeeds').map(call => call.payload.land_ids[0]), [1, 2, 3]);
    assert.deepEqual(h.placementStats, [['putWeed', 1], ['putWeed', 1]]); assert.equal(h.badBudget(), 97);
    assert.equal(h.state().recoveryRequired, false); assert.equal(h.calls.at(-1).method, 'Leave');
});

test('虫草1002002严格数字分类，原中文不是好友也处理且未知同码不能删好友', async () => {
    const h = loadFriendHarness();
    const refusal = Object.assign(new Error('gamepb.visitpb.VisitService.Enter 错误: code=1002002 不是好友无法拜访'), {
        errorCode: 1002002, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
    });
    h.setRpc(async () => { throw refusal; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop), error => error === refusal);
    assert.equal(refusal.friendEnterHandling?.kind, 'invalid_removed');
    assert.deepEqual(plain(h.api.getCurrentKnownGids()), [22]);
    assert.equal(h.state().recoveryRequired, false); assert.equal(h.calls.length, 1);
    const unknown = loadFriendHarness();
    const error = Object.assign(new Error('code=1002002 不是好友无法拜访'), {
        errorCode: 1002002, stage: 'transport', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    unknown.setRpc(async () => { throw error; });
    await assert.rejects(unknown.api.withFriendVisitSession(11, noop));
    assert.deepEqual(plain(unknown.api.getCurrentKnownGids()), [11, 22]);
    assert.equal(unknown.messages.some(message => message.type === 'known_friend_gid_remove'), false);
});

test('虫草逐地块确认：后续目标装不下时保留前面真实统计，允许草且只Leave一次', async () => {
    const h = loadFriendHarness();
    h.setRpc(async (_service, method, payload) => {
        if (method === 'PutInsects' && payload.land_ids[0] === 2) throw Object.assign(new Error('code=1001039 植物虫子数量已达上限'), {
            errorCode: 1001039, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
        });
        return { body: ['PutInsects', 'PutWeeds'].includes(method) ? { land: [{ id: payload.land_ids[0] }] } : { lands: [] } };
    });
    await h.api.withFriendVisitSession(11, async () => {
        const bugs = await h.api.putFriendItemsDetailed(11, [1, 2, 3], 'PutInsects');
        assert.equal(bugs.ok, 2); assert.equal(bugs.failed[0].kind, 'target_unavailable');
        assert.equal((await h.api.putFriendItemsDetailed(11, [1], 'PutWeeds')).ok, 1);
    });
    assert.deepEqual(h.placementStats, [['putBug', 1], ['putBug', 1], ['putWeed', 1]]);
    assert.equal(h.badBudget(), 96);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'PutInsects', 'PutInsects', 'PutInsects', 'PutWeeds', 'Leave']);
    assert.equal(h.state().recoveryRequired, false);
});

test('虫草空回包不记成功、不重放，真正unknown后保留已完成次数且不继续写', async () => {
    for (const kind of ['empty', 'unknown']) {
        const h = loadFriendHarness();
        h.setRpc(async (_service, method, payload) => {
            if (method === 'PutInsects' && payload.land_ids[0] === 2) {
                if (kind === 'empty') return { body: {} };
                throw Object.assign(new Error('timeout'), { sent: true, stage: 'transport', resultState: 'unknown', outcomeUnknown: true });
            }
            return { body: method === 'PutInsects' ? { land: [{ id: payload.land_ids[0] }] } : { lands: [] } };
        });
        await assert.rejects(h.api.withFriendVisitSession(11, () => h.api.putFriendItemsDetailed(11, [1, 2, 3], 'PutInsects')), error => error.resultState === 'unknown');
        assert.deepEqual(h.placementStats, [['putBug', 1]]); assert.equal(h.badBudget(), 98);
        assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'PutInsects', 'PutInsects']);
        assert.equal(h.state().recoveryRequired, true);
    }
});

test('虫草账号级1001047停每日预算，不把目标1001039误作全账号额度', async () => {
    const h = loadFriendHarness();
    h.setRpc(async (_service, method) => {
        if (method === 'PutInsects') throw Object.assign(new Error('code=1001047 daily limit'), {
            errorCode: 1001047, sent: true, stage: 'game_request', resultState: 'failed', outcomeUnknown: false,
        });
        return { body: { lands: [] } };
    });
    await h.api.withFriendVisitSession(11, async () => {
        assert.equal((await h.api.putFriendItemsDetailed(11, [1, 2], 'PutInsects')).failed[0].kind, 'daily_limit');
        assert.equal((await h.api.putFriendItemsDetailed(11, [1], 'PutWeeds')).ok, 0);
    });
    assert.equal(h.badBudget(), 0); assert.deepEqual(h.placementStats, []);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'PutInsects', 'Leave']);
});

test('好友CheckCanOperate带官方host_type字段并同次访问冻结', async () => {
    const h = loadFriendHarness();
    h.api.extractReplyFriends({ game_friends: [{ gid: 11, host_type: 1 }] });
    h.setRpc(async (_service, method) => ({ body: method === 'CheckCanOperate' ? { can_operate: true } : { lands: [] } }));
    await h.api.withFriendVisitSession(11, () => h.api.checkCanOperateRemote(11, 10005));
    assert.deepEqual(h.calls.map(call => call.payload.host_type), [1, 1, 1]);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'CheckCanOperate', 'Leave']);
});

test('每日虫草预算同日重挂载保留，统计比预算新时取较大值且跨日清掉服务端满额标记', () => {
    const time = fakeClock(); const io = new Map();
    const date = () => new time.Date(time.Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const accountPath = '/memory/data/bad-count/2.json';
    let statCount = 5;
    io.set(accountPath, JSON.stringify({ date: date(), count: 2 }));
    const h = loadSource('friendLimits', {
        'fs': { readFileSync: file => io.get(file), mkdirSync: noop }, 'path': path.posix,
        './json-db': { writeJsonFileAtomic: (file, value) => io.set(file, JSON.stringify(value)) },
        '../utils/utils': { toNum: x => Number(x) || 0, toLong: x => x, getServerTimeSec: () => time.Date.now() / 1000,
            log: noop, logWarn: noop, sleep: async () => {} },
        '../utils/network': { getUserState: () => ({}) }, '../utils/proto': { types: {} },
        './stats': { recordOperation: noop, getOperationCount: key => key === 'putBug' ? statCount : 0 },
    }, { time, processRef: fakeProcess({ FARM_DATA_DIR: '/memory/data' }) }).api;
    h.initLocalBadCount('2'); assert.equal(h.getBadRemainingTimes(), 94);
    h.markBadDailyLimitReached(); assert.equal(h.getBadRemainingTimes(), 0);
    h.initLocalBadCount('2'); assert.equal(h.getBadRemainingTimes(), 0);
    time.Date.now = () => 86400000 + 1000000;
    assert.equal(h.getBadRemainingTimes(), 99);
    const stored = JSON.parse(io.get(accountPath)); assert.equal(stored.count, 0); assert.equal(stored.dailyLimitReached, false);
});

function badOrchestratorHarness() {
    const time = fakeClock(); const logs = [], patches = [], visits = []; let budget = 99;
    let retryDate = ''; let onVisit = async () => ({ count: 0, message: '没有可捣乱土地' });
    let invalidGids = new Set(), badTargets = [], quietGids = new Set();
    let candidates = [{ gid: 11, name: '真实好友', level: 100, plant: { insect_num: 10 } }, { gid: 10001, name: '小果', level: 100 }];
    const store = { isAutomationOn: () => true, getAutomation: () => ({ friend_visit_max_per_run: 12, friend_visit_cooldown_min: 10 }),
        getFriendBlacklist: () => [], getFriendBadTargets: () => badTargets, getFriendBadRetryDate: () => retryDate,
        applyConfigSnapshot: patch => { patches.push(patch); retryDate = patch.friendBadRetryDate || ''; },
        readFriendDogInfoCache: () => ({}), getStealPlans: () => [], getFriendQuietHours: () => ({ enabled: false }) };
    const friendRefusals = loadFriendHarness().api;
    const api = loadSource('friendOrchestrator', {
        '../config/config': { CONFIG: {} }, '../models/store': store,
        '../utils/network': { getUserState: () => ({ gid: 42 }), isConnected: () => true, networkEvents: new EventEmitter() },
        '../utils/utils': { toNum: x => Number(x) || 0, log: (...args) => logs.push(args), logWarn: (...args) => logs.push(args),
            getServerTimeSec: () => time.Date.now() / 1000, randomDelay: async () => {} },
        './farm': { setOperationLimitsCallback: noop }, './scheduler': { createScheduler: () => fakeScheduler(time) },
        './friend-api': { getAllFriends: async () => ({ game_friends: candidates }), extractReplyFriends: value => value.game_friends,
            getInvalidKnownFriendGidSet: () => invalidGids, isConfirmedFriendRefusal: friendRefusals.isConfirmedFriendRefusal,
            classifyBadOperationFailure: friendRefusals.classifyBadOperationFailure, parseRpcErrorCode: friendRefusals.parseRpcErrorCode,
            inFriendQuietHours: gid => quietGids.has(gid), postToMaster: patch => patches.push(patch), SYSTEM_NPC_FRIENDS: [{ gid: 10001, name: '小果', level: 100 }],
            SYSTEM_NPC_GIDS: new Set([10001]) },
        './friend-operation-limits': { checkDailyReset: noop, canOperateBad: () => budget > 0,
            getBadBudgetSnapshot: () => ({ remaining: budget, used: 99 - budget, limit: 99 }), updateOperationLimits: noop },
        './friend-visit': { visitFriend: async (target, _tally, _gid, _account, options) => {
            assert.equal(options.onlyBad, true); visits.push(target.gid); return onVisit(target);
        } },
        './friend-visit-plan': {}, './friend-visit-pacing': { selectFriendVisitBatch: list => list },
        './warehouse': {}, './friend-land-analyzer': {},
    }, { time, processRef: fakeProcess({ FARM_ACCOUNT_ID: '2' }) }).api;
    return { api, logs, patches, visits, setOnVisit: fn => { onVisit = fn; }, setCandidates: list => { candidates = list; },
        setInvalid: values => { invalidGids = new Set(values); }, setBadTargets: values => { badTargets = values; },
        setQuiet: values => { quietGids = new Set(values); } };
}

test('虫草目标1001039或1002002跳过不累计全账号连续失败，非零预算不能标今日完成', async () => {
    const h = badOrchestratorHarness();
    h.setOnVisit(async target => { throw Object.assign(new Error(target.gid === 10001 ? 'code=1001039 植物虫子数量已达上限' : 'code=1002002 不是好友'), {
        stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
        friendEnterHandling: target.gid === 11 ? { handled: true } : undefined,
    }); });
    for (let i = 0; i < 4; i++) await h.api.runBadHourly();
    assert.equal(h.patches.length, 0);
    assert.ok(h.visits.includes(11), '有虫草的列表信号不排除真实好友');
    assert.equal(h.api.getBadTaskSnapshot().paused, false);
    assert.equal(h.api.getBadTaskSnapshot().budget.remaining, 99);
    assert.equal(h.api.getBadTaskSnapshot().lastRun.reason, 'round_complete');
});

test('虫草原始1002002明确拒绝无预先handled也不累计账号失败，unknown不能因上限文案忽略', async () => {
    const h = badOrchestratorHarness();
    h.setOnVisit(async () => { throw Object.assign(new Error('gamepb.visitpb.VisitService.Enter 错误: code=1002002 不是好友无法拜访'), {
        errorCode: 1002002, stage: 'game_request', visitStage: 'enter', sent: true, resultState: 'failed', outcomeUnknown: false,
    }); });
    for (let i = 0; i < 4; i++) await h.api.runBadHourly();
    assert.equal(h.patches.length, 0); assert.equal(h.api.getBadTaskSnapshot().paused, false);
    assert.equal(h.logs.some(row => row[2]?.event === '捣乱失败计数'), false);
    const unsafe = badOrchestratorHarness();
    unsafe.setOnVisit(async () => { throw Object.assign(new Error('code=1001036 当前植物野草次数达到上限'), {
        stage: 'transport', errorCode: 1001036, sent: true, resultState: 'unknown', outcomeUnknown: true,
    }); });
    await unsafe.api.runBadHourly();
    assert.equal(unsafe.visits.length, 1); assert.equal(unsafe.api.getBadTaskSnapshot().lastRun.reason, 'unknown_operation');
    assert.equal(unsafe.patches.length, 0);
});

test('虫草预算仅按本地已确认总数约束，旧10005/06除草杀虫计数不能阻断放虫草', () => {
    const time = fakeClock();
    const h = loadSource('friendLimits', {
        'fs': { readFileSync: () => { throw new Error('ENOENT'); } }, 'path': path.posix,
        './json-db': { writeJsonFileAtomic: noop },
        '../utils/utils': { toNum: x => Number(x) || 0, toLong: x => x, getServerTimeSec: () => time.Date.now() / 1000, log: noop },
        '../utils/network': {}, '../utils/proto': {}, './stats': { recordOperation: noop, getOperationCount: () => 0 },
    }, { time, processRef: fakeProcess({ FARM_DATA_DIR: '/memory/data' }) }).api;
    assert.equal(h.PUT_BUG_OPERATION_ID, 10004); assert.equal(h.PUT_WEED_OPERATION_ID, 10003);
    assert.equal(h.OP_NAMES[10005], '帮好友除草'); assert.equal(h.OP_NAMES[10006], '帮好友除虫');
    h.initLocalBadCount('2');
    h.updateOperationLimits([{ id: 10005, day_times: 99, day_times_lt: 99 }, { id: 10006, day_times: 99, day_times_lt: 99 }]);
    assert.equal(h.getBadRemainingTimes(), 99);
});

test('虫草已确认失效指定GID不会被兜底加回，安静时段指定好友也不能绕过', async () => {
    const h = badOrchestratorHarness();
    h.setCandidates([{ gid: 11, name: '失效目标', level: 100 }]);
    h.setBadTargets([11, 22]); h.setInvalid([11]); h.setQuiet([22]);
    await h.api.runBadHourly();
    assert.deepEqual(h.visits, []); assert.equal(h.patches.length, 0);
    assert.equal(h.api.getBadTaskSnapshot().lastRun.reason, 'no_targets');
});

test('虫草普通合并巡查不会绕过捣乱白名单和暂停，坏操作专轮不额外偷帮', async () => {
    const h = loadFriendHarness({ automation: { friend_bad: true } });
    h.setRpc(async (_service, method) => ({ body: method === 'Enter' ? {
        lands: [{ id: 1, plant: { id: 2, phases: [{ phase: 2 }], weed_owners: [], insect_owners: [] } }],
    } : {} }));
    await h.visit.visitFriend({ gid: 11, name: '非捣乱目标' }, { putBug: 0, putWeed: 0 }, 42, '2');
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
    assert.equal(h.badBudget(), 99);
});

test('虫草PlantOpreateTimesLimit结束当前类型但不冒充每日99，PlantNotFriend停止同好友后续写', async () => {
    for (const code of [1001046, 1001048]) {
        const h = loadFriendHarness();
        h.setRpc(async (_service, method, payload) => {
            if (method === 'PutInsects') throw Object.assign(new Error(`code=${code} confirmed refusal`), {
                errorCode: code, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
            });
            return { body: method === 'PutWeeds' ? { land: [{ id: payload.land_ids[0] }] } : { lands: [] } };
        });
        await h.api.withFriendVisitSession(11, async () => {
            const bugs = await h.api.putFriendItemsDetailed(11, [1, 2, 3], 'PutInsects');
            assert.equal(bugs.failed[0].kind, code === 1001046 ? 'operation_limit' : 'friend_unavailable');
            const weeds = await h.api.putFriendItemsDetailed(11, [1], 'PutWeeds');
            assert.equal(weeds.ok, code === 1001046 ? 1 : 0);
        });
        assert.deepEqual(h.calls.map(call => call.method), code === 1001046
            ? ['Enter', 'PutInsects', 'PutWeeds', 'Leave'] : ['Enter', 'PutInsects', 'Leave']);
        assert.equal(h.badBudget(), code === 1001046 ? 98 : 99); assert.equal(h.state().recoveryRequired, false);
    }
});

test('虫草未知和未发送只停本轮，不积累三次次日暂停；明确非目标故障仍保留保护', async () => {
    for (const kind of ['unknown', 'not_sent']) {
        const h = badOrchestratorHarness();
        h.setOnVisit(async () => { throw Object.assign(new Error('code=1001036 当前植物野草次数达到上限'), {
            errorCode: 1001036, stage: 'transport', sent: kind === 'unknown',
            resultState: kind, outcomeUnknown: kind === 'unknown',
        }); });
        for (let i = 0; i < 4; i++) await h.api.runBadHourly();
        assert.equal(h.patches.length, 0); assert.equal(h.api.getBadTaskSnapshot().paused, false);
        assert.equal(h.visits.length, 4);
        assert.equal(h.api.getBadTaskSnapshot().lastRun.reason, kind === 'unknown' ? 'unknown_operation' : 'transport_unavailable');
    }
    const rejected = badOrchestratorHarness();
    rejected.setOnVisit(async () => { throw Object.assign(new Error('code=1000020 参数错误'), {
        errorCode: 1000020, stage: 'game_request', sent: true, resultState: 'failed', outcomeUnknown: false,
    }); });
    await rejected.api.runBadHourly(); await rejected.api.runBadHourly();
    assert.equal(rejected.api.getBadTaskSnapshot().paused, true);
});

test('虫草结构化地块拒绝不看上限文案，不能把含上限的未知错误当安全跳过', async () => {
    const h = badOrchestratorHarness();
    h.setOnVisit(async () => ({ count: 0, message: '任意语言的目标拒绝',
        failed: [{ landId: 1, kind: 'target_unavailable', errorCode: 1001036 }] }));
    for (let i = 0; i < 4; i++) await h.api.runBadHourly();
    assert.equal(h.patches.length, 0); assert.equal(h.api.getBadTaskSnapshot().paused, false);
});

test('虫草旧limits导出只委派单一会话实现，不另发RPC或重复记预算统计', async () => {
    const delegated = [];
    const api = loadSource('friendLimits', {
        'fs': {}, 'path': path.posix, './json-db': { writeJsonFileAtomic: forbidden('旧入口重复预算落盘') },
        '../utils/utils': { toNum: x => Number(x) || 0, toLong: x => x },
        '../utils/network': { sendMsgAsync: forbidden('旧入口重复RPC') }, '../utils/proto': { types: {} },
        './friend-api': { putFriendItemsDetailed: async (gid, ids, method) => { delegated.push({ gid, ids, method }); return { ok: 2, failed: [] }; } },
    }).api;
    assert.equal(await api.putInsects(11, [1, 2]), 2);
    assert.equal((await api.putWeedsDetailed(11, [3, 4])).ok, 2);
    assert.deepEqual(plain(delegated), [{ gid: 11, ids: [1, 2], method: 'PutInsects' }, { gid: 11, ids: [3, 4], method: 'PutWeeds' }]);
});

test('虫草unknown立即停止本轮且不重放；并发启动不产生两组访问', async () => {
    const h = badOrchestratorHarness(); const pending = pendingReply();
    h.setOnVisit(async () => pending.promise);
    const first = h.api.runBadHourly(); await flush();
    await h.api.runBadHourly(); assert.equal(h.visits.length, 1);
    pending.reject(Object.assign(new Error('unknown timeout'), { resultState: 'unknown', outcomeUnknown: true }));
    await first; assert.equal(h.visits.length, 1);
    assert.equal(h.api.getBadTaskSnapshot().lastRun.reason, 'unknown_operation');
});

test('friend HostType：只采服务端值，同一Enter与Leave固定一致不随列表更新变化', async () => {
    const h = loadFriendHarness();
    h.api.extractReplyFriends({ game_friends: [{ gid: 11, host_type: 1 }] });
    await h.api.withFriendVisitSession(11, () => h.api.extractReplyFriends({ game_friends: [{ gid: 11, host_type: 3 }] }));
    assert.deepEqual(h.calls.map(call => call.payload.host_type), [1, 1]);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
});

test('friend Visit：nested同GID一次Enter，Leave和release只属于外层', async () => {
    const h = loadFriendHarness();
    await h.api.withFriendVisitSession(11, async reply => {
        await h.api.withFriendVisitSession(11, async nested => {
            assert.equal(reply, nested); await h.api.enterFriendFarm(11); await h.api.leaveFriendFarm(11);
            assert.equal(h.calls.length, 1); assert.equal(h.state().processing, true);
        });
        assert.equal(h.state().processing, true);
    });
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']);
    assert.equal(h.state().processing, false); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：Enter成功后页面取消，底层结算才发独立30秒Leave', async () => {
    const h = loadFriendHarness(); const operation = pendingReply(); const leave = pendingReply();
    const controller = new AbortController();
    h.setRpc(async (_service, method) => method === 'Leave' ? leave.promise : { body: { lands: [] } });
    const result = h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.withFriendVisitSession(11, () => operation.promise));
    const rejected = assert.rejects(result); await flush(); controller.abort(new Error('页面取消')); await rejected;
    assert.equal(h.state().processing, true); assert.deepEqual(h.calls.map(call => call.method), ['Enter']);
    operation.resolve(); await flush();
    const cleanup = h.calls.at(-1);
    assert.equal(cleanup.method, 'Leave'); assert.equal(cleanup.context.signal, undefined);
    assert.equal(cleanup.context.deadline, h.time.Date.now() + 30000); assert.equal(cleanup.meta.timeoutMs, 30000);
    assert.equal(h.state().processing, true);
    leave.resolve({ body: {} }); await flush();
    assert.equal(h.state().processing, false); assert.equal(h.state().resultState, 'idle'); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：事务deadline不释放processing，await后不得续写', async () => {
    const h = loadFriendHarness(); const pending = pendingReply();
    const result = h.priority.runWithRequestContext({ deadline: h.time.Date.now() + 100 }, () => h.api.withFriendVisitSession(11, async () => {
        await h.api.runFriendVisitOperation(11, () => pending.promise);
        await h.api.friendFarming(11, [1]);
    }));
    const rejected = assert.rejects(result); await flush(); await h.time.advance(100); await rejected;
    assert.equal(h.state().processing, true); await assert.rejects(h.api.withFriendVisitSession(22, noop));
    pending.resolve(); await flush();
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']); assert.equal(h.state().resultState, 'idle');
    assert.equal(h.time.timers.size, 0);
});

test('friend Visit：sentfalse Enter失败不Leave，原错误不丢meta', async () => {
    const h = loadFriendHarness(); const failure = Object.assign(new Error('未发送'), { errorCode: 'HEALTH_BACKOFF', sent: false, resultState: 'not_sent', meta: { seq: 1 } });
    h.setRpc(async () => { throw failure; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop), error => error === failure && error.meta.seq === 1);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter']); assert.equal(h.state().resultState, 'idle'); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：Leave失败报告unknown，IPC代际变化不复位而remoteGeneration变化才恢复', async () => {
    const h = loadFriendHarness(); const failure = Object.assign(new Error('Leave失败'), { sent: true, resultState: 'unknown' });
    h.setRpc(async (_service, method) => { if (method === 'Leave') throw failure; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, noop), error => error === failure && error.holdUntilTransportEpochChanged);
    h.setSnapshot({ connectionEpoch: 2, sessionEpoch: 200 });
    await assert.rejects(h.api.withFriendVisitSession(22, noop), error => error.errorCode === 'VISIT_STATE_UNKNOWN');
    assert.equal(h.calls.length, 2);
    h.setSnapshot({ remoteGeneration: 8 }); h.setRpc(async () => ({ body: { lands: [] } }));
    await h.api.withFriendVisitSession(22, noop); assert.equal(h.state().resultState, 'idle'); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：旧缺epoch状态不能被新IPC或新epoch猜测清除', async () => {
    const h = loadFriendHarness(); h.setSnapshot({ remoteGeneration: undefined });
    const failure = Object.assign(new Error('Enter超时'), { sent: true, resultState: 'unknown' });
    h.setRpc(async () => { throw failure; }); await assert.rejects(h.api.withFriendVisitSession(11, noop));
    h.setSnapshot({ connectionEpoch: 9, sessionEpoch: 10, remoteGeneration: 8 });
    await assert.rejects(h.api.withFriendVisitSession(22, noop));
    assert.equal(h.state().recoveryRequired, true); assert.equal(h.state().transportEpoch, null);
    assert.equal(h.calls.length, 1); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：不能向新WS发送旧事务Leave', async () => {
    const h = loadFriendHarness();
    await assert.rejects(h.api.withFriendVisitSession(11, () => { h.setSnapshot({ remoteGeneration: 8 }); }));
    assert.deepEqual(h.calls.map(call => call.method), ['Enter']); assert.equal(h.state().resultState, 'unknown');
    assert.equal(h.time.timers.size, 0);
});

test('friend Visit：32条有限队列，排队取消与超时不发送Enter也不提前release', async () => {
    const h = loadFriendHarness(); const token = await h.session.acquireFriendVisitSession(11, { accountId: '2', epoch: 7 });
    assert.equal(h.session.releaseFriendVisitSession(token), false);
    const pending = Array.from({ length: 32 }, () => h.session.acquireFriendVisitSession(22, { accountId: '2', epoch: 7, deadline: h.time.Date.now() + 100 }));
    const failures = pending.map(promise => assert.rejects(promise));
    await assert.rejects(h.session.acquireFriendVisitSession(33, { accountId: '2', epoch: 7 }), error => error.errorCode === 'VISIT_QUEUE_FULL');
    await h.time.advance(100); await Promise.all(failures);
    assert.equal(h.state().queued, 0); assert.equal(h.state().processing, true);
    token.settled = true; h.session.releaseFriendVisitSession(token); assert.equal(h.time.timers.size, 0); assert.equal(h.calls.length, 0);
});

test('friend writes：Farming超时不产生ReferenceError、不fallback单写', async () => {
    const h = loadFriendHarness(); const failure = Object.assign(new Error('Farming超时'), { sent: true, resultState: 'unknown' });
    h.setRpc(async (_service, method) => {
        if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 2, phases: [{ phase: 2 }], dry_num: 1 } }] } };
        throw failure;
    });
    await assert.rejects(h.visit.doFriendOperation(11, 'farming'), error => error === failure);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Farming']);
    let singles = 0;
    await assert.rejects(h.visit.runBatchWithFallback([1, 2], async () => { throw failure; }, async () => { singles++; }), error => error === failure);
    assert.equal(singles, 0); assert.equal(h.time.timers.size, 0);
});

test('friend GET：false只读owned GID单飞，刷新失败保缓存且不持久化', async () => {
    const h = loadFriendHarness(); const pending = pendingReply();
    h.setRpc(() => pending.promise);
    const first = h.analyzer.getFriendsList(false); const second = h.analyzer.getFriendsList(false);
    assert.equal(first, second); await flush(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'GetGameFriends');
    pending.resolve({ body: { game_friends: [{ gid: 11 }] } }); await first;
    const cache = plain(h.analyzer.getFriendsListCache());
    const failure = Object.assign(new Error('列表退避'), { sent: false, errorCode: 'HEALTH_BACKOFF', retryAfterMs: 1000 });
    h.setRpc(async () => { throw failure; });
    await assert.rejects(h.analyzer.getFriendsList(true), error => error === failure);
    assert.deepEqual(plain(h.analyzer.getFriendsListCache()), cache); assert.equal(h.commits.length, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.time.timers.size, 0);
});

test('friend GID：访客请求期间snapshot变化整批拒绝，不复活删除也不提交旧列表', async () => {
    const h = loadFriendHarness(); const pending = pendingReply();
    h.setRpc(async (_service, method, payload) => method === 'InteractRecords' ? pending.promise
        : { body: { game_friends: payload.gids.map(gid => ({ gid })) } });
    const request = h.api.getAllFriends(true); await flush(); h.setGids([22, 44]);
    pending.resolve({ body: { records: [{ visitor_gid: 11 }, { visitor_gid: 33 }] } });
    const reply = await request;
    assert.equal(reply.game_friends.some(friend => friend.gid === 11), false);
    assert.equal(reply.game_friends.some(friend => friend.gid === 33), false);
    assert.equal(reply.game_friends.some(friend => friend.gid === 44), true);
    assert.equal(h.commits.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.time.timers.size, 0);
});

test('friend GID：本地deletehook守住旧generation，即使store尚未更新也不能回写', async () => {
    const h = loadFriendHarness(); const baseGids = h.api.getCurrentKnownGids(); const generation = h.api.getFriendMutationGeneration();
    h.api.noteFriendGidDeleted(11);
    h.api.syncKnownFriendGidsFromFriends([{ gid: 11 }, { gid: 33 }], { baseGids, generation });
    assert.equal(h.commits.length, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.api.filterCurrentFriendGids([{ gid: 11 }]).length, 0);
    assert.equal(h.time.timers.size, 0);
});

test('interact：未知code1001和timeout不路由，原meta与成功缓存保留', async () => {
    const h = loadFriendHarness();
    h.setRpc(async () => ({ body: { records: [{ visitor_gid: 11 }] } })); await h.interact.getInteractRecords();
    for (const code of ['REQUEST_TIMEOUT', 1001]) {
        const failure = Object.assign(new Error(String(code)), { code, sent: true, resultState: 'unknown', meta: { seq: 9 } });
        h.setRpc(async () => { throw failure; });
        await assert.rejects(h.interact.getInteractRecords(), error => error === failure && error.meta.seq === 9);
    }
    assert.ok(h.calls.every(call => call.method === 'InteractRecords'));
    assert.equal(h.calls.length, 3); assert.equal(h.interact.getInteractRecordsCache()[0].visitorGid, 11); assert.equal(h.time.timers.size, 0);
});

test('worker→friend→真实client：页面取消不能中断已发Enter，业务期限后仍等底层结算再单次Leave', async () => {
    const client = loadClient(); client.api.connect('2', '', noop);
    client.sockets[0].emit('data', JSON.stringify({ t: 'login', accountId: '2', generation: 7, userState: { gid: 42 } }) + '\n');
    const friends = loadFriendHarness({ client });
    const network = loadNetwork(client).api;
    const worker = loadWorker(network, client.time, { extra: { getFriendDogInfo: friends.analyzer.getFriendDogInfo } });
    const response = () => worker.processRef.sent.find(message => message.type === 'api_response' && message.id === 201);
    const completion = worker.message({ type: 'api_call', id: 201, method: 'getFriendDogInfo', args: [11], readOnly: true, deadline: client.time.Date.now() + 100 });
    await flush();
    const enter = client.frames.find(frame => frame.t === 'request');
    assert.equal(enter.method, 'Enter'); assert.equal(enter.connectionEpoch, 7);
    await worker.message({ type: 'api_cancel', id: 201 });
    assert.equal(response(), undefined); assert.equal(friends.state().processing, true);
    await client.time.advance(100); await completion;
    assert.equal(response().errorMeta.resultState, 'unknown'); assert.equal(friends.state().processing, true);
    replyTo(client, enter, { body: Buffer.from(JSON.stringify({ lands: [], brief_dog_info: { dog_id: 90021 } })).toString('base64') });
    await flush();
    const leave = client.frames.filter(frame => frame.t === 'request').at(-1);
    assert.equal(leave.method, 'Leave'); assert.equal(leave.meta.deadline, client.time.Date.now() + 30000);
    assert.equal(client.frames.some(frame => frame.t === 'cancel'), false);
    assert.equal(friends.state().processing, true);
    replyTo(client, leave, { body: Buffer.from('{}').toString('base64') }); await flush();
    assert.equal(friends.state().resultState, 'idle'); assert.equal(worker.api.state().apiControlCount, 0);
    assert.equal(client.api.getRequestQueueSnapshot().active, 0); assert.equal(client.time.timers.size, 0);
    assert.deepEqual(client.frames.filter(frame => frame.t === 'request').map(frame => frame.method), ['Enter', 'Leave']);
});

test('friend Visit：业务异常和Leave异常都保留，cleanup失败不得替换原业务meta', async () => {
    const h = loadFriendHarness(); const business = Object.assign(new Error('业务拒绝'), { sent: true, stage: 'remote', resultState: 'failed', meta: { seq: 10 } });
    const leave = Object.assign(new Error('Leave失败'), { sent: true, resultState: 'unknown', meta: { seq: 11 } });
    h.setRpc(async (_service, method) => { if (method === 'Leave') throw leave; return { body: { lands: [] } }; });
    await assert.rejects(h.api.withFriendVisitSession(11, () => { throw business; }), error => error === business && error.meta.seq === 10 && error.leaveError === leave);
    assert.equal(h.state().resultState, 'unknown'); assert.equal(h.state().processing, false); assert.equal(h.time.timers.size, 0);
});

test('friend Visit：同epoch连接dead不发Leave、不允许缓存connected假恢复', async () => {
    const h = loadFriendHarness(); const failure = new Error('连接停止');
    await assert.rejects(h.api.withFriendVisitSession(11, () => { h.setSnapshot({ connected: false }); throw failure; }), error => error === failure);
    h.setSnapshot({ connected: true, connectionEpoch: 100 }); await assert.rejects(h.api.withFriendVisitSession(22, noop));
    assert.deepEqual(h.calls.map(call => call.method), ['Enter']); assert.equal(h.state().recoveryRequired, true); assert.equal(h.time.timers.size, 0);
});

test('friend GET：取消已返回首批后禁止下一批且不清已有缓存', async () => {
    const h = loadFriendHarness(); const controller = new AbortController(); h.setGids(Array.from({ length: 36 }, (_, index) => index + 100));
    h.setRpc(async (_service, _method, payload) => { controller.abort(new Error('页面关闭')); return { body: { game_friends: payload.gids.map(gid => ({ gid })) } }; });
    await assert.rejects(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.getAllFriends(false)));
    assert.equal(h.calls.length, 1); assert.equal(h.commits.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.time.timers.size, 0);
});

function longWriteSent(client, frame, settlementMs = 120000) {
    client.sockets.at(-1).emit('data', JSON.stringify({ t: 'request_sent', accountId: '2', seq: frame.seq,
        connectionEpoch: 7, sentAt: client.time.Date.now(), settlementDeadline: client.time.Date.now() + settlementMs }) + '\n');
}

for (const preserveSession of [true, false]) {
    test(`worker stop：真实后台raw写不在apiControls仍须排空，130秒不得detach/close（preserve=${preserveSession}）`, async () => {
        const client = loadClient(); const network = loadNetwork(client).api;
        assert.equal(typeof network.quiesceAndDrain, 'function', 'Cagent须导出真实network排空API，不得fixture假实现');
        assert.equal(typeof network.getPendingWriteCount, 'function');
        const wsClose = []; const worker = loadWorker(network, client.time, { extra: { getWs: () => ({ close: () => wsClose.push(client.time.Date.now()) }) } });
        await worker.message({ type: 'start', config: { resumeSession: true, platform: 'wx' } });
        client.api.connect('2', '', noop);
        client.sockets.at(-1).emit('data', JSON.stringify({ t: 'login', accountId: '2', connectionEpoch: 7, userState: { gid: 42 } }) + '\n');
        // 后台raw写不经过api_call，第二条的实际发送确认可晚于IPC入队。
        const write = network.sendMsgAsync('write-service', 'AutomaticFarmWrite', Buffer.alloc(0));
        const second = network.sendMsgAsync('write-service', 'AutomaticFarmWriteSecond', Buffer.alloc(0));
        await flush(); const [frame, secondFrame] = client.frames.filter(value => value.t === 'request');
        longWriteSent(client, frame); assert.equal(network.getPendingWriteCount(), 2);
        assert.equal(worker.api.state().apiControlCount, 0);
        const stop = worker.message({ type: 'stop', preserveSession }); await flush();
        assert.deepEqual(worker.processRef.sent.find(value => value.type === 'worker_quiescing'),
            { type: 'worker_quiescing', pendingWrites: 2, maxDrainMs: 155000 });
        assert.equal(worker.api.state().isRunning, false); assert.equal(worker.api.state().statsObservationsReady, false);
        assert.equal(worker.scheduler.tasks.size, 0); assert.equal(network.getDiagnosticSnapshot().quiescing, true);
        await client.time.advance(20000); longWriteSent(client, secondFrame);
        await assert.rejects(network.sendMsgAsync('write-service', 'NewWrite', Buffer.alloc(0)), error => error.errorCode === 'TRANSPORT_QUIESCING');
        await client.time.advance(100000); replyTo(client, frame); await write;
        await client.time.advance(10000);
        assert.equal(client.sockets.at(-1).destroyed, false); assert.deepEqual(wsClose, []); assert.deepEqual(worker.processRef.exits, []);
        assert.equal(network.getPendingWriteCount(), 1);
        replyTo(client, secondFrame); await second; await stop; await client.time.advance(0);
        assert.equal(network.getPendingWriteCount(), 0); assert.equal(client.sockets.at(-1).destroyed, true);
        assert.equal(wsClose.length, 1); assert.deepEqual(worker.processRef.exits, [0]);
        assert.equal(client.frames.filter(value => value.t === 'stop').length, preserveSession ? 0 : 1);
        assert.equal(client.frames.filter(value => value.t === 'request').length, 2); assert.equal(client.time.timers.size, 0);
    });
}

test('worker stop：quiesce等待130秒期间重复stop/start不得创建新状态或提前关闭WS', async () => {
    const client = loadClient(); const network = loadNetwork(client).api; const drain = pendingReply();
    const calls = []; const worker = loadWorker(network, client.time, { extra: {
        getPendingWriteCount: () => 1,
        quiesceAndDrain: async options => { calls.push(plain(options)); return drain.promise; },
        getWs: () => ({ close: () => calls.push('close') }),
    } });
    await worker.message({ type: 'start', config: { resumeSession: true, platform: 'wx' } });
    const stop = worker.message({ type: 'stop', preserveSession: true });
    const duplicate = worker.message({ type: 'stop', preserveSession: false });
    await worker.message({ type: 'start', config: { code: '禁止新状态', platform: 'qq' } });
    await client.time.advance(130000);
    assert.deepEqual(calls, [{ timeoutMs: 155000 }]); assert.equal(client.sockets.length, 1);
    assert.equal(client.sockets[0].destroyed, false); assert.equal(worker.scheduler.tasks.size, 0);
    assert.equal(worker.processRef.sent.filter(value => value.type === 'worker_quiescing').length, 1);
    assert.deepEqual(worker.processRef.exits, []);
    drain.resolve({ drained: true, pendingWrites: 0 }); await stop; await duplicate; await client.time.advance(0);
    assert.deepEqual(worker.processRef.exits, [0]); assert.equal(calls.filter(value => value === 'close').length, 1);
    assert.ok(!client.frames.some(value => value.t === 'stop')); assert.equal(client.time.timers.size, 0);
});

test('worker stop：C层reject unknown后仍等api业务completion，155秒cap明确报告未完成', async () => {
    const client = loadClient(); const network = loadNetwork(client).api; const business = pendingReply();
    const worker = loadWorker(network, client.time, { extra: {
        getPendingWriteCount: () => 1,
        quiesceAndDrain: async () => { throw Object.assign(new Error('传输结果未知'), { errorCode: 'WRITE_DRAIN_UNKNOWN', resultState: 'unknown' }); },
        runFarmOperation: () => business.promise,
    } });
    await worker.message({ type: 'start', config: { resumeSession: true, platform: 'wx' } });
    const request = worker.message({ type: 'api_call', id: 401, method: 'doFarmOp', args: [], readOnly: false, deadline: client.time.Date.now() + 200000 });
    const stop = worker.message({ type: 'stop', preserveSession: true }); await client.time.advance(130000);
    assert.equal(client.sockets[0].destroyed, false); assert.deepEqual(worker.processRef.exits, []);
    await client.time.advance(25000); await stop;
    const incomplete = worker.processRef.sent.find(value => value.type === 'worker_drain_incomplete');
    assert.equal(incomplete.error, '传输结果未知'); assert.equal(incomplete.errorMeta.errorCode, 'WRITE_DRAIN_UNKNOWN');
    assert.equal(incomplete.errorMeta.resultState, 'unknown'); assert.equal(incomplete.errorMeta.outcomeUnknown, true);
    assert.equal(client.sockets[0].destroyed, true); assert.equal(worker.api.state().apiControlCount, 1);
    business.resolve({ ok: true }); await request; await client.time.advance(0);
    assert.equal(worker.api.state().apiControlCount, 0); assert.equal(client.time.timers.size, 0);
});

test('worker stop：真实client非终态unknown写，API已离开等待不能当后台写已完成', async () => {
    const client = loadClient(); const network = loadNetwork(client).api;
    assert.equal(typeof network.quiesceAndDrain, 'function');
    const worker = loadWorker(network, client.time, { extra: { runFarmOperation: () => network.sendMsgAsync('write-service', 'Write', Buffer.alloc(0)) } });
    await worker.message({ type: 'start', config: { resumeSession: true, platform: 'wx' } });
    client.api.connect('2', '', noop);
    client.sockets.at(-1).emit('data', JSON.stringify({ t: 'login', accountId: '2', connectionEpoch: 7, userState: { gid: 42 } }) + '\n');
    const request = worker.message({ type: 'api_call', id: 402, method: 'doFarmOp', args: [], readOnly: false, deadline: client.time.Date.now() + 100 });
    await flush(); const frame = client.frames.find(value => value.t === 'request'); longWriteSent(client, frame);
    replyTo(client, frame, { error: '写结果尚未知', settled: false, sent: true, resultState: 'unknown', outcomeUnknown: true });
    const stop = worker.message({ type: 'stop', preserveSession: true }); await client.time.advance(1000);
    assert.equal(client.sockets.at(-1).destroyed, false); assert.equal(network.getPendingWriteCount(), 1);
    assert.equal(worker.processRef.sent.some(value => value.type === 'api_response'), false);
    replyTo(client, frame, { settled: true }); await request; await stop; await client.time.advance(0);
    assert.equal(network.getPendingWriteCount(), 0); assert.equal(client.time.timers.size, 0);
    assert.equal(client.frames.filter(value => value.t === 'request').length, 1);
});

test('worker health：businessHealthy false真实余额增加可记录，但getStats连读不能扩在线分母', async () => {
    const h = loadReadyWorker({ realStats: true }); await h.start(); await h.login();
    await h.client.time.advance(300000); h.event('experienceObserved', { gid: 42, exp: 450, at: h.client.time.Date.now() });
    h.event('connection_degraded', { backoffMs: 1000, timeoutStreak: 2 });
    h.event('connection_recovered', { businessHealthy: false });
    await h.client.time.advance(1000); h.event('experienceObserved', { gid: 42, exp: 475, at: h.client.time.Date.now() });
    assert.equal(h.actualStats.state().confirmedExp.exp, 475); assert.equal(h.actualStats.state().ready, false);
    assert.equal(h.api.state().statsConnectionPaused, true);
    h.context.statusData = {}; h.context.nextHelpRunAt = 0; h.context.nextStealRunAt = 0;
    h.context.getPreferredSeed = () => 0; h.context.getLevelExpProgress = () => ({});
    vm.runInContext(sourceBetween(sources.worker, 'function syncStatus()', '\n}').concat('\n}'), h.context);
    const before = h.stats.getStats({}, h.network.getUserState(), true, {}, { connectionReady: false }).expRate.elapsedHours;
    await h.client.time.advance(100000); h.context.syncStatus();
    const status = h.processRef.sent.filter(value => value.type === 'status_sync').at(-1).data;
    assert.equal(status.expRate.elapsedHours, before); assert.equal(h.actualStats.state().ready, false);
    assert.equal(status.status.exp, 475); assert.equal(status.gatewayTransport.health.businessHealthy, false);
    h.event('connection_recovered', { businessHealthy: true });
    assert.equal(h.actualStats.state().ready, true); assert.equal(h.api.state().statsConnectionPaused, false);
    await h.client.time.advance(10000); h.context.syncStatus();
    assert.ok(h.processRef.sent.filter(value => value.type === 'status_sync').at(-1).data.expRate.elapsedHours > before);
    await h.message({ type: 'stop', preserveSession: true }); await h.client.time.advance(0);
});

test('worker health：resume返回false不清暂停，未来时间/旧epoch恢复不启用尾段', async () => {
    const h = loadReadyWorker(); await h.start(); await h.login();
    h.context.resumeExpObservations = () => false;
    const readyCount = h.named('stats.connectionReady').length;
    h.event('connection_degraded', { backoffMs: 1000 });
    h.event('connection_recovered', { businessHealthy: true, at: h.client.time.Date.now() + 1 });
    h.event('connection_recovered', { businessHealthy: true, connectionEpoch: -1 });
    h.event('connection_recovered', { businessHealthy: true });
    assert.equal(h.api.state().statsConnectionPaused, true);
    assert.equal(h.named('stats.connectionReady').length, readyCount);
    h.event('experienceObserved', { gid: 42, exp: 475, at: h.client.time.Date.now() });
    assert.equal(h.named('stats.note').length, 0); assert.equal(h.api.state().statsConnectionPaused, true);
    await stopReadyWorker(h);
});

test('manager→worker静默ack：130秒不强杀，不因计数0快照提前restart，exit后才新建', async () => {
    const h = loadManager(); h.api.startWorker(account()); const old = h.children[0];
    const restart = h.api.restartWorker(account());
    old.emit('message', { type: 'worker_quiescing', pendingWrites: 0, maxDrainMs: 155000 });
    await h.time.advance(130000); assert.equal(old.killed, 0); assert.equal(h.children.length, 1);
    old.emit('exit', 0, null); await restart; assert.equal(h.children.length, 2);
    assert.equal(old.killed, 0); assert.ok(!h.scheduler.tasks.has('force_kill_2'));
});

test('worker health：网关remoteGeneration不同于本地epoch时合法真实观测可记录', async () => {
    const h = loadReadyWorker({ realStats: true }); await h.start(); await h.login();
    const diagnostic = h.network.getDiagnosticSnapshot();
    h.context.getDiagnosticSnapshot = () => ({ ...diagnostic, remoteGeneration: 77 });
    h.event('connection_degraded', { backoffMs: 1000 }); await h.client.time.advance(1000);
    h.event('experienceObserved', { gid: 42, exp: 425, at: h.client.time.Date.now(), connectionEpoch: 77 });
    assert.equal(h.actualStats.state().confirmedExp.exp, 425); assert.equal(h.actualStats.state().ready, false);
    h.event('connection_recovered', { businessHealthy: true, connectionEpoch: 77 });
    assert.equal(h.api.state().statsConnectionPaused, false); assert.equal(h.actualStats.state().ready, true);
    await h.message({ type: 'stop', preserveSession: true }); await h.client.time.advance(0);
});

test('worker stop：迟到旧onReady与Bag不能启动新业务或改缓存状态', async () => {
    const bag = pendingReply(); const h = loadReadyWorker({ bag: () => bag.promise });
    await h.start(); const ready = h.login(); await flush();
    const stop = h.message({ type: 'stop', preserveSession: true }); await flush();
    bag.resolve({ items: [{ id: 1002, count: 999 }] }); await ready; await stop;
    assert.equal(h.named('stats.init').length, 0); assert.equal(h.named('career.query').length, 0);
    assert.equal(h.calls.filter(value => value.name.startsWith('start')).length, 0);
    assert.equal(h.scheduler.tasks.size, 0); assert.equal(h.network.getUserState().coupon, 0);
    await h.client.time.advance(0);
});

test('worker diagnostics：直连空诊断安全降级，无token或真实RPC', async () => {
    const h = loadApiWorker(); h.context.getDiagnosticSnapshot = () => undefined;
    await h.call(403, 'getTransportDiagnostics');
    const result = h.response(403).result;
    assert.equal(result.currentGid, 42); assert.deepEqual(result.healthBackoff, { active: false, remainingMs: 0 });
    assert.deepEqual(result.queue, { byPriority: {}, metrics: {} });
    assert.equal(h.client.frames.filter(value => value.t === 'request').length, 0);
});
