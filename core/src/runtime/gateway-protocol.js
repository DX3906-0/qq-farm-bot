/**
 * 网关 IPC 协议 - worker 进程与连接网关进程之间的帧定义与编解码
 *
 * 设计：使用 JSON 文本帧（换行分隔）通过本地 Unix Socket / TCP 传输。
 * 二进制 body（protobuf）用 base64 编码进 JSON，避免二进制帧解析复杂度。
 *
 * 帧类型：
 *  - worker -> gateway:
 *    { t:'connect', accountId, code, platform, os, clientVersion }
 *    { t:'request', accountId, seq, service, method, body(base64) }
 *    { t:'stop', accountId }
 *    { t:'ping' }
 *  - gateway -> worker:
 *    { t:'connected', accountId }
 *    { t:'login', accountId, userState }            // 登录成功，携带基本信息
 *    { t:'response', accountId, seq, error, body(base64), meta }
 *    { t:'notify', accountId, body(base64) }        // 服务端推送，worker 侧 decode
 *    { t:'event', accountId, name, payload }         // kickout/disconnect/ws_error/reconnect_failed
 *    { t:'pong' }
 *    { t:'error', accountId, message }
 */

function encodeFrame(obj) {
    return JSON.stringify(obj);
}

function decodeFrame(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function toBase64(buf) {
    if (!buf) return '';
    if (Buffer.isBuffer(buf)) return buf.toString('base64');
    return Buffer.from(buf).toString('base64');
}

function fromBase64(str) {
    if (!str) return Buffer.alloc(0);
    return Buffer.from(str, 'base64');
}

module.exports = { encodeFrame, decodeFrame, toBase64, fromBase64 };
