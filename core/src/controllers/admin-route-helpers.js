function toBooleanFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function createAdminRouteHelpers({ store, userStore, logger, getProvider }) {
  function requireDangerConfirmation(req, res, requiredConfirmation) {
    const confirmed = req && req.body ? toBooleanFlag(req.body.confirmed) : false;
    if (!confirmed) {
      return (
        res.status(400).json({
          ok: false,
          error: '危险操作未确认',
          requiredConfirmation,
        }),
        false
      );
    }
    return true;
  }

  function getAdminUserMutationError(currentUser, targetUsername) {
    const normalizedTarget = String(targetUsername || '').trim();
    if (!currentUser || !normalizedTarget) return null;
    if (currentUser.role === 'super_admin') return null;
    if (String(currentUser.username || '').trim() === normalizedTarget) return null;
    try {
      const users = userStore.getAllUsers();
      const targetUser = Array.isArray(users)
        ? users.find(
            user => String(user.username || '').trim() === normalizedTarget,
          )
        : null;
      if (targetUser && targetUser.role === 'admin')
        return '普通管理员不能修改或删除其他管理员账号';
    } catch {}
    return null;
  }

  function checkAccountLimit(mode) {
    const antiResaleConfig = store.getAntiResaleConfig();
    if (!antiResaleConfig.accountLimitEnabled) {
      return {
        ok: true,
        enabled: false,
        triggered: false,
        message: '账号数量限制功能未启用',
      };
    }
    const provider = typeof getProvider === 'function' ? getProvider() : null;
    if (!provider || typeof provider.getRunningAccountCount !== 'function') {
      return {
        ok: false,
        enabled: true,
        error: '无法获取运行账号数量',
      };
    }
    const runningCount = provider.getRunningAccountCount();
    const threshold = antiResaleConfig.accountLimitThreshold || 25;
    const triggered = runningCount > threshold;
    const result = {
      ok: true,
      enabled: true,
      triggered,
      runningCount,
      threshold,
      mode: mode || 'dry-run',
    };
    result.message = triggered
      ? `检测到运行账号数量(${  runningCount  })超过阈值(${  threshold  })`
      : `当前运行账号数量(${  runningCount  })未超过阈值(${  threshold  })`;
    return result;
  }

  function checkAccountLimitInterval() {
    try {
      const limitResult = checkAccountLimit('interval');
      if (!limitResult.ok || !limitResult.enabled || !limitResult.triggered)
        return;
      logger.warn('账号数量超限，已拦截自动清空账号动作', {
        runningCount: limitResult.runningCount,
        threshold: limitResult.threshold,
        mode: 'observe_only',
      });
    } catch (err) {
      logger.error('检查账号数量限制失败', {
        error: err.message,
      });
    }
  }

  function sendProviderError(res, err) {
    if (res.headersSent || res.writableEnded || res.destroyed || res.locals?.requestTimedOut || res.locals?.requestClosed)
      return;

    const errorCode = err?.errorCode || err?.code;
    const unavailable = new Set(['HEALTH_BACKOFF', 'QUEUE_FULL', 'API_QUEUE_FULL', 'DEADLINE', 'TIMEOUT', 'REQUEST_TIMEOUT', 'REQUEST_DEADLINE', 'READ_FLIGHTS_FULL']);
    const payload = { ok: false, error: String(err?.message || 'Provider Error') };
    for (const key of ['errorCode', 'stage', 'retryAfterMs', 'sent', 'resultState', 'outcomeUnknown',
      'holdUntilTransportEpochChanged', 'friendGid', 'processing']) {
      if (err?.[key] !== undefined) payload[key] = err[key];
    }
    if (errorCode) payload.errorCode = errorCode;
    // 不确定的写结果不能提供重试提示；只有传输层给出的准确剩余时间才发 Retry-After。
    if (unavailable.has(errorCode) && err?.outcomeUnknown !== true
      && Number.isFinite(err?.retryAfterMs) && err.retryAfterMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
    }
    if (unavailable.has(errorCode)) return res.status(503).json(payload);
    if (['CANCELLED', 'CANCELED', 'ABORT_ERR', 'REQUEST_CANCELLED', 'QUEUE_CANCELLED'].includes(errorCode)) return res.status(499).json(payload);
    if (errorCode === 'WORKER_NOT_RUNNING') return res.json(payload);
    // 仅为旧 worker 保留历史文字响应；有结构化代码的异常不按 message 分类。
    if (!errorCode && (payload.error === '账号未运行' || payload.error === 'API Timeout')) return res.json(payload);
    return res.status(500).json(payload);
  }

  function requireAdminRole(req, res, next) {
    if (
      !req.currentUser
      || (req.currentUser.role !== 'admin'
        && req.currentUser.role !== 'super_admin')
    ) {
      return res.status(403).json({
        ok: false,
        error: '需要管理员权限',
      });
    }
    next();
  }

  function requireSuperAdminRole(req, res, next) {
    if (!req.currentUser || req.currentUser.role !== 'super_admin') {
      return res.status(403).json({
        ok: false,
        error: '需要超级管理员权限',
      });
    }
    next();
  }

  return {
    checkAccountLimit,
    checkAccountLimitInterval,
    getAdminUserMutationError,
    requireAdminRole,
    requireDangerConfirmation,
    requireSuperAdminRole,
    sendProviderError,
  };
}

module.exports = {
  createAdminRouteHelpers,
};
