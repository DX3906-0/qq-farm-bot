'use strict';

const network = require('../utils/network');
const protobuf = require('protobufjs');
const { types } = require('../utils/proto');
const { requestError } = require('../utils/request-priority');
const { validateOperationSession } = require('./account-operation-coordinator');
const { withGameScene, getSceneSessionSnapshot, RANCH_SCENE_ID } = require('./scene-session');
const { getRanchFriendSessionSnapshot } = require('./ranch-friend-session');
const { createSceneReadCache } = require('./ranch-readonly');
const { sceneRpc } = require('./ranch-manual');
const { getRanchItem, getRanchAnimal, getRanchGiantProduct, getRanchTask, getRanchWeightTier, getRanchMutationRules, getRanchImage, SOURCE_COMMIT } = require('./ranch-config');

const BOOK_TYPE = 101;
// Pinned ranch/daily-share.ts: distinct from farm share 1 and task-double share 103.
const SHARE_ID = '102';
const SHARE_DOC_ID = '2101';
const SHARE_REWARDS = [{ id: '80021', count: '5' }];
const PROGRESSION_ACTIONS = new Set(['claimTasks', 'claimIllustrated', 'claimWeight', 'reportDailyShare', 'claimDailyShare']);
const viewCache = createSceneReadCache(3000);
const READ_ROUTES = {
    tasks: ['gamepb.taskpb.TaskService', 'TaskInfo', 'RanchTaskInfoRequest', 'RanchTaskInfoReply'],
    book: ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedListV2', 'RanchGetIllustratedListV2Request', 'RanchGetIllustratedListV2Reply'],
    levels: ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedLevelListV2', 'RanchGetIllustratedLevelListV2Request', 'RanchGetIllustratedLevelListV2Reply'],
    weight: ['gamepb.illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', 'RanchGetRanchWeightScoreV2Request', 'RanchGetRanchWeightScoreV2Reply'],
    basic: ['gamepb.userpb.UserService', 'BatchGetBasicInfo', 'RanchBatchGetBasicInfoRequest', 'RanchBatchGetBasicInfoReply'],
    checkShare: ['gamepb.sharepb.ShareService', 'CheckCanShare', 'CheckCanShareRequest', 'CheckCanShareReply'],
};

function fail(message, code = 'RANCH_RESPONSE_MISMATCH', unknown = false) {
    throw requestError(message, { errorCode: code, stage: 'ranch_progression', sent: unknown,
        resultState: unknown ? 'unknown' : 'failed', outcomeUnknown: unknown });
}
function numberText(value, label = '数量') {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(`${label}超出精确整数范围`);
    const text = value?.toString?.() ?? String(value ?? '0');
    if (!/^\d+$/.test(text) || BigInt(text) > 9223372036854775807n) fail(`${label}无效`);
    return BigInt(text).toString();
}
function small(value, label = '整数') {
    const result = Number(numberText(value, label));
    if (!Number.isSafeInteger(result)) fail(`${label}超出范围`);
    return result;
}
function positive(value, label) {
    const result = numberText(value, label);
    if (result === '0') fail(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    return result;
}
function rewards(items, unknown = false) {
    if (!Array.isArray(items)) fail('奖励列表缺失', 'RANCH_RESPONSE_MISMATCH', unknown);
    const totals = new Map();
    for (const item of items) {
        let id, count;
        try { id = positive(item?.id, '奖励物品'); count = positive(item?.count, '奖励数量'); }
        catch (error) { fail(error.message, 'RANCH_RESPONSE_MISMATCH', unknown); }
        const next = (totals.get(id) || 0n) + BigInt(count);
        if (next > 9223372036854775807n) fail('奖励总量超出范围', 'RANCH_RESPONSE_MISMATCH', unknown);
        totals.set(id, next);
    }
    return [...totals].sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : 1)
        .map(([id, count]) => ({ id, count: count.toString(), name: getRanchItem(id)?.name || `物品 #${id}`, image: getRanchImage(id)?.url || '' }));
}
function rewardSignature(items, unknown = false) {
    return JSON.stringify(rewards(items, unknown).map(item => [item.id, item.count]));
}
function sameIds(actual, expected) {
    if (!Array.isArray(actual) || new Set(actual.map(String)).size !== actual.length) return false;
    return JSON.stringify(actual.map(String).sort()) === JSON.stringify(expected.map(String).sort());
}
function clock(session, sceneReply) {
    if (sceneReply) {
        const value = small(sceneReply.server_time, '服务端时间');
        if (!value) fail('缺少服务端时间，不能确认每日领取周期');
        session.ranchProgressClock = { serverMs: value < 100000000000 ? value * 1000 : value, observedAt: Date.now() };
    }
    const initial = session.ranchProgressClock;
    if (!initial) fail('缺少本次场景时间证据');
    const serverTimeMs = initial.serverMs + Math.max(0, Date.now() - initial.observedAt);
    return { serverTimeMs, dateKey: new Date(serverTimeMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) };
}
async function read(session, name, input = {}) {
    const [service, method, request, reply] = READ_ROUTES[name];
    return sceneRpc(session, service, method, types[request], types[reply], input, { read: true });
}

function taskRows(reply) {
    if (!reply?.task_info) fail('牧场任务信息未返回，不能当作已完成');
    const info = reply.task_info;
    const rows = [...(info.growth_tasks || []), ...(info.daily_tasks || []), ...(info.tasks || [])];
    const seen = new Set();
    return rows.map(row => {
        const id = positive(row.id, '任务ID');
        if (seen.has(id)) fail('牧场任务ID重复');
        seen.add(id);
        const config = getRanchTask(id);
        if (!config && BigInt(id) < 300000n) fail('scene2返回了农场任务，未接受混用');
        const progress = numberText(row.progress), total = numberText(row.total_progress);
        const group = numberText(row.group);
        const baseRewards = rewards(row.rewards || []), extraRewards = rewards(row.extra_rewards || []);
        const confirmed = !!config && total === String(config.total_progress)
            && (group === '0' || group === String(config.group))
            && small(row.task_type) === (config.category === 'daily' ? 5 : 4);
        const ready = row.is_unlocked === true && row.is_claimed !== true && BigInt(total) > 0n && BigInt(progress) >= BigInt(total);
        const canClaim = confirmed && ready && baseRewards.length > 0 && extraRewards.length === 0;
        return { id, category: config?.category || 'other', description: row.desc || config?.desc || `任务 #${id}`,
            progress, total, group, taskType: small(row.task_type), unlocked: row.is_unlocked === true,
            claimed: row.is_claimed === true, shareMultiple: numberText(row.share_multiple),
            configConfirmed: confirmed, condition: config?.condition || '', rewards: baseRewards, extraRewards,
            canClaim, stateReason: !confirmed ? '任务配置或目标尚未确认' : extraRewards.length ? '附加奖励规则未核验，仅展示'
                : row.is_claimed === true ? '已领取' : !row.is_unlocked ? '未解锁' : !ready ? '进行中'
                    : !baseRewards.length ? '奖励尚未确认' : '可普通领取' };
    }).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}
function taskWriteReceipt(reply) {
    if (!reply?.task_info) fail('任务领取回包缺少任务状态');
    const info = reply.task_info;
    const all = [...(info.growth_tasks || []), ...(info.daily_tasks || []), ...(info.tasks || [])];
    const seen = new Set();
    return all.map(row => {
        const id = positive(row.id, '领取回包任务ID');
        if (seen.has(id)) fail('任务领取回包包含重复任务ID');
        seen.add(id);
        return { id, claimed: row.is_claimed === true };
    });
}
async function loadTasks(session) {
    const tasks = taskRows(await read(session, 'tasks', { global_scene_id: RANCH_SCENE_ID }));
    return { tasks, summary: { total: tasks.length, claimable: tasks.filter(row => row.canClaim).length,
        claimed: tasks.filter(row => row.claimed).length, daily: tasks.filter(row => row.category === 'daily').length },
    guideReportingEnabled: false, automaticClaimEnabled: false };
}

async function loadBook(session) {
    const [normal, levelReply, weight] = await Promise.all([
        read(session, 'book', { type: BOOK_TYPE }), read(session, 'levels', { type: BOOK_TYPE }), read(session, 'weight'),
    ]);
    if (Number(normal.type) !== BOOK_TYPE || Number(normal.current_level) !== Number(levelReply.current_level)
        || Number(normal.total_progress) !== Number(levelReply.total_progress)) fail('牧场图鉴类型、等级或进度未相互印证');
    const totalProgress = small(normal.total_progress), currentLevel = small(normal.current_level);
    const seenLevels = new Set();
    const levels = (levelReply.level_list || []).map(row => {
        const id = small(positive(row.level, '图鉴奖励档位'));
        if (seenLevels.has(id)) fail('动物图鉴奖励档位重复');
        seenLevels.add(id);
        const need = small(row.point_condition), items = rewards(row.rewards || []);
        return { id, need, claimed: row.claimed === true,
            canClaim: row.can_claim === true && row.claimed !== true && need <= totalProgress && items.length > 0, rewards: items };
    });
    const pendingLevels = levels.filter(row => row.canClaim);
    const normalRewards = rewards(normal.total_rewards || []);
    const rewardStatusConfirmed = normal.has_claimable_reward === (pendingLevels.length > 0)
        && rewardSignature(normalRewards) === rewardSignature(pendingLevels.flatMap(row => row.rewards));
    const totalScore = numberText(weight.total_score);
    const seenWeights = new Set();
    const weightLevels = (weight.levels || []).map(row => {
        const id = small(positive(row.id, '巨大重量奖励档位'));
        if (id > 2147483647 || seenWeights.has(id)) fail('巨大重量奖励档位无效或重复');
        seenWeights.add(id);
        const need = numberText(row.score_condition), items = rewards(row.rewards || []);
        return { id, need, claimed: row.claimed === true,
            canClaim: row.can_claim === true && row.claimed !== true && BigInt(need) <= BigInt(totalScore) && items.length > 0,
            rewards: items };
    });
    const seenAnimals = new Set();
    const animals = (normal.list || []).map(row => {
        const id = String(small(positive(row.fruit_id, '图鉴条目')));
        if (seenAnimals.has(id)) fail('动物图鉴条目重复');
        seenAnimals.add(id);
        const giant = row.giant;
        // Pinned book.ts / official UI: 1124 is 11.24 kg, NOT 112.4 kg.
        const giantDto = giant ? { unlocked: giant.unlocked === true, tier: small(giant.tier),
            tierName: getRanchWeightTier(giant.tier)?.tier_name || '未确认档位',
            bestWeightKg: small(giant.best_weight_x10) / 100, minWeightKg: small(giant.lo_x10) / 100,
            maxWeightKg: small(giant.hi_x10) / 100, harvestCount: numberText(giant.harvest_count), isNew: giant.is_new === true } : null;
        const giantProduct = getRanchGiantProduct(id);
        const giantItem = giantProduct ? { id: String(giantProduct.itemId),
            name: giantProduct.item?.name || `巨大${giantProduct.animal.name}`, image: getRanchImage(giantProduct.itemId)?.url || '' } : null;
        return { id, name: getRanchAnimal(id)?.name || getRanchItem(id)?.name || `动物 #${id}`, image: getRanchImage(id)?.url || '',
            rarity: small(row.rarity), layer: small(row.layer), progress: small(row.progress), unlocked: row.unlocked === true,
            isNew: row.is_new === true, giant: giantDto, giantItem };
    });
    return { type: BOOK_TYPE, animals,
        normal: { currentLevel, totalProgress, nextProgress: small(normal.next_level_progress), levels,
            rewards: normalRewards, rewardStatusConfirmed, canClaim: rewardStatusConfirmed && pendingLevels.length > 0,
            stateReason: rewardStatusConfirmed ? '' : '奖励总表与档位未相互印证，未开放领取' },
        giant: { totalScore, currentId: small(weight.current_id), calculationMode: small(weight.calc_mode), levels: weightLevels },
        mutations: getRanchMutationRules().filter(row => row.enable_flag === true)
            .map(row => ({ type: row.mutation_type, name: row.name, description: row.tips, baseProbabilityPercent: row.pro })) };
}

function shareFromMap(map) {
    if (!map || typeof map !== 'object') return null;
    // protobufjs decodes int64 map keys as 8-byte Long hashes, including 102.
    // Use its own conversion instead of a second wire decode or guessing key text.
    const matches = Object.entries(map).filter(([key]) => {
        const id = /^\d+$/.test(key) ? BigInt(key).toString()
            : key.length === 8 ? protobuf.util.longFromHash(key, false).toString() : '';
        return id === SHARE_ID;
    });
    if (!matches.length) return null;
    if (matches.length !== 1) fail('牧场分享映射含重复102');
    const info = matches[0][1];
    if (!info || typeof info.is_claimed !== 'boolean') fail('牧场分享领取标记无效');
    return { shareCount: numberText(info.share_count), claimed: info.is_claimed === true };
}
async function loadShare(session) {
    const [reply, check] = await Promise.all([
        read(session, 'basic', { gids: [String(session.gid)] }), read(session, 'checkShare'),
    ]);
    const users = reply.users || [];
    if (users.length !== 1 || numberText(users[0].gid) !== String(session.gid)) fail('牧场分享信息所属用户不匹配');
    const info = shareFromMap(users[0].share_infos);
    const shared = !!info && BigInt(info.shareCount) > 0n;
    return { shareId: SHARE_ID, docId: SHARE_DOC_ID, known: !!info, shareCount: info?.shareCount ?? null,
        claimed: info?.claimed ?? null, shared, canReport: !!info && !info.claimed && !shared && check.can_share === true,
        canClaim: !!info && !info.claimed && shared, rewards: rewards(SHARE_REWARDS), automaticShareEnabled: false,
        stateReason: !info ? '服务端没有返回102状态，未推断为未领取' : info.claimed ? '今日已领取'
            : shared ? '分享已确认，可领取礼包' : check.can_share ? '请先在游戏内完成分享，再手动确认上报' : '分享入口当前不可用' };
}

async function loadProgressActionState(session, action, sceneReply) {
    clock(session, sceneReply);
    let state;
    if (action === 'claimTasks' || action === 'tasks') state = { tasksView: await loadTasks(session) };
    else if (action === 'claimIllustrated' || action === 'claimWeight' || action === 'book') state = { bookView: await loadBook(session) };
    else if (action === 'reportDailyShare' || action === 'claimDailyShare' || action === 'share') state = { shareView: await loadShare(session) };
    else fail('不支持的牧场成长操作', 'RANCH_INVALID_ARGUMENT');
    return { ...state, ...clock(session), bag: {}, cells: { facilities: [] } };
}
function skipped(plan, reason) {
    return { ...plan, count: 0, costItems: [], expectedRewards: [], reason, message: reason };
}
function planProgressAction(action, input, raw) {
    const plan = { action, payload: {}, costItems: [], expectedRewards: [], marker: { dateKey: raw.dateKey }, count: 1 };
    if (action === 'claimTasks') {
        plan.label = '普通领取牧场任务';
        if (input.double === true || input.doShared === true) fail('任务翻倍分享尚未开放，请选择普通领取', 'RANCH_INVALID_ARGUMENT');
        const rows = raw.tasksView.tasks;
        const requestedIds = Array.isArray(input.taskIds)
            ? [...new Set(input.taskIds.map(id => positive(id, '牧场任务ID')))]
            : null;
        const selected = input.all === true ? rows.filter(row => row.canClaim)
            : requestedIds ? rows.filter(row => requestedIds.includes(row.id))
                : rows.filter(row => row.id === positive(input.taskId, '牧场任务ID'));
        if (requestedIds && selected.length !== requestedIds.length) fail('领取任务清单已变化，请刷新后再试', 'RANCH_STATE_CHANGED');
        if (!selected.length || selected.some(row => !row.canClaim)) return skipped(plan, '没有已确认可普通领取的牧场任务');
        if (selected.length > 128) fail('单次最多领取128项任务', 'RANCH_INVALID_ARGUMENT');
        plan.payload = { ids: selected.map(row => row.id), do_shared: false };
        plan.marker.tasks = selected.map(row => ({ id: row.id, total: row.total, group: row.group, taskType: row.taskType, rewards: row.rewards }));
        plan.expectedRewards = rewards(selected.flatMap(row => row.rewards));
        plan.count = selected.length;
        plan.message = '仅普通奖励，不上报任务分享、不跳过引导；本次只发送一个批量领取请求。';
    }
    else if (action === 'claimIllustrated') {
        plan.label = '领取动物图鉴奖励';
        if (input.kind && input.kind !== 'normal') fail('巨大重量图鉴请逐档领取', 'RANCH_INVALID_ARGUMENT');
        const normal = raw.bookView.normal;
        if (!normal.canClaim) return skipped(plan, normal.stateReason || '没有已确认可领取的动物图鉴奖励');
        const selected = normal.levels.filter(row => row.canClaim);
        plan.payload = { type: BOOK_TYPE };
        plan.marker = { ...plan.marker, type: BOOK_TYPE, currentLevel: normal.currentLevel, totalProgress: normal.totalProgress,
            levels: selected.map(row => ({ id: row.id, need: row.need, rewards: row.rewards })) };
        plan.expectedRewards = rewards(selected.flatMap(row => row.rewards));
        plan.count = selected.length;
    }
    else if (action === 'claimWeight') {
        plan.label = '领取巨大重量图鉴奖励';
        const levelId = small(positive(input.levelId, '巨大重量档位'));
        const row = raw.bookView.giant.levels.find(level => level.id === levelId);
        if (!row?.canClaim) return skipped(plan, '该巨大重量档位尚未达标、已领取或奖励未确认');
        plan.payload = { id: levelId };
        plan.marker.levels = [{ id: row.id, need: row.need, rewards: row.rewards }];
        plan.marker.totalScore = raw.bookView.giant.totalScore;
        plan.expectedRewards = rewards(row.rewards);
        plan.message = '只领取当前档位，不自动继续领取其他档位。';
    }
    else {
        const share = raw.shareView;
        plan.label = action === 'reportDailyShare' ? '上报已完成的牧场分享' : '领取牧场每日首次分享礼包';
        if (!share.known) return skipped(plan, share.stateReason);
        if (action === 'reportDailyShare') {
            plan.label = '上报已完成的牧场分享';
            if (input.sharedInGame !== true) fail('请先在游戏内完成分享并明确确认', 'RANCH_INVALID_ARGUMENT');
            if (!share.canReport) return skipped(plan, share.stateReason);
            plan.payload = { share_id: SHARE_ID, doc_id: SHARE_DOC_ID, channel: 0 };
            plan.message = input.automatic === true
                ? '登记牧场每日分享奖励状态；不会打开分享面板或向好友发送消息。'
                : '仅上报你已在游戏内完成的分享，不替你发送社交消息，也不自动领取礼包。';
        }
        else {
            plan.label = '领取牧场每日首次分享礼包';
            if (!share.canClaim) return skipped(plan, share.stateReason);
            plan.payload = { share_id: SHARE_ID };
            plan.expectedRewards = rewards(SHARE_REWARDS);
        }
        plan.marker.shareCount = share.shareCount;
        plan.marker.claimed = share.claimed;
    }
    return plan;
}

function verifyProgressOutcome(plan, reply, before, after) {
    const unknown = reason => fail(`${plan.label}结果未确认：${reason}；保留待核对，勿重发`, 'RANCH_OUTCOME_UNKNOWN', true);
    if (plan.action !== 'claimTasks' && (!after || before.dateKey !== after.dateKey)) unknown('缺少同一游戏日期的写后状态');
    if (plan.action !== 'claimTasks' && (reply.compensated_items || []).length) unknown('出现未报价的补偿奖励');
    if (plan.action === 'claimTasks') {
        let receipt;
        try { receipt = taskWriteReceipt(reply); } catch (error) { unknown(error.message); }
        const requestedIds = new Set(plan.marker.tasks.map(task => task.id));
        const configuredRanchIds = new Set((before.tasksView?.tasks || []).map(task => task.id));
        // Match upstream: the RPC may return a different scene's task snapshot,
        // or claimed entries may disappear. Only an explicit selected-task
        // unclaimed status is negative; exact reward items decide success.
        if (receipt.some(row => requestedIds.has(row.id) && !row.claimed)) unknown('接口仍显示所选任务未领取');
        if (receipt.some(row => (configuredRanchIds.has(row.id) || getRanchTask(row.id))
            && !requestedIds.has(row.id) && row.claimed)) unknown('回包显示额外牧场任务已领取');
        const actualItems = rewards(reply.items || [], true);
        const expectedItems = rewards(plan.marker.tasks.flatMap(task => task.rewards));
        if (rewardSignature(actualItems) !== rewardSignature(expectedItems)) unknown('接口返回奖励与所选任务奖励不一致');
        return { rewards: actualItems, completed: plan.marker.tasks.length };
    }
    if (plan.action === 'claimIllustrated' || plan.action === 'claimWeight') {
        const ids = plan.marker.levels.map(row => row.id);
        const returned = plan.action === 'claimIllustrated' ? reply.claimed_level_ids : reply.claimed_ids;
        if (!sameIds(returned, ids)) unknown('领取档位为空、重复或与报价不同');
        const actual = plan.action === 'claimIllustrated' ? reply.total_rewards : reply.rewards;
        if (rewardSignature(actual || [], true) !== rewardSignature(plan.expectedRewards)) unknown('图鉴奖励不匹配');
        const key = plan.action === 'claimIllustrated' ? 'normal' : 'giant';
        const next = after.bookView[key].levels;
        if (ids.some(id => next.find(row => row.id === id)?.claimed !== true)) unknown('档位缺失或仍未领取');
        const previous = before.bookView[key].levels;
        if (previous.some(row => !row.claimed && !ids.includes(row.id) && next.find(item => item.id === row.id)?.claimed)) unknown('未报价档位也被领取');
        if (key === 'normal' && (Number(reply.current_level) !== plan.marker.currentLevel
            || after.bookView.type !== BOOK_TYPE)) unknown('动物图鉴等级或类型不匹配');
        return { rewards: rewards(actual, true), completed: ids.length };
    }
    let proof;
    try { proof = shareFromMap(reply.share_infos); } catch (error) { unknown(error.message); }
    const next = after.shareView;
    if (!proof || !next.known) unknown('回包或写后读取缺少102分享状态');
    if (plan.action === 'reportDailyShare') {
        if (proof.claimed || next.claimed || BigInt(proof.shareCount) !== BigInt(plan.marker.shareCount) + 1n
            || next.shareCount !== proof.shareCount) unknown('分享上报次数未准确增加或误混礼包领取');
        return { rewards: [], completed: 1 };
    }
    if (!proof.claimed || !next.claimed || proof.shareCount !== plan.marker.shareCount
        || next.shareCount !== proof.shareCount) unknown('每日分享领取终态未确认');
    if (rewardSignature(reply.rewards || [], true) !== rewardSignature(plan.expectedRewards)) unknown('礼包奖励不匹配或为空');
    return { rewards: rewards(reply.rewards, true), completed: 1 };
}

function viewKey(accountId, section) {
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const gid = Number(network.getUserState?.()?.gid);
    if (String(diagnostic.accountId || '') !== String(accountId) || !Number.isSafeInteger(gid) || gid <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(Number(diagnostic.connectionEpoch))
        || Number(diagnostic.connectionEpoch) < 0 || diagnostic.connected !== true || diagnostic.loggedIn !== true) return '';
    return JSON.stringify([String(accountId), gid, Number(diagnostic.connectionEpoch), diagnostic.remoteGeneration == null ? null : String(diagnostic.remoteGeneration),
        diagnostic.remoteGenerationSource || 'unknown', section]);
}
async function getRanchProgressView(accountId, section) {
    if (!['tasks', 'book', 'share'].includes(section)) fail('牧场成长专区无效', 'RANCH_INVALID_ARGUMENT');
    const result = await viewCache.read({ keyOf: () => viewKey(accountId, section),
        states: () => [getSceneSessionSnapshot(accountId), getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
            validateOperationSession(session);
            if (session.accountId !== String(accountId)) fail('牧场成长读取账号不匹配', 'ACCOUNT_OPERATION_CHANGED');
            const raw = await loadProgressActionState(session, section, sceneReply);
            return { readOnly: true, sceneId: RANCH_SCENE_ID, ownerGid: String(session.gid), observedAt: Date.now(),
                dateKey: raw.dateKey, serverTimeMs: raw.serverTimeMs, sourceCommit: SOURCE_COMMIT,
                ...(section === 'tasks' ? raw.tasksView : section === 'book' ? raw.bookView : raw.shareView) };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cache: { hit: result.hit, receivedAt: result.receivedAt, coalesced: result.coalesced === true } };
}
network.networkEvents?.on('taskInfoNotify', () => viewCache.invalidate());
network.networkEvents?.on('ranchDataChanged', () => viewCache.invalidate());
network.networkEvents?.on('disconnect', () => viewCache.invalidate());

module.exports = { PROGRESSION_ACTIONS, getRanchProgressView, loadProgressActionState, planProgressAction,
    verifyProgressOutcome, taskRows, rewardSignature, BOOK_TYPE, SHARE_ID,
    numberText, small, positive, rewards, clock };
