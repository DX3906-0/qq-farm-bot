'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { requestError } = require('../utils/request-priority');
const {
    validateOperationSession, hasConfirmedGameGenerationAdvance, runSceneRequest, drainSceneRequests,
} = require('./account-operation-coordinator');
const { registerPersistentSceneGuard } = require('./account-operation-barrier');

const VERSION = 1;
const PHASES = new Set(['idle', 'entering', 'active', 'leaving', 'unknown']);

function sessionError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'ranch_friend_session',
        sent: details.sent ?? false,
        resultState: details.resultState || 'not_sent',
        ...details,
    });
}

function normalizeGeneration(value) {
    return value === undefined || value === null ? null : String(value);
}

function recordFile(accountId) {
    return getDataFile(path.join('ranch-friend-session',
        `${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24)}.json`));
}

function assertPlainPath(file) {
    for (const candidate of [path.dirname(file), file]) {
        if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
            throw sessionError('好友牧场会话路径不能是符号链接', 'RANCH_FRIEND_SESSION_PATH_INVALID');
        }
    }
}

function validateRecord(record, accountId) {
    if (record == null) return null;
    if (record.version !== VERSION || String(record.accountId) !== String(accountId)
        || !PHASES.has(record.phase) || !Number.isSafeInteger(record.ownerGid) || record.ownerGid <= 0
        || !Number.isSafeInteger(record.connectionEpoch) || record.connectionEpoch < 0
        || !Number.isFinite(record.updatedAt)
        || (record.phase !== 'idle' && (!Number.isSafeInteger(record.hostGid) || record.hostGid <= 0))) {
        throw sessionError('好友牧场会话记录不完整，必须保守闭锁', 'RANCH_FRIEND_SESSION_INVALID', {
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

function sameSession(record, session) {
    return !!record && String(record.accountId) === session.accountId
        && Number(record.ownerGid) === session.gid
        && Number(record.connectionEpoch) === session.connectionEpoch
        && normalizeGeneration(record.remoteGeneration) === session.remoteGeneration;
}

function transition(session, phase, details = {}) {
    return {
        version: VERSION,
        accountId: session.accountId,
        ownerGid: session.gid,
        connectionEpoch: session.connectionEpoch,
        remoteGeneration: session.remoteGeneration,
        remoteGenerationSource: session.remoteGenerationSource || 'unknown',
        hostGid: Number(details.hostGid) || 0,
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

function createRanchFriendSession(dependencies = {}) {
    const records = new Map();
    const loadRecord = accountId => {
        const key = String(accountId);
        if (!records.has(key)) records.set(key, (dependencies.loadRecord || defaultLoad)(key));
        return records.get(key);
    };
    const saveRecord = (accountId, record) => {
        (dependencies.saveRecord || defaultSave)(accountId, record);
        records.set(String(accountId), record);
    };
    const protocolTypes = dependencies.types || types;
    const validateSession = dependencies.validateSession || validateOperationSession;
    const runRequest = dependencies.runRequest || runSceneRequest;
    const drainRequests = dependencies.drainRequests || drainSceneRequests;
    const getDiagnostic = dependencies.getDiagnostic || (() => network.getDiagnosticSnapshot?.() || {});
    const getUserState = dependencies.getUserState || (() => network.getUserState?.() || {});

    async function enter(session, hostGid, onAccepted) {
        const Request = protocolTypes.RanchEnterHomesteadRequest;
        const Reply = protocolTypes.RanchEnterHomesteadReply;
        if (!Request || !Reply) throw sessionError('好友牧场访问协议未加载', 'RANCH_FRIEND_PROTO_UNAVAILABLE');
        validateSession(session);
        const body = Request.encode(Request.fromObject({ host_gid: hostGid, reason: 2 })).finish();
        const response = await runRequest(session, 'gamepb.visitpb.VisitService', 'EnterHomestead', body, { timeoutMs: 30000 });
        onAccepted?.();
        validateSession(session, { ignoreCancellation: true });
        if (!response?.body?.length) {
            throw sessionError('好友牧场进入响应为空', 'RANCH_FRIEND_ENTER_EMPTY', {
                sent: true, resultState: 'unknown', outcomeUnknown: true,
            });
        }
        return Reply.decode(response.body);
    }

    async function leave(session, hostGid) {
        const Request = protocolTypes.RanchLeaveHomesteadRequest;
        const Reply = protocolTypes.RanchLeaveHomesteadReply;
        if (!Request || !Reply) throw sessionError('好友牧场离场协议未加载', 'RANCH_FRIEND_PROTO_UNAVAILABLE');
        const body = Request.encode(Request.fromObject({ host_gid: hostGid })).finish();
        const response = await runRequest(session, 'gamepb.visitpb.VisitService', 'LeaveHomestead', body, {
            timeoutMs: 30000, cleanup: true,
        });
        validateSession(session, { ignoreCancellation: true });
        if (response?.body == null) {
            throw sessionError('好友牧场离场响应缺失', 'RANCH_FRIEND_LEAVE_EMPTY', {
                sent: true, resultState: 'unknown', outcomeUnknown: true,
            });
        }
        Reply.decode(response.body);
    }

    async function withFriend(session, hostGid, work) {
        const target = Number(hostGid);
        if (!Number.isSafeInteger(target) || target <= 0 || target === session.gid || typeof work !== 'function') {
            throw sessionError('好友牧场目标无效', 'RANCH_FRIEND_INVALID_ARGUMENT');
        }
        validateSession(session);
        const wasClosing = session.sceneClosing === true;
        let record = validateRecord(loadRecord(session.accountId), session.accountId);
        if (record && record.phase !== 'idle') {
            if (!hasConfirmedGameGenerationAdvance(record, session)) {
                throw sessionError('上次好友牧场访问未确认离场；IPC重连不能解除未知锁', 'RANCH_FRIEND_SESSION_UNKNOWN', {
                    resultState: 'unknown', outcomeUnknown: false,
                    holdUntilTransportEpochChanged: true,
                    hostGid: record.hostGid,
                });
            }
            record = null;
        }
        else if (record && !sameSession(record, session)) record = null;

        saveRecord(session.accountId, transition(session, 'entering', {
            hostGid: target,
            proof: record?.proof || null,
        }));

        let entry;
        let entered = false;
        let workError = null;
        try {
            entry = await enter(session, target, () => { entered = true; });
        }
        catch (error) {
            if (!entered) {
                if (isDefinitiveFailure(error)) {
                    saveRecord(session.accountId, transition(session, 'idle', {
                        hostGid: 0,
                        proof: 'enter_rejected',
                        lastHostGid: target,
                        lastErrorCode: String(error?.errorCode || error?.code || '').slice(0, 80),
                    }));
                }
                else {
                    saveRecord(session.accountId, transition(session, 'unknown', {
                        hostGid: target,
                        proof: null,
                        errorCode: String(error?.errorCode || error?.code || 'RANCH_FRIEND_ENTER_UNKNOWN').slice(0, 80),
                        errorMessage: String(error?.message || '进入结果未确认').slice(0, 300),
                    }));
                    error.holdUntilTransportEpochChanged = true;
                    error.outcomeUnknown = true;
                }
                throw error;
            }
            workError = error?.resultState ? error : sessionError('好友牧场进入响应无法解析', 'RANCH_FRIEND_RESPONSE_DECODE_FAILED', {
                sent: true, resultState: 'failed', outcomeUnknown: false, cause: error,
            });
        }

        if (!workError) {
            const returnedGid = Number(entry?.basic?.gid);
            if (returnedGid !== target || !entry?.homestead_cells) {
                workError = sessionError('好友牧场进入回包与目标不匹配', 'RANCH_FRIEND_RESPONSE_MISMATCH', {
                    sent: true, resultState: 'unknown', outcomeUnknown: true,
                });
            }
        }

        saveRecord(session.accountId, transition(session, 'active', {
            hostGid: target,
            proof: 'enter_homestead_accepted',
            responseValidated: !workError,
        }));

        let value;
        if (!workError) {
            try {
                value = await work({ session, entry, hostGid: target });
                validateSession(session, { ignoreCancellation: true });
            }
            catch (error) {
                workError = error;
            }
        }

        saveRecord(session.accountId, transition(session, 'leaving', {
            hostGid: target,
            proof: 'enter_homestead_confirmed',
            workResultState: workError?.resultState || null,
        }));
        try {
            await drainRequests(session);
            await leave(session, target);
            saveRecord(session.accountId, transition(session, 'idle', {
                hostGid: 0,
                lastHostGid: target,
                proof: 'leave_homestead_confirmed',
            }));
        }
        catch (leaveError) {
            saveRecord(session.accountId, transition(session, 'unknown', {
                hostGid: target,
                proof: 'enter_homestead_confirmed',
                errorCode: String(leaveError?.errorCode || leaveError?.code || 'RANCH_FRIEND_LEAVE_UNKNOWN').slice(0, 80),
                errorMessage: String(leaveError?.message || '离场结果未确认').slice(0, 300),
            }));
            throw sessionError(workError
                ? `好友牧场操作与离场均未完全确认：${workError.message}; ${leaveError.message}`
                : value ? `好友牧场操作已确认，但离场未确认：${leaveError.message}`
                    : `好友牧场离场未确认：${leaveError.message}`,
            'RANCH_FRIEND_LEAVE_UNKNOWN', {
                sent: leaveError?.sent !== false,
                resultState: 'unknown', outcomeUnknown: true,
                holdUntilTransportEpochChanged: true,
                operationConfirmed: !workError && value != null,
                cause: leaveError,
                workError,
            });
        }

        session.sceneClosing = wasClosing;
        if (workError) throw workError;
        return value;
    }

    function getSnapshot(accountId = process.env.FARM_ACCOUNT_ID || '') {
        const key = String(accountId);
        const record = validateRecord(loadRecord(key), key);
        if (!record) return { phase: 'idle', resultState: 'idle', hostGid: 0, recoveryRequired: false };
        const diagnostic = getDiagnostic();
        const session = {
            accountId: String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || ''),
            gid: Number(getUserState()?.gid) || 0,
            connectionEpoch: Number(diagnostic.connectionEpoch),
            remoteGeneration: normalizeGeneration(diagnostic.remoteGeneration),
            remoteGenerationSource: String(diagnostic.remoteGenerationSource || 'unknown'),
        };
        const current = sameSession(record, session);
        const advanced = diagnostic.connected === true && diagnostic.loggedIn === true
            && hasConfirmedGameGenerationAdvance(record, session);
        const blocked = record.phase !== 'idle' && !advanced;
        return {
            phase: blocked ? record.phase : 'idle',
            resultState: blocked ? 'unknown' : 'idle',
            hostGid: blocked ? record.hostGid : 0,
            updatedAt: record.updatedAt,
            recoveryRequired: blocked,
            holdUntilTransportEpochChanged: blocked,
            staleRecord: !current && record.phase !== 'idle',
            errorCode: blocked ? record.errorCode || '' : '',
        };
    }

    return { withFriend, getSnapshot };
}

const shared = createRanchFriendSession();
registerPersistentSceneGuard('ranch-friend-session', accountId => shared.getSnapshot(accountId));

module.exports = {
    createRanchFriendSession,
    withRanchFriendVisit: shared.withFriend,
    getRanchFriendSessionSnapshot: shared.getSnapshot,
    isDefinitiveFailure,
};
