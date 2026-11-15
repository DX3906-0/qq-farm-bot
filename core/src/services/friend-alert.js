/**
 * 跨账号偷菜告警推送
 *
 * 当指定账号（示例账号乙）偷取了指定目标（示例账号甲）的菜时，推送提醒。
 * 其他账号/组合的偷菜行为不推送。
 * 推送通道读取 ALERT_WEBHOOK 环境变量（与 botMonitor 云函数同一配置）：
 * - PushPlus：URL 形如 http://www.pushplus.plus/send/{token}
 * - 其他：按企业微信群机器人 text 格式处理
 *
 * 标题即正文：简短事件直接写在标题上，无需点开详情。
 */
const fs = require('fs');
const path = require('path');
const { getAccounts } = require('../models/store');
const { logWarn } = require('../utils/utils');

/**
 * Code 失效告警节流：每个账号每 6 小时最多推送一次。
 * 状态持久化到 data/code-expired-alert.json，跨 worker 重启/重连风暴也不刷屏。
 */
const ALERT_THROTTLE_MS = 6 * 3600 * 1000;
function getCodeExpiredAlertStatePath() {
  const baseDir = process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
  return path.join(baseDir, 'code-expired-alert.json');
}
function getLastCodeExpiredAlertAt(accountId) {
  try {
    const p = getCodeExpiredAlertStatePath();
    if (!fs.existsSync(p)) return 0;
    const map = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    return Number(map[String(accountId)]) || 0;
  } catch {
    return 0;
  }
}
function setLastCodeExpiredAlertAt(accountId, ts) {
  try {
    const p = getCodeExpiredAlertStatePath();
    let map = {};
    if (fs.existsSync(p)) map = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    map[String(accountId)] = ts;
    fs.writeFileSync(p, JSON.stringify(map));
  } catch {
    /* 持久化失败不影响主流程 */
  }
}

/**
 * 指定偷菜告警规则：仅列出的「小偷 gid → 被偷 gid」组合才推送。
 * 目前仅：示例账号乙 偷 示例账号甲。
 */
const STEAL_ALERT_PAIRS = (() => {
    try {
        const rows = JSON.parse(process.env.FARM_STEAL_ALERT_PAIRS || '[]');
        return Array.isArray(rows) ? rows.filter(row => Number(row.thiefGid) > 0 && Number(row.victimGid) > 0) : [];
    } catch { return []; }
})();

async function pushAlertMessage(title, content, options = {}) {
  const hook = String(process.env.ALERT_WEBHOOK || '').trim();
  if (!hook || typeof fetch !== 'function') return options.details ? { ok: false, resultState: 'not_sent', reason: 'not_configured' } : false;
  try {
    const endpoint = new URL(hook);
    const pushplus = endpoint.hostname === 'pushplus.plus' || endpoint.hostname.endsWith('.pushplus.plus');
    if (options.channel === 'mail' && !pushplus) return options.details ? { ok: false, resultState: 'not_sent', reason: 'mail_requires_pushplus' } : false;
    const body = pushplus
      ? { title, content, ...(options.channel ? { channel: options.channel, template: 'txt' } : {}) }
      : { msgtype: 'text', text: { content: `${title}\n${content}` } };
    const resp = await fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!pushplus && !options.details) return !!resp.ok;
    const data = pushplus ? await resp.json() : {};
    const accepted = resp.ok && (!pushplus || Number(data.code) === 200);
    const result = { ok: accepted, resultState: accepted ? 'accepted' : 'failed', delivered: false,
      shortCode: accepted && pushplus && typeof data.data === 'string' ? data.data : '',
      code: pushplus ? Number(data.code) : resp.status,
      message: pushplus && typeof data.msg === 'string' ? data.msg.slice(0, 300) : '' };
    return options.details ? result : accepted;
  } catch {
    return options.details ? { ok: false, resultState: 'unknown', delivered: false } : false;
  }
}

async function notifySolarQuiz({ accountId, accountName, events } = {}, dependencies = {}) {
  const candidates = (Array.isArray(events) ? events : []).filter(event => event.quizAvailable === true);
  if (!accountId || !candidates.length) return { skipped: true, reason: 'no_quiz' };
  const { createHash } = require('node:crypto');
  const { getDataFile } = require('../config/runtime-paths');
  const { writeJsonFileAtomic } = require('./json-db');
  const filename = getDataFile(path.join('solar-quiz-notified', `${createHash('sha256').update(String(accountId)).digest('hex').slice(0, 24)}.json`));
  const read = dependencies.read || (() => fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {});
  const write = dependencies.write || (state => writeJsonFileAtomic(filename, state));
  const send = dependencies.send || pushAlertMessage;
  const state = read();
  // Channel-scoped keys preserve the old mail audit trail without letting a
  // rejected/unknown mail reserve suppress the newly requested WeChat notice.
  const channel = 'wechat';
  const fresh = candidates.map(event => ({ event, key: createHash('sha256').update(JSON.stringify([channel, event.id, event.startTime, event.endTime])).digest('hex') }))
    .filter(item => !state[item.key] || ['failed', 'not_sent'].includes(state[item.key].resultState));
  if (!fresh.length) return { skipped: true, reason: 'already_notified' };
  // Reserve before sending: timeout/crash is delivery-unknown, not a reason to
  // spam the same WeChat notice on every poll. Explicit platform rejection is
  // retryable only after a 6h backoff. No game RPC or quiz submission from here.
  const now = Date.now();
  const retryable = fresh.filter(item => !state[item.key] || now - state[item.key].at >= 6 * 3600000);
  if (!retryable.length) return { skipped: true, reason: 'backoff' };
  const next = { ...state };
  for (const item of retryable) next[item.key] = { at: now, resultState: 'pending' };
  write(next);
  const deadline = seconds => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(seconds * 1000);
  const content = [`账号：${accountName || accountId}`, ...retryable.map(({ event }) => `· ${event.name || `节令 ${event.id}`}，截止 ${deadline(event.endTime)}（北京时间）`),
    '', '前往农场面板「活动 → 节令小礼」手动答题。基础小礼与答题额外奖励独立。',
    '每题只有一次机会：本提醒没有替你答题，也不代表参考答案已经核验。',
    '如题干未适配，请在官方游戏界面核对；不要凭旧答案索引直接提交。'].join('\n');
  // Exactly the daily-report sender's default channel/template; no mail
  // override and no second notification service or credential.
  const result = await send('农场节令有答题奖励待领取', content, { details: true });
  for (const item of retryable) next[item.key] = { at: now, channel, resultState: result.resultState,
    shortCode: result.shortCode || '', code: Number.isFinite(result.code) ? result.code : null,
    message: typeof result.message === 'string' ? result.message.slice(0, 300) : '' };
  write(next);
  return { ...result, eventIds: retryable.map(item => item.event.id), count: retryable.length };
}

/**
 * 偷取成功后调用：若被偷好友是本系统的另一个账号，则推送告警。
 * fire-and-forget，任何异常都不影响偷菜主流程。
 * @param {object} params
 * @param {string|number} params.myAccountId 当前账号 ID
 * @param {string|number} params.friendGid 被偷好友的 GID
 * @param {number} params.stolen 成功偷取的地块数
 * @param {string[]} [params.cropNames] 被偷作物名称列表
 */
function notifyCrossAccountSteal({ myAccountId, friendGid, stolen, cropNames = [] } = {}) {
  try {
    const targetGid = Number(friendGid);
    const count = Number(stolen) || 0;
    if (!targetGid || count <= 0) return;

    const { accounts = [] } = getAccounts() || {};
    const victim = accounts.find(a => Number(a.gid) === targetGid);
    if (!victim || String(victim.id) === String(myAccountId)) return;

    const thief = accounts.find(a => String(a.id) === String(myAccountId));
    if (!thief) return;

    // 仅命中预设组合才推送
    const hit = STEAL_ALERT_PAIRS.some(
      p => Number(p.thiefGid) === Number(thief.gid) && Number(p.victimGid) === targetGid
    );
    if (!hit) return;

    const thiefName = thief?.name || `账号${myAccountId}`;
    const crops = [...new Set(cropNames.filter(Boolean))].join('、');
    const title = `🥬 ${thiefName} 偷了 ${victim.name} 的菜`;
    const content = `偷取 ${count} 块${crops ? `（${crops}）` : ''}`;

    pushAlertMessage(title, content).catch(() => {});
  } catch (err) {
    logWarn('好友', `跨账号偷菜告警失败: ${err.message}`, {
      module: 'friend',
      event: '偷菜告警',
      result: 'error',
    });
  }
}

/**
 * Code 失效告警：账号 WebSocket 握手被服务器拒绝(HTTP 400)时调用。
 * 复用 ALERT_WEBHOOK(PushPlus) 通道，标题即正文。节流按账号持久化，避免重连刷屏。
 * @param {{accountId?:string, platform?:string, message?:string}} param0
 */
async function notifyCodeExpired({ accountId = '', platform = 'qq', message = '', needRescan = false, networkStopped } = {}) {
  const id = String(accountId || '');
  const now = Date.now();
  if (now - getLastCodeExpiredAlertAt(id) < ALERT_THROTTLE_MS) return false;
  setLastCodeExpiredAlertAt(id, now);

  let name = '';
  try {
    const { accounts = [] } = getAccounts() || {};
    const acc = accounts.find(a => String(a.id) === id);
    name = acc && acc.name ? acc.name : '';
  } catch {
    /* 名称查找失败则用账号 ID 兜底 */
  }
  const who = name || `账号${id || '未知'}`;
  const isWechat = ['wx', 'wechat', 'weixin'].includes(String(platform).toLowerCase());
  const title = isWechat ? `${who} 微信授权恢复需要处理` : `${who} 登录码不可用，请更新`;
  const content = isWechat
    ? `微信账号「${who}」登录授权恢复未成功${needRescan ? '，建议在面板重新扫码' : ''}`
      + `${message ? `：${message}` : ''}。请使用面板扫码登录，不需要抓包。`
      + (networkStopped === false ? '网关未停止，仍按预算退避重试。' : '')
    : `QQ账号「${who}」登录码已过期或无效${message ? `：${message}` : ''}。请更新QQ登录码后重新启动。`;
  return pushAlertMessage(title, content).catch(() => false);
}

module.exports = {
  notifyCrossAccountSteal,
  pushAlertMessage,
  notifyCodeExpired,
  notifySolarQuiz,
};
