'use strict';

const { getItemById, getItemImageById } = require('../config/gameConfig');
const { toNum, getServerTimeSec } = require('../utils/utils');
const { createGameCommandScope, positiveId, validation, unknown, blockedUnknown, own } = require('./game-command');

// Official ShopRedHelper.fetchDressShop uses ShopInfo(shop_id=4).
// liyangpengs/qq-farm-bot b3c10208 commerce.ts confirms its 1005 currency.
// This is NOT MallService slot_type=4, which is the SVIP mall.
const DECORATION_SHOP_ID = 4;
const DECORATION_CURRENCY_ID = 1005;
const DECORATION_ITEM_TYPES = new Set([10, 18]); // ItemInfo: avatar frame, skin.
const scope = createGameCommandScope('decoration-shop');
const operationKey = goodsId => `BuyGoods:${goodsId}`;

function integer(value) {
    if (value == null || typeof value === 'boolean' || value === '') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
    if (typeof value === 'object' && typeof value.toNumber !== 'function'
        && !(Number.isInteger(value.low) && Number.isInteger(value.high))) return null;
    const number = toNum(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function buildDecorationGoods(raw, options = {}) {
    const now = options.now ?? getServerTimeSec();
    const id = integer(raw?.id);
    const itemId = integer(raw?.item_id);
    const itemCount = integer(raw?.item_count);
    const item = itemId > 0 ? getItemById(itemId) : null;
    const itemType = integer(item?.type);
    const isSeed = itemType === 5;
    const isForage = isSeed && itemId === 20040;
    // Shop 4 is a catalog source, not an item category or universal currency.
    // Its seed listing does not prove that seeds use the wardrobe's 1005 wallet.
    const currencyKnown = DECORATION_ITEM_TYPES.has(itemType);
    const currencyId = currencyKnown ? DECORATION_CURRENCY_ID : null;
    const currencyName = currencyKnown ? '金豆豆' : '';
    const basePrice = own(raw, 'price') ? integer(raw.price) : null;
    const start = integer(raw?.discount_start_time) || 0;
    const end = integer(raw?.discount_end_time) || 0;
    const promotionActive = start > 0 && end > start && start <= now && now < end;
    // A positive, active promotion window is required before an omitted proto3
    // discount_price=0 is interpreted as free. Missing base prices are not free.
    const discountPrice = promotionActive ? integer(raw?.discount_price ?? 0) : null;
    const price = promotionActive ? discountPrice : basePrice;
    const endTime = integer(raw?.end_time) || 0;
    const expired = endTime > 0 && now >= endTime;
    const limitCount = integer(raw?.limit_count) || 0;
    const boughtNum = integer(raw?.bought_num) || 0;
    const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
    const owned = raw?.owned === true || raw?.owned === 1;
    const unlocked = raw?.unlocked === true || raw?.unlocked === 1;
    const resultUnknown = options.resultUnknown === true;
    const contentKnown = id > 0 && itemId > 0 && itemCount > 0 && !!item;
    const priceKnown = price !== null;
    const countdownUnknown = raw?.is_display_countdown === true && endTime === 0;
    const requiredLevel = Math.max(0, ...(Array.isArray(raw?.conds) ? raw.conds : [])
        .filter(condition => Number(condition?.type) === 1)
        .map(condition => integer(condition.param) || 0));
    let availability = 'available';
    let unavailableReason = '';
    if (resultUnknown) { availability = 'unknown'; unavailableReason = '上次购买结果未确认，请只刷新核对，不要重复购买'; }
    else if (owned) { availability = 'owned'; unavailableReason = '已拥有该商品'; }
    else if (expired) { availability = 'expired'; unavailableReason = '商品已下架'; }
    else if (isSoldOut) { availability = 'sold_out'; unavailableReason = '已达到限购上限'; }
    else if (!unlocked) { availability = 'locked'; unavailableReason = '商品尚未解锁'; }
    else if (!currencyKnown) {
        availability = 'unverified'; unavailableReason = isSeed
            ? '种子商品已列出，但扣费币种尚未独立确认；请暂勿重复购买'
            : '商品类别或扣费币种尚未确认；请暂勿重复购买';
    }
    else if (!contentKnown || !priceKnown || countdownUnknown) {
        availability = 'unverified'; unavailableReason = '商品价格、内容或限时状态未确认';
    }
    return {
        id, itemId, itemCount, itemType, isSeed, isForage, category: isSeed ? 'seed' : currencyKnown ? 'decoration' : 'other',
        seedLevel: isSeed ? integer(item?.level) : null, shopId: DECORATION_SHOP_ID,
        name: item?.name || `商品 #${itemId || id || '?'}`,
        image: itemId > 0 ? getItemImageById(itemId) : '',
        desc: item?.desc || '', effectDesc: item?.effectDesc || '',
        price, basePrice, originalPrice: promotionActive ? basePrice : null,
        currencyId, currencyName, currencyKnown,
        priceKnown, contentKnown, isFree: priceKnown && currencyKnown && price === 0,
        owned, unlocked, requiredLevel, limitCount, boughtNum, isSoldOut,
        remaining: limitCount > 0 ? Math.max(0, limitCount - boughtNum) : null,
        isLimited: limitCount > 0, isDiscounted: promotionActive,
        discountStartTime: start, discountEndTime: end,
        isLimitedTime: raw?.is_display_countdown === true || endTime > 0,
        endTime, expired, resultUnknown, availability, unavailableReason,
        canBuy: availability === 'available',
    };
}

async function readCatalog(session) {
    const reply = await scope.rpc(session, 'gamepb.shoppb.ShopService', 'ShopInfo',
        'ShopInfoRequest', 'ShopInfoReply', { shop_id: DECORATION_SHOP_ID });
    if (!Array.isArray(reply?.goods_list) || !reply.goods_list.length) {
        throw validation('装扮商店尚未返回商品，不能用占位商品替代', 'SHOP_CATALOG_UNAVAILABLE');
    }
    const seen = new Set();
    const now = getServerTimeSec();
    const items = reply.goods_list.map(raw => {
        const id = integer(raw.id);
        if (id > 0 && seen.has(id)) throw validation('装扮商品编号重复，请刷新核对', 'SHOP_CATALOG_INVALID');
        if (id > 0) seen.add(id);
        return buildDecorationGoods(raw, { now, resultUnknown: id > 0 && scope.blocked(session, operationKey(id)) });
    });
    return { accountId: session.accountId, shopId: DECORATION_SHOP_ID,
        currencyId: DECORATION_CURRENCY_ID, currencyName: '金豆豆', serverTime: now,
        stateKnown: true, items: items.sort((a, b) => (a.id || 0) - (b.id || 0)) };
}

async function getDecorationShop() {
    return scope.execute(readCatalog);
}

function normalizeItems(items) {
    if (!Array.isArray(items)) return null;
    const result = [];
    for (const item of items) {
        const id = integer(item?.id), count = integer(item?.count);
        if (!(id > 0) || count === null) return null;
        if (count > 0) result.push({ id, count });
    }
    return result;
}

async function buyDecorationGoods(goodsIdInput, countInput, expectedOffer) {
    const goodsId = positiveId(goodsIdInput, '商品编号');
    const count = positiveId(countInput, '购买数量');
    if (count > 9999) throw validation('购买数量超过上限');
    return scope.execute(async session => {
        const key = operationKey(goodsId);
        if (scope.blocked(session, key)) throw blockedUnknown();
        const catalog = await readCatalog(session);
        const goods = catalog.items.find(item => item.id === goodsId);
        if (!goods?.canBuy) throw validation(goods?.unavailableReason || '商品已不在当前商店中');
        if (!expectedOffer || integer(expectedOffer.itemId) !== goods.itemId
            || integer(expectedOffer.itemCount) !== goods.itemCount
            || integer(expectedOffer.currencyId) !== goods.currencyId
            || integer(expectedOffer.price) !== goods.price) {
            throw validation('商品价格或内容已变化，请刷新后重新确认', 'SHOP_OFFER_CHANGED');
        }
        if (goods.remaining !== null && count > goods.remaining) throw validation('购买数量超过剩余限购');
        const amount = goods.price * count, rewardAmount = goods.itemCount * count;
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(rewardAmount)) throw validation('购买数量或金额超出安全范围');
        if (amount > 0) {
            const warehouse = require('./warehouse');
            const bag = await scope.rpc(session, 'gamepb.itempb.ItemService', 'Bag', 'BagRequest', 'BagReply');
            const currencies = warehouse.getBagItems(bag).filter(item => toNum(item.id) === goods.currencyId);
            let balance = 0;
            for (const item of currencies) {
                if (warehouse.isItemLocked(item)) continue;
                const itemCount = integer(item.count);
                if (itemCount === null || !Number.isSafeInteger(balance + itemCount)) throw validation('金豆豆余额未确认');
                balance += itemCount;
            }
            if (balance < amount) throw validation('金豆豆可用余额不足');
        }
        const reply = await scope.rpc(session, 'gamepb.shoppb.ShopService', 'BuyGoods',
            'BuyGoodsRequest', 'BuyGoodsReply', { goods_id: goodsId, num: count, price: goods.price },
            { write: true, key });
        const getItems = normalizeItems(reply.get_items);
        const costItems = normalizeItems(reply.cost_items);
        const received = getItems?.filter(item => item.id === goods.itemId).reduce((sum, item) => sum + item.count, 0);
        const spent = costItems?.reduce((sum, item) => sum + item.count, 0);
        // goods is an optional updated-catalog message. The request-bound receipt
        // still proves the outcome when exact rewards AND costs are confirmed.
        // If goods is supplied, a conflicting SKU must remain unknown.
        const conflictingGoods = reply.goods != null && integer(reply.goods.id) !== goodsId;
        if (conflictingGoods || !getItems?.length || received !== rewardAmount
            || costItems === null || costItems.some(item => item.id !== goods.currencyId) || spent !== amount) {
            throw unknown('购买回包与确认商品不一致，请刷新核对，不要重复购买');
        }
        scope.confirm(session, key);
        return { accountId: session.accountId, shopId: DECORATION_SHOP_ID,
            goodsId, count, getItems, costItems, outcome: 'completed', refreshRequired: true };
    });
}

module.exports = { DECORATION_SHOP_ID, DECORATION_CURRENCY_ID, buildDecorationGoods,
    getDecorationShop, buyDecorationGoods };
