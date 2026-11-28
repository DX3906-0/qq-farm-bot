'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

function moduleHarness() {
    const module = { exports: {} };
    const file = path.join(__dirname, '../src/services/solar-config.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, Buffer, process: { env: {} }, URL, Set, Map, Date, TextDecoder,
        setTimeout, clearTimeout,
        require(name) {
            if (name === 'node:https') return { get: () => { throw new Error('禁止真实网络'); } };
            if (name === 'node:fs') return { existsSync: () => false };
            if (name === 'node:crypto') return { createHash };
            if (name === 'node:util') return { TextDecoder };
            if (name === '../config/runtime-paths') return { getDataFile: name => name };
            if (name === './json-db') return { writeJsonFileAtomic: () => { throw new Error('禁止真实落盘'); } };
            if (name === '../activity-data/solar-calendar.json') return { events: [{ id: 1, name: 'fixture' }], seasons: [{ id: 1, year: '2026' }] };
            throw new Error(`禁止未声明依赖 ${name}`);
        },
    }, { filename: file });
    return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
function fixtures() {
    const api = moduleHarness(); let now = 1000000, version = '1.6.0.5', versionTag = '77b3c', unavailable = false;
    let question = 'fixture question', option = 'A.one;B.two', referenceIds = [403], officialIds = [401], calls = [];
    let persisted = null;
    const encoded = value => Buffer.from(JSON.stringify(value));
    const events = ids => ids.map(id => ({ id, name: `term${id}`, question, answer: option, answer_index: 0 }));
    const asset = (name, rows) => {
        const raw = Buffer.from(JSON.stringify(rows)), key = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE');
        for (let i = 0; i < raw.length; i++) raw[i] ^= key[i % key.length];
        return [1, 0, 0, [['cc.TextAsset', ['_name', 'text'], 1]], [[0, 0, 1, 3]], [[0, name, raw.toString('base64')]]];
    };
    const manifest = { name: 'mainscene', importBase: 'import', uuids: ['e305d396-06b6-4942-8047-15bc73c0fee9', 'e5e33093-f8d2-42b2-8f08-3723ba8a9293'],
        paths: { '0': ['config/SolarTerms', 0, 1], '1': ['config/SolarSeason', 0, 1] }, types: ['cc.TextAsset'], packs: {}, versions: { import: [0, 'f5185', 1, '53d1b'] } };
    const request = async url => {
        calls.push(url);
        if (unavailable) throw new Error('fixture offline');
        if (url.startsWith(api.VERSION_URL)) return encoded([{ version, md5: { mainscene: versionTag } }]);
        if (url === api.REFERENCE_URL) return encoded({ events: events(referenceIds), seasons: [{ id: 4, name: 'quarter' }] });
        if (/\/config\./.test(url)) return encoded(manifest);
        if (url.includes('e305d396')) return encoded(asset('SolarTerms', events(officialIds)));
        if (url.includes('e5e33093')) return encoded(asset('SolarSeason', [{ id: 4, year: '2026', name: 'quarter' }]));
        throw new Error(`fixture unknown ${url}`);
    };
    const loader = api.createSolarConfigLoader({ request, now: () => now, load: () => persisted, save: value => { persisted = value; } });
    return { api, loader, request, calls, advance: ms => { now += ms; }, getNow: () => now, setVersion: v => { version = v; },
        setUnavailable: value => { unavailable = value; }, setQuestion: value => { question = value; }, setReference: ids => { referenceIds = ids; },
        setOfficial: ids => { officialIds = ids; }, stored: () => persisted };
}

test('官方配置UUID与单资产版本按真实manifest解析，不猜URL', () => {
    const api = moduleHarness();
    assert.equal(api.expandUuid('e3BdOWBrZJQoBHFbxzwP7p'), 'e305d396-06b6-4942-8047-15bc73c0fee9');
    assert.equal(api.compareVersions('1.6.0.5', '1.15.1.4'), -1);
    assert.equal(api.compareVersions('1.16.1.6_20261028', '1.15.1.4'), 1);
    assert.equal(api.compareVersions('malformed', '1.15.1.4'), null);
});
test('元数据只有题干/原顺序选项，缺正确索引不补A，重复/空表拒绝', () => {
    const api = moduleHarness();
    const row = api.validateRows([{ id: 403, question: 'question', answer: 'B.two;A.one' }], 'events')[0];
    assert.equal(row.answer_index, null); assert.equal(row.answer, 'B.two;A.one');
    assert.throws(() => api.validateRows([], 'events'));
    assert.throws(() => api.validateRows([{ id: 1 }, { id: 1 }], 'events'));
    assert.throws(() => api.validateRows([{ id: 1, question: 'q', answer: 'A.x;' }], 'events'));
});
test('旧官方version入口不倒退历史快照，来源分别标官方和参考而不冒称最新', async () => {
    const h = fixtures();
    const result = await h.loader.get({ requiredIds: [401, 403], quizIds: [401, 403] });
    assert.equal(result.sync.officialStatus, 'version-index-behind'); assert.equal(result.sync.officialCurrent, false);
    assert.equal(result.sources['401'].questionOriginVerified, true);
    assert.equal(result.sources['401'].answerOriginVerified, false);
    assert.equal(result.sources['403'].questionOriginVerified, false);
    assert.ok(!h.calls.some(url => url.includes('config.undefined')));
    assert.equal(h.stored().version, 1);
});
test('同时读取只单flight，正常缓存不轮询，更新后新ID和新选项自动出现', async () => {
    const h = fixtures();
    const [a, b] = await Promise.all([h.loader.get(), h.loader.get()]);
    assert.deepEqual(plain(a), plain(b));
    const n = h.calls.length; await h.loader.get(); assert.equal(h.calls.length, n);
    h.advance(6 * 3600000 + 1); h.setReference([403, 404]); h.setQuestion('new question');
    const updated = await h.loader.get({ requiredIds: [404], quizIds: [404] });
    assert.equal(updated.events.find(row => row.id === 404).question, 'new question');
    assert.equal(updated.sources['404'].kind, 'upstream-live-reference');
    assert.deepEqual(plain(updated.sync.missingQuestionIds), []);
});
test('全失败保留上一完整快照且标stale，不覆盖官方题目为旧上游答案', async () => {
    const h = fixtures(); await h.loader.get(); h.advance(6 * 3600000 + 1); h.setUnavailable(true);
    const result = await h.loader.get();
    assert.equal(result.sync.status, 'stale'); assert.equal(result.sync.officialCurrent, false);
    assert.equal(result.events.find(row => row.id === 401).question, 'fixture question');
    h.setUnavailable(false); h.advance(10 * 60000 + 1); h.setQuestion('reference changed');
    const next = await h.loader.get();
    assert.equal(next.events.find(row => row.id === 401).question, 'fixture question');
    assert.equal(next.events.find(row => row.id === 403).question, 'reference changed');
});
test('官方升级可刷新题目但未知题目ID标missing，不能把不覆盖当最新', async () => {
    const h = fixtures(); h.setVersion('1.17.0.1'); h.setOfficial([401, 404]);
    const result = await h.loader.get({ quizIds: [404, 999] });
    assert.equal(result.sources['404'].questionOriginVerified, true);
    assert.equal(result.sync.status, 'missing-metadata'); assert.equal(result.sync.officialCurrent, false);
    assert.deepEqual(plain(result.sync.missingQuestionIds), [999]);
});
test('持久缓存重挂载无需重复网络且只恢复元数据，不恢复确认/答题预算', async () => {
    const h = fixtures(); await h.loader.get(); let requests = 0;
    const other = h.api.createSolarConfigLoader({ now: h.getNow, load: h.stored, save: () => {}, request: async () => { requests++; throw new Error('unexpected'); } });
    const value = await other.get(); assert.equal(requests, 0); assert.equal(value.events.length, 3);
    assert.equal(Object.hasOwn(value, 'confirmed'), false);
});
test('清单未含表、未知资源类型、路径重定向和ZIP均显式失败，不猜其它服务', () => {
    const api = moduleHarness();
    assert.throws(() => api.assetLocation({ name: 'mainscene', paths: {}, uuids: [] }, 'mainscene', 'SolarTerms'));
    assert.throws(() => api.assetLocation({ name: 'mainscene', paths: {}, uuids: [], isZip: true }, 'mainscene', 'SolarTerms'));
    assert.throws(() => api.decodeAsset({}, 'SolarTerms', 'cc.TextAsset'));
});
