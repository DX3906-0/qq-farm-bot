'use strict';

const { createGameCommandScope, positiveId, quantity, validation, unknown, validateSession } = require('./game-command');
const scope = createGameCommandScope('firework');
const ITEM_ID = 6001;
async function farm(session) {
    const reply = await scope.rpc(session, 'gamepb.plantpb.PlantService', 'AllLands', 'AllLandsRequest', 'AllLandsReply', {});
    if (!(reply.lands || []).length) throw validation('农场土地未完整加载，不能燃放烟花');
    const events = (reply.farm_social_events || []).filter(item => Number(item.item_id) === ITEM_ID);
    if (events.length > 1) throw validation('烟花状态不唯一，请先刷新');
    return events[0] || null;
}
async function useFirework(count, requestedUid) {
    if (count !== 1) throw validation('每次只能燃放一枚烟花');
    return scope.execute(async session => {
        const before = await farm(session);
        if (before && Number(before.phase) !== 0) throw validation('已有烟花处于燃放状态，请先等待完成');
        if (before && Number(before.phase) === 0) throw unknown('已有未确认点燃的烟花，保留现场，不自动重放点燃');
        const warehouse = require('./warehouse');
        const bag = warehouse.getBagItems(await warehouse.getBag());
        const item = bag.find(entry => Number(entry.id) === ITEM_ID && !warehouse.isItemLocked(entry)
            && BigInt(quantity(entry.count)) > 0n && (requestedUid == null || quantity(entry.uid) === quantity(requestedUid)));
        if (!item) throw validation('烟花不足、已锁定或实例不存在');
        const uid = quantity(item.uid);
        const key = 'firework';
        const placed = await scope.rpc(session, 'gamepb.itempb.ItemService', 'Use', 'UseRequest', 'UseReply', {
            item: { id: String(ITEM_ID), count: '1', uid }, target: { host_gid: session.gid, use_config_id: 0 },
        }, { write: true, key });
        if (!(placed.used_items || []).some(entry => Number(entry.id) === ITEM_ID && Number(entry.count) === 1)) throw unknown('烟花放置回包未确认消耗，暂不重复提交；刷新只读取当前烟花状态');
        const event = await farm(session);
        if (!event || Number(event.phase) !== 0) throw unknown('烟花放置状态未确认，不能继续点燃');
        validateSession(session);
        const igniteKey = `${key}:ignite`;
        await scope.rpc(session, 'gamepb.plantpb.PlantService', 'Farming', 'FarmingRequest', 'FarmingReply', {
            host_gid: session.gid, host_type: 0, reason: 0, clear_farm_social_item_ids: [String(ITEM_ID)],
        }, { write: true, key: igniteKey, allowEmpty: true });
        const ignited = await farm(session);
        if (!ignited || Number(ignited.phase) === 0) throw unknown('点燃结果未确认，禁止再消耗或重放，暂不重复提交；刷新只读取当前烟花状态');
        scope.confirm(session, igniteKey);
        scope.confirm(session, key);
        return { accountId: session.accountId, resultState: 'completed', firework: true, usedCount: 1, rewards: [] };
    });
}
module.exports = { useFirework, ITEM_ID };
