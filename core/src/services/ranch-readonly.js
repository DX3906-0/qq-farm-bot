'use strict';

const network = require('../utils/network');
const { types } = require('../utils/proto');
const { requestError, getRequestContext, runWithRequestContext, throwIfRequestCancelled } = require('../utils/request-priority');
const { getRanchAnimal, getRanchFacility, getRanchMutation, getRanchImage, getRanchItem } = require('./ranch-config');
const { validateOperationSession, runSceneRequest } = require('./account-operation-coordinator');
const { withGameScene, getSceneSessionSnapshot, RANCH_SCENE_ID } = require('./scene-session');
const { getRanchFriendSessionSnapshot } = require('./ranch-friend-session');

const CACHE_TTL_MS = 3000;
const SOURCE_COMMIT = '6ac7a3d7930018058d201af86beea8de6a9f8507';
const sceneReadCaches = new Set();

function ranchError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'ranch_readonly',
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

function milliseconds(value) {
    const number = integer(value);
    if (number <= 0) return null;
    return number < 100000000000 ? number * 1000 : number;
}

function itemDto(item) {
    const itemId = id(item?.id || item?.item_id);
    return { id: itemId, count: id(item?.count ?? item?.remain_num), name: getRanchItem(itemId)?.name || `物品 #${itemId}`,
        image: getRanchImage(itemId)?.url || '' };
}

function animalDto(animal, serverTimeMs = Date.now()) {
    const animalId = id(animal?.animal_id);
    const mutation = animal?.mutation;
    const config = getRanchAnimal(animalId);
    const imageId = integer(mutation?.mutation_type) > 0 ? getRanchMutation(animalId)?.giant_cub_item_id : config?.cub_item_id;
    const nextTimes = [animal?.infant_ready_at_ms, animal?.grow_ready_at_ms,
        animal?.produce_ready_at_ms, animal?.mature_ready_at_ms]
        .map(milliseconds).filter(value => value !== null && value > serverTimeMs);
    return {
        instanceId: integer(animal?.animal_inst_id),
        animalId,
        slot: integer(animal?.slot_index),
        name: getRanchAnimal(animalId)?.name || `动物 #${animalId}`,
        image: getRanchImage(imageId)?.url || '',
        imageRole: '幼崽道具图标，非当前阶段立绘',
        stage: integer(animal?.stage),
        stageName: ['未知', '幼崽期', '成长期', '生产期', '成熟期', '可收获'][integer(animal?.stage)] || '未知',
        produceCount: integer(animal?.produce_count),
        maxProduceCount: config?.max_produce_count ?? null,
        limitedCanUsed: animal?.limited_can_used === true,
        deadlines: { infant: milliseconds(animal?.infant_ready_at_ms), grow: milliseconds(animal?.grow_ready_at_ms),
            produce: milliseconds(animal?.produce_ready_at_ms), mature: milliseconds(animal?.mature_ready_at_ms) },
        expectedHarvest: { exp: id(animal?.expected_harvest_exp), items: (animal?.expected_harvest_sells || []).map(itemDto) },
        expectedProduce: { exp: id(animal?.expected_produce_exp), items: (animal?.expected_produce_sells || []).map(itemDto) },
        canHarvest: animal?.can_harvest === true,
        canProduce: animal?.can_deliver === true,
        canFeed: animal?.can_feed === true,
        canRelease: animal?.can_donate === true,
        grassBlocked: animal?.grass_blocked === true,
        producing: animal?.producing === true,
        nextAtMs: nextTimes.length ? Math.min(...nextTimes) : null,
        mutation: mutation ? {
            type: integer(mutation.mutation_type),
            tier: integer(mutation.tier),
            weightX10: integer(mutation.weight_final_x10 || mutation.weight_display_x10),
            displayWeightX10: integer(mutation.weight_display_x10), finalWeightX10: integer(mutation.weight_final_x10),
            source: integer(mutation.source), becameAtMs: milliseconds(mutation.became_at_ms),
            strokable: mutation.strokable === true,
        } : null,
    };
}

function ranchDto(ranch, serverTimeMs = Date.now()) {
    const grass = ranch?.grass;
    return {
        id: id(ranch?.ranch_inst_id),
        husbandryType: integer(ranch?.husbandry_type),
        capacity: integer(ranch?.capacity),
        animalCount: integer(ranch?.animal_count),
        grass: {
            amount: id(grass?.amount),
            emptyAtMs: milliseconds(grass?.empty_at_ms),
        },
        hazardCount: Array.isArray(ranch?.hazards) ? ranch.hazards.length : 0,
        shelfCount: Array.isArray(ranch?.shelves) ? ranch.shelves.length : 0,
        hazards: (ranch?.hazards || []).map(row => ({ id: id(row.hazard_id), type: integer(row.hazard_type), ownerGid: id(row.owner) })),
        shelves: (ranch?.shelves || []).map(row => ({ slot: integer(row.slot_index), totalRemain: id(row.total_remain),
            canCollect: row.can_collect === true, products: (row.lots || []).map(lot => ({ ...itemDto({ id: lot.item_id, count: lot.remain_num }),
                baseCount: id(lot.base_num), stolenCount: id(lot.stolen_num) })) })),
        animals: (ranch?.animals || []).map(row => animalDto(row, serverTimeMs)),
    };
}

function facilityDto(facility, serverTimeMs = Date.now()) {
    const facilityId = integer(facility?.facility_id);
    const feed = facility?.feed_machine;
    const metadata = getRanchFacility(facilityId);
    const next = getRanchFacility(metadata?.next_facility_id);
    const requirement = next?.upgrade_conditions?.match(/^RANCH_LEVEL:(\d+)$/);
    return {
        id: id(facility?.instance_id),
        facilityId,
        moduleType: integer(facility?.module_type),
        name: getRanchFacility(facilityId)?.name || `设施 #${facilityId}`,
        image: getRanchImage(facilityId, true)?.url || '',
        imageRole: '官方设施图标',
        level: integer(facility?.level),
        capacity: integer(facility?.capacity),
        state: integer(facility?.state),
        upgradeState: integer(facility?.upgrade_state),
        upgradeEndAtMs: milliseconds(facility?.upgrade_end_time),
        nextUpgrade: next && requirement && [6, 7, 8].includes(integer(facility?.module_type)) ? {
            facilityId: Number(next.facility_id), level: Number(next.level), capacity: Number(next.capacity),
            requiredLevel: Number(requirement[1]), durationSec: Number(next.upgrade_secs),
        } : null,
        position: { x: integer(facility?.position_x), y: integer(facility?.position_y) },
        feedMachine: feed ? {
            count: integer(feed.feed_count),
            consumeRate: integer(feed.consume_rate),
            remainingSec: integer(feed.remaining_secs),
            status: integer(feed.status),
        } : null,
        ranch: facility?.ranch ? ranchDto(facility.ranch, serverTimeMs) : null,
    };
}

function cacheKey() {
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const gid = Number(network.getUserState?.()?.gid) || 0;
    if (!diagnostic.accountId || !Number.isSafeInteger(gid) || gid <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(Number(diagnostic.connectionEpoch)) || Number(diagnostic.connectionEpoch) < 0
        || diagnostic.connected !== true || diagnostic.loggedIn !== true) return '';
    return JSON.stringify([String(diagnostic.accountId), gid, Number(diagnostic.connectionEpoch),
        diagnostic.remoteGeneration === undefined || diagnostic.remoteGeneration === null ? null : String(diagnostic.remoteGeneration),
        String(diagnostic.remoteGenerationSource || 'unknown')]);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 复合场景读：共享事务但各HTTP等待独立，只有无人等待且未取得租约时才取消。 */
function createSceneReadCache(ttlMs, maxEntries = 32) {
    const values = new Map();
    const flights = new Map();
    let revision = 0;
    const invalidated = () => ranchError('牧场读取已被写入或连接变化失效，请重新刷新', 'RANCH_READ_INVALIDATED', {
        sent: true, resultState: 'failed', outcomeUnknown: false,
    });
    function invalidate() {
        revision++;
        values.clear();
        flights.clear();
    }
    async function read({ keyOf, states, load, timeoutMs = 155000 }) {
        const context = getRequestContext();
        throwIfRequestCancelled(context);
        const key = keyOf();
        if (!key) throw ranchError('牧场读取账号或连接不可用', 'ACCOUNT_OPERATION_UNAVAILABLE');
        const version = revision;
        const cacheKey = `${key}:${version}`;
        const state = states();
        const recovery = state.some(row => row?.recoveryRequired === true);
        const unknown = state.some(row => row?.phase === 'unknown');
        const cached = values.get(cacheKey);
        if (!recovery && !unknown && cached?.expiresAt > Date.now()) {
            return { value: clone(cached.value), hit: true, receivedAt: cached.receivedAt };
        }
        let flight = unknown ? null : flights.get(cacheKey);
        const coalesced = !!flight;
        if (!flight) {
            flight = { controller: new AbortController(), started: false, settled: false, waiters: 0,
                deadline: Date.now() + timeoutMs, promise: null };
            const current = flight;
            current.promise = Promise.resolve().then(() => runWithRequestContext({
                signal: current.controller.signal, deadline: current.deadline, priority: context.priority || 'foreground',
            }, () => load({ onStart: () => {
                if (revision !== version || keyOf() !== key) throw invalidated();
                current.started = true;
            } }))).then(value => {
                if (revision !== version || keyOf() !== key || states().some(row => row?.recoveryRequired === true || row?.phase === 'unknown')) {
                    throw invalidated();
                }
                const receivedAt = Date.now();
                for (const [entryKey, entry] of values) if (entry.expiresAt <= receivedAt) values.delete(entryKey);
                if (values.size >= maxEntries) values.delete(values.keys().next().value);
                values.set(cacheKey, { value: clone(value), receivedAt, expiresAt: receivedAt + ttlMs });
                return { value, receivedAt };
            }).finally(() => {
                current.settled = true;
                if (flights.get(cacheKey) === current) flights.delete(cacheKey);
            });
            flights.set(cacheKey, current);
        }
        const current = flight;
        current.waiters++;
        return new Promise((resolve, reject) => {
            let finished = false;
            let timer;
            const onAbort = () => finish(ranchError('牧场读取等待已取消，已取得租约的事务会完成清理', 'REQUEST_CANCELLED'));
            function finish(error, result) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                context.signal?.removeEventListener('abort', onAbort);
                current.waiters--;
                if (!current.waiters && !current.started && !current.settled) {
                    if (flights.get(cacheKey) === current) flights.delete(cacheKey);
                    current.controller.abort();
                }
                if (error) reject(error);
                else resolve({ value: clone(result.value), receivedAt: result.receivedAt, hit: coalesced, coalesced });
            }
            context.signal?.addEventListener('abort', onAbort, { once: true });
            if (context.signal?.aborted) onAbort();
            if (Number.isFinite(context.deadline)) {
                timer = setTimeout(() => finish(ranchError('牧场读取等待期限已到，底层事务仍由租约结算', 'REQUEST_DEADLINE', {
                    sent: current.started, resultState: current.started ? 'failed' : 'not_sent',
                })), Math.max(0, context.deadline - Date.now()));
            }
            current.promise.then(result => finish(null, result), error => finish(error));
        });
    }
    const api = { read, invalidate, getRevision: () => revision };
    sceneReadCaches.add(api);
    return api;
}

const overviewCache = createSceneReadCache(CACHE_TTL_MS);

async function readAllCells(session) {
    const Request = types.RanchAllCellsRequest;
    const Reply = types.RanchAllCellsReply;
    if (!Request || !Reply) throw ranchError('牧场只读协议未加载', 'RANCH_PROTO_UNAVAILABLE');
    validateOperationSession(session);
    const body = Request.encode(Request.fromObject({})).finish();
    const response = await runSceneRequest(session,
        'gamepb.homesteadpb.HomesteadService', 'AllCells', body, { timeoutMs: 30000 });
    validateOperationSession(session, { ignoreCancellation: true });
    if (!response?.body?.length) throw ranchError('牧场格局响应为空', 'RANCH_RESPONSE_EMPTY', {
        sent: true, resultState: 'failed',
    });
    return Reply.decode(response.body);
}

async function getRanchOverview() {
    const accountId = String(network.getDiagnosticSnapshot?.()?.accountId || process.env.FARM_ACCOUNT_ID || '');
    const result = await overviewCache.read({
        keyOf: cacheKey,
        states: () => [getSceneSessionSnapshot(accountId), getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
        const cells = await readAllCells(session);
        const serverTimeMs = milliseconds(sceneReply?.server_time);
        const facilities = (cells.facilities || []).map(row => facilityDto(row, serverTimeMs || Date.now()));
        const ranches = facilities.filter(item => item.ranch).map(item => item.ranch);
        const receivedAt = Date.now();
        return {
            readOnly: true,
            actionsEnabled: true,
            sceneId: RANCH_SCENE_ID,
            observedAt: receivedAt,
            serverTimeMs,
            source: { repository: 'liyangpengs/qq-farm-bot', commit: SOURCE_COMMIT },
            grid: {
                width: integer(cells.grid_width),
                height: integer(cells.grid_height),
                cellCount: (cells.cells || []).length,
                openCellCount: (cells.cells || []).filter(cell => integer(cell.status) > 0).length,
                regionOccupied: integer(cells.region_occupied_count),
                regionQuota: integer(cells.region_quota_count),
            },
            summary: {
                facilityCount: facilities.length,
                ranchCount: ranches.length,
                animalCount: ranches.reduce((sum, ranch) => sum + ranch.animals.length, 0),
                harvestableCount: ranches.reduce((sum, ranch) => sum + ranch.animals.filter(animal => animal.canHarvest).length, 0),
                grassBlockedCount: ranches.reduce((sum, ranch) => sum + ranch.animals.filter(animal => animal.grassBlocked).length, 0),
            },
            facilities,
            cells: (cells.cells || []).map(row => ({ id: id(row.cell_id), x: integer(row.grid_x), y: integer(row.grid_y),
                status: integer(row.status), regionId: integer(row.region_id), occupiedBy: id(row.occupied_by),
                unlockEndAtMs: milliseconds(row.unlock_end_time) })),
            buildingItems: (cells.building_items || []).map(row => ({ id: id(row.inst_id), facilityId: integer(row.facility_id),
                level: integer(row.level), upgradeState: integer(row.upgrade_state), upgradeEndAtMs: milliseconds(row.upgrade_end_time),
                image: getRanchImage(row.facility_id, true)?.url || '' })),
            layoutActionsEnabled: false,
            cache: { hit: false, receivedAt },
        };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cache: { hit: result.hit, coalesced: result.coalesced === true, receivedAt: result.receivedAt } };
}

function clearRanchReadCache() {
    for (const cache of sceneReadCaches) cache.invalidate();
}

network.networkEvents?.on('ranchDataChanged', clearRanchReadCache);
network.networkEvents?.on('disconnect', clearRanchReadCache);

module.exports = {
    getRanchOverview,
    clearRanchReadCache,
    createSceneReadCache,
    animalDto,
    ranchDto,
    facilityDto,
    SOURCE_COMMIT,
};
