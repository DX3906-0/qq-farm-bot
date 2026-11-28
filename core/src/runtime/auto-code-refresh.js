const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
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

// 同 openid 单飞直到真实收尾；原生会话可复用，一次性 Code 不得复用。
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
 * 40188 是授权范围拒绝，不能直接判为风控或所有凭据失效。
 * 非网关入口保留6小时请求预算，拒绝后不向第三方重复授权；新扫码按世代重置。
 */
const LOCAL_CODE_40188_BLOCK_MS = 6 * 60 * 60 * 1000;
const localCodeCache = new Map(); // 世代键 -> { at }，仅记录退避时间，不存可复用 Code
const localCodeInflight = new Map(); // openid -> 在途操作
const localCodeFail = new Map(); // 世代键 -> { streak, nextAt }

function localCodeBlockedFor(cacheKey) {
    const f = localCodeFail.get(cacheKey);
    if (!f) return 0;
    const left = f.nextAt - Date.now();
    return left > 0 ? left : 0;
}

function readLocalWxSession(wxid) {
    const openid = String(wxid || '').trim();
    if (!openid || path.basename(openid) !== openid || /[\\/]/.test(openid)) throw new Error('微信凭据标识非法');
    const file = path.join(WX_LOGIN_DIR, `${openid}.json`);
    if (!fs.existsSync(file)) return null;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rec || !rec.loginBuffer || (rec.openid && rec.openid !== openid)) {
        throw Object.assign(new Error('本机微信凭据无效，请重新扫码'), { stage: 'local_credential_invalid' });
    }
    return { file, rec };
}

/** 续期与扫码共用 CAS writer；写入失败必须阻止继续换码。 */
function persistRefreshedWxBuffer(file, oldRec, refreshed) {
    const { writeWxCredential } = require('../services/wx-login/credential-storage');
    return writeWxCredential(file, refreshed, oldRec);
}

function assertCodeActive(options) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (options.deadline && Date.now() >= options.deadline) throw new Error('本机换码总期限已到');
}

// 只有服务端正面拒绝才需要先刷新 loginBuffer。WX_NATIVE_TICKET_REJECTED 属于明确的
// 票据拒绝信号，仍保留；短链"解不出来"（ticketUnverified）不在此列，避免拿未证实的结论换票。
function needsRefreshFirst(error) {
    return (error?.code === 'WX_MANUAL_AUTH_REJECTED' && error.serverCode === -10)
        || error?.code === 'WX_NATIVE_TICKET_REJECTED';
}

async function issueLocalCodeOnce(openid, wxConfig, logFn, options = {}, snapshot) {
    assertCodeActive(options);
    const local = snapshot === undefined ? readLocalWxSession(openid) : snapshot;
    if (!local) throw Object.assign(new Error('本机没有该号微信登录会话，需先扫码'), { localSessionMissing: true });
    const { withWxCredentialOperation } = require('../services/wx-login/credential-storage');
    return withWxCredentialOperation(local.file, local.rec,
        () => issueLocalCodeLocked(openid, wxConfig, logFn, options, local));
}

async function issueLocalCodeLocked(openid, wxConfig, logFn, options = {}, snapshot) {
    assertCodeActive(options);
    const emit = typeof logFn === 'function' ? logFn : () => {};
    const local = snapshot === undefined ? readLocalWxSession(openid) : snapshot;
    if (!local) {
        throw Object.assign(new Error(`本机没有该号的微信登录会话（${openid}.json），需先在面板扫码一次`), { localSessionMissing: true });
    }
    const { file } = local;
    let rec = local.rec;
    const appId = String(wxConfig.appId || rec.appId || 'wx5306c5978fdb76e4').trim();
    const { WxLoginService } = require('../services/wx-login/service');
    const svc = new WxLoginService();
    const t0 = Date.now();

    if (!rec.credentialGeneration) {
        rec = persistRefreshedWxBuffer(file, rec, { credentialGeneration: crypto.randomBytes(16).toString('hex'), nativeSession: null, pendingCode: null });
    }
    const generation = rec.credentialGeneration;
    const binding = `wx-login:${openid}:${generation}`;
    const session = {
        ...rec, openid,
        refreshBusinessId: rec.refreshBusinessId ?? rec.refresh_business_id ?? 'pc_yyb',
        credentialSource: rec.credentialSource ?? (rec.refreshBusinessId === 'pc_yyb_auth' ? 'pc_yyb_auth' : 'legacy_pc_yyb'),
    };
    const checkCurrent = () => {
        if (rec.credentialGeneration !== generation
            || JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(rec)) {
            throw Object.assign(new Error('微信凭据已被并发更新'), { stage: 'credential_conflict' });
        }
    };
    const save = value => {
        checkCurrent();
        rec = persistRefreshedWxBuffer(file, rec, value);
        return rec;
    };
    if (rec.nativeSession?.binding === binding && (rec.nativeSession.expiresAt === null
        || (Number.isFinite(rec.nativeSession.expiresAt) && rec.nativeSession.expiresAt <= Date.now()))) save({ nativeSession: null });
    const issue = () => svc.issueCode(session, appId, {
        ...options, session: rec.nativeSession, sessionBinding: binding,
        onSession(value) {
            if (value?.binding !== binding) throw Object.assign(new Error('微信原生会话世代不匹配'), { stage: 'credential_conflict' });
            save({ nativeSession: value });
            assertCodeActive(options);
        },
    });
    let code = '';
    try {
        checkCurrent();
        code = await issue();
    }
    catch (firstErr) {
        if (firstErr.stage === 'credential_conflict' || firstErr.stage === 'persist_native_session') throw firstErr;
        assertCodeActive(options);
        if (!needsRefreshFirst(firstErr)) throw firstErr;
        checkCurrent();
        emit('微信授权明确拒绝，按 accessToken 真实期限恢复 loginBuffer', { openid });
        const expiresAt = rec.accessTokenExpiresAt;
        if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() >= expiresAt) {
            const rotated = await svc.refreshCredentials(session, {
                ...options,
                onCredentialsRotated(value) {
                    // 已收到的轮换响应即使赶上取消也先 CAS 落盘。
                    save(value);
                    assertCodeActive(options);
                },
            });
            assertCodeActive(options);
            save(rotated);
            Object.assign(session, rotated);
        }
        assertCodeActive(options);
        const refreshed = await svc.refreshBufferWithAccessToken(session, options);
        assertCodeActive(options);
        if (!refreshed?.loginBuffer) throw new Error('微信续期响应未返回有效 loginBuffer');
        save({ ...refreshed, nativeSession: null, loginBufferUpdatedAt: Date.now() });
        Object.assign(session, refreshed);
        code = await issue();
    }
    assertCodeActive(options);
    checkCurrent();
    if (typeof code !== 'string' || !code) throw new Error('本机换码返回空 Code，暂不判定凭据失效');
    return { code, generation, file, credential: rec, ms: Date.now() - t0 };
}

async function requestFarmCodeLocal(account, wxConfig, logFn, options = {}) {
    assertCodeActive(options);
    const emit = typeof logFn === 'function' ? logFn : () => {};
    const openid = String(account && account.wxid || '').trim();
    if (!openid) throw new Error('账号缺少 wxid，无法本机换码');

    // 在途操作按 openid 串行化，但一枚 Code 只能交付给一个重连。
    const inflight = localCodeInflight.get(openid);
    if (inflight) {
        await inflight;
        throw Object.assign(new Error('本机换码已交付其他重连，请勿复用一次性 Code'), { skipRemoteFallback: true });
    }
    const local = readLocalWxSession(openid);
    if (local && !local.rec.credentialGeneration) {
        local.rec = persistRefreshedWxBuffer(local.file, local.rec, { credentialGeneration: crypto.randomBytes(16).toString('hex'), nativeSession: null, pendingCode: null });
    }
    const cacheKey = `wx-login:${openid}:${local?.rec.credentialGeneration || 'missing'}`;

    // 失败退避绑定世代，新扫码不能继承旧会话冷却。
    const blockedMs = localCodeBlockedFor(cacheKey);
    if (blockedMs > 0) {
        throw Object.assign(new Error(`本机换码处于退避期，还剩 ${Math.ceil(blockedMs / 1000)}s`), { skipRemoteFallback: true });
    }

    // 闸 4：「上一枚 Code 没生效」也退避。换码成功 ≠ 账号上线：
    // 缓存窗口一过又来要码，说明上一枚没让账号连上（loginBuffer 废/被风控拒），
    // 直接再握手会退化成每 60s 一次的高频特征 —— 按失败档退避。
    const last = localCodeCache.get(cacheKey);
    if (last && Date.now() - last.at <= LOCAL_CODE_REISSUE_WINDOW_MS) {
        const prev = localCodeFail.get(cacheKey);
        const streak = (prev ? prev.streak : 0) + 1;
        const wait = LOCAL_CODE_BACKOFF_STEPS[Math.min(streak - 1, LOCAL_CODE_BACKOFF_STEPS.length - 1)];
        localCodeFail.set(cacheKey, { streak, nextAt: Date.now() + wait });
        emit(`上一枚 Code 未生效（${Math.round((Date.now() - last.at) / 1000)}s 内再次请求），退避 ${Math.round(wait / 60000)}min`, {
            accountId: String((account && account.id) || ''),
            openid,
            streak,
        });
        throw Object.assign(new Error(`上一枚 Code 未生效，退避 ${Math.round(wait / 60000)} 分钟后重试`), { skipRemoteFallback: true });
    }

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? LOCAL_CODE_TIMEOUT_MS));
    const stageOptions = { ...options, signal: controller.signal, deadline, timeoutMs: Math.max(0, deadline - Date.now()) };
    const timer = setTimeout(() => controller.abort(new Error('本机换码总期限已到')), stageOptions.timeoutMs);
    const task = issueLocalCodeOnce(openid, wxConfig || {}, logFn, stageOptions, local)
        .then((res) => {
            assertCodeActive(stageOptions);
            if (JSON.stringify(JSON.parse(fs.readFileSync(res.file, 'utf8'))) !== JSON.stringify(res.credential)) {
                throw Object.assign(new Error('微信凭据已被并发更新，拒绝交付旧世代Code'), { stage: 'credential_conflict' });
            }
            localCodeFail.delete(cacheKey);
            localCodeCache.set(`wx-login:${openid}:${res.generation}`, { at: Date.now() });
            emit(`本机换码成功（不依赖第三方取码服务，耗时 ${res.ms}ms）`, {
                accountId: String((account && account.id) || ''),
                openid,
                ms: res.ms,
            });
            return res;
        })
        .catch((err) => {
            const msg = String(err && err.message || '');
            const is40188 = /40188|invalid scope/i.test(msg);
            const prev = localCodeFail.get(cacheKey);
            const streak = (prev ? prev.streak : 0) + 1;
            // 授权范围拒绝后延长本入口请求预算，不推断拒绝成因。
            const wait = is40188
                ? LOCAL_CODE_40188_BLOCK_MS
                : LOCAL_CODE_BACKOFF_STEPS[Math.min(streak - 1, LOCAL_CODE_BACKOFF_STEPS.length - 1)];
            localCodeFail.set(cacheKey, { streak, nextAt: Date.now() + wait });
            emit(`本机换码失败（第 ${streak} 次${is40188 ? '，40188 授权范围拒绝 → 退避 6h 并跳过远程兜底' : ''}，退避 ${Math.round(wait / 60000)}min）: ${msg.slice(0, 120)}`, {
                accountId: String((account && account.id) || ''),
                openid,
                streak,
                risk40188: is40188,
            });
            if (is40188) {
                err.skipRemoteFallback = true;
                throw err;
            }
            throw err;
        })
        .finally(() => {
            clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener('abort', abort);
            localCodeInflight.delete(openid);
        });
    localCodeInflight.set(openid, task);
    return await task;
}

/** 第三方取码服务（兜底，仅在无本机会话时使用；公共域名可能随时失效） */
async function requestFarmCodeRemote(account, wxConfig, options = {}) {
    assertCodeActive(options);
    const wxid = String(account && account.wxid || '').trim();
    if (!wxid) throw new Error('账号缺少 wxid，无法自动刷新 Code');

    const apiKey = String(wxConfig.apiKey || '').trim();
    const appId = String(wxConfig.appId || 'wx5306c5978fdb76e4').trim();

    if (apiKey) {
        const proxyApiUrl = String(wxConfig.proxyApiUrl || 'https://code.z74d.top/api').trim();
        const targetUrl = `${proxyApiUrl  }?api_key=${  encodeURIComponent(apiKey)  }&action=jslogin`;
        const response = await fetch(targetUrl, {
            signal: options.signal,
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
        signal: options.signal,
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
  const operations = new Map();

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

  function usesGateway(account) {
    if (!account || process.env.FARM_NETWORK_MODE !== 'gateway') return false;
    const configured = String(process.env.FARM_GATEWAY_ACCOUNTS || '').trim();
    return !configured || configured.split(',').map(s => s.trim()).includes(String(account.id));
  }

  async function requestFarmCode(account, wxConfig, options) {
    // 首选本机换码（不依赖第三方取码服务）；只有本机不可用时才回退到远程服务
    try {
      return await requestFarmCodeLocal(account, wxConfig, (msg, meta) => log('系统', msg, meta), options);
    }
    catch (localErr) {
      // 仅缺失本地会话允许远端兜底；写错、拒绝、取消和冷却均不能再授权。
      if (!localErr?.localSessionMissing || localErr.skipRemoteFallback) throw localErr;
      log('系统', `本机换码不可用，回退第三方取码服务: ${localErr.message}`, {
        accountId: String(account && account.id),
        accountName: account && account.name,
      });
    }
    assertCodeActive(options);
    return { code: await requestFarmCodeRemote(account, wxConfig, options) };
  }

  async function refreshAccountCode(accountId, reason = 'timer') {
    const account = findAccount(accountId);
    if (!account) return false;
    // 网关是连接与滚动凭据唯一管理者。主进程不得再换码后重启 worker，
    // 否则同一份 refreshtoken 被两进程轮换、产生旧写覆盖和重复原生握手。
    if (usesGateway(account)) {
      log('系统', '账号由连接网关维护凭据，跳过主进程换码', { accountId: String(accountId) });
      return false;
    }

    const wxConfig = getWxConfig();
    if (wxConfig.enabled === false) {
      log('系统', '自动刷新 Code 跳过: 微信登录未启用', {
        accountId: String(accountId),
        accountName: account.name,
      });
      return false;
    }

    const key = String(accountId);
    if (operations.has(key)) return await operations.get(key).promise;
    const controller = new AbortController();
    const options = { signal: controller.signal, deadline: Date.now() + LOCAL_CODE_TIMEOUT_MS, timeoutMs: LOCAL_CODE_TIMEOUT_MS };
    const timer = setTimeout(() => controller.abort(new Error('自动换码总期限已到')), options.timeoutMs);
    const operation = { controller };
    operations.set(key, operation);
    operation.promise = (async () => {
    try {
      const result = await requestFarmCode(account, wxConfig, options);
      assertCodeActive(options);
      if (result.file && JSON.stringify(JSON.parse(fs.readFileSync(result.file, 'utf8'))) !== JSON.stringify(result.credential)) {
        throw Object.assign(new Error('微信凭据已被并发更新，拒绝重连旧世代Code'), { stage: 'credential_conflict' });
      }
      const nextAccount = { ...account, code: result.code };
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
    } finally {
      clearTimeout(timer);
      if (operations.get(key) === operation) operations.delete(key);
    }
    })();
    return await operation.promise;
  }

  function scheduleAccount(accountId) {
    const cfg = normalizeConfig(accountId);
    const taskName = getTaskName(accountId);
    scheduler.clear(taskName);
    if (!cfg.enabled) return;

    const account = findAccount(accountId);
    if (usesGateway(account)) return;
    if (!account || !String(account.wxid || '').trim()) {
      log('系统', '自动刷新 Code 未启动: 账号缺少 wxid', {
        accountId: String(accountId),
        accountName: account && account.name || '',
      });
      return;
    }

    scheduler.setIntervalTask(taskName, cfg.intervalMinutes * 60000, () => {
      return refreshAccountCode(accountId, 'timer');
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
    const operation = operations.get(String(accountId));
    if (operation) operation.controller.abort(new Error('账号自动换码已取消'));
  }

  return {
    refreshAccountCode,
    scheduleAccount,
    rescheduleAll,
    stopAccount,
  };
}

module.exports = { createAutoCodeRefreshService };
