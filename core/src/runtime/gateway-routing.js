const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const DELEGATED_ACCOUNT_ID = '2';
const WX_GATEWAY_SOCKET = '/sock/qq-farm-wx.sock';
const DEFAULT_GATEWAY_SOCKET = '/sock/qq-farm-gateway.sock';

function invalidDelegation() {
    return new Error('gateway-delegation.json 配置非法，已阻止网关回退');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
    return (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value)));
}

function validateDelegation(data) {
    if (!isRecord(data)
        || data.version !== 1
        || typeof data.generation !== 'string' || !data.generation.trim()
        || !['draining', 'active', 'disabled'].includes(data.phase)
        || data.credentialDirectory !== 'wx-gateway'
        || data.socketPath !== WX_GATEWAY_SOCKET
        || data.socketPath === DEFAULT_GATEWAY_SOCKET
        || !Array.isArray(data.accountIds) || !Array.isArray(data.accounts)
        || !isTimestamp(data.createdAt)
        || (data.drainStartedAt !== undefined && !isTimestamp(data.drainStartedAt))) {
        throw invalidDelegation();
    }
    const count = data.phase === 'disabled' ? 0 : 1;
    if (data.accountIds.length !== count || data.accounts.length !== count) {
        throw invalidDelegation();
    }
    if (count && (data.accountIds[0] !== DELEGATED_ACCOUNT_ID
        || !isRecord(data.accounts[0])
        || data.accounts[0].id !== DELEGATED_ACCOUNT_ID
        || data.accounts[0].platform !== 'wx')) {
        throw invalidDelegation();
    }
    return data;
}

function readGatewayDelegation() {
    let text;
    try {
        text = fs.readFileSync(path.resolve(getDataFile('gateway-delegation.json')), 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw invalidDelegation();
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw invalidDelegation();
    }
    return validateDelegation(data);
}

function validateAccounts(data, raw = false) {
    if (!isRecord(data) || !Array.isArray(data.accounts)) throw invalidDelegation();
    const ids = new Set();
    for (const account of data.accounts) {
        if (!isRecord(account) || account.id === undefined || account.id === null) {
            throw invalidDelegation();
        }
        const id = String(account.id);
        if (!id || ids.has(id) || (raw && id === DELEGATED_ACCOUNT_ID)) {
            throw invalidDelegation();
        }
        ids.add(id);
    }
}

function readRawAccounts() {
    let text;
    try {
        text = fs.readFileSync(getDataFile('accounts.json'), 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return { accounts: [], nextId: 1 };
        throw invalidDelegation();
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw invalidDelegation();
    }
    validateAccounts(data, true);
    return data;
}

function mergeDelegatedAccounts(rawData) {
    const delegation = readGatewayDelegation();
    if (!delegation) return clone(rawData);
    validateAccounts(rawData, true);
    const result = clone(rawData);
    result.accounts.push(...clone(delegation.accounts));
    return result;
}

function splitDelegatedAccounts(allData) {
    const delegation = readGatewayDelegation();
    if (!delegation) return { raw: clone(allData), delegation: null };
    validateAccounts(allData);
    const currentRaw = readRawAccounts();
    const accounts = allData.accounts.filter(account => String(account.id) === DELEGATED_ACCOUNT_ID);
    if (accounts.length && (delegation.phase === 'disabled'
        || accounts[0].id !== DELEGATED_ACCOUNT_ID || accounts[0].platform !== 'wx')) {
        throw invalidDelegation();
    }
    const raw = clone(allData);
    raw.accounts = raw.accounts.filter(account => String(account.id) !== DELEGATED_ACCOUNT_ID);
    // 分离或删除委托账号不能降低 raw 中已经分配过的 ID 高水位。
    raw.nextId = Math.max(Number.parseInt(currentRaw.nextId, 10) || 1,
        Number.parseInt(allData.nextId, 10) || 1);
    const updatedDelegation = { ...delegation, accounts: clone(accounts) };
    if (!accounts.length) {
        updatedDelegation.accountIds = [];
        updatedDelegation.phase = 'disabled';
    }
    return { raw, delegation: validateDelegation(updatedDelegation) };
}

function resolveAccountGatewaySocket(accountId, env = {}) {
    const delegation = readGatewayDelegation();
    if (delegation && String(accountId) === DELEGATED_ACCOUNT_ID) {
        if (delegation.phase !== 'active') return { blocked: true, delegated: true };
        return { socketPath: delegation.socketPath, blocked: false, delegated: true };
    }
    return { socketPath: env.FARM_GATEWAY_SOCK, blocked: false, delegated: false };
}

/** 仅管理主进程同步调用：与昵称/Code等帐号 mutation 串行，不产生跨进程双文件竞态。 */
function prepareGatewayDelegation(generation, expectedAccountsSha256) {
    if (!/^[a-f0-9]{12}$/.test(String(generation || ''))) throw invalidDelegation();
    if (readGatewayDelegation()) throw new Error('微信委托已经存在，不能重复迁移');
    const rawText = fs.readFileSync(getDataFile('accounts.json'), 'utf8');
    const crypto = require('node:crypto');
    if (crypto.createHash('sha256').update(rawText).digest('hex') !== expectedAccountsSha256) {
        throw new Error('账号记录已更新，停止交接');
    }
    const raw = JSON.parse(rawText);
    validateAccounts(raw);
    if (raw.accounts.length !== 3 || !['1', '2', '10'].every(id => raw.accounts.some(a => a.id === id))) throw invalidDelegation();
    const account = raw.accounts.find(a => a.id === '2');
    if (account.platform !== 'wx') throw invalidDelegation();
    const record = validateDelegation({ version: 1, generation, phase: 'draining', accountIds: ['2'],
        socketPath: WX_GATEWAY_SOCKET, credentialDirectory: 'wx-gateway', accounts: [account], createdAt: Date.now() });
    const { writeJsonFileAtomic } = require('../services/json-db');
    // 同一JS同步调用内无await；其间主进程不可能插入另一帐号保存。
    writeJsonFileAtomic(getDataFile('accounts.json'), { ...raw, accounts: raw.accounts.filter(a => a.id !== '2') });
    writeJsonFileAtomic(getDataFile('gateway-delegation.json'), record);
    return { generation: record.generation, phase: record.phase, accountIds: record.accountIds };
}

function advanceGatewayDelegation(generation, action) {
    const record = readGatewayDelegation();
    if (!record || record.generation !== generation || record.phase !== 'draining') throw invalidDelegation();
    if (action === 'drained') {
        if (record.drainStartedAt !== undefined) throw new Error('排空记录已存在');
        record.drainStartedAt = Date.now();
    } else if (action === 'active') {
        if (!Number.isFinite(record.drainStartedAt) || Date.now() < record.drainStartedAt + 180000) throw new Error('排空时间尚未满足');
        record.phase = 'active';
    } else {
        throw invalidDelegation();
    }
    const { writeJsonFileAtomic } = require('../services/json-db');
    writeJsonFileAtomic(getDataFile('gateway-delegation.json'), record);
    return { generation: record.generation, phase: record.phase, drainStartedAt: record.drainStartedAt };
}

module.exports = {
    prepareGatewayDelegation,
    advanceGatewayDelegation,
    readGatewayDelegation,
    mergeDelegatedAccounts,
    splitDelegatedAccounts,
    resolveAccountGatewaySocket,
};
