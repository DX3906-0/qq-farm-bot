'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

const protocol = require('../src/services/player-login-protocol');

const root = new protobuf.Root();
let types;

test.before(async () => {
    await root.load([
        path.join(__dirname, '../src/proto/userpb.proto'),
        path.join(__dirname, '../src/proto/player-login.proto'),
    ], { keepCase: true });
    root.resolveAll();
    types = {
        LoginRequest: root.lookupType('gamepb.userpb.LoginRequest'),
        LoginReply: root.lookupType('gamepb.userpb.LoginReply'),
        PlayerLoginRequest: root.lookupType('gamepb.userpb.PlayerLoginRequest'),
        PlayerLoginReply: root.lookupType('gamepb.userpb.PlayerLoginReply'),
    };
});

const deviceInfo = {
    client_version: '1.16.1.6_20261028',
    sys_software: 'Windows',
    device_id: 'protocol-test-device',
};

function playerReply(overrides = {}) {
    return types.PlayerLoginReply.encode(types.PlayerLoginReply.create({
        basic: { gid: 1220537209, name: 'player' },
        time_now_millis: 1730000000000,
        version_info: { status: 0, res_version: 'player-res' },
        global_scene_id: 2,
        unlocked_scene_ids: [1, 2],
        ...overrides,
    })).finish();
}

function legacyReply(overrides = {}) {
    return types.LoginReply.encode(types.LoginReply.create({
        basic: { gid: 1220537209, name: 'legacy' },
        time_now_millis: 1730000000000,
        version_info: { status: 0, res_version: 'legacy-res' },
        ...overrides,
    })).finish();
}

test('buildRequest 用实际 protobufjs schema 锁定 player 与 legacy 的字段差异', () => {
    const player = protocol.buildRequest(types, deviceInfo, 'player', {
        sharer_id: 42,
        ark_biz_type: 7,
        ark_biz_param: Buffer.from('ark'),
        game_scene_id: 2,
    });
    const legacy = protocol.buildRequest(types, deviceInfo, 'legacy', { sharer_id: 42 });

    assert.equal(player.service, 'gamepb.userpb.UserService');
    assert.equal(player.method, 'PlayerLogin');
    assert.equal(legacy.method, 'Login');
    assert.equal(player.body.toString('hex').startsWith('082a'), true, 'player sharer_id 必须是 field 1');
    assert.equal(legacy.body.toString('hex').startsWith('182a'), true, 'legacy sharer_id 必须是 field 3');
    assert.equal(player.body.includes(Buffer.from('5807', 'hex')), true, 'player ark_biz_type 必须是 field 11');
    assert.equal(player.body.includes(Buffer.from('6203', 'hex')), true, 'player ark_biz_param 必须是 bytes field 12');
    assert.equal(player.body.includes(Buffer.from('6802', 'hex')), true, 'player game_scene_id 必须是 field 13');

    const playerDecoded = types.PlayerLoginRequest.decode(player.body);
    const legacyDecoded = types.LoginRequest.decode(legacy.body);
    assert.equal(playerDecoded.device_info.client_version, deviceInfo.client_version);
    assert.equal(legacyDecoded.device_info.client_version, deviceInfo.client_version);
    assert.deepEqual([...playerDecoded.ark_biz_param], [...Buffer.from('ark')]);
});

test('缺少 profile 或 protobuf types 时明确拒绝，不自动回退', () => {
    assert.throws(
        () => protocol.buildRequest(types, deviceInfo),
        error => error.code === 'PLAYER_LOGIN_PROFILE_REQUIRED'
    );
    assert.throws(
        () => protocol.buildRequest({ LoginRequest: types.LoginRequest }, deviceInfo, 'player'),
        error => error.code === 'PLAYER_LOGIN_PROTO_UNAVAILABLE'
    );
    assert.throws(
        () => protocol.buildRequest(types, deviceInfo, 'new-login'),
        error => error.code === 'PLAYER_LOGIN_PROFILE_REQUIRED'
    );
});

test('player reply 只接受真实 player schema，且身份 GID 必须是正 safe integer', () => {
    const request = protocol.buildRequest(types, deviceInfo, 'player');
    const reply = request.replyDecoder(playerReply());
    const normalized = protocol.validateLoginReply('player', reply);

    assert.equal(normalized.actualProfile, 'player');
    assert.equal(normalized.basic.gid, 1220537209);
    assert.equal(normalized.globalScene.id, 2);
    assert.deepEqual(normalized.globalScene.unlockedSceneIds, [1, 2]);
    assert.deepEqual(normalized.versionInfo, { version_recommend: null, version_force: null });
    assert.equal(normalized.globalScene.ranchUnlocked, true);
    assert.equal(normalized.homeSceneConfirmed, false);
    assert.equal(normalized.canBroadcastLoggedIn, false);

    for (const gid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740993']) {
        assert.throws(
            () => protocol.validateLoginReply('player', {
                basic: { gid },
                version_info: {},
                global_scene_id: 2,
                unlocked_scene_ids: [1, 2],
            }),
            /GID|gid|safe|正整数|安全整数|身份/
        );
    }
});

test('global_scene_id 不单独证明牧场解锁，unlocked_scene_ids 必须是合法 int32', () => {
    const request = protocol.buildRequest(types, deviceInfo, 'player');
    const notUnlocked = protocol.validateLoginReply('player', request.replyDecoder(playerReply({
        global_scene_id: 2,
        unlocked_scene_ids: [1],
    })));
    assert.equal(notUnlocked.globalScene.ranchUnlocked, false);

    for (const unlocked of [[1, 2.5], [1, 'not-an-int'], [1, 2147483648]]) {
        assert.throws(
            () => protocol.validateLoginReply('player', {
                basic: { gid: 1220537209 },
                version_info: {},
                global_scene_id: 2,
                unlocked_scene_ids: unlocked,
            }),
            /unlocked_scene_ids|int32|整数/
        );
    }
});

test('legacy schema 明确兼容，但 field 错位回包不能复用旧 GID', () => {
    const legacyRequest = protocol.buildRequest(types, deviceInfo, 'legacy');
    const legacy = protocol.validateLoginReply('legacy', legacyRequest.replyDecoder(legacyReply()));
    assert.equal(legacy.actualProfile, 'legacy');
    assert.equal(legacy.basic.gid, 1220537209);
    assert.deepEqual(legacy.globalScene, {
        id: null,
        unlockedSceneIds: [],
        idConfirmed: false,
        unlockedSceneIdsConfirmed: false,
        ranchUnlocked: false,
    });
    assert.equal(legacy.canBroadcastLoggedIn, true);

    assert.throws(() => {
        const decodedAsPlayer = protocol.buildRequest(types, deviceInfo, 'player').replyDecoder(legacyReply());
        protocol.validateLoginReply('player', decodedAsPlayer);
    }, /profile|version_info|场景|回包|登录|wire type/);

    assert.throws(() => {
        const decodedAsLegacy = legacyRequest.replyDecoder(playerReply());
        protocol.validateLoginReply('legacy', decodedAsLegacy);
    }, /profile|version_info|回包|登录|wire type|index out of range/);
});

test('未知 reply、缺 basic 或缺协议标记都不能被当作已登录', () => {
    assert.throws(
        () => protocol.validateLoginReply('player', { basic: { gid: 1220537209 } }),
        /version_info|回包|profile/
    );
    assert.throws(
        () => protocol.validateLoginReply('player', { version_info: {}, global_scene_id: 2, unlocked_scene_ids: [] }),
        /basic|身份|GID|gid/
    );
});

test('player 登录必须显式确认 HOME scene 1 后才允许广播 loggedin', () => {
    const request = protocol.buildRequest(types, deviceInfo, 'player');
    const login = protocol.validateLoginReply('player', request.replyDecoder(playerReply()));

    assert.throws(
        () => protocol.validateHomeSceneConfirmation({ global_scene_id: 2 }),
        /HOME|scene 1|确认/
    );
    const confirmed = protocol.confirmHomeScene(login, { global_scene_id: 1 });
    assert.equal(confirmed.homeSceneConfirmed, true);
    assert.equal(confirmed.canBroadcastLoggedIn, true);
});
