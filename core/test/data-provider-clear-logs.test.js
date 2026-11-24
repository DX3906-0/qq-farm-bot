const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createDataProvider } = require('../src/runtime/data-provider');

// 所有被测入口使用 VM 与假进程；fs 仅用于读取源码，任何未列出的模块禁止加载。
function createVmHarness() {
  const timers = new Map();
  let timerId = 0;
  let clock = null;
  const now = () => clock === null ? Date.now() : clock;
  class VmDate extends Date { static now() { return now(); } }
  const context = new AsyncLocalStorage();
  const transportUtil = {
    getRequestContext: () => context.getStore() || {},
    runWithRequestContext: (value, fn) => context.run(value, fn),
    requestError: (message, meta = {}) => Object.assign(new Error(message), { sent: false, resultState: 'not_sent', ...meta }),
  };
  const scheduler = {
    setTimeoutTask: (key, ms, fn) => timers.set(key, { ms, fn, due: now() + ms }),
    setIntervalTask: (key, ms, fn) => timers.set(key, { ms, fn, due: now() + ms, interval: true }),
    clear: key => timers.delete(key),
    clearAll: () => timers.clear(),
  };
  function load(relative, extra = {}, appended = '', transform = source => source) {
    const sandbox = {
      module: { exports: {} }, exports: {}, console, AbortController, Date: VmDate,
      process: { env: {}, uptime: () => 1 },
      setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, due: now() + ms }); return id; },
      clearTimeout: id => timers.delete(id),
      setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, due: now() + ms }); return id; },
      clearInterval: id => timers.delete(id),
      require(name) {
        if (name === '../utils/request-priority') return transportUtil;
        if (name === '../services/scheduler') return { createScheduler: () => scheduler };
        if (Object.hasOwn(extra, name)) return extra[name];
        if (name === '../services/account-maintenance-hold') return { isAccountMaintenanceHeld: () => false };
        throw new Error(`禁止加载模块：${name}`);
      },
    };
    vm.runInNewContext(transform(fs.readFileSync(path.join(__dirname, relative), 'utf8')) + appended, sandbox);
    return sandbox.module.exports;
  }
  function fire(key) {
    const timer = timers.get(key);
    assert.ok(timer, `缺少计时器 ${key}`);
    timers.delete(key);
    timer.fn();
  }
  function freezeClock() { clock = Date.now(); }
  function advance(ms) {
    if (clock === null) freezeClock();
    const end = clock + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      clock = next[1].due;
      fire(next[0]);
      if (next[1].interval) timers.set(next[0], { ...next[1], due: clock + next[1].ms });
    }
    clock = end;
  }
  return { timers, load, fire, context, transportUtil, freezeClock, advance };
}

function createRpcHarness(options = {}) {
  const h = createVmHarness();
  const processes = [];
  const logs = [];
  const workers = {};
  const processRef = Object.assign(new EventEmitter(), { env: {} });
  const { createWorkerManager } = h.load('../src/runtime/worker-manager.js', {
    '../models/store': { persistInactiveActivityAutomation: () => [] },
    './gateway-routing': { resolveAccountGatewaySocket: () => ({}) },
  }, '', options.managerTransform);
  const globalLogs = [];
  const manager = createWorkerManager({
    runtimeMode: 'fork', processRef, workers, globalLogs,
    fork: () => {
      const proc = Object.assign(new EventEmitter(), { connected: true, messages: [], killed: 0, kill() { this.killed += 1; } });
      proc.send = (message, cb) => { proc.messages.push(message); if (cb) cb(null); };
      processes.push(proc);
      return proc;
    },
    log: (...args) => logs.push(args), addAccountLog() {},
    normalizeStatusForPanel: value => value,
    buildConfigSnapshotForAccount: () => ({}),
    addOrUpdateAccount() {}, triggerOfflineReminder() {}, getOfflineAutoDeleteMs: () => Infinity,
  });
  manager.startWorker({ id: 'account-1', name: '测试账号' });
  const proc = processes[0];
  const calls = () => proc.messages.filter(item => item.type === 'api_call');
  const cancels = () => proc.messages.filter(item => item.type === 'api_cancel');
  const reply = (id, result, error, errorMeta) => proc.emit('message', { type: 'api_response', id, result, error, errorMeta });
  const run = (options, method, ...args) => h.context.run(options, () => manager.callWorkerApi('account-1', method, ...args));
  return { ...h, manager, workers, proc, calls, cancels, reply, run, logs, globalLogs, processRef };
}

test('牧场巡查日志经 worker 缓冲及 /api/logs 按账号和模块返回', () => {
  const h = createRpcHarness();
  const logger = { createModuleLogger: () => ({ info() {}, warn() {}, error() {} }), sanitizeMeta: meta => ({ ...meta }) };
  const { log, logWarn, setLogHook } = h.load('../src/utils/utils.js', { long: {}, '../services/logger': logger });
  const { createRuntimeState } = h.load('../src/runtime/runtime-state.js', {
    'node:events': EventEmitter, '../services/logger': logger,
    '../services/stats': { getTodayKey: () => 'fixture', loadPersistedStats: () => null },
  });
  const { filterLogs } = createRuntimeState({ store: {} });
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
  vm.runInNewContext(workerSource.slice(workerSource.indexOf('setLogHook(('), workerSource.indexOf('setRecordGoldExpHook((')), {
    setLogHook, sendToMaster: msg => h.proc.emit('message', msg), formatLocalDateTime24: () => '2026-11-21 12:00:00',
  });
  log('牧场', '自动巡查完成：无待执行动作', { event: 'ranch_patrol_complete', result: 'idle' });
  logWarn('系统', '自动巡查已暂停', { module: 'ranch', event: 'ranch_patrol_paused', result: 'unknown' });
  log('系统', '其他模块');
  h.globalLogs.push({ accountId: 'account-2', tag: '牧场', meta: { module: 'ranch' } });
  const provider = createDataProvider({ globalLogs: h.globalLogs, workers: h.workers, filterLogs,
    getAccounts: () => ({ accounts: [{ id: 'account-1' }, { id: 'account-2' }] }),
  });
  const { registerAdminAccountRoutes } = require('../src/controllers/admin-account-routes');
  let handler;
  registerAdminAccountRoutes({
    app: { get(path, fn) { if (path === '/api/logs') handler = fn; }, post() {}, delete() {}, put() {}, patch() {} },
    provider, resolveAccountReference: id => id, canAccessAccount: () => true,
  });
  const readLogs = module => {
    let response;
    handler({ currentUser: {}, query: { accountId: 'account-1', module, limit: '100' } }, { json(body) { response = body; } });
    assert.equal(response.ok, true);
    return response.data;
  };
  const rows = readLogs('ranch');
  assert.deepEqual(Array.from(rows, row => [row.tag, row.msg, row.isWarn, row.meta.event, row.meta.result]), [
    ['牧场', '自动巡查完成：无待执行动作', false, 'ranch_patrol_complete', 'idle'],
    ['牧场', '自动巡查已暂停', true, 'ranch_patrol_paused', 'unknown'],
  ]);
  assert.deepEqual(Array.from(readLogs('system'), row => row.msg), ['其他模块']);
});

function createProvider(globalLogs, accountLogs) {
  return createDataProvider({
    workers: {},
    globalLogs,
    accountLogs,
    store: {},
    getAccounts: () => ({
      accounts: [
        { id: 'account-1' },
        { id: 'account-2' }
      ]
    }),
    filterLogs: logs => logs
  });
}

test('真实runtime-state配置广播必须含账号独立friendBadRetryDate，清暂停和开关是独立字段', () => {
  const h = createVmHarness();
  const { createRuntimeState } = h.load('../src/runtime/runtime-state.js', {
    'node:events': EventEmitter,
    '../services/logger': { createModuleLogger: () => ({ info() {}, error() {} }) },
    '../services/stats': { getTodayKey: () => 'fixture', loadPersistedStats: () => null },
  });
  const configs = { 'account-1': '2026-11-15', 'account-2': '' };
  const store = { getFriendBadRetryDate: id => configs[id], getAutomation: () => ({ friend_bad: true }),
    getPlantingStrategy: () => 'preferred', getPreferredSeed: () => 1, getPrioritize2x2Crops: () => true,
    getIntervals: () => ({}), getFriendQuietHours: () => ({}), getFriendBlacklist: () => [], getFriendBadTargets: () => [],
    getPlantBlacklist: () => [], getKnownFriendGids: () => [], getBagSeedPriority: () => [], getBagSeedFallbackStrategy: () => '',
    getAutoAcceptFriendMinLevel: () => 0 };
  const state = createRuntimeState({ store });
  assert.equal(state.buildConfigSnapshotForAccount('account-1').friendBadRetryDate, '2026-11-15');
  configs['account-1'] = ''; state.nextConfigRevision();
  const next = state.buildConfigSnapshotForAccount('account-1');
  assert.equal(next.friendBadRetryDate, ''); assert.equal(next.automation.friend_bad, true);
  assert.equal(state.buildConfigSnapshotForAccount('account-2').friendBadRetryDate, '');
});

test('恢复虫草旧暂停只更新日期，不切换开关/清预算/发送游戏RPC且回读真实账号', async () => {
  const patches = [], broadcasts = [];
  let retryDate = '2026-11-15';
  const provider = createDataProvider({ workers: {}, globalLogs: [], accountLogs: [],
    getAccounts: () => ({ accounts: [{ id: 'account-1' }] }),
    nextConfigRevision: () => 7, broadcastConfigToWorkers: id => broadcasts.push(id),
    store: { isAutomationOn: () => true, getFriendBadRetryDate: () => retryDate,
      applyConfigSnapshot(patch, options) { patches.push({ patch, options }); retryDate = patch.friendBadRetryDate; } },
    callWorkerApi: () => assert.fail('恢复暂停不能发送游戏RPC'),
  });
  const result = await provider.resumeFriendBad('account-1');
  assert.deepEqual(patches, [{ patch: { friendBadRetryDate: '' }, options: { accountId: 'account-1' } }]);
  assert.equal(result.friendBadRetryDate, ''); assert.equal(result.budgetReset, false); assert.equal(result.gameRpcSent, false);
  assert.deepEqual(broadcasts, ['account-1']);
});

test('clearLogs removes runtime and historical system logs for one account', () => {
  const globalLogs = [
    { accountId: 'account-1', msg: 'runtime one' },
    { accountId: 'account-2', msg: 'runtime two' },
    { msg: 'global system log' }
  ];
  const accountLogs = [
    { accountId: 'account-1', msg: 'history one' },
    { accountId: 'account-2', msg: 'history two' }
  ];
  const provider = createProvider(globalLogs, accountLogs);

  assert.deepEqual(provider.clearLogs('account-1'), {
    cleared: 2,
    clearedRuntimeLogs: 1,
    clearedAccountLogs: 1,
    accountId: 'account-1'
  });
  assert.deepEqual(globalLogs, [
    { accountId: 'account-2', msg: 'runtime two' },
    { msg: 'global system log' }
  ]);
  assert.deepEqual(accountLogs, [
    { accountId: 'account-2', msg: 'history two' }
  ]);
});

test('clearLogs removes all runtime and historical system logs for all accounts', () => {
  const globalLogs = [{ accountId: 'account-1' }, { accountId: 'account-2' }];
  const accountLogs = [{ accountId: 'account-1' }, { accountId: 'account-2' }];
  const provider = createProvider(globalLogs, accountLogs);

  assert.deepEqual(provider.clearLogs('all'), {
    cleared: 'all',
    clearedRuntimeLogs: 2,
    clearedAccountLogs: 2
  });
  assert.deepEqual(globalLogs, []);
  assert.deepEqual(accountLogs, []);
});

test('RPC 并发安全读只发一次，返回副本且不缓存已完成结果', async () => {
  const h = createRpcHarness();
  try {
    const promises = Array.from({ length: 12 }, () => h.run({}, 'getBag'));
    const reordered = h.run({}, 'getBag', undefined);
    assert.equal(h.calls().length, 1);
    h.reply(h.calls()[0].id, { items: [{ count: 1 }] });
    const results = await Promise.all([...promises, reordered]);
    results[0].items[0].count = 99;
    assert.equal(results[1].items[0].count, 1);
    const next = h.run({}, 'getBag');
    assert.equal(h.calls().length, 2);
    h.reply(h.calls()[1].id, {});
    await next;
    assert.equal(h.workers['account-1'].requests.size, 0);
  } finally { h.manager.shutdown(); }
});

test('单个订阅者取消不影响其他读，最后取消才取消底层并保留 flight', async () => {
  const h = createRpcHarness();
  try {
    const first = new AbortController();
    const second = new AbortController();
    const p1 = h.run({ signal: first.signal }, 'getLands');
    const p2 = h.run({ signal: second.signal }, 'getLands');
    first.abort();
    await assert.rejects(p1, { errorCode: 'CANCELLED' });
    assert.equal(h.cancels().length, 0);
    h.reply(h.calls()[0].id, { ok: true });
    await p2;
    const third = new AbortController();
    const p3 = h.run({ signal: third.signal }, 'getBag');
    third.abort();
    await assert.rejects(p3, { errorCode: 'CANCELLED' });
    assert.equal(h.cancels().length, 1);
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'DEADLINE' });
    assert.equal(h.calls().length, 2);
    assert.equal(h.manager.getDiagnostics('account-1').pending, 1);
    h.reply(h.calls()[1].id, {});
    assert.equal(h.manager.getDiagnostics('account-1').pending, 0);
  } finally { h.manager.shutdown(); }
});

test('写开始与完成隔离旧读，身份和 sessionEpoch 隔离读，不取消旧读', async () => {
  const h = createRpcHarness();
  try {
    const old = h.run({}, 'getBag');
    const write = h.run({}, 'useItem', 1, 1);
    const middle = h.run({}, 'getBag');
    assert.equal(h.calls().length, 3);
    h.reply(h.calls()[1].id, {});
    await write;
    const after = h.run({}, 'getBag');
    h.workers['account-1'].status = { status: { gid: '2' }, stats: { gatewayTransport: { sessionEpoch: 1 } } };
    const identity = h.run({}, 'getBag');
    h.workers['account-1'].status.stats.gatewayTransport.sessionEpoch = 2;
    const epoch = h.run({}, 'getBag');
    assert.equal(h.calls().length, 6);
    assert.equal(h.cancels().length, 0);
    for (const call of h.calls()) h.reply(call.id, { id: call.id });
    await Promise.all([old, middle, after, identity, epoch]);
    assert.equal(h.manager.getDiagnostics('account-1').mutationGeneration, 2);
  } finally { h.manager.shutdown(); }
});

test('只有显式白名单读合并；强制好友、Visit 活动与已发送写均不合并', async () => {
  const h = createRpcHarness();
  try {
    const promises = [];
    for (const method of ['getFriends', 'getFriendLands', 'getRainPoemActivity', 'getSkins', 'getUnreviewedMethod', 'useItem']) {
      promises.push(h.run({}, method, true), h.run({}, method, true));
    }
    assert.equal(h.calls().length, 12);
    assert.ok(h.calls().every(call => call.readOnly === false));
    for (const call of h.calls()) h.reply(call.id, {});
    await Promise.all(promises);
  } finally { h.manager.shutdown(); }
});

test('deadline 取消安全读，已取消或超期未发送写不执行，已发送写保留未知结果且不重试', async () => {
  const h = createRpcHarness();
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(h.run({ signal: aborted.signal }, 'useItem'), { sent: false });
    await assert.rejects(h.run({ deadline: Date.now() - 1 }, 'useItem'), { errorCode: 'DEADLINE', sent: false });
    assert.equal(h.calls().length, 0);
    const read = h.run({ deadline: Date.now() + 120000 }, 'getPetOverview', { _timeoutMs: 600000 });
    const readCall = h.calls()[0];
    assert.ok(readCall.deadline <= Date.now() + 120000);
    h.fire(`api_timeout_account-1_${readCall.id}`);
    await assert.rejects(read, { errorCode: 'DEADLINE' });
    assert.equal(h.cancels().length, 1);
    h.reply(readCall.id, {});
    const write = h.run({}, 'useItem', 1, { _timeoutMs: 180000 });
    const writeCall = h.calls()[1];
    assert.deepEqual(JSON.parse(JSON.stringify(writeCall.args)), [1]);
    h.fire(`api_timeout_account-1_${writeCall.id}`);
    await assert.rejects(write, { errorCode: 'DEADLINE', sent: true, resultState: 'unknown', outcomeUnknown: true });
    assert.equal(h.cancels().length, 1);
    assert.equal(h.calls().length, 2);
    assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'unknown');
    h.reply(writeCall.id, { secret: '禁止保存的结果' });
    const diagnostics = h.manager.getDiagnostics('account-1');
    assert.equal(diagnostics.lateResults[0].resultState, 'completed');
    assert.equal(diagnostics.lateResults[0].outcomeUnknown, false);
    assert.ok(!JSON.stringify(diagnostics).includes('secret'));
    assert.ok(!JSON.stringify(h.logs).includes('禁止保存的结果'));
  } finally { h.manager.shutdown(); }
});

test('api_cancel 发送失败封闭 worker，不能释放后重复发送仍在途读', async () => {
  const h = createRpcHarness();
  try {
    const controller = new AbortController();
    const promise = h.run({ signal: controller.signal }, 'getBag');
    h.proc.send = (message, callback) => { h.proc.messages.push(message); callback(new Error('取消 IPC 失败')); };
    controller.abort();
    await assert.rejects(promise, { errorCode: 'CANCELLED' });
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'WORKER_NOT_RUNNING' });
    assert.equal(h.calls().length, 1);
    assert.equal(h.cancels().length, 1);
    assert.equal(h.manager.getDiagnostics('account-1').pending, 0);
  } finally { h.manager.shutdown(); }
});

test('顶层参数严格校验，剥离尾部 undefined，强制好友长请求 args_timeout 保留', async () => {
  const h = createRpcHarness();
  try {
    const first = h.run({}, 'getBag', undefined);
    const second = h.run({}, 'getBag');
    assert.equal(h.calls().length, 1);
    h.reply(h.calls()[0].id, {});
    await Promise.all([first, second]);
    const before = Date.now();
    const long = h.run({}, 'getFriends', true, { _timeoutMs: 180000 });
    const call = h.calls()[1];
    assert.ok(call.deadline >= before + 180000);
    assert.deepEqual(JSON.parse(JSON.stringify(call.args)), [true]);
    h.reply(call.id, {});
    await long;
  } finally { h.manager.shutdown(); }
});

test('好友土地provider→manager为Enter/Leave保留90秒，不归类安全读、不自动重放', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const provider = createDataProvider({ workers: h.workers, store: {}, getAccounts: () => ({ accounts: [{ id: 'account-1' }] }),
    callWorkerApi: h.manager.callWorkerApi });
  try {
    const request = h.context.run({ deadline: Date.now() + 120000 }, () => provider.getFriendLands('account-1', '11'));
    const call = h.calls()[0];
    assert.deepEqual(JSON.parse(JSON.stringify(call.args)), ['11']);
    assert.equal(call.readOnly, false, '访问会改变服务端场景，不得加进普通安全读白名单');
    const timer = h.timers.get(`api_timeout_account-1_${call.id}`);
    assert.equal(timer.ms, 90000);
    h.advance(11000);
    assert.equal(h.cancels().length, 0);
    assert.equal(h.logs.some(args => args[1]?.includes('迟到')), false);
    const result = { lands: [{ id: 1, unlocked: true, status: 'empty' }], summary: { growing: [] } };
    h.reply(call.id, result);
    assert.deepEqual(JSON.parse(JSON.stringify(await request)), result);
    assert.equal(h.calls().length, 1);
    assert.equal(h.manager.getDiagnostics('account-1').pending, 0);
    // 旧入口缺少专用预算时，11秒正常回包无法交付；只在同一个假manager中复现。
    const old = h.run({}, 'getFriendLands', '11');
    const rejected = assert.rejects(old, { errorCode: 'DEADLINE', outcomeUnknown: true });
    h.advance(11000);
    h.reply(h.calls()[1].id, result);
    await rejected;
    assert.equal(h.calls().length, 2);
  } finally { h.manager.shutdown(); }
});

test('旧访友恢复provider真实接线：90秒非安全读、无自动重放，遗漏接线必须复现失败', async () => {
  const h = createRpcHarness();
  h.freezeClock(); // 与好友土地预算测试一致，隔离真实时钟推进造成的89999ms偶发差异。
  const deps = { workers: h.workers, store: {}, getAccounts: () => ({ accounts: [{ id: 'account-1' }] }),
    callWorkerApi: h.manager.callWorkerApi };
  try {
    const provider = createDataProvider(deps);
    const options = { dryRun: true };
    const result = provider.recoverLegacyFriendVisit('account-1', options);
    const call = h.calls()[0];
    assert.equal(call.method, 'recoverLegacyFriendVisit');
    assert.equal(call.readOnly, false);
    assert.deepEqual(JSON.parse(JSON.stringify(call.args)), [options]);
    assert.equal(h.timers.get(`api_timeout_account-1_${call.id}`).ms, 90000);
    h.reply(call.id, { eligible: true, dryRun: true, gameRpcSent: false });
    assert.equal((await result).gameRpcSent, false);
    assert.equal(h.calls().length, 1);
    const old = h.load('../src/runtime/data-provider.js', {
      '../services/account-resolver': require('../src/services/account-resolver'),
      '../services/scheduler': { getSchedulerRegistrySnapshot: () => [] },
    }, '', source => source.replace(/^\s*recoverLegacyFriendVisit:.*\n/m, '\n')).createDataProvider(deps);
    assert.throws(() => old.recoverLegacyFriendVisit('account-1', options), TypeError);
    assert.equal(h.calls().length, 1, '缺接线的旧provider不能发出任何恢复请求');
  } finally { h.manager.shutdown(); }
});

test('神秘商人provider专用60秒等待仍保留真实失败，不改购买等待策略', async () => {
  const calls = [];
  const provider = createDataProvider({ workers: {}, store: {}, getAccounts: () => ({ accounts: [{ id: 'account-1' }] }),
    callWorkerApi: async (...args) => { calls.push(args); return { active: false, skipped: true, reason: 'inactive' }; } });
  assert.equal((await provider.getMysteryShop('account-1')).reason, 'inactive');
  assert.deepEqual(calls[0], ['account-1', 'getMysteryShop', { _timeoutMs: 60000 }]);
  await provider.buyMysteryShopGoods('account-1', 8);
  assert.deepEqual(calls[1], ['account-1', 'buyMysteryShopGoods', 8]);
});

test('取消写不发 api_cancel，HTTP 上下文仍能标识写的未知结果', async () => {
  const h = createRpcHarness();
  try {
    const controller = new AbortController();
    const rpcOutcome = { pendingWrites: 0 };
    const promise = h.run({ signal: controller.signal, rpcOutcome }, 'useItem', 1);
    controller.abort();
    await assert.rejects(promise, { sent: true, outcomeUnknown: true });
    assert.equal(rpcOutcome.pendingWrites, 1);
    assert.equal(h.cancels().length, 0);
    h.reply(h.calls()[0].id, {});
    assert.equal(rpcOutcome.pendingWrites, 0);
  } finally { h.manager.shutdown(); }
});

test('好友土地已有unknown立即拒绝不是迟到结算，IPC派发不得冒充本次游戏写发送', async () => {
  const assertNoFakeLate = async h => {
    try {
      const request = h.run({}, 'getFriendLands', '11', { _timeoutMs: 90000 });
      const call = h.calls()[0];
      h.reply(call.id, null, '好友访问状态未知，等待真实游戏连接代际改变', {
        errorCode: 'VISIT_STATE_UNKNOWN', stage: 'visit', sent: false, resultState: 'unknown', outcomeUnknown: false,
      });
      await assert.rejects(request, { errorCode: 'VISIT_STATE_UNKNOWN', sent: false, resultState: 'unknown', outcomeUnknown: false });
      assert.equal(h.logs.some(args => /迟到结算|迟到结果/.test(args[1] || '')), false);
      assert.equal(h.manager.getDiagnostics('account-1').lateResults.length, 0);
      assert.equal(h.manager.getDiagnostics('account-1').pending, 0);
      assert.equal(h.cancels().length, 0);
      assert.equal(h.calls().length, 1);
    } finally { h.manager.shutdown(); }
  };
  await assertNoFakeLate(createRpcHarness());
});

test('立即终态unknown仍可诊断，但不伪记为等待迟到并结算；真实超时保留迟到流程', async () => {
  const h = createRpcHarness();
  try {
    const request = h.run({}, 'useItem', 1);
    h.reply(h.calls()[0].id, null, '传输结果未知', {
      errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    await assert.rejects(request, { sent: true, resultState: 'unknown', outcomeUnknown: true });
    const record = h.manager.getDiagnostics('account-1').lateResults[0];
    assert.equal(record.resultState, 'unknown');
    assert.equal(record.outcomeUnknown, true);
    assert.equal(record.late, false);
    assert.equal(h.logs.some(args => /迟到结算|迟到结果/.test(args[1] || '')), false);
    assert.equal(h.logs.some(args => args[1] === 'Worker 写请求终态结果未知'), true);
    assert.equal(h.manager.getDiagnostics('account-1').pending, 0);
    h.reply(h.calls()[0].id, {});
    assert.equal(h.logs.some(args => /迟到结算|迟到结果/.test(args[1] || '')), false);
    assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'completed');

    const late = h.run({}, 'useItem', 2, { _timeoutMs: 50 });
    const call = h.calls().at(-1);
    const rejected = assert.rejects(late, { errorCode: 'DEADLINE', outcomeUnknown: true });
    h.advance(51); await rejected;
    assert.equal(h.logs.filter(args => args[1] === 'Worker 写请求等待迟到结算').length, 1);
    assert.equal(h.manager.getDiagnostics('account-1').pending, 1);
    h.reply(call.id, {});
    assert.equal(h.logs.filter(args => args[1] === 'Worker 写请求迟到结果已结算').length, 1);
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.at(-1).resultState, 'completed');
    assert.equal(h.cancels().length, 0);
  } finally { h.manager.shutdown(); }
});

test('shop catalog getter is a safe top-level read, coalesces without a write slot and never creates unknown-write diagnostics', async () => {
  const h = createRpcHarness();
  try {
    const first = h.run({}, 'getDecorationShop'), second = h.run({}, 'getDecorationShop');
    assert.equal(h.calls().length, 1); assert.equal(h.calls()[0].readOnly, true);
    assert.equal(h.manager.getDiagnostics('account-1').writeCount, 0);
    h.reply(h.calls()[0].id, { items: [{ id: 2129 }] });
    await Promise.all([first, second]);
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.length, 0);
    assert.equal(h.logs.some(args => args[1] === 'Worker 写请求终态结果未知'), false);
  } finally { h.manager.shutdown(); }
});

test('shop prior-unknown rejection remains blocked but is not logged as a newly-sent unknown write', async () => {
  const h = createRpcHarness();
  try {
    const result = h.run({}, 'buyDecorationGoods', 2129, 1, {});
    h.reply(h.calls()[0].id, null, '上次结果待核对，本次没有发送', {
      errorCode: 'GAME_PRIOR_RESULT_UNKNOWN', sent: false, resultState: 'unknown', outcomeUnknown: false,
    });
    await assert.rejects(result, { errorCode: 'GAME_PRIOR_RESULT_UNKNOWN', sent: false, resultState: 'unknown', outcomeUnknown: false });
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.length, 0);
    assert.equal(h.logs.some(args => args[1] === 'Worker 写请求终态结果未知'), false);
    assert.equal(h.calls().length, 1);
  } finally { h.manager.shutdown(); }
});

test('shop definitive server rejection keeps failed metadata and never becomes a late or unknown-write result', async () => {
  const h = createRpcHarness();
  try {
    const result = h.run({}, 'buyDecorationGoods', 501, 1, {});
    h.reply(h.calls()[0].id, null, '服务器明确拒绝', {
      errorCode: 1001001, stage: 'remote', sent: true, resultState: 'failed', outcomeUnknown: false,
    });
    await assert.rejects(result, { errorCode: 1001001, stage: 'remote', resultState: 'failed', outcomeUnknown: false });
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.length, 0);
    assert.equal(h.logs.some(args => args[1] === 'Worker 写请求终态结果未知'), false);
  } finally { h.manager.shutdown(); }
});

function friendRouteHarness({ lands, error, missingProvider = false, allowed = true, routeTransform } = {}) {
  const h = createVmHarness();
  const { registerAdminFriendRoutes } = h.load('../src/controllers/admin-friend-routes.js', {}, '', routeTransform);
  const helpers = h.load('../src/controllers/admin-route-helpers.js').createAdminRouteHelpers({});
  const routes = new Map(); const saved = []; const broadcasts = []; const reads = [];
  const provider = missingProvider ? {} : {
    async getFriendLands(accountId, gid) { reads.push({ accountId, gid }); if (error) throw error; return lands; },
    broadcastConfig: accountId => broadcasts.push(accountId),
  };
  registerAdminFriendRoutes({ app: Object.fromEntries(['get', 'post', 'delete'].map(method => [method,
    (route, handler) => routes.set(`${method}:${route}`, handler)])), provider,
    store: { upsertStealPlan(accountId, plan) { saved.push({ accountId, plan }); return [plan]; } },
    getAccountIdFromRequest: () => 'account-1', canAccessAccount: () => allowed, sendProviderError: helpers.sendProviderError });
  const invokeRoute = async (route, body, role = 'admin') => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`post:${route}`)({ body, currentUser: { role } }, response);
    return response;
  };
  const invoke = async (body = { gid: 11, delaySeconds: 5 }) => {
    const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; }, json(value) { this.body = value; return this; } };
    await routes.get('post:/api/steal-plans')({ body }, response);
    return response;
  };
  return { invoke, invokeRoute, provider, saved, broadcasts, reads };
}

test('旧访友恢复HTTP：权限/显式确认门控，客户端不能绕过证据直接清锁', async () => {
  const h = friendRouteHarness(); const recovery = [];
  h.provider.recoverLegacyFriendVisit = async (accountId, options) => { recovery.push({ accountId, options }); return { eligible: true, dryRun: true }; };
  const route = '/api/friends/visit/recover';
  assert.equal((await h.invokeRoute(route, { dryRun: false }, 'user')).statusCode, 403);
  assert.equal((await h.invokeRoute(route, { dryRun: false })).statusCode, 400);
  assert.equal(recovery.length, 0);
  const dryRun = await h.invokeRoute(route, {});
  assert.equal(dryRun.body.ok, true); assert.equal(recovery[0].options.dryRun, true);
  const execute = await h.invokeRoute(route, { dryRun: false, confirm: 'COMPLETE_ORIGINAL_LEAVE_ONCE',
    evidenceId: 'fixture', stateSha256: 'sha', gid: 99, force: true });
  assert.equal(execute.body.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(recovery[1])), { accountId: 'account-1',
    options: { dryRun: false, evidenceId: 'fixture', stateSha256: 'sha' } });
  assert.equal(h.saved.length, 0); assert.equal(h.broadcasts.length, 0);
});

test('预约偷取：好友土地读取失败或unknown不能默认为成熟，不落盘、不广播或覆盖旧计划', async () => {
  for (const failure of [Object.assign(new Error('好友访问状态未知'), {
    errorCode: 'VISIT_STATE_UNKNOWN', stage: 'visit', sent: false, resultState: 'unknown', outcomeUnknown: false,
    holdUntilTransportEpochChanged: true, friendGid: 11,
  }), Object.assign(new Error('真实超时'), { errorCode: 'REQUEST_TIMEOUT', stage: 'transport', sent: true, outcomeUnknown: true })]) {
    const h = friendRouteHarness({ error: failure });
    const res = await h.invoke();
    assert.equal(res.body.ok, false); assert.equal(res.body.errorCode, failure.errorCode);
    assert.equal(res.body.sent, failure.sent); assert.equal(res.body.outcomeUnknown, failure.outcomeUnknown);
    if (failure.holdUntilTransportEpochChanged) { assert.equal(res.body.holdUntilTransportEpochChanged, true); assert.equal(res.body.friendGid, 11); }
    assert.equal(h.saved.length, 0); assert.equal(h.broadcasts.length, 0); assert.equal(h.reads.length, 1);
  }
});

test('预约偷取：内存恢复旧catch静默排立即计划必须复现缺陷，不修改生产文件', async () => {
  const failure = Object.assign(new Error('好友访问状态未知'), { errorCode: 'VISIT_STATE_UNKNOWN', sent: false,
    resultState: 'unknown', outcomeUnknown: false });
  const legacy = friendRouteHarness({ error: failure, routeTransform: source => source.replace(
    'const landsData = await provider.getFriendLands(accountId, gid);',
    "const landsData = await provider.getFriendLands(accountId, gid).catch(() => ({ lands: [{ status: 'stealable', matureInSec: 0 }] }));") });
  const res = await legacy.invoke();
  assert.equal(res.body.ok, true, '旧逻辑错误地把查询失败包装为可立即创建计划');
  assert.equal(legacy.saved.length, 1);
  assert.throws(() => assert.equal(legacy.saved.length, 0), { name: 'AssertionError' });
});

test('预约偷取：畸形/空土地/未知成熟数据拒绝，不能用默认0排立即执行', async () => {
  for (const lands of [undefined, {}, { lands: null }, { lands: [] }, { lands: [{ status: 'growing' }] },
    { lands: [{ status: 'growing', matureInSec: -1 }] }, { lands: [{ status: 'growing', matureInSec: true }] },
    { ok: false, lands: [{ status: 'stealable', matureInSec: 0 }] },
    { resultState: 'unknown', lands: [{ status: 'stealable', matureInSec: 0 }] },
    { lands: [{ status: 'unknown', matureInSec: 0 }] }]) {
    const h = friendRouteHarness({ lands }); const res = await h.invoke();
    assert.equal(res.body.ok, false); assert.equal(h.saved.length, 0); assert.equal(h.broadcasts.length, 0);
  }
  const missing = friendRouteHarness({ missingProvider: true });
  assert.equal((await missing.invoke()).body.ok, false); assert.equal(missing.saved.length, 0);
});

test('预约偷取：确认最早成熟时间或已成熟才保存，未知不混入较早计划，权限仍守住', async () => {
  const h = friendRouteHarness({ lands: { lands: [
    { status: 'locked' }, { status: 'empty' }, { status: 'growing', matureInSec: 120 },
    { status: 'growing', matureInSec: 60 },
  ] } });
  const before = Date.now(); const res = await h.invoke(); const after = Date.now();
  assert.equal(res.body.ok, true); assert.equal(res.body.matureInSec, 60);
  assert.equal(h.saved.length, 1); assert.equal(h.broadcasts.length, 1);
  assert.ok(h.saved[0].plan.executeAt >= before + 65000 && h.saved[0].plan.executeAt <= after + 65000);
  const mature = friendRouteHarness({ lands: { lands: [{ status: 'stealable', matureInSec: 0 }] } });
  assert.equal((await mature.invoke()).body.matureInSec, 0); assert.equal(mature.saved.length, 1);
  const denied = friendRouteHarness({ lands: { lands: [{ status: 'stealable', matureInSec: 0 }] }, allowed: false });
  assert.equal((await denied.invoke()).statusCode, 403); assert.equal(denied.reads.length, 0); assert.equal(denied.saved.length, 0);
});

test('Worker errorMeta 完整保留原字符串和结构化字段', async () => {
  const h = createRpcHarness();
  try {
    const promise = h.run({}, 'getBag');
    h.reply(h.calls()[0].id, null, '原始错误', {
      errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: 2100,
      sent: false, resultState: 'not_sent', outcomeUnknown: false,
    });
    await assert.rejects(promise, {
      message: '原始错误', errorCode: 'HEALTH_BACKOFF', stage: 'queue', retryAfterMs: 2100,
      sent: false, resultState: 'not_sent', outcomeUnknown: false,
    });
  } finally { h.manager.shutdown(); }
});

test('旧 worker 字符串错误不把已发送写误报为未发送；重启中的 shutdown 也清理监听', async () => {
  const h = createRpcHarness();
  const promise = h.run({}, 'useItem', 1);
  h.reply(h.calls()[0].id, null, 'API Timeout');
  await assert.rejects(promise, { message: 'API Timeout', sent: true, resultState: 'unknown', outcomeUnknown: true });
  h.manager.restartWorker({ id: 'account-1', name: '测试账号' });
  h.manager.shutdown();
  assert.equal(h.proc.listenerCount('exit'), 0);
  assert.equal(h.proc.listenerCount('message'), 0);
  assert.equal(h.timers.size, 0);
});

test('pending 与订阅者有界，进程发送失败、退出、shutdown 清理计时器和监听', async () => {
  const h = createRpcHarness();
  try {
    const promises = Array.from({ length: 100 }, (_, i) => h.run({}, 'getBag', i));
    await assert.rejects(h.run({}, 'getBag', 101), { errorCode: 'QUEUE_FULL', sent: false });
    assert.equal(h.manager.getDiagnostics('account-1').pending, 100);
    const rejected = Promise.all(promises.map(p => assert.rejects(p, { errorCode: 'WORKER_EXITED' })));
    h.proc.emit('error', new Error('假进程退出'));
    await rejected;
    assert.equal(h.workers['account-1'].requests.size, 0);
    assert.equal([...h.timers.keys()].filter(key => String(key).startsWith('api_')).length, 0);
    await assert.rejects(h.run({}, 'getBag'), { message: '账号未运行' });
    h.workers['account-1'].rpcFailed = false;
    h.proc.send = () => { throw new Error('发送失败'); };
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'WORKER_SEND_FAILED', sent: false });
    assert.equal(h.workers['account-1'].requests.size, 0);
    h.proc.send = (message, callback) => callback(new Error('IPC 失败'));
    await assert.rejects(h.run({}, 'useItem'), { errorCode: 'WORKER_SEND_FAILED', outcomeUnknown: true });
    h.proc.connected = false;
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'WORKER_NOT_RUNNING' });
  } finally { h.manager.shutdown(); }
  assert.equal(h.timers.size, 0);
  assert.equal(h.processRef.listenerCount('exit'), 0);
  assert.equal(h.processRef.listenerCount('disconnect'), 0);
  assert.equal(h.proc.listenerCount('message'), 0);
  assert.equal(h.proc.listenerCount('error'), 0);
  assert.equal(h.proc.listenerCount('exit'), 0);
});

test('单飞订阅者也最多 100；较短订阅 deadline 不取消其他 live 读', async () => {
  const h = createRpcHarness();
  try {
    const live = h.run({}, 'getBag');
    const short = h.run({ deadline: Date.now() + 100 }, 'getBag');
    const key = [...h.timers.keys()].find(value => String(value).endsWith('_1_2'));
    h.fire(key);
    await assert.rejects(short, { errorCode: 'DEADLINE' });
    assert.equal(h.cancels().length, 0);
    const rest = Array.from({ length: 99 }, () => h.run({}, 'getBag'));
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'QUEUE_FULL' });
    assert.equal(h.calls().length, 1);
    assert.equal(h.manager.getDiagnostics('account-1').subscribers, 100);
    h.reply(h.calls()[0].id, {});
    await Promise.all([live, ...rest]);
    assert.equal(h.manager.getDiagnostics('account-1').subscribers, 0);
  } finally { h.manager.shutdown(); }
});

test('迟到写记录最多 50 条，worker exit 清除 pending 与信号监听', async () => {
  const h = createRpcHarness();
  try {
    for (let i = 0; i < 55; i++) {
      const controller = new AbortController();
      const promise = h.run({ signal: controller.signal }, 'useItem', { privateToken: '禁止保留参数' });
      controller.abort();
      await assert.rejects(promise, { outcomeUnknown: true });
      h.reply(h.calls().at(-1).id, { privateToken: '禁止保留回包' });
    }
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.length, 50);
    assert.ok(!JSON.stringify(h.logs).includes('privateToken'));
    const promise = h.run({}, 'getBag');
    const rejected = assert.rejects(promise, { errorCode: 'WORKER_EXITED' });
    h.proc.emit('exit', 0);
    await rejected;
    assert.equal(h.proc.listenerCount('message'), 0);
    assert.equal(h.proc.listenerCount('error'), 0);
    assert.equal(h.proc.listenerCount('exit'), 0);
    assert.equal([...h.timers.keys()].filter(key => String(key).startsWith('api_')).length, 0);
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'WORKER_NOT_RUNNING' });
  } finally { h.manager.shutdown(); }
});

function createAdminHarness() {
  const h = createVmHarness();
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/admin.js'), 'utf8');
  const extra = {};
  for (const match of source.matchAll(/require\("([^"]+)"\)/g)) extra[match[1]] = {};
  extra['../services/logger'] = { createModuleLogger: () => ({ warn() {}, info() {} }) };
  const admin = h.load('../src/controllers/admin.js', extra,
    '\nmodule.exports = { registerRequestTimeoutGuard, configureHttpServerTimeouts, trackHttpConnections, registerTransportDiagnosticsRoute, setProvider(value) { provider = value; } };');
  return { ...h, admin, source };
}

function fakeResponse() {
  return Object.assign(new EventEmitter(), {
    locals: {}, statusCode: 200, writableEnded: false, writableFinished: false, headersSent: false, destroyed: false,
    headers: {}, status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; this.writableEnded = true; this.writableFinished = true; this.emit('finish'); return this; },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
}

test('HTTP 请求上下文 120s 有界，finish 不取消，close/aborted/timeout 才取消且清理监听', () => {
  const h = createAdminHarness();
  let middleware;
  h.admin.registerRequestTimeoutGuard({ use(fn) { middleware = fn; } });
  for (const event of ['finish', 'close', 'aborted', 'timeout']) {
    const req = Object.assign(new EventEmitter(), { path: '/api/bag' });
    const res = fakeResponse();
    let ctx;
    middleware(req, res, () => { ctx = h.transportUtil.getRequestContext(); });
    assert.equal(ctx.priority, 'foreground');
    assert.ok(ctx.deadline <= Date.now() + 120000);
    const timer = [...h.timers.entries()].find(([, value]) => value.ms === 120000);
    assert.ok(timer);
    if (event === 'timeout') { ctx.rpcOutcome.pendingWrites = 1; h.fire(timer[0]); }
    else if (event === 'aborted') req.emit(event);
    else { if (event === 'finish') res.writableFinished = true; res.emit(event); }
    assert.equal(ctx.signal.aborted, event !== 'finish');
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(h.timers.size, 0);
    if (event === 'timeout') {
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.errorCode, 'DEADLINE');
      assert.equal(res.body.sent, true);
      assert.equal(res.body.outcomeUnknown, true);
    }
  }
  const streamingReq = Object.assign(new EventEmitter(), { path: '/api/bag' });
  const streamingRes = fakeResponse();
  let streamingContext;
  middleware(streamingReq, streamingRes, () => { streamingContext = h.transportUtil.getRequestContext(); });
  streamingRes.headersSent = true;
  h.fire([...h.timers.keys()][0]);
  assert.equal(streamingContext.signal.aborted, true);
  assert.equal(streamingRes.destroyed, true);
  assert.equal(streamingRes.body, undefined);
  for (const requestPath of ['/api/health', '/asset.js', '/game-config/a', '/apix']) {
    const req = Object.assign(new EventEmitter(), { path: requestPath });
    middleware(req, fakeResponse(), () => assert.equal(h.transportUtil.getRequestContext().signal, undefined));
    assert.equal(h.timers.size, 0);
  }
});

test('HTTP socket idle 超过 120s，不再 30s 重置；非 API 和健康路径不加请求计时器', () => {
  const h = createAdminHarness();
  const server = Object.assign(new EventEmitter(), { setTimeout(ms, fn) { this.idleMs = ms; this.onIdle = fn; } });
  h.admin.configureHttpServerTimeouts(server);
  assert.equal(server.requestTimeout, 120000);
  assert.ok(server.timeout >= server.requestTimeout);
  assert.equal(server.headersTimeout, 16000);
  assert.equal(server.keepAliveTimeout, 5000);
  h.admin.trackHttpConnections(server);
  const socket = Object.assign(new EventEmitter(), {
    setNoDelay() {}, setKeepAlive() {}, setTimeout(ms) { this.idleMs = ms; }, destroy() { this.destroyed = true; },
  });
  server.emit('connection', socket);
  assert.ok(socket.idleMs >= 120000);
  assert.equal(socket.destroyed, undefined);
  server.emit('close');
  assert.equal(h.timers.size, 0);
});

test('worker transport诊断分离IPC代际与真实网关代际，保留来源且不推进访友状态', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
  const match = workerSource.match(/function getTransportDiagnostics\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, '必须执行实际诊断函数，而不是另写数据模型');
  const native = { connectionEpoch: 2, remoteGeneration: 26, remoteGenerationSource: 'gateway',
    connected: true, loggedIn: true, detached: false, pending: 0, pendingWrites: 0,
    token: 'SENSITIVE_TOKEN', code: 'SENSITIVE_CODE', body: 'SENSITIVE_BODY' };
  let reads = 0;
  const diagnostic = vm.runInNewContext(`(${match[0]})`, {
    getDiagnosticSnapshot: () => native,
    getUserState: () => ({ gid: 10010 }),
    gatewayHealthBackoffUntil: 0,
    gatewayHealthSnapshot: { connectionEpoch: 26 },
    apiControls: new Map(), MAX_API_CONTROLS: 100,
    getFriendVisitSessionSnapshot: options => {
      assert.equal(options.observeTransport, false); reads++;
      return { resultState: 'unknown', transportEpoch: 26 };
    },
  });
  const result = diagnostic();
  assert.equal(result.connectionEpoch, 2); assert.equal(result.sessionEpoch, 2);
  assert.equal(result.remoteGeneration, 26); assert.equal(result.remoteGenerationSource, 'gateway');
  assert.equal(result.loggedIn, true); assert.equal(result.friendVisit.resultState, 'unknown');
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_|"token"|"code"|"body"/);
  for (const value of [undefined, null, NaN, Infinity, -1, true, {}, 'bad', '26x', '9007199254740993']) {
    native.remoteGeneration = value;
    assert.equal(diagnostic().remoteGeneration, null, String(value));
  }
  native.remoteGeneration = '26'; native.remoteGenerationSource = 'process';
  assert.equal(diagnostic().remoteGeneration, 26);
  assert.equal(diagnostic().remoteGenerationSource, 'process', '进程来源不能被伪标成gateway');
  native.remoteGenerationSource = 'SENSITIVE_SOURCE';
  const unknown = diagnostic();
  assert.equal(unknown.remoteGenerationSource, 'unknown');
  assert.doesNotMatch(JSON.stringify(unknown), /SENSITIVE_/);
});

test('transport 诊断路由必须显式认证及账号授权，provider 不增加第二层单飞', async () => {
  const h = createAdminHarness();
  let calls = 0;
  const provider = createDataProvider({
    workers: {}, globalLogs: [], accountLogs: [], store: {},
    getAccounts: () => ({ accounts: [{ id: 'account-1' }] }),
    callWorkerApi: async (id, method) => {
      assert.equal(id, 'account-1'); assert.equal(method, 'getTransportDiagnostics'); calls += 1; return { queueSize: 2 };
    },
  });
  h.admin.setProvider(provider);
  let handlers;
  const auth = () => {};
  h.admin.registerTransportDiagnosticsRoute({ get(route, ...fns) {
    assert.deepEqual(Array.from(route), ['/api/runtime/transport', '/api/runtime/transport/manager']); handlers = fns;
  } }, {
    requireAdminToken: auth, getAccountIdFromRequest: req => req.accountId,
    canAccessAccount: req => req.allowed, sendProviderError: () => assert.fail('不应报错'),
  });
  assert.equal(handlers[0], auth);
  const missing = fakeResponse(); await handlers[1]({}, missing); assert.equal(missing.statusCode, 400);
  const denied = fakeResponse(); await handlers[1]({ accountId: 'account-1' }, denied); assert.equal(denied.statusCode, 403);
  assert.equal(calls, 0);
  const allowed = fakeResponse(); await handlers[1]({ accountId: 'account-1', allowed: true }, allowed);
  assert.equal(allowed.body.data.worker.queueSize, 2);
  assert.equal(allowed.body.data.manager, null);
  const closed = fakeResponse(); closed.locals.requestClosed = true;
  await handlers[1]({ accountId: 'account-1', allowed: true }, closed);
  assert.equal(closed.body, undefined);
  await provider.getTransportDiagnostics('account-1');
  assert.equal(calls, 3);
});

test('安全读固定 65s/复合 90s 预算，短订阅不缩短共享 deadline，写仍默认 10s', async () => {
  const h = createRpcHarness();
  try {
    for (const method of ['getBag', 'getSeeds', 'getLands', 'getBagSeeds', 'getPetOverview']) {
      const before = Date.now();
      const short = h.run({}, method, { _timeoutMs: 20000 });
      const call = h.calls().at(-1);
      const budget = ['getLands', 'getBagSeeds', 'getPetOverview'].includes(method) ? 90000 : 65000;
      assert.ok(call.deadline >= before + budget);
      assert.ok(call.deadline <= Date.now() + budget);
      const live = h.run({}, method);
      const shortTimer = [...h.timers.entries()].find(([key, value]) =>
        String(key).startsWith(`api_subscriber_account-1_${call.id}_`) && value.ms <= 20000);
      h.fire(shortTimer[0]);
      await assert.rejects(short, { errorCode: 'DEADLINE' });
      assert.equal(h.cancels().length, 0);
      h.reply(call.id, {});
      await live;
    }
    const write = h.run({}, 'useItem');
    const writeCall = h.calls().at(-1);
    assert.ok(writeCall.deadline <= Date.now() + 10000);
    h.fire(`api_timeout_account-1_${writeCall.id}`);
    await assert.rejects(write, { sent: true, resultState: 'unknown', outcomeUnknown: true });
    assert.equal(h.cancels().length, 0);
    h.reply(writeCall.id, {});
  } finally { h.manager.shutdown(); }
});

test('首次 HTTP 短 deadline 不缩短共享读，20s 取消仅最后订阅者发 api_cancel', async () => {
  const h = createRpcHarness();
  try {
    const controller = new AbortController();
    const first = h.run({ signal: controller.signal, deadline: Date.now() + 20000 }, 'getLands');
    const call = h.calls()[0];
    assert.ok(call.deadline >= Date.now() + 89000);
    const second = h.run({ deadline: Date.now() + 120000 }, 'getLands');
    controller.abort();
    await assert.rejects(first, { errorCode: 'CANCELLED' });
    assert.equal(h.calls().length, 1);
    assert.equal(h.cancels().length, 0);
    h.reply(call.id, {});
    await second;
  } finally { h.manager.shutdown(); }
});

test('严格白名单拒绝 bodyargs/非 false force，皮肤读不合并且不取消', async () => {
  const h = createRpcHarness();
  try {
    const promises = [];
    for (const [method, args] of [
      ['getBag', [null]], ['getLands', [{}]], ['getFriends', [0]],
      ['getFriends', ['false']], ['getFriends', [false, {}]], ['getSkinOverview', []],
    ]) {
      promises.push(h.run({}, method, ...args));
      assert.equal(h.calls().at(-1).readOnly, false);
    }
    const controller = new AbortController();
    const skin = h.run({ signal: controller.signal }, 'getSkins');
    const otherSkin = h.run({}, 'getSkins');
    assert.equal(h.calls().at(-1).readOnly, false);
    controller.abort();
    await assert.rejects(skin, { sent: true, outcomeUnknown: true });
    assert.equal(h.cancels().length, 0);
    const ordinary = h.run({}, 'getFriends', false, undefined);
    const ordinaryCall = h.calls().at(-1);
    assert.equal(ordinaryCall.readOnly, true);
    assert.deepEqual(JSON.parse(JSON.stringify(ordinaryCall.args)), [false]);
    for (const call of h.calls()) h.reply(call.id, {});
    await Promise.all([...promises, otherSkin, ordinary]);
  } finally { h.manager.shutdown(); }
});

test('transport.direct.connectionEpoch 改变隔离共享读，不依赖 sessionEpoch 存在', async () => {
  const h = createRpcHarness();
  try {
    h.workers['account-1'].status = { stats: { gatewayTransport: { direct: { connectionEpoch: 1 } } } };
    const first = h.run({}, 'getBag');
    h.workers['account-1'].status.stats.gatewayTransport.direct.connectionEpoch = 2;
    const second = h.run({}, 'getBag');
    assert.equal(h.calls().length, 2);
    assert.equal(h.cancels().length, 0);
    for (const call of h.calls()) h.reply(call.id, {});
    await Promise.all([first, second]);
  } finally { h.manager.shutdown(); }
});

test('诊断真实 RPC 引用提供 manager 状态，迟到记录 clone 且不修改账号统计', async () => {
  const h = createRpcHarness();
  try {
    const provider = createDataProvider({
      workers: h.workers, globalLogs: [], accountLogs: [], store: {},
      getAccounts: () => ({ accounts: [{ id: 'account-1' }] }), callWorkerApi: h.manager.callWorkerApi,
    });
    const controller = new AbortController();
    const write = h.run({ signal: controller.signal }, 'useItem', 1);
    controller.abort();
    await assert.rejects(write, { outcomeUnknown: true });
    const combined = provider.getTransportDiagnostics('account-1');
    h.reply(h.calls().at(-1).id, { pending: 3, sessionEpoch: 1 });
    const result = await combined;
    assert.equal(result.worker.pending, 3);
    assert.equal(result.manager.pending, 1);
    assert.equal(result.manager.lateResults[0].resultState, 'unknown');
    result.manager.lateResults[0].resultState = '污染';
    assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'unknown');
    assert.equal(provider.getRunningAccountCount(), 1);
    h.reply(h.calls()[0].id, {});
    const uncertain = h.run({}, 'useItem', 2);
    h.reply(h.calls().at(-1).id, null, '传输结果未知', {
      errorCode: 'TIMEOUT', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    await assert.rejects(uncertain, { outcomeUnknown: true });
    assert.equal(h.manager.getDiagnostics('account-1').lateResults.at(-1).resultState, 'unknown');
  } finally { h.manager.shutdown(); }
});

test('取消无终态 producer 最多 100 个，继续请求不会无限发起', async () => {
  const h = createRpcHarness();
  try {
    for (let i = 0; i < 100; i++) {
      h.workers['account-1'].sessionEpoch = i;
      const controller = new AbortController();
      const promise = h.run({ signal: controller.signal }, 'getBag');
      controller.abort();
      await assert.rejects(promise, { errorCode: 'CANCELLED' });
    }
    assert.equal(h.manager.getDiagnostics('account-1').pending, 100);
    assert.equal(h.manager.getDiagnostics('account-1').subscribers, 0);
    h.workers['account-1'].sessionEpoch = 101;
    await assert.rejects(h.run({}, 'getBag'), { errorCode: 'QUEUE_FULL', sent: false });
    assert.equal(h.calls().length, 100);
    assert.equal(h.cancels().length, 100);
  } finally { h.manager.shutdown(); }
});

test('runtime shutdown 在 stopAllAccounts 前调用 manager hook，兼容旧 mock 并保留会话语义', () => {
  for (const hasShutdown of [true, false]) {
    const h = createVmHarness();
    const calls = [];
    const fakeProcess = Object.assign(new EventEmitter(), {
      env: { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_EXTERNAL: '1' }, exit() { assert.fail('不执行真实退出'); },
    });
    const workers = { 'account-1': {}, 'account-2': {} };
    const fakeManager = {
      startWorker() {}, restartWorker() {}, callWorkerApi() {},
      stopWorker(id, options) { calls.push({ type: 'stop', id, preserveSession: options.preserveSession }); },
    };
    if (hasShutdown) fakeManager.shutdown = () => calls.push({ type: 'shutdown' });
    const { createRuntimeEngine } = h.load('../src/runtime/runtime-engine.js', {
      'node:child_process': { fork() { assert.fail('禁止创建真实进程'); } },
      'node:path': { join: (...parts) => parts.join('/') }, 'node:fs': {},
      '../config/runtime-paths': {}, 'node:process': fakeProcess, 'node:worker_threads': {},
      '../models/store': { getAccounts: () => ({ accounts: [] }) }, '../config/config': {}, '../services/push': {}, '../services/qrlogin': {},
      './auto-code-refresh': { createAutoCodeRefreshService: () => ({}) },
      './data-provider': { createDataProvider: () => ({}) },
      './relogin-reminder': { createReloginReminderService: () => ({}) },
      './runtime-state': { createRuntimeState: () => ({ workers, runtimeEvents: new EventEmitter() }) },
      './worker-manager': { createWorkerManager: () => fakeManager },
    });
    createRuntimeEngine({ processRef: fakeProcess, mainEntryPath: 'fake-main', workerScriptPath: 'fake-worker' });
    fakeProcess.emit('SIGTERM');
    assert.deepEqual(calls.map(item => item.type), hasShutdown ? ['shutdown', 'stop', 'stop'] : ['stop', 'stop']);
    assert.ok(calls.filter(item => item.type === 'stop').every(item => item.preserveSession === true));
    assert.deepEqual(Object.keys(workers), ['account-1', 'account-2']);
    const count = calls.length;
    fakeProcess.emit('SIGINT');
    assert.equal(calls.length, count);
  }
});

function connectRealEngine(h) {
  const exits = [];
  h.processRef.env = { FARM_NETWORK_MODE: 'gateway', FARM_GATEWAY_EXTERNAL: '1' };
  h.processRef.exit = code => exits.push(code);
  const { createRuntimeEngine } = h.load('../src/runtime/runtime-engine.js', {
    'node:child_process': { fork() { assert.fail('禁止创建真实进程'); } },
    'node:path': { join: (...parts) => parts.join('/') }, 'node:fs': {},
    '../config/runtime-paths': {}, 'node:process': h.processRef, 'node:worker_threads': {},
    '../models/store': { getAccounts: () => ({ accounts: [{ id: 'account-1' }] }) },
    '../config/config': {}, '../services/push': {}, '../services/qrlogin': {},
    './auto-code-refresh': { createAutoCodeRefreshService: () => ({}) },
    './data-provider': { createDataProvider },
    './relogin-reminder': { createReloginReminderService: () => ({}) },
    './runtime-state': { createRuntimeState: () => ({ workers: h.workers, globalLogs: [], accountLogs: [], runtimeEvents: new EventEmitter() }) },
    './worker-manager': { createWorkerManager: () => h.manager },
  });
  const engine = createRuntimeEngine({ processRef: h.processRef, mainEntryPath: 'fake-main', workerScriptPath: 'fake-worker' });
  return { engine, exits };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('真实 engine+manager 两阶段关闭保留75s写回包，quiesce拒绝新RPC且无1.2s截断', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { engine, exits } = connectRealEngine(h);
  const write = h.run({}, 'useItem', { secret: '禁止存储' });
  const rejected = assert.rejects(write, { errorCode: 'DEADLINE', sent: true, outcomeUnknown: true });
  h.processRef.emit('SIGTERM');
  assert.equal(h.proc.messages.filter(item => item.type === 'stop').length, 1);
  assert.equal(h.proc.messages.find(item => item.type === 'stop').preserveSession, true);
  assert.equal(h.timers.get('force_kill_account-1').ms, 160000);
  assert.equal(h.proc.listenerCount('message'), 1);
  await assert.rejects(h.run({}, 'getBag'), { errorCode: 'WORKER_NOT_RUNNING', sent: false });
  h.advance(75000);
  await rejected;
  await flushMicrotasks();
  assert.deepEqual(exits, []);
  assert.equal(h.proc.killed, 0);
  assert.equal(h.manager.getDiagnostics('account-1').writeCount, 1);
  h.reply(h.calls()[0].id, { secret: '禁止存储回包' });
  assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'completed');
  assert.equal(h.proc.listenerCount('message'), 1);
  h.proc.emit('exit', 0);
  await flushMicrotasks();
  assert.deepEqual(exits, [0]);
  assert.equal(h.proc.killed, 0);
  assert.equal(h.proc.listenerCount('message'), 0);
  assert.equal(h.proc.listenerCount('exit'), 0);
  assert.equal(h.timers.size, 0);
  const retired = engine.dataProvider.getManagerDiagnostics('account-1');
  assert.equal(retired.lateResults[0].resultState, 'completed');
  assert.ok(!JSON.stringify(retired).includes('secret'));
  assert.ok(!JSON.stringify(h.logs).includes('secret'));
});

test('真实 engine+manager 160s强杀保留unknown而非成功，并在排空后才退出', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { engine, exits } = connectRealEngine(h);
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { sent: true, outcomeUnknown: true });
  h.processRef.emit('SIGINT');
  h.advance(159999);
  await rejected;
  await flushMicrotasks();
  assert.equal(h.proc.killed, 0);
  assert.deepEqual(exits, []);
  assert.equal(h.proc.listenerCount('message'), 1);
  assert.equal(h.manager.getDiagnostics('account-1').writeCount, 1);
  h.advance(1);
  await flushMicrotasks();
    assert.equal(h.proc.killed, 1);
    assert.deepEqual(exits, [1]);
  assert.equal(h.proc.listenerCount('message'), 0);
  assert.equal(h.proc.listenerCount('error'), 0);
  assert.equal(h.timers.size, 0);
  const record = engine.dataProvider.getManagerDiagnostics('account-1').lateResults[0];
  assert.equal(record.resultState, 'unknown');
  assert.equal(record.outcomeUnknown, true);
  assert.equal(record.sent, true);
  assert.equal(record.errorCode, 'WORKER_EXITED');
});

test('真实 engine+manager 无写以实际worker exit快速停止，重复信号和drain不重复stop', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { exits } = connectRealEngine(h);
  h.processRef.emit('SIGTERM');
  const drain = h.manager.shutdown({ drain: true, preserveSession: true });
  h.processRef.emit('SIGINT');
  assert.equal(h.proc.messages.filter(item => item.type === 'stop').length, 1);
  assert.equal(h.timers.get('force_kill_account-1').ms, 160000);
  h.advance(10);
  await flushMicrotasks();
  assert.deepEqual(exits, []);
  h.proc.emit('exit', 0);
  await drain;
  await flushMicrotasks();
  assert.deepEqual(exits, [0]);
  assert.equal(h.timers.size, 0);
});

test('普通用户stop最后RPC写结算仍等待raw写退出且不保留游戏会话', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { outcomeUnknown: true });
  const stopped = h.manager.stopWorker('account-1');
  assert.equal(h.proc.messages.find(item => item.type === 'stop').preserveSession, false);
  h.advance(75000);
  await rejected;
  assert.equal(h.proc.killed, 0);
  h.reply(h.calls()[0].id, {});
  h.advance(1000);
  assert.equal(h.proc.killed, 0);
  h.proc.emit('exit', 0);
  await stopped;
  assert.equal(h.proc.killed, 0);
  assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'completed');
  h.manager.emergencyCleanup();
});

test('restart写排空保护不被1500msfallback绕过', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { outcomeUnknown: true });
  h.manager.restartWorker({ id: 'account-1', name: '测试账号' });
  assert.equal(h.timers.has('restart_fallback_account-1'), false);
  assert.equal(h.timers.get('force_kill_account-1').ms, 160000);
  h.advance(75000);
  await rejected;
  assert.equal(h.proc.killed, 0);
  assert.equal(h.proc.listenerCount('message'), 1);
  h.reply(h.calls()[0].id, {});
  h.manager.emergencyCleanup();
});

test('manager诊断独立路由不发worker RPC，停机后未知记录仍可授权查询', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const provider = createDataProvider({ workers: h.workers, store: {}, getAccounts: () => ({ accounts: [{ id: 'account-1' }] }), callWorkerApi: h.manager.callWorkerApi });
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { outcomeUnknown: true });
  const stopped = h.manager.stopWorker('account-1');
  h.advance(160000);
  await rejected;
  await stopped;
  const adminHarness = createAdminHarness();
  adminHarness.admin.setProvider(provider);
  let handler;
  adminHarness.admin.registerTransportDiagnosticsRoute({ get(paths, auth, fn) { handler = fn; } }, {
    requireAdminToken() {}, getAccountIdFromRequest: () => 'account-1', canAccessAccount: () => true,
    sendProviderError: () => assert.fail('本地诊断不应报worker未运行'),
  });
  const response = fakeResponse();
  const before = h.calls().length;
  await handler({ path: '/api/runtime/transport/manager' }, response);
  assert.equal(h.calls().length, before);
  assert.equal(response.body.data.lateResults[0].resultState, 'unknown');
  response.body.data.lateResults.length = 0;
  assert.equal(provider.getManagerDiagnostics('account-1').lateResults.length, 1);
  h.manager.emergencyCleanup();
});

test('停机时安全读api_cancel发送失败不清除待结算写', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { outcomeUnknown: true });
  const read = h.run({}, 'getBag');
  const readRejected = assert.rejects(read, { errorCode: 'DEADLINE' });
  const send = h.proc.send;
  h.proc.send = (message, callback) => {
    if (message.type === 'api_cancel') {
      h.proc.messages.push(message);
      callback(new Error('取消发送失败'));
    } else send(message, callback);
  };
  const drain = h.manager.shutdown({ drain: true, preserveSession: true });
  assert.equal(h.manager.getDiagnostics('account-1').writeCount, 1);
  assert.equal(h.proc.listenerCount('message'), 1);
  h.proc.emit('error', new Error('停机期间 IPC 错误'));
  assert.equal(h.manager.getDiagnostics('account-1').writeCount, 1);
  h.advance(75000);
  await Promise.all([rejected, readRejected]);
  assert.equal(h.proc.killed, 0);
  h.reply(h.calls()[0].id, {});
  assert.equal(h.manager.getDiagnostics('account-1').lateResults[0].resultState, 'completed');
  h.proc.emit('exit', 0);
  await drain;
  assert.equal(h.proc.killed, 0);
  assert.equal(h.timers.size, 0);
});

test('进程exit兜底只同步清理，不进入异步drain', async () => {
  const h = createRpcHarness();
  const write = h.run({}, 'useItem');
  const rejected = assert.rejects(write, { outcomeUnknown: true, errorCode: 'WORKER_EXITED' });
  h.processRef.emit('exit', 0);
  await rejected;
  assert.equal(h.proc.messages.filter(item => item.type === 'stop').length, 0);
  assert.equal(h.proc.listenerCount('message'), 0);
  assert.equal(h.timers.size, 0);
});

test('无API RPC的后台raw写ack70s退出，不在1s杀死且ack只保留计数元数据', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { exits } = connectRealEngine(h);
  h.workers['account-1'].status = { stats: { gatewayTransport: { pendingWrites: 0 } } };
  h.processRef.emit('SIGTERM');
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 1, maxDrainMs: 155000, token: '禁止传播' });
  assert.equal(h.calls().length, 0);
  assert.equal(h.manager.getDiagnostics('account-1').writeCount, 0);
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck.pendingWrites, 1);
  assert.equal(h.timers.get('force_kill_account-1').ms, 160000);
  h.advance(70000);
  await flushMicrotasks();
  assert.equal(h.proc.killed, 0);
  assert.deepEqual(exits, []);
  assert.equal(h.proc.listenerCount('message'), 1);
  h.proc.emit('exit', 0);
  await flushMicrotasks();
  assert.deepEqual(exits, [0]);
  const diagnostics = h.manager.getDiagnostics('account-1');
  assert.equal(diagnostics.stopOutcome.graceful, true);
  assert.ok(!JSON.stringify(diagnostics).includes('token'));
  assert.ok(!JSON.stringify(h.logs).includes('禁止传播'));
  assert.equal(h.timers.size, 0);
});

test('无ack后台写仍160s保护；重复restart等同一stopPromise且无1.5s回退', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const first = h.manager.restartWorker({ id: 'account-1', name: '测试账号' });
  const second = h.manager.restartWorker({ id: 'account-1', name: '测试账号' });
  assert.equal(first, second);
  assert.equal(h.proc.messages.filter(message => message.type === 'stop').length, 1);
  assert.equal(h.timers.has('restart_fallback_account-1'), false);
  h.advance(70000);
  assert.equal(h.proc.killed, 0);
  assert.equal(h.proc.messages.filter(message => message.type === 'start').length, 1);
  h.proc.emit('exit', 0);
  assert.equal(await first, true);
  assert.notEqual(h.workers['account-1'].process, h.proc);
  h.manager.emergencyCleanup();
});

test('后台raw排空超时但无RPC记录仍保留unknown诊断，engine非成功退出', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { exits } = connectRealEngine(h);
  h.processRef.emit('SIGTERM');
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 3, maxDrainMs: 155000 });
  h.advance(159999);
  await flushMicrotasks();
  assert.equal(h.proc.killed, 0);
  h.advance(1);
  await flushMicrotasks();
  assert.equal(h.proc.killed, 1);
  assert.deepEqual(exits, [1]);
  const diagnostics = h.manager.getDiagnostics('account-1');
  assert.equal(diagnostics.lateResults.length, 0);
  assert.equal(diagnostics.stopOutcome.resultState, 'unknown');
  assert.equal(diagnostics.stopOutcome.outcomeUnknown, true);
  assert.equal(diagnostics.stopOutcome.errorCode, 'WORKER_DRAIN_TIMEOUT');
  assert.equal(diagnostics.quiesceAck.pendingWrites, 3);
  assert.equal(h.timers.size, 0);
});

test('quiesce ack重复或非法字段不延长总上限，零pending快照不缩短等待', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const stopped = h.manager.stopWorker('account-1', { preserveSession: false });
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: '1', maxDrainMs: 155000 });
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck, null);
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 0, maxDrainMs: 999999999, secret: {} });
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck.maxDrainMs, 155000);
  h.advance(2000);
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 20, maxDrainMs: 155000 });
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck.pendingWrites, 0);
  assert.equal(h.proc.killed, 0);
  assert.equal(h.timers.get('force_kill_account-1').ms, 160000);
  h.proc.emit('exit', 0);
  await stopped;
  h.manager.emergencyCleanup();
});

test('engine.stopAllAccounts返回真正stopPromise集合，无write ack需要等实际exit', async () => {
  const h = createRpcHarness();
  h.freezeClock();
  const { engine } = connectRealEngine(h);
  const stopped = engine.stopAllAccounts({ preserveSession: false });
  let done = false;
  stopped.then(() => { done = true; });
  h.advance(1500);
  await flushMicrotasks();
  assert.equal(done, false);
  assert.equal(h.proc.killed, 0);
  h.proc.emit('exit', 0);
  const results = await stopped;
  assert.equal(results[0].graceful, true);
  assert.equal(results[0].accountId, 'account-1');
  h.manager.emergencyCleanup();
});

test('quiesce ack限定当前worker且不能改变安全读范围，旧进程消息不污染新worker', async () => {
  const h = createRpcHarness();
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 1, maxDrainMs: 155000 });
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck, null);
  const restarting = h.manager.restartWorker({ id: 'account-1', name: '测试账号' });
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 1, maxDrainMs: 155000, readOnly: false });
  h.proc.emit('exit', 0);
  await restarting;
  h.proc.emit('message', { type: 'worker_quiescing', pendingWrites: 99, maxDrainMs: 155000 });
  assert.equal(h.manager.getDiagnostics('account-1').quiesceAck, null);
  const current = h.workers['account-1'].process;
  const read = h.run({}, 'getBag');
  const call = current.messages.find(message => message.type === 'api_call');
  assert.equal(call.readOnly, true);
  current.emit('message', { type: 'api_response', id: call.id, result: {} });
  await read;
  h.manager.emergencyCleanup();
});

test('provider 错误映射使用代码，未知写不发重试提示，已关闭 HTTP 不输出', () => {
  const h = createVmHarness();
  const { createAdminRouteHelpers } = h.load('../src/controllers/admin-route-helpers.js');
  const { sendProviderError } = createAdminRouteHelpers({});
  for (const errorCode of ['HEALTH_BACKOFF', 'QUEUE_FULL', 'API_QUEUE_FULL', 'DEADLINE', 'TIMEOUT', 'REQUEST_TIMEOUT', 'REQUEST_DEADLINE', 'READ_FLIGHTS_FULL']) {
    const res = fakeResponse();
    sendProviderError(res, Object.assign(new Error('API Timeout'), { errorCode, retryAfterMs: 2100, sent: false }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Retry-After'], '3');
    assert.equal(res.body.error, 'API Timeout');
  }
  const unknown = fakeResponse();
  sendProviderError(unknown, Object.assign(new Error('API Timeout'), {
    errorCode: 'DEADLINE', sent: true, resultState: 'unknown', outcomeUnknown: true, retryAfterMs: 2000,
  }));
  assert.equal(unknown.body.outcomeUnknown, true);
  assert.equal(unknown.headers['Retry-After'], undefined);
  const cancel = fakeResponse();
  sendProviderError(cancel, Object.assign(new Error('取消'), { errorCode: 'CANCELLED' }));
  assert.equal(cancel.statusCode, 499);
  for (const property of ['headersSent', 'writableEnded', 'destroyed']) {
    const res = fakeResponse(); res[property] = true;
    sendProviderError(res, new Error('错误'));
    assert.equal(res.body, undefined);
  }
  for (const message of ['账号未运行', 'API Timeout']) {
    const res = fakeResponse(); sendProviderError(res, new Error(message)); assert.equal(res.statusCode, 200);
  }
  const coded = fakeResponse();
  sendProviderError(coded, Object.assign(new Error('API Timeout'), { errorCode: 'INVALID_RESPONSE' }));
  assert.equal(coded.statusCode, 500);
});
