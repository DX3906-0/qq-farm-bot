'use strict';
/**
 * 奶茶热销中（S4）两段活动窗口的「过期压关」测试。
 *
 * 与 activity-window-automation.test.js 同款思路，但覆盖奶茶特有的**双窗口**语义：
 *   - 经营类（升级/制作/加速/雇佣/买种子）：经营期 1792029600 ~ 1794671998
 *   - 领奖类（收银台/工资/分享/基金）  ：含结算期 1792029600 ~ 1794844799
 *
 * 关键断言：经营期结束后、领奖期结束前，**经营类必须压关、领奖类必须放行**。
 * 这正是「结算期只允许领奖类操作」在配置层的体现，若写错会导致结算期仍发起经营请求被服务端拒绝。
 */

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/models/store');

// 与 store.js 常量一致
const BIZ_START = 1792029600;
const BIZ_END = 1794671998;
const CLAIM_END = 1794844799;

const MILK_TEA_BUSINESS_KEYS = [
    'milk_tea_upgrade',
    'milk_tea_craft',
    'milk_tea_boost',
    'milk_tea_hire',
    'milk_tea_seed_buy',
];
const MILK_TEA_CLAIM_KEYS = [
    'milk_tea_cashier',
    'milk_tea_wages',
    'milk_tea_share_daily',
    'milk_tea_share_rewards',
    'milk_tea_fund_rewards',
];

test('奶茶：经营期内两组开关都不压关', () => {
    const inactive = store.getInactiveActivityAutomationKeys(BIZ_START);
    for (const key of [...MILK_TEA_BUSINESS_KEYS, ...MILK_TEA_CLAIM_KEYS]) {
        assert.strictEqual(inactive.has(key), false, `${key} 经营期内不应被压关`);
    }
});

test('奶茶：经营期开始前，两组开关都压关', () => {
    const inactive = store.getInactiveActivityAutomationKeys(BIZ_START - 1);
    for (const key of [...MILK_TEA_BUSINESS_KEYS, ...MILK_TEA_CLAIM_KEYS]) {
        assert.strictEqual(inactive.has(key), true, `${key} 活动开始前应被压关`);
    }
});

test('奶茶边界：经营期末当秒放行，后 1 秒压关（闭区间）', () => {
    const atEnd = store.getInactiveActivityAutomationKeys(BIZ_END);
    for (const key of MILK_TEA_BUSINESS_KEYS) {
        assert.strictEqual(atEnd.has(key), false, `${key} 经营期末当秒应放行`);
    }
    const afterEnd = store.getInactiveActivityAutomationKeys(BIZ_END + 1);
    for (const key of MILK_TEA_BUSINESS_KEYS) {
        assert.strictEqual(afterEnd.has(key), true, `${key} 经营期后应压关`);
    }
});

test('⭐ 结算期（经营期已过、领奖期未过）：经营类压关、领奖类放行', () => {
    const mid = BIZ_END + 1;
    const inactive = store.getInactiveActivityAutomationKeys(mid);
    for (const key of MILK_TEA_BUSINESS_KEYS) {
        assert.strictEqual(inactive.has(key), true, `${key} 结算期必须压关（服务端会拒绝经营请求）`);
    }
    for (const key of MILK_TEA_CLAIM_KEYS) {
        assert.strictEqual(inactive.has(key), false, `${key} 结算期必须放行（领奖仍可执行）`);
    }
});

test('奶茶边界：领奖期末当秒放行，后 1 秒压关', () => {
    const atEnd = store.getInactiveActivityAutomationKeys(CLAIM_END);
    for (const key of MILK_TEA_CLAIM_KEYS) {
        assert.strictEqual(atEnd.has(key), false, `${key} 领奖期末当秒应放行`);
    }
    const afterEnd = store.getInactiveActivityAutomationKeys(CLAIM_END + 1);
    for (const key of MILK_TEA_CLAIM_KEYS) {
        assert.strictEqual(afterEnd.has(key), true, `${key} 领奖期后应压关`);
    }
});

test('奶茶：窗口外压关后 disableHiddenActivityAutomation 就地置 false', () => {
    const automation = {
        milk_tea_craft: true,       // 经营类，结算期应被压关
        milk_tea_cashier: true,     // 领奖类，结算期应保留
        farm: true,                 // 非活动开关，不应被触碰
    };
    store.disableHiddenActivityAutomation(automation, BIZ_END + 1);
    assert.strictEqual(automation.milk_tea_craft, false, '结算期经营类开关应被置 false');
    assert.strictEqual(automation.milk_tea_cashier, true, '结算期领奖类开关应保持 true');
    assert.strictEqual(automation.farm, true, '非活动开关不应被触碰');
});

test('奶茶：活动完全结束后两组开关都压关', () => {
    const inactive = store.getInactiveActivityAutomationKeys(CLAIM_END + 1);
    for (const key of [...MILK_TEA_BUSINESS_KEYS, ...MILK_TEA_CLAIM_KEYS]) {
        assert.strictEqual(inactive.has(key), true, `${key} 活动结束后应压关`);
    }
});

// ---------------------------------------------------------------------------
// 商品成本字段名兼容性（回归防护）
//
// 历史 bug：normalizeMilkTeaGood 用 normalizeCoreItem 生成 costs，字段名是 itemId；
// 但 milkTeaCanAfford / milkTeaMaxPurchasable 只读 cost.id → toNum(undefined) === 0
// → 与背包任何物品 id 都比不中 → affordable 恒 false、maxPurchasable 恒 0，
// 线上表现为「兑换商店所有种子/商品永远显示不可购买、自动购买种子永不触发」。
// 这里直接对 activity.js 源码做静态断言，确保兼容取值写法没有被改回去。
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

test('奶茶：成本项 id 必须兼容 itemId（normalizeCoreItem 输出）与 id（原始 protobuf）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
    // 存在统一的取值函数
    assert.match(src, /function\s+milkTeaCostItemId\s*\(/, '应存在 milkTeaCostItemId 统一取值函数');
    assert.match(src, /cost\?\.itemId\s*\?\?\s*cost\?\.id/, '取值函数必须同时兼容 itemId 与 id');
    // 两个判定函数都必须走统一取值函数，不得再直接读 cost.id
    const afford = src.match(/function\s+milkTeaCanAfford[\s\S]*?\n\}/);
    const maximum = src.match(/function\s+milkTeaMaxPurchasable[\s\S]*?\n\}/);
    assert.ok(afford, '应存在 milkTeaCanAfford');
    assert.ok(maximum, '应存在 milkTeaMaxPurchasable');
    assert.match(afford[0], /milkTeaCostItemId\s*\(\s*cost\s*\)/, 'milkTeaCanAfford 必须用 milkTeaCostItemId');
    assert.match(maximum[0], /milkTeaCostItemId\s*\(\s*cost\s*\)/, 'milkTeaMaxPurchasable 必须用 milkTeaCostItemId');
    assert.doesNotMatch(afford[0], /toNum\(\s*cost\.id\s*\)/, 'milkTeaCanAfford 不应再直接读 cost.id');
    assert.doesNotMatch(maximum[0], /toNum\(\s*cost\.id\s*\)/, 'milkTeaMaxPurchasable 不应再直接读 cost.id');
});

test('奶茶：库存充足时应判定为可购买（复刻判定逻辑做行为断言）', () => {
    const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const milkTeaCostItemId = cost => toNum(cost?.itemId ?? cost?.id);
    const canAfford = (costs, inventory, count = 1) => {
        const list = (costs || []).filter(c => toNum(c?.count) > 0);
        if (!list.length) return false;
        return list.every(cost => {
            const id = milkTeaCostItemId(cost);
            if (id === 1004) return false;
            const owned = inventory.filter(x => toNum(x?.id) === id)
                .reduce((s, x) => s + BigInt(String(x.count || 0)), 0n);
            return owned >= BigInt(toNum(cost.count)) * BigInt(count);
        });
    };
    const inventory = [{ id: 1001, count: '326434652' }, { id: 1041, count: '10532' }];
    // normalizeCoreItem 形状（itemId）
    assert.strictEqual(canAfford([{ itemId: 1001, count: 10000 }], inventory, 1), true);
    // 原始 protobuf 形状（id）
    assert.strictEqual(canAfford([{ id: 1001, count: 10000 }], inventory, 1), true);
    // 钻石一律不可用
    assert.strictEqual(canAfford([{ itemId: 1004, count: 10 }], inventory, 1), false);
    // 资源不足
    assert.strictEqual(canAfford([{ itemId: 1041, count: 999999 }], inventory, 1), false);
});

// ---------------------------------------------------------------------------
// boost / craft / int64 map key 三项修复（回归防护，2026-10-17 线上日志发现）
//
// 现象（docker logs qq-farm-bot | grep 奶茶热销中）：
//   1) 「使用加速失败: 奶茶操作回包不匹配，请刷新后重试」每轮刷屏。
//      根因：本地 boost 分支缺少「宣传喇叭」库存前置检查（404 有 available()），
//      无喇叭时照样发请求 → 服务端拒绝 → 回包不含 activity_id/operate_type
//      → milkTeaRpc 的严格校验误报成协议错误。
//      线上实测 salesItemId=1042，账号 1 持有 0 个。
//   2) 「制作奶茶失败: 没有可加工的已解锁活动果实」被记成 error。
//      根因：无果实属正常无事可做，应返回 skipped 而非 throw。
//   3) shop.boostCoinPrice 的 8 个 map key 全是控制字符（int64 map key 未规范化）。
// ---------------------------------------------------------------------------

test('奶茶：boost 必须有宣传喇叭库存前置检查（不得无脑发请求）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
    const boost = src.match(/else if \(action === 'boost'\)[\s\S]*?\n  \} else if/);
    assert.ok(boost, '应存在 boost 分支');
    assert.match(boost[0], /salesItemId/, 'boost 分支必须读取 shop.salesItemId');
    assert.match(boost[0], /milkTeaCanAfford\s*\(/, 'boost 分支必须做库存判定');
    assert.match(boost[0], /skipped:\s*true/, '宣传喇叭不足时应返回 skipped 而非发请求');
});

test('奶茶：craft 无果实时应返回 skipped 而不是抛错', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
    const craft = src.match(/else if \(action === 'craft'\)[\s\S]*?\n  \} else if/);
    assert.ok(craft, '应存在 craft 分支');
    assert.match(craft[0], /if \(!uids\.length\) return \{ ok: true, action, skipped: true/,
        '无果实时必须 return skipped，不得 throw');
    assert.doesNotMatch(craft[0], /if \(!uids\.length \|\| uids\.length > 200\) throw/,
        '不得把「无果实」与「超量」合并抛错');
});

// 现象：用户反馈「前端根本点不了兑换种子」。
// 根因：MilkTeaActivityPanel.vue 的兑换按钮写死 `:disabled="operateLoading || !g.available || settling"`，
//       而后端 normalizeMilkTeaGood() 从未下发 available 字段 → `!undefined` 恒为 true → 按钮永久置灰。
test('奶茶：兑换商品必须下发 available 字段（否则前端按钮永久置灰）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
    const fn = src.match(/function\s+normalizeMilkTeaGood[\s\S]*?\n\}/);
    assert.ok(fn, '应存在 normalizeMilkTeaGood');
    assert.match(fn[0], /normalized\.available\s*=/, 'normalizeMilkTeaGood 必须下发 available');
    assert.match(fn[0], /normalized\.maxPurchasable\s*=/, 'available 应复用 maxPurchasable 的判定结果');
    // 前端按钮必须继续绑定 g.available（契约锁定，避免日后改成别的字段名）
    const panel = fs.readFileSync(
        path.join(__dirname, '..', '..', 'web', 'src', 'components', 'activity', 'MilkTeaActivityPanel.vue'),
        'utf8'
    );
    assert.ok(panel.includes('!g.available'), '前端兑换按钮仍应绑定 g.available');
});

test('奶茶：int64 map key 必须规范化（否则面板显示控制字符乱码）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
    assert.match(src, /function\s+milkTeaNormalizeMapKey\s*\(/, '应存在 map key 规范化函数');
    assert.match(src, /longFromHash/, '必须用 protobufjs util.longFromHash 还原 int64 key');
    const cupMap = src.match(/function\s+milkTeaCupMap[\s\S]*?\n\}/);
    assert.ok(cupMap, '应存在 milkTeaCupMap');
    assert.match(cupMap[0], /milkTeaNormalizeMapKey\s*\(/, 'milkTeaCupMap 必须走规范化函数');
});

test('奶茶：int64 map key 规范化行为正确（控制字符 → 十进制字符串）', () => {
    const protobuf = require('protobufjs/minimal');
    const normalize = key => {
        const text = String(key);
        if (![...text].some(ch => ch.charCodeAt(0) < 32)) return text;
        return protobuf.util.longFromHash(text, false).toString();
    };
    // 线上实测的乱码 key：\x03\x00... 对应 3
    assert.strictEqual(normalize('\x03\x00\x00\x00\x00\x00\x00\x00'), '3');
    assert.strictEqual(normalize('\x08\x00\x00\x00\x00\x00\x00\x00'), '8');
    // 已经是正常十进制字符串的原样返回
    assert.strictEqual(normalize('3'), '3');
    assert.strictEqual(normalize('shop'), 'shop');
});
