'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { requestError } = require('../utils/request-priority');

const MAX_RECORDS = 128;

function operationError(message, errorCode, details = {}) {
    return requestError(message, {
        errorCode,
        stage: 'ranch_operation',
        sent: details.sent ?? false,
        resultState: details.resultState || 'not_sent',
        ...details,
    });
}

function validCost(cost) {
    return typeof cost?.resourceKey === 'string' && /^item:[1-9]\d*$/.test(cost.resourceKey)
        && typeof cost?.amount === 'string' && /^\d+$/.test(cost.amount) && BigInt(cost.amount) > 0n;
}

function normalizeCosts(costs) {
    if (costs === undefined || costs === null) return [];
    if (!Array.isArray(costs)) throw operationError('费用结构无效，不能按免费操作处理', 'RANCH_LEDGER_COST_INVALID');
    const rows = costs.map(cost => ({ resourceKey: String(cost?.resourceKey || ''), amount: String(cost?.amount ?? '0') }));
    if (!rows.every(validCost)) throw operationError('费用字段无效，不能丢弃资源预留', 'RANCH_LEDGER_COST_INVALID');
    return rows.map(row => ({ ...row, amount: BigInt(row.amount).toString() }));
}

function validateRecords(records) {
    if (!Array.isArray(records)) {
        throw operationError('牧场待核对记录格式错误，必须保守闭锁', 'RANCH_LEDGER_INVALID', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    if (records.some(row => !row?.id || typeof row.target !== 'string' || !row.label
        || !Number.isFinite(row.createdAt)
        || !Array.isArray(row.costs) || !row.costs.every(validCost))) {
        throw operationError('牧场待核对记录不完整，必须保守闭锁', 'RANCH_LEDGER_INVALID', {
            resultState: 'unknown', outcomeUnknown: false,
        });
    }
    return records;
}

/** 与 game-command 一致的明确失败语义；TIMEOUT/CANCEL/DEADLINE 不算明确。 */
function isDefinitiveFailure(error) {
    return error?.sent === false || error?.resultState === 'not_sent'
        || (error?.resultState === 'failed' && error?.outcomeUnknown !== true
            && !/TIMEOUT|CANCEL|DEADLINE/i.test(String(error?.errorCode || error?.code || '')));
}

function createRanchOperations(dependencies = {}) {
    const state = new Map();
    const inFlight = new Map();
    const loadFile = dependencies.loadFile || (accountId => {
        const file = getDataFile(path.join('ranch-operations',
            `${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24)}.json`));
        for (const candidate of [path.dirname(file), file]) {
            if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
                throw operationError('牧场操作记录路径不能是符号链接', 'RANCH_LEDGER_PATH_INVALID');
            }
        }
        return file;
    });
    const readFile = dependencies.readFile || (file => {
        if (!fs.existsSync(file)) return [];
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    });
    const writeFile = dependencies.writeFile || ((file, records) => writeJsonFileAtomic(file, records));

    function forAccount(accountId) {
        const key = String(accountId || '');
        if (!state.has(key)) {
            state.set(key, validateRecords(readFile(loadFile(key))));
        }
        return state.get(key);
    }

    function persist(accountId, records) {
        if (records.length > MAX_RECORDS) {
            throw operationError('牧场未确认操作已达上限，请先逐条核对', 'RANCH_LEDGER_FULL', {
                resultState: 'unknown', outcomeUnknown: false,
            });
        }
        try {
            writeFile(loadFile(String(accountId)), records);
            state.set(String(accountId), records);
        }
        catch (cause) {
            throw operationError('牧场操作记录保存失败，保留未确认标记，不要重提', 'RANCH_LEDGER_WRITE_FAILED', {
                cause,
            });
        }
    }

    function pending(accountId) {
        return forAccount(accountId).map(row => ({ ...row, costs: row.costs.map(cost => ({ ...cost })) }));
    }

    function reserved(accountId, resourceKey) {
        return forAccount(accountId)
            .flatMap(row => row.costs)
            .filter(cost => cost.resourceKey === resourceKey)
            .reduce((sum, cost) => sum + BigInt(cost.amount), 0n);
    }

    function hasPendingTarget(accountId, target) {
        return forAccount(accountId).some(row => row.target === target);
    }

    function acknowledge(accountId, id) {
        if (inFlight.get(String(accountId))?.has(id)) {
            throw operationError('该操作仍在结算，不能人工提前释放记录', 'RANCH_OPERATION_BUSY');
        }
        const records = forAccount(accountId);
        if (!records.some(row => row.id === id)) {
            throw operationError('这条记录已处理，请刷新', 'RANCH_RECORD_CHANGED');
        }
        persist(accountId, records.filter(row => row.id !== id));
    }

    /**
     * 持久化单次写事务：先落 pending，明确未发送/明确失败自动解除；否则保留并标 unknown。
     * run() 返回前调用方不得再触发同 target 新操作（由本函数入口拦截）。
     */
    async function spend(accountId, plan, run) {
        const key = String(accountId);
        if (hasPendingTarget(key, plan.target)) {
            throw operationError('该操作上次结果未知，已禁止重放；请先在待核对列表确认', 'RANCH_PENDING_CONFIRMATION', {
                resultState: 'unknown', outcomeUnknown: false,
            });
        }
        const costs = normalizeCosts(plan.costs);
        const requestedByResource = new Map();
        for (const cost of costs) requestedByResource.set(cost.resourceKey,
            (requestedByResource.get(cost.resourceKey) || 0n) + BigInt(cost.amount));
        const availableByResource = new Map(Object.entries(plan.availableResources || {}).map(([resourceKey, amount]) => {
            try { return [resourceKey, BigInt(amount)]; } catch { return [resourceKey, null]; }
        }));
        const existing = forAccount(key);
        const reservedByResource = new Map();
        for (const row of existing) for (const cost of row.costs) {
            reservedByResource.set(cost.resourceKey,
                (reservedByResource.get(cost.resourceKey) || 0n) + BigInt(cost.amount));
        }
        const conflictingResources = new Set();
        for (const [resourceKey, requestAmount] of requestedByResource) {
            const available = availableByResource.get(resourceKey);
            const reserved = reservedByResource.get(resourceKey) || 0n;
            if (existing.some(row => row.costs.some(cost => cost.resourceKey === resourceKey))
                && (available == null || reserved + requestAmount > available)) conflictingResources.add(resourceKey);
        }
        const conflict = existing.find(row => row.costs.some(cost => conflictingResources.has(cost.resourceKey)));
        if (conflict) {
            throw operationError(`${conflict.label || '另一项操作'}结果仍待核对；已为它预留余额，本次所需余额不足，未发送`,
                'RANCH_PENDING_RESOURCE_CONFLICT', { resultState: 'unknown', outcomeUnknown: false, conflictRecordId: conflict.id });
        }
        const record = {
            id: randomUUID(),
            target: plan.target,
            label: plan.label,
            costs: normalizeCosts(plan.costs),
            createdAt: Date.now(),
            message: '操作结果待核对',
        };
        persist(key, [...forAccount(key), record]);
        if (!inFlight.has(key)) inFlight.set(key, new Set());
        inFlight.get(key).add(record.id);
        let sentWrites = 0;
        let firstWriteError = null;
        let result;
        try {
            try {
                result = await run({
                    markSent: () => { sentWrites += 1; },
                    noteWriteError: error => { firstWriteError = firstWriteError || error; },
                });
            }
            catch (cause) {
                const rejected = sentWrites === 0 && isDefinitiveFailure(cause)
                    || sentWrites === 1 && firstWriteError && isDefinitiveFailure(firstWriteError);
                try {
                    if (rejected) persist(key, forAccount(key).filter(row => row.id !== record.id));
                    else persist(key, forAccount(key).map(row => row.id === record.id ? {
                        ...row, message: String(cause?.message || '结果未知').slice(0, 300),
                    } : row));
                }
                catch (storageError) {
                    throw operationError('游戏写结果与安全记录未完全提交，保留待核对，勿重发', 'RANCH_LEDGER_WRITE_FAILED', {
                        sent: sentWrites > 0, resultState: 'unknown', outcomeUnknown: !rejected,
                        cause: storageError, writeError: cause, recordId: record.id,
                    });
                }
                if (!rejected && cause && typeof cause === 'object') {
                    cause.outcomeUnknown = true;
                    cause.resultState = 'unknown';
                    cause.recordId = record.id;
                }
                throw cause;
            }
            try {
                persist(key, forAccount(key).filter(row => row.id !== record.id));
            }
            catch (storageError) {
                throw operationError('写回包已核验但安全记录提交失败，不能宣称未发送或重发', 'RANCH_LEDGER_COMMIT_UNKNOWN', {
                    sent: sentWrites > 0, resultState: 'unknown', outcomeUnknown: true,
                    operationConfirmed: true, cause: storageError, recordId: record.id,
                });
            }
            return result;
        }
        finally {
            inFlight.get(key)?.delete(record.id);
        }
    }

    function snapshot(accountId) {
        return { pending: pending(accountId), maxRecords: MAX_RECORDS };
    }

    function clearMemoryForTests() {
        if ([...inFlight.values()].some(entries => entries.size > 0)) {
            throw operationError('在途操作不能通过清内存解除', 'RANCH_OPERATION_BUSY');
        }
        state.clear();
        inFlight.clear();
    }

    return { spend, acknowledge, pending, reserved, hasPendingTarget, snapshot, clearMemoryForTests };
}

const shared = createRanchOperations();

module.exports = {
    createRanchOperations,
    isDefinitiveFailure,
    normalizeCosts,
    ranchOperations: shared,
};
