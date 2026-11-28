'use strict';

const network = require('../utils/network');
const { types } = require('../utils/proto');
const { requestError } = require('../utils/request-priority');
const { validateOperationSession, runSceneRequest } = require('./account-operation-coordinator');
const { withGameScene, getSceneSessionSnapshot, RANCH_SCENE_ID } = require('./scene-session');
const { withRanchFriendVisit, getRanchFriendSessionSnapshot } = require('./ranch-friend-session');
const { ranchOperations } = require('./ranch-operations-ledger');
const { getRanchAnimal, getRanchFacilityLimits, SOURCE_COMMIT } = require('./ranch-config');
const { clearRanchReadCache, createSceneReadCache } = require('./ranch-readonly');

const CACHE_TTL_MS = 3000;
const STROKE_OP_ID = 11009;
const MOSQUITO_OP_ID = 11003;
const ACTIONS = new Set(['steal', 'cleanFriend', 'stroke', 'putMosquito']);
const LABELS = {
    steal: '偷取好友牧场产物',
    cleanFriend: '清理好友牧场',
    stroke: '抚摸好友动物',
    putMosquito: '向好友牧场放蚊子',
};
const cache = createSceneReadCache(CACHE_TTL_MS);
const rosterCache = createSceneReadCache(CACHE_TTL_MS);
let rosterProgress = null;
let automationFriendIndex = 0;
const exhaustedQuotas = new Map();

function quotaScope(session) {
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    return `${session?.accountId || diagnostic.accountId || process.env.FARM_ACCOUNT_ID || ''}:${session?.gid || network.getUserState?.()?.gid || ''}`;
}
function gameClock() {
    const seconds = require('../utils/utils').getServerTimeSec?.();
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const day = Math.floor((seconds + 8 * 3600) / 86400);
    return { day, seconds, resetMs: ((day + 1) * 86400 - 8 * 3600) * 1000 };
}
function rememberQuota(session, action, count, observedDay, confirmedExhaustion) {
    const clock = gameClock();
    if (!clock || clock.day !== observedDay || !['stroke', 'putMosquito'].includes(action)) return;
    const key = `${quotaScope(session)}:${action}`;
    if (count > 0) exhaustedQuotas.delete(key);
    else if (count === 0 && confirmedExhaustion) exhaustedQuotas.set(key, { day: clock.day, resetMs: clock.resetMs });
}
function getInteractionQuotaResetAt(action, session) {
    const clock = gameClock(), key = `${quotaScope(session)}:${action}`, row = exhaustedQuotas.get(key);
    if (!clock || !row || row.day !== clock.day) { exhaustedQuotas.delete(key); return 0; }
    return Date.now() + row.resetMs - clock.seconds * 1000;
}

function friendError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'ranch_friend',
        sent: details.sent ?? false,
        resultState: details.resultState || 'not_sent',
        ...details,
    });
}

function integer(value) {
    const text = value && typeof value === 'object' && typeof value.toString === 'function'
        ? value.toString() : String(value ?? '0');
    if (!/^-?\d+$/.test(text)) return 0;
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : 0;
}

function id(value) {
    const text = value && typeof value === 'object' && typeof value.toString === 'function'
        ? value.toString() : String(value ?? '0');
    return /^\d+$/.test(text) ? text : '0';
}

function positiveId(value, label) {
    const text = id(value);
    if (text === '0') throw friendError(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    return text;
}

function positiveInteger(value, label) {
    const number = integer(value);
    if (number <= 0) throw friendError(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    return number;
}

function milliseconds(value) {
    const number = integer(value);
    if (number <= 0) return null;
    return number < 100000000000 ? number * 1000 : number;
}

function itemRows(items) {
    const totals = new Map();
    for (const item of items || []) {
        const itemId = id(item?.id);
        const count = BigInt(id(item?.count));
        if (itemId === '0' || count <= 0n) continue;
        totals.set(itemId, (totals.get(itemId) || 0n) + count);
    }
    return [...totals].map(([itemId, count]) => ({ id: itemId, count: count.toString() }));
}

function clearRanchFriendCache() {
    // 互动余次是账号级资源，任一好友写入需要失效本账号所有好友快照。
    cache.invalidate();
    rosterCache.invalidate();
}

function cacheKey(hostGid) {
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const ownerGid = Number(network.getUserState?.()?.gid) || 0;
    const host = Number(hostGid);
    if (!diagnostic.accountId || !Number.isSafeInteger(ownerGid) || ownerGid <= 0 || !Number.isSafeInteger(host) || host <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(Number(diagnostic.connectionEpoch)) || Number(diagnostic.connectionEpoch) < 0
        || diagnostic.connected !== true || diagnostic.loggedIn !== true) return '';
    return `${JSON.stringify([String(diagnostic.accountId), ownerGid, Number(diagnostic.connectionEpoch),
        diagnostic.remoteGeneration === undefined || diagnostic.remoteGeneration === null
            ? null : String(diagnostic.remoteGeneration), String(diagnostic.remoteGenerationSource || 'unknown')])}:${host}`;
}

async function rpc(session, service, method, Request, Reply, input, options = {}) {
    if (!Request || !Reply) throw friendError('好友牧场协议未加载', 'RANCH_FRIEND_PROTO_UNAVAILABLE');
    validateOperationSession(session);
    const body = Request.encode(Request.fromObject(input || {})).finish();
    const response = await runSceneRequest(session, service, method, body, {
        timeoutMs: options.timeoutMs || 30000,
        lifecycle: options.read ? undefined : options.lifecycle,
        assertCanSend: options.assertCanSend,
    });
    validateOperationSession(session, { ignoreCancellation: true });
    if (!response?.body?.length) {
        throw friendError('好友牧场响应为空', 'RANCH_FRIEND_RESPONSE_EMPTY', {
            sent: true,
            resultState: options.read ? 'failed' : 'unknown',
            outcomeUnknown: !options.read,
        });
    }
    return Reply.decode(response.body);
}

function patchRanches(raw, ranches) {
    const next = new Map((raw.ranches || []).map(ranch => [id(ranch.ranch_inst_id), ranch]));
    for (const ranch of ranches || []) next.set(id(ranch.ranch_inst_id), ranch);
    raw.ranches = [...next.values()];
    for (const facility of raw.cells?.facilities || []) {
        const ranch = next.get(id(facility.instance_id));
        if (ranch) facility.ranch = ranch;
    }
    return raw;
}

async function loadFriendState(session, entry, hostGid) {
    const observedDay = gameClock()?.day;
    const [detail, times] = await Promise.all([
        rpc(session, 'gamepb.animalpb.AnimalService', 'GetRanchDetail',
            types.RanchGetRanchDetailRequest, types.RanchGetRanchDetailReply,
            { host_gid: hostGid }, { read: true }),
        rpc(session, 'gamepb.animalpb.RanchService', 'GetRanchOpTimes',
            types.RanchGetRanchOpTimesRequest, types.RanchGetRanchOpTimesReply,
            { op_ids: [] }, { read: true }),
    ]);
    const remaining = operationId => {
        const row = (times.ops || []).find(item => id(item?.op_id) === String(operationId));
        const countText = row?.remaining_times?.toString();
        const count = typeof countText === 'string' && /^\d+$/.test(countText) && Number.isSafeInteger(Number(countText)) ? Number(countText) : -1;
        if (count < 0) throw friendError('好友牧场互动次数未完整返回', 'RANCH_FRIEND_RESPONSE_MISMATCH', {
            sent: true, resultState: 'failed', operationId,
        });
        const limit = integer(row.times_limit), used = integer(row.used_times);
        rememberQuota(session, operationId === STROKE_OP_ID ? 'stroke' : 'putMosquito', count, observedDay, limit > 0 && used >= limit);
        return count;
    };
    const raw = {
        hostGid: Number(hostGid),
        ownerGid: Number(session.gid),
        identity: { accountId: session.accountId, gid: session.gid, connectionEpoch: session.connectionEpoch,
            remoteGeneration: session.remoteGeneration, worker: session.workerInstanceId,
            source: session.remoteGenerationSource || 'unknown' },
        entry,
        cells: entry.homestead_cells,
        ranches: detail.ranches || [],
        interval: integer(detail.interval),
        remaining: {
            stroke: remaining(STROKE_OP_ID),
            putMosquito: remaining(MOSQUITO_OP_ID),
        },
    };
    return patchRanches(raw, raw.ranches);
}

function hasStroked(raw, animal) {
    return (animal?.mutation?.stroked_gids || []).some(gid => id(gid) === String(raw.ownerGid));
}

function canStroke(raw, animal) {
    return animal?.mutation?.strokable === true && !hasStroked(raw, animal);
}

function mosquitoState(ranch) {
    const limits = getRanchFacilityLimits(integer(ranch?.husbandry_type));
    const limit = integer(limits?.mosquito_max_count);
    const mosquitoes = (ranch?.hazards || []).filter(hazard => integer(hazard?.hazard_type) === 1).length;
    return { mosquitoes, limit, room: Math.max(0, limit - mosquitoes) };
}

function cleanableHazards(raw, ranch) {
    return (ranch?.hazards || []).filter(hazard => integer(hazard?.hazard_type) !== 1
        || id(hazard?.owner) !== String(raw.ownerGid));
}

function stealableShelves(raw, ranch) {
    return (ranch?.shelves || []).filter(shelf => shelf?.can_steal === true
        && (shelf.lots || []).some(lot => lot?.can_steal === true && BigInt(id(lot?.remain_num)) > 0n
            && !(lot.stealers || []).some(gid => id(gid) === String(raw.ownerGid))));
}

function animalDto(raw, animal) {
    const animalId = id(animal?.animal_id);
    const mutation = animal?.mutation;
    const stroked = hasStroked(raw, animal);
    return {
        instanceId: integer(animal?.animal_inst_id),
        animalId,
        name: getRanchAnimal(animalId)?.name || `动物 #${animalId}`,
        stage: integer(animal?.stage),
        stroked,
        canStroke: raw.remaining.stroke > 0 && mutation?.strokable === true && !stroked,
        mutation: mutation ? {
            type: integer(mutation.mutation_type),
            tier: integer(mutation.tier),
            strokable: mutation.strokable === true,
        } : null,
    };
}

function ranchDto(raw, ranch) {
    const mosquito = mosquitoState(ranch);
    const stealable = new Set(stealableShelves(raw, ranch).map(shelf => integer(shelf.slot_index)));
    const cleanable = cleanableHazards(raw, ranch);
    return {
        id: id(ranch?.ranch_inst_id),
        husbandryType: integer(ranch?.husbandry_type),
        name: integer(ranch?.husbandry_type) === 1 ? '动物窝' : integer(ranch?.husbandry_type) === 2 ? '动物棚' : '栏舍',
        capacity: integer(ranch?.capacity),
        animalCount: integer(ranch?.animal_count),
        mosquitoes: mosquito.mosquitoes,
        mosquitoLimit: mosquito.limit,
        mosquitoRoom: mosquito.room,
        canPutMosquito: raw.remaining.putMosquito > 0 && mosquito.limit > 0 && mosquito.room > 0,
        hazardCount: (ranch?.hazards || []).length,
        cleanableHazardCount: cleanable.length,
        animals: (ranch?.animals || []).map(animal => animalDto(raw, animal)),
        shelves: (ranch?.shelves || []).map(shelf => ({
            slot: integer(shelf?.slot_index),
            canSteal: stealable.has(integer(shelf?.slot_index)),
            products: (shelf?.lots || []).map(lot => ({
                id: id(lot?.item_id),
                count: id(lot?.remain_num),
                canSteal: lot?.can_steal === true
                    && !(lot.stealers || []).some(gid => id(gid) === String(raw.ownerGid)),
            })),
        })),
    };
}

function overviewDto(raw) {
    const ranches = raw.ranches.map(ranch => ranchDto(raw, ranch));
    return {
        gid: String(raw.hostGid),
        name: String(raw.entry?.basic?.name || `GID:${raw.hostGid}`),
        level: integer(raw.entry?.basic?.big_farm_level),
        hostAtHome: raw.entry?.host_at_home === true,
        tourist: raw.entry?.is_tourist === true,
        observedAt: Date.now(),
        source: { repository: 'liyangpengs/qq-farm-bot', commit: SOURCE_COMMIT },
        remaining: { ...raw.remaining },
        summary: {
            ranchCount: ranches.length,
            animalCount: ranches.reduce((sum, ranch) => sum + ranch.animals.length, 0),
            stealableShelfCount: ranches.reduce((sum, ranch) => sum + ranch.shelves.filter(shelf => shelf.canSteal).length, 0),
            cleanableHazardCount: ranches.reduce((sum, ranch) => sum + ranch.cleanableHazardCount, 0),
            strokableCount: ranches.reduce((sum, ranch) => sum + ranch.animals.filter(animal => animal.canStroke).length, 0),
            mosquitoRoom: ranches.reduce((sum, ranch) => sum + ranch.mosquitoRoom, 0),
        },
        ranches,
    };
}

// Independent scene2 roster. Known GIDs are query hints only, never membership
// evidence. No SyncAll or farm-list fallback is allowed in this scene lease.
async function loadRanchFriendRoster(session, checkpoint = () => {}) {
    const { getKnownFriendGids } = require('../models/store');
    const { CONFIG } = require('../config/config');
    const gids = CONFIG.platform === 'qq' ? [...new Set((getKnownFriendGids(session.accountId) || [])
        .map(Number).filter(gid => Number.isSafeInteger(gid) && gid > 0 && gid !== Number(session.gid)))].sort((a, b) => a - b) : [];
    const revision = rosterCache.getRevision();
    const key = JSON.stringify([session.accountId, session.gid, session.workerInstanceId, session.connectionEpoch,
        session.remoteGeneration, session.remoteGenerationSource, revision, gids]);
    if (!rosterProgress || rosterProgress.key !== key || Date.now() - rosterProgress.startedAt > 300000) {
        rosterProgress = { key, offset: 0, rows: new Map(), startedAt: Date.now() };
    }
    const progress = rosterProgress;
    const assertProgressCurrent = () => {
        if (rosterCache.getRevision() !== revision || rosterProgress !== progress) {
            throw friendError('牧场好友名单读取期间已失效，需重新读取全部批次', 'RANCH_READ_INVALIDATED', { resultState: 'failed' });
        }
    };
    while (progress.offset < Math.max(1, gids.length)) {
        assertProgressCurrent();
        checkpoint(false);
        const batch = gids.slice(progress.offset, progress.offset + 35);
        const reply = await rpc(session, 'gamepb.friendpb.FriendService', batch.length ? 'GetGameFriends' : 'GetAll',
            batch.length ? types.GetGameFriendsRequest : types.GetAllFriendsRequest, types.GetAllFriendsReply,
            { global_scene_id: RANCH_SCENE_ID, ...(batch.length ? { gids: batch.map(String) } : {}) }, { read: true });
        validateOperationSession(session);
        assertProgressCurrent();
        if (!Array.isArray(reply.game_friends)) throw friendError('牧场好友名单结构未确认', 'RANCH_FRIEND_RESPONSE_MISMATCH');
        for (const friend of reply.game_friends) {
            const gid = integer(friend.gid);
            if (gid <= 0 || gid === Number(session.gid) || !friend.big_farm_status || batch.length && !batch.includes(gid)) continue;
            progress.rows.set(gid, { gid, name: String(friend.name || '').trim() || String(friend.remark || '').trim() || `GID:${gid}`,
                avatarUrl: String(friend.avatar_url || ''), status: {
                    canSteal: friend.big_farm_status.can_steal === true, canHelp: friend.big_farm_status.can_help === true,
                    canMidwife: friend.big_farm_status.can_midwife === true,
                } });
        }
        // Advance only after a successful batch. If the following checkpoint
        // yields, retain the verified batch and resume from the next one.
        progress.offset += Math.max(1, batch.length);
        checkpoint(true);
    }
    const result = { sceneId: RANCH_SCENE_ID, ownerGid: String(session.gid), observedAt: Date.now(),
        friends: [...progress.rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.gid - b.gid) };
    rosterProgress = null;
    return result;
}
async function getRanchFriendRoster() {
    const accountId = String(network.getDiagnosticSnapshot?.()?.accountId || process.env.FARM_ACCOUNT_ID || '');
    const result = await rosterCache.read({
        keyOf: () => cacheKey(1),
        states: () => [getSceneSessionSnapshot(accountId), getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, ({ session }) => loadRanchFriendRoster(session),
            { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cache: { hit: result.hit, coalesced: result.coalesced === true, receivedAt: result.receivedAt } };
}

async function getRanchFriendOverview(hostGid) {
    const host = Number(positiveId(hostGid, '好友GID'));
    const accountId = String(network.getDiagnosticSnapshot?.()?.accountId || process.env.FARM_ACCOUNT_ID || '');
    const result = await cache.read({
        keyOf: () => cacheKey(host),
        states: () => [getSceneSessionSnapshot(accountId), getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, ({ session }) => withRanchFriendVisit(session, host,
            async ({ entry }) => overviewDto(await loadFriendState(session, entry, host))),
        { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cache: { hit: result.hit, coalesced: result.coalesced === true, receivedAt: result.receivedAt } };
}

function friendTarget(action, input = {}) {
    const host = Number(input.hostGid) || 0;
    if (action === 'stroke') return `ranch:stroke:${host}:${Number(input.ranchId) || 0}:${Number(input.animalId) || 0}`;
    if (action === 'putMosquito') return `ranch:putMosquito:${host}:${Number(input.ranchId) || 0}`;
    return `ranch:${action}:${host}`;
}

function planFriendAction(action, input, raw) {
    if (!ACTIONS.has(action)) throw friendError('不支持的好友牧场操作', 'RANCH_INVALID_ARGUMENT');
    const host = Number(positiveId(input?.hostGid, '好友GID'));
    if (host !== raw.hostGid) throw friendError('好友牧场目标已变化', 'RANCH_STATE_CHANGED');
    const plan = { action, label: LABELS[action], payload: {}, marker: null, count: 1, remaining: null };
    if (action === 'steal') {
        const targets = raw.ranches.flatMap(ranch => stealableShelves(raw, ranch).map(shelf => ({
            ranchId: id(ranch.ranch_inst_id),
            slot: integer(shelf.slot_index),
            itemIds: (shelf.lots || []).filter(lot => lot?.can_steal === true && BigInt(id(lot.remain_num)) > 0n
                && !(lot.stealers || []).some(gid => id(gid) === String(raw.ownerGid))).map(lot => id(lot.item_id)),
            itemCaps: itemRows((shelf.lots || []).filter(lot => lot?.can_steal === true && BigInt(id(lot.remain_num)) > 0n
                && !(lot.stealers || []).some(gid => id(gid) === String(raw.ownerGid)))
                .map(lot => ({ id: lot.item_id, count: lot.remain_num }))),
        })));
        plan.payload = { host_gid: host, targets: [] };
        plan.marker = { targets };
        plan.count = targets.length;
    }
    else if (action === 'cleanFriend') {
        const ranches = raw.ranches.filter(ranch => cleanableHazards(raw, ranch).length > 0);
        const hazards = ranches.flatMap(ranch => cleanableHazards(raw, ranch)
            .map(hazard => `${id(ranch.ranch_inst_id)}:${id(hazard.hazard_id)}`));
        plan.payload = { host_gid: host, ranch_inst_ids: ranches.map(ranch => id(ranch.ranch_inst_id)) };
        plan.marker = { hazards };
        plan.count = hazards.length;
    }
    else {
        const ranchId = positiveId(input?.ranchId, '好友栏舍');
        const ranch = raw.ranches.find(row => id(row.ranch_inst_id) === ranchId);
        if (!ranch) throw friendError('好友栏舍已变化，请刷新', 'RANCH_STATE_CHANGED');
        if (action === 'stroke') {
            if (raw.remaining.stroke <= 0) throw friendError('今日抚摸次数已用完', 'RANCH_INTERACTION_LIMIT');
            const animalId = positiveInteger(input?.animalId, '动物实例');
            const animal = (ranch.animals || []).find(row => integer(row.animal_inst_id) === animalId);
            if (!animal || !canStroke(raw, animal)) throw friendError('这只动物已抚摸或当前不能抚摸', 'RANCH_STATE_CHANGED');
            plan.payload = { host_gid: host, target: { ranch_inst_id: ranchId, animal_inst_id: animalId } };
            plan.marker = { animalId: id(animal.animal_id) };
            plan.remaining = raw.remaining.stroke;
            plan.label = `抚摸${getRanchAnimal(animal.animal_id)?.name || '好友动物'}`;
        }
        else {
            if (raw.remaining.putMosquito <= 0) throw friendError('今日放蚊次数已用完', 'RANCH_INTERACTION_LIMIT');
            const state = mosquitoState(ranch);
            if (!state.limit) throw friendError('该栏舍蚊子上限未确认', 'RANCH_CONFIG_UNKNOWN');
            if (!state.room) throw friendError(`该栏舍已有 ${state.limit} 只蚊子`, 'RANCH_HAZARD_FULL');
            plan.payload = { ranch_inst_id: ranchId, host_gid: host, op_id: MOSQUITO_OP_ID, count: 1 };
            plan.marker = {
                limit: state.limit,
                existingHazards: (ranch.hazards || []).map(hazard => id(hazard.hazard_id)),
            };
            plan.remaining = raw.remaining.putMosquito;
            plan.label = `向好友${integer(ranch.husbandry_type) === 1 ? '窝' : '棚'}放蚊子`;
        }
    }
    plan.signature = JSON.stringify({ identity: raw.identity, action, payload: plan.payload, marker: plan.marker, remaining: plan.remaining, count: plan.count });
    plan.target = friendTarget(action, input);
    return plan;
}

function unknown(plan, reason) {
    throw friendError(`${plan.label}结果未能确认：${reason}；请刷新核对，勿重复提交`, 'RANCH_RESULT_UNKNOWN', {
        sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
}

function verifyPositiveItems(plan, items) {
    if ((items || []).some(item => id(item?.id) === '0' || BigInt(id(item?.count)) <= 0n)) unknown(plan, '奖励数量无效');
}

function verifyFriendOutcome(plan, reply, raw) {
    if (plan.action === 'steal') {
        const expected = new Map(plan.marker.targets.map(target => [`${target.ranchId}:${target.slot}`, target]));
        const seen = new Set();
        if (!(reply.op_results || []).length) unknown(plan, '有可偷目标但没有实际结果');
        for (const result of reply.op_results || []) {
            const key = `${id(result?.facility_inst_id)}:${integer(result?.target_id)}`;
            const target = expected.get(key);
            if (!target || integer(result?.kind) !== 2 || seen.has(key) || (result.costs || []).length
                || !(result.rewards || []).length
                || (result.rewards || []).some(item => !target.itemIds.includes(id(item.id)) || BigInt(id(item.count)) <= 0n)) {
                unknown(plan, '偷取目标或奖励不匹配');
            }
            for (const reward of itemRows(result.rewards || [])) {
                const cap = target.itemCaps.find(item => item.id === reward.id);
                if (!cap || BigInt(reward.count) > BigInt(cap.count)) unknown(plan, '偷取奖励超出已确认产物存量');
            }
            seen.add(key);
        }
        if (seen.size > plan.count) unknown(plan, '偷取数量超出报价');
        return { completed: seen.size, rewards: itemRows((reply.op_results || []).flatMap(result => result.rewards || [])) };
    }
    if (plan.action === 'cleanFriend') {
        const expected = new Set(plan.marker.hazards);
        const seen = new Set();
        if (!(reply.op_results || []).length) unknown(plan, '有待清理目标但没有实际结果');
        for (const result of reply.op_results || []) {
            const key = `${id(result?.facility_inst_id)}:${id(result?.target_id)}`;
            if (integer(result?.kind) !== 3 || !expected.has(key) || seen.has(key) || (result.costs || []).length) {
                unknown(plan, '清理目标不匹配');
            }
            verifyPositiveItems(plan, result.rewards || []);
            const ranch = (reply.ranches || []).find(row => id(row.ranch_inst_id) === id(result.facility_inst_id));
            if (ranch && (ranch.hazards || []).some(hazard => id(hazard.hazard_id) === id(result.target_id))) {
                unknown(plan, '好友清理回包仍包含该目标');
            }
            seen.add(key);
        }
        if (seen.size > plan.count) unknown(plan, '清理数量超出报价');
        return { completed: seen.size, rewards: itemRows((reply.op_results || []).flatMap(result => result.rewards || [])) };
    }
    if (integer(reply.remaining_times) !== plan.remaining - 1) unknown(plan, '互动剩余次数不匹配');
    if (plan.action === 'stroke') {
        const result = reply.op_result;
        const target = plan.payload.target;
        const animal = (reply.ranches || []).find(ranch => id(ranch.ranch_inst_id) === id(target.ranch_inst_id))
            ?.animals?.find(row => integer(row.animal_inst_id) === target.animal_inst_id);
        if (!result || integer(result.kind) !== 1 || id(result.facility_inst_id) !== id(target.ranch_inst_id)
            || integer(result.target_id) !== target.animal_inst_id || (result.costs || []).length
            || !animal || id(animal.animal_id) !== plan.marker.animalId
            || !(animal.mutation?.stroked_gids || []).some(gid => id(gid) === String(raw.ownerGid))
            || (reply.triggered === true && !integer(animal.mutation?.mutation_type))) {
            unknown(plan, '抚摸目标或动物状态不匹配');
        }
        verifyPositiveItems(plan, result.rewards || []);
        return { completed: 1, rewards: itemRows(result.rewards || []), triggered: reply.triggered === true };
    }
    const hazards = reply.hazards || [];
    const seen = new Set(hazards.map(hazard => id(hazard.hazard_id)));
    const added = hazards.filter(hazard => integer(hazard.hazard_type) === 1
        && id(hazard.owner) === String(raw.ownerGid)
        && !plan.marker.existingHazards.includes(id(hazard.hazard_id)));
    const mosquitoCount = hazards.filter(hazard => integer(hazard.hazard_type) === 1).length;
    if (id(reply.actual_count) !== '1' || added.length !== 1 || seen.size !== hazards.length
        || hazards.some(hazard => id(hazard.hazard_id) === '0' || id(hazard.owner) === '0')
        || mosquitoCount > plan.marker.limit) unknown(plan, '新增蚊子或栏舍上限不匹配');
    verifyPositiveItems(plan, reply.rewards || []);
    return { completed: 1, rewards: itemRows(reply.rewards || []) };
}

const ROUTES = {
    steal: ['gamepb.animalpb.AnimalService', 'StealProduce', 'RanchStealProduceRequest', 'RanchStealProduceReply'],
    cleanFriend: ['gamepb.animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanchRequest', 'RanchCleanAllRanchReply'],
    stroke: ['gamepb.animalpb.RanchService', 'StrokeAnimal', 'RanchStrokeAnimalRequest', 'RanchStrokeAnimalReply'],
    putMosquito: ['gamepb.animalpb.RanchService', 'PutHazard', 'RanchPutHazardRequest', 'RanchPutHazardReply'],
};

function patchAfterWrite(raw, plan, reply) {
    if (reply.ranches) patchRanches(raw, reply.ranches);
    if (plan.action === 'putMosquito') {
        const ranch = raw.ranches.find(row => id(row.ranch_inst_id) === id(plan.payload.ranch_inst_id));
        if (ranch) ranch.hazards = reply.hazards || [];
    }
    if (plan.action === 'stroke') raw.remaining.stroke = integer(reply.remaining_times);
    if (plan.action === 'putMosquito') raw.remaining.putMosquito = integer(reply.remaining_times);
    return raw;
}

async function executeFriendPlan(accountId, plan, raw, session, assertCanSend) {
    if (String(accountId) !== session.accountId) throw friendError('好友牧场写与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
    if (!plan.count) return { raw, result: { status: 'skipped', action: plan.action, label: plan.label,
        count: 0, completed: 0, costs: [], rewards: [], reason: 'no_eligible_targets' } };
    const [service, method, requestName, replyName] = ROUTES[plan.action] || [];
    if (!service) throw friendError('不支持的好友牧场写操作', 'RANCH_INVALID_ARGUMENT');
    clearRanchFriendCache(raw.hostGid);
    clearRanchReadCache();
    try {
        const observedDay = gameClock()?.day;
        const executed = await ranchOperations.spend(accountId, {
            target: plan.target,
            label: plan.label,
            costs: [],
        }, async lifecycle => {
            const reply = await rpc(session, service, method, types[requestName], types[replyName], plan.payload, { lifecycle, assertCanSend });
            const outcome = verifyFriendOutcome(plan, reply, raw);
            return {
                result: {
                    status: outcome.completed ? 'confirmed' : 'skipped',
                    action: plan.action,
                    label: plan.label,
                    count: plan.count,
                    costs: [],
                    rewards: outcome.rewards,
                    completed: outcome.completed,
                    partial: outcome.completed < plan.count,
                    triggered: outcome.triggered === true,
                },
                raw: patchAfterWrite(raw, plan, reply),
            };
        });
        if (['stroke', 'putMosquito'].includes(plan.action)) rememberQuota(session, plan.action,
            executed.raw.remaining[plan.action], observedDay, executed.result.status === 'confirmed');
        return executed;
    }
    finally {
        clearRanchFriendCache(raw.hostGid);
        clearRanchReadCache();
    }
}

async function quoteRanchFriendAction(accountId, action, input = {}) {
    if (!ACTIONS.has(action)) throw friendError('不支持的好友牧场操作', 'RANCH_INVALID_ARGUMENT');
    const target = friendTarget(action, input);
    if (ranchOperations.hasPendingTarget(accountId, target)) {
        throw friendError('该好友牧场操作有待核对记录，本次未切换场景或发送请求', 'RANCH_PENDING_CONFIRMATION', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    const host = Number(positiveId(input.hostGid, '好友GID'));
    return withGameScene(RANCH_SCENE_ID, ({ session }) => {
        if (String(accountId) !== session.accountId) throw friendError('好友牧场请求与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
        return withRanchFriendVisit(session, host, async ({ entry }) => {
        const plan = planFriendAction(action, input, await loadFriendState(session, entry, host));
        return {
            action,
            label: plan.label,
            count: plan.count,
            skipped: plan.count === 0,
            costs: [],
            rewards: [],
            expected: { signature: plan.signature },
            message: '',
            pendingBlocked: false,
        };
        });
    }, { priority: 'foreground', timeoutMs: 155000 });
}

async function operateRanchFriendAction(accountId, action, input = {}, expected = {}) {
    if (!ACTIONS.has(action)) throw friendError('不支持的好友牧场操作', 'RANCH_INVALID_ARGUMENT');
    const target = friendTarget(action, input);
    if (ranchOperations.hasPendingTarget(accountId, target)) {
        throw friendError('该好友牧场操作上次结果未知，本次未切换场景或发送请求', 'RANCH_PENDING_CONFIRMATION', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    const host = Number(positiveId(input.hostGid, '好友GID'));
    return withGameScene(RANCH_SCENE_ID, ({ session }) => {
        if (String(accountId) !== session.accountId) throw friendError('好友牧场请求与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
        return withRanchFriendVisit(session, host, async ({ entry }) => {
        const raw = await loadFriendState(session, entry, host);
        const plan = planFriendAction(action, input, raw);
        if (expected?.signature !== plan.signature) {
            throw friendError('好友牧场状态已变化，请重新确认', 'RANCH_OFFER_CHANGED');
        }
        const executed = await executeFriendPlan(accountId, plan, raw, session);
        return executed.result;
        });
    }, { priority: 'foreground', timeoutMs: 155000 });
}

function isConfirmedEnterRefusal(error) {
    return error?.methodName === 'EnterHomestead'
        && ['remote', 'game_request'].includes(String(error?.stage || ''))
        && error?.outcomeUnknown !== true && error?.resultState !== 'unknown';
}

async function automateRanchFriend(session, accountId, friend, actionEnabled, shouldYield = () => false, progress = {}, onOutcome = () => {}) {
    const host = Number(friend?.gid);
    const enabled = action => actionEnabled(action) && !getInteractionQuotaResetAt(action, session);
    if (!Number.isSafeInteger(host) || host <= 0 || host === session.gid
        || ![...ACTIONS].some(action => !progress[action] && enabled(action))) return { skipped: true, results: [] };
    try {
        return await withRanchFriendVisit(session, host, async ({ entry }) => {
            let raw = await loadFriendState(session, entry, host);
            const results = [];
            let acted = false;
            const pause = () => shouldYield(acted);
            const nickname = String(entry?.basic?.name || '').trim() || friend?.name || `GID:${host}`;
            const run = async (action, input = {}) => {
                if (progress[action] || pause()) return null;
                if (!enabled(action)) return null;
                const plan = planFriendAction(action, { ...input, hostGid: host }, raw);
                if (!plan.count) { progress[action] = true; return null; }
                if (!enabled(action) || pause()) return null;
                let executed;
                try {
                    executed = await executeFriendPlan(accountId, plan, raw, session, () => {
                        if (!enabled(action)) throw friendError('好友牧场动作已不符合最新设置', 'RANCH_FRIEND_ACTION_DISABLED');
                        if (pause()) throw friendError('好友牧场写入前让路农场', 'RANCH_AUTOMATION_YIELD');
                    });
                }
                catch (error) {
                    if (error?.resultState === 'not_sent'
                        && ['RANCH_FRIEND_ACTION_DISABLED', 'RANCH_AUTOMATION_YIELD'].includes(error.errorCode)) return null;
                    throw error;
                }
                raw = executed.raw;
                acted = true;
                progress[action] = true;
                if (executed.result.status === 'confirmed') {
                    results.push(executed.result);
                    onOutcome(executed.result, nickname);
                }
                return executed.result;
            };

            // Perishable shelf output first; completed work is retained across
            // scene reentry, while every unfinished plan is freshly quoted.
            await run('steal');
            if (!pause()) await run('cleanFriend');
            if (!pause() && !progress.stroke && enabled('stroke') && raw.remaining.stroke > 0) {
                const candidate = raw.ranches.flatMap(ranch => (ranch.animals || [])
                    .filter(animal => canStroke(raw, animal))
                    .map(animal => ({ ranchId: id(ranch.ranch_inst_id), animalId: integer(animal.animal_inst_id) })))[0];
                if (candidate) await run('stroke', candidate);
                else progress.stroke = true;
            }
            else if (!pause() && raw.remaining.stroke === 0) progress.stroke = true;
            if (!pause() && !progress.putMosquito && enabled('putMosquito') && raw.remaining.putMosquito > 0) {
                const ranch = raw.ranches.find(row => mosquitoState(row).room > 0 && mosquitoState(row).limit > 0);
                if (ranch) await run('putMosquito', { ranchId: id(ranch.ranch_inst_id) });
                else progress.putMosquito = true;
            }
            else if (!pause() && raw.remaining.putMosquito === 0) progress.putMosquito = true;
            const unfinished = [...ACTIONS].some(action => enabled(action) && !progress[action]);
            return { results, yielded: unfinished, friend: { gid: host, name: nickname } };
        });
    }
    catch (error) {
        if (isConfirmedEnterRefusal(error)) return { skipped: true, results: [], reason: 'friend_ranch_unavailable' };
        throw error;
    }
}

function nextAutomationFriend(friends) {
    if (!Array.isArray(friends) || !friends.length) return null;
    const friend = friends[automationFriendIndex % friends.length];
    automationFriendIndex = (automationFriendIndex + 1) % friends.length;
    return friend;
}

module.exports = {
    ACTIONS,
    getRanchFriendOverview,
    getRanchFriendRoster,
    loadRanchFriendRoster,
    getInteractionQuotaResetAt,
    quoteRanchFriendAction,
    operateRanchFriendAction,
    planFriendAction,
    executeFriendPlan,
    automateRanchFriend,
    nextAutomationFriend,
    clearRanchFriendCache,
    friendTarget,
    getRanchFriendSessionSnapshot,
    resetAutomationCursor: () => { automationFriendIndex = 0; },
};
