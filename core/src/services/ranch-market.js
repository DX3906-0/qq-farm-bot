'use strict';

const network = require('../utils/network');
const { types } = require('../utils/proto');
const { requestError } = require('../utils/request-priority');
const { withGameScene, getSceneSessionSnapshot, RANCH_SCENE_ID } = require('./scene-session');
const { getRanchFriendSessionSnapshot } = require('./ranch-friend-session');
const { createSceneReadCache } = require('./ranch-readonly');
const { sceneRpc } = require('./ranch-manual');
const { numberText, small, positive, rewards, rewardSignature, clock } = require('./ranch-progression');
const { getRanchItem, getRanchImage, ranchLevelInfo, SOURCE_COMMIT } = require('./ranch-config');
const { ranchOperations } = require('./ranch-operations-ledger');
const openingGuide = require('../gameConfig/ranch/OpeningActivity.json');

const SHOP_ID = 7;
const marketCache = createSceneReadCache(5000);
const activityCache = createSceneReadCache(3000);
function error(message, code = 'RANCH_MARKET_UNCONFIRMED', unknown = false) {
    throw requestError(message, { errorCode: code, stage: 'ranch_market', sent: unknown,
        resultState: unknown ? 'unknown' : 'not_sent', outcomeUnknown: unknown });
}
async function rpc(session, service, method, request, reply, input = {}) {
    return sceneRpc(session, service, method, types[request], types[reply], input, { read: true });
}
function quantity(bag, id) {
    return [...(bag.physical_items || []), ...(bag.virtual_items || [])].filter(row => numberText(row.id) === String(id))
        .reduce((sum, row) => sum + BigInt(numberText(row.count)), 0n);
}
function available(bag, id, accountId) {
    const locked = [...(bag.physical_items || []), ...(bag.virtual_items || [])]
        .filter(row => numberText(row.id) === String(id) && row.is_locked === true)
        .reduce((sum, row) => sum + BigInt(numberText(row.count)), 0n);
    const free = quantity(bag, id) - locked - ranchOperations.reserved(accountId, `item:${id}`);
    return free > 0n ? free : 0n;
}
async function bag(session) {
    const reply = await rpc(session, 'gamepb.itempb.ItemService', 'GetBag', 'RanchGetBagRequest', 'RanchGetBagReply', { global_scene_id: 2 });
    if (Number(reply.global_scene_id) !== RANCH_SCENE_ID) error('集市库存不是当前牧场场景', 'RANCH_RESPONSE_MISMATCH');
    return reply;
}
function cardIdentity(row) {
    return JSON.stringify({ id: numberText(row.goods_id), item: numberText(row.item_id), amount: numberText(row.item_count),
        currency: numberText(row.cost_item_id), regular: numberText(row.cost_count), discount: numberText(row.discount_price),
        from: numberText(row.discount_start_time), until: numberText(row.discount_end_time),
        limit: numberText(row.limit_count), shelf: small(row.shelf_id), slot: small(row.slot),
        conditions: (row.buy_conds || []).map(condition => [condition.type, condition.params]) });
}
function decorateCard(row, raw, nowMs) {
    const id = positive(row.goods_id, '兑换商品ID'), itemId = positive(row.item_id, '兑换奖励ID');
    const itemCount = numberText(row.item_count), currencyId = numberText(row.cost_item_id);
    const costConfig = getRanchItem(currencyId), item = getRanchItem(itemId);
    const start = numberText(row.discount_start_time), end = numberText(row.discount_end_time);
    const asMs = value => { const n = small(value); return n > 0 && n < 100000000000 ? n * 1000 : n; };
    const discounted = asMs(start) > 0 && asMs(start) <= nowMs && nowMs < asMs(end);
    const price = numberText(discounted ? row.discount_price : row.cost_count);
    const limit = numberText(row.limit_count), used = numberText(row.limit_used);
    if (limit !== '0' && BigInt(used) > BigInt(limit)) error('兑换已用额度超过限额', 'RANCH_RESPONSE_MISMATCH');
    const remaining = limit === '0' ? null : (BigInt(limit) - BigInt(used)).toString();
    let conditionsKnown = true, requiredLevel = 0;
    for (const condition of row.buy_conds || []) {
        if (condition.type !== '最低等级' || !/^[1-9]\d*$/.test(String(condition.params || ''))) conditionsKnown = false;
        else requiredLevel = Math.max(requiredLevel, small(condition.params));
    }
    const expRows = [...(raw.bag.physical_items || []), ...(raw.bag.virtual_items || [])].filter(row => numberText(row.id) === '1102');
    const level = expRows.length ? ranchLevelInfo(quantity(raw.bag, '1102').toString())?.level ?? null : null;
    const balance = available(raw.bag, currencyId, raw.accountId);
    const max = remaining === null ? 999n : BigInt(remaining) < 999n ? BigInt(remaining) : 999n;
    const confirmed = !!item && !!costConfig && ['1005', '1008', '7002'].includes(currencyId) && [2, 108].includes(Number(costConfig.type))
        && itemCount !== '0' && price !== '0' && itemId !== currencyId && conditionsKnown;
    const ready = raw.market.opened === true && raw.market.present === true && raw.periodDay !== '0';
    const meetsLevel = requiredLevel === 0 || level !== null && level >= requiredLevel;
    const canExchange = confirmed && ready && meetsLevel && max > 0n && balance >= BigInt(price);
    const stateReason = !ready ? '集市未营业、未到访或周期未确认' : !confirmed ? '奖励、费用或兑换规则尚未核验'
        : !meetsLevel ? '牧场等级尚未达到或未确认' : max === 0n ? '本轮额度已用完'
            : balance < BigInt(price) ? '未锁定余额不足' : '';
    return { id, shelfId: small(row.shelf_id), slot: small(row.slot), name: item?.name || `物品 #${itemId}`,
        reward: { id: itemId, count: itemCount, name: item?.name || `物品 #${itemId}`, image: getRanchImage?.(itemId)?.url || '' },
        currencyId, currencyName: costConfig?.name || '币种未确认', currencyImage: getRanchImage?.(currencyId)?.url || '',
        unitPrice: price, currencyBalance: balance.toString(), limitCount: limit, limitUsed: used, remaining,
        maxCount: Number(max), requiredLevel: requiredLevel || null, discounted,
        priceValidUntilMs: discounted ? asMs(end) : null, available: canExchange, stateReason,
        identity: cardIdentity(row), raw: row };
}
async function loadMarketActionState(session, sceneReply) {
    clock(session, sceneReply);
    const market = await rpc(session, 'gamepb.shoppb.ShopService', 'RotationShopInfo',
        'RanchRotationShopInfoRequest', 'RanchRotationShopInfoReply', { shop_id: SHOP_ID });
    const periodDay = numberText(market.period_day), roundIndex = small(market.round_index);
    const inventory = await bag(session);
    const raw = { session, accountId: session.accountId, market, bag: inventory, cells: { facilities: [] },
        periodDay, roundIndex, ...clock(session) };
    const seen = new Set();
    raw.goods = (market.goods || []).map(row => {
        const item = decorateCard(row, raw, raw.serverTimeMs);
        if (seen.has(item.id)) error('集市出现重复商品ID', 'RANCH_RESPONSE_MISMATCH');
        seen.add(item.id); return item;
    });
    return raw;
}
function planExchange(input, raw) {
    const id = positive(input.goodsId, '兑换商品ID'), count = small(positive(input.count, '兑换数量'));
    if (count > 999) error('单次最多兑换999份', 'RANCH_INVALID_ARGUMENT');
    const good = raw.goods.find(row => row.id === id);
    const base = { action: 'exchange', label: '集市兑换', count: 0, payload: {}, costItems: [], expectedRewards: [], marker: {} };
    if (!good?.available) return { ...base, reason: good?.stateReason || '商品未返回或不可确认兑换', message: good?.stateReason || '当前无可确认商品' };
    if (count > good.maxCount || BigInt(good.unitPrice) * BigInt(count) > available(raw.bag, good.currencyId, raw.accountId)) {
        return { ...base, reason: '数量超额度或可用余额', message: '数量超出本轮额度或未锁定余额，未发送兑换' };
    }
    return { ...base, count, label: `兑换${good.name} ×${count}（商品 ${id}）`,
        payload: { goods_id: id, count, period_day: raw.periodDay, round_index: raw.roundIndex },
        costItems: [{ id: good.currencyId, count: (BigInt(good.unitPrice) * BigInt(count)).toString() }],
        expectedRewards: rewards([{ id: good.reward.id, count: (BigInt(good.reward.count) * BigInt(count)).toString() }]),
        marker: { dateKey: raw.dateKey, periodDay: raw.periodDay, roundIndex: raw.roundIndex, card: good.identity,
            currencyId: good.currencyId, rewardId: good.reward.id, limitCount: good.limitCount, used: good.limitUsed },
        message: `费用按服务端卡片与固定物品身份核验；周期 ${raw.periodDay} / 轮次 ${raw.roundIndex}。只兑换本次商品，不自动续买。` };
}
function verifyExchange(plan, reply, before, after) {
    const unknown = reason => error(`集市兑换未确认：${reason}；结果未确认；勿重复提交`, 'RANCH_OUTCOME_UNKNOWN', true);
    if (!reply.card || !after || after.dateKey !== plan.marker.dateKey || after.periodDay !== plan.marker.periodDay
        || after.roundIndex !== plan.marker.roundIndex) unknown('卡片、日期或轮次无法核验');
    const received = cardIdentity(reply.card), next = after.goods.find(row => row.id === plan.payload.goods_id);
    if (received !== plan.marker.card || !next || next.identity !== plan.marker.card) unknown('兑换商品、价格、条件或货架目标不匹配');
    if (rewardSignature(reply.awards || [], true) !== rewardSignature(plan.expectedRewards)) unknown('实际奖励为空或数量不符');
    const spent = quantity(before.bag, plan.marker.currencyId) - quantity(after.bag, plan.marker.currencyId);
    const gained = quantity(after.bag, plan.marker.rewardId) - quantity(before.bag, plan.marker.rewardId);
    if (spent !== BigInt(plan.costItems[0].count) || gained !== BigInt(plan.expectedRewards[0].count)) unknown('真实扣费或实物到账不符');
    const used = numberText(reply.card.limit_used), expected = BigInt(plan.marker.used) + BigInt(plan.count);
    if (next.limitUsed !== used || (plan.marker.limitCount !== '0' ? BigInt(used) !== expected
        : BigInt(used) !== BigInt(plan.marker.used) && BigInt(used) !== expected)) unknown('本轮兑换额度终态不符');
    return { rewards: rewards(reply.awards, true), completed: plan.count };
}
function key(accountId, view, focus = '') {
    const diagnostic = network.getDiagnosticSnapshot?.() || {}, gid = Number(network.getUserState?.()?.gid);
    if (String(diagnostic.accountId || '') !== String(accountId) || !Number.isSafeInteger(gid) || gid <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(Number(diagnostic.connectionEpoch))
        || Number(diagnostic.connectionEpoch) < 0 || diagnostic.connected !== true || diagnostic.loggedIn !== true) return '';
    return JSON.stringify([String(accountId), gid, diagnostic.connectionEpoch, diagnostic.remoteGeneration == null ? null : String(diagnostic.remoteGeneration),
        diagnostic.remoteGenerationSource || 'unknown', view, focus]);
}
async function cached(accountId, view, focus, cache, load) {
    const result = await cache.read({ keyOf: () => key(accountId, view, focus),
        states: () => [getSceneSessionSnapshot(accountId), getRanchFriendSessionSnapshot(accountId)],
        load: ({ onStart }) => withGameScene(2, async ({ session, sceneReply }) => {
            if (session.accountId !== String(accountId)) error('集市/活动读取账号不一致', 'ACCOUNT_OPERATION_CHANGED');
            clock(session, sceneReply);
            const value = await load(session);
            return { ...value, readOnly: true, sceneId: 2, ownerGid: String(session.gid), observedAt: Date.now(), ...clock(session), sourceCommit: SOURCE_COMMIT };
        }, { priority: 'foreground', timeoutMs: 155000, onStart }),
    });
    return { ...result.value, cache: { hit: result.hit, receivedAt: result.receivedAt } };
}
function getRanchMarket(accountId) {
    return cached(accountId, 'market', '', marketCache, async session => {
        const raw = await loadMarketActionState(session);
        return { shopId: SHOP_ID, opened: raw.market.opened === true, present: raw.market.present === true,
            periodDay: raw.periodDay, roundIndex: raw.roundIndex,
            shelves: (raw.market.shelves || []).map(row => ({ id: small(row.shelf_id), name: row.shelf_name, sort: small(row.sort) })),
            goods: raw.goods.map(({ raw: _raw, identity: _identity, ...row }) => row), automaticExchangeEnabled: false };
    });
}
function activityRows(nodes, parentId = '', seen = new Set()) {
    return (nodes || []).map(node => {
        const head = node.activity;
        if (!head) error('活动头部未返回', 'RANCH_RESPONSE_MISMATCH');
        const id = positive(head.activity_id, '活动ID');
        if (seen.has(id)) error('牧场活动ID重复', 'RANCH_RESPONSE_MISMATCH');
        seen.add(id);
        const ms = value => { const n = small(value); return n > 0 && n < 100000000000 ? n * 1000 : n || null; };
        const begin = ms(head.begin_time), end = ms(head.end_time);
        return { id, parentId, groupId: numberText(head.group_id), name: head.name || `活动 #${id}`,
            type: numberText(head.type), beginTimeMs: begin, endTimeMs: end, settlementTimeMs: ms(head.settle_start_time),
            actionsEnabled: false, progressState: 'unconfirmed',
            children: activityRows(node.children, id, seen) };
    });
}
function getRanchActivities(accountId, groupId = '') {
    return cached(accountId, 'activities', String(groupId), activityCache, async session => {
        const reply = await rpc(session, 'gamepb.activitypb.ActivityService', 'List',
            'RanchActivityListRequest', 'RanchActivityListReply', { game_scene_id: 2 });
        const activities = activityRows(reply.activities);
        let detail = null;
        if (groupId) {
            const selected = activities.find(row => row.id === String(groupId));
            if (!selected) error('该活动不在本次牧场目录，未读取其他场景活动', 'RANCH_ACTIVITY_UNAVAILABLE');
            const reply = await rpc(session, 'gamepb.activitypb.ActivityService', 'GetGroup',
                'RanchGetActivityGroupRequest', 'RanchGetActivityGroupReply', { group_id: selected.id });
            if (numberText(reply.group?.activity?.activity_id) !== selected.id) error('活动详情目标不匹配', 'RANCH_RESPONSE_MISMATCH');
            detail = activityRows([reply.group])[0];
        }
        let muge = null, mugeError = '';
        try { muge = await require('./ranch-muge').getRanchMugeActivityInSession(session, null); }
        catch (cause) { mugeError = String(cause?.message || '牧歌初启进度暂不可用').slice(0, 240); }
        return { activities, detail, actionsEnabled: false, guide: openingGuide, muge, mugeError,
            notice: '牧歌初启进度来自活动专属协议；其他牧场活动若没有对应协议，仍只展示目录。' };
    });
}
module.exports = { getRanchMarket, getRanchActivities, invalidateRanchActivitiesCache: () => activityCache.invalidate(),
    loadMarketActionState, planExchange, verifyExchange, cardIdentity, quantity };
