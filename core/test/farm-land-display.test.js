const test = require('node:test');
const assert = require('node:assert/strict');
const { getAllPlants } = require('../src/config/gameConfig');

const {
  buildLandMap,
  getDisplayLandContext,
  getCurrentPhase,
  analyzeLands,
  prioritizeBlueCrystalUpgrades
} = require('../src/services/farm-land-analyzer');

test('real pea suffix resolves phase_id 20 to the fifth configured stage', () => {
  const current = getCurrentPhase([
    { phase: 2, phase_id: 20, begin_time: 1785758321 },
    { phase: 6, phase_id: 19, begin_time: 1785764081 }
  ], false, '', 1020008);
  assert.equal(current.server_phase, 2);
  assert.equal(current.phase_record_id, 20);
  assert.equal(current.phase_index, 4);
  assert.equal(current.image_phase, 5);
  assert.equal(current.phaseName, '初熟');
});

test('real star bell suffix uses the first remaining record as current', () => {
  const current = getCurrentPhase([
    { phase: 2, phase_id: 8, begin_time: 1785752268 },
    { phase: 2, phase_id: 12, begin_time: 1785760908 },
    { phase: 2, phase_id: 10, begin_time: 1785769548 },
    { phase: 6, phase_id: 19, begin_time: 1785778188 }
  ], false, '', 1029003);
  assert.equal(current.server_phase, 2);
  assert.equal(current.phase_record_id, 8);
  assert.equal(current.phase_index, 2);
  assert.equal(current.image_phase, 3);
  assert.equal(current.phaseName, '小叶子');
});

test('a mature suffix with one remaining record resolves the final configured stage', () => {
  const current = getCurrentPhase([
    { phase: 6, phase_id: 19, begin_time: 1785764081 }
  ], false, '', 1020008);
  assert.equal(current.server_phase, 6);
  assert.equal(current.phase_index, 5);
  assert.equal(current.image_phase, 6);
  assert.equal(current.phaseName, '成熟');
});

test('blue-crystal priority never waits: purple-only candidates keep their original order', () => {
  const lands = [
    { id: 4, unlocked: true, level: 4, could_upgrade: true },
    { id: 2, unlocked: true, level: 3, could_upgrade: true },
    { id: 7, unlocked: true, level: 4, could_upgrade: true },
  ];
  assert.deepEqual(prioritizeBlueCrystalUpgrades([4, 2, 7], lands), [4, 2, 7]);
  assert.deepEqual(analyzeLands(lands).upgradable, [4, 2, 7]);
});

test('blue-crystal priority only reorders server-approved level-5 candidates ahead of other upgrades', () => {
  const lands = [
    { id: 4, unlocked: true, level: 4, could_upgrade: true },
    { id: 8, unlocked: true, level: 5, could_upgrade: true },
    { id: 2, unlocked: true, level: 5, could_upgrade: false },
    { id: 7, unlocked: true, level: 3, could_upgrade: true },
  ];
  // id=2 虽是 5 级，但服务端未允许，绝不能被加入候选。
  assert.deepEqual(analyzeLands(lands).upgradable, [8, 4, 7]);
});

test('morning glory final 盛开 stage is normalized to harvestable maturity', () => {
  const phases = [
    { phase: 2, phase_id: 19, begin_time: 1 }
  ];
  const current = getCurrentPhase(phases, false, '', 1020147);

  assert.equal(current.server_phase, 2);
  assert.equal(current.phase, 6);
  assert.equal(current.phase_index, 5);
  assert.equal(current.phaseName, '盛开');

  const analysis = analyzeLands([{
    id: 9,
    unlocked: true,
    plant: { id: 1020147, name: '牵牛花', phases }
  }]);
  assert.deepEqual(analysis.harvestable, [9]);
  assert.deepEqual(analysis.growing, []);
});

test('final configured stage remains harvestable when detailed phase id is encoded in phase', () => {
  const current = getCurrentPhase([
    { phase: 19, begin_time: 1 }
  ], false, '', 1020147);

  assert.equal(current.server_phase, 19);
  assert.equal(current.phase, 6);
  assert.equal(current.phaseName, '盛开');
});

test('a new activity plant without static growth config still uses protocol maturity', () => {
  const phases = [{ phase: 6, phase_id: 19, begin_time: 1 }];
  const current = getCurrentPhase(phases, false, '', 1060032);

  assert.equal(current.phase, 6);
  assert.equal(current.phaseName, '成熟');
  assert.deepEqual(analyzeLands([{
    id: 10,
    unlocked: true,
    plant: { id: 1060032, name: '金盏花', phases }
  }]).harvestable, [10]);
});

test('every configured plant recognizes all observed mature protocol variants', () => {
  const matureVariants = [
    [{ phase: 6, phase_id: 19, begin_time: 1 }],
    [{ phase: 2, phase_id: 19, begin_time: 1 }],
    [{ phase: 19, begin_time: 1 }]
  ];

  for (const plant of getAllPlants()) {
    for (const phases of matureVariants) {
      assert.equal(
        getCurrentPhase(phases, false, '', plant.id)?.phase,
        6,
        `${plant.name} (${plant.id}) mature variant ${JSON.stringify(phases[0])}`
      );
    }
  }
});

test('2x2 plant display context merges slave lands into the master land', () => {
  const plant = { id: 1001, phases: [{ phase: 1, begin_time: 1 }] };
  const lands = [
    { id: 1, plant, slave_land_ids: [2, 3, 4] },
    { id: 2, master_land_id: 1 },
    { id: 3, master_land_id: 1 },
    { id: 4, master_land_id: 1 }
  ];
  const landMap = buildLandMap(lands);

  const master = getDisplayLandContext(lands[0], landMap);
  assert.equal(master.occupiedByMaster, false);
  assert.equal(master.masterLandId, 1);
  assert.deepEqual(master.occupiedLandIds, [1, 2, 3, 4]);

  for (const slaveLand of lands.slice(1)) {
    const slave = getDisplayLandContext(slaveLand, landMap);
    assert.equal(slave.occupiedByMaster, true);
    assert.equal(slave.masterLandId, 1);
    assert.equal(slave.sourceLand, lands[0]);
    assert.deepEqual(slave.occupiedLandIds, [1, 2, 3, 4]);
  }
});

test('2x2 protocol master keeps all four occupied ids regardless of slave order', () => {
  const plant = { id: 1001, phases: [{ phase: 1, begin_time: 1 }] };
  const lands = [
    { id: 1, master_land_id: 5 },
    { id: 2, master_land_id: 5 },
    { id: 5, plant, slave_land_ids: [6, 1, 2] },
    { id: 6, master_land_id: 5 }
  ];
  const landMap = buildLandMap(lands);
  const master = getDisplayLandContext(lands[2], landMap);

  assert.equal(master.masterLandId, 5);
  assert.deepEqual(master.occupiedLandIds, [5, 6, 1, 2]);
});

test('slave lands are found from the master slave list when master_land_id is absent', () => {
  const plant = { id: 1029003, phases: [{ phase: 1, begin_time: 1 }] };
  const lands = [
    { id: 5, plant, slave_land_ids: [7, 13, 14] },
    { id: 7, plant },
    { id: 13, plant },
    { id: 14, plant }
  ];
  const landMap = buildLandMap(lands);

  for (const slaveLand of lands.slice(1)) {
    const context = getDisplayLandContext(slaveLand, landMap);
    assert.equal(context.occupiedByMaster, true);
    assert.equal(context.masterLandId, 5);
    assert.equal(context.sourceLand, lands[0]);
    assert.deepEqual(context.occupiedLandIds, [5, 7, 13, 14]);
  }
});

test('single-grid plant keeps only its own land id', () => {
  const land = {
    id: 8,
    plant: { id: 1002, phases: [{ phase: 1, begin_time: 1 }] }
  };
  const context = getDisplayLandContext(land, buildLandMap([land]));

  assert.equal(context.occupiedByMaster, false);
  assert.deepEqual(context.occupiedLandIds, [8]);
});

test('mutation icons normalize the official spriteFrame path instead of appending it to a PNG path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('../../web/node_modules/typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/components/LandCard.vue'), 'utf8');
  const start = source.indexOf('function normalizeMutantIcon(');
  const end = source.indexOf('\nconst hasGoldenMutation', start);
  assert.ok(start > 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const effects = require('../src/config/gameConfig').getAllMutantEffects();
  const h = vm.runInNewContext(`${code}\n({ normalizeMutantIcon, mutantEffects })`, {
    land: { value: { mutantEffects: effects } }, computed: fn => ({ get value() { return fn(); } }), ref: value => ({ value }),
  });
  assert.equal(h.normalizeMutantIcon('gui/texture/mutant/icon/bichon/spriteFrame'), 'bichon');
  assert.equal(h.normalizeMutantIcon('BICHON'), 'bichon');
  for (const bad of ['../../bichon', 'https://example.test/x', 'gui/texture/mutant/icon/../spriteFrame', '<script>', '']) {
    assert.equal(h.normalizeMutantIcon(bad), '');
  }
  const bichon = h.mutantEffects.value.find(effect => effect.id === 15);
  assert.equal(bichon.image, '/game-config/seed_images_named/mutant/bichon.png');
  assert.equal(h.mutantEffects.value.find(effect => effect.id === 17).image, '/game-config/seed_images_named/mutant/naicha.png');
  for (const effect of h.mutantEffects.value) {
    assert.ok(!effect.image.includes('spriteFrame') && !effect.image.includes('mutant/gui/'));
    if (effect.image.startsWith('/game-config/')) {
      assert.ok(fs.existsSync(path.join(__dirname, '../src/gameConfig', effect.image.slice('/game-config/'.length))), effect.image);
    }
  }
  assert.ok(source.includes('@error="failedMutantImages[effect.image] = true"'));
  assert.ok(source.includes('!failedMutantImages[effect.image]'));
});

function createFarmPanelHarness() {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const ts = webRequire('typescript');
  const vue = webRequire('vue');
  const compiler = webRequire('vue/compiler-sfc');
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/components/FarmPanel.vue'), 'utf8');
  const descriptor = compiler.parse(source).descriptor;
  const script = compiler.compileScript(descriptor, { id: 'farm-test' }).content;
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const account = { currentAccountId: vue.ref('a'), currentAccount: vue.ref({ running: true }) };
  const pending = [];
  const calls = [];
  const status = {
    status: vue.ref({}), loading: vue.ref(false), realtimeConnected: vue.ref(false), currentStatusReady: vue.ref(false),
    fetchStatus: id => new Promise(resolve => { calls.push(['status', id]); pending.push(resolve); }),
    clearAccountScopedData() {},
  };
  const farm = {
    lands: vue.ref([]), summary: vue.ref({}), weather: vue.ref(null), loading: vue.ref(false), unifiedHarvest: vue.ref(false),
    clearFarmData() {},
    fetchLands: (id, signal) => new Promise(resolve => { calls.push(['lands', id, signal]); pending.push(resolve); }),
    fetchUnifiedHarvest: async id => { calls.push(['unified', id]); },
  };
  const hooks = { mounted: [], unmounted: [], dispose: [] };
  let timer;
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, AbortController, document,
    window: { innerWidth: 1200, innerHeight: 900, scrollY: 0, addEventListener() {}, removeEventListener() {} },
    require(id) {
      if (id === 'vue') return { ...vue, onMounted: fn => hooks.mounted.push(fn), onUnmounted: fn => hooks.unmounted.push(fn), onScopeDispose: fn => hooks.dispose.push(fn) };
      if (id === 'pinia') return { storeToRefs: obj => obj };
      if (id === '@vueuse/core') return { useIntervalFn: fn => { timer = fn; return { pause() {}, resume() {} }; } };
      if (id === '@/stores/account') return { useAccountStore: () => account };
      if (id === '@/stores/status') return { useStatusStore: () => status };
      if (id === '@/stores/farm') return { useFarmStore: () => farm };
      if (id === '@/stores/toast') return { useToastStore: () => ({}) };
      if (id === '@/api') return { isReadCanceled: e => e?.code === 'ERR_CANCELED' };
      if (id.endsWith('.vue')) return {};
      throw new Error(`未模拟依赖 ${id}`);
    },
  });
  const scope = vue.effectScope();
  const exposed = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { account, pending, calls, document, exposed, timer: () => timer(), stop() { hooks.dispose.forEach(fn => fn()); hooks.unmounted.forEach(fn => fn()); scope.stop(); } };
}

const drainFarm = () => new Promise(resolve => setImmediate(resolve));
test('FarmPanel 重复刷新 singleflight，卸载 status await 后不再拉土地', async () => {
  const h = createFarmPanelHarness();
  assert.equal(h.calls.length, 1);
  const again = h.exposed.refresh();
  assert.equal(h.calls.length, 1);
  h.stop();
  h.pending.shift()(); await again;
  assert.deepEqual(h.calls.map(call => call[0]), ['status']);
});
test('FarmPanel 换号不拉旧 land/unified，hidden 时 timer 不产生网络', async () => {
  const h = createFarmPanelHarness();
  const old = h.pending.shift();
  h.account.currentAccountId.value = 'b';
  assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [['status', 'a']]);
  old(); await drainFarm();
  assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [['status', 'a'], ['status', 'b']]);
  assert.equal(h.calls.filter(call => call[0] === 'lands').length, 0);
  h.pending.shift()(); await drainFarm();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['lands', 'b']);
  h.stop(); h.pending.shift()(); await drainFarm();
  assert.equal(h.calls.filter(call => call[0] === 'unified').length, 0);
  h.document.hidden = true; h.timer(); await drainFarm();
  assert.equal(h.calls.length, 3);
});
test('FarmPanel 百次换号仅一进行加一待刷新，卸载消除待刷新', async () => {
  const h = createFarmPanelHarness();
  for (let i = 0; i < 100; i++) h.account.currentAccountId.value = `account-${i}`;
  assert.equal(h.calls.length, 1);
  h.pending.shift()(); await drainFarm();
  assert.deepEqual(h.calls.at(-1).slice(0, 2), ['status', 'account-99']);
  assert.equal(h.calls.length, 2);
  h.account.currentAccountId.value = 'last'; h.stop(); h.pending.shift()(); await drainFarm();
  assert.equal(h.calls.length, 2);
});
test('FarmPanel 成功读取仍保留土地/天气/合并显示与 60 秒网络刷新', async () => {
  const h = createFarmPanelHarness();
  h.pending.shift()(); await drainFarm();
  h.pending.shift()(); await drainFarm();
  assert.deepEqual(h.calls.map(call => call[0]), ['status', 'lands', 'unified']);
  h.timer(); await drainFarm();
  assert.equal(h.calls.at(-1)[0], 'status');
  h.stop(); h.pending.shift()(); await drainFarm();
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../web/src/components/FarmPanel.vue'), 'utf8');
  for (const marker of ['!land?.occupiedByMaster', ':land="land"', 'weather?.rainstorm', ':style="getIsometricStyle(land)"', 'LandDetailModal']) assert.ok(source.includes(marker), marker);
});

function farmPanelDescriptor() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
  const compiler = webRequire('vue/compiler-sfc');
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/components/FarmPanel.vue'), 'utf8');
  const parsed = compiler.parse(source);
  assert.deepEqual(parsed.errors, []);
  return { source, descriptor: parsed.descriptor, compiler };
}

test('FarmPanel 土地画布使用容器内容宽度，桌面不因剩余屏高或页面位置缩小', () => {
  const { descriptor } = farmPanelDescriptor();
  const css = descriptor.styles.map(style => style.content).join('\n');
  const viewport = css.match(/\.farm-land-viewport\s*\{([^}]+)\}/)?.[1]?.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(viewport);
  assert.match(viewport, /(?:^|;)\s*width:\s*100%;/);
  assert.match(viewport, /(?:^|;)\s*max-width:\s*1200px;/);
  assert.match(viewport, /margin-inline:\s*auto;/);
  // CSS percentages use the padded parent's content box, unlike clientWidth.
  assert.doesNotMatch(descriptor.scriptSetup.content, /farmStageWidth|farmStageStyle|updateFarmStageSize|window\.(?:innerHeight|scrollY)|getBoundingClientRect/);
  const viewportTag = descriptor.template.content.match(/<div[^>]*class="farm-land-viewport[^>]*>/)?.[0];
  assert.ok(viewportTag);
  assert.doesNotMatch(viewportTag, /:style=/);
});

test('FarmPanel 放大后保留原画布比例、窄屏裁切、四格坐标与独立详情交互', () => {
  const { descriptor, compiler } = farmPanelDescriptor();
  const css = descriptor.styles.map(style => style.content).join('\n');
  const result = compiler.compileStyle({ source: css, id: 'farm-size-test', scoped: true });
  assert.deepEqual(result.errors, []);
  const stage = css.match(/\.iso-farm-stage\s*\{([^}]+)\}/)?.[1];
  assert.match(stage, /width:\s*100%;/);
  assert.match(stage, /aspect-ratio:\s*1200\s*\/\s*650;/);
  const viewport = css.match(/\.farm-land-viewport\s*\{([^}]+)\}/)?.[1];
  assert.match(viewport, /overflow:\s*hidden;/);
  assert.doesNotMatch(viewport, /min-width:|(?:^|;)\s*(?:height|max-height):|transform:/);
  assert.match(descriptor.scriptSetup.content, /const FARM_CANVAS_WIDTH = 1200/);
  assert.match(descriptor.scriptSetup.content, /const FARM_CANVAS_HEIGHT = 650/);
  for (const marker of [':width="FARM_CANVAS_WIDTH"', ':height="FARM_CANVAS_HEIGHT"', ':style="getIsometricStyle(land)"', '@details="openLandDetail"', 'LandDetailModal']) {
    assert.ok(descriptor.template.content.includes(marker), marker);
  }
});

test('FarmPanel 操作和统计在卡片内由同一吸顶栏承载，事件仍由原农场所有者处理', () => {
  const { descriptor } = farmPanelDescriptor();
  const template = descriptor.template.content;
  const toolbar = template.match(/<FarmToolbar[\s\S]*?\/>/)?.[0];
  assert.ok(toolbar, '标题、七个按钮和统计应为同一个滚动单元');
  assert.equal((template.match(/<FarmToolbar\b/g) || []).length, 1);
  for (const binding of [':operating="operating"', ':unified-harvest="unifiedHarvest"', ':summary="summary"',
    '@operate="handleOperate"', '@remove-all="handleRemoveAllPlants"', '@unified-harvest="handleUnifiedHarvest"']) {
    assert.ok(toolbar.includes(binding), binding);
  }
  assert.ok(template.indexOf('<FarmToolbar') < template.indexOf('class="farm-land-viewport'));
  assert.doesNotMatch(descriptor.scriptSetup.content, /addEventListener\('(?:scroll|wheel)'|scrollY|getBoundingClientRect/);
  assert.match(descriptor.scriptSetup.content, /opType === 'all' \|\| opType === 'harvest'/);
});

test('FarmToolbar 原生吸顶、主题背景及弹层层级正确，不持有业务请求或复制状态', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { compiler } = farmPanelDescriptor();
  const file = path.join(__dirname, '../../web/src/components/FarmToolbar.vue');
  const source = fs.readFileSync(file, 'utf8');
  const parsed = compiler.parse(source, { filename: file });
  assert.deepEqual(parsed.errors, []);
  compiler.compileScript(parsed.descriptor, { id: 'farm-toolbar-test', inlineTemplate: true });
  const css = parsed.descriptor.styles.map(style => style.content).join('\n');
  const sticky = css.match(/\.farm-toolbar\s*\{([^}]+)\}/)?.[1];
  assert.match(sticky, /position:\s*sticky;/);
  assert.match(sticky, /top:\s*0;/);
  assert.match(sticky, /z-index:\s*20;/);
  assert.match(sticky, /background:\s*var\(--surface-1/);
  assert.doesNotMatch(sticky, /position:\s*fixed|transform:|height:|overflow:\s*hidden/);
  assert.doesNotMatch(parsed.descriptor.scriptSetup.content, /(?:stores\/|@\/api|fetch\(|XMLHttpRequest|WebSocket|localStorage|setInterval|addEventListener)/);
  for (const label of ['土地详情', '收获', '一键务农', '种植', '升级土地', '一键全收', '一键铲除', '统一时间收获', '可收:', '生长:', '空闲:', '枯萎:']) {
    assert.ok(source.includes(label), label);
  }
  const style = compiler.compileStyle({ source: css, id: 'farm-toolbar-test', scoped: true });
  assert.deepEqual(style.errors, []);
});
