'use strict';

const ALLOWED_RANCH_ACTIONS = new Set([
    'harvest', 'produce', 'feed', 'addGrass',
    'buy', 'sell', 'clean', 'completeUpgrade', 'release',
    'steal', 'cleanFriend', 'stroke', 'putMosquito',
    'place', 'useCan', 'buyCan', 'upgrade',
    'claimTasks', 'claimIllustrated', 'claimWeight', 'reportDailyShare', 'claimDailyShare', 'exchange',
]);

function requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount) {
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

function parseBody(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    if (!body) {
        res.status(400).json({ ok: false, error: '请求体无效' });
        return null;
    }
    return body;
}

function registerAdminRanchRoutes({
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
}) {
    // 自家与好友牧场均走场景事务；所有写仍需逐次报价确认，自动化不暴露独立HTTP入口。
    app.get('/api/ranch', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try {
            const data = await provider.getRanchOverview(accountId);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.get('/api/ranch/scene-access', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try {
            const data = await provider.getRanchSceneAccessInfo(accountId);
            res.set('Cache-Control', 'no-store');
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) { sendProviderError(res, error); }
    });

    app.post('/api/ranch/session/upgrade', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        if (String(accountId) !== '2') {
            return res.status(403).json({ ok: false, error: '当前全局登录修复仅授权微信单号验证', sent: false });
        }
        const body = parseBody(req, res);
        if (!body) return;
        const expected = body.expected;
        if (body.confirm !== true || !expected || typeof expected !== 'object' || Array.isArray(expected)
            || String(expected.accountId || '') !== String(accountId)
            || !Number.isSafeInteger(expected.gid) || expected.gid <= 0
            || !Number.isSafeInteger(expected.connectionEpoch) || expected.connectionEpoch < 0
            || typeof expected.remoteGeneration !== 'string' || !/^\d+$/.test(expected.remoteGeneration)
            || expected.remoteGenerationSource !== 'gateway') {
            return res.status(400).json({ ok: false, error: '缺少明确确认或当前游戏会话精确基线', sent: false });
        }
        try {
            const data = await provider.upgradeRanchGlobalLogin(accountId, {
                actorId: 2, accountId: String(accountId), gid: expected.gid, connectionEpoch: expected.connectionEpoch,
                remoteGeneration: expected.remoteGeneration, remoteGenerationSource: 'gateway',
            });
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) { sendProviderError(res, error); }
    });

    app.get('/api/ranch/friends', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try { res.json({ ok: true, accountId: String(accountId), data: await provider.getRanchFriends(accountId) }); }
        catch (error) { sendProviderError(res, error); }
    });

    app.get('/api/ranch/friend', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const gid = Number(req.query.gid);
        if (!Number.isSafeInteger(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: '好友GID无效' });
        }
        try {
            const data = await provider.getRanchFriend(accountId, gid);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.get('/api/ranch/bag', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try { res.json({ ok: true, accountId: String(accountId), data: await provider.getRanchBag(accountId) }); }
        catch (error) { sendProviderError(res, error); }
    });

    app.get('/api/ranch/cans', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const slotType = Number(req.query.slotType ?? 6);
        if (![6, 7].includes(slotType)) return res.status(400).json({ ok: false, error: '罐头商城入口无效' });
        try { res.json({ ok: true, accountId: String(accountId), data: await provider.getRanchCanCatalog(accountId, slotType) }); }
        catch (error) { sendProviderError(res, error); }
    });

    for (const [section, method] of [['tasks', 'getRanchTasks'], ['book', 'getRanchBook'], ['share', 'getRanchShare']]) {
        app.get(`/api/ranch/${section}`, async (req, res) => {
            const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
            if (!accountId) return;
            try { res.json({ ok: true, accountId: String(accountId), data: await provider[method](accountId) }); }
            catch (error) { sendProviderError(res, error); }
        });
    }

    app.get('/api/ranch/market', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try { res.json({ ok: true, accountId: String(accountId), data: await provider.getRanchMarket(accountId) }); }
        catch (error) { sendProviderError(res, error); }
    });
    app.get('/api/ranch/activities', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const groupId = String(req.query.groupId || '');
        if (groupId && !/^[1-9]\d{0,18}$/.test(groupId)) return res.status(400).json({ ok: false, error: '活动分组ID无效' });
        try { res.json({ ok: true, accountId: String(accountId), data: await provider.getRanchActivities(accountId, groupId) }); }
        catch (error) { sendProviderError(res, error); }
    });
    app.post('/api/ranch/activities/operate', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const body = parseBody(req, res);
        if (!body) return;
        const action = String(body.action || '');
        if (!['claimCelebration', 'claimFriends', 'claimTask', 'claimHandbook', 'saveAnswers', 'settle', 'claimShare'].includes(action)) {
            return res.status(400).json({ ok: false, error: '不支持的牧歌初启操作', sent: false });
        }
        try {
            const data = await provider.operateRanchMugeActivity(accountId, action, body.input || {});
            res.json({ ok: true, accountId: String(accountId), data });
        } catch (error) { sendProviderError(res, error); }
    });

    app.get('/api/ranch/catalog', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const shopId = Number(req.query.shopId);
        if (![5, 6].includes(shopId)) return res.status(400).json({ ok: false, error: '牧场商店编号无效' });
        try {
            const data = await provider.getRanchCatalog(accountId, shopId);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.get('/api/ranch/operations', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        try {
            const data = await provider.getRanchPendingOperations(accountId);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.post('/api/ranch/quote', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const body = parseBody(req, res);
        if (!body) return;
        if (!ALLOWED_RANCH_ACTIONS.has(String(body.action || ''))) {
            return res.status(400).json({ ok: false, error: '不支持的牧场操作' });
        }
        try {
            const data = await provider.prepareRanchAction(accountId, String(body.action), body.input || {});
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.post('/api/ranch/operate', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const body = parseBody(req, res);
        if (!body) return;
        if (!ALLOWED_RANCH_ACTIONS.has(String(body.action || ''))) {
            return res.status(400).json({ ok: false, error: '不支持的牧场操作' });
        }
        if (!body.expected || typeof body.expected !== 'object' || typeof body.expected.signature !== 'string') {
            return res.status(400).json({ ok: false, error: '缺少报价签名，请先获取确认信息' });
        }
        try {
            const data = await provider.operateRanch(accountId, String(body.action), body.input || {}, body.expected);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });

    app.post('/api/ranch/operations/acknowledge', async (req, res) => {
        const accountId = requireAccessibleAccount(req, res, getAccountIdFromRequest, canAccessAccount);
        if (!accountId) return;
        const body = parseBody(req, res);
        if (!body) return;
        if (typeof body.id !== 'string' || !body.id) {
            return res.status(400).json({ ok: false, error: '缺少记录ID' });
        }
        try {
            const data = await provider.acknowledgeRanchOperation(accountId, body.id);
            res.json({ ok: true, accountId: String(accountId), data });
        }
        catch (error) {
            sendProviderError(res, error);
        }
    });
}

module.exports = { registerAdminRanchRoutes, ALLOWED_RANCH_ACTIONS };
