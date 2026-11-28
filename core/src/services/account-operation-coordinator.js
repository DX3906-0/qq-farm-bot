'use strict';

const network = require('../utils/network');
const { randomUUID } = require('node:crypto');
const {
    runWithAccountOperation,
    getCurrentOperation,
    assertSceneOperationAvailable,
    assertPersistentSceneOperationAvailable,
    getBarrierSnapshot,
} = require('./account-operation-barrier');
const {
    createRequestGate,
    getRequestContext,
    requestError,
    throwIfRequestCancelled,
    runWithRequestContext,
} = require('../utils/request-priority');

const gate = createRequestGate({ maxActive: 1, maxQueued: 16 });
const workerInstanceId = randomUUID();
let nextOperationId = 1;

function operationError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'account_operation',
        sent: false,
        resultState: 'not_sent',
        ...details,
    });
}

function normalizeGeneration(value) {
    return value === undefined || value === null ? null : String(value);
}

/** IPC重连/进程重载不是离场证据；只接受同账号同用户的真实游戏代际严格推进。 */
function hasConfirmedGameGenerationAdvance(record, session) {
    if (!record || !session || String(record.accountId) !== String(session.accountId)
        || Number(record.ownerGid ?? record.gid) !== Number(session.gid)
        || record.remoteGenerationSource !== 'gateway' || session.remoteGenerationSource !== 'gateway') return false;
    const previous = normalizeGeneration(record.remoteGeneration);
    const current = normalizeGeneration(session.remoteGeneration);
    if (!previous || !current || !/^\d+$/.test(previous) || !/^\d+$/.test(current)) return false;
    return BigInt(current) > BigInt(previous);
}

function captureOperationSession(options = {}) {
    const inherited = getRequestContext();
    const context = {
        ...inherited,
        ...options,
        priority: options.priority || inherited.priority || 'foreground',
    };
    const timeoutMs = Math.min(155000, Math.max(1, Number(options.timeoutMs) || 90000));
    context.deadline = Math.min(Date.now() + timeoutMs,
        Number.isFinite(context.deadline) ? context.deadline : Infinity);
    throwIfRequestCancelled(context);

    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const accountId = String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || '');
    const gid = Number(network.getUserState?.()?.gid) || 0;
    const connectionEpoch = Number(diagnostic.connectionEpoch);
    if (!accountId || !Number.isSafeInteger(gid) || gid <= 0
        || diagnostic.connectionEpoch == null || !Number.isSafeInteger(connectionEpoch) || connectionEpoch < 0
        || diagnostic.connected !== true || diagnostic.loggedIn !== true
        || diagnostic.detached === true || diagnostic.quiescing === true) {
        throw operationError('当前账号连接不可用于场景操作', 'ACCOUNT_OPERATION_UNAVAILABLE');
    }
    return {
        id: nextOperationId++,
        accountId,
        gid,
        connectionEpoch,
        workerInstanceId,
        remoteGeneration: normalizeGeneration(diagnostic.remoteGeneration),
        remoteGenerationSource: String(diagnostic.remoteGenerationSource || 'unknown'),
        context,
        closed: false,
        sceneClosing: false,
        pendingSceneRequests: new Set(),
        unsettledSceneRequest: null,
    };
}

function validateOperationSession(session, { ignoreCancellation = false } = {}) {
    if (session.closed === true) throw operationError('账号事务已结束', 'ACCOUNT_OPERATION_CLOSED');
    if (!ignoreCancellation) throwIfRequestCancelled(session.context);
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    const gid = Number(network.getUserState?.()?.gid) || 0;
    if (String(diagnostic.accountId || process.env.FARM_ACCOUNT_ID || '') !== session.accountId
        || Number(diagnostic.connectionEpoch) !== session.connectionEpoch
        || normalizeGeneration(diagnostic.remoteGeneration) !== session.remoteGeneration
        || String(diagnostic.remoteGenerationSource || 'unknown') !== session.remoteGenerationSource
        || diagnostic.connected !== true || diagnostic.loggedIn !== true || diagnostic.detached === true
        || gid !== session.gid) {
        throw operationError('账号或游戏连接代际已变化', 'ACCOUNT_OPERATION_CHANGED');
    }
}

/** 场景原始请求属于租约，不受HTTP订阅取消；失败后仍等待全部兄弟请求结算。 */
function runSceneRequest(session, service, method, body, options = {}) {
    validateOperationSession(session, { ignoreCancellation: options.cleanup === true });
    if (session.sceneClosing === true && options.cleanup !== true) {
        throw operationError('场景正在离场，不能新增业务请求', 'ACCOUNT_SCENE_CLOSING');
    }
    const pending = session.pendingSceneRequests || (session.pendingSceneRequests = new Set());
    const timeoutMs = Math.min(60000, Math.max(1, Number(options.timeoutMs) || 30000));
    const promise = runWithRequestContext({
        signal: undefined, deadline: Date.now() + timeoutMs,
        priority: options.cleanup ? 'foreground' : session.context.priority || 'foreground',
    }, async () => {
        let acknowledged = false;
        if (!options.assertCanSend) options.lifecycle?.markSent();
        try {
            const response = await network.sendMsgAsync(service, method, body, {
                timeoutMs, priority: options.cleanup ? 'foreground' : session.context.priority || 'foreground',
                // 带校验的写必须等到本地传输即将提交时，才标记为可能已发送。
                assertCanSend: options.assertCanSend && (() => {
                    options.assertCanSend();
                    options.lifecycle?.markSent();
                }),
            });
            if (response?.body == null) {
                throw operationError('场景请求缺少结算回包', 'SCENE_REQUEST_UNSETTLED', {
                    sent: true, resultState: 'unknown', outcomeUnknown: true,
                });
            }
            acknowledged = true;
            validateOperationSession(session, { ignoreCancellation: true });
            return response;
        }
        catch (error) {
            if (!acknowledged) options.lifecycle?.noteWriteError(error);
            const notSent = error?.sent === false || error?.resultState === 'not_sent';
            const refused = ['remote', 'game_request'].includes(String(error?.stage || ''))
                && error?.resultState === 'failed' && error?.outcomeUnknown !== true;
            if (!acknowledged && !notSent && !refused) session.unsettledSceneRequest ||= error;
            throw error;
        }
    });
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
}

async function drainSceneRequests(session) {
    session.sceneClosing = true;
    await Promise.allSettled([...(session.pendingSceneRequests || [])]);
    const diagnostic = network.getDiagnosticSnapshot?.() || {};
    if (session.unsettledSceneRequest || Number(diagnostic.queue?.businessActive || 0) > 0
        || Number(diagnostic.pendingWrites || 0) > 0) {
        throw operationError('场景业务尚无可靠结算证据，不能发送离场或恢复命令', 'SCENE_REQUEST_UNSETTLED', {
            sent: false, resultState: 'unknown', outcomeUnknown: false,
            holdUntilTransportEpochChanged: true, cause: session.unsettledSceneRequest,
        });
    }
    validateOperationSession(session, { ignoreCancellation: true });
}

async function runAccountOperation(name, task, options = {}) {
    const parent = getCurrentOperation();
    if (parent?.session) {
        if (options.exclusive === true && parent.descriptor?.name !== String(name || 'account-operation')) {
            throw operationError('访友事务不能借用其他场景的租约', 'ACCOUNT_OPERATION_SCOPE_CONFLICT');
        }
        validateOperationSession(parent.session);
        return task(parent.session);
    }

    const session = captureOperationSession(options);
    const release = await gate.acquire(session.context.priority, {
        ...session.context,
        validate: () => validateOperationSession(session),
    });
    const descriptor = {
        id: session.id,
        name: String(name || 'account-operation'),
        accountId: session.accountId,
        priority: session.context.priority,
        sceneSensitive: options.sceneSensitive === true,
        startedAt: Date.now(),
    };
    try {
        validateOperationSession(session);
        return await runWithAccountOperation(descriptor, session, async () => {
            if (descriptor.sceneSensitive) {
                // 租约屏障已阻止外部新业务；只等已发请求自然结算，不取消请求或冻结心跳。
                const waitUntil = Math.min(Date.now() + 5000, session.context.deadline);
                for (;;) {
                    validateOperationSession(session, { ignoreCancellation: true });
                    const diagnostic = network.getDiagnosticSnapshot?.() || {};
                    const activeBusiness = Number(diagnostic.queue?.businessActive) || 0;
                    const pendingWrites = Number(diagnostic.pendingWrites) || 0;
                    if (activeBusiness <= 0 && pendingWrites <= 0) {
                        validateOperationSession(session);
                        break;
                    }
                    const remaining = waitUntil - Date.now();
                    if (remaining <= 0) {
                        throw operationError('当前账号业务请求未在等待窗口内结算，本次未切换场景；稍后重试', 'ACCOUNT_OPERATION_BUSY', {
                            retryAfterMs: 1000,
                        });
                    }
                    validateOperationSession(session);
                    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
                }
            }
            if (options.requirePersistentSceneReady === true) {
                assertPersistentSceneOperationAvailable(session.accountId);
            }
            options.onStart?.(session);
            return task(session);
        });
    }
    finally {
        release();
    }
}

function getAccountOperationSnapshot() {
    return {
        active: getBarrierSnapshot(),
        queue: gate.snapshot(),
    };
}

module.exports = {
    runAccountOperation,
    captureOperationSession,
    validateOperationSession,
    hasConfirmedGameGenerationAdvance,
    runSceneRequest,
    drainSceneRequests,
    assertSceneOperationAvailable,
    getAccountOperationSnapshot,
    operationError,
};
