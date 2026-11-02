'use strict';
/**
 * 前端「金豆」恒为 0 的回归测试。
 *
 * 背景（2026-10-18 线上实测）：
 *   三个账号背包里都有金豆豆（1005）——罗辑 35695 / 微信 19556 / 希恩斯 29521，
 *   但 /api/status 返回的 status.goldBean 恒为 0，前端 Dashboard 因此一直显示 0。
 *
 * 根因（两层）：
 *   1. gateway 模式下 network.js 的 fetchGoldBeanFromBag() 是**死代码**：
 *      它只在非 gateway 的 sendLogin() 路径里被调用，而 gateway 模式走
 *      gatewayClient.connect()，所以那段代码永远不执行。
 *   2. worker.js 登录后的「背包同步」只读了 1002（点券），漏读 1005（金豆）。
 *      上游实现是在同一次背包请求里 1002 / 1005 一起读。
 *
 * 本测试为静态断言：锁定 worker 侧必须从背包同时同步 1002 与 1005，
 * 避免日后重构时再次漏读（该 bug 无运行时报错，只能靠断言兜住）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'worker.js'),
    'utf8'
);

/** 提取 worker 里那段「登录后同步背包货币」的代码块 */
function extractBagSyncBlock() {
    const marker = '单次背包请求同步点券';
    const idx = WORKER_SRC.indexOf(marker);
    if (idx < 0) return '';
    // 取标记后 1200 字符足够覆盖整个 try/catch 块
    return WORKER_SRC.slice(idx, idx + 1200);
}

test('金豆：worker 背包同步必须同时读取点券(1002)与金豆(1005)', () => {
    const block = extractBagSyncBlock();
    assert.ok(block.length > 0, '未找到 worker 的背包同步代码块');
    assert.ok(
        block.includes('1002'),
        '背包同步必须读取点券 1002'
    );
    assert.ok(
        block.includes('1005'),
        '背包同步必须读取金豆 1005（漏读会导致前端金豆恒为 0）'
    );
});

test('金豆：背包同步必须把金豆写回 userState.goldBean', () => {
    const block = extractBagSyncBlock();
    assert.ok(
        /state\.goldBean\s*=/.test(block),
        '背包同步必须给 state.goldBean 赋值，否则 /api/status 的 goldBean 永远是 0'
    );
    assert.ok(
        /goldBeanCount/.test(block),
        '应存在 goldBeanCount 累加变量'
    );
});

test('金豆：不得再用 break 提前退出背包遍历（会漏掉后面的 1005）', () => {
    const block = extractBagSyncBlock();
    assert.ok(
        !block.includes('break;'),
        '背包遍历中用 break 会在命中 1002 后立即退出，导致 1005 永远读不到；'
        + '必须遍历完整背包（或使用 if/else if 分支）'
    );
});

test('金豆：stats 快照必须透出 status.goldBean', () => {
    const statsSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', 'stats.js'),
        'utf8'
    );
    assert.ok(
        /goldBean:\s*gb/.test(statsSrc),
        'stats.getStats 必须在 status 里返回 goldBean，前端 Dashboard 才能取到值'
    );
    assert.ok(
        /us\.goldBean\s*\?\?\s*fu\.goldBean/.test(statsSrc),
        'goldBean 取值应优先取 userState.goldBean，回退 farmUser.goldBean'
    );
});

test('金豆：前端 Dashboard 从 status.status.goldBean 取数', () => {
    const dashboard = fs.readFileSync(
        path.join(__dirname, '..', '..', 'web', 'src', 'views', 'Dashboard.vue'),
        'utf8'
    );
    assert.ok(
        dashboard.includes('status?.status?.goldBean'),
        'Dashboard 金豆展示必须绑定 status.status.goldBean'
    );
});

test('金豆：持久化统计必须带 statsVersion，且旧版本基线要被丢弃重建', () => {
    const statsSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', 'stats.js'),
        'utf8'
    );
    assert.ok(
        /const STATS_VERSION\s*=\s*\d+/.test(statsSrc),
        'stats.js 必须定义 STATS_VERSION 常量'
    );
    assert.ok(
        /statsVersion:\s*STATS_VERSION/.test(statsSrc),
        'doSave 必须把 statsVersion 写进持久化数据，否则下次启动无法判定版本'
    );
    assert.ok(
        /goldBeanBaselineStale/.test(statsSrc),
        '必须存在旧版本金豆基线的判定（否则升级后首启会显示「今日 +余额」假增益）'
    );
    // 旧版本时不恢复金豆基线
    assert.ok(
        /!goldBeanBaselineStale\s*&&\s*pi\.goldBean/.test(statsSrc),
        '旧版本的金豆基线必须被跳过，改用本次登录值重建'
    );
});
