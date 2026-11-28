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

/** 编译真实卡片并运行 Vue 渲染与响应式更新，不替换其图片计算或模板。 */
function mountCollectionCard(item) {
  const { createRequire } = require('node:module');
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const vue = webRequire('vue');
  const compiler = webRequire('vue/compiler-sfc');
  const filename = path.join(__dirname, '../../web/src/components/collection/CollectionCard.vue');
  const parsed = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename });
  assert.deepEqual(parsed.errors, []);
  const script = compiler.compileScript(parsed.descriptor, { id: 'collection-image-contract', inlineTemplate: true }).content;
  const compiled = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => {
      if (name === 'vue') return vue;
      throw new Error(`卡片不能引入游戏或 API 模块：${name}`);
    },
  }, { filename });
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
  const host = {
    createElement: type => node(type), createText: text => node('#text', text),
    createComment: text => node('#comment', text),
    patchProp: (element, key, _previous, next) => { element.props[key] = next; },
    setText: (element, text) => { element.text = text; },
    setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    insert: (element, parent, anchor = null) => {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, element);
      element.parent = parent;
    },
    remove: element => {
      if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
      element.parent = null;
    },
  };
  const value = vue.ref(item);
  const root = node('root');
  const app = vue.createRenderer(host).createApp({ render: () => vue.h(module.exports.default, { item: value.value }) });
  app.mount(root);
  const elements = () => {
    const result = [];
    const visit = element => { result.push(element); element.children.forEach(visit); };
    visit(root);
    return result;
  };
  return {
    image: () => elements().find(element => element.type === 'img'),
    texts: () => elements().filter(element => element.type !== '#comment').map(element => element.text).join(' '),
    fail: async element => {
      element.props.onError({ currentTarget: { getAttribute: name => element.props[name] } });
      await vue.nextTick();
    },
    update: async patch => { value.value = { ...value.value, ...patch }; await vue.nextTick(); },
    unmount: () => app.unmount(),
  };
}

function zeroOwnedItem(patch = {}) {
  return { collectionId: 700001, name: '棉芽', image: '', iconKey: 'icon_collect_5_1',
    iconRes: 'gui/texture/collectIcon/icon_collect_5_1/spriteFrame', starLevel: 0, ownCount: 0,
    firstObtainedTime: 0, isNew: false, owned: false, activated: false, canUpgrade: false, ...patch };
}

test('real collection cards render all 30 images from the live empty-image contract while unowned', () => {
  const items = require('../src/gameConfig/ItemInfo.json').filter(item => Number(item.type) === 35);
  assert.equal(items.length, 30);
  for (const item of items) {
    const iconKey = item.icon_res.split('/').at(-2);
    const card = mountCollectionCard(zeroOwnedItem({ collectionId: item.id, name: item.name, iconKey, iconRes: item.icon_res }));
    try {
      const image = card.image();
      assert.ok(image, `${item.name} 不能仍然显示文字占位`);
      assert.equal(image.props.src, `/game-config/deco_icons/${iconKey}.png`);
      assert.equal(image.props.alt, item.name);
      assert.match(card.texts(), /未获得/);
      assert.doesNotMatch(card.texts(), /图标待补/);
      const raw = fs.readFileSync(path.join(__dirname, '../../web/public', image.props.src));
      assert.equal(raw.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } finally { card.unmount(); }
  }
});

test('collection card preserves image priority, falls back once and ignores stale image errors', async () => {
  const card = mountCollectionCard(zeroOwnedItem({ image: '/old-missing-image.png' }));
  try {
    const first = card.image();
    assert.equal(first.props.src, '/old-missing-image.png');
    await card.fail(first);
    const fallback = card.image();
    assert.equal(fallback.props.src, '/game-config/deco_icons/icon_collect_5_1.png');
    await card.fail(first);
    assert.equal(card.image(), fallback, '旧图错误不能误伤新图片');
    await card.fail(fallback);
    assert.equal(card.image(), undefined, '候选去重后失败一次就结束，不能循环请求');
    assert.match(card.texts(), /图标待补/);
    await card.update({ ownCount: 2, owned: true, starLevel: 1 });
    assert.equal(card.image(), undefined, '业务状态刷新不能反复试同一张失败图片');
  } finally { card.unmount(); }
});

test('collection card resets failures only for changed resource addresses or collection identity', async () => {
  const card = mountCollectionCard(zeroOwnedItem());
  try {
    await card.fail(card.image());
    assert.equal(card.image(), undefined);
    await card.update({ iconKey: 'icon_collect_5_2', iconRes: 'gui/texture/collectIcon/icon_collect_5_2/spriteFrame' });
    assert.equal(card.image().props.src, '/game-config/deco_icons/icon_collect_5_2.png');
    await card.fail(card.image());
    await card.update({ collectionId: 700002, name: '布丁' });
    assert.equal(card.image().props.src, '/game-config/deco_icons/icon_collect_5_2.png');
    await card.update({ image: '/updated-image.png' });
    assert.equal(card.image().props.src, '/updated-image.png');
  } finally { card.unmount(); }
});

test('collection card extracts official spriteFrame or texture paths without guessing numeric image IDs', () => {
  for (const suffix of ['spriteFrame', 'texture', 'spriteFrame/']) {
    const card = mountCollectionCard(zeroOwnedItem({ iconKey: '', iconRes: `gui/texture/collectIcon/icon_collect_5_1/${suffix}` }));
    try { assert.equal(card.image().props.src, '/game-config/deco_icons/icon_collect_5_1.png'); }
    finally { card.unmount(); }
  }
  for (const patch of [
    { iconKey: '', iconRes: '' },
    { iconKey: '../unknown', iconRes: 'gui/texture/collectIcon/../unknown/spriteFrame' },
    { iconKey: 'icon_collect_5_1.png', iconRes: '' },
    { iconKey: '', iconRes: 'https://untrusted.invalid/icon_collect_5_1/spriteFrame' },
  ]) {
    const card = mountCollectionCard(zeroOwnedItem(patch));
    try { assert.equal(card.image(), undefined); assert.match(card.texts(), /图标待补/); }
    finally { card.unmount(); }
  }
});

// 可选浏览器实证：只服务真实卡片和本地构建图片，绝不加载账号/API/游戏连接。
test('existing Edge decodes all 30 real collection-card images with an empty backend image field', {
  skip: !process.env.FARM_COLLECTION_IMAGE_VERIFY_DIR,
}, async () => {
  const http = require('node:http');
  const { promisify } = require('node:util');
  const { createRequire } = require('node:module');
  const execFile = promisify(require('node:child_process').execFile);
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const compiler = webRequire('vue/compiler-sfc');
  const output = path.resolve(process.env.FARM_COLLECTION_IMAGE_VERIFY_DIR);
  const build = path.resolve(process.env.FARM_COLLECTION_IMAGE_BUILD_DIR);
  const edge = process.env.FARM_EDGE_EXECUTABLE;
  assert.ok(edge && fs.existsSync(edge), '只用现有 Edge，不下载浏览器');
  assert.ok(fs.existsSync(path.dirname(output)) && fs.existsSync(path.join(build, 'index.html')));
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(__dirname, '../../web/src/components/collection/CollectionCard.vue');
  const descriptor = compiler.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const code = ts.transpileModule(compiler.compileScript(descriptor, {
    id: 'collection-image-browser', inlineTemplate: true,
  }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const items = require('../src/gameConfig/ItemInfo.json').filter(item => Number(item.type) === 35)
    .map(item => zeroOwnedItem({ collectionId: item.id, name: item.name, desc: item.desc, rarity: item.rarity,
      rarityColor: item.rarity_color, iconKey: item.icon_res.split('/').at(-2), iconRes: item.icon_res }));
  const css = fs.readdirSync(path.join(build, 'assets')).find(name => /^index-.*\.css$/.test(name));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="/assets/${css}">
<style>:root{--theme-primary:#5e826a}body{margin:0;background:#f8faf7;color:#26392f;font-family:"Microsoft YaHei",sans-serif}main{padding:20px}header{margin-bottom:16px}#cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}</style></head>
<body><main><header>真实 CollectionCard · 30 个空 image / 未获得藏品 · 本地图片加载验证</header><div id="cards"></div><pre id="report" hidden></pre></main>
<script src="/__test-vue.js"></script><script>
let transports=0;const block=()=>{transports++;throw Error('forbidden-account-transport')};window.fetch=block;window.WebSocket=block;window.XMLHttpRequest=block;
const module={exports:{}};const exports=module.exports;const require=name=>{if(name==='vue')return Vue;throw Error('unexpected-component-dependency')};
${code.replaceAll('</script', '<\\/script')}
const items=${JSON.stringify(items)};Vue.createApp({render:()=>Vue.h(Vue.Fragment,null,items.map(item=>Vue.h(module.exports.default,{item,key:item.collectionId})))}).mount('#cards');
(async()=>{await Vue.nextTick();const images=[...document.querySelectorAll('#cards img')];for(const image of images)image.loading='eager';await Promise.all(images.map(image=>image.decode().catch(()=>null)));await Vue.nextTick();const visible=[...document.querySelectorAll('#cards img')];const report={ok:visible.length===30&&visible.every(image=>image.complete&&image.naturalWidth>0&&image.naturalHeight>0)&&transports===0,totalCards:document.querySelectorAll('article').length,decodedImages:visible.filter(image=>image.naturalWidth>0).length,placeholders:document.querySelector('#cards').textContent.includes('图标待补'),transports,rows:visible.map(image=>({name:image.alt,src:image.getAttribute('src'),width:image.naturalWidth,height:image.naturalHeight}))};document.querySelector('#report').textContent=JSON.stringify(report)})();
</script></body></html>`;
  let forbiddenRequests = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1').pathname;
    if (url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (url === '/__test-vue.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fs.readFileSync(webRequire.resolve('vue/dist/vue.global.prod.js'))); return; }
    if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const target = path.resolve(build, `.${decodeURIComponent(url)}`);
    if ((!url.startsWith('/game-config/') && !url.startsWith('/assets/')) || !target.startsWith(`${build}${path.sep}`)
      || !fs.existsSync(target) || !fs.statSync(target).isFile()) { forbiddenRequests++; res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.png') ? 'image/png' : target.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const screenshot = path.join(output, 'collection-images.png');
    const { stdout } = await execFile(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      '--virtual-time-budget=5000', '--force-device-scale-factor=1', '--window-size=1440,1800',
      `--user-data-dir=${path.join(output, 'edge-profile')}`, `--screenshot=${screenshot}`, '--dump-dom',
      `http://127.0.0.1:${server.address().port}/`], { encoding: 'utf8', timeout: 45000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const report = JSON.parse(stdout.match(/<pre id="report" hidden[^>]*>([^<]+)<\/pre>/)?.[1]
      .replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>') || '{}');
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.decodedImages, 30); assert.equal(report.placeholders, false); assert.equal(forbiddenRequests, 0);
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ ...report, forbiddenRequests,
      sourceFile: 'web/src/components/collection/CollectionCard.vue', screenshot }, null, 2) + '\n');
    assert.ok(fs.statSync(screenshot).size > 10000);
    console.log('COLLECTION_BROWSER_VERIFIED', JSON.stringify({ decodedImages: 30, transports: 0, forbiddenRequests, screenshot }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
