const assert = require('node:assert/strict');
const test = require('node:test');

const { AUTO_BUY_CHECK_INTERVAL_MS } = require('../src/services/mystery-shop');

test('mystery shop auto-buy polls often enough to catch offers appearing after login', () => {
  assert.equal(AUTO_BUY_CHECK_INTERVAL_MS, 10 * 60 * 1000);
  assert.ok(AUTO_BUY_CHECK_INTERVAL_MS < 3 * 60 * 60 * 1000);
});

// 宠物业务回归仅用 VM 加载实际服务模块，任何未声明依赖均拒绝加载。
const petFs = require('node:fs');
const petPath = require('node:path');
const petVm = require('node:vm');
const petProtobuf = require('protobufjs');
const petRoot = new petProtobuf.Root();
petRoot.loadSync(['dogpb.proto', 'mallpb.proto'].map(name => petPath.join(__dirname, '../src/proto', name)), { keepCase: true });
const petTypes = {};
for (const [prefix, names] of [
  ['gamepb.dogpb.', ['GetDogInfoRequest', 'GetDogInfoReply', 'ActivateDogRequest', 'ActivateDogReply', 'DeployDogRequest', 'DeployDogReply', 'WithdrawDogRequest', 'WithdrawDogReply', 'AddFoodRequest', 'AddFoodReply', 'ClaimSkillGiftsRequest', 'ClaimSkillGiftsReply']],
  ['gamepb.mallpb.', ['GetMallListBySlotTypeRequest', 'GetMallListBySlotTypeResponse', 'MallGoods', 'PurchaseRequest', 'PurchaseResponse']],
  ['corepb.', ['Item']],
]) for (const name of names) petTypes[name === 'Item' ? 'CoreItem' : name] = petRoot.lookupType(prefix + name);

function petDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function petFlush() { for (let i = 0; i < 40; i += 1) await Promise.resolve(); }

function petHarness(options = {}) {
  let now = 1000000, timerId = 0;
  const timers = new Map(), scheduled = new Map(), cache = new Map(), calls = [];
  const stateFiles = options.stateFiles || new Map();
  const actor = options.accountId || 'fixture';
  const h = {
    calls, scheduled, types: petTypes, logs: [], stateFiles,
    config: { enabled: true, dogId: 90001, leadSeconds: 60 },
    automation: { pet_food_auto_feed: true },
    user: { ticket: 0, coupon: 0, goldBean: 0 },
    bag: [{ id: 1002, count: 100 }, { id: 1004, count: 100 }, { id: 1005, count: 100 }],
    info: { dog_list: [{ id: 90001, owned: false, activated: true }, { id: 90002, owned: true, activated: true }], current_deployed_dog_id: 0, food_last_sec: 0, max_food_last_sec: 2592000, pending_gift_count: 1 },
    goods: { goods_id: 1006, price: { id: 1002, count: 10 }, reward_items: [{ id: 90004, count: 1 }], is_available: true },
  };
  const rpc = async (service, method, payload) => {
    const requestType = petTypes[method + 'Request'];
    const args = requestType ? requestType.decode(payload) : {};
    calls.push({ service, method, args });
    if (h.rpc) {
      const result = await h.rpc(method, args);
      if (result !== undefined) return result;
    }
    if (method === 'GetDogInfo') return { body: h.info };
    if (method === 'GetMallListBySlotType') return { body: { goods_list: [h.goods] } };
    if (method === 'Purchase') {
      h.bag = [{ id: 90004, count: 1 }];
      return { body: { goods_id: 1006, success: true, reward_items: h.bag } };
    }
    if (method === 'DeployDog') { h.info.current_deployed_dog_id = Number(args.dog_id); return { body: { dog_id: Number(args.dog_id) } }; }
    if (method === 'WithdrawDog') { const id = h.info.current_deployed_dog_id; h.info.current_deployed_dog_id = 0; return { body: { dog_id: id } }; }
    if (method === 'ActivateDog') { const dog = h.info.dog_list.find(item => item.id === Number(args.dog_id)); dog.activated = true; return { body: { dog } }; }
    if (method === 'AddFood') { h.info.food_last_sec += 86400; return { body: { food_last_sec: h.info.food_last_sec } }; }
    if (method === 'ClaimSkillGifts') { h.info.pending_gift_count = 0; return { body: { rewards: [{ id: 101351, count: 1 }], claimed_gift_count: 1, pending_gift_count: 0 } }; }
    throw new Error(`禁止未知 RPC ${method}`);
  };
  const mocks = {
    'node:fs': { existsSync: file => stateFiles.has(file), readFileSync: file => stateFiles.get(file) },
    'node:process': { env: { FARM_ACCOUNT_ID: actor } },
    'node:crypto': require('node:crypto'),
    '../config/runtime-paths': { getDataFile: file => file },
    './json-db': { writeJsonFileAtomic: (file, value) => stateFiles.set(file, JSON.stringify(value)) },
    '../config/gameConfig': { getItemById: id => ({ name: String(id) }), getItemImageById: () => '' },
    '../config/config': { PlantPhase: { MATURE: 3 } },
    '../utils/network': { sendMsgAsync: rpc, getUserState: () => h.user },
    '../utils/proto': { types: petTypes },
    '../utils/utils': { toNum: value => typeof value === 'boolean' ? 0 : Number(value?.toNumber ? value.toNumber() : value) || 0, toTimeSec: Number, getServerTimeSec: () => now / 1000, log: (...args) => h.logs.push(args), logWarn: (...args) => h.logs.push(args) },
    '../models/store': { getCapitalMode: () => h.config, getAutomation: () => h.automation },
    './warehouse': {
      getBag: async () => { calls.push({ method: 'Bag' }); return h.getBag ? h.getBag() : { items: h.bag }; },
      getBagItems: reply => { assert.equal(typeof reply?.then, 'undefined', '背包必须 await 后读取'); return reply.items || []; },
    },
    './logger': { createModuleLogger: () => ({ info() {}, warn() {} }) },
    './scheduler': { createScheduler: () => ({ clear: name => scheduled.delete(name), setTimeoutTask: (name, delay, fn) => scheduled.set(name, fn) }) },
  };
  class PetDate extends Date { static now() { return now; } }
  const context = petVm.createContext({
    Buffer, Uint8Array, Date: PetDate, console,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} };
    cache.set(name, module);
    const source = petFs.readFileSync(petPath.join(__dirname, '../src/services', name + '.js'), 'utf8');
    const factory = petVm.runInContext(`(function(require,module,exports){${source}\n})`, context);
    factory(id => {
      if (id === 'node:async_hooks') return require(id);
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (['./pets', './capital-mode', './pet-food-automation', './dog-skill-gifts'].includes(id)) return load(id.slice(2));
      throw new Error(`禁止真实网络及未声明依赖 ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  h.pets = load('pets'); h.capital = load('capital-mode'); h.food = load('pet-food-automation'); h.gifts = load('dog-skill-gifts');
  h.tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } };
  h.writes = () => calls.filter(call => ['DeployDog', 'WithdrawDog', 'ActivateDog', 'AddFood', 'Purchase', 'ClaimSkillGifts'].includes(call.method));
  h.prepare = () => h.capital.prepareForFarmOperation({ lands: [], analysis: { harvestable: [1] }, opType: 'harvest' });
  return h;
}

// 神秘商人状态契约只读测试：真实proto编码+实际服务/路由，未声明依赖全部拒绝。
function mysteryHarness({ response, error, transform = source => source } = {}) {
  const filename = petPath.join(__dirname, '../src/services/mystery-shop.js');
  const root = new petProtobuf.Root().loadSync(petPath.join(__dirname, '../src/proto/mysteryshoppb.proto'), { keepCase: true });
  const names = { GetActiveMysteryNPCRequest: 'GetActiveNPCRequest', GetActiveMysteryNPCReply: 'GetActiveNPCReply' };
  const types = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, root.lookupType(`gamepb.mysteryshoppb.${name}`)]));
  const now = 1000000;
  const calls = [];
  const dependencies = {
    '../config/gameConfig': { getItemById: id => ({ name: `物品${id}` }), getItemImageById: id => `/fixture/${id}.png` },
    '../utils/proto': { types }, '../utils/utils': { toNum: value => Number(value) || 0, log() {}, logWarn() {} },
    '../models/store': { getAutomation: () => ({}) }, './friend-alert': {}, './stats': {},
    '../utils/network': { sendMsgAsync: async (service, method, payload) => {
      calls.push({ service, method, payload });
      assert.equal(method, 'GetActiveNPC', '状态查询不得触发购买/请离');
      if (error) throw error;
      return { body: response === undefined ? types.GetActiveMysteryNPCReply.encode({ active: false }).finish() : response };
    } },
  };
  const module = { exports: {} };
  class MysteryDate extends Date { static now() { return now; } }
  petVm.runInNewContext(transform(petFs.readFileSync(filename, 'utf8')), { module, exports: module.exports, Buffer, Uint8Array, Date: MysteryDate,
    require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error(`禁止真实依赖 ${name}`); return dependencies[name]; },
  }, { filename });
  return { api: module.exports, calls, types };
}
function mysteryRoute(provider) {
  const { registerAdminMysteryShopRoutes } = require('../src/controllers/admin-mystery-shop-routes');
  const { createAdminRouteHelpers } = require('../src/controllers/admin-route-helpers');
  const routes = {};
  const helpers = createAdminRouteHelpers({});
  registerAdminMysteryShopRoutes({ app: { get: (path, fn) => { routes[path] = fn; }, post() {} }, provider,
    getAccountIdFromRequest: () => 'fixture', canAccessAccount: () => true, sendProviderError: helpers.sendProviderError });
  return async () => {
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name] = value; }, json(value) { this.body = value; return this; } };
    await routes['/api/shop/mystery']({}, res);
    return res;
  };
}

test('神秘商人：合法proto默认false回包以200明确不在期，不触发购买', async () => {
  const h = mysteryHarness();
  const call = mysteryRoute({ getStatus: () => ({ connection: { connected: true } }), getMysteryShop: h.api.getActiveMysteryShop });
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.active, false);
  assert.equal(res.body.data.skipped, true);
  assert.equal(res.body.data.reason, 'inactive');
  assert.match(res.body.data.statusLabel, /当前不在期/);
  assert.deepEqual(h.calls.map(call => call.method), ['GetActiveNPC']);
  // 旧归一化没有原因和状态文案；用内存变异验证新断言确实能检测缺陷。
  const old = mysteryHarness({ transform: source => source.replace('skipped: !!reason,', '').replace('reason: reason || undefined,', '') });
  const oldData = await old.api.getActiveMysteryShop();
  assert.throws(() => assert.equal(oldData.reason, 'inactive'), { name: 'AssertionError' });
});

for (const [reason, reply] of [
  ['purchased', { active: true, npc: { purchased: true }, start_time: 1, end_time: 2000 }],
  ['expired', { active: true, npc: { purchased: false }, start_time: 1, end_time: 999 }],
  ['upcoming', { active: true, npc: { purchased: false }, start_time: 1001, end_time: 2000 }],
]) test(`神秘商人：${reason}返回明确状态，不把无事可做当HTTP错误`, async () => {
  const h = mysteryHarness();
  const data = h.api.normalizeNPC(reply);
  assert.equal(data.reason, reason);
  assert.equal(data.active, false);
  assert.equal(data.skipped, true);
  assert.ok(data.statusLabel);
});

test('神秘商人：在期商品字段不丢，bytes/message/plain只解码必要次数', async () => {
  const h = mysteryHarness();
  const type = h.types.GetActiveMysteryNPCReply;
  const wire = type.encode({ active: true, start_time: 1, end_time: 2000,
    npc: { npc_id: 7, item_id: 20525, item_count: 20, currency_id: 1001, price: 100 } }).finish();
  for (const response of [wire, type.decode(wire), { active: true, start_time: 1, end_time: 2000,
    npc: { npc_id: 7, item_id: 20525, item_count: 20, currency_id: 1001, price: 100 } }]) {
    const box = mysteryHarness({ response });
    const data = await box.api.getActiveMysteryShop();
    assert.equal(data.active, true);
    assert.equal(data.skipped, false);
    assert.equal(data.npcId, 7);
    assert.equal(data.currencyId, 1001);
    assert.equal(data.itemCount, 20);
    assert.equal(data.price, 100);
    assert.equal(box.calls.length, 1);
  }
});

test('神秘商人：真实超时/断线/畸形响应保留错误，不伪装成不在期200', async () => {
  for (const failure of [Object.assign(new Error('响应超时'), { errorCode: 'REQUEST_TIMEOUT', stage: 'remote', sent: true }),
    Object.assign(new Error('连接不可用'), { errorCode: 'CONNECTION_UNAVAILABLE', sent: false })]) {
    const h = mysteryHarness({ error: failure });
    await assert.rejects(h.api.getActiveMysteryShop(), error => error === failure);
    const res = await mysteryRoute({ getStatus: () => ({ connection: { connected: true } }), getMysteryShop: h.api.getActiveMysteryShop })();
    assert.equal(res.body.ok, false);
    assert.equal(res.body.errorCode, failure.errorCode);
    assert.equal(res.statusCode, failure.errorCode === 'REQUEST_TIMEOUT' ? 503 : 500);
  }
  for (const response of [null, {}, { active: 'false' }, Buffer.from([0x12, 0xff])]) {
    const h = mysteryHarness({ response });
    await assert.rejects(h.api.getActiveMysteryShop());
    assert.equal(h.calls.length, 1);
  }
});

test('pet VM：狗粮缺商品/不可买/异常币种或价格均记录真实跳过原因，不购买', async () => {
  for (const [change, reason] of [
    [h => { h.goods = null; }, '当前商城未返回狗粮礼包'],
    [h => { h.goods.is_available = false; }, '狗粮礼包当前不可购买'],
    [h => { h.goods.price.id = 1001; }, '狗粮礼包价格币种不在当前允许范围'],
    [h => { h.goods.price.count = 0; }, '狗粮礼包未返回有效价格'],
  ]) {
    const h = petHarness(); change(h);
    const result = await h.food.checkAndFeedPetFood();
    assert.equal(result.skipped, true); assert.equal(h.writes().length, 0);
    assert.ok(h.logs.some(args => args[2]?.reason === reason), reason);
  }
});
test('pet VM：真实狗粮定时入口把 require/异步失败交回调度器，不静默吞错', async () => {
  const source = petFs.readFileSync(petPath.join(__dirname, '../src/core/worker.js'), 'utf8');
  const begin = source.indexOf('function stopPetFoodTimer()'), end = source.indexOf('// 神秘商人', begin);
  assert.ok(begin >= 0 && end > begin);
  for (const kind of ['require', 'async']) {
    const callbacks = new Map();
    const start = petVm.runInNewContext(source.slice(begin, end) + '\nstartPetFoodTimer', {
      isRunning: true, loginReady: true, loginInitializationEpoch: 1, friendSyncPaused: 0,
      getDiagnosticSnapshot: () => ({ connectionEpoch: 2 }), runWithRequestContext: (ctx, callback) => callback(),
      log() {}, getAutomation: () => ({ pet_food_auto_feed: true }),
      require: name => {
        assert.equal(name, '../services/pet-food-automation');
        if (kind === 'require') throw new Error('fixture require failure');
        return { checkAndFeedPetFood: async () => { throw new Error('fixture async failure'); } };
      },
      workerScheduler: {
        clear: name => callbacks.delete(name),
        setTimeoutTask: (name, delay, callback) => callbacks.set(name, callback),
        setIntervalTask: (name, delay, callback, options) => { assert.equal(options.preventOverlap, true); callbacks.set(name, callback); },
      },
    });
    start();
    for (const name of ['pet_food_initial', 'pet_food_interval']) await assert.rejects(callbacks.get(name)(), /fixture/);
  }
});
test('pet VM：真实商品Message未下发可买字段的默认false不阻止购买，显式false仍跳过', async () => {
  const h = petHarness();
  const MallGoods = petRoot.lookupType('gamepb.mallpb.MallGoods');
  h.goods = MallGoods.decode(MallGoods.encode(MallGoods.fromObject({ goods_id: 1006, price: { id: 1002, count: 33 }, reward_items: [{ id: 90004, count: 1 }] })).finish());
  assert.equal(h.goods.is_available, false); assert.equal(Object.hasOwn(h.goods, 'is_available'), false);
  assert.equal((await h.food.checkAndFeedPetFood()).fed, 1);
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase', 'AddFood']);
  const closed = petHarness(); closed.goods = MallGoods.decode(MallGoods.encode(MallGoods.fromObject({ goods_id: 1006, is_available: false, price: { id: 1002, count: 33 } })).finish());
  assert.equal(Object.hasOwn(closed.goods, 'is_available'), true);
  assert.equal((await closed.food.checkAndFeedPetFood()).reason, 'buy_none'); assert.equal(closed.writes().length, 0);
});
test('pet VM：未知购粮记录跨worker重建仍阻断force，另一账号不受影响', async () => {
  const stateFiles = new Map(), h = petHarness({ stateFiles, accountId: 'A' });
  h.rpc = method => method === 'Purchase' ? { body: {} } : undefined;
  await assert.rejects(h.food.checkAndFeedPetFood(), error => error.outcomeUnknown === true);
  const recreated = petHarness({ stateFiles, accountId: 'A' });
  await assert.rejects(recreated.food.checkAndFeedPetFood({ force: true }), error => error.outcomeUnknown === true);
  assert.equal(recreated.calls.length, 0);
  const other = petHarness({ stateFiles, accountId: 'B' });
  assert.equal((await other.food.checkAndFeedPetFood()).fed, 1);
});
test('pet VM：未知喂食保留记录，不能在下次检查或重建后再次消耗', async () => {
  const stateFiles = new Map(), h = petHarness({ stateFiles }); h.bag = [{ id: 90004, count: 2 }];
  h.rpc = method => method === 'AddFood' ? { body: {} } : undefined;
  await assert.rejects(h.food.checkAndFeedPetFood(), error => error.outcomeUnknown === true);
  const recreated = petHarness({ stateFiles }); recreated.bag = [{ id: 90004, count: 1 }];
  await assert.rejects(recreated.food.checkAndFeedPetFood({ force: true }), error => error.outcomeUnknown === true);
  assert.equal(recreated.writes().length, 0); assert.equal(recreated.calls.length, 0);
});
test('pet VM：账号代际验证失效时未发购粮，成功喂食恢复后仍保留冷却', async () => {
  const h = petHarness(); let active = true;
  h.rpc = method => { if (method === 'GetMallListBySlotType') active = false; };
  await assert.rejects(h.food.checkAndFeedPetFood({ detached: true, validate: () => active }), error => error.sent === false);
  assert.equal(h.writes().length, 0);
  const stateFiles = new Map(), good = petHarness({ stateFiles });
  assert.equal((await good.food.checkAndFeedPetFood()).fed, 1);
  assert.equal(petHarness({ stateFiles }).food.getPetFoodAutomationState().lastFeedAt, 1000000);
  assert.equal((await petHarness({ stateFiles }).food.checkAndFeedPetFood()).reason, 'cooldown');
});
test('pet VM：背包异步读取，自动买→刷新→喂在同一锁，重复调用只买喂一次', async () => {
  const h = petHarness(), bagGate = petDeferred();
  let firstBag = true;
  h.getBag = () => { if (firstBag) { firstBag = false; return bagGate.promise; } return { items: h.bag }; };
  const a = h.food.checkAndFeedPetFood({ force: true }), b = h.food.checkAndFeedPetFood({ force: true });
  await petFlush(); assert.equal(h.writes().length, 0);
  bagGate.resolve({ items: [] });
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left.fed, 1); assert.equal(right.fed, 1); assert.equal(left.bought, 1);
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase', 'AddFood']);
  const purchaseAt = h.calls.findIndex(call => call.method === 'Purchase');
  const feedAt = h.calls.findIndex(call => call.method === 'AddFood');
  assert.ok(h.calls.slice(purchaseAt + 1, feedAt).some(call => call.method === 'Bag'));
});

test('pet VM：购买无物品不伪报成功、不喂食', async () => {
  const h = petHarness();
  h.rpc = method => method === 'Purchase' ? { body: { goods_id: 1006, success: true, reward_items: [] } } : undefined;
  await assert.rejects(h.food.checkAndFeedPetFood({ force: true }), error => error.outcomeUnknown === true);
  assert.equal(h.food.getPetFoodAutomationState().blocked, true);
  await assert.rejects(h.food.checkAndFeedPetFood({ force: true }), error => error.outcomeUnknown === true);
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
});

test('pet VM：关闭配置即使 force 也不买，金豆/点券只按已有开关走', async () => {
  for (const currency of [1002, 1004, 1005]) {
    const h = petHarness(); h.goods.price.id = currency; h.automation.pet_food_auto_feed = false;
    assert.equal((await h.food.checkAndFeedPetFood({ force: true })).reason, 'disabled');
    assert.equal(h.calls.length, 0);
    h.automation.pet_food_auto_feed = true;
    assert.equal((await h.food.checkAndFeedPetFood({ force: true })).fed, 1);
  }
});

test('pet VM：购买读取后关闭配置，不发 Purchase', async () => {
  const h = petHarness();
  h.rpc = method => { if (method === 'GetMallListBySlotType') h.automation.pet_food_auto_feed = false; };
  const result = await h.food.checkAndFeedPetFood({ force: true });
  assert.equal(result.skipped, true); assert.equal(h.writes().length, 0);
});

test('pet VM：余额按 price.count × 数量核验，不能把价格对象当零', async () => {
  const h = petHarness(); h.bag = [{ id: 1002, count: 15 }]; h.automation.pet_food_auto_feed_buy_count = 2;
  assert.equal((await h.food.checkAndFeedPetFood({ force: true })).reason, 'buy_none');
  assert.equal(h.writes().length, 0);
});

test('pet VM：真实奖励但刷新背包无粮，skipped 不喂', async () => {
  const h = petHarness();
  h.rpc = method => method === 'Purchase' ? { body: { goods_id: 1006, success: true, reward_items: [{ id: 90004, count: 1 }] } } : undefined;
  assert.equal((await h.food.checkAndFeedPetFood({ force: true })).reason, 'insufficient_food');
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
});

test('pet VM：狗粮不足和锁定狗粮返回 skipped，不发 AddFood', async () => {
  const h = petHarness(); h.bag = [{ id: 90004, count: 9, locked: true }];
  const result = await h.pets.feedDog(90004);
  assert.equal(result.skipped, true); assert.equal(result.reason, 'insufficient_food'); assert.equal(h.writes().length, 0);
});

test('pet VM：partial 状态保留 unknown，unowned/未知不得派出或喂食', async () => {
  const h = petHarness();
  const snapshot = h.pets.buildPetSnapshot(h.info, { items: [] });
  assert.equal(snapshot.dogs.find(dog => dog.id === 90001).owned, true);
  assert.equal(snapshot.dogs.find(dog => dog.id === 90031).owned, null);
  await assert.rejects(h.pets.deployDog(90031), /未知/);
  h.info.dog_list = [{ id: 90001, owned: false, activated: false }]; h.bag = [{ id: 90004, count: 1 }];
  await assert.rejects(h.pets.deployDog(90001), /尚未拥有/);
  await assert.rejects(h.pets.feedDog(90004), /未确认拥有/);
  assert.equal(h.writes().length, 0);
  h.info.dog_list = [{ id: 90001 }];
  await assert.rejects(h.pets.getPetOverview(), /拥有状态/);
});

test('pet VM：锁内 overview 与嵌套 deploy 不重入死锁，伪造/过期 lease 拒绝', async () => {
  const h = petHarness(); let saved;
  const result = await h.pets.withPetCommand(async lease => {
    saved = lease; await h.pets.getPetOverview(); return h.pets.deployDog(90001);
  }, { source: 'test' });
  assert.equal(result.deployed, true);
  await assert.rejects(h.pets.deployDog(90002, { lease: {} }), /lease/);
  await assert.rejects(h.pets.deployDog(90002, { lease: saved }), /lease/);
  assert.equal(h.writes().length, 1);
});

test('pet VM：所有 activate/deploy/withdraw/feed/gift 写共享锁', async () => {
  const h = petHarness(), hold = petDeferred();
  h.info.dog_list[0].activated = false; h.info.dog_list[0].owned = true; h.bag = [{ id: 90004, count: 1 }];
  const blocker = h.pets.withPetCommand(() => hold.promise, { source: 'test' });
  const jobs = [h.pets.activateDog(90001), h.pets.deployDog(90001), h.pets.withdrawDog(), h.pets.feedDog(90004), h.gifts.checkAndClaimDogSkillGifts(999)];
  await petFlush(); assert.equal(h.calls.length, 0);
  hold.resolve(); await blocker; await Promise.all(jobs);
  assert.deepEqual(h.writes().map(call => call.method), ['ActivateDog', 'DeployDog', 'WithdrawDog', 'AddFood', 'ClaimSkillGifts']);
});

test('pet VM：有界 mutex 最多32项，排队超时不执行，读不等待队尾', async () => {
  const h = petHarness(), hold = petDeferred();
  const blocker = h.pets.withPetCommand(() => hold.promise, { source: 'test' });
  let executed = 0;
  const queued = Array.from({ length: 31 }, () => h.pets.withPetCommand(() => { executed += 1; }, { source: 'test', timeoutMs: 10 }).catch(error => error));
  await assert.rejects(h.pets.withPetCommand(() => null, { source: 'test' }), error => error.code === 'PET_COMMAND_QUEUE_FULL');
  await h.pets.getPetOverview();
  h.tick(10);
  for (const result of await Promise.all(queued)) { assert.equal(result.code, 'PET_COMMAND_TIMEOUT'); assert.equal(result.outcome, 'not_sent'); }
  hold.resolve(); await blocker; assert.equal(executed, 0);
});

test('pet VM：写超时 outcome unknown，不取消/重放，结算前下一个写不执行', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = (method, args) => method === 'DeployDog' && Number(args.dog_id) === 90001 ? gate.promise : undefined;
  const first = h.pets.deployDog(90001, { timeoutMs: 10 });
  const rejected = assert.rejects(first, error => error.code === 'PET_COMMAND_TIMEOUT' && error.outcome === 'unknown' && error.writeSent && !error.retryable);
  await petFlush();
  const second = h.pets.deployDog(90002);
  await petFlush(); assert.equal(h.writes().length, 1);
  h.tick(10); await rejected; await petFlush(); assert.equal(h.writes().length, 1);
  gate.resolve({ body: petTypes.DeployDogReply.encode({ dog_id: 90001 }).finish() });
  assert.equal((await second).dogId, 90002);
  assert.ok(h.logs.some(args => args[2]?.method === 'DeployDog' && args[2]?.late === true && args[2]?.resultState === 'completed'));
  assert.deepEqual(h.writes().map(call => Number(call.args.dog_id)), [90001, 90002]);
});

test('pet VM：读校验截止后不发写，旧读完成不能继续执行', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = method => method === 'GetDogInfo' ? gate.promise : undefined;
  const job = h.pets.deployDog(90001, { timeoutMs: 10 });
  const rejected = assert.rejects(job, error => error.outcome === 'not_sent');
  await petFlush(); h.tick(10); await rejected;
  gate.resolve({ body: h.info }); await petFlush(); assert.equal(h.writes().length, 0);
});

test('pet VM：自动派出 await 期间手动接管，不恢复旧 ownership、不额外召回', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = (method, args) => method === 'DeployDog' && Number(args.dog_id) === 90001 ? gate.promise : undefined;
  const auto = h.prepare(); await petFlush();
  assert.equal(h.writes().length, 1);
  const generation = h.capital._state.generation;
  const manual = h.pets.deployDog(90002);
  assert.ok(h.capital._state.generation > generation);
  gate.resolve({ body: { dog_id: 90001 } });
  assert.equal(await auto, false); await manual;
  assert.equal(h.capital._state.autoDogId, 0); assert.equal(h.scheduled.size, 0);
  assert.deepEqual(h.writes().map(call => call.method), ['DeployDog', 'DeployDog']);
  assert.equal(h.info.current_deployed_dog_id, 90002);
});

test('pet VM：自动校验 await 之后手动接管，旧部署 RPC 不发送', async () => {
  const h = petHarness(), gate = petDeferred(); let once = true;
  h.rpc = method => { if (method === 'GetDogInfo' && once) { once = false; return gate.promise; } };
  const auto = h.prepare(); await petFlush();
  const manual = h.pets.deployDog(90002); gate.resolve({ body: h.info });
  assert.equal(await auto, false); await manual;
  assert.deepEqual(h.writes().map(call => Number(call.args.dog_id)), [90002]);
});

test('pet VM：旧自动召回读取后手动同狗重派，不能 withdraw/hijack', async () => {
  const h = petHarness(); assert.equal(await h.prepare(), true);
  h.capital.handleFarmHarvested(); const oldTask = h.scheduled.get('withdraw_after_harvest');
  const gate = petDeferred(); let once = true;
  h.rpc = method => { if (method === 'GetDogInfo' && once) { once = false; return gate.promise; } };
  const withdrawal = oldTask(); await petFlush();
  const manual = h.pets.deployDog(90001); gate.resolve({ body: h.info });
  await withdrawal; await manual; await oldTask();
  assert.equal(h.writes().filter(call => call.method === 'WithdrawDog').length, 0);
  assert.equal(h.capital._state.autoDogId, 0); assert.equal(h.info.current_deployed_dog_id, 90001);
});

test('pet VM：排队旧自动命令在 fresh 校验前失效，不能覆盖手动部署', async () => {
  const h = petHarness(), hold = petDeferred();
  const blocker = h.pets.withPetCommand(() => hold.promise, { source: 'test' });
  const auto = h.prepare(); const manual = h.pets.deployDog(90002);
  hold.resolve(); await blocker; assert.equal(await auto, false); await manual;
  assert.deepEqual(h.writes().map(call => Number(call.args.dog_id)), [90002]);
});

test('pet VM：排队部署读取最新状态，重复激活/部署/召回不二次 RPC', async () => {
  const h = petHarness(); h.info.dog_list[0] = { id: 90001, owned: true, activated: false };
  await Promise.all([h.pets.activateDog(90001), h.pets.activateDog(90001)]);
  await Promise.all([h.pets.deployDog(90001), h.pets.deployDog(90001)]);
  await Promise.all([h.pets.withdrawDog(), h.pets.withdrawDog()]);
  assert.deepEqual(h.writes().map(call => call.method), ['ActivateDog', 'DeployDog', 'WithdrawDog']);
});

test('pet VM：狗/商城保留旧 protobuf 对象不二次 decode，bytes 只解一次', async () => {
  const h = petHarness();
  const old = petTypes.GetDogInfoReply.create(h.info);
  assert.equal(h.gifts.decodeDogReply(petTypes.GetDogInfoReply, { body: old }), old);
  assert.equal(h.gifts.decodeDogReply(petTypes.GetDogInfoReply, old), old);
  assert.equal(h.gifts.decodeDogReply(petTypes.GetDogInfoReply, { body: petTypes.GetDogInfoReply.encode(old).finish() }).dog_list.length, 2);
  h.info = old; h.goods = petTypes.MallGoods.create(h.goods);
  assert.equal((await h.food.checkAndFeedPetFood({ force: true })).fed, 1);
});

test('pet VM：缺失/错误写响应抛 unknown 元数据，不报告成功', async () => {
  for (const [method, invoke] of [
    ['DeployDog', h => h.pets.deployDog(90001)],
    ['WithdrawDog', h => { h.info.current_deployed_dog_id = 90001; return h.pets.withdrawDog(); }],
    ['ActivateDog', h => { h.info.dog_list[0] = { id: 90001, owned: true, activated: false }; return h.pets.activateDog(90001); }],
    ['AddFood', h => { h.bag = [{ id: 90004, count: 1 }]; return h.pets.feedDog(90004); }],
    ['ClaimSkillGifts', h => h.gifts.checkAndClaimDogSkillGifts()],
  ]) {
    const h = petHarness(); h.rpc = name => name === method ? { body: {} } : undefined;
    await assert.rejects(invoke(h), error => error.outcome === 'unknown' && error.writeSent === true && error.retryable === false);
    assert.equal(h.writes().length, 1);
  }
});

test('pet VM：礼包 hint 不绕过 fresh 校验，并发领取只调用一次', async () => {
  const h = petHarness();
  await Promise.all([h.gifts.checkAndClaimDogSkillGifts(99), h.gifts.checkAndClaimDogSkillGifts(99)]);
  assert.equal(h.writes().length, 1);
  const result = await h.gifts.checkAndClaimDogSkillGifts(99);
  assert.equal(result.claimed, 0); assert.equal(h.writes().length, 1);
});

test('pet VM：不同 worker 实例互不阻塞，不跨账号共享锁或 ownership', async () => {
  const a = petHarness(), b = petHarness(), hold = petDeferred();
  const blocker = a.pets.withPetCommand(() => hold.promise, { source: 'test' });
  assert.equal((await b.pets.deployDog(90002)).deployed, true);
  assert.equal(a.writes().length, 0); assert.equal(a.info.current_deployed_dog_id, 0);
  hold.resolve(); await blocker;
});

test('pet VM：配置关闭取消 in-flight auto 部署，不恢复旧所有权', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = method => method === 'DeployDog' ? gate.promise : undefined;
  const auto = h.prepare(); await petFlush();
  const previous = h.config; h.config = { ...previous, enabled: false };
  await h.capital.reconcileConfigChange(previous, h.config);
  gate.resolve({ body: { dog_id: 90001 } });
  assert.equal(await auto, false); assert.equal(h.capital._state.autoDogId, 0);
  assert.equal(h.writes().filter(call => call.method === 'WithdrawDog').length, 0);
});

test('pet VM：配置召回排队期间手动切换，不召回新部署', async () => {
  const h = petHarness(); assert.equal(await h.prepare(), true);
  const hold = petDeferred();
  const blocker = h.pets.withPetCommand(() => hold.promise, { source: 'test' });
  const previous = h.config; h.config = { ...previous, enabled: false };
  const change = h.capital.reconcileConfigChange(previous, h.config);
  const manual = h.pets.deployDog(90002);
  hold.resolve(); await blocker; await change; await manual;
  assert.equal(h.info.current_deployed_dog_id, 90002);
  assert.equal(h.writes().filter(call => call.method === 'WithdrawDog').length, 0);
});

test('pet VM：自动派出和召回的最终 fresh 状态变化不能覆盖他人狗', async () => {
  const h = petHarness(); let reads = 0;
  h.rpc = method => { if (method === 'GetDogInfo' && ++reads === 2) h.info.current_deployed_dog_id = 90002; };
  assert.equal(await h.prepare(), false); assert.equal(h.writes().length, 0);
  const b = petHarness(); assert.equal(await b.prepare(), true); b.capital.handleFarmHarvested();
  let withdrawReads = 0;
  b.rpc = method => { if (method === 'GetDogInfo' && ++withdrawReads === 2) b.info.current_deployed_dog_id = 90002; };
  await b.scheduled.get('withdraw_after_harvest')();
  assert.equal(b.writes().filter(call => call.method === 'WithdrawDog').length, 0);
});

test('pet VM：安全召回与收获召回同时触发只发一次', async () => {
  const h = petHarness(); assert.equal(await h.prepare(), true); h.capital.handleFarmHarvested();
  await Promise.all([h.scheduled.get('withdraw_safety')(), h.scheduled.get('withdraw_after_harvest')()]);
  assert.equal(h.writes().filter(call => call.method === 'WithdrawDog').length, 1);
  assert.equal(h.capital._state.autoDogId, 0);
});

test('pet VM：购买错误 goods/缺失响应抛 unknown，空 reward 不喂食', async () => {
  for (const reply of [{}, { goods_id: 999, reward_items: [{ id: 90004, count: 1 }] }]) {
    const h = petHarness(); h.rpc = method => method === 'Purchase' ? { body: reply } : undefined;
    await assert.rejects(h.food.checkAndFeedPetFood({ force: true }), error => error.outcome === 'unknown' && error.method === 'Purchase');
    assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
  }
});

test('pet VM：自动购买截止时间不重试/不发 feed，后续自动检查遵守冷却', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = method => method === 'Purchase' ? gate.promise : undefined;
  const job = h.food.checkAndFeedPetFood({ timeoutMs: 10 });
  const rejected = assert.rejects(job, error => error.outcome === 'unknown' && error.method === 'Purchase');
  await petFlush(); h.tick(10); await rejected;
  const retry = assert.rejects(h.food.checkAndFeedPetFood(), error => error.outcomeUnknown === true);
  await petFlush(); assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
  gate.resolve({ body: { goods_id: 1006, reward_items: [{ id: 90004, count: 1 }] } });
  await retry;
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
});

test('pet VM：宠物读没有 TTL 缓存，旧 protobuf 实例默认 false 为明确未拥有', async () => {
  const h = petHarness(); await h.pets.getPetOverview();
  h.info = petTypes.GetDogInfoReply.create({ ...h.info, dog_list: [petRoot.lookupType('gamepb.dogpb.DogInfo').create({ id: 90001 })] });
  const overview = await h.pets.getPetOverview();
  assert.equal(overview.dogs.find(dog => dog.id === 90001).owned, false);
  assert.equal(h.calls.filter(call => call.method === 'GetDogInfo').length, 2);
  assert.equal(h.pets.getDogActivationState({ dog_list: [{ id: 90001, owned: true, activated: false }] }, 90001).activatable, true);
});

test('pet VM：协议错误码/ok:false 拒绝，不重放写请求', async () => {
  for (const reply of [{ ok: false }, { meta: { error_code: 7 }, body: { dog_id: 90001 } }, null]) {
    const h = petHarness(); h.rpc = method => method === 'DeployDog' ? reply : undefined;
    await assert.rejects(h.pets.deployDog(90001), error => error.outcome === 'unknown');
    assert.equal(h.writes().length, 1);
  }
});

test('pet VM：喂食最后 fresh await 后配置关闭，不发送 AddFood', async () => {
  const h = petHarness(); h.bag = [{ id: 90004, count: 1 }]; let reads = 0;
  h.rpc = method => { if (method === 'GetDogInfo' && ++reads === 2) h.automation.pet_food_auto_feed = false; };
  assert.equal((await h.food.checkAndFeedPetFood()).reason, 'disabled');
  assert.equal(h.writes().length, 0);
});

test('pet VM：无效数值字段不能用零 fallback 确认召回/喂食成功', async () => {
  for (const value of [{}, -1, NaN, true, 'unknown']) {
    const h = petHarness(); h.info.current_deployed_dog_id = 90001;
    h.rpc = method => method === 'WithdrawDog' ? { body: { dog_id: value } } : undefined;
    await assert.rejects(h.pets.withdrawDog(), error => error.outcome === 'unknown');
    const b = petHarness(); b.bag = [{ id: 90004, count: 1 }];
    b.rpc = method => method === 'AddFood' ? { body: { food_last_sec: value } } : undefined;
    await assert.rejects(b.pets.feedDog(90004), error => error.outcome === 'unknown');
  }
});

test('pet VM：自动资本写响应未知必须抛元数据并丢弃 ownership，不补发恢复', async () => {
  const h = petHarness(); h.rpc = method => method === 'DeployDog' ? { body: {} } : undefined;
  await assert.rejects(h.prepare(), error => error.outcome === 'unknown' && error.method === 'DeployDog');
  assert.equal(h.capital._state.autoDogId, 0); assert.equal(h.scheduled.size, 0); assert.equal(h.writes().length, 1);
  const b = petHarness(); assert.equal(await b.prepare(), true); b.capital.handleFarmHarvested();
  b.rpc = method => method === 'WithdrawDog' ? { body: {} } : undefined;
  await assert.rejects(b.scheduled.get('withdraw_after_harvest')(), error => error.outcome === 'unknown' && error.method === 'WithdrawDog');
  assert.equal(b.capital._state.autoDogId, 0); assert.equal(b.scheduled.size, 0);
});

test('pet VM：1004 fresh 背包余额与缓存 coupon/ticket 不互相冒用', async () => {
  for (const currency of [1002, 1004]) {
    const h = petHarness(); h.goods.price.id = currency;
    h.bag = [{ id: currency, count: 20 }];
    h.user = { ticket: 0, coupon: 0, goldBean: 0 };
    assert.equal((await h.food.checkAndFeedPetFood()).fed, 1);
    const b = petHarness(); b.goods.price.id = currency;
    b.bag = [{ id: currency, count: 9 }];
    b.user = { ticket: 99999, coupon: 99999, goldBean: 99999 };
    assert.equal((await b.food.checkAndFeedPetFood()).reason, 'buy_none');
    assert.equal(b.writes().length, 0);
  }
});

test('pet VM：购买前最后刷新余额，不使用旧 bag alias 或锁定货币', async () => {
  const h = petHarness(); h.goods.price.id = 1004; let reads = 0;
  h.getBag = () => ({ items: ++reads < 3 ? [{ id: 1004, count: 100 }] : [{ id: 1004, count: 100, locked: true }] });
  assert.equal((await h.food.checkAndFeedPetFood()).reason, 'buy_none');
  assert.equal(h.writes().length, 0);
});

test('pet VM：真实 PurchaseResponse wire 只有 reward_items，无 ID/success 仍由正数奖励确认', async () => {
  for (const mode of ['wire', 'message', 'object']) {
    const h = petHarness();
    const wire = petTypes.PurchaseResponse.encode({ reward_items: [{ id: 90004, count: 2 }] }).finish();
    const body = mode === 'wire' ? wire : mode === 'message' ? petTypes.PurchaseResponse.decode(wire) : { reward_items: [{ id: 90004, count: 2 }] };
    h.rpc = method => { if (method === 'Purchase') { h.bag = [{ id: 90004, count: 2 }]; return { body }; } };
    const result = await h.food.checkAndFeedPetFood();
    assert.equal(result.fed, 1); assert.equal(result.bought, 2);
    assert.deepEqual(h.writes().map(call => call.method), ['Purchase', 'AddFood']);
  }
});

test('pet VM：正数奖励之外的 success/count/default false 不充当购买成功', async () => {
  for (const body of [
    { success: true, count: 9, reward_items: [] },
    { reward_items: [{ id: 90004, count: 0 }] },
    { reward_items: [{ id: 123, count: 9 }] },
    { success: false, reward_items: [{ id: 90004, count: 9 }] },
    petTypes.PurchaseResponse.decode(petTypes.PurchaseResponse.encode({ reward_items: [] }).finish()),
  ]) {
    const h = petHarness(); h.rpc = method => method === 'Purchase' ? { body } : undefined;
    if (Object.hasOwn(body, 'success') && body.success === false) assert.equal((await h.food.checkAndFeedPetFood()).reason, 'buy_none');
    else await assert.rejects(h.food.checkAndFeedPetFood(), error => error.outcomeUnknown === true);
    assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
    assert.ok(!h.logs.some(args => args[2]?.method === 'Purchase' && args[2]?.result === 'ok'));
  }
});

test('pet VM：统一 errorCode/sent/resultState/outcomeUnknown 并保留旧兼容元数据', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = method => method === 'DeployDog' ? gate.promise : undefined;
  const job = h.pets.deployDog(90001, { timeoutMs: 10 });
  const rejected = assert.rejects(job, error => error.errorCode === 'PET_COMMAND_TIMEOUT' && error.code === error.errorCode
    && error.sent === true && error.writeSent === true && error.resultState === 'unknown' && error.outcome === 'unknown' && error.outcomeUnknown === true);
  await petFlush(); h.tick(10); await rejected; gate.resolve({ body: { dog_id: 90001 } }); await petFlush();
  const b = petHarness();
  b.rpc = method => { if (method === 'DeployDog') throw Object.assign(new Error('未发送'), { errorCode: 'CONNECTION_UNAVAILABLE', sent: false, resultState: 'not_sent' }); };
  await assert.rejects(b.pets.deployDog(90001), error => error.errorCode === 'CONNECTION_UNAVAILABLE' && error.sent === false && error.resultState === 'not_sent' && !error.outcomeUnknown);
});

test('pet VM：读超时仍持锁直到 read/operation 结算，旧 continuation 不能越权写', async () => {
  const h = petHarness(), gate = petDeferred(); let once = true;
  h.rpc = method => { if (method === 'GetDogInfo' && once) { once = false; return gate.promise; } };
  const old = h.pets.deployDog(90001, { timeoutMs: 10 });
  const rejected = assert.rejects(old, error => error.sent === false && error.resultState === 'not_sent');
  await petFlush(); h.tick(10); await rejected;
  const next = h.pets.deployDog(90002); await petFlush();
  assert.equal(h.calls.filter(call => call.method === 'GetDogInfo').length, 1); assert.equal(h.writes().length, 0);
  gate.resolve({ body: h.info }); await next;
  assert.deepEqual(h.writes().map(call => Number(call.args.dog_id)), [90002]);
});

test('pet VM：晚回包解码及异步 postresult 完成前不释放锁或启动下一命令', async () => {
  const h = petHarness(), rpcGate = petDeferred(), postGate = petDeferred(); let decoded = 0;
  h.rpc = method => method === 'DeployDog' ? rpcGate.promise : undefined;
  const old = h.pets.withPetCommand(lease => lease.write('gamepb.dogpb.DogService', 'DeployDog',
    petTypes.DeployDogRequest.encode({ dog_id: 90001 }).finish(), async response => {
      const reply = h.gifts.decodeDogReply(petTypes.DeployDogReply, response); decoded += 1;
      assert.equal(Number(reply.dog_id), 90001); lease.confirm(); await postGate.promise; return { ok: true };
    }), { source: 'test', timeoutMs: 10 });
  const rejected = assert.rejects(old, error => error.outcomeUnknown === true);
  await petFlush(); h.tick(10); await rejected;
  const next = h.pets.deployDog(90002);
  rpcGate.resolve({ body: petTypes.DeployDogReply.encode({ dog_id: 90001 }).finish() });
  await petFlush(); assert.equal(decoded, 1); assert.equal(h.writes().length, 1);
  h.tick(2000); await petFlush(); assert.equal(h.writes().length, 1);
  h.rpc = undefined; postGate.resolve(); await next;
  assert.deepEqual(h.writes().map(call => Number(call.args.dog_id)), [90001, 90002]);
});

test('pet VM：晚成功日志记录 completed 但 auto 已失 generation 不再恢复 ownership', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = (method, args) => method === 'DeployDog' && Number(args.dog_id) === 90001 ? gate.promise : undefined;
  const auto = h.prepare(); await petFlush();
  h.tick(29999); const manual = h.pets.deployDog(90002); h.tick(1);
  await assert.rejects(auto, error => error.outcomeUnknown === true);
  gate.resolve({ body: petTypes.DeployDogReply.encode({ dog_id: 90001 }).finish() }); await manual;
  assert.equal(h.capital._state.autoDogId, 0); assert.equal(h.scheduled.size, 0);
  assert.ok(h.logs.some(args => args[2]?.method === 'DeployDog' && args[2]?.late === true && args[2]?.ownershipValid === false && args[2]?.resultState === 'completed'));
  assert.equal(h.writes().filter(call => call.method === 'WithdrawDog').length, 0);
});

test('pet VM：Purchase 晚成功仅记录实际奖励，截止后不刷新或喂食', async () => {
  const h = petHarness(), gate = petDeferred();
  h.rpc = method => method === 'Purchase' ? gate.promise : undefined;
  const job = h.food.checkAndFeedPetFood({ timeoutMs: 10 });
  const rejected = assert.rejects(job, error => error.sent === true && error.outcomeUnknown === true);
  await petFlush(); h.tick(10); await rejected;
  const bagReads = h.calls.filter(call => call.method === 'Bag').length;
  gate.resolve({ body: petTypes.PurchaseResponse.encode({ reward_items: [{ id: 90004, count: 3 }] }).finish() });
  await petFlush();
  assert.ok(h.logs.some(args => args[2]?.method === 'Purchase' && args[2]?.late === true && args[2]?.resultState === 'completed' && args[2]?.count === 3));
  assert.equal(h.calls.filter(call => call.method === 'Bag').length, bagReads);
  assert.deepEqual(h.writes().map(call => call.method), ['Purchase']);
});

test('pet VM：Promise.all 某读先失败也不释放另一个在途读，旧 lease 不绕锁', async () => {
  const h = petHarness(), gate = petDeferred(); let once = true;
  h.getBag = () => gate.promise;
  h.rpc = method => { if (method === 'GetDogInfo' && once) { once = false; throw new Error('读取失败'); } };
  await assert.rejects(h.pets.feedDog(90004), /读取失败/);
  const next = h.pets.deployDog(90002); await petFlush();
  assert.equal(h.calls.filter(call => call.method === 'GetDogInfo').length, 1); assert.equal(h.writes().length, 0);
  gate.resolve({ items: h.bag }); await next;
  assert.equal(h.writes().length, 1);
});
