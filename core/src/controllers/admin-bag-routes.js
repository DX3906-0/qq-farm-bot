const { getItemById } = require("../config/gameConfig");
const { toNum } = require("../utils/utils");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireAccessibleAccount(
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
  missingAccountError = "Missing x-account-id",
) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    const payload = { ok: false };
    if (missingAccountError)
      payload.error = missingAccountError;
    res.status(400).json(payload);
    return null;
  }

  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }

  return accountId;
}

function getItemName(itemId) {
  return getItemById(itemId)?.name || `物品${itemId}`;
}

function getBagItemCountMap(bag) {
  const counts = new Map();
  for (const item of bag?.originalItems || []) {
    counts.set(toNum(item.id), toNum(item.count));
  }
  return counts;
}

function getNewItemsAfterUse(bagBefore, bagAfter, usedItemId) {
  const beforeCounts = getBagItemCountMap(bagBefore);
  const newItems = [];

  for (const item of bagAfter?.originalItems || []) {
    const itemId = toNum(item.id);
    if (itemId === usedItemId)
      continue;

    const countDelta = toNum(item.count) - (beforeCounts.get(itemId) || 0);
    if (countDelta > 0) {
      newItems.push({
        id: itemId,
        count: countDelta,
        name: getItemName(itemId),
      });
    }
  }

  return newItems;
}

function buildUseItemMessage(usedItemName, usedCount, newItems) {
  if (newItems.length === 0)
    return `使用 ${usedItemName} x${usedCount}`;

  const rewards = newItems.map((item) => `${item.name} x${item.count}`).join(", ");
  return `使用 ${usedItemName} x${usedCount}，获得: ${rewards}`;
}

function registerAdminBagRoutes({
  app,
  provider,
  emitRealtimeLog,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/bag", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, null);
    if (!accountId)
      return;

    try {
      const bag = await provider.getBag(accountId);
      res.json({ ok: true, data: bag });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/bag/use", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const { itemId, count, uid } = req.body;
      if (!itemId)
        return res.status(400).json({ ok: false, error: "缺少 itemId" });

      const usedItemId = Number(itemId);
      const rawCount = count === undefined ? 1 : count;
      const usedCount = Number(rawCount);
      if (!Number.isSafeInteger(usedItemId) || usedItemId <= 0
        || !['number', 'string'].includes(typeof rawCount) || !/^\d+$/.test(String(rawCount))
        || !Number.isSafeInteger(usedCount) || usedCount <= 0) {
        return res.status(400).json({ ok: false, error: '物品编号和使用数量必须为有效正整数', sent: false, resultState: 'not_sent' });
      }
      const usedItemName = getItemName(usedItemId);
      const used = await provider.useItem(accountId, usedItemId, usedCount, uid);
      if (used?.resultState !== 'completed' || Number(used.usedCount) !== usedCount
        || used.usedItemId != null && Number(used.usedItemId) !== usedItemId) {
        throw Object.assign(new Error('使用回包未确认本次数量，请只刷新核对'), { resultState: 'unknown', sent: true, outcomeUnknown: true });
      }
      const newItems = Array.isArray(used.rewards) ? used.rewards : [];

      emitRealtimeLog({
        accountId,
        time: new Date().toISOString().replace("T", " ").slice(0, 19),
        tag: "背包",
        msg: buildUseItemMessage(usedItemName, usedCount, newItems),
        module: "warehouse",
        event: "use_item",
      });

      res.json({
        ok: true,
        data: {
          items: Array.isArray(used?.rewards) ? used.rewards : newItems,
          rewards: Array.isArray(used?.rewards) ? used.rewards : newItems,
          resultState: used?.resultState,
          usedItemId,
          usedItemName,
          usedCount,
        },
      });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/bag/sell", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0)
        return res.status(400).json({ ok: false, error: "缺少出售物品列表" });

      const result = await provider.sellItems(accountId, items);
      res.json({ ok: true, data: result });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/bag/seeds", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId)
      return;

    try {
      const seeds = await provider.getBagSeeds(accountId);
      res.json({ ok: true, data: seeds });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/daily-gifts", async (req, res) => {
    const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount, null);
    if (!accountId)
      return;

    try {
      const gifts = await provider.getDailyGifts(accountId);
      res.json({ ok: true, data: gifts });
    }
    catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminBagRoutes };
