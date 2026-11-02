/**
 * 远程抓包登录助手（Windows 本地运行）
 *
 * 适用场景：bot 部署在远程服务器（如 Azure），服务器代码是原版（无自动代理功能）。
 * 本脚本在本机运行，调用服务器面板已有的抓包 API，自动完成：
 *
 *   1. 登录面板 → 创建抓包会话 → 服务器启动 MITM 代理
 *   2. 自动把 Windows 系统代理指向 <服务器IP>:<代理端口>
 *   3. 等你打开电脑 QQ 农场（Code 由服务器自动抓取）
 *   4. 抓到 Code 后自动判断：gid 与已有账号一致则更新该账号（保留原设置），
 *      否则添加新账号；最后恢复原始系统代理
 *
 * 用法：
 *   node remote-capture.js --panel http://YOUR_PANEL_HOST:3007 --user admin --pass $FARM_PANEL_PASS
 *   node remote-capture.js --cert-only --panel ...   # 仅下载服务器 CA 证书
 *
 * 参数均可省略：首次填写（或命令行传入）后会保存到本目录
 * .remote-capture-config.json，之后直接运行即可，无需再输入。
 * 首次使用前需安装服务器 CA 证书（--cert-only 下载后双击安装到
 * “受信任的根证书颁发机构”）。
 */

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, execFileSync, spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { platform: 'qq', certOnly: false, timeoutSec: 180, open: '', noOpen: false, autoConfirm: true, restartQq: false, probeAccount: false, pickAccount: false, closeFarm: true };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--panel') { args.panel = next; i += 1; }
    else if (key === '--user') { args.user = next; i += 1; }
    else if (key === '--pass') { args.pass = next; i += 1; }
    else if (key === '--platform') { args.platform = next === 'wx' ? 'wx' : 'qq'; i += 1; }
    else if (key === '--timeout') { args.timeoutSec = Math.max(30, Number.parseInt(next, 10) || 180); i += 1; }
    else if (key === '--cert-only') { args.certOnly = true; }
    else if (key === '--restore-proxy') { args.restoreProxy = true; }
    else if (key === '--open') { args.open = next; i += 1; }
    else if (key === '--no-open') { args.noOpen = true; }
    else if (key === '--ask-confirm') { args.autoConfirm = false; }
    else if (key === '--restart-qq') { args.restartQq = true; }
    else if (key === '--probe-account') { args.probeAccount = true; }
    else if (key === '--pick-account') { args.pickAccount = true; }
    else if (key === '--no-close-farm') { args.closeFarm = false; }
  }
  return args;
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, answer => resolve(String(answer || '').trim()));
  });
}

// ---------------------------------------------------------------------------
// 配置持久化（首次填写后免重复输入）
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(__dirname, '.remote-capture-config.json');

function loadSavedConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

function saveConfig(config) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// Windows 系统代理（注册表方式，独立实现，不依赖 bot 进程）
// ---------------------------------------------------------------------------

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const SAVED_STATE_FILE = path.join(__dirname, '.saved-proxy.json');
let savedProxy = null;

/**
 * 上次异常退出（如直接关闭窗口）留下的代理状态，从磁盘文件恢复。
 * 返回是否执行了恢复。
 */
function restoreLeftoverProxy() {
  try {
    if (!fs.existsSync(SAVED_STATE_FILE)) return false;
    const state = JSON.parse(fs.readFileSync(SAVED_STATE_FILE, 'utf8'));
    savedProxy = state;
    console.log('[!] 检测到上次异常退出残留的代理设置，正在自动恢复...');
    restoreSystemProxy();
    return true;
  } catch {
    try { fs.unlinkSync(SAVED_STATE_FILE); } catch { /* 忽略 */ }
    return false;
  }
}

function readCurrentProxy() {
  const read = (value) => {
    try {
      const out = execSync(`reg query "${REG_PATH}" /v ${value}`, { encoding: 'utf8', windowsHide: true });
      const match = out.match(/REG_\w+\s+(.+)/i);
      return match ? match[1].trim() : '';
    } catch {
      return '';
    }
  };
  return {
    enabled: /0x1\b/i.test(read('ProxyEnable')),
    server: read('ProxyServer'),
    bypass: read('ProxyOverride'),
  };
}

function broadcastSettingsChange() {
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$s=@'
[DllImport("user32.dll")]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@; Add-Type -MemberDefinition $s -Name Win32 -Namespace User32 -ErrorAction SilentlyContinue; [User32.Win32]::SendMessageTimeout(0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref][UIntPtr]::Zero) | Out-Null`,
    ], { windowsHide: true, timeout: 10000 });
  } catch {
    // 广播失败时代理设置仍会在应用下次读取时生效
  }
}

function enableSystemProxy(host, port) {
  if (os.platform() !== 'win32') {
    throw new Error('本脚本仅支持 Windows（系统代理自动管理）');
  }
  if (!savedProxy) {
    savedProxy = readCurrentProxy();
    // 持久化到磁盘：即使进程被强杀（如直接关窗口），下次运行也能恢复
    try { fs.writeFileSync(SAVED_STATE_FILE, JSON.stringify(savedProxy)); } catch { /* 忽略 */ }
  }
  execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`, { windowsHide: true });
  execSync(`reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`, { windowsHide: true });
  execSync(`reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "<local>;${host};localhost;127.*" /f`, { windowsHide: true });
  broadcastSettingsChange();
}

function restoreSystemProxy() {
  if (os.platform() !== 'win32' || !savedProxy) return;
  const state = savedProxy;
  savedProxy = null;
  try {
    execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d ${state.enabled ? 1 : 0} /f`, { windowsHide: true });
    if (state.server) {
      execSync(`reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${state.server}" /f`, { windowsHide: true });
    } else {
      try { execSync(`reg delete "${REG_PATH}" /v ProxyServer /f`, { windowsHide: true }); } catch { /* 原本没有 */ }
    }
    if (state.bypass) {
      execSync(`reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "${state.bypass}" /f`, { windowsHide: true });
    } else {
      try { execSync(`reg delete "${REG_PATH}" /v ProxyOverride /f`, { windowsHide: true }); } catch { /* 原本没有 */ }
    }
    broadcastSettingsChange();
    console.log('[√] 系统代理已恢复原状');
  } catch {
    try {
      execSync(`reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`, { windowsHide: true });
      broadcastSettingsChange();
      console.log('[!] 精确恢复失败，已强制关闭系统代理');
    } catch { /* 尽力了 */ }
  }
  try { fs.unlinkSync(SAVED_STATE_FILE); } catch { /* 忽略 */ }
}

// ---- QQ 农场小程序自动拉起（Windows 本机） ----
// 自动探测工具目录下的小程序快捷方式（.lnk/.url），多个或不匹配时需用 --open 显式指定。
function detectDefaultShortcut() {
  try {
    const files = fs.readdirSync(__dirname);
    const cands = files.filter(f => /\.(lnk|url)$/i.test(f) && /农场|qq|farm|小程序/i.test(f));
    if (cands.length === 1) return path.join(__dirname, cands[0]);
    return null; // 多个候选不匹配 → 让脚本退回手动模式
  } catch {
    return null;
  }
}

// 用系统默认方式打开快捷方式/URL（explorer 处理空格更稳定，失败回退到 cmd start）。
// 注意：必须用非阻塞 spawn + detached + stdio:ignore，绝不能 execFileSync 同步等待——
// explorer.exe 是常驻进程不会退出，cmd /c start 的子进程会继承管道导致 cmd 也不退出，
// 同步等待必然 ETIMEDOUT。返回 true=已触发打开，false=未能触发。
function launchShortcut(target) {
  if (!target || !fs.existsSync(target)) {
    console.log(`[!] 快捷方式不存在: ${target}`);
    return false;
  }
  try {
    const child = spawn('explorer', [target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch (err) {
    try {
      const child = spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    } catch (err2) {
      console.log(`[!] 自动打开失败: ${err2.message}`);
      return false;
    }
  }
}

// 强制关闭 QQ（可选）。重抓 Code 时若农场已在运行可能不重新登录，--restart-qq 可先踢掉 QQ 强制重登。
function restartQQ() {
  try {
    execSync('taskkill /im QQ.exe /f', { windowsHide: true, timeout: 10000 });
  } catch { /* 本来就没运行 */ }
}

// 可选调试：带 --probe-account 时，在打开农场后延时给 QQ 弹出"选择账号"框的时间，
// 再调用 probe-watch.ps1 持续监听"新出现的可见 QQ 窗口"（即选号框），把窗口矩形 dump 到文件，
// 供判断能否用程序自动点选目标账号。非阻塞，不打断抓码主流程。
function probeAccountWindow(openTarget) {
  if (!openTarget) return;
  const probePs1 = require('node:path').join(__dirname, 'probe-watch.ps1');
  if (!require('node:fs').existsSync(probePs1)) {
    console.log('[i] 未找到监听探针 probe-watch.ps1，跳过 UI 探测');
    return;
  }
  console.log('[i] --probe-account: 将监听 QQ"选择账号"窗口是否弹出...');
  // 延时 ~4s，等 QQ 收到 openQQMiniApp 指令开始处理；之后监听探针自行持续盯到新窗口出现
  setTimeout(() => {
    try {
      const outFile = require('node:path').join(__dirname, '_probe-picker.txt');
      // probe-watch.ps1 后台持续监听约 70s（覆盖抓码主要时段），发现新可见窗口即写结果文件
      const child = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', probePs1, '70', '-OutFile', outFile
      ], { windowsHide: true });
      child.on('exit', (code) => {
        console.log(`[i] 探针结束 (exit=${code})，结果见 ${outFile}（若 QQ 未弹选号框则写 timeout）`);
      });
    } catch (err) {
      console.log(`[!] 探针运行失败: ${err.message}`);
    }
  }, 4000);
}

/**
 * 可选调试：带 --pick-account 时，在打开农场后启动 pick-account.py，
 * 让脚本监控 QQ "选择账号" 弹窗并自动点确定。
 * 优先 OCR 模式：把目标账号的 QQ 号（gid）传给 pick-account.py --qq-id，
 * 它会截图选号框 + Windows OCR 读取每行文本，精确点显示该 QQ 号的那一行
 * —— 不依赖行顺序假设（历史事故：行顺序变化导致罗辑的 Code 写到了
 * 比尔希恩斯头上）。OCR 不可用时退回按 id 推导的行号模式。
 * 非阻塞，不打断抓码主流程。
 */
function pickAccountWindow(targetAccount) {
  const pickPy = path.join(__dirname, 'pick-account.py');
  if (!fs.existsSync(pickPy)) {
    console.log('[i] 未找到 pick-account.py，跳过选号框自动点击');
    return;
  }
  const gid = targetAccount && targetAccount.gid ? String(targetAccount.gid) : '';
  // 关键：面板 gid 是农场游戏 ID，不是选号框上显示的 QQ 号（实测 gid=1000000003
  // 的账号在选号框显示 1000000002）。所以 gid 经常匹配不到任何行，昵称关键词才是
  // 首选（CJK OCR 对大字远比小字号数字可靠）。
  const nick = targetAccount ? String(targetAccount.nick || targetAccount.name || '') : '';
  // 历史默认映射（QQ NT 弹窗顺序: 第一行=比尔希恩斯 id=10, 第二行=罗輯 id=1），
  // 仅作 OCR 失败时的兜底。
  const tid = targetAccount ? targetAccount.id : null;
  const row = (tid === 10) ? 1 : 2;
  console.log(`[i] --pick-account: 已启动监控，OCR 匹配「${nick || gid || '未知'}」（失败退回 row=${row}）...`);
  // 立即启动（不能再延迟）：脚本一启动就枚举当前窗口，之后出现的选号框会被捕获。
  setTimeout(() => {
    try {
      const outFile = path.join(__dirname, '_pick-result.txt');
      // Prefer the managed Python known in this environment; fall back to PATH.
      let pythonExe = 'C:\\Users\\HP\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
      if (!fs.existsSync(pythonExe)) {
        pythonExe = 'python';
      }
      const argsList = [
        pickPy,
        '--row', String(row),
        '--timeout', '120',
        '--outfile', outFile,
      ];
      if (gid) argsList.push('--qq-id', gid);
      if (nick) argsList.push('--nick', nick);
      const child = spawn(pythonExe, argsList, { windowsHide: true });
      child.on('exit', (code) => {
        console.log(`[i] 选号框点击器结束 (exit=${code})，结果见 ${outFile}`);
      });
    } catch (err) {
      console.log(`[!] 选号框点击器运行失败: ${err.message}`);
    }
  }, 200);
}

/**
 * 补码成功后自动关闭 QQ 农场小程序窗口。
 * 安全约束（不可放宽）：close-farm.ps1 只关闭「QQ 进程中标题含"农场"」的窗口，
 * 且仅发送 WM_CLOSE 优雅关闭，绝不 kill 任何进程 —— 避免误伤 QQ 主窗口导致掉线。
 * 用 execFileSync 同步等待，确保关闭完成后主流程才退出。
 */
function closeFarmWindow() {
  const closePs1 = path.join(__dirname, 'close-farm.ps1');
  if (!fs.existsSync(closePs1)) {
    console.log('[i] 未找到 close-farm.ps1，跳过关闭小程序');
    return;
  }
  console.log('[i] 正在关闭 QQ 农场小程序窗口...');
  try {
    const outFile = path.join(__dirname, '_close-farm.txt');
    execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', closePs1,
      '-OutFile', outFile,
    ], { windowsHide: true, stdio: 'ignore' });
    console.log(`[√] 农场小程序已关闭（详情见 ${outFile}）`);
  } catch (err) {
    // 脚本 exit!=0 时会抛错；多数情况是没找到农场窗口，属于无害情况
    console.log(`[i] 关闭小程序未完全成功（可能窗口已关闭或未找到），详情见 _close-farm.txt`);
  }
}

// ---------------------------------------------------------------------------
// 面板 API 客户端
// ---------------------------------------------------------------------------

async function panelRequest(panelUrl, method, apiPath, { token = '', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['x-admin-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${panelUrl}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`面板返回无效响应 (HTTP ${response.status})`); }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (HTTP ${response.status})`);
  }
  return data;
}

async function login(panelUrl, username, password) {
  const data = await panelRequest(panelUrl, 'POST', '/api/login', {
    body: { username, password },
  });
  const token = data?.data?.token || '';
  if (!token) throw new Error('登录成功但未返回令牌');
  return token;
}

async function downloadCertificate(panelUrl, flow) {
  const certPath = flow?.publicInfo?.certificateUrl || '';
  if (!certPath) throw new Error('会话未返回证书下载地址');
  const response = await fetch(`${panelUrl}${certPath}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`证书下载失败 (HTTP ${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(process.cwd(), 'mitmproxy-ca-cert.cer');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ---------------------------------------------------------------------------
// “刚被顶下线”的账号检测（通过账号日志中的踢下线事件）
// ---------------------------------------------------------------------------

/**
 * 在电脑上登录 QQ 会把服务器上对应账号的 bot 踢下线，worker-manager 会写入
 * kickout_stop / ws_reconnect_failed / ws_400（登录失效）日志。
 * 查找最近 windowMs 内被踢下线的账号，取“最近一次被踢且当前已停止运行”的那个：
 * - 找到 → 大概率就是本次要重新登录的 QQ，返回该账号
 * - 找不到 → 返回 null
 * 日志结构: { time: 'YYYY-MM-DD HH:mm:ss', action, msg, accountId, accountName, ... }
 */
async function detectRecentlyKickedAccount(panelUrl, token, candidates, windowMs = 30 * 60 * 1000) {
  try {
    // 服务器日志时间是服务器本地墙钟（可能与中国时区不同，如 Azure 默认 UTC），
    // 因此用 /api/health 的 epoch 时间戳校准：只算相对时间差，不受时区影响
    const health = await fetch(`${panelUrl}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!health.ok) return null;
    const healthTs = Number((await health.json())?.timestamp) || 0;
    if (!healthTs) return null;

    const response = await fetch(`${panelUrl}/api/account-logs?limit=200`, {
      headers: { Accept: 'application/json', 'x-admin-token': token },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const logs = await response.json();
    if (!Array.isArray(logs) || logs.length === 0) return null;

    const parseWall = (entry) => Date.parse(String(entry?.time || '').replace(' ', 'T'));
    const newestWall = Math.max(...logs.map(parseWall).filter(Number.isFinite));
    if (!Number.isFinite(newestWall)) return null;
    // 最新一条日志距现在的真实时长（毫秒）
    const newestAgeMs = Math.max(0, Date.now() - healthTs);

    const candidateIds = new Set(candidates.map(a => String(a.id)));
    // 收集每个候选账号最近一次被踢/失效的真实时长（毫秒）
    const latestAge = new Map();
    for (const entry of logs) {
      const action = String(entry?.action || '');
      if (!/kickout_stop|ws_reconnect_failed|ws_400/.test(action)) continue;
      const wall = parseWall(entry);
      if (!Number.isFinite(wall)) continue;
      const ageMs = newestAgeMs + (newestWall - wall);
      if (ageMs > windowMs || ageMs < -60000) continue;
      const id = String(entry?.accountId || '');
      if (!candidateIds.has(id)) continue;
      if (!latestAge.has(id) || ageMs < latestAge.get(id)) latestAge.set(id, ageMs);
    }
    if (latestAge.size === 0) return null;
    // 取最近一次被踢的账号；双重确认：它当前应已停止运行（被踢后 worker 会自动停止）
    const [hitId] = [...latestAge.entries()].sort((a, b) => a[1] - b[1])[0];
    const account = candidates.find(a => String(a.id) === hitId);
    if (account && account.running === true) return null;
    return account || null;
  } catch {
    return null;
  }
}

/**
 * 获取账号日志中最近一次踢下线（kickout_stop）事件，返回
 * { accountId, ageMs }（ageMs 为距服务器当前时刻的真实时长，不受时区影响）；
 * 无记录返回 null。用于脚本启动后监听“用户登录 QQ 踢掉了哪个 bot”，
 * 比 running 字段可靠（worker 可能带着失效 Code 自动重连、状态失真）
 */
async function findNewestKickEvent(panelUrl, token) {
  try {
    const health = await fetch(`${panelUrl}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!health.ok) return null;
    const healthTs = Number((await health.json())?.timestamp) || 0;
    if (!healthTs) return null;

    const response = await fetch(`${panelUrl}/api/account-logs?limit=100`, {
      headers: { Accept: 'application/json', 'x-admin-token': token },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const logs = await response.json();
    if (!Array.isArray(logs) || logs.length === 0) return null;

    const parseWall = (entry) => Date.parse(String(entry?.time || '').replace(' ', 'T'));
    const newestWall = Math.max(...logs.map(parseWall).filter(Number.isFinite));
    if (!Number.isFinite(newestWall)) return null;
    const newestAgeMs = Math.max(0, Date.now() - healthTs);

    let best = null;
    for (const entry of logs) {
      if (!/kickout_stop/.test(String(entry?.action || ''))) continue;
      const wall = parseWall(entry);
      if (!Number.isFinite(wall)) continue;
      const ageMs = newestAgeMs + (newestWall - wall);
      if (!best || ageMs < best.ageMs) {
        best = { accountId: String(entry?.accountId || ''), ageMs };
      }
    }
    return best;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (os.platform() !== 'win32') {
    console.error('本脚本仅支持 Windows。');
    process.exit(1);
  }

  // 自愈：若上次被强杀（如直接关闭窗口）导致代理残留，先恢复
  const restored = restoreLeftoverProxy();
  if (args.restoreProxy) {
    if (!restored) console.log('[√] 没有需要恢复的代理残留，当前代理未被动过。');
    return;
  }

  const saved = loadSavedConfig();
  const fromSaved = !args.panel && !args.user && !args.pass && saved.panel && saved.user && saved.pass;
  if (fromSaved) {
    console.log(`[i] 使用已保存配置: ${saved.panel} / ${saved.user}（如需更换请加 --panel/--user/--pass 参数）`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const panelUrl = String(args.panel || saved.panel || await ask(rl, '面板地址（如 http://YOUR_PANEL_HOST:3007）: ')).replace(/\/+$/, '');
  const username = args.user || saved.user || await ask(rl, '用户名: ');
  const password = args.pass || saved.pass || await ask(rl, '密码: ');
  rl.close();
  console.log('');

  if (!/^https?:\/\//i.test(panelUrl) || !username || !password) {
    console.error('缺少面板地址 / 用户名 / 密码');
    process.exit(1);
  }

  // 保存本次使用的配置，下次运行免输入
  saveConfig({ panel: panelUrl, user: username, pass: password });

  let panelHost = '';
  try {
    panelHost = new URL(panelUrl).hostname;
  } catch {
    console.error('面板地址格式无效');
    process.exit(1);
  }

  // 任何退出路径都要恢复代理
  let restoring = false;
  const guard = () => { if (!restoring) { restoring = true; restoreSystemProxy(); } };
  process.on('exit', guard);
  process.on('SIGINT', () => { console.log('\n[!] 收到中断，正在清理...'); guard(); process.exit(130); });

  try {
    // 1. 登录
    console.log('[1/4] 登录面板...');
    const token = await login(panelUrl, username, password);

    // 2. 预检查已有账号，决定“更新旧账号”还是“新增”
    let existingQqAccounts = [];
    try {
      const accData = await panelRequest(panelUrl, 'GET', '/api/accounts', { token });
      existingQqAccounts = (accData?.data?.accounts || []).filter(a => (a?.platform || 'qq') === args.platform);
    } catch { /* 查询失败时退化为纯新增模式 */ }

    // 只有一个同平台账号 → 直接更新模式
    let updateTarget = args.platform === 'qq' && existingQqAccounts.length === 1 ? existingQqAccounts[0] : null;
    // heuristicTarget：目标是脚本推断的（非用户明确选择、也尚未被信号确认）。
    // 默认全自动：零确认信号时自动写入并记日志（--ask-confirm 恢复人工确认）；
    // 登录信号不符（踢下线/gid）时上游会自动 rebind 纠正目标。
    let heuristicTarget = !!updateTarget;
    // 用户明确选择了目标：由用户负责，最后一步不再追问（踢/gid 自动纠正仍生效）
    let userPicked = false;
    // 推断目标的踢下线确认基线：脚本启动前已有的 kick 记录不作为新事件
    let baselineKickAgeMs = Infinity;

    // 多个账号时在打开农场之前推断更新目标，避免抓到 Code 后才切换、导致农场要重开一次：
    // 1) 恰好一个账号掉线，或最近几分钟内恰好只有一个账号被踢下线 → 本次要补抓的大概率就是它
    //    （两个信号任一命中即可，推断目标后续会用“登录时踢掉谁”和 gid 双重确认，猜错会自动纠正）
    // 2) 全部信号都不命中 → 默认选第一个账号，等登录后靠踢下线/gid 信号自动纠正，
    //    全程无需人工确认（--ask-confirm 可恢复人工模式）
    if (!updateTarget && args.platform === 'qq' && existingQqAccounts.length > 1) {
      const stopped = existingQqAccounts.filter(a => a.running === false);
      if (stopped.length === 1 && stopped[0].gid) {
        updateTarget = stopped[0];
        heuristicTarget = true;
        console.log(`[i] 账号“${updateTarget.name || updateTarget.id}”当前掉线，推断为本次更新目标（gid 不符时会自动纠正）`);
      } else {
        // running 状态可能失真（worker 带着失效 Code 反复重连），用最近 5 分钟内的
        // 踢下线事件交叉判断：用户刚被顶下线才会来重新抓包，这个信号很贴近现实
        const kick = await findNewestKickEvent(panelUrl, token);
        const recentKickAcc = (kick && kick.ageMs <= 5 * 60 * 1000)
          ? existingQqAccounts.find(a => String(a.id) === kick.accountId)
          : null;
        if (recentKickAcc?.gid) {
          updateTarget = recentKickAcc;
          heuristicTarget = true;
          console.log(`[i] 账号“${updateTarget.name || updateTarget.id}”刚被顶下线，推断为本次更新目标（gid 不符时会自动纠正）`);
        }
      }
      if (!updateTarget) {
        updateTarget = existingQqAccounts[0];
        heuristicTarget = true;
        console.log(`[i] 多账号且无掉线/被踢信号，默认更新第一个账号“${updateTarget.name || updateTarget.id}”`);
        console.log('    （登录后若实际登录的是别的账号，会通过踢下线/gid 信号自动纠正）');
      }
    }
    if (heuristicTarget) {
      baselineKickAgeMs = (await findNewestKickEvent(panelUrl, token))?.ageMs ?? Infinity;
    }

    // 3. 创建抓包会话（服务器自动启动 MITM 代理）
    console.log(updateTarget
      ? `[2/4] 创建抓包会话（更新模式 → 已有账号: ${updateTarget.name || updateTarget.id}）...`
      : '[2/4] 创建抓包会话...');
    const created = await panelRequest(panelUrl, 'POST', '/api/capture/sessions', {
      token,
      body: { platform: args.platform, ...(updateTarget ? { accountId: updateTarget.id } : {}) },
    });
    let flow = created?.data;
    if (!flow?.id) throw new Error('创建抓包会话失败');

    // 重建抓包会话并切换目标（已抓到的 Code 无法跨会话迁移，之后需重开一次农场）
    const rebindSession = async (targetAccount, reason) => {
      console.log(`[i] ${reason}`);
      await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
      const recreated = await panelRequest(panelUrl, 'POST', '/api/capture/sessions', {
        token,
        body: { platform: args.platform, ...(targetAccount ? { accountId: targetAccount.id } : {}) },
      });
      if (!recreated?.data?.id) throw new Error('重建会话失败');
      flow = recreated.data;
      rebound = true;
      const newPort = Number(flow.publicInfo?.mitmPort) || 0;
      const newHost = String(flow.publicInfo?.host || panelHost);
      if (newPort) enableSystemProxy(newHost, newPort);
      deadline = Date.now() + args.timeoutSec * 1000;
      console.log('==============================================');
      console.log('  代理已更新，请重新打开一次 QQ 农场');
      console.log(targetAccount
        ? `  之后将更新已有账号 ${targetAccount.name || targetAccount.id}（原设置保留）`
        : '  之后将按新增账号处理');
      console.log('==============================================');
    };

    // 仅下载证书模式
    if (args.certOnly) {
      const filePath = await downloadCertificate(panelUrl, flow);
      console.log(`[√] 证书已保存: ${filePath}`);
      console.log('    请双击安装到“受信任的根证书颁发机构”（只需一次）');
      await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
      return;
    }

    const proxyPort = Number(flow?.publicInfo?.mitmPort) || 0;
    const proxyHost = String(flow?.publicInfo?.host || panelHost);
    if (!proxyPort) throw new Error('服务器未返回代理端口（请确认面板已开启抓包登录）');

    // 4. 设置本机系统代理
    console.log(`[3/4] 设置系统代理 → ${proxyHost}:${proxyPort}`);
    enableSystemProxy(proxyHost, proxyPort);

    // 4.5 自动拉起 QQ 农场小程序（无需手动点开）
    const openTarget = args.open || (!args.noOpen ? detectDefaultShortcut() : null);
    if (openTarget) {
      // 关键：必须在【打开农场之前】启动选号框点击器，让它先记录当前窗口基线，
      // 之后"新出现"的窗口才是真正的选号框。放在打开农场之后再启动会把常驻的
      // QQ 窗口（同样是 Chrome_WidgetWin_1 + 320x320）误当成选号框去点击。
      if (args.pickAccount) {
        // 透传整个目标账号（含 gid/QQ 号，供 OCR 精确匹配选号框行）
        pickAccountWindow(updateTarget);
      }
      if (args.restartQq) {
        console.log('[i] --restart-qq: 先关闭 QQ 以强制重新登录...');
        restartQQ();
        await new Promise(r => setTimeout(r, 2500));
      }
      console.log(`[3.5/4] 自动打开 QQ 农场小程序: ${openTarget}`);
      const launched = launchShortcut(openTarget);
      if (!launched) {
        console.log('[!] 未能自动触发打开，请手动打开 QQ 农场（若已手动打开可忽略此提示）');
      }
      // 关键：农场是 Chromium 窗口，后台挂起后会白屏。必须激活一次触发加载。
      // 方案：轮询等农场窗口出现(选号框点击后才创建) → 移到屏幕外强制激活触发加载
      //       → 保活验证期内窗口不被 Chromium 遮挡降级 → 停靠到屏幕边缘露一角。
      setTimeout(() => {
        try {
          const pythonExe = 'C:\\Users\\HP\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
          const activatePy = path.join(__dirname, 'activate-farm.py');
          if (fs.existsSync(activatePy)) {
            console.log('[i] --activate-farm: 已启动后台加载激活器(等待农场窗口出现, 最长90s)...');
            // --wait 90: 覆盖 选号框弹出+点击+农场窗口创建 的总耗时
            // --load 8:  屏幕外激活 8 秒触发 Chromium 加载(实测有效)
            // --verify 60: 加载后保活 60 秒, 防止立即被遮挡降级
            spawn(pythonExe, [activatePy, '--wait', '90', '--load', '8', '--verify', '60'], { windowsHide: true }).unref();
          } else {
            console.log('[!] 未找到 activate-farm.py，跳过农场加载激活');
          }
        } catch (err) {
          console.log(`[!] 农场加载激活失败: ${err.message}`);
        }
      }, 200);
      if (args.probeAccount) probeAccountWindow(openTarget);
    }

    console.log('');
    console.log('==============================================');
    if (openTarget) {
      console.log('  已自动打开 QQ 农场，等待抓取 Code...');
    } else {
      console.log('  现在请打开电脑 QQ → QQ 农场（保持页面打开）');
    }
    console.log('  抓到 Code 后会自动完成，无需其他操作');
    console.log(`  最长等待 ${args.timeoutSec} 秒，Ctrl+C 可随时退出（代理会自动恢复）`);
    console.log('==============================================');
    console.log('');


    // 5. 轮询抓取结果
    let deadline = Date.now() + args.timeoutSec * 1000;
    let captured = false;
    let aborted = false; // 主动取消（目标不一致/用户拒绝确认），结束时不再提示超时排查
    let rebound = false; // 多账号场景下是否已执行过“重绑定到已有账号”
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      let state = null;
      try {
        const data = await panelRequest(panelUrl, 'GET', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token });
        state = data?.data;
      } catch (error) {
        // 会话已完成时服务端可能已清理，视为成功结束
        if (captured) break;
        // 会话已过期被清理，不会再有结果，提前结束避免傻等
        if (String(error.message || '').includes('不存在或已过期')) {
          console.log('[×] 服务器上的抓包会话已过期（未抓到 Code）。请重新运行本脚本，并在提示出现后立刻打开 QQ 农场');
          break;
        }
        console.log(`[!] 状态查询失败: ${error.message}（继续等待）`);
        continue;
      }
      if (!state) break;

      // 推断目标的踢下线确认：用户登录 QQ 的瞬间会把对应 bot 踢下线，
      // 这个信号比 gid 更早到达：被踢的正是目标 → 确认；是别的账号 → 立即纠正
      if (!captured && !rebound && heuristicTarget && updateTarget) {
        const kick = await findNewestKickEvent(panelUrl, token);
        if (kick && kick.ageMs < baselineKickAgeMs - 5000) {
          const kickedAccount = existingQqAccounts.find(a => String(a.id) === kick.accountId) || null;
          if (kickedAccount && String(kickedAccount.id) !== String(updateTarget.id)) {
            try {
              await rebindSession(kickedAccount, `登录 QQ 时实际踢掉的是 ${kickedAccount.name || kickedAccount.id}，已切换更新目标`);
              updateTarget = kickedAccount;
              heuristicTarget = false;
              continue;
            } catch (error) {
              console.log(`[!] 切换失败: ${error.message}`);
            }
          } else if (kickedAccount) {
            console.log(`[i] 已确认: 本次登录踢掉的是 ${kickedAccount.name || kickedAccount.id}，更新目标无误`);
            heuristicTarget = false; // 已确认，后续交给 gid 校验
          }
        }
      }

      // 更新模式下的安全校验：抓到的 gid 与目标账号不一致 → 说明登录的是另一个 QQ
      if (!captured && !rebound && updateTarget && state.accountGid
        && updateTarget.gid && String(updateTarget.gid) !== String(state.accountGid)) {
        // 推断/选择的目标猜错了：切换到 gid 实际对应的账号（需重开一次农场）
        if (heuristicTarget) {
          const matched = existingQqAccounts.find(a => String(a?.gid || '') === String(state.accountGid)) || null;
          try {
            await rebindSession(matched, matched
              ? `登录的 QQ（gid ${state.accountGid}）不是推断目标，已切换为更新 ${matched.name || matched.id}`
              : `登录的 QQ（gid ${state.accountGid}）不在账号列表中，已切换为新增模式`);
            updateTarget = matched;
            heuristicTarget = false;
            continue;
          } catch (error) {
            console.log(`[!] 切换失败: ${error.message}`);
          }
        }
        console.log(`[×] 本次登录的 QQ（gid ${state.accountGid}）与目标更新账号（gid ${updateTarget.gid}）不一致。`);
        console.log('    已取消本次抓取，未修改任何账号。如需添加这个新 QQ，请先在面板中处理已有账号。');
        await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
        aborted = true;
        process.exitCode = 1;
        break;
      }

      if (state.codeCaptured) {
        // gid 可能比 code 晚一步到达：需要用 gid 做校验/匹配时先短暂等待
        let gid = state.accountGid || '';
        const needGid = (updateTarget && updateTarget.gid) || (!updateTarget && !rebound);
        if (!gid && needGid) {
          const gidWaitUntil = Date.now() + 8000;
          while (Date.now() < gidWaitUntil && !gid) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
              const poll = await panelRequest(panelUrl, 'GET', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token });
              gid = poll?.data?.accountGid || '';
            } catch { break; }
          }
        }

        // 非更新模式：抓到的 gid 命中已有账号，或该账号刚被顶下线 → 需要更新它而不是新增。
        // 但已抓到的 Code 无法迁移到另一个会话，只能重建绑定会话并重新打开一次农场
        if (!updateTarget && !rebound) {
          let matched = gid
            ? existingQqAccounts.find(a => String(a?.gid || '') === String(gid))
            : null;
          // gid 没提取到时的兜底：用踢下线记录定位刚被顶掉的账号
          if (!matched && !gid && existingQqAccounts.length > 1) {
            matched = await detectRecentlyKickedAccount(panelUrl, token, existingQqAccounts);
            if (matched) console.log(`[i] gid 未提取到，通过踢下线记录定位到账号: ${matched.name || matched.id}`);
          }
          if (!matched) console.log(`[i] 本次登录 gid: ${gid || '未提取到'}，未匹配到已有账号，按新增处理`);
          if (matched) {
            try {
              await rebindSession(matched, `检测到登录的是已有账号（${matched.name || matched.id}），切换为更新模式以保留原设置...`);
              continue;
            } catch (error) {
              console.log(`[!] 切换更新模式失败（${error.message}），继续按新增处理`);
            }
          }
        }

        // gid 与目标一致 → 目标确认，无需再人工确认
        if (updateTarget && gid && String(updateTarget.gid || '') === String(gid)) {
          heuristicTarget = false;
        }

        // 更新模式下 complete 前的最后校验（gid 可能晚于 code 到达，此处兜住推断目标的错判）
        if (updateTarget && updateTarget.gid && gid && String(updateTarget.gid) !== String(gid)) {
          if (heuristicTarget && !rebound) {
            const matched = existingQqAccounts.find(a => String(a?.gid || '') === String(gid)) || null;
            try {
              await rebindSession(matched, matched
                ? `登录的 QQ（gid ${gid}）不是推断目标，已切换为更新 ${matched.name || matched.id}`
                : `登录的 QQ（gid ${gid}）不在账号列表中，已切换为新增模式`);
              updateTarget = matched;
              heuristicTarget = false;
              continue;
            } catch (error) {
              console.log(`[!] 切换失败: ${error.message}`);
            }
          }
          console.log(`[×] 本次登录的 QQ（gid ${gid}）与目标更新账号（gid ${updateTarget.gid}）不一致，已取消，未修改任何账号`);
          await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
          aborted = true;
          process.exitCode = 1;
          break;
        }

        // 最终闸门：推断目标且零确认信号（本次登录既没踢掉任何 bot，gid 也没对上/没提取到）。
        // 默认自动确认（写入日志说明依据）；--ask-confirm 可恢复人工确认模式。
        // 自动模式下仍有兜底：登录信号不符时上游会自动 rebind 纠正目标，此处是最后一步。
        if (heuristicTarget && !userPicked) {
          if (args.autoConfirm) {
            console.log(`[i] 零确认信号（gid 未提取到且无踢下线记录），自动确认更新到推断目标 ${updateTarget.name || updateTarget.id}`);
            console.log('    （如需人工确认，运行时加 --ask-confirm）');
            heuristicTarget = false;
          } else {
            const rlConfirm = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
            console.log('[!] 无法自动确认本次登录的 QQ（gid 未提取到，也没有踢下线信号）');
            console.log(`    当前绑定目标: ${updateTarget.name || updateTarget.id}。如果这不是你登录的 QQ，千万不要确认！`);
            const answer = await ask(rlConfirm, '输入 y 确认更新到该账号，直接回车取消本次抓取: ');
            rlConfirm.close();
            if (!/^y(es)?$/i.test(String(answer || '').trim())) {
              console.log('[×] 已取消，未修改任何账号。请重新运行脚本，并在开始时选择正确的账号');
              await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
              aborted = true;
              process.exitCode = 1;
              break;
            }
            heuristicTarget = false;
          }
        }

        captured = true;
        console.log(`[√] Code 已抓取（本次登录 gid: ${gid || '未提取到'}），正在处理账号...`);

        // 调用 complete：更新模式（会话绑定了 accountId）→ 更新旧账号；否则新增
        try {
          const done = await panelRequest(panelUrl, 'POST', `/api/capture/sessions/${encodeURIComponent(flow.id)}/complete`, { token, body: {} });
          const result = done?.data || {};
          console.log(`[√] 账号${result.updated ? '更新' : '添加'}成功: ${result.name || result.accountId || ''}（好友 GID 服务器后台同步中）`);
          if (result.startError) console.log(`[!] 账号延迟启动失败: ${result.startError}`);
        } catch (error) {
          // 兜底：服务端报“重复账号”说明这个 QQ 已在列表里 → 重建绑定会话改为更新
          if (!rebound && String(error.message || '').includes('已添加的账号')) {
            await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
            let matched = gid ? existingQqAccounts.find(a => String(a?.gid || '') === String(gid)) : null;
            if (!matched) matched = await detectRecentlyKickedAccount(panelUrl, token, existingQqAccounts);
            if (matched) {
              try {
                const recreated = await panelRequest(panelUrl, 'POST', '/api/capture/sessions', {
                  token,
                  body: { platform: args.platform, accountId: matched.id },
                });
                if (!recreated?.data?.id) throw new Error('重建会话失败');
                flow = recreated.data;
                rebound = true;
                captured = false;
                const newPort = Number(flow.publicInfo?.mitmPort) || 0;
                const newHost = String(flow.publicInfo?.host || panelHost);
                if (newPort) enableSystemProxy(newHost, newPort);
                deadline = Date.now() + args.timeoutSec * 1000;
                console.log(`[i] 该 QQ 已在账号列表中（${matched.name || matched.id}），已切换为更新模式`);
                console.log('==============================================');
                console.log('  代理已更新，请重新打开一次 QQ 农场');
                console.log(`  之后将更新已有账号 ${matched.name || matched.id}（原设置保留）`);
                console.log('==============================================');
                continue;
              } catch (rebindError) {
                console.log(`[!] 切换更新模式失败: ${rebindError.message}`);
              }
            } else {
              console.log('[!] 无法定位对应的已有账号，本次抓取已取消');
            }
            process.exitCode = 1;
            break;
          }
          console.error(`[×] 账号处理失败: ${error.message}`);
          process.exitCode = 1;
        }
        break;
      }
      if (state.proxy && state.proxy.error) {
        console.log(`[!] 代理异常: ${state.proxy.error}`);
      }
    }

    if (!captured && !aborted) {
      console.log('[×] 超时未抓到 Code。常见原因:');
      console.log('    - 未安装服务器 CA 证书 → 运行: node remote-capture.js --cert-only --panel ' + panelUrl);
      console.log('    - QQ 没有重启（装证书后需彻底退出 QQ 再打开）');
      console.log('    - 服务器 NSG 未放行代理端口');
      // 清理服务器会话
      await panelRequest(panelUrl, 'DELETE', `/api/capture/sessions/${encodeURIComponent(flow.id)}`, { token }).catch(() => {});
      process.exitCode = 1;
      // 超时失败同样关闭农场小程序（用户要求：结束后不留小程序窗口）
      if (args.closeFarm) {
        console.log('[i] 超时结束，自动关闭 QQ 农场小程序...');
        closeFarmWindow();
      }
    } else {
      console.log('[√] 完成！服务器端账号已处理。');
      // 补完码后自动关闭 QQ 农场小程序窗口（安全：仅 WM_CLOSE 标题含"农场"的 QQ 窗口）
      if (args.closeFarm) closeFarmWindow();
    }
  } catch (error) {
    console.error(`[×] ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    guard();
  }
}

// ---------------------------------------------------------------------------
// 抓码互斥锁：任何方式（手动 bat / 守护进程）启动本脚本都会写 _capture.lock，
// 防止两个实例并发（抢代理、顶掉对方的服务器会话、关掉对方的农场窗口）。
// ---------------------------------------------------------------------------

const LOCK_FILE = path.join(__dirname, '_capture.lock');
const LOCK_STALE_SEC = 15 * 60; // 抓码最长 180s + 缓冲；超龄锁一律视为陈旧（防 Windows pid 复用误判）

function captureLockAlive(pid, ts) {
  if (ts && (Date.now() / 1000 - ts) > LOCK_STALE_SEC) return false; // 陈旧锁
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权发信号 = 活着
  }
}

function acquireCaptureLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const parts = fs.readFileSync(LOCK_FILE, 'utf8').trim().split(/\s+/);
      const oldPid = Number.parseInt(parts[0], 10);
      const oldTs = Number.parseFloat(parts[1]) || 0;
      if (Number.isInteger(oldPid) && oldPid !== process.pid && captureLockAlive(oldPid, oldTs)) {
        console.log(`[×] 已有抓码进程在运行 (pid=${oldPid})，本次直接退出以避免冲突`);
        process.exitCode = 1;
        return false;
      }
      // 陈旧锁（进程已死或超龄）→ 清掉重写
    }
    fs.writeFileSync(LOCK_FILE, `${process.pid} ${Date.now() / 1000}`);
    return true;
  } catch (e) {
    console.log(`[!] 写入抓码锁失败（忽略互斥）: ${e.message}`);
    return true; // 锁失败不应阻断抓码主流程
  }
}

function releaseCaptureLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) { /* 忽略 */ }
}

if (require.main === module) {
  if (acquireCaptureLock()) {
    process.on('exit', releaseCaptureLock);
    process.on('SIGINT', () => { releaseCaptureLock(); process.exit(130); });
    main();
  }
}

module.exports = {
  readCurrentProxy,
  enableSystemProxy,
  restoreSystemProxy,
  parseArgs,
  detectRecentlyKickedAccount,
  findNewestKickEvent,
};
