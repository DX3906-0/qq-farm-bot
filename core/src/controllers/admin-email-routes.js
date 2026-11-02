function sendMissingAccount(res) {
  res.status(400).json({ ok: false, error: "Missing x-account-id" });
}

function getAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    sendMissingAccount(res);
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

function registerAdminEmailRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  // 获取邮箱列表（box_type: 0=全部合并, 1=系统, 2=玩家）
  app.get("/api/account/email", async (req, res) => {
    const accountId = getAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId) return;

    const boxType = Number(req.query.boxType) || 0;
    try {
      if (boxType === 0) {
        const [sysReply, playerReply] = await Promise.all([
          provider.getEmails(accountId, 1),
          provider.getEmails(accountId, 2),
        ]);
        const merged = new Map();
        for (const email of [...(sysReply?.emails || []), ...(playerReply?.emails || [])]) {
          if (!email || !email.id) continue;
          if (!merged.has(email.id)) {
            merged.set(email.id, { ...email, box_type: email.__boxType ?? null });
          }
        }
        res.json({ ok: true, data: { box_type: 0, emails: [...merged.values()] } });
        return;
      }
      const reply = await provider.getEmails(accountId, boxType);
      res.json({ ok: true, data: { box_type: boxType, emails: reply?.emails || [] } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 领取单封邮件（body: { boxType, emailId }）
  app.post("/api/account/email/claim", async (req, res) => {
    const accountId = getAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId) return;

    const boxType = Number(req.body?.boxType) || 1;
    const emailId = String(req.body?.emailId || "");
    if (!emailId) {
      return res.status(400).json({ ok: false, error: "缺少 emailId" });
    }
    try {
      const reply = await provider.claimEmail(accountId, boxType, emailId);
      res.json({ ok: true, data: { items: reply?.items || [], emailId } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // 领取全部可领邮件
  app.post("/api/account/email/claim-all", async (req, res) => {
    const accountId = getAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
    if (!accountId) return;

    try {
      const [sysReply, playerReply] = await Promise.all([
        provider.getEmails(accountId, 1),
        provider.getEmails(accountId, 2),
      ]);
      const claimable = [];
      for (const [boxType, reply] of [
        [1, sysReply],
        [2, playerReply],
      ]) {
        for (const email of reply?.emails || []) {
          if (email && email.id && email.has_reward === true && email.claimed !== true) {
            claimable.push({ boxType, emailId: String(email.id) });
          }
        }
      }
      const claimed = [];
      for (const item of claimable) {
        try {
          const reply = await provider.claimEmail(accountId, item.boxType, item.emailId);
          claimed.push({ emailId: item.emailId, items: reply?.items || [] });
        } catch (_) {
          // 单封失败跳过
        }
      }
      res.json({ ok: true, data: { total: claimable.length, claimed } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminEmailRoutes };
