'use strict';

const { getAutomation, getIntervals, getFriendBlacklist, getFriendBadTargets } = require('../models/store');
const { requestError } = require('../utils/request-priority');
const { log, logWarn } = require('../utils/utils');
const { withGameScene, RANCH_SCENE_ID } = require('./scene-session');
const {
    loadSceneState,
    loadRanchDetail,
    mergeRanchDetails,
    planAction,
    executePreparedPlan,
    selectAutoCubPurchase,
    assertAutoCubPlan,
    findConflictingPendingOperation,
    attachAvailableResources,
} = require('./ranch-manual');
const { findRanchGoods, getRanchAnimalByCubItem, getRanchCan } = require('./ranch-config');
const { clearRanchReadCache } = require('./ranch-readonly');
const { ranchOperations } = require('./ranch-operations-ledger');
const ranchFriends = require('./ranch-friends');
const { inFriendQuietHours, SYSTEM_NPC_GIDS } = require('./friend-api');
const { getCanGetHelpExp } = require('./friend-operation-limits');

const PATROL_SLICE_MS = 5000;
const SCENE_REENTRY_MS = 20000;
const SAFETY_BACKOFF_MS = 10 * 60 * 1000;
const FRIEND_AUTOMATION_KEYS = [
    'ranch_friend_steal', 'ranch_friend_clean', 'ranch_friend_stroke', 'ranch_friend_mosquito',
];
const FRIEND_ACTION_KEYS = {
    steal: 'ranch_friend_steal',
    cleanFriend: 'ranch_friend_clean',
    stroke: 'ranch_friend_stroke',
    putMosquito: 'ranch_friend_mosquito',
};
const SELF_AUTOMATION_KEYS = [
    'ranch_harvest', 'ranch_produce', 'ranch_clean', 'ranch_sell',
    'ranch_grass', 'ranch_feed_normal',
    'ranch_feed_organic', 'ranch_fill_cans', 'ranch_complete_upgrade', 'ranch_place', 'ranch_cub_buy',
    'ranch_daily_tasks_claim', 'ranch_growth_tasks_claim', 'ranch_daily_share_claim', 'ranch_activity_claim',
];
const AUTOMATION_KEYS = [...SELF_AUTOMATION_KEYS, ...FRIEND_AUTOMATION_KEYS];
const SKIPPABLE_CODES = new Set([
    'RANCH_BUCKET_EMPTY', 'INSUFFICIENT_BALANCE', 'RESERVE_PROTECTED',
    'GOODS_UNAVAILABLE', 'PURCHASE_LIMIT_EXCEEDED',
    'RANCH_CONFIG_UNKNOWN', 'RANCH_UPGRADE_PENDING', 'RANCH_FACILITY_NOT_FOUND',
]);

let nextCheckAt = 0;
let running = false;
let lastStartedAt = 0;
let lastFinishedAt = 0;
let lastResult = 'idle';
let lastError = '';
let lastYieldReason = '';
let continuation = null;
let protectedUntil = 0;
let idleLogEmitted = false;
let pendingPauseLogged = false;
let remoteBusyLoggedAt = 0;
let shareBasicInfoRetryAfter = 0;
let shareBasicInfoBusyFailures = 0;
const SHARE_BASIC_INFO_RETRY_MS = [20_000, 60_000, 180_000, SAFETY_BACKOFF_MS];

function friendEnabled(action, auto) {
    return enabled(FRIEND_ACTION_KEYS[action], auto) && !ranchFriends.getInteractionQuotaResetAt(action);
}

function friendPolicy(accountId, auto = getAutomation(accountId)) {
    const blacklist = new Set(getFriendBlacklist(accountId).map(Number));
    const stealOnly = new Set((auto.friend_steal_only_gids || []).map(Number));
    const badTargets = new Set(getFriendBadTargets(accountId).map(Number));
    return {
        allowsVisit: gid => Number.isSafeInteger(gid) && gid > 0 && !blacklist.has(gid)
            && !SYSTEM_NPC_GIDS.has(gid) && !inFriendQuietHours(gid),
        allowsAction: (action, gid) => friendEnabled(action, auto)
            && (action !== 'cleanFriend' || auto.ranch_friend_clean_exp_limit === false || getCanGetHelpExp())
            && (action !== 'steal' || !stealOnly.size || stealOnly.has(gid))
            && (action !== 'putMosquito' || !badTargets.size || badTargets.has(gid)),
    };
}

function automationError(message, errorCode) {
    return requestError(message, { errorCode, stage: 'ranch_automation', sent: false, resultState: 'not_sent' });
}

function enabled(key, snapshot = getAutomation()) {
    return snapshot.ranch === true && snapshot[key] === true;
}

function farmIntervalRange(accountId = process.env.FARM_ACCOUNT_ID || '') {
    const intervals = getIntervals(accountId);
    const fallback = Math.max(2, Number.parseInt(intervals.farm, 10) || 2);
    const min = Math.max(1, Number.parseInt(intervals.farmMin, 10) || fallback);
    const max = Math.max(1, Number.parseInt(intervals.farmMax, 10) || fallback);
    return { farmMin: Math.min(min, max), farmMax: Math.max(min, max) };
}

function normalIntervalMs() {
    const { farmMin, farmMax } = farmIntervalRange();
    const min = farmMin * 1000;
    const max = farmMax * 1000;
    return min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
}

function scheduleProtected(delayMs) {
    protectedUntil = Date.now() + delayMs;
    nextCheckAt = protectedUntil;
}

function scheduleSafetyBackoff() {
    scheduleProtected(Math.max(SAFETY_BACKOFF_MS, farmIntervalRange().farmMax * 1000) + accountPhaseMs());
}

function accountPhaseMs(accountId = process.env.FARM_ACCOUNT_ID || '') {
    let hash = 2166136261;
    for (const char of String(accountId)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0) % 5000;
}

function hasWork(auto = getAutomation()) {
    return auto.ranch === true && (SELF_AUTOMATION_KEYS.some(key => auto[key] === true)
        || Object.keys(FRIEND_ACTION_KEYS).some(action => friendEnabled(action, auto)));
}

function getRoutineState() {
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    const auto = getAutomation(accountId);
    const { farmMin, farmMax } = farmIntervalRange(accountId);
    const quotaResetAt = Math.min(...Object.keys(FRIEND_ACTION_KEYS).filter(action => enabled(FRIEND_ACTION_KEYS[action], auto))
        .map(action => ranchFriends.getInteractionQuotaResetAt(action)).filter(at => at > Date.now()), Infinity);
    return {
        enabled: hasWork(auto),
        running,
        nextCheckAt,
        lastStartedAt,
        lastFinishedAt,
        lastResult,
        lastError,
        lastYieldReason,
        // 保留旧诊断字段，以分钟表示正常周期的下界；范围以秒为准。
        checkMinutes: farmMin / 60,
        farmMin,
        farmMax,
        quotaResetAt: Number.isFinite(quotaResetAt) ? quotaResetAt : null,
    };
}

function pauseForPending(actions, message) {
    continuation = null;
    scheduleSafetyBackoff();
    lastResult = 'unknown';
    lastError = message;
    if (!pendingPauseLogged) {
        pendingPauseLogged = true;
        idleLogEmitted = false;
        logWarn('牧场', `自动巡查已暂停：${message}`, {
            module: 'ranch', event: 'ranch_patrol_paused', result: 'unknown', reason: 'pending_confirmation',
        });
    }
    return { actions, skipped: true, reason: 'pending_confirmation', nextCheckAt };
}

async function run(options = {}) {
    const accountId = String(process.env.FARM_ACCOUNT_ID || '');
    const auto = getAutomation(accountId);
    const now = Date.now();
    if (running || !hasWork(auto) || now < nextCheckAt) return { actions: 0, skipped: true };
    lastStartedAt = now;
    lastFinishedAt = 0;
    lastError = '';
    lastYieldReason = '';
    if (typeof options.farmDeadline === 'function' && options.farmDeadline() <= now) {
        scheduleProtected(SCENE_REENTRY_MS);
        lastResult = 'yielded';
        lastYieldReason = 'farm_deadline';
        lastFinishedAt = Date.now();
        return { actions: 0, yielded: true };
    }

    running = true;
    protectedUntil = 0;
    lastResult = 'running';
    let actions = 0;
    let changed = false;
    let yieldReason = '';
    try {
        // A pending action blocks only its target or conflicting resources.
        // Unrelated automation may continue without clearing/replaying unknown.
        pendingPauseLogged = false;
        const signature = JSON.stringify([accountId, ...AUTOMATION_KEYS.map(key => enabled(key, auto)), enabled('ranch_grass_buy', auto)]);
        if (!continuation || continuation.signature !== signature) continuation = {
            signature, scope: null, done: new Set(), skipped: new Map(), friend: null, friendProgress: {}, normalFed: false,
            hadActions: false, cubBought: 0, cubPurchaseDone: false, upgradeStarted: false,
        };
        const cycle = continuation;
        await withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
            const scope = JSON.stringify([session.accountId, session.gid, session.workerInstanceId, session.connectionEpoch,
                session.remoteGeneration, session.remoteGenerationSource]);
            if (cycle.scope && cycle.scope !== scope) {
                cycle.done.clear(); cycle.skipped.clear(); cycle.friend = null; cycle.friendProgress = {}; cycle.normalFed = false; cycle.roster = null; cycle.upgradeStarted = false;
            }
            cycle.scope = scope;
            const [base, detail] = await Promise.all([loadSceneState(session), loadRanchDetail(session)]);
            let raw = mergeRanchDetails({ ...base, session, sessionAccountId: accountId }, detail);
            let inventoryDirty = false;
            let steps = 0;
            const patrolStartedAt = Date.now();
            const shouldYield = (acted = false) => {
                const at = Date.now();
                // 强读完成后给首个动作至多5秒准备/发送窗口，避免短农场周期只报价而永远零进展。
                if (steps === 0 && !acted && actions === 0) {
                    if (at < patrolStartedAt + PATROL_SLICE_MS) return false;
                    throw automationError('牧场首个动作准备超过5秒，未发送并停止本轮，避免重复报价空转',
                        'RANCH_AUTOMATION_FIRST_ACTION_TIMEOUT');
                }
                if (at >= (typeof options.farmDeadline === 'function' ? options.farmDeadline() : Infinity)) {
                    yieldReason = 'farm_deadline';
                    return true;
                }
                if (at >= patrolStartedAt + PATROL_SLICE_MS) {
                    yieldReason = 'patrol_slice';
                    return true;
                }
                return false;
            };
        const checkpoint = () => {
            if (shouldYield()) throw automationError('牧场巡查让路农场', 'RANCH_AUTOMATION_YIELD');
        };
            const currentEnabled = keyOrKeys => {
                const latest = getAutomation(accountId);
                const check = key => enabled(key, latest)
                    && (key !== 'ranch_grass_buy' || enabled('ranch_grass', latest))
                    && (key !== 'ranch_cub_buy' || enabled('ranch_place', latest));
                return Array.isArray(keyOrKeys) ? keyOrKeys.length > 0 && keyOrKeys.every(check) : check(keyOrKeys);
            };
            const assertCanSend = key => {
                if (!currentEnabled(key)) throw automationError('牧场总开关或关联动作开关已关闭，本次未发送',
                    'RANCH_AUTOMATION_DISABLED');
                // 只复查开关/发送时刻，不检查全局pending：spend已建立本次写的安全记录。
                if (shouldYield()) throw automationError('牧场巡查在发送前让路农场', 'RANCH_AUTOMATION_YIELD');
            };

            const stepKey = (key, action, input) => `${key}:${action}:${JSON.stringify(input)}`;
            async function act(key, action, input = {}) {
                const step = stepKey(key, action, input);
                if (cycle.done.has(step)) return { did: false, error: cycle.skipped.get(step) };
                if (!currentEnabled(key)) { cycle.done.add(step); return { did: false }; }
                checkpoint();
                let plan;
                try {
                    plan = attachAvailableResources(await planAction(action, input, raw), raw);
                }
                catch (error) {
                    if (error?.resultState === 'unknown' || error?.outcomeUnknown === true) throw error;
                    if (SKIPPABLE_CODES.has(error?.errorCode)) {
                        // Preserve the not-sent result across slices. Replanning
                        // the same shortage must not consume every next slice.
                        cycle.done.add(step);
                        cycle.skipped.set(step, error);
                        steps++;
                        return { did: false, error };
                    }
                    throw error;
                }
                if (!plan.count) { cycle.done.add(step); steps++; return { did: false }; }
                const conflict = findConflictingPendingOperation(accountId, action, input, plan);
                if (conflict) {
                    cycle.done.add(step);
                    cycle.skipped.set(step, conflict);
                    steps++;
                    logWarn('牧场', `${plan.label || '操作'}已跳过：${conflict.label || '相关操作'}结果未确认`, {
                        module: 'ranch', event: 'ranch_target_paused', result: 'unknown', reason: 'pending_target',
                    });
                    return { did: false, skipped: true, reason: 'pending_target' };
                }
                if (key === 'ranch_cub_buy') assertAutoCubPlan(plan, raw, 3 - cycle.cubBought);
                const assertNoConflict = () => {
                    const lateConflict = findConflictingPendingOperation(accountId, action, input, plan);
                    if (lateConflict) throw automationError(`${lateConflict.label || '操作'}结果未确认，本次未发送`, 'RANCH_AUTOMATION_PENDING');
                };
                assertCanSend(key);
                assertNoConflict();
                checkpoint();
                const executed = await executePreparedPlan(accountId, action, input, plan, raw, session, {
                    // The ledger has already created this write's pending record
                    // at this point; rechecking pending here would collide with
                    // our own in-flight target. spend() rechecks conflicts atomically.
                    assertCanSend: () => assertCanSend(key),
                });
                raw = executed.raw;
                cycle.done.add(step);
                steps++;
                if (key === 'ranch_feed_normal') cycle.normalFed = true;
                if (key === 'ranch_cub_buy') cycle.cubBought += input.count;
                actions++;
                changed = true;
                cycle.hadActions = true;
                idleLogEmitted = false;
                log('牧场', `${plan.label}完成`, {
                    module: 'ranch', event: `ranch_${action}`, result: 'ok',
                    completed: executed.result.completed,
                });
                return { did: true, result: executed.result };
            }

            // Feeding is time-sensitive: evaluate it before lower-priority cleanup, harvest,
            // upgrade and shop actions so a short patrol slice cannot starve eligible animals.
            // Ordinary cans take precedence; organic cans are only attempted if no ordinary feed succeeded.
            await act('ranch_feed_normal', 'feed', { all: true, bucketType: 2 });
            if (!cycle.normalFed) await act('ranch_feed_organic', 'feed', { all: true, bucketType: 1 });

            if ((await act('ranch_harvest', 'harvest', { all: true })).did) inventoryDirty = true;
            if ((await act('ranch_produce', 'produce', { all: true })).did) inventoryDirty = true;
            if ((await act('ranch_clean', 'clean')).did) inventoryDirty = true;

            if (currentEnabled('ranch_sell')) {
                // 收获/催产/清理奖励需要带show.sells的scene2背包结构；每周期最多精确reconcile一次。
                if (inventoryDirty) raw = { ...await loadSceneState(session), session, sessionAccountId: accountId,
                    serverIntervalSec: raw.serverIntervalSec };
                await act('ranch_sell', 'sell', { all: true });
            }

            if (currentEnabled('ranch_complete_upgrade')) {
                const facilities = [...(raw.cells?.facilities || [])]
                    .filter(facility => facility.state === 1 && [6, 7, 8].includes(Number(facility.module_type)))
                    .sort((a, b) => Number(a.instance_id) - Number(b.instance_id));
                const upgradeEndMs = facility => {
                    const value = Number(facility.upgrade_end_time);
                    return value > 0 && value < 100000000000 ? value * 1000 : value;
                };
                const upgradeInProgress = facilities.some(facility => Number(facility.upgrade_state) !== 0
                    || upgradeEndMs(facility) > Date.now());
                // Finish only server-confirmed or elapsed upgrades. Include level in the
                // local step identity so a later facility level is not suppressed by a
                // previous completed step for the same instance.
                for (const facility of facilities) {
                    const state = Number(facility.upgrade_state);
                    const end = upgradeEndMs(facility);
                    if (state === 2 || state > 0 && end > 0 && end <= Date.now()) {
                        await act('ranch_complete_upgrade', 'completeUpgrade', {
                            facilityId: Number(facility.instance_id), facilityLevel: Number(facility.level),
                        });
                    }
                }
                // The existing switch owns both phases: start a verified next-level
                // upgrade when nothing is already running, then complete it on a later
                // patrol. One new construction per patrol avoids parallel spending.
                if (!upgradeInProgress && !cycle.upgradeStarted) {
                    for (const facility of facilities) {
                        if (Number(facility.upgrade_state) !== 0 || upgradeEndMs(facility) > Date.now()) continue;
                        const started = await act('ranch_complete_upgrade', 'upgrade', {
                            facilityId: Number(facility.instance_id), facilityLevel: Number(facility.level),
                        });
                        if (started.did) { cycle.upgradeStarted = true; break; }
                    }
                }
            }

            if (currentEnabled('ranch_grass')) {
                for (const facility of raw.cells?.facilities || []) {
                    if (!facility.feed_machine) continue;
                    const input = { facilityId: Number(facility.instance_id) };
                    let outcome = await act('ranch_grass', 'addGrass', input);
                    if (!outcome.did && outcome.error?.errorCode === 'INSUFFICIENT_BALANCE'
                        && currentEnabled('ranch_grass_buy')) {
                        const goods = findRanchGoods(6, 7001);
                        if (goods) {
                            const bought = await act('ranch_grass_buy', 'buy', {
                                shopId: 6, goodsId: Number(goods.id), count: 1, autoPlace: false,
                            });
                            if (bought.did) {
                                // Only a confirmed purchase invalidates the prior
                                // shortage; if we yield, the next slice retries grass.
                                const grassStep = stepKey('ranch_grass', 'addGrass', input);
                                cycle.done.delete(grassStep);
                                cycle.skipped.delete(grassStep);
                                outcome = await act('ranch_grass', 'addGrass', input);
                            }
                        }
                    }
                }
            }

            // Stock-only ordinary cub placement is explicit and default-off.
            // Never purchases cubs, consumes giant cubs, activates a pen or guesses
            // an animal's husbandry type. The existing planner/ledger verifies all
            // inventory and newly placed animals for each bounded write.
            if (currentEnabled('ranch_place')) {
                const itemIds = [...new Set((raw.bag?.physical_items || []).map(item => Number(item.id)))]
                    .filter(Number.isSafeInteger).sort((a, b) => a - b);
                for (const itemId of itemIds) {
                    const animal = getRanchAnimalByCubItem(itemId);
                    if (!animal || animal.enable_flag !== true || Number(animal.giantCubItemId) > 0) continue;
                    const kind = animal.husbandry_type === '窝' ? 1 : animal.husbandry_type === '棚' ? 2 : 0;
                    if (!kind) continue;
                    for (const facility of raw.cells?.facilities || []) {
                        const ranch = facility.ranch;
                        if (facility.state !== 1 || Number(facility.upgrade_state) !== 0 || !ranch
                            || Number(ranch.husbandry_type) !== kind) continue;
                        const room = Number(ranch.capacity) - Math.max(Number(ranch.animal_count) || 0, (ranch.animals || []).length);
                        const owned = (raw.bag?.physical_items || []).filter(item => Number(item.id) === itemId && item.is_locked !== true)
                            .reduce((sum, item) => sum + BigInt(item.count?.toString() || '0'), 0n);
                        const reserved = ranchOperations.reserved(accountId, `item:${itemId}`);
                        const available = owned > reserved ? owned - reserved : 0n;
                        const count = Math.min(999, room, Number(available > 999n ? 999n : available));
                        if (count > 0) await act('ranch_place', 'place', { itemId, ranchId: Number(ranch.ranch_inst_id), count });
                    }
                }
            }

            if (currentEnabled('ranch_cub_buy') && !cycle.cubPurchaseDone) {
                checkpoint();
                const input = await selectAutoCubPurchase(raw, 3 - cycle.cubBought);
                if (input) await act('ranch_cub_buy', 'buy', input);
                cycle.cubPurchaseDone = true;
            }

            if (currentEnabled('ranch_fill_cans')) {
                const bucketBalance = bucketId => (raw.bag?.virtual_items || [])
                    .filter(item => String(item.id) === String(bucketId))
                    .reduce((sum, item) => sum + BigInt(item.count?.toString() || '0'), 0n);
                const candidates = (raw.bag?.physical_items || []).map(item => {
                    const itemId = Number(item.id);
                    const uid = item.uid?.toString?.() ?? String(item.uid ?? '');
                    const count = item.count?.toString?.() ?? String(item.count ?? '0');
                    const can = getRanchCan(itemId);
                    return { itemId, uid, count, can, locked: item.is_locked === true };
                }).filter(item => !item.locked && item.can?.bucketId && Number.isSafeInteger(item.itemId)
                    && /^[1-9]\d*$/.test(item.uid) && /^\d+$/.test(item.count) && BigInt(item.count) > 0n
                    && Number.isSafeInteger(Number(item.can.speed_up_secs)) && Number(item.can.speed_up_secs) > 0)
                    .sort((a, b) => Number(a.can.bucketId) - Number(b.can.bucketId)
                        || Number(a.can.speed_up_secs) - Number(b.can.speed_up_secs)
                        || a.itemId - b.itemId || (BigInt(a.uid) < BigInt(b.uid) ? -1 : 1));
                const filledBuckets = new Set();
                for (const item of candidates) {
                    const bucketId = Number(item.can.bucketId);
                    // Bucket capacity is not present in verified config. Fill only
                    // an empty bucket and at most one smallest can per bucket/patrol.
                    if (filledBuckets.has(bucketId) || bucketBalance(bucketId) > 0n) continue;
                    const owned = BigInt(item.count);
                    const reserved = ranchOperations.reserved(accountId, `item:${item.itemId}`);
                    if (owned <= reserved) continue;
                    const result = await act('ranch_fill_cans', 'useCan', { uid: item.uid, count: 1 });
                    if (result.did) filledBuckets.add(bucketId);
                }
            }

            if (currentEnabled('ranch_daily_tasks_claim') || currentEnabled('ranch_growth_tasks_claim')) {
                const progression = require('./ranch-progression');
                const taskState = await progression.loadProgressActionState(session, 'tasks', sceneReply);
                raw = { ...raw, ...taskState };
                const claimableTasks = taskState.tasksView.tasks.filter(task => task.canClaim
                    && (task.category === 'daily' && currentEnabled('ranch_daily_tasks_claim')
                        || task.category === 'growth' && currentEnabled('ranch_growth_tasks_claim')));
                if (claimableTasks.length) {
                    const taskKeys = [...new Set(claimableTasks.map(task => task.category === 'daily'
                        ? 'ranch_daily_tasks_claim' : 'ranch_growth_tasks_claim'))];
                    const result = await act(taskKeys, 'claimTasks', {
                        taskIds: claimableTasks.map(task => task.id), double: false,
                    });
                    if (result.did) inventoryDirty = true;
                }
            }

            if (currentEnabled('ranch_daily_share_claim') && Date.now() >= shareBasicInfoRetryAfter) {
                const progression = require('./ranch-progression');
                let shareState;
                try {
                    shareState = await progression.loadProgressActionState(session, 'share', sceneReply);
                    shareBasicInfoRetryAfter = 0;
                    shareBasicInfoBusyFailures = 0;
                }
                catch (error) {
                    if (Number(error?.errorCode) !== 1020001 || !/BatchGetBasicInfo/.test(String(error?.message || ''))) throw error;
                    // Fair, bounded exponential backoff: preserve all patrol time
                    // for actionable care, but keep a scheduled retry for this
                    // optional read. Consecutive busy errors wait 20s, 60s, 3m,
                    // then cap at 10m; successful reads reset the sequence.
                    const retryMs = SHARE_BASIC_INFO_RETRY_MS[Math.min(shareBasicInfoBusyFailures, SHARE_BASIC_INFO_RETRY_MS.length - 1)];
                    shareBasicInfoBusyFailures++;
                    const delayMs = retryMs + accountPhaseMs(accountId);
                    shareBasicInfoRetryAfter = Date.now() + delayMs;
                    lastError = '分享奖励状态接口繁忙，已安排重试';
                    if (Date.now() - remoteBusyLoggedAt >= 60000) {
                        remoteBusyLoggedAt = Date.now();
                        logWarn('牧场', `${lastError}（${Math.ceil(delayMs / 1000)}秒后重试）`, {
                            module: 'ranch', event: 'ranch_share_read_paused', result: 'yielded', reason: 'remote_busy', errorCode: 1020001,
                            retryAt: shareBasicInfoRetryAfter, consecutiveFailures: shareBasicInfoBusyFailures,
                        });
                    }
                }
                if (shareState) {
                    raw = { ...raw, ...shareState };
                    if (shareState.shareView?.canReport === true) {
                        // This game RPC updates the ranch reward marker only; it
                        // does not open a social sheet or message any friend.
                        // Report only when CheckCanShare explicitly allows it, then
                        // require the verified share-count increment before claiming.
                        await act('ranch_daily_share_claim', 'reportDailyShare', { sharedInGame: true, automatic: true });
                    }
                    if (raw.shareView?.canClaim === true) {
                        await act('ranch_daily_share_claim', 'claimDailyShare', {});
                    }
                }
            }

            if (currentEnabled('ranch_activity_claim')) {
                const muge = require('./ranch-muge');
                let activity = await muge.getRanchMugeActivityInSession(session, sceneReply);
                const claimActions = [
                    ['claimCelebration', () => activity.celebration?.tiers?.some(tier => tier.status === 2)],
                    ['claimFriends', () => activity.friends?.tiers?.some(tier => tier.status === 2)],
                    ['claimTask', () => activity.handbook?.tasks?.some(task => task.status === 2)],
                    ['claimHandbook', () => activity.handbook?.tiers?.some(tier => tier.status === 2)],
                ];
                for (const [action, available] of claimActions) {
                    const step = stepKey('ranch_activity_claim', action, {});
                    if (cycle.done.has(step) || !available()) continue;
                    const pendingMuge = ranchOperations.pending(accountId).find(row => row.target.startsWith('muge:2026111700:'));
                    if (pendingMuge) {
                        cycle.done.add(step);
                        cycle.skipped.set(step, pendingMuge);
                        steps++;
                        logWarn('活动', `牧歌初启已跳过：${pendingMuge.label || '活动领奖'}结果未确认`, {
                            module: 'ranch', event: 'ranch_target_paused', result: 'unknown', reason: 'pending_activity',
                        });
                        continue;
                    }
                    checkpoint();
                    if (!currentEnabled('ranch_activity_claim')) break;
                    const result = await muge.operateRanchMugeActivityInSession(session, sceneReply, action, {});
                    activity = result.activity;
                    cycle.done.add(step);
                    steps++;
                    actions++;
                    changed = true;
                    cycle.hadActions = true;
                    idleLogEmitted = false;
                    log('活动', `牧歌初启自动领取完成：${action}`, {
                        module: 'activity', event: `ranch_muge_${action}`, result: 'ok', count: result.rewards.length,
                    });
                }
            }

            const friendActions = Object.keys(FRIEND_ACTION_KEYS);
            const friendAuto = getAutomation(accountId);
            if (friendActions.some(action => friendEnabled(action, friendAuto))) {
                checkpoint();
                if (cycle.roster && Date.now() - cycle.roster.observedAt > 300000) cycle.roster = null;
                const roster = cycle.roster || await ranchFriends.loadRanchFriendRoster(session, completed => {
                    if (completed) steps++;
                    checkpoint();
                });
                cycle.roster = roster;
                // 名单只过滤场景二确认过的好友；每个动作独立判断准入。
                const policy = friendPolicy(accountId);
                const friendCandidates = roster.friends.filter(friend => {
                    const gid = Number(friend?.gid);
                    return policy.allowsVisit(gid) && friendActions.some(action => policy.allowsAction(action, gid));
                });
                const friend = cycle.friend
                    ? friendCandidates.find(row => Number(row.gid) === Number(cycle.friend.gid)
                        && friendActions.some(action => !cycle.friendProgress[action] && policy.allowsAction(action, Number(row.gid))))
                    : ranchFriends.nextAutomationFriend(friendCandidates);
                if (friend) {
                    cycle.friend = friend;
                    const gid = Number(friend.gid);
                    const actionEnabled = action => {
                        const latest = friendPolicy(accountId);
                        return latest.allowsVisit(gid) && latest.allowsAction(action, gid);
                    };
                    const friendResult = await ranchFriends.automateRanchFriend(session, accountId, friend,
                        actionEnabled, shouldYield, cycle.friendProgress, (result, nickname) => {
                            // Record each confirmed write before any later read/Leave
                            // can fail; logging never decides whether a write is safe.
                            actions++; changed = true;
                            cycle.hadActions = true;
                            idleLogEmitted = false;
                            log('牧场', `${nickname || friend.name || `GID:${friend.gid}`}：${result.label}完成`, {
                                module: 'ranch', event: `ranch_friend_${result.action}`, result: 'ok',
                                friendGid: friend.gid, completed: result.completed,
                            });
                        });
                    if (friendResult.yielded) throw automationError('牧场好友巡查让路农场', 'RANCH_AUTOMATION_YIELD');
                }
            }

        }, { priority: 'background', timeoutMs: 155000 });
        continuation = null;
        resetSchedule();
        lastResult = actions ? 'confirmed' : 'idle';
        const finishedAt = Date.now();
        if (!cycle.hadActions && !idleLogEmitted) {
            idleLogEmitted = true;
            log('牧场', '自动巡查完成：无待执行动作', {
                module: 'ranch', event: 'ranch_patrol_complete', result: 'idle',
            });
        }
        return { actions, nextCheckAt };
    }
    catch (error) {
        // Any remaining read-only BasicInfo path follows a long circuit-breaker
        // window; retrying every scene re-entry was producing repeated busy RPCs.
        if (Number(error?.errorCode) === 1020001 && /BatchGetBasicInfo/.test(String(error?.message || ''))) {
            scheduleProtected(10 * 60 * 1000);
            lastResult = 'yielded';
            lastYieldReason = 'remote_busy';
            lastError = '好友资料接口繁忙，暂缓相关读取';
            if (Date.now() - remoteBusyLoggedAt >= 60000) {
                remoteBusyLoggedAt = Date.now();
                logWarn('牧场', `${lastError}（10分钟内不重复读取）`, {
                    module: 'ranch', event: 'ranch_patrol_paused', result: 'yielded', reason: 'remote_busy', errorCode: 1020001,
                });
            }
            return { actions, yielded: true, reason: 'remote_busy', nextCheckAt };
        }
        if (error?.errorCode === 'RANCH_AUTOMATION_PENDING') {
            return pauseForPending(actions, String(error.message));
        }
        if (error?.errorCode === 'RANCH_AUTOMATION_YIELD') {
            scheduleProtected(SCENE_REENTRY_MS);
            lastResult = 'yielded';
            lastYieldReason = yieldReason || 'friend_unfinished';
            return { actions, yielded: true, nextCheckAt };
        }
        continuation = null;
        idleLogEmitted = false;
        const definitelyBusy = error?.errorCode === 'ACCOUNT_OPERATION_BUSY' && error.sent === false
            && error.resultState === 'not_sent' && error.outcomeUnknown !== true
            && error.holdUntilTransportEpochChanged !== true && actions === 0
            && ranchOperations.pending(accountId).length === 0;
        if (definitelyBusy) scheduleProtected(Math.min(5000, Math.max(1000, Number(error.retryAfterMs) || 1000)));
        else scheduleSafetyBackoff();
        lastResult = error?.resultState === 'unknown' || error?.outcomeUnknown === true ? 'unknown' : 'error';
        lastError = String(error?.message || error).slice(0, 300);
        logWarn('牧场', `自动巡查停止：${lastError}`, {
            module: 'ranch', event: 'ranch_automation', result: lastResult,
            errorCode: error?.errorCode || error?.code,
        });
        throw error;
    }
    finally {
        running = false;
        lastFinishedAt = Date.now();
        // A read-only yield must retain verified roster batches. Writes and
        // failures still invalidate snapshots; external notifications maintain
        // their own revision invalidation independently.
        if (changed || lastResult === 'unknown' || lastResult === 'error') {
            clearRanchReadCache();
            ranchFriends.clearRanchFriendCache();
        }
    }
}

function resetSchedule(delayMs = normalIntervalMs()) {
    // 正常巡查没有额外错峰或 20 秒下限；配置重载不得提前解除让路或安全退避。
    nextCheckAt = Math.max(protectedUntil, Date.now() + Math.max(0, Number(delayMs) || 0));
    return nextCheckAt;
}

module.exports = {
    run,
    getRoutineState,
    resetSchedule,
    normalIntervalMs,
    accountPhaseMs,
    AUTOMATION_KEYS,
};
