const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function source(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function session(generation = '1') {
    return {
        id: 1,
        accountId: '10',
        gid: 10010,
        connectionEpoch: 7,
        remoteGeneration: generation,
        remoteGenerationSource: 'gateway',
        context: { priority: 'foreground', deadline: Date.now() + 60000 },
    };
}

function sceneHarness(options = {}) {
    let record = options.record || null;
    let currentSession = options.session || session();
    const calls = [];
    let failRestore = options.failRestore === true;
    const { createSceneSession } = require('../src/services/scene-session');
    const service = createSceneSession({
        loadRecord: () => record && JSON.parse(JSON.stringify(record)),
        saveRecord: (_accountId, value) => { record = JSON.parse(JSON.stringify(value)); },
        runOperation: (_name, task) => task(currentSession),
        validateSession: options.validateSession || (() => {}),
        drainRequests: options.drainRequests || (async () => {}),
        getDiagnostic: options.getDiagnostic || (() => ({ ...currentSession, connected: true, loggedIn: true })),
        getUserState: options.getUserState || (() => ({ gid: currentSession.gid })),
        friendState: options.friendState || (() => ({ resultState: 'idle' })),
        observeFriendTransport: options.observeFriendTransport,
        reconcileFriendHome: options.reconcileFriendHome,
        getSceneAccessInfo: options.getSceneAccessInfo,
        ranchFriendState: options.ranchFriendState || (() => ({ resultState: 'idle' })),
        runRequest: options.runRequest,
        sendScene: async (_session, sceneId, sendOptions) => {
            calls.push({ sceneId, ignoreCancellation: sendOptions.ignoreCancellation === true });
            if (options.rejectSceneId === sceneId) {
                throw Object.assign(new Error('该场景还未解锁'), {
                    code: 1045002, sent: true, resultState: 'failed', outcomeUnknown: false,
                });
            }
            if (failRestore && sceneId === 1 && calls.some(row => row.sceneId === 2)) {
                const error = new Error('restore timeout');
                error.sent = true;
                error.resultState = 'unknown';
                error.outcomeUnknown = true;
                throw error;
            }
            return { global_scene_id: sceneId, server_time: 1000 };
        },
    });
    return {
        service,
        calls,
        get record() { return record; },
        setSession(value) { currentSession = value; },
        allowRestore() { failRestore = false; },
    };
}

test('牧场proto覆盖scene2、自家读写与独立好友牧场会话', () => {
    const root = new protobuf.Root();
    root.loadSync([
        path.join(SRC, 'proto/corepb.proto'),
        path.join(SRC, 'proto/globalscenepb.proto'),
        path.join(SRC, 'proto/animalpb.proto'),
        path.join(SRC, 'proto/homesteadpb.proto'),
        path.join(SRC, 'proto/ranchpb.proto'),
    ], { keepCase: true });
    for (const name of [
        'gamepb.globalscenepb.PlayerSceneLoginRequest',
        'gamepb.homesteadpb.AllCellsRequest',
        'gamepb.animalpb.GetRanchDetailRequest',
        'gamepb.ranchpb.EnterHomesteadRequest',
        'gamepb.ranchpb.LeaveHomesteadRequest',
        'gamepb.animalpb.StealProduceRequest',
        'gamepb.ranchpb.StealProduceReply',
        'gamepb.animalpb.PutHazardRequest',
        'gamepb.animalpb.GetRanchOpTimesRequest',
        'gamepb.animalpb.StrokeAnimalRequest',
    ]) assert.ok(root.lookupType(name), name);
    assert.throws(() => root.lookupType('gamepb.animalpb.EnterHomesteadRequest'), /no such type/i,
        '好友牧场Enter/Leave必须留在独立ranchpb类型中');
});

test('场景权限诊断只查询一次服务端，不切场或改写本地状态', async () => {
    const root = new protobuf.Root();
    root.loadSync(path.join(SRC, 'proto/globalscenepb.proto'), { keepCase: true });
    const { types } = require('../src/utils/proto');
    const names = ['GetPlayerSceneInfoRequest', 'GetPlayerSceneInfoReply'];
    const previous = names.map(name => types[name]);
    for (const name of names) types[name] = root.lookupType(`gamepb.globalscenepb.${name}`);
    try {
        let payload = { active_global_scene_id: 1, default_global_scene_id: 1, unlocked_scenes: [1, 2] };
        let queries = 0;
        const h = sceneHarness({ runRequest: async (_session, service, method, body, options) => {
            queries++;
            assert.equal(service, 'gamepb.globalscenepb.GlobalSceneService');
            assert.equal(method, 'GetPlayerSceneInfo');
            assert.equal(body.length, 0);
            assert.equal(options.cleanup, undefined);
            return { body: types.GetPlayerSceneInfoReply.encode(payload).finish() };
        } });
        const unlocked = await h.service.getSceneAccessInfo();
        assert.equal(unlocked.ranchAccessConfirmed, true);
        assert.deepEqual(unlocked.unlockedSceneIds, [1, 2]);
        assert.equal(queries, 1);
        payload = { active_global_scene_id: 1, unlocked_scenes: [1] };
        assert.equal((await h.service.getSceneAccessInfo()).ranchAccessConfirmed, false);
        payload = {};
        await assert.rejects(h.service.getSceneAccessInfo(), { errorCode: 'SCENE_ACCESS_INFO_UNCONFIRMED' });
        assert.equal(queries, 3);
        assert.equal(h.record, null);
        assert.deepEqual(h.calls, []);
    } finally {
        names.forEach((name, index) => { if (previous[index] === undefined) delete types[name]; else types[name] = previous[index]; });
    }
});

test('首次只读牧场先确认home，再进入scene2并无视页面取消完成恢复', async () => {
    const h = sceneHarness();
    const result = await h.service.withScene(2, async ({ sceneReply }) => ({ server: sceneReply.server_time }));
    assert.deepEqual(result, { server: 1000 });
    assert.deepEqual(h.calls, [
        { sceneId: 1, ignoreCancellation: false },
        { sceneId: 2, ignoreCancellation: false },
        { sceneId: 1, ignoreCancellation: true },
    ]);
    assert.equal(h.record.phase, 'home');
    assert.equal(h.record.sceneId, 1);
    assert.equal(h.record.proof, 'scene_restore_confirmed');
});

test('牧场访友门禁先观测真实代际：同代际及IPC重载不解锁，真实推进才继续', async () => {
    const protectedVisit = { resultState: 'unknown', holdUntilTransportEpochChanged: true,
        transportEpoch: 26, recoveryAttemptState: 'completed' };
    const order = [];
    const observed = [];
    const h = sceneHarness({
        session: session('26'),
        friendState: accountId => {
            assert.equal(accountId, '10'); order.push('snapshot'); return { ...protectedVisit };
        },
        observeFriendTransport: (accountId, epoch) => {
            assert.equal(accountId, '10'); order.push('observe'); observed.push(epoch);
            if (epoch > protectedVisit.transportEpoch) protectedVisit.resultState = 'idle';
        },
    });
    assert.equal(h.service.getSnapshot('10').phase, 'uninitialized');
    assert.deepEqual(order, [], '被动快照不观测或改变访友状态');
    await assert.rejects(h.service.withScene(2, async () => assert.fail('同代际不得进入场景')), {
        errorCode: 'SCENE_FRIEND_VISIT_BUSY', resultState: 'unknown', holdUntilTransportEpochChanged: true,
    });
    assert.deepEqual(order, ['observe', 'snapshot']);
    assert.deepEqual(observed, [26]);
    assert.deepEqual(h.calls, []);
    h.setSession({ ...session('26'), connectionEpoch: 999 });
    await assert.rejects(h.service.withScene(2, async () => assert.fail('IPC重载不得解锁')), {
        errorCode: 'SCENE_FRIEND_VISIT_BUSY',
    });
    assert.deepEqual(observed, [26, 26]);
    assert.deepEqual(h.calls, []);
    h.setSession({ ...session('27'), connectionEpoch: 1000 });
    assert.equal(await h.service.withScene(2, async () => 'confirmed'), 'confirmed');
    assert.deepEqual(observed, [26, 26, 27]);
    assert.deepEqual(h.calls.map(row => row.sceneId), [1, 2, 1]);
    assert.equal(protectedVisit.recoveryAttemptState, 'completed', '旧Leave尝试记录不能被观测重置');
});

test('同代际权威HOME回读可安全解除未确认访友阻塞，不重发Leave', async () => {
    const visit = { resultState: 'unknown', holdUntilTransportEpochChanged: true, transportEpoch: 26,
        unknownGid: 10001, recoveryAttemptState: 'completed' };
    const reconciled = [];
    const h = sceneHarness({
        session: session('26'),
        friendState: () => visit,
        getSceneAccessInfo: async () => ({ activeSceneId: 1 }),
        reconcileFriendHome: (accountId, evidence) => {
            reconciled.push({ accountId, evidence });
            visit.resultState = 'idle';
            return true;
        },
    });
    assert.equal(await h.service.withScene(2, async () => 'ranch-work'), 'ranch-work');
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].accountId, '10');
    assert.equal(reconciled[0].evidence.activeSceneId, 1);
    assert.equal(reconciled[0].evidence.currentGid, 10010);
    assert.equal(reconciled[0].evidence.diagnostic.remoteGeneration, '26');
    assert.deepEqual(h.calls.map(row => row.sceneId), [1, 2, 1]);
    assert.equal(visit.recoveryAttemptState, 'completed');
});

test('牧场访友观测只接受当前账号身份及gateway来源，不接受进程或缺失代际', async () => {
    const s = session('27');
    const cases = [
        { remoteGenerationSource: 'process' },
        { remoteGenerationSource: 'unknown' },
        { accountId: '1' },
        { connected: false },
        { loggedIn: false },
        { detached: true },
        { quiescing: true },
        { remoteGeneration: null },
        { remoteGeneration: 'not-a-generation' },
        { remoteGeneration: '-1' },
        { remoteGeneration: '9007199254740993' },
        { remoteGeneration: '28' },
    ];
    for (const patch of cases) {
        let observations = 0;
        const h = sceneHarness({ session: s,
            getDiagnostic: () => ({ ...s, connected: true, loggedIn: true, ...patch }),
            friendState: () => ({ resultState: 'unknown', holdUntilTransportEpochChanged: true }),
            observeFriendTransport: () => observations++,
        });
        await assert.rejects(h.service.withScene(2, async () => assert.fail('未知访问不能绕过')), {
            errorCode: 'SCENE_FRIEND_VISIT_BUSY',
        });
        assert.equal(observations, 0, JSON.stringify(patch));
        assert.deepEqual(h.calls, [], JSON.stringify(patch));
    }
    for (const options of [
        { session: { ...s, remoteGenerationSource: 'process' },
            getDiagnostic: () => ({ ...s, connected: true, loggedIn: true }) },
        { session: s, getUserState: () => ({ gid: s.gid + 1 }) },
    ]) {
        let observations = 0;
        const h = sceneHarness({ ...options,
            friendState: () => ({ resultState: 'unknown' }),
            observeFriendTransport: () => observations++,
        });
        await assert.rejects(h.service.withScene(2, async () => assert.fail('身份未确认不能进入')), {
            errorCode: 'SCENE_FRIEND_VISIT_BUSY',
        });
        assert.equal(observations, 0); assert.deepEqual(h.calls, []);
    }
});

test('牧场访友观测前必须复查租约，不因过期会话改写安全状态', async () => {
    let observations = 0;
    const h = sceneHarness({ session: session('27'),
        validateSession: () => { throw Object.assign(new Error('租约已过期'), { errorCode: 'ACCOUNT_SESSION_CHANGED' }); },
        friendState: () => ({ resultState: 'unknown' }),
        observeFriendTransport: () => observations++,
    });
    await assert.rejects(h.service.withScene(2, async () => assert.fail('过期租约不能进入')), {
        errorCode: 'ACCOUNT_SESSION_CHANGED',
    });
    assert.equal(observations, 0); assert.deepEqual(h.calls, []);
});

test('同代际已确认home复用基线，不重复home预登录', async () => {
    const s = session();
    const h = sceneHarness({ record: {
        version: 1, accountId: s.accountId, gid: s.gid, connectionEpoch: s.connectionEpoch,
        remoteGeneration: s.remoteGeneration, phase: 'home', sceneId: 1,
        proof: 'scene_restore_confirmed', updatedAt: Date.now(),
    }, session: s });
    await h.service.withScene(2, async () => 'ok');
    assert.deepEqual(h.calls.map(row => row.sceneId), [2, 1]);
});

test('明确场景拒绝保留失败目标和阶段，home状态不能被误读为一定进牧场失败', async () => {
    for (const rejectSceneId of [1, 2]) {
        const s = session();
        const h = sceneHarness({ rejectSceneId, record: {
            version: 1, accountId: s.accountId, gid: s.gid,
            connectionEpoch: rejectSceneId === 1 ? s.connectionEpoch - 1 : s.connectionEpoch,
            remoteGeneration: s.remoteGeneration, remoteGenerationSource: 'gateway',
            phase: 'home', sceneId: 1, proof: 'home_scene_confirmed', updatedAt: Date.now(),
        } });
        let worked = false;
        await assert.rejects(h.service.withScene(2, async () => { worked = true; }), error => error.code === 1045002);
        assert.equal(worked, false);
        assert.deepEqual(h.calls.map(row => row.sceneId), [rejectSceneId]);
        assert.equal(h.record.phase, 'home');
        assert.equal(h.record.lastErrorCode, '1045002');
        assert.equal(h.record.lastFailedTargetSceneId, rejectSceneId);
        assert.equal(h.record.lastFailedPhase, rejectSceneId === 1 ? 'establishing_home' : 'switching');
        assert.equal(h.record.connectionEpoch, rejectSceneId === 1 ? s.connectionEpoch - 1 : s.connectionEpoch,
            '旧农场确认不可被拒绝响应迁移到新连接');
        const snapshot = h.service.getSnapshot('10');
        assert.equal(snapshot.lastFailedTargetSceneId, rejectSceneId);
        assert.equal(snapshot.lastFailureDefinitive, true);
        assert.equal(snapshot.recoveryRequired, false);
    }
});

test('恢复未知持久闭锁同一代际，不自动重复PlayerSceneLogin', async () => {
    const h = sceneHarness({ failRestore: true });
    await assert.rejects(h.service.withScene(2, async () => 'read'), error => error.errorCode === 'SCENE_RESTORE_UNKNOWN');
    assert.equal(h.record.phase, 'unknown');
    const count = h.calls.length;
    await assert.rejects(h.service.withScene(2, async () => 'read-again'), error => error.errorCode === 'SCENE_STATE_UNKNOWN');
    assert.equal(h.calls.length, count, 'same generation must not send another scene request');
});

test('真实连接代际变化后先重新确认home，才允许新只读场景事务', async () => {
    const h = sceneHarness({ failRestore: true });
    await assert.rejects(h.service.withScene(2, async () => 'read'));
    h.allowRestore();
    h.setSession(session('2'));
    h.calls.length = 0;
    const result = await h.service.withScene(2, async () => 'new-generation');
    assert.equal(result, 'new-generation');
    assert.deepEqual(h.calls.map(row => row.sceneId), [1, 2, 1]);
    assert.equal(h.record.phase, 'home');
    assert.equal(h.record.remoteGeneration, '2');
});

test('场景unknown不因IPC重连、代际缺失/回退或错用户解除', async () => {
    for (const changed of [
        { connectionEpoch: 8 },
        { connectionEpoch: 1 },
        { remoteGeneration: null },
        { remoteGeneration: '0' },
        { remoteGeneration: '2', gid: 99999 },
        { remoteGeneration: '2', remoteGenerationSource: 'process' },
    ]) {
        const h = sceneHarness({ failRestore: true });
        await assert.rejects(h.service.withScene(2, async () => 'read'));
        const count = h.calls.length;
        h.setSession({ ...session(), ...changed });
        await assert.rejects(h.service.withScene(2, async () => 'never'), error => error.errorCode === 'SCENE_STATE_UNKNOWN');
        assert.equal(h.calls.length, count, JSON.stringify(changed));
        assert.equal(h.service.getSnapshot('10').recoveryRequired, true);
    }
});

test('来源未知的旧scene记录不能凭当前数字remote代际自动复位', async () => {
    const h = sceneHarness({ record: {
        version: 1, accountId: '10', gid: 10010, connectionEpoch: 7,
        remoteGeneration: '1', phase: 'unknown', sceneId: 2, updatedAt: Date.now(),
    }, session: session('2') });
    await assert.rejects(h.service.withScene(2, async () => 'never'), error => error.errorCode === 'SCENE_STATE_UNKNOWN');
    assert.equal(h.calls.length, 0);
});

test('场景未结算或好友离场未知时，不发恢复scene1且保留持久unknown', async () => {
    const h = sceneHarness({ drainRequests: async () => { throw new Error('unsettled request'); } });
    await assert.rejects(h.service.withScene(2, async () => 'value'), error => error.errorCode === 'SCENE_REQUEST_UNSETTLED');
    assert.deepEqual(h.calls.map(row => row.sceneId), [1, 2]);
    assert.equal(h.record.phase, 'unknown');

    let busy = false;
    const friend = sceneHarness({ ranchFriendState: () => ({ resultState: busy ? 'unknown' : 'idle', recoveryRequired: busy }) });
    await assert.rejects(friend.service.withScene(2, async () => { busy = true; }), error => error.errorCode === 'SCENE_REQUEST_UNSETTLED');
    assert.deepEqual(friend.calls.map(row => row.sceneId), [1, 2]);
});

test('读取逻辑失败也必须先恢复home，再原样返回读取错误', async () => {
    const h = sceneHarness();
    const expected = Object.assign(new Error('all cells invalid'), { errorCode: 'RANCH_RESPONSE_INVALID' });
    await assert.rejects(h.service.withScene(2, async () => { throw expected; }), error => error === expected);
    assert.equal(h.record.phase, 'home');
    assert.equal(h.calls.at(-1).sceneId, 1);
    assert.equal(h.calls.at(-1).ignoreCancellation, true);
});

function ranchFriendSessionHarness(options = {}) {
    let record = options.record || null;
    let activeSession = options.session || session();
    const calls = [];
    const jsonType = {
        fromObject: value => value,
        encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
        decode: body => JSON.parse(Buffer.from(body).toString('utf8')),
    };
    const emptyType = {
        fromObject: value => value,
        encode: value => ({ finish: () => Buffer.from(JSON.stringify(value)) }),
        decode: () => ({}),
    };
    const { createRanchFriendSession } = require('../src/services/ranch-friend-session');
    const service = createRanchFriendSession({
        loadRecord: () => record && JSON.parse(JSON.stringify(record)),
        saveRecord: (_accountId, value) => { record = JSON.parse(JSON.stringify(value)); },
        validateSession: () => {},
        drainRequests: async () => {},
        getDiagnostic: () => ({ accountId: activeSession.accountId, connectionEpoch: activeSession.connectionEpoch,
            remoteGeneration: activeSession.remoteGeneration, remoteGenerationSource: activeSession.remoteGenerationSource,
            connected: true, loggedIn: true }),
        getUserState: () => ({ gid: activeSession.gid }),
        types: {
            RanchEnterHomesteadRequest: jsonType,
            RanchEnterHomesteadReply: jsonType,
            RanchLeaveHomesteadRequest: jsonType,
            RanchLeaveHomesteadReply: emptyType,
        },
        runRequest: async (_session, _service, method) => {
            calls.push(method);
            if (method === 'LeaveHomestead' && options.failLeave) {
                throw Object.assign(new Error('leave timeout'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
            }
            if (method === 'EnterHomestead' && options.badEnterBody) return { body: Buffer.from('{') };
            if (method === 'EnterHomestead') return { body: Buffer.from(JSON.stringify({
                basic: { gid: 20001, name: '好友' }, homestead_cells: { facilities: [] },
            })) };
            return { body: Buffer.alloc(0) };
        },
    });
    return { service, calls, get record() { return record; }, setSession(value) { activeSession = value; } };
}

test('好友牧场会话严格EnterHomestead→业务→LeaveHomestead并落盘离场证据', async () => {
    const h = ranchFriendSessionHarness();
    const result = await h.service.withFriend(session(), 20001, async ({ entry }) => entry.basic.name);
    assert.equal(result, '好友');
    assert.deepEqual(h.calls, ['EnterHomestead', 'LeaveHomestead']);
    assert.equal(h.record.phase, 'idle');
    assert.equal(h.record.proof, 'leave_homestead_confirmed');
});

test('好友牧场Leave未知闭锁同代际；真实代际变化后才允许新访问', async () => {
    const h = ranchFriendSessionHarness({ failLeave: true });
    await assert.rejects(h.service.withFriend(session(), 20001, async () => ({ confirmed: true })), error => {
        return error.errorCode === 'RANCH_FRIEND_LEAVE_UNKNOWN' && error.operationConfirmed === true;
    });
    assert.equal(h.record.phase, 'unknown');
    const count = h.calls.length;
    await assert.rejects(h.service.withFriend(session(), 20001, async () => 'never'), error => {
        return error.errorCode === 'RANCH_FRIEND_SESSION_UNKNOWN';
    });
    assert.equal(h.calls.length, count, '同代际不得重放EnterHomestead或LeaveHomestead');
    h.setSession(session('2'));
    assert.equal(h.service.getSnapshot('10').resultState, 'idle', '真实远端代际变化使旧记录失效');
});

test('好友牧场unknown跨IPC/模块重载保持，诊断不能将缺失用户或代际伪报idle', async () => {
    const first = ranchFriendSessionHarness({ failLeave: true });
    await assert.rejects(first.service.withFriend(session(), 20001, async () => 'value'));
    const stored = first.record;
    for (const changed of [
        { connectionEpoch: 8 }, { connectionEpoch: 1 },
        { remoteGeneration: null }, { remoteGeneration: '0' },
        { gid: 0 }, { remoteGeneration: '2', gid: 99999 },
        { remoteGeneration: '2', remoteGenerationSource: 'process' },
    ]) {
        const s = { ...session(), ...changed };
        const restarted = ranchFriendSessionHarness({ record: stored, session: s });
        assert.equal(restarted.service.getSnapshot('10').recoveryRequired, true, JSON.stringify(changed));
        await assert.rejects(restarted.service.withFriend(s, 20001, async () => 'never'), error => {
            return error.errorCode === 'RANCH_FRIEND_SESSION_UNKNOWN';
        });
        assert.equal(restarted.calls.length, 0);
    }
});

test('好友牧场Enter回包解码失败仍只补一次LeaveHomestead', async () => {
    const h = ranchFriendSessionHarness({ badEnterBody: true });
    await assert.rejects(h.service.withFriend(session(), 20001, async () => 'never'), error => {
        return error.errorCode === 'RANCH_FRIEND_RESPONSE_DECODE_FAILED';
    });
    assert.deepEqual(h.calls, ['EnterHomestead', 'LeaveHomestead']);
    assert.equal(h.record.phase, 'idle');
});

test('只读DTO不拿农场ItemInfo猜动物和设施名称', () => {
    const { facilityDto } = require('../src/services/ranch-readonly');
    const dto = facilityDto({
        instance_id: 10002,
        facility_id: 999,
        module_type: 7,
        level: 2,
        capacity: 3,
        state: 1,
        ranch: {
            ranch_inst_id: 500,
            capacity: 3,
            animal_count: 1,
            husbandry_type: 1,
            animals: [{ animal_inst_id: 8, animal_id: 123456, slot_index: 2, stage: 3 }],
            grass: { amount: 700, empty_at_ms: 2000000000000 },
            shelves: [], hazards: [],
        },
    });
    assert.equal(dto.name, '设施 #999');
    assert.equal(dto.ranch.animals[0].name, '动物 #123456');
    assert.equal(dto.ranch.grass.amount, '700');
});

test('牧场路由保留统一quote/operate并新增参数化好友只读GET', async () => {
    const handlers = new Map();
    const app = {
        get: (route, handler) => handlers.set(`GET ${route}`, handler),
        post: (route, handler) => handlers.set(`POST ${route}`, handler),
    };
    const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
    registerAdminRanchRoutes({
        app,
        provider: {
            getRanchOverview: async accountId => ({ readOnly: true, accountId }),
            getRanchFriend: async (_accountId, gid) => ({ gid: String(gid), ranches: [] }),
        },
        getAccountIdFromRequest: () => '10',
        canAccessAccount: () => true,
        sendProviderError: (_res, error) => { throw error; },
    });
    const routes = [...handlers.keys()];
    assert.ok(routes.includes('GET /api/ranch'));
    assert.ok(routes.includes('GET /api/ranch/friend'));
    assert.ok(!routes.some(route => /^POST \/api\/ranch\/(?!quote$|operate$|operations|activities\/operate$|session\/upgrade$)/.test(route)),
        '牧歌只使用专用活动协议；其他好友动作仍复用统一报价/执行');
    assert.ok(!routes.some(route => /^POST/.test(route) && /auto|task|mall|market/i.test(route)), '不得暴露自动化/任务/集市独立写入口');
    assert.ok(routes.includes('GET /api/ranch/tasks'), '4B任务只读专区应开放');
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await handlers.get('GET /api/ranch')({}, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.data.readOnly, true);
    await handlers.get('GET /api/ranch/friend')({ query: { gid: '12345' } }, response);
    assert.equal(response.body.data.gid, '12345');
});

test('worker/manager/frontend白名单与A-B-A保护完整接线', () => {
    const worker = source('src/core/worker.js');
    const manager = source('src/runtime/worker-manager.js');
    const provider = source('src/runtime/data-provider.js');
    const admin = source('src/controllers/admin.js');
    const api = fs.readFileSync(path.resolve(ROOT, '../web/src/api/index.ts'), 'utf8');
    const store = fs.readFileSync(path.resolve(ROOT, '../web/src/stores/ranch.ts'), 'utf8');
    const view = fs.readFileSync(path.resolve(ROOT, '../web/src/views/Ranch.vue'), 'utf8');
    assert.match(worker, /'getRanchOverview'/);
    assert.match(worker, /'getRanchFriend'/);
    const managerSafe = manager.slice(manager.indexOf('const SAFE_TOPLEVEL_READ'), manager.indexOf('const READ_RPC_TIMEOUT_MS'));
    assert.doesNotMatch(managerSafe, /getRanchOverview|getRanchFriend/);
    assert.match(provider, /getRanchOverview:.*callWorkerApi/);
    assert.match(provider, /getRanchFriend:.*callWorkerApi/);
    assert.match(admin, /registerAdminRanchRoutes/);
    const apiSafe = api.slice(api.indexOf('const safeReadPaths'), api.indexOf('const reads'));
    assert.doesNotMatch(apiSafe, /'\/api\/ranch(?:\/friend)?'/);
    assert.match(store, /'\/api\/ranch\/friend'/);
    assert.match(store, /friendRequestId\+\+/);
    assert.match(store, /friendController\?\.abort\(\)/);
    assert.match(store, /isCurrentAccount/);
    assert.doesNotMatch(store, /setInterval|pollInterval|auto[A-Z]\w*\s*=/);
    assert.match(view, /requestAction\('steal'/);
    assert.match(view, /requestAction\('putMosquito'/);
});

test('场景切换型读取不冒充顶层SAFE，纯本地pending才允许共享', () => {
    const worker = source('src/core/worker.js');
    const manager = source('src/runtime/worker-manager.js');
    const workerSafe = worker.slice(worker.indexOf('const SAFE_API_READS'), worker.indexOf('function isSafeApiRead'));
    const managerSafe = manager.slice(manager.indexOf('const SAFE_TOPLEVEL_READ'), manager.indexOf('const READ_RPC_TIMEOUT_MS'));
    for (const block of [workerSafe, managerSafe]) {
        assert.doesNotMatch(block, /getRanchOverview|getRanchFriend|getRanchCatalog/, '含PlayerSceneLogin的复合读不能共享/取消为普通读');
        assert.match(block, /getRanchPendingOperations/);
    }
});

test('精确安全读含牧场状态与互动次数，场景和访友命令仍走写排空', () => {
    const priority = require('../src/utils/request-priority');
    assert.equal(priority.isSafeReadRequest('gamepb.homesteadpb.HomesteadService', 'AllCells'), true);
    assert.equal(priority.isSafeReadRequest('gamepb.animalpb.AnimalService', 'GetRanchDetail'), true);
    assert.equal(priority.isSafeReadRequest('gamepb.animalpb.RanchService', 'GetRanchOpTimes'), true);
    assert.equal(priority.isSafeReadRequest('gamepb.itempb.ItemService', 'GetBag'), true);
    assert.equal(priority.isSafeReadRequest('gamepb.homesteadpb.HomesteadService', 'GetFacilityDetail'), true);
    assert.equal(priority.isSafeReadRequest('gamepb.globalscenepb.GlobalSceneService', 'PlayerSceneLogin'), false);
    assert.equal(priority.isSafeReadRequest('gamepb.visitpb.VisitService', 'EnterHomestead'), false);
    assert.equal(priority.isSafeReadRequest('gamepb.visitpb.VisitService', 'LeaveHomestead'), false);
});

test('场景操作进行中，好友新访问被明确未发送拒绝；结束后放行', async () => {
    const vm = require('node:vm');
    const { EventEmitter } = require('node:events');
    const coordinatorSource = fs.readFileSync(path.join(SRC, 'services/account-operation-coordinator.js'), 'utf8');
    const module_ = { exports: {} };
    const diagnostic = {
        accountId: '10', connectionEpoch: 7, remoteGeneration: '1', connected: true,
        loggedIn: true, detached: false, quiescing: false,
    };
    const context = vm.createContext({
        module: module_, exports: module_.exports, Buffer, Error, AbortController, console,
        setTimeout: resolve => { diagnostic.queue = { businessActive: 0 }; resolve(); },
        process: { env: { FARM_ACCOUNT_ID: '10' } },
        require(id) {
            if (id === '../utils/network') {
                return { getDiagnosticSnapshot: () => ({ ...diagnostic }), getUserState: () => ({ gid: 10010 }) };
            }
            if (id === '../utils/request-priority') return require('../src/utils/request-priority');
            if (id === './account-operation-barrier') return require('../src/services/account-operation-barrier');
            if (id === 'node:crypto') return require('node:crypto');
            throw new Error(`禁止真实 require: ${id}`);
        },
    });
    vm.runInContext(coordinatorSource, context, { filename: 'account-operation-coordinator.js' });
    const coordinator = module_.exports;

    assert.doesNotThrow(() => coordinator.assertSceneOperationAvailable(), '空闲时不得拒绝好友访问');

    const barrier = require('../src/services/account-operation-barrier');
    let release;
    let insideAllowed = false;
    const held = new Promise(resolve => { release = resolve; });
    const operation = coordinator.runAccountOperation('ranch-scene', () => {
        assert.doesNotThrow(() => barrier.assertGameRequestAllowed('gamepb.homesteadpb.HomesteadService', 'AllCells'));
        insideAllowed = true;
        return held;
    }, { sceneSensitive: true, priority: 'foreground', timeoutMs: 5000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(insideAllowed, true);
    assert.throws(() => coordinator.assertSceneOperationAvailable(), error => {
        return error.errorCode === 'ACCOUNT_SCENE_BUSY' && error.sent === false && error.resultState === 'not_sent';
    });
    assert.throws(() => barrier.assertGameRequestAllowed('gamepb.plantpb.PlantService', 'AllLands'),
        error => error.errorCode === 'ACCOUNT_SCENE_BUSY' && error.sent === false);
    assert.doesNotThrow(() => barrier.assertGameRequestAllowed('gamepb.userpb.UserService', 'Heartbeat'));
    assert.doesNotThrow(() => barrier.assertGameRequestAllowed('gamepb.acepb.AceService', 'AntiData'));
    release();
    await operation;
    assert.doesNotThrow(() => coordinator.assertSceneOperationAvailable(), '操作完成后必须放行');

    diagnostic.queue = { businessActive: 1 };
    let entered = false;
    await coordinator.runAccountOperation('ranch-scene', () => { entered = true; },
        { sceneSensitive: true, priority: 'foreground' });
    assert.equal(entered, true, '已发业务自然结算后才执行场景任务');
});

test('农场访友与好友牧场会话双向门禁', () => {
    const visit = source('src/services/friend-visit-session.js');
    const scene = source('src/services/scene-session.js');
    assert.match(visit, /assertSceneOperationAvailable\('好友访问'\)/);
    assert.match(visit, /getRanchFriendSessionSnapshot/);
    assert.match(scene, /getFriendVisitSessionSnapshot/);
    assert.match(scene, /getRanchFriendSessionSnapshot/);
});

// ==================== 二期：手动写闭环 ====================

test('固定牧场配置核实商品币种、出售类型与牧草保护', () => {
    const config = require('../src/services/ranch-config');
    const goods = require('../src/gameConfig/ranch/Goods.json').filter(row => [5, 6].includes(Number(row.shop_id)));
    assert.ok(goods.length > 0);
    assert.deepEqual([...new Set(goods.map(row => Number(row.price_id)))], [1007], '当前固定版本shop5/6均以金券计价');
    for (const row of goods) {
        assert.equal(config.getRanchGoods(row.id)?.item_id, row.item_id);
    }
    assert.equal(config.isRanchSellableProduct(7001), false, '牧草不得作为牧场产物自动入选出售');
    assert.ok(require('../src/gameConfig/ranch/MCItemInfo.json').some(row => [106, 107].includes(Number(row.type))));
});

test('三期proto保留自家写消息并精确加入四类好友互动', () => {
    const root = new protobuf.Root();
    root.loadSync([
        path.join(SRC, 'proto/corepb.proto'),
        path.join(SRC, 'proto/animalpb.proto'),
        path.join(SRC, 'proto/homesteadpb.proto'),
        path.join(SRC, 'proto/ranchpb.proto'),
    ], { keepCase: true });
    for (const name of [
        'corepb.FacilityOpResult',
        'gamepb.animalpb.PlaceAnimalRequest', 'gamepb.animalpb.TriggerProduceRequest',
        'gamepb.animalpb.FeedAnimalRequest', 'gamepb.animalpb.HarvestRanchRequest',
        'gamepb.animalpb.DonateAnimalRequest', 'gamepb.animalpb.CleanAllRanchRequest',
        'gamepb.homesteadpb.UpgradeBuildingRequest', 'gamepb.homesteadpb.CompleteBuildingUpgradeRequest',
        'gamepb.ranchpb.GetBagRequest', 'gamepb.ranchpb.SellRequest',
        'gamepb.ranchpb.EnterHomesteadReply', 'gamepb.ranchpb.LeaveHomesteadReply',
        'gamepb.animalpb.StealProduceRequest', 'gamepb.ranchpb.StealProduceReply',
        'gamepb.animalpb.PutHazardRequest', 'gamepb.animalpb.PutHazardReply',
        'gamepb.animalpb.GetRanchOpTimesRequest', 'gamepb.animalpb.GetRanchOpTimesReply',
        'gamepb.animalpb.StrokeAnimalRequest', 'gamepb.animalpb.StrokeAnimalReply',
    ]) assert.ok(root.lookupType(name), name);
});

test('好友牧场规划精确绑定host/栏舍/动物并保护本人已放蚊子', () => {
    const { planFriendAction, friendTarget } = require('../src/services/ranch-friends');
    const raw = {
        hostGid: 20001,
        ownerGid: 10010,
        remaining: { stroke: 2, putMosquito: 3 },
        ranches: [{
            ranch_inst_id: 88, husbandry_type: 1,
            hazards: [
                { hazard_id: 501, owner: 10010, hazard_type: 1 },
                { hazard_id: 502, owner: 20001, hazard_type: 2 },
            ],
            animals: [{ animal_inst_id: 7, animal_id: 60001, mutation: { strokable: true, stroked_gids: [] } }],
            shelves: [{ slot_index: 2, can_steal: true, lots: [{ item_id: 8001, remain_num: 2, can_steal: true, stealers: [] }] }],
        }],
    };
    const steal = planFriendAction('steal', { hostGid: 20001 }, raw);
    assert.equal(steal.count, 1);
    assert.deepEqual(steal.payload.targets, [], '原生一键偷取应由服务端筛选，终态再按报价目标核对');
    const clean = planFriendAction('cleanFriend', { hostGid: 20001 }, raw);
    assert.equal(clean.count, 1);
    assert.deepEqual(clean.marker.hazards, ['88:502'], '本人已放蚊子不得被好友清理规划移除');
    const stroke = planFriendAction('stroke', { hostGid: 20001, ranchId: 88, animalId: 7 }, raw);
    assert.equal(stroke.payload.target.animal_inst_id, 7);
    const mosquito = planFriendAction('putMosquito', { hostGid: 20001, ranchId: 88 }, raw);
    assert.equal(mosquito.payload.op_id, 11003);
    assert.equal(mosquito.payload.count, 1);
    assert.equal(friendTarget('stroke', { hostGid: 20001, ranchId: 88, animalId: 7 }), 'ranch:stroke:20001:88:7');
});

function ranchRuntimeHarness(options = {}) {
    const vm = require('node:vm');
    const root = new protobuf.Root();
    root.loadSync(['corepb', 'globalscenepb', 'animalpb', 'homesteadpb', 'ranchpb', 'shoppb', 'mallpb', 'paypb', 'taskpb', 'illustratedpb', 'sharepb', 'friendpb', 'muge']
        .map(name => path.join(SRC, `proto/${name}.proto`)), { keepCase: true });
    const types = {};
    for (const namespace of ['animalpb', 'homesteadpb', 'ranchpb']) {
        for (const definition of root.lookup(`gamepb.${namespace}`).nestedArray) {
            if (definition instanceof protobuf.Type) types[`Ranch${definition.name}`] = definition;
        }
    }
    for (const name of ['ShopInfoRequest', 'ShopInfoReply', 'BuyGoodsRequest', 'BuyGoodsReply']) {
        types[name] = root.lookupType(`gamepb.shoppb.${name}`);
    }
    for (const name of ['PlayerSceneLoginRequest', 'PlayerSceneLoginReply']) {
        types[name] = root.lookupType(`gamepb.globalscenepb.${name}`);
    }
    for (const name of ['GetMallListBySlotTypeRequest', 'GetMallListBySlotTypeResponse', 'PurchaseRequest', 'PurchaseResponse']) {
        types[name] = root.lookupType(`gamepb.mallpb.${name}`);
    }
    for (const name of ['GetRechargeInfoRequest', 'GetRechargeInfoReply']) types[name] = root.lookupType(`gamepb.paypb.${name}`);
    for (const name of ['TaskInfoRequest', 'TaskInfoReply', 'BatchClaimTaskRewardRequest', 'BatchClaimTaskRewardReply']) {
        types[`Ranch${name}`] = root.lookupType(`gamepb.taskpb.${name}`);
    }
    for (const name of ['GetIllustratedLevelListV2Request', 'GetIllustratedLevelListV2Reply']) {
        types[`Ranch${name}`] = root.lookupType(`gamepb.illustratedpb.${name}`);
    }
    for (const name of ['CheckCanShareRequest', 'CheckCanShareReply']) types[name] = root.lookupType(`gamepb.sharepb.${name}`);
    for (const name of ['MugeListReply', 'MugeOperateRequest', 'MugeOperateReply']) {
        types[name] = root.lookupType(`gamepb.activitypb.${name}`);
    }
    types.ActivityListRequest = types.RanchActivityListRequest;
    types.GetAllFriendsRequest = root.lookupType('gamepb.friendpb.GetAllRequest');
    types.GetAllFriendsReply = root.lookupType('gamepb.friendpb.GetAllReply');
    types.GetGameFriendsRequest = root.lookupType('gamepb.friendpb.GetGameFriendsRequest');
    const routes = {
        GetAll: ['GetAllFriendsRequest', 'GetAllFriendsReply'],
        GetGameFriends: ['GetGameFriendsRequest', 'GetAllFriendsReply'],
        GetRechargeInfo: ['GetRechargeInfoRequest', 'GetRechargeInfoReply'],
        PlayerSceneLogin: ['PlayerSceneLoginRequest', 'PlayerSceneLoginReply'],
        AllCells: ['RanchAllCellsRequest', 'RanchAllCellsReply'],
        GetBag: ['RanchGetBagRequest', 'RanchGetBagReply'],
        GetRanchDetail: ['RanchGetRanchDetailRequest', 'RanchGetRanchDetailReply'],
        GetRanchOpTimes: ['RanchGetRanchOpTimesRequest', 'RanchGetRanchOpTimesReply'],
        EnterHomestead: ['RanchEnterHomesteadRequest', 'RanchEnterHomesteadReply'],
        LeaveHomestead: ['RanchLeaveHomesteadRequest', 'RanchLeaveHomesteadReply'],
        ShopInfo: ['ShopInfoRequest', 'ShopInfoReply'], BuyGoods: ['BuyGoodsRequest', 'BuyGoodsReply'],
        HarvestRanch: ['RanchHarvestRanchRequest', 'RanchHarvestRanchReply'],
        TriggerProduce: ['RanchTriggerProduceRequest', 'RanchTriggerProduceReply'],
        FeedAnimal: ['RanchFeedAnimalRequest', 'RanchFeedAnimalReply'],
        AddFeed: ['RanchAddFeedRequest', 'RanchAddFeedReply'],
        Sell: ['RanchSellRequest', 'RanchSellReply'],
        PlaceAnimal: ['RanchPlaceAnimalRequest', 'RanchPlaceAnimalReply'],
        DonateAnimal: ['RanchDonateAnimalRequest', 'RanchDonateAnimalReply'],
        CleanAllRanch: ['RanchCleanAllRanchRequest', 'RanchCleanAllRanchReply'],
        StealProduce: ['RanchStealProduceRequest', 'RanchStealProduceReply'],
        PutHazard: ['RanchPutHazardRequest', 'RanchPutHazardReply'],
        StrokeAnimal: ['RanchStrokeAnimalRequest', 'RanchStrokeAnimalReply'],
        UpgradeBuilding: ['RanchUpgradeBuildingRequest', 'RanchUpgradeBuildingReply'],
        CompleteBuildingUpgrade: ['RanchCompleteBuildingUpgradeRequest', 'RanchCompleteBuildingUpgradeReply'],
        GetFacilityDetail: ['RanchGetFacilityDetailRequest', 'RanchGetFacilityDetailReply'],
        Use: ['RanchUseRequest', 'RanchUseReply'],
        GetMallListBySlotType: ['GetMallListBySlotTypeRequest', 'GetMallListBySlotTypeResponse'],
        Purchase: ['PurchaseRequest', 'PurchaseResponse'],
        TaskInfo: ['RanchTaskInfoRequest', 'RanchTaskInfoReply'],
        BatchClaimTaskReward: ['RanchBatchClaimTaskRewardRequest', 'RanchBatchClaimTaskRewardReply'],
        GetIllustratedListV2: ['RanchGetIllustratedListV2Request', 'RanchGetIllustratedListV2Reply'],
        GetIllustratedLevelListV2: ['RanchGetIllustratedLevelListV2Request', 'RanchGetIllustratedLevelListV2Reply'],
        GetRanchWeightScoreV2: ['RanchGetRanchWeightScoreV2Request', 'RanchGetRanchWeightScoreV2Reply'],
        ClaimAllRewardsV2: ['RanchClaimAllRewardsV2Request', 'RanchClaimAllRewardsV2Reply'],
        ClaimRanchWeightScoreRewardV2: ['RanchClaimRanchWeightScoreRewardV2Request', 'RanchClaimRanchWeightScoreRewardV2Reply'],
        BatchGetBasicInfo: ['RanchBatchGetBasicInfoRequest', 'RanchBatchGetBasicInfoReply'],
        CheckCanShare: ['CheckCanShareRequest', 'CheckCanShareReply'],
        ReportShare: ['RanchReportShareRequest', 'RanchReportShareReply'],
        ClaimShareReward: ['RanchClaimShareRewardRequest', 'RanchClaimShareRewardReply'],
        RotationShopInfo: ['RanchRotationShopInfoRequest', 'RanchRotationShopInfoReply'],
        RotationBuyGoods: ['RanchRotationBuyGoodsRequest', 'RanchRotationBuyGoodsReply'],
        List: ['RanchActivityListRequest', 'RanchActivityListReply'],
        MugeList: ['ActivityListRequest', 'MugeListReply'],
        Operate: ['MugeOperateRequest', 'MugeOperateReply'],
        GetGroup: ['RanchGetActivityGroupRequest', 'RanchGetActivityGroupReply'],
    };
    const disk = new Map();
    const calls = [];
    const handlers = new Map();
    const diagnostic = { accountId: '10', connectionEpoch: 7, remoteGeneration: '1', remoteGenerationSource: 'gateway',
        connected: true, loggedIn: true, detached: false, quiescing: false };
    let ownerGid = 10010;
    let active = 0;
    let writes = 0;
    const state = { cells: { grid_width: 1, grid_height: 1, facilities: [] },
        bag: { global_scene_id: 2, physical_items: [], virtual_items: [] }, ranches: [], serverTime: Date.now(),
        mugeList: { groups: [{ head: { id: '2026111700', start_time: Math.floor(Date.now() / 1000) - 60,
            end_time: Math.floor(Date.now() / 1000) + 3600, status: 1, desc: '测试规则' }, children: [
            { head: { id: '2026111702' }, global_count: { total: '100', tiers: [{ tier_id: '1', threshold: '50', status: 2, reward: [{ id: '7001', count: '1' }] }] } },
            { head: { id: '2026111703' }, invite_friend: { counted_friends: [{ gid: '22' }], tiers: [] } },
            { head: { id: '2026111704' }, task: { tier_points: '10', tiers: [], tasks: [{ task_id: '1', progress: '1', target: '1', status: 2, unlock_day: '1', desc: '测试任务', reward: [{ id: '7001', count: '1' }] }] } },
            { head: { id: '2026111705' }, survey: { answers: {}, personality_id: '0', settle_count: '0', share_reward_claimed: false } },
        ] }] } };
    const priority = require('../src/utils/request-priority');
    const services = {};
    const network = {
        getDiagnosticSnapshot: () => ({ ...diagnostic, queue: { businessActive: active }, pendingWrites: writes }),
        getUserState: () => ({ gid: ownerGid }),
        networkEvents: new (require('node:events').EventEmitter)(),
        sendMsgAsync: async (service, method, body, options) => {
            services.barrier.assertGameRequestAllowed(service, method);
            if (state.beforeSend) await state.beforeSend(method);
            options?.assertCanSend?.();
            let route = routes[method];
            if (!route || !types[route[0]] || !types[route[1]]) throw new Error(`禁止未声明RPC: ${service}.${method}`);
            const input = types[route[0]].toObject(types[route[0]].decode(body), { longs: String, defaults: false });
            if (method === 'List' && service === 'gamepb.activitypb.ActivityService' && Number(input.game_scene_id) === 1) route = routes.MugeList;
            calls.push({ service, method, input });
            const write = !priority.isSafeReadRequest(service, method);
            active++; if (write) writes++;
            try {
                let reply;
                if (handlers.has(method)) reply = await handlers.get(method)(input, service);
                else if (method === 'PlayerSceneLogin') reply = { global_scene_id: input.global_scene_id, server_time: state.serverTime };
                else if (method === 'RotationShopInfo') reply = state.market;
                else if (method === 'List') reply = route === routes.MugeList ? state.mugeList : state.activityList;
                else if (method === 'TaskInfo') reply = state.tasksReply;
                else if (method === 'GetIllustratedListV2') reply = state.book;
                else if (method === 'GetIllustratedLevelListV2') reply = state.bookLevels;
                else if (method === 'GetRanchWeightScoreV2') reply = state.weightBook;
                else if (method === 'BatchGetBasicInfo') reply = { users: [{ gid: ownerGid, share_infos: state.shareInfos }] };
                else if (method === 'CheckCanShare') reply = { can_share: true };
                else if (method === 'AllCells') reply = state.cells;
                else if (method === 'GetBag') reply = state.bag;
                else if (method === 'GetRanchDetail') reply = { ranches: state.ranches, interval: 60 };
                else if (method === 'EnterHomestead') reply = { basic: { gid: input.host_gid, name: '好友' }, homestead_cells: state.cells };
                else if (method === 'LeaveHomestead') reply = {};
                else if (method === 'GetRanchOpTimes') reply = { ops: [{ op_id: 11009, remaining_times: 2 }, { op_id: 11003, remaining_times: 3 }] };
                else throw new Error(`未提供测试回包: ${method}`);
                return { body: types[route[1]].encode(types[route[1]].fromObject(reply)).finish() };
            }
            finally { active--; if (write) writes--; }
        },
    };
    const memoryFs = { existsSync: file => disk.has(file), lstatSync: () => ({ isSymbolicLink: () => false }),
        readFileSync: file => disk.get(file) };
    const common = {
        '../utils/network': network, '../utils/request-priority': priority, '../utils/proto': { types },
        '../utils/utils': { getServerTimeSec: () => state.serverTime / 1000, log() {}, logWarn() {} },
        '../models/store': {
            getKnownFriendGids: () => state.knownGids || [],
            getAutomation: () => state.automation || {},
            getIntervals: () => ({ farmMin: 2, farmMax: 2 }),
            getFriendBlacklist: () => state.blacklist || [],
            getFriendBadTargets: () => state.badTargets || [],
        },
        '../config/config': { CONFIG: { platform: 'qq' } },
        '../config/runtime-paths': { getDataFile: file => `/memory/${file}` },
        './json-db': { writeJsonFileAtomic: (file, value) => disk.set(file, JSON.stringify(value)) },
        './player-login-protocol': require('../src/services/player-login-protocol'),
        'node:fs': memoryFs, 'node:path': path.posix, 'node:crypto': require('node:crypto'),
        'node:async_hooks': require('node:async_hooks'), 'protobufjs': protobuf,
        './friend-operation-limits': { getCanGetHelpExp: () => true },
    };
    function load(name, extra = {}) {
        const module = { exports: {} };
        vm.runInNewContext(source(`src/services/${name}.js`), {
            module, exports: module.exports, Buffer, Error, console, AbortController,
            Date: options.Date || Date, setTimeout: options.setTimeout || setTimeout, clearTimeout,
            process: { env: { FARM_ACCOUNT_ID: '10' } },
            require(id) {
                const dependencies = { ...common, ...extra };
                if (Object.hasOwn(dependencies, id)) return dependencies[id];
                const serviceName = id.startsWith('./') ? id.slice(2) : '';
                if (Object.hasOwn(services, serviceName)) return services[serviceName];
                throw new Error(`禁止真实依赖: ${name} -> ${id}`);
            },
        }, { filename: `${name}.js` });
        services[name] = module.exports;
        return module.exports;
    }
    services.barrier = load('account-operation-barrier');
    services.coordinator = load('account-operation-coordinator');
    load('ranch-friend-session');
    load('scene-session', { './friend-visit-session': {
        getFriendVisitSessionSnapshot: options.friendState || (() => ({ resultState: 'idle' })),
        observeFriendVisitTransport: options.observeFriendTransport || (() => {}),
    } });
    load('ranch-operations-ledger');
    services['ranch-config'] = require('../src/services/ranch-config');
    load('ranch-readonly');
    load('ranch-manual');
    load('ranch-progression');
    load('ranch-muge', { '../activity-data/muge-20261117.json': require('../src/activity-data/muge-20261117.json') });
    load('ranch-market', { '../gameConfig/ranch/OpeningActivity.json': require('../src/gameConfig/ranch/OpeningActivity.json') });
    load('ranch-friends');
    load('ranch-automation', { './friend-api': { inFriendQuietHours: () => false, SYSTEM_NPC_GIDS: new Set([10001]) } });
    return { services, state, calls, disk, handlers, types, diagnostic, network,
        setOwner: value => { ownerGid = value; },
        call: (action, input, expected) => services['ranch-manual'].operateRanchAction('10', action, input, expected),
        quote: (action, input) => services['ranch-manual'].quoteRanchAction('10', action, input),
    };
}

test('牧场巡查的新每日任务与分享礼包使用独立开关并只普通领取', () => {
    const store = fs.readFileSync(path.join(SRC, 'models/store.js'), 'utf8');
    const automation = fs.readFileSync(path.join(SRC, 'services/ranch-automation.js'), 'utf8');
    const muge = fs.readFileSync(path.join(SRC, 'services/ranch-muge.js'), 'utf8');
    for (const key of ['ranch_daily_tasks_claim', 'ranch_growth_tasks_claim', 'ranch_daily_share_claim', 'ranch_fill_cans', 'ranch_activity_claim']) {
        assert.match(store, new RegExp(`${key}: false`), `${key}默认关闭`);
        assert.ok(automation.includes(`'${key}'`), `${key}纳入统一巡查开关签名/工作判定`);
    }
    assert.match(automation, /task\.category === 'daily' && currentEnabled\('ranch_daily_tasks_claim'\)/);
    assert.match(automation, /task\.category === 'growth' && currentEnabled\('ranch_growth_tasks_claim'\)/);
    assert.match(automation, /act\(taskKeys, 'claimTasks', \{[\s\S]*taskIds: claimableTasks\.map\(task => task\.id\), double: false/);
    assert.match(automation, /claimCelebration/);
    assert.match(automation, /claimFriends/);
    assert.match(automation, /claimHandbook/);
    assert.match(automation, /shareState\.shareView\?\.canReport === true/);
    assert.match(automation, /act\('ranch_daily_share_claim', 'reportDailyShare'/);
    assert.match(automation, /raw\.shareView\?\.canClaim === true/);
    assert.match(automation, /claimDailyShare/);
    assert.match(automation, /does not open a social sheet or message any friend/);
    assert.match(automation, /getRanchCan/);
    assert.match(automation, /bucketBalance\(bucketId\) > 0n/);
    assert.match(automation, /cycle\.upgradeStarted/);
    assert.match(automation, /'upgrade', \{/);
    assert.match(automation, /ranch_muge_\$\{action\}/);
    assert.match(muge, /ranchOperations\.spend\(session\.accountId/);
    assert.match(muge, /operateRanchMugeActivityInSession/);
    assert.doesNotMatch(automation, /survey|settle/);
});

test('牧场访友默认接线通过真实模块导出观测，不靠测试注入替代生产恢复入口', async () => {
    const observed = [];
    const visit = { resultState: 'unknown', transportEpoch: 26, holdUntilTransportEpochChanged: true,
        recoveryAttemptState: 'completed' };
    const h = ranchRuntimeHarness({
        friendState: () => ({ ...visit }),
        observeFriendTransport: (accountId, epoch) => {
            assert.equal(accountId, '10'); observed.push(epoch);
            if (epoch > visit.transportEpoch) visit.resultState = 'idle';
        },
    });
    h.diagnostic.remoteGeneration = '26';
    const withScene = h.services['scene-session'].withGameScene;
    await assert.rejects(withScene(2, async () => assert.fail('同代际必须闭锁')), {
        errorCode: 'SCENE_FRIEND_VISIT_BUSY',
    });
    assert.deepEqual(observed, [26]); assert.deepEqual(h.calls, []);
    h.diagnostic.remoteGeneration = '27'; h.diagnostic.connectionEpoch = 99;
    assert.equal(await withScene(2, async () => 'confirmed'), 'confirmed');
    assert.deepEqual(observed, [26, 27]);
    assert.deepEqual(h.calls.map(row => row.input.global_scene_id), [1, 2, 1]);
    assert.equal(visit.recoveryAttemptState, 'completed');
});

test('普通幼崽自动放养购买核验实际金券和新增动物；空回包错扣费不重复购买', async () => {
    for (const mode of ['confirmed', 'empty', 'wrong-cost', 'wrong-animal', 'wrong-inventory']) {
        const h = ranchRuntimeHarness();
        const good = { id: 10003, item_id: 60002, item_count: 1, price: 1080, unlocked: true };
        const pen = { ranch_inst_id: 10001, husbandry_type: 1, capacity: 3, animal_count: 0, animals: [] };
        h.state.cells.facilities = [{ instance_id: 10001, state: 1, upgrade_state: 0, ranch: pen }];
        h.state.bag.virtual_items = [{ id: '1007', count: '20000' }];
        h.handlers.set('ShopInfo', () => ({ goods_list: [good] }));
        h.handlers.set('BuyGoods', input => {
            assert.equal(input.auto_add, true); assert.equal(Number(input.num), 3); assert.equal(Number(input.price), 1080);
            pen.animal_count = 3;
            pen.animals = [1, 2, 3].map(id => ({ animal_inst_id: id, animal_id: mode === 'wrong-animal' ? 60001 : 60002 }));
            h.state.bag.virtual_items[0].count = mode === 'wrong-inventory' ? '20000' : '16760';
            return mode === 'empty' ? {} : { goods: good, cost_items: [{ id: 1007, count: mode === 'wrong-cost' ? 1080 : 3240 }] };
        });
        const input = { shopId: 5, goodsId: 10003, count: 3, autoPlace: true };
        const quote = await h.quote('buy', input);
        if (mode === 'confirmed') assert.equal((await h.call('buy', input, quote.expected)).status, 'confirmed');
        else {
            await assert.rejects(h.call('buy', input, quote.expected), e => e.resultState === 'unknown');
            const sent = h.calls.length;
            await assert.rejects(h.call('buy', input, quote.expected), e => e.resultState === 'unknown');
            assert.equal(h.calls.length, sent, '未知购买不能用旧报价重发');
        }
        assert.equal(h.calls.filter(row => row.method === 'BuyGoods').length, 1);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, mode === 'confirmed' ? 0 : 1);
    }
});

test('自动幼崽选购只用已解锁普通金券商品，预算保底/数量/有效栏舍均受限', async () => {
    for (const mode of ['normal', 'reserve', 'one-affordable', 'locked', 'upgrading', 'full', 'limit', 'wrong-price', 'wrong-item']) {
        const h = ranchRuntimeHarness();
        h.state.cells.facilities = [{ instance_id: 10001, state: 1, upgrade_state: mode === 'upgrading' ? 1 : 0,
            ranch: { ranch_inst_id: 10001, husbandry_type: 1, capacity: 3, animal_count: 0,
                animals: mode === 'full' ? [{ animal_inst_id: 1 }, { animal_inst_id: 2 }, { animal_inst_id: 3 }] : [] } }];
        h.state.bag.virtual_items = [{ id: '1007', count: mode === 'reserve' ? '10000' : mode === 'one-affordable' ? '11080' : '20000' }];
        h.handlers.set('ShopInfo', () => ({ goods_list: [
            { id: 10002, item_id: 60001, item_count: 1, price: 2, unlocked: true },
            { id: 10003, item_id: mode === 'wrong-item' ? 70001 : 60002, item_count: 1,
                price: mode === 'wrong-price' ? 1 : 1080, unlocked: mode !== 'locked',
                limit_count: mode === 'limit' ? 1 : 0 },
        ] }));
        const manual = h.services['ranch-manual'];
        await h.services['scene-session'].withGameScene(2, async ({ session }) => {
            const raw = { ...await manual.loadSceneState(session), session, sessionAccountId: '10' };
            const input = await manual.selectAutoCubPurchase(raw, 3);
            if (['normal', 'one-affordable', 'limit'].includes(mode)) {
                assert.equal(input.goodsId, 10003, '不选几秒即收走的引导鸡');
                assert.equal(input.count, mode === 'normal' ? 3 : 1);
                const plan = await manual.planAction('buy', input, raw);
                assert.doesNotThrow(() => manual.assertAutoCubPlan(plan, raw, 3));
                const original = plan.costItems[0].id;
                plan.costItems[0].id = 1004;
                assert.throws(() => manual.assertAutoCubPlan(plan, raw, 3), e => e.errorCode === 'RANCH_AUTO_BUY_POLICY');
                plan.costItems[0].id = original;
                assert.throws(() => manual.assertAutoCubPlan(plan, raw, 0), e => e.errorCode === 'RANCH_AUTO_BUY_POLICY');
            } else assert.equal(input, null, mode);
        });
        assert.equal(h.calls.some(call => call.method === 'BuyGoods'), false);
    }
});

test('场景租约屏障内有限等待普通已发请求自然结算，等待期间心跳放行且不切场', async () => {
    const h = ranchRuntimeHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { await held; return h.state.cells; });
    const ordinary = h.network.sendMsgAsync('gamepb.homesteadpb.HomesteadService', 'AllCells', Buffer.alloc(0));
    let entered = false;
    const scene = h.services['scene-session'].withGameScene(2, async () => { entered = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, false);
    assert.equal(h.services.coordinator.getAccountOperationSnapshot().active.sceneSensitive, true);
    assert.deepEqual(h.calls.map(row => row.method), ['AllCells']);
    assert.throws(() => h.services.barrier.assertGameRequestAllowed('gamepb.plantpb.PlantService', 'AllLands'),
        error => error.errorCode === 'ACCOUNT_SCENE_BUSY' && error.sent === false);
    assert.doesNotThrow(() => h.services.barrier.assertGameRequestAllowed('gamepb.userpb.UserService', 'Heartbeat'));
    assert.doesNotThrow(() => h.services.barrier.assertGameRequestAllowed('gamepb.acepb.AceService', 'AntiData'));
    release(); await ordinary; await scene;
    assert.equal(entered, true);
    assert.deepEqual(h.calls.filter(row => row.method === 'PlayerSceneLogin').map(row => row.input.global_scene_id), [1, 2, 1]);
    assert.equal(h.services.coordinator.getAccountOperationSnapshot().active, null);
});

test('等待5秒超时仍明确BUSY且不取消/清除已发请求，另一账号夹具不受影响', async () => {
    let now = Date.now();
    class ClockDate extends Date { static now() { return now; } }
    let timerCalls = 0;
    const h = ranchRuntimeHarness({ Date: ClockDate, setTimeout: (resolve, ms) => {
        timerCalls++; now += ms; resolve();
    } });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let settled = false;
    h.handlers.set('AllCells', async () => { await held; settled = true; return h.state.cells; });
    const ordinary = h.network.sendMsgAsync('gamepb.homesteadpb.HomesteadService', 'AllCells', Buffer.alloc(0));
    const startedAt = now;
    await assert.rejects(h.services['scene-session'].withGameScene(2, async () => assert.fail('不得切场')),
        error => error.errorCode === 'ACCOUNT_OPERATION_BUSY' && error.sent === false
            && error.resultState === 'not_sent' && error.retryAfterMs === 1000);
    assert.equal(now - startedAt, 5000);
    assert.equal(timerCalls, 50);
    assert.equal(settled, false);
    assert.equal(h.network.getDiagnosticSnapshot().queue.businessActive, 1);
    assert.equal(h.disk.size, 0);
    assert.deepEqual(h.calls.map(row => row.method), ['AllCells']);
    assert.doesNotThrow(() => h.services.barrier.assertGameRequestAllowed('gamepb.userpb.UserService', 'Heartbeat'));
    const isolated = ranchRuntimeHarness();
    isolated.diagnostic.accountId = '20'; isolated.setOwner(10020);
    await isolated.services['scene-session'].withGameScene(2, async () => '账号20完成');
    assert.equal(isolated.calls.filter(row => row.method === 'PlayerSceneLogin').length, 3);
    assert.equal(h.network.getDiagnosticSnapshot().queue.businessActive, 1);
    release(); await ordinary;
    assert.equal(settled, true);
    assert.equal(h.network.getDiagnosticSnapshot().queue.businessActive, 0);
});

test('自然等待同时受事务剩余期限约束，短期限到达也明确BUSY而非切场', async () => {
    let now = Date.now();
    class ClockDate extends Date { static now() { return now; } }
    const h = ranchRuntimeHarness({ Date: ClockDate, setTimeout: (resolve, ms) => { now += ms; resolve(); } });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { await held; return h.state.cells; });
    const ordinary = h.network.sendMsgAsync('gamepb.homesteadpb.HomesteadService', 'AllCells', Buffer.alloc(0));
    const startedAt = now;
    await assert.rejects(h.services['scene-session'].withGameScene(2, async () => assert.fail('不能切场'), { timeoutMs: 1000 }),
        error => error.errorCode === 'ACCOUNT_OPERATION_BUSY' && error.sent === false && error.resultState === 'not_sent');
    assert.equal(now - startedAt, 1000);
    assert.deepEqual(h.calls.map(row => row.method), ['AllCells']);
    release(); await ordinary;
});

test('真实自动写发送前透传开关复查，不误拦本次spend的pending；已发写关闭后仍正常核验', async () => {
    for (const mode of ['before-total', 'before-child', 'after', 'normal']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h);
        h.state.automation = { ranch: true, ranch_harvest: true };
        h.state.beforeSend = method => {
            if (method !== 'HarvestRanch') return;
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 1,
                '回调必须允许spend自己刚建立的pending');
            if (mode === 'before-total') h.state.automation.ranch = false;
            if (mode === 'before-child') h.state.automation.ranch_harvest = false;
        };
        h.handlers.set('HarvestRanch', () => {
            if (mode === 'after') h.state.automation.ranch = false;
            return { ranches: [ranch], op_results: [
                { facility_inst_id: 88, kind: 1, target_id: 1, rewards: [{ id: 1060001, count: 1 }] },
            ] };
        });
        const run = h.services['ranch-automation'].run();
        if (mode.startsWith('before')) await assert.rejects(run,
            error => error.errorCode === 'RANCH_AUTOMATION_DISABLED' && error.sent === false && error.resultState === 'not_sent');
        else {
            const outcome = await run;
            assert.equal(outcome.actions, 1, `${mode}: ${JSON.stringify({ outcome, calls: h.calls.map(row => row.method), state: h.services['ranch-automation'].getRoutineState() })}`);
        }
        assert.equal(h.calls.filter(row => row.method === 'HarvestRanch').length, mode.startsWith('before') ? 0 : 1);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        assert.equal(h.calls.at(-1).input.global_scene_id, 1, '未发送/已确认都可靠恢复，不重放写');
    }
});

test('补草consumed按正确ID精确汇总分批，非法/缺失/总量或feed_count不符保留unknown不重放', async () => {
    for (const [mode, consumed] of [
        ['single', [{ id: '7001', count: '20' }]],
        ['split', [{ id: '7001', count: '12', uid: '111' }, { id: '7001', count: '8', uid: '112' }]],
        ['wrong-id', [{ id: '1', count: '20' }]],
        ['mixed-id', [{ id: '7001', count: '12' }, { id: '7003', count: '8' }]],
        ['negative', [{ id: '7001', count: '-1' }, { id: '7001', count: '21' }]],
        ['zero', [{ id: '7001', count: '0' }, { id: '7001', count: '20' }]],
        ['missing-count', [{ id: '7001' }]], ['empty', []],
        ['wrong-total', [{ id: '7001', count: '19' }]],
        ['large-exact', [{ id: '7001', count: '9007199254740993' }]],
        ['wrong-feed-count', [{ id: '7001', count: '20' }]],
    ]) {
        const h = ranchRuntimeHarness();
        h.state.cells.facilities = [{ instance_id: 88, capacity: 30, feed_machine: { feed_count: 10 } }];
        h.state.bag.physical_items = [{ id: '7001', count: '20', uid: '111' }];
        h.handlers.set('AddFeed', input => {
            assert.equal(input.add_count, 20); assert.equal(input.use_gold, false);
            return { detail: { feed_count: mode === 'wrong-feed-count' ? 31 : 30 }, consumed };
        });
        const quote = await h.quote('addGrass', { facilityId: 88 });
        const success = ['single', 'split'].includes(mode);
        if (success) {
            const result = await h.call('addGrass', { facilityId: 88 }, quote.expected);
            assert.equal(result.status, 'confirmed'); assert.equal(result.completed, 20);
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        } else {
            await assert.rejects(h.call('addGrass', { facilityId: 88 }, quote.expected), error => error.resultState === 'unknown');
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 1);
            const callsBefore = h.calls.length;
            await assert.rejects(h.call('addGrass', { facilityId: 88 }, quote.expected), error => error.resultState === 'unknown');
            assert.equal(h.calls.length, callsBefore, mode);
        }
        assert.equal(h.calls.filter(row => row.method === 'AddFeed').length, 1);
    }
});

test('补草回包不列扣减时仅用同场景精确库存差额结算，不重发', async () => {
    for (const mode of ['confirmed', 'unchanged', 'wrong-scene', 'read-failure', 'locked-changed', 'wrong-machine']) {
        const h = ranchRuntimeHarness();
        h.state.cells.facilities = [{ instance_id: 10002, capacity: 30, feed_machine: { feed_count: 29 } }];
        h.state.bag.physical_items = [{ id: '7001', count: '1', uid: '111' }, { id: '7001', count: '2', uid: '112', is_locked: true }];
        const quote = await h.quote('addGrass', { facilityId: 10002 });
        let sent = false;
        h.handlers.set('AddFeed', input => {
            assert.equal(input.add_count, 1); assert.equal(input.use_gold, false);
            sent = true;
            if (mode !== 'unchanged') h.state.bag.physical_items.shift();
            if (mode === 'locked-changed') h.state.bag.physical_items.push({ id: '7001', count: '1', uid: '113' });
            h.state.cells.facilities[0].feed_machine.feed_count = mode === 'wrong-machine' ? 29 : 30;
            return { detail: { feed_count: mode === 'wrong-machine' ? 29 : 30 } };
        });
        h.handlers.set('GetBag', () => {
            if (sent && mode === 'read-failure') throw new Error('read failed');
            if (sent && mode === 'wrong-scene') return { ...h.state.bag, global_scene_id: 1 };
            if (sent && mode === 'locked-changed') return { ...h.state.bag, physical_items: [
                { id: '7001', count: '1', uid: '112', is_locked: true }, { id: '7001', count: '1', uid: '113' },
            ] };
            return h.state.bag;
        });
        const operate = () => h.call('addGrass', { facilityId: 10002 }, quote.expected);
        if (mode === 'confirmed') assert.equal((await operate()).completed, 1);
        else await assert.rejects(operate(), error => error.resultState === 'unknown', mode);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, mode === 'confirmed' ? 0 : 1, mode);
        assert.equal(h.calls.filter(row => row.method === 'AddFeed').length, 1, mode);
        assert.equal(h.calls.filter(row => row.method === 'GetBag').length, mode === 'wrong-machine' ? 2 : 3, mode);
    }
});

test('补草同物品回包总量不符须用写后目标增量和库存差双证据，缺任一证据保留且不重发', async () => {
    for (const mode of ['confirmed', 'no-deduction', 'wrong-target', 'changed-capacity', 'wrong-item', 'read-failure', 'zero-count']) {
        const h = ranchRuntimeHarness();
        h.state.cells.facilities = [{ instance_id: 10002, capacity: 100, feed_machine: { feed_count: 99 } }];
        h.state.bag.physical_items = [{ id: '7001', count: '80', uid: '111' }];
        const quote = await h.quote('addGrass', { facilityId: 10002 });
        let sent = false;
        h.handlers.set('AddFeed', () => {
            sent = true;
            h.state.bag.physical_items[0].count = mode === 'no-deduction' ? '80' : '79';
            const f = h.state.cells.facilities[0];
            f.feed_machine.feed_count = 100;
            if (mode === 'wrong-target') f.instance_id = 10003;
            if (mode === 'changed-capacity') f.capacity = 101;
            return { detail: { feed_count: 100 }, consumed: [{ id: mode === 'wrong-item' ? '7002' : '7001', count: mode === 'zero-count' ? '0' : '79' }] };
        });
        h.handlers.set('GetBag', () => { if (sent && mode === 'read-failure') throw new Error('no post-state'); return h.state.bag; });
        if (['confirmed', 'zero-count'].includes(mode)) assert.equal((await h.call('addGrass', { facilityId: 10002 }, quote.expected)).completed, 1);
        else {
            await assert.rejects(h.call('addGrass', { facilityId: 10002 }, quote.expected), e => e.resultState === 'unknown', mode);
            const calls = h.calls.length;
            await assert.rejects(h.call('addGrass', { facilityId: 10002 }, quote.expected), e => e.resultState === 'unknown');
            assert.equal(h.calls.length, calls, '已未知的同目标不能再次发送或自动再报价');
        }
        assert.equal(h.calls.filter(row => row.method === 'AddFeed').length, 1, mode);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, ['confirmed', 'zero-count'].includes(mode) ? 0 : 1, mode);
    }
});

test('动态场景结算：并行读拒绝时等待兄弟原始Promise后才能恢复scene1', async () => {
    const h = ranchRuntimeHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { throw Object.assign(new Error('remote refusal'), { stage: 'remote', sent: true, resultState: 'failed' }); });
    h.handlers.set('GetBag', async () => { await held; return h.state.bag; });
    const run = h.services['scene-session'].withGameScene(2, async ({ session: s }) => h.services['ranch-manual'].loadSceneState(s));
    const error = run.catch(cause => cause);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.calls.filter(row => row.method === 'PlayerSceneLogin').map(row => row.input.global_scene_id), [1, 2]);
    release();
    assert.equal((await error).message, 'remote refusal');
    assert.deepEqual(h.calls.filter(row => row.method === 'PlayerSceneLogin').map(row => row.input.global_scene_id), [1, 2, 1]);
});

test('动态场景超时：不恢复、不放普通RPC，IPC重连/重载不能抹掉unknown', async () => {
    const h = ranchRuntimeHarness();
    h.handlers.set('AllCells', async () => { throw Object.assign(new Error('transport timeout'), { stage: 'transport', sent: true, resultState: 'failed' }); });
    await assert.rejects(h.services['ranch-readonly'].getRanchOverview(), error => error.errorCode === 'SCENE_REQUEST_UNSETTLED');
    assert.deepEqual(h.calls.filter(row => row.method === 'PlayerSceneLogin').map(row => row.input.global_scene_id), [1, 2]);
    assert.throws(() => h.services.barrier.assertGameRequestAllowed('gamepb.plantpb.PlantService', 'AllLands'), error => error.errorCode === 'ACCOUNT_SCENE_UNKNOWN');
    h.diagnostic.connectionEpoch = 8;
    assert.throws(() => h.services.barrier.assertGameRequestAllowed('gamepb.plantpb.PlantService', 'AllLands'), error => error.errorCode === 'ACCOUNT_SCENE_UNKNOWN');
    assert.doesNotThrow(() => h.services.barrier.assertGameRequestAllowed('gamepb.userpb.UserService', 'Heartbeat'));
    h.diagnostic.remoteGeneration = '2';
    assert.doesNotThrow(() => h.services.barrier.assertGameRequestAllowed('gamepb.plantpb.PlantService', 'AllLands'));
});

test('动态租约取消：已发RPC不随HTTP取消，离场只属于租约；迟到任务不能续发', async () => {
    const h = ranchRuntimeHarness();
    const priority = require('../src/utils/request-priority');
    const controller = new AbortController();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { await held; return h.state.cells; });
    const run = priority.runWithRequestContext({ signal: controller.signal }, () => h.services['ranch-readonly'].getRanchOverview());
    const outcome = run.catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.deepEqual(h.calls.map(row => row.method), ['PlayerSceneLogin', 'PlayerSceneLogin', 'AllCells']);
    release();
    assert.equal((await outcome).errorCode, 'REQUEST_CANCELLED');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.at(-1).method, 'PlayerSceneLogin');
    assert.equal(h.calls.at(-1).input.global_scene_id, 1);

    let trigger;
    const later = new Promise(resolve => { trigger = resolve; });
    let late;
    await h.services.coordinator.runAccountOperation('ranch-scene', () => {
        late = later.then(() => h.services.barrier.assertGameRequestAllowed('gamepb.itempb.ItemService', 'GetBag'));
    }, { sceneSensitive: true });
    trigger();
    await assert.rejects(late, error => error.errorCode === 'ACCOUNT_SCENE_BUSY' && error.sent === false);
});

test('动态场景缓存：active期间仍合并同目标读，独立取消等待不打断共享事务', async () => {
    const h = ranchRuntimeHarness();
    const priority = require('../src/utils/request-priority');
    const controller = new AbortController();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { await held; return h.state.cells; });
    const first = priority.runWithRequestContext({ signal: controller.signal }, () => h.services['ranch-readonly'].getRanchOverview()).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    const second = h.services['ranch-readonly'].getRanchOverview();
    controller.abort();
    assert.equal((await first).errorCode, 'REQUEST_CANCELLED');
    assert.equal(h.calls.filter(row => row.method === 'AllCells').length, 1);
    release();
    const value = await second;
    assert.equal(value.cache.coalesced, true);
    assert.equal(h.calls.filter(row => row.method === 'AllCells').length, 1);
    assert.deepEqual(h.calls.filter(row => row.method === 'PlayerSceneLogin').map(row => row.input.global_scene_id), [1, 2, 1]);
    value.facilities.push({ fake: true });
    const cached = await h.services['ranch-readonly'].getRanchOverview();
    assert.equal(cached.facilities.length, 0, '共享值必须独立克隆');
});

test('动态场景缓存：无人等待且尚在账号队列时取消，不新增场景RPC', async () => {
    const h = ranchRuntimeHarness();
    const priority = require('../src/utils/request-priority');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const occupying = h.services.coordinator.runAccountOperation('farm-tick', () => held);
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const read = priority.runWithRequestContext({ signal: controller.signal }, () => h.services['ranch-readonly'].getRanchOverview()).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal((await read).errorCode, 'REQUEST_CANCELLED');
    release(); await occupying;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 0);
});

test('动态缓存失效：notify或写失效后旧读不回填，新读拿新版本', async () => {
    const h = ranchRuntimeHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('AllCells', async () => { await held; return h.state.cells; });
    const stale = h.services['ranch-readonly'].getRanchOverview().catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    h.network.networkEvents.emit('ranchDataChanged', { type: 'gamepb.homesteadpb.FacilitiesNotify' });
    release();
    assert.equal((await stale).errorCode, 'RANCH_READ_INVALIDATED');
    h.handlers.delete('AllCells');
    h.state.cells.grid_width = 2;
    const fresh = await h.services['ranch-readonly'].getRanchOverview();
    assert.equal(fresh.grid.width, 2);
    assert.equal(fresh.cache.hit, false);
    assert.equal(h.calls.filter(row => row.method === 'AllCells').length, 2);
});

test('动态好友单飞：同host只有一次EnterHomestead/LeaveHomestead，缓存不混目标', async () => {
    const h = ranchRuntimeHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('GetRanchDetail', async () => { await held; return { ranches: [], interval: 60 }; });
    const first = h.services['ranch-friends'].getRanchFriendOverview(20001);
    await new Promise(resolve => setImmediate(resolve));
    const second = h.services['ranch-friends'].getRanchFriendOverview(20001);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.gid, '20001'); assert.equal(b.gid, '20001');
    assert.equal(h.calls.filter(row => row.method === 'EnterHomestead').length, 1);
    assert.equal(h.calls.filter(row => row.method === 'LeaveHomestead').length, 1);
    const other = await h.services['ranch-friends'].getRanchFriendOverview(20002);
    assert.equal(other.gid, '20002');
    assert.equal(h.calls.filter(row => row.method === 'EnterHomestead').length, 2);
});

function readyRanch(h, count = 2) {
    const ranch = { ranch_inst_id: 88, husbandry_type: 1, capacity: 4, animal_count: count,
        animals: Array.from({ length: count }, (_, index) => ({ animal_inst_id: index + 1, animal_id: 60001,
            stage: 3, can_harvest: true, can_deliver: true })), shelves: [], hazards: [] };
    h.state.cells.facilities = [{ instance_id: 88, facility_id: 6001001, module_type: 6, state: 1, level: 1, ranch }];
    h.state.ranches = [ranch];
    return ranch;
}

test('实际收获终态：空/重复/错目标/零产出/未报价成本均保留unknown且只发送一次', async () => {
    const badResults = [
        [],
        [{ facility_inst_id: 88, kind: 1, target_id: 1, rewards: [{ id: 1060001, count: 1 }] },
            { facility_inst_id: 88, kind: 1, target_id: 1, rewards: [{ id: 1060001, count: 1 }] }],
        [{ facility_inst_id: 88, kind: 1, target_id: 99, rewards: [{ id: 1060001, count: 1 }] }],
        [{ facility_inst_id: 88, kind: 1, target_id: 1, rewards: [] }],
        [{ facility_inst_id: 88, kind: 1, target_id: 1, rewards: [{ id: 1060001, count: 0 }] }],
        [{ facility_inst_id: 88, kind: 1, target_id: 1, costs: [{ id: 1007, count: 1 }], rewards: [{ id: 1060001, count: 1 }] }],
    ];
    for (const results of badResults) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h);
        h.handlers.set('HarvestRanch', async () => ({ ranches: [ranch], op_results: results }));
        const quote = await h.quote('harvest', { all: true });
        await assert.rejects(h.call('harvest', { all: true }, quote.expected), error => error.resultState === 'unknown');
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 1);
        assert.equal(h.calls.filter(row => row.method === 'HarvestRanch').length, 1);
        const before = h.calls.length;
        await assert.rejects(h.quote('harvest', { all: true }), error => error.errorCode === 'RANCH_PENDING_CONFIRMATION');
        assert.equal(h.calls.length, before, '未知后不再切场或重提');
    }
});

test('部分收获只确认回包数量，报价签名包含目标/数量，零目标不发业务写', async () => {
    const h = ranchRuntimeHarness();
    const ranch = readyRanch(h);
    h.handlers.set('HarvestRanch', async () => ({ ranches: [ranch], op_results: [
        { facility_inst_id: 88, kind: 1, target_id: 1, rewards: [{ id: 1060001, count: 1 }] },
    ] }));
    const quote = await h.quote('harvest', { all: true });
    const result = await h.call('harvest', { all: true }, quote.expected);
    assert.equal(result.completed, 1); assert.equal(result.count, 2); assert.equal(result.partial, true);
    assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);

    const changed = ranchRuntimeHarness();
    const before = readyRanch(changed);
    const original = await changed.quote('clean', {});
    before.hazards = [{ hazard_id: 501, hazard_type: 2, owner: 10010 }];
    await assert.rejects(changed.call('clean', {}, original.expected), error => error.errorCode === 'RANCH_OFFER_CHANGED');
    assert.equal(changed.calls.filter(row => row.method === 'CleanAllRanch').length, 0);

    const empty = ranchRuntimeHarness();
    const none = await empty.quote('harvest', { all: true });
    const skipped = await empty.call('harvest', { all: true }, none.expected);
    assert.equal(skipped.status, 'skipped'); assert.equal(skipped.completed, 0);
    assert.equal(empty.calls.filter(row => row.method === 'HarvestRanch').length, 0);
});

test('喂养终态逐目标确认：部分实际消耗与动物变化匹配，不能只凭扣桶记全部成功', async () => {
    for (const mode of ['valid', 'no_results', 'missing_animal', 'unchanged', 'bad_cost']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h);
        for (const animal of ranch.animals) Object.assign(animal, {
            stage: 2, can_feed: true, limited_can_used: false, grow_ready_at_ms: Date.now() + 1800000,
        });
        h.state.bag.virtual_items = [{ id: 7003, count: 10000 }];
        const next = JSON.parse(JSON.stringify(ranch));
        next.animals[0].grow_ready_at_ms -= 600000;
        if (mode === 'missing_animal') next.animals = [];
        if (mode === 'unchanged') next.animals = JSON.parse(JSON.stringify(ranch.animals));
        h.handlers.set('FeedAnimal', async () => ({ ranches: [next], deduct_secs: 600, bucket_remain_secs: 9400,
            op_results: mode === 'no_results' ? [] : [{ facility_inst_id: 88, kind: 1, target_id: 1,
                costs: [{ id: 7003, count: mode === 'bad_cost' ? 500 : 600 }], rewards: [] }] }));
        const input = { all: true, bucketType: 2 };
        const quote = await h.quote('feed', input);
        if (mode === 'valid') {
            const result = await h.call('feed', input, quote.expected);
            assert.equal(result.completed, 1); assert.equal(result.partial, true);
            assert.equal(result.costs[0].count, '600');
        }
        else await assert.rejects(h.call('feed', input, quote.expected), error => error.resultState === 'unknown');
        assert.equal(h.calls.filter(row => row.method === 'FeedAnimal').length, 1);
    }
});

test('放生按栏舍绑定动物，同编号其他栏舍不会被误选', async () => {
    const h = ranchRuntimeHarness();
    const first = readyRanch(h, 1);
    first.animals[0].can_donate = true;
    const second = JSON.parse(JSON.stringify(first)); second.ranch_inst_id = 99;
    h.state.cells.facilities.push({ instance_id: 99, state: 1, ranch: second });
    const quote = await h.quote('release', { ranchId: 99, animalId: 1 });
    const signature = JSON.parse(quote.expected.signature);
    assert.equal(signature.payload.targets[0].ranch_inst_id, 99);
    await assert.rejects(h.quote('release', { animalId: 1 }), error => error.errorCode === 'RANCH_INVALID_ARGUMENT');
    assert.equal(h.calls.filter(row => row.method === 'DonateAnimal').length, 0);
});

test('好友零目标不发偷取/清理写，已发空结果与伪造新蚊ID保留unknown', async () => {
    const empty = ranchRuntimeHarness();
    const quote = await empty.quote('steal', { hostGid: 20001 });
    assert.equal((await empty.call('steal', { hostGid: 20001 }, quote.expected)).completed, 0);
    assert.equal(empty.calls.filter(row => row.method === 'StealProduce').length, 0);

    for (const action of ['steal', 'cleanFriend', 'putMosquito']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h, 1);
        ranch.shelves = [{ slot_index: 1, can_steal: true, lots: [{ item_id: 1060001, remain_num: 2, can_steal: true, stealers: [] }] }];
        ranch.hazards = [{ hazard_id: 501, hazard_type: 2, owner: 20001 }];
        const input = { hostGid: 20001, ranchId: 88 };
        const method = action === 'steal' ? 'StealProduce' : action === 'cleanFriend' ? 'CleanAllRanch' : 'PutHazard';
        h.handlers.set(method, async () => action === 'putMosquito'
            ? { actual_count: 1, remaining_times: 2, hazards: [{ hazard_id: 0, owner: 10010, hazard_type: 1 }] }
            : { ranches: [ranch], op_results: [] });
        const offer = await h.quote(action, input);
        await assert.rejects(h.call(action, input, offer.expected), error => error.resultState === 'unknown');
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 1);
        assert.equal(h.calls.filter(row => row.method === method).length, 1);
    }
});

test('好友四种写的正向真实protobuf回包均核验目标、数量与剩余次数', async () => {
    for (const action of ['steal', 'cleanFriend', 'stroke', 'putMosquito']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h, 1);
        ranch.animals[0].mutation = { strokable: true, stroked_gids: [] };
        ranch.shelves = [{ slot_index: 1, can_steal: true, lots: [{ item_id: 1060001, remain_num: 2, can_steal: true, stealers: [] }] }];
        ranch.hazards = [{ hazard_id: 501, hazard_type: 2, owner: 20001 }];
        const next = JSON.parse(JSON.stringify(ranch));
        const input = { hostGid: 20001, ranchId: 88, animalId: 1 };
        const method = action === 'steal' ? 'StealProduce' : action === 'cleanFriend' ? 'CleanAllRanch'
            : action === 'stroke' ? 'StrokeAnimal' : 'PutHazard';
        h.handlers.set(method, async () => {
            if (action === 'steal') return { ranches: [next], op_results: [{ facility_inst_id: 88, kind: 2, target_id: 1, rewards: [{ id: 1060001, count: 1 }] }] };
            if (action === 'cleanFriend') {
                next.hazards = [];
                return { ranches: [next], op_results: [{ facility_inst_id: 88, kind: 3, target_id: 501, rewards: [] }] };
            }
            if (action === 'stroke') {
                next.animals[0].mutation = { strokable: false, stroked_gids: [10010], mutation_type: 1 };
                return { ranches: [next], op_result: { facility_inst_id: 88, kind: 1, target_id: 1, rewards: [] }, triggered: true, remaining_times: 1 };
            }
            return { actual_count: 1, remaining_times: 2, hazards: [...next.hazards, { hazard_id: 502, hazard_type: 1, owner: 10010 }], rewards: [] };
        });
        const quote = await h.quote(action, input);
        const result = await h.call(action, input, quote.expected);
        assert.equal(result.status, 'confirmed'); assert.equal(result.completed, 1);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        assert.equal(h.calls.filter(row => row.method === method).length, 1);
        assert.equal(h.calls.at(-1).input.global_scene_id, 1);
    }
});

test('抚摸未扣正确次数或未出现本人GID时保持unknown，生产零奖励须有真实状态变化', async () => {
    for (const mode of ['bad_remaining', 'not_stroked']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h, 1); ranch.animals[0].mutation = { strokable: true, stroked_gids: [] };
        const next = JSON.parse(JSON.stringify(ranch));
        if (mode !== 'not_stroked') next.animals[0].mutation.stroked_gids = [10010];
        h.handlers.set('StrokeAnimal', async () => ({ ranches: [next], remaining_times: mode === 'bad_remaining' ? 2 : 1,
            op_result: { facility_inst_id: 88, kind: 1, target_id: 1, rewards: [] } }));
        const input = { hostGid: 20001, ranchId: 88, animalId: 1 };
        const quote = await h.quote('stroke', input);
        await assert.rejects(h.call('stroke', input, quote.expected), error => error.resultState === 'unknown');
    }
    const h = ranchRuntimeHarness();
    const ranch = readyRanch(h, 1);
    const next = JSON.parse(JSON.stringify(ranch));
    next.animals[0].can_deliver = false; next.animals[0].producing = true;
    h.handlers.set('TriggerProduce', async () => ({ ranches: [next], op_results: [{ facility_inst_id: 88, kind: 1, target_id: 1, rewards: [] }] }));
    const quote = await h.quote('produce', { all: true });
    assert.equal((await h.call('produce', { all: true }, quote.expected)).completed, 1);
});

function canStock(h, count = 3, uid = '9223372036854775701') {
    h.state.bag.physical_items = [{ id: 80021, uid, count, is_locked: false }];
    h.state.bag.virtual_items = [{ id: 7003, count: 100 }, { id: 1102, count: 300 }, { id: 1007, count: 100 }];
    return uid;
}

test('4A罐头按64位UID入桶：全量/部分消费核库存和秒数，错批次或错时长未知', async () => {
    for (const mode of ['valid', 'partial', 'wrong_seconds', 'wrong_uid']) {
        const h = ranchRuntimeHarness();
        const uid = canStock(h);
        h.handlers.set('Use', async () => {
            const used = mode === 'partial' ? 1 : 2;
            h.state.bag.physical_items[0].count = 3 - used;
            h.state.bag.virtual_items[0].count = 100 + (mode === 'wrong_seconds' ? 2 : used * 3600);
            return { item: { id: 80021, uid: mode === 'wrong_uid' ? '9999' : uid, count: 0 }, get_items: [] };
        });
        const input = { uid, count: 2 };
        const quote = await h.quote('useCan', input);
        if (mode === 'valid' || mode === 'partial') {
            const result = await h.call('useCan', input, quote.expected);
            assert.equal(result.completed, mode === 'partial' ? 1 : 2);
            assert.equal(result.partial, mode === 'partial');
        }
        else await assert.rejects(h.call('useCan', input, quote.expected), error => error.resultState === 'unknown');
        assert.equal(h.calls.find(row => row.method === 'Use').input.item.uid, uid, 'UID不得经Number舍入');
        assert.equal(h.calls.filter(row => row.method === 'Use').length, 1);
    }
    const locked = ranchRuntimeHarness();
    const uid = canStock(locked); locked.state.bag.physical_items[0].is_locked = true;
    await assert.rejects(locked.quote('useCan', { uid, count: 1 }), error => error.errorCode === 'RANCH_CAN_UNAVAILABLE');
    assert.equal(locked.calls.filter(row => row.method === 'Use').length, 0);
});

test('4A放养普通/巨大幼崽：只发一次PlaceAnimal，部分结果按实际库存和新增动物核验', async () => {
    for (const mode of ['normal', 'partial', 'giant', 'wrong_animal', 'wrong_giant']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h, 0);
        const itemId = ['giant', 'wrong_giant'].includes(mode) ? 65002 : 60001;
        const animalId = itemId === 65002 ? 60002 : 60001;
        h.state.bag.physical_items = [{ id: itemId, uid: '9007199254740997', count: 2, is_locked: false }];
        h.handlers.set('PlaceAnimal', async input => {
            const done = mode === 'partial' ? 1 : 2;
            ranch.animals = Array.from({ length: done }, (_, index) => ({ animal_inst_id: 7 + index,
                animal_id: mode === 'wrong_animal' ? 60002 : animalId, stage: 1,
                mutation: mode === 'giant' ? { mutation_type: 1 } : undefined }));
            ranch.animal_count = done;
            h.state.bag.physical_items[0].count = 2 - done;
            assert.equal(Number(input.items[0].giant_cub_item_id) || 0, itemId === 65002 ? 65002 : 0);
            return { ranches: [ranch], op_results: ranch.animals.map(animal => ({ facility_inst_id: 88, kind: 1,
                target_id: animal.animal_inst_id, costs: [{ id: itemId, count: 1 }], rewards: [] })) };
        });
        const input = { ranchId: 88, itemId, count: 2 };
        const quote = await h.quote('place', input);
        if (mode === 'wrong_animal' || mode === 'wrong_giant') await assert.rejects(h.call('place', input, quote.expected), error => error.resultState === 'unknown');
        else assert.equal((await h.call('place', input, quote.expected)).completed, mode === 'partial' ? 1 : 2);
        assert.equal(h.calls.filter(row => row.method === 'PlaceAnimal').length, 1);
    }
});

test('4A罐头商城：付费/免费核奖励和扣费，钻石专用余额不拿scene2背包猜', async () => {
    for (const mode of ['coin', 'free', 'diamond', 'wrong_debit', 'unknown_currency']) {
        const h = ranchRuntimeHarness();
        h.state.bag.virtual_items = [{ id: 1007, count: 100 }, { id: 1004, count: 99999 }];
        let diamond = 100;
        const currencyId = mode === 'unknown_currency' ? 99999 : mode === 'diamond' || mode === 'wrong_debit' ? 1004 : 1007;
        const free = mode === 'free';
        h.handlers.set('GetRechargeInfo', async input => { assert.equal(input.source, 'MallUI'); return { recharge_infos: [{ balance: diamond }] }; });
        h.handlers.set('GetMallListBySlotType', async input => {
            assert.equal(input.global_scene_id, 2);
            return { goods_list: [{ goods_id: 90001, name: '罐头补给', reward_items: [{ id: 80021, count: 1 }],
                price: { id: currencyId, count: free ? 0 : 6 }, is_free: free, is_available: true,
                purchase_limit: { limit_type: 1, limit_count: 5, bought_count: 0 } }] };
        });
        h.handlers.set('Purchase', async input => {
            if (!free) {
                if (currencyId === 1004) diamond -= mode === 'wrong_debit' ? 7 : 6;
                else h.state.bag.virtual_items[0].count -= 6;
            }
            h.state.bag.physical_items = [{ id: 80021, uid: '9007199254740997', count: 1 }];
            return { goods_id: input.goods_id, success: true, reward_items: [{ id: 80021, count: 1 }] };
        });
        const input = { slotType: 6, goodsId: '90001', count: 1 };
        if (mode === 'unknown_currency') {
            await assert.rejects(h.quote('buyCan', input), error => error.errorCode === 'GOODS_UNAVAILABLE');
            assert.equal(h.calls.filter(row => row.method === 'Purchase').length, 0);
            continue;
        }
        const quote = await h.quote('buyCan', input);
        if (mode === 'wrong_debit') await assert.rejects(h.call('buyCan', input, quote.expected), error => error.resultState === 'unknown');
        else assert.equal((await h.call('buyCan', input, quote.expected)).completed, 1);
        if (currencyId === 1004) assert.equal(h.calls.filter(row => row.method === 'GetRechargeInfo').length, 3);
        assert.equal(h.calls.filter(row => row.method === 'Purchase').length, 1);
    }
});

test('4A背包只读与报价身份：金券余额取1007且精确保留，旧IPC/worker报价拒绝，错账号零RPC', async () => {
    const h = ranchRuntimeHarness(); const uid = canStock(h);
    h.state.bag.virtual_items.find(row => String(row.id) === '1007').count = '987654321012345678';
    const bag = await h.services['ranch-manual'].getRanchBag('10');
    assert.equal(bag.level.level, 2); assert.equal(bag.items[0].uid, uid); assert.equal(bag.items[0].can.seconds, 3600);
    assert.equal(bag.goldVoucherBalance, '987654321012345678');
    const input = { uid, count: 1 };
    const quote = await h.quote('useCan', input);
    h.diagnostic.connectionEpoch = 8;
    await assert.rejects(h.call('useCan', input, quote.expected), error => error.errorCode === 'RANCH_OFFER_CHANGED');
    assert.equal(h.calls.filter(row => row.method === 'Use').length, 0);
    const other = ranchRuntimeHarness(); canStock(other);
    await assert.rejects(other.call('useCan', input, quote.expected), error => error.errorCode === 'RANCH_OFFER_CHANGED');
    assert.equal(other.calls.filter(row => row.method === 'Use').length, 0);
    const before = h.calls.length;
    await assert.rejects(h.services['ranch-manual'].quoteRanchAction('wrong', 'useCan', input), error => error.errorCode === 'ACCOUNT_OPERATION_CHANGED');
    assert.equal(h.calls.length, before);
});

test('4A发起升级：牧场1102等级/固定费用/服务端详情一致，错目标或扣费未知', async () => {
    for (const mode of ['valid', 'low_level', 'unknown_level', 'bad_price', 'wrong_target', 'wrong_debit']) {
        const h = ranchRuntimeHarness();
        const ranch = readyRanch(h, 0);
        const facility = h.state.cells.facilities[0];
        facility.capacity = 3; facility.upgrade_state = 0; ranch.capacity = 3;
        h.state.bag.virtual_items = [{ id: 1007, count: 20000 }];
        if (mode !== 'unknown_level') h.state.bag.virtual_items.push({ id: 1102, count: mode === 'low_level' ? 5300 : 7500 });
        h.handlers.set('GetFacilityDetail', async input => ({ info: { instance_id: input.instance_id, facility_id: 6001001,
            base_facility_id: 6001001, module_type: 6, level: 1, position_x: 9, position_y: 10,
            upgrade_cost: [{ id: 1007, count: mode === 'bad_price' ? 1 : 14000 }] } }));
        h.handlers.set('UpgradeBuilding', async input => {
            facility.upgrade_state = 1;
            facility.upgrade_end_time = Date.now() + 10000;
            h.state.bag.virtual_items[0].count -= mode === 'wrong_debit' ? 100 : 14000;
            return { upgrade: { inst_id: input.inst_id, state: 1, end_time: facility.upgrade_end_time,
                target_facility_id: mode === 'wrong_target' ? 6002002 : 6001002, target_level: 2 } };
        });
        const quote = await h.quote('upgrade', { facilityId: 88 });
        if (['low_level', 'unknown_level', 'bad_price'].includes(mode)) {
            assert.equal(quote.skipped, true);
            assert.equal(h.calls.filter(row => row.method === 'UpgradeBuilding').length, 0);
        }
        else if (mode === 'valid') {
            const result = await h.call('upgrade', { facilityId: 88 }, quote.expected);
            assert.equal(result.completed, 1); assert.equal(result.costs[0].count, '14000');
        }
        else await assert.rejects(h.call('upgrade', { facilityId: 88 }, quote.expected), error => error.resultState === 'unknown');
    }
});

test('4A完成升级仅确认精确下一设施/等级，其他设施DTO也提供有效报价描述', async () => {
    for (const valid of [true, false]) {
        const h = ranchRuntimeHarness();
        readyRanch(h, 0);
        const facility = h.state.cells.facilities[0]; facility.upgrade_state = 2;
        h.handlers.set('CompleteBuildingUpgrade', async () => ({ facility: { instance_id: 88,
            facility_id: valid ? 6001002 : 6001003, module_type: 6, state: 1, level: 2, upgrade_state: 0,
            ranch: { ranch_inst_id: 88, husbandry_type: 1, capacity: 4, animals: [], animal_count: 0 } } }));
        const quote = await h.quote('completeUpgrade', { facilityId: 88 });
        if (valid) assert.equal((await h.call('completeUpgrade', { facilityId: 88 }, quote.expected)).completed, 1);
        else await assert.rejects(h.call('completeUpgrade', { facilityId: 88 }, quote.expected), error => error.resultState === 'unknown');
        assert.equal(h.calls.filter(row => row.method === 'CompleteBuildingUpgrade').length, 1);
    }
    const dto = require('../src/services/ranch-readonly').facilityDto({ instance_id: 88, facility_id: 6001001, module_type: 6, level: 1, state: 1, upgrade_state: 0 });
    assert.equal(dto.nextUpgrade.level, 2); assert.equal(dto.nextUpgrade.requiredLevel, 8);
});

function ledgerHarness() {
    const files = new Map();
    const { createRanchOperations } = require('../src/services/ranch-operations-ledger');
    const ledger = createRanchOperations({
        loadFile: accountId => `memory:/ranch-operations/${accountId}.json`,
        readFile: (file) => {
            const raw = files.get(file);
            return raw ? JSON.parse(raw) : [];
        },
        writeFile: (file, records) => files.set(file, JSON.stringify(records)),
    });
    return { ledger, files };
}

test('在途账本没有人工确认接口，且不能清内存；返回副本不能改资源预留', async () => {
    const { ledger } = ledgerHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const run = ledger.spend('10', { target: 'ranch:buy:10001', label: '购买', costs: [{ resourceKey: 'item:1007', amount: '300' }] }, async life => {
        life.markSent(); await held; return 'confirmed';
    });
    const record = ledger.pending('10')[0];
    assert.equal(typeof ledger.acknowledge, 'undefined', '人工提前确认能力不存在');
    assert.throws(() => ledger.clearMemoryForTests(), error => error.errorCode === 'RANCH_OPERATION_BUSY');
    record.costs[0].amount = '0';
    assert.equal(ledger.reserved('10', 'item:1007'), 300n);
    release(); await run;
    assert.equal(ledger.pending('10').length, 0);
});

test('当前牧场任务接口快照自动结算旧任务记录，按claimed/canClaim直接展示服务端状态', async () => {
    const { ledger, files } = ledgerHarness();
    for (const target of ['ranch:claimTasks:400001', 'ranch:claimTasks:300011', 'ranch:claimTasks:all']) {
        await assert.rejects(ledger.spend('1', { target, label: '普通领取牧场任务', costs: [] }, async life => {
            life.markSent(); throw Object.assign(new Error('历史回包状态未知'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
        }), error => error.resultState === 'unknown');
    }
    assert.equal(ledger.pending('1').length, 3);
    const snapshot = ledger.reconcileTaskClaims('1', [
        { id: '400001', claimed: false, canClaim: true, progress: '1', total: '1' },
        { id: '400002', claimed: true, canClaim: false, progress: '1', total: '1' },
    ], { dateKey: '2026-11-24', observedAt: 1795545600000 });
    assert.equal(snapshot.resolvedCount, 3);
    assert.equal(ledger.pending('1').length, 0, '读取成功的任务接口状态自动替代历史人工确认');
    const saved = JSON.parse(files.get('memory:/ranch-operations/1.json'));
    assert.equal(saved.length, 3, '保留未知操作原记录作审计');
    assert.ok(saved.every(row => row.resolution?.kind === 'authoritative_task_snapshot'));
    assert.equal(saved.find(row => row.target === 'ranch:claimTasks:400001').resolution.observation.canClaim, true);
    await ledger.spend('1', { target: 'ranch:claimTasks:400001', label: '完成1次生产', costs: [] }, async () => 'confirmed');
    assert.equal(ledger.pending('1').length, 0);
    await assert.rejects(Promise.resolve().then(() => ledger.reconcileTaskClaims('1', [], { dateKey: '2026-11-24' })),
        error => error.errorCode === 'RANCH_TASK_SNAPSHOT_INVALID');
});

test('unknown待核对账本按target/资源精确互锁，不阻止无关购买', async () => {
    const { ledger } = ledgerHarness();
    await assert.rejects(ledger.spend('10', { target: 'ranch:claimTasks:300011', label: '成长任务领取', costs: [] }, async life => {
        life.markSent(); throw Object.assign(new Error('outcome unknown'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
    }), error => error.resultState === 'unknown');
    await assert.rejects(ledger.spend('10', { target: 'ranch:buy:10002', label: '旧金券购买',
        costs: [{ resourceKey: 'item:1007', amount: '30' }] }, async life => {
        life.markSent(); throw Object.assign(new Error('outcome unknown'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
    }), error => error.resultState === 'unknown');
    let unrelated = false;
    await ledger.spend('10', { target: 'ranch:buy:10003', label: '购买幼崽',
        costs: [{ resourceKey: 'item:1005', amount: '10' }] }, async () => { unrelated = true; return 'confirmed'; });
    assert.equal(unrelated, true, '零成本任务未知不阻止不同货币购买');
    let conflicted = false;
    await assert.rejects(ledger.spend('10', { target: 'ranch:buy:10004', label: '购买饲料',
        costs: [{ resourceKey: 'item:1007', amount: '20' }] }, async () => { conflicted = true; }),
    error => error.errorCode === 'RANCH_PENDING_RESOURCE_CONFLICT' && Boolean(error.conflictRecordId));
    assert.equal(conflicted, false, '相同金券余额仍被原子预留门禁保护');
    let same = false;
    await assert.rejects(ledger.spend('10', { target: 'ranch:claimTasks:300011', label: '重复任务领取', costs: [] }, async () => { same = true; }),
        error => error.errorCode === 'RANCH_PENDING_CONFIRMATION');
    assert.equal(same, false);
    assert.equal(ledger.pending('10').length, 2, '未核对任务与金券购买记录都仍保留');
});

test('游戏回包确认后提交账本失败仍为unknown，不冒称未发送或丢旧pending', async () => {
    let saves = 0;
    const files = new Map();
    const { createRanchOperations } = require('../src/services/ranch-operations-ledger');
    const ledger = createRanchOperations({
        loadFile: id => id,
        readFile: file => files.has(file) ? JSON.parse(files.get(file)) : [],
        writeFile: (file, rows) => {
            saves++;
            if (saves === 2) throw new Error('simulated ENOSPC');
            files.set(file, JSON.stringify(rows));
        },
    });
    await assert.rejects(ledger.spend('10', { target: 'ranch:buy:10001', label: '购买', costs: [{ resourceKey: 'item:1007', amount: '60' }] }, async life => {
        life.markSent(); return { status: 'confirmed', completed: 1 };
    }), error => error.errorCode === 'RANCH_LEDGER_COMMIT_UNKNOWN' && error.sent === true
        && error.resultState === 'unknown' && error.operationConfirmed === true);
    assert.equal(ledger.pending('10').length, 1);
    assert.equal(ledger.reserved('10', 'item:1007'), 60n);
    assert.equal(JSON.parse(files.get('10')).length, 1, '原pending仍在持久文件中');
    await assert.rejects(ledger.spend('10', { target: 'ranch:buy:10001', label: '购买', costs: [] }, async () => 'never'), error => error.errorCode === 'RANCH_PENDING_CONFIRMATION');
});

test('无效费用不能被过滤成免费写；既有坏记录保守闭锁', async () => {
    const { ledger, files } = ledgerHarness();
    let executed = false;
    await assert.rejects(ledger.spend('10', { target: 'ranch:buy:10001', label: '购买', costs: [{ id: 1007, count: 60 }] }, async () => { executed = true; }), error => error.errorCode === 'RANCH_LEDGER_COST_INVALID');
    assert.equal(executed, false); assert.equal(files.size, 0);
});

test('持久账本：写成功解除pending，明确失败自动解除，超时保留unknown', async () => {
    const { ledger, files } = ledgerHarness();
    await ledger.spend('10', { target: 'ranch:harvest:all', label: '收获', costs: [] }, async () => 'ok');
    assert.equal(ledger.pending('10').length, 0, '成功后不得残留pending');
    await assert.rejects(ledger.spend('10', { target: 'ranch:clean:all', label: '清理', costs: [] }, async () => {
        throw Object.assign(new Error('服务端拒绝'), { sent: true, resultState: 'failed', outcomeUnknown: false });
    }));
    assert.equal(ledger.pending('10').length, 0, '明确失败不算unknown，账本应自动解除');
    await assert.rejects(ledger.spend('10', { target: 'ranch:feed:all', label: '喂养', costs: [{ resourceKey: 'item:7003', amount: '5' }] }, async () => {
        throw Object.assign(new Error('网关请求超时'), { sent: true, resultState: 'unknown', outcomeUnknown: true });
    }));
    const pending = ledger.pending('10');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].target, 'ranch:feed:all');
    assert.equal(pending[0].costs[0].resourceKey, 'item:7003');
    assert.equal(files.size, 1, 'pending必须已落盘');
    // 同target新写被拦截且未发送
    await assert.rejects(
        ledger.spend('10', { target: 'ranch:feed:all', label: '喂养', costs: [] }, async () => 'never'),
        error => error.errorCode === 'RANCH_PENDING_CONFIRMATION' && error.sent === false,
    );
    assert.equal(typeof ledger.acknowledge, 'undefined', '未知写没有人工释放接口');
    assert.equal(ledger.pending('10').length, 1, '未知写由服务端证据解除，不能由用户确认');
    assert.equal(ledger.reserved('10', 'item:7003'), 5n);
});

test('账本预留计入余额检查，事务悬挂期间reserved可见', async () => {
    const { ledger } = ledgerHarness();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const operation = ledger.spend('2', { target: 'ranch:buy:5', label: '购买', costs: [{ resourceKey: 'item:1007', amount: '300' }] }, () => held);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ledger.reserved('2', 'item:1007'), 300n);
    assert.ok(ledger.pending('2').some(row => row.target === 'ranch:buy:5'));
    release();
    await operation;
    assert.equal(ledger.reserved('2', 'item:1007'), 0n, '成功结算后预留必须释放');
});

test('场景诊断HTTP仅可读本人获授权账号且不缓存，也不调用牧场写接口', async () => {
    const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
    const handlers = new Map();
    let accessible = false, requests = 0;
    registerAdminRanchRoutes({
        app: { get: (path, fn) => handlers.set(path, fn), post: () => {} },
        provider: { getRanchSceneAccessInfo: async id => { requests++; assert.equal(id, '10'); return { activeSceneId: 1 }; } },
        getAccountIdFromRequest: () => '10', canAccessAccount: () => accessible,
        sendProviderError: (_res, error) => { throw error; },
    });
    const res = { code: 200, status(code) { this.code = code; return this; },
        set(key, value) { this[key] = value; }, json(value) { this.body = value; } };
    await handlers.get('/api/ranch/scene-access')({}, res);
    assert.equal(res.code, 403);
    assert.equal(requests, 0);
    accessible = true;
    await handlers.get('/api/ranch/scene-access')({}, res);
    assert.equal(requests, 1);
    assert.equal(res['Cache-Control'], 'no-store');
    assert.equal(res.body.accountId, '10');
});

test('全局登录升级POST仅微信本人明确确认及匹配会话可进入provider', async () => {
    const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
    const handlers = new Map();
    let accountId = '10', allowed = true, calls = 0;
    const expected = { accountId: '2', gid: 1234, connectionEpoch: 2,
        remoteGeneration: '3', remoteGenerationSource: 'gateway' };
    registerAdminRanchRoutes({
        app: { get: () => {}, post: (route, handler) => handlers.set(route, handler) },
        provider: { upgradeRanchGlobalLogin: async (id, scope) => {
            calls++; assert.equal(id, '2'); assert.deepEqual(scope, { actorId: 2, ...expected }); return { homeConfirmed: true };
        } },
        getAccountIdFromRequest: () => accountId, canAccessAccount: () => allowed,
        sendProviderError: (_res, error) => { throw error; },
    });
    const res = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
    const handler = handlers.get('/api/ranch/session/upgrade');
    let response = res();
    await handler({ body: { confirm: true, expected } }, response);
    assert.equal(response.code, 403); assert.equal(calls, 0);
    accountId = '2';
    for (const body of [{ expected }, { confirm: true, expected: { ...expected, accountId: '1' } },
        { confirm: true, expected: { ...expected, gid: '1234' } },
        { confirm: true, expected: { ...expected, remoteGenerationSource: 'process' } }]) {
        response = res(); await handler({ body }, response); assert.equal(response.code, 400); assert.equal(calls, 0);
    }
    allowed = false; response = res(); await handler({ body: { confirm: true, expected } }, response);
    assert.equal(response.code, 403); assert.equal(calls, 0);
    allowed = true; response = res(); await handler({ body: { confirm: true, expected } }, response);
    assert.equal(response.body.ok, true); assert.equal(calls, 1);
});

test('HTTP路由：好友动作进入统一白名单且expected签名仍强制', async () => {
    const { ALLOWED_RANCH_ACTIONS } = require('../src/controllers/admin-ranch-routes');
    for (const action of ['harvest', 'steal', 'cleanFriend', 'stroke', 'putMosquito']) {
        assert.equal(ALLOWED_RANCH_ACTIONS.has(action), true, action);
    }
    assert.equal(ALLOWED_RANCH_ACTIONS.has('useCan'), true, '4A入桶由写后库存和时长双重核验');
    assert.equal(ALLOWED_RANCH_ACTIONS.has('place'), true);
    assert.equal(ALLOWED_RANCH_ACTIONS.has('buyCan'), true);
    const handlers = new Map();
    const app = {
        get: (route, handler) => handlers.set(`GET ${route}`, handler),
        post: (route, handler) => handlers.set(`POST ${route}`, handler),
    };
    const { registerAdminRanchRoutes } = require('../src/controllers/admin-ranch-routes');
    registerAdminRanchRoutes({
        app,
        provider: {},
        getAccountIdFromRequest: () => '10',
        canAccessAccount: () => true,
        sendProviderError: (_res, error) => { throw error; },
    });
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await handlers.get('POST /api/ranch/operate')(
        { body: { action: 'steal', input: { hostGid: 12345 } } }, response,
    );
    assert.equal(response.statusCode, 400, '好友写同样必须先报价取得签名');
    response.statusCode = 200;
    await handlers.get('POST /api/ranch/operate')(
        { body: { action: 'unlockRegion', input: {}, expected: { signature: 'x' } } }, response,
    );
    assert.equal(response.statusCode, 400, '未开放动作必须拒绝');
    assert.deepEqual([...handlers.keys()].sort(), [
        'GET /api/ranch', 'GET /api/ranch/friend', 'GET /api/ranch/friends', 'GET /api/ranch/catalog', 'GET /api/ranch/bag', 'GET /api/ranch/cans',
        'GET /api/ranch/tasks', 'GET /api/ranch/book', 'GET /api/ranch/share', 'GET /api/ranch/market', 'GET /api/ranch/activities', 'GET /api/ranch/operations', 'GET /api/ranch/scene-access',
        'POST /api/ranch/activities/operate', 'POST /api/ranch/operate', 'POST /api/ranch/quote', 'POST /api/ranch/session/upgrade',
    ].sort());
});

function automationHarness(automation, behavior = {}) {
    const vm = require('node:vm');
    const sourceText = source('src/services/ranch-automation.js');
    let now = 1800000000000;
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const calls = { scene: 0, sceneLogins: 0, stateReads: 0, detailReads: 0, progressReads: [], plans: [], planInputs: [], writes: [], friendVisits: [], friendWrites: [], clears: 0, logs: [], warnings: [] };
    const rawTemplate = {
        cells: { facilities: [{ instance_id: 88, facility_id: 9001, upgrade_state: 0, upgrade_end_time: 0,
            ranch: { ranch_inst_id: 88, animals: [{ animal_inst_id: 1, animal_id: 60001, grow_ready_at_ms: now + 600000 }], shelves: [], hazards: [] } }] },
        bag: { physical_items: [], virtual_items: [], global_scene_id: 2 },
    };
    const clone = value => JSON.parse(JSON.stringify(value));
    const module_ = { exports: {} };
    const context = vm.createContext({
        module: module_, exports: module_.exports, process: { env: { FARM_ACCOUNT_ID: '10' } },
        Date: FakeDate, Math: Object.assign(Object.create(Math), { random: () => behavior.random ?? 0 }), Number, Infinity, BigInt, JSON, Error, console,
        require(id) {
            if (id === '../models/store') return {
                getAutomation: () => automation,
                getIntervals: id => { assert.equal(id, '10'); return behavior.intervals || { farmMin: 2, farmMax: 2 }; },
                getFriendBlacklist: id => { assert.equal(id, '10'); return behavior.blacklist || []; },
                getFriendBadTargets: id => { assert.equal(id, '10'); return behavior.badTargets || []; },
            };
            if (id === './friend-operation-limits') return { getCanGetHelpExp: () => behavior.helpExpAllowed !== false };
            if (id === '../utils/request-priority') return { requestError: (message, details) => Object.assign(new Error(message), details) };
            if (id === '../utils/utils') return {
                log: (tag, msg, meta) => calls.logs.push({ tag, msg, isWarn: false, meta: clone(meta) }),
                logWarn: (tag, msg, meta) => {
                    calls.warnings.push(msg);
                    calls.logs.push({ tag, msg, isWarn: true, meta: clone(meta) });
                },
            };
            if (id === './scene-session') return {
                RANCH_SCENE_ID: 2,
                withGameScene: async (_scene, work, options = {}) => {
                    calls.scene++;
                    if (behavior.beforeLease) await behavior.beforeLease();
                    const currentSession = { accountId: '10', gid: 10010, workerInstanceId: 'automation-fixture',
                        connectionEpoch: 7, remoteGeneration: '1', remoteGenerationSource: 'gateway',
                        ...behavior.session, context: { priority: 'background' } };
                    options.onStart?.(currentSession);
                    calls.sceneLogins++;
                    return work({ session: currentSession });
                },
            };
            if (id === './ranch-manual') return {
                findConflictingPendingOperation: (_account, action, input, plan) => {
                    calls.pendingChecks = (calls.pendingChecks || 0) + 1;
                    if (typeof behavior.pendingConflict === 'function') return behavior.pendingConflict(action, input, plan);
                    const target = action === 'feed' ? 'ranch:feed:all'
                        : action === 'clean' ? 'ranch:clean:all'
                            : action === 'harvest' ? 'ranch:harvest:all'
                                : action === 'place' ? 'ranch:place:all' : '';
                    const pending = behavior.pending || [];
                    const requested = new Map();
                    for (const item of plan?.costItems || []) {
                        const key = `item:${item.id}`;
                        requested.set(key, (requested.get(key) || 0n) + BigInt(item.count));
                    }
                    const reserves = new Map();
                    for (const row of pending) for (const cost of row.costs || [])
                        reserves.set(cost.resourceKey, (reserves.get(cost.resourceKey) || 0n) + BigInt(cost.amount));
                    const resourceConflict = [...requested].some(([key, amount]) => {
                        const available = plan?.availableResources?.[key];
                        return pending.some(row => (row.costs || []).some(cost => cost.resourceKey === key))
                            && (available == null || (reserves.get(key) || 0n) + amount > BigInt(available));
                    });
                    return pending.find(record => record.target === target) || (resourceConflict ? pending.find(record =>
                        (record.costs || []).some(cost => requested.has(cost.resourceKey))) : null);
                },
                selectAutoCubPurchase: async (_raw, count) => {
                    calls.cubSelections = (calls.cubSelections || 0) + 1;
                    await behavior.onCubSelect?.();
                    return behavior.cubOffer === false ? null : { shopId: 5, goodsId: 10003, count: Math.min(3, count), autoPlace: true };
                },
                assertAutoCubPlan: () => { calls.cubPolicyChecks = (calls.cubPolicyChecks || 0) + 1; },
                attachAvailableResources: (plan, raw) => {
                    plan.availableResources = Object.fromEntries((plan.costItems || []).map(item => {
                        const rows = [...(raw.bag?.physical_items || []), ...(raw.bag?.virtual_items || [])]
                            .filter(row => String(row.id) === String(item.id));
                        const available = rows.reduce((sum, row) => sum + BigInt(String(row.count || '0'))
                            - (row.is_locked === true ? BigInt(String(row.count || '0')) : 0n), 0n);
                        return [`item:${item.id}`, available.toString()];
                    }));
                    return plan;
                },
                loadSceneState: async () => {
                    calls.stateReads++; now += Number(behavior.advanceAfterStateRead || 0);
                    return clone(behavior.raw || rawTemplate);
                },
                loadRanchDetail: async () => { calls.detailReads++; return { interval: 60, ranches: [] }; },
                mergeRanchDetails: (raw, detail) => ({ ...raw, serverIntervalSec: Number(detail.interval) }),
                planAction: async (action, input, raw) => {
                    calls.plans.push(action);
                    calls.planInputs.push({ action, input: clone(input) });
                    if (behavior.onPlan) await behavior.onPlan(action, input);
                    now += Number(behavior.advanceAfterPlan?.[action] || 0);
                    return { action, label: action, payload: input,
                        costItems: behavior.planCosts?.[action] || (action === 'feed' && behavior.feedBucketId
                            ? [{ id: String(behavior.feedBucketId), count: '3600' }] : []),
                        expectedRewards: [], marker: {}, count: behavior.planCount ?? 1, raw };
                },
                executePreparedPlan: async (_account, action, _input, _plan, raw, _session, options = {}) => {
                    await behavior.beforeSend?.(action, _input);
                    options.assertCanSend?.();
                    calls.writes.push(action);
                    if (behavior.onWrite) await behavior.onWrite(action, raw);
                    if (behavior.advanceAfterWrite) now += behavior.advanceAfterWrite;
                    if (behavior.unknownAction === action) throw Object.assign(new Error('unknown write'), { resultState: 'unknown', outcomeUnknown: true });
                if (action === 'reportDailyShare' && behavior.shareReportSucceeded !== false) {
                    raw.shareView = { ...(raw.shareView || {}), canReport: false, canClaim: true,
                        shared: true, shareCount: String(BigInt(raw.shareView?.shareCount || '0') + 1n) };
                    behavior.shareCanReport = false;
                    behavior.shareCanClaim = true;
                }
                    if (action === 'claimDailyShare') raw.shareView = { ...(raw.shareView || {}), canClaim: false, claimed: true };
                    return { raw, result: { completed: 1 } };
                },
            };
            if (id === './ranch-config') return { findRanchGoods: () => ({ id: 10001 }),
                getRanchAnimalByCubItem: itemId => behavior.cubs?.[itemId], getRanchCan: itemId => behavior.cans?.[itemId] };
            if (id === './ranch-progression') return { loadProgressActionState: async (_session, action) => {
                calls.progressReads.push(action);
                if (action === 'share' && behavior.failShareBusy) throw Object.assign(
                    new Error('gamepb.userpb.UserService.BatchGetBasicInfo 错误: code=1020001 网络繁忙，请稍候再试'),
                    { errorCode: 1020001, stage: 'remote', resultState: 'failed' });
                return action === 'share' ? { shareView: { canReport: behavior.shareCanReport === true,
                    canClaim: behavior.shareCanClaim === true, shareCount: behavior.shareCount || '0' } }
                    : { tasksView: { tasks: behavior.progressTasks || [] } };
            } };
            if (id === './ranch-readonly') return { clearRanchReadCache: () => { calls.clears++; } };
            if (id === './ranch-operations-ledger') return { ranchOperations: { pending: () => behavior.pending || [],
                reserved: (_accountId, resourceKey) => BigInt(behavior.reservedByResource?.[resourceKey] ?? behavior.reserved ?? 0),
        pending: () => behavior.pending || [] } };
            if (id === './friend-land-analyzer') return { getFriendsList: async () => behavior.friends || [] };
            if (id === './friend-api') return {
                inFriendQuietHours: gid => (behavior.quietGids || []).includes(Number(gid)),
                SYSTEM_NPC_GIDS: new Set([10001]),
            };
            if (id === './ranch-friends') return {
                getInteractionQuotaResetAt: action => behavior.exhausted?.includes(action) ? now + 60000 : 0,
                loadRanchFriendRoster: async () => {
                    await behavior.onRosterRead?.();
                    return { observedAt: now, friends: behavior.friends || [] };
                },
                nextAutomationFriend: friends => friends[0] || null,
                automateRanchFriend: async (_session, _accountId, friend, enabled, shouldYield, progress, onOutcome) => {
                    calls.friendVisits.push(Number(friend.gid));
                    await behavior.onFriendEnter?.();
                    const results = [];
                    for (const action of ['steal', 'cleanFriend', 'stroke', 'putMosquito']) {
                        if (progress[action] || !enabled(action)) continue;
                        const result = { action, label: action, status: 'confirmed', completed: 1 };
                        calls.friendWrites.push([Number(friend.gid), action]);
                        results.push(result);
                        progress[action] = true;
                        onOutcome(result, friend.name);
                        if (await behavior.onFriendWrite?.(action)) return { results, yielded: true, friend };
                    }
                    return { results, yielded: shouldYield(), friend };
                },
                clearRanchFriendCache: () => { calls.clears++; },
            };
            throw new Error(`禁止真实 require: ${id}`);
        },
    });
    vm.runInContext(sourceText, context, { filename: 'ranch-automation.js' });
    return { api: module_.exports, calls, now: () => now, advance: ms => { now += ms; } };
}

test('自动购买补栏默认不买、需库存补栏关联开关、报价后关开关不发，unknown停轮', async () => {
    for (const mode of ['off', 'place-off', 'normal', 'disable-after-select', 'unknown']) {
        const auto = { ranch: true, ranch_place: mode !== 'place-off', ranch_cub_buy: mode !== 'off' };
        const behavior = { unknownAction: mode === 'unknown' ? 'buy' : undefined,
            onCubSelect: () => { if (mode === 'disable-after-select') auto.ranch_place = false; } };
        const h = automationHarness(auto, behavior);
        if (mode === 'unknown') await assert.rejects(h.api.run(), e => e.outcomeUnknown === true);
        else await h.api.run();
        assert.deepEqual(h.calls.writes, ['normal', 'unknown'].includes(mode) ? ['buy'] : [], mode);
        assert.equal(h.calls.cubPolicyChecks || 0, ['normal', 'unknown'].includes(mode) ? 1 : 0, mode);
        if (mode === 'unknown') assert.equal(h.api.getRoutineState().lastResult, 'unknown');
    }
});

test('现有自动升级开关：启用时发起下一等级升级，同一时间最多一个并继续完成到期升级', async () => {
    const facilities = [
        { instance_id: 88, facility_id: 9001, module_type: 6, level: 1, state: 1, upgrade_state: 0, upgrade_end_time: 0 },
        { instance_id: 89, facility_id: 9011, module_type: 7, level: 1, state: 1, upgrade_state: 0, upgrade_end_time: 0 },
    ];
    const raw = { cells: { facilities }, bag: { physical_items: [], virtual_items: [] } };
    const enabled = automationHarness({ ranch: true, ranch_complete_upgrade: true }, { raw, planCount: 1 });
    await enabled.api.run();
    assert.deepEqual(enabled.calls.plans, ['upgrade']);
    assert.deepEqual(enabled.calls.writes, ['upgrade'], '同一轮只启动一项，不并行消耗多个设施升级费用');

    const blocked = automationHarness({ ranch: true, ranch_complete_upgrade: true }, { raw: { cells: { facilities: [
        { instance_id: 88, facility_id: 9001, module_type: 6, level: 1, state: 1, upgrade_state: 1, upgrade_end_time: 1800003600 },
        facilities[1],
    ] }, bag: { physical_items: [], virtual_items: [] } }, planCount: 1 });
    await blocked.api.run();
    assert.deepEqual(blocked.calls.writes, [], '已有升级进行中时不再启动另一项');
    const pendingEnd = automationHarness({ ranch: true, ranch_complete_upgrade: true }, { raw: { cells: { facilities: [
        { instance_id: 88, facility_id: 9001, module_type: 6, level: 1, state: 1, upgrade_state: 0, upgrade_end_time: 1800003600 },
        facilities[1],
    ] }, bag: { physical_items: [], virtual_items: [] } }, planCount: 1 });
    await pendingEnd.api.run();
    assert.deepEqual(pendingEnd.calls.writes, [], '状态值暂为0但未来结束时间未到时也不重复发起');

    const due = automationHarness({ ranch: true, ranch_complete_upgrade: true }, { raw: { cells: { facilities: [
        { instance_id: 88, facility_id: 9001, module_type: 6, level: 1, state: 1, upgrade_state: 2, upgrade_end_time: 0 },
        facilities[1],
    ] }, bag: { physical_items: [], virtual_items: [] } }, planCount: 1 });
    await due.api.run();
    assert.deepEqual(due.calls.plans, ['completeUpgrade']);
    assert.deepEqual(due.calls.writes, ['completeUpgrade'], '先完成现有到期升级；本轮不再叠加新开工');

    const off = automationHarness({ ranch: true }, { raw, planCount: 1 });
    await off.api.run();
    assert.deepEqual(off.calls.writes, [], '原有升级开关关闭时不得发起或完成升级');
});

test('上游缺失自动化：成长任务普通领奖、空桶补罐与已分享礼包安全接入', async () => {
    const canRaw = { cells: { facilities: [] }, bag: {
        physical_items: [
            { id: 80022, uid: '9002', count: '3', is_locked: false },
            { id: 80021, uid: '9001', count: '2', is_locked: false },
            { id: 80031, uid: '9003', count: '1', is_locked: false },
            { id: 80032, uid: '9004', count: '8', is_locked: true },
        ], virtual_items: [{ id: 7003, count: '0' }, { id: 7004, count: '120' }],
    } };
    const autoFill = automationHarness({ ranch: true, ranch_fill_cans: true }, { raw: canRaw, cans: {
        80021: { bucketId: 7003, speed_up_secs: 3600 }, 80022: { bucketId: 7003, speed_up_secs: 14400 },
        80031: { bucketId: 7004, speed_up_secs: 3600 }, 80032: { bucketId: 7004, speed_up_secs: 14400 },
    } });
    await autoFill.api.run();
    assert.equal(autoFill.calls.writes.filter(action => action === 'useCan').length, 1,
        '只给空桶加一份最小罐头；非空有机桶及锁定批次保留');
    assert.deepEqual(autoFill.calls.plans, ['useCan']);
    const off = automationHarness({ ranch: true }, { raw: canRaw, cans: { 80021: { bucketId: 7003, speed_up_secs: 3600 } } });
    await off.api.run(); assert.deepEqual(off.calls.writes, []);

    const growth = automationHarness({ ranch: true, ranch_growth_tasks_claim: true }, { planCount: 1,
        progressTasks: [{ id: '300010', category: 'daily', canClaim: true }, { id: '400012', category: 'growth', canClaim: true }] });
    await growth.api.run();
    assert.deepEqual(growth.calls.writes, ['claimTasks']);
    assert.deepEqual(growth.calls.planInputs, [{ action: 'claimTasks', input: { taskIds: ['400012'], double: false } }],
        '只普通领取配置确认的成长任务，不对每日任务和分享任务做混合写入');

    const noShare = automationHarness({ ranch: true, ranch_daily_share_claim: true }, { shareCanReport: false, shareCanClaim: false, planCount: 1 });
    await noShare.api.run(); assert.deepEqual(noShare.calls.writes, []);
    assert.deepEqual(noShare.calls.progressReads, ['share']);
    const share = automationHarness({ ranch: true, ranch_daily_share_claim: true }, { shareCanClaim: true, planCount: 1 });
    await share.api.run(); assert.deepEqual(share.calls.writes, ['claimDailyShare']);
    assert.deepEqual(share.calls.plans, ['claimDailyShare']);
    const automaticShare = automationHarness({ ranch: true, ranch_daily_share_claim: true }, {
        shareCanReport: true, shareCanClaim: false, shareCount: '0', planCount: 1,
    });
    await automaticShare.api.run();
    assert.deepEqual(automaticShare.calls.writes, ['reportDailyShare', 'claimDailyShare']);
    assert.deepEqual(automaticShare.calls.planInputs, [
        { action: 'reportDailyShare', input: { sharedInGame: true, automatic: true } },
        { action: 'claimDailyShare', input: {} },
    ]);
    assert.deepEqual(automaticShare.calls.progressReads, ['share'], '已确认canShare后按同场景RPC返回状态串联登记和领奖');
    const unknownReport = automationHarness({ ranch: true, ranch_daily_share_claim: true }, {
        shareCanReport: true, shareCanClaim: false, unknownAction: 'reportDailyShare', planCount: 1,
    });
    await assert.rejects(unknownReport.api.run(), error => error.resultState === 'unknown');
    assert.deepEqual(unknownReport.calls.writes, ['reportDailyShare'], '登记结果未知时不得继续领取或重发');
});

test('牧场空巡查同一连续空闲期只记一次，真实动作后可开启新的空闲记录', async () => {
    const behavior = { planCount: 0 };
    const h = automationHarness({ ranch: true, ranch_harvest: true }, behavior);
    assert.equal((await h.api.run({ farmDeadline: h.now })).yielded, true);
    assert.deepEqual(h.calls.logs, [], '未进场的让路不是已完成巡查');
    const next = () => h.advance(h.api.getRoutineState().nextCheckAt - h.now());
    next();
    assert.equal((await h.api.run()).actions, 0);
    assert.deepEqual(h.calls.logs, [{ tag: '牧场', msg: '自动巡查完成：无待执行动作', isWarn: false,
        meta: { module: 'ranch', event: 'ranch_patrol_complete', result: 'idle' } }]);
    next(); await h.api.run();
    assert.equal(h.calls.logs.length, 1);
    h.advance(58_000); await h.api.run();
    assert.equal(h.calls.logs.length, 1, '经过多轮空闲也不重复打日志');
    behavior.planCount = 1;
    next(); await h.api.run();
    assert.equal(h.calls.logs[1].meta.event, 'ranch_harvest');
    assert.equal(h.calls.logs[1].meta.result, 'ok');
    assert.equal(h.calls.logs.length, 2);
    behavior.planCount = 0;
    next(); await h.api.run();
    assert.equal(h.calls.logs[2].meta.event, 'ranch_patrol_complete', '动作后的新空闲期只记一次');
    next(); await h.api.run();
    assert.equal(h.calls.logs.length, 3);
});

test('牧场待核对只跳过同目标，无关自动照料继续且不清记录', async () => {
    const pendingTask = { id: 'unchanged', target: 'ranch:claimTasks:300011', costs: [] };
    const unrelated = automationHarness({ ranch: true, ranch_harvest: true }, { pending: [pendingTask], planCount: 1 });
    const result = await unrelated.api.run();
    assert.equal(result.actions, 1, '无关收获继续执行');
    assert.deepEqual(unrelated.calls.writes, ['harvest']);
    assert.deepEqual(unrelated.api.getRoutineState().lastResult, 'confirmed');
    assert.deepEqual(unrelated.calls.logs.filter(row => row.meta?.event === 'ranch_patrol_paused'), []);
    assert.deepEqual(unrelated.calls.pendingChecks > 0, true);
    assert.deepEqual(pendingTask, { id: 'unchanged', target: 'ranch:claimTasks:300011', costs: [] });

    const sameTarget = { id: 'same-harvest', target: 'ranch:harvest:all', costs: [] };
    const blocked = automationHarness({ ranch: true, ranch_harvest: true }, { pending: [sameTarget], planCount: 1 });
    const skipped = await blocked.api.run();
    assert.equal(skipped.actions, 0);
    assert.deepEqual(blocked.calls.writes, [], '同目标unknown不得重放');
    assert.equal(blocked.calls.scene, 1, '同目标账本已安全读取后，不必全局禁止进入只读巡查');
    assert.equal(blocked.calls.plans.includes('harvest'), true);
    assert.deepEqual(blocked.api.getRoutineState().lastResult, 'idle');
    assert.deepEqual(sameTarget, { id: 'same-harvest', target: 'ranch:harvest:all', costs: [] });

    const latePending = [];
    const late = automationHarness({ ranch: true, ranch_harvest: true }, {
        pending: latePending, planCount: 1,
        onPlan: (action) => { if (action === 'harvest' && !latePending.length) latePending.push(sameTarget); },
    });
    await late.api.run();
    assert.deepEqual(late.calls.writes, [], '报价后出现同目标unknown必须在发送前拦截');
    assert.deepEqual(latePending, [sameTarget]);
});

test('真实统一tick与牧场假时钟组合：帮助偷菜耗时后先补到期实际农场工作；全关deadline为Infinity', async () => {
    const vm = require('node:vm');
    const worker = source('src/core/worker.js');
    for (const workKey of ['farm', 'task', 'fertilizer_gift', null]) {
        const auto = { ranch: true, ranch_harvest: true, ranch_produce: true, friend_help: true, friend_steal: true };
        if (workKey) auto[workKey] = true;
        const h = automationHarness(auto, { advanceAfterStateRead: 2000,
            advanceAfterPlan: { harvest: 2000, produce: 2000 } });
        const order = [];
        const farmWork = name => async () => { order.push(name); h.advance(2000); };
        const context = vm.createContext({
            Date: { now: h.now }, CONFIG: { farmCheckIntervalMin: 2000, farmCheckIntervalMax: 2000 },
            randomIntervalMs: min => min, stealPhaseOffsetMs: () => 0,
            farmTaskRunning: false, ranchTaskRunning: false, friendSyncPaused: false,
            unifiedSchedulerRunning: true, loginReady: true, nextFarmRunAt: 0, nextRanchRunAt: 0,
            gatewayHealthBackoffUntil: 0, gatewayHealthBackoffReason: '',
            getAutomation: () => auto, ranchAutomation: h.api,
            runAccountOperation: async (_name, task) => task(),
            runWithRequestPriority: async (_priority, task) => task(),
            checkFarm: farmWork('farm'), checkAndClaimTasks: farmWork('task'),
            openFertilizerGiftPacksSilently: farmWork('fertilizer_gift'),
            checkFriends: async input => { order.push(input.onlyHelp ? 'help' : 'steal'); h.advance(3000); },
            runGoldenBugPlacement: async () => {}, runDueStealPlans: async () => {},
            isTransientNetworkError: () => false, log: () => {},
        });
        const code = worker.slice(worker.indexOf('async function runFarmTick('), worker.indexOf('function scheduleUnifiedNextTick()'));
        vm.runInContext(`${code}\nglobalThis.tick = runUnifiedTick;`, context);
        await context.tick();
        assert.deepEqual(order, workKey ? [workKey, 'help', 'steal', workKey] : ['help', 'steal']);
        assert.deepEqual(h.calls.writes, workKey ? ['harvest'] : ['harvest', 'produce']);
        if (workKey) {
            assert.equal(h.api.getRoutineState().lastYieldReason, 'farm_deadline');
            assert.equal(h.calls.plans.length, 1, '强读/报价已过期时首次公平单元仍推进');
            h.advance(h.api.getRoutineState().nextCheckAt - h.now());
            await context.tick();
            assert.deepEqual(h.calls.writes, ['harvest', 'produce'], '统一调度续片不重放确认收获');
        } else assert.equal(h.api.getRoutineState().lastResult, 'confirmed');
    }
});

test('补草分批核验不能解除旧id1未知账本，账号隔离且无marker不猜测历史结果', async () => {
    const h = ranchRuntimeHarness();
    const file = `/memory/ranch-operations/${require('node:crypto').createHash('sha256').update('10').digest('hex').slice(0, 24)}.json`;
    const legacy = { id: '1', target: 'ranch:addGrass:1', label: '旧补草', createdAt: Date.now() - 86400000,
        costs: [{ resourceKey: 'item:7001', amount: '20' }], message: '结果未知，无原始marker/回包' };
    h.disk.set(file, JSON.stringify([legacy]));
    h.state.cells.facilities = [{ instance_id: 88, capacity: 30, feed_machine: { feed_count: 10 } }];
    h.state.bag.physical_items = [{ id: '7001', count: '40', uid: '111' }];
    h.handlers.set('AddFeed', () => {
        h.state.bag.physical_items[0].count = '20';
        return { detail: { feed_count: 30 }, consumed: [
            { id: '7001', count: '12', uid: '111' }, { id: '7001', count: '8', uid: '112' },
        ] };
    });
    const quote = await h.quote('addGrass', { facilityId: 88 });
    assert.equal((await h.call('addGrass', { facilityId: 88 }, quote.expected)).completed, 20);
    const ledger = h.services['ranch-operations-ledger'].ranchOperations;
    assert.deepEqual(JSON.parse(JSON.stringify(ledger.pending('10'))), [legacy]);
    assert.deepEqual(JSON.parse( h.disk.get(file)), [legacy]);
    assert.equal(ledger.pending('20').length, 0);
    h.state.automation = { ranch: true, ranch_grass: true };
    const writesBefore = h.calls.filter(row => row.method === 'AddFeed').length;
    const patrol = await h.services['ranch-automation'].run();
    assert.equal(patrol.actions, 0, '原unknown预留20后，剩余草量不足以再自动补草');
    assert.equal(h.calls.filter(row => row.method === 'AddFeed').length, writesBefore, '不会重复消耗已预留草量');
    assert.deepEqual(JSON.parse(JSON.stringify(ledger.pending('10'))), [legacy]);
});

test('首次2秒报价在连续短农场窗口内取得进展，强读耗尽原窗口也不饿死', async () => {
    for (const readMs of [0, 2000, 6000]) {
        const h = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true }, {
            advanceAfterStateRead: readMs, advanceAfterPlan: { harvest: 2000, produce: 2000 },
        });
        for (let slice = 0; slice < 4; slice++) {
            const deadline = h.now() + 2000;
            await h.api.run({ farmDeadline: () => deadline });
            h.advance(h.api.getRoutineState().nextCheckAt - h.now());
        }
        assert.deepEqual(h.calls.writes, ['harvest', 'produce', 'harvest', 'produce']);
        assert.deepEqual(h.calls.plans, h.calls.writes, '无进度时不能反复只报价同一动作');
    }
});

test('首次公平单元不能超5秒或在实际发送排队后越界；不无限报价yield', async () => {
    for (const delayAtSend of [false, true]) {
        const behavior = delayAtSend ? { beforeSend: () => h.advance(5000) } : { advanceAfterPlan: { harvest: 5000 } };
        const h = automationHarness({ ranch: true, ranch_harvest: true }, behavior);
        await assert.rejects(h.api.run(), error => error.errorCode === 'RANCH_AUTOMATION_FIRST_ACTION_TIMEOUT'
            && error.sent === false && error.resultState === 'not_sent');
        assert.deepEqual(h.calls.writes, []);
        assert.equal(h.api.getRoutineState().lastResult, 'error');
        assert.ok(h.api.getRoutineState().nextCheckAt >= h.now() + 600000);
        await h.api.run();
        assert.deepEqual(h.calls.plans, ['harvest']);
    }
});

test('发送前关闭总/子开关或买草关联开关均明确未发送，普通/有机/库存放养逐发复查', async () => {
    for (const [switches, closeKey, action] of [
        [{ ranch_harvest: true }, 'ranch', 'harvest'],
        [{ ranch_harvest: true }, 'ranch_harvest', 'harvest'],
        [{ ranch_feed_normal: true, ranch_feed_organic: true }, 'ranch_feed_normal', 'feed'],
        [{ ranch_feed_organic: true }, 'ranch_feed_organic', 'feed'],
        [{ ranch_grass: true, ranch_grass_buy: true }, 'ranch_grass', 'buy'],
        [{ ranch_grass: true, ranch_grass_buy: true }, 'ranch_grass_buy', 'buy'],
        [{ ranch_place: true }, 'ranch_place', 'place'],
    ]) {
        const auto = { ranch: true, ...switches };
        const h = automationHarness(auto, {
            raw: { cells: { facilities: [{ instance_id: 88, state: 1, upgrade_state: 0, feed_machine: {},
                ranch: { ranch_inst_id: 88, husbandry_type: 1, capacity: 1, animal_count: 0, animals: [] } }] },
                bag: { physical_items: [{ id: 50001, count: '1' }] } },
            cubs: { 50001: { enable_flag: true, husbandry_type: '窝' } },
            onPlan: planned => { if (planned === 'addGrass') throw Object.assign(new Error('缺草'), { errorCode: 'INSUFFICIENT_BALANCE' }); },
            beforeSend: planned => { if (planned === action) auto[closeKey] = false; },
        });
        await assert.rejects(h.api.run(), error => error.errorCode === 'RANCH_AUTOMATION_DISABLED'
            && error.sent === false && error.resultState === 'not_sent');
        assert.deepEqual(h.calls.writes, [], closeKey);
    }
});

test('报价await后关闭开关按not_sent分类，进展后的实际发送排队越过农场期限必须让路且续片不重放', async () => {
    for (const closeKey of ['ranch', 'ranch_harvest']) {
        const auto = { ranch: true, ranch_harvest: true };
        const h = automationHarness(auto, { onPlan: () => { auto[closeKey] = false; } });
        await assert.rejects(h.api.run(), error => error.errorCode === 'RANCH_AUTOMATION_DISABLED'
            && error.sent === false && error.resultState === 'not_sent');
        assert.deepEqual(h.calls.writes, []);
    }
    const behavior = { beforeSend: action => { if (action === 'produce') h.advance(2000); } };
    const h = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true }, behavior);
    const deadline = h.now() + 2000;
    assert.equal((await h.api.run({ farmDeadline: () => deadline })).yielded, true);
    assert.deepEqual(h.calls.writes, ['harvest']);
    assert.equal(h.api.getRoutineState().lastYieldReason, 'farm_deadline');
    h.advance(20000);
    await h.api.run();
    assert.deepEqual(h.calls.writes, ['harvest', 'produce']);
});

test('只对明确not_sent ACCOUNT_OPERATION_BUSY短有界退避，未知与待核对保护不能缩短', async () => {
    for (const details of [
        { sent: false, resultState: 'not_sent' },
        { sent: true, resultState: 'not_sent' },
        { sent: false, resultState: 'unknown' },
        { sent: false, resultState: 'not_sent', outcomeUnknown: true },
        { sent: false, resultState: 'not_sent', holdUntilTransportEpochChanged: true },
    ]) {
        const h = automationHarness({ ranch: true, ranch_harvest: true }, {
            beforeLease: () => { throw Object.assign(new Error('业务在途'), { errorCode: 'ACCOUNT_OPERATION_BUSY', retryAfterMs: 99999, ...details }); },
        });
        await assert.rejects(h.api.run(), /业务在途/);
        const state = h.api.getRoutineState();
        const short = details.sent === false && details.resultState === 'not_sent'
            && !details.outcomeUnknown && !details.holdUntilTransportEpochChanged;
        assert.ok(short ? state.nextCheckAt - h.now() === 5000 : state.nextCheckAt >= h.now() + 600000);
        assert.equal(h.api.resetSchedule(), state.nextCheckAt);
        assert.deepEqual(h.calls.writes, []);
    }
});

test('续片身份真实隔离：账号游戏代际改变后不沿用上一代已完成动作', async () => {
    const behavior = { advanceAfterWrite: 2000, session: { remoteGeneration: '1' } };
    const h = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true }, behavior);
    const deadline = h.now() + 2000;
    await h.api.run({ farmDeadline: () => deadline });
    behavior.session.remoteGeneration = '2';
    h.advance(20000);
    await h.api.run();
    assert.deepEqual(h.calls.writes, ['harvest', 'harvest', 'produce']);
});

test('三期默认全关不进入场景；同周期多动作只强读一次', async () => {
    const off = automationHarness({ ranch: false, ranch_check_minutes: 30 });
    assert.deepEqual(JSON.parse(JSON.stringify(await off.api.run())), { actions: 0, skipped: true });
    assert.equal(off.calls.scene, 0);

    const on = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true, ranch_check_minutes: 30 });
    const result = await on.api.run();
    assert.equal(result.actions, 2);
    assert.equal(on.calls.scene, 1);
    assert.equal(on.calls.stateReads, 1, '一次scene周期只强读一次AllCells+GetBag');
    assert.equal(on.calls.detailReads, 1, '动物详情只读一次');
    assert.deepEqual(on.calls.writes, ['harvest', 'produce']);
});

test('自动巡查诊断初值及配额时间可直接JSON往返，读取状态不进入场景或写入', () => {
    const h = automationHarness({ ranch: true, ranch_harvest: true });
    const state = h.api.getRoutineState();
    assert.equal(state.lastStartedAt, 0);
    assert.equal(state.lastFinishedAt, 0);
    assert.equal(state.lastResult, 'idle');
    assert.equal(state.lastError, '');
    assert.equal(state.lastYieldReason, '');
    assert.equal(state.quotaResetAt, null, '无配额重置时直接返回null而非Infinity');
    for (const value of Object.values(state)) {
        if (typeof value === 'number') assert.ok(Number.isFinite(value));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(state)), { ...state });
    const quota = automationHarness({ ranch: true, ranch_friend_steal: true }, { exhausted: ['steal'] });
    assert.equal(quota.api.getRoutineState().quotaResetAt, quota.now() + 60000);
    assert.equal(h.calls.scene, 0);
    assert.deepEqual(h.calls.writes, []);
    assert.equal(h.calls.clears, 0);
    assert.equal(quota.calls.scene, 0);
    assert.deepEqual(quota.calls.writes, []);
});

test('worker状态同步携带可序列化ranchAutomation快照且不触发牧场操作', () => {
    const vm = require('node:vm');
    const h = automationHarness({ ranch: true, ranch_harvest: true });
    const worker = source('src/core/worker.js');
    const messages = [];
    vm.runInNewContext(`${worker.slice(worker.indexOf('function syncStatus() {'))}\nsyncStatus();`, {
        process: { send: true }, parentPort: null,
        getUserState: () => ({}), loginReady: true, isConnected: () => true,
        statsObservationsReady: true, gatewayHealthSnapshot: {}, statsConnectionPaused: false,
        gatewayHealthBackoffUntil: 0, isHealthBackoffActive: () => false,
        statusData: {}, nextFarmRunAt: 0, nextHelpRunAt: 0, nextStealRunAt: 0,
        getAutomation: () => ({ ranch: true }), ranchAutomation: h.api,
        getPreferredSeed: () => 0, appliedConfigRevision: 1, getTransportDiagnostics: () => ({}),
        lastStatusHash: '', lastStatusSentAt: 0, sendToMaster: message => messages.push(message),
        require(id) {
            if (id === '../services/friend') return { getOperationLimits: () => ({}) };
            if (id === '../services/stats') return { getStats: () => ({ status: { level: 0, exp: 0 } }) };
            throw new Error(`禁止真实 require: ${id}`);
        },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'status_sync');
    const state = messages[0].data.ranchAutomation;
    assert.equal(state.quotaResetAt, null);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), { ...h.api.getRoutineState() });
    assert.equal(h.calls.scene, 0);
    assert.deepEqual(h.calls.plans, []);
    assert.deepEqual(h.calls.writes, []);
    assert.equal(h.calls.clears, 0);
});

test('初始farmDeadline跳过覆盖旧成功结果和时间，不进入场景或重放', async () => {
    const h = automationHarness({ ranch: true, ranch_harvest: true });
    await h.api.run();
    const previous = h.api.getRoutineState();
    assert.equal(previous.lastResult, 'confirmed');
    assert.equal(previous.lastStartedAt, h.now());
    assert.equal(previous.lastFinishedAt, h.now());
    h.advance(previous.nextCheckAt - h.now());
    const startedAt = h.now();
    const before = JSON.stringify(h.calls);
    const result = await h.api.run({ farmDeadline: () => startedAt });
    assert.equal(result.yielded, true);
    const state = h.api.getRoutineState();
    assert.equal(state.running, false);
    assert.equal(state.lastResult, 'yielded');
    assert.equal(state.lastYieldReason, 'farm_deadline');
    assert.equal(state.lastError, '');
    assert.equal(state.lastStartedAt, startedAt);
    assert.equal(state.lastFinishedAt, startedAt);
    assert.ok(state.lastStartedAt > previous.lastFinishedAt);
    assert.equal(state.nextCheckAt, startedAt + 20000);
    assert.equal(h.api.resetSchedule(), state.nextCheckAt, '配置同步不能缩短重入保护');
    assert.equal(JSON.stringify(h.calls), before, '初始让路仅更新诊断和原有调度时间');
    await h.api.run();
    assert.deepEqual({ ...h.api.getRoutineState() }, { ...state }, '尚未到期的跳过不伪造一次巡查');
});

test('巡查在途状态有开始时间且无伪造完成时间，并发跳过不覆盖正在执行结果', async () => {
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = automationHarness({ ranch: true, ranch_harvest: true }, {
        beforeLease: async () => { entered(); await gate; },
    });
    const startedAt = h.now();
    const running = h.api.run();
    await waiting;
    const state = h.api.getRoutineState();
    assert.equal(state.running, true);
    assert.equal(state.lastResult, 'running');
    assert.equal(state.lastStartedAt, startedAt);
    assert.equal(state.lastFinishedAt, 0);
    h.advance(2500);
    assert.equal((await h.api.run()).skipped, true);
    assert.deepEqual({ ...h.api.getRoutineState() }, { ...state });
    assert.deepEqual(h.calls.writes, []);
    release();
    await running;
    const finished = h.api.getRoutineState();
    assert.equal(finished.running, false);
    assert.equal(finished.lastStartedAt, startedAt);
    assert.equal(finished.lastFinishedAt, startedAt + 2500);
    assert.equal(finished.lastResult, 'confirmed');
    assert.equal(finished.lastError, '');
    assert.deepEqual(h.calls.writes, ['harvest']);
});

test('库存补栏仅显式开启、匹配栏舍与未锁定未预留普通幼崽，不买幼崽不消耗巨大幼崽', async () => {
    const raw = { cells: { facilities: [{ instance_id: 88, state: 1, upgrade_state: 0,
        ranch: { ranch_inst_id: 88, husbandry_type: 1, capacity: 4, animal_count: 1, animals: [{ animal_inst_id: 1 }] } }] },
        bag: { physical_items: [{ id: 50001, count: '5', is_locked: false }, { id: 50001, count: '50', is_locked: true },
            { id: 55001, count: '8', is_locked: false }, { id: 50002, count: '4', is_locked: false }] } };
    const cubs = { 50001: { enable_flag: true, husbandry_type: '窝', giantCubItemId: 0 },
        55001: { enable_flag: true, husbandry_type: '窝', giantCubItemId: 55001 },
        50002: { enable_flag: true, husbandry_type: '棚', giantCubItemId: 0 } };
    const plans = [];
    const h = automationHarness({ ranch: true, ranch_place: true }, { raw, cubs, reserved: 3,
        onPlan: (action, input) => { if (action === 'place') plans.push(input); } });
    await h.api.run();
    assert.deepEqual(h.calls.writes, ['place']);
    assert.equal(plans[0].count, 2); assert.equal(plans[0].itemId, 50001); assert.equal(plans[0].ranchId, 88);
    const off = automationHarness({ ranch: true }, { raw, cubs }); await off.api.run();
    assert.equal(off.calls.scene, 0);
    const pending = automationHarness({ ranch: true, ranch_place: true }, { raw, cubs,
        pending: [{ id: 'old-unknown', target: 'ranch:place:all', costs: [] }] });
    await pending.api.run();
    assert.deepEqual(pending.calls.writes, [], '同一栏舍放养目标待核对时不重放');
    assert.equal(pending.calls.scene, 1, '已读安全快照允许进入只读巡查，避免全局冻结');
});

test('并发复查：排队取得租约及报价await后新增unknown必须零自动写', async () => {
    const behavior = { pending: [], beforeLease: () => {
        queued.advance(1000);
        behavior.pending.push({ id: 'manual-unknown', target: 'ranch:harvest:all', costs: [] });
    } };
    const queued = automationHarness({ ranch: true, ranch_harvest: true }, behavior);
    const stopped = await queued.api.run();
    assert.equal(stopped.actions, 0);
    assert.equal(queued.calls.sceneLogins, 1, '目标已知冲突时只读检查可以进入场景');
    assert.equal(queued.calls.stateReads, 1);
    assert.deepEqual(queued.calls.writes, [], '租约取得后发现同目标unknown，发送前跳过');
    assert.equal(queued.api.getRoutineState().running, false);
    assert.equal(behavior.pending.length, 1, '巡查不能清理未知操作锁');
    const duringPlan = { pending: [], onPlan: (action) => {
        if (action === 'harvest' && !duringPlan.pending.length)
            duringPlan.pending.push({ id: 'late-unknown', target: 'ranch:harvest:all', costs: [] });
    } };
    const planned = automationHarness({ ranch: true, ranch_harvest: true }, duringPlan);
    assert.equal((await planned.api.run()).actions, 0);
    assert.deepEqual(planned.calls.writes, [], '报价期间出现同目标unknown时仍不得发送');
    assert.equal(planned.api.getRoutineState().running, false);
    assert.equal(duringPlan.pending.length, 1);
});

test('并发复查：缺草后2秒报价跨农场期限推进，确认购买仅一次且后续库存补栏可达', async () => {
    const raw = { cells: { facilities: [{ instance_id: 88, state: 1, upgrade_state: 0, feed_machine: {},
        ranch: { ranch_inst_id: 88, husbandry_type: 1, capacity: 2, animal_count: 0, animals: [] } }] },
        bag: { physical_items: [{ id: 50001, count: '1', is_locked: false }] } };
    let bought = false;
    const h = automationHarness({ ranch: true, ranch_grass: true, ranch_grass_buy: true, ranch_place: true }, {
        raw, cubs: { 50001: { enable_flag: true, husbandry_type: '窝' } }, advanceAfterPlan: { buy: 2000 },
        onPlan: action => { if (action === 'addGrass' && !bought) throw Object.assign(new Error('缺草'), { errorCode: 'INSUFFICIENT_BALANCE' }); },
        onWrite: action => { if (action === 'buy') bought = true; },
    });
    for (let i = 0; i < 3; i++) {
        const deadline = h.now() + 2000;
        await h.api.run({ farmDeadline: () => deadline }); h.advance(30000);
    }
    assert.deepEqual(h.calls.writes, ['buy', 'addGrass', 'place']);
    assert.equal(h.calls.plans.filter(action => action === 'buy').length, 2, '首片让路后下片重新报价，不复用过期报价');
});

test('三期3B好友开关默认关闭，开启后每周期最多访问一位且遵守黑名单/免打扰', async () => {
    const off = automationHarness({ ranch: true, ranch_harvest: true, ranch_check_minutes: 30 }, {
        friends: [{ gid: 20001, name: 'A' }], planCount: 0,
    });
    await off.api.run();
    assert.deepEqual(off.calls.friendVisits, []);

    const on = automationHarness({ ranch: true, ranch_friend_steal: true, ranch_check_minutes: 30 }, {
        friends: [{ gid: 20001, name: 'A' }, { gid: 20002, name: 'B' }],
    });
    const result = await on.api.run();
    assert.equal(result.actions, 1);
    assert.deepEqual(on.calls.friendVisits, [20001], '每周期最多访问一位好友');

    const filtered = automationHarness({ ranch: true, ranch_friend_clean: true, ranch_check_minutes: 30 }, {
        friends: [{ gid: 20001, name: 'A' }, { gid: 20002, name: 'B' }],
        blacklist: [20001], quietGids: [20002],
    });
    await filtered.api.run();
    assert.deepEqual(filtered.calls.friendVisits, []);
});

test('牧场以自身名册选候选，偷取和放蚊只应用各自的农场名单', async () => {
    const friends = [10001, 20004, 20005, 20001, 20002, 20003].map(gid => ({ gid }));
    const behavior = { friends, blacklist: ['20004'], quietGids: [20005],
        badTargets: ['10001', '20004', '20005', '20003', '90001'] };
    const auto = { ranch: true, friend_steal_only_gids: ['10001', '20004', '20005', '20002', '90002'] };
    for (const [switches, expected] of [
        [{ ranch_friend_steal: true, ranch_friend_mosquito: true }, [[20002, 'steal']]],
        [{ ranch_friend_mosquito: true }, [[20003, 'putMosquito']]],
        [{ ranch_friend_steal: true, ranch_friend_mosquito: true, ranch_friend_clean: true, ranch_friend_stroke: true },
            [[20001, 'cleanFriend'], [20001, 'stroke']]],
    ]) {
        const h = automationHarness({ ...auto, ...switches }, behavior);
        await h.api.run();
        assert.deepEqual(h.calls.friendWrites, expected);
    }
    const missing = automationHarness({ ...auto, ranch_friend_steal: true, ranch_friend_mosquito: true }, { ...behavior, friends: [{ gid: 20001 }] });
    await missing.api.run();
    assert.deepEqual(missing.calls.friendVisits, [], '名单里的非牧场好友不能被补进候选');
    const unrestricted = automationHarness({ ranch: true, friend_steal_only_gids: [], ranch_friend_steal: true, ranch_friend_mosquito: true },
        { ...behavior, badTargets: [] });
    await unrestricted.api.run();
    assert.deepEqual(unrestricted.calls.friendWrites, [[20001, 'steal'], [20001, 'putMosquito']]);
});

test('名册读取、好友进入以及跨片期间都重新应用最新名单', async () => {
    const friends = [{ gid: 20001 }, { gid: 20002 }];
    const auto = { ranch: true, ranch_friend_steal: true, ranch_friend_mosquito: true, friend_steal_only_gids: ['20001'] };
    const behavior = { friends, badTargets: ['20001'],
        onRosterRead: () => { auto.friend_steal_only_gids = ['20002']; behavior.badTargets = ['20002']; },
        onFriendEnter: () => { auto.friend_steal_only_gids = ['20001']; },
    };
    const duringRead = automationHarness(auto, behavior);
    await duringRead.api.run();
    assert.deepEqual(duringRead.calls.friendVisits, [20002]);
    assert.deepEqual(duringRead.calls.friendWrites, [[20002, 'putMosquito']], '进入后撤销偷取不影响仍获准的放蚊');

    for (const keepClean of [true, false]) {
        const config = { ...auto, ranch_friend_clean: true };
        const sliced = { friends, badTargets: ['20001'], onFriendWrite: action => action === 'steal' };
        const h = automationHarness(config, sliced);
        assert.equal((await h.api.run()).yielded, true);
        sliced.badTargets = ['20002'];
        if (!keepClean) sliced.blacklist = ['20001'];
        h.advance(20000);
        await h.api.run();
        assert.deepEqual(h.calls.friendVisits, keepClean ? [20001, 20001] : [20001]);
        assert.deepEqual(h.calls.friendWrites, keepClean ? [[20001, 'steal'], [20001, 'cleanFriend']] : [[20001, 'steal']],
            '续片不会重放偷取，也不会对已移出名单的好友放蚊');
    }
});

test('三期收获后出售最多精确reconcile一次，farm deadline边界让路', async () => {
    const reconcile = automationHarness({ ranch: true, ranch_harvest: true, ranch_sell: true, ranch_check_minutes: 30 });
    const result = await reconcile.api.run();
    assert.equal(result.actions, 2);
    assert.equal(reconcile.calls.stateReads, 2, '初始强读+收获后出售前一次reconcile');
    assert.deepEqual(reconcile.calls.writes, ['harvest', 'sell']);

    const yieldHarness = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true, ranch_check_minutes: 30 }, { advanceAfterWrite: 6000 });
    const yielded = await yieldHarness.api.run({ farmDeadline: () => yieldHarness.now() + 300000 });
    assert.equal(yielded.yielded, true);
    assert.deepEqual(yieldHarness.calls.writes, ['harvest'], '当前写确认后才在下一动作边界让路');
    const state = yieldHarness.api.getRoutineState();
    assert.equal(state.lastResult, 'yielded');
    assert.equal(state.lastYieldReason, 'patrol_slice');
    assert.equal(state.lastError, '');
    assert.equal(state.lastStartedAt, yieldHarness.now() - 6000);
    assert.equal(state.lastFinishedAt, yieldHarness.now());
    assert.equal(state.running, false);
    yieldHarness.advance(20000);
    await yieldHarness.api.run();
    assert.deepEqual(yieldHarness.calls.writes, ['harvest', 'produce'], '续片不重放已确认的收获');
    assert.equal(yieldHarness.api.getRoutineState().lastYieldReason, '');

    const deadline = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true }, { advanceAfterWrite: 1000 });
    const farmDeadline = deadline.now() + 1000;
    await deadline.api.run({ farmDeadline: () => farmDeadline });
    assert.equal(deadline.api.getRoutineState().lastYieldReason, 'farm_deadline');
    assert.equal(deadline.api.getRoutineState().lastFinishedAt, farmDeadline);
    assert.deepEqual(deadline.calls.writes, ['harvest']);
});

test('自动两桶只做一种喂养；无关待核对时继续巡查，相关目标/余额继续跳过', async () => {
    const both = automationHarness({ ranch: true, ranch_feed_normal: true, ranch_feed_organic: true, ranch_check_minutes: 30 });
    await both.api.run();
    assert.deepEqual(both.calls.writes, ['feed']);

    const pending = [{ id: 'old', target: 'ranch:feed:all', label: '喂养动物', createdAt: 1,
        costs: [{ resourceKey: 'item:7003', amount: '3600' }], message: 'unknown' }];
    const unrelated = automationHarness({ ranch: true, ranch_clean: true, ranch_check_minutes: 30 }, { pending });
    const result = await unrelated.api.run();
    assert.equal(result.actions, 1);
    assert.deepEqual(unrelated.calls.writes, ['clean']);
    assert.ok(unrelated.calls.scene > 0);
    assert.deepEqual(pending.length, 1, '未知账本仍保留');

    const same = automationHarness({ ranch: true, ranch_feed_normal: true, ranch_harvest: true }, {
        pending, feedBucketId: 7003, raw: { cells: { facilities: [{ instance_id: 88, facility_id: 9001, upgrade_state: 0, upgrade_end_time: 0,
            ranch: { ranch_inst_id: 88, animals: [{ animal_inst_id: 1, animal_id: 60001, grow_ready_at_ms: 1800000001000 }], shelves: [], hazards: [] } }] },
            bag: { global_scene_id: 2, physical_items: [], virtual_items: [{ id: '7003', count: '7200' }] } },
    });
    const sameResult = await same.api.run();
    assert.deepEqual(same.calls.writes, ['harvest'], '冲突的7003喂养跳过，其他无冲突收获仍继续');
    assert.deepEqual(same.calls.plans, ['feed', 'harvest'], '先检查时效性喂养，资源冲突时再继续后续巡查');
    assert.ok(sameResult.actions >= 1);
    assert.deepEqual(pending.length, 1, '不会自动解除待核对记录');
});

test('时效性喂养优先于清理、出售和设施升级，短巡查切片仍先尝试喂养', async () => {
    const h = automationHarness({ ranch: true, ranch_feed_normal: true, ranch_harvest: true,
        ranch_produce: true, ranch_clean: true, ranch_sell: true });
    await h.api.run();
    assert.equal(h.calls.plans[0], 'feed');
    assert.equal(h.calls.writes[0], 'feed');
});

test('好友牧场清理默认受好友经验满限制，关闭独立限制开关才允许继续清理', async () => {
    const friend = { gid: 12345, name: '测试好友', big_farm_status: true };
    const blocked = automationHarness({ ranch: true, ranch_friend_clean: true, ranch_friend_clean_exp_limit: true },
        { friends: [friend], helpExpAllowed: false });
    await blocked.api.run();
    assert.deepEqual(blocked.calls.friendWrites, []);
    const allowed = automationHarness({ ranch: true, ranch_friend_clean: true, ranch_friend_clean_exp_limit: false },
        { friends: [friend], helpExpAllowed: false });
    await allowed.api.run();
    assert.deepEqual(allowed.calls.friendWrites, [[12345, 'cleanFriend']]);
});

test('1020001 BatchGetBasicInfo繁忙只延迟分享读取，按20秒/60秒/3分钟有序重试且成功后复位', async () => {
    const behavior = { failShareBusy: true };
    const h = automationHarness({ ranch: true, ranch_daily_share_claim: true, ranch_harvest: true }, behavior);
    const shareReads = () => h.calls.progressReads.filter(action => action === 'share').length;
    const first = await h.api.run();
    assert.equal(first.actions, 1, '分享读取失败不阻止自家牧场其他动作');
    assert.deepEqual(h.calls.writes, ['harvest']);
    assert.equal(h.api.getRoutineState().lastResult, 'confirmed');
    assert.equal(shareReads(), 1);
    assert.equal(h.calls.warnings.filter(message => message.includes('秒后重试')).length, 1);
    h.advance(2000);
    await h.api.run();
    assert.equal(shareReads(), 1, '短巡查周期不会重复请求繁忙接口');
    h.advance(25000);
    await h.api.run();
    assert.equal(shareReads(), 2, '首次退避到期后会重试');
    h.advance(65000);
    behavior.failShareBusy = false;
    await h.api.run();
    assert.equal(shareReads(), 3, '第二级退避到期后再次尝试并成功');
    behavior.failShareBusy = true;
    h.advance(25000);
    await h.api.run();
    assert.equal(shareReads(), 4, '成功读取会清空连续繁忙计数，下一次回到短退避');
    assert.equal(h.calls.writes.every(action => action === 'harvest'), true);
});

test('正常巡查只跟随账号农场秒数，空周期和确认写都无额外调度偏移', async () => {
    const auto = { ranch: true, ranch_harvest: true, ranch_check_minutes: 120 };
    const fixed = automationHarness(auto, { planCount: 0, intervals: { farmMin: 3, farmMax: 3 } });
    const result = await fixed.api.run();
    assert.equal(result.nextCheckAt - fixed.now(), 3000);
    assert.equal(fixed.api.getRoutineState().farmMin, 3);
    assert.equal(fixed.api.getRoutineState().farmMax, 3);
    fixed.advance(2999);
    assert.equal((await fixed.api.run()).skipped, true);
    fixed.advance(1);
    await fixed.api.run();
    assert.equal(fixed.calls.scene, 2, '正常周期不受20秒让路重入限制');

    const behavior = { random: 0.5, intervals: { farmMin: 80, farmMax: 90 }, raw: {
        cells: { facilities: [{ ranch: { animals: [{ grow_ready_at_ms: fixed.now() + 1000 }] } }] },
    } };
    const ranged = automationHarness(auto, behavior);
    assert.equal((await ranged.api.run()).nextCheckAt - ranged.now(), 85000,
        '服务端60秒、动物就绪和成功写不再改变正常周期');
    behavior.intervals = { farmMin: 1, farmMax: 4 };
    assert.equal(ranged.api.resetSchedule() - ranged.now(), 2500, '重新调度立即读取新范围');
    assert.equal(ranged.api.accountPhaseMs('10'), ranged.api.accountPhaseMs('10'));
    assert.notEqual(ranged.api.accountPhaseMs('1'), ranged.api.accountPhaseMs('2'));
});

test('三期unknown立即停止本轮并进入保守退避，不执行后续动作', async () => {
    const h = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true, ranch_check_minutes: 30 }, { unknownAction: 'harvest' });
    await assert.rejects(h.api.run(), error => error.resultState === 'unknown');
    assert.deepEqual(h.calls.writes, ['harvest']);
    const state = h.api.getRoutineState();
    assert.equal(state.lastResult, 'unknown');
    assert.equal(state.lastError, 'unknown write');
    assert.equal(state.lastStartedAt, h.now());
    assert.equal(state.lastFinishedAt, h.now());
    assert.equal(state.running, false);
    assert.ok(state.nextCheckAt > h.now());
});

test('切场明确失败更新错误及起止时间，不执行自动写', async () => {
    const h = automationHarness({ ranch: true, ranch_harvest: true }, {
        beforeLease: () => {
            h.advance(1500);
            throw Object.assign(new Error('业务在途，切场失败'), { errorCode: 'BUSINESS_IN_FLIGHT' });
        },
    });
    const startedAt = h.now();
    await assert.rejects(h.api.run(), /业务在途/);
    const state = h.api.getRoutineState();
    assert.equal(state.lastResult, 'error');
    assert.equal(state.lastError, '业务在途，切场失败');
    assert.equal(state.lastStartedAt, startedAt);
    assert.equal(state.lastFinishedAt, startedAt + 1500);
    assert.equal(state.running, false);
    assert.equal(state.lastYieldReason, '');
    assert.equal(h.calls.sceneLogins, 0);
    assert.deepEqual(h.calls.writes, []);
});

test('automation多字段保存单次apply、单次revision、单次broadcast', async () => {
    const calls = { apply: [], revisions: 0, broadcasts: [] };
    const { createDataProvider } = require('../src/runtime/data-provider');
    const store = {
        applyConfigSnapshot: (patch, options) => calls.apply.push({ patch, options }),
        getAutomation: () => ({ ranch: true, ranch_harvest: true, ranch_check_minutes: 30 }),
    };
    const provider = createDataProvider({
        workers: {}, globalLogs: [], accountLogs: [], store,
        getAccounts: () => ({ accounts: [{ id: '10', name: 'fixture' }] }),
        callWorkerApi: async () => null,
        buildDefaultStatus: () => ({}), normalizeStatusForPanel: value => value, filterLogs: value => value,
        nextConfigRevision: () => ++calls.revisions,
        broadcastConfigToWorkers: id => calls.broadcasts.push(id),
        startWorker() {}, stopWorker() {}, restartWorker() {}, scheduleAutoCodeRefresh() {}, refreshAccountCode() {},
    });
    const result = await provider.setAutomationBatch('10', { ranch: true, ranch_harvest: true, ranch_check_minutes: 30 });
    assert.equal(calls.apply.length, 1);
    assert.deepEqual(calls.apply[0].patch, { automation: { ranch: true, ranch_harvest: true, ranch_check_minutes: 30 } });
    assert.deepEqual(calls.apply[0].options, { accountId: '10' });
    assert.equal(calls.revisions, 1);
    assert.deepEqual(calls.broadcasts, ['10']);
    assert.equal(result.configRevision, 1);
});

function progressionFixture() {
    const h = ranchRuntimeHarness();
    h.state.tasksReply = { task_info: { growth_tasks: [
        { id: '300004', progress: '3', total_progress: '3', group: '2001', task_type: 4,
            is_unlocked: true, rewards: [{ id: '1102', count: '5' }] },
    ], daily_tasks: [
        { id: '400001', progress: '1', total_progress: '1', group: '1001', task_type: 5,
            is_unlocked: true, rewards: [{ id: '80021', count: '1' }] },
    ] } };
    h.state.book = { type: 101, current_level: 1, total_progress: 10, next_level_progress: 20,
        has_claimable_reward: true, total_rewards: [{ id: '1002', count: '1' }],
        list: [{ fruit_id: 60001, unlocked: true, progress: 1, giant: { unlocked: true,
            best_weight_x10: 1124, lo_x10: 1000, hi_x10: 2500, tier: 2, harvest_count: '9' } }] };
    h.state.bookLevels = { current_level: 1, total_progress: 10, level_list: [
        { level: 1, point_condition: 10, rewards: [{ id: '1002', count: '1' }], can_claim: true },
    ] };
    h.state.weightBook = { total_score: '1000', current_id: 2, calc_mode: 1, levels: [
        { id: 2, score_condition: '100', rewards: [{ id: '80021', count: '2' }], can_claim: true },
    ] };
    h.state.shareInfos = { '102': { share_count: '0', is_claimed: false } };
    h.progress = section => h.services['ranch-progression'].getRanchProgressView('10', section);
    return h;
}

test('牧场pending按同目标和冲突资源拦截，不全局禁用无关购买', () => {
    const task = { id: 'pending-task', target: 'ranch:claimTasks:300011', label: '成长任务领取', createdAt: 1, costs: [], message: 'unknown' };
    const h = ranchRuntimeHarness();
    const file = '/memory/ranch-operations/' + require('node:crypto').createHash('sha256').update('10').digest('hex').slice(0, 24) + '.json';
    h.disk.set(file, JSON.stringify([task]));
    const conflict = h.services['ranch-manual'].findConflictingPendingOperation;
    assert.equal(conflict('10', 'buy', { shopId: 5, goodsId: 10003 }, {
        costItems: [{ id: '1007', count: '1080' }], marker: {},
    }), null, '零成本未知任务不阻止无关商城购买报价');
    assert.equal(conflict('10', 'claimTasks', { taskId: '300011' })?.id, 'pending-task');
    assert.equal(conflict('10', 'claimTasks', { all: true })?.id, 'pending-task');
    assert.equal(conflict('10', 'claimTasks', { taskId: '300004' }), null, '另一个明确任务目标保持可操作');

    const shop = ranchRuntimeHarness();
    shop.disk.set(file, JSON.stringify([{ ...task, id: 'pending-buy', target: 'ranch:buy:60009',
        costs: [{ resourceKey: 'item:1007', amount: '3240' }] }]));
    const shopConflict = shop.services['ranch-manual'].findConflictingPendingOperation;
    assert.equal(shopConflict('10', 'buy', { shopId: 5, goodsId: 60009 }, {
        costItems: [{ id: '1007', count: '1080' }], marker: {},
    })?.id, 'pending-buy', '没有新鲜余额证据时保守阻止重复花费');
    assert.equal(shopConflict('10', 'buy', { shopId: 5, goodsId: 60010 }, {
        costItems: [{ id: '1007', count: '1080' }], availableResources: { 'item:1007': '5000' }, marker: {},
    }), null, '同一余额仍足以覆盖原预留和新购买时允许无关商品');
    assert.equal(shopConflict('10', 'buy', { shopId: 5, goodsId: 60010 }, {
        costItems: [{ id: '1007', count: '1080' }], availableResources: { 'item:1007': '4000' }, marker: {},
    })?.id, 'pending-buy', '扣除原预留后余额不足仍阻止购买');
    assert.equal(shopConflict('10', 'buyCan', { goodsId: '9001' }, {
        costItems: [{ id: '1005', count: '50' }], availableResources: { 'item:1005': '1000' }, marker: {},
    }), null, '使用不同货币且目标不同的购买不互锁');

    const share = ranchRuntimeHarness();
    share.disk.set(file, JSON.stringify([{ ...task, id: 'pending-share', target: 'ranch:reportDailyShare:102' }]));
    const shareConflict = share.services['ranch-manual'].findConflictingPendingOperation;
    assert.equal(shareConflict('10', 'claimDailyShare', {})?.id, 'pending-share', '同一分享奖励链不得跳过未知登记');
    assert.equal(shareConflict('10', 'buyCan', { goodsId: '9001' }, { costItems: [], marker: {} }), null);
});

test('牧场待核对锁按同目标和相冲突余额生效，不冻结无关商城购买', () => {
    const accountFile = () => `/memory/ranch-operations/${require('node:crypto').createHash('sha256')
        .update('10').digest('hex').slice(0, 24)}.json`;
    const seed = (h, rows) => h.disk.set(accountFile(), JSON.stringify(rows));
    const pendingTask = { id: 'pending-task', target: 'ranch:claimTasks:300011', label: '成长任务领取',
        createdAt: 1, costs: [], message: 'unknown' };
    const h = ranchRuntimeHarness();
    seed(h, [pendingTask]);
    const conflict = h.services['ranch-manual'].findConflictingPendingOperation;
    const buy1007 = { costItems: [{ id: '1007', count: '1080' }], marker: {} };
    assert.equal(conflict('10', 'buy', { shopId: 5, goodsId: 10003 }, buy1007), null,
        '无扣款任务未知结果不能锁定普通商品购买');
    assert.equal(conflict('10', 'claimTasks', { taskId: '300011' })?.id, 'pending-task');
    assert.equal(conflict('10', 'claimTasks', { all: true })?.id, 'pending-task');
    assert.equal(conflict('10', 'claimTasks', { taskId: '300004' }), null, '其他明确任务目标不互锁');

    const money = ranchRuntimeHarness();
    seed(money, [{ ...pendingTask, id: 'pending-buy', target: 'ranch:buy:10003',
        costs: [{ resourceKey: 'item:1007', amount: '3240' }] }]);
    const resourceConflict = money.services['ranch-manual'].findConflictingPendingOperation;
    assert.equal(resourceConflict('10', 'buy', { shopId: 5, goodsId: 10004 }, buy1007)?.id, 'pending-buy',
        '未知的金券扣款须预留相同余额');
    assert.equal(resourceConflict('10', 'buyCan', { goodsId: '9001' }, {
        costItems: [{ id: '1005', count: '50' }], marker: {},
    }), null, '不同余额的购买不互锁');

    const share = ranchRuntimeHarness();
    seed(share, [{ ...pendingTask, id: 'pending-share', target: 'ranch:reportDailyShare:102' }]);
    const shareConflict = share.services['ranch-manual'].findConflictingPendingOperation;
    assert.equal(shareConflict('10', 'claimDailyShare', {})?.id, 'pending-share', '分享状态未知时仍保护同一礼包链');
    assert.equal(shareConflict('10', 'buyCan', { goodsId: '9001' }, { costItems: [], marker: {} }), null);
});

test('4B固定配置：完整144项牧场任务、四个重量档位与独立协议', () => {
    const config = require('../src/services/ranch-config');
    const rows = require('../src/gameConfig/ranch/MCTask.json');
    assert.equal(rows.length, 144);
    assert.equal(rows.filter(row => config.getRanchTask(row.id).category === 'growth').length, 141);
    assert.equal(config.getRanchTask('200001'), undefined, '农场每日任务不得进入牧场配置');
    assert.equal(config.getRanchTask('300008').condition, '客户端上报进度');
    assert.equal(config.getRanchWeightTier(4).tier_name, '巨无霸');
    const h = progressionFixture();
    for (const name of ['RanchTaskInfoRequest', 'RanchGetIllustratedListV2Reply', 'RanchGetRanchWeightScoreV2Reply',
        'RanchClaimAllRewardsV2Reply', 'RanchClaimRanchWeightScoreRewardV2Reply', 'RanchReportShareReply', 'RanchClaimShareRewardReply']) {
        assert.ok(h.types[name], name);
    }
    const { ALLOWED_RANCH_ACTIONS } = require('../src/controllers/admin-ranch-routes');
    assert.ok(ALLOWED_RANCH_ACTIONS.has('claimTasks'));
    assert.ok(ALLOWED_RANCH_ACTIONS.has('reportDailyShare'));
    assert.equal(ALLOWED_RANCH_ACTIONS.has('reportEntry'), false, '不自动上报引导进度');
});

test('4B只读：任务带scene2且按需缓存，不读栏舍或背包；农场任务回包拒绝', async () => {
    const h = progressionFixture();
    const result = await h.progress('tasks');
    assert.equal(result.tasks.length, 2);
    assert.equal(result.summary.claimable, 2);
    assert.equal(result.guideReportingEnabled, false);
    assert.equal(h.calls.filter(row => row.method === 'TaskInfo').length, 1);
    assert.equal(h.calls.find(row => row.method === 'TaskInfo').input.global_scene_id, 2);
    assert.equal(h.calls.filter(row => ['AllCells', 'GetBag'].includes(row.method)).length, 0);
    assert.equal((await h.progress('tasks')).cache.hit, true);
    const wrong = progressionFixture();
    wrong.state.tasksReply.task_info.growth_tasks[0].id = '100001';
    await assert.rejects(wrong.progress('tasks'), error => error.errorCode === 'RANCH_RESPONSE_MISMATCH');
});

test('4B任务：单次批量普通领取，接口奖励精确匹配才确认，坏奖励与负向回包保留unknown', async () => {
    for (const mode of ['full', 'partial', 'empty', 'missing', 'wrong-reward', 'extra-claim', 'compensation']) {
        const h = progressionFixture();
        h.state.tasksReply.task_info.tasks = [{ id: '300010', progress: '0', total_progress: '4', group: '2001', task_type: 4,
            is_unlocked: true, rewards: [{ id: '1102', count: '7' }] }];
        h.handlers.set('BatchClaimTaskReward', input => {
            assert.deepEqual(input.ids, ['300004', '400001']);
            assert.notEqual(input.do_shared, true);
            h.state.tasksReply.task_info.growth_tasks[0].is_claimed = true;
            h.state.tasksReply.task_info.daily_tasks[0].is_claimed = mode !== 'partial';
            if (mode === 'missing') h.state.tasksReply.task_info.daily_tasks = [];
            if (mode === 'extra-claim') h.state.tasksReply.task_info.tasks[0].is_claimed = true;
            const items = mode === 'empty' ? [] : mode === 'wrong-reward' ? [{ id: '1102', count: '99' }]
                : [{ id: '1102', count: '5' }, ...(mode === 'partial' ? [] : [{ id: '80021', count: '1' }])];
            return { task_info: h.state.tasksReply.task_info, items,
                compensated_items: mode === 'compensation' ? [{ id: '1102', count: '1' }] : [] };
        });
        const quote = await h.quote('claimTasks', { all: true });
        if (['full', 'missing', 'compensation'].includes(mode)) {
            const result = await h.call('claimTasks', { all: true }, quote.expected);
            assert.equal(result.completed, 2);
            assert.equal(result.partial, false);
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        }
        else {
            await assert.rejects(h.call('claimTasks', { all: true }, quote.expected), error => error.resultState === 'unknown', mode);
            await h.progress('tasks');
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0, `${mode}: fresh TaskInfo automatically resolves the old receipt`);
            const writes = h.calls.filter(row => row.method === 'BatchClaimTaskReward').length;
            await h.quote('claimTasks', { taskId: '300004' });
            assert.equal(h.calls.filter(row => row.method === 'BatchClaimTaskReward').length, writes, 'refresh and quote must not resend the claim');
        }
        assert.equal(h.calls.filter(row => row.method === 'BatchClaimTaskReward').length, 1);
        assert.equal(h.calls.filter(row => row.method === 'ReportShare').length, 0);
    }
});

test('牧场任务领取回包按上游规则：目标仍未领取为负证据，精确奖励为成功证据', async () => {
    const good = new Set(['farm-only', 'mixed', 'wrong-type', 'empty-snapshot', 'missing-readback',
        'metadata', 'reward-changed', 'missing-ranch-target']);
    for (const mode of ['farm-only', 'mixed', 'partial', 'wrong-type', 'duplicate', 'empty-snapshot',
        'missing-readback', 'metadata', 'reward-changed', 'unclaimed', 'wrong-reward', 'extra-claim', 'missing-ranch-target']) {
        const h = progressionFixture();
        h.state.tasksReply.task_info.tasks = [{ id: '300010', progress: '0', total_progress: '4', group: '2001', task_type: 4,
            is_unlocked: true, rewards: [{ id: '1102', count: '7' }] }];
        h.handlers.set('BatchClaimTaskReward', input => {
            assert.deepEqual(input.ids, ['300004', '400001']);
            assert.notEqual(input.do_shared, true);
            h.state.tasksReply.task_info.growth_tasks[0].is_claimed = mode !== 'unclaimed';
            h.state.tasksReply.task_info.daily_tasks[0].is_claimed = !['partial', 'unclaimed'].includes(mode);
            if (mode === 'missing-readback') h.state.tasksReply.task_info.daily_tasks = [];
            if (mode === 'metadata') h.state.tasksReply.task_info.daily_tasks[0].group = '1002';
            if (mode === 'reward-changed') h.state.tasksReply.task_info.daily_tasks[0].rewards[0].count = '9';
            if (mode === 'extra-claim') h.state.tasksReply.task_info.tasks[0].is_claimed = true;
            const farm = { id: '100001', task_type: mode === 'wrong-type' ? 4 : 1 };
            let taskInfo = { growth_tasks: [farm], daily_tasks: [{ id: '200001', task_type: 2 }] };
            if (mode === 'duplicate') taskInfo.growth_tasks.push({ ...farm });
            if (mode === 'empty-snapshot') taskInfo = {};
            if (mode === 'mixed' || mode === 'unclaimed') taskInfo.tasks = [h.state.tasksReply.task_info.growth_tasks[0], h.state.tasksReply.task_info.daily_tasks[0]];
            if (mode === 'missing-ranch-target') taskInfo.tasks = [h.state.tasksReply.task_info.growth_tasks[0]];
            if (mode === 'extra-claim') taskInfo.tasks = [h.state.tasksReply.task_info.tasks[0]];
            const items = mode === 'wrong-reward' ? [{ id: '1102', count: '999' }]
                : [{ id: '1102', count: '5' }, ...(mode === 'partial' ? [] : [{ id: '80021', count: '1' }])];
            return { task_info: taskInfo, items };
        });
        const quote = await h.quote('claimTasks', { all: true });
        if (good.has(mode)) {
            const result = await h.call('claimTasks', { all: true }, quote.expected);
            assert.equal(result.completed, 2, mode);
            assert.equal(result.partial, false, mode);
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        }
        else {
            await assert.rejects(h.call('claimTasks', { all: true }, quote.expected), error => error.resultState === 'unknown', mode);
            await h.progress('tasks');
            assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0, `${mode}: authoritative TaskInfo resolves prior claim receipts`);
            const writes = h.calls.filter(row => row.method === 'BatchClaimTaskReward').length;
            await h.quote('claimTasks', { all: true });
            assert.equal(h.calls.filter(row => row.method === 'BatchClaimTaskReward').length, writes, 'refreshing TaskInfo does not resend a write');
        }
        assert.equal(h.calls.filter(row => row.method === 'BatchClaimTaskReward').length, 1, mode);
        assert.equal(h.calls.filter(row => row.method === 'ReportShare').length, 0, mode);
        for (const call of h.calls.filter(row => row.method === 'TaskInfo')) assert.equal(call.input.global_scene_id, 2, mode);
    }
});

test('4B任务资格：空目标不发写，附加奖励/未知任务仅展示，翻倍与过期日期拒绝', async () => {
    const h = progressionFixture();
    h.state.tasksReply.task_info.growth_tasks[0].extra_rewards = [{ id: '1102', count: '1' }];
    h.state.tasksReply.task_info.daily_tasks[0].is_claimed = true;
    assert.equal((await h.quote('claimTasks', { all: true })).skipped, true);
    assert.equal(h.calls.filter(row => row.method === 'BatchClaimTaskReward').length, 0);
    await assert.rejects(h.quote('claimTasks', { all: true, double: true }), error => error.errorCode === 'RANCH_INVALID_ARGUMENT');
    const old = progressionFixture();
    const offer = await old.quote('claimTasks', { all: true });
    old.state.serverTime += 24 * 60 * 60 * 1000;
    await assert.rejects(old.call('claimTasks', { all: true }, offer.expected), error => error.errorCode === 'RANCH_OFFER_CHANGED');
    assert.equal(old.calls.filter(row => row.method === 'BatchClaimTaskReward').length, 0);
});

test('4B图鉴：101动物图鉴与巨大记录/重量档位独立，1124显示11.24kg，各写仅发送一次', async () => {
    for (const action of ['claimIllustrated', 'claimWeight']) {
        const h = progressionFixture();
        const book = await h.progress('book');
        assert.equal(book.type, 101);
        assert.equal(book.animals[0].giant.bestWeightKg, 11.24);
        assert.equal(book.animals[0].giant.tierName, '超重');
        assert.equal(book.giant.levels[0].id, 2);
        h.handlers.set('ClaimAllRewardsV2', input => {
            assert.equal(input.type, 101);
            h.state.bookLevels.level_list[0].claimed = true;
            h.state.bookLevels.level_list[0].can_claim = false;
            h.state.book.has_claimable_reward = false;
            h.state.book.total_rewards = [];
            return { current_level: 1, claimed_level_ids: [1], total_rewards: [{ id: '1002', count: '1' }] };
        });
        h.handlers.set('ClaimRanchWeightScoreRewardV2', input => {
            assert.equal(input.id, 2);
            h.state.weightBook.levels[0].claimed = true;
            h.state.weightBook.levels[0].can_claim = false;
            return { claimed_ids: [2], rewards: [{ id: '80021', count: '2' }] };
        });
        const input = action === 'claimIllustrated' ? { kind: 'normal' } : { levelId: 2 };
        const quote = await h.quote(action, input);
        const result = await h.call(action, input, quote.expected);
        assert.equal(result.completed, 1);
        assert.equal(h.calls.filter(row => ['ClaimAllRewardsV2', 'ClaimRanchWeightScoreRewardV2'].includes(row.method)).length, 1);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
    }
});

test('4B巨大图鉴DTO：只按普通产物到巨大产物配置映射归类，名称与图标独立', async () => {
    const h = progressionFixture();
    h.state.book.list.push({ fruit_id: 2060002, unlocked: true, progress: 1, giant: { unlocked: true,
        best_weight_x10: 1124, lo_x10: 1000, hi_x10: 2500, tier: 2, harvest_count: '9' } });
    const view = await h.progress('book');
    const ordinary = view.animals.find(row => row.id === '60001');
    const duck = view.animals.find(row => row.id === '2060002');
    const config = require('../src/services/ranch-config');
    const giantProduct = config.getRanchGiantProduct(2060002);
    assert.equal(ordinary.giantItem, null, '没有MCAnimalMutation映射的条目不能算巨大');
    assert.equal(duck.giantItem.id, '2065002');
    assert.equal(duck.giantItem.name, giantProduct.item.name);
    assert.equal(duck.giantItem.image, config.getRanchImage(2065002).url, '使用已核验巨大产物自身图');
    assert.notEqual(duck.giantItem.image, duck.image, '巨大图不复用普通图放大');
    assert.equal(duck.giant.bestWeightKg, 11.24);
});

test('4B图鉴坏回包：错类型、空/重复/错档位、零奖励与未领取终态不会确认', async () => {
    const wrong = progressionFixture(); wrong.state.book.type = 1;
    await assert.rejects(wrong.progress('book'), error => error.errorCode === 'RANCH_RESPONSE_MISMATCH');
    for (const mode of ['empty-id', 'duplicate', 'wrong-id', 'empty-rewards', 'not-claimed']) {
        const h = progressionFixture();
        h.handlers.set('ClaimRanchWeightScoreRewardV2', () => {
            if (mode !== 'not-claimed') h.state.weightBook.levels[0].claimed = true;
            return { claimed_ids: mode === 'empty-id' ? [] : mode === 'duplicate' ? [2, 2] : mode === 'wrong-id' ? [3] : [2],
                rewards: mode === 'empty-rewards' ? [] : [{ id: '80021', count: '2' }] };
        });
        const input = { levelId: 2 }, quote = await h.quote('claimWeight', input);
        await assert.rejects(h.call('claimWeight', input, quote.expected), error => error.resultState === 'unknown', mode);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 1);
    }
});

test('4B分享：真实int64映射102，缺失不当未领取，上报与领奖为两次独立确认', async () => {
    const h = progressionFixture();
    const view = await h.progress('share');
    assert.equal(view.known, true);
    assert.equal(view.shareCount, '0');
    assert.equal(view.canClaim, false);
    assert.equal(view.canReport, true);
    await assert.rejects(h.quote('reportDailyShare', {}), error => error.errorCode === 'RANCH_INVALID_ARGUMENT');
    h.handlers.set('ReportShare', input => {
        assert.equal(input.share_id, '102'); assert.equal(input.doc_id, '2101');
        h.state.shareInfos['102'].share_count = '1';
        return { share_infos: h.state.shareInfos };
    });
    h.handlers.set('ClaimShareReward', input => {
        assert.equal(input.share_id, '102');
        h.state.shareInfos['102'].is_claimed = true;
        return { share_infos: h.state.shareInfos, rewards: [{ id: '80021', count: '5' }] };
    });
    const input = { sharedInGame: true }, report = await h.quote('reportDailyShare', input);
    assert.equal((await h.call('reportDailyShare', input, report.expected)).completed, 1);
    assert.equal(h.calls.filter(row => row.method === 'ClaimShareReward').length, 0, '上报不能串联自动领奖');
    const claim = await h.quote('claimDailyShare', {});
    assert.equal((await h.call('claimDailyShare', {}, claim.expected)).completed, 1);
    assert.equal(h.calls.filter(row => row.method === 'ReportShare').length, 1);
    assert.equal(h.calls.filter(row => row.method === 'ClaimShareReward').length, 1);
    assert.equal((await h.quote('claimDailyShare', {})).skipped, true);
    const blocked = progressionFixture();
    blocked.handlers.set('CheckCanShare', () => ({}));
    assert.equal((await blocked.progress('share')).canReport, false, '已结算的空proto3检查回包表示false，不是未知写');
    assert.equal((await blocked.quote('claimDailyShare', {})).skipped, true);
    const absent = progressionFixture(); absent.state.shareInfos = { '1': { share_count: '1', is_claimed: false } };
    const unknown = await absent.progress('share');
    assert.equal(unknown.known, false); assert.equal(unknown.claimed, null);
    assert.equal((await absent.quote('claimDailyShare', {})).skipped, true);
});

test('4B分享坏终态：错102、错误次数、空奖励或未领取都保留unknown，不跨步骤重发', async () => {
    for (const mode of ['wrong-map', 'bad-count', 'empty-reward', 'not-claimed', 'compensation']) {
        const h = progressionFixture(); h.state.shareInfos['102'].share_count = '1';
        h.handlers.set('ClaimShareReward', () => {
            h.state.shareInfos['102'].is_claimed = mode !== 'not-claimed';
            if (mode === 'bad-count') h.state.shareInfos['102'].share_count = '2';
            return { share_infos: mode === 'wrong-map' ? { '1': { share_count: '1', is_claimed: true } } : h.state.shareInfos,
                rewards: mode === 'empty-reward' ? [] : [{ id: '80021', count: '5' }],
                compensated_items: mode === 'compensation' ? [{ id: '1102', count: '1' }] : [] };
        });
        const quote = await h.quote('claimDailyShare', {});
        await assert.rejects(h.call('claimDailyShare', {}, quote.expected), error => error.resultState === 'unknown');
        const count = h.calls.length;
        await assert.rejects(h.quote('reportDailyShare', { sharedInGame: true }), error => error.errorCode === 'RANCH_PENDING_CONFIRMATION');
        assert.equal(h.calls.length, count);
    }
});

test('4B缓存：任务通知/写入使已发旧读取失效，旧结果不回填', async () => {
    const h = progressionFixture();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.handlers.set('TaskInfo', async () => { await held; return h.state.tasksReply; });
    const run = h.progress('tasks').catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    h.network.networkEvents.emit('taskInfoNotify', h.state.tasksReply.task_info);
    release();
    assert.equal((await run).errorCode, 'RANCH_READ_INVALIDATED');
    h.handlers.delete('TaskInfo');
    assert.equal((await h.progress('tasks')).cache.hit, false);
    const before = h.calls.length;
    h.diagnostic.connectionEpoch++;
    assert.equal((await h.progress('tasks')).cache.hit, false);
    assert.ok(h.calls.length > before);
});

test('农场任务推送不会延迟自动领取牧场任务或活跃奖励', () => {
    const vm = require('node:vm'), networkEvents = new (require('node:events').EventEmitter)();
    const scheduled = [];
    const module = { exports: {} };
    vm.runInNewContext(source('src/services/task.js'), { module, exports: module.exports, console,
        require(id) {
            if (id === '../models/store') return { isAutomationOn: () => true };
            if (id === '../utils/network') return { networkEvents, isConnected: () => true, sendMsgAsync: () => { throw new Error('禁止真实RPC'); } };
            if (id === '../utils/proto') return { types: {} };
            if (id === '../utils/utils') return { toLong: value => value, toNum: Number, log() {}, logWarn() {}, sleep: async () => {} };
            if (id === './scheduler') return { createScheduler: () => ({ clearAll() {}, setTimeoutTask: (...args) => scheduled.push(args) }) };
            if (id === './stats') return { recordOperation() {} };
            if (id === '../config/gameConfig') return { getItemById: () => null };
            if (id === './ranch-config') return require('../src/services/ranch-config');
            throw new Error(`未声明依赖: ${id}`);
        },
    });
    module.exports.initTaskSystem();
    scheduled.length = 0;
    const h = progressionFixture();
    networkEvents.emit('taskInfoNotify', h.state.tasksReply.task_info);
    assert.equal(scheduled.length, 0);
    module.exports.cleanupTaskSystem();
});

function commerceFixture(currency = '1005') {
    const h = ranchRuntimeHarness();
    const id = '9007199254740997';
    h.state.market = { opened: true, present: true, period_day: '20261118', round_index: 0,
        shelves: [{ shelf_id: 1, shelf_name: '测试货架', sort: 1 }], goods: [{ goods_id: id, shelf_id: 1, slot: 0,
            item_id: '80021', item_count: '2', cost_item_id: currency, cost_count: '5', discount_price: '2',
            discount_start_time: h.state.serverTime - 1000, discount_end_time: h.state.serverTime + 60000,
            limit_count: '5', limit_used: '0', buy_conds: [{ type: '最低等级', params: '1' }] }] };
    h.state.bag.virtual_items = [{ id: currency, count: '100' }, { id: '1102', count: '0' }];
    h.state.bag.physical_items = [{ id: '80021', uid: '8888', count: '3' }];
    h.state.activityList = { activities: [{ activity: { activity_id: '9000001', name: '牧歌初启',
        type: '10000000001', begin_time: h.state.serverTime - 1000, end_time: h.state.serverTime + 60000 },
        children: [{ activity: { activity_id: '9000002', name: '兴牧庆典', type: 1 } }] }] };
    h.market = () => h.services['ranch-market'].getRanchMarket('10');
    h.activities = group => h.services['ranch-market'].getRanchActivities('10', group || '');
    return h;
}

test('4C集市：实际1005/1008/7002费用与限时折扣，int64商品身份及唯一兑换闭环', async () => {
    for (const currency of ['1005', '1008', '7002']) {
        const h = commerceFixture(currency);
        const view = await h.market();
        assert.equal(view.goods[0].id, '9007199254740997');
        assert.equal(view.goods[0].currencyId, currency);
        assert.equal(view.goods[0].currencyName, require('../src/services/ranch-config').getRanchItem(currency).name);
        assert.equal(view.goods[0].unitPrice, '2');
        assert.equal(view.goods[0].available, true);
        assert.equal((await h.market()).cache.hit, true);
        h.handlers.set('RotationBuyGoods', input => {
            assert.equal(input.goods_id, '9007199254740997'); assert.equal(input.count, 2);
            assert.equal(input.period_day, '20261118'); assert.equal(input.round_index || 0, 0);
            h.state.bag.virtual_items[0].count = '96'; h.state.bag.physical_items[0].count = '7';
            h.state.market.goods[0].limit_used = '2';
            return { card: h.state.market.goods[0], awards: [{ id: '80021', count: '4' }] };
        });
        const input = { goodsId: view.goods[0].id, count: 2 }, quote = await h.quote('exchange', input);
        const result = await h.call('exchange', input, quote.expected);
        assert.equal(result.completed, 2); assert.equal(result.costs[0].count, '4');
        assert.equal(h.calls.filter(row => row.method === 'RotationBuyGoods').length, 1);
        assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
        assert.equal(h.calls.filter(row => row.method === 'AllCells').length, 0, '集市不额外读栏舍');
    }
});

test('4C报价：价差/轮次/额度变化拒绝旧确认，未知规则/免费/未到访不发兑换', async () => {
    for (const changed of ['price', 'round', 'used']) {
        const h = commerceFixture(), input = { goodsId: '9007199254740997', count: 1 };
        const quote = await h.quote('exchange', input);
        if (changed === 'price') h.state.market.goods[0].discount_price = '3';
        if (changed === 'round') h.state.market.round_index = 1;
        if (changed === 'used') h.state.market.goods[0].limit_used = '1';
        await assert.rejects(h.call('exchange', input, quote.expected), error => error.errorCode === 'RANCH_OFFER_CHANGED');
        assert.equal(h.calls.filter(row => row.method === 'RotationBuyGoods').length, 0);
    }
    for (const mode of ['unknown-condition', 'free', 'closed', 'exhausted', 'same-item', 'diamond', 'locked']) {
        const h = commerceFixture(mode === 'diamond' ? '1004' : '1005'), row = h.state.market.goods[0];
        if (mode === 'unknown-condition') row.buy_conds = [{ type: 'VIP', params: '1' }];
        if (mode === 'free') row.discount_price = '0';
        if (mode === 'closed') h.state.market.present = false;
        if (mode === 'exhausted') row.limit_used = '5';
        if (mode === 'same-item') row.item_id = row.cost_item_id;
        if (mode === 'locked') h.state.bag.virtual_items[0].is_locked = true;
        assert.equal((await h.quote('exchange', { goodsId: '9007199254740997', count: 1 })).skipped, true, mode);
        assert.equal(h.calls.filter(row => row.method === 'RotationBuyGoods').length, 0);
    }
});

test('4C坏终态：空/错奖励、错商品、错扣费、坏库存/额度或写后跨轮次均unknown', async () => {
    for (const mode of ['empty', 'wrong-card', 'fee', 'inventory', 'limit', 'round']) {
        const h = commerceFixture();
        h.handlers.set('RotationBuyGoods', () => {
            h.state.bag.virtual_items[0].count = mode === 'fee' ? '95' : '98';
            h.state.bag.physical_items[0].count = mode === 'inventory' ? '3' : '5';
            h.state.market.goods[0].limit_used = mode === 'limit' ? '2' : '1';
            if (mode === 'round') h.state.market.round_index = 1;
            return { card: { ...h.state.market.goods[0], goods_id: mode === 'wrong-card' ? '42' : '9007199254740997' },
                awards: mode === 'empty' ? [] : [{ id: '80021', count: '2' }] };
        });
        const input = { goodsId: '9007199254740997', count: 1 }, quote = await h.quote('exchange', input);
        await assert.rejects(h.call('exchange', input, quote.expected), error => error.resultState === 'unknown', mode);
        const ledger = h.services['ranch-operations-ledger'].ranchOperations;
        assert.equal(ledger.pending('10').length, 1);
        assert.equal(ledger.reserved('10', 'item:1005'), 2n);
        const count = h.calls.length;
        await assert.rejects(h.quote('exchange', { goodsId: '12345', count: 1 }), error => error.errorCode === 'RANCH_PENDING_CONFIRMATION');
        assert.equal(h.calls.length, count, '不能换商品或轮次绕过未知账本');
    }
});

test('牧歌初启：按上游 Muge* 协议显示真实进度并提供可核验领取操作', async () => {
    const h = commerceFixture();
    const view = await h.activities();
    assert.equal(view.activities[0].type, '10000000001');
    assert.equal(view.actionsEnabled, false, '通用活动操作仍关闭');
    assert.equal(view.muge.activityId, '2026111700');
    assert.equal(view.muge.celebration.total, '100');
    assert.equal(view.muge.celebration.tiers[0].status, 2);
    assert.equal(view.muge.friends.count, 1);
    assert.equal(view.muge.handbook.tasks[0].progress, '1');
    assert.equal(view.muge.questions.length, 10);
    assert.deepEqual(h.calls.filter(row => row.method === 'List').map(row => row.input.game_scene_id), [2, 1]);
    h.handlers.set('Operate', input => {
        assert.equal(input.id, '2026111702');
        assert.equal(input.cmd, '85');
        assert.equal(input.global_count_claim_tier.tier_id, '0');
        return { id: input.id, cmd: input.cmd,
            global_count_claim_tier: { claimed_ids: ['1'], awards: [{ id: '7001', count: '1' }] },
            activity: { head: { id: input.id } } };
    });
    const result = await h.services['ranch-muge'].operateRanchMugeActivity('10', 'claimCelebration');
    assert.equal(result.rewards[0].id, '7001');
    assert.equal(h.calls.filter(row => row.method === 'Operate').length, 1);
    await assert.rejects(h.services['ranch-muge'].operateRanchMugeActivity('10', 'saveAnswers', {
        answers: { 1: 99 }, clear: false,
    }), error => error.errorCode === 'RANCH_MUGE_INVALID_ANSWERS');
    assert.equal(h.calls.filter(row => row.method === 'Operate').length, 1, '未知答案不能发写请求');
});

test('4C活动：普通牧场活动保持只读，目录详情仍绑定当前分组', async () => {
    const h = commerceFixture();
    const view = await h.activities();
    assert.equal(view.activities[0].type, '10000000001');
    assert.equal(view.actionsEnabled, false);
    h.handlers.set('GetGroup', input => { assert.equal(input.group_id, '9000001'); return { group: h.state.activityList.activities[0] }; });
    assert.equal((await h.activities('9000001')).detail.id, '9000001');
    const before = h.calls.filter(row => row.method === 'GetGroup').length;
    await assert.rejects(h.activities('9999'), error => error.errorCode === 'RANCH_ACTIVITY_UNAVAILABLE');
    assert.equal(h.calls.filter(row => row.method === 'GetGroup').length, before);
    assert.equal(require('../src/controllers/admin-ranch-routes').ALLOWED_RANCH_ACTIONS.has('claimActivity'), false);
});

test('4C安全复查：图片hash缓存必须按本条声明核验，不能借同URL的另一条成功结果', () => {
    const crypto = require('node:crypto');
    const original = require('../src/gameConfig/ranch/image-manifest.json').items['60001'];
    const bytes = fs.readFileSync(path.join(SRC, 'gameConfig', original.url.slice('/game-config/'.length)));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const row = { url: '/game-config/ranch/item-icons/60001.png', officialOriginVerified: true, sha256: digest };
    const manifest = { sourceCommit: '6ac7a3d7930018058d201af86beea8de6a9f8507', gameRpcSent: false,
        items: { '60001': { ...row, resource: 'texture/60001_1' }, '60002': { ...row, resource: 'texture/60002_1', sha256: '0'.repeat(64) } } };
    const mockedFs = { existsSync: () => true, statSync: filename => ({ mtimeMs: 1, size: filename.endsWith('image-manifest.json') ? 1 : bytes.length }),
        lstatSync: () => ({ isSymbolicLink: () => false }), readFileSync: filename => filename.endsWith('image-manifest.json') ? JSON.stringify(manifest) : bytes };
    const module = { exports: {} };
    require('node:vm').runInNewContext(source('src/services/ranch-art.js'), { module, exports: module.exports, __dirname: path.join(SRC, 'services'),
        require: name => name === 'node:fs' ? mockedFs : require(name) });
    assert.ok(module.exports.image('60001', false, 'texture/60001_1'));
    assert.equal(module.exports.image('60002', false, 'texture/60002_1'), null, '同路径缓存不能替错误的hash声明作证');
});

test('场景缓存安全复查：unknown本身足够闭锁，不能依赖recoveryRequired附加标志', async () => {
    const h = ranchRuntimeHarness(), cache = h.services['ranch-readonly'].createSceneReadCache(3000);
    let phase = 'home', reads = 0;
    const options = { keyOf: () => 'stable-owner-generation', states: () => [{ phase, recoveryRequired: false }],
        load: async ({ onStart }) => { onStart(); reads++; if (phase === 'unknown') throw new Error('unknown-scene'); return { stamp: reads }; } };
    assert.equal((await cache.read(options)).hit, false);
    assert.equal((await cache.read(options)).hit, true);
    phase = 'unknown';
    await assert.rejects(cache.read(options), /unknown-scene/);
    phase = 'home'; cache.invalidate();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const flight = cache.read({ ...options, load: async ({ onStart }) => { onStart(); await gate; return { stamp: 'late' }; } });
    await Promise.resolve(); await Promise.resolve(); phase = 'unknown'; release();
    await assert.rejects(flight, error => error.errorCode === 'RANCH_READ_INVALIDATED');
    phase = 'home'; assert.equal((await cache.read(options)).hit, false, 'unknown期间的迟到读不得回填缓存');
});

test('牧场发布候选必须包含scene2好友字段与成长商城支付协议，不能只部署ranchpb', () => {
    const deploy = fs.readFileSync(path.resolve(ROOT, '../cloudbase/.ref/deploy.py'), 'utf8');
    const start = deploy.indexOf('RANCH_AUDIT_BACKEND_FILES =');
    const end = deploy.indexOf('RANCH_AUDIT_FRONTEND_FILES =', start);
    assert.ok(start >= 0 && end > start);
    const candidate = deploy.slice(start, end);
    for (const file of ['friendpb.proto', 'taskpb.proto', 'sharepb.proto', 'mallpb.proto', 'paypb.proto', 'illustratedpb.proto']) {
        assert.ok(candidate.includes(`'core/src/proto/${file}'`), `候选漏协议: ${file}`);
    }
    assert.ok(candidate.includes("'core/src/services/friend-api.js'"));
});

test('4C官方图片：新缓存补图源身份/像素hash一致，设施与巨大图独立且未声明牧草保持缺图', () => {
    const config = require('../src/services/ranch-config');
    const manifest = require('../src/gameConfig/ranch/image-manifest.json');
    assert.equal(Object.keys(manifest.items).length, 183); assert.equal(Object.keys(manifest.facilities).length, 24);
    assert.deepEqual(manifest.unresolved.map(row => row.id), [7001]);
    const provenance = JSON.parse(fs.readFileSync(path.join(SRC, 'gameConfig/art-resource-sources.json'), 'utf8'));
    const declared = new Map(provenance.manifests.map(row => [row.url, row.sha256]));
    assert.ok(fs.readFileSync(path.join(SRC, 'gameConfig/art-resource-sources.json')).equals(
        fs.readFileSync(path.resolve(ROOT, '../web/public/game-config/art-resource-sources.json'))));
    for (const [rows, facility] of [[manifest.items, false], [manifest.facilities, true]]) for (const row of Object.values(rows)) {
        assert.equal(config.getRanchImage(row.id, facility).url, row.url);
        assert.equal(row.source.officialOriginVerified, true);
        assert.equal(row.source.resource, row.resource);
        assert.match(row.source.manifest.url, /^https:\/\/cdn-resource\.nqf\.qq\.com\/release\/remote\/[A-Za-z0-9]+\/config\.[a-f0-9]+\.json$/);
        assert.equal(declared.get(row.source.manifest.url), row.source.manifest.sha256);
        const relative = row.url.slice('/game-config/'.length), left = fs.readFileSync(path.join(SRC, 'gameConfig', relative));
        const right = fs.readFileSync(path.resolve(ROOT, '../web/public/game-config', relative));
        assert.ok(left.equals(right)); assert.equal(require('node:crypto').createHash('sha256').update(left).digest('hex'), row.sha256);
    }
    assert.equal(config.getRanchImage(3601001), null, '建筑物品错误的动物头像不能成为设施图');
    assert.notEqual(config.getRanchImage(65002).url, config.getRanchImage(60002).url, '巨大幼崽使用独立来源图');
    assert.equal(config.getRanchImage(7001), null, '未声明texture/Crop_40不能冒用装扮7001');
});

test('4C完整状态：下一时间只选未来，预计收益/货架/限次与原始巨型字段保留', () => {
    const { animalDto, ranchDto } = require('../src/services/ranch-readonly');
    const now = Date.now(), dto = animalDto({ animal_id: '60001', animal_inst_id: 1, stage: 2,
        infant_ready_at_ms: now - 1000, grow_ready_at_ms: now + 10000, limited_can_used: true,
        expected_harvest_sells: [{ id: '1007', count: '12' }], mutation: { mutation_type: 1, weight_display_x10: 1124 } }, now);
    assert.equal(dto.nextAtMs, now + 10000); assert.equal(dto.limitedCanUsed, true);
    assert.equal(dto.expectedHarvest.items[0].count, '12'); assert.equal(dto.mutation.displayWeightX10, 1124);
    const ranch = ranchDto({ shelves: [{ slot_index: 1, total_remain: '3', can_collect: true,
        lots: [{ item_id: '1060001', remain_num: '3', base_num: '5', stolen_num: '2' }] }], hazards: [{ hazard_id: '111', hazard_type: 2, owner: '999' }] });
    assert.equal(ranch.shelves[0].products[0].count, '3'); assert.equal(ranch.shelves[0].products[0].stolenCount, '2');
    assert.equal(ranch.hazards[0].ownerGid, '999');
});

test('上游修复：牧场名单只用scene2状态，35条分批/共享读/昵称与两代际隔离', async () => {
    const h = ranchRuntimeHarness();
    h.state.knownGids = Array.from({ length: 81 }, (_, i) => i + 20001);
    h.handlers.set('GetGameFriends', input => ({ application_count: 0, game_friends: input.gids.map((gid, i) => ({
        gid, name: '牧场昵称' + gid, remark: '农场备注', ...(i === 0 ? {} : { big_farm_status: { can_steal: true } }),
    })) }));
    const service = h.services['ranch-friends'];
    const [a, b] = await Promise.all([service.getRanchFriendRoster(), service.getRanchFriendRoster()]);
    assert.equal(a.sceneId, 2); assert.equal(a.friends.length, 78);
    assert.equal(b.friends.length, a.friends.length);
    const reads = h.calls.filter(row => row.method === 'GetGameFriends');
    assert.deepEqual(reads.map(row => row.input.gids.length), [35, 35, 11]);
    assert.ok(reads.every(row => row.input.global_scene_id === 2));
    assert.ok(a.friends.every(row => row.name.startsWith('牧场昵称')));
    assert.equal(h.calls.filter(row => row.method === 'EnterHomestead').length, 0);
    h.diagnostic.remoteGeneration = '2';
    await service.getRanchFriendRoster();
    assert.equal(h.calls.filter(row => row.method === 'GetGameFriends').length, 6);
});

test('上游修复：牧场名单让路保留已确认批次，失败与真实代际变化不借旧进度', async () => {
    const h = ranchRuntimeHarness(), service = h.services['ranch-friends'];
    h.state.knownGids = Array.from({ length: 70 }, (_, i) => i + 20001);
    h.handlers.set('GetGameFriends', input => ({ game_friends: input.gids.map(gid => ({ gid, name: 'R', big_farm_status: {} })) }));
    let first = true;
    await assert.rejects(h.services['scene-session'].withGameScene(2, ({ session }) => service.loadRanchFriendRoster(session, completed => {
        if (completed && first) { first = false; throw Object.assign(new Error('yield'), { errorCode: 'RANCH_AUTOMATION_YIELD' }); }
    })), /yield/);
    const result = await h.services['scene-session'].withGameScene(2, ({ session }) => service.loadRanchFriendRoster(session));
    assert.equal(result.friends.length, 70);
    assert.deepEqual(h.calls.filter(row => row.method === 'GetGameFriends').map(row => row.input.gids[0]), ['20001', '20036']);
    h.diagnostic.remoteGeneration = '2';
    await service.getRanchFriendRoster();
    assert.equal(h.calls.filter(row => row.method === 'GetGameFriends').length, 4);
});

test('并发复查：牧场名单部分批次失效后从头重读，通知期间的旧批次不拼接或缓存', async () => {
    const h = ranchRuntimeHarness(), service = h.services['ranch-friends'];
    h.state.knownGids = Array.from({ length: 70 }, (_, i) => i + 20001);
    let nickname = '旧';
    h.handlers.set('GetGameFriends', input => ({ game_friends: input.gids.map(gid => ({ gid, name: nickname, big_farm_status: {} })) }));
    await assert.rejects(h.services['scene-session'].withGameScene(2, ({ session }) => service.loadRanchFriendRoster(session, completed => {
        if (completed) throw new Error('slice-yield');
    })), /slice-yield/);
    nickname = '新';
    h.network.networkEvents.emit('ranchDataChanged');
    const result = await service.getRanchFriendRoster();
    assert.equal(result.friends.length, 70);
    assert.ok(result.friends.every(friend => friend.name === '新'));
    assert.deepEqual(h.calls.filter(row => row.method === 'GetGameFriends').map(row => row.input.gids[0]), ['20001', '20001', '20036']);
    assert.equal((await service.getRanchFriendRoster()).cache.hit, true);
    service.clearRanchFriendCache();
    let invalidateOnce = true;
    h.handlers.set('GetGameFriends', input => {
        if (invalidateOnce) { invalidateOnce = false; h.network.networkEvents.emit('ranchDataChanged'); }
        return { game_friends: input.gids.map(gid => ({ gid, name: '过期中途回包', big_farm_status: {} })) };
    });
    await assert.rejects(service.getRanchFriendRoster(), error => error.errorCode === 'RANCH_READ_INVALIDATED');
    nickname = '最终';
    h.handlers.set('GetGameFriends', input => ({ game_friends: input.gids.map(gid => ({ gid, name: nickname, big_farm_status: {} })) }));
    const fresh = await service.getRanchFriendRoster();
    assert.ok(fresh.friends.every(friend => friend.name === '最终'));
    assert.equal(fresh.cache.hit, false);
});

test('上游修复：巡查跨三个6秒写切片续跑，后续催产和好友不再饥饿', async () => {
    const h = automationHarness({ ranch: true, ranch_harvest: true, ranch_produce: true, ranch_friend_steal: true, ranch_check_minutes: 30 },
        { advanceAfterWrite: 6000, friends: [{ gid: 20001, name: 'R' }] });
    await h.api.run({ farmDeadline: () => h.now() + 300000 }); h.advance(30000);
    await h.api.run({ farmDeadline: () => h.now() + 300000 }); h.advance(30000);
    await h.api.run({ farmDeadline: () => h.now() + 300000 });
    assert.deepEqual(h.calls.writes, ['harvest', 'produce']);
    assert.deepEqual(h.calls.friendVisits, [20001]);
});

test('上游修复：同好友偷取先于清理，让路后不重复偷且优先用访问昵称记录确认产出', async () => {
    const h = ranchRuntimeHarness(), service = h.services['ranch-friends'];
    const ranch = readyRanch(h, 1);
    ranch.shelves = [{ slot_index: 1, can_steal: true, lots: [{ item_id: 1060001, remain_num: 2, can_steal: true, stealers: [] }] }];
    ranch.hazards = [{ hazard_id: 501, hazard_type: 2, owner: 20001 }];
    h.handlers.set('StealProduce', () => ({ ranches: [ranch], op_results: [{ facility_inst_id: 88, kind: 2, target_id: 1, rewards: [{ id: 1060001, count: 1 }] }] }));
    h.handlers.set('CleanAllRanch', () => ({ ranches: [{ ...ranch, hazards: [] }], op_results: [{ facility_inst_id: 88, kind: 3, target_id: 501, rewards: [] }] }));
    const progress = {}, outcomes = [];
    const enabled = action => ['steal', 'cleanFriend'].includes(action);
    const visit = pause => h.services['scene-session'].withGameScene(2, ({ session }) => service.automateRanchFriend(session, '10',
        { gid: 20001, name: '旧备注' }, enabled, pause, progress, (result, nickname) => outcomes.push([result.action, nickname])));
    const first = await visit(acted => acted);
    assert.equal(first.yielded, true); assert.equal(progress.steal, true); assert.equal(progress.cleanFriend, undefined);
    const second = await visit(() => false);
    assert.equal(second.yielded, false);
    assert.deepEqual(h.calls.filter(row => ['StealProduce', 'CleanAllRanch'].includes(row.method)).map(row => row.method), ['StealProduce', 'CleanAllRanch']);
    assert.deepEqual(outcomes, [['steal', '好友'], ['cleanFriend', '好友']]);
});

test('发送前名单变更：已发偷取照常确认，撤销的放蚊不发送、不留未知账本', async () => {
    const h = ranchRuntimeHarness();
    const ranch = readyRanch(h, 1);
    ranch.shelves = [{ slot_index: 1, can_steal: true, lots: [{ item_id: 1060001, remain_num: 2, can_steal: true }] }];
    h.state.automation = { ranch: true, ranch_friend_steal: true, ranch_friend_mosquito: true, friend_steal_only_gids: ['20001'] };
    h.state.badTargets = [20001];
    h.state.knownGids = [20001];
    h.handlers.set('GetGameFriends', () => ({ game_friends: [{ gid: 20001, big_farm_status: {} }] }));
    h.handlers.set('StealProduce', () => ({ ranches: [ranch], op_results: [
        { facility_inst_id: 88, kind: 2, target_id: 1, rewards: [{ id: 1060001, count: 1 }] },
    ] }));
    const attempted = [];
    h.state.beforeSend = async method => {
        if (method !== 'PutHazard') return;
        attempted.push(method);
        h.state.badTargets = [20002];
    };
    const result = await h.services['ranch-automation'].run();
    assert.equal(result.actions, 1);
    assert.deepEqual(attempted, ['PutHazard'], '确实已排到放蚊发送前，而非在较早的候选阶段跳过');
    assert.deepEqual(h.calls.filter(row => ['StealProduce', 'PutHazard'].includes(row.method)).map(row => row.method), ['StealProduce']);
    assert.equal(h.services['ranch-operations-ledger'].ranchOperations.pending('10').length, 0);
    assert.equal(h.services['ranch-automation'].getRoutineState().lastResult, 'confirmed');
    assert.ok(h.calls.some(row => row.method === 'LeaveHomestead'));
    assert.equal(h.calls.at(-1).input.global_scene_id, 1, '未发送不影响正常离场和恢复');
});

test('上游修复：次数耗尽须有服务端证据，跨北京时间游戏日/账号隔离，普通名单不解除保护', async () => {
    const h = ranchRuntimeHarness(), service = h.services['ranch-friends'];
    h.handlers.set('GetRanchOpTimes', () => ({ ops: [{ op_id: 11009, times_limit: 3, used_times: 3, remaining_times: 0 },
        { op_id: 11003, times_limit: 0, used_times: 0, remaining_times: 0 }] }));
    await service.getRanchFriendOverview(20001);
    assert.ok(service.getInteractionQuotaResetAt('stroke') > Date.now());
    assert.equal(service.getInteractionQuotaResetAt('putMosquito'), 0, '未确认上限的零值不记耗尽');
    h.setOwner(10011); assert.equal(service.getInteractionQuotaResetAt('stroke'), 0);
    h.setOwner(10010); assert.ok(service.getInteractionQuotaResetAt('stroke') > 0);
    h.state.serverTime += 86400000; assert.equal(service.getInteractionQuotaResetAt('stroke'), 0);
    const off = automationHarness({ ranch: true, ranch_friend_stroke: true, ranch_friend_mosquito: true }, { exhausted: ['stroke', 'putMosquito'] });
    assert.equal(off.api.getRoutineState().enabled, false);
    await off.api.run(); assert.equal(off.calls.scene, 0);
});

test('三期3B源码接线完整且不创建独立调度器', () => {
    const manual = source('src/services/ranch-manual.js');
    const friends = source('src/services/ranch-friends.js');
    const friendSession = source('src/services/ranch-friend-session.js');
    const routes = source('src/controllers/admin-ranch-routes.js');
    const worker = source('src/core/worker.js');
    const automation = source('src/services/ranch-automation.js');
    assert.match(friends, /EnterHomestead/);
    assert.match(friends, /StealProduce/);
    assert.match(friends, /PutHazard/);
    assert.match(friends, /StrokeAnimal/);
    assert.match(friendSession, /LeaveHomestead/);
    assert.match(friendSession, /holdUntilTransportEpochChanged/);
    assert.match(manual, /FRIEND_ACTIONS/);
    assert.doesNotMatch(automation, /setInterval|setTimeoutTask|createScheduler/, '好友牧场也不得创建独立定时器');
    assert.match(worker, /runRanchTick/);
    assert.match(worker, /if \(shouldRanch\) \{[\s\S]*?await runFarmTick\(latestAuto\);[\s\S]*?await runRanchTick\(\)/);
    assert.match(source('src/runtime/gateway-client.js'), /assertGameRequestAllowed\(service, method\)/);
    assert.match(source('src/utils/network.js'), /assertGameRequestAllowed\(serviceName, methodName\)/);
    assert.doesNotMatch(manual, /RANCH_CURRENCY_ID\s*=/, '购买币种不得硬编码');
    assert.match(manual, /currencyId: valid \? Number\(config\.price_id\)/, '币种须来自固定商品配置并校验服务端商品');
    assert.match(manual, /good\.remaining !== null && count > good\.remaining/, '不限购null不能误拒购买');
    assert.match(manual, /Promise\.all\(\[/, 'AllCells与GetBag应在scene2并行强读');
    assert.match(manual, /uid: bigText\(item\.uid\)/, '场景2出售必须携带物品uid');
    assert.match(manual, /resourceKey: `item:\$\{item\.id\}`/, '账本费用必须转换为资源预留字段');
    assert.match(manual, /connectionEpoch/, '目录缓存key必须含连接代际');
    assert.match(manual, /remoteGeneration/, '目录缓存key必须含远端代际');
    assert.match(manual, /clearRanchCatalogCache\(accountId\)/, '写后必须失效目录缓存');
    assert.match(manual, /createSceneReadCache\(CATALOG_CACHE_MS\)/, '商品目录复用可取消等待且原始结算独立的场景缓存');
    assert.match(source('src/services/ranch-readonly.js'), /createSceneReadCache\(CACHE_TTL_MS\)/, '自家overview复用场景缓存');
    assert.match(friends, /createSceneReadCache\(CACHE_TTL_MS\)/, '好友overview按host和代际复用场景缓存');
    assert.match(manual, /use_gold: false/);
    assert.match(routes, /ALLOWED_RANCH_ACTIONS/);
    assert.match(worker, /'getRanchPendingOperations'/);
    assert.match(source('src/services/ranch-readonly.js'), /actionsEnabled: true/);
    const store = source('src/models/store.js');
    for (const key of ['ranch', 'ranch_harvest', 'ranch_produce', 'ranch_clean', 'ranch_sell',
        'ranch_grass', 'ranch_grass_buy', 'ranch_feed_normal', 'ranch_feed_organic', 'ranch_complete_upgrade',
        'ranch_friend_steal', 'ranch_friend_clean', 'ranch_friend_stroke', 'ranch_friend_mosquito']) {
        assert.match(store, new RegExp(`${key}: false`), `${key}必须默认关闭`);
    }
    assert.match(store, /ranch_check_minutes: 30/);
    const controller = source('src/controllers/admin-farm-resource-routes.js');
    assert.match(controller, /setAutomationBatch\(accountId, body\)/, '多开关保存必须单次原子应用');
    assert.doesNotMatch(controller, /for \(const \[key, value\] of Object\.entries\(req\.body\)\)/);
});
