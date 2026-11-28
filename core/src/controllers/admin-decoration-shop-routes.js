function getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: 'Missing x-account-id' });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: '无权访问此账号' });
    return null;
  }
  return accountId;
}

function registerAdminDecorationShopRoutes({
  app, provider, adminLogger, getAccountIdFromRequest, canAccessAccount, sendProviderError,
}) {
  app.get('/api/shop/decoration', async (req, res) => {
    const accountId = getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount });
    if (!accountId) return;
    try {
      const status = provider.getStatus(accountId);
      if (status?.connection?.connected !== true) {
        return res.json({ ok: false, error: '获取装扮商店失败：账号未连接' });
      }
      const catalog = await provider.getDecorationShop(accountId);
      if (String(catalog?.accountId) !== String(accountId) || catalog.stateKnown !== true
        || catalog.shopId !== 4 || catalog.currencyId !== 1005 || !Array.isArray(catalog.items) || !catalog.items.length) {
        throw new Error('装扮商店响应不完整或账号已切换');
      }
      res.json({ ok: true, data: catalog.items, accountId: String(accountId),
        shopId: catalog.shopId, currencyId: catalog.currencyId, serverTime: catalog.serverTime,
        userGoldBean: status?.status?.goldBean ?? null });
    } catch (error) {
      adminLogger.error('获取装扮商店失败', { error: error.message });
      sendProviderError(res, error);
    }
  });

  app.post('/api/shop/decoration/buy', async (req, res) => {
    const accountId = getAuthorizedAccountId({ req, res, getAccountIdFromRequest, canAccessAccount });
    if (!accountId) return;
    try {
      const { goodsId, count = 1, expectedOffer } = req.body || {};
      const result = await provider.buyDecorationGoods(accountId, goodsId, count, expectedOffer);
      if (String(result?.accountId) !== String(accountId) || result.outcome !== 'completed' || !result.getItems?.length) {
        throw Object.assign(new Error('装扮购买结果未完整确认；暂不重复提交，刷新只读取当前背包'), {
          errorCode: 'GAME_RESULT_UNKNOWN', outcomeUnknown: true, resultState: 'unknown', sent: true, retryable: false,
        });
      }
      res.json({ ok: true, data: result });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminDecorationShopRoutes };
