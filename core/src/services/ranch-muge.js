'use strict';

const { types } = require('../utils/proto');
const { requestError } = require('../utils/request-priority');
const { withGameScene, RANCH_SCENE_ID } = require('./scene-session');
const { sceneRpc } = require('./ranch-manual');
const { numberText, small, rewards, clock } = require('./ranch-progression');
const { getRanchItem, getRanchImage } = require('./ranch-config');
const config = require('../activity-data/muge-20261117.json');
const { ranchOperations } = require('./ranch-operations-ledger');

const GROUP_ID = '2026111700';
const IDS = Object.freeze({ celebration: '2026111702', friends: '2026111703', handbook: '2026111704', personality: '2026111705' });
const OPERATIONS = Object.freeze({
    claimCelebration: { id: IDS.celebration, cmd: 85, field: 'global_count_claim_tier' },
    claimFriends: { id: IDS.friends, cmd: 84, field: 'invite_friend_tier_claim' },
    claimTask: { id: IDS.handbook, cmd: 82, field: 'task_claim' },
    claimHandbook: { id: IDS.handbook, cmd: 83, field: 'task_tier_claim' },
    saveAnswers: { id: IDS.personality, cmd: 86, field: 'survey_save_progress' },
    settle: { id: IDS.personality, cmd: 87, field: 'survey_settle' },
    claimShare: { id: IDS.personality, cmd: 89, field: 'survey_claim_share_reward' },
});
let mutationTail = Promise.resolve();

function fail(message, code = 'RANCH_MUGE_UNCONFIRMED', unknown = false) {
    throw requestError(message, { errorCode: code, stage: 'ranch_muge', sent: unknown,
        resultState: unknown ? 'unknown' : 'not_sent', outcomeUnknown: unknown });
}
function itemDto(item) {
    const id = numberText(item?.id, '活动奖励ID');
    return { id, count: numberText(item?.count, '活动奖励数量'), name: getRanchItem(id)?.name || `物品 #${id}`,
        image: getRanchImage(id)?.url || '' };
}
function tierDto(tier) {
    return { id: numberText(tier.tier_id, '活动档位ID'), threshold: numberText(tier.threshold, '活动档位门槛'),
        status: small(tier.status, '活动档位状态'), rewards: (tier.reward || []).map(itemDto) };
}
function answersDto(answers) {
    const output = {};
    for (const [key, value] of Object.entries(answers || {})) {
        const normalized = /^\d+$/.test(key) ? key : require('protobufjs').util.longFromHash(key).toString();
        output[normalized] = numberText(value, '活动答案');
    }
    return output;
}
function activityDto(group, session) {
    if (String(group?.head?.id) !== GROUP_ID) fail('牧歌初启活动分组未返回', 'RANCH_MUGE_UNAVAILABLE');
    const child = id => (group.children || []).find(row => String(row.head?.id) === id);
    const celebration = child(IDS.celebration)?.global_count;
    const friends = child(IDS.friends)?.invite_friend;
    const handbook = child(IDS.handbook)?.task;
    const personality = child(IDS.personality)?.survey;
    const now = clock(session).serverTimeMs;
    const startTime = small(group.head.start_time, '活动开始时间') * 1000;
    const endTime = small(group.head.end_time, '活动结束时间') * 1000;
    return {
        activityId: GROUP_ID, title: '牧歌初启', serverTime: now, startTime, endTime,
        active: small(group.head.status, '活动状态') === 1 && now >= startTime && now < endTime,
        rules: String(group.head.desc || '').split(/\r?\n/).filter(Boolean),
        sections: IDS,
        celebration: celebration ? { total: numberText(celebration.total, '全服累计数量'), tiers: (celebration.tiers || []).map(tierDto) } : null,
        friends: friends ? { count: (friends.counted_friends || []).length, tiers: (friends.tiers || []).map(tierDto) } : null,
        handbook: handbook ? { points: numberText(handbook.tier_points, '成长积分'), tiers: (handbook.tiers || []).map(tierDto),
            tasks: (handbook.tasks || []).map(task => ({ id: numberText(task.task_id), description: String(task.desc || ''),
                progress: numberText(task.progress), target: numberText(task.target), status: small(task.status),
                unlockDay: small(task.unlock_day), points: config.tasks.find(entry => String(entry.id) === numberText(task.task_id))?.points || 0,
                rewards: (task.reward || []).map(itemDto) })) } : null,
        personality: personality ? { answers: answersDto(personality.answers), personalityId: numberText(personality.personality_id),
            settleCount: numberText(personality.settle_count), image: `/activity/muge/personality-${numberText(personality.personality_id)}.png`,
            shareRewardClaimed: personality.share_reward_claimed === true } : null,
        questions: config.questions,
    };
}
async function readState(session) {
    if (!types.ActivityListRequest || !types.MugeListReply) fail('牧歌初启协议未加载', 'RANCH_MUGE_PROTO_UNAVAILABLE');
    const reply = await sceneRpc(session, 'gamepb.activitypb.ActivityService', 'List', types.ActivityListRequest,
        types.MugeListReply, { game_scene_id: 1 }, { read: true });
    const group = (reply.groups || []).find(row => String(row.head?.id) === GROUP_ID);
    return activityDto(group, session);
}
function claimable(state, action) {
    if (action === 'claimTask') return state.handbook?.tasks?.some(row => row.status === 2) === true;
    const section = { claimCelebration: 'celebration', claimFriends: 'friends', claimHandbook: 'handbook' }[action];
    if (section) return state[section]?.tiers?.some(row => row.status === 2) === true;
    if (action === 'settle') return state.personality
        && config.questions.every(question => config.questions.find(entry => entry.id === question.id)?.options
            .some(option => String(option.value) === state.personality.answers[String(question.id)]));
    return false;
}
function operationInput(action, input, state) {
    if (!state.active) fail('牧歌初启活动尚未开始或已结束', 'RANCH_MUGE_ENDED');
    if (action === 'claimCelebration' || action === 'claimFriends' || action === 'claimHandbook' || action === 'claimTask') {
        if (!claimable(state, action)) fail('当前没有可领取的活动奖励', 'RANCH_MUGE_NOT_CLAIMABLE');
        return action === 'claimTask' ? { task_id: 0 } : { tier_id: 0 };
    }
    if (!state.personality) fail('牧场人格数据暂不可用', 'RANCH_MUGE_UNAVAILABLE');
    if (action === 'saveAnswers') {
        if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)
            || typeof input.clear !== 'boolean' || (input.clear && Object.keys(input.answers).length)
            || (!input.clear && !Object.keys(input.answers).length)) fail('答案参数无效；清空与保存必须分开提交', 'RANCH_MUGE_INVALID_ANSWERS');
        for (const [id, value] of Object.entries(input.answers)) {
            const question = config.questions.find(row => String(row.id) === id);
            if (!question || !question.options.some(option => String(option.value) === String(value))) fail('题目或答案不在已核验题库中', 'RANCH_MUGE_INVALID_ANSWERS');
        }
        return { answers: input.answers, clear: input.clear };
    }
    if (action === 'settle') {
        if (!claimable(state, action)) fail('请先完成全部题目', 'RANCH_MUGE_ANSWERS_INCOMPLETE');
        return {};
    }
    if (action === 'claimShare') {
        if (state.personality.personalityId === '0' || state.personality.shareRewardClaimed) fail('当前没有可领取的人格分享奖励', 'RANCH_MUGE_NOT_CLAIMABLE');
        return {};
    }
    fail('不支持的牧歌初启操作', 'RANCH_MUGE_INVALID_ACTION');
}
function verifyReply(reply, op, action, input) {
    const result = reply?.[op.field];
    if (String(reply?.id) !== op.id || small(reply?.cmd) !== op.cmd || !result
        || String(reply.activity?.head?.id) !== op.id) fail('活动操作结果未确认；暂不重复提交，刷新只读取当前活动状态', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    if (['claimTask', 'claimHandbook', 'claimCelebration', 'claimFriends'].includes(action) && !(result.claimed_ids || []).length)
        fail('服务端未确认已领取档位；暂不重复领取，刷新只读取当前档位', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    if (action === 'settle' && numberText(reply.activity?.survey?.personality_id) === '0') fail('人格结算结果未确认；暂不重复结算，刷新只读取当前人格状态', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    if (action === 'saveAnswers' && !reply.activity?.survey) fail('问卷保存结果未确认；暂不重复保存，刷新只读取当前问卷', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    if (action === 'saveAnswers' && input.clear && Object.values(answersDto(reply.activity.survey.answers)).some(value => value !== '0'))
        fail('清空问卷回包仍有答案；刷新只读取当前问卷状态', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    if (action === 'saveAnswers' && !input.clear) {
        const saved = answersDto(reply.activity.survey.answers);
        if (!Object.entries(input.answers).every(([id, value]) => saved[id] === String(value))) fail('答案保存回包与请求不符；暂不重复保存，刷新只读取当前问卷', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    }
    if (action === 'claimShare' && reply.activity?.survey?.share_reward_claimed !== true) fail('分享奖励领取结果未确认；暂不重复领取，刷新只读取当前活动状态', 'RANCH_MUGE_RESULT_UNKNOWN', true);
    return (result.awards || []).map(itemDto);
}
async function getRanchMugeActivityInSession(session, sceneReply) {
    clock(session, sceneReply);
    return readState(session);
}
async function getRanchMugeActivity(accountId) {
    return withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
        if (session.accountId !== String(accountId)) fail('活动读取账号不匹配', 'ACCOUNT_OPERATION_CHANGED');
        return getRanchMugeActivityInSession(session, sceneReply);
    }, { priority: 'foreground', timeoutMs: 60000 });
}
async function performInSession(session, sceneReply, action, input = {}) {
    const op = OPERATIONS[action];
    if (!op) fail('不支持的牧歌初启操作', 'RANCH_MUGE_INVALID_ACTION');
    clock(session, sceneReply);
    const state = await readState(session);
    const params = operationInput(action, input, state);
    if (!types.MugeOperateRequest || !types.MugeOperateReply) fail('牧歌初启协议未加载', 'RANCH_MUGE_PROTO_UNAVAILABLE');
    const target = `muge:${GROUP_ID}:${op.id}:${op.cmd}:${action}`;
    return ranchOperations.spend(session.accountId, { target, label: `牧歌初启·${action}`, costs: [] }, async lifecycle => {
        const response = await sceneRpc(session, 'gamepb.activitypb.ActivityService', 'Operate', types.MugeOperateRequest,
            types.MugeOperateReply, { id: op.id, cmd: op.cmd, [op.field]: params }, { lifecycle });
        const awards = verifyReply(response, op, action, input);
        const fresh = await readState(session);
        return { activity: fresh, rewards: awards };
    });
}
async function perform(accountId, action, input = {}) {
    return withGameScene(RANCH_SCENE_ID, async ({ session, sceneReply }) => {
        if (session.accountId !== String(accountId)) fail('活动操作账号不匹配', 'ACCOUNT_OPERATION_CHANGED');
        return performInSession(session, sceneReply, action, input);
    }, { priority: 'foreground', timeoutMs: 120000 });
}
function serializeMutation(task) {
    const pending = mutationTail.then(task);
    mutationTail = pending.catch(() => {});
    return pending;
}
function operateRanchMugeActivity(accountId, action, input = {}) {
    return serializeMutation(() => perform(String(accountId), String(action), input || {}));
}
function operateRanchMugeActivityInSession(session, sceneReply, action, input = {}) {
    return serializeMutation(() => performInSession(session, sceneReply, String(action), input || {}));
}
module.exports = { getRanchMugeActivity, getRanchMugeActivityInSession, operateRanchMugeActivity,
    operateRanchMugeActivityInSession, MUGE_GROUP_ID: GROUP_ID, MUGE_OPERATIONS: OPERATIONS };
