// 微信换码失败分类器的回归测试（2026-10-31 新增）
// 目的：确保「临时性错误」不会被当成「凭证已失效」，否则几次网络抖动就会把账号打进必须扫码的状态。
const test = require('node:test');
const assert = require('node:assert');

// 提取并执行真实源码函数，不加载网关入口或镜像分类规则。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/runtime/gateway-process.js'), 'utf8');
const start = source.indexOf('function classifyWxCodeError(');
const end = source.indexOf('\n}\n', start) + 2;
assert.ok(start >= 0 && end > start, '必须提取到源码分类器');
const classifyWxCodeError = vm.runInNewContext(`(${source.slice(start, end)})`);

test('40188 属于临时性失败，不得判定为需要扫码', () => {
    const r = classifyWxCodeError('WeChat login buffer refresh failed: code=-101 msg=GetLoginBuffer error [40188] [invalid scope, rid: xxx]');
    assert.equal(r.temporary, true);
    assert.equal(r.reason, '40188_scope');
});

test('换码超时属于临时性失败（旧逻辑会误判为永久失效）', () => {
    const r = classifyWxCodeError('换码超时 20000ms');
    assert.equal(r.temporary, true);
    assert.equal(r.reason, 'timeout');
});

test('刷新超时属于临时性失败', () => {
    const r = classifyWxCodeError('刷新 loginBuffer超时 30000ms');
    assert.equal(r.temporary, true);
});

test('网络类错误属于临时性失败', () => {
    for (const m of ['read ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'network error', 'fetch failed']) {
        assert.equal(classifyWxCodeError(m).temporary, true, m);
    }
});

test('ManualAuth rejected 属于临时性失败', () => {
    const r = classifyWxCodeError('Unable to establish WeChat protocol session: 43.159.233.159:8080 ManualAuth reje');
    assert.equal(r.temporary, true);
    assert.equal(r.reason, 'manualauth_rejected');
});

test('token 阶段拒绝或缺字段不得推断需扫码', () => {
    for (const m of ['WeChat token refresh failed', 'RefreshToken empty', 'missing access_token']) {
        assert.equal(classifyWxCodeError({ message: m, stage: 'token_refresh' }).temporary, true, m);
    }
    const r = classifyWxCodeError({ message: 'WeChat token refresh failed: code=40188 msg=invalid scope', stage: 'token_refresh', code: 40188 });
    assert.equal(r.temporary, true);
    assert.equal(r.reason, '40188_scope');
});

test('本地凭证缺失属于永久性失败', () => {
    assert.equal(classifyWxCodeError('loginBuffer 文件不存在').temporary, false);
    assert.equal(classifyWxCodeError('loginBuffer 为空').temporary, false);
    assert.equal(classifyWxCodeError('loginBuffer 解析异常 Unexpected token').temporary, true);
    assert.equal(classifyWxCodeError({ message: '缺少刷新凭证', stage: 'local_credential_missing' }).temporary, false);
    assert.equal(classifyWxCodeError({ message: '磁盘写入失败', stage: 'persist_rotated' }).temporary, true);
});

test('无 refreshtoken 属于永久性失败', () => {
    const r = classifyWxCodeError('loginBuffer 已失效且无 refreshtoken（旧版落盘未保存凭证）');
    assert.equal(r.temporary, false);
    assert.equal(r.reason, 'no_refreshtoken');
});

test('未知错误保守按临时处理（宁可多试也不误判必须扫码）', () => {
    const r = classifyWxCodeError('something totally unexpected');
    assert.equal(r.temporary, true);
    assert.equal(r.reason, 'unknown');
});

test('空错误信息也不会崩，按临时处理', () => {
    for (const m of ['', null, undefined]) {
        const r = classifyWxCodeError(m);
        assert.equal(r.temporary, true);
    }
});

// 服务契约只在 VM 内执行 service 源码；HTTP 和 native 均为内存 mock。
const crypto = require('node:crypto');
const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/wx-login/service.js'), 'utf8');
const mockHost = 'https://yybadaccess.3g.qq.com';
const mainRefreshUrl = `${mockHost}/pc_yyb/pcyyb_refresh_token`;
const authRefreshUrl = `${mockHost}/pc_yyb_auth/pcyyb_refresh_token_auth`;
const bufferUrl = `${mockHost}/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth`;
const authKey = 'wgrdg373hy26ww2';
const configuredScope = 'snsapi_login,snsapi_runtime_pcsdk';
const mockOpenid = 'mock-openid-[40201]';
const oldAccess = 'mock-old-access-[40188]';
const oldRefresh = 'mock-old-refresh-[40202]';
const newAccess = 'mock-new-access-[40203]';
const newRefresh = 'mock-new-refresh-[40204]';
const mockBuffer = 'mock-login-buffer-[40205]';

function mockSession(overrides = {}) {
    return {
        openid: mockOpenid, accesstoken: oldAccess, refreshtoken: oldRefresh,
        loginType: 'WX', refreshBusinessId: 'pc_yyb', cookies: new Map(),
        ...overrides,
    };
}

function tokenData(overrides = {}) {
    return {
        code: 0,
        user_info: { openid: mockOpenid, login_type: 'WX', access_token: newAccess, refresh_token: newRefresh, expiresIn: 60 },
        ...overrides,
    };
}

function bufferData(overrides = {}) {
    return { code: 0, ext_info: { list_s: { login_buffer: { value: [mockBuffer] } } }, ...overrides };
}

function mockResponse(data, { status = 200, raw = false, cookies = [], location } = {}) {
    // 使用真实 Response/Headers 的 getSetCookie，避免伪造或绕过 cookie 的来源元数据。
    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    if (location) headers.set('Location', location);
    return new Response(raw ? data : JSON.stringify(data), { status, headers });
}

function mockWxService(responses = [], native = async () => 'mock-native-code') {
    const requests = [];
    const nativeCalls = [];
    const timers = new Set();
    const queue = [...responses];
    const moduleExports = {};
    const context = vm.createContext({
        exports: moduleExports, Buffer, URL, URLSearchParams, Headers, AbortController, Date, Error,
        setTimeout(callback, ms, ...args) {
            const timer = setTimeout(() => {
                timers.delete(timer);
                callback(...args);
            }, ms);
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) {
            timers.delete(timer);
            clearTimeout(timer);
        },
        require(name) {
            if (name === 'node:crypto') return crypto;
            if (name === './native-protocol') {
                return {
                    hasNativeSession(record, binding) { return !!record && record.binding === binding; },
                    getNativeWxLoginCode(...args) {
                        nativeCalls.push(args);
                        return native(...args);
                    },
                };
            }
            throw new Error(`VM 不允许加载依赖 ${name}`);
        },
        async fetch(url, init) {
            const request = { url: String(url), ...init, headers: new Headers(init.headers) };
            requests.push(request);
            assert.equal(init.redirect, 'manual');
            assert.ok(init.signal instanceof AbortSignal);
            if (init.signal.aborted) throw init.signal.reason;
            assert.ok(queue.length > 0, `不允许额外 HTTP 请求：${url}`);
            const next = queue.shift();
            return typeof next === 'function' ? await next(request) : next;
        },
    });
    vm.runInContext(serviceSource, context, { filename: 'wx-login/service.js' });
    return {
        service: new moduleExports.WxLoginService(), requests, nativeCalls, timers,
        assertDrained() {
            assert.equal(queue.length, 0, '所有预期 mock 响应应已使用');
            assert.equal(timers.size, 0, '操作结束必须清除全部 service/request timer');
        },
    };
}

function assertSignedRequest(request, url, business, key) {
    assert.equal(request.url, url);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    assert.equal(request.headers.get('Ual-Access-Businessid'), business);
    const timestamp = request.headers.get('Ual-Access-Timestamp');
    const nonce = request.headers.get('Ual-Access-Nonce');
    assert.match(timestamp, /^\d+$/);
    assert.match(nonce, /^\d+$/);
    const signature = crypto.createHash('md5').update(`${request.body}${timestamp}${key}${nonce}`).digest('hex');
    assert.equal(request.headers.get('Ual-Access-Signature'), signature, '签名必须使用实际发送 body、timestamp、业务 key 和 nonce');
}

async function captureFailure(operation) {
    let failure;
    await assert.rejects(operation, error => {
        failure = error;
        return true;
    });
    return failure;
}

function assertRedacted(error, secrets = [mockOpenid, oldAccess, oldRefresh, newAccess, newRefresh, mockBuffer]) {
    for (const secret of secrets) {
        for (const text of [error.message, error.stack || '']) {
            assert.ok(!text.includes(secret), '错误 message/stack 不得包含原始凭据');
            assert.ok(!text.includes(encodeURIComponent(secret)), '错误 message/stack 不得包含 URL 编码凭据');
        }
    }
    assert.equal(error.cause, undefined, '不能通过 cause 泄露原始错误');
}

for (const [name, overrides, url, business, key, sourceName] of [
    ['主业务', {}, mainRefreshUrl, 'pc_yyb', '', 'pc_yyb'],
    ['缺 marker 的 legacy', { refreshBusinessId: undefined }, mainRefreshUrl, 'pc_yyb', '', 'legacy_pc_yyb'],
    ['显式 auth', { refreshBusinessId: 'pc_yyb_auth' }, authRefreshUrl, 'pc_yyb_auth', authKey, 'pc_yyb_auth'],
    ['snake marker 的 auth', { refreshBusinessId: undefined, refresh_business_id: 'pc_yyb_auth' }, authRefreshUrl, 'pc_yyb_auth', authKey, 'pc_yyb_auth'],
]) {
    test(`VM refreshCredentials：${name}只请求正确 URL，精确 business/MD5 签名`, async () => {
        const mock = mockWxService([mockResponse(tokenData())]);
        const session = mockSession(overrides);
        const before = Date.now();
        const result = await mock.service.refreshCredentials(session);
        const after = Date.now();
        assert.equal(mock.requests.length, 1);
        assertSignedRequest(mock.requests[0], url, business, key);
        assert.deepStrictEqual(JSON.parse(mock.requests[0].body), {
            userInfo: { openId: mockOpenid, refreshToken: oldRefresh, accessToken: oldAccess, loginType: 'WX' },
        });
        assert.equal(result.refreshBusinessId, business);
        assert.equal(result.credentialSource, sourceName);
        assert.equal(result.refreshtoken, newRefresh);
        assert.equal(result.accesstoken, newAccess);
        assert.ok(result.tokenCheckedAt >= before && result.tokenCheckedAt <= after);
        assert.equal(result.refreshTokenChangedAt, result.tokenCheckedAt);
        assert.equal(result.accessTokenExpiresAt, Number(mock.requests[0].headers.get('Ual-Access-Timestamp')) + 60000);
        assert.equal(mock.nativeCalls.length, 0);
        mock.assertDrained();
    });
}

for (const marker of ['unknown', '', null, false, 123, { business: 'pc_yyb' }]) {
    test(`VM refreshCredentials：非法 marker ${JSON.stringify(marker)} 在任何请求前失败`, async () => {
        const mock = mockWxService();
        const session = mockSession({ refreshBusinessId: marker });
        let writes = 0;
        const error = await captureFailure(mock.service.refreshCredentials(session, { onCredentialsRotated() { writes++; } }));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(error.type, 'credential_source_invalid');
        assert.equal(mock.requests.length, 0);
        assert.equal(mock.nativeCalls.length, 0);
        assert.equal(writes, 0);
        assert.equal(session.refreshtoken, oldRefresh);
        assertRedacted(error);
        mock.assertDrained();
    });
}

test('VM token-only：等待 callback 落盘完成才返回，不请求 buffer/native', async () => {
    const mock = mockWxService([mockResponse(tokenData())]);
    const session = mockSession({ loginBuffer: 'mock-original-buffer' });
    let enterWriter;
    let finishWriter;
    const writerEntered = new Promise(resolve => { enterWriter = resolve; });
    const writerFinished = new Promise(resolve => { finishWriter = resolve; });
    let saved;
    let returned = false;
    const pending = mock.service.refreshCredentials(session, {
        async onCredentialsRotated(credentials) {
            saved = credentials;
            assert.equal(session.refreshtoken, newRefresh);
            assert.equal(session.accesstoken, newAccess);
            enterWriter();
            await writerFinished;
            return true;
        },
    }).then(result => { returned = true; return result; });
    await writerEntered;
    try {
        assert.equal(returned, false);
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.nativeCalls.length, 0);
    } finally {
        finishWriter();
    }
    const result = await pending;
    assert.deepStrictEqual({ ...result }, { ...saved });
    assert.equal(session.loginBuffer, 'mock-original-buffer');
    mock.assertDrained();
});

test('VM token-only：函数 callback 兼容，未轮换 refresh 不伪造 changedAt', async () => {
    const data = tokenData();
    delete data.user_info.refresh_token;
    const mock = mockWxService([mockResponse(data)]);
    const session = mockSession();
    let saved;
    const result = await mock.service.refreshCredentials(session, credentials => { saved = credentials; });
    assert.equal(result.refreshtoken, oldRefresh);
    assert.equal(result.refreshTokenChangedAt, undefined);
    assert.equal(session.refreshTokenChangedAt, undefined);
    assert.deepStrictEqual({ ...result }, { ...saved });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.nativeCalls.length, 0);
    mock.assertDrained();
});

for (const [name, callbackOptions] of [
    ['options callback', callback => ({ onCredentialsRotated: callback })],
    ['旧函数 callback', callback => callback],
]) {
    test(`VM refreshLoginBuffer：${name} 保持 token → persist → buffer 两步兼容`, async () => {
        let persisted = false;
        const mock = mockWxService([
            mockResponse(tokenData()),
            request => {
                assert.equal(persisted, true, '不能在凭据落盘前获取 buffer');
                assertSignedRequest(request, bufferUrl, 'pc_yyb_auth', authKey);
                assert.equal(JSON.parse(request.body).extInfo.listS.access_token.value[0], newAccess);
                assert.equal(request.headers.get('Cookie'), `openid=${mockOpenid}; accesstoken=${newAccess}; refreshtoken=${newRefresh}`);
                return mockResponse(bufferData());
            },
        ]);
        const session = mockSession();
        const result = await mock.service.refreshLoginBuffer(session, callbackOptions(async credentials => {
            assert.equal(credentials.refreshtoken, newRefresh);
            assert.equal(credentials.accesstoken, newAccess);
            persisted = true;
        }));
        assert.equal(mock.requests.length, 2);
        assertSignedRequest(mock.requests[0], mainRefreshUrl, 'pc_yyb', '');
        assert.equal(result.loginBuffer, mockBuffer);
        assert.equal(session.loginBuffer, mockBuffer);
        assert.equal(result.refreshtoken, newRefresh);
        assert.equal(result.accesstoken, newAccess);
        assert.equal(mock.nativeCalls.length, 0);
        mock.assertDrained();
    });
}

for (const accessToken of [undefined, '', null, false, 17, {}]) {
    test(`VM 缺有效 access ${JSON.stringify(accessToken)}：先保存 refresh 后失败，清除旧 expires`, async () => {
        const data = tokenData();
        data.user_info.access_token = accessToken;
        const mock = mockWxService([mockResponse(data)]);
        const session = mockSession({ accessTokenExpiresAt: Date.now() + 3600000 });
        const saved = [];
        const error = await captureFailure(mock.service.refreshLoginBuffer(session, {
            onCredentialsRotated(credentials) { saved.push(credentials); },
        }));
        assert.equal(saved.length, 1, '已轮换 refresh 必须在缺 access 的错误返回前落盘');
        assert.equal(saved[0].refreshtoken, newRefresh);
        assert.equal(saved[0].accessTokenExpiresAt, null);
        assert.equal(session.refreshtoken, newRefresh);
        assert.equal(session.accessTokenExpiresAt, null);
        assert.equal(error.refreshtoken, newRefresh);
        assert.equal(error.accessTokenExpiresAt, null);
        assert.equal(error.stage, 'token_refresh');
        assert.equal(error.type, 'response_invalid');
        assert.equal(error.serverCode, 0);
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.nativeCalls.length, 0);
        assertRedacted(error);
        mock.assertDrained();
    });
}

for (const [name, field, seconds, topLevel] of [
    ['整数', 'expiresIn', 60, false],
    ['规范整数字符串', 'expiresIn', '60', false],
    ['snake 字段', 'expires_in', 120, false],
    ['顶层 camel 字段', 'expiresIn', 90, true],
    ['顶层 snake 字段', 'expires_in', 90, true],
]) {
    test(`VM expires：${name} 使用真实请求时间而非默认有效期`, async () => {
        const data = tokenData();
        delete data.user_info.expiresIn;
        (topLevel ? data : data.user_info)[field] = seconds;
        const mock = mockWxService([mockResponse(data)]);
        const before = Date.now();
        const result = await mock.service.refreshCredentials(mockSession());
        const after = Date.now();
        const requestedAt = Number(mock.requests[0].headers.get('Ual-Access-Timestamp'));
        assert.ok(requestedAt >= before && requestedAt <= after);
        assert.equal(result.accessTokenExpiresAt, requestedAt + Number(seconds) * 1000);
        mock.assertDrained();
    });
}

for (const seconds of [undefined, null, true, false, 0, -1, 1.5, '1.5', ' 60', '60 ', '060', '6e1', '60seconds', '', [], {}, Number.MAX_SAFE_INTEGER]) {
    test(`VM expires：${JSON.stringify(seconds)} 非有效正整数时不默认、不沿用旧期限`, async () => {
        const data = tokenData();
        data.user_info.expiresIn = seconds;
        const mock = mockWxService([mockResponse(data)]);
        const result = await mock.service.refreshCredentials(mockSession({ accessTokenExpiresAt: Date.now() + 3600000 }));
        assert.equal(result.accessTokenExpiresAt, null);
        mock.assertDrained();
    });
}

for (const [name, modify] of [
    ['顶层 openid 不一致', data => { data.openid = 'mock-other-openid'; }],
    ['snake openid 不一致', data => { data.user_info.openid = 'mock-other-openid'; }],
    ['camel openId 不一致', data => { data.userInfo = { openId: 'mock-other-openid' }; }],
    ['open_id 不一致', data => { data.open_id = 'mock-other-openid'; }],
    ['openid 为 null', data => { data.user_info.openid = null; }],
    ['openid 为数字', data => { data.user_info.openid = 42; }],
    ['openid 为 boolean', data => { data.user_info.openid = true; }],
    ['openid 为对象', data => { data.user_info.openid = {}; }],
    ['login_type 非微信', data => { data.user_info.login_type = 'QQ'; }],
    ['loginType 为 boolean', data => { data.loginType = true; }],
    ['loginType 为 null', data => { data.loginType = null; }],
    ['loginType 为浮点', data => { data.loginType = 2.5; }],
    ['嵌套 camel loginType 不一致', data => { data.userInfo = { loginType: 'QQ' }; }],
]) {
    test(`VM identity：${name} 不得修改或落盘凭据`, async () => {
        const data = tokenData();
        modify(data);
        const mock = mockWxService([mockResponse(data)]);
        const session = mockSession();
        let writes = 0;
        const error = await captureFailure(mock.service.refreshCredentials(session, { onCredentialsRotated() { writes++; } }));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(error.type, 'response_invalid');
        assert.equal(error.serverCode, 0);
        assert.equal(writes, 0);
        assert.equal(session.refreshtoken, oldRefresh);
        assert.equal(session.accesstoken, oldAccess);
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.nativeCalls.length, 0);
        assertRedacted(error, ['mock-other-openid', mockOpenid, oldAccess, oldRefresh, newAccess, newRefresh]);
        mock.assertDrained();
    });
}

test('主续期code0响应open_id空默认值不覆盖绑定身份，有效token仍可靠接受', async () => {
    const data = tokenData(); data.user_info.open_id = '';
    const mock = mockWxService([mockResponse(data)]); const session = mockSession(); let saved;
    const result = await mock.service.refreshCredentials(session, { onCredentialsRotated(value) { saved = value; } });
    assert.equal(session.openid, mockOpenid); assert.equal(saved.accesstoken, newAccess);
    assert.equal(saved.refreshtoken, newRefresh); assert.ok(result.accessTokenExpiresAt > Date.now());
    assert.equal(mock.requests.length, 1); mock.assertDrained();
});

for (const loginType of ['WX', '2', 2]) {
    test(`VM identity：微信 loginType ${JSON.stringify(loginType)} 和 camel 凭据合法兼容`, async () => {
        const mock = mockWxService([mockResponse({
            code: '0', userInfo: { openId: mockOpenid, loginType, accessToken: newAccess, refreshToken: newRefresh, expires_in: 60 },
        })]);
        const result = await mock.service.refreshCredentials(mockSession());
        assert.equal(result.accesstoken, newAccess);
        assert.equal(result.refreshtoken, newRefresh);
        mock.assertDrained();
    });
}

for (const refreshToken of ['', null, true, 123, {}, []]) {
    test(`VM refresh token 类型 ${JSON.stringify(refreshToken)} 非法时不落盘`, async () => {
        const data = tokenData();
        data.user_info.refresh_token = refreshToken;
        const mock = mockWxService([mockResponse(data)]);
        const session = mockSession();
        let writes = 0;
        const error = await captureFailure(mock.service.refreshCredentials(session, { onCredentialsRotated() { writes++; } }));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(error.type, 'response_invalid');
        assert.equal(writes, 0);
        assert.equal(session.refreshtoken, oldRefresh);
        assertRedacted(error);
        mock.assertDrained();
    });
}

for (const code of [true, false, null, undefined, 0.5, -101.5, '0.0', '00', ' 0', '0junk', [], {}]) {
    for (const operation of ['refreshCredentials', 'refreshBufferWithAccessToken']) {
        test(`VM ${operation} server code ${JSON.stringify(code)} 不允许强制转成功或使用 msg 猜测`, async () => {
            const data = operation === 'refreshCredentials' ? tokenData() : bufferData();
            Object.assign(data, { code, msg: `code=0 secret=${oldAccess} rotated=${newRefresh}` });
            // buffer 响应也含需脱敏的旋转凭据，不让 msg 数字成为可信错误码。
            if (operation !== 'refreshCredentials') data.user_info = { refresh_token: newRefresh };
            const mock = mockWxService([mockResponse(data)]);
            const session = mockSession();
            let writes = 0;
            const error = await captureFailure(mock.service[operation](session, { onCredentialsRotated() { writes++; } }));
            assert.equal(error.stage, operation === 'refreshCredentials' ? 'token_refresh' : 'login_buffer');
            assert.equal(error.type, 'response_invalid');
            assert.equal(error.code, 'response_invalid');
            assert.equal(error.serverCode, undefined);
            assert.equal(error.wechatCode, undefined, '敏感 token 内的五位数字不能误解析成微信错误码');
            assert.equal(writes, 0);
            assert.equal(session.refreshtoken, oldRefresh);
            assert.equal(session.loginBuffer, undefined);
            assertRedacted(error);
            mock.assertDrained();
        });
    }
}

for (const [name, message] of [
    ['旧凭据', `${mockOpenid} ${oldAccess} ${oldRefresh}`],
    ['响应凭据', `${newAccess} ${newRefresh}`],
    ['编码凭据', `${encodeURIComponent(oldAccess)} ${encodeURIComponent(newRefresh)}`],
    ['非独立数字', 'opaque40188id 40188.5 +40188 -40188 140188 401880'],
    ['非字符串', { code: 40188 }],
]) {
    test(`VM 不可信 msg：${name} 不误 parse wechatCode，不泄露原文`, async () => {
        const mock = mockWxService([mockResponse(tokenData({ code: -101, msg: message }))]);
        const error = await captureFailure(mock.service.refreshCredentials(mockSession()));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(error.serverCode, -101);
        assert.equal(error.code, -101);
        assert.equal(error.wechatCode, undefined);
        assertRedacted(error);
        mock.assertDrained();
    });
}

for (const outerCode of [-101, '-101']) {
    test(`VM buffer：实际 ${JSON.stringify(outerCode)} 内 40188 保留 stage/business/serverCode`, async () => {
        const mock = mockWxService([
            mockResponse(tokenData()),
            mockResponse({ code: outerCode, msg: `GetLoginBuffer error [40188] [invalid scope, rid: mock-only] ${newAccess}` }),
        ]);
        let saved;
        const error = await captureFailure(mock.service.refreshLoginBuffer(mockSession(), credentials => { saved = credentials; }));
        assert.equal(error.stage, 'login_buffer');
        assert.equal(error.business, 'pc_yyb_auth');
        assert.equal(error.type, 'server_rejected');
        assert.equal(error.serverCode, -101);
        assert.equal(error.code, -101);
        assert.equal(error.wechatCode, 40188);
        assert.equal(saved.refreshtoken, newRefresh);
        assert.equal(error.refreshtoken, newRefresh);
        assert.equal(error.accesstoken, newAccess);
        const classification = classifyWxCodeError(error);
        assert.equal(classification.temporary, true);
        assert.equal(classification.reason, '40188_scope');
        assert.equal(mock.requests.length, 2, '不得修改未知 scope 或切业务重试');
        assertRedacted(error);
        mock.assertDrained();
    });
}

for (const [name, data, status, raw, expectedCode] of [
    ['无效 JSON', `not-json ${oldAccess} ${newRefresh}`, 200, true, undefined],
    ['HTTP 502 HTML', `<html>${oldRefresh} ${newAccess}</html>`, 502, true, undefined],
    ['HTTP 401 JSON', { code: -101, msg: `body=${oldAccess}`, user_info: { refresh_token: newRefresh } }, 401, false, -101],
    ['JSON null', null, 200, false, undefined],
    ['JSON array', [{ code: 0 }], 200, false, undefined],
]) {
    for (const operation of ['refreshCredentials', 'refreshBufferWithAccessToken']) {
        test(`VM ${operation}：${name} 返回结构错误不泄露 response body`, async () => {
            const mock = mockWxService([mockResponse(data, { status, raw })]);
            let writes = 0;
            const error = await captureFailure(mock.service[operation](mockSession(), { onCredentialsRotated() { writes++; } }));
            assert.equal(error.stage, operation === 'refreshCredentials' ? 'token_refresh' : 'login_buffer');
            assert.equal(error.type, status === 200 ? 'response_invalid' : 'http_error');
            assert.equal(error.httpStatus, status === 200 ? undefined : status);
            assert.equal(error.serverCode, expectedCode);
            assert.equal(writes, 0);
            assertRedacted(error);
            assert.ok(!error.message.includes('<html>'));
            assert.ok(!error.message.includes('not-json'));
            mock.assertDrained();
        });
    }
}

for (const [name, writer] of [
    ['返回 false', () => false],
    ['异步抛错', async () => {
        const error = new Error(`mock writer failed ${oldRefresh} ${newRefresh} ${encodeURIComponent(newAccess)}`);
        error.cause = new Error(`mock raw cause ${oldAccess}`);
        throw error;
    }],
]) {
    test(`VM callback ${name}：失败不 silent、不进入 buffer，保留 token 阶段和轮换凭据`, async () => {
        const mock = mockWxService([mockResponse(tokenData())]);
        const error = await captureFailure(mock.service.refreshLoginBuffer(mockSession(), { onCredentialsRotated: writer }));
        assert.equal(error.stage, 'persist_rotated');
        assert.equal(error.business, 'pc_yyb');
        assert.equal(error.serverCode, 0);
        assert.equal(error.refreshtoken, newRefresh);
        assert.equal(error.accesstoken, newAccess);
        if (name === '返回 false') assert.equal(error.type, 'credential_persist_failed');
        assert.equal(mock.requests.length, 1);
        assert.equal(mock.nativeCalls.length, 0);
        assertRedacted(error);
        mock.assertDrained();
    });
}

function pendingMockRequest() {
    let notify;
    let aborted = 0;
    let signal;
    const started = new Promise(resolve => { notify = resolve; });
    return {
        started,
        get aborted() { return aborted; },
        get signal() { return signal; },
        response(request) {
            signal = request.signal;
            return new Promise((resolve, reject) => {
                const abort = () => {
                    aborted++;
                    reject(signal.reason);
                };
                signal.addEventListener('abort', abort, { once: true });
                notify();
                if (signal.aborted) abort();
            });
        },
    };
}

for (const phase of ['token', 'buffer']) {
    for (const cancellation of ['signal', 'destroy', 'deadline']) {
        test(`VM ${phase} ${cancellation}：真正 abort HTTP 并清除所有 timer`, async () => {
            const waiting = pendingMockRequest();
            const mock = mockWxService(phase === 'token' ? [waiting.response] : [mockResponse(tokenData()), waiting.response]);
            const session = mockSession();
            const controller = new AbortController();
            const options = cancellation === 'deadline'
                ? { deadline: Date.now() + 150, timeoutMs: 1000 }
                : { signal: controller.signal, timeoutMs: 1000 };
            const pending = captureFailure(mock.service.refreshLoginBuffer(session, options));
            await waiting.started;
            if (cancellation === 'signal') controller.abort(new Error(`mock cancelled ${oldAccess}`));
            if (cancellation === 'destroy') mock.service.destroy(session);
            const error = await pending;
            assert.equal(waiting.signal.aborted, true);
            assert.equal(waiting.aborted, 1);
            assert.equal(error.stage, phase === 'token' ? 'token_refresh' : 'login_buffer');
            assert.equal(mock.requests.length, phase === 'token' ? 1 : 2);
            assert.equal(mock.nativeCalls.length, 0);
            mock.assertDrained();
            assertRedacted(error);
        });
    }
}

test('VM token响应完成时已destroy：先保存服务端新凭据，取消后不进入buffer', async () => {
    let mock; const session = mockSession(); let saved;
    const reply = mockResponse(tokenData());
    reply.arrayBuffer = async () => {
        mock.service.destroy(session);
        return Buffer.from(JSON.stringify(tokenData()));
    };
    mock = mockWxService([reply]);
    const failure = await captureFailure(mock.service.refreshLoginBuffer(session, {
        onCredentialsRotated(value) { saved = value; },
    }));
    assert.equal(saved.refreshtoken, newRefresh);
    assert.equal(saved.accesstoken, newAccess);
    assert.equal(mock.requests.length, 1);
    assertRedacted(failure); mock.assertDrained();
});

test('VM 已取消 signal 和已过 deadline：请求前失败且不留下 timer', async () => {
    for (const options of [{ signal: AbortSignal.abort(new Error('mock pre-aborted')) }, { deadline: Date.now() - 1 }]) {
        const mock = mockWxService();
        const error = await captureFailure(mock.service.refreshCredentials(mockSession(), options));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(mock.requests.length, 0);
        assert.equal(mock.nativeCalls.length, 0);
        mock.assertDrained();
    }
});

for (const hasBuffer of [true, false]) {
    test(`VM issueCode：${hasBuffer ? '有 buffer' : '无 buffer 但 native 可复用缓存'} 时 options 原样透传`, async () => {
        const mock = mockWxService([], async () => 'mock-cached-native-code');
        const session = mockSession(hasBuffer ? { loginBuffer: mockBuffer } : {});
        const options = Object.freeze({ signal: new AbortController().signal, deadline: Date.now() + 10000, timeoutMs: 1000,
            ...(hasBuffer ? {} : { session: { binding: 'synthetic-binding' }, sessionBinding: 'synthetic-binding' }),
        });
        const result = await mock.service.issueCode(session, 'mock-native-app-id', options);
        assert.equal(result, 'mock-cached-native-code');
        assert.equal(mock.nativeCalls.length, 1);
        if (hasBuffer) assert.equal(mock.nativeCalls[0][0], mockBuffer);
        else assert.ok(!mock.nativeCalls[0][0], '无 buffer 由 native mock 的缓存逻辑负责，不伪造 buffer');
        assert.equal(mock.nativeCalls[0][1], 'mock-native-app-id');
        assert.strictEqual(mock.nativeCalls[0][2], options);
        assert.equal(mock.requests.length, 0);
        mock.assertDrained();
    });
}

function callbackResponse(cookies = [
    `openid=${mockOpenid}; Path=/; Secure; HttpOnly`,
    `accesstoken=${oldAccess}; Path=/; Secure; Max-Age=120`,
    `refreshtoken=${oldRefresh}; Path=/; Secure; HttpOnly`,
]) {
    return mockResponse({}, { cookies });
}

test('VM confirm：真实 Set-Cookie 来源被记录，原 host Cookie 发送，scope 仅 configured', async () => {
    const mock = mockWxService([
        request => {
            const url = new URL(request.url);
            assert.equal(url.origin, mockHost);
            assert.equal(url.pathname, '/pc_yyb/pcyyb_oauth');
            assert.equal(url.searchParams.get('login_type'), 'WX');
            assert.equal(url.searchParams.get('code'), 'mock-oauth-code');
            assert.equal(request.headers.get('Cookie'), null);
            return callbackResponse();
        },
        request => {
            assertSignedRequest(request, bufferUrl, 'pc_yyb_auth', authKey);
            assert.equal(request.headers.get('Cookie'), `openid=${mockOpenid}; accesstoken=${oldAccess}; refreshtoken=${oldRefresh}`);
            return mockResponse(bufferData());
        },
    ]);
    const session = { cookies: new Map(), oauthCode: 'mock-oauth-code' };
    const before = Date.now();
    const result = await mock.service.confirm(session);
    const after = Date.now();
    assert.equal(result.openid, mockOpenid);
    assert.equal(result.loginBuffer, mockBuffer);
    assert.equal(session.refreshBusinessId, 'pc_yyb');
    assert.equal(session.credentialSource, 'pc_yyb');
    assert.equal(session.loginType, 'WX');
    assert.equal(session.scope, configuredScope);
    assert.equal(session.appId, 'wxd44977328b36e647');
    assert.equal(session.accessTokenExpiresAt, null);
    assert.equal(session.accessTokenExpirySource, 'unknown');
    assert.equal(session.accessTokenCookieExpirySource, 'cookie_max_age');
    assert.ok(session.accessTokenCookieExpiresAt >= before + 120000 && session.accessTokenCookieExpiresAt <= after + 120000);
    assert.equal(mock.requests.length, 2, 'confirm 不试探其它 scope');
    assert.equal(mock.nativeCalls.length, 0);
    mock.assertDrained();
});

test('VM createQrSession：scope 只使用配置值，二维码请求全部为内存 mock', async () => {
    const mock = mockWxService([
        request => {
            const url = new URL(request.url);
            assert.equal(url.searchParams.get('scope'), configuredScope);
            assert.equal(url.searchParams.get('appid'), 'wxd44977328b36e647');
            return mockResponse('<img src="/connect/qrcode/mock-qr-uuid">', { raw: true });
        },
        mockResponse('mock-image-bytes', { raw: true }),
    ]);
    const result = await mock.service.createQrSession();
    assert.equal(result.session.uuid, 'mock-qr-uuid');
    assert.equal(result.qr.toString(), 'mock-image-bytes');
    assert.equal(mock.requests.length, 2);
    mock.assertDrained();
});

test('VM confirm：预填 Map 不伪造 cookie 原 host 元数据', async () => {
    const mock = mockWxService([mockResponse({})]);
    const session = { oauthCode: 'mock-oauth-code', cookies: new Map([['openid', mockOpenid], ['accesstoken', oldAccess]]) };
    const error = await captureFailure(mock.service.confirm(session));
    assert.match(error.message, /did not provide openid/);
    assert.equal(mock.requests[0].headers.get('Cookie'), null);
    assert.equal(mock.requests.length, 1);
    assert.equal(session.openid, undefined);
    mock.assertDrained();
});

test('VM Cookie：显式最新凭据优先于 confirm 留下的旧 cookie，过期不回退旧 access expires', async () => {
    const mock = mockWxService([
        callbackResponse(), mockResponse(bufferData()),
        request => {
            assert.equal(request.headers.get('Cookie'), `openid=${mockOpenid}; accesstoken=${newAccess}; refreshtoken=${newRefresh}`);
            const data = tokenData();
            delete data.user_info.expiresIn;
            return mockResponse(data);
        },
        request => {
            assert.equal(request.headers.get('Cookie'), `openid=${mockOpenid}; accesstoken=${newAccess}; refreshtoken=${newRefresh}`);
            return mockResponse(bufferData());
        },
    ]);
    const session = { cookies: new Map(), oauthCode: 'mock-oauth-code' };
    await mock.service.confirm(session);
    session.accesstoken = newAccess;
    session.refreshtoken = newRefresh;
    const result = await mock.service.refreshCredentials(session);
    assert.equal(session.cookies.get('accesstoken'), oldAccess, '真实旧 cookie 仍在，不能靠清空 Map 假通过');
    assert.equal(result.accessTokenExpiresAt, null, '旧 access 的 Cookie 期限不适用于新 access');
    await mock.service.refreshBufferWithAccessToken(session);
    assert.equal(mock.requests.length, 4);
    mock.assertDrained();
});

test('VM expires：最新 access 的 Cookie 保存期不能被当成 token 授权期限', async () => {
    const data = tokenData();
    delete data.user_info.expiresIn;
    const mock = mockWxService([mockResponse(data, { cookies: [`accesstoken=${newAccess}; Max-Age=45; Path=/; Secure`] })]);
    const before = Date.now();
    const result = await mock.service.refreshCredentials(mockSession());
    const after = Date.now();
    assert.equal(result.accessTokenExpiresAt, null, 'Cookie Max-Age只约束Cookie存储，不证明授权时效');
    assert.equal(result.accessTokenExpirySource, 'unknown');
    assert.equal(result.accessTokenCookieExpirySource, 'cookie_max_age');
    assert.ok(result.accessTokenCookieExpiresAt >= before + 45000 && result.accessTokenCookieExpiresAt <= after + 45000);
    mock.assertDrained();
});

test('VM expires：延迟 mock 响应仍从真实请求时间计算，不从返回时间加期限', async () => {
    const mock = mockWxService([async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return mockResponse(tokenData());
    }]);
    const result = await mock.service.refreshCredentials(mockSession());
    const requestedAt = Number(mock.requests[0].headers.get('Ual-Access-Timestamp'));
    assert.ok(result.tokenCheckedAt > requestedAt, 'mock 响应应在真实时钟上晚于请求');
    assert.equal(result.accessTokenExpiresAt, requestedAt + 60000);
    assert.notEqual(result.accessTokenExpiresAt, result.tokenCheckedAt + 60000);
    mock.assertDrained();
});

test('VM Cookie：Max-Age=0 删除 cookie，不默认 access 有效期', async () => {
    const data = tokenData();
    delete data.user_info.expiresIn;
    const mock = mockWxService([mockResponse(data, { cookies: [`accesstoken=${newAccess}; Max-Age=0; Path=/`] })]);
    const session = mockSession();
    const result = await mock.service.refreshCredentials(session);
    assert.equal(session.cookies.has('accesstoken'), false);
    assert.equal(result.accessTokenExpiresAt, null);
    mock.assertDrained();
});

for (const status of [302, 303, 307, 308]) {
    test(`VM 跨 host ${status}：不转发 POST body、Cookie 或 token headers`, async () => {
        const redirect = mockResponse({}, { status, location: 'https://mock-redirect.invalid/credential-sink' });
        const shouldFollow = status === 302 || status === 303;
        const mock = mockWxService(shouldFollow ? [redirect, request => {
            assert.equal(new URL(request.url).host, 'mock-redirect.invalid');
            assert.equal(request.method, 'GET');
            assert.equal(request.body, undefined);
            assert.equal(request.headers.get('Cookie'), null);
            assert.equal([...request.headers.keys()].filter(name => name.startsWith('ual-access-')).length, 0);
            assert.ok(![...request.headers.values()].join(' ').includes(oldAccess));
            assert.ok(![...request.headers.values()].join(' ').includes(oldRefresh));
            return mockResponse({ code: -101 });
        }] : [redirect]);
        const error = await captureFailure(mock.service.refreshCredentials(mockSession()));
        assert.equal(error.stage, 'token_refresh');
        assert.equal(mock.requests.length, shouldFollow ? 2 : 1);
        if (!shouldFollow) assert.match(error.message, /redirected to another host/);
        assertRedacted(error);
        mock.assertDrained();
    });
}

test('VM 跨 host GET：删除 access/openid 等 token headers 和原 host Cookie', async () => {
    const mock = mockWxService([
        callbackResponse(), mockResponse(bufferData()),
        request => {
            assert.equal(request.headers.get('Ual-Access-Access-Token'), oldAccess);
            assert.equal(request.headers.get('Ual-Access-Openid'), mockOpenid);
            assert.ok(request.headers.get('Cookie').includes(oldRefresh));
            return mockResponse({}, { status: 302, location: 'https://mock-redirect.invalid/user-info' });
        },
        request => {
            assert.equal(request.headers.get('Cookie'), null);
            assert.equal(request.body, undefined);
            assert.equal([...request.headers.keys()].filter(name => name.startsWith('ual-access-')).length, 0);
            return mockResponse({ code: 0 });
        },
    ]);
    const session = { cookies: new Map(), oauthCode: 'mock-oauth-code' };
    await mock.service.confirm(session);
    await mock.service.fetchUserInfo(session);
    assert.equal(mock.requests.length, 4);
    mock.assertDrained();
});

test('VM confirm：跨 host Set-Cookie 不能伪造原 host 的 OAuth 凭据', async () => {
    const mock = mockWxService([
        mockResponse({}, { status: 302, location: 'https://mock-redirect.invalid/oauth' }),
        request => {
            assert.equal(request.headers.get('Cookie'), null);
            return callbackResponse();
        },
    ]);
    const session = { cookies: new Map(), oauthCode: 'mock-oauth-code' };
    const error = await captureFailure(mock.service.confirm(session));
    assert.match(error.message, /did not provide openid/);
    assert.equal(session.openid, undefined);
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.nativeCalls.length, 0);
    mock.assertDrained();
});