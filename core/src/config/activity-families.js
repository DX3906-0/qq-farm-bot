/**
 * 活动族谱（Activity Family Registry）—— 活动适配的单一事实来源
 *
 * 为什么需要这张表
 * ----------------
 * 历年活动高度模板化：官方会把同一套玩法骨架换个 ID、换套文案、换套 UI 皮再上架。
 * 实测证据：
 *   - 「荷风游记」与「千星游记」在本地代码里**共用同一个 HeluPassportPanel 组件**
 *     和同一套 getSeasonPassport() 实现，只靠 title / uid 区分；
 *   - 「荷风十里蝉初鸣」(2026060100) 与「心许千灯星垂野」(2026072700) 共用
 *     兑换商店（exchange_shop=102）与节令小札两套面板；
 *   - 「奶茶热销中」的兑换商店与荷风/星垂同走 102 字段号，仅字段形状不同。
 *
 * 因此**不该为新活动新增一套并行实现**，而应「照族换皮」：改 ID、改 uid、改文案、
 * 换 UI 皮，复用族内既有骨架。本表把这种隐性约定显性化，用于：
 *   1. 发现新活动时自动判断它属于哪一族、最接近哪个既有活动 → 推送给人的是
 *      「这是 X 族，照 Y 改」而不是干巴巴一个 ID；
 *   2. 适配时按族取「槽位 → proto 字段号 → 复用组件」清单，不必翻代码考古。
 *
 * 维护约定
 * --------
 * - 新增活动适配完成后，**必须把它的 ID/uid/标题登记进对应族的 members**，
 *   否则活动发现层会把它一直当作「未知新活动」重复推送。
 * - 新增一族时，slots 里只写该族真实共用的槽位；槽位定义见 ACTIVITY_SLOT_DEFS。
 */

// 槽位定义：活动骨架的最小可复用单位。
// field = ActivityNode 里的 protobuf 字段号（0 表示不在 ActivityNode 下发，走独立 RPC）。
const ACTIVITY_SLOT_DEFS = {
  randomShop: { field: 101, label: '随机商店', panel: 'NanguaShopPanel' },
  exchangeShop: { field: 102, label: '兑换商店', panel: 'HeluExchangePanel' },
  draw: { field: 105, label: '抽奖', panel: 'HeluDrawPanel' },
  starRecord: { field: 110, label: '收集图鉴', panel: 'StarRecordPanel' },
  qixiBridge: { field: 112, label: '鹊桥搭建', panel: 'QixiActivityPanel' },
  qixiGift: { field: 113, label: '鹊桥赠礼', panel: 'QixiActivityPanel' },
  petDiary: { field: 115, label: '萌宠养成', panel: 'PetDiaryActivityPanel' },
  weatherTasks: { field: 117, label: '天气任务', panel: 'RainPoemActivityPanel' },
  weatherResearch: { field: 118, label: '天气研究', panel: 'RainPoemActivityPanel' },
  wishSign: { field: 119, label: '祈愿签到', panel: 'WishSignActivityPanel' },
  shareReward: { field: 120, label: '分享奖励', panel: 'ShareRewardActivityPanel' },
  milkTea: { field: 121, label: '店铺经营', panel: 'MilkTeaActivityPanel' },
  growthFund: { field: 122, label: '成长基金', panel: 'MilkTeaActivityPanel' },
  // 以下槽位不在 ActivityNode 下发，走独立 RPC（字段号 0）。
  journey: { field: 0, label: '游记/通行证', panel: 'HeluPassportPanel', rpc: 'SeasonService' },
  notes: { field: 0, label: '节令小札', panel: 'HeluSolarTermsPanel', rpc: 'SolarTerms' },
  qingmei: { field: 0, label: '酿造经营', panel: 'QingmeiActivityPanel', rpc: 'QingmeiActivity' },
};

// 族定义。members 里登记该族历次上线过的活动（换皮前后都保留，便于比对）。
const ACTIVITY_FAMILIES = [
  {
    key: 'helu-star',
    name: '抽奖 · 商店 · 游记 · 小札',
    note: '官方复刻频率最高的一族：主活动挂子活动树，含抽奖 + 兑换商店 + 游记(通行证) + 节令小札。',
    slots: ['draw', 'exchangeShop', 'journey', 'notes', 'starRecord'],
    // 子活动槽位映射：子活动 ID → 族内槽位 key（供 getSubActivityKey 使用）
    // 荷风与千星共用此表，换皮时只需在此登记新 ID，不必改 activity.js。
    subActivitySlots: {
      2026060101: 'draw',
      2026060102: 'exchangeShop',
      2026060103: 'journey',
      2026060104: 'notes',
      2026072701: 'starRecord',
      2026072702: 'exchangeShop',
    },
    // 子活动标题关键词 → 槽位 key（ID 变动时的兜底识别）
    subActivityTitleSlots: [
      { re: '奇遇礼莲', slot: 'draw' },
      { re: '荷露商店', slot: 'exchangeShop' },
      { re: '荷风游记', slot: 'journey' },
      { re: '节令小札', slot: 'notes' },
      { re: '观星礼录', slot: 'starRecord' },
      { re: '星砂', slot: 'exchangeShop' },
    ],
    members: [
      {
        key: 'helu',
        activityId: 2026060100,
        uid: 'SAIJI',
        title: '荷风十里蝉初鸣',
        subActivities: [2026060101, 2026060102, 2026060103, 2026060104],
      },
      {
        key: 'star',
        activityId: 2026072700,
        uid: 'SAIJI_MEGA_EVENT',
        title: '心许千灯星垂野',
        subActivities: [2026072701, 2026072702],
      },
    ],
    guide: '照最近成员的子活动树改 ID/uid/标题；抽奖复用 HeluDrawPanel、商店复用 HeluExchangePanel、'
      + '游记复用 HeluPassportPanel、小札复用 HeluSolarTermsPanel。',
  },
  {
    key: 'qixi',
    name: '鹊桥寄情',
    note: '独立主活动 + 鹊桥搭建 + 赠礼，含农田露水/金植物的地块交互。',
    slots: ['qixiBridge', 'qixiGift'],
    members: [
      {
        key: 'qixi',
        activityId: 2026081800,
        uid: 'QiXiActivity',
        title: '鹊桥寄情',
        subActivities: [2026081801, 2026081802],
      },
    ],
    guide: '复用 QixiActivityPanel；注意 112/113 字段号与露水状态文件（qixi-dew-state）随活动换皮。',
  },
  {
    key: 'weather-poem',
    name: '天气瓶 · 雨落成诗',
    note: '天气任务 + 研究树，含召唤瓶与雷击变异植物判定。',
    slots: ['weatherTasks', 'weatherResearch'],
    members: [
      {
        key: 'rain-poem',
        activityId: 2026070300,
        uid: 'WeatherBottleUI',
        title: '雨落成诗',
        subActivities: [2026070301, 2026070303, 2026070304],
      },
    ],
    guide: '复用 RainPoemActivityPanel；117/118 字段号固定，换皮只改 ID 与文案。',
  },
  {
    key: 'pet-diary',
    name: '萌宠养成',
    note: '单活动体（115）承载全部子状态，是「独立活动体」族的代表。',
    slots: ['petDiary'],
    members: [
      {
        key: 'pet-diary',
        // 主活动体 2026090101（PET_ID），族/组根为 2026090100；
        // 该族走独立 service（activity-pet-diary.js）+ 独立 proto，无独立 _ACTIVITY_UID 常量。
        activityId: 2026090101,
        groupId: 2026090100,
        uid: '',
        title: '萌宠成长日记',
        subActivities: [2026090102, 2026090103],
      },
    ],
    guide: '复用 PetDiaryActivityPanel；活动体整体走独立 proto（pet-diary.proto），'
      + '换皮时按需改 pet-diary-*.json 配置而非改代码。',
  },
  {
    key: 'share-reward',
    name: '分享领奖',
    note: '轻量活动：分享 + 里程碑 + 每日领取，槽位最简，适合作为新活动的最小骨架参考。',
    slots: ['shareReward'],
    members: [
      {
        key: 'share-reward',
        activityId: 2026092501,
        uid: 'HappySharePanel',
        title: '快乐不独享',
        subActivities: [],
      },
      {
        key: 'wish-sign',
        activityId: 2026092401,
        uid: 'WishSignMainUI',
        title: '秋祈良愿',
        subActivities: [],
      },
    ],
    guide: '复用 ShareRewardActivityPanel / WishSignActivityPanel；120/119 字段号固定。',
  },
  {
    key: 'shop-operate',
    name: '店铺经营 · 兑换 · 基金',
    note: '奶茶热销中引入的一族：店铺经营 + 兑换商店 + 成长基金，是首个「多槽位独立活动体」组合。',
    slots: ['milkTea', 'growthFund', 'exchangeShop'],
    members: [
      {
        key: 'milk-tea',
        activityId: 2026110100,
        uid: 'MilkTeaMainUI',
        title: '奶茶热销中',
        subActivities: [2026110101, 2026110102, 2026110103, 2026110104],
      },
    ],
    guide: '复用 MilkTeaActivityPanel；121/122 为新增字段号，兑换商店复用 102（容错解析）。'
      + '若新活动玩法相近，直接在 milk-tea 的 service/面板上换皮，不要新开并行实现。',
  },
  {
    key: 'qingmei',
    name: '酿造经营',
    note: '日期派生 ID 的特殊一族：活动 ID 由日期推导，需 resolveQingmeiActivityIds 动态解析。',
    slots: ['qingmei'],
    members: [
      {
        key: 'qingmei',
        activityId: 2026081200,
        uid: 'QingMeiActivity',
        title: '青酿换万金',
        subActivities: [2026081201, 2026081202],
      },
    ],
    guide: '复用 QingmeiActivityPanel；该族 ID 走日期派生，换皮需同步改 getDateDerivedQingmeiRootIds。',
  },
  {
    key: 'random-shop',
    name: '随机商店',
    note: '最早的一族，仅随机商店槽位（101）。',
    slots: ['randomShop'],
    members: [
      {
        key: 'nangua',
        activityId: 2026030200,
        uid: 'NanGua',
        title: '南瓜商店',
        subActivities: [2026030201],
      },
    ],
    guide: '复用 NanguaShopPanel；101 字段号固定。',
  },
];

const FAMILY_BY_KEY = new Map(ACTIVITY_FAMILIES.map(family => [family.key, family]));

// 活动 ID → 族 key 的扁平索引（含子活动 ID）
const FAMILY_BY_ACTIVITY_ID = new Map();
for (const family of ACTIVITY_FAMILIES) {
  for (const member of family.members) {
    FAMILY_BY_ACTIVITY_ID.set(Number(member.activityId), family.key);
    for (const subId of member.subActivities || []) {
      FAMILY_BY_ACTIVITY_ID.set(Number(subId), family.key);
    }
  }
}

function getFamily(key) {
  return FAMILY_BY_KEY.get(key) || null;
}

/**
 * 按活动 ID 找族（含子活动 ID）。
 */
function getFamilyByActivityId(activityId) {
  const key = FAMILY_BY_ACTIVITY_ID.get(Number(activityId));
  return key ? getFamily(key) : null;
}

/**
 * 取某族「子活动 ID → 槽位 key」映射（供 getSubActivityKey 等复用）。
 */
function getFamilySubActivitySlots(familyKey) {
  const family = getFamily(familyKey);
  return family?.subActivitySlots || {};
}

/**
 * 取某族全部槽位定义。
 */
function getFamilySlots(familyKey) {
  const family = getFamily(familyKey);
  if (!family) return [];
  return family.slots.map(slot => ({ slot, ...ACTIVITY_SLOT_DEFS[slot] })).filter(item => item.label);
}

/**
 * 从活动快照里提取「槽位指纹」。
 * 入参可以是 getActivityGroupSnapshot 的返回值（含 features），也可以是裸 features 对象。
 */
function extractSlotFingerprint(snapshot) {
  const features = snapshot?.features || snapshot || {};
  const slots = [];
  for (const [slot, def] of Object.entries(ACTIVITY_SLOT_DEFS)) {
    if (def.field > 0 && features[slot]) slots.push(slot);
  }
  return slots;
}

/**
 * 按槽位指纹给活动快照归族。
 * 返回命中族、覆盖率（族内槽位被覆盖的比例）与最接近的既有成员。
 */
function resolveActivityFamily(snapshot) {
  const slots = extractSlotFingerprint(snapshot);
  const activityId = Number(snapshot?.id || 0);

  // 1. 已登记 ID 直接命中（最可信）
  const known = getFamilyByActivityId(activityId);
  if (known) {
    const member = known.members.find(item => Number(item.activityId) === activityId)
      || known.members.find(item => (item.subActivities || []).map(Number).includes(activityId))
      || null;
    return {
      matched: true,
      byId: true,
      familyKey: known.key,
      familyName: known.name,
      coverage: 1,
      slots,
      member,
      guide: known.guide,
    };
  }

  // 2. 未登记：按槽位指纹找最相近的族
  let best = null;
  for (const family of ACTIVITY_FAMILIES) {
    const familySlots = new Set(family.slots);
    const hit = slots.filter(slot => familySlots.has(slot)).length;
    if (!hit) continue;
    // 覆盖率：以「族槽位」为分母，命中越多越像
    const coverage = hit / familySlots.size;
    // 平手时取槽位数更少的族（更具体）
    if (!best
      || coverage > best.coverage
      || (coverage === best.coverage && familySlots.size < best.familySlots)) {
      best = { family, coverage, familySlots: familySlots.size, hit };
    }
  }

  if (!best) {
    return { matched: false, byId: false, familyKey: '', familyName: '', coverage: 0, slots, member: null, guide: '' };
  }

  // 取族内最新成员作为「照它改」的参照
  const member = best.family.members.reduce(
    (acc, item) => (!acc || Number(item.activityId) > Number(acc.activityId) ? item : acc),
    null
  );
  return {
    matched: true,
    byId: false,
    familyKey: best.family.key,
    familyName: best.family.name,
    coverage: Number(best.coverage.toFixed(2)),
    slots,
    member,
    guide: best.family.guide,
  };
}

/**
 * 生成一行中文提示，用于活动发现推送。
 */
function describeFamilyHint(snapshot) {
  const resolved = resolveActivityFamily(snapshot);
  if (!resolved.matched) {
    return resolved.slots.length
      ? `未匹配到既有族（槽位: ${resolved.slots.map(s => ACTIVITY_SLOT_DEFS[s]?.label || s).join('+')}），需人工定族`
      : '未读取到槽位指纹，需人工定族';
  }
  const ref = resolved.member
    ? `${resolved.member.title}(${resolved.member.activityId})`
    : '族内成员';
  const tag = resolved.byId ? '已登记' : `结构匹配 ${Math.round(resolved.coverage * 100)}%`;
  return `归属「${resolved.familyName}」族（${tag}），可照 ${ref} 换皮改造`;
}

/**
 * 供活动发现层使用：列出全部已登记活动 ID（含子活动），用于判定「未知新活动」。
 */
function listKnownFamilyActivityIds() {
  return [...FAMILY_BY_ACTIVITY_ID.keys()].sort((a, b) => a - b);
}

module.exports = {
  ACTIVITY_SLOT_DEFS,
  ACTIVITY_FAMILIES,
  getFamily,
  getFamilyByActivityId,
  getFamilySubActivitySlots,
  getFamilySlots,
  extractSlotFingerprint,
  resolveActivityFamily,
  describeFamilyHint,
  listKnownFamilyActivityIds,
};
