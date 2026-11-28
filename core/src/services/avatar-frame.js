'use strict';

const fs = require('node:fs');
const { getResourcePath } = require('../config/runtime-paths');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { createGameCommandScope, captureSession, validateSession, validation, unknown, positiveId, own } = require('./game-command');

const SERVICE = 'gamepb.avatarframepb.AvatarFrameService';
const scope = createGameCommandScope('avatar-frame');
const FRAME_TYPES = [1, 2];
const DEFAULT_IDS = { 1: 101, 2: 401000 };
const source = Object.freeze({ kind: 'official-miniapp', version: '1.16.1.6_20261028',
    module: 'chunks:///_virtual/avatarframepb.ts', moduleOffset: 2019674,
    manager: 'chunks:///_virtual/AvatarFrameManager.ts', managerOffset: 2012080,
    gameJsSha256: '3ce682493dde4b8ab56d621eeb27f4aa1b50e802a077997e5fc1bbee8f49072b',
    equippedMethod: 'AvatarFramesEquiped', selection: 'unique-highest-priority-per-type' });
let catalogCache;
function artworkImage(item) {
    const resource = String(item.icon_res || '').replace(/\/(?:spriteFrame|texture)$/, '');
    const name = resource.split('/').filter(Boolean).pop();
    if (resource.startsWith('gui/texture/') && name && /^[\w-]+$/.test(name)
        && fs.existsSync(getResourcePath('gameConfig', 'deco_icons', `${name}.png`))) {
        return `/game-config/deco_icons/${name}.png`;
    }
    return getItemImageById(Number(item.id)) || '';
}
function catalog() {
    if (!catalogCache) {
        const raw = JSON.parse(fs.readFileSync(getResourcePath('gameConfig', 'ItemInfo.json'), 'utf8'));
        // The three legacy prototype items have no art. Preserve any real
        // server-owned unknown ID separately, rather than inventing a catalog.
        catalogCache = (Array.isArray(raw) ? raw : Object.values(raw)).filter(item => Number(item.type) === 10
            && /头像框|铭牌/.test(String(item.name || '')) && item.icon_res).map(item => ({
            itemId: Number(item.id), frameId: Number(item.target_id) > 0 ? Number(item.target_id) : Number(item.id),
            frameType: /铭牌/.test(item.name) ? 2 : 1, name: String(item.name), desc: String(item.desc || ''),
            image: artworkImage(item), owned: false, equipped: null,
        }));
    }
    return catalogCache.map(item => ({ ...item }));
}
function frameDto(raw, requestedType) {
    const frameId = positiveId(raw.id, '头像挂件编号');
    // The server uses the decoration ID, not the inventory item ID. E.g.
    // item 2130 -> decoration 301. Never match the item ID as another frame ID.
    const config = catalog().find(item => item.frameId === frameId);
    const rawType = Number(raw.type);
    if (own(raw, 'type') && rawType !== 0 && !FRAME_TYPES.includes(rawType)) {
        throw validation('头像挂件类型无效', 'FRAME_INCOMPLETE_REPLY');
    }
    const frameType = config?.frameType || (FRAME_TYPES.includes(rawType) ? rawType
        : requestedType || (frameId >= DEFAULT_IDS[2] ? 2 : 1));
    if (requestedType && frameType !== requestedType || rawType > 0 && rawType !== frameType) {
        throw validation('头像挂件回包类型与请求不一致', 'FRAME_INCOMPLETE_REPLY');
    }
    const item = getItemById(config?.itemId || frameId);
    const priority = Number(raw.priority || 0);
    if (!Number.isInteger(priority) || priority < -2147483648 || priority > 2147483647) {
        throw validation('头像挂件优先级无效', 'FRAME_INCOMPLETE_REPLY');
    }
    return { ...(config || {}), frameId, itemId: config?.itemId || frameId, frameType,
        name: config?.name || item?.name || (frameId === DEFAULT_IDS[frameType]
            ? frameType === 1 ? '默认头像' : '无铭牌' : `挂件${frameId}`),
        desc: config?.desc || item?.desc || '', image: config?.image || getItemImageById(config?.itemId || frameId) || '',
        owned: true, equipped: null, stateKnown: false, priority,
        count: own(raw, 'count') ? String(raw.count) : null, isNew: raw.is_new === true,
        rawExpiry: own(raw, 'expire_time') ? String(raw.expire_time) : null };
}
function decodeFrames(values, requestedType) {
    if (!Array.isArray(values)) throw validation('头像挂件列表结构无效', 'FRAME_INCOMPLETE_REPLY');
    const rows = values.map(raw => frameDto(raw, requestedType));
    if (new Set(rows.map(item => item.frameId)).size !== rows.length) {
        throw validation('头像挂件列表编号重复，不能操作', 'FRAME_INCOMPLETE_REPLY');
    }
    return rows;
}
function equippedState(rows) {
    return FRAME_TYPES.map(frameType => {
        const entries = rows.filter(item => item.frameType === frameType);
        const candidates = entries.filter(item => item.frameId !== DEFAULT_IDS[frameType]);
        if (!candidates.length) return { frameType, equippedIds: [], equippedId: 0, stateKnown: true, warning: '' };
        // Official AvatarFrameManager.getEquippedFrameId filters out the default
        // decoration and picks maximum priority. Equal maxima are ambiguous:
        // don't pick the first row or label every ownership count=1 as worn.
        const maximum = Math.max(...candidates.map(item => item.priority));
        const highest = candidates.filter(item => item.priority === maximum);
        if (highest.length !== 1) return { frameType, equippedIds: [], equippedId: 0, stateKnown: false,
            warning: `${frameType === 1 ? '头像框' : '铭牌'}当前佩戴列表存在同优先级冲突，请刷新核对；不猜测当前款式。` };
        return { frameType, equippedIds: [highest[0].frameId], equippedId: highest[0].frameId, stateKnown: true, warning: '' };
    });
}
async function readOwned(session, frameType) {
    const reply = await scope.rpc(session, SERVICE, 'AvatarFramesOwned', 'AvatarFramesOwnedRequest', 'AvatarFramesOwnedReply',
        { type: frameType }, { allowEmpty: true });
    return decodeFrames(reply.avatar_frames || [], frameType);
}
async function readEquipped(session) {
    const reply = await scope.rpc(session, SERVICE, 'AvatarFramesEquiped', 'AvatarFramesEquipedRequest', 'AvatarFramesEquipedReply',
        {}, { allowEmpty: true });
    const rows = decodeFrames(reply.avatar_frames || []);
    return { rows, states: equippedState(rows) };
}
async function snapshot(session) {
    const owned = [];
    for (const type of FRAME_TYPES) owned.push(...await readOwned(session, type));
    const current = await readEquipped(session);
    validateSession(session);
    const items = catalog();
    // An equipped-only entry is still owned, even if the ownership snapshot
    // lagged. Prefer its genuine art/ID but never infer equipment from count.
    for (const frame of [...current.rows, ...owned]) {
        if (frame.frameId === DEFAULT_IDS[frame.frameType]) continue;
        const index = items.findIndex(item => item.frameId === frame.frameId && item.frameType === frame.frameType);
        if (index >= 0) items[index] = frame;
        else items.push(frame);
    }
    const groups = current.states.map(state => ({ ...state, label: state.frameType === 1 ? '头像框' : '铭牌',
        items: items.filter(item => item.frameType === state.frameType).map(item => ({ ...item,
            equipped: state.stateKnown ? item.frameId === state.equippedId : null,
            stateKnown: state.stateKnown, resultUnknown: scope.blocked(session, `frame:${state.frameType}`) })) }));
    return { accountId: session.accountId, source, groups, warning: current.states.map(item => item.warning).filter(Boolean).join('\n') };
}
async function getAvatarFrames() { return snapshot(captureSession()); }
async function operateAvatarFrame(action, input = {}) {
    if (!['equip', 'unequip'].includes(action)) throw validation('未知的头像挂件操作');
    const frameId = positiveId(input.frameId, '头像挂件编号');
    const frameType = positiveId(input.frameType, '头像挂件类型');
    if (!FRAME_TYPES.includes(frameType) || input.confirmed !== true) throw validation('请确认头像框或铭牌操作');
    return scope.execute(async session => {
        const key = `frame:${frameType}`;
        if (scope.blocked(session, key)) throw unknown('该挂件栏存在未确认操作，请只刷新核对，禁止重放');
        const before = await readOwned(session, frameType);
        const target = before.find(item => item.frameId === frameId);
        if (!target) throw validation('该挂件不在当前账号已拥有列表中', 'FRAME_NOT_OWNED');
        const current = (await readEquipped(session)).states.find(item => item.frameType === frameType);
        if (!current.stateKnown) throw validation('当前佩戴列表存在冲突，请刷新核对后再操作', 'FRAME_STATE_CONFLICT');
        if ((action === 'equip' && current.equippedId === frameId) || (action === 'unequip' && current.equippedId !== frameId)) {
            return { skipped: true, reason: 'already_in_target_state', accountId: session.accountId };
        }
        if (Array.isArray(input.expectedEquippedIds)) {
            const expected = input.expectedEquippedIds.map(id => positiveId(id)).sort((a, b) => a - b);
            if (expected.length > 1 || JSON.stringify(current.equippedIds) !== JSON.stringify(expected)) {
                throw validation('当前佩戴状态已变化，请刷新后确认');
            }
        }
        // Official equipFrame(): first nameplate -> Equip; changing an existing
        // slot (including default avatar 101) -> UpdateEquip; removal -> Unequip.
        // Choose BEFORE sending. A failure never triggers another method/write.
        const method = action === 'unequip' ? 'Unequip' : frameType === 2 && !current.equippedId ? 'Equip' : 'UpdateEquip';
        const params = method === 'UpdateEquip'
            ? { current_id: String(current.equippedId || DEFAULT_IDS[frameType]), new_id: String(frameId) }
            : { id: String(frameId) };
        const reply = await scope.rpc(session, SERVICE, method, `AvatarFrame${method}Request`, `AvatarFrame${method}Reply`,
            params, { write: true, key, allowEmpty: true });
        const proves = state => state?.stateKnown && (action === 'equip' ? state.equippedId === frameId : state.equippedId !== frameId);
        const rows = decodeFrames(reply.equip_avatar_frames || []);
        let proof = rows.length ? equippedState(rows).find(item => item.frameType === frameType) : null;
        if (!proves(proof)) proof = (await readEquipped(session)).states.find(item => item.frameType === frameType);
        if (!proves(proof)) throw unknown('挂件更换结果未被服务端当前佩戴列表确认，请只刷新核对，不要重提');
        scope.confirm(session, key);
        const result = { accountId: session.accountId, frameId, frameType, action, resultState: 'completed', retryable: false };
        try { return { ...result, snapshot: await snapshot(session) }; }
        catch (cause) { validateSession(session); return { ...result, refreshRequired: true }; }
    });
}

module.exports = { getAvatarFrames, operateAvatarFrame, frameDto, equippedState, catalog, SERVICE, source };
