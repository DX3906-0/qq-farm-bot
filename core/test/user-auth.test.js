const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const storePath = path.resolve(__dirname, '../src/models/user-store.js');

test('普通管理员认证、限速、账号维护保留且商业卡密API已移除', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-auth-cleanup-'));
  const script = String.raw`
process.env.FARM_DATA_DIR = process.argv[1];
process.env.FARM_ADMIN_USERNAME = 'test_admin';
process.env.FARM_ADMIN_PASSWORD = 'StrongPassword!482';
const store = require(process.argv[2]);
const assert = require('node:assert/strict');
const user = store.validateUser('test_admin', 'StrongPassword!482', '127.0.0.1');
assert.equal(user.username, 'test_admin');
assert.equal(user.role, 'admin');
assert.equal(store.getAllUsers()[0].username, 'test_admin');
assert.equal(store.editUser('test_admin', { accountLimit: 7 }).user.accountLimit, 7);
assert.equal(store.validateUser('test_admin', 'wrong-password', '127.0.0.2').error, 'invalid_credentials');
for (const name of ['registerUser', 'renewUser', 'getAllCards', 'createCard', 'claimCardByUA', 'verifyCardOwnership', 'resetPasswordByCard', 'clearExpiredUsers']) {
  assert.equal(name in store, false, name + ' must not be exported');
}
`;
  try {
    const result = spawnSync(process.execPath, ['-e', script, dataDir, storePath], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('既有账号库中的管理员和普通账号仍能登录，但不再暴露卡密字段', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-auth-migrate-'));
  const storeDir = path.join(dataDir, 'data');
  fs.mkdirSync(storeDir, { recursive: true });
  const salt = 'a'.repeat(64);
  const { execFileSync } = require('node:child_process');
  const passwordHash = execFileSync(process.execPath, ['-e', `process.stdout.write(require('node:crypto').pbkdf2Sync('ExistingPassword!482', '${salt}', 100000, 64, 'sha512').toString('hex'))`], { encoding: 'utf8' });
  fs.writeFileSync(path.join(storeDir, 'users.json'), JSON.stringify({ users: [
    { username: 'existing', password: `${salt}:${passwordHash}`, role: 'user', accountLimit: 3, cardCode: 'OLD-SECRET', card: { code: 'OLD-SECRET', expiresAt: Date.now() + 86400000 } },
  ] }));
  const script = String.raw`
process.env.FARM_DATA_DIR = process.argv[1];
const store = require(process.argv[2]);
const assert = require('node:assert/strict');
const result = store.validateUser('existing', 'ExistingPassword!482', '127.0.0.1');
assert.equal(result.username, 'existing');
assert.equal(result.accountLimit, 3);
assert.equal(Object.hasOwn(result, 'card'), false);
const user = store.getAllUsers()[0];
assert.equal(user.accountLimit, 3);
assert.equal(Object.hasOwn(user, 'card'), false);
assert.equal(Object.hasOwn(user, 'cardCode'), false);
`;
  try {
    const result = spawnSync(process.execPath, ['-e', script, storeDir, storePath], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
