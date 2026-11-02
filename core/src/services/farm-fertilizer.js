const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { PlantPhase } = require('../config/config');
const { toNum, toTimeSec, getServerTimeSec, log, logWarn, randomDelay } = require('../utils/utils');
const { getAutomation } = require('../models/store');
const { recordOperation } = require('./stats');
const { getAllLands, fertilize, harvest, NORMAL_FERTILIZER_ID, ORGANIC_FERTILIZER_ID } = require('./farm-api');
const { getCurrentPhase } = require('./farm-land-analyzer');
const fs = require('fs');
const path = require('path');

/** 雷雨天联动施肥：仅在「雨落成诗」雷雨天气期间施肥 */
const RAIN_POEM_MODE = 'rain_poem';
/** 雷雨剩余时间低于该值视为「快结束」（收尾段，默认 300 秒） */
const RAIN_POEM_END_SECONDS_DEFAULT = 300;
/** 收尾段按生长时间判定有机肥：距下一阶段不足该秒数才施有机肥（默认 180 秒） */
const RAIN_POEM_ORGANIC_GAP_DEFAULT = 180;
/** 中段反应式施肥的「雷雨剩余下限」（默认 60 秒）。
 *  作物在雷雨中段「触发了下一阶段」时立即补普通肥以制造更多变异判定；
 *  若雷雨剩余已不足该秒数（临近结束），不再反应式施，留给收尾段统一保底，避免浪费普通肥额度。
 *  前端字段复用 fertilizer_rain_poem_wait_gap。 */
const RAIN_POEM_REACTIVE_REMAIN_DEFAULT = 60;

// 每块地上一轮看到的「阶段签名」与本季是否已施普通肥，用于检测阶段变换（中段反应式施肥）与跨轮去重
const rainPoemLandState = new Map(); // landId -> { sig, normalSeasonKey }

// ─── 常量 ───

/** 全部可施肥土地类型 */
const ALL_FERTILIZER_LAND_TYPES = ['purple', 'gold', 'black', 'red', 'normal'];

/** 土地类型中文标签 */
const FERTILIZER_LAND_TYPE_LABELS = {
  purple: '紫土地',
  gold: '金土地',
  black: '黑土地',
  red: '红土地',
  normal: '普通土地'
};

// ─── 辅助函数 ───

function isTransientNetworkError(err) {
  const msg = String(err && err.message || '');
  if (!msg) return false;
  return [
    '连接未打开', '请求超时', '请求已中断',
    '连接关闭', '发送失败', '请求队列已满'
  ].some(pattern => msg.includes(pattern));
}

/**
 * 有机化肥循环施肥（逐块施肥直到失败）
 * @param {number[]} landIds - 地块 ID 列表
 * @returns {number} 成功施肥次数
 */
async function fertilizeOrganicLoop(landIds) {
  const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
  if (ids.length === 0) return 0;

  let successCount = 0;
  let index = 0;
  while (true) {
    const landId = ids[index];
    try {
      const payload = types.FertilizeRequest.encode(types.FertilizeRequest.create({
        land_ids: [toNum(landId)],
        fertilizer_id: toNum(ORGANIC_FERTILIZER_ID)
      })).finish();
      await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', payload);
      successCount++;
    } catch {
      break;
    }
    index = (index + 1) % ids.length;
    await randomDelay(200, 300);
  }
  return successCount;
}

/**
 * 从地块列表获取可施有机肥的目标
 * @param {Array} lands - 地块数据列表
 * @returns {number[]} 可施有机肥的地块 ID
 */
function getOrganicFertilizerTargetsFromLands(lands) {
  const list = Array.isArray(lands) ? lands : [];
  const targets = [];
  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD) continue;

    // 检查剩余有机肥次数
    if (Object.hasOwn(plant, 'left_inorc_fert_times')) {
      const remaining = toNum(plant.left_inorc_fert_times);
      if (remaining <= 0) continue;
    }
    targets.push(landId);
  }
  return targets;
}

/**
 * 获取即将成熟的地块（用于智能施肥）
 * @param {Array} lands - 地块数据
 * @param {number} thresholdSec - 距成熟时间阈值（秒），默认 3600（1小时）
 */
function getFastMatureLands(lands, thresholdSec = 3600) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];
  const serverTime = getServerTimeSec();
  const threshold = Math.max(0, toNum(thresholdSec) || 3600);

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;
    if (currentPhase.phase === PlantPhase.DEAD) continue;
    if (currentPhase.phase === PlantPhase.MATURE) continue;

    // 查找成熟阶段
    const maturePhase = plant.phases
      .filter(p => p && toTimeSec(p.begin_time) > 0)
      .sort((left, right) => toTimeSec(right.begin_time) - toTimeSec(left.begin_time))[0];
    if (!maturePhase) continue;

    const matureTime = toTimeSec(maturePhase.begin_time);
    if (matureTime <= 0) continue;

    const remaining = matureTime - serverTime;
    if (remaining <= threshold && remaining >= 0) {
      // 检查剩余有机肥次数
      if (Object.hasOwn(plant, 'left_inorc_fert_times')) {
        const left = toNum(plant.left_inorc_fert_times);
        if (left <= 0) continue;
      }
      result.push(landId);
    }
  }
  return result;
}

/**
 * 获取处于成熟前最后一个生长阶段的地块（用于最终阶段施肥）
 * @param {Array} lands - 地块数据
 * @param {object} options - { organicOnly }
 * @returns {number[]} 最终阶段地块 ID
 */
function getFinalStageLands(lands, options = {}) {
  const list = Array.isArray(lands) ? lands : [];
  const result = [];
  const organicOnly = !!options.organicOnly;

  for (const land of list) {
    if (!land || !land.unlocked) continue;
    const landId = toNum(land.id);
    if (!landId) continue;

    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) continue;

    const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
    if (!currentPhase) continue;

    const currentPhaseValue = toNum(currentPhase.phase);
    if (currentPhaseValue === PlantPhase.DEAD) continue;
    if (currentPhaseValue === PlantPhase.MATURE) continue;

    const orderedPhases = plant.phases
      .map((phase, index) => ({
        phase,
        index,
        beginTime: toTimeSec(phase && phase.begin_time)
      }))
      .filter(item => item.beginTime > 0)
      .sort((a, b) => (a.beginTime - b.beginTime) || (a.index - b.index));

    const matureIndex = orderedPhases.findIndex(item => toNum(item.phase && item.phase.phase) === PlantPhase.MATURE);
    if (matureIndex <= 0) continue;

    const currentIndex = orderedPhases.findIndex(item => item.phase === currentPhase);
    if (currentIndex !== matureIndex - 1) continue;

    if (organicOnly && Object.hasOwn(plant, 'left_inorc_fert_times')) {
      const left = toNum(plant.left_inorc_fert_times);
      if (left <= 0) continue;
    }

    result.push(landId);
  }

  return result;
}

/** 根据等级获取土地类型 */
function getLandTypeByLevel(level) {
  const lv = toNum(level);
  if (lv === 5) return 'purple';   // 紫土地
  if (lv === 4) return 'gold';     // 金土地
  if (lv === 3) return 'black';    // 黑土地
  if (lv === 2) return 'red';      // 红土地
  return 'normal';
}

/** 标准化施肥土地类型列表 */
function normalizeFertilizerLandTypes(types) {
  const input = Array.isArray(types) ? types : ALL_FERTILIZER_LAND_TYPES;
  const result = [];
  for (const t of input) {
    const normalized = String(t || '').trim().toLowerCase();
    if (!ALL_FERTILIZER_LAND_TYPES.includes(normalized)) continue;
    if (result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

/** 按土地类型过滤地块 ID */
function filterLandIdsByTypes(landIds, landTypeMap, allowedTypes) {
  const ids = Array.isArray(landIds) ? landIds : [];
  const typeSet = new Set(normalizeFertilizerLandTypes(allowedTypes));
  if (typeSet.size === 0) return [];
  if (typeSet.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];

  const result = [];
  for (const landId of ids) {
    const landType = String(landTypeMap.get(landId) || '');
    if (!landType) continue;
    if (typeSet.has(landType)) result.push(landId);
  }
  return result;
}

/** 格式化土地类型为中文标签 */
function formatFertilizerLandTypes(types) {
  return normalizeFertilizerLandTypes(types).map(t => FERTILIZER_LAND_TYPE_LABELS[t] || t);
}

// ─── 核心施肥逻辑 ───

/**
 * 读取当前雷雨状态（雨落成诗活动）
 *
 * 闪电变异只在「生长阶段发生变换的瞬间」判定，因此所有施肥动作都必须
 * 落在雷雨窗口内。非雷雨期间本策略不施肥。
 *
 * @returns {{ rainstorm: boolean, remainSec: number }}
 */
async function getRainstormStatus() {
  try {
    // 延迟 require，避免与 activity.js 形成循环依赖
    const { getOwnWeatherStatus } = require('./activity');
    const status = await getOwnWeatherStatus();
    if (!status) return { rainstorm: false, remainSec: 0 };

    const rainstorm = status.rainstorm === true
      || String(status.status || '') === '2'
      || String(status.type || '') === '2';
    if (!rainstorm) return { rainstorm: false, remainSec: 0 };

    const nowSec = getServerTimeSec();
    const endSec = toTimeSec(status.endTime || status.end_time);
    const remainSec = endSec > nowSec ? endSec - nowSec : 0;
    return { rainstorm: remainSec > 0, remainSec };
  } catch (err) {
    if (isTransientNetworkError(err)) {
      // 网络抖动：保持上一帧雷雨状态，避免误判「雷雨结束」触发提前下降沿把累计清零。
      // 返回 remainSec 较大值，使本帧按中段反应式处理（不强制收尾），等下一帧恢复真实剩余时间。
      const accId = String(process.env.FARM_ACCOUNT_ID || '').trim();
      const prev = rainPushState.get(accId) || false;
      if (prev) {
        return { rainstorm: true, remainSec: 3600, uncertain: true };
      }
      return { rainstorm: false, remainSec: 0, uncertain: true };
    }
    logWarn('施肥', `雷雨天策略：获取天气状态失败（按非雷雨处理）: ${err.message}`, {
      module: 'farm', event: '雷雨天施肥', result: 'error'
    });
    return { rainstorm: false, remainSec: 0 };
  }
}

// 雷雨来临推送：每账号按「上升沿」推送（上一帧非雷雨→本帧雷雨只推一次），避免每轮轮询刷屏
const rainPushState = new Map(); // accountId -> 上次是否雷雨

function getRainPoemAccountName(accountId) {
  try {
    const { getAccounts } = require('../models/store');
    const { accounts = [] } = getAccounts() || {};
    const a = accounts.find(x => String(x.id) === String(accountId));
    if (a && a.name) return a.name;
  } catch { /* 忽略 */ }
  return accountId ? `账号${accountId}` : '未知账号';
}

async function notifyRainstormStart(remainSec) {
  try {
    const accId = String(process.env.FARM_ACCOUNT_ID || '').trim();
    const prev = rainPushState.get(accId) || false;
    if (prev) return; // 已在雷雨中，不重复推
    const name = getRainPoemAccountName(accId);
    const minutes = Math.max(1, Math.round(remainSec / 60));
    const title = `⛈️ 雷雨来临 · ${name}`;
    const content = `${name} 进入雷雨天，预计持续约 ${minutes} 分钟｜bot 已自动进入「反应式+收尾保底」施肥`;
    const { pushAlertMessage } = require('./friend-alert');
    await pushAlertMessage(title, content).catch(() => {});
  } catch { /* 推送失败不影响施肥流程 */ }
}

// 雷雨窗口状态：进入窗口开始累计，结束时汇总推送。
// 持久化到磁盘（每账号一个文件），跨 worker 重启 / 重连风暴 / 瞬时网络抖动都不丢累计。
const rainWindowState = new Map(); // accountId -> { startSec, midNormal, endNormal, organic, lightning, lightningLands:Set }

function getRainWindowPath(accId) {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, `rain-poem-window-${accId}.json`);
}

function loadRainWindow(accId) {
  try {
    const p = getRainWindowPath(accId);
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    if (!v || typeof v !== 'object') return null;
    return {
      startSec: toNum(v.startSec) || getServerTimeSec(),
      midNormal: toNum(v.midNormal), endNormal: toNum(v.endNormal),
      organic: toNum(v.organic), lightning: toNum(v.lightning),
      lightningLands: new Set(Array.isArray(v.lightningLands) ? v.lightningLands : []),
    };
  } catch {
    return null;
  }
}

function saveRainWindow(accId, w) {
  try {
    const p = getRainWindowPath(accId);
    if (!w) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    const ser = {
      startSec: w.startSec, midNormal: w.midNormal, endNormal: w.endNormal,
      organic: w.organic, lightning: w.lightning,
      lightningLands: [...(w.lightningLands || new Set())],
    };
    fs.writeFileSync(p, JSON.stringify(ser));
  } catch { /* 持久化失败不影响主流程 */ }
}

function initRainWindow(accId) {
  // 优先从磁盘恢复（防止中途 worker 重启丢累计）；若已有进行中的窗口则不覆盖，避免抖动重置
  let w = rainWindowState.get(accId);
  if (w) return false; // 内存中已有窗口（续接）
  const recovered = loadRainWindow(accId);
  if (recovered) {
    rainWindowState.set(accId, recovered);
    saveRainWindow(accId, recovered);
    return true; // 从磁盘恢复（worker 重启续接），不重新推送「雷雨来临」
  }
  w = {
    startSec: getServerTimeSec(),
    midNormal: 0, endNormal: 0, organic: 0, lightning: 0,
    lightningLands: new Set(),
  };
  rainWindowState.set(accId, w);
  saveRainWindow(accId, w);
  return false; // 全新窗口
}

function addWin(accId, key, n) {
  if (!accId || !n) return;
  const w = rainWindowState.get(accId);
  if (w) {
    w[key] = (w[key] || 0) + n;
    saveRainWindow(accId, w);
  }
}

async function notifyRainstormEnd(accId) {
  const w = rainWindowState.get(accId);
  rainWindowState.delete(accId); // 无论是否拿到数据都清，避免内存泄漏
  saveRainWindow(accId, null);   // 同步清理磁盘文件
  if (!w) return;
  const minutes = Math.max(1, Math.round((getServerTimeSec() - w.startSec) / 60));
  const name = getRainPoemAccountName(accId);
  const lightning = w.lightning > 0 ? `出现 ${w.lightning} 个 ✨` : '未出现';
  const title = `⛈️ 雷雨结束 · ${name}`;
  const content =
    `本次雷雨窗口（约 ${minutes} 分钟）：\n` +
    `· 中段反应式普通肥 ${w.midNormal} 块（制造变异判定）\n` +
    `· 收尾保底普通肥 ${w.endNormal} 块\n` +
    `· 有机肥 ${w.organic} 块\n` +
    `· 闪电变异：${lightning}`;
  const { pushAlertMessage } = require('./friend-alert');
  await pushAlertMessage(title, content).catch(() => {});
}

/**
 * 解析地块当前阶段与下一阶段信息
 * @returns {{ landId:number, phase:number, growing:boolean, phaseRemainSec:number, nextIsMature:boolean, hasNext:boolean }|null}
 */
function parseLandPhase(land) {
  if (!land) return null;
  const plant = land.plant;
  if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) return null;

  const currentPhase = getCurrentPhase(plant.phases, false, '', plant.id);
  if (!currentPhase) return null;

  const nowSec = getServerTimeSec();
  const phaseStartSec = toTimeSec(currentPhase.begin_time);

  // 下一阶段：begin_time 大于当前阶段起始时间的最小者
  const nextPhase = plant.phases
    .filter(p => p && toTimeSec(p.begin_time) > phaseStartSec)
    .sort((a, b) => toTimeSec(a.begin_time) - toTimeSec(b.begin_time))[0] || null;

  const nextStartSec = nextPhase ? toTimeSec(nextPhase.begin_time) : 0;
  const phaseRemainSec = nextStartSec > nowSec ? nextStartSec - nowSec : 0;

  const plantId = toNum(plant.id);
  const season = toNum(plant.season);
  // 阶段签名：作物 + 季 + 当前阶段枚举值。阶段变换或补种后签名变化，用于检测「触发了下一阶段」
  const sig = `${plantId}-${season}-${toNum(currentPhase.phase)}`;

  // 延迟 require，避免与 activity.js 形成循环依赖
  const { isLightningMutantPlant } = require('./activity');

  return {
    landId: toNum(land.id),
    plantId,
    season,
    sig,
    phase: currentPhase.phase,
    growing: currentPhase.phase !== PlantPhase.MATURE && currentPhase.phase !== PlantPhase.DEAD,
    phaseRemainSec,
    nextIsMature: nextPhase ? toNum(nextPhase.phase) === PlantPhase.MATURE : false,
    hasNext: !!nextPhase,
    lightningMutated: isLightningMutantPlant(plant)
  };
}

/**
 * 雷雨天联动施肥（雨落成诗活动专用策略）
 *
 * 核心原理：闪电变异在「生长阶段变换的瞬间」判定，因此要在雷雨窗口内
 * 制造尽可能多次的阶段变换，而不是单纯催熟。
 *
 * 规则（反应式 + 收尾保底）：
 * 1. 非雷雨期间不施肥（清空阶段签名，避免下次雷雨误判）；
 * 2. 中段（雷雨剩余 > endSeconds）：监测每块地的「阶段签名」。一旦检测到作物
 *    触发了下一阶段（签名变化，不区分是否成熟；成熟地块由巡田补种，补种后落入
 *    中段接管），且未闪电变异、本季普通肥未用、雷雨剩余充足 → 立即施普通肥，
 *    制造又一次阶段变换（更多变异判定机会）；
 *    若作物在剩余雷雨时间内「无法自然」到达下一阶段（phaseRemainSec > remainSec），
 *    同样主动施普通肥强制一次阶段变换，否则它整轮雷雨都拿不到闪电变异判定机会；
 * 3. 收尾（雷雨剩余 ≤ endSeconds）：对中段未触发变换（或已闪电变异）的地块
 *    统一保底补一次普通肥；
 * 4. 有机肥仅收尾段、且未闪电变异、且按生长时间（距下一阶段 ≤ organicGap）判定
 *    需催熟的地块施；普通肥后的作物已是全新阶段，不重复施有机肥。
 *
 * @param {object} automation - 自动化配置
 * @param {number[]} landTypes - 允许施肥的土地类型
 * @param {object} landTypeMap - 地块类型映射
 * @returns {{ normal: number, organic: number }}
 */
async function runRainPoemFertilizer(automation, landTypes, landTypeMap) {
  const endSeconds = Math.max(60, toNum(automation.fertilizer_rain_poem_end_seconds) || RAIN_POEM_END_SECONDS_DEFAULT);
  const organicGap = Math.max(30, toNum(automation.fertilizer_rain_poem_organic_gap) || RAIN_POEM_ORGANIC_GAP_DEFAULT);
  // 中段反应式施肥的「雷雨剩余下限」：作物触发下一阶段时立即施普通肥制造更多变异判定；
  // 若雷雨剩余已不足该秒数（临近结束），不再反应式施，留给收尾段统一保底，避免浪费普通肥额度。
  const reactiveRemain = Math.max(15, Math.min(600, toNum(automation.fertilizer_rain_poem_wait_gap) || RAIN_POEM_REACTIVE_REMAIN_DEFAULT));

  const accId = String(process.env.FARM_ACCOUNT_ID || '').trim();
  const prevRain = rainPushState.get(accId) || false;
  const { rainstorm, remainSec } = await getRainstormStatus();
  if (rainstorm && !prevRain) {
    // 上升沿：初始化本次窗口统计（从磁盘恢复则不重复推「雷雨来临」）
    const recovered = initRainWindow(accId);
    if (!recovered) await notifyRainstormStart(remainSec);
  } else if (!rainstorm && prevRain) {
    // 下降沿：本次窗口结束，汇总推送
    await notifyRainstormEnd(accId);
  }
  rainPushState.set(accId, rainstorm);
  if (!rainstorm) {
    // 非雷雨：清空阶段签名，避免下次雷雨一开始就误判「阶段变换」
    rainPoemLandState.clear();
    log('施肥', '雷雨天策略：当前非雷雨天气，跳过施肥（保留普通肥额度）', {
      module: 'farm', event: '雷雨天施肥', result: 'skip', reason: 'not_rainstorm'
    });
    return { normal: 0, organic: 0 };
  }

  const landsReply = await getAllLands();
  const lands = Array.isArray(landsReply && landsReply.lands) ? landsReply.lands : [];
  if (lands.length === 0) return { normal: 0, organic: 0 };

  const isAllTypes = landTypes.length === ALL_FERTILIZER_LAND_TYPES.length;

  // 只处理「成长中」的地块（成熟/枯死不参与变异判定；成熟地块等巡田补种后由下段逻辑接管）
  const candidates = [];
  for (const land of lands) {
    const info = parseLandPhase(land);
    if (!info || !info.growing || !info.landId) continue;
    if (!isAllTypes && landTypeMap.size > 0) {
      const type = landTypeMap.get(info.landId);
      if (!type || !landTypes.includes(type)) continue;
    }
    candidates.push(info);
  }

  // 本次窗口内首次出现闪电变异的地块计数（去重，按 landId；同一块地持续变异只算一次）
  if (accId) {
    const w = rainWindowState.get(accId);
    if (w) {
      for (const info of candidates) {
        if (info.lightningMutated && !w.lightningLands.has(info.landId)) {
          w.lightningLands.add(info.landId);
          w.lightning += 1;
        }
      }
    }
  }

  if (candidates.length === 0) {
    log('施肥', `雷雨天策略：无成长中作物（雷雨剩余 ${remainSec}s）`, {
      module: 'farm', event: '雷雨天施肥', result: 'skip', reason: 'no_growing', remainSec
    });
    return { normal: 0, organic: 0 };
  }

  let normalCount = 0;
  let organicCount = 0;
  const isEnd = remainSec <= endSeconds;

  const midNormalTargets = [];   // 中段反应式：作物触发下一阶段立即施
  const endNormalTargets = [];   // 收尾保底：中段未触发变换的地块
  const normalAppliedThisRound = new Set(); // 本轮已施普通肥的地块（有机肥去重用）

  // ── 依据本轮状态决定普通肥目标 ──
  for (const info of candidates) {
    const prev = rainPoemLandState.get(info.landId);
    const normalSeasonKey = `${info.plantId}-${info.season}`;
    const transitioned = !!prev && prev.sig !== info.sig;          // 阶段签名变化 = 触发了下一阶段
    const normalUsedThisSeason = !!prev && prev.normalSeasonKey === normalSeasonKey;
    // 本次轮询是否检测到阶段变换（用于标记「触发了下一阶段」，决定收尾保底是否跳过；跨雷雨由 clear() 重置）
    info.triggeredNextStage = transitioned || (prev ? !!prev.triggeredNextStage : false);

    if (isEnd) {
      // 收尾：中段未触发变换（含已闪电变异但触发过变换的）且本季普通肥未用过的地块保底施一次
      if (!info.triggeredNextStage && !normalUsedThisSeason) endNormalTargets.push(info.landId);
    } else {
      // 中段反应式：
      //  - 作物自然触发了下一阶段 → 立即补普通肥制造更多变异判定（原逻辑）；
      //  - 作物在剩余雷雨时间内「无法自然」到达下一阶段（phaseRemainSec > remainSec）→
      //    主动补普通肥强制一次阶段变换，否则它整轮雷雨都拿不到闪电变异判定机会
      //    （仅在未闪电变异、本季普通肥未用、雷雨剩余充足时执行，每季每地最多一次）
      const cannotNaturallyTransition = info.phaseRemainSec > remainSec;
      if ((transitioned || cannotNaturallyTransition) && !info.lightningMutated && !normalUsedThisSeason && remainSec >= reactiveRemain) {
        midNormalTargets.push(info.landId);
      }
    }
  }

  // ① 中段反应式普通肥：作物自然变换瞬间立即补普通肥，制造又一次阶段变换（更多闪电变异判定机会）
  if (midNormalTargets.length > 0) {
    const nowCount = await fertilize(midNormalTargets, NORMAL_FERTILIZER_ID);
    if (nowCount > 0) {
      normalCount += nowCount;
      addWin(accId, 'midNormal', nowCount);
      for (const id of midNormalTargets) normalAppliedThisRound.add(id);
      log('施肥', `雷雨天中段：为 ${nowCount} 块地补普通肥（自然触发下一阶段 / 主动强制变换），制造闪电变异判定（雷雨剩余 ${remainSec}s）`, {
        module: 'farm', event: '雷雨天施肥', result: 'ok', type: 'normal',
        count: nowCount, remainSec
      });
      recordOperation('fertilize', nowCount);
    }
  }

  // ② 收尾保底普通肥：中段未触发变换（或已闪电变异）的地块，统一补一次普通肥
  if (isEnd && endNormalTargets.length > 0) {
    const nowCount = await fertilize(endNormalTargets, NORMAL_FERTILIZER_ID);
    if (nowCount > 0) {
      normalCount += nowCount;
      addWin(accId, 'endNormal', nowCount);
      for (const id of endNormalTargets) normalAppliedThisRound.add(id);
      log('施肥', `雷雨天收尾：为 ${nowCount} 块地保底补普通肥（中段未触发变换），触发阶段变换判定（雷雨剩余 ${remainSec}s）`, {
        module: 'farm', event: '雷雨天施肥', result: 'ok', type: 'normal',
        count: nowCount, remainSec
      });
      recordOperation('fertilize', nowCount);
    }
  }

  // ③ 有机肥：仅收尾段、未闪电变异、且按生长时间（距下一阶段 ≤ organicGap）判定需催熟，且本轮未施普通肥
  //    （普通肥后作物已是全新生长阶段，phaseRemainSec 重新变大，不在此判定有机肥，避免与预期冲突）
  if (isEnd) {
    const organicTargets = [];
    for (const info of candidates) {
      if (info.lightningMutated) continue;                 // 已闪电变异不施有机肥
      if (!info.hasNext) continue;
      if (info.phaseRemainSec <= 0 || info.phaseRemainSec > organicGap) continue;
      if (normalAppliedThisRound.has(info.landId)) continue;
      organicTargets.push(info.landId);
    }
    if (organicTargets.length > 0) {
      organicCount = await fertilizeOrganicLoop(organicTargets);
      if (organicCount > 0) {
        addWin(accId, 'organic', organicCount);
        log('施肥', `雷雨天收尾：按生长时间为 ${organicCount} 块地（未闪电变异）施有机肥催熟，触发阶段变换判定（雷雨剩余 ${remainSec}s）`, {
          module: 'farm', event: '雷雨天施肥', result: 'ok', type: 'organic',
          count: organicCount, remainSec
        });
        recordOperation('fertilize', organicCount);
      }
    }
  }

  // ── 更新每块地的阶段签名与本季普通肥使用标记（供下次轮询检测变换 / 去重）──
  for (const info of candidates) {
    const normalSeasonKey = `${info.plantId}-${info.season}`;
    const usedNow = normalAppliedThisRound.has(info.landId);
    const prev = rainPoemLandState.get(info.landId);
    const prevNormalSeasonKey = prev ? prev.normalSeasonKey : null;
    const storedNormalSeasonKey = usedNow
      ? normalSeasonKey
      : (prevNormalSeasonKey === normalSeasonKey ? normalSeasonKey : prevNormalSeasonKey);
    rainPoemLandState.set(info.landId, {
      sig: info.sig,
      normalSeasonKey: storedNormalSeasonKey,
      triggeredNextStage: info.triggeredNextStage
    });
  }

  if (!isEnd) {
    log('施肥', `雷雨天中段：保留额度，反应式监测 ${candidates.length} 块地阶段变换（雷雨剩余 ${remainSec}s）`, {
      module: 'farm', event: '雷雨天施肥', result: 'wait', count: candidates.length, remainSec
    });
  }

  return { normal: normalCount, organic: organicCount };
}

/**
 * 根据配置执行施肥
 * @param {number[]} explicitLandIds - 指定地块 ID（空数组则自动获取）
 * @param {object} options - { reason, skipNormal }
 * @returns {{ normal: number, organic: number }}
 */
async function runFertilizerByConfig(explicitLandIds = [], options = {}) {
  const automation = getAutomation() || {};
  const mode = automation.fertilizer || 'none';
  const reason = String(options.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
  const label = reason === 'multi_season' ? '多季补肥' : '常规施肥';
  const eventLabel = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
  const landTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
  const landTypeLabels = formatFertilizerLandTypes(landTypes);

  if (reason === 'multi_season' && mode === 'final_normal') {
    log('施肥', '多季补肥：当前策略为最终阶段普通肥，跳过本轮多季补肥', {
      module: 'farm', event: eventLabel, result: 'skip', reason, type: 'normal'
    });
    return { normal: 0, organic: 0 };
  }

  const explicitIds = [...new Set(
    (Array.isArray(explicitLandIds) ? explicitLandIds : [])
      .map(id => toNum(id))
      .filter(Boolean)
  )];

  // 没有选中土地类型 → 跳过
  if (landTypes.length === 0) {
    log('施肥', `${label}：未勾选施肥范围，跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, scope: 'none'
    });
    return { normal: 0, organic: 0 };
  }

  const { skipNormal = false } = options;

  // 没有指定地块且非自动选地模式 → 空返回
  if (explicitIds.length === 0 &&
      mode !== 'organic' && mode !== 'both' &&
      mode !== 'smart' && mode !== 'smart_only' && mode !== 'smart_normal' &&
      mode !== 'final_normal' && mode !== 'final_organic' && mode !== RAIN_POEM_MODE) {
    return { normal: 0, organic: 0 };
  }

  // 获取全农场土地信息构建类型映射
  let allLands = [];
  const landTypeMap = new Map();
  try {
    const landsReply = await getAllLands();
    allLands = Array.isArray(landsReply && landsReply.lands) ? landsReply.lands : [];
    for (const land of allLands) {
      if (!land) continue;
      const landId = toNum(land.id);
      if (!landId) continue;
      landTypeMap.set(landId, getLandTypeByLevel(land.level));
    }
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('施肥', `${label}：获取土地信息失败，按已知地块继续: ${err.message}`, {
        module: 'farm', event: eventLabel, result: 'error', reason
      });
    }
  }

  const isAllTypes = landTypes.length === ALL_FERTILIZER_LAND_TYPES.length;

  if (landTypeMap.size === 0 && !isAllTypes) {
    logWarn('施肥', `${label}：无法确认土地类型，已跳过本轮施肥`, {
      module: 'farm', event: eventLabel, result: 'skip', reason, landTypes
    });
    return { normal: 0, organic: 0 };
  }

  let targetIds = explicitIds;
  if (landTypeMap.size > 0) {
    targetIds = filterLandIdsByTypes(explicitIds, landTypeMap, landTypes);
  }

  let normalCount = 0;
  let organicCount = 0;

  // 雷雨天联动施肥：仅在雷雨期间施肥，自身决定是否施普通肥/有机肥，
  // 不受巡田传入的 skipNormal 影响（后者是针对常规策略的节流）
  if (mode === RAIN_POEM_MODE) {
    return await runRainPoemFertilizer(automation, landTypes, landTypeMap);
  }

  // 普通化肥
  if (!skipNormal && (mode === 'normal' || mode === 'both' || mode === 'smart') && targetIds.length > 0) {
    normalCount = await fertilize(targetIds, NORMAL_FERTILIZER_ID);
    if (normalCount > 0) {
      log('施肥', `${label}：已为 ${normalCount}/${targetIds.length} 块地施普通化肥（范围: ${landTypeLabels.join('、')}）`, {
        module: 'farm', event: eventLabel, result: 'ok', reason, type: 'normal',
        count: normalCount, landTypes
      });
      recordOperation('fertilize', normalCount);
    }
  }

  // 有机化肥
  if (mode === 'organic' || mode === 'both') {
    let organicTargets = explicitIds;
    if (allLands.length > 0) {
      organicTargets = getOrganicFertilizerTargetsFromLands(allLands);
    }
    if (landTypeMap.size > 0) {
      organicTargets = filterLandIdsByTypes(organicTargets, landTypeMap, landTypes);
    }
    organicCount = await fertilizeOrganicLoop(organicTargets);
    if (organicCount > 0) {
      log('施肥', `${label}：有机化肥循环施肥完成，共施 ${organicCount} 次（范围: ${landTypeLabels.join('、')}）`, {
        module: 'farm', event: eventLabel, result: 'ok', reason, type: 'organic',
        count: organicCount, landTypes
      });
      recordOperation('fertilize', organicCount);
    }
  } else if (mode === 'smart' || mode === 'smart_only' || mode === 'smart_normal' ||
      mode === 'final_normal' || mode === 'final_organic') {
    // 智能/最终阶段施肥：寻找目标作物施肥
    let targetFertilizerLands = [];
    const isFinalStageMode = mode === 'final_normal' || mode === 'final_organic';
    const explicitIdSet = new Set(explicitIds);

    if (isFinalStageMode) {
      targetFertilizerLands = getFinalStageLands(allLands, { organicOnly: mode === 'final_organic' });
      if (explicitIdSet.size > 0) {
        targetFertilizerLands = targetFertilizerLands.filter(id => explicitIdSet.has(id));
      }
    } else {
      const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 3600;

      try {
        const landsReply = await getAllLands();
        targetFertilizerLands = getFastMatureLands(landsReply && landsReply.lands, smartSeconds);
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          logWarn('施肥', `获取全农场地块失败: ${err.message}`);
        }
      }
    }

    if (landTypeMap.size > 0) {
      targetFertilizerLands = filterLandIdsByTypes(targetFertilizerLands, landTypeMap, landTypes);
    }

    if (targetFertilizerLands.length > 0) {
      const useOrganic = mode === 'smart' || mode === 'smart_only' || mode === 'final_organic';
      const typeLabel = useOrganic ? '有机' : '普通';
      const fertId = useOrganic ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
      const modeLabel = isFinalStageMode ? '最终阶段' : '快成熟';

      if (useOrganic) {
        organicCount = await fertilizeOrganicLoop(targetFertilizerLands);
      } else {
        normalCount = await fertilize(targetFertilizerLands, fertId);
      }

      const totalCount = useOrganic ? organicCount : normalCount;
      if (totalCount > 0) {
        log('施肥', `${typeLabel}化肥${modeLabel}施肥完成，共施 ${totalCount} 次（范围: ${landTypeLabels.join('、')}）`, {
          module: 'farm', event: '施肥', result: 'ok',
          type: useOrganic ? 'organic' : 'normal', count: totalCount
        });
        recordOperation('fertilize', totalCount);
      }
    }
  }

  return { normal: normalCount, organic: organicCount };
}

module.exports = {
  ALL_FERTILIZER_LAND_TYPES,
  FERTILIZER_LAND_TYPE_LABELS,
  runFertilizerByConfig
};
