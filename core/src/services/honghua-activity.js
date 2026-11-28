/**
 * 公益小红花活动服务（移植自 Aoluis1005/QQ-farm-BOT-GO，活动 ID 2026090901）
 *
 * 活动说明（腾讯官方）：
 *   - 活动时间：2026-09-01 ~ 2026-09-09
 *   - 核心玩法：收获小红花果实 → 获得爱心值 → 送爱心值 / 送公益金；
 *     累计爱心值达 30/60/90/120/150 五档领奖；分享得奖励；全服公益目标进度。
 *
 * 协议（Go 项目 Aoluis1005/QQ-farm-BOT-GO 2026-09-02 线上实测实锤，proto 手写编码）：
 *   ActivityService.Operate {
 *     f1 = activity_id (2026090901)
 *     f2 = cmd
 *     f<cmd+99> = 扩展参数子消息（必带，缺失一律「活动参数错误」）
 *   }
 *   cmd: 35=领小红花种子 36=送爱心值 37=领爱心值档位(f136={f1=阈值}) 38=送公益金(真实 1 元扣款!)
 *   ⚠️ cmd=39 领档位是【错误结论】：线上实测它只是查询类操作，静默空回包（f139={f1:1}），
 *      永远不发放奖励 —— 2026-09-03 已把档位领取从 39 改回 37（含 f136 扩展块 + 回包 f137 奖励解析）。
 *
 * 注意：送公益金 cmd=38 是【真实 1 元微信扣款】，单账号活动期仅 1 次资格。
 *   本服务后端加内存防重，但绝不接入任何自动任务；前端按钮默认禁用并明确警示。
 *
 * 进度解析（2026-09-01 实测打通）：公益块挂在活动子节点的 f116 上，我方 proto 未定义该字段，
 *   改用通用 protobuf wire 扫描（scanProtoMessage）解析原始回包，字段含义见 pickHonghuaProgress。
 */
const protobuf = require('protobufjs/minimal');
const { types } = require('../utils/proto');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { toNum, toLong } = require('../utils/utils');
const { createModuleLogger } = require('./logger');

const honghuaLogger = createModuleLogger('honghua');

const HONGHUA_ACTIVITY_ID = 2026090901;

const CMD = {
  CLAIM_SHARE: 35, // 领小红花种子（每日分享/任务奖励，空参）
  DONATE_LOVE: 36, // 送爱心值（需先收获小红花果实，否则服务器返回"爱心不足"）
  DONATE_FUND: 38, // 送公益金（真实 1 元扣款！单账号活动期仅 1 次）
  CLAIM_TIERS: 37, // 领爱心值档位奖励，扩展 f136={f1=阈值}，一次领一档；回包 f137={f1=阈值, f2={f1=物品id, f2=数量}}
  // ⚠️ 39 是查询类操作（静默空回包 f139={f1:1}），不是领取，勿再使用。
};

// 已捐赠公益金的账号（内存防重，worker 长驻进程内有效；重启后清空，由前端二次确认兜底）
const honghuaFundDonatedByAccount = new Set();

// 手写 ActivityService.Operate 请求（对齐 Go：f1=id, f2=cmd, f<cmd+99>={} 空子消息）
function encodeHonghuaOperate(activityId, cmd, extPayloadBytes) {
  const writer = protobuf.Writer.create();
  writer.uint32(8).int64(toLong(toNum(activityId))); // field 1 = activity_id
  writer.uint32(16).int64(toLong(toNum(cmd))); // field 2 = cmd
  const extFieldNo = toNum(cmd) + 99;
  const extTag = (extFieldNo << 3) | 2; // length-delimited 扩展块
  writer.uint32(extTag);
  if (extPayloadBytes && extPayloadBytes.length) {
    writer.bytes(extPayloadBytes);
  } else {
    writer.fork().ldelim(); // 空子消息（length = 0），必带
  }
  return writer.finish();
}

// 手写 ActivityService.GetGroup 请求（f1 = activity_id）
function encodeHonghuaGetGroup(activityId) {
  const writer = protobuf.Writer.create();
  writer.uint32(8).int64(toLong(toNum(activityId))); // field 1 = id
  return writer.finish();
}

function isAlreadyClaimedError(err) {
  const message = String(err?.message || err || '');
  return message.includes('已领取')
    || message.includes('已经领取')
    || message.includes('重复')
    || message.includes('already')
    || message.includes('1009001')
    || message.includes('爱心值档位')
    || message.includes('已领');
}

// ActivityNode 中我方 proto 已定义的字段号，其余视为未知扩展块（小红花公益块在其中）
const KNOWN_NODE_FIELDS = new Set([1, 2, 101, 102, 105, 110, 112, 113, 117, 118]);

/**
 * 通用 protobuf wire-format 扫描（不依赖 .proto 定义）
 * 把原始字节解析成 { f<字段号>: 值 | 子对象 | 数组 }，用于解析未定义的活动扩展块。
 */
function scanProtoMessage(buf, depth = 0) {
  const out = {};
  if (!buf || !buf.length || depth > 6) return out;
  const reader = protobuf.Reader.create(buf);
  try {
    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (!field) break;
      let value;
      if (wire === 0) value = toNum(reader.uint64());
      else if (wire === 1) value = toNum(reader.fixed64());
      else if (wire === 5) value = reader.fixed32();
      else if (wire === 2) {
        const bytes = Buffer.from(reader.bytes());
        // 先判断是否为合法可打印 UTF-8 文本（中文字节也能被误当子消息解析，故文本优先）
        const text = bytes.toString('utf8');
        // eslint-disable-next-line no-control-regex
        const printable = bytes.length > 0 && !/[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(text);
        if (printable) {
          value = text.length > 60 ? `str(${text.length}):${text.slice(0, 60)}` : text;
        } else {
          const sub = scanProtoMessage(bytes, depth + 1);
          value = Object.keys(sub).length
            ? sub
            : `hex:${bytes.toString('hex').slice(0, 120)}`;
        }
      } else {
        break; // group（wire 3/4）不支持
      }
      const key = `f${field}`;
      if (out[key] === undefined) out[key] = value;
      else if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    }
  } catch {
    // 尽力解析，遇到无法识别的结构就返回已解析部分
  }
  return out;
}

/** 递归收集活动树各 ActivityNode 上 proto 未定义的扩展块（进度可能挂在子节点） */
function collectUnknownNodeBlocks(node, path = 'group', out = {}) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    const fieldNo = Number(key.slice(1));
    if (fieldNo === 1) continue; // activity（ActivityInfo，无进度）
    if (fieldNo === 2) { // children
      const children = Array.isArray(value) ? value : [value];
      children.forEach((child, idx) => collectUnknownNodeBlocks(child, `${path}.c${idx}`, out));
      continue;
    }
    if (KNOWN_NODE_FIELDS.has(fieldNo)) continue;
    if (value && typeof value === 'object') out[`${path}.${key}`] = value;
  }
  return out;
}

/**
 * 公益块（ActivityNode.f116）字段含义（2026-09-01 用账号真实回包 + 官方活动规则比对确认）：
 *   f3  = 个人**累计已送出**的爱心值（f1 为公共基准值，三个账号相同，非个人累计）
 *         2026-09-02 实测：只有"送爱心值"成功后才累加，收获小红花果实不会让它增长；
 *         一次送出可 +46（数额取决于已收获果实积累量，并非固定 +2）。
 *         因此它可用于档位（30/60/90/120/150）达标判定，但**不能**用来判断"当前是否有爱心值可送"——
 *         从未送过的账号恒为 0，若据此门控自动送爱心值会永久跳过（死锁）。
 *   f4  = 全服累计爱心值    f5  = 全服公益目标（10 亿）
 *   f7  = 持有的小红花道具 {id, count}
 *   f9  = 爱心值档位列表 [{ f1: 档位, f2: 奖励道具, f3: 领取状态 }]，实测 30/60/90/120/150
 *         奖励依次为 有机化肥8h*1 / 点券*50 / 有机化肥8h*2 / 点券*100 / 头像框*1（与官方规则一致）
 *         f3 = 领取状态：1=已领取（领取后由 0/缺失置 1），0/缺失=未领取
 *   f10 = 全服目标礼包 { f1: 目标值, f2: 礼包道具 }   f12 = 全服结算礼包道具（101604）
 *   f13 = 结算时间戳（= 活动结束时间）
 *   f21 = 每日公益礼包道具（化肥1小时 * 2，与官方规则一致）
 *   f6 / f11 / f17 语义未确认，原样放入 extra，不参与展示
 */
function pickHonghuaProgress(unknownBlocks) {
  const entries = Object.entries(unknownBlocks || {});
  if (!entries.length) return null;
  // 公益块固定挂在活动子节点的 f116 上，找不到时退回第一个未知块
  const entry = entries.find(([key]) => key.endsWith('.f116')) || entries[0];
  const block = entry && entry[1];
  if (!block || typeof block !== 'object') return null;

  const num = v => (typeof v === 'number' ? v : 0);
  const item = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const id = num(v.f1);
    if (!id) return null;
    return { id, count: num(v.f2) || 1 };
  };

  const loveValue = num(block.f3);
  const serverProgress = num(block.f4);
  const serverGoal = num(block.f5) || num(block.f10 && block.f10.f1);
  const tierSource = Array.isArray(block.f9) ? block.f9 : (block.f9 ? [block.f9] : []);
  const tiers = tierSource
    .map((t) => {
      const tier = num(t && t.f1);
      if (!tier) return null;
      return {
        tier,
        reward: item(t && t.f2),
        reached: loveValue >= tier,
        // f9 档位块 f3 语义未定：Go 版注释称 1=已领取，但用户 2026-09-03 在官方小程序看到
        // 30/60 档（f3=1）仍显示未领取 → 也可能是"达标可领取"。两种解读冲突，
        // 故不据此判定 claimed/过滤领取；一律按 reached 尝试 cmd=37，以回包 f137 奖励判定到账。
        claimed: false,
        flag3: num(t && t.f3),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.tier - b.tier);

  return {
    loveValue,
    serverProgress,
    serverGoal,
    serverPercent: serverGoal > 0 ? Math.min(100, (serverProgress / serverGoal) * 100) : 0,
    tiers,
    dailyGift: item(block.f21),
    serverGift: item(block.f12) || item(block.f10 && block.f10.f2),
    holdingItem: item(block.f7),
    settleTime: num(block.f13),
    fundDonated: false,
    extra: { f6: num(block.f6), f11: num(block.f11), f17: num(block.f17) },
  };
}

async function operateHonghua(cmd, extPayloadBytes) {
  const payload = encodeHonghuaOperate(HONGHUA_ACTIVITY_ID, cmd, extPayloadBytes);
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', payload, 20000);
  return body;
}

// 编码档位领取的扩展块：{ field1 = 档位阈值(30/60/90/120/150) }
// 对齐 Go 版 Aoluis1005/QQ-farm-BOT-GO 2026-09-02 线上实测：cmd=37 领档位时扩展块
// f136 内带 field1=阈值，一次领一个档位，靠阈值参数区分；不带阈值返回「活动参数错误」。
// （扩展块字段号由 encodeHonghuaOperate 按 cmd+99 自动计算：37→136 ✓）
function encodeTierExt(threshold) {
  const writer = protobuf.Writer.create();
  writer.uint32(8).int64(toLong(toNum(threshold))); // field 1 = 档位阈值
  return writer.finish();
}

// 从 Operate 响应体解析档位领取奖励块。
// cmd=37 领档位的奖励在响应扩展块 f137（= cmd + 100）里：{ f1=阈值回显, f2={ f1=物品id, f2=数量 } }。
// 递归查找以兼容不同包裹层（对齐 Go 版 honghuaParseTierReward）。解析到奖励才说明真正领取成功。
function parseTierRewardField(body, extFieldNo) {
  const out = [];
  if (!body || !body.length) return out;
  const target = `f${extFieldNo != null ? extFieldNo : CMD.CLAIM_TIERS + 100}`; // 默认 f137
  const find = (buf, depth = 0) => {
    if (depth > 6) return null;
    const tree = scanProtoMessage(buf);
    for (const [key, value] of Object.entries(tree)) {
      if (key === target && value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const hit = find(value, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const blk = find(body);
  if (!blk) return out;
  const items = blk.f2;
  const list = Array.isArray(items) ? items : (items ? [items] : []);
  for (const it of list) {
    if (it && typeof it === 'object') {
      const id = toNum(it.f1);
      if (id > 0) out.push({ id, count: toNum(it.f2) || 1 });
    }
  }
  return out;
}

async function getHonghuaActivity() {
  try {
    const payload = encodeHonghuaGetGroup(HONGHUA_ACTIVITY_ID);
    const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', payload, 20000);
    const raw = Buffer.from(body || []);

    // 已定义字段走 proto 解码（拿服务器真实标题/状态），未定义的公益块走通用 wire 扫描
    let title = '公益小红花';
    try {
      const decoded = types.ActivityGetGroupReply.decode(raw);
      const info = decoded?.group?.activity;
      if (info?.title) title = String(info.title);
    } catch {
      // proto 解码失败不影响下面的通用扫描
    }

    const tree = scanProtoMessage(raw);
    const group = tree.f1 && typeof tree.f1 === 'object' && !Array.isArray(tree.f1) ? tree.f1 : null;
    const unknownBlocks = collectUnknownNodeBlocks(group);
    const progress = pickHonghuaProgress(unknownBlocks);

    const result = {
      title,
      activityId: HONGHUA_ACTIVITY_ID,
      available: true,
      progress,
      fundDonated: progress ? !!progress.fundDonated : honghuaFundDonatedByAccount.size > 0,
      warning: progress
        ? undefined
        : '进度详情暂不可用（服务器未在活动信息里返回公益进度，操作功能正常）。送爱心值需先收获小红花果实。',
    };
    if (!progress) {
      // 解析失败时带回结构摘要，便于活动改版后快速定位新字段
      result.debugTree = JSON.stringify(unknownBlocks).slice(0, 6000);
    }
    return result;
  } catch (err) {
    const message = String(err?.message || err || '');
    honghuaLogger.warn(`getHonghuaActivity 失败: ${message}`);
    return {
      title: '公益小红花',
      activityId: HONGHUA_ACTIVITY_ID,
      available: false,
      warning: `活动状态获取失败：${message}`,
    };
  }
}

async function donateHonghuaLove() {
  try {
    await operateHonghua(CMD.DONATE_LOVE);
    return { ok: true, message: '送爱心值成功（若提示爱心不足，请先收获小红花果实）' };
  } catch (err) {
    const message = String(err?.message || err || '');
    if (message.includes('爱心不足') || message.includes('收获')) {
      return { ok: false, code: 'NO_LOVE', message: '爱心值不足：请先在农场收获小红花果实' };
    }
    if (isAlreadyClaimedError(err)) {
      return { ok: true, message: '今日已送过爱心值' };
    }
    return { ok: false, message };
  }
}

async function donateHonghuaFund() {
  const st = getUserState();
  const accId = st?.accountId;
  if (accId != null && honghuaFundDonatedByAccount.has(accId)) {
    return { ok: true, already: true, message: '本账号本次活动已捐过公益金（真实扣款仅 1 次）' };
  }
  // 真实 1 元微信扣款，绝不在任何自动任务中调用，仅管理员手动触发
  try {
    await operateHonghua(CMD.DONATE_FUND);
    if (accId != null) honghuaFundDonatedByAccount.add(accId);
    return { ok: true, realCharge: true, message: '已捐赠公益金（真实扣款 1 元，单账号活动期仅 1 次）' };
  } catch (err) {
    const message = String(err?.message || err || '');
    if (isAlreadyClaimedError(err) || message.includes('已捐') || message.includes('已捐赠')) {
      if (accId != null) honghuaFundDonatedByAccount.add(accId);
      return { ok: true, already: true, message: '本账号本次活动已捐过公益金' };
    }
    return { ok: false, realCharge: true, message };
  }
}

async function claimHonghuaShare() {
  try {
    await operateHonghua(CMD.CLAIM_SHARE);
    return { ok: true, message: '分享奖励领取成功' };
  } catch (err) {
    if (isAlreadyClaimedError(err)) return { ok: true, message: '分享奖励今日已领取' };
    return { ok: false, message: String(err?.message || err || '') };
  }
}

async function claimHonghuaTiers() {
  // 对齐 Go 版 Aoluis1005/QQ-farm-BOT-GO 2026-09-02 线上实测结论：
  //   - cmd=37 领档位，扩展块 f136 内带 field1=档位阈值(30/60/90/120/150)，一次领一个档位；
  //   - cmd=37 领未达标档服务器返回「个人捐赠进度未达标」错误、领已领取档静默无奖励；
  //   - cmd=39 只是查询类操作（静默空回包），此前误判为有效领取 —— 已于 2026-09-03 修正；
  //   - 回包奖励在 f137={f1=阈值, f2={f1=物品id, f2=数量}}，解析到奖励才算真正到账。
  const claimed = [];
  const skipped = [];
  try {
    // 先取活动进度，找出所有达标且未领取的档位
    let tiers = [];
    try {
      const honghua = await getHonghuaActivity();
      tiers = (honghua && honghua.progress && honghua.progress.tiers) || [];
    } catch (_) { /* 进度拉取失败则退化为空，下面按无档位处理 */ }
    // 只按爱心值达标过滤：f9.f3 语义未定（Go 称 1=已领取，用户小程序亲测 1=仍可领取），
    // 不能用它排除档位，否则可能永久跳过；已领的档 cmd=37 会静默无奖励，无副作用。
    const reachable = tiers.filter((t) => t && t.reached);
    if (!reachable.length) {
      return { ok: true, message: '当前无达标且未领取的爱心值档位（爱心值需先收获小红花果实并送出）' };
    }
    for (const t of reachable) {
      const threshold = toNum(t.tier);
      if (!threshold) continue;
      try {
        const body = await operateHonghua(CMD.CLAIM_TIERS, encodeTierExt(threshold));
        const rewards = parseTierRewardField(body);
        if (rewards.length) {
          claimed.push({ threshold, rewards });
          honghuaLogger.warn(`claimHonghuaTiers tier=${threshold} rewards=${JSON.stringify(rewards)}`);
        } else {
          // 回包无奖励：可能该档位已领取或未真正达标，记录但不报成功
          skipped.push(threshold);
          honghuaLogger.warn(`claimHonghuaTiers tier=${threshold} 无奖励回包 len=${Buffer.from(body || []).length}`);
        }
      } catch (err) {
        const message = String(err?.message || err || '');
        if (isAlreadyClaimedError(err)) {
          claimed.push({ threshold, already: true });
        } else {
          skipped.push(threshold);
          honghuaLogger.warn(`claimHonghuaTiers tier=${threshold} ERR ${message}`);
        }
      }
    }
    if (claimed.length) {
      return { ok: true, claimed: claimed.length, message: `爱心值档位奖励领取成功 ${claimed.length} 档` };
    }
    if (skipped.length) {
      return { ok: false, message: `档位奖励未领取到：${skipped.join('/')} 档（可能已领取或爱心值未达标）` };
    }
    return { ok: true, message: '爱心值档位奖励领取成功' };
  } catch (err) {
    if (isAlreadyClaimedError(err)) return { ok: true, message: '档位奖励今日已领取' };
    return { ok: false, message: String(err?.message || err || '') };
  }
}

module.exports = {
  HONGHUA_ACTIVITY_ID,
  getHonghuaActivity,
  donateHonghuaLove,
  donateHonghuaFund,
  claimHonghuaShare,
  claimHonghuaTiers,
};
