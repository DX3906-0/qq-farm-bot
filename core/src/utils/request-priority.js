const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');

const PRIORITIES = Object.freeze({ critical: 0, foreground: 1, farm: 2, friend: 3, background: 4 });
const requestContext = new AsyncLocalStorage();

function normalizePriority(value) {
  const key = String(value || '').toLowerCase();
  return Object.hasOwn(PRIORITIES, key) ? key : 'foreground';
}

function runWithRequestContext(context, fn) {
  return requestContext.run({ ...getRequestContext(), ...context }, fn);
}

function getRequestContext() { return requestContext.getStore() || {}; }
function runWithRequestPriority(priority, fn) {
  return runWithRequestContext({ priority: normalizePriority(priority) }, fn);
}
function getRequestPriority(fallback = 'foreground') {
  return normalizePriority(getRequestContext().priority || fallback);
}

function requestError(message, details = {}) {
  const sent = details.sent ?? false;
  const states = ['unknown', 'completed', 'not_sent', 'failed'];
  const resultState = states.includes(details.resultState) ? details.resultState
    : details.outcomeUnknown === true ? 'unknown' : sent ? 'failed' : 'not_sent';
  return Object.assign(new Error(String(message)), details, { sent, resultState });
}

function clonePlainMeta(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null
    && !(prototype.constructor?.name === 'Object' && Object.getPrototypeOf(prototype) === null)) {
    throw new TypeError('共享响应 meta 必须是 plain object');
  }
  const copy = Array.isArray(value) ? [] : Object.create(prototype === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: clonePlainMeta(value[key], seen), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function throwIfRequestCancelled(context = getRequestContext()) {
  if (context.signal?.aborted) {
    throw requestError('请求已取消', { errorCode: 'REQUEST_CANCELLED', stage: 'queue' });
  }
  if (Number.isFinite(context.deadline) && Date.now() >= context.deadline) {
    throw requestError('请求等待期限已到', { errorCode: 'REQUEST_DEADLINE', stage: 'queue' });
  }
}

function createRequestGate(options = {}) {
  const maxActive = Math.min(8, Math.max(1, Math.floor(Number(options.maxActive) || 8)));
  const maxCritical = Math.min(1, Math.max(0, Math.floor(Number(options.maxCritical) || 0)));
  const maxQueued = Math.min(100, Math.max(1, Math.floor(Number(options.maxQueued) || 100)));
  let active = 0;
  let criticalActive = 0;
  let order = 0;
  let closed = false;
  const queue = [];
  const metrics = { acquired: 0, released: 0, cancelled: 0, expired: 0, rejected: 0 };

  function clean(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  }
  function rejectEntry(entry, error) {
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    clean(entry);
    metrics.rejected++;
    entry.reject(error);
  }
  function drain() {
    if (closed) return;
    queue.sort((a, b) => PRIORITIES[a.priority] - PRIORITIES[b.priority] || a.order - b.order);
    for (const entry of [...queue]) {
      try {
        throwIfRequestCancelled(entry);
        if (entry.validate) entry.validate();
      } catch (error) {
        rejectEntry(entry, error);
        continue;
      }
      const reserved = entry.priority === 'critical' && maxCritical > 0;
      if (reserved ? criticalActive >= maxCritical : active >= maxActive) continue;
      queue.splice(queue.indexOf(entry), 1);
      clean(entry);
      if (reserved) criticalActive++;
      else active++;
      metrics.acquired++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        if (reserved) criticalActive--;
        else active--;
        metrics.released++;
        drain();
      });
    }
  }

  function acquire(priority, context = {}) {
    if (priority && typeof priority === 'object') {
      context = priority;
      priority = context.priority;
    }
    try {
      if (closed) throw requestError('请求调度已关闭', { errorCode: 'GATE_CLOSED', stage: 'queue' });
      throwIfRequestCancelled(context);
      if (context.validate) context.validate();
      if (queue.length >= maxQueued) throw requestError('请求调度队列已满', { errorCode: 'QUEUE_FULL', stage: 'queue' });
    } catch (error) {
      metrics.rejected++;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const entry = { ...context, priority: normalizePriority(priority), order: order++, resolve, reject };
      queue.push(entry);
      if (entry.signal) {
        entry.onAbort = () => {
          metrics.cancelled++;
          rejectEntry(entry, requestError('请求已取消', { errorCode: 'REQUEST_CANCELLED', stage: 'queue' }));
          drain();
        };
        entry.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (Number.isFinite(entry.deadline)) {
        entry.timer = setTimeout(() => {
          metrics.expired++;
          rejectEntry(entry, requestError('请求等待期限已到', { errorCode: 'REQUEST_DEADLINE', stage: 'queue' }));
          drain();
        }, Math.max(0, entry.deadline - Date.now()));
      }
      drain();
    });
  }

  function cancelQueued(reason = '业务请求已取消', predicate = entry => entry.priority !== 'critical') {
    let count = 0;
    for (const entry of [...queue]) {
      if (!predicate(entry)) continue;
      count++;
      metrics.cancelled++;
      rejectEntry(entry, reason instanceof Error ? reason : requestError(reason, { errorCode: 'QUEUE_CANCELLED', stage: 'queue' }));
    }
    return count;
  }
  function close(reason = '请求调度已关闭') {
    closed = true;
    return cancelQueued(reason, () => true);
  }
  function snapshot() {
    return {
      active: active + criticalActive, businessActive: active, criticalActive,
      queued: queue.length, maxActive, maxCritical, maxQueued, closed,
      byPriority: queue.reduce((result, item) => {
        result[item.priority] = (result[item.priority] || 0) + 1;
        return result;
      }, {}),
      metrics: { ...metrics },
    };
  }
  return { acquire, cancelQueued, close, snapshot };
}

// 精确 service/method 配对，不以 Get 前缀推断只读或以 priority 推断保活。
const SAFE_READ_METHODS = Object.freeze([
  ['gamepb.itempb.ItemService', 'Bag'],
  ['gamepb.plantpb.PlantService', 'AllLands'],
  ['gamepb.dogpb.DogService', 'GetDogInfo'],
  ['gamepb.careerpb.CareerService', 'CareerInfoGet'],
  ['gamepb.activitypb.ActivityService', 'GetGroup'],
  ['gamepb.shoppb.ShopService', 'ShopInfo'],
  ['gamepb.shoppb.ShopService', 'ShopProfiles'],
  ['gamepb.mallpb.MallService', 'GetMallListBySlotType'],
  // 牧场一期只读；场景切换 PlayerSceneLogin 明确不在安全读白名单。
  ['gamepb.homesteadpb.HomesteadService', 'AllCells'],
  ['gamepb.animalpb.AnimalService', 'GetRanchDetail'],
  ['gamepb.animalpb.RanchService', 'GetRanchOpTimes'],
  ['gamepb.itempb.ItemService', 'GetBag'],
  ['gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail'],
  ['gamepb.paypb.PayService', 'GetRechargeInfo'],
  ['gamepb.taskpb.TaskService', 'TaskInfo'],
  ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedListV2'],
  ['gamepb.illustratedpb.IllustratedService', 'GetIllustratedLevelListV2'],
  ['gamepb.illustratedpb.IllustratedService', 'GetRanchWeightScoreV2'],
  ['gamepb.userpb.UserService', 'BatchGetBasicInfo'],
  ['gamepb.sharepb.ShareService', 'CheckCanShare'],
  ['gamepb.shoppb.ShopService', 'RotationShopInfo'],
  ['gamepb.activitypb.ActivityService', 'List'],
].map(pair => Object.freeze(pair)));
const CRITICAL_METHODS = Object.freeze([
  ['gamepb.userpb.UserService', 'Login'],
  ['gamepb.userpb.UserService', 'Heartbeat'],
  ['gamepb.acepb.AceService', 'AntiData'],
].map(pair => Object.freeze(pair)));
const safeMethods = new Set(SAFE_READ_METHODS.map(pair => JSON.stringify(pair)));
const criticalMethods = new Set(CRITICAL_METHODS.map(pair => JSON.stringify(pair)));
function isSafeReadRequest(service, method) { return safeMethods.has(JSON.stringify([service, method])); }
function isCriticalRequest(service, method) { return criticalMethods.has(JSON.stringify([service, method])); }

function getRequestOptions(meta, defaultTimeoutMs, defaultWireTimeoutMs = defaultTimeoutMs) {
  const context = getRequestContext();
  const explicitTimeout = typeof meta === 'number' ? meta : meta?.timeoutMs;
  const validTimeout = Number.isFinite(explicitTimeout) && explicitTimeout > 0;
  const timeoutMs = Math.min(60000, validTimeout ? explicitTimeout : defaultTimeoutMs);
  return {
    priority: normalizePriority(meta?.priority || context.priority), signal: context.signal,
    deadline: Math.min(Date.now() + timeoutMs, Number.isFinite(context.deadline) ? context.deadline : Infinity),
    timeoutMs, wireTimeoutMs: Math.min(60000, validTimeout ? explicitTimeout : defaultWireTimeoutMs),
    settlementTimeoutMs: 120000,
  };
}

function createSafeReadFlights(options = {}) {
  const maxEntries = Math.min(109, Math.max(1, options.maxEntries || 109));
  const maxWaiters = Math.min(100, Math.max(1, options.maxWaiters || 100));
  const flights = new Map();
  const live = new Set();
  let mutationGeneration = 0;
  let waiters = 0;
  const metrics = { started: 0, shared: 0, cancelled: 0, invalidated: 0, settled: 0 };

  function invalidate() {
    mutationGeneration++;
    flights.clear();
    metrics.invalidated++;
  }
  function run({ accountId, epoch, service, method, body, context, execute }) {
    try { throwIfRequestCancelled(context); } catch (error) { return Promise.reject(error); }
    const hash = createHash('sha256').update(body).digest('hex');
    const key = JSON.stringify([String(accountId), epoch, service, method, hash, mutationGeneration]);
    let flight = flights.get(key);
    if (flight && Date.now() >= flight.deadline) {
      flights.delete(key);
      flight = null;
    }
    if (waiters >= maxWaiters || (!flight && live.size >= maxEntries)) {
      return Promise.reject(requestError('只读共享请求已满', { errorCode: 'READ_FLIGHTS_FULL', stage: 'queue' }));
    }
    if (!flight) {
      const lifetime = Number.isFinite(context.timeoutMs) && context.timeoutMs > 0 ? Math.min(context.timeoutMs, 60000) : 60000;
      flight = { controller: new AbortController(), waiters: 0, sent: false, settled: false,
        subscribers: new Set(), deadline: Date.now() + lifetime, onNoWaiters: null };
      flights.set(key, flight);
      live.add(flight);
      metrics.started++;
      flight.promise = Promise.resolve().then(() => execute({
        signal: flight.controller.signal,
        deadline: flight.deadline,
        validateWaiters: () => {
          throwIfRequestCancelled({ deadline: flight.deadline });
          if (![...flight.subscribers].some(waiter => !waiter.context.signal?.aborted
            && (!Number.isFinite(waiter.context.deadline) || Date.now() < waiter.context.deadline))) {
            throw requestError('只读请求已无有效等待者', { errorCode: 'REQUEST_CANCELLED', stage: 'queue' });
          }
        },
        setOnNoWaiters: callback => { flight.onNoWaiters = callback; },
        markSent: () => { flight.sent = true; },
      })).finally(() => {
        flight.settled = true;
        flight.onNoWaiters = null;
        if (flights.get(key) === flight) flights.delete(key);
        live.delete(flight);
        metrics.settled++;
      });
    } else metrics.shared++;
    const subscriber = { context };
    flight.waiters++;
    flight.subscribers.add(subscriber);
    waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const onAbort = () => {
        metrics.cancelled++;
        finish(requestError('只读等待已取消', { errorCode: 'REQUEST_CANCELLED', stage: 'wait' }));
      };
      function finish(error, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        flight.waiters--;
        flight.subscribers.delete(subscriber);
        waiters--;
        if (!flight.waiters && !flight.settled) {
          if (flights.get(key) === flight) flights.delete(key);
          if (!flight.sent) flight.controller.abort();
          else if (flight.onNoWaiters) flight.onNoWaiters();
        }
        if (error) reject(error);
        else {
          try {
            resolve({ ...value, body: Buffer.isBuffer(value.body) ? Buffer.from(value.body) : value.body,
              meta: clonePlainMeta(value.meta || {}) });
          } catch (cloneError) {
            reject(requestError(cloneError.message, { stage: 'decode', sent: flight.sent, resultState: 'failed' }));
          }
        }
      }
      context.signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(context.deadline)) {
        timer = setTimeout(() => finish(requestError('只读等待期限已到', {
          errorCode: 'REQUEST_DEADLINE', stage: 'wait', sent: flight.sent,
          resultState: flight.sent ? 'failed' : 'not_sent',
        })), Math.max(0, context.deadline - Date.now()));
      }
      flight.promise.then(value => finish(null, value), error => finish(error));
    });
  }
  function cancelUnsent() {
    for (const flight of [...live]) {
      if (flight.settled || flight.sent) continue;
      flight.controller.abort();
    }
    invalidate();
  }
  function snapshot() {
    return { inFlight: live.size, shareable: flights.size, waiters, mutationGeneration, maxEntries, maxWaiters, metrics: { ...metrics } };
  }
  return { run, invalidate, cancelUnsent, snapshot };
}

function createWriteDrain(getCount) {
  const waiters = new Set();
  function notify() {
    if (getCount() !== 0) return;
    for (const waiter of [...waiters]) waiter.finish(true);
  }
  function wait(timeoutMs = 155000) {
    if (getCount() === 0) return Promise.resolve({ drained: true, pendingWrites: 0 });
    if (waiters.size) return waiters.values().next().value.promise;
    const budget = Math.min(155000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 155000));
    const waiter = {};
    waiter.promise = new Promise(resolve => {
      let timer;
      let done = false;
      waiter.finish = drained => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        waiters.delete(waiter);
        resolve({ drained, pendingWrites: getCount() });
      };
      timer = setTimeout(() => waiter.finish(false), budget);
    });
    waiters.add(waiter);
    return waiter.promise;
  }
  return { wait, notify };
}

module.exports = {
  PRIORITIES, normalizePriority, runWithRequestPriority, getRequestPriority,
  runWithRequestContext, getRequestContext, throwIfRequestCancelled,
  createRequestGate, requestError, getRequestOptions, createWriteDrain,
  SAFE_READ_METHODS, CRITICAL_METHODS, isSafeReadRequest, isCriticalRequest, createSafeReadFlights,
};
