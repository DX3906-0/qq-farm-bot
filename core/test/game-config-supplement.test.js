const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  getItemById,
  getItemImageById,
  getAllSeeds,
  getPlantBySeedId,
  getPlantGrowPhases,
} = require('../src/config/gameConfig');

const activityPlants = [
  { asset: 'Crop_9003', seedId: 29003, fruitId: 49003, plantId: 1029003, mutantId: 1049003, name: '星语铃花' },
  { asset: 'Crop_1353', seedId: 21353, fruitId: 41353, plantId: 1021353, mutantId: 1041353, name: '紫薇' },
  { asset: 'Crop_264', seedId: 20264, fruitId: 40264, plantId: 1020264, mutantId: 1040264, name: '帝王血' },
  { asset: 'Crop_1404', seedId: 21404, fruitId: 41404, plantId: 1021404, mutantId: 1041404, name: '月光花' },
  { asset: 'Crop_108', seedId: 20108, fruitId: 40108, plantId: 1020108, mutantId: 1040108, name: '铃兰' },
  { asset: 'Crop_1037', seedId: 21037, fruitId: 41037, plantId: 1021037, mutantId: 1041037, name: '银星海棠' },
  { asset: 'Crop_6032', seedId: 26032, fruitId: 46032, plantId: 1026032, mutantId: 1046032, name: '月见草' },
  { asset: 'Crop_1050', seedId: 21050, fruitId: 41050, plantId: 1021050, mutantId: 1041050, name: '萱草' },
  { asset: 'Crop_1251', seedId: 21251, fruitId: 41251, plantId: 1021251, mutantId: 1041251, name: '紫茉莉' },
  { asset: 'Crop_1380', seedId: 21380, fruitId: 41380, plantId: 1021380, mutantId: 1041380, name: '梧桐' },
  { asset: 'Crop_129', seedId: 20129, fruitId: 40129, plantId: 1020129, mutantId: 1040129, name: '勿忘我' },
  { asset: 'Crop_375', seedId: 20375, fruitId: 40375, plantId: 1020375, mutantId: 1040375, name: '木槿' },
];

function assertImageExists(itemId, label) {
  const imageUrl = getItemImageById(itemId);
  assert.match(imageUrl, /^\/game-config\/seed_images_named\/.+\.png$/, label);
  const relativePath = decodeURIComponent(imageUrl.replace('/game-config/', ''));
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', 'src', 'gameConfig', relativePath)),
    true,
    `${label} file`,
  );
}

test('supplemental source mappings resolve names and official images', () => {
  const expected = new Map([
    // 注：20207/40207（普通绣球花）在 ItemInfo 中自始缺失（HEAD 版本即无），
    // 只有黄金版 1040207 存在，属既有数据缺口，不在本测试断言范围内。
    [20329, '发财红包种子'],
    [40329, '发财红包'],
    [1040265, '黄金·朱雀花'],
    [1041037, '黄金·银星海棠'],
    // 2026-11-02 同步上游：官方重命名了一批花卉装扮
    //   1041050 卷丹百合 → 萱草 / 1046032 金盏花 → 月见草 / 1041353 粉樱花 → 紫薇
    [1041050, '黄金·萱草'],
    [1046032, '黄金·月见草'],
    [1041353, '黄金·紫薇'],
    [1049003, '黄金·星语铃花'],
    [301102, '足球'],
    [204003, '黄金·哈哈南瓜塔'],
    // 2026-11-02 同步上游：官方改名 星语花铃 → 蝶梦星铃（含黄金版）
    [204006, '蝶梦星铃'],
    [204007, '黄金·蝶梦星铃'],
  ]);

  for (const [itemId, name] of expected) {
    assert.equal(getItemById(itemId)?.name, name);
    assert.match(getItemImageById(itemId), /^\/game-config\/seed_images_named\/.+\.png$/);
  }
});

test('star bell flower is configured as a 2x2 crop', () => {
  assert.equal(getPlantBySeedId(29003)?.size, 2);
});

test('bubble cotton candy resolves its official 2x2 plant configuration', () => {
  const plant = getPlantBySeedId(29004);
  assert.equal(plant?.id, 1029004);
  assert.equal(plant?.size, 2);
  assert.equal(plant?.fruit?.id, 49004);
  assert.equal(plant?.fruit?.count, 192);
  assert.equal(plant?.exp, 7680);
  assert.ok(getPlantGrowPhases(plant.id).length > 0);
});

test('charity red flower uses the official single-grid plant configuration', () => {
  const plant = getPlantBySeedId(20883);
  assert.equal(plant?.id, 1020883);
  assert.equal(plant?.fruit?.id, 40883);
  assert.equal(plant?.size, 1);
  assert.equal(plant?.planting_priority, 1000);
  assert.match(plant?.grow_phases || '', /盛开:0/);
});

test('charity flower activity items use official names and static icons', () => {
  assert.equal(getItemById(1040)?.name, '爱心值');
  assert.equal(getItemById(2158)?.name, '小红花做好事头像框');
  assert.equal(getItemById(101604)?.name, '公益小红花结算礼包');
  assert.equal(getItemImageById(101604), '/activity/charity-flower/settlement-pack.png');
  assert.equal(
    fs.existsSync(path.join(__dirname, '..', '..', 'web', 'public', 'activity', 'charity-flower', 'settlement-pack.png')),
    true,
    'charity flower settlement pack image file',
  );
  assertImageExists(20883, 'red flower seed image');
  assertImageExists(40883, 'red flower fruit image');
});

test('seed levels come from seed item configuration', () => {
  const seedLevels = new Map(getAllSeeds().map(seed => [seed.seedId, seed.requiredLevel]));
  assert.equal(seedLevels.get(20003), 2, 'carrot seed level');
  // 2026-11-02 同步上游：勿忘我种子等级由 81 下调为 41（官方 ItemInfo 变更）。
  assert.equal(seedLevels.get(20129), 41, 'forget-me-not seed level');
  // 26032 等新作物种子原先在 ItemInfo 里缺失，只能回落到 land_level_need(=1)；
  // 补齐后按官方 item.level 取值（与勿忘我 / 月见草同一口径）。
  assert.equal(seedLevels.get(26032), 21, 'evening primrose seed level');
  // 2026-11-02 同步上游：哈哈南瓜种子等级由 1 调整为 200（官方 ItemInfo 变更）。
  assert.equal(seedLevels.get(20416), 200, 'haha pumpkin seed level');
});

test('qixi activity items resolve official static icons', () => {
  const expected = new Map([
    [1024, '/activity/qixi/qixi-feather.png'],
    [301103, '/activity/qixi/qixi-dew.png'],
  ]);

  for (const [itemId, imageUrl] of expected) {
    assert.equal(getItemImageById(itemId), imageUrl);
    assert.equal(
      fs.existsSync(path.join(__dirname, '..', '..', 'web', 'public', imageUrl)),
      true,
      `${getItemById(itemId)?.name} image file`,
    );
  }
});

test('rain poem activity items resolve official names and static icons', () => {
  const expected = new Map([
    [1027, ['雷电徽章', '/activity/rain-poem/lightning-badge.svg']],
    [4002, ['闪电感应', '/activity/rain-poem/lightning-sense.png?v=2']],
    [4003, ['闪电感应', '/activity/rain-poem/lightning-sense.png?v=2']],
    [5001, ['天气采集瓶', '/activity/rain-poem/weather-collection-bottle.png']],
    [5002, ['雷雨召唤瓶', '/activity/rain-poem/rainstorm-summon-bottle.png']],
    [5005, ['青蛙使坏瓶', '/activity/rain-poem/frog-prank-bottle.png']],
    [5006, ['乌云使坏瓶', '/activity/rain-poem/cloud-prank-bottle.png']],
    [2159, ['雨落成诗头像框', '/activity/rain-poem/avatar-frame.png?v=2']],
    [100003, ['化肥礼包', '/game-config/seed_images_named/100003_pack_03.png']],
  ]);

  for (const [itemId, [name, imageUrl]] of expected) {
    assert.equal(getItemById(itemId)?.name, name);
    assert.equal(getItemImageById(itemId), imageUrl);
    const imagePath = imageUrl.split('?', 1)[0];
    const publicPath = imagePath.startsWith('/activity/')
      ? path.join(__dirname, '..', '..', 'web', 'public', imagePath)
      : path.join(__dirname, '..', 'src', 'gameConfig', imageUrl.replace('/game-config/', ''));
    assert.equal(fs.existsSync(publicPath), true, `${name} image file`);
  }
});

test('recent bag items resolve official names and icons', () => {
  const expected = new Map([
    [1026, '鹊羽香囊'],
    [101304, '千星游记礼包'],
  ]);

  for (const [itemId, name] of expected) {
    assert.equal(getItemById(itemId)?.name, name);
    assertImageExists(itemId, `${name} image`);
  }
});

test('activity supplements preserve growth phases from the base plant config', () => {
  const baseBackedActivitySeeds = [
    21353, 20264, 21404, 20108, 21050, 21251, 21380, 20129, 20375, 20329
  ];
  for (const seedId of baseBackedActivitySeeds) {
    const plant = getPlantBySeedId(seedId);
    assert.ok(getPlantGrowPhases(plant.id).length > 0, `${plant.name} growth phases`);
  }
});

test('decoration fruits in the mutant illustrated have complete images', () => {
  assertImageExists(204003, 'golden pumpkin tower image');
  assertImageExists(204004, 'moon lotus tower image');
  assertImageExists(204005, 'golden moon lotus tower image');
  assertImageExists(204006, 'star bell tower image');
  assertImageExists(204007, 'golden star bell tower image');
});

test('current activity plants cover crop and mutant illustrated mappings', () => {
  for (const plant of activityPlants) {
    const seed = getItemById(plant.seedId);
    const fruit = getItemById(plant.fruitId);
    const plantConfig = getPlantBySeedId(plant.seedId);

    assert.equal(seed?.name, `${plant.name}种子`, `${plant.asset} seed name`);
    assert.equal(seed?.asset_name, plant.asset, `${plant.asset} seed asset`);
    assert.equal(fruit?.name, plant.name, `${plant.asset} fruit name`);
    assert.equal(fruit?.asset_name, plant.asset, `${plant.asset} fruit asset`);
    assert.equal(plantConfig?.id, plant.plantId, `${plant.asset} plant mapping`);
    assert.equal(plantConfig?.fruit?.id, plant.fruitId, `${plant.asset} fruit mapping`);
    assertImageExists(plant.seedId, `${plant.asset} seed image`);
    assertImageExists(plant.fruitId, `${plant.asset} fruit image`);
    assertImageExists(plant.mutantId, `${plant.asset} mutant image`);
  }
});

// Artwork completion is local-only. Test actual files in BOTH static roots,
// not an OR-exists check that can hide a Vite public-resource omission.
function dualRootImage(url) {
  const pathname = decodeURIComponent(String(url).split('?')[0]);
  assert.match(pathname, /^\/game-config\//);
  const relative = pathname.slice('/game-config/'.length);
  const coreFile = path.join(__dirname, '../src/gameConfig', relative);
  const webFile = path.join(__dirname, '../../web/public/game-config', relative);
  const coreBytes = fs.readFileSync(coreFile);
  const webBytes = fs.readFileSync(webFile);
  assert.equal(coreBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(webBytes, coreBytes, relative);
}

test('artwork completion: all 30 collection icons resolve intact dual-root PNGs', () => {
  const items = require('../src/gameConfig/ItemInfo.json').filter(item => item.type === 35);
  assert.equal(items.length, 30);
  for (const item of items) {
    const image = getItemImageById(item.id);
    assert.match(image, /^\/game-config\/deco_icons\/icon_collect_[1-5]_[1-6]\.png$/);
    dualRootImage(image);
  }
});

test('artwork completion: ranch animals, products and consumables have distinct evidenced icons', () => {
  for (const id of [1102, 7001, 7002, 60001, 60002, 70001, 70012, 80021, 80024, 80031, 80034, 1060001, 1070002, 2060001, 2070002]) {
    dualRootImage(getItemImageById(id));
  }
  assert.notEqual(getItemImageById(60001), getItemImageById(1060001));
  assert.notEqual(getItemImageById(80021), getItemImageById(80031));
});

test('artwork completion: new high-level flowers resolve without changing plant data', () => {
  for (const id of [20374, 20381, 20397, 20398, 20399, 20457, 20530, 21080, 21082, 21084, 21096, 21097, 21099, 21100, 21111]) {
    dualRootImage(getItemImageById(id));
  }
  for (const id of [1040530, 1041435, 1042254]) dualRootImage(getItemImageById(id));
});

test('artwork completion: item metadata remains authoritative and origin grades are explicit', () => {
  const crypto = require('node:crypto');
  const index = require('../src/gameConfig/art-resource-sources.json');
  assert.equal(index.localOnly, true);
  assert.equal(index.gameRpcSent, false);
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../src/gameConfig/art-resource-sources.json')),
    fs.readFileSync(path.join(__dirname, '../../web/public/game-config/art-resource-sources.json')));
  for (const [relative, source] of Object.entries(index.items)) {
    const raw = fs.readFileSync(path.join(__dirname, '../src/gameConfig', relative));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), source.sha256, relative);
    dualRootImage(`/game-config/${relative}`);
    if (source.kind === 'github-client-resource-snapshot') {
      assert.equal(source.officialOriginVerified, false);
      const approved = new Set([
        'Xb-Fishing/qq-farm-evolution@282f6c2d209c6864b5e92fc89bb920c00c1314fb',
        'chengleier/qq-farm-bot@5e7c027115ede6fc835bb69d7ad9a081a84c4133',
      ]);
      assert.ok(approved.has(`${source.repository}@${source.commit}`), relative);
      assert.match(source.gitBlob, /^[a-f0-9]{40}$/);
      assert.equal(crypto.createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex'), source.gitBlob);
      assert.equal(source.sourceUrl, `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`);
    }
    if (source.officialOriginVerified) {
      assert.match(source.manifest.url, /^https:\/\/cdn-resource\.nqf\.qq\.com\/release\/remote\//);
      assert.match(source.manifest.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test('artwork completion: catalysts, reshapers, display stands and tea coupons use exact item resource names', () => {
  for (const id of [5011, 5012, 5013, 5014, 5015, 5016, 5017, 5018,
    610100, 610201, 610202, 610203, 610204, 610205, 610206, 610301, 610302, 610303, 101404, 101405]) {
    const icon = getItemById(id).icon_res.replace(/\/(?:spriteFrame|texture)$/, '').split('/').at(-1);
    assert.equal(getItemImageById(id), `/game-config/deco_icons/${icon}.png`);
    dualRootImage(getItemImageById(id));
  }
});

test('artwork completion: frontend numeric aliases preserve the backend canonical image URLs', () => {
  const crypto = require('node:crypto');
  const index = require('../src/gameConfig/art-resource-sources.json');
  for (const [id, alias] of Object.entries(index.webNumericAliases)) {
    assert.equal(alias.deploymentAliasOnly, true);
    const relative = decodeURIComponent(alias.url.replace('/game-config/', ''));
    const raw = fs.readFileSync(path.join(__dirname, '../../web/public/game-config', relative));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), alias.sha256, id);
    assert.equal(getItemImageById(id), alias.sourceUrl, id);
    assert.equal(fs.existsSync(path.join(__dirname, '../src/gameConfig', relative)), false, id);
  }
});

test('artwork completion: the real frontend catalog bundles eligible collection images without sessions', () => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const web = path.resolve(__dirname, '../../web');
  const ts = createRequire(path.join(web, 'package.json'))('typescript');
  const config = fs.readFileSync(path.join(web, 'vite.config.ts'), 'utf8');
  const start = config.indexOf('function bundledMutationCatalog()');
  const end = config.indexOf('const mutationBundle = bundledMutationCatalog()');
  assert.ok(start > 0 && end > start);
  const js = ts.transpileModule(config.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = {
    exports: {},
    buildMutationCatalog: require('../src/services/mutation-catalog-data').buildMutationCatalog,
    createHash: require('node:crypto').createHash, URL,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync,
  };
  const base = require('node:url').pathToFileURL(path.join(web, 'vite.config.ts')).href;
  const catalog = vm.runInNewContext(
    `${js.replaceAll('import.meta.url', JSON.stringify(base))}\nbundledMutationCatalog()`, context,
  );
  const entries = catalog.collections.flatMap(series => series.items);
  // display=true 的果冻花园不在种植产出宝典内，补图不能改变其业务展示条件。
  const expectedIds = require('../src/gameConfig/collections/CollectionItem.json')
    .filter(item => item.series_id !== 2002).map(item => Number(item.item_id)).sort((a, b) => a - b);
  assert.equal(entries.length, 24);
  assert.deepEqual(Array.from(entries, item => Number(item.id)).sort((a, b) => a - b), expectedIds);
  for (const item of entries) {
    assert.equal(item.image, getItemImageById(item.id));
    dualRootImage(item.image);
  }
});
