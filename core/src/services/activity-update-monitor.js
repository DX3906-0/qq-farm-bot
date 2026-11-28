const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const { scanActivityUpdates } = require('./activity-update-scanner');
const { pushAlertMessage } = require('./friend-alert');
const { describeFamilyHint } = require('../config/activity-families');

// 活动一般按天结算，默认每天扫描一次
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const STATE_FILE = getDataFile('activity-update-report.json');
// 已推送过的活动 ID 集合，避免同一活动每天重复推送
const PUSHED_FILE = getDataFile('activity-update-pushed.json');

let timer = null;
let running = false;
let report = null;
let knownActivityIds = [];
let intervalMs = DEFAULT_INTERVAL_MS;
let nextScanAt = 0;
let onlineScanner = null;
let localScanEnabled = false;

/**
 * 读取已推送的活动 ID 集合（持久化，防重复推送）。
 */
function readPushedIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'));
    return new Set((Array.isArray(raw) ? raw : raw?.ids || []).map(Number).filter(Number.isFinite));
  } catch {
    return new Set();
  }
}

function writePushedIds(ids) {
  try {
    fs.mkdirSync(require('node:path').dirname(PUSHED_FILE), { recursive: true });
    fs.writeFileSync(PUSHED_FILE, `${JSON.stringify([...ids].sort((a, b) => a - b), null, 2)}\n`);
  } catch (error) {
    console.warn(`[活动更新] 保存推送记录失败: ${error.message}`);
  }
}

/**
 * 发现新活动时通过 ALERT_WEBHOOK（PushPlus）推送。
 * 只推送从未推送过的活动 ID；标题即结论，正文给出活动 ID 与标题清单。
 */
async function notifyNewActivities(reportValue) {
  const ids = [...new Set((reportValue?.unknownActivityIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return;
  const pushed = readPushedIds();
  const fresh = ids.filter(id => !pushed.has(id));
  if (!fresh.length) return;

  // 从在线扫描结果里取活动标题，缺省则用 ID 兜底。
  const titleById = new Map();
  for (const item of (reportValue?.online?.activities || [])) {
    const id = Number(item?.id);
    if (Number.isFinite(id) && item?.title) titleById.set(id, String(item.title));
  }
  for (const group of (reportValue?.online?.groups || [])) {
    const id = Number(group?.id);
    if (Number.isFinite(id) && group?.title && !titleById.has(id)) titleById.set(id, String(group.title));
  }

  // 快照指纹：用于判定新活动归属哪一族、可照哪个既有活动换皮。
  // 键同时登记活动 ID 与标题，兼容「只拿到标题没拿到 ID」的探测结果。
  const snapshotById = new Map();
  const snapshotByTitle = new Map();
  for (const group of (reportValue?.online?.groups || [])) {
    const id = Number(group?.id);
    if (Number.isFinite(id)) snapshotById.set(id, group);
    if (group?.title) snapshotByTitle.set(String(group.title), group);
  }
  const hintFor = (id, title) => {
    const snapshot = snapshotById.get(id) || snapshotByTitle.get(title);
    if (!snapshot) return '';
    try {
      return describeFamilyHint(snapshot);
    } catch {
      return '';
    }
  };

  const lines = fresh
    .sort((a, b) => b - a)
    .map((id) => {
      const title = titleById.get(id) || '(标题待确认)';
      const hint = hintFor(id, title);
      return hint ? `· ${id} ${title}\n  → ${hint}` : `· ${id} ${title}`;
    });
  const title = `农场发现新活动 ${fresh.length} 个`;
  const content = [
    `扫描时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `新活动 ID 数量：${fresh.length}`,
    '',
    ...lines,
    '',
    '可在面板「活动」页查看在线活动分组；族谱见 core/src/config/activity-families.js，',
    '按提示在相近族成员基础上换皮改造（改 ID/uid/文案/UI，复用族内骨架）。',
  ].join('\n');

  const ok = await pushAlertMessage(title, content);
  if (ok) {
    for (const id of fresh) pushed.add(id);
    writePushedIds(pushed);
    console.log(`[活动更新] 已推送 ${fresh.length} 个新活动通知: ${fresh.join(', ')}`);
  } else {
    console.warn('[活动更新] 新活动推送失败（ALERT_WEBHOOK 未配置或请求失败），下次扫描将重试');
  }
}

function emptyLocalReport() {
  return {
    scannedAt: Date.now(),
    appId: '1112386029',
    source: null,
    candidateCount: 0,
    incompleteCandidates: [],
    detectedActivityIds: [],
    unknownActivityIds: [],
    caches: [],
    warnings: [],
    localScanEnabled: false,
  };
}

function readSavedReport() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSavedReport(value) {
  try {
    fs.mkdirSync(require('node:path').dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    console.warn(`[活动更新] 保存分析结果失败: ${error.message}`);
  }
}

function analyzeReport(scanned, previous, online = null) {
  // 正式候选必须得到在线接口确认。本机源码/缓存仅作为辅助证据展示。
  const candidateIds = [...new Set(online?.unknownActivityIds || [])]
    .sort((a, b) => b - a);
  const groups = new Map();
  for (const id of candidateIds) {
    const date = String(id).slice(0, 8);
    const items = groups.get(date) || [];
    items.push(id);
    groups.set(date, items);
  }
  const previousVersion = previous?.source?.version || '';
  return {
    ...scanned,
    status: !scanned.source && !online?.available
      ? 'unavailable'
      : candidateIds.length ? 'update-found' : 'up-to-date',
    unknownActivityIds: candidateIds,
    online,
    localEvidence: {
      enabled: scanned.localScanEnabled === true,
      unknownActivityIds: scanned.unknownActivityIds || [],
      detectedActivityIds: scanned.detectedActivityIds || [],
      source: scanned.source || null,
      caches: scanned.caches || [],
      warnings: scanned.warnings || [],
    },
    sourceChanged: !!previousVersion && previousVersion !== scanned.source?.version,
    previousSourceVersion: previousVersion || null,
    analysis: {
      candidateGroups: [...groups.entries()].map(([date, ids]) => ({ date, ids })),
      requiresProtocolSample: candidateIds.length > 0,
      safeToAutoApply: false,
      summary: candidateIds.length
        ? `发现 ${candidateIds.length} 个候选活动 ID，已自动读取在线活动列表和只读活动分组`
        : online?.available
          ? '在线活动列表未发现尚未登记的新活动'
          : '在线分析等待已连接账号',
    },
  };
}

async function runActivityUpdateScan() {
  if (running) return report;
  running = true;
  try {
    const previous = report || readSavedReport();
    const scanned = localScanEnabled
      ? { ...scanActivityUpdates({ knownActivityIds }), localScanEnabled: true }
      : emptyLocalReport();
    let online = null;
    if (typeof onlineScanner === 'function') {
      try {
        online = await onlineScanner(knownActivityIds, scanned);
      } catch (error) {
        online = { available: false, error: error.message || String(error), activities: [], groups: [], unknownActivityIds: [] };
      }
    }
    report = analyzeReport(scanned, previous, online);
    writeSavedReport(report);
    // 发现新活动时推送（fire-and-forget，失败不影响扫描结果）
    notifyNewActivities(report).catch(error => {
      console.warn(`[活动更新] 推送新活动通知异常: ${error.message}`);
    });
    return report;
  } finally {
    running = false;
    nextScanAt = Date.now() + intervalMs;
  }
}

function scheduleNextScan() {
  if (timer) clearTimeout(timer);
  nextScanAt = Date.now() + intervalMs;
  timer = setTimeout(async () => {
    try {
      await runActivityUpdateScan();
    } catch (error) {
      console.warn(`[活动更新] 定时分析失败: ${error.message}`);
    } finally {
      scheduleNextScan();
    }
  }, intervalMs);
  timer.unref?.();
}

function startActivityUpdateMonitor(options = {}) {
  knownActivityIds = (options.knownActivityIds || []).map(Number);
  onlineScanner = typeof options.onlineScanner === 'function' ? options.onlineScanner : null;
  localScanEnabled = options.localScanEnabled === true
    || String(process.env.ACTIVITY_LOCAL_SCAN_ENABLED || '').toLowerCase() === 'true';
  intervalMs = Math.max(MIN_INTERVAL_MS, Number(options.intervalMs) || Number(process.env.ACTIVITY_UPDATE_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  report = report || readSavedReport();
  scheduleNextScan();
  setImmediate(() => runActivityUpdateScan().catch(error => {
    console.warn(`[活动更新] 初始分析失败: ${error.message}`);
  }));
}

function getActivityUpdateState() {
  return {
    running,
    intervalMs,
    nextScanAt,
    report: report || readSavedReport(),
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  analyzeReport,
  getActivityUpdateState,
  notifyNewActivities,
  runActivityUpdateScan,
  startActivityUpdateMonitor,
};
