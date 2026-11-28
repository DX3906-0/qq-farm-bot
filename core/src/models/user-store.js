const fs = require('node:fs');
const crypto = require('node:crypto');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');

const USERS_FILE = getDataFile('users.json');
const LOGIN_ATTEMPTS_FILE = getDataFile('login-attempts.json');
const LOGIN_LOGS_FILE = getDataFile('login-logs.json');
const DEFAULT_ACCOUNT_LIMIT = 2;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 6;
const IP_LOCKOUT_DURATION = 10 * 60 * 1000;

let users = [];
let loginAttempts = {};
let loginLogs = [];
let logIdCounter = 0;

function loadUsers() {
  ensureDataDir();
  try {
    const data = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : {};
    users = Array.isArray(data.users) ? data.users : [];
  } catch (error) {
    console.error('加载用户数据失败:', error.message);
    users = [];
  }
}
function saveUsers() {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
}
function validatePasswordStrength(password) {
  const value = String(password || '');
  const errors = [];
  if (value.length < 6) errors.push('密码长度至少6位');
  if (value.length > 128) errors.push('密码长度不能超过128位');
  let complexity = 0;
  if (/[a-z]/.test(value)) complexity++;
  if (/[A-Z]/.test(value)) complexity++;
  if (/\d/.test(value)) complexity++;
  if (/[!@#$%^&*(),.?":{}|<>_\-+=[\]\\;'/`~]/.test(value)) complexity++;
  if (complexity < 2) errors.push('密码必须包含大写字母、小写字母、数字、特殊符号中的至少两种');
  if (['password', '123456', 'qwerty', 'abc123', '111111', '000000'].includes(value.toLowerCase())) errors.push('密码过于简单，请使用更复杂的密码');
  return { valid: errors.length === 0, errors };
}
function hashPassword(password, salt = crypto.randomBytes(SALT_LENGTH).toString('hex')) {
  return `${salt}:${crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [salt, expected] = stored.includes(':') ? stored.split(':') : ['', stored];
  const actual = stored.includes(':')
    ? crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex')
    : crypto.createHash('sha256').update(String(password)).digest('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
function loadLoginAttempts() {
  try {
    ensureDataDir();
    loginAttempts = fs.existsSync(LOGIN_ATTEMPTS_FILE) ? JSON.parse(fs.readFileSync(LOGIN_ATTEMPTS_FILE, 'utf8')) || {} : {};
  } catch { loginAttempts = {}; }
}
function saveLoginAttempts() {
  ensureDataDir();
  fs.writeFileSync(LOGIN_ATTEMPTS_FILE, JSON.stringify(loginAttempts, null, 2), 'utf8');
}
function cleanExpiredAttempts() {
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of Object.entries(loginAttempts)) {
    if ((entry.lockedUntil && entry.lockedUntil < now) || (entry.windowStart && now - entry.windowStart > RATE_LIMIT_WINDOW && !entry.lockedUntil)) {
      delete loginAttempts[key];
      changed = true;
    }
  }
  if (changed) saveLoginAttempts();
}
function checkRateLimit(ip) {
  loadLoginAttempts();
  cleanExpiredAttempts();
  const key = `ip:${ip}`;
  const now = Date.now();
  const entry = loginAttempts[key];
  if (!entry || (entry.windowStart && now - entry.windowStart > RATE_LIMIT_WINDOW && !entry.lockedUntil)) {
    loginAttempts[key] = { count: 1, windowStart: now };
    saveLoginAttempts();
    return { allowed: true };
  }
  if (entry.lockedUntil > now) return { allowed: false, remainingMs: entry.lockedUntil - now, message: `该 IP 登录失败过多，请 ${Math.ceil((entry.lockedUntil - now) / 1000)} 秒后重试` };
  if (entry.count >= MAX_ATTEMPTS_PER_IP) {
    entry.lockedUntil = now + IP_LOCKOUT_DURATION;
    saveLoginAttempts();
    return { allowed: false, remainingMs: IP_LOCKOUT_DURATION, message: `该 IP 登录失败过多，请 ${Math.ceil(IP_LOCKOUT_DURATION / 1000)} 秒后重试` };
  }
  entry.count++;
  saveLoginAttempts();
  return { allowed: true };
}
function checkAccountLockout(username) {
  cleanExpiredAttempts();
  const entry = loginAttempts[`user:${username}`];
  if (entry?.lockedUntil > Date.now()) return { locked: true, remainingMs: entry.lockedUntil - Date.now(), message: `账户已被锁定，请 ${Math.ceil((entry.lockedUntil - Date.now()) / 60000)} 分钟后重试` };
  return { locked: false };
}
function recordFailedAttempt(username) {
  const key = `user:${username}`;
  const entry = loginAttempts[key] || { count: 0, firstAttempt: Date.now() };
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= MAX_LOGIN_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_DURATION;
  loginAttempts[key] = entry;
  saveLoginAttempts();
  return entry.lockedUntil ? { locked: true, message: `登录失败次数过多，账户已被锁定 ${LOCKOUT_DURATION / 60000} 分钟` } : { locked: false, remainingAttempts: MAX_LOGIN_ATTEMPTS - entry.count };
}
function clearFailedAttempts(username) { delete loginAttempts[`user:${username}`]; saveLoginAttempts(); }
function clearIpAttempts(ip) { delete loginAttempts[`ip:${ip}`]; saveLoginAttempts(); }
function validateUser(username, password, ip = 'unknown') {
  loadUsers();
  loadLoginAttempts();
  const limit = checkRateLimit(ip);
  if (!limit.allowed) return { error: 'rate_limit', message: limit.message, remainingMs: limit.remainingMs };
  const lock = checkAccountLockout(username);
  if (lock.locked) return { error: 'locked', message: lock.message, remainingMs: lock.remainingMs };
  const user = users.find(item => item.username === username);
  if (!user || !verifyPassword(password, user.password)) {
    const failed = recordFailedAttempt(username);
    return failed.locked ? { error: 'locked', message: failed.message } : { error: 'invalid_credentials', message: `用户名或密码错误${failed.remainingAttempts ? `，剩余尝试次数: ${failed.remainingAttempts}` : ''}` };
  }
  clearFailedAttempts(username);
  clearIpAttempts(ip);
  if (!user.password.includes(':')) { user.password = hashPassword(password); saveUsers(); }
  return { username: user.username, role: user.role, accountLimit: user.accountLimit ?? DEFAULT_ACCOUNT_LIMIT, mustChangePassword: user.mustChangePassword === true };
}
function getAllUsers() {
  loadUsers();
  return users.map(({ username, role, accountLimit }) => ({ username, role, accountLimit: accountLimit ?? DEFAULT_ACCOUNT_LIMIT }));
}
function editUser(username, updates = {}) {
  loadUsers();
  const user = users.find(item => item.username === username);
  if (!user) return { ok: false, error: '用户不存在' };
  if (updates.newUsername && updates.newUsername !== username) {
    if (!/^\w{3,32}$/.test(updates.newUsername)) return { ok: false, error: '用户名只能包含字母、数字和下划线，长度3-32位' };
    if (users.some(item => item.username === updates.newUsername)) return { ok: false, error: '用户名已存在' };
    user.username = updates.newUsername;
  }
  if (updates.password) {
    const strength = validatePasswordStrength(updates.password);
    if (!strength.valid) return { ok: false, error: strength.errors.join('；') };
    user.password = hashPassword(updates.password);
  }
  if (updates.accountLimit !== undefined) {
    const limit = Number.parseInt(updates.accountLimit, 10);
    if (!Number.isFinite(limit) || limit < 1) return { ok: false, error: '账号额度必须大于0' };
    user.accountLimit = limit;
  }
  saveUsers();
  return { ok: true, user: { username: user.username, role: user.role, accountLimit: user.accountLimit ?? DEFAULT_ACCOUNT_LIMIT } };
}
function deleteUser(username, force = false) {
  loadUsers();
  const index = users.findIndex(item => item.username === username);
  if (index < 0) return { ok: false, error: '用户不存在' };
  if (!force && users[index].role === 'admin') return { ok: false, error: '不能删除管理员账号' };
  users.splice(index, 1);
  saveUsers();
  return { ok: true };
}
function changePassword(username, currentPassword, newPassword) {
  loadUsers();
  const user = users.find(item => item.username === username);
  if (!user) return { ok: false, error: '用户不存在' };
  if (!verifyPassword(currentPassword, user.password)) return { ok: false, error: '当前密码错误' };
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) return { ok: false, error: strength.errors.join('；') };
  user.password = hashPassword(newPassword);
  delete user.mustChangePassword;
  saveUsers();
  return { ok: true, message: '密码修改成功' };
}
function isSuperAdmin(username) { loadUsers(); return users.some(user => user.username === username && user.role === 'super_admin'); }
function getUserCount() { loadUsers(); return users.length; }
function clearAllData() { return { ok: true, clearedFiles: [] }; }
function loadLoginLogs() {
  ensureDataDir();
  try {
    const data = fs.existsSync(LOGIN_LOGS_FILE) ? JSON.parse(fs.readFileSync(LOGIN_LOGS_FILE, 'utf8')) : {};
    loginLogs = Array.isArray(data.logs) ? data.logs : [];
    logIdCounter = Number(data.counter) || 0;
  } catch { loginLogs = []; logIdCounter = 0; }
}
function saveLoginLogs() { ensureDataDir(); fs.writeFileSync(LOGIN_LOGS_FILE, JSON.stringify({ logs: loginLogs, counter: logIdCounter }, null, 2), 'utf8'); }
function addLoginLog(event, username, errorType, ip, userAgent) {
  loadLoginLogs();
  loginIdCounter++;
  loginLogs.push({ id: String(loginIdCounter), timestamp: Date.now(), event, username, errorType: errorType || null, ip, userAgent: userAgent || 'unknown' });
  if (loginLogs.length > 5000) loginLogs = loginLogs.slice(-5000);
  saveLoginLogs();
}
function getLoginLogs(limit = 100, offset = 0) {
  loadLoginLogs();
  const start = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const count = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const reversed = loginLogs.slice().reverse();
  return { logs: reversed.slice(start, start + count), total: reversed.length };
}
function clearLoginLogs() { loginLogs = []; logIdCounter = 0; saveLoginLogs(); return { ok: true }; }
function initConfiguredAdmin() {
  loadUsers();
  const username = String(process.env.FARM_ADMIN_USERNAME || '').trim();
  const password = String(process.env.FARM_ADMIN_PASSWORD || '');
  if (!username || !password || users.some(user => user.username === username)) return;
  if (!/^\w{3,32}$/.test(username) || !validatePasswordStrength(password).valid) {
    console.error('[用户系统] 环境变量管理员账号不符合用户名或密码强度规则');
    return;
  }
  users.push({ username, password: hashPassword(password), role: 'admin', accountLimit: -1, createdAt: Date.now(), mustChangePassword: true });
  saveUsers();
  console.log('[用户系统] 已按环境变量创建管理员账号；请首次登录后修改密码');
}
loadLoginLogs();
initConfiguredAdmin();
module.exports = { validateUser, getAllUsers, editUser, deleteUser, changePassword, DEFAULT_ACCOUNT_LIMIT, isSuperAdmin, clearAllData, getUserCount, checkRateLimit, clearIpAttempts, addLoginLog, getLoginLogs, clearLoginLogs, validatePasswordStrength };
