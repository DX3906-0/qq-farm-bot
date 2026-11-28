// 微信扫码登录路由（本地直连微信开放平台，不依赖第三方 API）
// 移植自 liyangpengs/qq-farm-bot 的 controllers/admin/wx-login-routes.ts
// 认证由 admin.js 的 registerAuthGate 统一处理（/api 下所有路由需登录）。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("../config/runtime-paths");
const { WxLoginService } = require("../services/wx-login/service");
const { createModuleLogger } = require("../services/logger");

const TARGET_APP_ID = "wx5306c5978fdb76e4";
// 微信 loginBuffer 持久化目录：扫码后落盘，断线重连时 gateway 据此重新 issueCode 换新一次性 code
const WX_LOGIN_DIR = path.join(getDataDir(), "wx-login");
function wxCredentialDirectory() {
  const { readGatewayDelegation } = require("../runtime/gateway-routing");
  const delegation = readGatewayDelegation();
  if (!delegation) return WX_LOGIN_DIR;
  if (delegation.phase !== "active") throw new Error("微信凭据正在交接，暂不覆盖登录态");
  return path.join(getDataDir(), delegation.credentialDirectory);
}
// 历史 bug（2026-10-27 实测两次）：TTL=110s 对"切窗口→拿手机→扫→点确认"的真人节奏太紧，
// 用户在边缘才扫完，任务刚 authorized 就被回收，confirm 报 not found，白白浪费两次扫码。
// 提到 5 分钟；微信侧二维码自身过期时 poll 会返回 expired，不影响正确性。
const TASK_TTL_MS = 300000;
// 用户已扫码/已授权后，任务需要再活一会儿才能走完 confirm→code（历史 bug：
// 用户在 110s 边缘才扫码，status 刚返回 authorized 任务就被 TTL 回收，confirm 报
// "Login task not found or expired"，一次扫码被白白浪费——实测 2026-10-27 22:32）。
const TASK_AUTHORIZED_GRACE_MS = 180000;
const tasks = new Map();
const wxLogin = new WxLoginService();
const logger = createModuleLogger("wx-login");

function destroy(task) {
  task.cancelled = true;
  if (task.operation) task.operation.controller.abort(new Error("微信扫码任务已取消"));
  try {
    wxLogin.destroy(task.session);
  } catch (_) {}
  task.code = undefined;
  task.credential = undefined;
  task.session = undefined;
  tasks.delete(task.id);
}

// 持久化微信登录缓冲：微信 code 一次性，断线重连必须靠 loginBuffer 重新换码，否则会被 gameserver 顶下线
// 【保活关键】refreshtoken / accesstoken 必须一并落盘。
// loginBuffer 有效期很短（实测仅数分钟），断线重连时往往已过期；
// 只有凭 refreshtoken 才能续期出新的 loginBuffer —— 这才是微信账号的"保活"能力。
// 早期版本只落盘 loginBuffer（丢掉 refreshtoken），导致 loginBuffer 一过期就只能重新扫码，
// 表现为"扫码后没几分钟就掉线"（用户反馈的根因）。
function persistWxLoginBuffer(openid, loginBuffer, credentials, expected, directory) {
  const key = String(openid || "");
  if (!key || path.basename(key) !== key || /[\\/]/.test(key)) throw new Error("微信凭据标识非法");
  if (directory !== wxCredentialDirectory()) throw new Error("微信凭据目录已交接，请重新扫码");
  const creds = credentials || {};
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${key}.json`);
  const { writeWxCredential } = require("../services/wx-login/credential-storage");
  const cleared = {};
  // writer 合并 patch：新扫码不能继承旧世代的失败、冷却或扫码重试状态。
  for (const field of Object.keys(expected || {})) {
    if (/(?:token|buffer|native|code|scan)/i.test(field) && /(?:fail|retry|cooldown|blocked|error|pending)/i.test(field)) cleared[field] = null;
  }
  return writeWxCredential(file, {
    ...cleared,
    openid: key, appId: TARGET_APP_ID, loginBuffer,
    oauthAppId: creds.oauthAppId ?? creds.appId ?? null,
    refreshBusinessId: creds.refreshBusinessId ?? creds.refresh_business_id ?? "pc_yyb",
    credentialSource: creds.credentialSource ?? ((creds.refreshBusinessId ?? creds.refresh_business_id) === "pc_yyb_auth" ? "pc_yyb_auth" : "pc_yyb"),
    scope: creds.scope ?? null, loginType: creds.loginType ?? null,
    scannedAt: creds.scannedAt ?? null,
    accessTokenExpiresAt: creds.accessTokenExpiresAt ?? null,
    accessTokenExpirySource: creds.accessTokenExpirySource ?? (creds.accessTokenExpiresAt ? "legacy_unverified" : "unknown"),
    accessTokenCookieExpiresAt: creds.accessTokenCookieExpiresAt ?? null,
    accessTokenCookieExpirySource: creds.accessTokenCookieExpirySource ?? "unknown",
    refreshtoken: creds.refreshtoken || "", accesstoken: creds.accesstoken || "",
    tokenCheckedAt: creds.tokenCheckedAt ?? Date.now(), loginBufferUpdatedAt: Date.now(),
    refreshTokenChangedAt: null, nativeSession: null, nativeReverify: null, pendingCode: null,
    tokenRetryAfter: 0, tokenFailureCount: 0, tokenRefreshPending: false,
    bufferRefreshPending: false, bufferRetryAfter: 0, bufferFailureCount: 0,
    wxReloginNeeded: false,
    credentialGeneration: crypto.randomBytes(16).toString("hex"),
    updatedAt: Date.now(),
  }, expected);
}

function publicTask(task) {
  return {
    task_id: task.id,
    app_id: TARGET_APP_ID,
    status: task.status,
    expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000),
  };
}

function owner(req) {
  return String(req.currentUser?.username || req.adminToken || "");
}

function findTask(req, res) {
  const task = tasks.get(String(req.params.taskId || ""));
  // 已授权/待换码的任务享有宽限期，避免"刚扫完就 TTL 回收"导致 confirm 失败
  const limit = (task && (task.status === "authorized" || task.status === "ready_for_code"))
    ? TASK_TTL_MS + TASK_AUTHORIZED_GRACE_MS
    : TASK_TTL_MS;
  if (!task || task.owner !== owner(req) || Date.now() - task.createdAt > limit) {
    if (task) destroy(task);
    res.status(404).json({ ok: false, error: "Login task not found or expired" });
    return null;
  }
  return task;
}

async function createTask(requestOwner) {
  const { session, qr } = await wxLogin.createQrSession();
  const task = {
    id: crypto.randomBytes(32).toString("hex"),
    owner: requestOwner,
    createdAt: Date.now(),
    status: "waiting",
    session,
    qr,
  };
  tasks.set(task.id, task);
  return task;
}

function assertActive(task, options = {}) {
  if (task.cancelled || tasks.get(task.id) !== task) throw new Error("微信扫码任务已取消");
  if (options.signal?.aborted) throw options.signal.reason;
  if (options.deadline && Date.now() >= options.deadline) throw new Error("微信扫码任务阶段超时");
}

function runStage(task, stage, operation, timeoutMs) {
  if (task.operation) {
    if (task.operation.stage === stage) return task.operation.promise;
    const error = new Error("微信扫码任务正在执行其他阶段，请稍后重试");
    error.taskBusy = true;
    return Promise.reject(error);
  }
  const controller = new AbortController();
  const options = { signal: controller.signal, deadline: Date.now() + timeoutMs, timeoutMs };
  const pending = { stage, controller };
  task.operation = pending;
  const timer = setTimeout(() => controller.abort(new Error("微信扫码任务阶段超时")), timeoutMs);
  // 下层HTTP/native响应取消；保留stage单飞直到其真实结算，不能只race返回后丢掉在途操作。
  pending.promise = Promise.resolve().then(() => {
    assertActive(task, options); return operation(task, options);
  }).finally(() => {
    clearTimeout(timer);
    if (task.operation === pending) task.operation = undefined;
  });
  return pending.promise;
}

async function poll(task, options) {
  if (task.status === "authorized" || task.status === "ready_for_code") return;
  const status = await wxLogin.poll(task.session, options);
  assertActive(task, options);
  task.status = status;
}

async function confirm(task, options) {
  if (task.status === "ready_for_code") return;
  if (task.status !== "authorized") throw new Error("Waiting for scan authorization");
  const directory = wxCredentialDirectory();
  // confirm 前快照，防止等待扫码响应时覆盖另一进程的新凭据。
  const snapshots = new Map();
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith(".json")) snapshots.set(name, fs.readFileSync(path.join(directory, name), "utf8"));
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  assertActive(task, options);
  const session = task.session;
  await wxLogin.confirm(session, options);
  if (!session?.loginBuffer || !session?.openid) throw new Error("微信会话缺少可持久化凭据");
  const name = `${session.openid}.json`;
  const expected = snapshots.has(name) ? JSON.parse(snapshots.get(name)) : null;
  // 已取消的扫码不得创建新世代；在途 token 轮换另由回调立即 CAS 保存。
  assertActive(task, options);
  task.credential = persistWxLoginBuffer(session.openid, session.loginBuffer, session, expected, directory);
  task.credentialFile = path.join(directory, name);
  assertActive(task, options);
  task.status = "ready_for_code";
}

async function consumeCode(task, options) {
    assertActive(task, options);
    const { withWxCredentialOperation } = require("../services/wx-login/credential-storage");
    return withWxCredentialOperation(task.credentialFile, task.credential, () => consumeCodeLocked(task, options));
}

async function consumeCodeLocked(task, options) {
    assertActive(task, options);
  if (task.status !== "ready_for_code") throw new Error("Login code is not ready");
  const session = task.session;
  const openid = session.openid;
  const file = task.credentialFile;
  let credential = task.credential;
  const generation = credential.credentialGeneration;
  const binding = `wx-login:${openid}:${generation}`;
  const { writeWxCredential } = require("../services/wx-login/credential-storage");
  const checkCurrent = () => {
    if (file !== path.join(wxCredentialDirectory(), `${openid}.json`)
      || credential.credentialGeneration !== generation
      || JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(credential)) {
      throw Object.assign(new Error("微信凭据已交接或并发更新"), { stage: "credential_conflict" });
    }
  };
  const save = value => {
    checkCurrent();
    credential = writeWxCredential(file, value, credential);
    if (!task.cancelled) task.credential = credential;
    return credential;
  };
  checkCurrent();
  if (credential.nativeSession?.binding === binding && (credential.nativeSession.expiresAt === null
    || (Number.isFinite(credential.nativeSession.expiresAt) && credential.nativeSession.expiresAt <= Date.now()))) {
    save({ nativeSession: null });
  }
  const issue = () => wxLogin.issueCode(session, TARGET_APP_ID, {
    ...options, session: credential.nativeSession, sessionBinding: binding,
    onSession(value) {
      if (value?.binding !== binding) throw Object.assign(new Error("微信原生会话世代不匹配"), { stage: "credential_conflict" });
      // 首枚 Code 失败/取消仍保留已建立的会话，旧扫码则由 CAS 拒绝。
      save({ nativeSession: value });
      assertActive(task, options);
    },
  });
  let code;
  try {
    code = await issue();
  } catch (error) {
    if (error.stage === "credential_conflict" || error.stage === "persist_native_session") throw error;
    assertActive(task, options);
    // 短链阶段"解不出来"不是服务端拒绝：偏移/多 record 布局差异也会报同一码。
    // 只有服务端正面拒绝（ManualAuth -10）才续期缓冲；解码失败先按原错误上报，
    // 不消耗 token/buffer 请求去赌一个未证实的结论。
    if (error.code === "WX_NATIVE_TICKET_REJECTED") throw error;
    const rejected = error.code === "WX_MANUAL_AUTH_REJECTED" && error.serverCode === -10;
    if (!rejected) throw error;
    checkCurrent();
    const expiresAt = credential.accessTokenExpiresAt;
    if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() >= expiresAt) {
      const rotated = await wxLogin.refreshCredentials(session, {
        ...options,
        onCredentialsRotated(value) {
          // 轮换完成后先保存，再检查取消；不能丢失不可逆的服务端新 token。
          save(value);
          assertActive(task, options);
        },
      });
      assertActive(task, options);
      save(rotated);
      Object.assign(session, rotated);
    }
    assertActive(task, options);
    const refreshed = await wxLogin.refreshBufferWithAccessToken(session, options);
    assertActive(task, options);
    if (!refreshed?.loginBuffer) throw new Error("微信续期未返回有效 loginBuffer");
    save({ ...refreshed, nativeSession: null, loginBufferUpdatedAt: Date.now() });
    Object.assign(session, refreshed);
    code = await issue();
  }
  assertActive(task, options);
  if (typeof code !== "string" || !code) throw new Error("微信换码返回空 Code");
  const issuedAt = Date.now();
  save({ pendingCode: { value: code, generation, issuedAt, expiresAt: issuedAt + 60000, consumed: false } });
  task.code = code;
}

function registerAdminWxLoginRoutes({ app, provider }) {
  // 迁移控制在管理主进程同步完成，避免后台QQ更新昵称时穿插外部双文件提交。
  for (const action of ["prepare", "drained", "active"]) {
    app.post(`/api/wx-login/isolation/${action}`, (req, res) => {
      if (!["admin", "super_admin"].includes(req.currentUser?.role)) return res.status(403).json({ ok: false, error: "仅管理员可迁移微信托管" });
      try {
        const status = provider.getStatus("2");
        if (status?.connection?.connected === true) throw new Error("微信仍在线，拒绝迁移");
        const listed = provider.getAccounts();
        const accounts = Array.isArray(listed) ? listed : listed?.accounts || [];
        if (accounts.find(a => String(a.id) === "2")?.running === true) throw new Error("微信worker仍在运行，拒绝迁移");
        const routing = require("../runtime/gateway-routing");
        const data = action === "prepare"
          ? routing.prepareGatewayDelegation(req.body?.generation, req.body?.expectedAccountsSha256)
          : routing.advanceGatewayDelegation(req.body?.generation, action);
        return res.json({ ok: true, data });
      } catch (error) {
        return res.status(409).json({ ok: false, error: error.message });
      }
    });
  }
  app.post("/api/wx-login/tasks", async (req, res) => {
    if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) {
      return res.status(400).json({ ok: false, error: "Unsupported app_id" });
    }
    try {
      const task = await createTask(owner(req));
      res.json({
        ok: true,
        data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` },
      });
    } catch (error) {
      logger.warn("创建微信扫码任务失败", { error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/wx-login/tasks/:taskId/qr", (req, res) => {
    const task = findTask(req, res);
    if (task) res.type("jpeg").send(task.qr);
  });

  app.delete("/api/wx-login/tasks/:taskId", (req, res) => {
    const task = tasks.get(String(req.params.taskId || ""));
    if (!task || task.owner !== owner(req)) {
      return res.status(404).json({ ok: false, error: "Login task not found or expired" });
    }
    destroy(task);
    return res.json({ ok: true });
  });

  app.get("/api/wx-login/tasks/:taskId/status", async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      await runStage(task, "poll", poll, 45000);
      assertActive(task);
      const data = publicTask(task);
      if (task.status === "cancelled" || task.status === "expired") destroy(task);
      res.json({ ok: true, data });
    } catch (error) {
      if (error.taskBusy) return res.status(409).json({ ok: false, error: error.message });
      task.status = "failed";
      destroy(task);
      logger.warn("微信扫码状态轮询失败", { error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/wx-login/tasks/:taskId/confirm", async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      await runStage(task, "confirm", confirm, 75000);
      assertActive(task);
      res.json({ ok: true, data: publicTask(task) });
    } catch (error) {
      if (error.taskBusy) return res.status(409).json({ ok: false, error: error.message });
      task.status = "failed";
      destroy(task);
      logger.warn("微信扫码确认失败", { error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/wx-login/tasks/:taskId/code", async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      await runStage(task, "code", consumeCode, 75000);
      assertActive(task);
      const data = {
        openid: task.session.openid,
        app_id: TARGET_APP_ID,
        code: task.code,
        err_msg: "login:ok",
      };
      res.json({ ok: true, data });
      destroy(task);
    } catch (error) {
      if (error.taskBusy) return res.status(409).json({ ok: false, error: error.message });
      task.status = "failed";
      destroy(task);
      logger.warn("微信扫码换取 Code 失败", { error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminWxLoginRoutes };
