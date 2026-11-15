/**
 * 装扮 / 皮肤服务（skinpb.SkinService）
 *
 * 对齐官方 chunks:///_virtual/skinpb.ts（来源摘要见 source）。请求和
 * 当前装备的字段经过独立编码核对；EquipReply 只确认受理，不含外观列表。
 *
 *   1. 官方 `Skin.id` **等于 ItemInfo 的 item_id**（例：201009 = 月光营地小屋），
 *      因此名称/图标可以直接用 `getItemById` / `getItemImageById` 补全。
 *   2. 官方 `skin_type`（面板 slotType）是服务端槽位编号。它 ↔ 部件名（桌椅/门/窗/墙面/地板/屋顶/围栏…）的对应关系
 *      不写死在代码里，而是**用图标名反推**（图标命名稳定：`icon_men02`=门、`icon_skin_fence_11`=围栏），
 *      再把「同一 slot_type 下出现最多的部件名」当作该槽位的中文标签 —— 这样即使游戏新增槽位
 *      也不用改代码，且不会因为枚举值猜错而显示错标签。
 *
 * 写操作仅供手动确认；不参与自动化，读取不会消红点或改变外观。
 */
const { createGameCommandScope, captureSession, validateSession, validation, unknown, positiveId, quantity } = require('./game-command');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { log, logWarn } = require('../utils/utils');
const { util: protobufUtil } = require('protobufjs');

const SERVICE = 'gamepb.skinpb.SkinService';
const EQUIP_METHOD = 'Equip';
const scope = createGameCommandScope('skin');
const source = Object.freeze({ kind: 'official-miniapp', version: '1.16.1.6_20261028',
    module: 'chunks:///_virtual/skinpb.ts', moduleOffset: 6665473,
    gameJsSha256: '3ce682493dde4b8ab56d621eeb27f4aa1b50e802a077997e5fc1bbee8f49072b',
    equipReply: 'empty-acknowledgement', confirmation: 'single-post-write-SkinsEquipped' });

/** 图标名 → 部件中文名（按前缀匹配，顺序有意义：越具体放越前） */
const PART_RULES = [
    [/^icon_zhuoyi/, '桌椅'],
    [/^icon_men/, '门'],
    [/^icon_chuang/, '窗'],
    [/^icon_zhuangshi/, '装饰'],
    [/^icon_qiangmian/, '墙面'],
    [/^icon_diban/, '地板'],
    [/^icon_wuding/, '屋顶'],
    // 场景皮肤：文件名形如 icon_skin_house_11 / img_skin_tower_3（house=小屋、tower=塔/建筑…）
    [/^(?:icon|img)_skin_house/, '小屋'],
    [/^(?:icon|img)_skin_tower/, '塔/建筑'],
    [/^(?:icon|img)_skin_warehouse/, '仓库'],
    [/^(?:icon|img)_skin_board/, '木牌'],
    [/^(?:icon|img)_skin_barrier/, '栅栏'],
    [/^(?:icon|img)_skin_doghouse/, '狗屋'],
    [/^(?:icon|img)_skin_road/, '街道'],
    [/^(?:icon|img)_skin_fence/, '围栏'],
    [/^(?:icon|img)_skin_/, '场景皮肤'],
    [/^img_avatar/, '头像框'],
    [/^img_nameplate|nameplate/, '铭牌'],
];

/** 槽位兜底名（部件名推不出来时用） */
const SLOT_FALLBACK = '其它';

/**
 * 名称人工覆盖表：极少数**老装扮**在游戏服务端已下发的 ItemInfo 里没有条目
 * （服端只下发在售道具的配置，撤档的老装扮查不到名字），图标文件名也没有中文，
 * 此时只能人工从游戏内补。key = skinId，value = 游戏里显示的名字。
 * 例：{ 201010: 'xxx小屋' }
 */
const SKIN_NAME_OVERRIDES = {};

/**
 * 从 item 的 icon_res（Cocos 路径）反推部件名。
 * 例：gui/texture/skinDecorationIcon/icon_zhuoyi02/spriteFrame → 桌椅
 */
function partNameFromIconRes(itemId) {
    const info = getItemById(itemId) || {};
    const iconRes = String(info.icon_res || '');
    const match = iconRes.match(/gui\/texture\/[^/]+\/([^/]+)/);
    if (!match) return '';
    const iconName = match[1];
    for (const [re, label] of PART_RULES) {
        if (re.test(iconName)) return label;
    }
    return '';
}

/**
 * 部件名兜底：很多老装扮在 ItemInfo 里**没有条目**（名字显示成"装扮201009"），
 * 但它们的图标文件名带中文，形如
 *   /game-config/seed_images_named/203009_月光营地栅栏.png
 *   /game-config/seed_images_named/skinDetail/204006_img_skin_tower_3.png（这类没有中文，跳过）
 * 所以再从「图片文件名里出现的关键词」认一遍部件。
 */
const PART_KEYWORDS = [
    '桌椅', '狗屋', '仓库', '木牌', '栅栏', '围栏', '街道', '小屋', '房', '塔',
    '门', '窗', '墙面', '地板', '屋顶', '装饰', '头像框', '铭牌',
];

function partNameFromImage(imageUrl) {
    const raw = String(imageUrl || '');
    if (!raw) return '';
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    }
    catch { /* 非法转义就按原样匹配 */ }
    for (const kw of PART_KEYWORDS) {
        if (decoded.includes(kw)) return kw;
    }
    return '';
}

function partNameOfItem(itemId, imageUrl) {
    return partNameFromIconRes(itemId) || partNameFromImage(imageUrl) || '';
}

/**
 * 名称兜底：ItemInfo 没登记时，从图标文件名 `<itemId>_<中文名>.png` 里取中文名。
 * 取不到就退回「装扮<id>」。
 */
function nameFromImage(itemId, imageUrl) {
    const raw = String(imageUrl || '');
    const match = raw.match(/\/(\d+)_([^/]+)\.png$/i);
    if (match && Number(match[1]) === Number(itemId)) {
        const decoded = decodeURIComponent(match[2]);
        if (/[\u4e00-\u9fa5]/.test(decoded)) return decoded;
    }
    return '';
}

/** 归一化单条皮肤（补名称/图标/部件名） */
function normalizeSkinItem(raw, allowDefault = false) {
    const rawId = raw && raw.id;
    const skinId = allowDefault && rawId != null && typeof rawId !== 'boolean' && String(rawId) === '0'
        ? 0 : positiveId(rawId, '装扮编号');
    const slotType = positiveId(raw && raw.skin_type, '装扮槽位');
    const info = getItemById(skinId) || {};
    const image = getItemImageById(skinId) || '';
    const partName = partNameOfItem(skinId, image);
    // 名称优先级：人工覆盖 > ItemInfo > 图标文件名里的中文 > 「部件 · 编号」兜底
    const name = (skinId === 0 ? '默认外观' : SKIN_NAME_OVERRIDES[skinId])
        || info.name
        || nameFromImage(skinId, image)
        || (partName ? `${partName}（未命名 ${skinId}）` : `装扮${skinId}`);
    return {
        skinId,
        slotType,
        isNew: !!(raw && raw.is_new),
        name,
        image,
        partName,
        desc: info.desc || '',
        expireTime: quantity(raw && raw.expire_time),
        partIds: (raw && raw.part_ids || []).map(id => positiveId(id, '装扮部件编号')),
    };
}

/** 给每个 slot_type 推定中文标签：该槽位下出现最多的部件名 */
function buildSlotLabels(items) {
    const counter = new Map(); // slotType -> Map<partName, count>
    for (const it of items) {
        if (!it.partName) continue;
        if (!counter.has(it.slotType)) counter.set(it.slotType, new Map());
        const m = counter.get(it.slotType);
        m.set(it.partName, (m.get(it.partName) || 0) + 1);
    }
    const labels = new Map();
    for (const [slotType, m] of counter.entries()) {
        let best = '';
        let bestN = -1;
        for (const [name, n] of m.entries()) {
            if (n > bestN) { best = name; bestN = n; }
        }
        labels.set(slotType, best);
    }
    return labels;
}

function decodeSkins(values, uniqueSlots = false) {
    if (!Array.isArray(values)) throw validation('装扮列表结构无效', 'SKIN_INCOMPLETE_REPLY');
    const skins = values.map(raw => normalizeSkinItem(raw, uniqueSlots));
    const identities = skins.map(item => uniqueSlots ? item.slotType : `${item.slotType}:${item.skinId}`);
    if (new Set(identities).size !== identities.length) {
        throw validation(uniqueSlots ? '当前装扮槽位存在冲突，请刷新核对' : '装扮列表编号重复', 'SKIN_STATE_CONFLICT');
    }
    return skins;
}

async function readOwned(session) {
    const reply = await scope.rpc(session, SERVICE, 'SkinsOwned', 'SkinsOwnedRequest', 'SkinsOwnedReply', {}, { allowEmpty: true });
    return decodeSkins(reply.skins || []);
}

async function readEquipped(session) {
    const reply = await scope.rpc(session, SERVICE, 'SkinsEquipped', 'SkinsEquippedRequest', 'SkinsEquippedReply', {}, { allowEmpty: true });
    return {
        skins: decodeSkins(reply.skins || [], true),
        activeSetEffects: (reply.active_set_effects || []).map(effect => ({
            // Zero/default effect values are valid protobuf data, not proof
            // of a missing equipment list. Preserve them without inventing buffs.
            setId: Number(quantity(effect.set_id)),
            effectType: Number(quantity(effect.effect_type)),
            enabled: effect.is_active === true,
        })),
    };
}

async function readEffects(session) {
    const reply = await scope.rpc(session, SERVICE, 'GetSkinEffectTypeParams', 'GetSkinEffectTypeParamsRequest', 'GetSkinEffectTypeParamsReply', {}, { allowEmpty: true });
    return Object.entries(reply.effect_type_params || {}).map(([effectType, params]) => ({
        // protobufjs represents decoded int64 map keys as 8-byte hashes.
        effectType: positiveId(/^\d+$/.test(effectType) ? effectType : protobufUtil.longFromHash(effectType, false).toString(), '装扮效果类型'),
        value: quantity(params && params.param1_int),
    }));
}

/** Reads preserve one captured account/connection context. Empty lists are valid,
 * but never imply that a preceding mutation was applied. */
async function getSkinsOwned() { return readOwned(captureSession()); }
async function getSkinsEquipped() { return readEquipped(captureSession()); }
async function getSkinEffectTypeParams() { return readEffects(captureSession()); }

/** Manual-only red-dot acknowledgement; no overview/animation calls this. */
async function markSkinsViewed(skinIds) {
    const ids = (Array.isArray(skinIds) ? skinIds : []).map(id => positiveId(id, '装扮编号'));
    if (!ids.length) return false;
    return scope.execute(async session => {
        const key = `viewed:${[...new Set(ids)].sort((a, b) => a - b).join(',')}`;
        await scope.rpc(session, SERVICE, 'MarkAsViewed', 'MarkSkinAsViewedRequest', 'MarkSkinAsViewedReply', { skin_ids: ids }, { write: true, key, allowEmpty: true });
        scope.confirm(session, key);
        return true;
    });
}

/** A single verified Equip write, followed by exactly one fresh read of current
 * equipment. Never probe another method or retry a write after an unknown result. */
async function equipSkin(skinId, slotType, expected = {}) {
    const id = positiveId(skinId, '装扮编号');
    const requestedSlot = slotType == null || slotType === 0 ? null : positiveId(slotType, '装扮槽位');
    if (expected.confirmed !== true) throw validation('请确认更换装扮');
    return scope.execute(async session => {
        const owned = await readOwned(session);
        const target = owned.find(item => item.skinId === id && (requestedSlot === null || item.slotType === requestedSlot));
        if (!target) throw validation('该装扮不在当前账号已拥有列表或槽位已变化', 'SKIN_NOT_OWNED');
        const slot = target.slotType;
        const key = `skin:${slot}`;
        if (scope.blocked(session, key)) throw unknown('该装扮槽位存在未确认操作，请只刷新核对，禁止重放');
        if (BigInt(target.expireTime) > 0n && BigInt(target.expireTime) * 1000n <= BigInt(Date.now())) {
            throw validation('该装扮已过期，请刷新核对', 'SKIN_EXPIRED');
        }
        const before = await readEquipped(session);
        const currentId = before.skins.find(item => item.slotType === slot)?.skinId || 0;
        if (expected.expectedEquippedSkinId != null) {
            const value = expected.expectedEquippedSkinId;
            if (typeof value === 'boolean' || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0
                || Number(value) !== currentId) throw validation('当前外观已变化，请刷新后重新确认', 'SKIN_STATE_CHANGED');
        }
        if (currentId === id) return { skipped: true, reason: 'already_in_target_state', accountId: session.accountId, skinId: id, slotType: slot };

        await scope.rpc(session, SERVICE, EQUIP_METHOD, 'EquipSkinRequest', 'EquipSkinReply',
            { id: String(id), skin_type: String(slot) }, { write: true, key, allowEmpty: true });
        const current = await readEquipped(session);
        if (current.skins.find(item => item.slotType === slot)?.skinId !== id) {
            throw Object.assign(unknown('换装已提交，但当前装备未确认目标；请只刷新核对，不要重复操作'), {
                errorCode: 'SKIN_RESULT_UNCONFIRMED', stage: 'readback',
            });
        }
        validateSession(session);
        scope.confirm(session, key);
        log('装扮', `换装已确认: skinId=${id} slot=${slot}`, {
            module: 'skin', event: '换装', result: 'ok', skinId: id, slotType: slot,
        });
        return { accountId: session.accountId, skinId: id, slotType: slot,
            equipped: current.skins, activeSetEffects: current.activeSetEffects,
            method: EQUIP_METHOD, source, resultState: 'completed', confirmation: 'SkinsEquipped', retryable: false };
    });
}

/**
 * 面板主入口：一次返回「已拥有 + 当前装备 + 槽位标签 + 效果」，
 * 前端按槽位分组渲染、高亮当前装备即可。
 */
async function getSkinOverview() {
    const session = captureSession();
    const owned = await readOwned(session);
    const current = await readEquipped(session);
    const equipped = current.skins;
    const activeSetEffects = current.activeSetEffects;
    let effectParams = [];
    const warnings = [];
    try {
        effectParams = await readEffects(session);
    } catch (error) {
        const code = error?.errorCode || error?.code;
        if (code === 'REQUEST_CANCELLED' || code === 'REQUEST_DEADLINE' || code === 'CANCELLED') throw error;
        warnings.push('装扮效果参数暂不可用');
        logWarn('装扮', '读取可选效果参数失败', { module: 'skin', event: '读取效果', result: 'warn', errorCode: code });
    }

    validateSession(session);
    const equippedSlots = new Map(equipped.map(s => [s.slotType, s]));

    // 槽位标签：优先用「已装备」里的部件名，其次用「已拥有」统计
    const labels = buildSlotLabels([...equipped, ...owned]);

    const items = owned
        .map(it => ({
            ...it,
            equipped: equippedSlots.get(it.slotType)?.skinId === it.skinId,
            resultUnknown: scope.blocked(session, `skin:${it.slotType}`),
        }))
        .sort((a, b) => (a.slotType - b.slotType) || (b.equipped - a.equipped) || (a.skinId - b.skinId));

    const slots = [...new Set(items.map(i => i.slotType))]
        .sort((a, b) => a - b)
        .map(slotType => ({
            slotType,
            label: labels.get(slotType) || SLOT_FALLBACK,
            equippedSkinId: equippedSlots.get(slotType)?.skinId || 0,
            resultUnknown: scope.blocked(session, `skin:${slotType}`),
        }));

    return { accountId: session.accountId, source, slots, items, equipped, activeSetEffects,
        effectSelection: null, effectParams, warnings, stateKnown: true, ownedCount: items.length };
}

module.exports = {
    getSkinOverview,
    getSkinsOwned,
    getSkinsEquipped,
    getSkinEffectTypeParams,
    equipSkin,
    markSkinsViewed,
    normalizeSkinItem,
    source,
};
