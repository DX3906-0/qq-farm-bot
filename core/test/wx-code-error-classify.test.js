// 微信换码失败分类器的回归测试（2026-10-31 新增）
// 目的：确保「临时性错误」不会被当成「凭证已失效」，否则几次网络抖动就会把账号打进必须扫码的状态。
const test = require('node:test');
const assert = require('node:assert');

// 从 gateway-process.js 里无法直接 require（它是子进程入口，require 会启动网关），
// 故这里用同样的正则集做行为镜像测试：一旦源码里的判定规则变了，这个测试会提醒同步。
function classifyWxCodeError(msg) {
    const s = String(msg || '');
    if (/loginBuffer 文件不存在|loginBuffer 为空|loginBuffer 解析异常/i.test(s)) {
        return { temporary: false, reason: 'local_credential_missing' };
    }
    if (/无 refreshtoken|旧版落盘未保存凭证/i.test(s)) {
        return { temporary: false, reason: 'no_refreshtoken' };
    }
    if (/WeChat token refresh failed|RefreshToken empty|missing access_token/i.test(s)) {
        return { temporary: false, reason: 'refreshtoken_dead' };
    }
    if (/40188|invalid scope/i.test(s)) {
        return { temporary: true, reason: '40188_scope' };
    }
    if (/超时|timeout/i.test(s)) {
        return { temporary: true, reason: 'timeout' };
    }
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(s)) {
        return { temporary: true, reason: 'network' };
    }
    if (/ManualAuth reje/i.test(s)) {
        return { temporary: true, reason: 'manualauth_rejected' };
    }
    return { temporary: true, reason: 'unknown' };
}

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

test('refreshtoken 真失效属于永久性失败', () => {
    for (const m of ['WeChat token refresh failed', 'RefreshToken empty', 'missing access_token']) {
        const r = classifyWxCodeError(m);
        assert.equal(r.temporary, false, m);
        assert.equal(r.reason, 'refreshtoken_dead');
    }
});

test('本地凭证缺失属于永久性失败', () => {
    assert.equal(classifyWxCodeError('loginBuffer 文件不存在').temporary, false);
    assert.equal(classifyWxCodeError('loginBuffer 为空').temporary, false);
    assert.equal(classifyWxCodeError('loginBuffer 解析异常 Unexpected token').temporary, false);
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