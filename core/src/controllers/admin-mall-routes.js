// 2026-11-02：mallpb.proto 换成官方定义后，price/reward_items/purchase_limit
// 都是结构化字段，无需手写 varint 解析（旧的 parse* 函数已无调用方）。
const { toNum } = require("../utils/utils");
const { getItemImageById, getItemById } = require("../config/gameConfig");

// 服务端 pic 可能是相对路径 / CDN 路径，统一成可直接 <img src> 的形式
function normalizePicUrl(pic) {
  if (!pic) return "";
  const s = String(pic).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return s;
  return "/" + s;
}

const MALL_GOODS_ORDER = [1002, 1003, 1006];
const MALL_GOODS_PRICE_OVERRIDES = {
  1002: 42,
  1003: 34,
  1006: 33,
};
const MALL_GOODS_META = {
  1002: {
    name: "10小时有机化肥",
    images: [
      "/game-config/seed_images_named/80011_organic_1.png",
      "/game-config/seed_images_named/80013_organic_8.png",
    ],
    layout: "horizontal",
  },
  1003: {
    name: "10小时化肥",
    images: [
      "/game-config/seed_images_named/80001_ordinary_1.png",
      "/game-config/seed_images_named/80003_ordinary_8.png",
    ],
    layout: "horizontal",
  },
  1006: {
    name: "狗粮礼包",
    images: [
      "/game-config/seed_images_named/90004_dog_food_1.png",
      "/game-config/seed_images_named/90005_dog_food_3.png",
      "/game-config/seed_images_named/90006_dog_food_5.png",
    ],
    layout: "triangle",
  },
};

function getAuthorizedAccountId({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing\x20x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function registerAdminMallRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/shop/mall", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const status = provider.getStatus(accountId);
      if (!status || !status.connection || !status.connection.connected) {
        return res.json({
          ok: false,
          error: "获取商城失败:\x20账号未运行",
        });
      }

      // slotType 对应游戏的商场分栏（1=主商城 4=SVIP 5=限时 等）
      const slotType = Math.max(1, toNum(req.query.slot) || 1);
      const userTicket = status?.status?.coupon || 0;
      const discounts = await provider.getMallGoods(accountId, slotType);
      const goods = [];
      const typeCounts = {};

      for (const raw of discounts) {
        const id = toNum(raw.goods_id) || 0;
        if (!id) continue;

        // ---- 结构化字段（proto 已正确解码，无需手写 varint）----
        // price: corepb.Item { id=货币道具id, count=单价 }
        const priceItem = raw.price || {};
        const currencyId = toNum(priceItem.id) || 0;
        const parsedPrice = toNum(priceItem.count) || 0;

        // reward_items: repeated corepb.Item，首个非货币物品当作图标/名称来源
        const rewards = (Array.isArray(raw.reward_items) ? raw.reward_items : [])
          .map(it => ({ id: toNum(it.id) || 0, count: toNum(it.count) || 0 }))
          .filter(it => it.id > 0);

        // purchase_limit: { limit_type, bought_count, limit_count }
        const pl = raw.purchase_limit || {};
        const limitType = toNum(pl.limit_type) || 0;
        const boughtNum = toNum(pl.bought_count) || 0;
        const limitCount = toNum(pl.limit_count) || 0;

        const isFree = raw.is_free === true;
        const isAvailable = raw.is_available !== false;

        // 图片：服务端 pic 优先（通常是 CDN 相对路径），否则用奖励物品图标
        const pic = typeof raw.pic === 'string' ? raw.pic.trim() : '';
        const iconFromReward = rewards.length
          ? (getItemImageById(rewards[0].id) || '')
          : '';
        const images = [];
        if (pic) images.push(normalizePicUrl(pic));
        if (iconFromReward) images.push(iconFromReward);

        // 名称：服务端 name 优先（官方就叫这个），本地 meta 兜底修正
        const meta = MALL_GOODS_META[id] || null;
        const name = (raw.name && String(raw.name).trim())
          || meta?.name
          || (rewards.length ? (getItemById(rewards[0].id)?.name || '') : '')
          || ("\u5546\u54c1 " + id);

        const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
        const goodsType = toNum(raw.goods_type) || 0;
        typeCounts[goodsType] = (typeCounts[goodsType] || 0) + 1;

        // 折扣文案
        const discountText = typeof raw.discount_text === 'string' ? raw.discount_text : '';

        goods.push({
          id,
          goodsId: id,
          name,
          type: goodsType,
          itemIds: rewards.map(r => r.id),
          rewards,
          price: parsedPrice,
          currencyId,
          origPrice: parsedPrice,
          isFree,
          isAvailable,
          isLimited: limitCount > 0,
          limitCount,
          boughtNum,
          limitType,
          isSoldOut,
          discount: discountText,
          images,
          pic,
          canBuy: isAvailable && !isSoldOut,
        });
      }

      // 已知商品优先（白名单顺序），其余按 id 升序，保证展示稳定
      const orderIndex = new Map(MALL_GOODS_ORDER.map((id, idx) => [id, idx]));
      goods.sort((a, b) => {
        const oa = orderIndex.has(a.id) ? orderIndex.get(a.id) : 9999;
        const ob = orderIndex.has(b.id) ? orderIndex.get(b.id) : 9999;
        if (oa !== ob) return oa - ob;
        return a.id - b.id;
      });

      // 按 type 汇总成分类
      const categories = Object.keys(typeCounts)
        .map(t => ({ type: Number(t), count: typeCounts[t] }))
        .sort((a, b) => b.count - a.count);

      return res.json({
        ok: true,
        data: {
          goods,
          categories,
          slotType,
          userTicket,
          total: goods.length,
        },
      });
    } catch (e) {
      return sendProviderError(res, e, "获取商城失败");
    }
  });

  app.post("/api/shop/mall/buy", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const { goodsId, count } = req.body || {};
      if (!goodsId || !count) {
        return res.status(400).json({ ok: false, error: "参数不完整" });
      }

      const data = await provider.buyMallGoods(accountId, goodsId, count);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminMallRoutes };
