'use strict';

const { Buffer } = require('node:buffer');

const HOME_SCENE_ID = 1;
const RANCH_SCENE_ID = 2;
const MAX_INT32 = 2 ** 31 - 1;

const PROFILE_DEFINITIONS = Object.freeze({
    legacy: Object.freeze({
        service: 'gamepb.userpb.UserService',
        method: 'Login',
        requestType: 'LoginRequest',
        replyType: 'LoginReply',
    }),
    player: Object.freeze({
        service: 'gamepb.userpb.UserService',
        method: 'PlayerLogin',
        requestType: 'PlayerLoginRequest',
        replyType: 'PlayerLoginReply',
    }),
});

const REQUEST_FIELDS = Object.freeze([
    'sharer_id', 'sharer_open_id', 'share_cfg_id', 'scene_id', 'report_data',
    'share_key', 'experiment_keys', 'ark_biz_type', 'ark_biz_param', 'game_scene_id',
]);

const LOGIN_PROFILE_MARK = Symbol('player-login-profile');

function protocolError(message, code = 'PLAYER_LOGIN_PROTOCOL_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertProfile(profile) {
    if (profile !== 'legacy' && profile !== 'player') {
        throw protocolError('登录 profile 必须显式指定为 legacy 或 player', 'PLAYER_LOGIN_PROFILE_REQUIRED');
    }
    return PROFILE_DEFINITIONS[profile];
}

function assertType(types, name, kind) {
    const type = types && types[name];
    if (!type || typeof type.encode !== 'function' || typeof type.decode !== 'function') {
        throw protocolError(`${kind} protobuf 类型缺失: ${name}`, 'PLAYER_LOGIN_PROTO_UNAVAILABLE');
    }
    return type;
}

function parseBuildArguments(profileOrOptions, requestFields) {
    if (typeof profileOrOptions === 'string') {
        return { profile: profileOrOptions, fields: requestFields || {} };
    }
    if (!profileOrOptions || typeof profileOrOptions !== 'object') {
        throw protocolError('登录 profile 必须显式指定，禁止默认或自动回退', 'PLAYER_LOGIN_PROFILE_REQUIRED');
    }
    const { profile, request, requestFields: namedFields, ...inlineFields } = profileOrOptions;
    return {
        profile,
        fields: request || namedFields || inlineFields,
    };
}

function pickRequestFields(fields) {
    const result = {};
    for (const name of REQUEST_FIELDS) {
        if (Object.hasOwn(fields, name)) result[name] = fields[name];
    }
    return result;
}

function markDecodedReply(reply, profile) {
    if (reply && typeof reply === 'object') {
        Object.defineProperty(reply, LOGIN_PROFILE_MARK, {
            value: profile,
            enumerable: false,
            configurable: false,
        });
    }
    return reply;
}

/**
 * 只构造登录 RPC 描述，不发送网络请求，也不改变登录状态。
 * profile 不提供默认值，避免新协议失败后静默回退旧 Login。
 */
function buildRequest(types, deviceInfo, profileOrOptions, requestFields) {
    if (!types || typeof types !== 'object') {
        throw protocolError('登录 protobuf 类型集合缺失', 'PLAYER_LOGIN_PROTO_UNAVAILABLE');
    }
    if (!deviceInfo || typeof deviceInfo !== 'object') {
        throw protocolError('登录请求缺少 deviceInfo', 'PLAYER_LOGIN_DEVICE_INFO_REQUIRED');
    }

    const { profile, fields } = parseBuildArguments(profileOrOptions, requestFields);
    const definition = assertProfile(profile);
    const Request = assertType(types, definition.requestType, '请求');
    const Reply = assertType(types, definition.replyType, '回包');
    const payload = { ...pickRequestFields(fields || {}), device_info: deviceInfo };
    const message = typeof Request.create === 'function' ? Request.create(payload) : Request.fromObject(payload);
    const body = Buffer.from(Request.encode(message).finish());

    return {
        profile,
        actualProfile: profile,
        service: definition.service,
        method: definition.method,
        body,
        replyDecoder(bytes) {
            return markDecodedReply(Reply.decode(bytes), profile);
        },
    };
}

function decimalSafeInteger(value, fieldName, { positive = false, int32 = false } = {}) {
    let text;
    if (typeof value === 'bigint') text = value.toString();
    else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw protocolError(`${fieldName} 必须是安全整数`, 'PLAYER_LOGIN_IDENTITY_INVALID');
        if (positive ? value <= 0 : false) throw protocolError(`${fieldName} 必须为正整数`, 'PLAYER_LOGIN_IDENTITY_INVALID');
        if (int32 && (value < -MAX_INT32 - 1 || value > MAX_INT32)) {
            throw protocolError(`${fieldName} 超出 int32 范围`, 'PLAYER_LOGIN_SCENE_INVALID');
        }
        return value;
    } else if (value && typeof value.toString === 'function') text = value.toString();
    else text = String(value);

    if (!/^-?\d+$/.test(text)) throw protocolError(`${fieldName} 必须是整数`, 'PLAYER_LOGIN_IDENTITY_INVALID');
    const number = Number(text);
    if (!Number.isSafeInteger(number)) throw protocolError(`${fieldName} 超出安全整数范围`, 'PLAYER_LOGIN_IDENTITY_INVALID');
    if (positive && number <= 0) throw protocolError(`${fieldName} 必须为正整数`, 'PLAYER_LOGIN_IDENTITY_INVALID');
    if (int32 && (number < -MAX_INT32 - 1 || number > MAX_INT32)) {
        throw protocolError(`${fieldName} 超出 int32 范围`, 'PLAYER_LOGIN_SCENE_INVALID');
    }
    return number;
}

function normalizeBasic(rawBasic) {
    if (!rawBasic || typeof rawBasic !== 'object') {
        throw protocolError('登录回包缺少 basic 身份信息', 'PLAYER_LOGIN_IDENTITY_INVALID');
    }
    const basic = { ...rawBasic };
    basic.gid = decimalSafeInteger(rawBasic.gid, 'basic.gid', { positive: true });
    for (const field of ['level', 'exp', 'gold']) {
        if (Object.hasOwn(rawBasic, field)) basic[field] = decimalSafeInteger(rawBasic[field], `basic.${field}`);
    }
    return basic;
}

function hasOwnValue(value, field) {
    return value !== null && value !== undefined && Object.hasOwn(value, field);
}

function requireProfileMarker(reply, profile) {
    if (reply[LOGIN_PROFILE_MARK] && reply[LOGIN_PROFILE_MARK] !== profile) {
        throw protocolError('登录回包 profile 与请求不一致', 'PLAYER_LOGIN_REPLY_PROFILE_MISMATCH');
    }
}

function normalizeUnlockedScenes(reply) {
    if (!hasOwnValue(reply, 'unlocked_scene_ids')) return [];
    if (!Array.isArray(reply.unlocked_scene_ids)) {
        throw protocolError('unlocked_scene_ids 必须是数组', 'PLAYER_LOGIN_SCENE_INVALID');
    }
    return reply.unlocked_scene_ids.map((sceneId, index) => decimalSafeInteger(
        sceneId, `unlocked_scene_ids[${index}]`, { int32: true }
    ));
}

function validateVersionMarker(reply, profile) {
    if (!hasOwnValue(reply, 'version_info') || !reply.version_info || typeof reply.version_info !== 'object') {
        throw protocolError(`${profile} 登录回包缺少 version_info，拒绝按另一种 schema 猜测`, 'PLAYER_LOGIN_REPLY_PROFILE_MISMATCH');
    }
}

/**
 * 校验已解码登录回包并归一化身份信息。
 * 不接受旧 gid 作为失败回退，也不把 global_scene_id 单独当作解锁证明。
 */
function validateLoginReply(profileOrOptions, decodedReply) {
    let profile = profileOrOptions;
    let reply = decodedReply;
    if (profileOrOptions && typeof profileOrOptions === 'object' && !decodedReply) {
        profile = profileOrOptions.profile;
        reply = profileOrOptions.reply || profileOrOptions.decodedReply;
    }
    assertProfile(profile);
    if (!reply || typeof reply !== 'object') {
        throw protocolError('登录回包缺失或不可识别', 'PLAYER_LOGIN_REPLY_INVALID');
    }
    requireProfileMarker(reply, profile);
    validateVersionMarker(reply, profile);

    const basic = normalizeBasic(reply.basic);
    const globalScene = {
        id: null,
        unlockedSceneIds: [],
        idConfirmed: false,
        unlockedSceneIdsConfirmed: false,
        ranchUnlocked: false,
    };

    if (profile === 'player') {
        if (!hasOwnValue(reply, 'global_scene_id')) {
            throw protocolError('PlayerLoginReply 缺少 global_scene_id', 'PLAYER_LOGIN_SCENE_INVALID');
        }
        globalScene.id = decimalSafeInteger(reply.global_scene_id, 'global_scene_id', { int32: true });
        globalScene.unlockedSceneIds = normalizeUnlockedScenes(reply);
        globalScene.idConfirmed = true;
        globalScene.unlockedSceneIdsConfirmed = hasOwnValue(reply, 'unlocked_scene_ids');
        globalScene.ranchUnlocked = globalScene.unlockedSceneIds.includes(RANCH_SCENE_ID);
    }

    return {
        profile,
        actualProfile: profile,
        basic,
        globalScene,
        gid: basic.gid,
        versionInfo: Object.fromEntries(['version_recommend', 'version_force'].map(key => {
            const value = reply.version_info?.[key];
            return [key, typeof value === 'string' && /^\d+(?:\.\d+){2,4}(?:_\d{8})?$/.test(value) ? value : null];
        })),
        requiresHomeSceneConfirmation: profile === 'player',
        homeSceneConfirmed: profile === 'legacy' ? null : false,
        canBroadcastLoggedIn: profile === 'legacy',
    };
}

function validateHomeSceneConfirmation(decodedSceneReply) {
    if (!decodedSceneReply || typeof decodedSceneReply !== 'object'
        || !hasOwnValue(decodedSceneReply, 'global_scene_id')) {
        throw protocolError('HOME 场景回包缺少 global_scene_id', 'PLAYER_LOGIN_HOME_NOT_CONFIRMED');
    }
    const sceneId = decimalSafeInteger(decodedSceneReply.global_scene_id, 'HOME.global_scene_id', { int32: true });
    if (sceneId !== HOME_SCENE_ID) {
        throw protocolError('登录后必须显式确认 HOME scene 1', 'PLAYER_LOGIN_HOME_NOT_CONFIRMED');
    }
    return { homeSceneId: HOME_SCENE_ID, confirmed: true };
}

function confirmHomeScene(loginResult, decodedSceneReply) {
    if (!loginResult || loginResult.actualProfile !== 'player') {
        throw protocolError('只有 player 登录结果需要确认 HOME 场景', 'PLAYER_LOGIN_HOME_NOT_CONFIRMED');
    }
    validateHomeSceneConfirmation(decodedSceneReply);
    return {
        ...loginResult,
        homeSceneConfirmed: true,
        canBroadcastLoggedIn: true,
    };
}

module.exports = {
    HOME_SCENE_ID,
    RANCH_SCENE_ID,
    PROFILE_DEFINITIONS,
    buildRequest,
    validateLoginReply,
    validateDecodedLoginReply: validateLoginReply,
    normalizeLoginReply: validateLoginReply,
    validateHomeSceneConfirmation,
    confirmHomeScene,
};
