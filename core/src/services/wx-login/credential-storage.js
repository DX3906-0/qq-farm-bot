'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

function conflict(message = '微信凭据已被并发更新，拒绝旧写入') {
    const error = new Error(message);
    error.stage = 'credential_conflict';
    return error;
}

function procStat(text) {
    const match = /^(\d+) \(.*\) ([\s\S]*)$/.exec(String(text).trim());
    const fields = match && match[2].split(/\s+/);
    if (!fields || !/^\d+$/.test(fields[19] || '')) return null;
    return { pid: match[1], startTime: fields[19] };
}

function procScope() {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = fs.readlinkSync('/proc/1/ns/pid');
    // 只接受自身与 /proc 根视角一致的 namespace；跨容器视角未知时不自动回收。
    if (!bootId || pidNamespace !== fs.readlinkSync('/proc/self/ns/pid')) return null;
    return { bootId, pidNamespace };
}

function procIdentity(directory, scope) {
    const stat = procStat(fs.readFileSync(`${directory}/stat`, 'utf8'));
    const status = fs.readFileSync(`${directory}/status`, 'utf8');
    const nspid = /^NSpid:\s*(\d+(?:[ \t]+\d+)*)[ \t]*$/m.exec(status);
    const pids = nspid && nspid[1].split(/\s+/);
    if (!stat || !pids || pids[0] !== stat.pid || fs.readlinkSync(`${directory}/ns/pid`) !== scope.pidNamespace) return null;
    return { ...scope, ...stat, nspid: pids, version: 2 };
}

function lockOwner() {
    let identity = null;
    try {
        const scope = procScope();
        if (scope) {
            const self = procIdentity('/proc/self', scope);
            const visible = self && procIdentity(`/proc/${self.pid}`, scope);
            if (visible && JSON.stringify(self) === JSON.stringify(visible)) identity = self;
        }
    } catch (_) {}
    return { nonce: crypto.randomBytes(16).toString('hex'), identity };
}

function readOwner(lock) {
    try {
        const entries = fs.readdirSync(lock);
        if (entries.length !== 1 || !/^owner-[a-f0-9]{32}\.json$/.test(entries[0])) return null;
        const file = `${lock}/${entries[0]}`;
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (entries[0] !== `owner-${owner.nonce}.json`) return null;
        return { file, owner };
    } catch (_) { return null; }
}

function ownerExited(owner) {
    const identity = owner.identity;
    if (!identity || identity.version !== 2 || !/^[1-9]\d*$/.test(identity.pid) || !/^\d+$/.test(identity.startTime)
        || !Array.isArray(identity.nspid) || identity.nspid[0] !== identity.pid
        || !identity.nspid.every(pid => /^[1-9]\d*$/.test(pid))) return false;
    try {
        const scope = procScope();
        if (!scope || scope.bootId !== identity.bootId || scope.pidNamespace !== identity.pidNamespace) return false;
        const directory = `/proc/${identity.pid}`;
        let stat;
        try { stat = procStat(fs.readFileSync(`${directory}/stat`, 'utf8')); }
        catch (error) { return error.code === 'ENOENT'; }
        const visible = procIdentity(directory, scope);
        // 已验证同一 PID 视角，且启动时刻改变，才能证明旧 owner 退出。
        return !!stat && !!visible && visible.pid === identity.pid && stat.startTime === visible.startTime
            && visible.startTime !== identity.startTime;
    } catch (_) { return false; }
}

function removeOwnedLock(lock, expected) {
    const current = readOwner(lock);
    if (!current || current.file !== expected.file || JSON.stringify(current.owner) !== JSON.stringify(expected.owner)) return false;
    try { fs.unlinkSync(expected.file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // owner 文件名含随机 nonce：并发回收者只有一个能 unlink 成功。
    fs.rmdirSync(lock);
    return true;
}

/** 跨进程临界区；仅回收已确证退出的 owner，未知残锁需部署预检人工处理。 */
function writeWxCredential(file, value, expected) {
    const lock = `${file}.write-lock`;
    for (let attempt = 0; ; attempt++) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const old = readOwner(lock);
            if (attempt !== 0 || !old || !ownerExited(old.owner) || !removeOwnedLock(lock, old)) {
                throw conflict('微信凭据正在更新或存在身份不明的残锁，请检查后重试');
            }
        }
    }
    const owner = lockOwner();
    const owned = { file: `${lock}/owner-${owner.nonce}.json`, owner };
    let temp;
    let fd;
    let ownerCreated = false;
    let ownerReady = false;
    try {
        fd = fs.openSync(owned.file, 'wx', 0o600);
        ownerCreated = true;
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        ownerReady = true;
        let next = value;
        if (expected !== undefined) {
            let current;
            try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch (error) {
                if (expected === null && error.code === 'ENOENT') current = null;
                else throw conflict();
            }
            if (JSON.stringify(current) !== JSON.stringify(expected)) throw conflict();
            next = { ...current, ...value };
        }
        next = { ...next, updatedAt: Date.now() };
        temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(next));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (expected !== undefined) {
            let current;
            try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch (error) {
                if (expected === null && error.code === 'ENOENT') current = null;
                else throw conflict();
            }
            if (JSON.stringify(current) !== JSON.stringify(expected)) throw conflict();
        }
        fs.renameSync(temp, file);
        temp = undefined;
        return next;
    } finally {
        try {
            if (fd !== undefined) fs.closeSync(fd);
            if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
        } finally {
            if (ownerReady) removeOwnedLock(lock, owned);
            else if (ownerCreated) {
                // 初始化写失败时仍由当前调用持锁，清理自己创建的不完整 owner。
                fs.unlinkSync(owned.file);
                fs.rmdirSync(lock);
            }
        }
    }
}

/** 持有独立操作锁直至远端操作真实结算；CAS 写锁不能替代远端副作用的互斥。 */
async function withWxCredentialOperation(file, expected, operation) {
    const lock = `${file}.operation-lock`;
    for (let attempt = 0; ; attempt++) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const old = readOwner(lock);
            if (attempt !== 0 || !old || !ownerExited(old.owner) || !removeOwnedLock(lock, old)) {
                throw conflict('微信凭据有在途操作或身份不明残锁，拒绝并发授权');
            }
        }
    }
    const owner = lockOwner();
    const owned = { file: `${lock}/owner-${owner.nonce}.json`, owner };
    let fd;
    let ownerCreated = false;
    let ownerReady = false;
    try {
        fd = fs.openSync(owned.file, 'wx', 0o600);
        ownerCreated = true;
        fs.writeFileSync(fd, JSON.stringify(owner));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        ownerReady = true;
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) throw conflict();
        return await operation(current);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (ownerReady) removeOwnedLock(lock, owned);
        else if (ownerCreated) { fs.unlinkSync(owned.file); fs.rmdirSync(lock); }
    }
}

module.exports = { writeWxCredential, withWxCredentialOperation };
