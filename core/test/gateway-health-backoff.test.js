// 纯 VM 传输回归：所有 socket、时钟、调度器和协议均为内存 mock。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');

const USER = 'gamepb.userpb.UserService';
const ITEM = 'gamepb.itempb.ItemService';
const PLANT = 'gamepb.plantpb.PlantService';
const BAG = Buffer.from([8, 1]);
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function capture(promise) { return promise.then(value => ({ value }), error => ({ error })); }

function harness(direct = false) {
    let now = 10000;
    let nextTimer = 1;
    const timers = new Map();
    const sockets = [];
    const env = { FARM_ACCOUNT_ID: '99', FARM_NETWORK_MODE: 'local' };
    const mockProcess = { env };
    const clock = {
        setTimeout(fn, delay) {
            const id = nextTimer++;
            timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0) });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    class MockDate extends Date { static now() { return now; } }
    class Socket extends EventEmitter {
        constructor() { super(); this.destroyed = false; this.readyState = 1; this.frames = []; sockets.push(this); }
        setEncoding() {}
        write(line) {
            if (this.writeError) throw this.writeError;
            this.frames.push(JSON.parse(line));
            return true;
        }
        send(bytes) { this.frames.push(JSON.parse(Buffer.from(bytes).toString())); }
        destroy() { this.destroyed = true; this.readyState = 3; this.emit('close'); }
        close() { this.destroy(); }
        terminate() { this.destroy(); }
    }
    Socket.OPEN = 1;
    function load(relative, dependencies, suffix = '') {
        const filename = path.join(__dirname, relative);
        const module = { exports: {} };
        const sandbox = {
            module, exports: module.exports, Buffer, Date: MockDate, AbortController,
            setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, process: mockProcess,
            require(name) {
                if (!Object.hasOwn(dependencies, name)) throw new Error(`禁止未 mock 依赖: ${name}`);
                return dependencies[name];
            },
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8') + suffix, sandbox, { filename });
        return module.exports;
    }
    const priority = load('../src/utils/request-priority.js', {
        'node:async_hooks': { AsyncLocalStorage }, 'node:crypto': { createHash },
    });
    const protocol = {
        encodeFrame: JSON.stringify, decodeFrame: JSON.parse,
        toBase64: bytes => Buffer.from(bytes).toString('base64'),
        fromBase64: value => Buffer.from(value || '', 'base64'),
    };
    const utils = { log() {}, logWarn() {}, toLong: value => value, toNum: Number, syncServerTime() {} };
    const gc = load('../src/runtime/gateway-client.js', {
        net: { connect: () => new Socket() }, events: { EventEmitter },
        './gateway-protocol': protocol, '../utils/request-priority': priority, '../utils/utils': utils,
        '../services/account-operation-barrier': { assertGameRequestAllowed() {}, isSceneRequestOwned: () => false },
    });
    let api = gc;
    let encryption = null;
    if (direct) {
        const tasks = new Map();
        const scheduler = {
            setTimeoutTask(key, delay, fn) { this.clear(key); tasks.set(key, clock.setTimeout(fn, delay)); },
            setIntervalTask() { throw new Error('测试禁止启动心跳 interval'); },
            clear(key) { clock.clearTimeout(tasks.get(key)); tasks.delete(key); },
            clearAll() { for (const key of tasks.keys()) this.clear(key); },
        };
        api = load('../src/utils/network.js', {
            'node:buffer': { Buffer }, 'node:events': EventEmitter, 'node:process': mockProcess,
            ws: Socket, '../config/config': { CONFIG: {} }, '../services/ace-service': {},
            '../services/scheduler': { createScheduler: () => scheduler },
            '../services/status': {}, '../services/stats': {},
            './proto': { types: { GateMessage: {
                create: value => value,
                encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
                decode: bytes => {
                    const message = JSON.parse(Buffer.from(bytes).toString());
                    if (message.body?.type === 'Buffer') message.body = Buffer.from(message.body.data);
                    return message;
                },
            } } },
            './utils': utils, './crypto-wasm': { encryptBuffer: bytes => encryption ? encryption(bytes) : bytes, setRuntime() {} },
            './gateway-token': { createGatewayToken: () => 'mock' }, './tsdk-runtime': {},
            './request-priority': priority, 'node:worker_threads': {},
            '../services/account-operation-barrier': { assertGameRequestAllowed() {}, isSceneRequestOwned: () => false },
        }, '\nmodule.exports.__mock = { login(socket) { ws = socket; userState.gid = 1; }, handleMessage, rejectAllPendingRequests };');
        api.__mock.login(new Socket());
    }
    const h = {
        api, gc, priority, timers, sockets, now: () => now,
        deferEncryption(fn) { encryption = fn; },
        elapse(ms) { now += ms; },
        async tick(ms) {
            await flush();
            now += ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, item]) => item.at <= now).sort((a, b) => a[1].at - b[1].at);
                if (!due.length) break;
                const [id, item] = due[0];
                timers.delete(id);
                item.fn();
                await flush();
            }
            await flush();
        },
        login(id = '99') {
            gc.connect(id, '', null, { resumeSession: true });
            this.frame({ t: 'login', accountId: id, userState: { gid: 1, name: id }, generation: 1 });
        },
        frame(frame, socket = sockets.at(-1)) { socket.emit('data', JSON.stringify(frame) + '\n'); },
        requests() {
            return sockets.flatMap(socket => socket.frames).filter(frame => direct ? frame.meta?.message_type === 1 : frame.t === 'request');
        },
        sent(request, patch = {}) {
            this.frame({ t: 'request_sent', accountId: request.accountId, seq: request.seq,
                connectionEpoch: request.connectionEpoch ?? 1, sentAt: now,
                settlementDeadline: now + 120000, readOnly: false, ...patch });
        },
        reply(request, patch = {}) {
            if (direct) {
                api.__mock.handleMessage(Buffer.from(JSON.stringify({ meta: {
                    message_type: 2, client_seq: request.meta.client_seq, error_code: patch.errorCode || 0,
                    service_name: request.meta.service_name, method_name: request.meta.method_name, ...patch.meta,
                }, body: patch.body || Buffer.from('mock') })));
            } else this.frame({ t: 'response', accountId: '99', seq: request.seq, body: 'b2s=', ...patch });
        },
        async clean() {
            if (direct) api.stopNetwork('测试清理');
            else gc.detach();
            await flush();
            assert.equal(api.getDiagnosticSnapshot().pending, 0);
            assert.equal(api.getDiagnosticSnapshot().queue.active, 0);
            assert.equal(api.getDiagnosticSnapshot().queue.queued, 0);
            assert.equal(api.getDiagnosticSnapshot().reads.inFlight, 0);
            assert.equal(timers.size, 0, '无孤儿 timer');
        },
    };
    if (!direct) h.login();
    return h;
}

for (const direct of [false, true]) {
    const mode = direct ? 'direct' : 'gateway';
    test(`${mode}: 等待传输队列时撤销好友写入许可，不发送旧请求`, async () => {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        await flush();
        let allowed = true;
        const write = capture(h.api.sendMsgAsync('gamepb.animalpb.RanchService', 'PutHazard', BAG, {
            assertCanSend() {
                if (!allowed) throw h.priority.requestError('名单已变更', { errorCode: 'RANCH_FRIEND_ACTION_DISABLED' });
            },
        }));
        await flush();
        assert.equal(h.api.getRequestQueueSnapshot().queued, 1);
        assert.equal(h.requests().length, 8);
        allowed = false;
        h.reply(h.requests()[0]);
        assert.equal((await write).error.resultState, 'not_sent');
        assert.equal(h.requests().length, 8);
        for (const request of h.requests().slice(1)) h.reply(request);
        await Promise.all(jobs);
        await h.clean();
    });

    test(`${mode}: 真实 gate 8+1、degraded 清业务队列且不误拦 HB/ACE`, async () => {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        const ninth = capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([9])));
        await flush();
        assert.equal(h.requests().length, 8);
        assert.equal(h.api.getRequestQueueSnapshot().queued, 1);
        h.api.setHealthBackoff(5000, '测试退避');
        assert.equal((await ninth).error.sent, false);
        for (const [service, method] of [[PLANT, 'Heartbeat'], [USER, 'Logout'], [USER, 'GetReward'], ['gamepb.acepb.AceService', 'GetGift']]) {
            const result = await capture(h.api.sendMsgAsync(service, method, BAG, { priority: 'critical' }));
            assert.equal(result.error.errorCode, 'HEALTH_BACKOFF');
        }
        const heartbeat = capture(h.api.sendMsgAsync(USER, 'Heartbeat', BAG));
        const ace = capture(h.api.sendMsgAsync('gamepb.acepb.AceService', 'AntiData', BAG));
        await flush();
        assert.equal(h.requests().length, 9);
        assert.equal(h.api.getRequestQueueSnapshot().criticalActive, 1);
        h.api.cancelQueued();
        assert.equal(h.api.getRequestQueueSnapshot().queued, 1, 'ACE 保留');
        h.reply(h.requests().at(-1));
        assert.ok((await heartbeat).value);
        await flush();
        assert.equal(h.requests().length, 10);
        h.reply(h.requests().at(-1));
        assert.ok((await ace).value);
        h.reply(h.requests()[0]);
        await flush();
        assert.equal(h.requests().length, 10, '退避后第九笔业务不能发送');
        h.api.clearHealthBackoff();
        await h.clean();
        await Promise.all(jobs);
    });

    test(`${mode}: queued write deadline 和取消后绝不发送`, async () => {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        await flush();
        const expired = capture(h.priority.runWithRequestContext({ deadline: h.now() + 20 }, () => h.api.sendMsgAsync(PLANT, 'Harvest', BAG)));
        const controller = new AbortController();
        const cancelled = capture(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.sendMsgAsync(PLANT, 'Harvest', BAG)));
        await flush();
        controller.abort();
        await h.tick(21);
        assert.equal((await expired).error.errorCode, 'REQUEST_DEADLINE');
        assert.equal((await cancelled).error.errorCode, 'REQUEST_CANCELLED');
        h.reply(h.requests()[0]);
        await flush();
        assert.equal(h.requests().length, 8);
        await h.clean();
        await Promise.all(jobs);
    });

    test(`${mode}: abort 一个 shared read 不影响另一个，settle 后只共享在途`, async () => {
        const h = harness(direct);
        const controller = new AbortController();
        const a = capture(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
        const b = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        assert.equal(h.requests().length, 1);
        controller.abort();
        assert.equal((await a).error.errorCode, 'REQUEST_CANCELLED');
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
        h.reply(h.requests()[0]);
        assert.ok((await b).value);
        await flush();
        assert.equal(h.api.getDiagnosticSnapshot().reads.inFlight, 0);
        const c = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        assert.equal(h.requests().length, 2);
        h.reply(h.requests()[1]);
        assert.ok((await c).value);
        await h.clean();
    });

    test(`${mode}: 共享读精确 bodyhash、非白名单不合并、写不重放且前后失效`, async () => {
        const h = harness(direct);
        const old = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        const otherBody = capture(h.api.sendMsgAsync(ITEM, 'Bag', Buffer.from([8, 2])));
        await flush();
        assert.equal(h.requests().length, 2);
        const controller = new AbortController();
        const write = capture(h.priority.runWithRequestContext({ signal: controller.signal, deadline: h.now() + 10 }, () =>
            h.api.sendMsgAsync(PLANT, 'Harvest', BAG, 15)));
        const duplicateWrite = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
        await flush();
        const duringWrite = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        assert.equal(h.requests().length, 5);
        controller.abort();
        await h.tick(11);
        assert.equal(h.api.getDiagnosticSnapshot().pending, 5, 'HTTP deadline 不缩短已发写结算');
        if (direct) h.reply(h.requests()[2], { errorCode: 77 });
        else h.reply(h.requests()[2], { error: '写结算超时', meta: { sent: true, outcomeUnknown: true, retryable: false } });
        const error = (await write).error;
        assert.equal(error.sent, true);
        assert.equal(error.resultState, direct ? 'failed' : 'unknown');
        const afterWrite = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        const getMutation = capture(h.api.sendMsgAsync(ITEM, 'GetAndClaim', BAG));
        const getMutation2 = capture(h.api.sendMsgAsync(ITEM, 'GetAndClaim', BAG));
        await flush();
        assert.equal(h.requests().length, 8, '未知 Get 不按前缀共享，写超时无重放');
        for (const request of h.requests()) h.reply(request);
        await Promise.all([old, otherBody, duplicateWrite, duringWrite, afterWrite, getMutation, getMutation2]);
        await h.clean();
    });

    test(`${mode}: 所有读等待者取消时 queued 调用取消，已发 flight 留到真实 settle`, async () => {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        await flush();
        const controller = new AbortController();
        const queued = capture(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
        await flush();
        controller.abort();
        await queued;
        await flush();
        h.reply(h.requests()[0]);
        await flush();
        assert.equal(h.requests().length, 8);
        const liveController = new AbortController();
        const live = capture(h.priority.runWithRequestContext({ signal: liveController.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
        await flush();
        liveController.abort();
        await live;
        assert.equal(h.api.getDiagnosticSnapshot().reads.inFlight, 1);
        h.reply(h.requests().at(-1));
        await flush();
        assert.equal(h.api.getDiagnosticSnapshot().reads.inFlight, 0);
        await h.clean();
        await Promise.all(jobs);
    });
}

test('gateway: metadata/numeric timeout、默认 wire30s 与写租约120s 分离、remote error 字段保留', async () => {
    const h = harness();
    const a = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG, 15000));
    const b = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG, { priority: 'background', timeoutMs: 12000 }));
    const c = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
    await flush();
    assert.equal(h.requests()[0].meta.timeoutMs, 15000);
    assert.equal(h.requests()[1].meta.timeoutMs, 12000);
    assert.equal(h.requests()[1].meta.priority, 'background');
    assert.equal(h.requests()[2].meta.timeoutMs, 30000);
    assert.equal(h.requests()[2].meta.settlementTimeoutMs, 120000);
    assert.equal(h.requests()[2].meta.deadline, h.now() + 30000);
    h.reply(h.requests()[0], { error: '远端字符串错误', errorCode: 'BUSY', stage: 'remote_queue', retryAfterMs: 42, sent: false, resultState: 'not_sent' });
    const error = (await a).error;
    assert.equal(error.message, '远端字符串错误');
    assert.equal(error.errorCode, 'BUSY');
    assert.equal(error.stage, 'remote_queue');
    assert.equal(error.retryAfterMs, 42);
    assert.equal(error.sent, false);
    assert.equal(error.resultState, 'not_sent');
    h.reply(h.requests()[1], { error: '未知结果', meta: { errorCode: 77, stage: 'response', sent: true, outcomeUnknown: true, retryable: false } });
    const unknownError = (await b).error;
    assert.equal(unknownError.errorCode, 77);
    assert.equal(unknownError.resultState, 'unknown');
    assert.equal(unknownError.outcomeUnknown, true);
    assert.equal(unknownError.retryable, false);
    h.sent(h.requests()[2]);
    await h.tick(124999);
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    await h.tick(1);
    assert.equal((await c).error.resultState, 'unknown');
    await h.clean();
});

test('gateway: detach/socket close reject 全部 pending+queued，不隐式创建 IPC，旧 data/close 隔离', async () => {
    for (const detach of [true, false]) {
        const h = harness();
        const oldSocket = h.sockets[0];
        const jobs = Array.from({ length: 9 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        const read = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        const oldRequest = h.requests()[0];
        if (detach) h.api.detach();
        else oldSocket.destroy();
        await Promise.all([...jobs, read]);
        await flush();
        assert.equal(h.api.getDiagnosticSnapshot().queue.active, 0);
        assert.equal(h.api.getDiagnosticSnapshot().queue.queued, 0);
        await assert.rejects(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        assert.equal(h.sockets.length, 1);
        const epoch = h.api.getDiagnosticSnapshot().connectionEpoch;
        h.login('99');
        assert.ok(h.api.getDiagnosticSnapshot().connectionEpoch > epoch);
        const current = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        h.frame({ t: 'login', accountId: '99', userState: { gid: 999, name: '旧用户' } }, oldSocket);
        oldSocket.emit('data', '{"t":"login",');
        h.frame({ t: 'response', accountId: '99', seq: oldRequest.seq, body: 'b2s=' }, oldSocket);
        oldSocket.emit('close');
        h.frame({ t: 'login', accountId: 'other', userState: { gid: 123, name: '串号' } });
        h.frame({ t: 'event', accountId: 'other', name: 'disconnect' });
        h.frame({ t: 'response', accountId: 'other', seq: h.requests().at(-1).seq, body: 'b2s=' });
        assert.equal(h.api.getUserState().gid, 1);
        assert.equal(h.api.isConnected(), true);
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
        h.reply(h.requests().at(-1));
        assert.ok((await current).value);
        await h.clean();
    }
});

test('gateway: 新登录 generation 和 game_dead 清理旧请求/队列/read flights', async () => {
    const h = harness();
    const old = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    const epoch = h.api.getDiagnosticSnapshot().connectionEpoch;
    h.frame({ t: 'login', accountId: '99', generation: 2, userState: { gid: 1 } });
    assert.ok((await old).error);
    assert.ok(h.api.getDiagnosticSnapshot().connectionEpoch > epoch);
    const newer = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    h.frame({ t: 'response', accountId: '99', generation: 1, seq: h.requests().at(-1).seq, body: 'b2s=' });
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    h.frame({ t: 'event', accountId: '99', generation: 2, name: 'game_dead' });
    assert.ok((await newer).error);
    await h.clean();
});

test('gateway/direct: shared read deadline 已过但 timer 未执行，出队仍不得实际发送', async () => {
    for (const direct of [false, true]) {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        await flush();
        const read = capture(h.priority.runWithRequestContext({ deadline: h.now() + 10 }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
        await flush();
        h.elapse(11);
        h.reply(h.requests()[0]);
        await flush();
        assert.ok((await read).error);
        assert.equal(h.requests().length, 8);
        await h.clean();
        await Promise.all(jobs);
    }
});

test('gateway: flight 启动微任务前切换账号/epoch，旧读不能发往新会话', async () => {
    const h = harness();
    const old = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    h.login('100');
    assert.ok((await old).error);
    assert.equal(h.requests().length, 0);
    assert.equal(h.api.getUserState().name, '100');
    await h.clean();
});

test('direct: 加密中 queued deadline/退避/换 socket 复核，无过期 send', async () => {
    for (const action of ['expire', 'backoff', 'socket']) {
        const h = harness(true);
        let unlock;
        h.deferEncryption(bytes => new Promise(resolve => { unlock = () => resolve(bytes); }));
        const job = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG, 10));
        await flush();
        if (action === 'expire') await h.tick(11);
        if (action === 'backoff') h.api.setHealthBackoff(5000, '加密中退避');
        if (action === 'socket') h.api.stopNetwork('切换 socket');
        unlock();
        await flush();
        assert.ok((await job).error);
        assert.equal(h.requests().length, 0);
        await h.clean();
    }
});

test('direct: 加密期间撤销好友写入许可，套接字不发送', async () => {
    const h = harness(true);
    let unlock;
    let allowed = true;
    h.deferEncryption(bytes => new Promise(resolve => { unlock = () => resolve(bytes); }));
    const job = capture(h.api.sendMsgAsync('gamepb.animalpb.RanchService', 'PutHazard', BAG, {
        assertCanSend() {
            if (!allowed) throw h.priority.requestError('名单已变更', { errorCode: 'RANCH_FRIEND_ACTION_DISABLED' });
        },
    }));
    await flush();
    assert.equal(typeof unlock, 'function');
    allowed = false;
    unlock();
    assert.equal((await job).error.resultState, 'not_sent');
    assert.equal(h.requests().length, 0);
    await h.clean();
});

test('ALS: context 与 priority 双向嵌套合并不丢 signal/deadline', async () => {
    const h = harness();
    const signal = new AbortController().signal;
    await h.priority.runWithRequestContext({ signal, deadline: 12345 }, () =>
        h.priority.runWithRequestPriority('background', async () => {
            await Promise.resolve();
            assert.equal(h.priority.getRequestContext().signal, signal);
            assert.equal(h.priority.getRequestContext().deadline, 12345);
            assert.equal(h.priority.getRequestPriority(), 'background');
        }));
    h.priority.runWithRequestPriority('farm', () => h.priority.runWithRequestContext({ signal }, () => {
        assert.equal(h.priority.getRequestPriority(), 'farm');
        assert.equal(h.priority.getRequestContext().signal, signal);
    }));
    await h.clean();
});

test('gateway: 同一 IPC 的新登录时积压队列全部清理，旧 response 不匹配新 pending', async () => {
    const h = harness();
    const jobs = Array.from({ length: 9 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
    await flush();
    const oldRequest = h.requests()[0];
    h.frame({ t: 'login', accountId: '99', generation: 2, userState: { gid: 1 } });
    await Promise.all(jobs);
    const current = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    h.reply(oldRequest);
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    assert.equal(h.requests().length, 9);
    h.reply(h.requests().at(-1));
    await current;
    await h.clean();
});

test('gateway: 只读共享 map/waiters 有界，diagnostic 不发送 RPC 且快照独立', async () => {
    const h = harness();
    const jobs = Array.from({ length: 100 }, () => capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    await flush();
    const overflow = await capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    assert.equal(overflow.error.errorCode, 'READ_FLIGHTS_FULL');
    assert.equal(h.requests().length, 1);
    const snapshot = h.api.getDiagnosticSnapshot();
    snapshot.queue.metrics.acquired = 999;
    snapshot.reads.metrics.shared = 999;
    assert.equal(h.api.getDiagnosticSnapshot().queue.metrics.acquired, 1);
    assert.equal(h.api.getDiagnosticSnapshot().reads.metrics.shared, 99);
    assert.equal(h.requests().length, 1);
    h.reply(h.requests()[0]);
    await Promise.all(jobs);
    await h.clean();
});

test('gate: 旧 acquire(priority) 兼容，close 清 timer/listener，release 一次且容量有界', async () => {
    const h = harness();
    const gate = h.priority.createRequestGate({ maxActive: 1, maxQueued: 1 });
    const release = await gate.acquire('farm');
    const queued = capture(gate.acquire('background', { deadline: h.now() + 100 }));
    await assert.rejects(gate.acquire('farm'), /已满/);
    gate.close();
    assert.ok((await queued).error);
    release();
    release();
    assert.equal(gate.snapshot().active, 0);
    assert.equal(gate.snapshot().metrics.released, 1);
    await assert.rejects(gate.acquire('critical'), /关闭/);
    const bounded = h.priority.createRequestGate({ maxActive: 1000, maxCritical: 1000, maxQueued: 1000 });
    assert.equal(bounded.snapshot().maxActive, 8);
    assert.equal(bounded.snapshot().maxCritical, 1);
    assert.equal(bounded.snapshot().maxQueued, 100);
    await h.clean();
});

test('gateway/direct: 每个 shared read waiter 独立 Buffer 与深层 plain meta', async () => {
    for (const direct of [false, true]) {
        const h = harness(direct);
        const first = h.api.sendMsgAsync(ITEM, 'Bag', BAG).then(value => {
            value.body[0] = 0;
            value.meta.nested.rows[0].label = '被修改';
            value.meta.nested.rows.push({ label: '新增' });
            return value;
        });
        const second = h.api.sendMsgAsync(ITEM, 'Bag', BAG);
        await flush();
        h.reply(h.requests()[0], { body: direct ? Buffer.from('ok') : 'b2s=', meta: { nested: { rows: [{ label: '原始' }] } } });
        const [a, b] = await Promise.all([first, second]);
        assert.ok(Buffer.isBuffer(a.body));
        assert.ok(Buffer.isBuffer(b.body));
        assert.notEqual(a.body, b.body);
        assert.equal(b.body.toString(), 'ok');
        assert.notEqual(a.meta, b.meta);
        assert.equal(b.meta.nested.rows[0].label, '原始');
        assert.equal(b.meta.nested.rows.length, 1);
        assert.equal(b.resultState, 'completed');
        await h.clean();
    }
});

test('flights: 同 context 多订阅者独立身份，单个 settle 不删除其他 waiter', async () => {
    const h = harness();
    const flights = h.priority.createSafeReadFlights();
    const context = { deadline: h.now() + 100, timeoutMs: 200 };
    let hooks;
    let settle;
    let calls = 0;
    const input = { accountId: '99', epoch: 1, service: ITEM, method: 'Bag', body: BAG, context,
        execute(value) { hooks = value; calls++; return new Promise(resolve => { settle = resolve; }); } };
    const first = capture(flights.run(input));
    const second = capture(flights.run(input));
    await flush();
    const due = [...h.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    h.timers.delete(due[0]);
    due[1].fn();
    assert.ok((await first).error);
    assert.equal(flights.snapshot().waiters, 1);
    assert.doesNotThrow(hooks.validateWaiters);
    hooks.markSent();
    settle({ body: Buffer.from('ok'), meta: { nested: { n: 1 } } });
    assert.ok((await second).value);
    await flush();
    assert.equal(calls, 1);
    assert.equal(flights.snapshot().inFlight, 0);
    await h.clean();
});

test('gateway: 首次 flight deadline 固定，后续更长 waiter 不能延长寿命', async () => {
    const h = harness();
    const first = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG, 50));
    await flush();
    await h.tick(20);
    const later = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG, 15000));
    await flush();
    assert.equal(h.requests().length, 1);
    await h.tick(30);
    assert.ok((await first).error);
    const error = (await later).error;
    assert.equal(error.errorCode, 'REQUEST_TIMEOUT');
    assert.equal(error.resultState, 'failed');
    assert.equal(h.api.getDiagnosticSnapshot().pending, 0);
    await h.clean();
});

test('gateway: IPC request/cancel 带 remote epoch，最后 waiter 才 cancel 并留 pending 到 settle', async () => {
    const h = harness();
    h.frame({ t: 'login', accountId: '99', connectionEpoch: 41, userState: { gid: 1 } });
    const aController = new AbortController();
    const bController = new AbortController();
    const a = capture(h.priority.runWithRequestContext({ signal: aController.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    const b = capture(h.priority.runWithRequestContext({ signal: bController.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    await flush();
    const request = h.requests()[0];
    assert.equal(request.connectionEpoch, 41);
    assert.equal(Object.hasOwn(request, 'readOnly'), false);
    const cancels = () => h.sockets.at(-1).frames.filter(frame => frame.t === 'cancel');
    aController.abort();
    await a;
    assert.equal(cancels().length, 0);
    bController.abort();
    await b;
    assert.equal(cancels().length, 1);
    assert.deepEqual(cancels()[0], { t: 'cancel', accountId: '99', seq: request.seq, connectionEpoch: 41 });
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    assert.equal(h.api.getDiagnosticSnapshot().queue.active, 1);
    assert.equal(h.api.getDiagnosticSnapshot().reads.inFlight, 1);
    h.reply(request, { connectionEpoch: 40 });
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1, '旧 remote epoch 响应拒收');
    h.reply(request, { connectionEpoch: 41, error: '未发送读已取消', meta: { sent: false, errorCode: 'CANCELLED', retryable: false } });
    await flush();
    assert.equal(h.api.getDiagnosticSnapshot().pending, 0);
    const writeController = new AbortController();
    const write = capture(h.priority.runWithRequestContext({ signal: writeController.signal }, () => h.api.sendMsgAsync(PLANT, 'Harvest', BAG)));
    await flush();
    writeController.abort();
    assert.equal(cancels().length, 1, '写绝不发送 cancel');
    h.reply(h.requests().at(-1), { connectionEpoch: 41 });
    assert.ok((await write).value);
    h.api.setHealthBackoff(5000, '退避');
    h.api.stop('99');
    assert.equal(h.sockets.at(-1).frames.filter(frame => frame.t === 'stop').length, 1);
    assert.equal(h.sockets.length, 1, '显式 stop 保留且不自动 new IPC');
    await h.clean();
});

test('gateway: 已 cancel 的无 waiter flight 不供新订阅共享，旧 cancel 响应不影响新读', async () => {
    const h = harness();
    const controller = new AbortController();
    const old = capture(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    await flush();
    const firstRequest = h.requests()[0];
    controller.abort();
    await old;
    const fresh = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    assert.equal(h.requests().length, 2);
    assert.equal(h.api.getDiagnosticSnapshot().queue.active, 2);
    h.reply(firstRequest, { error: '取消确认', meta: { sent: false, retryable: false } });
    await flush();
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    h.reply(h.requests()[1]);
    assert.ok((await fresh).value);
    await h.clean();
});

test('gateway: 所有 waiter deadline 到期后发送一次 read cancel，无新 probe/timer', async () => {
    const h = harness();
    const read = capture(h.priority.runWithRequestContext({ deadline: h.now() + 10 }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    await flush();
    await h.tick(10);
    const error = (await read).error;
    assert.equal(error.errorCode, 'REQUEST_DEADLINE');
    assert.equal(error.sent, true);
    assert.equal(error.resultState, 'failed');
    assert.equal(h.sockets.at(-1).frames.filter(frame => frame.t === 'cancel').length, 1);
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    assert.equal(h.timers.size, 1, '仅原 transport timeout 保留');
    h.reply(h.requests()[0], { error: '取消', meta: { sent: false, outcomeUnknown: false } });
    await h.clean();
});

test('gateway: remote metadata 归一化且发送 catch 保留 structured details', async () => {
    const h = harness();
    for (const [method, meta, expected] of [
        ['Harvest', { errorCode: 'QUEUE', stage: 'queue', sent: false, outcomeUnknown: false, retryable: true, retryAfterMs: 15 }, 'not_sent'],
        ['Harvest', { errorCode: 'DEAD', stage: 'transport', sent: true, outcomeUnknown: true, retryable: false }, 'unknown'],
        ['Harvest', { errorCode: 77, stage: 'remote', sent: true, outcomeUnknown: false, retryable: false }, 'failed'],
        ['Bag', { errorCode: 'TIMEOUT', stage: 'transport', sent: true, outcomeUnknown: true, retryable: false }, 'failed'],
    ]) {
        const job = capture(h.api.sendMsgAsync(method === 'Bag' ? ITEM : PLANT, method, BAG));
        await flush();
        h.reply(h.requests().at(-1), { error: '保持字符串错误', meta });
        const error = (await job).error;
        assert.equal(error.message, '保持字符串错误');
        assert.equal(error.resultState, expected);
        for (const key of Object.keys(meta)) assert.equal(error[key], meta[key]);
    }
    const details = { errorCode: 'STRUCTURED', stage: 'send', retryAfterMs: 31, sent: false, outcomeUnknown: false, retryable: true };
    h.sockets.at(-1).writeError = h.priority.requestError('结构化发送失败', details);
    const error = (await capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG))).error;
    for (const key of Object.keys(details)) assert.equal(error[key], details[key]);
    assert.equal(error.resultState, 'not_sent');
    h.sockets.at(-1).writeError = null;
    await h.clean();
});

test('gateway/direct: invalid service 和已删除 GetShopInfo 均按写，不共享不 cancel', async () => {
    for (const direct of [false, true]) {
        const h = harness(direct);
        for (const [service, method] of [['other.ItemService', 'Bag'], ['gamepb.shoppb.ShopService', 'GetShopInfo']]) {
            const controller = new AbortController();
            const before = h.requests().length;
            const a = capture(h.priority.runWithRequestContext({ signal: controller.signal }, () => h.api.sendMsgAsync(service, method, BAG)));
            const b = capture(h.api.sendMsgAsync(service, method, BAG));
            await flush();
            assert.equal(h.requests().length - before, 2);
            controller.abort();
            assert.equal(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.t === 'cancel').length, 0);
            h.reply(h.requests()[before]);
            h.reply(h.requests()[before + 1]);
            assert.ok((await a).value);
            assert.ok((await b).value);
        }
        await h.clean();
    }
});

test('gate: 不依赖 setHealthBackoff 清队列，drain validate 仍拒绝退避业务', async () => {
    const h = harness();
    const gate = h.priority.createRequestGate({ maxActive: 1 });
    const release = await gate.acquire('foreground');
    let degraded = false;
    const queued = capture(gate.acquire('foreground', { validate() {
        if (degraded) throw h.priority.requestError('出队复核退避', { errorCode: 'HEALTH_BACKOFF', retryAfterMs: 42, stage: 'queue' });
    } }));
    degraded = true;
    release();
    const error = (await queued).error;
    assert.equal(error.errorCode, 'HEALTH_BACKOFF');
    assert.equal(error.retryAfterMs, 42);
    assert.equal(gate.snapshot().active, 0);
    assert.equal(gate.snapshot().queued, 0);
    await h.clean();
});

test('gateway: 同 epoch dead 暂停业务保留身份/在途写，可信恢复不触发 onReady', async () => {
    const h = harness();
    let ready = 0;
    h.gc.connect('99', '', () => { ready++; }, { resumeSession: true });
    h.frame({ t: 'login', accountId: '99', connectionEpoch: 10, userState: { gid: 1 } });
    const write = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
    await flush();
    const epoch = h.api.getDiagnosticSnapshot().connectionEpoch;
    const requests = h.requests().length;
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 10, name: 'connection_dead' });
    const snapshot = h.api.getDiagnosticSnapshot();
    assert.equal(snapshot.loggedIn, true);
    assert.equal(snapshot.businessSuspended, true);
    assert.equal(snapshot.connectionEpoch, epoch);
    assert.equal(snapshot.pending, 1);
    assert.equal(h.api.isConnected(), false);
    h.frame({ t: 'login', accountId: '99', connectionEpoch: 10, userState: { gid: 1 } });
    assert.equal(ready, 1, '同 epoch 重复登录不得重新初始化或绕过 suspended');
    assert.equal(h.api.isConnected(), false);
    await assert.rejects(h.api.sendMsgAsync(ITEM, 'Bag', BAG), error => error.errorCode === 'CONNECTION_SUSPENDED');
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 10, name: 'connection_recovered', payload: { businessHealthy: false } });
    assert.equal(h.api.isConnected(), false);
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 9, name: 'connection_recovered', payload: { linkRecovered: true } });
    assert.equal(h.api.isConnected(), false);
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 10, name: 'connection_recovered', payload: { linkRecovered: true, businessHealthy: false } });
    assert.equal(h.api.isConnected(), true);
    assert.equal(ready, 1, '恢复不重新初始化登录');
    const read = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    assert.equal(h.requests().length, requests + 1);
    h.reply(h.requests().at(-1), { connectionEpoch: 10 });
    await read;
    h.reply(h.requests()[0], { connectionEpoch: 10 });
    assert.ok((await write).value);
    await h.clean();
});

test('gateway: businessHealthy=false 恢复不清退避，自然到期后允许正常业务而不 probe', async () => {
    const h = harness();
    h.api.setHealthBackoff(100, '业务退避');
    const count = h.requests().length;
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 1, name: 'connection_recovered', payload: { linkRecovered: true, businessHealthy: false } });
    assert.equal(h.api.getHealthBackoffState().active, true);
    await assert.rejects(h.api.sendMsgAsync(ITEM, 'Bag', BAG), error => error.errorCode === 'HEALTH_BACKOFF');
    assert.equal(h.requests().length, count);
    await h.tick(100);
    const read = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    h.reply(h.requests().at(-1));
    assert.ok((await read).value);
    h.api.setHealthBackoff(10000, '第二次退避');
    h.frame({ t: 'event', accountId: '99', connectionEpoch: 1, name: 'connection_recovered', payload: { businessHealthy: true } });
    assert.equal(h.api.getHealthBackoffState().active, false);
    await h.clean();
});

test('gateway: 当前 bound IPC 的 higher epoch terminal 生效，旧 response/recovery 拒收', async () => {
    for (const name of ['disconnect', 'connection_dead', 'game_dead', 'login_error']) {
        const h = harness();
        const jobs = Array.from({ length: 9 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
        await flush();
        const first = h.requests()[0];
        let events = 0;
        h.api.networkEvents.on(name, () => { events++; });
        const epoch = h.api.getDiagnosticSnapshot().connectionEpoch;
        h.frame({ t: 'event', accountId: 'other', connectionEpoch: 2, name });
        assert.equal(events, 0);
        h.frame({ t: 'event', accountId: '99', connectionEpoch: 0, name });
        assert.equal(events, 0);
        h.frame({ t: 'event', accountId: '99', connectionEpoch: 2, name });
        await Promise.all(jobs);
        assert.equal(events, 1);
        assert.equal(h.api.getDiagnosticSnapshot().loggedIn, false);
        assert.ok(h.api.getDiagnosticSnapshot().connectionEpoch > epoch);
        assert.equal(h.api.getDiagnosticSnapshot().remoteGeneration, 2);
        assert.equal(h.api.getDiagnosticSnapshot().queue.queued, 0);
        h.frame({ t: 'event', accountId: '99', connectionEpoch: 1, name: 'connection_recovered', payload: { linkRecovered: true, businessHealthy: true } });
        assert.equal(h.api.isConnected(), false);
        h.frame({ t: 'login', accountId: '99', connectionEpoch: 3, userState: { gid: 1 } });
        const fresh = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        h.reply(first, { connectionEpoch: 1 });
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
        h.reply(h.requests().at(-1), { connectionEpoch: 3 });
        await fresh;
        await h.clean();
    }
});

test('gateway/direct: 已发送写越过 HTTP deadline/cancel 仍接受真实回包', async () => {
    for (const direct of [false, true]) {
        const h = harness(direct);
        const controller = new AbortController();
        const write = capture(h.priority.runWithRequestContext({ signal: controller.signal, deadline: h.now() + 10 }, () => h.api.sendMsgAsync(PLANT, 'Harvest', BAG, 6000)));
        await flush();
        if (!direct) {
            assert.equal(h.requests()[0].meta.timeoutMs, 6000);
            assert.equal(h.requests()[0].meta.deadline, h.now() + 10);
            assert.equal(h.requests()[0].meta.settlementTimeoutMs, 120000);
            h.sent(h.requests()[0]);
        }
        controller.abort();
        await h.tick(20000);
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
        assert.equal(h.api.getRequestQueueSnapshot().active, 1);
        h.reply(h.requests()[0]);
        assert.equal((await write).value.resultState, 'completed');
        await h.clean();
    }
});

test('gateway: nonfinal timeout progress 保留写槽和原租约，接收 late actual final', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
    const progress = [];
    h.api.networkEvents.on('request_progress', frame => progress.push(frame));
    await flush();
    const request = h.requests()[0];
    h.sent(request);
    await h.tick(30000);
    h.reply(request, { error: '网关写超时，结果未知', settled: false,
        meta: { errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, outcomeUnknown: true, retryable: false } });
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    assert.equal(h.api.getRequestQueueSnapshot().active, 1);
    assert.equal(progress[0].error, '网关写超时，结果未知');
    assert.equal(progress[0].meta.resultState, 'unknown');
    await h.tick(40000);
    h.reply(request);
    assert.equal((await write).value.resultState, 'completed');
    assert.equal(h.requests().length, 1, '无重试重放');
    await h.clean();
});

test('gateway/direct: actual send 写租约120s 加5s余量固定有界，重复 progress 不续租', async () => {
    for (const direct of [false, true]) {
        const h = harness(direct);
        const write = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
        await flush();
        if (!direct) h.sent(h.requests()[0]);
        await h.tick(60000);
        if (!direct) h.reply(h.requests()[0], { error: '未知', meta: { settled: false, sent: true, outcomeUnknown: true } });
        await h.tick(64999);
        if (!direct) h.reply(h.requests()[0], { error: '仍未知', settled: false, meta: { sent: true, outcomeUnknown: true } });
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
        await h.tick(1);
        assert.equal((await write).error.resultState, 'unknown');
        assert.equal(h.api.getRequestQueueSnapshot().active, 0);
        assert.equal(h.api.getRequestQueueSnapshot().metrics.released, 1);
        await h.clean();
    }
});

test('gateway: 8 个 nonfinal 写保留槽位，第9个仅在真实结算释放后发送', async () => {
    const h = harness();
    const jobs = Array.from({ length: 8 }, (_, i) => capture(h.api.sendMsgAsync(PLANT, 'Harvest', Buffer.from([i]))));
    await flush();
    const ninth = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
    await flush();
    for (const request of h.requests()) h.reply(request, { error: '未知', settled: false, meta: { sent: true, outcomeUnknown: true } });
    assert.equal(h.api.getRequestQueueSnapshot().active, 8);
    assert.equal(h.api.getRequestQueueSnapshot().queued, 1);
    assert.equal(h.requests().length, 8);
    h.reply(h.requests()[0]);
    await flush();
    assert.equal(h.requests().length, 9);
    assert.equal(h.api.getRequestQueueSnapshot().active, 8);
    assert.equal(h.api.getRequestQueueSnapshot().queued, 0);
    await h.clean();
    await Promise.all([...jobs, ninth]);
});

test('options: 超长 numeric timeout 有界且与 HTTP deadline 分离', async () => {
    const h = harness();
    h.priority.runWithRequestContext({ deadline: h.now() + 10 }, () => {
        const options = h.priority.getRequestOptions(999999, 60000, 30000);
        assert.equal(options.deadline, h.now() + 10);
        assert.equal(options.wireTimeoutMs, 60000);
        assert.equal(options.timeoutMs, 60000);
        assert.equal(options.settlementTimeoutMs, 120000);
    });
    await h.clean();
});

test('gateway: 旧网关30s普通超时是 final，不能声称保留了晚回包', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(PLANT, 'Harvest', BAG));
    await flush();
    const request = h.requests()[0];
    assert.equal(request.meta.timeoutMs, 30000);
    await h.tick(30000);
    h.reply(request, { error: '网关默认写超时', meta: { sent: true, outcomeUnknown: true, retryable: false } });
    assert.equal((await write).error.resultState, 'unknown');
    assert.equal(h.api.getDiagnosticSnapshot().pending, 0);
    h.reply(request);
    assert.equal(h.api.getDiagnosticSnapshot().pending, 0);
    await h.clean();
});

test('gateway: 延迟出队 actual send 后114s late final 不受IPC起点120s截断', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
    await flush();
    const request = h.requests()[0];
    assert.equal(h.api.getDiagnosticSnapshot().actualSent, 0);
    await h.tick(29000);
    h.sent(request);
    const snapshot = h.api.getDiagnosticSnapshot();
    assert.equal(snapshot.pendingWrites, 1);
    assert.equal(snapshot.pendingActualWrites, 1);
    assert.equal(snapshot.deadlines[0].sentAt, h.now());
    assert.equal(snapshot.deadlines[0].timeoutDeadline, h.now() + 125000);
    await h.tick(114000);
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1);
    h.reply(request);
    assert.equal((await write).value.resultState, 'completed');
    await h.clean();
});

test('gateway: actual acknowledgement 仅当前socket/account/epoch/seq接受且重复不续租', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
    await flush();
    const request = h.requests()[0];
    for (const patch of [{ accountId: 'other' }, { seq: request.seq + 10 }, { connectionEpoch: 0 },
        { settlementDeadline: NaN }, { sentAt: h.now() + 20, settlementDeadline: h.now() }]) {
        h.sent(request, patch);
        assert.equal(h.api.getDiagnosticSnapshot().actualSent, 0);
    }
    h.sent(request, { settlementDeadline: h.now() + 999999, readOnly: true });
    assert.equal(h.api.getDiagnosticSnapshot().pendingActualWrites, 1, 'readOnly 不能覆盖本地分类');
    const deadline = h.api.getDiagnosticSnapshot().deadlines[0].timeoutDeadline;
    await h.tick(1000);
    h.sent(request);
    assert.equal(h.api.getDiagnosticSnapshot().deadlines[0].timeoutDeadline, deadline);
    h.reply(request);
    await write;
    await h.clean();
});

test('gateway: 未确认sent的IPC写在队列deadline加5s后unknown，actual read不延长subscriber', async () => {
    const h = harness();
    const write = capture(h.priority.runWithRequestContext({ deadline: h.now() + 10 }, () => h.api.sendMsgAsync(ITEM, 'Sell', BAG)));
    await flush();
    await h.tick(5009);
    assert.equal(h.api.getPendingWriteCount(), 1);
    await h.tick(1);
    assert.equal((await write).error.resultState, 'unknown');
    const read = capture(h.priority.runWithRequestContext({ deadline: h.now() + 10 }, () => h.api.sendMsgAsync(ITEM, 'Bag', BAG)));
    await flush();
    h.sent(h.requests().at(-1), { readOnly: true });
    await h.tick(10);
    assert.equal((await read).error.resultState, 'failed');
    assert.equal(h.api.getDiagnosticSnapshot().pending, 1, 'wire read仍有界等待真实响应');
    h.reply(h.requests().at(-1));
    await h.clean();
});

for (const direct of [false, true]) {
    test(`${direct ? 'direct' : 'gateway'}: quiesce覆盖background Sell、拒新业务/排队写，HB不阻塞drain`, async () => {
        const h = harness(direct);
        const jobs = Array.from({ length: 8 }, (_, i) => capture(h.priority.runWithRequestPriority('background', () =>
            h.api.sendMsgAsync(ITEM, 'Sell', Buffer.from([i])))));
        const ninth = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
        const queuedRead = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
        await flush();
        if (!direct) for (const request of h.requests()) h.sent(request);
        assert.equal(h.api.getPendingWriteCount(), 8);
        let drained = false;
        const drain = h.api.quiesceAndDrain().then(result => { drained = true; return result; });
        assert.equal((await ninth).error.errorCode, 'TRANSPORT_QUIESCING');
        assert.ok((await queuedRead).error);
        await assert.rejects(h.api.sendMsgAsync(ITEM, 'Sell', BAG), error => error.errorCode === 'TRANSPORT_QUIESCING');
        await assert.rejects(h.api.sendMsgAsync(USER, 'Login', BAG), error => error.errorCode === 'TRANSPORT_QUIESCING');
        assert.equal(h.api.getDiagnosticSnapshot().quiescing, true);
        const heartbeat = capture(h.api.sendMsgAsync(USER, 'Heartbeat', BAG));
        await flush();
        assert.equal(h.requests().length, 9);
        assert.equal(drained, false);
        for (const request of h.requests().slice(0, 7)) h.reply(request);
        await flush();
        assert.equal(drained, false);
        h.reply(h.requests()[7]);
        const result = await drain;
        assert.equal(result.drained, true);
        assert.equal(result.pendingWrites, 0);
        assert.equal(h.api.getPendingWriteCount(), 0);
        assert.equal(h.api.getDiagnosticSnapshot().pending, 1, 'HB不计入业务写排空');
        h.reply(h.requests()[8]);
        await heartbeat;
        await Promise.all(jobs);
        await h.clean();
    });
}

test('gateway: quiesce读取cancel、不打断actual写；timeout返回未排空不detach，重复调用共用timer', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
    const read = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    await flush();
    h.sent(h.requests()[0]);
    const first = h.api.quiesceAndDrain({ timeoutMs: 20 });
    const timerCount = h.timers.size;
    const second = h.api.quiesceAndDrain({ timeoutMs: 999999 });
    assert.equal(first, second);
    assert.equal(h.timers.size, timerCount);
    assert.equal(h.sockets.at(-1).frames.filter(frame => frame.t === 'cancel').length, 1);
    await h.tick(20);
    assert.equal((await first).drained, false);
    assert.equal(h.api.getPendingWriteCount(), 1);
    assert.equal(h.api.isConnected(), true);
    const retryDrain = h.api.quiesceAndDrain();
    h.reply(h.requests()[0]);
    assert.equal((await retryDrain).drained, true);
    await write;
    h.reply(h.requests()[1], { error: '读取消确认', meta: { sent: false } });
    await read;
    await h.clean();
});

test('gateway: flight微任务尚未入队时quiesce也取消，不创建RPC或孤儿timer', async () => {
    const h = harness();
    const read = capture(h.api.sendMsgAsync(ITEM, 'Bag', BAG));
    const result = await h.api.quiesceAndDrain();
    assert.equal(result.drained, true);
    assert.ok((await read).error);
    assert.equal(h.requests().length, 0);
    await h.clean();
});

test('gateway: 默认写队列期限30s加IPC5s，无ack不能无界等待且quiesce自动完成', async () => {
    const h = harness();
    const write = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
    await flush();
    assert.equal(h.requests()[0].meta.deadline, h.now() + 30000);
    const drain = h.api.quiesceAndDrain();
    await h.tick(34999);
    assert.equal(h.api.getPendingWriteCount(), 1);
    await h.tick(1);
    assert.equal((await write).error.resultState, 'unknown');
    assert.equal((await drain).drained, true);
    await h.clean();
});

test('direct: 旧callback无分类时保守计入drain，不轮询，raw发送不能绕过quiesce', async () => {
    const h = harness(true);
    const legacy = new Promise(resolve => h.api.sendMsg(ITEM, 'Sell', BAG, () => resolve()));
    await flush();
    assert.equal(h.api.getPendingWriteCount(), 1);
    const drain = h.api.quiesceAndDrain({ timeoutMs: 50 });
    await assert.rejects(h.api.sendMsg(ITEM, 'Sell', BAG), error => error.errorCode === 'TRANSPORT_QUIESCING');
    h.reply(h.requests()[0]);
    await legacy;
    assert.equal((await drain).drained, true);
    await h.clean();
});

test('direct: quiesce取消加密中的未发写，等待回调清理后drain完成', async () => {
    const h = harness(true);
    let unlock;
    h.deferEncryption(bytes => new Promise(resolve => { unlock = () => resolve(bytes); }));
    const write = capture(h.api.sendMsgAsync(ITEM, 'Sell', BAG));
    await flush();
    const drain = h.api.quiesceAndDrain();
    unlock();
    assert.equal((await write).error.resultState, 'not_sent');
    assert.equal((await drain).drained, true);
    assert.equal(h.requests().length, 0);
    await h.clean();
});

test('raw 精确白名单可核，不匹配 service 或 Get 前缀绝不共享', async () => {
    const h = harness();
    const expected = [
        [ITEM, 'Bag'], [PLANT, 'AllLands'], ['gamepb.dogpb.DogService', 'GetDogInfo'],
        ['gamepb.careerpb.CareerService', 'CareerInfoGet'], ['gamepb.activitypb.ActivityService', 'GetGroup'],
        ['gamepb.shoppb.ShopService', 'ShopInfo'],
        ['gamepb.shoppb.ShopService', 'ShopProfiles'],
        ['gamepb.mallpb.MallService', 'GetMallListBySlotType'],
        ['gamepb.homesteadpb.HomesteadService', 'AllCells'],
        ['gamepb.animalpb.AnimalService', 'GetRanchDetail'],
        ['gamepb.animalpb.RanchService', 'GetRanchOpTimes'],
        ['gamepb.itempb.ItemService', 'GetBag'],
        ['gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail'],
        ['gamepb.paypb.PayService', 'GetRechargeInfo'],
        ['gamepb.taskpb.TaskService', 'TaskInfo'],
        ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedListV2'],
        ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedLevelListV2'],
        ['gamepb.illustratedpb.IllustratedService', 'GetRanchWeightScoreV2'],
        ['gamepb.userpb.UserService', 'BatchGetBasicInfo'],
        ['gamepb.sharepb.ShareService', 'CheckCanShare'],
        ['gamepb.shoppb.ShopService', 'RotationShopInfo'],
        ['gamepb.activitypb.ActivityService', 'List'],
    ];
    assert.equal(JSON.stringify(h.priority.SAFE_READ_METHODS), JSON.stringify(expected));
    for (const [service, method] of expected) assert.equal(h.priority.isSafeReadRequest(service, method), true);
    assert.equal(h.priority.isSafeReadRequest(ITEM, 'GetUnknown'), false);
    assert.equal(h.priority.isSafeReadRequest('other', 'Bag'), false);
    for (const [service, method] of [
        ['gamepb.taskpb.TaskService', 'BatchClaimTaskReward'],
        ['gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2'],
        ['gamepb.illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2'],
        ['gamepb.sharepb.ShareService', 'ReportShare'], ['gamepb.sharepb.ShareService', 'ClaimShareReward'],
    ]) assert.equal(h.priority.isSafeReadRequest(service, method), false, `${service}.${method} must stay a write`);
    assert.equal(h.priority.isCriticalRequest(PLANT, 'Heartbeat'), false);
    await h.clean();
});
