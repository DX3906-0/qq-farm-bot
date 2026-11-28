const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadSource(relative, dependencies, globals = {}, exports = '') {
    const filename = path.resolve(__dirname, relative);
    const module = { exports: {} };
    const context = vm.createContext({
        Buffer, console, module, exports: module.exports, __dirname: path.dirname(filename),
        __filename: filename, setTimeout, clearTimeout, setInterval, clearInterval,
        process: { env: {}, platform: process.platform },
        require(name) {
            if (Object.hasOwn(dependencies, name)) return dependencies[name];
            throw new Error(`VM 未声明依赖: ${name}`);
        },
        ...globals,
    });
    vm.runInContext(`${fs.readFileSync(filename, 'utf8')}\n${exports}`, context, { filename });
    return module.exports;
}

// 原 TSDK 生命周期回归仍执行真实 WASM，但所有写入及 HTTPS 都在内存中模拟。
function loadTsdk() {
    const files = new Map();
    const network = [];
    const memoryFs = {
        mkdirSync() {},
        readFileSync(filename, encoding) {
            if (files.has(filename)) return encoding ? files.get(filename).toString(encoding) : files.get(filename);
            if (path.basename(filename) === 'tsdk-v3.9.0.1789137379.wasm') return fs.readFileSync(filename);
            if (path.basename(filename) === 'tsdk-legacy.wasm') return Buffer.from('错误版本');
            throw new Error('内存文件不存在');
        },
        writeFileSync(filename, data, encoding) { files.set(filename, Buffer.from(data, encoding)); },
        appendFileSync(filename, data, encoding) {
            files.set(filename, Buffer.concat([files.get(filename) || Buffer.alloc(0), Buffer.from(data, encoding)]));
        },
        statSync() { throw new Error('内存文件不存在'); },
    };
    const request = (...args) => {
        network.push(args);
        const emitter = new EventEmitter();
        emitter.end = () => {};
        return emitter;
    };
    const api = loadSource('../src/utils/tsdk-runtime.js', {
        'node:crypto': require('node:crypto'), 'node:fs': memoryFs,
        'node:https': { get: request, request }, 'node:os': require('node:os'),
        'node:path': path, 'node:process': { env: {}, platform: process.platform },
        'node:perf_hooks': require('node:perf_hooks'), '../config/runtime-paths': { ensureDataDir: () => '/vm-data' },
    });
    return { ...api, files, network };
}
const { OFFICIAL_SHA256, OFFICIAL_VERSION, TsdkRuntime } = loadTsdk();
function createRuntime(name) { return new TsdkRuntime({ accountId: name, dataDir: `/vm-data/${name}` }); }

test('TSDK：加载并校验匹配的官方 WASM（仅内存副作用）', async (t) => {
    const runtime = createRuntime('load');
    t.after(() => runtime.destroy());
    await runtime.init();
    const status = runtime.getStatus();
    assert.equal(status.ready, true);
    assert.equal(status.version, OFFICIAL_VERSION);
    assert.equal(status.wasmSha256, OFFICIAL_SHA256);
    assert.equal(runtime.gameId, 3167);
    assert.equal(runtime.appKey, '0');
    assert.equal(runtime.getResult().length, 64);
});

test('TSDK：加解密往返和 token 生成', async (t) => {
    const runtime = createRuntime('crypto');
    t.after(() => runtime.destroy());
    await runtime.init();
    const plain = Buffer.from('qq-farm-tsdk-offline-roundtrip');
    const encrypted = runtime.encrypt(plain);
    assert.notDeepEqual(encrypted, plain);
    assert.deepEqual(runtime.decrypt(encrypted), plain);
    const first = runtime.generateToken(Buffer.from('request-sequence-1'));
    const second = runtime.generateToken(Buffer.from('request-sequence-2'));
    assert.ok(first.token.length > 0);
    assert.ok(second.token.length > 0);
    assert.notEqual(first.token, second.token);
});

test('TSDK：心跳 ACE 数据和实例隔离', async (t) => {
    const first = createRuntime('isolation-a');
    const second = createRuntime('isolation-b');
    t.after(() => { first.destroy(); second.destroy(); });
    await Promise.all([first.init(), second.init()]);
    first.heartbeatTick();
    const data = first.getDataToServer();
    assert.ok(Buffer.isBuffer(data));
    assert.ok(data.length > 0);
    assert.equal(first.getStatus().heartbeatTicks, 1);
    assert.equal(second.getStatus().heartbeatTicks, 0);
});

test('TSDK：官方封装生命周期指标', async (t) => {
    const runtime = createRuntime('lifecycle');
    t.after(() => runtime.destroy());
    await runtime.init();
    runtime.processReceivedData();
    runtime.sendStatus();
    runtime.detectSpeedHack(30000);
    runtime.checkFunctionArray([runtime.getDataToServer], 0);
    assert.equal(runtime.bindUser('test-open-id'), true);
    assert.match(runtime.getEncryptedInitInfo(), /^[a-z0-9+/]+=*$/i);
    const status = runtime.getStatus();
    assert.equal(status.processTicks, 1);
    assert.equal(status.statusReports, 1);
    assert.equal(status.functionChecks, 1);
    assert.equal(status.userBound, true);
});

test('TSDK：拒绝错误 WASM 版本和 destroy 后使用', async () => {
    const wrong = new TsdkRuntime({ accountId: 'bad-wasm', wasmPath: '/vm/tsdk-legacy.wasm', dataDir: '/vm-data/bad-wasm' });
    await assert.rejects(wrong.init(), /checksum mismatch/);
    const runtime = createRuntime('destroy');
    await runtime.init();
    runtime.destroy();
    assert.throws(() => runtime.generateToken(Buffer.from('x')), /not ready/);
});

async function flush() { for (let i = 0; i < 40; i += 1) await Promise.resolve(); }
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fakeClock() {
    let now = 1000;
    let serial = 0;
    const timers = new Map();
    function add(fn, delay, interval = 0) {
        const handle = { id: ++serial, fn, at: now + Math.max(1, delay), interval, unref() {} };
        timers.set(handle.id, handle);
        return handle;
    }
    function clear(handle) { if (handle) timers.delete(handle.id); }
    return {
        Date: class extends Date { static now() { return now; } },
        now: () => now, timers,
        setTimeout: (fn, ms) => add(fn, ms), clearTimeout: clear,
        setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: clear,
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                const next = Array.from(timers.values()).filter(value => value.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!next) break;
                now = next.at;
                if (next.interval) next.at += next.interval;
                else timers.delete(next.id);
                next.fn();
                await flush();
            }
            now = end;
            await flush();
        },
    };
}

const USER_SERVICE = 'gamepb.userpb.UserService';
const ACE_SERVICE = 'gamepb.acepb.AceService';
const BUSINESS_SERVICE = 'gamepb.plantpb.PlantService';

function gatewayVm(options = {}) {
    const clock = fakeClock();
    const sockets = [];
    const logs = [];
    const storeAccounts = options.storeAccounts || [{ id: '1', platform: 'qq', code: 'saved' }];
    const filesystemWrites = [];
    const exits = [];
    class Runtime {
        constructor(opts = {}) {
            this.accountId = String(opts.accountId || '1');
            this.logger = opts.logger || (() => {});
            this.ready = true;
            this.destroyed = false;
            this.encryptions = [];
            this.gate = null;
        }
        async init() { if (this.gate) await this.gate.promise; return this; }
        encrypt(value) {
            if (this.destroyed) throw new Error('运行时已销毁');
            this.encryptions.push(Buffer.from(value));
            return Buffer.from(`${this.accountId}:${value.toString()}`);
        }
        decrypt(value) { return Buffer.from(`${this.accountId}:${value.toString()}`); }
        generateToken(value) { return { token: `${this.accountId}:${value.toString()}` }; }
        destroy() { this.destroyed = true; this.ready = false; }
        bindUser() {}
        getEncryptedInitInfo() { return 'init-info'; }
    }
    class Socket extends EventEmitter {
        constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closed = 0; sockets.push(this); }
        send(data) {
            if (this.sendError) throw new Error('模拟发送失败');
            const message = JSON.parse(data.toString());
            message.body = Buffer.from(message.body.data);
            this.sent.push(message);
        }
        close() { this.closed += 1; this.readyState = 3; }
        terminate() { this.close(); }
    }
    class Ace {
        constructor(opts) { this.options = opts; }
        start() {}
        stop() {}
    }
    const simpleType = { create: value => value, encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }) };
    const types = {
        GateMessage: { ...simpleType, decode: data => {
            const message = JSON.parse(data.toString());
            message.body = message.body ? Buffer.from(message.body.data || message.body) : Buffer.alloc(0);
            return message;
        } },
        HeartbeatRequest: simpleType, LoginRequest: simpleType,
        LoginReply: { decode: data => JSON.parse(data.toString()) },
    };
    const crypto = loadSource('../src/utils/crypto-wasm.js', { './tsdk-runtime': { TsdkRuntime: Runtime } });
    const health = loadSource('../src/utils/gateway-health.js', {});
    const priority = loadSource('../src/utils/request-priority.js', {
        'node:async_hooks': require('node:async_hooks'), 'node:crypto': require('node:crypto'),
    });
    const api = loadSource('../src/runtime/gateway-process.js', {
        net: { createServer() { throw new Error('禁止真实 IPC 服务'); } },
        fs: {
            mkdirSync: (...args) => filesystemWrites.push(args),
            readFileSync() { throw new Error('无模拟微信凭据'); },
            existsSync: () => false,
        },
        path, ws: Socket,
        '../config/config': { CONFIG: { platform: 'qq', tsdkAceEnabled: true, heartbeatInterval: 10000, clientVersion: 'test' } },
        '../utils/utils': { log: (...args) => logs.push(args), logWarn: (...args) => logs.push(args), toLong: Number, toNum: value => Number(value) || 0 },
        '../utils/crypto-wasm': crypto, '../utils/proto': { types, loadProto: async () => {} },
        '../utils/tsdk-runtime': { TsdkRuntime: Runtime }, '../services/ace-service': { AceService: Ace },
        '../utils/gateway-token': { createGatewayToken: () => 'gateway-token' },
        '../config/runtime-paths': { getDataDir: () => '/vm-data' },
        '../utils/gateway-health': health,
        '../utils/request-priority': priority,
        './gateway-routing': { readGatewayDelegation: () => options.delegation || null },
        '../models/store': { getAccounts: () => ({ accounts: storeAccounts }), getDeviceProtocolForAccount: () => null },
    }, {
        Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        setInterval: clock.setInterval, clearInterval: clock.clearInterval, AbortController,
        process: { env: options.env || {}, exit: code => exits.push(code) },
    }, `module.exports = { ...module.exports, createConn, accounts, sendMsg, gatewaySendRequest,
        handleMessage, handleWorkerFrame, registerWorkerSocket, startHeartbeat, stopNetwork, closeCurrentWs, scheduleReconnect,
        armWxReconnectAt, gatewayHealthStatus, noteBusinessTimeout, startSecurityRuntime, connectWxSingleFlight,
        startAceService, clearHealthTimers, cancelReconnectTimers, isTrulySilent, BUSINESS_REQUEST_LIMIT,
        sendFrame, emitEvent, emitEventToAll, requestKind, cancelWorkerOperation, shutdownGateway };`);
    const account = api.createConn('1');
    account.platform = 'qq';
    account.savedCode = 'saved';
    account.connectedAt = clock.now();
    account.lastInboundAt = clock.now();
    account.userState.gid = 1;
    account.ws = new Socket();
    account.tsdkRuntime = new Runtime({ accountId: '1' });
    api.accounts.set('1', account);
    function ipc() {
        return { destroyed: false, frames: [], write(data) { this.frames.push(JSON.parse(data)); } };
    }
    function reply(seq, errorCode = 0, serverSeq = seq, method = 'Harvest') {
        api.handleMessage(account, Buffer.from(JSON.stringify({
            meta: { message_type: 2, client_seq: seq, server_seq: serverSeq, error_code: errorCode, method_name: method },
        })));
    }
    function notify(serverSeq = 0, socket = account.ws, epoch = account.connectionEpoch) {
        api.handleMessage(account, Buffer.from(JSON.stringify({ meta: { message_type: 3, server_seq: serverSeq } })), socket, epoch);
    }
    return { api, account, clock, crypto, health, priority, Runtime, Socket, sockets, logs, filesystemWrites, exits, ipc, reply, notify };
}

function workerRequest(h, sock, seq = 1, method = 'Harvest', body = '') {
    return h.api.handleWorkerFrame(sock, { t: 'request', accountId: '1', seq, service: BUSINESS_SERVICE, method, body });
}
async function bindWorker(h, sock) { await h.api.handleWorkerFrame(sock, { t: 'connect', accountId: '1' }); }

for (const [name, method] of [['加密', 'encryptBuffer'], ['解密', 'decryptBuffer'], ['token', 'generateToken']]) {
    test(`crypto：${name} 在 await 前固定默认 runtime，不读取后切换的全局值`, async () => {
        const h = gatewayVm();
        const first = h.account.tsdkRuntime;
        first.gate = deferred();
        const second = new h.Runtime({ accountId: '2' });
        h.crypto.setRuntime(first);
        const result = h.crypto[method](Buffer.from('payload'));
        h.crypto.setRuntime(second);
        first.gate.resolve();
        const value = await result;
        assert.equal(method === 'generateToken' ? value.token : value.toString(), '1:payload');
    });
}

test('crypto：显式 runtime 和旧单参数 API 均兼容', async () => {
    const h = gatewayVm();
    const second = new h.Runtime({ accountId: '2' });
    h.crypto.setRuntime(h.account.tsdkRuntime);
    assert.equal((await h.crypto.encryptBuffer(Buffer.from('x'), second)).toString(), '2:x');
    assert.equal((await h.crypto.encryptBuffer(Buffer.from('x'))).toString(), '1:x');
    assert.throws(() => h.crypto.setRuntime({}), /TsdkRuntime/);
});

test('队列：非空编码 await 不被空 body 越序，串行只到 send 不等 response', async () => {
    const h = gatewayVm();
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const first = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('nonempty'));
    const second = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'AllLands', Buffer.alloc(0));
    await flush();
    assert.equal(h.account.ws.sent.length, 0);
    runtime.gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(h.account.ws.sent.map(msg => msg.meta.client_seq), [1, 2]);
    assert.equal(h.account.pendingCallbacks.size, 2);
    assert.equal(h.account.ws.sent[0].body.toString(), '1:nonempty');
});

test('队列：不同账号同时编码使用各自 runtime', async () => {
    const h = gatewayVm();
    const second = h.api.createConn('2');
    second.ws = new h.Socket();
    second.tsdkRuntime = new h.Runtime({ accountId: '2' });
    h.account.tsdkRuntime.gate = deferred();
    const a = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('a'));
    const b = h.api.sendMsg(second, BUSINESS_SERVICE, 'Harvest', Buffer.from('b'));
    await b;
    h.account.tsdkRuntime.gate.resolve();
    await a;
    assert.equal(h.account.ws.sent[0].body.toString(), '1:a');
    assert.equal(second.ws.sent[0].body.toString(), '2:b');
});

test('队列：critical HB/ACE 不被排队业务饿死，互相各有一席', async () => {
    const h = gatewayVm();
    h.account.tsdkRuntime.gate = deferred();
    const promises = [h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('first'))];
    for (let i = 0; i < 12; i += 1) promises.push(h.api.sendMsg(h.account, BUSINESS_SERVICE, `Business${i}`, Buffer.alloc(0)));
    promises.push(h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0)));
    promises.push(h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0)));
    h.account.tsdkRuntime.gate.resolve();
    await Promise.all(promises);
    assert.deepEqual(h.account.ws.sent.slice(0, 3).map(msg => msg.meta.method_name), ['Harvest', 'Heartbeat', 'AntiData']);
    assert.deepEqual(h.account.ws.sent.map(msg => msg.meta.client_seq), Array.from({ length: 15 }, (_, i) => i + 1));
});

test('队列：业务量有限、critical 独立 singleflight、超限明确失败且不发 wire', async () => {
    const h = gatewayVm();
    h.account.tsdkRuntime.gate = deferred();
    const all = [];
    for (let i = 0; i < 80; i += 1) all.push(h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0)));
    const hb = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    const duplicateHb = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    const ace = h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0));
    const duplicateAce = h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0));
    await flush();
    assert.ok(h.account.operations.size <= h.api.BUSINESS_REQUEST_LIMIT + 2);
    assert.equal(await duplicateHb, -1);
    assert.equal(await duplicateAce, -1);
    h.account.tsdkRuntime.gate.resolve();
    await Promise.all([...all, hb, ace]);
    assert.equal(h.account.pendingCallbacks.size, 34);
    assert.equal(h.account.ws.sent.length, 34);
});

for (const change of ['socket', 'epoch', 'runtime']) {
    test(`队列：编码 await 后 ${change} 变化拒绝，不用旧加密发送新连接`, async () => {
        const h = gatewayVm();
        const oldSocket = h.account.ws;
        const runtime = h.account.tsdkRuntime;
        runtime.gate = deferred();
        const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('x'));
        const rejected = assert.rejects(request, /取消|世代/);
        if (change === 'socket') h.account.ws = new h.Socket();
        if (change === 'epoch') h.account.connectionEpoch += 1;
        if (change === 'runtime') h.account.tsdkRuntime = new h.Runtime({ accountId: 'new' });
        runtime.gate.resolve();
        await rejected;
        assert.equal(oldSocket.sent.length, 0);
        assert.equal(h.account.ws.sent.length, 0);
        assert.equal(runtime.encryptions.length, 0);
        assert.equal(h.account.operations.size, 0);
    });
}

test('队列：编码 timeout 不上 wire、不消耗 init token，并释放 critical 通道', async () => {
    const h = gatewayVm();
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    h.account.initialGamePackInfo = 'one-use-info';
    const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('x'), 50);
    const rejected = assert.rejects(request, error => error.code === 'REQUEST_TIMEOUT' && error.sent === false && error.retryable === false);
    const hb = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    await h.clock.advance(50);
    await rejected;
    await hb;
    assert.equal(h.account.ws.sent.length, 1);
    assert.equal(h.account.ws.sent[0].meta.method_name, 'Heartbeat');
    assert.equal(h.account.ws.sent[0].auth_token, 'one-use-info');
    runtime.gate.resolve();
    await flush();
    assert.equal(runtime.encryptions.length, 0);
    assert.equal(h.account.ws.sent.length, 1);
});

test('队列：排队 deadline 纳入超时、取消未发送写，无自动重放', async () => {
    const h = gatewayVm();
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const first = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('blocking'), { timeoutMs: 1000 });
    const write = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Water', Buffer.alloc(0), 50);
    const rejected = assert.rejects(write, error => error.sent === false && error.outcomeUnknown === false);
    await h.clock.advance(50);
    await rejected;
    runtime.gate.resolve();
    await first;
    assert.deepEqual(h.account.ws.sent.map(msg => msg.meta.method_name), ['Harvest']);
    await h.clock.advance(1000);
    assert.equal(h.account.ws.sent.length, 1);
});

test('队列：已发送写 timeout 标记结果未知，不能重放', async () => {
    const h = gatewayVm();
    const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0), 50);
    const rejected = assert.rejects(request, error => error.sent && error.outcomeUnknown && error.retryable === false);
    await flush();
    await h.clock.advance(120000);
    await rejected;
    assert.equal(h.account.ws.sent.length, 1);
    assert.equal(h.account.pendingCallbacks.size, 0);
    h.reply(1);
    await h.clock.advance(1000);
    assert.equal(h.account.ws.sent.length, 1);
});

test('队列：发送异常清理且只回一次结构化错误', async () => {
    const h = gatewayVm();
    const sock = h.ipc();
    await bindWorker(h, sock);
    h.account.ws.sendError = true;
    await workerRequest(h, sock);
    const errors = sock.frames.filter(frame => frame.t === 'response');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.retryable, false);
    assert.equal(errors[0].meta.outcomeUnknown, true);
    assert.equal(h.account.operations.size, 0);
    await h.clock.advance(30000);
    assert.equal(sock.frames.filter(frame => frame.t === 'response').length, 1);
});

test('HB：持续无回复 pending 最多一个、有 timeout 清理，miss 不踢在线连接', async () => {
    const h = gatewayVm();
    h.api.startHeartbeat(h.account);
    for (let i = 0; i < 40; i += 1) {
        await h.clock.advance(10000);
        assert.ok(h.account.pendingCallbacks.size <= 1);
        assert.ok(h.account.criticalFlights.size <= 1);
    }
    assert.equal(h.account.ws.closed, 0);
    assert.equal(h.account.connectionDead, false);
    assert.ok(h.account.heartbeatMissCount <= 6);
    assert.ok(h.account.ws.sent.length > 1);
    h.api.stopNetwork(h.account);
    assert.equal(h.account.pendingCallbacks.size, 0);
    assert.equal(h.clock.timers.size, 0);
});

test('健康：7 parallel 30 秒超时不当作 210 秒；暂停业务后 timer 仍确认真实静默', async () => {
    const h = gatewayVm();
    const sock = h.ipc();
    await bindWorker(h, sock);
    await Promise.all(Array.from({ length: 7 }, (_, i) => workerRequest(h, sock, i + 1, 'AllLands')));
    await h.clock.advance(30000);
    assert.equal(h.account.requestTimeoutStreak, 7);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.deadReconnectCount, 0);
    assert.ok(h.account.deadConfirmTimer);
    assert.equal(sock.frames.filter(frame => frame.name === 'connection_degraded').length, 1);
    await h.clock.advance(179999);
    assert.equal(h.account.connectionDead, false);
    await h.clock.advance(1);
    assert.equal(h.account.connectionDead, true);
    assert.equal(h.account.deadReconnectCount, 1);
    assert.ok(h.account.deadReconnectTimer);
    assert.equal(h.account.ws.closed, 0);
    assert.equal(sock.frames.filter(frame => frame.name === 'connection_dead').length, 1);
});

for (const kind of ['heartbeat', 'ace']) {
    test(`健康：忙业务超时但 ${kind} 入站正常，超过 210 秒也不 disconnect`, async () => {
        const h = gatewayVm();
        const sock = h.ipc();
        await bindWorker(h, sock);
        await workerRequest(h, sock, 1, 'AllLands');
        await h.clock.advance(30000);
        for (let i = 0; i < 10; i += 1) {
            const seq = await h.api.sendMsg(h.account, kind === 'heartbeat' ? USER_SERVICE : ACE_SERVICE,
                kind === 'heartbeat' ? 'Heartbeat' : 'AntiData', Buffer.alloc(0));
            h.reply(seq);
            await h.clock.advance(25000);
        }
        assert.equal(h.account.connectionDead, false);
        assert.equal(h.account.ws.closed, 0);
        assert.equal(h.account.lastBusinessSuccessAt, 0);
        assert.equal(h.account.requestTimeoutStreak, 1);
        assert.ok(h.account.deadConfirmTimer);
    });
}

test('健康：迟到回复恢复取消全部 dead 重连 timer/flag，旧匿名式回调也无效', async () => {
    const h = gatewayVm();
    const sock = h.ipc();
    await bindWorker(h, sock);
    await workerRequest(h, sock);
    await h.clock.advance(210000);
    const deadTimer = h.account.deadReconnectTimer;
    h.account.reconnectTimer = h.clock.setTimeout(() => {}, 999999);
    assert.equal(h.account.connectionDead, true);
    h.reply(1, 0, 100);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.deadReconnectTimer, null);
    assert.equal(h.account.reconnectTimer, null);
    const oldSocket = h.account.ws;
    deadTimer.fn();
    await flush();
    assert.equal(h.account.ws, oldSocket);
    assert.equal(oldSocket.closed, 0);
    assert.equal(h.account.serverSeq, 100);
    assert.equal(h.account.lastBusinessSuccessAt, 0);
    await h.clock.advance(180000);
    assert.equal(h.account.ws, oldSocket);
    assert.equal(h.account.connectionDead, false);
});

test('健康：notify、错误 reply 都是 link 入站，不能冒充业务成功，serverSeq 单调', async () => {
    const h = gatewayVm();
    h.notify(100);
    await h.clock.advance(50);
    const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0));
    const rejected = assert.rejects(request, error => error.code === 42 && error.stage === 'game_request');
    await flush();
    h.reply(1, 42, 20);
    await rejected;
    assert.equal(h.account.serverSeq, 100);
    assert.equal(h.account.lastInboundAt, h.clock.now());
    assert.equal(h.account.lastBusinessReplyAt, h.clock.now());
    assert.equal(h.account.lastBusinessSuccessAt, 0);
    assert.equal(h.account.lastGameResponseAt, 0);
    h.reply(999, 0, 110);
    h.notify(2);
    assert.equal(h.account.serverSeq, 110);
});

test('健康：业务成功才恢复业务计数，HB/ACE 和错误不冒充 success', async () => {
    const h = gatewayVm();
    const business = await h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0));
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const seq = await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    h.reply(seq);
    assert.equal(h.account.requestTimeoutStreak, 2);
    assert.equal(h.account.healthBackoffChanging, true);
    h.reply(business);
    assert.equal(h.account.requestTimeoutStreak, 0);
    assert.equal(h.account.healthBackoffChanging, false);
    assert.equal(h.account.healthBackoffTimer, null);
    assert.equal(h.account.deadConfirmTimer, null);
    assert.equal(h.account.lastBusinessSuccessAt, h.clock.now());
});

test('健康：旧窗口 timer 不能清新退避，旧 confirm timer 不改变新 socket', async () => {
    const h = gatewayVm();
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const oldWindow = h.account.healthBackoffTimer;
    const oldConfirm = h.account.deadConfirmTimer;
    h.api.clearHealthTimers(h.account);
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const newWindow = h.account.healthBackoffTimer;
    oldWindow.fn();
    assert.equal(h.account.healthBackoffTimer, newWindow);
    assert.equal(h.account.healthBackoffChanging, true);
    h.account.ws = new h.Socket();
    h.account.connectionEpoch += 1;
    oldConfirm.fn();
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.deadReconnectCount, 0);
});

test('健康：稳定 WSstate 和真实最后入站共同约束 210 秒判死', async () => {
    const h = gatewayVm();
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(180000);
    h.notify(1);
    await h.clock.advance(209999);
    assert.equal(h.account.connectionDead, false);
    await h.clock.advance(1);
    assert.equal(h.account.connectionDead, true);
});

test('健康：非 OPEN 或停止后的 confirm/dead timer 不执行', async () => {
    const h = gatewayVm();
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const confirm = h.account.deadConfirmTimer;
    h.account.ws.readyState = 2;
    await h.clock.advance(210000);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.deadConfirmTimer, null);
    h.api.stopNetwork(h.account);
    confirm.fn();
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.clock.timers.size, 0);
});

test('健康：重复判死只排一个恢复、真实静默退避后只建一个新 WS', async () => {
    const h = gatewayVm();
    const oldSocket = h.account.ws;
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(210000);
    const timer = h.account.deadReconnectTimer;
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    assert.equal(h.account.deadReconnectTimer, timer);
    assert.equal(h.account.deadReconnectCount, 1);
    await h.clock.advance(180000);
    assert.equal(h.sockets.length, 2);
    assert.notEqual(h.account.ws, oldSocket);
    assert.equal(oldSocket.closed, 1);
    timer.fn();
    await flush();
    assert.equal(h.sockets.length, 2);
});

test('重连：普通与微信冷却 timer 均校验句柄/socket/epoch，旧回调不清新 timer', async () => {
    const h = gatewayVm();
    h.account.ws = null;
    h.api.scheduleReconnect(h.account, 'closed');
    const first = h.account.reconnectTimer;
    const attempts = h.account.reconnectAttempts;
    h.api.scheduleReconnect(h.account, 'repeat');
    assert.equal(h.account.reconnectTimer, first);
    assert.equal(h.account.reconnectAttempts, attempts);
    h.api.cancelReconnectTimers(h.account);
    h.api.scheduleReconnect(h.account, 'new');
    const second = h.account.reconnectTimer;
    first.fn();
    assert.equal(h.account.reconnectTimer, second);
    h.account.connectionEpoch += 1;
    second.fn();
    assert.equal(h.account.reconnectTimer, second);
    h.api.cancelReconnectTimers(h.account);
    h.account.platform = 'wx';
    h.api.armWxReconnectAt(h.account, h.clock.now() + 100);
    const wxOld = h.account.reconnectTimer;
    h.api.armWxReconnectAt(h.account, h.clock.now() + 200);
    const wxNew = h.account.reconnectTimer;
    wxOld.fn();
    assert.equal(h.account.reconnectTimer, wxNew);
    h.api.stopNetwork(h.account);
    wxNew.fn();
    assert.equal(h.account.reconnectTimer, null);
    assert.equal(h.clock.timers.size, 0);
});

test('IPC：新 socket 首 connect 兼容无 generation，旧 connect/request/stop 不能抢新 worker', async () => {
    const h = gatewayVm();
    const old = h.ipc();
    const fresh = h.ipc();
    await bindWorker(h, old);
    await bindWorker(h, fresh);
    const oldSocket = h.account.ws;
    await bindWorker(h, old);
    await workerRequest(h, old);
    await h.api.handleWorkerFrame(old, { t: 'stop', accountId: '1' });
    assert.equal(h.account.workerSock, fresh);
    assert.equal(h.account.ws, oldSocket);
    assert.equal(oldSocket.sent.length, 0);
    assert.equal(h.account.networkStopped, false);
    await workerRequest(h, fresh);
    assert.equal(oldSocket.sent.length, 1);
    assert.equal(old.frames.filter(frame => frame.t === 'error').length, 3);
});

test('IPC：先接入但迟到首 connect 的旧 socket，不能夺取新 worker', async () => {
    const h = gatewayVm();
    const old = h.ipc();
    const fresh = h.ipc();
    h.api.registerWorkerSocket(old);
    h.api.registerWorkerSocket(fresh);
    await bindWorker(h, fresh);
    await bindWorker(h, old);
    assert.equal(h.account.workerSock, fresh);
    assert.equal(old.frames.at(-1).t, 'error');
    assert.equal(h.account.workerSession, 1);
});

test('IPC：同 socket 混 account frame 拒绝，status/ping 只读不抢 workerSock', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    const reader = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '1' });
    await h.api.handleWorkerFrame(reader, { t: 'ping' });
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '2' });
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '2' });
    assert.equal(h.account.workerSock, worker);
    assert.equal(h.api.accounts.size, 1);
    assert.equal(reader.frames[0].t, 'status');
    assert.equal(reader.frames[1].t, 'pong');
    assert.equal(reader.frames[2].t, 'error');
    assert.equal(worker.frames.at(-1).t, 'error');
});

test('IPC：显式 generation 绑定后不同 generation 帧拒绝', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', generation: 'new' });
    await h.api.handleWorkerFrame(worker, { t: 'stop', accountId: '1', generation: 'old' });
    assert.equal(h.account.networkStopped, false);
    assert.match(worker.frames.at(-1).message, /世代/);
});

test('IPC：未 connect 的 request 不创建账号也不抢 worker', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await workerRequest(h, worker);
    assert.equal(h.account.workerSock, null);
    assert.equal(h.account.ws.sent.length, 0);
    assert.equal(worker.frames[0].t, 'error');
});

test('IPC：worker 重启免 Code 保留活会话、不重置业务亚健康', async () => {
    const h = gatewayVm();
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const socket = h.account.ws;
    const runtime = h.account.tsdkRuntime;
    await bindWorker(h, h.ipc());
    await bindWorker(h, h.ipc());
    assert.equal(h.account.ws, socket);
    assert.equal(h.account.tsdkRuntime, runtime);
    assert.equal(h.account.requestTimeoutStreak, 1);
    assert.equal(h.account.deadReconnectCount, 0);
    assert.equal(h.sockets.length, 1);
});

test('IPC：真实新 Code 取消旧发送和全部 timer，不重放旧请求', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const write = workerRequest(h, worker, 1, 'Harvest', Buffer.from('x').toString('base64'));
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    const oldConfirm = h.account.deadConfirmTimer;
    const oldWindow = h.account.healthBackoffTimer;
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', code: 'fresh-code' });
    runtime.gate.resolve();
    await write;
    oldConfirm.fn();
    oldWindow.fn();
    assert.equal(h.account.savedCode, 'fresh-code');
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.ws.sent.length, 0);
    assert.equal(h.account.deadConfirmTimer, null);
    assert.equal(h.account.healthBackoffTimer, null);
    assert.equal(h.account.deadReconnectTimer, null);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.userState.gid, 0);
});

test('WS：旧 socket message/error/close 事件不污染新连接', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', code: 'second' });
    const old = h.account.ws;
    const oldMessage = old.listeners('message')[0];
    const oldClose = old.listeners('close')[0];
    const oldError = old.listeners('error')[0];
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', code: 'third' });
    const fresh = h.account.ws;
    const before = h.account.lastInboundAt;
    oldMessage(Buffer.from(JSON.stringify({ meta: { message_type: 3, server_seq: 999 } })));
    oldError(new Error('Unexpected server response: 403'));
    oldClose(1006);
    assert.equal(h.account.ws, fresh);
    assert.equal(h.account.serverSeq, 0);
    assert.equal(h.account.lastInboundAt, before);
    assert.equal(h.account.reconnectTimer, null);
    assert.equal(h.account.codeInvalidCount, 0);
    assert.equal(worker.frames.filter(frame => frame.name === 'ws_error').length, 0);
});

test('ACE：日志归属 accountId，旧服务闭包不得向新 runtime/socket 发请求', async () => {
    const h = gatewayVm();
    h.api.startAceService(h.account);
    const ace = h.account.aceService;
    ace.options.logger('warn', '测试');
    h.account.tsdkRuntime.logger('info', '直接模拟');
    assert.ok(h.logs.some(args => args[1] === 'account 1 测试'));
    h.account.ws = new h.Socket();
    h.account.connectionEpoch += 1;
    await assert.rejects(ace.options.sendRequest(ACE_SERVICE, 'AntiData', Buffer.alloc(0), 100), /失效/);
    assert.equal(h.account.ws.sent.length, 0);
});

test('status：真实健康 ages/queue/pending，连接不代表业务健康', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    const reader = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '1' });
    let state = reader.frames.at(-1).state;
    assert.equal(state.connected, true);
    assert.equal(state.healthy, false);
    assert.equal(state.heartbeatAgeMs, null);
    assert.equal(state.businessAgeMs, null);
    assert.equal(state.inboundAgeMs, 0);
    const hb = await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    h.reply(hb);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const first = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('x'));
    const second = h.api.sendMsg(h.account, BUSINESS_SERVICE, 'AllLands', Buffer.alloc(0));
    await h.clock.advance(6000);
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '1' });
    state = reader.frames.at(-1).state;
    assert.equal(state.linkHealthy, true);
    assert.equal(state.businessHealthy, false);
    assert.equal(state.oldestPendingAgeMs, 6000);
    assert.equal(state.queueLength, 1);
    assert.equal(state.businessPendingCount, 2);
    runtime.gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    h.reply(a);
    h.reply(b);
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '1' });
    state = reader.frames.at(-1).state;
    assert.equal(state.healthy, true);
    assert.equal(state.pendingCount, 0);
    assert.equal(state.queueLength, 0);
    assert.equal(state.businessAgeMs, 0);
    assert.equal(h.account.workerSock, worker);
});

test('健康工具：保留旧输入兼容，新增字段不改变既有阈值语义', () => {
    const h = gatewayVm();
    assert.equal(h.health.evaluateGatewayHealth({ connected: false }).reason, 'disconnected');
    assert.equal(h.health.evaluateGatewayHealth({ heartbeatAgeMs: 30001 }).reason, 'heartbeat_stale');
    assert.equal(h.health.evaluateGatewayHealth({ oldestPendingAgeMs: 5001 }).reason, 'request_stuck');
    assert.equal(h.health.evaluateGatewayHealth({}).healthy, true);
    assert.equal(h.health.getOldestPendingAgeMs([1000, 2000], 6000), 5000);
    assert.equal(h.health.nextBusinessBackoffMs(0), 30000);
    assert.equal(h.health.nextBusinessBackoffMs(30000), 60000);
});

test('status：HB 持续正常但业务成功已过期，不能把连接当业务 healthy', async () => {
    const h = gatewayVm();
    const seq = await h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0));
    h.reply(seq);
    for (let i = 0; i < 9; i += 1) {
        await h.clock.advance(25000);
        const hb = await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
        h.reply(hb);
    }
    const state = h.api.gatewayHealthStatus(h.account);
    assert.equal(state.linkHealthy, true);
    assert.equal(state.businessHealthy, false);
    assert.equal(state.healthy, false);
    assert.equal(state.reason, 'business_stale');
    assert.equal(state.businessAgeMs, 225000);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.account.ws.closed, 0);
});

test('微信：换码 await 期间旧 WS 入站恢复，不顶掉恢复会话', async () => {
    const h = gatewayVm();
    h.account.platform = 'wx';
    h.account.connectionDead = true;
    const gate = deferred();
    h.account.wxIssueFlight = gate.promise;
    const socket = h.account.ws;
    const runtime = h.account.tsdkRuntime;
    const flight = h.api.connectWxSingleFlight(h.account);
    h.notify(1);
    gate.resolve('unused-fresh-code');
    assert.equal(await flight, true);
    assert.equal(h.account.ws, socket);
    assert.equal(h.account.tsdkRuntime, runtime);
    assert.equal(socket.closed, 0);
    assert.equal(h.account.savedCode, 'saved');
    assert.equal(h.account.connectionDead, false);
});

test('健康：业务错误入站后再静默，不发新 RPC 仍会被 confirm timer 发现', async () => {
    const h = gatewayVm();
    const seq = await h.api.sendMsg(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.alloc(0));
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(100);
    h.reply(seq, 42);
    assert.equal(h.account.lastBusinessSuccessAt, 0);
    assert.equal(h.account.businessNoResponseSince, h.clock.now());
    assert.ok(h.account.deadConfirmTimer);
    await h.clock.advance(209999);
    assert.equal(h.account.connectionDead, false);
    await h.clock.advance(1);
    assert.equal(h.account.connectionDead, true);
});

test('安全运行时：init 跨 await 的旧 runtime 销毁，不能覆盖新实例', async () => {
    const h = gatewayVm();
    const start = h.api.startSecurityRuntime(h.account);
    const oldRuntime = h.account.tsdkRuntime;
    const fresh = new h.Runtime({ accountId: 'fresh' });
    h.account.tsdkRuntime = fresh;
    h.account.connectionEpoch += 1;
    await assert.rejects(start, /失效/);
    assert.equal(oldRuntime.destroyed, true);
    assert.equal(fresh.destroyed, false);
    assert.equal(h.account.tsdkRuntime, fresh);
    oldRuntime.logger('info', '初始化归属');
    assert.ok(h.logs.some(args => args[1] === 'account 1 初始化归属'));
});

test('IPC：回包返回结构化错误增量字段，保留 error 字符串兼容', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker);
    h.reply(1, 42, 123);
    const error = worker.frames.find(frame => frame.t === 'response');
    assert.equal(typeof error.error, 'string');
    assert.equal(error.meta.errorCode, 42);
    assert.equal(error.meta.stage, 'game_request');
    assert.equal(error.meta.serverSeq, 123);
    assert.equal(error.meta.outcomeUnknown, false);
    assert.equal(error.meta.retryable, false);
});

test('HB：迟到旧 heartbeat reply 不消除新 heartbeat 的 pending 单飞', async () => {
    const h = gatewayVm();
    h.api.startHeartbeat(h.account);
    await h.clock.advance(50000);
    assert.equal(h.account.pendingCallbacks.size, 1);
    h.reply(1, 0, 100);
    assert.equal(h.account.pendingCallbacks.size, 1);
    assert.equal(h.account.lastHeartbeatResponse, 0);
    assert.equal(h.account.lastInboundAt, h.clock.now());
    assert.equal(h.account.serverSeq, 100);
    h.reply(2, 0, 20);
    assert.equal(h.account.pendingCallbacks.size, 0);
    assert.equal(h.account.lastHeartbeatResponse, h.clock.now());
    assert.equal(h.account.serverSeq, 100);
});

test('契约 epoch：login 重用、notify、response、event、status 都携带顶层当前世代', async () => {
    const h = gatewayVm();
    h.account.connectionEpoch = 17;
    const worker = h.ipc();
    await bindWorker(h, worker);
    h.notify(30);
    await workerRequest(h, worker, 1);
    h.reply(1);
    h.api.emitEvent(h.account, '测试事件', {});
    h.api.emitEventToAll('广播事件', {});
    await h.api.handleWorkerFrame(worker, { t: 'status', accountId: '1' });
    await h.api.handleWorkerFrame(worker, { t: 'ping', accountId: '1' });
    for (const frame of worker.frames) assert.equal(frame.connectionEpoch, 17, frame.t);
    assert.equal(worker.frames.find(frame => frame.t === 'response').meta.connectionEpoch, 17);
    assert.equal(worker.frames.find(frame => frame.t === 'status').state.connectionEpoch, 17);
    const fresh = h.ipc();
    await bindWorker(h, fresh);
    assert.equal(fresh.frames[0].connectionEpoch, 17);
    assert.equal(h.account.connectionEpoch, 17);
});

test('契约 epoch：旧 operation 重置错误保留旧 epoch，不被改标新会话', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    h.account.connectionEpoch = 7;
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const request = workerRequest(h, worker, 1, 'Harvest', Buffer.from('x').toString('base64'));
    h.api.closeCurrentWs(h.account);
    await request;
    runtime.gate.resolve();
    await flush();
    const error = worker.frames.find(frame => frame.t === 'response');
    assert.equal(error.connectionEpoch, 7);
    assert.equal(error.meta.connectionEpoch, 7);
    assert.equal(error.meta.resultState, 'not_sent');
    assert.equal(h.account.connectionEpoch, 8);
});

for (const sentEpoch of [6, '7']) {
    test(`契约 epoch：请求 epoch=${JSON.stringify(sentEpoch)} 严格不匹配则 not_sent`, async () => {
        const h = gatewayVm();
        h.account.connectionEpoch = 7;
        const worker = h.ipc();
        await bindWorker(h, worker);
        await h.api.handleWorkerFrame(worker, {
            t: 'request', accountId: '1', seq: 1, connectionEpoch: sentEpoch,
            service: BUSINESS_SERVICE, method: 'Harvest', body: '',
        });
        const error = worker.frames.at(-1);
        assert.equal(error.meta.errorCode, 'STALE_CONNECTION');
        assert.equal(error.meta.sent, false);
        assert.equal(error.meta.resultState, 'not_sent');
        assert.equal(error.connectionEpoch, sentEpoch);
        assert.equal(h.account.ws.sent.length, 0);
        assert.equal(h.account.operations.size, 0);
    });
}

test('契约 epoch：匹配 epoch 和旧无 epoch 请求均兼容且返回 completed', async () => {
    const h = gatewayVm();
    h.account.connectionEpoch = 7;
    const worker = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(worker, {
        t: 'request', accountId: '1', seq: 1, connectionEpoch: 7,
        service: BUSINESS_SERVICE, method: 'AllLands', body: '',
    });
    await workerRequest(h, worker, 2);
    h.reply(1);
    h.reply(2);
    const replies = worker.frames.filter(frame => frame.t === 'response');
    assert.equal(replies.length, 2);
    for (const reply of replies) {
        assert.equal(reply.meta.resultState, 'completed');
        assert.equal(reply.meta.sent, true);
        assert.equal(reply.connectionEpoch, 7);
    }
});

test('契约 cancel：未发送写可取消 encoding/queue，critical 继续，取消仅一次回复', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const a = workerRequest(h, worker, 10, 'Harvest', Buffer.from('x').toString('base64'));
    const b = workerRequest(h, worker, 11, 'Water');
    const hb = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 11, connectionEpoch: 0 });
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 10, connectionEpoch: 0 });
    await Promise.all([a, b, hb]);
    runtime.gate.resolve();
    await flush();
    const replies = worker.frames.filter(frame => frame.t === 'response');
    assert.equal(replies.length, 2);
    for (const reply of replies) {
        assert.equal(reply.meta.errorCode, 'REQUEST_CANCELLED');
        assert.equal(reply.meta.sent, false);
        assert.equal(reply.meta.resultState, 'not_sent');
    }
    assert.deepEqual(h.account.ws.sent.map(message => message.meta.method_name), ['Heartbeat']);
    assert.equal(runtime.encryptions.length, 0);
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 10 });
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 2);
});

test('契约 cancel：已发写和伪 readOnly 请求不能取消或释放席位', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(worker, {
        t: 'request', accountId: '1', seq: 1, service: BUSINESS_SERVICE,
        method: 'Harvest', readOnly: true, body: '',
    });
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 1, readOnly: true });
    assert.equal(h.account.operations.size, 1);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
    h.reply(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'completed');
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.ws.sent.length, 1);
});

test('契约 cancel：SAFE 精确 service 配对，错误 service 的同名读按写处理', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(worker, {
        t: 'request', accountId: '1', seq: 1, service: 'gamepb.unknownpb.UnknownService',
        method: 'AllLands', readOnly: true, body: '',
    });
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 1 });
    assert.equal(h.account.operations.size, 1);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
    await h.clock.advance(120000);
    assert.equal(worker.frames.find(frame => frame.t === 'response').meta.resultState, 'unknown');
});

test('契约 cancel：已发只读解绑 waiter 但保留有界在途直到真实回复', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker, 1, 'AllLands');
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 1, connectionEpoch: 0 });
    assert.equal(h.account.operations.size, 1);
    assert.equal(h.account.pendingCallbacks.size, 1);
    const error = worker.frames.at(-1);
    assert.equal(error.meta.errorCode, 'REQUEST_CANCELLED');
    assert.equal(error.meta.resultState, 'failed');
    assert.equal(error.meta.sent, true);
    assert.equal(error.meta.outcomeUnknown, false);
    h.reply(1, 0, 100);
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.pendingCallbacks.size, 0);
    assert.equal(h.account.lastBusinessSuccessAt, h.clock.now());
    assert.equal(h.account.serverSeq, 100);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 1);
});

test('契约 cancel：已发只读反复取消不能突破32业务在途上限，timeout仍清理', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    for (let i = 1; i <= 40; i += 1) {
        await workerRequest(h, worker, i, 'AllLands');
        await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: i });
    }
    assert.equal(h.account.operations.size, 32);
    assert.equal(h.account.ws.sent.length, 32);
    assert.equal(worker.frames.filter(frame => frame.meta?.errorCode === 'QUEUE_FULL').length, 8);
    const before = worker.frames.filter(frame => frame.t === 'response').length;
    await h.clock.advance(30000);
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.pendingCallbacks.size, 0);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, before);
});

test('契约 cancel：旧worker、跨账号和过期epoch不得取消当前operation', async () => {
    const h = gatewayVm();
    const old = h.ipc();
    const worker = h.ipc();
    await bindWorker(h, old);
    await bindWorker(h, worker);
    await workerRequest(h, worker, 1, 'AllLands');
    await h.api.handleWorkerFrame(old, { t: 'cancel', accountId: '1', seq: 1 });
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '2', seq: 1 });
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 1, connectionEpoch: -1 });
    assert.equal(h.account.operations.size, 1);
    assert.equal(Array.from(h.account.operations)[0].waiterDetached, undefined);
    assert.equal(h.account.workerSock, worker);
    assert.equal(worker.frames.at(-1).meta.resultState, 'not_sent');
});

test('契约 critical：仅 ACE.AntiData 优先，未知 method 不占ACE席位', async () => {
    const h = gatewayVm();
    assert.equal(h.api.requestKind(ACE_SERVICE, 'AntiData'), 'ace');
    assert.equal(h.api.requestKind(ACE_SERVICE, 'Unknown'), 'business');
    h.account.healthBackoffUntil = h.clock.now() + 1000;
    assert.equal(await h.api.sendMsg(h.account, ACE_SERVICE, 'Unknown', Buffer.alloc(0)), -1);
    const seq = await h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0));
    assert.ok(seq > 0);
    assert.equal(h.account.ws.sent.length, 1);
});

test('契约退避：网关清掉退避前 queued/encoding 并拒新业务，HB/ACE独立放行', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const a = workerRequest(h, worker, 1, 'Harvest', Buffer.from('x').toString('base64'));
    const b = workerRequest(h, worker, 2, 'AllLands');
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await Promise.all([a, b]);
    await workerRequest(h, worker, 3);
    const hb = await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    const ace = await h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0));
    runtime.gate.resolve();
    await flush();
    const errors = worker.frames.filter(frame => frame.t === 'response');
    assert.equal(errors.length, 3);
    for (const error of errors) {
        assert.equal(error.meta.errorCode, 'HEALTH_BACKOFF');
        assert.equal(error.meta.resultState, 'not_sent');
        assert.equal(error.meta.sent, false);
        assert.ok(error.meta.retryAfterMs > 0);
    }
    assert.equal(runtime.encryptions.length, 0);
    assert.deepEqual(h.account.ws.sent.map(message => message.meta.method_name), ['Heartbeat', 'AntiData']);
    h.reply(hb);
    h.reply(ace);
    assert.equal(h.account.requestTimeoutStreak, 2);
    assert.equal(h.api.gatewayHealthStatus(h.account).businessHealthy, false);
});

test('契约退避：跨编码await后再次检查退避，不能漏发旧客户端业务', async () => {
    const h = gatewayVm();
    h.account.tsdkRuntime.gate = deferred();
    const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'Harvest', Buffer.from('x'));
    const rejected = assert.rejects(request, error => error.code === 'HEALTH_BACKOFF' && error.resultState === 'not_sent');
    h.account.healthBackoffUntil = h.clock.now() + 1000;
    h.account.tsdkRuntime.gate.resolve();
    await rejected;
    assert.equal(h.account.ws.sent.length, 0);
    assert.equal(h.account.operations.size, 0);
});

for (const [method, expected] of [['AllLands', 'failed'], ['Harvest', 'unknown']]) {
    test(`契约 resultState：已发 ${method} timeout 为 ${expected}，无重放`, async () => {
        const h = gatewayVm();
        const worker = h.ipc();
        await bindWorker(h, worker);
        await workerRequest(h, worker, 1, method);
        await h.clock.advance(method === 'Harvest' ? 120000 : 30000);
        const error = worker.frames.find(frame => frame.t === 'response');
        assert.equal(error.meta.resultState, expected);
        assert.equal(error.meta.outcomeUnknown, expected === 'unknown');
        assert.equal(error.meta.sent, true);
        assert.equal(error.meta.retryable, false);
        assert.equal(h.account.ws.sent.length, 1);
    });
}

test('契约 resultState：真实服务错误是failed，成功completed保留业务body与serverSeq', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker, 1);
    h.reply(1, 42, 100);
    assert.equal(worker.frames.at(-1).meta.resultState, 'failed');
    assert.equal(worker.frames.at(-1).meta.outcomeUnknown, false);
    await workerRequest(h, worker, 2, 'AllLands');
    h.api.handleMessage(h.account, Buffer.from(JSON.stringify({
        meta: { message_type: 2, client_seq: 2, server_seq: 50 }, body: Buffer.from('业务原文'),
    })));
    const reply = worker.frames.at(-1);
    assert.equal(reply.meta.resultState, 'completed');
    assert.equal(reply.meta.serverSeq, 100);
    assert.equal(Buffer.from(reply.body, 'base64').toString(), '业务原文');
    const raw = Buffer.from(JSON.stringify({ meta: { message_type: 3, server_seq: 120 }, body: Buffer.from('通知原文') }));
    h.api.handleMessage(h.account, raw);
    assert.deepEqual(Buffer.from(worker.frames.at(-1).body, 'base64'), raw);
    assert.equal(h.account.serverSeq, 120);
});

test('契约恢复：退避窗口已结束仍发businessHealthy恢复，不让client一直dead', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(30000);
    assert.equal(h.account.healthBackoffChanging, false);
    await workerRequest(h, worker);
    h.reply(1);
    const events = worker.frames.filter(frame => frame.name === 'connection_recovered');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.businessHealthy, true);
    assert.equal(h.api.gatewayHealthStatus(h.account).businessHealthy, true);
});

test('契约恢复：同一业务成功先link恢复false再business恢复true，取消所有dead timer', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const seq = await h.api.sendMsg(h.account, BUSINESS_SERVICE, 'AllLands', Buffer.alloc(0), {
        workerSock: worker, workerSeq: 1, timeoutMs: 60000,
    });
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(30000);
    h.account.connectionDead = true;
    h.account.deadReconnectTimer = h.clock.setTimeout(() => {}, 180000);
    h.reply(seq);
    const events = worker.frames.filter(frame => frame.name === 'connection_recovered');
    assert.deepEqual(events.map(frame => frame.payload.businessHealthy), [false, true]);
    assert.equal(h.account.deadReconnectTimer, null);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.api.gatewayHealthStatus(h.account).businessHealthy, true);
});

test('契约健康：Infinity 保留不误判新连接 healthy；新鲜HB延后confirm无1ms空转', async () => {
    const h = gatewayVm();
    assert.equal(h.health.evaluateGatewayHealth({ heartbeatAgeMs: Infinity }).linkHealthy, false);
    assert.equal(h.health.evaluateGatewayHealth({ businessAgeMs: Infinity }).businessHealthy, false);
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(200000);
    const seq = await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    h.reply(seq);
    assert.equal(h.account.deadConfirmTimer.at - h.clock.now(), 210000);
    await h.clock.advance(20000);
    assert.equal(h.account.connectionDead, false);
    assert.ok(h.account.deadConfirmTimer.at - h.clock.now() > 1000);
});

test('契约健康：gid缺失的OPEN连接不产生1ms confirm空转', async () => {
    const h = gatewayVm();
    h.account.userState.gid = 0;
    h.api.noteBusinessTimeout(h.account, h.clock.now());
    await h.clock.advance(220000);
    assert.equal(h.account.deadConfirmTimer, null);
    assert.equal(h.account.connectionDead, false);
    assert.equal(h.clock.timers.size, 0);
});

test('契约 epoch：真实登录帧与断链事件标记所属session，重连后旧callback仍旧epoch', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', code: 'fresh' });
    const socket = h.account.ws;
    const epoch = h.account.connectionEpoch;
    socket.emit('open');
    await flush();
    h.api.handleMessage(h.account, Buffer.from(JSON.stringify({
        meta: { message_type: 2, client_seq: 1, server_seq: 10 },
        body: Buffer.from(JSON.stringify({ basic: { gid: 1, name: '模拟账号' } })),
    })), socket, epoch);
    assert.equal(worker.frames.at(-1).t, 'login');
    assert.equal(worker.frames.at(-1).connectionEpoch, epoch);
    await workerRequest(h, worker, 22, 'AllLands');
    socket.emit('close', 1000);
    const closed = worker.frames.find(frame => frame.name === 'disconnect');
    const cancelled = worker.frames.find(frame => frame.t === 'response' && frame.seq === 22);
    assert.equal(closed.connectionEpoch, epoch);
    assert.equal(cancelled.connectionEpoch, epoch);
    assert.equal(cancelled.meta.resultState, 'failed');
    assert.ok(h.account.connectionEpoch > epoch);
});

test('契约 resultState：本地Promise只读timeout也为failed，成功携completed与epoch', async () => {
    const h = gatewayVm();
    const request = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'AllLands', Buffer.alloc(0), 50);
    const rejected = assert.rejects(request, error => error.resultState === 'failed'
        && !error.outcomeUnknown && error.connectionEpoch === 0);
    await flush();
    await h.clock.advance(50);
    await rejected;
    const success = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'AllLands', Buffer.alloc(0));
    await flush();
    h.reply(2);
    const result = await success;
    assert.equal(result.meta.resultState, 'completed');
    assert.equal(result.meta.connectionEpoch, 0);
});

test('契约输入：未知帧不绑定资源，超过1MiB body在Buffer构造前拒绝', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await h.api.handleWorkerFrame(worker, { t: 'unknown', accountId: '2', body: {} });
    await bindWorker(h, worker);
    const over = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    await h.api.handleWorkerFrame(worker, { t: 'request', accountId: '1', seq: 1,
        service: BUSINESS_SERVICE, method: 'Harvest', body: over });
    assert.equal(worker.frames.at(-1).meta.errorCode, 'INVALID_REQUEST');
    assert.equal(worker.frames.at(-1).meta.resultState, 'not_sent');
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.ws.sent.length, 0);
});

function requestWithMeta(h, worker, seq, method, meta, service = BUSINESS_SERVICE, body = '') {
    return h.api.handleWorkerFrame(worker, { t: 'request', accountId: '1', connectionEpoch: h.account.connectionEpoch,
        seq, service, method, body, meta });
}

for (const timeoutMs of [15000, 30000]) {
    test(`二轮预算：IPC只读显式${timeoutMs}ms透传，wire后到期failed`, async () => {
        const h = gatewayVm();
        const worker = h.ipc();
        await bindWorker(h, worker);
        await requestWithMeta(h, worker, 1, 'AllLands', { timeoutMs });
        const op = Array.from(h.account.operations)[0];
        assert.equal(op.timeoutMs, timeoutMs);
        assert.equal(op.timer.at - op.sentAt, timeoutMs);
        await h.clock.advance(timeoutMs - 1);
        assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
        await h.clock.advance(1);
        const error = worker.frames.at(-1);
        assert.equal(error.meta.resultState, 'failed');
        assert.equal(error.meta.timeoutMs, timeoutMs);
        assert.equal(error.meta.settlementTimeoutMs, timeoutMs);
        assert.equal(h.account.operations.size, 0);
    });
}

for (const [value, expected] of [[0, 1], [-10, 1], [90000, 60000], [1.8, 1], ['6000', 30000], [null, 30000]]) {
    test(`二轮预算：timeoutMs=${JSON.stringify(value)}只接受有限数字且界限为${expected}ms`, async () => {
        const h = gatewayVm();
        const worker = h.ipc();
        await bindWorker(h, worker);
        await requestWithMeta(h, worker, 1, 'AllLands', { timeoutMs: value });
        const op = Array.from(h.account.operations)[0];
        assert.equal(op.timeoutMs, expected);
        assert.equal(op.settlementTimeoutMs, expected);
        assert.ok(op.timer.at - op.sentAt <= 60000);
        h.reply(op.seq);
    });
}

test('二轮deadline：已过绝对期限空body也立即not_sent，不分配wire seq', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 60000, deadline: h.clock.now() - 1 });
    assert.equal(worker.frames.at(-1).meta.resultState, 'not_sent');
    assert.equal(worker.frames.at(-1).meta.sent, false);
    assert.equal(h.account.clientSeq, 0);
    assert.equal(h.account.operations.size, 0);
});

test('二轮deadline：编码超时不延成120秒，后返回不能wire写', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const request = requestWithMeta(h, worker, 1, 'Harvest', {
        timeoutMs: 6000, deadline: h.clock.now() + 100,
    }, BUSINESS_SERVICE, Buffer.from('写体').toString('base64'));
    await h.clock.advance(100);
    await request;
    const error = worker.frames.at(-1);
    assert.equal(error.meta.resultState, 'not_sent');
    assert.equal(error.meta.settlementTimeoutMs, 0);
    assert.equal(h.account.operations.size, 0);
    runtime.gate.resolve();
    await flush();
    assert.equal(runtime.encryptions.length, 0);
    assert.equal(h.account.ws.sent.length, 0);
});

test('二轮deadline：读排队后发送重新取得完整wire预算，旧queue timer无效', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const blocker = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.from('HB'), { timeoutMs: 60000 });
    const read = requestWithMeta(h, worker, 1, 'AllLands', { timeoutMs: 15000, deadline: h.clock.now() + 5000 });
    const op = Array.from(h.account.operations).find(value => value.kind === 'business');
    const oldTimer = op.timer;
    await h.clock.advance(4000);
    runtime.gate.resolve();
    await Promise.all([blocker, read]);
    assert.equal(op.deadline - op.sentAt, 15000);
    oldTimer.fn();
    assert.equal(op.done, false);
    await h.clock.advance(14999);
    assert.equal(op.done, false);
    await h.clock.advance(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'failed');
});

test('二轮写：6000ms与绝对deadline只管未发，75秒真实回复仍经worker结算', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 6000, deadline: h.clock.now() + 1000 });
    const op = Array.from(h.account.operations)[0];
    assert.equal(op.settlementTimeoutMs, 120000);
    assert.equal(op.deadline - op.sentAt, 120000);
    await h.clock.advance(75000);
    await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: 1, connectionEpoch: op.epoch });
    assert.equal(op.done, false);
    assert.equal(h.account.pendingCallbacks.size, 1);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
    const rawBody = Buffer.from('真实写结算原文');
    h.api.handleMessage(h.account, Buffer.from(JSON.stringify({ meta: {
        message_type: 2, client_seq: op.seq, server_seq: 90,
    }, body: rawBody })));
    const reply = worker.frames.at(-1);
    assert.equal(reply.t, 'response');
    assert.equal(reply.meta.resultState, 'completed');
    assert.equal(reply.meta.settlementTimeoutMs, 120000);
    assert.equal(reply.meta.timeoutMs, 6000);
    assert.equal(reply.connectionEpoch, op.epoch);
    assert.deepEqual(Buffer.from(reply.body, 'base64'), rawBody);
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.ws.sent.length, 1);
});

test('二轮写：最大120秒unknown前不释放callback，旧queue timer不能提前结算', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const request = requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 6000 }, BUSINESS_SERVICE, Buffer.from('x').toString('base64'));
    const op = Array.from(h.account.operations)[0];
    const queueTimer = op.timer;
    runtime.gate.resolve();
    await request;
    queueTimer.fn();
    await h.clock.advance(119999);
    assert.equal(op.done, false);
    assert.equal(h.account.pendingCallbacks.size, 1);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
    await h.clock.advance(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'unknown');
    assert.equal(worker.frames.at(-1).meta.outcomeUnknown, true);
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.account.pendingCallbacks.size, 0);
    assert.equal(h.account.ws.sent.length, 1);
});

test('二轮写：32业务写占位至settle，HB/ACE/Login独立3席，不受低timeout/cancel突破', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    for (let i = 1; i <= 32; i += 1) {
        await requestWithMeta(h, worker, i, 'Harvest', { timeoutMs: 6000 });
        await h.api.handleWorkerFrame(worker, { t: 'cancel', accountId: '1', seq: i });
    }
    await h.clock.advance(75000);
    assert.equal(h.account.operations.size, 32);
    await requestWithMeta(h, worker, 33, 'Harvest', { timeoutMs: 6000 });
    assert.equal(worker.frames.at(-1).meta.errorCode, 'QUEUE_FULL');
    await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0));
    await h.api.sendMsg(h.account, ACE_SERVICE, 'AntiData', Buffer.alloc(0));
    await h.api.sendMsg(h.account, USER_SERVICE, 'Login', Buffer.alloc(0));
    assert.equal(h.account.operations.size, 35);
    assert.equal(h.account.criticalFlights.size, 3);
    assert.equal(h.api.gatewayHealthStatus(h.account).writePendingCount, 32);
});

test('二轮critical：ACE只AntiData预算20秒不延到120秒，未知method按业务写', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await requestWithMeta(h, worker, 1, 'AntiData', { timeoutMs: 20000 }, ACE_SERVICE);
    await requestWithMeta(h, worker, 2, 'Unknown', { timeoutMs: 20000 }, ACE_SERVICE);
    const ops = Array.from(h.account.operations);
    assert.equal(ops[0].kind, 'ace');
    assert.equal(ops[0].settlementTimeoutMs, 20000);
    assert.equal(ops[1].kind, 'business');
    assert.equal(ops[1].settlementTimeoutMs, 120000);
    await h.clock.advance(20000);
    assert.equal(ops[0].done, true);
    assert.equal(ops[1].done, false);
});

test('二轮只读：15秒后callback不保留，75秒late仅link入站不business成功', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await requestWithMeta(h, worker, 1, 'AllLands', { timeoutMs: 15000 });
    await h.clock.advance(75000);
    assert.equal(h.account.pendingCallbacks.size, 0);
    h.reply(1, 0, 100);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 1);
    assert.equal(h.account.lastBusinessSuccessAt, 0);
    assert.equal(h.account.serverSeq, 100);
});

test('二轮旧世代：75秒旧写回复不能匹配新连接相同seq或污染身份状态', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const oldSocket = h.account.ws;
    const oldEpoch = h.account.connectionEpoch;
    await requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 6000 });
    await h.clock.advance(75000);
    assert.equal(h.account.pendingCallbacks.size, 1);
    h.api.closeCurrentWs(h.account);
    h.account.ws = new h.Socket();
    h.account.tsdkRuntime = new h.Runtime({ accountId: '1' });
    h.account.clientSeq = 0;
    await requestWithMeta(h, worker, 2, 'AllLands', { timeoutMs: 60000 });
    const fresh = Array.from(h.account.operations)[0];
    const before = h.account.lastInboundAt;
    h.api.handleMessage(h.account, Buffer.from(JSON.stringify({ meta: {
        message_type: 2, client_seq: 1, server_seq: 999,
    } })), oldSocket, oldEpoch);
    assert.equal(fresh.done, false);
    assert.equal(h.account.lastInboundAt, before);
    assert.equal(h.account.serverSeq, 0);
    assert.equal(h.account.lastBusinessSuccessAt, 0);
    assert.equal(worker.frames.find(frame => frame.seq === 1 && frame.t === 'response').connectionEpoch, oldEpoch);
});

test('二轮结果：75秒明确写错误failed，空写回复不伪造reward/领取成功', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await requestWithMeta(h, worker, 1, 'ClaimReward', { timeoutMs: 6000 });
    await requestWithMeta(h, worker, 2, 'ClaimReward', { timeoutMs: 6000 });
    await h.clock.advance(75000);
    h.reply(1, 42);
    h.reply(2);
    const replies = worker.frames.filter(frame => frame.t === 'response');
    assert.equal(replies[0].meta.resultState, 'failed');
    assert.equal(replies[0].meta.outcomeUnknown, false);
    assert.equal(replies[1].body, '');
    assert.equal(replies[1].meta.resultState, 'completed');
    assert.equal(Object.hasOwn(replies[1], 'reward'), false);
    assert.equal(Object.hasOwn(replies[1].meta, 'reward'), false);
    assert.equal(Object.hasOwn(replies[1], 'ok'), false);
});

test('二轮诊断：并发超时/真实dead/link与business恢复日志低频且时间真实无secret', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    h.account.savedCode = '禁止日志泄露code';
    await Promise.all(Array.from({ length: 7 }, (_, i) => workerRequest(h, worker, i + 1, 'AllLands')));
    await h.clock.advance(30000);
    const degraded = h.logs.filter(args => String(args[1]).includes('业务亚健康'));
    assert.equal(degraded.length, 1);
    assert.match(degraded[0][1], /account 1 epoch=0/);
    assert.match(degraded[0][1], /真实入站静默 30s/);
    assert.equal(h.account.connectionDead, false);
    await h.clock.advance(180000);
    const dead = h.logs.filter(args => String(args[1]).includes('真实静默判死'));
    assert.equal(dead.length, 1);
    assert.match(dead[0][1], /入站静默 210s/);
    h.notify(80);
    h.notify(81);
    assert.equal(h.logs.filter(args => String(args[1]).includes('链路入站恢复')).length, 1);
    await workerRequest(h, worker, 8, 'AllLands');
    h.reply(8);
    assert.equal(h.logs.filter(args => String(args[1]).includes('业务回复恢复')).length, 1);
    assert.equal(h.logs.some(args => String(args[1]).includes('禁止日志泄露code')), false);
});

test('二轮排队：未发写仍受6000ms短TTL，不借120秒结算预算滞留', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    h.account.tsdkRuntime.gate = deferred();
    const blocking = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.from('HB'), { timeoutMs: 60000 });
    const queued = requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 6000 });
    await h.clock.advance(6000);
    await queued;
    assert.equal(worker.frames.at(-1).meta.resultState, 'not_sent');
    assert.equal(worker.frames.at(-1).meta.settlementTimeoutMs, 0);
    assert.equal(h.account.sendQueue.length, 0);
    assert.equal(h.account.ws.sent.length, 0);
    h.account.tsdkRuntime.gate.resolve();
    await blocking;
    assert.equal(h.account.ws.sent.length, 1);
    assert.equal(h.account.ws.sent[0].meta.method_name, 'Heartbeat');
});

test('二轮并发：7个写30秒无回复仍保留结算且不判死，120秒后只进入真实观察', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await Promise.all(Array.from({ length: 7 }, (_, i) => requestWithMeta(h, worker, i + 1, 'Harvest', { timeoutMs: 6000 })));
    await h.clock.advance(30000);
    assert.equal(h.account.pendingCallbacks.size, 7);
    assert.equal(h.account.operations.size, 7);
    assert.equal(h.account.requestTimeoutStreak, 0);
    assert.equal(h.account.connectionDead, false);
    assert.equal(worker.frames.filter(frame => frame.t === 'response').length, 0);
    await h.clock.advance(90000);
    assert.equal(h.account.requestTimeoutStreak, 7);
    assert.equal(h.account.connectionDead, false);
    assert.equal(worker.frames.filter(frame => frame.meta?.resultState === 'unknown').length, 7);
    await h.clock.advance(89999);
    assert.equal(h.account.connectionDead, false);
    await h.clock.advance(1);
    assert.equal(h.account.connectionDead, true);
});

test('二轮写：排队5秒后wire重新计满120秒，不被入队时钟提前unknown', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const blocking = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.from('HB'), { timeoutMs: 60000 });
    const request = requestWithMeta(h, worker, 1, 'Harvest', { timeoutMs: 6000 });
    await h.clock.advance(5000);
    runtime.gate.resolve();
    await Promise.all([blocking, request]);
    const op = Array.from(h.account.operations).find(value => value.kind === 'business');
    assert.equal(op.sentAt - op.startedAt, 5000);
    assert.equal(op.deadline - op.sentAt, 120000);
    await h.clock.advance(119999);
    assert.equal(op.done, false);
    await h.clock.advance(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'unknown');
});

test('三轮确认：实际send后request_sent字段精确，排队45秒后仍完整120秒结算', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    h.account.tsdkRuntime.gate = deferred();
    const blocking = h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.from('HB'), { timeoutMs: 60000 });
    const request = requestWithMeta(h, worker, 81, 'Harvest', { timeoutMs: 60000 });
    await h.clock.advance(45000);
    assert.equal(worker.frames.filter(frame => frame.t === 'request_sent').length, 0);
    h.account.tsdkRuntime.gate.resolve();
    await Promise.all([blocking, request]);
    const op = Array.from(h.account.operations).find(value => value.kind === 'business');
    const ack = worker.frames.find(frame => frame.t === 'request_sent');
    assert.deepEqual(Object.keys(ack).sort(), ['accountId', 'connectionEpoch', 'readOnly', 'sentAt', 'seq', 'settlementDeadline', 't'].sort());
    assert.equal(ack.accountId, '1');
    assert.equal(ack.seq, 81);
    assert.equal(ack.connectionEpoch, op.epoch);
    assert.equal(ack.sentAt, 46000);
    assert.equal(ack.settlementDeadline, ack.sentAt + 120000);
    assert.equal(ack.readOnly, false);
    await h.clock.advance(100000);
    assert.equal(op.done, false);
    h.reply(op.seq);
    assert.equal(worker.frames.at(-1).meta.resultState, 'completed');
    assert.equal(worker.frames.at(-1).seq, 81);
});

test('三轮确认：只读ack到原callback socket，不抢新worker；发送异常/未发取消无ack', async () => {
    const h = gatewayVm();
    const old = h.ipc();
    const fresh = h.ipc();
    await bindWorker(h, old);
    h.account.tsdkRuntime.gate = deferred();
    const request = requestWithMeta(h, old, 7, 'AllLands', { timeoutMs: 30000 }, BUSINESS_SERVICE, Buffer.from('x').toString('base64'));
    await bindWorker(h, fresh);
    h.account.tsdkRuntime.gate.resolve();
    await request;
    const ack = old.frames.find(frame => frame.t === 'request_sent');
    assert.equal(ack.readOnly, true);
    assert.equal(ack.settlementDeadline - ack.sentAt, 30000);
    assert.equal(fresh.frames.filter(frame => frame.t === 'request_sent').length, 0);
    assert.equal(h.account.workerSock, fresh);
    h.account.ws.sendError = true;
    await workerRequest(h, fresh, 8);
    assert.equal(fresh.frames.filter(frame => frame.t === 'request_sent').length, 0);
    assert.equal(fresh.frames.at(-1).meta.resultState, 'unknown');
});

test('三轮排空：已发自动写70秒SIGTERM后不close，真实回复触发排空退出', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const socket = h.account.ws;
    await requestWithMeta(h, worker, 1, 'AutoCommand', { timeoutMs: 6000 });
    await h.clock.advance(70000);
    const epoch = h.account.connectionEpoch;
    const flight = h.api.shutdownGateway();
    assert.equal(h.api.shutdownGateway(), flight);
    assert.equal(h.api.gatewayHealthStatus(h.account).quiescing, true);
    assert.equal(h.api.gatewayHealthStatus(h.account).writePendingCount, 1);
    assert.equal(socket.closed, 0);
    assert.equal(h.account.connectionEpoch, epoch);
    assert.deepEqual(h.exits, []);
    await workerRequest(h, worker, 2);
    assert.equal(worker.frames.at(-1).meta.errorCode, 'GATEWAY_SHUTTING_DOWN');
    assert.equal(worker.frames.at(-1).meta.resultState, 'not_sent');
    await h.clock.advance(5000);
    assert.equal(socket.closed, 0);
    h.reply(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'completed');
    await flight;
    assert.deepEqual(h.exits, [0]);
    assert.equal(socket.closed, 1);
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.clock.timers.size, 0);
});

test('三轮排空：70秒开始关闭只等剩余50秒，120秒unknown后立即退出不等满新窗口', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const socket = h.account.ws;
    await workerRequest(h, worker, 1, 'AutoWrite');
    await h.clock.advance(70000);
    const flight = h.api.shutdownGateway();
    await h.clock.advance(49999);
    assert.equal(socket.closed, 0);
    assert.equal(h.account.pendingCallbacks.size, 1);
    assert.deepEqual(h.exits, []);
    await h.clock.advance(1);
    await flight;
    assert.equal(worker.frames.at(-1).meta.resultState, 'unknown');
    assert.equal(socket.closed, 1);
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.clock.timers.size, 0);
});

test('三轮排空：未发encoding/queued全部not_sent，原runtime到达后不能wire', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const runtime = h.account.tsdkRuntime;
    runtime.gate = deferred();
    const a = requestWithMeta(h, worker, 1, 'Harvest', {}, BUSINESS_SERVICE, Buffer.from('x').toString('base64'));
    const b = workerRequest(h, worker, 2);
    const socket = h.account.ws;
    await h.api.shutdownGateway();
    await Promise.all([a, b]);
    runtime.gate.resolve();
    await flush();
    const replies = worker.frames.filter(frame => frame.t === 'response');
    assert.equal(replies.length, 2);
    assert.ok(replies.every(frame => frame.meta.resultState === 'not_sent'));
    assert.equal(worker.frames.filter(frame => frame.t === 'request_sent').length, 0);
    assert.equal(socket.sent.length, 0);
    assert.equal(runtime.encryptions.length, 0);
    assert.equal(socket.closed, 1);
    assert.deepEqual(h.exits, [0]);
});

test('三轮排空：所有账号及无worker自动写均被纳入drain，单账号回复不早退', async () => {
    const h = gatewayVm();
    const second = h.api.createConn('2');
    second.ws = new h.Socket();
    second.tsdkRuntime = new h.Runtime({ accountId: '2' });
    second.userState.gid = 2;
    second.connectedAt = h.clock.now();
    h.api.accounts.set('2', second);
    const a = h.api.gatewaySendRequest(h.account, BUSINESS_SERVICE, 'AutoWrite', Buffer.alloc(0), 6000);
    const b = h.api.gatewaySendRequest(second, BUSINESS_SERVICE, 'AutoWrite', Buffer.alloc(0), 6000);
    await flush();
    const firstSocket = h.account.ws;
    const secondSocket = second.ws;
    const flight = h.api.shutdownGateway();
    h.reply(1);
    await a;
    assert.deepEqual(h.exits, []);
    assert.equal(firstSocket.closed, 0);
    assert.equal(secondSocket.closed, 0);
    h.api.handleMessage(second, Buffer.from(JSON.stringify({ meta: { message_type: 2, client_seq: 1, server_seq: 2 } })));
    await b;
    await flight;
    assert.equal(firstSocket.closed, 1);
    assert.equal(secondSocket.closed, 1);
    assert.deepEqual(h.exits, [0]);
});

test('三轮排空：critical停止不终止runtime/WS，status/ping可读且stop/connect不破坏写', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    const reader = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker, 1, 'AutoWrite');
    await workerRequest(h, worker, 2, 'AllLands');
    h.api.startHeartbeat(h.account);
    h.api.startAceService(h.account);
    const runtime = h.account.tsdkRuntime;
    const socket = h.account.ws;
    const flight = h.api.shutdownGateway();
    assert.equal(h.account.operations.size, 1);
    assert.equal(h.account.heartbeatTimer, null);
    assert.equal(runtime.destroyed, false);
    await h.api.handleWorkerFrame(worker, { t: 'stop', accountId: '1' });
    await h.api.handleWorkerFrame(worker, { t: 'connect', accountId: '1', code: 'new' });
    assert.equal(h.account.ws, socket);
    assert.equal(socket.closed, 0);
    assert.equal(h.account.savedCode, 'saved');
    await h.api.handleWorkerFrame(reader, { t: 'status', accountId: '1' });
    assert.equal(reader.frames.at(-1).state.quiescing, true);
    assert.equal(reader.frames.at(-1).state.writePendingCount, 1);
    await h.api.handleWorkerFrame(reader, { t: 'ping' });
    assert.equal(reader.frames.at(-1).t, 'pong');
    assert.equal(h.account.workerSock, worker);
    assert.equal(await h.api.sendMsg(h.account, USER_SERVICE, 'Heartbeat', Buffer.alloc(0)), -1);
    h.reply(1);
    await flight;
    assert.equal(runtime.destroyed, true);
});

test('三轮排空：原结算timer丢失也受剩余deadline加5秒兜底，未使用poll', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker);
    const op = Array.from(h.account.operations)[0];
    h.clock.clearTimeout(op.timer);
    const flight = h.api.shutdownGateway();
    await h.clock.advance(124999);
    assert.equal(op.done, false);
    assert.deepEqual(h.exits, []);
    await h.clock.advance(1);
    await flight;
    assert.equal(worker.frames.at(-1).meta.resultState, 'unknown');
    assert.deepEqual(h.exits, [0]);
});

test('三轮确认：IPC ack写异常不释放已发游戏写，真实reply仍可结算', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    await bindWorker(h, worker);
    const originalWrite = worker.write;
    worker.write = function(data) {
        if (JSON.parse(data).t === 'request_sent') throw new Error('模拟确认IPC失效');
        originalWrite.call(this, data);
    };
    await workerRequest(h, worker);
    assert.equal(h.account.ws.sent.length, 1);
    assert.equal(h.account.pendingCallbacks.size, 1);
    assert.equal(h.account.operations.size, 1);
    await h.clock.advance(75000);
    h.reply(1);
    assert.equal(worker.frames.at(-1).meta.resultState, 'completed');
    assert.equal(h.account.operations.size, 0);
    assert.equal(h.logs.filter(args => String(args[1]).includes('发送确认回传失败')).length, 1);
});

test('三轮排空：新worker连接不能抢排空原worker或创建账号', async () => {
    const h = gatewayVm();
    const worker = h.ipc();
    const fresh = h.ipc();
    await bindWorker(h, worker);
    await workerRequest(h, worker);
    const flight = h.api.shutdownGateway();
    await bindWorker(h, fresh);
    assert.equal(fresh.frames.at(-1).t, 'error');
    assert.equal(h.account.workerSock, worker);
    await h.api.handleWorkerFrame(h.ipc(), { t: 'connect', accountId: '9' });
    assert.equal(h.api.accounts.has('9'), false);
    h.reply(1);
    await flight;
    assert.equal(worker.frames.at(-1).meta.resultState, 'completed');
});

test('三轮排空：空队列关闭立即完成，重复关闭共享结果仅exit一次', async () => {
    const h = gatewayVm();
    const flight = h.api.shutdownGateway();
    assert.equal(h.api.shutdownGateway(), flight);
    await flight;
    await h.api.shutdownGateway();
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.clock.timers.size, 0);
});

test('路由：主网关不抢委托微信账号，隔离网关只接受登记的微信2号', async () => {
    const delegation = { phase: 'active', accountIds: ['2'] };
    const main = gatewayVm({ delegation });
    const mainSock = main.ipc();
    await main.api.handleWorkerFrame(mainSock, { t: 'connect', accountId: '2' });
    assert.equal(mainSock.frames[0].t, 'error');
    assert.equal(main.api.accounts.has('2'), false);
    const isolated = gatewayVm({ delegation, env: { FARM_WX_GATEWAY: '1', FARM_GATEWAY_SOCK: '/sock/qq-farm-wx.sock' } });
    const isolatedSock = isolated.ipc();
    await isolated.api.handleWorkerFrame(isolatedSock, { t: 'connect', accountId: '1' });
    assert.equal(isolatedSock.frames[0].t, 'error');
    assert.equal(isolated.filesystemWrites.length, 0);
});
