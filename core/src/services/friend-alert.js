/**
 * 跨账号偷菜告警推送
 *
 * 当指定账号（面壁者比尔·希恩斯）偷取了指定目标（面壁者罗辑）的菜时，推送提醒。
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
 * 目前仅：面壁者比尔·希恩斯 偷 面壁者罗辑。
 */
const STEAL_ALERT_PAIRS = [
  { thiefGid: 1000000003, victimGid: 1000000001 },
];

async function pushAlertMessage(title, content) {
  const hook = String(process.env.ALERT_WEBHOOK || '').trim();
  if (!hook || typeof fetch !== 'function') return false;
  try {
    const body = /pushplus/i.test(hook)
      ? { title, content }
      : { msgtype: 'text', text: { content: `${title}\n${content}` } };
    const resp = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return !!resp.ok;
  } catch {
    return false;
  }
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
async function notifyCodeExpired({ accountId = '', platform = 'qq', message = '' } = {}) {
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
  const plat = String(platform).toLowerCase() === 'wechat' ? '微信' : 'QQ';
  const title = `🔑 ${who} 登录失效，请更新 Code`;
  const content =
    `${plat}账号「${who}」连接被服务器拒绝(HTTP 400)，Code 已过期或无效` +
    `${message ? `：${message}` : ''}。请到面板用抓包登录更新 Code 后重新启动。`;
  return pushAlertMessage(title, content).catch(() => false);
}

module.exports = {
  notifyCrossAccountSteal,
  pushAlertMessage,
  notifyCodeExpired,
};
