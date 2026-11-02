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
  try {
    wxLogin.destroy(task.session);
  } catch (_) {}
  task.code = undefined;
  tasks.delete(task.id);
}

// 持久化微信登录缓冲：微信 code 一次性，断线重连必须靠 loginBuffer 重新换码，否则会被 gameserver 顶下线
// 【保活关键】refreshtoken / accesstoken 必须一并落盘。
// loginBuffer 有效期很短（实测仅数分钟），断线重连时往往已过期；
// 只有凭 refreshtoken 才能续期出新的 loginBuffer —— 这才是微信账号的"保活"能力。
// 早期版本只落盘 loginBuffer（丢掉 refreshtoken），导致 loginBuffer 一过期就只能重新扫码，
// 表现为"扫码后没几分钟就掉线"（用户反馈的根因）。
function persistWxLoginBuffer(openid, loginBuffer, credentials) {
  const creds = credentials || {};
  try {
    fs.mkdirSync(WX_LOGIN_DIR, { recursive: true });
    const file = path.join(WX_LOGIN_DIR, `${String(openid)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      openid,
      appId: TARGET_APP_ID,
      loginBuffer,
      refreshtoken: creds.refreshtoken || "",
      accesstoken: creds.accesstoken || "",
      updatedAt: Date.now(),
    }));
  } catch (e) {
    logger.warn("微信 loginBuffer 持久化失败", { error: e.message });
  }
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

async function poll(task) {
  if (task.status === "authorized" || task.status === "ready_for_code") return;
  task.status = await wxLogin.poll(task.session);
}

async function confirm(task) {
  if (task.status !== "authorized") throw new Error("Waiting for scan authorization");
  await wxLogin.confirm(task.session);
  task.status = "ready_for_code";
}

async function consumeCode(task) {
  if (task.status !== "ready_for_code") throw new Error("Login code is not ready");
  // 微信首次会话约 1 分钟易被服务器踢（断线→loginBuffer 换码重连），先用 refreshtoken 刷新 loginBuffer
  // 取更稳定的会话再发 code；无 refreshtoken 或刷新失败时回退原始 loginBuffer（部分环境不回传 refreshtoken）
  try {
    if (task.session && task.session.refreshtoken) {
      const refreshed = await wxLogin.refreshLoginBuffer(task.session);
      if (refreshed && refreshed.loginBuffer) {
        task.session.loginBuffer = refreshed.loginBuffer;
        if (refreshed.accesstoken) task.session.accesstoken = refreshed.accesstoken;
        if (refreshed.refreshtoken) task.session.refreshtoken = refreshed.refreshtoken;
      }
    }
  } catch (e) {
    console.warn("微信 loginBuffer 刷新失败，回退原始 loginBuffer:", e.message);
  }
  task.code = await wxLogin.issueCode(task.session, TARGET_APP_ID);
}

function registerAdminWxLoginRoutes({ app }) {
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
      if (!task.pending) {
        task.pending = poll(task).finally(() => {
          task.pending = undefined;
        });
      }
      await task.pending;
      const data = publicTask(task);
      if (task.status === "cancelled" || task.status === "expired") destroy(task);
      res.json({ ok: true, data });
    } catch (error) {
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
      if (!task.pending) {
        task.pending = confirm(task).finally(() => {
          task.pending = undefined;
        });
      }
      await task.pending;
      res.json({ ok: true, data: publicTask(task) });
    } catch (error) {
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
      if (!task.pending) {
        task.pending = consumeCode(task).finally(() => {
          task.pending = undefined;
        });
      }
      await task.pending;
      // 持久化 loginBuffer：微信 code 一次性，断线重连需用 loginBuffer 重新换码，否则会被 gameserver 顶下线
      try {
        if (task.session && task.session.loginBuffer && task.session.openid) {
          // 传入完整 session：refreshtoken/accesstoken 一并落盘，供断线续期保活
          persistWxLoginBuffer(task.session.openid, task.session.loginBuffer, task.session);
        }
      } catch (e) { logger.warn("微信 loginBuffer 持久化失败", { error: e.message }); }
      const data = {
        openid: task.session.openid,
        app_id: TARGET_APP_ID,
        code: task.code,
        err_msg: "login:ok",
      };
      destroy(task);
      res.json({ ok: true, data });
    } catch (error) {
      task.status = "failed";
      destroy(task);
      logger.warn("微信扫码换取 Code 失败", { error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerAdminWxLoginRoutes };
