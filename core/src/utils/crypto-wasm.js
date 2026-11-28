const { TsdkRuntime } = require('./tsdk-runtime');

let defaultRuntime = null;

function setRuntime(runtime) {
    if (runtime != null && !(runtime instanceof TsdkRuntime)) {
        throw new TypeError('crypto-wasm runtime must be a TsdkRuntime');
    }
    defaultRuntime = runtime;
}

function getRuntime() {
    if (!defaultRuntime) throw new Error('TSDK runtime has not been configured');
    return defaultRuntime;
}

async function initWasm(runtime = getRuntime()) {
    return runtime.init();
}

async function generateToken(value, runtime = getRuntime()) {
    await initWasm(runtime);
    return runtime.generateToken(value);
}

async function encryptBuffer(buffer, runtime = getRuntime(), isCurrent) {
    await initWasm(runtime);
    if (isCurrent && !isCurrent()) throw new Error('加密请求已取消或运行时世代已变更');
    return runtime.encrypt(buffer);
}

async function decryptBuffer(buffer, runtime = getRuntime()) {
    await initWasm(runtime);
    return runtime.decrypt(buffer);
}

module.exports = {
    setRuntime,
    getRuntime,
    initWasm,
    generateToken,
    encryptBuffer,
    decryptBuffer,
    encryptData: generateToken,
};
