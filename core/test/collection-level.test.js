const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../web/node_modules/typescript');
const { getCollectionUserLevel, registerAdminCollectionRoutes } = require('../src/controllers/admin-collection-routes');

function createRoute(provider, options = {}) {
  const routes = new Map();
  const warnings = [];
  registerAdminCollectionRoutes({
    app: {
      get: (route, handler) => routes.set(route, handler),
      post: () => {},
    },
    provider,
    getAccountIdFromRequest: req => req.headers['x-account-id'],
    canAccessAccount: (_req, id) => id === '1' || id === '10',
    adminLogger: { warn: (...args) => warnings.push(args) },
    ...options,
  });
  return {
    warnings,
    request: async (accountId = '1') => {
      const response = { statusCode: 200, body: null };
      const res = {
        status: (code) => { response.statusCode = code; return res; },
        json: (body) => { response.body = body; return res; },
      };
      await routes.get('/api/collection')({ headers: { 'x-account-id': accountId }, query: {} }, res);
      return response;
    },
  };
}

test('collection level reads the nested status and never treats pending data as level zero', () => {
  assert.equal(getCollectionUserLevel({ status: { level: 103 } }), 103);
  assert.equal(getCollectionUserLevel({ status: { level: '125' } }), 125);
  assert.equal(getCollectionUserLevel({ level: 101 }), 101);
  assert.equal(getCollectionUserLevel({ status: { level: 103 }, level: 0 }), 103);
  for (const value of [null, undefined, 0, -1, '', 'bad', Infinity, NaN, 1.5, true]) {
    assert.equal(getCollectionUserLevel({ status: { level: value } }), null);
  }
});

test('collection API supplies the requested account level with synchronous or async providers', async () => {
  const route = createRoute({
    getCollections: async () => ({ details: [], service: 'CollectionService' }),
    getStatus: async id => ({ status: { level: id === '1' ? 103 : 101 } }),
  });
  assert.equal((await route.request('1')).body.data.userLevel, 103);
  assert.equal((await route.request('10')).body.data.userLevel, 101);
  assert.equal((await route.request('10')).body.data.levelStatus, 'ready');
});

test('unknown or failed status preserves collection data and reports an explicit unknown level', async () => {
  const pending = createRoute({
    getCollections: async () => ({ details: [{ category: 1 }] }),
    getStatus: () => ({ status: { level: 0 } }),
  });
  const result = await pending.request();
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.userLevel, null);
  assert.equal(result.body.data.levelStatus, 'pending');
  assert.equal(result.body.data.details.length, 1);

  const failed = createRoute({
    getCollections: async () => ({ details: [{ category: 1 }] }),
    getStatus: () => { throw new Error('status unavailable'); },
  });
  const failure = await failed.request();
  assert.equal(failure.body.data.userLevel, null);
  assert.equal(failure.body.data.levelStatus, 'unavailable');
  assert.equal(failed.warnings.length, 1);
});

test('collection API does not query another account when access is forbidden', async () => {
  let calls = 0;
  const route = createRoute({
    getCollections: async () => { calls++; return {}; },
    getStatus: () => { calls++; return {}; },
  });
  assert.equal((await route.request('2')).statusCode, 403);
  assert.equal(calls, 0);
});

/** 执行现有前端 store，Vue/HTTP 换为内存对象，测试无浏览器或游戏依赖。 */
function loadFrontendStore(get, currentId = '1') {
  const account = { currentAccountId: currentId };
  const module = { exports: {} };
  const sourcePath = path.join(__dirname, '../../web/src/stores/collection.ts');
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'pinia') return { defineStore: (_id, setup) => setup };
      if (name === 'vue') return { ref: value => ({ value }) };
      if (name === '@/api') return { default: { get } };
      if (name === '@/stores/account') return { useAccountStore: () => account };
      throw new Error(`unexpected dependency: ${name}`);
    },
  }, { filename: sourcePath });
  return { store: module.exports.useCollectionStore(), account };
}

test('frontend uses backend collection level without an extra status request', async () => {
  const calls = [];
  const { store } = loadFrontendStore(async (url) => {
    calls.push(url);
    return { data: { ok: true, data: { userLevel: 103, details: [] } } };
  });
  await store.fetchCollections('1');
  assert.equal(store.userLevel.value, 103);
  assert.deepEqual(calls, ['/api/collection']);
});

test('frontend fetches current account status when talking to the old backend', async () => {
  const calls = [];
  const { store } = loadFrontendStore(async (url, options) => {
    calls.push([url, options.headers['x-account-id']]);
    return { data: { ok: true, data: url === '/api/collection'
      ? { details: [] }
      : { status: { level: 103 } } } };
  });
  await store.fetchCollections('1');
  assert.equal(store.userLevel.value, 103);
  assert.deepEqual(calls, [['/api/collection', '1'], ['/api/status', '1']]);
});

test('frontend status failure stays unknown instead of inventing Lv.0', async () => {
  const { store } = loadFrontendStore(async (url) => {
    if (url === '/api/status') throw new Error('offline');
    return { data: { ok: true, data: { details: [] } } };
  });
  await store.fetchCollections('1');
  assert.equal(store.userLevel.value, null);
  assert.equal(store.loading.value, false);
});

test('late collection response cannot restore the old account level after clear', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { store, account } = loadFrontendStore(() => pending);
  const oldRequest = store.fetchCollections('1');
  account.currentAccountId = '10';
  store.clear();
  resolve({ data: { ok: true, data: { userLevel: 103, details: [{ category: 1 }] } } });
  await oldRequest;
  assert.equal(store.userLevel.value, null);
  assert.equal(store.categories.value.length, 0);
  assert.equal(store.loading.value, false);
});

test('late legacy status fallback cannot overwrite the newly selected account', async () => {
  let resolve;
  const pendingStatus = new Promise(done => { resolve = done; });
  const { store, account } = loadFrontendStore(async (url) => {
    if (url === '/api/status') return pendingStatus;
    return { data: { ok: true, data: { details: [] } } };
  });
  const oldRequest = store.fetchCollections('1');
  await Promise.resolve();
  await Promise.resolve();
  account.currentAccountId = '10';
  store.clear();
  resolve({ data: { ok: true, data: { status: { level: 103 } } } });
  await oldRequest;
  assert.equal(store.userLevel.value, null);
  assert.equal(store.loadedAccountId.value, '');
});

/** 使用真实 protobuf 类型与服务代码，但网络/资源全部为内存模拟。 */
async function loadCollectionService(reply, failure = null) {
  const protobuf = require('protobufjs');
  const root = await new protobuf.Root().load(path.join(__dirname, '../src/proto/collectionpb.proto'), { keepCase: true });
  const types = Object.fromEntries([
    'GetCollectionsRequest', 'GetCollectionsReply', 'UpgradeCollectionRequest',
    'UpgradeCollectionReply', 'ClaimCollectionRewardRequest', 'ClaimCollectionRewardReply',
  ].map(name => [name, root.lookupType(`gamepb.collectionpb.${name}`)]));
  const calls = [];
  const catalog = [
    { id: 700001, type: 35, name: '棉芽', rarity: 1 },
    { id: 700002, type: 35, name: '布丁', rarity: 2 },
  ];
  const warnings = [];
  const module = { exports: {} };
  const file = path.join(__dirname, '../src/services/collection.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    __dirname: path.dirname(file),
    require: name => {
      if (name === '../utils/proto') return { types };
      if (name === '../utils/utils') return { logWarn: (...args) => warnings.push(args) };
      if (name === '../config/gameConfig') return {
        getItemById: id => catalog.find(item => item.id === id),
        getItemImageById: () => '',
      };
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true, readFileSync: () => JSON.stringify(catalog) };
      if (name === '../utils/network') return { sendMsgAsync: async (service, method, request) => {
        const requestType = types[`${method}Request`];
        calls.push({ service, method, request: requestType.decode(request) });
        if (failure) throw failure;
        const replyType = types[`${method}Reply`];
        return { body: replyType.encode(replyType.create(reply)).finish() };
      } };
      throw new Error(`unexpected dependency: ${name}`);
    },
  }, { filename: file });
  return { service: module.exports, calls, warnings };
}

for (const [method, args, reply, wireMethod] of [
  ['getCollections', [], { details: [] }, 'GetCollections'],
  // Mutation paths now require fresh state/cost/level confirmation. Their actual
  // protobuf + network + durable single-write coverage lives in gameplay-migration.test.js.
]) {
  test(`${wireMethod} sends exactly one request to the verified service`, async () => {
    const { service, calls } = await loadCollectionService(reply);
    await service[method](...args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].service, 'gamepb.collectionpb.CollectionService');
    assert.equal(calls[0].method, wireMethod);
  });

  test(`${wireMethod} failure propagates without retrying another service`, async () => {
    const { service, calls } = await loadCollectionService(reply, new Error('模拟业务拒绝'));
    await assert.rejects(service[method](...args), /模拟业务拒绝/);
    assert.equal(calls.length, 1);
  });
}

test('collection catalog keeps owned state and server-only new items', async () => {
  const { service } = await loadCollectionService({ details: [{ category: 1, current_score: 42, collections: [
    { collection_id: 700001, star_level: 2, own_count: 3 },
    { collection_id: 799999, star_level: 1, own_count: 1 },
  ] }] });
  const result = await service.getCollections();
  const category = result.details.find(item => item.category === 1);
  assert.equal(category.currentScore, 42);
  assert.equal(category.collections.length, 3);
  assert.equal(category.collections.find(item => item.collectionId === 700001).starLevel, 2);
  assert.equal(category.collections.find(item => item.collectionId === 700001).ownCount, 3);
  assert.equal(category.collections.find(item => item.collectionId === 700002).owned, false);
  assert.equal(category.collections.find(item => item.collectionId === 799999).owned, true);
});

test('category filter does not replace unrelated categories with the default catalog', async () => {
  const { service } = await loadCollectionService({ details: [{ category: 2, collections: [
    { collection_id: 799999, star_level: 1, own_count: 1 },
  ] }] });
  const result = await service.getCollections([2]);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].category, 2);
  assert.equal(result.details[0].collections.length, 1);
  assert.equal(result.details[0].collections[0].collectionId, 799999);
});

test('empty player collection state still shows a zero-owned catalog', async () => {
  const { service } = await loadCollectionService({ details: [] });
  const result = await service.getCollections();
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].category, 1);
  assert.equal(result.details[0].collections.length, 2);
  assert.ok(result.details[0].collections.every(item => !item.owned && item.starLevel === 0));
});
