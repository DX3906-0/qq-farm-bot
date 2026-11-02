const { getLevelExpProgress } = require("../config/gameConfig");

function sendMissingAccount(res, statusCode = 400) {
  const payload = { ok: false, error: "Missing x-account-id" };
  return statusCode ? res.status(statusCode).json(payload) : res.json(payload);
}

function requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, missingStatusCode = 400) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    sendMissingAccount(res, missingStatusCode);
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }

  return accountId;
}

function withLevelProgress(statusPayload) {
  if (statusPayload?.status) {
    const { level, exp } = statusPayload.status;
    statusPayload.levelProgress = getLevelExpProgress(level, exp);
  }
  return statusPayload;
}

function getFertilizerCheckOptions(body = {}) {
  return {
    buyOrganic: body.buyOrganic ?? false,
    buyNormal: body.buyNormal ?? false,
    organicCount: Number(body.organicCount) || 0,
    organicThresholdHours: Number(body.organicThresholdHours) || 0,
    normalCount: Number(body.normalCount) || 0,
    normalThresholdHours: Number(body.normalThresholdHours) || 0,
  };
}

function registerAdminFarmResourceRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/status", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, null);
    if (!accountId)
      return;

    try {
      const status = withLevelProgress(provider.getStatus(accountId));
      res.json({ ok: true, data: status });
    }
    catch (error) {
      res.json({ ok: false, error: error.message });
    }
  });

  app.post("/api/automation", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      let result = null;
      for (const [key, value] of Object.entries(req.body)) {
        result = await provider.setAutomation(accountId, key, value);
      }
      res.json({ ok: true, data: result || {} });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/fertilizer/buy", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const type = String(req.body?.type || "organic");
      const count = Number(req.body?.count) || 0;
      const bought = await provider.buyFertilizer(accountId, type, count);
      res.json({ ok: true, bought });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/fertilizer/check-and-buy", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const result = await provider.checkAndBuyFertilizer(
        accountId,
        getFertilizerCheckOptions(req.body),
      );
      res.json({ ok: true, ...result });
    }
    catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/lands", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const lands = await provider.getLands(accountId);
      res.json({ ok: true, data: lands });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  // 诊断接口：输出灵露相关土地的完整原始数据，用于排查灵露效果判断。
  app.get("/api/lands/diagnose", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const lands = await provider.getLands(accountId);
      const summary = {
        total: lands?.lands?.length || 0,
        withDew: [],
        all: [],
      };
      for (const land of lands?.lands || []) {
        const socialItems = Array.isArray(land?.socialItems) ? land.socialItems : [];
        const hasDewItem = socialItems.some(item => Number(item?.itemId) === 301103);
        const item = {
          landId: land.id,
          plantName: land.plantName,
          plantId: land.plantId,
          displayPlantId: land.displayPlantId,
          seedId: land.seedId,
          status: land.status,
          dewApplied: land.dewApplied,
          socialItems,
          buff: land.landBuff,
          phaseName: land.phaseName,
          currentSeason: land.currentSeason,
          totalSeason: land.totalSeason,
          matureInSec: land.matureInSec,
        };
        summary.all.push(item);
        if (land?.dewApplied || hasDewItem) {
          summary.withDew.push(item);
        }
      }
      res.json({ ok: true, data: summary });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFarmResourceRoutes };
