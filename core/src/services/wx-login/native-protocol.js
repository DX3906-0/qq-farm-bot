"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNativeWxLoginCode = getNativeWxLoginCode;
exports.hasNativeSession = hasNativeSession;
const node_crypto_1 = __importDefault(require("node:crypto"));
const net = __importStar(require("node:net"));
const U8 = Buffer.from;
const REC = 61699;
const HOST_APP = U8("wxd44977328b36e647");
const SERVER_PUB = Buffer.from("04ef87876d6478b15f1796eab12068610541173b7176b67f1dcc86683e901acd44d18b4ac36938251d0812dd0cf842aa2d6cbb8115712d1c0087dcefc14a44cd58", "hex");
const TRANSFER_PATH = U8("/ilink/ilinkapp/mp/wxaruntime_transfer");
const TRANSFER_HOST = U8("shortcloud.weixin.com");
const vi = (n) => {
    let v = BigInt(n);
    const out = [];
    do {
        let b = Number(v & 127n);
        v >>= 7n;
        if (v)
            b |= 128;
        out.push(b);
    } while (v);
    return Buffer.from(out);
};
const pbl = (f, b) => Buffer.concat([vi(f * 8 + 2), vi(b.length), b]);
const pbv = (f, n) => Buffer.concat([vi(f * 8), vi(n)]);
function parseError(state, field = "unknown", wire = "unknown", length = 0) {
    const error = new Error(`Protocol parse invalid: state=${state} field=${field} wire=${wire} length=${length}`);
    error.code = "WX_NATIVE_PARSE_INVALID";
    return error;
}
function rvi(b, o, field, wire) {
    if (!Number.isSafeInteger(o) || o < 0 || o > b.length)
        throw parseError("invalid-varint-offset", field, wire);
    let n = 0n;
    for (let i = 0; i < 10; i++) {
        if (o + i >= b.length)
            throw parseError("truncated-varint", field, wire, i);
        const x = b[o + i];
        if (i === 9 && x > 1)
            throw parseError("varint-overflow", field, wire, 10);
        n |= BigInt(x & 127) << BigInt(i * 7);
        if (!(x & 128))
            return [n, o + i + 1];
    }
    throw parseError("varint-overflow", field, wire, 10);
}
function pbf(b) {
    const out = new Map();
    out.meta = new Map();
    let o = 0;
    while (o < b.length) {
        const [tag, a] = rvi(b, o);
        o = a;
        const field = tag >> 3n;
        const wire = Number(tag & 7n);
        if (!field || field > 536870911n)
            throw parseError("invalid-field", field, wire, b.length);
        const f = Number(field);
        let value;
        let length;
        if (wire === 0) {
            const [n, z] = rvi(b, o, f, wire);
            value = n;
            length = z - o;
            o = z;
        }
        else if (wire === 1 || wire === 2 || wire === 5) {
            let n = wire === 1 ? 8n : 4n;
            if (wire === 2)
                [n, o] = rvi(b, o, f, wire);
            if (n > BigInt(Number.MAX_SAFE_INTEGER) || n > BigInt(b.length - o))
                throw parseError("invalid-field-length", f, wire, b.length - o);
            length = Number(n);
            value = b.subarray(o, o + length);
            o += length;
        }
        else
            throw parseError("unsupported-wire", f, wire, b.length);
        out.set(f, value);
        out.meta.set(f, { wire, length });
    }
    return out;
}
const hmac = (key, data) => node_crypto_1.default.createHmac("sha256", key).update(data).digest();
function expand(secret, label, context, size) {
    const out = [];
    let prev = Buffer.alloc(0);
    for (let c = 1; Buffer.concat(out).length < size; c++) {
        prev = hmac(secret, Buffer.concat([prev, U8(label), context, Buffer.from([c])]));
        out.push(prev);
    }
    return Buffer.concat(out).subarray(0, size);
}
function extract(salt, data) {
    return hmac(salt, data);
}
function nonce(iv, seq) {
    const n = Buffer.from(iv);
    const s = Buffer.alloc(8);
    s.writeBigUInt64BE(BigInt(seq));
    for (let i = 0; i < 8; i++)
        n[n.length - 8 + i] ^= s[i];
    return n;
}
function gcm(key, iv, seq, type, data, decrypt = false) {
    const aad = Buffer.alloc(13);
    aad.writeBigUInt64BE(BigInt(seq));
    aad[8] = type;
    aad.writeUInt16BE(REC, 9);
    aad.writeUInt16BE(decrypt ? data.length : data.length + 16, 11);
    const algo = `aes-${key.length * 8}-gcm`;
    if (decrypt) {
        const d = node_crypto_1.default.createDecipheriv(algo, key, nonce(iv, seq));
        d.setAAD(aad);
        d.setAuthTag(data.subarray(-16));
        return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
    }
    const c = node_crypto_1.default.createCipheriv(algo, key, nonce(iv, seq));
    c.setAAD(aad);
    return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}
function layout(key, plain, aad = Buffer.alloc(0)) {
    const iv = node_crypto_1.default.randomBytes(12);
    const c = node_crypto_1.default.createCipheriv(`aes-${key.length * 8}-gcm`, key, iv);
    c.setAAD(aad);
    return Buffer.concat([c.update(plain), c.final(), iv, c.getAuthTag()]);
}
function unlayout(key, blob, aad = Buffer.alloc(0)) {
    const split = blob.length - 28;
    const d = node_crypto_1.default.createDecipheriv(`aes-${key.length * 8}-gcm`, key, blob.subarray(split, split + 12));
    d.setAAD(aad);
    d.setAuthTag(blob.subarray(split + 12));
    return Buffer.concat([d.update(blob.subarray(0, split)), d.final()]);
}
const rec = (type, body) => {
    const h = Buffer.alloc(5);
    h[0] = type;
    h.writeUInt16BE(REC, 1);
    h.writeUInt16BE(body.length, 3);
    return Buffer.concat([h, body]);
};
function records(data) {
    const out = [];
    for (let o = 0; o + 5 <= data.length;) {
        const n = data.readUInt16BE(o + 3);
        if (data.readUInt16BE(o + 1) !== REC || o + 5 + n > data.length)
            break;
        out.push({ type: data[o], body: data.subarray(o + 5, o + 5 + n) });
        o += 5 + n;
    }
    return out;
}
const hs = (type, body) => {
    const h = Buffer.alloc(5);
    h.writeUInt32BE(body.length + 1);
    h[4] = type;
    return Buffer.concat([h, body]);
};
function splitHs(b) {
    if (b.length < 5 || b.readUInt32BE() + 4 > b.length)
        throw new Error("invalid handshake");
    return { type: b[4], body: b.subarray(5) };
}
function lz4Literal(data) {
    if (data.length < 15)
        return Buffer.concat([Buffer.from([data.length << 4]), data]);
    const xs = [240];
    for (let n = data.length - 15; n >= 255; n -= 255)
        xs.push(255);
    xs.push((data.length - 15) % 255);
    return Buffer.concat([Buffer.from(xs), data]);
}
function lz4(data) {
    const out = [];
    for (let i = 0; i < data.length;) {
        const t = data[i++];
        let n = t >> 4;
        if (n === 15) {
            let x = 0;
            do {
                x = data[i++];
                n += x;
            } while (x === 255);
        }
        for (let e = i + n; i < e; i++)
            out.push(data[i]);
        if (i >= data.length)
            break;
        const off = data.readUInt16LE(i);
        i += 2;
        let m = (t & 15) + 4;
        if ((t & 15) === 15) {
            let x = 0;
            do {
                x = data[i++];
                m += x;
            } while (x === 255);
        }
        for (let j = 0; j < m; j++)
            out.push(out[out.length - off]);
    }
    return Buffer.from(out);
}
function wpkg(ints, bytes) {
    const a = [vi(1)];
    for (const k of Object.keys(ints).map(Number).sort((x, y) => x - y))
        a.push(vi(k), vi(ints[k]));
    a.push(vi(0));
    for (const k of Object.keys(bytes).map(Number).sort((x, y) => x - y))
        a.push(vi(k), vi(bytes[k].length), bytes[k]);
    const p = Buffer.concat(a);
    return Buffer.concat([p, vi(0), vi(p.length + 1)]);
}
function readWpkg(b) {
    let o = 0;
    [, o] = rvi(b, o);
    for (;;) {
        const [f, n] = rvi(b, o);
        o = n;
        if (!f)
            break;
        [, o] = rvi(b, o);
    }
    for (;;) {
        const [f, n] = rvi(b, o);
        o = n;
        if (!f)
            break;
        const [l, z] = rvi(b, o, f, 2);
        if (l > BigInt(Number.MAX_SAFE_INTEGER) || l > BigInt(b.length - z))
            throw parseError("invalid-wpkg-byte-length", f, 2, b.length - z);
        o = z + Number(l);
    }
    [, o] = rvi(b, o);
    return o;
}
function short(cmd, seq, body) {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(16 + body.length);
    b.writeUInt16BE(4368, 4);
    b.writeUInt16BE(1901, 6);
    b.writeUInt32BE(cmd, 8);
    b.writeUInt32BE(seq, 12);
    return Buffer.concat([b, body]);
}
function parseShort(b) {
    if (b.length < 16 || b.readUInt32BE() > b.length)
        throw new Error("invalid shortlink");
    return { cmd: b.readUInt32BE(8), body: b.subarray(16, b.readUInt32BE()) };
}
function ecdh() {
    const e = node_crypto_1.default.createECDH("prime256v1");
    return { e, pub: e.generateKeys() };
}
function ch(pub1, pub2) {
    const r = node_crypto_1.default.randomBytes(32);
    const b = [Buffer.from([3, 241, 1, 192, 43]), r, Buffer.alloc(4)];
    b[2].writeUInt32BE(Math.floor(Date.now() / 1e3));
    const offers = [pub1, pub2].map((p, i) => {
        const x = Buffer.alloc(6);
        x.writeUInt32BE(i ? 2 : 1);
        x.writeUInt16BE(65, 4);
        const z = Buffer.concat([x, p]);
        const n2 = Buffer.alloc(4);
        n2.writeUInt32BE(z.length);
        return Buffer.concat([n2, z]);
    });
    const ks = Buffer.concat([Buffer.from([0, 16, 2]), ...offers, Buffer.from([0, 0, 0, 1])]);
    const ext = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), ks]);
    ext.writeUInt32BE(ks.length, 1);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(ext.length);
    return hs(1, Buffer.concat([...b, n, ext]));
}
function pskClientHello(ticket, timestamp) {
    const u32 = (value) => {
        const out = Buffer.alloc(4);
        out.writeUInt32BE(value);
        return out;
    };
    const ticketExtension = Buffer.concat([Buffer.from([0, 15, 1]), u32(ticket.length), ticket]);
    const extension = Buffer.concat([Buffer.from([1]), u32(ticketExtension.length), ticketExtension]);
    const body = Buffer.concat([
        Buffer.from([3, 241, 1, 0, 168]),
        node_crypto_1.default.randomBytes(32),
        u32(timestamp),
        u32(extension.length),
        extension
    ]);
    return hs(1, body);
}
async function socket(host, port, timeout = 3e4, options = {}) {
    const signal = options.signal;
    if (signal?.aborted)
        throw signal.reason || new Error("WeChat protocol cancelled");
    if (options.deadline !== undefined && Date.now() >= options.deadline)
        throw new Error("WeChat protocol timeout");
    const s = net.createConnection({ host, port });
    const chunks = [];
    const pending = new Set();
    let connected = false;
    let ended = false;
    let failure = null;
    let offset = 0;
    const notify = () => {
        for (const waiter of [...pending]) waiter.check();
    };
    const onData = (chunk) => {
        chunks.push(Buffer.from(chunk));
        notify();
    };
    const onConnect = () => {
        connected = true;
        notify();
    };
    const onEnd = () => {
        ended = true;
        notify();
    };
    const onError = (error) => close(error);
    const onClose = () => {
        close(new Error("socket closed"));
        s.removeListener("error", onError);
        s.removeListener("close", onClose);
    };
    const onAbort = () => close(signal.reason || new Error("WeChat protocol cancelled"));
    function close(error = new Error("socket closed")) {
        if (failure) return;
        failure = error;
        for (const waiter of [...pending]) waiter.reject(error);
        s.removeListener("data", onData);
        s.removeListener("connect", onConnect);
        s.removeListener("end", onEnd);
        if (signal) signal.removeEventListener("abort", onAbort);
        // destroy 后仍可能有已排队的 error；保留到 close 再解绑，避免未处理错误。
        if (s.closed) {
            s.removeListener("error", onError);
            s.removeListener("close", onClose);
        }
        s.destroy();
    }
    s.on("data", onData);
    s.on("connect", onConnect);
    s.on("end", onEnd);
    s.on("error", onError);
    s.on("close", onClose);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // 在 connect 完成前登记，失败或取消也必须被最终清理覆盖。
    if (options.createdSockets) options.createdSockets.add({ close });
    function wait(check, message, start) {
        if (signal?.aborted) onAbort();
        if (options.deadline !== undefined && Date.now() >= options.deadline)
            close(new Error("WeChat protocol timeout"));
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pending.delete(waiter);
                if (error) reject(error);
                else resolve(value);
            };
            const waiter = {
                check: () => {
                    try { check((value) => finish(null, value), (error) => finish(error)); }
                    catch (error) { close(error); }
                },
                reject: (error) => finish(error)
            };
            const waitMs = Math.min(timeout, options.deadline === undefined ? Infinity : Math.max(0, options.deadline - Date.now()));
            const timer = setTimeout(() => close(new Error(message)), waitMs);
            pending.add(waiter);
            if (start) {
                try { start((value) => finish(null, value), (error) => close(error)); }
                catch (error) { close(error); }
            }
            if (!settled) waiter.check();
        });
    }
    if (signal?.aborted) onAbort();
    await wait((resolve) => { if (connected) resolve(); }, "connection timeout");
    return {
        s,
        take: () => wait((resolve, reject) => {
            const all = Buffer.concat(chunks);
            if (all.length - offset >= 5) {
                const n = all.readUInt16BE(offset + 3);
                if (all.length - offset >= n + 5) {
                    const out = { type: all[offset], body: all.subarray(offset + 5, offset + 5 + n) };
                    offset += 5 + n;
                    resolve(out);
                    return;
                }
            }
            if (ended) reject(new Error("socket ended before a complete record"));
        }, "socket read timeout"),
        readAll: () => wait((resolve) => {
            if (ended) resolve(Buffer.concat(chunks));
        }, "socket read timeout"),
        send: (data) => wait(() => {}, "socket write timeout", (resolve, reject) => {
            s.write(data, (error) => error ? reject(error) : resolve());
        }),
        close
    };
}
function keys(secret, label, hash, size = 56) {
    const z = expand(secret, label, hash, size);
    return { ck: z.subarray(0, 16), sk: z.subarray(16, 32), ci: z.subarray(32, 44), si: z.subarray(44, 56) };
}
function oneWayKeys(secret, label, hash) {
    const z = expand(secret, label, hash, 28);
    return { key: z.subarray(0, 16), iv: z.subarray(16, 28) };
}
function manualRequest(buffer, app) {
    const raw = Buffer.from(buffer, "base64");
    const f = pbf(raw);
    const ticket = f.get(1);
    const device = f.get(2);
    const host = f.get(3);
    if (!Buffer.isBuffer(ticket) || !ticket.length || !Buffer.isBuffer(device) || !device.length)
        throw new Error("invalid login buffer");
    const base = pbl(1, app);
    const req = Buffer.concat([pbl(1, base), pbv(2, 1901), pbl(3, pbl(1, ticket)), pbv(4, 4), pbl(6, Buffer.alloc(0)), pbv(7, 0), pbv(8, 6)]);
    return { req, device, host: Buffer.isBuffer(host) && host.length ? host : HOST_APP };
}
function hybrid(plain) {
    const x = ecdh();
    const secret = node_crypto_1.default.createHash("sha256").update(x.e.computeSecret(SERVER_PUB)).digest();
    const h1 = node_crypto_1.default.createHash("sha256").update(Buffer.concat([U8("1"), U8("415"), x.pub])).digest();
    const cek = node_crypto_1.default.randomBytes(32);
    const encKey = layout(secret.subarray(0, 24), cek, h1);
    const okm = expand(extract(U8("security hdkf expand"), cek), "", h1, 56);
    const comp = lz4Literal(plain);
    const h2 = node_crypto_1.default.createHash("sha256").update(Buffer.concat([U8("1"), U8("415"), x.pub, encKey])).digest();
    const enc = layout(okm.subarray(0, 24), comp, h2);
    return { temp: { e: x.e, okm, comp }, wire: Buffer.concat([pbv(1, 1), pbl(2, Buffer.concat([pbv(1, 415), pbl(2, x.pub)])), pbl(3, encKey), pbl(4, Buffer.alloc(0)), pbl(5, enc)]) };
}
function requiredField(fields, field, name) {
    const value = fields.get(field);
    if (!Buffer.isBuffer(value))
        throw new Error(`${name} is missing (fields: ${[...fields.keys()].join(",") || "none"})`);
    return value;
}
function parseManual(body, temp) {
    let state = "hybrid-not-found";
    const requiredBytes = (fields, field, allowEmpty = false) => {
        const value = fields.get(field);
        const meta = fields.meta.get(field);
        if (meta?.wire !== 2 || !Buffer.isBuffer(value) || (!allowEmpty && !value.length))
            throw parseError("missing-or-invalid-bytes", field, meta?.wire, meta?.length);
        return value;
    };
    try {
        let hybridResponse;
        try {
            const offset = readWpkg(body);
            if (offset < body.length && body[offset] === 10)
                hybridResponse = body.subarray(offset);
        }
        catch {
        }
        if (!hybridResponse) {
            const marker = Buffer.from([8, 159, 3, 18, 65, 4]);
            const offset = body.indexOf(marker);
            if (offset < 2)
                throw parseError(state, "unknown", "unknown", body.length);
            hybridResponse = body.subarray(offset - 2);
        }
        state = "hybrid-fields";
        const response = pbf(hybridResponse);
        const keyFields = pbf(requiredBytes(response, 1));
        const peer = requiredBytes(keyFields, 2);
        const ct = requiredBytes(response, 3);
        const credentialValue = response.get(2);
        if (response.has(2) && (typeof credentialValue !== "bigint" || credentialValue > BigInt(Number.MAX_SAFE_INTEGER)))
            throw parseError("invalid-credential-type", 2, response.meta.get(2).wire, response.meta.get(2).length);
        const cred = credentialValue === undefined ? 1 : Number(credentialValue);
        state = "key-agreement-failed";
        const secret = node_crypto_1.default.createHash("sha256").update(temp.e.computeSecret(peer)).digest();
        const aad = node_crypto_1.default.createHash("sha256").update(Buffer.concat([temp.okm.subarray(24), temp.comp, U8("415"), peer, U8(String(cred))])).digest();
        state = "decrypt-auth-failed";
        const plain = lz4(unlayout(secret.subarray(0, 24), ct, aad));
        state = "manual-fields";
        const manual = pbf(plain);
        // ManualAuthResponse.BaseResponse.ret 位于 outer field1 → field1，
        // body field4 不是唯一业务结果。旧解析会把真实-10拒绝误报code0缺session。
        if (manual.has(1)) {
            const base = pbf(requiredBytes(manual, 1));
            const result = base.get(1);
            if (result !== undefined && typeof result !== "bigint") throw parseError("invalid-base-code", 1, base.meta.get(1)?.wire);
            if (typeof result === "bigint" && result !== 0n) {
                const serverCode = BigInt.asIntN(result <= 0xffffffffn ? 32 : 64, result);
                const error = nativeError("WX_MANUAL_AUTH_REJECTED", "manual_auth", `ManualAuth rejected: code=${serverCode} state=base-response field=1 wire=0`);
                error.serverCode = Number.isSafeInteger(Number(serverCode)) ? Number(serverCode) : serverCode.toString();
                throw error;
            }
        }
        const bodyFields = pbf(requiredBytes(manual, 3));
        const code = bodyFields.get(4);
        const codeMeta = bodyFields.meta.get(4);
        if (bodyFields.has(4) && typeof code !== "bigint")
            throw parseError("invalid-code-type", 4, codeMeta.wire, codeMeta.length);
        if (typeof code === "bigint" && code !== 0n) {
            const serverCode = BigInt.asIntN(code <= 0xffffffffn ? 32 : 64, code);
            const error = new Error(`ManualAuth rejected: code=${serverCode} state=nonzero-code field=4 wire=0 length=${codeMeta.length}`);
            error.code = "WX_MANUAL_AUTH_REJECTED";
            error.stage = "manual_auth";
            error.serverCode = serverCode >= BigInt(Number.MIN_SAFE_INTEGER) && serverCode <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(serverCode) : serverCode.toString();
            throw error;
        }
        if (!bodyFields.has(2))
            throw parseError(code === 0n ? "zero-code-without-session" : "unknown-code-without-session", 2);
        const sessionFields = pbf(requiredBytes(bodyFields, 2));
        const identityFields = pbf(requiredBytes(bodyFields, 3));
        const uin = identityFields.get(1);
        const identityMeta = identityFields.meta.get(1);
        if (typeof uin !== "bigint" || !uin)
            throw parseError("missing-or-invalid-identity", 1, identityMeta?.wire, identityMeta?.length);
        return {
            sendKey: requiredBytes(sessionFields, 1),
            recvKey: requiredBytes(sessionFields, 2),
            f9: sessionFields.has(9) ? requiredBytes(sessionFields, 9, true) : Buffer.alloc(0),
            uin
        };
    }
    catch (cause) {
        if (cause?.code === "WX_MANUAL_AUTH_REJECTED") throw cause;
        const error = new Error(cause?.code === "WX_NATIVE_PARSE_INVALID"
            ? cause.message : `ManualAuth response invalid: state=${state} field=unknown wire=unknown length=${body.length}`);
        error.code = "WX_MANUAL_AUTH_RESPONSE_INVALID";
        error.stage = "manual_auth";
        throw error;
    }
}
function jsPlain(uin, appId, host) {
    const mac = node_crypto_1.default.randomBytes(6);
    mac[0] = (mac[0] | 2) & 254;
    const dev = U8((mac.toString("hex").match(/../g) || []).join("-").toUpperCase());
    const uin32 = BigInt.asUintN(32, uin);
    const info = (name) => Buffer.concat([pbl(1, U8("sessionkey")), pbv(2, uin32), pbl(3, dev), pbv(4, 1661404927), pbl(5, U8(name)), pbv(6, 0)]);
    const req = Buffer.concat([pbl(1, info("UnifiedPCWindows")), pbl(2, U8(appId)), pbv(4, 1), pbl(5, Buffer.alloc(0)), pbl(6, Buffer.alloc(0)), pbv(7, 1)]);
    return Buffer.concat([pbl(1, info("Windows")), pbl(2, U8("/cgi-bin/mmbiz-bin/js-login")), pbl(3, host), pbv(4, 5), pbl(5, req), pbl(6, U8(appId)), pbv(7, 1029), pbv(8, 1610627409), pbl(9, U8("WindowsxWebPlugin")), pbv(10, 573651281)]);
}
function envelope(s, plain) {
    const enc = layout(s.sendKey, lz4Literal(plain));
    const head = wpkg({ 1: 1, 2: s.uin, 3: 0, 4: 0, 5: 524545, 6: 11, 7: 0, 8: 0, 9: 0, 10: 1, 11: 0, 12: 0, 13: 0, 17: 0, 18: 1, 20: 1504, 21: 0, 22: s.uin, 23: 0, 25: 16, 26: 4, 28: 1, 29: 1, 30: 0 }, { 14: Buffer.alloc(0), 24: s.deviceId, 27: s.f9 });
    const inner = short(2881, 0, Buffer.concat([head, enc]));
    const b = Buffer.concat([Buffer.alloc(2), TRANSFER_PATH, Buffer.alloc(2), TRANSFER_HOST, Buffer.alloc(4), inner]);
    b.writeUInt16BE(TRANSFER_PATH.length);
    b.writeUInt16BE(TRANSFER_HOST.length, 2 + TRANSFER_PATH.length);
    b.writeUInt32BE(inner.length, 4 + TRANSFER_PATH.length + TRANSFER_HOST.length);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function targets(kind, signal) {
    if (signal?.aborted) throw signal.reason || new Error("WeChat protocol cancelled");
    const r = await fetch("http://aedns.weixin.qq.com/cgi-bin/default/getdns?clientversion=0&devicetype=Windows&uin=0&format=json", { headers: { "User-Agent": "MicroMessenger Client" }, signal });
    const data = await r.json();
    const dns = asRecord(asRecord(data).dns);
    const domainList = Array.isArray(dns.domainlist) ? dns.domainlist.map(asRecord) : [];
    const item = domainList.find((entry) => entry.name === (kind === "long" ? "longcloud.weixin.com" : "shortcloud.weixin.com"));
    const proto = kind === "long" ? "mmtlsovertcp" : "http";
    const protocolList = Array.isArray(item?.protocollist) ? item.protocollist.map(asRecord) : [];
    const portList = protocolList.find((entry) => entry.name === proto)?.portlist;
    const ports = Array.isArray(portList) ? portList.filter((port) => typeof port === "number") : [];
    // 端口排序：8080/443/5000 优先（服务器响应快，失败也立即拒绝），80 最后（最常挂起到 read timeout）
    const orderedPorts = [8080, 443, 5000, 80].filter((p) => ports.includes(p));
    const ipList = Array.isArray(item?.iplist) ? item.iplist.map(asRecord) : [];
    const ips = ipList.map((entry) => entry.ip).filter((ip) => typeof ip === "string" && ip.length > 0);
    const out = ips.flatMap((ip) => orderedPorts.map((port) => ({ ip, port })));
    return out.length ? out : [{ ip: kind === "long" ? "180.153.202.85" : "120.241.131.173", port: kind === "long" ? 8080 : 80 }];
}
// 进程内缓存：上次微信长连换码成功的 IP:port。海外服务器连国内微信长连服务器慢，
// 原逻辑对 12 个 IP 逐一 5s 超时重试，单此步就可能几十秒。缓存命中后下次直连，秒级完成。
let preferredLongTarget = null;

function nativeError(code, stage, message) {
    const error = new Error(message);
    error.code = code;
    error.stage = stage;
    return error;
}
function ticketExpiry(ticket, createdAt) {
    if (ticket[0] !== 1 || ticket.length < 5) return null;
    const expiresAt = createdAt + ticket.readUInt32BE(1) * 1000;
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !Number.isSafeInteger(expiresAt))
        throw nativeError("WX_NATIVE_SESSION_INVALID", "native_session", "Native session lifetime is invalid");
    return expiresAt;
}
function restoreNativeSession(record, binding, now = Date.now()) {
    const invalid = () => nativeError("WX_NATIVE_SESSION_INVALID", "native_session", "Native session is invalid");
    if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1 ||
        typeof binding !== "string" || !binding.length || record.binding !== binding ||
        typeof record.uin !== "string" || !/^[1-9][0-9]{0,19}$/.test(record.uin) ||
        BigInt(record.uin) > ((1n << 64n) - 1n) ||
        !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || record.createdAt > now)
        throw invalid();
    const session = { uin: BigInt(record.uin) };
    for (const field of ["sendKey", "recvKey", "f9", "deviceId", "hostAppId", "psk", "ticket"]) {
        const value = record[field];
        if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
            throw invalid();
        const bytes = Buffer.from(value, "base64");
        if (bytes.toString("base64") !== value || (field !== "f9" && !bytes.length)) throw invalid();
        session[field] = bytes;
    }
    if (![16, 24, 32].includes(session.sendKey.length) || ![16, 24, 32].includes(session.recvKey.length) || session.psk.length !== 32)
        throw invalid();
    const expiresAt = ticketExpiry(session.ticket, record.createdAt);
    // 没有服务器 lifetime 的 ticket 仅本次使用，不跨调用复用。
    if (expiresAt === null || !Number.isSafeInteger(record.expiresAt) || record.expiresAt !== expiresAt)
        throw invalid();
    if (expiresAt <= now)
        throw nativeError("WX_NATIVE_SESSION_EXPIRED", "native_session", "Native session has expired");
    return session;
}
function hasNativeSession(record, sessionBinding) {
    try { restoreNativeSession(record, sessionBinding); return true; }
    catch { return false; }
}
function nativeSessionRecord(session, binding, createdAt) {
    const record = { version: 1, binding, uin: session.uin.toString(), createdAt, expiresAt: ticketExpiry(session.ticket, createdAt) };
    for (const field of ["sendKey", "recvKey", "f9", "deviceId", "hostAppId", "psk", "ticket"])
        record[field] = session[field].toString("base64");
    return record;
}
async function getNativeWxLoginCode(loginBuffer, appId, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20e3;
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(deadline))
        throw new Error("Invalid WeChat protocol timeout/deadline");
    const controller = new AbortController();
    const createdSockets = new Set();
    const timeoutError = new Error("WeChat protocol timeout");
    timeoutError.name = "TimeoutError";
    const abort = () => controller.abort(options.signal.reason);
    if (options.signal) {
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(timeoutError), Math.max(0, deadline - Date.now()));
    const remaining = (limit) => {
        if (!controller.signal.aborted && Date.now() >= deadline) controller.abort(timeoutError);
        if (controller.signal.aborted) throw controller.signal.reason || new Error("WeChat protocol cancelled");
        return Math.min(limit, deadline - Date.now());
    };
    const socketOptions = { signal: controller.signal, createdSockets, deadline };
    try {
    remaining(Infinity);
    let session = options.session == null ? null : restoreNativeSession(options.session, options.sessionBinding);
    let sessionExpiresAt = session ? options.session.expiresAt : null;
    if ((options.sessionBinding !== undefined && (typeof options.sessionBinding !== "string" || !options.sessionBinding.length)) ||
        (options.onSession !== undefined && (typeof options.onSession !== "function" || options.sessionBinding === undefined)))
        throw nativeError("WX_NATIVE_SESSION_INVALID", "native_session", "Native session persistence options are invalid");
    if (!session) {
    const { req, device, host } = manualRequest(loginBuffer, node_crypto_1.default.randomBytes(32));
    let manualAuthStarted = false;
    const failures = [];
    // IP 优选：把上次成功的排在前面，命中即秒连，省去其余 11 个 ×5s 重试
    const allTargets = (await targets("long", controller.signal)).slice(0, 12);
    remaining(Infinity);
    const orderedTargets = preferredLongTarget
        ? [preferredLongTarget, ...allTargets.filter((t) => !(t.ip === preferredLongTarget.ip && t.port === preferredLongTarget.port))]
        : allTargets;
    for (const t of orderedTargets) {
        let c;
        try {
            c = await socket(t.ip, t.port, remaining(5e3), socketOptions);
            const a = ecdh();
            const b = ecdh();
            const hello = ch(a.pub, b.pub);
            await c.send(rec(22, hello));
            const sh = await c.take();
            const serverHello = splitHs(sh.body).body;
            const extLength = serverHello.readUInt32BE(36);
            const ext = serverHello.subarray(40, 40 + extLength);
            if (ext.length < 78 || ext[0] !== 1)
                throw new Error("invalid ServerHello key-share extension");
            const secret = node_crypto_1.default.createHash("sha256").update(a.e.computeSecret(ext.subarray(13, 78))).digest();
            const transcript = [hello, sh.body];
            const hsKeys = keys(secret, "handshake key expansion", node_crypto_1.default.createHash("sha256").update(Buffer.concat(transcript)).digest());
            let certHash;
            let ticketCreatedAt;
            const ticketEntries = [];
            let rxSeq = 1;
            for (;;) {
                const r = await c.take();
                const plain = gcm(hsKeys.sk, hsKeys.si, rxSeq++, r.type, r.body, true);
                const x = splitHs(plain);
                if (x.type !== 20)
                    transcript.push(plain);
                if (x.type === 15)
                    certHash = node_crypto_1.default.createHash("sha256").update(Buffer.concat(transcript)).digest();
                if (x.type === 4) {
                    let o = 1;
                    for (let i = 0; i < x.body[0]; i++) {
                        const n = x.body.readUInt32BE(o);
                        if (n > x.body.length - o - 4)
                            throw parseError("invalid-ticket-length", "unknown", "unknown", n);
                        const e = x.body.subarray(o + 4, o + 4 + n);
                        o += 4 + n;
                        if (e[0] === 1 && ticketCreatedAt === undefined) ticketCreatedAt = Date.now();
                        ticketEntries.push(e);
                    }
                }
                if (x.type === 20) {
                    const hash = node_crypto_1.default.createHash("sha256").update(Buffer.concat(transcript)).digest();
                    const verify = hmac(expand(secret, "server finished", Buffer.alloc(0), 32), hash);
                    if (!x.body.subarray(2).equals(verify))
                        throw new Error("MMTLS server verification failed");
                    const appKeys = keys(expand(secret, "expanded secret", hash, 32), "application data key expansion", hash);
                    const finish = hs(20, Buffer.concat([Buffer.from([0, 32]), hmac(expand(secret, "client finished", Buffer.alloc(0), 32), hash)]));
                    await c.send(rec(22, gcm(hsKeys.ck, hsKeys.ci, 1, 22, finish)));
                    const h = hybrid(req);
                    const body = Buffer.concat([wpkg({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 524545, 6: 11, 7: 0, 8: 0, 9: 0, 10: 1, 11: 0, 12: 0, 13: 0, 17: 0, 18: 1, 20: 1504, 21: 0, 22: 0, 23: 0, 25: 17, 26: 4, 28: 1, 29: 1, 30: 0 }, { 14: Buffer.alloc(0), 24: device, 27: Buffer.alloc(0) }), h.wire]);
                    manualAuthStarted = true;
                    // 先登记响应读取；完整响应到达即可保存，不等待迟到的 write 回调。
                    const authResponse = c.take();
                    c.send(rec(23, gcm(appKeys.ck, appKeys.ci, 2, 23, short(3453, 0, body)))).catch(() => {});
                    const ar = await authResponse;
                    const auth = parseShort(gcm(appKeys.sk, appKeys.si, rxSeq++, ar.type, ar.body, true));
                    const s = parseManual(auth.body, h.temp);
                    const certificateHash = certHash;
                    const tickets = certificateHash ? ticketEntries.filter((entry) => entry[0] === 1).map((ticket) => ({ psk: expand(secret, "PSK_ACCESS", certificateHash, 32), ticket })) : [];
                    const firstTicket = tickets[0];
                    if (![16, 24, 32].includes(s.sendKey.length) || ![16, 24, 32].includes(s.recvKey.length) || !s.uin || !firstTicket)
                        throw nativeError("WX_MANUAL_AUTH_RESPONSE_INVALID", "manual_auth", "ManualAuth did not return a usable session");
                    session = { ...s, deviceId: device, hostAppId: host, ...firstTicket };
                    const record = nativeSessionRecord(session, options.sessionBinding, ticketCreatedAt);
                    sessionExpiresAt = record.expiresAt;
                    preferredLongTarget = { ip: t.ip, port: t.port };
                    c.close();
                    if (options.onSession) {
                        try { await options.onSession(record); }
                        catch {
                            throw nativeError("WX_NATIVE_SESSION_PERSIST_FAILED", "persist_native_session", "Native session persistence failed");
                        }
                    }
                    remaining(Infinity);
                    if (record.expiresAt !== null && record.expiresAt <= Date.now())
                        throw nativeError("WX_NATIVE_SESSION_EXPIRED", "native_session", "Native session has expired");
                    break;
                }
            }
        }
        catch (error) {
            if (error?.stage === "persist_native_session") throw error;
            remaining(Infinity);
            if (manualAuthStarted || error?.stage === "native_session" || error?.name === "AbortError" || error?.code === "WX_MANUAL_AUTH_REJECTED" || error?.code === "WX_MANUAL_AUTH_RESPONSE_INVALID") throw error;
            failures.push(`${t.ip}:${t.port} ${errorMessage(error).slice(0, 120)}`);
        }
        finally {
            if (c) c.close();
        }
        if (session)
            break;
    }
    if (!session)
        throw new Error(`Unable to establish WeChat protocol session: ${failures.join("; ") || "no HTTPDNS target succeeded"}`);
    }
    remaining(Infinity);
    const activeSession = session;
    const env = envelope(activeSession, jsPlain(activeSession.uin, appId, activeSession.hostAppId));
    const early = async (target) => {
        const ts = Math.floor(Date.now() / 1e3);
        const ticket = activeSession.ticket;
        const hello = pskClientHello(ticket, ts);
        const ek = oneWayKeys(activeSession.psk, "early data key expansion", node_crypto_1.default.createHash("sha256").update(hello).digest());
        const type8 = Buffer.from([0, 0, 0, 16, 8, 0, 0, 0, 11, 1, 0, 0, 0, 6, 0, 18, 0, 0, 0, 0]);
        type8.writeUInt32BE(ts, 16);
        const body = Buffer.concat([rec(25, hello), rec(25, gcm(ek.key, ek.iv, 1, 25, type8)), rec(23, gcm(ek.key, ek.iv, 2, 23, env)), rec(21, gcm(ek.key, ek.iv, 3, 21, Buffer.from([0, 0, 0, 3, 0, 1, 1])))]);
        const requestHead = `POST /mmtls/${ts.toString(16).padStart(8, "0")} HTTP/1.0\r
Accept: */*\r
Cache-Control: no-cache\r
Connection: close\r
Content-Length: ${body.length}\r
Content-Type: application/octet-stream\r
Host: shortcloud.weixin.com\r
Upgrade: mmtls\r
User-Agent: MicroMessenger Client\r
X-Online-Host: shortcloud.weixin.com\r
\r
`;
        const c = await socket(target.ip, target.port, remaining(8e3), socketOptions);
        let raw;
        try {
            await c.send(Buffer.concat([U8(requestHead), body]));
            raw = await c.readAll();
            remaining(Infinity);
        }
        finally {
            c.close();
        }
        const headerEnd = raw.indexOf("\r\n\r\n");
        const status = /^HTTP\/1\.[01] ([0-9]{3})(?:[ \r\n])/.exec(raw.subarray(0, headerEnd < 0 ? 0 : headerEnd + 2).toString("latin1"));
        if (headerEnd < 0 || !status)
            throw nativeError("WX_SHORTLINK_RESPONSE_INVALID", "shortlink", "ShortLink returned an invalid HTTP response");
        const httpStatus = Number(status[1]);
        if (httpStatus < 200 || httpStatus >= 300) {
            const error = nativeError("WX_SHORTLINK_HTTP_ERROR", "shortlink", `ShortLink HTTP status ${httpStatus}`);
            error.httpStatus = httpStatus;
            throw error;
        }
        const responseBody = raw.subarray(headerEnd + 4);
        const responseRecords = records(responseBody);
        const serverHello = responseRecords.find((record) => record.type === 22)?.body;
        // 服务端可能回多个 type-23（early data 回声/ACK 在前、真正应用响应在后）。只取第一条
        // 会让"第二条才合法"的响应永久失败；records() 已把 body 精确切分并按平铺长度校验，
        // 因此遍历全部 type-23 天然有界，不会放大攻击面。
        const appRecords = responseRecords.filter((record) => record.type === 23)
            .map((record) => record.body).filter((body) => body.length >= 16);
        if (!serverHello?.length || !appRecords.length || responseRecords.reduce((size, record) => size + 5 + record.body.length, 0) !== responseBody.length)
            throw nativeError("WX_SHORTLINK_RESPONSE_INVALID", "shortlink", "ShortLink response missing or invalid ServerHello/AppData");
        let authenticated = false;
        let appLayoutDecrypted = false;
        let invalidCodeField = false;
        let codeUnavailable = false;
        const transcripts = [Buffer.concat([hello, serverHello]), Buffer.concat([hello, type8, serverHello]), Buffer.concat([hello, serverHello, type8])];
        for (const transcript of transcripts) {
            const hk = oneWayKeys(activeSession.psk, "handshake key expansion", node_crypto_1.default.createHash("sha256").update(transcript).digest());
            for (const seq of [2, 1, 3]) {
                for (const appData of appRecords) {
                    let decrypted;
                    try { decrypted = gcm(hk.key, hk.iv, seq, 23, appData, true); }
                    catch { continue; }
                    // AEAD 通过 == 真实认证过；坏 tag/错 seq 必然在此失败，不会被后面的解析掩盖。
                    authenticated = true;
                    const candidates = [decrypted];
                    try {
                        const parsed = parseShort(decrypted);
                        if (parsed.body.length) candidates.unshift(parsed.body);
                    }
                    catch { }
                    for (const candidate of candidates) {
                        // 结构化偏移：short 信封给出 body，wpkg 头给出加密块起点；解析失败才回退 0。
                        // 不再 0..219 盲扫——盲扫既会解错位置，也会漏掉偏移 >=220 的合法布局。
                        const offsets = [];
                        try {
                            const offset = readWpkg(candidate);
                            if (offset > 0 && offset < candidate.length) offsets.push(offset);
                        } catch { }
                        offsets.push(0);
                        for (const offset of offsets) {
                            let compressed;
                            try { compressed = unlayout(activeSession.recvKey, candidate.subarray(offset)); }
                            catch { continue; }
                            // 应用层 AEAD 通过：说明这一段确实是服务端加密的应用响应，
                            // 之后的结构/字段问题属于"响应内容非法"，与"票不可用"无关。
                            appLayoutDecrypted = true;
                            let inner;
                            try {
                                const outer = pbf(lz4(compressed));
                                inner = pbf(requiredField(outer, 2, "wx.login response field 2"));
                            }
                            catch { continue; }
                            const code = inner.get(3);
                            if (code !== undefined && !Buffer.isBuffer(code)) { invalidCodeField = true; continue; }
                            if (!Buffer.isBuffer(code) || !code.length) { codeUnavailable = true; continue; }
                            return code.toString();
                        }
                    }
                }
            }
        }
        if (invalidCodeField)
            throw nativeError("WX_SHORTLINK_RESPONSE_INVALID", "shortlink", "ShortLink login code field is invalid");
        if (codeUnavailable)
            throw nativeError("WX_LOGIN_CODE_UNAVAILABLE", "js_login", "wx.login response has no code");
        // 应用层 AEAD 已通过但结构不合法：是响应内容问题，不是网络抖动或票据问题。
        if (appLayoutDecrypted)
            throw nativeError("WX_SHORTLINK_RESPONSE_INVALID", "shortlink", "ShortLink application response is invalid");
        // 短链阶段无法区分"票已不可用"与"响应布局/解析和本地假设不一致"：
        // 2026-11-08 用真实 AES 复核证实，同一张合法 7 天票在应用数据偏移 220、或多 record
        // 布局下同样报 APP_DECRYPT_FAILED，外层认证失败也会落在这里。
        // 因此这里绝不断言"票被服务端拒绝"（ticketRejected），只标记 needsReverify：
        // 由上层走一次 ManualAuth 权威校验，真正的拒绝码 -10 只会从 ManualAuth 回来。
        const shortlinkError = nativeError(authenticated ? "WX_SHORTLINK_APP_DECRYPT_FAILED" : "WX_SHORTLINK_AUTH_FAILED", "shortlink",
            authenticated ? "ShortLink application decryption failed" : "ShortLink authentication failed");
        shortlinkError.ticketUnverified = true;
        throw shortlinkError;
    };
    let last = null;
    let shortTargets;
    try { shortTargets = await targets("short", controller.signal); }
    catch {
        remaining(Infinity);
        throw nativeError("WX_SHORTLINK_NETWORK_ERROR", "shortlink", "ShortLink HTTPDNS request failed");
    }
    for (const t of shortTargets)
        try {
            remaining(Infinity);
            if (sessionExpiresAt !== null && sessionExpiresAt <= Date.now())
                throw nativeError("WX_NATIVE_SESSION_EXPIRED", "native_session", "Native session has expired");
            const code = await early(t);
            remaining(Infinity);
            return code;
        }
        catch (e) {
            remaining(Infinity);
            if (e?.name === "AbortError" || e?.stage === "native_session" || e?.stage === "shortlink" || e?.stage === "js_login") throw e;
            last = nativeError("WX_SHORTLINK_NETWORK_ERROR", "shortlink", "ShortLink network request failed");
        }
    if (last instanceof Error)
        throw last;
    throw nativeError("WX_SHORTLINK_NETWORK_ERROR", "shortlink", "Unable to request wx.login code");
    }
    finally {
        clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener("abort", abort);
        if (!controller.signal.aborted) controller.abort(new Error("WeChat protocol finished"));
        for (const c of createdSockets) c.close();
        createdSockets.clear();
    }
}
