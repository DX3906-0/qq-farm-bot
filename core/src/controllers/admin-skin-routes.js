const { toNum } = require("../utils/utils");

/**
 * 装扮/皮肤面板接口（个人页「装扮」选项卡）
 *
 *   GET  /api/skins          → 已拥有 + 当前装备 + 槽位标签 + 效果
 *   POST /api/skins/equip    → 换装 { skinId, slotType? }
 *
 * 只做「读 + 手动换装」，不参与任何自动化。
 */
function requireAccessibleAccount({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function registerAdminSkinRoutes({
  app,
  provider,
  adminLogger,
  emitRealtimeLog,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/skins", async (req, res) => {
    const accountId = requireAccessibleAccount({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId)
      return;

    try {
      const data = await provider.getSkins(accountId);
      res.json({ ok: true, data });
    }
    catch (error) {
      adminLogger.error("获取装扮列表失败", {
        error: error.message,
        stack: error.stack,
      });
      sendProviderError(res, error);
    }
  });

  app.post("/api/skins/equip", async (req, res) => {
    const accountId = requireAccessibleAccount({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId)
      return;

    const skinId = toNum(req.body && req.body.skinId);
    const slotType = toNum(req.body && req.body.slotType);
    if (skinId <= 0) {
      return res.status(400).json({ ok: false, error: "无效的装扮ID" });
    }

    try {
      const result = await provider.equipSkin(accountId, skinId, slotType);
      // 换装是用户可见的外观变化，实时日志留一条便于回溯
      try {
        if (emitRealtimeLog) {
          emitRealtimeLog({
            accountId,
            tag: "装扮",
            module: "skin",
            event: "换装",
            result: "ok",
            message: `换装成功: ${skinId}`,
            skinId,
            slotType: result && result.slotType,
          });
        }
      }
      catch { /* 实时日志失败不影响换装 */ }
      res.json({ ok: true, data: result });
    }
    catch (error) {
      adminLogger.error("换装失败", {
        error: error.message,
        stack: error.stack,
      });
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminSkinRoutes };
