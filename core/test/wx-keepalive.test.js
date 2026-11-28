const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 真实磁盘仅读取源码；凭据、操作锁、HTTP、原生连接与游戏连接全部在内存模拟。
const gatewaySource = fs.readFileSync(path.join(__dirname, '../src/runtime/gateway-process.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/service.js'), 'utf8');
const storageSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/credential-storage.js'), 'utf8');
const nativeSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/native-protocol.js'), 'utf8');
const gatewayHealthSource = fs.readFileSync(path.join(__dirname, '../src/utils/gateway-health.js'), 'utf8');
const requestPrioritySource = fs.readFileSync(path.join(__dirname, '../src/utils/request-priority.js'), 'utf8');
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const MINUTE = 60000;
const record = () => ({ openid: 'wx-test', loginBuffer: 'buffer-old', refreshtoken: 'refresh-old', accesstoken: 'access-old', updatedAt: 1, tokenCheckedAt: 1, loginBufferUpdatedAt: 1, credentialGeneration: 'generation-old' });
const saved = h => JSON.parse(h.storage.files.get(h.storage.file));
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function clock() {
    let now = 100 * MINUTE + 1;
    let sequence = 0;
    const timers = new Map();
    class FakeDate extends Date { static now() { return now; } }
    const set = (fn, ms, interval = false) => {
        const id = { id: ++sequence, unref() {} };
        timers.set(id, { fn, at: now + ms, ms, interval });
        return id;
    };
    const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    return {
        Date: FakeDate, timers, flush,
        setTimeout: (fn, ms) => set(fn, ms), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => set(fn, ms, true), clearInterval: id => timers.delete(id),
        setNow(value) { now = value; },
        async advance(ms) {
            const end = now + ms;
            await flush();
            while (true) {
                const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                const [id, t] = next;
                now = t.at;
                if (t.interval) t.at += t.ms;
                else timers.delete(id);
                t.fn();
                await flush();
            }
            now = end;
            await flush();
        },
    };
}

function fakeFs(initial, credentialDirectory = 'wx-login') {
    const file = `/fake/${credentialDirectory}/wx-test.json`;
    const files = new Map([[file, JSON.stringify(initial)]]);
    const fds = new Map();
    const locks = new Set();
    let nextFd = 0;
    const api = {
        mkdirSync(name, options) {
            if (options?.recursive) return;
            if (locks.has(name)) throw Object.assign(new Error('busy'), { code: 'EEXIST' });
            assert.equal(options?.mode, 0o700);
            locks.add(name);
        },
        rmdirSync(name) {
            assert.equal([...files.keys()].filter(key => path.posix.dirname(key) === name).length, 0);
            assert.ok(locks.delete(name));
        },
        files, file, locks, failWrite: false, beforeRenameCheck: null, writes: [],
        readFileSync(name) {
            if (!files.has(name)) throw Object.assign(new Error('模拟文件不存在'), { code: 'ENOENT' });
            return files.get(name);
        },
        existsSync: name => files.has(name),
        openSync(name, flags, mode) {
            assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
            assert.ok(!files.has(name));
            const fd = ++nextFd;
            files.set(name, ''); fds.set(fd, name);
            return fd;
        },
        writeFileSync(fd, text) {
            if (api.failWrite) throw new Error('ENOSPC 模拟磁盘写失败');
            assert.ok(fds.has(fd), '禁止直接整份覆盖目标文件');
            files.set(fds.get(fd), text);
        },
        fsyncSync(fd) { if (api.beforeRenameCheck && String(fds.get(fd)).endsWith('.tmp')) { const fn = api.beforeRenameCheck; api.beforeRenameCheck = null; fn(); } },
        closeSync: fd => fds.delete(fd),
        renameSync(temp, target) { files.set(target, files.get(temp)); files.delete(temp); api.writes.push(JSON.parse(files.get(target))); },
        unlinkSync(name) {
            assert.notEqual(name, file);
            if (!files.delete(name)) throw Object.assign(new Error('模拟文件不存在'), { code: 'ENOENT' });
        },
        readdirSync(name) {
            if (locks.has(name)) return [...files.keys()].filter(fileName => path.posix.dirname(fileName) === name).map(fileName => path.posix.basename(fileName));
            throw new Error('禁止扫描 latest 文件');
        },
        readlinkSync() { throw Object.assign(new Error('没有模拟proc视角'), { code: 'ENOENT' }); },
    };
    return api;
}

function response(data, status = 200) {
    return { status, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(data)) };
}
const tokenResponse = () => response({ code: 0, userInfo: { accessToken: 'access-new', refreshToken: 'refresh-new' } });
const bufferResponse = () => response({ code: 0, extInfo: { listS: { loginBuffer: { value: ['buffer-new'] } } } });
function nativeRecord(time, binding) {
    const ticket = Buffer.alloc(9, 7); ticket[0] = 1; ticket.writeUInt32BE(7200, 1);
    return {
        version: 1, binding, uin: '42', createdAt: time.Date.now(), expiresAt: time.Date.now() + 120 * MINUTE,
        sendKey: Buffer.alloc(16, 1).toString('base64'), recvKey: Buffer.alloc(16, 2).toString('base64'),
        f9: '', deviceId: Buffer.from('synthetic-device').toString('base64'),
        hostAppId: Buffer.from('synthetic-host').toString('base64'),
        psk: Buffer.alloc(32, 3).toString('base64'), ticket: ticket.toString('base64'),
    };
}
let cryptoSequence = 0;
const fakeCrypto = {
    createHash: (...args) => crypto.createHash(...args),
    randomInt(minimum) { return minimum; },
    randomBytes(length) {
        const bytes = Buffer.alloc(length);
        bytes.writeUInt32BE(++cryptoSequence, length - 4);
        return bytes;
    },
};

function loadGatewayUtils(time) {
    const load = (source, filename, dependencies = {}) => {
        const module = { exports: {} };
        vm.runInNewContext(source, {
            module, exports: module.exports, Buffer, Error, AbortController, Date: time.Date,
            setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
            require(name) {
                if (Object.hasOwn(dependencies, name)) return dependencies[name];
                throw new Error(`禁止utils依赖: ${name}`);
            },
        }, { filename });
        return module.exports;
    };
    return {
        health: load(gatewayHealthSource, 'gateway-health.js'),
        priority: load(requestPrioritySource, 'request-priority.js', {
            'node:async_hooks': { AsyncLocalStorage }, 'node:crypto': fakeCrypto,
        }),
    };
}

function loadNative(time) {
    const module = { exports: {} };
    vm.runInNewContext(nativeSource, {
        module, exports: module.exports, Buffer, Error, AbortController, Date: time.Date,
        setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
        fetch() { throw new Error('禁止未mock的原生HTTP请求'); },
        require(name) {
            if (name === 'node:crypto') return fakeCrypto;
            if (name === 'node:net') return { createConnection() { throw new Error('禁止真实原生连接'); } };
            throw new Error(`禁止真实 require: ${name}`);
        },
    }, { filename: 'native-protocol.js' });
    return module.exports;
}
function loadStorage(storage, time, pid = 123) {
    const module = { exports: {} };
    vm.runInNewContext(storageSource, {
        module, exports: module.exports, process: { pid }, Date: time.Date, Error,
        require(name) {
            if (name === 'node:fs') return storage;
            if (name === 'node:crypto') return fakeCrypto;
            throw new Error(`不允许storage依赖: ${name}`);
        },
    }, { filename: 'credential-storage.js' });
    return module.exports;
}
function loadService(time, fetch, native = { ...loadNative(time), getNativeWxLoginCode: async () => 'code-fake' }) {
    const module = { exports: {} };
    vm.runInNewContext(serviceSource, {
        module, exports: module.exports, Buffer, URL, URLSearchParams, Headers, AbortController, Error,
        Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, fetch,
        require(name) {
            if (name === 'node:crypto') return fakeCrypto;
            if (name === './native-protocol') return native;
            throw new Error(`禁止真实 require: ${name}`);
        },
    }, { filename: 'wx-login/service.js' });
    return module.exports.WxLoginService;
}

function loadGateway({ initial = record(), Service, time = clock(), env = {}, delegation = null, storage: sharedStorage } = {}) {
    Service = Service || successfulService({ calls: 0 }, time);
    const storage = sharedStorage || fakeFs(initial, env.FARM_WX_GATEWAY === '1' ? 'wx-gateway' : 'wx-login');
    const storageApi = loadStorage(storage, time);
    const nativeApi = loadNative(time);
    const utils = loadGatewayUtils(time);
    const logs = [];
    const frames = [];
    const storeAccounts = [{ id: '2', platform: 'wx', wxid: 'wx-test' }];
    const store = { getAccounts: () => ({ accounts: storeAccounts }) };
    const wsSockets = [];
    class FakeWebSocket extends EventEmitter {
        constructor() {
            super(); this.OPEN = 1; this.CONNECTING = 0; this.readyState = 0;
            this.writes = [];
            this.credentialAtConnect = JSON.parse(storage.files.get(storage.file));
            wsSockets.push(this);
        }
        terminate() { this.readyState = 3; }
        close() { this.readyState = 3; this.emit('close', 1000); }
        send(bytes) { assert.equal(this.readyState, this.OPEN); this.writes.push(Buffer.from(bytes)); }
    }
    const types = {
        GateMessage: { create: value => value, encode: () => ({ finish: () => Buffer.alloc(0) }) },
    };
    class FakeTsdkRuntime {
        async init() { this.ready = true; }
        bindUser() {}
        getEncryptedInitInfo() { return 'synthetic-init'; }
        destroy() { this.ready = false; }
    }
    class FakeAceService { start() {} stop() {} }
    const module = { exports: {} };
    const apiNames = ['wxTokenDue', 'wxLayerCooling', 'refreshWxTokenSingleFlight', 'withWxCredentialContext', 'wxCredentialFlights', 'wxSessionBinding', 'wxFailureState', 'stopNetwork', 'createConn', 'accounts', 'issueWxCodeFromBuffer', 'refreshWxBufferSingleFlight', 'persistRefreshedWxBuffer', 'persistRotatedCredentialsOnError', 'keepWxCredentialAlive', 'startWxKeepalive', 'classifyWxCodeError', 'handleWxCodeFailure', 'onAccountLogin', 'reconnect', 'handleWorkerFrame', 'withTimeout', 'WX_KEEPALIVE_INTERVAL_MS', 'WX_KEEPALIVE_MIN_AGE_MS', 'handleMessage', 'decodeLoginReply', 'sendLogin', 'connect', 'connectWxSingleFlight', 'armWxReconnectAt', 'sendMsg'];
    const context = vm.createContext({
        module, exports: module.exports, Buffer, Error, AbortController, Date: time.Date,
        process: { env: { FARM_LOGIN_PROFILE: 'legacy', ...env }, pid: 123 },
        setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
        setInterval: time.setInterval, clearInterval: time.clearInterval,
        require(name) {
            if (name === 'node:crypto') return fakeCrypto;
            if (name === 'fs') return storage;
            if (name === 'path') return path.posix;
            if (name === 'net') return { createServer() { throw new Error('禁止建立端口'); } };
            if (name === 'ws') return FakeWebSocket;
            if (name === '../config/config') return { CONFIG: { tsdkAceEnabled: true, serverUrl: 'synthetic-game' } };
            if (name === '../utils/utils') return { toNum: value => Number(value || 0), toLong: value => value, log: (...args) => logs.push(args.join(' ')), logWarn: (...args) => logs.push(args.join(' ')) };
            if (name === '../utils/gateway-health') return utils.health;
            if (name === '../utils/request-priority') return utils.priority;
            if (name === '../utils/proto') return { types };
            if (name === '../utils/crypto-wasm') return { setRuntime() {}, encryptBuffer: async value => value };
            if (name === '../config/runtime-paths') return { getDataDir: () => '/fake' };
            if (name === '../models/store') return store;
            if (name === './gateway-routing') return { readGatewayDelegation: () => delegation };
            if (name === '../services/wx-login/service') return { WxLoginService: Service };
            if (name === '../services/wx-login/credential-storage') return storageApi;
            if (name === '../services/wx-login/native-protocol') return nativeApi;
            if (name === '../utils/tsdk-runtime') return { TsdkRuntime: FakeTsdkRuntime };
            if (name === '../services/ace-service') return { AceService: FakeAceService };
            if (name === '../utils/gateway-token') return { createGatewayToken: () => 'synthetic-gateway-token' };
            if (name === '../services/account-maintenance-hold') return { isAccountMaintenanceHeld: () => false };
            if (name === '../services/player-login-protocol') return require('../src/services/player-login-protocol');
            throw new Error(`禁止真实 require: ${name}`);
        },
    });
    vm.runInContext(`${gatewaySource}\n;globalThis.api = { ${apiNames.join(', ')} };`, context, { filename: 'gateway-process.js' });
    const account = context.api.createConn('2'); account.platform = 'wx'; account.savedCode = 'saved-old';
    account.wxCredentialGeneration = initial.credentialGeneration || '';
    context.api.accounts.set('2', account);
    const sock = { write(text) { frames.push(JSON.parse(text)); } };
    return { api: context.api, context, storage, storageApi, logs, frames, account, sock, time, storeAccounts, wsSockets, types };
}

test('官方player登录先验证新Reply并确认HOME，之前不发布gid或loggedin', async () => {
    const protobuf = require('protobufjs');
    const root = new protobuf.Root();
    root.loadSync(path.join(__dirname, '../src/proto/player-login.proto'), { keepCase: true });
    root.loadSync(path.join(__dirname, '../src/proto/globalscenepb.proto'), { keepCase: true });
    for (const failure of [null, 'remote', 'gid', 'home', 'epoch']) {
        const h = loadGateway({ env: { FARM_LOGIN_PROFILE: failure === null ? '' : 'player' } });
        for (const [name, full] of Object.entries({
            PlayerLoginRequest: 'gamepb.userpb.PlayerLoginRequest', PlayerLoginReply: 'gamepb.userpb.PlayerLoginReply',
            PlayerSceneLoginRequest: 'gamepb.globalscenepb.PlayerSceneLoginRequest', PlayerSceneLoginReply: 'gamepb.globalscenepb.PlayerSceneLoginReply',
        })) h.types[name] = root.lookupType(full);
        h.account.ws = { OPEN: 1, readyState: 1 };
        h.account.userState.gid = 0;
        const methods = [];
        let homeCallback, published = 0;
        h.context.__sendPlayerTest = async (_account, service, method, bytes, callback) => {
            methods.push(method);
            if (method === 'PlayerLogin') {
                assert.equal(service, 'gamepb.userpb.UserService');
                const request = h.types.PlayerLoginRequest.decode(bytes);
                assert.equal(request.game_scene_id, 1);
                assert.equal(request.device_info.client_version, '1.17.0.6_20261117');
                if (failure === 'remote') { callback.reject(new Error('server refused')); return; }
                callback.resolve({ body: h.types.PlayerLoginReply.encode({ basic: { gid: failure === 'gid' ? 0 : 321, name: 'fixture' },
                    version_info: {}, global_scene_id: 2, unlocked_scene_ids: [1, 2] }).finish() });
            } else {
                assert.equal(method, 'PlayerSceneLogin');
                assert.equal(callback.loginScene, true);
                assert.equal(h.types.PlayerSceneLoginRequest.decode(bytes).global_scene_id, 1);
                homeCallback = callback;
            }
        };
        vm.runInContext("CONFIG.clientVersion='1.17.0.6_20261117'; sendMsg=__sendPlayerTest;", h.context);
        assert.equal(vm.runInContext("requestKind('gamepb.userpb.UserService','PlayerLogin')", h.context), 'login');
        const pending = h.api.sendLogin(h.account, () => { published++; });
        // Attach rejection handler immediately, before draining microtasks.
        const settled = pending.then(() => ({ ok: true }), error => ({ error }));
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(h.account.userState.gid, 0);
        assert.equal(published, 0);
        if (homeCallback) {
            if (failure === 'epoch') h.account.connectionEpoch++;
            homeCallback.resolve({ body: h.types.PlayerSceneLoginReply.encode({ global_scene_id: failure === 'home' ? 2 : 1 }).finish() });
        }
        const result = await settled;
        if (failure) {
            assert.ok(result.error, failure);
            assert.equal(published, 0);
            assert.equal(h.account.userState.gid, 0);
        } else {
            assert.equal(result.ok, true);
            assert.equal(published, 1);
            assert.equal(h.account.userState.gid, 321);
            assert.equal(h.account.loginProfile, 'player');
            assert.deepEqual([...h.account.unlockedSceneIds], [1, 2]);
        }
        assert.equal(methods.filter(method => method === 'PlayerLogin').length, 1);
        assert.equal(methods.includes('Login'), false, 'player失败不可回退legacy');
    }
});

function successfulService(counter = { calls: 0 }, time = clock()) {
    const native = loadNative(time);
    return class {
        hasNativeSession(rec, binding) { return native.hasNativeSession(rec, binding); }
        async refreshCredentials(session, options) {
            counter.calls++;
            const rotated = { refreshtoken: 'refresh-new', accesstoken: 'access-new', tokenCheckedAt: time.Date.now(), accessTokenExpiresAt: null };
            await options.onCredentialsRotated(rotated);
            return rotated;
        }
        async refreshBufferWithAccessToken(session) {
            counter.buffers = (counter.buffers || 0) + 1;
            return { loginBuffer: 'buffer-new', refreshtoken: session.refreshtoken, accesstoken: session.accesstoken };
        }
        async issueCode() { counter.codes = (counter.codes || 0) + 1; return 'code-fake'; }
    };
}

test('unknown expiry age89相位：2min仅本地检查，age91才token-only续期', async () => {
    const counter = { calls: 0 }; const time = clock();
    const h = loadGateway({ Service: successfulService(counter, time), time });
    time.setNow(89 * MINUTE + 1);
    h.api.startWxKeepalive(); await time.flush();
    assert.equal(counter.calls, 0);
    assert.equal(h.api.WX_KEEPALIVE_INTERVAL_MS, 2 * MINUTE);
    assert.equal(h.api.WX_KEEPALIVE_MIN_AGE_MS, 90 * MINUTE);
    await time.advance(2 * MINUTE); assert.equal(counter.calls, 1);
    await time.advance(88 * MINUTE); assert.equal(counter.calls, 1);
    assert.equal(counter.buffers || 0, 0); assert.equal(counter.codes || 0, 0);
    assert.equal(h.wsSockets.length, 0); assert.equal(saved(h).loginBuffer, 'buffer-old');
});

test('重连换码与保活同file串行，token单飞等真实收尾且不吞游戏timer', async () => {
    const time = clock(); const gate = deferred(); const counter = { calls: 0 }; let issues = 0;
    class Service extends successfulService(counter, time) {
        async refreshCredentials(session, options) { const value = await super.refreshCredentials(session, options); await gate.promise; return value; }
        async issueCode() {
            assert.equal(counter.calls, 1); assert.equal(saved(h).refreshtoken, 'refresh-new');
            issues++;
            if (issues === 1) throw Object.assign(new Error('明确票据拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
            return 'code-fake';
        }
    }
    const h = loadGateway({ Service, time });
    const timer = time.setTimeout(() => {}, 5 * MINUTE); h.account.reconnectTimer = timer;
    const keep = h.api.keepWxCredentialAlive('2');
    const keepAgain = h.api.keepWxCredentialAlive('2');
    const issue = h.api.issueWxCodeFromBuffer(h.account);
    await time.flush(); assert.equal(counter.calls, 1); assert.equal(issues, 0);
    assert.ok(h.storage.locks.has(`${h.storage.file}.operation-lock`));
    gate.resolve(); await Promise.all([keep, keepAgain]); assert.equal(await issue, 'code-fake');
    assert.equal(counter.calls, 1); assert.equal(counter.buffers, 1); assert.equal(issues, 2);
    assert.equal(h.account.reconnectTimer, timer); assert.ok(time.timers.has(timer));
    assert.equal(h.storage.locks.size, 0); assert.equal(h.api.wxCredentialFlights.size, 0);
});

test('3次旧code connect尊重持久化token冷却，不stop/需扫码/游戏连接，清account冷却不绕盘', async () => {
    const time = clock(); let calls = 0;
    const native = { ...loadNative(time), async getNativeWxLoginCode() {
        throw Object.assign(new Error('明确票据拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
    } };
    const Service = loadService(time, async () => { calls++; return response({ code: 40188, msg: 'invalid scope' }); }, native);
    const h = loadGateway({ Service, time }); h.account.wxNeedsRefresh = true;
    for (let i = 0; i < 3; i++) await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: `incoming-${i}` });
    assert.equal(calls, 1); assert.equal(h.account.networkStopped, false);
    assert.equal(h.account.wxCodeFailCount, 0); assert.equal(h.account.wxTempFailCount, 0, '层错误已经给出冷却，不重复账号计数');
    assert.equal(saved(h).tokenError.code, 40188); assert.equal(saved(h).tokenFailureCount, 1);
    h.account.wxRetryAfter = 0;
    assert.equal(await h.api.reconnect(h.account), false); assert.equal(calls, 1);
    assert.equal(h.account.wxLastCodeError.stage, 'token_cooldown');
    for (let i = 0; i < 10; i++) h.api.handleWxCodeFailure(h.account, new Error('timeout'));
    assert.equal(h.account.wxTempFailCount, 10);
    assert.equal(h.account.wxRetryAfter - time.Date.now(), 12 * 60 * MINUTE);
    assert.equal(h.wsSockets.length, 0); assert.equal(h.account.networkStopped, false);
    assert.ok(!h.frames.some(f => f.payload?.needRescan));
});

test('同 code connect 和 reconnect 必须尊重冷却，不重复授权', async () => {
    const h = loadGateway();
    h.account.wxRetryAfter = h.time.Date.now() + MINUTE;
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: h.account.savedCode });
    assert.equal(await h.api.reconnect(h.account), false);
});

test('本地凭据缺失才报告需扫码，精确 wxid 不得借用 latest/openId', async () => {
    const h = loadGateway();
    h.storeAccounts[0].wxid = 'missing-wx'; h.storeAccounts[0].openId = 'wx-test';
    h.account.userState.openId = 'wx-test';
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    h.api.handleWxCodeFailure(h.account, h.account.wxLastCodeError);
    assert.equal(h.account.networkStopped, true);
    h.account.workerSock = h.sock;
    h.account.wxBufferAlerted = false;
    h.api.handleWxCodeFailure(h.account, h.account.wxLastCodeError);
    assert.ok(h.frames.some(f => f.payload && f.payload.needRescan));
});

test('保活仅清token层，不清game/account错误或buffer/code冷却；真实登录才清account', async () => {
    const time = clock(); const counter = { calls: 0 };
    const initial = { ...record(), bufferRetryAfter: time.Date.now() + MINUTE, codeRetryAfter: time.Date.now() + MINUTE, bufferFailureCount: 3, codeFailureCount: 2 };
    const h = loadGateway({ Service: successfulService(counter, time), initial, time });
    const error = new Error('游戏故障');
    Object.assign(h.account, { wxTempFailCount: 4, wxRetryAfter: time.Date.now() + MINUTE, wxLastCodeError: error, codeInvalidCount: 2, deadReconnectCount: 2 });
    await h.api.keepWxCredentialAlive('2');
    assert.equal(counter.calls, 1); assert.equal(counter.buffers || 0, 0); assert.equal(counter.codes || 0, 0);
    assert.equal(h.account.wxTempFailCount, 4); assert.equal(h.account.wxLastCodeError, error);
    assert.equal(h.account.wxRetryAfter, initial.bufferRetryAfter); assert.equal(h.account.codeInvalidCount, 2); assert.equal(h.account.deadReconnectCount, 2);
    assert.equal(saved(h).bufferRetryAfter, initial.bufferRetryAfter); assert.equal(saved(h).codeRetryAfter, initial.codeRetryAfter);
    vm.runInContext('startHeartbeat = () => {}; startAceService = () => {};', h.context);
    h.api.onAccountLogin(h.account);
    assert.equal(h.account.wxTempFailCount, 0); assert.equal(h.account.wxRetryAfter, 0);
    assert.equal(saved(h).codeRetryAfter, initial.codeRetryAfter, '游戏成功也不擦独立磁盘层冷却');
});

test('换码成功但尚未收到游戏登录回复，connect/reconnect不能清除故障计数', async () => {
    const h = loadGateway({ Service: successfulService() });
    vm.runInContext('connect = () => {};', h.context);
    h.account.wxTempFailCount = 4;
    assert.equal(await h.api.reconnect(h.account), true);
    assert.equal(h.account.wxTempFailCount, 4);
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'incoming-new' });
    assert.equal(h.account.wxTempFailCount, 4);
});

test('在途换码收到stop后不能复活连接或改savedCode', async () => {
    let finish;
    const wait = new Promise(resolve => { finish = resolve; });
    class Service extends successfulService() {
        async issueCode() { await wait; return 'synthetic-fresh'; }
    }
    const h = loadGateway({ Service });
    vm.runInContext('connect = () => { throw new Error("停止后不得建连"); };', h.context);
    const pending = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    await h.time.flush();
    await h.api.handleWorkerFrame(h.sock, { t: 'stop', accountId: '2' });
    finish();
    await pending;
    assert.equal(h.account.networkStopped, true);
    assert.equal(h.account.savedCode, 'saved-old');
});

test('凭据跨进程写锁已被占用时不能覆盖文件，扫码结束后旧快照必须拒写', () => {
    const h = loadGateway();
    const original = record();
    const lock = `${h.storage.file}.write-lock`;
    h.storage.mkdirSync(lock, { mode: 0o700 });
    assert.throws(() => h.api.persistRefreshedWxBuffer(h.storage.file, original, { loginBuffer: 'unused' }), error => error.stage === 'credential_conflict');
    assert.deepEqual(JSON.parse(h.storage.files.get(h.storage.file)), original);
    h.storage.rmdirSync(lock);
    h.storage.files.set(h.storage.file, JSON.stringify({ ...original, loginBuffer: 'new-scan' }));
    assert.throws(() => h.api.persistRefreshedWxBuffer(h.storage.file, original, { loginBuffer: 'old-response' }), error => error.stage === 'credential_conflict');
});

test('整体30s超时取消第二个HTTP，token步骤1已持久化、不留孤儿fetch或timer', async () => {
    const time = clock(); let calls = 0; let aborted = 0; let h;
    const Service = loadService(time, async (url, init) => {
        calls++;
        if (calls === 1) return tokenResponse();
        assert.equal(JSON.parse(h.storage.files.get(h.storage.file)).refreshtoken, 'refresh-new');
        return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true });
        });
    });
    h = loadGateway({ Service, time });
    const pending = h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), new Service(), { deadline: time.Date.now() + 30000 });
    const rejected = assert.rejects(pending, error => error.stage === 'login_buffer' && error.code === undefined && error.serverCode === undefined);
    await time.flush(); assert.equal(calls, 2);
    await time.advance(30000); await rejected;
    assert.equal(aborted, 1);
    const saved = JSON.parse(h.storage.files.get(h.storage.file));
    assert.equal(saved.refreshtoken, 'refresh-new'); assert.equal(saved.loginBuffer, 'buffer-old');
    assert.equal(saved.bufferError.stage, 'login_buffer');
    assert.equal(saved.bufferError.serverCode, null, '不能把步骤1 code=0 冒充步骤2错误码');
    assert.equal(time.timers.size, 0); assert.equal(h.storage.locks.size, 0);
});

test('service 第2步40188仅保留实际收到的阶段和错误码，旧调用兼容', async () => {
    const time = clock(); let calls = 0;
    const Service = loadService(time, async () => ++calls === 1 ? tokenResponse() : response({ code: -101, msg: 'GetLoginBuffer error [40188] invalid scope' }));
    let rotated;
    await assert.rejects(new Service().refreshLoginBuffer(record(), value => { rotated = value; }), error => {
        assert.equal(error.stage, 'login_buffer'); assert.equal(error.code, -101);
        assert.equal(error.refreshtoken, 'refresh-new'); return true;
    });
    assert.equal(rotated.refreshtoken, 'refresh-new'); assert.equal(time.timers.size, 0);
    calls = 0;
    const LegacyService = loadService(time, async () => ++calls === 1 ? tokenResponse() : bufferResponse());
    assert.equal((await new LegacyService().refreshLoginBuffer(record())).loginBuffer, 'buffer-new');
});

test('service 外部取消会终止fetch并清理timer，不伪造服务器错误码', async () => {
    const time = clock(); let aborted = 0;
    const Service = loadService(time, async (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true });
    }));
    const controller = new AbortController();
    const pending = new Service().refreshLoginBuffer(record(), { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.stage === 'token_refresh' && error.code === undefined);
    controller.abort(new Error('用户取消模拟'));
    await rejected; assert.equal(aborted, 1); assert.equal(time.timers.size, 0);
});

test('写临时文件期间扫码更新及扫码后旧快照写入均不得覆盖新凭据', async () => {
    const h = loadGateway();
    const scan = { ...record(), loginBuffer: 'buffer-scan', refreshtoken: 'refresh-scan', updatedAt: h.time.Date.now() };
    h.storage.beforeRenameCheck = () => h.storage.files.set(h.storage.file, JSON.stringify(scan));
    assert.throws(() => h.api.persistRefreshedWxBuffer(h.storage.file, record(), { loginBuffer: 'buffer-stale' }), /并发更新/);
    assert.deepEqual(JSON.parse(h.storage.files.get(h.storage.file)), scan);
    assert.throws(() => h.api.persistRotatedCredentialsOnError(h.storage.file, record(), { refreshtoken: 'refresh-stale' }), /并发更新/);
    assert.equal(h.storage.files.size, 1, '本次临时文件已清理');
});

test('按需buffer进行中扫码：最终旧buffer不可覆盖新generation，CAS冲突必须传出', async () => {
    const time = clock(); let calls = 0; let release;
    const Service = loadService(time, async () => ++calls === 1 ? tokenResponse() : new Promise(resolve => { release = () => resolve(bufferResponse()); }));
    const h = loadGateway({ Service, time });
    const pending = h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), new Service());
    const rejected = assert.rejects(pending, error => error.stage === 'credential_conflict');
    await time.flush(); assert.equal(calls, 2);
    const scan = { ...record(), credentialGeneration: 'generation-scan', loginBuffer: 'buffer-scan', refreshtoken: 'refresh-scan', updatedAt: time.Date.now() };
    h.storage.files.set(h.storage.file, JSON.stringify(scan));
    release(); await rejected;
    assert.deepEqual(saved(h), scan); assert.equal(h.storage.locks.size, 0);
    assert.ok(!h.logs.some(s => s.includes('续期并落盘成功')));
});

test('token writer失败必须拒绝且不进入buffer，不报成功、不吞ENOSPC', async () => {
    const time = clock(); let calls = 0; let h;
    const Service = loadService(time, async () => { calls++; h.storage.failWrite = true; return tokenResponse(); });
    h = loadGateway({ Service, time });
    await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), new Service()), error => error.stage === 'persist_rotated' && /ENOSPC/.test(error.message));
    assert.equal(calls, 1); assert.deepEqual(saved(h), record());
    assert.equal(h.account.networkStopped, false); assert.equal(time.timers.size, 0);
    assert.equal(h.storage.files.size, 1); assert.equal(h.storage.locks.size, 0);
    assert.throws(() => h.api.persistRefreshedWxBuffer(h.storage.file, record(), { loginBuffer: 'new' }), /ENOSPC/);
});

test('步骤2最终buffer写失败：保留步骤1token，但不可报保活成功', async () => {
    const time = clock(); let calls = 0; let h;
    const Service = loadService(time, async () => {
        if (++calls === 1) return tokenResponse();
        h.storage.failWrite = true;
        return bufferResponse();
    });
    h = loadGateway({ Service, time });
    await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), new Service()), /ENOSPC/);
    assert.equal(calls, 2); assert.equal(saved(h).refreshtoken, 'refresh-new');
    assert.equal(saved(h).loginBuffer, 'buffer-old'); assert.equal(h.storage.locks.size, 0);
    assert.ok(!h.logs.some(s => s.includes('续期并落盘成功')));
});

test('凭据保活不取消合法重连，QQ真实登录撤销陈旧游戏重连', async () => {
    const h = loadGateway({ Service: successfulService() });
    const reconnectTimer = h.time.setTimeout(() => {}, MINUTE);
    h.account.reconnectTimer = reconnectTimer;
    await h.api.keepWxCredentialAlive('2');
    assert.equal(h.account.reconnectTimer, reconnectTimer);
    assert.ok(h.time.timers.has(reconnectTimer));
    h.account.platform = 'qq';
    vm.runInContext('startHeartbeat = () => {}; startAceService = () => {};', h.context);
    h.api.onAccountLogin(h.account);
    assert.equal(h.account.reconnectTimer, null);
    assert.equal(h.time.timers.has(reconnectTimer), false, '真实游戏登录后不得保留旧会话重连');
});

test('旧快照发起刷新前冲突必须拒绝，服务端消息不可冒充本地凭据缺失', async () => {
    const h = loadGateway();
    const scan = { ...record(), credentialGeneration: 'generation-scan', refreshtoken: 'refresh-scan', updatedAt: h.time.Date.now() };
    h.storage.files.set(h.storage.file, JSON.stringify(scan));
    await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), {
        refreshCredentials() { throw new Error('不应发起过期请求'); },
        refreshBufferWithAccessToken() { throw new Error('不应发起过期请求'); },
    }), error => error.stage === 'credential_conflict');
    assert.equal(h.api.classifyWxCodeError({ stage: 'token_refresh', message: '服务端返回：无 refreshtoken' }).temporary, true);
});

test('service deadline 小于单HTTP超时，token响应抵达期限时仍先持久化', async () => {
    const time = clock(); let calls = 0; let rotated;
    const deadline = time.Date.now() + 1000;
    const Service = loadService(time, async () => {
        calls++;
        time.setNow(deadline);
        return tokenResponse();
    });
    await assert.rejects(new Service().refreshLoginBuffer(record(), {
        deadline,
        onCredentialsRotated(value) { rotated = value; },
    }), /超时/);
    assert.equal(rotated.refreshtoken, 'refresh-new');
    assert.equal(calls, 1);
    assert.equal(time.timers.size, 0);
});

test('token成功但缺access字段仍先持久化，错误阶段仍为实际token响应', async () => {
    const time = clock(); let saved;
    const Service = loadService(time, async () => response({ code: 0, userInfo: { refreshToken: 'refresh-new' } }));
    await assert.rejects(new Service().refreshLoginBuffer(record(), {
        onCredentialsRotated(value) { saved = value; },
    }), error => error.stage === 'token_refresh' && error.code === 'response_invalid' && error.serverCode === 0);
    assert.equal(saved.refreshtoken, 'refresh-new');
    assert.equal(time.timers.size, 0);
});

test('独立微信实例排空阶段不授权，active后只读写专属凭据', async () => {
    const state = { accountIds: ['2'], phase: 'draining' };
    const count = { calls: 0 };
    const h = loadGateway({ Service: successfulService(count), env: { FARM_WX_GATEWAY: '1', FARM_GATEWAY_SOCK: '/sock/qq-farm-wx.sock' }, delegation: state });
    await h.api.keepWxCredentialAlive('2');
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'synthetic' });
    assert.equal(count.calls, 0);
    state.phase = 'active';
    await h.api.keepWxCredentialAlive('2');
    assert.equal(count.calls, 1);
    assert.equal(h.storage.file, '/fake/wx-gateway/wx-test.json');
    assert.ok(!h.storage.files.has('/fake/wx-login/wx-test.json'));
});

test('主网关不再刷新委托微信，独立网关拒绝QQ且status不抢业务socket', async () => {
    const state = { accountIds: ['2'], phase: 'active' };
    const count = { calls: 0 };
    const main = loadGateway({ Service: successfulService(count), delegation: state });
    await main.api.keepWxCredentialAlive('2');
    assert.equal(count.calls, 0);
    const h = loadGateway({ env: { FARM_WX_GATEWAY: '1', FARM_GATEWAY_SOCK: '/sock/qq-farm-wx.sock' }, delegation: state });
    const existing = { write() { throw new Error('不得改写业务socket'); } };
    h.account.workerSock = existing;
    await h.api.handleWorkerFrame(h.sock, { t: 'status', accountId: '2' });
    assert.equal(h.account.workerSock, existing);
    assert.ok(h.frames.some(f => f.t === 'status' && f.state.credentialDirectory === 'wx-gateway'));
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '1', code: 'unused' });
    assert.ok(!h.api.accounts.has('1'));
});

test('token成功而buffer40188后，冷却到期仅重试第二步；统一updatedAt不能掩盖失败', async () => {
    const time = clock(); let tokenCalls = 0; let bufferCalls = 0;
    const Service = loadService(time, async url => {
        if (url.includes('refresh_token')) { tokenCalls++; return tokenResponse(); }
        bufferCalls++;
        return bufferCalls === 1 ? response({ code: -101, msg: '[40188] invalid scope' }) : bufferResponse();
    });
    const h = loadGateway({ Service, time });
    h.account.networkStopped = true; // 只测凭据，不允许保活擅自启动游戏。
    await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, record(), record(), new Service()), error => error.stage === 'login_buffer' && error.code === -101 && error.wechatCode === 40188);
    const failed = JSON.parse(h.storage.files.get(h.storage.file));
    assert.equal(tokenCalls, 1); assert.equal(bufferCalls, 1);
    assert.equal(failed.bufferRefreshPending, true);
    assert.equal(failed.loginBufferUpdatedAt, 1);
    assert.ok(failed.tokenCheckedAt > failed.loginBufferUpdatedAt);
    await time.advance(5 * MINUTE);
    await h.api.keepWxCredentialAlive('2'); assert.equal(bufferCalls, 1, '保活不重试buffer');
    await h.api.refreshWxBufferSingleFlight(h.storage.file, saved(h), saved(h), new Service());
    const recovered = JSON.parse(h.storage.files.get(h.storage.file));
    assert.equal(tokenCalls, 1, '不再次轮换刚检查的token');
    assert.equal(bufferCalls, 2);
    assert.equal(recovered.bufferRefreshPending, false);
    assert.equal(recovered.loginBuffer, 'buffer-new');
    assert.equal(h.account.networkStopped, true, '保活不能启动已停止账号');
});

test('保活延长冷却不会吞掉唯一游戏重连timer', async () => {
    let calls = 0;
    class Service extends successfulService() { async issueCode() { calls++; throw new Error('network'); } }
    const h = loadGateway({ Service });
    h.api.handleWxCodeFailure(h.account, new Error('network'));
    await h.time.advance(4 * MINUTE);
    h.api.handleWxCodeFailure(h.account, new Error('network'), { schedule: false });
    await h.time.advance(MINUTE);
    assert.equal(calls, 0);
    assert.ok(h.account.reconnectTimer, '旧timer提前触发后必须重新排冷却截止');
    await h.time.advance(9 * MINUTE);
    assert.equal(calls, 1, '冷却期满恢复一次换码');
});

test('并发connect/reconnect共享一次native换码和一条CONNECTING游戏连接', async () => {
    let release; let issued = 0;
    class Service extends successfulService() { async issueCode() { issued++; return await new Promise(resolve => { release = resolve; }); } }
    const h = loadGateway({ Service });
    vm.runInContext('startHeartbeat = () => {}; startAceService = () => {};', h.context);
    const a = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'disk-old' });
    const b = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'disk-other' });
    const c = h.api.reconnect(h.account);
    await h.time.flush(); assert.equal(issued, 1);
    release('synthetic-code'); await h.time.flush();
    assert.equal(h.wsSockets.length, 1);
    h.api.connect(h.account, 'same-code');
    assert.equal(h.wsSockets.length, 1, 'CONNECTING阶段不能重复创建WebSocket');
    h.account.ws.readyState = 1; h.account.userState.gid = 42;
    h.api.onAccountLogin(h.account);
    await Promise.all([a, b, c]);
    assert.equal(issued, 1); assert.equal(h.wsSockets.length, 1);
});

test('服务端登录错误码/坏回复/空gid不得返login，不能借用残留gid', async () => {
    for (const kind of ['error_code', 'decode', 'empty']) {
        const h = loadGateway(); h.account.workerSock = h.sock; h.account.userState.gid = 99;
        h.api.connect(h.account, 'synthetic-login-code'); h.account.ws.readyState = 1;
        let rejected; let success = false;
        await h.api.sendMsg(h.account, 'gamepb.userpb.UserService', 'Login', Buffer.alloc(0), {
            isLogin: true, reject(error) { rejected = error; }, onLoginSuccess() { success = true; },
        });
        assert.equal(h.account.operations.size, 1);
        assert.equal(h.account.pendingCallbacks.get(1).operation.sent, true);
        h.types.GateMessage = { decode: () => ({ meta: { message_type: 2, client_seq: 1, error_code: kind === 'error_code' ? 123 : 0 }, body: Buffer.alloc(0) }) };
        h.types.LoginReply = { decode() { if (kind === 'decode') throw new Error('broken'); return {}; } };
        h.api.handleMessage(h.account, Buffer.alloc(0));
        assert.ok(rejected, kind); assert.equal(success, false); assert.equal(h.account.userState.gid, 0);
        assert.ok(!h.frames.some(f => f.t === 'login'));
    }
});

test('业务错误码通过response传回worker，不被当成成功数据', async () => {
    const h = loadGateway();
    const knownState = { ...h.account };
    h.storeAccounts[0].platform = 'qq';
    vm.runInContext('globalThis.fixtureConnect = connect; globalThis.fixtureConnectCodes = []; connect = (account, code) => { fixtureConnectCodes.push(code); return false; };', h.context);
    try {
        await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
        assert.deepEqual(Array.from(h.context.fixtureConnectCodes), ['saved-old']);
        assert.equal(h.wsSockets.length, 0, '绑定初始化不得接游戏服务器');
    } finally {
        vm.runInContext('connect = fixtureConnect;', h.context);
        h.storeAccounts[0].platform = 'wx';
        const { workerSock, workerSession, workerSocketSerial } = h.account;
        Object.assign(h.account, knownState, { workerSock, workerSession, workerSocketSerial });
    }
    assert.equal(h.account.workerSock, h.sock);
    assert.equal(h.account.workerSession, 1);
    h.api.connect(h.account, 'synthetic-request-code'); h.account.ws.readyState = 1;
    h.account.clientSeq = 6;
    await h.api.handleWorkerFrame(h.sock, { t: 'request', accountId: '2', seq: 88,
        service: 'gamepb.itempb.ItemService', method: 'Bag', body: '', connectionEpoch: h.account.connectionEpoch });
    assert.equal(h.account.pendingCallbacks.get(7).operation.sent, true);
    assert.equal(h.frames[0].t, 'request_sent');
    h.frames.length = 0;
    h.types.GateMessage = { decode: () => ({ meta: { message_type: 2, client_seq: 7, error_code: 1000020 }, body: Buffer.alloc(0) }) };
    h.api.handleMessage(h.account, Buffer.alloc(0));
    assert.equal(h.frames[0].seq, 88); assert.match(h.frames[0].error, /1000020/);
    assert.equal(h.frames[0].body, '');
});

test('登录不回包有界超时，pending和timer全部清理', async () => {
    const h = loadGateway();
    h.api.connect(h.account, 'synthetic-login-code'); h.account.ws.readyState = 1;
    h.types.LoginRequest = { create: x => x, encode: () => ({ finish: () => Buffer.alloc(0) }) };
    const waiting = h.api.sendLogin(h.account, () => { throw new Error('不该成功'); });
    const rejected = assert.rejects(waiting, error => {
        assert.equal(error.code, 'REQUEST_TIMEOUT');
        assert.match(error.message, /网关请求超时/);
        assert.equal(error.sent, true);
        return true;
    });
    await h.time.flush();
    assert.equal(h.account.criticalFlights.has('login'), true);
    assert.equal(h.account.pendingCallbacks.size, 1);
    await h.time.advance(30000); await rejected;
    assert.equal(h.account.operations.size, 0); assert.equal(h.account.criticalFlights.size, 0);
    assert.equal(h.account.pendingCallbacks.size, 0); assert.equal(h.time.timers.size, 0);
});

test('共享网关冷启动后的QQ resume不带code仍从同账号落盘取码', async () => {
    const h = loadGateway(); h.account.platform = 'qq'; h.account.savedCode = null;
    h.storeAccounts[0].platform = 'qq'; h.storeAccounts[0].code = 'persisted-qq-code';
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    assert.equal(h.account.savedCode, 'persisted-qq-code'); assert.equal(h.wsSockets.length, 1);
});

test('wxTokenDue真实expires提前4min；unknown只看checked/scanned/buffer时间不看updatedAt', () => {
    const h = loadGateway(); const now = h.time.Date.now();
    assert.equal(h.api.wxTokenDue({ ...record(), accessTokenExpiresAt: now + 4 * MINUTE + 1 }), false);
    assert.equal(h.api.wxTokenDue({ ...record(), accessTokenExpiresAt: now + 4 * MINUTE }), true);
    assert.equal(h.api.wxTokenDue({ ...record(), tokenCheckedAt: now, accessTokenExpiresAt: now - 1 }), true);
    assert.equal(h.api.wxTokenDue({ ...record(), tokenCheckedAt: now - 90 * MINUTE + 1, updatedAt: 1 }), false);
    assert.equal(h.api.wxTokenDue({ ...record(), tokenCheckedAt: now - 90 * MINUTE, updatedAt: now }), true);
    assert.equal(h.api.wxTokenDue({ scannedAt: now - MINUTE, updatedAt: 1 }), false);
    assert.equal(h.api.wxTokenDue({ loginBufferUpdatedAt: now - MINUTE, updatedAt: 1 }), false);
    assert.equal(h.api.wxTokenDue({ updatedAt: now }), true);
});

test('service真实expiresIn落盘驱动4min提前续期，buffer/code/account冷却互不影响token', async () => {
    const time = clock(); let calls = 0;
    const Service = loadService(time, async url => {
        assert.ok(url.includes('refresh_token')); calls++;
        return response({ code: 0, userInfo: { accessToken: `access-${calls}`, refreshToken: `refresh-${calls}`, expiresIn: 600 } });
    });
    const h = loadGateway({ Service, time, initial: { ...record(), bufferRetryAfter: time.Date.now() + 60 * MINUTE, codeRetryAfter: time.Date.now() + 60 * MINUTE } });
    h.account.wxRetryAfter = time.Date.now() + 60 * MINUTE;
    await h.api.keepWxCredentialAlive('2'); assert.equal(calls, 1);
    assert.equal(saved(h).accessTokenExpiresAt, time.Date.now() + 10 * MINUTE);
    await time.advance(6 * MINUTE - 1); await h.api.keepWxCredentialAlive('2'); assert.equal(calls, 1);
    await time.advance(1); await h.api.keepWxCredentialAlive('2'); assert.equal(calls, 2);
    assert.equal(saved(h).loginBuffer, 'buffer-old'); assert.equal(h.wsSockets.length, 0);
});

for (const layer of ['token', 'buffer', 'code']) {
    test(`${layer}独立冷却/错误落盘，重启清account不能绕过，期满只重试本层`, async () => {
        const time = clock(); const counter = { calls: 0 }; let failing = true;
        const error = Object.assign(new Error('synthetic-layer-error'), {
            stage: layer === 'token' ? 'token_refresh' : layer === 'buffer' ? 'login_buffer' : 'js_login',
            code: -101, serverCode: -101, wechatCode: 40188,
        });
        class Service extends successfulService(counter, time) {
            async refreshCredentials(session, options) { if (layer === 'token' && failing) { counter.calls++; throw error; } return super.refreshCredentials(session, options); }
            async refreshBufferWithAccessToken(session) { if (layer === 'buffer' && failing) { counter.buffers = (counter.buffers || 0) + 1; throw error; } return super.refreshBufferWithAccessToken(session); }
            async issueCode() { if (layer === 'code' && failing) { counter.codes = (counter.codes || 0) + 1; throw error; } return super.issueCode(); }
        }
        const initial = { ...record(), tokenCheckedAt: layer === 'token' ? 1 : time.Date.now() };
        const h = loadGateway({ Service, time, initial });
        const invoke = async target => {
            if (layer === 'token') return target.api.keepWxCredentialAlive('2');
            if (layer === 'code') return target.api.issueWxCodeFromBuffer(target.account);
            return target.api.refreshWxBufferSingleFlight(target.storage.file, saved(target), saved(target), new Service());
        };
        if (layer === 'buffer') await assert.rejects(invoke(h), error); else await invoke(h);
        const failed = saved(h); const at = time.Date.now();
        assert.equal(failed[`${layer}RetryAfter`], at + 5 * MINUTE);
        assert.equal(failed[`${layer}FailureCount`], 1);
        assert.equal(failed[`${layer}Error`].stage, error.stage);
        assert.equal(failed[`${layer}Error`].serverCode, -101);
        for (const other of ['token', 'buffer', 'code'].filter(value => value !== layer)) assert.equal(failed[`${other}RetryAfter`], undefined);
        const restarted = loadGateway({ Service, time, initial: failed, storage: h.storage });
        if (layer === 'buffer') await assert.rejects(invoke(restarted), value => value.stage === 'buffer_cooldown'); else await invoke(restarted);
        assert.equal(counter[layer === 'token' ? 'calls' : layer === 'buffer' ? 'buffers' : 'codes'], 1);
        failing = false; await time.advance(5 * MINUTE); await invoke(restarted);
        assert.equal(counter[layer === 'token' ? 'calls' : layer === 'buffer' ? 'buffers' : 'codes'], 2);
        assert.equal(saved(restarted)[`${layer}RetryAfter`], 0);
        assert.equal(saved(restarted)[`${layer}FailureCount`], 0);
        assert.equal(h.storage.locks.size, 0);
    });
}

for (const due of [false, true]) {
    test(`明确ManualAuth -10仅单次buffer恢复，token ${due ? 'due才轮换' : '未due不轮换'}`, async () => {
        const time = clock(); const calls = []; let h;
        const native = { ...loadNative(time), async getNativeWxLoginCode(buffer, appId, options) {
            calls.push('native');
            if (calls.filter(value => value === 'native').length === 1) throw Object.assign(new Error('明确拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
            assert.equal(buffer, 'buffer-new'); assert.equal(options.session, null);
            throw Object.assign(new Error('再次明确拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
        } };
        const Service = loadService(time, async url => {
            if (url.includes('refresh_token')) { calls.push('token'); return tokenResponse(); }
            calls.push('buffer'); assert.equal(saved(h).refreshtoken, due ? 'refresh-new' : 'refresh-old'); return bufferResponse();
        }, native);
        h = loadGateway({ Service, time, initial: { ...record(), tokenCheckedAt: due ? 1 : time.Date.now() } });
        assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
        assert.deepEqual(calls, due ? ['native', 'token', 'buffer', 'native'] : ['native', 'buffer', 'native']);
        assert.equal(saved(h).codeFailureCount, 1); assert.equal(h.account.networkStopped, false);
    });
}

for (const failure of [
    { code: 'WX_NATIVE_SESSION_INVALID', stage: 'native_session' },
    { code: 'WX_NATIVE_SESSION_EXPIRED', stage: 'native_session' },
    { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -11, stage: 'manual_auth' },
    { serverCode: -10, stage: 'manual_auth' },
    { code: 1006, stage: 'js_login' },
    { code: 'TimeoutError', stage: 'js_login' },
]) {
    test(`unknown native ${failure.code || '无typed码'} / ${failure.serverCode || ''}不能推断token或buffer需refresh`, async () => {
        const time = clock(); let issued = 0;
        const Service = loadService(time, async () => { throw new Error('禁止任何HTTP授权'); }, {
            ...loadNative(time), async getNativeWxLoginCode() { issued++; throw Object.assign(new Error('synthetic-native-failure'), failure); },
        });
        const h = loadGateway({ Service, time });
        assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
        assert.equal(issued, 1); assert.equal(saved(h).refreshtoken, 'refresh-old');
        assert.equal(saved(h).bufferFailureCount, undefined); assert.equal(saved(h).tokenFailureCount, undefined);
        assert.equal(saved(h).codeFailureCount, 1); assert.equal(h.wsSockets.length, 0);
    });
}

test('token成功-buffer40188完整链：native先持久化，cached无buffer跨重启换码并真实LoginReply，token仍独立可续', async () => {
    const time = clock(); let tokens = 0; let buffers = 0; let manual = 0; let cached = 0; let h;
    const native = { ...loadNative(time), async getNativeWxLoginCode(buffer, appId, options) {
        if (options.session) {
            cached++; assert.equal(native.hasNativeSession(options.session, options.sessionBinding), true);
            return `cached-code-${cached}`;
        }
        manual++; assert.ok(buffer);
        const rec = nativeRecord(time, options.sessionBinding);
        await options.onSession(rec);
        assert.deepEqual(saved(h).nativeSession, rec, '新native必须先写盘再返回code');
        return 'manual-code';
    } };
    const Service = loadService(time, async url => {
        if (url.includes('refresh_token')) { tokens++; return response({ code: 0, userInfo: { accessToken: `access-rotated-${tokens}`, refreshToken: `refresh-rotated-${tokens}`, expiresIn: 3600 } }); }
        buffers++; return response({ code: -101, msg: '拒绝 [40188] invalid scope' });
    }, native);
    h = loadGateway({ Service, time });
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'manual-code');
    const nativeBefore = saved(h).nativeSession;
    await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, saved(h), saved(h), new Service()), error => error.serverCode === -101 && error.wechatCode === 40188);
    assert.equal(tokens, 1); assert.equal(buffers, 1);
    assert.equal(saved(h).refreshtoken, 'refresh-rotated-1'); assert.deepEqual(saved(h).nativeSession, nativeBefore);
    assert.equal(saved(h).bufferRefreshPending, true); assert.equal(saved(h).loginBufferUpdatedAt, 1);
    const noBuffer = { ...saved(h), loginBuffer: '' };
    h.storageApi.writeWxCredential(h.storage.file, { loginBuffer: '' }, saved(h));
    const restarted = loadGateway({ Service, time, initial: noBuffer, storage: h.storage });
    assert.equal(await restarted.api.issueWxCodeFromBuffer(restarted.account), 'cached-code-1');
    await time.advance(56 * MINUTE); await restarted.api.keepWxCredentialAlive('2');
    assert.equal(tokens, 2); assert.equal(buffers, 1); assert.equal(manual, 1);
    assert.equal(await restarted.api.issueWxCodeFromBuffer(restarted.account), 'cached-code-2');
    assert.equal(saved(h).bufferFailureCount, 1); assert.deepEqual(saved(h).nativeSession, nativeBefore);
    assert.equal(h.wsSockets.length + restarted.wsSockets.length, 0); assert.equal(time.timers.size, 0);
    restarted.types.LoginRequest = { create: value => value, encode: () => ({ finish: () => Buffer.alloc(0) }) };
    restarted.types.GateMessage = {
        create: value => value, encode: () => ({ finish: () => Buffer.alloc(0) }),
        decode: () => ({ meta: { message_type: 2, client_seq: 1, error_code: 0 }, body: Buffer.alloc(0) }),
    };
    restarted.types.LoginReply = { decode: () => ({ basic: { gid: 42, name: 'synthetic-user', open_id: 'game-test' } }) };
    const connected = restarted.api.handleWorkerFrame(restarted.sock, { t: 'connect', accountId: '2' }); await time.flush();
    const socket = restarted.wsSockets[0]; assert.ok(socket); assert.equal(restarted.frames.some(frame => frame.t === 'login'), false);
    socket.readyState = 1; socket.emit('open'); await time.flush();
    assert.equal(restarted.account.pendingCallbacks.size, 1); assert.ok(restarted.account.tsdkRuntime.ready);
    socket.emit('message', Buffer.alloc(0)); await connected;
    assert.equal(restarted.account.userState.gid, 42); assert.equal(restarted.frames.filter(frame => frame.t === 'login').length, 1);
    assert.equal(tokens, 2); assert.equal(buffers, 1); assert.equal(manual, 1); assert.equal(cached, 3);
    restarted.api.stopNetwork(restarted.account); assert.equal(time.timers.size, 0);
});

test('cache校验调用svc.hasNativeSession；错误wxid/世代/PSK/寿命不借其他文件', async () => {
    const time = clock(); const binding = 'wx-login:wx-test:generation-old'; const valid = nativeRecord(time, binding);
    const invalids = [
        { ...valid, binding: 'wx-login:other-wx:generation-old' }, { ...valid, binding: 'wx-login:wx-test:generation-new' },
        { ...valid, psk: Buffer.alloc(31).toString('base64') }, { ...valid, expiresAt: valid.expiresAt + 1 },
        { ...valid, ticket: Buffer.from([0, 1, 2, 3, 4]).toString('base64'), expiresAt: null },
    ];
    for (const nativeSession of invalids) {
        let checks = 0; let issued = 0;
        class Service extends successfulService({}, time) {
            hasNativeSession(rec, key) { checks++; return super.hasNativeSession(rec, key); }
            async issueCode(session, app, options) { issued++; assert.equal(options.session, null); return 'fresh-manual-code'; }
        }
        const h = loadGateway({ Service, time, initial: { ...record(), nativeSession } });
        h.storage.files.set('/fake/wx-login/other-wx.json', JSON.stringify({ ...record(), openid: 'other-wx', nativeSession: valid }));
        assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'fresh-manual-code'); assert.equal(issued, 1); assert.ok(checks > 0);
        const empty = loadGateway({ Service, time, initial: { ...record(), loginBuffer: '', nativeSession } });
        assert.equal(await empty.api.issueWxCodeFromBuffer(empty.account), null);
        assert.equal(empty.account.wxLastCodeError.stage, 'local_credential_missing'); assert.equal(issued, 1);
    }
});

test('pendingCode一次CAS清value并consumedtrue后才接游戏，重启不会二次take', async () => {
    const time = clock(); const counter = { calls: 0 };
    const pendingCode = { generation: 'generation-old', value: 'scan-code', consumed: false, issuedAt: time.Date.now(), expiresAt: time.Date.now() + 60000 };
    const h = loadGateway({ Service: successfulService(counter, time), time, initial: { ...record(), pendingCode, codeRetryAfter: time.Date.now() + MINUTE } });
    const pending = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    await time.flush();
    assert.equal(h.wsSockets.length, 1); assert.equal(h.account.savedCode, 'scan-code');
    assert.equal(h.wsSockets[0].credentialAtConnect.pendingCode.value, null); assert.equal(h.wsSockets[0].credentialAtConnect.pendingCode.consumed, true);
    h.account.finishLogin(true); await pending;
    const restarted = loadGateway({ Service: successfulService(counter, time), time, initial: saved(h), storage: h.storage });
    assert.equal(await restarted.api.issueWxCodeFromBuffer(restarted.account), null);
    assert.equal(restarted.account.wxLastCodeError.stage, 'code_cooldown'); assert.equal(counter.codes || 0, 0);
    assert.equal(h.storage.writes.filter(value => value.pendingCode?.consumed).length, 1);
});

for (const kind of ['expired', 'generation', 'future', 'lifetime', 'consumed']) {
    test(`pendingCode ${kind}不take不误接游戏，正常native按层规则恢复`, async () => {
        const time = clock(); const counter = { calls: 0 }; const now = time.Date.now();
        const pendingCode = { generation: 'generation-old', value: 'forbidden-code', consumed: false, issuedAt: now, expiresAt: now + 60000 };
        if (kind === 'expired') pendingCode.expiresAt = now;
        if (kind === 'generation') pendingCode.generation = 'generation-other';
        if (kind === 'future') pendingCode.issuedAt = now + 1;
        if (kind === 'lifetime') pendingCode.expiresAt = now + 60001;
        if (kind === 'consumed') pendingCode.consumed = true;
        const h = loadGateway({ Service: successfulService(counter, time), time, initial: { ...record(), pendingCode } });
        assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'code-fake'); assert.equal(counter.codes, 1);
        assert.deepEqual(saved(h).pendingCode, pendingCode); assert.equal(h.wsSockets.length, 0);
    });
}

test('pendingCode CAS writer失败不交接游戏、不吞错误或消费原值', async () => {
    const time = clock(); const pendingCode = { generation: 'generation-old', value: 'scan-code', consumed: false, issuedAt: time.Date.now(), expiresAt: time.Date.now() + 60000 };
    const h = loadGateway({ time, initial: { ...record(), pendingCode } });
    h.storage.beforeRenameCheck = () => { throw new Error('ENOSPC 模拟CAS失败'); };
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.match(h.account.wxLastCodeError.message, /ENOSPC/); assert.deepEqual(saved(h).pendingCode, pendingCode);
    assert.equal(h.wsSockets.length, 0); assert.equal(h.storage.locks.size, 0);
});

test('新generation只清account失败，disk三层冷却保留且不重复授权', async () => {
    const time = clock(); const counter = { calls: 0 }; const now = time.Date.now();
    const initial = { ...record(), credentialGeneration: 'generation-new', tokenRetryAfter: now + MINUTE, bufferRetryAfter: now + 2 * MINUTE, codeRetryAfter: now + 3 * MINUTE };
    const h = loadGateway({ Service: successfulService(counter, time), time, initial });
    Object.assign(h.account, { wxCredentialGeneration: 'generation-old', wxTempFailCount: 4, wxRetryAfter: now + 10 * MINUTE, networkStopped: true, codeInvalidCount: 6, deadReconnectCount: 5, shortSessionCount: 3 });
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'ignored' });
    assert.equal(h.account.wxTempFailCount, 0); assert.equal(h.account.codeInvalidCount, 0);
    assert.equal(h.account.deadReconnectCount, 0); assert.equal(h.account.shortSessionCount, 0);
    assert.equal(h.account.wxLastCodeError.stage, 'code_cooldown'); assert.deepEqual(saved(h), initial);
    assert.equal(counter.codes || 0, 0); assert.equal(counter.calls, 0); assert.equal(h.wsSockets.length, 0);
});

test('stop在token响应inflight后仍保存旋转凭据，但epoch禁止旧code复活/旧冷却覆盖', async () => {
    const time = clock(); const gate = deferred(); let h; let tokens = 0;
    const Service = loadService(time, async () => { tokens++; await gate.promise; return tokenResponse(); }, {
        ...loadNative(time), async getNativeWxLoginCode() { throw Object.assign(new Error('明确拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 }); },
    });
    h = loadGateway({ Service, time }); const pending = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    await time.flush(); assert.equal(tokens, 1);
    await h.api.handleWorkerFrame(h.sock, { t: 'stop', accountId: '2' });
    const epoch = h.account.connectionEpoch; gate.resolve(); await pending;
    assert.equal(saved(h).refreshtoken, 'refresh-new'); assert.equal(h.account.connectionEpoch, epoch);
    assert.equal(h.account.savedCode, 'saved-old'); assert.equal(h.account.networkStopped, true);
    assert.equal(h.account.reconnectTimer, null); assert.equal(h.account.deadReconnectTimer, null);
    assert.equal(h.wsSockets.length, 0);
    assert.equal(h.storage.locks.size, 0); assert.equal(time.timers.size, 0);
});

test('新扫码在native inflight替换generation，旧onSession CAS不得覆盖，新pendingCode才可接游戏', async () => {
    const time = clock(); const gate = deferred(); let issued = 0;
    class Service extends successfulService({}, time) {
        async issueCode(session, app, options) {
            issued++; await gate.promise;
            await options.onSession(nativeRecord(time, options.sessionBinding));
            return 'old-native-code';
        }
    }
    const h = loadGateway({ Service, time });
    const old = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' }); await time.flush(); assert.equal(issued, 1);
    const scan = { ...record(), credentialGeneration: 'generation-new', refreshtoken: 'refresh-scan', pendingCode: { generation: 'generation-new', value: 'new-scan-code', consumed: false, issuedAt: time.Date.now(), expiresAt: time.Date.now() + 60000 } };
    h.storage.files.set(h.storage.file, JSON.stringify(scan));
    const fresh = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' }); await time.flush();
    gate.resolve(); await old; await time.flush();
    assert.equal(h.wsSockets.length, 1); assert.equal(h.account.savedCode, 'new-scan-code');
    assert.equal(saved(h).refreshtoken, 'refresh-scan'); assert.equal(saved(h).nativeSession, undefined);
    assert.equal(saved(h).pendingCode.consumed, true); assert.equal(issued, 1);
    h.account.finishLogin(true); await fresh; assert.equal(h.storage.locks.size, 0);
});

test('withWxCredentialOperation两个VM真实async互斥，cancel不提前释放，下层拒绝原样传出', async () => {
    const time = clock(); const storage = fakeFs(record()); const a = loadStorage(storage, time, 1); const b = loadStorage(storage, time, 2);
    const controller = new AbortController(); const gate = deferred(); let entered = 0;
    const first = a.withWxCredentialOperation(storage.file, record(), async current => {
        entered++; assert.deepEqual(JSON.parse(JSON.stringify(current)), record()); await gate.promise;
        if (controller.signal.aborted) throw controller.signal.reason;
    });
    const rejected = assert.rejects(first, /模拟取消/); await time.flush();
    assert.equal(entered, 1); assert.ok(storage.locks.has(`${storage.file}.operation-lock`));
    controller.abort(new Error('模拟取消'));
    await assert.rejects(b.withWxCredentialOperation(storage.file, undefined, async () => { entered++; }), error => error.stage === 'credential_conflict');
    assert.equal(entered, 1); assert.ok(storage.locks.has(`${storage.file}.operation-lock`));
    // 短时CAS写锁可在持有operation-lock期间写；远端互斥直到真实下层结算。
    a.writeWxCredential(storage.file, { marker: 'during-operation' }, record());
    assert.ok(storage.locks.has(`${storage.file}.operation-lock`));
    gate.resolve(); await rejected; assert.equal(storage.locks.size, 0);
    assert.equal(await b.withWxCredentialOperation(storage.file, undefined, async () => 'after-settle'), 'after-settle');
    assert.equal(storage.files.size, 1);
});

test('operation未知owner残锁不清理，空/坏/无法确认退出均拒绝；跨file操作不互阻', async () => {
    const time = clock(); const storage = fakeFs(record()); const api = loadStorage(storage, time);
    const lock = `${storage.file}.operation-lock`; const ownerFile = `${lock}/owner-${'a'.repeat(32)}.json`;
    for (const owner of [null, 'bad-json', { nonce: 'a'.repeat(32), identity: null }, { nonce: 'a'.repeat(32), identity: { version: 2, pid: '9', startTime: '1', nspid: ['9'], bootId: 'unknown', pidNamespace: 'unknown' } }]) {
        storage.mkdirSync(lock, { mode: 0o700 });
        if (owner !== null) storage.files.set(ownerFile, typeof owner === 'string' ? owner : JSON.stringify(owner));
        await assert.rejects(api.withWxCredentialOperation(storage.file, undefined, async () => assert.fail('未知owner不能运行')), error => error.stage === 'credential_conflict');
        assert.ok(storage.locks.has(lock));
        if (owner !== null) { assert.ok(storage.files.has(ownerFile)); storage.unlinkSync(ownerFile); }
        storage.rmdirSync(lock);
    }
    const gate = deferred(); const other = '/fake/wx-login/other.json'; storage.files.set(other, JSON.stringify({ ...record(), openid: 'other' }));
    const held = api.withWxCredentialOperation(storage.file, record(), async () => gate.promise); await time.flush();
    assert.equal(await loadStorage(storage, time, 2).withWxCredentialOperation(other, undefined, async () => 'independent'), 'independent');
    assert.ok(storage.locks.has(lock)); gate.resolve('done'); assert.equal(await held, 'done'); assert.equal(storage.locks.size, 0);
});

test('gateway同file队列取消不抢跑，底层真实收尾后重读快照；跨file队列不互阻', async () => {
    const h = loadGateway(); const gate = deferred(); const controller = new AbortController(); let runs = 0;
    const first = h.api.withWxCredentialContext(h.storage.file, record(), async context => { runs++; await gate.promise; context.check(); }, { signal: controller.signal });
    const rejected = assert.rejects(first, /模拟取消/); await h.time.flush();
    controller.abort(new Error('模拟取消'));
    const second = h.api.withWxCredentialContext(h.storage.file, record(), async () => { runs++; return 'queued'; });
    const other = '/fake/wx-login/other.json'; const otherRec = { ...record(), openid: 'other' };
    h.storage.files.set(other, JSON.stringify(otherRec));
    assert.equal(await h.api.withWxCredentialContext(other, otherRec, async () => 'other'), 'other');
    assert.equal(runs, 1); assert.ok(h.storage.locks.has(`${h.storage.file}.operation-lock`));
    gate.resolve(); await rejected; assert.equal(await second, 'queued'); assert.equal(runs, 2);
    assert.equal(h.api.wxCredentialFlights.size, 0); assert.equal(h.storage.locks.size, 0);
});

test('storage operation owner writer失败拒绝且清理，CAS快照冲突不进入远端回调', async () => {
    const time = clock(); const storage = fakeFs(record()); const api = loadStorage(storage, time); storage.failWrite = true;
    await assert.rejects(api.withWxCredentialOperation(storage.file, record(), async () => assert.fail('不能运行')), /ENOSPC/);
    assert.equal(storage.files.size, 1); assert.equal(storage.locks.size, 0); storage.failWrite = false;
    await assert.rejects(api.withWxCredentialOperation(storage.file, { ...record(), credentialGeneration: 'wrong' }, async () => assert.fail('不能运行')), error => error.stage === 'credential_conflict');
    assert.equal(storage.locks.size, 0);
});

test('native onSession持久化失败不可继续发code且不能误报成功', async () => {
    const time = clock(); let h; let completed = false;
    const Service = loadService(time, async () => { throw new Error('不得刷新HTTP'); }, {
        ...loadNative(time), async getNativeWxLoginCode(buffer, app, options) {
            h.storage.failWrite = true;
            try { await options.onSession(nativeRecord(time, options.sessionBinding)); }
            catch (cause) { throw Object.assign(new Error('Native session persistence failed'), { stage: 'persist_native_session', code: 'WX_NATIVE_SESSION_PERSIST_FAILED', cause }); }
            completed = true; return 'forbidden-code';
        },
    });
    h = loadGateway({ Service, time }); assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(h.account.wxLastCodeError.stage, 'persist_native_session'); assert.equal(completed, false);
    assert.equal(saved(h).nativeSession, undefined); assert.equal(saved(h).codeFailureCount, undefined); assert.equal(h.storage.locks.size, 0);
});

for (const layer of ['token', 'buffer', 'code']) {
    test(`${layer} persisted error仅安全字段，不存服务原文/stack/cause/合成密钥`, async () => {
        const time = clock(); const initial = { ...record(), tokenCheckedAt: layer === 'token' ? 1 : time.Date.now() };
        const secret = ['wx-test', 'refresh-old', 'access-old', 'buffer-old', 'synthetic-psk-secret'];
        let h;
        const Service = loadService(time, async url => {
            assert.equal(url.includes('refresh_token'), layer === 'token');
            return response({ code: -101, msg: `[40188] ${secret.join(' ')}`, accessToken: 'synthetic-psk-secret' });
        }, { ...loadNative(time), async getNativeWxLoginCode() {
            throw Object.assign(new Error(secret.join(' ')), { stage: 'js_login', code: 'WX_JS_LOGIN_FAILED', cause: { secret }, refreshtoken: 'refresh-old' });
        } });
        h = loadGateway({ Service, time, initial });
        if (layer === 'token') await h.api.keepWxCredentialAlive('2');
        if (layer === 'buffer') await assert.rejects(h.api.refreshWxBufferSingleFlight(h.storage.file, initial, initial, new Service()));
        if (layer === 'code') await h.api.issueWxCodeFromBuffer(h.account);
        const state = saved(h)[`${layer}Error`]; assert.ok(state);
        assert.deepEqual(Object.keys(state).sort(), ['at', 'code', 'reason', 'serverCode', 'stage', 'wechatCode']);
        const exposed = JSON.stringify(state) + h.logs.join('');
        for (const value of secret) assert.ok(!exposed.includes(value), value);
        assert.equal(h.storage.locks.size, 0);
    });
}

test('未知/畸形code响应typed response_invalid，只有严格服务端0可接受且serverCode独立保存', async () => {
    const time = clock();
    for (const code of [undefined, null, false, '', '00', '0.0', [], {}]) {
        const Service = loadService(time, async () => response({ code, userInfo: { accessToken: 'access-new', refreshToken: 'refresh-new' } }));
        await assert.rejects(new Service().refreshCredentials(record()), error => error.code === 'response_invalid' && error.serverCode === undefined && error.stage === 'token_refresh');
    }
    const Service = loadService(time, async () => response({ code: 0, extInfo: {} }));
    await assert.rejects(new Service().refreshBufferWithAccessToken(record()), error => error.code === 'response_invalid' && error.serverCode === 0);
    assert.equal(time.timers.size, 0);
});

test('status只读不创建账号、不抢sock、不写盘、不暴露敏感错误信息', async () => {
    const h = loadGateway(); const existing = { write() { assert.fail('禁止业务socket写入'); } };
    h.account.workerSock = existing; h.account.wxLastCodeError = Object.assign(new Error('refresh-old access-old'), { stage: 'token_refresh', code: 'response_invalid' });
    await h.api.handleWorkerFrame(h.sock, { t: 'status', accountId: '2' });
    const diagnosticSock = { write(text) { h.frames.push(JSON.parse(text)); } };
    await h.api.handleWorkerFrame(diagnosticSock, { t: 'status', accountId: 'uncreated' });
    assert.equal(h.frames[0].state.reason, 'disconnected');
    assert.equal(h.frames[0].state.healthy, false);
    assert.equal(h.frames[1].t, 'status'); assert.equal(h.frames[1].state.pendingCount, 0);
    const now = h.time.Date.now();
    Object.assign(h.account, { ws: { OPEN: 1, readyState: 1 },
        lastHeartbeatResponse: now, lastBusinessSuccessAt: now });
    h.account.userState.gid = 42;
    await h.api.handleWorkerFrame(h.sock, { t: 'status', accountId: '2' });
    assert.equal(h.frames.at(-1).state.reason, 'ok');
    assert.equal(h.frames.at(-1).state.linkHealthy, true);
    assert.equal(h.frames.at(-1).state.businessHealthy, true);
    h.account.operations.add({ kind: 'business', startedAt: now - 5001, sent: true, read: true });
    await h.api.handleWorkerFrame(h.sock, { t: 'status', accountId: '2' });
    assert.equal(h.frames.at(-1).state.reason, 'request_stuck');
    assert.equal(h.frames.at(-1).state.oldestPendingAgeMs, 5001);
    assert.equal(h.frames.at(-1).state.businessPendingCount, 1);
    assert.equal(h.frames.at(-1).state.businessHealthy, false);
    h.account.requestTimeoutStreak = 2;
    await h.api.handleWorkerFrame(h.sock, { t: 'status', accountId: '2' });
    assert.equal(h.frames.at(-1).state.reason, 'business_degraded');
    assert.equal(h.account.workerSock, existing); assert.ok(!h.api.accounts.has('uncreated')); assert.equal(h.storage.writes.length, 0);
    assert.ok(!JSON.stringify(h.frames).includes('refresh-old')); assert.ok(!JSON.stringify(h.frames).includes('access-old'));
});

test('真实重连buffer恢复与keepalive重叠仅一次token，未知二次native失败不吞重连timer', async () => {
    const time = clock(); const tokenGate = deferred(); let tokens = 0; let buffers = 0; let natives = 0;
    const Service = loadService(time, async url => {
        if (url.includes('refresh_token')) { tokens++; await tokenGate.promise; return tokenResponse(); }
        buffers++; return bufferResponse();
    }, { ...loadNative(time), async getNativeWxLoginCode() {
        natives++;
        if (natives === 1) throw Object.assign(new Error('明确拒绝'), { code: 'WX_MANUAL_AUTH_REJECTED', serverCode: -10 });
        throw Object.assign(new Error('native timeout'), { stage: 'js_login', code: 'WX_NATIVE_TIMEOUT' });
    } });
    const h = loadGateway({ Service, time });
    const reconnecting = h.api.reconnect(h.account); await time.flush(); assert.equal(tokens, 1);
    const keep = h.api.keepWxCredentialAlive('2'); const keepAgain = h.api.keepWxCredentialAlive('2');
    await time.flush(); assert.equal(tokens, 1); assert.equal(buffers, 0);
    tokenGate.resolve(); assert.equal(await reconnecting, false); await Promise.all([keep, keepAgain]);
    assert.equal(tokens, 1); assert.equal(buffers, 1); assert.equal(natives, 2);
    assert.equal(saved(h).refreshtoken, 'refresh-new'); assert.equal(saved(h).codeFailureCount, 1);
    const timer = h.account.reconnectTimer; assert.ok(timer); assert.ok(time.timers.has(timer));
    await h.api.keepWxCredentialAlive('2'); assert.equal(h.account.reconnectTimer, timer);
    assert.equal(h.wsSockets.length, 0); assert.equal(h.api.wxCredentialFlights.size, 0); assert.equal(h.storage.locks.size, 0);
});

test('buffer同层单飞直到真实fetch取消收尾，排队token/native不提前进入远端', async () => {
    const time = clock(); const remote = deferred(); const controller = new AbortController(); let bufferCalls = 0; let nativeCalls = 0; let observedAbort = false;
    const initial = { ...record(), tokenCheckedAt: time.Date.now() };
    const Service = loadService(time, async (url, init) => {
        bufferCalls++; assert.ok(!url.includes('refresh_token'));
        init.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
        return remote.promise;
    }, { ...loadNative(time), async getNativeWxLoginCode() { nativeCalls++; return 'after-buffer-settled'; } });
    const h = loadGateway({ Service, time, initial });
    const a = h.api.refreshWxBufferSingleFlight(h.storage.file, initial, initial, new Service(), { signal: controller.signal });
    const b = h.api.refreshWxBufferSingleFlight(h.storage.file, initial, initial, new Service());
    assert.equal(a, b); const rejected = assert.rejects(a, /模拟取消/);
    await time.flush(); controller.abort(new Error('模拟取消')); await time.flush(); assert.equal(observedAbort, true);
    const queued = h.api.issueWxCodeFromBuffer(h.account); await time.flush();
    assert.equal(bufferCalls, 1); assert.equal(nativeCalls, 0); assert.ok(h.storage.locks.has(`${h.storage.file}.operation-lock`));
    assert.equal(h.api.refreshWxBufferSingleFlight(h.storage.file, initial, initial, new Service()), a);
    remote.reject(controller.signal.reason); await rejected; assert.equal(await queued, 'after-buffer-settled');
    assert.equal(nativeCalls, 1); assert.equal(h.storage.locks.size, 0); assert.equal(time.timers.size, 0);
});

test('两个gateway VM共用磁盘操作锁，inflight另一进程不得重复旋转token', async () => {
    const time = clock(); const remote = deferred(); let calls = 0;
    const Service = loadService(time, async () => { calls++; return remote.promise; });
    const storage = fakeFs(record()); const a = loadGateway({ Service, time, storage }); const b = loadGateway({ Service, time, storage });
    const pending = a.api.keepWxCredentialAlive('2'); await time.flush(); assert.equal(calls, 1);
    await b.api.keepWxCredentialAlive('2'); assert.equal(calls, 1);
    assert.ok(b.logs.some(value => value.includes('credential_conflict'))); assert.ok(storage.locks.has(`${storage.file}.operation-lock`));
    remote.resolve(tokenResponse()); await pending; await b.api.keepWxCredentialAlive('2');
    assert.equal(calls, 1); assert.equal(saved(a).refreshtoken, 'refresh-new'); assert.equal(storage.locks.size, 0);
});

test('pendingCode两个gateway VM同时take只有一次CAS消费，另一路被操作锁拒绝', async () => {
    const time = clock(); const counter = { calls: 0 };
    const initial = { ...record(), pendingCode: { generation: 'generation-old', value: 'scan-once', consumed: false, issuedAt: time.Date.now(), expiresAt: time.Date.now() + MINUTE } };
    const storage = fakeFs(initial); const Service = successfulService(counter, time);
    const a = loadGateway({ Service, time, storage, initial }); const b = loadGateway({ Service, time, storage, initial });
    const result = await Promise.all([a.api.issueWxCodeFromBuffer(a.account), b.api.issueWxCodeFromBuffer(b.account)]);
    assert.equal(result.filter(value => value === 'scan-once').length, 1); assert.equal(result.filter(value => value === null).length, 1);
    assert.equal(counter.codes || 0, 0); assert.equal(storage.writes.length, 1);
    assert.equal(saved(a).pendingCode.value, null); assert.equal(saved(a).pendingCode.consumed, true); assert.equal(storage.locks.size, 0);
});

test('legacy凭据生成新generation但不抹disk层冷却，不伪造native.cache，正常require crypto', async () => {
    const time = clock(); const initial = { ...record(), tokenCheckedAt: 1, tokenRetryAfter: time.Date.now() + MINUTE, bufferRetryAfter: time.Date.now() + 2 * MINUTE };
    delete initial.credentialGeneration;
    initial.nativeSession = { cache: true }; initial.pendingCode = { value: 'unbound-code' };
    const h = loadGateway({ time, initial }); assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'code-fake');
    const current = saved(h); assert.match(current.credentialGeneration, /^[a-f0-9]{32}$/);
    assert.equal(current.nativeSession, null); assert.equal(current.pendingCode, null);
    assert.equal(current.tokenRetryAfter, initial.tokenRetryAfter); assert.equal(current.bufferRetryAfter, initial.bufferRetryAfter);
    assert.equal(h.storage.locks.size, 0);
});

test('PSK记录unknown服务器lifetime仅本次新native可用，不跨调用复用或主动refresh', async () => {
    const time = clock(); const native = loadNative(time); let manual = 0; let h;
    const Service = loadService(time, async () => assert.fail('unknown lifetime不刷新token/buffer'), {
        ...native, async getNativeWxLoginCode(buffer, app, options) {
            assert.equal(options.session, null); assert.ok(buffer); manual++;
            const rec = nativeRecord(time, options.sessionBinding);
            rec.ticket = Buffer.from([0, 1, 2, 3, 4]).toString('base64'); rec.expiresAt = null;
            await options.onSession(rec); assert.equal(native.hasNativeSession(saved(h).nativeSession, options.sessionBinding), false);
            return `same-call-code-${manual}`;
        },
    });
    h = loadGateway({ Service, time }); assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'same-call-code-1');
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'same-call-code-2'); assert.equal(manual, 2);
    assert.equal(saved(h).refreshtoken, 'refresh-old'); assert.equal(h.storage.locks.size, 0);
});

test('游戏WS1006只记游戏故障，重连优先缓存native且不续token或buffer', async () => {
    const time = clock(); const initial = { ...record(), loginBuffer: '', nativeSession: nativeRecord(time, 'wx-login:wx-test:generation-old') }; let issues = 0;
    const Service = loadService(time, async () => assert.fail('1006不能触发HTTP刷新'), { ...loadNative(time), async getNativeWxLoginCode(buffer, app, options) {
        assert.equal(buffer, ''); assert.ok(options.session); issues++; return `cached-${issues}`;
    } });
    const h = loadGateway({ Service, time, initial }); h.account.workerSock = h.sock;
    h.api.connect(h.account, 'synthetic-game-code'); const socket = h.account.ws;
    socket.readyState = 3; socket.emit('close', 1006);
    assert.equal(h.account.wxNeedsRefresh, undefined); assert.equal(h.account.codeInvalidCount, 1);
    vm.runInContext('connect = () => {};', h.context);
    assert.equal(await h.api.reconnect(h.account), false, '旧游戏loginPromise已false，尚未真实登录不能报true');
    assert.equal(issues, 1); assert.equal(saved(h).refreshtoken, 'refresh-old'); assert.equal(saved(h).tokenCheckedAt, 1);
    assert.equal(saved(h).bufferFailureCount, undefined); assert.equal(h.wsSockets.length, 1);
});

test('token-only真实30s超时仅记token层，account/game/native/pendingCode/timer原样保留', async () => {
    const time = clock(); let aborted = 0; let calls = 0;
    const Service = loadService(time, async (url, init) => {
        calls++; assert.ok(url.includes('refresh_token'));
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(init.signal.reason); }, { once: true }));
    });
    const initial = { ...record(), nativeSession: nativeRecord(time, 'wx-login:wx-test:generation-old'), pendingCode: { generation: 'generation-old', value: 'scan-code', consumed: false, issuedAt: time.Date.now(), expiresAt: time.Date.now() + MINUTE } };
    const h = loadGateway({ Service, time, initial });
    const timer = time.setTimeout(() => {}, MINUTE); const game = { readyState: 1, OPEN: 1 };
    Object.assign(h.account, { ws: game, wxTempFailCount: 3, wxRetryAfter: time.Date.now() + 10 * MINUTE, reconnectTimer: timer, wxLastCodeError: new Error('game-error') });
    const gameError = h.account.wxLastCodeError;
    const pending = h.api.keepWxCredentialAlive('2'); await time.flush(); assert.equal(calls, 1);
    await time.advance(30000); await pending;
    assert.equal(aborted, 1); assert.equal(saved(h).tokenError.stage, 'token_refresh');
    assert.equal(saved(h).tokenError.serverCode, null); assert.equal(saved(h).tokenFailureCount, 1);
    assert.equal(saved(h).tokenRetryAfter, time.Date.now() + 5 * MINUTE);
    assert.deepEqual(saved(h).nativeSession, initial.nativeSession); assert.deepEqual(saved(h).pendingCode, initial.pendingCode);
    assert.equal(h.account.ws, game); assert.equal(h.account.wxLastCodeError, gameError); assert.equal(h.account.wxTempFailCount, 3);
    assert.equal(h.account.reconnectTimer, timer); assert.equal(time.timers.size, 1); assert.ok(time.timers.has(timer));
    assert.equal(h.storage.locks.size, 0); assert.equal(h.api.wxCredentialFlights.size, 0);
});

test('stop后的重复connect在旧native收尾前不能复活；operation-lock保持直至下层真实结束', async () => {
    const time = clock(); const gate = deferred(); let issued = 0;
    class Service extends successfulService({}, time) { async issueCode() { issued++; await gate.promise; return 'old-code'; } }
    const h = loadGateway({ Service, time }); const pending = h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    await time.flush(); await h.api.handleWorkerFrame(h.sock, { t: 'stop', accountId: '2' });
    const epoch = h.account.connectionEpoch;
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2', code: 'ignored-old-code' });
    assert.equal(h.account.networkStopped, true); assert.equal(h.account.connectionEpoch, epoch); assert.equal(issued, 1);
    assert.ok(h.storage.locks.has(`${h.storage.file}.operation-lock`));
    gate.resolve(); await pending; assert.equal(h.account.networkStopped, true); assert.equal(h.account.savedCode, 'saved-old');
    assert.equal(h.wsSockets.length, 0); assert.equal(h.storage.locks.size, 0); assert.equal(time.timers.size, 0);
});

test('token-only请求inflight新扫码CAS拒绝旧轮换响应，不覆盖新generation或报续期成功', async () => {
    const time = clock(); const remote = deferred(); let calls = 0;
    const Service = loadService(time, async () => { calls++; return remote.promise; }); const h = loadGateway({ Service, time });
    const pending = h.api.keepWxCredentialAlive('2'); await time.flush(); assert.equal(calls, 1);
    const scan = { ...record(), credentialGeneration: 'generation-new', refreshtoken: 'refresh-scan', accesstoken: 'access-scan', tokenCheckedAt: time.Date.now() };
    h.storage.files.set(h.storage.file, JSON.stringify(scan)); remote.resolve(tokenResponse()); await pending;
    assert.deepEqual(saved(h), scan); assert.equal(h.storage.locks.size, 0); assert.equal(time.timers.size, 0);
    assert.ok(h.logs.some(value => value.includes('credential_conflict'))); assert.ok(!h.logs.some(value => value.includes('续期并落盘成功')));
});

test('native onSession世代绑定错误必须拒绝，不能写错cache或继续交接code', async () => {
    const time = clock(); let continued = false;
    const Service = loadService(time, async () => assert.fail('不能刷新HTTP'), { ...loadNative(time), async getNativeWxLoginCode(buffer, app, options) {
        await options.onSession(nativeRecord(time, 'wx-login:other-wx:other-generation'));
        continued = true; return 'wrong-session-code';
    } });
    const h = loadGateway({ Service, time }); assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(h.account.wxLastCodeError.stage, 'credential_conflict'); assert.equal(continued, false);
    assert.deepEqual(saved(h), record()); assert.equal(h.storage.locks.size, 0); assert.equal(h.wsSockets.length, 0);
});

test('token缺access响应只保存已旋转材料，不能伪报lastSuccess，冷却期满可按token层重试', async () => {
    const time = clock(); let calls = 0;
    const Service = loadService(time, async () => ++calls === 1
        ? response({ code: 0, userInfo: { refreshToken: 'refresh-rotated-without-access' } }) : tokenResponse());
    const h = loadGateway({ Service, time });
    await h.api.keepWxCredentialAlive('2');
    const failure = saved(h);
    assert.equal(failure.refreshtoken, 'refresh-rotated-without-access');
    assert.equal(failure.tokenLastSuccessAt, undefined);
    assert.equal(failure.tokenRefreshPending, true);
    assert.ok(failure.tokenRetryAfter > time.Date.now());
    await time.advance(5 * MINUTE);
    await h.api.keepWxCredentialAlive('2');
    assert.equal(calls, 2); assert.equal(saved(h).tokenRefreshPending, false);
    assert.ok(saved(h).tokenLastSuccessAt > 0);
    assert.equal(saved(h).loginBuffer, 'buffer-old');
});

test('withTimeout 成功和超时都清理自身timer', async () => {
    const h = loadGateway();
    assert.equal(await h.api.withTimeout(Promise.resolve('ok'), 1000, '模拟'), 'ok');
    assert.equal(h.time.timers.size, 0);
    const pending = h.api.withTimeout(new Promise(() => {}), 1000, '模拟');
    const rejected = assert.rejects(pending, /超时/);
    await h.time.advance(1000); await rejected;
    assert.equal(h.time.timers.size, 0);
});

// 2026-11-07 事故回归 + 2026-11-08 结论纠正：
// 短链阶段 APP_DECRYPT_FAILED 只证明"这条响应解不出来"，真实 AES 复核证实同一张合法票
// 在偏移 220 / 多 record 布局下也会报同一错误。因此不得据此判定"票被服务端拒绝"，
// 只能用一次 ManualAuth 拿权威结论（真拒绝会是 WX_MANUAL_AUTH_REJECTED/-10）。
function ticketService(time, behaviour) {
    const native = loadNative(time);
    return class {
        hasNativeSession(rec, binding) { return native.hasNativeSession(rec, binding); }
        async issueCode(session, appId, options) { return behaviour(options, time); }
    };
}
function seedCachedTicket(h, time) {
    const binding = h.api.wxSessionBinding(saved(h), 'wx-test');
    h.storageApi.writeWxCredential(h.storage.file, { nativeSession: nativeRecord(time, binding) }, saved(h));
    return binding;
}
const unverifiedError = () => Object.assign(new Error('ShortLink application decryption failed'),
    { code: 'WX_SHORTLINK_APP_DECRYPT_FAILED', stage: 'shortlink', ticketUnverified: true });
const manualRejected = () => Object.assign(new Error('ManualAuth rejected: code=-10'),
    { code: 'WX_MANUAL_AUTH_REJECTED', stage: 'manual_auth', serverCode: -10 });

test('短链解码失败不做废票断言：改用一次 ManualAuth 权威校验并复用成功结果', async () => {
    const time = clock();
    const counter = { cached: 0, manual: 0 };
    const Service = ticketService(time, async (options, t) => {
        if (options.session) { counter.cached++; throw unverifiedError(); }
        counter.manual++;
        await options.onSession(nativeRecord(t, options.sessionBinding));
        return 'code-reverified';
    });
    const h = loadGateway({ Service, time });
    seedCachedTicket(h, time);
    const bufferBefore = saved(h).loginBuffer;
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), 'code-reverified');
    assert.equal(counter.cached, 1, '必须先尝试复用已存的票');
    assert.equal(counter.manual, 1, '解码失败只做一次权威校验');
    assert.equal(saved(h).loginBuffer, bufferBefore, '权威校验不得改动登录缓冲');
    assert.equal(saved(h).nativeSession.binding, h.api.wxSessionBinding(saved(h), 'wx-test'), '新票必须落盘');
    assert.equal(h.wsSockets.length, 0); assert.equal(time.timers.size, 0);
});

test('权威校验也解不出来：不虚报成功，不报需扫码，只按临时失败退避', async () => {
    const time = clock();
    const counter = { attempts: 0 };
    const Service = ticketService(time, async () => { counter.attempts++; throw unverifiedError(); });
    const h = loadGateway({ Service, time });
    seedCachedTicket(h, time);
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(counter.attempts, 2, '复用一次 + 权威校验一次，不无限重试');
    assert.equal(h.account.wxLastCodeError.code, 'WX_SHORTLINK_APP_DECRYPT_FAILED');
    assert.equal(h.account.wxLastCodeError.ticketRejected, undefined, '不得把解码失败标成票据拒绝');
    assert.equal(h.account.networkStopped, false, '解不出来不等于凭证失效，不能停死');

    const alerts = [];
    h.account.workerSock = { destroyed: false, write: line => alerts.push(JSON.parse(line)) };
    h.api.handleWxCodeFailure(h.account, h.account.wxLastCodeError, { schedule: false });
    h.api.handleWxCodeFailure(h.account, h.account.wxLastCodeError, { schedule: false });
    assert.equal(alerts.filter(frame => frame.name === 'code_invalid').length, 0, '解码失败不得要求用户重扫码');
    assert.equal(h.account.networkStopped, false);
    assert.ok(h.account.wxRetryAfter > time.Date.now(), '仍按临时失败退避重试');
    assert.equal(time.timers.size, 0);
});

test('ManualAuth 明确 -10 才刷新 loginBuffer；换新缓冲后仍 -10 才需重扫码', async () => {
    const time = clock();
    const calls = [];
    class Service extends ticketService(time, async () => { throw manualRejected(); }) {
        async refreshBufferWithAccessToken() { calls.push('buffer'); return { loginBuffer: 'buffer-new' }; }
    }
    const h = loadGateway({ Service, time, initial: {
        ...record(), accessTokenExpiresAt: time.Date.now() + 60 * MINUTE,
        nativeSession: nativeRecord(time, 'wx-login:wx-test:generation-old'),
    } });
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    const error = h.account.wxLastCodeError;
    assert.deepEqual(calls, ['buffer'], '明确 -10 才刷新缓冲');
    assert.equal(saved(h).loginBuffer, 'buffer-new');
    assert.equal(error.code, 'WX_MANUAL_AUTH_REJECTED');
    assert.equal(error.serverCode, -10);
    assert.equal(error.ticketRejected, true, '换新缓冲后仍被拒才允许判定需要重扫码');

    const alerts = [];
    h.account.workerSock = { destroyed: false, write: line => alerts.push(JSON.parse(line)) };
    h.api.handleWxCodeFailure(h.account, error, { schedule: false });
    const rescans = alerts.filter(frame => frame.name === 'code_invalid');
    assert.equal(rescans.length, 1);
    assert.equal(rescans[0].payload.needRescan, true);
    assert.equal(rescans[0].payload.reason, 'wx_buffer_auth_rejected');
    assert.equal(rescans[0].payload.networkStopped, false);
    assert.equal(h.account.networkStopped, false);
    assert.equal(time.timers.size, 0);
});

test('无缓存票时短链解码失败不触发 ManualAuth 与缓冲刷新', async () => {
    const time = clock();
    const counter = { attempts: 0, buffers: 0 };
    class Service extends ticketService(time, async () => { counter.attempts++; throw unverifiedError(); }) {
        async refreshBufferWithAccessToken() { counter.buffers++; return { loginBuffer: 'buffer-new' }; }
    }
    const h = loadGateway({ Service, time });
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(counter.attempts, 1);
    assert.equal(counter.buffers, 0, '没有可丢弃的旧票就不该额外握手');
    assert.equal(saved(h).loginBuffer, 'buffer-old');
    assert.equal(time.timers.size, 0);
});

test('冷启动保存新会话后短链失败，不得在同次调用再次 ManualAuth', async () => {
    const time = clock();
    let attempts = 0;
    const Service = ticketService(time, async (options, t) => {
        attempts++;
        if (!options.session) await options.onSession(nativeRecord(t, options.sessionBinding));
        throw unverifiedError();
    });
    const h = loadGateway({ Service, time });
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(attempts, 1, '本次刚做完认证，onSession存在不代表调用复用了旧票');
    assert.ok(saved(h).nativeSession, '已认证会话要先保存，不能因取码失败丢弃');
    assert.equal(h.account.wxLastCodeError.ticketRejected, undefined);
    assert.equal(h.storage.locks.size, 0);
});

test('同一旧票重验失败的预算跨调用和新网关VM持久化，不反复认证', async () => {
    const time = clock();
    const count = { cached: 0, manual: 0 };
    const Service = ticketService(time, async options => {
        if (options.session) { count.cached++; throw unverifiedError(); }
        count.manual++;
        throw Object.assign(new Error('ManualAuth timeout'), { stage: 'manual_auth' });
    });
    const h = loadGateway({ Service, time });
    seedCachedTicket(h, time);
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(count.manual, 1);
    assert.ok(saved(h).nativeReverify, '在发请求前持久化单票重验预算');
    await time.advance(5 * MINUTE);
    const next = loadGateway({ initial: saved(h), storage: h.storage, Service, time });
    assert.equal(await next.api.issueWxCodeFromBuffer(next.account), null);
    assert.equal(count.cached, 2, '同票仍允许正常短链重试');
    assert.equal(count.manual, 1, '新VM也不得再次使用同票重验预算');
    assert.equal(next.storage.locks.size, 0);
});

test('仅有旧 ticketRejected 标签但无二次 ManualAuth 拒绝证据不得报需扫码', () => {
    const h = loadGateway();
    h.account.workerSock = h.sock;
    h.api.handleWxCodeFailure(h.account, Object.assign(unverifiedError(), { ticketRejected: true }), { schedule: false });
    assert.equal(h.frames.filter(frame => frame.payload?.needRescan).length, 0);
    assert.equal(h.account.wxRescanAlerted, false);
    assert.equal(h.account.networkStopped, false);
});

test('新扫码世代清除旧的需扫码告警标记', async () => {
    const h = loadGateway();
    h.account.wxRescanAlerted = true;
    vm.runInContext('connect = () => {};', h.context);
    h.storage.files.set(h.storage.file, JSON.stringify({ ...record(), credentialGeneration: 'new-scan-generation', tokenCheckedAt: h.time.Date.now() }));
    await h.api.handleWorkerFrame(h.sock, { t: 'connect', accountId: '2' });
    assert.equal(h.account.wxRescanAlerted, false);
});

test('非短链的临时错误不触发权威校验，也不误报需扫码', async () => {
    const time = clock();
    const counter = { attempts: 0 };
    const Service = ticketService(time, async () => {
        counter.attempts++;
        throw Object.assign(new Error('换码超时 20000ms'), { stage: 'js_login' });
    });
    const h = loadGateway({ Service, time });
    seedCachedTicket(h, time);
    assert.equal(await h.api.issueWxCodeFromBuffer(h.account), null);
    assert.equal(counter.attempts, 1, '超时类错误不做权威校验');
    const alerts = [];
    h.account.workerSock = { destroyed: false, write: line => alerts.push(JSON.parse(line)) };
    h.api.handleWxCodeFailure(h.account, h.account.wxLastCodeError, { schedule: false });
    assert.equal(alerts.filter(frame => frame.name === 'code_invalid').length, 0);
    assert.equal(h.account.networkStopped, false);
});
