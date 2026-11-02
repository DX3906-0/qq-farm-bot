/**
 * 经验刷新（方案 B：事件驱动，不新增定时轮询）
 *
 * 背景（2026-10-29 定位）：
 *   面板的「效率」「升级预测」长期不准，根因是经验值 exp **几乎不更新**——
 *   全项目只有 4 个被动入口（登录回包 / ItemNotify 1101 / 某回包 basic.exp / gateway 登录），
 *   没有任何主动拉取。于是登录那一刻的经验值被冻结，之后收获带来的经验根本不反映到面板。
 *
 * 为什么不加定时轮询：
 *   经验是慢变量，定时打 `CareerInfoGet` 属于为面板数字凭空增加请求量，性价比低且有风控顾虑。
 *
 * 本模块做法：
 *   只在「本来就要发请求」的时点（收获成功后）顺带刷新一次经验，
 *   并做严格节流（默认 3 分钟内最多一次），保证不会因连收多块地而放大请求量。
 *
 * 风控备注：
 *   `CareerInfoGet` 是游戏正常客户端也会调的查询型接口（生涯面板），无副作用，
 *   与已被实证触发风控的「授权接口高频」「切号高频」完全不同类。
 */
const { getCareerInfo } = require('./career');
const stats = require('./stats');
const network = require('../utils/network');

/**
 * 把经验写回 userState（面板 status.exp 的来源）。
 * ⚠️ 兼容性：`applyUserExpPatch` 只在 gateway 模式下导出（非 gateway 分支的 networkApi 没有它）。
 * 当前生产走 gateway，但若某天切回直连模式，这里必须降级为直接改 getUserState()，
 * 否则面板会"日志说同步了、数字却不动"（这个坑已踩过：起初只更新 stats 模块，面板毫无变化）。
 */
function writeBackExp(exp, level) {
    try {
        if (typeof network.applyUserExpPatch === 'function') {
            return network.applyUserExpPatch({ exp, level });
        }
        const us = typeof network.getUserState === 'function' ? network.getUserState() : null;
        if (!us) return false;
        let changed = false;
        if (exp > 0 && Number(us.exp) !== exp) { us.exp = exp; changed = true; }
        if (level > 0 && Number(us.level) !== level) { us.level = level; changed = true; }
        return changed;
    } catch {
        return false;
    }
}

/** 最小刷新间隔：3 分钟。收获通常几分钟一批，合并后不会额外放大请求。 */
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000;
/** 单次请求超时（毫秒）——避免拖住农场主循环 */
const REFRESH_TIMEOUT_MS = 15000;

let lastRefreshAt = 0;
let inflight = null;
let lastError = null;

/**
 * 刷新经验（节流 + 合并并发）。
 * 供 farming-orchestrator 在收获成功后以 fire-and-forget 方式调用。
 * 不抛异常、不阻塞主循环：失败只记录，留给下一次收获再试。
 *
 * @param {{gid?:number|string, force?:boolean}} opts
 * @returns {Promise<{skipped?:boolean, reason?:string, exp?:number, level?:number}|null>}
 */
async function refreshExpAfterHarvest(opts = {}) {
    const now = Date.now();
    if (!opts.force && now - lastRefreshAt < MIN_REFRESH_GAP_MS) {
        return { skipped: true, reason: `throttled(${Math.round((now - lastRefreshAt) / 1000)}s)` };
    }
    // 已有请求在飞：直接复用，避免并发打同一接口
    if (inflight) return inflight;

    const gid = opts.gid;
    if (!gid) return { skipped: true, reason: 'no-gid' };

    lastRefreshAt = now;
    inflight = (async () => {
        try {
            const info = await Promise.race([
                getCareerInfo(gid),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`经验刷新超时 ${REFRESH_TIMEOUT_MS}ms`)), REFRESH_TIMEOUT_MS)),
            ]);
            const exp = Number(info && info.exp) || 0;
            const level = Number(info && info.level) || 0;
            if (exp > 0) {
                // 写入 stats：updateStats 内部会触发 noteExpObservation 维护速率
                stats.updateStats(undefined, exp);
                // ⭐ 必须同时写回 userState，否则面板的 status.exp 不会变
                //（实测：只更新 stats 时日志显示"已同步"但面板数字纹丝不动）
                writeBackExp(exp, level);
                lastError = null;
            }
            return { exp, level };
        } catch (e) {
            lastError = String((e && e.message) || e).slice(0, 120);
            return { skipped: true, reason: `error:${lastError}` };
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** 供面板/调试查看当前节流与错误状态 */
function getExpRefreshState() {
    return {
        lastRefreshAt,
        lastRefreshAgoSec: lastRefreshAt ? Math.round((Date.now() - lastRefreshAt) / 1000) : -1,
        minGapSec: MIN_REFRESH_GAP_MS / 1000,
        inflight: !!inflight,
        lastError,
    };
}

module.exports = { refreshExpAfterHarvest, getExpRefreshState };