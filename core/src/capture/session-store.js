/**
 * 抓包会话管理
 *
 * 每个会话对应一次 iPhone 抓包登录流程：
 * - 独立 MITM 代理端口
 * - 抓到的 code/openid
 * - 好友 GID 集合与来源
 * - 对外公布的代理地址（多 IP：局域网 / Tailscale）
 */

const fs = require('fs');
const ARCHIVE_PATH = process.env.CAPTURE_ARCHIVE_PATH || '/tmp/capture-archive.jsonl';
const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

/** 把抓到的原始游戏消息追加到本地归档文件（用于离线逆向游戏公告等未知协议） */
function appendArchive(entry) {
  try {
    if (fs.existsSync(ARCHIVE_PATH) && fs.statSync(ARCHIVE_PATH).size > ARCHIVE_MAX_BYTES) {
      fs.writeFileSync(ARCHIVE_PATH, '');
    }
    fs.appendFileSync(ARCHIVE_PATH, JSON.stringify(entry) + '\n');
  } catch { /* 调试写盘失败不影响主流程 */ }
}

function createSessionStore({ config } = {}) {
  const sessions = new Map();

  function createSession(id, platform = 'qq') {
    const session = {
      id,
      platform: platform === 'wx' ? 'wx' : 'qq',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancelled: false,
      completed: false,
      code: '',
      openId: '',
      accountGid: '',
      friendGids: new Set(),
      friendSource: '',
      friendListComplete: false,
      proxy: {
        running: false,
        status: 'idle',
        error: '',
        port: 0,
        startedAt: '',
      },
      publicInfo: {
        host: '',
        addresses: [],
        mitmPort: 0,
        mitmProxyAutoStopSec: config.autoStopSec || 900,
        certUrl: '/cert/mitmproxy-ca-cert.cer',
      },
      bypassHosts: [],
      rawMessages: [],
    };
    sessions.set(id, session);
    return session;
  }

  function getSession(id) {
    return sessions.get(String(id || '')) || null;
  }

  function hasSession(id) {
    return sessions.has(String(id || ''));
  }

  function deleteSession(id) {
    const key = String(id || '');
    const session = sessions.get(key);
    if (session && session.proxy && typeof session.proxy.stop === 'function') {
      try {
        session.proxy.stop();
      } catch { /* 忽略 */ }
    }
    sessions.delete(key);
  }

  function markUpdated(session) {
    session.updatedAt = Date.now();
  }

  /** 启动代理后记录代理信息 */
  function setProxyInfo(session, proxyInfo) {
    session.proxy = {
      running: proxyInfo.running === true,
      status: proxyInfo.status || 'running',
      error: proxyInfo.error || '',
      port: Number(proxyInfo.port) || 0,
      startedAt: proxyInfo.startedAt || new Date().toISOString(),
      stop: proxyInfo.stop || null,
    };
    session.publicInfo = {
      host: proxyInfo.host || '',
      addresses: Array.isArray(proxyInfo.addresses) ? proxyInfo.addresses : [],
      mitmPort: Number(proxyInfo.port) || 0,
      mitmProxyAutoStopSec: proxyInfo.autoStopSec || config.autoStopSec || 900,
      certUrl: proxyInfo.certUrl || '/cert/mitmproxy-ca-cert.cer',
    };
    if (Array.isArray(proxyInfo.bypassHosts)) session.bypassHosts = proxyInfo.bypassHosts;
    markUpdated(session);
  }

  function setProxyError(session, error) {
    if (!session.proxy) session.proxy = {};
    session.proxy.error = String(error || '');
    session.proxy.status = 'error';
    session.proxy.running = false;
    markUpdated(session);
  }

  /** 记录抓到的登录 code / openid */
  function addCode(session, { code = '', openId = '' } = {}) {
    let changed = false;
    const cleanCode = String(code || '').trim();
    const cleanOpenId = String(openId || '').trim();
    if (cleanCode && !session.code) {
      session.code = cleanCode;
      changed = true;
    }
    if (cleanOpenId && !session.openId) {
      session.openId = cleanOpenId;
      changed = true;
    }
    if (changed) markUpdated(session);
    return changed;
  }

  /** 记录本次登录账号自身的 GID（来自 LoginReply.basic.gid） */
  function addAccountGid(session, gid) {
    const num = Number(gid);
    if (!Number.isSafeInteger(num) || num <= 0) return false;
    const value = String(num);
    if (session.accountGid === value) return false;
    session.accountGid = value;
    markUpdated(session);
    return true;
  }

  /** 记录好友 GID（去重） */
  function addFriendGids(session, { gids = [], source = '', complete = false } = {}) {
    let changed = false;
    for (const gid of Array.isArray(gids) ? gids : []) {
      const num = Number(gid);
      if (Number.isSafeInteger(num) && num > 0 && !session.friendGids.has(num)) {
        session.friendGids.add(num);
        changed = true;
      }
    }
    if (source) session.friendSource = source;
    if (complete) session.friendListComplete = true;
    if (changed || source || complete) markUpdated(session);
    return changed;
  }

  /** 记录原始游戏消息（用于逆向游戏公告等未知协议）：service/method/msgType/bodyHex */
  function addRawMessage(session, msg) {
    if (!session) return;
    if (!Array.isArray(session.rawMessages)) session.rawMessages = [];
    session.rawMessages.push(msg);
    if (session.rawMessages.length > 2000) session.rawMessages.shift();
    appendArchive({ ts: Date.now(), sessionId: session.id, ...msg });
    markUpdated(session);
  }

  function getRawMessages(session) {
    return Array.isArray(session.rawMessages) ? session.rawMessages : [];
  }

  function getCodesArray(session) {
    if (!session.code && !session.openId) return [];
    return [{ code: session.code, gid: session.accountGid || '', openid: session.openId }];
  }

  function buildSnapshot(session) {
    return {
      channels: {
        [session.platform]: {
          status: session.code ? 'captured' : (session.proxy.running ? 'running' : 'idle'),
          codes: getCodesArray(session),
        },
      },
      friends: {
        source: session.friendSource,
        items: [...session.friendGids].sort((a, b) => a - b).map(gid => ({ gid: String(gid) })),
        complete: session.friendListComplete === true,
      },
      publicInfo: { ...session.publicInfo },
      proxy: {
        running: session.proxy.running === true,
        status: session.proxy.status || 'idle',
        error: session.proxy.error || '',
        startedAt: session.proxy.startedAt || '',
      },
      captured: !!session.code,
      accountGid: session.accountGid || '',
      rawMessageCount: Array.isArray(session.rawMessages) ? session.rawMessages.length : 0,
    };
  }

  function listSessions() {
    return [...sessions.keys()];
  }

  /** 清理过期会话 */
  function cleanupExpired() {
    const cutoff = Date.now() - (config.sessionTtlMs || 60 * 60 * 1000);
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff && !session.completed) {
        deleteSession(id);
      }
    }
  }

  return {
    addAccountGid,
    addCode,
    addFriendGids,
    addRawMessage,
    buildSnapshot,
    getRawMessages,
    cleanupExpired,
    createSession,
    deleteSession,
    getCodesArray,
    getSession,
    hasSession,
    listSessions,
    markUpdated,
    setProxyError,
    setProxyInfo,
  };
}

module.exports = { createSessionStore };
