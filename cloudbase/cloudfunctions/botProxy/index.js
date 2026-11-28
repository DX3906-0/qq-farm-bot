// botProxy: Azure 农场 bot 面板 API 的国内中继
// 浏览器直连 Azure API 会被 CORS 拦截，由本函数代理转发：
// - 校验共享密钥 x-bot-token，防止被第三方滥用
// - 服务端负责面板登录并注入 x-admin-token，前端不保存服务器凭据

let cachedToken = ''; // 实例级缓存，冷启动后重新登录

async function panelLogin() {
  const resp = await fetch(`${process.env.PANEL_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      username: process.env.PANEL_USER,
      password: process.env.PANEL_PASS,
    }),
  });
  const data = await resp.json().catch(() => null);
  const token = data?.data?.token || '';
  if (!resp.ok || !token) throw new Error(data?.error || `login failed (HTTP ${resp.status})`);
  return token;
}

async function getAdminToken(force = false) {
  if (!cachedToken || force) cachedToken = await panelLogin();
  return cachedToken;
}

async function fetchPanel(path, qs, method, headers, body) {
  const token = await getAdminToken();
  const url = `${process.env.PANEL_URL}${path}${qs ? `?${qs}` : ''}`;
  let resp = await fetch(url, {
    method,
    headers: { ...headers, 'x-admin-token': token, Accept: 'application/json' },
    body: ['GET', 'HEAD'].includes(method) ? undefined : body || '',
  });
  if (resp.status === 401 && !path.startsWith('/api/login')) {
    // token 过期：重新登录重试一次
    await getAdminToken(true);
    resp = await fetch(url, {
      method,
      headers: { ...headers, 'x-admin-token': cachedToken, Accept: 'application/json' },
      body: ['GET', 'HEAD'].includes(method) ? undefined : body || '',
    });
  }
  return resp;
}

exports.main = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-bot-token',
    'Access-Control-Max-Age': '86400',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  const json = (status, obj) => ({
    statusCode: status,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  try {
    const headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
      headers[k.toLowerCase()] = v;
    }
    if (!process.env.BOT_TOKEN || headers['x-bot-token'] !== process.env.BOT_TOKEN) {
      return json(401, { error: 'invalid token' });
    }
    const panel = process.env.PANEL_URL;
    if (!panel || !process.env.PANEL_USER || !process.env.PANEL_PASS) {
      return json(500, { error: 'proxy not configured' });
    }
    const path = event.path || '/';
    const qs = event.queryStringParameters
      ? new URLSearchParams(event.queryStringParameters).toString()
      : '';
    let body = event.body || undefined;
    if (event.isBase64Encoded && body) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    const reqHeaders = {};
    if (headers['content-type']) reqHeaders['Content-Type'] = headers['content-type'];
    const resp = await fetchPanel(path, qs, event.httpMethod, reqHeaders, body);
    const respHeaders = { ...cors };
    const ct = resp.headers.get('content-type');
    if (ct) respHeaders['Content-Type'] = ct;
    return { statusCode: resp.status, headers: respHeaders, body: await resp.text() };
  } catch (e) {
    return json(502, { error: 'proxy failed', msg: e.message });
  }
};
