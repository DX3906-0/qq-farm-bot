const {
  getAuthorizedAccountId,
  requireConnectedAccount,
} = require("./admin-activity-route-helpers");

function registerAdminHonghuaActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };

  // 公益小红花活动状态（进度探测，不可用时降级）
  app.get("/api/activity/honghua", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "获取公益小红花失败: 账号未运行"))
        return;
      res.json({ ok: true, activity: await provider.getHonghuaActivity(accountId) });
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  // 送爱心值（需先收获小红花果实，否则服务器返回爱心不足）
  app.post("/api/activity/honghua/love", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "送爱心值失败: 账号未运行"))
        return;
      res.json(await provider.donateHonghuaLove(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  // 送公益金（真实 1 元微信扣款，单账号活动期仅 1 次；绝不自动调用）
  app.post("/api/activity/honghua/fund", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "送公益金失败: 账号未运行"))
        return;
      res.json(await provider.donateHonghuaFund(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  // 领分享奖励
  app.post("/api/activity/honghua/share/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "领分享奖励失败: 账号未运行"))
        return;
      res.json(await provider.claimHonghuaShare(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });

  // 领爱心值档位奖励（30/60/90/120/150，一次领全部达标档位）
  app.post("/api/activity/honghua/tiers/claim", async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, "领档位奖励失败: 账号未运行"))
        return;
      res.json(await provider.claimHonghuaTiers(accountId));
    } catch (err) {
      sendProviderError(res, err);
    }
  });
}

module.exports = { registerAdminHonghuaActivityRoutes };
