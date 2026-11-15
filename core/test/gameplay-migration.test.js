'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const protobuf = require('protobufjs');
const priority = require('../src/utils/request-priority');
const root = new protobuf.Root().loadSync(['avatarframepb.proto', 'collectionpb.proto', 'itempb.proto', 'plantpb.proto', 'redpacketpb.proto', 'solartermspb.proto', 'skinpb.proto']
    .map(name => path.join(__dirname, '../src/proto', name)), { keepCase: true });
root.resolveAll();
const type = name => root.lookupType(name);
const lookup = {
    ClaimSolarTermsRequest: 'gamepb.solartermspb.ClaimSolarTermsRequest', ClaimSolarTermsReply: 'gamepb.solartermspb.ClaimSolarTermsReply',
    BagRequest: 'gamepb.itempb.BagRequest', BagReply: 'gamepb.itempb.BagReply',
    UseRequest: 'gamepb.itempb.UseRequest', UseReply: 'gamepb.itempb.UseReply',
    LockItemsRequest: 'gamepb.itempb.LockItemsRequest', LockItemsReply: 'gamepb.itempb.LockItemsReply',
    UnlockItemsRequest: 'gamepb.itempb.UnlockItemsRequest', UnlockItemsReply: 'gamepb.itempb.UnlockItemsReply',
    AvatarFramesOwnedRequest: 'gamepb.avatarframepb.AvatarFramesOwnedRequest', AvatarFramesOwnedReply: 'gamepb.avatarframepb.AvatarFramesOwnedReply',
    AvatarFramesEquipedRequest: 'gamepb.avatarframepb.AvatarFramesEquipedRequest', AvatarFramesEquipedReply: 'gamepb.avatarframepb.AvatarFramesEquipedReply',
    AvatarFrameUpdateEquipRequest: 'gamepb.avatarframepb.UpdateEquipRequest', AvatarFrameUpdateEquipReply: 'gamepb.avatarframepb.UpdateEquipReply',
    AvatarFrameEquipRequest: 'gamepb.avatarframepb.EquipRequest', AvatarFrameEquipReply: 'gamepb.avatarframepb.EquipReply',
    AvatarFrameUnequipRequest: 'gamepb.avatarframepb.UnequipRequest', AvatarFrameUnequipReply: 'gamepb.avatarframepb.UnequipReply',
    GetCollectionsRequest: 'gamepb.collectionpb.GetCollectionsRequest', GetCollectionsReply: 'gamepb.collectionpb.GetCollectionsReply',
    UpgradeCollectionRequest: 'gamepb.collectionpb.UpgradeCollectionRequest', UpgradeCollectionReply: 'gamepb.collectionpb.UpgradeCollectionReply',
    ClaimCollectionRewardRequest: 'gamepb.collectionpb.ClaimCollectionRewardRequest', ClaimCollectionRewardReply: 'gamepb.collectionpb.ClaimCollectionRewardReply',
    SwitchSceneDisplayRequest: 'gamepb.collectionpb.SwitchSceneDisplayRequest', SwitchSceneDisplayReply: 'gamepb.collectionpb.SwitchSceneDisplayReply',
    AllLandsRequest: 'gamepb.plantpb.AllLandsRequest', AllLandsReply: 'gamepb.plantpb.AllLandsReply',
    FarmingRequest: 'gamepb.plantpb.FarmingRequest', FarmingReply: 'gamepb.plantpb.FarmingReply',
    GetTodayClaimStatusRequest: 'gamepb.redpacketpb.GetTodayClaimStatusRequest', GetTodayClaimStatusReply: 'gamepb.redpacketpb.GetTodayClaimStatusReply',
    ClaimRedPacketRequest: 'gamepb.redpacketpb.ClaimRedPacketRequest', ClaimRedPacketReply: 'gamepb.redpacketpb.ClaimRedPacketReply',
    SkinsOwnedRequest: 'gamepb.skinpb.SkinsOwnedRequest', SkinsOwnedReply: 'gamepb.skinpb.SkinsOwnedReply',
    SkinsEquippedRequest: 'gamepb.skinpb.SkinsEquippedRequest', SkinsEquippedReply: 'gamepb.skinpb.SkinsEquippedReply',
    EquipSkinRequest: 'gamepb.skinpb.EquipRequest', EquipSkinReply: 'gamepb.skinpb.EquipReply',
    GetSkinEffectTypeParamsRequest: 'gamepb.skinpb.GetSkinEffectTypeParamsRequest', GetSkinEffectTypeParamsReply: 'gamepb.skinpb.GetSkinEffectTypeParamsReply',
    MarkSkinAsViewedRequest: 'gamepb.skinpb.MarkAsViewedRequest', MarkSkinAsViewedReply: 'gamepb.skinpb.MarkAsViewedReply',
};
const types = Object.fromEntries(Object.entries(lookup).map(([name, full]) => [name, type(full)]));
const encode = (name, obj) => types[name].encode(types[name].fromObject(obj)).finish();
const clone = value => JSON.parse(JSON.stringify(value));
function harness() {
    const calls = [];
    const writes = [];
    const ledgers = new Map();
    const diagnostic = { accountId: 'fixture', connected: true, loggedIn: true, detached: false, connectionEpoch: 1, remoteGeneration: 1 };
    const user = { gid: 123, level: 125 };
    const h = { calls, writes, diagnostic, user, ledgers, onRpc: null };
    const network = {
        getDiagnosticSnapshot: () => ({ ...diagnostic }), getUserState: () => user,
        sendMsgAsync: async (service, method, bytes) => {
            const prefix = service.includes('avatarframe') ? 'AvatarFrame' : '';
            const skinRequest = service.includes('skinpb') && method === 'Equip' ? 'EquipSkinRequest'
                : service.includes('skinpb') && method === 'MarkAsViewed' ? 'MarkSkinAsViewedRequest' : null;
            const requestName = skinRequest || (['AvatarFramesOwned', 'AvatarFramesEquiped'].includes(method) ? `${method}Request` : `${prefix}${method}Request`);
            const request = types[requestName]?.toObject(types[requestName].decode(bytes), { longs: String }) || {};
            calls.push({ service, method, request });
            if (!['Bag', 'AllLands', 'AvatarFramesOwned', 'AvatarFramesEquiped', 'GetCollections', 'GetTodayClaimStatus', 'SkinsOwned', 'SkinsEquipped', 'GetSkinEffectTypeParams'].includes(method)) writes.push({ method, request });
            const result = await h.onRpc?.(method, request);
            if (Buffer.isBuffer(result)) return { body: result, resultState: 'completed' };
            const replyName = skinRequest ? skinRequest.replace(/Request$/, 'Reply')
                : ['AvatarFramesOwned', 'AvatarFramesEquiped'].includes(method) ? `${method}Reply` : `${prefix}${method}Reply`;
            return { body: encode(replyName, result || {}), resultState: 'completed' };
        },
    };
    const definitions = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/ItemInfo.json'), 'utf8'));
    const actualItems = Array.isArray(definitions) ? definitions : Object.values(definitions);
    const info = id => actualItems.find(item => Number(item.id) === Number(id)) || ({ id, name: `物品${id}`, type: id === 700001 ? 35 : id === 101619 ? 33 : id === 20001 ? 5 : 6 });
    const commandsModule = { exports: {} };
    const commandFile = path.join(__dirname, '../src/services/game-command.js');
    vm.runInNewContext(fs.readFileSync(commandFile, 'utf8'), { module: commandsModule, Buffer, Uint8Array, Date, BigInt, Intl,
        require: name => {
            if (name === '../utils/network') return network;
            if (name === '../utils/proto') return { types };
            if (name === '../utils/request-priority') return priority;
            if (name === '../config/runtime-paths') return { getDataFile: filename => filename };
            if (name === './json-db') return { writeJsonFileAtomic: (filename, data) => ledgers.set(filename, clone(data)) };
            if (name === 'node:fs') return { existsSync: filename => ledgers.has(filename), readFileSync: filename => JSON.stringify(ledgers.get(filename)) };
            return require(name);
        },
    }, { filename: commandFile });
    h.commands = commandsModule.exports;
    const cache = {};
    function load(name) {
        if (cache[name]) return cache[name].exports;
        const file = path.join(__dirname, '../src/services', name + '.js');
        const module = { exports: {} };
        cache[name] = module;
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: path.dirname(file), Buffer, Uint8Array, Date, BigInt, Intl, console,
            require: dep => {
                if (dep === '../utils/network') return network;
                if (dep === '../utils/proto') return { types };
                if (dep === '../utils/request-priority') return priority;
                if (dep === './game-command') return h.commands;
                if (dep === './status') return { updateStatusGold() {} };
                if (dep === '../models/store') return { isAutomationOn: () => false };
                if (dep === '../utils/utils') return { toNum: value => Number(value) || 0, toLong: value => String(value), log() {}, logWarn() {}, sleep: async () => {} };
                if (dep === '../config/runtime-paths') return { getResourcePath: (...parts) => path.join(__dirname, '../src', ...parts) };
                if (dep === '../config/gameConfig') return { getItemById: info, getItemImageById: () => '', getPlantBySeedId: id => Number(id) === 20001 ? { name: '种子', size: 1 } : null,
                    getPlantByFruitId: () => null, isSeedItem: id => Number(id) === 20001, getSeedImageBySeedId: () => '', getSeedLevel: () => 1 };
                if (dep.startsWith('./')) return load(dep.slice(2));
                return require(dep);
            },
        }, { filename: file });
        return module.exports;
    }
    h.load = load;
    return h;
}

test('real protocol includes instance locks and nested Use/actual reward fields', () => {
    const raw = encode('UseRequest', { item: { id: '101619', count: '1', uid: '9007199254740993' }, target: { host_gid: '123' } });
    const result = types.UseRequest.decode(raw);
    assert.equal(result.item.uid.toString(), '9007199254740993');
    const reward = types.UseReply.decode(encode('UseReply', { used_items: [{ id: 101619, count: 1 }], items: [{ id: 700001, count: 1 }] }));
    assert.equal(Number(reward.items[0].id), 700001);
    const Item = type('corepb.Item');
    assert.equal(Item.decode(Item.encode(Item.fromObject({ id: 20001, uid: 100, locked: true })).finish()).locked, true);
});
test('scope ledger refuses replay across a new module instance after unknown writes', async () => {
    const h = harness();
    h.onRpc = () => { throw new Error('transport timeout'); };
    const scope = h.commands.createGameCommandScope('fixture');
    await assert.rejects(scope.execute(session => scope.rpc(session, 'gamepb.avatarframepb.AvatarFrameService', 'Equip', 'AvatarFrameEquipRequest', 'AvatarFrameEquipReply', { frame_id: 2158 }, { write: true, key: 'slot' })), error => error.resultState === 'unknown');
    const restarted = h.commands.createGameCommandScope('fixture');
    await assert.rejects(restarted.execute(session => restarted.rpc(session, 'gamepb.avatarframepb.AvatarFrameService', 'Equip', 'AvatarFrameEquipRequest', 'AvatarFrameEquipReply', { frame_id: 2158 }, { write: true, key: 'slot' })), /禁止重放/);
    assert.equal(h.writes.length, 1);
});
test('definite not-sent errors are preserved rather than falsely claiming game mutation', async () => {
    const h = harness(); h.onRpc = () => { throw Object.assign(new Error('queued'), { sent: false, resultState: 'not_sent' }); };
    const scope = h.commands.createGameCommandScope('fixture');
    await assert.rejects(scope.execute(session => scope.rpc(session, 'x', 'Equip', 'AvatarFrameEquipRequest', 'AvatarFrameEquipReply', {}, { write: true, key: 'slot' })), error => error.sent === false);
});
test('completed one-shot quiz stays reserved across module reload without blocking unrelated pending check', () => {
    const h = harness();
    const session = h.commands.captureSession();
    const first = h.commands.createGameCommandScope('quiz');
    first.confirmOnce(session, 'AnswerSolarTerms:403', 'wrong');
    const restored = h.commands.createGameCommandScope('quiz');
    assert.equal(restored.completed(session, 'AnswerSolarTerms:403'), true);
    assert.equal(restored.blocked(session, 'AnswerSolarTerms:403'), true);
});

test('PushPlus quiz WeChat uses daily-report defaults, accepted/unknown are never repeated', async () => {
    const module = { exports: {} };
    const filename = path.join(__dirname, '../src/services/friend-alert.js');
    const io = new Map();
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process: { env: {} }, Date, Intl,
        require(name) {
            if (name === 'fs') return { existsSync: f => io.has(f), readFileSync: f => io.get(f) };
            if (name === '../models/store') return { getAccounts: () => ({ accounts: [] }) };
            if (name === '../utils/utils') return { logWarn() {} };
            if (name === '../config/runtime-paths') return { getDataFile: name => name };
            if (name === './json-db') return { writeJsonFileAtomic: (name, data) => io.set(name, JSON.stringify(data)) };
            return require(name);
        },
    }, { filename });
    let sends = 0;
    const send = async (_title, _content, options) => { sends++; assert.equal(Object.hasOwn(options, 'channel'), false); assert.equal(Object.hasOwn(options, 'template'), false); assert.equal(options.details, true); return { ok: true, resultState: 'accepted', shortCode: 'fixture' }; };
    const event = { id: 403, name: '立冬', startTime: Math.floor(Date.now() / 1000), endTime: Math.floor(Date.now() / 1000) + 100, quizAvailable: true };
    const params = { accountId: 'A', events: [event] };
    const accepted = await module.exports.notifySolarQuiz(params, { send });
    assert.equal(accepted.resultState, 'accepted'); assert.equal(accepted.count, 1);
    assert.equal((await module.exports.notifySolarQuiz(params, { send })).skipped, true); assert.equal(sends, 1);
    assert.equal((await module.exports.notifySolarQuiz({ accountId: 'A', events: [{ ...event, quizAvailable: false }] }, { send })).skipped, true);
    const unknownSend = async () => { sends++; return { ok: false, resultState: 'unknown' }; };
    await module.exports.notifySolarQuiz({ ...params, accountId: 'B' }, { send: unknownSend });
    await module.exports.notifySolarQuiz({ ...params, accountId: 'B' }, { send: unknownSend });
    assert.equal(sends, 2, '未知送达不可重复发');
});

test('PushPlus WeChat channel migration keeps mail evidence, failure backoff, pending no-replay and per-account isolation', async () => {
    const filename = path.join(__dirname, '../src/services/friend-alert.js');
    const module = { exports: {} };
    const io = new Map();
    let now = Date.now(), sends = 0;
    class Clock extends Date { static now() { return now; } }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process: { env: {} }, Date: Clock, Intl,
        require(name) {
            if (name === 'fs') return { existsSync: f => io.has(f), readFileSync: f => io.get(f) };
            if (name === '../models/store') return { getAccounts: () => ({ accounts: [] }) };
            if (name === '../utils/utils') return { logWarn() {} };
            if (name === '../config/runtime-paths') return { getDataFile: f => f };
            if (name === './json-db') return { writeJsonFileAtomic: (f, data) => io.set(f, JSON.stringify(data)) };
            return require(name);
        },
    }, { filename });
    const hash = input => require('node:crypto').createHash('sha256').update(input).digest('hex');
    const event = { id: 403, name: '立冬', startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 100, quizAvailable: true };
    const oldKey = hash(JSON.stringify([event.id, event.startTime, event.endTime]));
    const newKey = hash(JSON.stringify(['wechat', event.id, event.startTime, event.endTime]));
    const stateFile = path.join('solar-quiz-notified', `${hash('10').slice(0, 24)}.json`);
    const old = { at: now, resultState: 'unknown', shortCode: '' };
    io.set(stateFile, JSON.stringify({ [oldKey]: old }));
    const send = async () => {
        sends++;
        assert.equal(JSON.parse(io.get(stateFile))[newKey].resultState, 'pending', '发送前先持久占位');
        return { ok: false, resultState: 'failed', code: 400, message: '平台拒绝' };
    };
    const params = { accountId: '10', accountName: '账号乙', events: [event] };
    const result = await module.exports.notifySolarQuiz(params, { send });
    assert.equal(result.resultState, 'failed');
    assert.deepEqual(JSON.parse(io.get(stateFile))[oldKey], old, '旧mail未知证据不删不覆盖');
    assert.equal(JSON.parse(io.get(stateFile))[newKey].channel, 'wechat');
    assert.equal(JSON.parse(io.get(stateFile))[newKey].code, 400);
    assert.equal(JSON.parse(io.get(stateFile))[newKey].message, '平台拒绝');
    now += 6 * 3600000 - 1;
    assert.equal((await module.exports.notifySolarQuiz(params, { send })).reason, 'backoff'); assert.equal(sends, 1);
    now++;
    await module.exports.notifySolarQuiz(params, { send: async () => { sends++; return { ok: true, resultState: 'accepted', code: 200, shortCode: 'fixture' }; } });
    assert.equal(sends, 2);
    await module.exports.notifySolarQuiz(params, { send }); assert.equal(sends, 2, '已受理后不自动刷屏');
    const other = { ...params, accountId: '1' };
    await module.exports.notifySolarQuiz(other, { send: async () => { sends++; throw new Error('crash'); } }).catch(() => {});
    await module.exports.notifySolarQuiz(other, { send }); assert.equal(sends, 3, '崩溃pending跨调用也不重发');
});

test('PushPlus helper checks platform JSON and quiz details leave daily-report payload unchanged', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/friend-alert.js'), 'utf8');
    const begin = source.indexOf('async function pushAlertMessage('), end = source.indexOf('\nasync function notifySolarQuiz', begin);
    const calls = []; let code = 200, message = '请求成功', httpOk = true, throws = false;
    const push = vm.runInNewContext(source.slice(begin, end) + '\npushAlertMessage', { URL, JSON, AbortSignal,
        process: { env: { ALERT_WEBHOOK: 'https://www.pushplus.plus/send/fixture-not-a-secret' } },
        fetch: async (_url, options) => {
            calls.push(JSON.parse(options.body));
            if (throws) throw new Error('timeout');
            return { ok: httpOk, status: httpOk ? 200 : 503, json: async () => ({ code, msg: message, data: 'fixture' }) };
        },
    });
    const quiz = await push('test', 'body', { details: true });
    assert.equal(quiz.resultState, 'accepted'); assert.equal(quiz.delivered, false); assert.equal(quiz.shortCode, 'fixture');
    assert.equal(quiz.code, 200); assert.equal(quiz.message, '请求成功');
    await push('test', 'body');
    assert.deepEqual(calls[0], calls[1], '提醒和日报必须使用完全相同的默认通道/模板负载');
    assert.equal(Object.hasOwn(calls[0], 'channel'), false); assert.equal(Object.hasOwn(calls[0], 'template'), false);
    code = 500; message = '平台拒绝';
    const rejected = await push('test', 'body', { details: true });
    assert.equal(rejected.resultState, 'failed'); assert.equal(rejected.code, 500); assert.equal(rejected.message, '平台拒绝');
    assert.equal(rejected.shortCode, ''); assert.equal(await push('test', 'body'), false);
    code = 200; httpOk = false; assert.equal(await push('test', 'body'), false);
    throws = true; assert.equal((await push('test', 'body', { details: true })).resultState, 'unknown');
});

// Independent wire definitions transcribed from the official encoders above,
// not from the production proto whose false EquipReply.skins caused the bug.
const skinOfficialRoot = protobuf.parse(`syntax = "proto3";
message Skin { int64 id=1; int64 skin_type=2; bool is_new=3; int64 expire_time=4; repeated int64 part_ids=5; }
message Part { int64 id=1; bool is_new=2; }
message Effect { int64 set_id=1; int64 effect_type=2; bool is_active=3; }
message Params { int64 param1_int=1; }
message Owned { repeated Skin skins=1; repeated Part parts=2; }
message Equipped { repeated Skin skins=1; repeated Effect active_set_effects=2; }
message Effects { map<int64, Params> effect_type_params=1; }
message EquipRequest { int64 id=1; int64 skin_type=2; }
message EquipReply {}
message Notify { int64 player_id=1; repeated Skin equip_skins=2; repeated Effect active_set_effects=3; map<int64, Params> effect_type_params=4; }
`, { keepCase: true }).root;
const skinOfficialWire = (name, input) => {
    const Message = skinOfficialRoot.lookupType(name);
    return Buffer.from(Message.encode(Message.fromObject(input)).finish());
};
function sceneSkinHarness({ readback = 'target', equipError = null } = {}) {
    const h = harness();
    let currentId = 201009, equippedReads = 0;
    h.onRpc = (method, request) => {
        if (method === 'SkinsOwned') return skinOfficialWire('Owned', { skins: [
            { id: 201009, skin_type: 1, part_ids: [210011] },
            { id: 201010, skin_type: 1, is_new: true, part_ids: [210021] },
            { id: 202001, skin_type: 2 },
        ], parts: [{ id: 210011, is_new: true }] });
        if (method === 'SkinsEquipped') {
            equippedReads++;
            if (equippedReads > 1 && readback === 'error') throw new Error('readback unavailable');
            if (equippedReads > 1 && readback === 'changed-account') h.diagnostic.connectionEpoch++;
            return skinOfficialWire('Equipped', { skins: readback === 'empty' && equippedReads > 1 ? [] : [
                { id: readback === 'wrong-slot' && equippedReads > 1 ? 201009 : currentId, skin_type: 1 },
                { id: readback === 'wrong-slot' && equippedReads > 1 ? 201010 : 202001, skin_type: 2 },
            ], active_set_effects: [{ set_id: 11, effect_type: 2, is_active: true }, { set_id: 12, effect_type: 3, is_active: false }] });
        }
        if (method === 'GetSkinEffectTypeParams') return skinOfficialWire('Effects', { effect_type_params: { '2': { param1_int: '9007199254740993' } } });
        if (method === 'Equip') {
            assert.deepEqual(request, { id: '201010', skin_type: '1' });
            if (equipError) throw equipError;
            if (readback === 'target' || readback === 'changed-account') currentId = 201010;
            return skinOfficialWire('EquipReply', {});
        }
        assert.fail('Unexpected scene skin RPC: ' + method);
    };
    h.reloadSkin = () => {
        const filename = path.join(__dirname, '../src/services/skin.js'), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, Uint8Array, Date, BigInt, Intl,
            require(name) {
                if (name === './game-command') return h.commands;
                if (name === '../utils/utils') return { log() {}, logWarn() {} };
                if (name === '../config/gameConfig') return { getItemById: id => ({ name: `装扮${id}` }), getItemImageById: () => '' };
                if (name === 'protobufjs') return protobuf;
                throw new Error('Unexpected skin dependency: ' + name);
            },
        }, { filename });
        return module.exports;
    };
    return h;
}

test('official scene skin wire has empty Equip acknowledgement, full Skin/parts, repeated effects and separate notify fields', () => {
    const owned = types.SkinsOwnedReply.decode(skinOfficialWire('Owned', { skins: [{ id: 201010, skin_type: 1, expire_time: 1900000000, part_ids: [210021, 210022] }], parts: [{ id: 210021, is_new: true }] }));
    assert.equal(Number(owned.skins[0].id), 201010);
    assert.equal(Number(owned.skins[0].skin_type), 1);
    assert.equal(Number(owned.skins[0].expire_time), 1900000000);
    assert.deepEqual(owned.skins[0].part_ids.map(Number), [210021, 210022]);
    assert.equal(owned.parts[0].is_new, true);
    const body = skinOfficialWire('EquipReply', {});
    assert.equal(body.length, 0);
    assert.deepEqual(Object.keys(types.EquipSkinReply.decode(body)), []);
    assert.equal(Object.hasOwn(types.EquipSkinReply.fields, 'skins'), false);
    const legacy = protobuf.parse('syntax = "proto3";message S { int64 skin_id=1;int64 slot_type=2; }message R { repeated S skins=1; }', { keepCase: true }).root.lookupType('R').decode(body);
    assert.equal(legacy.skins.length, 0, 'Independent empty ack reproduces the old impossible confirmation');
    const officialRequest = skinOfficialRoot.lookupType('EquipRequest').decode(encode('EquipSkinRequest', { id: 201010, skin_type: 1 }));
    assert.equal(Number(officialRequest.id), 201010); assert.equal(Number(officialRequest.skin_type), 1);
    const Notify = type('gamepb.skinpb.SkinChangeNotify');
    const notify = Notify.decode(skinOfficialWire('Notify', { player_id: 123, equip_skins: [{ id: 201010, skin_type: 1 }], active_set_effects: [{ set_id: 11, effect_type: 2, is_active: true }] }));
    assert.equal(Number(notify.player_id), 123); assert.equal(Number(notify.equip_skins[0].id), 201010); assert.equal(notify.active_set_effects[0].is_active, true);
});
test('empty official Equip reply followed by one genuine current-state read confirms scene appearance with one write only', async () => {
    const h = sceneSkinHarness(), service = h.load('skin');
    const result = await service.equipSkin(201010, 1, { confirmed: true, expectedEquippedSkinId: 201009 });
    assert.equal(result.resultState, 'completed'); assert.equal(result.confirmation, 'SkinsEquipped'); assert.equal(result.accountId, 'fixture');
    assert.deepEqual(h.calls.map(call => call.method), ['SkinsOwned', 'SkinsEquipped', 'Equip', 'SkinsEquipped']);
    assert.equal(h.writes.length, 1); assert.ok(h.calls.every(call => call.service === 'gamepb.skinpb.SkinService'));
    assert.equal(result.equipped.find(item => item.slotType === 1).skinId, 201010);
    assert.deepEqual(clone(result.activeSetEffects), [{ setId: 11, effectType: 2, enabled: true }, { setId: 12, effectType: 3, enabled: false }]);
    assert.ok(Object.values([...h.ledgers.values()][0]).length === 0);
});
for (const readback of ['old', 'empty', 'wrong-slot', 'error', 'changed-account']) test(`scene skin ${readback} readback stays unknown, survives service reload, and never resubmits or probes`, async () => {
    const h = sceneSkinHarness({ readback }), service = h.load('skin');
    await assert.rejects(service.equipSkin(201010, 1, { confirmed: true }), error => error.resultState === 'unknown' && error.retryable === false);
    assert.equal(h.writes.length, 1);
    const reloaded = h.reloadSkin();
    await assert.rejects(reloaded.equipSkin(201010, 1, { confirmed: true }), /未确认|禁止重放/);
    assert.equal(h.writes.length, 1);
    assert.equal(h.calls.filter(call => !['SkinsOwned', 'SkinsEquipped', 'Equip'].includes(call.method)).length, 0);
});
test('scene skin timeout locks the slot; definite rejection does not fake success or try another method', async () => {
    for (const definite of [false, true]) {
        const h = sceneSkinHarness({ equipError: definite ? Object.assign(new Error('not owned'), { sent: true, resultState: 'failed', errorCode: 400 }) : new Error('timeout') });
        await assert.rejects(h.load('skin').equipSkin(201010, 1, { confirmed: true }), error => definite ? error.resultState === 'failed' : error.resultState === 'unknown');
        assert.equal(h.writes.length, 1);
        const slotEntries = Object.values([...h.ledgers.values()][0]);
        assert.equal(slotEntries.length, definite ? 0 : 1);
        assert.equal(h.calls.filter(call => call.method === 'SkinsEquipped').length, 1, 'Failed ack must not enter a new mutation/readback path');
    }
});
test('scene skin full proto registrations resolve, explicit default current skin and expiration do not invent or enable writes', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/utils/proto.js'), 'utf8');
    for (const name of ['Skin', 'SkinPart', 'SkinSetEffectInfo', 'SkinSetEffectTypeParams', 'SkinChangeNotify']) {
        assert.match(source, new RegExp(`types\\.${name} = _lookup\\('gamepb\\.skinpb\\.${name}'\\)`));
        assert.ok(type(`gamepb.skinpb.${name}`));
    }
    const h = sceneSkinHarness(), service = h.load('skin');
    const defaultAppearance = service.normalizeSkinItem({ id: 0, skin_type: 1 }, true);
    assert.equal(defaultAppearance.skinId, 0); assert.equal(defaultAppearance.name, '默认外观');
    assert.throws(() => service.normalizeSkinItem({ id: 0, skin_type: 1 }), /无效/);
    h.onRpc = method => method === 'SkinsOwned' ? skinOfficialWire('Owned', { skins: [{ id: 201010, skin_type: 1, expire_time: 1 }] }) : assert.fail('Expired item must not request current state or write');
    await assert.rejects(service.equipSkin(201010, 1, { confirmed: true }), error => error.sent === false && error.errorCode === 'SKIN_EXPIRED');
    assert.equal(h.writes.length, 0);
});

test('scene skin confirmation, ownership, current expected slot and malformed input stop writes before sending', async () => {
    for (const [id, slot, expected] of [[201010, 1, {}], [201010, 1, { confirmed: true, expectedEquippedSkinId: 123 }], [201010, 2, { confirmed: true }], [true, 1, { confirmed: true }], [201010, true, { confirmed: true }]]) {
        const h = sceneSkinHarness();
        await assert.rejects(h.load('skin').equipSkin(id, slot, expected), error => error.sent === false);
        assert.equal(h.writes.length, 0);
    }
    const h = sceneSkinHarness();
    const result = await h.load('skin').equipSkin(201009, 1, { confirmed: true });
    assert.equal(result.skipped, true); assert.equal(h.writes.length, 0);
});
test('scene skin overview preserves repeated effects, int64 map keys and exact values without marking or unlocking writes', async () => {
    const h = sceneSkinHarness(), overview = await h.load('skin').getSkinOverview();
    assert.equal(overview.stateKnown, true); assert.equal(overview.ownedCount, 3); assert.equal(overview.effectSelection, null);
    assert.deepEqual(clone(overview.effectParams), [{ effectType: 2, value: '9007199254740993' }]);
    assert.equal(overview.items.find(item => item.skinId === 201010).isNew, true);
    assert.deepEqual(clone(overview.items.find(item => item.skinId === 201010).partIds), [210021]);
    assert.equal(h.writes.length, 0);
});

test('scene skin registry loads the actual full proto tree offline, and its multi-stage HTTP/IPC budgets outlast the game scope', async () => {
    const module = { exports: {} }, filename = path.join(__dirname, '../src/utils/proto.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Promise, console,
        require(name) {
            if (name === 'protobufjs') return protobuf;
            if (name === '../config/runtime-paths') return { getResourcePath: (...parts) => path.join(__dirname, '../src', ...parts) };
            if (name === './utils') return { log() {} };
            throw new Error('Full proto load must not start a transport: ' + name);
        },
    }, { filename });
    await module.exports.loadProto();
    assert.ok(module.exports.types.EquipSkinReply);
    assert.equal(Object.keys(module.exports.types.EquipSkinReply.fields).length, 0);
    assert.ok(module.exports.types.SkinChangeNotify);
    const provider = fs.readFileSync(path.join(__dirname, '../src/runtime/data-provider.js'), 'utf8');
    assert.match(provider, /getSkins:.*_timeoutMs: 65000/);
    assert.match(provider, /equipSkin:.*expected.*_timeoutMs: 65000/);
    const panel = fs.readFileSync(path.join(__dirname, '../../web/src/components/SkinPanel.vue'), 'utf8');
    assert.match(panel, /timeout: 70000, headers/);
});

test('skin HTTP route freezes confirmed account/slot/expected state and rejects missing confirmation before calling provider', async () => {
    const routes = new Map(), calls = [], logs = [];
    const app = { get: (name, run) => routes.set(`GET ${name}`, run), post: (name, run) => routes.set(`POST ${name}`, run) };
    require('../src/controllers/admin-skin-routes').registerAdminSkinRoutes({ app,
        provider: { equipSkin: async (...args) => { calls.push(args); return { accountId: args[0], skinId: args[1], slotType: args[2], resultState: 'completed' }; } },
        adminLogger: { error() {}, warn() {} }, emitRealtimeLog: row => logs.push(row),
        getAccountIdFromRequest: req => req.headers['x-account-id'], canAccessAccount: () => true,
        sendProviderError: (res, error) => res.status(500).json({ ok: false, error: error.message }),
    });
    const res = () => ({ code: 200, value: null, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } });
    const valid = { skinId: 201010, slotType: 1, expectedEquippedSkinId: 201009, confirmed: true };
    for (const body of [{ ...valid, confirmed: false }, { ...valid, skinId: true }, { ...valid, slotType: true }, { ...valid, expectedEquippedSkinId: undefined }, { ...valid, expectedEquippedSkinId: true }]) {
        const output = res(); await routes.get('POST /api/skins/equip')({ headers: { 'x-account-id': 'fixture' }, body }, output);
        assert.equal(output.code, 400); assert.equal(output.value.sent, false); assert.equal(calls.length, 0);
    }
    const output = res(); await routes.get('POST /api/skins/equip')({ headers: { 'x-account-id': 'fixture' }, body: valid }, output);
    assert.deepEqual(calls, [['fixture', 201010, 1, { confirmed: true, expectedEquippedSkinId: 201009 }]]);
    assert.equal(output.value.ok, true); assert.equal(logs.length, 1);
});

test('expired or changed account context sends no game request', async () => {
    const h = harness(); h.user.gid = 0;
    await assert.rejects(h.load('avatar-frame').getAvatarFrames());
    assert.equal(h.calls.length, 0);
});
test('official independent wire: count field3 is not equipment, expiry is field6', () => {
    // Independent official schema, NOT encoded from the production proto that
    // caused this bug. It must reproduce the old count=1 -> all equipped error.
    const official = protobuf.parse(`syntax = "proto3"; message Frame { int64 id=1; int32 type=2; int64 count=3; int32 priority=4; bool is_new=5; int64 expire_time=6; } message Reply { repeated Frame avatar_frames=1; }`, { keepCase: true }).root;
    const Reply = official.lookupType('Reply');
    const raw = Reply.encode(Reply.fromObject({ avatar_frames: [{ id: 301, type: 1, count: 1, priority: 5, is_new: true, expire_time: 1900000000 }, { id: 203, type: 1, count: 1 }] })).finish();
    const actual = types.AvatarFramesOwnedReply.decode(raw);
    assert.equal(Number(actual.avatar_frames[0].count), 1);
    assert.equal(Number(actual.avatar_frames[0].expire_time), 1900000000);
    assert.equal(actual.avatar_frames[0].is_new, true);
    assert.equal(Object.hasOwn(actual.avatar_frames[0], 'equipped'), false);
    const legacy = protobuf.parse('syntax = "proto3"; message Frame { int64 frame_id=1; int64 status=2; int64 equipped=3; int64 expire_time=4; } message Reply { repeated Frame frames=1; }').root.lookupType('Reply').decode(raw);
    assert.equal(legacy.frames.filter(frame => Number(frame.equipped) === 1).length, 2, '夹具必须真实复现旧错位协议');
    const dto = harness().load('avatar-frame').frameDto(actual.avatar_frames[0], 1);
    assert.equal(dto.equipped, null); assert.equal(dto.itemId, 2130); assert.equal(dto.count, '1');
});
test('owned count1 rows never imply worn; separate current query selects one per type', async () => {
    const h = harness();
    h.onRpc = (method, req) => method === 'AvatarFramesOwned'
        ? { avatar_frames: Number(req.type) === 1 ? [{ id: 301, type: 1, count: 1 }, { id: 203, type: 1, count: 1 }, { id: 2158, type: 1, count: 1 }]
            : [{ id: 401001, type: 2, count: 1 }, { id: 401005, type: 2, count: 1 }] }
        : { avatar_frames: [{ id: 301, type: 1, count: 1 }, { id: 401005, type: 2, count: 1 }] };
    const data = await h.load('avatar-frame').getAvatarFrames();
    assert.deepEqual(h.calls.map(call => call.method), ['AvatarFramesOwned', 'AvatarFramesOwned', 'AvatarFramesEquiped']);
    assert.deepEqual(h.calls.map(call => call.request), [{ type: 1 }, { type: 2 }, {}]);
    assert.deepEqual(clone(data.groups.map(group => group.items.filter(item => item.equipped === true).length)), [1, 1]);
    assert.deepEqual(clone(data.groups.map(group => group.equippedIds)), [[301], [401005]]);
    assert.equal(data.groups[0].items.find(item => item.frameId === 203).equipped, false);
    assert.equal(h.writes.length, 0);
});
test('official unique maximum priority wins; equal maxima are unknown, never first item', async () => {
    const h = harness(); let tied = false;
    h.onRpc = (method, req) => method === 'AvatarFramesOwned' ? { avatar_frames: Number(req.type) === 1 ? [{ id: 301, type: 1, count: 1 }, { id: 203, type: 1, count: 1 }] : [] }
        : { avatar_frames: [{ id: 301, type: 1, priority: 1 }, { id: 203, type: 1, priority: tied ? 1 : 2 }] };
    const service = h.load('avatar-frame');
    assert.equal((await service.getAvatarFrames()).groups[0].equippedIds[0], 203);
    tied = true;
    const data = await service.getAvatarFrames();
    assert.equal(data.groups[0].stateKnown, false);
    assert.equal(data.groups[0].items.filter(item => item.equipped === true).length, 0);
    assert.match(data.warning, /冲突/);
    await assert.rejects(service.operateAvatarFrame('equip', { frameId: 301, frameType: 1, confirmed: true }), /冲突/);
    assert.equal(h.writes.length, 0);
});
test('default or empty current list means no decorated frame, current read failure is not count fallback', async () => {
    const h = harness(); let mode = 'default';
    h.onRpc = (method, req) => {
        if (method === 'AvatarFramesOwned') return { avatar_frames: Number(req.type) === 1 ? [{ id: 301, type: 1, count: 1 }] : [] };
        if (mode === 'failed') throw new Error('current read failed');
        return mode === 'empty' ? Buffer.alloc(0) : { avatar_frames: [{ id: 101, type: 1 }, { id: 401000, type: 2 }] };
    };
    const service = h.load('avatar-frame');
    for (const next of ['default', 'empty']) {
        mode = next;
        const data = await service.getAvatarFrames();
        assert.ok(data.groups.every(group => group.stateKnown && group.equippedIds.length === 0));
        assert.ok(data.groups[0].items.every(item => item.equipped === false));
    }
    mode = 'failed'; await assert.rejects(service.getAvatarFrames(), /current read failed/);
    assert.equal(h.writes.length, 0);
});
test('avatar change uses one preselected UpdateEquip and exact current/new IDs', async () => {
    const h = harness(); let equipped = 301;
    h.onRpc = (method, req) => method === 'AvatarFramesOwned' ? { avatar_frames: Number(req.type) === 1 ? [{ id: 301, type: 1, count: 1 }, { id: 2158, type: 1, count: 1 }] : [] }
        : method === 'AvatarFramesEquiped' ? { avatar_frames: [{ id: equipped, type: 1 }] }
            : (equipped = Number(req.new_id), { equip_avatar_frames: [{ id: equipped, type: 1 }] });
    const result = await h.load('avatar-frame').operateAvatarFrame('equip', { frameId: 2158, frameType: 1, confirmed: true, expectedEquippedIds: [301] });
    assert.equal(result.resultState, 'completed'); assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].method, 'UpdateEquip'); assert.deepEqual(h.writes[0].request, { current_id: '301', new_id: '2158' });
});
test('avatar from default uses official default101 UpdateEquip; no actual game request', async () => {
    const h = harness(); let equipped = 101;
    h.onRpc = (method, req) => method === 'AvatarFramesOwned' ? { avatar_frames: Number(req.type) === 1 ? [{ id: 2158, type: 1, count: 1 }] : [] }
        : method === 'AvatarFramesEquiped' ? { avatar_frames: [{ id: equipped, type: 1 }] }
            : (equipped = Number(req.new_id), { equip_avatar_frames: [{ id: equipped, type: 1 }] });
    await h.load('avatar-frame').operateAvatarFrame('equip', { frameId: 2158, frameType: 1, confirmed: true });
    assert.deepEqual(h.writes[0].request, { current_id: '101', new_id: '2158' });
});
test('avatar empty write reply + unchanged current list is not success or another write', async () => {
    const h = harness(); h.onRpc = method => method === 'AvatarFramesOwned' ? { avatar_frames: [{ id: 2158, type: 1, count: 1 }] } : Buffer.alloc(0);
    const service = h.load('avatar-frame');
    await assert.rejects(service.operateAvatarFrame('equip', { frameId: 2158, frameType: 1, confirmed: true }), error => error.resultState === 'unknown');
    await assert.rejects(service.operateAvatarFrame('equip', { frameId: 2158, frameType: 1, confirmed: true }), error => error.resultState === 'unknown');
    assert.equal(h.writes.length, 1);
});
test('avatar unknown IDs, item/decor mismatch and missing confirmation never write', async () => {
    const h = harness(); h.onRpc = () => ({ avatar_frames: [{ id: 301, type: 1, count: 1 }] });
    const service = h.load('avatar-frame');
    for (const frameId of [999, 2130]) await assert.rejects(service.operateAvatarFrame('equip', { frameId, frameType: 1, confirmed: true }));
    await assert.rejects(service.operateAvatarFrame('equip', { frameId: 301, frameType: 1 }));
    assert.equal(h.writes.length, 0);
});
test('first nameplate Equip and removal Unequip use id; replacement uses UpdateEquip without fallback', async () => {
    const h = harness(); let worn = 0;
    h.onRpc = (method, req) => {
        if (method === 'AvatarFramesOwned') return { avatar_frames: Number(req.type) === 2 ? [{ id: 401005, type: 2, count: 1 }, { id: 401007, type: 2, count: 1 }] : [] };
        if (method === 'AvatarFramesEquiped') return { avatar_frames: worn ? [{ id: worn, type: 2 }] : [] };
        worn = method === 'Unequip' ? 0 : Number(req.new_id || req.id);
        return { equip_avatar_frames: worn ? [{ id: worn, type: 2 }] : [] };
    };
    const service = h.load('avatar-frame');
    await service.operateAvatarFrame('equip', { frameId: 401005, frameType: 2, confirmed: true });
    await service.operateAvatarFrame('equip', { frameId: 401007, frameType: 2, confirmed: true });
    await service.operateAvatarFrame('unequip', { frameId: 401007, frameType: 2, confirmed: true });
    assert.deepEqual(h.writes.map(call => call.method), ['Equip', 'UpdateEquip', 'Unequip']);
    assert.deepEqual(h.writes[0].request, { id: '401005' });
    assert.deepEqual(h.writes[1].request, { current_id: '401005', new_id: '401007' });
    assert.deepEqual(h.writes[2].request, { id: '401007' });
});
test('definite UpdateEquip failure never probes Equip or Unequip', async () => {
    const h = harness(); h.onRpc = (method, req) => {
        if (method === 'AvatarFramesOwned') return { avatar_frames: Number(req.type) === 1 ? [{ id: 2158, type: 1, count: 1 }] : [] };
        if (method === 'AvatarFramesEquiped') return { avatar_frames: [] };
        throw Object.assign(new Error('game rejected'), { resultState: 'failed', outcomeUnknown: false });
    };
    await assert.rejects(h.load('avatar-frame').operateAvatarFrame('equip', { frameId: 2158, frameType: 1, confirmed: true }), /game rejected/);
    assert.deepEqual(h.writes.map(call => call.method), ['UpdateEquip']);
});
test('real V1 claim scope requires rewards + server claimed state and durably forbids replay', async () => {
    const h = harness();
    const activityFile = path.join(__dirname, '../src/services/activity.js');
    const source = fs.readFileSync(activityFile, 'utf8');
    const begin = source.indexOf('let solarV1Scope;');
    const end = source.indexOf('\nfunction parseStarRecordExtra', begin);
    const module = { exports: {} };
    const run = vm.runInNewContext(source.slice(begin, end) + '\nclaimSolarTermsReward', { console,
        require: name => { assert.equal(name, './game-command'); return h.commands; },
        toNum: Number, getSolarTermsInfo: async () => ({ terms: [{ id: 403, claimable: true, title: '立冬' }] }),
        normalizeCoreItem: raw => ({ itemId: Number(raw.id), itemCount: Number(raw.count) }),
        activityLogger: { info() {} }, module,
    });
    h.onRpc = () => ({ rewards: [{ id: 1001, count: 20 }], updated_event: { id: 403, status: 3 } });
    assert.equal((await run(403)).resultState, 'completed');
    assert.equal(h.writes[0].method, 'ClaimSolarTerms'); assert.deepEqual(h.writes[0].request, { id: '403' });
    h.onRpc = () => Buffer.alloc(0);
    await assert.rejects(run(403), error => error.resultState === 'unknown');
    await assert.rejects(run(403), error => error.resultState === 'unknown');
    assert.equal(h.writes.length, 2, '一次成功+一次未确认，后续禁止重放');
});

test('warehouse Use selects requested UID and shows real rewards once', async () => {
    const h = harness(); h.onRpc = method => method === 'Bag' ? { item_bag: { items: [{ id: 101619, count: 2, uid: '9007199254740993' }] } }
        : { used_items: [{ id: 101619, count: 1 }], items: [{ id: 700001, count: 1 }] };
    const result = await h.load('warehouse').useItem(101619, 1, [], '9007199254740993');
    assert.equal(result.resultState, 'completed'); assert.equal(result.rewards[0].id, 700001);
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].request.item.uid, '9007199254740993');
});
test('warehouse locked pack and unsafe UID sends no mutation', async () => {
    const h = harness(); h.onRpc = () => ({ item_bag: { items: [{ id: 101619, count: 2, uid: 11, locked: true }] } });
    await assert.rejects(h.load('warehouse').useItem(101619, 1));
    assert.throws(() => h.commands.quantity(9007199254740992)); assert.equal(h.writes.length, 0);
});
test('warehouse Use timeout no alternative encoding or replay even after count changes', async () => {
    const h = harness(); let count = 2;
    h.onRpc = method => { if (method === 'Bag') return { item_bag: { items: [{ id: 101619, count, uid: 11 }] } }; throw new Error('timeout'); };
    const service = h.load('warehouse'); await assert.rejects(service.useItem(101619, 1)); count = 1;
    await assert.rejects(service.useItem(101619, 1)); assert.equal(h.writes.length, 1);
});
test('locks are UID scoped and require exact reply or readback proof', async () => {
    const h = harness(); h.onRpc = method => method === 'Bag' ? { item_bag: { items: [{ id: 20001, count: 3, uid: 11 }, { id: 20001, count: 2, uid: 12, locked: true }] } }
        : { item_uids: [11] };
    const result = await h.load('warehouse').setItemsLocked(['11'], true);
    assert.equal(result.changed, 1); assert.equal(h.writes.length, 1); assert.deepEqual(h.writes[0].request.item_uids, ['11']);
});
test('unknown lock UID refuses before request', async () => {
    const h = harness(); h.onRpc = () => ({ item_bag: { items: [{ id: 20001, count: 3, uid: 11 }] } });
    await assert.rejects(h.load('warehouse').setItemsLocked(['12'], true)); assert.equal(h.writes.length, 0);
});
test('bag keeps locked and unlocked same-ID instances separate; locked seeds excluded', async () => {
    const h = harness(); h.onRpc = () => ({ item_bag: { items: [{ id: 20001, count: 3, uid: 11 }, { id: 20001, count: 2, uid: 12, locked: true }] } });
    const warehouse = h.load('warehouse'); const bag = await warehouse.getBagDetail();
    assert.equal(bag.items.length, 2); assert.equal(bag.items[1].locked, true);
    const seeds = await warehouse.getBagSeeds(); assert.equal(seeds[0].count, 3);
});
test('rules allow one-copy first activation, variable next-star costs and explicit rules', () => {
    const h = harness(); const rules = h.load('collection-rules');
    const item = rules.itemRules({ collectionId: 700001, starLevel: 0, ownCount: 1 }, new Map());
    assert.equal(item.canUpgrade, true); assert.equal(item.activated, false); assert.equal(item.nextStarCosts[0].count, 1);
    const next = rules.itemRules({ collectionId: 700001, starLevel: 1, ownCount: 2 }, new Map());
    assert.equal(next.nextStarCosts[0].count, 2); assert.equal(next.nextStarCosts[1].count, 3000000);
});
test('collection upgrade uses latest state, real cost and one write with proof', async () => {
    const h = harness(); let star = 0; let count = 1;
    h.onRpc = method => {
        if (method === 'GetCollections') return { details: [{ category: 1, current_score: star ? 600 : 0, collections: [{ collection_id: 700001, star_level: star, own_count: count }] }] };
        if (method === 'Bag') return { item_bag: { items: [] } };
        if (method === 'UpgradeCollection') { star = 1; count = 0; return { category: 1, collection_id: 700001, star_level: 1, own_count: 0, current_score: 600 }; }
        return {};
    };
    const result = await h.load('collection').upgradeCollection(1, 700001, { expectedStarLevel: 0, expectedCosts: [{ itemId: 700001, count: 1 }] });
    assert.equal(result.starLevel, 1); assert.equal(result.resultState, 'completed'); assert.equal(h.writes.length, 1);
});
test('collection costs mismatch and below-level never writes', async () => {
    const h = harness(); h.onRpc = () => ({ details: [{ category: 1, collections: [{ collection_id: 700001, star_level: 0, own_count: 1 }] }] });
    const service = h.load('collection'); await assert.rejects(service.upgradeCollection(1, 700001, { expectedStarLevel: 0, expectedCosts: [] }));
    h.user.level = 124; await assert.rejects(service.upgradeCollection(1, 700001)); assert.equal(h.writes.length, 0);
});
test('collection display set/clear uses unique scene slot and one write each', async () => {
    const h = harness(); let display = 0;
    h.onRpc = (method, req) => method === 'GetCollections' ? { details: [{ category: 1, current_score: 600, collections: [{ collection_id: 700001, star_level: 1 }] }], display_slots: [{ slot_type: 1, display: { category: 1, item_id: display } }] }
        : method === 'SwitchSceneDisplay' ? (display = Number(req.display_slot.display.item_id), { display_slot: { slot_type: 1, display: { category: 1, item_id: display } } }) : {};
    const service = h.load('collection'); await service.setCollectionDisplay({ collectionId: 700001, displayed: true, confirmed: true, expectedDisplayItemId: 0 });
    await service.setCollectionDisplay({ collectionId: 700001, displayed: false, confirmed: true, expectedDisplayItemId: 700001 });
    assert.equal(h.writes.length, 2); assert.equal(h.writes[1].request.display_slot.display.item_id, '0');
});
test('collection score reward may be an attribute-only milestone, not fake empty reward', async () => {
    const h = harness(); h.onRpc = method => method === 'GetCollections' ? { details: [{ category: 1, current_score: 600, claimed_reward_score: 0 }] }
        : { current_score: 600, claimed_reward_score: 400, claimed_scores: [400] };
    const result = await h.load('collection').claimCollectionReward(1);
    assert.equal(result.resultState, 'completed'); assert.equal(result.claimedRewardScore, 400); assert.equal(h.writes.length, 1);
});
test('mutation catalog is static with actual independent probabilities', () => {
    const h = harness(); const data = h.load('collection-rules').getMutationCatalog();
    assert.equal(h.calls.length, 0); assert.equal(data.readOnly, true); assert.ok(data.normal.length > 0);
    const basic = data.collections.find(series => series.id === 1001); assert.equal(basic.groups[0].probability, 1.2); assert.equal(basic.groups[0].guarantee, 120);
});
test('red packets require claimable state and positive actual rewards', async () => {
    const h = harness(); h.onRpc = method => method === 'GetTodayClaimStatus' ? { infos: [{ id: 1, can_claim: true }] } : { status: 0, item: { id: 1001, count: 100 } };
    const result = await h.load('openserver').claimOpenServerGift(1); assert.equal(result.resultState, 'completed'); assert.equal(h.writes.length, 1);
});
test('empty red packet status is unavailable, not current-date inferred claimable', async () => {
    const h = harness(); h.onRpc = () => Buffer.alloc(0);
    await assert.rejects(h.load('openserver').claimOpenServerGift(1)); assert.equal(h.writes.length, 0);
});
test('red packet empty reward is unknown and no retry', async () => {
    const h = harness(); h.onRpc = method => method === 'GetTodayClaimStatus' ? { infos: [{ id: 1, can_claim: true }] } : { status: 0 };
    const service = h.load('openserver'); await assert.rejects(service.claimOpenServerGift(1)); await assert.rejects(service.claimOpenServerGift(1));
    assert.equal(h.writes.length, 1);
});
test('firework requires placement proof then one ignition and authoritative phase', async () => {
    const h = harness(); let phase = null;
    h.onRpc = method => {
        if (method === 'AllLands') return { lands: [{ id: 1 }], farm_social_events: phase == null ? [] : [{ item_id: 6001, phase }] };
        if (method === 'Bag') return { item_bag: { items: [{ id: 6001, count: 2, uid: 11 }] } };
        if (method === 'Use') { phase = 0; return { used_items: [{ id: 6001, count: 1 }] }; }
        if (method === 'Farming') { phase = 1; return {}; }
    };
    const result = await h.load('firework-use').useFirework(1, 11); assert.equal(result.resultState, 'completed');
    assert.deepEqual(h.writes.map(call => call.method), ['Use', 'Farming']);
});
test('firework timeout after place never repeats consumption or ignition', async () => {
    const h = harness(); let phase = null;
    h.onRpc = method => {
        if (method === 'AllLands') return { lands: [{ id: 1 }], farm_social_events: phase == null ? [] : [{ item_id: 6001, phase }] };
        if (method === 'Bag') return { item_bag: { items: [{ id: 6001, count: 2, uid: 11 }] } };
        if (method === 'Use') { phase = 0; return { used_items: [{ id: 6001, count: 1 }] }; }
        throw new Error('timeout');
    };
    const service = h.load('firework-use'); await assert.rejects(service.useFirework(1)); await assert.rejects(service.useFirework(1));
    assert.deepEqual(h.writes.map(call => call.method), ['Use', 'Farming']);
});
test('official avatar/nameplate art has exact 24-item dual-root mapping and excludes prototype rows', () => {
    const crypto = require('node:crypto');
    const gameConfig = require('../src/config/gameConfig');
    const core = path.join(__dirname, '../src/gameConfig');
    const web = path.join(__dirname, '../../web/public/game-config');
    const relative = 'deco_icons/avatar-frame-sources.json';
    const rawMap = fs.readFileSync(path.join(core, relative));
    assert.deepEqual(rawMap, fs.readFileSync(path.join(web, relative)));
    const map = JSON.parse(rawMap);
    assert.equal(map.manifest.url, 'https://cdn-resource.nqf.qq.com/release/remote/extraRes/config.9fc68.json');
    const entries = Object.values(map.items);
    assert.equal(entries.filter(item => item.frameType === 1).length, 17);
    assert.equal(entries.filter(item => item.frameType === 2).length, 7);
    assert.equal(entries.filter(item => item.source.kind === 'official-atlas-extraction').length, 5);
    for (const item of entries) {
        const filename = item.url.replace('/game-config/', '');
        const raw = fs.readFileSync(path.join(core, filename));
        assert.deepEqual(raw, fs.readFileSync(path.join(web, filename)), item.name);
        assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), item.sha256, item.name);
        assert.equal(raw.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.deepEqual([raw.readUInt32BE(16), raw.readUInt32BE(20)], item.size, item.name);
        assert.equal(item.officialOriginVerified, true);
        assert.notEqual(gameConfig.getItemImageById(item.itemId), '/game-config/deco_icons/icon.png', item.name);
        assert.ok(item.source.url.startsWith('https://cdn-resource.nqf.qq.com/release/remote/extraRes/'));
        if (item.source.kind === 'official-atlas-extraction') assert.equal(item.source.resampling, 'none');
    }
    const catalog = harness().load('avatar-frame').catalog();
    assert.equal(catalog.length, 24);
    for (const item of catalog) assert.equal(item.image, map.items[item.itemId].url, item.name);
    assert.ok(catalog.every(item => ![2101, 2102, 2103].includes(item.itemId)));
    const code = fs.readFileSync(path.join(core, '../config/gameConfig.js'), 'utf8');
    assert.doesNotMatch(code, /const iconMatch = iconRes\.match\(/, '旧正则会把nameplate/icon误映射成icon.png');
});

test('节令题目GET与已确认暂停恢复POST均隔离账号，未确认不得写设置', async () => {
    const handlers = new Map(), calls = [];
    const app = { get: (url, fn) => handlers.set(`GET ${url}`, fn), post: (url, fn) => handlers.set(`POST ${url}`, fn) };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/admin-gameplay-routes.js'), 'utf8'), {
        module, require(name) { if (name === '../services/collection-rules') return { getMutationCatalog: () => ({}) }; throw new Error(name); },
    });
    module.exports.registerAdminGameplayRoutes({ app, provider: { getSolarQuestion: async (...args) => { calls.push(['question', ...args]); return {}; },
        resumeFriendBad: async id => { calls.push(['resume', id]); return { budgetReset: false }; } },
        getAccountIdFromRequest: req => req.headers?.['x-account-id'], canAccessAccount: (_req, id) => id === 'fixture', sendProviderError: () => assert.fail('unexpected error') });
    const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } });
    const get = response(); await handlers.get('GET /api/solar-calendar/questions/:id')({ headers: { 'x-account-id': 'fixture' }, params: { id: '403' } }, get);
    assert.equal(get.body.ok, true); assert.deepEqual(calls, [['question', 'fixture', 403]]);
    const rejected = response(); await handlers.get('POST /api/friend-bad/resume')({ headers: { 'x-account-id': 'fixture' }, body: {} }, rejected);
    assert.equal(rejected.code, 400); assert.equal(calls.length, 1);
    const resume = response(); await handlers.get('POST /api/friend-bad/resume')({ headers: { 'x-account-id': 'fixture' }, body: { confirmed: true } }, resume);
    assert.equal(resume.body.data.budgetReset, false); assert.deepEqual(calls[1], ['resume', 'fixture']);
});

test('11-14修复发布精确覆盖装扮/题目/虫草接线且不扩大网关权限', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '../../cloudbase/.ref/deploy.py')) }, () => {
    const { execFileSync } = require('node:child_process');
    const script = String.raw`
import ast,pathlib,sys
p=pathlib.Path(sys.argv[1]);tree=ast.parse(p.read_text(encoding='utf-8'));env={}
for node in tree.body:
 if isinstance(node,ast.Assign):
  for target in node.targets:
   if isinstance(target,ast.Name) and target.id in {'RELEASE_BACKEND_ALLOWLIST','RELEASE_STATIC_ALLOWLIST','RELEASE_SESSION_FILES'}:
    env[target.id]=ast.literal_eval(node.value)
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='RELEASE_TABS_SKIN_FILES' for t in node.targets):
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(p),'exec'),env)
files=env['RELEASE_TABS_SKIN_FILES']
assert env['RELEASE_SESSION_FILES']<=files
assert files<=env['RELEASE_BACKEND_ALLOWLIST']
assert {'core/src/proto/skinpb.proto','core/src/controllers/admin-skin-routes.js','core/src/runtime/data-provider.js','core/src/core/worker.js','core/src/services/solar-config.js','core/src/services/friend-api.js','core/src/services/friend-operation-limits.js'}<=files
assert 'core/src/runtime/gateway-process.js' not in files
assert not any('wx-login' in x or 'friend-visit-session' in x for x in files)
`;
    const root = path.join(__dirname, '../../');
    execFileSync('C:/Program Files/Python310/python.exe', ['-c', script, path.join(root, 'cloudbase/.ref/deploy.py')], { encoding: 'utf8' });
});

test('暂停同步补丁只改一个挂载模块，PID/TCP或在途写门禁失败不得重载', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '../../cloudbase/.ref/deploy.py')) }, () => {
    const { execFileSync } = require('node:child_process');
    const script = String.raw`
import ast,pathlib,json,sys,io,contextlib,subprocess,urllib.request,copy
from unittest.mock import patch
root=pathlib.Path(sys.argv[1]);source=root/'cloudbase/.ref/deploy.py';tree=ast.parse(source.read_text(encoding='utf-8'))
env={'json':json,'pathlib':pathlib,'REMOTE':'/fixture/project'}
keys={'RELEASE_BACKEND_ALLOWLIST','RELEASE_STATIC_ALLOWLIST','RELEASE_SESSION_FILES','PAUSE_SYNC_PREFLIGHT_SCRIPT'}
for node in tree.body:
 if isinstance(node,ast.Assign):
  for target in node.targets:
   if isinstance(target,ast.Name) and target.id in keys:env[target.id]=ast.literal_eval(node.value)
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in {'RELEASE_PAUSE_SYNC_FILES','RELEASE_PAUSE_SYNC_DEPENDENCIES'} for t in node.targets):
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),env)
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'socket_fingerprints','assert_same_gateway_sessions','deploy_release'}]
exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),env)
assert env['RELEASE_PAUSE_SYNC_FILES']==env['RELEASE_SESSION_FILES']|{'core/src/runtime/runtime-state.js'}
assert env['RELEASE_PAUSE_SYNC_DEPENDENCIES']==env['RELEASE_SESSION_FILES']|{'web-dist/index.html'}
assert env['RELEASE_PAUSE_SYNC_FILES']<=env['RELEASE_BACKEND_ALLOWLIST']
row={'family':'tcp','local':'A:100','remote':'B:443','inode':'100'}
before={'id':'fixture','startedAt':'old','pid':1,'restartCount':0,'gameSockets':[row]}
after={**before,'gameSockets':[],'establishedSockets':[row]}
env['assert_same_gateway_sessions'](before,after)
for field,value in [('id','new'),('startedAt','new'),('pid',2),('restartCount',1),('establishedSockets',[]),('establishedSockets',[{**row,'inode':'101'}])]:
 try:env['assert_same_gateway_sessions'](before,{**after,field:value})
 except RuntimeError:pass
 else:raise AssertionError('changed original session must fail: '+field)
manifest={'migration':'pause-sync-20261114','files':[{'path':name} for name in env['RELEASE_PAUSE_SYNC_FILES']|{'web-dist/index.html'}],
          'requiredUnchangedFiles':list(env['RELEASE_PAUSE_SYNC_DEPENDENCIES'])}
env['load_release_manifest']=lambda archive:manifest
def blocked():raise RuntimeError('offline-ssh-stop')
env['ssh_connect']=blocked
for extra in [{'build_app_only':True},{'allow_gateway_change':True},{'preserve_friend_unknown':True},{'friend_history_stage':'spent'},{'frontend_only':True}]:
 try:env['deploy_release']('fixture',allow_main_reload=True,**extra)
 except RuntimeError as e:assert '仅使用已挂载源码' in str(e)
 else:raise AssertionError('forbidden pause release route accepted')
try:env['deploy_release']('fixture',allow_main_reload=True)
except RuntimeError as e:assert str(e)=='offline-ssh-stop'
else:raise AssertionError('fixture must stop before SSH')
worker={'connected':True,'detached':False,'quiescing':False,'pendingWrites':0,'queue':{'queued':0},
        'healthBackoff':{'active':False},'friendVisit':{'processing':False,'activeGid':0,'holdUntilTransportEpochChanged':False,'recoveryRequired':False}}
manager={'writeCount':0};settings={'friendBadRetryDate':'','automation':{'friend_bad':True}}
record={'accountId':'1','phase':'left','proof':'leave_confirmed'};grace=[170];requests=[]
class Response:
 def __init__(self,data):self.data=data
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self):return json.dumps({'ok':True,'data':self.data}).encode()
class Opener:
 def open(self,req,timeout):
  route=req.full_url.removeprefix('http://127.0.0.1:3007');requests.append(route)
  if route=='/api/login':return Response({'token':'fixture'})
  if route=='/api/settings':return Response(settings)
  if route=='/api/runtime/transport':return Response({'worker':worker,'manager':manager})
  raise AssertionError('only local readonly routes permitted')
class File:
 def __truediv__(self,name):return self
 def read_text(self):return json.dumps(record)
def run_gate(expect_failure=False):
 requests.clear()
 with patch.object(urllib.request,'build_opener',return_value=Opener()),patch.object(pathlib,'Path',return_value=File()),\
      patch.object(subprocess,'check_output',return_value=json.dumps([{'Config':{'StopTimeout':grace[0]}}]).encode()),\
      patch.object(sys,'stdin',io.StringIO(json.dumps({'credentials':{'username':'fixture'},'accountIds':['1']}))),\
      contextlib.redirect_stdout(io.StringIO()) as out:
  try:exec(compile(env['PAUSE_SYNC_PREFLIGHT_SCRIPT'],'fixture-gate','exec'),{})
  except RuntimeError:
   assert expect_failure;return
  assert not expect_failure
  result=json.loads(out.getvalue());assert result['ok'] and not result['gameRpcSent']
  assert requests==['/api/login','/api/settings','/api/runtime/transport']
run_gate()
for obj,key,value in [(worker,'pendingWrites',1),(worker,'connected',False),(worker,'quiescing',True),(manager,'writeCount',1),
                      (worker['friendVisit'],'processing',True),(worker['friendVisit'],'recoveryRequired',True),
                      (worker['friendVisit'],'holdUntilTransportEpochChanged',True),(worker['queue'],'queued',1),
                      (worker['healthBackoff'],'active',True),(settings,'friendBadRetryDate','tomorrow'),(record,'phase','unknown')]:
 old=obj[key];obj[key]=value;run_gate(True);obj[key]=old
value=worker.pop('pendingWrites');run_gate(True);worker['pendingWrites']=value
grace[0]=10;run_gate(True)
print(json.dumps({'ok':True,'guardFailuresVerified':True,'originalTcpNotReconnect':True}))
`;
    const result = execFileSync('C:/Program Files/Python310/python.exe', ['-c', script, path.resolve(__dirname, '../..')],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(JSON.parse(result).guardFailuresVerified, true);
});

test('虫草部署精确六文件，已上线接线和前端不变且禁止网关/镜像/旧恢复入口', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '../../cloudbase/.ref/deploy.py')) }, () => {
    const { execFileSync } = require('node:child_process');
    const script = String.raw`
import ast,pathlib,json,sys,contextlib,io
root=pathlib.Path(sys.argv[1]);source=root/'cloudbase/.ref/deploy.py';tree=ast.parse(source.read_text(encoding='utf-8'))
env={'pathlib':pathlib,'json':json,'REMOTE':'/fixture/project'}
keys={'RELEASE_BACKEND_ALLOWLIST','RELEASE_STATIC_ALLOWLIST','RELEASE_SESSION_FILES','RELEASE_INSPECT_SCRIPT','RELEASE_FRIEND_BAD_CHANGED_FILES','RELEASE_FRIEND_BAD_DEPENDENCIES','RELEASE_FRIEND_BAD_FILES'}
for node in tree.body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in keys for t in node.targets):
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),env)
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='deploy_release']
exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),env)
changed=env['RELEASE_FRIEND_BAD_CHANGED_FILES'];deps=env['RELEASE_FRIEND_BAD_DEPENDENCIES'];files=env['RELEASE_FRIEND_BAD_FILES']
assert len(changed)==6 and files==changed|deps
assert changed=={'core/src/services/friend-api.js','core/src/services/friend-visit.js','core/src/services/friend-orchestrator.js','core/src/services/friend-land-analyzer.js','core/src/services/friend-operation-limits.js','core/src/proto/plantpb.proto'}
assert {'web-dist/index.html','core/src/runtime/runtime-state.js','core/src/services/friend-visit-session.js','core/src/services/stats.js','core/src/utils/proto.js'}<=deps
assert env['RELEASE_SESSION_FILES']<=deps and not any('gateway-process' in f for f in files)
assert files-{'web-dist/index.html'}<=env['RELEASE_BACKEND_ALLOWLIST']
manifest={'migration':'friend-bad-contract-20261115','files':[{'path':f} for f in files],'requiredUnchangedFiles':list(deps)}
env['load_release_manifest']=lambda _:manifest
calls=[]
class Client:
 def close(self):pass
def blocked():calls.append('ssh');raise RuntimeError('offline-ssh-stop')
env['ssh_connect']=blocked
for extra in [{'frontend_only':True},{'allow_gateway_change':True},{'preserve_friend_unknown':True},{'build_app_only':True},{'friend_history_stage':'spent'}]:
 try:env['deploy_release']('fixture',allow_main_reload=True,**extra)
 except RuntimeError as e:assert '仅使用已挂载源码' in str(e)
 else:raise AssertionError('forbidden operation accepted')
assert not calls
try:env['deploy_release']('fixture',allow_main_reload=True)
except RuntimeError as e:assert str(e)=='offline-ssh-stop'
else:raise AssertionError('fixture must stop before real operations')
env['ssh_connect']=lambda:Client()
env['load_panel_credentials']=lambda:{'username':'fixture'}
main={'mounts':{'/app/core/src':'/fixture/project/core/src','/app/web/dist':'/home/example/web-dist'}}
gateway={'health':'healthy','running':True}
for member in deps:
 env['remote_file_json']=lambda *a,**k:{'containers':{'qq-farm-bot':main,'farm-gateway':gateway},'differences':[member]}
 try:env['deploy_release']('fixture',allow_main_reload=True)
 except RuntimeError as e:assert '依赖变化' in str(e)
 else:raise AssertionError('changed dependency not blocked: '+member)
assert source.read_text(encoding='utf-8').count('if pause_sync or friend_bad_contract:')==2
print(json.dumps({'ok':True,'exactSixFiles':True,'noGatewayOrRecovery':True,'immutableDepsChecked':len(deps)}))
`;
    const result = execFileSync('C:/Program Files/Python310/python.exe', ['-c', script, path.resolve(__dirname, '../..')],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(JSON.parse(result).exactSixFiles, true);
});

test('gameplay release entry uses exact dependencies, static-only acceptance and never old Leave recovery', { skip: !require('node:fs').existsSync(require('node:path').join(__dirname, '../../cloudbase/.ref/deploy.py')) }, () => {
    const { execFileSync } = require('node:child_process');
    const script = String.raw`
import ast, pathlib, io, json, contextlib, sys
root=pathlib.Path(sys.argv[1])
source=root/'cloudbase/.ref/deploy.py'
tree=ast.parse(source.read_text(encoding='utf-8'))
env={'json':json,'pathlib':pathlib,'REMOTE':'/fixture/project'}
for node in tree.body:
    if isinstance(node,ast.Assign):
        for target in node.targets:
            if isinstance(target,ast.Name) and target.id in {'RELEASE_BACKEND_ALLOWLIST','RELEASE_STATIC_ALLOWLIST','RELEASE_SESSION_FILES','RELEASE_INSPECT_SCRIPT'}:
                env[target.id]=ast.literal_eval(node.value)
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in {'inspect_release','deploy_release','package_gameplay_release'}]
exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),env)
assert env['RELEASE_STATIC_ALLOWLIST']=={'core/src/gameConfig/land_images/land_valid6.png','core/src/gameConfig/land_images/land_valid6_2x2.png','core/src/gameConfig/land_images/sources.json'}
required={'core/src/services/game-command.js','core/src/services/avatar-frame.js','core/src/services/json-db.js','core/src/services/collection-rules.js','core/src/runtime/data-provider.js','core/src/utils/proto.js','core/src/config/gameConfig.js','core/src/proto/itempb.proto','core/src/proto/corepb.proto','core/src/proto/avatarframepb.proto','core/src/proto/solartermspb.proto','core/src/gameConfig/BuffCfg.json'}
assert required<=env['RELEASE_BACKEND_ALLOWLIST']
seen=[]
class Client:
    def close(self): pass
def inspect(client,script,payload,**kwargs):
    assert payload['announcements'] is False and payload['accept'] is False
    seen.append(payload)
    return {'ok':True}
def blocked(*args,**kwargs): raise RuntimeError('offline-preflight-stop')
env.update({'load_release_manifest':lambda archive:{'name':'fixture','migration':'gameplay-20261111','files':[{'path':'core/src/services/avatar-frame.js'}]},'ssh_connect':lambda:Client(),'load_panel_credentials':lambda:{'username':'fixture'},'remote_file_json':inspect,'friend_visit_recovery_evidence':lambda *a,**k:sys.exit('禁止旧恢复'),'ssh_connect':blocked})
# Normal business image activation is allowed only for the fixed migration and
# never touches the spent historical friend-recovery entry.
try: env['deploy_release']('fixture',allow_main_reload=True,build_app_only=True)
except RuntimeError as error: assert str(error)=='offline-preflight-stop'
else: raise AssertionError('should stop at fake SSH')
env['load_release_manifest']=lambda archive:{'name':'wrong','files':[]}
try: env['deploy_release']('fixture',allow_main_reload=True,build_app_only=True)
except RuntimeError as error: assert '11-11' in str(error)
else: raise AssertionError('generic build-only release must be blocked')
env['load_release_manifest']=lambda archive:{'files':[{'path':'core/src/services/avatar-frame.js'}]}
env['ssh_connect']=lambda:Client()
with contextlib.redirect_stdout(io.StringIO()):
    env['inspect_release']('fixture',no_game_rpc=True)
    env['inspect_release']('fixture',accept=True,no_game_rpc=True)
assert seen[0]['staticAccept'] is False and seen[1]['staticAccept'] is True
assert all(value['noGameRpc'] is True for value in seen)
print(json.dumps({'ok':True,'noGameRpc':True,'noOldRecovery':True,'exactAllowlist':True}))
`;
    const python = process.platform === 'win32' ? 'C:/Program Files/Python310/python.exe' : 'python3';
    const result = execFileSync(python, ['-c', script, path.resolve(__dirname, '../..')],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(JSON.parse(result).ok, true);
});

function accountFrontendHarness(get) {
    const { createRequire } = require('node:module');
    const webRequire = createRequire(path.join(__dirname, '../../web/package.json'));
    const vue = webRequire('vue');
    const pinia = webRequire('pinia');
    const ts = webRequire('typescript');
    const accountId = vue.ref('A');
    const filename = path.join(__dirname, '../../web/src/stores/account.ts');
    const module = { exports: {} };
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(compiled, { module, exports: module.exports, console,
        require(name) {
            if (name === 'vue') return vue;
            if (name === 'pinia') return pinia;
            if (name === '@vueuse/core') return { useStorage: () => accountId };
            if (name === '@/api') return { __esModule: true, default: { get } };
            if (name === '@/utils/operation-result') {
                const resultModule = { exports: {} };
                const resultSource = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../web/src/utils/operation-result.ts'), 'utf8'), {
                    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
                }).outputText;
                vm.runInNewContext(resultSource, { module: resultModule, exports: resultModule.exports });
                return resultModule.exports;
            }
            throw new Error(`禁止加载账号夹具依赖：${name}`);
        } }, { filename });
    const instance = pinia.createPinia();
    const store = module.exports.useAccountStore(instance);
    const snapshot = (id = 'A', overrides = {}) => ({ accountId: id, groups: [{ frameType: 1, stateKnown: true,
        items: [{ frameId: 301, owned: true, equipped: true, name: '柯基', image: '/game-config/deco_icons/img_keji_head_bg.png', ...overrides }] }] });
    return { store, accountId, snapshot, dispose: () => pinia.disposePinia(instance) };
}

test('header frame accepts one explicit equipped frame only, clears unknown/unowned/invalid state', () => {
    const h = accountFrontendHarness(async () => assert.fail('纯快照测试不能读取HTTP'));
    try {
        assert.equal(h.store.applyAvatarFrameSnapshot(h.snapshot()), true);
        assert.equal(h.store.equippedAvatarFrame.frameId, 301);
        assert.equal(h.store.applyAvatarFrameSnapshot(h.snapshot('B')), false);
        for (const patch of [{ equipped: null }, { equipped: undefined }, { owned: false }, { resultUnknown: true }, { frameId: -1 }, { equipped: false }, { image: '' }]) {
            h.store.applyAvatarFrameSnapshot(h.snapshot('A', patch));
            assert.equal(h.store.equippedAvatarFrame, null);
        }
        const duplicate = h.snapshot(); duplicate.groups[0].items.push({ ...duplicate.groups[0].items[0], frameId: 203 });
        h.store.applyAvatarFrameSnapshot(duplicate); assert.equal(h.store.equippedAvatarFrame, null);
        const unknown = h.snapshot(); unknown.groups[0].stateKnown = false;
        h.store.applyAvatarFrameSnapshot(unknown); assert.equal(h.store.equippedAvatarFrame, null);
    } finally { h.dispose(); }
});

test('avatar shared snapshot neutralizes an old backend that reports all ownership rows as worn', async () => {
    const h = accountFrontendHarness(async () => ({ data: { ok: true, data: {
        accountId: 'A', groups: [{ frameType: 1, stateKnown: true, equippedIds: [301, 203],
            items: [{ frameId: 301, owned: true, equipped: true, image: '/a.png' }, { frameId: 203, owned: true, equipped: true, image: '/b.png' }] }],
    } } }));
    try {
        const snapshot = await h.store.fetchAvatarFrames('A');
        assert.equal(snapshot.groups[0].stateKnown, false);
        assert.equal(snapshot.groups[0].items.filter(item => item.equipped === true).length, 0);
        assert.equal(h.store.equippedAvatarFrame, null);
        assert.match(snapshot.warning, /冲突/);
    } finally { h.dispose(); }
});

test('header and avatar panel share one in-flight read, failed or A-B-A late results cannot restore old art', async () => {
    let resolve;
    let calls = 0;
    const pending = new Promise(done => { resolve = done; });
    const h = accountFrontendHarness(async url => { assert.equal(url, '/api/avatar-frames'); calls++; return pending; });
    try {
        const first = h.store.fetchAvatarFrames('A');
        const second = h.store.fetchAvatarFrames('A');
        assert.equal(calls, 1, 'Pinia可包装订阅Promise，但底层HTTP只能发一次');
        h.accountId.value = 'B'; h.accountId.value = 'A';
        assert.equal(h.store.equippedAvatarFrame, null);
        resolve({ data: { ok: true, data: h.snapshot() } });
        assert.equal(await first, null);
        assert.equal(await second, null);
        assert.equal(h.store.equippedAvatarFrame, null);
        await h.store.fetchAvatarFrames('A');
        assert.equal(calls, 2); assert.equal(h.store.equippedAvatarFrame.frameId, 301);
        h.store.clearAvatarFrame(); assert.equal(h.store.equippedAvatarFrame, null);
    } finally { h.dispose(); }
    const failed = accountFrontendHarness(async () => { throw new Error('读取失败'); });
    try {
        failed.store.applyAvatarFrameSnapshot(failed.snapshot());
        await assert.rejects(failed.store.fetchAvatarFrames(), /读取失败/);
        assert.equal(failed.store.equippedAvatarFrame, null);
    } finally { failed.dispose(); }
});

test('frontends and provider + worker + private routes expose exact migrated operations', () => {
    const read = name => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');
    const provider = read('core/src/runtime/data-provider.js'); const worker = read('core/src/core/worker.js');
    for (const name of ['getAvatarFrames', 'operateAvatarFrame', 'getSolarCalendar', 'operateSolarCalendar', 'setItemsLocked', 'setCollectionDisplay', 'getOpenServerGifts', 'claimOpenServerGift']) {
        assert.ok(provider.includes(`${name}:`), name); assert.ok(worker.includes(`case '${name}':`), name);
    }
    assert.ok(read('core/src/controllers/admin.js').includes('registerAdminGameplayRoutes({'));
    assert.ok(read('web/src/components/BagPanel.vue').includes('[11, 33]'));
    assert.ok(read('web/src/views/Personal.vue').includes('AvatarFramePanel'));
    assert.ok(read('web/src/components/collection/CollectionCard.vue').includes("'激活'"));
    assert.ok(!read('web/src/router/menu.ts').includes("path: 'solar-calendar'"), '导航不能保留重复日历入口');
    assert.ok(read('web/src/router/index.ts').includes("path: 'solar-calendar'"), '旧URL必须兼容跳转');
    assert.ok(read('web/src/views/Activity.vue').includes('ref="solarPanel"'));
});

/**
 * Reproducible offline preview: compile the real Vue components and stores, but
 * resolve every HTTP/account/status dependency to an in-memory fixture. This
 * entry never loads a game transport, panel credentials, socket or worker.
 * Opt in with FARM_GAMEPLAY_PREVIEW_DIR and FARM_EDGE_EXECUTABLE.
 */
function previewFixtures() {
    const gameConfig = require('../src/config/gameConfig');
    const h = harness();
    const rules = h.load('collection-rules');
    const definitions = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/ItemInfo.json'), 'utf8'));
    const info = Array.isArray(definitions) ? definitions : Object.values(definitions);
    const imageCache = new Map();
    function dataImage(url) {
        if (!url || !url.startsWith('/')) return '';
        if (imageCache.has(url)) return imageCache.get(url);
        const relative = decodeURIComponent(url.split('?')[0].slice(1));
        const candidates = [path.join(__dirname, '../../web/public', relative)];
        if (url.startsWith('/game-config/')) candidates.push(path.join(__dirname, '../src/gameConfig', relative.slice('game-config/'.length)));
        // The app also serves static gameConfig assets from the core root. Use
        // those exact local bytes; a missing web mirror is not a missing icon.
        const file = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        let result = '';
        if (file) {
            const extension = path.extname(file).toLowerCase();
            const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[extension];
            if (mime) result = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
        }
        imageCache.set(url, result);
        return result;
    }
    const avatarArt = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/gameConfig/deco_icons/avatar-frame-sources.json'), 'utf8')).items;
    const metadata = id => {
        const item = gameConfig.getItemById(id) || {};
        return { name: item.name || `物品${id}`, desc: item.desc || '', itemType: item.type || 0,
            rarity: item.rarity || 1, rarityColor: item.rarity_color || '', level: item.level || 0,
            image: dataImage(avatarArt[id]?.url || gameConfig.getItemImageById(id)) };
    };
    const frameCatalog = info.filter(item => Number(item.type) === 10 && /头像框|铭牌/.test(item.name || '') && item.icon_res);
    const groups = [1, 2].map(frameType => {
        const entries = frameCatalog.filter(item => (/铭牌/.test(item.name) ? 2 : 1) === frameType);
        const items = entries.map((item, index) => ({ ...metadata(item.id), itemId: item.id,
            frameId: Number(item.target_id) > 0 ? Number(item.target_id) : item.id, frameType,
            owned: index < 4, equipped: index === 0 ? true : false,
            resultUnknown: false }));
        return { frameType, label: frameType === 1 ? '头像框' : '铭牌', items,
            equippedIds: items.filter(item => item.equipped).map(item => item.frameId), stateKnown: true };
    });
    assert.ok(groups.every(group => group.items.length >= 3), '本地配置需包含头像框及铭牌，不能编造目录');
    const catalog = rules.configs().CollectionItem.map((entry, index) => ({ ...metadata(entry.item_id),
        collectionId: entry.item_id, starLevel: index === 1 ? 1 : index === 2 ? 2 : index === 3 ? 5 : 0,
        ownCount: index === 0 ? 1 : index === 1 ? 3 : index === 2 ? 1 : 0, isNew: index === 0,
        firstObtainedTime: 0, iconRes: gameConfig.getItemById(entry.item_id)?.icon_res || '' }));
    const owned = new Map(catalog.map(item => [item.collectionId, item]));
    const score = catalog.reduce((sum, item) => sum + rules.itemRules(item, owned).score, 0);
    const category = rules.applyRules({ category: 1, currentScore: score, claimedRewardScore: 400,
        collectionLikeCount: 0, pedestalLikeCount: 0, collections: catalog,
        pedestals: [], wished: [] }, catalog[1].collectionId);
    for (const item of category.collections) for (const cost of item.nextStarCosts) {
        cost.name = metadata(cost.itemId).name;
        cost.image = metadata(cost.itemId).image;
    }
    const bagSpecs = [
        { id: 101619, uid: '9007199254740993', count: 2 },
        { id: 101618, uid: '10002', count: 1 },
        { id: 20003, uid: '10003', count: 18, locked: false },
        { id: 20003, uid: '10004', count: 7, locked: true },
        { id: 29003, uid: '10005', count: 4, plantSize: 2 },
        { id: 40003, uid: '10006', count: 36, price: 12, priceId: 1001, priceUnit: '金币' },
        { id: 6001, uid: '10007', count: 2 },
    ];
    const bag = bagSpecs.map(item => ({ ...metadata(item.id), locked: false, ...item, groupKey: `${item.id}:${item.uid}` }));
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/activity-data/solar-calendar.json'), 'utf8'));
    const configSources = { repository: 'liyangpengs/qq-farm-bot', commit: 'a459b0ab787c75ab7cfe8cd16899dbd1f6d7fca7', config: 'solar-calendar.json' };
    const legacy = { nowTime: 0, terms: [{ id: 403, title: '立冬', status: 2, statusLabel: '可领取', claimable: true, startTime: 1, endTime: 2,
        rewards: [{ itemId: 1001, itemCount: 20, itemName: '金币', image: metadata(1001).image }] }], claimableCount: 1 };
    // Obtain the clock from the runtime, not a hand-calculated timestamp. The
    // windows below are deliberately synthetic, never evidence of live opening.
    const now = Math.floor(Date.now() / 1000);
    const reward = (id, count) => ({ id, count, ...metadata(id) });
    const events = [401, 402, 403].map((id, index) => {
        const entry = config.events.find(value => value.id === id);
        return { id, name: entry.name, description: entry.description, startTime: now - (3 - index) * 86400,
            endTime: index === 2 ? now + 2 * 86400 : now - 86400, status: index === 2 ? 2 : 3,
            open: index === 2, directClaimed: index === 0, quizClaimed: index === 0,
            quizWrongToday: false, wrongOptions: [], question: entry.question || '',
            options: String(entry.answer || '').split(';').filter(Boolean), answerIndex: entry.answer_index ?? null,
            answerSource: configSources, rewards: [reward(1002, 200)], questionRewards: [reward(1002, 100)],
            rules: ['模拟时间窗口仅用于展示，不表示当前游戏可领取。'], errorTips: entry.error_tips || '',
            canClaim: index === 2, canAnswer: index === 2 };
    });
    const season = config.seasons.find(value => value.id === 4);
    const calendar = { serverTime: now, defaultEventId: 403, events,
        seasons: [{ ...season, eventIds: events.map(event => event.id), litCount: 1, totalCount: 3,
            claimed: false, canClaim: false, rewards: [reward(1002, 300)] }], configSources };
    const mutation = rules.getMutationCatalog();
    for (const group of [mutation.normal, mutation.decoration]) for (const item of group) item.image = dataImage(item.image);
    for (const series of mutation.collections) for (const item of series.items) item.image = metadata(item.id).image;
    const buildAssets = path.join(process.env.FARM_GAMEPLAY_BUILD_DIR || path.resolve(__dirname, '../../.workbuddy/frontend-20261111-gameplay-migration'), 'assets');
    const head = fs.readdirSync(buildAssets).find(name => /^default_head-.*\.png$/.test(name));
    const avatar = head ? `data:image/png;base64,${fs.readFileSync(path.join(buildAssets, head)).toString('base64')}` : '';
    return { groups, category, bag, calendar, legacy, mutation, avatar, generatedAt: new Date().toISOString(),
        frameWarning: '当前佩戴状态为模拟已确认；可切换“操作结果不确定”检查未知保护。',
        sources: { collection: rules.configs().source, calendar: configSources },
        images: [...imageCache.entries()].map(([url, data]) => ({ url, embedded: !!data })) };
}

async function buildOfflineGameplayPreview(directory) {
    const { createRequire } = require('node:module');
    const { createHash } = require('node:crypto');
    const web = path.resolve(__dirname, '../../web');
    const webRequire = createRequire(path.join(web, 'package.json'));
    const compiler = webRequire('vue/compiler-sfc');
    const viteRequire = createRequire(webRequire.resolve('vite/package.json'));
    const esbuild = viteRequire('esbuild');
    const fixtures = previewFixtures();
    const styles = [];
    const sources = new Map();
    const fixtureJson = JSON.stringify(fixtures);
    const mockCode = String.raw`
import { computed, ref, reactive } from 'vue'
import { defineStore } from 'pinia'
import { useAccountStore } from '@/stores/account'
import fixtures from 'farm:fixtures'
export const state = reactive({ accountId: 'fixture-A', scenario: 'normal', page: 'calendar', epoch: 0 })
export const audit = reactive({ mockReads: 0, legacyReads: 0, mockWrites: 0, realRequests: 0, blockedAttempts: 0, errors: [], toasts: [] })
const copy = value => JSON.parse(JSON.stringify(value))
export const useStatusStore = defineStore('offline-status', () => ({
  status: computed(() => ({ status: { name: state.accountId === 'fixture-A' ? '模拟账号 A' : '模拟账号 B', avatar: fixtures.avatar }, connection: { connected: state.scenario !== 'offline' } })),
  loading: ref(false), error: ref(''), realtimeConnected: ref(true), currentStatusReady: ref(true),
  fetchStatus: async () => {}, clearAccountScopedData: () => {}
}))
export function useToastStore() {
  return Object.fromEntries(['success', 'warning', 'error', 'info'].map(tone => [tone, message => { audit.toasts.push({ tone, message }); if (audit.toasts.length > 4) audit.toasts.shift() }]))
}
function payload(url, accountId) {
  if (url === '/api/accounts') return { accounts: ['fixture-A', 'fixture-B'].map(id => ({ id, name: id === 'fixture-A' ? '模拟账号 A' : '模拟账号 B', avatar: fixtures.avatar, platform: 'qq', running: true })) }
  if (url === '/api/status') return { status: { level: accountId === 'fixture-A' ? 125 : 106 }, connection: { connected: state.scenario !== 'offline' } }
  if (url === '/api/avatar-frames') {
    const groups = copy(fixtures.groups)
    if (state.scenario === 'empty') groups.forEach(group => { group.items = []; group.equippedIds = [] })
    if (accountId === 'fixture-B') groups.forEach(group => { group.items.forEach(item => { item.equipped = false }); group.equippedIds = [] })
    if (state.scenario === 'unknown') groups.forEach(group => { group.stateKnown = false; group.items.forEach(item => { item.equipped = null; item.resultUnknown = item.owned }) })
    if (state.scenario === 'conflict') groups.forEach(group => { group.equippedIds = group.items.filter(item => item.owned).map(item => item.frameId); group.items.forEach(item => { item.equipped = item.owned }) })
    return { accountId, groups, warning: state.scenario === 'unknown' ? '模拟：上次更换外观结果未确认，只能刷新，不可重提。' : fixtures.frameWarning }
  }
  if (url === '/api/bag') {
    const items = state.scenario === 'empty' ? [] : copy(fixtures.bag)
    return { items, originalItems: copy(items) }
  }
  if (url === '/api/collection') {
    const category = copy(fixtures.category)
    if (state.scenario === 'empty') category.collections = []
    if (accountId !== 'fixture-A' || state.scenario === 'unknown') category.collections.forEach(item => { item.canUpgrade = false })
    return { accountId, userLevel: accountId === 'fixture-A' ? 125 : 106, details: [category], displaySlots: [{ slotType: 1, itemId: fixtures.category.collections[1].collectionId, pedestalId: 0 }] }
  }
  if (url === '/api/solar-terms') return state.scenario === 'empty' ? { terms: [], claimableCount: 0 } : copy(fixtures.legacy)
  if (url === '/api/solar-calendar') {
    const calendar = copy(fixtures.calendar)
    calendar.accountId = accountId
    if (state.scenario === 'empty') { calendar.events = []; calendar.seasons = [] }
    if (state.scenario === 'unknown') {
      calendar.events.forEach(event => { event.canClaim = false; event.canAnswer = false; event.claimResultUnknown = true; event.answerResultUnknown = true })
      calendar.seasons.forEach(season => { season.canClaim = false; season.resultUnknown = true })
    }
    return calendar
  }
  if (url === '/api/illustrated/mutations') return copy(fixtures.mutation)
  if (url === '/api/open-server-gifts') return { accountId, packets: state.scenario === 'empty' || state.scenario === 'unknown' ? [] : [{ id: 1, canClaim: true }, { id: 2, canClaim: false }], message: state.scenario === 'normal' ? '模拟开放状态；尚未核实线上活动是否可领。' : '模拟：服务端未提供可领取的红包状态，不推断活动开放。' }
  throw new Error('离线预览禁止未声明的读取：' + url)
}
function rejectUnknown(message) {
  return Object.assign(new Error(message), { response: { data: { ok: false, error: message, sent: true, resultState: 'unknown', outcomeUnknown: true } } })
}
const api = {
  async get(url, options = {}) {
    audit.mockReads++
    if (url === '/api/solar-terms') audit.legacyReads++
    const id = String(options.headers?.['x-account-id'] || state.accountId)
    if (state.scenario === 'error' && url !== '/api/illustrated/mutations') throw Object.assign(new Error('模拟读取失败：未连接任何真实服务器'), { response: { data: { error: '模拟读取失败：未连接任何真实服务器' } } })
    return { data: { ok: true, data: payload(url, id) } }
  },
  async post(url, input, options = {}) {
    const allowed = ['/api/avatar-frames/equip', '/api/avatar-frames/unequip', '/api/bag/lock', '/api/bag/use', '/api/bag/sell', '/api/collection/upgrade', '/api/collection/display', '/api/collection/claim', '/api/solar-calendar/claim', '/api/solar-calendar/answer', '/api/solar-calendar/season', '/api/open-server-gifts/claim']
    if (!allowed.includes(url)) throw new Error('离线预览禁止未声明的写入：' + url)
    audit.mockWrites++
    if (state.scenario === 'unknown') throw rejectUnknown('模拟结果不确定；请只刷新，不重提')
    // Buttons retain their real confirmation flow. Confirming only demonstrates
    // an in-memory response, and never starts any game action or real HTTP.
    const accountId = String(options.headers?.['x-account-id'] || state.accountId)
    useToastStore().info('此为模拟确认，未发送游戏请求，未扣除任何真实资源')
    const data = { accountId, resultState: 'completed', retryable: false, rewards: [{ id: 1001, name: '模拟金币', count: 100 }], totalRewards: [{ id: 1001, count: 100 }] }
    if (url.includes('/solar-calendar/')) { data.calendar = payload('/api/solar-calendar', accountId); data.correct = input.optionIndex === 0 }
    return { data: { ok: true, data } }
  }
}
export default api
`;
    const entry = String.raw`
import { createApp, h, nextTick, onMounted, watch } from 'vue'
import { createPinia } from 'pinia'
import Avatar from '@/components/AvatarFramePanel.vue'
import Calendar from '@/views/SolarCalendar.vue'
import Bag from '@/components/BagPanel.vue'
import Collection from '@/views/Collection.vue'
import Mutation from '@/components/MutationCatalogPanel.vue'
import Gifts from '@/components/OpenServerGiftPanel.vue'
import TopAccountMenu from '@/components/TopAccountMenu.vue'
import { useAccountStore } from '@/stores/account'
import { state, audit } from 'farm:mock'
const pages = [
  { key: 'avatar', label: '头像框与铭牌', route: '个人 · 头像框与铭牌', component: Avatar },
  { key: 'calendar', label: '节令小礼（统一入口）', route: '活动 · 节令小礼 · 日历 / 问答 / 季度集册', component: Calendar },
  { key: 'bag', label: '背包与礼包', route: '个人 · 背包 · 实例锁定 / 藏品礼包 / 烟花', component: Bag },
  { key: 'collection', label: '藏品补全', route: '藏品 · 首次激活 / 真实材料 / 场景展示', component: Collection },
  { key: 'mutation', label: '变异宝典', route: '个人 · 变异宝典 · 公开概率 / 独立保底', component: Mutation },
  { key: 'gifts', label: '开服红包', route: '任务 · 开服红包 · 手动查询 / 领取', component: Gifts }
]
const query = new URLSearchParams(location.search)
if (pages.some(page => page.key === query.get('page'))) state.page = query.get('page')
if (['normal', 'unknown', 'conflict', 'empty', 'error', 'offline'].includes(query.get('case'))) state.scenario = query.get('case')
const guard = kind => (...args) => { audit.blockedAttempts++; throw new Error('离线预览禁止真实 ' + kind) }
window.fetch = guard('fetch')
window.XMLHttpRequest = class { constructor() { guard('XHR')() } }
window.WebSocket = class { constructor() { guard('WebSocket')() } }
window.EventSource = class { constructor() { guard('EventSource')() } }
try { navigator.sendBeacon = guard('sendBeacon') } catch {}
addEventListener('error', event => audit.errors.push(event.message))
addEventListener('unhandledrejection', event => audit.errors.push(String(event.reason?.message || event.reason)))
addEventListener('securitypolicyviolation', event => audit.errors.push('CSP: ' + event.violatedDirective + ' ' + event.blockedURI))
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick() } }
const content = () => document.getElementById('actual-component')
const button = (root, text) => [...root.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.textContent.trim().startsWith(text + ' ') || item.closest('.bag-categories') && item.textContent.trim().startsWith(text))
const ensure = (condition, message) => { if (!condition) throw new Error(message) }
async function waitImages(images) {
  await Promise.all([...images].map(image => new Promise((resolve, reject) => {
    image.loading = 'eager'
    if (image.complete && image.naturalWidth) return resolve()
    image.addEventListener('load', resolve, { once: true })
    image.addEventListener('error', () => reject(new Error('真实资源图加载失败')), { once: true })
  })))
}
const geometry = () => {
  const root = content(), width = document.documentElement.clientWidth
  const escaped = [...root.querySelectorAll('*')].filter(element => {
    const r = element.getBoundingClientRect(), style = getComputedStyle(element)
    return r.width > 0 && r.height > 0 && style.display !== 'none' && r.right > width + 1
  }).map(element => ({ tag: element.tagName, text: element.textContent.trim().slice(0, 50), right: Number(element.getBoundingClientRect().right.toFixed(2)) })).slice(0, 8)
  return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, escaped }
}
async function showPage(key) {
  state.page = key
  state.epoch++
  await flush()
  if (key === 'bag') { await new Promise(resolve => setTimeout(resolve, 1)); button(content(), '全部')?.click(); await flush() }
  if (key === 'gifts') { button(content(), '查询状态')?.click(); await flush() }
}
async function checks() {
  const initial = { page: state.page, scenario: state.scenario, accountId: state.accountId }
  const rows = []
  state.scenario = 'normal'
  for (const page of pages) {
    await showPage(page.key)
    let root = content(), text = root.textContent
    if (page.key === 'avatar') {
      ensure(root.querySelectorAll('article').length === 17, '真实头像框组件未展示17款')
      ensure([...root.querySelectorAll('article span')].filter(item => item.textContent.trim() === '佩戴中').length === 1, '头像框只能一个佩戴徽标')
      const overlay = document.querySelector('.account-avatar-frame')
      ensure(overlay?.dataset.frameId === String(useAccountStore().equippedAvatarFrame?.frameId), '真实右上角未显示已确认佩戴头像框')
      state.checkStep = 'header-image'
      await waitImages([overlay])
      const frameRect = overlay.getBoundingClientRect(), portrait = document.querySelector('.account-avatar-core').getBoundingClientRect()
      ensure(frameRect.width > portrait.width && frameRect.height > portrait.height && frameRect.left < portrait.left, '头像框叠层被裁剪到头像内')
      ensure(getComputedStyle(overlay.parentElement).overflow !== 'hidden', '头像框外层不应截断装饰')
      ensure(root.querySelectorAll('article img').length === 17, '头像框不能以首字占位交付')
      state.checkStep = 'all-frame-images'
      await waitImages(root.querySelectorAll('article img'))
      ensure([...root.querySelectorAll('article img')].every(image => image.naturalWidth === 128), '头像框真实原图未解码')
      ensure([...root.querySelectorAll('button')].some(item => item.textContent.trim() === '换上' && item.disabled), '已佩戴/未拥有条目未禁用')
      button(root, '铭牌')?.click(); await flush()
      ensure(root.querySelectorAll('article img').length === 7, '七款铭牌真实图缺失')
      await waitImages(root.querySelectorAll('article img'))
      ensure([...root.querySelectorAll('article img')].every(image => image.naturalWidth === 100), '铭牌不能用通用icon图代替')
      ensure(root.textContent.includes('铭牌'), '真实铭牌tab未切换')
      ensure([...root.querySelectorAll('article span')].filter(item => item.textContent.trim() === '佩戴中').length === 1, '铭牌只能一个佩戴徽标')
    }
    if (page.key === 'calendar') {
      ensure(text.includes('立冬') && text.includes('集齐奖励'), '真实日历/季度进度未展示')
      const eventCards = [...root.querySelectorAll('li[data-event-id]')]
      ensure(eventCards.map(item => Number(item.dataset.eventId)).join(',') === '403,402,401', '最新立冬必须置顶，霜降/重阳倒序')
      ensure(eventCards[0].classList.contains('solar-event--featured'), '当前最新节令未突出主卡')
      ensure(root.querySelectorAll('.solar-reward-lane').length === 6, '基础小礼与答题奖励没有独立布局')
      ensure(text.includes('PushPlus 微信订阅') && !text.includes('PushPlus 邮件'), '节令页面仍在引导邮件而不是日报微信通道')
      const quizButton = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === '查看题目' && item.closest('li')?.textContent.includes('立冬'))
      ensure(quizButton, '缺少立冬题目入口'); quizButton.click(); await flush()
      ensure(root.querySelectorAll('input[type=radio]').length === 4, '真实问答选项未展示')
      ensure(root.querySelector('.solar-question')?.closest('li')?.dataset.eventId === '403', '问答应在当前立冬卡片内原位展开')
      ensure([...root.querySelectorAll('input[type=radio]')].every(item => !item.checked), '预览不能自动选择答案')
      ensure(button(root, '确认提交答案')?.disabled, '未选答案时不能提交')
      ensure(root.textContent.includes('显示上游题库参考'), '配置答案应由用户手动查看')
      button(root, '关闭')?.click(); await flush()
      const theme = document.documentElement, originalThemeStyle = theme.getAttribute('style')
      theme.classList.add('dark')
      Object.entries({ '--theme-text': '#f3f4f6', '--surface-1': '#1e211a', '--surface-2': '#262b20', '--surface-3': '#2e3427', '--surface-border': 'rgba(255,255,255,.08)' }).forEach(([key, value]) => theme.style.setProperty(key, value))
      await flush()
      const channels = value => value.match(/[\\d.]+/g)?.map(Number) || []
      const ink = channels(getComputedStyle(root.querySelector('.solar-event h2')).color)
      const surface = channels(getComputedStyle(root.querySelector('.solar-event')).backgroundColor)
      ensure(ink.slice(0, 3).every(value => value > 180) && surface.slice(0, 3).every(value => value < 80), '深色主题应有浅色文字和深色表面')
      theme.classList.remove('dark')
      if (originalThemeStyle === null) theme.removeAttribute('style'); else theme.setAttribute('style', originalThemeStyle)
      await flush()
      const compatibility = [...root.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.includes('旧版节令记录'))
      ensure(compatibility, '统一入口必须保留旧版兼容记录')
      ensure(audit.legacyReads === 0, '默认不应重复读取旧版记录')
      const toggled = new Promise(resolve => compatibility.addEventListener('toggle', resolve, { once: true }))
      compatibility.querySelector('summary').click(); await toggled; await flush()
      ensure(audit.legacyReads === 1, '仅展开时读取一次旧版记录')
      ensure(![...compatibility.querySelectorAll('button')].some(item => item.textContent.trim() === '领取奖励' && !item.disabled), 'V1/V2同ID不应双领奖')
      compatibility.querySelector('summary').click(); await flush()
    }
    if (page.key === 'bag') {
      ensure(text.includes('金豆豆藏品礼包') && text.includes('钻石藏品礼包'), '真实背包未展示type33礼包')
      await new Promise(resolve => setTimeout(resolve, 1))
      button(root, '详情')?.click(); await flush()
      ensure(root.textContent.includes('9007199254740993'), '背包实例详情UID丢失精度')
      await new Promise(resolve => setTimeout(resolve, 1))
      button(root, '关闭')?.click(); await flush()
      ensure(text.includes('解锁') && text.includes('锁定'), '同ID不同实例锁定状态未展示')
      const lock = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === '锁定')
      await new Promise(resolve => setTimeout(resolve, 1))
      lock.click(); await flush()
      ensure(root.textContent.includes('确认锁定'), '锁定确认框缺失')
      const action = [...root.querySelectorAll('.confirm-modal-actions button')].at(-1)
      ensure(action?.textContent.trim() === '确认锁定', '锁定确认按钮不能标成确认使用')
      button(root, '取消')?.click(); await flush()
    }
    if (page.key === 'collection') {
      ensure(text.includes('Lv.125') && text.includes('图标待补'), '藏品等级/真实缺图占位未展示')
      const activate = button(root, '激活')
      ensure(activate && !activate.disabled, '单份藏品首次激活入口仍被禁用')
      ensure(text.includes('3,000,000'), '藏品分星级真实金币成本未展示')
      ensure(text.includes('取消展示') && text.includes('展示藏品'), '藏品展示/取消入口未展示')
      activate.click(); await flush()
      ensure(root.textContent.includes('消耗：') && root.textContent.includes('棉芽'), '真实激活确认框未展示材料')
      button(root, '取消')?.click(); await flush()
    }
    if (page.key === 'mutation') {
      button(root, '藏品变异')?.click(); await flush()
      ensure(root.textContent.includes('1.2%') && root.textContent.includes('保底 120 次'), '实际公开概率/独立保底未展示')
    }
    if (page.key === 'gifts') ensure(text.includes('模拟开放状态') && text.includes('当前不可领'), '红包未区分模拟可领/不可领')
    const measured = geometry()
    ensure(measured.documentWidth <= measured.viewport + 1 && measured.escaped.length === 0, page.label + '存在横向溢出：' + JSON.stringify(measured))
    rows.push({ page: page.key, ...measured })
  }
  state.scenario = 'conflict'
  await showPage('avatar')
  ensure(content().textContent.includes('状态存在冲突'), '旧后端全佩戴冲突没有显示异常')
  ensure(![...content().querySelectorAll('article span')].some(item => item.textContent.trim() === '佩戴中'), '冲突仍显示全部佩戴')
  ensure(!document.querySelector('.account-avatar-frame'), '冲突状态不能保留右上角旧框')
  state.scenario = 'unknown'
  await showPage('avatar')
  ensure(content().textContent.includes('上次结果未确认'), '头像框结果未知没有阻断提示')
  ensure(!document.querySelector('.account-avatar-frame'), '未知佩戴状态不能保留右上角旧框')
  ensure(![...content().querySelectorAll('button')].some(item => item.textContent.trim() === '换上' && !item.disabled), '未知头像框写操作仍可重提')
  await showPage('calendar')
  ensure(content().textContent.includes('仅刷新确认'), '节令未知结果仍标成可领')
  ensure([...content().querySelectorAll('button')].filter(item => item.textContent.trim() === '仅刷新确认').every(item => item.disabled || item.closest('li')), '未知节令没有状态保护')
  state.scenario = 'empty'
  await showPage('gifts')
  ensure(content().textContent.includes('不推断活动开放') && !button(content(), '领取'), '空红包状态被伪造可领取')
  await showPage('calendar')
  ensure(!content().textContent.includes('立冬'), '空日历不能从配置补造开放事件')
  state.scenario = 'error'
  await showPage('avatar')
  ensure(content().textContent.includes('模拟读取失败'), '读取错误被伪装成成功空列表')
  state.scenario = 'normal'; state.accountId = 'fixture-B'
  await showPage('collection')
  ensure(content().textContent.includes('Lv.106') && content().textContent.includes('还差'), '换模拟账号后等级被旧结果覆盖')
  ensure(!document.querySelector('.account-avatar-frame'), '换号后不能保留模拟A的头像框')
  ensure(![...content().querySelectorAll('button')].some(item => item.textContent.trim() === '激活' && !item.disabled), '未达125级仍可激活')
  ensure(audit.mockWrites === 0, '预览自检不应确认或自动提交任何写操作')
  ensure(audit.blockedAttempts === 0 && audit.errors.length === 0, '离线页面有真实传输尝试/渲染错误：' + JSON.stringify(audit.errors))
  state.scenario = initial.scenario; state.accountId = initial.accountId
  await showPage(initial.page)
  return { ok: true, viewport: innerWidth, realRequests: audit.realRequests, mockWrites: audit.mockWrites,
    blockedAttempts: audit.blockedAttempts, errors: [...audit.errors], components: rows,
    cases: ['佩戴中/未拥有/未知', '铭牌切换', 'V2时间窗/问答/季度', '未自动选择答案', 'type33礼包/精确UID/锁定确认', '首次激活/真实成本/展示', '概率与独立保底', '红包未知不推断', '空数据', '读取失败', '换号等级隔离'] }
}
const Shell = {
  setup() {
    onMounted(async () => {
      try {
        await useAccountStore().fetchAccounts()
        await showPage(state.page)
        if (query.get('check') === '1') {
          const report = await checks()
          window.__farmPreviewReport = report
          document.getElementById('preview-report').textContent = JSON.stringify(report)
          if (parent !== window) parent.postMessage({ farmPreviewReport: report }, '*')
        }
        if (query.get('tab') === 'nameplates') { button(content(), '铭牌')?.click(); await flush() }
        if (query.get('detail') === 'quiz') {
          const quiz = [...content().querySelectorAll('button')].find(item => item.textContent.trim() === '查看题目' && item.closest('li')?.textContent.includes('立冬'))
          quiz?.click(); await flush(); content().querySelector('[aria-label="节令问答"]')?.scrollIntoView()
        }
      } catch (cause) {
        const report = { ok: false, viewport: innerWidth, error: cause.message, errors: [...audit.errors], ...geometry() }
        document.getElementById('preview-report').textContent = JSON.stringify(report)
        if (parent !== window) parent.postMessage({ farmPreviewReport: report }, '*')
      }
    })
    watch(() => [state.page, state.scenario, state.accountId], async () => {
      await flush()
      if (state.page === 'bag') { button(content(), '全部')?.click(); await flush() }
      if (state.page === 'gifts') { button(content(), '查询状态')?.click(); await flush() }
    })
    return () => {
      const selected = pages.find(page => page.key === state.page) || pages[0]
      return h('div', { class: 'preview-shell' }, [
        h('header', { class: 'preview-heading' }, [h('div', [h('b', 'QQ 农场 · 游戏缺口移植'), h('p', '离线验收预览 / 真实 Vue 组件 / 本地配置与模拟进度')]), h('div', { class: 'preview-header-account' }, [h('span', { class: 'preview-badge' }, '仅本地 · 尚未上线'), h(TopAccountMenu)])]),
        h('div', { class: 'preview-warning' }, '全部账号、数量、奖励与可领状态均为模拟；确认按钮仅返回内存数据。0 个真实网络请求，不换装、不扣资源、不部署。'),
        h('div', { class: 'preview-layout' }, [
          h('aside', { class: 'preview-sidebar' }, [h('small', '本次移植'), ...pages.map(page => h('button', { class: state.page === page.key ? 'preview-nav active' : 'preview-nav', onClick: () => { state.page = page.key } }, page.label)), h('p', '头像框与藏品缺失的原图保留真实占位，不使用假素材。')]),
          h('main', { class: 'preview-main' }, [
            h('div', { class: 'preview-toolbar' }, [h('span', selected.route), h('div', { class: 'preview-controls' }, [
              h('select', { value: state.accountId, 'aria-label': '模拟账号', onChange: event => { state.accountId = event.target.value; state.epoch++ } }, [h('option', { value: 'fixture-A' }, '模拟账号 A · Lv125'), h('option', { value: 'fixture-B' }, '模拟账号 B · Lv106')]),
              h('select', { value: state.scenario, 'aria-label': '模拟状态', onChange: event => { state.scenario = event.target.value; state.epoch++ } }, [h('option', { value: 'normal' }, '正常模拟数据'), h('option', { value: 'unknown' }, '操作结果不确定'), h('option', { value: 'conflict' }, '旧回包全佩戴冲突'), h('option', { value: 'empty' }, '服务端空数据'), h('option', { value: 'error' }, '读取失败'), h('option', { value: 'offline' }, '账号未运行')])
            ])]),
            h('div', { id: 'actual-component', class: 'preview-stage' }, [h(selected.component, { key: state.page + ':' + state.scenario + ':' + state.epoch })]),
            h('footer', { class: 'preview-footnote' }, '以上为实际组件与生产样式，不是手写页面截图。游戏协议及当前可用性仍待单独授权验收。')
          ])
        ]),
        audit.toasts.length ? h('div', { class: 'preview-toasts' }, audit.toasts.map(item => h('p', item.message))) : null
      ])
    }
  }
}
createApp(Shell).use(createPinia()).mount('#app')
window.__farmPreview = { state, audit, showPage, checks }
`;
    const plugin = {
        name: 'offline-gameplay-fixtures',
        setup(build) {
            build.onResolve({ filter: /^farm:/ }, args => ({ path: args.path, namespace: 'farm-fixture' }));
            build.onResolve({ filter: /^@\// }, args => {
                if (['@/api', '@/stores/status', '@/stores/toast'].includes(args.path)) return { path: 'farm:mock', namespace: 'farm-fixture' };
                if (['@/components/AccountModal.vue', '@/components/AccountCareerModal.vue', '@/components/RemarkModal.vue'].includes(args.path)) return { path: 'farm:hidden-modal', namespace: 'farm-fixture' };
                let filename = path.join(web, 'src', args.path.slice(2));
                if (!path.extname(filename)) filename += '.ts';
                return { path: filename };
            });
            build.onResolve({ filter: /^vue-router$/ }, () => ({ path: 'farm:router', namespace: 'farm-fixture' }));
            build.onResolve({ filter: /^@vueuse\/core$/ }, () => ({ path: 'farm:vueuse', namespace: 'farm-fixture' }));
            build.onLoad({ filter: /.*/, namespace: 'farm-fixture' }, args => {
                if (args.path === 'farm:fixtures') return { contents: `export default ${fixtureJson}`, loader: 'js', resolveDir: web };
                if (args.path === 'farm:mock') return { contents: mockCode, loader: 'ts', resolveDir: web };
                if (args.path === 'farm:vueuse') return { contents: "import { computed, ref } from 'vue'; import { state } from 'farm:mock'; export const useIntervalFn = () => ({ pause() {}, resume() {} }); export const useStorage = (key, fallback) => key === 'current_account_id' ? computed({get: () => state.accountId, set: value => {state.accountId = value}}) : ref(fallback)", loader: 'js', resolveDir: web };
                if (args.path === 'farm:hidden-modal') return { contents: "import { defineComponent } from 'vue'; export default defineComponent({render: () => null})", loader: 'js', resolveDir: web };
                if (args.path === 'farm:router') return { contents: "import { defineComponent, h } from 'vue'; export const RouterLink = defineComponent({ props: ['to'], setup: (props, ctx) => () => h('a', { href: '#' }, ctx.slots.default?.()) })", loader: 'js', resolveDir: web };
                throw new Error(`未知离线模块 ${args.path}`);
            });
            build.onLoad({ filter: /\.vue$/ }, args => {
                const raw = fs.readFileSync(args.path, 'utf8');
                const hash = createHash('sha256').update(raw).digest('hex');
                sources.set(path.relative(path.join(__dirname, '../..'), args.path).replaceAll('\\', '/'), hash);
                const id = `data-v-${hash.slice(0, 8)}`;
                const descriptor = compiler.parse(raw, { filename: args.path }).descriptor;
                const script = compiler.compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component',
                    templateOptions: { compilerOptions: { scopeId: descriptor.styles.some(style => style.scoped) ? id : undefined } } });
                for (const style of descriptor.styles) {
                    const result = compiler.compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped });
                    assert.equal(result.errors.length, 0, `样式编译失败：${args.path}`);
                    styles.push(result.code);
                }
                return { contents: script.content + `\n__component.__scopeId = '${id}';\nexport default __component;`, loader: 'ts', resolveDir: path.dirname(args.path) };
            });
        },
    };
    const result = await esbuild.build({ stdin: { contents: entry, resolveDir: web, sourcefile: 'offline-gameplay-preview.ts', loader: 'ts' },
        absWorkingDir: web, nodePaths: [path.join(web, 'node_modules')], plugins: [plugin], bundle: true, write: false,
        platform: 'browser', format: 'iife', target: 'es2022', minify: true,
        alias: { vue: webRequire.resolve('vue/dist/vue.runtime.esm-bundler.js') },
        define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
    const buildDir = process.env.FARM_GAMEPLAY_BUILD_DIR || path.resolve(__dirname, '../../.workbuddy/frontend-20261111-gameplay-migration');
    const buildIndex = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
    const cssFiles = [...buildIndex.matchAll(/href="(?:\.\/|\/)?assets\/([^\"]+\.css)"/g)]
        .map(match => match[1]).filter(name => /^(vendor-|index-)/.test(name));
    assert.ok(cssFiles.some(name => name.startsWith('index-')), '必须使用现有生产样式');
    let css = cssFiles.map(name => fs.readFileSync(path.join(buildDir, 'assets', name), 'utf8')).join('\n');
    css = css.replace(/@import\s+(?:url\([^)]*\)|[^;]+);/g, '')
        .replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (whole, _quote, url) => url.startsWith('data:') ? whole : 'none');
    const previewCss = `
:root{color-scheme:light}*{box-sizing:border-box}html,body{margin:0;min-width:0;background:#f7f4eb;color:#2c2a22;font-family:"Segoe UI","Microsoft YaHei",sans-serif}button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default}.preview-shell{min-height:100vh}.preview-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:22px 30px;background:#fcfbf6;border-bottom:1px solid #ece5d6}.preview-heading b{font-size:21px}.preview-header-account{display:flex;align-items:center;gap:14px}.preview-heading p{margin:6px 0 0;font-size:12px;color:#746d5f}.preview-badge{border:1px solid #bfd1b6;border-radius:999px;padding:7px 12px;color:#486d43;background:#eff4e9;font-size:12px;white-space:nowrap}.preview-warning{padding:12px 30px;font-size:12px;line-height:1.6;color:#896520;background:#fff5dd;border-bottom:1px solid #ecdfc0}.preview-layout{display:grid;grid-template-columns:205px minmax(0,1fr);min-height:calc(100vh - 145px)}.preview-sidebar{padding:26px 18px;background:#fcfbf6;border-right:1px solid #ece5d6}.preview-sidebar small{display:block;color:#898272;margin:0 12px 16px}.preview-nav{display:block;width:100%;text-align:left;border:0;background:transparent;color:#5d594b;padding:12px 14px;margin:4px 0;border-radius:10px;font-size:14px}.preview-nav.active{background:#e8efdf;color:#476a3f;font-weight:650}.preview-sidebar p{font-size:11px;line-height:1.8;color:#8b8270;margin:32px 12px}.preview-main{min-width:0;padding:22px 28px}.preview-toolbar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;color:#7c7465;font-size:12px;margin-bottom:18px}.preview-controls{display:flex;flex-wrap:wrap;gap:8px}.preview-controls select{max-width:100%;padding:7px 10px;border-radius:8px;border:1px solid #e1d9c5;background:#fcfbf6;color:#615a4b}.preview-stage{min-width:0}.preview-footnote{padding:20px 0 0;font-size:11px;color:#8b8270;line-height:1.7}.preview-toasts{position:fixed;bottom:20px;right:20px;max-width:min(420px,calc(100vw - 40px));z-index:70}.preview-toasts p{padding:12px 16px;border:1px solid #bed0b5;border-radius:12px;background:#f4f8ef;box-shadow:0 8px 30px #50462c22;color:#476c3e;font-size:12px}
@media(max-width:900px){.preview-heading{padding:18px}.preview-warning{padding:10px 18px}.preview-layout{grid-template-columns:minmax(0,1fr)}.preview-sidebar{padding:8px 12px;display:flex;flex-wrap:wrap;gap:3px;border-right:0;border-bottom:1px solid #ece5d6}.preview-sidebar small,.preview-sidebar p{display:none}.preview-nav{width:auto;font-size:12px;padding:8px 10px;margin:0}.preview-main{padding:18px}.preview-toolbar{align-items:flex-start}.preview-heading b{font-size:17px}.preview-heading p{font-size:11px}.preview-badge{font-size:10px;padding:6px 9px}.preview-heading{flex-wrap:wrap}.preview-header-account{margin-left:auto}}

`;
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'gameplay-preview.html');
    const code = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>QQ 农场游戏缺口移植 · 离线模拟预览</title><style>${css}\n${styles.join('\n')}\n${previewCss}</style></head><body><div id="app"></div><pre id="preview-report" hidden></pre><script>function previewBootFailure(error){const report={ok:false,viewport:innerWidth,error:String(error?.message||error||'preview bootstrap failed')};document.getElementById('preview-report').textContent=JSON.stringify(report);if(parent!==window)parent.postMessage({farmPreviewReport:report},'*')}addEventListener('error',event=>previewBootFailure(event.error||event.message));addEventListener('unhandledrejection',event=>previewBootFailure(event.reason));</script><script>${code}</script></body></html>`;
    fs.writeFileSync(file, html, 'utf8');
    const proof = { preview: file, generatedAt: fixtures.generatedAt, network: 'strict-memory-mocks + CSP connect-src none',
        actualComponents: [...sources.entries()].map(([name, sha256]) => ({ path: name, sha256 })),
        productionStyles: cssFiles, fixtureImages: fixtures.images, sources: fixtures.sources };
    return { file, proof };
}

test('Edge 离线玩法预览：真实组件、模拟数据、精确视口与零游戏传输', {
    skip: !process.env.FARM_GAMEPLAY_PREVIEW_DIR,
}, async () => {
    const { execFileSync } = require('node:child_process');
    const { pathToFileURL } = require('node:url');
    const directory = path.resolve(process.env.FARM_GAMEPLAY_PREVIEW_DIR);
    assert.ok(fs.statSync(path.dirname(directory)).isDirectory(), '先确认预览父目录存在');
    const edge = process.env.FARM_EDGE_EXECUTABLE;
    assert.ok(edge && fs.existsSync(edge), '只能使用现有Edge，不下载浏览器');
    const { file, proof } = await buildOfflineGameplayPreview(directory);
    const results = [];
    for (const width of [375, 768, 1024, 1440]) {
        const wrapper = path.join(directory, `verify-${width}.html`);
        fs.writeFileSync(wrapper, `<!doctype html><html><head><meta charset="UTF-8"></head><body style="margin:0"><pre id="preview-report" hidden></pre><script>addEventListener('message',event=>{if(event.data?.farmPreviewReport)document.getElementById('preview-report').textContent=JSON.stringify(event.data.farmPreviewReport)});setTimeout(()=>{const report=document.getElementById('preview-report');if(!report.textContent){const frame=document.querySelector('iframe').contentWindow;report.textContent=JSON.stringify({ok:false,viewport:${width},error:'验收未结束',page:frame.__farmPreview?.state.page,step:frame.__farmPreview?.state.checkStep})}},4500)</script><iframe src="gameplay-preview.html?check=1" style="width:${width}px;height:1040px;border:0"></iframe></body></html>`, 'utf8');
        const dom = execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
            '--disable-sync', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--dump-dom',
            '--virtual-time-budget=5000', '--force-device-scale-factor=1', `--window-size=${Math.max(800, width)},1100`,
            `--user-data-dir=${path.join(directory, 'edge-check-profile')}`, pathToFileURL(wrapper).href],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const encoded = dom.match(/<pre id="preview-report" hidden[^>]*>([^<]+)<\/pre>/)?.[1];
        assert.ok(encoded, `Edge ${width}px没有返回真实组件验收结果；DOM末段：${dom.slice(-1200)}`);
        const report = JSON.parse(encoded.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"'));
        results.push(report);
        fs.writeFileSync(path.join(directory, 'edge-verification.json'), JSON.stringify({ ...proof, results }, null, 2) + '\n', 'utf8');
        assert.equal(report.viewport, width, 'iframe必须提供真实CSS视口，不能用Edge最小窗口冒充375px');
        assert.equal(report.ok, true, report.error || JSON.stringify(report));
        assert.equal(report.realRequests, 0);
        assert.equal(report.mockWrites, 0, '验收只打开确认框，不实际确认写入');
    }
    const screenshots = [];
    for (const page of ['avatar', 'nameplates', 'calendar', 'bag', 'collection', 'mutation', 'gifts']) {
        const screenshot = path.join(directory, `${page}-1440.png`);
        const query = page === 'nameplates' ? '?page=avatar&tab=nameplates' : `?page=${page}`;
        execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
            '--disable-sync', '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--hide-scrollbars',
            '--virtual-time-budget=1500', '--force-device-scale-factor=1', `--window-size=1440,${page === 'avatar' ? 1440 : 1040}`,
            `--user-data-dir=${path.join(directory, 'edge-screenshot-profile')}`, `--screenshot=${screenshot}`,
            pathToFileURL(file).href + query],
        { encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        assert.ok(fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10000, `${page}未获得真实Edge截图`);
        screenshots.push(screenshot);
    }
    fs.writeFileSync(path.join(directory, 'edge-verification.json'), JSON.stringify({ ...proof, results, screenshots }, null, 2) + '\n', 'utf8');
    console.log('GAMEPLAY_OFFLINE_PREVIEW', JSON.stringify({ file, viewports: results.map(item => item.viewport),
        realRequests: 0, confirmedMockWrites: 0, components: proof.actualComponents.length, screenshots }));
});
