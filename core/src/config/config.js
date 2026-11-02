const process = require('node:process');

const DEFAULT_CLIENT_VERSION = '1.14.2.15_20260922';

function parseClientVersion(value) {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+){2,4})_(\d{8})$/);
    return match ? { parts: match[1].split('.').map(Number), date: Number(match[2]) } : null;
}

function resolveClientVersion(value) {
    const version = String(value || '').trim();
    const candidate = parseClientVersion(version);
    const baseline = parseClientVersion(DEFAULT_CLIENT_VERSION);
    if (!candidate || !baseline) return version || DEFAULT_CLIENT_VERSION;
    if (candidate.date !== baseline.date) {
        return candidate.date < baseline.date ? DEFAULT_CLIENT_VERSION : version;
    }
    const width = Math.max(candidate.parts.length, baseline.parts.length);
    for (let index = 0; index < width; index += 1) {
        const delta = (candidate.parts[index] || 0) - (baseline.parts[index] || 0);
        if (delta !== 0) return delta < 0 ? DEFAULT_CLIENT_VERSION : version;
    }
    return version;
}

/**
 * 应用服务器下发的版本校准信息（登录回复 version_info）。
 * 规则（仅升不降，下限受 DEFAULT_CLIENT_VERSION 兜底保护，见 resolveClientVersion）：
 *  - version_force 非空且合法 → 强制对齐到服务器指定版本（优先取 force）
 *  - 否则 version_recommend 非空且合法 → 静默升级到推荐版本
 * @param {object} info 形如 { version_force, version_recommend }
 * @returns {{ force: boolean, recommend: boolean, changed: boolean, target: string }}
 */
function applyServerVersion(info) {
    const force = String((info && info.version_force) || '').trim();
    const recommend = String((info && info.version_recommend) || '').trim();
    const useVersion = force || recommend;

    if (!useVersion) {
        return { force: !!force, recommend: !!recommend, changed: false, target: CONFIG.clientVersion };
    }

    const target = resolveClientVersion(useVersion);
    if (parseClientVersion(target) && compareVersions(target, CONFIG.clientVersion) >= 0
        && target !== CONFIG.clientVersion) {
        CONFIG.clientVersion = target;
        return { force: !!force, recommend: !force, changed: true, target };
    }
    return { force: !!force, recommend: !force, changed: false, target: CONFIG.clientVersion };
}

// 返回 >0 表示 a 比 b 新；==0 相同；<0 表示 a 比 b 旧（非法格式一律按 0 处理，不误判）
function compareVersions(a, b) {
    const pa = parseClientVersion(String(a || '').trim());
    const pb = parseClientVersion(String(b || '').trim());
    if (!pa || !pb) return 0;
    if (pa.date !== pb.date) return pa.date - pb.date;
    for (let index = 0; index < Math.max(pa.parts.length, pb.parts.length); index += 1) {
        const delta = (pa.parts[index] || 0) - (pb.parts[index] || 0);
        if (delta !== 0) return delta;
    }
    return 0;
}

// 默认系统配置
const DEFAULT_SYSTEM_CONFIG = {
    serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
    clientVersion: DEFAULT_CLIENT_VERSION,
    platform: 'qq',
    os: 'iOS'
};

// 运行时配置（可被系统配置覆盖）
const CONFIG = {
    serverUrl: DEFAULT_SYSTEM_CONFIG.serverUrl,
    clientVersion: DEFAULT_SYSTEM_CONFIG.clientVersion,
    platform: DEFAULT_SYSTEM_CONFIG.platform,
    os: DEFAULT_SYSTEM_CONFIG.os,
    tsdkAceEnabled: process.env.FARM_TSDK_ACE_ENABLED !== 'false',
    // 官方 AceManager: SdkInitEx(3167, 0)
    tsdkGameId: Number(process.env.FARM_TSDK_GAME_ID || 3167),
    tsdkAppKey: String(process.env.FARM_TSDK_APP_KEY || '0'),
    heartbeatInterval: 25000,         // 心跳间隔 25秒
    farmCheckInterval: 3000,           // 农场检查间隔 3秒
    friendCheckInterval: 12000,        // 好友检查间隔 12秒
    farmCheckIntervalMin: 3000,        // 农场检查最小间隔 3秒
    farmCheckIntervalMax: 5000,        // 农场检查最大间隔 5秒
    friendCheckIntervalMin: 12000,     // 好友检查最小间隔 12秒
    friendCheckIntervalMax: 15000,     // 好友检查最大间隔 15秒
    adminPort: Number(process.env.ADMIN_PORT),
    adminPassword: process.env.ADMIN_PASSWORD
};

/**
 * 更新运行时配置
 * @param {object} config - 包含 serverUrl, clientVersion, platform, os 的配置对象
 */
function updateRuntimeConfig(config) {
    if (config.serverUrl && typeof config.serverUrl === 'string') {
        CONFIG.serverUrl = config.serverUrl;
    }
    if (config.clientVersion && typeof config.clientVersion === 'string') {
        CONFIG.clientVersion = resolveClientVersion(config.clientVersion);
    }
    if (config.platform && typeof config.platform === 'string') {
        CONFIG.platform = config.platform;
    }
    if (config.os && typeof config.os === 'string') {
        CONFIG.os = config.os;
    }
}

/**
 * 获取当前运行时配置快照
 */
function getRuntimeConfig() {
    return {
        serverUrl: CONFIG.serverUrl,
        clientVersion: CONFIG.clientVersion,
        platform: CONFIG.platform,
        os: CONFIG.os
    };
}

/**
 * 获取默认系统配置的副本
 */
function getDefaultSystemConfig() {
    return { ...DEFAULT_SYSTEM_CONFIG };
}

// 植物生长阶段枚举
const PlantPhase = {
    UNKNOWN: 0,        // 未知
    SEED: 1,           // 种子
    GERMINATION: 2,    // 发芽
    SMALL_LEAVES: 3,   // 小叶
    LARGE_LEAVES: 4,   // 大叶
    BLOOMING: 5,       // 开花
    MATURE: 6,         // 成熟
    DEAD: 7            // 枯死
};

// 植物阶段名称
const PHASE_NAMES = ['未知', '种子', '发芽', '小叶', '大叶', '开花', '成熟', '枯死'];

module.exports = {
    CONFIG,
    DEFAULT_CLIENT_VERSION,
    PlantPhase,
    PHASE_NAMES,
    updateRuntimeConfig,
    getRuntimeConfig,
    getDefaultSystemConfig,
    resolveClientVersion,
    applyServerVersion,
};
