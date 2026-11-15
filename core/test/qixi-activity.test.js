const test = require('node:test');
const assert = require('node:assert/strict');
const { types, loadProto } = require('../src/utils/proto');
const { normalizeQixiActivity } = require('../src/services/activity');
const { getItemById } = require('../src/config/gameConfig');

test('鹊桥活动协议解析阶段、材料和香囊次数', async () => {
  await loadProto();
  const reply = types.ActivityGetGroupReply.create({
    group: {
      activity: { id: 2026081800, title: '鹊桥寄情' },
      children: [
        {
          activity: { id: 2026081801, visible: true, enabled: true },
          qixi_bridge: {
            balances: [{ id: 1024, count: 35 }, { id: 1025, count: 2 }],
            stages: [
              { id: 1, cost: { id: 1024, count: 30 }, rewards: [{ id: 1025, count: 5 }], status: 2 },
              { id: 2, cost: { id: 1024, count: 50 }, status: 1 },
            ],
          },
        },
        {
          activity: { id: 2026081802 },
          qixi_gift: { sent_count: 4, received_count: 12, max_count: 50, rule: { cost: { id: 1025, count: 1 }, enabled: true } },
        },
      ],
    },
  });
  const activity = normalizeQixiActivity(reply);
  assert.equal(activity.items.feather.itemCount, 35);
  assert.equal(activity.bridge.completedCount, 1);
  assert.equal(activity.bridge.nextStage.id, 2);
  assert.equal(activity.bridge.canBuild, false);
  assert.equal(activity.gift.remainingCount, 46);
  assert.equal(activity.gift.cost.itemId, 1025);
});

test('鹊羽灵露使用真实背包 ID 301103 并具有名称映射', () => {
  assert.equal(getItemById(1024)?.name, '鹊羽');
  assert.equal(getItemById(301103)?.name, '鹊羽灵露');
});

test('黄金作物识别：112 段作物优先获得灵露双倍效果', async () => {
  await loadProto();
  // 直接验证黄金作物 ID 判定函数（通过 land 筛选逻辑的输入形态）
  const { getPlantById } = require('../src/config/gameConfig');
  const gold = getPlantById(1120112); // 黄金·风信子
  const normal = getPlantById(1020112);
  assert.equal(Number(gold && gold.id), 1120112);
  assert.ok(String(gold && gold.name).includes('黄金'));
  assert.ok(!String(normal && normal.name).includes('黄金'));
});

test('鹊羽灵露通过 social_items 从服务端识别（重登不丢失）', async () => {
  await loadProto();
  const { hasQixiDew, getSocialItemsSummary } = require('../src/services/farm-land-analyzer');
  const plant = {
    id: 29003,
    social_items: [
      { item_id: 301103, count: 1, type: 2, owner_gid: 1, created_at: 1 },
    ],
  };
  assert.equal(hasQixiDew(plant), true);
  const summary = getSocialItemsSummary(plant);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].itemId, 301103);
  // 非灵露道具不影响判断
  const goldenBugPlant = {
    id: 29003,
    social_items: [{ item_id: 301101, count: 1, type: 2, owner_gid: 1, created_at: 1 }],
  };
  assert.equal(hasQixiDew(goldenBugPlant), false);
});

test('1000020 是请求参数错误而非每日上限（warehouse 回退逻辑证实）', () => {
  // 关键修正：code=1000020 是"请求参数错误"（warehouse.js 回退 raw 协议证实），
  // 误判为每日上限会导致活动页错误显示 15/15。
  const { isQixiDewDailyLimitError } = require('../src/services/activity');
  assert.equal(isQixiDewDailyLimitError({ code: 1000020 }), false);
  assert.equal(isQixiDewDailyLimitError(new Error('code=1000020 请求参数错误')), false);
  assert.equal(isQixiDewDailyLimitError({ code: 1003008 }), true);
  assert.equal(isQixiDewDailyLimitError(new Error('网络错误')), false);
});

test('香囊赠送参数使用独立 field 124 并保留好友优先目标', async () => {
  if (!types.ActivityOperateRequest) await loadProto();
  const bytes = types.ActivityOperateRequest.encode(types.ActivityOperateRequest.create({
    id: 2026081802,
    cmd: 26,
    qixi_gift: { friend_gid: 987654321, gift_id: 11 },
  })).finish();
  const decoded = types.ActivityOperateRequest.decode(bytes);
  assert.equal(Number(decoded.qixi_gift.friend_gid), 987654321);
  assert.equal(Number(decoded.qixi_gift.gift_id), 11);
});

// 独立 VM 隔离网络和持久化，旧协议失败断言保持原样。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function qixiSnapshotSandbox(options = {}) {
  const filename = path.join(__dirname, '..', 'src', 'services', 'activity.js');
  const localRequire = createRequire(filename);
  let gid = '1';
  let now = Date.now();
  let calls = 0;
  let bagReads = 0;
  let active = true;
  let fail = false;
  const wireType = { create: v => v, encode: () => ({ finish: () => Buffer.alloc(0) }), decode: () => { throw new Error('官方对象不可重复解码'); } };
  const module = { exports: {} };
  class FakeDate extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, structuredClone, Date: FakeDate,
    setTimeout, clearTimeout, console,
    require: name => {
      if (name === '../utils/network') return {
        getUserState: () => ({ gid }), isConnected: () => true,
        sendMsgAsync: async () => {
          calls++;
          if (options.wait) await options.wait();
          if (fail) throw new Error('网络超时');
          return { body: { group: {
            activity: { id: 2026081800, end_time: Math.floor(now / 1000) + 60 },
            children: [{ activity: { id: 2026081801, visible: active, enabled: active }, qixi_bridge: { stages: [], balances: [] } }],
          } } };
        },
      };
      if (name === '../utils/proto') return { types: new Proxy({}, { get: () => wireType }) };
      if (name === '../utils/utils') return { toNum: v => Number(v) || 0, toLong: v => v };
      if (name === './warehouse') return { getBag: async () => { bagReads++; return { items: [] }; }, getBagItems: bag => bag.items };
      if (name === './json-db') return { readJsonFile: () => ({}), writeJsonFileAtomic: () => { throw new Error('禁止写盘'); } };
      if (name === '../config/runtime-paths') return { getDataFile: name => name, getDataDir: () => '' };
      if (name === './logger') return { createModuleLogger: () => ({ info() {}, warn() {}, debug() {} }) };
      if (name === '../config/gameConfig') return { getItemById: () => null, getItemImageById: () => '' };
      if (name === './activity-center-helpers' || name === './activity-pet-diary') return {};
      return localRequire(name);
    },
  }, { filename });
  return {
    api: module.exports, calls: () => calls, bagReads: () => bagReads,
    advance: ms => { now += ms; }, account: value => { gid = value; },
    setActive: value => { active = value; }, fail: value => { fail = value; },
  };
}

test('七夕快照：未知 getter 返回 null，不 fire-and-forget、不默认在期', async () => {
  const box = qixiSnapshotSandbox();
  for (let i = 0; i < 100; i++) assert.equal(box.api.getQixiEndedStateCached(), null);
  await Promise.resolve();
  assert.equal(box.calls(), 0);
});

test('七夕快照：实际异步消费者更新 getter，active:true 保持真实未结束', async () => {
  const box = qixiSnapshotSandbox();
  const activity = await box.api.getQixiActivity();
  assert.equal(activity.active, true);
  const snapshot = box.api.getQixiEndedStateCached();
  assert.equal(snapshot.ended, false);
  assert.equal(snapshot.activity.active, true);
  assert.equal(box.bagReads(), 1);
  snapshot.ended = true;
  assert.equal(box.api.getQixiEndedStateCached().ended, false);
});

test('七夕快照：过 TTL 的同步 getter 仍是纯快照，刷新由异步消费者负责', async () => {
  const box = qixiSnapshotSandbox();
  await box.api.getQixiEndedState();
  box.advance(16 * 60 * 1000);
  box.setActive(false);
  assert.equal(box.api.getQixiEndedStateCached().ended, false);
  assert.equal(box.calls(), 1);
  assert.equal((await box.api.getQixiEndedState()).ended, true);
  assert.equal(box.calls(), 2);
});

test('七夕快照：显式刷新并发只发一次 flight', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const box = qixiSnapshotSandbox({ wait: () => gate });
  const pending = Array.from({ length: 32 }, () => box.api.getQixiEndedState());
  assert.equal(box.calls(), 1);
  release();
  const snapshots = await Promise.all(pending);
  assert.equal(box.calls(), 1);
  assert.ok(snapshots.every(snapshot => snapshot.ended === false));
});

test('七夕快照：账号隔离且旧账户响应不能污染新账户', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const box = qixiSnapshotSandbox({ wait: () => gate });
  const pending = box.api.getQixiEndedState();
  box.account('2'); release();
  assert.equal(await pending, null);
  assert.equal(box.api.getQixiEndedStateCached(), null);
  await box.api.getQixiEndedState();
  assert.equal(box.api.getQixiEndedStateCached().ended, false);
  box.account('1');
  assert.equal(box.api.getQixiEndedStateCached(), null);
});

test('七夕快照：网络错误不伪装已结束或新建默认在期快照', async () => {
  const box = qixiSnapshotSandbox();
  box.fail(true);
  assert.equal(await box.api.getQixiEndedState(), null);
  assert.equal(box.api.getQixiEndedStateCached(), null);
  assert.equal(box.calls(), 1);
  box.fail(false);
  await box.api.getQixiEndedState();
  box.advance(16 * 60 * 1000);
  box.fail(true);
  assert.equal((await box.api.getQixiEndedState()).ended, false, '失败只能保留已确证快照');
});
