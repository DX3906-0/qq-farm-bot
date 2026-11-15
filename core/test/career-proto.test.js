const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

test('career proto preserves official totals and harvest details', async () => {
  const root = new protobuf.Root();
  await root.load([path.join(__dirname, '../src/proto/careerpb.proto')], { keepCase: true });
  const Reply = root.lookupType('gamepb.careerpb.CareerInfoGetReply');
  const encoded = Reply.encode(Reply.create({
    harvest_items: [
      { fruit_id: 40098, harvest_count: 5197 },
      { fruit_id: 40007, harvest_count: 4284 },
    ],
    total_harvest_count: 35329,
    total_steal_count: 1647,
    name: '测试农场主',
    level: 24,
    exp: 210674,
    gid: 1251852428,
  })).finish();
  const decoded = Reply.decode(encoded);

  assert.equal(Number(decoded.total_harvest_count), 35329);
  assert.equal(Number(decoded.total_steal_count), 1647);
  assert.equal(decoded.harvest_items.length, 2);
  assert.equal(Number(decoded.harvest_items[0].fruit_id), 40098);
  assert.equal(Number(decoded.harvest_items[0].harvest_count), 5197);
});

test('career request sends the target gid in field 1', async () => {
  const root = new protobuf.Root();
  await root.load([path.join(__dirname, '../src/proto/careerpb.proto')], { keepCase: true });
  const Request = root.lookupType('gamepb.careerpb.CareerInfoGetRequest');
  const decoded = Request.decode(Request.encode({ gid: 1251852428 }).finish());
  assert.equal(Number(decoded.gid), 1251852428);
});

function loadCareerService(response) {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/career.js'), 'utf8'), {
    module,
    require(name) {
      if (name === '../config/gameConfig') return { getItemById: () => null, getItemImageById: () => '', getPlantByFruitId: () => null };
      if (name === '../utils/utils') return { toNum: value => Number(value) || 0 };
      if (name === '../utils/network') return { sendMsgAsync: async () => ({ body: response }) };
      if (name === '../utils/proto') return { types: {
        CareerInfoGetRequest: { create: value => value, encode: value => ({ finish: () => value }) },
        CareerInfoGetReply: { decode: value => value },
      } };
      throw new Error(name);
    },
  });
  return module.exports;
}

test('career marks only an explicitly returned experience field as a real observation', async () => {
  for (const [reply, available] of [
    [{ gid: 42, exp: 0 }, true], [{ gid: 42, exp: 100 }, true],
    [{ gid: 42 }, false], [Object.assign(Object.create({ exp: 0 }), { gid: 42 }), false],
    [{ gid: 42, exp: -1 }, false],
  ]) {
    assert.equal((await loadCareerService(reply).getCareerInfo(42)).expAvailable, available);
  }
});

function loadExpRefresh(getCareerInfo) {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const { EventEmitter } = require('node:events');
  const events = new EventEmitter();
  const state = { gid: 42, exp: 100, level: 10 };
  const observations = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/exp-refresh.js'), 'utf8'), {
    module, Date,
    require(name) {
      if (name === './career') return { getCareerInfo };
      if (name === './stats') return { updateStats: (...args) => observations.push(args) };
      if (name === '../utils/network') return {
        networkEvents: events, getUserState: () => state, isConnected: () => true,
        applyUserExpPatch: patch => Object.assign(state, patch),
      };
      throw new Error(name);
    },
  });
  return { ...module.exports, events, state, observations };
}

test('harvest experience query preserves the single flight until the real request finishes', async () => {
  let resolve;
  let calls = 0;
  const h = loadExpRefresh(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = h.refreshExpAfterHarvest({ gid: 42, force: true });
  const second = h.refreshExpAfterHarvest({ gid: 42, force: true });
  assert.equal(h.getExpRefreshState().inflight, true);
  assert.equal(calls, 1);
  resolve({ gid: 42, exp: 0, level: 1, expAvailable: true });
  assert.equal((await first).exp, 0);
  assert.equal((await second).exp, 0);
  assert.equal(h.observations.length, 1);
  assert.equal(h.state.exp, 0);
  assert.equal(h.getExpRefreshState().inflight, false);
});

test('experience query ignores a response from before disconnection or from another GID', async () => {
  let resolve;
  const h = loadExpRefresh(() => new Promise(done => { resolve = done; }));
  const first = h.refreshExpAfterHarvest({ gid: 42, force: true });
  h.events.emit('disconnect');
  resolve({ gid: 42, exp: 500, expAvailable: true });
  assert.equal((await first).reason, 'session-changed');
  assert.equal(h.observations.length, 0);
  assert.equal(h.state.exp, 100);
  const other = loadExpRefresh(async () => ({ gid: 99, exp: 900, expAvailable: true }));
  assert.equal((await other.refreshExpAfterHarvest({ gid: 42, force: true })).reason, 'session-changed');
  assert.equal(other.observations.length, 0);
  const missing = loadExpRefresh(async () => ({ gid: 42, exp: 0, expAvailable: false }));
  assert.equal((await missing.refreshExpAfterHarvest({ gid: 42, force: true })).reason, 'exp-not-confirmed');
  assert.equal(missing.observations.length, 0);
});
