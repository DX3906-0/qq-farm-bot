/**
 * 游戏公告（ BulletinBoardService.GetBulletinList / GetBulletinDetail ）抓取与解码
 *
 * 逆向来源：本地 MITM 抓包（core/local-capture.js）捕获到
 *   gamepb.bulletinboardpb.BulletinBoardService.GetBulletinList
 *   gamepb.bulletinboardpb.BulletinBoardService.GetBulletinDetail
 *
 * 列表接口（GetBulletinList）响应为 repeated Bulletin，每条含 id / title / type / pic，
 * 只有摘要没有正文；正文需通过详情接口（GetBulletinDetail）按 id 拉取，
 * 详情响应结构为 field1=标题、field2=正文（与列表消息结构不同）。
 *
 * 由于 bot 未内置 bulletinboardpb.proto，这里直接发送裸请求体并按
 * protobuf wire 格式手写解码，提取需要的字段。
 */

const { sendMsgAsync } = require('../utils/network');

const BULLETIN_SERVICE = 'gamepb.bulletinboardpb.BulletinBoardService';
const BULLETIN_METHOD = 'GetBulletinList';
const BULLETIN_DETAIL_METHOD = 'GetBulletinDetail';

async function getBulletinList() {
  const { body } = await sendMsgAsync(BULLETIN_SERVICE, BULLETIN_METHOD, Buffer.alloc(0));
  return decodeBulletins(body);
}

// ---- protobuf 工具 ----

function encodeVarint(n) {
  let v = BigInt(n); const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

// 写入 length-delimited 字段（tag + 长度 + 内容）
function encodeLenField(fieldNo, payload) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), encodeVarint(payload.length), payload]);
}

function readTag(buf, off) {
  let tag = 0, shift = 0, b;
  do { b = buf[off++]; tag |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && off < buf.length);
  return { field: tag >> 3, wt: tag & 7, next: off };
}

function readVarint(buf, off) {
  let v = 0, s = 0, b;
  do { b = buf[off++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && off < buf.length);
  return { v, next: off };
}

function readLen(buf, off) {
  let len = 0, s = 0, b;
  do { b = buf[off++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && off < buf.length);
  return { len, next: off };
}

function skip(buf, off, wt) {
  if (wt === 0) { while ((buf[off] & 0x80) && off < buf.length) off += 1; return off + 1; }
  if (wt === 1) return off + 8;
  if (wt === 5) return off + 4;
  const { len, next } = readLen(buf, off);
  return next + len;
}

// 列表：每条公告为 field1 的 length-delimited 子 message
function decodeBulletins(buf) {
  const list = [];
  let off = 0;
  while (off < buf.length) {
    const { field, wt, next } = readTag(buf, off); off = next;
    if (wt === 2 && field === 1) {
      const { len, next: no } = readLen(buf, off); off = no;
      list.push(decodeBulletin(buf.slice(off, off + len)));
      off += len;
    } else {
      off = skip(buf, off, wt);
    }
  }
  return list;
}

// 列表中的公告摘要：field1=id, field2=title, field3=type, field6=pic
function decodeBulletin(buf) {
  const out = { id: 0, title: '', type: 0, pic: '' };
  let off = 0;
  while (off < buf.length) {
    const { field, wt, next } = readTag(buf, off); off = next;
    if (wt === 0) {
      const { v, next: no } = readVarint(buf, off); off = no;
      if (field === 1) out.id = v;
      else if (field === 3) out.type = v;
    } else if (wt === 2) {
      const { len, next: no } = readLen(buf, off); off = no;
      const sub = buf.slice(off, off + len); off += len;
      const text = sub.toString('utf8');
      if (field === 2) out.title = text;
      else if (field === 6) out.pic = text;
    } else {
      off = skip(buf, off, wt);
    }
  }
  return out;
}

// 公告详情：请求体 field1=id（uint32）
async function getBulletinDetail(id) {
  const body = Buffer.concat([Buffer.from([0x08]), encodeVarint(id)]);
  const { body: resp } = await sendMsgAsync(BULLETIN_SERVICE, BULLETIN_DETAIL_METHOD, body, 8000);
  return { raw: resp.toString('base64'), decoded: decodeBulletinDetail(resp), method: BULLETIN_DETAIL_METHOD };
}

// 详情响应结构（与列表不同）：field1=标题, field2=正文
function decodeBulletinDetail(buf) {
  const out = { title: '', content: '' };
  let off = 0;
  while (off < buf.length) {
    const { field, wt, next } = readTag(buf, off); off = next;
    if (wt === 2) {
      const { len, next: no } = readLen(buf, off); off = no;
      const sub = buf.slice(off, off + len); off += len;
      const text = sub.toString('utf8');
      if (field === 1) out.title = text;
      else if (field === 2) out.content = text;
    } else {
      off = skip(buf, off, wt);
    }
  }
  return out;
}

module.exports = { getBulletinList, getBulletinDetail, BULLETIN_SERVICE, BULLETIN_METHOD };