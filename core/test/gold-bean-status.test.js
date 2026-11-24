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

// 统计回归使用隔离 VM、假时钟和临时磁盘；绝不加载 network/worker 或业务 RPC。
const vm = require('node:vm');
const os = require('node:os');
const STATS_SRC = fs.readFileSync(path.join(__dirname, '../src/services/stats.js'), 'utf8');
const HOUR = 3600000;
const START = Date.parse('2026-11-05T04:00:00Z');

function statsFixture(t, at = START) {
    assert.ok(fs.statSync(os.tmpdir()).isDirectory());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-stats-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let now = at;
    const warnings = [];
    const instances = [];
    function restart() {
        const timers = new Map();
        let timerId = 0;
        class FakeDate extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        }
        const context = {
            module: { exports: {} },
            __dirname: path.join(__dirname, '../src/services'),
            Date: FakeDate,
            console: { warn: (...args) => warnings.push(args.join(' ')) },
            setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
            clearTimeout: id => timers.delete(id),
            require: id => {
                if (id === 'node:process') return { env: { FARM_DATA_DIR: dir }, uptime: () => 999999999 };
                if (id === './json-db') return require('../src/services/json-db');
                if (id === './activity') return { getQixiEndedStateCached: () => null };
                if (id.startsWith('node:')) return require(id);
                throw new Error(`模拟禁止加载业务模块 ${id}`);
            }
        };
        vm.runInNewContext(STATS_SRC, context, { filename: 'stats.js' });
        const instance = { stats: context.module.exports, timers };
        instances.push(instance);
        return instance;
    }
    function tick(ms) {
        now += ms;
        for (const instance of instances) {
            for (const [id, timer] of [...instance.timers]) {
                if (timer.due <= now) { instance.timers.delete(id); timer.fn(); }
            }
        }
    }
    function read(accountId) { return JSON.parse(fs.readFileSync(path.join(dir, 'stats', `${accountId}.json`), 'utf8')); }
    function write(accountId, data) {
        assert.ok(fs.statSync(dir).isDirectory());
        fs.mkdirSync(path.join(dir, 'stats'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'stats', `${accountId}.json`), typeof data === 'string' ? data : JSON.stringify(data));
    }
    return { restart, tick, read, write, dir, warnings, now: () => now, setNow: value => { now = value; } };
}

function closeEnough(actual, expected, tolerance = 0.001) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function snapshot(stats, exp, { connected = true, gold = 100, coupon = 20, goldBean = 300, level = 10 } = {}, rateOptions) {
    return stats.getStats({}, { gold, exp, coupon, goldBean, level }, connected, {}, rateOptions);
}

function legacyStats(date, start, end, from = 100, to = 400) {
    return {
        statsVersion: 2, date,
        operations: { harvest: 5 },
        initialState: { gold: 100, exp: from, coupon: 20, goldBean: 300 },
        finalState: { gold: 150, exp: to, coupon: 30, goldBean: 340 },
        session: { goldGained: 50, expGained: to - from, couponGained: 10, goldBeanGained: 40 },
        initialStateAt: start, savedAt: end
    };
}

test('经验：首次登录 seed 不造正速率，有依据的低样本可初估并于2秒内落盘', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 0, 20, 300);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    assert.equal(stats.computeExpRate().sampleCount, 1);
    assert.equal(timers.size, 1);
    f.tick(2000);
    assert.equal(f.read('a').rateState.anchor.exp, 0);
    f.tick(HOUR - 2000);
    stats.updateStats(undefined, 300);
    const rate = stats.computeExpRate();
    closeEnough(rate.expPerHour, 300);
    assert.equal(rate.confidence, 'low');
    assert.equal(rate.sampleCount, 2);
    assert.equal(rate.observedGain, 300);
    assert.equal(timers.size, 1);
    f.tick(2000);
    const disk = f.read('a');
    assert.equal(disk.statsVersion, 2);
    assert.equal(disk.rateState.version, 2);
    assert.equal(disk.rateState.accountId, 'a');
    assert.equal(disk.rateState.intervals[0].gain, 300);
    assert.equal(disk.session.expGained, 300);
    assert.equal(disk.finalState.exp, 300);
    assert.equal(disk.finalStateAt, START + HOUR);
});

test('经验：保存后真正重启恢复同账号历史，登录增量与离线时长不污染速率', t => {
    const f = statsFixture(t);
    const first = f.restart();
    first.stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    first.stats.updateStats(150, 400);
    first.stats.recordOperation('harvest', 5);
    snapshot(first.stats, 400, { gold: 150, coupon: 30, goldBean: 340 });
    first.stats.pauseExpObservations();
    const before = first.stats.computeExpRate();
    const saved = f.read('a');
    assert.equal(saved.session.goldBeanGained, 40);
    f.tick(HOUR);
    const second = f.restart();
    second.stats.initStatsWithPersistence('a', 200, 1000, 40, 350);
    const after = second.stats.computeExpRate();
    closeEnough(after.expPerHour, before.expPerHour);
    closeEnough(after.elapsedHours, 1);
    assert.equal(after.source, 'history');
    assert.equal(after.observedGain, 300);
    assert.equal(after.sampleCount, 2);
    assert.equal(second.stats.getOperationCount('harvest'), 5);
    assert.equal(snapshot(second.stats, 1000, { gold: 200, coupon: 40, goldBean: 350 }).sessionGoldBeanGained, 50);
    second.stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 1);
    f.tick(HOUR);
    second.stats.updateStats(undefined, 1300);
    closeEnough(second.stats.computeExpRate().expPerHour, 300);
    closeEnough(second.stats.computeExpRate().elapsedHours, 2);
    assert.equal(second.stats.computeExpRate().observedGain, 600);
    second.stats.saveStats();
    assert.equal(f.read('a').rateState.intervals[0].source, 'history');
    assert.equal(f.read('a').rateState.intervals[1].source, 'live');
});

test('经验：待写数据跨同进程重登录和切号必须先flush，另一账号严格隔离', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    stats.recordOperation('harvest', 3);
    stats.initStatsWithPersistence('a', 100, 400, 20, 300);
    assert.equal(f.read('a').session.expGained, 300);
    assert.equal(f.read('a').operations.harvest, 3);
    assert.equal(stats.computeExpRate().observedGain, 300);
    assert.equal(timers.size, 1);
    stats.initStatsWithPersistence('b', 10, 5, 0, 7);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    assert.equal(stats.getOperationCount('harvest'), 0);
    assert.equal(f.read('a').rateState.accountId, 'a');
    f.tick(2000);
    assert.equal(f.read('b').rateState.intervals.length, 0);
    stats.initStatsWithPersistence('a', 100, 400, 20, 300);
    closeEnough(stats.computeExpRate().expPerHour, 300);
    assert.equal(stats.getOperationCount('harvest'), 3);
});

test('经验：午夜只重置每日计数收益，不重置6h滚动样本；延迟保存也按跨天处理', t => {
    const f = statsFixture(t, Date.parse('2026-11-05T15:00:00Z'));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(30 * 60000);
    stats.updateStats(150, 400);
    snapshot(stats, 400, { gold: 150, coupon: 30, goldBean: 340 });
    stats.recordOperation('harvest', 5);
    const before = stats.computeExpRate();
    f.tick(30 * 60000 + 1000);
    const today = snapshot(stats, 400, { gold: 150, coupon: 30, goldBean: 340 });
    assert.equal(today.sessionExpGained, 0);
    assert.equal(today.sessionGoldGained, 0);
    assert.equal(today.sessionCouponGained, 0);
    assert.equal(today.sessionGoldBeanGained, 0);
    assert.equal(today.operations.harvest, 0);
    closeEnough(today.expRate.observedGain, before.observedGain);
    closeEnough(today.expRate.expPerHour, 300 * HOUR / (HOUR + 1000));
    assert.equal(stats.getYesterdayStats('a').operations.harvest, 5);
    assert.equal(stats.getYesterdayStats('a').finalState.exp, 400);
    stats.updateStats(180, 500);
    stats.recordOperation('harvest', 1);
    f.tick(2000);
    const disk = f.read('a');
    assert.equal(disk.date, '2026-11-06');
    assert.equal(disk.session.expGained, 100);
    assert.equal(disk.operations.harvest, 1);
    assert.equal(disk.rateState.intervals.length, 2);
});

test('经验：同批burst包含全部gain，重复回包幂等，不用秒级瞬时速率', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 200);
    stats.updateStats(undefined, 250);
    f.tick(1000);
    stats.updateStats(undefined, 300);
    f.tick(1000);
    stats.updateStats(undefined, 400);
    stats.noteExpObservation(400, f.now());
    const rate = stats.computeExpRate();
    closeEnough(rate.expPerHour, 300 * HOUR / (HOUR + 2000));
    assert.equal(rate.observedGain, 300);
    assert.equal(rate.gainCount, 1);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 1);
    assert.equal(f.read('a').rateState.intervals[0].gain, 300);
});

test('经验：真实同值idle纳入时长，缓存getStats/金币钩子不延长经验观测', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    const observedAt = stats.computeExpRate().lastObservedAt;
    f.tick(HOUR);
    for (let i = 0; i < 20; i++) snapshot(stats, 400);
    stats.recordGoldExp(120, 400);
    assert.equal(stats.computeExpRate().lastObservedAt, observedAt);
    closeEnough(stats.computeExpRate().elapsedHours, 1);
    assert.equal(stats.noteExpObservation(400), true);
    const idle = stats.computeExpRate();
    closeEnough(idle.elapsedHours, 2);
    closeEnough(idle.activeRatio, 0.5);
    closeEnough(idle.expPerHour, 150);
    stats.saveStats();
    assert.equal(f.read('a').finalStateAt, f.now());
    assert.equal(f.read('a').rateState.intervals[1].gain, 0);
});

test('经验：无增长从不造正rate，短于30秒无初估，长冻结stale不因缓存读取复活', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(1000);
    stats.updateStats(undefined, 200);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    f.tick(6 * HOUR);
    assert.equal(snapshot(stats, 200).expRate.expPerHour, 0);
    assert.equal(stats.computeExpRate().reason, 'stale');
    stats.updateStats(undefined, 100000);
    assert.equal(stats.computeExpRate().observedGain, 0);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    f.tick(HOUR);
    stats.noteExpObservation(100000);
    assert.equal(stats.computeExpRate().reason, 'idle');
    assert.equal(stats.computeExpRate().expPerHour, 0);
});

test('经验：长离线重启过期旧样本，登录余额跳涨不虚造活跃时间', t => {
    const f = statsFixture(t);
    const first = f.restart();
    first.stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    first.stats.updateStats(undefined, 400);
    first.stats.pauseExpObservations();
    f.tick(24 * HOUR);
    const second = f.restart();
    second.stats.initStatsWithPersistence('a', 100, 100000, 20, 300);
    assert.equal(second.stats.computeExpRate().observedGain, 0);
    assert.equal(second.stats.computeExpRate().elapsedHours, 0);
    assert.equal(second.stats.computeExpRate().expPerHour, 0);
    second.stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 0);
});

test('经验：暂停flush后忽略登录前观测，新login seed后才能采样', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    assert.equal(stats.noteExpObservation(100), false);
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    snapshot(stats, 400, { connected: false });
    f.tick(HOUR);
    assert.equal(stats.noteExpObservation(1000), false);
    assert.equal(f.read('a').rateState.intervals[0].gain, 300);
    stats.initStatsWithPersistence('a', 100, 1000, 20, 300);
    assert.equal(stats.computeExpRate().observedGain, 300);
    f.tick(HOUR);
    stats.noteExpObservation(1300);
    assert.equal(stats.computeExpRate().observedGain, 600);
});

test('经验：累计经验跨等级正常增长；经验回退重置整段，不叠加等级阈值', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    const promoted = snapshot(stats, 400, { level: 11 });
    assert.equal(promoted.expRate.observedGain, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 10);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    assert.equal(stats.computeExpRate().observedGain, 0);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 0);
    f.tick(HOUR);
    stats.updateStats(undefined, 110);
    closeEnough(stats.computeExpRate().expPerHour, 100);
});

test('经验：时钟回退拒绝乱序观测/负速率，非finite/空值不污染磁盘', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    stats.saveStats();
    const before = JSON.stringify(f.read('a').rateState);
    for (const value of [NaN, Infinity, -Infinity, -1, null, undefined, '', true, 1e308]) {
        assert.equal(stats.noteExpObservation(value), false);
        stats.updateStats(value, value);
    }
    assert.equal(stats.noteExpObservation(500, f.now() - 1000), false);
    assert.equal(stats.noteExpObservation(500, NaN), false);
    assert.equal(stats.computeExpRate(f.now() - 1000).expPerHour, 0);
    assert.equal(stats.computeExpRate(f.now() - 1000).reason, 'clock-regression');
    snapshot(stats, NaN, { gold: Infinity, coupon: NaN, goldBean: Infinity });
    stats.saveStats();
    assert.equal(JSON.stringify(f.read('a').rateState), before);
    assert.equal(f.read('a').finalState.exp, 400);
    assert.equal(f.read('a').session.expGained, 300);
    assert.equal(f.read('a').session.goldBeanGained, 0);
    f.setNow(f.now() - 1000);
    stats.updateStats(undefined, 10000);
    stats.saveStats();
    assert.equal(f.read('a').finalState.exp, 400);
    assert.equal(stats.computeExpRate().reason, 'clock-regression');
});

test('经验：旧sameDate有可靠基线时间才迁移初估，金豆v2/每日计数保持', t => {
    const f = statsFixture(t);
    f.write('a', legacyStats('2026-11-05', START - HOUR, START));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 400, 30, 340);
    const rate = stats.computeExpRate();
    closeEnough(rate.expPerHour, 300);
    assert.equal(rate.source, 'history');
    assert.equal(rate.estimate, true);
    assert.equal(stats.getOperationCount('harvest'), 5);
    assert.equal(snapshot(stats, 400, { gold: 150, coupon: 30, goldBean: 340 }).sessionGoldBeanGained, 40);
    stats.saveStats();
    assert.equal(f.read('a').initialState.goldBean, 300);
    assert.equal(f.read('a').statsVersion, 2);
    assert.equal(f.read('a').rateState.intervals[0].source, 'migrated');
});

test('经验：旧数据没有基线timestamp不能猜午夜跨度，v1金豆仍单独迁移', t => {
    const f = statsFixture(t);
    const old = legacyStats('2026-11-05', null, START);
    old.statsVersion = 1;
    old.initialState.goldBean = 0;
    f.write('a', old);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 400, 30, 340);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    assert.equal(stats.computeExpRate().observedGain, 0);
    stats.saveStats();
    assert.equal(f.read('a').initialStateAt, null);
    assert.equal(f.read('a').initialState.goldBean, 340);
    assert.equal(f.read('a').session.goldBeanGained, 0);
    assert.equal(f.read('a').operations.harvest, 5);
});

test('经验：每日历史真实snapshot时间可补可靠跨度，但不使用新登录差额', t => {
    const now = Date.parse('2026-11-05T16:30:00Z');
    const f = statsFixture(t, now);
    const old = legacyStats('2026-11-06', null, now - 60000, 100, 400);
    f.write('a', old);
    assert.ok(fs.statSync(f.dir).isDirectory());
    const historyDir = path.join(f.dir, 'stats-history', 'a');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, '2026-11-05.json'), JSON.stringify({ finalState: { exp: 100 }, savedAt: now - HOUR }));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 10000, 30, 340);
    closeEnough(stats.computeExpRate().expPerHour, 300 * HOUR / (HOUR - 60000));
    assert.equal(stats.computeExpRate().observedGain, 300);
    assert.equal(stats.computeExpRate().source, 'history');
});

test('经验：JSON corruption与样本损坏/账号不匹配都明确warning，拒绝恢复', t => {
    const f = statsFixture(t);
    f.write('a', '{broken');
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    assert.ok(f.warnings.some(w => w.includes('读取统计失败') && w.includes('a.json')));
    assert.equal(stats.computeExpRate().expPerHour, 0);
    for (const [id, sample] of [
        ['b', { version: 1, accountId: 'a', intervals: [] }],
        ['c', { version: 1, accountId: 'c', intervals: [{ start: START - HOUR, end: START, gain: null, source: 'live' }] }],
        ['d', { version: 1, accountId: 'd', anchor: { t: START + HOUR, exp: 400 }, intervals: [{ start: START, end: START + HOUR, gain: 300, source: 'live' }] }]
    ]) {
        f.write(id, { ...legacyStats('2026-11-05', START - HOUR, START), rateState: sample });
        stats.initStatsWithPersistence(id, 150, 400, 30, 340);
        assert.equal(stats.computeExpRate().expPerHour, 0);
    }
    assert.ok(f.warnings.some(w => w.includes('账号不匹配')));
    assert.ok(f.warnings.some(w => w.includes('样本损坏')));
    assert.ok(f.warnings.some(w => w.includes('时间在未来')));
});

test('经验：保存失败必须warning，原子写入不留tmp且采样上限有界', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    for (let i = 1; i <= 450; i++) { f.tick(31000); stats.updateStats(undefined, 100 + i); }
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 400);
    assert.ok(fs.readdirSync(path.join(f.dir, 'stats')).every(name => name.endsWith('.json')));
    const target = path.join(f.dir, 'stats', 'a.json');
    fs.rmSync(target);
    fs.mkdirSync(target);
    stats.saveStats();
    assert.ok(f.warnings.some(w => w.includes('保存账号 a 失败')));
});

test('经验：Dashboard无daily/uptime速率回退，低confidence不封锁实测初估', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/views/Dashboard.vue'), 'utf8');
    const block = src.slice(src.indexOf('const expRateInfo'), src.indexOf('const fertilizerNormal'));
    assert.ok(!block.includes('expRateLabel'));
    assert.ok(!block.includes('仅供参考'));
    assert.ok(!block.includes('历史粗估'));
    assert.ok(!/[（）]/.test(block));
    assert.ok(block.includes('--/小时'));
    assert.ok(block.includes('0/小时'));
    assert.ok(block.includes('暂无法预测'));
    assert.ok(!block.includes('sessionExpGained'));
    assert.ok(!block.includes('sessionExpSec'));
    assert.ok(!block.includes('process.uptime'));
    assert.ok(!block.includes('rate * Math'));
    assert.ok(!/confidence.*return/.test(block));
});

test('经验：执行Dashboard预测计算，历史低样本可预测，stale/idle不伪装数据不足', () => {
    const ts = require('../../web/node_modules/typescript');
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/views/Dashboard.vue'), 'utf8');
    const block = src.slice(src.indexOf('const expRateInfo'), src.indexOf('const fertilizerNormal'));
    const compiled = ts.transpileModule(block + '\nmodule.exports = { expRate, timeToLevel };', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const status = { value: { levelProgress: { current: 100, needed: 400 }, expRate: {
        expPerHour: 150, confidence: 'low', sampleCount: 2, source: 'history', estimate: true,
        activeRatio: 0.1, reason: '', stale: false
    } } };
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
        module, status, computed: fn => ({ get value() { return fn(); } })
    });
    const display = module.exports;
    assert.equal(display.expRate.value, '150/小时');
    assert.equal(display.timeToLevel.value, '约 2.0 小时后升级');
    status.value.expRate.stale = true;
    status.value.expRate.reason = 'stale';
    assert.equal(display.expRate.value, '--/小时');
    assert.equal(display.timeToLevel.value, '暂无法预测');
    status.value.expRate = { expPerHour: 0, reason: 'idle' };
    assert.equal(display.expRate.value, '0/小时');
    assert.equal(display.timeToLevel.value, '暂无法预测');
    status.value.expRate = null;
    assert.equal(display.expRate.value, '--/小时');
    assert.equal(display.timeToLevel.value, '暂无法预测');
    status.value.expRate = { expPerHour: Infinity };
    assert.equal(display.timeToLevel.value, '暂无法预测');
});

test('经验：每日历史snapshot过期或无时间戳不得迁移，坏rate版本不清金豆v2', t => {
    const f = statsFixture(t);
    const base = legacyStats('2026-11-05', START - HOUR, START);
    f.write('a', { ...base, rateState: { version: 99, accountId: 'a', intervals: [] } });
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 400, 30, 340);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    assert.equal(snapshot(stats, 400, { gold: 150, coupon: 30, goldBean: 340 }).sessionGoldBeanGained, 40);
    f.write('b', { ...base, initialStateAt: START - 7 * HOUR });
    stats.initStatsWithPersistence('b', 150, 400, 30, 340);
    assert.equal(stats.computeExpRate().expPerHour, 0);
});

test('经验：无process.uptime参与rate；真实累计经验进度与gameConfig口径一致', () => {
    const config = require('../src/config/gameConfig');
    const table = config.getLevelExpTable();
    const level = 10;
    const progress = config.getLevelExpProgress(level, table[level] + 123);
    assert.equal(progress.current, 123);
    assert.equal(progress.needed, table[level + 1] - table[level]);
    const rateBlock = STATS_SRC.slice(STATS_SRC.indexOf('function computeExpRate'), STATS_SRC.indexOf('function recordOperation'));
    assert.ok(!rateBlock.includes('uptime'));
    assert.ok(!rateBlock.includes('session.expGained'));
});

test('经验：零掉线部署恢复oldloginexp不清历史，首次真通知确认新段后再统计', t => {
    const f = statsFixture(t);
    const first = f.restart();
    first.stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    first.stats.updateStats(undefined, 400);
    first.stats.recordOperation('harvest', 5);
    first.stats.saveStats();
    const observedAt = f.now();
    f.tick(60000);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300, { snapshotOnly: true });
    const workerCache = { gold: 100, exp: 100, coupon: 20, goldBean: 300 };
    const result = stats.getStats({}, workerCache, true, {});
    assert.equal(workerCache.exp, 100, '不得反向patch network缓存');
    assert.equal(result.status.exp, 400);
    assert.equal(result.status.expSource, 'confirmed');
    assert.equal(result.sessionExpGained, 300);
    assert.equal(result.expRate.observedGain, 300);
    assert.equal(result.expRate.lastObservedAt, observedAt);
    closeEnough(result.expRate.expPerHour, 300);
    stats.saveStats();
    assert.equal(f.read('a').rateState.anchor.exp, 400);
    assert.equal(f.read('a').rateState.anchor.snapshotOnly, true);
    assert.equal(f.read('a').finalState.exp, 400);
    assert.equal(f.read('a').finalStateAt, observedAt);
    assert.equal(f.read('a').operations.harvest, 5);
    f.tick(60000);
    stats.updateStats(undefined, 450);
    assert.equal(stats.computeExpRate().observedGain, 300, '缓存seed至首次真通知不形成live区间');
    assert.equal(snapshot(stats, 100).sessionExpGained, 350);
    f.tick(HOUR);
    stats.noteExpObservation(750);
    assert.equal(snapshot(stats, 100).status.exp, 750);
    assert.equal(stats.computeExpRate().observedGain, 600);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 2);
    assert.equal(f.read('a').rateState.intervals[1].gain, 300);
});

test('经验：查询失败同进程resume及连续重启保持confirmed，缓存getter上下跳均不采样', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    stats.initStatsWithPersistence('a', 100, 100, 20, 300, { snapshotOnly: true });
    const observedAt = stats.computeExpRate().lastObservedAt;
    for (const cacheExp of [0, 100, 9999, 400, 50]) {
        const result = snapshot(stats, cacheExp);
        assert.equal(result.status.exp, 400);
        assert.equal(result.sessionExpGained, 300);
        stats.recordGoldExp(100, cacheExp);
        assert.equal(stats.computeExpRate().lastObservedAt, observedAt);
    }
    stats.saveStats();
    f.tick(60000);
    const second = f.restart();
    second.stats.initStatsWithPersistence('a', 100, 100, 20, 300, { snapshotOnly: true });
    assert.equal(snapshot(second.stats, 100).status.exp, 400);
    assert.equal(second.stats.computeExpRate().observedGain, 300);
    second.stats.saveStats();
    assert.equal(f.read('a').rateState.confirmed.exp, 400);
    assert.equal(f.read('a').rateState.confirmed.t, observedAt);
});

test('经验：权威query成功默认false允许真实回退，旧cache不反向抬经验，getter不吞真实reset', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.updateStats(undefined, 400);
    stats.initStatsWithPersistence('a', 100, 10, 20, 300, { snapshotOnly: false });
    assert.equal(stats.computeExpRate().observedGain, 0);
    assert.equal(snapshot(stats, 400).status.exp, 10);
    assert.equal(snapshot(stats, 400).sessionExpGained, -90);
    f.tick(HOUR);
    stats.noteExpObservation(110);
    assert.equal(stats.computeExpRate().observedGain, 100);
    stats.updateStats(undefined, 0);
    const result = snapshot(stats, 9999);
    assert.equal(result.status.exp, 0);
    assert.equal(result.expRate.observedGain, 0);
    stats.saveStats();
    assert.equal(f.read('a').finalState.exp, 0);
    assert.equal(f.read('a').rateState.confirmed.exp, 0);
});

test('经验：snapshotOnly高缓存只设pendingseed，daily和API用confirmed而非虚高缓存', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    stats.initStatsWithPersistence('a', 100, 9999, 20, 300, { snapshotOnly: true });
    stats.saveStats();
    assert.equal(f.read('a').rateState.anchor.exp, 9999);
    assert.equal(f.read('a').finalState.exp, 400);
    assert.equal(f.read('a').session.expGained, 300);
    assert.equal(snapshot(stats, 9999).status.exp, 400);
    f.tick(60000);
    stats.noteExpObservation(450);
    assert.equal(stats.computeExpRate().observedGain, 300, '真实450低于pending但高于confirmed不能清history');
    assert.equal(snapshot(stats, 9999).status.exp, 450);
    assert.equal(snapshot(stats, 9999).sessionExpGained, 350);
    f.tick(60000);
    stats.noteExpObservation(10);
    assert.equal(stats.computeExpRate().observedGain, 0, '低于confirmed的真通知仍清段');
    assert.equal(snapshot(stats, 9999).status.exp, 10);
});

test('经验：snapshotOnly新账号不得借另一号confirmed，首次真实回包建立actual基线', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 1000, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(1300);
    stats.initStatsWithPersistence('b', 10, 5, 0, 7, { snapshotOnly: true });
    assert.equal(snapshot(stats, 5).status.exp, 5);
    assert.equal(snapshot(stats, 5).status.expSource, 'snapshot');
    stats.saveStats();
    assert.equal(f.read('b').rateState.confirmed, null);
    assert.equal(f.read('b').initialStateAt, null);
    f.tick(HOUR);
    stats.noteExpObservation(50);
    assert.equal(snapshot(stats, 5).status.expSource, 'confirmed');
    assert.equal(snapshot(stats, 5).sessionExpGained, 0);
    assert.equal(stats.computeExpRate().observedGain, 0);
    f.tick(HOUR);
    stats.noteExpObservation(150);
    closeEnough(stats.computeExpRate().expPerHour, 100);
    assert.equal(f.read('a').rateState.confirmed.exp, 1300);
});

test('经验：旧缺基线time查询失败可恢复历史余额但只能migrated粗估，savedAt不作live基准', t => {
    const f = statsFixture(t, Date.parse('2026-11-05T16:30:00Z'));
    const now = f.now();
    f.write('a', legacyStats('2026-11-06', null, now - 60000, 100, 400));
    const historyDir = path.join(f.dir, 'stats-history', 'a');
    assert.ok(fs.statSync(f.dir).isDirectory());
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, '2026-11-05.json'), JSON.stringify({ finalState: { exp: 100 }, savedAt: now - HOUR }));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 100, 30, 340, { snapshotOnly: true });
    const result = snapshot(stats, 100);
    assert.equal(result.status.exp, 400);
    assert.equal(result.status.expSource, 'legacy');
    assert.equal(result.expRate.observedGain, 300);
    assert.equal(result.expRate.estimate, true);
    assert.equal(result.expRate.lastObservedAt, now - 60000);
    stats.saveStats();
    assert.equal(f.read('a').initialStateAt, null);
    assert.equal(f.read('a').rateState.intervals[0].source, 'migrated');
    f.tick(60000);
    stats.noteExpObservation(450);
    assert.equal(stats.computeExpRate().observedGain, 300);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 1);
    assert.equal(f.read('a').rateState.confirmed.source, 'actual');
});

test('经验：snapshotOnly午夜confirmed作dailybase，旧login不归零或重复增长', t => {
    const f = statsFixture(t, Date.parse('2026-11-05T15:00:00Z'));
    const first = f.restart();
    first.stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(30 * 60000);
    first.stats.noteExpObservation(400);
    first.stats.pauseExpObservations();
    f.tick(40 * 60000);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300, { snapshotOnly: true });
    assert.equal(snapshot(stats, 100).sessionExpGained, 0);
    assert.equal(snapshot(stats, 100).status.exp, 400);
    assert.equal(stats.computeExpRate().observedGain, 300);
    f.tick(60000);
    stats.noteExpObservation(450);
    assert.equal(snapshot(stats, 100).sessionExpGained, 50);
    stats.saveStats();
    assert.equal(f.read('a').initialState.exp, 400);
    assert.equal(f.read('a').finalState.exp, 450);
});

test('经验：main调用方epoch/gid gating模拟丢弃迟到query，stats不自行猜epoch', async t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    let epoch = 1;
    let resolve;
    const delayedQuery = new Promise(done => { resolve = done; });
    const pending = (async () => {
        const requestEpoch = epoch;
        const reply = await delayedQuery;
        if (requestEpoch !== epoch || reply.gid !== 123) return false;
        stats.initStatsWithPersistence('a', 100, reply.exp, 20, 300, { snapshotOnly: false });
        return true;
    })();
    epoch += 1;
    stats.initStatsWithPersistence('a', 100, 100, 20, 300, { snapshotOnly: true });
    resolve({ gid: 123, exp: 0 });
    assert.equal(await pending, false);
    assert.equal(snapshot(stats, 100).status.exp, 400);
    assert.equal(stats.computeExpRate().observedGain, 300);
    assert.equal(stats.noteExpObservation(450, f.now() - 1), false);
    assert.equal(snapshot(stats, 100).status.exp, 400);
});

test('经验：高pending缓存跨午夜历史final与dailybase仍为confirmed值', t => {
    const f = statsFixture(t, Date.parse('2026-11-05T15:00:00Z'));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(30 * 60000);
    stats.noteExpObservation(400);
    stats.initStatsWithPersistence('a', 100, 9999, 20, 300, { snapshotOnly: true });
    snapshot(stats, 9999);
    f.tick(31 * 60000);
    const result = snapshot(stats, 9999);
    assert.equal(result.status.exp, 400);
    assert.equal(result.sessionExpGained, 0);
    const history = stats.getYesterdayStats('a');
    assert.equal(history.finalState.exp, 400);
    stats.saveStats();
    assert.equal(f.read('a').initialState.exp, 400);
    assert.equal(f.read('a').finalState.exp, 400);
});

test('经验：无rateState无initialStateAt查询失败仅保余额不能猜rate，后续真回退可清段', t => {
    const f = statsFixture(t);
    f.write('a', legacyStats('2026-11-05', null, START));
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 150, 100, 30, 340, { snapshotOnly: true });
    assert.equal(snapshot(stats, 100).status.exp, 400);
    assert.equal(snapshot(stats, 100).status.expSource, 'legacy');
    assert.equal(snapshot(stats, 100).sessionExpGained, 300);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    stats.saveStats();
    assert.equal(f.read('a').initialStateAt, null);
    assert.equal(f.read('a').rateState.intervals.length, 0);
    f.tick(60000);
    stats.noteExpObservation(10);
    assert.equal(snapshot(stats, 400).status.exp, 10);
    assert.equal(snapshot(stats, 400).sessionExpGained, -90);
});


test('经验：恒定收益不因采样频率改变，完整收益除以有效时间', t => {
    const f = statsFixture(t);
    const rates = [];
    for (const step of [60000, 5 * 60000, 15 * 60000]) {
        const { stats } = f.restart();
        stats.initStatsWithPersistence(`constant-${step}`, 100, 0, 20, 300);
        stats.setExpConnectionReady(true);
        for (let elapsed = step; elapsed <= 2 * HOUR; elapsed += step) {
            f.tick(step);
            stats.noteExpObservation(elapsed / 60000 * 10);
        }
        const rate = stats.computeExpRate();
        closeEnough(rate.expPerHour, 600);
        closeEnough(rate.elapsedHours, 2);
        assert.equal(rate.observedGain, 1200);
        rates.push(rate.expPerHour);
        stats.pauseExpObservations();
    }
    assert.ok(rates.every(rate => rate === rates[0]));
});

test('经验：可靠在线无通知持续降速，memo每秒更新但不伪造观测或落盘', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    f.tick(2000);
    const disk = JSON.stringify(f.read('a'));
    const observedAt = START + HOUR;
    const cached = stats.computeExpRate();
    assert.strictEqual(stats.computeExpRate(), cached);
    f.tick(HOUR - 2000);
    const rate = snapshot(stats, 100).expRate;
    closeEnough(rate.expPerHour, 150);
    closeEnough(rate.elapsedHours, 2);
    assert.equal(rate.lastObservedAt, observedAt);
    assert.equal(rate.sampleCount, 2);
    assert.equal(rate.observedGain, 300);
    assert.notStrictEqual(rate, cached);
    assert.equal(timers.size, 0);
    assert.equal(JSON.stringify(f.read('a')), disk);
    f.tick(1000);
    assert.ok(stats.computeExpRate().expPerHour < 150);
    f.tick(5 * HOUR);
    const idle = stats.computeExpRate();
    assert.equal(idle.reason, 'idle');
    assert.equal(idle.expPerHour, 0);
    closeEnough(idle.elapsedHours, 6);
    assert.equal(idle.lastObservedAt, observedAt);
});

test('经验：在线时长由ready事件界定，不把之前未知等待塞入分母', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    f.tick(HOUR);
    closeEnough(stats.computeExpRate().expPerHour, 300);
    snapshot(stats, 400);
    closeEnough(stats.computeExpRate().expPerHour, 300);
    f.tick(HOUR);
    closeEnough(stats.computeExpRate().expPerHour, 150);
    closeEnough(stats.computeExpRate(f.now(), { connected: false }).expPerHour, 300);
});

test('经验：offline flush保留已知等待但不插入真观测，重启排除离线跨度', t => {
    const f = statsFixture(t);
    const first = f.restart();
    first.stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    first.stats.setExpConnectionReady(true);
    f.tick(HOUR);
    first.stats.noteExpObservation(400);
    f.tick(HOUR);
    first.stats.pauseExpObservations();
    const saved = f.read('a');
    assert.equal(saved.rateState.intervals[1].source, 'online');
    assert.equal(saved.rateState.intervals[1].gain, 0);
    assert.equal(saved.finalStateAt, START + HOUR);
    f.tick(HOUR);
    closeEnough(first.stats.computeExpRate().expPerHour, 150);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 10000, 20, 300);
    closeEnough(stats.computeExpRate().expPerHour, 150);
    closeEnough(stats.computeExpRate().elapsedHours, 2);
    assert.equal(stats.computeExpRate().lastObservedAt, f.now());
    assert.equal(stats.computeExpRate().sampleCount, 2);
    assert.equal(stats.computeExpRate().observedGain, 300);
    assert.equal(stats.computeExpRate().source, 'history');
    stats.setExpConnectionReady(true);
    f.tick(HOUR);
    stats.noteExpObservation(10300);
    closeEnough(stats.computeExpRate().expPerHour, 200);
    assert.equal(stats.computeExpRate().observedGain, 600);
});

test('经验：一秒初样保留全部真实收益但不生成百万速率，低样本五分钟可预测', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 0, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(1000);
    stats.noteExpObservation(1000);
    assert.equal(stats.computeExpRate().observedGain, 1000);
    assert.equal(stats.computeExpRate().expPerHour, 0);
    f.tick(299000);
    const rate = stats.computeExpRate();
    closeEnough(rate.expPerHour, 12000);
    assert.equal(rate.confidence, 'low');
    assert.equal(rate.reason, '');
    assert.equal(rate.observedGain, 1000);
    stats.saveStats();
    assert.equal(f.read('a').session.expGained, 1000);
    assert.equal(f.read('a').rateState.intervals[0].gain, 1000);
});

test('经验：近期足够收益时跟随策略升降，凸组合不再系统性向下取min', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 0, 20, 300);
    let exp = 0;
    for (let i = 0; i < 12; i++) { f.tick(15 * 60000); exp += 25; stats.noteExpObservation(exp); }
    closeEnough(stats.computeExpRate().expPerHour, 100);
    for (let i = 0; i < 4; i++) { f.tick(15 * 60000); exp += 100; stats.noteExpObservation(exp); }
    closeEnough(stats.computeExpRate().expPerHour, 0.3 * 175 + 0.7 * 400);
    for (let i = 0; i < 4; i++) { f.tick(15 * 60000); exp += 10; stats.noteExpObservation(exp); }
    closeEnough(stats.computeExpRate().expPerHour, 0.3 * 148 + 0.7 * 40);
    assert.equal(stats.computeExpRate().observedGain, 740);
});

test('经验：高频真实同值10秒节流，真实收益仍2秒保存，重复status不写盘', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(2000);
    const savedAt = f.read('a').savedAt;
    for (let i = 0; i < 7; i++) { f.tick(1000); stats.updateStats(100, 100); }
    assert.equal(f.read('a').savedAt, savedAt);
    assert.equal(timers.size, 1);
    f.tick(1000);
    stats.noteExpObservation(110);
    f.tick(2000);
    assert.equal(f.read('a').finalState.exp, 110);
    assert.equal(f.read('a').savedAt, f.now());
    assert.equal(timers.size, 0);
    const disk = JSON.stringify(f.read('a'));
    for (let i = 0; i < 20; i++) { f.tick(5000); snapshot(stats, 110); stats.recordGoldExp(100, 110); }
    assert.equal(timers.size, 0);
    assert.equal(JSON.stringify(f.read('a')), disk);
    const first = stats.computeExpRate();
    stats.noteExpObservation(120);
    assert.notStrictEqual(stats.computeExpRate(), first);
    assert.equal(stats.computeExpRate().observedGain, 20);
});

function dashboardRefreshFixture() {
    const ts = require('../../web/node_modules/typescript');
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/views/Dashboard.vue'), 'utf8');
    const state = src.slice(src.indexOf('let disposed'), src.indexOf('const filter'));
    const refresh = src.slice(src.indexOf('async function refreshBag'), src.indexOf('function syncRealtimeAccount'));
    const compiled = ts.transpileModule(state + '\n' + refresh + `
module.exports = { refresh, refreshBag, switchTo(id) { currentAccountId.value = id; accountEpoch++; },
  dispose() { disposed = true; accountEpoch++; refreshQueued = false; }, isRefreshCurrent };`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const calls = [];
    const pending = [];
    const watchers = [];
    const module = { exports: {} };
    const bagStore = { allItems: [], originalItems: [], clearBag() { this.allItems = []; this.originalItems = []; } };
    const api = { get: (url, options) => new Promise((resolve, reject) => {
        calls.push([url, options.headers['x-account-id']]); pending.push({ url, resolve, reject });
    }) };
    const statusStore = Object.fromEntries(['fetchStatus', 'fetchAccountLogs', 'fetchLogs'].map(method => [method, id =>
        new Promise(resolve => { calls.push([method, id]); pending.push({ url: method, resolve }); })]));
    vm.runInNewContext(compiled, {
        module, api, statusStore, bagStore, console: { error() {} },
        currentAccountId: { value: 'a' }, currentAccount: { value: { running: true } },
        currentStatusReady: { value: true }, status: { value: { connection: { connected: true } } },
        realtimeConnected: { value: false }, lastBagFetchAt: { value: 0 },
        hasActiveLogFilter: { value: false }, filter: {}, watch: (...args) => watchers.push(args)
    });
    return { ...module.exports, calls, pending, bagStore, watchers };
}

async function flushMicrotasks() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('Dashboard：10秒轮询不重叠，卸载后的status回包不发后续日志背包请求', async () => {
    const f = dashboardRefreshFixture();
    const first = f.refresh();
    assert.strictEqual(f.refresh(), first);
    assert.equal(f.calls.length, 1);
    f.dispose();
    f.pending.shift().resolve();
    await first;
    assert.equal(f.calls.length, 1);
    assert.equal(f.watchers[0][2].flush, 'sync');
});

test('Dashboard：切号epoch阻断旧链，强制刷新合并到新账号不复用旧id', async () => {
    const f = dashboardRefreshFixture();
    const first = f.refresh();
    f.switchTo('b');
    f.refresh(true);
    f.pending.shift().resolve();
    await first;
    await flushMicrotasks();
    assert.deepEqual(f.calls, [['fetchStatus', 'a'], ['fetchStatus', 'b']]);
    f.pending.shift().resolve();
    await flushMicrotasks();
    assert.deepEqual(f.calls.at(-1), ['fetchAccountLogs', 'b']);
    f.pending.shift().resolve();
    await flushMicrotasks();
    assert.deepEqual(f.calls.at(-1), ['fetchLogs', 'b']);
    f.pending.shift().resolve();
    await flushMicrotasks();
    assert.deepEqual(f.calls.at(-1), ['/api/bag', 'b']);
    f.pending.shift().resolve({ data: { ok: true, data: { items: [{ id: 1011 }], originalItems: [] } } });
    await flushMicrotasks();
    assert.equal(f.bagStore.allItems[0].id, 1011);
});

test('Dashboard：背包并发去重，A到B再A及卸载的迟到响应不提交', async () => {
    const f = dashboardRefreshFixture();
    const first = f.refreshBag(true);
    const second = f.refreshBag();
    assert.equal(f.calls.length, 1);
    f.switchTo('b');
    f.switchTo('a');
    f.pending.shift().resolve({ data: { ok: true, data: { items: [{ id: 1005 }] } } });
    await Promise.all([first, second]);
    assert.equal(f.bagStore.allItems.length, 0);
    const third = f.refreshBag(true);
    f.dispose();
    f.pending.shift().resolve({ data: { ok: true, data: { items: [{ id: 1011 }] } } });
    await third;
    assert.equal(f.bagStore.allItems.length, 0);
});

test('status store：同epoch去重，切A到B再A后拒绝迟到数据错误与loading覆盖', async () => {
    const ts = require('../../web/node_modules/typescript');
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/stores/status.ts'), 'utf8');
    const block = src.slice(src.indexOf('  function fetchStatus'), src.indexOf('  async function fetchLogs'));
    const compiled = ts.transpileModule(`
let accountEpoch = 0, statusRequest = 0, statusInFlight = null, currentId = 'a';
const status = { value: null }, error = { value: '' }, loading = { value: false }, statusAccountId = { value: '' };
function isCurrentRequest(id, epoch) { return id === currentId && epoch === accountEpoch; }
function normalizeStatusPayload(data) { return data; }
${block}
module.exports = { fetchStatus, status, error, loading, switchTo(id) { currentId = id; accountEpoch++; } };`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const pending = [];
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, api: { get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } });
    const s = module.exports;
    const first = s.fetchStatus('a');
    assert.strictEqual(s.fetchStatus('a'), first);
    s.switchTo('b');
    const second = s.fetchStatus('b');
    s.switchTo('a');
    const third = s.fetchStatus('a');
    pending[0].resolve({ data: { ok: true, data: { expRate: { expPerHour: 99999 } } } });
    await first;
    assert.equal(s.status.value, null);
    assert.equal(s.loading.value, true);
    pending[1].reject(new Error('旧账号错误'));
    await second;
    assert.equal(s.error.value, '');
    assert.equal(s.loading.value, true);
    pending[2].resolve({ data: { ok: true, data: { expRate: { expPerHour: 300 } } } });
    await third;
    assert.equal(s.status.value.expRate.expPerHour, 300);
    assert.equal(s.loading.value, false);
});

test('经验：拒绝未来真实时间，ready之后的乱序观测不能覆盖余额', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    assert.equal(stats.noteExpObservation(9999, f.now() + 1000), false);
    f.tick(60000);
    stats.setExpConnectionReady(true);
    assert.equal(stats.noteExpObservation(10, f.now() - 1000), false);
    f.setNow(f.now() - 1000);
    stats.updateStats(undefined, 10);
    assert.equal(stats.computeExpRate().reason, 'clock-regression');
    const result = stats.getStats({}, { exp: 10 }, true, {});
    assert.equal(result.status.exp, 400);
    stats.saveStats();
    assert.equal(f.read('a').rateState.confirmed.exp, 400);
});

test('经验：连续秒级收益按30秒批次有界，不永久合成跨6小时大段', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 0, 20, 300);
    for (let i = 1; i <= 360; i++) { f.tick(10000); stats.noteExpObservation(i * 10); }
    const rate = stats.computeExpRate();
    closeEnough(rate.expPerHour, 3600);
    assert.equal(rate.observedGain, 3600);
    assert.equal(rate.gainCount, 120);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 120);
});

test('经验：连续真实idle可滚动裁时长，巨大finite输入、零时长均保持数值有界', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 0, 20, 300);
    for (let i = 0; i < 8; i++) { f.tick(HOUR); stats.noteExpObservation(0); }
    closeEnough(stats.computeExpRate().elapsedHours, 6);
    assert.equal(stats.computeExpRate().reason, 'idle');
    stats.noteExpObservation(Number.MAX_SAFE_INTEGER);
    const rate = stats.computeExpRate();
    assert.equal(rate.observedGain, Number.MAX_SAFE_INTEGER);
    for (const key of ['expPerHour', 'elapsedHours', 'activeRatio', 'activeRatePerHour'])
        assert.ok(Number.isFinite(rate[key]) && rate[key] >= 0);
    assert.ok(rate.activeRatio <= 1);
    assert.equal(stats.noteExpObservation(0, Number.MAX_SAFE_INTEGER), false);
    stats.saveStats();
    assert.ok(f.read('a').rateState.intervals.length <= 400);
});

function recoverStats(stats, at, exp) {
    assert.equal(stats.resumeExpObservations(at), true);
    stats.setExpConnectionReady(true, at);
    if (exp !== undefined) assert.equal(stats.noteExpObservation(exp, at), true);
}

test('经验恢复：同会话100→150暂停→175，累计75但未知25不参与有效速率', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(150);
    stats.recordOperation('harvest', 3);
    stats.pauseExpObservations();
    const baseline = f.read('a').initialState.exp;
    f.tick(1000);
    const before = stats.computeExpRate();
    recoverStats(stats, f.now());
    const diskBefore = f.read('a');
    assert.equal(diskBefore.rateState.confirmed.exp, 150);
    assert.equal(diskBefore.session.expGained, 50);
    assert.equal(stats.computeExpRate().elapsedHours, before.elapsedHours);
    assert.equal(stats.noteExpObservation(175), true);
    const result = snapshot(stats, 1);
    assert.equal(result.status.exp, 175);
    assert.equal(result.sessionExpGained, 75);
    assert.equal(result.expRate.observedGain, 75);
    assert.equal(result.expRate.rateEligibleGain, 50);
    assert.equal(result.expRate.partialGain, 25);
    assert.equal(result.expRate.partialUnknown, true);
    closeEnough(result.expRate.expPerHour, 600);
    closeEnough(result.expRate.elapsedHours, 5 / 60);
    assert.equal(stats.getOperationCount('harvest'), 3);
    stats.saveStats();
    assert.equal(f.read('a').initialState.exp, baseline);
    assert.equal(f.read('a').rateState.intervals.reduce((sum, i) => sum + i.gain, 0), 75);
    assert.equal(f.read('a').rateState.intervals[1].source, 'unknown');
});

test('经验恢复：400→450退化→475收益75，撤销可能重叠的online尾段再持续采样', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 400, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(450);
    f.tick(10000);
    snapshot(stats, 450, { connected: false });
    assert.equal(f.read('a').rateState.intervals[1].source, 'online');
    f.tick(1000);
    recoverStats(stats, f.now(), 475);
    stats.noteExpObservation(475);
    stats.saveStats();
    const disk = f.read('a');
    assert.equal(disk.finalState.exp, 475);
    assert.equal(disk.session.expGained, 75);
    assert.equal(disk.rateState.pendingGap, null);
    assert.equal(disk.rateState.intervals.length, 2);
    assert.equal(disk.rateState.intervals[0].end, disk.rateState.intervals[1].start);
    assert.equal(disk.rateState.intervals[1].gain, 25);
    closeEnough(stats.computeExpRate().expPerHour, 600);
    f.tick(300000);
    stats.noteExpObservation(525);
    assert.equal(stats.computeExpRate().observedGain, 125);
    assert.equal(stats.computeExpRate().rateEligibleGain, 100);
    closeEnough(stats.computeExpRate().elapsedHours, 10 / 60);
    closeEnough(stats.computeExpRate().expPerHour, 600);
});

test('经验恢复：重复resume幂等，不伪造pause→resume零收益或累计未知分母', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(150);
    stats.pauseExpObservations();
    f.tick(HOUR);
    recoverStats(stats, f.now());
    const before = stats.computeExpRate();
    f.tick(2000);
    const disk = JSON.stringify(f.read('a'));
    for (let i = 0; i < 5; i++) {
        f.tick(1000);
        assert.equal(stats.resumeExpObservations(f.now()), true);
        stats.setExpConnectionReady(true);
    }
    assert.equal(timers.size, 0);
    assert.equal(JSON.stringify(f.read('a')), disk);
    closeEnough(stats.computeExpRate().elapsedHours, before.elapsedHours);
    assert.equal(stats.computeExpRate().observedGain, 50);
    recoverStats(stats, f.now(), 175);
    assert.equal(stats.noteExpObservation(175), false);
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.filter(i => i.source === 'unknown').length, 1);
});

test('经验恢复：长未知时段只有可确认收益，未知不显示真实零增长或给正rate', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    stats.pauseExpObservations();
    f.tick(8 * HOUR);
    recoverStats(stats, f.now(), 175);
    const result = stats.computeExpRate();
    assert.equal(result.observedGain, 75);
    assert.equal(result.rateEligibleGain, 0);
    assert.equal(result.partialGain, 75);
    assert.equal(result.expPerHour, 0);
    assert.equal(result.elapsedHours, 0);
    assert.equal(result.reason, 'insufficient');
    stats.saveStats();
    const disk = f.read('a');
    assert.equal(disk.rateState.intervals[0].end - disk.rateState.intervals[0].start, 8 * HOUR);
    f.tick(6 * HOUR + 1000);
    assert.equal(stats.computeExpRate().partialGain, 0);
});

test('经验恢复：无变化回包保留已知online尾段，未知等待排除且区间不重叠', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    f.tick(HOUR);
    stats.pauseExpObservations();
    f.tick(HOUR);
    recoverStats(stats, f.now(), 400);
    closeEnough(stats.computeExpRate().expPerHour, 150);
    closeEnough(stats.computeExpRate().elapsedHours, 2);
    stats.saveStats();
    const intervals = f.read('a').rateState.intervals;
    assert.equal(intervals.length, 3);
    assert.equal(intervals[1].source, 'online');
    assert.equal(intervals[2].source, 'unknown');
    assert.equal(intervals[2].gain, 0);
    assert.equal(intervals[1].end, intervals[2].start);
});

test('经验恢复：未来逆序false时间均拒绝，未初始化不能恢复，首次真实回退仍清段', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    assert.equal(stats.resumeExpObservations(), false);
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(150);
    f.tick(10000);
    stats.pauseExpObservations();
    const disk = JSON.stringify(f.read('a'));
    for (const at of [false, true, null, NaN, Infinity, 0, -1, f.now() - 1, f.now() + 1]) {
        assert.equal(stats.resumeExpObservations(at), false);
        assert.equal(stats.pauseExpObservations(at), false);
        stats.setExpConnectionReady(true, at);
    }
    assert.equal(stats.noteExpObservation(175), false);
    assert.equal(JSON.stringify(f.read('a')), disk);
    f.tick(1000);
    recoverStats(stats, f.now());
    stats.setExpConnectionReady(undefined);
    assert.equal(stats.noteExpObservation(10), true);
    assert.equal(stats.computeExpRate().observedGain, 0);
    assert.equal(snapshot(stats, 175).status.exp, 10);
    assert.equal(snapshot(stats, 175).sessionExpGained, -90);
});

test('经验恢复：v2未知增益重启保留，v1可读取并升级，坏unknown/账号拒绝恢复', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(300000);
    stats.noteExpObservation(150);
    stats.pauseExpObservations();
    f.tick(1000);
    recoverStats(stats, f.now(), 175);
    stats.saveStats();
    const disk = f.read('a');
    f.tick(1000);
    const second = f.restart();
    second.stats.initStatsWithPersistence('a', 100, 1, 20, 300, { snapshotOnly: true });
    assert.equal(second.stats.computeExpRate().observedGain, 75);
    assert.equal(second.stats.computeExpRate().partialGain, 25);
    assert.equal(snapshot(second.stats, 1).status.exp, 175);
    second.stats.noteExpObservation(175);
    f.tick(300000);
    second.stats.noteExpObservation(225);
    assert.equal(second.stats.computeExpRate().observedGain, 125);
    assert.equal(second.stats.computeExpRate().rateEligibleGain, 100);
    const v1 = { ...disk, rateState: { ...disk.rateState, version: 1, accountId: 'b',
        pendingGap: undefined, intervals: [disk.rateState.intervals[0]] } };
    f.write('b', v1);
    second.stats.initStatsWithPersistence('b', 100, 175, 20, 300);
    assert.equal(second.stats.computeExpRate().observedGain, 50);
    second.stats.saveStats();
    assert.equal(f.read('b').rateState.version, 2);
    for (const [id, rateState] of [
        ['c', { ...disk.rateState, accountId: 'c', intervals: [{ ...disk.rateState.intervals[1], observed: true }] }],
        ['d', { ...disk.rateState, accountId: 'a' }],
        ['e', { ...disk.rateState, accountId: 'e', pendingGap: { start: disk.rateState.anchor.t,
            pausedAt: f.now() + 1, resumedAt: null } }],
        ['g', { ...disk.rateState, version: 1, accountId: 'g' }],
    ]) {
        f.write(id, { ...disk, rateState });
        second.stats.initStatsWithPersistence(id, 100, 175, 20, 300);
        assert.equal(second.stats.computeExpRate().observedGain, 0);
    }
    assert.ok(f.warnings.some(w => w.includes('暂停经验区间损坏')));
    assert.ok(f.warnings.some(w => w.includes('样本损坏')));
});

test('经验恢复：首次actual前再次退化扩大未知段，重复pause不插入重叠online', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(150);
    f.tick(10000);
    stats.pauseExpObservations();
    f.tick(1000);
    recoverStats(stats, f.now());
    f.tick(1000);
    stats.pauseExpObservations();
    stats.pauseExpObservations();
    f.tick(1000);
    recoverStats(stats, f.now(), 175);
    stats.saveStats();
    const disk = f.read('a');
    assert.equal(disk.rateState.intervals.length, 2);
    assert.equal(disk.rateState.intervals[1].source, 'unknown');
    assert.equal(disk.rateState.intervals[1].gain, 25);
    assert.equal(disk.rateState.pendingGap, null);
    assert.equal(disk.session.expGained, 75);
    closeEnough(stats.computeExpRate().elapsedHours, 5 / 60);
    closeEnough(stats.computeExpRate().expPerHour, 600);
});

test('经验恢复：待actual的pendingGap可持久化，但切号重启缓存不能伪恢复live', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    f.tick(300000);
    stats.noteExpObservation(150);
    stats.pauseExpObservations();
    f.tick(1000);
    recoverStats(stats, f.now());
    stats.saveStats();
    assert.equal(f.read('a').rateState.pendingGap.resumedAt, f.now());
    assert.equal(f.read('a').rateState.confirmed.exp, 150);
    stats.initStatsWithPersistence('b', 100, 1000, 20, 300, { snapshotOnly: true });
    assert.equal(stats.computeExpRate().observedGain, 0);
    assert.equal(snapshot(stats, 1000).status.expSource, 'snapshot');
    const second = f.restart();
    second.stats.initStatsWithPersistence('a', 100, 1, 20, 300, { snapshotOnly: true });
    second.stats.setExpConnectionReady(true);
    f.tick(1000);
    const cached = snapshot(second.stats, 99999);
    assert.equal(cached.status.exp, 150);
    assert.equal(cached.expRate.observedGain, 50);
    closeEnough(cached.expRate.elapsedHours, 5 / 60);
    second.stats.noteExpObservation(175);
    assert.equal(second.stats.computeExpRate().observedGain, 50, '跨登录缓存仍只设基准，不把离线余额差伪装同会话增益');
    assert.equal(snapshot(second.stats, 1).sessionExpGained, 75);
    f.tick(300000);
    second.stats.noteExpObservation(225);
    assert.equal(second.stats.computeExpRate().observedGain, 100);
});

test('经验恢复：连续暂停恢复仍400有界，同秒memo遇unknown与真观测立即失效', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    for (let i = 1; i <= 210; i++) {
        f.tick(31000);
        stats.noteExpObservation(100 + i * 2 - 1);
        stats.pauseExpObservations();
        f.setNow(f.now() + 1);
        const before = stats.computeExpRate();
        recoverStats(stats, f.now(), 100 + i * 2);
        assert.notStrictEqual(stats.computeExpRate(), before);
    }
    stats.saveStats();
    assert.equal(f.read('a').rateState.intervals.length, 400);
    assert.equal(f.read('a').session.expGained, 420);
    assert.equal(stats.computeExpRate().observedGain, 400);
    assert.equal(stats.computeExpRate().partialGain, 200);
});

test('经验健康：第五参数false允许resume后的actual收益，反复读取不ready不添gap不写盘', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 400, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(450);
    stats.pauseExpObservations();
    f.tick(1000);
    assert.equal(stats.resumeExpObservations(f.now()), true);
    assert.equal(stats.noteExpObservation(475), true);
    const observedAt = f.now();
    f.tick(2000);
    const disk = JSON.stringify(f.read('a'));
    for (let i = 0; i < 12; i++) {
        f.tick(5000);
        const result = snapshot(stats, 450, {}, { connectionReady: false });
        assert.equal(result.connection.connected, true);
        assert.equal(result.status.exp, 475);
        assert.equal(result.status.expObservedAt, observedAt);
        assert.equal(result.sessionExpGained, 75);
        assert.equal(result.expRate.observedGain, 75);
        assert.equal(result.expRate.partialGain, 25);
        assert.equal(result.expRate.rateEligibleGain, 50);
        assert.equal(result.expRate.reason, '');
        closeEnough(result.expRate.elapsedHours, 5 / 60);
        closeEnough(result.expRate.expPerHour, 600);
        assert.equal(timers.size, 0);
    }
    assert.equal(JSON.stringify(f.read('a')), disk);
    closeEnough(stats.computeExpRate().elapsedHours, 5 / 60);
    assert.equal(stats.noteExpObservation(500), true, 'false选项不能暂停后续actual');
    assert.equal(stats.computeExpRate().observedGain, 100);
    assert.equal(stats.computeExpRate().partialGain, 25);
    f.tick(2000);
    assert.equal(f.read('a').rateState.pendingGap, null);
    assert.equal(f.read('a').finalState.exp, 500);
    assert.equal(f.read('a').rateState.intervals.length, 3);
});

test('经验健康：false读取不解除pendingGap，业务恢复true才从确认时刻延伸尾段', t => {
    const f = statsFixture(t);
    const { stats } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(300000);
    stats.noteExpObservation(150);
    stats.pauseExpObservations();
    f.tick(1000);
    stats.resumeExpObservations(f.now());
    f.tick(2000);
    const pendingDisk = JSON.stringify(f.read('a'));
    for (let i = 0; i < 3; i++) {
        f.tick(1000);
        snapshot(stats, 150, {}, { connectionReady: false });
    }
    assert.equal(JSON.stringify(f.read('a')), pendingDisk);
    assert.equal(stats.noteExpObservation(175), true);
    f.tick(HOUR);
    const unhealthy = snapshot(stats, 175, {}, { connectionReady: false });
    closeEnough(unhealthy.expRate.elapsedHours, 5 / 60);
    const readyAt = f.now();
    const healthy = snapshot(stats, 175, {}, { connectionReady: true });
    closeEnough(healthy.expRate.elapsedHours, 5 / 60);
    f.tick(HOUR);
    const later = snapshot(stats, 175, {}, { connectionReady: true });
    closeEnough(later.expRate.elapsedHours, 65 / 60);
    closeEnough(later.expRate.expPerHour, 50 * HOUR / (300000 + HOUR));
    assert.equal(later.expRate.observedGain, 75);
    assert.equal(later.status.expObservedAt, readyAt - HOUR);
    assert.equal(later.sessionExpGained, 75);
    stats.saveStats();
    assert.equal(f.read('a').rateState.pendingGap, null);
    assert.equal(f.read('a').rateState.intervals.length, 2);
});

test('经验健康：已有ready时false不突变状态，同秒false与true结果不误命中memo', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.setExpConnectionReady(true);
    f.tick(HOUR);
    stats.noteExpObservation(400);
    f.tick(HOUR);
    const disk = JSON.stringify(f.read('a'));
    const healthy = snapshot(stats, 400, {}, { connectionReady: true });
    closeEnough(healthy.expRate.expPerHour, 150);
    closeEnough(healthy.expRate.elapsedHours, 2);
    const unhealthy = snapshot(stats, 400, {}, { connectionReady: false });
    closeEnough(unhealthy.expRate.expPerHour, 300);
    closeEnough(unhealthy.expRate.elapsedHours, 1);
    assert.notStrictEqual(unhealthy.expRate, healthy.expRate);
    const healthyAgain = snapshot(stats, 400, {}, { connectionReady: true });
    closeEnough(healthyAgain.expRate.expPerHour, 150);
    closeEnough(healthyAgain.expRate.elapsedHours, 2);
    const legacy = snapshot(stats, 400);
    assert.strictEqual(legacy.expRate, healthyAgain.expRate);
    assert.equal(timers.size, 0);
    assert.equal(JSON.stringify(f.read('a')), disk);
    assert.equal(stats.noteExpObservation(500), true);
    assert.equal(snapshot(stats, 400, {}, { connectionReady: false }).status.exp, 500);
});

test('经验健康：业务false只有未知收益时不是idle，物理断线false仍走暂停接口', t => {
    const f = statsFixture(t);
    const { stats, timers } = f.restart();
    stats.initStatsWithPersistence('a', 100, 100, 20, 300);
    stats.pauseExpObservations();
    f.tick(HOUR);
    stats.resumeExpObservations(f.now());
    stats.noteExpObservation(175);
    f.tick(2000);
    const result = snapshot(stats, 175, {}, { connectionReady: false });
    assert.equal(result.expRate.observedGain, 75);
    assert.equal(result.expRate.rateEligibleGain, 0);
    assert.equal(result.expRate.reason, 'insufficient');
    assert.equal(result.expRate.expPerHour, 0);
    assert.equal(result.expRate.elapsedHours, 0);
    assert.equal(result.sessionExpGained, 75);
    assert.equal(timers.size, 0);
    snapshot(stats, 175, { connected: false }, { connectionReady: true });
    assert.equal(stats.noteExpObservation(200), false);
    assert.equal(f.read('a').rateState.confirmed.exp, 175);
    assert.equal(f.read('a').rateState.pendingGap.resumedAt, null);
});
