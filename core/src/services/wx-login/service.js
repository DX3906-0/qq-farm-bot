"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WxLoginService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const { getNativeWxLoginCode, hasNativeSession } = require("./native-protocol");
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
const QR_CONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";
const QR_IMAGE_BASE = "https://open.weixin.qq.com/connect/qrcode/";
const QR_POLL_URL = "https://long.open.weixin.qq.com/connect/l/qrconnect";
const CALLBACK_URL = "https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_oauth";
const LOGIN_BUFFER_URL = "https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth";
const REFRESH_TOKEN_URL = "https://yybadaccess.3g.qq.com/pc_yyb_auth/pcyyb_refresh_token_auth";
const MAIN_REFRESH_TOKEN_URL = "https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_refresh_token";
const USER_INFO_URL = "https://yybadaccess.3g.qq.com/pc_yyb/pcyyb_get_user_info";
const OAUTH_APP_ID = "wxd44977328b36e647";
const OAUTH_SCOPE = "snsapi_login,snsapi_runtime_pcsdk";
const USER_AGENT = "Mozilla/5.0";
const LOGIN_BUFFER_ACCESS_KEY = "wgrdg373hy26ww2";
const cookieMetadata = new WeakMap();
function cookieHeader(cookies, host) {
    const metadata = cookieMetadata.get(cookies);
    return [...cookies].filter(([name, value]) => {
        const entry = metadata?.get(name);
        return entry?.host === host && entry.value === value && (entry.expiresAt === null || entry.expiresAt > Date.now());
    }).map(([name, value]) => `${name}=${value}`).join("; ");
}
function storeCookies(cookies, headers, host) {
    const headerValue = headers.get("set-cookie");
    const values = typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headerValue ? headerValue.split(/,(?=\s*[^;,=\s]+\s*=)/) : [];
    const metadata = cookieMetadata.get(cookies);
    for (const value of values) {
        const parts = value.split(";");
        const pair = parts.shift().trim();
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator);
        const token = pair.slice(separator + 1);
        const maxAge = parts.find((part) => /^\s*max-age=/i.test(part));
        const expires = parts.find((part) => /^\s*expires=/i.test(part));
        let expiresAt = null;
        if (maxAge) {
            const seconds = serverInteger(maxAge.slice(maxAge.indexOf("=") + 1).trim());
            const at = Date.now() + seconds * 1000;
            if (seconds !== undefined && Number.isSafeInteger(at) && Math.abs(at) <= 8640000000000000) expiresAt = at;
        }
        else if (expires) {
            const at = Date.parse(expires.slice(expires.indexOf("=") + 1).trim());
            if (Number.isFinite(at)) expiresAt = at;
        }
        cookies.set(name, token);
        metadata.set(name, { host, value: token, expiresAt, expirySource: maxAge ? "cookie_max_age" : expires ? "cookie_expires" : "session_cookie" });
        if (expiresAt !== null && expiresAt <= Date.now()) cookies.delete(name);
    }
}
async function request(url, cookies, init = {}, timeout = 35e3) {
    // cookies 可能为 undefined：微信 refreshLoginBuffer 续期路径（gateway 的 issueWxCodeFromBuffer）
    // 构造的 session 只含 loginBuffer/refreshtoken/accesstoken，不再带 cookie Map。
    // 必须兜底成空 Map，否则 cookies.size / cookies.set 会抛
    // "Cannot read properties of undefined (reading 'size')"，让整个续期路径崩溃、微信无法保活掉线。
    const cookieStore = (cookies && typeof cookies.size === "number") ? cookies : new Map();
    if (!cookieMetadata.has(cookieStore)) cookieMetadata.set(cookieStore, new Map());
    const sourceHost = new URL(url).host;
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal.reason);
    if (init.signal) {
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error(`WeChat request timeout ${timeout}ms`)), timeout);
    try {
        let currentUrl = url;
        let method = init.method || "GET";
        let body = init.body;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const headers = new Headers(init.headers);
            headers.set("User-Agent", USER_AGENT);
            const currentHost = new URL(currentUrl).host;
            if (currentHost !== sourceHost) {
                if (body !== undefined) throw new Error("WeChat credential request redirected to another host");
                headers.delete("Cookie");
                for (const name of [...headers.keys()]) {
                    if (name.toLowerCase().startsWith("ual-access-")) headers.delete(name);
                }
            }
            if (!headers.has("Cookie")) {
                const stored = cookieHeader(cookieStore, currentHost);
                if (stored) headers.set("Cookie", stored);
            }
            if (controller.signal.aborted)
                throw controller.signal.reason;
            const response = await fetch(currentUrl, { ...init, method, body, headers, redirect: "manual", signal: controller.signal });
            if (!controller.signal.aborted)
                storeCookies(cookieStore, response.headers, currentHost);
            const location = response.headers.get("location");
            if (response.status < 300 || response.status >= 400 || !location) {
                return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
            }
            currentUrl = new URL(location, currentUrl).toString();
            if (response.status === 303 || (response.status === 301 || response.status === 302) && method === "POST") {
                method = "GET";
                body = void 0;
            }
        }
        throw new Error("Too many redirects while contacting WeChat");
    }
    finally {
        clearTimeout(timer);
        if (init.signal) init.signal.removeEventListener("abort", abort);
    }
}
function requiredCookie(cookies, name) {
    const value = cookies.get(name);
    const metadata = cookieMetadata.get(cookies)?.get(name);
    if (!value || metadata?.host !== new URL(CALLBACK_URL).host || metadata.value !== value
        || (metadata.expiresAt !== null && metadata.expiresAt <= Date.now()))
        throw new Error(`WeChat OAuth callback did not provide ${name}`);
    return value;
}
function pickLoginBuffer(data) {
    const source = asRecord(data);
    const snake = asRecord(asRecord(asRecord(source.ext_info).list_s).login_buffer).value;
    const camel = asRecord(asRecord(asRecord(source.extInfo).listS).loginBuffer).value;
    const value = (Array.isArray(snake) ? snake[0] : undefined)
        || (Array.isArray(camel) ? camel[0] : undefined)
        || "";
    return typeof value === "string" ? value : "";
}
function attachRotatedCredentials(error, refreshToken, accessToken, metadata = {}) {
    const credentialError = (error instanceof Error ? error : new Error(String(error)));
    Object.assign(credentialError, metadata, { refreshtoken: refreshToken, accesstoken: accessToken });
    return credentialError;
}
function serverInteger(value) {
    if (typeof value !== "number" && !(typeof value === "string" && /^(?:0|-?[1-9]\d*)$/.test(value))) return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
}
function credentialSource(session) {
    const marker = session.refreshBusinessId !== undefined ? session.refreshBusinessId : session.refresh_business_id;
    if (marker === undefined) return { refreshBusinessId: "pc_yyb", credentialSource: "legacy_pc_yyb", url: MAIN_REFRESH_TOKEN_URL, key: "" };
    if (marker === "pc_yyb") return { refreshBusinessId: marker, credentialSource: session.credentialSource === "legacy_pc_yyb" ? "legacy_pc_yyb" : "pc_yyb", url: MAIN_REFRESH_TOKEN_URL, key: "" };
    if (marker === "pc_yyb_auth") return { refreshBusinessId: marker, credentialSource: "pc_yyb_auth", url: REFRESH_TOKEN_URL, key: LOGIN_BUFFER_ACCESS_KEY };
    throw responseFailure("token_refresh", undefined, undefined, "credential_source_invalid");
}
function responseFailure(stage, business, code, type = "response_invalid", wechatCode) {
    const error = new Error(`WeChat ${stage} failed: ${type}${code === undefined ? "" : ` code=${code}`}${wechatCode === undefined ? "" : ` wechatCode=${wechatCode}`}`);
    Object.assign(error, { stage, business, type, code: code === undefined || code === 0 ? type : code });
    if (code !== undefined) error.serverCode = code;
    if (wechatCode !== undefined) error.wechatCode = wechatCode;
    return error;
}
function redactCredentials(message, session, data = {}) {
    const secrets = [session?.openid, session?.open_id, session?.accesstoken, session?.refreshtoken, session?.loginBuffer, pickLoginBuffer(data)];
    for (const record of [data, asRecord(data.user_info), asRecord(data.userInfo)]) {
        for (const key of ["openid", "open_id", "openId", "accesstoken", "access_token", "accessToken", "refreshtoken", "refresh_token", "refreshToken", "loginBuffer", "login_buffer"])
            secrets.push(record[key]);
    }
    for (const secret of secrets.filter((value) => typeof value === "string" && value).sort((a, b) => b.length - a.length)) {
        message = message.split(secret).join("[redacted]");
        message = message.split(encodeURIComponent(secret)).join("[redacted]");
    }
    return message;
}
function sanitizeFailure(error, session, credentials) {
    if (typeof error.message === "string") error.message = redactCredentials(error.message, session, credentials);
    if (typeof error.stack === "string") error.stack = redactCredentials(error.stack, session, credentials);
    delete error.cause;
    return error;
}
function wechatErrorCode(data, session) {
    if (typeof data.msg !== "string") return undefined;
    const message = redactCredentials(data.msg, session, data);
    // 不保留服务端原文；只提取独立的微信五位整数错误码。
    const match = /(?:^|[^A-Za-z0-9_.+-])([1-9]\d{4})(?=$|[^A-Za-z0-9_.+-])/.exec(message);
    return match ? serverInteger(match[1]) : undefined;
}
function responseData(response, stage, business, session) {
    let data;
    try { data = asRecord(JSON.parse(response.body.toString("utf8"))); }
    catch { data = undefined; }
    if (response.status < 200 || response.status >= 300) {
        const error = responseFailure(stage, business, serverInteger(data?.code), "http_error", data && session ? wechatErrorCode(data, session) : undefined);
        error.httpStatus = response.status;
        throw error;
    }
    if (!data) throw responseFailure(stage, business);
    return data;
}
function accessTokenExpiry(info, data, cookies, accessToken, requestedAt) {
    const metadata = {
        accessTokenExpiresAt: null, accessTokenExpirySource: "unknown",
        accessTokenCookieExpiresAt: null, accessTokenCookieExpirySource: "unknown"
    };
    if (!accessToken) return metadata;
    // Cookie 的保存期与 token 的授权期是两种契约，不可用 Max-Age/Expires 冒充 expires_in。
    // 仅记录同 host、同 token 的 Cookie 元数据，不记录 Cookie/token 原文。
    const cookie = cookies && cookieMetadata.get(cookies)?.get("accesstoken");
    if (cookie?.host === new URL(CALLBACK_URL).host && cookie.value === accessToken
        && Number.isSafeInteger(cookie.expiresAt) && cookie.expiresAt > Date.now()) {
        metadata.accessTokenCookieExpiresAt = cookie.expiresAt;
        metadata.accessTokenCookieExpirySource = cookie.expirySource || "cookie_unverified";
    }
    for (const [source, value] of [
        ["server_user_info_expiresIn", info.expiresIn], ["server_user_info_expires_in", info.expires_in],
        ["server_response_expiresIn", data.expiresIn], ["server_response_expires_in", data.expires_in]
    ]) {
        if (value === undefined || value === null) continue;
        const seconds = serverInteger(value);
        const expiresAt = requestedAt + seconds * 1000;
        if (seconds > 0 && Number.isSafeInteger(expiresAt) && expiresAt <= 8640000000000000 && expiresAt > Date.now()) {
            metadata.accessTokenExpiresAt = expiresAt;
            metadata.accessTokenExpirySource = source;
        }
        break;
    }
    return metadata;
}
function validateIdentity(data, session, business, code) {
    const loginType = (value) => value === "WX" || value === "2" || value === 2 ? "WX" : undefined;
    const expectedType = loginType(session.loginType ?? session.login_type ?? "WX");
    for (const record of [data, asRecord(data.user_info), asRecord(data.userInfo)]) {
        for (const key of ["openid", "open_id", "openId"]) {
            if (Object.prototype.hasOwnProperty.call(record, key)
                && (typeof record[key] !== "string" || (record[key] !== "" && record[key] !== session.openid)))
                throw responseFailure("token_refresh", business, code, "response_invalid");
        }
        for (const key of ["loginType", "login_type"]) {
            if (Object.prototype.hasOwnProperty.call(record, key) && (!expectedType || loginType(record[key]) !== expectedType))
                throw responseFailure("token_refresh", business, code, "response_invalid");
        }
    }
}
const sharedRefreshOperation = Symbol("sharedRefreshOperation");
const refreshOperations = new WeakMap();
function refreshOperation(session, options, defaultTimeout) {
    const controller = new AbortController();
    const deadline = Math.min(options.deadline == null ? Infinity : Number(options.deadline), Date.now() + (options.timeoutMs ?? defaultTimeout));
    if (!Number.isFinite(deadline))
        throw new Error("刷新 loginBuffer期限无效");
    const operations = refreshOperations.get(session) || new Set();
    refreshOperations.set(session, operations);
    operations.add(controller);
    const abort = () => controller.abort(options.signal.reason);
    if (options.signal) {
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error("刷新 loginBuffer超时")), Math.max(0, deadline - Date.now()));
    return {
        controller, deadline,
        active: () => operations.has(controller),
        remaining() {
            if (controller.signal.aborted) throw controller.signal.reason || new Error("刷新 loginBuffer已取消");
            const ms = deadline - Date.now();
            if (ms <= 0) {
                controller.abort(new Error("刷新 loginBuffer超时"));
                throw controller.signal.reason;
            }
            return Math.min(35e3, ms);
        },
        close() {
            clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener("abort", abort);
            operations.delete(controller);
            if (!operations.size && refreshOperations.get(session) === operations)
                refreshOperations.delete(session);
        }
    };
}
class WxLoginService {
    async createQrSession() {
        const cookies = /* @__PURE__ */ new Map();
        const params = new URLSearchParams({
            appid: OAUTH_APP_ID,
            redirect_uri: `${CALLBACK_URL}?login_type=WX`,
            response_type: "code",
            scope: OAUTH_SCOPE,
            state: "web",
            fast_login: "1",
            self_redirect: "true"
        });
        const page = await request(`${QR_CONNECT_URL}?${params}`, cookies);
        if (page.status < 200 || page.status >= 300)
            throw new Error(`Unable to create WeChat QR session (HTTP ${page.status})`);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString("utf8"))?.[1];
        if (!uuid)
            throw new Error("Unable to parse the WeChat QR session");
        const qr = await request(`${QR_IMAGE_BASE}${encodeURIComponent(uuid)}`, cookies);
        if (qr.status < 200 || qr.status >= 300)
            throw new Error(`Unable to download WeChat QR image (HTTP ${qr.status})`);
        return { session: { cookies, uuid }, qr: qr.body };
    }
    async poll(session, options = {}) {
        if (session.oauthCode)
            return "authorized";
        const params = new URLSearchParams({ uuid: String(session.uuid || ""), _: String(Date.now()) });
        const remaining = Math.min(35e3, Number(options.deadline || Infinity) - Date.now());
        if (remaining <= 0 || options.signal?.aborted) throw options.signal?.reason || new Error("微信扫码轮询已超时");
        const response = await request(`${QR_POLL_URL}?${params}`, session.cookies, { signal: options.signal }, remaining);
        if (response.status < 200 || response.status >= 300)
            throw new Error(`WeChat QR polling failed (HTTP ${response.status})`);
        const body = response.body.toString("utf8");
        const errcode = /wx_errcode\s*=\s*(\d+)/.exec(body)?.[1];
        if (errcode === "408")
            return "waiting";
        if (errcode === "404")
            return "scanned";
        if (errcode === "403")
            return "cancelled";
        if (errcode === "402")
            return "expired";
        if (errcode === "405") {
            const code = /wx_code\s*=\s*'([^']+)'/.exec(body)?.[1];
            if (!code)
                throw new Error("WeChat authorization response did not include a code");
            session.oauthCode = code;
            session.scannedAt = Date.now();
            return "authorized";
        }
        throw new Error("Unrecognized WeChat QR polling response");
    }
    async confirm(session, options = {}) {
        if (!session.oauthCode)
            throw new Error("Waiting for scan authorization");
        const deadline = Math.min(Number(options.deadline || Infinity), Date.now() + (options.timeoutMs ?? 70e3));
        const remaining = () => {
            if (options.signal?.aborted) throw options.signal.reason;
            const ms = Math.min(35e3, deadline - Date.now());
            if (ms <= 0) throw new Error("微信扫码确认已超时");
            return ms;
        };
        const params = new URLSearchParams({ login_type: "WX", code: session.oauthCode, state: "web" });
        const callbackRequestedAt = Date.now();
        const callback = await request(`${CALLBACK_URL}?${params}`, session.cookies, { signal: options.signal }, remaining());
        if (callback.status < 200 || callback.status >= 400)
            throw new Error(`WeChat authorization callback failed (HTTP ${callback.status})`);
        const openid = requiredCookie(session.cookies, "openid");
        const accessToken = requiredCookie(session.cookies, "accesstoken");
        // refreshtoken 可选（部分环境不回传）；存在则用于 loginBuffer 保活刷新
        const refreshToken = session.cookies.get("refreshtoken") ? requiredCookie(session.cookies, "refreshtoken") : "";
        session.openid = openid;
        session.accesstoken = accessToken;
        session.refreshtoken = refreshToken;
        Object.assign(session, {
            refreshBusinessId: "pc_yyb", credentialSource: "pc_yyb", loginType: "WX",
            scope: OAUTH_SCOPE, appId: OAUTH_APP_ID, scannedAt: session.scannedAt ?? callbackRequestedAt, tokenCheckedAt: Date.now()
        });
        let callbackData = {};
        try { callbackData = asRecord(JSON.parse(callback.body.toString("utf8"))); } catch {}
        Object.assign(session, accessTokenExpiry(asRecord(callbackData.user_info || callbackData.userInfo), callbackData, session.cookies, accessToken, callbackRequestedAt));
        const payload = JSON.stringify({ extInfo: { listS: { unionid: { value: [openid] }, user_id: { value: [openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
        const timestamp = String(Date.now());
        const nonce = String(node_crypto_1.default.randomInt(1e3, 1e4));
        const signature = node_crypto_1.default.createHash("md5").update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest("hex");
        const response = await request(LOGIN_BUFFER_URL, session.cookies, {
            method: "POST",
            body: payload,
            signal: options.signal,
            headers: { "Content-Type": "application/json", "Ual-Access-Businessid": "pc_yyb_auth", "Ual-Access-Timestamp": timestamp, "Ual-Access-Nonce": nonce, "Ual-Access-Signature": signature }
        }, remaining());
        const data = responseData(response, "login_buffer", "pc_yyb_auth", session);
        const code = serverInteger(data.code);
        const loginBuffer = code === 0 ? pickLoginBuffer(data) : "";
        if (!loginBuffer)
            throw responseFailure("login_buffer", "pc_yyb_auth", code, code === undefined || code === 0 ? "response_invalid" : "server_rejected", wechatErrorCode(data, session));
        session.loginBuffer = loginBuffer;
        return { openid, loginBuffer };
    }
    async fetchUserInfo(session) {
        if (!session || !session.openid || !session.accesstoken)
            throw new Error("登录会话未确认，无法获取用户信息");
        const timestamp = String(Date.now());
        const nonce = String(node_crypto_1.default.randomInt(1e3, 1e4));
        // pcyyb_get_user_info 的签名 key 为空串：md5(ts + "" + nonce)
        const signature = node_crypto_1.default.createHash("md5").update(`${timestamp}${nonce}`).digest("hex");
        const response = await request(USER_INFO_URL, session.cookies, {
            headers: {
                "Ual-Access-Access-Token": session.accesstoken,
                "Ual-Access-Login-Type": "2",
                "Ual-Access-Openid": session.openid,
                "Ual-Access-Businessid": "pc_yyb",
                "Ual-Access-Guid": "web",
                "Ual-Access-Nonce": nonce,
                "Ual-Access-Requestid": String(node_crypto_1.default.randomInt(1e3, 1e4)),
                "Ual-Access-Signature": signature,
                "Ual-Access-Timestamp": timestamp
            }
        });
        if (response.status < 200 || response.status >= 300)
            throw new Error(`Unable to fetch WeChat user info (HTTP ${response.status})`);
        return asRecord(JSON.parse(response.body.toString("utf8")));
    }
    hasNativeSession(record, sessionBinding) {
        return hasNativeSession(record, sessionBinding);
    }
    async issueCode(session, appId, options = {}) {
        const cached = Object.prototype.hasOwnProperty.call(options, "session") ? options.session : session.nativeSession;
        if (!session.loginBuffer && !hasNativeSession(cached, options.sessionBinding))
            throw new Error("WeChat login session has not been confirmed");
        const nativeOptions = !Object.prototype.hasOwnProperty.call(options, "session") && cached
            ? { ...options, session: cached } : options;
        return getNativeWxLoginCode(session.loginBuffer, appId, nativeOptions);
    }
    async refreshBufferWithAccessToken(session, options = {}) {
        let operation;
        let receivedCode;
        try {
            if (!session || !session.openid || !session.accesstoken)
                throw new Error("缺少 openid 或 accesstoken，无法获取 loginBuffer");
            operation = options[sharedRefreshOperation] || refreshOperation(session, options, 35e3);
            operation.remaining();
            const accessToken = session.accesstoken;
            const refreshToken = session.refreshtoken || "";
            const payload = JSON.stringify({ extInfo: { listS: { unionid: { value: [session.openid] }, user_id: { value: [session.openid] }, access_token: { value: [accessToken] } }, listI: { user_type: { value: [0] } } } });
            const timestamp = String(Date.now());
            const nonce = String(node_crypto_1.default.randomInt(1e3, 1e4));
            const signature = node_crypto_1.default.createHash("md5").update(`${payload}${timestamp}${LOGIN_BUFFER_ACCESS_KEY}${nonce}`).digest("hex");
            const response = await request(LOGIN_BUFFER_URL, session.cookies, {
                method: "POST", body: payload, signal: operation.controller.signal,
                headers: { "Content-Type": "application/json", "Ual-Access-Businessid": "pc_yyb_auth", "Ual-Access-Timestamp": timestamp, "Ual-Access-Nonce": nonce, "Ual-Access-Signature": signature, "Cookie": `openid=${session.openid}; accesstoken=${accessToken}; refreshtoken=${refreshToken}` }
            }, operation.remaining());
            const data = responseData(response, "login_buffer", "pc_yyb_auth", session);
            receivedCode = serverInteger(data.code);
            const loginBuffer = receivedCode === 0 ? pickLoginBuffer(data) : "";
            if (!loginBuffer)
                throw responseFailure("login_buffer", "pc_yyb_auth", receivedCode, receivedCode === undefined || receivedCode === 0 ? "response_invalid" : "server_rejected", wechatErrorCode(data, session));
            operation.remaining();
            session.loginBuffer = loginBuffer;
            return { loginBuffer, refreshtoken: refreshToken, accesstoken: accessToken };
        }
        catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            failure.stage = "login_buffer";
            failure.business = "pc_yyb_auth";
            if (receivedCode !== undefined) {
                if (failure.code === undefined) failure.code = receivedCode;
                failure.serverCode = receivedCode;
            }
            throw sanitizeFailure(failure, session);
        }
        finally {
            if (operation && !options[sharedRefreshOperation]) operation.close();
        }
    }
    async refreshCredentials(session, options = {}) {
        if (typeof options === "function") options = { onCredentialsRotated: options };
        if (!session || typeof session.openid !== "string" || !session.openid || typeof session.refreshtoken !== "string" || !session.refreshtoken)
            throw responseFailure("token_refresh", undefined, undefined, "local_credential_missing");
        const source = credentialSource(session);
        const inputCredentials = { openid: session.openid, accesstoken: session.accesstoken, refreshtoken: session.refreshtoken,
            loginBuffer: session.loginBuffer, loginType: session.loginType, login_type: session.login_type };
        let operation;
        let receivedCode;
        let credentials;
        let stage = "token_refresh";
        try {
            operation = options[sharedRefreshOperation] || refreshOperation(session, options, 35e3);
            operation.remaining();
            const previousRefreshToken = session.refreshtoken;
            const previousAccessToken = session.accesstoken || "";
            const tokenRequestedAt = Date.now();
            const payload = JSON.stringify({ userInfo: { openId: session.openid, refreshToken: previousRefreshToken, accessToken: previousAccessToken, loginType: "WX" } });
            const timestamp = String(tokenRequestedAt);
            const nonce = String(node_crypto_1.default.randomInt(1e3, 1e4));
            const signature = node_crypto_1.default.createHash("md5").update(`${payload}${timestamp}${source.key}${nonce}`).digest("hex");
            const response = await request(source.url, session.cookies, {
                method: "POST", body: payload, signal: operation.controller.signal,
                headers: {
                    "Content-Type": "application/json", "Ual-Access-Businessid": source.refreshBusinessId,
                    "Ual-Access-Timestamp": timestamp, "Ual-Access-Nonce": nonce, "Ual-Access-Signature": signature,
                    "Cookie": `openid=${session.openid}; accesstoken=${previousAccessToken}; refreshtoken=${previousRefreshToken}`
                }
            }, operation.remaining());
            const data = responseData(response, "token_refresh", source.refreshBusinessId, session);
            receivedCode = serverInteger(data.code);
            const info = asRecord(data.user_info || data.userInfo);
            const wechatCode = wechatErrorCode(data, inputCredentials);
            if (receivedCode !== 0)
                throw responseFailure("token_refresh", source.refreshBusinessId, receivedCode, receivedCode === undefined ? "response_invalid" : "server_rejected", wechatCode);
            validateIdentity(data, inputCredentials, source.refreshBusinessId, receivedCode);
            const returnedAccessToken = info.access_token !== undefined ? info.access_token : info.accessToken;
            const returnedRefreshToken = info.refresh_token !== undefined ? info.refresh_token : info.refreshToken;
            const accessToken = typeof returnedAccessToken === "string" ? returnedAccessToken : "";
            if (returnedRefreshToken !== undefined && (typeof returnedRefreshToken !== "string" || !returnedRefreshToken))
                throw responseFailure("token_refresh", source.refreshBusinessId, receivedCode);
            const refreshToken = returnedRefreshToken || previousRefreshToken;
            // 响应已完成的 token 轮换必须先保存；销毁/期限随后阻止后续请求。
            const metadata = {
                tokenCheckedAt: Date.now(), ...accessTokenExpiry(info, data, session.cookies, accessToken, tokenRequestedAt),
                refreshBusinessId: source.refreshBusinessId, credentialSource: source.credentialSource
            };
            if (refreshToken !== previousRefreshToken) metadata.refreshTokenChangedAt = metadata.tokenCheckedAt;
            // 缺 access 时仍保留已轮换的 refresh；旧 access 不能沿用旧有效期。
            credentials = { refreshtoken: refreshToken, accesstoken: accessToken || previousAccessToken, ...metadata };
            Object.assign(session, credentials);
            if (options.onCredentialsRotated) {
                stage = "persist_rotated";
                const saved = await options.onCredentialsRotated({ ...credentials });
                if (saved === false) throw responseFailure(stage, source.refreshBusinessId, undefined, "credential_persist_failed");
                stage = "token_refresh";
            }
            if (!accessToken)
                throw responseFailure("token_refresh", source.refreshBusinessId, receivedCode, "response_invalid", wechatCode);
            operation.remaining();
            return credentials;
        }
        catch (error) {
            const failure = credentials ? attachRotatedCredentials(error, credentials.refreshtoken, credentials.accesstoken, credentials) : (error instanceof Error ? error : new Error(String(error)));
            failure.stage = failure.stage || stage;
            failure.business = source.refreshBusinessId;
            if (receivedCode !== undefined) {
                if (failure.code === undefined) failure.code = receivedCode;
                failure.serverCode = receivedCode;
            }
            throw sanitizeFailure(failure, inputCredentials, credentials);
        }
        finally {
            if (operation && !options[sharedRefreshOperation]) operation.close();
        }
    }
    async refreshLoginBuffer(session, options = {}) {
        if (typeof options === "function") options = { onCredentialsRotated: options };
        let operation;
        let credentials;
        const inputCredentials = session && { ...session };
        try {
            if (!session || !session.openid || !session.refreshtoken)
                return await this.refreshCredentials(session, options);
            operation = refreshOperation(session, options, 70e3);
            const sharedOptions = { ...options, [sharedRefreshOperation]: operation };
            credentials = await this.refreshCredentials(session, sharedOptions);
            operation.remaining();
            const buffer = await this.refreshBufferWithAccessToken(session, sharedOptions);
            return { ...credentials, ...buffer };
        }
        catch (error) {
            if (credentials) {
                const failure = attachRotatedCredentials(error, credentials.refreshtoken, credentials.accesstoken, credentials);
                failure.stage = failure.stage || "login_buffer";
                failure.business = failure.business || "pc_yyb_auth";
                throw sanitizeFailure(failure, inputCredentials, credentials);
            }
            throw error;
        }
        finally {
            if (operation) operation.close();
        }
    }
    destroy(session) {
        const operations = refreshOperations.get(session);
        if (operations) {
            refreshOperations.delete(session);
            const controllers = [...operations];
            operations.clear();
            for (const controller of controllers)
                controller.abort(new Error("微信登录会话已销毁"));
        }
        if (session.cookies) {
            session.cookies.clear();
            cookieMetadata.delete(session.cookies);
        }
        session.oauthCode = void 0;
        session.openid = void 0;
        session.accesstoken = void 0;
        session.refreshtoken = void 0;
        session.loginBuffer = void 0;
        session.tokenCheckedAt = void 0;
        session.refreshTokenChangedAt = void 0;
        session.accessTokenExpiresAt = void 0;
        session.accessTokenExpirySource = void 0;
        session.accessTokenCookieExpiresAt = void 0;
        session.accessTokenCookieExpirySource = void 0;
        session.refreshBusinessId = void 0;
        session.refresh_business_id = void 0;
        session.credentialSource = void 0;
        session.loginType = void 0;
        session.scope = void 0;
        session.appId = void 0;
        session.scannedAt = void 0;
    }
}
exports.WxLoginService = WxLoginService;
