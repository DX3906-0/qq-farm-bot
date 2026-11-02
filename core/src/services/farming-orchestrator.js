const { CONFIG } = require('../config/config');
const { getUserState, isConnected, networkEvents } = require('../utils/network');
const { toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { isAutomationOn, getAutomation, getPrioritize2x2Crops, getHarvestPacing, setHarvestPacing } = require('../models/store');
const { getCanGetHelpExp } = require('./friend-operation-limits');
const { recordOperation } = require('./stats');
const { createScheduler } = require('./scheduler');
const { getAllLands, harvest, farming, unlockLand, upgradeLand } = require('./farm-api');
const { analyzeLands, resolveRemovableHarvestedLands } = require('./farm-land-analyzer');
const { runFertilizerByConfig } = require('./farm-fertilizer');
const { autoPlantEmptyLands } = require('./planting-service');
const { startFertilizerBuyCheckTimer, stopFertilizerBuyCheckTimer } = require('./farm-scheduler');
const { refreshExpAfterHarvest } = require('./exp-refresh');

/**
 * 收获后顺带刷新一次真实经验（fire-and-forget）。
 * 为什么不在这里 await：经验刷新只是为了让面板「效率/升级预测」有真数据，
 * 失败或超时都不该拖住农场主循环。exp-refresh 内部有 3 分钟节流，
 * 连收多块地不会放大请求量。
 */
function scheduleExpRefresh(reason) {
  try {
    const gid = toNum(getUserState().gid);
    if (!gid) return;
    Promise.resolve(refreshExpAfterHarvest({ gid })).then((r) => {
      if (r && r.exp > 0) {
        log('统计', `经验已同步: ${r.exp}（${reason}）`, {
          module: 'stats', event: '经验同步', result: 'ok', exp: r.exp, reason,
        });
      }
    }).catch(() => { /* exp-refresh 内部已兜底，这里只防未捕获 */ });
  } catch { /* 不影响主流程 */ }
}

// ─── 状态标记 ───

let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
let lastPushTime = 0;
let shouldRefresh2x2Plan = true;
// 延迟收获「留田等待」日志节流：等待中每 60s 才打一次，避免巡田刷屏
let lastHarvestWaitLogAt = 0;
const HARVEST_WAIT_LOG_INTERVAL_MS = 60 * 1000;
// 统一时间收获可能一等就是几个小时。固定时间间隔不合理（等 6h 要刷 24 条、等 10min 又只有 1 条），
// 改为**按进度百分比**推进：每走过 UNIFIED_WAIT_LOG_PERCENT_STEP% 打一条，
// 于是无论等 10 分钟还是 6 小时，全程都只有 ~10 条，信息密度均匀。
// 另留一个时间兜底：目标成熟时刻可能因「中途补种/施肥」而后移导致进度回退、
// 长时间打不出新百分比，此时距上条超过 UNIFIED_WAIT_LOG_FALLBACK_MS 也补一条，避免彻底静默。
const UNIFIED_WAIT_LOG_PERCENT_STEP = 10;
const UNIFIED_WAIT_LOG_FALLBACK_MS = 10 * 60 * 1000;

// 「统一时间收获」等待最后一块地成熟的上限：超过这个时长还没等到就按当前已成熟的一键收，
// 防止作物长期留田枯死（游戏有 PlantPhase.DEAD）。6h 足够覆盖任何正常种植周期。
const UNIFIED_MAX_WAIT_MS = 6 * 60 * 60 * 1000;

const farmScheduler = createScheduler('farm');

// ─── 延迟收获「静默去抖 + 上限」节奏工具 ───

/** 在 baseSec 附近 ±20% 抖动（像真人，避免精确整数指纹）。baseSec<=0 返回 0。 */
function jitterSilenceSec(baseSec) {
  if (baseSec <= 0) return 0;
  const min = Math.floor(baseSec * 0.8);
  const max = Math.ceil(baseSec * 1.2);
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ─── 「统一时间收获」模式开关 ───

/**
 * 开启统一时间收获：记下 mode='unified'，之后每轮巡田都会等
 * 「当前所有土地中最后一块地成熟」，再按延迟收获规则统一一键收取。
 */
function startUnifiedHarvest() {
  const existing = getHarvestPacing() || {};
  const next = {
    ...existing,
    mode: 'unified',
    unifiedStartAt: Date.now(),
  };
  setHarvestPacing(next);
  log('收获', '已开启统一时间收获：将等待最后一块地成熟后统一一键收取', {
    module: 'farm', event: '统一时间收获', result: 'ok'
  });
  return getHarvestPacing();
}

/** 取消统一时间收获（回到常规收获节奏）。 */
function cancelUnifiedHarvest() {
  const existing = getHarvestPacing();
  if (!existing || existing.mode !== 'unified') return null;
  setHarvestPacing(null);
  log('收获', '已取消统一时间收获', {
    module: 'farm', event: '统一时间收获', result: 'ok'
  });
  return null;
}

/** 当前是否处于统一时间收获等待中。 */
function isUnifiedHarvestActive() {
  const pacing = getHarvestPacing();
  return !!(pacing && pacing.mode === 'unified');
}

// ─── 辅助函数 ───

/** 判断是否为临时性网络错误 */
function isTransientNetworkError(err) {
  const msg = String(err && err.message || '');
  if (!msg) return false;
  return [
    '连接未打开', '请求超时', '请求已中断',
    '连接关闭', '发送失败', '请求队列已满'
  ].some(pattern => msg.includes(pattern));
}

// ─── 核心巡田逻辑 ───

/**
 * 检查并执行农场操作
 * @returns {boolean} 是否有需要执行的操作
 */
async function checkFarm() {
  const userState = getUserState();
  if (isCheckingFarm || !userState.gid || !isAutomationOn('farm') || !isConnected()) {
    return false;
  }

  isCheckingFarm = true;
  try {
    const result = await runFarmOperation('all');
    isFirstFarmCheck = false;
    return !!(result && result.hadWork);
  } catch (err) {
    if (!isTransientNetworkError(err)) {
      logWarn('巡田', `检查失败: ${err.message}`);
    }
    return false;
  } finally {
    isCheckingFarm = false;
  }
}

/**
 * 执行农场操作
 * @param {string} opType - 操作类型：'all' | 'harvest' | 'plant' | 'clear' | 'upgrade'
 */
async function runFarmOperation(opType) {
  const landsReply = await getAllLands();
  if (!landsReply.lands || landsReply.lands.length === 0) {
    if (opType !== 'all') log('农场', '没有土地数据');
    return { hadWork: false, actions: [] };
  }

  const lands = landsReply.lands;
  const analysis = analyzeLands(lands, isFirstFarmCheck);
  const labels = [];

  // 构建状态标签
  if (analysis.harvestable.length) labels.push(`收:${  analysis.harvestable.length}`);
  if (analysis.needWeed.length) labels.push(`草:${  analysis.needWeed.length}`);
  if (analysis.needBug.length) labels.push(`虫:${  analysis.needBug.length}`);
  if (analysis.needGoldenBug.length) labels.push(`金虫:${  analysis.needGoldenBug.length}`);
  if (analysis.needWater.length) labels.push(`水:${  analysis.needWater.length}`);
  if (analysis.dead.length) labels.push(`枯:${  analysis.dead.length}`);
  if (analysis.empty.length) labels.push(`空:${  analysis.empty.length}`);
  if (analysis.unlockable.length) labels.push(`解:${  analysis.unlockable.length}`);
  if (analysis.upgradable.length) labels.push(`升:${  analysis.upgradable.length}`);
  labels.push(`长:${  analysis.growing.length}`);

  const actions = [];

  // ── 一键务农（浇水/除草/除虫）──
  if (opType === 'all' || opType === 'clear') {
    // 不除自己草虫：默认「总是跳过」(skip_own_weed_bug)；
    // 若开启「经验满不除自己草虫」(skip_own_weed_bug_when_exp_full)，则当帮助经验已达上限
    // (getCanGetHelpExp 为 false，与好友「经验满只帮护主犬」同一状态) 时才跳过，未达上限仍照常除。
    const skipOwnWeedBug = opType === 'all' && (
      isAutomationOn('skip_own_weed_bug') ||
      (isAutomationOn('skip_own_weed_bug_when_exp_full') && !getCanGetHelpExp())
    );
    const ordinaryLandIds = skipOwnWeedBug
      ? [...analysis.needWater]
      : [...analysis.needWeed, ...analysis.needBug, ...analysis.needWater];
    const goldenBugLandIds = isAutomationOn('golden_bug_clear')
      ? analysis.needGoldenBug
      : [];
    const farmingLandIds = [...new Set([...ordinaryLandIds, ...goldenBugLandIds])];

    if (farmingLandIds.length > 0) {
      try {
        await farming(farmingLandIds);
        const parts = [];
        // 除草/除虫单独计入统计（原先只合计为 farming，导致面板「除草/除虫」恒为 0）
        if (!skipOwnWeedBug && analysis.needWeed.length > 0) {
          parts.push(`草${analysis.needWeed.length}`);
          recordOperation('weed', analysis.needWeed.length);
        }
        if (!skipOwnWeedBug && analysis.needBug.length > 0) {
          parts.push(`虫${analysis.needBug.length}`);
          recordOperation('bug', analysis.needBug.length);
        }
        if (analysis.needWater.length > 0) parts.push(`水${analysis.needWater.length}`);
        if (goldenBugLandIds.length > 0) {
          parts.push(`黄金虫${goldenBugLandIds.length}`);
          recordOperation('goldenBugClear', goldenBugLandIds.length);
        }
        actions.push(`一键务农${parts.join('/')}`);
        recordOperation('farming', farmingLandIds.length);
      } catch (err) { logWarn('一键务农', err.message); }
    }
  }

  // ── 收获 ──
  let harvestedLands = [];
  let harvestResult = null;
  let removeResult = null;

  if (opType === 'all' || opType === 'harvest') {
    const now = Date.now();
    const delayMin = toNum(getAutomation()?.harvest_delay_min || 0);
    const unifiedActive = isUnifiedHarvestActive();

    // ── 统一时间收获：先等「当前所有土地中最后一块地成熟」 ──
    // lastMatureAt=0 表示已经没有在长的作物，无需再等。
    let unifiedWaiting = false;
    if (unifiedActive) {
      const pacing = getHarvestPacing();
      const lastMatureAt = toNum(analysis.lastMatureAt) || 0;
      const allMature = lastMatureAt === 0 || lastMatureAt * 1000 <= now;
      const capMet = now - (pacing && pacing.unifiedStartAt ? pacing.unifiedStartAt : now) >= UNIFIED_MAX_WAIT_MS;

      if (!allMature && !capMet) {
        unifiedWaiting = true;
        // 进度百分比：以「开启时刻 → 最后一块地成熟时刻」为 0~100%
        const startAt = (pacing && pacing.unifiedStartAt) ? pacing.unifiedStartAt : now;
        const targetAt = lastMatureAt * 1000;
        const span = targetAt - startAt;
        const percent = span > 0
          ? Math.max(0, Math.min(100, Math.round((now - startAt) / span * 100)))
          : 100;
        const lastPercent = (pacing && pacing.lastLoggedPercent) || 0;

        const percentAdvanced = percent - lastPercent >= UNIFIED_WAIT_LOG_PERCENT_STEP;
        const fallbackDue = now - ((pacing && pacing.lastLogAt) || 0) >= UNIFIED_WAIT_LOG_FALLBACK_MS
          && percent > lastPercent;
        if (percentAdvanced || fallbackDue) {
          const waitedMin = Math.max(0, Math.round((now - startAt) / 60000));
          const remainMin = Math.max(0, Math.round((targetAt - now) / 60000));
          log('收获', `统一时间收获等待中：进度 ${percent}%（已等 ${waitedMin}min，最后一块地还需 ${remainMin}min；上限 ${Math.round(UNIFIED_MAX_WAIT_MS / 60000)}min 后强制收）`, {
            module: 'farm', event: '统一时间收获等待', result: 'waiting',
            percent, waitedMin, remainMin
          });
          // 落盘进度基线：worker 重启后接着算，不会从 0 重新打一遍
          setHarvestPacing({
            ...pacing,
            mode: 'unified',
            lastLoggedPercent: percent,
            lastLogAt: now,
          });
        }
      }
      else if (analysis.harvestable.length === 0) {
        // 到点却无可收的（全被铲除/枯死）→ 退出统一模式，回到常规节奏
        setHarvestPacing(null);
      }
    }

    if (!unifiedWaiting && analysis.harvestable.length > 0) {
      const currentIds = analysis.harvestable.map(id => toNum(id)).filter(Boolean);

      if (delayMin > 0) {
        // 延迟收获「静默去抖 + 上限」闸门：
        //  - 有新成熟（与上一轮差集非空）→ 静默计时清零
        //  - 连续 pendingSilenceSec（在 delayMin 附近 ±20% 抖动）无新成熟 → 收
        //  - 距等待起点超「设置值 + 30min」上限 → 无视静默，强制收（兜枯死）
        // 收割用一键 is_all，收掉当前全部成熟（含期间新成熟的），最像真人。
        const pacing = getHarvestPacing() || {
          waitStartAt: 0, lastNewMatureAt: 0, pendingSilenceSec: 0, seenHarvestable: []
        };
        const seenSet = new Set(pacing.seenHarvestable || []);
        const newOnes = currentIds.filter(id => !seenSet.has(id));
        let { waitStartAt, lastNewMatureAt, pendingSilenceSec } = pacing;
        let changed = false;

        if (newOnes.length > 0) {
          lastNewMatureAt = now;   // 发现新成熟 → 静默计时清零（waitStartAt 保持最早等待起点）
          changed = true;
        }
        if (!waitStartAt) {
          waitStartAt = now;
          lastNewMatureAt = now;   // 首次进入等待必须同步初始化，否则静默立即满足
          changed = true;
        }
        if (!pendingSilenceSec) {
          pendingSilenceSec = jitterSilenceSec(delayMin * 60);  // 本周期固定一次抖动
          changed = true;
        }
        for (const id of currentIds) seenSet.add(id);
        const seenHarvestable = [...seenSet];

        const silenceMet = now - lastNewMatureAt >= pendingSilenceSec * 1000;
        const capMs = (delayMin + 30) * 60 * 1000;             // 上限 = 设置值 + 30min
        const capMet = now - waitStartAt >= capMs;

        if (silenceMet || capMet) {
          // 到点 → 一键收全部（is_all 自动含期间新成熟的）
          try {
            harvestResult = await harvest(currentIds);
            log('收获', capMet ? `到达留田上限 ${delayMin + 30}min，强制一键收获 ${currentIds.length} 块`
                               : `静默 ${Math.round(pendingSilenceSec / 60)}min 无新成熟，一键收获 ${currentIds.length} 块`, {
              module: 'farm', event: '收获作物', result: 'ok',
              count: currentIds.length, landIds: currentIds, reason: capMet ? 'cap' : 'silence'
            });
            actions.push(`收获${currentIds.length}`);
            recordOperation('harvest', currentIds.length);
            scheduleExpRefresh('一键收获');
            harvestedLands = [...currentIds];

            networkEvents.emit('farmHarvested', {
              count: currentIds.length,
              landIds: [...currentIds],
              opType
            });
          } catch (err) {
            logWarn('收获', err.message, { module: 'farm', event: '收获作物', result: 'error' });
            // 收割失败不清空 pacing，下轮重试（此时 silenceMet/capMet 仍满足）
          }
          if (harvestResult) {
            setHarvestPacing(null);   // 清空节奏，进入下一周期（重新抖动）
          }
        } else {
          // 留田等待：仅当状态有变化（新成熟/首进/抽抖动）才落盘，避免每轮写盘
          if (changed) {
            // 必须透传 mode/unifiedStartAt，否则统一时间收获模式会在静默等待中被悄悄关掉
            setHarvestPacing({
              ...pacing,
              mode: pacing.mode || 'silence',
              waitStartAt, lastNewMatureAt, pendingSilenceSec, seenHarvestable
            });
          }
          // 节流日志：等待中每 60s 才打一次
          if (now - lastHarvestWaitLogAt >= HARVEST_WAIT_LOG_INTERVAL_MS) {
            lastHarvestWaitLogAt = now;
            const remainingSilence = Math.max(0, Math.round((pendingSilenceSec * 1000 - (now - lastNewMatureAt)) / 1000));
            const remainingCap = Math.max(0, Math.round((capMs - (now - waitStartAt)) / 1000));
            log('收获', `延迟收获留田等待 ${currentIds.length} 块成熟（静默还剩 ${Math.round(remainingSilence / 60)}min / 上限还剩 ${Math.round(remainingCap / 60)}min）`, {
              module: 'farm', event: '延迟收获等待', result: 'waiting',
              count: currentIds.length,
              pendingSilenceSec, capMs
            });
          }
        }
      } else {
        // 未开启延迟（delay_min=0）：保持老行为，立即一键收获
        try {
          harvestResult = await harvest(analysis.harvestable);
          log('收获', unifiedActive
            ? `统一时间收获：全部作物已成熟，一键收获 ${analysis.harvestable.length} 块土地`
            : `收获完成 ${analysis.harvestable.length} 块土地`, {
            module: 'farm', event: '收获作物', result: 'ok',
            count: analysis.harvestable.length, landIds: [...analysis.harvestable],
            ...(unifiedActive ? { reason: 'unified' } : {})
          });
          actions.push(`收获${analysis.harvestable.length}`);
          recordOperation('harvest', analysis.harvestable.length);
          scheduleExpRefresh('农场循环收获');
          harvestedLands = [...analysis.harvestable];

          networkEvents.emit('farmHarvested', {
            count: analysis.harvestable.length,
            landIds: [...analysis.harvestable],
            opType
          });
        } catch (err) {
          logWarn('收获', err.message, { module: 'farm', event: '收获作物', result: 'error' });
        }
        // 统一时间收获是一次性任务：收完就退出，回到常规节奏
        if (harvestResult && unifiedActive) {
          setHarvestPacing(null);
        }
      }
    }
  }

  // ── 种植 ──
  if (opType === 'all' || opType === 'plant') {
    const emptyLands = [...new Set(analysis.empty)];
    let deadLands = [...new Set(analysis.dead)];

    // 收获后检查可铲除的地块
    if (opType === 'all' && harvestedLands.length > 0) {
      await randomDelay(200, 800);
      removeResult = await resolveRemovableHarvestedLands(harvestedLands, harvestResult);
      deadLands = [...new Set([...deadLands, ...removeResult.removable])];
    }

    const shouldRefresh2x2 = shouldRefresh2x2Plan && getPrioritize2x2Crops();
    if (deadLands.length > 0 || emptyLands.length > 0 || shouldRefresh2x2) {
      try {
        const plantResult = await autoPlantEmptyLands(deadLands, emptyLands, lands);
        const removedCount = Number(plantResult && plantResult.removedCount) || 0;
        const plantedCount = Number(plantResult && (plantResult.occupiedCount || plantResult.plantedCount)) || 0;
        if (removedCount > 0) {
          actions.push(`铲除${  removedCount}`);
        }
        if (plantedCount > 0) {
          actions.push(`种植${  plantedCount}`);
          recordOperation('plant', plantedCount);
        }
      } catch (err) {
        logWarn('种植', err.message);
      } finally {
        shouldRefresh2x2Plan = false;
      }
    }
  }

  // ── 多季作物补肥 ──
  if (opType === 'all' && removeResult && Array.isArray(removeResult.growing) &&
      removeResult.growing.length > 0 && isAutomationOn('fertilizer_multi_season') &&
      (getAutomation().fertilizer || 'none') !== 'final_normal') {
    const multiSeasonLands = [...new Set(
      removeResult.growing.map(id => toNum(id)).filter(Boolean)
    )];
    if (multiSeasonLands.length > 0) {
      log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonLands.length} 块`, {
        module: 'farm', event: '多季节施肥', result: 'trigger',
        count: multiSeasonLands.length, landIds: multiSeasonLands
      });
      try {
        await runFertilizerByConfig(multiSeasonLands, { reason: 'multi_season' });
      } catch (err) {
        logWarn('施肥', `多季补肥执行失败: ${err.message}`, {
          module: 'farm', event: '多季节施肥', result: 'error'
        });
      }
    }
  }

  // ── 土地升级/解锁 ──
  const shouldUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
  if (shouldUpgrade || opType === 'upgrade') {
    // 解锁土地
    if (analysis.unlockable.length > 0) {
      let unlockedCount = 0;
      for (const landId of analysis.unlockable) {
        try {
          await unlockLand(landId, false);
          log('解锁', `土地#${landId} 解锁成功`, {
            module: 'farm', event: '解锁土地', result: 'ok', landId
          });
          unlockedCount++;
        } catch (err) {
          logWarn('解锁', `土地#${landId} 解锁失败: ${err.message}`, {
            module: 'farm', event: '解锁土地', result: 'error', landId
          });
        }
        await randomDelay(200, 500);
      }
      if (unlockedCount > 0) actions.push(`解锁${  unlockedCount}`);
    }

    // 升级土地
    if (analysis.upgradable.length > 0) {
      let upgradedCount = 0;
      for (const landId of analysis.upgradable) {
        try {
          const result = await upgradeLand(landId);
          const newLevel = result.land ? toNum(result.land.level) : '?';
          log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
            module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
          });
          upgradedCount++;
        } catch (err) {
          log('升级', `土地#${landId} 升级失败: ${err.message}`, {
            module: 'farm', event: '升级土地', result: 'error', landId
          });
        }
        await randomDelay(200, 500);
      }
      if (upgradedCount > 0) {
        actions.push(`升级${  upgradedCount}`);
        recordOperation('upgrade', upgradedCount);
      }
    }
  }

  // ── 智能施肥（巡田时触发）──
  if (opType === 'all') {
    const fertilizerMode = getAutomation().fertilizer || 'none';
    if (fertilizerMode === 'smart' || fertilizerMode === 'smart_only' || fertilizerMode === 'smart_normal' ||
        fertilizerMode === 'final_normal' || fertilizerMode === 'final_organic') {
      try {
        const fertResult = await runFertilizerByConfig([], { skipNormal: true });
        if (fertResult.organic > 0) actions.push(`有机肥${  fertResult.organic}`);
        else if (fertResult.normal > 0) actions.push(`普通肥${  fertResult.normal}`);
      } catch (err) {
        logWarn('施肥', `巡田时施肥失败: ${err.message}`);
      }
    }
  }

  // ── 日志输出 ──
  const summary = actions.length > 0 ? ` → ${actions.join('/')}` : '';
  if (actions.length > 0) {
    log('农场', `[${labels.join(' ')}]${summary}`, {
      module: 'farm', event: '农场循环', opType, actions
    });
  }

  return { hadWork: actions.length > 0, actions };
}

// ── 定时巡田循环 ──

function scheduleNextFarmCheck(intervalMs = CONFIG.farmCheckInterval) {
  if (externalSchedulerMode) return;
  if (!farmLoopRunning) return;
  farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, intervalMs), async () => {
    if (!farmLoopRunning) return;
    await checkFarm();
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(CONFIG.farmCheckInterval);
  });
}

function startFarmCheckLoop(options = {}) {
  if (farmLoopRunning) return;
  externalSchedulerMode = !!options.externalScheduler;
  farmLoopRunning = true;
  shouldRefresh2x2Plan = true;
  networkEvents.on('landsChanged', onLandsChangedPush);
  if (!externalSchedulerMode) scheduleNextFarmCheck(1000); // 1 秒后首次检查
  startFertilizerBuyCheckTimer();
}

/** 收到地块变化推送时的响应 */
function onLandsChangedPush(lands) {
  if (!isAutomationOn('farm_push')) return;
  shouldRefresh2x2Plan = true;
  if (isCheckingFarm) return;
  const now = Date.now();
  if (now - lastPushTime < 500) return; // 500ms 去抖
  lastPushTime = now;
  log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
    module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
  });
  farmScheduler.setTimeoutTask('farm_push_check', 1000, async () => {
    if (!isCheckingFarm) await checkFarm();
  });
}

function stopFarmCheckLoop() {
  farmLoopRunning = false;
  externalSchedulerMode = false;
  farmScheduler.clearAll();
  networkEvents.removeListener('landsChanged', onLandsChangedPush);
  stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs = 0) {
  if (!farmLoopRunning) return;
  shouldRefresh2x2Plan = true;
  scheduleNextFarmCheck(delayMs);
}

module.exports = {
  checkFarm,
  runFarmOperation,
  startFarmCheckLoop,
  stopFarmCheckLoop,
  refreshFarmCheckLoop,
  startUnifiedHarvest,
  cancelUnifiedHarvest,
  isUnifiedHarvestActive
};
