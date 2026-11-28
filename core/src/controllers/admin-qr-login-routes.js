"use strict";

/**
 * QQ 扫码登录（面板侧）+ NapCat 中转（守护侧）。
 *
 * ── 为什么是「中转」而不是直连 ────────────────────────────────────────
 * 面板原来的 /api/qr/create 走的是 QQ 小程序开发者工具（IDE）授权链路
 * （q.qq.com/ide/devtoolAuth/GetLoginCode → q.qq.com/ide/login），出码与扫码都正常，
 * 但换 authCode 时腾讯要求扫码账号是目标小程序的在册开发者/协作者，普通玩家必然
 * 拿到 -3000（HANDOVER §9 已证伪）。唯一可行路径是让真实 QQ 客户端（本机 NapCat）
 * 扫码登录后调用 NodeMiscService.loginWithAppId 直取农场 Code。
 *
 * 但本机 NapCat 在 NAT 之后（服务器不可达），服务器内存也放不下 NapCat。因此这里
 * 只做「任务中转」：
 *   面板建任务 → 本机补码守护轮询领取 → 操作 NapCat 出码/换码 → 回填结果 → 面板取走
 *
 * 面板侧沿用原有 /api/qr/create + /api/qr/check 契约（前端零改动），区别只是
 * create 返回的 `code` 现在是「中转任务 id」而非 IDE 登录码。
 */

const crypto = require("node:crypto");
const relay = require("../services/napcat-relay");

const CREATE_WAIT_MS = Math.max(
  0,
  Number(process.env.NAPCAT_RELAY_CREATE_WAIT_MS) || 12000,
);
const CREATE_WAIT_STEP_MS = 400;

const RELAY_TOKEN = String(process.env.NAPCAT_RELAY_TOKEN || "").trim();

function relayEnabled() {
  return Boolean(RELAY_TOKEN);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function guardOk(req) {
  if (!relayEnabled()) return { ok: false, code: 503, error: "服务端未配置 NAPCAT_RELAY_TOKEN，扫码中转未启用" };
  const token = req.headers["x-relay-token"] || (req.body && req.body.token) || "";
  if (!timingSafeEqual(token, RELAY_TOKEN)) {
    return { ok: false, code: 401, error: "relay token 无效" };
  }
  return { ok: true };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAvatar(uin) {
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : "";
}

function registerAdminQrLoginRoutes({ app }) {
  // ───────────────────────── 守护侧（需 relay token） ─────────────────────────

  // 心跳 + 领取任务（合并成一个请求，减少本机到服务器的往返）
  app.post("/api/napcat-relay/heartbeat", (req, res) => {
    const gate = guardOk(req);
    if (!gate.ok) return res.status(gate.code).json({ ok: false, error: gate.error });

    const body = req.body || {};
    relay.heartbeat({
      napcat: body.napcat,
      uin: body.uin,
      busy: body.busy,
      version: body.version,
    });

    const tasks = relay.listActive().map((task) => relay.publicTask(task));
    res.json({ ok: true, data: { tasks, serverTime: Date.now() } });
  });

  // 回填任务进度 / 结果
  app.post("/api/napcat-relay/report", async (req, res) => {
    const gate = guardOk(req);
    if (!gate.ok) return res.status(gate.code).json({ ok: false, error: gate.error });

    const body = req.body || {};
    if (!body.id) return res.status(400).json({ ok: false, error: "Missing id" });

    const patch = {};
    for (const key of ["status", "uin", "nickname", "code", "error"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    // NapCat 返回的是二维码内容串（qrcodeurl），这里统一渲染成 data URL 再入任务
    if (body.qrImage !== undefined) {
      patch.qrImage = await relay.normalizeQrImage(body.qrImage);
      if (!patch.qrImage && body.qrImage) {
        return res.status(400).json({ ok: false, error: "二维码渲染失败" });
      }
    }
    const task = relay.updateTask(body.id, patch);
    if (!task) return res.status(404).json({ ok: false, error: "任务不存在或已过期" });
    res.json({ ok: true, data: relay.publicTask(task) });
  });

  // ───────────────────────── 面板侧（沿用原契约） ─────────────────────────

  app.post("/api/qr/create", async (req, res) => {
    if (!relayEnabled()) {
      return res.json({
        ok: false,
        error: "扫码中转未启用（服务端缺少 NAPCAT_RELAY_TOKEN）",
      });
    }
    if (!relay.isOnline()) {
      return res.json({
        ok: false,
        error: "本机补码守护未在线：请先在运行 NapCat 的电脑上启动守护，再刷新二维码",
      });
    }

    try {
      const task = relay.createTask({ owner: String(req.headers["x-forwarded-for"] || "") });
      // 二维码由守护异步产出：这里短暂等待，拿到就一并返回，省一次轮询
      const deadline = Date.now() + CREATE_WAIT_MS;
      while (!task.qrImage && !relay.isTerminal(task) && Date.now() < deadline) {
        await sleep(CREATE_WAIT_STEP_MS);
      }
      if (task.status === "error") {
        return res.json({ ok: false, error: task.error || "本机取码失败" });
      }
      res.json({
        ok: true,
        data: {
          code: task.id,
          image: task.qrImage || "",
          guard: relay.heartbeatInfo(),
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/qr/check", (req, res) => {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ ok: false, error: "Missing code" });
    }

    const task = relay.getTask(code);
    if (!task) {
      return res.json({ ok: true, data: { status: "Error", error: "二维码已失效，请刷新重试" } });
    }

    switch (task.status) {
      case "pending":
      case "scanning":
        return res.json({
          ok: true,
          data: { status: "Wait", image: task.qrImage || "", uin: task.uin || "" },
        });
      case "done":
        return res.json({
          ok: true,
          data: {
            status: "OK",
            code: task.code || "",
            uin: task.uin || "",
            avatar: toAvatar(task.uin),
            nickname: task.nickname || "",
          },
        });
      default:
        return res.json({
          ok: true,
          data: { status: "Error", error: task.error || "二维码已失效，请刷新重试" },
        });
    }
  });

  // 面板显示「守护在线状态」（供前端提示用，非必需）
  app.get("/api/qr/guard-status", (req, res) => {
    res.json({ ok: true, data: { enabled: relayEnabled(), ...relay.heartbeatInfo() } });
  });
}

module.exports = { registerAdminQrLoginRoutes };
