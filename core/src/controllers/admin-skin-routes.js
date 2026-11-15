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

    const body = req.body || {};
    const skinId = toNum(body.skinId);
    const slotType = toNum(body.slotType);
    const expectedId = body.expectedEquippedSkinId;
    if (typeof body.skinId === "boolean" || !Number.isSafeInteger(skinId) || skinId <= 0
      || typeof body.slotType === "boolean" || !Number.isSafeInteger(slotType) || slotType <= 0) {
      return res.status(400).json({ ok: false, error: "无效的装扮ID或槽位", sent: false, resultState: "not_sent" });
    }
    if (body.confirmed !== true || expectedId == null || typeof expectedId === "boolean" || expectedId === ""
      || !Number.isSafeInteger(Number(expectedId)) || Number(expectedId) < 0) {
      return res.status(400).json({ ok: false, error: "请刷新后确认当前外观与目标装扮", sent: false, resultState: "not_sent" });
    }

    try {
      const result = await provider.equipSkin(accountId, skinId, slotType, {
        confirmed: true, expectedEquippedSkinId: Number(expectedId),
      });
      // 换装是用户可见的外观变化，实时日志留一条便于回溯
      try {
        if (emitRealtimeLog && result?.resultState === "completed") {
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
      catch (error) {
        adminLogger.warn("换装结果已确认，实时日志输出失败", { accountId, error: error.message });
      }
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
