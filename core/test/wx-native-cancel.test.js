'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter, getEventListeners } = require('node:events');

// 只读指定源码；VM 拒绝所有未显式 mock 的模块和网络调用。
const nativeSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/native-protocol.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/service.js'), 'utf8');

async function flush() {
    for (let i = 0; i < 60; i++) await Promise.resolve();
}

function clock() {
    let now = 1700000000000;
    let nextId = 0;
    const timers = new Map();
    return {
        timers,
        now: () => now,
        setTimeout(fn, ms) {
            const id = ++nextId;
            timers.set(id, { at: now + Math.max(0, ms), fn });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        async advance(ms) {
            const until = now + ms;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) break;
                now = next[1].at;
                timers.delete(next[0]);
                next[1].fn();
                await flush();
            }
            now = until;
            await flush();
        }
    };
}

class FakeSocket extends EventEmitter {
    constructor(onWrite) {
        super();
        this.onWrite = onWrite;
        this.writes = [];
        this.destroyed = false;
        this.destroyCount = 0;
    }
    write(data, callback) {
        assert.equal(this.destroyed, false, '取消后不得向 socket 写入');
        this.writes.push(Buffer.from(data));
        if (this.onWrite) this.onWrite(this, data, callback);
        else callback();
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.destroyCount++;
        this.emit('close');
    }
}

const fakeSecret = Buffer.alloc(32, 7);
const fakePeer = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]);
// 仅完整协议模拟使用：ECDH 和 AES 用可控结果，hash/HMAC 保持真实计算。
const fakeCrypto = {
    ...crypto,
    createECDH: () => ({ generateKeys: () => fakePeer, computeSecret: () => fakeSecret }),
    createCipheriv: () => ({
        setAAD() {}, update: (data) => Buffer.from(data), final: () => Buffer.alloc(0), getAuthTag: () => Buffer.alloc(16)
    }),
    createDecipheriv: () => ({
        setAAD() {}, setAuthTag() {}, update: (data) => Buffer.from(data), final: () => Buffer.alloc(0)
    })
};

function harness({ fetchImpl, onConnection, protocolCrypto = crypto } = {}) {
    const time = clock();
    const sockets = [];
    const fetchCalls = [];
    const context = vm.createContext({
        exports: {}, Buffer, Error, AbortController,
        Date: class extends Date { static now() { return time.now(); } },
        setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
        fetch: (url, init) => {
            fetchCalls.push({ url, init });
            if (!fetchImpl) throw new Error('禁止未 mock 的 fetch');
            return fetchImpl(url, init, fetchCalls.length);
        },
        require(name) {
            if (name === 'node:crypto') return protocolCrypto;
            if (name === 'node:net') return {
                createConnection(target) {
                    const s = new FakeSocket();
                    sockets.push(s);
                    s.target = target;
                    if (onConnection) onConnection(s, target, sockets.length, context);
                    return s;
                }
            };
            throw new Error(`禁止加载模块 ${name}`);
        }
    });
    vm.runInContext(`${nativeSource}\nexports.testOnly = { socket, targets, pbl, pbv, rec, hs, short, wpkg, lz4Literal, expand, hmac, rvi, pbf, readWpkg, parseManual, manualRequest };`, context);
    const api = context.exports;
    const p = api.testOnly;
    const loginBuffer = Buffer.concat([
        p.pbl(1, Buffer.from('仅模拟 ticket')), p.pbl(2, Buffer.from('仅模拟 device'))
    ]).toString('base64');
    return { api, p, time, sockets, fetchCalls, loginBuffer, context };
}

function observe(promise) {
    const result = { settled: false };
    result.done = promise.then(
        (value) => { result.settled = true; result.value = value; },
        (error) => { result.settled = true; result.error = error; }
    );
    return result;
}

function assertClean(h, signal) {
    assert.equal(h.time.timers.size, 0, '必须清理所有 native timer');
    for (const s of h.sockets) {
        assert.equal(s.destroyed, true, '必须销毁每个创建的 socket');
        assert.equal(s.destroyCount, 1, '销毁必须幂等');
        assert.deepEqual(s.eventNames(), [], '必须移除 socket 监听');
    }
    if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0, '必须移除 abort 监听');
    for (const call of h.fetchCalls) {
        assert.equal(getEventListeners(call.init.signal, 'abort').length, 0, '内部信号不得遗留监听');
    }
}

function dnsResponse() {
    return { json: async () => ({ dns: { domainlist: [
        { name: 'longcloud.weixin.com', protocollist: [{ name: 'mmtlsovertcp', portlist: [8080] }],
            iplist: Array.from({ length: 12 }, (_, i) => ({ ip: `192.0.2.${i + 1}` })) },
        { name: 'shortcloud.weixin.com', protocollist: [{ name: 'http', portlist: [80] }],
            iplist: [{ ip: '198.51.100.1' }, { ip: '198.51.100.2' }] }
    ] } }) };
}

function abortableFetch(init) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(init.signal.reason);
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
    });
}

// 将模拟记录喂给真实 socket/take/parseManual，不替换生产函数。
function longPeer(h, s, { rejectAuth = false, holdAuth = false, plainFixture, ticketHex = '010000003c0203', afterAuth } = {}) {
    s.onWrite = (socket, wire, callback) => {
        const writeNumber = socket.writes.length;
        if (writeNumber === 1) {
            const hello = wire.subarray(5);
            const serverBody = Buffer.alloc(118);
            serverBody.writeUInt32BE(78, 36);
            serverBody[40] = 1;
            fakePeer.copy(serverBody, 53);
            const sh = h.p.hs(2, serverBody);
            const cert = h.p.hs(15, Buffer.alloc(0));
            // 手写 type=1、服务器 lifetime=60 秒及不透明 ticket 后缀。
            const ticket = Buffer.from(ticketHex, 'hex');
            const size = Buffer.alloc(4);
            size.writeUInt32BE(ticket.length);
            const tickets = h.p.hs(4, Buffer.concat([Buffer.from([1]), size, ticket]));
            const secret = crypto.createHash('sha256').update(fakeSecret).digest();
            const hash = crypto.createHash('sha256').update(Buffer.concat([hello, sh, cert, tickets])).digest();
            const verify = h.p.hmac(h.p.expand(secret, 'server finished', Buffer.alloc(0), 32), hash);
            const finish = h.p.hs(20, Buffer.concat([Buffer.from([0, 32]), verify]));
            const encrypted = (plain) => Buffer.concat([plain, Buffer.alloc(16)]);
            socket.emit('data', Buffer.concat([
                h.p.rec(22, sh), h.p.rec(22, encrypted(cert)), h.p.rec(22, encrypted(tickets)), h.p.rec(22, encrypted(finish))
            ]));
        }
        if (writeNumber === 3 && !holdAuth) {
            const fields = rejectAuth
                ? Buffer.concat([h.p.pbv(4, 7), h.p.pbl(5, Buffer.from('模拟 ManualAuth 拒绝'))])
                : Buffer.concat([
                    h.p.pbl(2, Buffer.concat([h.p.pbl(1, Buffer.alloc(16, 1)), h.p.pbl(2, Buffer.alloc(16, 2))])),
                    h.p.pbl(3, h.p.pbv(1, 123))
                ]);
            const manual = plainFixture === undefined ? h.p.pbl(3, fields) : Buffer.from(plainFixture, 'hex');
            const ciphertext = Buffer.concat([h.p.lz4Literal(manual), Buffer.alloc(28)]);
            const response = Buffer.concat([
                h.p.pbl(1, Buffer.concat([h.p.pbv(1, 415), h.p.pbl(2, fakePeer)])), h.p.pbv(2, 1), h.p.pbl(3, ciphertext)
            ]);
            const packet = h.p.short(3453, 0, Buffer.concat([h.p.wpkg({}, {}), response]));
            socket.emit('data', h.p.rec(23, Buffer.concat([packet, Buffer.alloc(16)])));
            if (afterAuth) afterAuth();
        }
        callback();
    };
}

// 手写 protobuf hex；不调用生产 protobuf/Wpkg/LZ4 编码器构造解析用例。
const manualFixtures = [
    { name: 'code0 缺 session', hex: '1a022000', state: 'zero-code-without-session' },
    { name: '未知 code 缺 session', hex: '1a032a0178', state: 'unknown-code-without-session' },
    { name: 'code 类型错误', hex: '1a022200', state: 'invalid-code-type' },
    { name: 'fixed32 code 类型错误', hex: '1a052500000000', state: 'invalid-code-type' },
    { name: 'session 类型错误', hex: '1a0420001001', state: 'missing-or-invalid-bytes' },
    { name: 'fixed32 session 不可当 bytes', hex: '1a051501020304', state: 'missing-or-invalid-bytes' },
    { name: 'empty session', hex: '1a021200', state: 'missing-or-invalid-bytes' },
    { name: 'empty identity', hex: '1a0a12060a01611201621a00', state: 'missing-or-invalid-bytes' },
    { name: '缺 identity', hex: '1a0812060a0161120162', state: 'missing-or-invalid-bytes' },
    { name: 'identity 类型错误', hex: '1a0a12060a01611201621801', state: 'missing-or-invalid-bytes' },
    { name: 'identity 缺 field1', hex: '1a0c12060a01611201621a021001', state: 'missing-or-invalid-identity' },
    { name: 'identity field1 类型错误', hex: '1a0c12060a01611201621a020a00', state: 'missing-or-invalid-identity' },
    { name: 'identity 为零', hex: '1a0c12060a01611201621a020800', state: 'missing-or-invalid-identity' },
    { name: '缺 send key', hex: '1a0912031201621a02087b', state: 'missing-or-invalid-bytes' },
    { name: '缺 recv key', hex: '1a0912030a01611a02087b', state: 'missing-or-invalid-bytes' },
    { name: 'empty send key', hex: '1a0b12050a001201621a02087b', state: 'missing-or-invalid-bytes' },
    { name: 'empty recv key', hex: '1a0b12050a016112001a02087b', state: 'missing-or-invalid-bytes' },
    { name: 'fixed32 key 不可当 bytes', hex: '1a0e12080d010203041201621a02087b', state: 'missing-or-invalid-bytes' },
    { name: '不支持的嵌套 session 不递归', hex: '1a100a0c12060a01611201621a02087b2000', state: 'zero-code-without-session' },
    { name: '完整 session 后非法 tag', hex: '1a0d12060a01611201621a02087b00', state: 'invalid-field' },
    { name: 'ManualAuth field3 截断', hex: '1a032000', state: 'invalid-field-length' },
    { name: '完整 session 后 group', hex: '1a0d12060a01611201621a02087b2b', state: 'unsupported-wire' },
    { name: '完整 session 后 fixed64 截断', hex: '1a0e12060a01611201621a02087b2901', state: 'invalid-field-length' },
    { name: '完整 session 后 fixed32 截断', hex: '1a0e12060a01611201621a02087b2d01', state: 'invalid-field-length' },
    { name: '完整 session 后超长 bytes', hex: '1a1512060a01611201621a02087b2a8080808080808010', state: 'invalid-field-length' }
];
const validManualHex = '1a0c12060a01611201621a02087b';
const fixedManualHex = '1a1a0901020304050607082d090a0b0c12060a01611201621a02087b';

function manualPacket(hex, encrypt) {
    const manual = Buffer.from(hex, 'hex');
    assert.ok(manual.length < 128);
    const compressed = Buffer.concat([
        manual.length < 15 ? Buffer.from([manual.length << 4]) : Buffer.from([0xf0, manual.length - 15]), manual
    ]);
    const ciphertext = encrypt ? encrypt(compressed) : Buffer.concat([compressed, Buffer.alloc(28)]);
    assert.ok(ciphertext.length < 128);
    return Buffer.concat([
        Buffer.from('010000040a46089f031241', 'hex'), fakePeer,
        Buffer.from([0x10, 0x01, 0x1a, ciphertext.length]), ciphertext
    ]);
}

function shortPeer(h, s, mode) {
    s.onWrite = (socket, wire, callback) => {
        assert.match(wire.toString('latin1'), /^POST \/mmtls\//, '保持原始 TCP HTTP 短链接协议');
        if (['success', 'empty', 'missing', 'nested', 'bad-protobuf'].includes(mode)) {
            const code = mode === 'success' ? h.p.pbl(2, h.p.pbl(3, Buffer.from('mock-wx-code')))
                : Buffer.from(mode === 'empty' ? '12021a00' : mode === 'missing' ? '1200'
                    : mode === 'nested' ? '12090a071a056465636f79' : '120100', 'hex');
            const appData = Buffer.concat([h.p.lz4Literal(code), Buffer.alloc(28), Buffer.alloc(16)]);
            socket.emit('data', Buffer.concat([
                Buffer.from('HTTP/1.0 200 OK\r\n\r\n'), h.p.rec(22, Buffer.from('mock-server-hello')), h.p.rec(23, appData)
            ]));
            socket.emit('end');
        }
        else if (mode !== 'hold') {
            const raw = mode === 'invalid-http' ? Buffer.from('invalid HTTP')
                : mode === 'invalid-record' ? Buffer.from('HTTP/1.0 200 OK\r\n\r\n1700000001', 'latin1')
                    : Buffer.from(`HTTP/1.0 ${mode} rejected\r\n\r\nmock-secret-server-body`);
            socket.emit('data', raw);
            socket.emit('end');
        }
        callback();
    };
}

test('rvi 手写 hex：uint64 有界、拒绝截断/超长及非法 offset', () => {
    const h = harness();
    const maximum = h.p.rvi(Buffer.from('ffffffffffffffffff01', 'hex'), 0);
    assert.equal(maximum[0], (1n << 64n) - 1n);
    assert.equal(maximum[1], 10);
    assert.equal(h.p.rvi(Buffer.from('8101', 'hex'), 0)[0], 129n);
    for (const hex of ['', '80', 'ffffffffffffffffff02', '8080808080808080808000']) {
        assert.throws(() => h.p.rvi(Buffer.from(hex, 'hex'), 0), (error) => {
            assert.equal(error.code, 'WX_NATIVE_PARSE_INVALID');
            assert.match(error.message, /state=(truncated-varint|varint-overflow)/);
            return true;
        });
    }
    for (const offset of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, 2])
        assert.throws(() => h.p.rvi(Buffer.from('01', 'hex'), offset), /invalid-varint-offset/);
    assertClean(h);
});

test('pbf 手写 fixed64/fixed32 后仍读 field2，保存原字节及 wire/长度', () => {
    const h = harness();
    const fields = h.p.pbf(Buffer.from('0901020304050607082d090a0b0c1203616263', 'hex'));
    assert.equal(fields.get(1).toString('hex'), '0102030405060708');
    assert.equal(fields.get(5).toString('hex'), '090a0b0c');
    assert.equal(fields.get(2).toString(), 'abc');
    assert.equal(fields.meta.get(1).wire, 1);
    assert.equal(fields.meta.get(5).wire, 5);
    assert.equal(fields.meta.get(2).wire, 2);
    assert.equal(fields.meta.get(1).length, 8);
    assert.equal(fields.meta.get(5).length, 4);
    assertClean(h);
});

test('pbf 手写非法 tags/截断/超长长度显式抛错，不能返回前半 Map', () => {
    const h = harness();
    const cases = [
        ['080100', 'invalid-field'], ['08010200', 'invalid-field'],
        ['08018080808010', 'invalid-field'],
        ['08010b', 'unsupported-wire'], ['08010c', 'unsupported-wire'],
        ['08010e', 'unsupported-wire'], ['08010f', 'unsupported-wire'],
        ['08011203aabb', 'invalid-field-length'], ['08010901020304050607', 'invalid-field-length'],
        ['080115010203', 'invalid-field-length'], ['08011080', 'truncated-varint'],
        ['080180', 'truncated-varint'], ['08011280', 'truncated-varint'],
        ['0801128080808080808010', 'invalid-field-length'],
        ['0801108080808080808080808000', 'varint-overflow'],
        ['080112ffffffffffffffffff02', 'varint-overflow']
    ];
    for (const [hex, state] of cases)
        assert.throws(() => h.p.pbf(Buffer.from(hex, 'hex')), (error) => {
            assert.equal(error.code, 'WX_NATIVE_PARSE_INVALID');
            assert.match(error.message, new RegExp(`state=${state} `));
            assert.match(error.message, /field=.* wire=.* length=\d+$/);
            return true;
        }, state);
    assertClean(h);
});

test('readWpkg 手写字节段长度边界；不推断版本或尾长度含义', () => {
    const h = harness();
    assert.equal(h.p.readWpkg(Buffer.from('01000004', 'hex')), 4);
    assert.equal(h.p.readWpkg(Buffer.from('7f000e02aabb0008', 'hex')), 8);
    assert.equal(h.p.readWpkg(Buffer.from('01000e000006', 'hex')), 6);
    assert.equal(h.p.readWpkg(Buffer.from('01000000', 'hex')), 4);
    for (const hex of ['01000e03aabb', '01000e8080808080808010', '01000e80', '01000e01aa'])
        assert.throws(() => h.p.readWpkg(Buffer.from(hex, 'hex')), (error) => error.code === 'WX_NATIVE_PARSE_INVALID');
    assertClean(h);
});

for (const fixture of manualFixtures) {
    test(`parseManual 手写 fixture：${fixture.name} 报 typed invalid`, () => {
        const h = harness({ protocolCrypto: fakeCrypto });
        const temp = { e: fakeCrypto.createECDH(), okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
        assert.throws(() => h.p.parseManual(manualPacket(fixture.hex), temp), (error) => {
            assert.equal(error.code, 'WX_MANUAL_AUTH_RESPONSE_INVALID');
            assert.match(error.message, new RegExp(`state=${fixture.state} `));
            assert.match(error.message, /field=.* wire=.* length=\d+$/);
            assert.equal(error.cause, undefined, '不挂载可能包含敏感信息的底层异常');
            return true;
        });
        assertClean(h);
    });
}

test('parseManual 手写正常层级：fixed1/5 后置 session 和完整 code0 仅结构完整才成功', () => {
    const h = harness({ protocolCrypto: fakeCrypto });
    const temp = { e: fakeCrypto.createECDH(), okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
    for (const hex of [validManualHex, fixedManualHex, '1a0e200012060a01611201621a02087b']) {
        const session = h.p.parseManual(manualPacket(hex), temp);
        assert.equal(session.sendKey.toString(), 'a');
        assert.equal(session.recvKey.toString(), 'b');
        assert.equal(session.uin, 123n);
        assert.equal(session.f9.length, 0);
    }
    assertClean(h);
});

test('parseManual 手写非0 拒绝，服务端明文不进入诊断，完整 session 也不覆盖拒绝', () => {
    const h = harness({ protocolCrypto: fakeCrypto });
    const temp = { e: fakeCrypto.createECDH(), okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
    for (const hex of ['1a0d20072a0973656e736974697665', '1a0e12060a01611201621a02087b2007']) {
        assert.throws(() => h.p.parseManual(manualPacket(hex), temp), (error) => {
            assert.equal(error.code, 'WX_MANUAL_AUTH_REJECTED');
            assert.match(error.message, /^ManualAuth rejected: code=7 state=nonzero-code field=4 wire=0 length=1$/);
            assert.doesNotMatch(error.message, /sensitive|message=/);
            return true;
        });
    }
    assertClean(h);
});

test('parseManual 底层异常与 code0 服务端明文只留下结构/状态诊断', () => {
    const h = harness({ protocolCrypto: fakeCrypto });
    const secretText = 'mock-private-ticket-key-uin';
    const temp = { e: { computeSecret() { throw new Error(secretText); } }, okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
    assert.throws(() => h.p.parseManual(manualPacket(validManualHex), temp), (error) => {
        assert.equal(error.code, 'WX_MANUAL_AUTH_RESPONSE_INVALID');
        assert.match(error.message, /state=key-agreement-failed field=unknown wire=unknown length=\d+$/);
        assert.equal(error.message.includes(secretText), false);
        assert.equal(error.cause, undefined);
        return true;
    });
    temp.e = fakeCrypto.createECDH();
    assert.throws(() => h.p.parseManual(manualPacket('1a0d20002a0973656e736974697665'), temp), (error) => {
        assert.equal(error.code, 'WX_MANUAL_AUTH_RESPONSE_INVALID');
        assert.match(error.message, /zero-code-without-session/);
        assert.doesNotMatch(error.message, /sensitive|message=/);
        return true;
    });
    assertClean(h);
});

test('ManualAuth BaseResponse field1.ret优先：真实-10不能误报bodycode0缺session', async () => {
    const h = harness({ protocolCrypto: fakeCrypto });
    const temp = { e: fakeCrypto.createECDH(), okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
    for (const hex of ['0a0608f6ffffff0f1a022000', '0a0b08f6ffffffffffffffff011a022000', '0a0608f6ffffff0f']) {
        assert.throws(() => h.p.parseManual(manualPacket(hex), temp), error => {
            assert.equal(error.code, 'WX_MANUAL_AUTH_REJECTED');
            assert.equal(error.serverCode, -10); assert.equal(error.stage, 'manual_auth');
            return true;
        });
    }
    const good = h.p.parseManual(manualPacket('0a020800' + validManualHex), temp);
    assert.equal(good.uin, 123n); assertClean(h);
});

test('parseManual 使用真实 GCM/AAD/tag，损坏 tag 只报脱敏 typed invalid', () => {
    const h = harness();
    const temp = { e: { computeSecret: () => fakeSecret }, okm: Buffer.alloc(56), comp: Buffer.from('mock-comp') };
    const secret = crypto.createHash('sha256').update(fakeSecret).digest();
    const aad = crypto.createHash('sha256').update(Buffer.concat([
        temp.okm.subarray(24), temp.comp, Buffer.from('415'), fakePeer, Buffer.from('1')
    ])).digest();
    const packet = manualPacket(validManualHex, (plain) => {
        const iv = Buffer.alloc(12, 9);
        const cipher = crypto.createCipheriv('aes-192-gcm', secret.subarray(0, 24), iv);
        cipher.setAAD(aad);
        return Buffer.concat([cipher.update(plain), cipher.final(), iv, cipher.getAuthTag()]);
    });
    assert.equal(h.p.parseManual(packet, temp).uin, 123n);
    for (const invalid of [Buffer.from(packet), packet.subarray(0, -1)]) {
        if (invalid.length === packet.length) invalid[invalid.length - 1] ^= 1;
        assert.throws(() => h.p.parseManual(invalid, temp), (error) => {
            assert.equal(error.code, 'WX_MANUAL_AUTH_RESPONSE_INVALID');
            assert.match(error.message, /state=(decrypt-auth-failed|invalid-field-length)/);
            assert.doesNotMatch(error.message, /authenticate|[0-9a-f]{32}/);
            return true;
        });
    }
    assertClean(h);
});

for (const fixture of manualFixtures) {
    test(`真实长连控制流：${fixture.name} 仅一次请求并清 socket/listener/timer`, async () => {
        let h;
        h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s) => {
            longPeer(h, s, { plainFixture: fixture.hex });
            queueMicrotask(() => s.emit('connect'));
        } });
        const controller = new AbortController();
        const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { signal: controller.signal }));
        await flush();
        assert.equal(result.settled, true);
        await result.done;
        assert.equal(result.error.code, 'WX_MANUAL_AUTH_RESPONSE_INVALID');
        assert.match(result.error.message, new RegExp(`state=${fixture.state} `));
        assert.equal(h.sockets.length, 1);
        assert.equal(h.sockets[0].writes.length, 3);
        assert.equal(h.fetchCalls.length, 1, '不推进后续长 IP 或短链接 HTTPDNS');
        assertClean(h, controller.signal);
        await h.time.advance(30000);
        assert.equal(h.sockets.length, 1);
        assert.equal(h.sockets[0].writes.length, 3);
        assertClean(h, controller.signal);
    });
}

test('socket connect 期间取消：拒绝连接、关闭 socket、清 timer/listener', async () => {
    const h = harness();
    const controller = new AbortController();
    const reason = new Error('模拟取消连接');
    const result = observe(h.p.socket('192.0.2.1', 8080, 5000, { signal: controller.signal }));
    assert.equal(h.time.timers.size, 1);
    controller.abort(reason);
    await result.done;
    assert.equal(result.error, reason);
    assertClean(h, controller.signal);
    h.sockets[0].emit('connect');
    h.sockets[0].emit('data', h.p.rec(22, Buffer.from('late')));
    assert.equal(h.sockets[0].writes.length, 0);
    await h.time.advance(10000);
    assertClean(h, controller.signal);
});

test('socket abort 拒绝 pending take/readAll/send，之后不得取缓存或发送', async () => {
    const h = harness({ onConnection: (s) => queueMicrotask(() => s.emit('connect')) });
    const controller = new AbortController();
    const c = await h.p.socket('192.0.2.1', 8080, 5000, { signal: controller.signal });
    let writeCallback;
    h.sockets[0].onWrite = (s, data, callback) => { writeCallback = callback; };
    const pending = [observe(c.take()), observe(c.readAll()), observe(c.send(Buffer.from('模拟发送')))];
    assert.equal(h.time.timers.size, 3);
    const reason = new Error('模拟取消读取');
    controller.abort(reason);
    await Promise.all(pending.map((r) => r.done));
    for (const r of pending) assert.equal(r.error, reason);
    writeCallback();
    h.sockets[0].emit('data', h.p.rec(23, Buffer.from('取消后的缓存')));
    await assert.rejects(c.take(), (error) => error === reason);
    await assert.rejects(c.readAll(), (error) => error === reason);
    await assert.rejects(c.send(Buffer.from('禁止发送')), (error) => error === reason);
    assert.equal(h.sockets[0].writes.length, 1);
    c.close();
    assertClean(h, controller.signal);
});

test('socket 取消优先于已经缓存的完整记录，不允许后续 take/send', async () => {
    const h = harness({ onConnection: (s) => queueMicrotask(() => s.emit('connect')) });
    const controller = new AbortController();
    const c = await h.p.socket('192.0.2.1', 80, 100, { signal: controller.signal });
    h.sockets[0].emit('data', h.p.rec(23, Buffer.from('已缓存完整记录')));
    controller.abort(new Error('取消优先于缓存'));
    await assert.rejects(c.take(), /取消优先于缓存/);
    await assert.rejects(c.send(Buffer.from('禁止发送')), /取消优先于缓存/);
    assert.equal(h.sockets[0].writes.length, 0);
    assertClean(h, controller.signal);
});

test('socket 预取消不创建连接；connect timeout 与 error/close 清理资源', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error('预取消'));
    await assert.rejects(h.p.socket('192.0.2.1', 80, 100, { signal: controller.signal }), /预取消/);
    assert.equal(h.sockets.length, 0);
    const timeout = observe(h.p.socket('192.0.2.1', 80, 100));
    await h.time.advance(100);
    await timeout.done;
    assert.match(timeout.error.message, /connection timeout/);
    const error = observe(h.p.socket('192.0.2.2', 80, 100));
    h.sockets[1].emit('error', new Error('ECONNREFUSED'));
    await error.done;
    assert.match(error.error.message, /ECONNREFUSED/);
    const closed = observe(h.p.socket('192.0.2.3', 80, 100));
    h.sockets[2].emit('close');
    await closed.done;
    assert.match(closed.error.message, /socket closed/);
    assertClean(h);
});

test('socket destroy 与异步 close 之间的迟到 error 不成为未处理异常', async () => {
    const h = harness();
    const controller = new AbortController();
    const result = observe(h.p.socket('192.0.2.1', 80, 100, { signal: controller.signal }));
    const s = h.sockets[0];
    s.destroy = () => {
        if (s.destroyed) return;
        s.destroyed = true;
        s.destroyCount++;
    };
    controller.abort(new Error('模拟异步关闭'));
    await result.done;
    assert.equal(h.time.timers.size, 0);
    assert.doesNotThrow(() => s.emit('error', new Error('destroy 后排队的 ECONNRESET')));
    s.emit('close');
    assertClean(h, controller.signal);
});

test('socket 真实 take 处理拆包、缓冲记录；readAll 接收结束且清 timer', async () => {
    const h = harness({ onConnection: (s) => queueMicrotask(() => s.emit('connect')) });
    const c = await h.p.socket('192.0.2.1', 80, 100);
    const packet = h.p.rec(22, Buffer.from('record'));
    const first = observe(c.take());
    h.sockets[0].emit('data', packet.subarray(0, 3));
    await flush();
    assert.equal(first.settled, false);
    h.sockets[0].emit('data', Buffer.concat([packet.subarray(3), h.p.rec(23, Buffer.from('second'))]));
    await first.done;
    assert.equal(first.value.body.toString(), 'record');
    assert.equal((await c.take()).body.toString(), 'second');
    const all = observe(c.readAll());
    h.sockets[0].emit('end');
    await all.done;
    assert.equal(all.value.length, packet.length + 11);
    assert.equal(h.time.timers.size, 0);
    c.close();
    assertClean(h);
});

test('socket take/readAll/send 超时分别关闭连接并清理 timer/listener', async () => {
    for (const method of ['take', 'readAll', 'send']) {
        const h = harness({ onConnection: (s) => queueMicrotask(() => s.emit('connect')) });
        const c = await h.p.socket('192.0.2.1', 80, 100);
        h.sockets[0].onWrite = () => {};
        const result = observe(method === 'send' ? c.send(Buffer.from('模拟发送')) : c[method]());
        await h.time.advance(100);
        await result.done;
        assert.match(result.error.message, /socket (read|write) timeout/);
        await assert.rejects(c.take(), /timeout/);
        await assert.rejects(c.send(Buffer.from('禁止发送')), /timeout/);
        assertClean(h);
    }
});

test('targets fetch 直接接收外部 signal 并可取消', async () => {
    const h = harness({ fetchImpl: (url, init) => abortableFetch(init) });
    const controller = new AbortController();
    const result = observe(h.p.targets('long', controller.signal));
    assert.equal(h.fetchCalls[0].init.signal, controller.signal);
    const reason = new Error('模拟取消 HTTPDNS');
    controller.abort(reason);
    await result.done;
    assert.equal(result.error, reason);
    assertClean(h, controller.signal);
});

test('native 外部取消传到 HTTPDNS signal，且不推进 IP 或遗留 timer', async () => {
    const h = harness({ fetchImpl: (url, init) => abortableFetch(init) });
    const controller = new AbortController();
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { signal: controller.signal }));
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.fetchCalls[0].init.signal.aborted, false);
    const reason = new Error('模拟 gateway 取消');
    controller.abort(reason);
    await result.done;
    assert.equal(result.error, reason);
    assert.equal(h.fetchCalls[0].init.signal.reason, reason);
    assert.equal(h.sockets.length, 0);
    assertClean(h, controller.signal);
});

test('默认总 timeout 是 20 秒并覆盖挂起的 HTTPDNS fetch', async () => {
    const h = harness({ fetchImpl: (url, init) => abortableFetch(init) });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app'));
    await h.time.advance(19999);
    assert.equal(result.settled, false);
    await h.time.advance(1);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(result.error.name, 'TimeoutError');
    assert.equal(h.fetchCalls[0].init.signal.aborted, true);
    assertClean(h);
});

test('HTTPDNS response.json 消费响应体时也受总取消信号约束', async () => {
    const h = harness({ fetchImpl: async (url, init) => ({ json: () => abortableFetch(init) }) });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { timeoutMs: 100 }));
    await flush();
    assert.equal(result.settled, false);
    await h.time.advance(100);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(h.sockets.length, 0);
    assertClean(h);
});

test('多 IP 网络失败可以换下一个，但共享总 deadline，不冲完 12 IP', async () => {
    let h;
    h = harness({ fetchImpl: async () => dnsResponse(), onConnection: (s, target, n) => {
        if (n === 1) h.time.setTimeout(() => s.emit('error', new Error('模拟 IP 网络失败')), 60);
    } });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        timeoutMs: 1000, deadline: h.time.now() + 100
    }));
    await flush();
    assert.equal(h.sockets.length, 1);
    await h.time.advance(60);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[0].destroyed, true, '切下个 IP 前关闭失败连接');
    await h.time.advance(40);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(h.sockets.length, 2);
    assertClean(h);
});

test('总 deadline 跨多个 5 秒 connect timeout，不允许产生第三个 IP', async () => {
    const h = harness({ fetchImpl: async () => dnsResponse() });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { timeoutMs: 7000 }));
    await flush();
    await h.time.advance(5000);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[0].destroyed, true);
    await h.time.advance(2000);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(h.sockets.length, 2);
    assertClean(h);
});

test('预取消/已过 deadline/非法 buffer 不发 fetch，也清理 native timer', async () => {
    for (const mode of ['abort', 'deadline', 'buffer']) {
        const h = harness();
        const controller = new AbortController();
        if (mode === 'abort') controller.abort(new Error('预取消'));
        const result = observe(h.api.getNativeWxLoginCode(mode === 'buffer' ? '' : h.loginBuffer, 'mock-app', {
            signal: controller.signal, deadline: mode === 'deadline' ? h.time.now() : h.time.now() + 1000
        }));
        await result.done;
        assert.ok(result.error);
        assert.equal(h.fetchCalls.length, 0);
        assert.equal(h.sockets.length, 0);
        assertClean(h, controller.signal);
    }
});

test('真实握手和 parseManual 明确拒绝仅一次认证，不向后续 IP 重试', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s) => {
        longPeer(h, s, { rejectAuth: true });
        queueMicrotask(() => s.emit('connect'));
    } });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app'));
    await flush();
    assert.equal(result.settled, true);
    await result.done;
    assert.match(result.error.message, /ManualAuth rejected: code=7/);
    assert.equal(result.error.code, 'WX_MANUAL_AUTH_REJECTED');
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].writes.length, 3, '执行真实握手、finish 和 ManualAuth 请求');
    assert.equal(h.fetchCalls.length, 1);
    assertClean(h);
});

test('ManualAuth 等待时外部 abort 不产生孤儿认证或后续 IP 请求', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s) => {
        longPeer(h, s, { holdAuth: true });
        queueMicrotask(() => s.emit('connect'));
    } });
    const controller = new AbortController();
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { signal: controller.signal }));
    await flush();
    assert.equal(h.sockets[0].writes.length, 3);
    assert.equal(result.settled, false);
    const reason = new Error('认证等待时取消');
    controller.abort(reason);
    await result.done;
    assert.equal(result.error, reason);
    await h.time.advance(30000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].writes.length, 3);
    assertClean(h, controller.signal);
});

test('短链接原始 TCP HTTP 等待可取消；不创建第二个短链接 IP', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) longPeer(h, s);
        else shortPeer(h, s, 'hold');
        queueMicrotask(() => s.emit('connect'));
    } });
    const controller = new AbortController();
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { signal: controller.signal }));
    await flush();
    assert.equal(h.fetchCalls.length, 2);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[1].writes.length, 1);
    assert.equal(h.sockets[0].destroyed, true);
    controller.abort(new Error('短链接等待取消'));
    await result.done;
    assert.match(result.error.message, /短链接等待取消/);
    assert.equal(h.sockets.length, 2);
    assertClean(h, controller.signal);
});

test('短链接 HTTPDNS 挂起受同一总 deadline 约束', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async (url, init, n) => {
        if (n === 2) return abortableFetch(init);
        return dnsResponse();
    }, onConnection: (s) => {
        longPeer(h, s);
        queueMicrotask(() => s.emit('connect'));
    } });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { timeoutMs: 100 }));
    await flush();
    assert.equal(h.fetchCalls.length, 2);
    assert.equal(result.settled, false);
    await h.time.advance(100);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(h.sockets.length, 1);
    assertClean(h);
});

test('短链接 readAll 等待受总 deadline 限制，不能继续第二个短 IP', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) longPeer(h, s);
        else shortPeer(h, s, 'hold');
        queueMicrotask(() => s.emit('connect'));
    } });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { timeoutMs: 100 }));
    await flush();
    assert.equal(h.sockets.length, 2);
    assert.equal(result.settled, false);
    await h.time.advance(100);
    await result.done;
    assert.match(result.error.message, /timeout/);
    assert.equal(h.sockets.length, 2);
    assertClean(h);
});

test('短链接网络 read timeout 可切换 IP，失败 socket 在下一次创建前关闭', async () => {
    let h;
    let shortCount = 0;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) longPeer(h, s);
        else {
            shortCount++;
            if (shortCount === 2) assert.equal(h.sockets[1].destroyed, true);
            shortPeer(h, s, shortCount === 1 ? 'hold' : 'success');
        }
        queueMicrotask(() => s.emit('connect'));
    } });
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app'));
    await flush();
    await h.time.advance(8000);
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value, 'mock-wx-code');
    assert.equal(h.sockets.length, 3);
    assertClean(h);
});

test('完整真实 native 成功路径返回模拟 code 并清理所有资源', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) longPeer(h, s);
        else shortPeer(h, s, 'success');
        queueMicrotask(() => s.emit('connect'));
    } });
    const controller = new AbortController();
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { signal: controller.signal, timeoutMs: 1000 }));
    await flush();
    assert.equal(result.settled, true);
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value, 'mock-wx-code');
    assert.equal(h.sockets.length, 2);
    assertClean(h, controller.signal);
});

function cachedRecord(h, changes = {}) {
    return {
        version: 1, binding: 'mock-wxid:generation-1', uin: '18446744073709551615',
        sendKey: Buffer.alloc(16, 1).toString('base64'), recvKey: Buffer.alloc(16, 2).toString('base64'),
        f9: '', deviceId: Buffer.from('mock-device').toString('base64'), hostAppId: Buffer.from('mock-host').toString('base64'),
        psk: Buffer.alloc(32, 7).toString('base64'), ticket: Buffer.from('010000003c0203', 'hex').toString('base64'),
        createdAt: h.time.now(), expiresAt: h.time.now() + 60000, ...changes
    };
}

function successHarness(longOptions = {}, shortMode = 'success') {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) longPeer(h, s, longOptions);
        else shortPeer(h, s, shortMode);
        queueMicrotask(() => s.emit('connect'));
    } });
    return h;
}

// 短链响应使用真实 AES-GCM/HMAC；所有身份、密钥和响应均为本地合成。
function realShortPeer(h, s, record, mode = 'success') {
    s.onWrite = (socket, wire, callback) => {
        const payload = wire.subarray(wire.indexOf('\r\n\r\n') + 4);
        const hello = payload.subarray(5, 5 + payload.readUInt16BE(3));
        const ticketLength = hello.readUInt32BE(58);
        assert.equal(hello.subarray(62, 62 + ticketLength).toString('base64'), record.ticket);
        const psk = Buffer.from(record.psk, 'base64');
        const serverHello = Buffer.from('00000003020102', 'hex');
        const hash = crypto.createHash('sha256').update(Buffer.concat([hello, serverHello])).digest();
        const material = h.p.expand(psk, 'handshake key expansion', hash, 28);
        const iv = Buffer.from(material.subarray(16));
        iv[11] ^= 2;
        const plain = Buffer.from('120e1a0c6d6f636b2d77782d636f6465', 'hex');
        const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(record.recvKey, 'base64'), Buffer.alloc(12, 9));
        const appBlob = Buffer.concat([cipher.update(h.p.lz4Literal(plain)), cipher.final(), Buffer.alloc(12, 9), cipher.getAuthTag()]);
        if (mode === 'app-tag') appBlob[appBlob.length - 1] ^= 1;
        const aad = Buffer.alloc(13);
        aad.writeBigUInt64BE(2n); aad[8] = 23; aad.writeUInt16BE(61699, 9); aad.writeUInt16BE(appBlob.length + 16, 11);
        const transport = crypto.createCipheriv('aes-128-gcm', material.subarray(0, 16), iv);
        transport.setAAD(aad);
        const appData = Buffer.concat([transport.update(appBlob), transport.final(), transport.getAuthTag()]);
        if (mode === 'transport-tag') appData[appData.length - 1] ^= 1;
        socket.emit('data', Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\n\r\n'), h.p.rec(22, serverHello), h.p.rec(23, appData)]));
        socket.emit('end');
        callback();
    };
}

function realCachedHarness(mode = 'success') {
    let h;
    let record;
    h = harness({ fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        assert.equal(target.port, 80, 'cache 不得建立长链接');
        realShortPeer(h, s, record, mode);
        queueMicrotask(() => s.emit('connect'));
    } });
    record = cachedRecord(h);
    return { h, record };
}

// 真实 AES 的手写布局对端：只复用密钥派生，响应结构由每个用例独立构造，
// 不经过 parseShort/unlayout/readWpkg，避免测试与被测函数互为镜像。
function realLayoutPeer(h, s, record, appBlobs) {
    s.onWrite = (socket, wire, callback) => {
        const payload = wire.subarray(wire.indexOf('\r\n\r\n') + 4);
        const hello = payload.subarray(5, 5 + payload.readUInt16BE(3));
        const psk = Buffer.from(record.psk, 'base64');
        const serverHello = Buffer.from('00000003020102', 'hex');
        const hash = crypto.createHash('sha256').update(Buffer.concat([hello, serverHello])).digest();
        const material = h.p.expand(psk, 'handshake key expansion', hash, 28);
        const iv = Buffer.from(material.subarray(16));
        iv[11] ^= 2;
        // 用错误的外层密钥封装：模拟"本地 seq/transcript 假设与服务端不一致"的真实现场。
        const outerKey = (record.tamperOuter ? Buffer.alloc(16, 0x33) : material.subarray(0, 16));
        const frames = appBlobs.map((blob) => {
            const aad = Buffer.alloc(13);
            aad.writeBigUInt64BE(2n); aad[8] = 23; aad.writeUInt16BE(61699, 9); aad.writeUInt16BE(blob.length + 16, 11);
            const transport = crypto.createCipheriv('aes-128-gcm', outerKey, iv);
            transport.setAAD(aad);
            return h.p.rec(23, Buffer.concat([transport.update(blob), transport.final(), transport.getAuthTag()]));
        });
        socket.emit('data', Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\n\r\n'), h.p.rec(22, serverHello), ...frames]));
        socket.emit('end');
        callback();
    };
}

// 应用层加密块：ct | iv(12) | tag(16)，与 unlayout 的尾部 28 字节结构一致。
function appCipher(h, record, plain, prefix) {
    const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(record.recvKey, 'base64'), Buffer.alloc(12, 9));
    const enc = Buffer.concat([cipher.update(h.p.lz4Literal(plain)), cipher.final(), Buffer.alloc(12, 9), cipher.getAuthTag()]);
    return prefix ? Buffer.concat([prefix, enc]) : enc;
}

const loginCodePlain = Buffer.from('120e1a0c6d6f636b2d77782d636f6465', 'hex');

function realCachedLayoutPeer(buildBlobs, patch = {}) {
    let h;
    let record;
    h = harness({ fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        assert.equal(target.port, 80);
        realLayoutPeer(h, s, record, buildBlobs(h, record));
        queueMicrotask(() => s.emit('connect'));
    } });
    record = cachedRecord(h, patch);
    return { h, record };
}

test('真实 AES：应用数据在 wpkg 头之后且偏移 >=220 仍解出 code（旧 0..219 盲扫漏解）', async () => {
    // 服务端 wpkg 头含设备 ID 等字节段，长度远超 220；旧实现的 offset 上限会让这张合法响应永久失败。
    const { h, record } = realCachedLayoutPeer((ctx, rec) => {
        const head = ctx.p.wpkg({ 1: 1, 2: 1, 3: 0 }, { 14: Buffer.alloc(0), 24: Buffer.alloc(240, 7), 27: Buffer.alloc(0) });
        assert.ok(head.length > 220, '构造的头必须超过旧盲扫上限');
        const enc = appCipher(ctx, rec, loginCodePlain, head);
        return [ctx.p.short(2881, 0, enc)];
    });
    assert.equal(await h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), 'mock-wx-code');
    assertClean(h);
});

test('真实 AES：第一条 type-23 非应用响应时，第二条仍能解出 code', async () => {
    const { h, record } = realCachedLayoutPeer((ctx, rec) => [
        // early-data 回声/ACK：transport 认证通过，但应用层不是合法响应。
        appCipher(ctx, rec, Buffer.alloc(48, 0x5a)),
        ctx.p.short(2881, 0, appCipher(ctx, rec, loginCodePlain)),
    ]);
    assert.equal(await h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), 'mock-wx-code');
    assertClean(h);
});

test('真实 AES：应用层解出非法内容时归为响应非法，绝不推断票据被拒', async () => {
    // 应用层 AEAD 通过、内容却不是合法响应：属于响应内容问题，既不是"解不开"也不是"票废"。
    const { h, record } = realCachedLayoutPeer((ctx, rec) => [
        appCipher(ctx, rec, Buffer.alloc(48, 0x5a)),
        appCipher(ctx, rec, Buffer.alloc(64, 0x5b)),
    ]);
    await assert.rejects(h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), (error) => {
        assert.equal(error.stage, 'shortlink');
        assert.equal(error.code, 'WX_SHORTLINK_RESPONSE_INVALID');
        assert.equal(error.ticketUnverified, undefined, '应用层已解开，不能再要求重验票据');
        assert.equal(error.ticketRejected, undefined, '不得把内容非法当成服务端拒绝');
        return true;
    });
    assert.equal(h.api.hasNativeSession(record, record.binding), true, 'cache 不得因响应非法被丢弃');
    assertClean(h);
});

test('真实 AES：外层认证全失败时只标 ticketUnverified，cache 不丢', async () => {
    // 外层 GCM 用的是错误密钥：本地无法用任何 seq/transcript 认证这条响应，
    // 这既可能是密钥/布局假设不符，也可能是票不可用——绝不能直接断言"票被拒"。
    const { h, record } = realCachedLayoutPeer(
        (ctx, rec) => [appCipher(ctx, rec, loginCodePlain)],
        { tamperOuter: true },
    );
    await assert.rejects(h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), (error) => {
        assert.equal(error.stage, 'shortlink');
        assert.equal(error.code, 'WX_SHORTLINK_AUTH_FAILED');
        assert.equal(error.ticketUnverified, true, '认证失败可能是密钥/布局假设不符，不能断言票废');
        assert.equal(error.ticketRejected, undefined);
        return true;
    });
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    assertClean(h);
});

test('ManualAuthRequest 手写独立 expected hex：version1901 只在 outer field2，保留空 field6', () => {
    const h = harness();
    const input = Buffer.from('0a01741201641a0168', 'hex').toString('base64');
    const request = h.p.manualRequest(input, Buffer.from('app'));
    assert.equal(request.req.toString('hex'), '0a050a0361707010ed0e1a030a01742004320038004006');
    assert.equal(request.device.toString(), 'd');
    assert.equal(request.host.toString(), 'h');
    assert.deepEqual([...h.p.pbf(h.p.pbf(request.req).get(1)).keys()], [1]);
    assertClean(h);
});

test('parseManual signed serverCode：手写 int32/int64 -10、-1 和无损大整数，不推断 code0', () => {
    const h = harness({ protocolCrypto: fakeCrypto });
    const temp = { e: fakeCrypto.createECDH(), okm: Buffer.alloc(56), comp: Buffer.alloc(0) };
    const fixtures = [
        ['1a0620f6ffffff0f', -10], ['1a0b20f6ffffffffffffffff01', -10],
        ['1a0620ffffffff0f', -1], ['1a0b20ffffffffffffffffff01', -1],
        ['1a09208080808080808010', '9007199254740992']
    ];
    for (const [hex, code] of fixtures) {
        assert.throws(() => h.p.parseManual(manualPacket(hex), temp), (error) => {
            assert.equal(error.code, 'WX_MANUAL_AUTH_REJECTED');
            assert.equal(error.stage, 'manual_auth');
            assert.equal(error.serverCode, code);
            assert.match(error.message, new RegExp(`code=${code} `));
            return true;
        });
    }
    assertClean(h);
});

test('连续两次取码：第一次 long+short，第二次 cache 仅 short，不再回调且不需要 buffer', async () => {
    const h = successHarness();
    let record;
    let callbacks = 0;
    const options = { sessionBinding: 'mock-wxid:generation-1', onSession: async (value) => {
        callbacks++;
        assert.equal(h.fetchCalls.length, 1, '保存完成前不能 fetch short');
        assert.equal(h.sockets[0].destroyed, true);
        record = JSON.parse(JSON.stringify(value));
    } };
    assert.equal(await h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', options), 'mock-wx-code');
    assert.equal(callbacks, 1);
    assert.equal(record.version, 1);
    assert.equal(record.uin, '123');
    assert.equal(record.expiresAt, record.createdAt + 60000);
    assert.equal(record.ticket, Buffer.from('010000003c0203', 'hex').toString('base64'));
    assert.equal(Buffer.from(record.psk, 'base64').length, 32);
    assert.equal(record.f9, '');
    assert.equal(h.api.hasNativeSession(record, options.sessionBinding), true);
    const before = JSON.stringify(record);
    assert.equal(await h.api.getNativeWxLoginCode(undefined, 'mock-app', { ...options, session: record }), 'mock-wx-code');
    assert.equal(callbacks, 1);
    assert.equal(h.sockets.length, 3);
    assert.deepEqual(h.sockets.map((s) => s.target.port), [8080, 80, 80]);
    assert.equal(h.fetchCalls.length, 3);
    assert.equal(JSON.stringify(record), before, 'cache 不得修改');
    assertClean(h);
});

test('JSON 落盘格式重建新 VM，真实 PSK/ticket/AES 复用且 lifetime 到期不能网络', async () => {
    const first = successHarness();
    let diskJson;
    await first.api.getNativeWxLoginCode(first.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: async (record) => { diskJson = JSON.stringify(record); }
    });
    assertClean(first);
    const record = JSON.parse(diskJson);
    let h;
    h = harness({ fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        assert.equal(target.port, 80);
        realShortPeer(h, s, record);
        queueMicrotask(() => s.emit('connect'));
    } });
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    assert.equal(await h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), 'mock-wx-code');
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.sockets.length, 1);
    assertClean(h);
    await h.time.advance(60000);
    assert.equal(h.api.hasNativeSession(record, record.binding), false);
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { session: record, sessionBinding: record.binding }),
        (error) => error.code === 'WX_NATIVE_SESSION_EXPIRED' && error.stage === 'native_session');
    assert.equal(h.fetchCalls.length, 1, '过期不得隐式 ManualAuth');
    assertClean(h);
});

const invalidSessionCases = [
    ['version', { version: 2 }], ['binding', { binding: 'mock-wxid:generation-2' }],
    ['uin0', { uin: '0' }], ['uint64 越界', { uin: '18446744073709551616' }],
    ['uin leading zero', { uin: '0123' }], ['uin number', { uin: 123 }], ['uin negative', { uin: '-1' }],
    ['send key length', { sendKey: 'YQ==' }], ['recv key length', { recvKey: 'Yg==' }],
    ['psk length', { psk: Buffer.alloc(16).toString('base64') }],
    ['非 canonical pad bits', { deviceId: 'YR==' }], ['缺 padding', { deviceId: 'YQ' }],
    ['base64 空白', { deviceId: 'YQ==\n' }], ['base64url', { ticket: '_w==' }],
    ['device 空', { deviceId: '' }], ['host 空', { hostAppId: '' }], ['ticket 空', { ticket: '' }],
    ['f9 type', { f9: null }], ['非 PSK ticket', { ticket: Buffer.from('020000003c01', 'hex').toString('base64') }],
    ['ticket 缺 lifetime', { ticket: 'AQID' }], ['expiry 伪延长', { expiresAt: 1700000060001 }],
    ['expiry 伪缩短', { expiresAt: 1700000059999 }], ['expiry 缺失', { expiresAt: undefined }],
    ['createdAt future', { createdAt: 1700000000001, expiresAt: 1700000060001 }],
    ['createdAt negative', { createdAt: -1, expiresAt: 59999 }],
    ['createdAt fractional', { createdAt: 1699999999999.5, expiresAt: 1700000059999.5 }],
    ['expiry 越界', { expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['ticket lifetime 与 expiry 不符', { ticket: Buffer.from('010000003d01', 'hex').toString('base64') }]
];
for (const [name, changes] of invalidSessionCases) {
    test(`cache 校验 ${name}：typed native_session，不联网也不自动重建`, async () => {
        const h = harness();
        const record = cachedRecord(h, changes);
        assert.equal(h.api.hasNativeSession(record, 'mock-wxid:generation-1'), false);
        const before = JSON.stringify(record);
        await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
            session: record, sessionBinding: 'mock-wxid:generation-1'
        }), (error) => {
            assert.equal(error.code, 'WX_NATIVE_SESSION_INVALID');
            assert.equal(error.stage, 'native_session');
            assert.doesNotMatch(error.message, /generation|184467|YQ|PSK_ACCESS/);
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(JSON.stringify(record), before);
        assert.equal(h.fetchCalls.length, 0);
        assert.equal(h.sockets.length, 0);
        assertClean(h);
    });
}

test('hasNativeSession 缺绑定/空记录/expiry 恰等 now 都 false；AES16/24/32 均允许，时间算术严格 safe', async () => {
    const h = harness();
    for (const record of [null, undefined, [], 'record']) assert.equal(h.api.hasNativeSession(record, 'binding'), false);
    assert.equal(h.api.hasNativeSession(cachedRecord(h)), false);
    assert.equal(h.api.hasNativeSession(cachedRecord(h), ''), false);
    for (const length of [16, 24, 32]) {
        const record = cachedRecord(h, { sendKey: Buffer.alloc(length).toString('base64'), recvKey: Buffer.alloc(length).toString('base64') });
        assert.equal(h.api.hasNativeSession(record, record.binding), true);
    }
    const expired = cachedRecord(h, { createdAt: h.time.now() - 60000, expiresAt: h.time.now() });
    assert.equal(h.api.hasNativeSession(expired, expired.binding), false);
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { session: expired, sessionBinding: expired.binding }),
        (error) => error.code === 'WX_NATIVE_SESSION_EXPIRED' && error.stage === 'native_session');
    const huge = harness();
    await huge.time.advance(Number.MAX_SAFE_INTEGER - huge.time.now());
    const overflow = cachedRecord(huge, { createdAt: Number.MAX_SAFE_INTEGER - 1000, expiresAt: Number.MAX_SAFE_INTEGER });
    assert.equal(huge.api.hasNativeSession(overflow, overflow.binding), false);
    await assert.rejects(huge.api.getNativeWxLoginCode(null, 'mock-app', { session: overflow, sessionBinding: overflow.binding }),
        (error) => error.code === 'WX_NATIVE_SESSION_INVALID' && error.stage === 'native_session');
    assert.equal(huge.fetchCalls.length, 0);
    assertClean(h);
    assertClean(huge);
});

test('onSession 必须先 await 持久化；失败 typed persist_native_session，不泄漏底层秘密且全清资源', async () => {
    const h = successHarness();
    let rejectSave;
    let record;
    const controller = new AbortController();
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        signal: controller.signal, sessionBinding: 'mock-wxid:generation-1', onSession: (value) => {
            record = value;
            return new Promise((resolve, reject) => { rejectSave = reject; });
        }
    }));
    await flush();
    assert.equal(result.settled, false);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].destroyed, true);
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    rejectSave(new Error(`mock-private-save-error ${record.psk}`));
    await result.done;
    assert.equal(result.error.code, 'WX_NATIVE_SESSION_PERSIST_FAILED');
    assert.equal(result.error.stage, 'persist_native_session');
    assert.doesNotMatch(result.error.message, /mock-private|save-error/);
    assert.equal(result.error.message.includes(record.psk), false);
    assert.equal(result.error.cause, undefined);
    assertClean(h, controller.signal);
});

test('onSession 等待期间取消仍完成保存，但不得推进 short code', async () => {
    const h = successHarness();
    const controller = new AbortController();
    let finishSave;
    let serialized;
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        signal: controller.signal, sessionBinding: 'mock-wxid:generation-1', onSession: (record) => new Promise((resolve) => {
            finishSave = () => { serialized = JSON.stringify(record); resolve(); };
        })
    }));
    await flush();
    const reason = new Error('模拟持久化时取消');
    controller.abort(reason);
    assert.equal(result.settled, false, '不得中断可靠保存');
    finishSave();
    await result.done;
    assert.equal(result.error, reason);
    assert.ok(serialized);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.sockets.length, 1);
    assertClean(h, controller.signal);
});

test('刚收到 ManualAuth 新材料即取消：仍回调保存完整 record，不能换 IP 或取 code', async () => {
    const controller = new AbortController();
    const reason = new Error('收到认证响应时取消');
    const h = successHarness({ afterAuth: () => controller.abort(reason) });
    let record;
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        signal: controller.signal, sessionBinding: 'mock-wxid:generation-1', onSession: async (value) => { record = value; }
    }), (error) => error === reason);
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.sockets.length, 1);
    assertClean(h, controller.signal);
});

test('ManualAuth 响应已完整到达但 write 回调迟到：立即保存并取码，关闭后不遗留 pending timer', async () => {
    let h;
    let lateWrite;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s, target) => {
        if (target.port === 8080) {
            longPeer(h, s);
            const peerWrite = s.onWrite;
            s.onWrite = (socket, wire, callback) => {
                if (s.writes.length === 3) {
                    lateWrite = callback;
                    peerWrite(socket, wire, () => {});
                }
                else peerWrite(socket, wire, callback);
            };
        }
        else shortPeer(h, s, 'success');
        queueMicrotask(() => s.emit('connect'));
    } });
    let record;
    assert.equal(await h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: async (value) => { record = value; }
    }), 'mock-wx-code');
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    assertClean(h);
    lateWrite();
    await flush();
    assertClean(h);
});

test('onSession 同步 throw、取消后写失败优先 typed persist_native_session，认证失败不回调', async () => {
    for (const cancel of [false, true]) {
        const controller = new AbortController();
        const h = successHarness();
        await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
            signal: controller.signal, sessionBinding: 'mock-wxid:generation-1', onSession: () => {
                if (cancel) controller.abort(new Error('模拟取消'));
                throw new Error('mock-private-disk-failure');
            }
        }), (error) => error.code === 'WX_NATIVE_SESSION_PERSIST_FAILED' && error.stage === 'persist_native_session' && !error.message.includes('mock-private'));
        assert.equal(h.fetchCalls.length, 1);
        assertClean(h, controller.signal);
    }
    const rejected = successHarness({ rejectAuth: true });
    let callbacks = 0;
    await assert.rejects(rejected.api.getNativeWxLoginCode(rejected.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: async () => { callbacks++; }
    }), (error) => error.code === 'WX_MANUAL_AUTH_REJECTED' && error.serverCode === 7);
    assert.equal(callbacks, 0);
    assertClean(rejected);
});

test('onSession/sessionBinding 参数边界只校验、不联网', async () => {
    for (const options of [{ onSession: async () => {} }, { onSession: true, sessionBinding: 'mock-binding' },
        { sessionBinding: '' }, { sessionBinding: 1 }]) {
        const h = harness();
        await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', options),
            (error) => error.code === 'WX_NATIVE_SESSION_INVALID' && error.stage === 'native_session');
        assert.equal(h.fetchCalls.length, 0);
        assertClean(h);
    }
});

test('onSession 延迟超过服务器 lifetime：保存后报 EXPIRED，不创建 short 或重新 ManualAuth', async () => {
    const h = successHarness({ ticketHex: '01000000010203' });
    let save;
    let record;
    const result = observe(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: (value) => {
            record = value;
            return new Promise((resolve) => { save = resolve; });
        }
    }));
    await flush();
    await h.time.advance(1000);
    save();
    await result.done;
    assert.equal(record.expiresAt, record.createdAt + 1000);
    assert.equal(result.error.code, 'WX_NATIVE_SESSION_EXPIRED');
    assert.equal(result.error.stage, 'native_session');
    assert.equal(h.fetchCalls.length, 1);
    assertClean(h);
});

test('无 lifetime ticket 本次可取码、回调 expiresAt=null；跨调用 INVALID 不猜 TTL', async () => {
    const h = successHarness({ ticketHex: '010203' });
    let record;
    assert.equal(await h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: async (value) => { record = JSON.parse(JSON.stringify(value)); }
    }), 'mock-wx-code');
    assert.equal(record.expiresAt, null);
    assert.equal(h.api.hasNativeSession(record, record.binding), false);
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', { session: record, sessionBinding: record.binding }),
        (error) => error.code === 'WX_NATIVE_SESSION_INVALID' && error.stage === 'native_session');
    assert.equal(h.sockets.length, 2);
    assertClean(h);
});

for (const mode of ['empty', 'missing', 'nested', 'bad-protobuf', '401', '403', '500', 'invalid-http', 'invalid-record']) {
    test(`short ${mode}：cache 保留，typed stage，不继续下一 IP 或重新 ManualAuth`, async () => {
        const h = successHarness({}, mode);
        const record = cachedRecord(h);
        const before = JSON.stringify(record);
        let callbacks = 0;
        await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
            session: record, sessionBinding: record.binding, onSession: async () => { callbacks++; }
        }), (error) => {
            const noCode = ['empty', 'missing', 'nested'].includes(mode);
            assert.equal(error.stage, noCode ? 'js_login' : 'shortlink');
            assert.equal(error.code, noCode ? 'WX_LOGIN_CODE_UNAVAILABLE'
                : /^[0-9]+$/.test(mode) ? 'WX_SHORTLINK_HTTP_ERROR' : 'WX_SHORTLINK_RESPONSE_INVALID');
            if (/^[0-9]+$/.test(mode)) assert.equal(error.httpStatus, Number(mode));
            assert.doesNotMatch(error.message, /mock-secret|server-body/);
            return true;
        });
        assert.equal(callbacks, 0);
        assert.equal(h.sockets.length, 1);
        assert.equal(h.sockets[0].target.port, 80);
        assert.equal(h.fetchCalls.length, 1);
        assert.equal(JSON.stringify(record), before);
        assert.equal(h.api.hasNativeSession(record, record.binding), true);
        assertClean(h);
    });
}

for (const mode of ['transport-tag', 'app-tag']) {
    test(`真实 GCM ${mode} 失败：准确 typed shortlink，cache 不丢且不跨 IP 扩大拒绝`, async () => {
        const { h, record } = realCachedHarness(mode);
        const before = JSON.stringify(record);
        await assert.rejects(h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }), (error) => {
            assert.equal(error.stage, 'shortlink');
            assert.equal(error.code, mode === 'transport-tag' ? 'WX_SHORTLINK_AUTH_FAILED' : 'WX_SHORTLINK_APP_DECRYPT_FAILED');
            assert.equal(error.cause, undefined);
            return true;
        });
        assert.equal(h.sockets.length, 1);
        assert.equal(JSON.stringify(record), before);
        assert.equal(h.api.hasNativeSession(record, record.binding), true);
        assertClean(h);
    });
}

test('冷启动 short 无 code 仍先保存新 session，不新增 long/refresh', async () => {
    const h = successHarness({}, 'empty');
    let record;
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app', {
        sessionBinding: 'mock-wxid:generation-1', onSession: async (value) => { record = value; }
    }), (error) => error.code === 'WX_LOGIN_CODE_UNAVAILABLE' && error.stage === 'js_login');
    assert.equal(h.api.hasNativeSession(record, record.binding), true);
    assert.deepEqual(h.sockets.map((s) => s.target.port), [8080, 80]);
    assert.equal(h.fetchCalls.length, 2);
    assertClean(h);
});

test('cache 网络失败可以下一 IP，但共享 deadline；全部失败 typed shortlink 且不修改 cache', async () => {
    let h;
    h = harness({ fetchImpl: async () => dnsResponse(), onConnection: (s) => {
        queueMicrotask(() => s.emit('error', new Error('模拟 ECONNREFUSED')));
    } });
    const record = cachedRecord(h);
    const before = JSON.stringify(record);
    await assert.rejects(h.api.getNativeWxLoginCode(null, 'mock-app', { session: record, sessionBinding: record.binding }),
        (error) => error.code === 'WX_SHORTLINK_NETWORK_ERROR' && error.stage === 'shortlink');
    assert.deepEqual(h.sockets.map((s) => s.target.port), [80, 80]);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(JSON.stringify(record), before);
    assertClean(h);
    const waiting = harness({ fetchImpl: async () => dnsResponse() });
    const cached = cachedRecord(waiting);
    const result = observe(waiting.api.getNativeWxLoginCode(null, 'mock-app', {
        session: cached, sessionBinding: cached.binding, timeoutMs: 7000
    }));
    await flush();
    await waiting.time.advance(7000);
    await result.done;
    assert.equal(result.error.name, 'TimeoutError');
    assert.equal(waiting.sockets.length, 1);
    assert.equal(waiting.api.hasNativeSession(cached, cached.binding), true);
    assertClean(waiting);
});

test('ManualAuth 已发送后断网不重复认证；等待时取消仍清理，不能用超时推断需新 buffer', async () => {
    let h;
    h = harness({ protocolCrypto: fakeCrypto, fetchImpl: async () => dnsResponse(), onConnection: (s) => {
        longPeer(h, s, { holdAuth: true });
        const peerWrite = s.onWrite;
        s.onWrite = (...args) => {
            peerWrite(...args);
            if (s.writes.length === 3) queueMicrotask(() => s.emit('error', new Error('模拟认证后 ECONNRESET')));
        };
        queueMicrotask(() => s.emit('connect'));
    } });
    await assert.rejects(h.api.getNativeWxLoginCode(h.loginBuffer, 'mock-app'), /ECONNRESET/);
    assert.equal(h.fetchCalls.length, 1);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].writes.length, 3);
    assertClean(h);
});

test('issueCode 真实方法原样透传 options，保留旧两参调用和缺 buffer 校验', async () => {
    const calls = [];
    const context = vm.createContext({
        exports: {}, Error,
        fetch: () => { throw new Error('禁止 service fetch'); },
        require(name) {
            if (name === 'node:crypto') return crypto;
            if (name === './native-protocol') return { hasNativeSession: () => false, getNativeWxLoginCode: async (...args) => {
                calls.push(args);
                return 'mock-service-code';
            } };
            throw new Error(`禁止加载模块 ${name}`);
        }
    });
    vm.runInContext(serviceSource, context);
    const service = new context.exports.WxLoginService();
    const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 1234, deadline: 1700000001234 };
    const session = { loginBuffer: '仅模拟 buffer' };
    assert.equal(await service.issueCode(session, 'mock-app', options), 'mock-service-code');
    assert.equal(calls[0][0], session.loginBuffer);
    assert.equal(calls[0][1], 'mock-app');
    assert.equal(calls[0][2], options, '不是拷贝、不是丢失字段');
    await service.issueCode(session, 'mock-app');
    assert.deepEqual(Object.keys(calls[1][2]), []);
    await assert.rejects(service.issueCode({}, 'mock-app', options), /has not been confirmed/);
    assert.equal(calls.length, 2);
});
