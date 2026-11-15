'use strict';

const config = require('../activity-data/solar-calendar.json');
const { getSolarConfig } = require('./solar-config');
const { createHash } = require('node:crypto');
const network = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { createGameCommandScope } = require('./game-command');
const { createRequestGate, getRequestContext, runWithRequestContext, throwIfRequestCancelled, requestError } = require('../utils/request-priority');

const SERVICE = 'gamepb.solartermspb.SolarTermsV2Service';
const configSources = Object.freeze({
    repository: 'liyangpengs/qq-farm-bot',
    commit: 'a459b0ab787c75ab7cfe8cd16899dbd1f6d7fca7',
    config: 'core/src/activity-data/solar-calendar.json',
    service: 'core/src/services/solar-calendar.ts',
    view: 'web/src/views/SolarCalendar.vue',
    proto: 'core/src/proto/solartermspb.proto',
    answerOriginVerified: false,
    answerProvenance: 'fixed-upstream-config-not-independently-verified',
});
const operationGate = createRequestGate({ maxActive: 1, maxQueued: 8 });
const mutationScope = createGameCommandScope('solar-v2');
const uncertain = new Set();
const has = (value, key) => value != null && Object.hasOwn(value, key);
const num = value => value == null ? NaN : Number(value);
const positive = value => Number.isSafeInteger(num(value)) && num(value) > 0;

function failure(message, errorCode = 'SOLAR_VALIDATION', details = {}) {
    return requestError(message, { errorCode, retryable: false, ...details });
}
function unknown(cause) {
    return failure('操作结果不确定，请只刷新确认进度，勿重复提交', 'SOLAR_RESULT_UNKNOWN', {
        sent: true, resultState: 'unknown', outcomeUnknown: true, refreshRequired: true,
        causeCode: cause?.errorCode || cause?.code || '',
    });
}
function captureContext(options = {}) {
    const context = { ...getRequestContext(), ...options };
    context.deadline = Math.min(Date.now() + 30000, Number.isFinite(context.deadline) ? context.deadline : Infinity);
    context.priority = options.priority === 'background' ? 'background' : 'foreground';
    throwIfRequestCancelled(context);
    const snapshot = network.getDiagnosticSnapshot();
    if (!snapshot.accountId || !snapshot.loggedIn || !snapshot.connected || snapshot.detached
        || !positive(network.getUserState().gid)) throw failure('当前账号未连接或未登录', 'SOLAR_ACCOUNT_UNAVAILABLE');
    if (context.accountId != null && String(context.accountId) !== String(snapshot.accountId)) {
        throw failure('请求账号与当前连接不一致', 'SOLAR_ACCOUNT_CHANGED');
    }
    return { context, accountId: String(snapshot.accountId), epoch: snapshot.connectionEpoch,
        generation: snapshot.remoteGeneration, gid: String(network.getUserState().gid) };
}
function validateContext(session) {
    throwIfRequestCancelled(session.context);
    const snapshot = network.getDiagnosticSnapshot();
    if (String(snapshot.accountId) !== session.accountId || snapshot.connectionEpoch !== session.epoch
        || snapshot.remoteGeneration !== session.generation || !snapshot.loggedIn || !snapshot.connected
        || snapshot.detached || String(network.getUserState().gid) !== session.gid) {
        throw failure('账号或连接已切换，本次响应已失效', 'SOLAR_ACCOUNT_CHANGED');
    }
}
function rewards(values = []) {
    return values.filter(item => positive(item.id) && positive(item.count)).map(item => ({
        id: num(item.id), count: num(item.count), name: getItemById(num(item.id))?.name || `物品${num(item.id)}`,
        image: getItemImageById(num(item.id)) || '',
    }));
}
function eventDto(value, serverTime, metadata = { ...config, sources: {} }) {
    const id = num(value.id);
    const entry = metadata.events.find(item => item.id === id);
    const source = metadata.sources?.[id] || configSources;
    const startTime = num(value.open_start_time);
    const endTime = num(value.open_end_time);
    const completeWindow = has(value, 'window_status') && has(value, 'open_start_time') && has(value, 'open_end_time')
        && positive(startTime) && positive(endTime) && endTime >= startTime;
    const open = positive(serverTime) && positive(id) && completeWindow && num(value.window_status) === 2
        && serverTime >= startTime && serverTime <= endTime;
    const options = typeof entry?.answer === 'string' ? entry.answer.split(';') : [];
    const question = typeof entry?.question === 'string' ? entry.question : '';
    const answerIndex = question && Number.isInteger(entry?.answer_index) && entry.answer_index >= 0
        && entry.answer_index < options.length ? entry.answer_index : null;
    let rules = [];
    try {
        const texts = JSON.parse(entry?.help || '{}').tips?.txt;
        if (Array.isArray(texts)) rules = texts.filter(text => typeof text === 'string')
            .map(text => text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
    } catch { /* 无有效配置文本时不补造说明。 */ }
    return {
        id, name: entry?.name || `节令 ${id}`, description: entry?.description || '',
        startTime: positive(startTime) ? startTime : 0, endTime: positive(endTime) ? endTime : 0,
        status: has(value, 'window_status') ? num(value.window_status) : 0, open,
        directClaimed: value.direct_claimed === true, quizClaimed: value.quiz_claimed === true,
        quizWrongToday: value.quiz_wrong_today === true, wrongOptions: (value.wrong_options || []).map(num),
        question, options, answerIndex, answerSource: answerIndex === null ? null : source,
        questionSource: question ? source : null,
        questionStatus: question && options.length > 0 ? 'available' : rewards(value.question_rewards).length > 0 ? 'metadata_missing' : 'no_quiz',
        questionRevision: question ? createHash('sha256').update(JSON.stringify([id, question, options, startTime, endTime])).digest('hex') : null,
        errorTips: entry?.error_tips || '', rules, rewards: rewards(value.rewards), questionRewards: rewards(value.question_rewards),
        canClaim: open && value.direct_claimed !== true,
        quizAvailable: open && rewards(value.question_rewards).length > 0 && value.quiz_claimed !== true && value.quiz_wrong_today !== true,
        canAnswer: open && !!question && options.length > 0 && value.quiz_claimed !== true && value.quiz_wrong_today !== true,
    };
}
function calendarDto(reply, metadata = { ...config, sources: {} }) {
    if (!has(reply, 'server_time') || !positive(reply.server_time)) throw failure('节令日历回包缺少有效服务器时间', 'SOLAR_INCOMPLETE_REPLY');
    const serverTime = num(reply.server_time);
    const rawEvents = reply.events || [];
    if (rawEvents.some(value => !has(value, 'id') || !positive(value.id))
        || new Set(rawEvents.map(value => num(value.id))).size !== rawEvents.length) {
        throw failure('节令日历事件编号无效或重复', 'SOLAR_INCOMPLETE_REPLY');
    }
    const events = rawEvents.map(value => eventDto(value, serverTime, metadata));
    const rawSeasons = reply.seasons || [];
    if (rawSeasons.some(value => !has(value, 'id') || !positive(value.id))
        || new Set(rawSeasons.map(value => num(value.id))).size !== rawSeasons.length) {
        throw failure('节令日历季度编号无效或重复', 'SOLAR_INCOMPLETE_REPLY');
    }
    return { serverTime, defaultEventId: positive(reply.default_event_id) ? num(reply.default_event_id) : 0, events,
        seasons: rawSeasons.map(value => {
            const id = num(value.id);
            const entry = metadata.seasons.find(item => item.id === id);
            const eventIds = (value.event_ids || []).map(num);
            const items = rewards(value.rewards);
            // 季度奖励不使用本地日期；只认同回包的具体节令及服务端可领标志。
            const complete = eventIds.length > 0 && new Set(eventIds).size === eventIds.length
                && eventIds.every(eventId => positive(eventId) && events.some(event => event.id === eventId && event.startTime > 0 && event.endTime >= event.startTime));
            return { id, name: entry?.name || `季度 ${id}`, year: entry?.year || '', description: entry?.description || '',
                eventIds, litCount: Number.isSafeInteger(num(value.lit_count)) ? num(value.lit_count) : 0,
                totalCount: Number.isSafeInteger(num(value.total_count)) ? num(value.total_count) : 0,
                claimed: value.reward_claimed === true, rewards: items,
                canClaim: complete && value.reward_claimable === true && value.reward_claimed !== true && items.length > 0 };
        }), configSources, metadataSync: metadata.sync || null };
}
async function rpc(method, input, session, mutation = false) {
    validateContext(session);
    const request = types[`${method}Request`];
    const replyType = types[`${method}Reply`];
    if (!request || !replyType) throw failure(`节令协议未加载：${method}`, 'SOLAR_PROTO_UNAVAILABLE');
    if (mutation) return mutationScope.rpc(session, SERVICE, method, `${method}Request`, `${method}Reply`, input,
        { write: true, key: `${method}:${input.id}`, timeoutMs: 30000 });
    const body = request.encode(request.fromObject(input)).finish();
    const response = await runWithRequestContext(session.context, () => network.sendMsgAsync(SERVICE, method, body, { timeoutMs: 30000, priority: session.context.priority }));
    validateContext(session);
    if ((response?.resultState && response.resultState !== 'completed') || !response?.body || response.body.length === 0) {
        throw failure('节令回包为空或未确认', 'SOLAR_INCOMPLETE_REPLY');
    }
    return replyType.decode(response.body);
}
async function readCalendar(session) {
    // Refresh static metadata alongside the existing read, not after its full
    // deadline. This is not a second game request or a hidden quiz submission.
    const [reply, initialMetadata] = await Promise.all([rpc('GetSolarTermsV2', {}, session), getSolarConfig()]);
    validateContext(session);
    const metadata = await getSolarConfig({ requiredIds: (reply.events || []).map(value => num(value.id)),
        quizIds: (reply.events || []).filter(value => rewards(value.question_rewards).length > 0).map(value => num(value.id)),
        checkOnly: true });
    validateContext(session);
    const calendar = calendarDto(reply, metadata || initialMetadata);
    for (const event of calendar.events) {
        event.claimResultUnknown = uncertain.has(`${session.accountId}:claim:${event.id}`) || mutationScope.blocked(session, `ClaimSolarTermsV2:${event.id}`);
        event.answerCompletedLocally = mutationScope.completed(session, `AnswerSolarTerms:${event.id}`);
        event.answerResultUnknown = uncertain.has(`${session.accountId}:answer:${event.id}`)
            || (!event.answerCompletedLocally && mutationScope.blocked(session, `AnswerSolarTerms:${event.id}`));
        if (event.claimResultUnknown) event.canClaim = false;
        if (event.answerResultUnknown || event.answerCompletedLocally) { event.canAnswer = false; event.quizAvailable = false; }
    }
    for (const season of calendar.seasons) {
        season.resultUnknown = uncertain.has(`${session.accountId}:season:${season.id}`) || mutationScope.blocked(session, `ClaimSolarSeason:${season.id}`);
        if (season.resultUnknown) season.canClaim = false;
    }
    return { ...calendar, accountId: session.accountId };
}
async function getSolarCalendar(options = {}) {
    return readCalendar(captureContext(options));
}
async function getSolarQuestion(id, options = {}) {
    if (!positive(id)) throw failure('节令编号无效');
    const calendar = await getSolarCalendar(options);
    const event = calendar.events.find(value => value.id === num(id));
    if (!event) throw failure('服务端尚未下发这个节令');
    return { accountId: calendar.accountId, serverTime: calendar.serverTime, id: event.id, name: event.name,
        question: event.question || null, options: [...event.options], questionStatus: event.questionStatus,
        questionRevision: event.questionRevision, source: event.questionSource, metadataSync: calendar.metadataSync,
        startTime: event.startTime, endTime: event.endTime, canAnswer: event.canAnswer,
        quizClaimed: event.quizClaimed, quizWrongToday: event.quizWrongToday,
        wrongOptions: [...event.wrongOptions], rewards: event.questionRewards };
}
async function perform(action, input, session, { auto = false } = {}) {
    const id = input.id;
    if (!['claim', 'answer', 'season'].includes(action)) throw failure('未知的节令操作');
    if (typeof id !== 'number' || !positive(id)) throw failure('节令编号无效');
    const key = `${session.accountId}:${action}:${id}`;
    const mutationMethod = { claim: 'ClaimSolarTermsV2', answer: 'AnswerSolarTerms', season: 'ClaimSolarSeason' }[action];
    if (uncertain.has(key) || mutationScope.blocked(session, `${mutationMethod}:${id}`)) throw unknown();
    const state = await readCalendar(session);
    validateContext(session);
    let method;
    const params = { id };
    if (action === 'season') {
        if (!state.seasons.find(value => value.id === id)?.canClaim) throw failure('当前季度奖励不可领取');
        method = 'ClaimSolarSeason';
    } else {
        const event = state.events.find(value => value.id === id);
        if (auto && action === 'claim' && (!event?.canClaim || !event.rewards.length)) return { skipped: true, reason: 'not_claimable' };
        if (!event || !(action === 'claim' ? event.canClaim : event.canAnswer)) throw failure('节令未开放、已结束或本次操作已完成');
        if (action === 'answer') {
            const index = input.optionIndex;
            if (input.expectedQuestion !== event.question) throw failure('题目已变化，请刷新后重新选择');
            if (input.expectedQuestionRevision !== undefined && input.expectedQuestionRevision !== event.questionRevision) {
                throw failure('题目配置版本已变化，请刷新确认后再选择');
            }
            if (input.expectedOptions !== undefined && JSON.stringify(input.expectedOptions) !== JSON.stringify(event.options)) {
                throw failure('答案选项已变化，请刷新后重新确认');
            }
            if ((input.expectedStartTime !== undefined && input.expectedStartTime !== event.startTime)
                || (input.expectedEndTime !== undefined && input.expectedEndTime !== event.endTime)) {
                throw failure('节令窗口已变化，请刷新后重新确认');
            }
            if (!Number.isInteger(index) || index < 0 || index >= event.options.length || event.wrongOptions.includes(index)) throw failure('请选择有效答案');
            params.option_index = index;
        }
        method = action === 'claim' ? 'ClaimSolarTermsV2' : 'AnswerSolarTerms';
    }
    let reply;
    try {
        reply = await rpc(method, params, session, true);
        const updated = action === 'season' ? reply.updated_season : reply.updated_event;
        if (!has(updated, 'id') || num(updated.id) !== id) throw unknown();
        if (action === 'claim' && (updated.direct_claimed !== true || rewards(reply.rewards).length === 0)) throw unknown();
        if (action === 'season' && (updated.reward_claimed !== true || rewards(reply.rewards).length === 0)) throw unknown();
        if (action === 'answer' && !(reply.correct === true ? updated.quiz_claimed === true && rewards(reply.rewards).length > 0
            : updated.quiz_wrong_today === true && updated.quiz_claimed !== true)) throw unknown();
    } catch (cause) {
        if (cause.resultState === 'unknown') uncertain.add(key);
        throw cause;
    }
    if (action === 'answer') mutationScope.confirmOnce(session, `${method}:${id}`, reply.correct === true ? 'correct' : 'wrong');
    else mutationScope.confirm(session, `${method}:${id}`);
    const result = { accountId: session.accountId, resultState: 'completed', retryable: false,
        rewards: rewards(reply.rewards), ...(action === 'answer' ? { correct: reply.correct === true } : {}) };
    try { return { ...result, calendar: await readCalendar(session) }; }
    catch (cause) {
        // 已确认的写入不会因刷新失败再写；账号/代际切换时不向新上下文交付旧结果。
        try { validateContext(session); } catch { throw unknown(cause); }
        return { ...result, calendar: null, refreshRequired: true };
    }
}
async function autoClaimSolarGifts() {
    const session = captureContext({ priority: 'background' });
    const release = await operationGate.acquire('background', { ...session.context, validate: () => validateContext(session) });
    try {
        const initial = await readCalendar(session);
        const results = [];
        const candidates = initial.events.filter(event => event.canClaim && event.rewards.length > 0);
        // Existing solar_terms_claim covers only the basic small gift. Never
        // auto-answer questions or auto-claim albums under that old switch.
        for (const event of candidates.slice(0, 12)) {
            validateContext(session);
            const result = await perform('claim', { id: event.id }, session, { auto: true });
            if (result.skipped) continue;
            if (result.resultState !== 'completed' || !result.rewards.length) throw unknown();
            results.push({ ...result, id: event.id, name: event.name });
        }
        return { supported: initial.events.length > 0 || initial.seasons.length > 0,
            handledIds: initial.events.map(event => event.id), results, count: results.length,
            calendar: results.at(-1)?.calendar || initial };
    } finally { release(); }
}
async function autoAnswerSolarQuizzes(input = {}, options = {}) {
    input = { ...input, ...(Array.isArray(input.expectedOptions) ? { expectedOptions: [...input.expectedOptions] } : {}) };
    // An explicit one-shot reference approval is scoped to this account, event,
    // window and exact question/options. It never changes the background gate
    // or promotes user confirmation to independently verified official origin.
    const approval = input.acceptReferenceAnswer === true;
    if (approval && (input.confirmed !== true || typeof input.expectedAccountId !== 'string'
        || !input.expectedAccountId || typeof input.id !== 'number' || !positive(input.id)
        || typeof input.expectedQuestion !== 'string' || !input.expectedQuestion
        || !Array.isArray(input.expectedOptions) || input.expectedOptions.length === 0
        || input.expectedOptions.some(value => typeof value !== 'string')
        || !positive(input.expectedStartTime) || !positive(input.expectedEndTime))) {
        throw failure('参考答案试答需要单次确认及完整账号、题目、选项和节令窗口', 'SOLAR_REFERENCE_APPROVAL_INVALID');
    }
    const calendar = await getSolarCalendar({ ...options, priority: 'background' });
    if (approval) {
        const target = calendar.events.find(event => event.id === input.id);
        if (calendar.accountId !== input.expectedAccountId || !target || target.question !== input.expectedQuestion
            || JSON.stringify(target.options) !== JSON.stringify(input.expectedOptions)
            || target.startTime !== input.expectedStartTime || target.endTime !== input.expectedEndTime) {
            throw failure('试答账号、题目、选项或节令窗口已变化，请刷新确认', 'SOLAR_REFERENCE_APPROVAL_INVALID');
        }
    }
    const available = calendar.events.filter(event => event.canAnswer && (!approval || event.id === input.id));
    const eligible = available.filter(event => (event.answerSource?.answerOriginVerified === true || approval)
        && Number.isInteger(event.answerIndex) && event.answerIndex >= 0 && event.answerIndex < event.options.length);
    if (!eligible.length) return { skipped: true, reason: approval ? 'not_answerable' : 'no_independently_verified_answer',
        candidateCount: available.length, results: [], count: 0 };
    const results = [];
    for (const event of eligible) {
        const result = await operateSolarCalendar('answer', { id: event.id, optionIndex: event.answerIndex,
            expectedQuestion: event.question, expectedOptions: [...event.options],
            expectedStartTime: event.startTime, expectedEndTime: event.endTime }, { ...options, priority: 'background' });
        results.push({ ...result, id: event.id, name: event.name, optionIndex: event.answerIndex,
            selectedOption: event.options[event.answerIndex], answerOriginVerified: event.answerSource?.answerOriginVerified === true,
            answerProvenance: approval ? 'user-confirmed-upstream-reference-once' : 'independently-verified-config' });
        if (result.correct !== true) break;
    }
    return { accountId: calendar.accountId, results, count: results.length };
}
async function operateSolarCalendar(action, input = {}, options = {}) {
    if (action === 'auto-answer') return autoAnswerSolarQuizzes({ ...input }, options);
    const session = captureContext(options);
    const snapshot = { ...input };
    const release = await operationGate.acquire(session.context.priority, { ...session.context, validate: () => validateContext(session) });
    try { return await perform(action, snapshot, session); }
    finally { release(); }
}

module.exports = { getSolarCalendar, getSolarQuestion, operateSolarCalendar, autoClaimSolarGifts, autoAnswerSolarQuizzes, eventDto, calendarDto, configSources, SERVICE };
