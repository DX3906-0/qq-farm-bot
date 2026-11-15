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

// 所有 RPC 和持久化依赖都由离线桩替代，不连接游戏、不改磁盘状态。
const vm = require('node:vm');
const { createRequire } = require('node:module');
function activitySandbox(options = {}) {
    const filename = path.join(__dirname, '..', 'src', 'services', 'activity.js');
    const localRequire = createRequire(filename);
    const calls = [];
    let account = '101';
    let epoch = 1;
    const config = { clientVersion: '测试当前版本' };
    let now = Date.now();
    class FakeDate extends Date { static now() { return now; } }
    let bagReads = 0;
    let decodeCount = 0;
    let group = options.group || {
        group: { head: { activity_id: 2026110100 }, children: [{
            head: { activity_id: 2026110101, begin_time: 1, end_time: 4102444800 },
            milk_tea: { summary: { shop_open_at: 1, can_upgrade: true } },
        }] },
    };
    const wireType = {
        create: value => value,
        encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
        decode: body => { decodeCount++; return JSON.parse(Buffer.from(body).toString()); },
        fields: {},
    };
    const claimField = { resolvedType: { fields: { type: {} } } };
    const contractTypes = options.confirmedClaim ? {
        ActivityOperateRequest: { ...wireType, fields: { qingmei_claim_params: claimField } },
        ActivityGetGroupReply: { ...wireType, fields: { group: { resolvedType: { fields: {
            activity: { resolvedType: { fields: { qingmei_claim_params: claimField } } },
        } } } } },
    } : {};
    const weatherType = { ...wireType, fields: { weather_collect_operate: { resolvedType: { fields: { host_gid: {} } } } } };
    const defaultType = { ...wireType, root: { lookup: name => name === 'gamepb.activitypb.CollectWeatherRequest' ? weatherType : null } };
    const types = new Proxy({}, { get: (_, name) => options.realTypes?.[name] || options.types?.[name] || contractTypes[name] || defaultType });
    const sendMsgAsync = async (service, method, bytes, meta) => {
        const requestType = options.realTypes && (method === 'Operate'
            ? options.realTypes.MilkTeaOperateRequest : options.realTypes.ActivityGetGroupRequest);
        const request = requestType ? requestType.toObject(requestType.decode(bytes), { longs: Number })
            : JSON.parse(Buffer.from(bytes).toString());
        if (options.realTypes && [71, 74].includes(request.operate_type)) {
            const autumn = options.realTypes.MilkTeaOperateRequest.root.lookupType('gamepb.activitypb.AutumnOperateRequest');
            Object.assign(request, autumn.toObject(autumn.decode(bytes), { longs: Number }));
        }
        calls.push({ service, method, request, meta });
        if (options.rpc) {
            const result = await options.rpc(method, request, calls);
            if (result !== undefined) return { body: result };
        }
        if (method === 'GetGroup') return { body: group };
        const field = Object.keys(request).find(k => k !== 'activity_id' && k !== 'operate_type');
        let value = { items: [] };
        if (field === 'milk_tea_get_shop') value = { shop: { sales_item_id: 1042, pending_rewards: [{ id: 1001, count: 5 }] } };
        if (field === 'milk_tea_get_workshop') value = { recipes: [] };
        if (field === 'milk_tea_boost') value = { cups: 1, token_gain: 1 };
        if (field === 'milk_tea_claim_cashier') value = { items: [{ id: 1001, count: 1 }] };
        return { body: { activity_id: request.activity_id, operate_type: request.operate_type, [field]: value } };
    };
    const module = { exports: {} };
    const context = {
        module, exports: module.exports, Buffer, structuredClone, console, Date: FakeDate,
        setTimeout: (callback) => { queueMicrotask(callback); return 0; }, clearTimeout,
        require: name => {
            if (name === '../utils/network') return { sendMsgAsync, isConnected: () => true,
                getUserState: () => ({ gid: account }), getDiagnosticSnapshot: () => ({ connectionEpoch: epoch }) };
            if (name === '../config/config') return { CONFIG: config };
            if (name === '../utils/proto') return { types };
            if (name === '../utils/utils') return { toNum: v => Number(v) || 0, toLong: v => v };
            if (name === './warehouse') return {
                getBag: async () => { bagReads++; return options.bag ? options.bag() : { items: [{ id: 1042, count: 100, uid: 1 }] }; },
                getBagItems: bag => bag?.item_bag?.items || bag?.items || [],
            };
            if (name === './json-db') return { readJsonFile: () => ({}), writeJsonFileAtomic: () => { throw new Error('禁止写盘'); } };
            if (name === '../config/runtime-paths') return { getDataFile: name => name, getDataDir: () => '' };
            if (name === './logger') return { createModuleLogger: () => ({ info() {}, warn() {}, debug() {} }) };
            if (name === '../config/gameConfig') return { getItemById: () => null, getItemImageById: () => '' };
            if (name === './activity-center-helpers' || name === './activity-pet-diary') return {};
            if (name === './friend-api') return options.friendApi || {};
            if (name === './friend-land-analyzer') return { getFriendsList: async () => options.friends || [] };
            return localRequire(name);
        },
    };
    const source = fs.readFileSync(filename, 'utf8');
    vm.runInNewContext(options.sourceTransform ? options.sourceTransform(source) : source, context, { filename });
    return {
        api: module.exports, calls,
        setAccount: value => { account = value; }, setGroup: value => { group = value; },
        setEpoch: value => { epoch = value; }, setVersion: value => { config.clientVersion = value; },
        advance: ms => { now += ms; }, now: () => now,
        bagReads: () => bagReads, decodeCount: () => decodeCount,
    };
}
function deferredActivity() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const page of ['shop', 'upgrade', 'workshop', 'hireList', 'work', 'rank', 'logs', 'exchange', 'fund', 'settings']) {
    test(`奶茶离线：${page} 同键只合并 flight、不保留 TTL`, async () => {
        const box = activitySandbox();
        const [a, b] = await Promise.all([box.api.getMilkTeaActivity(page), box.api.getMilkTeaActivity(page)]);
        assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
        assert.strictEqual(box.bagReads(), 1);
        a.summary.level = 999;
        assert.notStrictEqual(b.summary.level, 999);
        await box.api.getMilkTeaActivity(page);
        assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 2);
        assert.strictEqual(box.decodeCount(), 0, '官方 object 不应再次 decode');
    });
}

for (const [page, left, right] of [
    ['hireList', { durationId: 1 }, { durationId: 2 }],
    ['rank', { pageNumber: 1 }, { pageNumber: 2 }],
    ['logs', { day: 100 }, { day: 200 }],
]) {
    test(`奶茶离线：${page} 参数隔离`, async () => {
        const box = activitySandbox();
        await Promise.all([box.api.getMilkTeaActivity(page, left), box.api.getMilkTeaActivity(page, right)]);
        assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 2);
        const reads = box.calls.filter(c => c.method === 'Operate');
        assert.ok(reads.some(c => Object.values(c.request).some(v => v && typeof v === 'object' && Object.values(v).includes(Object.values(left)[0]))));
        assert.ok(reads.some(c => Object.values(c.request).some(v => v && typeof v === 'object' && Object.values(v).includes(Object.values(right)[0]))));
    });
}

test('奶茶离线：canonical 参数及金币价格不被请求无关字段污染', async () => {
    const box = activitySandbox();
    await Promise.all([
        box.api.getMilkTeaActivity('rank', { pageNumber: 0, price: 1 }),
        box.api.getMilkTeaActivity('rank', { pageNumber: 1, price: 999, name: '不同' }),
    ]);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
    const getGroup = box.calls.find(c => c.method === 'GetGroup').request;
    assert.strictEqual(getGroup.uid, 'MilkTeaMainUI');
    assert.strictEqual(getGroup.id, 2026110100);
});

test('奶茶离线：账户 ID 隔离 flight', async () => {
    const box = activitySandbox();
    const a = box.api.getMilkTeaActivity('exchange').catch(err => err);
    box.setAccount('202');
    const b = box.api.getMilkTeaActivity('exchange');
    const [result] = await Promise.all([a, b]);
    assert.strictEqual(result.code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
});

test('奶茶离线：锁内一次 fresh snapshot、两个真实写不合并', async () => {
    const box = activitySandbox();
    const result = await Promise.all([
        box.api.operateMilkTeaActivity('boost'), box.api.operateMilkTeaActivity('boost'),
    ]);
    assert.ok(result.every(r => r.ok));
    assert.strictEqual(box.bagReads(), 2);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 2);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 2);
    const firstWrite = box.calls.findIndex(c => c.request.operate_type === 60);
    const secondGroup = box.calls.findIndex((c, i) => i > firstWrite && c.method === 'GetGroup');
    assert.ok(secondGroup > firstWrite);
});

test('奶茶离线：下一排队命令重新检查库存，不把前命令 fresh snapshot 当缓存', async () => {
    let stock = 1;
    const box = activitySandbox({
        bag: () => ({ items: [{ id: 1042, count: stock, uid: 1 }] }),
        rpc: async (method, request) => { if (request.operate_type === 60) stock--; },
    });
    const [first, second] = await Promise.all([
        box.api.operateMilkTeaActivity('boost'), box.api.operateMilkTeaActivity('boost'),
    ]);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(box.bagReads(), 2);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 1);
});

test('奶茶离线：入锁后不复用页面旧 flight，写结束后再读不缓存旧价', async () => {
    const gate = deferredActivity();
    let groups = 0;
    const box = activitySandbox({ rpc: async method => {
        if (method === 'GetGroup' && ++groups === 1) await gate.promise;
    } });
    const page = box.api.getMilkTeaActivity('shop').catch(err => err);
    await Promise.resolve();
    await box.api.operateMilkTeaActivity('boost');
    assert.strictEqual(groups, 2);
    await box.api.getMilkTeaActivity('shop');
    assert.strictEqual(groups, 3);
    gate.resolve();
    assert.strictEqual((await page).code, 'ACTIVITY_STALE_RESULT');
    await box.api.getMilkTeaActivity('shop');
    assert.strictEqual(groups, 4);
});

test('奶茶离线：最多 32 个命令，超量明确 skipped', async () => {
    const gate = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') await gate.promise; } });
    const pending = Array.from({ length: 32 }, () => box.api.operateMilkTeaActivity('boost'));
    const overflow = await box.api.operateMilkTeaActivity('boost');
    assert.strictEqual(overflow.skipped, true);
    assert.strictEqual(overflow.reason, 'milk_tea_queue_full');
    gate.resolve();
    await Promise.all(pending);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 32);
});

test('奶茶离线：排队 deadline 已过不读不写', async () => {
    const box = activitySandbox();
    const result = await box.api.operateMilkTeaActivity('boost', {}, { deadlineAt: 0 });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(box.calls.length, 0);
});

test('奶茶离线：命令预读后取消，不能继续真实写', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    const box = activitySandbox({ rpc: async (method, request) => {
        if (request.operate_type === 55) { started.resolve(); await gate.promise; }
    } });
    const controller = new AbortController();
    const command = box.api.operateMilkTeaActivity('boost', {}, { signal: controller.signal });
    await started.promise;
    controller.abort(); gate.resolve();
    assert.strictEqual((await command).skipped, true);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 0);
});

test('奶茶离线：页面取消后停止下一阶段读', async () => {
    const gate = deferredActivity();
    const started = deferredActivity();
    const box = activitySandbox({ rpc: async method => {
        if (method === 'GetGroup') { started.resolve(); await gate.promise; }
    } });
    const controller = new AbortController();
    const page = box.api.getMilkTeaActivity('shop', {}, { signal: controller.signal }).catch(err => err);
    await started.promise;
    controller.abort(); gate.resolve();
    assert.strictEqual((await page).code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual(box.bagReads(), 0);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
});

test('奶茶离线：取消一个读者不会中止共享 flight 的其他读者', async () => {
    const gate = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') await gate.promise; } });
    const controller = new AbortController();
    const a = box.api.getMilkTeaActivity('shop', {}, { signal: controller.signal }).catch(err => err);
    const b = box.api.getMilkTeaActivity('shop');
    controller.abort(); gate.resolve();
    assert.strictEqual((await a).code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual((await b).active, true);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
});

test('奶茶离线：真实写发送后不 abort、不 retry，保留 meta', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    const controller = new AbortController();
    const meta = { code: 1000020 };
    const box = activitySandbox({ rpc: async (method, request) => {
        if (request.operate_type === 60) { started.resolve(); await gate.promise; const err = new Error('写超时'); err.meta = meta; throw err; }
    } });
    const command = box.api.operateMilkTeaActivity('boost', {}, { signal: controller.signal }).catch(err => err);
    await started.promise;
    controller.abort(); gate.resolve();
    const error = await command;
    assert.strictEqual(error.meta, meta);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 1);
    await box.api.getMilkTeaActivity('exchange');
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 2);
});

for (const [title, options] of [
    ['空背包 body', { bag: () => ({}) }],
    ['店铺无 shop', { rpc: async (method, request) => request.operate_type === 55 ? { activity_id: 2026110101, operate_type: 55, milk_tea_get_shop: {} } : undefined }],
    ['缺宣传喇叭契约', { rpc: async (method, request) => request.operate_type === 55 ? { activity_id: 2026110101, operate_type: 55, milk_tea_get_shop: { shop: {} } } : undefined }],
]) {
    test(`奶茶离线：${title} 不伪造成功、不发 boost`, async () => {
        const box = activitySandbox(options);
        const result = await box.api.operateMilkTeaActivity('boost');
        assert.strictEqual(result.skipped, true);
        assert.notStrictEqual(result.ok, true);
        assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 0);
    });
}

test('奶茶离线：写回包只有 envelope 没有结果不得 ok', async () => {
    const box = activitySandbox({ rpc: async (method, request) => request.operate_type === 60
        ? { activity_id: 2026110101, operate_type: 60 } : undefined });
    await assert.rejects(box.api.operateMilkTeaActivity('boost'), /回包不匹配/);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 1);
});

test('奶茶离线：写回包结果对象缺 items 不得伪造成功', async () => {
    const box = activitySandbox({ rpc: async (method, request) => request.operate_type === 59
        ? { activity_id: 2026110101, operate_type: 59, milk_tea_claim_cashier: {} } : undefined });
    await assert.rejects(box.api.operateMilkTeaActivity('claim'), /未返回有效结果/);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 59).length, 1);
});

test('奶茶离线：官方 item_bag.items 背包被正常接受', async () => {
    const box = activitySandbox({ bag: () => ({ item_bag: { items: [] } }) });
    const result = await box.api.getMilkTeaActivity('exchange');
    assert.strictEqual(result.active, true);
    assert.strictEqual(box.bagReads(), 1);
});

test('奶茶离线：并发页内 shop/workshop/bag 不串行等待', async () => {
    const gate = deferredActivity();
    const shopStarted = deferredActivity(), workshopStarted = deferredActivity();
    const box = activitySandbox({ rpc: async (method, request) => {
        if (request.operate_type === 55) { shopStarted.resolve(); await gate.promise; }
        if (request.operate_type === 58) { workshopStarted.resolve(); await gate.promise; }
    } });
    const page = box.api.getMilkTeaActivity('shop');
    await Promise.all([shopStarted.promise, workshopStarted.promise]);
    assert.strictEqual(box.bagReads(), 1);
    gate.resolve(); await page;
});

test('青梅离线：只查询 primary contract，超时无日期/UID/列表重试', async () => {
    const meta = { code: 12345 };
    const box = activitySandbox({ rpc: async () => { const err = new Error('超时'); err.meta = meta; throw err; } });
    const error = await box.api.claimQingmeiSeeds().catch(err => err);
    assert.strictEqual(error.meta, meta);
    assert.strictEqual(box.calls.length, 1);
    assert.strictEqual(box.calls[0].request.id, 2026081200);
    assert.strictEqual(box.calls[0].request.uid, 'QingMeiActivity');
});

test('青梅离线：任意 payload 中 type 不构成官方契约、不写不假已领取', async () => {
    const box = activitySandbox({ group: { group: { activity: { id: 2026081200 }, children: [{
        activity: { id: 2026081201, end_time: 4102444800, payload: JSON.stringify({ qingmei_claim_params: { type: 1 } }) },
    }] } } });
    const a = await box.api.claimQingmeiSeeds();
    const b = await box.api.claimQingmeiSeeds();
    assert.strictEqual(a.reason, 'qingmei_claim_contract_unconfirmed');
    assert.strictEqual(b.skipped, true);
    assert.notStrictEqual(a.ok, true);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
});

test('青梅离线：已确证官方 reqfields 和服务端 type 保留正常领取，只有一次 write', async () => {
    const box = activitySandbox({
        confirmedClaim: true,
        group: { group: { activity: { id: 2026081200 }, children: [{
            activity: { id: 2026081201, end_time: 4102444800, qingmei_claim_params: { type: 3 } },
        }] } },
        rpc: async (method, request) => request.cmd === 4 ? { qingmei_claim: { items: [{ id: 21221, count: 24 }] } } : undefined,
    });
    const result = await box.api.claimQingmeiSeeds();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.claimedCount, 24);
    const writes = box.calls.filter(c => c.method === 'Operate');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].request.qingmei_claim_params.type, 3);
});

test('青梅离线：已确证参数被拒绝也不换 type/gid，不标记假已领取', async () => {
    const box = activitySandbox({
        confirmedClaim: true,
        group: { group: { activity: { id: 2026081200 }, children: [{
            activity: { id: 2026081201, end_time: 4102444800, qingmei_claim_params: { type: 3 } },
        }] } },
        rpc: async (method, request) => { if (request.cmd === 4) throw new Error('1034005'); },
    });
    await assert.rejects(box.api.claimQingmeiSeeds(), /1034005/);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 1);
    await assert.rejects(box.api.claimQingmeiSeeds(), /1034005/);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 2);
});

test('青梅离线：preview 失败保留 stage/code/meta，停止 brew/sell', async () => {
    const meta = { code: 1000020 };
    const box = activitySandbox({
        group: { group: { activity: { id: 2026081200 }, children: [{ activity: { id: 2026081202, end_time: 4102444800 } }] } },
        bag: () => ({ items: [{ id: 41221, uid: 77, count: 5 }] }),
        rpc: async (method, request) => { if (request.cmd === 14) { const err = new Error('预览失败'); err.code = 1000020; err.meta = meta; throw err; } },
    });
    const error = await box.api.brewAndSellQingmeiWine().catch(err => err);
    assert.strictEqual(error.stage, 'preview');
    assert.strictEqual(error.code, 1000020);
    assert.strictEqual(error.meta, meta);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 1);
});

const officialProto = require('../src/utils/proto');
function encodeMilkTeaGroup(group) {
    const type = officialProto.types.MilkTeaGetGroupReply;
    return type.encode(type.create(group)).finish();
}

test('奶茶真实协议：当前 202611 在期组保留 shop/workshop/价格 map，无 UID/type probe', async () => {
    await officialProto.loadProto();
    const types = officialProto.types;
    const group = encodeMilkTeaGroup({ group: { head: { activity_id: 2026110100 }, children: [{
        head: { activity_id: 2026110101, begin_time: BIZ_START, end_time: CLAIM_END, settle_start_time: BIZ_END + 1 },
        milk_tea: { summary: { shop_open_at: BIZ_START, level: 1 } },
    }] } });
    const box = activitySandbox({ realTypes: types, rpc: async (method, request) => {
        if (method === 'GetGroup') return group;
        const field = Object.keys(request).find(k => !['activity_id', 'operate_type'].includes(k));
        const payload = field === 'milk_tea_get_shop'
            ? { shop: { sales_item_id: 1042, boost_coin_price: { 3: 9876 } } }
            : { recipes: [{ recipe_id: 2, token_price: 23, coin_price: 456, clear_coin_total: 789 }] };
        return types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
            activity_id: request.activity_id, operate_type: request.operate_type, [field]: payload,
        })).finish();
    } });
    const state = await box.api.getMilkTeaActivity('shop');
    assert.strictEqual(state.active, true);
    assert.strictEqual(state.phase, 'business');
    assert.strictEqual(state.shop.boostCoinPrice['3'], 9876);
    assert.strictEqual(state.recipes[0].coinPrice, 456);
    assert.strictEqual(state.recipes[0].clearCoinTotal, 789);
    assert.deepStrictEqual(box.calls.map(c => c.request.operate_type || c.request.uid), ['MilkTeaMainUI', 55, 58]);
});

test('奶茶真实协议：cmd1 种子购买不因省略空 cond_hints 退化，两命令 fresh 限购', async () => {
    const types = officialProto.types;
    let bought = 0;
    const box = activitySandbox({ realTypes: types,
        bag: () => ({ item_bag: { items: [{ id: 1041, count: 100 }] } }),
        rpc: async (method, request) => {
            if (method === 'GetGroup') return encodeMilkTeaGroup({ group: { children: [
                { head: { activity_id: 2026110101, begin_time: BIZ_START, end_time: CLAIM_END }, milk_tea: { summary: { shop_open_at: BIZ_START } } },
                { head: { activity_id: 2026110102 }, shop: { goods: [{ id: 11, purchase_limit: 1, purchased_count: bought,
                    cost: [{ id: 1041, count: 10 }], item: [{ id: 201611, count: 1 }], category_tag: 'seed' }] } },
            ] } });
            assert.strictEqual(request.operate_type, 1);
            assert.strictEqual(request.activity_id, 2026110102);
            bought++;
            return types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({ activity_id: 2026110102,
                operate_type: 1, shop_buy: { awards: [{ id: 201611, count: 1 }] } })).finish();
        },
    });
    const a = box.api.operateMilkTeaActivity('seedBuy');
    const b = box.api.operateMilkTeaActivity('seedBuy').catch(err => err);
    assert.strictEqual((await a).ok, true);
    assert.match((await b).message, /暂无可购买/);
    assert.strictEqual(box.bagReads(), 2);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 1);
});

async function milkTeaSeedFixture(goods, options = {}) {
    if (!officialProto.types.MilkTeaGetGroupReply) await officialProto.loadProto();
    const types = officialProto.types;
    return activitySandbox({ ...options, realTypes: types,
        bag: options.bag || (() => ({ items: [1000, 1001, 1002, 1004, 1005, 1041, 9999].map(id => ({ id, count: 100000 })) })),
        rpc: async (method, request) => {
            if (method === 'GetGroup') return encodeMilkTeaGroup({ group: { children: [
                { head: { activity_id: 2026110101, begin_time: BIZ_START, end_time: CLAIM_END }, milk_tea: { summary: { shop_open_at: BIZ_START } } },
                { head: { activity_id: 2026110102 }, shop: { goods: typeof goods === 'function' ? goods() : goods } },
            ] } });
            assert.strictEqual(request.operate_type, 1, '种子夹具禁止其他业务操作');
            return types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({ activity_id: request.activity_id,
                operate_type: 1, shop_buy: { awards: [{ id: 20525, count: 1 }] } })).finish();
        },
    });
}
function milkTeaSeedGood(id, cost, order = id) {
    return { id, order, category_tag: 'seed', purchase_limit: 10, cost, item: [{ id: 20525, count: 1 }] };
}

test('奶茶自动购种：券种子排首位仍仅购买金币商品，手动券兑换保持兼容', async () => {
    const goods = [milkTeaSeedGood(11, [{ id: 1041, count: 10 }], 1), milkTeaSeedGood(12, [{ id: 1001, count: 100 }], 2)];
    const box = await milkTeaSeedFixture(goods);
    assert.strictEqual((await box.api.operateMilkTeaActivity('seedBuy', { auto: true, count: 1 })).ok, true);
    assert.strictEqual(box.calls.find(c => c.method === 'Operate').request.shop_buy.goods_id, 12);
    const manual = await milkTeaSeedFixture(goods);
    assert.strictEqual((await manual.api.operateMilkTeaActivity('seedBuy', { goodsId: 11 })).ok, true);
    assert.strictEqual(manual.calls.find(c => c.method === 'Operate').request.shop_buy.goods_id, 11);
    // 在内存关闭新策略以模拟旧逻辑；同一断言必须检测出自动耗券。
    const old = await milkTeaSeedFixture(goods, { sourceTransform: source => source.replace('const autoGoldOnly = wantSeed && input.auto === true;', 'const autoGoldOnly = false;') });
    await old.api.operateMilkTeaActivity('seedBuy', { auto: true });
    assert.throws(() => assert.strictEqual(old.calls.find(c => c.method === 'Operate').request.shop_buy.goods_id, 12), { name: 'AssertionError' });
});

for (const [label, costs] of [
    ['奶茶券', [{ id: 1041, count: 10 }]], ['点券', [{ id: 1002, count: 10 }]],
    ['金豆豆', [{ id: 1005, count: 10 }]], ['钻石', [{ id: 1004, count: 10 }]],
    ['1000系未知货币', [{ id: 1000, count: 10 }]], ['未知货币', [{ id: 9999, count: 10 }]],
    ['混合金币和券', [{ id: 1001, count: 10 }, { id: 1041, count: 1 }]],
    ['空成本', []], ['零成本', [{ id: 1001, count: 0 }]], ['负成本', [{ id: 1001, count: -1 }]],
]) test(`奶茶自动购种：${label}明确跳过，不发送购买RPC`, async () => {
    const box = await milkTeaSeedFixture([milkTeaSeedGood(11, costs)]);
    const result = await box.api.operateMilkTeaActivity('seedBuy', { auto: true });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
});

test('奶茶自动购种：指定券goodsId不绕过限制，也不偷偷改购其他商品', async () => {
    const box = await milkTeaSeedFixture([milkTeaSeedGood(11, [{ id: 1041, count: 10 }]), milkTeaSeedGood(12, [{ id: 1001, count: 10 }])]);
    const result = await box.api.operateMilkTeaActivity('seedBuy', { goodsId: 11, auto: true });
    assert.strictEqual(result.reason, 'milk_tea_seed_gold_only');
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
});

test('奶茶自动购种：预读金币价而锁内fresh变券价，绝不使用旧快照购买', async () => {
    let currency = 1001;
    const box = await milkTeaSeedFixture(() => [milkTeaSeedGood(11, [{ id: currency, count: 10 }])]);
    const state = await box.api.getMilkTeaActivity('exchange');
    assert.strictEqual(box.api.isMilkTeaGoldSeed(state.goods[0]), true);
    currency = 1041;
    const result = await box.api.operateMilkTeaActivity('seedBuy', { auto: true, goodsId: 11 });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 2);
});

test('奶茶自动购种：同一金币策略兼容原始/归一化成本并拒绝非法值', async () => {
    const box = await milkTeaSeedFixture([]);
    for (const costs of [[{ id: 1001, count: 10 }], [{ itemId: 1001, count: '10' }]]) {
        assert.strictEqual(box.api.isMilkTeaGoldSeed({ categoryTag: 'seed', costs }), true);
    }
    for (const costs of [null, [], [{ itemId: 1001, count: true }], [{ itemId: 1001, count: 1.5 }],
        [{ itemId: 1001, count: 10 }, { itemId: 1041, count: 0 }]]) {
        assert.strictEqual(box.api.isMilkTeaGoldSeed({ categoryTag: 'seed', costs }), false);
    }
});

test('奶茶真实协议：cmd62 非空 crafted_cups map 是真实成功结果', async () => {
    const types = officialProto.types;
    const recipe = require('../src/activity-data/milk-tea-20261015.json').MilkTeaRecipeConfig
        .find(item => Number(String(item.fruit_item_id).split(':')[0]) > 0);
    const fruitId = Number(String(recipe.fruit_item_id).split(':')[0]);
    const box = activitySandbox({ realTypes: types,
        bag: () => ({ item_bag: { items: [{ id: fruitId, uid: 77, count: 2 }] } }),
        rpc: async (method, request) => {
            if (method === 'GetGroup') return encodeMilkTeaGroup({ group: { children: [{
                head: { activity_id: 2026110101, begin_time: BIZ_START, end_time: CLAIM_END }, milk_tea: { summary: { shop_open_at: BIZ_START } },
            }] } });
            const field = Object.keys(request).find(k => !['activity_id', 'operate_type'].includes(k));
            const data = request.operate_type === 55 ? { shop: { level: 1 } }
                : request.operate_type === 58 ? { recipes: [{ recipe_id: recipe.recipe_id, unlocked: true, is_advanced: true }] }
                : { crafted_cups: { [recipe.recipe_id]: 10 } };
            return types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({ activity_id: request.activity_id,
                operate_type: request.operate_type, [field]: data })).finish();
        },
    });
    assert.strictEqual((await box.api.operateMilkTeaActivity('craft', { auto: true })).ok, true);
    assert.strictEqual(box.bagReads(), 1);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 62).length, 1);
});

test('奶茶真实协议：同一原始 GetGroup 分享字段不丢，基金空请求仍发一次真实 write', async () => {
    const types = officialProto.types;
    const root = types.MilkTeaGetGroupReply.root;
    const dataType = root.lookupType('gamepb.activitypb.ActivityData');
    const child = dataType.encode(dataType.create({ activity: { activity_id: 2026110104 }, share_reward: {
        summary: { score_item_id: 1042, daily: { claim_limit: 1 }, milestones: [] },
    } })).finish();
    const group = types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({ group: { children: [
        { head: { activity_id: 2026110101, begin_time: BIZ_START, end_time: CLAIM_END }, milk_tea: { summary: { shop_open_at: BIZ_START } } },
        { head: { activity_id: 2026110103 }, growth_fund: { unlocked: false, unlock_cost: [{ id: 1041, count: 1 }] } },
    ] } })).finish();
    const groupReader = require('protobufjs/minimal').Reader.create(group);
    groupReader.uint32(); const groupBytes = groupReader.bytes();
    const writer = require('protobufjs/minimal').Writer.create();
    const merged = writer.uint32(10).bytes(Buffer.concat([groupBytes, require('protobufjs/minimal').Writer.create().uint32(18).bytes(child).finish()])).finish();
    const box = activitySandbox({ realTypes: types, bag: () => ({ item_bag: { items: [{ id: 1041, count: 100 }] } }), rpc: async (method, request) => {
        if (method === 'GetGroup') return merged;
        if (request.operate_type === 75) return types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({
            activity_id: 2026110103, operate_type: 75, growth_fund_unlock: {},
        })).finish();
        if (request.operate_type === 74) {
            assert.ok(request.share_reward_claim_daily, '已加载官方空请求字段必须真正编码');
            const replyType = root.lookupType('gamepb.activitypb.ActivityOperateReply');
            return replyType.encode(replyType.create({ activity_id: 2026110104, operate_type: 74,
                share_reward_claim_daily: { rewards: [{ id: 1041, count: 12 }], granted_score: 3 },
            })).finish();
        }
    } });
    const state = await box.api.getMilkTeaActivity('fund');
    assert.ok(state.share);
    assert.strictEqual(state.share.scoreItemId, 1042);
    assert.strictEqual((await box.api.operateMilkTeaActivity('unlock')).ok, true);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 75).length, 1);
    const daily = await box.api.operateMilkTeaActivity('shareDaily');
    assert.strictEqual(daily.ok, true);
    assert.strictEqual(daily.result.granted_score.toString(), '3');
    assert.strictEqual(daily.rewards[0].itemCount, 12);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 74).length, 1);
});

test('奶茶队列：已入锁预读 31秒仍服从业务120秒，不用entry30秒压关', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') { started.resolve(); await gate.promise; } } });
    const command = box.api.operateMilkTeaActivity('boost', {}, { deadline: box.now() + 120000 });
    await started.promise; box.advance(31000); gate.resolve();
    assert.strictEqual((await command).ok, true);
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 1);
});

test('奶茶队列：已发写跨 deadline/取消，settled前不能放行下一命令且保留成功收益', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    const box = activitySandbox({ rpc: async (method, request) => {
        if (request.operate_type === 60) { started.resolve(); await gate.promise; return {
            activity_id: 2026110101, operate_type: 60, milk_tea_boost: { cups: 10, coin_gain: 777 },
        }; }
    } });
    const controller = new AbortController();
    let firstSettled = false;
    const first = box.api.operateMilkTeaActivity('boost', {}, { signal: controller.signal, deadline: box.now() + 120000 })
        .then(result => { firstSettled = true; return result; });
    await started.promise;
    const second = box.api.operateMilkTeaActivity('boost');
    box.advance(121000); controller.abort();
    await Promise.resolve(); await Promise.resolve();
    assert.strictEqual(firstSettled, false);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
    gate.resolve();
    const result = await first;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.rewards[0].itemCount, 777);
    assert.strictEqual((await second).reason, 'milk_tea_queue_deadline');
    assert.strictEqual(box.calls.filter(c => c.request.operate_type === 60).length, 1);
});

test('奶茶队列：并行预读一项失败，其他预读settled前不可释放锁', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    let fail = true;
    const box = activitySandbox({ rpc: async (method, request) => {
        if (request.operate_type === 55 && fail) throw new Error('店铺失败');
        if (request.operate_type === 58 && fail) { started.resolve(); await gate.promise; }
    } });
    let settled = false;
    const first = box.api.operateMilkTeaActivity('boost').catch(err => { settled = true; return err; });
    const second = box.api.operateMilkTeaActivity('boost');
    await started.promise; await Promise.resolve();
    assert.strictEqual(settled, false);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
    fail = false; gate.resolve();
    assert.match((await first).message, /店铺失败/);
    assert.strictEqual((await second).ok, true);
});

test('奶茶页面：不同deadline共用一次Group，各消费者独立过期', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') { started.resolve(); await gate.promise; } } });
    const a = box.api.getMilkTeaActivity('exchange', {}, { deadline: box.now() + 10000 }).catch(err => err);
    const b = box.api.getMilkTeaActivity('exchange', {}, { deadline: box.now() + 20000 });
    await started.promise;
    box.advance(11000); gate.resolve();
    assert.strictEqual((await a).code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual((await b).active, true);
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 1);
});

test('天气：getOwnWeatherStatus只读自己，不访问好友，官方object不重复decode', async () => {
    const box = activitySandbox({ friendApi: { withFriendVisitSession: () => { throw new Error('自己天气不得访问好友'); } },
        rpc: async method => method === 'GetWeatherStatus' ? { weather: { type: 2, status: 1 } } : undefined });
    assert.strictEqual((await box.api.getOwnWeatherStatus()).rainstorm, true);
    assert.strictEqual(box.decodeCount(), 0);
    assert.strictEqual(box.calls.length, 1);
    assert.strictEqual(box.calls[0].service, 'gamepb.weatherpb.WeatherService');
});

test('天气：好友采集写只在本次visit callback内，Leave后才刷新', async () => {
    let inVisit = false;
    const steps = [];
    const box = activitySandbox({
        group: { group: { activity: { id: 2026070300, start_time: 1, end_time: 4102444800 }, children: [
            { activity: { id: 2026070303 }, draw_info: { paid_remaining_count: 2 } },
        ] } },
        bag: () => ({ items: [{ id: 5001, count: 2 }] }), friends: [{ gid: 999, name: '好友' }],
        friendApi: { withFriendVisitSession: async (gid, callback) => {
            steps.push('Entry'); inVisit = true;
            try { return await callback({ weather: { type: 2, status: 1 } }); }
            finally { inVisit = false; steps.push('Leave'); }
        } },
        rpc: async (method, request) => {
            if (method === 'Operate') {
                assert.strictEqual(inVisit, true);
                assert.strictEqual(request.weather_collect_operate.host_gid, 999);
                assert.strictEqual(request.activity_id, 2026070303);
                assert.strictEqual(request.operate_type, 9);
                steps.push('Write'); return {};
            }
            if (method === 'GetWeatherStatus') return { weather: { type: 0, status: 0 } };
            if (method === 'GetGroup' && steps.length) { assert.strictEqual(inVisit, false); steps.push('Refresh'); }
        },
    });
    assert.strictEqual((await box.api.collectRainPoemWeather()).ok, true);
    assert.deepStrictEqual(steps, ['Entry', 'Write', 'Leave', 'Refresh']);
});

test('奶茶页面：空group只报告unknown，不能伪装已结束', async () => {
    const box = activitySandbox({ group: {} });
    const state = await box.api.getMilkTeaActivity();
    assert.strictEqual(state.active, null);
    assert.strictEqual(state.phase, 'unknown');
    assert.strictEqual(state.reason, 'milk_tea_snapshot_missing');
    assert.strictEqual((await box.api.operateMilkTeaActivity('boost')).skipped, true);
});

test('奶茶页面：通知与userinfo跨模块失效入口切断old flight，不取消其余消费者', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    let count = 0;
    const box = activitySandbox({ rpc: async method => {
        if (method === 'GetGroup' && ++count === 1) { started.resolve(); await gate.promise; }
    } });
    const old = box.api.getMilkTeaActivity('exchange').catch(err => err);
    await started.promise;
    box.api.invalidateMilkTeaSnapshot();
    await box.api.getMilkTeaActivity('exchange');
    assert.strictEqual(count, 2);
    gate.resolve();
    assert.strictEqual((await old).code, 'ACTIVITY_STALE_RESULT');
    await box.api.getMilkTeaActivity('exchange');
    assert.strictEqual(count, 3);
});

test('天气：Entry结果unknown不能继续访问其他好友或重复采集写', async () => {
    let visits = 0;
    const box = activitySandbox({
        group: { group: { activity: { id: 2026070300, start_time: 1, end_time: 4102444800 }, children: [
            { activity: { id: 2026070303 }, draw_info: { paid_remaining_count: 2 } },
        ] } },
        bag: () => ({ items: [{ id: 5001, count: 2 }] }), friends: [{ gid: 999 }, { gid: 888 }],
        friendApi: { withFriendVisitSession: async () => { visits++; const err = new Error('Entry状态未知'); err.resultState = 'unknown'; throw err; } },
        rpc: async method => method === 'GetWeatherStatus' ? { weather: {} } : undefined,
    });
    await assert.rejects(box.api.collectRainPoemWeather(), /Entry状态未知/);
    assert.strictEqual(visits, 1);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 0);
});

test('青梅：preview空报价不继续brew或sell、不伪造ok', async () => {
    const box = activitySandbox({
        group: { group: { activity: { id: 2026081200 }, children: [{ activity: { id: 2026081202, end_time: 4102444800 } }] } },
        bag: () => ({ items: [{ id: 41221, uid: 77, count: 5 }] }),
        rpc: async (method, request) => request.cmd === 14 ? { qingmei_preview: {} } : undefined,
    });
    await assert.rejects(box.api.brewAndSellQingmeiWine(), /未返回有效报价/);
    assert.strictEqual(box.calls.filter(c => c.method === 'Operate').length, 1);
});

test('奶茶页面：从真实ALS捕获HTTP取消，等待已发Group后不启动后续读', async () => {
    const { runWithRequestContext } = require('../src/utils/request-priority');
    const gate = deferredActivity(), started = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') { started.resolve(); await gate.promise; } } });
    const controller = new AbortController();
    const pending = runWithRequestContext({ signal: controller.signal, deadline: box.now() + 120000 },
        () => box.api.getMilkTeaActivity('shop')).catch(err => err);
    await started.promise;
    controller.abort(); gate.resolve();
    assert.strictEqual((await pending).code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual(box.calls.length, 1);
    assert.strictEqual(box.bagReads(), 0);
});

test('奶茶页面：最多32个live flight，失效不能提前释放容量，溢出明确QUEUE_FULL', async () => {
    const gate = deferredActivity();
    const box = activitySandbox({ rpc: async method => { if (method === 'GetGroup') await gate.promise; } });
    const pending = Array.from({ length: 32 }, (_, i) => box.api.getMilkTeaActivity('rank', { pageNumber: i + 1 }).catch(err => err));
    box.api.invalidateMilkTeaSnapshot();
    const overflow = await Promise.all(Array.from({ length: 100 }, (_, i) =>
        box.api.getMilkTeaActivity('rank', { pageNumber: i + 100 }).catch(err => err)));
    assert.ok(overflow.every(err => err.code === 'QUEUE_FULL'));
    assert.strictEqual(box.calls.filter(c => c.method === 'GetGroup').length, 32);
    gate.resolve();
    assert.ok((await Promise.all(pending)).every(err => err.code === 'ACTIVITY_STALE_RESULT'));
    assert.strictEqual((await box.api.getMilkTeaActivity('rank')).active, true);
});

test('奶茶页面：连接epoch与本地clientVersion变化隔离flight并拒绝旧结果', async () => {
    const gate = deferredActivity(), started = deferredActivity();
    let groups = 0;
    const box = activitySandbox({ rpc: async method => {
        if (method === 'GetGroup' && ++groups <= 2) { started.resolve(); await gate.promise; }
    } });
    const oldEpoch = box.api.getMilkTeaActivity('exchange').catch(err => err);
    await started.promise;
    box.setEpoch(2);
    const oldVersion = box.api.getMilkTeaActivity('exchange').catch(err => err);
    await Promise.resolve(); await Promise.resolve();
    box.setVersion('本地更新版本');
    assert.strictEqual((await box.api.getMilkTeaActivity('exchange')).active, true);
    gate.resolve();
    assert.strictEqual((await oldEpoch).code, 'ACTIVITY_CONTEXT_EXPIRED');
    assert.strictEqual((await oldVersion).code, 'ACTIVITY_STALE_RESULT');
    assert.strictEqual(groups, 3);
});
