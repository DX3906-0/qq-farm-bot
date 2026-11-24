const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const evidence = require('./fixtures/official-client-version.json');

test('运行时最低版本来自实际官方配置的version与proto，不猜版本日期', () => {
  const expected = evidence.config.version + '_' + evidence.config.proto;
  const runtime = require('../src/config/config');
  assert.equal(expected, '1.17.0.6_20261117');
  assert.equal(runtime.resolveClientVersion('1.16.1.6_20261028'), expected);
  assert.equal(runtime.resolveClientVersion(expected), expected);
  assert.equal(runtime.resolveClientVersion('1.17.0.7_20261117'), '1.17.0.7_20261117');
});

test('可移植版本夹具绑定官方资源摘要，本地保留原件时额外核对', () => {
  assert.match(evidence.source.sha256, /^[a-f0-9]{64}$/);
  const original = path.resolve(__dirname, '../../.workbuddy/diag/ranch-scene-20261120/official-client-config.json');
  if (!fs.existsSync(original)) return;
  const raw = fs.readFileSync(original);
  assert.equal(createHash('sha256').update(raw).digest('hex'), evidence.source.sha256);
  const config = JSON.parse(raw.toString('utf8'))[5][0][2].config;
  assert.deepEqual({ version: config.version, proto: config.proto }, evidence.config);
});
