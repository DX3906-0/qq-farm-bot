'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const web = path.resolve(__dirname, '../../web');
const webRequire = createRequire(path.join(web, 'package.json'));
const vue = webRequire('vue');
const pinia = webRequire('pinia');
const ts = webRequire('typescript');
const compiler = webRequire('vue/compiler-sfc');
const renderer = webRequire('vue/server-renderer');
const read = relative => fs.readFileSync(path.join(web, 'src', relative), 'utf8');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }, values };
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function frontendHarness(overrides = {}, options = {}) {
  const cache = new Map();
  const localStorage = options.localStorage || storage();
  const sessionStorage = options.sessionStorage || storage();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(web, 'src', relative);
    let code = read(relative);
    if (relative.endsWith('.vue')) {
      const descriptor = compiler.parse(code, { filename }).descriptor;
      code = compiler.compileScript(descriptor, { id: 'ux-unit', inlineTemplate: true, templateOptions: { ssr: true } }).content;
    }
    const module = { exports: {} };
    cache.set(relative, module);
    const output = ts.transpileModule(code, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(output, { module, exports: module.exports, console, Date, Intl, URL, URLSearchParams, Map, Set,
      localStorage, sessionStorage, setTimeout, clearTimeout, AbortController,
      ...options.globals,
      require(name) {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name === 'vue') return vue;
        if (name === 'pinia') return pinia;
        if (name === 'vue/server-renderer') return renderer;
        if (name === 'vue-router') return webRequire('vue-router');
        if (name.startsWith('@/')) {
          let file = name.slice(2);
          if (!path.extname(file)) file += '.ts';
          return load(file);
        }
        throw new Error(`Unmocked frontend dependency is forbidden: ${name}`);
      },
    }, { filename });
    return module.exports;
  }
  return { load, localStorage, sessionStorage };
}
async function renderComponent(relative, props = {}) {
  const h = frontendHarness();
  const component = h.load(relative).default;
  return renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, props, { default: () => '确认操作' }) }));
}
function themeHarness(get, local = storage()) {
  const styles = new Map();
  const classes = new Set();
  const h = frontendHarness({ '@/api': { __esModule: true, default: { get } }, '@/config/localReadonly': { LOCAL_UI_READONLY: false } }, { localStorage: local, globals: {
    document: { documentElement: { style: { setProperty: (key, value) => styles.set(key, value) },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } },
  } });
  const instance = pinia.createPinia();
  const store = h.load('stores/app.ts').useAppStore(instance);
  return { ...h, store, styles, classes, dispose: () => pinia.disposePinia(instance) };
}

function shopStoreHarness(get, post = () => assert.fail('unexpected shop purchase')) {
  const selected = vue.ref('A'), requests = [], purchases = [];
  const account = { get currentAccountId() { return selected.value; } };
  const apiSource = read('api/index.ts');
  const coordinatorSource = apiSource.slice(apiSource.indexOf('export function createReadCoordinator()'), apiSource.indexOf('const safeReadPaths'));
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(coordinatorSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, AbortController, CanceledError: webRequire('axios').CanceledError,
      tokenRef: { value: '' }, sessionEpoch: 0, cloneRead: value => value === undefined ? value : JSON.parse(JSON.stringify(value)) });
  const apiMock = { __esModule: true,
    default: { post: (url, body, config) => { purchases.push({ url, body, config }); return post(url, body, config); } },
    safeGet: (url, config) => { requests.push({ url, config }); return get(url, config); },
    createReadCoordinator: module.exports.createReadCoordinator, invalidateSafeReads() {},
    isReadCanceled: error => error?.code === 'ERR_CANCELED' || error?.name === 'AbortError',
  };
  const h = frontendHarness({ '@/api': apiMock, '@/stores/account': { useAccountStore: () => account } });
  const instance = pinia.createPinia();
  const store = h.load('stores/shop.ts').useShopStore(instance);
  return { store, selected, requests, purchases, dispose: () => pinia.disposePinia(instance) };
}
function ranchStoreHarness(responder) {
  const selected = vue.ref('A'), calls = [];
  let invalidations = 0;
  const api = {
    get: (url, config) => { calls.push({ method: 'GET', url, config }); return responder('GET', url, config); },
    post: (url, body, config) => { calls.push({ method: 'POST', url, body, config }); return responder('POST', url, body, config); },
  };
  const h = frontendHarness({
    '@/api': { __esModule: true, default: api, safeGet: api.get,
      invalidateSafeReads: () => { invalidations++; }, isReadCanceled: error => error?.code === 'ERR_CANCELED' },
    '@/stores/account': { useAccountStore: () => ({ get currentAccountId() { return selected.value; } }) },
  });
  const instance = pinia.createPinia();
  const store = h.load('stores/ranch.ts').useRanchStore(instance);
  // Most store-unit fixtures represent a rendered page after the required
  // service safety snapshot already succeeded; dedicated tests below exercise
  // safe-read failure/recovery explicitly.
  store.operationsReady = true;
  return { store, selected, calls, invalidations: () => invalidations, storage: h.localStorage,
    dispose: () => pinia.disposePinia(instance) };
}
const ranchWriteResponse = (accountId, action = 'harvest') => ({ data: { ok: true, accountId,
  data: { status: 'confirmed', action, label: '牧场操作', count: 1, completed: 1, costs: [], rewards: [] } } });
const ranchOperationsResponse = (accountId, pending = []) => ({ data: { ok: true, accountId,
  data: { pending, scene: { phase: 'home', recoveryRequired: false }, friendSession: { phase: 'idle', recoveryRequired: false } } } });

test('ranch writes: 跨账号独立在途，迟到成功/finally不清新账号目录或锁，重复点击只发送一次', async () => {
  const a = deferred(), b = deferred();
  const h = ranchStoreHarness((method, _url, third, fourth) => {
    const config = method === 'GET' ? third : fourth;
    return method === 'GET' ? Promise.resolve(ranchOperationsResponse(config.headers['x-account-id']))
      : config.headers['x-account-id'] === 'A' ? a.promise : b.promise;
  });
  try {
    const first = h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    const duplicate = await h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    assert.equal(duplicate.sent, false);
    assert.equal(h.store.operating, true);
    h.selected.value = 'B';
    assert.equal(h.store.operating, false);
    const bSafety = await h.store.fetchOperations('B');
    assert.equal(bSafety.safe, true, '新账号先独立读取自己的待核对安全快照');
    h.store.catalogs = { 5: [{ id: 222, name: 'B' }] };
    const second = h.store.execute('B', 'clean', {}, { signature: 'b' });
    await Promise.resolve();
    const before = h.invalidations();
    a.resolve(ranchWriteResponse('A'));
    assert.equal((await first).stale, true);
    assert.equal(h.store.operating, true, `A的finally不能解除B的在途状态: ${JSON.stringify({ states: h.store.operationStates, current: h.store.currentState, calls: h.calls.map(call => [call.method, call.config?.headers?.['x-account-id']]) })}`);
    assert.equal(h.store.catalogs[5][0].id, 222);
    assert.equal(h.invalidations(), before, '迟到A不能失效B的读取');
    b.resolve(ranchWriteResponse('B', 'clean'));
    assert.equal((await second).ok, true);
    assert.equal(h.store.operating, false);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(h.storage.length, 0, '游戏写状态不持久化到页面存储');
  }
  finally { h.dispose(); }
});

test('ranch quote: A-B-A迟到报价不能覆盖新报价，旧成功与旧错误均标stale', async () => {
  const old = deferred(), fresh = deferred();
  let count = 0;
  const h = ranchStoreHarness(() => (++count === 1 ? old.promise : fresh.promise));
  try {
    const first = h.store.quote('A', 'harvest', { all: true });
    h.selected.value = 'B'; h.selected.value = 'A';
    const second = h.store.quote('A', 'harvest', { all: true });
    const response = signature => ({ data: { ok: true, accountId: 'A', data: { action: 'harvest', expected: { signature } } } });
    fresh.resolve(response('new'));
    assert.equal((await second).quote.expected.signature, 'new');
    old.resolve(response('old'));
    assert.equal((await first).stale, true);
  }
  finally { h.dispose(); }
});

test('ranch unknown: 切号不丢未知状态，空pending不自动解除，人工核对也不重放写', async () => {
  const gate = deferred();
  const h = ranchStoreHarness((method, _url, value) => method === 'POST' ? gate.promise
    : Promise.resolve(ranchOperationsResponse(value.headers['x-account-id'])));
  try {
    const write = h.store.execute('A', 'feed', { all: true, bucketType: 2 }, { signature: 'a' });
    await Promise.resolve();
    h.selected.value = 'B';
    h.store.catalogs = { 5: [{ id: 222, name: 'B' }] };
    gate.reject(Object.assign(new Error('timeout'), { response: { data: { resultState: 'unknown', sent: true, outcomeUnknown: true } } }));
    assert.equal((await write).stale, true);
    assert.equal(h.store.catalogs[5][0].id, 222);
    assert.equal(h.store.currentState, 'idle');
    h.selected.value = 'A';
    assert.equal(h.store.writeBlocked, true);
    await h.store.fetchOperations('A');
    assert.equal(h.store.writeBlocked, true, '空pending不是客户端操作终态证据');
    const blocked = await h.store.execute('A', 'feed', { all: true }, { signature: 'a' });
    assert.equal(blocked.sent, false);
    assert.equal((await h.store.confirmClientOutcome('A')).ok, true);
    assert.equal(h.store.writeBlocked, false);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
  finally { h.dispose(); }
});

test('服务端明确列出待核对目标时，前端不再全局禁用无关购买；场景恢复锁仍全局阻止', async () => {
  const pending = { id: 'unknown-task', target: 'ranch:claimTasks:300011', label: '成长任务领取',
    costs: [], createdAt: 1, message: '结果待核对' };
  const h = ranchStoreHarness((method, url) => url === '/api/ranch/operations'
    ? Promise.resolve(ranchOperationsResponse('A', [pending]))
    : method === 'POST' ? Promise.resolve(ranchWriteResponse('A', 'buy'))
      : Promise.resolve({ data: { ok: true, accountId: 'A', data: {} } }));
  try {
    const safety = await h.store.fetchOperations('A');
    assert.equal(safety.safe, true);
    assert.equal(h.store.currentState, 'unknown', '仍如实提示待核对记录');
    assert.equal(h.store.writeBlocked, false, '只限制冲突目标，不全局禁用其它购买');
    const result = await h.store.execute('A', 'buy', { shopId: 5, goodsId: 10003, count: 1 }, { signature: 'fresh-offer' });
    assert.equal(result.ok, true);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
  finally { h.dispose(); }

  const recovery = ranchStoreHarness((_method, url) => Promise.resolve({ data: { ok: true, accountId: 'A', data: {
    pending: [pending], scene: { phase: 'unknown', recoveryRequired: true },
    friendSession: { phase: 'idle', recoveryRequired: false },
  } } }));
  try {
    await recovery.store.fetchOperations('A');
    assert.equal(recovery.store.writeBlocked, true, '未知scene状态继续冻结所有场景写');
  }
  finally { recovery.dispose(); }
});

test('已读取的无关待核对账本不全局禁商城购买；恢复状态未知时仍禁止所有写入', async () => {
  const row = { id: 'task-unknown', target: 'ranch:claimTasks:300011', label: '成长任务领取', costs: [], createdAt: 1, message: '结果待核对' };
  const h = ranchStoreHarness((method, url) => {
    if (url === '/api/ranch/operations') return Promise.resolve(ranchOperationsResponse('A', [row]));
    if (method === 'POST' && url === '/api/ranch/operate') return Promise.resolve(ranchWriteResponse('A', 'buy'));
    return Promise.resolve({ data: { ok: true, accountId: 'A', data: {} } });
  });
  try {
    await h.store.fetchOperations('A');
    assert.equal(h.store.currentState, 'unknown', '账本状态仍显式提示存在未知记录');
    assert.equal(h.store.writeBlocked, false, '零成本任务领取unknown不应锁无关商城购买');
    const result = await h.store.execute('A', 'buy', { shopId: 5, goodsId: 10003, count: 1 }, { signature: 'fresh-offer' });
    assert.equal(result.ok, true);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  }
  finally { h.dispose(); }

  const recovery = ranchStoreHarness((_method, url) => Promise.resolve({ data: { ok: true, accountId: 'A', data: {
    pending: [row], scene: { phase: 'unknown', recoveryRequired: true },
    friendSession: { phase: 'idle', recoveryRequired: false },
  } } }));
  try {
    await recovery.store.fetchOperations('A');
    assert.equal(recovery.store.writeBlocked, true, '场景恢复状态unknown仍关闭所有牧场写');
  }
  finally { recovery.dispose(); }
});

test('ranch clear: 离页或清快照不释放在途写，迟到回复不恢复旧页面', async () => {
  const gate = deferred();
  const h = ranchStoreHarness(() => gate.promise);
  try {
    const write = h.store.execute('A', 'clean', {}, { signature: 'a' });
    h.store.clear();
    assert.equal(h.store.operating, true);
    assert.equal((await h.store.execute('A', 'clean', {}, { signature: 'a' })).sent, false);
    gate.resolve(ranchWriteResponse('A', 'clean'));
    assert.equal((await write).stale, true);
    assert.equal(h.store.notice, '');
    assert.equal(h.store.overview, null);
    assert.equal(h.store.operating, false);
  }
  finally { h.dispose(); }
});

test('ranch reads: 写入使旧目录回包失效，缺失/错误待核对响应不假报为空', async () => {
  const catalog = deferred(), write = deferred();
  const h = ranchStoreHarness((method, url) => method === 'POST' ? write.promise
    : url === '/api/ranch/catalog' ? catalog.promise : Promise.resolve({ data: { ok: true, accountId: 'A', data: {} } }));
  try {
    const read = h.store.fetchCatalog('A', 5);
    const run = h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    catalog.resolve({ data: { ok: true, accountId: 'A', data: { goods: [{ id: 111, name: 'old' }] } } });
    await read;
    assert.equal(h.store.catalogs[5], undefined);
    h.store.operations = [{ id: 'keep', target: 't', label: '待核对', costs: [], createdAt: 1, message: '保留' }];
    assert.equal((await h.store.fetchOperations('A')).ok, false);
    assert.equal(h.store.operations[0].id, 'keep');
    assert.match(h.store.operationsError, /未完整返回/);
    write.resolve(ranchWriteResponse('A'));
    await run;
  }
  finally { h.dispose(); }
});

test('ranch write failure: 错账号回包保持unknown，同步明确未发异常不残留flight', async () => {
  let count = 0;
  const h = ranchStoreHarness((method) => {
    if (method === 'GET') return Promise.resolve(ranchOperationsResponse('A'));
    count++;
    if (count === 1) throw Object.assign(new Error('not sent'), { sent: false, resultState: 'not_sent' });
    return Promise.resolve(ranchWriteResponse('wrong-account'));
  });
  try {
    const rejected = await h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    assert.equal(rejected.resultState, 'not_sent');
    assert.equal(h.store.operating, false);
    await h.store.fetchOperations('A');
    const wrong = await h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    assert.equal(wrong.outcomeUnknown, true);
    assert.equal(h.store.currentState, 'unknown');
    assert.equal(h.store.catalogs[5], undefined);
    assert.equal(count, 2);
  }
  finally { h.dispose(); }
});

test('ranch 4A reads: 背包A-B-A拒绝旧结果，罐头专区错误互不污染，缺桶字段不假成功', async () => {
  const old = deferred(), fresh = deferred(), slot6 = deferred();
  let bagReads = 0;
  const reply = name => ({ data: { ok: true, accountId: 'A', data: { readOnly: true, sceneId: 2,
    items: [{ id: '80021', uid: '9007199254740997', name, count: '3' }], goldVoucherBalance: '10000', pens: [], buckets: { normal: '100', organic: '200' } } } });
  const h = ranchStoreHarness((method, url, config) => {
    assert.equal(method, 'GET');
    if (url === '/api/ranch/bag') {
      bagReads++;
      return bagReads === 1 ? old.promise : bagReads === 2 ? fresh.promise
        : Promise.resolve({ data: { ok: true, accountId: 'A', data: { sceneId: 2, items: [], pens: [], buckets: {} } } });
    }
    return config.params.slotType === 6 ? slot6.promise
      : Promise.resolve({ data: { ok: true, accountId: 'A', data: { slotType: 7, goods: [{ id: 'organic', name: '有机罐头' }] } } });
  });
  try {
    const a = h.store.fetchBag('A');
    h.selected.value = 'B'; h.selected.value = 'A';
    const b = h.store.fetchBag('A');
    fresh.resolve(reply('new')); await b;
    old.resolve(reply('old')); await a;
    assert.equal(h.store.bagOverview.items[0].name, 'new');
    const six = h.store.fetchCanCatalog('A', 6);
    await h.store.fetchCanCatalog('A', 7);
    slot6.reject(new Error('专区六读取失败')); await six;
    assert.equal(h.store.canCatalogs[7][0].id, 'organic');
    assert.equal(h.store.canErrors[7] || '', '');
    assert.match(h.store.canErrors[6], /专区六/);
    await h.store.fetchBag('A');
    assert.match(h.store.bagError, /未确认/);
    assert.equal(h.store.bagOverview.items[0].name, 'new');
  }
  finally { h.dispose(); }
});

function ranchProgressResponse(accountId, section, patch = {}) {
  const base = { readOnly: true, sceneId: 2, ownerGid: '10010', observedAt: Date.now(), serverTimeMs: Date.now(), dateKey: '2026-11-18',
    cache: { hit: false, receivedAt: Date.now() } };
  const value = section === 'tasks' ? { tasks: [], summary: { total: 0, claimable: 0, claimed: 0, daily: 0 },
    guideReportingEnabled: false, automaticClaimEnabled: false }
    : section === 'book' ? { type: 101, animals: [], normal: { levels: [], rewards: [], canClaim: false }, giant: { totalScore: '0', levels: [] }, mutations: [] }
      : { shareId: '102', known: false, shareCount: null, claimed: null, canClaim: false, canReport: false,
        rewards: [{ id: '80021', count: '5', name: '普通罐头' }], automaticShareEnabled: false, stateReason: '标记未确认' };
  return { data: { ok: true, accountId, data: { ...base, ...value, ...patch } } };
}

test('ranch 4B reads: 任务A-B-A旧回包不回填，图鉴/分享错误独立，未知分享不是未领取', async () => {
  const old = deferred(), fresh = deferred(); let tasks = 0;
  const h = ranchStoreHarness((_method, url) => {
    if (url === '/api/ranch/tasks') return (++tasks === 1 ? old.promise : fresh.promise);
    if (url === '/api/ranch/book') return Promise.reject(new Error('图鉴临时读取失败'));
    return Promise.resolve(ranchProgressResponse('A', 'share'));
  });
  try {
    const first = h.store.fetchProgress('A', 'tasks');
    h.selected.value = 'B'; h.selected.value = 'A';
    const second = h.store.fetchProgress('A', 'tasks');
    fresh.resolve(ranchProgressResponse('A', 'tasks', { source: 'new' })); await second;
    old.resolve(ranchProgressResponse('A', 'tasks', { source: 'old' })); await first;
    assert.equal(h.store.progressViews.tasks.source, 'new');
    await h.store.fetchProgress('A', 'book'); await h.store.fetchProgress('A', 'share');
    assert.match(h.store.progressErrors.book, /图鉴/);
    assert.equal(h.store.progressErrors.share, '');
    assert.equal(h.store.progressViews.share.known, false);
    assert.equal(h.store.progressViews.share.claimed, null);
    assert.equal(h.store.progressLoading.tasks, false);
  }
  finally { h.dispose(); }
});

test('ranch 4B write: 旧专区读取在写入后失效，换页不释放pending，错操作回包保持unknown', async () => {
  const read = deferred(), write = deferred();
  const h = ranchStoreHarness(method => method === 'GET' ? read.promise : write.promise);
  try {
    const reading = h.store.fetchProgress('A', 'tasks');
    const operation = h.store.execute('A', 'claimTasks', { all: true }, { signature: 'tasks' });
    read.resolve(ranchProgressResponse('A', 'tasks')); await reading;
    assert.equal(h.store.progressViews.tasks, undefined);
    h.store.clear(); assert.equal(h.store.operating, true);
    write.resolve(ranchWriteResponse('A', 'harvest'));
    const result = await operation;
    assert.equal(result.stale, true);
    assert.equal(result.outcomeUnknown, true, '同账号但错动作也不能确认');
    assert.equal(h.store.writeBlocked, true);
    assert.equal(h.store.progressViews.tasks, undefined);
  }
  finally { h.dispose(); }
});

test('ranch 4B DTO: 错账号、农场图鉴类型和未知却可领取的分享状态均拒绝', async () => {
  for (const [section, response] of [
    ['tasks', ranchProgressResponse('B', 'tasks')],
    ['book', ranchProgressResponse('A', 'book', { type: 1 })],
    ['share', ranchProgressResponse('A', 'share', { canClaim: true })],
  ]) {
    const h = ranchStoreHarness(() => Promise.resolve(response));
    try {
      await h.store.fetchProgress('A', section);
      assert.equal(h.store.progressViews[section], undefined);
      assert.match(h.store.progressErrors[section], /未确认/);
    }
    finally { h.dispose(); }
  }
});

test('ranch last summary: 总概览只保留有归属的历史观察，写入标旧且不跨账号混用', async () => {
  const h = ranchStoreHarness((method, url, third, fourth) => {
    const config = method === 'GET' ? third : fourth;
    if (method === 'POST') return Promise.resolve(ranchWriteResponse('A'));
    if (url === '/api/ranch/operations') return Promise.resolve(ranchOperationsResponse(config.headers['x-account-id']));
    return Promise.resolve({ data: { ok: true, accountId: config.headers['x-account-id'], data: { readOnly: true, actionsEnabled: true,
      sceneId: 2, observedAt: 123, facilities: [], summary: { animalCount: 3, ranchCount: 1, harvestableCount: 1 } } } });
  });
  try {
    await h.store.fetchOverview('A'); h.store.clear();
    assert.equal(h.store.overview, null);
    assert.equal(h.store.lastSummaries.A.summary.animalCount, 3);
    assert.equal(h.store.lastSummaries.A.accountId, 'A');
    assert.equal(h.store.lastSummaries.A.stale, false);
    await h.store.fetchOperations('A');
    await h.store.execute('A', 'harvest', { all: true }, { signature: 'a' });
    assert.equal(h.store.lastSummaries.A.stale, true);
    h.selected.value = 'B';
    assert.equal(h.store.lastSummaries.B, undefined);
  }
  finally { h.dispose(); }
});

const navigationLinkStub = vue.defineComponent({ props: ['to'], setup: (props, { slots }) => () => vue.h('a', { href: props.to }, slots.default?.()) });

test('独立牧场名单：scene2结构校验、A-B-A与清页取消不回填旧名单', async () => {
  const requests = [];
  const h = ranchStoreHarness((_method, url, options) => { const pending = deferred(); requests.push({ url, options, pending }); return pending.promise; });
  const response = (id, name, sceneId = 2) => ({ data: { ok: true, accountId: id, data: { sceneId, ownerGid: '10010', observedAt: Date.now(),
    friends: [{ gid: 20001, name, avatarUrl: '' }] } } });
  try {
    const old = h.store.fetchFriends('A'); assert.equal(requests[0].url, '/api/ranch/friends');
    h.selected.value = 'B'; await vue.nextTick(); h.selected.value = 'A'; await vue.nextTick();
    const fresh = h.store.fetchFriends('A'); requests[1].pending.resolve(response('A', '牧场新昵称')); await fresh;
    requests[0].pending.resolve(response('A', '迟到旧昵称')); await old;
    assert.equal(h.store.friends[0].name, '牧场新昵称'); assert.equal(requests[0].options.signal.aborted, true);
    const bad = h.store.fetchFriends('A'); requests[2].pending.resolve(response('A', '农场名单', 1)); await bad;
    assert.equal(h.store.friends.length, 0); assert.match(h.store.friendsError, /未确认/);
    const leaving = h.store.fetchFriends('A'); h.store.clear(); requests[3].pending.resolve(response('A', '离页旧名单')); await leaving;
    assert.equal(h.store.friends.length, 0);
    assert.doesNotMatch(read('views/Ranch.vue'), /useFriendStore|friendStore\.fetchFriends/);
  } finally { h.dispose(); }
});

test('双工作区导航：农场恢复原页面与侧栏，牧场同名菜单对应独立业务路由', async () => {
  const h = frontendHarness({ 'vue-router': { RouterLink: navigationLinkStub } });
  const component = h.load('components/GameViewSwitch.vue').default;
  for (const [view, expected] of [['farm', '去牧场'], ['ranch', '回农场'], ['overview', '进入农场']]) {
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { view }) }));
    assert.match(html, new RegExp(expected)); assert.match(html, /href="\/(?:ranch)?"/);
  }
  const menu = h.load('router/menu.ts');
  assert.match(menu.menuRoutes[0].component.toString(), /Dashboard\.vue/);
  assert.equal(menu.menuRoutes[0].name, 'dashboard'); assert.equal(menu.menuRoutes[0].label, '概览');
  assert.equal(menu.menuRoutes.find(row => row.name === 'personal').showInNav, undefined);
  assert.match(menu.menuRoutes.find(row => row.name === 'personal').component.toString(), /Personal\.vue/);
  assert.ok(['宠物', '藏品', '变异宝典', '分析', '设置'].every(label => menu.menuRoutes.some(row => row.label === label)));
  assert.ok(!menu.menuRoutes.some(row => ['农场', '牧场'].includes(row.label)), '两个工作区不能作为普通菜单项');
  assert.deepEqual(Array.from(menu.ranchMenuRoutes, row => row.label), ['概览', '个人', '好友', '活动', '商城', '图鉴', '设置', '后台']);
  assert.deepEqual(Array.from(menu.ranchMenuRoutes.slice(0, 6), row => row.props.page), ['overview', 'personal', 'friends', 'activity', 'shop', 'illustrated']);
  assert.equal(new Set(menu.allMenuRoutes.map(row => row.path)).size, menu.allMenuRoutes.length);
  assert.equal(new Set(menu.allMenuRoutes.map(row => row.name)).size, menu.allMenuRoutes.length);
  for (const [path, expected] of [['/', '/ranch'], ['/personal', '/ranch/personal'], ['/friends', '/ranch/friends'], ['/ranch/shop', '/shop'], ['/settings', '/ranch/settings'], ['/ranch', '/'], ['/pet', '/ranch']])
    assert.equal(menu.workspaceSwitchPath({ path }), expected);
  assert.equal(menu.workspaceForRoute({ path: '/ranch/settings' }), 'ranch');
  assert.equal(menu.workspaceForRoute({ path: '/personal' }), 'farm');
  assert.match(read('router/index.ts'), /path: 'farm', name: 'farm', redirect: \{ name: 'personal' \}/);
  assert.match(read('router/index.ts'), /path: 'farm\/status', name: 'farm-status', redirect: \{ name: 'dashboard' \}/);
  assert.doesNotMatch(read('views/Personal.vue'), /farmPage|GameViewSwitch/);
  assert.match(read('views/Ranch.vue'), /:data-ranch-page="page"/);
  assert.match(read('components/Sidebar.vue'), /workspaceMenuRoutes\(workspace\.value\)/);
  assert.match(read('layouts/DefaultLayout.vue'), /workspace === 'farm' && route.name !== 'overview'/);
  assert.doesNotMatch(read('components/GameViewSwitch.vue'), /fetch\(|api\.|operate|setInterval|fetchOverview/);
});

test('移动端工作区顶部导航：账号菜单限宽、工作区按钮不抢占账号区域', () => {
  const layout = read('layouts/DefaultLayout.vue')
  const account = read('components/TopAccountMenu.vue')
  assert.match(layout, /gap-1 rounded-lg px-2 sm:gap-3 sm:px-4/)
  assert.match(layout, /class="shrink-0 whitespace-nowrap px-2 sm:px-3"/)
  assert.match(layout, /hidden min-\[380px\]:inline/)
  assert.match(account, /max-w-\[min\(42vw,220px\)\].*sm:max-w-\[min\(76vw,280px\)\]/)
  assert.match(account, /flex min-w-0 items-center gap-2/)
})

test('真实路由链接：去牧场与回农场保留href，未被BaseButton的undefined属性覆盖', async () => {
  const routing = webRequire('vue-router');
  const component = frontendHarness().load('components/GameViewSwitch.vue').default;
  const router = routing.createRouter({ history: routing.createMemoryHistory(), routes: [
    { path: '/', component: { render: () => null } }, { path: '/farm', component: { render: () => null } },
    { path: '/ranch', component: { render: () => null } },
  ] });
  await router.push('/'); await router.isReady();
  for (const [view, expected] of [['farm', '/ranch'], ['ranch', '/']]) {
    const app = vue.createSSRApp({ render: () => vue.h(component, { view }) }).use(router);
    const html = await renderer.renderToString(app);
    assert.ok(html.includes(`href="${expected}"`), html);
  }
});

async function ranchPageFixture(page, section = '', readonly = true, populated = true) {
  const h = ranchStoreHarness(() => assert.fail('页面初始化不允许未声明API'));
  const instance = pinia.createPinia(), calls = [], fixture = ranchVisualFixtures();
  const account = pinia.defineStore('ranch-page-account', () => ({ currentAccountId: h.selected, currentAccount: vue.ref({ name: '离线牧场账号' }) }))(instance);
  const friend = pinia.defineStore('ranch-page-friend', () => ({ friends: vue.ref([]), loading: vue.ref(false),
    async fetchFriends() { calls.push('friends'); } }))(instance);
  // This SSR fixture preserves preloaded presentation only. Real clear/flight
  // behavior is tested independently and by the actual browser build below.
  h.store.clear = () => {};
  if (populated) h.store.$patch({ overview: fixture.overview, bagOverview: fixture.bagOverview,
    friendOverview: fixture.friendOverview, progressViews: fixture.progressViews, catalogs: fixture.catalogs, canCatalogs: fixture.canCatalogs });
  if (populated) h.store.friends = [
    { gid: 700000002, name: '离线牧场好友', avatarUrl: '' },
    { gid: 700000003, name: '很长的好友昵称也要完整显示而不是藏进下拉框', avatarUrl: '' },
  ];
  h.store.fetchFriends = async () => { calls.push('friends'); };
  h.store.fetchOperations = async () => { calls.push('operations'); };
  h.store.fetchOverview = async () => { calls.push('overview'); };
  h.store.fetchBag = async () => { calls.push('bag'); };
  h.store.fetchCatalog = async (_id, shop) => { calls.push('catalog:' + shop); };
  h.store.fetchCanCatalog = async (_id, slot) => { calls.push('cans:' + slot); };
  h.store.fetchProgress = async (_id, target) => { calls.push('progress:' + target); };
  const routing = webRequire('vue-router'), menu = frontendHarness().load('router/menu.ts');
  const router = routing.createRouter({ history: routing.createMemoryHistory(), routes: menu.allMenuRoutes.map(row => ({
    path: '/' + row.path, component: { render: () => null }, meta: { gameWorkspace: row.workspace || 'farm' } })) });
  const pathname = page === 'overview' ? '/ranch' : '/ranch/' + page;
  await router.push({ path: pathname, query: section ? { section } : {} }); await router.isReady();
  const local = frontendHarness().load('config/localReadonly.ts');
  const render = frontendHarness({ '@/stores/account': { useAccountStore: () => account }, '@/stores/friend': { useFriendStore: () => friend },
    '@/stores/ranch': { useRanchStore: () => h.store, ranchItemLabel: id => String(id) },
    '@/stores/status': { useStatusStore: () => ({ async fetchStatus() { calls.push('status'); } }) },
    '@/stores/setting': { useSettingStore: () => ({ async fetchSettings() { calls.push('settings'); } }) },
    '@/api': { __esModule: true, default: { async get(path, options) {
      assert.equal(path, '/api/logs');
      assert.equal(options.params.module, 'ranch');
      assert.equal(options.params.accountId, h.selected.value);
      calls.push('ranch-logs');
      return { data: { ok: true, data: [] } };
    } } },
    '@/config/localReadonly': { LOCAL_UI_READONLY: readonly, accountDataEmptyState: local.accountDataEmptyState } });
  try {
    const component = render.load('views/Ranch.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { page }) }).use(instance).use(router));
    await Promise.resolve(); return { html, calls };
  } finally { h.dispose(); pinia.disposePinia(instance); }
}

test('牧场独立页面SSR：商城目录/罐头不再藏在个人概览中，单页不伪装成八个顶级标签', async () => {
  const catalog = await ranchPageFixture('shop', 'catalog');
  assert.match(catalog.html, /幼崽与饲料/); assert.match(catalog.html, /豪猪/); assert.match(catalog.html, /价格：1005/);
  assert.doesNotMatch(catalog.html, /场景概况|手动操作|成长手册与每日任务/); assert.equal(catalog.calls.length, 0);
  const cans = await ranchPageFixture('shop', 'cans'); assert.match(cans.html, /离线罐头商品/); assert.equal(cans.calls.length, 0);
  const friends = await ranchPageFixture('friends'); assert.match(friends.html, /好友列表/); assert.match(friends.html, /离线牧场好友/); assert.doesNotMatch(friends.html, /role="tablist"|<select/);
  const personal = await ranchPageFixture('personal', 'bag'); assert.match(personal.html, /牧场背包与补给/);
  assert.equal((personal.html.match(/role="tab"/g) || []).length, 4); assert.doesNotMatch(personal.html, /仓鼠集市|牧場活动目录/);
});

test('共享数字格式对牧场金券采用农场紧凑位数且保留int64整数精度', () => {
  const formatter = frontendHarness().load('utils/number-format.ts');
  assert.equal(formatter.formatCurrencyAmountByLabel('123456789', '金券'), '1.23亿');
  assert.equal(formatter.formatIntegerAmount('987654321012345678'), '987,654,321,012,345,678');
  assert.equal(formatter.formatCurrencyAmountByLabel('123456789', '金币'), '1.23亿');
  assert.equal(formatter.formatCurrencyAmountByLabel('987654321012345678', '金券'), '9,876,543,210.12亿');
});

test('牧场概览使用三张账号与资源卡及日志和统计双栏，不展示内部实现声明', async () => {
  const overview = await ranchPageFixture('overview');
  assert.match(overview.html, /账号资源/);
  assert.doesNotMatch(overview.html, /农场 Lv\.|农场等级未读取/);
  assert.match(overview.html, /金券/);
  assert.match(overview.html, /1\.23亿/);
  assert.match(read('views/Ranch.vue'), /读取失败 · 重试/);
  assert.match(read('views/Ranch.vue'), /bagError/);
  assert.doesNotMatch(overview.html, />金币</);
  assert.match(overview.html, /牧场等级/);
  assert.match(overview.html, /Lv\.12/);
  assert.match(overview.html, /牧草机存量/);
  assert.match(read('views/Ranch.vue'), /bagOverview\?\.level \? `Lv\.\$\{bagOverview\.level\.level\}`/);
  assert.match(overview.html, /md:w-3\/4[^>]+运行日志/);
  assert.match(overview.html, /md:w-1\/4[^>]+牧场检查与统计/);
  assert.match(overview.html, /检查间隔/);
  assert.match(overview.html, /今日统计/);
  assert.doesNotMatch(overview.html, /快捷入口|牧场设施/);
  assert.match(overview.html, /metric-card/);
  assert.equal((overview.html.match(/min-h-\[168px\]/g) || []).length, 3);
  assert.doesNotMatch(overview.html, /操作与场景安全说明|scene2|逐次报价|连续重试|手动操作/);
  assert.equal(overview.calls.length, 0);
  const personal = await ranchPageFixture('personal', 'home');
  assert.match(personal.html, /手动操作/);
});

test('牧场好友直接列出并搜索，点击按需展开且同步清旧详情，绝不批量读取', async () => {
  const page = await ranchPageFixture('friends');
  assert.match(page.html, /aria-label="牧场好友列表"/);
  assert.match(page.html, /离线牧场好友/);
  assert.equal((page.html.match(/class="ranch-friend-row/g) || []).length, 2);
  assert.doesNotMatch(page.html, /<select|不会用农场名单|确认进入|来源与哈希/);
  assert.equal(page.calls.length, 0);
  const source = read('views/Ranch.vue'), selectedFriendGid = vue.ref(null), friendLoading = vue.ref(false), operating = vue.ref(false);
  const friends = vue.ref([{ gid: 1, name: '好友甲' }, { gid: 2, name: 'Beta好友' }]), order = [];
  const stop = vue.watch(selectedFriendGid, () => order.push('clear'), { flush: 'sync' });
  const context = { ref: vue.ref, computed: vue.computed, friends, selectedFriendGid, friendLoading, operating,
    currentAccountId: vue.ref('A'), friendsLoading: vue.ref(false), friendsError: vue.ref(''), LOCAL_UI_READONLY: false,
    loadFriendRanch: async () => order.push('read:' + selectedFriendGid.value), ranchStore: { async fetchFriends() { order.push('roster'); } } };
  const code = source.slice(source.indexOf('const friendSearch ='), source.indexOf('const manualReviewError ='))
    + source.slice(source.indexOf('async function selectRanchFriend'), source.indexOf('async function selectCatalog'));
  const result = vm.runInNewContext(ts.transpileModule(code + '\n;({ friendSearch, filteredRanchFriends, selectRanchFriend })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  try {
    result.friendSearch.value = 'BETA'; assert.equal(result.filteredRanchFriends.value[0].gid, 2);
    result.friendSearch.value = '1'; assert.equal(result.filteredRanchFriends.value[0].gid, 1);
    await result.selectRanchFriend(1); await result.selectRanchFriend(2); await result.selectRanchFriend(2);
    assert.deepEqual(order, ['clear', 'read:1', 'clear', 'read:2', 'clear']);
    await result.selectRanchFriend(999); assert.equal(order.length, 5);
    context.LOCAL_UI_READONLY = true; await result.selectRanchFriend(1);
    assert.deepEqual(order, ['clear', 'read:1', 'clear', 'read:2', 'clear', 'clear']);
  } finally { stop(); }
});

test('牧场界面诊断只写账号内存日志，去重有界、跨切页保留，不改变未知保护', () => {
  const h = ranchStoreHarness(() => assert.fail('记录诊断不得发请求'));
  try {
    h.store.operationStates.A = 'unknown';
    h.store.appendInterfaceLog('A', 'ranch_ui_read', '读取失败 ?token=secret');
    h.store.appendInterfaceLog('A', 'ranch_ui_read', '读取失败 ?token=secret');
    assert.equal(h.store.interfaceLogs.length, 1);
    assert.doesNotMatch(h.store.interfaceLogs[0].msg, /secret/);
    h.store.clear(); assert.equal(h.store.interfaceLogs.length, 1);
    assert.equal(h.store.currentState, 'unknown'); assert.equal(h.store.writeBlocked, true);
    h.selected.value = 'B'; assert.equal(h.store.interfaceLogs.length, 0);
    h.store.appendInterfaceLog('A', 'ranch_ui_read', '旧账号迟到错误'); assert.equal(h.store.interfaceLogs.length, 0);
    h.store.appendInterfaceLog('B', 'ranch_ui_read', 'B读取失败'); assert.equal(h.store.interfaceLogs.length, 1);
    for (let i = 0; i < 120; i++) h.store.appendInterfaceLog('B', 'ranch_ui_read', '错误' + i);
    assert.equal(h.store.interfaceLogs.length, 100); assert.equal(h.calls.length, 0);
    h.selected.value = 'A'; assert.equal(h.store.interfaceLogs.length, 1); assert.equal(h.store.currentState, 'unknown');
  } finally { h.dispose(); }
  const source = read('views/Ranch.vue'), template = source.slice(source.indexOf('<template>'), source.indexOf('<style scoped>'));
  assert.doesNotMatch(template, /ranch-error|ranch-notice|ranch-pending|role="alert"|本账号牧场结果或离场状态未确认/);
  assert.match(source, /appendInterfaceLog\?\.\(accountId, 'ranch_ui_pending'/);
  const diagnosticObserver = source.slice(source.indexOf('// 诊断只进入当前账号'), source.indexOf('watch(selectedFriendGid'));
  assert.doesNotMatch(diagnosticObserver, /routineState\.value\?\.lastError/, '后端巡查暂停不能重复伪装成界面读取错误');
  assert.match(source, /\.\.\.\(ranchStore.interfaceLogs \|\| \[\]\)/);
});

test('牧场日志与农场同款紧凑排版、模块/事件徽标及双列统计，不更改读取契约', async () => {
  const source = read('views/Ranch.vue');
  const farm = read('views/Dashboard.vue');
  const code = source.slice(source.indexOf('function ranchLogTagClass'), source.indexOf('async function readRanchLogs'));
  const helpers = vm.runInNewContext(ts.transpileModule(code + '\n;({ ranchLogTagClass, ranchLogEventLabel })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  const farmTag = farm.slice(farm.indexOf('function getLogTagClass'), farm.indexOf('function getLogMsgClass'));
  const getFarmClass = vm.runInNewContext(ts.transpileModule(farmTag + '\n;getLogTagClass',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  for (const tag of ['牧场', '系统', '活动', '错误']) assert.equal(helpers.ranchLogTagClass({ tag }), getFarmClass(tag));
  assert.match(helpers.ranchLogTagClass({ tag: '牧场', isWarn: true }), /bg-orange/);
  assert.match(helpers.ranchLogTagClass({ tag: '牧场', meta: { result: 'unknown' } }), /bg-orange/);
  assert.equal(helpers.ranchLogEventLabel('ranch_harvest'), '收获');
  assert.equal(helpers.ranchLogEventLabel('ranch_patrol_paused'), '巡查暂停');
  assert.equal(helpers.ranchLogEventLabel('unrecognized_event'), 'unrecognized_event');
  assert.match(source, /ranch-log-list[^\n]+text-sm leading-relaxed font-mono/);
  assert.match(source, /\[\{\{ ranchLogTime\(entry\) \}\}\]/);
  assert.match(source, /ranchLogTagClass\(entry\)/);
  assert.match(source, /ranchLogEventLabel\(entry.meta.event\)/);
  const logMarkup = source.slice(source.indexOf('aria-label="运行日志"'), source.indexOf('aria-label="牧场检查与统计"'));
  assert.doesNotMatch(logMarkup, /divide-y|py-2\.5/);
  const overview = await ranchPageFixture('overview');
  assert.match(overview.html, /下次检查倒计时/);
  assert.match(overview.html, /ranch-countdown[^>]*font-mono/);
  assert.equal((overview.html.match(/ranch-stat-tile/g) || []).length, 5);
  assert.match(overview.html, /grid grid-cols-2 gap-2 2xl:gap-3/);
  assert.equal(overview.calls.length, 0);
});

test('牧场调度展示依据真实期限，未知/过期快照不伪装倒计时，近100条统计跨日更新', () => {
  const source = read('views/Ranch.vue');
  const code = source.slice(source.indexOf('const savedAutomation ='), source.indexOf('function logTimestamp'));
  const now = new Date(2026, 10, 21, 12).getTime();
  class TestDate extends Date { static now() { return now; } }
  const currentAccountId = vue.ref('A'), currentState = vue.ref('idle'), operations = vue.ref([]);
  const panelStatus = vue.ref({ automation: { ranch: true }, ranchAutomation: { enabled: true, running: false,
    farmMin: 2, farmMax: 5, nextCheckAt: now + 67000, lastStartedAt: now - 10000, lastFinishedAt: now - 5000, lastResult: 'confirmed' } });
  const presentation = vue.ref({ kind: 'online' });
  const settingStore = { settingsAccountId: 'A', readError: '', confirmedAutomation: { ranch: false } };
  const readableLogs = vue.ref({ readAt: now });
  const ranchLogEntries = vue.ref([
    { ts: now, meta: { event: 'ranch_harvest', result: 'ok' } },
    { ts: now, meta: { event: 'ranch_harvest', result: 'unknown' } },
    { ts: now - 86400000, meta: { event: 'ranch_harvest', result: 'ok' } },
    { ts: now, meta: { event: 'ranch_friend_stroke', result: 'ok' } },
    { ts: now, meta: { event: 'ranch_patrol_complete', result: 'idle' } },
    { ts: now, meta: { event: 'ranch_patrol_paused', result: 'unknown' } },
  ]);
  const result = vm.runInNewContext(ts.transpileModule(code + '\n;({ savedAutomation, ranchCycleText, ranchRoutineText, ranchCountdownText, ranchTodayStats, routineClock })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { computed: vue.computed, ref: vue.ref, panelStatus, currentAccountId, currentState, operations, presentation, settingStore,
      readableLogs, ranchLogEntries, Date: TestDate, logTimestamp: entry => entry.ts });
  assert.equal(result.savedAutomation.value.ranch, true, '状态接口的已生效开关优先于旧设置快照');
  assert.equal(result.ranchCycleText.value, '2–5 秒（同农场）');
  assert.equal(result.ranchCountdownText.value, '00:01:07');
  result.routineClock.value = now + 60000;
  assert.equal(result.ranchCountdownText.value, '00:00:07');
  result.routineClock.value = now + 67000;
  assert.equal(result.ranchCountdownText.value, '等待调度', '到期不是已执行证据');
  panelStatus.value.ranchAutomation.running = true;
  assert.equal(result.ranchCountdownText.value, '巡查中');
  assert.equal(result.ranchRoutineText.value, '巡查中');
  for (const kind of ['error', 'stale', 'stopped', 'offline', 'readonly', 'unknown']) {
    presentation.value.kind = kind;
    assert.equal(result.ranchCountdownText.value, '—', kind);
    assert.equal(result.ranchRoutineText.value, '—', kind);
  }
  presentation.value.kind = 'online'; panelStatus.value.ranchAutomation.running = false;
  currentState.value = 'unknown';
  assert.equal(result.ranchRoutineText.value, '安全状态待核对'); assert.equal(result.ranchCountdownText.value, '—');
  currentState.value = 'pending'; assert.equal(result.ranchCountdownText.value, '操作中');
  currentState.value = 'idle'; panelStatus.value.ranchAutomation.lastResult = 'unknown';
  assert.equal(result.ranchCountdownText.value, '—');
  panelStatus.value.ranchAutomation.lastResult = 'error';
  assert.equal(result.ranchRoutineText.value, '等待巡查');
  panelStatus.value.ranchAutomation.enabled = false; assert.equal(result.ranchCountdownText.value, '未安排巡查');
  assert.equal(result.ranchTodayStats.value[0].count, 1); assert.equal(result.ranchTodayStats.value[4].count, 1);
  result.routineClock.value = now + 86400000;
  assert.equal(result.ranchTodayStats.value[0].count, 0, '跨日不能继续显示昨天的成功记录');
  panelStatus.value = null; assert.equal(result.ranchCountdownText.value, '—');
  settingStore.settingsAccountId = 'B'; assert.equal(result.savedAutomation.value, null);
  assert.match(source, /下次检查/); assert.match(source, /routineState\.lastFinishedAt/);
  assert.match(source, /近100条日志中的今日成功记录/);
});

test('牧场概览日志与定时器：A-B-A取消旧读取、隐藏页无额外读取、倒计时不发RPC且卸载清理', async () => {
  const source = read('views/Ranch.vue');
  const code = source.slice(source.indexOf('async function readRanchLogs'), source.indexOf('function itemKey'));
  const cleanup = source.slice(source.indexOf('onBeforeUnmount(() => {'), source.indexOf('</script>'));
  const pending = [], timers = new Map(), mounted = [], unmounted = [];
  let timerId = 0, statusReads = 0, cleared = 0, now = 1000;
  class TestDate extends Date { static now() { return now; } }
  const props = vue.reactive({ page: 'overview' }), currentAccountId = vue.ref('A'), document = { hidden: false };
  const logSnapshot = vue.ref(null), logLoading = vue.ref(false), logError = vue.ref(false), routineClock = vue.ref(now);
  const context = { AbortController, Date: TestDate, props, currentAccountId, document, logSnapshot, logLoading, logError, routineClock,
    LOCAL_UI_READONLY: false, ref: vue.ref, computed: vue.computed, statusStore: { async fetchStatus() { statusReads++; } }, settingStore: { async fetchSettings() {} },
    ranchStore: { clear() { cleared++; } }, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => unmounted.push(fn),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearInterval: id => timers.delete(id),
    api: { get(url, options) { const gate = deferred(); pending.push({ url, options, gate }); return gate.promise; } } };
  const result = vm.runInNewContext(ts.transpileModule('let logRequest;\n' + code + cleanup + '\n;({ readRanchLogs, resetRanchLogs })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  mounted[0](); assert.equal(timers.size, 2);
  const clockTick = [...timers.values()].find(timer => timer.delay === 1000).fn;
  const readTick = [...timers.values()].find(timer => timer.delay === 15000).fn;
  now = 2000; clockTick(); assert.equal(routineClock.value, now); assert.equal(pending.length, 0); assert.equal(statusReads, 0);
  document.hidden = true; readTick(); clockTick();
  await result.readRanchLogs('A'); assert.equal(pending.length, 0); assert.equal(statusReads, 0);
  document.hidden = false; props.page = 'personal'; readTick(); await result.readRanchLogs('A');
  assert.equal(pending.length, 0); assert.equal(statusReads, 0);
  props.page = 'overview'; await result.readRanchLogs('B'); assert.equal(pending.length, 0);
  const first = result.readRanchLogs('A');
  assert.equal(pending[0].options.headers['x-account-id'], 'A');
  assert.equal(pending[0].options.params.accountId, 'A'); assert.equal(pending[0].options.params.module, 'ranch');
  assert.equal(pending[0].options.params.limit, 100);
  currentAccountId.value = 'B'; result.resetRanchLogs(); currentAccountId.value = 'A';
  const second = result.readRanchLogs('A');
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].gate.resolve({ data: { ok: true, data: [{ msg: '新日志' }] } }); await second;
  pending[0].gate.resolve({ data: { ok: true, data: [{ msg: '旧日志' }] } }); await first;
  assert.equal(logSnapshot.value.entries[0].msg, '新日志'); assert.equal(logLoading.value, false);
  const failing = result.readRanchLogs('A'); pending[2].gate.reject(new Error('当前日志异常')); await failing;
  assert.equal(logError.value, true); assert.equal(logSnapshot.value.entries[0].msg, '新日志');
  const leaving = result.readRanchLogs('A'); unmounted[0]();
  assert.equal(timers.size, 0); assert.equal(pending[3].options.signal.aborted, true); assert.equal(cleared, 1);
  pending[3].gate.reject(new Error('离页后的旧异常')); await leaving;
  assert.equal(logSnapshot.value, null); assert.equal(logError.value, false); assert.equal(logLoading.value, false);
});

test('牧场页面初始化按所属功能读取，商城/图鉴/活动不顺带读取概览或其他业务', async () => {
  for (const [page, section, expected] of [['overview', '', 'overview'], ['personal', 'bag', 'bag'], ['personal', 'tasks', 'progress:tasks'],
    ['personal', 'share', 'progress:share'], ['friends', '', 'friends'], ['shop', '', 'catalog:5'], ['shop', 'cans', 'cans:6'],
    ['shop', 'market', 'progress:market'], ['activity', '', 'progress:activities'], ['illustrated', '', 'progress:book']]) {
    const value = await ranchPageFixture(page, section, false, false);
    assert.deepEqual(value.calls, page === 'overview' ? ['operations', 'status', 'settings', 'ranch-logs', 'bag', expected] : ['operations', expected], `${page}/${section} 不得读隐藏页面`);
  }
});

test('工作区加载控制器：路由绘制与插画结束双确认，迟到事件/取消/卸载不能解除新加载', () => {
  let completed = 0;
  const controller = frontendHarness().load('composables/useContentMotion.ts').createWorkspaceTravel(() => { completed++; });
  controller.begin(1, 'ranch', '/ranch'); controller.arrived(1);
  assert.equal(controller.active.value.painted, false); assert.equal(completed, 0);
  controller.painted(1, '/wrong'); assert.equal(completed, 0);
  controller.painted(1, '/ranch'); assert.equal(controller.active.value, null); assert.equal(completed, 1);
  controller.begin(2, 'farm', '/'); controller.painted(2, '/'); controller.arrived(1);
  assert.equal(controller.active.value.arrived, false); controller.cancel(); controller.arrived(2); assert.equal(completed, 1);
  controller.begin(3, 'ranch', '/ranch/shop'); controller.begin(4, 'farm', '/shop');
  controller.arrived(3); controller.painted(3, '/ranch/shop'); assert.equal(controller.active.value.id, 4);
  controller.painted(4, '/shop'); controller.arrived(4); assert.equal(completed, 2);
  controller.dispose(); controller.begin(5, 'ranch', '/ranch'); assert.equal(controller.active.value, null);
  const layout = read('layouts/DefaultLayout.vue'), overlay = read('components/WorkspaceTravelOverlay.vue');
  assert.match(layout, /router.beforeResolve\(async[\s\S]*travelController.begin/);
  assert.match(layout, /:inert="workspaceTravel \? true : undefined"/); assert.match(layout, /travelController\.dispose\(\)/);
  assert.match(overlay, /emit\('arrived', props.requestId\)/); assert.match(overlay, /prefers-reduced-motion/);
  assert.match(overlay, /workspace-cart-body/); assert.match(overlay, /workspace-wheel-hub/);
  assert.match(overlay, /workspace-child-bob/); assert.match(overlay, /cubic-bezier\(\.22,\.72,\.28,1\)/);
  assert.doesNotMatch(overlay, /setInterval|setTimeout|api\.|fetch\(|operate|gameRpc/);
});

test('总概览：不主动切换牧场场景，加载账号状态并展示资源、动态与异常入口', async () => {
  const instance = pinia.createPinia();
  const account = pinia.defineStore('overview-account-fixture', () => ({ currentAccountId: vue.ref('A'), currentAccount: vue.ref({ id: 'A', name: '账号A' }) }))(instance);
  const status = pinia.defineStore('overview-status-fixture', () => ({ status: vue.ref(null), currentStatusReady: vue.ref(false),
    currentStatusMetadata: vue.ref(null), currentStatusStale: vue.ref(false), loading: vue.ref(false), error: vue.ref(''),
    logs: vue.ref([]), accountLogs: vue.ref([]), fetchStatus: async () => {} }))(instance);
  const ranch = pinia.defineStore('overview-ranch-fixture', () => ({
    operations: vue.ref(Array.from({ length: 10 }, (_, index) => ({ id: `record-${index}`, label: '普通领取牧场任务', target: `ranch:claimTasks:${300011 + index}` }))),
    operationsReady: vue.ref(true), operationsLoading: vue.ref(false), operationsError: vue.ref(''),
    fetchOperations: async () => ({ ok: true, safe: true }),
  }))(instance);
  const h = frontendHarness({ '@/stores/account': { useAccountStore: () => account }, '@/stores/status': { useStatusStore: () => status },
    '@/stores/ranch': { useRanchStore: () => ranch }, '@/config/localReadonly': { LOCAL_UI_READONLY: false }, 'vue-router': { RouterLink: navigationLinkStub } });
  try {
    const component = h.load('views/Overview.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component) }));
    assert.match(html, /总概览/); assert.match(html, /10 条待核对/); assert.match(html, /普通领取牧场任务/);
    assert.match(html, /最近动态/); assert.match(html, /账户资源/); assert.match(html, /查看记录/);
    assert.doesNotMatch(html, /牧场操作保护|无本地在途写|保留原有经营与状态页面|同一套交互风格|总概览不主动切换游戏场景/);
    const source = read('views/Overview.vue');
    assert.match(source, /fetchStatus/); assert.match(source, /fetchOperations/);
    assert.doesNotMatch(source, /fetchOverview|fetchBag|fetchProgress|setInterval|connectRealtime|api\./);
  }
  finally { pinia.disposePinia(instance); }
});

test('4B分享SSR：没有102标记时两种写按钮均禁用，不展示已领取或未领取推断', async () => {
  const h = ranchStoreHarness(() => Promise.reject(new Error('不允许渲染发请求')));
  h.store.progressViews = { share: ranchProgressResponse('A', 'share').data.data };
  const render = frontendHarness({ '@/stores/ranch': { useRanchStore: () => h.store,
    ranchItemLabel: id => `物品#${id}` } });
  try {
    const component = render.load('components/RanchProgressPanel.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { section: 'share' }) }));
    assert.match(html, /保持未确认|保持未确认|未确认/);
    assert.doesNotMatch(html, /服务端没有返回牧场分享标记|ui-notice|progress-error/);
    assert.doesNotMatch(html, /今日已领取/);
    assert.match(html, /disabled/);
    assert.equal(h.calls.length, 0);
  }
  finally { h.dispose(); }
});

test('仓鼠集市只禁用冲突余额的购买，其他商品保持可购买并说明安全锁原因', async () => {
  const h = ranchStoreHarness(() => assert.fail('本用例只验证已加载集市的渲染'));
  h.store.clear = () => {};
  h.store.operations = [{ id: 'pending-buy', target: 'ranch:buy:9001', label: '购买商品', costs: [
    { resourceKey: 'item:1005', amount: '50' }], createdAt: 1, message: 'unknown' }];
  h.store.progressViews = { market: { readOnly: true, sceneId: 2, ownerGid: 'gid', observedAt: Date.now(), dateKey: '2026-11-23',
    serverTimeMs: Date.now(), shopId: 7, opened: true, present: true, periodDay: '20261123', roundIndex: 1,
    shelves: [], automaticExchangeEnabled: false, cache: { hit: false, receivedAt: Date.now() },
    goods: [
      { id: '9001', shelfId: 1, slot: 0, name: '金豆商品', reward: { id: '80021', count: '1', image: '', name: '罐头' },
        currencyId: '1005', currencyName: '金豆豆', currencyImage: '', unitPrice: '50', currencyBalance: '1000',
        remaining: '5', maxCount: 5, limitUsed: '0', available: true, discounted: false, priceValidUntilMs: null, requiredLevel: null, stateReason: '' },
      { id: '9002', shelfId: 1, slot: 1, name: '松果商品', reward: { id: '80031', count: '1', image: '', name: '有机罐头' },
        currencyId: '1008', currencyName: '松果币', currencyImage: '', unitPrice: '50', currencyBalance: '1000',
        remaining: '5', maxCount: 5, limitUsed: '0', available: true, discounted: false, priceValidUntilMs: null, requiredLevel: null, stateReason: '' },
    ] } };
  const render = frontendHarness({ '@/stores/ranch': { useRanchStore: () => h.store } });
  try {
    const component = render.load('components/RanchMarketPanel.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { section: 'market', accountId: 'A' }) }));
    assert.match(html, /有购买结果待核对，且使用相同余额/);
    const cards = [...html.matchAll(/<article[\s\S]*?<\/article>/g)].map(match => match[0]);
    assert.equal(cards.length, 2);
    assert.match(cards[0], /disabled/);
    assert.match(cards[1], /购买/);
    assert.doesNotMatch(cards[1], /disabled/);
  }
  finally { h.dispose(); }
});

function marketResponse(accountId, patch = {}) {
  return { data: { ok: true, accountId, data: { readOnly: true, sceneId: 2, ownerGid: '10010', observedAt: Date.now(),
    dateKey: '2026-11-18', serverTimeMs: Date.now(), shopId: 7, opened: true, present: true, periodDay: '20261118', roundIndex: 0,
    shelves: [], goods: [], automaticExchangeEnabled: false, cache: { hit: false }, ...patch } } };
}

test('4C前端：集市A-B-A旧回复不回填，错卡结构与活动详情归属拒绝', async () => {
  const old = deferred(), fresh = deferred(); let count = 0;
  const h = ranchStoreHarness((_method, url) => url === '/api/ranch/market' ? (++count === 1 ? old.promise : fresh.promise)
    : Promise.resolve({ data: { ok: true, accountId: 'A', data: { readOnly: true, sceneId: 2, ownerGid: '10010',
      observedAt: Date.now(), dateKey: '2026-11-18', actionsEnabled: false, activities: [], guide: {}, detail: { id: 'wrong' } } } }));
  try {
    const first = h.store.fetchProgress('A', 'market'); h.selected.value = 'B'; h.selected.value = 'A';
    const second = h.store.fetchProgress('A', 'market'); fresh.resolve(marketResponse('A', { stamp: 'new' })); await second;
    old.resolve(marketResponse('A', { stamp: 'old' })); await first;
    assert.equal(h.store.progressViews.market.stamp, 'new');
    await h.store.fetchProgress('A', 'activities', '12345');
    assert.equal(h.store.progressViews.activities, undefined);
    assert.match(h.store.progressErrors.activities, /未确认/);
    assert.equal(h.calls.at(-1).config.params.groupId, '12345');
  }
  finally { h.dispose(); }
  const bad = ranchStoreHarness(() => Promise.resolve(marketResponse('A', { goods: [{ id: '1', unitPrice: 'NaN' }] })));
  try { await bad.store.fetchProgress('A', 'market'); assert.equal(bad.store.progressViews.market, undefined); }
  finally { bad.dispose(); }
});

test('4C前端写：兑换在途跨页不解除，旧集市读不能在写后回填', async () => {
  const read = deferred(), write = deferred();
  const h = ranchStoreHarness(method => method === 'GET' ? read.promise : write.promise);
  try {
    const reading = h.store.fetchProgress('A', 'market');
    const operation = h.store.execute('A', 'exchange', { goodsId: '9007199254740997', count: 1 }, { signature: 'offer' });
    read.resolve(marketResponse('A')); await reading;
    assert.equal(h.store.progressViews.market, undefined);
    h.store.clear(); assert.equal(h.store.operating, true);
    write.resolve(ranchWriteResponse('A', 'exchange')); assert.equal((await operation).stale, true);
    assert.equal(h.store.progressViews.market, undefined);
  }
  finally { h.dispose(); }
});

test('4C视图SSR：官方图源原URL保留，活动未确认不显示完成或产生写请求', async () => {
  const picture = await renderComponent('components/RanchItemImage.vue', { src: '/game-config/ranch/item-icons/60013.png', alt: '豪猪' });
  assert.match(picture, /src="\/game-config\/ranch\/item-icons\/60013\.png"/);
  const h = ranchStoreHarness(() => Promise.reject(new Error('渲染不得发请求')));
  h.store.progressViews = { activities: { activities: [{ id: '1234', name: '牧歌初启', beginTimeMs: null, endTimeMs: null,
    children: [], actionsEnabled: false, progressState: 'unconfirmed' }], actionsEnabled: false, detail: null,
    notice: '具体进度尚未核验', serverTimeMs: Date.now(), observedAt: Date.now(),
    guide: { title: '牧歌初启', description: '公告不是账号进度', bulletinId: 26111702, sections: [], notice: '未自动领取' } } };
  const render = frontendHarness({ '@/stores/ranch': { useRanchStore: () => h.store } });
  try {
    const component = render.load('components/RanchMarketPanel.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { section: 'activities' }) }));
    assert.match(html, /时间未确认/); assert.doesNotMatch(html, /具体领奖进度未核验|状态未确认|领奖进度未确认/);
    assert.doesNotMatch(html, /全部已领取|已完成全部/); assert.equal(h.calls.length, 0);
    h.store.progressViews.activities.activities[0].beginTimeMs = Date.now() - 1000;
    h.store.progressViews.activities.activities[0].endTimeMs = Date.now() + 60000;
    h.store.progressViews.activities.serverTimeMs = undefined;
    const noClock = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { section: 'activities' }) }));
    assert.match(noClock, /时间未确认/); assert.doesNotMatch(noClock, /活动时间内/);
  }
  finally { h.dispose(); }
});

test('牧场活动SSR展示牧歌四分区、真实进度与已确认操作入口，不在渲染期发请求', async () => {
  const h = ranchStoreHarness(() => assert.fail('SSR不得读取活动或提交领奖'));
  const root = { id: '2026111700', name: '牧歌初启', children: [], beginTimeMs: Date.now() - 1000, endTimeMs: Date.now() + 60000 };
  const muge = { activityId: '2026111700', title: '牧歌初启', serverTime: Date.now(), startTime: Date.now() - 1000,
    endTime: Date.now() + 60000, active: true, rules: [], sections: {},
    celebration: { total: '100', tiers: [{ id: '1', threshold: '50', status: 2, rewards: [{ id: '7001', count: '1', name: '牧草', image: '' }] }] },
    friends: { count: 3, tiers: [] }, handbook: { points: '10', tiers: [], tasks: [] },
    personality: { answers: {}, personalityId: '0', settleCount: '0', image: '', shareRewardClaimed: false },
    questions: [{ id: 1, title: '你一般什么时候上线玩农场？', options: [{ value: 1, text: '睁眼就开始玩', label: 'A' }] }] };
  h.store.progressViews = { activities: { activities: [root], detail: root, actionsEnabled: false, guide: {}, muge,
    serverTimeMs: Date.now(), observedAt: Date.now() } };
  const render = frontendHarness({ '@/stores/ranch': { useRanchStore: () => h.store } });
  try {
    const component = render.load('components/RanchMarketPanel.vue').default;
    const html = await renderer.renderToString(vue.createSSRApp({ render: () => vue.h(component, { section: 'activities', accountId: 'A' }) }));
    for (const title of ['兴牧庆典', '牧友同行', '成长手册', '牧场人格']) assert.match(html, new RegExp(title));
    assert.match(html, /全服累计饲养/);
    assert.match(html, /100 只/);
    assert.match(html, /领取 1 档奖励/);
    const panelSource = read('components/RanchMugeActivityPanel.vue');
    assert.match(panelSource, /领取按钮已锁定/);
    assert.match(panelSource, /活动当前不在可操作时间/);
    assert.match(panelSource, /自动领取：/);
    assert.match(panelSource, /具体奖励是否到账以各档状态显示“已领取”为准/);
    assert.match(panelSource, /question\.title/);
    assert.match(panelSource, /queuedAnswers = new Map/);
    assert.match(panelSource, /while \(queuedAnswers\.size/);
    assert.match(panelSource, /blockedUnknownAccount/);
    assert.match(panelSource, /aria-label="牧歌初启活动分区"/);
    assert.doesNotMatch(panelSource.match(/<nav[^>]*aria-label="牧歌初启活动分区"[\s\S]*?<\/nav>/)?.[0] || '', /disabled/);
    assert.match(panelSource, /saveAnswers/);
    assert.match(read('components/RanchMugeActivityPanel.vue'), /startRetake/);
    assert.match(read('views/Ranch.vue'), /activityReadOnlyReason/);
    assert.match(read('views/Ranch.vue'), /ranch_activity_claim/);
    assert.match(read('components/RanchMugeActivityPanel.vue'), /answers: \{\}, clear: true/);
    assert.match(panelSource, /muge-preview-dialog/);
    assert.doesNotMatch(html, /状态未确认|具体领奖进度未核验|只显示活动 ID/);
    assert.equal(h.calls.length, 0);
  } finally { h.dispose(); }
});

test('牧歌人格图片可放大，键盘Escape/遮罩/关闭按钮退出且对话框有无障碍语义', () => {
  const source = read('components/RanchMugeActivityPanel.vue');
  assert.match(source, /放大查看牧场人格/);
  assert.match(source, /function selectRandomAnswers/);
  assert.match(source, /Math\.floor\(random\(\) \* question\.options\.length\)/);
  assert.match(source, /const option = question\.options\[index\]/);
  assert.match(source, /if \(await operate\('settle'\)\)/);
  assert.match(source, /不同账号的答案不保证对应不同人格结果/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /window\.addEventListener\('keydown', onPreviewKeydown\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /@click\.self="imagePreviewOpen = false"/);
  assert.match(source, /aria-label="关闭图片预览"/);
});

test('牧歌问卷保存队列不锁分区导航，等待/未知结果不触发隐式重放', () => {
  const source = read('components/RanchMugeActivityPanel.vue');
  const nav = source.match(/<nav[^>]*aria-label="牧歌初启活动分区"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.match(source, /queuedAnswers = new Map/);
  assert.match(source, /while \(queuedAnswers\.size/);
  assert.match(source, /queuedAnswers\.clear\(\)/);
  assert.match(source, /unknownBlockedForCurrentAccount/);
  assert.doesNotMatch(nav, /disabled/);
  assert.match(nav, /@click\.stop="tab = section\.key"/);
  assert.match(source, /savingQuestion === question\.id \? '保存中/);
  assert.match(source, /queuedQuestionIds\.has\(question\.id\) \? '等待保存/);
});

test('4C安全复查：缺失或非有限服务端时钟不能成为可用集市/活动快照', async () => {
  for (const section of ['market', 'activities']) for (const clock of [undefined, 0, -1, '123', Number.NaN]) {
    const response = marketResponse('A', { serverTimeMs: clock });
    if (section === 'activities') Object.assign(response.data.data, { activities: [], actionsEnabled: false, guide: {}, detail: null });
    const h = ranchStoreHarness(() => Promise.resolve(response));
    try {
      await h.store.fetchProgress('A', section);
      assert.equal(h.store.progressViews[section], undefined, `${section}: bad server clock ${clock}`);
      assert.match(h.store.progressErrors[section], /结构未确认|时间未确认/);
    } finally { h.dispose(); }
  }
});

test('牧场缺图与只读空态：文字和辅助语义明确，不让用户寻找不存在的账号入口', async () => {
  const placeholder = await renderComponent('components/RanchItemImage.vue', { alt: '巨大鸭' });
  assert.match(placeholder, /巨大鸭：图标未确认/); assert.match(placeholder, />未确认</); assert.doesNotMatch(placeholder, /<img/);
  const local = frontendHarness().load('config/localReadonly.ts');
  assert.equal(local.accountDataEmptyState(true, '').title, '本地仅查看界面');
  assert.match(read('views/Ranch.vue'), /emptyState\.title/); assert.match(read('views/Ranch.vue'), /emptyState\.description/);
  assert.match(read('views/Overview.vue'), /仅查看界面，不加载账号或游戏数据/);
});

const decorationDto = () => ({ id: 501, itemId: 2130, itemCount: 1, shopId: 4, name: '头像框', price: 30,
  priceKnown: true, contentKnown: true, currencyId: 1005, currencyName: '金豆豆', currencyKnown: true,
  unlocked: true, owned: false, canBuy: true, availability: 'available' });
const decorationResponse = (accountId = 'A') => ({ data: { ok: true, accountId, shopId: 4, currencyId: 1005,
  data: [decorationDto()], userGoldBean: 100 } });
const decorationPurchaseResponse = (accountId = 'A') => ({ data: { ok: true,
  data: { accountId, outcome: 'completed', getItems: [{ id: 2130, count: 1 }], costItems: [{ id: 1005, count: 30 }] } } });

test('shop catalog reads merge once, bind the owner and reject old two-frame placeholder responses', async () => {
  const pending = deferred();
  const h = shopStoreHarness(() => pending.promise);
  try {
    const a = h.store.fetchDecorations('A'), b = h.store.fetchDecorations('A');
    assert.equal(h.requests.length, 1); pending.resolve(decorationResponse());
    await Promise.all([a, b]); assert.equal(h.store.decorations.length, 1);
    assert.equal(h.store.decorations[0].currencyId, 1005);
  } finally { h.dispose(); }
  const legacy = shopStoreHarness(async () => ({ data: { ok: true, data: [{ id: 2130, price: 0, canBuy: true }] } }));
  try { assert.equal((await legacy.store.fetchDecorations('A')).ok, false); assert.equal(legacy.store.decorations.length, 0); assert.ok(legacy.store.decorationError); }
  finally { legacy.dispose(); }
});

test('shop failed refresh preserves the visible catalog but disables stale purchase state', async () => {
  let failed = false;
  const h = shopStoreHarness(async url => {
    if (failed) throw new Error('catalog unavailable');
    if (url === '/api/shop/seed') return { data: { ok: true, accountId: 'A', shopId: 2,
      data: [{ id: 991, itemId: 20040, name: '牧草种子', price: 30, priceKnown: true, canBuy: true, unlocked: true }] } };
    return decorationResponse();
  });
  try {
    await h.store.fetchSeeds('A'); await h.store.fetchDecorations('A'); failed = true;
    await h.store.fetchSeeds('A'); await h.store.fetchDecorations('A');
    assert.equal(h.store.seeds.length, 1); assert.equal(h.store.decorations.length, 1);
    assert.equal(h.store.seeds[0].canBuy, false); assert.equal(h.store.decorations[0].canBuy, false);
    assert.equal(h.store.seeds[0].availability, 'unverified'); assert.ok(h.store.decorationError);
  } finally { h.dispose(); }
});

test('shop A-B-A late catalog response cannot restore the old account goods or error/loading state', async () => {
  const pending = deferred(); const h = shopStoreHarness(() => pending.promise);
  try {
    const a = h.store.fetchDecorations('A'); h.selected.value = 'B'; h.selected.value = 'A';
    pending.resolve(decorationResponse()); await a;
    assert.equal(h.store.decorations.length, 0); assert.equal(h.store.decorationLoading, false);
  } finally { h.dispose(); }
});

test('decoration store purchase freezes the goods/currency snapshot and repeated clicks issue only one POST', async () => {
  const pending = deferred(); const h = shopStoreHarness(async () => decorationResponse(), () => pending.promise);
  try {
    await h.store.fetchDecorations('A'); const item = h.store.decorations[0];
    const a = h.store.buyDecorationGoods('A', item), b = h.store.buyDecorationGoods('A', item);
    assert.equal(h.purchases.length, 1);
    assert.equal(h.purchases[0].url, '/api/shop/decoration/buy');
    assert.equal(h.purchases[0].config.headers['x-account-id'], 'A');
    assert.deepEqual(JSON.parse(JSON.stringify(h.purchases[0].body.expectedOffer)), { itemId: 2130, itemCount: 1, currencyId: 1005, price: 30 });
    assert.equal((await b).resultState, 'not_sent');
    pending.resolve(decorationPurchaseResponse()); assert.equal((await a).ok, true);
    assert.equal(h.requests.length, 1, 'store purchase must not spawn hidden catalog reads');
  } finally { h.dispose(); }
});

test('decoration store unknown or empty success receipts block repeat purchases and a read refresh cannot clear them', async () => {
  for (const outcome of ['timeout', 'empty']) {
    const h = shopStoreHarness(async () => decorationResponse(), async () => {
      if (outcome === 'timeout') throw new Error('network timeout');
      return { data: { ok: true, data: { accountId: 'A', outcome: 'completed', getItems: [] } } };
    });
    try {
      await h.store.fetchDecorations('A'); const item = h.store.decorations[0];
      assert.equal((await h.store.buyDecorationGoods('A', item)).ok, false);
      assert.equal(h.store.decorations[0].resultUnknown, true);
      await h.store.fetchDecorations('A'); assert.equal(h.store.decorations[0].canBuy, false);
      h.selected.value = 'B'; h.selected.value = 'A'; await h.store.fetchDecorations('A');
      await h.store.buyDecorationGoods('A', item); assert.equal(h.purchases.length, 1);
    } finally { h.dispose(); }
  }
});

test('decoration rejected/not-sent purchase is not mislabeled unknown, and stale purchase results are isolated', async () => {
  const rejected = shopStoreHarness(async () => decorationResponse(), async () => ({ data: { ok: false, sent: false, resultState: 'not_sent', error: 'price changed' } }));
  try {
    await rejected.store.fetchDecorations('A'); const item = rejected.store.decorations[0];
    assert.equal((await rejected.store.buyDecorationGoods('A', item)).resultState, 'not_sent');
    assert.notEqual(rejected.store.decorations[0].resultUnknown, true);
  } finally { rejected.dispose(); }
  const pending = deferred(), stale = shopStoreHarness(async () => decorationResponse(), () => pending.promise);
  try {
    const a = stale.store.buyDecorationGoods('A', decorationDto());
    stale.selected.value = 'B'; stale.selected.value = 'A'; pending.resolve(decorationPurchaseResponse());
    assert.equal((await a).canceled, true); assert.equal(stale.store.decorations.length, 0);
  } finally { stale.dispose(); }
});

test('unlisted forage and unverified/owned decoration cannot send a purchase from the store', async () => {
  const h = shopStoreHarness(async () => decorationResponse());
  try {
    for (const extra of [{ currencyKnown: false }, { priceKnown: false }, { price: null }, { owned: true }, { resultUnknown: true }, { canBuy: false }]) {
      assert.equal((await h.store.buyDecorationGoods('A', { ...decorationDto(), ...extra })).ok, false);
    }
    assert.equal((await h.store.buyDecorationGoods('B', decorationDto())).ok, false);
    assert.equal(h.purchases.length, 0);
  } finally { h.dispose(); }
  const availability = frontendHarness().load('composables/shop/useShopAvailability.ts').createShopAvailability({
    currentLevel: () => 109, currentGold: () => 100, currentCoupon: () => 100, userGoldBean: () => 100 });
  const forage = { itemId: 20040, isForage: true, catalogOnly: true, price: null, priceKnown: false, availability: 'not_listed', canBuy: false };
  assert.equal(availability.getSeedStatusLabel(forage), '尚未上架'); assert.equal(availability.canAffordGoods(forage), false);
  assert.equal(availability.getDecorationStatusLabel({ ...decorationDto(), owned: true }), '已拥有');
  assert.equal(availability.getDecorationStatusLabel({ ...decorationDto(), resultUnknown: true }), '结果待核对');
  assert.equal(availability.canAffordDecoration({ ...decorationDto(), currencyId: null }), false);
});

test('actual shop cards render truthful forage unknown values and owned/free decoration states, without source labels', async () => {
  const forage = await renderComponent('components/shop/SeedGoodsCard.vue', { currentLevel: 109, canAfford: false, statusLabel: '尚未上架', hint: '服务器未上架',
    item: { id: null, itemId: 20040, name: '牧草种子', isForage: true, catalogOnly: true, price: null, priceKnown: false, harvestKnown: false, requiredLevel: null, seasons: null, expPerSeason: null, canBuy: false } });
  assert.match(forage, /牧草种子/); assert.match(forage, /售价待确认/); assert.match(forage, /生长与收获数据待确认/); assert.match(forage, /disabled/);
  assert.doesNotMatch(forage, /季数 1|每季经验 0|价格 0|售价 10|来源|provenance/);
  const owned = await renderComponent('components/shop/DecorationGoodsCard.vue', { currentLevel: 109, canAfford: true, statusLabel: '已拥有', hint: '无需重复购买', item: { ...decorationDto(), owned: true, canBuy: false } });
  assert.match(owned, /已拥有/); assert.match(owned, /disabled/); assert.doesNotMatch(owned, /立即购买/);
  const free = await renderComponent('components/shop/DecorationGoodsCard.vue', { currentLevel: 109, canAfford: true, statusLabel: '可免费领', hint: '限时免费', item: { ...decorationDto(), price: 0, isFree: true, isDiscounted: true, originalPrice: 30 } });
  assert.match(free, /免费领取/); assert.match(free, /原价/);
});

test('mixed shop4 forage is shown once in seeds, never as a decoration or an invented golden-bean offer', async () => {
  const forage = { ...decorationDto(), id: 2129, itemId: 20040, name: '牧草种子', price: 20, itemType: 5, category: 'seed', isSeed: true };
  const h = shopStoreHarness(async url => url === '/api/shop/seed'
    ? { data: { ok: true, accountId: 'A', shopId: 2, data: [{ id: null, itemId: 20040, name: '牧草种子', catalogOnly: true, price: null, seedLevel: 1, requiredLevel: null }] } }
    : { data: { ...decorationResponse().data, data: [decorationDto(), forage] } });
  try {
    await h.store.fetchSeeds('A'); await h.store.fetchDecorations('A');
    assert.equal(h.store.displayDecorations.length, 1);
    assert.equal(h.store.displayDecorations.some(x => x.itemId === 20040), false);
    const rows = h.store.displaySeeds.filter(x => x.itemId === 20040);
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 2129); assert.equal(rows[0].shopId, 4);
    assert.equal(rows[0].price, 20); assert.equal(rows[0].catalogOnly, false);
    assert.equal(rows[0].currencyId, null); assert.equal(rows[0].currencyKnown, false);
    assert.equal(rows[0].canBuy, false); assert.equal(rows[0].availability, 'unverified');
    assert.equal(rows[0].seasons, null); assert.equal(rows[0].harvestKnown, false);
    assert.equal((await h.store.buySeedGoods('A', rows[0])).ok, false); assert.equal(h.purchases.length, 0);
    assert.equal(h.requests.length, 2, 'classification must not add hidden catalog or game requests');
  } finally { h.dispose(); }
});

test('legacy forage DTO and historical unknown are classified safely and no seed-tab alias can replay the same SKU', async () => {
  const forage = { ...decorationDto(), id: 2129, itemId: 20040, name: '牧草种子', price: 20 };
  const h = shopStoreHarness(async () => ({ data: { ...decorationResponse().data, data: [forage] } }),
    async () => ({ data: { ok: false, error: 'old outcome unconfirmed', sent: true, resultState: 'unknown', outcomeUnknown: true } }));
  try {
    await h.store.fetchDecorations('A');
    assert.equal(h.store.displayDecorations.length, 0); assert.equal(h.store.displaySeeds[0].currencyKnown, false);
    // Model a former, already-confirmed UI snapshot. The alias must still use the
    // same protected API and key, not the legacy generic purchase endpoint.
    await h.store.buySeedGoods('A', forage);
    assert.equal(h.purchases.length, 1); assert.equal(h.purchases[0].url, '/api/shop/decoration/buy');
    assert.equal(h.purchases[0].body.goodsId, 2129);
    await h.store.fetchDecorations('A');
    assert.equal(h.store.displaySeeds[0].resultUnknown, true);
    assert.equal(h.store.displaySeeds[0].availability, 'unknown');
    h.selected.value = 'B'; h.selected.value = 'A'; await h.store.fetchDecorations('A');
    await h.store.buySeedGoods('A', forage);
    assert.equal(h.purchases.length, 1); assert.equal(h.store.displaySeeds[0].resultUnknown, true);
  } finally { h.dispose(); }
});

test('seed card and availability distinguish listed-but-unverified billing from unlisted or historical-unknown offers', async () => {
  const availability = frontendHarness().load('composables/shop/useShopAvailability.ts').createShopAvailability({
    currentLevel: () => 109, currentGold: () => 100, currentCoupon: () => 100, userGoldBean: () => 100 });
  const item = { id: 2129, itemId: 20040, name: '牧草种子', isForage: true, shopId: 4, price: 20, priceKnown: true,
    currencyKnown: false, catalogOnly: false, unlocked: true, canBuy: false, harvestKnown: false, availability: 'unverified' };
  assert.equal(availability.getSeedStatusLabel(item), '信息待确认');
  assert.equal(availability.canAffordGoods(item), false);
  assert.match(availability.getSeedHint(item), /已列出|币种/);
  assert.equal(availability.getSeedStatusLabel({ ...item, resultUnknown: true }), '结果待核对');
  assert.match(availability.getSeedHint({ ...item, resultUnknown: true }), /背包/);
  const html = await renderComponent('components/shop/SeedGoodsCard.vue', { currentLevel: 109, canAfford: true,
    statusLabel: availability.getSeedStatusLabel(item), hint: availability.getSeedHint(item), item });
  assert.match(html, /币种待确认/); assert.match(html, /种植后可收获牧草/); assert.match(html, /disabled/);
  assert.doesNotMatch(html, /金豆豆|金币|牧场饲料作物|每季经验 0/);
});

function shopConfirmHarness() {
  const script = read('views/Shop.vue').split('<script setup lang="ts">')[1].split('</script>')[0];
  const sf = ts.createSourceFile('Shop.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['openConfirm', 'runConfirmedAction', 'closeQuantityModal', 'openQuantityModal', 'runQuantityPurchase', 'getShopMaxQuantity', 'buyDecoration']);
  const functions = sf.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(sf)).join('\n');
  const accountWatch = sf.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(sf) === 'watch' && node.expression.arguments[0]?.getText(sf) === 'currentAccountId').getText(sf);
  const currentAccountId = vue.ref('A'), quantityModal = vue.ref({ show: false, item: null, mode: 'shop', accountId: '', epoch: 0 }), pendingAction = vue.ref(null), showConfirm = vue.ref(false), confirmLoading = vue.ref(false);
  const feedback = [], purchases = [], refreshes = [], gate = deferred(), module = { exports: {} };
  const code = `let shopUiEpoch=0;\n${functions}\nconst stop=${accountWatch}\nmodule.exports={openConfirm,runConfirmedAction,openQuantityModal,runQuantityPurchase,buyDecoration,stop}`;
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, watch: vue.watch, currentAccountId, quantityModal, pendingAction, showConfirm, confirmLoading,
      confirmTitle: vue.ref(''), confirmMessage: vue.ref(''),
      toast: { success: message => feedback.push(message), error: message => feedback.push(message) },
      shopStore: { clearShopData() {}, refreshAll: async accountId => { refreshes.push(accountId); }, buyDecorationGoods: async (...args) => { purchases.push(args); return gate.promise; } },
      refreshAll: async () => { refreshes.push(currentAccountId.value); }, refreshMysteryAutoBuyStatus() {},
      buyGoods: async (...args) => { purchases.push(args); }, buyMallGoods: async (...args) => { purchases.push(args); },
    });
  return { ...module.exports, currentAccountId, quantityModal, pendingAction, showConfirm, feedback, purchases, refreshes, gate };
}

test('actual shop confirmation and quantity handlers cancel A-B-A stale intents before any purchase', async () => {
  const h = shopConfirmHarness();
  try {
    h.openConfirm('购买', '商品', async () => h.purchases.push('must not run'));
    const oldAction = h.pendingAction.value;
    h.currentAccountId.value = 'B'; h.currentAccountId.value = 'A';
    assert.equal(h.showConfirm.value, false); await oldAction(); assert.equal(h.purchases.length, 0);
    h.openQuantityModal({ id: 991, name: '牧草种子', price: 20, canBuy: true }, 'shop', '金币', 100);
    const oldQuantity = { ...h.quantityModal.value };
    h.currentAccountId.value = 'B'; h.currentAccountId.value = 'A';
    assert.equal(h.quantityModal.value.show, false);
    h.quantityModal.value = oldQuantity; await h.runQuantityPurchase(1); assert.equal(h.purchases.length, 0);
    h.openQuantityModal({ id: null, name: '牧草种子', price: null, catalogOnly: true, canBuy: false }, 'shop', '金币', 100);
    assert.equal(h.purchases.length, 0);
  } finally { h.stop(); }
});

test('actual shop late decoration purchase reply cannot toast or refresh the newly selected account', async () => {
  const h = shopConfirmHarness();
  try {
    const work = h.buyDecoration(decorationDto(), 'A'); assert.equal(h.purchases.length, 1);
    h.currentAccountId.value = 'B'; h.currentAccountId.value = 'A';
    const reads = h.refreshes.length;
    h.gate.resolve({ ok: true }); await work;
    assert.equal(h.feedback.length, 0); assert.equal(h.refreshes.length, reads);
  } finally { h.stop(); }
});

test('theme startup has a single definition/sync and preserves the eight existing themes', () => {
  assert.doesNotMatch(read('main.ts'), /const themes\s*[:=]|setProperty\('--theme-/);
  assert.equal((read('main.ts').match(/fetchTheme\(/g) || []).length, 1);
  assert.doesNotMatch(read('App.vue').split('</script>')[0], /fetchTheme|applyTheme|localStorage/);
  const h = themeHarness(() => assert.fail('startup must not issue an API request'));
  try {
    assert.equal(Object.keys(h.store.themes).length, 8);
    assert.equal(h.store.currentTheme, 'light-green');
    assert.equal(h.styles.get('--theme-bg'), '#f7f3ea');
    h.store.applyTheme('dark-purple');
    assert.equal(h.classes.has('dark'), true);
    h.store.applyTheme('toString');
    assert.equal(h.store.currentTheme, 'light-green');
    assert.equal(h.classes.has('dark'), false);
    h.store.toggleDark(); assert.equal(h.store.isDark, true);
    h.store.toggleDark(); assert.equal(h.store.isDark, false);
  } finally { h.dispose(); }
});

test('theme sync shares one read and a late response cannot undo a user choice', async () => {
  const pending = deferred(); let reads = 0;
  const h = themeHarness(async () => { reads++; return pending.promise; });
  try {
    const first = h.store.fetchTheme(), second = h.store.fetchTheme();
    assert.equal(reads, 1);
    h.store.applyTheme('dark-purple');
    pending.resolve({ data: { ok: true, data: { ui: { theme: 'light-pink' } } } });
    await Promise.all([first, second]);
    assert.equal(h.store.currentTheme, 'dark-purple');
  } finally { h.dispose(); }
});

test('generic light maps to green, unmarked historic blue migrates once, and explicit blue or other palettes survive reload/sync', async () => {
  for (const [legacy, chosen, expected] of [['light-blue', null, 'light-green'], ['light-blue', 'light-blue', 'light-blue'], ['light-pink', null, 'light-pink'], ['dark-purple', null, 'dark-purple'], ['light-green', 'light-pink', 'light-pink'], [null, null, 'light-green']]) {
    const local = storage(); if (legacy) local.setItem('ui_theme', legacy); if (chosen) local.setItem('ui_theme_choice_v1', chosen);
    const h = themeHarness(async () => ({ data: { ok: true, data: { ui: { theme: 'light' } } } }), local);
    try {
      assert.equal(h.store.currentTheme, expected);
      await h.store.fetchTheme(); assert.equal(h.store.currentTheme, expected);
      assert.equal(h.localStorage.getItem('ui_theme_choice_v1'), chosen);
      h.store.applyTheme('light-blue'); assert.equal(local.getItem('ui_theme_choice_v1'), 'light-blue');
    } finally { h.dispose(); }
    const reloaded = themeHarness(async () => ({ data: { ok: true, data: { ui: { theme: 'light' } } } }), local);
    try { await reloaded.store.fetchTheme(); assert.equal(reloaded.store.currentTheme, 'light-blue'); }
    finally { reloaded.dispose(); }
  }
});

test('five previously static tabs use actual clipped content motion, one theme selection surface, valid keyboard panels and original read contracts', () => {
  for (const file of ['views/Pet.vue', 'views/Illustrated.vue', 'views/Collection.vue', 'views/Analytics.vue', 'components/admin/AdminPanelTabs.vue']) {
    const source = read(file);
    assert.match(source, /useSlidingTabs\(/, file); assert.match(source, /v-sliding-tabs/, file);
    assert.match(source, /tab-motion-viewport/, file); assert.match(source, /data-motion-entry/, file);
    assert.match(source, /role="tabpanel"/, file); assert.match(source, /@keydown="moveSlidingTabFocus"/, file);
    assert.doesNotMatch(source, /@click="(?:tab|activeTab|filter|illustratedType)\s*=/, file);
    assert.doesNotMatch(source, /KeepAlive|cloneNode|setInterval|fetch.*(?:preview|preload)/, file);
    const descriptor = compiler.parse(source, { filename: file }); assert.equal(descriptor.errors.length, 0, file);
    compiler.compileScript(descriptor.descriptor, { id: 'real-tabs', inlineTemplate: true });
  }
  assert.match(read('views/Pet.vue'), /watch\(\[currentAccountId, tab\], load, \{ immediate: true \}\)/);
  assert.match(read('views/Illustrated.vue'), /watch\(\[currentAccountId, illustratedType\]/);
  assert.doesNotMatch(read('views/Analytics.vue'), /border-blue-500 text-blue-600/);
  assert.doesNotMatch(read('views/Collection.vue'), /bg-violet-600 text-white/);
});

test('milk tea toolbar leads actual operations, todo defaults closed outside sticky area and ordinary tab clicks never scroll or write', () => {
  const source = read('components/activity/MilkTeaActivityPanel.vue'), activity = read('views/Activity.vue');
  assert.ok(source.indexOf('data-milk-tea-exchange-entry') < source.indexOf('class="milk-tea-todo'));
  const toolbar = source.slice(source.indexOf('<div ref="toolbar"'), source.indexOf('<details v-if="props.overview"'));
  assert.match(toolbar, /<\/nav>\s*<\/div>\s*$/);
  assert.doesNotMatch(source.match(/<details v-if="props.overview"[^>]+>/)[0], /\bopen\b/);
  const ordinary = source.slice(source.indexOf('function switchTab'), source.indexOf('function navigateTo'));
  assert.doesNotMatch(ordinary, /scrollIntoView|scrollTop\s*=|focus\(|operate|api\./); assert.match(ordinary, /pendingTarget.value = null/);
  assert.match(ordinary, /cancelTargetScroll\(\)/);
  assert.match(source, /props.loading\) return/); assert.match(source, /pending.accountId !== props.accountId/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /scrollIntoView\(\{ block: 'start'/);
  assert.match(source, /data-milk-tea-action="wages"/);
  assert.match(activity, /:account-id="String\(currentAccountId \|\| ''\)"/);
  assert.match(activity, /:overview="milkTeaTodo"/);
});

test('milk tea navigation allowlist has precise wages/cashier/exchange targets and no phantom share mutation destination', () => {
  const rules = frontendHarness().load('utils/activity-overview.ts');
  for (const [input, page, anchor] of [['work:wages', 'work', 'wages'], ['shop:cashier', 'shop', 'cashier'], ['exchange', 'exchange', 'exchange'], ['shop:opening', 'shop', 'opening']]) {
    assert.deepEqual(JSON.parse(JSON.stringify(rules.milkTeaNavigationTarget(input))), { page, anchor });
  }
  for (const invalid of ['__proto__', 'toString', 'share', 'exchange:buy', 'shop:cashier:repeat', ':wages', 'work:cashier']) assert.equal(rules.milkTeaNavigationTarget(invalid), null);
});

function luminance(hex) {
  const c = channel => { const value = parseInt(channel, 16) / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
  return c(hex.slice(1, 3)) * .2126 + c(hex.slice(3, 5)) * .7152 + c(hex.slice(5, 7)) * .0722;
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
test('all themed primary actions have readable solid text, without changing the decorative palette', () => {
  const h = themeHarness(() => assert.fail('contrast calculation must stay offline'));
  try {
    for (const name of Object.keys(h.store.themes)) {
      h.store.applyTheme(name);
      assert.ok(contrast(h.styles.get('--action-bg'), h.styles.get('--action-text')) >= 4.5, name);
    }
    const styles = compiler.parse(read('App.vue')).descriptor.styles[0].content;
    for (const selector of [':root', '.dark']) {
      const variables = styles.match(new RegExp(`${selector.replace('.', '\\.')} \\{([\\s\\S]*?)\\n\\}`))[1];
      const color = name => variables.match(new RegExp(`--${name}: (#[a-f\\d]{6});`, 'i'))[1];
      for (const surface of ['surface-1', 'surface-2', 'surface-3']) {
        assert.ok(contrast(color('muted-text'), color(surface)) >= 5.5, `${selector} ${surface}`);
        for (const [name, theme] of Object.entries(h.store.themes)) {
          if (theme.isDark === (selector === '.dark'))
            assert.ok(contrast(theme.text, color(surface)) >= 4.5, `${name} ${surface} primary text`);
        }
      }
    }
  } finally { h.dispose(); }
});

test('real BaseButton preserves its label while loading and enforces disabled anchors before navigation', async () => {
  const html = await renderComponent('components/ui/BaseButton.vue', { loading: true, variant: 'primary' });
  assert.match(html, /disabled/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /base-button-label/);
  assert.match(html, /确认操作/);
  assert.match(read('components/ui/BaseButton.vue'), /@click\.capture="guardClick"/);
  assert.match(read('components/ui/BaseButton.vue'), /event\.preventDefault\(\)/);
  const source = read('components/ui/BaseButton.vue');
  assert.doesNotMatch(source, /hover:-translate|transition-all/);
  assert.match(source, /:data-clicked="clicked"/);
  assert.match(source, /scale\(\.97\)/);
  assert.match(source, /button-acknowledge 180ms/);
  assert.match(source, /onBeforeUnmount/);
});

test('settings drafts stay in memory, compare normalized keys and keep in-flight edits after confirmed save', () => {
  const h = frontendHarness(), { createSettingsDraft, settingsFingerprint } = h.load('composables/settings/useSettingsDraft.ts');
  const value = vue.ref({ timing: { min: 1, max: 5 }, choice: 0 });
  const draft = createSettingsDraft(() => value.value, next => { value.value = next; });
  assert.equal(draft.dirty.value, false); draft.rebase();
  value.value.timing.min = 2; assert.equal(draft.dirty.value, true);
  const submitted = JSON.parse(JSON.stringify(value.value)); value.value.choice = 7;
  draft.rebase(submitted); assert.equal(draft.dirty.value, true, 'post-submit edit lost');
  draft.reset(); assert.equal(value.value.choice, 0); assert.equal(value.value.timing.min, 2); assert.equal(draft.dirty.value, false);
  assert.equal(settingsFingerprint({ b: 2, a: { y: 1, x: 0 } }), settingsFingerprint({ a: { x: 0, y: 1 }, b: 2 }));
  draft.clear(); assert.equal(draft.ready.value, false); assert.equal(draft.confirmed(), null);
  assert.doesNotMatch(read('composables/settings/useSettingsDraft.ts'), /localStorage|sessionStorage|fetch\(/);
});

function settingsSaveHarness(responder) {
  const selected = vue.ref('A'), calls = [], h = frontendHarness({
    '@/api': { __esModule: true, default: { get: (...args) => { calls.push(['GET', ...args]); return responder('GET', ...args); },
      post: (...args) => { calls.push(['POST', ...args]); return responder('POST', ...args); } } },
    '@/stores/account': { useAccountStore: () => ({ get currentAccountId() { return selected.value; } }) },
  });
  const instance = pinia.createPinia(), store = h.load('stores/setting.ts').useSettingStore(instance);
  store.settingsAccountId = 'A';
  const payload = JSON.parse(JSON.stringify(store.settings));
  payload.automation = { farm: false, fertilizer: 'none' };
  return { store, payload, selected, calls, dispose: () => pinia.disposePinia(instance) };
}
test('settings save confirms each response and readback, preserves flat automation and never repeats unknown writes', async () => {
  let h, readback, first = deferred();
  h = settingsSaveHarness(async (method, url, body) => {
    if (method === 'GET') return { data: { ok: true, data: readback } };
    if (url === '/api/settings/save') { await first.promise; return { data: { ok: true } }; }
    return { data: { ok: true } };
  });
  try {
    readback = JSON.parse(JSON.stringify(h.payload));
    const result = h.store.saveSettings('A', h.payload);
    assert.equal(h.store.mutationStates.A, 'pending');
    const blocked = await h.store.saveSettings('A', h.payload); assert.equal(blocked.ok, false); assert.equal(h.calls.length, 1);
    h.payload.automation.farm = true; first.resolve();
    assert.equal((await result).ok, true);
    const automation = h.calls.find(item => item[1] === '/api/automation');
    assert.equal(automation[2].farm, false); assert.equal(automation[2].automation, undefined);
    assert.equal(h.store.lastConfirmedSave.payload.automation.farm, false); assert.equal(h.store.mutationStates.A, 'idle');
  } finally { h.dispose(); }
  let readOk = false;
  const unknown = settingsSaveHarness(async (method, url) => method === 'GET' ? { data: readOk ? { ok: true, data: unknown.payload } : { ok: false } } : { data: { ok: true } });
  try {
    const result = await unknown.store.saveSettings('A', unknown.payload);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true); assert.equal(unknown.store.mutationStates.A, 'unknown');
    const before = unknown.calls.length; await unknown.store.saveSettings('A', unknown.payload); assert.equal(unknown.calls.length, before);
    readOk = true; await unknown.store.fetchSettings('A'); assert.equal(unknown.store.mutationStates.A, 'idle');
    assert.equal(unknown.calls.filter(item => item[0] === 'POST').length, 2, 'readback replayed writes');
  } finally { unknown.dispose(); }
});
test('settings definite rejection stops later stages, and mismatch or A-B-A readback cannot claim saved', async () => {
  const rejected = settingsSaveHarness(async () => ({ data: { ok: false, sent: false, error: 'rejected' } }));
  try { assert.equal((await rejected.store.saveSettings('A', rejected.payload)).ok, false); assert.equal(rejected.calls.length, 1); assert.equal(rejected.store.mutationStates.A, 'idle'); }
  finally { rejected.dispose(); }
  let readback;
  const mismatch = settingsSaveHarness(async method => method === 'GET' ? { data: { ok: true, data: readback } } : { data: { ok: true } });
  try { readback = { ...mismatch.payload, plantingStrategy: 'different' }; assert.equal((await mismatch.store.saveSettings('A', mismatch.payload)).outcomeUnknown, true); assert.equal(mismatch.store.lastConfirmedSave, null); }
  finally { mismatch.dispose(); }
  const wait = deferred(), race = settingsSaveHarness(async method => method === 'GET' ? wait.promise : { data: { ok: true } });
  try {
    const result = race.store.saveSettings('A', race.payload); for(let i=0;i<10&&race.calls.length<3;i++)await Promise.resolve();
    race.selected.value = 'B'; race.selected.value = 'A'; wait.resolve({ data: { ok: true, data: race.payload } });
    assert.equal((await result).ok, false); assert.equal(race.store.lastConfirmedSave, null);
  } finally { race.dispose(); }
});

test('settings section patches omit unrelated fields and require genuine raw readback including disabled false values', async () => {
  const h = settingsSaveHarness(async (method, url, body) => {
    if (method === 'POST') { if (url === '/api/automation') Object.assign(raw.automation, body); else Object.assign(raw, body); return { data: { ok: true } }; }
    return { data: { ok: true, data: raw } };
  });
  const raw = JSON.parse(JSON.stringify(h.payload));
  try {
    raw.autoCodeRefresh = { enabled: true, intervalMinutes: 95 }; raw.goldenBugRoundLimit = 42;
    const patch = { plantDelaySeconds: 3, intervals: { farmMin: 2, farmMax: 6 }, automation: { harvest_delay_min: 1 } };
    raw.intervals = { farm: 2, farmMin: 2, farmMax: 5, helpMin: 30, helpMax: 35 };
    assert.equal((await h.store.saveSettings('A', patch)).ok, true);
    const posted = h.calls.find(item => item[1] === '/api/settings/save')[2];
    assert.equal(posted.autoCodeRefresh, undefined); assert.equal(posted.goldenBugRoundLimit, undefined); assert.equal(posted.preferredSeedId, undefined);
    assert.equal(raw.goldenBugRoundLimit, 42); assert.equal(raw.autoCodeRefresh.enabled, true);
    assert.deepEqual(Object.keys(h.calls.find(item => item[1] === '/api/automation')[2]), ['harvest_delay_min']);
    const matches = frontendHarness().load('composables/settings/useSettingsDraft.ts').settingsPatchMatches;
    assert.equal(matches({ intervals: { farmMin: 2, farmMax: 6, farm: 2 } }, { intervals: { farmMin: 2, farmMax: 6 } }), true);
    assert.equal(matches({ automation: {} }, { automation: { farm: false } }), false);
    assert.equal(matches({ values: [2, 1] }, { values: [1, 2] }), false);
  } finally { h.dispose(); }
  const incomplete = settingsSaveHarness(async method => method === 'GET' ? { data: { ok: true, data: { plantingStrategy: 'max_exp' } } } : { data: { ok: true } });
  try { assert.equal((await incomplete.store.saveSettings('A', { preferredSeedId: 0 })).outcomeUnknown, true); assert.equal(incomplete.store.lastConfirmedSave, null); }
  finally { incomplete.dispose(); }
});

test('unconfirmed first write and changed account cannot continue stages or masquerade as definitely not sent', async () => {
  const uncertain = settingsSaveHarness(async () => ({ data: { ok: true, resultState: 'unknown', error: 'partial' } }));
  try { const result = await uncertain.store.saveSettings('A', uncertain.payload); assert.equal(result.outcomeUnknown, true); assert.equal(uncertain.calls.length, 1); }
  finally { uncertain.dispose(); }
  const first = deferred(), h = settingsSaveHarness(async () => first.promise);
  try {
    h.payload.automation = { ranch: true, ranch_harvest: true, ranch_friend_mosquito: false, ranch_check_minutes: 30 };
    const result = h.store.saveSettings('A', h.payload); h.selected.value = 'B'; h.selected.value = 'A';
    first.resolve({ data: { ok: true } }); assert.equal((await result).outcomeUnknown, true);
    assert.equal(h.calls[0][3].headers['x-account-id'], 'A');
    assert.equal(h.calls.length, 1, 'later automation stage sent after A-B-A'); assert.equal(h.store.mutationStates.A, 'unknown');
  } finally { h.dispose(); }
});

test('user config writes require actual readback, persist unknown per session, and notifications never auto-repeat', async () => {
  let body = { enabled: false, deviceModel: 'fixture' }, writes = 0, readEnabled = false;
  const h = settingsSaveHarness(async (method) => { if (method === 'GET') return { data: readEnabled ? { ok: true, config: body } : { ok: false } }; throw new Error('unexpected store write'); });
  try {
    const send = async () => { writes++; return { data: { ok: true } }; };
    const result = await h.store.saveUserConfig('device', send, body, {}); assert.equal(result.outcomeUnknown, true);
    await h.store.saveUserConfig('device', send, body, {}); assert.equal(writes, 1);
    readEnabled = true; await h.store.fetchUserConfig('device'); assert.equal(h.store.userMutationStates.device, 'idle'); assert.equal(writes, 1);
    const pending = deferred(); const action = h.store.sendUserAction('notification', () => { writes++; return pending.promise; });
    assert.equal((await h.store.sendUserAction('notification', send)).ok, false);
    pending.reject(new Error('transport')); assert.equal((await action).outcomeUnknown, true);
    await h.store.sendUserAction('notification', send); assert.equal(writes, 2);
    assert.equal(h.store.userMutationStates.notification, 'unknown');
    const success = await h.store.sendUserAction('password', async () => ({ data: { ok: true } })); assert.equal(success.ok, true);
  } finally { h.dispose(); }
});

function accountSelectionHarness(responder) {
  const memory = new Map(), calls = [], h = frontendHarness({
    '@vueuse/core': { useStorage(key, fallback) { if (!memory.has(key)) memory.set(key, vue.ref(fallback)); return memory.get(key); } },
    '@/api': { __esModule: true, default: { get: (...args) => { calls.push(['GET', ...args]); return responder('GET', ...args); },
      post: (...args) => { calls.push(['POST', ...args]); return responder('POST', ...args); }, delete: (...args) => { calls.push(['DELETE', ...args]); return responder('DELETE', ...args); } } },
  });
  const instance = pinia.createPinia(), store = h.load('stores/account.ts').useAccountStore(instance);
  store.accounts = [{ id: 'A', name: 'fixture A', running: true }, { id: 'B', name: 'fixture B', running: false }]; store.currentAccountId = 'A';
  return { store, calls, dispose: () => pinia.disposePinia(instance) };
}
test('account selection guards survive background refresh, reselect supersedes older choice and no mutation selects another card', async () => {
  const gate = deferred(), h = accountSelectionHarness(async () => ({ data: { ok: true, data: { accounts: [] } } }));
  try {
    const remove = h.store.registerSelectionGuard(Symbol('fixture'), () => gate.promise);
    await h.store.fetchAccounts(); assert.equal(h.store.currentAccountId, 'A', 'list refresh discarded editor');
    h.store.accounts = [{ id: 'A' }, { id: 'B' }];
    const choose = h.store.selectAccount('B'); assert.equal(await h.store.selectAccount('A'), true); gate.resolve(true);
    assert.equal(await choose, false); assert.equal(h.store.currentAccountId, 'A'); remove();
    assert.equal(h.calls.filter(item => item[0] !== 'GET').length, 0);
  } finally { h.dispose(); }
});
test('account mutation waits for pre-mutation list then makes one fresh readback and blocks unknown across refresh', async () => {
  const old = deferred(); let reads = 0, running = true;
  const h = accountSelectionHarness(async method => {
    if (method !== 'GET') { running = false; return { data: { ok: true } }; }
    reads++; return reads === 1 ? old.promise : { data: { ok: true, data: { accounts: [{ id: 'A', running }] } } };
  });
  try {
    const firstRead = h.store.fetchAccounts(); const mutation = h.store.stopAccount('A');
    old.resolve({ data: { ok: true, data: { accounts: [{ id: 'A', running: true }] } } });
    await firstRead; await mutation; assert.equal(reads, 2); assert.equal(h.store.currentAccountId, 'A'); assert.equal(h.store.accounts[0].running, false);
  } finally { h.dispose(); }
  let writes = 0;
  const unknown = accountSelectionHarness(async method => method === 'GET' ? { data: { ok: true, data: { accounts: [{ id: 'A', running: true }] } } } : (writes++, { data: { ok: false, outcomeUnknown: true } }));
  try {
    await assert.rejects(unknown.store.stopAccount('A')); await unknown.store.fetchAccounts(); await assert.rejects(unknown.store.stopAccount('A'));
    assert.equal(writes, 1); assert.equal(unknown.store.operationStates.A, 'unknown');
  } finally { unknown.dispose(); }
});

test('default-plan application confirms settings once, keeps unknown across editor remount and never adds a retry', async () => {
  let mode = 'normal', writes = 0;
  const plan = { exists: true, enabled: true, config: { plantingStrategy: 'level', automation: { farm: false } } };
  const h = settingsSaveHarness(async (method, url) => {
    if (method !== 'GET') { writes++; return { data: { ok: true } }; }
    if (url === '/api/settings/default-plan') return { data: { ok: true, data: plan } };
    return { data: mode === 'normal' ? { ok: true, data: plan.config } : { ok: false } };
  });
  try {
    assert.equal((await h.store.applyDefaultAccountPlan('A')).ok, true); assert.equal(writes, 1);
    mode = 'unknown'; assert.equal((await h.store.applyDefaultAccountPlan('A')).outcomeUnknown, true);
    h.store.clearSettingsState(); await h.store.applyDefaultAccountPlan('A'); assert.equal(writes, 2, 'remount reset unknown application lock');
    mode = 'normal'; await h.store.fetchSettings('A'); assert.equal(h.store.defaultPlanApplications.A, 'idle'); assert.equal(writes, 2);
  } finally { h.dispose(); }
});

test('conservative dashboard keeps metric/log structure and explicit historical-reading pause without adding game reads', () => {
  const source = read('views/Dashboard.vue');
  assert.match(source, /dashboard-notice ui-notice/); assert.match(source, /<details[^>]*class="dashboard-log-filters"/);
  assert.match(source, /正在查看历史，新日志不会打断阅读/); assert.match(source, /function resumeLiveLogs\(\)/);
  assert.match(source, /if \(logContainer.value && autoScroll.value\)/); assert.match(source, /bagStore\.fetchBag\(accountId\)/);
  assert.doesNotMatch(source, /bagStore\.allItems =|Lv\.\{\{ status\?\.status\?\.level \|\| 0/);
  assert.match(source, /md:w-3\/4/); assert.match(source, /md:w-1\/4/);
});

test('real settings preserves a same-instance draft registry, isolates save sections and renders independent account actions', () => {
  const source = read('views/Settings.vue'), user = read('composables/settings/useUserSettings.ts'), account = read('components/settings/AccountSettingsTab.vue');
  assert.match(source, /useUserSettings\(showAlert, draftRegistry\)/); assert.match(user, /draftRegistry \|\| inject/);
  assert.match(source, /onBeforeRouteLeave/); assert.match(source, /registerSelectionGuard/); assert.match(source, /beforeunload/);
  assert.match(source, /strategyDraft\.clear\(\)[\s\S]*automationDraft\.clear\(\)/); assert.match(source, /initializingEditor\.value = true/);
  assert.match(source, /baseline\.automation\.automation\.harvest_delay_min/);
  assert.doesNotMatch(read('composables/settings/useStrategySettings.ts').slice(read('composables/settings/useStrategySettings.ts').indexOf('async function saveStrategySettings')), /\.\.\.settings\.value|automation: getAutomationSettings\(\)\.automation,/);
  assert.match(account, /<article[^>]*class="ui-card account-card"/); assert.doesNotMatch(account, /<article[^>]*@click/);
  for (const action of ['select', 'toggle', 'settings', 'delete']) assert.match(account, new RegExp(`@click\\.stop="emit\\('${action}'`));
});

test('ranch automation dialog keeps all switches in a bounded scroll body and its completion control outside', async () => {
  const source = read('components/settings/AutomationSettingsTab.vue');
  const dialog = source.slice(source.indexOf('<!-- 分类设置弹窗 -->'), source.indexOf('<!-- 香囊优先赠送好友选择弹窗 -->'));
  const ranch = dialog.slice(dialog.indexOf("displayedCategory === 'ranch'"), dialog.indexOf("displayedCategory === 'activity'"));
  assert.match(dialog, /class="[^\"]*\bcategory-dialog\b[^\"]*\bmin-w-0\b/);
  assert.match(source, /\.category-dialog\s*\{[^}]*max-height:\s*88dvh/);
  assert.match(dialog, /<div class="flex shrink-0 items-center justify-between/);
  assert.match(dialog, /<div class="[^\"]*\bmin-h-0\b[^\"]*\boverflow-y-auto\b[^\"]*">\s*<fieldset class="[^\"]*\bmin-w-0\b[^\"]*" :disabled="saving \|\| !activeCategory">/);
  assert.match(dialog, /<\/fieldset>\s*<\/div>\s*<div class="flex shrink-0 justify-end[^>]*>\s*<BaseButton[^>]*@click="closeCategory">完成<\/BaseButton>/);
  assert.doesNotMatch(ranch, /scene[12]/);
  assert.match(ranch, /<SettingToggle v-model="settings\.automation\.ranch"/);
  assert.match(ranch, /<SettingToggle v-for="group in ranchQuickGroups"[^>]*@update:model-value="\(value: boolean\) => setRanchGroup\(group, value\)"/);
  assert.match(ranch, /好友牧场互动（可选）/);
  assert.match(ranch, /购买与补给设置/);
  assert.doesNotMatch(ranch, /v-model\.number="settings\.automation\.ranch_check_minutes"/);
  assert.match(ranch, /巡查间隔跟随农场设置/);
  assert.match(ranch, /仅偷取指定好友（与农场共用）/);
  assert.match(ranch, /stealPickerVisible = true/);
  assert.match(ranch, /badPickerVisible = true/);
  assert.match(ranch, /<SettingToggle v-for="group in ranchQuickGroups"[^>]*:disabled="!settings\.automation\.ranch"/);
  assert.match(ranch, /<SettingToggle v-for="toggle in ranchOptionalToggles"[^>]*:disabled="!settings\.automation\.ranch"/);
  assert.ok((ranch.match(/:disabled="!settings\.automation\.ranch"/g) || []).length >= 6, '主开关关闭时全部可编辑的自动化选项均需原生禁用');
  const categoryCode = source.slice(source.indexOf('const ranchToggles ='), source.indexOf('const rainPoemToggles ='))
    + source.slice(source.indexOf('const categoryToggleKeys:'), source.indexOf('</script>'));
  const settings = vue.ref({ automation: { ranch: true, ranch_harvest: true, ranch_check_minutes: 30 } });
  const counts = vm.runInNewContext(ts.transpileModule(categoryCode + '\n({ categoryToggleList, categoryEnabledCount, ranchQuickGroups, ranchGroupEnabled, setRanchGroup, ranchOptionalToggles, ranchFriendToggles })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { settings });
  assert.equal(counts.categoryToggleList('ranch').length, 10, '卡片摘要展示4组、升级/库存和3项补购选项');
  assert.equal(counts.categoryEnabledCount('ranch'), 1, '部分开启的常用组不冒充整组开启');
  const care = counts.ranchQuickGroups.find(group => group.key === 'ranch_group_care');
  assert.equal(counts.ranchGroupEnabled(care), false);
  counts.setRanchGroup(care, true);
  assert.equal(counts.ranchGroupEnabled(care), true);
  assert.equal(JSON.stringify(care.keys.map(key => settings.value.automation[key])), '[true,true,true,true,true]');
  counts.setRanchGroup(care, false);
  assert.ok(care.keys.every(key => settings.value.automation[key] === false));
  assert.equal(counts.ranchOptionalToggles.length, 3);
  assert.equal(counts.ranchFriendToggles.length, 4);
  assert.ok(!counts.categoryToggleList('ranch').includes('ranch_check_minutes'), '分钟字段不是布尔开关');
  const entries = source.match(/const ranchToggles = \[([\s\S]*?)\n\]/)[1];
  assert.deepEqual(Array.from(entries.matchAll(/key: '(ranch_\w+)'/g), match => match[1]), [
    'ranch_harvest', 'ranch_produce', 'ranch_clean', 'ranch_sell', 'ranch_grass', 'ranch_grass_buy',
    'ranch_feed_normal', 'ranch_feed_organic', 'ranch_fill_cans', 'ranch_complete_upgrade', 'ranch_place', 'ranch_cub_buy',
    'ranch_daily_tasks_claim', 'ranch_growth_tasks_claim', 'ranch_daily_share_claim', 'ranch_activity_claim',
    'ranch_friend_steal', 'ranch_friend_clean', 'ranch_friend_stroke', 'ranch_friend_mosquito',
  ]);
  const label = entries.match(/key: 'ranch_place', label: '([^']+)'/)[1];
  const html = await renderComponent('components/settings/SettingToggle.vue', { label, modelValue: true });
  assert.match(html, /ui-subtle-panel box-border flex w-full max-w-full min-w-0 items-center/);
  assert.match(html, /class="min-w-0 flex-1 \[overflow-wrap:anywhere\]"/);
  assert.doesNotMatch(html, /\btruncate\b/);
  assert.match(html, /class="base-switch-field shrink-0"/);
  assert.ok(html.includes(`aria-label="${label}"`));
});

test('牧场自动化：21个布尔开关默认关闭，任务、分享与活动领取独立授权', async () => {
  const source = read('components/settings/AutomationSettingsTab.vue');
  const storeSource = fs.readFileSync(path.join(__dirname, '../src/models/store.js'), 'utf8');
  const defaults = vm.runInNewContext('({' + storeSource.match(/    ranch: false,[\s\S]*?\n    ranch_check_minutes: \d+/)[0] + '\n})');
  const entries = source.match(/const ranchToggles = \[([\s\S]*?)\n\]/)[1];
  const keys = ['ranch', ...Array.from(entries.matchAll(/key: '(ranch_\w+)'/g), match => match[1])];
  const booleanKeys = Object.keys(defaults).filter(key => typeof defaults[key] === 'boolean');
  assert.equal(booleanKeys.length, 21);
  assert.deepEqual(booleanKeys, keys, '默认布尔列表与前端开关列表必须一致');
  for (const key of keys) assert.equal(defaults[key], false, key);
  assert.equal(defaults.ranch_check_minutes, 30, '保留原有分钟默认值');
  assert.match(source, /ranch_cub_buy: boolean/);
  const settings = vue.ref({ automation: { ...defaults } });
  const code = source.slice(source.indexOf('const ranchToggles ='), source.indexOf('const rainPoemToggles ='))
    + source.slice(source.indexOf('const categoryToggleKeys:'), source.indexOf('</script>'));
  const counts = vm.runInNewContext(ts.transpileModule(code + '\n({ categoryEnabledCount })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { settings });
  assert.equal(counts.categoryEnabledCount('ranch'), 0);
  settings.value.automation.ranch_place = true;
  assert.equal(settings.value.automation.ranch_cub_buy, false, '库存补栏不能连带授权购买');
  assert.equal(counts.categoryEnabledCount('ranch'), 1);
  settings.value.automation.ranch_cub_buy = true;
  assert.equal(counts.categoryEnabledCount('ranch'), 2);
  settings.value.automation.ranch_cub_buy = false;
  assert.equal(settings.value.automation.ranch_place, true, '关闭补购不应关闭库存补栏');
  assert.equal(counts.categoryEnabledCount('ranch'), 1);
  const label = entries.match(/key: 'ranch_cub_buy', label: '([^']+)'/)[1];
  assert.equal(label, '库存不足时用金券购买普通幼崽');
  const toggleHtml = await renderComponent('components/settings/SettingToggle.vue', { label, modelValue: false });
  assert.ok(toggleHtml.includes(`aria-label="${label}"`));
  assert.match(toggleHtml, /aria-checked="false"/);
  assert.doesNotMatch(toggleHtml, /<input[^>]*\schecked(?:\s|=|>)/);
  const bag = await ranchPageFixture('personal', 'bag');
  assert.equal(bag.calls.length, 0, '展示帮助文案不得触发额外请求');
  assert.match(bag.html, /<details[^>]*><summary[^>]*>自动补栏规则/);
  assert.doesNotMatch(bag.html, /shop5|ranch_place|后台轮询/);
  const note = source.match(/<p class="category-dialog__note[^>]*>([^<]+)<\/p>/)[1];
  for (const help of [`${note} ${bag.html}`]) {
    for (const rule of ['默认关闭', '需同时开启库存补栏',
      '单价不超过1080金券', '每轮最多3只', '保留10000金券', '不使用钻石、点券', '不购买或消耗巨大幼崽']) {
      assert.ok(help.includes(rule), `缺少安全提示：${rule}`);
    }
  }
});

test('牧场自动化设置按需读取共用好友名单，切号关闭旧弹窗且不额外读取', () => {
  const source = read('components/settings/AutomationSettingsTab.vue');
  const code = 'let nowTimer = null;\n' + source.slice(source.indexOf('function ensureFriends()'), source.indexOf('// 活动控制分类的介绍文案'));
  const props = vue.reactive({ currentAccountId: 'A', saving: false }), mounted = [], stops = [];
  const qixiPickerVisible = vue.ref(false), badPickerVisible = vue.ref(false), stealPickerVisible = vue.ref(false), friendSearch = vue.ref('旧查询');
  let reads = 0;
  const scope = vue.effectScope();
  try {
    const result = scope.run(() => vm.runInNewContext(ts.transpileModule(code + '\n({ openCategory, activeCategory, displayedCategory })',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
      { ref: vue.ref, watch: (...args) => { const stop = vue.watch(...args); stops.push(stop); return stop; }, props,
        qixiPickerVisible, badPickerVisible, stealPickerVisible, friendSearch, nowMs: vue.ref(0),
        friendStore: { friends: [], loading: false, fetchFriends(id) { assert.equal(id, 'A'); reads++; } },
        onMounted: fn => mounted.push(fn), onUnmounted() {}, overlayMotion: { dispose() {} },
        window: { setInterval: () => 1, clearInterval() {} } }));
    mounted[0](); result.openCategory('ranch'); assert.equal(reads, 0, '打开分类及其动画不能预读隐藏好友名单');
    stealPickerVisible.value = true; assert.equal(reads, 1);
    props.currentAccountId = 'B';
    assert.equal(result.activeCategory.value, null); assert.equal(result.displayedCategory.value, null);
    assert.equal(stealPickerVisible.value, false); assert.equal(badPickerVisible.value, false); assert.equal(qixiPickerVisible.value, false);
    assert.equal(friendSearch.value, ''); assert.equal(reads, 1);
    props.currentAccountId = 'A'; assert.equal(reads, 1, 'A-B-A返回不能自动恢复旧名单弹窗');
  } finally { for (const stop of stops) stop(); scope.stop(); }
});

test('real form inputs forward native constraints and key events to actual controls with accessible hints', async () => {
  const html = await renderComponent('components/ui/BaseInput.vue', { type: 'number', modelValue: 0, min: 0, max: 1440, step: 1, required: true,
    id: 'delay-value', name: 'delay', label: '延迟', hint: '分钟', class: 'w-40' });
  assert.match(html, /<input[^>]*id="delay-value"[^>]*min="0"[^>]*max="1440"[^>]*step="1"/);
  assert.match(html, /<label[^>]*for="delay-value"/); assert.match(html, /aria-describedby="delay-value-help"/);
  assert.doesNotMatch(html, /<div[^>]*(?:min|max|step|name)=/);
  const error = await renderComponent('components/ui/BaseInput.vue', { label: '参数', error: '超出允许范围', disabled: true });
  assert.match(error, /aria-invalid="true"/); assert.match(error, /超出允许范围/);
  const source = read('components/ui/BaseInput.vue');
  assert.match(source, /inheritAttrs: false/); assert.match(source, /v-bind="inputAttrs\(\)"/);
  assert.match(source, /checkValidity/); assert.match(source, /validationMessage/);
});

test('real select and switch provide keyboard/top-layer semantics and preserve disabled constraints', async () => {
  const html = await renderComponent('components/ui/BaseSelect.vue', { label: '种子', modelValue: 0, options: [{ label: '自动选择', value: 0 }, { label: '种子', value: 1 }], disabled: true, disabledReason: '请先选择账号' });
  assert.match(html, /<button[^>]*disabled[^>]*role="combobox"/); assert.match(html, /自动选择/); assert.match(html, /请先选择账号/);
  const source = read('components/ui/BaseSelect.vue');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'Tab']) assert.ok(source.includes(key), key);
  assert.match(source, /showPopover\(\)/); assert.match(source, /<Teleport to="body"/); assert.match(source, /role="listbox"/);
  assert.match(source, /aria-activedescendant/); assert.match(source, /option\.disabled/); assert.match(source, /window\.visualViewport/);
  const switchHtml = await renderComponent('components/ui/BaseSwitch.vue', { label: '自动化', modelValue: true, disabled: true, disabledReason: '保存中' });
  assert.match(switchHtml, /<input[^>]*type="checkbox"[^>]*role="switch"[^>]*disabled/); assert.match(switchHtml, /保存中/);
});

function modalMotionHarness() {
  const listeners = new Map(), media = { matches: false, addEventListener: (event, fn) => listeners.set('media', fn), removeEventListener() {} }, animations = [];
  const element = { isConnected: true, style: {}, animate(frames, timing) { const done = deferred(); const item = { frames, timing, finished: done.promise, cancel() { this.canceled = true; }, resolve: done.resolve }; animations.push(item); return item; } };
  const h = frontendHarness({}, { globals: { window: { matchMedia: () => media }, document: { hidden: false, addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener() {} }, getComputedStyle: () => ({ opacity: '.63', transform: 'matrix(1, 0, 0, 1, 0, 3.5)' }) } });
  let hidden = 0; const motion = h.load('composables/useContentMotion.ts').createModalPresenceMotion(() => element, () => hidden++);
  return { motion, media, listeners, animations, get hidden() { return hidden; } };
}
test('modal visual reversal starts from exact paint, closes only once and runtime reduced motion finishes without a callback replay', async () => {
  const h = modalMotionHarness();
  try {
    h.motion.change(true, true); assert.equal(h.animations[0].timing.duration, 240);
    h.motion.change(false); assert.equal(h.animations[0].canceled, true); assert.equal(h.animations[1].frames[0].transform, 'matrix(1, 0, 0, 1, 0, 3.5)');
    assert.equal(h.animations[1].timing.duration, 150); assert.equal(h.hidden, 0);
    h.motion.change(true); h.animations[1].resolve(); await Promise.resolve(); assert.equal(h.hidden, 0, 'old close won after reopen');
    h.motion.change(false); h.media.matches = true; h.listeners.get('media')(); assert.equal(h.hidden, 1);
    h.animations.at(-1).resolve(); await Promise.resolve(); assert.equal(h.hidden, 1);
  } finally { h.motion.dispose(); }
});
test('visual polish preserves content directions, adds decorative tab/fold motion and limits hover to interactive surfaces', () => {
  const css = read('App.vue'), code = read('composables/useContentMotion.ts');
  assert.match(css, /\[data-sliding-tabs\] > \.ui-tab\[data-active='true'\]/); assert.match(css, /\.ui-tab-selection \{[^}]*pointer-events: none/);
  assert.match(code, /export const vSlidingTabs/); assert.match(code, /export const vFoldMotion/); assert.match(code, /const current = \[0, 0, 0, 0\]/);
  assert.match(code, /media\.addEventListener\('change'/); assert.match(css, /\.ui-card\[data-interactive='true'\]:hover/);
  assert.match(read('components/ToastContainer.vue'), /\.toast-move \{ transition: transform 220ms/);
  assert.match(read('views/Dashboard.vue'), /dashboard-amount-change \{ font-size: 12px/);
  assert.match(read('components/settings/AutomationSettingsTab.vue'), /overlayMotion\.leave/);
  assert.doesNotMatch(read('components/settings/AutomationSettingsTab.vue'), /cubic-bezier\(0\.34, 1\.56/);
});

test('real confirmation dialog uses native modal semantics, safe initial focus and pending no-cancel', async () => {
  const html = await renderComponent('components/ConfirmModal.vue', { show: true, title: '确认出售', loading: true });
  assert.match(html, /<dialog[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /请求处理中/);
  assert.equal((html.match(/disabled/g) || []).length >= 2, true);
  const code = read('components/ConfirmModal.vue');
  assert.match(code, /\.showModal\(\)/);
  assert.match(code, /\[data-modal-cancel\]/);
  assert.match(code, /event\.preventDefault\(\)/);
  assert.match(code, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(code, /color:\s*#2e7d32|background:\s*rgba\(255, 255, 255/);
});

test('page motion uses ephemeral painted continuity, keeps one real page and has no developer-facing copy', () => {
  const layout = read('layouts/DefaultLayout.vue');
  assert.match(layout, /:key="route.path" class="page-view/);
  assert.doesNotMatch(layout, /mode="out-in"|<KeepAlive/);
  assert.doesNotMatch(layout.slice(layout.indexOf('ref="pageViewport"'), layout.indexOf('</main>')), /<Transition|<KeepAlive/);
  assert.match(layout, /<Transition name="workspace-travel">/);
  assert.match(layout, /router.beforeResolve/);
  assert.match(layout, /releaseGuard\(\)[\s\S]*return paint/);
  const personal = read('views/Personal.vue');
  assert.match(personal, /:key="currentTab" class="personal-panel-entry"/);
  assert.match(personal, /@click="selectTab\(tab.key\)"/);
  assert.doesNotMatch(personal, /仅记住界面偏好|不缓存游戏操作/);
  assert.doesNotMatch(read('components/BagPanel.vue'), /优先展示物品与数量/);
  const motion = read('composables/useContentMotion.ts');
  assert.match(motion, /startViewTransition/);
  assert.doesNotMatch(motion, /cloneNode|sessionStorage|localStorage|fetch\(/);
  const css = read('App.vue');
  assert.match(css, /content-snapshot-in/);
  assert.match(css, /--content-slide-y: 100%/);
  assert.match(css, /--content-slide-x: 100%/);
  assert.match(css, /--content-duration: 460ms/);
  assert.match(css, /--content-easing: cubic-bezier\(\.24, \.08, \.2, 1\)/);
  assert.match(css, /clip-path: inset\(0/);
  const frames = css.slice(css.indexOf('@keyframes content-snapshot-out'), css.indexOf('@media (prefers-reduced-motion', css.indexOf('@keyframes content-snapshot-out')));
  assert.doesNotMatch(frames, /scale\(|opacity:/);
  assert.match(css, /::view-transition-new\(farm-content\)[\s\S]*pointer-events: none/);
});

test('anonymous local viewing requires an explicit build and exact loopback origin, never a production/query auth switch', () => {
  const api = frontendHarness().load('config/localReadonly.ts');
  assert.equal(api.allowsLocalReadonly(true, 'http://127.0.0.1:4177/personal'), true);
  for (const url of ['http://127.0.0.1:3007/personal', 'http://localhost:4177/', 'https://farm.example/personal?readonly=1', 'http://20.222.178.208:3007/'])
    assert.equal(api.allowsLocalReadonly(true, url), false, url);
  assert.equal(api.allowsLocalReadonly(false, 'http://127.0.0.1:4177/'), false);
  assert.match(read('main.ts'), /if \(LOCAL_UI_READONLY\)[\s\S]*current_account_id/);
  assert.match(read('api/index.ts'), /adapter:[\s\S]*CanceledError\('本地只读浏览/);
});

test('global surface tiers no longer override every rounded control or replay page-card animations', () => {
  const css = read('App.vue');
  assert.doesNotMatch(css, /\.rounded-lg\s*\{[^}]*!important|animation:\s*card-reveal/);
  assert.match(css, /--radius-control: 8px/);
  assert.match(css, /--radius-card: 12px/);
  assert.match(css, /--radius-panel: 16px/);
  assert.match(css, /prefers-reduced-motion[\s\S]*scroll-behavior: auto !important/);
});

test('activity and mutation pages share the real personal heading, tabs, surfaces and safe motion vocabulary', () => {
  const css = read('App.vue'), activity = read('views/Activity.vue'), mutation = read('components/MutationCatalogPanel.vue');
  for (const source of [read('views/Personal.vue'), activity, mutation]) {
    assert.match(source, /ui-page-heading/);
    assert.match(source, /ui-tabs/);
    assert.match(source, /ui-tab/);
  }
  assert.match(css, /\.ui-page-heading h1\s*\{[^}]*color: var\(--theme-text\)/);
  assert.match(css, /\.ui-tab\[data-active='true'\]\s*\{[^}]*var\(--action-bg\)[^}]*var\(--action-text\)/);
  assert.match(css, /\.ui-empty-state\s*\{[^}]*var\(--surface-border-strong\)/);
  assert.match(activity, /activity-banner ui-card/);
  assert.ok(activity.indexOf('activity-tabs ui-tabs') < activity.indexOf('activity-banner ui-card'));
  assert.doesNotMatch(activity, /bg-\[#071b43\]|text-amber-100|backdrop-blur-sm|min-h-40/);
  assert.doesNotMatch(mutation, /bg-blue-600|text-blue-700|api\.(post|put|patch|delete)\(/);
  assert.match(mutation, /useSlidingTabs\(tab/);
  assert.match(mutation, /bundledMutationCatalog\(\)/);
  assert.match(read('utils/mutation-catalog.ts'), /__MUTATION_CATALOG__/);
  assert.match(mutation, /role="tabpanel"/);
  assert.match(mutation, /if \(LOCAL_UI_READONLY \|\| disposed\)/);
  assert.match(mutation, /onBeforeUnmount\(\(\) => \{ disposed = true; controller.abort\(\)/);
  assert.match(read('views/SolarCalendar.vue'), /\.solar-card\s*\{[^}]*border-radius: var\(--radius-card/);
  assert.match(read('components/activity/MilkTeaActivityPanel.vue'), /milk-tea-metric/);
});

test('readable page copy keeps secondary text solid and emphasizes only existing dates and rule values', () => {
  const css = compiler.parse(read('App.vue')).descriptor.styles[0].content;
  const tab = css.match(/\.ui-tab \{([^}]+)\}/)[1];
  assert.match(tab, /color: var\(--theme-text\)/);
  assert.doesNotMatch(tab, /opacity:/);
  assert.match(read('views/Personal.vue'), /\.personal-tab \{[^}]*color: var\(--theme-text\)/);
  assert.match(css, /\.ui-tab\[data-active='true'\] \{[^}]*color: var\(--action-text\)/);
  const activity = read('views/Activity.vue'), mutation = read('components/MutationCatalogPanel.vue');
  assert.match(activity, /<strong>\{\{ milkTeaSchedule\.businessEnd \}\}<\/strong>/);
  assert.match(activity, /<strong>\{\{ milkTeaSchedule\.rewardEnd \}\}<\/strong>/);
  assert.match(activity, /\.activity-header-schedule \{[^}]*font-size: 12px/);
  assert.match(activity, /\.activity-header-schedule strong \{[^}]*var\(--theme-text\)/);
  assert.doesNotMatch(activity.match(/class="activity-tab-count[^\"]*"/)[0], /opacity-/);
  assert.match(mutation, /保底 <strong>\{\{ group\.guarantee \}\}<\/strong> 次/);
  assert.match(mutation, /\.mutation-description \{[^}]*font-size: 13px/);
  assert.match(mutation, /\.mutation-probabilities dd \{[^}]*font-size: 16px/);
  assert.doesNotMatch(mutation.match(/\.mutation-tab-count \{([^}]+)\}/)[1], /opacity:/);
  assert.match(mutation, /未提供公开概率/);
  const milk = read('components/activity/MilkTeaActivityPanel.vue'), solar = read('views/SolarCalendar.vue');
  assert.match(milk, /经营截止 <strong>\{\{ formatActivityDeadline\(activity\?\.settleStartTime\) \}\}<\/strong>/);
  assert.match(milk, /milk-tea-claimable[\s\S]*color: var\(--status-success\)/);
  assert.match(milk, /:not\(button\):not\(input\):not\(select\):not\(textarea\):not\(a\)/);
  assert.match(solar, /--solar-muted: var\(--muted-text/);
  assert.doesNotMatch(solar, /--solar-muted: color-mix/);
  assert.match(solar, /\.solar-period \{[^}]*font-size: 12px/);
});

test('mutation catalog local-readonly renders a real unloaded state and no synthetic rules or error wall', async () => {
  const h = frontendHarness({
    '@/api': { __esModule: true, default: { get: () => assert.fail('SSR must not request game/backend') }, isReadCanceled: () => false },
    '@/config/localReadonly': { LOCAL_UI_READONLY: true },
    '@/composables/useContentMotion': { useSlidingTabs: selection => ({ select() {}, selected: selection }), vSlidingTabs: {}, vFoldMotion: {} },
  });
  const html = await renderer.renderToString(vue.createSSRApp(h.load('components/MutationCatalogPanel.vue').default));
  assert.match(html, /<h1[^>]*>变异宝典<\/h1>/);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.match(html, /变异资料未加载/);
  assert.doesNotMatch(html, /class="mutation-card|class="mutation-series ui-card|bg-blue-600|读取规则失败|<dt>/);
});

function actualMutationCatalog() {
  const root = path.join(__dirname, '../src/gameConfig');
  const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const cfg = Object.fromEntries(['CollectionSeries', 'CollectionGroup', 'CollectionItem', 'MutantPublicity'].map(name => [name, json(`collections/${name}.json`)]));
  const items = new Map(json('ItemInfo.json').map(item => [Number(item.id), item]));
  return require('../src/services/mutation-catalog-data').buildMutationCatalog(json('MutantEffect.json'), { ...cfg, source: json('collections/sources.json') }, id => items.get(Number(id)));
}

test('bundled mutation rules are genuine file-derived data, crop names follow source-rarity groups and filters do not mutate rules', async () => {
  const catalog = actualMutationCatalog();
  const h = frontendHarness({}, { globals: { __MUTATION_CATALOG__: catalog } });
  const api = h.load('utils/mutation-catalog.ts');
  assert.equal(api.bundledMutationCatalog().normal.length, catalog.normal.length);
  const golden = catalog.normal.find(item => item.name === '黄金');
  assert.ok(golden && golden.probabilities.length > 0);
  const groups = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/collections/CollectionGroup.json'), 'utf8'));
  for (const group of groups) assert.equal(api.cropRarityLabel(group.source_rarity, catalog.rarityNames), `${group.group_name.split('·').at(-1)}作物`);
  assert.equal(api.cropRarityLabel(null, catalog.rarityNames), '公开概率');
  assert.equal(api.cropRarityLabel(99, catalog.rarityNames), '作物品质 99');
  const before = JSON.stringify(catalog);
  assert.deepEqual(Array.from(api.filterMutationEffects(catalog.normal, '黄金', 'all')).map(item => item.id), [golden.id]);
  assert.ok(api.filterMutationEffects(catalog.normal, '售价', 'price').every(item => item.effect.startsWith('售价×')));
  assert.equal(api.filterMutationEffects(catalog.normal, '不存在的规则词', 'all').length, 0);
  const series = catalog.collections[0];
  assert.ok(api.filterMutationSeries(catalog.collections, series.items[0].name, 'all').some(item => item.id === series.id));
  assert.equal(JSON.stringify(catalog), before);
  assert.equal(api.parseMutationCatalog({ normal: [], decoration: [], collections: [] }), null);
  assert.equal(api.parseMutationCatalog({ ...catalog, normal: [{ ...golden, probabilities: [{ rarity: null, percent: NaN }] }] }), null);
  assert.equal(api.parseMutationCatalog({ ...catalog, normal: [null] }), null);
  assert.equal(api.parseMutationCatalog({ ...catalog, collections: [{ ...series, groups: [null] }] }), null);
  const render = frontendHarness({
    '@/api': { __esModule: true, default: { get: () => assert.fail('bundled rule rendering must never ask for an account/backend') }, isReadCanceled: () => false },
    '@/config/localReadonly': { LOCAL_UI_READONLY: true },
    '@/composables/useContentMotion': { useSlidingTabs: selection => ({ select() {}, selected: selection }), vSlidingTabs: {}, vFoldMotion: {} },
  }, { globals: { __MUTATION_CATALOG__: catalog } });
  const html = await renderer.renderToString(vue.createSSRApp(render.load('components/MutationCatalogPanel.vue').default));
  assert.match(html, /本地规则/); assert.match(html, /搜索规则/); assert.match(html, /筛选变异效果/);
  assert.equal((html.match(/class="mutation-card ui-card"/g) || []).length, catalog.normal.length);
  assert.match(html, /黄金/); assert.match(html, /天工作物/);
  assert.doesNotMatch(html, /连接后可查看|模拟|示例|品质[1-4]/);
});

test('bundled rule build validates each recorded collection source and keeps source facts separate from local file hashes', () => {
  const { createHash } = require('node:crypto');
  const root = path.join(__dirname, '../src/gameConfig');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'collections/sources.json'), 'utf8'));
  for (const name of ['CollectionSeries', 'CollectionGroup', 'CollectionItem', 'MutantPublicity'])
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, `collections/${name}.json`))).digest('hex'), source.files[name].sha256, name);
  const build = fs.readFileSync(path.join(web, 'vite.config.ts'), 'utf8');
  assert.match(build, /source\.files\[key\]\?\.sha256 !== sha256/);
  assert.match(build, /__MUTATION_CATALOG__: JSON.stringify\(mutationBundle\)/);
  assert.match(build, /local-game-config/);
  assert.match(build, /bundledArt/);
  const pure = fs.readFileSync(path.join(__dirname, '../src/services/mutation-catalog-data.js'), 'utf8');
  assert.doesNotMatch(pure, /require\(|fs\.|network|sendMsg|fetch\(/);
});

test('activity overview never treats unloaded, stale, ended or unknown state as completed or adds a game write', async () => {
  const api = frontendHarness().load('utils/activity-overview.ts');
  const unknown = api.milkTeaOverview(null, { milk_tea_cashier: true });
  assert.equal(unknown.known, false); assert.equal(unknown.ready, null); assert.equal(unknown.done, null);
  const state = { active: true, settling: false, serverTime: 150, startTime: 100, endTime: 600, settleStartTime: 550,
    summary: { shopOpenAt: 101, hasUnclaimedWage: true, canUpgrade: true },
    shop: { pendingRewards: [{ itemCount: 1 }] }, fund: { unlocked: true, tiers: [{ state: 2, rewards: [{ itemCount: 1 }] }] },
    share: { daily: { claimed: true }, redDots: { daily: false }, milestones: [] } };
  const result = api.milkTeaOverview(state, { milk_tea_cashier: true, milk_tea_wages: false });
  assert.equal(result.tasks.find(task => task.id === 'cashier').status, 'ready');
  assert.equal(result.tasks.find(task => task.id === 'cashier').automated, true);
  assert.equal(result.tasks.find(task => task.id === 'wages').automated, false);
  assert.equal(result.tasks.find(task => task.id === 'upgrade').automated, null);
  assert.equal(result.tasks.find(task => task.id === 'share-daily').status, 'done');
  assert.match(result.note, /不代表已经领取/);
  assert.equal(api.milkTeaOverview(state, {}, true).ready, null);
  assert.equal(api.milkTeaOverview(state, {}, false, 500).ready, null, 'old display snapshot must not remain current');
  assert.equal(api.milkTeaOverview(state, {}, false, 600).ready, 0, 'past close boundary cannot reopen rewards');
  const settled = api.milkTeaOverview({ ...state, serverTime: 560 }, {}, false, 560);
  assert.equal(settled.tasks.some(task => task.id === 'upgrade'), false);
  const partial = api.milkTeaOverview({ ...state, shop: undefined }, {});
  assert.equal(partial.tasks.find(task => task.id === 'cashier').status, 'unknown');
  const event = { id: 1, name: '真实字段夹具', startTime: 100, endTime: 200, open: true, canClaim: true, canAnswer: true,
    directClaimed: false, quizClaimed: false, question: '题目', rewards: [{ count: 1 }], questionRewards: [{ count: 1 }] };
  const solar = api.solarOverview([event], [], 150, { solar_terms_claim: true });
  assert.equal(solar.ready, 2); assert.equal(solar.done, 0);
  const uncertain = api.solarOverview([event], [], 150, {}, new Set(['claim:1', 'answer:1']));
  assert.equal(uncertain.ready, 0); assert.ok(uncertain.tasks.every(task => task.status === 'unknown'));
  assert.equal(api.solarOverview([{ ...event, quizWrongToday: true }], [], 150, {}).tasks.find(task => task.id === 'answer:1').status, 'idle');
  assert.equal(api.solarOverview([event], [], 201, {}).tasks.length, 0);
  const html = await renderComponent('components/activity/ActivityOverviewPanel.vue', { overview: unknown });
  assert.match(html, /进度待确认/); assert.doesNotMatch(html, /已领取|操作成功/);
  const readyHtml = await renderComponent('components/activity/ActivityOverviewPanel.vue', { overview: result });
  assert.match(readyHtml, /自动处理已开启/); assert.match(readyHtml, /需手动查看处理/); assert.match(readyHtml, /自动设置待确认/);
  assert.doesNotMatch(read('utils/activity-overview.ts'), /api\.|fetch\(|localStorage|sessionStorage|setInterval/);
  assert.doesNotMatch(read('components/activity/ActivityOverviewPanel.vue'), /emit\('claim'|api\.post/);
});

test('confirmed automation snapshot is account-scoped and a late settings response cannot leak its label to another account', async () => {
  const selected = vue.ref('A'), pending = deferred();
  const h = frontendHarness({
    '@/api': { __esModule: true, default: { get: () => pending.promise } },
    '@/stores/account': { useAccountStore: () => ({ get currentAccountId() { return selected.value; } }) },
  });
  const instance = pinia.createPinia();
  try {
    const store = h.load('stores/setting.ts').useSettingStore(instance);
    const request = store.fetchSettings('A');
    selected.value = 'B';
    pending.resolve({ data: { ok: true, data: { automation: { milk_tea_cashier: true } } } });
    await request;
    assert.equal(store.settingsAccountId, ''); assert.equal(store.confirmedAutomation, null);
  } finally { pinia.disposePinia(instance); }
});

test('diagnostic chrome is opt-in and anonymous empty states do not invite an unavailable login', () => {
  const monitor = read('utils/requestMonitor.ts');
  assert.match(monitor, /mountMonitorBadge\(\) \{\s*if \(!isRequestDiagnosticsEnabled\(\)\) return/);
  assert.match(monitor, /localStorage.getItem\(ENABLE_KEY\) === '1'/);
  assert.match(read('components/settings/UserSettingsTab.vue'), /role="switch"/);
  const api = frontendHarness().load('config/localReadonly.ts');
  assert.match(api.accountDataEmptyState(true, '').title, /本地仅查看/);
  assert.match(api.accountDataEmptyState(true, '').description, /账号数据不可用/);
  assert.doesNotMatch(api.accountDataEmptyState(true, '').description, /连接后|选择账号/);
  assert.doesNotMatch(read('views/Activity.vue'), /class="activity-account"/);
  assert.match(read('layouts/DefaultLayout.vue'), /v-if="LOCAL_UI_READONLY" class="layout-readonly-status"/);
});

test('counted tab labels have symmetric fixed rails including hidden counts rather than asymmetric inline width', () => {
  const css = read('App.vue');
  assert.match(css, /\.ui-tab\.ui-tab-counted \{[^}]*grid-template-columns: 24px auto 24px/);
  assert.match(css, /\.ui-tab-counted > \.ui-tab-icon \{[^}]*width: 24px/);
  for (const file of ['views/Activity.vue', 'components/MutationCatalogPanel.vue']) {
    assert.match(read(file), /ui-tab ui-tab-counted/); assert.match(read(file), /class="ui-tab-icon"/);
    assert.match(read(file), /ui-tab-count/);
  }
});

test('account UI storage allowlist excludes game snapshots and confirmations, isolates login identities and accounts', () => {
  const local = storage(), session = storage();
  local.setItem('user_info', JSON.stringify({ username: 'tester-A' }));
  const h = frontendHarness({}, { localStorage: local, sessionStorage: session });
  const ui = h.load('composables/useAccountUiState.ts');
  ui.writeAccountUiState('A', 'bag', { category: 'seed', search: '茶', density: 'compact',
    selectedItems: [1], confirmed: true, gameState: { gold: 3 }, token: 'should-not-be-saved' });
  const saved = ui.readAccountUiState('A', 'bag');
  assert.equal(saved.category, 'seed');
  assert.equal(saved.search, '茶');
  assert.deepEqual(Object.keys(saved).sort(), ['category', 'density', 'search']);
  assert.equal(Object.keys(ui.readAccountUiState('B', 'bag')).length, 0);
  assert.ok(![...session.values.values()].join('').includes('should-not-be-saved'));
  local.setItem('user_info', JSON.stringify({ username: 'tester-B' }));
  assert.equal(Object.keys(ui.readAccountUiState('A', 'bag')).length, 0);
});

test('account UI preferences survive module reload, corrupted/blocked storage degrades safely and retains bounded entries', () => {
  const local = storage(), session = storage();
  local.setItem('user_info', JSON.stringify({ username: 'tester' }));
  const first = frontendHarness({}, { localStorage: local, sessionStorage: session }).load('composables/useAccountUiState.ts');
  first.writeAccountUiState('A', 'personal', { tab: 'bag' });
  const second = frontendHarness({}, { localStorage: local, sessionStorage: session }).load('composables/useAccountUiState.ts');
  assert.equal(second.readAccountUiState('A', 'personal').tab, 'bag');
  session.setItem('farm-ui-v1:A:bag', 'broken-json');
  assert.equal(Object.keys(second.readAccountUiState('A', 'bag')).length, 0);
  for (let i = 0; i < 100; i++) second.writeAccountUiState(`A${i}`, 'bag', { category: 'fruit' });
  assert.ok(session.length <= 65);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const fallback = frontendHarness({}, { localStorage: blocked, sessionStorage: blocked }).load('composables/useAccountUiState.ts');
  fallback.writeAccountUiState('A', 'bag', { category: 'tool' });
  assert.equal(fallback.readAccountUiState('A', 'bag').category, 'tool');
});

function dataStoreHarness(relative, get, post = () => assert.fail('unexpected write')) {
  const selected = vue.ref('A');
  const account = { get currentAccountId() { return selected.value; } };
  const h = frontendHarness({ '@/api': { __esModule: true, default: { get, post }, isReadCanceled: error => error?.code === 'ERR_CANCELED' },
    '@/stores/account': { useAccountStore: () => account } });
  const instance = pinia.createPinia();
  const module = h.load(relative);
  const store = (module.useBagStore || module.useFriendStore)(instance);
  return { store, selected, dispose: () => pinia.disposePinia(instance) };
}
const bagReply = (count = 5) => ({ data: { ok: true, data: { items: [{ id: 20003, uid: '9999999999999999', count }], originalItems: [{ id: 20003, uid: '9999999999999999', count }] } } });
test('bag same-account reads share a flight and failed refresh preserves display with an explicit error', async () => {
  const pending = deferred(); let reads = 0;
  const h = dataStoreHarness('stores/bag.ts', async () => { reads++; return reads === 1 ? pending.promise : Promise.reject(new Error('offline')); });
  try {
    const a = h.store.fetchBag('A'), b = h.store.fetchBag('A');
    assert.equal(reads, 1);
    pending.resolve(bagReply()); await Promise.all([a, b]);
    const updated = h.store.lastUpdatedAt;
    assert.equal(h.store.items[0].count, 5);
    await h.store.fetchBag('A');
    assert.equal(h.store.items[0].count, 5);
    assert.match(h.store.readError, /offline/);
    assert.equal(h.store.lastUpdatedAt, updated);
  } finally { h.dispose(); }
});
test('bag A-B-A delayed reads cannot restore old data or restore loading/error state', async () => {
  const pending = deferred();
  const h = dataStoreHarness('stores/bag.ts', async () => pending.promise);
  try {
    const result = h.store.fetchBag('A');
    h.selected.value = 'B'; h.selected.value = 'A';
    pending.resolve(bagReply(999));
    assert.equal(await result, false);
    assert.equal(h.store.items.length, 0);
    assert.equal(h.store.loading, false);
    assert.equal(h.store.lastUpdatedAt, 0);
  } finally { h.dispose(); }
});
test('bag write pending shared across repeated clicks; read refresh does not invalidate a real write result', async () => {
  const pending = deferred(); let writes = 0;
  const h = dataStoreHarness('stores/bag.ts', async () => bagReply(), async () => { writes++; return pending.promise; });
  try {
    const request = [{ id: 20003, count: 1, uid: '9999999999999999' }];
    const a = h.store.sellItems('A', request), b = h.store.sellItems('A', request);
    assert.equal(writes, 1); assert.equal(h.store.mutationStates.A, 'pending');
    assert.equal(await h.store.fetchBag('A'), false, 'pending write must not add a game read or overwrite its result');
    pending.resolve({ data: { ok: true, data: { sell_items: request, get_items: [{ id: 1001, count: 24 }] } } });
    const result = await a; await b;
    assert.equal(result.ok, true); assert.equal(result.stale, false);
    assert.equal(h.store.mutationStates.A, 'idle');
  } finally { h.dispose(); }
});
test('bag unknown write remains blocked across component remount and account switch, never succeeds from HTTP200 alone', async () => {
  let writes = 0;
  const h = dataStoreHarness('stores/bag.ts', async () => bagReply(), async () => { writes++; return { data: { ok: true, data: { get_items: [{ id: 1001, count: 50 }] } } }; });
  try {
    const request = [{ id: 20003, count: 1, uid: '1' }];
    const result = await h.store.sellItems('A', request);
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
    h.selected.value = 'B'; h.selected.value = 'A';
    await h.store.fetchBag('A');
    const again = await h.store.sellItems('A', request);
    assert.equal(again.outcomeUnknown, true); assert.equal(writes, 1);
  } finally { h.dispose(); }
});
test('bag custom/all quantity is a positive integer bounded by the selected unlocked instance; fireworks remain single use', () => {
  const rules = frontendHarness().load('utils/operation-result.ts');
  const item = { id: 101619, count: 7, uid: '9007199254740993', locked: false };
  for (const amount of [1, 3, '7']) {
    const checked = rules.validateItemUseQuantity(item, amount);
    assert.equal(checked.error, ''); assert.equal(checked.count, Number(amount)); assert.equal(checked.limit, 7);
  }
  for (const amount of [0, -1, 1.5, '', null, true, '1e2', '2.1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8]) {
    const checked = rules.validateItemUseQuantity(item, amount);
    assert.equal(checked.count, 0, String(amount)); assert.ok(checked.error, String(amount));
  }
  for (const locked of [true, 1, '1']) assert.equal(rules.itemUseLimit({ ...item, locked }), 0);
  assert.equal(rules.itemUseLimit(null), 0);
  assert.equal(rules.itemUseLimit({ ...item, count: '9007199254740993' }), 0);
  const firework = { ...item, id: 6001, count: 99 };
  assert.equal(rules.itemUseLimit(firework), 1);
  assert.match(rules.validateItemUseQuantity(firework, 2).error, /一枚/);
});
test('bag custom quantity submits one exact count and UID, freezes the pending request and confirms the returned amount', async () => {
  const pending = deferred(), calls = [];
  const h = dataStoreHarness('stores/bag.ts', async () => bagReply(), async (url, body, options) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(body)), options }); return pending.promise;
  });
  try {
    const first = h.store.useItem('A', 101619, 7, '9007199254740993');
    const repeated = h.store.useItem('A', 101619, 3, '9007199254740993');
    assert.equal(calls.length, 1); assert.equal(calls[0].body.count, 7);
    assert.equal(calls[0].body.uid, '9007199254740993'); assert.equal(calls[0].options.headers['x-account-id'], 'A');
    assert.equal(await h.store.fetchBag('A'), false);
    pending.resolve({ data: { ok: true, data: { resultState: 'completed', usedItemId: 101619, usedCount: 7, rewards: [{ id: 700001, count: 7 }] } } });
    assert.equal((await first).ok, true); assert.equal((await repeated).data.usedCount, 7);
    assert.equal(h.store.mutationStates.A, 'idle');
  } finally { h.dispose(); }
});
test('bag invalid quantity or unsafe UID refuses before HTTP, partial use reply locks the account without retrying a smaller amount', async () => {
  let writes = 0;
  const h = dataStoreHarness('stores/bag.ts', async () => bagReply(), async () => {
    writes++; return { data: { ok: true, data: { resultState: 'completed', usedCount: 1 } } };
  });
  try {
    for (const amount of [0, -1, 1.5, true, null, '', NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await h.store.useItem('A', 101619, amount, '11'); assert.equal(result.sent, false);
    }
    assert.equal((await h.store.useItem('A', 101619, 1, Number.MAX_SAFE_INTEGER + 1)).sent, false);
    assert.equal(writes, 0);
    const result = await h.store.useItem('A', 101619, 5, '11');
    assert.equal(result.ok, false); assert.equal(result.outcomeUnknown, true);
    h.selected.value = 'B'; h.selected.value = 'A';
    assert.equal((await h.store.useItem('A', 101619, 1, '11')).outcomeUnknown, true);
    assert.equal(writes, 1);
  } finally { h.dispose(); }
});
test('real quantity dialog exposes custom/all controls, disables invalid confirmation and never stores quantities or changes the single-use contract', async () => {
  const source = read('components/BagPanel.vue');
  assert.match(source, /全部使用/); assert.match(source, /自定义使用数量/);
  assert.match(source, /handleUseClick\(item, itemUseLimit\(item\)\)/);
  assert.match(source, /requestedUse!\.count, action\.item\.uid/);
  assert.match(source, /:confirm-disabled="dialogAction\?\.action === 'use' && !!useValidation\.error"/);
  assert.doesNotMatch(source, /bagStore\.useItem\([^\n]+, 1, action\.item\.uid\)/);
  const descriptor = compiler.parse(source, { filename: 'BagPanel.vue' });
  assert.equal(descriptor.errors.length, 0); compiler.compileScript(descriptor.descriptor, { id: 'bag-quantity', inlineTemplate: true });
  const html = await renderComponent('components/ConfirmModal.vue', { show: true, confirmDisabled: true });
  assert.match(html, /确认操作/); assert.match(html, /disabled/);
  assert.match(read('components/ConfirmModal.vue'), /props\.confirmDisabled/);
});
test('result presentation does not label zero-op or unknown as success, sale gains come only from actual get_items', () => {
  const result = frontendHarness().load('utils/operation-result.ts');
  assert.equal(result.feedbackForResult({ ok: true, count: 0, message: '没有可捣乱土地' }, 'fallback').state, 'info');
  assert.equal(result.feedbackForResult({ ok: true, outcomeUnknown: true }, 'fallback').state, 'unknown');
  assert.equal(result.operationFailure(new Error('network')).resultState, 'unknown');
  assert.equal(result.operationFailure({ sent: false, message: 'queued' }).resultState, 'not_sent');
  assert.equal(result.actualSaleRewards({ estimate: 100 }).length, 0);
  assert.equal(result.actualSaleRewards({ get_items: [{ id: 1001, count: '9007199254740993' }] })[0].count, '9007199254740993');
});
test('account presentation table keeps ownership, null, process state and stale evidence separate', () => {
  const { deriveAccountPresentation: derive } = frontendHarness().load('utils/operation-result.ts');
  const snapshot = { accountId: 'A', connection: { connected: true } };
  const metadata = { accountId: 'A', updatedAt: 1000, source: 'ws' };
  const base = { accountId: 'A', account: { id: 'A', running: true }, snapshot, snapshotReady: true };
  const cases = [
    ['当前归属且明确连接', {}, 'online'],
    ['只有进程运行', { snapshot: null }, 'unknown'],
    ['未归属当前快照', { snapshotReady: false }, 'unknown'],
    ['缺少明确 ready', { snapshotReady: undefined }, 'unknown'],
    ['旧账号快照', { snapshot: { ...snapshot, accountId: 'B' } }, 'unknown'],
    ['旧账号元数据', { snapshot: { ...snapshot, metadata: { ...metadata, accountId: 'B' } } }, 'unknown'],
    ['旧账号 account', { account: { id: 'B', running: false } }, 'unknown'],
    ['明确连接断开且进程运行', { snapshot: { ...snapshot, connection: { connected: false } } }, 'offline'],
    ['null 不等于 false', { snapshot: { ...snapshot, connection: { connected: null } } }, 'unknown'],
    ['缺少连接字段', { snapshot: { accountId: 'A' } }, 'unknown'],
    ['数字 0 不是明确 false', { snapshot: { ...snapshot, connection: { connected: 0 } } }, 'unknown'],
    ['字符串 true 不是明确 true', { snapshot: { ...snapshot, connection: { connected: 'true' } } }, 'unknown'],
    ['明确停止', { running: false, snapshot: null }, 'stopped'],
    ['停止覆盖旧连接 true', { running: false }, 'stopped'],
    ['running null 不阻止真实连接', { running: null }, 'online'],
    ['无账号普通模式', { accountId: '', loading: true, error: '失败' }, 'unselected'],
    ['无账号只读模式', { accountId: '', readonly: true, loading: true, error: '失败' }, 'readonly'],
    ['首次加载', { snapshot: null, loading: true }, 'loading'],
    ['刷新仍保留已确认快照', { loading: true }, 'online'],
    ['明确接口错误', { error: '状态读取失败' }, 'error'],
    ['真实 stale 参数', { stale: true }, 'stale'],
    ['真实快照 stale 字段', { snapshot: { ...snapshot, stale: true } }, 'stale'],
    ['无快照不能凭 stale 猜测', { snapshot: null, stale: true, transportConnected: false }, 'unknown'],
    ['断开但没有来源信息不猜 stale', { transportConnected: false }, 'online'],
    ['旧 WS 快照与明确传输中断', { snapshot: { ...snapshot, metadata }, transportConnected: false }, 'stale'],
    ['未知传输不等于断开', { snapshot: { ...snapshot, metadata }, transportConnected: null }, 'online'],
    ['HTTP 回包不依赖 WS 连接', { snapshot: { ...snapshot, metadata: { ...metadata, source: 'http' } }, transportConnected: false }, 'online'],
    ['不凭更新时间硬猜过时', { snapshot: { ...snapshot, metadata }, transportConnected: true }, 'online'],
    ['uin 可作为当前归属', { accountId: '42', account: { uin: '42' }, snapshot: { connection: { connected: true } } }, 'online'],
  ];
  for (const [name, changes, kind] of cases) {
    const input = { ...base, ...changes }, before = JSON.stringify(input), result = derive(input);
    assert.equal(result.kind, kind, name);
    assert.equal(result.pulse, kind === 'online', name);
    assert.equal(typeof result.label, 'string', name); assert.ok(result.detail, name);
    assert.equal(JSON.stringify(input), before, `${name}：纯派生不能修改输入`);
    if (kind === 'unknown' || kind === 'unselected' || kind === 'readonly') assert.notEqual(result.tone, 'success', name);
  }
  assert.equal(derive(base).updatedAt, null);
  assert.equal(derive({ ...base, snapshot: { ...snapshot, metadata } }).updatedAt, 1000);
});

function accountStatusHarness(get) {
  const selected = vue.ref('A'), handlers = new Map(), requests = [], emissions = [];
  let time = 1000, connects = 0;
  const socket = { connected: false, auth: {},
    on(name, handler) { handlers.set(name, handler); }, off(name) { handlers.delete(name); },
    emit(name, payload) { emissions.push({ name, payload }); },
    connect() { connects++; this.connected = true; handlers.get('connect')?.(); },
    disconnect() { this.connected = false; handlers.get('disconnect')?.(); } };
  class TestDate extends Date { static now() { return time; } }
  const h = frontendHarness({
    '@/api': { __esModule: true, default: { get: (...args) => { requests.push(args); return get(...args); } } },
    '@/stores/account': { useAccountStore: () => ({ get currentAccountId() { return selected.value; } }) },
    '@/config/localReadonly': { LOCAL_UI_READONLY: false },
    '@vueuse/core': { useStorage: () => vue.ref('offline-fixture') },
    'socket.io-client': { io: () => socket },
  }, { globals: { Date: TestDate } });
  const instance = pinia.createPinia(), store = h.load('stores/status.ts').useStatusStore(instance);
  return { store, selected, requests, emissions, socket, handlers, get connects() { return connects; },
    setTime(value) { time = value; }, dispose: () => pinia.disposePinia(instance) };
}

test('account status metadata accepts only current valid HTTP replies and preserves errors on log success', async () => {
  let response = { data: { ok: true, data: { connection: { connected: null } } } };
  const h = accountStatusHarness(async () => response);
  try {
    assert.equal(h.store.currentStatusMetadata, null);
    await h.store.fetchStatus('B'); assert.equal(h.requests.length, 0);
    await h.store.fetchStatus('A');
    assert.equal(h.store.currentStatusReady, true);
    assert.equal(h.store.status.connection.connected, null);
    assert.equal(JSON.stringify(h.store.currentStatusMetadata), JSON.stringify({ accountId: 'A', updatedAt: 1000, source: 'http' }));
    const failures = [
      { data: { ok: false } }, { data: { ok: false, error: '接口失败' } }, { data: { ok: true, data: null } },
      { data: { ok: true, data: [] } }, { data: { ok: true, accountId: 'B', data: {} } },
      { data: { ok: true, data: { accountId: 'B', connection: { connected: true } } } },
    ];
    h.setTime(2000);
    for (const failure of failures) {
      response = failure; await h.store.fetchStatus('A');
      assert.ok(h.store.error); assert.equal(h.store.loading, false);
      assert.equal(h.store.currentStatusMetadata.updatedAt, 1000);
      assert.equal(h.store.status.connection.connected, null);
    }
    response = { data: { ok: true, data: [] } };
    const error = h.store.error; await h.store.fetchLogs('A'); assert.equal(h.store.error, error);
    response = { data: { ok: true, data: { connection: { connected: false } } } };
    await h.store.fetchStatus('A'); assert.equal(h.store.error, '');
    assert.equal(h.store.currentStatusMetadata.updatedAt, 2000);
    assert.equal(h.store.status.connection.connected, false);
    h.store.statusAccountId = 'B';
    assert.equal(h.store.currentStatusReady, false); assert.equal(h.store.currentStatusMetadata, null);
    h.store.clearAccountScopedData();
    assert.equal(h.store.status, null); assert.equal(h.store.statusMetadata, null);
    assert.equal(h.store.statusAccountId, ''); assert.equal(h.store.error, '');
  } finally { h.dispose(); }
});

test('account status metadata ignores delayed A-B-A HTTP success and errors without adding reads', async () => {
  for (const outcome of ['success', 'failure', 'rejection']) {
    const pending = deferred(); let reads = 0;
    const h = accountStatusHarness(async () => ++reads === 1 ? pending.promise : { data: { ok: true, data: { connection: { connected: false } } } });
    try {
      const first = h.store.fetchStatus('A'), shared = h.store.fetchStatus('A');
      assert.equal(first, shared); assert.equal(reads, 1);
      h.selected.value = 'B'; h.selected.value = 'A';
      assert.equal(h.store.loading, false); assert.equal(h.store.statusMetadata, null);
      h.setTime(2000); await h.store.fetchStatus('A');
      if (outcome === 'rejection') pending.reject({ response: { data: { error: '旧账号接口失败' } } });
      else pending.resolve({ data: { ok: outcome === 'success', error: outcome === 'failure' ? '旧账号失败' : undefined, data: { connection: { connected: true } } } });
      await Promise.all([first, shared]);
      assert.equal(h.store.currentStatusMetadata.updatedAt, 2000, outcome);
      assert.equal(h.store.status.connection.connected, false, outcome); assert.equal(h.store.error, '', outcome);
      assert.equal(reads, 2, outcome);
      h.selected.value = 'B';
      assert.equal(h.store.status, null); assert.equal(h.store.statusAccountId, ''); assert.equal(h.store.currentStatusMetadata, null);
    } finally { h.dispose(); }
  }
  const h = accountStatusHarness(async () => { throw { response: { data: { error: '当前接口失败' } } }; });
  try { await h.store.fetchStatus('A'); assert.equal(h.store.error, '当前接口失败'); assert.equal(h.store.statusMetadata, null); }
  finally { h.dispose(); }
});

test('牧场运行状态接口：HTTP与WS保留真实调度字段，切号不沿用旧账号状态', async () => {
  const routine = { enabled: true, running: false, nextCheckAt: 123456, lastStartedAt: 120000,
    lastFinishedAt: 121000, lastResult: 'error', lastError: '真实巡查异常', farmMin: 2, farmMax: 5 };
  const h = accountStatusHarness(async () => ({ data: { ok: true, accountId: 'A', data: { ranchAutomation: routine } } }));
  try {
    await h.store.fetchStatus('A');
    assert.deepEqual(JSON.parse(JSON.stringify(h.store.status.ranchAutomation)), routine);
    assert.equal(h.store.statusAccountId, 'A'); assert.equal(h.requests.length, 1);
    h.store.connectRealtime('A');
    h.handlers.get('status:update')({ accountId: 'A', status: { ranchAutomation: { ...routine, nextCheckAt: 234567, lastResult: 'yielded' } } });
    assert.equal(h.store.status.ranchAutomation.nextCheckAt, 234567); assert.equal(h.requests.length, 1);
    h.selected.value = 'B'; assert.equal(h.store.currentStatusReady, false); assert.equal(h.store.status, null);
    h.handlers.get('status:update')({ accountId: 'A', status: { ranchAutomation: routine } });
    assert.equal(h.store.status, null);
  } finally { h.dispose(); }
});

test('account status WS metadata latches interruption until a valid current snapshot and never crosses accounts', () => {
  const h = accountStatusHarness(() => assert.fail('WS 纯测试不得发起 HTTP 请求'));
  const push = payload => h.handlers.get('status:update')(payload);
  try {
    h.store.connectRealtime('A');
    push({ accountId: 'B', status: { connection: { connected: true } } });
    assert.equal(h.store.statusMetadata, null);
    push({ accountId: 'A', status: { connection: { connected: true } } });
    assert.equal(h.store.currentStatusMetadata.source, 'ws'); assert.equal(h.store.currentStatusMetadata.updatedAt, 1000);
    h.socket.disconnect(); assert.equal(h.store.currentStatusStale, true);
    h.store.connectRealtime('A'); assert.equal(h.store.realtimeConnected, true);
    assert.equal(h.store.currentStatusStale, true, '仅连上传输不能确认旧游戏快照恢复在线');
    h.setTime(2000);
    for (const payload of [
      { accountId: 'B', error: '其他账号失败' },
      { accountId: 'A', ok: false },
      { accountId: 'A', status: { accountId: 'B' } },
      { accountId: 'A', status: [] },
    ]) { push(payload); assert.equal(h.store.currentStatusMetadata.updatedAt, 1000); }
    assert.ok(h.store.error); assert.equal(h.store.currentStatusStale, true);
    push({ accountId: 'A', status: { connection: { connected: null } } });
    assert.equal(h.store.error, ''); assert.equal(h.store.currentStatusStale, false);
    assert.equal(h.store.currentStatusMetadata.updatedAt, 2000);
    h.store.disconnectRealtime(); assert.equal(h.store.currentStatusStale, true);
    h.selected.value = 'B'; assert.equal(h.store.statusMetadata, null); assert.equal(h.store.currentStatusStale, false);
    h.store.connectRealtime('B');
    push({ accountId: 'A', status: { connection: { connected: true } } }); assert.equal(h.store.status, null);
    push({ accountId: 'B', status: { connection: { connected: false } } });
    assert.equal(h.store.statusAccountId, 'B'); assert.equal(h.store.currentStatusMetadata.accountId, 'B');
    assert.equal(h.requests.length, 0);
    h.handlers.get('subscribed')({ accountId: 'B' });
    const count = h.emissions.length, connects = h.connects;
    h.store.connectRealtime('B'); assert.equal(h.emissions.length, count); assert.equal(h.connects, connects);
  } finally { h.dispose(); }
});

test('account sidebar uses unified presentation and only explicit system failure overrides account state', () => {
  const code = read('components/Sidebar.vue').match(/const connectionStatus = computed\(\(\) => \{[\s\S]*?\n\}\)/)[0];
  const derive = frontendHarness().load('utils/operation-result.ts').deriveAccountPresentation;
  for (const [system, readonly, selected, ready, connected, kind, text] of [
    [null, false, 'A', true, true, 'online', '在线'], [true, false, 'A', true, null, 'unknown', '状态待确认'],
    [true, false, 'A', false, true, 'unknown', '状态待确认'], [true, false, '', false, null, 'unselected', '未选择账号'],
    [false, false, 'A', true, true, undefined, '系统离线'], [false, true, '', false, null, 'readonly', '本地只读 · 未登录'],
  ]) {
    const context = { computed: vue.computed, deriveAccountPresentation: derive, LOCAL_UI_READONLY: readonly,
      currentAccountId: vue.ref(selected), currentAccount: vue.ref(selected ? { id: selected, running: true } : null),
      status: vue.ref({ connection: { connected } }), systemConnected: vue.ref(system),
      statusStore: { statusAccountId: 'A', currentStatusReady: ready, currentStatusMetadata: null, currentStatusStale: false, loading: false, error: '' } };
    const result = vm.runInNewContext(code.replace('const connectionStatus = ', ''), context).value;
    assert.equal(result.text, text); assert.equal(result.kind, kind);
    if (text === '系统离线') assert.equal(result.pulse, false);
  }
});

test('friend operation awaits one real result, isolates late A-B-A writes and never refreshes friend lands to animate feedback', async () => {
  let writes = 0, reads = 0; const pending = deferred();
  const h = dataStoreHarness('stores/friend.ts', () => { reads++; assert.fail('operation must not trigger a preview Enter'); }, async () => { writes++; return pending.promise; });
  try {
    const a = h.store.operate('A', '10001', 'bad'), b = h.store.operate('A', '10001', 'bad');
    assert.equal(writes, 1); assert.equal(h.store.operationStates.A, 'pending');
    h.selected.value = 'B'; h.selected.value = 'A';
    pending.resolve({ data: { ok: true, data: { ok: true, count: 2, message: '捣乱完成' } } });
    assert.equal((await a).stale, true); await b;
    assert.equal(reads, 0);
    assert.match(read('views/Friends.vue'), /const result = await friendStore\.operate\(id, target, type\)/);
    assert.doesNotMatch(read('views/Friends.vue'), /return \{ ok: true \}/);
  } finally { h.dispose(); }
});
test('friend unknown returns never re-submit, and definite failure remains a definite failure', async () => {
  let writes = 0;
  const h = dataStoreHarness('stores/friend.ts', () => assert.fail('unexpected read'), async () => { writes++; throw new Error('network timeout'); });
  try {
    assert.equal((await h.store.operate('A', '10001', 'bad')).resultState, 'unknown');
    assert.equal((await h.store.operate('A', '10001', 'bad')).resultState, 'unknown');
    assert.equal(writes, 1);
  } finally { h.dispose(); }
});

test('sale evidence decodes actual protobuf int64 JSON fields without precision loss or duplicate-request undercount', () => {
  const rules = frontendHarness().load('utils/operation-result.ts');
  const protobuf = require('protobufjs');
  const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/itempb.proto'), { keepCase: true });
  const type = root.lookupType('gamepb.itempb.SellReply');
  const value = type.decode(type.encode(type.fromObject({ sell_items: [{ id: 40003, uid: '9007199254740993', count: 3 }], get_items: [{ id: 1001, count: '9007199254740993' }] })).finish());
  // Simulate the existing fork worker JSON transport: Long instances lose methods.
  const transported = JSON.parse(JSON.stringify(value, (key, item) => item && typeof item === 'object' && typeof item.low === 'number' ? { low: item.low, high: item.high, unsigned: item.unsigned } : item));
  assert.equal(rules.integerText({ low: 1, high: 2097152, unsigned: false }), '9007199254740993');
  assert.equal(rules.actualSaleRewards(transported)[0].count, '9007199254740993');
  assert.equal(rules.saleConsumptionConfirmed(transported, [{ id: 40003, uid: '9007199254740993', count: 3 }]), true);
  assert.equal(rules.saleConsumptionConfirmed(transported, [{ id: 40003, uid: '9007199254740993', count: 2 }, { id: 40003, uid: '9007199254740993', count: 2 }]), false);
  assert.equal(rules.integerText({ low: -1, high: -1, unsigned: false }), null);
});

test('unknown response metadata always outranks optimistic HTTP status or nested ok fields', () => {
  const rules = frontendHarness().load('utils/operation-result.ts');
  assert.equal(rules.operationFailure({ response: { status: 400, data: { sent: true, outcomeUnknown: true } } }).outcomeUnknown, true);
  const confirmedFailure = rules.operationFailure({ response: { status: 400, data: { sent: true, resultState: 'failed' } } });
  assert.equal(confirmedFailure.sent, true); assert.equal(confirmedFailure.resultState, 'failed');
  assert.equal(rules.feedbackForResult({ ok: true }, 'fallback').state, 'info');
});

test('friend definite rejection and a canceled not-sent operation do not permanently block later manual actions', async () => {
  let writes = 0;
  const h = dataStoreHarness('stores/friend.ts', () => assert.fail('unexpected read'), async () => {
    writes++; return { data: { ok: false, sent: false, resultState: 'not_sent', error: 'queue full' } };
  });
  try {
    const result = await h.store.operate('A', '10001', 'bad');
    assert.equal(result.outcomeUnknown, false); assert.equal(result.resultState, 'not_sent');
    await h.store.operate('A', '10001', 'bad');
    assert.equal(writes, 2);
  } finally { h.dispose(); }
});

test('sidebar optimistic selection precedes routing and stale failures cannot undo the latest click or reselect', async () => {
  let route = '/', api; const pending = [], feedback = [];
  const navigate = destination => {
    assert.equal(api.selected.value, destination, 'selection must precede the navigation call');
    const waiter = deferred(); pending.push({ ...waiter, destination }); return waiter.promise;
  };
  api = frontendHarness().load('composables/useContentMotion.ts').createNavigationSelection(() => route, navigate, () => feedback.push(api.selected.value));
  try {
    const first = api.select('/personal'), second = api.select('/settings');
    assert.equal(api.selected.value, '/settings'); assert.deepEqual(feedback, ['/personal', '/settings']);
    pending[0].reject(new Error('stale import')); await first; assert.equal(api.selected.value, '/settings');
    route = '/settings'; api.sync(route); pending[1].resolve(); await second; assert.equal(api.selected.value, route);
    const failed = api.select('/friends'); pending[2].reject(new Error('current import failed')); await failed;
    assert.equal(api.selected.value, '/settings');
    route = '/shop'; api.sync(route); assert.equal(api.selected.value, '/shop', 'browser history did not sync');
    const old = api.select('/personal'), reselect = api.select('/shop');
    pending[4].resolve(); await reselect; pending[3].reject(new Error('canceled old route')); await old;
    assert.equal(api.selected.value, '/shop');
    const redirect = api.select('/friends'); route = '/activity'; api.sync(route); assert.equal(api.selected.value, '/friends');
    pending[5].resolve(); await redirect; assert.equal(api.selected.value, '/activity', 'redirect must settle to actual route');
    const unmounted = api.select('/settings'); api.dispose(); pending[6].resolve(); await unmounted;
    const count = pending.length; await api.select('/'); assert.equal(pending.length, count);
  } finally { api.dispose(); }
});

function indicatorHarness() {
  const frames = new Map(), listeners = new Map(); let sequence = 0;
  const element = { isConnected: true, style: {} };
  const media = { matches: false, addEventListener: (_name, callback) => listeners.set('media', callback), removeEventListener: () => listeners.delete('media') };
  const document = { hidden: false, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const h = frontendHarness({}, { globals: { document, window: {
    matchMedia: () => media, requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
  } } });
  const motion = h.load('composables/useContentMotion.ts').createNavigationIndicatorMotion(() => element);
  return { motion, element, media, document, frames, listeners,
    position: () => Number(element.style.transform.match(/, ([\d.-]+)px/)[1]),
    step(now) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now)); } };
}

test('sidebar selection spring retargets from its exact current position and never queues competing frames', () => {
  const h = indicatorHarness();
  try {
    assert.equal(h.motion.move(0, 44), true); assert.equal(h.position(), 0); assert.equal(h.frames.size, 0);
    h.motion.move(400, 44); assert.equal(h.position(), 0); assert.equal(h.frames.size, 1);
    h.step(0); h.step(17); h.step(34);
    const current = h.position(); assert.ok(current > 0 && current < 400);
    h.motion.move(-50, 44); assert.equal(h.position(), current, 'retarget must not snap to either row'); assert.equal(h.frames.size, 1);
    h.motion.move(100, 44); assert.equal(h.position(), current); assert.equal(h.frames.size, 1);
    for (let time = 51; time < 1500 && h.frames.size; time += 17) h.step(time);
    assert.equal(h.position(), 100); assert.equal(h.frames.size, 0); assert.equal(h.element.style.height, '44px');
    assert.equal(h.motion.move(NaN, 44), false); assert.equal(h.motion.move(100, 0), false);
  } finally { h.motion.dispose(); }
});

test('sidebar selection settles on reduced motion, resize/visibility and disposes its only animation frame', () => {
  const h = indicatorHarness();
  try {
    h.motion.move(0, 44); h.motion.move(200, 44); h.step(0);
    h.media.matches = true; h.listeners.get('media')(); assert.equal(h.position(), 200); assert.equal(h.frames.size, 0);
    h.motion.move(70, 48); assert.equal(h.position(), 70); assert.equal(h.frames.size, 0);
    h.media.matches = false; h.motion.move(300, 44); h.step(17);
    h.document.hidden = true; h.listeners.get('visibilitychange')(); assert.equal(h.position(), 300); assert.equal(h.frames.size, 0);
    h.document.hidden = false; h.motion.move(40, 44, true); assert.equal(h.position(), 40);
    h.motion.move(600, 44); assert.equal(h.frames.size, 1); h.motion.dispose();
    assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.motion.move(0, 44), false);
  } finally { h.motion.dispose(); }
});

test('sidebar keeps one live theme selection surface, real anchors, immediate feedback and latest-intent rollback', () => {
  const source = read('components/Sidebar.vue');
  assert.equal((source.match(/class="sidebar-nav-indicator"/g) || []).length, 1);
  assert.match(source, /v-slot="\{ href \}"[\s\S]*custom/);
  assert.match(source, /:href="href"/); assert.match(source, /:data-selected="selectedNavPath === item.path"/);
  assert.match(source, /:aria-current="route.path === item.path \? 'page'/);
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
  assert.match(source, /createNavigationSelection\(\(\) => route\.path, path => router\.push\(path\)/);
  assert.match(source, /navigationSelection\.select\(path\)[\s\S]*warmMenuCode\(path\)/);
  assert.match(source, /navigationSelection\.sync\(path\)/);
  assert.match(source, /ResizeObserver/); assert.match(source, /indicatorMotion\.dispose\(\)/);
  assert.doesNotMatch(source, /\.router-link-active\s*\{|opacity': '0\.8'|group-hover:scale-110/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
});

function motionHarness({ native = true, reduced = false, hidden = false, throws = false, kind = 'page' } = {}) {
  const attrs = new Map(), listeners = new Map(), transitions = [], animations = [], paintedAnimations = [];
  const root = { style: { viewTransitionName: '' }, getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value), removeAttribute: name => attrs.delete(name) };
  const element = { isConnected: true, style: { viewTransitionName: '' }, querySelector: () => null,
    animate(frames, options) { const finished = deferred(); const item = { frames, options, finished: finished.promise,
      cancel() { this.canceled = true; finished.resolve(); } }; animations.push(item); return item; } };
  const media = { matches: reduced, addEventListener: (_name, fn) => listeners.set('media', fn), removeEventListener: () => listeners.delete('media') };
  const document = { documentElement: root, hidden, body: {}, querySelectorAll: () => [], getAnimations: () => paintedAnimations,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  if (native) document.startViewTransition = callback => {
    if (throws) throw new Error('capture unavailable');
    const ready = deferred(), update = deferred(), finish = deferred();
    const item = { callback, ready: ready.promise, updateCallbackDone: update.promise, finished: finish.promise,
      skipTransition() { this.skipped = true; ready.reject(new Error('skipped')); finish.resolve(); },
      async run() { try { await callback(); update.resolve(); ready.resolve(); } catch (error) { update.reject(error); ready.reject(error); finish.reject(error); } },
      finish: () => finish.resolve() };
    transitions.push(item); return item;
  };
  const h = frontendHarness({}, { globals: { document, window: { innerWidth: 1440, innerHeight: 1080,
    matchMedia: () => media, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } });
  const api = h.load('composables/useContentMotion.ts');
  const motion = api.createContentMotion(() => element, kind);
  return { ...api, motion, element, attrs, root, transitions, animations, paintedAnimations, media, listeners, dispose: () => { api.cancelContentMotion('unmount'); motion.dispose(); } };
}

test('painted transition commits exactly once and resolves before animation completion', async () => {
  const h = motionHarness(); let calls = 0;
  try {
    const result = h.motion.change(() => { calls++; });
    assert.equal(calls, 0); assert.equal(h.element.style.viewTransitionName, 'farm-content');
    assert.equal(h.root.style.viewTransitionName, 'none');
    await h.transitions[0].run(); assert.equal(await result, true);
    assert.equal(calls, 1); assert.equal(h.attrs.get('data-content-motion'), 'page');
    h.transitions[0].finish(); await Promise.resolve();
    assert.equal(h.element.style.viewTransitionName, ''); assert.equal(h.root.style.viewTransitionName, '');
    assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
  } finally { h.dispose(); }
});

test('rapid painted changes discard stale callbacks and old cleanup cannot erase the newest snapshot name', async () => {
  const h = motionHarness(); const calls = [];
  try {
    const first = h.motion.change(() => { calls.push('old'); });
    const second = h.motion.change(() => { calls.push('latest'); });
    assert.equal(await first, false); assert.equal(h.transitions[0].skipped, true);
    await h.transitions[0].run();
    assert.equal(h.element.style.viewTransitionName, 'farm-content');
    await h.transitions[1].run(); assert.equal(await second, true);
    assert.deepEqual(calls, ['latest']);
    h.transitions[1].finish(); await Promise.resolve(); assert.equal(h.attrs.size, 0);
  } finally { h.dispose(); }
});

test('account change or disposal before capture aborts pending content intent without replay', async () => {
  for (const reason of ['context', 'unmount']) {
    const h = motionHarness(); let calls = 0, aborted = 0;
    try {
      const result = h.motion.change(() => { calls++; }, { onAbort: () => { aborted++; } });
      h.cancelContentMotion(reason); assert.equal(await result, false);
      await h.transitions[0].run();
      assert.equal(calls, 0); assert.ok(aborted >= 1);
      assert.equal(h.attrs.size, 0); assert.equal(h.element.style.viewTransitionName, '');
    } finally { h.dispose(); }
  }
});

test('opening an overlay removes painted frames but releases an active navigation only once', async () => {
  const h = motionHarness(); let calls = 0;
  try {
    const result = h.motion.change(() => { calls++; });
    h.cancelContentMotion('overlay'); assert.equal(await result, true);
    await h.transitions[0].run();
    assert.equal(calls, 1); assert.equal(h.transitions[0].skipped, true);
    assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
  } finally { h.dispose(); }
});

test('unsupported or throwing capture falls back after one immediate update, not after an exit wait', async () => {
  for (const options of [{ native: false }, { throws: true }]) {
    const h = motionHarness(options); let calls = 0;
    try {
      assert.equal(await h.motion.change(() => { calls++; }), true);
      await Promise.resolve(); assert.equal(calls, 1);
      assert.equal(h.animations.length, 1); assert.equal(h.animations[0].options.duration, 460);
      assert.equal(h.animations[0].frames[0].transform, 'translate3d(0, 100%, 0)');
      assert.equal(h.animations[0].frames[0].opacity, undefined);
      h.cancelContentMotion('overlay'); assert.equal(h.animations[0].canceled, true);
      assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
    } finally { h.dispose(); }
  }
});

test('reduced motion and hidden documents switch directly without any snapshot or WAAPI animation', async () => {
  for (const options of [{ reduced: true }, { hidden: true }]) {
    const h = motionHarness(options); let calls = 0;
    try {
      assert.equal(await h.motion.change(() => { calls++; }), true);
      assert.equal(calls, 1); assert.equal(h.transitions.length, 0); assert.equal(h.animations.length, 0);
      assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
    } finally { h.dispose(); }
  }
});

test('runtime reduced-motion preference skips the existing animation without repeating the update', async () => {
  const h = motionHarness(); let calls = 0;
  try {
    const result = h.motion.change(() => { calls++; }); await h.transitions[0].run(); await result;
    h.media.matches = true; h.listeners.get('media')();
    assert.equal(h.transitions[0].skipped, true); assert.equal(calls, 1); assert.equal(h.attrs.size, 0);
  } finally { h.dispose(); }
});

test('new pointer, keyboard or scrolling input drops snapshots before real controls respond', async () => {
  for (const interaction of ['pointerdown', 'keydown', 'wheel']) {
    const h = motionHarness(); let calls = 0;
    try {
      const result = h.motion.change(() => { calls++; }); await h.transitions[0].run(); await result;
      h.listeners.get(interaction)({ type: interaction, target: null });
      assert.equal(h.transitions[0].skipped, true); assert.equal(calls, 1);
      assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
    } finally { h.dispose(); }
  }
});

test('animation context invalidation cannot revive a canceled update after a deferred capture callback', async () => {
  const h = motionHarness(); const applied = []; let current = 'account-A';
  try {
    const result = h.motion.change(() => { applied.push(current); }, { valid: () => current === 'account-A' });
    current = 'account-B'; h.cancelContentMotion('context'); await h.transitions[0].run();
    assert.equal(await result, false); assert.deepEqual(applied, []);
    assert.equal(h.root.style.viewTransitionName, ''); assert.equal(h.element.style.viewTransitionName, '');
  } finally { h.dispose(); }
});

test('mid-flight reverse reuses painted timelines, updates once and keeps latest cleanup ownership', async () => {
  const h = motionHarness(); const applied = [];
  const finished = [deferred(), deferred()];
  for (let index = 0; index < 2; index++) h.paintedAnimations.push({
    animationName: index === 0 ? 'content-snapshot-in' : 'content-snapshot-out',
    currentTime: 120, playbackRate: 1, effect: { getTiming: () => ({ duration: 460 }) },
    finished: finished[index].promise,
    pause() { this.paused = true; }, reverse() { this.playbackRate *= -1; this.paused = false; },
  });
  try {
    const first = h.motion.change(() => { applied.push('B'); }, { fromKey: 'A', toKey: 'B' });
    await h.transitions[0].run(); await first;
    h.cancelContentMotion('navigation');
    assert.equal(h.transitions[0].skipped, undefined);
    const reversed = h.motion.change(() => { applied.push('A'); }, { fromKey: 'B', toKey: 'A' });
    assert.equal(await reversed, true); assert.equal(h.transitions.length, 1);
    assert.ok(h.paintedAnimations.every(item => item.playbackRate === -1));
    assert.deepEqual(applied, ['B', 'A']);
    const next = h.motion.change(() => { applied.push('C'); }, { fromKey: 'A', toKey: 'C' });
    finished.forEach(item => item.resolve()); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.element.style.viewTransitionName, 'farm-content', 'old reverse cleanup erased newer job');
    await h.transitions[1].run(); assert.equal(await next, true);
    assert.deepEqual(applied, ['B', 'A', 'C']); h.transitions[1].finish();
  } finally { h.dispose(); }
});

test('context cancellation during a reversed route flush releases its waiter, removes snapshots and never repeats the update', async () => {
  const h = motionHarness(); const routePaint = deferred(); let calls = 0, aborted = 0;
  const finished = deferred();
  h.paintedAnimations.push(...['content-snapshot-in', 'content-snapshot-out'].map(animationName => ({ animationName,
    currentTime: 80, effect: { getTiming: () => ({ duration: 460 }) }, finished: finished.promise, pause() {}, reverse() { assert.fail('canceled reverse should never resume'); } })));
  try {
    const first = h.motion.change(() => { calls++; }, { fromKey: 'A', toKey: 'B' }); await h.transitions[0].run(); await first;
    const reversal = h.motion.change(() => { calls++; return routePaint.promise; }, { fromKey: 'B', toKey: 'A', onAbort: () => { aborted++; routePaint.resolve(); } });
    h.cancelContentMotion('context'); assert.equal(await reversal, true);
    assert.equal(calls, 2); assert.equal(aborted, 1); assert.equal(h.attrs.size, 0); assert.equal(h.listeners.size, 0);
  } finally { h.dispose(); }
});

for (const kind of ['page', 'panel']) test(`${kind} reversal resumes current painted transforms with forward damping, not reversed ease-out or a new capture`, async () => {
  const h = motionHarness({ kind });
  const applied = [], finished = [deferred(), deferred()];
  for (let index = 0; index < 2; index++) {
    const vector = value => kind === 'page' ? `translate3d(0, ${value}%, 0)` : `translate3d(${value}%, 0, 0)`;
    const effect = { frames: [{ transform: vector(index ? 0 : 100) }, { transform: vector(index ? -100 : 0) }], timing: { duration: kind === 'page' ? 460 : 420 },
      getKeyframes() { return this.frames; }, getTiming() { return this.timing; }, setKeyframes(frames) { this.frames = frames; }, updateTiming(timing) { this.timing = timing; } };
    h.paintedAnimations.push({ animationName: index ? 'content-snapshot-out' : 'content-snapshot-in', currentTime: 100, playbackRate: 1, effect,
      finished: finished[index].promise, pause() {}, play() { this.played = true; }, reverse() { assert.fail(`${kind} must not reverse an ease-out curve`); } });
  }
  try {
    const first = h.motion.change(() => applied.push('B'), { fromKey: 'A', toKey: 'B' });
    await h.transitions[0].run(); await first;
    assert.equal(await h.motion.change(() => applied.push('A'), { fromKey: 'B', toKey: 'A' }), true);
    assert.equal(h.transitions.length, 1); assert.deepEqual(applied, ['B', 'A']);
    for (const animation of h.paintedAnimations) {
      assert.equal(animation.playbackRate, 1); assert.equal(animation.currentTime, 0); assert.equal(animation.played, true);
      assert.equal(animation.effect.timing.duration, 260); assert.equal(animation.effect.timing.easing, 'cubic-bezier(.24, .08, .2, 1)');
    }
    finished.forEach(item => item.resolve()); await Promise.resolve(); await Promise.resolve();
  } finally { h.dispose(); }
});

for (const kind of ['page', 'panel']) test(`a third ${kind} intent briefly finishes current pixels and only the latest destination is committed`, async () => {
  const h = motionHarness({ kind }); const calls = []; const finished = [deferred(), deferred()];
  for (let index = 0; index < 2; index++) h.paintedAnimations.push({ animationName: index ? 'content-snapshot-out' : 'content-snapshot-in', currentTime: 90, playbackRate: 1,
    effect: { getKeyframes: () => [{ transform: 'translate3d(100%,0,0)' }, { transform: 'none' }], getTiming: () => ({ duration: 420 }), setKeyframes() {}, updateTiming(value) { this.timing = value; } },
    finished: finished[index].promise, pause() {}, play() {}, reverse() {} });
  try {
    const first = h.motion.change(() => calls.push('B'), { fromKey: 'A', toKey: 'B' }); await h.transitions[0].run(); await first;
    const old = h.motion.change(() => calls.push('C'), { fromKey: 'B', toKey: 'C' });
    const latest = h.motion.change(() => calls.push('D'), { fromKey: 'B', toKey: 'D' });
    assert.equal(h.transitions[0].skipped, undefined, 'third-tab input must not immediately skip to endpoint');
    assert.ok(h.paintedAnimations.every(item => item.effect.timing?.duration === 110));
    finished.forEach(item => item.resolve()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(await old, false);
    for(let i = 0; i < 10 && h.transitions.length < 2; i++) await Promise.resolve();
    await h.transitions[1].run(); assert.equal(await latest, true); assert.deepEqual(calls, ['B', 'D']);
  } finally { h.dispose(); }
});

async function buildUxPreview(directory, buildDirectory) {
  const { createHash } = require('node:crypto');
  const viteRequire = createRequire(webRequire.resolve('vite/package.json'));
  const esbuild = viteRequire('esbuild');
  const gameConfig = require('../src/config/gameConfig');
  const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/ItemInfo.json'), 'utf8'));
  const catalog = Array.isArray(definition) ? definition : Object.values(definition);
  function image(url) {
    if (!url || !url.startsWith('/')) return '';
    const relative = decodeURIComponent(url.slice(1).split('?')[0]);
    const candidates = [path.join(web, 'public', relative), path.join(__dirname, '../src/gameConfig', relative.replace(/^game-config\//, ''))];
    const file = candidates.find(value => fs.existsSync(value) && fs.statSync(value).isFile());
    if (!file) return '';
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(file)];
    return mime ? `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` : '';
  }
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/deco_icons/avatar-frame-sources.json'), 'utf8')).items;
  const bagDefinitions = [...[101619, 101618, 6001].map(id => gameConfig.getItemById(id)).filter(Boolean),
    ...catalog.filter(item => Number(item.type) === 11).slice(0, 4),
    ...catalog.filter(item => Number(item.type) === 5).slice(0, 34),
    ...catalog.filter(item => [6, 17].includes(Number(item.type))).slice(0, 14)];
  const items = bagDefinitions.map((item, index) => ({ id: Number(item.id), uid: String(9000000000n + BigInt(index)),
    groupKey: `${item.id}:${index}`, name: item.name, itemType: Number(item.type), count: index % 3 === 0 ? 12 : 36 + index,
    level: Number(item.level || 0), locked: false, price: 12, priceId: 1001, priceUnit: '金币',
    image: image(gameConfig.getItemImageById(item.id)) }));
  const seed = items.find(item => item.itemType === 5);
  if (seed) items.splice(4, 0, { ...seed, uid: '9007199254740993', groupKey: 'locked-precise-uid', locked: true, count: 7 });
  const portraitFile = fs.readdirSync(path.join(buildDirectory, 'assets')).find(file => /^default_head-.*\.png$/.test(file));
  const portrait = portraitFile ? `data:image/png;base64,${fs.readFileSync(path.join(buildDirectory, 'assets', portraitFile)).toString('base64')}` : '';
  const frames = Object.values(art).map((entry, index) => ({ ...entry, itemId: entry.itemId, frameId: entry.frameId || entry.targetId || entry.itemId,
    owned: index < 4, equipped: index === 0, image: image(entry.url), resultUnknown: false }));
  const fixtures = { items, portrait, frames, friends: [11, 12, 13].map((gid, index) => ({ gid: String(gid), name: `示例好友 ${index + 1}`,
    avatarUrl: portrait, level: 100 + index, plant: {}, gold: 3000, dogId: 0 })) };
  const styles = [], sources = new Map();
  const mock = String.raw`
import { computed, ref, reactive } from 'vue'
import { defineStore } from 'pinia'
import fixtures from 'ux:fixtures'
export const state = reactive({ accountId: 'fixture-A', page: 'personal', readCase: 'normal', resultCase: 'normal' })
export const audit = reactive({ reads: [], writes: [], errors: [], blocked: 0, toasts: [] })
const copy = value => JSON.parse(JSON.stringify(value))
const delay = () => new Promise(resolve => setTimeout(resolve, 50))
export const useStatusStore = defineStore('offline-status', () => ({
  status: computed(() => ({ status: { name: state.accountId === 'fixture-A' ? '日常农场' : '备用农场', level: 125, avatar: fixtures.portrait }, connection: { connected: true } })),
  statusAccountId: computed(() => state.accountId), currentStatusMetadata: ref(null), currentStatusStale: ref(false),
  currentStatusReady: ref(true), realtimeConnected: ref(true), loading: ref(false), error: ref(''),
  clearAccountScopedData() {}, async fetchStatus() {}, connectRealtime() {}, disconnectRealtime() {}
}))
export const useToastStore = defineStore('offline-toast', () => {
  const toasts = ref([])
  let sequence = 0
  const remove = id => { toasts.value = toasts.value.filter(item => item.id !== id) }
  const methods = Object.fromEntries(['success', 'info', 'warning', 'error'].map(tone => [tone, message => {
    audit.toasts.push({ tone, message }); if (audit.toasts.length > 8) audit.toasts.shift()
    const id = ++sequence
    toasts.value.push({ id, type: tone, message })
    setTimeout(() => remove(id), 2500)
  }]))
  return { toasts, remove, ...methods }
})
export const useUserStore = defineStore('offline-user', () => ({
  username: ref('农场主人'), avatar: ref(fixtures.portrait), token: ref(''),
  isAdmin: ref(true), accountLimit: ref(3),
  async fetchUserInfo() {}, async logout() { useToastStore().info('此预览使用示例账号，无需退出登录') },
}))
export const useShopStore = defineStore('offline-shop', () => ({
  mysteryOffer: ref(null), mysteryOfferAccountId: ref(''), mysteryLoading: ref(false),
  async fetchMysteryShop() {}
}))
export const isReadCanceled = error => error?.code === 'ERR_CANCELED'
export function payload(url, id) {
  if (url === '/api/accounts') return { accounts: ['fixture-A', 'fixture-B'].map((id, index) => ({ id, uin: String(10000001 + index), name: id === 'fixture-A' ? '日常农场' : '备用农场', platform: 'qq', running: true, avatar: fixtures.portrait })) }
  if (url === '/api/settings') return { ui: { theme: 'light-green' } }
  if (url === '/api/ping') return { uptime: 7200, version: '2.2.2' }
  if (url === '/api/public/login-links') return { title: 'QQ农场智能助手', logoUrl: '', loginSubtitle: '', qqGroupUrl: '' }
  if (url === '/api/activity/update/status') return { report: { unknownActivityIds: [] } }
  if (url === '/api/announcement') return { content: '', showOnce: true, updatedAt: 0, shouldShow: false }
  if (url === '/api/bag') {
    const values = state.readCase === 'empty' ? [] : copy(fixtures.items)
    if (id === 'fixture-B') values.forEach(item => { item.count = 2 })
    return { items: values, originalItems: copy(values) }
  }
  if (url === '/api/friends') return copy(fixtures.friends)
  if (url === '/api/friend-blacklist' || url === '/api/interact-records' || url === '/api/steal-plans') return []
  if (url === '/api/friend-known-gids') return { knownFriendGids: [11, 12], knownFriendGidSyncCooldownSec: 600, friendsListCacheTtlSec: 60 }
  if (url === '/api/avatar-frames') return { accountId: id, groups: [1, 2].map(frameType => ({ frameType, label: frameType === 1 ? '头像框' : '铭牌', stateKnown: true,
    items: copy(fixtures.frames.filter(item => item.frameType === frameType)).map(item => ({ ...item, equipped: id === 'fixture-A' && item.equipped })), equippedIds: [] })) }
  throw new Error('未声明的预览读取：' + url)
}
const api = {
  async get(url, config = {}) {
    const id = String(config.headers?.['x-account-id'] || state.accountId)
    audit.reads.push({ url, id })
    const readCase = state.readCase
    if (url === '/api/bag' && readCase === 'slow') await delay()
    if (url === '/api/bag' && readCase === 'error') throw new Error('模拟刷新失败；不会清空已有背包')
    return { data: { ok: true, data: payload(url, id) } }
  },
  async post(url, body, config = {}) {
    if (!['/api/bag/use', '/api/bag/lock', '/api/bag/sell'].includes(url) && !/^\/api\/friend\/\d+\/op$/.test(url)) throw new Error('未声明的预览操作：' + url)
    const id = String(config.headers?.['x-account-id'] || state.accountId), resultCase = state.resultCase
    audit.writes.push({ url, id, body: copy(body) })
    await delay()
    if (resultCase === 'unknown') throw Object.assign(new Error('模拟回包超时，结果未确认'), { response: { data: { ok: false, sent: true, resultState: 'unknown', outcomeUnknown: true } } })
    if (resultCase === 'reject') return { data: { ok: false, sent: false, resultState: 'not_sent', error: '模拟发送前明确拒绝' } }
    if (url.startsWith('/api/friend/')) return { data: { ok: true, data: { ok: true, opType: body.opType, count: resultCase === 'zero' ? 0 : 2, message: resultCase === 'zero' ? '没有可捣乱土地' : '模拟捣乱已确认：虫1 / 草1', resultState: 'completed' } } }
    const data = { accountId: id, resultState: 'completed', rewards: [{ id: 1001, count: 10, name: '模拟金币' }] }
    if (url === '/api/bag/sell') { data.sell_items = copy(body.items); data.get_items = [{ id: 1001, count: '321' }] }
    return { data: { ok: true, data } }
  }
}
export default api
`;
  const entry = String.raw`
import { createApp, defineComponent, h, nextTick, onMounted } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import DefaultLayout from '@/layouts/DefaultLayout.vue'
import Personal from '@/views/Personal.vue'
import Friends from '@/views/Friends.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import { menuRoutes } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useFriendStore } from '@/stores/friend'
import { useAppStore } from '@/stores/app'
import { readAccountUiState, writeAccountUiState } from '@/composables/useAccountUiState'
import { cancelContentMotion } from '@/composables/useContentMotion'
import { state, audit } from 'ux:mock'
const query = new URLSearchParams(location.search)
if (query.get('page') === 'friends') state.page = 'friends'
if (['error', 'empty'].includes(query.get('case'))) state.readCase = query.get('case')
const motionAudit = []
const nativeStart = document.startViewTransition?.bind(document)
if (nativeStart) document.startViewTransition = callback => {
  const record = { kind: document.documentElement.dataset.contentMotion, direction: document.documentElement.dataset.contentDirection, committed: false, skipped: false, sampled: null }
  const transition = nativeStart(async () => { await callback(); record.committed = true })
  const skip = transition.skipTransition.bind(transition)
  transition.skipTransition = () => { record.skipped = true; skip() }
  const readPaint = () => {
    const rootElement = document.documentElement
    const css = getComputedStyle(rootElement, '::view-transition-new(farm-content)')
    const running = document.getAnimations().filter(animation => ['content-snapshot-in', 'content-snapshot-out'].includes(animation.animationName))
    return { entry: css.animationName, duration: css.animationDuration, frames: running.map(animation => ({ name: animation.animationName, keys: animation.effect?.getKeyframes().map(frame => ({ transform: frame.transform, opacity: frame.opacity })) })),
      overlayPointerEvents: getComputedStyle(rootElement, '::view-transition').pointerEvents,
      rootName: getComputedStyle(rootElement).viewTransitionName, onlyOnePageMounted: document.querySelectorAll('[data-page-content]').length === 1 }
  }
  transition.ready.then(() => { record.sampled = readPaint() }, error => { record.captureError = String(error?.message || error) })
  transition.finished.then(() => { record.finished = true }, () => {})
  record.transition = transition
  motionAudit.push(record)
  return transition
}
const guard = kind => () => { audit.blocked++; throw new Error('禁止真实 ' + kind) }
window.fetch = guard('fetch')
window.XMLHttpRequest = class { constructor() { guard('XHR')() } }
window.WebSocket = class { constructor() { guard('WebSocket')() } }
window.EventSource = class { constructor() { guard('EventSource')() } }
try { navigator.sendBeacon = guard('sendBeacon') } catch {}
addEventListener('error', event => audit.errors.push(event.message))
addEventListener('unhandledrejection', event => audit.errors.push(String(event.reason?.message || event.reason)))
addEventListener('securitypolicyviolation', event => audit.errors.push('CSP: ' + event.blockedURI))
localStorage.setItem('user_info', JSON.stringify({ username: 'offline-preview' }))
localStorage.setItem('ui_theme', query.get('theme') === 'dark' ? 'dark-blue' : 'light-green')
writeAccountUiState('fixture-A', 'personal', { tab: 'bag' })
writeAccountUiState('fixture-B', 'personal', { tab: 'bag' })
writeAccountUiState('fixture-A', 'bag', { category: 'all', density: query.get('density') === 'compact' ? 'compact' : 'standard' })
const OutsidePilot = defineComponent({ setup() { return () => h('section', { class: 'preview-outside-pilot' }, [
  h('h1', '更多农场功能'), h('p', '此页面不在本次外观预览范围，真实功能不会受影响。'),
  h('button', { onClick: () => router.push('/personal') }, '返回个人中心')
]) } })
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: DefaultLayout,
  children: menuRoutes.map(item => ({ path: item.path, name: item.name, component: item.name === 'personal' ? Personal : item.name === 'friends' ? Friends : OutsidePilot }))
}] })
router.afterEach(to => { state.page = to.name === 'friends' ? 'friends' : to.name === 'personal' ? 'personal' : String(to.name || '') })
const app = createApp({
  setup() {
    useAppStore()
    onMounted(async () => {
      await flush()
      if (query.get('check') === '1') {
        try { const report = await checks(); finish(report) }
        catch (error) { finish({ ok: false, viewport: innerWidth, error: error.message, step: state.checkStep, stack: error.stack?.slice(0, 300), errors: [...audit.errors] }) }
      }
    })
    return () => h('div', { class: 'ux-shell' }, [
      h('div', { class: 'ux-preview-note' }, '本地预览 · 示例数据，不影响真实农场'),
      h('div', { class: 'ux-product' }, [h(RouterView)]),
      h(ToastContainer),
    ])
  }
}).use(createPinia()).use(router)
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
const wait = () => new Promise(resolve => setTimeout(resolve, 80))
const root = () => document.querySelector('[data-page-content]')
const goPage = async page => { state.page = page; await router.push(page === 'friends' ? '/friends' : '/personal'); await flush() }
const byText = (text, area = root()) => [...area.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.textContent.trim().startsWith(text + ' ') || item.closest('.bag-categories') && item.textContent.trim().startsWith(text))
const ensure = (value, message) => { if (!value) throw new Error(message) }
const click = async (text, area = root()) => { const button = byText(text, area); ensure(button, '缺少按钮：' + text); await new Promise(resolve => setTimeout(resolve, 1)); const before = motionAudit.length; button.click(); await flush(); if (motionAudit.length > before) await motionAudit.at(-1).transition.updateCallbackDone.catch(() => {}); await flush(); return button }
function geometry() {
  const width = document.documentElement.clientWidth
  const escaped = [...root().querySelectorAll('*')].filter(element => {
    const r = element.getBoundingClientRect(), style = getComputedStyle(element)
    return r.width > 0 && r.height > 0 && style.display !== 'none' && r.right > width + 1
  }).map(element => ({ tag: element.tagName, right: Math.round(element.getBoundingClientRect().right), text: element.textContent.trim().slice(0, 35) })).slice(0, 8)
  return { width, documentWidth: document.documentElement.scrollWidth, escaped }
}
function finish(report) {
  window.__uxReport = report
  window.dispatchEvent(new Event('ux-verification-finished'))
  document.getElementById('preview-report').textContent = JSON.stringify(report)
  if (parent !== window) parent.postMessage({ uxReport: report }, '*')
}
async function checks() {
  const cases = []
  state.checkStep = 'initial-bag'
  state.accountId = 'fixture-A'; state.readCase = 'normal'; await goPage('personal')
  ensure(root().querySelector('.bag-view'), '真实个人页面默认应显示试点背包')
  ensure(document.querySelector('.ux-product aside') && document.querySelector('.ux-product header'), '预览必须使用实际导航与顶栏')
  ensure(!document.querySelector('.ux-controls') && !document.querySelector('[aria-label="模拟刷新结果"]') && !document.querySelector('[aria-label="模拟操作结果"]'), '测试场景开关不应出现在用户界面')
  ensure(!document.querySelector('.ux-shell').textContent.includes('正常读取'), '用户界面仍泄露测试术语')
  cases.push('真实侧栏顶栏 / 用户界面无测试开关')
  await click('全部')
  const firstImage = root().querySelector('.bag-item img')
  if (firstImage) { firstImage.loading = 'eager'; await firstImage.decode() }
  ensure(root().querySelectorAll('.bag-item').length > 20, '实例列表没有真实组件数据')
  ensure(root().querySelectorAll('.bag-item img').length > 20, '已有真实物品美术不能被预览编码路径误当缺图')
  const exactUid = [...root().querySelectorAll('.bag-item')].find(item => item.textContent.includes('已锁定'))
  ensure(exactUid, '锁定实例未显示')
  exactUid.querySelector('.bag-detail-button').focus(); exactUid.querySelector('.bag-detail-button').click(); await flush()
  ensure(root().textContent.includes('9007199254740993'), 'UID在详情中丢失精度')
  ensure(root().querySelector('dialog')?.matches(':modal'), '确认/详情框未在浏览器native top layer中')
  await click('关闭'); cases.push('真实实例详情 / native modal')
  state.checkStep = 'modal-focus'
  const action = [...root().querySelectorAll('.bag-item-actions button')].find(button => button.textContent.trim() === '锁定')
  action.focus(); await new Promise(resolve => setTimeout(resolve, 1)); action.click(); await flush()
  ensure(action.dataset.clicked === 'true', '点击未显示按钮响应反馈')
  const clickAnimation = getComputedStyle(action, '::after').animationName
  const clickStyle = { animationName: clickAnimation }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches)
    ensure(clickStyle.animationName === 'none', '减动效偏好仍播放点击脉冲')
  else ensure(clickStyle.animationName.includes('button-acknowledge'), '正常模式下实际按钮缺少点击脉冲')
  cases.push('按钮按压样式 / 实际点击脉冲 / 处理中不假成功')
  const modal = root().querySelector('dialog'), cancel = modal.querySelector('[data-modal-cancel]'), confirm = modal.querySelector('.confirm-modal-actions button:last-child')
  ensure(document.activeElement === cancel, '不可逆确认首次焦点应在取消')
  if (matchMedia('(prefers-reduced-motion: reduce)').matches)
    ensure(getComputedStyle(modal).animationName === 'none', '减动效偏好未抑制确认框动画')
  cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
  ensure(document.activeElement === confirm, 'Shift Tab未限制在弹窗内')
  confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
  ensure(document.activeElement === cancel, 'Tab未循环回弹窗首项')
  modal.dispatchEvent(new Event('cancel', { cancelable: true })); await flush()
  ensure(!root().querySelector('dialog'), 'Esc取消事件未关闭确认框')
  ensure(document.activeElement === action, '关闭后焦点未恢复到原按钮')
  cases.push('键盘焦点 / Tab循环 / Esc取消 / 恢复焦点')
  state.checkStep = 'restore-ui-and-scroll'
  await click('紧凑'); await click('种子')
  ensure(root().querySelector('.bag-view').dataset.density === 'compact', '密度未切换')
  const content = root().querySelector('.personal-content')
  content.scrollTop = Math.min(250, content.scrollHeight - content.clientHeight)
  content.dispatchEvent(new Event('scroll')); await flush()
  const beforeTop = content.scrollTop
  const writesBeforeTabs = audit.writes.length
  await click('我的农场'); await click('我的背包'); await flush()
  let panelPaint = null
  const panelTransition = motionAudit.at(-1)
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ensure(panelTransition?.kind === 'panel', '个人标签没有独立内容过渡')
    await panelTransition.transition.ready.catch(() => {})
    panelPaint = panelTransition.sampled
    ensure(panelPaint?.frames.some(item => item.name === 'content-snapshot-in' && item.keys.some(frame => /translate3d\(100%,\s*0/.test(frame.transform || '')))), '个人标签没有实际横向滑动关键帧：' + JSON.stringify({ paint: panelPaint, skipped: panelTransition.skipped, error: panelTransition.captureError }))
    ensure(parseFloat(panelPaint.duration) <= .35, '个人标签动效过长')
  }
  ensure(audit.writes.length === writesBeforeTabs, '切标签不应触发游戏写')
  ensure(root().querySelector('.bag-view').dataset.density === 'compact', '切换panel丢失密度')
  ensure(root().querySelector('[aria-pressed="true"]').textContent.includes('种子'), '切panel丢失分类')
  await wait(); await flush()
  ensure(Math.abs(root().querySelector('.personal-content').scrollTop - beforeTop) <= 2, '切panel后阅读位置未恢复')
  await goPage('friends')
  ensure(document.querySelectorAll('[data-page-content]').length === 1, '切页动画不应保留两个在途页面')
  let pagePaint = null
  const pageTransition = motionAudit.at(-1)
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ensure(getComputedStyle(root()).animationName === 'none' && !document.documentElement.dataset.contentMotion, '减动效偏好仍保留切页快照')
  }
  else {
    ensure(pageTransition?.kind === 'page', '真实路由未进入内容快照过渡')
    await pageTransition.transition.ready.catch(() => {})
    pagePaint = pageTransition.sampled
    ensure(pagePaint?.entry?.includes('content-snapshot-in'), '浏览器未实际执行新页滑动：' + JSON.stringify({ paint: pagePaint, skipped: pageTransition.skipped }))
    ensure(parseFloat(pagePaint.duration) <= .45 && pagePaint.frames.some(item => item.name === 'content-snapshot-out'), '缺少旧页衔接或切页时长超出范围')
    ensure(pagePaint.frames.some(item => item.name === 'content-snapshot-in' && item.keys.some(frame => /translate3d\(0[^,]*,\s*100%/.test(frame.transform || '')))), '新页没有真实纵向滑动关键帧')
    ensure(pagePaint.rootName === 'none' && pagePaint.overlayPointerEvents === 'none' && pagePaint.onlyOnePageMounted, '快照冻住导航/拦截操作/保活旧页')
  }
  const rapidOne = router.push('/personal'), rapidTwo = router.push('/friends'), rapidThree = router.push('/personal')
  await Promise.all([rapidOne, rapidTwo, rapidThree]); await flush()
  ensure(router.currentRoute.value.path === '/personal' && document.querySelectorAll('[data-page-content]').length === 1, '连续切页没收敛到最后意图或保留旧页')
  if (motionAudit.length) await motionAudit.at(-1).transition.updateCallbackDone.catch(() => {})
  cancelContentMotion('overlay'); await flush()
  ensure(!document.documentElement.dataset.contentMotion, '取消后绘制快照属性未清除')
  ensure(root().querySelector('.bag-view') && root().querySelector('.bag-view').dataset.density === 'compact', '返回个人页未恢复Tab和密度')
  cases.push('真实路由上下推页 / 标签左右推页 / 单真实页 / 快速连切最后意图')
  cases.push('按账号保留Tab / 分类 / 密度 / 阅读位置')
  state.checkStep = 'interruptions-and-fallback'
  const readsBeforeQuery = audit.reads.filter(item => item.url === '/api/bag').length
  const transitionsBeforeQuery = motionAudit.length
  await router.push('/personal?tab-test=1'); await flush()
  ensure(audit.reads.filter(item => item.url === '/api/bag').length === readsBeforeQuery && motionAudit.length === transitionsBeforeQuery, 'query变化不应重挂载或重新捕获游戏页面')
  await router.push('/personal'); await flush()
  await goPage('friends')
  const interrupted = motionAudit.at(-1)
  state.accountId = 'fixture-B'; await flush()
  ensure(!document.documentElement.dataset.contentMotion, '切号没有同步撤销旧画面')
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) ensure(interrupted.skipped, '切号后旧原生快照仍在播放')
  state.accountId = 'fixture-A'; await flush(); await goPage('personal')
  const detailInMotion = [...root().querySelectorAll('.bag-detail-button')][0]
  await new Promise(resolve => setTimeout(resolve, 1)); detailInMotion.click(); await flush()
  ensure(root().querySelector('dialog')?.matches(':modal') && !document.documentElement.dataset.contentMotion, '切页途中详情弹窗被快照压住或未撤销')
  await click('关闭')
  const nativeHandler = document.startViewTransition
  document.startViewTransition = undefined
  await goPage('friends'); await flush()
  const fallbackAnimation = root().getAnimations().find(animation => animation.effect?.getKeyframes().some(frame => /translate3d\(0[^,]*,\s*100%/.test(frame.transform || ''))))
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) ensure(fallbackAnimation, '缺少原生API时当前新页滑动未降级')
  cancelContentMotion('overlay'); await flush()
  ensure(!root().getAnimations().length && !document.documentElement.dataset.contentMotion, 'fallback取消后有残余变换')
  document.startViewTransition = nativeHandler
  await goPage('personal'); cancelContentMotion('overlay'); await flush()
  cases.push('query不重挂载 / 切号撤快照 / 中途弹窗 / 无API即时降级')
  state.checkStep = 'refresh-and-search'
  const input = root().querySelector('input[type="search"]')
  const beforeSearchReads = audit.reads.length
  input.value = '不存在的模拟物品'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  ensure(root().textContent.includes('没有匹配'), '本地搜索空态未展示')
  ensure(audit.reads.length === beforeSearchReads, '本地搜索不应发游戏请求')
  input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  const size = root().querySelectorAll('.bag-item').length
  state.readCase = 'slow'; const reading = useBagStore().fetchBag('fixture-A'); await flush()
  ensure(root().querySelectorAll('.bag-item').length === size, '后台刷新清空已有列表')
  await reading; await flush()
  state.readCase = 'error'; await useBagStore().fetchBag('fixture-A'); await flush()
  ensure(root().querySelectorAll('.bag-item').length === size && root().textContent.includes('模拟刷新失败'), '刷新失败未保留内容并明确标注')
  ensure([...root().querySelectorAll('.bag-item-actions .base-button')].every(button => button.disabled), '失败后的旧快照仍可操作')
  state.readCase = 'normal'; await useBagStore().fetchBag('fixture-A'); await flush()
  cases.push('同账号刷新 / 错误保留 / 旧快照禁用')
  state.accountId = 'fixture-B'; await flush()
  ensure(!root().querySelector('dialog') && !root().querySelector('input[type="checkbox"]'), '切号携带旧确认或批选')
  state.accountId = 'fixture-A'; await flush(); await wait(); await flush(); await click('全部')
  state.checkStep = 'single-use-pending'
  const pendingReadsBefore = audit.writes.length
  const useButton = [...root().querySelectorAll('.bag-item-actions button')].find(button => button.textContent.trim() === '使用 1 个')
  ensure(useButton && !useButton.disabled, '使用前新快照应已完成且可操作：' + root().textContent.slice(0, 300))
  // Vue intentionally ignores events occurring at the exact attach timestamp.
  // Real pointer events arrive on a later task; give new fixture nodes one tick.
  await new Promise(resolve => setTimeout(resolve, 1))
  useButton.click(); await flush()
  const confirmUse = root().querySelector('.confirm-modal-actions button:last-child')
  ensure(confirmUse, '使用操作未打开真实确认框')
  const widthBefore = confirmUse.getBoundingClientRect().width
  await new Promise(resolve => setTimeout(resolve, 1))
  confirmUse.click(); confirmUse.click(); await flush()
  ensure(audit.writes.length === pendingReadsBefore + 1, '快速重复确认产生多次写')
  ensure(Math.abs(confirmUse.getBoundingClientRect().width - widthBefore) < 1, 'loading导致确认按钮变宽')
  const pendingDialog = root().querySelector('dialog'); pendingDialog.dispatchEvent(new Event('cancel', { cancelable: true })); await flush()
  ensure(root().querySelector('dialog')?.open, 'pending时Esc不应假取消已发送请求')
  await wait(); await flush()
  ensure(root().textContent.includes('实际获得'), '使用成功未呈现实际回包')
  cases.push('pending尺寸稳定 / 重复点击单次 / 在途不取消 / 实际奖励')
  const widths = geometry(); ensure(widths.documentWidth <= widths.width + 1 && !widths.escaped.length, '背包横向溢出：' + JSON.stringify(widths))
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ensure(getComputedStyle(root().querySelector('.bag-item')).transitionDuration.split(',').every(value => parseFloat(value) === 0), '减动效偏好仍有卡片过渡')
    cases.push('浏览器减动效偏好生效')
  }
  const theme = useAppStore(); theme.applyTheme('dark-blue'); await flush()
  const ink = getComputedStyle(root().querySelector('.bag-item h3')).color
  const background = getComputedStyle(root().querySelector('.bag-item')).backgroundColor
  ensure(ink.match(/\d+/g).slice(0, 3).every(value => Number(value) > 180) && background.match(/\d+/g).slice(0, 3).every(value => Number(value) < 80), '深色表面不可读')
  theme.applyTheme('light-green'); await flush(); cases.push('深浅主题 / 表面层级')
  state.checkStep = 'friend-feedback'
  await goPage('friends'); await wait(); await flush()
  const countBefore = audit.writes.length
  state.resultCase = 'normal'; await click('捣乱'); await click('确定'); await flush()
  ensure(root().textContent.includes('处理中'), '好友捣乱仍fire-and-forget关闭反馈')
  await wait(); await flush(); ensure(audit.writes.length === countBefore + 1, '好友一次确认发出多次操作')
  ensure(root().textContent.includes('模拟捣乱已确认'), '好友成功没有真实结果')
  const zeroToasts = audit.toasts.filter(item => item.tone === 'success').length
  state.resultCase = 'zero'; await click('捣乱'); await click('确定'); await wait(); await flush()
  ensure(root().textContent.includes('没有可捣乱土地'), '无效果没有明确反馈')
  ensure(audit.toasts.filter(item => item.tone === 'success').length === zeroToasts, '零效果被标成功')
  state.resultCase = 'unknown'; await click('捣乱'); await click('确定'); await wait(); await flush()
  ensure(root().textContent.includes('结果未确认'), '好友unknown未展示')
  ensure([...root().querySelectorAll('.friend-row button')].filter(button => ['偷取', '捣乱', '一键务农'].includes(button.textContent.trim())).every(button => button.disabled), 'unknown可重复好友写')
  const friendGeometry = geometry(); ensure(friendGeometry.documentWidth <= friendGeometry.width + 1 && !friendGeometry.escaped.length, '好友页面横向溢出')
  ensure(!audit.reads.some(item => /\/api\/friend\/\d+\/lands/.test(item.url)), '反馈不应自动再访问好友土地')
  cases.push('好友单次await / 零效果非成功 / unknown不重提 / 不二次访问')
  ensure(audit.errors.length === 0 && audit.blocked === 0, '预览存在错误或真实传输尝试：' + JSON.stringify(audit.errors))
  // Pure fixture reset for the delivered preview. Never a production lock-clear API.
  useBagStore().mutationStates = {}; useFriendStore().operationStates = {}
  state.resultCase = 'normal'; state.readCase = 'normal'; state.accountId = 'fixture-A'
  await goPage('personal'); await click('全部'); await click('标准')
  return { ok: true, viewport: innerWidth, realNetworkCalls: 0, blockedAttempts: audit.blocked, mockWrites: audit.writes.length,
    errors: [...audit.errors], cases, geometry: [widths, friendGeometry], syntheticKeyboardChecks: true,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    motionEvidence: { pagePaint, panelPaint, clickAnimation: clickStyle.animationName, onlyOnePageMounted: true,
      nativeSnapshotsStarted: motionAudit.length, canceledSnapshots: motionAudit.filter(item => item.skipped).length } }
}
async function boot() { await router.push(state.page === 'friends' ? '/friends' : '/personal'); await router.isReady(); app.mount('#app') }
void boot()
window.__uxPreview = { state, audit, checks, router, goPage, motionAudit, cancelContentMotion }
`;
  const hidden = ['FarmPanel.vue', 'EmailPanel.vue', 'TaskPanel.vue', 'SkinPanel.vue', 'AnnouncementPanel.vue'];
  const plugin = { name: 'ux-offline-preview', setup(build) {
    build.onResolve({ filter: /^ux:/ }, args => ({ path: args.path, namespace: 'ux' }));
    build.onResolve({ filter: /^@\// }, args => {
      if (['@/api', '@/stores/status', '@/stores/toast', '@/stores/user', '@/stores/shop'].includes(args.path)) return { path: 'ux:mock', namespace: 'ux' };
      if (args.path === '@/router/menu') return { path: 'ux:menu', namespace: 'ux' };
      if (hidden.some(name => args.path === `@/components/${name}`) || ['AccountModal.vue', 'AccountCareerModal.vue', 'RemarkModal.vue', 'LandCard.vue'].some(name => args.path === `@/components/${name}`)) return { path: 'ux:hidden', namespace: 'ux' };
      let filename = path.join(web, 'src', args.path.slice(2)); if (!path.extname(filename)) filename += '.ts'; return { path: filename };
    });
    build.onResolve({ filter: /^@vueuse\/core$/ }, () => ({ path: 'ux:vueuse', namespace: 'ux' }));
    build.onLoad({ filter: /.*/, namespace: 'ux' }, args => {
      if (args.path === 'ux:fixtures') return { contents: `export default ${JSON.stringify(fixtures)}`, loader: 'js', resolveDir: web };
      if (args.path === 'ux:mock') return { contents: mock, loader: 'ts', resolveDir: web };
      if (args.path === 'ux:vueuse') return { contents: "import { ref, computed } from 'vue'; import { state } from 'ux:mock'; export const useIntervalFn=()=>({pause(){},resume(){}}); export const useStorage=(key,fallback)=> key==='current_account_id'?computed({get:()=>state.accountId,set:value=>state.accountId=value}):ref(fallback); export const useNow=()=>ref(new Date());export const useDateFormat=(value)=>computed(()=>value.value.toLocaleString('zh-CN',{hour12:false}));", loader: 'js', resolveDir: web };
      if (args.path === 'ux:menu') return { contents: read('router/menu.ts').replace(/component:\s*\(\)\s*=>\s*import\([^\n]+\)/g, 'component: () => Promise.resolve({})'), loader: 'ts', resolveDir: web };
      if (args.path === 'ux:hidden') return { contents: "import {defineComponent,h} from 'vue'; export default defineComponent({render:()=>h('div',{style:'min-height:520px;padding:24px;color:var(--muted-text)'},'此面板不在第一批预览范围；切回“我的背包”可查看实际优化组件。未读取游戏数据。')})", loader: 'js', resolveDir: web };
      throw new Error('Unknown preview module: ' + args.path);
    });
    build.onLoad({ filter: /\.vue$/ }, args => {
      const raw = fs.readFileSync(args.path, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex'); sources.set(path.relative(path.resolve(web, '..'), args.path).replaceAll('\\', '/'), hash);
      const id = `data-v-${hash.slice(0, 8)}`;
      const descriptor = compiler.parse(raw, { filename: args.path }).descriptor;
      const script = compiler.compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component',
        templateOptions: { compilerOptions: { scopeId: descriptor.styles.some(style => style.scoped) ? id : undefined } } });
      for (const style of descriptor.styles) {
        const result = compiler.compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped });
        assert.equal(result.errors.length, 0); styles.push(result.code);
      }
      return { contents: script.content + `\n__component.__scopeId='${id}';export default __component;`, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } };
  const compiled = await esbuild.build({ stdin: { contents: entry, resolveDir: web, loader: 'ts', sourcefile: 'ux-preview.ts' }, absWorkingDir: web,
    nodePaths: [path.join(web, 'node_modules')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    plugins: [plugin], alias: { vue: webRequire.resolve('vue/dist/vue.runtime.esm-bundler.js') },
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', __APP_VERSION__: JSON.stringify(require('../package.json').version) } });
  const currentHtml = fs.readFileSync(path.join(buildDirectory, 'index.html'), 'utf8');
  const cssFiles = [...currentHtml.matchAll(/href="(?:\.\/|\/)?assets\/([^"]+\.css)"/g)]
    .map(match => match[1]).filter(file => /^(index-|vendor-)/.test(file));
  assert.ok(cssFiles.some(file => file.startsWith('index-')), 'Preview must use the current build CSS, not stale files from previous builds');
  let css = cssFiles.map(file => fs.readFileSync(path.join(buildDirectory, 'assets', file), 'utf8')).join('\n');
  css = css.replace(/@import\s+(?:url\([^)]*\)|[^;]+);/g, '').replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (match, _quote, url) => url.startsWith('data:') ? match : 'none');
  const shellCss = `html,body{height:100%;margin:0;overflow:hidden;background:var(--surface-2);color:var(--theme-text);font-family:"Segoe UI","Microsoft YaHei",sans-serif}.ux-shell{height:100dvh;display:flex;flex-direction:column;min-width:0}.ux-preview-note{padding:5px 16px;text-align:center;border-bottom:1px solid var(--surface-border);background:var(--surface-1);color:var(--muted-text);font-size:11px;line-height:1.6}.ux-product{flex:1;min-height:0;min-width:0}.ux-product>div{height:100%!important}.preview-outside-pilot{padding:24px;color:var(--theme-text)}.preview-outside-pilot h1{font-size:22px}.preview-outside-pilot p{margin:12px 0;color:var(--muted-text)}.preview-outside-pilot button{border:1px solid var(--surface-border-strong);border-radius:8px;padding:10px 16px;background:var(--surface-1);color:var(--theme-text)}`;
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'ux-preview.html');
  fs.writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data:;font-src data:;connect-src 'none';base-uri 'none';form-action 'none'"><title>农场前端第一批优化 · 本地预览</title><style>${css}\n${styles.join('\n')}\n${shellCss}</style></head><body><div id="app"></div><pre id="preview-report" hidden></pre><script>${compiled.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`, 'utf8');
  return { file, actualComponents: [...sources].map(([name, sha256]) => ({ path: name, sha256 })), productionStyles: cssFiles,
    generatedAt: new Date().toISOString(), network: 'memory-only fixtures + CSP connect-src none',
    userFacingPreview: true, testControlsVisible: false, usesRealLayoutAndNavigation: true,
    notes: 'Actual DefaultLayout, Sidebar, top account menu, Personal/Bag/Friends and buttons/modals; other pages are explicitly outside this pilot. Test scenes run only during automated checks.' };
}

async function buildSettingsVerificationSource(directory) {
  const esbuild = createRequire(webRequire.resolve('vite/package.json'))('esbuild'), styles = [], hidden = ['AccountModal.vue', 'AccountCareerModal.vue', 'RemarkModal.vue'];
  const mock = String.raw`
import {reactive,computed,ref} from 'vue'
import {defineStore} from 'pinia'
export const fixture=reactive({selected:'',calls:[],saveCase:'normal',accounts:[{id:'fixture-A',name:'离线测试甲',running:true,platform:'qq'},{id:'fixture-B',name:'离线测试乙',running:false,platform:'wx'}],status:null,logs:[]})
const base={plantingStrategy:'level',preferredSeedId:0,prioritize2x2Crops:false,bagSeedPriority:[],bagSeedKnownIds:[],bagSeedFallbackStrategy:'level',intervals:{farmMin:2,farmMax:5,helpMin:30,helpMax:35,stealMin:25,stealMax:30},friendQuietHours:{enabled:false,start:'23:00',end:'07:00',exemptGids:[10001]},automation:{farm:false,fertilizer:'none',fertilizer_buy_normal:false,fertilizer_buy_organic:false},autoCodeRefresh:{enabled:false,intervalMinutes:60},offlineReminder:{channel:'smtp',reloginUrlMode:'none',endpoint:'',token:'',title:'测试提醒',msg:'测试',offlineDeleteSec:0,smtpHost:'',smtpPort:465,smtpUser:'',smtpPass:'',senderName:'',recipientEmail:'',emailContent:''}}
export const raw={accounts:{'fixture-A':JSON.parse(JSON.stringify(base)),'fixture-B':JSON.parse(JSON.stringify(base))},device:{enabled:false,userAgent:'',deviceBrand:'fixture',deviceModel:'离线设备',deviceMac:'',deviceId:'',imei:''},plan:{exists:true,enabled:true,config:JSON.parse(JSON.stringify(base)),updatedAt:1},offline:JSON.parse(JSON.stringify(base.offlineReminder))}
const clone=v=>JSON.parse(JSON.stringify(v))
async function request(method,url,body,options={}){fixture.calls.push({method,url,body:clone(body??{}),accountId:options.headers?.['x-account-id']??fixture.selected});const id=options.headers?.['x-account-id']??fixture.selected;let data
if(method==='GET'){if(url==='/api/accounts')data={accounts:clone(fixture.accounts)};else if(url==='/api/settings')data={...(clone(raw.accounts[id]||base)),offlineReminder:clone(raw.offline)};else if(url==='/api/user/device-protocol')return{data:{ok:true,config:clone(raw.device)}};else if(url==='/api/settings/default-plan')data=clone(raw.plan);else data=[];return{data:{ok:true,data}}}
await new Promise(resolve=>setTimeout(resolve,30))
if(fixture.saveCase==='unknown')throw new Error('内存测试传输结果未知')
if(url==='/api/settings/save')Object.assign(raw.accounts[id],clone(body));else if(url==='/api/automation')Object.assign(raw.accounts[id].automation,clone(body));else if(url==='/api/user/device-protocol')raw.device=clone(body);else if(url==='/api/settings/offline-reminder')raw.offline=clone(body);else if(url==='/api/settings/default-plan'){raw.plan={exists:true,...clone(body),updatedAt:2}}else if(url.endsWith('/stop'))fixture.accounts.find(a=>a.id===id||url.includes(a.id)).running=false
return{data:{ok:true,data:{}}}}
const api={get:(url,options)=>request('GET',url,null,options),post:(url,body,options)=>request('POST',url,body,options),put:(url,body,options)=>request('PUT',url,body,options),delete:(url,options)=>request('DELETE',url,null,options)}
export default api
export const safeGet=api.get
export const invalidateSafeReads=()=>{}
export const isReadCanceled=()=>false
export function createReadCoordinator(){return{run(_key,fn){return fn(new AbortController().signal)},invalidate(){}}}
export const useFarmStore=defineStore('verify-farm',()=>({seeds:ref([]),async fetchSeeds(){}}))
export const useFriendStore=defineStore('verify-friend',()=>({friends:ref([]),async fetchFriends(){}}))
export const useStatusStore=()=>({get status(){return fixture.status},get currentStatusReady(){return!!fixture.status},currentStatusStale:false})
export const useUserStore=()=>({isAdmin:true,isExpired:false,accountLimit:10,logout(){},userInfo:null})
export const verificationToasts=reactive([])
export const useToastStore=()=>({show(){},get toasts(){return verificationToasts},remove(id){const index=verificationToasts.findIndex(t=>t.id===id);if(index>=0)verificationToasts.splice(index,1)}})
export function useStorage(key,fallback){return key==='current_account_id'?computed({get:()=>fixture.selected,set:value=>fixture.selected=value}):ref(fallback)}
export const useIntervalFn=()=>({pause(){},resume(){}})
`;
  const entry = String.raw`
import{createApp,nextTick,ref,reactive,h}from'vue';import{createPinia}from'pinia';import{createRouter,createMemoryHistory,RouterView}from'vue-router';import Settings from '@/views/Settings.vue';import BaseSelect from '@/components/ui/BaseSelect.vue';import BaseInput from '@/components/ui/BaseInput.vue';import BaseSwitch from '@/components/ui/BaseSwitch.vue';import ConfirmModal from '@/components/ConfirmModal.vue';import ToastContainer from '@/components/ToastContainer.vue';import{vFoldMotion,vSlidingTabs}from'@/composables/useContentMotion';import{useAccountStore}from'@/stores/account';import{useSettingStore}from'@/stores/setting';import{fixture,raw,verificationToasts}from'verify:mock'
const NativeFetch=window.fetch;window.fetch=()=>{throw new Error('verification forbids network fetch')};window.XMLHttpRequest=class{open(){throw new Error('verification forbids XHR')}};window.WebSocket=class{constructor(){throw new Error('verification forbids WebSocket')}}
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/settings',component:Settings},{path:'/done',component:{render:()=>h('p','安全离页测试')}}]});const pinia=createPinia();const app=createApp({setup(){const selected=ref(0),number=ref(0),enabled=ref(false);return()=>[h('div',{id:'form-verification',style:'overflow:hidden;height:72px;margin:10px;padding:8px'},[h(BaseSelect,{modelValue:selected.value,'onUpdate:modelValue':v=>selected.value=v,label:'键盘测试',options:[{label:'零',value:0},{label:'禁用',value:1,disabled:true},{label:'二',value:2}]}),h(BaseInput,{modelValue:number.value,'onUpdate:modelValue':v=>number.value=v,label:'约束测试',type:'number',min:0,max:10,step:1}),h(BaseSwitch,{modelValue:enabled.value,'onUpdate:modelValue':v=>enabled.value=v,label:'开关测试'})]),h(RouterView),h(ToastContainer)]}});app.use(pinia);app.use(router);await router.push('/settings?tab=account');await router.isReady();app.mount('#app');const account=useAccountStore(pinia),setting=useSettingStore(pinia);window.__settingsVerification={app,router,account,setting,fixture,raw,nextTick};
const motionState=reactive({show:false,loading:false,tab:'a',confirmCount:0}),motionApp=createApp({setup(){return{motionState}},render(){return h(ConfirmModal,{show:motionState.show,loading:motionState.loading,title:'离线视觉验收',onCancel:()=>motionState.show=false,onConfirm:()=>motionState.confirmCount++})}});const holder=document.createElement('div');document.body.append(holder);motionApp.mount(holder);const folds=document.createElement('details');folds.className='motion-test-fold';folds.style.cssText='border:1px solid;padding:12px;box-sizing:border-box;width:300px';folds.innerHTML='<summary>折叠测试</summary><div style="height:200px">纯展示内容</div>';document.body.append(folds);vFoldMotion.mounted(folds,{});const tabs=document.createElement('nav');tabs.className='ui-tabs motion-test-tabs';tabs.style.cssText='position:relative;display:flex;gap:6px;padding:8px;width:420px';tabs.innerHTML='<button class="ui-tab" data-active="true" style="width:100px;height:40px">甲</button><button class="ui-tab" data-active="false" style="width:160px;height:40px">乙</button>';document.body.append(tabs);vSlidingTabs.mounted(tabs,{});window.__motionVerification={motionState,folds,tabs,verificationToasts};
`;
  const plugin = { name: 'settings-memory-only-verification', setup(build) {
    build.onResolve({ filter: /^verify:/ }, () => ({ path: 'verify:mock', namespace: 'verification' }));
    build.onResolve({ filter: /^@\// }, args => {
      if (['@/api', '@/stores/user', '@/stores/status', '@/stores/farm', '@/stores/friend', '@/stores/toast'].includes(args.path)) return { path: 'verify:mock', namespace: 'verification' };
      if (args.path === '@/config/localReadonly') return { path: 'readonly', namespace: 'verification' };
      if (hidden.some(name => args.path.endsWith('/' + name))) return { path: 'hidden', namespace: 'verification' };
      let filename = path.join(web, 'src', args.path.slice(2)); if (!path.extname(filename)) filename += '.ts'; return { path: filename };
    });
    build.onResolve({ filter: /^@vueuse\/core$/ }, () => ({ path: 'verify:mock', namespace: 'verification' }));
    build.onLoad({ filter: /.*/, namespace: 'verification' }, args => ({ contents: args.path === 'readonly' ? 'export const LOCAL_UI_READONLY=false' : args.path === 'hidden' ? "export default {render(){return null}}" : mock, loader: 'ts', resolveDir: web }));
    build.onLoad({ filter: /\.(png|webp)$/ }, () => ({ contents: "export default 'data:image/png;base64,'", loader: 'js' }));
    build.onLoad({ filter: /\.vue$/ }, args => {
      const descriptor = compiler.parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path }).descriptor;
      const id = 'data-v-verify-' + require('node:crypto').createHash('sha256').update(args.path).digest('hex').slice(0, 10);
      const script = compiler.compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component', templateOptions: { compilerOptions: { scopeId: descriptor.styles.some(s => s.scoped) ? id : undefined } } });
      for (const style of descriptor.styles) { const compiled = compiler.compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped }); assert.equal(compiled.errors.length, 0); styles.push(compiled.code); }
      return { contents: script.content + `\n__component.__scopeId='${id}';export default __component;`, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } };
  const output = await esbuild.build({ stdin: { contents: entry, resolveDir: web, loader: 'ts' }, absWorkingDir: web, nodePaths: [path.join(web, 'node_modules')], bundle: true, write: false, format: 'esm', target: 'es2022', plugins: [plugin], alias: { vue: webRequire.resolve('vue/dist/vue.runtime.esm-bundler.js') }, define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  // Use the same reset, utility classes and shared surface CSS as the actual
  // readonly build. Memory-only component checks must not assert layout on an
  // unstyled fixture (notably toast FLIP and horizontal selection surfaces).
  const buildDirectory = path.resolve(__dirname, '../../.workbuddy/frontend-20261112-local-readonly');
  const html = fs.readFileSync(path.join(buildDirectory, 'index.html'), 'utf8');
  const cssFiles = [...html.matchAll(/href="(?:\.\/|\/)?assets\/([^"]+\.css)"/g)].map(match => match[1]);
  const productionStyles = cssFiles.map(file => fs.readFileSync(path.join(buildDirectory, 'assets', file), 'utf8')).join('\n')
    .replace(/@import\s+(?:url\([^)]*\)|[^;]+);/g, '').replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (match, _quote, url) => url.startsWith('data:') ? match : 'none');
  return { code: output.outputFiles[0].text, styles: productionStyles + '\n' + styles.join('\n') };
}

test('Edge 本轮设置验收：键盘弹层、内存草稿与账号独立操作及真实只读网页', { skip: !process.env.FARM_LOCAL_SETTINGS_VERIFY }, async () => {
  const directory = path.resolve(process.env.FARM_LOCAL_SETTINGS_VERIFY), browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory);
  const requests = [], sockets = [], errors = [], report = { scenes: [], screenshots: [] };
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    let verificationStep = 0;
    const evaluate = async expression => {
      const step = ++verificationStep;
      try {
        const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
        return value.result.value;
      } catch (error) {
        throw new Error(`Settings verification step ${step}: ${expression.slice(0, 220)}\n${error.message}`, { cause: error });
      }
    };
    browser.events.on('Network.requestWillBeSent', event => { if (event.sessionId === sessionId) requests.push(event.params.request); });
    browser.events.on('Network.webSocketCreated', event => { if (event.sessionId === sessionId) sockets.push(event.params.url); });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) errors.push(event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:4177/settings?tab=account&v=settings-20261114' });
    await evaluate(String.raw`(async()=>{for(let i=0;i<160&&!document.querySelector('.settings-page');i++)await new Promise(r=>requestAnimationFrame(r));if(!document.querySelector('.settings-page'))throw Error('Real settings did not mount: '+JSON.stringify({href:location.href,title:document.title,body:document.body?.innerText.slice(0,500),html:document.querySelector('#app')?.innerHTML.slice(0,800),errors}));window.__verifyFrame=()=>new Promise(r=>requestAnimationFrame(r));window.__verifyWait=async f=>{for(let i=0;i<240&&!f();i++)await window.__verifyFrame();if(!f())throw Error('verification wait failed')};window.__verifyIdle=()=>window.__verifyWait(()=>!document.documentElement.dataset.contentMotion)})()`);
    report.realReadonly = await evaluate(String.raw`(()=>({noAccount:!localStorage.getItem('admin_token')&&!localStorage.getItem('current_account_id')&&!localStorage.getItem('user_info'),tabs:[...document.querySelectorAll('.settings-tab')].map(e=>({label:e.textContent.trim(),role:e.getAttribute('role')})),noFakeAccounts:document.querySelectorAll('.account-card').length===0}))()`);
    assert.equal(report.realReadonly.noAccount, true); assert.equal(report.realReadonly.noFakeAccounts, true); assert.equal(report.realReadonly.tabs.length, 5);
    for (const theme of ['light-green', 'dark-purple']) {
      await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').applyTheme(${JSON.stringify(theme)})`);
      await evaluate('(async()=>{for(let i=0;i<12;i++)await window.__verifyFrame()})()');
      const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), file = path.join(directory, `settings-five-${theme}-1440.png`); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); report.screenshots.push(file);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate('(async()=>{document.querySelector(\'[data-settings-tab="user"]\').click();await window.__verifyIdle();for(let i=0;i<10;i++)await window.__verifyFrame();if(document.documentElement.scrollWidth>375)throw Error("Settings overflow on mobile")})()');
    report.scenes.push('真实设置五页签、深浅主题和375px无横向溢出');
    await evaluate(String.raw`(async()=>{document.querySelector('[data-nav-path="/"]').click();await window.__verifyWait(()=>location.pathname==='/');await window.__verifyIdle();if(document.querySelector('.metric-card')?.textContent.includes('Lv.0'))throw Error('False zero level');if(document.querySelector('.dashboard-log-filters').open)throw Error('Log filters expanded by default');document.querySelector('.dashboard-log-filters summary').click();await window.__verifyFrame();if(!document.querySelector('[aria-label="日志模块"]'))throw Error('Log filter missing');})()`);
    report.scenes.push('真实概览保留指标和日志、无Lv.0、详细筛选按需展开');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const fixtureSource = await buildSettingsVerificationSource(directory);
    const blankLoaded = new Promise(resolve => { const listener = event => { if (event.sessionId === sessionId) { browser.events.off('Page.loadEventFired', listener); resolve(); } }; browser.events.on('Page.loadEventFired', listener); });
    await send('Page.navigate', { url: 'about:blank' }); await blankLoaded;
    await evaluate(`(()=>{document.documentElement.lang='zh-CN';document.head.innerHTML='<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src \\'unsafe-inline\\'; style-src \\'unsafe-inline\\'; img-src data:; connect-src \\'none\\'; form-action \\'none\\'">';document.body.innerHTML='<div id="app"></div>';window.__fixtureErrors=[];const originalConsoleError=console.error;console.error=(...args)=>{window.__fixtureErrors.push(args.map(a=>a?.stack||String(a)).join(' '));originalConsoleError(...args)};addEventListener('error',event=>window.__fixtureErrors.push(event.message));const style=document.createElement('style');style.textContent=${JSON.stringify(fixtureSource.styles + '\n:root{--theme-text:#2c2a22;--theme-primary:#416d3b;--surface-1:#fcfbf6;--surface-2:#f5f1e7;--surface-3:#eee8dc;--muted-text:#625b4d;--surface-border:#d9d3c6;--surface-border-strong:#c4b9a7;--input-bg:#fcfbf6;--radius-card:12px;--radius-control:8px;--action-bg:#416d3b;--action-text:#fff}body{background:var(--surface-2);color:var(--theme-text);font-family:Microsoft YaHei,sans-serif}button{cursor:pointer}')} ;document.head.append(style);const script=document.createElement('script');script.type='module';script.textContent=${JSON.stringify(fixtureSource.code)};document.body.append(script)})()`);
    await evaluate(String.raw`(async()=>{for(let i=0;i<200&&!window.__settingsVerification;i++)await new Promise(r=>requestAnimationFrame(r));if(!window.__settingsVerification)throw Error('In-memory settings verification did not boot: '+JSON.stringify(window.__fixtureErrors));window.__fixtureTick=async()=>{await window.__settingsVerification.nextTick();for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r))};window.__fixtureWait=async f=>{for(let i=0;i<160&&!f();i++)await window.__fixtureTick();if(!f())throw Error('Fixture wait failed: '+JSON.stringify({route:window.__settingsVerification.router.currentRoute.value.fullPath,selected:window.__settingsVerification.account.currentAccountId,settingsAccount:window.__settingsVerification.setting.settingsAccountId,readError:window.__settingsVerification.setting.readError,text:document.querySelector('#app')?.textContent.slice(-1600),tabs:[...document.querySelectorAll('.settings-tab')].map(e=>({text:e.textContent,selected:e.dataset.active})),errors:window.__fixtureErrors}))};})()`);
    await evaluate(String.raw`window.__fixtureDialog=()=>document.querySelector('dialog[open][data-leaving="false"]');window.__fixtureDismissed=()=>window.__fixtureWait(()=>!document.querySelector('dialog[open]'))`);
    const beforeFixtureCalls = requests.length;
    const key = async value => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: ({ ArrowDown:40, ArrowUp:38, Enter:13, Escape:27, Home:36, End:35, Tab:9 })[value] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: ({ ArrowDown:40, ArrowUp:38, Enter:13, Escape:27, Home:36, End:35, Tab:9 })[value] }); };
    await evaluate('document.querySelector("#form-verification .base-select-trigger").focus()'); await key('ArrowDown'); await key('ArrowDown');
    report.keyboard = await evaluate(String.raw`(()=>{const t=document.querySelector('#form-verification .base-select-trigger'),m=document.querySelector('.base-select-menu');if(t.getAttribute('aria-activedescendant')!==m.querySelector('[data-option-index="2"]').id)throw Error('Disabled option not skipped');const r=m.getBoundingClientRect();if(!m.matches(':popover-open')||r.bottom>innerHeight||r.top<0)throw Error('Dropdown clipped or not top layer');return{disabledSkipped:true,topLayer:true,withinViewport:true}})()`);
    await key('Enter'); assert.equal(await evaluate('document.querySelector("#form-verification .base-select-value").textContent.trim()'), '二');
    await key('Home'); await key('Enter'); assert.equal(await evaluate('document.querySelector("#form-verification .base-select-value").textContent.trim()'), '零');
    await key('ArrowDown'); await key('Escape'); assert.equal(await evaluate('document.querySelector("#form-verification .base-select-trigger").getAttribute("aria-expanded")'), 'false');
    report.scenes.push('真实键盘方向/Home/Enter/Esc、禁用项跳过、弹层不受裁切且数值0保留');
    await evaluate(String.raw`(async()=>{const v=window.__settingsVerification;await v.account.selectAccount('fixture-A');await window.__fixtureTick();await v.router.push('/settings?tab=strategy');await window.__fixtureTick();if(!document.querySelector('[data-settings-tab="strategy"]'))throw Error('Settings mounted without tab: '+JSON.stringify({html:document.querySelector('#app').innerHTML.slice(0,900),errors:window.__fixtureErrors}));document.querySelector('[data-settings-tab="strategy"]').click();await window.__fixtureWait(()=>document.querySelector('.settings-savebar'));const input=[...document.querySelectorAll('input')].find(e=>e.closest('.base-input-field')?.textContent.includes('种植延迟'));if(!input)throw Error('Strategy input missing');input.value='3';input.dispatchEvent(new Event('input',{bubbles:true}));await window.__fixtureTick();if(!document.querySelector('.settings-savebar').textContent.includes('有未保存修改'))throw Error('Strategy draft not tracked');const change=v.account.selectAccount('fixture-B');await window.__fixtureWait(()=>window.__fixtureDialog());window.__fixtureDialog().querySelector('[data-modal-cancel]').click();await change;if(v.account.currentAccountId!=='fixture-A')throw Error('Cancelled selection changed account');})()`);
    await evaluate(String.raw`(async()=>{const v=window.__settingsVerification;const leave=v.router.push('/done');await window.__fixtureWait(()=>window.__fixtureDialog());window.__fixtureDialog().querySelector('[data-modal-cancel]').click();await leave;await window.__fixtureDismissed();if(v.router.currentRoute.value.path!=='/settings')throw Error('Dirty route escaped');document.querySelector('.settings-savebar .base-button:last-child').click();await window.__fixtureWait(()=>window.__fixtureDialog());window.__fixtureDialog().querySelector('.base-button:last-child').click();await window.__fixtureTick();if(document.querySelector('.settings-savebar').textContent.includes('有未保存修改'))throw Error('Confirmed save not rebased');const calls=v.fixture.calls.filter(c=>c.method!=='GET');if(calls.length!==2||Object.keys(calls[1].body).join(',')!=='harvest_delay_min')throw Error('Strategy saved unrelated automation');})()`);
    report.scenes.push('真实策略草稿、换号取消/离页取消、保存当前页单次读回与相邻开关隔离');
    await evaluate(String.raw`(async()=>{const v=window.__settingsVerification;await v.router.push('/settings?tab=user');await window.__fixtureTick();const password=[...document.querySelectorAll('input')].find(e=>e.autocomplete==='current-password');password.value='memory-only';password.dispatchEvent(new Event('input',{bubbles:true}));await window.__fixtureTick();document.querySelector('[data-settings-tab="account"]').click();await window.__fixtureWait(()=>window.__fixtureDialog());window.__fixtureDialog().querySelector('[data-modal-cancel]').click();await window.__fixtureTick();if(!document.querySelector('input[autocomplete="current-password"]'))throw Error('Password draft dismissal guard missing');})()`);
    await evaluate(String.raw`(async()=>{const v=window.__settingsVerification;document.querySelector('[data-settings-tab="account"]').click();await window.__fixtureWait(()=>window.__fixtureDialog());window.__fixtureDialog().querySelector('.base-button:last-child').click();await window.__fixtureTick();await window.__fixtureWait(()=>document.querySelectorAll('.account-card').length===2);const cards=[...document.querySelectorAll('.account-card')];cards[1].querySelector('.account-more-actions').open=true;const edit=[...cards[1].querySelectorAll('button')].find(b=>b.textContent.includes('编辑资料'));edit.click();await window.__fixtureTick();if(v.account.currentAccountId!=='fixture-A')throw Error('Edit bubbled into account selection');})()`);
    report.scenes.push('密码草稿、跨标签确认、账号内部操作不冒泡切号');
    report.automationOverlay = await evaluate(String.raw`(async()=>{
      const v=window.__settingsVerification;await window.__fixtureDismissed();await v.router.push('/settings?tab=automation');await window.__fixtureTick();
      document.querySelector('[data-settings-tab="automation"]').click();await window.__fixtureWait(()=>document.querySelectorAll('.auto-card').length>0);
      const opener=[...document.querySelectorAll('.auto-card')].find(e=>e.textContent.includes('核心自动化'));opener.click();await window.__fixtureTick();
      const panel=document.querySelector('.modal-card[data-overlay-panel]');if(!panel||!panel.querySelector('fieldset').textContent.includes('自动种植收获'))throw Error('Actual automation overlay missing');
      panel.querySelector('[aria-label="关闭"]').click();await v.nextTick();
      if(panel.getAnimations()[0]?.effect.getTiming().duration!==150)throw Error('Actual automation exit missing');
      if(!panel.querySelector('h3').textContent.includes('核心自动化')||!panel.querySelector('fieldset').textContent.includes('自动种植收获'))throw Error('Automation content vanished during exit');
      if(!panel.closest('.fixed').inert)throw Error('Exiting automation controls remained interactive');
      await window.__fixtureWait(()=>!panel.isConnected);opener.click();await window.__fixtureTick();const reopened=document.querySelector('.modal-card[data-overlay-panel]');
      if(!reopened||reopened.closest('.fixed').inert)throw Error('Reopened automation did not restore controls');reopened.querySelector('[aria-label="关闭"]').click();await window.__fixtureWait(()=>!reopened.isConnected);
      return{realComponent:true,exitMs:150,contentPreserved:true,staleControlsInert:true,reopenUsable:true}
    })()`);
    await evaluate(String.raw`(async()=>{const v=window.__settingsVerification,opener=[...document.querySelectorAll('.auto-card')].find(e=>e.textContent.includes('牧场自动化'));if(!opener)throw Error('Ranch automation category missing');opener.click();await window.__fixtureWait(()=>document.querySelector('.category-dialog__body'));})()`);
    report.ranchAutomationLayout = await evaluate(String.raw`(()=>{const panel=document.querySelector('.category-dialog'),body=panel?.querySelector('.category-dialog__body');if(!panel||!body)throw Error('Ranch automation dialog missing');const bounds=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}};const cards=[...body.querySelectorAll('.ui-subtle-panel')],note=body.querySelector('.category-dialog__note');return{panel:bounds(panel),body:bounds(body),cards:cards.map(bounds),note:note&&bounds(note),horizontalOverflow:body.scrollWidth>body.clientWidth+1,allCardsInside:cards.every(e=>e.getBoundingClientRect().left>=panel.getBoundingClientRect().left-1&&e.getBoundingClientRect().right<=panel.getBoundingClientRect().right+1),noteInside:!!note&&note.getBoundingClientRect().right<=panel.getBoundingClientRect().right+1}})()`);
    assert.equal(report.ranchAutomationLayout.horizontalOverflow,false,JSON.stringify(report.ranchAutomationLayout));
    assert.equal(report.ranchAutomationLayout.allCardsInside,true,JSON.stringify(report.ranchAutomationLayout));
    assert.equal(report.ranchAutomationLayout.noteInside,true,JSON.stringify(report.ranchAutomationLayout));
    await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(({data})=>{const file=path.join(directory,'ranch-automation-desktop.png');fs.writeFileSync(file,Buffer.from(data,'base64'));report.screenshots.push(file)});
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:900,deviceScaleFactor:1,mobile:false});
    report.ranchAutomationMobile = await evaluate(String.raw`(()=>{const panel=document.querySelector('.category-dialog'),body=panel?.querySelector('.category-dialog__body');if(!panel||!body)throw Error('Mobile ranch automation dialog missing');const cards=[...body.querySelectorAll('.ui-subtle-panel')],right=panel.getBoundingClientRect().right;return{viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,panelWidth:panel.getBoundingClientRect().width,bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,cardCount:cards.length,allCardsInside:cards.every(e=>e.getBoundingClientRect().right<=right+1),horizontalOverflow:body.scrollWidth>body.clientWidth+1}})()`);
    assert.ok(report.ranchAutomationMobile.documentWidth<=375,JSON.stringify(report.ranchAutomationMobile));
    assert.equal(report.ranchAutomationMobile.horizontalOverflow,false,JSON.stringify(report.ranchAutomationMobile));
    assert.equal(report.ranchAutomationMobile.allCardsInside,true,JSON.stringify(report.ranchAutomationMobile));
    assert.equal(report.ranchAutomationMobile.cardCount,16,JSON.stringify(report.ranchAutomationMobile));
    report.ranchAutomationScroll = await evaluate(String.raw`(async()=>{const panel=document.querySelector('.category-dialog'),body=panel?.querySelector('.category-dialog__body'),footer=panel?.querySelector('.flex.shrink-0.justify-end');body.scrollTop=body.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const cards=[...body.querySelectorAll('.ui-subtle-panel')],last=cards.at(-1),br=body.getBoundingClientRect(),lr=last.getBoundingClientRect(),fr=footer.getBoundingClientRect();return{scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,lastCardFullyVisible:lr.top>=br.top-1&&lr.bottom<=br.bottom+1,footerVisible:fr.top>=panel.getBoundingClientRect().top&&fr.bottom<=panel.getBoundingClientRect().bottom,lastCardFooterSeparated:lr.bottom<=fr.top+1}})()`);
    assert.ok(report.ranchAutomationScroll.lastCardFullyVisible,JSON.stringify(report.ranchAutomationScroll));
    assert.ok(report.ranchAutomationScroll.footerVisible,JSON.stringify(report.ranchAutomationScroll));
    assert.ok(report.ranchAutomationScroll.lastCardFooterSeparated,JSON.stringify(report.ranchAutomationScroll));
    await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}).then(({data})=>{const file=path.join(directory,'ranch-automation-mobile-bottom.png');fs.writeFileSync(file,Buffer.from(data,'base64'));report.screenshots.push(file)});
    report.polish = await evaluate(String.raw`(async()=>{
      const m=window.__motionVerification,s=m.motionState;const frame=()=>new Promise(r=>requestAnimationFrame(r));
      s.show=true;await window.__fixtureTick();const modal=[...document.querySelectorAll('dialog')].find(e=>e.textContent.includes('离线视觉验收'));if(!modal?.matches(':modal'))throw Error('Modal lost native semantics');
      s.show=false;await window.__settingsVerification.nextTick();const out=modal.getAnimations()[0];if(!out||out.effect.getTiming().duration!==150)throw Error('Modal exit missing');
      const at=getComputedStyle(modal).transform;s.show=true;await window.__settingsVerification.nextTick();await window.__fixtureTick();if(!modal.open)throw Error('Reopen closed modal');
      s.loading=true;await window.__fixtureTick();modal.dispatchEvent(new Event('cancel',{cancelable:true}));if(!s.show)throw Error('Pending cancel affected operation');
      s.loading=false;s.show=false;for(let i=0;i<20;i++)await frame();if([...document.querySelectorAll('dialog')].some(e=>e.textContent.includes('离线视觉验收')))throw Error('Modal never exited');
      const details=m.folds;details.querySelector('summary').click();await frame();const height=details.getBoundingClientRect().height;details.querySelector('summary').click();const fold=details.getAnimations()[0];if(!fold||Math.abs(parseFloat(fold.effect.getKeyframes()[0].height)-height)>1)throw Error('Fold reversal jumped');for(let i=0;i<20;i++)await frame();if(details.open)throw Error('Fold did not settle closed');
      const tabs=m.tabs,selection=tabs.querySelector('.ui-tab-selection'),buttons=tabs.querySelectorAll('button'),initial=selection.style.transform;
      buttons[0].dataset.active='false';buttons[1].dataset.active='true';await frame();await frame();
      const halfway=selection.style.transform,position=new DOMMatrix(halfway).m41;
      if(!(position>buttons[0].offsetLeft+.1&&position<buttons[1].offsetLeft-.1))throw Error('First tab click snapped to destination');
      const beforeResize=selection.style.transform;tabs.style.width='460px';if(selection.style.transform!==beforeResize)throw Error('Resize snapped synchronously');await frame();await frame();
      if(new DOMMatrix(selection.style.transform).m41>=buttons[1].offsetLeft-.1)throw Error('Resize erased active tab travel');
      const beforeReverse=selection.style.transform;buttons[0].dataset.active='true';buttons[1].dataset.active='false';if(selection.style.transform!==beforeReverse)throw Error('Tab snapped on reversal');
      for(let i=0;i<45;i++)await frame();if(Math.abs(new DOMMatrix(selection.style.transform).m41-buttons[0].offsetLeft)>.3)throw Error('Tab surface never settled');
      const toastList=m.verificationToasts;toastList.push({id:1,type:'info',message:'离线验收通知一'},{id:2,type:'success',message:'离线验收通知二'},{id:3,type:'warning',message:'离线验收通知三'});
      for(let i=0;i<14;i++)await frame();const notices=[...document.querySelectorAll('.toast-item')],third=notices[2],beforeY=third.getBoundingClientRect().y;
      notices[1].querySelector('[aria-label="关闭通知"]').click();await window.__settingsVerification.nextTick();
      if(!third.classList.contains('toast-move')){const clone=third.cloneNode();clone.classList.add('toast-move');clone.style.visibility='hidden';third.parentElement.append(clone);const style=getComputedStyle(clone);const state={beforeY,currentY:third.getBoundingClientRect().y,classes:third.className,stackDisplay:getComputedStyle(third.parentElement).display,count:document.querySelectorAll('.toast-item').length,transitionProperty:style.transitionProperty,transitionDuration:style.transitionDuration,positions:[...document.querySelectorAll('.toast-item')].map(e=>({class:e.className,y:e.getBoundingClientRect().y,position:getComputedStyle(e).position}))};clone.remove();throw Error('Toast stack replacement has no FLIP move: '+JSON.stringify(state))}
      for(let i=0;i<4;i++)await frame();const duringY=third.getBoundingClientRect().y;for(let i=0;i<20;i++)await frame();const afterY=third.getBoundingClientRect().y;
      if(!(afterY<duringY&&duringY<beforeY)||document.querySelectorAll('.toast-item').length!==2)throw Error('Toast replacement did not travel to a stable slot');
      toastList.splice(0);for(let i=0;i<12;i++)await frame();
      return{modalEnterExit:true,pendingNotCanceled:true,reopenUsesCurrentPaint:true,foldCurrentHeight:true,tabContinuous:true,firstClickTravel:true,resizeRetargetContinuous:true,toastContinuous:true,toastY:{beforeY,duringY,afterY},initial,halfway}
    })()`);
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    report.polishReduced = await evaluate(String.raw`(async()=>{const m=window.__motionVerification;m.motionState.show=true;await window.__fixtureTick();const modal=[...document.querySelectorAll('dialog')].find(e=>e.textContent.includes('离线视觉验收'));if(modal.getAnimations().length)throw Error('Reduced modal animated');m.motionState.show=false;await window.__fixtureTick();m.folds.querySelector('summary').click();if(m.folds.getAnimations().length)throw Error('Reduced folding animated');m.verificationToasts.push({id:4,type:'info',message:'减动效通知'});await window.__fixtureTick();const toast=document.querySelector('.toast-item');if(toast.getAnimations().length)throw Error('Reduced toast animated');m.verificationToasts.splice(0);await window.__fixtureTick();return{modalInstant:true,foldInstant:true,toastInstant:true}})()`);
    report.scenes.push('弹窗开关/快速重开/在途不可取消、折叠当前高度反向、标签连续选中面与减动效');
    // Embedded data: SVG icons are decoded locally but Edge reports them as
    // resource events. Reject all actual network attempts, not local decoding.
    const fixtureNetwork = requests.slice(beforeFixtureCalls).filter(request => !request.url.startsWith('data:'));
    assert.equal(fixtureNetwork.length, 0, 'in-memory component checks attempted network: ' + JSON.stringify(fixtureNetwork.map(request => ({ method: request.method, url: request.url })))); assert.equal(sockets.length, 0);
    report.apiRequests = requests.filter(r=>/\/api\/|\/socket\.io/.test(r.url)); report.networkWrites = requests.filter(r=>!['GET','HEAD'].includes(r.method)); report.errors = errors;
    assert.equal(report.apiRequests.length, 0); assert.equal(report.networkWrites.length, 0); assert.equal(errors.length, 0);
    fs.writeFileSync(path.join(directory, 'settings-five-verification.json'), JSON.stringify(report,null,2)+'\n');
    console.log('SETTINGS_FIVE_VERIFIED', JSON.stringify({ scenes: report.scenes, noAccount: true, apiRequests:0,websockets:0,networkWrites:0,keyboard:report.keyboard }));
  } finally { await browser.close(); }
});

test('Edge 正式发布构建保留认证且隔离真实网络', { skip: !process.env.FARM_PRODUCTION_UI_VERIFY }, async () => {
  const http = require('node:http');
  const build = path.resolve(process.env.FARM_PRODUCTION_UI_VERIFY), directory = path.resolve(process.env.FARM_PRODUCTION_VERIFY_DIR);
  assert.ok(fs.statSync(path.dirname(directory)).isDirectory()); fs.mkdirSync(directory, { recursive: true });
  const networkAttempts = [], errors = [], sockets = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)) {
      throw new Error('Production browser verification must intercept backend requests before the static server');
    }
    const file = path.resolve(build, '.' + decodeURIComponent(url.pathname));
    if (file !== build && !file.startsWith(build + path.sep)) { response.writeHead(403); response.end(); return; }
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(build, 'index.html');
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' })[path.extname(target)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); fs.createReadStream(target).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => { const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result.value; };
    const interceptions = new Set();
    browser.events.on('Fetch.requestPaused', event => {
      if (event.sessionId !== sessionId) return;
      const task = (async () => {
        const { requestId, request } = event.params, url = new URL(request.url);
        if (url.origin !== origin || url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io') || !['GET', 'HEAD'].includes(request.method)) {
          networkAttempts.push({ method: request.method, path: url.pathname });
          await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ ok: true, data: {}, clientVersion: 'offline-verification' })).toString('base64') });
        } else await send('Fetch.continueRequest', { requestId });
      })();
      interceptions.add(task); task.then(() => interceptions.delete(task), error => { interceptions.delete(task); errors.push(error.message); });
    });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) errors.push(event.params.exceptionDetails.text); });
    browser.events.on('Network.webSocketCreated', event => { if (event.sessionId === sessionId) sockets.push(event.params.url); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Page.navigate', { url: origin + '/settings?readonly=1' });
    const report = await evaluate(String.raw`(async()=>{for(let i=0;i<160&&!document.querySelector('.login-container');i++)await new Promise(r=>requestAnimationFrame(r));if(!document.querySelector('.login-container')||location.pathname!=='/login')throw Error('Production anonymous route bypassed login');if(document.querySelector('.settings-page'))throw Error('Production exposed anonymous settings');return{loginRequired:true,queryCannotBypass:true,noAccount:!localStorage.getItem('admin_token')&&!localStorage.getItem('current_account_id')&&!localStorage.getItem('user_info'),language:document.documentElement.lang}})()`);
    assert.equal(report.loginRequired, true); assert.equal(report.noAccount, true); assert.equal(report.language, 'zh-CN');
    assert.equal(networkAttempts.filter(item => !['GET', 'HEAD'].includes(item.method)).length, 0); assert.equal(sockets.length, 0); assert.equal(errors.length, 0);
    await Promise.all([...interceptions]);
    fs.writeFileSync(path.join(directory, 'production-auth-verification.json'), JSON.stringify({ ...report, interceptedReads: networkAttempts, actualBackendRequests: 0, networkWrites: 0, errors, sockets }, null, 2) + '\n');
    console.log('PRODUCTION_AUTH_VERIFIED', JSON.stringify({ ...report, actualBackendRequests: 0, networkWrites: 0, sockets: 0 }));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

async function realtimeEdge(edge, directory, gpu = false) {
  const { spawn } = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const child = spawn(edge, ['--headless=new', ...(gpu ? [] : ['--disable-gpu']), '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.join(directory, 'edge-realtime-profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const address = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Dedicated Edge debugging endpoint timed out')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Dedicated Edge exited before ready: ' + code)); });
      child.stderr.on('data', chunk => {
        text += chunk.toString(); const match = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const pending = new Map(), events = new EventEmitter(); let sequence = 0;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const callback = pending.get(message.id); pending.delete(message.id);
        clearTimeout(callback.timer);
        if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
      } else events.emit(message.method, message);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      // A real-time suite can await many 460/380ms animations in one evaluation;
      // extend only its transport budget, never the application's capture guard.
      const timeout = method === 'Runtime.evaluate' && params.awaitPromise ? 45000 : 15000;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Edge command timed out: ' + method)); }, timeout);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return { send, events, async close() { try { await send('Browser.close'); } catch {} socket.close(); if (child.exitCode === null) child.kill(); } };
  } catch (error) { socket?.close(); child.kill(); throw error; }
}
async function edgeRealtimeReport(browser, url, width, reduced) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  let listener, timer;
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
    await send('Runtime.addBinding', { name: 'uxTestReport' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "addEventListener('ux-verification-finished',()=>uxTestReport(JSON.stringify(window.__uxReport)))" });
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Real-time browser checks timed out at ' + width)), 15000);
      listener = event => { if (event.sessionId === sessionId && event.params.name === 'uxTestReport') resolve(JSON.parse(event.params.payload)); };
      browser.events.on('Runtime.bindingCalled', listener);
    });
    await send('Page.navigate', { url });
    const report = await result;
    report.browserClock = 'real-time compositor, no virtual-time budget';
    return report;
  } finally {
    clearTimeout(timer); if (listener) browser.events.off('Runtime.bindingCalled', listener);
    await browser.send('Target.closeTarget', { targetId });
  }
}

function ranchVisualFixtures() {
  const root = path.resolve(web, '../core/src/gameConfig/ranch');
  const config = name => JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'));
  const manifest = config('image-manifest'), items = new Map(config('MCItemInfo').map(row => [String(row.id), row]));
  const facilities = new Map(config('MCFacilityConfig').map(row => [String(row.facility_id), row]));
  const now = Date.now(), sourceCommit = '6ac7a3d7930018058d201af86beea8de6a9f8507';
  const reward = (id, count = '1') => ({ id: String(id), count, name: items.get(String(id))?.name || `物品 ${id}`, image: manifest.items[String(id)]?.url || '' });
  const base = { readOnly: true, sceneId: 2, ownerGid: '700000001', observedAt: now, serverTimeMs: now,
    dateKey: new Date(now).toLocaleDateString('en-CA'), sourceCommit, cache: { hit: true, receivedAt: now } };
  const animal = (id, instanceId, giant = false) => ({ instanceId, animalId: String(id), slot: instanceId,
    name: `${giant ? '巨大' : ''}${items.get(String(id))?.name || '动物'}`, image: giant ? '' : manifest.items[String(id)]?.url || '',
    imageRole: '官方幼崽道具图标，不是当前阶段立绘', stage: 2, stageName: '成长中', produceCount: 1, maxProduceCount: 3,
    limitedCanUsed: true, canHarvest: false, canProduce: true, canFeed: true, canRelease: true, grassBlocked: false,
    producing: true, nextAtMs: now + 3600000, expectedHarvest: { exp: '80', items: [reward(1060001, '2')] },
    expectedProduce: { exp: '40', items: [reward(2060001)] }, mutation: giant ? { type: 1, tier: 2, weightX10: 1124, strokable: true } : null });
  const pen = (id, facilityId, animals) => ({ id, facilityId,
    moduleType: facilities.get(String(facilityId)).module_type === 'MODULE_TYPE_RANCH_COOP' ? 6 : 7,
    name: facilities.get(String(facilityId)).name, image: manifest.facilities[String(facilityId)]?.url || '',
    level: facilities.get(String(facilityId)).level, capacity: facilities.get(String(facilityId)).capacity, state: 0, upgradeState: 0,
    upgradeEndAtMs: null, nextUpgrade: null, position: { x: 1, y: 2 }, feedMachine: null,
    ranch: { id, husbandryType: facilities.get(String(facilityId)).module_type === 'MODULE_TYPE_RANCH_COOP' ? 1 : 2,
      capacity: facilities.get(String(facilityId)).capacity, animalCount: animals.length, grass: { amount: '1234567', emptyAtMs: now + 7200000 },
      hazardCount: 1, shelfCount: 1, animals, hazards: [{ id: '9001', type: 1, ownerGid: '700000001' }],
      shelves: [{ slot: 1, totalRemain: '3', canCollect: true, products: [reward(1060001, '3')] }] } });
  const overview = { ...base, actionsEnabled: true, source: { repository: 'pinned-local-config', commit: sourceCommit },
    grid: { width: 12, height: 12, cellCount: 144, openCellCount: 24, regionOccupied: 2, regionQuota: 4 },
    summary: { facilityCount: 3, ranchCount: 2, animalCount: 3, harvestableCount: 0, grassBlockedCount: 0 },
    facilities: [pen('9223372036854775806', 6001001, [animal(60001, 1), animal(60013, 2)]), pen('9007199254740997', 6002001, [animal(70002, 3, true)]),
      { id: '9007199254740996', facilityId: 7001001, moduleType: 8, name: '牧草机', image: manifest.facilities['7001001'].url,
        level: 1, capacity: 100, state: 0, upgradeState: 0, upgradeEndAtMs: null, nextUpgrade: null, position: { x: 5, y: 6 },
        ranch: null, feedMachine: { count: 100, consumeRate: 1, remainingSec: 3600, status: 1 } }],
    layoutActionsEnabled: false, cells: [{ id: '1', x: 1, y: 2, status: 1, regionId: 1, occupiedBy: '9223372036854775806', unlockEndAtMs: null }], buildingItems: [] };
  const bagItem = (id, category, extra = {}) => ({ ...reward(id, '12'), uid: '9223372036854775806', availableCount: '12', availableTypeCount: '12',
    type: 101, locked: false, category, can: null, animal: null, product: null, canUseCan: false, canPlace: false, ...extra });
  const bagOverview = { ...base, receivedAt: now, cacheHit: true, level: { level: 12, exp: '1000', currentExp: '80', neededExp: '300' },
    items: [bagItem(60013, 'cub', { animal: { id: 60013, husbandryType: 1, giantCub: false }, canPlace: true }),
      bagItem(80021, 'can', { can: { bucketId: 7003, seconds: 3600, family: '普通罐头' }, canUseCan: true }),
      bagItem(65002, 'cub', { animal: { id: 60002, husbandryType: 1, giantCub: true }, canPlace: true }),
      bagItem(1060001, 'product', { product: { weightX10: 1124, tier: 2 } })],
    goldVoucherBalance: '123456789',
    pens: [{ id: '9223372036854775806', name: '牧场窝', husbandryType: 1, capacity: 3, animalCount: 2, room: 1 }], buckets: { normal: '7200', organic: '3600' } };
  const tasks = { ...base, guideReportingEnabled: false, automaticClaimEnabled: false, summary: { total: 3, claimable: 1, claimed: 0, daily: 2 },
    tasks: [0, 1, 2].map((index) => ({ id: String(700001 + index), category: index < 2 ? 'daily' : 'growth',
      description: index === 0 ? '照料牧场动物，完成当天经营任务' : '本地布局示例：较长的任务说明也应完整换行，不与状态标签重叠',
      progress: index === 0 ? '3' : '1', total: '3', group: '1', claimed: false, unlocked: true, configConfirmed: true,
      shareMultiple: '1', condition: '', rewards: [reward(1005, '30')], extraRewards: [], canClaim: index === 0, stateReason: index === 0 ? '可普通领取' : '未完成' })) };
  const giantProductFor = require('../src/services/ranch-config').getRanchGiantProduct;
  const animals = new Map(config('MCAnimalConfig').map(row => [String(row.id), row]));
  const book = { ...base, type: 101, normal: { currentLevel: 2, totalProgress: 5, nextProgress: 8, levels: [],
    rewards: [reward(1005, '80')], rewardStatusConfirmed: false, canClaim: false, stateReason: '当前奖励终态未确认' },
    giant: { totalScore: '1124', currentId: 2, calculationMode: 1, levels: [{ id: 1, need: '1000', claimed: false, canClaim: true, rewards: [reward(1008, '10')] }] },
    animals: [60001, 60013, 60002].map(animalId => {
      const id = Number(animals.get(String(animalId))?.product_item?.id || animalId), mapping = giantProductFor(id);
      return { id: String(id), name: items.get(String(id))?.name || '动物', image: manifest.items[String(id)]?.url || '',
        rarity: 1, layer: 2, progress: 2, unlocked: true, isNew: false,
        giantItem: mapping ? { id: String(mapping.itemId), name: mapping.item?.name || '巨大产物', image: manifest.items[String(mapping.itemId)]?.url || '' } : null,
        giant: animalId === 60002 ? { unlocked: true, tier: 2, tierName: '巨大', bestWeightKg: 11.24, minWeightKg: 10, maxWeightKg: 20, harvestCount: '3', isNew: false } : null };
    }), mutations: [] };
  const share = { ...base, shareId: '102', docId: '2101', known: false, shareCount: null, claimed: null,
    shared: false, canReport: false, canClaim: false, automaticShareEnabled: false, rewards: [reward(1005, '10')], stateReason: '牧场分享标记尚未确认' };
  const market = { ...base, shopId: 7, opened: true, present: true, periodDay: '20261118', roundIndex: 2, automaticExchangeEnabled: false,
    shelves: [{ id: 1, name: '幼崽货架', sort: 1 }, { id: 2, name: '补给货架', sort: 2 }],
    goods: [60013, 80021, 65002].map((id, index) => ({ id: String(9223372036854775806n - BigInt(index)), shelfId: index === 0 ? 1 : 2, slot: index,
      name: items.get(String(id))?.name || `物品 ${id}`, reward: reward(id), currencyId: index === 0 ? '1005' : '1008',
      currencyName: index === 0 ? '金豆豆' : '松果币', currencyImage: '', unitPrice: '123456789', currencyBalance: '1234567890123456789',
      remaining: '3', maxCount: 3, limitUsed: '1', available: index !== 2, discounted: index === 0, priceValidUntilMs: now + 60000,
      requiredLevel: 5, stateReason: index === 2 ? '兑换条件尚未确认，保持禁用' : '' })) };
  const guide = config('OpeningActivity');
  const activities = { ...base, actionsEnabled: false, notice: '这里只展示目录和时间，不执行活动领奖或人格测试。', detail: null, guide,
    activities: [{ id: '9223372036854775806', name: '牧歌初启 · 目录示例', parentId: '0', groupId: '9223372036854775806', type: '2',
      beginTimeMs: new Date(guide.begin).getTime(), endTimeMs: new Date(guide.endExclusive).getTime(), actionsEnabled: false,
      progressState: 'unconfirmed', children: [{ id: '9007199254740997', name: '兴牧庆典：具体领取进度未确认', children: [] }] }] };
  const friendOverview = { gid: '700000002', name: '示例好友（未连接真实账号）', level: 12, hostAtHome: true, tourist: false, observedAt: now,
    remaining: { stroke: 1, putMosquito: 2 }, summary: { ranchCount: 1, animalCount: 1, stealableShelfCount: 1, cleanableHazardCount: 1, strokableCount: 1, mosquitoRoom: 1 },
    ranches: [{ id: '9223372036854775806', husbandryType: 1, name: '牧场窝', capacity: 6, animalCount: 1, mosquitoes: 1, mosquitoLimit: 2,
      mosquitoRoom: 1, canPutMosquito: true, hazardCount: 1, cleanableHazardCount: 1, animals: [{ instanceId: 1, animalId: '60001', name: '小鸡', stage: 2, stroked: false, canStroke: true, mutation: null }],
      shelves: [{ slot: 1, canSteal: true, products: [{ id: '1060001', count: '3', canSteal: true }] }] }], cache: { hit: true, receivedAt: now } };
  const catalogGood = (id, itemId) => ({ ...reward(itemId), id, itemId, itemCount: 1, name: items.get(String(itemId))?.name || '示例商品',
    currencyId: 1005, currencyBalance: '1000', unitPrice: 5, maxCount: 3, remaining: 3, available: true, unlocked: true, owned: false, valid: true, discounted: false });
  const catalogs = { 5: [catalogGood(501, 60013)], 6: [catalogGood(502, 7001)] };
  const canGood = { id: '600001', name: '离线罐头商品', rewards: [reward(80021)], currencyId: 1005,
    unitPrice: '5', currencyBalance: '1000', free: false, remaining: 3, maxCount: 3, available: true, stateReason: '' };
  const canCatalogs = { 6: [canGood], 7: [{ ...canGood, id: '600002', rewards: [reward(80031)] }] };
  return { overview, bagOverview, friendOverview, catalogs, canCatalogs, progressViews: { tasks, book, share, market, activities },
    accounts: [{ id: 'fixture-ranch-A', name: '内存布局示例甲', platform: 'qq', running: false }, { id: 'fixture-ranch-B', name: '内存布局示例乙', platform: 'wx', running: false }] };
}

test('Edge 双工作区只读验收：两套完整侧栏、独立页面、赶牛动画与未知保护', { skip: !process.env.FARM_LOCAL_RANCH_VERIFY }, async () => {
  const http = require('node:http');
  const build = path.resolve(process.env.FARM_LOCAL_RANCH_BUILD), directory = path.resolve(process.env.FARM_LOCAL_RANCH_VERIFY);
  assert.ok(fs.statSync(path.dirname(directory)).isDirectory()); fs.mkdirSync(directory, { recursive: true });
  const report = { ok: false, actualVuePages: true, fixtureDataOnly: true, noRealAccountLogin: true, samples: [], screenshots: [], issues: [],
    requests: [], sockets: [], serverDenied: [], errors: [] };
  const origin = 'http://127.0.0.1:4177';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (/^\/(?:api(?:\/|$)|socket\.io(?:\/|$))/.test(url.pathname) || !['GET', 'HEAD'].includes(request.method)) {
      report.serverDenied.push({ path: url.pathname, method: request.method }); response.writeHead(403); response.end(); return;
    }
    const filename = path.resolve(build, '.' + decodeURIComponent(url.pathname));
    if (filename !== build && !filename.startsWith(build + path.sep)) { response.writeHead(403); response.end(); return; }
    const existing = fs.existsSync(filename) && fs.statSync(filename).isFile();
    if (!existing && /\.[^/]+$/.test(url.pathname)) { response.writeHead(404); response.end(); return; }
    const target = existing ? filename : path.join(build, 'index.html');
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2' })[path.extname(target)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" });
    if (request.method === 'HEAD') response.end(); else fs.createReadStream(target).pipe(response);
  });
  server.on('upgrade', (request, socket) => { report.serverDenied.push({ path: request.url, method: 'UPGRADE' }); socket.destroy(); });
  let browser, send;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4177, '127.0.0.1', resolve); });
    browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const pending = new Set();
    browser.events.on('Fetch.requestPaused', event => {
      if (event.sessionId !== sessionId) return;
      const job = (async () => {
        const { requestId, request } = event.params, url = new URL(request.url);
        const allowed = url.protocol === 'data:' || url.origin === origin && ['GET', 'HEAD'].includes(request.method)
          && !/^\/(?:api(?:\/|$)|socket\.io(?:\/|$))/.test(url.pathname);
        if (!allowed) { report.errors.push('禁止的网络尝试：' + request.url); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
        else await send('Fetch.continueRequest', { requestId });
      })();
      pending.add(job); job.then(() => pending.delete(job), error => { pending.delete(job); report.errors.push(error.message); });
    });
    browser.events.on('Network.requestWillBeSent', event => { if (event.sessionId === sessionId) report.requests.push({ url: event.params.request.url, method: event.params.request.method }); });
    browser.events.on('Network.webSocketCreated', event => { if (event.sessionId === sessionId) report.sockets.push(event.params.url); });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) report.errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    let initScript;
    async function open(route, width, theme) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      if (initScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
      initScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin===${JSON.stringify(origin)}){for(const key of ['admin_token','user_info','current_account_id'])localStorage.removeItem(key);localStorage.setItem('ui_theme',${JSON.stringify(theme)})}` })).identifier;
      const pathname = route.split('?')[0], canonical = pathname === '/farm' ? '/personal' : pathname === '/farm/status' ? '/' : pathname;
      const workspace = canonical.startsWith('/ranch') ? 'ranch' : 'farm';
      const page = { '/ranch':'overview', '/ranch/personal':'personal', '/ranch/friends':'friends', '/ranch/activity':'activity', '/ranch/shop':'shop', '/ranch/illustrated':'illustrated' }[canonical];
      await send('Page.navigate', { url: origin + route });
      await evaluate(`(async()=>{const frame=()=>new Promise(r=>requestAnimationFrame(r));for(let i=0;i<180&&(!document.querySelector('[data-game-workspace="${workspace}"]')||!document.querySelector('[data-page-content]')?.firstElementChild||${page ? `!document.querySelector('[data-ranch-page="${page}"]')` : 'false'});i++)await frame();await frame();await frame();if(!document.querySelector('[data-game-workspace="${workspace}"]')||location.pathname!==${JSON.stringify(canonical)})throw Error('工作区页面未加载：'+location.pathname);if(localStorage.getItem('admin_token')||localStorage.getItem('user_info')||localStorage.getItem('current_account_id'))throw Error('匿名只读页面出现账号凭据')})()`);
    }
    async function capture(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(data, 'base64')); report.screenshots.push(name + '.png');
    }
    async function sample(label) {
      const value = await evaluate(`(async()=>{
        const frame=()=>new Promise(r=>requestAnimationFrame(r));await frame();await frame();
        const root=document.querySelector('[data-page-content]'),page=root?.firstElementChild,title=page?.querySelector('h1')||document.querySelector('.layout-page-context');
        if(!root||!page||!title)throw Error('真实页面结构缺失');
        const workspace=document.querySelector('[data-game-workspace]')?.dataset.gameWorkspace,sidebar=document.querySelector('[data-sidebar-workspace]');
        const links=[...sidebar.querySelectorAll('.sidebar-nav-link')],sidebarPaths=links.map(e=>e.dataset.navPath),sidebarLabels=links.map(e=>e.querySelector('.sidebar-nav-content').textContent.trim());
        const expectedWorkspace=location.pathname.startsWith('/ranch')?'ranch':'farm';
        const correctWorkspace=workspace===expectedWorkspace&&sidebar.dataset.sidebarWorkspace===expectedWorkspace&&sidebarPaths.every(p=>workspace==='ranch'?p.startsWith('/ranch'):!p.startsWith('/ranch'));
        const commonMenus=['概览','个人','好友','活动','商城','图鉴','设置'].every(label=>sidebarLabels.includes(label));
        const originalFarmMenus=workspace==='ranch'||['宠物','藏品','变异宝典','分析'].every(label=>sidebarLabels.includes(label));
        const selectedSide=links.filter(e=>e.getAttribute('aria-current')==='page');
        const visibleRoute=sidebarPaths.includes(location.pathname),sidebarSelectionValid=!visibleRoute||selectedSide.length===1&&selectedSide[0].dataset.navPath===location.pathname;
        const rgb=value=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=value;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3)};
        const luminance=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
        const css=getComputedStyle(document.documentElement), card=page.querySelector('.ui-card,.ranch-card')||document.querySelector('main>header');
        const contrast=ratio(getComputedStyle(title).color,getComputedStyle(card).backgroundColor);
        const texts=[...page.querySelectorAll('p,b,strong,h3')].filter(e=>e.getBoundingClientRect().width>0&&e.scrollWidth>e.clientWidth+2)
          .map(e=>({tag:e.tagName,class:e.className,text:e.textContent.trim().slice(0,80),width:e.clientWidth,scrollWidth:e.scrollWidth})).slice(0,10);
        const tabs=page.querySelector('.ranch-tabs'),selected=tabs?.querySelector('[aria-selected="true"]');
        const active=selected?document.getElementById(selected.getAttribute('aria-controls')):null;
        const strip=tabs?.getBoundingClientRect(),selectedBox=selected?.getBoundingClientRect();
        const tabRows=tabs?new Set([...tabs.querySelectorAll('[role="tab"]')].map(e=>Math.round(e.getBoundingClientRect().top))).size:0;
        const tabVisible=!tabs||selectedBox.left>=strip.left-1&&selectedBox.right<=strip.right+1;
        const header=document.querySelector('main>header'),brand=header?.querySelector('div.truncate'),badge=header?.querySelector('.layout-readonly-status');
        const mobileHeaderSeparated=!brand||!badge||getComputedStyle(brand).display==='none'||brand.getBoundingClientRect().right<=badge.getBoundingClientRect().left-4;
        const metrics=page.querySelector('.ranch-metrics');const compactMetrics=!metrics||[...metrics.querySelectorAll('.ranch-stat')].every(e=>e.getBoundingClientRect().height<=120);
        const imgs=[...page.querySelectorAll('img')];await Promise.all(imgs.filter(img=>img.loading!=='lazy').map(img=>img.decode().catch(()=>{})));
        return{label:${JSON.stringify(label)},route:location.pathname,width:innerWidth,theme:localStorage.getItem('ui_theme'),title:title.textContent,
          workspace,sidebarPaths,sidebarLabels,correctWorkspace,commonMenus,originalFarmMenus,sidebarSelectionValid,
          documentWidth:document.documentElement.scrollWidth,pageWidth:page.clientWidth,pageScrollWidth:page.scrollWidth,contrast,
          livePages:document.querySelectorAll('[data-page-content]').length,tabCount:tabs?.querySelectorAll('[role="tab"]').length||0,
          tabSelectionValid:!tabs||tabs.querySelectorAll('[aria-selected="true"]').length===1&&!!active,
          tabRows,tabVisible,mobileHeaderSeparated,compactMetrics,
          localEmptyCorrect:!!localStorage.getItem('current_account_id')||!page.hasAttribute('data-ranch-page')||page.textContent.includes('本地仅查看界面'),
          overflowText:texts,images:imgs.map(img=>({src:img.getAttribute('src'),alt:img.getAttribute('alt'),loaded:img.complete&&img.naturalWidth>0})),
          anonymous:!localStorage.getItem('admin_token')&&!localStorage.getItem('user_info')}
      })()`);
      report.samples.push(value);
      if (value.documentWidth > value.width || value.pageScrollWidth > value.pageWidth + 1 || value.overflowText.length) report.issues.push({ kind: 'overflow', ...value });
      if (value.contrast < 4.5 || value.livePages !== 1 || !value.tabSelectionValid || !value.anonymous) report.issues.push({ kind: 'theme-or-state', ...value });
      if (!value.correctWorkspace || !value.commonMenus || !value.originalFarmMenus || !value.sidebarSelectionValid || value.tabCount > 4) report.issues.push({ kind: 'workspace-navigation', ...value });
      if (!value.mobileHeaderSeparated || !value.localEmptyCorrect || !value.compactMetrics || value.width <= 820 && (!value.tabVisible || value.tabRows > 1)) report.issues.push({ kind: 'responsive-or-copy', ...value });
      return value;
    }
    const fixture = ranchVisualFixtures();
    async function seed(preserveProtection = false) {
      await evaluate(`(async()=>{
        const app=document.getElementById('app').__vue_app__,pinia=app.config.globalProperties.$pinia;
        const stores=pinia._s,account=stores.get('account'),ranch=stores.get('ranch');if(!account||!ranch)throw Error('真实Pinia store缺失');
        const fixture=${JSON.stringify(fixture)};window.__ranchVisual={stores,fixture};
        account.accounts=fixture.accounts;account.currentAccountId='fixture-ranch-A';
        for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));
        ranch.$patch({overview:fixture.overview,bagOverview:fixture.bagOverview,friendOverview:fixture.friendOverview,progressViews:fixture.progressViews,catalogs:fixture.catalogs,canCatalogs:fixture.canCatalogs,operations:[],operationsError:'',operationStates:${preserveProtection ? "ranch.operationStates" : "{'fixture-ranch-A':'idle','fixture-ranch-B':'idle'}"},notice:'内存示例 · 仅用于布局验收，未连接真实账号'});
        ranch.friends=[{gid:700000002,name:'示例牧场好友（未连接真实账号）',avatarUrl:''}];
      })()`);
    }
    async function choose(label) {
      await evaluate(`(async()=>{const button=[...document.querySelectorAll('.ranch-tabs [role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('缺少牧场专区');button.click();for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));if(button.getAttribute('aria-selected')!=='true')throw Error('专区未响应')})()`);
    }
    if (process.env.FARM_RANCH_DASHBOARD_ONLY) {
      for (const theme of ['light-green', 'dark-blue']) for (const width of [1440, 375]) {
        await open('/ranch', width, theme); await seed();
        await evaluate(`(async()=>{
          const seen=new Set();
          function find(v){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);
            if(v.component){if(v.component.type.__name==='Ranch')return v.component;const hit=find(v.component.subTree);if(hit)return hit}
            if(v.suspense){const hit=find(v.suspense.activeBranch);if(hit)return hit}
            if(Array.isArray(v.children))for(const child of v.children){const hit=find(child);if(hit)return hit}}
          const app=document.getElementById('app').__vue_app__,vm=find(app._container._vnode);
          if(!vm?.setupState||!('logSnapshot' in vm.setupState))throw Error('日志夹具仅用于开发只读构建，不注入生产钩子');
          const now=Date.now(),samples=[
            ['ranch_harvest','收获动物完成','ok'],['ranch_produce','催产完成','ok'],['ranch_clean','清理牧场完成','ok'],
            ['ranch_sell','出售牧场产物完成','ok'],['ranch_addGrass','补充牧草完成','ok'],['ranch_buy','购买鸭 ×1完成','ok'],
            ['ranch_place','普通幼崽放养完成','ok'],['ranch_friend_stroke','示例好友：抚摸完成','ok'],
            ['ranch_friend_putMosquito','示例好友：放蚊子完成','ok'],['ranch_patrol_complete','自动巡查完成：无待执行动作','idle'],
            ['ranch_patrol_paused','自动巡查已暂停：存在待核对记录，未重放','unknown'],
            ['ranch_automation','自动巡查停止：示例异常，保留原始提示','error'],
            ['ranch_fixture_future_event','较长的未知事件名称与说明也应在窄屏完整换行，不挤出卡片或遮挡右侧栏。','idle']];
          vm.setupState.logSnapshot={accountId:'fixture-ranch-A',readAt:now,entries:samples.map(([event,msg,result],i)=>({
            ts:now-i*60000,tag:'牧场',msg,isWarn:result==='unknown',meta:{module:'ranch',event,result}}))};
          for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));
          if(document.querySelectorAll('.ranch-log-list li').length!==samples.length)throw Error('真实模板未渲染日志样本');
        })()`);
        const check = await evaluate(`(()=>{
          const log=document.querySelector('.ranch-log-list'),first=log.querySelector('li'),badge=first.querySelector('time+span'),
            body=document.querySelector('[data-ranch-dashboard-body]'),side=body.querySelector('aside'),tiles=[...side.querySelectorAll('.ranch-stat-tile')];
          const l=log.getBoundingClientRect(),s=side.getBoundingClientRect(),style=getComputedStyle(log),line=getComputedStyle(first);
          return {width:innerWidth,theme:localStorage.getItem('ui_theme'),rows:log.querySelectorAll('li').length,
            font:style.fontFamily,lineHeight:style.lineHeight,rowMargin:line.marginBottom,rowPadding:line.paddingTop,
            module:badge.textContent,event:first.querySelector('time+span+span').textContent,time:first.querySelector('time').textContent,
            tileCount:tiles.length,tileColumns:getComputedStyle(tiles[0].parentElement).gridTemplateColumns,
            pageOverflow:document.documentElement.scrollWidth>innerWidth,logOverflow:log.scrollWidth>log.clientWidth+1,
            sideBySide:s.left>l.right,stacked:s.top>=l.bottom,heading:side.querySelector('h2').textContent}
        })()`);
        assert.equal(check.rows, 13); assert.equal(check.module, '牧场'); assert.equal(check.event, '收获');
        assert.match(check.time, /^\[\d{2}:\d{2}:\d{2}\]$/); assert.match(check.font, /mono/i);
        assert.equal(check.rowPadding, '0px'); assert.equal(check.tileCount, 5);
        assert.equal(check.pageOverflow, false, JSON.stringify(check)); assert.equal(check.logOverflow, false, JSON.stringify(check));
        assert.ok(width === 1440 ? check.sideBySide : check.stacked, JSON.stringify(check));
        report.samples.push(check);
        if (width === 375) await evaluate(`document.querySelector('[aria-label="运行日志"]').scrollIntoView({block:'start'})`);
        await capture(`ranch-dashboard-${theme}-${width}`);
        if (width === 375) { await evaluate(`document.querySelector('[aria-label="牧场检查与统计"]').scrollIntoView({block:'start'})`); await capture(`ranch-dashboard-sidebar-${theme}-${width}`); }
      }
      for (const theme of ['light-green', 'dark-blue']) for (const width of [1440, 375]) {
        await open('/ranch/friends', width, theme); await seed();
        const friendCheck = await evaluate(`(async()=>{
          const frame=()=>new Promise(r=>requestAnimationFrame(r));
          const {stores,fixture}=window.__ranchVisual,ranch=stores.get('ranch');
          ranch.friends=[{gid:700000002,name:'牧场好友甲',avatarUrl:''},{gid:700000003,name:'很长的好友昵称也会完整显示而不是被藏进下拉菜单里',avatarUrl:''},{gid:700000004,name:'Beta牧场好友',avatarUrl:''}];
          ranch.friendsError='示例读取失败，只应进入日志，不应出现警告条';
          await frame();await frame();
          if(document.querySelectorAll('.ranch-friend-row').length!==3||document.querySelector('[data-ranch-page] select'))throw Error('好友没有直接列出');
          const search=document.querySelector('input[aria-label="搜索牧场好友"]');
          search.value='Beta';search.dispatchEvent(new Event('input',{bubbles:true}));await frame();
          if(document.querySelectorAll('.ranch-friend-row').length!==1)throw Error('本地搜索未筛选');
          search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));await frame();
          document.querySelector('.ranch-friend-row').click();await frame();await frame();
          ranch.friendOverview=fixture.friendOverview;await frame();await frame();
          const row=document.querySelector('.ranch-friend-row[aria-expanded="true"]'),details=document.getElementById(row?.getAttribute('aria-controls'));
          if(!details||!details.textContent.includes('动物'))throw Error('好友详情未原位展开');
          const hasBanner=!!document.querySelector('[data-ranch-page] .ranch-error,[data-ranch-page] .ranch-notice,[data-ranch-page] [role="alert"]');
          const root=document.querySelector('[data-ranch-page]');
          return{page:'friends',width:innerWidth,theme:localStorage.getItem('ui_theme'),rows:document.querySelectorAll('.ranch-friend-row').length,
            hasBanner,pageOverflow:document.documentElement.scrollWidth>innerWidth,pageWidth:root.clientWidth,scrollWidth:root.scrollWidth,inlineDetail:details.parentElement.tagName==='LI'}
        })()`);
        assert.equal(friendCheck.rows,3);assert.equal(friendCheck.hasBanner,false);assert.equal(friendCheck.pageOverflow,false,JSON.stringify(friendCheck));
        assert.ok(friendCheck.inlineDetail);assert.ok(friendCheck.scrollWidth<=friendCheck.pageWidth+1,JSON.stringify(friendCheck));
        report.samples.push(friendCheck);
        if(width===375)await evaluate(`document.querySelector('[aria-label="牧场好友列表"]').scrollIntoView({block:'start'})`);
        await capture(`ranch-friends-list-${theme}-${width}`);
        await evaluate(`document.querySelector('.ranch-friend-row[aria-expanded="true"]').click()`);
        assert.equal(await evaluate(`document.querySelectorAll('.ranch-friend-row[aria-expanded="true"]').length`),0);
      }
      await Promise.all([...pending]);
      const forbidden=report.requests.filter(r=>!['GET','HEAD'].includes(r.method)||/^https?:/.test(r.url)&&(new URL(r.url).origin!==origin||/^\/(?:api(?:\/|$)|socket\.io(?:\/|$))/.test(new URL(r.url).pathname)));
      assert.equal(forbidden.length,0);assert.equal(report.sockets.length,0);assert.equal(report.serverDenied.length,0);assert.equal(report.errors.length,0,JSON.stringify(report.errors));
      report.ok=true;console.log('RANCH_DASHBOARD_VISUAL_VERIFIED',JSON.stringify({samples:report.samples.length,screenshots:report.screenshots.length,apiRequests:0,websockets:0,networkWrites:0}));
      return;
    }
    const businessPages = ['/', '/personal', '/friends', '/activity', '/shop', '/illustrated', '/settings',
      '/ranch', '/ranch/personal', '/ranch/friends', '/ranch/activity', '/ranch/shop', '/ranch/illustrated', '/ranch/settings'];
    const ranchScenes = [
      ['/ranch', '', 'overview'], ['/ranch/personal?section=home', '', 'personal'], ['/ranch/personal?section=bag', '', 'bag'],
      ['/ranch/personal?section=tasks', '', 'tasks'], ['/ranch/personal?section=share', '', 'share'], ['/ranch/friends', '', 'friends'],
      ['/ranch/activity', '', 'activity'], ['/ranch/illustrated', '', 'illustrated'],
      ['/ranch/shop?section=catalog', '', 'catalog'], ['/ranch/shop?section=cans', '', 'cans'], ['/ranch/shop?section=market', '', 'market'],
    ];
    for (const theme of ['light-green', 'dark-blue']) for (const width of [375, 768, 1440]) {
      for (const route of businessPages) {
        await open(route, width, theme); await sample('anonymous-' + route);
        if (width === 1440 && theme === 'light-green' && ['/', '/personal', '/ranch'].includes(route))
          await capture(route === '/' ? 'farm-overview-light-1440' : route === '/personal' ? 'farm-personal-light-1440' : 'ranch-anonymous-light-1440');
      }
      for (const [route, label, key] of ranchScenes) {
        await open(route, width, theme); await seed(); if (label) await choose(label);
        await sample('fixture-' + key);
        if (key === 'overview') {
          const layout = await evaluate(`(()=>{
            const body=document.querySelector('[data-ranch-dashboard-body]'), log=body?.querySelector('[aria-label="运行日志"]'), side=body?.querySelector('aside');
            if(!log||!side)return null;
            const l=log.getBoundingClientRect(),s=side.getBoundingClientRect(), cards=[...document.querySelectorAll('[data-ranch-page="overview"] .metric-card')];
            return { cards:cards.length, cardRows:new Set(cards.map(card=>Math.round(card.getBoundingClientRect().top))).size,
              aligned:Math.abs(l.top-s.top)<2, sideBySide:s.left>l.left+l.width-2, widthRatio:l.width/s.width, stacked:s.top>=l.bottom,
              hasStats:side.textContent.includes('今日统计'), hasInterval:side.textContent.includes('检查间隔') };
          })()`);
          assert.ok(layout, '牧场概览必须具有日志和右侧栏');
          assert.equal(layout.cards, 3);
          assert.ok(layout.hasStats && layout.hasInterval);
          if (width === 1440) assert.ok(layout.aligned && layout.sideBySide && layout.cardRows === 1 && layout.widthRatio > 2.5 && layout.widthRatio < 3.5, JSON.stringify(layout));
          if (width === 375) assert.ok(layout.stacked && layout.cardRows === 3, JSON.stringify(layout));
        }
        if (width === 1440 || width === 375 && theme === 'light-green') {
          await capture(`ranch-${key}-${theme === 'light-green' ? 'light' : 'dark'}-${width}`);
          if (key === 'personal') {
            await evaluate(`document.querySelector('.ranch-animal')?.scrollIntoView({block:'center'})`);
            await capture(`ranch-animals-${theme === 'light-green' ? 'light' : 'dark'}-${width}`);
          }
        }
      }
    }
    await open('/ranch/illustrated', 1440, 'light-green'); await seed();
    report.giantBook = await evaluate(`(async()=>{
      const frame=()=>new Promise(r=>requestAnimationFrame(r));
      const button=[...document.querySelectorAll('.ranch-progress button')].find(e=>e.textContent.includes('巨大动物'))
        ||[...document.querySelectorAll('button')].find(e=>e.textContent.includes('巨大动物'));
      if(!button)throw Error('缺少巨大图鉴筛选');button.click();await frame();await frame();
      const text=document.querySelector('.ranch-progress')?.textContent||document.querySelector('[data-page-content]').textContent;
      if(!text.includes('巨大')||!text.includes('未确认'))throw Error('巨大图鉴缺图或分类说明缺失');
      return{independentFilter:true,missingImageExplicit:true}
    })()`);
    await evaluate(`document.querySelectorAll('.ranch-progress button').forEach(e=>{if(e.textContent.includes('巨大动物'))e.scrollIntoView({block:'start'})})`);
    await capture('ranch-giant-book-light-1440');
    for (const route of ['/farm', '/farm/status', '/overview', '/ranch/overview']) { await open(route, 1440, 'light-green'); await sample('compatibility-' + route); }
    await open('/ranch/personal?section=home', 375, 'light-green'); await seed();
    await evaluate(`document.querySelector('.ranch-tabs [role="tab"]').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    assert.equal(await evaluate(`document.activeElement.textContent.trim()`), '每日分享');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    report.keyboard = await sample('fixture-keyboard-last-tab');
    assert.equal(await evaluate(`document.querySelector('.ranch-tabs [aria-selected="true"]').textContent.trim()`), '每日分享');
    await choose('我的牧场');
    report.protection = await evaluate(`(async()=>{
      const app=document.getElementById('app').__vue_app__,router=app.config.globalProperties.$router;
      const v=window.__ranchVisual,a=v.stores.get('account'),r=v.stores.get('ranch');
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      const navigate=async path=>{await router.push(path);for(let i=0;i<8;i++)await frame()};
      r.operationStates={'fixture-ranch-A':'pending','fixture-ranch-B':'idle'};await frame();await frame();
      await navigate('/ranch/shop');await navigate('/ranch/personal?section=home');
      if(r.currentState!=='pending')throw Error('独立子页切换清除在途提示');
      r.operationStates={'fixture-ranch-A':'unknown','fixture-ranch-B':'idle'};await frame();await frame();
      await navigate('/personal');
      if(r.operationStates['fixture-ranch-A']!=='unknown')throw Error('返回农场解除牧场未知保护');
      await navigate('/ranch/personal?section=home');
      a.currentAccountId='fixture-ranch-B';await frame();await frame();if(r.currentState!=='idle')throw Error('甲号未知污染乙号');
      a.currentAccountId='fixture-ranch-A';await frame();await frame();if(r.currentState!=='unknown')throw Error('A-B-A丢失未知保护');
      r.$patch({overview:v.fixture.overview,progressViews:v.fixture.progressViews});await frame();await frame();
      const controls=[...document.querySelectorAll('.ranch-content button')].filter(e=>/催产|出售全部|喂养|放生/.test(e.textContent));
      if(!controls.length||controls.some(e=>!e.disabled))throw Error('未知状态允许重复写按钮');
      if(!document.body.textContent.includes('本账号牧场结果或离场状态未确认'))throw Error('未知告警缺失');
      return{pendingIndicatorSurvivesPage:true,unknownSurvivesPageAndAccount:true,accountIsolation:true,writeButtonsDisabled:controls.length}
    })()`);
    await sample('fixture-unknown'); await capture('ranch-unknown-light-375');
    await open('/personal', 1440, 'light-green');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    report.motion = await evaluate(`(async()=>{
      const frame=()=>new Promise(r=>requestAnimationFrame(r));await frame();await frame();
      document.querySelector('.sidebar-nav-link[data-nav-path="/friends"]').click();
      for(let i=0;i<100&&!document.getAnimations().some(a=>a.animationName==='content-snapshot-out');i++)await frame();
      const animations=document.getAnimations().filter(a=>['content-snapshot-in','content-snapshot-out'].includes(a.animationName));
      if(animations.length!==2||document.querySelector('.workspace-travel-mask'))throw Error('同工作区切页未保留原快照动画');
      const frames=animations.map(a=>({name:a.animationName,frames:a.effect.getKeyframes().map(k=>({transform:k.transform,opacity:k.opacity}))}));
      await Promise.all(animations.map(a=>a.finished.catch(()=>{})));for(let i=0;i<8&&document.documentElement.dataset.contentMotion;i++)await frame();
      if(document.querySelectorAll('[data-page-content]').length!==1||document.documentElement.dataset.contentMotion)throw Error('动画结束后仍保活或卡住');
      return{nativeSnapshots:2,onlyOnePage:true,finalRoute:location.pathname,frames}
    })()`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    report.reducedMotion = await evaluate(`(async()=>{document.querySelector('[data-workspace-switch]').click();for(let i=0;i<60&&(!document.querySelector('[data-ranch-page="friends"]')||document.querySelector('.workspace-travel-mask'));i++)await new Promise(r=>requestAnimationFrame(r));if(document.documentElement.dataset.contentMotion||document.querySelector('.workspace-travel-mask')||document.getAnimations().some(a=>a.animationName?.startsWith('workspace-journey')||['content-snapshot-in','content-snapshot-out'].includes(a.animationName)))throw Error('减动效仍推页或锁住界面');if(!document.querySelector('[data-ranch-page="friends"]'))throw Error('减动效未切换完整工作区');return{routeChanged:true,animations:0}})()`);
    await open('/', 1440, 'light-green');
    report.navigationGuard = await evaluate(`(async()=>{
      const router=document.getElementById('app').__vue_app__.config.globalProperties.$router;
      const remove=router.beforeEach(to=>to.path==='/ranch'?new Promise(resolve=>{window.__releaseJourneyGuard=resolve}):true);
      document.querySelector('[data-workspace-switch]').click();for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));
      if(typeof window.__releaseJourneyGuard!=='function'||document.querySelector('.workspace-travel-mask')||document.querySelector('[data-game-workspace]').inert)throw Error('导航确认未通过就被加载层遮挡');
      window.__releaseJourneyGuard(false);remove();for(let i=0;i<8;i++)await new Promise(r=>requestAnimationFrame(r));
      if(location.pathname!=='/'||document.querySelector('.workspace-travel-mask'))throw Error('取消导航仍切换工作区');return{guardBeforeJourney:true,cancelKeepsWorkspace:true}
    })()`);
    report.journeys = [];
    async function captureJourney(destination, width = 1440, count = 14) {
      await open(destination === 'ranch' ? '/' : '/ranch', width, 'light-green');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      const info = await evaluate(`(async()=>{
        const frame=()=>new Promise(r=>requestAnimationFrame(r));document.querySelector('[data-workspace-switch]').click();
        let mask,animations,main;for(let i=0;i<90;i++){mask=document.querySelector('.workspace-travel-mask');animations=mask?.querySelector('svg')?.getAnimations({subtree:true})||[];main=animations.find(a=>a.animationName?.startsWith('workspace-journey-move'));if(main)break;await frame()}
        if(!main||mask.dataset.travelDestination!==${JSON.stringify(destination)})throw Error('真实切换插画未启动');
        for(const a of animations){a.pause();a.currentTime=0}window.__journeyFrames={animations,main};
        for(let i=0;i<12;i++)await frame();const card=mask.querySelector('.workspace-travel-card'),box=card.getBoundingClientRect();
        if(!document.querySelector('[data-game-workspace]').inert||getComputedStyle(mask).opacity<.98)throw Error('加载背景未隔离或插画未完整显示');
        return{destination:${JSON.stringify(destination)},width:innerWidth,duration:Number(main.effect.getComputedTiming().duration),animations:animations.length,route:location.pathname,
          clip:{x:Math.floor(box.left),y:Math.floor(box.top),width:Math.ceil(box.width),height:Math.ceil(box.height),scale:1},backgroundInert:true,caption:card.textContent.trim()}
      })()`);
      info.frames = [];
      for (let index = 0; index < count; index++) {
        const time = info.duration * index / count;
        await evaluate(`(async()=>{for(const a of window.__journeyFrames.animations)a.currentTime=${time};await new Promise(r=>requestAnimationFrame(r));await new Promise(r=>requestAnimationFrame(r))})()`);
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: info.clip });
        const name = `travel-${destination}-${width}-frame-${String(index).padStart(2, '0')}.png`;
        fs.writeFileSync(path.join(directory, name), Buffer.from(data, 'base64')); info.frames.push(name);
      }
      await evaluate(`(async()=>{for(const a of window.__journeyFrames.animations)a.play();window.__journeyFrames.main.currentTime=${info.duration - 1};for(let i=0;i<90&&document.querySelector('.workspace-travel-mask');i++)await new Promise(r=>requestAnimationFrame(r));if(document.querySelector('.workspace-travel-mask')||document.querySelector('[data-game-workspace]').inert)throw Error('插画结束未释放界面')})()`);
      report.journeys.push(info);
    }
    await captureJourney('ranch'); await captureJourney('farm'); await captureJourney('ranch', 375, 3);
    await open('/', 1440, 'light-green');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    report.travelIdleTiming = await evaluate(`(async()=>{
      const frame=()=>new Promise(r=>requestAnimationFrame(r));const samples=[];let previous=await frame();
      for(let i=0;i<30;i++){const now=await frame();samples.push(now-previous);previous=now}
      const sorted=samples.filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
      if(sorted.length<10)throw Error('空闲基线有效帧样本不足');
      return {frames:sorted.length,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.floor(sorted.length*.95)],longFrames:sorted.filter(n=>n>50).length}
    })()`);
    report.travelFrameTiming = await evaluate(`(async()=>{
      const frame=()=>new Promise(r=>requestAnimationFrame(r));document.querySelector('[data-workspace-switch]').click();
      for(let i=0;i<90&&!document.querySelector('.workspace-journey');i++)await frame();
      const frames=[];let previous=await frame();
      for(let i=0;i<180&&document.querySelector('.workspace-travel-mask');i++) {const now=await frame();frames.push(now-previous);previous=now}
      if(document.querySelector('.workspace-travel-mask'))throw Error('工作区动画未在预算内结束');
      const sorted=frames.filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
      if(sorted.length<10)throw Error('工作区动画有效帧样本不足');
      return {frames:frames.length,medianMs:sorted[Math.floor(sorted.length/2)]||0,p95Ms:sorted[Math.floor(sorted.length*.95)]||0,longFrames:frames.filter(n=>n>50).length}
    })()`);
    await open('/', 1440, 'light-green');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    report.travelAnimationCancel = await evaluate(`(async()=>{
      const frame=()=>new Promise(r=>requestAnimationFrame(r));document.querySelector('[data-workspace-switch]').click();let main;
      for(let i=0;i<90;i++){main=document.querySelector('.workspace-journey')?.getAnimations().find(a=>a.animationName?.startsWith('workspace-journey-move'));if(main)break;await frame()}
      if(!main)throw Error('取消测试未捕获主动画');main.cancel();
      for(let i=0;i<90&&document.querySelector('.workspace-travel-mask');i++)await frame();
      if(document.querySelector('.workspace-travel-mask')||document.querySelector('[data-game-workspace]').inert)throw Error('动画取消后界面仍锁住');
      return {released:true}
    })()`);
    await Promise.all([...pending]);
    report.apiRequests = report.requests.filter(r => /^https?:/.test(r.url) && /^\/(?:api(?:\/|$)|socket\.io(?:\/|$))/.test(new URL(r.url).pathname));
    report.externalRequests = report.requests.filter(r => /^https?:/.test(r.url) && new URL(r.url).origin !== origin);
    report.networkWrites = report.requests.filter(r => !['GET', 'HEAD'].includes(r.method));
    assert.equal(report.apiRequests.length, 0); assert.equal(report.externalRequests.length, 0); assert.equal(report.sockets.length, 0);
    assert.equal(report.serverDenied.length, 0); assert.equal(report.networkWrites.length, 0); assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(report.issues.length, 0, JSON.stringify(report.issues.map(i => ({ kind: i.kind, label: i.label, theme: i.theme, width: i.width, overflowText: i.overflowText }))));
    report.ok = true;
    console.log('RANCH_VISUAL_VERIFIED', JSON.stringify({ samples: report.samples.length, screenshots: report.screenshots.length, apiRequests: 0, websockets: 0, networkWrites: 0, issues: 0 }));
  } catch (error) {
    report.failure = error.message;
    if (send) try { const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(directory, 'failure.png'), Buffer.from(data, 'base64')); } catch {}
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    report.previewClosed = !server.listening;
    fs.writeFileSync(path.join(directory, 'ranch-visual-verification.json'), JSON.stringify(report, null, 2) + '\n');
  }
});

test('Edge 本地只读切页帧诊断：实际指针输入、捕获延迟与帧节奏', {
  skip: !process.env.FARM_LOCAL_MOTION_TRACE,
}, async () => {
  const directory = path.resolve(process.env.FARM_LOCAL_MOTION_TRACE);
  const browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory, true);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
      window.__motionTrace = { records: [], presses: [], longTasks: [] }
      document.addEventListener('pointerdown', event => window.__motionTrace.presses.push({ at: performance.now(), text: event.target.closest('a,button')?.textContent.trim() }), true)
      try { new PerformanceObserver(list => window.__motionTrace.longTasks.push(...list.getEntries().map(item => ({ start: item.startTime, duration: item.duration })))).observe({ type: 'longtask', buffered: true }) } catch {}
      const start = document.startViewTransition.bind(document)
      document.startViewTransition = callback => {
        const item = { kind: document.documentElement.dataset.contentMotion, direction: document.documentElement.dataset.contentDirection, start: performance.now(), frames: [], skipped: false }
        window.__motionTrace.records.push(item)
        const transition = start(async () => { item.updateStart = performance.now(); await callback(); item.updateEnd = performance.now() })
        const skip = transition.skipTransition.bind(transition)
        transition.skipTransition = () => { item.skipped = true; item.skipAt = performance.now(); skip() }
        transition.ready.then(() => {
          item.ready = performance.now()
          const outgoing = document.getAnimations().find(animation => animation.animationName === 'content-snapshot-out')
          const tick = now => {
            if (item.finished) return
            const style = getComputedStyle(document.documentElement, '::view-transition-old(farm-content)')
            item.frames.push({ at: now, timeline: outgoing?.currentTime, transform: style.transform })
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }, error => { item.captureError = String(error) })
        transition.finished.then(() => { item.finished = performance.now() }, error => { item.finished = performance.now(); item.error = String(error) })
        return transition
      }
    ` });
    const load = new Promise(resolve => { const listener = event => { if (event.sessionId === sessionId) { browser.events.off('Page.loadEventFired', listener); resolve(); } }; browser.events.on('Page.loadEventFired', listener); });
    await send('Page.navigate', { url: 'http://127.0.0.1:4177/' }); await load;
    const click = async (selector, waitMs = 750) => {
      const point = await evaluate(`(async () => { for(let i=0;i<100&&!document.querySelector(${JSON.stringify(selector)});i++)await new Promise(resolve=>requestAnimationFrame(resolve));const element = document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing real trace control: '+${JSON.stringify(selector)}); const r = element.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2 } })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await evaluate(`new Promise(resolve=>{const end=performance.now()+${waitMs};const tick=()=>performance.now()>=end?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick)})`);
    };
    await click('a[href="/activity"]');
    await click('.activity-tabs button:nth-child(2)'); await click('.activity-tabs button:nth-child(1)');
    await click('a[href="/mutation-catalog"]');
    await click('.mutation-tabs button:nth-child(2)'); await click('.mutation-tabs button:nth-child(3)');
    await click('.mutation-tabs button:nth-child(1)', 110); await click('.mutation-tabs button:nth-child(2)', 110); await click('.mutation-tabs button:nth-child(3)');
    const result = await evaluate('window.__motionTrace');
    const summaries = result.records.map(item => {
      const gaps = item.frames.slice(1).map((frame, index) => frame.at - item.frames[index].at);
      const press = [...result.presses].reverse().find(press => press.at <= item.start);
      return { kind: item.kind, direction: item.direction, skipped: item.skipped,
        pressToStartMs: press ? Math.round(item.start - press.at) : null,
        captureToReadyMs: item.ready ? Math.round(item.ready - item.start) : null,
        frames: item.frames.length, maxFrameGapMs: Math.round(Math.max(0, ...gaps)),
        gapsOver34Ms: gaps.filter(gap => gap > 34).length };
    });
    fs.writeFileSync(path.join(directory, process.env.FARM_MOTION_TRACE_FILE || 'motion-frame-diagnostic.json'), JSON.stringify({ ...result, summaries, environment: 'Headless existing Edge, GPU not disabled, real time; not a user-display FPS claim' }, null, 2) + '\n');
    console.log('MOTION_FRAME_DIAGNOSTIC', JSON.stringify({ summaries, longTasks: result.longTasks }));
  } finally { await browser.close(); }
});

test('Edge 本地侧栏顺滑验收：真实按压、即时选中、连续续接与键盘减动效', {
  skip: !process.env.FARM_LOCAL_SIDEBAR_VERIFY,
}, async () => {
  const directory = path.resolve(process.env.FARM_LOCAL_SIDEBAR_VERIFY);
  const browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory, true);
  const requests = [], sockets = [], errors = [], report = { sceneChecks: [], screenshots: [] };
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    browser.events.on('Network.requestWillBeSent', event => { if (event.sessionId === sessionId) requests.push(event.params.request); });
    browser.events.on('Network.webSocketCreated', event => { if (event.sessionId === sessionId) sockets.push(event.params.url); });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) errors.push(event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
      window.__sidebarAudit = { captures: [], commits: [] }
      const start = document.startViewTransition.bind(document)
      document.startViewTransition = callback => {
        const item = { kind: document.documentElement.dataset.contentMotion, at: performance.now() }
        window.__sidebarAudit.captures.push(item)
        const transition = start(async () => { await callback(); item.path = location.pathname; window.__sidebarAudit.commits.push(item.path) })
        transition.finished.then(() => { item.finished = true }, () => { item.finished = true })
        return transition
      }
    ` });
    await send('Page.navigate', { url: 'http://127.0.0.1:4177/' });
    await evaluate(String.raw`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
      for (let i = 0; i < 100 && !document.querySelector('.sidebar-nav-indicator[data-ready="true"]'); i++) await frame()
      if (!document.querySelector('.sidebar-nav-indicator[data-ready="true"]')) throw new Error('Sidebar selection did not mount')
      for (let i = 0; i < 100 && document.documentElement.dataset.contentMotion; i++) await frame()
      window.__sidebarFrames = frame
      window.__sidebarWait = async test => { for(let i=0;i<160;i++){if(test())return;await frame()}throw new Error('Sidebar condition did not settle') }
      window.__sidebarIdle = () => window.__sidebarWait(() => !document.documentElement.dataset.contentMotion)
    })()`);
    const key = destination => `.sidebar-nav-link[data-nav-path=${JSON.stringify(destination)}]`;
    const point = async destination => evaluate(`(() => { const element=document.querySelector(${JSON.stringify(key(destination))});element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2} })()`);
    const click = async destination => {
      const position = await point(destination);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    };
    const position = await point('/personal');
    const before = await evaluate(`document.querySelector(${JSON.stringify(key('/personal'))}).getBoundingClientRect().toJSON()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await evaluate(String.raw`(async()=>{for(let i=0;i<22;i++)await window.__sidebarFrames()})()`);
    const hover = await evaluate(`(() => { const link=document.querySelector(${JSON.stringify(key('/personal'))});return{row:link.getBoundingClientRect().toJSON(),transform:getComputedStyle(link.querySelector('.sidebar-nav-content')).transform,opacity:getComputedStyle(link,'::before').opacity} })()`);
    assert.equal(hover.row.y, before.y); assert.equal(hover.row.height, before.height);
    assert.ok(Number(hover.opacity) > .95, 'hover should softly reach its highlight'); assert.notEqual(hover.transform, 'none');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await evaluate(String.raw`(async()=>{for(let i=0;i<8;i++)await window.__sidebarFrames()})()`);
    const press = await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(key('/personal'))}).querySelector('.sidebar-nav-content')).transform`);
    assert.ok(Number(press.match(/matrix\(([^)]+)\)/)[1].split(',')[0]) < .995, 'press feedback did not compress softly');
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
    await evaluate(String.raw`(async()=>{await window.__sidebarWait(()=>location.pathname==='/personal');await window.__sidebarIdle()})()`);
    report.sceneChecks.push({ scene: 'actual-pointer-hover-press', stableHitArea: true, hover, press });
    report.selectionTravel = await evaluate(String.raw`(async () => {
      const indicator = document.querySelector('.sidebar-nav-indicator'), list = document.querySelector('.sidebar-nav-list')
      const link = path => [...document.querySelectorAll('[data-nav-path]')].find(item => item.dataset.navPath === path)
      const readY = () => new DOMMatrix(getComputedStyle(indicator).transform).m42
      await window.__sidebarWait(() => Math.abs(readY() - link('/personal').offsetTop) < .2)
      const previous = readY(), points = [], header = document.querySelector('header').getBoundingClientRect().toJSON()
      link('/settings').click()
      if (link('/settings').dataset.selected !== 'true' && document.querySelector('.sidebar-nav-link[data-selected="true"]').dataset.navPath !== '/settings') await window.__sidebarFrames()
      if (link('/settings').dataset.selected !== 'true') throw new Error('Selection did not respond before route commit')
      for(let i=0;i<6;i++){await window.__sidebarFrames();points.push(readY())}
      if(!points.some(y=>y>previous&&y<link('/settings').offsetTop))throw new Error('Selection surface jumped rather than moved')
      await window.__sidebarWait(()=>location.pathname==='/settings');await window.__sidebarIdle()
      await window.__sidebarWait(()=>Math.abs(readY()-link('/settings').offsetTop)<.2)
      const afterHeader=document.querySelector('header').getBoundingClientRect().toJSON()
      if(header.x!==afterHeader.x||header.y!==afterHeader.y)throw new Error('Sidebar feedback moved the header')
      if(document.querySelectorAll('.sidebar-nav-indicator').length!==1||document.querySelectorAll('[data-page-content]').length!==1)throw new Error('Multiple selection surfaces or pages')
      return{immediateSelection:true,previous,points,destination:readY(),height:indicator.offsetHeight,onlyOneSurface:true,headerStable:true}
    })()`);
    report.reversal = await evaluate(String.raw`(async()=>{
      const link=path=>[...document.querySelectorAll('[data-nav-path]')].find(item=>item.dataset.navPath===path)
      const captures=window.__sidebarAudit.captures.length
      link('/personal').click()
      await window.__sidebarWait(()=>location.pathname==='/personal'&&document.getAnimations().some(item=>item.animationName==='content-snapshot-out'&&Number(item.currentTime)>65))
      const out=document.getAnimations().find(item=>item.animationName==='content-snapshot-out'), root=document.documentElement
      out.pause();const incoming=document.getAnimations().find(item=>item.animationName==='content-snapshot-in');incoming.pause()
      const pixels=getComputedStyle(root,'::view-transition-old(farm-content)').transform
      const indicator=document.querySelector('.sidebar-nav-indicator'), selectionPixels=indicator.style.transform
      link('/settings').click()
      if(indicator.style.transform!==selectionPixels)throw new Error('Selection retarget snapped before next frame')
      await window.__sidebarWait(()=>out.effect.getTiming().duration===260&&location.pathname==='/settings')
      if(window.__sidebarAudit.captures.length-captures!==1)throw new Error('Reverse recaptured instead of reused pixels')
      const start=out.effect.getKeyframes()[0].transform
      if(start!==pixels||out.playbackRate!==1)throw new Error('Reverse did not begin at current pixels with forward damping')
      await out.finished.catch(()=>{});await window.__sidebarIdle()
      return{captures:1,pixelDifference:0,forwardDamping:true,duration:260,selectionRetargetContinuous:true,finalRoute:location.pathname}
    })()`);
    report.thirdDestination = await evaluate(String.raw`(async()=>{
      const link=path=>[...document.querySelectorAll('[data-nav-path]')].find(item=>item.dataset.navPath===path)
      const baseline=window.__sidebarAudit.commits.length
      link('/personal').click()
      await window.__sidebarWait(()=>location.pathname==='/personal'&&document.getAnimations().some(item=>item.animationName==='content-snapshot-out'&&Number(item.currentTime)>65))
      const out=document.getAnimations().find(item=>item.animationName==='content-snapshot-out')
      link('/friends').click();await window.__sidebarFrames()
      link('/shop').click();await window.__sidebarFrames()
      if(document.querySelector('.sidebar-nav-link[data-selected="true"]').dataset.navPath!=='/shop')throw new Error('Latest click lost immediate selection')
      await window.__sidebarWait(()=>out.effect.getTiming().duration===110)
      await window.__sidebarWait(()=>location.pathname==='/shop');await window.__sidebarIdle()
      const commits=window.__sidebarAudit.commits.slice(baseline)
      if(commits.includes('/friends'))throw new Error('Stale intermediate page was mounted')
      if(document.querySelectorAll('[data-page-content]').length!==1)throw new Error('Continuous clicks kept multiple pages')
      return{bridgeMs:110,commits,staleDestinationDropped:true,finalRoute:location.pathname}
    })()`);
    await evaluate(`document.querySelector(${JSON.stringify(key('/settings'))}).focus({preventScroll:true})`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    report.keyboard = await evaluate(String.raw`(async()=>{await window.__sidebarWait(()=>location.pathname==='/settings');await window.__sidebarIdle();const link=document.querySelector('[data-nav-path="/settings"]');return{routeChanged:true,activeAnchor:link.getAttribute('aria-current'),focusVisible:link.matches(':focus-visible'),outline:getComputedStyle(link).outlineStyle}})()`);
    assert.equal(report.keyboard.activeAnchor, 'page'); assert.equal(report.keyboard.focusVisible, true); assert.equal(report.keyboard.outline, 'solid');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 150 });
    for (const theme of ['light-green', 'dark-purple']) {
      await evaluate(`(() => {const app=document.querySelector('#app').__vue_app__;const store=app.config.globalProperties.$pinia._s.get('app');store.applyTheme(${JSON.stringify(theme)});document.activeElement?.blur()})()`);
      await evaluate(String.raw`(async()=>{for(let i=0;i<35;i++)await window.__sidebarFrames()})()`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(directory, `sidebar-motion-${theme}-1440.png`); fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64')); report.screenshots.push(file);
      const colors = await evaluate(String.raw`(()=>{const row=document.querySelector('[data-nav-path="/settings"]');return{label:getComputedStyle(row).color,background:getComputedStyle(document.querySelector('.sidebar-nav-indicator')).backgroundImage,theme:getComputedStyle(document.documentElement).getPropertyValue('--theme-bg')}})()`);
      report.sceneChecks.push({ scene: theme, colors });
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(String.raw`(async()=>{for(let i=0;i<6;i++)await window.__sidebarFrames();document.querySelector('[aria-label="打开导航"]').click();for(let i=0;i<24;i++)await window.__sidebarFrames()})()`);
    await click('/activity');
    report.mobile = await evaluate(String.raw`(async()=>{await window.__sidebarWait(()=>location.pathname==='/activity');await window.__sidebarIdle();await window.__sidebarWait(()=>document.querySelector('aside').getBoundingClientRect().right<1);if(document.documentElement.scrollWidth>375)throw new Error('Mobile navigation overflowed');return{width:375,realNavigationClicked:true,closedAfterCommit:true,noHorizontalOverflow:true}})()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    report.reduced = await evaluate(String.raw`(async()=>{for(let i=0;i<5;i++)await window.__sidebarFrames();const captures=window.__sidebarAudit.captures.length;document.querySelector('[data-nav-path="/"]').click();await window.__sidebarWait(()=>location.pathname==='/');await window.__sidebarFrames();const indicator=document.querySelector('.sidebar-nav-indicator');if(window.__sidebarAudit.captures.length!==captures||Math.abs(new DOMMatrix(getComputedStyle(indicator).transform).m42)>0.1)throw new Error('Reduced motion still animated navigation');return{noSnapshot:true,selectionImmediate:true,routeChanged:true}})()`);
    report.apiRequests = requests.filter(item => /\/api\/|\/socket\.io/.test(item.url)); report.networkWrites = requests.filter(item => !['GET', 'HEAD'].includes(item.method));
    report.websocketConnections = sockets; report.errors = errors;
    report.noAccount = await evaluate("!localStorage.getItem('admin_token')&&!localStorage.getItem('current_account_id')&&!localStorage.getItem('user_info')");
    assert.equal(report.apiRequests.length, 0); assert.equal(report.networkWrites.length, 0); assert.equal(sockets.length, 0); assert.equal(errors.length, 0); assert.equal(report.noAccount, true);
    fs.writeFileSync(path.join(directory, 'sidebar-motion-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('SIDEBAR_MOTION_VERIFIED', JSON.stringify({ actualPointer: true, selection: report.selectionTravel, reversal: report.reversal, thirdDestination: report.thirdDestination, keyboard: report.keyboard, mobile: report.mobile, reduced: report.reduced, apiRequests: 0, websocketConnections: 0, noAccount: true }));
  } finally { await browser.close(); }
});

test('Edge 本地只读正式构建：真实页面可直入、方向滑动且账号网络均为空', {
  skip: !process.env.FARM_LOCAL_UI_VERIFY,
}, async () => {
  const directory = path.resolve(process.env.FARM_LOCAL_UI_VERIFY);
  const browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory);
  const requests = [], errors = [];
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
      return result.result.value;
    };
    browser.events.on('Network.requestWillBeSent', event => { if (event.sessionId === sessionId) requests.push({ url: event.params.request.url, method: event.params.request.method }); });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) errors.push(event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "if(location.origin==='http://127.0.0.1:4177')localStorage.removeItem('settings-active-tab')" });
    const load = new Promise(resolve => { const listener = event => { if (event.sessionId === sessionId) { browser.events.off('Page.loadEventFired', listener); resolve(); } }; browser.events.on('Page.loadEventFired', listener); });
    await send('Page.navigate', { url: 'http://127.0.0.1:4177/personal' }); await load;
    const report = await evaluate(String.raw`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
      await frame(); await frame()
      const check = (value, message) => { if (!value) throw new Error(message) }
      check(location.pathname === '/personal' && document.querySelector('.personal-view'), '本地真实页面未进入个人页')
      check(!localStorage.getItem('admin_token') && !localStorage.getItem('current_account_id') && !localStorage.getItem('user_info'), '本地出现登录或账号状态')
      check(!document.body.textContent.includes('服务器错误'), '仍出现503服务器错误')
      check(document.querySelector('aside') && document.querySelector('header'), '真实导航未挂载')
      const paints = []
      async function action(element, text, axis, direction) {
        window.__localVerifyStep = text
        check(element, '找不到实际控件：' + text)
        const header = document.querySelector('header').getBoundingClientRect()
        const nav = document.querySelector('.personal-tabs')?.getBoundingClientRect()
        element.click()
        for (let i = 0; i < 10 && !document.documentElement.dataset.contentMotion; i++) await frame()
        for (let i = 0; i < 12 && !document.getAnimations().some(item => item.animationName === 'content-snapshot-in'); i++) await frame()
        const running = document.getAnimations().filter(item => ['content-snapshot-in', 'content-snapshot-out'].includes(item.animationName))
        check(running.length === 2, '实际正式构建没有前后滑动动效：' + text)
        const frames = running.map(item => ({ name: item.animationName, timing: item.effect.getTiming(), keyframes: item.effect.getKeyframes().map(key => ({ transform: key.transform, opacity: key.opacity })) }))
        const incoming = frames.find(item => item.name === 'content-snapshot-in'), outgoing = frames.find(item => item.name === 'content-snapshot-out')
        // Percentage transforms are relative to each painted viewport and are
        // intentionally not parseable by DOMMatrix without an element box.
        const offsets = transform => {
          const values = transform.match(/translate3d\(([^,]+),\s*([^,]+),/)?.slice(1).map(parseFloat)
          check(values?.length === 2, '滑动关键帧不是纯平移：' + transform)
          return { x: values[0], y: values[1] }
        }
        const incomingVector = offsets(incoming.keyframes[0].transform), outgoingVector = offsets(outgoing.keyframes.at(-1).transform)
        const incomingOffset = incomingVector[axis], outgoingOffset = outgoingVector[axis]
        check(Math.sign(incomingOffset) === direction && Math.sign(outgoingOffset) === -direction, '滑动方向不符合前后顺序：' + text)
        check(axis === 'y' ? incomingVector.x === 0 && outgoingVector.x === 0 : incomingVector.y === 0 && outgoingVector.y === 0, '滑动混入另一方向：' + text)
        check(!frames.some(item => item.keyframes.some(key => key.transform.includes('scale') || key.opacity && key.opacity !== '1')), '推页仍残留缩放或淡入')
        check(Math.abs(incomingOffset + outgoingOffset) < 1 && incoming.timing.duration === outgoing.timing.duration && incoming.timing.easing === outgoing.timing.easing, '前后页面不是同速接续')
        const groupStyle = getComputedStyle(document.documentElement, '::view-transition-group(farm-content)')
        check(groupStyle.clipPath !== 'none', '滑动快照未裁切，可能遮住其他元素')
        const afterHeader = document.querySelector('header').getBoundingClientRect()
        check(Math.abs(header.top - afterHeader.top) < 1 && Math.abs(header.left - afterHeader.left) < 1, '顶栏跟着滑动')
        if (axis === 'x' && nav) check(Math.abs(nav.top - document.querySelector('.personal-tabs').getBoundingClientRect().top) < 1, '标签栏跟着内容滑走')
        paints.push({ label: text, axis, direction, clipPath: groupStyle.clipPath, pageCount: document.querySelectorAll('[data-page-content]').length, frames })
        await Promise.all(running.map(item => item.finished.catch(() => {})))
        // Native rendering releases pseudo-elements on a compositor frame after
        // animation timelines end; do not confuse that frame with a leaked job.
        for (let i = 0; i < 6 && document.documentElement.dataset.contentMotion; i++) await frame()
        check(!document.documentElement.dataset.contentMotion, '正式构建动画结束仍残留快照')
      }
      const textButton = text => [...document.querySelectorAll('button')].find(item => item.querySelector('.ui-tab-label')?.textContent.trim() === text || item.textContent.trim() === text || item.textContent.trim().replace(/\s+\d+$/, '') === text)
      await action(textButton('我的背包'), '我的背包', 'x', 1)
      check(document.querySelector('.bag-view') && !document.querySelector('.bag-item'), '未登录真实背包不应填示例物品')
      await action(textButton('我的农场'), '我的农场', 'x', -1)
      await action(document.querySelector('a[href="/friends"]'), '好友', 'y', 1)
      check(location.pathname === '/friends', '真实好友路由不可进入')
      await action(textButton('好友黑名单'), '好友黑名单', 'x', 1)
      await action(textButton('好友列表'), '好友列表', 'x', -1)
      await action(document.querySelector('a[href="/shop"]'), '商店', 'y', 1)
      await action(textButton('宠物商店'), '宠物商店', 'x', 1)
      await action(textButton('种子商店'), '种子商店', 'x', -1)
      await action(document.querySelector('a[href="/settings"]'), '设置', 'y', 1)
      await action(textButton('策略设置'), '策略设置', 'x', 1)
      await action(textButton('账号管理'), '账号管理', 'x', -1)
      await action(document.querySelector('a[href="/activity"]'), '活动', 'y', -1)
      await action(textButton('节令小礼'), '节令小礼', 'x', 1)
      await action(textButton('奶茶热销中'), '奶茶热销中', 'x', -1)
      await action(document.querySelector('a[href="/mutation-catalog"]'), '变异宝典', 'y', 1)
      await action(textButton('装扮变异'), '装扮变异', 'x', 1)
      await action(textButton('藏品变异'), '藏品变异', 'x', 1)
      await action(textButton('常规变异'), '常规变异', 'x', -1)
      await action(document.querySelector('a[href="/personal"]'), '个人', 'y', -1)
      await action(document.querySelector('a[href="/"]'), '概览', 'y', -1)
      await action(document.querySelector('a[href="/personal"]'), '概览到个人', 'y', 1)
      await action(document.querySelector('a[href="/"]'), '个人回概览', 'y', -1)
      let nativeCaptures = 0
      const nativeStart = document.startViewTransition.bind(document)
      document.startViewTransition = callback => { nativeCaptures++; return nativeStart(callback) }
      const personalLink = document.querySelector('a[href="/personal"]'), dashboardLink = document.querySelector('a[href="/"]')
      personalLink.click()
      for (let i = 0; i < 25 && (!document.querySelector('.personal-view') || !document.getAnimations().some(item => item.animationName === 'content-snapshot-out' && Number(item.currentTime) > 55)); i++) await frame()
      const beforeReverse = document.getAnimations().find(item => item.animationName === 'content-snapshot-out')
      check(beforeReverse && Number(beforeReverse.currentTime) > 0, '反向接续前没有在途动画')
      const timeAtReversal = Number(beforeReverse.currentTime)
      dashboardLink.click()
      for (let i = 0; i < 16 && beforeReverse.effect.getTiming().duration !== 260; i++) await frame()
      check(nativeCaptures === 1, '反向切页不应跳终点重新抓图')
      check(beforeReverse.playbackRate === 1 && beforeReverse.effect.getTiming().duration === 260, '页面反向仍倒放原曲线而非当前画面柔和续接')
      check(beforeReverse.effect.getKeyframes()[0].transform.startsWith('matrix'), '页面续接不是当前真实像素矩阵')
      await beforeReverse.finished.catch(() => {})
      for (let i = 0; i < 6 && document.documentElement.dataset.contentMotion; i++) await frame()
      check(location.pathname === '/' && !document.documentElement.dataset.contentMotion, '反向接续结束未回到真实概览')
      document.startViewTransition = nativeStart
      const reversal = { nativeCaptures, timeAtReversal, reusedTimeline: true, forwardDamping: true, finalRoute: location.pathname }
      await action(document.querySelector('a[href="/mutation-catalog"]'), '宝典连续标签测试', 'y', 1)
      let panelCaptures=0
      document.startViewTransition=callback=>{panelCaptures++;return nativeStart(callback)}
      textButton('装扮变异').click();await frame()
      check(textButton('装扮变异').getAttribute('aria-selected')==='true','选中标签应在捕获前立即响应')
      for(let i=0;i<24&&!document.getAnimations().some(item=>item.animationName==='content-snapshot-out'&&Number(item.currentTime)>65);i++)await frame()
      const panelOut=document.getAnimations().find(item=>item.animationName==='content-snapshot-out')
      check(panelOut,'反向标签前没有真实动画')
      const transformBefore=getComputedStyle(document.documentElement,'::view-transition-old(farm-content)').transform
      textButton('常规变异').click();await frame();await frame()
      check(panelCaptures===1,'标签反向不能重捕获')
      check(panelOut.playbackRate===1&&panelOut.effect.getTiming().duration===260,'标签倒放硬减速未替换为新段')
      const reverseFrames=panelOut.effect.getKeyframes();check(reverseFrames[0].transform.startsWith('matrix'),'反向必须从当前像素矩阵出发')
      await panelOut.finished.catch(()=>{});for(let i=0;i<8&&document.documentElement.dataset.contentMotion;i++)await frame()
      const matrixX=value=>parseFloat(value.match(/matrix\(([^)]+)\)/)?.[1].split(',')[4]||'0')
      const continuityDifference=Math.abs(matrixX(transformBefore)-matrixX(reverseFrames[0].transform))
      const readBefore=window.__reqMonitor?.summarize().window.total
      textButton('装扮变异').click()
      for(let i=0;i<24&&!document.getAnimations().some(item=>item.animationName==='content-snapshot-out'&&Number(item.currentTime)>55);i++)await frame()
      const runningPanel=document.getAnimations().find(item=>item.animationName==='content-snapshot-out')
      textButton('藏品变异').click();await frame()
      check(textButton('藏品变异').getAttribute('aria-selected')==='true','第三标签点击反馈应立即到位')
      check(runningPanel.effect.getTiming().duration===110,'第三标签仍直接跳终点而非短续接')
      for(let i=0;i<120&&(document.documentElement.dataset.contentMotion||document.querySelector('.mutation-list-heading h2')?.textContent!=='藏品变异');i++)await frame()
      check(document.querySelector('.mutation-list-heading h2')?.textContent==='藏品变异'&&!document.documentElement.dataset.contentMotion,'连续标签最后意图未落地')
      check(window.__reqMonitor?.summarize().window.total===readBefore,'连续标签增加了后端读')
      document.startViewTransition=nativeStart
      const panelContinuity={immediateSelection:true,reverseCaptures:1,forwardDamping:true,continuityDifference,thirdTabBridgeMs:110,finalLabel:'藏品变异'}
      const nextAccount = [...document.querySelectorAll('button')].find(item => item.textContent.includes('添加账号'))
      check(!nextAccount || nextAccount.disabled, '本地模式添加账号入口未禁止')
      check(!document.body.textContent.includes('服务器错误'), '浏览期间仍出现服务器错误')
      return { ok: true, view: location.pathname, paints, reversal, panelContinuity, tokenPresent: !!localStorage.getItem('admin_token'),
        selectedAccount: localStorage.getItem('current_account_id') || '', realPageComponents: true, mockAccounts: 0 }
    })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    report.mobile = await evaluate(String.raw`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
      // Device metrics deliver resize asynchronously. Let that layout settle
      // before input; otherwise the resize safety cancel hits the new motion.
      await frame(); await frame(); await frame()
      const personal = document.querySelector('a[href="/personal"]')
      personal.click()
      for (let i = 0; i < 30 && (!document.querySelector('.personal-view') || !document.getAnimations().some(item => item.animationName === 'content-snapshot-out')); i++) await frame()
      const animations = document.getAnimations().filter(item => ['content-snapshot-in','content-snapshot-out'].includes(item.animationName))
      if (animations.length !== 2) throw new Error('手机宽度没有真实推页')
      await Promise.all(animations.map(item => item.finished.catch(() => {})))
      for (let i = 0; i < 6 && document.documentElement.dataset.contentMotion; i++) await frame()
      if (document.documentElement.scrollWidth > 375 || document.querySelectorAll('[data-page-content]').length !== 1) throw new Error('手机推页溢出或保活多页')
      return { width: innerWidth, noHorizontalOverflow: true, onlyOnePage: true, directionSlidePlayed: true }
    })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1040, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    report.reducedMotion = await evaluate(String.raw`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
      document.querySelector('a[href="/"]').click()
      for (let i = 0; i < 16 && location.pathname !== '/'; i++) await frame()
      await frame(); await frame()
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.contentMotion || document.getAnimations().some(item => ['content-snapshot-in','content-snapshot-out'].includes(item.animationName))) throw new Error('实际减动效仍播放推页')
      return { preferenceApplied: true, snapshotAnimations: 0, routeChanged: location.pathname === '/' }
    })()`);
    report.apiRequests = requests.filter(item => /\/api\/|\/socket\.io/.test(item.url));
    report.networkWrites = requests.filter(item => !['GET', 'HEAD'].includes(item.method));
    report.errors = errors;
    assert.equal(report.ok, true); assert.equal(report.tokenPresent, false); assert.equal(report.selectedAccount, '');
    assert.equal(report.apiRequests.length, 0); assert.equal(report.networkWrites.length, 0); assert.equal(errors.length, 0);
    fs.writeFileSync(path.join(directory, 'local-readonly-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('LOCAL_READONLY_VERIFIED', JSON.stringify({ path: report.view, actualNavigationChecks: report.paints.length, apiRequests: 0, accountLogin: false }));
  } finally { await browser.close(); }
});

test('Edge 真实本地页面：活动与变异宝典主题一致、标签不漂移且没有账号请求', {
  skip: !process.env.FARM_LOCAL_STYLE_VERIFY,
}, async () => {
  const directory = path.resolve(process.env.FARM_LOCAL_STYLE_VERIFY);
  const browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory);
  const requests = [], errors = [], samples = [];
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    browser.events.on('Network.requestWillBeSent', event => { if (event.sessionId === sessionId) requests.push({ url: event.params.request.url, method: event.params.request.method }); });
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) errors.push(event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    async function open(route, selector, width, theme) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin==='http://127.0.0.1:4177')localStorage.setItem('ui_theme',${JSON.stringify(theme)})` });
      let loadListener, loadTimer;
      const loaded = new Promise((resolve, reject) => {
        loadTimer = setTimeout(() => reject(new Error('Real local page load timed out: ' + route)), 15000);
        loadListener = event => { if (event.sessionId === sessionId) resolve(); };
        browser.events.on('Page.loadEventFired', loadListener);
      });
      try { await send('Page.navigate', { url: `http://127.0.0.1:4177${route}` }); await loaded; }
      finally { clearTimeout(loadTimer); browser.events.off('Page.loadEventFired', loadListener); }
      return evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        for (let i=0;i<100&&!document.querySelector(${JSON.stringify(selector)});i++) await frame();
        await frame(); await frame();
        const root=document.querySelector(${JSON.stringify(selector)});if(!root)throw new Error('实际页面未挂载');
        const title=root.querySelector('h1'),nav=root.querySelector('.ui-tabs'),active=nav.querySelector('[data-active="true"]');
        const css=getComputedStyle(document.documentElement),style=getComputedStyle(nav),caption=getComputedStyle(title);
        const normalize=value=>{const e=document.createElement('span');e.style.color=value;document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c};
        if(caption.color!==normalize(css.getPropertyValue('--theme-text')))throw new Error('标题没有使用当前主题');
        if(style.backgroundColor!==normalize(css.getPropertyValue('--surface-1')))throw new Error('标签容器不是主题卡片');
        const selection=nav.querySelector('.ui-tab-selection[data-ready="true"]');
        if(!selection||nav.querySelectorAll('.ui-tab-selection').length!==1)throw new Error('标签没有唯一的连续选中面');
        const selectedBackground=getComputedStyle(selection).backgroundColor;
        if(selectedBackground!==normalize('color-mix(in srgb, var(--theme-primary) 15%, var(--surface-1))'))throw new Error('标签选中面不是统一主题柔色');
        if(getComputedStyle(active).color!==caption.color)throw new Error('选中标签文字没有使用可读主题色');
        // color-mix() serializes as color(srgb ...) with 0..1 channels in Edge,
        // not rgb()'s 0..255 channels. Read actual painted sRGB for both syntaxes.
        const rgb=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=normalize(value);ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
        const luminance=value=>{const c=rgb(value).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};
        const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
        const secondary=root.querySelector('.ui-page-heading p'),inactive=nav.querySelector('[data-active="false"]'),emptyCopy=root.querySelector('.ui-empty-state p');
        if(getComputedStyle(secondary).color!==normalize(css.getPropertyValue('--muted-text')))throw new Error('说明文字未使用统一可读色');
        if(getComputedStyle(inactive).color!==caption.color||getComputedStyle(inactive).opacity!=='1')throw new Error('未选中标签仍发灰或透明');
        const secondaryContrast=ratio(getComputedStyle(secondary).color,style.backgroundColor),inactiveContrast=ratio(getComputedStyle(inactive).color,style.backgroundColor);
        const activeContrast=ratio(getComputedStyle(active).color,selectedBackground);
        if(secondaryContrast<5.5||inactiveContrast<4.5||activeContrast<4.5)throw new Error('实际文字对比不足');
        if(emptyCopy&&(getComputedStyle(emptyCopy).color!==normalize(css.getPropertyValue('--muted-text'))||getComputedStyle(emptyCopy).opacity!=='1'))throw new Error('空态说明仍降低可读性');
        const schedule=root.querySelector('.activity-header-schedule');
        if(schedule&&(getComputedStyle(schedule).fontSize!=='12px'||[...schedule.querySelectorAll('strong')].some(e=>getComputedStyle(e).color!==caption.color||Number(getComputedStyle(e).fontWeight)<600)))throw new Error('真实截止时间未加重');
        if(document.documentElement.scrollWidth>innerWidth||root.scrollWidth>root.clientWidth+1)throw new Error('两页出现横向溢出');
        const tabs=[...nav.querySelectorAll('button')];const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
        const centers=tabs.filter(button=>button.classList.contains('ui-tab-counted')).map(button=>{const b=rect(button),label=rect(button.querySelector('.ui-tab-label'));return Math.abs(label.x+label.width/2-b.x-b.width/2)});
        const centeringError=Math.max(0,...centers);if(centeringError>.25)throw new Error('标签文字没有真正居中 '+centeringError);
        const before=tabs.map(rect);for(const button of tabs){button.click();await frame();await frame()};const after=tabs.map(rect);
        const drift=Math.max(...before.flatMap((r,i)=>Object.keys(r).map(k=>Math.abs(r[k]-after[i][k]))));if(drift>.25)throw new Error('切换标签位置漂移 '+drift);
        if(document.getElementById('panel-req-monitor'))throw new Error('普通使用仍出现诊断浮条');
        const ruleCount=root.querySelectorAll('.mutation-card,.mutation-series').length;
        if(${JSON.stringify(selector)}==='.mutation-catalog'&&ruleCount===0)throw new Error('可信静态规则没有渲染');
        if(${JSON.stringify(selector)}==='.activity-page'&&!root.textContent.includes('本地仅查看界面'))throw new Error('本地空态仍要求登录账号');
        if([...document.querySelectorAll('img')].some(img=>!img.hasAttribute('alt')))throw new Error('真实图片缺少alt');
        if([...nav.querySelectorAll('[role="tab"]')].filter(button=>button.getAttribute('aria-selected')==='true').length!==1)throw new Error('标签选择语义错误');
        if(!document.getElementById(nav.querySelector('[aria-selected="true"]').getAttribute('aria-controls')))throw new Error('tab没有真实内容区域');
        if(localStorage.getItem('admin_token')||localStorage.getItem('current_account_id')||localStorage.getItem('user_info'))throw new Error('出现账号或登录状态');
        return{route:location.pathname,width:innerWidth,theme:localStorage.getItem('ui_theme'),title:title.textContent,titleSize:caption.fontSize,titleWeight:caption.fontWeight,titleColor:caption.color,tabBackground:style.backgroundColor,tabRadius:style.borderRadius,activeBackground:getComputedStyle(selection).backgroundColor,activeContrast,secondaryContrast,inactiveContrast,secondaryColor:getComputedStyle(secondary).color,drift,centeringError,ruleCount,noHorizontalOverflow:true,unloaded:!!root.querySelector('.ui-empty-state'),livePages:document.querySelectorAll('[data-page-content]').length};
      })()`);
    }
    for (const width of [375, 768, 1024, 1440, 1920]) {
      for (const [route, selector] of [['/activity','.activity-page'],['/mutation-catalog','.mutation-catalog']])
        samples.push(await open(route, selector, width, 'light-green'));
    }
    for (const [route, selector] of [['/activity','.activity-page'],['/mutation-catalog','.mutation-catalog']])
      samples.push(await open(route, selector, 1440, 'dark-blue'));
    const baseline = await open('/personal', '.personal-view', 1440, 'light-green');
    for (const sample of samples.filter(item => item.width === 1440 && item.theme === 'light-green')) {
      assert.equal(sample.titleSize, baseline.titleSize); assert.equal(sample.titleWeight, baseline.titleWeight);
      assert.equal(sample.titleColor, baseline.titleColor); assert.equal(sample.tabBackground, baseline.tabBackground);
      assert.equal(sample.tabRadius, baseline.tabRadius); assert.equal(sample.activeBackground, baseline.activeBackground);
    }
    for (const [route, selector, filename] of [['/activity','.activity-page','activity-style-1440.png'],['/mutation-catalog','.mutation-catalog','mutation-style-1440.png']]) {
      await open(route, selector, 1440, 'light-green');
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(directory, filename), Buffer.from(data, 'base64'));
    }
    await open('/mutation-catalog', '.mutation-catalog', 1440, 'light-green');
    const catalogTools = await evaluate(String.raw`(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
      const root=document.querySelector('.mutation-catalog'),tabs=[...root.querySelectorAll('[role="tab"]')];
      const choose=async label=>{tabs.find(button=>button.querySelector('.ui-tab-label').textContent.trim()===label).click();await frame();await frame()};
      const input=root.querySelector('input[type="search"]'),select=root.querySelector('select');
      const query=async text=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));await frame();await frame()};
      await choose('常规变异');await query('黄金');
      if(root.querySelectorAll('.mutation-card').length!==1||!root.querySelector('.mutation-card h3').textContent.includes('黄金'))throw new Error('真实静态名称搜索失效');
      if(![...root.querySelectorAll('dt')].some(item=>item.textContent.includes('天工作物')))throw new Error('作物品质名未使用规则依据');
      await query('售价');select.value='price';select.dispatchEvent(new Event('change',{bubbles:true}));await frame();await frame();
      if(!root.querySelectorAll('.mutation-card').length||[...root.querySelectorAll('.mutation-card')].some(item=>!item.querySelector('.mutation-effect')?.textContent.includes('售价×')))throw new Error('效果筛选失效');
      await query('不存在的规则词');if(!root.textContent.includes('没有匹配的规则'))throw new Error('搜索无结果没有清楚空态');
      [...root.querySelectorAll('button')].find(button=>button.textContent.trim()==='清除筛选').click();await frame();await frame();
      if(input.value!==''||select.value!=='all'||root.querySelectorAll('.mutation-card').length<2)throw new Error('重置不能恢复真实规则');
      await choose('藏品变异');
      const details=root.querySelector('.mutation-items-details');if(!details||details.open)throw new Error('长列表没有默认折叠');
      details.querySelector('summary').click();await frame();if(!details.open||!details.querySelector('.mutation-series-items').textContent.trim())throw new Error('藏品列表无法展开');
      const name=details.querySelector('.mutation-series-items > span').textContent.trim();await query(name);
      if(root.querySelectorAll('.mutation-series').length!==1)throw new Error('藏品名称不能搜索所属系列');
      const source=root.querySelector('.mutation-source');source.querySelector('summary').click();await frame();
      if(!source.open||!source.textContent.includes('不是实时游戏状态'))throw new Error('版本说明或来源边界缺失');
      return{searchedName:true,searchedEffect:true,filteredEffect:true,noResults:true,reset:true,collectionSearch:true,detailsExpanded:true,sourceVisible:true}
    })()`);
    const gameRequests = requests.filter(item => /\/api\/|\/socket\.io|^wss?:/.test(item.url));
    assert.equal(gameRequests.length, 0); assert.equal(requests.filter(item => !['GET','HEAD'].includes(item.method)).length, 0); assert.equal(errors.length, 0);
    assert.ok(samples.every(item => item.livePages === 1 && (item.route === '/activity' ? item.unloaded : item.ruleCount > 0)));
    const report = { ok: true, scope: 'Centered labels, genuine bundled rules, search/filter, accurate local empty states, opt-in diagnostics', samples, catalogTools, personalBaseline: baseline, noAccountLogin: true, apiRequests: gameRequests, networkWrites: 0, errors, actualVuePages: true, syntheticData: false };
    fs.writeFileSync(path.join(directory, 'page-style-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('PAGE_STYLE_VERIFIED', JSON.stringify({ samples: samples.length, matchingPersonalBaseline: true, accountLogin: false, apiRequests: 0 }));
  } finally { await browser.close(); }
});

test('Edge 第一批前端优化预览：真实个人背包好友、状态连续性、键盘与零真实请求', {
  skip: !process.env.FARM_UX_PREVIEW_DIR,
}, async () => {
  const { execFileSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const directory = path.resolve(process.env.FARM_UX_PREVIEW_DIR);
  const buildDirectory = path.resolve(process.env.FARM_UX_BUILD_DIR);
  const edge = process.env.FARM_EDGE_EXECUTABLE;
  assert.ok(edge && fs.existsSync(edge), 'Use only the already-installed Edge');
  assert.ok(fs.statSync(path.dirname(directory)).isDirectory());
  const proof = await buildUxPreview(directory, buildDirectory);
  const results = [];
  const widths = process.env.FARM_UX_QUICK ? [375] : [375, 768, 1024, 1440, 1920];
  const scenarios = widths.map(width => ({ width, reduced: false }));
  if (!process.env.FARM_UX_QUICK) scenarios.push({ width: 1440, reduced: true });
  const browser = await realtimeEdge(edge, directory);
  try {
    for (const { width, reduced } of scenarios) {
      const report = await edgeRealtimeReport(browser, pathToFileURL(proof.file).href + '?check=1', width, reduced);
      results.push(report);
      fs.writeFileSync(path.join(directory, 'ux-verification.json'), JSON.stringify({ ...proof, results }, null, 2) + '\n');
      assert.equal(report.viewport, width);
      assert.equal(report.ok, true, report.error || JSON.stringify(report));
      assert.equal(report.realNetworkCalls, 0);
      assert.equal(report.reducedMotion, reduced, 'Browser preference must match the scenario, not just a CSS assertion');
    }
  } finally { await browser.close(); }
  const screenshots = [];
  if (!process.env.FARM_UX_QUICK) for (const [name, width, query] of [
    ['bag-standard-1440', 1440, ''], ['bag-compact-1440', 1440, '?density=compact'], ['bag-mobile-375', 375, ''], ['bag-dark-1440', 1440, '?theme=dark'], ['friends-1440', 1440, '?page=friends'],
  ]) {
    const file = path.join(directory, `${name}.png`);
    if (width === 375) {
      const wrapper = path.join(directory, 'mobile-screenshot.html');
      fs.writeFileSync(wrapper, '<!doctype html><html><body style="margin:0;background:#ece7da"><iframe src="ux-preview.html" style="width:375px;height:1040px;border:0"></iframe></body></html>');
      execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--allow-file-access-from-files', '--force-device-scale-factor=1', '--window-size=800,1080', '--virtual-time-budget=2000', `--user-data-dir=${path.join(directory, 'edge-profile')}`, `--screenshot=${file}`, pathToFileURL(wrapper).href], { timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    else execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--allow-file-access-from-files', '--force-device-scale-factor=1', `--window-size=${width},1040`, '--virtual-time-budget=2000', `--user-data-dir=${path.join(directory, 'edge-profile')}`, `--screenshot=${file}`, pathToFileURL(proof.file).href + query], { timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(fs.statSync(file).size > 10000); screenshots.push(file);
  }
  fs.writeFileSync(path.join(directory, 'ux-verification.json'), JSON.stringify({ ...proof, results, screenshots }, null, 2) + '\n');
  console.log('FRONTEND_UX_PREVIEW', JSON.stringify({ file: proof.file, viewports: results.map(result => result.viewport), actualComponents: proof.actualComponents.length, realNetworkCalls: 0, screenshots }));
});

test('panel scroll continuity holds only geometry through short loading content, releases on fitting scroll and restores original styles/listeners', () => {
  let height = 1600, scrollTop = 700, entryHeight = 1600;
  const listeners = new Map(), style = { minHeight: '180px', overflowAnchor: '' };
  const scroller = { isConnected: true, clientTop: 0, clientHeight: 700,
    get scrollTop() { return scrollTop; }, get scrollHeight() { return 200 + Math.max(height, parseFloat(style.minHeight) || 0); },
    getBoundingClientRect: () => ({ top: 0 }), addEventListener: (event, listener) => listeners.set(event, listener), removeEventListener: event => listeners.delete(event) };
  const element = { isConnected: true, style, closest: () => scroller,
    getBoundingClientRect: () => ({ top: 200 - scrollTop, height: Math.max(height, parseFloat(style.minHeight) || 0) }),
    querySelector: () => ({ getBoundingClientRect: () => ({ height: entryHeight }) }) };
  const motion = frontendHarness().load('composables/useContentMotion.ts').createPanelScrollContinuity(() => element);
  try {
    motion.capture(); assert.equal(style.minHeight, '1600px'); assert.equal(style.overflowAnchor, 'none');
    height = entryHeight = 180; motion.release(); assert.equal(style.minHeight, '1200px'); assert.equal(scrollTop, 700);
    assert.equal(listeners.size, 1);
    scrollTop = 0; listeners.get('scroll')(); assert.equal(style.minHeight, '180px'); assert.equal(style.overflowAnchor, '');
    height = entryHeight = 1600; scrollTop = 700; motion.capture(); motion.release(); assert.equal(style.minHeight, '180px');
    motion.dispose(); assert.equal(listeners.size, 0); assert.equal(style.minHeight, '180px');
  } finally { motion.dispose(); }
});

test('category and filter controllers hand off one geometry floor and old disposal cannot restore stale inline height', () => {
  const api = frontendHarness().load('composables/useContentMotion.ts');
  const style = { minHeight: '180px', overflowAnchor: '' }, listeners = new Set();
  let naturalHeight = 1600;
  const scroller = { isConnected: true, scrollTop: 700, clientTop: 0, clientHeight: 700,
    get scrollHeight() { return 200 + Math.max(naturalHeight, parseFloat(style.minHeight) || 0); },
    getBoundingClientRect: () => ({ top: 0 }), addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  const element = { isConnected: true, style, closest: () => scroller,
    getBoundingClientRect: () => ({ top: -500, height: Math.max(naturalHeight, parseFloat(style.minHeight) || 0) }),
    querySelector: () => ({ getBoundingClientRect: () => ({ height: naturalHeight }) }) };
  const category = api.createPanelScrollContinuity(() => element), filter = api.createPanelScrollContinuity(() => element);
  try {
    category.capture(); naturalHeight = 180; category.release(); assert.equal(style.minHeight, '1200px');
    filter.capture(); filter.release(); assert.equal(style.minHeight, '1200px'); assert.equal(listeners.size, 1);
    category.dispose(); assert.equal(style.minHeight, '1200px'); assert.equal(listeners.size, 1);
    filter.dispose(); assert.equal(style.minHeight, '180px'); assert.equal(style.overflowAnchor, ''); assert.equal(listeners.size, 0);
  } finally { category.dispose(); filter.dispose(); }
});

test('tab keyboard arrows move focus only with preventScroll and never trigger a selection/read', () => {
  const points = [], prevent = [];
  const tabs = [0, 1, 2].map(index => ({ focus: options => points.push({ index, ...options }) }));
  const list = { querySelectorAll: () => tabs }; tabs.forEach(tab => { tab.closest = () => list; });
  const move = frontendHarness().load('composables/useContentMotion.ts').moveSlidingTabFocus;
  for (const [key, index] of [['ArrowLeft', 0], ['ArrowRight', 1], ['Home', 2], ['End', 0]]) move({ key, currentTarget: tabs[index], preventDefault: () => prevent.push(key) });
  assert.deepEqual(points, [{ index: 2, preventScroll: true }, { index: 2, preventScroll: true }, { index: 0, preventScroll: true }, { index: 2, preventScroll: true }]);
  move({ key: 'Enter', currentTarget: tabs[0], preventDefault: () => assert.fail('Enter stays native click') });
  assert.equal(points.length, 4); assert.equal(prevent.length, 4);
});

async function buildTabsVerificationSource(buildDirectory) {
  const esbuild = createRequire(webRequire.resolve('vite/package.json'))('esbuild'), styles = [], sources = {};
  const readCoordinatorSource = read('api/index.ts').slice(read('api/index.ts').indexOf('export function createReadCoordinator()'), read('api/index.ts').indexOf('\nconst safeReadPaths'));
  const mock = String.raw`
import { ref, computed, reactive } from 'vue'
import { defineStore } from 'pinia'
export const fixture = reactive({ reads: [], writes: [], errors: [], readDelay: 0, skinCase: 'normal', resolveSkin: null, skinId: 201009 })
const clone = value => JSON.parse(JSON.stringify(value))
const CanceledError = class extends Error { code = 'ERR_CANCELED' }
const tokenRef = ref(''), sessionEpoch = 0
const cloneRead = clone
export const isReadCanceled = error => error?.code === 'ERR_CANCELED'
export const invalidateSafeReads = () => {}
__READ_COORDINATOR__
const skins = () => ({ accountId: 'fixture-A', slots: [{ slotType: 1, label: '小屋', equippedSkinId: fixture.skinId }], items: [201009,201010].map(id => ({ skinId: id, slotType: 1, name: '小屋'+id, image: '', partName: '小屋', equipped: id===fixture.skinId, isNew: false, desc: '' })), stateKnown: true, ownedCount: 2 })
function payload(url, config) {
  if(url==='/api/skins') return {...skins(),accountId:config?.headers?.['x-account-id']||'fixture-A'}
  if(url==='/api/settings') return { ui:{theme:'light'} }
  if(url==='/api/plant-blacklist') return [20003]
  if(url==='/api/analytics') return [20003,20004,20005].map((seedId,index)=>({seedId,name:'作物'+seedId,image:'',level:index+1,size:1,seasons:1,growTime:100,expPerHour:10+index,expPerHourPerLand:10+index,profitPerHour:20+index,profitPerHourPerLand:20+index,normalFertilizerExpPerHour:15,normalFertilizerExpPerHourPerLand:15,normalFertilizerProfitPerHour:25,normalFertilizerProfitPerHourPerLand:25}))
  if(url==='/api/illustrated') { const items=Array.from({length:30},(_,index)=>({seedId:20003+index, name:(config?.params?.illustrated_type===2?'变异':'作物')+index,level:1,image:'',unlocked:index%2===0,plantedCount:1,harvestCount:1,canBuy:false}));return {items,summary:{total:30,unlocked:15,locked:15,canBuy:0},userLevel:130} }
  if(url==='/api/collection') return {userLevel:130,details:[{category:1,currentScore:0,claimedRewardScore:0,collections:Array.from({length:12},(_,index)=>({collectionId:700001+index,name:'藏品'+index,starLevel:0,ownCount:index%2===0?1:0,owned:index%2===0,rarity:index%2+1,image:'',isNew:false,canUpgrade:false,activated:false})),pedestals:[],wished:[]}]}
  if(url==='/api/dog/info') return {dogs:[1,2,3].map(id=>({id,name:'守护犬'+id,image:'',desc:'伙伴',rarity:id,owned:true,activated:true,activatable:false,deployed:id===1})),foods:[{id:6001,name:'狗粮',image:'',count:10,days:1,duration:86400}],deployedId:1,foodSeconds:3600,protectSeconds:86400,warnings:[]}
  if(url==='/api/dog/protect-logs') return {logs:[{id:1,friendName:'测试好友',timestamp:Math.floor(Date.now()/1000),dogName:'守护犬1',protectedGold:10}]}
  if(url==='/api/dog/capital-mode') return {enabled:false,dogId:1,leadSeconds:10}
  if(url==='/api/activity/update/status')return {report:{unknownActivityIds:[]}}
  if(url==='/api/admin/system-config') return {saved:{serverUrl:'',clientVersion:'fixture',platform:'qq',os:'iOS'},default:{serverUrl:'',clientVersion:'fixture',platform:'qq',os:'iOS'}}
  if(url==='/api/admin/login-links') return {logoUrl:'',title:'QQ农场智能助手',loginSubtitle:'',qqGroupUrl:''}
  if(url==='/api/admin/wx-config') return {enabled:false,mode:'local',apiBase:'',apiKey:'',proxyApiUrl:'',appId:'',autoAddAccount:false,userIsolation:true}
  if(url==='/api/admin/capture-config') return {enabled:false,embedded:true,apiBase:'',apiToken:'',tokenConfigured:false,autoImportQqGids:false}
  throw new Error('Unexpected offline read '+url)
}
export async function safeGet(url,config) { return api.get(url,config) }
const api = {
  async get(url,config) { fixture.reads.push({url,accountId:config?.headers?.['x-account-id']}); if(fixture.readDelay)await new Promise(resolve=>setTimeout(resolve,fixture.readDelay));return {data:{ok:true,data:clone(payload(url,config))}} },
  async post(url,body,config) {
    fixture.writes.push({url,body:clone(body),accountId:config?.headers?.['x-account-id']})
    if(url!=='/api/skins/equip')throw Error('Forbidden fixture mutation '+url)
    if(fixture.skinCase==='deferred') await new Promise(resolve=>fixture.resolveSkin=resolve)
    if(fixture.skinCase==='unknown')return {data:{ok:false,sent:true,resultState:'unknown',outcomeUnknown:true,error:'结果未确认'}}
    if(fixture.skinCase==='optimistic')return {data:{ok:true,data:{skinId:body.skinId,slotType:body.slotType}}}
    if(fixture.skinCase==='wrong-slot')return {data:{ok:true,data:{accountId:config.headers['x-account-id'],skinId:body.skinId,slotType:body.slotType,resultState:'completed',confirmation:'SkinsEquipped',equipped:[{skinId:body.skinId,slotType:2}]}}}
    fixture.skinId=body.skinId
    return {data:{ok:true,data:{accountId:config.headers['x-account-id'],skinId:body.skinId,slotType:body.slotType,resultState:'completed',confirmation:'SkinsEquipped',equipped:[{skinId:body.skinId,slotType:body.slotType}]}}}
  },
}
export default api
export const useToastStore = defineStore('tabs-fixture-toast',()=>Object.fromEntries(['success','error','warning','info'].map(name=>[name,message=>fixture.errors.push({name,message})])))
export const useStatusStore = defineStore('tabs-fixture-status',()=>({status:ref({status:{level:130}})}))
export const useUserStore = defineStore('tabs-fixture-user',()=>({username:ref('fixture-user'),isAdmin:ref(true),isSuperAdmin:ref(false),
  async getAllCards(){return{ok:true,data:[]}},async getAllUsers(){return{ok:true,data:[]}},async getLoginLogs(){return{ok:true,data:{logs:[],total:0}}},
}))
export const formatCardValue=()=>'',formatTimeDuration=()=>'',getCardQuotaValue=()=>0
export const useStorage=(_key,value)=>ref(value)
`.replace('__READ_COORDINATOR__', readCoordinatorSource);
  const entry = String.raw`
import {createApp,ref,computed,nextTick,h} from 'vue'
import {createPinia} from 'pinia'
import Pet from '@/views/Pet.vue'
import Illustrated from '@/views/Illustrated.vue'
import Collection from '@/views/Collection.vue'
import Analytics from '@/views/Analytics.vue'
import Admin from '@/views/AdminPanel.vue'
import MilkTea from '@/components/activity/MilkTeaActivityPanel.vue'
import Skin from '@/components/SkinPanel.vue'
import {useAccountStore} from '@/stores/account'
import {useAppStore} from '@/stores/app'
import {milkTeaOverview} from '@/utils/activity-overview'
import {cancelContentMotion} from '@/composables/useContentMotion'
import {fixture} from 'tabs:mock'
const page=ref('pet'),panel=ref(),milkPage=ref('shop'),milkLoading=ref(false),milkData=ref(),milkModel=ref(),navigation=[]
const now=Math.floor(Date.now()/1000)
function milkDataFor(key){return {title:'奶茶热销中',active:true,settling:false,serverTime:now,startTime:now-100,endTime:now+86400,settleStartTime:now+43200,summary:{shopOpenAt:now-10,shopName:'测试店铺',level:6,canUpgrade:true,hasUnclaimedWage:true},balances:{milkTeaToken:10000,coin:20000},shop:{level:6,totalRevenue:100,nextLevelRevenue:200,effectiveCupsPerHour:60,cashierElapsedSec:10,cashierCapacitySec:60,slots:[],drinkCups:{},pendingRewards:[]},recipes:Array.from({length:key==='workshop'?36:12},(_,index)=>({recipeId:index+1,recipeName:'配方'+index,unlocked:true,isAdvanced:false,description:'制作说明',tokenPrice:10,coinPrice:20})),goods:Array.from({length:key==='exchange'?30:1},(_,index)=>({id:index+1,name:'兑换商品'+index,available:true,unlocked:true,rewards:[{itemId:20003,itemName:'种子',itemCount:1}],costs:[{itemId:1041,itemName:'奶茶券',itemCount:10}],remaining:10})),work:{slips:[{id:1,wageStatus:1,wage:100}],hours:[]},levels:[{level:6,employeeSlotCount:1,recipes:[]},{level:7,employeeSlotCount:2,recipes:[]}],fund:{unlocked:true,tiers:[]},rank:{players:[]},logs:{items:[]}}}
milkData.value=milkDataFor('shop');milkModel.value=milkData.value
async function navigateMilk(key){navigation.push(key);milkPage.value=key;milkLoading.value=true;milkData.value=null;await new Promise(resolve=>setTimeout(resolve,140));if(milkPage.value!==key)return;milkData.value=milkDataFor(key);milkModel.value=milkData.value;milkLoading.value=false}
const app=createApp({setup(){const components={pet:Pet,illustrated:Illustrated,collection:Collection,analytics:Analytics,admin:Admin,skin:Skin};return()=>h('div',{'data-page-viewport':'',class:'test-viewport'},[h('div',{'data-test-heading':'',style:'height:120px;padding:16px'},'隔离组件验证'),page.value==='milk'?h('div',{class:'tab-motion-viewport'},[h('div',{'data-motion-entry':''},[h(MilkTea,{ref:milkDataRef,key:account.currentAccountId,activity:milkData.value,accountId:account.currentAccountId,page:milkPage.value,overview:milkTeaOverview(milkModel.value,null),loading:milkLoading.value,embedded:true,onNavigate:navigateMilk,onOperate:()=>{throw Error('Milk tea navigation must not write')}})])]):h(components[page.value],{ref:panel,key:page.value})])}})
const milkDataRef=ref(),pinia=createPinia();app.use(pinia);const account=useAccountStore(pinia);account.currentAccountId='fixture-A';const theme=useAppStore(pinia);theme.applyTheme('light-green',false);app.config.errorHandler=(error)=>fixture.errors.push({name:'vue',message:String(error)});app.mount('#app')
window.__tabsVerification={fixture,account,theme,page,milkPage,milkData,milkModel,milkLoading,panel,milkDataRef,navigation,cancelContentMotion,nextTick,milkDataFor,
  async show(name){cancelContentMotion('overlay');page.value=name;await nextTick()},
  async resetSkin(){fixture.skinId=201009;account.setSkinMutationState('fixture-A',1,'idle');account.setSkinMutationState('fixture-B',1,'idle');account.currentAccountId='fixture-A';page.value='pet';await nextTick();page.value='skin';await nextTick()},
}
`;
  const plugin = { name: 'tabs-isolated-verification', setup(build) {
    build.onResolve({ filter: /^tabs:/ }, args => ({ path: args.path, namespace: 'tabs' }));
    build.onResolve({ filter: /^@\// }, args => {
      if (['@/api', '@/stores/status', '@/stores/toast', '@/stores/user'].includes(args.path)) return { path: 'tabs:mock', namespace: 'tabs' };
      if (args.path === '@/config/localReadonly') return { path: 'tabs:readonly', namespace: 'tabs' };
      let filename = path.join(web, 'src', args.path.slice(2)); if (!path.extname(filename)) filename += '.ts'; return { path: filename };
    });
    build.onResolve({ filter: /^@vueuse\/core$/ }, () => ({ path: 'tabs:mock', namespace: 'tabs' }));
    build.onLoad({ filter: /.*/, namespace: 'tabs' }, args => ({ contents: args.path === 'tabs:readonly' ? 'export const LOCAL_UI_READONLY=false' : mock, loader: 'ts', resolveDir: web }));
    build.onLoad({ filter: /\.(svg|png|jpg)$/ }, () => ({ contents: "export default ''", loader: 'js' }));
    build.onLoad({ filter: /\.vue$/ }, args => {
      const raw = fs.readFileSync(args.path, 'utf8'), hash = require('node:crypto').createHash('sha256').update(raw).digest('hex');
      sources[path.relative(path.resolve(web, '..'), args.path).replaceAll('\\', '/')] = hash;
      const id = 'data-v-tabs-' + hash.slice(0, 10), descriptor = compiler.parse(raw, { filename: args.path }).descriptor;
      const script = compiler.compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component', templateOptions: { compilerOptions: { scopeId: descriptor.styles.some(style => style.scoped) ? id : undefined } } });
      for (const style of descriptor.styles) { const compiled = compiler.compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped }); assert.equal(compiled.errors.length, 0); styles.push(compiled.code); }
      return { contents: script.content + `\n__component.__scopeId='${id}';export default __component;`, loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } };
  const output = await esbuild.build({ stdin: { contents: entry, resolveDir: web, loader: 'ts' }, absWorkingDir: web,
    nodePaths: [path.join(web, 'node_modules')], bundle: true, write: false, format: 'iife', target: 'es2022', plugins: [plugin],
    alias: { vue: webRequire.resolve('vue/dist/vue.runtime.esm-bundler.js') },
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  const html = fs.readFileSync(path.join(buildDirectory, 'index.html'), 'utf8');
  const cssFiles = [...html.matchAll(/href="(?:\.\/|\/)?assets\/([^"]+\.css)"/g)].map(match => match[1]);
  const css = cssFiles.map(file => fs.readFileSync(path.join(buildDirectory, 'assets', file), 'utf8')).join('\n')
    .replace(/@import\s+(?:url\([^)]*\)|[^;]+);/g, '').replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (match, _quote, url) => url.startsWith('data:') ? match : 'none');
  return { code: output.outputFiles[0].text, styles: css + '\n' + styles.join('\n') + '\nhtml,body,#app{height:100%;margin:0;overflow:hidden}.test-viewport{height:100dvh;overflow-y:auto;overflow-x:clip;padding:0 16px 24px;contain:paint;}.test-viewport:has(dialog[open],.fixed){contain:none}', sources };
}

test('Edge isolated actual tabs: five content directions, milk tea sticky/navigation/scroll and single-write skin confirmation with zero real game transport', {
  skip: !process.env.FARM_TABS_VERIFY_DIR,
}, async () => {
  const directory = path.resolve(process.env.FARM_TABS_VERIFY_DIR), build = path.resolve(process.env.FARM_TABS_VERIFY_BUILD);
  assert.ok(fs.statSync(path.dirname(directory)).isDirectory());
  fs.mkdirSync(directory, { recursive: true });
  const source = await buildTabsVerificationSource(build), browser = await realtimeEdge(process.env.FARM_EDGE_EXECUTABLE, directory, true);
  const report = { scenes: [], screenshots: [], sources: source.sources, realNetwork: [], errors: [], noPreviewServer: true };
  let requestHandler;
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    const url = 'http://127.0.0.1:41997/__isolated_component_check__';
    const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'none';img-src data:;connect-src 'none';form-action 'none';base-uri 'none'"><style>${source.styles}</style></head><body><div id="app"></div></body></html>`;
    requestHandler = event => {
      if (event.sessionId !== sessionId) return;
      const req = event.params;
      if (req.resourceType === 'Document' && req.request.url === url) void send('Fetch.fulfillRequest', { requestId: req.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(document).toString('base64') });
      else { report.realNetwork.push({ url: req.request.url, method: req.request.method }); void send('Fetch.failRequest', { requestId: req.requestId, errorReason: 'BlockedByClient' }); }
    };
    browser.events.on('Fetch.requestPaused', requestHandler);
    browser.events.on('Runtime.exceptionThrown', event => { if (event.sessionId === sessionId) report.errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text); });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await evaluate(`(async()=>{while(!document.querySelector('#app'))await new Promise(resolve=>requestAnimationFrame(resolve))})()`);
    await evaluate(String.raw`
      window.__testFrames=async(n=2)=>{for(let i=0;i<n;i++)await new Promise(resolve=>requestAnimationFrame(resolve))};
      window.__testWait=async(check)=>{const end=performance.now()+5000;while(!check()){if(performance.now()>end)throw Error('Isolated condition timed out');await __testFrames(1)}};
      window.__motionAudit=[];const start=document.startViewTransition.bind(document);document.startViewTransition=callback=>{const row={kind:document.documentElement.dataset.contentMotion,direction:document.documentElement.dataset.contentDirection};__motionAudit.push(row);const t=start(callback);t.ready.catch(error=>row.error=String(error));return t};
    `);
    await evaluate(source.code);
    await evaluate('(async()=>{await __testWait(()=>window.__tabsVerification&&!window.__tabsVerification.fixture.errors.length&&document.querySelector(".dog-card"));await __testFrames(3)})()');
    for (const [page, listIndex, target, content] of [
      ['pet',0,'logs','守护记录'], ['illustrated',0,'2','变异0'], ['collection',0,'owned','藏品'], ['analytics',0,'blacklist','偷菜黑名单'], ['admin',0,'user','用户管理'],
    ]) {
      const scene = await evaluate(`(async()=>{
        const v=__tabsVerification;await v.show(${JSON.stringify(page)});await __testFrames(5);
        const list=document.querySelectorAll('[role="tablist"]')[${listIndex}],buttons=[...list.querySelectorAll('[role="tab"]')];
        if(!list||buttons.length<2)throw Error('Missing actual tablist');
        const button=buttons.find(item=>item.id.endsWith('-'+${JSON.stringify(target)}));if(!button)throw Error('Missing intended actual tab');
        const before=__motionAudit.length,header=document.querySelector('[data-test-heading]').getBoundingClientRect().top;
        button.click();await __testWait(()=>button.getAttribute('aria-selected')==='true'&&__motionAudit.length>before);await __testFrames(8);
        const animations=document.getAnimations().filter(item=>['content-snapshot-in','content-snapshot-out'].includes(item.animationName));
        if(animations.length!==2)throw Error('No two actual horizontal content surfaces: '+${JSON.stringify(page)});
        const transform=getComputedStyle(document.documentElement,'::view-transition-new(farm-content)').transform,matrix=new DOMMatrix(transform);
        if(Math.abs(matrix.m41)<1||Math.abs(matrix.m42)>1)throw Error('Content is not traveling horizontally: '+transform);
        if(document.querySelector('[data-test-heading]').getBoundingClientRect().top!==header)throw Error('Header moved with panel');
        await __testWait(()=>!document.documentElement.dataset.contentMotion);await __testFrames(3);
        const panel=document.getElementById(button.getAttribute('aria-controls'));if(!panel||!panel.textContent.includes(${JSON.stringify(content)}))throw Error('Actual target content is missing: '+panel?.textContent.slice(0,150));
        const directions=__motionAudit.slice(before).map(row=>row.direction);
        if(directions[0]!=='forward')throw Error('Forward direction incorrect');
        const reverseBefore=__motionAudit.length;buttons[0].click();await __testWait(()=>__motionAudit.length>reverseBefore);await __testFrames(4);
        if(__motionAudit.at(-1).direction!=='back')throw Error('Reverse direction incorrect');
        v.cancelContentMotion('overlay');await __testFrames(3);
        if(list.querySelectorAll('.ui-tab-selection').length!==1)throw Error('Competing selection surfaces');
        return {page:${JSON.stringify(page)},horizontal:true,transform,forward:true,back:true,stableHeader:true,actualPanel:true,reads:v.fixture.reads.length};
      })()`);
      report.scenes.push(scene);
    }
    report.scenes.push(await evaluate(String.raw`(async()=>{
      const v=__tabsVerification;await v.show('milk');await __testFrames(4);const root=document.querySelector('.milk-tea-panel'),scroller=document.querySelector('[data-page-viewport]'),details=root.querySelector('.milk-tea-todo'),toolbar=root.querySelector('.milk-tea-toolbar');
      if(details.open||details.getBoundingClientRect().height>48||toolbar.contains(details))throw Error('Todo is expanded or dominates sticky controls');
      if(root.querySelectorAll('[role="tab"]').length!==9)throw Error('Missing nine milk tea tabs');
      const click=key=>[...root.querySelectorAll('[role="tab"]')].find(button=>button.id.endsWith('-'+key)).click();
      click('exchange');await __testWait(()=>!v.milkLoading.value&&v.milkPage.value==='exchange');await __testFrames(30);
      if(root.querySelectorAll('[data-milk-tea-action="exchange"] input').length<20)throw Error('Long real exchange content not rendered');
      scroller.scrollTop=360;await __testFrames(3);const before=scroller.scrollTop,sticky=toolbar.getBoundingClientRect();
      if(Math.abs(sticky.top-scroller.getBoundingClientRect().top)>2)throw Error('Milk toolbar is not sticky');
      click('work');await __testFrames(2);const loadingPosition=scroller.scrollTop;
      await __testWait(()=>!v.milkLoading.value&&v.milkPage.value==='work');await __testFrames(8);const after=scroller.scrollTop;
      if(Math.abs(before-loadingPosition)>2||Math.abs(before-after)>2)throw Error('Ordinary page change reset/clamped scroll: '+JSON.stringify({before,loadingPosition,after}));
      v.cancelContentMotion('overlay');scroller.scrollTop=0;await __testFrames(3);
      root.querySelector('[data-milk-tea-exchange-entry]').click();await __testWait(()=>!v.milkLoading.value&&document.activeElement?.dataset.milkTeaAction==='exchange');await __testFrames(25);
      const exchange= root.querySelector('[data-milk-tea-action="exchange"]'),box=exchange.getBoundingClientRect(),tool=toolbar.getBoundingClientRect();
      if(box.top<tool.bottom-2||box.top>innerHeight)throw Error('Explicit exchange target is obscured/not visible');
      const writes=v.fixture.writes.length;await v.milkDataRef.value.navigateTo('work:wages');await __testWait(()=>!v.milkLoading.value&&document.activeElement?.dataset.milkTeaAction==='wages');
      if(v.fixture.writes.length!==writes)throw Error('Navigation sent a write');
      const allPages=[];
      for(const key of ['shop','workshop','hireList','upgrade','work','exchange','fund','rank','logs']){
        v.cancelContentMotion('overlay');const position=scroller.scrollTop;click(key);
        await __testWait(()=>!v.milkLoading.value&&v.milkPage.value===key);await __testFrames(4);
        if(Math.abs(scroller.scrollTop-position)>2)throw Error('Nine page switch moved scroll '+key+' '+position+' -> '+scroller.scrollTop);
        if(!root.querySelector('[data-milk-tea-action="'+key+'"]'))throw Error('Missing actual milk page '+key);
        allPages.push(key);
      }
      v.cancelContentMotion('overlay');details.querySelector('summary').click();await __testFrames(18);
      if(!details.open||!details.querySelector('button[aria-label^="前往兑换"]'))throw Error('Todo has no useful actual exchange entry');
      details.querySelector('button[aria-label^="前往兑换"]').click();await __testWait(()=>!v.milkLoading.value&&document.activeElement?.dataset.milkTeaAction==='exchange');
      scroller.scrollTop=0;await __testFrames(4);
      return {page:'milk',todoDefaultClosed:true,todoOutsideSticky:true,nineTabs:true,allPages,sticky:true,ordinaryScroll:{before,loadingPosition,after},explicitExchange:true,explicitWages:true,todoExchangeEntry:true,navigationWrites:0};
    })()`));
    for (const skinCase of ['normal', 'optimistic', 'unknown', 'wrong-slot']) {
      report.scenes.push(await evaluate(`(async()=>{
        const v=__tabsVerification;v.fixture.skinCase=${JSON.stringify(skinCase)};await v.resetSkin();await __testWait(()=>[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010'&&!button.disabled));
        const button=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010');button.click();await __testWait(()=>document.querySelector('dialog[open]'));
        const before=v.fixture.writes.length,submit=document.querySelector('.confirm-modal-actions button:last-child');submit.click();submit.click();await __testWait(()=>v.account.skinMutationState('fixture-A',1)!=='pending');await __testFrames(3);
        if(v.fixture.writes.length!==before+1)throw Error('Duplicate scene skin write');
        const sent=v.fixture.writes.at(-1);if(sent.accountId!=='fixture-A'||sent.body.expectedEquippedSkinId!==201009||sent.body.confirmed!==true)throw Error('Write context/confirmation was not frozen');
        const state=v.account.skinMutationState('fixture-A',1),text=document.querySelector('[data-page-viewport]').textContent;
        if(${JSON.stringify(skinCase)}==='normal'){if(state!=='idle'||!text.includes('已确认换上'))throw Error('Actual readback confirmation did not succeed')}
        else {if(state!=='unknown'||text.includes('已确认换上'))throw Error('Optimistic/unknown result incorrectly accepted');await v.show('pet');await v.show('skin');await __testFrames(4);if([...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010'&&!button.disabled))throw Error('Remount unlocked unknown slot')}
        return {page:'skin',case:${JSON.stringify(skinCase)},oneWrite:true,confirmedContext:true,resultState:state,unknownRemountBlocked:${skinCase === 'normal' ? 'false' : 'true'}};
      })()`));
    }
    report.scenes.push(await evaluate(String.raw`(async()=>{
      const v=__tabsVerification;v.fixture.skinCase='deferred';await v.resetSkin();await __testWait(()=>[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010'&&!button.disabled));
      [...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010').click();await __testWait(()=>document.querySelector('dialog[open]'));document.querySelector('.confirm-modal-actions button:last-child').click();await __testWait(()=>!!v.fixture.resolveSkin);
      v.account.currentAccountId='fixture-B';await __testFrames(2);v.account.currentAccountId='fixture-A';await __testFrames(2);
      if(!v.account.hasPendingSkinMutation('fixture-A'))throw Error('Pending write lock lost in A-B-A');
      if([...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='更换为 · 小屋201010'&&!button.disabled))throw Error('Pending write allowed a second action after A-B-A');
      v.fixture.resolveSkin();await __testWait(()=>v.account.skinMutationState('fixture-A',1)!=='pending');await __testFrames(4);
      const text=document.querySelector('[data-page-viewport]').textContent;if(text.includes('已确认换上'))throw Error('Late A-B-A completion leaked feedback');
      return {page:'skin',case:'A-B-A delayed completion',oldFeedbackIgnored:true,oneWrite:true};
    })()`));
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    report.scenes.push(await evaluate(String.raw`(async()=>{
      const v=__tabsVerification;await v.show('analytics');await __testFrames(4);const before=__motionAudit.length;[...document.querySelectorAll('[role="tab"]')].find(button=>button.id.endsWith('-strategy')).click();await __testFrames(3);
      if(__motionAudit.length!==before||document.documentElement.dataset.contentMotion)throw Error('Reduced motion still captures');return {page:'analytics',reducedMotionImmediate:true};
    })()`));
    for (const width of [375, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const [page, theme] of [['milk','light-green'],['collection','dark-blue']]) {
        const scene = await evaluate(`(async()=>{const v=__tabsVerification;v.theme.applyTheme(${JSON.stringify(theme)});await v.show(${JSON.stringify(page)});await __testFrames(4);if(document.documentElement.scrollWidth>innerWidth+1)throw Error('Mobile overflow');return {page:${JSON.stringify(page)},theme:${JSON.stringify(theme)},width:innerWidth,noOverflow:true,noAccountLogin:!localStorage.getItem('admin_token')&&!localStorage.getItem('user_info')}})()`);
        report.scenes.push(scene);
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(directory, `${page}-${theme}-${width}.png`); fs.writeFileSync(file, Buffer.from(data, 'base64')); report.screenshots.push(file);
      }
    }
    report.errors.push(...await evaluate('__tabsVerification.fixture.errors.filter(row=>row.name==="vue")'));
    report.ok = report.realNetwork.length === 0 && report.errors.length === 0;
    fs.writeFileSync(path.join(directory, 'tabs-milk-skin-verification.json'), JSON.stringify(report, null, 2) + '\n');
    assert.equal(report.ok, true, JSON.stringify({ network: report.realNetwork, errors: report.errors }));
    console.log('TABS_MILK_SKIN_VERIFIED', JSON.stringify({ scenes: report.scenes.length, realNetwork: 0, accountLogin: false, noPreviewServer: true }));
  } finally {
    if (requestHandler) browser.events.off('Fetch.requestPaused', requestHandler);
    await browser.close();
  }
});

module.exports = { frontendHarness, storage, deferred, web, webRequire, realtimeEdge, motionHarness, buildTabsVerificationSource };
