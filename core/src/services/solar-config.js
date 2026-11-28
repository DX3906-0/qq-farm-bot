'use strict';

// Metadata only: no game RPC, account login, rewards, or automation writes.
const https = require('node:https');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { getDataFile } = require('../config/runtime-paths');
const { writeJsonFileAtomic } = require('./json-db');
const bundled = require('../activity-data/solar-calendar.json');

const VERSION_URL = 'https://cdn-resource.nqf.qq.com/release/version.json';
const CDN_ROOT = 'https://cdn-resource.nqf.qq.com/release/remote/';
const REFERENCE_URL = 'https://raw.githubusercontent.com/liyangpengs/qq-farm-bot/master/core/src/activity-data/solar-calendar.json';
const BASELINE = Object.freeze({ version: '1.15.1.4', mainscene: '77b3c', delayRes: '943e2',
    source: 'official-miniapp-settings', gameJsSha256: '3ce682493dde4b8ab56d621eeb27f4aa1b50e802a077997e5fc1bbee8f49072b' });
const CONFIG_KEY = 'NQF_SHANGXIANDAMAI_#2026_SECURE';
const TTL_MS = 6 * 3600000;
const FAILURE_TTL_MS = 10 * 60000;
const MAX_BYTES = 4 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => value != null && Object.hasOwn(value, key);

function validUrl(value) {
    const url = new URL(value);
    const allowed = url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
        && ((url.hostname === 'cdn-resource.nqf.qq.com' && url.pathname.startsWith('/release/'))
            || (url.hostname === 'raw.githubusercontent.com' && url.pathname === new URL(REFERENCE_URL).pathname));
    if (!allowed) throw new Error('节令配置来源不在已核验白名单');
    return url;
}
function requestBytes(value, deadline) {
    const url = validUrl(value);
    return new Promise((resolve, reject) => {
        const timeout = Math.min(5000, Math.max(1, deadline - Date.now()));
        if (deadline <= Date.now()) { reject(new Error('节令配置刷新期限已到')); return; }
        let totalTimer;
        const finish = (error, bytes) => { clearTimeout(totalTimer); error ? reject(error) : resolve(bytes); };
        const request = https.get(url, { headers: { accept: 'application/json', 'user-agent': 'qq-farm-bot/solar-config' } }, response => {
            if (response.statusCode !== 200) {
                response.resume(); finish(new Error(`节令配置 HTTP ${response.statusCode}`)); return;
            }
            let size = 0; const chunks = [];
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_BYTES) { request.destroy(new Error('节令配置资源超过大小限制')); return; }
                chunks.push(chunk);
            });
            response.on('error', error => finish(error));
            response.on('end', () => finish(null, Buffer.concat(chunks)));
        });
        totalTimer = setTimeout(() => request.destroy(new Error('节令配置读取超时')), timeout);
        request.on('error', error => finish(error));
    });
}
function validateRows(rows, kind) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 512) throw new Error('节令配置表为空或数量异常');
    const seen = new Set();
    return rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0
            || seen.has(Number(row.id))) throw new Error('节令配置编号缺失或重复');
        seen.add(Number(row.id));
        const out = { id: Number(row.id), name: typeof row.name === 'string' ? row.name : '',
            description: typeof row.description === 'string' ? row.description : typeof row.desc === 'string' ? row.desc : '' };
        if (kind === 'events') {
            for (const key of ['question', 'answer', 'error_tips', 'help']) {
                const value = row[key];
                if (value != null && typeof value !== 'string') throw new Error(`节令配置 ${key} 类型错误`);
                out[key] = value || '';
            }
            const options = out.answer ? out.answer.split(';') : [];
            if (out.question && (options.length < 2 || options.length > 12 || options.some(value => !value.trim()))) throw new Error('节令题目选项不完整');
            // Missing index is NOT A. Never copy the official schema's default 0.
            out.answer_index = own(row, 'answer_index') && Number.isInteger(row.answer_index)
                && row.answer_index >= 0 && row.answer_index < options.length ? row.answer_index : null;
        } else out.year = row.year == null ? '' : String(row.year);
        return out;
    });
}
function compareVersions(a, b) {
    const parse = value => String(value || '').match(/^\d+(?:\.\d+){2,3}/)?.[0].split('.').map(Number);
    const aa = parse(a), bb = parse(b);
    if (!aa || !bb) return null;
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        const delta = (aa[i] || 0) - (bb[i] || 0);
        if (delta) return Math.sign(delta);
    }
    return 0;
}
function expandUuid(compact) {
    if (/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(compact)
        || /^[a-f\d]{9}$/i.test(compact)) return compact;
    if (!/^[a-f\d]{2}[A-Za-z\d+/]{20}$/.test(compact)) throw new Error('节令配置 UUID 无效');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hex = compact.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const a = alphabet.indexOf(compact[i]), b = alphabet.indexOf(compact[i + 1]);
        hex += (a >> 2).toString(16) + (((a & 3) << 2) | (b >> 4)).toString(16) + (b & 15).toString(16);
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function assetLocation(manifest, bundle, name) {
    if (manifest.name !== bundle || !manifest.paths || !Array.isArray(manifest.uuids) || manifest.isZip) throw new Error('节令 bundle 清单不完整或布局未支持');
    const matches = Object.entries(manifest.paths).filter(([, value]) => Array.isArray(value) && value[0] === `config/${name}`);
    if (matches.length !== 1) throw new Error(`官方清单尚未包含 ${name}`);
    const [index, definition] = matches[0];
    const type = manifest.types?.[definition[1]];
    if (!['cc.TextAsset', 'cc.JsonAsset'].includes(type)) throw new Error('节令配置资源类型不符');
    if ((manifest.redirect || []).some((value, i) => i % 2 === 0 && String(value) === index)) throw new Error('节令配置跨 bundle 重定向尚未核验');
    const packs = Object.entries(manifest.packs || {}).filter(([, entries]) => entries.includes(Number(index)));
    if (packs.length > 1) throw new Error('节令配置重复分包');
    const key = packs[0]?.[0] || index;
    const versions = manifest.versions?.import || [];
    const at = versions.findIndex((value, i) => i % 2 === 0 && String(value) === String(key));
    const version = versions[at + 1];
    if (at < 0 || !/^[A-Za-z\d_-]{1,64}$/.test(version || '')) throw new Error('节令配置缺少资源版本');
    const uuid = expandUuid(packs[0]?.[0] || manifest.uuids[Number(index)]);
    const importBase = manifest.importBase || 'import';
    if (importBase !== 'import') throw new Error('节令配置资源基址未核验');
    return { url: `${CDN_ROOT}${bundle}/${importBase}/${uuid.slice(0, 2)}/${uuid}.${version}.json`, type, version, packed: !!packs.length };
}
function decodeAsset(value, name, type) {
    let payload;
    function find(node, depth = 0) {
        if (depth > 6 || payload !== undefined || !node || typeof node !== 'object') return;
        if (node.__type__ === type && node._name === name) { payload = node[type === 'cc.TextAsset' ? 'text' : 'json']; return; }
        if (Array.isArray(node) && Array.isArray(node[3]) && Array.isArray(node[5])
            && node[3].some(definition => Array.isArray(definition) && definition[0] === type)) {
            for (const row of node[5]) {
                if (Array.isArray(row) && row[1] === name) { payload = row[2]; return; }
            }
        }
        if (Array.isArray(node)) for (const child of node) find(child, depth + 1);
    }
    find(value);
    if (payload === undefined) throw new Error(`节令配置资产 ${name} 结构未确认`);
    if (type === 'cc.JsonAsset') return payload;
    if (typeof payload !== 'string' || !/^[A-Za-z\d+/=\r\n]+$/.test(payload)) throw new Error('节令文字配置编码无效');
    const bytes = Buffer.from(payload, 'base64'), key = Buffer.from(CONFIG_KEY, 'utf8');
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function createSolarConfigLoader(dependencies = {}) {
    const now = dependencies.now || Date.now;
    const read = dependencies.request || requestBytes;
    const scope = /^[\d]+$/.test(String(process.env.FARM_ACCOUNT_ID || '')) ? String(process.env.FARM_ACCOUNT_ID) : 'panel';
    // Each worker owns its own metadata cache. No worker overwrites global config.
    const cachePath = getDataFile(`solar-config/${scope}.json`);
    const load = dependencies.load || (() => fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : null);
    const save = dependencies.save || (value => writeJsonFileAtomic(cachePath, value));
    let snapshot = { events: bundled.events, seasons: bundled.seasons, sources: {}, sync: { status: 'bundled-reference', checkedAt: 0, officialCurrent: false } };
    let initialized = false, nextCheck = 0, flight = null;
    const json = async (url, deadline) => {
        validUrl(url);
        const bytes = await read(url, deadline);
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw new Error('节令配置响应不是有限字节内容');
        return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: hash(bytes), url };
    };
    async function officialTable(bundle, version, name, kind, deadline) {
        const manifestUrl = `${CDN_ROOT}${bundle}/config.${version}.json`;
        const manifest = await json(manifestUrl, deadline);
        const location = assetLocation(manifest.value, bundle, name);
        const asset = await json(location.url, deadline);
        const rows = validateRows(decodeAsset(asset.value, name, location.type), kind);
        return { rows, source: { kind: 'official-cdn-snapshot', url: asset.url, sha256: asset.sha256,
            manifestUrl, manifestSha256: manifest.sha256, bundle, bundleVersion: version,
            resourceVersion: location.version, questionOriginVerified: true, answerOriginVerified: false } };
    }
    async function update() {
        const deadline = now() + 18000;
        const sync = { status: 'partial', checkedAt: now(), officialCurrent: false, officialStatus: 'unavailable', referenceStatus: 'unavailable', warnings: [] };
        let index, officialEvents, officialSeasons, reference;
        try {
            index = await json(`${VERSION_URL}?random=${now()}`, deadline);
            const entry = Array.isArray(index.value) ? index.value[0] : null;
            if (!entry?.md5 || compareVersions(entry.version, BASELINE.version) === null) throw new Error('官方版本入口结构无效');
            sync.officialVersion = entry.version;
            const floor = snapshot.sync?.officialSnapshotVersion || BASELINE.version;
            if (compareVersions(entry.version, floor) < 0) sync.officialStatus = 'version-index-behind';
            else {
                const version = entry.md5.mainscene;
                if (!/^[A-Za-z\d_-]{1,64}$/.test(version || '')) throw new Error('官方节令清单版本缺失');
                [officialEvents, officialSeasons] = await Promise.all([
                    officialTable('mainscene', version, 'SolarTerms', 'events', deadline),
                    officialTable('mainscene', version, 'SolarSeason', 'seasons', deadline),
                ]);
                sync.officialStatus = 'index-snapshot';
                sync.officialCurrent = true;
            }
        } catch (error) { sync.warnings.push(error.message); }
        // Seeded official snapshots are only historical fallback, never latest.
        if (!officialEvents && !snapshot.sync.officialSnapshotLoaded && now() < deadline) {
            try {
                [officialEvents, officialSeasons] = await Promise.all([
                    officialTable('mainscene', BASELINE.mainscene, 'SolarTerms', 'events', deadline),
                    officialTable('mainscene', BASELINE.mainscene, 'SolarSeason', 'seasons', deadline),
                ]);
            } catch (error) { sync.warnings.push(error.message); }
        }
        try {
            if (now() >= deadline) throw new Error('节令元数据刷新预算已耗尽');
            const result = await json(REFERENCE_URL, deadline);
            reference = { events: validateRows(result.value.events, 'events'), seasons: validateRows(result.value.seasons, 'seasons'),
                source: { kind: 'upstream-live-reference', repository: 'liyangpengs/qq-farm-bot', config: 'core/src/activity-data/solar-calendar.json',
                    url: result.url, sha256: result.sha256, questionOriginVerified: false, answerOriginVerified: false } };
            sync.referenceStatus = 'fetched';
        } catch (error) { sync.warnings.push(error.message); }
        const events = new Map(snapshot.events.map(row => [row.id, row]));
        const seasons = new Map(snapshot.seasons.map(row => [row.id, row]));
        const sources = { ...snapshot.sources };
        if (reference) {
            for (const row of reference.events) { events.set(row.id, row); sources[row.id] = reference.source; }
            for (const row of reference.seasons) seasons.set(row.id, row);
        }
        if (officialEvents && officialSeasons) {
            sync.officialSnapshotVersion = sync.officialCurrent ? sync.officialVersion : BASELINE.version;
            for (const row of officialEvents.rows) { events.set(row.id, row); sources[row.id] = officialEvents.source; }
            for (const row of officialSeasons.rows) seasons.set(row.id, row);
            sync.officialSnapshotLoaded = true;
        } else {
            // A later live reference must not downgrade already verified
            // official question bytes merely because discovery is unavailable.
            for (const row of snapshot.events) {
                if (snapshot.sources[row.id]?.questionOriginVerified === true) {
                    events.set(row.id, row); sources[row.id] = snapshot.sources[row.id];
                }
            }
            sync.officialSnapshotLoaded = snapshot.sync.officialSnapshotLoaded === true;
            sync.officialSnapshotVersion = snapshot.sync.officialSnapshotVersion;
        }
        sync.status = sync.officialCurrent ? 'official-index-snapshot' : reference || officialEvents ? 'partial' : 'stale';
        snapshot = { events: [...events.values()], seasons: [...seasons.values()], sources, sync };
        try { save({ version: 1, ...snapshot }); }
        catch (error) { snapshot.sync.warnings.push(`元数据缓存保存失败：${error.message}`); }
        nextCheck = now() + (sync.status === 'stale' ? FAILURE_TTL_MS : TTL_MS);
        return snapshot;
    }
    async function get(options = {}) {
        if (!initialized) {
            initialized = true;
            try {
                const persisted = load();
                if (persisted?.version === 1) {
                    snapshot = { events: validateRows(persisted.events, 'events'), seasons: validateRows(persisted.seasons, 'seasons'),
                        sources: persisted.sources || {}, sync: persisted.sync || snapshot.sync };
                    const age = Math.max(0, now() - Number(snapshot.sync.checkedAt || 0));
                    if (age < TTL_MS) nextCheck = now() + TTL_MS - age;
                }
            } catch (error) { snapshot.sync.warnings = [`元数据缓存未读取：${error.message}`]; }
        }
        if (options.refresh === true) nextCheck = 0;
        if (options.checkOnly !== true && now() >= nextCheck && !flight) flight = update().finally(() => { flight = null; });
        if (flight) await flight;
        const out = clone(snapshot);
        out.sync.missingEventIds = (options.requiredIds || []).filter(id => !out.events.some(row => row.id === id));
        out.sync.missingQuestionIds = (options.quizIds || []).filter(id => !out.events.some(row => row.id === id && row.question && row.answer));
        if (out.sync.missingEventIds.length || out.sync.missingQuestionIds.length) {
            out.sync.officialCurrent = false;
            out.sync.status = 'missing-metadata';
        }
        return out;
    }
    return { get };
}
const loader = createSolarConfigLoader();
module.exports = { getSolarConfig: options => loader.get(options), createSolarConfigLoader,
    validateRows, compareVersions, expandUuid, assetLocation, decodeAsset, VERSION_URL, REFERENCE_URL, BASELINE };
