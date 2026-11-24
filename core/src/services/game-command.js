'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const { createRequestGate, getRequestContext, runWithRequestContext, throwIfRequestCancelled, requestError } = require('../utils/request-priority');

const own = (value, key) => value != null && Object.hasOwn(value, key);
function positiveId(value, label = '编号') {
    if (typeof value === 'boolean' || value == null || value === '') throw validation(`${label}无效`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw validation(`${label}无效`);
    return number;
}
function quantity(value, label = '数量') {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw validation(`${label}超出安全整数范围`);
    const text = String(value == null ? '0' : value);
    if (!/^\d+$/.test(text) || BigInt(text) > 9223372036854775807n) throw validation(`${label}无效`);
    return BigInt(text).toString();
}
function validation(message, errorCode = 'GAME_VALIDATION') {
    return requestError(message, { errorCode, retryable: false, sent: false, resultState: 'not_sent' });
}
function unknown(message = '操作结果未确认，请只刷新核对，不要重复提交', cause) {
    return requestError(message, { errorCode: 'GAME_RESULT_UNKNOWN', retryable: false, sent: true,
        resultState: 'unknown', outcomeUnknown: true, refreshRequired: true, causeCode: cause?.errorCode || cause?.code });
}
function blockedUnknown(message = '上次操作结果未确认，本次没有发送新请求；请只刷新核对，不要重复提交') {
    return requestError(message, { errorCode: 'GAME_PRIOR_RESULT_UNKNOWN', retryable: false, sent: false,
        resultState: 'unknown', outcomeUnknown: false, priorOutcomeUnknown: true, refreshRequired: true });
}
function captureSession(options = {}) {
    const context = { ...getRequestContext(), ...options, priority: 'foreground' };
    context.deadline = Math.min(Date.now() + 60000, Number.isFinite(context.deadline) ? context.deadline : Infinity);
    throwIfRequestCancelled(context);
    const diagnostic = network.getDiagnosticSnapshot();
    const gid = quantity(network.getUserState()?.gid);
    if (!diagnostic.accountId || !diagnostic.connected || !diagnostic.loggedIn || diagnostic.detached || gid === '0') {
        throw validation('当前账号未连接或未登录', 'GAME_ACCOUNT_UNAVAILABLE');
    }
    if (context.accountId != null && String(context.accountId) !== String(diagnostic.accountId)) {
        throw validation('请求账号与当前游戏连接不一致', 'GAME_ACCOUNT_CHANGED');
    }
    return { accountId: String(diagnostic.accountId), gid, context,
        epoch: diagnostic.connectionEpoch, generation: diagnostic.remoteGeneration };
}
function validateSession(session) {
    throwIfRequestCancelled(session.context);
    const diagnostic = network.getDiagnosticSnapshot();
    if (String(diagnostic.accountId) !== session.accountId || diagnostic.connectionEpoch !== session.epoch
        || diagnostic.remoteGeneration !== session.generation || !diagnostic.connected || !diagnostic.loggedIn
        || diagnostic.detached || quantity(network.getUserState()?.gid) !== session.gid) {
        throw validation('账号或游戏连接已切换，本次响应已失效', 'GAME_ACCOUNT_CHANGED');
    }
}
function isDefinitiveFailure(error) {
    return error?.sent === false || error?.resultState === 'not_sent'
        || (error?.resultState === 'failed' && error?.outcomeUnknown !== true
            && !/TIMEOUT|CANCEL|DEADLINE/i.test(String(error?.errorCode || error?.code || '')));
}

/** A bounded, single-writer command scope. The durable ledger is touched only when a user sends a game mutation. */
function createGameCommandScope(name, dependencies = {}) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError('命令模块名无效');
    const gate = createRequestGate({ maxActive: 1, maxQueued: 8 });
    const fileFor = accountId => getDataFile(path.join('game-command-state', name,
        `${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24)}.json`));
    const read = dependencies.read || (accountId => {
        const file = fileFor(accountId);
        if (!fs.existsSync(file)) return {};
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('操作记录损坏，请保留记录并检查', 'GAME_LEDGER_INVALID');
        return value;
    });
    const save = dependencies.save || ((accountId, value) => writeJsonFileAtomic(fileFor(accountId), value));
    const memory = new Map();
    function ledger(accountId) {
        if (!memory.has(accountId)) {
            try { memory.set(accountId, read(accountId)); }
            catch (error) { throw validation(`无法读取操作记录：${error.message}`, 'GAME_LEDGER_INVALID'); }
        }
        return memory.get(accountId);
    }
    function token(key) { return createHash('sha256').update(String(key)).digest('hex'); }
    function blocked(session, key) { return !!ledger(session.accountId)[token(key)]; }
    function reserve(session, key) {
        validateSession(session);
        const state = ledger(session.accountId);
        if (state[token(key)]) throw blockedUnknown('此操作有未确认记录，本次未发送新请求；禁止重放，请只刷新核对');
        if (Object.keys(state).length >= 128) throw validation('未确认操作记录过多，请先核对已有结果', 'GAME_LEDGER_FULL');
        const next = { ...state, [token(key)]: { phase: 'pending', at: Date.now() } };
        try { save(session.accountId, next); }
        catch (error) { throw validation(`保存单次操作记录失败：${error.message}`, 'GAME_LEDGER_WRITE_FAILED'); }
        memory.set(session.accountId, next);
    }
    function confirm(session, key) {
        const next = { ...ledger(session.accountId) };
        delete next[token(key)];
        try { save(session.accountId, next); }
        catch (cause) { throw unknown('游戏结果已确认，但操作记录保存失败；保留未确认标记，不要重提', cause); }
        memory.set(session.accountId, next);
    }
    function completed(session, key) { return ledger(session.accountId)[token(key)]?.phase === 'completed'; }
    function confirmOnce(session, key, outcome) {
        validateSession(session);
        const next = { ...ledger(session.accountId), [token(key)]: { phase: 'completed', at: Date.now(), outcome: String(outcome) } };
        try { save(session.accountId, next); }
        catch (cause) { throw unknown('答题结果已确认但单次记录保存失败，请勿重提', cause); }
        memory.set(session.accountId, next);
    }
    async function rpc(session, service, method, requestName, replyName, input = {}, options = {}) {
        validateSession(session);
        const Request = types[requestName];
        const Reply = types[replyName];
        if (!Request || !Reply) throw validation(`协议未加载：${method}`, 'GAME_PROTO_UNAVAILABLE');
        const payload = Request.encode(Request.fromObject(input)).finish();
        if (options.write && !options.key) throw validation('缺少单次操作标识');
        if (options.write) {
            reserve(session, options.key);
            if (!session.commandWrites) session.commandWrites = new Set();
            session.commandWrites.add(options.key);
        }
        let response;
        try {
            response = await runWithRequestContext(session.context, () => network.sendMsgAsync(service, method, payload,
                { timeoutMs: Math.min(30000, options.timeoutMs || 20000), priority: session.context.priority || 'foreground' }));
        } catch (cause) {
            if (options.write) {
                if (isDefinitiveFailure(cause)) {
                    confirm(session, options.key);
                    cause.retryable = false;
                    throw cause;
                }
                throw unknown(undefined, cause);
            }
            throw cause;
        }
        try {
            validateSession(session);
            if (!response || !Buffer.isBuffer(response.body) && !(response.body instanceof Uint8Array)
                || response.resultState && response.resultState !== 'completed') throw validation('游戏未返回完整响应', 'GAME_INCOMPLETE_REPLY');
            if (response.body.length === 0 && options.allowEmpty !== true) throw validation('游戏响应为空，不能据此判断成功', 'GAME_INCOMPLETE_REPLY');
            return Reply.decode(response.body);
        } catch (cause) {
            if (options.write) throw unknown(undefined, cause);
            throw cause;
        }
    }
    async function execute(operation, options = {}) {
        const session = captureSession(options);
        const release = await gate.acquire('foreground', { ...session.context, validate: () => validateSession(session) });
        try { return await operation(session); }
        catch (cause) {
            // Only writes reserved by THIS operation can turn a later read/validation
            // failure into a post-write unknown. Older records or another SKU must
            // not make a new pre-write rejection pretend that a game write was sent.
            const pendingThisOperation = [...(session.commandWrites || [])]
                .some(key => ledger(session.accountId)[token(key)]?.phase === 'pending');
            if (pendingThisOperation && cause.resultState !== 'unknown') {
                throw unknown('本次操作链路未全部确认，请只刷新核对，不要重放', cause);
            }
            throw cause;
        }
        finally { release(); }
    }
    return { rpc, execute, blocked, confirm, completed, confirmOnce };
}

module.exports = { createGameCommandScope, captureSession, validateSession, validation, unknown, blockedUnknown, positiveId, quantity, own };
