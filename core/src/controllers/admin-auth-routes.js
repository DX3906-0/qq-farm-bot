function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return cfIp.trim();
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const first = forwardedFor.split(',').map(item => item.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  if (req.ip && req.ip !== '::1' && req.ip !== '::ffff:127.0.0.1') return req.ip;
  const remote = req.connection?.remoteAddress || req.socket?.remoteAddress;
  return remote?.startsWith('::ffff:') ? remote.substring(7) : remote || 'unknown';
}

function registerAdminAuthRoutes({ app, logger, userStore, requireAdminToken, createAdminSession }) {
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    if (!username || !password) return res.status(401).json({ ok: false, error: '请输入用户名和密码' });

    const result = userStore.validateUser(username, password, ip);
    if (!result || result.error) {
      const errorType = result?.error || 'invalid_credentials';
      const status = errorType === 'rate_limit' ? 429 : errorType === 'locked' ? 423 : 401;
      logger.warn('登录失败', { username, error: errorType, ip, message: result?.message });
      userStore.addLoginLog('login_failed', username, errorType, ip, userAgent);
      return res.status(status).json({ ok: false, error: result?.message || '用户名或密码错误', errorType, remainingMs: result?.remainingMs });
    }

    userStore.addLoginLog('login_success', username, null, ip, userAgent);
    const token = createAdminSession(result);
    return res.json({ ok: true, data: { token, role: result.role, accountLimit: result.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2, user: { username: result.username }, mustChangePassword: result.mustChangePassword || false } });
  });

  app.post('/api/user/change-password', requireAdminToken, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const username = req.currentUser?.username;
    if (!username) return res.status(401).json({ ok: false, error: '未登录' });
    if (!oldPassword || !newPassword) return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
    res.json(userStore.changePassword(username, oldPassword, newPassword));
  });
}

module.exports = { registerAdminAuthRoutes };
