const process = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonFileAtomic } = require('./json-db');

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

function readStatsJson(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('统计快照不是对象');
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[统计] 读取统计失败 ${filePath}: ${error.message}`);
    return null;
  }
}

function loadPersistedStats(accountId) {
  return readStatsJson(getStatsFilePath(accountId));
}

function savePersistedStats(accountId, data) {
  try {
    const filePath = getStatsFilePath(accountId);
    writeJsonFileAtomic(filePath, data);
    return true;
  } catch (error) {
    console.warn(`[统计] 保存账号 ${accountId} 失败: ${error.message}`);
    return false;
  }
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
  } catch (error) {
    console.warn(`[统计] 保存账号 ${accountId} 历史 ${dateKey} 失败: ${error.message}`);
  }
}

/** 读取指定账号昨日统计快照（日报用） */
function getYesterdayStats(accountId) {
  const yKey = getYesterdayKey();
  const filePath = path.join(getHistoryDir(accountId), `${yKey}.json`);
  return readStatsJson(filePath);
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
  coupon: -1,
  goldBean: -1
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

// 每日收益与滚动经验样本的时间口径独立；速率格式升级不触发金豆 v2 迁移。
const EXP_RATE_VERSION = 2;
const EXP_SAMPLE_WINDOW_MS = 6 * 3600 * 1000;
const EXP_SAMPLE_MAX = 400;
const EXP_GROWTH_MIN_GAP_MS = 30 * 1000;
const EXP_RATE_MIN_SPAN_MS = 5 * 60000;
const EXP_IDLE_SAVE_MS = 10000;
// v2 区分可确认收益与可用于速率的完整观测，仍读取 v1 历史。
const rateState = { anchor: null, intervals: [], pendingGap: null };
let rateRevision = 0;
let rateMemo = null;
let connectionReady = false;
let connectionReadyAt = null;
let statsDirty = false;
let saveDueAt = 0;
let lastSavedAt = 0;
let currentAccountId = null;
let saveTimer = null;
let lastFinalState = null;
let initialStateAt = null;
let finalStateAt = null;
let expObservationEnabled = false;
// 缓存登录只能提供待确认基准，不能冒充真实观测或覆盖本账号最后确认值。
let confirmedExp = null;

function validValue(value) {
  return (typeof value === 'number' || typeof value === 'string') && value !== '' && Number.isFinite(Number(value))
    && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER;
}

function validTime(value) {
  return validValue(value) && Number(value) > 0 && Number(value) <= 8640000000000000;
}

function invalidateExpRate() {
  rateRevision += 1;
  rateMemo = null;
}

function pruneExpSamples(now) {
  // 跨窗口的增长不能按比例摊分；零收益区间可以精确裁掉过期等待时长。
  if (rateState.anchor && now < rateState.anchor.t) return;
  const cutoff = now - EXP_SAMPLE_WINDOW_MS;
  const intervals = rateState.intervals.filter(i => i.end <= now && (i.source === 'unknown'
    ? i.end >= cutoff : (i.start >= cutoff || (i.gain === 0 && i.end > cutoff))));
  let changed = intervals.length !== rateState.intervals.length;
  for (const i of intervals) {
    if (i.start < cutoff && i.source !== 'unknown') { i.start = cutoff; changed = true; }
  }
  if (intervals.length > EXP_SAMPLE_MAX) {
    intervals.splice(0, intervals.length - EXP_SAMPLE_MAX);
    changed = true;
  }
  rateState.intervals = intervals;
  if (changed) invalidateExpRate();
}

function seedExpBaseline(exp, at = Date.now(), { snapshotOnly = false } = {}) {
  if (!validValue(exp) || !validTime(at) || Number(at) > Date.now()
      || (rateState.anchor && Number(at) < rateState.anchor.t)
      || (confirmedExp && Number(at) < confirmedExp.t)) return;
  const e = Number(exp);
  const t = Number(at);
  const previousExp = confirmedExp ? confirmedExp.exp : rateState.anchor && rateState.anchor.exp;
  if (!snapshotOnly && ((previousExp !== null && e < previousExp)
      || (rateState.anchor && t < rateState.anchor.t))) rateState.intervals = [];
  pruneExpSamples(t);
  // 缓存基准只定位新段，首个真实回包须重新确认，不能用该时间计算 live 速率。
  rateState.anchor = snapshotOnly ? { t, exp: e, snapshotOnly: true } : { t, exp: e };
  rateState.pendingGap = null;
  if (!snapshotOnly) confirmedExp = { exp: e, t, source: 'actual' };
  invalidateExpRate();
  scheduleSave();
}

/** 仅用于真实回包/通知；同值真实观测代表已知 idle，缓存状态读数不得调用。 */
function noteExpObservation(exp, at = Date.now()) {
  if (!expObservationEnabled || !validValue(exp) || !validTime(at) || Number(at) > Date.now()) return false;
  checkAndResetDailyStats();
  const e = Number(exp);
  const t = Number(at);
  const anchor = rateState.anchor;
  const gap = rateState.pendingGap;
  if ((anchor && t < anchor.t) || (confirmedExp && t < confirmedExp.t)
      || (connectionReadyAt !== null && t < connectionReadyAt)
      || (gap && (gap.resumedAt === null || t < gap.resumedAt))) return false;
  if (gap && confirmedExp && confirmedExp.source === 'actual' && e >= confirmedExp.exp) {
    const gain = e - confirmedExp.exp;
    // 尾段零收益只是在线推断；恢复后有增量时无法确定它发生在哪段，整段标为未知。
    if (gain > 0) rateState.intervals = rateState.intervals.filter(i => i.end <= gap.start);
    const last = rateState.intervals[rateState.intervals.length - 1];
    const start = Math.max(gap.start, last ? last.end : gap.start);
    rateState.intervals.push({ start, end: t, gain, source: 'unknown', observed: false });
    rateState.pendingGap = null;
    rateState.anchor = { t, exp: e };
    confirmedExp = { exp: e, t, source: 'actual' };
    lastState.exp = e;
    if (initialState.exp !== null) session.expGained = e - initialState.exp;
    finalStateAt = t;
    lastFinalState = { ...lastState, exp: e };
    pruneExpSamples(t);
    invalidateExpRate();
    scheduleSave(gain === 0);
    return true;
  }
  if (!anchor || anchor.snapshotOnly || e < anchor.exp
      || (t - anchor.t >= EXP_SAMPLE_WINDOW_MS && e !== anchor.exp)) {
    if (anchor && anchor.snapshotOnly && !confirmedExp) {
      initialState.exp = e;
      initialStateAt = t;
    }
    if (confirmedExp && e < confirmedExp.exp) rateState.intervals = [];
    seedExpBaseline(e, t);
    lastState.exp = e;
    if (initialState.exp !== null) session.expGained = e - initialState.exp;
    finalStateAt = t;
    lastFinalState = { ...lastState, exp: confirmedExp ? confirmedExp.exp : lastState.exp };
    return true;
  }
  if (t === anchor.t && e === anchor.exp) return false;
  const gain = e - anchor.exp;
  const last = rateState.intervals[rateState.intervals.length - 1];
  if (last && last.end === anchor.t && last.source === 'live'
      && ((gain > 0 && last.gain > 0 && t - anchor.t < EXP_GROWTH_MIN_GAP_MS
        && t - (last.batchAt ?? last.end) < EXP_GROWTH_MIN_GAP_MS)
        || (gain === 0 && last.gain === 0))) {
    // 同批增长合并且最多延续30秒，保留全部收益；idle 连续段压缩。
    if (gain > 0 && last.batchAt === undefined) last.batchAt = last.end;
    last.end = t;
    last.gain += gain;
  } else {
    const interval = { start: anchor.t, end: t, gain, source: 'live' };
    if (gain > 0) interval.batchAt = t;
    rateState.intervals.push(interval);
  }
  rateState.anchor = { t, exp: e };
  confirmedExp = { exp: e, t, source: 'actual' };
  lastState.exp = e;
  if (initialState.exp !== null) session.expGained = e - initialState.exp;
  finalStateAt = t;
  lastFinalState = { ...lastState, exp: confirmedExp ? confirmedExp.exp : lastState.exp };
  pruneExpSamples(t);
  invalidateExpRate();
  scheduleSave(gain === 0);
  return true;
}

function restoreExpSamples(persisted, now) {
  rateState.anchor = null;
  rateState.intervals = [];
  rateState.pendingGap = null;
  const saved = persisted && persisted.rateState;
  if (saved) {
    if (![1, EXP_RATE_VERSION].includes(saved.version) || String(saved.accountId) !== String(currentAccountId)
        || !Array.isArray(saved.intervals)) {
      console.warn('[统计] 经验样本格式或账号不匹配，拒绝恢复');
      return;
    }
    if (saved.anchor && (!validTime(saved.anchor.t) || !validValue(saved.anchor.exp))) {
      console.warn('[统计] 经验样本基准损坏，拒绝恢复');
      return;
    }
    let previousEnd = 0;
    let previousObservedEnd = 0;
    for (const i of saved.intervals) {
      if (!i || !validTime(i.start) || !validTime(i.end) || !validValue(i.gain)
          || i.end < i.start || i.start < previousEnd
          || (i.end - i.start > EXP_SAMPLE_WINDOW_MS && i.source !== 'unknown')
          || !['live', 'history', 'migrated', 'online', 'unknown'].includes(i.source)
          || (i.source === 'unknown' && (saved.version !== EXP_RATE_VERSION || i.observed !== false))
          || (i.source === 'online' && Number(i.gain) !== 0)
          || (i.observed === false && i.source !== 'unknown' && Number(i.gain) !== 0)) {
        console.warn('[统计] 经验样本损坏，拒绝恢复');
        rateState.intervals = [];
        return;
      }
      previousEnd = i.end;
      const interval = { start: Number(i.start), end: Number(i.end), gain: Number(i.gain),
        source: i.source === 'unknown' ? 'unknown' : i.source === 'migrated' ? 'migrated' : 'history' };
      if (i.source === 'online' || i.observed === false) interval.observed = false;
      if (i.source !== 'online' && !(i.source === 'history' && i.observed === false)) previousObservedEnd = i.end;
      rateState.intervals.push(interval);
    }
    if (saved.anchor && validTime(saved.anchor.t) && validValue(saved.anchor.exp)) {
      rateState.anchor = { t: Number(saved.anchor.t), exp: Number(saved.anchor.exp) };
      if (saved.anchor.snapshotOnly === true) rateState.anchor.snapshotOnly = true;
    }
    if (rateState.anchor && rateState.anchor.t < previousObservedEnd) {
      console.warn('[统计] 经验样本基准早于区间，拒绝恢复');
      rateState.anchor = null;
      rateState.intervals = [];
    }
    if ((rateState.anchor && rateState.anchor.t > now) || previousEnd > now) {
      console.warn('[统计] 经验样本时间在未来，拒绝恢复');
      rateState.anchor = null;
      rateState.intervals = [];
    }
    if (saved.pendingGap) {
      const gap = saved.pendingGap;
      if (!rateState.anchor || saved.version !== EXP_RATE_VERSION
          || !validTime(gap.start) || !validTime(gap.pausedAt) || gap.start > gap.pausedAt
          || gap.start !== rateState.anchor.t || gap.pausedAt > now
          || (gap.resumedAt !== null && (!validTime(gap.resumedAt)
            || gap.resumedAt < gap.pausedAt || gap.resumedAt > now))) {
        console.warn('[统计] 暂停经验区间损坏，拒绝恢复样本');
        rateState.anchor = null;
        rateState.intervals = [];
      } else {
        // 重启不能恢复旧进程的在线性，须再次收到当前会话的恢复事件。
        rateState.pendingGap = { start: Number(gap.start), pausedAt: Number(gap.pausedAt), resumedAt: null };
      }
    }
    pruneExpSamples(now);
    return;
  }
  if (!persisted) return;
  // 旧今日统计没有基线时间时不能用午夜/进程启动时间猜测分母。
  let start = persisted.initialStateAt;
  let end = persisted.finalStateAt || persisted.savedAt;
  let from = persisted.initialState && persisted.initialState.exp;
  const to = persisted.finalState && persisted.finalState.exp;
  if (persisted.date !== getTodayKey() || !validTime(start)) {
    const history = getYesterdayStats(currentAccountId);
    start = history && (history.finalStateAt || history.savedAt);
    from = history && history.finalState && history.finalState.exp;
  }
  if (validTime(start) && validTime(end) && validValue(from) && validValue(to)
      && end > start && end <= now && start >= now - EXP_SAMPLE_WINDOW_MS && to >= from) {
    rateState.intervals = [{ start: Number(start), end: Number(end), gain: Number(to) - Number(from), source: 'migrated' }];
    rateState.anchor = { t: Number(end), exp: Number(to) };
  }
}

function restoreConfirmedExp(persisted, now) {
  if (!persisted) return;
  const saved = persisted.rateState;
  if (saved && (![1, EXP_RATE_VERSION].includes(saved.version) || String(saved.accountId) !== String(currentAccountId))) return;
  const value = saved && saved.confirmed;
  if (value) {
    if (!validValue(value.exp) || !validTime(value.t) || value.t > now
        || !['actual', 'legacy'].includes(value.source)) {
      console.warn('[统计] 已确认经验损坏，拒绝恢复');
      return;
    }
    confirmedExp = { exp: Number(value.exp), t: Number(value.t), source: value.source };
  } else if (saved && !Object.prototype.hasOwnProperty.call(saved, 'confirmed')
      && rateState.anchor && !rateState.anchor.snapshotOnly) {
    confirmedExp = { exp: rateState.anchor.exp, t: rateState.anchor.t, source: 'actual' };
  } else if (!saved && validValue(persisted.finalState && persisted.finalState.exp)) {
    const at = persisted.finalStateAt || persisted.savedAt;
    // 旧保存时间仅能标记历史余额，不能变成 live 观测时间。
    if (validTime(at) && at <= now) confirmedExp = { exp: Number(persisted.finalState.exp), t: Number(at), source: 'legacy' };
  }
}

/** 时间加权收益/有效时长；已知在线等待只进分母，不修改真实基准。 */
function computeExpRate(now = Date.now(), { connected = connectionReady } = {}) {
  const t = Number(now);
  const anchor = rateState.anchor;
  const gap = rateState.pendingGap;
  const future = !validTime(now) || (anchor && t < anchor.t)
    || (confirmedExp && t < confirmedExp.t) || (connectionReadyAt !== null && t < connectionReadyAt)
    || (gap && t < (gap.resumedAt ?? gap.pausedAt));
  const ongoing = !future && !gap && connected === true && connectionReady && expObservationEnabled
    && anchor && !anchor.snapshotOnly && connectionReadyAt !== null && t >= connectionReadyAt;
  // 无数据变化时最多每秒重算一次；样本、连接与回退时钟均独立失效。
  const bucket = Math.floor(t / 1000);
  if (rateMemo && rateMemo.revision === rateRevision && rateMemo.bucket === bucket
      && rateMemo.ongoing === !!ongoing && rateMemo.future === !!future && t >= rateMemo.at)
    return rateMemo.value;
  const cutoff = t - EXP_SAMPLE_WINDOW_MS;
  const recentCutoff = t - 3600000;
  let gain = 0;
  let partialGain = 0;
  let partialUnknown = !!gap;
  let spanMs = 0;
  let activeMs = 0;
  let gainCount = 0;
  let recentGain = 0;
  let recentMs = 0;
  let recentCount = 0;
  let sampleCount = 0;
  let historical = false;
  let live = false;
  let migrated = false;
  let lastIntervalAt = null;
  if (!future) for (const i of rateState.intervals) {
    if (i.source === 'unknown') {
      // 收益在首次恢复回包时可确认，但发生时刻和有效时长未知，绝不拿来造速率。
      if (i.end <= t && i.end >= cutoff) { partialGain += i.gain; partialUnknown = true; }
      continue;
    }
    if (i.end > t || (i.start < cutoff && (i.gain > 0 || i.end <= cutoff))) continue;
    const dt = i.end - Math.max(i.start, cutoff);
    spanMs += dt;
    gain += i.gain;
    if (i.gain > 0) { activeMs += dt; gainCount += 1; }
    if (i.start >= recentCutoff || (i.gain === 0 && i.end > recentCutoff)) {
      recentMs += i.end - Math.max(i.start, recentCutoff);
      recentGain += i.gain;
      if (i.gain > 0) recentCount += 1;
    }
    if (i.source !== 'online' && i.observed !== false) { sampleCount += 1; lastIntervalAt = i.end; }
    historical ||= i.source === 'history' || i.source === 'migrated';
    live ||= i.source === 'live' || i.source === 'online';
    migrated ||= i.source === 'migrated';
  }
  const waitStart = ongoing ? Math.max(anchor.t, connectionReadyAt, cutoff) : t;
  const ongoingMs = ongoing ? Math.max(0, t - waitStart) : 0;
  spanMs += ongoingMs;
  recentMs += ongoing ? Math.max(0, t - Math.max(waitStart, recentCutoff)) : 0;
  const lastObservedAt = anchor && !anchor.snapshotOnly ? anchor.t
    : (lastIntervalAt || (confirmedExp ? confirmedExp.t : null));
  const stale = !!lastObservedAt && t - lastObservedAt >= EXP_SAMPLE_WINDOW_MS;
  const knownIdle = !future && !gap && partialGain === 0 && gain === 0
    && spanMs >= EXP_GROWTH_MIN_GAP_MS && (!stale || !!ongoing);
  // 秒级初样不能支撑预测，等待5分钟有效跨度；全部真实收益原样保留。
  const sufficient = !future && !stale && spanMs >= EXP_RATE_MIN_SPAN_MS;
  const baseline = spanMs > 0 ? gain * 3600000 / spanMs : 0;
  const recentRate = recentMs > 0 ? recentGain * 3600000 / recentMs : 0;
  // 最近1小时具备3批收益及15分钟跨度时跟随策略；否则只用6小时基线。
  const recentWeight = sufficient && recentCount >= 3 && recentMs >= 15 * 60000
    ? 0.7 * Math.min(1, recentMs / 3600000) : 0;
  const expPerHour = sufficient && gain > 0 ? (1 - recentWeight) * baseline + recentWeight * recentRate : 0;
  let confidence = 'low';
  if (gainCount >= 7 && spanMs >= 3600000) confidence = 'good';
  else if (gainCount >= 3 && spanMs >= 15 * 60000) confidence = 'ok';
  const source = sampleCount ? (historical ? (live ? 'mixed' : 'history') : 'live') : 'none';
  const reason = future ? 'clock-regression' : knownIdle ? 'idle' : stale ? 'stale'
    : !sufficient || (gain === 0 && (partialGain > 0 || gap)) ? 'insufficient' : '';
  const value = Object.freeze({
    expPerHour: Number.isFinite(expPerHour) ? expPerHour : 0,
    activeRatePerHour: activeMs > 0 && sufficient ? gain * 3600000 / activeMs : 0,
    activeRatio: spanMs > 0 ? activeMs / spanMs : 0,
    elapsedHours: spanMs / 3600000,
    sampleCount: sampleCount ? sampleCount + 1 : (anchor ? 1 : 0),
    gainCount,
    observedGain: gain + partialGain,
    rateEligibleGain: gain,
    partialGain,
    partialUnknown,
    lastObservedAt,
    confidence,
    source,
    estimate: confidence === 'low' || migrated || ongoingMs > 0 || partialUnknown,
    reason,
    stale,
  });
  rateMemo = { revision: rateRevision, bucket, ongoing: !!ongoing, future: !!future, at: t, value };
  return value;
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
      initialStateAt,
      finalStateAt,
      savedAt: finalStateAt || Date.now()
    });
    Object.keys(operations).forEach(k => { operations[k] = 0; });
    mysteryMerchantCount = 0;
    resetSessionGains();
    // 使用跨天前最后已知余额，不把昨天收益带到今天；速率样本不随午夜重置。
    Object.keys(initialState).forEach(k => { initialState[k] = lastState[k] < 0 ? null : lastState[k]; });
    if (confirmedExp) initialState.exp = confirmedExp.exp;
    initialStateAt = finalStateAt;
    lastFinalState = null;
    finalStateAt = null;
    scheduleSave();
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
      initialStateAt: persisted.initialStateAt || null,
      finalStateAt: persisted.finalStateAt || null,
      savedAt: persisted.savedAt || null
    });
  }
}

/** 收益变化仍在2秒内保存；高频同值观测最多每10秒落盘。 */
function scheduleSave(idleOnly = false) {
  if (!currentAccountId) return;
  statsDirty = true;
  const now = Date.now();
  const due = Math.max(now + 2000, idleOnly ? lastSavedAt + EXP_IDLE_SAVE_MS : 0);
  if (saveTimer && saveDueAt <= due) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveDueAt = due;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSave();
  }, due - now);
}

function doSave(force = false) {
  if (!currentAccountId || (!statsDirty && !force)) return;
  checkAndResetDailyStats();
  pruneExpSamples(Date.now());
  const todayKey = getTodayKey();
  const finalState = {
    gold: lastState.gold < 0 ? null : lastState.gold,
    exp: confirmedExp ? confirmedExp.exp : (lastState.exp < 0 ? null : lastState.exp),
    coupon: lastState.coupon < 0 ? null : lastState.coupon,
    goldBean: lastState.goldBean < 0 ? null : lastState.goldBean
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
    initialStateAt,
    finalStateAt,
    rateState: {
      version: EXP_RATE_VERSION,
      accountId: String(currentAccountId),
      anchor: rateState.anchor,
      confirmed: confirmedExp,
      intervals: rateState.intervals,
      pendingGap: rateState.pendingGap
    },
    savedAt: Date.now()
  };
  if (savePersistedStats(currentAccountId, data)) {
    statsDirty = false;
    lastSavedAt = Date.now();
  }
}

/**
 * 初始化统计（设置初始金币/经验/点券/金豆）
 * @param {number} gold - 当前金币
 * @param {number} exp - 当前经验
 * @param {number} coupon - 当前点券（默认 0）
 * @param {number} goldBean - 当前金豆（默认 0）
 */
function initStats(gold, exp, coupon = 0, goldBean = 0) {
  const g = validValue(gold) ? Number(gold) : 0;
  const e = validValue(exp) ? Number(exp) : 0;
  const c = validValue(coupon) ? Number(coupon) : 0;
  const gb = validValue(goldBean) ? Number(goldBean) : 0;
  lastState.gold = g;
  lastState.exp = e;
  lastState.coupon = c;
  initialState.gold = g;
  initialState.exp = e;
  initialState.coupon = c;
  initialState.goldBean = gb;
  lastState.goldBean = gb;
  initialStateAt = Date.now();
  finalStateAt = initialStateAt;
  expObservationEnabled = true;
  seedExpBaseline(exp);
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
 * @param {{snapshotOnly?: boolean}} options - 查询失败/复用登录缓存时不能判定经验回退
 */
function initStatsWithPersistence(accountId, gold, exp, coupon = 0, goldBean = 0, { snapshotOnly = false } = {}) {
  // 清除待写计时器，切号前同步 flush 旧账号，防止待保存数据被新登录覆盖。
  pauseExpObservations();
  currentAccountId = accountId;
  connectionReady = false;
  connectionReadyAt = null;
  statsDirty = false;
  lastSavedAt = 0;
  invalidateExpRate();
  lastFinalState = null;
  initialStateAt = null;
  finalStateAt = null;
  rateState.anchor = null;
  rateState.intervals = [];
  rateState.pendingGap = null;
  confirmedExp = null;
  const todayKey = getTodayKey();
  currentDateKey = todayKey;
  // 重置运行时状态
  Object.keys(operations).forEach(k => { operations[k] = 0; });
  mysteryMerchantCount = 0;
  lastState.gold = -1;
  lastState.exp = -1;
  lastState.coupon = -1;
  lastState.goldBean = -1;
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
  session.lastExpTime = 0;

  // 尝试恢复今日持久化数据
  const persisted = loadPersistedStats(accountId);
  restoreExpSamples(persisted, Date.now());
  restoreConfirmedExp(persisted, Date.now());
  if (persisted) flushYesterdayIfNeeded(persisted);
  // ── 一次性迁移：v1 及更早版本因「worker 背包同步漏读 1005」导致金豆基线恒为 0，
  //    升级后首启会把「当前金豆余额」整体算成今日增益（前端显示「今日 +35695」这类假增益）。
  //    检测到旧版本时丢弃金豆基线，改用本次登录值重建，避免污染今日统计。
  const persistedStatsVersion = Number(persisted && persisted.statsVersion) || 1;
  const goldBeanBaselineStale = persistedStatsVersion < STATS_VERSION;
  if (persisted && persisted.date === todayKey) {
    initialStateAt = validTime(persisted.initialStateAt) ? Number(persisted.initialStateAt) : null;
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
      if (validValue(pi.gold)) initialState.gold = Number(pi.gold);
      if (validValue(pi.exp)) initialState.exp = Number(pi.exp);
      if (validValue(pi.coupon)) initialState.coupon = Number(pi.coupon);
      // 金豆基线仅在版本一致时恢复；旧版本基线无效（见上方 goldBeanBaselineStale 说明）
      if (!goldBeanBaselineStale && pi.goldBean !== null && validValue(pi.goldBean)) {
        initialState.goldBean = Number(pi.goldBean);
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
  // 缓存登录使用本账号已确认余额，不把 retained old login 当真实回退或新收益。
  const g = validValue(gold) ? Number(gold) : 0;
  const loginExp = validValue(exp) ? Number(exp) : 0;
  const clockRegression = confirmedExp && Date.now() < confirmedExp.t;
  const e = clockRegression ? confirmedExp.exp
    : snapshotOnly ? Math.max(loginExp, confirmedExp ? confirmedExp.exp : 0, rateState.anchor ? rateState.anchor.exp : 0) : loginExp;
  const c = validValue(coupon) ? Number(coupon) : 0;
  const gb = validValue(goldBean) ? Number(goldBean) : 0;
  lastState.gold = g;
  lastState.exp = e;
  lastState.coupon = c;
  // 无持久化恢复时（跨天/新账号），以当前值作为今日初始值
  if (initialState.gold === null) initialState.gold = g;
  if (initialState.exp === null) {
    initialState.exp = snapshotOnly && confirmedExp ? confirmedExp.exp : e;
    initialStateAt = snapshotOnly ? (confirmedExp ? confirmedExp.t : null) : (validValue(exp) ? Date.now() : null);
  }
  if (initialState.coupon === null) initialState.coupon = c;
  if (initialState.goldBean === null) initialState.goldBean = gb;
  lastState.goldBean = gb;
  finalStateAt = snapshotOnly || clockRegression ? (confirmedExp ? confirmedExp.t : null) : Date.now();
  expObservationEnabled = true;
  seedExpBaseline(snapshotOnly ? e : exp, Date.now(), { snapshotOnly });
  const dailyExp = snapshotOnly && confirmedExp ? confirmedExp.exp : e;
  recomputeSessionTotals(g, dailyExp, c, gb);
  scheduleSave();
}

/**
 * 更新金币/经验差值追踪
 * @param {number} gold - 当前金币
 * @param {number} exp - 当前经验
 * @param {{observe?: boolean}} options - false 为缓存路径，不更新任何经验状态；真实回包须由调用方校验账号/epoch
 */
function updateStats(gold, exp, { observe = true } = {}) {
  checkAndResetDailyStats();
  // ⚠️ 允许只更新其中一项（如 exp-refresh 只拿到经验）：
  // 未提供的项必须保持原值，不能写成 undefined —— 否则 lastState.gold 被污染，
  // 之后 gold > undefined 恒为 false，金币增量统计会静默失效。
  const hasGold = validValue(gold);
  const goldChanged = hasGold && Number(gold) !== lastState.gold;
  const hasExp = observe && expObservationEnabled && validValue(exp)
    && (!rateState.anchor || Date.now() >= rateState.anchor.t)
    && (!confirmedExp || Date.now() >= confirmedExp.t)
    && (connectionReadyAt === null || Date.now() >= connectionReadyAt)
    && (!rateState.pendingGap || (rateState.pendingGap.resumedAt !== null
      && Date.now() >= rateState.pendingGap.resumedAt));
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
    // 只有真实更新允许经验回退；缓存路径不变更经验、基准或样本。
    noteExpObservation(expNum);
    lastState.exp = expNum;
  }
  if (hasGold && initialState.gold !== null) session.goldGained = lastState.gold - initialState.gold;
  if (hasExp && initialState.exp !== null) session.expGained = lastState.exp - initialState.exp;
  if (hasExp && rateState.anchor && rateState.anchor.exp === Number(exp)) finalStateAt = rateState.anchor.t;
  lastFinalState = { ...lastState, exp: confirmedExp ? confirmedExp.exp : lastState.exp };
  if (goldChanged) scheduleSave();
}

function recordGoldExp(gold, exp) {
  if (!expObservationEnabled) return;
  // status 钩子可能附带旧登录缓存；真实经验由 main 接 noteExpObservation/updateStats。
  updateStats(gold, exp, { observe: false });
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
 * @param {{connectionReady?: boolean}} options - false 只禁用在线尾段，不阻断真实经验回包
 */
function getStats(farmUser, userState, connected, limits, { connectionReady: ready } = {}) {
  checkAndResetDailyStats();
  const fu = farmUser && typeof farmUser === 'object' ? farmUser : {};
  const us = userState && typeof userState === 'object' ? userState : {};

  const gold = us.gold ?? fu.gold;
  const exp = us.exp ?? fu.exp;
  const coupon = us.coupon ?? fu.coupon;
  const goldBean = us.goldBean ?? fu.goldBean;

  const g = validValue(gold) ? Number(gold) : Math.max(0, lastState.gold);
  const e = confirmedExp ? confirmedExp.exp : (validValue(exp) ? Number(exp) : Math.max(0, lastState.exp));
  const expSource = confirmedExp ? (confirmedExp.source === 'actual' ? 'confirmed' : 'legacy') : 'snapshot';
  const c = validValue(coupon) ? Number(coupon) : Math.max(0, lastState.coupon);
  const gb = validValue(goldBean) ? Number(goldBean) : Math.max(0, lastState.goldBean);

  // 如果已连接，更新内部追踪并重新计算会话增益
  if (connected) {
    const currencyChanged = c !== lastState.coupon || gb !== lastState.goldBean;
    updateStats(gold, exp, { observe: false });
    recomputeSessionTotals(g, confirmedExp ? confirmedExp.exp : Math.max(0, lastState.exp), c, gb);
    lastState.coupon = c;
    lastState.goldBean = gb;
    lastFinalState = { ...lastState, exp: confirmedExp ? confirmedExp.exp : lastState.exp };
    if (currencyChanged) scheduleSave();
  }

  const tailReady = connected === true && ready !== false;
  if (connected === false && expObservationEnabled) pauseExpObservations();
  else if (tailReady) setExpConnectionReady(true);
  // 业务亚健康只限制当前快照的推断尾段，不能用状态读取反复暂停实际观测。
  const expRate = computeExpRate(Date.now(), { connected: tailReady });
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
      expSource,
      expObservedAt: confirmedExp ? confirmedExp.t : null,
      platform: fu.platform || us.platform || 'qq',
      gid: us.gid || fu.gid || 0,
      openId: us.openId || fu.openId || fu.open_id || '',
      avatar: us.avatar || fu.avatar || fu.avatarUrl || fu.avatar_url || ''
    },
    uptime: process.uptime(),
    // 兼容展示字段，已观测时长不与每日收益混算速率。
    sessionExpSec: Math.round(expRate.elapsedHours * 3600),
    operations: ops,
    mysteryMerchantCount,
    mysteryMerchantLimit: null,
    sessionExpGained: session.expGained,
    sessionGoldGained: session.goldGained,
    sessionCouponGained: session.couponGained,
    sessionGoldBeanGained: session.goldBeanGained,
    lastExpGain: session.lastExpGain,
    lastGoldGain: session.lastGoldGain,
    expRate,
    limits
  };
}

function saveStats() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  doSave(true);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

/** 当前同会话真实恢复事件使用，不改基准余额，首个真实回包只确认未知段收益。 */
function resumeExpObservations(at = Date.now()) {
  const t = Number(at);
  const gap = rateState.pendingGap;
  const anchor = rateState.anchor;
  const last = rateState.intervals[rateState.intervals.length - 1];
  if (!currentAccountId || !validTime(at) || t > Date.now()
      || (anchor && t < anchor.t) || (confirmedExp && t < confirmedExp.t)
      || (last && t < last.end) || (connectionReadyAt !== null && t < connectionReadyAt)
      || (gap && t < (gap.resumedAt ?? gap.pausedAt))) return false;
  if (expObservationEnabled) return true;
  if (!gap || !anchor) return false;
  gap.resumedAt = t;
  expObservationEnabled = true;
  invalidateExpRate();
  scheduleSave();
  return true;
}

/** 连接已就绪事件使用，调用方须校验账号/epoch；缓存状态不能恢复暂停采样。 */
function setExpConnectionReady(ready, at = Date.now()) {
  if (ready === false) { pauseExpObservations(at); return; }
  if (ready !== true) return;
  if (!expObservationEnabled || !validTime(at) || Number(at) > Date.now() || connectionReady
      || (rateState.anchor && Number(at) < rateState.anchor.t)
      || (confirmedExp && Number(at) < confirmedExp.t)
      || (rateState.pendingGap && (rateState.pendingGap.resumedAt === null
        || Number(at) < rateState.pendingGap.resumedAt))) return;
  connectionReady = true;
  connectionReadyAt = Number(at);
  invalidateExpRate();
}

/** 停止观测并保存已知在线等待，离线时间不延续到下一登录段。 */
function pauseExpObservations(at = Date.now()) {
  const anchor = rateState.anchor;
  const t = Number(at);
  const gap = rateState.pendingGap;
  const last = rateState.intervals[rateState.intervals.length - 1];
  if (!validTime(at) || t > Date.now() || (anchor && t < anchor.t)
      || (confirmedExp && t < confirmedExp.t) || (last && t < last.end)
      || (connectionReadyAt !== null && t < connectionReadyAt)
      || (gap && t < (gap.resumedAt ?? gap.pausedAt))) return false;
  if (!expObservationEnabled && !statsDirty) return true;
  if (expObservationEnabled && anchor) {
    rateState.pendingGap = gap ? { ...gap, pausedAt: t, resumedAt: null }
      : { start: anchor.t, pausedAt: t, resumedAt: null };
    statsDirty = true;
  }
  if (connectionReady && !gap && connectionReadyAt !== null && anchor && !anchor.snapshotOnly
      && validTime(at) && t >= anchor.t && t >= connectionReadyAt) {
    const start = Math.max(anchor.t, connectionReadyAt, t - EXP_SAMPLE_WINDOW_MS);
    if (t > start) {
      rateState.intervals.push({ start, end: t, gain: 0, source: 'online' });
      pruneExpSamples(t);
      statsDirty = true;
    }
  }
  connectionReady = false;
  connectionReadyAt = null;
  expObservationEnabled = false;
  invalidateExpRate();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  doSave();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  return true;
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
  pauseExpObservations,
  resumeExpObservations,
  setExpConnectionReady,
  getTodayKey,
  loadPersistedStats,
  checkAndResetDailyStats,
  getYesterdayStats,
  noteExpObservation,
  computeExpRate
};
