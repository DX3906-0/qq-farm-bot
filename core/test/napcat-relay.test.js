"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const path = require("node:path");

process.env.NAPCAT_RELAY_TOKEN = "test-token-123";
process.env.NAPCAT_RELAY_CREATE_WAIT_MS = "3000";

const {
  registerAdminQrLoginRoutes,
} = require(path.join(__dirname, "..", "src/controllers/admin-qr-login-routes.js"));

function startServer() {
  const app = express();
  app.use(express.json());
  registerAdminQrLoginRoutes({ app });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function makeClient(port) {
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, json: await r.json() };
  };
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, json: await r.json() };
  };
  return { post, get };
}

const AUTH = { "x-relay-token": "test-token-123" };

test("守护离线时 create 明确报错而不是静默失败", async () => {
  const { server, port } = await startServer();
  try {
    const { post } = makeClient(port);
    const r = await post("/api/qr/create", {});
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /守护未在线/);
  } finally {
    server.close();
  }
});

test("守护端点必须带 relay token", async () => {
  const { server, port } = await startServer();
  try {
    const { post } = makeClient(port);
    const bad = await post("/api/napcat-relay/heartbeat", { napcat: true });
    assert.equal(bad.status, 401);

    const ok = await post("/api/napcat-relay/heartbeat", { napcat: true }, AUTH);
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.data.tasks, []);
  } finally {
    server.close();
  }
});

test("完整中转闭环：建任务 → 领取 → 回填二维码 → 换码 → 面板取走", async () => {
  const { server, port } = await startServer();
  try {
    const { post, get } = makeClient(port);
    await post("/api/napcat-relay/heartbeat", { napcat: true, uin: "10001" }, AUTH);

    const createP = post("/api/qr/create", {});
    await new Promise((r) => setTimeout(r, 300));

    const poll = await post("/api/napcat-relay/heartbeat", { napcat: true, uin: "10001" }, AUTH);
    const task = poll.json.data.tasks[0];
    assert.ok(task, "守护应能领取到任务");
    assert.equal(task.status, "pending");

    await post("/api/napcat-relay/report", { id: task.id, status: "scanning", qrImage: "data:image/png;base64,AAAA" }, AUTH);

    const created = await createP;
    assert.equal(created.json.ok, true);
    assert.equal(created.json.data.code, task.id);
    assert.equal(created.json.data.image, "data:image/png;base64,AAAA");

    const wait = await post("/api/qr/check", { code: task.id });
    assert.equal(wait.json.data.status, "Wait");
    assert.equal(wait.json.data.image, "data:image/png;base64,AAAA");

    await post("/api/napcat-relay/report", { id: task.id, status: "done", uin: "10001", nickname: "测试号", code: "FARM-CODE-XYZ" }, AUTH);

    const done = await post("/api/qr/check", { code: task.id });
    assert.equal(done.json.data.status, "OK");
    assert.equal(done.json.data.code, "FARM-CODE-XYZ");
    assert.equal(done.json.data.uin, "10001");
    assert.match(done.json.data.avatar, /nk=10001/);

    const guard = await get("/api/qr/guard-status");
    assert.equal(guard.json.data.online, true);
    assert.equal(guard.json.data.uin, "10001");
  } finally {
    server.close();
  }
});

test("未知任务 id 返回 Error 而不是崩溃", async () => {
  const { server, port } = await startServer();
  try {
    const { post } = makeClient(port);
    const r = await post("/api/qr/check", { code: "deadbeef" });
    assert.equal(r.json.data.status, "Error");
  } finally {
    server.close();
  }
});
