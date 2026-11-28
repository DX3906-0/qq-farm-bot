'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const SRC = path.resolve(__dirname, '../src');
const { types } = require('../src/utils/proto');
const typeNames = [
    'GetPlayerSceneInfoRequest', 'GetPlayerSceneInfoReply',
    'PlayerSceneLoginRequest', 'PlayerSceneLoginReply',
    'PlayerLoginRequest', 'PlayerLoginReply',
];
const previousTypes = typeNames.map(name => types[name]);
const root = new protobuf.Root();

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function playerReply(gid = 12002) {
    return types.PlayerLoginReply.encode(types.PlayerLoginReply.create({
        basic: { gid, name: 'test-player' },
        time_now_millis: 1730000000000,
        version_info: { status: 0, res_version: 'test-res' },
        global_scene_id: 2,
        unlocked_scene_ids: [1],
    })).finish();
}

function sceneInfo(activeSceneId = 1, unlockedSceneIds = [1]) {
    return types.GetPlayerSceneInfoReply.encode(types.GetPlayerSceneInfoReply.create({
        default_global_scene_id: 1,
        active_global_scene_id: activeSceneId,
        unlocked_scenes: unlockedSceneIds,
    })).finish();
}

function session() {
    return {
        id: 1,
        accountId: '2',
        gid: 12002,
        connectionEpoch: 9,
        remoteGeneration: '44',
        remoteGenerationSource: 'gateway',
        context: { priority: 'foreground', deadline: Date.now() + 60000 },
        sceneClosing: false,
    };
}

function expected(s = session()) {
    return {
        actorId: 2,
        accountId: s.accountId,
        gid: s.gid,
        connectionEpoch: s.connectionEpoch,
        remoteGeneration: s.remoteGeneration,
        remoteGenerationSource: 'gateway',
    };
}

function makeHarness(options = {}) {
    const s = options.session || session();
    let sceneRecord = options.record ? clone(options.record) : null;
    let upgradeRecord = options.upgradeRecord ? clone(options.upgradeRecord) : null;
    const calls = [];
    const writes = [];
    let sceneInfoIndex = 0;
    const { createSceneSession } = require('../src/services/scene-session');
    const service = createSceneSession({
        loadRecord: () => clone(sceneRecord),
        saveRecord: (_accountId, record) => {
            writes.push(clone(record));
            sceneRecord = clone(record);
        },
        loadUpgradeRecord: () => clone(upgradeRecord),
        saveUpgradeRecord: (_scope, record, { exclusive } = {}) => {
            if (exclusive && upgradeRecord) {
                throw Object.assign(new Error('already attempted'), { errorCode: 'SCENE_UPGRADE_ALREADY_ATTEMPTED' });
            }
            upgradeRecord = clone(record);
        },
        runOperation: async (_name, task, operationOptions) => {
            calls.push({ type: 'operation', options: operationOptions });
            return task(s);
        },
        validateSession: () => {},
        getDiagnostic: () => ({ accountId: s.accountId, connected: true, loggedIn: true,
            connectionEpoch: s.connectionEpoch, remoteGeneration: s.remoteGeneration,
            remoteGenerationSource: s.remoteGenerationSource }),
        getUserState: () => ({ gid: s.gid }),
        friendState: () => ({ resultState: options.friendResultState || 'idle' }),
        ranchFriendState: () => ({ resultState: options.ranchFriendResultState || 'idle' }),
        runRequest: async (_session, serviceName, method, body, requestOptions) => {
            calls.push({ type: 'request', serviceName, method, body: Buffer.from(body), options: requestOptions });
            if (method === 'GetPlayerSceneInfo') {
                const payloads = options.sceneInfoPayloads || [sceneInfo(1, options.initialUnlocked || [1])];
                const payload = payloads[Math.min(sceneInfoIndex, payloads.length - 1)];
                sceneInfoIndex += 1;
                return { body: payload };
            }
            if (method === 'PlayerLogin') {
                const request = types.PlayerLoginRequest.decode(body);
                assert.equal(request.game_scene_id, 1);
                assert.equal(request.scene_id, '1256');
                assert.equal(Number(request.sharer_id), 0);
                assert.equal(Number(request.share_cfg_id), 0);
                assert.equal(request.device_info.client_version.length > 0, true);
                assert.equal(request.device_info.sys_software.length > 0, true);
                requestOptions.lifecycle?.markSent();
                if (options.loginError) throw options.loginError;
                return { body: playerReply(options.replyGid ?? s.gid) };
            }
            if (method === 'PlayerSceneLogin') {
                const request = types.PlayerSceneLoginRequest.decode(body);
                assert.equal(request.global_scene_id, 1);
                assert.equal(requestOptions.cleanup, true);
                if (options.homeError) throw options.homeError;
                return { body: types.PlayerSceneLoginReply.encode(types.PlayerSceneLoginReply.create({
                    global_scene_id: options.homeReplySceneId ?? 1,
                })).finish() };
            }
            throw new Error(`Unexpected request method: ${method}`);
        },
    });
    return {
        service,
        calls,
        writes,
        get sceneRecord() { return sceneRecord; },
        get upgradeRecord() { return upgradeRecord; },
        session: s,
    };
}

test.before(() => {
    root.loadSync([
        path.join(SRC, 'proto/corepb.proto'),
        path.join(SRC, 'proto/userpb.proto'),
        path.join(SRC, 'proto/player-login.proto'),
        path.join(SRC, 'proto/globalscenepb.proto'),
    ], { keepCase: true });
    for (const name of typeNames) {
        const packageName = name.startsWith('GetPlayer') || name.startsWith('PlayerScene')
            ? 'gamepb.globalscenepb' : 'gamepb.userpb';
        types[name] = root.lookupType(`${packageName}.${name}`);
    }
});

test.after(() => {
    typeNames.forEach((name, index) => {
        if (previousTypes[index] === undefined) delete types[name];
        else types[name] = previousTypes[index];
    });
});

test('成功时仅发送一次 PlayerLogin，显式确认 HOME 并如实返回解锁信息', async () => {
    const h = makeHarness({ sceneInfoPayloads: [sceneInfo(1, [1]), sceneInfo(1, [1])] });
    const result = await h.service.upgradeGlobalLogin(expected(h.session));

    assert.equal(result.actorId, 2);
    assert.equal(result.profile, 'player');
    assert.equal(result.playerLoginSent, true);
    assert.equal(result.homeConfirmed, true);
    assert.equal(result.activeSceneId, 1);
    assert.deepEqual(result.unlockedSceneIds, [1]);
    assert.equal(result.ranchAccessConfirmed, false);
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'PlayerLogin').length, 1);
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'GetPlayerSceneInfo').length, 2);
    assert.equal(h.calls.find(call => call.type === 'operation').options.sceneSensitive, true);
    assert.equal(h.sceneRecord.phase, 'home');
    assert.equal(h.sceneRecord.proof, 'player_login_home_scene_confirmed');
    assert.equal(h.upgradeRecord.phase, 'succeeded');
});

test('expected 身份不匹配时 not_sent 且不查询、不写入、不发送', async () => {
    const h = makeHarness();
    const wrong = { ...expected(h.session), connectionEpoch: h.session.connectionEpoch + 1 };

    await assert.rejects(h.service.upgradeGlobalLogin(wrong), error => {
        assert.equal(error.errorCode, 'SCENE_UPGRADE_SCOPE_MISMATCH');
        assert.equal(error.resultState, 'not_sent');
        return true;
    });
    assert.equal(h.calls.filter(call => call.type === 'request').length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.upgradeRecord, null);
});

test('已有 unknown 场景记录时拒绝且原样保留记录', async () => {
    const oldRecord = {
        version: 1, accountId: '2', gid: 12002, connectionEpoch: 8,
        remoteGeneration: '43', remoteGenerationSource: 'gateway',
        phase: 'unknown', sceneId: 2, proof: null, updatedAt: 1700000000000,
    };
    const oldBytes = JSON.stringify(oldRecord);
    const h = makeHarness({ record: oldRecord });

    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_STATE_UNKNOWN' });
    assert.equal(JSON.stringify(h.sceneRecord), oldBytes);
    assert.equal(h.writes.length, 0);
    assert.equal(h.calls.filter(call => call.type === 'request').length, 0);
});

test('同一账号游戏代际重放会被持久升级记录挡住', async () => {
    const h = makeHarness();
    await h.service.upgradeGlobalLogin(expected(h.session));
    const requestCount = h.calls.filter(call => call.type === 'request').length;

    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_UPGRADE_ALREADY_ATTEMPTED' });
    assert.equal(h.calls.filter(call => call.type === 'request').length, requestCount);
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'PlayerLogin').length, 1);
});

test('PlayerLogin 超时后持久 unknown 并闭锁后续农场场景', async () => {
    const timeout = Object.assign(new Error('timeout'), {
        code: 'REQUEST_TIMEOUT', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    const h = makeHarness({ loginError: timeout });

    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_UPGRADE_RESULT_UNKNOWN' });
    assert.equal(h.sceneRecord.phase, 'unknown');
    assert.equal(h.upgradeRecord.phase, 'unknown');
    const requestCount = h.calls.filter(call => call.type === 'request').length;
    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_STATE_UNKNOWN' });
    assert.equal(h.calls.filter(call => call.type === 'request').length, requestCount);
});

test('PlayerLogin 回包 GID 不匹配时不接受身份并保留 unknown 锁', async () => {
    const h = makeHarness({ replyGid: 99999 });

    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_UPGRADE_RESULT_UNKNOWN' });
    assert.equal(h.sceneRecord.phase, 'unknown');
    assert.equal(h.upgradeRecord.phase, 'unknown');
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'PlayerSceneLogin').length, 0);
});

test('HOME 确认失败不能记为成功，且升级继续闭锁', async () => {
    const homeError = Object.assign(new Error('home timeout'), {
        code: 'SCENE_TIMEOUT', sent: true, resultState: 'unknown', outcomeUnknown: true,
    });
    const h = makeHarness({ homeError });

    await assert.rejects(h.service.upgradeGlobalLogin(expected(h.session)), { errorCode: 'SCENE_UPGRADE_RESULT_UNKNOWN' });
    assert.equal(h.sceneRecord.phase, 'unknown');
    assert.equal(h.upgradeRecord.phase, 'unknown');
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'GetPlayerSceneInfo').length, 1);
});

test('服务端已报告解锁 scene2 时返回 noop 且不发送 PlayerLogin', async () => {
    const h = makeHarness({ initialUnlocked: [1, 2] });
    const result = await h.service.upgradeGlobalLogin(expected(h.session));

    assert.equal(result.noop, true);
    assert.equal(result.playerLoginSent, false);
    assert.equal(result.ranchAccessConfirmed, true);
    assert.equal(h.calls.filter(call => call.type === 'request' && call.method === 'PlayerLogin').length, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.upgradeRecord, null);
});
