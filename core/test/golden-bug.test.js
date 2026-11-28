const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const fs = require('node:fs');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const gamePhaseConfig = require('../src/config/config');

const originalHarness = placementHarness();
// VM 返回数组跨 realm，统一转为普通对象后保持原有断言不变。
const analyzeLands = (...args) => JSON.parse(JSON.stringify(originalHarness.own.analyzeLands(...args)));
const analyzeFriendLands = (...args) => JSON.parse(JSON.stringify(originalHarness.analyzer.analyzeFriendLands(...args)));
const { getGoldenBugCount } = originalHarness.golden;

const CAPTURED_PUT_REPLY_HEX = '0aa0010818100118032005420e080110571a0808e90710c0cc8d084a0a08a09c0110e80728d00f5277088da13e1209e78c95e78cb4e6a1832210080210ccf9ccd206180a38cf8bcdd206220a080610f492cdd2061813280150edb80258d80478a0658001018801019001d804b001ee03d001edb802d801d80492020a08e90710ac02188da13e9a021408adb012100118022087dd8dc30428f0f9ccd206a802468001031209089f4e1001186428011a090818120508cd08101e220a0818120608adb0121001';

let proto;

test.before(async () => {
  const root = new protobuf.Root();
  await root.load([
    path.join(__dirname, '../src/proto/corepb.proto'),
    path.join(__dirname, '../src/proto/plantpb.proto'),
  ], { keepCase: true });
  proto = {
    request: root.lookupType('gamepb.plantpb.PutSocialItemRequest'),
    reply: root.lookupType('gamepb.plantpb.PutSocialItemReply'),
    farmingReply: root.lookupType('gamepb.plantpb.FarmingReply'),
  };
});

test('farming reply decodes the captured 720 exp golden bug clear reward', () => {
  const reply = proto.farmingReply.decode(Buffer.from('1a0a0801120608cd0810d005', 'hex'));

  assert.equal(Number(reply.social_rewards[0].items[0].id), 1101);
  assert.equal(Number(reply.social_rewards[0].items[0].count), 720);
});

test('golden bug request matches the captured client payload', () => {
  const payload = proto.request.encode(proto.request.create({
    host_gid: 1212748551,
    land_ids: [24],
    item_id: 301101,
    social_type: 2,
  })).finish();

  assert.equal(payload.toString('hex'), '0887a6a4c20412011818adb0122802');
});

test('golden bug reply decodes its limit, reward, cost, and land marker', () => {
  const reply = proto.reply.decode(Buffer.from(CAPTURED_PUT_REPLY_HEX, 'hex'));

  assert.equal(Number(reply.operation_limits[0].id), 10015);
  assert.equal(Number(reply.operation_limits[0].day_times), 1);
  assert.equal(Number(reply.operation_limits[0].day_times_lt), 100);
  assert.equal(Number(reply.rewards[0].items[0].id), 1101);
  assert.equal(Number(reply.rewards[0].items[0].count), 30);
  assert.equal(Number(reply.costs[0].items[0].id), 301101);
  assert.equal(Number(reply.costs[0].items[0].count), 1);
  assert.equal(Number(reply.land[0].plant.social_items[0].item_id), 301101);
  assert.equal(Number(reply.land[0].plant.social_items[0].owner_gid), 1214475911);
});

test('land analyzers keep golden bugs separate from ordinary insects', () => {
  const land = {
    id: 7,
    unlocked: true,
    plant: {
      id: 1020029,
      phases: [{ phase: 3, begin_time: 1 }],
      insect_owners: [],
      social_items: [{ item_id: 301101, type: 2, owner_gid: 123 }],
    },
  };

  const own = analyzeLands([land]);
  const friend = analyzeFriendLands([land], 456);

  assert.deepEqual(own.needBug, []);
  assert.deepEqual(own.needGoldenBug, [7]);
  assert.deepEqual(friend.canPutGoldenBug, []);

  land.plant.social_items = [];
  assert.deepEqual(analyzeFriendLands([land], 456).canPutGoldenBug, [7]);
});

test('golden bug inventory totals only item 301101', () => {
  assert.equal(getGoldenBugCount([
    { id: 301101, count: 9 },
    { id: 301101, count: 3 },
    { id: 1001, count: 999 },
  ]), 12);
});

function placementHarness() {
  let now = 1000000;
  let timerId = 0;
  let remoteGeneration = 7;
  let enabled = true;
  let inventory = [{ id: 301101, count: 3 }, { id: 5005, count: 2, uid: 55 }, { id: 5006, count: 1, uid: 66 }];
  let gids = [11, 22];
  let config = { goldenBugKeepCount: 0, goldenBugRoundLimit: 3 };
  let dailyRemaining = 100;
  let budget99 = 99;
  const timers = new Map(); const calls = []; const logs = []; const stats = []; const modules = new Map();
  const visitStateFiles = new Map([['/memory/data/friend-visit-state/2.json', JSON.stringify({
    version: 1, accountId: '2', phase: 'left', gid: 0, epoch: 7, proof: 'leave_confirmed', updatedAt: 1000000,
  })]]);
  const planted = id => ({ id, unlocked: true, plant: { id: 1020029, phases: [{ phase: 3, begin_time: 1 }], social_items: [] } });
  let lands = [planted(1), planted(2), planted(3)];
  let rpc = async (_service, method, payload) => ({ body: method === 'Enter' ? { lands }
    : method === 'GetGameFriends' ? { game_friends: payload.gids.map(gid => ({ gid, name: `模拟${gid}`, level: 100 - gid })) }
    : method === 'PutSocialItem' ? { operation_limits: [] }
    : ['PutInsects', 'PutWeeds'].includes(method) ? { land: payload.land_ids.map(id => ({ id })), operation_limits: [] } : {} });
  class ClockDate extends Date { static now() { return now; } }
  const clock = {
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const wire = { create: value => value, encode: value => ({ finish: () => value }), decode: value => value };
  const utils = { toNum: value => Number(value) || 0, toLong: value => value, toTimeSec: value => Number(value) || 0,
    getServerTimeSec: () => now / 1000, log: (...args) => logs.push(args), logWarn: (...args) => logs.push(args),
    randomDelay: async () => {}, sleep: async () => {} };
  const store = { getConfigSnapshot: () => ({ ...config, knownFriendGids: [...gids] }), getFriendBlacklist: () => [10001],
    getFriendQuietHours: () => ({ enabled: false }), getFriendQuietHoursExemptGids: () => [],
    getPlantBlacklist: () => [], isAutomationOn: () => enabled, getAutomation: () => ({}),
    applyConfigSnapshot: () => { throw new Error('禁止持久化或配置变更'); }, removeFriendFromCache: () => {} };
  const network = { isConnected: () => true, getUserState: () => ({ gid: 42, accountId: '2' }),
    getDiagnosticSnapshot: () => ({ remoteGeneration, connected: true, loggedIn: true, detached: false }),
    async sendMsgAsync(service, method, payload, meta) {
      calls.push({ service, method, payload, meta, context: load('priority').getRequestContext() });
      return rpc(service, method, payload, meta);
    } };
  const limits = { GOLDEN_BUG_OPERATION_ID: 10015, checkDailyReset: () => {}, getRemainingTimes: () => dailyRemaining,
    updateOperationLimits: () => {}, getBadRemainingTimes: () => budget99,
    recordBadOperationSuccess: count => { budget99 -= count; } };
  const warehouse = { getBag: async () => ({ items: inventory }), getBagItems: reply => reply.items || [] };
  const gameConfig = { getPlantById: () => null, getPlantGrowPhases: () => [], getPlantName: () => '模拟作物', getItemById: () => null };
  const fileNames = { priority: 'utils/request-priority', api: 'services/friend-api', session: 'services/friend-visit-session',
    analyzer: 'services/friend-land-analyzer', own: 'services/farm-land-analyzer', golden: 'services/golden-bug-service', rain: 'services/rain-poem-prank-service' };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = { exports: {} };
    const filename = path.join(__dirname, '../src', `${fileNames[name]}.js`);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, Buffer, Error, AbortController, Date: ClockDate, ...clock,
      process: { env: { FARM_ACCOUNT_ID: '2', FARM_NETWORK_MODE: 'local' } },
      require(id) {
        if (id === 'node:path') return path.posix;
        if (id === 'node:fs') return { existsSync: file => visitStateFiles.has(file),
          lstatSync: () => ({ isSymbolicLink: () => false }), readFileSync: file => visitStateFiles.get(file) };
        if (id === '../config/runtime-paths') return { getDataFile: file => `/memory/data/${file}` };
        if (id === './json-db') return { writeJsonFileAtomic: (file, value) => visitStateFiles.set(file, JSON.stringify(value)) };
        if (id === 'node:async_hooks') return { AsyncLocalStorage };
        if (id === 'node:crypto') return { createHash };
        if (id === 'node:worker_threads') return {};
        if (id === 'protobufjs') return { Writer: protobuf.Writer };
        if (id === 'protobufjs/minimal') return {};
        if (id === '../utils/network') return network;
        if (id === '../utils/request-priority') return load('priority');
        if (id === '../utils/proto') return { types: new Proxy({}, { get: () => wire }) };
        if (id === '../utils/utils') return utils;
        if (id === '../models/store') return store;
        if (id === '../config/config') return { ...gamePhaseConfig, CONFIG: { platform: 'qq' } };
        if (id === '../config/gameConfig') return gameConfig;
        if (id === './friend-api') return load('api');
        if (id === './friend-visit-session') return load('session');
        if (id === './friend-land-analyzer') return load('analyzer');
        if (id === './farm-land-analyzer') return load('own');
        if (id === './friend-operation-limits') return limits;
        if (id === './warehouse') return warehouse;
        if (id === './stats') return { recordOperation: (...args) => stats.push(args) };
        if (id === './interact') return { getInteractRecords: async () => { throw new Error('普通GET不能发现访客'); } };
        if (id === './farm-api') return {};
        if (id === './farm-land-upgrade') return {};
        throw new Error(`禁止未模拟依赖 ${id}`);
      },
    }, { filename });
    modules.set(name, module.exports); return module.exports;
  }
  const priority = load('priority'); const api = load('api'); const own = load('own'); const analyzer = load('analyzer');
  return { priority, api, own, analyzer, golden: load('golden'), rain: load('rain'), timers, calls, logs, stats,
    state: () => api.getFriendVisitSessionSnapshot(), setRpc: value => { rpc = value; },
    setEnabled: value => { enabled = value; }, setGids: value => { gids = value; }, setLands: value => { lands = value; },
    setInventory: value => { inventory = value; }, setConfig: value => { config = value; }, setDaily: value => { dailyRemaining = value; },
    budget: () => budget99, bumpEpoch: () => { remoteGeneration++; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await flushPlacement();
    },
  };
}

async function flushPlacement() { for (let index = 0; index < 80; index++) await Promise.resolve(); }
function deferredPlacement() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function decodeBottlePayload(payload) {
  const reader = protobuf.Reader.create(payload);
  const itemLengthTag = reader.uint32(); assert.equal(itemLengthTag, 10);
  const item = protobuf.Reader.create(reader.bytes());
  assert.equal(item.uint32(), 8); const id = Number(item.int64());
  assert.equal(item.uint32(), 16); const count = Number(item.int64());
  assert.equal(item.uint32(), 48); const uid = Number(item.int64());
  assert.equal(reader.uint32(), 18); const target = protobuf.Reader.create(reader.bytes());
  assert.equal(target.uint32(), 8); const gid = Number(target.int64());
  assert.equal(target.uint32(), 18); const landId = Number(protobuf.Reader.create(target.bytes()).int64());
  return { id, count, uid, gid, landId };
}

test('黄金虫实际入口：整个多地块事务一次Enter/Leave，数量和100额度不消耗虫草99预算', async () => {
  const h = placementHarness(); const result = await h.golden.runGoldenBugPlacement({ force: true });
  assert.equal(result.placed, 3); assert.equal(h.budget(), 99);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'PutSocialItem', 'PutSocialItem', 'PutSocialItem', 'Leave']);
  assert.equal(h.calls[2].payload.item_id, 301101); assert.equal(h.calls[2].payload.social_type, 2);
  assert.equal(h.calls[2].payload.host_gid, 11); assert.deepEqual(Array.from(h.calls[2].payload.land_ids), [1]);
  assert.equal(h.stats.length, 3); assert.equal(h.state().processing, false); assert.equal(h.timers.size, 0);
});

test('黄金虫库存保留、每日剩余与轮次上限取最小且无库存不Enter', async () => {
  const h = placementHarness(); h.setConfig({ goldenBugKeepCount: 1, goldenBugRoundLimit: 3 }); h.setDaily(1);
  assert.equal((await h.golden.runGoldenBugPlacement({ force: true })).placed, 1);
  const empty = placementHarness(); empty.setInventory([]);
  assert.equal((await empty.golden.runGoldenBugPlacement({ force: true })).placed, 0); assert.equal(empty.calls.length, 0);
});

test('黄金虫写后关闭自动控制不续写，仍执行外层Leave', async () => {
  const h = placementHarness(); h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, unlocked: true, plant: { id: 1, phases: [{ phase: 3 }] } }, { id: 2, unlocked: true, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'PutSocialItem') h.setEnabled(false);
    return { body: {} };
  });
  assert.equal((await h.golden.runGoldenBugPlacement({ force: true })).placed, 1);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'PutSocialItem', 'Leave']); assert.equal(h.timers.size, 0);
});

test('黄金虫未知写失败一次停止，不重试、不串下一好友、不是零成功', async () => {
  const h = placementHarness(); const failure = Object.assign(new Error('写超时'), { sent: true, resultState: 'unknown', errorCode: 'REQUEST_TIMEOUT' });
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }, { gid: 22 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, unlocked: true, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    throw failure;
  });
  const result = await h.golden.runGoldenBugPlacement({ force: true });
  assert.equal(result.failed, true); assert.equal(result.unknown, true); assert.equal(result.ok, false);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'PutSocialItem']);
  assert.equal(h.state().resultState, 'unknown'); assert.equal(h.timers.size, 0);
});

test('黄金虫已确认写后Leave失败保留数量并报告unknown', async () => {
  const h = placementHarness(); h.setConfig({ goldenBugRoundLimit: 1 });
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, unlocked: true, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Leave') throw Object.assign(new Error('Leave超时'), { sent: true, resultState: 'unknown' });
    return { body: {} };
  });
  const result = await h.golden.runGoldenBugPlacement({ force: true });
  assert.equal(result.failed, true); assert.equal(result.placed, 1); assert.equal(result.unknown, true); assert.equal(h.stats.length, 1); assert.equal(h.timers.size, 0);
});

test('手动雨诗入口完整事务与knownprotocol：UID/瓶类型/好友/地块全部保留', async () => {
  const h = placementHarness(); const result = await h.rain.putRainPoemPrankOnFriend(11, 5005);
  assert.equal(result.ok, true); assert.equal(result.placed, true);
  assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Use', 'Leave']);
  assert.deepEqual(decodeBottlePayload(h.calls[1].payload), { id: 5005, count: 1, uid: 55, gid: 11, landId: 1 });
  assert.equal(h.timers.size, 0);
});

test('自动雨诗入口每好友一次Enter/Use/Leave，不对每个瓶重复进入', async () => {
  const h = placementHarness(); h.setInventory([{ id: 5005, count: 1, uid: 55 }, { id: 5006, count: 1, uid: 66 }]);
  const result = await h.rain.runRainPoemPrankPlacement();
  assert.equal(result.placed, 2); assert.equal(result.frog, 1); assert.equal(result.cloud, 1);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'Use', 'Leave', 'Enter', 'Use', 'Leave']);
  assert.equal(decodeBottlePayload(h.calls[5].payload).gid, 22); assert.equal(h.timers.size, 0);
});

test('三入口并发共享真实Visit锁，首个写未结束不能Enter下一GID', async () => {
  const h = placementHarness(); h.setConfig({ goldenBugRoundLimit: 1 });
  h.setInventory([{ id: 301101, count: 1 }, { id: 5005, count: 1, uid: 55 }]);
  const write = deferredPlacement();
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, unlocked: true, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'PutSocialItem') return write.promise;
    return { body: {} };
  });
  const golden = h.golden.runGoldenBugPlacement({ force: true }); await flushPlacement();
  const manual = h.rain.putRainPoemPrankOnFriend(22, 5005); const auto = h.rain.runRainPoemPrankPlacement(); await flushPlacement();
  assert.equal(h.calls.filter(call => call.method === 'Enter').length, 1); assert.equal(h.state().processing, true);
  write.resolve({ body: {} }); await Promise.all([golden, manual, auto]);
  const visits = h.calls.filter(call => call.method === 'Enter' || call.method === 'Leave').map(call => call.method);
  assert.deepEqual(visits, ['Enter', 'Leave', 'Enter', 'Leave', 'Enter', 'Leave']); assert.equal(h.timers.size, 0);
});

test('手动雨诗取消后写仍在途不release；晚成功只记一次并独立Leave', async () => {
  const h = placementHarness(); const write = deferredPlacement(); const controller = new AbortController();
  h.setRpc(async (_service, method) => {
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Use') return write.promise;
    return { body: {} };
  });
  const request = h.priority.runWithRequestContext({ signal: controller.signal }, () => h.rain.putRainPoemPrankOnFriend(11, 5005));
  await flushPlacement(); controller.abort(new Error('页面取消')); const result = await request;
  assert.equal(result.failed, true); assert.equal(result.unknown, true); assert.equal(h.state().processing, true);
  assert.equal((await h.rain.putRainPoemPrankOnFriend(22, 5005)).unknown, true);
  write.resolve({ body: {} }); await flushPlacement();
  assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Use', 'Leave']); assert.equal(h.state().resultState, 'idle'); assert.equal(h.timers.size, 0);
});

test('手动雨诗写同tick返回后取消不续写，仍清理实际Visit', async () => {
  const h = placementHarness(); const controller = new AbortController();
  h.setRpc(async (_service, method) => {
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Use') controller.abort(new Error('已返回后取消'));
    return { body: {} };
  });
  const result = await h.priority.runWithRequestContext({ signal: controller.signal }, () => h.rain.putRainPoemPrankOnFriend(11, 5005));
  await flushPlacement(); assert.equal(result.failed, true);
  assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Use', 'Leave']); assert.equal(h.timers.size, 0);
});

test('自动雨诗未知Use失败不跨好友重复消耗瓶子', async () => {
  const h = placementHarness(); const failure = Object.assign(new Error('Use超时'), { sent: true, resultState: 'unknown' });
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }, { gid: 22 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    throw failure;
  });
  const result = await h.rain.runRainPoemPrankPlacement();
  assert.equal(result.failed, true); assert.equal(result.unknown, true);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'Use']); assert.equal(h.timers.size, 0);
});

test('雨诗明确已生效code1033011只skipped，外层Leave后可访下一好友', async () => {
  const h = placementHarness(); h.setInventory([{ id: 5005, count: 1, uid: 55 }]); let writes = 0;
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }, { gid: 22 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Use' && writes++ === 0) throw Object.assign(new Error('code=1033011 已有使坏效果'), { sent: true, stage: 'remote', resultState: 'failed' });
    return { body: {} };
  });
  const result = await h.rain.runRainPoemPrankPlacement();
  assert.equal(result.activeFriends, 1); assert.equal(result.placed, 1);
  assert.deepEqual(h.calls.filter(call => ['Enter', 'Leave'].includes(call.method)).map(call => call.method), ['Enter', 'Leave', 'Enter', 'Leave']); assert.equal(h.timers.size, 0);
});

test('雨诗已处理blacklist Enter错误保持skipped且不写瓶子', async () => {
  const h = placementHarness();
  h.setRpc(async () => { throw Object.assign(new Error('禁止进入'), { sent: true, stage: 'remote', resultState: 'failed', friendEnterHandling: { handled: true, kind: 'blacklist' } }); });
  const result = await h.rain.putRainPoemPrankOnFriend(11, 5005);
  assert.equal(result.skipped, true); assert.equal(result.failed, false); assert.equal(result.placed, false);
  assert.deepEqual(h.calls.map(call => call.method), ['Enter']); assert.equal(h.timers.size, 0);
});

test('雨诗关闭自动控制不启动Visit，手动入口仍可用', async () => {
  const h = placementHarness(); h.setEnabled(false);
  assert.equal((await h.rain.runRainPoemPrankPlacement()).skipped, true); assert.equal(h.calls.length, 0);
  assert.equal((await h.rain.putRainPoemPrankOnFriend(11, 5005)).placed, true); assert.equal(h.timers.size, 0);
});

test('原虫草预算owner导出计数接口，子RPC不多Enter且计数仍为99预算', async () => {
  const h = placementHarness();
  await h.api.withFriendVisitSession(11, () => h.api.putFriendItemsDetailed(11, [1, 2], 'PutInsects'));
  assert.equal(h.budget(), 97);
  assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'PutInsects', 'PutInsects', 'Leave']); assert.equal(h.timers.size, 0);
});

test('手动雨诗写成功但Leave失败，placed仍为true且unknown不是伪成功', async () => {
  const h = placementHarness();
  h.setRpc(async (_service, method) => {
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Leave') throw Object.assign(new Error('Leave失败'), { sent: true, resultState: 'unknown' });
    return { body: {} };
  });
  const result = await h.rain.putRainPoemPrankOnFriend(11, 5005);
  assert.equal(result.placed, true); assert.equal(result.ok, false); assert.equal(result.failed, true); assert.equal(result.unknown, true);
  assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Use', 'Leave']); assert.equal(h.timers.size, 0);
});

test('雨诗缺库存或没有目标地块仍Leave，不发Use', async () => {
  for (const kind of ['inventory', 'land']) {
    const h = placementHarness();
    if (kind === 'inventory') h.setInventory([]); else h.setLands([]);
    const result = await h.rain.putRainPoemPrankOnFriend(11, 5005);
    assert.equal(result.ok, false); assert.equal(result.placed, false);
    assert.deepEqual(h.calls.map(call => call.method), ['Enter', 'Leave']); assert.equal(h.timers.size, 0);
  }
});

test('自动雨诗第一瓶成功后关闭开关不访问第二好友', async () => {
  const h = placementHarness();
  h.setRpc(async (_service, method) => {
    if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }, { gid: 22 }] } };
    if (method === 'Enter') return { body: { lands: [{ id: 1, plant: { id: 1, phases: [{ phase: 3 }] } }] } };
    if (method === 'Use') h.setEnabled(false);
    return { body: {} };
  });
  const result = await h.rain.runRainPoemPrankPlacement();
  assert.equal(result.placed, 1);
  assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter', 'Use', 'Leave']); assert.equal(h.timers.size, 0);
});

test('黄金虫与自动雨诗已处理blacklist返回skipped，不静默伪零成功', async () => {
  for (const mode of ['golden', 'rain']) {
    const h = placementHarness(); h.setGids([11]);
    h.setRpc(async (_service, method) => {
      if (method === 'GetGameFriends') return { body: { game_friends: [{ gid: 11 }] } };
      throw Object.assign(new Error('已加入黑名单'), { sent: true, stage: 'remote', resultState: 'failed',
        friendEnterHandling: { handled: true, kind: 'blacklist' } });
    });
    const result = mode === 'golden' ? await h.golden.runGoldenBugPlacement({ force: true }) : await h.rain.runRainPoemPrankPlacement();
    assert.equal(result.skipped, true); assert.equal(result.skippedFriends, 1);
    assert.deepEqual(h.calls.map(call => call.method), ['GetGameFriends', 'Enter']); assert.equal(h.timers.size, 0);
  }
});
