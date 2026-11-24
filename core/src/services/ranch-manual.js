'use strict';

const network = require('../utils/network');
const { types } = require('../utils/proto');
const { requestError } = require('../utils/request-priority');
const { validateOperationSession, runSceneRequest } = require('./account-operation-coordinator');
const { withGameScene, getSceneSessionSnapshot, RANCH_SCENE_ID } = require('./scene-session');
const { ranchOperations } = require('./ranch-operations-ledger');
const { clearRanchReadCache, createSceneReadCache } = require('./ranch-readonly');
const { getRanchGoods, getRanchItem, getRanchAnimal, getRanchAnimalByCubItem, getRanchCan, getRanchImage, ranchLevelInfo, getRanchFacility, isRanchSellableProduct } = require('./ranch-config');

const RANCH_SHOP_IDS = [5, 6];
const GRASS_ITEM_ID = 7001;
const BUCKET_BY_TYPE = { 1: 7004, 2: 7003 };
const SOURCE_COMMIT = '6ac7a3d7930018058d201af86beea8de6a9f8507';
const CATALOG_CACHE_MS = 5000;
const catalogCache = createSceneReadCache(CATALOG_CACHE_MS);
const bagCache = createSceneReadCache(3000);
const canCatalogCache = createSceneReadCache(CATALOG_CACHE_MS);
const FRIEND_ACTIONS = new Set(['steal', 'cleanFriend', 'stroke', 'putMosquito']);
const PROGRESSION_ACTIONS = new Set(['claimTasks', 'claimIllustrated', 'claimWeight', 'reportDailyShare', 'claimDailyShare']);

const ACTION_LABELS = {
    harvest: '收获牧场产物', produce: '催产', feed: '喂养动物', addGrass: '补充牧草',
    buy: '购买牧场商品', sell: '出售牧场产物', clean: '清理牧场',
    completeUpgrade: '完成牧场升级', release: '放生动物',
    place: '放养背包幼崽', useCan: '添加罐头入桶', buyCan: '购买牧场罐头', upgrade: '发起设施升级',
    exchange: '集市兑换',
    claimTasks: '普通领取牧场任务', claimIllustrated: '领取动物图鉴奖励', claimWeight: '领取巨大重量图鉴奖励',
    reportDailyShare: '上报已完成的牧场分享', claimDailyShare: '领取牧场每日首次分享礼包',
};

function assertAccountBinding(accountId) {
    const current = String(network.getDiagnosticSnapshot?.()?.accountId || process.env.FARM_ACCOUNT_ID || '');
    if (!current || current !== String(accountId)) throw manualError('请求与当前牧场账号不匹配，本次未发请求', 'ACCOUNT_OPERATION_CHANGED');
}

function manualError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'ranch_manual',
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

function bigText(value) {
    const text = value && typeof value === 'object' && typeof value.toString === 'function'
        ? value.toString() : String(value ?? '0');
    return /^\d+$/.test(text) ? text : '0';
}

function positiveId(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw manualError(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    return number;
}

function positiveCount(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > 2147483647) throw manualError(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    return number;
}

function positiveBigId(value, label) {
    const text = String(value ?? '').trim();
    if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) {
        throw manualError(`${label}无效`, 'RANCH_INVALID_ARGUMENT');
    }
    return text;
}

function signature(items) {
    return JSON.stringify((items || []).map(item => [bigText(item?.id), bigText(item?.count)]).sort());
}

function planSignature(plan, session) {
    return JSON.stringify({ identity: { accountId: String(session.accountId), gid: Number(session.gid),
        connectionEpoch: Number(session.connectionEpoch), remoteGeneration: session.remoteGeneration,
        worker: session.workerInstanceId, source: session.remoteGenerationSource || 'unknown' },
    action: plan.action, payload: plan.payload, costs: plan.costItems, rewards: plan.expectedRewards,
    marker: plan.marker, count: plan.count, resultKeys: plan.resultKeys || [] });
}

function bagItems(bag) {
    return [...(bag?.physical_items || []), ...(bag?.virtual_items || [])];
}

function balance(bag, id) {
    const entries = bagItems(bag).filter(item => bigText(item?.id) === String(id));
    const total = entries.reduce((sum, item) => sum + BigInt(bigText(item?.count)), 0n);
    const locked = entries.filter(item => item?.is_locked === true)
        .reduce((sum, item) => sum + BigInt(bigText(item?.count)), 0n);
    return { total, locked, available: total - locked };
}

function setBalance(bag, itemId, nextCount) {
    const id = String(itemId);
    const entries = bagItems(bag).filter(item => bigText(item?.id) === id);
    if (entries.length) {
        entries[0].count = String(nextCount < 0n ? 0n : nextCount);
        for (const duplicate of entries.slice(1)) duplicate.count = '0';
        return;
    }
    (bag.virtual_items || (bag.virtual_items = [])).push({ id, count: String(nextCount < 0n ? 0n : nextCount) });
}

function applyItemDelta(bag, itemId, delta) {
    setBalance(bag, itemId, balance(bag, itemId).total + BigInt(delta));
}

function patchRanches(raw, ranches) {
    for (const ranch of ranches || []) {
        const facility = (raw.cells.facilities || []).find(row => Number(row.instance_id) === Number(ranch.ranch_inst_id));
        if (facility) facility.ranch = ranch;
    }
}

function patchRawAfterReply(raw, action, reply, plan) {
    patchRanches(raw, reply.ranches);
    if (action === 'feed') setBalance(raw.bag, plan.costItems[0].id, BigInt(bigText(reply.bucket_remain_secs)));
    if (action === 'addGrass') {
        const facility = (raw.cells.facilities || []).find(row => Number(row.instance_id) === plan.marker.facilityId);
        if (facility) facility.feed_machine = reply.detail;
        for (const cost of plan.costItems) applyItemDelta(raw.bag, cost.id, -BigInt(cost.count));
    }
    if (action === 'sell') {
        for (const item of reply.sell_items || []) {
            const found = (raw.bag.physical_items || []).find(row => bigText(row.uid) === bigText(item.uid));
            if (found) found.count = String(BigInt(bigText(found.count)) - BigInt(bigText(item.count)));
        }
        for (const item of reply.get_items || []) applyItemDelta(raw.bag, bigText(item.id), BigInt(bigText(item.count)));
    }
    if (action === 'completeUpgrade' && reply.facility) {
        const index = (raw.cells.facilities || []).findIndex(row => Number(row.instance_id) === Number(reply.facility.instance_id));
        if (index >= 0) raw.cells.facilities[index] = reply.facility;
    }
    return raw;
}

async function sceneRpc(session, service, method, Request, Reply, input, options = {}) {
    if (!Request || !Reply) throw manualError('牧场协议未加载', 'RANCH_PROTO_UNAVAILABLE');
    validateOperationSession(session);
    const body = Request.encode(Request.fromObject(input || {})).finish();
    const response = await runSceneRequest(session, service, method, body, {
        timeoutMs: options.timeoutMs || 30000,
        lifecycle: options.read ? undefined : options.lifecycle,
        assertCanSend: options.assertCanSend,
    });
    validateOperationSession(session, { ignoreCancellation: true });
    if (!response?.body?.length) {
        // A settled CheckCanShare reply may encode false as an empty proto3 body.
        // This exception is read-only and exact; an empty write reply remains unknown.
        if (options.read && service === 'gamepb.sharepb.ShareService' && method === 'CheckCanShare'
            && response?.body != null) return Reply.decode(response.body);
        throw manualError('牧场响应为空', 'RANCH_RESPONSE_EMPTY', {
            sent: true, resultState: options.read ? 'failed' : 'unknown', outcomeUnknown: !options.read,
        });
    }
    return Reply.decode(response.body);
}

async function loadSceneState(session) {
    const AllCells = types.RanchAllCellsRequest;
    const AllCellsReply = types.RanchAllCellsReply;
    const BagRequest = types.RanchGetBagRequest;
    const BagReply = types.RanchGetBagReply;
    if (!AllCells || !AllCellsReply || !BagRequest || !BagReply) {
        throw manualError('牧场协议未加载', 'RANCH_PROTO_UNAVAILABLE');
    }
    // 两个精确安全读同属当前 scene2，互不依赖；并行可减少每次报价/执行的驻留时间。
    const [cellsReply, bag] = await Promise.all([
        sceneRpc(session, 'gamepb.homesteadpb.HomesteadService', 'AllCells',
            AllCells, AllCellsReply, {}, { read: true }),
        sceneRpc(session, 'gamepb.itempb.ItemService', 'GetBag',
            BagRequest, BagReply, { global_scene_id: RANCH_SCENE_ID }, { read: true }),
    ]);
    if (Number(bag.global_scene_id) !== RANCH_SCENE_ID) {
        throw manualError('牧场背包场景不匹配', 'RANCH_RESPONSE_MISMATCH', {
            sent: true, resultState: 'unknown', outcomeUnknown: true,
        });
    }
    return { cells: cellsReply, bag };
}

async function loadRanchDetail(session) {
    return sceneRpc(session, 'gamepb.animalpb.AnimalService', 'GetRanchDetail',
        types.RanchGetRanchDetailRequest, types.RanchGetRanchDetailReply, {}, { read: true });
}

function mergeRanchDetails(raw, detail) {
    patchRanches(raw, detail?.ranches || []);
    raw.serverIntervalSec = integer(detail?.interval);
    return raw;
}

function ranchesOf(cells) {
    return (cells.facilities || [])
        .filter(facility => facility?.ranch)
        .map(facility => ({ facility, ranch: facility.ranch }));
}

function sellCandidates(bag) {
    return (bag.physical_items || []).filter(item => {
        if (item?.is_locked === true || Number(item?.id) === GRASS_ITEM_ID) return false;
        const sells = item?.show?.sells || [];
        const conds = item?.show?.sell_cond || [];
        return sells.length > 0 && conds.length === 0 && isRanchSellableProduct(Number(item.id));
    });
}

async function shopGoods(session, shopId) {
    if (!RANCH_SHOP_IDS.includes(Number(shopId))) {
        throw manualError('不支持的牧场商店', 'RANCH_INVALID_ARGUMENT');
    }
    const reply = await sceneRpc(session, 'gamepb.shoppb.ShopService', 'ShopInfo',
        types.ShopInfoRequest, types.ShopInfoReply, { shop_id: Number(shopId) }, { read: true });
    return (reply.goods_list || []).map(good => {
        const config = getRanchGoods(integer(good.id));
        const valid = !!config && Number(config.shop_id) === Number(shopId)
            && Number(config.item_id) === integer(good.item_id)
            && Number(config.item_count) === integer(good.item_count)
            && Number(config.price_count) === integer(good.price);
        return {
            id: integer(good.id),
            itemId: integer(good.item_id),
            itemCount: integer(good.item_count),
            currencyId: valid ? Number(config.price_id) : 0,
            maxCount: valid ? Number(config.one_buy_count) || 1 : 0,
            valid,
            price: integer(good.price),
            discountPrice: integer(good.discount_price),
            discounted: Number(good.discount_start_time) > 0 && Number(good.discount_start_time) <= Math.floor(Date.now() / 1000)
                && Math.floor(Date.now() / 1000) < Number(good.discount_end_time),
            unlocked: good.unlocked === true,
            owned: good.owned === true,
            limitCount: integer(good.limit_count),
            boughtNum: integer(good.bought_num),
            remaining: Number(good.limit_count) > 0 ? Math.max(0, Number(good.limit_count) - Number(good.bought_num)) : null,
        };
    });
}

function ranchStateKey(accountId, view, focus = '') {
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const gid = Number(network.getUserState?.()?.gid) || 0;
    if (String(diagnostic.accountId || '') !== String(accountId) || !Number.isSafeInteger(gid) || gid <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(Number(diagnostic.connectionEpoch)) || Number(diagnostic.connectionEpoch) < 0
        || diagnostic.connected !== true || diagnostic.loggedIn !== true) return '';
    return JSON.stringify([String(accountId), gid, String(view), String(focus), Number(diagnostic.connectionEpoch),
        diagnostic.remoteGeneration == null ? null : String(diagnostic.remoteGeneration),
        String(diagnostic.remoteGenerationSource || 'unknown')]);
}

function catalogKey(accountId, shopId) {
    return ranchStateKey(accountId, 'shop', shopId);
}

function clearRanchCatalogCache() {
    catalogCache.invalidate();
}

async function getRanchCatalog(accountId, shopId) {
    shopId = Number(shopId);
    if (!RANCH_SHOP_IDS.includes(shopId)) throw manualError('不支持的牧场商店', 'RANCH_INVALID_ARGUMENT');
    const result = await catalogCache.read({
        keyOf: () => catalogKey(accountId, shopId),
        states: () => [getSceneSessionSnapshot(accountId), require('./ranch-friend-session').getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, async ({ session }) => {
        const [raw, goods] = await Promise.all([loadSceneState(session), shopGoods(session, shopId)]);
        const rows = goods.map(good => {
            const funds = good.currencyId ? balance(raw.bag, good.currencyId) : { total: 0n, locked: 0n, available: 0n };
            const reserved = good.currencyId ? ranchOperations.reserved(accountId, `item:${good.currencyId}`) : 0n;
            const unitPrice = good.discounted && good.discountPrice > 0 ? good.discountPrice : good.price;
            return {
                ...good,
                name: getRanchItem(good.itemId)?.name || `物品 #${good.itemId}`,
                image: getRanchImage(good.itemId)?.url || '',
                unitPrice,
                currencyBalance: (funds.available - reserved).toString(),
                available: good.valid && good.unlocked && !good.owned && unitPrice > 0
                    && (good.remaining === null || good.remaining > 0),
            };
        });
        return { shopId, readOnly: true, receivedAt: Date.now(), goods: rows, cacheHit: false };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cacheHit: result.hit, coalesced: result.coalesced === true };
}

async function readSceneBag(session) {
    const bag = await sceneRpc(session, 'gamepb.itempb.ItemService', 'GetBag',
        types.RanchGetBagRequest, types.RanchGetBagReply, { global_scene_id: RANCH_SCENE_ID }, { read: true });
    if (Number(bag.global_scene_id) !== RANCH_SCENE_ID) throw manualError('牧场背包场景未确认', 'RANCH_RESPONSE_MISMATCH');
    return bag;
}

async function loadActionState(session, action, sceneReply) {
    if (action === 'exchange') return require('./ranch-market').loadMarketActionState(session, sceneReply);
    if (PROGRESSION_ACTIONS.has(action)) return require('./ranch-progression').loadProgressActionState(session, action, sceneReply);
    if (['useCan', 'buyCan', 'sell'].includes(action)) return { bag: await readSceneBag(session), cells: { facilities: [] } };
    return loadSceneState(session);
}

function physicalBalance(bag, itemId, uid) {
    const rows = (bag.physical_items || []).filter(item => bigText(item.id) === String(itemId)
        && (uid === undefined || bigText(item.uid) === String(uid)));
    const total = rows.reduce((sum, item) => sum + BigInt(bigText(item.count)), 0n);
    const locked = rows.filter(item => item.is_locked === true).reduce((sum, item) => sum + BigInt(bigText(item.count)), 0n);
    return { total, locked, available: total - locked };
}

function rawRanchLevel(raw) {
    const rows = bagItems(raw.bag).filter(item => bigText(item.id) === '1102');
    if (!rows.length || rows.some(item => !/^\d+$/.test(String(item.count ?? '')))) return null;
    return ranchLevelInfo(rows.reduce((sum, item) => sum + BigInt(bigText(item.count)), 0n).toString());
}

function ranchPens(raw) {
    return ranchesOf(raw.cells).filter(({ facility, ranch }) => facility.state === 1 && Number(facility.upgrade_state) === 0
        && [1, 2].includes(Number(ranch.husbandry_type)))
        .map(({ ranch }) => ({ id: bigText(ranch.ranch_inst_id), husbandryType: Number(ranch.husbandry_type),
            name: Number(ranch.husbandry_type) === 1 ? '动物窝' : '动物棚', capacity: Number(ranch.capacity),
            animalCount: Math.max(Number(ranch.animal_count), (ranch.animals || []).length),
            room: Math.max(0, Number(ranch.capacity) - Math.max(Number(ranch.animal_count), (ranch.animals || []).length)) }));
}

function inventoryDto(raw) {
    return (raw.bag.physical_items || []).map(item => {
        const itemId = Number(item.id);
        const can = getRanchCan(itemId);
        const animal = getRanchAnimalByCubItem(itemId);
        const count = BigInt(bigText(item.count));
        const reserved = ranchOperations.reserved(raw.sessionAccountId, `item:${itemId}`);
        const available = item.is_locked === true ? 0n : count > reserved ? count - reserved : 0n;
        const stock = physicalBalance(raw.bag, itemId).available - reserved;
        return { id: bigText(item.id), uid: bigText(item.uid), count: count.toString(),
            availableCount: available.toString(), availableTypeCount: (stock > 0n ? stock : 0n).toString(),
            name: getRanchItem(itemId)?.name || `物品 #${itemId}`, image: getRanchImage(itemId)?.url || '',
            type: Number(getRanchItem(itemId)?.type) || 0,
            locked: item.is_locked === true,
            category: can ? 'can' : animal ? 'cub' : isRanchSellableProduct(itemId) ? 'product' : itemId === GRASS_ITEM_ID ? 'grass' : 'other',
            can: can ? { bucketId: can.bucketId, seconds: Number(can.speed_up_secs),
                family: can.bucketId === 7004 ? '有机罐头' : '普通罐头' } : null,
            animal: animal ? { id: Number(animal.id), husbandryType: animal.husbandry_type === '窝' ? 1 : 2,
                giantCub: Number(animal.giantCubItemId) > 0 } : null,
            canUseCan: !!can?.bucketId && available > 0n && bigText(item.uid) !== '0',
            canPlace: !!animal && animal.enable_flag === true && stock > 0n,
            product: item.item_detail?.ranch_product ? { weightX10: Number(item.item_detail.ranch_product.weight_x10),
                tier: Number(item.item_detail.ranch_product.tier) } : null,
        };
    });
}

async function getRanchBag(accountId) {
    const result = await bagCache.read({
        keyOf: () => ranchStateKey(accountId, 'bag'),
        states: () => [getSceneSessionSnapshot(accountId), require('./ranch-friend-session').getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, async ({ session }) => {
            const raw = { ...await loadSceneState(session), session, sessionAccountId: accountId };
            return { readOnly: true, sceneId: RANCH_SCENE_ID, receivedAt: Date.now(), level: rawRanchLevel(raw),
                items: inventoryDto(raw), pens: ranchPens(raw),
                goldVoucherBalance: balance(raw.bag, 1007).total.toString(),
                buckets: { normal: balance(raw.bag, 7003).total.toString(),
                    organic: balance(raw.bag, 7004).total.toString() } };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cacheHit: result.hit };
}

async function resourceBalance(raw, currencyId) {
    if (Number(currencyId) === 1004) {
        if (!raw.diamondBalance) {
            const reply = await sceneRpc(raw.session, 'gamepb.paypb.PayService', 'GetRechargeInfo',
                types.GetRechargeInfoRequest, types.GetRechargeInfoReply, { source: 'MallUI' }, { read: true });
            if ((reply.recharge_infos || []).length !== 1) throw manualError('钻石专用余额未完整返回', 'RANCH_BALANCE_UNKNOWN');
            raw.diamondBalance = { total: BigInt(bigText(reply.recharge_infos[0].balance)), locked: 0n,
                available: BigInt(bigText(reply.recharge_infos[0].balance)) };
        }
        return raw.diamondBalance;
    }
    if (![1001, 1002, 1005, 1007, 1008].includes(Number(currencyId))) throw manualError('该购买币种尚未核验', 'RANCH_PRICE_UNKNOWN');
    return balance(raw.bag, currencyId);
}

async function canGoods(session, raw, slotType) {
    if (![6, 7].includes(Number(slotType))) throw manualError('罐头商城入口无效', 'RANCH_INVALID_ARGUMENT');
    const list = await sceneRpc(session, 'gamepb.mallpb.MallService', 'GetMallListBySlotType',
        types.GetMallListBySlotTypeRequest, types.GetMallListBySlotTypeResponse,
        { slot_type: Number(slotType), is_manual_open: true, global_scene_id: RANCH_SCENE_ID }, { read: true });
    const rows = [];
    const now = Math.floor(Date.now() / 1000);
    for (const good of list.goods_list || []) {
        const rewards = (good.reward_items || []).map(item => ({ id: bigText(item.id), count: bigText(item.count), name: getRanchItem(item.id)?.name }));
        if (!rewards.length || rewards.some(item => !getRanchCan(item.id) || BigInt(item.count) <= 0n)) continue;
        const promoted = Number(good.discount_price) > 0 && Number(good.promotion_start_time) > 0
            && Number(good.promotion_start_time) <= now && now < Number(good.promotion_end_time);
        const unitPrice = promoted ? bigText(good.discount_price) : bigText(good.price?.count);
        const currencyId = Number(good.price?.id) || 0;
        const free = good.is_free === true && BigInt(unitPrice) === 0n;
        const limitType = Number(good.purchase_limit?.limit_type) || 0;
        const limit = Number(good.purchase_limit?.limit_count) || 0;
        const bought = Number(good.purchase_limit?.bought_count) || 0;
        const knownLimit = limitType === 0 || [1, 2, 3, 4].includes(limitType)
            && Number.isSafeInteger(limit) && Number.isSafeInteger(bought) && limit >= 0 && bought >= 0;
        const remaining = limitType > 0 ? knownLimit ? Math.max(0, limit - bought) : 0 : null;
        const accessible = good.is_available === true && good.is_owned !== true && good.ad_only !== true
            && !(good.share?.share_only === true && Number(good.share.share_status) !== 2)
            && knownLimit && (remaining === null || remaining > 0)
            && (!promoted || Number(good.promotion_end_time) - now >= 5);
        let funds = null;
        const knownCurrency = [1001, 1002, 1004, 1005, 1007, 1008].includes(currencyId);
        let knownPrice = free ? currencyId === 0 || knownCurrency : knownCurrency && BigInt(unitPrice) > 0n;
        if (accessible && knownPrice && !free) {
            try { funds = await resourceBalance(raw, currencyId); }
            catch (error) {
                if (!['RANCH_PRICE_UNKNOWN', 'RANCH_BALANCE_UNKNOWN'].includes(error?.errorCode)) throw error;
                knownPrice = false;
            }
        }
        const reserved = !free && currencyId ? ranchOperations.reserved(raw.sessionAccountId, `item:${currencyId}`) : 0n;
        const availableFunds = funds ? (funds.available > reserved ? funds.available - reserved : 0n) : null;
        const inStock = free || availableFunds !== null && BigInt(unitPrice) <= availableFunds;
        rows.push({ id: bigText(good.goods_id), name: String(good.name || '罐头商品'), rewards,
            currencyId, unitPrice, free, remaining, limitType, maxCount: free ? 1 : Math.min(999, remaining ?? 999),
            currencyBalance: availableFunds?.toString() ?? null,
            available: accessible && knownPrice && inStock,
            stateReason: !accessible ? remaining === 0 ? '本轮购买次数已用完' : '服务端购买资格尚未确认'
                : !knownPrice ? '价格或专用余额未确认' : !inStock ? '可用余额不足' : '',
        });
    }
    return rows;
}

async function getRanchCanCatalog(accountId, slotType) {
    if (![6, 7].includes(Number(slotType))) throw manualError('罐头商城入口无效', 'RANCH_INVALID_ARGUMENT');
    const result = await canCatalogCache.read({
        keyOf: () => ranchStateKey(accountId, 'cans', slotType),
        states: () => [getSceneSessionSnapshot(accountId), require('./ranch-friend-session').getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(RANCH_SCENE_ID, async ({ session }) => {
            const raw = { bag: await readSceneBag(session), session, sessionAccountId: accountId };
            const goods = await canGoods(session, raw, slotType);
            return { readOnly: true, sceneId: RANCH_SCENE_ID, slotType: Number(slotType), goods, receivedAt: Date.now() };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cacheHit: result.hit };
}

function planBase(action) {
    return { action, label: ACTION_LABELS[action] || action, payload: {}, costItems: [], expectedRewards: [], count: 1 };
}

async function planAction(action, input, raw) {
    if (action === 'exchange') return require('./ranch-market').planExchange(input, raw);
    if (PROGRESSION_ACTIONS.has(action)) return require('./ranch-progression').planProgressAction(action, input, raw);
    const plan = planBase(action);
    if (action === 'harvest') {
        const all = input.all === true;
        const animals = [];
        const shelves = [];
        for (const { facility, ranch } of ranchesOf(raw.cells)) {
            for (const animal of ranch.animals || []) {
                if (animal.can_harvest) animals.push({ ranch_inst_id: Number(ranch.ranch_inst_id), animal_inst_id: Number(animal.animal_inst_id) });
            }
            for (const shelf of ranch.shelves || []) {
                if (all && shelf.can_collect) shelves.push({ ranch_inst_id: Number(ranch.ranch_inst_id), slot_index: Number(shelf.slot_index) });
            }
        }
        if (!all && !input.animalId) throw manualError('请选择要收获的动物或使用一键收获', 'RANCH_INVALID_ARGUMENT');
        const targets = all ? [] : animals.filter(row => row.animal_inst_id === positiveId(input.animalId, '动物实例')
            && row.ranch_inst_id === positiveId(input.ranchId, '栏舍实例'));
        if (all && !animals.length && !shelves.length) { plan.count = 0; return plan; }
        if (!all && !targets.length) { plan.count = 0; return plan; }
        plan.payload = all ? { op: 1 } : { op: 4, animals: targets };
        plan.marker = { animals: all ? animals : targets, shelves };
        plan.resultKeys = [...(all ? animals : targets).map(row => `${row.ranch_inst_id}:1:${row.animal_inst_id}`),
            ...shelves.map(row => `${row.ranch_inst_id}:2:${row.slot_index}`)];
        plan.count = (all ? animals.length : targets.length) + shelves.length;
        return plan;
    }
    if (action === 'produce') {
        const animals = [];
        for (const { ranch } of ranchesOf(raw.cells)) {
            for (const animal of ranch.animals || []) {
                if (animal.can_deliver) animals.push({ ranch_inst_id: Number(ranch.ranch_inst_id), animal_inst_id: Number(animal.animal_inst_id) });
            }
        }
        if (input.all !== true && !input.animalId) throw manualError('请选择要催产的动物或使用一键催产', 'RANCH_INVALID_ARGUMENT');
        const targets = input.all === true ? []
            : animals.filter(row => row.animal_inst_id === positiveId(input.animalId, '动物实例')
                && row.ranch_inst_id === positiveId(input.ranchId, '栏舍实例'));
        if (input.all !== true && !targets.length) { plan.count = 0; return plan; }
        if (input.all === true && !animals.length) { plan.count = 0; return plan; }
        plan.payload = { targets };
        plan.marker = { animals: input.all === true ? animals : targets };
        plan.resultKeys = (input.all === true ? animals : targets).map(row => `${row.ranch_inst_id}:1:${row.animal_inst_id}`);
        plan.count = input.all === true ? animals.length : targets.length;
        return plan;
    }
    if (action === 'feed') {
        if (input.all !== true) throw manualError('当前喂养须明确选择一键喂养，不忽略目标参数', 'RANCH_INVALID_ARGUMENT');
        const bucketType = Number(input.bucketType);
        if (![1, 2].includes(bucketType)) throw manualError('请选择有机或普通罐头', 'RANCH_INVALID_ARGUMENT');
        const bucketId = BUCKET_BY_TYPE[bucketType];
        const targets = [];
        const beforeAnimals = [];
        let maxSeconds = 0n;
        const nowSec = Math.floor(Date.now() / 1000);
        for (const { ranch } of ranchesOf(raw.cells)) {
            for (const animal of ranch.animals || []) {
                if (!animal.can_feed || (bucketType === 2 && animal.limited_can_used === true)) continue;
                const config = getRanchAnimal(animal.animal_id);
                if (!config) throw manualError('动物阶段配置未同步，无法确认罐头上限', 'RANCH_CONFIG_UNKNOWN');
                const stage = Number(animal.stage);
                const durations = [0, config.infant_sec, config.grow_sec, config.product_round_sec, config.mature_sec].map(Number);
                const deadlines = [0, animal.infant_ready_at_ms, animal.grow_ready_at_ms, animal.produce_ready_at_ms, animal.mature_ready_at_ms].map(Number);
                const remaining = Math.max(0, Math.ceil((deadlines[stage] || 0) / 1000) - nowSec);
                const upperBound = Math.max(durations[stage] || 0, Math.ceil(remaining / 3600) * 3600);
                if (!upperBound) throw manualError('动物当前阶段罐头消耗无法确认', 'RANCH_PRICE_UNKNOWN');
                maxSeconds += BigInt(upperBound);
                targets.push({ ranch_inst_id: Number(ranch.ranch_inst_id), animal_inst_id: Number(animal.animal_inst_id) });
                beforeAnimals.push({ ranchId: Number(ranch.ranch_inst_id), instanceId: Number(animal.animal_inst_id),
                    animalId: bigText(animal.animal_id), stage,
                    limitedCanUsed: animal.limited_can_used === true,
                    deadlines: [animal.infant_ready_at_ms, animal.grow_ready_at_ms, animal.produce_ready_at_ms, animal.mature_ready_at_ms].map(bigText) });
            }
        }
        if (!targets.length) { plan.count = 0; return plan; }
        const available = balance(raw.bag, bucketId);
        if (available.total <= 0n) throw manualError('罐头桶为空，请先添加罐头', 'RANCH_BUCKET_EMPTY');
        const funds = available.available - ranchOperations.reserved(raw.sessionAccountId, `item:${bucketId}`);
        if (funds <= 0n) throw manualError('扣除待核对操作预留后罐头余额不足', 'RESERVE_PROTECTED');
        const quoted = funds < maxSeconds ? funds : maxSeconds;
        plan.payload = { targets, bucket_type: bucketType };
        plan.costItems = [{ id: bucketId, count: quoted.toString() }];
        plan.marker = { animals: targets, beforeAnimals, bucketType, bucketRemain: available.total.toString() };
        plan.resultKeys = targets.map(row => `${row.ranch_inst_id}:1:${row.animal_inst_id}`);
        plan.count = targets.length;
        return plan;
    }
    if (action === 'addGrass') {
        const facilityId = positiveId(input.facilityId, '牧草机实例');
        const facility = (raw.cells.facilities || []).find(row => Number(row.instance_id) === facilityId);
        if (!facility?.feed_machine) throw manualError('牧草机不存在', 'RANCH_FACILITY_NOT_FOUND');
        const room = Number(facility.capacity) - Number(facility.feed_machine.feed_count);
        if (room <= 0) { plan.count = 0; return plan; }
        const grass = balance(raw.bag, GRASS_ITEM_ID);
        const funds = grass.available - ranchOperations.reserved(raw.sessionAccountId, `item:${GRASS_ITEM_ID}`);
        const count = Math.min(room, Number(funds));
        if (count <= 0) throw manualError('牧草库存不足（已扣除待核对预留）', 'INSUFFICIENT_BALANCE');
        plan.payload = { instance_id: facilityId, add_count: count, use_gold: false };
        plan.costItems = [{ id: GRASS_ITEM_ID, count: count.toString() }];
        plan.marker = { facilityId, feedCount: Number(facility.feed_machine.feed_count), capacity: Number(facility.capacity) };
        plan.count = count;
        return plan;
    }
    if (action === 'place') {
        const ranchId = positiveId(input.ranchId, '栏舍实例');
        const itemId = positiveId(input.itemId, '幼崽物品');
        const count = positiveCount(input.count, '放养数量');
        const animal = getRanchAnimalByCubItem(itemId);
        const pen = ranchPens(raw).find(row => Number(row.id) === ranchId);
        if (!animal || animal.enable_flag !== true || !pen
            || pen.husbandryType !== (animal.husbandry_type === '窝' ? 1 : 2)) {
            throw manualError('幼崽与所选栏舍类型不匹配或配置未确认', 'RANCH_ANIMAL_MISMATCH');
        }
        if (count > pen.room || count > 999) throw manualError('所选栏舍空位或单次上限不足', 'RANCH_FULL');
        const funds = physicalBalance(raw.bag, itemId);
        if (funds.available - ranchOperations.reserved(raw.sessionAccountId, `item:${itemId}`) < BigInt(count)) {
            throw manualError('同类型未锁定幼崽库存不足', 'INSUFFICIENT_BALANCE');
        }
        const ranch = ranchesOf(raw.cells).find(row => Number(row.ranch.ranch_inst_id) === ranchId).ranch;
        plan.payload = { items: Array.from({ length: count }, () => ({ ranch_inst_id: ranchId,
            animal_id: Number(animal.id), giant_cub_item_id: Number(animal.giantCubItemId) || 0 })) };
        plan.costItems = [{ id: String(itemId), count: String(count) }];
        plan.marker = { ranchId, itemId, animalId: Number(animal.id), giantCubItemId: Number(animal.giantCubItemId) || 0,
            beforeAnimals: (ranch.animals || []).map(row => Number(row.animal_inst_id)),
            capacity: pen.capacity, occupied: pen.animalCount };
        plan.count = count;
        plan.label = `向${pen.name} ${pen.id} 放养${getRanchItem(itemId)?.name || animal.name} ×${count}`;
        plan.message = '服务端按同类型库存分配幼崽；不会承诺消耗指定批次。';
        return plan;
    }
    if (action === 'useCan') {
        const uid = positiveBigId(input.uid, '罐头批次');
        const count = positiveCount(input.count, '罐头数量');
        const item = (raw.bag.physical_items || []).find(row => bigText(row.uid) === uid);
        const can = item ? getRanchCan(item.id) : null;
        if (!item || !can?.bucketId || item.is_locked === true || BigInt(bigText(item.count)) < BigInt(count)) {
            throw manualError('罐头批次不存在、已锁定或库存不足', 'RANCH_CAN_UNAVAILABLE');
        }
        if (physicalBalance(raw.bag, Number(item.id)).available - ranchOperations.reserved(raw.sessionAccountId, `item:${Number(item.id)}`) < BigInt(count)) {
            throw manualError('罐头已被待核对操作预留', 'RESERVE_PROTECTED');
        }
        plan.payload = { item: { id: bigText(item.id), uid, count } };
        plan.costItems = [{ id: bigText(item.id), count: String(count) }];
        plan.marker = { uid, itemId: bigText(item.id), bucketId: can.bucketId, seconds: Number(can.speed_up_secs),
            bucketBefore: balance(raw.bag, can.bucketId).total.toString(), batchBefore: bigText(item.count) };
        plan.count = count;
        plan.label = `添加${getRanchItem(item.id)?.name || '罐头'} ×${count}`;
        plan.message = `预期加入${can.bucketId === 7004 ? '有机' : '普通'}罐头桶 ${BigInt(can.speed_up_secs) * BigInt(count)} 秒；入桶不等于喂养。`;
        return plan;
    }
    if (action === 'buyCan') {
        const slotType = Number(input.slotType ?? 6);
        const goodsId = positiveBigId(input.goodsId, '罐头商品');
        const count = positiveCount(input.count, '购买份数');
        const goods = await canGoods(sessionOf(raw), raw, slotType);
        const good = goods.find(row => row.id === goodsId);
        if (!good?.available) throw manualError(good?.stateReason || '商品资格或配置未确认', 'GOODS_UNAVAILABLE');
        if (count > good.maxCount || good.remaining !== null && count > good.remaining) {
            throw manualError('份数超过本地单次或服务端限购上限', 'PURCHASE_LIMIT_EXCEEDED');
        }
        const cost = BigInt(good.unitPrice) * BigInt(count);
        if (!good.free && BigInt(good.currencyBalance) < cost) throw manualError('购买货币不足（已扣除预留）', 'INSUFFICIENT_BALANCE');
        plan.payload = { goods_id: goodsId, count };
        plan.costItems = good.free ? [] : [{ id: String(good.currencyId), count: cost.toString() }];
        plan.expectedRewards = good.rewards.map(item => ({ id: item.id, count: (BigInt(item.count) * BigInt(count)).toString() }));
        plan.marker = { slotType, remaining: good.remaining, free: good.free, currencyId: good.currencyId,
            currencyBefore: good.currencyId ? (await resourceBalance(raw, good.currencyId)).total.toString() : null,
            stockBefore: plan.expectedRewards.map(item => ({ id: item.id, count: physicalBalance(raw.bag, item.id).total.toString() })) };
        plan.count = count;
        plan.label = `${good.free ? '领取' : '购买'}${good.name} ×${count} 份`;
        return plan;
    }
    if (action === 'buy') {
        const shopId = Number(input.shopId);
        const goodsId = positiveId(input.goodsId, '商品编号');
        const count = positiveCount(input.count, '购买数量');
        const goods = await shopGoods(sessionOf(raw), shopId);
        const good = goods.find(row => row.id === goodsId);
        if (!good?.valid || !good.unlocked || good.owned || !good.currencyId) {
            throw manualError('商品未解锁、已拥有或配置未确认', 'GOODS_UNAVAILABLE');
        }
        if (count > good.maxCount || (good.remaining !== null && count > good.remaining)) {
            throw manualError('数量超过单次或限购剩余', 'PURCHASE_LIMIT_EXCEEDED');
        }
        const unitPrice = good.discounted && good.discountPrice > 0 ? good.discountPrice : good.price;
        if (unitPrice <= 0) throw manualError('商品价格未确认', 'RANCH_PRICE_UNKNOWN');
        const funds = balance(raw.bag, good.currencyId);
        const cost = BigInt(unitPrice) * BigInt(count);
        const available = funds.available - ranchOperations.reserved(raw.sessionAccountId, `item:${good.currencyId}`);
        if (available < cost) throw manualError('购买货币不足（已扣除待核对预留）', 'INSUFFICIENT_BALANCE');
        const animal = getRanchAnimalByCubItem(good.itemId);
        const autoAdd = input.autoPlace === true;
        if (autoAdd && (!animal || animal.enable_flag !== true || Number(animal.giantCubItemId) > 0
            || !['窝', '棚'].includes(animal.husbandry_type) || Number(good.itemCount) !== 1)) {
            throw manualError('该商品不是已核实的普通单只幼崽，不能自动放养', 'RANCH_CONFIG_UNKNOWN');
        }
        if (autoAdd) {
            const kind = animal.husbandry_type === '窝' ? 1 : 2;
            const room = ranchPens(raw).filter(pen => pen.husbandryType === kind)
                .reduce((sum, pen) => sum + Math.max(0, pen.room), 0);
            if (room < count) throw manualError('窝或棚空位不足', 'RANCH_FULL');
        }
        plan.payload = { goods_id: goodsId, num: count, price: unitPrice, auto_add: autoAdd };
        plan.costItems = [{ id: good.currencyId, count: cost.toString() }];
        plan.expectedRewards = [{ id: String(good.itemId), count: (BigInt(good.itemCount) * BigInt(count)).toString() }];
        plan.marker = {
            shopId, goodsId, unitPrice, currencyId: good.currencyId,
            itemId: good.itemId, itemCount: good.itemCount,
            animalId: animal?.id || null,
            beforeAnimals: ranchesOf(raw.cells).flatMap(({ ranch }) => (ranch.animals || [])
                .map(row => `${Number(ranch.ranch_inst_id)}:${Number(row.animal_inst_id)}`)),
        };
        plan.label = `购买${getRanchItem(good.itemId)?.name || `物品 #${good.itemId}`} ×${count}`;
        return plan;
    }
    if (action === 'sell') {
        if (input.all !== true) throw manualError('二期只支持一键出售牧场产物', 'RANCH_INVALID_ARGUMENT');
        const candidates = sellCandidates(raw.bag);
        if (!candidates.length) { plan.count = 0; return plan; }
        plan.payload = { items: candidates.map(item => ({ id: bigText(item.id), uid: bigText(item.uid), count: bigText(item.count) })) };
        plan.costItems = candidates.map(item => ({ id: bigText(item.id), count: bigText(item.count) }));
        const rewards = new Map();
        for (const item of candidates) {
            for (const price of item.show?.sells || []) {
                const id = bigText(price.id);
                rewards.set(id, (rewards.get(id) || 0n) + BigInt(bigText(price.count)) * BigInt(bigText(item.count)));
            }
        }
        plan.expectedRewards = [...rewards.entries()].map(([id, count]) => ({ id, count: count.toString() }));
        plan.marker = { items: plan.payload.items.map(entry => `${entry.id}:${entry.count}`) };
        plan.count = candidates.length;
        return plan;
    }
    if (action === 'clean') {
        const ranchIds = ranchesOf(raw.cells)
            .filter(({ ranch }) => (ranch.hazards || []).length > 0)
            .map(({ ranch }) => Number(ranch.ranch_inst_id));
        if (!ranchIds.length) { plan.count = 0; return plan; }
        plan.payload = { ranch_inst_ids: ranchIds };
        plan.marker = { ranchIds };
        plan.resultKeys = ranchesOf(raw.cells).flatMap(({ ranch }) => (ranch.hazards || [])
            .map(hazard => `${Number(ranch.ranch_inst_id)}:3:${Number(hazard.hazard_id)}`));
        plan.count = plan.resultKeys.length;
        return plan;
    }
    if (action === 'upgrade') {
        const facilityId = positiveId(input.facilityId, '设施实例');
        const facility = (raw.cells.facilities || []).find(row => Number(row.instance_id) === facilityId);
        if (!facility || facility.state !== 1 || ![6, 7, 8].includes(Number(facility.module_type))) {
            throw manualError('该设施尚未就绪或不在本期升级范围', 'RANCH_FACILITY_NOT_FOUND');
        }
        if (Number(facility.upgrade_state) !== 0) { plan.count = 0; plan.message = '设施已在升级或等待完成'; return plan; }
        const current = getRanchFacility(facility.facility_id);
        const next = getRanchFacility(current?.next_facility_id);
        const required = next?.upgrade_conditions?.match(/^RANCH_LEVEL:(\d+)$/);
        const level = rawRanchLevel(raw);
        if (!current || !next || !required || Number(current.level) !== Number(facility.level)
            || Number(next.level) !== Number(current.level) + 1 || next.module_type !== current.module_type) {
            plan.count = 0; plan.message = '目标等级或配置尚未确认'; return plan;
        }
        if (!level || level.level < Number(required[1])) {
            plan.count = 0; plan.message = level ? `当前牧场 Lv.${level.level}，需 Lv.${required[1]}` : '牧场经验1102未返回，不能用农场等级代替'; return plan;
        }
        const detail = await sceneRpc(sessionOf(raw), 'gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail',
            types.RanchGetFacilityDetailRequest, types.RanchGetFacilityDetailReply, { instance_id: facilityId }, { read: true });
        const info = detail.info;
        if (!info || Number(info.instance_id) !== facilityId || Number(info.facility_id) !== Number(facility.facility_id)
            || Number(info.level) !== Number(facility.level) || Number(info.module_type) !== Number(facility.module_type)) {
            throw manualError('升级费用详情与当前设施不一致', 'RANCH_STATE_CHANGED');
        }
        const parts = String(next.upgrade_cost || '').split(';');
        if (!parts.length || parts.some(part => !/^[1-9]\d*:[1-9]\d*$/.test(part))) {
            plan.count = 0; plan.message = '固定升级费用不完整，暂不提交'; return plan;
        }
        const fixed = parts.map(part => { const [id, count] = part.split(':'); return { id, count }; });
        const costs = (info.upgrade_cost || []).map(item => ({ id: bigText(item.id), count: bigText(item.count) }));
        if (costs.some(item => item.id === '0' || BigInt(item.count) <= 0n)
            || signature(aggregateItems(costs)) !== signature(aggregateItems(fixed))) {
            plan.count = 0; plan.message = '固定配置与服务端升级费用不一致，暂不提交'; return plan;
        }
        const funds = [];
        for (const cost of aggregateItems(costs)) {
            const money = await resourceBalance(raw, Number(cost.id));
            if (money.available - ranchOperations.reserved(raw.sessionAccountId, `item:${cost.id}`) < BigInt(cost.count)) {
                plan.count = 0; plan.message = '升级货币不足（已扣除待核对预留）'; return plan;
            }
            funds.push({ id: cost.id, count: money.total.toString() });
        }
        plan.payload = { inst_id: facilityId };
        plan.costItems = aggregateItems(costs);
        plan.marker = { facilityId, facilityType: Number(facility.facility_id), moduleType: Number(facility.module_type),
            level: Number(facility.level), targetFacilityId: Number(next.facility_id), targetLevel: Number(next.level), funds };
        plan.label = `升级${current.name} Lv.${facility.level} → Lv.${next.level}`;
        plan.message = `当前牧场 Lv.${level.level}，要求 Lv.${required[1]}；预计 ${next.upgrade_secs} 秒，费用与目标在发送前复核。`;
        return plan;
    }
    if (action === 'completeUpgrade') {
        const facilityId = positiveId(input.facilityId, '设施实例');
        const facility = (raw.cells.facilities || []).find(row => Number(row.instance_id) === facilityId);
        if (!facility || facility.state !== 1 || ![6, 7, 8].includes(Number(facility.module_type))) throw manualError('设施不存在或未就绪', 'RANCH_FACILITY_NOT_FOUND');
        if (!facility.upgrade_state) { plan.count = 0; return plan; }
        const current = getRanchFacility(facility.facility_id);
        const next = getRanchFacility(current?.next_facility_id);
        if (!next || Number(next.level) !== Number(facility.level) + 1) {
            plan.count = 0; plan.message = '待完成的目标设施配置未确认'; return plan;
        }
        const endMs = Number(facility.upgrade_end_time) < 100000000000
            ? Number(facility.upgrade_end_time) * 1000 : Number(facility.upgrade_end_time);
        if (facility.upgrade_state !== 2 && endMs > Date.now()) {
            throw manualError('设施仍在升级中', 'RANCH_UPGRADE_PENDING');
        }
        plan.payload = { inst_id: facilityId };
        plan.marker = { facilityId, facilityType: Number(facility.facility_id), moduleType: Number(facility.module_type),
            level: Number(facility.level), upgradeState: Number(facility.upgrade_state),
            targetFacilityId: Number(next.facility_id), targetLevel: Number(next.level) };
        plan.count = 1;
        return plan;
    }
    if (action === 'release') {
        if (input.all === true) throw manualError('放生必须逐只确认', 'RANCH_INVALID_ARGUMENT');
        const animalInstId = positiveId(input.animalId, '动物实例');
        const ranchId = positiveId(input.ranchId, '栏舍实例');
        let target = null;
        for (const { ranch } of ranchesOf(raw.cells)) {
            if (Number(ranch.ranch_inst_id) !== ranchId) continue;
            const animal = (ranch.animals || []).find(row => Number(row.animal_inst_id) === animalInstId);
            if (animal) { target = { ranch, animal }; break; }
        }
        if (!target || target.animal.can_donate !== true) throw manualError('这只动物当前不能放生', 'RANCH_STATE_CHANGED');
        plan.payload = { targets: [{ ranch_inst_id: Number(target.ranch.ranch_inst_id), animal_inst_id: animalInstId }] };
        plan.marker = { animalInstId, ranchId: Number(target.ranch.ranch_inst_id) };
        plan.resultKeys = [`${Number(target.ranch.ranch_inst_id)}:1:${animalInstId}`];
        plan.label = `放生动物 #${integer(target.animal.animal_id)}`;
        plan.count = 1;
        return plan;
    }
    throw manualError('不支持的牧场操作', 'RANCH_INVALID_ARGUMENT');
}

function sessionOf(raw) {
    if (!raw.session) throw manualError('缺少会话', 'RANCH_INVALID_ARGUMENT');
    return raw.session;
}

function assertPositiveItems(plan, items, label) {
    for (const item of items || []) {
        if (bigText(item?.id) === '0' || BigInt(bigText(item?.count)) <= 0n) {
            throw unknownOutcome(plan, `${label}物品或数量无效`);
        }
    }
}

function assertOpResults(plan, reply, allowCosts = false) {
    const rows = reply.op_results || [];
    if (!rows.length) throw unknownOutcome(plan, '有目标但未返回任何实际操作结果');
    const keys = rows.map(row => `${Number(row.facility_inst_id)}:${Number(row.kind)}:${Number(row.target_id)}`);
    if (new Set(keys).size !== keys.length) throw unknownOutcome(plan, '回包包含重复目标');
    const expected = new Set(plan.resultKeys || []);
    for (const [index, key] of keys.entries()) {
        const row = rows[index];
        if (!expected.has(key)) throw unknownOutcome(plan, '回包目标超出本次报价范围');
        assertPositiveItems(plan, row.rewards || [], '奖励');
        assertPositiveItems(plan, row.costs || [], '消耗');
        if (!allowCosts && (row.costs || []).length) throw unknownOutcome(plan, '回包包含未报价消耗');
    }
    return rows;
}

function unknownOutcome(plan, reason) {
    return manualError(`${plan.label}结果未能确认：${reason}，请刷新核对，勿重复提交`, 'RANCH_RESULT_UNKNOWN', {
        sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
}

function aggregateItems(items) {
    const totals = new Map();
    for (const item of items || []) {
        const id = bigText(item.id);
        totals.set(id, (totals.get(id) || 0n) + BigInt(bigText(item.count)));
    }
    return [...totals].map(([id, count]) => ({ id, count: count.toString() }));
}

function verifyPhysicalConsumption(plan, before, after, itemId, count) {
    const previous = physicalBalance(before.bag, itemId);
    const current = physicalBalance(after.bag, itemId);
    if (previous.total - current.total !== BigInt(count) || previous.locked !== current.locked) {
        throw unknownOutcome(plan, '实体库存扣减或锁定库存不匹配');
    }
}

async function verifyOutcome(plan, reply, before, after) {
    if (plan.action === 'exchange') return require('./ranch-market').verifyExchange(plan, reply, before, after);
    if (PROGRESSION_ACTIONS.has(plan.action)) return require('./ranch-progression').verifyProgressOutcome(plan, reply, before, after);
    for (const key of ['get_items', 'cost_items', 'sell_items', 'consumed']) {
        // AddFeed 的零数量明细只能交由下方写后双证据路径核验，不能按成功扣减直接通过。
        if (key === 'consumed' && plan.action === 'addGrass') {
            if (reply[key] && !Array.isArray(reply[key])) throw unknownOutcome(plan, '牧草扣减明细结构无效');
            continue;
        }
        if (reply[key]) assertPositiveItems(plan, reply[key], key);
    }
    switch (plan.action) {
        case 'place': {
            if (!after) throw unknownOutcome(plan, '放养后库存未能读取');
            const ranch = ranchesOf(after.cells).find(row => Number(row.ranch.ranch_inst_id) === plan.marker.ranchId)?.ranch;
            if (!ranch) throw unknownOutcome(plan, '所选栏舍未返回');
            const added = (ranch.animals || []).filter(animal => !plan.marker.beforeAnimals.includes(Number(animal.animal_inst_id)));
            const rows = reply.op_results || [];
            const ids = rows.map(row => Number(row.target_id));
            if (!rows.length || rows.length > plan.count || added.length !== rows.length || new Set(ids).size !== ids.length
                || rows.some(row => Number(row.kind) !== 1 || Number(row.facility_inst_id) !== plan.marker.ranchId
                    || Number(row.target_id) <= 0 || !added.some(animal => Number(animal.animal_inst_id) === Number(row.target_id)))
                || added.some(animal => Number(animal.animal_id) !== plan.marker.animalId
                    || plan.marker.giantCubItemId > 0 && !(Number(animal.mutation?.mutation_type) > 0))) {
                throw unknownOutcome(plan, '新增动物、栏舍或巨大幼崽状态不匹配');
            }
            if (Math.max(Number(ranch.animal_count), (ranch.animals || []).length) - plan.marker.occupied !== rows.length) {
                throw unknownOutcome(plan, '栏舍新增数量未确认');
            }
            const costs = rows.flatMap(row => row.costs || []);
            assertPositiveItems(plan, costs, '放养消耗');
            assertPositiveItems(plan, rows.flatMap(row => row.rewards || []), '放养奖励');
            if (costs.length && (costs.some(item => bigText(item.id) !== String(plan.marker.itemId))
                || costs.reduce((sum, item) => sum + BigInt(bigText(item.count)), 0n) !== BigInt(rows.length))) {
                throw unknownOutcome(plan, '放养回包消耗不匹配');
            }
            verifyPhysicalConsumption(plan, before, after, plan.marker.itemId, rows.length);
            return { completed: rows.length, rewards: rows.flatMap(row => row.rewards || []), partial: rows.length < plan.count,
                actualCosts: [{ id: String(plan.marker.itemId), count: String(rows.length) }] };
        }
        case 'useCan': {
            if (!after) throw unknownOutcome(plan, '入桶后库存未能读取');
            const returned = reply.item;
            if (returned && (bigText(returned.id) !== '0' && bigText(returned.id) !== plan.marker.itemId
                || bigText(returned.uid) !== '0' && bigText(returned.uid) !== plan.marker.uid)) {
                throw unknownOutcome(plan, '罐头回包批次或物品不匹配');
            }
            const afterUid = (after.bag.physical_items || []).find(item => bigText(item.uid) === plan.marker.uid);
            if (afterUid && bigText(afterUid.id) !== plan.marker.itemId) throw unknownOutcome(plan, '使用后批次物品类型变化');
            const used = BigInt(plan.marker.batchBefore) - physicalBalance(after.bag, plan.marker.itemId, plan.marker.uid).total;
            if (used <= 0n || used > BigInt(plan.count)) throw unknownOutcome(plan, '所选批次实际消耗数量未确认');
            verifyPhysicalConsumption(plan, before, after, plan.marker.itemId, used);
            const gained = balance(after.bag, plan.marker.bucketId).total - BigInt(plan.marker.bucketBefore);
            if (gained !== used * BigInt(plan.marker.seconds)) throw unknownOutcome(plan, '入桶时长与实际消耗不匹配');
            return { completed: Number(used), rewards: reply.get_items || [], partial: used < BigInt(plan.count),
                actualCosts: [{ id: plan.marker.itemId, count: used.toString() }] };
        }
        case 'buyCan': {
            if (!after || reply.success !== true || bigText(reply.goods_id) !== String(plan.payload.goods_id)) {
                throw unknownOutcome(plan, '罐头购买状态或商品未确认');
            }
            assertPositiveItems(plan, reply.reward_items || [], '购买奖励');
            if (signature(aggregateItems(reply.reward_items || [])) !== signature(aggregateItems(plan.expectedRewards))) {
                throw unknownOutcome(plan, '罐头购买奖励不匹配');
            }
            for (const item of aggregateItems(plan.expectedRewards)) {
                const stock = plan.marker.stockBefore.find(row => row.id === item.id);
                if (!stock || physicalBalance(after.bag, item.id).total - BigInt(stock.count) !== BigInt(item.count)) {
                    throw unknownOutcome(plan, '罐头实物库存增加不匹配');
                }
            }
            if (plan.marker.currencyBefore !== null) {
                const money = await resourceBalance(after, Number(plan.marker.currencyId));
                if (BigInt(plan.marker.currencyBefore) - money.total !== BigInt(plan.marker.free ? 0 : plan.costItems[0].count)) {
                    throw unknownOutcome(plan, '罐头购买扣费与报价不匹配');
                }
            }
            return { completed: plan.count, rewards: aggregateItems(reply.reward_items || []) };
        }
        case 'harvest':
        case 'produce':
        case 'clean': {
            const rows = assertOpResults(plan, reply);
            if (rows.length > plan.count) throw unknownOutcome(plan, '实际数量超出报价');
            if (plan.action === 'harvest' && rows.some(row => !(row.rewards || []).length)) {
                throw unknownOutcome(plan, '收获目标没有实际产出');
            }
            if (plan.action === 'produce') {
                for (const row of rows) {
                    const animal = (reply.ranches || []).find(ranch => Number(ranch.ranch_inst_id) === Number(row.facility_inst_id))
                        ?.animals?.find(item => Number(item.animal_inst_id) === Number(row.target_id));
                    if (!animal || animal.can_deliver === true
                        || !(animal.producing === true || Number(animal.delivering_until_ms) > 0)) {
                        throw unknownOutcome(plan, '生产目标状态未确认变化');
                    }
                }
            }
            if (plan.action === 'clean') {
                for (const row of rows) {
                    const ranch = (reply.ranches || []).find(item => Number(item.ranch_inst_id) === Number(row.facility_inst_id));
                    if (ranch && (ranch.hazards || []).some(item => Number(item.hazard_id) === Number(row.target_id))) {
                        throw unknownOutcome(plan, '回包仍包含已清理目标');
                    }
                }
            }
            return { rewards: rows.flatMap(row => row.rewards || []), completed: rows.length, partial: rows.length < plan.count };
        }
        case 'feed': {
            const used = BigInt(bigText(reply.deduct_secs));
            const cap = BigInt(plan.costItems[0].count);
            if (used <= 0n || used > cap) throw unknownOutcome(plan, '罐头消耗与上限不匹配');
            const beforeTotal = BigInt(plan.marker.bucketRemain);
            if (BigInt(bigText(reply.bucket_remain_secs)) !== beforeTotal - used) {
                throw unknownOutcome(plan, '罐头桶余量不匹配');
            }
            const rows = assertOpResults(plan, reply, true);
            if (rows.length > plan.count) throw unknownOutcome(plan, '喂养数量超出报价');
            const rowCosts = rows.flatMap(row => row.costs || []);
            if (rowCosts.length) {
                if (rowCosts.some(item => bigText(item.id) !== String(plan.costItems[0].id))
                    || rowCosts.reduce((sum, item) => sum + BigInt(bigText(item.count)), 0n) !== used) {
                    throw unknownOutcome(plan, '逐目标喂养消耗不匹配');
                }
            }
            for (const row of rows) {
                const before = plan.marker.beforeAnimals.find(item => item.ranchId === Number(row.facility_inst_id)
                    && item.instanceId === Number(row.target_id));
                const animal = (reply.ranches || []).find(ranch => Number(ranch.ranch_inst_id) === Number(row.facility_inst_id))
                    ?.animals?.find(item => Number(item.animal_inst_id) === Number(row.target_id));
                if (!before || !animal || bigText(animal.animal_id) !== before.animalId) {
                    throw unknownOutcome(plan, '喂养回包缺少正确动物');
                }
                const afterTimes = [animal.infant_ready_at_ms, animal.grow_ready_at_ms, animal.produce_ready_at_ms, animal.mature_ready_at_ms].map(bigText);
                const timeReduced = before.deadlines.some((value, index) => BigInt(value) > 0n
                    && BigInt(afterTimes[index]) > 0n && BigInt(afterTimes[index]) < BigInt(value));
                const changed = Number(animal.stage) !== before.stage || timeReduced
                    || plan.marker.bucketType === 2 && !before.limitedCanUsed && animal.limited_can_used === true;
                if (!changed) throw unknownOutcome(plan, '喂养目标未确认变化');
            }
            return { rewards: rows.flatMap(row => row.rewards || []), completed: rows.length,
                partial: rows.length < plan.count, actualCosts: [{ id: plan.costItems[0].id, count: used.toString() }] };
        }
        case 'addGrass': {
            const detail = reply.detail;
            if (!detail || Number(detail.feed_count) !== plan.marker.feedCount + plan.count) {
                throw unknownOutcome(plan, '牧草机存量不匹配');
            }
            const consumed = reply.consumed || [];
            let total = 0n;
            for (const item of consumed) {
                const count = item?.count?.toString() || '';
                if (bigText(item?.id) !== String(GRASS_ITEM_ID) || !/^\d+$/.test(count)
                    || BigInt(count) > 9223372036854775807n) {
                    throw unknownOutcome(plan, '牧草扣减物品或数量无效');
                }
                total += BigInt(count);
            }
            if (!consumed.length || total !== BigInt(plan.count) || consumed.some(item => BigInt(item.count.toString()) === 0n)) {
                // 明细缺失、包含零数量或同物品总量不符时，不猜测字段语义；用同租约的两个独立强读核验真实产出和消耗。
                // 错物品、无效数量仍在上方拒绝；回读只读一次，任何失败都不重发 AddFeed。
                let observed;
                try { observed = await loadSceneState(before.session); }
                catch { throw unknownOutcome(plan, '扣减明细未确认且写后库存与牧草机未能核验'); }
                const facility = (observed.cells.facilities || []).find(row => Number(row.instance_id) === plan.marker.facilityId);
                if (!facility?.feed_machine || Number(facility.capacity) !== plan.marker.capacity
                    || Number(facility.feed_machine.feed_count) !== plan.marker.feedCount + plan.count) {
                    throw unknownOutcome(plan, '写后目标牧草机增量不匹配');
                }
                const bag = observed.bag;
                const validGrass = source => bagItems(source).every(item => bigText(item?.id) !== String(GRASS_ITEM_ID)
                    || /^\d+$/.test(String(item?.count ?? '')));
                if (!validGrass(before.bag) || !validGrass(bag)) throw unknownOutcome(plan, '牧草库存数量无效');
                const previous = balance(before.bag, GRASS_ITEM_ID);
                const current = balance(bag, GRASS_ITEM_ID);
                if (previous.total - current.total !== BigInt(plan.count) || previous.locked !== current.locked) {
                    throw unknownOutcome(plan, '扣减明细未确认且写后库存差额不匹配');
                }
                return { rewards: [], completed: plan.count, verifiedBag: bag };
            }
            return { rewards: [], completed: plan.count };
        }
        case 'buy': {
            const goods = reply.goods;
            if (!goods || Number(goods.id) !== plan.payload.goods_id) throw unknownOutcome(plan, '商品编号不匹配');
            const costItems = reply.cost_items || [];
            if (signature(costItems) !== signature(plan.costItems)) throw unknownOutcome(plan, '扣费不匹配');
            if (plan.payload.auto_add !== true) {
                if (signature(reply.get_items || []) !== signature(plan.expectedRewards)) {
                    throw unknownOutcome(plan, '入包物品不匹配');
                }
            }
            return { rewards: reply.get_items || [], completed: 1 };
        }
        case 'sell': {
            const sold = (items) => (items || []).map(item => `${bigText(item?.id)}:${bigText(item?.uid)}:${bigText(item?.count)}`).sort().join('|');
            if (sold(reply.sell_items) !== sold(plan.payload.items)) throw unknownOutcome(plan, '出售物品不匹配');
            if (signature(reply.get_items || []) !== signature(plan.expectedRewards)) throw unknownOutcome(plan, '出售收益不匹配');
            return { rewards: reply.get_items || [], completed: plan.count };
        }
        case 'upgrade': {
            const upgrade = reply.upgrade;
            if (!after || !upgrade || Number(upgrade.inst_id) !== plan.payload.inst_id
                || Number(upgrade.target_facility_id) !== plan.marker.targetFacilityId
                || Number(upgrade.target_level) !== plan.marker.targetLevel || ![1, 2].includes(Number(upgrade.state))) {
                throw unknownOutcome(plan, '发起升级回包目标或状态不匹配');
            }
            const facility = (after.cells.facilities || []).find(row => Number(row.instance_id) === plan.payload.inst_id);
            const pending = facility && Number(facility.facility_id) === plan.marker.facilityType
                && Number(facility.level) === plan.marker.level && [1, 2].includes(Number(facility.upgrade_state));
            const done = facility && Number(facility.facility_id) === plan.marker.targetFacilityId && Number(facility.level) === plan.marker.targetLevel;
            if (!facility || Number(facility.module_type) !== plan.marker.moduleType || (!pending && !done)) {
                throw unknownOutcome(plan, '升级后的设施状态未确认');
            }
            for (const cost of plan.costItems) {
                const initial = plan.marker.funds.find(item => item.id === cost.id);
                const money = await resourceBalance(after, Number(cost.id));
                if (!initial || BigInt(initial.count) - money.total !== BigInt(cost.count)) {
                    throw unknownOutcome(plan, '升级实际扣费与报价不匹配');
                }
            }
            return { rewards: [], completed: 1 };
        }
        case 'completeUpgrade': {
            const facility = reply.facility;
            if (!facility || Number(facility.instance_id) !== plan.payload.inst_id
                || Number(facility.level) !== plan.marker.targetLevel
                || Number(facility.facility_id) !== plan.marker.targetFacilityId
                || Number(facility.module_type) !== plan.marker.moduleType || Number(facility.upgrade_state) !== 0) {
                throw unknownOutcome(plan, '设施升级目标或等级回包不匹配');
            }
            return { rewards: [], completed: 1 };
        }
        case 'release': {
            const rows = reply.op_results || [];
            const result = rows[0];
            if (rows.length !== 1 || !result || Number(result.kind) !== 1
                || Number(result.facility_inst_id) !== plan.marker.ranchId
                || Number(result.target_id) !== plan.marker.animalInstId
                || (result.costs || []).length) {
                throw unknownOutcome(plan, '放生目标不匹配');
            }
            const ranch = (reply.ranches || []).find(row => Number(row.ranch_inst_id) === plan.marker.ranchId);
            if (!ranch || (ranch.animals || []).some(row => Number(row.animal_inst_id) === plan.marker.animalInstId)) {
                throw unknownOutcome(plan, '动物仍在栏舍');
            }
            assertPositiveItems(plan, result.rewards || [], '放生奖励');
            return { rewards: result.rewards || [], completed: 1 };
        }
        default:
            throw unknownOutcome(plan, '未核对的动作');
    }
}

const WRITE_ROUTES = {
    harvest: ['gamepb.animalpb.AnimalService', 'HarvestRanch', 'RanchHarvestRanchRequest', 'RanchHarvestRanchReply'],
    produce: ['gamepb.animalpb.AnimalService', 'TriggerProduce', 'RanchTriggerProduceRequest', 'RanchTriggerProduceReply'],
    feed: ['gamepb.animalpb.AnimalService', 'FeedAnimal', 'RanchFeedAnimalRequest', 'RanchFeedAnimalReply'],
    addGrass: ['gamepb.homesteadpb.FeedMachineService', 'AddFeed', 'RanchAddFeedRequest', 'RanchAddFeedReply'],
    buy: ['gamepb.shoppb.ShopService', 'BuyGoods', 'BuyGoodsRequest', 'BuyGoodsReply'],
    sell: ['gamepb.itempb.ItemService', 'Sell', 'RanchSellRequest', 'RanchSellReply'],
    clean: ['gamepb.animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanchRequest', 'RanchCleanAllRanchReply'],
    completeUpgrade: ['gamepb.homesteadpb.HomesteadService', 'CompleteBuildingUpgrade', 'RanchCompleteBuildingUpgradeRequest', 'RanchCompleteBuildingUpgradeReply'],
    release: ['gamepb.animalpb.AnimalService', 'DonateAnimal', 'RanchDonateAnimalRequest', 'RanchDonateAnimalReply'],
    place: ['gamepb.animalpb.AnimalService', 'PlaceAnimal', 'RanchPlaceAnimalRequest', 'RanchPlaceAnimalReply'],
    useCan: ['gamepb.itempb.ItemService', 'Use', 'RanchUseRequest', 'RanchUseReply'],
    buyCan: ['gamepb.mallpb.MallService', 'Purchase', 'PurchaseRequest', 'PurchaseResponse'],
    upgrade: ['gamepb.homesteadpb.HomesteadService', 'UpgradeBuilding', 'RanchUpgradeBuildingRequest', 'RanchUpgradeBuildingReply'],
    exchange: ['gamepb.shoppb.ShopService', 'RotationBuyGoods', 'RanchRotationBuyGoodsRequest', 'RanchRotationBuyGoodsReply'],
    claimTasks: ['gamepb.taskpb.TaskService', 'BatchClaimTaskReward', 'RanchBatchClaimTaskRewardRequest', 'RanchBatchClaimTaskRewardReply'],
    claimIllustrated: ['gamepb.illustratedpb.IllustratedService', 'ClaimAllRewardsV2', 'RanchClaimAllRewardsV2Request', 'RanchClaimAllRewardsV2Reply'],
    claimWeight: ['gamepb.illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2', 'RanchClaimRanchWeightScoreRewardV2Request', 'RanchClaimRanchWeightScoreRewardV2Reply'],
    reportDailyShare: ['gamepb.sharepb.ShareService', 'ReportShare', 'RanchReportShareRequest', 'RanchReportShareReply'],
    claimDailyShare: ['gamepb.sharepb.ShareService', 'ClaimShareReward', 'RanchClaimShareRewardRequest', 'RanchClaimShareRewardReply'],
};

function attachAvailableResources(plan, raw) {
    plan.availableResources = Object.fromEntries((plan.costItems || []).map(item => {
        const resourceKey = `item:${item.id}`;
        return [resourceKey, balance(raw.bag, item.id).available.toString()];
    }));
    return plan;
}

function findConflictingPendingOperation(accountId, action, input, plan = null) {
    const target = targetOf(action, input);
    const pending = ranchOperations.pending(accountId);
    const requestedByResource = new Map();
    for (const item of plan?.costItems || []) {
        const key = `item:${String(item.id)}`;
        requestedByResource.set(key, (requestedByResource.get(key) || 0n) + BigInt(item.count));
    }
    const reservedByResource = new Map();
    for (const row of pending) for (const cost of row.costs || []) {
        reservedByResource.set(cost.resourceKey, (reservedByResource.get(cost.resourceKey) || 0n) + BigInt(cost.amount));
    }
    const resourceConflicts = new Set();
    for (const [key, requested] of requestedByResource) {
        const available = plan?.availableResources?.[key] == null ? null : BigInt(plan.availableResources[key]);
        if ([...pending].some(row => (row.costs || []).some(cost => cost.resourceKey === key))
            && (available === null || (reservedByResource.get(key) || 0n) + requested > available)) resourceConflicts.add(key);
    }
    const requestedTaskIds = new Set((plan?.marker?.tasks || []).map(task => String(task.id)));
    for (const id of input?.taskIds || []) requestedTaskIds.add(String(id));
    if (input?.taskId != null) requestedTaskIds.add(String(input.taskId));
    const taskPending = row => {
        if (action !== 'claimTasks' || !String(row.target).startsWith('ranch:claimTasks:')) return false;
        const pendingId = String(row.target).slice('ranch:claimTasks:'.length);
        return pendingId === 'all' || input?.all === true || requestedTaskIds.has(pendingId);
    };
    const sharePending = row => ['ranch:reportDailyShare:102', 'ranch:claimDailyShare:102'].includes(row.target)
        && ['reportDailyShare', 'claimDailyShare'].includes(action);
    const exchangePending = row => action === 'exchange' && String(row.target).startsWith('ranch:exchange:');
    const conflicts = pending.filter(row => row.target === target || taskPending(row) || sharePending(row)
        || exchangePending(row) || (row.costs || []).some(cost => resourceConflicts.has(cost.resourceKey)));
    return conflicts[0] || null;
}

function assertNoConflictingPendingTarget(accountId, action, input, plan = null) {
    const conflict = findConflictingPendingOperation(accountId, action, input, plan);
    if (!conflict) return;
    const target = targetOf(action, input);
    throw manualError(conflict.target === target
        ? `${conflict.label || '这项操作'}结果仍待核对；同一目标暂不能重复操作`
        : '另有未核实操作可能影响本次使用的物品或余额，暂不能购买。',
        'RANCH_PENDING_CONFIRMATION', { resultState: 'unknown', outcomeUnknown: false });
}

async function quoteRanchAction(accountId, action, input) {
    assertAccountBinding(accountId);
    if (FRIEND_ACTIONS.has(action)) {
        return require('./ranch-friends').quoteRanchFriendAction(accountId, action, input || {});
    }
    if (!ACTION_LABELS[action]) throw manualError('不支持的牧场操作', 'RANCH_INVALID_ARGUMENT');
    assertNoConflictingPendingTarget(accountId, action, input || {});
    return withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
        if (String(accountId) !== session.accountId) throw manualError('牧场请求与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
        const raw = { ...await loadActionState(session, action, sceneReply), session, sessionAccountId: accountId };
        const plan = attachAvailableResources(await planAction(action, input || {}, raw), raw);
        assertNoConflictingPendingTarget(accountId, action, input || {}, plan);
        return {
            action, label: plan.label, count: plan.count, skipped: plan.count === 0,
            costs: plan.costItems.map(item => ({ ...item, name: getRanchItem(item.id)?.name,
                unit: [7003, 7004].includes(Number(item.id)) ? '秒' : '' })),
            rewards: plan.expectedRewards.map(item => ({ ...item, name: getRanchItem(item.id)?.name,
                unit: [7003, 7004].includes(Number(item.id)) ? '秒' : '' })),
            expected: { signature: planSignature(plan, session) },
            message: plan.message || '',
            pendingBlocked: false,
        };
    }, { priority: 'foreground', timeoutMs: PROGRESSION_ACTIONS.has(action) || action === 'exchange' ? 155000 : 90000 });
}

function targetOf(action, input) {
    // Preserve all previous target names; 4B gets distinct task/book/share targets.
    if (action === 'claimTasks') return `ranch:${action}:${input?.all === true || Array.isArray(input?.taskIds) ? 'all' : input?.taskId || 'all'}`;
    if (action === 'claimIllustrated') return 'ranch:claimIllustrated:101';
    if (action === 'claimWeight') return `ranch:claimWeight:${input?.levelId || 'all'}`;
    if (['reportDailyShare', 'claimDailyShare'].includes(action)) return `ranch:${action}:102`;
    const focus = input?.goodsId || input?.facilityId || input?.uid || input?.animalId;
    return `ranch:${action}:${focus || 'all'}`;
}

// 固定保守购买策略：普通金券、每轮最多3只、每只至多1080、始终保留10000金券。
// 不选几秒成熟的引导鸡，避免“刚放养即被收走”冒充稳定有动物。
const AUTO_CUB_POLICY = Object.freeze({ currencyId: 1007, maxUnitPrice: 1080, reserve: 10000n, maxCount: 3 });
async function selectAutoCubPurchase(raw, remainingCount) {
    const limit = Math.min(AUTO_CUB_POLICY.maxCount, remainingCount);
    if (!Number.isSafeInteger(limit) || limit <= 0) return null;
    const pens = ranchPens(raw).filter(pen => pen.room > 0);
    if (!pens.length) return null;
    const money = balance(raw.bag, AUTO_CUB_POLICY.currencyId);
    const available = money.available - ranchOperations.reserved(raw.sessionAccountId, 'item:1007') - AUTO_CUB_POLICY.reserve;
    if (available <= 0n) return null;
    const goods = await shopGoods(sessionOf(raw), 5);
    const candidates = goods.filter(good => {
        const animal = getRanchAnimalByCubItem(good.itemId);
        const price = good.discounted && good.discountPrice > 0 ? good.discountPrice : good.price;
        return good.valid && good.unlocked && !good.owned && good.currencyId === AUTO_CUB_POLICY.currencyId
            && good.itemCount === 1 && Number.isSafeInteger(price) && price > 0 && price <= AUTO_CUB_POLICY.maxUnitPrice
            && good.maxCount > 0 && (good.remaining === null || good.remaining > 0)
            && animal?.enable_flag === true && !Number(animal.giantCubItemId) && Number(animal.grow_sec) >= 60
            && pens.some(pen => pen.husbandryType === (animal.husbandry_type === '窝' ? 1 : animal.husbandry_type === '棚' ? 2 : 0));
    }).sort((a, b) => a.id - b.id);
    for (const good of candidates) {
        const animal = getRanchAnimalByCubItem(good.itemId);
        const kind = animal.husbandry_type === '窝' ? 1 : 2;
        const room = pens.filter(pen => pen.husbandryType === kind).reduce((sum, pen) => sum + pen.room, 0);
        const price = good.discounted && good.discountPrice > 0 ? good.discountPrice : good.price;
        const count = Math.min(limit, room, good.maxCount, good.remaining ?? Infinity, Number(available / BigInt(price)));
        if (Number.isSafeInteger(count) && count > 0) return { shopId: 5, goodsId: good.id, count, autoPlace: true };
    }
    return null;
}

function assertAutoCubPlan(plan, raw, remainingCount) {
    const cost = plan.costItems?.[0];
    if (plan.action !== 'buy' || plan.marker?.shopId !== 5 || plan.payload?.auto_add !== true
        || plan.payload.num > remainingCount || plan.payload.num > AUTO_CUB_POLICY.maxCount
        || plan.costItems?.length !== 1 || Number(cost?.id) !== AUTO_CUB_POLICY.currencyId
        || !Number.isSafeInteger(plan.marker?.unitPrice) || plan.marker.unitPrice <= 0
        || plan.marker.unitPrice > AUTO_CUB_POLICY.maxUnitPrice
        || balance(raw.bag, AUTO_CUB_POLICY.currencyId).available - ranchOperations.reserved(raw.sessionAccountId, 'item:1007')
            - BigInt(cost.count) < AUTO_CUB_POLICY.reserve) {
        throw manualError('自动补栏超出金券预算或普通幼崽范围，本次未发送', 'RANCH_AUTO_BUY_POLICY');
    }
}

async function executePreparedPlan(accountId, action, input, plan, raw, session, options = {}) {
    if (String(accountId) !== session.accountId) throw manualError('牧场写与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
    assertNoConflictingPendingTarget(accountId, action, input || {}, plan);
    if (!plan.count) return { raw, result: { status: 'skipped', action, label: plan.label,
        count: 0, completed: 0, costs: [], rewards: [] } };
    const target = targetOf(action, input);
    clearRanchReadCache();
    clearRanchCatalogCache(accountId);
    const [service, method, requestName, replyName] = WRITE_ROUTES[action] || [];
    if (!service) throw manualError('不支持的牧场写操作', 'RANCH_INVALID_ARGUMENT');
    const reservedCosts = plan.costItems.map(item => ({ resourceKey: `item:${item.id}`, amount: String(item.count) }));
    const availableResources = Object.fromEntries(plan.costItems.map(item => {
        const resourceKey = `item:${item.id}`;
        return [resourceKey, balance(raw.bag, item.id).available.toString()];
    }));
    try {
        return await ranchOperations.spend(accountId, { target, label: plan.label, costs: reservedCosts,
            availableResources }, async (lifecycle) => {
            const reply = await sceneRpc(session, service, method,
                types[requestName], types[replyName], plan.payload, { lifecycle, assertCanSend: options.assertCanSend });
            let after = null;
            const requiresPostState = ['buy', 'place', 'useCan', 'buyCan', 'upgrade', 'exchange'].includes(action)
                || PROGRESSION_ACTIONS.has(action) && action !== 'claimTasks';
            if (requiresPostState) {
                try { after = { ...await loadActionState(session, action), session, sessionAccountId: accountId,
                    serverIntervalSec: raw.serverIntervalSec }; }
                catch (error) { throw unknownOutcome(plan, `操作后的库存未能读取：${error?.message || '无结算证据'}`); }
            }
            const outcome = await verifyOutcome(plan, reply, raw, after);
            const actualCosts = outcome.actualCosts || plan.costItems;
            let nextRaw = after || patchRawAfterReply(raw, action, reply, plan);
            if (outcome.verifiedBag) nextRaw.bag = outcome.verifiedBag;
            if (action === 'buy') {
                for (const cost of plan.costItems) {
                    const beforeBalance = balance(raw.bag, cost.id).total;
                    const afterBalance = balance(after.bag, cost.id).total;
                    if (beforeBalance - afterBalance !== BigInt(cost.count)) {
                        throw unknownOutcome(plan, '库存扣减与费用不匹配');
                    }
                }
                if (plan.payload.auto_add) {
                    const known = new Set(plan.marker.beforeAnimals);
                    const added = ranchesOf(after.cells).flatMap(({ ranch }) => (ranch.animals || [])
                        .filter(row => !known.has(`${Number(ranch.ranch_inst_id)}:${Number(row.animal_inst_id)}`)));
                    if (added.length !== plan.payload.num
                        || added.some(row => Number(row.animal_id) !== Number(plan.marker.animalId))) {
                        throw unknownOutcome(plan, '自动放养动物或数量不匹配');
                    }
                }
                nextRaw = after;
            }
            return {
                result: {
                    status: 'confirmed', action, label: plan.label, count: plan.count,
                    costs: actualCosts, rewards: outcome.rewards || [],
                    completed: outcome.completed ?? plan.count,
                    partial: outcome.partial === true,
                },
                raw: nextRaw,
            };
        });
    }
    finally {
        clearRanchReadCache();
        clearRanchCatalogCache(accountId);
    }
}

async function operateRanchAction(accountId, action, input, expected) {
    assertAccountBinding(accountId);
    if (FRIEND_ACTIONS.has(action)) {
        return require('./ranch-friends').operateRanchFriendAction(accountId, action, input || {}, expected || {});
    }
    if (!WRITE_ROUTES[action]) {
        throw manualError('不支持的牧场写操作', 'RANCH_INVALID_ARGUMENT');
    }
    // Reject same-target unknowns before entering scene 2; resource conflicts
    // that need a plan are checked again after the read-only preparation.
    assertNoConflictingPendingTarget(accountId, action, input || {});
    return withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
        if (String(accountId) !== session.accountId) throw manualError('牧场请求与当前账号绑定不一致', 'ACCOUNT_OPERATION_CHANGED');
        const raw = { ...await loadActionState(session, action, sceneReply), session, sessionAccountId: accountId };
        const plan = attachAvailableResources(await planAction(action, input || {}, raw), raw);
        assertNoConflictingPendingTarget(accountId, action, input || {}, plan);
        if (!expected || expected.signature !== planSignature(plan, session)) {
            throw manualError('牧场状态、商品或费用已变化，请重新确认', 'RANCH_OFFER_CHANGED');
        }
        if (plan.count === 0) return { status: 'skipped', action, label: plan.label,
            count: 0, completed: 0, costs: [], rewards: [], reason: plan.reason || 'no_eligible_targets' };

        const executed = await executePreparedPlan(accountId, action, input || {}, plan, raw, session);
        return executed.result;
    }, { priority: 'foreground', timeoutMs: 155000 }).finally(() => {
        clearRanchReadCache();
        clearRanchCatalogCache(accountId);
    });
}

function getRanchOperationsSnapshot(accountId) {
    return {
        ...ranchOperations.snapshot(accountId),
        scene: getSceneSessionSnapshot(accountId),
        friendSession: require('./ranch-friend-session').getRanchFriendSessionSnapshot(accountId),
    };
}

function acknowledgeRanchOperation(accountId, id) {
    if (typeof id !== 'string' || !id) throw manualError('记录ID无效', 'RANCH_INVALID_ARGUMENT');
    ranchOperations.acknowledge(accountId, id);
    clearRanchCatalogCache(accountId);
    clearRanchReadCache();
    require('./ranch-friends').clearRanchFriendCache();
    return { ok: true };
}

module.exports = {
    quoteRanchAction,
    operateRanchAction,
    getRanchCatalog,
    getRanchBag,
    getRanchCanCatalog,
    clearRanchCatalogCache,
    getRanchOperationsSnapshot,
    acknowledgeRanchOperation,
    loadSceneState,
    sceneRpc,
    loadRanchDetail,
    mergeRanchDetails,
    planAction,
    executePreparedPlan,
    selectAutoCubPurchase,
    assertAutoCubPlan,
    targetOf,
    findConflictingPendingOperation,
    attachAvailableResources,
    SOURCE_COMMIT,
};
