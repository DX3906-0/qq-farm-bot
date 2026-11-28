const {
  buildIllustratedItem,
  getSeedShopGoodsMap,
  getUserLevel,
  sortIllustratedItems,
  summarizeIllustratedItems,
} = require("./admin-illustrated-helpers");
const {
  registerAdminIllustratedPurchaseRoutes,
} = require("./admin-illustrated-purchase-routes");
const { getNongmePlantData } = require("../services/nongme-plant-data");

function getAuthorizedAccountId(req, res, { getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({
      ok: false,
      error: "Missing x-account-id",
    });
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({
      ok: false,
      error: "无权访问此账号",
    });
    return null;
  }

  return accountId;
}

function registerAdminIllustratedRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    provider,
    adminLogger,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  };

  registerAdminIllustratedPurchaseRoutes({
    app,
    ...routeContext,
  });

  app.get("/api/illustrated", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      // 2026-11-02：官方 GetIllustratedListV2Request 只有 rarity + type，
      // 旧的 refresh 参数不存在（field 1 是 rarity），传布尔值会造成字段错位。
      const rarity = Number(req.query.rarity) || 0;
      const illustratedType = Number(req.query.illustrated_type) || 1;
      const userLevel = getUserLevel(provider, accountId);

      adminLogger.info("获取图鉴列表请求", {
        accountId,
        rarity,
        illustratedType,
      });

      const [seedGoodsMap, illustratedList, nongmeData] = await Promise.all([
        getSeedShopGoodsMap({
          provider,
          accountId,
          adminLogger,
          tolerateFailure: true,
        }),
        provider.getIllustratedList(accountId, rarity, illustratedType),
        getNongmePlantData(false),
      ]);

      adminLogger.info("图鉴列表数据", {
        itemsCount: illustratedList?.items?.length || 0,
        hasRaw: !!illustratedList?.__raw,
        rawCount: illustratedList?.__raw?.rawItemCount || 0,
      });

      const items = sortIllustratedItems(
        (illustratedList?.items || []).map(item =>
          buildIllustratedItem(item, {
            seedGoodsMap,
            userLevel,
            adminLogger,
            nongmeFruitMap: nongmeData.byFruitId,
          }),
        ),
      );
      const summary = summarizeIllustratedItems(items);

      adminLogger.info("图鉴列表返回", {
        total: summary.total,
        unlocked: summary.unlocked,
        canBuy: summary.canBuy,
        userLevel,
      });

      res.json({
        ok: true,
        data: {
          items,
          summary,
          userLevel,
        },
      });
    } catch (err) {
      adminLogger.error("获取图鉴列表失败", {
        error: err.message,
        stack: err.stack,
      });
      sendProviderError(res, err);
    }
  });
}

module.exports = { registerAdminIllustratedRoutes };
