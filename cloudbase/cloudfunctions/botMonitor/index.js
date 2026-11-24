// botMonitor: QQ 农场 bot 掉线监控
// 两种模式：
// - 定时触发（每5分钟）：拉取 Azure 面板账号状态，与上次快照对比，
//   账号掉线/恢复/服务器不可达时写告警并推送 webhook
// - HTTP 触发（网关 /botMonitor）：给手机面板提供实时状态 + 最近告警列表
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: process.env.ENV_ID || process.env.TCB_ENV });
const db = app.database();
const _ = db.command;
const COLL = 'bot_monitor';

// 备用面板网关域名（腾讯云 CloudBase）：在掉线/服务器不可达等告警里附带，免得忘记还有这个入口
const GATEWAY_URL = process.env.GATEWAY_URL
  || 'https://hunyuan-d3gmfp6yb0b9cc97b-1469582266.ap-shanghai.app.tcloudbase.com/botMonitor';
// 在告警正文里附上备用面板域名
const withGateway = (msg) => `${msg}\n备用面板：${GATEWAY_URL}`;

// ---------------------------------------------------------------------------
// 面板 API 客户端（服务端登录 + token 缓存，与 botProxy 同款）
// ---------------------------------------------------------------------------

let cachedToken = '';

async function panelLogin() {
  const resp = await fetch(`${process.env.PANEL_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      username: process.env.PANEL_USER,
      password: process.env.PANEL_PASS,
    }),
  });
  const data = await resp.json().catch(() => null);
  const token = data?.data?.token || '';
  if (!resp.ok || !token) throw new Error(data?.error || `login failed (HTTP ${resp.status})`);
  return token;
}

async function getAdminToken(force = false) {
  if (!cachedToken || force) cachedToken = await panelLogin();
  return cachedToken;
}

async function fetchPanel(path, force = false) {
  const token = await getAdminToken(force);
  let resp = await fetch(`${process.env.PANEL_URL}${path}`, {
    headers: { 'x-admin-token': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401 && !force) {
    resp = await fetchPanel(path, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// NoSQL 快照读写
// ---------------------------------------------------------------------------

async function getSnapshot() {
  try {
    const res = await db.collection(COLL).doc('snapshot').get();
    const doc = Array.isArray(res.data) ? res.data[0] : res.data;
    return doc && doc.checkedAt ? doc : null;
  } catch {
    return null;
  }
}

async function saveSnapshot(snapshot) {
  const payload = { ...snapshot, updatedAt: new Date().toISOString() };
  try {
    await db.collection(COLL).doc('snapshot').set(payload);
  } catch {
    try {
      await db.collection(COLL).add({ _id: 'snapshot', ...payload });
    } catch { /* 并发竞争时忽略 */ }
  }
}

async function pushAlert(msg) {
  const hook = process.env.ALERT_WEBHOOK;
  if (!hook) return;
  try {
    if (/pushplus/i.test(hook)) {
      // PushPlus 微信推送：URL 形如 http://www.pushplus.plus/send/{token}
      // 标题即正文：简短事件直接写在标题上，无需点开详情
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: msg, content: msg }),
      });
    } else {
      // 企业微信群机器人等：text 消息格式
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: msg } }),
      });
    }
  } catch { /* 推送失败不影响主流程 */ }
}

// ---------------------------------------------------------------------------
// 活动更新分析（读取面板的活动分析报告，发现新候选活动 ID 时告警）
// ---------------------------------------------------------------------------

async function fetchActivityReport() {
  try {
    const resp = await fetchPanel('/api/activity/update/status');
    if (!resp.ok) return null;
    const data = await resp.json();
    const report = data?.report;
    if (!report) return null;
    const ids = (report.unknownActivityIds || []).map(Number).sort((a, b) => a - b);
    // 尽量从在线分组快照里拿活动标题
    const titles = new Map();
    for (const g of report.online?.groups || []) {
      if (Number(g?.id) > 0 && g?.title) titles.set(Number(g.id), String(g.title));
    }
    return { ids, titles, scannedAt: report.scannedAt || null, status: report.status || '' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 巡检（定时触发）
// ---------------------------------------------------------------------------

async function runCheck() {
  const nowIso = new Date().toISOString();
  let serverReachable = true;
  const accounts = {};
  try {
    const health = await fetchPanel('/api/health');
    if (!health.ok) throw new Error(`health HTTP ${health.status}`);
    const resp = await fetchPanel('/api/accounts');
    if (!resp.ok) throw new Error(`accounts HTTP ${resp.status}`);
    const data = await resp.json();
    const list = data?.data?.accounts || data?.accounts || [];
    for (const a of list) {
      accounts[String(a.id)] = {
        name: a.name || String(a.id),
        running: a.running === true,
        gid: a.gid || '',
        platform: a.platform || '',
      };
    }
  } catch {
    serverReachable = false;
  }

  const prev = await getSnapshot();
  const alerts = [];

  // 新活动发现检测（与账号状态无关，服务器可达就查）
  let activityIds = prev?.activityIds || [];
  if (serverReachable) {
    const act = await fetchActivityReport();
    if (act && act.ids.length) {
      activityIds = act.ids;
      const known = new Set(prev?.activityIds || []);
      const fresh = prev ? act.ids.filter(id => !known.has(id)) : [];
      if (fresh.length) {
        const desc = fresh.map(id => {
          const title = act.titles.get(id);
          return title ? `${title}（ID ${id}）` : `ID ${id}`;
        }).join('、');
        alerts.push({
          kind: 'new-activity', name: '新活动',
          msg: `🎉 发现未来新活动：${desc}。接入仍需抓包，请在面板活动页查看详情`,
        });
      }
    }
  }

  if (prev) {
    if (serverReachable) {
      if (prev.serverReachable === false) {
        alerts.push({ kind: 'server_up', name: '服务器', msg: withGateway('✅ Azure 面板恢复访问') });
      }
      for (const [id, cur] of Object.entries(accounts)) {
        const old = prev.accounts?.[id];
        if (old && old.running === true && cur.running === false) {
          alerts.push({
            kind: 'offline', accountId: id, name: cur.name,
            msg: withGateway(`⚠️ ${cur.name} 掉线了（bot 已停止），可能需要重新抓包`),
          });
        } else if (old && old.running === false && cur.running === true) {
          alerts.push({ kind: 'recovered', accountId: id, name: cur.name, msg: withGateway(`✅ ${cur.name} 已恢复运行`) });
        }
      }
    } else if (prev.serverReachable !== false) {
      alerts.push({ kind: 'server_down', name: '服务器', msg: withGateway('🔴 Azure 面板无法访问（服务器可能宕机或网络故障）') });
    }
  }

  // 逐条存历史（便于面板/备用页查看）；推送则合并：同周期多个掉线/恢复合并为一条，
  // 避免 PushPlus 免费档频控把后发的几条吞掉（多账号同时掉线时尤其明显，表现为"推送不全"）
  for (const al of alerts) {
    await db.collection(COLL).add({ type: 'alert', at: nowIso, ...al }).catch(() => {});
  }
  const offline = alerts.filter(a => a.kind === 'offline');
  const recovered = alerts.filter(a => a.kind === 'recovered');
  const others = alerts.filter(a => a.kind !== 'offline' && a.kind !== 'recovered');
  for (const al of others) {
    await pushAlert(al.msg);
  }
  if (recovered.length) {
    const names = recovered.map(a => a.name).join('、');
    await pushAlert(withGateway(`✅ ${recovered.length} 个账号已恢复运行：${names}`));
  }
  if (offline.length) {
    const names = offline.map(a => a.name).join('、');
    await pushAlert(withGateway(`⚠️ ${offline.length} 个账号掉线（bot 已停止），可能需要重新抓包：${names}`));
  }

  await saveSnapshot({ type: 'snapshot', accounts, serverReachable, activityIds, checkedAt: nowIso });

  // 清理 7 天前的告警，避免集合膨胀
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  await db.collection(COLL).where({ type: 'alert', at: _.lt(cutoff) }).remove().catch(() => {});

  return { first: !prev, alerts: alerts.length, serverReachable };
}

// ---------------------------------------------------------------------------
// HTTP API（手机面板调用）
// ---------------------------------------------------------------------------

async function apiMode(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-bot-token',
    'Access-Control-Max-Age': '86400',
  };
  const json = (status, obj) => ({
    statusCode: status,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

  // 实时状态（直连 Azure）
  let live = null;
  let serverReachable = true;
  try {
    const resp = await fetchPanel('/api/accounts');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    live = (data?.data?.accounts || data?.accounts || []).map(a => ({
      id: String(a.id), name: a.name, platform: a.platform,
      running: a.running === true, gid: a.gid || '',
    }));
  } catch {
    serverReachable = false;
  }

  // 最近告警
  let alerts = [];
  try {
    const res = await db.collection(COLL).where({ type: 'alert' }).orderBy('at', 'desc').limit(30).get();
    alerts = res.data || [];
  } catch { /* 集合为空等情况 */ }

  const snap = await getSnapshot();
  const payload = { serverReachable, accounts: live, alerts, lastCheckedAt: snap?.checkedAt || null };

  // 人类浏览器直接访问（无 x-bot-token 的 GET）：返回只读 HTML 状态页，微信里点开即可看
  if (event.httpMethod === 'GET' && !headers['x-bot-token']) {
    return renderStatusPage(payload);
  }

  // 带密钥的请求：返回 JSON（手机面板用）
  if (!process.env.BOT_TOKEN || headers['x-bot-token'] !== process.env.BOT_TOKEN) {
    return json(401, { ok: false, error: 'invalid token' });
  }
  return json(200, { ok: true, data: payload });
}

// 只读 HTML 状态页：微信/浏览器点开网关域名 /botMonitor 即可查看，无需密钥
function renderStatusPage(data) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const reach = data.serverReachable
    ? '<span style="color:#22c55e">● Azure 可访问</span>'
    : '<span style="color:#ef4444">● Azure 不可访问</span>';
  const accRows = (data.accounts || []).map(a => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #263449">
      <span style="width:9px;height:9px;border-radius:50%;background:${a.running ? '#22c55e' : '#ef4444'}"></span>
      <span style="flex:1">${esc(a.name || a.id)}</span>
      <span style="color:${a.running ? '#22c55e' : '#ef4444'};font-size:13px">${a.running ? '运行中' : '已停止'}</span>
    </div>`).join('') || '<div style="color:#94a3b8;padding:8px 0">（无账号 / 服务器不可达）</div>';
  const alertRows = (data.alerts || []).slice(0, 20).map(al => `
    <div style="padding:8px 0;border-bottom:1px solid #263449;font-size:13px">
      <div>${esc(al.msg || '')}</div>
      <div style="color:#94a3b8;font-size:11px;margin-top:2px">${fmt(al.at)}</div>
    </div>`).join('') || '<div style="color:#94a3b8;padding:8px 0">暂无告警 ✓</div>';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ农场 Bot 状态</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:16px">
  <h1 style="font-size:18px;margin:0 0 4px">QQ农场 Bot · 备用状态页</h1>
  <div style="color:#94a3b8;font-size:12px;margin-bottom:14px">最近巡检：${fmt(data.lastCheckedAt)} · 每5分钟自动检查</div>
  <div style="font-size:14px;margin-bottom:12px">${reach}</div>
  <div style="background:#1e293b;border-radius:14px;padding:12px 14px;margin-bottom:14px">${accRows}</div>
  <h2 style="font-size:14px;color:#94a3b8;margin:0 0 8px">最近告警（7天内）</h2>
  <div style="background:#1e293b;border-radius:14px;padding:12px 14px">${alertRows}</div>
  <div style="color:#64748b;font-size:11px;margin-top:16px;line-height:1.6">本页只读。完整操作面板（启停账号）见本地 panel/index.html，需 48 位访问密钥。</div>
</div></body></html>`;
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
}

exports.main = async (event) => {
  if (event && event.httpMethod) return apiMode(event);
  return runCheck();
};
