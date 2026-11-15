const DOG_INFO_HTTP_TIMEOUT_MS = 11 * 60 * 1000;

function getAccountOrRespond(req, res, { getAccountIdFromRequest, canAccessAccount, includeMissingMessage = true }) {
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

async function getFriendMetaByGid(provider, accountId) {
  let friends = [];
  try {
    if (provider && typeof provider.getFriends === "function") {
      friends = (await provider.getFriends(accountId)) || [];
    }
  } catch {}

  const metaByGid = new Map();
  for (const friend of friends) {
    const gid = Number(friend && friend.gid);
    if (gid > 0) {
      metaByGid.set(gid, {
        name: friend.name || friend.remark || "",
        avatarUrl: friend.avatarUrl || friend.avatar_url || "",
      });
    }
  }
  return metaByGid;
}

function formatFriendBlacklist(gids, metaByGid) {
  return gids.map((gid) => {
    const meta = metaByGid.get(Number(gid)) || {};
    return {
      gid: Number(gid),
      name: meta.name || "",
      avatarUrl: meta.avatarUrl || "",
    };
  });
}

function getKnownFriendGidsData(store, accountId) {
  return {
    knownFriendGids: store.getKnownFriendGids
      ? store.getKnownFriendGids(accountId)
      : [],
  };
}

function broadcastConfig(provider, accountId) {
  if (provider && typeof provider.broadcastConfig === "function") {
    provider.broadcastConfig(accountId);
  }
}

function registerAdminFriendRoutes({
  app,
  provider,
  store,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const access = { getAccountIdFromRequest, canAccessAccount };

  app.get("/api/friends", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, {
      ...access,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const forceSync = req.query.forceSync === "true";
      const data = await provider.getFriends(accountId, forceSync);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friends/clear-cache", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      await provider.clearFriendsCache(accountId);
      res.json({ ok: true });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friends/fetch-dog-info", async (req, res) => {
    req.setTimeout(DOG_INFO_HTTP_TIMEOUT_MS);
    res.setTimeout(DOG_INFO_HTTP_TIMEOUT_MS);

    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const result = await provider.fetchFriendsDogInfo(accountId);
      res.json(result);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/interact-records", async (req, res) => {
    const accountId = getAccountIdFromRequest(req);
    if (!accountId) {
      return res.status(400).json({ ok: false, error: "Missing x-account-id" });
    }

    try {
      const data = await provider.getInteractRecords(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 运维一次性补完旧场景清理；所有游戏状态证据由worker核验，HTTP不能强制清锁。
  app.post("/api/friends/visit/recover", async (req, res) => {
    if (!['admin', 'super_admin'].includes(req.currentUser?.role)) {
      return res.status(403).json({ ok: false, error: "旧访友场景恢复需要管理员权限" });
    }
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;
    const body = req.body || {};
    if (body.dryRun === false && body.confirm !== "COMPLETE_ORIGINAL_LEAVE_ONCE") {
      return res.status(400).json({ ok: false, error: "缺少单次离场确认", errorCode: "VISIT_RECOVERY_CONFIRMATION_REQUIRED" });
    }
    try {
      const data = await provider.recoverLegacyFriendVisit(accountId, {
        dryRun: body.dryRun !== false, evidenceId: body.evidenceId, stateSha256: body.stateSha256,
      });
      res.json({ ok: true, data });
    } catch (error) { sendProviderError(res, error); }
  });

  // ===== 预约偷取计划 =====
  // GET /api/steal-plans - 获取计划列表
  app.get("/api/steal-plans", (req, res) => {
    const accountId = getAccountOrRespond(req, res, {
      ...access,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const plans = store.getStealPlans
        ? store.getStealPlans(accountId)
        : [];
      res.json({ ok: true, data: plans });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // POST /api/steal-plans - 添加/更新计划 { gid, delaySeconds, name? }
  app.post("/api/steal-plans", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    const delaySeconds = Math.max(0, Math.min(86400, Number((req.body || {}).delaySeconds) || 0));
    const recurring = Boolean((req.body || {}).recurring);
    if (!Number.isFinite(gid) || gid <= 0) {
      return res.status(400).json({ ok: false, error: "无效的好友 GID" });
    }

    try {
      const name = String((req.body || {}).name || "").slice(0, 60);
      // 成熟时间必须来自本次已完成的好友访问；失败、畸形数据不能默认成“立即成熟”。
      if (!provider || typeof provider.getFriendLands !== "function") {
        throw Object.assign(new Error("好友土地查询不可用，未创建预约计划"), { errorCode: "FRIEND_LANDS_UNAVAILABLE", sent: false });
      }
      const landsData = await provider.getFriendLands(accountId, gid);
      if (!Array.isArray(landsData?.lands) || landsData?.ok === false || landsData?.resultState === 'unknown') {
        throw Object.assign(new Error("好友土地响应不完整，未创建预约计划"), { errorCode: "FRIEND_LANDS_INVALID_RESPONSE", sent: false });
      }
      let executeAt = 0;
      let matureInSec = -1;
      for (const land of landsData.lands) {
        if (land?.status === "locked" || land?.status === "empty" || land?.status === "dead") continue;
        const value = land?.matureInSec;
        const sec = typeof value === "number" ? value : NaN;
        if (!['growing', 'stealable', 'harvested'].includes(land?.status) || !Number.isSafeInteger(sec) || sec < 0
          || (sec === 0 && land?.status !== "stealable" && land?.status !== "harvested")) {
          throw Object.assign(new Error("好友作物成熟时间尚未确认，未创建预约计划"), { errorCode: "FRIEND_MATURITY_UNKNOWN", sent: false });
        }
        if (matureInSec < 0 || sec < matureInSec) matureInSec = sec;
      }
      if (matureInSec < 0) {
        return res.json({ ok: false, skipped: true, reason: "friend_no_crop", error: "好友暂无可确认成熟时间的作物，未创建预约计划" });
      }
      const base = matureInSec;
      const createdAt = Date.now();
      // 盯守时长：作物没熟 / 时间算偏时不会「错过一次就作废」，会持续重排直到该截止时间
      const watchHours = Math.max(1, Math.min(72, Number((req.body || {}).watchHours) || 24));
      const expireAt = createdAt + watchHours * 3600 * 1000;
      executeAt = createdAt + base * 1000 + delaySeconds * 1000;

      const saved = store.upsertStealPlan
        ? store.upsertStealPlan(accountId, {
            gid,
            name,
            delaySeconds,
            executeAt,
            createdAt,
            expireAt,
            recurring,
          })
        : [];
      broadcastConfig(provider, accountId);
      res.json({
        ok: true,
        data: saved,
        plan: saved.find(p => p.gid === gid) || null,
        matureInSec,
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // DELETE /api/steal-plans/:gid - 取消计划
  app.delete("/api/steal-plans/:gid", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number(req.params.gid);
    if (!Number.isFinite(gid) || gid <= 0) {
      return res.status(400).json({ ok: false, error: "无效的好友 GID" });
    }

    try {
      const saved = store.removeStealPlan
        ? store.removeStealPlan(accountId, gid)
        : [];
      broadcastConfig(provider, accountId);
      res.json({ ok: true, data: saved });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend/:gid/lands", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, {
      ...access,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const data = await provider.getFriendLands(accountId, req.params.gid);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend/:gid/op", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const opType = String((req.body || {}).opType || "");
      const data = await provider.doFriendOp(accountId, req.params.gid, opType);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend/:gid/dog", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.getFriendDogInfo(accountId, req.params.gid);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend/:gid/delete", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const gid = Number(req.params.gid);
      if (!gid) {
        return res.status(400).json({ ok: false, error: "无效的好友 GID" });
      }

      await provider.delFriend(accountId, gid);
      res.json({ ok: true, message: "删除好友成功" });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend-blacklist", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const blacklist = store.getFriendBlacklist
      ? store.getFriendBlacklist(accountId)
      : [];
    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(blacklist, metaByGid),
    });
  });

  app.post("/api/friend-blacklist/toggle", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }

    const blacklist = store.getFriendBlacklist
      ? store.getFriendBlacklist(accountId)
      : [];
    const nextBlacklist = blacklist.includes(gid)
      ? blacklist.filter((item) => item !== gid)
      : [...blacklist, gid];
    const saved = store.setFriendBlacklist
      ? store.setFriendBlacklist(accountId, nextBlacklist)
      : nextBlacklist;
    if (provider && typeof provider.broadcastConfig === "function") {
      provider.broadcastConfig(accountId);
    }

    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(saved, metaByGid),
    });
  });

  app.get("/api/friend-known-gids", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, body.knownFriendGids);
      }
      broadcastConfig(provider, accountId);
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/remove", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!Number.isFinite(gid) || gid <= 0) {
      return res.status(400).json({ ok: false, error: "GID 无效" });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const nextKnownGids = Array.isArray(knownGids)
        ? knownGids.filter((item) => Number(item) !== gid)
        : [];
      if (store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, nextKnownGids);
      }
      broadcastConfig(provider, accountId);
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/batch-add", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gids = (req.body || {}).gids;
    if (!Array.isArray(gids) || gids.length === 0) {
      return res.status(400).json({ ok: false, error: "GID 列表无效" });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const nextKnownGids = new Set(knownGids.map(Number));
      let addedCount = 0;
      for (const rawGid of gids) {
        const gid = Number(rawGid);
        if (!Number.isFinite(gid) || gid <= 0) continue;
        if (!nextKnownGids.has(gid)) {
          nextKnownGids.add(gid);
          addedCount++;
        }
      }

      if (store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, Array.from(nextKnownGids));
      }
      broadcastConfig(provider, accountId);
      res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        addedCount,
        message:
          addedCount > 0
            ? '已添加好友GID，请点击"刷新列表"获取好友信息，然后点击"获取狗信息"获取狗信息。处理中请勿频繁访问好友界面。'
            : "",
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/batch-remove", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gids = (req.body || {}).gids;
    if (!Array.isArray(gids) || gids.length === 0) {
      return res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        removedCount: 0,
      });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const gidSet = new Set(
        gids.map(Number).filter((gid) => Number.isFinite(gid) && gid > 0),
      );
      const nextKnownGids = knownGids.filter(
        (gid) => !gidSet.has(Number(gid)),
      );
      const removedCount = knownGids.length - nextKnownGids.length;
      if (removedCount > 0 && store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, nextKnownGids);
      }
      res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        removedCount,
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFriendRoutes };
