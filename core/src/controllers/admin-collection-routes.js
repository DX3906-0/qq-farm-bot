/**
 * 藏品（Collection）REST 接口 —— 2026-11-03
 *
 * 对应公告 26110102：11-02 上线的「果冻花园」藏品系统（125 级解锁）。
 *   获取：特惠商城【金豆豆藏品礼包】【钻石藏品礼包】；蓝晶土地种植概率触发变异
 *   养成：重复藏品升星（上限 5 星），评分达标领奖励
 *
 * 路由：
 *   GET  /api/collection            拉藏品列表（?categories=1,2 可选）
 *   POST /api/collection/upgrade    激活/升星 { category, collectionId }
 *   POST /api/collection/claim      领取评分奖励 { category }
 */

const { getCollectionCatalog } = require('../services/collection');

/** 默认状态中的 0 代表尚未同步，不应当作真实角色等级显示。 */
function getCollectionUserLevel(status) {
  const value = status?.status?.level ?? status?.level;
  if (value == null || typeof value === 'boolean') return null;
  const level = Number(value);
  return Number.isSafeInteger(level) && level > 0 ? level : null;
}

function getAuthorizedAccountId(req, res, { getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: 'Missing x-account-id' });
    return null;
  }
  if (typeof canAccessAccount === 'function' && !canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: '无权访问此账号' });
    return null;
  }
  return accountId;
}

function registerAdminCollectionRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  adminLogger,
}) {
  const routeContext = { getAccountIdFromRequest, canAccessAccount };

  // 藏品总目录（纯本地配置，不依赖账号/游戏连接）
  app.get('/api/collection/catalog', (req, res) => {
    try {
      const catalog = getCollectionCatalog();
      return res.json({
        ok: true,
        data: {
          total: catalog.length,
          items: catalog,
        },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || '读取藏品目录失败' });
    }
  });

  app.get('/api/collection', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      // categories 可选：?categories=1,2  空 = 全部
      const raw = String(req.query.categories || '').trim();
      const categories = raw
        ? raw.split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
        : [];

      const data = await provider.getCollections(accountId, categories);

      // 2026-11-03：把等级一起返回。前端自己从 /api/status 读容易读错层级
      // （status.status.level），曾导致「当前 Lv.0，还差 125 级」的误报。
      let userLevel = null;
      let levelStatus = 'pending';
      try {
        userLevel = getCollectionUserLevel(await provider.getStatus(accountId));
        if (userLevel !== null) levelStatus = 'ready';
      } catch (error) {
        levelStatus = 'unavailable';
        adminLogger?.warn('获取藏品角色等级失败', { accountId, error: error.message });
      }

      return res.json({ ok: true, data: { ...data, userLevel, levelStatus } });
    } catch (error) {
      if (typeof sendProviderError === 'function') {
        return sendProviderError(res, error, '获取藏品失败');
      }
      return res.status(500).json({ ok: false, error: error.message || '获取藏品失败' });
    }
  });

  app.post('/api/collection/upgrade', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    const category = Number(req.body && req.body.category) || 0;
    const collectionId = Number(req.body && req.body.collectionId) || 0;
    if (!category || !collectionId) {
      return res.status(400).json({ ok: false, error: 'category 与 collectionId 必填' });
    }

    try {
      if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: '请确认本次激活或升星' });
      const data = await provider.upgradeCollection(accountId, category, collectionId, {
        expectedStarLevel: req.body.expectedStarLevel, expectedCosts: req.body.expectedCosts,
      });
      return res.json({ ok: true, data });
    } catch (error) {
      return sendProviderError(res, error);
    }
  });

  app.post('/api/collection/claim', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    const category = Number(req.body && req.body.category) || 0;
    if (!category) {
      return res.status(400).json({ ok: false, error: 'category 必填' });
    }

    try {
      if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: '请确认领取评分奖励' });
      const data = await provider.claimCollectionReward(accountId, category);
      return res.json({ ok: true, data });
    } catch (error) {
      return sendProviderError(res, error);
    }
  });
  app.post('/api/collection/display', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;
    if (req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: '请确认展示变更' });
    try { return res.json({ ok: true, data: await provider.setCollectionDisplay(accountId, req.body) }); }
    catch (error) { return sendProviderError(res, error); }
  });
}

module.exports = { registerAdminCollectionRoutes, getCollectionUserLevel };