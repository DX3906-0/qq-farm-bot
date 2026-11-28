'use strict';

const fs = require('node:fs');
const { getResourcePath } = require('../config/runtime-paths');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { quantity, positiveId, validation } = require('./game-command');
const { buildMutationCatalog } = require('./mutation-catalog-data');
let cache;
function configs() {
    if (!cache) {
        const names = ['CollectionSeries', 'CollectionItem', 'CollectionStarLevelNeed', 'CollectionScore',
            'CollectionScoreReward', 'CollectionCondition', 'CollectionGroup', 'CollectionPedestal', 'MutantPublicity'];
        const result = {};
        for (const name of names) {
            const value = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'collections', `${name}.json`), 'utf8'));
            if (!Array.isArray(value)) throw validation(`藏品配置无效：${name}`);
            result[name] = value;
        }
        result.source = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'collections', 'sources.json'), 'utf8'));
        cache = result;
    }
    return cache;
}
function parseCosts(text, collectionId) {
    if (!text) return [];
    return String(text).split(';').map(part => {
        const [rawId, rawCount] = part.split(':');
        const itemId = rawId === '0' ? collectionId : positiveId(rawId, '材料编号');
        const count = quantity(rawCount, '材料数量');
        if (BigInt(count) <= 0n) throw validation('藏品材料数量必须大于零');
        return { itemId, count: Number(count) <= Number.MAX_SAFE_INTEGER ? Number(count) : count,
            name: getItemById(itemId)?.name || `物品${itemId}`, image: getItemImageById(itemId) || '' };
    });
}
function requirements(ids, owned) {
    const cfg = configs();
    return String(ids || '').split(';').filter(Boolean).map(id => {
        const definition = cfg.CollectionCondition.find(value => Number(value.condition_id) === Number(id));
        if (!definition || Number(definition.condition_type) !== 3) return { met: false, text: `解锁条件${id}尚未适配`, supported: false };
        const series = cfg.CollectionSeries.find(value => Number(value.series_id) === Number(definition.target_series_id));
        const needed = Number(definition.required_count);
        const star = Number(definition.required_star_level);
        const itemIds = cfg.CollectionItem.filter(value => Number(value.series_id) === Number(definition.target_series_id)).map(value => Number(value.item_id));
        const current = itemIds.filter(itemId => Number(owned.get(itemId)?.starLevel || 0) >= star).length;
        return { met: current >= needed, text: `${series?.series_name || definition.target_series_id}系列至少${needed}款达到${star}星（当前${current}款）`, supported: true };
    });
}
function scoreFor(star, rarity) {
    if (!star) return 0;
    const row = configs().CollectionScore.find(value => Number(value.star_level) === star);
    return Number(String(row?.score || '').split(';')[rarity - 1]) || 0;
}
function itemRules(item, owned, displayItemId = 0) {
    const cfg = configs();
    const entry = cfg.CollectionItem.find(value => Number(value.item_id) === Number(item.collectionId));
    const series = cfg.CollectionSeries.find(value => Number(value.series_id) === Number(entry?.series_id));
    const star = Number(item.starLevel) || 0;
    const conditions = [...requirements(series?.unlock_condition_ids, owned), ...requirements(entry?.unlock_condition_ids, owned)];
    const next = cfg.CollectionStarLevelNeed.find(value => Number(value.series_id) === Number(entry?.series_id) && Number(value.star_level) === star + 1);
    const costs = parseCosts(next?.items_need, item.collectionId);
    const copies = costs.find(cost => cost.itemId === item.collectionId);
    const available = quantity(item.ownCount);
    return { ...item, activated: star > 0, owned: star > 0 || BigInt(available) > 0n,
        seriesId: Number(series?.series_id) || 0, seriesName: series?.series_name || '',
        rarity: Number(series?.series_rarity) || item.rarity || 0, requirements: conditions,
        nextStarCosts: costs, score: scoreFor(star, Number(series?.series_rarity) || 0),
        unlocked: !!entry && !!series && conditions.every(condition => condition.met),
        canUpgrade: !!entry && !!series && conditions.every(condition => condition.met) && star < 5 && !!copies
            && BigInt(available) >= BigInt(quantity(copies.count)),
        displayed: Number(displayItemId) === Number(item.collectionId) };
}
function milestones(score, claimedScore, category = 1) {
    const cfg = configs();
    const buffs = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'BuffCfg.json'), 'utf8'));
    return cfg.CollectionScoreReward.filter(row => Number(row.category) === category).sort((a, b) => a.score - b.score).map(row => ({
        score: row.score, reached: score >= row.score, claimed: claimedScore >= row.score,
        rewards: parseCosts(row.rewards, 0), buffs: buffs.filter(buff => buff.source_type === '藏品属性' && Number(buff.source_param) === row.level)
            .map(buff => ({ name: String(buff.attr_id), value: Number(buff.attr_value) / 100,
                description: buff.attr_id === '节省10%肥料' ? `${Number(buff.attr_value) / 100}%概率节省10%肥料` : `${buff.attr_id} +${Number(buff.attr_value) / 100}%` })),
    }));
}
function applyRules(detail, displayItemId) {
    const owned = new Map(detail.collections.map(item => [Number(item.collectionId), item]));
    const steps = milestones(detail.currentScore, detail.claimedRewardScore, detail.category);
    const buffMap = new Map();
    for (const step of steps.filter(value => value.claimed)) for (const buff of step.buffs) buffMap.set(buff.name, buff);
    return { ...detail, collections: detail.collections.map(item => itemRules(item, owned, displayItemId)),
        milestones: steps, currentBuffs: [...buffMap.values()], rulesAvailable: true,
        seriesRules: configs().CollectionSeries.filter(series => Number(series.category) === detail.category).map(series => ({
            seriesId: series.series_id, name: series.series_name, description: series.desc,
            groups: configs().CollectionGroup.filter(group => group.series_id === series.series_id).map(group => ({
                name: group.group_name, probability: Number((group.public_probability / 100).toFixed(1)), guarantee: group.display_guarantee })),
        })) };
}
function getMutationCatalog() {
    const raw = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'MutantEffect.json'), 'utf8'));
    return buildMutationCatalog(raw, configs(), getItemById, getItemImageById);
}
module.exports = { configs, parseCosts, itemRules, applyRules, getMutationCatalog };
