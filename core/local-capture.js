#!/usr/bin/env node
/**
 * 本地 MITM 抓包小工具（复用 bot 的 capture 核心）
 *
 * 用途：在 Windows 本机启动选择性 MITM 代理，捕获 PC QQ 小游戏（农场）的
 * WebSocket 游戏消息，解码 gatepb.Message 后把每条消息（service/method/
 * msgType/bodyHex）追加到本地归档文件，用于离线逆向游戏公告等未知协议。
 *
 * 用法：
 *   node core/local-capture.js           启动抓包代理（持续运行，Ctrl+C 停止）
 *   node core/local-capture.js check      冒烟测试：导出 CA、打印配置后退出
 *   node core/local-capture.js summarize  打印去重后的 service.method 列表
 *   node core/local-capture.js dump <svc> 导出某 service（或 '*' 全部）的消息到文件
 *
 * 环境变量（可选）：
 *   CAPTURE_HOSTS       需中间人解密的域名，逗号分隔，如 "*.qq.com,*.myqcloud.com"
 *   CAPTURE_AUTOSTOP_SEC 代理自动停止秒数（默认 3600）
 */

const path = require('path');
const fs = require('fs');

const dataDir = path.resolve(__dirname, '.local-capture-data');
fs.mkdirSync(dataDir, { recursive: true });

if (!process.env.CAPTURE_ARCHIVE_PATH) {
  process.env.CAPTURE_ARCHIVE_PATH = path.join(dataDir, 'capture-archive.jsonl');
}
if (!process.env.CAPTURE_AUTOSTOP_SEC) {
  process.env.CAPTURE_AUTOSTOP_SEC = '3600';
}
const ARCHIVE = process.env.CAPTURE_ARCHIVE_PATH;

// 必须在 require capture 之前设置路径（session-store 在加载时读取）
const { createCaptureCore } = require('./src/capture');

function log(lvl, msg, extra) {
  console.log(`[${lvl}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

function readArchiveLines() {
  if (!fs.existsSync(ARCHIVE)) return [];
  return fs.readFileSync(ARCHIVE, 'utf8').trim().split('\n').filter(Boolean);
}

async function start() {
  const core = createCaptureCore({ dataDir, log });
  await core.ready;

  const caDer = core.getCaCertDer();
  const caPath = path.join(dataDir, 'mitmproxy-ca-cert.cer');
  fs.writeFileSync(caPath, caDer);
  log('info', `CA 证书已导出: ${caPath}`);
  log('info', `抓取域名(captureHosts): ${core.config.captureHosts.join(', ')}`);
  log('info', `代理端口池: ${core.config.proxyPortFrom}-${core.config.proxyPortTo}`);

  const sid = 'local';
  core.sessionStore.createSession(sid, 'qq');
  await core.handleApiRequest('POST', '/api/capture/start', {
    mode: 'qq', deviceMode: 'pc', bypassHosts: [], advertiseHost: '',
  }, { sessionId: sid });
  const sess = core.sessionStore.getSession(sid);
  const port = (sess && sess.publicInfo && sess.publicInfo.mitmPort)
    || (sess && sess.proxy && sess.proxy.port);
  log('info', `抓包代理已启动 端口=${port}`);

  console.log('\n========================================================');
  console.log('① 安装 CA 证书（管理员）：');
  console.log(`   双击 ${caPath}`);
  console.log('   → 安装证书 → 本地计算机 → 受信任的根证书颁发机构');
  console.log('② Windows 系统代理：');
  console.log(`   设置 → 网络 → 代理 → 手动代理 → 地址 127.0.0.1  端口 ${port}`);
  console.log('③ 打开 PC QQ → 小游戏 → 农场，登录，点开「公告」侧栏多停留');
  console.log(`④ 归档文件：${ARCHIVE}`);
  console.log('⑤ 抓完：node core/local-capture.js summarize  查看 service 列表');
  console.log('   Ctrl+C 停止代理（停止后系统代理记得关回「自动检测」）');
  console.log('========================================================\n');

  let lastSize = -1;
  const ticker = setInterval(() => {
    try {
      if (!fs.existsSync(ARCHIVE)) return;
      const size = fs.statSync(ARCHIVE).size;
      if (size === lastSize) return;
      lastSize = size;
      const lines = readArchiveLines();
      const set = new Set();
      for (const l of lines) {
        try {
          const m = JSON.parse(l);
          if (m.service) set.add(`${m.service}.${m.method}`);
        } catch { /* ignore */ }
      }
      process.stdout.write(`\r[live] 消息数=${lines.length}  去重 service=${set.size}  `);
    } catch { /* ignore */ }
  }, 2000);
  if (ticker.unref) ticker.unref();

  const stop = async () => {
    clearInterval(ticker);
    try { await core.handleApiRequest('POST', '/api/capture/stop', {}, { sessionId: sid }); } catch { /* ignore */ }
    try { await core.stop(); } catch { /* ignore */ }
    log('info', '已停止');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function check() {
  const core = createCaptureCore({ dataDir, log });
  await core.ready;
  const caDer = core.getCaCertDer();
  const caPath = path.join(dataDir, 'mitmproxy-ca-cert.cer');
  fs.writeFileSync(caPath, caDer);
  console.log('CA 证书:', caPath);
  console.log('captureHosts:', core.config.captureHosts.join(', '));
  console.log('proxyPortFrom-To:', core.config.proxyPortFrom, '-', core.config.proxyPortTo);
  console.log('proto 加载完成，capture 核心可用。');
  await core.stop();
  process.exit(0);
}

function summarize() {
  const lines = readArchiveLines();
  if (lines.length === 0) { console.log('无归档消息（尚未抓包或文件为空）'); return; }
  const map = new Map();
  for (const l of lines) {
    try {
      const m = JSON.parse(l);
      const key = `${m.service}.${m.method}  (msgType=${m.msgType}, bodyLen=${m.bodyLen})`;
      map.set(key, (map.get(key) || 0) + 1);
    } catch { /* ignore */ }
  }
  console.log(`共 ${lines.length} 条消息，去重 service.method（按次数降序）：`);
  for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}\t${k}`);
  }
}

function dump(service) {
  const lines = readArchiveLines();
  if (lines.length === 0) { console.log('无归档消息'); return; }
  const out = [];
  for (const l of lines) {
    try {
      const m = JSON.parse(l);
      if (service === '*' || m.service === service || `${m.service}.${m.method}` === service) out.push(m);
    } catch { /* ignore */ }
  }
  const safe = String(service || 'all').replace(/[^a-z0-9*]/gi, '_');
  const file = path.join(dataDir, `dump-${safe}.jsonl`);
  fs.writeFileSync(file, out.map(o => JSON.stringify(o)).join('\n'));
  console.log(`已导出 ${out.length} 条到 ${file}`);
}

const cmd = process.argv[2];
if (cmd === 'check') check().catch(e => { console.error(e); process.exit(1); });
else if (cmd === 'summarize') summarize();
else if (cmd === 'dump') dump(process.argv[3] || '*');
else start().catch(e => { console.error(e); process.exit(1); });
