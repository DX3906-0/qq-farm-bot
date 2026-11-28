'use strict';

const { getMutationCatalog } = require('../services/collection-rules');

function registerAdminGameplayRoutes({ app, provider, getAccountIdFromRequest, canAccessAccount, sendProviderError }) {
    const route = (verb, url, operation, confirmed = false) => {
        app[verb](url, async (req, res) => {
            const accountId = getAccountIdFromRequest(req);
            if (!accountId) return res.status(400).json({ ok: false, error: '请先选择账号' });
            if (!canAccessAccount(req, accountId)) return res.status(403).json({ ok: false, error: '无权访问此账号' });
            if (confirmed && req.body?.confirmed !== true) return res.status(400).json({ ok: false, error: '请确认本次操作' });
            try {
                const data = await operation(accountId, req);
                if (res.writableEnded || res.destroyed || res.locals?.requestClosed || res.locals?.requestTimedOut) return;
                return res.json({ ok: true, data });
            } catch (error) { return sendProviderError(res, error); }
        });
    };
    route('post', '/api/friend-bad/resume', id => provider.resumeFriendBad(id), true);
    route('get', '/api/avatar-frames', id => provider.getAvatarFrames(id));
    route('post', '/api/avatar-frames/:action', (id, req) => provider.operateAvatarFrame(id, req.params.action, req.body || {}), true);
    // Lazy compatibility read for the unified activity panel, not the retired
    // Helu activity tree. V1 automation and its existing claim route stay intact.
    route('get', '/api/solar-terms', id => provider.getSolarTermsInfo(id));
    route('post', '/api/solar-terms/claim', (id, req) => provider.claimSolarTermsReward(id, req.body.termId), true);
    route('get', '/api/solar-calendar', id => provider.getSolarCalendar(id));
    route('get', '/api/solar-calendar/questions/:id', (id, req) => provider.getSolarQuestion(id, Number(req.params.id)));
    route('post', '/api/solar-calendar/:action', (id, req) => provider.operateSolarCalendar(id, req.params.action, req.body || {}), true);
    route('post', '/api/bag/lock', (id, req) => provider.setItemsLocked(id, req.body.itemUids, req.body.locked), true);
    route('get', '/api/open-server-gifts', id => provider.getOpenServerGifts(id));
    route('post', '/api/open-server-gifts/claim', (id, req) => provider.claimOpenServerGift(id, req.body.id), true);
    app.get('/api/illustrated/mutations', (_req, res) => {
        try { return res.json({ ok: true, data: getMutationCatalog() }); }
        catch (error) { return sendProviderError(res, error); }
    });
}

module.exports = { registerAdminGameplayRoutes };
