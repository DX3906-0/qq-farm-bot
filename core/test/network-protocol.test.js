const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_CLIENT_VERSION, resolveClientVersion } = require('../src/config/config');
let protocol;
const buildHeartbeatBody = (...args) => protocol.buildHeartbeatBody(...args);
const buildLoginBody = (...args) => protocol.buildLoginBody(...args);

// 2026-11-02 同步上游 1.16.1.6_20261028 后的登录体指纹（由 buildLoginBody() 实际生成）
const OFFICIAL_LOGIN_BODY =
  '180022002a1c0a11312e31362e312e365f3230323631303238120757696e646f777330003a073132333435363742180a0012001a0022002a086f746865722d717130023a004200'
  + '';
const OFFICIAL_HEARTBEAT_BODY = '08f9d6ffc5041211312e31362e312e365f3230323631303238';

test.before(async () => {
  await Promise.resolve();
  const root = new protobuf.Root().loadSync([
    path.join(__dirname, '../src/proto/player-login.proto'),
    path.join(__dirname, '../src/proto/userpb.proto'),
  ], { keepCase: true });
  root.resolveAll();
  const types = Object.fromEntries(['LoginRequest', 'HeartbeatRequest'].map(name => [name, root.lookupType(`gamepb.userpb.${name}`)]));
  const filename = path.join(__dirname, '../src/utils/network.js');
  const blocked = () => assert.fail('协议夹具禁止传输、IPC、定时调度和后端调用');
  const dependencies = {
    'node:buffer': { Buffer }, 'node:events': require('node:events'),
    'node:process': { env: { FARM_NETWORK_MODE: 'local' }, exit: blocked },
    'node:worker_threads': { workerData: null }, ws: class { constructor() { blocked(); } },
    '../config/config': { ...require('../src/config/config'), CONFIG: { ...require('../src/config/config').CONFIG } },
    '../services/ace-service': { AceService: class { constructor() { blocked(); } } },
    '../services/scheduler': { createScheduler: () => ({ setTimeoutTask: blocked, setIntervalTask: blocked, clear: () => {} }) },
    '../services/status': {}, '../services/stats': {}, './proto': { types },
    './utils': { toLong: Long.fromNumber, toNum, log: () => {}, logWarn: () => {} },
    './crypto-wasm': {}, './gateway-token': { createGatewayToken: blocked }, './tsdk-runtime': {},
    './request-priority': {
      ...require('../src/utils/request-priority'),
      createWriteDrain: () => ({ wait: blocked, notify: blocked }),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, setTimeout: blocked, clearTimeout: () => {},
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `未模拟协议依赖 ${id}`);
      return dependencies[id];
    },
  }, { filename });
  protocol = module.exports;
});

test('default client protocol is upgraded without replacing custom versions', () => {
  assert.equal(DEFAULT_CLIENT_VERSION, '1.16.1.6_20261028');
  assert.equal(resolveClientVersion('1.13.0.5_20260723'), DEFAULT_CLIENT_VERSION);
  assert.equal(resolveClientVersion('1.13.2.9_20260723'), DEFAULT_CLIENT_VERSION);
  // 低于基线的版本会被拉回基线（只升不降）
  assert.equal(resolveClientVersion('1.15.0.1_20261001'), DEFAULT_CLIENT_VERSION);
  // 高于基线的版本原样保留
  assert.equal(resolveClientVersion('1.17.0.1_20261101'), '1.17.0.1_20261101');
  assert.equal(resolveClientVersion('custom-build'), 'custom-build');
});

test('default login request reproduces the 1.16.1.6 official capture', () => {
  assert.equal(buildLoginBody().toString('hex'), OFFICIAL_LOGIN_BODY);
});

test('custom device protocol keeps its explicit fingerprint fields', () => {
  const body = buildLoginBody({
    enabled: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    deviceBrand: 'Xiaomi',
    deviceModel: 'Xiaomi 14 Ultra',
    deviceId: 'device-14-ultra',
  });
  assert.notEqual(body.toString('hex'), OFFICIAL_LOGIN_BODY);
});

test('heartbeat request reproduces the official capture', () => {
  assert.equal(buildHeartbeatBody(1220537209).toString('hex'), OFFICIAL_HEARTBEAT_BODY);
});

test('官方访友HostType：Enter字段3、Leave字段2、GameFriend字段11一致且不改默认REAL', () => {
  const root = new protobuf.Root().loadSync([path.join(__dirname, '../src/proto/visitpb.proto'),
    path.join(__dirname, '../src/proto/friendpb.proto')], { keepCase: true });
  root.resolveAll();
  const enter = root.lookupType('gamepb.visitpb.EnterRequest');
  const leave = root.lookupType('gamepb.visitpb.LeaveRequest');
  const friend = root.lookupType('gamepb.friendpb.GameFriend');
  assert.equal(enter.fields.host_type.id, 3); assert.equal(leave.fields.host_type.id, 2);
  assert.equal(friend.fields.host_type.id, 11);
  for (const hostType of [0, 1, 3]) {
    const enterWire = enter.encode(enter.create({ host_gid: 10001, reason: 2, host_type: hostType })).finish();
    const leaveWire = leave.encode(leave.create({ host_gid: 10001, host_type: hostType })).finish();
    assert.equal(enterWire.toString('hex'), `08914e100218${hostType.toString(16).padStart(2, '0')}`);
    assert.equal(leaveWire.toString('hex'), `08914e10${hostType.toString(16).padStart(2, '0')}`);
    assert.equal(leave.decode(leaveWire).host_type, hostType);
  }
  assert.equal(leave.decode(Buffer.from('08914e', 'hex')).host_type, 0);
});

test('官方放虫草线格式：host_type字段3、reason字段4，与独立官方编码字节一致', () => {
  const root = new protobuf.Root().loadSync([path.join(__dirname, '../src/proto/plantpb.proto')], { keepCase: true });
  root.resolveAll();
  // c68e官方plantpb.ts encode：tag8 host_gid，tag18 packed land_ids，tag24 host_type，tag32 reason。
  // 不使用生产schema生成期望字节，避免同错自证。
  for (const name of ['PutInsectsRequest', 'PutWeedsRequest']) {
    const request = root.lookupType(`gamepb.plantpb.${name}`);
    assert.equal(request.fields.host_type.id, 3); assert.equal(request.fields.reason.id, 4);
    const wire = Buffer.from('08914e1202010218032002', 'hex');
    const actual = request.encode(request.create({ host_gid: 10001, land_ids: [1, 2], host_type: 3, reason: 2 })).finish();
    assert.equal(actual.toString('hex'), wire.toString('hex'));
    const decoded = request.decode(wire);
    assert.equal(toNum(decoded.host_gid), 10001); assert.deepEqual(decoded.land_ids.map(toNum), [1, 2]);
    assert.equal(decoded.host_type, 3); assert.equal(decoded.reason, 2);
  }
});

// DogService 只使用模拟 RPC；以下套件不连接游戏、不调用真实宠物操作。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const protobuf = require('protobufjs');
const Long = require('long');
const numericUtils = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/utils.js'), 'utf8'), {
  module: numericUtils,
  require(id) {
    if (id === 'long') return Long;
    if (id === '../services/logger') return { createModuleLogger: () => ({}), sanitizeMeta: value => value };
    throw new Error(`未模拟数值工具依赖 ${id}`);
  },
});
const { toNum } = numericUtils.exports;
const { AsyncLocalStorage } = require('node:async_hooks');

function createServiceClock() {
  let now = Date.now();
  const timers = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const timer = {}; timers.set(timer, { fn, at: now + ms }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    tick(ms) {
      now += ms;
      for (const [timer, task] of [...timers]) if (task.at <= now) { timers.delete(timer); task.fn(); }
    },
    get pending() { return timers.size; },
    clear() { timers.clear(); },
  };
}

function loadSimulatedService(name, dependencies, globals = {}) {
  const filename = path.join(__dirname, '../src/services', `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    Uint8Array,
    ...globals,
    require(id) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, id)) throw new Error(`未模拟依赖 ${id}`);
      return dependencies[id];
    },
  }, { filename });
  return module.exports;
}

function createDogHarness() {
  const clock = createServiceClock();
  const controls = { getBag: null, releases: 0 };
  const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/dogpb.proto'), { keepCase: true });
  root.resolveAll();
  const types = Object.fromEntries([
    'GetDogInfoRequest', 'GetDogInfoReply', 'ClaimSkillGiftsRequest', 'ClaimSkillGiftsReply',
    'ActivateDogRequest', 'ActivateDogReply', 'DeployDogRequest', 'DeployDogReply',
    'WithdrawDogRequest', 'WithdrawDogReply', 'AddFoodRequest', 'AddFoodReply',
  ].map(name => [name, root.lookupType(`gamepb.dogpb.${name}`)]));
  const info = {
    dog_list: [{ id: 90031, owned: false, activated: true }],
    current_deployed_dog_id: 0, food_last_sec: 99, max_food_last_sec: 2592000,
    pending_gift_count: 0,
  };
  const calls = [];
  const warnings = [];
  const bag = { items: [{ id: 90004, count: 2 }] };
  const responses = new Map([['GetDogInfo', { body: info }]]);
  const dependencies = {
    'node:async_hooks': { AsyncLocalStorage },
    './capital-mode': { releaseForManualCommand: () => { controls.releases++; } },
    '../config/gameConfig': { getItemById: id => ({ id, name: `模拟物品#${id}`, desc: '测试元数据', rarity: 3 }), getItemImageById: id => `/fixture/${id}.png` },
    '../utils/proto': { types },
    '../utils/utils': { toNum, log: () => {}, logWarn: (...args) => warnings.push(args) },
    '../utils/network': {
      async sendMsgAsync(service, method, payload) {
        assert.equal(service, 'gamepb.dogpb.DogService');
        calls.push({ method, payload });
        if (!responses.has(method)) throw new Error(`未模拟 RPC ${method}`);
        const response = responses.get(method);
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response(payload) : response;
      },
    },
    './warehouse': { getBag: async () => controls.getBag ? controls.getBag() : bag, getBagItems: reply => reply.items || [] },
    './logger': { createModuleLogger: () => ({ warn: message => warnings.push(message), info: () => {} }) },
  };
  const dog = loadSimulatedService('dog-skill-gifts', dependencies);
  dependencies['./dog-skill-gifts'] = dog;
  const pet = loadSimulatedService('pets', dependencies, clock);
  dependencies['./pets'] = pet;
  return { root, types, info, bag, calls, warnings, responses, dog, pet, clock, controls, dependencies };
}

const plain = value => JSON.parse(JSON.stringify(value));

async function rejectedPetResult(promise, expected) {
  let result;
  await assert.rejects(promise, error => {
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    assert.equal(error.retryable, false);
    assert.equal(error.writeSent, error.sent);
    assert.equal(error.outcome, error.resultState);
    assert.equal(error.outcomeUnknown, error.resultState === 'unknown');
    result = { ...error, error: error.message };
    return true;
  });
  return result;
}

test.describe('DogService 核心纯模拟回归', () => {
  test('手写 wire：卡字段 6=false、激活字段 7=true，时长及技能字段正确', async () => {
    const h = createDogHarness();
    const dogBytes = protobuf.Writer.create().uint32(8).int64(90031)
      .uint32(48).bool(false).uint32(56).bool(true).finish();
    const skillBytes = protobuf.Writer.create().uint32(8).int64(7).uint32(16).int64(2)
      .uint32(24).int64(5).uint32(32).int64(90031).finish();
    const wire = protobuf.Writer.create().uint32(10).bytes(dogBytes).uint32(16).int64(0)
      .uint32(24).int64(99).uint32(32).int64(2592000).uint32(56).int64(3)
      .uint32(66).bytes(skillBytes).finish();
    h.responses.set('GetDogInfo', { body: wire });
    const snapshot = h.pet.buildPetSnapshot(await h.dog.getDogInfo());
    const dog = snapshot.dogs.find(item => item.id === 90031);
    assert.equal(dog.owned, true);
    assert.equal(dog.cardOwned, false);
    assert.equal(dog.activated, true);
    assert.equal(snapshot.deployedId, 0);
    assert.equal(snapshot.foodSeconds, 99);
    assert.equal(snapshot.protectSeconds, 2592000);
    assert.equal(snapshot.pendingGiftCount, 3);
    assert.deepEqual(plain(dog.skillUsage), [{ skillId: 7, usedCount: 2, dailyLimit: 5 }]);
    assert.equal(Object.prototype.hasOwnProperty.call(dog, 'level'), false);
    assert.equal(h.types.GetDogInfoRequest.encode({}).finish().length, 0);
    const food = h.root.lookupType('gamepb.dogpb.FoodInfo');
    assert.equal(toNum(food.decode(Buffer.from('080110021803', 'hex')).own_count), 3);
  });

  test('structured 对象及 repeated Message 不二次 decode', async () => {
    const h = createDogHarness();
    const wire = h.types.GetDogInfoReply.encode(h.info).finish();
    const message = h.types.GetDogInfoReply.decode(wire);
    h.types.GetDogInfoReply.decode = () => { throw new Error('不应二次 decode'); };
    for (const body of [h.info, message]) {
      h.responses.set('GetDogInfo', { body });
      assert.equal(await h.dog.getDogInfo(), body);
      assert.equal(h.pet.buildPetSnapshot(body).dogs.find(item => item.id === 90031).owned, true);
    }
    assert.equal(h.dog.decodeDogReply(h.types.GetDogInfoReply, message), message);
  });

  test('bool、数字、字符串 0/1、Long 和序列化 Long 保留三态', () => {
    const h = createDogHarness();
    for (const value of [true, 1, '1', Long.ONE, { low: 1, high: 0 }]) {
      const state = h.pet.getDogActivationState({ dog_list: [{ id: Long.fromNumber(90031), owned: value, activated: value }] }, 90031);
      assert.equal(state.owned, true);
      assert.equal(state.activated, true);
    }
    for (const value of [false, 0, '0', Long.ZERO, { low: 0, high: 0 }]) {
      assert.equal(h.pet.getDogActivationState({ dog_list: [{ id: 90031, owned: value, activated: value }] }, 90031).owned, false);
    }
    for (const value of [{}, 'false', '', 2, null, undefined]) {
      assert.equal(h.pet.getDogActivationState({ dog_list: [{ id: 90031, owned: value }] }, 90031).owned, null);
    }
  });

  test('缺字段、空列表和错误响应不产生正常全未拥有快照', async () => {
    const h = createDogHarness();
    for (const body of [{}, { dogs: [{ id: 90031 }] }, { dog_list: [] }, { dog_list: [{}] }]) {
      h.responses.set('GetDogInfo', { body });
      await assert.rejects(h.dog.getDogInfo());
    }
    const emptyMessage = h.types.GetDogInfoReply.decode(h.types.GetDogInfoReply.encode({ max_food_last_sec: 2592000 }).finish());
    h.responses.set('GetDogInfo', { body: emptyMessage });
    await assert.rejects(h.dog.getDogInfo(), /空 dog_list/);
    assert.throws(() => h.pet.buildPetSnapshot(emptyMessage), /空 dog_list/);
    assert.throws(() => h.pet.buildPetSnapshot({ ...h.info, dog_list: [{ id: 90031 }] }), /拥有状态/);
    for (const field of ['food_last_sec', 'max_food_last_sec', 'current_deployed_dog_id']) {
      const missing = { ...h.info };
      delete missing[field];
      assert.throws(() => h.pet.buildPetSnapshot(missing));
    }
    assert.throws(() => h.pet.buildPetSnapshot({ error: '失败' }));
    for (const response of [{ ok: false, error: '失败' }, { meta: { errorCode: Long.ONE }, body: h.info }, { body: Buffer.from([10, 255]) }]) {
      h.responses.set('GetDogInfo', response);
      await assert.rejects(h.dog.getDogInfo());
    }
    await assert.rejects(h.pet.getPetOverview());
    assert.ok(h.warnings.some(item => Array.isArray(item) && item[2]?.result === 'error'));
  });

  test('Message 实例继承 $type 与缺省 false/0，普通对象不可借伪 $type 补值', () => {
    const h = createDogHarness();
    const message = h.types.GetDogInfoReply.decode(h.types.GetDogInfoReply.encode({ dog_list: [{ id: 90031 }], max_food_last_sec: 2592000 }).finish());
    const dog = message.dog_list[0];
    assert.equal(message.$type, h.types.GetDogInfoReply);
    assert.equal(dog.$type, h.root.lookupType('gamepb.dogpb.DogInfo'));
    assert.ok(dog instanceof dog.$type.ctor);
    assert.equal(Object.prototype.hasOwnProperty.call(dog, '$type'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(dog, 'owned'), false);
    assert.equal(dog.owned, false);
    const snapshot = h.pet.buildPetSnapshot(message);
    assert.equal(snapshot.dogs.find(item => item.id === 90031).owned, false);
    assert.equal(snapshot.foodSeconds, 0);
    assert.equal(snapshot.deployedId, 0);
    const fake = Object.assign(Object.create({ owned: false, activated: false }), { id: 90031, $type: dog.$type });
    assert.equal(h.pet.getDogActivationState({ dog_list: [fake] }, 90031).owned, null);
  });

  test('卡、激活、claimable 和派出 ID 独立，缺席稀有宠物为 null 加 warning', async () => {
    const h = createDogHarness();
    const snapshot = await h.pet.getPetOverview();
    const missing = snapshot.dogs.find(item => item.id === 90021);
    assert.equal(missing.owned, null);
    assert.equal(missing.activated, null);
    assert.ok(snapshot.warnings.length > 0);
    assert.ok(h.warnings.some(item => Array.isArray(item) && item[2]?.result === 'warn'));
    const card = h.pet.getDogActivationState({ dog_list: [{ id: 90031, owned: true, activated: false }] }, 90031);
    assert.equal(card.owned, true);
    assert.equal(card.activatable, true);
    assert.equal(card.activated, false);
    const unknown = { dog_list: [{ id: 90031, claimable: true }], current_deployed_dog_id: 90031 };
    assert.equal(h.pet.getDogActivationState(unknown, 90031).owned, null);
    const activated = h.pet.getDogActivationState({ dog_list: [{ id: 90031, owned: false, activated: true }] }, 90031);
    assert.equal(activated.owned, true);
    assert.equal(activated.activatable, false);
  });

  test('未知 owner 拒绝激活、派出和喂食，已激活不重复写 RPC', async () => {
    const h = createDogHarness();
    assert.equal((await h.pet.activateDog(90031)).activated, false);
    assert.deepEqual(h.calls.map(item => item.method), ['GetDogInfo']);
    h.calls.length = 0;
    h.responses.set('GetDogInfo', { body: { ...h.info, dog_list: [{ id: 90031, claimable: true }] } });
    for (const operation of [() => h.pet.activateDog(90031), () => h.pet.deployDog(90031), () => h.pet.feedDog(90004)]) {
      await assert.rejects(operation());
    }
    assert.ok(h.calls.every(item => item.method === 'GetDogInfo'));
    h.responses.set('GetDogInfo', { body: { ...h.info, dog_list: [{ id: 90031, owned: true, activated: false }] } });
    await assert.rejects(h.pet.deployDog(90031), /尚未激活/);
    assert.ok(h.calls.every(item => item.method === 'GetDogInfo'));
  });

  test('领取礼包保留 repeated 奖励/补偿，零 pending 与缺失计数不同', async () => {
    const h = createDogHarness();
    h.info.pending_gift_count = 3;
    const wire = h.types.ClaimSkillGiftsReply.encode({
      rewards: [{ id: 101351, count: 2 }, { id: 1, count: 10 }],
      compensated_items: [{ id: 2, count: 3 }], claimed_gift_count: 2, pending_gift_count: 0,
    }).finish();
    const message = h.types.ClaimSkillGiftsReply.decode(wire);
    const defaultZero = h.types.ClaimSkillGiftsReply.decode(h.types.ClaimSkillGiftsReply.encode({ rewards: [{ id: 101351, count: 1 }], claimed_gift_count: 1 }).finish());
    assert.equal(Object.prototype.hasOwnProperty.call(defaultZero, 'pending_gift_count'), false);
    assert.equal(h.dog.getPendingGiftCount(defaultZero), 0);
    h.responses.set('ClaimSkillGifts', { body: wire });
    const claimed = await h.dog.checkAndClaimDogSkillGifts(3);
    assert.equal(claimed.claimed, 2);
    assert.equal(claimed.pending, 0);
    assert.equal(toNum(claimed.item.id), 101351);
    assert.equal(claimed.rewards.length, 2);
    assert.equal(claimed.compensatedItems.length, 1);
    h.types.ClaimSkillGiftsReply.decode = () => { throw new Error('不应二次 decode 奖励'); };
    h.responses.set('ClaimSkillGifts', { body: message });
    assert.equal((await h.dog.checkAndClaimDogSkillGifts(3)).pending, 0);
    h.responses.set('ClaimSkillGifts', { body: defaultZero });
    const zeroResult = await h.dog.checkAndClaimDogSkillGifts(1);
    assert.equal(zeroResult.pending, 0);
    assert.equal(zeroResult.error, undefined);
    const object = { rewards: [{ id: 101351, count: 7 }], compensatedItems: [{ id: 2, count: 1 }], claimedGiftCount: 1, pendingGiftCount: 0 };
    h.responses.set('ClaimSkillGifts', { body: object });
    assert.equal((await h.dog.checkAndClaimDogSkillGifts(3)).claimed, 1);
    assert.equal(h.dog.getPendingGiftCount({ pending_gift_count: Long.ZERO }), 0);
    assert.equal(h.dog.getPendingGiftCount({ pendingGiftCount: 0 }), 0);
    assert.throws(() => h.dog.getPendingGiftCount({}), /缺少/);
    h.responses.set('ClaimSkillGifts', { body: { rewards: [], claimed_gift_count: 0 } });
    const expectedFailure = { errorCode: 'PET_COMMAND_FAILED', sent: true, resultState: 'unknown', source: 'gifts', method: 'ClaimSkillGifts' };
    assert.match((await rejectedPetResult(h.dog.checkAndClaimDogSkillGifts(1), expectedFailure)).error, /不完整/);
    h.responses.set('ClaimSkillGifts', { body: { rewards: [], claimed_gift_count: null, pending_gift_count: 0 } });
    assert.match((await rejectedPetResult(h.dog.checkAndClaimDogSkillGifts(1), expectedFailure)).error, /不完整/);
    h.info.pending_gift_count = 0;
    h.calls.length = 0;
    h.responses.set('GetDogInfo', { body: h.info });
    assert.equal((await h.dog.checkAndClaimDogSkillGifts()).pending, 0);
    assert.deepEqual(h.calls.map(item => item.method), ['GetDogInfo']);
  });

  test('camel 普通对象和序列化 Long 的时长、派出及技能字段正确', async () => {
    const h = createDogHarness();
    const body = {
      dogList: [{ id: { low: 90031, high: 0 }, owned: false, activated: true }],
      currentDeployedDogId: 90031, foodLastSec: Long.fromNumber(99), maxFoodLastSec: 2592000,
      pendingGiftCount: Long.fromNumber(3),
      skillUseInfos: [{ skillId: 7, dogId: 90031, dailyTriggerCount: 2, maxTriggerDaily: 5 }],
    };
    h.responses.set('GetDogInfo', { body });
    assert.equal(await h.dog.getDogInfo(), body);
    const snapshot = h.pet.buildPetSnapshot(body);
    const dog = snapshot.dogs.find(item => item.id === 90031);
    assert.equal(dog.deployed, true);
    assert.equal(dog.owned, true);
    assert.equal(snapshot.pendingGiftCount, 3);
    assert.equal(snapshot.foodSeconds, 99);
    assert.deepEqual(plain(dog.skillUsage), [{ skillId: 7, usedCount: 2, dailyLimit: 5 }]);
  });

  test('派出列表或激活状态不一致报错，不强制补 owned', () => {
    const h = createDogHarness();
    assert.throws(() => h.pet.buildPetSnapshot({ ...h.info, current_deployed_dog_id: 90001 }), /不在响应列表/);
    assert.throws(() => h.pet.buildPetSnapshot({ ...h.info, current_deployed_dog_id: 90031, dog_list: [{ id: 90031, owned: true, activated: false }] }), /不一致/);
    assert.throws(() => h.pet.buildPetSnapshot({ ...h.info, current_deployed_dog_id: null }));
    assert.throws(() => h.pet.buildPetSnapshot({ ...h.info, max_food_last_sec: 0 }));
  });

  test('喂食使用真实 proto 时长/上限及 Message 缺省值，不用假定 30 天补缺字段', async () => {
    const h = createDogHarness();
    const message = h.types.GetDogInfoReply.decode(h.types.GetDogInfoReply.encode({ dog_list: h.info.dog_list, max_food_last_sec: 86400 }).finish());
    h.responses.set('GetDogInfo', { body: message });
    const added = h.types.AddFoodReply.decode(h.types.AddFoodReply.encode({ food_last_sec: 86400 }).finish());
    h.responses.set('AddFood', { body: added });
    assert.equal((await h.pet.feedDog(90004)).foodSeconds, 86400);
    const request = h.types.AddFoodRequest.decode(h.calls.find(item => item.method === 'AddFood').payload);
    assert.equal(toNum(request.item_id), 90004);
    assert.equal(toNum(request.count), 1);
    const zero = h.types.AddFoodReply.decode(Buffer.alloc(0));
    h.responses.set('AddFood', { body: zero });
    assert.equal((await h.pet.feedDog(90004)).foodSeconds, 0);
    h.responses.set('GetDogInfo', { body: { dogList: h.info.dog_list, currentDeployedDogId: 0, foodLastSec: 0, maxFoodLastSec: 86400 } });
    h.responses.set('AddFood', { body: { foodLastSec: 86400 } });
    assert.equal((await h.pet.feedDog(90004)).foodSeconds, 86400);
    h.calls.length = 0;
    h.responses.set('GetDogInfo', { body: h.types.GetDogInfoReply.decode(h.types.GetDogInfoReply.encode({ dog_list: h.info.dog_list }).finish()) });
    await assert.rejects(h.pet.feedDog(90004), /时长/);
    h.responses.set('GetDogInfo', { body: { ...h.info, food_last_sec: 1, max_food_last_sec: 86400 } });
    await assert.rejects(h.pet.feedDog(90004), /超过/);
    assert.ok(h.calls.every(item => item.method === 'GetDogInfo'));
    h.responses.set('GetDogInfo', { body: { ...h.info, food_last_sec: 0 } });
    h.responses.set('AddFood', { body: {} });
    await assert.rejects(h.pet.feedDog(90004), /响应缺少/);
  });

  test('资本模式只选 owned=true 且 activated=true 的宠物', async () => {
    let candidate = { id: 90031, owned: true, activated: false };
    const deployed = [];
    const capital = loadSimulatedService('capital-mode', {
      '../config/config': { PlantPhase: { MATURE: 1 } },
      '../models/store': { getCapitalMode: () => ({ enabled: true, dogId: 90031, leadSeconds: 10 }) },
      '../utils/utils': { getServerTimeSec: () => 1, toNum, toTimeSec: toNum, log: () => {} },
      './scheduler': { createScheduler: () => ({ clear: () => {}, setTimeoutTask: () => {} }) },
      './pets': {
        withPetCommand: async (operation, options) => {
          assert.equal(options.source, 'capital');
          const lease = { assertCurrent: () => assert.equal(options.validate(), true) };
          return operation(lease);
        },
        getPetOverview: async ({ lease }) => { lease.assertCurrent(); return { deployedId: 0, dogs: [candidate] }; },
        deployDog: async (id, options) => {
          options.lease.assertCurrent();
          assert.equal(options.source, 'capital');
          assert.equal(options.onlyIfUndeployed, true);
          deployed.push(id);
          return { ok: true, deployed: true, dogId: id };
        },
        withdrawDog: async () => assert.fail('资格测试不应召回'),
      },
    });
    const operation = { lands: [], analysis: { harvestable: [1] }, opType: 'harvest' };
    for (const activated of [false, null, undefined, 1]) {
      candidate = { id: 90031, owned: true, activated };
      capital._state.lastAttemptAt = 0;
      assert.equal(await capital.prepareForFarmOperation(operation), false);
    }
    assert.deepEqual(deployed, []);
    candidate = { id: 90031, owned: true, activated: true };
    capital._state.lastAttemptAt = 0;
    assert.equal(await capital.prepareForFarmOperation(operation), true);
    assert.deepEqual(deployed, [90031]);
  });
});

function loadFrontendModule(relative, dependencies, globals = {}, transform = source => source) {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const ts = webRequire('typescript');
  const filename = path.join(__dirname, '../../web/src', relative);
  const code = ts.transpileModule(transform(fs.readFileSync(filename, 'utf8')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController, URLSearchParams, ...globals,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (['vue', 'pinia'].includes(id)) return webRequire(id);
      if (id === 'axios') {
        const axios = webRequire('axios');
        const isolated = Object.assign(function (...args) { return axios(...args); }, axios, {
          create: config => axios.create({ ...config, adapter: () => assert.fail('禁止真实 HTTP adapter') }),
        });
        isolated.default = isolated;
        return isolated;
      }
      throw new Error(`未模拟前端依赖 ${id}`);
    },
  }, { filename });
  return module.exports;
}
function createApiHarness() {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const axios = webRequire('axios');
  const vue = webRequire('vue');
  const storage = { admin_token: vue.ref('session-1'), current_account_id: vue.ref('a') };
  const pending = [];
  const toasts = [];
  let observations = 0;
  const exports = loadFrontendModule('api/index.ts', {
    '@vueuse/core': { useStorage: key => storage[key] },
    '@/stores/toast': { useToastStore: () => ({ error: m => toasts.push(m), warning: m => toasts.push(m) }) },
    '@/utils/requestMonitor': { installRequestMonitor(api) { api.interceptors.request.use(config => { observations++; return config; }, undefined, { synchronous: true }); } },
    '@/config/localReadonly': { LOCAL_UI_READONLY: false },
  }, { window: { location: { pathname: '/pet', href: '' } } });
  exports.default.defaults.adapter = config => new Promise((resolve, reject) => {
    const request = { config, resolve: data => resolve({ data, status: 200, statusText: 'OK', headers: {}, config }), reject };
    config.signal?.addEventListener('abort', () => reject(new axios.CanceledError('取消', config)), { once: true });
    pending.push(request);
  });
  return { ...exports, storage, pending, toasts, axios, get observations() { return observations; } };
}

function createPetStoreHarness() {
  // 从 web/package.json 定位依赖；转译与模拟模块只留在内存，不生成文件。
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const ts = webRequire('typescript');
  const vue = webRequire('vue');
  const pinia = webRequire('pinia');
  const account = vue.reactive({ currentAccountId: 'a' });
  const pending = [];
  const api = {
    get: (url, config) => new Promise((resolve, reject) => pending.push({ url, config, resolve, reject })),
    post: (url, body, config) => new Promise((resolve, reject) => pending.push({ url, body, config, resolve, reject })),
  };
  const filename = path.join(__dirname, '../../web/src/stores/pet.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    AbortController,
    require(id) {
      if (id === 'vue') return vue;
      if (id === 'pinia') return pinia;
      if (id === '@/api') return { __esModule: true, ...createApiHarness(), default: api, safeGet: (url, config) => api.get(url, config) };
      if (id === '@/stores/account') return { useAccountStore: () => account };
      throw new Error(`未模拟前端依赖 ${id}`);
    },
  }, { filename });
  const instance = pinia.createPinia();
  const store = module.exports.usePetStore(instance);
  return { account, pending, store, stop: () => pinia.disposePinia(instance) };
}

function petOverviewResponse(id) {
  return { data: { ok: true, data: {
    dogs: [{ id, owned: true, activated: true, deployed: false }], foods: [],
    deployedId: 0, foodSeconds: 10, protectSeconds: 2592000,
  } } };
}

function createReadStoreHarness(name, transform) {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const vue = webRequire('vue');
  const pinia = webRequire('pinia');
  const account = vue.reactive({ currentAccountId: 'a' });
  const pending = [];
  const api = {
    get: (url, config) => new Promise((resolve, reject) => pending.push({ url, config, resolve, reject })),
    post: (url, body, config) => new Promise((resolve, reject) => pending.push({ url, body, config, resolve, reject })),
  };
  const exports = loadFrontendModule(`stores/${name}.ts`, {
    '@/api': { __esModule: true, ...createApiHarness(), default: api, safeGet: (url, config) => api.get(url, config) },
    '@/stores/account': { useAccountStore: () => account },
    '@/utils/operation-result': loadFrontendModule('utils/operation-result.ts', {}),
  }, {}, transform);
  const instance = pinia.createPinia();
  const store = exports[`use${name[0].toUpperCase()}${name.slice(1)}Store`](instance);
  return { account, pending, store, stop: () => pinia.disposePinia(instance) };
}
test.describe('好友土地与神秘商人前端离线回归', () => {
  test('好友土地同号同GID只发一次访问，95秒预算交付非空结果并更新摘要', async (t) => {
    const h = createReadStoreHarness('friend'); t.after(h.stop);
    h.store.friends = [{ gid: '11' }];
    const a = h.store.fetchFriendLands('a', '11');
    const b = h.store.fetchFriendLands('a', '11');
    assert.equal(a, b);
    assert.equal(h.pending.length, 1);
    const request = h.pending.shift();
    assert.equal(request.config.timeout, 95000);
    assert.equal(request.url, '/api/friend/11/lands');
    request.resolve({ data: { ok: true, data: { lands: [{ id: 1, unlocked: true, status: 'stealable', needWater: true }], summary: {} } } });
    await Promise.all([a, b]);
    assert.equal(h.store.friendLands['11'][0].id, 1);
    assert.equal(h.store.friends[0].plant.stealNum, 1);
    assert.equal(h.store.friendLandsLoading['11'], false);
    assert.equal(h.store.friendLandsError['11'], '');
  });

  test('好友土地请求错误/ok:false/畸形响应不变空成功，不自动重试且保留上次土地', async (t) => {
    const h = createReadStoreHarness('friend'); t.after(h.stop);
    h.store.friendLands['11'] = [{ id: 6 }];
    const request = h.store.fetchFriendLands('a', '11');
    h.pending.shift().reject(Object.assign(new Error('Request failed with status code 503'), { response: { data: { error: '好友访问状态未知' } } }));
    await request;
    assert.equal(h.store.friendLandsError['11'], '好友访问状态未知');
    assert.equal(h.store.friendLands['11'][0].id, 6);
    assert.equal(h.pending.length, 0);
    for (const response of [{ data: { ok: false, error: '当前不可访问' } }, { data: { ok: true, data: {} } }]) {
      const read = h.store.fetchFriendLands('a', '11');
      h.pending.shift().resolve(response); await read;
      assert.ok(h.store.friendLandsError['11']);
      assert.equal(h.store.friendLands['11'][0].id, 6);
      assert.equal(h.store.friendLandsLoading['11'], false);
    }
    const empty = h.store.fetchFriendLands('a', '11');
    h.pending.shift().resolve({ data: { ok: true, data: { lands: [], summary: {} } } }); await empty;
    assert.equal(h.store.friendLandsError['11'], '');
    assert.equal(h.store.friendLands['11'].length, 0);
    // 旧catch吞错的变体必须无法通过“真实错误展示”断言。
    const old = createReadStoreHarness('friend', source => source.replace("friendLandsError.value[friendId] = error?.response?.data?.error || error?.message || '读取好友土地失败'", "friendLandsError.value[friendId] = ''"));
    t.after(old.stop);
    const oldRead = old.store.fetchFriendLands('a', '11');
    old.pending.shift().reject(new Error('读取失败')); await oldRead;
    assert.throws(() => assert.ok(old.store.friendLandsError['11']), { name: 'AssertionError' });
  });

  test('好友土地A-B-A和清数据不接纳旧结果，不取消旧访问也不重新发起同GID', async (t) => {
    const h = createReadStoreHarness('friend'); t.after(h.stop);
    const a = h.store.fetchFriendLands('a', '11');
    const old = h.pending.shift();
    h.account.currentAccountId = 'b';
    const b = h.store.fetchFriendLands('b', '11');
    const currentB = h.pending.shift();
    h.account.currentAccountId = 'a';
    assert.equal(h.store.fetchFriendLands('a', '11'), a);
    assert.equal(h.pending.length, 0, '已发访问尚未结算，切回账号不能补发');
    old.resolve({ data: { ok: true, data: { lands: [{ id: 99 }] } } });
    currentB.reject(new Error('旧B迟失败'));
    await Promise.all([a, b]);
    assert.equal(h.store.friendLands['11'], undefined);
    assert.equal(h.store.friendLandsError['11'], undefined);
    const fresh = h.store.fetchFriendLands('a', '11');
    h.pending.shift().resolve({ data: { ok: true, data: { lands: [{ id: 1 }] } } }); await fresh;
    assert.equal(h.store.friendLands['11'][0].id, 1);
    const delayed = h.store.fetchFriendLands('a', '12');
    const late = h.pending.shift(); h.store.clearFriendData();
    late.resolve({ data: { ok: true, data: { lands: [{ id: 12 }] } } }); await delayed;
    assert.equal(h.store.friendLands['12'], undefined);
    assert.equal(h.pending.length, 0);
  });

  test('真实好友组件区分访问失败、正常空数据、未加载与上次数据，不隐藏错误', async () => {
    const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
    const vue = webRequire('vue'), renderer = webRequire('vue/server-renderer'), compiler = webRequire('vue/compiler-sfc'), ts = webRequire('typescript');
    const filename = path.join(__dirname, '../../web/src/components/friends/FriendsFriendList.vue');
    const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor;
    const script = compiler.compileScript(descriptor, { id: 'friend-list-test', inlineTemplate: true, templateOptions: { ssr: true } }).content;
    const module = { exports: {} };
    const LandCard = vue.defineComponent({ props: ['land'], setup: props => () => vue.h('span', `土地#${props.land.id}`) });
    vm.runInNewContext(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
      module, exports: module.exports, Set, require(name) {
        if (name === 'vue') return vue;
        if (name === 'vue/server-renderer') return renderer;
        if (name === '@/components/LandCard.vue') return LandCard;
        throw new Error(`未声明SSR依赖${name}`);
      },
    }, { filename });
    const props = { friends: [{ gid: 11, name: '夹具' }], totalFriends: 1, totalPages: 1, pageSize: 25, currentPage: 1,
      blacklistGidSet: new Set(), knownFriendGidSet: new Set(), expandedFriends: new Set(['11']), friendLands: {}, friendLandsLoading: {},
      isQqAccount: true, canShowFriendAvatar: () => false, getFriendAvatar: () => '', getFriendLevel: () => 1, getFriendGold: () => 0,
      formatFriendGold: () => '', getFriendStatusText: () => '无操作', getFriendStatusHint: () => '', stealPlans: {} };
    const render = data => renderer.renderToString(vue.createSSRApp({ render: () => vue.h(module.exports.default, { ...props, ...data }) }));
    const failed = await render({ friendLandsError: { 11: '状态未知' } });
    assert.match(failed, /读取好友土地失败：状态未知/);
    assert.doesNotMatch(failed, /没有返回可展示|尚未读取|当前没有返回土地数据/);
    const retained = await render({ friendLandsError: { 11: '状态未知' }, friendLands: { 11: [{ id: 6 }] } });
    assert.match(retained, /保留上次成功读取/); assert.match(retained, /土地#6/);
    assert.match(await render({ friendLands: { 11: [] } }), /本次访问成功/);
    assert.match(await render({}), /尚未读取/);
  });

  test('神秘商人前端保留不在期原因，HTTP错误显示原文而非错误认定未出现', async (t) => {
    const ts = createRequire(path.join(__dirname, '../../web/package.json'))('typescript');
    const h = createReadStoreHarness('shop'); t.after(h.stop);
    const inactive = h.store.fetchMysteryShop('a');
    const request = h.pending.shift(); assert.equal(request.config.timeout, 65000);
    request.resolve({ data: { ok: true, data: { active: false, skipped: true, reason: 'inactive', statusLabel: '神秘商人当前不在期' } } });
    await inactive;
    assert.equal(h.store.mysteryOffer.reason, 'inactive');
    assert.equal(h.store.mysteryError, '');
    const failed = h.store.fetchMysteryShop('a');
    h.pending.shift().reject(Object.assign(new Error('Request failed with status code 502'), { response: { data: { error: '上游超时，请稍后确认' } } }));
    await failed;
    assert.equal(h.store.mysteryError, '上游超时，请稍后确认');
    assert.equal(h.pending.length, 0);
    const view = fs.readFileSync(path.join(__dirname, '../../web/src/views/Shop.vue'), 'utf8');
    const begin = view.indexOf('const activeEmptyMessage =');
    const end = view.indexOf('\nfunction openConfirm', begin);
    const compiled = ts.transpileModule(view.slice(begin, end) + '\n globalThis.label = activeEmptyMessage;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = { computed: vue => vue(), tab: { value: 'mystery' }, mysteryError: { value: '上游错误' }, mysteryLoading: { value: false }, mysteryOffer: { value: h.store.mysteryOffer } };
    vm.runInNewContext(compiled, context);
    assert.match(context.label, /读取失败.*无法确认是否在期/);
    context.mysteryError.value = '';
    const next = { ...context };
    vm.runInNewContext(compiled, next);
    assert.equal(next.label, '神秘商人当前不在期');
  });
});

function createPageHarness(name, { solarVisible = false, section = '' } = {}) {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const vue = webRequire('vue');
  const compiler = webRequire('vue/compiler-sfc');
  const ts = webRequire('typescript');
  const filename = path.join(__dirname, '../../web/src/views', `${name}.vue`);
  const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8')).descriptor;
  const script = compiler.compileScript(descriptor, { id: 'page-test' }).content;
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const account = { currentAccountId: vue.ref('a'), currentAccount: vue.ref({ name: 'a' }) };
  const calls = [];
  const pending = [];
  const toasts = [];
  const hooks = { mounted: [], dispose: [], unmounted: [] };
  const call = (method, args) => new Promise(resolve => { calls.push({ method, args }); pending.push(resolve); });
  const activity = new Proxy({}, { get: (_, method) => method === 'setReadSignal' || method === 'clearActivityData' ? () => {} : (...args) => call(method, args) });
  const pet = new Proxy({}, { get: (_, method) => (...args) => call(method, args) });
  const refs = Object.fromEntries(['overview', 'logs', 'capitalMode', 'capitalReady', 'loading', 'mutating', 'status', 'error', 'milkTeaPages'].map(key => [key, vue.ref(key === 'overview' ? { dogs: [], foods: [] } : key === 'milkTeaPages' ? {} : null)]));
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController,
    window: { setInterval: () => 1, clearInterval() {} },
    require(id) {
      if (id === 'vue') return { ...vue, onMounted: fn => hooks.mounted.push(fn), onScopeDispose: fn => hooks.dispose.push(fn), onUnmounted: fn => hooks.unmounted.push(fn) };
      if (id === 'pinia') return { storeToRefs: store => store === account ? account : new Proxy(refs, { get: (obj, key) => obj[key] || vue.ref(null) }) };
      if (id === 'vue-router') return { useRoute: () => ({ query: section ? { section } : {} }) };
      if (id === '@/stores/account') return { useAccountStore: () => account };
      if (id === '@/stores/activity') return { useActivityStore: () => activity };
      if (id === '@/stores/setting') return { useSettingStore: () => ({}) };
      if (id === '@/utils/activity-overview') return loadFrontendModule('utils/activity-overview.ts', {});
      if (id === '@/config/localReadonly') return loadFrontendModule('config/localReadonly.ts', {});
      if (id === '@/stores/pet') return { usePetStore: () => pet };
      if (id === '@/stores/toast') return { useToastStore: () => ({ error: m => toasts.push(m), success: m => toasts.push(m) }) };
      if (id === '@/stores/user') return { useUserStore: () => ({}) };
      if (id === '@/stores/activityDiscovery') return { useActivityDiscoveryStore: () => ({}) };
      if (id === '@/constants/activity-windows') return loadFrontendModule('constants/activity-windows.ts', {});
      if (id === '@/config/solarTerms') return loadFrontendModule('config/solarTerms.ts', {});
      if (id === '@/config/activityVisibility') return { isActivityHidden: key => !['milk-tea', 'pet-diary', 'qixi', ...(solarVisible ? ['notes'] : [])].includes(key) };
      if (id === '@/api') return { __esModule: true, default: { get: (...args) => call('bulletin', args) }, isReadCanceled: e => e?.code === 'ERR_CANCELED' };
      if (id === '@/composables/useContentMotion') return loadFrontendModule('composables/useContentMotion.ts', {});
      if ([
        '@/components/ui/BaseButton.vue', '@/components/ui/BaseSwitch.vue',
        '@/components/admin/AdminActivityUpdatePanel.vue', '@/components/activity/StarRecordPanel.vue',
        '@/components/activity/HeluExchangePanel.vue', '@/components/activity/HeluPassportPanel.vue',
        '@/views/SolarCalendar.vue', '@/components/activity/HeluSolarTermsPanel.vue', '@/components/activity/QingmeiActivityPanel.vue',
        '@/components/activity/AutoActivityPanel.vue', '@/components/activity/MilkTeaActivityPanel.vue', '@/components/activity/ActivityOverviewPanel.vue',
        '@/components/activity/PetDiaryActivityPanel.vue', '@/components/activity/QixiActivityPanel.vue',
        '@/components/activity/RainPoemActivityPanel.vue', '@/components/activity/RedFlowerActivityPanel.vue',
        '@/components/activity/ShareRewardActivityPanel.vue', '@/components/activity/WishSignActivityPanel.vue',
      ].includes(id)) return {};
      throw new Error(`未模拟页面依赖 ${id}`);
    },
  });
  const scope = vue.effectScope();
  const page = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { page, account, calls, pending, toasts, refs, mount: () => hooks.mounted.forEach(fn => fn()), stop() { hooks.dispose.forEach(fn => fn()); hooks.unmounted.forEach(fn => fn()); scope.stop(); } };
}
const drainFrontend = () => new Promise(resolve => setImmediate(resolve));

test('活动节令页只挂统一子面板，进入不读荷风树，刷新委派一次', async () => {
  const h = createPageHarness('Activity', { solarVisible: true, section: 'notes' });
  try {
    assert.equal(h.page.activeSection.value, 'notes', '旧日历URL query应直达统一节令tab');
    h.mount(); await drainFrontend();
    assert.equal(h.calls.filter(call => call.method === 'fetchHeluActivity').length, 0);
    let reads = 0;
    h.page.solarPanel.value = { refresh: async () => { reads++; } };
    await h.page.refreshAll();
    assert.equal(reads, 1);
    h.account.currentAccountId.value = 'b'; await drainFrontend();
    assert.equal(reads, 1, '换号读取由子面板自己执行，不父子双发');
    assert.equal(h.calls.filter(call => call.method === 'fetchHeluActivity').length, 0);
    assert.equal(h.page.sections.value.filter(item => item.key === 'notes').length, 1, '只能保留一个节令tab');
  } finally { h.stop(); }
});

function deferredPetCall() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.describe('宠物 lease、结果方案与协议依赖纯模拟回归', () => {
  test('精确依赖拒绝未知 backend，ALS 只注入无 I/O 的标准库', () => {
    assert.throws(() => loadSimulatedService('pets', {}), /未模拟依赖/);
    const h = createDogHarness();
    delete h.dependencies['node:async_hooks'];
    assert.throws(() => loadSimulatedService('pets', h.dependencies, h.clock), /未模拟依赖 node:async_hooks/);
    assert.equal(require.cache[require.resolve('../src/utils/network')], undefined);
    assert.equal(require.cache[require.resolve('../src/runtime/gateway-client')], undefined);
  });

  test('DogInfo 元数据与手写状态位逐字段核验，不借派出或 claimable 补 owned', () => {
    const h = createDogHarness();
    const dogType = h.root.lookupType('gamepb.dogpb.DogInfo');
    assert.deepEqual(Object.values(dogType.fields).map(field => [field.name, field.id, field.type]), [
      ['id', 1, 'int64'], ['name', 2, 'string'], ['protect_probability', 3, 'int64'],
      ['lost_gold_range_min', 4, 'int64'], ['lost_gold_range_max', 5, 'int64'],
      ['owned', 6, 'bool'], ['activated', 7, 'bool'], ['price', 8, 'int64'],
      ['expire_time', 9, 'int64'], ['is_reddot', 10, 'bool'],
    ]);
    for (const [cardOwned, activated, owned] of [[false, false, false], [true, false, true], [false, true, true], [true, true, true]]) {
      const bytes = protobuf.Writer.create().uint32(8).int64(90031).uint32(48).bool(cardOwned).uint32(56).bool(activated).finish();
      const state = h.pet.getDogActivationState({ dog_list: [dogType.decode(bytes)] }, 90031);
      assert.equal(state.cardOwned, cardOwned);
      assert.equal(state.activated, activated);
      assert.equal(state.owned, owned);
      assert.equal(state.activatable, cardOwned && !activated);
    }
    const replyType = h.types.GetDogInfoReply;
    assert.deepEqual(Object.values(replyType.fields).map(field => [field.name, field.id, field.type, field.repeated]), [
      ['dog_list', 1, 'DogInfo', true], ['current_deployed_dog_id', 2, 'int64', false],
      ['food_last_sec', 3, 'int64', false], ['max_food_last_sec', 4, 'int64', false],
      ['food_list', 5, 'FoodInfo', true], ['is_exist_new_log', 6, 'bool', false],
      ['pending_gift_count', 7, 'int64', false], ['skill_use_infos', 8, 'DogSkillUsage', true],
    ]);
    assert.deepEqual(Object.values(h.root.lookupType('gamepb.dogpb.DogSkillUsage').fields).map(field => [field.name, field.id]), [
      ['skill_id', 1], ['daily_trigger_count', 2], ['max_trigger_daily', 3], ['dog_id', 4],
    ]);
    assert.deepEqual(Object.values(h.root.lookupType('gamepb.dogpb.FoodInfo').fields).map(field => [field.name, field.id]), [
      ['id', 1], ['time', 2], ['own_count', 3],
    ]);
    const snapshot = h.pet.buildPetSnapshot(h.info, h.bag);
    const dog = snapshot.dogs.find(item => item.id === 90031);
    assert.deepEqual([dog.id, dog.name, dog.desc, dog.rarity, dog.image], [90031, '模拟物品#90031', '测试元数据', 3, '/fixture/90031.png']);
    assert.equal(h.clock.pending, 0);
  });

  test('只读夹具每次独立，Dog 与 Bag await 均结束才构造快照', async () => {
    const h = createDogHarness();
    const fresh = createDogHarness();
    h.info.food_last_sec = 0;
    h.bag.items[0].count = 1;
    assert.equal(fresh.info.food_last_sec, 99);
    assert.equal(fresh.bag.items[0].count, 2);
    const gate = deferredPetCall();
    h.controls.getBag = () => gate.promise;
    let complete = false;
    const read = h.pet.getPetOverview().then(snapshot => { complete = true; return snapshot; });
    await drainFrontend();
    assert.equal(complete, false);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo']);
    gate.resolve({ items: [{ id: 90004, count: 7 }] });
    assert.equal((await read).foods.find(item => item.id === 90004).count, 7);
    assert.equal(h.controls.releases, 0);
    assert.equal(h.clock.pending, 0);
  });

  test('喂食等 Bag 且完整事务串行，入队手动命令先释放资本所有权', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    h.info.food_last_sec = 0;
    const gate = deferredPetCall();
    h.controls.getBag = () => gate.promise;
    h.responses.set('AddFood', { body: { food_last_sec: 86400 } });
    h.responses.set('DeployDog', { body: { dog_id: 90031 } });
    const feed = h.pet.feedDog(90004);
    const deploy = h.pet.deployDog(90031);
    assert.equal(h.controls.releases, 2);
    await drainFrontend();
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo']);
    gate.resolve(h.bag);
    assert.equal((await feed).foodSeconds, 86400);
    assert.equal((await deploy).deployed, true);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'AddFood', 'GetDogInfo', 'DeployDog']);
    assert.deepEqual(plain(h.types.AddFoodRequest.decode(h.calls[1].payload)), { item_id: '90004', count: '1' });
    assert.equal(h.clock.pending, 0);
  });

  test('失效的 Bag await 不写 RPC，下一命令不穿透未完成读', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    h.info.food_last_sec = 0;
    const gate = deferredPetCall();
    h.controls.getBag = () => gate.promise;
    const feed = h.pet.feedDog(90004, 1, { source: 'food', timeoutMs: 10 });
    const failed = rejectedPetResult(feed, { errorCode: 'PET_COMMAND_TIMEOUT', sent: false, resultState: 'not_sent', source: 'food', method: null });
    await drainFrontend(); h.clock.tick(10); await failed;
    h.responses.set('DeployDog', { body: { dog_id: 90031 } });
    const next = h.pet.deployDog(90031);
    await drainFrontend();
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo']);
    gate.resolve(h.bag);
    assert.equal((await next).deployed, true);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'GetDogInfo', 'DeployDog']);
    assert.equal(h.clock.pending, 0);
  });

  test('写入超时 unknown 不释放在途 lease，晚回包结算后才执行下一命令', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    const gate = deferredPetCall();
    h.responses.set('DeployDog', () => gate.promise);
    h.responses.set('WithdrawDog', { body: { dog_id: 90031 } });
    const deploy = h.pet.deployDog(90031, { timeoutMs: 10 });
    const failed = rejectedPetResult(deploy, { errorCode: 'PET_COMMAND_TIMEOUT', sent: true, resultState: 'unknown', source: 'manual', method: 'DeployDog' });
    await drainFrontend(); h.clock.tick(10); await failed;
    const next = h.pet.withdrawDog();
    await drainFrontend();
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'DeployDog']);
    h.info.current_deployed_dog_id = 90031;
    gate.resolve({ body: { dog_id: 90031 } });
    assert.equal((await next).withdrawn, true);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'DeployDog', 'GetDogInfo', 'WithdrawDog']);
    assert.equal(h.clock.pending, 0);
  });

  test('永不结算写入仍占锁，队列超时不伪造成功且不留下 Node timer', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    h.responses.set('DeployDog', () => new Promise(() => {}));
    const first = h.pet.deployDog(90031, { timeoutMs: 10 });
    const failed = rejectedPetResult(first, { errorCode: 'PET_COMMAND_TIMEOUT', sent: true, resultState: 'unknown', source: 'manual', method: 'DeployDog' });
    await drainFrontend(); h.clock.tick(10); await failed;
    const queued = h.pet.withdrawDog({ timeoutMs: 10 });
    const rejected = rejectedPetResult(queued, { errorCode: 'PET_COMMAND_TIMEOUT', sent: false, resultState: 'not_sent', source: 'manual', method: null });
    h.clock.tick(10); await rejected;
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'DeployDog']);
    assert.equal(h.clock.pending, 0);
  });

  test('资本模式真实 lease 晚派出不得恢复所有权，手动命令等待结算且不补召回', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    const config = { enabled: true, dogId: 90031, leadSeconds: 10 };
    const tasks = new Map();
    const capital = loadSimulatedService('capital-mode', {
      '../config/config': { PlantPhase: { MATURE: 6 } },
      '../models/store': { getCapitalMode: () => config },
      '../utils/utils': { getServerTimeSec: () => 1, toNum, toTimeSec: toNum, log: () => {} },
      './scheduler': { createScheduler: () => ({ clear: key => tasks.delete(key), setTimeoutTask: (key, ms, fn) => tasks.set(key, { ms, fn }) }) },
      './pets': h.pet,
    }, h.clock);
    h.dependencies['./capital-mode'] = capital;
    const gate = deferredPetCall();
    h.responses.set('DeployDog', () => gate.promise);
    const auto = capital.prepareForFarmOperation({ lands: [], analysis: { harvestable: [1] }, opType: 'harvest' });
    await drainFrontend();
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'GetDogInfo', 'DeployDog']);
    const manual = h.pet.activateDog(90031);
    assert.equal(capital._state.generation, 1);
    assert.equal(capital._state.autoDogId, 0);
    await drainFrontend();
    assert.equal(h.calls.length, 3);
    h.info.current_deployed_dog_id = 90031;
    gate.resolve({ body: { dog_id: 90031 } });
    assert.equal(await auto, false);
    assert.equal((await manual).reason, 'already_activated');
    assert.equal(capital._state.phase, 'idle');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0);
    assert.equal(h.calls.some(call => call.method === 'WithdrawDog'), false);
    assert.equal(h.clock.pending, 0);
  });

  test('资本模式定时召回 unknown 仍拒绝，不吞 callback 失败或恢复旧所有权', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    const tasks = new Map();
    const capital = loadSimulatedService('capital-mode', {
      '../config/config': { PlantPhase: { MATURE: 6 } },
      '../models/store': { getCapitalMode: () => ({ enabled: true, dogId: 90031, leadSeconds: 10 }) },
      '../utils/utils': { getServerTimeSec: () => 1, toNum, toTimeSec: toNum, log: () => {} },
      './scheduler': { createScheduler: () => ({ clear: key => tasks.delete(key), setTimeoutTask: (key, ms, fn) => tasks.set(key, { ms, fn }) }) },
      './pets': h.pet,
    }, h.clock);
    h.responses.set('DeployDog', { body: { dog_id: 90031 } });
    assert.equal(await capital.prepareForFarmOperation({ lands: [], analysis: { harvestable: [1] }, opType: 'harvest' }), true);
    assert.equal(capital._state.autoDogId, 90031);
    h.info.current_deployed_dog_id = 90031;
    capital.handleFarmHarvested();
    const callback = tasks.get('withdraw_after_harvest');
    assert.equal(callback.ms, 5000);
    h.responses.set('WithdrawDog', Object.assign(new Error('模拟召回结果未知'), { errorCode: 'REQUEST_TIMEOUT', sent: true, resultState: 'unknown' }));
    await rejectedPetResult(callback.fn(), { errorCode: 'REQUEST_TIMEOUT', sent: true, resultState: 'unknown', source: 'capital', method: 'WithdrawDog' });
    assert.equal(capital._state.phase, 'idle');
    assert.equal(capital._state.autoDogId, 0);
    assert.equal(tasks.size, 0);
    assert.equal(h.calls.filter(call => call.method === 'WithdrawDog').length, 1);
    assert.equal(h.clock.pending, 0);
  });

  test('新结果方案 not_sent、failed、unknown 的 errorCode/sent 均不被宠物注解覆盖', async (t) => {
    for (const [sent, resultState] of [[false, 'not_sent'], [true, 'failed'], [true, 'unknown']]) {
      const h = createDogHarness(); t.after(h.clock.clear);
      const failure = Object.assign(new Error(`模拟${resultState}`), { errorCode: '模拟协议错误', sent, resultState });
      h.responses.set('DeployDog', failure);
      await rejectedPetResult(h.pet.deployDog(90031), { errorCode: '模拟协议错误', sent, resultState, source: 'manual', method: 'DeployDog' });
      assert.equal(h.calls.filter(call => call.method === 'DeployDog').length, 1);
      assert.equal(h.clock.pending, 0);
    }
  });

  test('礼包 critical unknown 逐订阅原样拒绝，不自动重试且 fresh fixture 独立', async (t) => {
    const h = createDogHarness(); t.after(h.clock.clear);
    h.info.pending_gift_count = 1;
    const failure = Object.assign(new Error('模拟 critical 写结果未知'), {
      errorCode: 'RPC_TIMEOUT', sent: true, resultState: 'unknown', outcomeUnknown: true, critical: true,
    });
    h.responses.set('ClaimSkillGifts', failure);
    const operation = h.dog.checkAndClaimDogSkillGifts(1);
    const duplicate = h.dog.checkAndClaimDogSkillGifts(1);
    const callbacks = await Promise.all([operation, duplicate].map(promise => rejectedPetResult(promise, {
      errorCode: 'RPC_TIMEOUT', sent: true, resultState: 'unknown', critical: true, source: 'gifts', method: 'ClaimSkillGifts',
    })));
    assert.equal(callbacks.length, 2);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'ClaimSkillGifts']);
    assert.equal(callbacks[0].error, failure.message);
    assert.equal(callbacks[1].error, failure.message);
    const fresh = createDogHarness(); t.after(fresh.clock.clear);
    fresh.info.pending_gift_count = 1;
    fresh.responses.set('ClaimSkillGifts', { body: { rewards: [{ id: 101351, count: 1 }], claimed_gift_count: 1, pending_gift_count: 0 } });
    assert.equal((await fresh.dog.checkAndClaimDogSkillGifts(1)).claimed, 1);
    assert.deepEqual(h.calls.map(call => call.method), ['GetDogInfo', 'ClaimSkillGifts']);
    assert.equal(h.clock.pending, 0);
    assert.equal(fresh.clock.pending, 0);
  });
});

test.describe('Pet/Activity Vue hook 当前页与有界切换回归', () => {
  test('Pet logs 切页不拉 Dog/Bag，卸载后不提示或写 draft', async () => {
    const h = createPageHarness('Pet');
    assert.deepEqual(h.calls.map(c => c.method), ['fetchOverview']);
    h.pending.shift()(true); await drainFrontend();
    h.page.tab.value = 'logs'; await drainFrontend();
    assert.deepEqual(h.calls.map(c => c.method), ['fetchOverview', 'fetchLogs']);
    const logsSignal = h.calls.at(-1).args[1];
    h.stop(); assert.equal(logsSignal.aborted, true);
    h.pending.shift()(false); await drainFrontend();
    assert.equal(h.toasts.length, 0);
  });
  test('Activity 公告只一次，百次切页只有当前页加一轮 dirty，无自动重复', async () => {
    const h = createPageHarness('Activity'); h.page.activeSection.value = 'pet-diary'; h.mount(); await drainFrontend();
    assert.deepEqual(h.calls.map(c => c.method), ['bulletin']);
    h.pending.shift()({ data: { ok: true, data: { bulletins: [] } } });
    h.page.activeSection.value = 'milk-tea'; await drainFrontend();
    assert.equal(h.calls.at(-1).method, 'fetchMilkTeaActivity');
    const oldSignal = h.calls.at(-1).args[3];
    for (let i = 0; i < 100; i++) h.page.milkTeaPage.value = i % 2 ? 'upgrade' : 'shop';
    await drainFrontend();
    assert.equal(h.calls.length, 2);
    assert.equal(oldSignal.aborted, false);
    h.pending.shift()({ ok: false, canceled: true }); await drainFrontend();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.at(-1).args[1], 'upgrade');
    h.pending.shift()({ ok: true }); await drainFrontend(); await drainFrontend();
    assert.equal(h.calls.length, 3);
    await h.page.fetchGameBulletinBanner();
    assert.equal(h.calls.filter(c => c.method === 'bulletin').length, 1);
    h.page.activeSection.value = 'pet-diary'; await drainFrontend();
    assert.equal(h.calls.length, 3);
    h.stop();
  });
  test('Activity 全部页面操作跨号迟结果静默，失败不抛出未处理拒绝', async () => {
    const methods = ['buildQixi', 'useQixiDew', 'claimRecords', 'claimPassport', 'claimQingmei', 'sellQingmeiWine', 'drawWishSign', 'claimWishSign', 'shareRewardShare', 'claimShareDaily', 'claimShareMilestones', 'onRedFlowerDonateLove', 'onRedFlowerDonateFund', 'onRedFlowerClaimShare', 'onRedFlowerClaimTiers'];
    for (const method of methods) {
      const h = createPageHarness('Activity');
      const operation = h.page[method]();
      h.account.currentAccountId.value = 'b'; h.account.currentAccountId.value = 'a';
      h.pending.shift()({ ok: false, error: '旧号失败' }); await operation;
      assert.equal(h.toasts.length, 0, method); h.stop();
    }
  });
  test('Activity 相同页刷新不 abort/refetch，切回进行中页撤销 dirty', async () => {
    const h = createPageHarness('Activity'); h.page.activeSection.value = 'milk-tea'; void h.page.queueRefresh(); await drainFrontend();
    const signal = h.calls[0].args[3];
    for (let i = 0; i < 100; i++) h.page.queueRefresh();
    assert.equal(h.calls.length, 1); assert.equal(signal.aborted, false);
    h.page.milkTeaPage.value = 'upgrade'; await drainFrontend();
    h.page.milkTeaPage.value = 'shop'; await drainFrontend();
    h.pending.shift()({ ok: true }); await drainFrontend(); await drainFrontend();
    assert.equal(h.calls.length, 1); h.stop();
  });
  test('Activity 已发 POST 不取消，卸载后不再拉任何相关奶茶页', async () => {
    const h = createPageHarness('Activity');
    const operation = h.page.onMilkTeaOperate('upgrade');
    assert.equal(h.calls[0].method, 'operateMilkTeaActivity');
    assert.equal(h.calls[0].args.length, 3);
    h.stop(); h.pending.shift()({ ok: true }); await operation;
    assert.equal(h.calls.length, 1);
    assert.equal(h.toasts.length, 0);
  });
});

test('Settings settings await 后卸载不再发 seed，seed signal 贯通并独立取消', async () => {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json')); const vue = webRequire('vue');
  for (const stage of ['settings', 'seeds']) {
    const hooks = []; const calls = []; const pending = [];
    const h = loadFrontendModule('composables/settings/useStrategySettings.ts', {
      vue: { ...vue, onScopeDispose: fn => hooks.push(fn) }, pinia: { storeToRefs: value => value },
      '@/api': { __esModule: true, ...createApiHarness(), default: {} },
      '@/stores/farm': { useFarmStore: () => ({ seeds: vue.ref([]), fetchSeeds: (id, signal) => new Promise(resolve => { calls.push({ id, signal }); pending.push(resolve); }) }) },
      '@/stores/setting': { useSettingStore: () => ({ settings: vue.ref(null), loading: vue.ref(false), fetchSettings: () => new Promise(resolve => pending.push(resolve)) }) },
    }, { document: { hidden: false }, window: { setInterval: () => 1, clearInterval() {} } });
    const scope = vue.effectScope();
    const strategy = scope.run(() => h.useStrategySettings({ currentAccountId: vue.ref('a'), activeTab: vue.ref('strategy'), getAutomationSettings: () => ({ automation: {} }), showAlert() {} }));
    const loading = strategy.loadStrategyData();
    if (stage === 'seeds') { pending.shift()(); await drainFrontend(); assert.equal(calls.length, 1); }
    hooks.forEach(fn => fn()); scope.stop(); pending.shift()(); assert.equal(await loading, false); await drainFrontend();
    assert.equal(calls.length, stage === 'settings' ? 0 : 1);
    if (calls.length) assert.equal(calls[0].signal.aborted, true);
  }
});

test('Settings 策略不显示不轮询，显示才读，scope dispose 阻止回填', async () => {
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const vue = webRequire('vue');
  const activeTab = vue.ref('account');
  const accountId = vue.ref('a');
  const settings = vue.ref({ plantingStrategy: 'bag_priority', intervals: {}, friendQuietHours: {} });
  const pending = [];
  let timer;
  const hooks = [];
  const h = loadFrontendModule('composables/settings/useStrategySettings.ts', {
    vue: { ...vue, onScopeDispose: fn => hooks.push(fn) },
    pinia: { storeToRefs: value => value },
    '@/api': { __esModule: true, ...createApiHarness(), default: {}, safeGet: (url, config) => new Promise(resolve => pending.push({ url, config, resolve })) },
    '@/stores/farm': { useFarmStore: () => ({ seeds: vue.ref([]), fetchSeeds: async () => {} }) },
    '@/stores/setting': { useSettingStore: () => ({ settings, loading: vue.ref(false) }) },
  }, { document: { hidden: false }, window: { setInterval: fn => { timer = fn; return 1; }, clearInterval() {} } });
  const scope = vue.effectScope();
  const strategy = scope.run(() => h.useStrategySettings({ currentAccountId: accountId, activeTab, getAutomationSettings: () => ({ automation: {} }), showAlert() {} }));
  strategy.syncLocalStrategySettings(); await drainFrontend(); timer();
  assert.equal(pending.length, 0);
  activeTab.value = 'strategy'; await drainFrontend();
  assert.equal(pending.length, 1);
  timer(); assert.equal(pending.length, 1);
  hooks.forEach(fn => fn()); scope.stop();
  assert.equal(pending[0].config.signal.aborted, true);
  pending.shift().resolve({ data: { ok: true, data: [{ seedId: 1 }] } }); await drainFrontend();
  assert.equal(strategy.bagSeeds.value.length, 0);
});

test.describe('商店与活动在途/写后快照纯模拟回归', () => {
  test('Activity 全部写操作跨号迟成功/迟失败/finally 不回填、不清除新 loading、不取消 POST', async (t) => {
    const cases = [
      ['donateRedFlowerLove', 'redFlowerLoveLoading'], ['donateRedFlowerFund', 'redFlowerFundLoading'],
      ['claimRedFlowerShare', 'redFlowerShareLoading'], ['claimRedFlowerTiers', 'redFlowerTiersLoading'],
      ['operateWishSignActivity', 'wishSignOperateLoading', 'draw'], ['operateShareRewardActivity', 'shareRewardOperateLoading', 'daily'],
      ['operateMilkTeaActivity', 'milkTeaOperateLoading', 'upgrade'], ['useRainPoemPrankOnFriend', 'rainPoemPrankLoading', 1, 2],
      ['unlockRainPoemResearch', 'rainPoemResearchLoading', 1], ['buildQixiBridge', 'qixiBuildLoading'],
      ['useQixiDew', 'qixiDewLoading'], ['sendQixiSachet', 'qixiGiftLoading', 1, 1],
      ['claimStarRecords', 'starRecordClaimLoading'], ['drawHelu', 'drawLoading'], ['exchangeHelu', 'exchangeLoading', 1, 1],
      ['exchangeStarSand', 'exchangeLoading', 1, 1], ['claimHeluPassport', 'passportClaimLoading'],
      ['claimHeluSolar', 'solarClaimLoading', 1], ['claimQingmeiSeeds', 'qingmeiClaimLoading'], ['brewAndSellQingmeiWine', 'qingmeiSellLoading'],
    ];
    for (const [method, loading, ...args] of cases) {
      const h = createReadStoreHarness('activity'); t.after(h.stop);
      const old = h.store[method]('a', ...args); const request = h.pending.shift();
      assert.equal(request.config.signal, undefined, method);
      h.account.currentAccountId = 'b';
      const fresh = h.store[method]('b', ...args); const next = h.pending.shift();
      request.resolve({ data: { ok: true, activity: { old: true }, data: { ok: true } } });
      assert.equal((await old).canceled, true, method);
      assert.equal(h.store[loading], true, method);
      assert.equal(h.pending.length, 0, method);
      next.reject(new Error('新号真实失败'));
      const result = await fresh;
      assert.equal(result.ok, false, method); assert.match(result.error, /新号真实失败/);
      assert.equal(h.store[loading], false, method);
      assert.equal(h.store.heluActivity, null, method); assert.equal(h.store.qixiActivity, null, method);
    }
  });
  test('Activity 同号 A-B-A 操作迟拒绝静默，旧只读被写失效，未知 rain-poem 不合并', async (t) => {
    const h = createReadStoreHarness('activity'); t.after(h.stop);
    const old = h.store.buildQixiBridge('a'); const request = h.pending.shift();
    h.account.currentAccountId = 'b'; h.account.currentAccountId = 'a';
    request.reject(new Error('旧号失败')); assert.equal((await old).canceled, true);
    const reads = [h.store.fetchRainPoemActivity('a'), h.store.fetchRainPoemActivity('a')];
    assert.equal(h.pending.length, 2); h.pending.splice(0).forEach(r => r.resolve({ data: { ok: true, activity: {} } })); await Promise.all(reads);
  });
  test('Farm 同号土地单读，写后新读不复用旧读，失败不算成功', async (t) => {
    const h = createReadStoreHarness('farm'); t.after(h.stop);
    const a = h.store.fetchLands('a'); const b = h.store.fetchLands('a');
    assert.equal(h.pending.length, 1); const old = h.pending.shift();
    const write = h.store.operate('a', 'harvest');
    h.pending.shift().resolve({ data: { ok: true, success: true } }); await drainFrontend();
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve({ data: { ok: true, data: { lands: [{ id: 2 }], summary: {}, weather: { rainstorm: true } } } });
    await write;
    old.resolve({ data: { ok: true, data: { lands: [{ id: 1 }] } } }); await Promise.all([a, b]);
    assert.equal(h.store.lands[0].id, 2); assert.equal(h.store.weather.rainstorm, true);
    const failure = h.store.fetchLands('a'); const failed = assert.rejects(failure);
    h.pending.shift().resolve({ data: { ok: false, error: '失败' } }); await failed;
    const scope = new AbortController();
    const post = h.store.removeAllPlants('a', scope.signal); const request = h.pending.shift();
    assert.equal(request.config.signal, undefined); scope.abort(); request.resolve({ data: { ok: true } }); await post;
    assert.equal(h.pending.length, 0);
  });
  test('shop 两轮 refreshAll 仅五次 HTTP，写后不复用旧 flight，A-B-A 不回填', async (t) => {
    const h = createReadStoreHarness('shop'); t.after(h.stop);
    const a = h.store.refreshAll('a');
    const b = h.store.refreshAll('a');
    assert.equal(h.pending.length, 5);
    const old = h.pending.splice(0);
    const buy = h.store.buyGoods('a', 1, 1, 1);
    h.pending.shift().resolve({ data: { ok: true } }); await buy;
    const fresh = h.store.fetchPets('a');
    const next = h.pending.shift();
    next.resolve({ data: { ok: true, data: [{ id: 2 }], userGold: 3 } }); await fresh;
    old.forEach(r => r.resolve({ data: { ok: true, data: [{ id: 1 }] } }));
    await Promise.all([a, b]);
    assert.equal(h.store.pets[0].id, 2);
    const stale = h.store.fetchPets('a'); const staleRequest = h.pending.shift();
    h.account.currentAccountId = 'b'; h.account.currentAccountId = 'a';
    staleRequest.resolve({ data: { ok: true, data: [{ id: 9 }] } }); await stale;
    assert.equal(h.store.pets.length, 0);
  });
  test('activity 当前奶茶页读合并、返回 clone，写前旧读不能覆盖写后结果', async (t) => {
    const h = createReadStoreHarness('activity'); t.after(h.stop);
    const a = h.store.fetchMilkTeaActivity('a', 'shop');
    const b = h.store.fetchMilkTeaActivity('a', 'shop');
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve({ data: { ok: true, data: { page: 'shop', summary: { level: 1 } } } });
    const [first, second] = await Promise.all([a, b]);
    first.data.summary.level = 99;
    assert.equal(second.data.summary.level, 1);
    assert.equal(h.store.milkTeaPages.shop.summary.level, 1);
    const stale = h.store.fetchMilkTeaActivity('a', 'shop');
    const staleDone = assert.rejects(stale);
    const old = h.pending.shift();
    const write = h.store.operateMilkTeaActivity('a', 'upgrade');
    h.pending.shift().resolve({ data: { ok: true, data: { ok: true } } }); await write;
    const fresh = h.store.fetchMilkTeaActivity('a', 'shop');
    h.pending.shift().resolve({ data: { ok: true, data: { page: 'shop', summary: { level: 2 } } } }); await fresh;
    old.resolve({ data: { ok: true, data: { page: 'shop', summary: { level: 1 } } } }); await staleDone;
    assert.equal(h.store.milkTeaPages.shop.summary.level, 2);
  });
});

test.describe('API 只读自定义 adapter 回归（无真实请求）', () => {
  test('callable api 同步冻结默认号，显式空值/大小写不覆盖；迟 401 不注销新号或新会话', async () => {
    const h = createApiHarness();
    const a = h.default({ url: '/api/dog/info' });
    const aRejected = assert.rejects(a);
    const explicit = h.default({ url: '/api/dog/info', headers: { 'X-ACCOUNT-ID': '' } });
    h.storage.current_account_id.value = 'b';
    const b = h.default.request('/api/dog/info');
    assert.deepEqual(h.pending.map(r => r.config.headers.get('x-account-id')), ['a', '', 'b']);
    const old = h.pending.shift();
    old.reject(Object.assign(new Error('旧号 401'), { config: old.config, response: { status: 401 } }));
    await aRejected;
    assert.equal(h.storage.admin_token.value, 'session-1');
    const stale = h.default.get('/api/dog/info'); const staleRejected = assert.rejects(stale);
    h.storage.admin_token.value = 'session-2';
    h.pending.at(-1).reject(Object.assign(new Error('旧会话 401'), { config: h.pending.at(-1).config, response: { status: 401 } }));
    await staleRejected;
    assert.equal(h.storage.admin_token.value, 'session-2');
    h.pending.slice(0, 2).forEach(r => r.resolve({ ok: true })); await Promise.all([explicit, b]);
    assert.equal(h.toasts.length, 0);
  });
  test('协调器 64 live/128 observers 有界，取消后旧 job 未结束不得再繁殖同 key', async () => {
    const h = createApiHarness(); const coordinator = h.createReadCoordinator();
    const pending = []; const promises = [];
    const job = signal => new Promise((resolve, reject) => pending.push({ signal, resolve, reject }));
    for (let i = 0; i < 64; i++) promises.push(coordinator.run(`key:${i}`, job));
    await assert.rejects(coordinator.run('overflow', job), { code: 'ERR_CANCELED' });
    assert.equal(pending.length, 64); assert.equal(coordinator.size, 64);
    for (let i = 0; i < 64; i++) promises.push(coordinator.run('key:0', job));
    await assert.rejects(coordinator.run('key:0', job), { code: 'ERR_CANCELED' });
    assert.equal(coordinator.waiters, 128);
    pending.forEach(r => r.resolve({ ok: true })); await Promise.all(promises);
    assert.equal(coordinator.size, 0); assert.equal(coordinator.waiters, 0);
    const controller = new AbortController();
    const old = coordinator.run('old', job, controller.signal); const canceled = assert.rejects(old);
    controller.abort(); await canceled;
    for (let i = 0; i < 100; i++) await assert.rejects(coordinator.run('old', job), { code: 'ERR_CANCELED' });
    assert.equal(pending.length, 65); assert.equal(coordinator.size, 1);
    pending.at(-1).reject(new Error('adapter 迟拒绝')); await drainFrontend();
    assert.equal(coordinator.size, 0); assert.equal(coordinator.waiters, 0);
    const fresh = coordinator.run('old', job); pending.at(-1).resolve(1); assert.equal(await fresh, 1);
  });
  test('局部 invalidate 只释放自身订阅，其他全局订阅存活；写后同路径用新 flight', async () => {
    const h = createApiHarness(); const local = h.createReadCoordinator();
    const a = local.run('overview', signal => h.safeGet('/api/dog/info', { signal }));
    const canceled = assert.rejects(a, { code: 'ERR_CANCELED' });
    const b = h.safeGet('/api/dog/info'); assert.equal(h.pending.length, 1);
    local.invalidate(); await canceled;
    assert.equal(h.pending[0].config.signal.aborted, false);
    h.invalidateSafeReads();
    const fresh = h.safeGet('/api/dog/info'); assert.equal(h.pending.length, 2);
    h.pending[1].resolve({ ok: true, data: 2 }); assert.equal((await fresh).data.data, 2);
    h.pending[0].resolve({ ok: true, data: 1 }); assert.equal((await b).data.data, 1);
  });
  test('serialized query 保留大小写/数组顺序/uid，rain-poem 与 friends 不共享', async () => {
    const h = createApiHarness();
    const jobs = [
      h.safeGet('/api/activity/milk-tea/shop', { params: { uid: 'u1', ids: [1, 2] } }),
      h.safeGet('/api/activity/milk-tea/shop', { params: { ids: [1, 2], uid: 'u1' } }),
      h.safeGet('/api/activity/milk-tea/shop', { params: { uid: 'u2', ids: [1, 2] } }),
      h.safeGet('/api/activity/milk-tea/shop', { params: { UID: 'u1', ids: [1, 2] } }),
      h.safeGet('/api/activity/milk-tea/shop', { params: { uid: 'u1', ids: [2, 1] } }),
      h.safeGet('/api/activity/rain-poem/friends'), h.safeGet('/api/activity/rain-poem/friends'),
      h.safeGet('/api/activity/rain-poem'), h.safeGet('/api/activity/rain-poem'),
    ];
    assert.equal(h.pending.length, 8);
    const uris = h.pending.slice(0, 4).map(r => h.default.getUri(r.config));
    assert.equal(new Set(uris).size, 4);
    h.pending.forEach(r => r.resolve({ ok: true })); await Promise.all(jobs);
  });
  test('callable api 在异步 observer 前冻结，旧 401 的 A-B-A 也不误注销', async () => {
    const h = createApiHarness();
    h.default.interceptors.request.use(config => Promise.resolve(config));
    const request = h.default({ url: '/api/dog/info', headers: new h.axios.AxiosHeaders({ 'X-Account-ID': 'a' }) });
    const rejected = assert.rejects(request);
    h.storage.current_account_id.value = 'b'; h.storage.current_account_id.value = 'a';
    await drainFrontend(); const old = h.pending.shift();
    assert.equal(old.config.headers.get('x-account-id'), 'a');
    old.reject(Object.assign(new Error('旧周期 401'), { config: old.config, response: { status: 401 } }));
    await rejected; assert.equal(h.storage.admin_token.value, 'session-1'); assert.equal(h.toasts.length, 0);
  });
  test('显式大小写/AxiosHeaders 与发起时默认账号在 A-B-A 中冻结', async () => {
    const h = createApiHarness();
    const explicit = h.default.get('/api/dog/info', { headers: new h.axios.AxiosHeaders({ 'X-Account-ID': 'a' }) });
    const implicit = h.default.get('/api/dog/info');
    h.storage.current_account_id.value = 'b';
    const b = h.default.get('/api/dog/info');
    h.storage.current_account_id.value = 'a';
    await drainFrontend();
    assert.deepEqual(h.pending.map(r => r.config.headers.get('x-account-id')), ['a', 'a', 'b']);
    h.pending.forEach(r => r.resolve({ ok: true }));
    await Promise.all([explicit, implicit, b]);
  });
  test('同账号规范参数共享一读和一条 observer，返回值独立，无 TTL', async () => {
    const h = createApiHarness();
    const a = h.safeGet('/api/dog/info', { params: { b: 2, a: 1 } });
    const b = h.safeGet('/api/dog/info', { params: { a: 1, b: 2 } });
    await drainFrontend();
    assert.equal(h.pending.length, 1);
    assert.equal(h.observations, 1);
    h.pending.shift().resolve({ ok: true, data: { count: 1 } });
    const [first, second] = await Promise.all([a, b]);
    first.data.data.count = 9;
    assert.equal(second.data.data.count, 1);
    const fresh = h.safeGet('/api/dog/info');
    await drainFrontend();
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve({ ok: true });
    await fresh;
  });
  test('错账号、会话和非白名单不共享，POST 不合并也不重试', async () => {
    const h = createApiHarness();
    const jobs = [h.safeGet('/api/dog/info')];
    h.storage.current_account_id.value = 'b';
    jobs.push(h.safeGet('/api/dog/info'));
    h.storage.admin_token.value = 'session-2';
    jobs.push(h.safeGet('/api/dog/info'));
    jobs.push(h.safeGet('/api/unknown'), h.safeGet('/api/unknown'));
    jobs.push(h.default.post('/api/dog/feed', {}), h.default.post('/api/dog/feed', {}));
    await drainFrontend();
    assert.equal(h.pending.length, 7);
    h.pending.forEach(r => r.resolve({ ok: true }));
    await Promise.allSettled(jobs);
    assert.deepEqual(h.pending.map(r => r.config.headers.get('x-account-id')), ['a', 'b', 'b', 'b', 'b', 'b', 'b']);
  });
  test('取消一个订阅不取消其他人，拒绝清理后可重新读取，取消不 toast', async () => {
    const h = createApiHarness();
    const controller = new AbortController();
    const a = h.safeGet('/api/dog/info', { signal: controller.signal });
    const rejected = assert.rejects(a, { code: 'ERR_CANCELED' });
    const b = h.safeGet('/api/dog/info');
    await drainFrontend();
    controller.abort();
    await rejected;
    assert.equal(h.pending[0].config.signal.aborted, false);
    h.pending.shift().resolve({ ok: true });
    assert.equal((await b).data.ok, true);
    assert.equal(h.toasts.length, 0);
    const failure = h.safeGet('/api/dog/info');
    const failed = assert.rejects(failure);
    await drainFrontend();
    h.pending.shift().reject(Object.assign(new Error('模拟失败'), { config: { skipErrorToast: true } }));
    await failed;
    const fresh = h.safeGet('/api/dog/info');
    await drainFrontend();
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve({ ok: true });
    await fresh;
  });
});

test.describe('Pet store 前端纯模拟账户竞态回归', () => {
  test('跨号及 A-B-A 迟响应与迟报错均不能回填', async (t) => {
    const h = createPetStoreHarness();
    t.after(h.stop);
    const a = h.store.fetchOverview('a');
    const oldA = h.pending.shift();
    h.account.currentAccountId = 'b';
    assert.equal(h.store.overview.dogs.length, 0);
    const b = h.store.fetchOverview('b');
    h.pending.shift().resolve(petOverviewResponse(90021));
    await b;
    oldA.resolve(petOverviewResponse(90031));
    assert.equal(await a, false);
    assert.equal(h.store.overview.dogs[0].id, 90021);
    const old = h.store.fetchOverview('b');
    const oldB = h.pending.shift();
    h.account.currentAccountId = 'a';
    h.account.currentAccountId = 'b';
    const fresh = h.store.fetchOverview('b');
    h.pending.shift().resolve(petOverviewResponse(90011));
    await fresh;
    oldB.reject(new Error('旧账号迟报错'));
    assert.equal(await old, false);
    assert.equal(h.store.status, 'ready');
    assert.equal(h.store.overview.dogs[0].id, 90011);
  });

  test('同号同 epoch 两个总览订阅只发一个读，不保留已完成缓存', async (t) => {
    const h = createPetStoreHarness();
    t.after(h.stop);
    const a = h.store.fetchOverview('a');
    const b = h.store.fetchOverview('a');
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve(petOverviewResponse(90021));
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.equal(h.store.overview.dogs[0].id, 90021);
    assert.equal(h.store.loading, false);
    const fresh = h.store.fetchOverview('a');
    assert.equal(h.pending.length, 1);
    h.pending.shift().resolve(petOverviewResponse(90031));
    await fresh;
  });

  test('空成功、未知及错误响应清空事实展示，部分缺席 null 可显示警告', async (t) => {
    const h = createPetStoreHarness();
    t.after(h.stop);
    const partial = petOverviewResponse(90031);
    partial.data.data.dogs.push({ id: 90021, owned: null, activated: null, deployed: false });
    partial.data.data.warnings = ['部分状态未知'];
    const ready = h.store.fetchOverview('a');
    h.pending.shift().resolve(partial);
    await ready;
    assert.equal(h.store.status, 'ready');
    assert.equal(h.store.overview.dogs[1].owned, null);
    assert.equal(h.store.overview.warnings.length, 1);
    for (const response of [
      { data: { ok: true, data: { dogs: [], foods: [] } } },
      { data: { ok: true, data: { ...partial.data.data, dogs: [{ id: 90031, owned: null, activated: null, deployed: false }] } } },
      { data: { ok: false, error: '模拟失败' } },
    ]) {
      const request = h.store.fetchOverview('a');
      const rejected = assert.rejects(request);
      h.pending.shift().resolve(response);
      await rejected;
      assert.equal(h.store.status, 'error');
      assert.equal(h.store.overview.dogs.length, 0);
      assert.ok(h.store.error);
    }
  });

  test('logs、资本设置与保存的迟响应及迟错误不能跨号回填', async (t) => {
    const h = createPetStoreHarness();
    t.after(h.stop);
    const logs = h.store.fetchLogs('a');
    const oldLogs = h.pending.shift();
    const capital = h.store.fetchCapitalMode('a');
    const oldCapital = h.pending.shift();
    const save = h.store.saveCapitalMode('a', { enabled: true, dogId: 90031, leadSeconds: 10 });
    const oldSave = h.pending.shift();
    h.account.currentAccountId = 'b';
    oldLogs.resolve({ data: { ok: true, data: { logs: [{ id: 1 }] } } });
    oldCapital.reject(new Error('旧号设置迟报错'));
    oldSave.resolve({ data: { ok: true, data: { capitalMode: { enabled: true, dogId: 90031, leadSeconds: 10 } } } });
    assert.deepEqual(await Promise.all([logs, capital, save]), [false, false, false]);
    assert.equal(h.store.logs.length, 0);
    assert.equal(h.store.capitalMode.enabled, false);
    assert.equal(h.store.capitalReady, false);
  });

  test('宠物取消单个订阅保留另一个，写前旧读不回填且卸载不发下一读', async (t) => {
    const h = createPetStoreHarness(); t.after(h.stop);
    const controller = new AbortController();
    const a = h.store.fetchOverview('a', controller.signal);
    const canceled = assert.rejects(a, { code: 'ERR_CANCELED' });
    const b = h.store.fetchOverview('a');
    assert.equal(h.pending.length, 1);
    controller.abort(); await canceled;
    assert.equal(h.pending[0].config.signal.aborted, false);
    h.pending.shift().resolve(petOverviewResponse(90021)); await b;
    const stale = h.store.fetchOverview('a'); const old = h.pending.shift();
    const scope = new AbortController();
    const write = h.store.deploy('a', 90021, scope.signal); const post = h.pending.shift();
    assert.equal(post.config.signal, undefined);
    scope.abort(); post.resolve({ data: { ok: true } });
    await write;
    assert.equal(h.pending.length, 0);
    old.resolve(petOverviewResponse(90031));
    assert.equal(await stale, false);
    assert.equal(h.store.overview.dogs[0].id, 90021);
  });
  test('Pet 写后刷新在退出 scope 时取消读但不取消已发写，silent cancel 不变 error', async (t) => {
    const h = createPetStoreHarness(); t.after(h.stop);
    const scope = new AbortController();
    const write = h.store.deploy('a', 90021, scope.signal);
    const post = h.pending.shift(); assert.equal(post.config.signal, undefined);
    post.resolve({ data: { ok: true } }); await drainFrontend();
    const read = h.pending.shift(); scope.abort();
    assert.equal(await write, false); assert.equal(read.config.signal.aborted, true);
    read.resolve(petOverviewResponse(90031)); await drainFrontend();
    assert.notEqual(h.store.status, 'error'); assert.equal(h.store.overview.dogs.length, 0);
    const fresh = h.store.fetchOverview('a'); h.pending.shift().resolve(petOverviewResponse(90021)); await fresh;
  });
  test('旧号操作不刷新旧号，旧 finally 不清除新号 mutating', async (t) => {
    const h = createPetStoreHarness();
    t.after(h.stop);
    const old = h.store.deploy('a', 90031);
    const oldPost = h.pending.shift();
    assert.equal(oldPost.config.headers['x-account-id'], 'a');
    h.account.currentAccountId = 'b';
    const fresh = h.store.deploy('b', 90021);
    const freshPost = h.pending.shift();
    oldPost.resolve({ data: { ok: true } });
    assert.equal(await old, false);
    assert.equal(h.pending.length, 0);
    assert.equal(h.store.mutating, true);
    freshPost.resolve({ data: { ok: true } });
    // Pinia 的 action 包装也会排入微任务，先让本轮微任务全部完成。
    await new Promise(resolve => setImmediate(resolve));
    const refresh = h.pending.shift();
    assert.equal(refresh.config.headers['x-account-id'], 'b');
    refresh.resolve(petOverviewResponse(90021));
    assert.equal(await fresh, true);
    assert.equal(h.store.mutating, false);
    assert.equal(h.store.overview.dogs[0].id, 90021);
  });
});
