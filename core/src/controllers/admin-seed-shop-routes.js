const { getItemById, getSeedHarvestInfo, getSeedImageBySeedId, getPlantBySeedId } = require('../config/gameConfig');
const { toNum, getServerTimeSec } = require('../utils/utils');

const SEED_SHOP_ID = 2;
const FORAGE_SEED_ID = 20040;
const own = (value, key) => value != null && Object.hasOwn(value, key);

function nonnegativeInteger(value) {
  if (value == null || typeof value === 'boolean' || value === '') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (typeof value === 'object' && typeof value.toNumber !== 'function'
    && !(Number.isInteger(value.low) && Number.isInteger(value.high))) return null;
  const number = toNum(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount,
  missingAccountPayload = { ok: false, error: 'Missing x-account-id' } }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json(missingAccountPayload);
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: '无权访问此账号' });
    return null;
  }
  return accountId;
}

function buildSeedGoods(raw, userLevel, now = getServerTimeSec()) {
  const itemId = nonnegativeInteger(raw?.item_id);
  if (!(itemId > 0)) return null;
  const itemConfig = getItemById(itemId);
  if (itemConfig && Number(itemConfig.type) !== 5) return null;
  const id = nonnegativeInteger(raw.id);
  const isForage = itemId === FORAGE_SEED_ID;
  const plant = getPlantBySeedId(itemId);
  const harvest = plant ? getSeedHarvestInfo(itemId) : null;
  const requiredLevel = Math.max(0, ...(Array.isArray(raw.conds) ? raw.conds : [])
    .filter(condition => Number(condition?.type) === 1)
    .map(condition => nonnegativeInteger(condition.param) || 0));
  const limitCount = nonnegativeInteger(raw.limit_count) || 0;
  const boughtNum = nonnegativeInteger(raw.bought_num) || 0;
  const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
  const basePrice = own(raw, 'price') ? nonnegativeInteger(raw.price) : null;
  const start = nonnegativeInteger(raw.discount_start_time) || 0;
  const end = nonnegativeInteger(raw.discount_end_time) || 0;
  const isDiscounted = start > 0 && end > start && start <= now && now < end;
  const price = isDiscounted ? nonnegativeInteger(raw.discount_price ?? 0) : basePrice;
  const endTime = nonnegativeInteger(raw.end_time) || 0;
  const expired = endTime > 0 && now >= endTime;
  const countdownUnknown = raw.is_display_countdown === true && endTime === 0;
  const unlocked = raw.unlocked === true || raw.unlocked === 1;
  const contentKnown = id > 0 && !!itemConfig;
  const priceKnown = price !== null;
  const canBuy = contentKnown && priceKnown && !countdownUnknown && !expired
    && unlocked && userLevel >= requiredLevel && !isSoldOut;
  const harvestKnown = !!plant && nonnegativeInteger(plant.exp) !== null
    && nonnegativeInteger(plant.seasons) > 0;
  return {
    id, itemId, itemCount: nonnegativeInteger(raw.item_count) || 1,
    shopId: SEED_SHOP_ID, price, priceKnown, contentKnown,
    basePrice, originalPrice: isDiscounted ? basePrice : null,
    currencyId: 1001, currencyName: '金币',
    limitCount, boughtNum, unlocked, requiredLevel,
    seedLevel: nonnegativeInteger(itemConfig?.level) || 0,
    name: isForage ? itemConfig?.name || '牧草种子'
      : itemConfig?.effectDesc || itemConfig?.name || `种子 #${itemId}`,
    desc: itemConfig?.desc || '', assetName: itemConfig?.asset_name || '',
    image: getSeedImageBySeedId(itemId), isForage, catalogOnly: false,
    canBuy, isSoldOut, expired, endTime, isDiscounted, discountEndTime: end,
    availability: expired ? 'expired' : !contentKnown || !priceKnown || countdownUnknown ? 'unverified'
      : !unlocked ? 'locked' : isSoldOut ? 'sold_out' : 'available',
    harvestKnown, expPerSeason: harvestKnown ? harvest.expPerSeason : null,
    seasons: harvestKnown ? harvest.seasons : null,
    incomePerSeason: harvestKnown && !isForage ? harvest.incomePerSeason : null,
  };
}

function buildForageCatalogEntry() {
  const item = getItemById(FORAGE_SEED_ID);
  if (!item || Number(item.type) !== 5) return null;
  // This is a catalog hint, never a fabricated shop offer. In particular,
  // ItemInfo.sells is a SELL price and must not be used as a purchase price.
  return {
    id: null, itemId: FORAGE_SEED_ID, itemCount: null, shopId: SEED_SHOP_ID,
    name: item.name || '牧草种子', desc: item.desc || '',
    assetName: item.asset_name || '', image: getSeedImageBySeedId(FORAGE_SEED_ID),
    isForage: true, catalogOnly: true, price: null, priceKnown: false, contentKnown: true,
    currencyId: null, currencyName: '', seedLevel: nonnegativeInteger(item.level),
    requiredLevel: null, unlocked: false, canBuy: false, isSoldOut: false,
    availability: 'not_listed', unavailableReason: '服务器当前未将牧草种子列入种子商店',
    harvestKnown: false, expPerSeason: null, seasons: null, incomePerSeason: null,
  };
}

function registerAdminSeedShopRoutes({ app, provider, adminLogger,
  getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
  app.get('/api/seeds', async (req, res) => {
    const accountId = getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount,
      missingAccountPayload: { ok: false } });
    if (!accountId) return;
    try { res.json({ ok: true, data: await provider.getSeeds(accountId) }); }
    catch (error) { sendProviderError(res, error); }
  });

  app.get('/api/shop/seed', async (req, res) => {
    const accountId = getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount });
    if (!accountId) return;
    try {
      const status = provider.getStatus(accountId);
      if (status?.connection?.connected !== true) return res.json({ ok: false, error: '获取种子商店失败：账号未连接' });
      const userLevel = status?.status?.level || 0;
      const reply = await provider.getShopInfo(accountId, SEED_SHOP_ID);
      if (!Array.isArray(reply?.goods_list) || !reply.goods_list.length) {
        throw new Error('种子商店回包为空或不完整，暂不能确认商品状态');
      }
      const now = getServerTimeSec();
      const seeds = reply.goods_list.map(raw => buildSeedGoods(raw, userLevel, now)).filter(Boolean);
      if (!seeds.some(item => item.itemId === FORAGE_SEED_ID)) {
        const entry = buildForageCatalogEntry();
        if (entry) seeds.push(entry);
      }
      seeds.sort((left, right) => (left.seedLevel || 0) - (right.seedLevel || 0));
      res.json({ ok: true, data: seeds, accountId: String(accountId), shopId: SEED_SHOP_ID,
        debug: { goodsCount: reply.goods_list.length, displayedCount: seeds.length,
          catalogOnlyCount: seeds.filter(item => item.catalogOnly).length } });
    } catch (error) {
      adminLogger.error('获取种子商店失败', { error: error.message });
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminSeedShopRoutes, buildSeedGoods, buildForageCatalogEntry };
