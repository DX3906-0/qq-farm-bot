function requireAccountAccess({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
  includeMissingMessage = true,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    const payload = { ok: false };
    if (includeMissingMessage) payload.error = "Missing x-account-id";
    res.status(400).json(payload);
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function requireLandId(req, res) {
  const { landId } = req.body || {};
  if (!landId) {
    res.status(400).json({ ok: false, error: "缺少土地ID" });
    return null;
  }
  return Number(landId);
}

function registerAdminFarmOperationRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.post("/api/farm/operate", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const { opType } = req.body || {};
      if (!['all', 'harvest', 'plant', 'clear', 'upgrade'].includes(opType)) {
        res.status(400).json({ ok: false, error: '无效的农场操作类型' });
        return;
      }
      const result = await provider.doFarmOp(accountId, opType);
      if (!result || typeof result.hadWork !== 'boolean') {
        res.json({ ok: false, error: '未返回农场操作结果', data: result || null });
        return;
      }
      const errors = Array.isArray(result.errors) ? result.errors : [];
      const skipped = !result.hadWork && errors.length === 0;
      const ok = errors.length === 0 && (result.success === true || skipped);
      const error = ok ? undefined : errors.map(item => item.message || String(item)).join('；') || '农场操作失败';
      res.json({ ...result, ok, skipped, error, details: errors, data: result });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/farm/unified-harvest", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      // body.enabled === false → 取消；其余（含缺省）→ 开启
      const enabled = (req.body || {}).enabled !== false;
      const data = await provider.setUnifiedHarvest(accountId, enabled);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/farm/unified-harvest", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const data = await provider.getUnifiedHarvest(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/fertilize", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const landId = requireLandId(req, res);
      if (!landId) return;

      const data = await provider.fertilizeLand(accountId, landId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/remove", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const landId = requireLandId(req, res);
      if (!landId) return;

      const data = await provider.removePlant(accountId, landId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/land/remove-all", async (req, res) => {
    const accountId = requireAccountAccess({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const data = await provider.removeAllPlants(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFarmOperationRoutes };
