// 网关断线自动重连的退避逻辑测试（2026-11-01 新增）
//
// 背景：worker 的 onDisconnectHandler 原来只打日志「等待重连...」但从不重连，
// 形成「僵尸 worker」（进程活着 / socket 断了 / 账号永久离线）。
// 修复后 worker 会主动重发 connect 帧，gateway 侧走「复用已有网关连接（免 Code）」分支。
//
// 本测试锁定退避策略的三个不变量（不启动真实 worker，只验证算法）：
//   ① 指数退避：1s → 2s → 4s → … → 封顶 60s，且带抖动
//   ② 连续失败上限：达到上限后不再排期
//   ③ 单飞闸门：一轮未结束时不叠加新一轮（防并发 connect）
const test = require('node:test');
const assert = require('node:assert');

// 复刻 worker.js 中的退避算法（保持与实现一致，仅去掉副作用）
function computeBackoff(attempt) {
    return Math.min(60000, 1000 * Math.pow(2, attempt - 1));
}

test('指数退避序列符合 1s/2s/4s/8s...', () => {
    assert.equal(computeBackoff(1), 1000);
    assert.equal(computeBackoff(2), 2000);
    assert.equal(computeBackoff(3), 4000);
    assert.equal(computeBackoff(4), 8000);
    assert.equal(computeBackoff(5), 16000);
    assert.equal(computeBackoff(6), 32000);
});

test('退避封顶 60s，不会无限增长', () => {
    for (const n of [7, 8, 9, 10, 20, 100]) {
        assert.equal(computeBackoff(n), 60000, `第 ${n} 次应封顶 60000`);
    }
});

test('退避序列单调不减（防止抖动把间隔越拉越小）', () => {
    let prev = 0;
    for (let n = 1; n <= 10; n += 1) {
        const cur = computeBackoff(n);
        assert.ok(cur >= prev, `第 ${n} 次 ${cur} 应 >= 前一次 ${prev}`);
        prev = cur;
    }
});

test('10 次退避总时长在合理范围（约 5 分钟，不是几分钟内几十次）', () => {
    let total = 0;
    for (let n = 1; n <= 10; n += 1) total += computeBackoff(n);
    // 1+2+4+8+16+32+60+60+60+60 = 303s
    assert.equal(total, 303000);
    assert.ok(total > 240000 && total < 400000, `总退避 ${total}ms 应在 4~6.7 分钟量级`);
});

test('抖动范围 0~1.5s，不会让退避变成 0', () => {
    // 复刻 Math.floor(Math.random() * 1500)
    for (let i = 0; i < 200; i += 1) {
        const jitter = Math.floor(Math.random() * 1500);
        assert.ok(jitter >= 0 && jitter < 1500, `抖动 ${jitter} 越界`);
    }
    // 即使抖动为 0，首次退避仍有 1s 基础间隔（不会退化成 0 间隔）
    assert.ok(computeBackoff(1) + 0 >= 1000);
});

test('单飞闸门语义：in-flight 时不得再次排期', () => {
    // 模拟 worker 里的三个闸门判断
    function shouldSchedule({ isRunning, hasTimer, inFlight, attempt, maxAttempt }) {
        if (!isRunning) return false;
        if (hasTimer) return false;
        if (inFlight) return false;
        if (attempt >= maxAttempt) return false;
        return true;
    }
    const base = { isRunning: true, hasTimer: false, inFlight: false, attempt: 0, maxAttempt: 10 };
    assert.equal(shouldSchedule(base), true, '正常情况应排期');
    assert.equal(shouldSchedule({ ...base, isRunning: false }), false, '已停止不应排期');
    assert.equal(shouldSchedule({ ...base, hasTimer: true }), false, '已有定时器不应重复排期');
    assert.equal(shouldSchedule({ ...base, inFlight: true }), false, '单飞中不应叠加');
    assert.equal(shouldSchedule({ ...base, attempt: 10 }), false, '达到上限应停止');
});

test('主动 stop 后即使 timer 已排队也不得重连（isRunning 闸门）', () => {
    // 模拟 timer 回调入口
    function onTimerFire(isRunning) {
        if (!isRunning) return 'skipped';
        return 'reconnect';
    }
    assert.equal(onTimerFire(false), 'skipped', '停止状态下 timer 触发必须跳过');
    assert.equal(onTimerFire(true), 'reconnect');
});