'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const persistentGuards = new Map();
let active = null;

function barrierError(message, activeOperation) {
    return Object.assign(new Error(message), {
        errorCode: 'ACCOUNT_SCENE_BUSY',
        stage: 'account_operation',
        sent: false,
        resultState: 'not_sent',
        outcomeUnknown: false,
        activeOperation,
    });
}

function isCritical(service, method) {
    return service === 'gamepb.userpb.UserService' && ['Login', 'Heartbeat'].includes(method)
        || service === 'gamepb.acepb.AceService' && method === 'AntiData';
}

async function runWithAccountOperation(descriptor, session, task) {
    if (storage.getStore()?.descriptor) return task();
    active = descriptor;
    try {
        return await storage.run({ descriptor, session }, task);
    }
    finally {
        session.closed = true;
        if (active?.id === descriptor.id) active = null;
    }
}

function getCurrentOperation() {
    return storage.getStore() || null;
}

function isSceneRequestOwned() {
    const current = storage.getStore();
    return current?.descriptor?.sceneSensitive === true && current.descriptor.id === active?.id
        && current.session?.closed !== true;
}

function registerPersistentSceneGuard(name, guard) {
    if (typeof guard !== 'function') throw new TypeError('场景持久门禁必须是函数');
    persistentGuards.set(String(name), guard);
}

function assertPersistentSceneOperationAvailable(accountId) {
    const key = String(accountId || '');
    if (!key) return;
    for (const [name, guard] of persistentGuards) {
        const state = guard(key);
        if (state?.recoveryRequired === true) {
            throw Object.assign(barrierError('场景离场证据未确认，普通业务请求未发送；仅保留心跳', name), {
                errorCode: 'ACCOUNT_SCENE_UNKNOWN', resultState: 'unknown',
                holdUntilTransportEpochChanged: true,
            });
        }
    }
}

function assertGameRequestAllowed(service, method) {
    if (isCritical(service, method)) return;
    const current = storage.getStore();
    if (current?.session?.closed === true) {
        throw barrierError('账号事务已结束，迟到任务不能继续发送业务请求', current.descriptor?.name);
    }
    if (active?.sceneSensitive) {
        if (isSceneRequestOwned()) return;
        throw barrierError('牧场场景租约生效中，当前业务请求未发送；等待恢复农场场景后再试', active.name);
    }
    const accountId = String(current?.descriptor?.accountId || process.env.FARM_ACCOUNT_ID || '');
    assertPersistentSceneOperationAvailable(accountId);
}

function assertSceneOperationAvailable(label = '好友访问') {
    if (!active?.sceneSensitive) return;
    // 农场访友也完整占有串行场景租约；只允许本事务取得自己的访友锁。
    if (label === '好友访问' && active.name === 'farm-friend-visit' && isSceneRequestOwned()) return;
    throw barrierError(`${label}暂不能与场景切换并发，请稍后重试`, active.name);
}

function getBarrierSnapshot() {
    return active ? { ...active } : null;
}

module.exports = {
    runWithAccountOperation,
    getCurrentOperation,
    assertGameRequestAllowed,
    isSceneRequestOwned,
    registerPersistentSceneGuard,
    assertPersistentSceneOperationAvailable,
    assertSceneOperationAvailable,
    getBarrierSnapshot,
};
