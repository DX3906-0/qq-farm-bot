const process = require('node:process');
const path = require('node:path');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

// ─── 持久化格式版本 ───
// v1: 金豆基线不可信（worker 背包同步漏读 1005，initialState.goldBean 恒为 0）
// v2: 金豆从背包 1005 正确同步；旧基线需丢弃重建，避免「今日 +余额」假增益
const STATS_VERSION = 2;

// ─── 持久化路径 ───

function getStatsFilePath(accountId) {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, 'stats', `${accountId  }.json`);
}

/** 获取 YYYY-MM-DD 格式的当天日期键（北京时间 UTC+8，按北京时间零点跨天） */
function getTodayKey() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadPersistedStats(accountId) {
  const filePath = getStatsFilePath(accountId);
  return readJsonFile(filePath, null);
}

function savePersistedStats(accountId, data) {
  try {
    const filePath = getStatsFilePath(accountId);
    writeJsonFileAtomic(filePath, data);
  } catch {}
}

// ─── 昨日历史（用于日报推送）───

function getYesterdayKey() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000 - 86400 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getHistoryDir(accountId) {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, 'stats-history', String(accountId));
}

function saveHistoryStats(accountId, dateKey, snapshot) {
  try {
    const filePath = path.join(getHistoryDir(accountId), `${dateKey}.json`);
    writeJsonFileAtomic(filePath, snapshot);
  } catch {}
}

/** 读取指定账号昨日统计快照（日报用） */
function getYesterdayStats(accountId) {
  const yKey = getYesterdayKey();
  const filePath = path.join(getHistoryDir(accountId), `${yKey}.json`);
  return readJsonFile(filePath, null);
}

// ─── 运行状态 ───

/** 每日操作计数（按类型） */
const operations = {
  harvest: 0,
  water: 0,
  weed: 0,
  bug: 0,
  farming: 0,
  fertilize: 0,
  plant: 0,
  steal: 0,
  helpWater: 0,
  helpWeed: 0,
  helpBug: 0,
  goldenBugClear: 0,
  goldenBugPut: 0,
  taskClaim: 0,
  putBug: 0,
  putWeed: 0,
  dewOnFriend: 0,
  sell: 0,
  upgrade: 0,
  levelUp: 0,
  mysteryMerchant: 0
};

/** 遇到神秘商人次数计数 */
let mysteryMerchantCount = 0;
/** 当前日期键，跨天时自动重置 */
let currentDateKey = null;

/** 上次记录的金币/经验/点券值（用于计算增量） */
const lastState = {
  gold: -1,
  exp: -1,
  coupon: -1
};

/** 初始值（会话开始时记录） */
const initialState = {
  gold: null,
  exp: null,
  coupon: null,
  goldBean: null
};

/** 会话期间累计增益 */
const session = {
  goldGained: 0,
  expGained: 0,
  couponGained: 0,
  goldBeanGained: 0,
  lastExpGain: 0,
  lastGoldGain: 0
};

/**
 * ⭐ 经验速率追踪（2026-10-29 新增，修「效率/升级预测算不准」）
 *
 * 旧实现：rate = sessionExpGained / process.uptime()
 *   → 分子是「今日 00:00 起的累计」（持久化跨重启），分母是「本次 worker 进程运行秒数」。
 *     两者时间起点完全不同，今天重启 N 次分母就被清零 N 次，速率虚高数倍。
 *   → 更糟的是 exp 只在登录回包/ItemNotify 时被动刷新，可能长时间冻结，
 *     导致分子是历史残留值，算出来的速率既不是当前值也不是当日真实值。
 *
 * 新实现要点：
 *   1. expFirstAt     —— 今日首次观测到「经验增长」的时刻（持久化，跨重启不丢）。
 *                        分母 = now - expFirstAt，与分子（今日累计增长）同源。
 *   2. expRateEma     —— 相邻两次经验增长之间的瞬时速率，做指数平滑（EMA）。
 *                        纯区间速率不受重启影响，也不会被"冻结期"稀释。
 *   3. expPoints / expChangedAt —— 近 6 小时的 (时刻, 经验) 采样点，
 *                        用于计算「有增长的活跃时长」占比，让预测能反映作物成熟等待。
 */
const rateState = {
  /** 今日首次观测到经验增长的毫秒时间戳（0=今天还没有增长） */
  expFirstAt: 0,
  /** 经验速率 EMA（经验/小时） */
  expRateEma: 0,
  /** EMA 上一次更新时对应的经验值（用于算区间增量） */
  expEmaAnchorExp: 0,
  /** EMA 上一次更新时间戳（ms） */
  expEmaAnchorAt: 0,
  /** 近 6h 采样点 [{t, exp}]，用于估算活跃时长占比 */
  expPoints: [],
};
/** EMA 平滑系数：越小越平滑，0.3 约等于最近 3~4 个区间的加权平均 */
const EXP_RATE_EMA_ALPHA = 0.3;
/** 采样点保留窗口（6 小时） */
const EXP_SAMPLE_WINDOW_MS = 6 * 3600 * 1000;
/** 采样点上限（防止数组无限增长） */
const EXP_SAMPLE_MAX = 400;
/** 判定「这个区间经验有增长」的最小间隔，避免同一批收获的回包被拆成多次 */
const EXP_GROWTH_MIN_GAP_MS = 30 * 1000;

let currentAccountId = null;
let saveTimer = null;
let lastFinalState = null;

// ─── 公开 API ───

/**
 * 记录一次经验观测（经验值变化时调用）。
 * 同时维护：今日首次增长时刻、EMA 速率、近 6h 采样点。
 * 幂等：同一经验值重复观测不会污染统计。
 * @param {number} exp 当前经验值
 * @param {number} [at] 观测时刻（默认 Date.now()）
 */
function noteExpObservation(exp, at = Date.now()) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e <= 0) return;
  const t = Number(at) || Date.now();

  // 采样点：只保留近 6h，且同值不重复入队
  const pts = rateState.expPoints;
  const lastPt = pts.length ? pts[pts.length - 1] : null;
  if (!lastPt || lastPt.exp !== e) {
    pts.push({ t, exp: e });
    if (pts.length > EXP_SAMPLE_MAX) pts.splice(0, pts.length - EXP_SAMPLE_MAX);
  }
  const cutoff = t - EXP_SAMPLE_WINDOW_MS;
  while (pts.length && pts[0].t < cutoff) pts.shift();

  // EMA：用「上一次锚点 → 本次」的区间增量算瞬时速率
  const anchorExp = rateState.expEmaAnchorExp;
  const anchorAt = rateState.expEmaAnchorAt;
  if (anchorExp > 0 && anchorAt > 0 && e > anchorExp) {
    const dtMs = t - anchorAt;
    // 区间太短（同批收获）不更新速率，避免噪声；但仍推进锚点
    if (dtMs >= EXP_GROWTH_MIN_GAP_MS) {
      const instRate = ((e - anchorExp) / dtMs) * 3600000; // 经验/小时
      rateState.expRateEma = rateState.expRateEma > 0
        ? rateState.expRateEma * (1 - EXP_RATE_EMA_ALPHA) + instRate * EXP_RATE_EMA_ALPHA
        : instRate;
      rateState.expEmaAnchorExp = e;
      rateState.expEmaAnchorAt = t;
      // 今日首次增长时刻：只有真正涨了才记
      if (!rateState.expFirstAt) rateState.expFirstAt = anchorAt || t;
    } else if (dtMs > 0) {
      // 区间太短（同批收获/回包重复）：不更新速率但仍推进锚点，
      // 否则下一轮会拿更久之前的值当锚点，虚增区间长度
      rateState.expEmaAnchorExp = e;
      rateState.expEmaAnchorAt = t;
    } else {
      // ⚠️ 时间戳非递增（乱序/时钟回拨）：只吸收经验值，不动锚点时间，
      //    避免算出负区间或把锚点时间往前推导致后续速率失真。
      rateState.expEmaAnchorExp = e;
    }
  } else if (!anchorExp || e < anchorExp) {
    // 首次观测 / 经验回退（等级重置等）：重置锚点，不臆造速率
    rateState.expEmaAnchorExp = e;
    rateState.expEmaAnchorAt = t;
  }
}

/**
 * 计算经验速率与升级预测（供 getStats 输出、前端直接展示）。
 *
 * 返回：
 *   expPerHour        —— 综合速率（活跃区间速度 × 活跃占比），单位为经验/小时
 *   activeRatePerHour —— 有产出时的瞬时速率（EMA），用于展示"干活时多快"
 *   activeRatio       —— 近 6h 内"有经验增长"的时长占比（0~1）
 *   elapsedHours      —— 今日统计已覆盖的小时数（从首次增长算起）
 *   sampleCount       —— 采样点数量（前端据此判断数据是否足够，不足就不给预测）
 *   confidence        —— 'low' | 'ok' | 'good'
 */
function computeExpRate(now = Date.now()) {
  const pts = rateState.expPoints || [];
  const firstGainAt = rateState.expFirstAt;
  const elapsedMs = firstGainAt > 0 ? Math.max(0, now - firstGainAt) : 0;
  const elapsedHours = elapsedMs / 3600000;

  // 活跃占比：采样点里「有增长的区间」总时长 / 总跨度
  let activeMs = 0;
  let spanMs = 0;
  if (pts.length >= 2) {
    const spanStart = pts[0].t;
    spanMs = Math.max(0, pts[pts.length - 1].t - spanStart);
    for (let i = 1; i < pts.length; i += 1) {
      // 只有经验确实增加、且间隔不超过窗口才计入"活跃"
      if (pts[i].exp > pts[i - 1].exp) activeMs += (pts[i].t - pts[i - 1].t);
    }
  }
  const activeRatio = spanMs > 0 ? Math.min(1, activeMs / spanMs) : 0;

  const activeRate = rateState.expRateEma > 0 ? rateState.expRateEma : 0;

  // 综合速率：用「今日总增长 / 今日已过时长」作为兜底基准；
  // 若 EMA 可用，则用 EMA × 活跃占比（更贴近"含等待成熟"的真实节奏）。
  let expPerHour = 0;
  if (activeRate > 0 && activeRatio > 0) {
    expPerHour = activeRate * activeRatio;
  } else if (session.expGained > 0 && elapsedHours > 0.05) {
    expPerHour = session.expGained / elapsedHours;
  }

  // 置信度：采样点越多、跨度越长越可信
  let confidence = 'low';
  if (pts.length >= 8 && spanMs >= 60 * 60000) confidence = 'good';
  else if (pts.length >= 4 && spanMs >= 15 * 60000) confidence = 'ok';

  return {
    expPerHour: Math.max(0, expPerHour),
    activeRatePerHour: Math.max(0, activeRate),
    activeRatio,
    elapsedHours,
    sampleCount: pts.length,
    confidence,
  };
}

/**
 * 记录一次操作
 * @param {string} opType - 操作类型（harvest/plant/steal 等）
 * @param {number} count - 次数，默认 1
 */
function recordOperation(opType, count = 1) {
  checkAndResetDailyStats();
  if (operations[opType] !== undefined) {
    operations[opType] += count;
    scheduleSave();
  }
}

/** 记录遇到神秘商人次数 */
function recordMysteryMerchant(count = 1) {
  checkAndResetDailyStats();
  mysteryMerchantCount += count;
  operations.mysteryMerchant = mysteryMerchantCount;
  scheduleSave();
}

function getMysteryMerchantCount() {
  checkAndResetDailyStats();
  return mysteryMerchantCount;
}

function getMysteryMerchantLimit() {
  return null; // 当前无限制
}

/** 获取今日某类操作的累计次数（用于按配置限额控制，如对好友使用灵露的每日上限） */
function getOperationCount(opType) {
  checkAndResetDailyStats();
  return operations[opType] || 0;
}

/** 检查是否跨天，若跨天则重置每日统计 */
function checkAndResetDailyStats() {
  if (!currentAccountId) return;
  const todayKey = getTodayKey();
  if (currentDateKey && currentDateKey !== todayKey) {
    const yesterdayKey = currentDateKey;
    console.warn(`[统计] 检测到跨天，保存昨日历史并重置 (${yesterdayKey} -> ${todayKey})`);
    saveHistoryStats(currentAccountId, yesterdayKey, {
      date: yesterdayKey,
      operations: { ...operations, mysteryMerchant: mysteryMerchantCount },
      mysteryMerchantCount,
      initialState: { ...initialState },
      finalState: lastFinalState || null,
      savedAt: Date.now()
    });
    Object.keys(operations).forEach(k => { operations[k] = 0; });
    mysteryMerchantCount = 0;
    lastFinalState = null;
  }
  currentDateKey = todayKey;
}

/**
 * bot 启动时若持久化文件停留在昨天，先把昨天历史 flush 出来（避免凌晨无操作导致丢失）
 */
function flushYesterdayIfNeeded(persisted) {
  if (!currentAccountId || !persisted || !persisted.date) return;
  const yKey = getYesterdayKey();
  if (persisted.date === yKey) {
    saveHistoryStats(currentAccountId, yKey, {
      date: persisted.date,
      operations: persisted.operations,
      mysteryMerchantCount: persisted.mysteryMerchantCount,
      initialState: persisted.initialState,
      finalState: persisted.finalState || null,
      savedAt: persisted.savedAt || Date.now()
    });
  }
}

/** 延迟 2 秒后保存（防抖） */
function scheduleSave() {
  if (!currentAccountId) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSave();
  }, 2000);
}

function doSave() {
  if (!currentAccountId) return;
  const todayKey = getTodayKey();
  const finalState = {
    gold: lastState.gold < 0 ? null : lastState.gold,
    exp: lastState.exp < 0 ? null : lastState.exp,
    coupon: (initialState.coupon == null)
      ? null
      : (Number(initialState.coupon) || 0) + (session.couponGained || 0)
  };
  lastFinalState = finalState;
  const data = {
    statsVersion: STATS_VERSION,
    date: todayKey,
    operations: { ...operations, mysteryMerchant: mysteryMerchantCount },
    mysteryMerchantCount,
    initialState: { ...initialState },
    finalState,
    session: {
      goldGained: session.goldGained,
      expGained: session.expGained,
      couponGained: session.couponGained,
      goldBeanGained: session.goldBeanGained,
    },
    savedAt: Date.now()
  };
  savePersistedStats(currentAccountId, data);
}

/**
 * 初始化统计（设置初始金币/经验/点券/金豆）
 * @param {number} gold - 当前金币
 * @param {number} exp - 当前经验
 * @param {number} coupon - 当前点券（默认 0）
 * @param {number} goldBean - 当前金豆（默认 0）
 */
function initStats(gold, exp, coupon = 0, goldBean = 0) {
  const g = Number.isFinite(Number(gold)) ? Number(gold) : 0;
  const e = Number.isFinite(Number(exp)) ? Number(exp) : 0;
  const c = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
  const gb = Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0;
  lastState.gold = g;
  lastState.exp = e;
  lastState.coupon = c;
  initialState.gold = g;
  initialState.exp = e;
  initialState.coupon = c;
  initialState.goldBean = gb;
}

/**
 * 初始化统计并加载持久化数据
 * 重登/重连时，若今日已有持久化数据，恢复「今日初始值 + 会话累计增益」，
 * 使金币/点券/金豆的今日加减在重新登录后依然保留。
 * @param {string} accountId - 账号 ID
 * @param {number} gold - 金币
 * @param {number} exp - 经验
 * @param {number} coupon - 点券（默认 0）
 * @param {number} goldBean - 金豆（默认 0）
 */
function initStatsWithPersistence(accountId, gold, exp, coupon = 0, goldBean = 0) {
  currentAccountId = accountId;
  const todayKey = getTodayKey();
  currentDateKey = todayKey;
  // 重置运行时状态
  Object.keys(operations).forEach(k => { operations[k] = 0; });
  mysteryMerchantCount = 0;
  lastState.gold = -1;
  lastState.exp = -1;
  lastState.coupon = -1;
  initialState.gold = null;
  initialState.exp = null;
  initialState.coupon = null;
  initialState.goldBean = null;
  session.goldGained = 0;
  session.expGained = 0;
  session.couponGained = 0;
  session.goldBeanGained = 0;
  session.lastExpGain = 0;
  session.lastGoldGain = 0;

  // 尝试恢复今日持久化数据
  const persisted = loadPersistedStats(accountId);
  if (persisted) flushYesterdayIfNeeded(persisted);
  // ── 一次性迁移：v1 及更早版本因「worker 背包同步漏读 1005」导致金豆基线恒为 0，
  //    升级后首启会把「当前金豆余额」整体算成今日增益（前端显示「今日 +35695」这类假增益）。
  //    检测到旧版本时丢弃金豆基线，改用本次登录值重建，避免污染今日统计。
  const persistedStatsVersion = Number(persisted && persisted.statsVersion) || 1;
  const goldBeanBaselineStale = persistedStatsVersion < STATS_VERSION;
  if (persisted && persisted.date === todayKey) {
    Object.keys(persisted.operations || {}).forEach(k => {
      if (operations[k] !== undefined) {
        operations[k] = Number(persisted.operations[k]) || 0;
      }
    });
    mysteryMerchantCount = Number(persisted.mysteryMerchantCount) || Number(operations.mysteryMerchant) || 0;
    operations.mysteryMerchant = mysteryMerchantCount;
    // 恢复今日初始值（用持久化的今日初始值，而不是当前登录值，
    // 这样 sessionGoldGained = 当前金币 - 今日初始金币 = 今日累计变化，重登后依然正确）
    if (persisted.initialState && typeof persisted.initialState === 'object') {
      const pi = persisted.initialState;
      if (pi.gold !== null && pi.gold !== undefined) initialState.gold = Number(pi.gold) || 0;
      if (pi.exp !== null && pi.exp !== undefined) initialState.exp = Number(pi.exp) || 0;
      if (pi.coupon !== null && pi.coupon !== undefined) initialState.coupon = Number(pi.coupon) || 0;
      // 金豆基线仅在版本一致时恢复；旧版本基线无效（见上方 goldBeanBaselineStale 说明）
      if (!goldBeanBaselineStale && pi.goldBean !== null && pi.goldBean !== undefined) {
        initialState.goldBean = Number(pi.goldBean) || 0;
      }
    }
    // 恢复会话累计增益
    if (persisted.session && typeof persisted.session === 'object') {
      const ps = persisted.session;
      session.goldGained = Number(ps.goldGained) || 0;
      session.expGained = Number(ps.expGained) || 0;
      session.couponGained = Number(ps.couponGained) || 0;
      // 金豆累计增益同样只在版本一致时恢复，否则清零由本次登录值重建
      session.goldBeanGained = goldBeanBaselineStale ? 0 : (Number(ps.goldBeanGained) || 0);
    }
    if (goldBeanBaselineStale) {
      console.warn(`[统计] 检测到金豆基线为旧版本(${persistedStatsVersion} < ${STATS_VERSION})，丢弃历史金豆基线并用本次登录值重建`);
    }
    console.warn(`[统计] 已恢复今日统计数据: ops=${JSON.stringify(operations)}, 初始=${JSON.stringify(initialState)}, 增益=${JSON.stringify({g: session.goldGained, e: session.expGained, c: session.couponGained, gb: session.goldBeanGained})}`);
  } else if (persisted) {
    console.warn(`[统计] 日期已变更，重置统计 (${persisted.date} -> ${todayKey})`);
  } else {
    console.warn('[统计] 新账号初始化，无历史数据');
  }
  // lastState 用当前登录值（用于后续增量检测）；initialState 保持已恢复的今日初始值
  const g = Number.isFinite(Number(gold)) ? Number(gold) : 0;
  const e = Number.isFinite(Number(exp)) ? Number(exp) : 0;
  const c = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
  const gb = Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0;
  lastState.gold = g;
  lastState.exp = e;
  lastState.coupon = c;
  // 无持久化恢复时（跨天/新账号），以当前值作为今日初始值
  if (initialState.gold === null) initialState.gold = g;
  if (initialState.exp === null) initialState.exp = e;
  if (initialState.coupon === null) initialState.coupon = c;
  if (initialState.goldBean === null) initialState.goldBean = gb;
}

/**
 * 更新金币/经验差值追踪
 * @param {number} gold - 当前金币
 * @param {number} exp - 当前经验
 */
function updateStats(gold, exp) {
  // ⚠️ 允许只更新其中一项（如 exp-refresh 只拿到经验）：
  // 未提供的项必须保持原值，不能写成 undefined —— 否则 lastState.gold 被污染，
  // 之后 gold > undefined 恒为 false，金币增量统计会静默失效。
  const hasGold = Number.isFinite(Number(gold)) && gold !== null && gold !== undefined;
  const hasExp = Number.isFinite(Number(exp)) && exp !== null && exp !== undefined;
  if (lastState.gold === -1 && hasGold) lastState.gold = Number(gold);
  if (lastState.exp === -1 && hasExp) lastState.exp = Number(exp);
  if (!hasGold && !hasExp) return;

  // 金币增量
  if (hasGold) {
    const g = Number(gold);
    if (g > lastState.gold) {
      session.lastGoldGain = g - lastState.gold;
    } else if (g < lastState.gold) {
      session.lastGoldGain = 0;
    }
    lastState.gold = g;
  }

  // 经验增量（带同值去重，避免短时间内重复计算）
  if (hasExp) {
    const expNum = Number(exp);
    if (expNum > lastState.exp) {
      const gain = expNum - lastState.exp;
      const now = Date.now();
      // 如果和上次增量相同且时间间隔 < 5s，跳过（去重）
      if (gain === session.lastExpGain && now - (session.lastExpTime || 0) < 5000) {
        // skip duplicate
      } else {
        session.lastExpGain = gain;
        session.lastExpTime = now;
      }
    } else {
      session.lastExpGain = 0;
    }
    // ⭐ 经验速率追踪：只要有观测就记一笔（内部对同值/回退做了幂等与重置处理）
    noteExpObservation(expNum);
    lastState.exp = expNum;
  }
}

function recordGoldExp(gold, exp) {
  updateStats(gold, exp);
}

function setInitialValues(gold, exp, coupon = 0) {
  initStats(gold, exp, coupon);
}

/** 重置会话增益 */
function resetSessionGains() {
  session.goldGained = 0;
  session.expGained = 0;
  session.couponGained = 0;
  session.goldBeanGained = 0;
  session.lastGoldGain = 0;
  session.lastExpGain = 0;
  session.lastExpTime = 0;
}

/** 根据初始值重新计算会话总增益 */
function recomputeSessionTotals(gold, exp, coupon, goldBean) {
  if (initialState.gold === null || initialState.exp === null || initialState.coupon === null) {
    initialState.gold = gold;
    initialState.exp = exp;
    initialState.coupon = coupon;
  }
  if (initialState.goldBean === null) {
    initialState.goldBean = Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0;
  }
  session.goldGained = gold - initialState.gold;
  session.expGained = exp - initialState.exp;
  session.couponGained = coupon - initialState.coupon;
  session.goldBeanGained = (Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0) - initialState.goldBean;
}

/**
 * 获取完整统计快照（供 API 返回）
 * @param {object} farmUser - 农场用户数据
 * @param {object} userState - 用户状态（含 gold/exp/coupon）
 * @param {boolean} connected - 是否连接中
 * @param {object} limits - 操作次数限制
 */
function getStats(farmUser, userState, connected, limits) {
  checkAndResetDailyStats();
  const fu = farmUser && typeof farmUser === 'object' ? farmUser : {};
  const us = userState && typeof userState === 'object' ? userState : {};

  const gold = us.gold ?? fu.gold;
  const exp = us.exp ?? fu.exp;
  const coupon = us.coupon ?? fu.coupon;
  const goldBean = us.goldBean ?? fu.goldBean;

  const g = Number.isFinite(Number(gold)) ? Number(gold) : 0;
  const e = Number.isFinite(Number(exp)) ? Number(exp) : 0;
  const c = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
  const gb = Number.isFinite(Number(goldBean)) ? Number(goldBean) : 0;

  // 如果已连接，更新内部追踪并重新计算会话增益
  if (connected) {
    updateStats(g, e);
    recomputeSessionTotals(g, e, c, gb);
  }

  const ops = { ...operations, mysteryMerchant: mysteryMerchantCount };

  // 鹊桥活动已结束则不在「今日统计」展示「友灵露」
  try {
    const actMod = require('./activity');
    const qixiState = actMod.getQixiEndedStateCached && actMod.getQixiEndedStateCached();
    if (qixiState && qixiState.ended) delete ops.dewOnFriend;
  } catch { /* 活动模块异常时保留原统计 */ }

  return {
    connection: { connected },
    status: {
      name: us.name || fu.name,
      level: fu.level || us.level || 0,
      gold: g,
      coupon: Number.isFinite(Number(us.coupon)) ? Number(us.coupon) : 0,
      goldBean: gb,
      exp: e,
      platform: fu.platform || us.platform || 'qq',
      gid: us.gid || fu.gid || 0,
      openId: us.openId || fu.openId || fu.open_id || '',
      avatar: us.avatar || fu.avatar || fu.avatarUrl || fu.avatar_url || ''
    },
    uptime: process.uptime(),
    // ⭐ 与 sessionExpGained 同源的计时（秒）：从「今日首次观测到经验增长」起算。
    // 前端算速率必须用它，不要用 uptime（uptime 是进程运行时长，重启就清零 → 速率虚高）。
    sessionExpSec: Math.max(0, Math.round((Date.now() - (rateState.expFirstAt || Date.now())) / 1000)),
    operations: ops,
    mysteryMerchantCount,
    mysteryMerchantLimit: null,
    sessionExpGained: session.expGained,
    sessionGoldGained: session.goldGained,
    sessionCouponGained: session.couponGained,
    sessionGoldBeanGained: session.goldBeanGained,
    lastExpGain: session.lastExpGain,
    lastGoldGain: session.lastGoldGain,
    expRate: computeExpRate(),
    limits
  };
}

function saveStats() {
  doSave();
}

module.exports = {
  recordOperation,
  getOperationCount,
  recordMysteryMerchant,
  getMysteryMerchantCount,
  getMysteryMerchantLimit,
  initStats,
  initStatsWithPersistence,
  updateStats,
  setInitialValues,
  recordGoldExp,
  resetSessionGains,
  getStats,
  saveStats,
  getTodayKey,
  loadPersistedStats,
  checkAndResetDailyStats,
  getYesterdayStats,
  noteExpObservation,
  computeExpRate
};
