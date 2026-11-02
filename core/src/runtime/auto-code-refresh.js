const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { createScheduler } = require('../services/scheduler');
const { getDataDir } = require('../config/runtime-paths');

/**
 * ⭐ 本机换码（首选路径）：不依赖任何第三方取码服务。
 *
 * 背景（2026-10-27）：公共取码服务域名 `code.z74d.top` 已 NXDOMAIN 永久失效，
 * 导致微信号每次断线都刷不到新 Code → 无限「刷新失败→启动→离线」循环。
 * 而 `services/wx-login/` 里本来就有完整的**本机实现**：
 *   扫码 createQrSession/poll/confirm → 拿 loginBuffer(+refreshtoken) → issueCode 换农场 Code。
 * 会话已由 gateway 的主动保活（`keepWxCredentialAlive`）滚动续期并落盘到
 *   `<dataDir>/wx-login/<openid>.json`（字段：openid/appId/loginBuffer/refreshtoken/accesstoken），
 * 所以只要该文件在，就能直接换码，无需再请求任何公共取码服务。
 */
const WX_LOGIN_DIR = path.join(getDataDir(), 'wx-login');

/**
 * 性能/风控护栏（2026-10-27）——本机换码走 MMTLS 原生握手（内部最多试 12 个 IP ×5s），
 * 比原来一次 HTTP 请求重得多，且微信对「同一 openid 高频调授权接口」会打 40188 风控标签，
 * 所以必须三道闸：
 *   1) 单飞（single-flight）：同一 openid 的换码并发请求复用同一个 Promise，
 *      避免断线风暴时叠加多次握手（实测离线循环约 5 分钟一轮，很容易并发）。
 *   2) 最小间隔复用：`LOCAL_CODE_MIN_INTERVAL_MS` 内重复请求直接复用上次结果，不再握手。
 *   3) 硬超时：握手若卡死（MMTLS 在服务器环境可能长时间不返回）用 Promise.race 兜住，
 *      不让刷新链路被拖住（比失败更糟的是挂住）。
 */
const LOCAL_CODE_MIN_INTERVAL_MS = 60 * 1000;
const LOCAL_CODE_TIMEOUT_MS = 45 * 1000;
/** 失败退避阶梯（毫秒）：避免离线循环每轮都去握一次手 */
const LOCAL_CODE_BACKOFF_STEPS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000];
/**
 * 「换码成功但没生效」判定窗口：换码成功后若在此时长内**又被请求换码**，
 * 说明上一枚 Code 没让账号上线（多因 loginBuffer 已废/被风控拒绝）。
 * 此时同样按失败退避，否则会退化成"每 60 秒握一次手"——既不划算也会堆高频特征。
 */
const LOCAL_CODE_REISSUE_WINDOW_MS = 180 * 1000;
/**
 * ⚠️ 40188（invalid scope）= 腾讯对该 openid 的授权范围判失效（风控标签），
 * 此时**任何**授权接口调用都会加固标签（HANDOVER §8 实证）。识别到就长退避 6 小时，
 * 期间本机/远程两条路都不再打授权接口，直到用户重新扫码（扫码成功会重置）。
 */
const LOCAL_CODE_40188_BLOCK_MS = 6 * 60 * 60 * 1000;
const localCodeCache = new Map(); // openid -> { code, at }
const localCodeInflight = new Map(); // openid -> Promise
const localCodeFail = new Map(); // openid -> { streak, nextAt }

function localCodeCacheGet(openid) {
    const hit = localCodeCache.get(openid);
    if (!hit) return '';
    if (Date.now() - hit.at > LOCAL_CODE_MIN_INTERVAL_MS) return '';
    return hit.code;
}

function localCodeBlockedFor(openid) {
    const f = localCodeFail.get(openid);
    if (!f) return 0;
    const left = f.nextAt - Date.now();
    return left > 0 ? left : 0;
}

function readLocalWxSession(wxid) {
    const openid = String(wxid || '').trim();
    if (!openid) return null;
    const file = path.join(WX_LOGIN_DIR, `${openid}.json`);
    if (!fs.existsSync(file)) return null;
    try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!rec || !rec.loginBuffer) return null;
        return { file, rec };
    }
    catch {
        return null;
    }
}

/** 回写续期后的微信凭证（与 gateway-process.js::persistRefreshedWxBuffer 同字段，两边必须兼容） */
function persistRefreshedWxBuffer(file, oldRec, refreshed) {
    fs.writeFileSync(file, JSON.stringify({
        ...(oldRec || {}),
        loginBuffer: refreshed.loginBuffer,
        refreshtoken: refreshed.refreshtoken || (oldRec && oldRec.refreshtoken) || '',
        accesstoken: refreshed.accesstoken || (oldRec && oldRec.accesstoken) || '',
        updatedAt: Date.now(),
    }));
}

/**
 * ⭐ 失败时也要回写「已轮换的凭证」。
 * 背景（2026-10-28 定位）：`refreshLoginBuffer` 是两步请求，第1步刷 refreshtoken 成功后旧 token 即作废；
 * 第2步换 loginBuffer 失败时，新 token 只挂在 error.refreshtoken 上。调用方若只打日志，
 * 磁盘就永久停留在废 token → 每轮保活都 40188，永远无法自愈。
 */
function persistRotatedCredentialsOnError(file, oldRec, err) {
    try {
        const nextRefresh = err && err.refreshtoken;
        const nextAccess = err && err.accesstoken;
        if (!nextRefresh && !nextAccess) return false;
        fs.writeFileSync(file, JSON.stringify({
            ...(oldRec || {}),
            ...(nextRefresh ? { refreshtoken: nextRefresh } : {}),
            ...(nextAccess ? { accesstoken: nextAccess } : {}),
            updatedAt: Date.now(),
        }));
        return true;
    }
    catch {
        return false;
    }
}

/** 判断是否属于「loginBuffer 需要先续期」的失败（MMTLS 握手被拒/超时） */
function needsRefreshFirst(message) {
    return /Unable to establish|ManualAuth rejected|超时|timeout/i.test(String(message || ''));
}

async function issueLocalCodeOnce(openid, wxConfig, logFn) {
    const emit = typeof logFn === 'function' ? logFn : () => {};
    const local = readLocalWxSession(openid);
    if (!local) {
        throw new Error(`本机没有该号的微信登录会话（${openid}.json），需先在面板扫码一次`);
    }
    const { file, rec } = local;
    const appId = String(wxConfig.appId || rec.appId || 'wx5306c5978fdb76e4').trim();
    const { WxLoginService } = require('../services/wx-login/service');
    const svc = new WxLoginService();
    const t0 = Date.now();

    let session = {
        openid: rec.openid || openid,
        loginBuffer: rec.loginBuffer,
        refreshtoken: rec.refreshtoken || '',
        accesstoken: rec.accesstoken || '',
    };

    const withTimeout = (promise, label) => {
        let timer = null;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label}超时 ${LOCAL_CODE_TIMEOUT_MS}ms`)),
                    LOCAL_CODE_TIMEOUT_MS);
            }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
    };

    let code = '';
    try {
        code = await withTimeout(svc.issueCode(session, appId), '本机换码');
    }
    catch (firstErr) {
        // ⭐ 关键一步（照搬 gateway 的成熟路径）：
        // loginBuffer 直接换码常被腾讯拒（ManualAuth rejected），但 refreshtoken 续期几乎必成功，
        // 续期后同一 loginBuffer 就能换码。缺了这步，本机换码会一直失败（实测 2026-10-27）。
        if (!needsRefreshFirst(firstErr.message)) throw firstErr;
        if (!session.refreshtoken) {
            throw new Error(`loginBuffer 被拒且无 refreshtoken 可续期（需重新扫码）: ${firstErr.message}`);
        }
        emit(`loginBuffer 直接换码失败，改用 refreshtoken 续期后重试: ${String(firstErr.message).slice(0, 80)}`, {
            accountId: String((wxConfig && wxConfig._accountId) || ''),
            openid,
        });
        const refreshed = await withTimeout(svc.refreshLoginBuffer(session), '微信凭证续期')
            .catch((refreshErr) => {
                // ⭐ 第1步 refresh 成功、第2步换 loginBuffer 失败时，error 上带着**已轮换**的新 token。
                // 不回写 = 磁盘永久停在已作废的旧 refreshtoken（40188 永不恢复的根因）。
                persistRotatedCredentialsOnError(file, rec, refreshErr);
                throw refreshErr;
            });
        if (!refreshed || !refreshed.loginBuffer) {
            throw new Error(`refreshtoken 续期未返回有效 loginBuffer（需重新扫码）: ${firstErr.message}`);
        }
        persistRefreshedWxBuffer(file, rec, refreshed);
        session = {
            ...session,
            loginBuffer: refreshed.loginBuffer,
            refreshtoken: refreshed.refreshtoken || session.refreshtoken,
            accesstoken: refreshed.accesstoken || session.accesstoken,
        };
        code = await withTimeout(svc.issueCode(session, appId), '续期后本机换码');
    }
    if (!code) throw new Error('本机换码返回空 Code（loginBuffer 可能已失效，需重新扫码）');
    return { code: String(code), ms: Date.now() - t0 };
}

async function requestFarmCodeLocal(account, wxConfig, logFn) {
    const emit = typeof logFn === 'function' ? logFn : () => {};
    const openid = String((account && (account.wxid || account.openId)) || '').trim();
    if (!openid) throw new Error('账号缺少 wxid，无法本机换码');

    // 闸 2：短窗口内复用上次换码结果（省一次握手，也降低腾讯侧高频特征）
    const cached = localCodeCacheGet(openid);
    if (cached) return cached;

    // 闸 3：失败退避期内不再握手（离线循环约 5 分钟一轮，不加退避会变成高频打授权接口）
    const blockedMs = localCodeBlockedFor(openid);
    if (blockedMs > 0) {
        throw new Error(`本机换码处于退避期，还剩 ${Math.ceil(blockedMs / 1000)}s`);
    }

    // 闸 4：「上一枚 Code 没生效」也退避。换码成功 ≠ 账号上线：
    // 缓存窗口一过又来要码，说明上一枚没让账号连上（loginBuffer 废/被风控拒），
    // 直接再握手会退化成每 60s 一次的高频特征 —— 按失败档退避。
    const last = localCodeCache.get(openid);
    if (last && Date.now() - last.at <= LOCAL_CODE_REISSUE_WINDOW_MS) {
        const prev = localCodeFail.get(openid);
        const streak = (prev ? prev.streak : 0) + 1;
        const wait = LOCAL_CODE_BACKOFF_STEPS[Math.min(streak - 1, LOCAL_CODE_BACKOFF_STEPS.length - 1)];
        localCodeFail.set(openid, { streak, nextAt: Date.now() + wait });
        emit(`上一枚 Code 未生效（${Math.round((Date.now() - last.at) / 1000)}s 内再次请求），退避 ${Math.round(wait / 60000)}min`, {
            accountId: String((account && account.id) || ''),
            openid,
            streak,
        });
        throw new Error(`上一枚 Code 未生效，退避 ${Math.round(wait / 60000)} 分钟后重试`);
    }

    // 闸 1：并发复用同一 Promise，避免叠加握手
    const inflight = localCodeInflight.get(openid);
    if (inflight) return await inflight;

    const task = issueLocalCodeOnce(openid, wxConfig || {}, logFn)
        .then((res) => {
            localCodeFail.delete(openid);
            localCodeCache.set(openid, { code: res.code, at: Date.now() });
            emit(`本机换码成功（不依赖第三方取码服务，耗时 ${res.ms}ms）`, {
                accountId: String((account && account.id) || ''),
                openid,
                ms: res.ms,
            });
            return res.code;
        })
        .catch((err) => {
            const msg = String(err && err.message || '');
            const is40188 = /40188|invalid scope/i.test(msg);
            const prev = localCodeFail.get(openid);
            const streak = (prev ? prev.streak : 0) + 1;
            // 40188 = 风控标签：继续打任何授权接口只会加固标签（HANDOVER 实证），直接长退避 6h
            const wait = is40188
                ? LOCAL_CODE_40188_BLOCK_MS
                : LOCAL_CODE_BACKOFF_STEPS[Math.min(streak - 1, LOCAL_CODE_BACKOFF_STEPS.length - 1)];
            localCodeFail.set(openid, { streak, nextAt: Date.now() + wait });
            emit(`本机换码失败（第 ${streak} 次${is40188 ? '，40188 风控标签 → 退避 6h 并跳过远程兜底' : ''}，退避 ${Math.round(wait / 60000)}min）: ${msg.slice(0, 120)}`, {
                accountId: String((account && account.id) || ''),
                openid,
                streak,
                risk40188: is40188,
            });
            if (is40188) {
                const blocked = new Error(`微信授权被风控拒绝（40188 invalid scope），需重新扫码`);
                blocked.skipRemoteFallback = true; // 上层据此不再打已死的远程取码服务
                blocked.wxReloginNeeded = true;
                throw blocked;
            }
            throw err;
        })
        .finally(() => {
            localCodeInflight.delete(openid);
        });
    localCodeInflight.set(openid, task);
    return await task;
}

/** 第三方取码服务（兜底，仅在无本机会话时使用；公共域名可能随时失效） */
async function requestFarmCodeRemote(account, wxConfig) {
    const wxid = String(account && account.wxid || '').trim();
    if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

    const apiKey = String(wxConfig.apiKey || '').trim();
    const appId = String(wxConfig.appId || 'wx5306c5978fdb76e4').trim();

    if (apiKey) {
        const proxyApiUrl = String(wxConfig.proxyApiUrl || 'https://code.z74d.top/api').trim();
        const targetUrl = `${proxyApiUrl  }?api_key=${  encodeURIComponent(apiKey)  }&action=jslogin`;
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wxid, appid: appId }),
        });
        const data = await response.json();
        if (data && data.code === 0 && data.data && data.data.code) return String(data.data.code);
        throw new Error(data && data.msg ? data.msg : '代理获取 Code 失败');
    }

    const apiBase = String(wxConfig.apiBase || 'https://code.z74d.top/api').trim();
    const response = await fetch(`${apiBase  }/Wxapp/JSLogin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Wxid: wxid, Appid: appId }),
    });
    const data = await response.json();
    if (data && data.Success && data.Data && data.Data.code) return String(data.Data.code);
    const msg = data && data.Data && data.Data.jsapiBaseresponse && data.Data.jsapiBaseresponse.errmsg
        ? data.Data.jsapiBaseresponse.errmsg
        : data && data.Message ? data.Message : '获取 Code 失败';
    throw new Error(msg);
}


function createAutoCodeRefreshService(deps) {
  const {
    store,
    getAccounts,
    addOrUpdateAccount,
    resolveWorkerControls,
    log,
    addAccountLog,
  } = deps;

  const scheduler = createScheduler('auto_code_refresh');

  function getTaskName(accountId) {
    return `refresh_${  String(accountId || '')}`;
  }

  function findAccount(accountId) {
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    return accounts.find(acc => String(acc.id) === String(accountId));
  }

  function normalizeConfig(accountId) {
    const cfg = store.getAutoCodeRefresh ? store.getAutoCodeRefresh(accountId) : null;
    return {
      enabled: cfg && cfg.enabled === true,
      intervalMinutes: Math.max(1, Math.min(1440, Number(cfg && cfg.intervalMinutes) || 60)),
    };
  }

  function getWxConfig() {
    return store.getGlobalWxConfig ? store.getGlobalWxConfig() : {};
  }

  async function requestFarmCode(account, wxConfig) {
    // 首选本机换码（不依赖第三方取码服务）；只有本机不可用时才回退到远程服务
    try {
      return await requestFarmCodeLocal(account, wxConfig, (msg, meta) => log('系统', msg, meta));
    }
    catch (localErr) {
      // 40188 风控标签：再打任何授权接口（含远程兜底）只会加固标签，直接放弃本轮
      if (localErr && localErr.skipRemoteFallback) throw localErr;
      log('系统', `本机换码不可用，回退第三方取码服务: ${localErr.message}`, {
        accountId: String(account && account.id),
        accountName: account && account.name,
      });
    }
    return await requestFarmCodeRemote(account, wxConfig);
  }

  async function refreshAccountCode(accountId, reason = 'timer') {
    const account = findAccount(accountId);
    if (!account) return false;

    const wxConfig = getWxConfig();
    if (wxConfig.enabled === false) {
      log('系统', '自动刷新 Code 跳过: 微信登录未启用', {
        accountId: String(accountId),
        accountName: account.name,
      });
      return false;
    }

    try {
      const code = await requestFarmCode(account, wxConfig);
      const nextAccount = { ...account, code };
      addOrUpdateAccount(nextAccount);

      const controls = typeof resolveWorkerControls === 'function' ? (resolveWorkerControls() || {}) : {};
      if (typeof controls.restartWorker === 'function') controls.restartWorker(nextAccount);

      addAccountLog('auto_code_refresh', `自动刷新 Code 成功，已重启账号: ${  account.name}`,
        account.id, account.name, { reason });
      log('系统', `自动刷新 Code 成功: ${  account.name}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return true;
    } catch (err) {
      addAccountLog('auto_code_refresh_failed', `自动刷新 Code 失败: ${  err.message}`,
        account.id, account.name, { reason });
      log('错误', `自动刷新 Code 失败: ${  account.name  } - ${  err.message}`, {
        accountId: String(account.id),
        accountName: account.name,
      });
      return false;
    }
  }

  function scheduleAccount(accountId) {
    const cfg = normalizeConfig(accountId);
    const taskName = getTaskName(accountId);
    scheduler.clear(taskName);
    if (!cfg.enabled) return;

    const account = findAccount(accountId);
    if (!account || !String(account.wxid || '').trim()) {
      log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
        accountId: String(accountId),
        accountName: account && account.name || '',
      });
      return;
    }

    scheduler.setIntervalTask(taskName, cfg.intervalMinutes * 60000, () => {
      refreshAccountCode(accountId, 'timer');
    }, { preventOverlap: true });

    log('系统', `自动刷新 Code 已启用: ${  account.name  }，间隔 ${  cfg.intervalMinutes  } 分钟`, {
      accountId: String(accountId),
      accountName: account.name,
    });
  }

  function rescheduleAll() {
    scheduler.clearAll();
    const data = getAccounts();
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    for (const account of accounts) {
      scheduleAccount(account.id);
    }
  }

  function stopAccount(accountId) {
    scheduler.clear(getTaskName(accountId));
  }

  return {
    refreshAccountCode,
    scheduleAccount,
    rescheduleAll,
    stopAccount,
  };
}

module.exports = { createAutoCodeRefreshService };
