"use strict";

/**
 * NapCat 扫码登录「服务器中转」任务中转站（纯内存）。
 *
 * 背景：QQ 小程序的官方 IDE 授权链路（q.qq.com/ide/login）要求扫码账号是该
 * 小程序的开发者/协作者，普通玩家换 code 必被腾讯拒（-3000）。唯一可行路径是
 * 让真实 QQ 客户端（本机 NapCat）扫码登录后调用 loginWithAppId 直取农场 code。
 *
 * 但本机 NapCat 在 NAT 之后，服务器不可达；且服务器内存不足以承载 NapCat。
 * 因此本服务只做「任务中转」：
 *   面板 → 建任务 → 本机补码守护轮询领取 → 操作 NapCat 出码/取码 → 回填结果
 * 守护不常开时，扫码入口会明确提示「本机守护未在线」，而不是静默失败。
 */

const crypto = require("node:crypto");

const TASK_TTL_MS = Math.max(60000, Number(process.env.NAPCAT_RELAY_TTL_MS) || 180000);
const CREATE_THROTTLE_MS = Math.max(
  0,
  Number(process.env.NAPCAT_RELAY_CREATE_THROTTLE_MS) || 15000,
);
const HEARTBEAT_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.NAPCAT_RELAY_HEARTBEAT_TIMEOUT_MS) || 60000,
);
const MAX_TASKS = Math.max(4, Number(process.env.NAPCAT_RELAY_MAX_TASKS) || 20);

const TERMINAL = new Set(["done", "error", "expired", "cancelled"]);

const tasks = new Map();
let activeTaskId = "";
let lastCreateAt = 0;
let lastHeartbeatAt = 0;
let lastHeartbeatMeta = {};

function prune() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    const ttl = TERMINAL.has(task.status) ? TASK_TTL_MS : TASK_TTL_MS * 3;
    if (now - task.updatedAt > ttl) tasks.delete(id);
  }
  while (tasks.size > MAX_TASKS) {
    const oldest = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    tasks.delete(oldest.id);
  }
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    status: task.status,
    qrImage: task.qrImage || "",
    uin: task.uin || "",
    nickname: task.nickname || "",
    code: task.code || "",
    error: task.error || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
  };
}

function isTerminal(task) {
  return !task || TERMINAL.has(task.status);
}

// ---------- 守护心跳 ----------
function heartbeat(meta = {}) {
  lastHeartbeatAt = Date.now();
  if (meta && typeof meta === "object") lastHeartbeatMeta = { ...meta };
}

function isOnline() {
  return Date.now() - lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS;
}

function heartbeatInfo() {
  return {
    online: isOnline(),
    lastSeenAt: lastHeartbeatAt,
    napcat: Boolean(lastHeartbeatMeta.napcat),
    uin: String(lastHeartbeatMeta.uin || ""),
    busy: Boolean(lastHeartbeatMeta.busy),
    version: String(lastHeartbeatMeta.version || ""),
  };
}

// ---------- 任务 ----------
function getTask(id) {
  prune();
  return tasks.get(String(id || "")) || null;
}

function createTask({ owner = "" } = {}) {
  prune();
  const now = Date.now();
  const active = tasks.get(activeTaskId);
  if (active && !isTerminal(active)) {
    // 前端 100s 自动刷新 / 快速重试：节流窗口内直接复用，避免频繁重启 NapCat 宿主
    if (now - active.createdAt < CREATE_THROTTLE_MS) return active;
    active.status = "cancelled";
    active.updatedAt = now;
  }
  lastCreateAt = now;
  const task = {
    id: crypto.randomBytes(12).toString("hex"),
    owner,
    status: "pending",
    qrImage: "",
    uin: "",
    nickname: "",
    code: "",
    error: "",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + TASK_TTL_MS,
  };
  tasks.set(task.id, task);
  activeTaskId = task.id;
  return task;
}

function listActive() {
  prune();
  const now = Date.now();
  const out = [];
  for (const task of tasks.values()) {
    if (isTerminal(task)) continue;
    if (task.expiresAt <= now) {
      task.status = "expired";
      task.error = "二维码已过期，请刷新重试";
      task.updatedAt = now;
      continue;
    }
    out.push(task);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

function updateTask(id, patch = {}) {
  const task = getTask(id);
  if (!task) return null;
  const allowed = ["status", "qrImage", "uin", "nickname", "code", "error"];
  for (const key of allowed) {
    if (patch[key] !== undefined && patch[key] !== null) task[key] = patch[key];
  }
  task.updatedAt = Date.now();
  return task;
}

function lastCreateAtMs() {
  return lastCreateAt;
}

// ---------- 二维码归一化 ----------
function looksLikeBase64(value) {
  return value.length > 128 && /^[a-z0-9+/=\r\n]+$/i.test(value);
}

/**
 * 把守护回传的二维码原始值统一成 data URL。
 * 兼容三种形态：data URL / 裸 base64 / 需要自行编码的二维码内容（url 等）。
 */
async function normalizeQrImage(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^data:image\//i.test(value)) return value;
  if (looksLikeBase64(value)) return `data:image/png;base64,${value}`;
  try {
    const QRCode = require("qrcode");
    return await QRCode.toDataURL(value, { width: 280, margin: 1 });
  } catch (error) {
    return "";
  }
}

module.exports = {
  heartbeat,
  isOnline,
  heartbeatInfo,
  createTask,
  getTask,
  listActive,
  isTerminal,
  updateTask,
  publicTask,
  normalizeQrImage,
  lastCreateAtMs,
  TASK_TTL_MS,
};
