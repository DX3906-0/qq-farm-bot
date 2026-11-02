const process = require('node:process');
const { parentPort, workerData } = require('node:worker_threads');

const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const {
    getAutomation,
    getPreferredSeed,
    getConfigSnapshot,
    applyConfigSnapshot,
    getInactiveActivityAutomationKeys,
    getHarvestPacing
} = require('../models/store');
const {
    checkAndClaimEmails,
    notifyNewSystemEmails,
    getEmailDailyState
} = require('../services/email');
const { sendDailyReport } = require('../services/daily-report');
const { initLocalBadCount } = require('../services/friend-operation-limits');
const {
    checkFarm,
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation,
    startUnifiedHarvest,
    cancelUnifiedHarvest,
    isUnifiedHarvestActive,
    runFertilizerByConfig,
    ORGANIC_FERTILIZER_ID,
    fertilize,
    removePlant
} = require('../services/farm');
const {
    checkFriends,
    runDueStealPlans,
    startFriendCheckLoop,
    stopFriendCheckLoop,
    refreshFriendCheckLoop,
    runBadOnceOnStartup,
    runBadHourly,
    runGoldenBugPlacement,
    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
    getFriendDogInfo,
    batchGetFriendDogInfo,
    syncFriendsFromGids,
    bootstrapQqFriendGids,
    fetchFriendsDogInfo,
    delFriend
} = require('../services/friend');
const { getInteractRecords } = require('../services/interact');
const { processInviteCodes } = require('../services/invite');
const { notifyCodeExpired } = require('../services/friend-alert');
const {
    autoBuyFertilizer,
    checkAndBuyFertilizerBoth,
    buyFreeGifts,
    getFreeGiftDailyState
} = require('../services/mall');
const {
    performDailyMonthCardGift,
    getMonthCardDailyState
} = require('../services/monthcard');
const {
    performDailyVipGift,
    getVipDailyState
} = require('../services/qqvip');
const {
    createScheduler,
    getSchedulerRegistrySnapshot
} = require('../services/scheduler');
const {
    performDailyShare,
    getShareDailyState
} = require('../services/share');
const {
    recordOperation,
    initStatsWithPersistence,
    saveStats
} = require('../services/stats');
const {
    initStatusBar,
    setStatusPlatform,
    setRecordGoldExpHook,
    statusData
} = require('../services/status');
const {
    cleanupTaskSystem,
    checkAndClaimTasks,
    getTaskClaimDailyState,
    getTaskDailyStateLikeApp,
    getGrowthTaskStateLikeApp
} = require('../services/task');
const {
    sellAllFruits,
    getBag,
    getBagItems,
    openFertilizerGiftPacksSilently
} = require('../services/warehouse');
const {
    connect,
    stopNetwork,
    getWs,
    getUserState,
    isConnected,
    networkEvents,
    // ⭐ 亚健康退避闸门（2026-11-01）：传输层统一拦截业务请求
    setHealthBackoff,
    clearHealthBackoff
} = require('../utils/network');
const { loadProto } = require('../utils/proto');
const { runWithRequestPriority } = require('../utils/request-priority');
const { setLogHook, log, toNum } = require('../utils/utils');

// 设置环境变量中的账号ID
if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

// ==================== IPC 通信 ====================

/** 发送消息给主进程 */
function sendToMaster(message) {
    if (process.send) {
        process.send(message);
        return;
    }
    if (parentPort) {
        parentPort.postMessage(message);
    }
}

/** 监听主进程消息 */
function onMasterMessage(handler) {
    if (process.send) process.on('message', handler);
    if (parentPort) parentPort.on('message', handler);
}

/** 退出 Worker 进程 */
function exitWorker(code = 0) {
    if (parentPort) {
        try { parentPort.close(); } catch { }
    }
    setImmediate(() => process.exit(code));
}

// ==================== 格式化工具 ====================

function pad2(num) {
    return String(num).padStart(2, '0');
}

function formatLocalDateTime24(date = new Date()) {
    const d = date instanceof Date ? date : new Date();
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const min = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${yyyy  }-${  mm  }-${  dd  } ${  hh  }:${  min  }:${  ss}`;
}

// ==================== 日志/统计钩子 ====================

setLogHook((tag, msg, isWarn, meta) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            meta: meta || {}
        }
    });
});

setRecordGoldExpHook((gold, exp) => {
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);
    sendToMaster({
        type: 'stat_update',
        data: { gold, exp }
    });
});

// ==================== 全局状态 ====================

let isRunning = false;
let loginReady = false;
let appliedConfigRevision = 0;
let unifiedSchedulerRunning = false;

// ===== 网关亚健康退避（防凌晨假死判死）=====
// 网关进程检测到业务请求连续超时(亚健康)时发 connection_degraded，worker 进入退避窗口：
// 这段时间不再主动发农场/帮助/偷菜等业务请求，把连接留给心跳+ACE 自愈，避免 pending 打满挤掉心跳。
// 业务恢复(connection_recovered)或退避到期后自动恢复自动化。
let gatewayHealthBackoffUntil = 0;
let gatewayHealthBackoffReason = '';

// ==================== 工具函数 ====================

/** 判断是否是瞬时网络错误（可忽略） */
function isTransientNetworkError(err) {
    const msg = String(err && err.message || '');
    if (!msg) return false;
    return ['连接未打开', '请求超时', '请求已中断', '连接关闭', '发送失败', '请求队列已满']
        .some(text => msg.includes(text));
}

// ==================== 农场/好友/偷菜 Tick 任务 ====================

let farmTaskRunning = false;
let nextFarmRunAt = 0;
let lastStatusHash = '';
let lastStatusSentAt = 0;
let onSellGain = null;
let onFarmHarvested = null;
let onDogSkillGiftPending = null;
let harvestSellRunning = false;
let onWsError = null;
let onDisconnectHandler = null;
// ===== 网关重连状态（2026-11-01）=====
// 提升到模块级而非 startBot 内部：stopBot 需要能清理这些 timer，
// 否则用户点「停止」后已排队的重连仍会跑一轮，表现为"停了又自己起来"。
let gatewayReconnectTimer = null;      // 退避等待定时器
let gatewayReconnectWatchdog = null;   // 单轮 connect 的超时看门狗
let gatewayReconnectInFlight = false;  // 单飞闸门：一轮未结束不叠加新一轮
let gatewayReconnectAttempt = 0;       // 连续失败计数（成功后清零）
let onHeartbeatDead = null;
let onCodeInvalid = null;
let onConnectionDegraded = null;
let onConnectionRecovered = null;
let wsErrorHandledAt = 0;
let lastDailyRunDate = '';
let friendSyncPaused = false;
let starActivityClaimRunning = false;

// 奶茶热销中（S4）声明式自动化：自动化 key → 服务层动作名。
// 一个循环遍历即可，无需为每个开关写一个 runXxxAutoClaims 函数（对齐 404 的 AUTO_ACTIONS）。
const MILK_TEA_AUTO_ACTIONS = {
    milk_tea_cashier: 'claim',
    milk_tea_wages: 'wages',
    milk_tea_upgrade: 'upgrade',
    milk_tea_craft: 'craft',
    milk_tea_boost: 'boost',
    milk_tea_hire: 'hire',
    milk_tea_seed_buy: 'seedBuy',
    milk_tea_share_daily: 'shareDaily',
    milk_tea_share_rewards: 'shareRewards',
    milk_tea_fund_rewards: 'fundClaim',
};
const MILK_TEA_ACTION_LABELS = {
    claim: '领收银台收益', wages: '领工资', upgrade: '升级店铺', craft: '制作奶茶',
    boost: '使用加速', hire: '雇佣店员', seedBuy: '购买种子',
    shareDaily: '领每日快乐值', shareRewards: '领分享档位奖励', fundClaim: '领成长基金',
};
// 「跳过」日志节流：同一动作 10 分钟内只记一次。
// 否则「没有果实可加工」「宣传喇叭不足」这类长期条件会每轮刷一条日志（404 同款做法）。
const MILK_TEA_SKIP_LOG_INTERVAL_MS = 10 * 60 * 1000;
const milkTeaSkipLoggedAt = new Map();

const workerScheduler = createScheduler('worker');

/** 每日任务是否启用 */
function isDailyRoutineEnabled() { return true; }

/** 获取当天日期键 */
function getLocalDateKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y  }-${  m  }-${  day}`;
}

// ==================== 每日任务 ====================

async function runDailyRoutines(force = false) {
    if (!loginReady || friendSyncPaused) return;
    try {
        if (getAutomation().email) await checkAndClaimEmails(force);
        await performDailyShare(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (err) {
        log('系统', `每日任务调度失败: ${  err.message}`, {
            module: 'system',
            event: '每日任务',
            result: 'error'
        });
    }
}

function stopDailyRoutineTimer() {
    workerScheduler.clear('daily_routine_interval');
}

function startDailyRoutineTimer() {
    stopDailyRoutineTimer();
    lastDailyRunDate = getLocalDateKey();
    runDailyRoutines(true).catch(() => null);

    // 每 60 秒检查一次日期是否变化
    workerScheduler.setIntervalTask('daily_routine_interval', 60000, () => {
        if (!loginReady) return;
        const today = getLocalDateKey();
        if (today === lastDailyRunDate) {
            // 分享资格在服务端日切后可能延迟刷新；服务内部有 10 分钟冷却，
            // 持续检查可避免零点单次未命中后必须重连才能领取。
            performDailyShare(false).catch(() => null);
            return;
        }
        lastDailyRunDate = today;
        require('../services/stats').checkAndResetDailyStats(); // 跨天先 flush 昨日历史
        runDailyRoutines(true)
            .then(() => runBadOnceOnStartup(true))
            .catch(() => null);
    });
}

// ==================== 活动自动控制 ====================

const petDiaryBattleEnabled = () => loginReady && !friendSyncPaused
    && getAutomation().pet_diary_battle === true;
const petDiaryBattleExcluded = gid => String(getUserState().gid) === gid
    || getFriendBlacklist(process.env.FARM_ACCOUNT_ID || '').some(value => String(value) === gid);
const runPetDiaryBattles = require('../services/pet-diary-battle-automation').createPetDiaryBattleAutomation({
    getPet: () => require('../services/activity').getPetDiary(),
    getFriends: () => getFriendsList(),
    getFriend: gid => require('../services/activity').getPetDiaryFriend(gid),
    operate: (action, params) => require('../services/activity').operatePetDiary(action, params, {
        shouldContinue: () => petDiaryBattleEnabled() && !petDiaryBattleExcluded(params.gid),
    }),
    enabled: petDiaryBattleEnabled,
    excluded: petDiaryBattleExcluded,
    now: () => require('../utils/utils').getServerTimeSec() * 1000,
    pause: () => new Promise(resolve => setTimeout(resolve, 400)),
    report: (message, detail) => log('活动', `${message}（检查 ${detail.scanned} 人，夺宝 ${detail.battles} 次）`, {
        module: 'activity', event: '自动好友夺宝', result: detail.error ? 'error' : 'ok', ...detail,
    }),
});

/**
 * 萌宠成长日记（S3）自动化。
 *
 * 设计约束：
 * - 只调用 operatePetDiary，不绕过 service 的任何前置校验（限额、资源、活动窗口、拒绝钻石）。
 * - 每次 operate 返回完整 snapshot，直接拿来驱动下一步，避免额外读。
 * - 执行顺序有依赖：领养 -> 投喂 -> 领狗 -> 选锦囊 -> 寻宝 -> 各类领取。
 *   选锦囊必须在投喂之后：canChoose 要求已成年，而成年靠投喂换来。
 *   阶段 1（投喂）与阶段 2（寻宝）在单个快照内互斥，但同一轮里可以级联：
 *   投喂 10 次成年 -> 领狗 -> 选锦囊 -> 转入寻宝。
 * - 循环都有硬上限，即使服务端标志位异常也不会打转。
 */
async function runPetDiaryAutomation(flags) {
    const { getPetDiary, operatePetDiary } = require('../services/activity');
    const { getServerTimeSec } = require('../utils/utils');
    const spacer = () => new Promise(resolve => setTimeout(resolve, 400));
    // 用漂移校正后的服务器时钟，而不是快照里抓取的 pet.serverTime：
    // 一轮跑下来可能过去几分钟，快照时间戳只会偏小，导致中途成熟的宝藏被漏掉、
    // 精准唤醒也会算得偏晚。service 端 openTreasure 的判定用的就是这个时钟。
    const serverNowMs = () => getServerTimeSec() * 1000;

    let pet = await getPetDiary();
    if (!pet || pet.active !== true) {
        workerScheduler.clear('pet_diary_treasure_ready');
        return;
    }

    // 单步执行器：判定 -> 操作 -> 用返回的 snapshot 更新状态。
    // 失败只记日志不中断后续步骤，避免一个受限操作拖垮整批。
    // ready() 也放进 try：它一旦抛出会逃出本函数并被外层 catch 吞掉，
    // 连带跳过后续所有活动自动化，且只留一条无指向的通用错误日志。
    const step = async (enabled, event, ready, action, params = {}) => {
        try {
            if (!enabled || !ready()) return false;
            const result = await operatePetDiary(action, params);
            if (result?.snapshot) pet = result.snapshot;
            const rewards = (result?.rewards || []).map(item => `${item.name}x${item.count}`).join('、');
            log('活动', `萌宠日记${event}完成${rewards ? `：${rewards}` : ''}`, {
                module: 'activity', event: `萌宠日记${event}`, result: 'success'
            });
            return true;
        } catch (err) {
            log('活动', `萌宠日记${event}失败: ${err.message}`, {
                module: 'activity', event: `萌宠日记${event}`, result: 'error'
            });
            return false;
        }
    };

    // 领养比熊。未领养时后续所有玩法都不可用，必须最先执行。
    await step(flags.adopt, '领养比熊', () => pet.nurture?.initialized !== true, 'initialize');

    // 阶段 1：投喂。单次成长 700，成年阈值 7000，即 10 次成年即转阶段 2。
    // 日限虽为 16，但 canFeed 要求未成年，所以单次运行最多 10 次。
    let fed = 0;
    while (flags.feed && pet.nurture?.canFeed === true && fed < 12) {
        if (!await step(true, '投喂', () => true, 'feed')) break;
        fed++;
        await spacer();
    }

    // 成年即领取比熊，与领养同属一次性领取，复用同一开关。
    await step(flags.adopt, '领取比熊',
        () => pet.nurture?.adult === true && pet.nurture?.dogGranted !== true, 'claimDog');

    // 领取奖励后，比熊还只是“可激活”；官方客户端会在宠物界面另调
    // DogService.ActivateDog。严格复用成年 + 已领奖条件，并由 pets service 再校验
    // GetDogInfo 的可激活标记，兼容此前已领取但尚未手动激活的账号。
    if (flags.adopt && pet.nurture?.adult === true && pet.nurture?.dogGranted === true) {
        try {
            const result = await require('../services/pets').activateBichonIfEligible(pet);
            if (result.activated) {
                log('活动', '萌宠日记激活比熊完成', {
                    module: 'activity', event: '萌宠日记激活比熊', result: 'success'
                });
            }
        } catch (err) {
            log('活动', `萌宠日记激活比熊失败: ${err.message}`, {
                module: 'activity', event: '萌宠日记激活比熊', result: 'error'
            });
        }
    }

    // 选锦囊必须排在投喂之后：canChoose 要求已成年（stage 2），
    // 而成年是投喂到 7000 成长值换来的。放在投喂前会导致刚成年的那一轮永远选不到锦囊。
    // 锦囊影响夺宝结算，所以又要排在寻宝之前。
    //
    // 只选不刷新：免费刷新每日仅 1 次，而池内锦囊均为正向效果，
    // 盲目重摇再取 pool[0] 期望收益为零，白扣一次免费额度。
    if (flags.charm && pet.charms?.canChoose && pet.charms.pool?.length) {
        await step(true, '选择锦囊', () => true, 'equipCharm', { charmId: pet.charms.pool[0].id });
    }

    // 阶段 2：寻宝，日限 10 次。与投喂消耗同一种元气糕（1028 x700），
    // 刚成年那一轮通常因元气糕已耗尽而拿不到 canDraw。
    let drawn = 0;
    while (flags.draw && pet.hunt?.canDraw === true && drawn < 12) {
        if (!await step(true, '寻宝', () => true, 'draw')) break;
        drawn++;
        await spacer();
    }

    // 爪印手记：逐个领取已解锁未领取的。
    if (flags.story) {
        let claimed = 0;
        while (claimed < 20) {
            const story = (pet.stories || []).find(item => item.unlocked && !item.claimed);
            if (!story) break;
            if (!await step(true, '领取手记', () => true, 'story', { order: story.order })) break;
            claimed++;
            await spacer();
        }
    }

    await step(flags.seeds, '领取种子礼包', () => pet.seeds?.canClaim === true, 'seeds');

    // 节令小礼：窗口内可领取的逐个领。
    if (flags.solar) {
        for (const term of (pet.solarTerms?.terms || [])) {
            if (term.canClaim !== true) continue;
            await step(true, `领取${term.name || '节令'}好礼`, () => true, 'solar', { termId: term.id });
            await spacer();
        }
    }

    // 宝藏护送：status 3 已完成，status 2 且 endTime 已过也算完成。
    // service 端会一并处理，这里只判断是否存在可开的宝藏。
    const treasureReady = () => (pet.treasures || []).some(item => item.status === 3
        || (item.status === 2 && item.endTime > 0 && item.endTime <= serverNowMs()));
    if (flags.treasure) {
        let opened = 0;
        while (treasureReady() && opened < 20) {
            if (!await step(true, '开启宝藏', () => true, 'openTreasure')) break;
            opened++;
            await spacer();
        }
    }

    await step(flags.compensation, '领取夺宝补偿',
        () => BigInt(String(pet.compensationCount || '0')) > 0n, 'compensation');

    if (flags.battle) await runPetDiaryBattles();

    // 护送完成是时间驱动的，5 分钟轮询会白等。按最近一个 endTime 精准唤醒，
    // 与 rain_poem_weather_renew 同一套写法：先清后设，+2s 安全垫，回调重入顶层函数。
    workerScheduler.clear('pet_diary_treasure_ready');
    if (flags.treasure) {
        const nowMs = serverNowMs();
        const nextEnd = (pet.treasures || [])
            .filter(item => item.status === 2 && item.endTime > nowMs)
            .map(item => item.endTime)
            .sort((a, b) => a - b)[0];
        if (nextEnd) {
            const delayMs = Math.max(1000, nextEnd - nowMs + 2000);
            workerScheduler.setTimeoutTask('pet_diary_treasure_ready', delayMs, () => {
                runStarActivityAutoClaims().catch(() => null);
            });
        }
    }
}

// 秋祈良愿 + 快乐不独享 活动自动化（worker 侧统一入口）。
// - draw:   自动抽心仪（wish_sign_draw），chooseId 来自面板 wish_sign_choice/本地默认
// - claim:  自动领祈愿奖励（wish_sign_claim）
// - shareDaily: 快乐不独享每日分享领奖
// - shareMilestones: 快乐不独享里程碑领奖
// - shareRewardShare: 自动分享任务
async function runWishShareAutomation(flags) {
    const { getWishSignActivity, operateWishSign, getShareRewardActivity, operateShareReward } = require('../services/activity');
    const spacer = () => new Promise(resolve => setTimeout(resolve, 500));

    // 秋祈良愿（中秋祈愿）
    if (flags.draw || flags.claim) {
        try {
            let wish = await getWishSignActivity();
            if (wish && wish.active === true) {
                // 有已抽待领的签文 → 优先领取
                if (flags.claim && wish.pending) {
                    const r = await operateWishSign('claim', wish.pending.chooseId);
                    const rewards = (r?.rewards || []).map(item => `${item.name}x${item.count || 1}`).join('、');
                    log('活动', `秋祈良愿领奖完成${rewards ? `：${rewards}` : ''}`, {
                        module: 'activity', event: '秋祈良愿领奖', result: 'success'
                    });
                    await spacer();
                }
                // 无可领且还有抽签次数 → 抽一次
                if (flags.draw && !wish.pending && (wish.remainingCount > 0)) {
                    const chooseId = Number(flags.chooseId) >= 1 ? Number(flags.chooseId) : 1;
                    const r = await operateWishSign('draw', chooseId);
                    const rewards = (r?.rewards || []).map(item => `${item.name || item.id}x${item.count || 1}`).join('、');
                    log('活动', `秋祈良愿抽签完成${rewards ? `：${rewards}` : ''}`, {
                        module: 'activity', event: '秋祈良愿抽签', result: 'success'
                    });
                    if (r?.activity) wish = r.activity;
                }
            }
        } catch (err) {
            log('活动', `秋祈良愿自动任务失败: ${err.message}`, {
                module: 'activity', event: '秋祈良愿自动', result: 'error'
            });
        }
    }

    // 快乐不独享（分享奖励）
    if (flags.shareDaily || flags.shareMilestones || flags.shareRewardShare) {
        try {
            const share = await getShareRewardActivity();
            if (share && share.active === true) {
                // 首次分享任务
                if (flags.shareRewardShare && !share.daily.firstShareAwarded) {
                    await operateShareReward('share');
                    log('活动', '快乐不独享完成首次分享', { module: 'activity', event: '快乐不独享分享', result: 'success' });
                    await spacer();
                }
                // 今日奖励领取
                if (flags.shareDaily && !share.daily.rewardClaimed) {
                    const r = await operateShareReward('daily');
                    const rewards = (r?.rewards || []).map(item => `${item.name || item.iconId}x${item.count || 1}`).join('、');
                    log('活动', `快乐不独享领每日奖励完成${rewards ? `：${rewards}` : ''}`, {
                        module: 'activity', event: '快乐不独享每日', result: 'success'
                    });
                    await spacer();
                }
                // 里程碑领奖（state=2 达标可领）
                const claimable = (share.milestones || []).filter(t => t.state === 2 && share.currentScore >= t.threshold);
                if (flags.shareMilestones && claimable.length) {
                    for (const tier of claimable) {
                        await operateShareReward('milestones');
                        log('活动', `快乐不独享领里程碑奖励完成（档位${tier.id || ''}）`, {
                            module: 'activity', event: '快乐不独享里程碑', result: 'success'
                        });
                        await spacer();
                    }
                }
            }
        } catch (err) {
            log('活动', `快乐不独享自动任务失败: ${err.message}`, {
                module: 'activity', event: '快乐不独享自动', result: 'error'
            });
        }
    }
}

async function runStarActivityAutoClaims() {
    if (!loginReady || friendSyncPaused || starActivityClaimRunning) return;

    const automation = getAutomation() || {};
    // 已下线/已出窗口活动硬门控：即使面板/持久化配置里残留 true（服务端不再下发活动节点），
    // 也不再执行对应自动化、不再发起活动接口请求，避免每 5 分钟轮询刷失败日志。
    // 统一从 store 的过期压关机制取口径（HIDDEN ∪ 已出时间窗），不再手工枚举，
    // 避免与 store.js 不同步；活动换皮返厂时只要更新窗口常量即自动复活。
    const retiredActivityKeys = getInactiveActivityAutomationKeys();
    for (const key of retiredActivityKeys) {
        if (automation[key]) automation[key] = false;
    }
    const claimPassport = automation.star_passport_claim === true;
    const claimRecords = automation.star_record_claim === true;
    // 青梅活动结束后（写死结束时间兜底）强制关闭对应自动化，即使面板配置还开着也不执行，
    // 避免活动结束后 1034004 参数错误刷屏。
    const qingmeiHardExpired = (() => {
        const { QINGMEI_WINE_END_TIME } = require('../services/activity');
        return QINGMEI_WINE_END_TIME > 0 && QINGMEI_WINE_END_TIME * 1000 < Date.now();
    })();
    const claimQingmeiSeedsEnabled = !qingmeiHardExpired && automation.qingmei_seed_claim === true;
    const brewQingmeiWineEnabled = !qingmeiHardExpired && automation.qingmei_wine_brew === true;
    const useQixiDewEnabled = automation.qixi_dew_use === true;
    const buildQixiBridgeEnabled = automation.qixi_bridge_build === true;
    const giftQixiSachetEnabled = automation.qixi_sachet_gift === true;
    const buyRainPoemBottleEnabled = automation.rain_poem_bottle_buy === true;
    const collectRainPoemWeatherEnabled = automation.rain_poem_weather_collect === true;
    const useRainPoemSummonEnabled = automation.rain_poem_summon_use === true;
    const useRainPoemPrankEnabled = automation.rain_poem_prank_use === true;
    const unlockRainPoemResearchEnabled = automation.rain_poem_research_unlock === true;
    const claimSolarTermsEnabled = automation.solar_terms_claim === true;
    const claimHonghuaShareEnabled = automation.honghua_share_claim === true;
    const claimHonghuaTiersEnabled = automation.honghua_tiers_claim === true;
    const donateHonghuaLoveEnabled = automation.honghua_love_donate === true;
    const petDiaryAdoptEnabled = automation.pet_diary_adopt === true;
    const petDiaryFeedEnabled = automation.pet_diary_feed === true;
    const petDiaryDrawEnabled = automation.pet_diary_draw === true;
    const petDiaryStoryEnabled = automation.pet_diary_story_claim === true;
    const petDiarySeedEnabled = automation.pet_diary_seed_claim === true;
    const petDiarySolarEnabled = automation.pet_diary_solar_claim === true;
    const petDiaryTreasureEnabled = automation.pet_diary_treasure_open === true;
    const petDiaryCompensationEnabled = automation.pet_diary_compensation_claim === true;
    const petDiaryCharmEnabled = automation.pet_diary_charm_equip === true;
    const petDiaryBattleFlag = automation.pet_diary_battle === true;
    const petDiaryAnyEnabled = petDiaryAdoptEnabled || petDiaryFeedEnabled || petDiaryDrawEnabled
        || petDiaryStoryEnabled || petDiarySeedEnabled || petDiarySolarEnabled
        || petDiaryTreasureEnabled || petDiaryCompensationEnabled || petDiaryCharmEnabled || petDiaryBattleFlag;
    // 秋祈良愿（祈愿签到）+ 快乐不独享（分享）活动
    const wishSignDrawEnabled = automation.wish_sign_draw === true;
    const wishSignClaimEnabled = automation.wish_sign_claim === true;
    const wishSignChoice = Number(automation.wish_sign_choice);
    const wishSignChoiceId = Number.isInteger(wishSignChoice) && wishSignChoice >= 1 ? wishSignChoice : 1;
    const shareRewardShareEnabled = automation.share_reward_share === true;
    const claimShareDailyEnabled = automation.share_reward_daily === true;
    const claimShareMilestonesEnabled = automation.share_reward_milestones === true;
    const wishShareAnyEnabled = wishSignDrawEnabled || wishSignClaimEnabled
        || shareRewardShareEnabled || claimShareDailyEnabled || claimShareMilestonesEnabled;
    const qixiFriendPriority = Array.isArray(automation.qixi_friend_priority)
        ? automation.qixi_friend_priority.map(Number).filter(gid => gid > 0) : [];
    // 奶茶热销中（S4）：任一开关开启即启用循环
    const milkTeaAnyEnabled = Object.keys(MILK_TEA_AUTO_ACTIONS).some(key => automation[key] === true);
    if (!claimPassport && !claimRecords && !claimQingmeiSeedsEnabled && !brewQingmeiWineEnabled
        && !useQixiDewEnabled && !buildQixiBridgeEnabled && !giftQixiSachetEnabled
        && !buyRainPoemBottleEnabled && !collectRainPoemWeatherEnabled && !useRainPoemSummonEnabled && !useRainPoemPrankEnabled
        && !unlockRainPoemResearchEnabled
        && !claimSolarTermsEnabled
        && !claimHonghuaShareEnabled && !claimHonghuaTiersEnabled && !donateHonghuaLoveEnabled
        && !petDiaryAnyEnabled
        && !wishShareAnyEnabled
        && !milkTeaAnyEnabled) return;

    starActivityClaimRunning = true;
    try {
        const {
            getStarActivity,
            claimSeasonPassportRewards,
            claimStarRecordRewards,
            claimQingmeiSeeds,
            brewAndSellQingmeiWine,
            getSolarTermsInfo,
            claimSolarTermsReward
        } = require('../services/activity');
        const {
            getHonghuaActivity,
            claimHonghuaShare,
            claimHonghuaTiers,
            donateHonghuaLove,
        } = require('../services/honghua-activity');
        // 心许千灯星垂野整棵活动树已于 2026-08-28 下线：仅在仍有依赖它的开关开启时才请求，
        // 否则每次轮询都白跑一次「活动已结束或不存在」的失败请求。
        const needStarActivity = claimPassport || claimRecords || claimSolarTermsEnabled;
        const activity = needStarActivity ? await getStarActivity() : null;
        if (claimPassport && Number(activity?.passport?.claimableLevels || 0) > 0) {
            try {
                const result = await claimSeasonPassportRewards();
                log('活动', `自动领取千星游记完成：${  Number(result?.claimedLevels || 0)  } 级奖励`, {
                    module: 'activity',
                    event: '千星游记自动领取',
                    result: 'success',
                    claimedLevels: Number(result?.claimedLevels || 0)
                });
            } catch (err) {
                log('活动', `自动领取千星游记失败: ${  err.message}`, {
                    module: 'activity',
                    event: '千星游记自动领取',
                    result: 'error'
                });
            }
        }

        if (claimRecords && Number(activity?.starRecord?.claimableCount || 0) > 0) {
            try {
                const result = await claimStarRecordRewards();
                log('活动', `自动领取观星礼录完成：${  result?.recordIds?.length || 0  } 个星宿`, {
                    module: 'activity',
                    event: '观星礼录自动领取',
                    result: 'success',
                    recordCount: result?.recordIds?.length || 0
                });
            } catch (err) {
                log('活动', `自动领取观星礼录失败: ${  err.message}`, {
                    module: 'activity',
                    event: '观星礼录自动领取',
                    result: 'error'
                });
            }
        }

        // 节令小札（节令小礼）：有可领取节令时循环领取，直到无可领取为止
        if (claimSolarTermsEnabled && Number(activity?.solarTerms?.claimableCount || 0) > 0) {
            try {
                let claimed = 0;
                for (let guard = 0; guard < 12; guard++) {
                    const info = await getSolarTermsInfo();
                    const next = (info.terms || []).find(t => t.claimable);
                    if (!next) break;
                    const r = await claimSolarTermsReward(next.id);
                    claimed++;
                    log('活动', `自动领取节令小札：${  r?.term?.title || ''  }`, {
                        module: 'activity',
                        event: '节令小札自动领取',
                        result: 'success',
                        termId: next.id,
                        title: r?.term?.title || ''
                    });
                }
                if (claimed > 0) {
                    log('活动', `节令小札自动领取完成：共 ${  claimed  } 个`, {
                        module: 'activity',
                        event: '节令小札自动领取',
                        result: 'ok',
                        count: claimed
                    });
                }
            } catch (err) {
                log('活动', `自动领取节令小札失败: ${  err.message}`, {
                    module: 'activity',
                    event: '节令小札自动领取',
                    result: 'error'
                });
            }
        }

        // 青梅活动有效性：end_time 已过（且 >0）视为活动结束，跳过青梅自动化，
        // 避免活动结束后 1034004 参数错误刷屏（青梅可能为常驻活动，保留逻辑不删除）。
        const qingmeiEnd = Number(activity?.qingmei?.endTime || 0);
        const qingmeiExpired = qingmeiEnd > 0 && qingmeiEnd * 1000 < Date.now();
        if (qingmeiExpired) {
            log('活动', '青梅活动已结束，跳过青梅自动化', {
                module: 'activity',
                event: '青梅活动结束',
                result: 'none',
            });
        }
        // 青梅领取节点不稳定地下发每日 status，不能依赖页面用的 claimable
        // 字段决定是否调用；服务端“已领取”响应会在 service 内标记当天状态。
        else if (claimQingmeiSeedsEnabled && activity?.qingmei?.claimed !== true) {
            try {
                const result = await claimQingmeiSeeds();
                const alreadyClaimed = result?.alreadyClaimed === true;
                log('活动', alreadyClaimed
                    ? '自动校验青梅种子：今日已领取'
                    : `自动领取青梅种子完成：${  Number(result?.claimedCount || 0)  } 个`, {
                    module: 'activity',
                    event: '青梅种子自动领取',
                    result: alreadyClaimed ? 'none' : 'success',
                    alreadyClaimed,
                    claimedCount: Number(result?.claimedCount || 0)
                });
            } catch (err) {
                log('活动', `自动领取青梅种子失败: ${  err.message}`, {
                    module: 'activity',
                    event: '青梅种子自动领取',
                    result: 'error'
                });
            }
        }
        else if (claimQingmeiSeedsEnabled) {
            log('活动', '自动领取青梅种子跳过：今日已领取', {
                module: 'activity',
                event: '青梅种子自动领取',
                result: 'none',
                alreadyClaimed: true
            });
        }

        if (!qingmeiExpired && brewQingmeiWineEnabled && Number(activity?.qingmei?.material?.itemCount || 0) > 0) {
            try {
                const result = await brewAndSellQingmeiWine({ share: true });
                const sellOption = Math.max(1, Number(result?.sell?.multiple || (result?.share?.shared ? 2 : 1)) || 1);
                const incomeMultiple = sellOption === 2 ? 1.5 : 1;
                const previewPrice = Number(result?.preview?.price || 0);
                const finalPrice = Number(result?.brew?.price || 0);
                const brewMultiple = previewPrice > 0 && finalPrice > 0
                    ? Number((finalPrice / previewPrice).toFixed(2))
                    : 1;
                log('活动', `自动酿造并售卖青梅酿完成：酿造 ${  brewMultiple  } 倍，分享收入 ${  incomeMultiple  } 倍，金币 ${  Number(result?.sell?.gold || 0)  }`, {
                    module: 'activity',
                    event: '青梅酿自动酿造',
                    result: 'success',
                    consumedCount: Number(result?.consumedCount || 0),
                    gold: Number(result?.sell?.gold || 0),
                    brewMultiple,
                    previewPrice,
                    finalPrice,
                    incomeMultiple,
                    protocolMultiple: sellOption,
                    shared: result?.share?.shared === true
                });
            } catch (err) {
                log('活动', `自动酿造青梅酿失败: ${  err.message}`, {
                    module: 'activity',
                    event: '青梅酿自动酿造',
                    result: 'error',
                    stage: err?.stage || ''
                });
            }
        }
        else if (!qingmeiExpired && brewQingmeiWineEnabled) {
            log('活动', '自动酿造青梅酿跳过：背包中没有普通青梅', {
                module: 'activity',
                event: '青梅酿自动酿造',
                result: 'none',
                materialCount: 0
            });
        }

        if (useQixiDewEnabled || buildQixiBridgeEnabled || giftQixiSachetEnabled) {
            const { getQixiEndedState, getQixiActivity, useQixiDew, buildQixiBridge, sendQixiSachet } = require('../services/activity');
            // 活动结束态按天缓存：已结束则不再每轮巡查/请求，仅在跨天首次确认时打一次日志。
            const qixiState = await getQixiEndedState();
            if (qixiState.ended) {
                // 活动已结束：彻底静默，不执行灵露/驻建鹊桥/赠送香囊，也不再打印提示日志
            } else {
                let qixi = qixiState.activity || await getQixiActivity();
                if (!qixi) {
                    // 活动节点未开放/已下架：保持静默轮询，不执行也不打日志
                } else {
                    if (useQixiDewEnabled && !qixi?.dewUsage?.limitReached && Number(qixi?.items?.dew?.itemCount || 0) > 0) {
                        const result = await useQixiDew();
                        qixi = result.activity || qixi;
                        log('活动', `自动使用鹊羽灵露完成：${Number(result.usedCount || 0)} 个`, { module: 'activity', event: '鹊羽灵露自动使用', result: result.usedCount ? 'success' : 'none' });
                    }
                    if (buildQixiBridgeEnabled && qixi?.bridge?.nextStage) {
                        let built = 0;
                        try {
                            // 以 nextStage 存在为循环条件（不依赖 canBuild，避免鹊羽不足时静默跳过）；
                            // 每轮开始先确认鹊羽足够，不足则明确提示后停止。
                            while (qixi?.bridge?.nextStage && built < 20) {
                                if (!qixi.bridge.canBuild) {
                                    log('活动', `鹊桥下一阶段鹊羽不足，暂停自动驻建（已建 ${qixi.bridge.completedCount} 阶段）`, { module: 'activity', event: '鹊桥自动驻建', result: 'none', count: built });
                                    break;
                                }
                                const result = await buildQixiBridge();
                                if (!result.built) break;
                                built++;
                                qixi = result.activity || qixi;
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                            // 仅在实际有建动作时打日志。无 nextStage 已在外层跳过（活动结束/全建完不刷屏）；
                            // 鹊羽不足等异常在 while 内单独打「暂停」日志，这里 0 阶段不再重复打。
                            if (built > 0) {
                                log('活动', `自动驻建鹊桥完成：${built} 阶段`, { module: 'activity', event: '鹊桥自动驻建', result: 'success', count: built });
                            }
                        } catch (err) {
                            log('活动', `自动驻建鹊桥失败: ${err.message}`, { module: 'activity', event: '鹊桥自动驻建', result: 'error', count: built });
                        }
                    }
                    if (giftQixiSachetEnabled && qixiFriendPriority.length > 0 && Number(qixi?.gift?.remainingCount || 0) > 0) {
                        let sent = 0;
                        for (const gid of qixiFriendPriority) {
                            if (Number(qixi?.gift?.remainingCount || 0) <= 0 || Number(qixi?.items?.sachet?.itemCount || 0) <= 0) break;
                            try {
                                const sendCount = Math.min(
                                    Number(qixi.gift.remainingCount || 0),
                                    Number(qixi.items.sachet.itemCount || 0)
                                );
                                const result = await sendQixiSachet(gid, sendCount);
                                sent += Number(result.sentCount || 0);
                                qixi = result.activity || qixi;
                            } catch (err) {
                                log('活动', `向好友 ${gid} 赠送香囊失败: ${err.message}`, { module: 'activity', event: '香囊自动赠送', result: 'error', friendGid: gid });
                            }
                        }
                        log('活动', `自动赠送鹊羽香囊完成：${sent} 个`, { module: 'activity', event: '香囊自动赠送', result: sent ? 'success' : 'none', count: sent });
                    }
                }
            }
        }

        if (buyRainPoemBottleEnabled || collectRainPoemWeatherEnabled || useRainPoemSummonEnabled || useRainPoemPrankEnabled || unlockRainPoemResearchEnabled) {
            const {
                getRainPoemActivity,
                buyRainPoemCollectionBottle,
                collectRainPoemWeather,
                useRainPoemSummonBottle,
                unlockRainPoemResearch
            } = require('../services/activity');
            let rainPoem = await getRainPoemActivity();
            if (rainPoem?.active === false) return;
            const lightningHarvestComplete = rainPoem?.lightningHarvest?.complete === true;

            // 雷电变异作物每日目标未完成时，按服务端天气结束时间精准续接。
            // 5 分钟活动轮询仍作为断线、重启或定时器丢失后的兜底。
            workerScheduler.clear('rain_poem_weather_renew');
            if (useRainPoemSummonEnabled && !lightningHarvestComplete && rainPoem?.weather?.rainstorm && Number(rainPoem?.weather?.endTime || 0) > 0) {
                const renewDelayMs = Math.max(1000, (Number(rainPoem.weather.endTime) - Math.floor(Date.now() / 1000) + 2) * 1000);
                workerScheduler.setTimeoutTask('rain_poem_weather_renew', renewDelayMs, () => {
                    runStarActivityAutoClaims().catch(() => null);
                });
            }

            if (buyRainPoemBottleEnabled && rainPoem?.shop?.available && !rainPoem?.shop?.purchasedToday) {
                try {
                    const result = await buyRainPoemCollectionBottle();
                    rainPoem = result.activity || rainPoem;
                    log('活动', result?.purchased ? '自动购买天气采集瓶完成：1 个' : '自动购买天气采集瓶：今日已购买', {
                        module: 'activity',
                        event: '雨落成诗自动买瓶',
                        result: result?.purchased ? 'success' : 'none'
                    });
                } catch (err) {
                    log('活动', `自动购买天气采集瓶失败: ${err.message}`, { module: 'activity', event: '雨落成诗自动买瓶', result: 'error' });
                }
            }

            if (collectRainPoemWeatherEnabled && Number(rainPoem?.items?.collectionBottles || 0) > 0 && Number(rainPoem?.collection?.remainingUseCount || 0) > 0) {
                try {
                    const result = await collectRainPoemWeather();
                    rainPoem = result.activity || rainPoem;
                    log('活动', result?.collected === false
                        ? `自动采集好友雷雨：已检查 ${Number(result?.checkedCount || 0)} 位好友，暂未发现雷雨`
                        : `自动采集好友雷雨完成：${result?.friendName || result?.friendGid || ''}`, {
                        module: 'activity',
                        event: '雨落成诗自动采集',
                        result: result?.collected === false ? 'none' : 'success',
                        checkedCount: Number(result?.checkedCount || 0),
                        friendGid: Number(result?.friendGid || 0)
                    });
                } catch (err) {
                    log('活动', `自动采集好友雷雨失败: ${err.message}`, { module: 'activity', event: '雨落成诗自动采集', result: 'error' });
                }
            }

            if (useRainPoemSummonEnabled
                && !lightningHarvestComplete
                && !rainPoem?.weather?.rainstorm
                && Number(rainPoem?.items?.summonBottles || 0) > 0
                && Number(rainPoem?.summon?.usedToday || 0) < Number(rainPoem?.summon?.dailyUseLimit || 50)) {
                try {
                    const result = await useRainPoemSummonBottle();
                    rainPoem = result.activity || rainPoem;
                    const noUseMessage = result?.reason === 'daily_limit'
                        ? '自动使用雷雨召唤瓶：今日使用次数已达上限'
                        : '自动使用雷雨召唤瓶：当前已是雷雨天气';
                    log('活动', result?.used ? '自动使用雷雨召唤瓶完成' : noUseMessage, {
                        module: 'activity',
                        event: '雨落成诗自动召唤',
                        result: result?.used ? 'success' : 'none'
                    });
                } catch (err) {
                    log('活动', `自动使用雷雨召唤瓶失败: ${err.message}`, { module: 'activity', event: '雨落成诗自动召唤', result: 'error' });
                }
            }

            if (useRainPoemPrankEnabled
                && (Number(rainPoem?.items?.frogPrankBottles || 0) > 0
                    || Number(rainPoem?.items?.cloudPrankBottles || 0) > 0)) {
                try {
                    const { runRainPoemPrankPlacement } = require('../services/rain-poem-prank-service');
                    // 投放服务只在实际成功使用至少一个瓶子时记录完成日志。
                    // 活动状态与背包二次读取之间若发生库存竞态，保持静默。
                    await runRainPoemPrankPlacement();
                } catch (err) {
                    log('活动', `自动使用使坏瓶失败: ${err.message}`, { module: 'activity', event: '雨落成诗自动使坏', result: 'error' });
                }
            }

            if (unlockRainPoemResearchEnabled) {
                let unlocked = 0;
                try {
                    while (unlocked < 20) {
                        // 研究节点是分支结构：同一层可能多个节点同时可解锁。
                        // 自动任务优先解锁「徽章够用且成本最低」的节点，避免第一个节点
                        // 徽章不足就整体放弃（玩家可在活动页面手动选择解锁哪个分支）。
                        const badges = Number(rainPoem?.items?.badges || 0);
                        const stage = (rainPoem?.research?.stages || [])
                            .filter(item => item.available && Number(item?.cost?.itemCount || 0) <= badges)
                            .sort((a, b) => Number(a?.cost?.itemCount || 0) - Number(b?.cost?.itemCount || 0))[0];
                        if (!stage) break;
                        const result = await unlockRainPoemResearch(stage.id);
                        if (!result?.unlocked) break;
                        unlocked++;
                        rainPoem = result.activity || rainPoem;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    log('活动', `自动解锁气象研究完成：${unlocked} 个节点`, {
                        module: 'activity',
                        event: '雨落成诗自动研究',
                        result: unlocked ? 'success' : 'none',
                        count: unlocked
                    });
                } catch (err) {
                    log('活动', `自动解锁气象研究失败: ${err.message}`, { module: 'activity', event: '雨落成诗自动研究', result: 'error', count: unlocked });
                }
            }
        }
        // ===== 公益小红花自动（领分享/领档位/送爱心值；公益金 cmd=38 真实扣款绝不自动） =====
        // 前置判断：未参与活动时部分操作服务器会空操作却返回"成功"，故基于活动进度门控避免误报。
        // 注意 loveValue 语义：它是"累计已送出的爱心值"（送出后才累加），可用于档位达标判定，
        // 但**绝不能**用来判断"当前有没有爱心值可送"（详见下方送爱心值分支的说明）。
        if (claimHonghuaShareEnabled || claimHonghuaTiersEnabled || donateHonghuaLoveEnabled) {
            try {
                const honghua = await getHonghuaActivity();
                if (!honghua || honghua.available !== true) {
                    log('活动', '小红花活动不可用，跳过自动任务', { module: 'activity', event: '小红花自动', result: 'none' });
                } else {
                    const prog = honghua.progress || {};
                    const loveValue = Number(prog.loveValue || 0);
                    const holdingCount = Number(prog.holdingItem && prog.holdingItem.count || 0);
                    const hasHonghua = loveValue > 0 || holdingCount > 0; // 已收获/持有小红花果实
                    const hasTierToClaim = (prog.tiers || []).some((t) => t.reached && !t.claimed);
                    if (claimHonghuaShareEnabled) {
                        // 分享奖励需已产生小红花进度（收获果实）才有资格；未参与直接跳过，不误报成功
                        if (!hasHonghua) {
                            log('活动', '自动跳过小红花分享奖励：尚未收获小红花果实，无分享资格', { module: 'activity', event: '小红花分享', result: 'none' });
                        } else {
                            // claimHonghuaShare 返回 {ok,message}，失败时不抛异常 → 必须按 ok 记日志，不能无条件报成功
                            try {
                                const shareResult = await claimHonghuaShare();
                                if (shareResult && shareResult.ok) {
                                    log('活动', `自动领取小红花分享奖励成功: ${shareResult.message || ''}`, { module: 'activity', event: '小红花分享', result: 'success' });
                                } else {
                                    log('活动', `自动领取小红花分享奖励未到账: ${shareResult && shareResult.message || '未知原因'}`, { module: 'activity', event: '小红花分享', result: 'error' });
                                }
                            }
                            catch (err) { if (!isTransientNetworkError(err)) log('活动', `自动领取小红花分享奖励失败: ${err.message}`, { module: 'activity', event: '小红花分享', result: 'error' }); }
                        }
                    }
                    if (claimHonghuaTiersEnabled) {
                        // 仅当累计爱心值已达某档位时才调；未达标直接跳过。
                        // claimHonghuaTiers 内部以回包 f137 奖励判定真正到账，ok:false 表示一档都没领到 → 必须按结果记日志
                        if (!hasTierToClaim) {
                            log('活动', '自动跳过小红花档位奖励：累计爱心值未达任何档位', { module: 'activity', event: '小红花档位', result: 'none' });
                        } else {
                            try {
                                const tierResult = await claimHonghuaTiers();
                                if (tierResult && tierResult.ok && Number(tierResult.claimed || 0) > 0) {
                                    log('活动', `自动领取小红花档位奖励成功 ${tierResult.claimed} 档: ${tierResult.message || ''}`, { module: 'activity', event: '小红花档位', result: 'success', count: Number(tierResult.claimed) });
                                } else if (tierResult && tierResult.ok) {
                                    log('活动', `自动领取小红花档位奖励无新到账: ${tierResult.message || ''}`, { module: 'activity', event: '小红花档位', result: 'none' });
                                } else {
                                    log('活动', `自动领取小红花档位奖励未到账: ${tierResult && tierResult.message || '未知原因'}`, { module: 'activity', event: '小红花档位', result: 'error' });
                                }
                            }
                            catch (err) { if (!isTransientNetworkError(err)) log('活动', `自动领取小红花档位奖励失败: ${err.message}`, { module: 'activity', event: '小红花档位', result: 'error' }); }
                        }
                    }
                    if (donateHonghuaLoveEnabled) {
                        // 送爱心值的正确门控依据是「持有小红花果实数」holdingCount（活动 f7），而非累计爱心值 loveValue：
                        //   - loveValue（f3）是"累计已送出的爱心值"，收获不会增长、只有送出才累加 → 用于档位达标判断，
                        //     曾误用它门控（loveValue<=0 跳过）导致从未送过的账号永久死锁，表现正是"爱心值为0需先收获"。
                        //   - holdingCount 是当前活动内持有的可送果实，收获后 >0、送完归 0，才是"能不能送"的真实依据。
                        // 实测：服务器在 holdingCount=0 时对 cmd36 返回空操作成功（ok:true、loveValue 不变），
                        // 故必须先用 holdingCount 门控，避免无果实时盲目调用刷屏、且日志更准确。
                        // 注：活动内"收获小红花果实"由常规农场收获任务完成（小红花作物成熟后收进活动持有），
                        // 本循环只负责"有果实就送"，不再重复收获。
                        if (holdingCount <= 0) {
                            log('活动', `自动跳过小红花送爱心值：当前无持有小红花果实（holding=${holdingCount}，累计已送爱心 ${loveValue}），需先收获小红花果实`, { module: 'activity', event: '小红花爱心', result: 'none' });
                        } else {
                            try {
                                const before = loveValue;
                                const r = await donateHonghuaLove();
                                if (r && r.ok) {
                                    let after = before;
                                    try {
                                        const fresh = await getHonghuaActivity();
                                        after = Number(fresh && fresh.progress && fresh.progress.loveValue || 0);
                                    } catch (_) { after = before; }
                                    const gained = after - before;
                                    if (gained > 0) {
                                        log('活动', `自动送小红花爱心值成功：+${gained}（累计 ${after}）`, { module: 'activity', event: '小红花爱心', result: 'success', count: gained });
                                    } else {
                                        log('活动', `自动送小红花爱心值：服务器返回成功但爱心值未变化（holding=${holdingCount}），可能果实已全部送出或需重新收获`, { module: 'activity', event: '小红花爱心', result: 'none' });
                                    }
                                } else if (r && r.code === 'NO_LOVE') {
                                    log('活动', '小红花爱心值不足，需先收获果实', { module: 'activity', event: '小红花爱心', result: 'none' });
                                } else {
                                    log('活动', `自动送小红花爱心值失败: ${r && r.message || '未知错误'}`, { module: 'activity', event: '小红花爱心', result: 'error' });
                                }
                            } catch (err) {
                                if (!isTransientNetworkError(err)) log('活动', `自动送小红花爱心值失败: ${err.message}`, { module: 'activity', event: '小红花爱心', result: 'error' });
                            }
                        }
                    }
                }
            } catch (err) {
                if (!isTransientNetworkError(err)) log('活动', `小红花自动任务检查失败: ${err.message}`, { module: 'activity', event: '小红花自动', result: 'error' });
            }
        }

        if (petDiaryAnyEnabled) {
            await runPetDiaryAutomation({
                adopt: petDiaryAdoptEnabled,
                feed: petDiaryFeedEnabled,
                draw: petDiaryDrawEnabled,
                story: petDiaryStoryEnabled,
                seeds: petDiarySeedEnabled,
                solar: petDiarySolarEnabled,
                treasure: petDiaryTreasureEnabled,
                compensation: petDiaryCompensationEnabled,
                battle: petDiaryBattleFlag,
                charm: petDiaryCharmEnabled
            });
        }

        if (wishSignDrawEnabled || wishSignClaimEnabled || claimShareDailyEnabled || claimShareMilestonesEnabled || shareRewardShareEnabled) {
            await runWishShareAutomation({
                draw: wishSignDrawEnabled,
                claim: wishSignClaimEnabled,
                chooseId: wishSignChoiceId,
                shareDaily: claimShareDailyEnabled,
                shareMilestones: claimShareMilestonesEnabled,
                shareRewardShare: shareRewardShareEnabled
            });
        }

        // 奶茶热销中（S4）声明式自动化：一个循环遍历 key→动作表，
        // 不新增 N 个 runXxxAutoClaims 函数。phase 前置条件 + 结算期白名单见 performMilkTeaOperation。
        if (milkTeaAnyEnabled) {
            const { getMilkTeaActivity, operateMilkTeaActivity } = require('../services/activity');
            // 结算期只允许领奖类操作（与 service 层白名单一致，双保险）
            const settlingAllowed = new Set(['milk_tea_cashier', 'milk_tea_wages', 'milk_tea_share_daily', 'milk_tea_share_rewards', 'milk_tea_fund_rewards']);
            // 无需开业即可执行的动作（与 service 层 MILK_TEA_NO_SHOP_REQUIRED 一致）
            const noShopRequired = new Set(['milk_tea_share_daily', 'milk_tea_share_rewards', 'milk_tea_fund_rewards']);
            for (const [key, action] of Object.entries(MILK_TEA_AUTO_ACTIONS)) {
                if (!loginReady || friendSyncPaused) break;
                if (getAutomation()?.[key] !== true) continue;
                try {
                    // 页名必须与 getMilkTeaActivity 的 validPages 一致。
                    // 注意：动作名取自 MILK_TEA_AUTO_ACTIONS 的值（claim/seedBuy/fundClaim…），
                    // 不是 key 名（milk_tea_cashier/milk_tea_seed_buy/milk_tea_fund_rewards），
                    // 曾误用 key 名判断导致前置条件恒不命中、页名回落。
                    const page = action === 'seedBuy' ? 'exchange'
                        : action === 'claim' ? 'shop'
                        : action === 'wages' ? 'work'
                        : action === 'craft' ? 'workshop'
                        : action === 'hire' ? 'hireList'
                        : action === 'upgrade' ? 'upgrade'
                        : action === 'fundClaim' ? 'fund'
                        : 'shop';
                    const state = await getMilkTeaActivity(page);
                    if (state?.active !== true) break;
                    const phase = state.phase || (state.settling ? 'settling' : 'business');
                    if (phase !== 'business' && phase !== 'settling') break;
                    if (phase === 'settling' && !settlingAllowed.has(key)) continue;
                    if (!(state.summary?.shopOpenAt > 0) && !noShopRequired.has(key)) continue;

                    // 各动作的前置条件（服务端不再下发时直接跳过，不发起请求）
                    if (action === 'claim' && !(state.shop?.pendingRewards || []).some(r => Number(r.count) > 0)) continue;
                    if (action === 'wages' && !state.summary?.hasUnclaimedWage) continue;
                    if (action === 'upgrade' && !state.summary?.canUpgrade) continue;
                    if (action === 'craft' && !(state.recipes || []).some(r => r.unlocked && r.isAdvanced)) continue;
                    // 加速需要「宣传喇叭」（shop.salesItemId）。无货时提前跳过，
                    // 不发请求 —— 服务端拒绝的回包不含 activity_id，会被误报成协议错误。
                    if (action === 'boost' && !(state.shop?.salesItemId > 0)) continue;
                    if (action === 'hire') {
                        const capacity = (state.levels || []).find(l => l.level === Number(state.shop?.level))?.employeeSlotCount || 0;
                        const nowSec = Math.floor(Date.now() / 1000);
                        const free = Array.from({ length: capacity }, (_, i) => i)
                            .some(i => !(state.shop?.slots || []).some(s => s.slotIndex === i && s.endAt > nowSec));
                        if (!free) continue;
                    }
                    if (action === 'seedBuy' && !(state.goods || []).some(g => g.categoryTag === 'seed' && g.unlocked && !g.paid && g.remaining > 0 && g.affordable)) continue;
                    if (action === 'shareDaily' && state.share?.daily?.claimed) continue;
                    if (action === 'shareRewards' && !(state.share?.milestones || []).some(t => t.claimable)) continue;
                    if (action === 'fundClaim' && (!state.fund?.unlocked || !(state.fund?.tiers || []).some(t => t.state === 2))) continue;

                    const params = {};
                    if (action === 'seedBuy') params.count = 1;
                    if (action === 'craft') params.auto = true;
                    if (action === 'hire') {
                        params.autoSelect = true;
                        params.durationId = Number(automation.milk_tea_hire_duration) || 1;
                        params.talentId = Number(automation.milk_tea_hire_talent) || 0;
                    }
                    const result = await operateMilkTeaActivity(action, params);
                    if (result?.skipped) {
                        // 节流：长期不满足的条件（无果实/无喇叭）只每 10 分钟记一次，避免刷屏
                        const nowMs = Date.now();
                        const lastAt = milkTeaSkipLoggedAt.get(action) || 0;
                        if (nowMs - lastAt >= MILK_TEA_SKIP_LOG_INTERVAL_MS) {
                            milkTeaSkipLoggedAt.set(action, nowMs);
                            log('活动', `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}跳过：${result.reason || '条件不满足'}`, {
                                module: 'activity', event: `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}`, result: 'skip'
                            });
                        }
                    } else if (result?.ok) {
                        milkTeaSkipLoggedAt.delete(action);
                        log('活动', `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}完成`, {
                            module: 'activity', event: `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}`, result: 'success'
                        });
                    }
                } catch (err) {
                    // 前置条件不满足属正常跳过（如"暂无可领取收益"），只在非业务性错误时记日志
                    if (!/暂无可|已领取|不可进行|资源不足|售罄|超出限购|尚未|请先开业|活动尚未|不存在/.test(err.message)) {
                        log('活动', `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}失败: ${err.message}`, {
                            module: 'activity', event: `奶茶热销中自动${MILK_TEA_ACTION_LABELS[action] || action}`, result: 'error'
                        });
                    }
                }
            }
        }
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            log('活动', `活动自动领取检查失败: ${  err.message}`, {
                module: 'activity',
                event: '活动自动领取检查',
                result: 'error'
            });
        }
    } finally {
        starActivityClaimRunning = false;
    }
}

function stopStarActivityClaimTimer() {
    workerScheduler.clear('star_activity_claim_initial');
    workerScheduler.clear('star_activity_claim_interval');
    workerScheduler.clear('rain_poem_weather_renew');
    workerScheduler.clear('rain_poem_after_harvest');
    workerScheduler.clear('pet_diary_treasure_ready');
    starActivityClaimRunning = false;
}

function startStarActivityClaimTimer() {
    stopStarActivityClaimTimer();
    workerScheduler.setTimeoutTask('star_activity_claim_initial', 10000, () => {
        runStarActivityAutoClaims().catch(() => null);
    });
    workerScheduler.setIntervalTask('star_activity_claim_interval', 5 * 60 * 1000, () => {
        runStarActivityAutoClaims().catch(() => null);
    }, { preventOverlap: true });
}

// 邮箱奖励：登录后立即检查一次，之后每小时自动领取（受 automation.email 开关控制）。
let emailClaimRunning = false;

function stopEmailClaimTimer() {
    workerScheduler.clear('email_claim_initial');
    workerScheduler.clear('email_claim_interval');
    emailClaimRunning = false;
}

async function runEmailAutoClaim() {
    if (!loginReady || friendSyncPaused || emailClaimRunning) return;
    if (getAutomation().email !== true) return;
    emailClaimRunning = true;
    try {
        await notifyNewSystemEmails();
        await checkAndClaimEmails(true);
    } catch (err) {
        log('邮箱', `定时检查领取邮箱失败: ${err.message}`, {
            module: 'task', event: 'email_claim', result: 'error',
        });
    } finally {
        emailClaimRunning = false;
    }
}

function startEmailClaimTimer() {
    stopEmailClaimTimer();
    workerScheduler.setTimeoutTask('email_claim_initial', 10000, () => {
        runEmailAutoClaim().catch(() => null);
    });
    workerScheduler.setIntervalTask('email_claim_interval', 60 * 60 * 1000, () => {
        runEmailAutoClaim().catch(() => null);
    }, { preventOverlap: true });
}

// 宠物狗粮：登录后先检查一次，之后每 10 分钟按「守护剩余时长阈值」自动购买并喂食。
function stopPetFoodTimer() {
    workerScheduler.clear('pet_food_initial');
    workerScheduler.clear('pet_food_interval');
}

async function runPetFoodAutoFeed() {
    if (!loginReady || friendSyncPaused) return;
    if (getAutomation().pet_food_auto_feed !== true) return;
    const { checkAndFeedPetFood } = require('../services/pet-food-automation');
    await checkAndFeedPetFood();
}

function startPetFoodTimer() {
    stopPetFoodTimer();
    workerScheduler.setTimeoutTask('pet_food_initial', 20000, () => {
        runPetFoodAutoFeed().catch(() => null);
    });
    workerScheduler.setIntervalTask('pet_food_interval', 10 * 60 * 1000, () => {
        runPetFoodAutoFeed().catch(() => null);
    }, { preventOverlap: true });
}

// 神秘商人可能在登录后的任意时间出现；登录后先检查，并持续短周期探测。
function stopMysteryShopAutoBuyTimer() {
    workerScheduler.clear('mystery_shop_auto_buy_initial');
    workerScheduler.clear('mystery_shop_auto_buy_interval');
    workerScheduler.clear('mystery_shop_auto_buy_after_save');
}

function runMysteryShopAutoBuy() {
    // 无论是否开启自动购买都保持轮询，用于统计"遇到神秘商人"次数；购买与否由 checkAndAutoBuyMysteryShop 内部按配置决定。
    if (!loginReady) return Promise.resolve();
    const { checkAndAutoBuyMysteryShop } = require('../services/mystery-shop');
    return checkAndAutoBuyMysteryShop(process.env.FARM_ACCOUNT_ID);
}

function startMysteryShopAutoBuyTimer() {
    const { AUTO_BUY_CHECK_INTERVAL_MS } = require('../services/mystery-shop');
    stopMysteryShopAutoBuyTimer();
    workerScheduler.setTimeoutTask('mystery_shop_auto_buy_initial', 10000, () => {
        runMysteryShopAutoBuy().catch(() => null);
    });
    workerScheduler.setIntervalTask('mystery_shop_auto_buy_interval', AUTO_BUY_CHECK_INTERVAL_MS, () => {
        runMysteryShopAutoBuy().catch(() => null);
    }, { preventOverlap: true });
}

// ==================== 间隔计算 ====================

function normalizeIntervalRangeSec(minVal, maxVal, defaultVal) {
    const def = Math.max(1, Number.parseInt(defaultVal, 10) || 3);
    let min = Math.max(1, Number.parseInt(minVal, 10) || def);
    let max = Math.max(1, Number.parseInt(maxVal, 10) || def);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals) {
    const iv = intervals && typeof intervals === 'object' ? intervals : {};
    const farmDefault = Math.max(2, Number.parseInt(iv.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(iv.farmMin, iv.farmMax, farmDefault);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    const helpRange = normalizeIntervalRangeSec(iv.helpMin, iv.helpMax, 30);
    CONFIG.helpCheckIntervalMin = helpRange.min * 1000;
    CONFIG.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(iv.stealMin, iv.stealMax, 25);
    CONFIG.stealCheckIntervalMin = stealRange.min * 1000;
    CONFIG.stealCheckIntervalMax = stealRange.max * 1000;
}

/** 在 [minMs, maxMs] 范围内随机取一个毫秒数 */
function randomIntervalMs(minMs, maxMs) {
    const min = Math.max(1, Math.floor(Number(minMs) || 3));
    const max = Math.max(min, Math.floor(Number(maxMs) || min * 2));
    if (max === min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * P2: 账号确定性错峰相位（毫秒）。
 * 不同账号对偷菜巡查产生一个固定且彼此不同的相位偏移，避免多号在同一时间点"齐刷"群攻，
 * 弱化并发偷菜的行为特征。偏移量上限由巡查间隔范围决定，不会累计失控。
 * @param {string|number} accountId
 * @returns {number} [0, spread) 的确定性相位
 */
function stealPhaseOffsetMs(accountId) {
    const id = Number(process.env.FARM_ACCOUNT_ID || accountId || 0) || 0;
    const minMs = Number(CONFIG.stealCheckIntervalMin) || 25000;
    const maxMs = Number(CONFIG.stealCheckIntervalMax) || 30000;
    // 相位散布取间隔宽度的约 1/3，额外 +1 保证非零账号有差异
    const spread = Math.max(500, Math.floor((maxMs - minMs) / 3));
    if (!id) return 0;
    return Math.abs((id * 2654435761) >>> 0) % spread;
}

// ==================== 统一调度时间重置 ====================

function resetUnifiedSchedule() {
    const farmDelay = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 3000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 5000
    );
    const helpDelay = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 30000,
        CONFIG.helpCheckIntervalMax || 35000
    );
    const stealDelay = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 25000,
        CONFIG.stealCheckIntervalMax || 30000
    ) + stealPhaseOffsetMs();
    const now = Date.now();
    nextFarmRunAt = now + farmDelay;
    nextHelpRunAt = now + helpDelay;
    nextStealRunAt = now + stealDelay;
}

// ==================== 农场 Tick ====================

async function runFarmTick(autoConfig) {
    if (farmTaskRunning || friendSyncPaused) return;
    farmTaskRunning = true;

    const nextDelay = randomIntervalMs(
        CONFIG.farmCheckIntervalMin || CONFIG.farmCheckInterval || 3000,
        CONFIG.farmCheckIntervalMax || CONFIG.farmCheckInterval || 5000
    );

    try {
        await runWithRequestPriority('farm', async () => {
            if (autoConfig.farm) await checkFarm();
            if (autoConfig.task) await checkAndClaimTasks();
            if (autoConfig.fertilizer_gift) await openFertilizerGiftPacksSilently();
        });
    } catch { } finally {
        nextFarmRunAt = Date.now() + nextDelay;
        farmTaskRunning = false;
    }
}

// ==================== 帮助 Tick ====================

let helpTaskRunning = false;
let nextHelpRunAt = 0;

async function runHelpTick(autoConfig) {
    if (helpTaskRunning || friendSyncPaused) return;
    if (!autoConfig.friend_help && !autoConfig.friend_golden_bug) return;
    helpTaskRunning = true;

    const nextDelay = randomIntervalMs(
        CONFIG.helpCheckIntervalMin || 30000,
        CONFIG.helpCheckIntervalMax || 35000
    );

    try {
        await runWithRequestPriority('friend', async () => {
            if (autoConfig.friend_help) await checkFriends({ onlyHelp: true });
            if (autoConfig.friend_golden_bug) await runGoldenBugPlacement();
        });
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            log('系统', `帮助巡查执行失败: ${  err.message}`, {
                module: 'system',
                event: '帮助巡查',
                result: 'error'
            });
        }
    } finally {
        nextHelpRunAt = Date.now() + nextDelay;
        helpTaskRunning = false;
    }
}

// ==================== 偷菜 Tick ====================

let stealTaskRunning = false;
let nextStealRunAt = 0;

async function runStealTick(autoConfig) {
    if (stealTaskRunning || friendSyncPaused) return;
    stealTaskRunning = true;

    const nextDelay = randomIntervalMs(
        CONFIG.stealCheckIntervalMin || 25000,
        CONFIG.stealCheckIntervalMax || 30000
    ) + stealPhaseOffsetMs();

    try {
        await runWithRequestPriority('friend', async () => {
            // 预约偷取：用户指定好友 + 成熟后延迟，独立于 friend_steal 开关执行
            try {
                await runDueStealPlans();
            } catch (err) {
                log('系统', `预约偷取执行失败: ${  err.message}`, {
                    module: 'system',
                    event: '预约偷取',
                    result: 'error'
                });
            }
            if (autoConfig.friend_steal) {
                await checkFriends({ onlySteal: true });
            }
        });
    } catch (err) {
        if (!isTransientNetworkError(err)) {
            log('系统', `偷菜巡查执行失败: ${  err.message}`, {
                module: 'system',
                event: '偷菜巡查',
                result: 'error'
            });
        }
    } finally {
        nextStealRunAt = Date.now() + nextDelay;
        stealTaskRunning = false;
    }
}

// ==================== 统一调度器 ====================

/**
 * 网关 亚健康健康检查：退避窗口内返回 false，表示「暂停发业务请求，给心跳让路」。
 * 也允许 worker 其它业务入口(如邮件领取、活动自动认领)统一复用。
 */
function isGatewayHealthyBackoffActive() {
    if (!gatewayHealthBackoffUntil) return false;
    if (Date.now() >= gatewayHealthBackoffUntil) {
        // 退避到期，恢复自动化
        gatewayHealthBackoffUntil = 0;
        if (gatewayHealthBackoffReason) {
            log('系统', `网关健康退避窗口已结束（${gatewayHealthBackoffReason}），恢复自动化任务`);
            gatewayHealthBackoffReason = '';
        }
        return false;
    }
    return true;
}

async function runUnifiedTick() {
    if (!unifiedSchedulerRunning || !loginReady || friendSyncPaused) return;

    // 网关亚健康退避：不发任何业务请求，让连接只剩心跳自愈
    if (isGatewayHealthyBackoffActive()) return;

    const now = Date.now();
    const shouldFarm = now >= nextFarmRunAt;
    const shouldHelp = now >= nextHelpRunAt;
    const shouldSteal = now >= nextStealRunAt;

    if (!shouldFarm && !shouldHelp && !shouldSteal) return;

    const autoConfig = getAutomation();
    if (shouldFarm) await runFarmTick(autoConfig);
    if (shouldHelp) await runHelpTick(autoConfig);
    if (shouldSteal) await runStealTick(autoConfig);
}

function scheduleUnifiedNextTick() {
    if (!unifiedSchedulerRunning) return;
    workerScheduler.clear('unified_next_tick');

    if (!loginReady) {
        workerScheduler.setTimeoutTask('unified_next_tick', 500, async () => {
            try { await runUnifiedTick(); } finally { scheduleUnifiedNextTick(); }
        });
        return;
    }

    const now = Date.now();
    const nearest = Math.min(
        Number(nextFarmRunAt) || now + 3000,
        Number(nextHelpRunAt) || now + 30000,
        Number(nextStealRunAt) || now + 25000
    );
    const waitMs = Math.max(100, nearest - now);

    workerScheduler.setTimeoutTask('unified_next_tick', waitMs, async () => {
        try { await runUnifiedTick(); } finally { scheduleUnifiedNextTick(); }
    });
}

function startUnifiedScheduler() {
    if (unifiedSchedulerRunning) return;
    unifiedSchedulerRunning = true;
    resetUnifiedSchedule();
    scheduleUnifiedNextTick();
}

function stopUnifiedScheduler() {
    unifiedSchedulerRunning = false;
    farmTaskRunning = false;
    helpTaskRunning = false;
    stealTaskRunning = false;
    workerScheduler.clear('unified_next_tick');
}

// ==================== 配置同步 ====================

function applyRuntimeConfig(config, syncStatusAfter = false) {
    const prevAuto = getAutomation();
    const prevCapitalMode = require('../models/store').getCapitalMode();
    const accountId = process.env.FARM_ACCOUNT_ID || '';

    applyConfigSnapshot(config || {}, {
        persist: false,
        accountId
    });
    const nextCapitalMode = require('../models/store').getCapitalMode();
    require('../services/capital-mode').reconcileConfigChange(prevCapitalMode, nextCapitalMode).catch(() => null);

    const revision = Number((config || {}).__revision || 0);
    if (revision > 0) appliedConfigRevision = revision;

    const intervals = config && config.intervals && typeof config.intervals === 'object'
        ? config.intervals : null;
    if (intervals) applyIntervalsToRuntime(intervals);

    if (loginReady) {
        refreshFarmCheckLoop(3000);
        refreshFriendCheckLoop(12000);
        resetUnifiedSchedule();
        scheduleUnifiedNextTick();

        const hasAutomation = !!(config && config.automation && typeof config.automation === 'object');
        if (hasAutomation) {
            const newAuto = getAutomation();

            const starClaimBecameEnabled = (
                !prevAuto?.star_passport_claim && newAuto?.star_passport_claim
            ) || (
                !prevAuto?.star_record_claim && newAuto?.star_record_claim
            ) || (
                !prevAuto?.qingmei_seed_claim && newAuto?.qingmei_seed_claim
            ) || (
                !prevAuto?.qingmei_wine_brew && newAuto?.qingmei_wine_brew
            ) || (
                !prevAuto?.qixi_dew_use && newAuto?.qixi_dew_use
            ) || (
                !prevAuto?.qixi_bridge_build && newAuto?.qixi_bridge_build
            ) || (
                !prevAuto?.qixi_sachet_gift && newAuto?.qixi_sachet_gift
            ) || [
                'pet_diary_adopt',
                'pet_diary_feed',
                'pet_diary_draw',
                'pet_diary_story_claim',
                'pet_diary_seed_claim',
                'pet_diary_solar_claim',
                'pet_diary_treasure_open',
                'pet_diary_compensation_claim',
                'pet_diary_battle',
                'pet_diary_charm_equip'
            ].some(key => !prevAuto?.[key] && newAuto?.[key]);
            if (starClaimBecameEnabled) {
                workerScheduler.setTimeoutTask('star_activity_claim_after_save', 2000, () => {
                    runStarActivityAutoClaims().catch(() => null);
                });
            }

            const mysteryShopConfigChanged = [
                'mystery_shop_auto_buy',
                'mystery_shop_allow_gold',
                'mystery_shop_allow_coupon',
                'mystery_shop_allow_gold_bean'
            ].some(key => prevAuto?.[key] !== newAuto?.[key]);
            if (newAuto?.mystery_shop_auto_buy && mysteryShopConfigChanged) {
                workerScheduler.setTimeoutTask('mystery_shop_auto_buy_after_save', 2000, () => {
                    runMysteryShopAutoBuy().catch(() => null);
                });
            }

            // 邮箱领取从关变开 → 立即执行一次
            if (!prevAuto?.email && newAuto?.email) {
                workerScheduler.setTimeoutTask('email_claim_after_save', 2000, () => {
                    runEmailAutoClaim().catch(() => null);
                });
            }

            // 日报推送从关变开 → 立即排程并测试推送一次
            const prevReport = !!(prevAuto && prevAuto.daily_report_push);
            const newReport = !!(newAuto && newAuto.daily_report_push);
            if (!prevReport && newReport) {
                startDailyReportTimer();
                workerScheduler.setTimeoutTask('daily_report_test', 3000, () => {
                    runDailyReport().catch(() => null);
                });
            }

            // 每日任务从关变开 → 立即执行一次
            const prevDailyEnabled = isDailyRoutineEnabled(prevAuto);
            const newDailyEnabled = isDailyRoutineEnabled(newAuto);
            if (!prevDailyEnabled && newDailyEnabled) {
                workerScheduler.setTimeoutTask('daily_routine_immediate', 2000, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            // 施肥策略变化 → 立即施肥
            const prevFert = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const newFert = String(newAuto && newAuto.fertilizer ? newAuto.fertilizer : '').toLowerCase();
            const fertChanged = prevFert !== newFert;
            if (fertChanged && (newFert === 'both' || newFert === 'organic' || newFert === 'smart' || newFert === 'smart_only' || newFert === 'smart_normal' || newFert === 'final_normal' || newFert === 'final_organic')) {
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 1000, async () => {
                    if (!loginReady) return;
                    try {
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (err) {
                        log('施肥', `保存配置后立即施肥失败: ${  err.message}`, {
                            module: 'farm', event: '施肥', result: 'error'
                        });
                    }
                });
            }

            // 好友捣乱从关变开 → 立即执行
            const prevBad = !!(prevAuto && prevAuto.friend_bad);
            const newBad = !!(newAuto && newAuto.friend_bad);
            if (!prevBad && newBad) {
                workerScheduler.setTimeoutTask('friend_bad_immediate', 3000, async () => {
                    if (!loginReady) return;
                    try {
                        await runBadOnceOnStartup(true);
                    } catch (err) {
                        log('好友', `开启自动捣乱后立即执行失败: ${  err.message}`, {
                            module: 'friend', event: '开启捣乱立即执行', result: 'error'
                        });
                    }
                });
                startBadHourlyTimer();
            }

            const prevGoldenBug = !!(prevAuto && prevAuto.friend_golden_bug);
            const newGoldenBug = !!(newAuto && newAuto.friend_golden_bug);
            if (!prevGoldenBug && newGoldenBug) {
                workerScheduler.setTimeoutTask('friend_golden_bug_immediate', 3000, async () => {
                    if (!loginReady) return;
                    await runGoldenBugPlacement({ force: true });
                });
            }
        }
    }

    if (syncStatusAfter) syncStatus();
}

// ==================== 主控消息处理 ====================

onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'start') {
            await startBot(msg.config);
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        }
    } catch (err) {
        sendToMaster({ type: 'error', error: err.message });
    }
});

// ==================== 每日收益日报推送 ====================

/** 计算下一个目标小时（北京时间）的时间戳 */
function nextBeijingHour(hour) {
  const h = Math.max(0, Math.min(23, Number(hour) || 8));
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  beijing.setUTCHours(h, 0, 0, 0);
  let ts = beijing.getTime() - 8 * 3600 * 1000;
  if (ts <= now.getTime()) {
    beijing.setUTCDate(beijing.getUTCDate() + 1);
    ts = beijing.getTime() - 8 * 3600 * 1000;
  }
  return ts;
}

async function runDailyReport() {
  if (!getAutomation().daily_report_push) return;
  try {
    const userState = getUserState();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    await sendDailyReport({
      accountId,
      accountName: userState && userState.name ? userState.name : '',
      connected: !!loginReady
    });
    console.warn(`[日报] 已推送昨日日报 (${userState && userState.name || accountId})`);
  } catch (err) {
    console.warn(`[日报] 推送失败: ${err && err.message}`);
  }
}

function stopDailyReportTimer() {
  workerScheduler.clear('daily_report_timer');
}

function startDailyReportTimer() {
  stopDailyReportTimer();
  if (!getAutomation().daily_report_push) return;
  const hour = Number(getAutomation().daily_report_hour) || 8;
  const ts = nextBeijingHour(hour);
  const delay = Math.max(1000, ts - Date.now());
  workerScheduler.setTimeoutTask('daily_report_timer', delay, () => {
    runDailyReport().catch(() => null).finally(() => {
      startDailyReportTimer();
    });
  });
}

// ==================== 自动捣蛋（放虫放草）每小时定时 ====================

const BAD_HOURLY_INTERVAL_MS = 60 * 60 * 1000;

function scheduleBadHourlyNext(delayMs) {
  workerScheduler.setTimeoutTask('bad_hourly_timer', delayMs, () => {
    if (!loginReady) {
      scheduleBadHourlyNext(BAD_HOURLY_INTERVAL_MS);
      return;
    }
    runBadHourly()
      .catch(() => null)
      .finally(() => scheduleBadHourlyNext(BAD_HOURLY_INTERVAL_MS));
  });
}

function stopBadHourlyTimer() {
  workerScheduler.clear('bad_hourly_timer');
}

function startBadHourlyTimer() {
  stopBadHourlyTimer();
  if (!getAutomation().friend_bad) return;
  scheduleBadHourlyNext(10 * 60 * 1000); // 首次 10 分钟后，之后每小时一次
}

// ==================== 启动/停止 Bot ====================

async function startBot(config) {
    if (isRunning) return;
    isRunning = true;

    const { code, platform } = config;
    CONFIG.platform = platform || 'qq';

    await loadProto();
    log('系统', '正在连接服务器...');

    applyRuntimeConfig(getConfigSnapshot(), false);
    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    // WebSocket 错误监听
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (wsErr) => {
        if ((Number(wsErr?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 5000) return;
        wsErrorHandledAt = now;

        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: wsErr?.message || ''
        });
        if (isRunning) {
            workerScheduler.setTimeoutTask('ws_error_cleanup', 500, () => {
                if (isRunning) stopBot().catch(() => exitWorker(0));
            });
        }
        // Code 失效 PushPlus 告警（节流在 notifyCodeExpired 内按账号持久化，避免重连风暴刷屏）
        notifyCodeExpired({
            accountId: process.env.FARM_ACCOUNT_ID || '',
            platform: CONFIG.platform || 'qq',
            message: wsErr && wsErr.message ? String(wsErr.message).slice(0, 120) : '',
        }).catch(() => {});
    };
    networkEvents.on('ws_error', onWsError);
    networkEvents.on('reconnect_failed', onReconnectFailed);
    networkEvents.on('kickout', onKickout);

    // 网关模式专属事件：连接假死判死自愈 / Code 失效停止重连
    if (onHeartbeatDead) networkEvents.off('heartbeat_dead', onHeartbeatDead);
    onHeartbeatDead = () => {
        log('系统', '连接假死（心跳长时间无响应），网关正在自动重连恢复...');
        sendToMaster({ type: 'ws_reconnect_failed', reason: 'heartbeat_dead' });
    };
    networkEvents.on('heartbeat_dead', onHeartbeatDead);

    if (onCodeInvalid) networkEvents.off('code_invalid', onCodeInvalid);
    onCodeInvalid = () => {
        log('系统', 'Code 已失效，网关已停止自动重连，请重新抓包/扫码');
        sendToMaster({ type: 'ws_reconnect_failed', reason: 'code_invalid' });
        // Code 失效 PushPlus 告警（notifyCodeExpired 内按账号节流，避免刷屏）
        notifyCodeExpired({
            accountId: process.env.FARM_ACCOUNT_ID || '',
            platform: CONFIG.platform || 'qq',
            message: 'code_invalid',
        }).catch(() => { });
    };
    networkEvents.on('code_invalid', onCodeInvalid);

    // 网关亚健康退避：业务请求连续超时(未到判死)时暂停自动化发请求，给心跳让路自愈
    if (onConnectionDegraded) networkEvents.off('connection_degraded', onConnectionDegraded);
    onConnectionDegraded = (payload) => {
        const backoffMs = Number(payload && payload.backoffMs) || 60000;
        gatewayHealthBackoffUntil = Date.now() + backoffMs;
        gatewayHealthBackoffReason = `业务请求连续超时(${payload && payload.degradedStreak || 1})`;
        // ⭐ 2026-11-01：同步下推到 gateway-client 的传输层闸门。
        // 原来只有 runUnifiedTick 检查 gatewayHealthBackoffUntil，其余 10+ 个业务入口
        // 完全无视退避，继续往假死连接打请求 → pending 堆积 → 更快判死重连 → 消耗 Code → 1006。
        // 现在由 sendMsgAsync 统一拦截，才真正做到"暂停所有业务请求、只留心跳"。
        try {
            if (typeof setHealthBackoff === 'function') {
                setHealthBackoff(backoffMs, gatewayHealthBackoffReason);
            }
        } catch { /* 兼容直连模式：无此接口时静默跳过 */ }
        console.log(`[worker] 网关亚健康退避 ${Math.round(backoffMs / 1000)}s，暂停农场/帮助/偷菜给心跳让路`);
        log('系统', `网关亚健康（业务请求连续超时），暂停自动化任务 ${Math.round(backoffMs / 1000)}s 给心跳让路，待恢复后自动继续`);
        sendToMaster({
            type: 'log',
            data: {
                time: formatLocalDateTime24(new Date()),
                tag: '保活',
                msg: `网关亚健康退避 ${Math.round(backoffMs / 1000)}s（连接假死前自动让路，避免判死掉线）`,
                isWarn: true,
                meta: { event: 'connection_degraded', backoffMs }
            }
        });
    };
    networkEvents.on('connection_degraded', onConnectionDegraded);

    if (onConnectionRecovered) networkEvents.off('connection_recovered', onConnectionRecovered);
    onConnectionRecovered = () => {
        if (gatewayHealthBackoffUntil) {
            gatewayHealthBackoffUntil = 0;
            gatewayHealthBackoffReason = '';
            // ⭐ 2026-11-01：同步解除传输层闸门。
            // 必须先 clear 再往下走，否则 sendMsgAsync 仍会拒绝业务请求，
            // 出现"日志说已恢复、实际一个请求都发不出去"的假恢复（这类不一致排查成本极高）。
            try {
                if (typeof clearHealthBackoff === 'function') clearHealthBackoff();
            } catch { /* 兼容直连模式 */ }
            log('系统', '网关亚健康已恢复，立即恢复自动化任务');
        }
    };
    networkEvents.on('connection_recovered', onConnectionRecovered);

    // 断线监听
    if (onDisconnectHandler) networkEvents.off('disconnect', onDisconnectHandler);
    onDisconnectHandler = () => {
        if (!loginReady) return;
        loginReady = false;
        log('系统', '连接断开，暂停自动化任务，等待重连...');
        // ⭐ 2026-11-01：主动重连网关（原实现只打日志，从不重连 → 「僵尸 worker」）
        //
        // 背景：gateway 的 sock.on('close') 注释写明「worker 断开：保留游戏连接，等待 worker 重连」，
        // 且 gateway-process.js 有复用分支：
        //     if (liveWs && !codeChanged) { 复用已有网关连接（worker 重启免 Code） }
        // 但 worker 侧从来没有"重发 connect 帧"这一步 → gateway 一直等，worker 一直等，双方都等。
        // 结果：进程活着、socket 断了、账号永久离线，只能靠守护脚本 stop + 补码。
        //
        // 针对「场景 A」（worker 自己重启 / 主容器重启，gateway 的 gameserver ws 仍活着）：
        // 重发 connect 帧即可走复用分支，**不消耗 Code、不重新登录 gameserver**。
        // 针对「场景 B」（gateway 容器重启，内存清零）：复用分支走不到，会用旧 code 尝试，
        // 失败后由守护脚本兜底补码 —— 与现状一致，不退化。
        scheduleGatewayReconnect();
    };
    networkEvents.on('disconnect', onDisconnectHandler);

    // ===== 网关重连（带退避 + 风暴防护）=====
    // 三道闸门，缺一不可（吸取 2026-09-02「单账号重连风暴拖垮同网关其它账号」的教训）：
    //   ① 单账号指数退避 1s→2s→4s→…→60s + 抖动：避免密集重连
    //   ② 连续失败上限：超限停手，交守护脚本兜底，不再无脑冲
    //   ③ 单账号单飞（gatewayReconnectInFlight）：防止 timer 交叉触发产生并发 connect
    const RECONNECT_MAX_ATTEMPT = 10;

    function clearReconnectTimer() {
        if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
        if (gatewayReconnectWatchdog) { clearTimeout(gatewayReconnectWatchdog); gatewayReconnectWatchdog = null; }
        gatewayReconnectInFlight = false;
    }

    function scheduleGatewayReconnect() {
        // 用户主动 stop / 进程退出中：绝不能重连，否则停不下来
        if (!isRunning) return;
        // 已在退避等待中：不重复排队
        if (gatewayReconnectTimer) return;
        // 单飞：上一轮 connect 还没返回就不叠加新的一轮
        if (gatewayReconnectInFlight) return;
        if (gatewayReconnectAttempt >= RECONNECT_MAX_ATTEMPT) {
            log('系统', `网关重连已连续失败 ${gatewayReconnectAttempt} 次，停止自动重连（请检查 Code 或等待补码守护）`);
            return;
        }
        gatewayReconnectAttempt += 1;
        // 指数退避封顶 60s，叠加 0~1.5s 抖动，避免多账号同时重连
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, gatewayReconnectAttempt - 1))
            + Math.floor(Math.random() * 1500);
        log('系统', `将在 ${(backoffMs / 1000).toFixed(1)}s 后重连网关（第 ${gatewayReconnectAttempt}/${RECONNECT_MAX_ATTEMPT} 次）`);
        gatewayReconnectTimer = setTimeout(() => {
            gatewayReconnectTimer = null;
            if (!isRunning) return;
            try {
                gatewayReconnectInFlight = true;
                // ⭐ 看门狗：connect 失败时**没有任何回调**（gateway-client 的 ws_error 只在收到
                // error 帧时触发，连不上根本没有帧），若不设超时兜底，gatewayReconnectInFlight 会永久
                // 为 true，之后所有 scheduleGatewayReconnect() 都被单飞闸门挡掉 → 重连彻底卡死。
                // 取 25s：connect 内部的建连 + 登录通常在数秒内完成，25s 足以覆盖慢网。
                gatewayReconnectWatchdog = setTimeout(() => {
                    gatewayReconnectWatchdog = null;
                    if (!gatewayReconnectInFlight) return;
                    gatewayReconnectInFlight = false;
                    if (loginReady) return; // 期间其实已经连上了
                    log('系统', '网关重连超时未收到登录响应，继续退避重试');
                    scheduleGatewayReconnect();
                }, 25000);
                if (gatewayReconnectWatchdog.unref) gatewayReconnectWatchdog.unref();
                // 复用既有 connect：onReady 是完整的初始化入口（启调度器/注册定时器/syncStatus），
                // connect 内部会 ensureSocket() 自动重建到网关的 socket 并重发 connect 帧。
                connect(code, onReady);
            } catch (e) {
                gatewayReconnectInFlight = false;
                clearReconnectTimer();
                log('系统', `网关重连调用异常: ${e && e.message}`);
                scheduleGatewayReconnect();
            }
        }, backoffMs);
        if (gatewayReconnectTimer.unref) gatewayReconnectTimer.unref();
    }

    // 登录成功回调
    const onReady = async () => {
        // 重连成功：复位退避状态，本次会话不再受之前失败计数影响
        gatewayReconnectInFlight = false;
        gatewayReconnectAttempt = 0;
        clearReconnectTimer();
        loginReady = true;

        // 出售收益监听
        if (onSellGain) networkEvents.off('sell', onSellGain);
        onSellGain = (sellInfo) => {
            const gold = Number(sellInfo && sellInfo.gold || sellInfo || 0);
            const count = Number(sellInfo && sellInfo.count || 0);
            if (!Number.isFinite(gold) || gold <= 0) return;
            if (count > 0) recordOperation('sell', count);
        };
        networkEvents.on('sell', onSellGain);

        // 收获后自动出售
        if (onFarmHarvested) networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = async () => {
            if (getAutomation().rain_poem_summon_use === true) {
                workerScheduler.setTimeoutTask('rain_poem_after_harvest', 2000, () => {
                    runStarActivityAutoClaims().catch(() => null);
                });
            }
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (err) {
                log('仓库', `收获后自动出售失败: ${  err.message}`, {
                    module: 'warehouse', event: '收获后出售', result: 'error'
                });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        if (onDogSkillGiftPending) networkEvents.off('dogSkillGiftPending', onDogSkillGiftPending);
        onDogSkillGiftPending = (count) => {
            const pendingCount = Math.max(0, toNum(count));
            if (!loginReady || pendingCount <= 0) return;
            require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts(pendingCount).catch(() => null);
        };
        networkEvents.on('dogSkillGiftPending', onDogSkillGiftPending);

        // 单次背包请求同步点券(1002)和金豆豆(1005)，避免登录阶段重复并发查询。
        // 注意：gateway 模式下 network.js 里的 fetchGoldBeanFromBag 不会被调用（那条路径
        // 只在非 gateway 的 sendLogin 里执行），所以金豆必须在 worker 侧从背包取值，
        // 否则前端「金豆」恒为 0。上游实现同样在此处同时读 1002/1005。
        try {
            const bag = await getBag();
            const items = getBagItems(bag);
            let couponCount = 0;
            let goldBeanCount = 0;
            for (const item of items || []) {
                const itemId = toNum(item && item.id);
                if (itemId === 1002) couponCount = toNum(item.count);
                else if (itemId === 1005) goldBeanCount = toNum(item.count);
            }
            const state = getUserState();
            state.coupon = Math.max(0, couponCount);
            state.goldBean = Math.max(0, goldBeanCount);
        } catch { }

        // 预热鹊桥活动结束态缓存：登录后立即探测一次，确保 stats 的友灵露隐藏判断、
        // worker 的灵露/驻桥/香囊自动化在首次巡查前就有正确的活动状态可用。
        try {
            const actMod = require('../services/activity');
            if (actMod.getQixiEndedState) actMod.getQixiEndedState().catch(() => null);
        } catch { /* 预热失败不影响启动 */ }

        // 初始化统计数据（含金豆；initStatsWithPersistence 内部会恢复今日累计增益，
        // 之后不再 resetSessionGains，避免重登后今日金币/点券/金豆加减归零）
        const userState = getUserState();
        const accountId = process.env.FARM_ACCOUNT_ID || '';
        initStatsWithPersistence(
            accountId,
            Number(userState.gold || 0),
            Number(userState.exp || 0),
            Number(userState.coupon || 0),
            Number(userState.goldBean || 0)
        );

        // 恢复今日已用捣乱预算（虫/草共享 99），跨 worker 重启保留，避免重连后预算归零叠加超放
        initLocalBadCount(accountId);
        // 恢复今日「帮忙经验已满」状态（跨重启保留），否则手动一键务农被服务端拒绝时
        // 本地以为还能帮，只能给笼统提示（2026-10-22 希恩斯实测）
        require('../services/friend-operation-limits').restoreHelpExpLimit(accountId);

        // QQ 好友列表接口（GetGameFriends）按「已知 GID」拉取：抓包登录只在抓包那一刻
        // 导入一次 GID，之后新增的好友永远不会出现在列表里；NapCat 扫码更是完全没有 GID。
        // 因此所有 QQ 登录方式上号后都引导同步一次 GID（好友全量/待处理申请/最近访客）。
        if ((CONFIG.platform || 'qq') === 'qq') {
            workerScheduler.setTimeoutTask('friend_gid_bootstrap', 2000, async () => {
                if (!loginReady) return;
                try {
                    await bootstrapQqFriendGids();
                } catch (err) {
                    log('好友', `好友GID引导同步失败: ${err.message}`, {
                        module: 'friend', event: 'QQ好友GID引导同步', result: 'error'
                    });
                }
            });
        }

        // 处理邀请码
        await processInviteCodes();

        // 打开肥料礼包
        if (getAutomation().fertilizer_gift) {
            await openFertilizerGiftPacksSilently().catch(() => 0);
        }

        // 延迟执行放虫放草
        workerScheduler.setTimeoutTask('bad_startup_once', 15000, async () => {
            try {
                await runBadOnceOnStartup();
            } catch (err) {
                log('好友', `启动时放虫放草执行失败: ${  err.message}`, {
                    module: 'friend', event: '启动放虫放草失败', error: err.message
                });
            }
        });

        // 启动各检查循环
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });

        // 启动统一调度器
        if (unifiedSchedulerRunning) {
            resetUnifiedSchedule();
            scheduleUnifiedNextTick();
        } else {
            startUnifiedScheduler();
        }

        // 启动每日定时器
        startDailyRoutineTimer();
        startStarActivityClaimTimer();
        startMysteryShopAutoBuyTimer();
        startEmailClaimTimer();
        startDailyReportTimer();
        startBadHourlyTimer();
        startPetFoodTimer();

        syncStatus();
    };

    // 建立连接
    connect(code, onReady);

    // 定期同步状态
    workerScheduler.setIntervalTask('status_sync', 5000, syncStatus, { preventOverlap: true });
}

async function stopBot() {
    if (!isRunning) return exitWorker(0);
    saveStats();
    isRunning = false;
    loginReady = false;
    friendSyncPaused = false;

    stopUnifiedScheduler();
    stopMysteryShopAutoBuyTimer();
    stopEmailClaimTimer();
    stopDailyReportTimer();
    stopBadHourlyTimer();
    stopPetFoodTimer();

    networkEvents.off('kickout', onKickout);
    networkEvents.off('reconnect_failed', onReconnectFailed);
    if (onHeartbeatDead) {
        networkEvents.off('heartbeat_dead', onHeartbeatDead);
        onHeartbeatDead = null;
    }
    if (onCodeInvalid) {
        networkEvents.off('code_invalid', onCodeInvalid);
        onCodeInvalid = null;
    }
    if (onConnectionDegraded) {
        networkEvents.off('connection_degraded', onConnectionDegraded);
        onConnectionDegraded = null;
    }
    if (onConnectionRecovered) {
        networkEvents.off('connection_recovered', onConnectionRecovered);
        onConnectionRecovered = null;
    }

    if (onDisconnectHandler) {
        networkEvents.off('disconnect', onDisconnectHandler);
        onDisconnectHandler = null;
    }
    // ⭐ 2026-11-01：清掉已排队的网关重连 timer。
    // 只靠 isRunning=false 不足以阻止：timer 已经排队，触发时会先检查 isRunning 没错，
    // 但若不清理，用户"停止后马上启动"会遇上旧 timer 用旧 code 抢连，形成两条并行的重连。
    if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
    if (gatewayReconnectWatchdog) { clearTimeout(gatewayReconnectWatchdog); gatewayReconnectWatchdog = null; }
    gatewayReconnectInFlight = false;
    gatewayReconnectAttempt = 0;
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }

    stopFarmCheckLoop();
    stopFriendCheckLoop();
    stopDailyRoutineTimer();
    stopStarActivityClaimTimer();
    cleanupTaskSystem();
    workerScheduler.clearAll();
    stopNetwork('账号停止');

    const ws = getWs();
    if (ws) ws.close();

    exitWorker(0);
}

// ==================== 踢下线处理 ====================

function onKickout(info) {
    const reason = info && info.reason ? info.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${  reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 500, () => {
        stopBot().catch(() => exitWorker(0));
    });
}

function onReconnectFailed(info) {
    const reason = info && info.reason ? info.reason : '未知';
    log('系统', `连接重连中（网关持续重试），暂不停账号。原因: ${  reason}`);
    // 网关会持续重连：worker 保持存活以等待恢复，不自杀、不触发主进程 stopWorker。
    // Code 可能已失效，发一次告警（节流）提示用户重抓，但号不会因此被踢下线。
    notifyCodeExpired({
        accountId: process.env.FARM_ACCOUNT_ID || '',
        platform: CONFIG.platform || 'qq',
        message: '网关重连多次失败，Code 可能已失效，请重抓后 /start',
    }).catch(() => {});
}

// ==================== API 调用处理 ====================

async function handleApiCall(msg) {
    const { id, method, args } = msg;
    let result = null;
    let error = null;

    // 好友同步操作期间暂停自动化
    const isFriendSync = method === 'getFriends' && args[0] === true
        || method === 'fetchFriendsDogInfo'
        || method === 'syncFriendsFromGids';

    if (isFriendSync) {
        friendSyncPaused = true;
        log('系统', '好友同步操作开始，已暂停其他自动化进程', {
            module: 'system', event: '好友同步暂停', method
        });
    }

    try {
        switch (method) {
            case 'getLands':
                result = await getLandsDetail();
                if (result?.lands?.length) {
                    try {
                        const { isQixiDewApplied, clearQixiDewApplied, getQixiEndedStateCached } = require('../services/activity');
                        // 鹊桥活动已结束：灵露效果已失效，清空本地标记，不再在地图上展示"鹊羽灵露已使用"
                        const qixiState = getQixiEndedStateCached && getQixiEndedStateCached();
                        if (qixiState && qixiState.ended) {
                            result.lands = result.lands.map(land => ({ ...land, qixiDewApplied: undefined }));
                        } else {
                            result.lands = result.lands.map(land => {
                                // 双源：服务端社交道具状态（dewApplied）优先，本地持久化记录兜底。
                                // 记录绑定 plantId：作物收获重种后 plantId 变化视为失效；空地不展示。
                                const plantId = Number(land?.plantId || land?.displayPlantId || 0);
                                const inCropCycle = !!plantId && ['growing', 'harvestable'].includes(land?.status);
                                const localApplied = inCropCycle && isQixiDewApplied(land?.id, plantId);
                                if (!localApplied && !land?.dewApplied && isQixiDewApplied(land?.id)) {
                                    // 本地记录存在但当前地块为空/已重种（无 plantId 兜底时）→ 清除过期标记
                                    clearQixiDewApplied(land?.id);
                                }
                                if (land?.dewApplied || localApplied) return { ...land, qixiDewApplied: true };
                                return land;
                            });
                        }
                    } catch { /* 活动模块异常时忽略灵露标记 */ }
                }
                try {
                    const { getOwnWeatherStatus } = require('../services/activity');
                    result.weather = await getOwnWeatherStatus();
                } catch (weatherError) {
                    result.weather = null;
                }
                break;
            case 'getFriends':
                result = await getFriendsList(args[0] === true);
                break;
            case 'clearFriendsCache':
                require('../services/friend').clearFriendsListCache();
                result = { ok: true };
                break;
            case 'getInteractRecords':
                result = await getInteractRecords();
                break;
            case 'getFriendLands':
                result = await getFriendLandsDetail(args[0]);
                break;
            case 'doFriendOp':
                result = await doFriendOperation(args[0], args[1]);
                break;
            case 'getFriendDogInfo':
                result = await getFriendDogInfo(args[0]);
                break;
            case 'batchGetFriendDogInfo':
                result = await batchGetFriendDogInfo(args[0]);
                break;
            case 'syncFriendsFromGids':
                result = await syncFriendsFromGids(args[0]);
                break;
            case 'fetchFriendsDogInfo':
                result = await fetchFriendsDogInfo();
                break;
            case 'delFriend':
                result = await delFriend(args[0]);
                break;
            case 'getSeeds':
                result = await getAvailableSeeds();
                break;
            case 'getBag':
                result = await require('../services/warehouse').getBagDetail();
                break;
            case 'getSkins':
                result = await require('../services/skin').getSkinOverview();
                break;
            case 'equipSkin':
                result = await require('../services/skin').equipSkin(args[0], args[1]);
                break;
            case 'getBagSeeds':
                result = await require('../services/warehouse').getBagSeeds();
                break;
            case 'getDogSkillGiftStatus': {
                const dogGifts = require('../services/dog-skill-gifts');
                result = { pendingCount: dogGifts.getPendingGiftCount(await dogGifts.getDogInfo()) };
                break;
            }
            case 'claimDogSkillGifts':
                result = await require('../services/dog-skill-gifts').checkAndClaimDogSkillGifts();
                break;
            case 'getPetOverview':
                result = await require('../services/pets').getPetOverview();
                break;
            case 'deployDog':
                require('../services/capital-mode').releaseForManualCommand();
                result = await require('../services/pets').deployDog(args[0]);
                break;
            case 'withdrawDog':
                require('../services/capital-mode').releaseForManualCommand();
                result = await require('../services/pets').withdrawDog();
                break;
            case 'feedDog':
                result = await require('../services/pets').feedDog(args[0], args[1]);
                break;
            case 'activateDog':
                require('../services/capital-mode').releaseForManualCommand();
                result = await require('../services/pets').activateDog(args[0]);
                break;
            case 'getProtectLogs':
                result = await require('../services/pets').getProtectLogs();
                break;
            case 'useItem': {
                const { useItem } = require('../services/warehouse');
                const itemId = Number(args[0]) || 0;
                const count = Math.max(1, Number(args[1]) || 1);
                result = await useItem(itemId, count, []);
                break;
            }
            case 'sellItems': {
                const { sellItems } = require('../services/warehouse');
                const items = Array.isArray(args[0]) ? args[0] : [];
                const totalCount = items.reduce((sum, it) => sum + (Number(it.count) || 0), 0);
                result = await sellItems(items.map(it => ({
                    id: it.id, count: it.count, uid: it.uid || 0
                })));
                if (totalCount > 0) recordOperation('sell', totalCount);
                break;
            }
            case 'setAutomation': {
                const item = args && args[0] ? args[0] : {};
                const patch = { [item.key]: item.value };
                applyRuntimeConfig({ automation: patch }, true);
                result = getAutomation();
                break;
            }
            case 'doFarmOp':
                result = await runFarmOperation(args[0]);
                break;
            case 'setUnifiedHarvest':
                if (args[0] === false) {
                    result = { active: false, pacing: cancelUnifiedHarvest() };
                }
                else {
                    result = { active: true, pacing: startUnifiedHarvest() };
                }
                break;
            case 'getUnifiedHarvest':
                result = { active: isUnifiedHarvestActive(), pacing: getHarvestPacing() };
                break;
            case 'buyFertilizer': {
                const fertType = args[0] || 'organic';
                const count = Number(args[1]) || 1;
                result = await autoBuyFertilizer(true, fertType, count);
                break;
            }
            case 'checkAndBuyFertilizer': {
                const opts = args[0] || {};
                result = await checkAndBuyFertilizerBoth(opts);
                break;
            }
            case 'getEmails': {
                const { getEmailList } = require('../services/email');
                const boxType = Number(args[0]) || 0;
                const list = boxType
                    ? await getEmailList(boxType)
                    : { emails: [] };
                result = { box_type: boxType, emails: list.emails || [] };
                break;
            }
            case 'claimEmail': {
                const { claimEmail } = require('../services/email');
                const boxType = Number(args[0]) || 1;
                const emailId = String(args[1] || '');
                const reply = await claimEmail(boxType, emailId);
                result = { items: reply.items || [], emailId };
                break;
            }
            case 'getAnalytics': {
                const { getPlantRankings } = require('../services/analytics');
                result = getPlantRankings(args[0]);
                break;
            }
            case 'getShopInfo': {
                const { getShopInfo } = require('../services/farm');
                result = await getShopInfo(args[0]);
                break;
            }
            case 'buyGoods': {
                const { buyGoods } = require('../services/farm');
                result = await buyGoods(args[0], args[1], args[2]);
                break;
            }
            case 'getMallGoods': {
                const { getMallGoodsList } = require('../services/mall');
                result = await getMallGoodsList(0);
                break;
            }
            case 'buyMallGoods': {
                const { purchaseMallGoods } = require('../services/mall');
                result = await purchaseMallGoods(args[0], args[1]);
                break;
            }
            case 'getMysteryShop': {
                const { getActiveMysteryShop } = require('../services/mystery-shop');
                result = await getActiveMysteryShop();
                break;
            }
            case 'buyMysteryShopGoods': {
                const { buyMysteryShopGoods } = require('../services/mystery-shop');
                result = await buyMysteryShopGoods(args[0]);
                break;
            }
            case 'abandonMysteryShop': {
                const { abandonMysteryShop } = require('../services/mystery-shop');
                result = await abandonMysteryShop();
                break;
            }
            case 'getActivityShop': {
                const { getNanguaShop } = require('../services/activity');
                result = await getNanguaShop();
                break;
            }
            case 'getActivityDiscoveryList': {
                const { getActivityDiscoveryList } = require('../services/activity');
                result = await getActivityDiscoveryList();
                break;
            }
            case 'getActivityGroupSnapshot': {
                const { getActivityGroupSnapshot } = require('../services/activity');
                result = await getActivityGroupSnapshot(args[0], args[1]);
                break;
            }
            case 'getBulletinList': {
                const { getBulletinList } = require('../services/bulletin');
                result = await getBulletinList();
                break;
            }
            case 'getBulletinDetail': {
                const { getBulletinDetail } = require('../services/bulletin');
                result = await getBulletinDetail(args[0]);
                break;
            }
            case 'buyActivityShopItem': {
                const { buyNanguaShopItem } = require('../services/activity');
                result = await buyNanguaShopItem(args[0], args[1]);
                break;
            }
            case 'refreshActivityShop': {
                const { refreshNanguaShop } = require('../services/activity');
                result = await refreshNanguaShop();
                break;
            }
            case 'getHeluActivity': {
                const { getHeluActivity } = require('../services/activity');
                result = await getHeluActivity();
                break;
            }
            case 'getHonghuaActivity': {
                const { getHonghuaActivity } = require('../services/honghua-activity');
                result = await getHonghuaActivity();
                break;
            }
            case 'donateHonghuaLove': {
                const { donateHonghuaLove } = require('../services/honghua-activity');
                result = await donateHonghuaLove();
                break;
            }
            case 'donateHonghuaFund': {
                const { donateHonghuaFund } = require('../services/honghua-activity');
                result = await donateHonghuaFund();
                break;
            }
            case 'claimHonghuaShare': {
                const { claimHonghuaShare } = require('../services/honghua-activity');
                result = await claimHonghuaShare();
                break;
            }
            case 'claimHonghuaTiers': {
                const { claimHonghuaTiers } = require('../services/honghua-activity');
                result = await claimHonghuaTiers();
                break;
            }
            case 'getStarActivity': {
                const { getStarActivity } = require('../services/activity');
                result = await getStarActivity();
                break;
            }
            case 'claimStarRecordRewards': {
                const { claimStarRecordRewards } = require('../services/activity');
                result = await claimStarRecordRewards();
                break;
            }
            case 'exchangeStarShopItem': {
                const { exchangeStarShopItem } = require('../services/activity');
                result = await exchangeStarShopItem(args[0], args[1]);
                break;
            }
            case 'exchangeHeluShopItem': {
                const { exchangeHeluShopItem } = require('../services/activity');
                result = await exchangeHeluShopItem(args[0], args[1]);
                break;
            }
            case 'drawHeluGiftLotus': {
                const { drawHeluGiftLotus } = require('../services/activity');
                result = await drawHeluGiftLotus(args[0] || {});
                break;
            }
            case 'claimSeasonPassportRewards': {
                const { claimSeasonPassportRewards } = require('../services/activity');
                result = await claimSeasonPassportRewards();
                break;
            }
            case 'claimSolarTermsReward': {
                const { claimSolarTermsReward } = require('../services/activity');
                result = await claimSolarTermsReward(args[0]);
                break;
            }
            case 'claimQingmeiSeeds': {
                const { claimQingmeiSeeds } = require('../services/activity');
                result = await claimQingmeiSeeds();
                break;
            }
            case 'brewAndSellQingmeiWine': {
                const { brewAndSellQingmeiWine } = require('../services/activity');
                result = await brewAndSellQingmeiWine(args[0] || {});
                break;
            }
            case 'getQixiActivity': {
                const { getQixiActivity } = require('../services/activity');
                result = await getQixiActivity();
                break;
            }
            case 'buildQixiBridge': {
                const { buildQixiBridge } = require('../services/activity');
                result = await buildQixiBridge(args[0] || {});
                break;
            }
            case 'sendQixiSachet': {
                const { sendQixiSachet } = require('../services/activity');
                result = await sendQixiSachet(args[0], args[1]);
                break;
            }
            case 'useQixiDew': {
                const { useQixiDew } = require('../services/activity');
                result = await useQixiDew(args[0] || {});
                break;
            }
            case 'getRainPoemActivity': {
                const { getRainPoemActivity } = require('../services/activity');
                result = await getRainPoemActivity();
                break;
            }
            case 'buyRainPoemCollectionBottle': {
                const { buyRainPoemCollectionBottle } = require('../services/activity');
                result = await buyRainPoemCollectionBottle();
                break;
            }
            case 'collectRainPoemWeather': {
                const { collectRainPoemWeather } = require('../services/activity');
                result = await collectRainPoemWeather(args[0]);
                break;
            }
            case 'useRainPoemSummonBottle': {
                const { useRainPoemSummonBottle } = require('../services/activity');
                result = await useRainPoemSummonBottle();
                break;
            }
            case 'unlockRainPoemResearch': {
                const { unlockRainPoemResearch } = require('../services/activity');
                result = await unlockRainPoemResearch(args[0]);
                break;
            }
            case 'putRainPoemPrankOnFriend': {
                const { putRainPoemPrankOnFriend } = require('../services/rain-poem-prank-service');
                result = await putRainPoemPrankOnFriend(
                    toNum(args[0]),
                    toNum(args[1]),
                    args[2] != null ? toNum(args[2]) : 0
                );
                break;
            }
            case 'getPetDiaryActivity': {
                const { getPetDiaryActivity } = require('../services/activity');
                result = await getPetDiaryActivity();
                break;
            }
            case 'getPetDiary': {
                const { getPetDiary } = require('../services/activity');
                result = await getPetDiary();
                break;
            }
            case 'operatePetDiary': {
                const { operatePetDiary } = require('../services/activity');
                result = await operatePetDiary(args[0], args[1]);
                break;
            }
            case 'getWishSignActivity': {
                const { getWishSignActivity } = require('../services/activity');
                result = await getWishSignActivity();
                break;
            }
            case 'operateWishSign': {
                const { operateWishSign } = require('../services/activity');
                result = await operateWishSign(args[0], args[1]);
                break;
            }
            case 'getShareRewardActivity': {
                const { getShareRewardActivity } = require('../services/activity');
                result = await getShareRewardActivity();
                break;
            }
            case 'operateShareReward': {
                const { operateShareReward } = require('../services/activity');
                result = await operateShareReward(args[0]);
                break;
            }
            case 'getMilkTeaActivity': {
                const { getMilkTeaActivity } = require('../services/activity');
                result = await getMilkTeaActivity(args[0] || 'shop', args[1] || {});
                break;
            }
            case 'operateMilkTeaActivity': {
                const { operateMilkTeaActivity } = require('../services/activity');
                result = await operateMilkTeaActivity(args[0], args[1] || {});
                break;
            }
            case 'getPetDiaryRecords': {
                const { getPetDiaryRecords } = require('../services/activity');
                result = await getPetDiaryRecords(args[0]);
                break;
            }
            case 'getPetDiaryFriend': {
                const { getPetDiaryFriend } = require('../services/activity');
                result = await getPetDiaryFriend(args[0]);
                break;
            }
            case 'getIllustratedList': {
                const { getIllustratedListV2 } = require('../services/illustrated');
                result = await getIllustratedListV2(args[0], args[1]);
                break;
            }
            case 'claimIllustratedRewards': {
                const { claimAllRewardsV2 } = require('../services/illustrated');
                result = await claimAllRewardsV2(args[0]);
                break;
            }
            case 'getCareerInfo': {
                const { getCareerInfo } = require('../services/career');
                result = await getCareerInfo(args[0]);
                break;
            }
            case 'getDailyGiftOverview':
                result = await getDailyGiftOverview();
                break;
            case 'getSchedulers':
                result = getSchedulerRegistrySnapshot();
                break;
            case 'fertilizeLand': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    log('施肥', `正在对土地 ${  landId  } 使用有机肥料催熟`, {
                        module: 'farm', event: '催熟', landId
                    });
                    const fertilizeCount = await fertilize([landId], ORGANIC_FERTILIZER_ID);
                    if (fertilizeCount > 0) {
                        log('施肥', `土地 ${  landId  } 催熟成功`, {
                            module: 'farm', event: '催熟', result: 'ok', landId
                        });
                        result = { success: true, count: fertilizeCount };
                    } else {
                        log('施肥', `土地 ${  landId  } 催熟失败，可能有机肥料不足`, {
                            module: 'farm', event: '催熟', result: 'error', landId
                        });
                        result = { success: false, count: 0 };
                    }
                }
                break;
            }
            case 'removePlant': {
                const landId = Number(args[0]) || 0;
                if (!landId) {
                    error = '无效的土地ID';
                } else {
                    result = await removePlant([landId]);
                }
                break;
            }
            case 'removeAllPlants': {
                const landsDetail = await getLandsDetail();
                const lands = landsDetail?.lands || [];
                const occupiedLands = lands
                    .filter(l => l && l.unlocked && l.status !== 'empty' && l.status !== 'locked')
                    .map(l => l.id);

                if (occupiedLands.length === 0) {
                    result = { removed: 0, message: '没有可铲除的作物' };
                } else {
                    await removePlant(occupiedLands);
                    log('铲除', `已铲除 ${  occupiedLands.length  } 块土地上的作物`, {
                        module: 'farm', event: '一键铲除', result: 'ok', count: occupiedLands.length
                    });
                    result = { removed: occupiedLands.length };
                }
                break;
            }
            default:
                error = 'Unknown method';
        }
    } catch (err) {
        error = err.message;
    }

    if (isFriendSync) {
        friendSyncPaused = false;
        log('系统', '好友同步操作完成，已恢复自动化进程', {
            module: 'system', event: '好友同步恢复', method
        });
    }

    sendToMaster({
        type: 'api_response',
        id,
        result,
        error
    });
}

// ==================== 每日礼包总览 ====================

async function getDailyGiftOverview() {
    const auto = getAutomation() || {};

    const taskState = getTaskDailyStateLikeApp
        ? await getTaskDailyStateLikeApp()
        : getTaskClaimDailyState ? getTaskClaimDailyState() : { doneToday: false, lastClaimAt: 0 };

    const growthState = getGrowthTaskStateLikeApp
        ? await getGrowthTaskStateLikeApp()
        : { doneToday: false, completedCount: 0, totalCount: 0, tasks: [] };

    const emailState = getEmailDailyState
        ? getEmailDailyState()
        : { doneToday: false, lastCheckAt: 0 };

    const freeGiftState = getFreeGiftDailyState
        ? getFreeGiftDailyState()
        : { doneToday: false, lastClaimAt: 0 };

    const shareState = getShareDailyState
        ? getShareDailyState()
        : { doneToday: false, lastClaimAt: 0 };

    const vipState = getVipDailyState
        ? getVipDailyState()
        : { doneToday: false, lastClaimAt: 0 };

    const monthCardState = getMonthCardDailyState
        ? getMonthCardDailyState()
        : { doneToday: false, lastClaimAt: 0 };

    return {
        date: new Date().toISOString().slice(0, 10),
        growth: {
            key: 'growth_task',
            label: '成长任务',
            doneToday: !!growthState.doneToday,
            completedCount: Number(growthState.completedCount || 0),
            totalCount: Number(growthState.totalCount || 0),
            tasks: Array.isArray(growthState.tasks) ? growthState.tasks : []
        },
        gifts: [
            {
                key: 'task_claim',
                label: '每日任务',
                enabled: !!auto.task,
                doneToday: !!taskState.doneToday,
                lastAt: Number(taskState.lastClaimAt || 0),
                completedCount: Number(taskState.completedCount || 0),
                totalCount: Number(taskState.totalCount || 0)
            },
            {
                key: 'email_rewards',
                label: '邮箱奖励',
                enabled: true,
                doneToday: !!emailState.doneToday,
                lastAt: Number(emailState.lastCheckAt || 0)
            },
            {
                key: 'mall_free_gifts',
                label: '商城免费礼包',
                enabled: true,
                doneToday: !!freeGiftState.doneToday,
                lastAt: Number(freeGiftState.lastClaimAt || 0)
            },
            {
                key: 'daily_share',
                label: '分享礼包',
                enabled: true,
                doneToday: !!shareState.doneToday,
                lastAt: Number(shareState.lastClaimAt || 0)
            },
            {
                key: 'vip_daily_gift',
                label: '会员礼包',
                enabled: true,
                doneToday: !!vipState.doneToday,
                lastAt: Number(vipState.lastClaimAt || vipState.lastCheckAt || 0),
                // null（还没查过）→ undefined，让前端显示「等待执行」而不是误判成「未开通」
                hasGift: vipState.hasGift == null ? undefined : !!vipState.hasGift,
                canClaim: vipState.canClaim == null ? undefined : !!vipState.canClaim,
                result: vipState.result || ''
            },
            {
                key: 'month_card_gift',
                label: '月卡礼包',
                enabled: true,
                doneToday: !!monthCardState.doneToday,
                lastAt: Number(monthCardState.lastClaimAt || monthCardState.lastCheckAt || 0),
                hasCard: monthCardState.hasCard == null ? undefined : !!monthCardState.hasCard,
                hasClaimable: monthCardState.hasClaimable == null ? undefined : !!monthCardState.hasClaimable,
                result: monthCardState.result || ''
            }
        ]
    };
}

// ==================== 状态同步 ====================

function syncStatus() {
    if (!process.send && !parentPort) return;

    const userState = getUserState();
    const connected = !!(loginReady && isConnected());

    let levelProgress = null;
    const level = userState.level ?? statusData.level ?? 0;
    const exp = userState.exp ?? statusData.exp ?? 0;
    if (level > 0 && exp >= 0) {
        levelProgress = getLevelExpProgress(level, exp);
    }

    const limits = require('../services/friend').getOperationLimits();
    const stats = require('../services/stats').getStats(statusData, userState, connected, limits);

    const now = Date.now();
    const farmRemainSec = Math.max(0, Math.ceil((Number(nextFarmRunAt || 0) - now) / 1000));
    const helpRemainSec = Math.max(0, Math.ceil((Number(nextHelpRunAt || 0) - now) / 1000));
    const stealRemainSec = Math.max(0, Math.ceil((Number(nextStealRunAt || 0) - now) / 1000));

    stats.nextChecks = {
        farmRemainSec,
        helpRemainSec,
        stealRemainSec,
        friendRemainSec: Math.max(helpRemainSec, stealRemainSec)
    };
    stats.automation = getAutomation();
    stats.preferredSeed = getPreferredSeed();
    stats.levelProgress = levelProgress;
    stats.configRevision = appliedConfigRevision;

    const hash = JSON.stringify(stats);
    const now2 = Date.now();

    if (hash !== lastStatusHash || now2 - lastStatusSentAt > 30000) {
        lastStatusHash = hash;
        lastStatusSentAt = now2;
        sendToMaster({ type: 'status_sync', data: stats });
    }
}
