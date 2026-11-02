// 网关亚健康退避闸门的回归测试（2026-11-01 新增）
//
// 背景缺陷：网关在"业务请求连续超时 2 次"时发 connection_degraded 通知 worker 暂停业务请求，
// 但 worker 原有实现只在 runUnifiedTick 一处检查退避，而 worker 有 10+ 个独立业务入口
// （农场/帮助/偷菜/邮件/宠物/商店/活动…）完全无视退避，继续往假死连接打请求 →
// pending 堆积 → 更快判死重连 → 消耗一次性 Code → 1006。
// 修法是把闸门下沉到 sendMsgAsync（所有 gateway 请求的唯一必经之路）。
//
// 本测试锁定三个不能退化的行为：
//   ① 退避期业务请求必须被拒，且错误信息明确带"退避"
//   ② 退避期关键请求（心跳/登录）必须放行——退避的意义就是给它们让路
//   ③ clear 后必须立即恢复，不能出现"日志说恢复、实际发不出去"的假恢复
const test = require('node:test');
const assert = require('node:assert');

process.env.FARM_GATEWAY_MODE = '1';
process.env.FARM_ACCOUNT_ID = '99';
process.env.FARM_GATEWAY_SOCK = '/tmp/qq-farm-gateway-test-nonexistent.sock';
process.env.FARM_DATA_DIR = '/tmp/qq-farm-test-backoff';

const gc = require('../src/runtime/gateway-client');

test('退避相关函数都正确导出（防止静默 undefined）', () => {
    for (const f of ['setHealthBackoff', 'clearHealthBackoff', 'isHealthBackoffActive', 'getHealthBackoffState']) {
        assert.equal(typeof gc[f], 'function', `${f} 必须是函数，不能是 undefined`);
    }
});

test('setHealthBackoff 能开启退避，状态可读', () => {
    gc.clearHealthBackoff();
    assert.equal(gc.isHealthBackoffActive(), false);
    gc.setHealthBackoff(3000, '测试原因');
    assert.equal(gc.isHealthBackoffActive(), true);
    const st = gc.getHealthBackoffState();
    assert.equal(st.active, true);
    assert.ok(st.remainingMs > 0 && st.remainingMs <= 3000);
    assert.match(st.reason, /测试原因/);
    gc.clearHealthBackoff();
});

test('退避只延长不缩短（多次 degraded 叠加取最晚到期）', () => {
    gc.clearHealthBackoff();
    gc.setHealthBackoff(2000, '短');
    const first = gc.getHealthBackoffState().remainingMs;
    gc.setHealthBackoff(6000, '长');   // 更长的应覆盖
    const second = gc.getHealthBackoffState().remainingMs;
    assert.ok(second > first, `更长窗口应覆盖短窗口，实际 ${first} -> ${second}`);
    gc.setHealthBackoff(1000, '更短'); // 更短的不能缩短
    const third = gc.getHealthBackoffState().remainingMs;
    assert.ok(third > 3000, `更短窗口不应缩短既有退避，实际 ${third}`);
    gc.clearHealthBackoff();
});

test('clearHealthBackoff 立即解除（不能有残留）', () => {
    gc.setHealthBackoff(60000, '长退避');
    assert.equal(gc.isHealthBackoffActive(), true);
    gc.clearHealthBackoff();
    assert.equal(gc.isHealthBackoffActive(), false);
    assert.equal(gc.getHealthBackoffState().remainingMs, 0);
});

test('退避期业务请求必须被拒，且错误信息带"退避"', async () => {
    gc.setHealthBackoff(5000, '测试退避');
    let err = null;
    try {
        await gc.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0));
    } catch (e) { err = e; }
    gc.clearHealthBackoff();
    assert.ok(err, '业务请求应当抛错而不是静默通过');
    assert.match(err.message, /退避/, `错误信息应明确说明是退避拦截，实际: ${err.message}`);
});

test('退避期心跳/登录等关键请求必须放行（退避的目的是给它们让路）', async () => {
    gc.setHealthBackoff(5000, '测试退避');
    // 注意：这里不能用 `await sendMsgAsync(...)` 直接判定——关键请求被放行后会真的进入
    // requestGate 排队并等 60s 超时（socket 不存在时首帧写失败才会快速失败），
    // 直接 await 会让整个测试卡住 1 分钟以上（实测踩到）。
    // 正确做法：用一个极短超时的竞速，只关心"是否在退避层被立即拒绝"。
    const critical = [
        ['gamepb.userpb.UserService', 'Heartbeat'],
        ['gamepb.userpb.UserService', 'Login'],
        ['gamepb.userpb.UserService', 'Logout'],
    ];
    for (const [svc, method] of critical) {
        const outcome = await Promise.race([
            gc.sendMsgAsync(svc, method, Buffer.alloc(0))
                .then(() => 'resolved')
                .catch((e) => `rejected:${e && e.message}`),
            new Promise((r) => setTimeout(() => r('still-pending'), 300)),
        ]);
        // 关键点：只要不是"被退避拒绝"就算通过（pending 或 socket 错误都说明闸门放行了）
        assert.ok(
            !String(outcome).includes('退避'),
            `${method} 被退避误拦了: ${outcome}`,
        );
    }
    gc.clearHealthBackoff();
});

test('未设置退避时业务请求不受影响（正常路径零开销）', async () => {
    gc.clearHealthBackoff();
    // 同理用竞速判定：无退避时业务请求不应被"退避"拒绝（它会进入正常排队/超时流程）
    const outcome = await Promise.race([
        gc.sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', Buffer.alloc(0))
            .then(() => 'resolved')
            .catch((e) => `rejected:${e && e.message}`),
        new Promise((r) => setTimeout(() => r('still-pending'), 300)),
    ]);
    assert.ok(!String(outcome).includes('退避'), `无退避时不该因退避失败: ${outcome}`);
});

test('退避自然到期后自动失效（无需外部 timer）', async () => {
    gc.setHealthBackoff(120, '超短');
    assert.equal(gc.isHealthBackoffActive(), true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(gc.isHealthBackoffActive(), false, '到期后应自动解除');
    assert.equal(gc.getHealthBackoffState().remainingMs, 0);
});

// 收尾：清理退避状态与连接。
// 注意：关键请求测试会让 sendMsgAsync 在 pending 里挂一个 60s 的请求超时 timer，
// 该 timer 无法从外部清除（pending 是模块私有 Map），因此跑本文件建议加
// `--test-force-exit`，否则 node --test 会等满 60s 才退出（实测 61s → 1.7s）。
test.after(() => {
    try { gc.stop('99'); } catch { }
    try { gc.clearHealthBackoff(); } catch { }
});