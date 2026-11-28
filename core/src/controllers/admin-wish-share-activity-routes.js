/**
 * 秋祈良愿（wish-sign）+ 快乐不独享（share-reward）活动管理路由。
 * 遵循本地 admin-pet-routes.js 的授权风格：内联 accountIdFor + provider 透传。
 */
function registerAdminWishShareActivityRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
  const accountIdFor = (req, res) => {
    const id = getAccountIdFromRequest(req);
    if (!id) { res.status(400).json({ ok: false, error: '缺少账号标识' }); return ''; }
    if (!canAccessAccount(req, id)) { res.status(403).json({ ok: false, error: '无权访问此账号' }); return ''; }
    return id;
  };
  const route = (method, path, operation) => app[method](path, async (req, res) => {
    const id = accountIdFor(req, res);
    if (!id) return;
    try { res.json({ ok: true, data: await operation(id, req.body || {}) }); }
    catch (error) { sendProviderError(res, error); }
  });

  // 秋祈良愿
  route('get', '/api/activity/wish-sign', id => provider.getWishSignActivity(id));
  route('post', '/api/activity/wish-sign/operate', (id, body) => {
    const actions = ['draw', 'claim'];
    if (!actions.includes(body.action)) throw new Error('祈愿操作无效');
    return provider.operateWishSign(id, body.action, Number(body.chooseId) || 1);
  });

  // 快乐不独享
  route('get', '/api/activity/share-reward', id => provider.getShareRewardActivity(id));
  route('post', '/api/activity/share-reward/operate', (id, body) => {
    const actions = ['daily', 'share', 'milestones'];
    if (!actions.includes(body.action)) throw new Error('快乐不独享操作无效');
    return provider.operateShareReward(id, body.action);
  });

  // 奶茶热销中（S4，2026-10-15）
  // GET /api/activity/milk-tea?page=shop 或 /api/activity/milk-tea/shop
  const milkTeaHandler = (pageFromPath) => async (req, res) => {
    const id = accountIdFor(req, res);
    if (!id) return;
    try {
      const page = String(pageFromPath || req.query?.page || 'shop');
      const input = { ...(req.query || {}) };
      delete input.page;
      res.json({ ok: true, data: await provider.getMilkTeaActivity(id, page, input) });
    } catch (error) {
      sendProviderError(res, error);
    }
  };
  app.get('/api/activity/milk-tea', milkTeaHandler(null));
  app.get('/api/activity/milk-tea/:page', (req, res, next) => milkTeaHandler(req.params?.page)(req, res, next));
  route('post', '/api/activity/milk-tea/operate', (id, body) => {
    const actions = [
      'create', 'rename', 'claim', 'boost', 'upgrade', 'craft',
      'hire', 'exchange', 'unlock', 'fundClaim', 'wages', 'interact', 'hireSetting',
      // S4 快乐分享 / 成长基金 / 活动种子购买（与 service 层 MILK_TEA_OPERATIONS 对齐）
      'seedBuy', 'shareDaily', 'shareRewards',
    ];
    if (!actions.includes(body.action)) throw new Error('奶茶活动操作无效');
    return provider.operateMilkTeaActivity(id, body.action, body.input || {});
  });
}

module.exports = { registerAdminWishShareActivityRoutes };