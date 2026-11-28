const { getItemById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');
const { createModuleLogger } = require('./logger');

const DOG_SKILL_GIFT_ITEM_ID = 101351;
const logger = createModuleLogger('dog');
let pendingClaim = null;

function decodeDogReply(type, response) {
  if (!response || response.error || response.ok === false) throw new Error(response?.error || '宠物请求失败');
  const code = response.meta?.error_code ?? response.meta?.errorCode;
  if (toNum(code) !== 0) throw new Error(`宠物请求失败，错误码 ${toNum(code)}`);
  const body = response.body ?? response;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return type.decode(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('宠物响应格式异常');
  // RPC 若已返回 Message/对象，直接使用；repeated Message 同样不能二次 decode。
  return body;
}

async function getDogInfo() {
  try {
    const payload = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
    const reply = decodeDogReply(types.GetDogInfoReply, await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', payload));
    const dogs = reply.dog_list ?? reply.dogList;
    if (!Array.isArray(dogs) || dogs.some(dog => !dog || toNum(dog.id) <= 0)) {
      throw new Error('宠物响应缺少有效 dog_list，无法确认拥有状态');
    }
    if (!dogs.length) throw new Error('宠物响应返回空 dog_list，拥有状态尚未确认');
    return reply;
  } catch (error) {
    logger.warn(`获取宠物信息失败: ${error?.message || error}`);
    throw error;
  }
}

async function claimSkillGifts(options = {}) {
  return require('./pets').withPetCommand(async (lease) => {
    const pending = getPendingGiftCount(await lease.read(getDogInfo));
    if (!pending) return { rewards: [], claimed_gift_count: 0, pending_gift_count: 0 };
    const payload = types.ClaimSkillGiftsRequest.encode(types.ClaimSkillGiftsRequest.create({})).finish();
    return lease.write('gamepb.dogpb.DogService', 'ClaimSkillGifts', payload, response => {
      const reply = decodeDogReply(types.ClaimSkillGiftsReply, response);
      if (!Array.isArray(reply.rewards) || (reply.claimed_gift_count ?? reply.claimedGiftCount) == null
        || (reply.pending_gift_count ?? reply.pendingGiftCount) == null) throw new Error('技能礼包响应不完整');
      const completion = lease.confirm();
      logger.info('技能礼包领取响应已确认', { ...completion, claimed: toNum(reply.claimed_gift_count ?? reply.claimedGiftCount) });
      return reply;
    });
  }, { source: 'gifts', ...options });
}

function getPendingGiftCount(reply) {
  const count = reply?.pending_gift_count ?? reply?.pendingGiftCount;
  if (count == null) throw new Error('宠物响应缺少待领取礼包计数');
  return Math.max(0, toNum(count));
}

async function checkAndClaimDogSkillGifts(pendingCountHint) {
  if (pendingClaim) return pendingClaim;

  const request = (async () => {
    try {
      const reply = await claimSkillGifts();
      const rewards = reply.rewards;
      if (!Array.isArray(rewards) || (reply.claimed_gift_count ?? reply.claimedGiftCount) == null
        || (reply.pending_gift_count ?? reply.pendingGiftCount) == null) throw new Error('技能礼包响应不完整');
      const item = rewards.find(reward => toNum(reward?.id) === DOG_SKILL_GIFT_ITEM_ID) || rewards[0] || null;
      const claimed = Math.max(0, toNum(reply.claimed_gift_count ?? reply.claimedGiftCount));
      const itemId = toNum(item && item.id);
      const itemName = getItemById(itemId)?.name || (itemId > 0 ? `物品#${itemId}` : '同气连枝礼包');
      if (claimed > 0) logger.info(`拾取${itemName} x${claimed}`, { itemId, count: claimed });
      return { claimed, pending: Math.max(0, toNum(reply.pending_gift_count ?? reply.pendingGiftCount)), item, rewards, compensatedItems: reply.compensated_items ?? reply.compensatedItems ?? [] };
    } catch (error) {
      logger.warn(`拾取同气连枝礼包失败: ${error?.message || error}`);
      if (error.outcome === 'unknown') throw error;
      return {
        claimed: 0,
        pending: Math.max(0, toNum(pendingCountHint)),
        item: null,
        error: String(error?.message || error)
      };
    }
  })();

  pendingClaim = request;
  try {
    return await request;
  } finally {
    if (pendingClaim === request) pendingClaim = null;
  }
}

module.exports = {
  DOG_SKILL_GIFT_ITEM_ID,
  decodeDogReply,
  getDogInfo,
  claimSkillGifts,
  getPendingGiftCount,
  checkAndClaimDogSkillGifts
};
