'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { CONFIG } = require('../config/config');
const { requestError } = require('../utils/request-priority');
const {
    runAccountOperation,
    validateOperationSession,
    hasConfirmedGameGenerationAdvance,
    runSceneRequest,
    drainSceneRequests,
} = require('./account-operation-coordinator');
const { getFriendVisitSessionSnapshot, observeFriendVisitTransport, reconcileFriendVisitAtHome } = require('./friend-visit-session');
const { getRanchFriendSessionSnapshot } = require('./ranch-friend-session');
const { registerPersistentSceneGuard } = require('./account-operation-barrier');

const HOME_SCENE_ID = 1;
const RANCH_SCENE_ID = 2;
const VERSION = 1;

function sceneError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'scene_session',
        sent: details.sent ?? false,
        resultState: details.resultState || 'not_sent',
        ...details,
    });
}

function normalizeGeneration(value) {
    return value === undefined || value === null ? null : String(value);
}

function recordFile(accountId) {
    return getDataFile(path.join('scene-session',
        `${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24)}.json`));
}

function upgradeScope(session) {
    return {
        accountId: session.accountId,
        gid: session.gid,
        remoteGeneration: session.remoteGeneration,
    };
}

function upgradeRecordFile(scope) {
    const key = JSON.stringify([String(scope.accountId), Number(scope.gid), String(scope.remoteGeneration)]);
    return getDataFile(path.join('scene-global-login-upgrade',
        `${createHash('sha256').update(key).digest('hex')}.json`));
}

function assertPlainPath(file) {
    for (const candidate of [path.dirname(file), file]) {
        if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
            throw sceneError('场景状态路径不能是符号链接', 'SCENE_STATE_PATH_INVALID');
        }
    }
}

function validateRecord(record, accountId) {
    if (record == null) return null;
    if (record.version !== VERSION || String(record.accountId) !== String(accountId)
        || !['home', 'establishing_home', 'switching', 'active', 'restoring', 'unknown'].includes(record.phase)
        || !Number.isSafeInteger(record.gid) || record.gid <= 0
        || !Number.isSafeInteger(record.connectionEpoch) || record.connectionEpoch < 0
        || !Number.isFinite(record.updatedAt)) {
        throw sceneError('场景状态记录不完整，必须保守闭锁', 'SCENE_STATE_INVALID', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    return record;
}

function defaultLoad(accountId) {
    const file = recordFile(accountId);
    assertPlainPath(file);
    if (!fs.existsSync(file)) return null;
    return validateRecord(JSON.parse(fs.readFileSync(file, 'utf8')), accountId);
}

function defaultSave(accountId, record) {
    const file = recordFile(accountId);
    assertPlainPath(file);
    writeJsonFileAtomic(file, record);
}

function validateUpgradeRecord(record, scope) {
    if (record == null) return null;
    if (record.version !== VERSION || String(record.accountId) !== String(scope.accountId)
        || Number(record.gid) !== Number(scope.gid)
        || normalizeGeneration(record.remoteGeneration) !== normalizeGeneration(scope.remoteGeneration)
        || !['pending', 'player_login_confirmed', 'home_confirmed', 'succeeded', 'failed', 'unknown'].includes(record.phase)
        || !Number.isFinite(record.updatedAt)) {
        throw sceneError('全局登录升级记录无法确认，已保守闭锁', 'SCENE_UPGRADE_STATE_INVALID', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    return record;
}

function defaultLoadUpgrade(scope) {
    const file = upgradeRecordFile(scope);
    assertPlainPath(file);
    if (!fs.existsSync(file)) return null;
    try {
        return validateUpgradeRecord(JSON.parse(fs.readFileSync(file, 'utf8')), scope);
    } catch {
        throw sceneError('全局登录升级记录无法读取，已保守闭锁', 'SCENE_UPGRADE_STATE_INVALID', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
}

function defaultCreateUpgrade(scope, record) {
    const file = upgradeRecordFile(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertPlainPath(file);
    let fd;
    try {
        fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
        fs.fsyncSync(fd);
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw sceneError('该游戏代际已执行或尝试过全局登录升级', 'SCENE_UPGRADE_ALREADY_ATTEMPTED', {
                resultState: 'failed', outcomeUnknown: false,
            });
        }
        throw sceneError('全局登录升级记录无法持久化，未发送登录请求', 'SCENE_UPGRADE_PERSIST_FAILED', {
            sent: false, resultState: 'not_sent', outcomeUnknown: false,
        });
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function defaultSaveUpgrade(scope, record) {
    const file = upgradeRecordFile(scope);
    assertPlainPath(file);
    const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(record), 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function sessionMatches(record, session) {
    return !!record && String(record.accountId) === session.accountId && Number(record.gid) === session.gid
        && Number(record.connectionEpoch) === session.connectionEpoch
        && normalizeGeneration(record.remoteGeneration) === session.remoteGeneration;
}

function transition(session, phase, details = {}) {
    return {
        version: VERSION,
        accountId: session.accountId,
        gid: session.gid,
        connectionEpoch: session.connectionEpoch,
        remoteGeneration: session.remoteGeneration,
        remoteGenerationSource: session.remoteGenerationSource || 'unknown',
        phase,
        updatedAt: Date.now(),
        ...details,
    };
}

function isDefinitiveFailure(error) {
    return error?.sent === false || error?.resultState === 'not_sent'
        || (error?.resultState === 'failed' && error?.outcomeUnknown !== true
            && !/TIMEOUT|CANCEL|DEADLINE/i.test(String(error?.errorCode || error?.code || '')));
}

function createSceneSession(dependencies = {}) {
    const records = new Map();
    const upgradeRecords = new Map();
    const loadRecord = accountId => {
        const key = String(accountId);
        if (!records.has(key)) records.set(key, (dependencies.loadRecord || defaultLoad)(key));
        return records.get(key);
    };
    const saveRecord = (accountId, record) => {
        (dependencies.saveRecord || defaultSave)(accountId, record);
        records.set(String(accountId), record);
    };
    const upgradeScopeKey = scope => JSON.stringify([String(scope.accountId), Number(scope.gid), String(scope.remoteGeneration)]);
    const loadUpgradeRecord = scope => {
        const key = upgradeScopeKey(scope);
        if (upgradeRecords.has(key)) return upgradeRecords.get(key);
        const record = (dependencies.loadUpgradeRecord || defaultLoadUpgrade)(scope);
        const validated = validateUpgradeRecord(record, scope);
        if (validated) upgradeRecords.set(key, validated);
        return validated;
    };
    const saveUpgradeRecord = (scope, record, { exclusive = false } = {}) => {
        const key = upgradeScopeKey(scope);
        if (exclusive) upgradeRecords.set(key, record);
        if (exclusive && !dependencies.saveUpgradeRecord) defaultCreateUpgrade(scope, record);
        else if (dependencies.saveUpgradeRecord) dependencies.saveUpgradeRecord(scope, record, { exclusive });
        else defaultSaveUpgrade(scope, record);
        upgradeRecords.set(key, record);
    };
    const runOperation = dependencies.runOperation || runAccountOperation;
    const validateSession = dependencies.validateSession || validateOperationSession;
    const runRequest = dependencies.runRequest || runSceneRequest;
    const drainRequests = dependencies.drainRequests || drainSceneRequests;
    const getDiagnostic = dependencies.getDiagnostic || (() => network.getDiagnosticSnapshot?.() || {});
    const getUserState = dependencies.getUserState || (() => network.getUserState?.() || {});
    const sendScene = dependencies.sendScene || (async (session, sceneId, options = {}) => {
        const Request = types.PlayerSceneLoginRequest;
        const Reply = types.PlayerSceneLoginReply;
        if (!Request || !Reply) throw sceneError('场景协议未加载', 'SCENE_PROTO_UNAVAILABLE');
        const body = Request.encode(Request.fromObject({ global_scene_id: sceneId })).finish();
        const response = await runRequest(session, 'gamepb.globalscenepb.GlobalSceneService',
            'PlayerSceneLogin', body, { timeoutMs: 30000, cleanup: options.ignoreCancellation === true });
        const reply = Reply.decode(response.body);
        if (Number(reply.global_scene_id) !== sceneId) {
            throw sceneError('场景登录回包与目标不一致', 'SCENE_RESPONSE_MISMATCH', {
                sent: true, resultState: 'unknown', outcomeUnknown: true,
            });
        }
        return reply;
    });
    // Diagnostic only: do not take a scene-sensitive lease, which would allow
    // requests past a persisted unknown-scene guard.
    async function getSceneAccessInfo() {
        return runOperation('scene-access-info', async (session) => {
            const Request = types.GetPlayerSceneInfoRequest;
            const Reply = types.GetPlayerSceneInfoReply;
            if (!Request || !Reply) throw sceneError('场景查询协议未加载', 'SCENE_PROTO_UNAVAILABLE');
            const response = await runRequest(session, 'gamepb.globalscenepb.GlobalSceneService',
                'GetPlayerSceneInfo', Request.encode(Request.create()).finish(), { timeoutMs: 10000 });
            const reply = Reply.decode(response.body);
            if (!Object.hasOwn(reply, 'active_global_scene_id') || ![0, HOME_SCENE_ID, RANCH_SCENE_ID].includes(reply.active_global_scene_id)) {
                throw sceneError('服务端未确认当前场景', 'SCENE_ACCESS_INFO_UNCONFIRMED');
            }
            return {
                activeSceneId: reply.active_global_scene_id,
                defaultSceneId: Object.hasOwn(reply, 'default_global_scene_id') ? reply.default_global_scene_id : null,
                unlockedSceneIds: [...reply.unlocked_scenes],
                ranchAccessConfirmed: reply.unlocked_scenes.includes(RANCH_SCENE_ID),
                lastAttempt: getSnapshot(session.accountId),
            };
        }, { priority: 'foreground', timeoutMs: 12000 });
    }

    const friendState = dependencies.friendState || (accountId => getFriendVisitSessionSnapshot(accountId));
    const observeFriendTransport = dependencies.observeFriendTransport
        || (dependencies.friendState ? () => {} : observeFriendVisitTransport);
    const reconcileFriendHome = dependencies.reconcileFriendHome
        || (dependencies.friendState ? null : reconcileFriendVisitAtHome);
    const readSceneAccess = dependencies.getSceneAccessInfo || getSceneAccessInfo;
    const ranchFriendState = dependencies.ranchFriendState || (accountId => getRanchFriendSessionSnapshot(accountId));

    function currentFriendState(session) {
        const diagnostic = getDiagnostic() || {};
        const generation = normalizeGeneration(diagnostic.remoteGeneration);
        const epoch = generation != null && /^\d+$/.test(generation) ? Number(generation) : null;
        // 只有实际业务租约才观测；被动诊断继续只读。IPC/进程计数不能成为复位证据。
        if (diagnostic.connected === true && diagnostic.loggedIn === true
            && diagnostic.detached !== true && diagnostic.quiescing !== true
            && String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || '') === session.accountId
            && Number(getUserState()?.gid) === session.gid && session.gid > 0
            && diagnostic.remoteGenerationSource === 'gateway' && session.remoteGenerationSource === 'gateway'
            && generation === session.remoteGeneration && Number.isSafeInteger(epoch) && epoch >= 0) {
            validateSession(session);
            observeFriendTransport(session.accountId, epoch);
        }
        return friendState(session.accountId);
    }

    function validateUpgradeScope(expected, session) {
        const expectedGeneration = normalizeGeneration(expected?.remoteGeneration);
        const diagnostic = getDiagnostic() || {};
        const liveAccountId = String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || '');
        const liveGid = Number(getUserState()?.gid) || 0;
        if (!expected || Number(expected.actorId) !== 2 || String(expected.accountId ?? '') !== '2'
            || session.accountId !== '2' || liveAccountId !== session.accountId
            || Number(expected.gid) !== session.gid || liveGid !== session.gid
            || Number(expected.connectionEpoch) !== session.connectionEpoch
            || Number(diagnostic.connectionEpoch) !== session.connectionEpoch
            || expected.remoteGenerationSource !== 'gateway'
            || expectedGeneration !== session.remoteGeneration
            || normalizeGeneration(diagnostic.remoteGeneration) !== session.remoteGeneration
            || diagnostic.remoteGenerationSource !== 'gateway'
            || session.remoteGenerationSource !== 'gateway'
            || !/^\d+$/.test(String(session.remoteGeneration || ''))) {
            throw sceneError('升级目标或当前游戏连接身份不匹配', 'SCENE_UPGRADE_SCOPE_MISMATCH', {
                sent: false, resultState: 'not_sent', outcomeUnknown: false,
            });
        }
        if (!Number.isSafeInteger(session.gid) || session.gid <= 0
            || !Number.isSafeInteger(session.connectionEpoch) || session.connectionEpoch < 0) {
            throw sceneError('升级目标或当前游戏连接身份无效', 'SCENE_UPGRADE_SCOPE_MISMATCH', {
                sent: false, resultState: 'not_sent', outcomeUnknown: false,
            });
        }
    }

    async function querySceneInfo(session, { cleanup = false } = {}) {
        const Request = types.GetPlayerSceneInfoRequest;
        const Reply = types.GetPlayerSceneInfoReply;
        if (!Request || !Reply) throw sceneError('场景查询协议未加载', 'SCENE_PROTO_UNAVAILABLE');
        validateSession(session, { ignoreCancellation: cleanup });
        const response = await runRequest(session, 'gamepb.globalscenepb.GlobalSceneService',
            'GetPlayerSceneInfo', Request.encode(Request.create()).finish(), { timeoutMs: 10000, cleanup });
        validateSession(session, { ignoreCancellation: true });
        const reply = Reply.decode(response.body);
        if (!Object.hasOwn(reply, 'active_global_scene_id')
            || ![0, HOME_SCENE_ID, RANCH_SCENE_ID].includes(reply.active_global_scene_id)
            || !Array.isArray(reply.unlocked_scenes)
            || reply.unlocked_scenes.some(sceneId => !Number.isSafeInteger(sceneId) || sceneId < 0)) {
            throw sceneError('服务端未确认当前场景', 'SCENE_ACCESS_INFO_UNCONFIRMED');
        }
        return {
            activeSceneId: reply.active_global_scene_id,
            defaultSceneId: Object.hasOwn(reply, 'default_global_scene_id') ? reply.default_global_scene_id : null,
            unlockedSceneIds: [...reply.unlocked_scenes],
            ranchAccessConfirmed: reply.unlocked_scenes.includes(RANCH_SCENE_ID),
        };
    }

    async function upgradeGlobalLogin(expected) {
        const loginProtocol = dependencies.loginProtocol || require('./player-login-protocol');
        return runOperation('global-login-upgrade', async (session) => {
            validateUpgradeScope(expected, session);
            validateSession(session);

            const record = validateRecord(loadRecord(session.accountId), session.accountId);
            if (record && record.phase !== 'home') {
                throw sceneError('已有场景恢复状态未确认，拒绝升级且不改动记录', 'SCENE_STATE_UNKNOWN', {
                    sent: false, resultState: 'unknown', outcomeUnknown: false,
                    holdUntilTransportEpochChanged: true,
                });
            }
            const visit = friendState(session.accountId);
            if (visit?.resultState !== 'idle') {
                throw sceneError('好友访问状态非空闲，拒绝升级', 'SCENE_FRIEND_VISIT_BUSY', {
                    sent: false, resultState: visit?.resultState === 'unknown' ? 'unknown' : 'not_sent',
                    outcomeUnknown: false,
                });
            }
            const ranchVisit = ranchFriendState(session.accountId);
            if (ranchVisit?.resultState !== 'idle') {
                throw sceneError('好友牧场访问状态非空闲，拒绝升级', 'SCENE_RANCH_FRIEND_BUSY', {
                    sent: false, resultState: ranchVisit?.resultState === 'unknown' ? 'unknown' : 'not_sent',
                    outcomeUnknown: false,
                });
            }

            const scope = upgradeScope(session);
            if (loadUpgradeRecord(scope)) {
                throw sceneError('该游戏代际已执行或尝试过全局登录升级', 'SCENE_UPGRADE_ALREADY_ATTEMPTED', {
                    sent: false, resultState: 'failed', outcomeUnknown: false,
                });
            }

            const before = await querySceneInfo(session);
            validateUpgradeScope(expected, session);
            validateSession(session, { ignoreCancellation: true });
            if (before.activeSceneId !== HOME_SCENE_ID) {
                throw sceneError('当前场景不是HOME，拒绝升级且未发送登录请求', 'SCENE_UPGRADE_NOT_HOME', {
                    sent: false, resultState: 'not_sent', outcomeUnknown: false,
                });
            }
            if (before.ranchAccessConfirmed) {
                return {
                    actorId: 2,
                    accountId: session.accountId,
                    gid: session.gid,
                    profile: 'player',
                    playerLoginSent: false,
                    activeSceneId: before.activeSceneId,
                    defaultSceneId: before.defaultSceneId,
                    unlockedSceneIds: before.unlockedSceneIds,
                    ranchAccessConfirmed: true,
                    homeConfirmed: true,
                    noop: true,
                };
            }

            const request = loginProtocol.buildRequest(types, {
                client_version: String(CONFIG.clientVersion || ''),
                sys_software: String(CONFIG.os || ''),
            }, 'player', {
                sharer_id: 0,
                sharer_open_id: '',
                share_cfg_id: 0,
                scene_id: '1256',
                game_scene_id: HOME_SCENE_ID,
            });
            const pending = {
                version: VERSION,
                ...scope,
                phase: 'pending',
                updatedAt: Date.now(),
            };
            try {
                saveUpgradeRecord(scope, pending, { exclusive: true });
            } catch (error) {
                if (error?.errorCode === 'SCENE_UPGRADE_ALREADY_ATTEMPTED') throw error;
                throw sceneError('全局登录升级记录无法持久化，未发送登录请求', 'SCENE_UPGRADE_PERSIST_FAILED', {
                    sent: false, resultState: 'not_sent', outcomeUnknown: false,
                });
            }

            let sceneGuardWritten = false;
            let playerLoginMarkedSent = false;
            let playerLoginMayHaveBeenSent = false;
            let playerLoginResponseReceived = false;
            let playerLoginConfirmed = false;
            try {
                saveRecord(session.accountId, transition(session, 'establishing_home', {
                    sceneId: null,
                    targetSceneId: HOME_SCENE_ID,
                    proof: null,
                    upgradeAttempt: true,
                }));
                sceneGuardWritten = true;
                validateUpgradeScope(expected, session);
                validateSession(session);

                playerLoginMayHaveBeenSent = true;
                const response = await runRequest(session, request.service, request.method, request.body, {
                    timeoutMs: 30000,
                });
                playerLoginResponseReceived = true;
                validateUpgradeScope(expected, session);
                validateSession(session, { ignoreCancellation: true });
                const loginResult = loginProtocol.validateLoginReply('player', request.replyDecoder(response.body));
                if (loginResult.gid !== session.gid) {
                    throw sceneError('PlayerLogin回包身份与当前连接不一致', 'SCENE_UPGRADE_REPLY_IDENTITY_MISMATCH', {
                        sent: true, resultState: 'unknown', outcomeUnknown: true,
                    });
                }
                playerLoginConfirmed = true;
                saveUpgradeRecord(scope, { ...pending, phase: 'player_login_confirmed', updatedAt: Date.now() });

                const homeReply = await sendScene(session, HOME_SCENE_ID, { ignoreCancellation: true });
                validateUpgradeScope(expected, session);
                validateSession(session, { ignoreCancellation: true });
                loginProtocol.confirmHomeScene(loginResult, homeReply);
                saveRecord(session.accountId, transition(session, 'home', {
                    sceneId: HOME_SCENE_ID,
                    proof: 'player_login_home_scene_confirmed',
                }));

                const after = await querySceneInfo(session, { cleanup: session.sceneClosing === true });
                validateUpgradeScope(expected, session);
                validateSession(session, { ignoreCancellation: true });
                if (after.activeSceneId !== HOME_SCENE_ID) {
                    throw sceneError('PlayerLogin后HOME场景状态未确认', 'SCENE_UPGRADE_HOME_NOT_CONFIRMED', {
                        sent: true, resultState: 'unknown', outcomeUnknown: true,
                    });
                }
                try {
                    saveUpgradeRecord(scope, { ...pending, phase: 'succeeded', updatedAt: Date.now() });
                } catch {
                    // Initial fsync'd pending record remains a one-time durable lock.
                }
                return {
                    actorId: 2,
                    accountId: session.accountId,
                    gid: session.gid,
                    profile: loginResult.actualProfile,
                    playerLoginSent: true,
                    activeSceneId: after.activeSceneId,
                    defaultSceneId: after.defaultSceneId,
                    unlockedSceneIds: after.unlockedSceneIds,
                    ranchAccessConfirmed: after.ranchAccessConfirmed,
                    homeConfirmed: true,
                    noop: false,
                };
            } catch (error) {
                const definitelyNotSent = error?.sent === false || error?.resultState === 'not_sent';
                if (playerLoginMayHaveBeenSent && !playerLoginMarkedSent
                    && !playerLoginResponseReceived && definitelyNotSent) {
                    playerLoginMayHaveBeenSent = false;
                }
                if (playerLoginMayHaveBeenSent || playerLoginResponseReceived || playerLoginConfirmed) {
                    const code = String(error?.errorCode || error?.code || 'SCENE_UPGRADE_RESULT_UNKNOWN')
                        .replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 80) || 'SCENE_UPGRADE_RESULT_UNKNOWN';
                    try {
                        saveRecord(session.accountId, transition(session, 'unknown', {
                            sceneId: null,
                            targetSceneId: HOME_SCENE_ID,
                            proof: null,
                            errorCode: code,
                        }));
                    } catch { /* The establishing guard remains non-home and continues to block farm RPCs. */ }
                    try {
                        saveUpgradeRecord(scope, { ...pending, phase: 'unknown', updatedAt: Date.now(), errorCode: code });
                    } catch { /* Durable pending state still blocks a repeated PlayerLogin. */ }
                    throw sceneError('全局登录升级结果未确认，已闭锁后续农场业务', 'SCENE_UPGRADE_RESULT_UNKNOWN', {
                        sent: true, resultState: 'unknown', outcomeUnknown: true,
                        holdUntilTransportEpochChanged: true,
                    });
                }
                if (sceneGuardWritten) {
                    try {
                        if (record) saveRecord(session.accountId, record);
                        else saveRecord(session.accountId, transition(session, 'home', {
                            sceneId: HOME_SCENE_ID, proof: 'pre_upgrade_home_record',
                        }));
                    } catch { /* No login packet was sent; persistent upgrade attempt still prevents replay. */ }
                }
                try {
                    saveUpgradeRecord(scope, { ...pending, phase: 'failed', updatedAt: Date.now() });
                } catch { /* Durable pending state still blocks a repeated PlayerLogin. */ }
                throw sceneError('全局登录升级未发送或未完成', 'SCENE_UPGRADE_NOT_SENT', {
                    sent: false, resultState: 'not_sent', outcomeUnknown: false,
                });
            }
        }, { priority: 'foreground', timeoutMs: 90000, sceneSensitive: true });
    }

    async function confirmedSceneLogin(session, sceneId, phase, previous, options = {}) {
        saveRecord(session.accountId, transition(session, phase, {
            sceneId: previous?.sceneId ?? null,
            targetSceneId: sceneId,
            proof: previous?.proof || null,
        }));
        try {
            const reply = await sendScene(session, sceneId, options);
            validateSession(session, { ignoreCancellation: options.ignoreCancellation === true });
            return reply;
        }
        catch (error) {
            if (isDefinitiveFailure(error) && previous?.phase === 'home') {
                // Keep the original proof and transport identity: a definitive
                // rejection does not establish HOME for the current session.
                saveRecord(session.accountId, {
                    ...previous,
                    updatedAt: Date.now(),
                    lastErrorCode: String(error.errorCode || error.code || ''),
                    lastFailedTargetSceneId: sceneId,
                    lastFailedPhase: phase,
                    lastFailureDefinitive: true,
                });
                throw error;
            }
            const unknown = transition(session, 'unknown', {
                sceneId: previous?.sceneId ?? null,
                targetSceneId: sceneId,
                lastFailedTargetSceneId: sceneId,
                lastFailedPhase: phase,
                lastFailureDefinitive: isDefinitiveFailure(error),
                proof: null,
                errorCode: String(error.errorCode || error.code || 'SCENE_RESULT_UNKNOWN').slice(0, 80),
                errorMessage: String(error.message || '场景结果未确认').slice(0, 300),
            });
            saveRecord(session.accountId, unknown);
            throw sceneError('场景切换结果未确认，已停止后续业务；请勿重复刷新', 'SCENE_RESULT_UNKNOWN', {
                sent: error.sent !== false,
                resultState: 'unknown', outcomeUnknown: true,
                holdUntilTransportEpochChanged: true,
                cause: error,
            });
        }
    }

    async function withScene(targetSceneId, work, options = {}) {
        if (targetSceneId !== RANCH_SCENE_ID) {
            throw sceneError('仅允许通过牧场租约进入scene2', 'SCENE_TARGET_NOT_ALLOWED');
        }
        return runOperation('ranch-scene', async (session) => {
            let visit = currentFriendState(session);
            if (visit?.resultState === 'unknown' && reconcileFriendHome) {
                // 查询是只读的：若服务端以当前同一账号/GID/网关代际明确报告HOME，
                // 这比历史未确认的Leave更直接；只据此结算旧保护，不重发Leave。
                const access = await readSceneAccess();
                validateSession(session);
                if (access.activeSceneId === HOME_SCENE_ID) {
                    const diagnostic = getDiagnostic() || {};
                    reconcileFriendHome(session.accountId, {
                        accountId: session.accountId,
                        gid: session.gid,
                        currentGid: Number(getUserState()?.gid) || 0,
                        activeSceneId: access.activeSceneId,
                        diagnostic,
                    });
                    visit = friendState(session.accountId);
                }
            }
            if (visit?.resultState && visit.resultState !== 'idle') {
                throw sceneError('好友访问尚未确认结束，暂不能切换牧场场景', 'SCENE_FRIEND_VISIT_BUSY', {
                    resultState: visit.resultState === 'unknown' ? 'unknown' : 'not_sent',
                    holdUntilTransportEpochChanged: visit.holdUntilTransportEpochChanged === true,
                });
            }
            const ranchVisit = ranchFriendState(session.accountId);
            if (ranchVisit?.resultState && ranchVisit.resultState !== 'idle') {
                throw sceneError('好友牧场访问尚未确认离场，暂不能再次进入牧场场景', 'SCENE_RANCH_FRIEND_BUSY', {
                    resultState: 'unknown', outcomeUnknown: false,
                    holdUntilTransportEpochChanged: ranchVisit.holdUntilTransportEpochChanged === true,
                    hostGid: ranchVisit.hostGid,
                });
            }

            let record = validateRecord(loadRecord(session.accountId), session.accountId);
            if (record && record.phase !== 'home') {
                if (!hasConfirmedGameGenerationAdvance(record, session)) {
                    throw sceneError('上次场景操作未确认恢复；IPC重连不能解除未知锁', 'SCENE_STATE_UNKNOWN', {
                        resultState: 'unknown', outcomeUnknown: false,
                        holdUntilTransportEpochChanged: true,
                    });
                }
                // 只在真实游戏代际严格推进后重新建立home；不改写任何操作账本。
                record = null;
            }

            if (!record || !sessionMatches(record, session)) {
                await confirmedSceneLogin(session, HOME_SCENE_ID, 'establishing_home', record, {});
                record = transition(session, 'home', { sceneId: HOME_SCENE_ID, proof: 'home_scene_confirmed' });
                saveRecord(session.accountId, record);
            }

            const sceneReply = await confirmedSceneLogin(session, targetSceneId, 'switching', record, {});
            record = transition(session, 'active', { sceneId: targetSceneId, proof: 'target_scene_confirmed' });
            saveRecord(session.accountId, record);

            let value;
            let workError = null;
            try {
                value = await work({ session, sceneReply });
                validateSession(session, { ignoreCancellation: true });
            }
            catch (error) {
                workError = error;
            }

            try {
                const remainingVisit = ranchFriendState(session.accountId);
                if (remainingVisit?.recoveryRequired === true) {
                    throw sceneError('好友牧场未确认离场，不能发送恢复scene1请求', 'SCENE_RANCH_FRIEND_BUSY', {
                        resultState: 'unknown', outcomeUnknown: false,
                    });
                }
                await drainRequests(session);
            }
            catch (unsettledError) {
                saveRecord(session.accountId, transition(session, 'unknown', {
                    sceneId: RANCH_SCENE_ID, proof: null,
                    errorCode: 'SCENE_REQUEST_UNSETTLED',
                    errorMessage: String(unsettledError?.message || '场景请求未结算').slice(0, 300),
                }));
                throw sceneError('场景业务未结算，保留未知锁且未发送恢复请求', 'SCENE_REQUEST_UNSETTLED', {
                    sent: false, resultState: 'unknown', outcomeUnknown: false,
                    holdUntilTransportEpochChanged: true, cause: unsettledError,
                    workError: workError?.message,
                });
            }

            try {
                await confirmedSceneLogin(session, HOME_SCENE_ID, 'restoring', record, { ignoreCancellation: true });
                saveRecord(session.accountId, transition(session, 'home', {
                    sceneId: HOME_SCENE_ID,
                    proof: 'scene_restore_confirmed',
                }));
            }
            catch (restoreError) {
                throw sceneError('牧场场景操作结束但农场场景恢复未确认，已封闭后续业务', 'SCENE_RESTORE_UNKNOWN', {
                    sent: restoreError.sent !== false,
                    resultState: 'unknown', outcomeUnknown: true,
                    holdUntilTransportEpochChanged: true,
                    cause: restoreError,
                    workError: workError?.message,
                });
            }

            if (workError) throw workError;
            return value;
        }, { ...options, priority: options.priority || 'foreground', sceneSensitive: true, timeoutMs: options.timeoutMs || 90000 });
    }

    function getSnapshot(accountId = process.env.FARM_ACCOUNT_ID || '') {
        const record = validateRecord(loadRecord(String(accountId)), String(accountId));
        if (!record) return { phase: 'uninitialized', sceneId: null, recoveryRequired: false };
        const diagnostic = getDiagnostic();
        const advanced = diagnostic.connected === true && diagnostic.loggedIn === true
            && hasConfirmedGameGenerationAdvance(record, {
                accountId: String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || ''),
                gid: Number(getUserState().gid) || 0,
                remoteGeneration: normalizeGeneration(diagnostic.remoteGeneration),
                remoteGenerationSource: diagnostic.remoteGenerationSource || 'unknown',
            });
        return {
            phase: advanced && record.phase !== 'home' ? 'uninitialized' : record.phase,
            sceneId: record.sceneId ?? null,
            targetSceneId: record.targetSceneId ?? null,
            lastFailedTargetSceneId: record.lastFailedTargetSceneId ?? null,
            lastFailedPhase: record.lastFailedPhase || '',
            lastFailureDefinitive: record.lastFailureDefinitive === true,
            connectionEpoch: record.connectionEpoch,
            remoteGeneration: record.remoteGeneration,
            updatedAt: record.updatedAt,
            recoveryRequired: record.phase !== 'home' && !advanced,
            errorCode: record.errorCode || '',
        };
    }

    return { withScene, getSnapshot, getSceneAccessInfo, upgradeGlobalLogin };
}

const sceneSession = createSceneSession();
registerPersistentSceneGuard('scene-session', accountId => sceneSession.getSnapshot(accountId));

module.exports = {
    HOME_SCENE_ID,
    RANCH_SCENE_ID,
    createSceneSession,
    getSceneAccessInfo: sceneSession.getSceneAccessInfo,
    upgradeGlobalLogin: sceneSession.upgradeGlobalLogin,
    withGameScene: sceneSession.withScene,
    getSceneSessionSnapshot: sceneSession.getSnapshot,
};
