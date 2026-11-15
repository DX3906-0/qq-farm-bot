'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const protobuf = require('protobufjs');
const priority = require('../src/utils/request-priority');
const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/solartermspb.proto'), { keepCase: true });
root.resolveAll();
const types = {};
for (const method of ['GetSolarTermsV2', 'ClaimSolarTermsV2', 'AnswerSolarTerms', 'ClaimSolarSeason']) {
    for (const suffix of ['Request', 'Reply']) types[method + suffix] = root.lookupType(`gamepb.solartermspb.${method}${suffix}`);
}
const source = fs.readFileSync(path.join(__dirname, '../src/services/solar-calendar.js'), 'utf8');
const configText = fs.readFileSync(path.join(__dirname, '../src/activity-data/solar-calendar.json'), 'utf8');
const NOW = 1794182400;
const QUESTION = '立冬这天，北方很多地方会吃什么？';
const answerInput = { id: 403, expectedQuestion: QUESTION, optionIndex: 0 };
const referenceInput = { id: 403, confirmed: true, acceptReferenceAnswer: true, expectedAccountId: 'test-account',
    expectedQuestion: QUESTION, expectedOptions: ['A.饺子', 'B.粽子', 'C.月饼', 'D.汤圆'],
    expectedStartTime: NOW - 100, expectedEndTime: NOW + 100 };
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function harness() {
    const calls = [];
    const writes = [];
    const config = JSON.parse(configText);
    const event = { id: 403, window_status: 2, open_start_time: NOW - 100, open_end_time: NOW + 100,
        rewards: [{ id: 1002, count: 200 }], question_rewards: [{ id: 1002, count: 100 }] };
    const season = { id: 4, event_ids: [403], lit_count: 1, total_count: 1,
        reward_claimable: true, rewards: [{ id: 1002, count: 10 }] };
    const snapshot = { accountId: 'test-account', connectionEpoch: 7, remoteGeneration: 42,
        loggedIn: true, connected: true, detached: false };
    const user = { gid: 123 };
    const h = { config, event, season, snapshot, user, calls, writes, onRead: null, onWrite: null };
    const network = {
        getDiagnosticSnapshot: () => ({ ...snapshot }),
        getUserState: () => user,
        sendMsgAsync: async (service, method, bytes, meta) => {
            assert.equal(service, 'gamepb.solartermspb.SolarTermsV2Service');
            assert.equal(meta.timeoutMs, 30000);
            assert.ok(['foreground', 'background'].includes(priority.getRequestContext().priority));
            assert.ok(Number.isFinite(priority.getRequestContext().deadline));
            const request = types[`${method}Request`].toObject(types[`${method}Request`].decode(bytes), { longs: Number });
            calls.push({ method, request });
            let reply;
            if (method === 'GetSolarTermsV2') {
                const replacement = h.onRead ? await h.onRead(calls.filter(value => value.method === method).length) : undefined;
                if (Buffer.isBuffer(replacement)) return { body: replacement };
                reply = replacement === undefined ? { server_time: NOW, default_event_id: 403, events: [clone(event)], seasons: [clone(season)] } : replacement;
            } else {
                writes.push({ method, request });
                const replacement = h.onWrite ? await h.onWrite(method, request) : undefined;
                if (Buffer.isBuffer(replacement)) return { body: replacement };
                if (replacement !== undefined) reply = replacement;
                else if (method === 'ClaimSolarTermsV2') {
                    event.direct_claimed = true;
                    reply = { updated_event: clone(event), rewards: clone(event.rewards) };
                } else if (method === 'AnswerSolarTerms') {
                    const correct = request.option_index === 0;
                    event.quiz_claimed = correct;
                    event.quiz_wrong_today = !correct;
                    if (!correct) event.wrong_options = [request.option_index];
                    reply = { correct, updated_event: clone(event), rewards: correct ? clone(event.question_rewards) : [] };
                } else {
                    season.reward_claimed = true;
                    reply = { updated_season: clone(season), rewards: clone(season.rewards) };
                }
            }
            return { resultState: 'completed', body: types[`${method}Reply`].encode(types[`${method}Reply`].fromObject(reply)).finish() };
        },
    };
    // Execute the real durable command scope with in-memory disk I/O. A mock
    // scope would miss post-write cancellation and falsely confirm mutations.
    const ledgers = new Map();
    const commandModule = { exports: {} };
    const commandFile = path.join(__dirname, '../src/services/game-command.js');
    vm.runInNewContext(fs.readFileSync(commandFile, 'utf8'), { module: commandModule, Buffer, Uint8Array, Date, BigInt,
        require(name) {
            if (name === '../utils/network') return network;
            if (name === '../utils/proto') return { types };
            if (name === '../utils/request-priority') return priority;
            if (name === '../config/runtime-paths') return { getDataFile: filename => filename };
            if (name === './json-db') return { writeJsonFileAtomic: (filename, data) => ledgers.set(filename, clone(data)) };
            if (name === 'node:fs') return { existsSync: filename => ledgers.has(filename), readFileSync: filename => JSON.stringify(ledgers.get(filename)) };
            return require(name);
        },
    }, { filename: commandFile });
    const module = { exports: {} };
    const mocks = {
        '../activity-data/solar-calendar.json': config,
        '../utils/network': network,
        '../utils/proto': { types: { ...types } },
        '../utils/request-priority': priority,
        './game-command': commandModule.exports,
        './solar-config': { getSolarConfig: async () => ({ ...config, sources: {}, sync: { status: 'fixture', officialCurrent: false } }) },
        'node:crypto': { createHash },
        '../config/gameConfig': { getItemById: () => ({ name: '点券' }), getItemImageById: () => '' },
    };
    vm.runInNewContext(source, { module, require: name => {
        assert.ok(Object.hasOwn(mocks, name), `禁止加载非白名单模块：${name}`);
        return mocks[name];
    }, Buffer, Date, Set, Object, Number, String }, { filename: 'solar-calendar.js' });
    h.service = module.exports;
    h.proto = mocks['../utils/proto'].types;
    return h;
}
const isUnknown = cause => cause.resultState === 'unknown' && cause.retryable === false
    && cause.sent === true && cause.refreshRequired === true && /只刷新/.test(cause.message);

test('配置与固定 SHA 上游内容完全相同，来源元数据单独保留', () => {
    const config = JSON.parse(configText);
    assert.equal(createHash('sha256').update(JSON.stringify(config)).digest('hex'), '86d83751274a5c8143c888a04743952589d8cfa4edf70f441f4e011bb921d88e');
    assert.equal(config.events.length, 14);
    assert.equal(config.seasons.length, 3);
    assert.equal(harness().service.configSources.commit, 'a459b0ab787c75ab7cfe8cd16899dbd1f6d7fca7');
});
test('真实 protobuf 回包富化并按服务器窗口判定，不发写入', async () => {
    const h = harness();
    const calendar = await h.service.getSolarCalendar({ accountId: 'test-account' });
    assert.equal(calendar.accountId, 'test-account');
    assert.equal(calendar.serverTime, NOW);
    assert.equal(calendar.events[0].name, '立冬');
    assert.equal(calendar.events[0].question, QUESTION);
    assert.equal(calendar.events[0].answerIndex, 0);
    assert.equal(calendar.events[0].answerSource.commit, h.service.configSources.commit);
    assert.equal(calendar.events[0].canClaim, true);
    assert.equal(calendar.events[0].canAnswer, true);
    assert.equal(calendar.seasons[0].canClaim, true);
    assert.equal(calendar.events[0].rewards[0].count, 200);
    assert.equal(h.writes.length, 0);
});
test('配置缺少或无效答案索引时不猜答案，未知节令不补造题目', async () => {
    const h = harness();
    const entry = h.config.events.find(value => value.id === 403);
    for (const index of [undefined, null, -1, 4, 0.5, '0', false]) {
        entry.answer_index = index;
        const event = (await h.service.getSolarCalendar()).events[0];
        assert.equal(event.answerIndex, null);
        assert.equal(event.answerSource, null);
        assert.equal(event.canAnswer, true);
    }
    h.event.id = 999;
    const unknownEvent = (await h.service.getSolarCalendar()).events[0];
    assert.equal(unknownEvent.question, '');
    assert.equal(unknownEvent.canAnswer, false);
    assert.equal(unknownEvent.canClaim, true);
});
test('空、坏、缺失、零及不安全 server_time 回包全部拒绝', async () => {
    for (const response of [Buffer.alloc(0), Buffer.from([0x80]), {}, { server_time: 0 }, { server_time: -1 }, { server_time: '9007199254740993' }]) {
        const h = harness();
        h.onRead = () => response;
        await assert.rejects(h.service.getSolarCalendar());
        await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }));
        assert.equal(h.writes.length, 0);
    }
});
test('固定服务器时间样本没有事件时不使用配置合成事件或可领季度', async () => {
    const h = harness();
    // 0x10 为 field 2/server_time；只解析固定只读样本，绝不读取游戏数据。
    const writer = protobuf.Writer.create().uint32(0x10).int64(NOW);
    h.onRead = () => Buffer.from(writer.finish());
    const calendar = await h.service.getSolarCalendar();
    assert.equal(calendar.serverTime, NOW);
    assert.equal(calendar.events.length, 0);
    assert.equal(calendar.seasons.length, 0);
    await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }));
    assert.equal(h.writes.length, 0);
});
test('只有具体有效事件窗口与状态 2 可操作，闭区间边界正确', async () => {
    for (const patch of [
        { window_status: 0 }, { window_status: 1 }, { window_status: 3 }, { window_status: undefined },
        { open_start_time: undefined }, { open_end_time: undefined }, { open_start_time: 0 },
        { open_start_time: NOW + 1 }, { open_end_time: NOW - 1 }, { open_start_time: NOW + 3, open_end_time: NOW + 2 },
    ]) {
        const h = harness(); Object.assign(h.event, patch);
        const event = (await h.service.getSolarCalendar()).events[0];
        assert.equal(event.canClaim, false);
        assert.equal(event.canAnswer, false);
        await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }));
        assert.equal(h.writes.length, 0);
    }
    for (const boundary of ['open_start_time', 'open_end_time']) {
        const h = harness(); h.event[boundary] = NOW;
        assert.equal((await h.service.getSolarCalendar()).events[0].canClaim, true);
    }
});
test('事件或季度缺失、重复、无效编号不被接受', async () => {
    for (const values of [
        { events: [{}] }, { events: [{ id: 403 }, { id: 403 }] }, { events: [{ id: -1 }] },
        { seasons: [{}] }, { seasons: [{ id: 4 }, { id: 4 }] },
    ]) {
        const h = harness();
        h.onRead = () => ({ server_time: NOW, ...values });
        await assert.rejects(h.service.getSolarCalendar());
    }
});
test('fresh 读取验证 ID、有效答案、期望题目及今日答题限制', async () => {
    const h = harness();
    for (const id of [0, -1, 0.5, '403', null, false, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(h.service.operateSolarCalendar('claim', { id }));
    }
    for (const optionIndex of [null, false, '0', -1, 4, 0.5]) {
        await assert.rejects(h.service.operateSolarCalendar('answer', { ...answerInput, optionIndex }));
    }
    await assert.rejects(h.service.operateSolarCalendar('answer', { ...answerInput, expectedQuestion: '旧题目' }), /题目已变化/);
    h.event.wrong_options = [0];
    await assert.rejects(h.service.operateSolarCalendar('answer', answerInput), /有效答案/);
    h.event.wrong_options = [];
    h.event.quiz_wrong_today = true;
    await assert.rejects(h.service.operateSolarCalendar('answer', answerInput));
    h.event.quiz_wrong_today = false;
    h.event.quiz_claimed = true;
    await assert.rejects(h.service.operateSolarCalendar('answer', answerInput));
    assert.equal(h.writes.length, 0);
});
test('fresh 进度变化时不使用页面旧可领状态或配置旧题目', async () => {
    const h = harness();
    await h.service.getSolarCalendar();
    h.event.direct_claimed = true;
    await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }));
    h.config.events.find(value => value.id === 403).question = '配置题目已更新';
    await assert.rejects(h.service.operateSolarCalendar('answer', answerInput), /题目已变化/);
    assert.equal(h.writes.length, 0);
});
test('正确或错误答案均以具体 updated_event 确认，只写一次', async () => {
    for (const optionIndex of [0, 1]) {
        const h = harness();
        const result = await h.service.operateSolarCalendar('answer', { ...answerInput, optionIndex });
        assert.equal(result.correct, optionIndex === 0);
        assert.equal(result.resultState, 'completed');
        assert.equal(result.retryable, false);
        assert.deepEqual(h.writes, [{ method: 'AnswerSolarTerms', request: { id: 403, option_index: optionIndex } }]);
        await assert.rejects(h.service.operateSolarCalendar('answer', answerInput));
        assert.equal(h.writes.length, 1);
    }
});
test('季度领奖只认真实服务端标志、具体关联事件、未领状态及奖励', async () => {
    for (const patch of [{ rewards: [] }, { reward_claimable: false }, { reward_claimed: true },
        { event_ids: [] }, { event_ids: [999] }, { event_ids: [403, 403] }]) {
        const h = harness(); Object.assign(h.season, patch);
        await assert.rejects(h.service.operateSolarCalendar('season', { id: 4 }));
        assert.equal(h.writes.length, 0);
    }
    const h = harness();
    const result = await h.service.operateSolarCalendar('season', { id: 4 });
    assert.equal(result.rewards[0].count, 10);
    assert.deepEqual(h.writes, [{ method: 'ClaimSolarSeason', request: { id: 4 } }]);
    await assert.rejects(h.service.operateSolarCalendar('season', { id: 4 }));
});
test('空、错误编号、未确认状态的写回包均 unknown，不虚构成功、不重发', async () => {
    for (const [action, input, replies] of [
        ['claim', { id: 403 }, [Buffer.alloc(0), Buffer.from([0x80]), {}, { updated_event: { id: 999, direct_claimed: true } }, { updated_event: { id: 403 } }]],
        ['answer', answerInput, [{ updated_event: { id: 403 } }, { correct: true, updated_event: { id: 403, quiz_wrong_today: true } }]],
        ['season', { id: 4 }, [{ updated_season: { id: 4 } }, { updated_season: { id: 9, reward_claimed: true } }]],
    ]) {
        for (const reply of replies) {
            const h = harness(); h.onWrite = () => reply;
            await assert.rejects(h.service.operateSolarCalendar(action, input), isUnknown);
            await assert.rejects(h.service.operateSolarCalendar(action, input), isUnknown);
            assert.equal(h.writes.length, 1);
            const state = await h.service.getSolarCalendar();
            assert.equal(action === 'season' ? state.seasons[0].canClaim
                : action === 'answer' ? state.events[0].canAnswer : state.events[0].canClaim, false);
        }
    }
});
test('发送后超时/取消/未知错误强制 unknown retryable=false，刷新不解除重提封锁', async () => {
    for (const details of [
        { sent: true, resultState: 'unknown', errorCode: 'REQUEST_TIMEOUT' },
        { sent: true, resultState: 'failed', errorCode: 'REQUEST_TIMEOUT' },
        { sent: true, resultState: 'unknown', errorCode: 'REQUEST_CANCELLED' },
        {},
    ]) {
        const h = harness(); h.onWrite = () => { throw Object.assign(new Error('请求超时'), details); };
        await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }), isUnknown);
        const state = await h.service.getSolarCalendar();
        assert.equal(state.events[0].claimResultUnknown, true);
        await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }), isUnknown);
        assert.equal(h.writes.length, 1);
    }
});
test('明确未发送及服务端明确拒绝不伪造成功，也不自动重试', async () => {
    for (const details of [{ sent: false, resultState: 'not_sent' }, { sent: true, resultState: 'failed', errorCode: 'REMOTE_ERROR' }]) {
        const h = harness(); h.onWrite = () => { throw Object.assign(new Error('明确拒绝'), details); };
        await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }), cause => cause.resultState === details.resultState && cause.retryable === false);
        assert.equal(h.writes.length, 1);
    }
});
test('领取已确认但随后刷新失败保留真实奖励并要求刷新，不额外写入', async () => {
    const h = harness();
    h.onRead = () => { if (h.writes.length) throw new Error('只读刷新失败'); };
    const result = await h.service.operateSolarCalendar('claim', { id: 403 });
    assert.equal(result.resultState, 'completed');
    assert.equal(result.rewards[0].count, 200);
    assert.equal(result.calendar, null);
    assert.equal(result.refreshRequired, true);
    assert.equal(h.writes.length, 1);
});
test('账号上下文不一致或未登录，在读取/写入前直接拒绝', async () => {
    const h = harness();
    await assert.rejects(h.service.getSolarCalendar({ accountId: 'other' }), /不一致/);
    await assert.rejects(priority.runWithRequestContext({ accountId: 'other' }, () => h.service.operateSolarCalendar('claim', { id: 403 })), /不一致/);
    h.snapshot.loggedIn = false;
    await assert.rejects(h.service.getSolarCalendar(), /未连接或未登录/);
    assert.equal(h.calls.length, 0);
});
test('读回包时账号、gid 或连接代际切换会失效，不发送写入', async () => {
    for (const change of [h => { h.snapshot.accountId = 'new'; }, h => { h.snapshot.connectionEpoch++; },
        h => { h.snapshot.remoteGeneration++; }, h => { h.user.gid++; }]) {
        const h = harness(); h.onRead = () => { change(h); };
        await assert.rejects(h.service.getSolarCalendar(), /已切换/);
        const next = harness(); next.onRead = () => { change(next); };
        await assert.rejects(next.service.operateSolarCalendar('claim', { id: 403 }), /已切换/);
        assert.equal(next.writes.length, 0);
    }
});
test('写回包或后续读回包时账号切换，旧结果不交付新账号', async () => {
    const h = harness();
    h.onWrite = () => { h.snapshot.accountId = 'new'; };
    await assert.rejects(h.service.operateSolarCalendar('claim', { id: 403 }), isUnknown);
    assert.equal(h.writes.length, 1);
    const next = harness();
    next.onRead = () => { if (next.writes.length) next.snapshot.connectionEpoch++; };
    await assert.rejects(next.service.operateSolarCalendar('claim', { id: 403 }), isUnknown);
    assert.equal(next.writes.length, 1);
});
test('串行 fresh 校验消除重复领奖，调用入参在排队前冻结', async () => {
    const h = harness();
    const input = { id: 403 };
    const first = h.service.operateSolarCalendar('claim', input);
    input.id = 999;
    const second = h.service.operateSolarCalendar('claim', { id: 403 });
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map(value => value.status), ['fulfilled', 'rejected']);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].request.id, 403);
});
test('有界串行队列拒绝超容量，取消排队请求不会启动 fresh 读或写', async () => {
    const h = harness();
    const started = deferred(); const release = deferred();
    h.onRead = async count => { if (count === 1) { started.resolve(); await release.promise; } };
    const first = h.service.operateSolarCalendar('claim', { id: 403 });
    await started.promise;
    const controller = new AbortController();
    const waiting = h.service.operateSolarCalendar('claim', { id: 403 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, cause => cause.errorCode === 'REQUEST_CANCELLED' && cause.resultState === 'not_sent');
    const jobs = Array.from({ length: 12 }, () => h.service.operateSolarCalendar('claim', { id: 403 }));
    const all = Promise.allSettled(jobs);
    release.resolve();
    await first;
    const results = await all;
    assert.ok(results.some(value => value.status === 'rejected' && value.reason.errorCode === 'QUEUE_FULL'));
    assert.equal(h.writes.length, 1);
});
test('排队期间账号切换或 deadline 已到不会发送新请求', async () => {
    const h = harness();
    await assert.rejects(h.service.getSolarCalendar({ deadline: Date.now() - 1 }), cause => cause.errorCode === 'REQUEST_DEADLINE');
    const started = deferred(); const release = deferred();
    h.onRead = async count => { if (count === 1) { started.resolve(); await release.promise; } };
    const first = h.service.operateSolarCalendar('claim', { id: 403 });
    const firstRejected = assert.rejects(first, /已切换/);
    await started.promise;
    const waiting = h.service.operateSolarCalendar('claim', { id: 403 });
    const waitingRejected = assert.rejects(waiting, /已切换/);
    h.snapshot.connectionEpoch++;
    release.resolve();
    await Promise.all([firstRejected, waitingRejected]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.writes.length, 0);
});
test('fresh 读取期间取消不写入；发送写入后取消则 unknown 并禁止重提', async () => {
    const before = harness();
    const beforeController = new AbortController();
    before.onRead = () => { beforeController.abort(); };
    await assert.rejects(before.service.operateSolarCalendar('claim', { id: 403 }, { signal: beforeController.signal }),
        cause => cause.errorCode === 'REQUEST_CANCELLED' && cause.resultState === 'not_sent');
    assert.equal(before.writes.length, 0);
    const after = harness();
    const afterController = new AbortController();
    after.onWrite = () => { afterController.abort(); };
    await assert.rejects(after.service.operateSolarCalendar('claim', { id: 403 }, { signal: afterController.signal }), isUnknown);
    await assert.rejects(after.service.operateSolarCalendar('claim', { id: 403 }), isUnknown);
    assert.equal(after.writes.length, 1);
});
test('V2自动只领基础小礼一次，校验实际奖励，决不自动答题/季度领奖', async () => {
    const h = harness();
    const result = await h.service.autoClaimSolarGifts();
    assert.equal(result.count, 1); assert.deepEqual(clone(result.handledIds), [403]);
    assert.equal(result.results[0].name, '立冬');
    assert.deepEqual(h.writes.map(call => call.method), ['ClaimSolarTermsV2']);
    await h.service.autoClaimSolarGifts();
    assert.equal(h.writes.length, 1, '已领状态不能自动二次提交');
});
test('新版已领/未开放/过期/空奖励不自动提交，持有server time不代表开放', async () => {
    for (const patch of [{ direct_claimed: true }, { window_status: 1 }, { open_end_time: NOW - 1 }, { rewards: [] }]) {
        const h = harness(); Object.assign(h.event, patch);
        assert.equal((await h.service.autoClaimSolarGifts()).count, 0);
        assert.equal(h.writes.length, 0);
    }
});
test('新版自动unknown保留单次记录，下轮不得再次发送该事件', async () => {
    const h = harness();
    h.onWrite = () => Buffer.alloc(0);
    await assert.rejects(h.service.autoClaimSolarGifts(), isUnknown);
    await h.service.autoClaimSolarGifts();
    assert.equal(h.writes.length, 1);
});

test('单次答题答错后即使服务端次日复位仍不重发，自动答案不可信时跳过', async () => {
    const h = harness();
    await h.service.operateSolarCalendar('answer', { ...answerInput, optionIndex: 1 });
    h.event.quiz_wrong_today = false; h.event.wrong_options = [];
    const data = await h.service.getSolarCalendar();
    assert.equal(data.events[0].canAnswer, false);
    assert.equal(data.events[0].answerCompletedLocally, true);
    await assert.rejects(h.service.operateSolarCalendar('answer', answerInput));
    assert.equal(h.writes.length, 1);
    const unknown = harness();
    assert.equal((await unknown.service.autoAnswerSolarQuizzes()).reason, 'no_independently_verified_answer');
    assert.equal(unknown.writes.length, 0);
    assert.equal(unknown.service.configSources.answerOriginVerified, false);
});

test('用户明确单次确认仅放行当前账号当前题自动选答，不篡改官方来源或后台开关', async () => {
    const h = harness(); h.event.direct_claimed = true;
    const result = await h.service.operateSolarCalendar('auto-answer', referenceInput);
    assert.equal(result.accountId, 'test-account'); assert.equal(result.count, 1);
    assert.equal(result.results[0].correct, true); assert.equal(result.results[0].optionIndex, 0);
    assert.equal(result.results[0].selectedOption, 'A.饺子');
    assert.equal(result.results[0].answerProvenance, 'user-confirmed-upstream-reference-once');
    assert.equal(result.results[0].answerOriginVerified, false); assert.equal(h.service.configSources.answerOriginVerified, false);
    assert.deepEqual(h.writes, [{ method: 'AnswerSolarTerms', request: { id: 403, option_index: 0 } }]);
    assert.equal(result.results[0].calendar.events[0].directClaimed, true);
    assert.equal(result.results[0].calendar.events[0].quizClaimed, true);
    assert.equal(result.results[0].calendar.events[0].answerCompletedLocally, true);
    assert.equal((await h.service.operateSolarCalendar('auto-answer', referenceInput)).skipped, true);
    assert.equal(h.writes.length, 1, '单次路径再次调用也不能重发');
    const other = harness();
    assert.equal((await other.service.autoAnswerSolarQuizzes()).reason, 'no_independently_verified_answer');
    assert.equal(other.writes.length, 0, '此次批准不能污染另一个账号或后台调用');
});
test('参考答案授权必须有完整确认/正确账号/题干/选项/窗口，失配一律零写入', async () => {
    for (const patch of [{ confirmed: false }, { expectedAccountId: '10' }, { expectedAccountId: '' },
        { id: 402 }, { id: '403' }, { expectedQuestion: '旧题' }, { expectedOptions: undefined },
        { expectedOptions: ['B.粽子', 'A.饺子', 'C.月饼', 'D.汤圆'] },
        { expectedStartTime: NOW }, { expectedEndTime: NOW + 1 }]) {
        const h = harness();
        await assert.rejects(h.service.operateSolarCalendar('auto-answer', { ...referenceInput, ...patch }),
            cause => cause.errorCode === 'SOLAR_REFERENCE_APPROVAL_INVALID');
        assert.equal(h.writes.length, 0);
    }
});
test('单次自动选答fresh选项/窗口变化或账号切换不写入，未知回包不得重复', async () => {
    for (const change of [h => { h.config.events.find(e => e.id === 403).answer = 'B.粽子;A.饺子;C.月饼;D.汤圆'; },
        h => { h.event.open_end_time--; }, h => { h.snapshot.accountId = 'other'; }]) {
        const h = harness(); h.onRead = count => { if (count === 2) change(h); };
        await assert.rejects(h.service.operateSolarCalendar('auto-answer', referenceInput));
        assert.equal(h.writes.length, 0);
    }
    const h = harness(); h.onWrite = () => Buffer.alloc(0);
    await assert.rejects(h.service.operateSolarCalendar('auto-answer', referenceInput), isUnknown);
    assert.equal((await h.service.operateSolarCalendar('auto-answer', referenceInput)).skipped, true);
    assert.equal(h.writes.length, 1);
});
test('单次自动选答答错只确认一次，不换索引重试，也不扣回已领基础礼', async () => {
    const h = harness(); h.event.direct_claimed = true;
    h.onWrite = () => { h.event.quiz_wrong_today = true; return { correct: false, rewards: [], updated_event: clone(h.event) }; };
    const result = await h.service.operateSolarCalendar('auto-answer', referenceInput);
    assert.equal(result.results[0].correct, false); assert.equal(result.results[0].rewards.length, 0);
    assert.equal(result.results[0].calendar.events[0].directClaimed, true);
    h.event.quiz_wrong_today = false;
    await h.service.operateSolarCalendar('auto-answer', referenceInput);
    assert.equal(h.writes.length, 1);
});

test('协议未加载时在发送前拒绝，不尝试其他服务名或探测', async () => {
    const h = harness(); delete h.proto.GetSolarTermsV2Request;
    await assert.rejects(h.service.getSolarCalendar(), /协议未加载/);
    assert.equal(h.calls.length, 0);
});
test('节令题目读取接口返回原顺序选项/来源/窗口，零答题与领取写入', async () => {
    const h = harness();
    const result = await h.service.getSolarQuestion(403);
    assert.equal(result.question, QUESTION);
    assert.deepEqual(clone(result.options), ['A.饺子', 'B.粽子', 'C.月饼', 'D.汤圆']);
    assert.equal(result.questionStatus, 'available');
    assert.match(result.questionRevision, /^[a-f\d]{64}$/);
    assert.equal(result.source.answerOriginVerified, false);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.calls.map(call => call.method), ['GetSolarTermsV2']);
});
test('节令新增未知ID仍返回真实窗口和奖励，题目未取得而非无答题，禁止自动写入', async () => {
    const h = harness(); h.event.id = 999;
    const result = await h.service.getSolarQuestion(999);
    assert.equal(result.question, null); assert.deepEqual(clone(result.options), []);
    assert.equal(result.questionStatus, 'metadata_missing'); assert.equal(result.canAnswer, false);
    assert.equal(result.startTime, NOW - 100); assert.equal(result.rewards.length, 1);
    assert.equal(h.writes.length, 0);
});
test('题目版本/选项和窗口的旧确认零写入，不默认补0或自动重新选答', async () => {
    const h = harness();
    await assert.rejects(h.service.operateSolarCalendar('answer', { ...answerInput, expectedQuestionRevision: 'stale' }), /版本已变化/);
    assert.equal(h.writes.length, 0);
});

test('本地 Vue 页面只使用现有按钮与确认框，无 NaiveUI/自动答题/写入重试', () => {
    const vue = fs.readFileSync(path.join(__dirname, '../../web/src/views/SolarCalendar.vue'), 'utf8');
    assert.match(vue, /BaseButton/);
    assert.match(vue, /ConfirmModal/);
    assert.doesNotMatch(vue, /naive-ui|NButton|NModal/);
    assert.match(vue, /expectedQuestion: operation.expectedQuestion/);
    assert.match(vue, /controller\?\.abort\(\)/);
    assert.match(vue, /revision !== sequence \|\| accountId !== currentAccountId.value/);
    assert.match(vue, /结果不确定时只能刷新，不能重提/);
    assert.equal((vue.match(/api\.post\(/g) || []).length, 2, 'V2与展开的V1兼容领奖各有单一写路径，不试其它服务');
    assert.match(vue, /overlappingLegacyIds\.value\.has\(term.id\)/);
    assert.match(vue, /defineExpose\(\{ refresh \}\)/);
    assert.match(vue, /status\.value\?\.connection\?\.connected === true/);
    assert.match(vue, /const showAnswerHint = ref\(false\)/);
});
