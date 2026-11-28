const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 宿主 fs 仅在这里读取白名单源码，运行态所有文件操作均由内存 fs 承接。
const sources = {
    routing: fs.readFileSync(path.join(__dirname, '../src/runtime/gateway-routing.js'), 'utf8'),
    store: fs.readFileSync(path.join(__dirname, '../src/models/store.js'), 'utf8'),
    jsonDb: fs.readFileSync(path.join(__dirname, '../src/services/json-db.js'), 'utf8'),
    runtimePaths: fs.readFileSync(path.join(__dirname, '../src/config/runtime-paths.js'), 'utf8'),
};
const plain = value => JSON.parse(JSON.stringify(value));
const wxRecord = () => ({
    id: '2', platform: 'wx', name: '模拟微信', code: 'synthetic-code-only',
    loginType: 'manual', wxid: 'synthetic-wxid-only', username: 'simulation',
    avatar: 'synthetic-avatar-only', openId: 'synthetic-openid-only',
    createdAt: 100, updatedAt: 200, customConfig: { nested: ['preserved'] },
});
const rawRecords = () => ({
    accounts: [{ id: '1', platform: 'qq', name: '模拟QQ1' }, { id: '10', platform: 'qq', name: '模拟QQ10' }],
    nextId: 41,
});
const manifest = (phase = 'active') => ({
    version: 1, generation: 'simulation-generation', phase,
    accountIds: ['2'], socketPath: '/sock/qq-farm-wx.sock',
    credentialDirectory: 'wx-gateway', accounts: [wxRecord()],
    createdAt: '2026-11-05T00:00:00.000Z', drainStartedAt: 100,
    deploymentMetadata: { marker: 'preserved' },
});

function storeFunction(name) {
    const match = sources.store.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
    assert.ok(match, `找不到 store 函数 ${name}`);
    return match[0];
}

function createHarness({ delegation = manifest(), raw = rawRecords() } = {}) {
    const root = path.resolve(__dirname, '__gateway_routing_memory_only__');
    const files = new Map();
    const directories = new Set();
    const commits = [];
    const reads = [];
    const readErrors = new Map();
    const writeErrors = new Map();
    function key(file) {
        const resolved = path.resolve(file);
        assert.ok(resolved === root || resolved.startsWith(`${root}${path.sep}`), '内存 fs 禁止访问模拟目录之外');
        return resolved;
    }
    function fileError(code) {
        return Object.assign(new Error('模拟文件错误'), { code });
    }
    const fakeFs = {
        existsSync(file) {
            const resolved = key(file);
            return files.has(resolved) || directories.has(resolved);
        },
        mkdirSync(file) { directories.add(key(file)); },
        readFileSync(file) {
            const resolved = key(file);
            reads.push(resolved);
            if (readErrors.has(resolved)) throw fileError(readErrors.get(resolved));
            if (!files.has(resolved)) throw fileError('ENOENT');
            return files.get(resolved);
        },
        writeFileSync(file, text) { files.set(key(file), String(text)); },
        renameSync(from, to) {
            const source = key(from);
            const target = key(to);
            if (writeErrors.has(target)) throw fileError(writeErrors.get(target));
            if (!files.has(source)) throw fileError('ENOENT');
            files.set(target, files.get(source));
            files.delete(source);
            commits.push(target);
        },
        unlinkSync(file) { files.delete(key(file)); },
    };
    const simulatedProcess = { env: { FARM_DATA_DIR: root }, pid: 12345 };
    const noLogs = new Proxy({}, { get() { return () => { throw new Error('模拟运行禁止输出日志'); }; } });
    function loadModule(source, filename, dependencies) {
        const module = { exports: {} };
        vm.runInNewContext(source, {
            module, exports: module.exports, __dirname: path.dirname(filename), console: noLogs,
            require(id) {
                if (Object.hasOwn(dependencies, id)) return dependencies[id];
                throw new Error(`模拟运行禁止加载依赖 ${id}`);
            },
        }, { filename });
        return module.exports;
    }
    const runtimePaths = loadModule(sources.runtimePaths, path.join(root, 'runtime-paths.js'), {
        'node:fs': fakeFs, 'node:path': path, 'node:process': simulatedProcess,
    });
    const jsonDb = loadModule(sources.jsonDb, path.join(root, 'json-db.js'), {
        'node:fs': fakeFs, 'node:path': path, 'node:process': simulatedProcess,
    });
    const routing = loadModule(sources.routing, path.join(root, 'gateway-routing.js'), {
        'node:fs': fakeFs, 'node:path': path, 'node:crypto': require('node:crypto'), '../config/runtime-paths': runtimePaths,
        '../services/json-db': jsonDb,
    });
    const names = ['loadAccounts', 'saveAccounts', 'normalizeAccountsData', 'getAccounts', 'addOrUpdateAccount', 'deleteAccount'];
    const storeSource = `${names.map(storeFunction).join('\n')}\nmodule.exports = { ${names.join(', ')} };`;
    const module = { exports: {} };
    vm.runInNewContext(storeSource, {
        module, console: noLogs, ACCOUNTS_FILE: runtimePaths.getDataFile('accounts.json'),
        ...runtimePaths, ...jsonDb,
        globalConfig: { userDefaultAccountPlans: {} },
        ensureAccountConfig() {}, setAccountConfigSnapshot() {}, removeAccountConfig() {}, deleteAccountCaches() {},
        require(id) {
            assert.equal(id, '../runtime/gateway-routing');
            return routing;
        },
    }, { filename: 'store-account-functions.js' });
    const dataPath = filename => runtimePaths.getDataFile(filename);
    const put = (filename, value) => files.set(dataPath(filename), JSON.stringify(value));
    if (raw !== null) put('accounts.json', raw);
    if (delegation !== null) put('gateway-delegation.json', delegation);
    return {
        routing, store: module.exports, commits, reads, files, put, dataPath, readErrors, writeErrors,
        get: filename => JSON.parse(files.get(dataPath(filename))),
    };
}

for (const phase of ['active', 'draining']) {
    test(`${phase}：面板保留完整 id2，raw 只含 QQ1/10`, () => {
        const h = createHarness({ delegation: manifest(phase) });
        const data = plain(h.store.getAccounts());
        assert.deepEqual(data.accounts.map(account => account.id), ['1', '10', '2']);
        assert.deepEqual(data.accounts.find(account => account.id === '2'), wxRecord());
        assert.deepEqual(h.get('accounts.json'), rawRecords());
        assert.equal(data.nextId, 41);
        assert.equal(h.commits.length, 0);
    });

    test(`${phase}：昵称和 Code 仅保存到 delegate，metadata 与高水位保持`, () => {
        const initial = manifest(phase);
        const h = createHarness({ delegation: initial });
        h.store.addOrUpdateAccount({ id: '2', name: '模拟新昵称', code: 'synthetic-updated-code-only' });
        assert.deepEqual(h.get('accounts.json'), rawRecords());
        const saved = h.get('gateway-delegation.json');
        assert.equal(saved.accounts[0].name, '模拟新昵称');
        assert.equal(saved.accounts[0].code, 'synthetic-updated-code-only');
        assert.deepEqual(saved.accounts[0].customConfig, wxRecord().customConfig);
        assert.deepEqual({ ...saved, accounts: initial.accounts }, initial);
        assert.deepEqual(h.commits, [h.dataPath('gateway-delegation.json'), h.dataPath('accounts.json')]);
        assert.equal(h.store.getAccounts().accounts.find(account => account.id === '2').code, 'synthetic-updated-code-only');
    });

    test(`${phase}：显式删除 id2 写 disabled，重复读取和保存不复活`, () => {
        const initial = manifest(phase);
        const h = createHarness({ delegation: initial });
        h.store.deleteAccount('2');
        const deleted = h.get('gateway-delegation.json');
        assert.deepEqual(deleted, { ...initial, phase: 'disabled', accountIds: [], accounts: [] });
        assert.deepEqual(h.get('accounts.json'), rawRecords());
        assert.deepEqual(plain(h.routing.resolveAccountGatewaySocket('2', {})), { blocked: true, delegated: true });
        for (let attempt = 0; attempt < 3; attempt++) {
            const data = h.store.getAccounts();
            assert.deepEqual(Array.from(data.accounts, account => account.id), ['1', '10']);
            h.store.saveAccounts(data);
            assert.deepEqual(h.get('gateway-delegation.json'), deleted);
        }
        assert.ok(h.files.has(h.dataPath('gateway-delegation.json')));
    });
}

test('主进程同步交接保留QQ记录，昵称保存不把id2插回raw', () => {
    const wx = wxRecord();
    const raw = { accounts: [...rawRecords().accounts, wx], nextId: 41 };
    const h = createHarness({ raw, delegation: null });
    const hash = require('node:crypto').createHash('sha256').update(h.files.get(h.dataPath('accounts.json'))).digest('hex');
    const result = h.routing.prepareGatewayDelegation('ab1234567890', hash);
    assert.equal(result.phase, 'draining');
    assert.deepEqual(h.get('accounts.json'), rawRecords());
    h.store.addOrUpdateAccount({ id: '1', name: 'QQ改名' });
    assert.equal(h.store.getAccounts().accounts.find(a => a.id === '2').wxid, wx.wxid);
    assert.ok(!h.get('accounts.json').accounts.some(a => a.id === '2'));
    assert.throws(() => h.routing.prepareGatewayDelegation('ab1234567890', hash));
});

test('active：只有 id2 选择微信 socket，QQ 原 TCP/默认环境不变', () => {
    const h = createHarness();
    const env = Object.freeze({ FARM_GATEWAY_SOCK: 'tcp://127.0.0.1:19090', KEEP: 'unchanged' });
    assert.deepEqual(plain(h.routing.resolveAccountGatewaySocket(2, env)), {
        socketPath: '/sock/qq-farm-wx.sock', blocked: false, delegated: true,
    });
    for (const id of ['1', '10']) {
        assert.deepEqual(plain(h.routing.resolveAccountGatewaySocket(id, env)), {
            socketPath: env.FARM_GATEWAY_SOCK, blocked: false, delegated: false,
        });
        assert.equal(h.routing.resolveAccountGatewaySocket(id, {}).socketPath, undefined);
        assert.equal(h.routing.resolveAccountGatewaySocket(id, { FARM_GATEWAY_SOCK: '/sock/qq-farm-gateway.sock' }).socketPath,
            '/sock/qq-farm-gateway.sock');
    }
    assert.equal(env.KEEP, 'unchanged');
});

test('draining：id2 禁止旧/新启动，QQ 保留 TCP 路由', () => {
    const h = createHarness({ delegation: manifest('draining') });
    const env = { FARM_GATEWAY_SOCK: 'tcp://127.0.0.1:19090' };
    assert.deepEqual(plain(h.routing.resolveAccountGatewaySocket('2', env)), { blocked: true, delegated: true });
    assert.equal(h.routing.resolveAccountGatewaySocket('1', env).socketPath, env.FARM_GATEWAY_SOCK);
    assert.equal(h.routing.resolveAccountGatewaySocket('10', env).blocked, false);
});

test('helper 每次重读 manifest，不缓存 active/draining/disabled 或不存在状态', () => {
    const h = createHarness({ delegation: null });
    assert.equal(h.routing.readGatewayDelegation(), null);
    h.put('gateway-delegation.json', manifest('draining'));
    assert.equal(h.routing.resolveAccountGatewaySocket('2', {}).blocked, true);
    h.put('gateway-delegation.json', manifest('active'));
    assert.equal(h.routing.resolveAccountGatewaySocket('2', {}).socketPath, '/sock/qq-farm-wx.sock');
    h.put('gateway-delegation.json', { ...manifest(), phase: 'disabled', accountIds: [], accounts: [] });
    assert.equal(h.routing.resolveAccountGatewaySocket('2', {}).blocked, true);
    h.files.delete(h.dataPath('gateway-delegation.json'));
    assert.equal(h.routing.readGatewayDelegation(), null);
    assert.equal(h.routing.resolveAccountGatewaySocket('2', {}).delegated, false);
});

test('merge/split 不修改输入，不与输入共享嵌套帐号记录', () => {
    const h = createHarness();
    const raw = rawRecords();
    Object.freeze(raw.accounts[0]);
    Object.freeze(raw.accounts);
    Object.freeze(raw);
    const merged = h.routing.mergeDelegatedAccounts(raw);
    merged.accounts[0].name = '仅修改返回值';
    assert.equal(raw.accounts[0].name, '模拟QQ1');
    merged.accounts[2].customConfig.nested.push('changed');
    const snapshot = plain(merged);
    const split = h.routing.splitDelegatedAccounts(merged);
    split.delegation.accounts[0].customConfig.nested.push('separate');
    split.raw.accounts[0].name = '仅修改 split';
    assert.deepEqual(plain(merged), snapshot);
    assert.deepEqual(h.get('gateway-delegation.json'), manifest());
});

test('split 保留已持久化 nextId 高水位，不被输入降低', () => {
    const h = createHarness();
    const data = h.store.getAccounts();
    data.nextId = 11;
    h.store.saveAccounts(data);
    assert.equal(h.get('accounts.json').nextId, 41);
    data.nextId = 50;
    h.store.saveAccounts(data);
    assert.equal(h.get('accounts.json').nextId, 50);
});

test('仅有 id2 时删除后 raw 空数组仍保留 nextId 高水位', () => {
    const h = createHarness({ raw: { accounts: [], nextId: 41 } });
    assert.equal(h.store.getAccounts().nextId, 41);
    h.store.deleteAccount('2');
    assert.deepEqual(h.get('accounts.json'), { accounts: [], nextId: 41 });
    assert.deepEqual(plain(h.store.getAccounts()), { accounts: [], nextId: 41 });
});

test('无 manifest：helper、store 原行为保持且只写 raw', () => {
    const raw = { accounts: [...rawRecords().accounts, wxRecord()], nextId: 41 };
    const h = createHarness({ delegation: null, raw });
    assert.equal(h.routing.readGatewayDelegation(), null);
    assert.deepEqual(plain(h.routing.mergeDelegatedAccounts(raw)), raw);
    assert.deepEqual(plain(h.routing.splitDelegatedAccounts(raw)), { raw, delegation: null });
    assert.deepEqual(plain(h.store.getAccounts()), raw);
    h.store.addOrUpdateAccount({ id: '2', code: 'synthetic-legacy-code-only' });
    assert.equal(h.get('accounts.json').accounts[2].code, 'synthetic-legacy-code-only');
    assert.deepEqual(h.commits, [h.dataPath('accounts.json')]);
    assert.deepEqual(plain(h.routing.resolveAccountGatewaySocket('2', { FARM_GATEWAY_SOCK: 'tcp://legacy' })), {
        socketPath: 'tcp://legacy', blocked: false, delegated: false,
    });
    h.store.saveAccounts({ accounts: [], nextId: 41 });
    assert.deepEqual(h.get('accounts.json'), { accounts: [], nextId: 1 });
});

test('用户已移除 manifest 后保存不重建 delegate 文件', () => {
    const h = createHarness();
    const loaded = h.store.getAccounts();
    h.files.delete(h.dataPath('gateway-delegation.json'));
    h.store.saveAccounts(loaded);
    assert.ok(!h.files.has(h.dataPath('gateway-delegation.json')));
    assert.deepEqual(h.commits, [h.dataPath('accounts.json')]);
});

const malformedCases = [
    ['版本', data => { data.version = 2; }],
    ['generation 空白', data => { data.generation = '  '; }],
    ['generation 类型', data => { data.generation = 1; }],
    ['未知 phase', data => { data.phase = 'starting'; }],
    ['凭据目录越界', data => { data.credentialDirectory = '../wx-gateway'; }],
    ['凭据目录绝对路径', data => { data.credentialDirectory = '/wx-gateway'; }],
    ['旧 socket', data => { data.socketPath = '/sock/qq-farm-gateway.sock'; }],
    ['其他 socket', data => { data.socketPath = '/sock/other.sock'; }],
    ['socket 路径归一化伪装', data => { data.socketPath = '/sock/../sock/qq-farm-wx.sock'; }],
    ['托管其他 ID', data => { data.accountIds = ['1']; }],
    ['数字 ID', data => { data.accountIds = [2]; data.accounts[0].id = 2; }],
    ['重复委托 ID', data => { data.accountIds.push('2'); data.accounts.push(wxRecord()); }],
    ['records ID 不一致', data => { data.accounts[0].id = '10'; }],
    ['非 wx platform', data => { data.accounts[0].platform = 'qq'; }],
    ['active 空 records', data => { data.accounts = []; data.accountIds = []; }],
    ['draining 空 records', data => { data.phase = 'draining'; data.accounts = []; data.accountIds = []; }],
    ['disabled 含 records', data => { data.phase = 'disabled'; }],
    ['disabled ID 与 records 不一致', data => { data.phase = 'disabled'; data.accounts = []; }],
    ['records 非数组', data => { data.accounts = {}; }],
    ['records 非对象', data => { data.accounts = [null]; }],
    ['缺少创建时间', data => { delete data.createdAt; }],
    ['非法创建时间', data => { data.createdAt = {}; }],
    ['非法 drain 时间', data => { data.drainStartedAt = 'not-a-time'; }],
];
for (const [label, mutate] of malformedCases) {
    test(`非法 manifest ${label}：load/save/route 全部 fail-closed`, () => {
        const data = manifest();
        mutate(data);
        const h = createHarness({ delegation: data });
        const before = new Map(h.files);
        assert.throws(() => h.routing.readGatewayDelegation(), /配置非法/);
        assert.throws(() => h.store.getAccounts(), /配置非法/);
        assert.throws(() => h.store.saveAccounts(rawRecords()), /配置非法/);
        for (const id of ['2', '1', '10']) {
            assert.throws(() => h.routing.resolveAccountGatewaySocket(id, {}), /配置非法/);
        }
        assert.equal(h.commits.length, 0);
        assert.deepEqual(h.files, before);
    });
}

for (const text of ['', '{', 'null', '[]']) {
    test(`非法 manifest JSON ${JSON.stringify(text)}：不静默降回旧 gateway`, () => {
        const h = createHarness();
        h.files.set(h.dataPath('gateway-delegation.json'), text);
        assert.throws(() => h.store.getAccounts(), /配置非法/);
        assert.throws(() => h.routing.resolveAccountGatewaySocket('2', {}), /配置非法/);
        assert.equal(h.commits.length, 0);
    });
}

test('manifest EACCES/EIO 不是不存在，且错误不包含帐号内容', () => {
    const h = createHarness();
    for (const code of ['EACCES', 'EIO']) {
        h.readErrors.set(h.dataPath('gateway-delegation.json'), code);
        assert.throws(() => h.routing.readGatewayDelegation(), error => {
            assert.match(error.message, /配置非法/);
            assert.ok(!error.message.includes('synthetic'));
            return true;
        });
        assert.throws(() => h.store.saveAccounts(rawRecords()), /配置非法/);
    }
    assert.equal(h.commits.length, 0);
});

for (const id of ['2', 2, '1', 1]) {
    test(`raw 重复/冲突 ID ${JSON.stringify(id)}：合并和保存均拒绝`, () => {
        const raw = rawRecords();
        raw.accounts.push({ ...wxRecord(), id });
        const h = createHarness({ raw });
        assert.throws(() => h.store.getAccounts(), /配置非法/);
        assert.throws(() => h.store.saveAccounts({ accounts: [...rawRecords().accounts, wxRecord()], nextId: 41 }), /配置非法/);
        assert.equal(h.commits.length, 0);
    });
}

test('保存输入包含重复 id2 不串号、不写入任意文件', () => {
    const h = createHarness();
    const data = h.store.getAccounts();
    data.accounts.push({ ...wxRecord(), id: 2 });
    assert.throws(() => h.store.saveAccounts(data), /配置非法/);
    assert.equal(h.commits.length, 0);
    assert.deepEqual(h.get('accounts.json'), rawRecords());
});

test('保存不允许把委托 id2 改成 QQ', () => {
    const h = createHarness();
    const data = h.store.getAccounts();
    data.accounts[2].platform = 'qq';
    assert.throws(() => h.store.saveAccounts(data), /配置非法/);
    assert.equal(h.commits.length, 0);
});

test('disabled 拒绝陈旧快照恢复 id2', () => {
    const h = createHarness();
    const stale = h.store.getAccounts();
    h.store.deleteAccount('2');
    h.commits.length = 0;
    assert.throws(() => h.store.saveAccounts(stale), /配置非法/);
    assert.equal(h.commits.length, 0);
    assert.deepEqual(h.get('gateway-delegation.json').accounts, []);
});

test('delegate 原子提交失败时 raw 不写，复用真实 json-db 写入函数', () => {
    const h = createHarness();
    const data = h.store.getAccounts();
    data.accounts[2].name = '模拟保存失败';
    h.writeErrors.set(h.dataPath('gateway-delegation.json'), 'EIO');
    assert.throws(() => h.store.saveAccounts(data), /模拟文件错误/);
    assert.equal(h.commits.length, 0);
    assert.deepEqual(h.get('accounts.json'), rawRecords());
    assert.deepEqual(h.get('gateway-delegation.json'), manifest());
    assert.equal(h.files.size, 2);
});

test('raw 原子提交失败时 delegate 已先更新，raw 不包含 id2', () => {
    const h = createHarness();
    const data = h.store.getAccounts();
    data.accounts[2].name = '模拟先提交 delegate';
    h.writeErrors.set(h.dataPath('accounts.json'), 'EIO');
    assert.throws(() => h.store.saveAccounts(data), /模拟文件错误/);
    assert.deepEqual(h.commits, [h.dataPath('gateway-delegation.json')]);
    assert.deepEqual(h.get('accounts.json'), rawRecords());
    assert.equal(h.get('gateway-delegation.json').accounts[0].name, '模拟先提交 delegate');
    assert.equal(h.files.size, 2);
});
