const protobuf = require('protobufjs/minimal');
const { parentPort } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const {
  getKnownFriendGids,
  applyConfigSnapshot,
  getFriendBlacklist,
  removeFriendFromCache,
} = require('../models/store');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log, logWarn, randomDelay } = require('../utils/utils');
const { getInteractRecords } = require('./interact');

// ===== Constants =====
const QQ_FRIEND_LIST_BATCH_SIZE = 35;
const INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// 系统 NPC 好友（官方人机号），始终在好友列表中可用
const SYSTEM_NPC_FRIENDS = [
  { gid: 10001, name: '小果', remark: '小果', level: 1 },
];
const SYSTEM_NPC_GIDS = new Set(SYSTEM_NPC_FRIENDS.map(f => f.gid));

// ===== Dog names mapping =====
// ⚠️ 这只是**兜底小表**。狗名以游戏配置（ItemInfo，type=8 为宠物）为准——
// 该表曾缺 90031（比熊犬），导致养比熊犬的好友被显示成「无狗」（2026-10-22 实测）。
const DOG_NAMES = {
  '90001': '田园犬',
  '90002': '牧羊犬',
  '90003': '斑点狗',
  '90011': '柯基',
  '90021': '护主犬',
  '90031': '比熊犬',
};

// ===== State =====
let hasInitializedFromVisitors = false;
// 访客 GID 同步节流：普通调用受此间隔限制，显式刷新（force）可绕过。
// 参考上游 `syncKnownFriendGidsFromRecentVisitors` 的 10 分钟节奏。
const DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QQ_VISITOR_GID_SYNC_RETRY_MS = 30 * 1000;
const MAX_QQ_VISITOR_GID_SYNC_RETRY_MS = 2 * 60 * 1000;
let lastVisitorGidSyncAt = 0;
// QQ（尤其 NapCat 扫码）登录后仅引导同步一次好友 GID
let hasBootstrappedQqFriendGids = false;
const invalidKnownFriendGidCooldownUntil = new Map();

// ===== Dog Name =====
/**
 * 取狗名：**优先查游戏配置**（ItemInfo 里宠物 type=8），它含全部狗；
 * DOG_NAMES 小表仅作配置未就绪时的兜底，避免再出现「表里没有就当成无狗」。
 */
function getDogName(dogId) {
  const id = toNum(dogId);
  if (!id) return '';
  try {
    const { getItemById } = require('../config/gameConfig');
    const info = getItemById(id);
    if (info && info.name) return String(info.name);
  } catch { /* 配置未就绪 → 回退小表 */ }
  return DOG_NAMES[id] || '';
}

// ===== Protobuf helpers =====

/**
 * Check if a buffer is mostly printable UTF-8 text (>= 85% printable).
 * Used to decide whether to treat bytes as a nested protobuf or as a string.
 */
function isMostlyPrintableUtf8(buf) {
  if (!buf || buf.length === 0) return false;
  const text = Buffer.from(buf).toString('utf8');
  if (!text) return false;
  let printableCount = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // TAB(9), LF(10), CR(13), or printable (32-126)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) {
      printableCount++;
    }
  }
  return printableCount / text.length >= 0.85;
}

/**
 * Decode raw protobuf bytes into an array of {no, wire, value/length/fields} objects.
 * Recursively decodes nested messages up to `maxDepth` (default 2).
 */
function decodeProtoFields(rawBytes, depth = 0, maxDepth = 2) {
  const reader = protobuf.Reader.create(Buffer.from(rawBytes || []));
  const fields = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    const entry = { no: fieldNo, wire: wireType };

    if (wireType === 0) {
      // Varint
      const val = reader.uint64();
      entry.value = Number(val.toString());
    } else if (wireType === 1) {
      // Fixed64
      entry.value = String(reader.fixed64());
    } else if (wireType === 2) {
      // Length-delimited (bytes / string / nested message)
      const bytes = reader.bytes();
      entry.length = bytes.length;
      if (isMostlyPrintableUtf8(bytes)) {
        entry.text = Buffer.from(bytes).toString('utf8');
      } else if (depth < maxDepth) {
        try {
          const nested = decodeProtoFields(bytes, depth + 1, maxDepth);
          if (nested.length > 0) {
            entry.fields = nested;
          }
        } catch (_) {
          // Ignore nested decode errors
        }
      }
    } else if (wireType === 5) {
      // Fixed32
      entry.value = reader.fixed32();
    } else {
      reader.skipType(wireType);
      continue;
    }
    fields.push(entry);
  }
  return fields;
}

/**
 * Recursively collect all varint (wireType === 0) integer values from decoded fields.
 */
function collectVarints(decodedFields, result = []) {
  for (const field of Array.isArray(decodedFields) ? decodedFields : []) {
    if (field && field.wire === 0 && Number.isFinite(field.value)) {
      result.push(Math.max(0, Math.floor(field.value)));
    }
    if (field && Array.isArray(field.fields)) {
      collectVarints(field.fields, result);
    }
  }
  return result;
}

/**
 * Parse the brief_dog_info protobuf bytes from VisitEnterReply.
 * Returns { dogId, numbers, rawLen, fields } or null.
 */
function parseBriefDogInfoBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  let fields = [];
  try {
    fields = decodeProtoFields(bytes);
  } catch (_) {
    fields = [];
  }
  const varints = collectVarints(fields).filter(v => v > 0);
  const dogId = varints.find(id => Object.hasOwn(DOG_NAMES, id)) || 0;
  return {
    dogId,
    numbers: varints.slice(-3),   // last 3 varints
    rawLen: bytes.length,
    fields,
  };
}

/**
 * Extract dog info from VisitEnter reply raw bytes.
 * Looks for field number 3, wire type 2 (length-delimited).
 */
function extractVisitEnterBriefDogInfo(rawBytes) {
  if (!rawBytes || rawBytes.length === 0) return null;
  const reader = protobuf.Reader.create(Buffer.from(rawBytes));
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 3 && wireType === 2) {
      const bytes = reader.bytes();
      return parseBriefDogInfoBytes(bytes);
    }
    reader.skipType(wireType);
  }
  return null;
}

// ===== IPC to master process =====
function postToMaster(msg) {
  try {
    if (process.send) {
      process.send(msg);
      return true;
    }
    if (parentPort && typeof parentPort.postMessage === 'function') {
      parentPort.postMessage(msg);
      return true;
    }
  } catch (_) {
    // Ignore IPC errors
  }
  return false;
}

// ===== Invalid known friend GID cooldown management =====

/** Remove expired cooldown entries. */
function pruneInvalidKnownFriendGidCooldown(now = Date.now()) {
  for (const [gid, until] of invalidKnownFriendGidCooldownUntil.entries()) {
    if (!gid || until <= now) {
      invalidKnownFriendGidCooldownUntil.delete(gid);
    }
  }
}

/** Clear invalid marks for specific GIDs. */
function clearInvalidKnownFriendGidMarks(gids) {
  for (const gid of normalizeFriendGids(gids)) {
    invalidKnownFriendGidCooldownUntil.delete(gid);
  }
}

/** Mark a friend GID as invalid with a cooldown period. */
function markKnownFriendGidInvalid(gid, now = Date.now()) {
  const numericGid = toNum(gid);
  if (!numericGid) return;
  invalidKnownFriendGidCooldownUntil.set(numericGid, now + INVALID_KNOWN_FRIEND_GID_COOLDOWN_MS);
}

/** Get the set of currently invalid GIDs (prune first). */
function getInvalidKnownFriendGidSet(now = Date.now()) {
  pruneInvalidKnownFriendGidCooldown(now);
  return new Set(invalidKnownFriendGidCooldownUntil.keys());
}

/** Normalize an array of GIDs: convert to numbers, remove zeros and duplicates. */
function normalizeFriendGids(rawGids) {
  const result = [];
  for (const raw of Array.isArray(rawGids) ? rawGids : []) {
    const num = toNum(raw);
    if (num <= 0) continue;
    if (result.includes(num)) continue;
    result.push(num);
  }
  return result;
}

/** Extract game_friends array from the reply object (supports both snake_case and camelCase). */
function extractReplyFriends(reply) {
  if (Array.isArray(reply && reply.game_friends)) return reply.game_friends;
  if (Array.isArray(reply && reply.gameFriends)) return reply.gameFriends;
  return [];
}

/** Deduplicate friend list by GID, keeping first occurrence. */
function dedupeFriendsByGid(friends) {
  const result = [];
  const seen = new Set();
  for (const friend of Array.isArray(friends) ? friends : []) {
    const gid = toNum(friend && friend.gid);
    if (gid <= 0 || seen.has(gid)) continue;
    seen.add(gid);
    result.push(friend);
  }
  return result;
}

/** Wrap deduplicated friends into a reply-shaped object. */
function buildFriendReply(friends) {
  const deduped = dedupeFriendsByGid(friends);
  return { game_friends: deduped, gameFriends: deduped };
}

/** Sync known friend GIDs into config and notify master process. */
function syncKnownFriendGidsFromFriends(friends) {
  const newGids = normalizeFriendGids(
    (Array.isArray(friends) ? friends : []).map(f => f && f.gid)
  );
  if (newGids.length === 0) return [];

  clearInvalidKnownFriendGidMarks(newGids);

  const currentGids = normalizeFriendGids(getKnownFriendGids());
  const mergedGids = normalizeFriendGids([...currentGids, ...newGids]);

  // No change
  if (mergedGids.length === currentGids.length &&
      mergedGids.every((gid, i) => gid === currentGids[i])) {
    return mergedGids;
  }

  // Persist (non-blocking via IPC)
  applyConfigSnapshot({ knownFriendGids: mergedGids }, { persist: false });
  const synced = postToMaster({ type: 'known_friend_gids_sync', gids: mergedGids });

  if (!synced) {
    // Fallback to immediate persistence
    applyConfigSnapshot({ knownFriendGids: mergedGids }, { persist: true });
  }
  return mergedGids;
}

/**
 * Get known QQ friend GIDs, excluding invalid and blacklisted ones.
 */
function getEffectiveKnownQqFriendGids() {
  const gids = normalizeFriendGids(getKnownFriendGids());
  clearInvalidKnownFriendGidMarks(gids);
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const invalidSet = getInvalidKnownFriendGidSet();
  const blacklist = new Set(getFriendBlacklist(accountId));
  return normalizeFriendGids(gids).filter(
    gid => !invalidSet.has(gid) && !blacklist.has(gid)
  );
}

/**
 * 同步「最近访客」里的 GID 到 knownFriendGids。
 *
 * 关键语义（对齐上游 `syncKnownFriendGidsFromRecentVisitors`）：
 * - **不是一次性**：每次调用都会尝试拉访客记录并合并（普通调用受 10 分钟间隔节流，
 *   `force=true` 时立即同步）。好友列表接口只按 knownFriendGids 拉取，
 *   若这里只跑一次，之后新增/遗漏的好友 GID 永远不会被发现。
 * - 只做「并集」，绝不因访客为空而收缩已知 GID。
 * - 失败时按退避重试（30s~2min），避免把节流窗口顶满导致长时间不再重试。
 */
async function syncKnownFriendGidsFromRecentVisitorsOnce(force = false) {
  const now = Date.now();
  if (!force && lastVisitorGidSyncAt > 0
      && now - lastVisitorGidSyncAt < DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS) {
    return getEffectiveKnownQqFriendGids();
  }

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const existingGids = normalizeFriendGids(getKnownFriendGids());

  try {
    if (!hasInitializedFromVisitors) {
      log('好友', '首次登录，尝试从访客记录获取好友GID...', {
        module: 'friend',
        event: '首次获取好友GID',
      });
    }

    const interactRecords = await getInteractRecords();
    const invalidSet = getInvalidKnownFriendGidSet(now);
    const visitorGids = normalizeFriendGids(
      (Array.isArray(interactRecords) ? interactRecords : [])
        .map(r => r && r.visitorGid)
    ).filter(gid => !invalidSet.has(gid));

    hasInitializedFromVisitors = true;
    lastVisitorGidSyncAt = now;

    if (visitorGids.length === 0) {
      log('好友', '访客记录为空，无法获取好友GID', {
        module: 'friend',
        event: '获取访客好友GID',
        result: 'empty',
      });
      return getEffectiveKnownQqFriendGids();
    }

    const mergedGids = normalizeFriendGids([...existingGids, ...visitorGids]);
    const addedCount = mergedGids.length - existingGids.length;
    if (addedCount > 0) {
      applyConfigSnapshot({ knownFriendGids: mergedGids }, {
        persist: false,
        accountId,
      });

      const synced = postToMaster({
        type: 'known_friend_gids_sync',
        gids: mergedGids,
      });

      if (!synced) {
        applyConfigSnapshot({ knownFriendGids: mergedGids }, {
          persist: true,
          accountId,
        });
      }

      log('好友', `已从最近访客补充 ${addedCount} 个好友GID，当前已知好友 GID 共 ${mergedGids.length} 个`, {
        module: 'friend',
        event: '访客补充好友GID',
        result: 'ok',
        addedFromVisitors: addedCount,
        totalKnownGids: mergedGids.length,
      });
    }

    return getEffectiveKnownQqFriendGids();
  } catch (err) {
    hasInitializedFromVisitors = true;
    // 失败退避：把上次同步时间往前挪，使下次在 30s~2min 后即可重试
    const retryMs = Math.max(MIN_QQ_VISITOR_GID_SYNC_RETRY_MS,
      Math.min(DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS, MAX_QQ_VISITOR_GID_SYNC_RETRY_MS));
    lastVisitorGidSyncAt = now - (DEFAULT_QQ_VISITOR_GID_SYNC_INTERVAL_MS - retryMs);
    logWarn('好友', `同步最近访客 GID 失败: ${err.message}`, {
      module: 'friend',
      event: '同步好友GID',
      result: 'error',
    });
    return getEffectiveKnownQqFriendGids();
  }
}

/**
 * Best-effort QQ friend GID bootstrap for login flows that do not provide
 * platform openids (notably NapCat QR login). Every source is independent so
 * one unavailable legacy RPC does not prevent visitor/application discovery.
 *
 * 好友列表接口（GetGameFriends）只按「已知 GID」拉取，因此新增好友必须先被发现
 * 并写进 knownFriendGids，否则永远不出现在好友列表里。这里把三条发现路径
 * （好友全量/待处理申请/最近访客）合并成一次引导同步。
 */
async function bootstrapQqFriendGids() {
  if (CONFIG.platform !== 'qq') return { skipped: true, reason: 'not_qq' };
  if (hasBootstrappedQqFriendGids) return { skipped: true, reason: 'already_bootstrapped' };
  hasBootstrappedQqFriendGids = true;

  const discovered = [];
  const sourceCounts = { legacy: 0, applications: 0, visitors: 0 };
  const errors = [];

  try {
    const friends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
    sourceCounts.legacy = friends.length;
    discovered.push(...friends.map(friend => toNum(friend && friend.gid)));
  } catch (err) {
    errors.push(`legacy: ${err.message}`);
  }

  try {
    const reply = await getApplications();
    const applications = Array.isArray(reply && reply.applications) ? reply.applications : [];
    sourceCounts.applications = applications.length;
    discovered.push(...applications.map(application => toNum(application && application.gid)));
  } catch (err) {
    errors.push(`applications: ${err.message}`);
  }

  try {
    const records = await getInteractRecords();
    const visitorGids = normalizeFriendGids(
      (Array.isArray(records) ? records : []).map(record => record && record.visitorGid)
    );
    sourceCounts.visitors = visitorGids.length;
    discovered.push(...visitorGids);
    hasInitializedFromVisitors = true;
  } catch (err) {
    errors.push(`visitors: ${err.message}`);
  }

  const ownGid = toNum(getUserState().gid);
  const gids = normalizeFriendGids(discovered).filter(gid => gid !== ownGid);
  const before = getEffectiveKnownQqFriendGids();
  if (gids.length > 0) syncKnownFriendGidsFromFriends(gids.map(gid => ({ gid })));
  const after = getEffectiveKnownQqFriendGids();

  let verifiedCount = 0;
  if (after.length > 0) {
    try {
      const verified = await fetchQqFriendsByKnownGids();
      verifiedCount = verified.length;
      syncKnownFriendGidsFromFriends(verified);
    } catch (err) {
      errors.push(`verify: ${err.message}`);
    }
  }

  const addedCount = Math.max(0, after.length - before.length);
  log('好友', `QQ 好友GID引导同步完成：发现 ${gids.length} 个，新增 ${addedCount} 个`, {
    module: 'friend',
    event: 'QQ好友GID引导同步',
    result: errors.length > 0 ? 'partial' : 'ok',
    sourceCounts,
    discoveredCount: gids.length,
    addedCount,
    verifiedCount,
    errors,
  });

  return { skipped: false, sourceCounts, discoveredCount: gids.length, addedCount, verifiedCount, errors };
}

// ===== Friend management APIs =====

/** Remove a known friend GID and mark it as invalid. */
function removeKnownFriendGid(gid, friendName, reason = '') {
  const numericGid = toNum(gid);
  if (!numericGid) return false;

  const currentGids = normalizeFriendGids(getKnownFriendGids());
  const filteredGids = currentGids.filter(g => g !== numericGid);
  markKnownFriendGidInvalid(numericGid);

  if (filteredGids.length !== currentGids.length) {
    applyConfigSnapshot({ knownFriendGids: filteredGids }, { persist: false });
  }

  const synced = postToMaster({
    type: 'known_friend_gid_remove',
    gid: numericGid,
    friendName: friendName || `GID:${numericGid}`,
    reason: String(reason || ''),
  });

  if (!synced && filteredGids.length !== currentGids.length) {
    applyConfigSnapshot({ knownFriendGids: filteredGids }, { persist: true });
  }

  logWarn('好友', `检测到失效好友 GID，已自动移除: ${friendName || `GID:${numericGid}`}`, {
    module: 'friend',
    event: '检测失效好友GID',
    result: 'auto_removed',
    friendName: friendName || `GID:${numericGid}`,
    friendGid: numericGid,
    reason: String(reason || ''),
  });

  return true;
}

/** Check if the error indicates the user is banned from entering the farm. */
function isEnterFarmBannedError(err) {
  const msg = String((err && err.message) || err || '');
  if (!msg) return false;
  return msg.includes('1002003');
}

/** Extract the RPC error code from an error message. */
function parseRpcErrorCode(err) {
  const msg = String((err && err.message) || err || '');
  const match = msg.match(/code=(\d+)/i);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

/** Check if the error is a transient network error (retryable). */
function isTransientNetworkError(err) {
  const msg = String((err && err.message) || err || '');
  if (!msg) return false;
  return [
    '连接未打开',
    '请求超时',
    '请求已中断',
    '连接关闭',
    '连接已在加密途中关闭',
    'worker exited',
  ].some(keyword => msg.includes(keyword));
}

/** Check if the error is due to an invalid friend relationship. */
function isInvalidFriendAccessError(err) {
  const msg = String((err && err.message) || err || '');
  if (!msg || isEnterFarmBannedError(err) || isTransientNetworkError(err)) return false;

  const lower = msg.toLowerCase();
  const matched = ['无效', '不存在', '删除', '关系', 'not found', 'invalid', 'not friend', 'friend']
    .some(kw => lower.includes(kw.toLowerCase()));

  return matched && parseRpcErrorCode(err) > 0;
}

/** Add a friend to the blacklist via IPC to master process. */
function addFriendToBlacklist(gid, friendName, reason = '') {
  const numericGid = toNum(gid);
  if (!numericGid) return false;

  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const blacklist = getFriendBlacklist(accountId);
  const list = Array.isArray(blacklist) ? blacklist : [];
  if (list.includes(numericGid)) return false;

  const synced = postToMaster({
    type: 'friend_blacklist_add',
    gid: numericGid,
    friendName: friendName || `GID:${numericGid}`,
    reason: String(reason || ''),
  });
  if (!synced) return false;

  logWarn('好友', `检测到封禁好友，已自动加入黑名单: ${friendName || `GID:${numericGid}`}`, {
    module: 'friend',
    event: '加黑名单',
    result: 'auto_blocked',
    friendName: friendName || `GID:${numericGid}`,
    friendGid: numericGid,
    reason: String(reason || ''),
  });
  return true;
}

/** Handle errors encountered while entering a friend's farm. */
function handleFriendEnterError(gid, friendName, error) {
  const numericGid = toNum(gid);
  const name = String(friendName || '').trim() || `GID:${numericGid}`;
  const errMsg = String((error && error.message) || error || '');

  // 系统 NPC（如小果 10001）不应被加入黑名单或从好友列表中移除
  if (SYSTEM_NPC_GIDS.has(numericGid)) {
    return { handled: false, kind: 'npc_error' };
  }

  if (isEnterFarmBannedError(error)) {
    addFriendToBlacklist(numericGid, name, errMsg);
    return { handled: true, kind: 'blacklist' };
  }

  if (isInvalidFriendAccessError(error)) {
    removeKnownFriendGid(numericGid, name, errMsg);
    return { handled: true, kind: 'invalid_removed' };
  }

  return { handled: false, kind: 'error' };
}

// ===== QQ friend APIs =====

/** Fetch QQ friends by batch-requesting known GIDs via GetGameFriends. */
async function fetchQqFriendsByKnownGids() {
  if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
    throw new Error('GetGameFriends 接口类型未加载');
  }

  const gids = getEffectiveKnownQqFriendGids();
  if (gids.length === 0) return [];

  const allFriends = [];
  for (let i = 0; i < gids.length; i += QQ_FRIEND_LIST_BATCH_SIZE) {
    const batch = gids.slice(i, i + QQ_FRIEND_LIST_BATCH_SIZE);
    const payload = types.GetGameFriendsRequest.encode(
      types.GetGameFriendsRequest.create({ gids: batch.map(g => toLong(g)) })
    ).finish();

    try {
      const { body } = await sendMsgAsync(
        'gamepb.friendpb.FriendService',
        'GetGameFriends',
        payload
      );
      const reply = types.GetAllFriendsReply.decode(body);
      allFriends.push(...extractReplyFriends(reply));
    } catch (err) {
      logWarn('好友',
        `QQ 新好友接口分批请求失败(${i + 1}-${i + batch.length}/${gids.length}): ${err.message}`,
        {
          module: 'friend',
          event: '好友列表接口',
          result: 'error',
          method: 'GetGameFriends',
          batchSize: batch.length,
        }
      );
    }

    if (i + QQ_FRIEND_LIST_BATCH_SIZE < gids.length) {
      await randomDelay(500, 1500);
    }
  }

  return dedupeFriendsByGid(allFriends);
}

/** Fetch QQ friends via legacy methods: SyncAll first, then GetAll as fallback. */
async function fetchQqFriendsByLegacyMethod() {
  const errors = [];

  // Try SyncAll
  try {
    const SyncAllReq = types.SyncAllRequest || types.SyncAllFriendsRequest;
    const SyncAllRep = types.SyncAllReply || types.SyncAllFriendsReply;
    if (!SyncAllReq || !SyncAllRep) throw new Error('SyncAll 接口类型未加载');

    const payload = SyncAllReq.encode(SyncAllReq.create({ open_ids: [] })).finish();
    const { body } = await sendMsgAsync(
      'gamepb.friendpb.FriendService',
      'SyncAll',
      payload
    );
    return extractReplyFriends(SyncAllRep.decode(body));
  } catch (err) {
    errors.push(`SyncAll: ${err.message}`);
  }

  // Fallback: GetAll
  try {
    if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply) {
      throw new Error('GetAll 接口类型未加载');
    }
    const payload = types.GetAllFriendsRequest.encode(
      types.GetAllFriendsRequest.create({})
    ).finish();
    const { body } = await sendMsgAsync(
      'gamepb.friendpb.FriendService',
      'GetAll',
      payload
    );
    return extractReplyFriends(types.GetAllFriendsReply.decode(body));
  } catch (err) {
    errors.push(`GetAll: ${err.message}`);
  }

  throw new Error(errors.join(' | '));
}

/**
 * Get all friends. For QQ platform, try GetGameFriends first (with known GIDs),
 * then fall back to legacy methods. For WeChat, use GetAll directly.
 */
async function getAllFriends(forceRefresh = false) {
  const isQQ = CONFIG.platform === 'qq';

  /** 将系统 NPC 合并到好友列表中，已有真实数据的优先保留 */
  function mergeSystemNpcs(friends) {
    const list = Array.isArray(friends) ? friends : [];
    const existingGids = new Set(list.map(f => toNum(f && f.gid)).filter(g => g > 0));
    const npcsToAdd = SYSTEM_NPC_FRIENDS.filter(npc => !existingGids.has(npc.gid));
    return dedupeFriendsByGid([...list, ...npcsToAdd]);
  }

  if (isQQ) {
    await syncKnownFriendGidsFromRecentVisitorsOnce(forceRefresh);

    // Try new API first（GetGameFriends：只按 knownFriendGids 拉取）
    const knownFriends = await fetchQqFriendsByKnownGids();

    // 刷新（forceRefresh）时额外走一次 legacy 全量接口并取并集：
    // GetGameFriends 只认 knownFriendGids，若好友是「刚加、还没进 knownFriendGids」，
    // 或 knownFriendGids 里混入了已失效的 GID，单靠它会比真实好友数少。
    // legacy（SyncAll/GetAll）是服务端全量列表，能补齐这部分并顺带把新 GID 落库。
    // 非刷新路径保持原有行为（先 knownGids，为空才回退 legacy），避免每轮多打一次请求。
    if (forceRefresh) {
      let legacyFriends = [];
      try {
        legacyFriends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
      } catch (err) {
        logWarn('好友', `刷新时 legacy 全量好友接口失败（忽略，继续用 knownGids 结果）: ${err.message}`, {
          module: 'friend',
          event: '好友列表接口',
          result: 'error',
          method: 'SyncAll/GetAll',
        });
      }

      const merged = dedupeFriendsByGid([...knownFriends, ...legacyFriends]);
      if (merged.length > 0) {
        syncKnownFriendGidsFromFriends(merged);
        return buildFriendReply(mergeSystemNpcs(merged));
      }
    }

    if (knownFriends.length > 0) {
      syncKnownFriendGidsFromFriends(knownFriends);
      return buildFriendReply(mergeSystemNpcs(knownFriends));
    }

    // Fallback to legacy methods
    try {
      const fallbackFriends = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
      if (fallbackFriends.length > 0) {
        syncKnownFriendGidsFromFriends(fallbackFriends);
      } else if (getEffectiveKnownQqFriendGids().length === 0) {
        logWarn('好友',
          'QQ 好友列表为空；若近期接口已切到 GetGameFriends，请先在好友页维护已知好友 GID 列表',
          {
            module: 'friend',
            event: '好友列表接口',
            result: 'empty',
          }
        );
      }
      return buildFriendReply(mergeSystemNpcs(fallbackFriends));
    } catch (err) {
      if (getEffectiveKnownQqFriendGids().length === 0) {
        throw new Error(
          `QQ 好友列表获取失败，请先在好友页维护已知好友 GID 列表。${err.message}`
        );
      }
      throw err;
    }
  }

  // WeChat platform: direct GetAll
  const payload = types.GetAllFriendsRequest.encode(
    types.GetAllFriendsRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'GetAll',
    payload
  );
  const wxFriends = extractReplyFriends(types.GetAllFriendsReply.decode(body));
  return buildFriendReply(mergeSystemNpcs(wxFriends));
}

/** Get pending friend applications. */
async function getApplications() {
  const payload = types.GetApplicationsRequest.encode(
    types.GetApplicationsRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'GetApplications',
    payload
  );
  return types.GetApplicationsReply.decode(body);
}

/** Accept friend requests by GID list. */
async function acceptFriends(gids) {
  const payload = types.AcceptFriendsRequest.encode(
    types.AcceptFriendsRequest.create({
      friend_gids: gids.map(g => toLong(g)),
    })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'AcceptFriends',
    payload
  );
  return types.AcceptFriendsReply.decode(body);
}

/** Delete a friend by GID. */
async function delFriend(gid) {
  const numericGid = toNum(gid);
  if (!numericGid) throw new Error('无效的好友 GID');

  const payload = types.DelFriendRequest.encode(
    types.DelFriendRequest.create({ friend_gid: toLong(numericGid) })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.friendpb.FriendService',
    'DelFriend',
    payload
  );
  const reply = types.DelFriendReply.decode(body);

  // Remove from local cache
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  if (accountId) {
    removeFriendFromCache(accountId, numericGid);
  }

  log('好友', `已删除好友 GID: ${numericGid}`, {
    module: 'friend',
    event: '删除好友',
    result: 'ok',
    friendGid: numericGid,
  });
  return reply;
}

/** Enter a friend's farm. Visit reason = 2 (general visit). */
async function enterFriendFarm(gid) {
  const payload = types.VisitEnterRequest.encode(
    types.VisitEnterRequest.create({ host_gid: toLong(gid), reason: 2 })
  ).finish();
  const { body } = await sendMsgAsync(
    'gamepb.visitpb.VisitService',
    'Enter',
    payload
  );
  const reply = types.VisitEnterReply.decode(body);

  // 狗信息：proto 里 brief_dog_info 是结构化 BriefDogInfo，直接读 dog_id。
  // ⚠️ 旧实现把该字段当 bytes、从原始字节里猜 varint 再比对 DOG_NAMES 小表，
  // 只要狗 id 不在表里（或猜错）就得到 dogId=0 → 上层判成「无狗」
  // （2026-10-22 用户实测：除小果外 13 个好友全显示无狗）。
  // 现在：有上场狗就一定拿到 id（名字查不到时退化成 `狗#<id>`，而不是「无狗」）。
  const briefDog = reply && reply.brief_dog_info;
  const dogId = toNum(briefDog && briefDog.dog_id);
  reply.__briefDogInfo = dogId > 0
    ? { dogId, dogName: getDogName(dogId) || `狗#${dogId}` }
    : null; // 无上场狗

  return reply;
}

/** Leave a friend's farm. */
async function leaveFriendFarm(gid) {
  const payload = types.VisitLeaveRequest.encode(
    types.VisitLeaveRequest.create({ host_gid: toLong(gid) })
  ).finish();
  try {
    await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', payload);
  } catch (_) {
    // Ignore leave errors
  }
}

/** Check whether we can perform a remote operation on a friend's farm. */
async function checkCanOperateRemote(gid, operationId) {
  if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) {
    return { canOperate: true, canStealNum: 0 };
  }

  try {
    const payload = types.CheckCanOperateRequest.encode(
      types.CheckCanOperateRequest.create({
        host_gid: toLong(gid),
        operation_id: toLong(operationId),
      })
    ).finish();
    const { body } = await sendMsgAsync(
      'gamepb.plantpb.PlantService',
      'CheckCanOperate',
      payload
    );
    const reply = types.CheckCanOperateReply.decode(body);
    return {
      canOperate: !!reply.can_operate,
      canStealNum: toNum(reply.can_steal_num),
    };
  } catch (_) {
    return { canOperate: true, canStealNum: 0 };
  }
}

// ===== Quiet hours =====

/** Parse a "HH:MM" time string to total minutes. Returns null if invalid. */
function parseTimeToMinutes(timeStr) {
  const match = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/** Check if the current time falls within the friend quiet hours.
 *  If a GID is provided, checks if that specific GID is exempt from quiet hours
 *  (NPC gids like 10001 and user-configured exempt gids are always exempt).
 *  Without a GID, returns the global quiet hours status. */
function inFriendQuietHours(gid, now = new Date()) {
  const { getFriendQuietHours, getFriendQuietHoursExemptGids } = require('../models/store');
  const accountId = process.env.FARM_ACCOUNT_ID || '';
  const quietHours = getFriendQuietHours(accountId);
  if (!quietHours || !quietHours.enabled) return false;

  // If a specific GID is provided, check if it is exempt
  if (gid !== undefined && gid !== null) {
    const numericGid = toNum(gid);
    if (numericGid <= 0) return false;
    // NPC GIDs are always exempt
    if (SYSTEM_NPC_GIDS.has(numericGid)) return false;
    // Check user-configured exempt GIDs
    const exemptGids = getFriendQuietHoursExemptGids(accountId);
    if (exemptGids.includes(numericGid)) return false;
    // GID is not exempt — check if we are in quiet hours
  }

  const startMin = parseTimeToMinutes(quietHours.start);
  const endMin = parseTimeToMinutes(quietHours.end);
  if (startMin === null || endMin === null) return false;

  const currentMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return true; // All-day quiet
  if (startMin < endMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  // Crosses midnight (e.g. 23:00 - 03:00)
  return currentMin >= startMin || currentMin < endMin;
}

/** Clear all cooldown marks for invalid friend GIDs. */
function clearAllInvalidKnownFriendGidCooldown() {
  invalidKnownFriendGidCooldownUntil.clear();
}

// ===== Exports =====
module.exports = {
  DOG_NAMES,
  SYSTEM_NPC_FRIENDS,
  SYSTEM_NPC_GIDS,
  getDogName,
  postToMaster,
  normalizeFriendGids,
  extractReplyFriends,
  dedupeFriendsByGid,
  buildFriendReply,
  syncKnownFriendGidsFromFriends,
  getEffectiveKnownQqFriendGids,
  isEnterFarmBannedError,
  parseRpcErrorCode,
  isTransientNetworkError,
  isInvalidFriendAccessError,
  addFriendToBlacklist,
  handleFriendEnterError,
  removeKnownFriendGid,
  parseTimeToMinutes,
  inFriendQuietHours,
  getAllFriends,
  bootstrapQqFriendGids,
  getApplications,
  acceptFriends,
  delFriend,
  enterFriendFarm,
  leaveFriendFarm,
  checkCanOperateRemote,
  parseBriefDogInfoBytes,
  extractVisitEnterBriefDogInfo,
  clearAllInvalidKnownFriendGidCooldown,
};
