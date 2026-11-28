'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../gameConfig');
const filename = path.join(root, 'ranch/image-manifest.json');
let manifest = null, stamp = -1;
const verified = new Map();
function image(id, facility = false, expectedResource = '') {
    if (!fs.existsSync(filename)) return null;
    const stat = fs.statSync(filename);
    if (stat.mtimeMs !== stamp) {
        if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('牧场图片来源不能为符号链接');
        manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (manifest.sourceCommit !== '6ac7a3d7930018058d201af86beea8de6a9f8507' || manifest.gameRpcSent !== false) {
            throw new Error('牧场图片来源版本或安全标记未确认');
        }
        stamp = stat.mtimeMs; verified.clear();
    }
    const row = (facility ? manifest.facilities : manifest.items)?.[String(id)];
    if (!row || row.resource !== expectedResource || row.officialOriginVerified !== true || !/^[a-f0-9]{64}$/.test(row.sha256 || '')
        || !/^\/game-config\/[A-Za-z0-9_./-]+\.png$/.test(row.url || '')) return null;
    const relative = row.url.slice('/game-config/'.length);
    if (relative.split('/').includes('..')) return null;
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) return null;
    const fileStat = fs.statSync(file), key = `${file}:${fileStat.mtimeMs}:${fileStat.size}`;
    // Cache the actual file digest, not another manifest row's boolean verdict.
    if (!verified.has(key)) verified.set(key, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    if (verified.get(key) !== row.sha256) return null;
    return { url: row.url, verified: true, role: row.role, label: facility ? '官方设施图标' : '官方道具图标' };
}
module.exports = { image };
