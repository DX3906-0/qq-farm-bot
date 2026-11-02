/**
 * 装扮 / 皮肤服务（skinpb.SkinService）
 *
 * 上游只登记了协议类型（`protos/skinpb.proto` + `tools/audit-capture-compatibility.js` 的抓包实证清单），
 * **没有任何服务或 UI 调用过**；本项目是首个使用者，所以下面两处都是按实跑回包对齐的：
 *
 *   1. `SkinItem.skin_id` **等于 ItemInfo 的 item_id**（例：210016 = 海贝桌椅），
 *      因此名称/图标可以直接用 `getItemById` / `getItemImageById` 补全。
 *   2. `slot_type` 是服务端槽位编号。它 ↔ 部件名（桌椅/门/窗/墙面/地板/屋顶/围栏…）的对应关系
 *      不写死在代码里，而是**用图标名反推**（图标命名稳定：`icon_men02`=门、`icon_skin_fence_11`=围栏），
 *      再把「同一 slot_type 下出现最多的部件名」当作该槽位的中文标签 —— 这样即使游戏新增槽位
 *      也不用改代码，且不会因为枚举值猜错而显示错标签。
 *
 * 写操作只有 `Equip`（换装），仅由面板手动触发；不参与任何自动化，避免误操作改掉用户外观。
 */
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { toNum, log, logWarn } = require('../utils/utils');

const SERVICE = 'gamepb.skinpb.SkinService';

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
function normalizeSkinItem(raw) {
    const skinId = toNum(raw && raw.skin_id);
    const slotType = toNum(raw && raw.slot_type);
    const info = getItemById(skinId) || {};
    const image = getItemImageById(skinId) || '';
    const partName = partNameOfItem(skinId, image);
    // 名称优先级：人工覆盖 > ItemInfo > 图标文件名里的中文 > 「部件 · 编号」兜底
    const name = SKIN_NAME_OVERRIDES[skinId]
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

async function callSkin(method, requestType, payload, timeoutMs) {
    const req = requestType.encode(requestType.create(payload || {})).finish();
    const args = [SERVICE, method, req];
    if (Number(timeoutMs) > 0) args.push(Number(timeoutMs));
    const { body } = await sendMsgAsync(...args);
    return body;
}

/**
 * 换装 RPC 的方法名：上游 proto 里叫 `Equip`，但它**没出现在上游抓包实证清单里**
 * （实证只有 SkinsOwned / SkinsEquipped / GetSkinEffectTypeParams），实测 `Equip` 会静默挂住
 * （游戏服务端对未知方法不回包）。所以这里按候选名依次短超时试，命中后缓存，
 * 以后直接用缓存名——既不用猜死，也不会每次换装都等一大串超时。
 */
const EQUIP_METHOD_CANDIDATES = ['Equip', 'EquipSkin', 'SetSkin', 'Wear', 'SkinEquip', 'ChangeSkin'];
let equipMethodCache = '';

/** 已拥有的装扮（含未装备的） */
async function getSkinsOwned() {
    const body = await callSkin('SkinsOwned', types.SkinsOwnedRequest, {});
    const reply = types.SkinsOwnedReply.decode(body);
    return (reply.skins || []).map(normalizeSkinItem);
}

/** 当前装备（= 当前外观） */
async function getSkinsEquipped() {
    const body = await callSkin('SkinsEquipped', types.SkinsEquippedRequest, {});
    const reply = types.SkinsEquippedReply.decode(body);
    const skins = (reply.skins || []).map(normalizeSkinItem);
    const sel = reply.effect_selection;
    return {
        skins,
        effectSelection: sel ? {
            effectType: toNum(sel.effect_type),
            effectValue: toNum(sel.effect_value),
            enabled: !!sel.enabled,
        } : null,
    };
}

/** 皮肤效果类型参数（部分皮肤带可开关的效果） */
async function getSkinEffectTypeParams() {
    const body = await callSkin('GetSkinEffectTypeParams', types.GetSkinEffectTypeParamsRequest, {});
    const reply = types.GetSkinEffectTypeParamsReply.decode(body);
    return (reply.params || []).map(p => ({
        effectType: toNum(p.effect_type),
        value: toNum(p.params && p.params.value),
    }));
}

/** 标记已查看（消红点），失败不影响主流程 */
async function markSkinsViewed(skinIds) {
    const ids = (Array.isArray(skinIds) ? skinIds : []).map(toNum).filter(n => n > 0);
    if (ids.length === 0) return false;
    await callSkin('MarkAsViewed', types.MarkSkinAsViewedRequest, { skin_ids: ids });
    return true;
}

/**
 * 换装。`slotType` 缺省时自动沿用该皮肤当前所在槽位（从已装备列表推断），
 * 避免调用方必须知道槽位编号。
 */
async function equipSkin(skinId, slotType) {
    const id = toNum(skinId);
    if (id <= 0) throw new Error('无效的装扮ID');

    let slot = toNum(slotType);
    if (slot <= 0) {
        const owned = await getSkinsOwned();
        const hit = owned.find(s => s.skinId === id);
        if (!hit || !hit.slotType) {
            throw new Error(`装扮 ${id} 不在已拥有列表中，无法推断槽位`);
        }
        slot = hit.slotType;
    }

    const methods = equipMethodCache ? [equipMethodCache] : EQUIP_METHOD_CANDIDATES;
    let lastErr = null;
    for (const method of methods) {
        try {
            const body = await callSkin(method, types.EquipSkinRequest,
                { skin_id: id, slot_type: slot }, 6000);
            const reply = types.EquipSkinReply.decode(body);
            const equipped = (reply.skins || []).map(normalizeSkinItem);
            if (!equipMethodCache) {
                equipMethodCache = method;
                logWarn('装扮', `换装方法名已确认: ${method}（上游 proto 名为 Equip，实测服务端只认这个）`, {
                    module: 'skin', event: '换装方法名', result: 'ok',
                });
            }
            log('装扮', `换装成功: skinId=${id} slot=${slot}`, {
                module: 'skin', event: '换装', result: 'ok', skinId: id, slotType: slot,
            });
            return { skinId: id, slotType: slot, equipped, method };
        }
        catch (err) {
            lastErr = err;
            // 只有「无回应/超时」才继续试下一个名字；业务性报错（如参数被拒）直接抛出
            if (!/超时|timeout|timed? ?out/i.test(String(err && err.message || ''))) break;
        }
    }
    throw new Error(`换装失败：服务端未响应（已试 ${methods.join('/')}）${lastErr ? ` · ${lastErr.message}` : ''}`);
}

/**
 * 面板主入口：一次返回「已拥有 + 当前装备 + 槽位标签 + 效果」，
 * 前端按槽位分组渲染、高亮当前装备即可。
 */
async function getSkinOverview() {
    const owned = await getSkinsOwned();

    let equipped = [];
    let effectSelection = null;
    let effectParams = [];
    try {
        const eq = await getSkinsEquipped();
        equipped = eq.skins;
        effectSelection = eq.effectSelection;
    } catch (err) {
        logWarn('装扮', `读取当前装备失败: ${err.message}`, {
            module: 'skin', event: '读取装备', result: 'error',
        });
    }
    try {
        effectParams = await getSkinEffectTypeParams();
    } catch {
        /* 效果参数是可选信息，拿不到不影响面板 */
    }

    const equippedSlots = new Map(equipped.map(s => [s.slotType, s]));
    const equippedIds = new Set(equipped.map(s => s.skinId));

    // 槽位标签：优先用「已装备」里的部件名，其次用「已拥有」统计
    const labels = buildSlotLabels([...equipped, ...owned]);

    const items = owned
        .map(it => ({
            ...it,
            equipped: equippedIds.has(it.skinId),
        }))
        .sort((a, b) => (a.slotType - b.slotType) || (b.equipped - a.equipped) || (a.skinId - b.skinId));

    const slots = [...new Set(items.map(i => i.slotType))]
        .sort((a, b) => a - b)
        .map(slotType => ({
            slotType,
            label: labels.get(slotType) || SLOT_FALLBACK,
            equippedSkinId: equippedSlots.get(slotType)?.skinId || 0,
        }));

    return { slots, items, equipped, effectSelection, effectParams, ownedCount: items.length };
}

module.exports = {
    getSkinOverview,
    getSkinsOwned,
    getSkinsEquipped,
    getSkinEffectTypeParams,
    equipSkin,
    markSkinsViewed,
};
