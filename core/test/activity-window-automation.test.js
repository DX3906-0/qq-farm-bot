'use strict';
/**
 * 活动自动化「过期压关」机制测试。
 *
 * 覆盖两类收口（core/src/models/store.js）：
 *   A. HIDDEN_ACTIVITY_AUTOMATION_KEYS —— 无时间窗，恒压关（鹊桥寄情）
 *   B. TIMED_ACTIVITY_AUTOMATION_GROUPS —— 有窗口，**窗口外才压关**，
 *      窗口内必须放行（换皮返厂自动复活）。
 *
 * 重点验证「边界」语义（404 的 hidden-activity-automation.test.js 同款思路）：
 *   startTime 当秒 = 在窗口内；endTime 当秒 = 在窗口内；endTime+1 = 出窗口。
 */

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/models/store');

const RAIN_POEM_KEYS = [
    'rain_poem_bottle_buy',
    'rain_poem_weather_collect',
    'rain_poem_summon_use',
    'rain_poem_prank_use',
    'rain_poem_research_unlock',
];
const QIXI_KEYS = [
    'qixi_bridge_build',
    'qixi_dew_use',
    'qixi_dew_use_on_friend',
    'qixi_sachet_gift',
];

// 雨落成诗窗口（与 store.js 常量一致）
const RAIN_START = 1787709600;
const RAIN_END = 1788883199;

test('窗口内：活动 key 不出现在压关集合里', () => {
    const mid = RAIN_START + Math.floor((RAIN_END - RAIN_START) / 2);
    const inactive = store.getInactiveActivityAutomationKeys(mid);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(inactive.has(key), false, `${key} 窗口内不应被压关`);
    }
});

test('窗口外（之前）：活动 key 全部进入压关集合', () => {
    const inactive = store.getInactiveActivityAutomationKeys(RAIN_START - 1);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(inactive.has(key), true, `${key} 窗口开始前应被压关`);
    }
});

test('窗口外（之后）：活动 key 全部进入压关集合', () => {
    const inactive = store.getInactiveActivityAutomationKeys(RAIN_END + 1);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(inactive.has(key), true, `${key} 窗口结束后应被压关`);
    }
});

test('边界：startTime 当秒算窗口内（闭区间）', () => {
    const inactive = store.getInactiveActivityAutomationKeys(RAIN_START);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(inactive.has(key), false, `${key} 在 startTime 当秒应放行`);
    }
});

test('边界：endTime 当秒算窗口内，endTime+1 出窗口', () => {
    const atEnd = store.getInactiveActivityAutomationKeys(RAIN_END);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(atEnd.has(key), false, `${key} 在 endTime 当秒应放行`);
    }
    const afterEnd = store.getInactiveActivityAutomationKeys(RAIN_END + 1);
    for (const key of RAIN_POEM_KEYS) {
        assert.strictEqual(afterEnd.has(key), true, `${key} 在 endTime+1 应压关`);
    }
});

test('恒压关集合：无窗口的鹊桥 key 任何时候都被压关', () => {
    const mid = RAIN_START + Math.floor((RAIN_END - RAIN_START) / 2);
    for (const now of [0, mid, RAIN_END + 1, 4102444800 /* 2100 年 */]) {
        const inactive = store.getInactiveActivityAutomationKeys(now);
        for (const key of QIXI_KEYS) {
            assert.strictEqual(inactive.has(key), true, `${key} 在 ${now} 应恒被压关`);
        }
    }
});

test('isActivityWindowActive：缺省 start/end 视为不限（恒活跃）', () => {
    assert.strictEqual(store.isActivityWindowActive({}, 1234567890), true);
    assert.strictEqual(store.isActivityWindowActive({ startTime: 0, endTime: 0 }, 1), true);
});

test('disableHiddenActivityAutomation：只把过期 key 置 false，窗口内的保持原值', () => {
    const mid = RAIN_START + Math.floor((RAIN_END - RAIN_START) / 2);
    // 窗口内：rain_poem_* 与 qixi_* 都为 true，只有 qixi（恒压关）应被置 false
    const automation = {
        rain_poem_bottle_buy: true,
        qixi_dew_use: true,
        autoPlant: true,
    };
    store.disableHiddenActivityAutomation(automation, mid);
    assert.strictEqual(automation.rain_poem_bottle_buy, true, '窗口内活动开关应保持 true');
    assert.strictEqual(automation.qixi_dew_use, false, '恒压关开关应被置 false');
    assert.strictEqual(automation.autoPlant, true, '非活动开关不应被触碰');

    // 窗口外：rain_poem_* 也应被置 false
    const after = { rain_poem_bottle_buy: true, autoPlant: true };
    store.disableHiddenActivityAutomation(after, RAIN_END + 1);
    assert.strictEqual(after.rain_poem_bottle_buy, false, '窗口外活动开关应被置 false');
    assert.strictEqual(after.autoPlant, true, '非活动开关不应被触碰');
});

test('disableHiddenActivityAutomation：非对象入参安全返回', () => {
    assert.strictEqual(store.disableHiddenActivityAutomation(null), null);
    assert.strictEqual(store.disableHiddenActivityAutomation(undefined), undefined);
    const s = 'not-an-object';
    assert.strictEqual(store.disableHiddenActivityAutomation(s), s);
});

test('持久化钩子与读取侧口径一致（同一时刻不矛盾）', () => {
    const mid = RAIN_START + Math.floor((RAIN_END - RAIN_START) / 2);
    const inactive = store.getInactiveActivityAutomationKeys(mid);
    // persistInactiveActivityAutomation 返回「被改动的账号」，但依赖真实 globalConfig；
    // 此处只断言它是函数且调用不抛（无账号时应返回空数组）。
    assert.strictEqual(typeof store.persistInactiveActivityAutomation, 'function');
    const changed = store.persistInactiveActivityAutomation(mid);
    assert.ok(Array.isArray(changed), '应返回数组');
    assert.ok(inactive instanceof Set, '压关集合应为 Set');
});
