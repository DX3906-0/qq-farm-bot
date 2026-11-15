const test = require('node:test');
const assert = require('node:assert/strict');

const levels = require('../src/gameConfig/LandLevel.json');
const needs = require('../src/gameConfig/LandLevelNeed.json');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runWithRequestPriority, getRequestPriority } = require('../src/utils/request-priority');

function loadFarmService(name, dependencies) {
  const filename = path.join(__dirname, `../src/services/${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => {
      assert.ok(Object.hasOwn(dependencies, id), `未模拟农场依赖: ${id}`);
      return dependencies[id];
    },
  }, { filename });
  return module.exports;
}

const farmConfig = require('../src/config/config');
const gameConfig = require('../src/config/gameConfig');
const farmUtils = {
  toNum: value => Number(value) || 0, toTimeSec: value => Number(value) || 0,
  toLong: Number, getServerTimeSec: () => Math.floor(Date.now() / 1000),
  log: () => {}, logWarn: () => {},
};
const isolatedFarmApi = loadFarmService('farm-api', {
  '../utils/network': {
    sendMsgAsync: () => assert.fail('纯函数测试不得发送 RPC'), getUserState: () => ({ gid: 1 }),
  },
  '../utils/proto': { types: {}, waitForProtoReady: async () => {} },
  '../utils/utils': farmUtils,
});
const { analyzeLands, buildLandMap } = loadFarmService('farm-land-analyzer', {
  '../config/config': farmConfig, '../config/gameConfig': gameConfig,
  '../utils/utils': farmUtils, './farm-api': isolatedFarmApi, './farm-land-upgrade': {},
});
const {
  ALL_FERTILIZER_LAND_TYPES,
  getLandTypeByLevel,
  normalizeFertilizerLandTypes,
  filterLandIdsByTypes,
} = loadFarmService('farm-fertilizer', {
  '../utils/network': {}, '../utils/proto': { types: {} },
  '../config/config': farmConfig, '../utils/utils': farmUtils,
  '../models/store': {}, './stats': {}, './farm-api': isolatedFarmApi,
  './farm-land-analyzer': {}, fs: {}, path: {},
});

test('official blue-crystal land level 6 config is present', () => {
  const blue = levels.find(x => x.id === 6 && x.land_level === 6);
  assert.ok(blue);
  assert.equal(blue.level_name, '蓝晶土地');
  assert.equal(blue.land_icon_res, 'gui/texture/plantinteractive/lanjintudi/spriteFrame');
  assert.equal(blue.plant_yield_bonus, 40000);
  assert.equal(blue.planting_time_reduction, 2000);
  assert.equal(blue.plant_exp_bonus, 3000);
  assert.equal(blue.plant_mutant_bonus, 12500);
  assert.equal(blue.plant_mutant_exp_bonus, 3000);
});

test('all 24 lands have official blue-crystal upgrade requirements', () => {
  const blueNeeds = needs.filter(x => x.level === 6);
  assert.equal(blueNeeds.length, 24);
  assert.deepEqual(
    [blueNeeds[0].land_id, blueNeeds[0].level_need, blueNeeds[0].items_need],
    [1, 125, '1001:100000000;1005:11350'],
  );
  assert.deepEqual(
    [blueNeeds[23].land_id, blueNeeds[23].level_need, blueNeeds[23].items_need],
    [24, 240, '1001:3823700000;1005:81320'],
  );
});

test('fertilizer treats level 6 as blue crystal and respects explicitly excluding it', () => {
  assert.equal(getLandTypeByLevel(6), 'blue-crystal');
  assert.equal(getLandTypeByLevel(5), 'purple');
  assert.ok(ALL_FERTILIZER_LAND_TYPES.includes('blue-crystal'));
  assert.ok(normalizeFertilizerLandTypes(undefined).includes('blue-crystal'));

  const withoutBlue = ['purple', 'gold', 'black', 'red', 'normal'];
  assert.deepEqual(Array.from(normalizeFertilizerLandTypes(withoutBlue)), withoutBlue);
  assert.deepEqual(Array.from(normalizeFertilizerLandTypes(['purple'])), ['purple']);
  assert.deepEqual(Array.from(filterLandIdsByTypes([1, 2], new Map([[1, 'blue-crystal'], [2, 'purple']]), withoutBlue)), [2]);
});

/** 从真实 store 文件抽出纯配置函数，无需加载/修改个人或服务器配置。 */
function loadScopeFunctions() {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/store.js'), 'utf8');
  const begin = source.indexOf('function normalizeFertilizerLandTypes(');
  const end = source.indexOf('function normalizeOfflineReminder(', begin);
  assert.ok(begin > 0 && end > begin);
  const context = {
    DEFAULT_FERTILIZER_LAND_TYPES: ALL_FERTILIZER_LAND_TYPES,
    LEGACY_FERTILIZER_LAND_TYPES: ['purple', 'gold', 'black', 'red', 'normal'],
    FERTILIZER_LAND_TYPE_SET: new Set(ALL_FERTILIZER_LAND_TYPES),
  };
  vm.runInNewContext(source.slice(begin, end), context);
  return context;
}

test('legacy all-selected scope migrates once, while current saves can exclude blue', () => {
  const { migrateLegacyFertilizerScope, normalizeFertilizerLandTypes: normalize } = loadScopeFunctions();
  const oldTypes = ['purple', 'gold', 'black', 'red', 'normal'];
  const old = { automation: { fertilizer_land_types: oldTypes, land_upgrade: false } };
  const migrated = migrateLegacyFertilizerScope(old);
  assert.deepEqual(Array.from(migrated.automation.fertilizer_land_types), ['blue-crystal', ...oldTypes]);
  assert.equal(old.automation.fertilizer_land_types.length, 5);
  assert.equal(migrated.automation.land_upgrade, false);
  assert.deepEqual(Array.from(normalize(oldTypes)), oldTypes);
  const partial = { automation: { fertilizer_land_types: ['purple'] } };
  assert.equal(migrateLegacyFertilizerScope(partial), partial);
});

test('frontend normalization leaves explicit blue opt-out unchanged', () => {
  const ts = require('../../web/node_modules/typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/composables/settings/useAutomationSettings.ts'), 'utf8');
  const match = source.match(/  function normalizeFertilizerLandTypes\(input: unknown\) \{([\s\S]*?)\n  \}/);
  assert.ok(match);
  const compiled = ts.transpileModule(`function normalizeFertilizerLandTypes(input: unknown) {${match[1]}\n}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const normalize = vm.runInNewContext(`${compiled}\nnormalizeFertilizerLandTypes`, { allFertilizerLandTypes: ALL_FERTILIZER_LAND_TYPES });
  const withoutBlue = ['purple', 'gold', 'black', 'red', 'normal'];
  assert.deepEqual(Array.from(normalize(withoutBlue)), withoutBlue);
  assert.ok(normalize(undefined).includes('blue-crystal'));
});

test('fertilizer range can select blue crystal independently', () => {
  const types = new Map([[1, 'blue-crystal'], [2, 'purple'], [3, 'gold']]);
  assert.deepEqual(Array.from(filterLandIdsByTypes([1, 2, 3], types, ['blue-crystal'])), [1]);
  assert.deepEqual(Array.from(filterLandIdsByTypes([1, 2, 3], types, ['purple'])), [2]);
});

/** 执行真实调度器代码，但所有游戏请求均替换为内存模拟，绝不连接游戏。 */
function loadUpgradeRunner(lands, failIds = []) {
  const attempts = [];
  const operations = [];
  const logs = [];
  const delays = [];
  const failSet = new Set(failIds);
  const modules = {
    '../utils/request-priority': { runWithRequestPriority },
    '../config/config': { CONFIG: {} },
    '../utils/network': { getUserState: () => ({ gid: 1 }), isConnected: () => true, networkEvents: {} },
    '../utils/utils': {
      toNum: Number,
      log: (...args) => logs.push(args),
      logWarn: (...args) => logs.push(args),
      randomDelay: async (...args) => { delays.push(args); },
    },
    '../models/store': {
      isAutomationOn: key => key === 'land_upgrade',
      getAutomation: () => ({ fertilizer: 'none' }),
      getPrioritize2x2Crops: () => false,
      getHarvestPacing: () => null,
    },
    './friend-operation-limits': { getCanGetHelpExp: () => false },
    './stats': { recordOperation: (...args) => operations.push(args) },
    './scheduler': { createScheduler: () => ({}) },
    './farm-api': {
      getAllLands: async () => ({ lands }),
      upgradeLand: async (id) => {
        attempts.push(id);
        if (failSet.has(id)) throw new Error('模拟余额不足');
        return { land: { level: Number(lands.find(land => Number(land.id) === id).level) + 1 } };
      },
    },
    './farm-land-analyzer': { analyzeLands, buildLandMap },
    './farm-fertilizer': {},
    './planting-service': { autoPlantEmptyLands: async () => ({ plantedCount: 0 }) },
    './farm-scheduler': {},
    './exp-refresh': {},
  };
  const file = path.join(__dirname, '../src/services/farming-orchestrator.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    setTimeout: (fn, ms) => { delays.push(ms); Promise.resolve().then(fn); return {}; },
    clearTimeout: () => {},
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
      return modules[name];
    },
  }, { filename: file });
  return { run: module.exports.runFarmOperation, attempts, operations, logs, delays };
}

test('automatic upgrade immediately upgrades purple when blue is not eligible', async () => {
  const runner = loadUpgradeRunner([
    { id: 1, unlocked: true, level: 5, could_upgrade: false },
    { id: 9, unlocked: true, level: 4, could_upgrade: true },
    { id: 12, unlocked: true, level: 4, could_upgrade: true },
  ]);
  const result = await runner.run('all', { source: 'auto' });
  assert.deepEqual(runner.attempts, [9, 12]);
  assert.equal(result.hadWork, true);
  assert.deepEqual(runner.operations, [['upgrade', 2]]);
  assert.equal(runner.delays.length, 2);
  assert.ok(runner.delays.every(ms => ms >= 200 && ms <= 500));
});

test('eligible blue is tried first, but failure never blocks remaining purple upgrades', async () => {
  const runner = loadUpgradeRunner([
    { id: 9, unlocked: true, level: 4, could_upgrade: true },
    { id: 1, unlocked: true, level: 5, could_upgrade: true },
    { id: 12, unlocked: true, level: 4, could_upgrade: true },
    { id: 2, unlocked: true, level: 5, could_upgrade: false },
  ], [1]);
  const result = await runner.run('all', { source: 'auto' });
  assert.deepEqual(runner.attempts, [1, 9, 12]);
  assert.deepEqual(runner.operations, [['upgrade', 2]]);
  assert.equal(result.hadWork, true);
  assert.ok(runner.logs.some(([, message, meta]) => meta?.landId === 1 && /升级失败/.test(message)));
});

test('no eligible upgrades makes no upgrade request and does not wait for blue', async () => {
  const runner = loadUpgradeRunner([
    { id: 1, unlocked: true, level: 5, could_upgrade: false },
    { id: 9, unlocked: true, level: 4, could_upgrade: false },
  ]);
  const result = await runner.run('all', { source: 'auto' });
  assert.deepEqual(runner.attempts, []);
  assert.deepEqual(runner.delays, []);
  assert.equal(result.hadWork, false);
});

function deferredFarmCall() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function farmCrop(id, phase = 6, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id, unlocked: true, level: 1,
    plant: {
      id: 99999999, season: 1, fruit_num: 10,
      phases: phase === 2
        ? [{ phase: 2, begin_time: now - 60 }, { phase: 6, begin_time: now + 3600 }]
        : [{ phase, begin_time: now - 60 }],
    },
    ...extra,
  };
}

/** 所有调度器/分析器依赖均注入模拟；只读取源码，绝不发送游戏请求或写配置。 */
function loadFarmRunner(initialLands, options = {}) {
  let world = structuredClone(initialLands);
  let now = Date.now();
  let pacing = structuredClone(options.pacing || null);
  const automation = { farm: true, fertilizer: 'none', harvest_delay_min: 0, ...options.automation };
  const calls = [];
  const requestPriorities = [];
  const operations = [];
  const events = [];
  const pacingWrites = [];
  const delays = [];
  const timers = [];
  let activeRpc = 0;
  let maxActiveRpc = 0;
  const snapshot = () => structuredClone(world);
  const rpc = async (name, ids, run) => {
    calls.push({ name, ids: Array.from(ids || []) });
    requestPriorities.push({ name, priority: getRequestPriority() });
    activeRpc++;
    maxActiveRpc = Math.max(maxActiveRpc, activeRpc);
    try { return await run(); }
    finally { activeRpc--; }
  };
  const api = {
    FARM_OPERATION_YIELD: Symbol.for('farm.manualHarvestPriority'),
    runFarmCall: isolatedFarmApi.runFarmCall,
    getAllLands: () => rpc('lands', [], () => options.getAllLands
      ? options.getAllLands(snapshot()) : { lands: snapshot() }),
    harvest: ids => rpc('harvest', ids, () => {
      if (options.harvest) return options.harvest(Array.from(ids), snapshot());
      const reply = [];
      world = world.map(land => {
        if (!ids.includes(Number(land.id))) return land;
        const next = structuredClone(land);
        next.plant = options.multiSeason
          ? { ...next.plant, season: 2, phases: [{ phase: 2, begin_time: Math.floor(now / 1000) },
            { phase: 6, begin_time: Math.floor(now / 1000) + 3600 }] }
          : { ...next.plant, phases: [{ phase: 7, begin_time: Math.floor(now / 1000) }] };
        reply.push(next);
        return next;
      });
      return { land: reply };
    }),
    farming: ids => rpc('farming', ids, () => options.farming ? options.farming(ids) : {}),
    upgradeLand: id => rpc('upgrade', [id], () => options.upgrade ? options.upgrade(id) : { land: { level: 2 } }),
    unlockLand: id => rpc('unlock', [id], () => ({})),
  };
  const utils = {
    toNum: value => Number(value) || 0,
    toTimeSec: value => Number(value) || 0,
    getServerTimeSec: () => Math.floor(now / 1000),
    log: () => {}, logWarn: () => {},
    randomDelay: (...args) => {
      delays.push(args);
      return options.delay ? options.delay(...args) : Promise.resolve();
    },
  };
  const analyzerModule = { exports: {} };
  const analyzerDeps = {
    '../config/config': require('../src/config/config'),
    '../config/gameConfig': require('../src/config/gameConfig'),
    '../utils/utils': utils,
    './farm-api': api,
    './farm-land-upgrade': {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/farm-land-analyzer.js'), 'utf8'), {
    module: analyzerModule,
    require: name => {
      assert.ok(Object.hasOwn(analyzerDeps, name), `未模拟分析器依赖: ${name}`);
      return analyzerDeps[name];
    },
  });
  const analyzer = analyzerModule.exports;
  const deps = {
    '../utils/request-priority': { runWithRequestPriority },
    '../config/config': require('../src/config/config'),
    '../utils/network': {
      getUserState: () => ({ gid: 1 }), isConnected: () => true,
      networkEvents: { emit: (...args) => events.push(args) },
    },
    '../utils/utils': utils,
    '../models/store': {
      isAutomationOn: key => !!automation[key], getAutomation: () => automation,
      getPrioritize2x2Crops: () => false, getHarvestPacing: () => pacing,
      setHarvestPacing: value => { pacing = value; pacingWrites.push(structuredClone(value)); },
    },
    './friend-operation-limits': { getCanGetHelpExp: () => true },
    './stats': { recordOperation: (...args) => operations.push(args) },
    './scheduler': { createScheduler: () => ({}) },
    './farm-api': api,
    './farm-land-analyzer': { ...analyzer, analyzeLands: lands => analyzer.analyzeLands(lands, false) },
    './farm-fertilizer': {
      runFertilizerByConfig: ids => rpc('fertilize', ids, () => ({ organic: 0, normal: 0 })),
    },
    './planting-service': {
      autoPlantEmptyLands: (dead, empty) => rpc('plant', dead, () => {
        assert.ok(dead.every(id => !analyzer.analyzeLands(snapshot()).growing.includes(id)), '不可铲除正在生长作物');
        if (options.plant) return options.plant(Array.from(dead), Array.from(empty));
        world = world.map(land => dead.includes(Number(land.id)) ? { ...land, plant: null } : land);
        return { removedCount: dead.length, plantedCount: 0 };
      }),
    },
    './farm-scheduler': {},
    './exp-refresh': { refreshExpAfterHarvest: async () => ({ exp: 0 }) },
  };
  if (options.realComposite) {
    const codec = { create: value => value, encode: value => ({ finish: () => value }), decode: value => value };
    const simulatedNetwork = {
      getUserState: () => ({ gid: 1, level: 100, gold: 100000, accountId: '模拟账号' }),
      getWsErrorState: () => null,
      sendMsgAsync: (service, method, payload) => rpc(method, payload.items?.[0]?.land_ids || payload.land_ids, async () => {
        if (options.onRpc) await options.onRpc(method, payload);
        if (method === 'Plant') return { body: { land: payload.items[0].land_ids.map(id => ({ id, unlocked: true })) } };
        return { body: {} };
      }),
    };
    function loadComposite(file, modules) {
      const target = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../src/services/${file}.js`), 'utf8'), {
        module: target, process: { env: {} }, __dirname, console,
        require: name => {
          assert.ok(Object.hasOwn(modules, name), `未模拟复合依赖: ${name}`);
          return modules[name];
        },
      });
      return target.exports;
    }
    const proto = { types: { FertilizeRequest: codec, PlantRequest: codec, PlantReply: codec } };
    const compositeUtils = { ...utils, toLong: Number, sleep: utils.randomDelay };
    const realApi = loadComposite('farm-api', {
      '../utils/network': simulatedNetwork,
      '../utils/proto': proto, '../utils/utils': compositeUtils,
    });
    const compositeApi = { ...realApi, ...api,
      getShopInfo: () => rpc('shop', [], () => ({ goods_list: [{ id: 1, item_id: 1, unlocked: true, price: 1 }] })),
      getSeedShopId: async () => 2,
      buyGoods: () => rpc('buy', [], () => ({ get_items: [], cost_items: [] })),
      removePlant: ids => rpc('remove', ids, () => ({})),
    };
    const fertilizer = loadComposite('farm-fertilizer', {
      '../utils/network': simulatedNetwork, '../utils/proto': proto,
      '../config/config': require('../src/config/config'), '../utils/utils': compositeUtils,
      '../models/store': { getAutomation: () => automation }, './stats': deps['./stats'],
      './farm-api': compositeApi, './farm-land-analyzer': analyzer,
      fs: {}, path: {},
    });
    const planting = loadComposite('planting-service', {
      '../utils/network': simulatedNetwork, '../utils/proto': proto, '../utils/utils': compositeUtils,
      '../config/gameConfig': {
        getPlantBySeedId: () => ({ size: 1 }), getPlantById: () => ({ seasons: 1 }),
        getPlantNameBySeedId: () => '模拟种子', getPlantGrowTime: () => 60, formatGrowTime: () => '1分钟',
      },
      '../models/store': {
        getPlantingStrategy: () => 'level', getPrioritize2x2Crops: () => false,
        getBagSeedPriority: () => [],
      },
      './analytics': {}, './warehouse': { getBagSeeds: async () => [] },
      './farm-api': compositeApi, './farm-land-analyzer': analyzer, './farm-fertilizer': fertilizer,
    });
    deps['./planting-service'] = planting;
    deps['./farm-fertilizer'] = fertilizer;
  }
  const module = { exports: {} };
  class FarmDate extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/farming-orchestrator.js'), 'utf8'), {
    module, Date: FarmDate,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      const timer = { active: true };
      timers.push(timer);
      if (options.delay) void options.delay(ms).then(() => { if (timer.active) fn(); });
      else Promise.resolve().then(() => { if (timer.active) fn(); });
      return timer;
    },
    clearTimeout: timer => { timer.active = false; },
    require: name => {
      assert.ok(Object.hasOwn(deps, name), `未模拟编排依赖: ${name}`);
      return deps[name];
    },
  });
  return {
    ...module.exports, calls, requestPriorities, operations, events, pacingWrites, delays, automation, timers,
    get pacing() { return pacing; }, get maxActiveRpc() { return maxActiveRpc; },
    advance: ms => { now += ms; },
  };
}

for (const opType of ['all', 'harvest']) {
  test(`手动 ${opType} 立即收延迟成熟，不收未熟且保留设置`, async () => {
    const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], {
      automation: { harvest_delay_min: 180 }, multiSeason: true,
      pacing: { mode: 'silence', seenHarvestable: [1], waitStartAt: Date.now(), pendingSilenceSec: 10800 },
    });
    const before = structuredClone(runner.pacing);
    const settings = structuredClone(runner.automation);
    const result = await runner.runFarmOperation(opType);
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(result.harvestedLands), [1]);
    assert.deepEqual(runner.calls.filter(call => call.name === 'harvest'), [{ name: 'harvest', ids: [1] }]);
    assert.equal(runner.calls.some(call => call.name === 'plant'), false);
    assert.deepEqual(runner.delays, []);
    assert.deepEqual(runner.pacing, before);
    assert.deepEqual(runner.automation, settings);
    assert.deepEqual(runner.pacingWrites, []);
  });

  test(`手动 ${opType} 绕过统一等待，不取消统一配置`, async () => {
    const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], {
      pacing: { mode: 'unified', unifiedStartAt: Date.now() },
    });
    const before = structuredClone(runner.pacing);
    const result = await runner.runFarmOperation(opType);
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(result.harvestedLands), [1]);
    assert.deepEqual(runner.pacing, before);
    assert.deepEqual(runner.pacingWrites, []);
    assert.deepEqual(runner.delays, []);
  });
}

test('手动一键先收成熟，再务农/种植/施肥', async () => {
  const growing = farmCrop(2, 2);
  growing.plant.dry_num = 1;
  const runner = loadFarmRunner([farmCrop(1), growing], { automation: { fertilizer: 'smart' } });
  const result = await runner.runFarmOperation('all');
  assert.equal(result.success, true);
  assert.deepEqual(runner.calls.map(call => call.name), ['lands', 'harvest', 'farming', 'plant', 'fertilize']);
  assert.deepEqual(runner.calls.find(call => call.name === 'plant').ids, [1]);
});

test('自动巡田保留延迟等待，到静默阈值才收', async () => {
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], { automation: { harvest_delay_min: 10 } });
  assert.equal(await runner.checkFarm(), false);
  assert.equal(runner.calls.some(call => call.name === 'harvest'), false);
  assert.equal(runner.pacing.mode, 'silence');
  runner.advance(runner.pacing.pendingSilenceSec * 1000 + 1);
  assert.equal(await runner.checkFarm(), true);
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 1);
  assert.equal(runner.pacing, null);
});

test('自动统一等待仍等未熟地，到期收完才取消', async () => {
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], {
    pacing: { mode: 'unified', unifiedStartAt: Date.now() },
  });
  assert.equal(await runner.checkFarm(), false);
  assert.equal(runner.calls.some(call => call.name === 'harvest'), false);
  assert.equal(runner.pacing.mode, 'unified');
  runner.advance(6 * 60 * 60 * 1000 + 1);
  assert.equal(await runner.checkFarm(), true);
  assert.equal(runner.pacing, null);
});

test('收获RPC失败不伪报成功、统计或所收地块，队列可重试', async () => {
  let attempts = 0;
  const runner = loadFarmRunner([farmCrop(1)], {
    harvest: () => { attempts++; throw new Error('模拟收获失败'); },
  });
  for (let i = 0; i < 2; i++) {
    const result = await runner.runFarmOperation('all');
    assert.equal(result.success, false);
    assert.equal(result.hadWork, false);
    assert.deepEqual(Array.from(result.harvestedLands), []);
    assert.equal(result.errors[0].operation, 'harvest');
  }
  assert.equal(attempts, 2);
  assert.deepEqual(runner.operations, []);
  assert.deepEqual(runner.events, []);
  assert.equal(runner.calls.some(call => call.name === 'plant'), false);
});

test('空响应或状态未变不伪报成功', async () => {
  for (const reply of [null, { success: false }, { land: [] }]) {
    const runner = loadFarmRunner([farmCrop(1)], { harvest: () => reply });
    const result = await runner.runFarmOperation('harvest');
    assert.equal(result.success, false);
    assert.equal(result.hadWork, false);
    assert.deepEqual(Array.from(result.harvestedLands), []);
    assert.equal(result.errors.length, 1);
  }
});

test('部分收获仅返回确认地块，响应缺地且补拉失败不丢已成功结果', async () => {
  let reads = 0;
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2)], {
    getAllLands: lands => {
      if (++reads > 1) throw new Error('模拟补拉失败');
      return { lands };
    },
    harvest: () => ({ land: [farmCrop(1, 7)] }),
  });
  const result = await runner.runFarmOperation('all');
  assert.equal(result.success, false);
  assert.equal(result.hadWork, true);
  assert.deepEqual(Array.from(result.harvestedLands), [1]);
  assert.deepEqual(runner.operations, [['harvest', 1]]);
  assert.deepEqual(runner.calls.find(call => call.name === 'plant').ids, [1]);
});

test('自动AllLands在途时手动等待RPC边界，重新读取后只收一次', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  let reads = 0;
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], {
    getAllLands: async lands => {
      if (++reads === 1) { started.resolve(); await gate.promise; }
      return { lands };
    },
  });
  const auto = runner.checkFarm();
  await started.promise;
  const manual = runner.runFarmOperation('all');
  assert.equal(runner.calls.length, 1);
  gate.resolve();
  await Promise.all([auto, manual]);
  assert.equal(runner.maxActiveRpc, 1);
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 1);
  assert.deepEqual(runner.calls.find(call => call.name === 'harvest').ids, [1]);
});

test('真实ALS隔离队列项：自动在途接入手动foreground，后续自动恢复farm', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  let reads = 0;
  const runner = loadFarmRunner([farmCrop(1)], {
    getAllLands: async lands => {
      if (++reads === 1) { started.resolve(); await gate.promise; }
      return { lands };
    },
  });
  const originalPriority = getRequestPriority();
  const auto = runWithRequestPriority('farm', () => runner.runFarmOperation('all', { source: 'auto' }));
  await started.promise;
  const manual = runWithRequestPriority('foreground', () => runner.runFarmOperation('harvest'));
  // 故意从前台上下文入队自动项，验证每项执行时重新绑定而不是沿用调用方。
  const nextAuto = runWithRequestPriority('foreground', () => runner.runFarmOperation('harvest', { source: 'auto' }));
  assert.deepEqual(runner.requestPriorities, [{ name: 'lands', priority: 'farm' }]);
  gate.resolve();
  const [, manualResult] = await Promise.all([auto, manual, nextAuto]);
  assert.equal(manualResult.success, true);
  assert.deepEqual(runner.requestPriorities, [
    { name: 'lands', priority: 'farm' },
    { name: 'lands', priority: 'foreground' },
    { name: 'harvest', priority: 'foreground' },
    { name: 'lands', priority: 'farm' },
  ]);
  assert.equal(runner.maxActiveRpc, 1);
  assert.equal(getRequestPriority(), originalPriority);
});

test('自动务农在途时不跳忙，不doubleRPC；边界立即让位手动收获', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  const growing = farmCrop(2, 2);
  growing.plant.dry_num = 1;
  const runner = loadFarmRunner([farmCrop(1), growing], {
    farming: async () => { started.resolve(); await gate.promise; return {}; },
  });
  const auto = runner.checkFarm();
  await started.promise;
  const manual = runner.runFarmOperation('harvest');
  assert.equal(runner.calls.some(call => call.name === 'harvest'), false);
  gate.resolve();
  const [, result] = await Promise.all([auto, manual]);
  assert.equal(runner.maxActiveRpc, 1);
  assert.equal(result.success, true);
  assert.deepEqual(Array.from(result.harvestedLands), [1]);
  assert.deepEqual(runner.calls.map(call => call.name), ['lands', 'farming', 'lands', 'harvest']);
});

test('自动Harvest在途加多个手动不重复收/铲，未熟作物不进入目标', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2)], {
    harvest: async () => { started.resolve(); await gate.promise; return { land: [farmCrop(1, 7)] }; },
  });
  const auto = runner.checkFarm();
  await started.promise;
  const one = runner.runFarmOperation('all');
  const two = runner.runFarmOperation('harvest');
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 1);
  gate.resolve();
  const [, first, second] = await Promise.all([auto, one, two]);
  assert.equal(runner.maxActiveRpc, 1);
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 1);
  assert.equal(runner.calls.some(call => call.name === 'plant'), false);
  assert.deepEqual(Array.from(first.harvestedLands), []);
  assert.deepEqual(Array.from(second.harvestedLands), []);
  assert.deepEqual(runner.operations, [['harvest', 1]]);
});

test('自动人工延迟未到也立即让位，手动不排在剩余升级链后', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const delayGate = deferredFarmCall();
  const runner = loadFarmRunner([farmCrop(1), farmCrop(2, 2, { could_upgrade: true }),
    farmCrop(3, 2, { could_upgrade: true })], {
    automation: { land_upgrade: true, harvest_delay_min: 180 },
    delay: () => { started.resolve(); return delayGate.promise; },
  });
  const auto = runner.checkFarm();
  await started.promise;
  const result = await runner.runFarmOperation('harvest');
  assert.equal(result.success, true);
  assert.deepEqual(Array.from(result.harvestedLands), [1]);
  assert.equal(runner.calls.filter(call => call.name === 'upgrade').length, 1);
  assert.equal(runner.maxActiveRpc, 1);
  delayGate.resolve();
  assert.equal(await auto, true);
});

test('自动复合种植未完成不可穿透锁并发收获，完成后不再执行后续施肥', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  const runner = loadFarmRunner([farmCrop(1), { id: 3, unlocked: true }], {
    automation: { harvest_delay_min: 180, fertilizer: 'smart' },
    plant: async () => { started.resolve(); await gate.promise; return { plantedCount: 0 }; },
  });
  const auto = runner.checkFarm();
  await started.promise;
  const manual = runner.runFarmOperation('harvest');
  assert.equal(runner.calls.some(call => call.name === 'harvest'), false);
  gate.resolve();
  await Promise.all([auto, manual]);
  assert.equal(runner.maxActiveRpc, 1);
  assert.equal(runner.calls.some(call => call.name === 'fertilize'), false);
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 1);
});

test('2x2主从地块只收主地一次，多季继续长时不铲从属/未熟地', async () => {
  const master = farmCrop(5, 6, { slave_land_ids: [6, 1, 2] });
  const lands = [master, ...[6, 1, 2].map(id => farmCrop(id, 6, { master_land_id: 5 })), farmCrop(3, 2)];
  const runner = loadFarmRunner(lands, { multiSeason: true, automation: { harvest_delay_min: 180 } });
  const [one, two] = await Promise.all([
    runner.runFarmOperation('all'), runner.runFarmOperation('harvest'),
  ]);
  assert.equal(one.success, true);
  assert.deepEqual(Array.from(one.harvestedLands), [5]);
  assert.deepEqual(Array.from(two.harvestedLands), []);
  assert.deepEqual(runner.calls.filter(call => call.name === 'harvest'), [{ name: 'harvest', ids: [5] }]);
  assert.equal(runner.calls.some(call => call.name === 'plant'), false);
  assert.equal(runner.maxActiveRpc, 1);
});

test('2x2响应省略主地块时补拉确认，多季仍长不铲除', async () => {
  const master = farmCrop(5, 6, { slave_land_ids: [6, 1, 2] });
  const lands = [master, ...[6, 1, 2].map(id => ({ id, unlocked: true, master_land_id: 5 }))];
  let harvested = false;
  const runner = loadFarmRunner(lands, {
    getAllLands: snapshot => ({ lands: snapshot.map(land => harvested && land.id === 5
      ? { ...land, plant: farmCrop(5, 2).plant } : land) }),
    harvest: () => { harvested = true; return { land: lands.slice(1) }; },
  });
  const result = await runner.runFarmOperation('all');
  assert.equal(result.success, true);
  assert.deepEqual(Array.from(result.harvestedLands), [5]);
  assert.equal(runner.calls.filter(call => call.name === 'lands').length, 2);
  assert.equal(runner.calls.some(call => call.name === 'plant'), false);
});

test('并发去重标记不阻挡下一季成熟再次收获', async () => {
  const original = farmCrop(1);
  let reads = 0;
  const runner = loadFarmRunner([original], {
    getAllLands: () => ({ lands: [reads++ === 0 ? original
      : { ...original, plant: { ...original.plant, season: 2 } }] }),
    harvest: (ids, lands) => ({ land: lands.map(land => ({ ...land, plant: null })) }),
  });
  const first = await runner.runFarmOperation('harvest');
  const next = await runner.runFarmOperation('harvest');
  assert.equal(first.success, true);
  assert.equal(next.success, true);
  assert.equal(runner.calls.filter(call => call.name === 'harvest').length, 2);
});

for (const [mode, method] of [['plant', 'Plant'], ['normal', 'Fertilize'], ['organic', 'Fertilize']]) {
  test(`真实复合 ${mode} 在首个RPC完成边界让位，保留已完成计数且不发送余链`, { timeout: 3000 }, async () => {
    const started = deferredFarmCall();
    const gate = deferredFarmCall();
    const runner = loadFarmRunner([farmCrop(1), ...(mode === 'plant'
      ? [{ id: 2, unlocked: true }, { id: 3, unlocked: true }]
      : [farmCrop(2, 2), farmCrop(3, 2)])], {
      realComposite: true,
      automation: { harvest_delay_min: 180, fertilizer: mode === 'plant' ? 'none' : mode === 'normal' ? 'smart_normal' : 'smart_only' },
      onRpc: async rpcMethod => { if (rpcMethod === method) { started.resolve(); await gate.promise; } },
    });
    const auto = runner.runFarmOperation('all', { source: 'auto' });
    await started.promise;
    const manual = runner.runFarmOperation('harvest');
    assert.equal(runner.calls.some(call => call.name === 'harvest'), false);
    gate.resolve();
    const [autoResult, manualResult] = await Promise.all([auto, manual]);
    assert.equal(runner.maxActiveRpc, 1);
    assert.equal(runner.calls.filter(call => call.name === method).length, 1);
    assert.equal(manualResult.success, true);
    assert.deepEqual(Array.from(manualResult.harvestedLands), [1]);
    assert.equal(autoResult.hadWork, true);
    assert.deepEqual(Array.from(autoResult.errors), []);
    assert.ok(runner.operations.some(([op, count]) => op === (mode === 'plant' ? 'plant' : 'fertilize') && count === 1));
  });
}

test('真实种植复合人工间隔可取消，不留下timer且不继续第二地块', { timeout: 3000 }, async () => {
  const started = deferredFarmCall();
  const gate = deferredFarmCall();
  const runner = loadFarmRunner([farmCrop(1), { id: 2, unlocked: true }, { id: 3, unlocked: true }], {
    realComposite: true, automation: { harvest_delay_min: 180 },
    delay: () => { started.resolve(); return gate.promise; },
  });
  const auto = runner.runFarmOperation('all', { source: 'auto' });
  await started.promise;
  const manual = await runner.runFarmOperation('harvest');
  assert.equal(manual.success, true);
  assert.equal(runner.calls.filter(call => call.name === 'Plant').length, 1);
  assert.equal((await auto).hadWork, true);
  assert.ok(runner.timers.length > 0);
  assert.ok(runner.timers.every(timer => !timer.active));
  gate.resolve();
});

test('真实2x2种植确认关联后保存四格计数，再抛优先符号而非网络错误', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/planting-service.js'), 'utf8');
  const begin = source.indexOf('async function plant2x2Seed(');
  const end = source.indexOf('\nasync function plantPrioritized2x2Crops', begin);
  const priority = Symbol.for('farm.manualHarvestPriority');
  let completed = false;
  let count = 0;
  const plant = vm.runInNewContext(`${source.slice(begin, end)}\nplant2x2Seed`, {
    encodePlantRequest: () => ({}), toNum: Number, buildLandMap,
    types: { PlantReply: { decode: body => body } },
    sendMsgAsync: async () => {
      completed = true;
      return { body: { land: [
        { id: 5, land_size: 2, slave_land_ids: [6, 1, 2] },
        ...[6, 1, 2].map(id => ({ id, master_land_id: 5 })),
      ] } };
    },
  });
  await assert.rejects(plant(1, { masterLandId: 5, landIds: [5, 6, 1, 2] }, {
    checkpoint: () => { if (completed) throw priority; },
    onPlanted: value => { count += value; },
  }), err => err === priority);
  assert.equal(count, 4);
});

test('协作检查点在RPC开始前优先，不发送尚未开始的请求', async () => {
  const { runFarmCall, FARM_OPERATION_YIELD } = isolatedFarmApi;
  let calls = 0;
  await assert.rejects(runFarmCall(async () => { calls++; }, {
    checkpoint: () => { throw FARM_OPERATION_YIELD; },
  }), err => err === FARM_OPERATION_YIELD);
  assert.equal(calls, 0);
});

test('真实普通复合种植无竞争时全部完成，统计无重复', async () => {
  const runner = loadFarmRunner([{ id: 2, unlocked: true }, { id: 3, unlocked: true }], {
    realComposite: true,
  });
  const result = await runner.runFarmOperation('all');
  assert.equal(result.success, true);
  assert.equal(runner.calls.filter(call => call.name === 'Plant').length, 2);
  assert.equal(runner.operations.filter(([op]) => op === 'plant').reduce((sum, [, count]) => sum + count, 0), 2);
});

function loadFarmRoute(result) {
  let handler;
  const { registerAdminFarmOperationRoutes } = require('../src/controllers/admin-farm-operation-routes');
  registerAdminFarmOperationRoutes({
    app: { post: (url, fn) => { if (url === '/api/farm/operate') handler = fn; }, get: () => {} },
    provider: { doFarmOp: async () => result },
    getAccountIdFromRequest: () => '模拟账号', canAccessAccount: () => true,
    sendProviderError: () => assert.fail('业务结果不应走HTTP错误路径'),
  });
  return async () => {
    let response;
    await handler({ body: { opType: 'all' } }, { json: value => { response = value; } });
    return response;
  };
}

for (const [name, result, ok, skipped] of [
  ['成功', { success: true, hadWork: true, actions: ['收获1'], errors: [], harvestedLands: [1] }, true, false],
  ['无待办', { success: false, hadWork: false, actions: [], errors: [], harvestedLands: [] }, true, true],
  ['部分失败', { success: false, hadWork: true, actions: ['收获1'], errors: [{ message: '第二地块失败' }], harvestedLands: [1] }, false, false],
  ['明确失败', { success: false, hadWork: false, actions: [], errors: [{ message: '请求失败' }], harvestedLands: [] }, false, false],
]) {
  test(`HTTP农场结果 ${name} 透传明细、不丢partial且区分skipped`, async () => {
    const reply = await loadFarmRoute(result)();
    assert.equal(reply.ok, ok);
    assert.equal(reply.skipped, skipped);
    assert.equal(reply.success, result.success);
    assert.deepEqual(reply.harvestedLands, result.harvestedLands);
    assert.deepEqual(reply.details, result.errors);
    assert.deepEqual(reply.data, result);
    if (!ok) assert.ok(reply.error.includes(result.errors[0].message));
  });
}

test('HTTP缺结果不是成功回执', async () => {
  const reply = await loadFarmRoute(undefined)();
  assert.equal(reply.ok, false);
});

function loadFarmFrontend(kind, globals, t) {
  const { createRequire } = require('node:module');
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const ts = webRequire('typescript');
  if (kind === 'panel') {
    const filename = path.join(__dirname, '../../web/src/components/FarmPanel.vue');
    const compiler = webRequire('vue/compiler-sfc');
    const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8')).descriptor;
    const source = ts.createSourceFile(filename, descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'showFarmOperationResult');
    assert.ok(declaration, '未找到面板结果提示函数');
    const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInNewContext(`${code}\nshowFarmOperationResult`, globals);
  }
  const vue = webRequire('vue');
  const pinia = webRequire('pinia');
  function loadTs(relative, dependencies) {
    const filename = path.join(__dirname, '../../web/src', relative);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports, AbortController, URLSearchParams,
      require: id => {
        assert.ok(Object.hasOwn(dependencies, id), `未模拟农场前端依赖: ${id}`);
        return dependencies[id];
      },
    }, { filename });
    return module.exports;
  }
  const axios = webRequire('axios');
  const apiExports = loadTs('api/index.ts', {
    vue, axios: (() => {
      const isolated = Object.assign(function (...args) { return axios(...args); }, axios, {
        create: config => axios.create({ ...config, adapter: () => assert.fail('禁止真实 HTTP adapter') }),
      });
      isolated.default = isolated;
      return isolated;
    })(),
    '@vueuse/core': { useStorage: () => vue.ref('测试会话') },
    '@/stores/toast': { useToastStore: () => ({ error: () => {}, warning: () => {} }) },
    '@/utils/requestMonitor': { installRequestMonitor: () => {} },
    '@/config/localReadonly': { LOCAL_UI_READONLY: false },
  });
  const account = vue.reactive({ currentAccountId: '模拟账号' });
  const calls = [];
  const api = {
    post: (...args) => { calls.push(['post', ...args]); return globals.api.post(...args); },
    get: (...args) => {
      calls.push(['get', ...args]);
      return globals.fetchLands(...args).then(() => ({ data: { ok: true, data: { lands: [] } } }));
    },
  };
  const exports = loadTs('stores/farm.ts', {
    vue, pinia, '@/stores/account': { useAccountStore: () => account },
    '@/api': { __esModule: true, ...apiExports, default: api, safeGet: (...args) => api.get(...args) },
  });
  const instance = pinia.createPinia();
  const store = exports.useFarmStore(instance);
  t.after(() => pinia.disposePinia(instance));
  return Object.assign(store.operate, { calls });
}

test('前端store检查ok并回传失败/partial，刷新失败不覆盖收获结果', async (t) => {
  const reply = { ok: false, hadWork: true, harvestedLands: [1], error: '部分失败' };
  const operate = loadFarmFrontend('store', {
    api: { post: async () => ({ data: reply }) }, fetchLands: async () => { throw new Error('模拟刷新失败'); },
  }, t);
  const result = await operate('模拟账号', 'all');
  assert.equal(result, reply);
  assert.ok(result.refreshError);
  assert.deepEqual(result.harvestedLands, [1]);
  assert.equal((await operate('', 'all')).ok, false);
  assert.deepEqual(operate.calls.map(([method, url]) => [method, url]), [['post', '/api/farm/operate'], ['get', '/api/lands']]);
  assert.equal(operate.calls[0][3].headers['x-account-id'], '模拟账号');
  assert.equal(operate.calls[1][2].headers['x-account-id'], '模拟账号');
});

test('完整TS store保留真实成功、noop及部分失败明细，只发模拟刷新', async (t) => {
  for (const reply of [
    { ok: true, success: true, hadWork: true, harvestedLands: [1], errors: [] },
    { ok: true, skipped: true, success: false, hadWork: false, harvestedLands: [], errors: [] },
    { ok: false, success: false, hadWork: true, harvestedLands: [1], errors: [{ operation: 'harvest', message: '第二地块失败' }] },
  ]) {
    const operate = loadFarmFrontend('store', { api: { post: async () => ({ data: reply }) }, fetchLands: async () => {} }, t);
    const result = await operate('模拟账号', 'all');
    assert.equal(result, reply);
    assert.equal(result.ok, reply.ok);
    assert.equal(result.skipped, reply.skipped);
    assert.equal(result.success, reply.success);
    assert.equal(result.hadWork, reply.hadWork);
    assert.deepEqual(result.harvestedLands, reply.harvestedLands);
    assert.deepEqual(result.errors, reply.errors);
    assert.deepEqual(operate.calls.map(([method, url]) => [method, url]), [['post', '/api/farm/operate'], ['get', '/api/lands']]);
  }
  assert.equal(require.cache[require.resolve('../src/utils/network')], undefined);
  assert.equal(require.cache[require.resolve('../src/services/farm-api')], undefined);
});

test('前端store缺失ok结果不能作为成功', async (t) => {
  const operate = loadFarmFrontend('store', { api: { post: async () => ({ data: {} }) }, fetchLands: async () => {} }, t);
  assert.equal((await operate('模拟账号', 'all')).ok, false);
});

test('面板提示区分成功/无待办/部分失败/仅回执，绝不统一success', () => {
  const calls = [];
  const toast = Object.fromEntries(['success', 'error', 'info', 'warning'].map(type => [type, message => calls.push([type, message])]));
  const show = loadFarmFrontend('panel', { toast });
  show({ ok: true, success: true, hadWork: true, harvestedLands: [1] });
  show({ ok: true, success: false, hadWork: false, skipped: true });
  show({ ok: false, hadWork: true, harvestedLands: [1], error: '部分失败' });
  show({ ok: true });
  assert.deepEqual(calls.map(([type]) => type), ['success', 'info', 'error', 'info']);
  assert.ok(calls[2][1].includes('已收获 1'));
  const panel = fs.readFileSync(path.join(__dirname, '../../web/src/components/FarmPanel.vue'), 'utf8');
  assert.ok(panel.includes('showFarmOperationResult(result)'));
});

test('land protocol matches official field numbers and repeated structured costs', async () => {
  const protobuf = require('protobufjs');
  const root = await new protobuf.Root().load(path.join(__dirname, '../src/proto/plantpb.proto'), { keepCase: true });
  const unlock = root.lookupType('gamepb.plantpb.LandUnlockCondition');
  const upgrade = root.lookupType('gamepb.plantpb.LandUpgradeCondition');
  assert.deepEqual(Object.values(unlock.fields).map(field => [field.name, field.id]), [
    ['preceding_land_id', 1], ['need_level', 2], ['need_gold', 3],
  ]);
  assert.equal(upgrade.fields.preceeding_lands_count_need.id, 1);
  assert.equal(upgrade.fields.level_need.id, 2);
  assert.equal(upgrade.fields.items_need.id, 3);
  assert.equal(upgrade.fields.items_need.repeated, true);
  const raw = { preceeding_lands_count_need: 3, level_need: 125,
    items_need: [{ id: 1001, count: '100000000' }, { id: 1005, count: '11350' }] };
  const decoded = upgrade.decode(upgrade.encode(upgrade.create(raw)).finish());
  assert.equal(Number(decoded.level_need), 125);
  assert.equal(Number(decoded.items_need[1].count), 11350);
});

test('farm card and canvas use the real blue crystal texture without level-5 fallback', () => {
  const ts = require('../../web/node_modules/typescript');
  const cardFile = path.join(__dirname, '../../web/src/components/LandCard.vue');
  const panelFile = path.join(__dirname, '../../web/src/components/FarmPanel.vue');
  const card = fs.readFileSync(cardFile, 'utf8');
  const panel = fs.readFileSync(panelFile, 'utf8');
  const cardMatch = card.match(/const landTextureUrl = computed\(\(\) => \{([\s\S]*?)\n\}\)/);
  const panelMatch = panel.match(/function getLandTextureUrl\(land: any\) \{([\s\S]*?)\n\}/);
  assert.ok(cardMatch);
  assert.ok(panelMatch);
  const cardTexture = vm.runInNewContext(`(target) => { const land = { value: target }; return (() => {${cardMatch[1]}})(); }`);
  const compiled = ts.transpileModule(`function getLandTextureUrl(land: any) {${panelMatch[1]}\n}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const canvasTexture = vm.runInNewContext(`${compiled}\ngetLandTextureUrl`);

  for (const target of [
    { level: 6 }, { level: 6, plantSize: 1 }, { level: 6, needWater: true },
  ]) {
    assert.equal(cardTexture(target), '/game-config/land_images/land_valid6.png');
    assert.equal(canvasTexture(target), '/game-config/land_images/land_valid6.png');
  }
  for (const target of [
    { level: 6, plantSize: 2 }, { level: 6, plantSize: 4 }, { level: '6', plantSize: '2' },
    { level: 6, plantSize: 2, needWater: true }, { level: 6, plantSize: 2, status: 'growing' },
  ]) {
    assert.equal(cardTexture(target), '/game-config/land_images/land_valid6_2x2.png');
    assert.equal(canvasTexture(target), '/game-config/land_images/land_valid6_2x2.png');
  }
  const oldCardMatch = card.replace(/if \(level === 6\)[\s\S]*?(?=\n  if \(Number\(targetLand.plantSize\))/, "if (level === 6) return '/land-assets/6.png'")
    .match(/const landTextureUrl = computed\(\(\) => \{([\s\S]*?)\n\}\)/);
  const oldTexture = vm.runInNewContext(`(target) => { const land = { value: target }; return (() => {${oldCardMatch[1]}})(); }`);
  assert.equal(oldTexture({ level: 6, plantSize: 2 }), '/land-assets/6.png', '旧早返只能放大低清缩略图，确实复现缺陷');
  assert.equal(oldTexture({ level: 6, plantSize: 1 }), '/land-assets/6.png');
  assert.notEqual(oldTexture({ level: 6, plantSize: 1 }), cardTexture({ level: 6, plantSize: 1 }));
  assert.notEqual(oldTexture({ level: 6, plantSize: 2 }), cardTexture({ level: 6, plantSize: 2 }));
  assert.equal(cardTexture({ level: 6, status: 'locked' }), '/game-config/land_images/land_locked.png');
  assert.equal(canvasTexture({ level: 6, status: 'locked' }), '/game-config/land_images/land_locked.png');
  assert.equal(cardTexture({ level: 5 }), '/game-config/land_images/land_valid5.png');
  assert.equal(canvasTexture({ level: 5 }), '/game-config/land_images/land_valid5.png');
  assert.equal(cardTexture({ level: 5, needWater: true }), '/game-config/land_images/land_dry5.png');
  assert.equal(cardTexture({ level: 5, plantSize: 4 }), '/game-config/land_images/land_valid5_2x2.png');
  assert.equal(canvasTexture({ level: 5, plantSize: 2 }), '/game-config/land_images/land_valid5_2x2.png');
  assert.equal(cardTexture({ level: 6, plantSize: 2, status: 'locked', snow: true }), '/game-config/land_images/land_locked_snow.png');
});

test('真实LandCard Vue渲染四格蓝晶img与合并尺寸，单格和紫晶资源仍独立', async () => {
  const { createRequire } = require('node:module');
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const vue = webRequire('vue');
  const renderer = webRequire('vue/server-renderer');
  const compiler = webRequire('vue/compiler-sfc');
  const ts = webRequire('typescript');
  const filename = path.join(__dirname, '../../web/src/components/LandCard.vue');
  const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor;
  const script = compiler.compileScript(descriptor, { id: 'blue-crystal-real-card', inlineTemplate: true,
    templateOptions: { ssr: true } }).content;
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, require(name) {
      if (name === 'vue') return vue;
      if (name === 'vue/server-renderer') return renderer;
      if (name === './PestSprite.vue' || name === './OfficialBichonMutation.vue') return {};
      throw new Error(`未声明LandCard隔离依赖 ${name}`);
    },
  }, { filename });
  module.exports.default.__scopeId = 'data-v-blue-crystal-real-card';
  const render = (land, options = {}) => renderer.renderToString(vue.createSSRApp({ render: () => vue.h(module.exports.default,
    { land: { id: 1, status: 'growing', plantName: '森林黄金芽', imagePhase: 1, phase: 1,
      phaseName: '种子', matureInSec: 41162, currentSeason: 1, totalSeason: 3,
      plantImage: '/game-config/plant_images/common/seed.png', ...land }, farmGrid: true, showActions: false, ...options }) }));
  const merged = await render({ level: 6, plantSize: 2, occupiedLandIds: [1, 2, 5, 6] });
  assert.match(merged, /src="\/game-config\/land_images\/land_valid6_2x2.png"[^>]*class="land-ground-merged"/);
  assert.match(merged, /col-span-2 row-span-2/);
  assert.doesNotMatch(merged, /src="\/land-assets\/6.png"/);
  const single = await render({ level: 6, plantSize: 1 });
  assert.match(single, /src="\/game-config\/land_images\/land_valid6.png"[^>]*class="land-ground-single"/);
  assert.doesNotMatch(single, /src="\/land-assets\/6.png"/);
  const purple = await render({ level: 5, plantSize: 2 });
  assert.match(purple, /src="\/game-config\/land_images\/land_valid5_2x2.png"/);
  if (process.env.FARM_BLUE_CRYSTAL_PREVIEW_DIR)
    await writeBlueCrystalPreview(compiler, ts, render);
});

async function writeBlueCrystalPreview(compiler, ts, renderCard) {
  const directory = process.env.FARM_BLUE_CRYSTAL_PREVIEW_DIR;
  const build = process.env.FARM_BLUE_CRYSTAL_PREVIEW_BUILD;
  const root = path.join(__dirname, '../..');
  assert.ok(directory && build && fs.statSync(directory).isDirectory() && fs.statSync(build).isDirectory());
  assert.ok(!fs.lstatSync(directory).isSymbolicLink());
  const dataImages = {};
  function embedImage(url) {
    if (dataImages[url]) return dataImages[url];
    const relative = url.replace(/^\//, '');
    assert.ok(!relative.includes('..') && !/^https?:/.test(relative));
    const candidates = [path.join(root, 'web/public', relative)];
    if (relative.startsWith('game-config/'))
      candidates.push(path.join(root, 'core/src/gameConfig', relative.slice('game-config/'.length)));
    const filename = candidates.find(file => fs.existsSync(file));
    assert.ok(filename, `离线预览缺图 ${url}`);
    dataImages[url] = `data:image/png;base64,${fs.readFileSync(filename).toString('base64')}`;
    return dataImages[url];
  }
  const inlineImages = html => html.replace(/src="(\/[^"<>]+)"/g, (_, url) => `src="${embedImage(url)}"`);
  const cardSource = fs.readFileSync(path.join(root, 'web/src/components/LandCard.vue'), 'utf8');
  const panelSource = fs.readFileSync(path.join(root, 'web/src/components/FarmPanel.vue'), 'utf8');
  const cardStyle = compiler.parse(cardSource).descriptor.styles[0].content;
  const panelStyle = compiler.parse(panelSource).descriptor.styles[0].content;
  const compiledCardStyle = compiler.compileStyle({ source: cardStyle, id: 'data-v-blue-crystal-real-card', scoped: true });
  const compiledPanelStyle = compiler.compileStyle({ source: panelStyle, id: 'data-v-blue-crystal-preview-panel', scoped: true });
  assert.deepEqual(compiledCardStyle.errors, []);
  assert.deepEqual(compiledPanelStyle.errors, []);
  const cssFiles = fs.readdirSync(path.join(build, 'assets')).filter(name => /^(vendor-|index-).*\.css$/.test(name));
  assert.ok(cssFiles.length >= 2);
  const css = cssFiles.map(name => fs.readFileSync(path.join(build, 'assets', name), 'utf8')).join('\n')
    + '\n' + compiledCardStyle.code + '\n' + compiledPanelStyle.code;
  const candidateUrl = '/game-config/land_images/land_valid6_2x2.png';
  const singleUrl = '/game-config/land_images/land_valid6.png';
  const oldUrl = '/land-assets/6.png';
  const purpleUrl = '/game-config/land_images/land_valid5_2x2.png';
  const oldData = embedImage(oldUrl), candidateData = embedImage(candidateUrl), purpleData = embedImage(purpleUrl);
  const common = { plantSize: 2, occupiedLandIds: [1, 2, 5, 6] };
  const cardNew = inlineImages(await renderCard({ level: 6, ...common }));
  const cardOld = cardNew.replaceAll(candidateData, oldData);
  const cardPurple = inlineImages(await renderCard({ level: 5, ...common }));
  const constants = ['FARM_CANVAS_WIDTH', 'FARM_CANVAS_HEIGHT', 'SINGLE_LAND_WIDTH', 'SINGLE_LAND_HEIGHT',
    'LAND_STEP_X', 'LAND_STEP_Y', 'MERGED_LAND_WIDTH', 'MERGED_LAND_HEIGHT', 'FIELD_BACKGROUND_SCALE',
    'FIELD_BACKGROUND_OFFSET_X', 'FIELD_BACKGROUND_OFFSET_Y']
    .map(name => {
      const match = panelSource.match(new RegExp(`const ${name} = ([^\\n]+)`));
      assert.ok(match, `画布常量未找到 ${name}`);
      return `const ${name} = ${match[1]};`;
    }).join('\n');
  const names = ['getLandAnchorId', 'getCanvasPosition', 'getLandTextureUrl', 'loadCanvasImage', 'drawFarmCanvas', 'getIsometricStyle'];
  const functions = names.map(name => {
    const match = panelSource.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `画布真实函数未找到 ${name}`);
    return name === 'loadCanvasImage'
      ? match[0].replace('image.src = src', 'image.src = previewImages[src]') : match[0];
  }).join('\n');
  const compiled = ts.transpileModule(`${constants}\n${functions}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const positionStyle = vm.runInNewContext(`${compiled}\ngetIsometricStyle`, {
    Image() { throw new Error('预览生成期间不得加载网络图像'); },
  });
  const fixtureLands = [
    { id: 1, level: 6, plantSize: 2, occupiedLandIds: [1, 2, 5, 6] },
    { id: 3, level: 5, plantSize: 2, occupiedLandIds: [3, 4, 7, 8] },
    ...Array.from({ length: 16 }, (_, index) => ({ id: index + 9, level: index % 3 === 0 ? 6 : 5, plantSize: 1 })),
  ].map(land => ({ status: 'growing', phase: 1, imagePhase: 1,
    plantImage: '/game-config/plant_images/common/seed.png', ...land }));
  const overlays = [];
  for (const land of fixtureLands) {
    embedImage(land.level === 6 ? land.plantSize > 1 ? candidateUrl : singleUrl
      : land.plantSize > 1 ? purpleUrl : '/game-config/land_images/land_valid5.png');
    overlays.push(inlineImages(await renderCard(land, { isometric: true, farmGrid: false, style: positionStyle(land) })));
  }
  embedImage('/game-config/scene_images/farm-field-base.png');
  const sourceUrl = 'https://github.com/BUGDey/qq-farm-bot/blob/669f5969ad03fe60b68df9440b02bb7a503fafa8/web/public/game-config/land_images/land_valid6_2x2.png';
  const photo = (image, label, meta, className = '') => `<figure class="preview-photo ${className}"><div class="preview-photo-stage"><img src="${image}" alt="${label}"></div><figcaption><strong>${label}</strong><span>${meta}</span></figcaption></figure>`;
  const card = (html, label, meta) => `<article class="preview-card-panel"><div class="preview-land-shell">${html}</div><h3>${label}</h3><p>${meta}</p></article>`;
  const scene = (id, label, meta) => `<article class="preview-scene-panel"><div class="farm-land-viewport" data-v-blue-crystal-preview-panel><div class="iso-farm-stage" data-v-blue-crystal-preview-panel><canvas id="${id}" class="farm-scene-canvas" width="1200" height="650" data-v-blue-crystal-preview-panel></canvas>${overlays.join('')}</div></div><h3>${label}</h3><p>${meta}</p></article>`;
  const script = `const previewImages=${JSON.stringify(dataImages)};
const nextTick=()=>Promise.resolve();
const farmCanvas={value:null},displayLands={value:${JSON.stringify(fixtureLands)}},selectedLandId={value:null};
const imageCache=new Map();
${compiled}
const newTexture=getLandTextureUrl;
(async()=>{
  farmCanvas.value=document.getElementById('farm-before');
  getLandTextureUrl=land=>Number(land.level)===6?'/land-assets/6.png':newTexture(land);
  await drawFarmCanvas();
  farmCanvas.value=document.getElementById('farm-after');
  getLandTextureUrl=newTexture;
  await drawFarmCanvas();
  await Promise.all([...document.images].map(image=>image.complete?Promise.resolve():new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject})));
  const broken=[...document.images].filter(image=>!image.naturalWidth);
  const alpha=document.getElementById('farm-after').getContext('2d').getImageData(700,145,1,1).data[3];
  const report={ok:broken.length===0&&alpha>240,offline:true,apiRequests:0,realLandCardSSR:true,realDrawFarmCanvas:true,fixtureLands:displayLands.value.length,loadedImages:document.images.length,brokenImages:broken.length,candidateSize:[356,202],fourInnerFaces:true,officialOriginVerified:false,canvasCenterAlpha:alpha};
  window.blueCrystalPreviewReport=report;
  document.getElementById('preview-status').textContent=report.ok?'本地预览已就绪 · 图片完整加载':'预览校验失败';
  document.getElementById('preview-report').textContent=JSON.stringify(report);
  document.body.dataset.previewReady=report.ok?'true':'false';
})().catch(error=>{document.getElementById('preview-status').textContent='预览失败：'+error.message;document.getElementById('preview-report').textContent=JSON.stringify({ok:false,error:error.message});});`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src data:"><title>蓝晶四格土地 · 本地候选对比</title><style>${css}
body{margin:0;background:#f8f6ef;color:#26362f;font-family:"Microsoft YaHei",sans-serif;font-size:14px}.preview-page{max-width:1160px;margin:auto;padding:30px 32px 26px}.preview-eyebrow{color:#4c7c60;letter-spacing:.12em;font-size:12px;font-weight:700;margin:0 0 7px}.preview-header{display:flex;align-items:flex-start;justify-content:space-between;gap:28px}.preview-header h1{font-size:30px;line-height:1.35;margin:0 0 8px;letter-spacing:-.03em}.preview-header p{margin:0;color:#647269;line-height:1.7;max-width:720px}.preview-badge{flex:none;margin-top:4px;padding:9px 14px;border-radius:100px;background:#e8f1e7;color:#3e6950;font-size:12px;font-weight:700}.preview-section{margin-top:24px}.preview-section-head{display:flex;gap:12px;align-items:baseline;margin-bottom:12px}.preview-section-head h2{font-size:16px;margin:0}.preview-section-head span{font-size:12px;color:#7b877f}.preview-three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.preview-photo{margin:0;border:1px solid #e0e7dd;border-radius:14px;overflow:hidden;background:#fffef9}.preview-photo-stage{height:172px;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#eff4e6,#e6efdc);padding:15px}.preview-photo-stage img{width:282px;height:155px;object-fit:contain}.preview-photo figcaption{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:11px 14px}.preview-photo strong{font-size:13px}.preview-photo span{font-size:11px;color:#758277}.preview-photo.is-candidate{border-color:#8db8ca;box-shadow:0 0 0 1px #cfe0e9}.preview-card-panel{background:#fffef9;border:1px solid #e0e7dd;border-radius:14px;padding:12px}.preview-land-shell{height:212px;position:relative}.preview-land-shell .land-card{min-height:0;width:100%;border:1px solid #dedfd2;box-sizing:border-box}.preview-card-panel h3,.preview-scene-panel h3{margin:11px 0 3px;font-size:13px;font-weight:700}.preview-card-panel p,.preview-scene-panel p{margin:0;font-size:11px;line-height:1.65;color:#7b877f}.preview-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.preview-scene-panel{padding:12px;border:1px solid #e0e7dd;border-radius:14px;background:#fffef9}.preview-scene-panel .farm-land-viewport{border-radius:10px;pointer-events:none}.preview-note{margin-top:20px;display:flex;justify-content:space-between;align-items:center;gap:20px;border-top:1px solid #dde5da;padding-top:13px;font-size:11px;line-height:1.8;color:#78867c}.preview-note a{color:#567668;text-decoration:underline;text-underline-offset:3px}.preview-note strong{color:#4f6859}#preview-status{white-space:nowrap;color:#567b62}.preview-land-shell .land-bubble{display:none!important}#preview-report{display:none}@media(max-width:760px){.preview-page{padding:22px 16px}.preview-header{display:block}.preview-header h1{font-size:24px}.preview-badge{display:inline-block;margin-top:12px}.preview-three{gap:10px}.preview-photo-stage{height:125px;padding:8px}.preview-photo-stage img{width:100%;height:110px}.preview-photo figcaption{display:block}.preview-photo strong,.preview-photo span{display:block}.preview-photo figcaption{padding:8px}.preview-land-shell{height:190px}.preview-card-panel{padding:7px}.preview-two{grid-template-columns:1fr}.preview-note{display:block}}
</style></head><body><main class="preview-page"><header class="preview-header"><div><p class="preview-eyebrow">QQ FARM / BLUE CRYSTAL</p><h1>蓝晶土地，四格终于看清了</h1><p>直接采用 GitHub 中已存在的 356×202 四格素材，不再把低清小图放大或重复拼成更多格。<br>下面是同尺寸贴图、真实土地卡片和实际画布绘制函数的离线对比。</p></div><span class="preview-badge">仅本地候选 · 未发布</span></header><section class="preview-section"><div class="preview-section-head"><h2>01 / 同尺寸底图对比</h2><span>四块内面 + 一个连续外框</span></div><div class="preview-three">${photo(oldData, '当前小图', '53×29 · 分界模糊')}${photo(candidateData, '蓝晶四格候选', '356×202 · GitHub 原PNG', 'is-candidate')}${photo(purpleData, '紫晶四格参考', '355×205 · 现有素材')}</div></section><section class="preview-section"><div class="preview-section-head"><h2>02 / 放入真实土地卡片</h2><span>同一 Vue 组件、同一四格尺寸、同一模拟作物</span></div><div class="preview-three">${card(cardOld, '旧显示', '四格位置放大53×29小图，纹理发糊')}${card(cardNew, '替换为高清候选', '四块蓝晶内面与整体外框清楚可辨')}${card(cardPurple, '紫晶原显示', '保留现有资源，不改色或用它冒充蓝晶')}</div></section><section class="preview-section"><div class="preview-section-head"><h2>03 / 农场画布效果</h2><span>使用真实 drawFarmCanvas + 本地模拟土地，不请求账号</span></div><div class="preview-two">${scene('farm-before', '替换前', '上部蓝晶四格仍是模糊小图，右侧紫晶保留作参考')}${scene('farm-after', '替换后', '同一位置替换四格高清素材，单格与作物锚点保持原样')}</div></section><footer class="preview-note"><div><strong>来源说明：</strong><a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">BUGDey/qq-farm-bot · 669f5969</a>；aaang99 同图 blob 已核验。<br>官方 CDN / GUID 及素材授权未独立证实，故标记为 GitHub 候选，不声称官方原版。未重绘、未生成、未部署。</div><span id="preview-status">正在绘制本地画布…</span></footer></main><pre id="preview-report"></pre><script>${script}</script></body></html>`;
  const file = path.join(directory, '蓝晶四格对比.html');
  fs.writeFileSync(file, html, 'utf8');
  console.log('BLUE_CRYSTAL_PREVIEW', JSON.stringify({ file, offline: true, sourceBytesUnchanged: true }));
}

test('蓝晶四格是核验GitHub原PNG，四内面单外框、来源映射与双根一致', () => {
  const { createHash } = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '../..');
  const thumbnail = path.join(root, 'web/public/land-assets/6.png');
  const coreImage = path.join(root, 'core/src/gameConfig/land_images/land_valid6_2x2.png');
  const webImage = path.join(root, 'web/public/game-config/land_images/land_valid6_2x2.png');
  const coreMap = path.join(root, 'core/src/gameConfig/land_images/sources.json');
  const webMap = path.join(root, 'web/public/game-config/land_images/sources.json');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(thumbnail), '18493a6d842a07796ad6338a3b91e6e2818ed7d03470b8ce17dac190cf3adedf', '单格旧契约文件不改');
  assert.equal(hash(coreImage), 'aa885a4ca41d548aed705b736bce36f07ba67674b8b279fcc55d739fecf2acae');
  assert.equal(hash(coreImage), hash(webImage));
  assert.deepEqual(JSON.parse(fs.readFileSync(coreMap)), JSON.parse(fs.readFileSync(webMap)));
  const map = JSON.parse(fs.readFileSync(webMap)).land_valid6_2x2;
  assert.equal(map.kind, 'github-four-cell-candidate');
  assert.equal(map.independentOfficialAsset, false);
  assert.equal(map.officialOriginVerified, false, '未得到CDN/GUID证据不得冒称官方原版');
  assert.equal(map.previewOnly, false);
  assert.equal(map.userConfirmedApplication, true, '应用状态须区分用户确认与官方来源认证');
  assert.equal(map.sha256, hash(webImage));
  assert.equal(map.source.sha256, hash(webImage));
  assert.equal(map.source.gitBlob, 'd9a09f5c2ed6e8ebe3be96d5f6008cf2f80c0a2d');
  assert.equal(map.source.repository, 'BUGDey/qq-farm-bot');
  assert.equal(map.source.matchingRepository, 'aaang99/qq-farm-bot-404');
  assert.deepEqual(map.layout.nativeSize, [356, 202]);
  assert.deepEqual(map.layout.outputSize, [356, 202]);
  assert.equal(map.layout.cellCount, 4);
  assert.equal(map.layout.outerFrameCount, 1);
  assert.equal(map.layout.resampling, 'none', '必须原字节同步，不继续旧的四图拼铺或伪造细节');
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const script = String.raw`
from PIL import Image
import sys, json, hashlib
raw = open(sys.argv[1], 'rb').read()
assert hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == 'd9a09f5c2ed6e8ebe3be96d5f6008cf2f80c0a2d'
image = Image.open(sys.argv[1])
assert image.mode == 'RGBA' and image.size == (356, 202)
assert image.getchannel('A').getextrema() == (0, 255)
assert all(image.getpixel((x,y))[3] == 0 for x,y in [(0,0),(355,0),(0,201),(355,201)])
assert all(image.getpixel((x,y))[3] > 240 for x,y in [(177,44),(95,95),(265,95),(177,147)])
print(json.dumps({'ok': True, 'unchangedGitBlob': True, 'transparentCorners': True}))
`;
  const result = execFileSync(python, ['-c', script, webImage], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(JSON.parse(result).ok, true);
});

test('蓝晶小格使用干净112×64原图而不是四格缩图/增强颗粒版，双根及来源一致', () => {
  const { createHash } = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '../..');
  const image = path.join(root, 'web/public/game-config/land_images/land_valid6.png');
  const core = path.join(root, 'core/src/gameConfig/land_images/land_valid6.png');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(image), 'e5352c6190bbc11c84cc3271d9508535af7a9eb04457840d882d42703877de2e');
  assert.equal(hash(core), hash(image));
  const map = JSON.parse(fs.readFileSync(path.join(root, 'web/public/game-config/land_images/sources.json'))).land_valid6;
  assert.equal(map.kind, 'github-single-land-candidate');
  assert.equal(map.source.gitBlob, 'a5c7c5d3fd1786852501dfd9ba56d5846b26b168');
  assert.equal(map.source.sha256, hash(image));
  assert.equal(map.officialOriginVerified, false);
  assert.equal(map.userConfirmedApplication, true);
  assert.equal(map.layout.cellCount, 1);
  assert.deepEqual(map.source.size, [112, 64]);
  assert.deepEqual(map.layout.outputSize, [112, 64], '不能把插值放大声称为更多原始细节');
  assert.equal(map.layout.resampling, 'none');
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const script = String.raw`
from PIL import Image
import hashlib,sys,json
raw=open(sys.argv[1],'rb').read()
assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()=='a5c7c5d3fd1786852501dfd9ba56d5846b26b168'
im=Image.open(sys.argv[1]);assert im.mode=='RGBA' and im.size==(112,64)
assert im.getchannel('A').getextrema()==(0,255)
assert all(im.getpixel(p)[3]==0 for p in [(0,0),(111,0),(0,63),(111,63)])
assert im.getpixel((56,32))[3]>240
print(json.dumps({'ok':True,'unchangedGitBlob':True}))
`;
  assert.equal(JSON.parse(execFileSync(python, ['-c', script, image], { encoding: 'utf8', timeout: 15000, windowsHide: true })).ok, true);
});

test('蓝晶图片双根纯静态发布不触发重载，check/accept不发游戏RPC', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '../../cloudbase/.ref/deploy.py')) }, () => {
  const { execFileSync } = require('node:child_process');
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const root = path.join(__dirname, '../..');
  const script = String.raw`
import ast, pathlib, io, json, hashlib, tarfile, shlex, contextlib, types, sys, tempfile
from datetime import datetime
root = pathlib.Path(sys.argv[1])
source = root / 'cloudbase/.ref/deploy.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
constants = {}
for node in tree.body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in {'RELEASE_STATIC_ALLOWLIST', 'RELEASE_BACKEND_ALLOWLIST', 'RELEASE_INSPECT_SCRIPT', 'RELEASE_INSTALL_SCRIPT'}:
                constants[target.id] = ast.literal_eval(node.value)
assert constants['RELEASE_STATIC_ALLOWLIST'] == {'core/src/gameConfig/land_images/land_valid6.png', 'core/src/gameConfig/land_images/land_valid6_2x2.png', 'core/src/gameConfig/land_images/sources.json'}
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'load_release_manifest', 'deploy_release', 'inspect_release'}]
env = {**constants, 'pathlib': pathlib, 'io': io, 'json': json, 'hashlib': hashlib, 'tarfile': tarfile,
       'shlex': shlex, 'datetime': datetime, 'REMOTE': '/fixture/project'}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), env)
main = {'id': 'business', 'startedAt': 'same-main-time', 'mounts': {'/app/core/src': '/fixture/project/core/src', '/app/web/dist': '/home/example/web-dist'}}
gateway = {'id': 'gateway', 'startedAt': 'same-gateway-time', 'health': 'healthy', 'running': True}
class Channel:
    def recv_exit_status(self): return 0
class Stream(io.BytesIO):
    channel = Channel()
class Sftp:
    def putfo(self, stream, path, file_size): self.size = len(stream.read()); assert self.size == file_size
    def stat(self, path): return types.SimpleNamespace(st_size=self.size)
    def close(self): pass
class Client:
    def __init__(self): self.commands=[]; self.sftp=Sftp()
    def exec_command(self, command, timeout):
        self.commands.append(command)
        assert command.startswith('test -d ') and 'mkdir -p' in command, '纯前端不能发送任何restart/compose/worker命令'
        return None, Stream(b''), Stream(b'')
    def open_sftp(self): return self.sftp
    def get_transport(self): return types.SimpleNamespace(set_keepalive=lambda value: None)
    def close(self): pass
calls=[]; clients=[]; tcp_calls=[]
def connect():
    client=Client(); clients.append(client); return client
def remote(client, code, payload, timeout=120, sudo=False, script_name=''):
    calls.append((script_name,payload))
    if script_name=='qq_farm_release_preflight.py':
        selected=payload['manifest']['files']
        return {'containers': {'qq-farm-bot': main, 'farm-gateway': gateway}, 'accounts': [{'id':'1','connected':True}],
                'differences': [x['path'] for x in selected], 'verifiedExisting':0}
    if script_name=='qq_farm_release_install.py':
        assert 'core/src/runtime/gateway-process.js' not in payload['changed']
        return {'installedCount':len(payload['changed'])}
    if script_name=='qq_farm_frontend_after_read.py':
        return {'containers':{'qq-farm-bot':main,'farm-gateway':gateway}, 'accounts':[{'id':'1','connected':True}]}
    if script_name=='qq_farm_release_gateway_read.py': return {'id':'gateway','startedAt':'same-gateway-time'}
    if script_name=='qq_farm_release_verify.py': return {'ok':True}
    raise AssertionError('未许可静态步骤 '+script_name)
def tcp(client):
    tcp_calls.append(True); return {'id':'gateway','gameSockets':[{'inode':'unchanged'}]}
env.update({'ssh_connect':connect,'remote_file_json':remote,'load_panel_credentials':lambda:{'username':'fixture'},
            'gateway_tcp_snapshot':tcp,'assert_same_gateway_sessions':lambda before,after:None})
with tempfile.TemporaryDirectory(prefix='blue-crystal-static-',dir=root/'.workbuddy') as directory:
    files={'web-dist/index.html':b'index','web-dist/assets/LandCard.js':b'blue-crystal',
           'web-dist/game-config/land_images/land_valid6_2x2.png':b'png',
           'core/src/gameConfig/land_images/land_valid6_2x2.png':b'png',
           'core/src/gameConfig/land_images/land_valid6.png':b'single-png',
           'core/src/gameConfig/land_images/sources.json':b'{}',
           'core/src/runtime/gateway-process.js':b'forbidden-to-activate'}
    manifest={'name':'fixture','files':[{'path':name,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in files.items()]}
    archive=pathlib.Path(directory)/'fixture.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
        for name,raw in {**files,'release-manifest.json':json.dumps(manifest).encode()}.items():
            member=tarfile.TarInfo(name);member.size=len(raw);tar.addfile(member,io.BytesIO(raw))
    with contextlib.redirect_stdout(io.StringIO()): env['deploy_release'](str(archive),frontend_only=True)
    installed=next(p for name,p in calls if name=='qq_farm_release_install.py')
    assert set(installed['changed'])==set(files)-{'core/src/runtime/gateway-process.js'}
    assert installed['manifest']['backendFiles']==[] and len(tcp_calls)==2
    assert len([c for c in clients if c.commands])==1
    static_archive=pathlib.Path(directory)/'static.tar.gz'
    static_files={name:raw for name,raw in files.items() if name!='core/src/runtime/gateway-process.js'}
    static_manifest={**manifest,'files':[x for x in manifest['files'] if x['path'] in static_files]}
    with tarfile.open(static_archive,'w:gz') as tar:
        for name,raw in {**static_files,'release-manifest.json':json.dumps(static_manifest).encode()}.items():
            member=tarfile.TarInfo(name);member.size=len(raw);tar.addfile(member,io.BytesIO(raw))
    for accept in [False,True]:
        with contextlib.redirect_stdout(io.StringIO()): env['inspect_release'](str(static_archive),accept=accept)
        payload=calls[-1][1]
        assert payload['announcements'] is False and payload['accept'] is False
        assert payload['staticAccept'] is accept
print(json.dumps({'ok':True,'noReload':True,'staticDualRoot':True,'cases':6}))
`;
  const result = execFileSync(python, ['-c', script, root], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(JSON.parse(result).ok, true);
});

test('蓝晶候选导入严格校验hash并先检查双根，拒绝旧拼铺/篡改不修改任何文件', () => {
  const { execFileSync } = require('node:child_process');
  const python = process.env.FARM_DEPLOY_PYTHON || (process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3');
  const root = path.join(__dirname, '../..');
  const script = String.raw`
import ast, json, io, pathlib, sys, tempfile, contextlib
root = pathlib.Path(sys.argv[1])
source = root / 'tools/asset-fetcher/fetch-qqext-assets.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'import_blue_crystal_2x2', 'import_blue_crystal_asset'}]
env = {'io': io, 'json': json}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), env)
assert 'build_blue_crystal_2x2' not in source.read_text(encoding='utf-8'), '废弃的16格拼铺入口必须删除'
# 公开副本不需要私有工作记录目录；临时素材由系统临时目录隔离管理。
with tempfile.TemporaryDirectory(prefix='blue-crystal-import-') as folder:
    test = pathlib.Path(folder)
    core = test / 'core/src/gameConfig/land_images'
    web = test / 'web/public/game-config/land_images'
    core.mkdir(parents=True); web.mkdir(parents=True)
    for path in (core, web):
        (path / 'land_valid6_2x2.png').write_bytes(b'sentinel')
        (path / 'sources.json').write_text('{"otherLevel": {"keep": true}}', encoding='utf-8')
    candidate = root / 'web/public/game-config/land_images/land_valid6_2x2.png'
    tampered = test / 'tampered.png'
    tampered.write_bytes(candidate.read_bytes() + b'bad')
    try: env['import_blue_crystal_2x2'](tampered, test)
    except RuntimeError: pass
    else: raise AssertionError('篡改素材必须拒绝')
    assert all((p / 'land_valid6_2x2.png').read_bytes() == b'sentinel' for p in (core, web))
    missing = test / 'missing'
    missing_core = missing / 'core/src/gameConfig/land_images'
    missing_core.mkdir(parents=True)
    (missing_core / 'land_valid6_2x2.png').write_bytes(b'untouched')
    try: env['import_blue_crystal_2x2'](candidate, missing)
    except RuntimeError: pass
    else: raise AssertionError('另一根不存在必须在写前拒绝')
    assert (missing_core / 'land_valid6_2x2.png').read_bytes() == b'untouched'
    with contextlib.redirect_stdout(io.StringIO()): env['import_blue_crystal_2x2'](candidate, test)
    assert all((p / 'land_valid6_2x2.png').read_bytes() == candidate.read_bytes() for p in (core, web))
    assert all(json.loads((p / 'sources.json').read_text())['otherLevel']['keep'] for p in (core, web))
    assert all(json.loads((p / 'sources.json').read_text())['land_valid6_2x2']['previewOnly'] for p in (core, web))
    with contextlib.redirect_stdout(io.StringIO()): env['import_blue_crystal_2x2'](candidate, test, confirmed=True)
    assert all(json.loads((p / 'sources.json').read_text())['land_valid6_2x2']['previewOnly'] is False for p in (core, web))
    assert all(json.loads((p / 'sources.json').read_text())['land_valid6_2x2']['officialOriginVerified'] is False for p in (core, web))
print(json.dumps({'ok': True, 'cases': 5, 'gameRpcSent': False}))
`;
  const result = execFileSync(python, ['-c', script, root], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(JSON.parse(result).ok, true);
});
