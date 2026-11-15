function getOldestPendingAgeMs(startedAtValues, now = Date.now()) {
  const values = Array.from(startedAtValues || []).filter(Number.isFinite);
  if (values.length === 0) return 0;
  return Math.max(0, now - Math.min(...values));
}

function evaluateGatewayHealth(input = {}) {
  const connected = input.connected !== false;
  const heartbeatAgeMs = Math.max(0, Number(input.heartbeatAgeMs) || 0);
  const oldestPendingAgeMs = Math.max(0, Number(input.oldestPendingAgeMs) || 0);
  const heartbeatLimitMs = Math.max(1000, Number(input.heartbeatLimitMs) || 30000);
  const pendingLimitMs = Math.max(1000, Number(input.pendingLimitMs) || 5000);
  const businessAgeMs = Math.max(0, Number(input.businessAgeMs) || 0);
  const businessLimitMs = Math.max(1000, Number(input.businessLimitMs) || 210000);

  const linkHealthy = connected && heartbeatAgeMs <= heartbeatLimitMs;
  const businessHealthy = connected && input.businessObserved !== false
    && input.businessDegraded !== true && oldestPendingAgeMs <= pendingLimitMs
    && businessAgeMs <= businessLimitMs;
  const result = (healthy, reason) => ({ healthy, reason, linkHealthy, businessHealthy });
  if (!connected) return result(false, 'disconnected');
  if (!linkHealthy) return result(false, 'heartbeat_stale');
  if (input.businessObserved === false) return result(false, 'business_unobserved');
  if (input.businessDegraded === true) return result(false, 'business_degraded');
  if (businessAgeMs > businessLimitMs) return result(false, 'business_stale');
  if (oldestPendingAgeMs > pendingLimitMs) return result(false, 'request_stuck');
  return result(true, 'ok');
}

function nextBusinessBackoffMs(previousMs = 0, minimumMs = 30000, maximumMs = 60000) {
  const min = Math.max(1000, Number(minimumMs) || 30000);
  const max = Math.max(min, Number(maximumMs) || 60000);
  const previous = Math.max(0, Number(previousMs) || 0);
  return previous > 0 ? Math.min(max, previous * 2) : min;
}

module.exports = { getOldestPendingAgeMs, evaluateGatewayHealth, nextBusinessBackoffMs };
