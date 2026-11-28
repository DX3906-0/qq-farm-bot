/**
 * 藏品（Collection）服务 —— 2026-11-03 新增
 *
 * 背景：公告 26110102（11-01）宣布 11-02 上线「果冻花园」藏品系统（125 级解锁），
 * 但项目里只有 collectionpb.proto（且注释标注已用官方 2026-11-01 编码器验证），
 * 没有任何服务层/接口 —— 这就是"前端看不到藏品"的真正原因。
 *
 * 协议要点（collectionpb.proto）：
 *   GetCollections(categories: int32[]) -> details: CategoryDetail[]
 *     CategoryDetail { category, collections[{collection_id,star_level,is_new,...}],
 *                      pedestals[], wished[], claimed_reward_score, current_score, ... }
 *   UpgradeCollection(category, collection_id) -> 激活/升星共用
 *   ClaimCollectionReward(category)
 *
 * 服务名已实测确认：gamepb.collectionpb.CollectionService。
 * 每次操作只发送一次请求，尤其不能用升星/领奖请求去探测服务名。
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { logWarn } = require('../utils/utils');

/**
 * 藏品配置富化：把 collection_id 对应的游戏配置（名称/图标/稀有度）补进来。
 * 藏品本体在 ItemInfo 里是 type=35（果冻精灵系列），id 段 700001~710xxx。
 * 拿不到配置时返回 null，前端用 id 兜底显示，不能因此让整个列表失败。
 */
function enrichCollection(collectionId) {
  try {
    const info = getItemById(collectionId);
    if (!info) return null;
    const iconRes = typeof info.icon_res === 'string' ? info.icon_res : '';
    return {
      name: info.name || '',
      desc: info.desc || '',
      iconRes,
      // icon_res 形如 gui/texture/collectIcon/icon_collect_5_1/spriteFrame
      // 只取 spriteFrame 前那一段做图片名，便于后续补图
      iconKey: iconRes ? (iconRes.split('/').slice(-2, -1)[0] || '') : '',
      image: getItemImageById(collectionId) || '',
      rarity: Number(info.rarity) || 0,
      rarityColor: info.rarity_color || '',
    };
  } catch (error) {
    logWarn('藏品', '读取藏品配置失败', { collectionId, error: error.message });
    return null;
  }
}

const COLLECTION_SERVICE = 'gamepb.collectionpb.CollectionService';

/**
 * 目录只补入已确认的分类 1，不改写其他分类，也不丢弃服务端新增的藏品。
 * 只读数据合并；不影响拥有状态、星级、评分或实际升级条件。
 */
function mergeCollectionCatalog(details, catalog, categories = []) {
  const defaultCategory = 1;
  if (catalog.length === 0 || (categories.length > 0 && !categories.includes(defaultCategory))) {
    return details;
  }

  let target = details.find((detail) => detail.category === defaultCategory);
  if (!target) {
    target = {
      category: defaultCategory,
      currentScore: 0,
      claimedRewardScore: 0,
      collectionLikeCount: 0,
      pedestalLikeCount: 0,
      collections: [],
      pedestals: [],
      wished: [],
    };
    details = [...details, target];
  }

  const ownedById = new Map(target.collections.map((item) => [item.collectionId, item]));
  const catalogIds = new Set(catalog.map((item) => item.collectionId));
  target.collections = [
    ...catalog.map((cfg) => ({
      ...cfg,
      starLevel: 0,
      isNew: false,
      ownCount: 0,
      firstObtainedTime: 0,
      owned: false,
      ...(ownedById.get(cfg.collectionId) || {}),
    })),
    ...target.collections.filter((item) => !catalogIds.has(item.collectionId)),
  ];
  return details;
}

/**
 * 拉取藏品列表。
 * @param {number[]} categories 分类过滤，空数组=全部
 */
async function getCollections(categories = []) {
  if (!types.GetCollectionsRequest) throw new Error('collectionpb 未加载');

  const req = types.GetCollectionsRequest.encode(
    types.GetCollectionsRequest.create({ categories: Array.isArray(categories) ? categories : [] })
  ).finish();

  const { body } = await sendMsgAsync(COLLECTION_SERVICE, 'GetCollections', req, 15000);
  const reply = types.GetCollectionsReply.decode(body);

  // 归一化：把 protobuf Long 转普通数字，方便前端直接用
  const num = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  let details = (reply.details || []).map((d) => ({
    category: num(d.category),
    currentScore: num(d.current_score),
    claimedRewardScore: num(d.claimed_reward_score),
    collectionLikeCount: num(d.collection_like_count),
    pedestalLikeCount: num(d.pedestal_like_count),
    collections: (d.collections || []).map((c) => {
      const cid = num(c.collection_id);
      const cfg = enrichCollection(cid);
      return {
        collectionId: cid,
        starLevel: num(c.star_level),
        isNew: c.is_new === true,
        ownCount: num(c.own_count),
        firstObtainedTime: num(c.first_obtained_time),
        // 配置富化（可能为 null，前端需兜底）
        name: cfg?.name || `藏品${cid}`,
        desc: cfg?.desc || '',
        image: cfg?.image || '',
        iconRes: cfg?.iconRes || '',
        iconKey: cfg?.iconKey || '',
        rarity: cfg?.rarity || 0,
        rarityColor: cfg?.rarityColor || '',
        owned: num(c.own_count) > 0 || num(c.star_level) > 0,
      };
    }),
    pedestals: (d.pedestals || []).map((p) => ({
      pedestalId: num(p.pedestal_id),
      isNew: p.is_new === true,
    })),
    wished: (d.wished || []).map((w) => ({
      seriesId: num(w.series_id),
      collectionId: num(w.collection_id),
      cooldownUntil: num(w.cooldown_until),
    })),
  }));

  // GetCollections 只下发玩家状态；低等级账号也应看到未获得的完整目录。
  details = mergeCollectionCatalog(details, getCollectionCatalog(), categories);

  const displaySlots = (reply.display_slots || []).map((s) => ({
    slotType: num(s.slot_type), itemId: num(s.display?.item_id), pedestalId: num(s.display?.pedestal_id),
  }));
  const displayItemId = displaySlots.find(slot => slot.slotType === 1)?.itemId || 0;
  // Static rules enrich the existing data contract; missing rules are explicit, not invented costs.
  let rulesWarning = '';
  try {
    const { applyRules } = require('./collection-rules');
    details = details.map(detail => applyRules(detail, displayItemId));
  } catch (error) {
    rulesWarning = `藏品规则暂不可用：${error.message}`;
    logWarn('藏品', rulesWarning);
  }
  return { details, displaySlots, service: COLLECTION_SERVICE, rulesWarning };
}

function commands() {
  if (!commands.scope) commands.scope = require('./game-command').createGameCommandScope('collection');
  return commands.scope;
}
function assertCollectionLevel() {
  const { validation } = require('./game-command');
  const level = Number(require('../utils/network').getUserState()?.level);
  if (!Number.isSafeInteger(level) || level < 125) throw validation('藏品需125级解锁，当前等级未达标或未同步');
}
function costSignature(costs) { return costs.map(item => `${item.itemId}:${item.count}`).sort().join('|'); }

/** Activation/upgrade shares the RPC, but each star has its own verified costs. */
async function upgradeCollection(category, collectionId, expected = {}) {
  const { positiveId, quantity, validation, unknown } = require('./game-command');
  const id = positiveId(collectionId, '藏品编号');
  if (Number(category) !== 1) throw validation('当前仅支持已验证藏品分类1');
  return commands().execute(async session => {
    assertCollectionLevel();
    const before = await getCollections([1]);
    const detail = before.details.find(value => value.category === 1);
    const item = detail?.collections.find(value => value.collectionId === id);
    if (!item?.canUpgrade || !item.nextStarCosts?.length) throw validation('藏品未解锁、材料不足或已满星');
    if (detail.rulesAvailable !== true || expected.expectedStarLevel !== item.starLevel || !Array.isArray(expected.expectedCosts)
        || costSignature(expected.expectedCosts) !== costSignature(item.nextStarCosts)) throw validation('星级或消耗材料已变化，请重新确认');
    const warehouse = require('./warehouse');
    const getBalances = async () => {
      const bag = warehouse.getBagItems(await warehouse.getBag());
      return new Map(item.nextStarCosts.map(cost => [cost.itemId, bag.filter(entry => Number(entry.id) === cost.itemId && !warehouse.isItemLocked(entry))
        .reduce((sum, entry) => sum + BigInt(quantity(entry.count)), 0n)]));
    };
    const balances = await getBalances();
    for (const cost of item.nextStarCosts) {
      const available = cost.itemId === id ? BigInt(quantity(item.ownCount)) : balances.get(cost.itemId);
      if (available < BigInt(quantity(cost.count))) throw validation(`${cost.name}不足或已锁定`);
    }
    const key = `upgrade:${id}:${item.starLevel}`;
    const reply = await commands().rpc(session, COLLECTION_SERVICE, 'UpgradeCollection', 'UpgradeCollectionRequest', 'UpgradeCollectionReply',
      { category: 1, collection_id: String(id) }, { write: true, key });
    const copies = item.nextStarCosts.find(cost => cost.itemId === id);
    const star = Number(reply.star_level);
    if (Number(reply.category) !== 1 || Number(reply.collection_id) !== id || star !== item.starLevel + 1
        || BigInt(quantity(reply.own_count)) !== BigInt(quantity(item.ownCount)) - BigInt(quantity(copies.count))) throw unknown();
    const refreshed = await getCollections([1]);
    const confirmed = refreshed.details.find(value => value.category === 1)?.collections.find(value => value.collectionId === id);
    if (!confirmed || confirmed.starLevel !== star || confirmed.ownCount !== Number(reply.own_count)
        || refreshed.details[0].currentScore !== Number(reply.current_score)
        || Number(reply.current_score) !== detail.currentScore - item.score + confirmed.score) throw unknown();
    const after = await getBalances();
    for (const cost of item.nextStarCosts.filter(cost => cost.itemId !== id)) {
      if (after.get(cost.itemId) !== balances.get(cost.itemId) - BigInt(quantity(cost.count))) throw unknown('藏品已响应，但材料变化未确认；暂不重复操作，刷新只读取当前材料');
    }
    commands().confirm(session, key);
    return { category: 1, collectionId: id, starLevel: star, currentScore: Number(reply.current_score),
      ownCount: Number(reply.own_count), resultState: 'completed', costs: item.nextStarCosts, accountId: session.accountId };
  });
}

async function claimCollectionReward(category) {
  const { validation, unknown } = require('./game-command');
  if (Number(category) !== 1) throw validation('当前仅支持已验证藏品分类1');
  return commands().execute(async session => {
    assertCollectionLevel();
    const before = (await getCollections([1])).details.find(value => value.category === 1);
    const eligible = (before?.milestones || []).filter(step => step.reached && !step.claimed);
    if (!eligible.length) return { skipped: true, reason: 'no_claimable_rewards' };
    const targetScore = eligible[eligible.length - 1].score;
    const key = `claim:${targetScore}`;
    const reply = await commands().rpc(session, COLLECTION_SERVICE, 'ClaimCollectionReward', 'ClaimCollectionRewardRequest', 'ClaimCollectionRewardReply',
      { category: 1 }, { write: true, key });
    if (Number(reply.claimed_reward_score) < targetScore || Number(reply.claimed_reward_score) > Number(reply.current_score)) throw unknown();
    commands().confirm(session, key);
    return { totalRewards: (reply.total_rewards || []).map(item => ({ id: Number(item.id), count: Number(item.count) })),
      currentScore: Number(reply.current_score), claimedRewardScore: Number(reply.claimed_reward_score),
      claimedScores: (reply.claimed_scores || []).map(Number), resultState: 'completed', accountId: session.accountId };
  });
}

async function setCollectionDisplay(input = {}) {
  const { positiveId, validation, unknown } = require('./game-command');
  const id = positiveId(input.collectionId, '藏品编号');
  if (typeof input.displayed !== 'boolean' || input.confirmed !== true) throw validation('请确认展示或取消展示');
  return commands().execute(async session => {
    assertCollectionLevel();
    const before = await getCollections([1]);
    const item = before.details[0]?.collections.find(value => value.collectionId === id);
    if (!item?.activated) throw validation('请先激活藏品');
    const current = before.displaySlots.find(slot => slot.slotType === 1)?.itemId || 0;
    if (Number(input.expectedDisplayItemId) !== current) throw validation('展示藏品已变化，请刷新后确认');
    if ((input.displayed && current === id) || (!input.displayed && current !== id)) return { skipped: true, reason: 'already_in_target_state' };
    const target = input.displayed ? id : 0;
    const key = 'display-slot-1';
    const reply = await commands().rpc(session, COLLECTION_SERVICE, 'SwitchSceneDisplay', 'SwitchSceneDisplayRequest', 'SwitchSceneDisplayReply',
      { display_slot: { slot_type: 1, display: { category: 1, item_id: String(target) } } }, { write: true, key });
    if (Number(reply.display_slot?.slot_type) !== 1 || Number(reply.display_slot?.display?.category) !== 1
        || Number(reply.display_slot?.display?.item_id) !== target) throw unknown();
    commands().confirm(session, key);
    return { displayed: input.displayed, itemId: target, resultState: 'completed', accountId: session.accountId };
  });
}

/**
 * 藏品总目录：从 ItemInfo.json 取 type=35 的全部条目（30 个果冻精灵）。
 * 用于前端展示"图鉴"——玩家未获得的藏品也要能看到名称/稀有度。
 * 直接读配置文件，因为 gameConfig 只导出了 getItemById，没有遍历接口。
 */
let catalogCache = null;

function getCollectionCatalog() {
  if (catalogCache) return catalogCache;
  try {
    const path = require('path');
    const fs = require('fs');
    // gameConfig 目录与本文件同级往上：services/ -> src/gameConfig/
    const file = path.join(__dirname, '..', 'gameConfig', 'ItemInfo.json');
    if (!fs.existsSync(file)) throw new Error('藏品物品配置文件缺失');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    catalogCache = list
      .filter((it) => it && Number(it.type) === 35)
      .map((it) => {
        const id = Number(it.id) || 0;
        const iconRes = typeof it.icon_res === 'string' ? it.icon_res : '';
        return {
          collectionId: id,
          name: it.name || `藏品${id}`,
          desc: it.desc || '',
          iconRes,
          iconKey: iconRes ? (iconRes.split('/').slice(-2, -1)[0] || '') : '',
          image: getItemImageById(id) || '',
          rarity: Number(it.rarity) || 0,
          rarityColor: it.rarity_color || '',
        };
      })
      .sort((a, b) => a.collectionId - b.collectionId);
    return catalogCache;
  } catch (error) {
    logWarn('藏品', '读取藏品目录失败', { error: error.message });
    throw error;
  }
}

module.exports = {
  getCollections,
  upgradeCollection,
  claimCollectionReward,
  setCollectionDisplay,
  getCollectionCatalog,
  COLLECTION_SERVICE,
};