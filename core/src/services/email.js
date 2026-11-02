/**
 * 邮箱服务 - 自动领取邮件奖励
 * 
 * 功能：
 * - 获取邮箱列表（系统邮件 + 玩家邮件）
 * - 批量领取邮件附件
 * - 每日自动检查并领取邮箱奖励
 */
const fs = require('node:fs');
const path = require('node:path');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, toNum } = require('../utils/utils');
const { getItemById } = require('../config/gameConfig');
const { getDataFile } = require('../config/runtime-paths');
const { pushAlertMessage } = require('./friend-alert');

const DAILY_KEY = 'email_rewards';

// 每日状态追踪
let doneDateKey = '';
let lastCheckAt = 0;

// 两次检查最小间隔：5分钟
const CHECK_COOLDOWN_MS = 5 * 60 * 1000;

// ---- 日期工具 ----

function getDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function markDoneToday() {
  doneDateKey = getDateKey();
}

function isDoneToday() {
  return doneDateKey === getDateKey();
}

// ---- RPC 调用 ----

async function getEmailList(boxType = 1) {
  const request = types.GetEmailListRequest.encode(
    types.GetEmailListRequest.create({ box_type: Number(boxType) || 1 })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'GetEmailList', request);
  return types.GetEmailListReply.decode(body);
}

async function claimEmail(boxType = 1, emailId = '') {
  const request = types.ClaimEmailRequest.encode(
    types.ClaimEmailRequest.create({
      box_type: Number(boxType) || 1,
      email_id: String(emailId || ''),
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'ClaimEmail', request);
  return types.ClaimEmailReply.decode(body);
}

async function batchClaimEmail(boxType = 0, emailId = '') {
  const request = types.BatchClaimEmailRequest.encode(
    types.BatchClaimEmailRequest.create({
      box_type: Number(boxType) || 0,
      email_id: String(emailId || ''),
    })
  ).finish();
  const { body } = await sendMsgAsync('gamepb.emailpb.EmailService', 'BatchClaimEmail', request);
  return types.BatchClaimEmailReply.decode(body);
}

// ---- 数据解析 ----

/**
 * 筛选出有未领取奖励的邮件
 */
function collectClaimableEmails(reply) {
  const emails = reply && Array.isArray(reply.emails) ? reply.emails : [];
  return emails.filter(
    (e) => e && e.id && e.has_reward === true && e.claimed !== true
  );
}

/**
 * 标准化邮箱类型：仅允许 1（系统）或 2（玩家），否则返回 0
 */
function normalizeBoxType(value) {
  const num = Number(value);
  return (num === 1 || num === 2) ? num : 0;
}

/**
 * 生成奖励摘要字符串
 * 1001 → 金币, 1002 → 经验, 500 → 点券
 */
function getRewardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const parts = [];
  for (const item of list) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    if (count <= 0) continue;
    if (id === 1001 || id === 500001) {
      parts.push(`金币${count}`);
    } else if (id === 1002 || id === 500002) {
      parts.push(`经验${count}`);
    } else if (id === 500) {
      parts.push(`点券${count}`);
    } else {
      const info = getItemById(id);
      const name = info && info.name ? String(info.name) : `物品#${id}`;
      parts.push(`${name}x${count}`);
    }
  }
  return parts.join('/');
}

// ---- 主逻辑 ----

/**
 * 检查并领取所有邮箱奖励
 * @param {boolean} force - 强制检查（跳过每日完成和冷却检查）
 */
async function checkAndClaimEmails(force = false) {
  const now = Date.now();
  const emptyResult = { claimed: 0, rewardItems: 0 };

  if (!force && isDoneToday()) return emptyResult;

  const result = { claimed: 0, rewardItems: 0 };

  if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) return result;

  lastCheckAt = now;

  try {
    // 同时获取两种邮箱类型的列表
    const [boxType1Reply, boxType2Reply] = await Promise.all([
      getEmailList(1).catch(() => ({ emails: [] })),
      getEmailList(2).catch(() => ({ emails: [] })),
    ]);

    // 合并去重邮件
    const merged = new Map();
    const list1 = (boxType1Reply.emails || []).map((e) => ({ ...e, __boxType: 1 }));
    const list2 = (boxType2Reply.emails || []).map((e) => ({ ...e, __boxType: 2 }));

    for (const email of [...list1, ...list2]) {
      if (!email || !email.id) continue;
      if (!merged.has(email.id)) {
        merged.set(email.id, email);
        continue;
      }
      const existing = merged.get(email.id);
      const existingClaimable = !!(existing && existing.has_reward === true && existing.claimed !== true);
      const newClaimable = !!(email && email.has_reward === true && email.claimed !== true);
      // 优先保留可领取的那个
      if (!existingClaimable && newClaimable) {
        merged.set(email.id, email);
      }
    }

    const claimable = collectClaimableEmails({ emails: [...merged.values()] });

    if (claimable.length === 0) {
      markDoneToday();
      log('邮箱', '今日暂无可领取邮箱奖励', { module: 'task', event: DAILY_KEY, result: 'none' });
      return { claimed: 0, rewardItems: 0 };
    }

    const allItems = [];
    let claimed = 0;

    // 按邮箱类型分组
    const groupedByBox = new Map();
    for (const email of claimable) {
      const box = normalizeBoxType(email && email.__boxType);
      if (!groupedByBox.has(box)) groupedByBox.set(box, []);
      groupedByBox.get(box).push(email);
    }

    // 先尝试批量领取
    for (const [boxType, emails] of groupedByBox.entries()) {
      try {
        const firstId = String(emails[0] && emails[0].id || '');
        if (firstId) {
          const batchResult = await batchClaimEmail(boxType, firstId);
          if (Array.isArray(batchResult.items) && batchResult.items.length > 0) {
            allItems.push(...batchResult.items);
          }
          claimed += 1;
        }
      } catch (_) {
        // 批量领取失败，下面逐个重试
      }
    }

    // 逐个领取（回退）
    for (const email of claimable) {
      const boxType = normalizeBoxType(email && email.__boxType);
      try {
        const result = await claimEmail(boxType, String(email.id || ''));
        if (Array.isArray(result.items) && result.items.length > 0) {
          allItems.push(...result.items);
        }
        claimed += 1;
      } catch (_) {
        // 单个失败跳过
      }
    }

    if (claimed > 0) {
      const summary = getRewardSummary(allItems);
      log('邮箱',
        summary
          ? `[邮箱领取] 领取成功 ${claimed} 封 → ${summary}`
          : `[邮箱领取] 领取成功 ${claimed} 封`,
        { module: 'task', event: DAILY_KEY, result: 'ok', count: claimed }
      );
      markDoneToday();
    }

    return { claimed, rewardItems: allItems.length };
  } catch (err) {
    log('邮箱', `领取邮箱奖励失败: ${err.message}`, {
      module: 'task', event: DAILY_KEY, result: 'error',
    });
    return { claimed: 0, rewardItems: 0 };
  }
}

// ---- 新系统邮件推送（PushPlus，走 ALERT_WEBHOOK） ----

const PUSHED_STATE_FILE = () => getDataFile('email-pushed.json');
const MAX_SEEN_IDS = 500;

function getAccountKey() {
  return String(process.env.FARM_ACCOUNT_ID || 'default');
}

function loadPushedState() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSHED_STATE_FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function savePushedState(state) {
  try {
    fs.mkdirSync(path.dirname(PUSHED_STATE_FILE()), { recursive: true });
    fs.writeFileSync(PUSHED_STATE_FILE(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (_) {
    // 状态落盘失败不影响主流程
  }
}

/**
 * 检查系统邮箱（box_type=1），发现新邮件即 PushPlus 推送标题+原文。
 * 已推送邮件 id 持久化在 data/email-pushed.json（按账号隔离），只增不减防重复推送。
 * @returns {Promise<number>} 新推送的邮件数
 */
async function notifyNewSystemEmails() {
  let listReply;
  try {
    listReply = await getEmailList(1);
  } catch (err) {
    log('邮箱', `获取系统邮件列表失败（推送跳过）: ${err.message}`, {
      module: 'task', event: 'email_push', result: 'error',
    });
    return 0;
  }
  const emails = (listReply && Array.isArray(listReply.emails) ? listReply.emails : [])
    .filter((e) => e && e.id);
  if (!emails.length) return 0;

  const accountKey = getAccountKey();
  const state = loadPushedState();
  const accounts = state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  const seen = new Set(Array.isArray(accounts[accountKey]?.seenIds) ? accounts[accountKey].seenIds : []);

  let pushed = 0;
  for (const email of emails) {
    const id = String(email.id);
    if (seen.has(id)) continue;
    const title = String(email.title || '').trim() || '新邮件';
    const subtitle = String(email.subtitle || '').trim();
    const content = subtitle || (email.has_reward ? '（含待领取奖励）' : title);
    // 标题即正文：事件直接写标题，原文放内容
    pushAlertMessage(`📮 农场新邮件：${title}`, content).catch(() => {});
    pushed += 1;
    seen.add(id);
  }

  if (pushed > 0) {
    log('邮箱', `推送新系统邮件 ${pushed} 封`, {
      module: 'task', event: 'email_push', result: 'ok', count: pushed,
    });
  }
  accounts[accountKey] = {
    ...(accounts[accountKey] || {}),
    seenIds: [...seen].slice(-MAX_SEEN_IDS),
    lastCheckAt: Date.now(),
  };
  state.accounts = accounts;
  savePushedState(state);
  return pushed;
}

module.exports = {
  getEmailList,
  claimEmail,
  batchClaimEmail,
  checkAndClaimEmails,
  notifyNewSystemEmails,
  getEmailDailyState: () => ({
    key: DAILY_KEY,
    doneToday: isDoneToday(),
    lastCheckAt,
  }),
};
