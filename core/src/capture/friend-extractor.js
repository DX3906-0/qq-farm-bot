/**
 * 好友 GID 提取器
 *
 * 服务器→客户端 WebSocket 消息为 `gatepb.Message`（protobuf），其中
 * `meta.service_name` / `meta.method_name` 标识 RPC，`body` 为明文
 * protobuf 回复体（与 bot 内直接解码的方式一致，无需 TSDK 解密）。
 *
 * 好友相关 RPC：
 * - gamepb.friendpb.FriendService.GetAll        → GetAllReply（完整列表）
 * - gamepb.friendpb.FriendService.SyncAll       → SyncAllReply（完整列表）
 * - gamepb.friendpb.FriendService.GetGameFriends→ GetAllReply 形态（分批）
 */

const path = require('node:path');
const protobuf = require('protobufjs');

const FRIEND_SERVICE = 'gamepb.friendpb.FriendService';
const COMPLETE_METHODS = new Set(['GetAll', 'SyncAll']);
const PARTIAL_METHODS = new Set(['GetGameFriends']);

const REPLY_TYPE_MAP = {
  GetAll: 'GetAllReply',
  SyncAll: 'SyncAllReply',
  GetGameFriends: 'GetAllReply',
};

// 登录响应：提取自己的 GID（basic.gid），用于抓包后自动确认本次登录的 QQ
const LOGIN_SERVICE = 'gamepb.userpb.UserService';
const LOGIN_METHOD = 'Login';
const LOGIN_REPLY_TYPE = 'gamepb.userpb.LoginReply';

function getProtoPaths() {
  // 返回 proto 文件绝对路径数组
  return [
    path.join(__dirname, '../proto/game.proto'),
    path.join(__dirname, '../proto/friendpb.proto'),
    path.join(__dirname, '../proto/userpb.proto'),
  ];
}

/**
 * 创建好友 GID 提取器（异步加载 proto）
 * @returns {Promise<{ handleMessage: (buffer: Buffer) => {gids: number[], source: string, complete: boolean} | null }>} 提取器实例
 */
async function createFriendExtractor() {
  const root = new protobuf.Root();
  await root.load(getProtoPaths(), { keepCase: true });

  const GateMessage = root.lookupType('gatepb.Message');
  const replyTypes = {};
  for (const [method, replyName] of Object.entries(REPLY_TYPE_MAP)) {
    try {
      replyTypes[method] = root.lookupType(`gamepb.friendpb.${replyName}`);
    } catch {
      replyTypes[method] = null;
    }
  }
  let loginReplyType = null;
  try {
    loginReplyType = root.lookupType(LOGIN_REPLY_TYPE);
  } catch {
    loginReplyType = null;
  }

  /**
   * 解析一条服务器→客户端的二进制 WebSocket 消息。
   * @param {Buffer} buffer
   * @returns {{ gids: number[], source: string, complete: boolean, ownGid: number } | null}
   *          好友 RPC 或登录 RPC 解析结果；非目标消息返回 null。
   *          ownGid 仅在 Login 响应中返回（本次登录的 QQ 自身 GID）
   */
  function handleMessage(buffer) {
    if (!buffer || buffer.length === 0) return null;
    let message;
    try {
      message = GateMessage.decode(buffer);
    } catch {
      return null;
    }
    const meta = message && message.meta;
    if (!meta) return null;

    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    const body = message.body;
    if (!body || body.length === 0) return null;

    // 登录响应 → 提取自己的 GID（用于抓包后自动确认本次登录的 QQ）
    if (serviceName === LOGIN_SERVICE && methodName === LOGIN_METHOD && loginReplyType) {
      try {
        const reply = loginReplyType.decode(body);
        const ownGid = Number(reply && reply.basic && reply.basic.gid);
        if (Number.isSafeInteger(ownGid) && ownGid > 0) {
          return { gids: [], source: `${LOGIN_SERVICE}.${LOGIN_METHOD}`, complete: true, ownGid };
        }
      } catch {
        // 忽略单条解析失败
      }
      return null;
    }

    if (serviceName !== FRIEND_SERVICE) return null;
    if (!COMPLETE_METHODS.has(methodName) && !PARTIAL_METHODS.has(methodName)) return null;

    const replyType = replyTypes[methodName];
    let gids = [];
    if (replyType) {
      try {
        const reply = replyType.decode(body);
        const friends = Array.isArray(reply && reply.game_friends) ? reply.game_friends : [];
        gids = friends
          .map(friend => Number(friend && friend.gid))
          .filter(gid => Number.isSafeInteger(gid) && gid > 0);
      } catch {
        gids = [];
      }
    }

    return {
      gids,
      source: `${serviceName}.${methodName}`,
      complete: COMPLETE_METHODS.has(methodName),
    };
  }

  function decodeGateMessage(buffer) {
    if (!buffer || buffer.length === 0) return null;
    let message;
    try {
      message = GateMessage.decode(buffer);
    } catch {
      return null;
    }
    const meta = message && message.meta;
    if (!meta) return null;
    return {
      serviceName: String(meta.service_name || ''),
      methodName: String(meta.method_name || ''),
      msgType: Number(meta.message_type || 0),
      body: message.body || Buffer.alloc(0),
    };
  }

  return { handleMessage, decodeGateMessage };
}

module.exports = {
  COMPLETE_METHODS,
  FRIEND_SERVICE,
  PARTIAL_METHODS,
  REPLY_TYPE_MAP,
  createFriendExtractor,
  getProtoPaths,
};
