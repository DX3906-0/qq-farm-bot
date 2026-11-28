'use strict';

const goods = require('../gameConfig/ranch/Goods.json');
const items = require('../gameConfig/ranch/MCItemInfo.json');
const animals = require('../gameConfig/ranch/MCAnimalConfig.json');
const facilities = require('../gameConfig/ranch/MCFacilityConfig.json');
const ranchFacilities = require('../gameConfig/ranch/MCRanchFacilityConfig.json');
const cans = require('../gameConfig/ranch/MCCanConfig.json');
const levels = require('../gameConfig/ranch/BigFarmLevel.json');
const mutations = require('../gameConfig/ranch/MCAnimalMutation.json');
// MCTask is the complete home-task subset of the pinned table, not the farm rows.
const tasks = require('../gameConfig/ranch/MCTask.json');
const weightTiers = require('../gameConfig/ranch/MCRanchWeightTier.json');
const mutationRules = require('../gameConfig/ranch/MCMutantInfo.json');

const SOURCE_COMMIT = '6ac7a3d7930018058d201af86beea8de6a9f8507';

if (![goods, items, animals, facilities, ranchFacilities, cans, levels, mutations, tasks, weightTiers, mutationRules].every(Array.isArray)) {
    throw new TypeError('牧场配置格式错误');
}

const goodsMap = new Map(goods.map(row => [Number(row.id), Object.freeze({ ...row })]));
const itemMap = new Map(items.map(row => [Number(row.id), Object.freeze({ ...row })]));
const animalMap = new Map(animals.map(row => [Number(row.id), Object.freeze({ ...row })]));
const giantProductMap = new Map();
for (const mutation of mutations) {
    const animal = animalMap.get(Number(mutation.animal_id));
    const productId = Number(animal?.product_item?.id);
    const giantProductId = Number(mutation.giant_product_item);
    if (!animal || !productId || !giantProductId || giantProductMap.has(productId)) continue;
    giantProductMap.set(productId, Object.freeze({ animal, itemId: giantProductId }));
}
const cubMap = new Map(animals.map(row => [Number(row.cub_item_id), Object.freeze({ ...row, giantCubItemId: 0 })]));
for (const mutation of mutations) {
    const animal = animalMap.get(Number(mutation.animal_id));
    if (!animal || !Number(mutation.giant_cub_item_id) || cubMap.has(Number(mutation.giant_cub_item_id))) {
        throw new TypeError('巨大幼崽映射不完整或重复');
    }
    cubMap.set(Number(mutation.giant_cub_item_id), Object.freeze({ ...animal, giantCubItemId: Number(mutation.giant_cub_item_id) }));
}
const canMap = new Map(cans.map(row => [Number(row.id), Object.freeze({ ...row,
    bucketId: row.feed_type === '有机罐头' ? 7004 : row.feed_type === '无机罐头' ? 7003 : 0 })]));
const facilityMap = new Map(facilities.map(row => [Number(row.facility_id), Object.freeze({ ...row })]));
const ranchFacilityMap = new Map(ranchFacilities.map(row => [Number(row.id), Object.freeze({ ...row })]));
const taskMap = new Map(tasks.map(row => [String(row.id), Object.freeze({ ...row,
    category: Number(row.group) === 2001 ? 'growth' : 'daily' })]));
if (taskMap.size !== tasks.length) throw new TypeError('牧场任务配置ID重复');
const weightTierMap = new Map(weightTiers.map(row => [Number(row.tier), Object.freeze({ ...row })]));
const ranchMutationRules = Object.freeze(mutationRules.map(row => Object.freeze({ ...row })));

function getRanchGoods(goodsId) {
    return goodsMap.get(Number(goodsId));
}

function getRanchItem(itemId) {
    return itemMap.get(Number(itemId));
}

function findRanchGoods(shopId, itemId) {
    return goods.find(row => Number(row.shop_id) === Number(shopId) && Number(row.item_id) === Number(itemId));
}

function getRanchAnimal(animalId) {
    return animalMap.get(Number(animalId));
}

function getRanchAnimalByCubItem(itemId) {
    return cubMap.get(Number(itemId));
}

function getRanchGiantProduct(productItemId) {
    const mapping = giantProductMap.get(Number(productItemId));
    return mapping ? { animal: mapping.animal, itemId: mapping.itemId, item: getRanchItem(mapping.itemId) } : undefined;
}

function getRanchCan(itemId) {
    return canMap.get(Number(itemId));
}

function ranchLevelInfo(exp) {
    const text = String(exp ?? '');
    if (!/^\d+$/.test(text)) return null;
    const amount = BigInt(text);
    const current = [...levels].reverse().find(row => amount >= BigInt(row.exp));
    if (!current) return null;
    const next = levels.find(row => Number(row.level) === Number(current.level) + 1);
    return { level: Number(current.level), exp: amount.toString(), currentExp: (amount - BigInt(current.exp)).toString(),
        neededExp: next ? String(Number(next.exp) - Number(current.exp)) : null };
}

function getRanchFacility(facilityId) {
    return facilityMap.get(Number(facilityId));
}

function getRanchFacilityLimits(husbandryType) {
    const id = Number(husbandryType) === 1 ? 6001001 : Number(husbandryType) === 2 ? 6002001 : 0;
    return ranchFacilityMap.get(id);
}

function isRanchSellableProduct(itemId) {
    const item = getRanchItem(itemId);
    return !!item && [106, 107].includes(Number(item.type));
}

module.exports = {
    SOURCE_COMMIT,
    getRanchGoods,
    findRanchGoods,
    getRanchItem,
    getRanchAnimal,
    getRanchAnimalByCubItem,
    getRanchGiantProduct,
    getRanchCan,
    getRanchImage: (id, facility = false) => {
        const row = facility ? getRanchFacility(id) : getRanchItem(id);
        const resource = String((facility ? row?.icon_asset : row?.icon_res) || (!facility && row?.asset_name ? `texture/${row.asset_name}` : ''))
            .replace(/\/(spriteFrame|texture)$/, '');
        return resource ? require('./ranch-art').image(id, facility, resource) : null;
    },
    getRanchMutation: animalId => mutations.find(row => Number(row.animal_id) === Number(animalId)),
    getRanchTask: taskId => taskMap.get(String(taskId)),
    getRanchWeightTier: tier => weightTierMap.get(Number(tier)),
    getRanchMutationRules: () => ranchMutationRules.map(row => ({ ...row })),
    ranchLevelInfo,
    getRanchFacility,
    getRanchFacilityLimits,
    isRanchSellableProduct,
};
