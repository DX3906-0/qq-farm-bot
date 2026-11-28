function registerAdminUserRoutes({
  app,
  requireAdminToken,
  requireAdminRole,
  requireDangerConfirmation,
  getAdminUserMutationError,
  userStore,
  adminLogger,
  invalidateAdminSessions,
  updateAdminSessions,
}) {
  app.get('/api/admin/users', requireAdminToken, requireAdminRole, (req, res) => {
    try { res.json({ ok: true, data: userStore.getAllUsers() }); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  app.post('/api/admin/users/:username/edit', requireAdminToken, requireAdminRole, (req, res) => {
    try {
      if (!requireDangerConfirmation(req, res, 'EDIT_USER')) return;
      const { username } = req.params;
      const mutationError = getAdminUserMutationError(req.currentUser, username);
      if (mutationError) return res.status(403).json({ ok: false, error: mutationError });
      const { newUsername, password, accountLimit } = req.body || {};
      const result = userStore.editUser(username, { newUsername, password, accountLimit });
      if (!result.ok) return res.status(400).json(result);
      adminLogger.warn('编辑用户资料', {
        admin: req.currentUser?.username || '', username,
        newUsername: result.user?.username || username,
        changedPassword: !!String(password || '').trim(),
        accountLimit: result.user?.accountLimit || accountLimit || null,
        confirmation: 'EDIT_USER',
      });
      updateAdminSessions(
        session => session.username === username || session.username === newUsername,
        session => { session.username = result.user.username; session.accountLimit = result.user.accountLimit; },
      );
      res.json({ ok: true, data: result.user });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });

  app.delete('/api/admin/users/:username', requireAdminToken, requireAdminRole, (req, res) => {
    try {
      if (!requireDangerConfirmation(req, res, 'DELETE_USER')) return;
      const { username } = req.params;
      const currentUser = req.currentUser;
      if (currentUser?.username === username) return res.status(400).json({ ok: false, error: '不能删除自己的账号' });
      const mutationError = getAdminUserMutationError(currentUser, username);
      if (mutationError) return res.status(403).json({ ok: false, error: mutationError });
      const result = userStore.deleteUser(username, true);
      if (!result.ok) return res.status(400).json(result);
      adminLogger.warn('删除用户', { admin: currentUser?.username || '', username, confirmation: 'DELETE_USER' });
      invalidateAdminSessions(session => session.username === username);
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
}

module.exports = { registerAdminUserRoutes };
