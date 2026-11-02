'use strict';
/**
 * 活动自动化「过期压关」的**真实落盘**测试。
 *
 * 读取侧压关只能骗过面板与运行时判断，盘上残留的 true 不会被清理。
 * 本测试用子进程 + 独立数据目录（FARM_DATA_DIR）+ 注入的固定时间戳，
 * 验证 persistInactiveActivityAutomation() 真的把 store.json 里的开关写成 false。
 *
 * 思路参考 404 的 inactive-activity-persistence.test.js（子进程隔离 + 假数据目录）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STORE_MODULE = path.join(__dirname, '..', 'src', 'models', 'store.js');

// 雨落成诗窗口（与 store.js 常量一致）
const RAIN_START = 1787709600;
const RAIN_END = 1788883199;
const IN_WINDOW = RAIN_START + 3600;      // 窗口内
const OUT_WINDOW = RAIN_END + 3600;       // 窗口外（之后）

/** 造一个含「过期活动开关为 true」的 store.json，返回数据目录 */
function makeDataDir(automationOverrides) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-window-'));
    // ⚠️ accountConfigs 在 store.json **顶层**（非 globalConfig 下）。
    const store = {
        accountConfigs: {
            '1': {
                id: 1,
                name: '测试账号',
                automation: Object.assign({
                    farm: true,
                    rain_poem_bottle_buy: true,   // 雨落成诗（有窗口）
                    qixi_dew_use: true,           // 鹊桥（无窗口，恒压关）
                }, automationOverrides || {}),
            },
        },
    };
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(store, null, 2), 'utf-8');
    return dir;
}

/** 在子进程里以固定时间戳调用持久化钩子，返回 [changed, storeAfter]。
 *  ⚠️ 必须在 require 之前覆盖 Date.now —— loadGlobalConfig() 的 normalize 会
 *  用「当前时间」判定窗口并就地压关，若不固定时间，测试结果会随真实日期漂移。 */
function runPersist(dir, nowSeconds) {
    const script = `
        const FIXED = ${nowSeconds} * 1000;
        Date.now = function () { return FIXED; };
        const store = require(${JSON.stringify(STORE_MODULE)});
        const changed = store.persistInactiveActivityAutomation(${nowSeconds});
        process.stdout.write(JSON.stringify({ changed }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
        env: Object.assign({}, process.env, { FARM_DATA_DIR: dir }),
        encoding: 'utf-8',
    });
    assert.strictEqual(r.status, 0, `子进程失败: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf-8'));
    return [parsed.changed, after];
}

function automationOf(storeObj) {
    return storeObj.accountConfigs['1'].automation;
}

test('窗口外：盘上的过期活动开关真的被写成 false', () => {
    const dir = makeDataDir();
    try {
        const [changed, after] = runPersist(dir, OUT_WINDOW);
        assert.deepStrictEqual(changed, ['1'], '应报告账号 1 被改动');
        const auto = automationOf(after);
        assert.strictEqual(auto.rain_poem_bottle_buy, false, '窗口外雨落开关应落盘 false');
        assert.strictEqual(auto.qixi_dew_use, false, '恒压关开关应落盘 false');
        assert.strictEqual(auto.farm, true, '非活动开关不应被改动');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('窗口内：活动开关保持 true，只有恒压关的被清', () => {
    const dir = makeDataDir();
    try {
        const [changed, after] = runPersist(dir, IN_WINDOW);
        assert.deepStrictEqual(changed, ['1'], '仍应因鹊桥 key 报告改动');
        const auto = automationOf(after);
        assert.strictEqual(auto.rain_poem_bottle_buy, true, '窗口内雨落开关不应被改');
        assert.strictEqual(auto.qixi_dew_use, false, '恒压关开关应落盘 false');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('无脏数据：不需要改动的账号不报告、也不写盘', () => {
    const dir = makeDataDir();
    try {
        // 先把所有活动开关预置为 false
        const p = path.join(dir, 'store.json');
        const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const auto = s.accountConfigs['1'].automation;
        auto.rain_poem_bottle_buy = false;
        auto.qixi_dew_use = false;
        fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf-8');
        const before = fs.readFileSync(p, 'utf-8');

        const [changed] = runPersist(dir, OUT_WINDOW);
        assert.deepStrictEqual(changed, [], '无脏数据时不应报告改动');
        const afterRaw = fs.readFileSync(p, 'utf-8');
        assert.strictEqual(afterRaw, before, '无脏数据时不应重写文件');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('换皮返厂：窗口内 true 的开关不会被压关（自动复活语义）', () => {
    // 模拟「活动换皮返厂」：store.js 常量更新窗口后，旧配置里残留的 true
    // 在窗口内必须放行 —— 这正是相对手工 RETIRED 列表的核心收益。
    const dir = makeDataDir({ rain_poem_bottle_buy: true });
    try {
        const [, after] = runPersist(dir, IN_WINDOW);
        assert.strictEqual(automationOf(after).rain_poem_bottle_buy, true,
            '窗口内残留 true 应保留（返厂自动复活）');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
