'use strict';

const { getItemById, getItemImageById } = require('../config/gameConfig');
const { createGameCommandScope, captureSession, positiveId, validation, unknown } = require('./game-command');
const SERVICE = 'gamepb.redpacketpb.RedPacketService';
const scope = createGameCommandScope('openserver');
async function status(session) {
    const reply = await scope.rpc(session, SERVICE, 'GetTodayClaimStatus', 'GetTodayClaimStatusRequest', 'GetTodayClaimStatusReply', {}, { allowEmpty: true });
    const packets = (reply.infos || []).map(item => ({ id: positiveId(item.id, '红包编号'), canClaim: item.can_claim === true }));
    if (new Set(packets.map(item => item.id)).size !== packets.length) throw validation('红包状态编号重复');
    return { accountId: session.accountId, packets, message: packets.length ? '' : '服务器未返回可用开服红包，不按日期推断开放。' };
}
async function getOpenServerGifts() { return status(captureSession()); }
async function claimOpenServerGift(id) {
    const packetId = positiveId(id, '红包编号');
    return scope.execute(async session => {
        const before = await status(session);
        if (!before.packets.find(item => item.id === packetId)?.canClaim) throw validation('当前红包不可领取');
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const key = `packet:${packetId}:${date}`;
        const reply = await scope.rpc(session, SERVICE, 'ClaimRedPacket', 'ClaimRedPacketRequest', 'ClaimRedPacketReply', { id: packetId }, { write: true, key });
        const item = reply.item;
        if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= 0 || Number(item.count) <= 0) throw unknown('红包回包未返回实际奖励，不能当作成功');
        scope.confirm(session, key);
        return { accountId: session.accountId, resultState: 'completed', rewards: [{ id: Number(item.id), count: Number(item.count),
            name: getItemById(Number(item.id))?.name || `物品${item.id}`, image: getItemImageById(Number(item.id)) || '' }] };
    });
}
module.exports = { getOpenServerGifts, claimOpenServerGift, SERVICE };
