const assert = require('node:assert/strict');
const test = require('node:test');

const { loadProto, types } = require('../src/utils/proto');

/**
 * 2026-11-03 回归防线
 *
 * 官方 mallpb.proto 里 `goods_list` 是 `repeated MallGoods`（结构化），
 * protobufjs 解码后会直接给对象数组。旧代码误以为它是 bytes，
 * 每条又调一次 `types.MallGoods.decode(raw)` → 必抛错 → 被 catch 吞掉
 * → 商城永远返回空列表（表现为"前端看不到任何商品"）。
 *
 * 这个测试钉住两件事：
 *   1. goods_list 解出来就是对象（不是 bytes）
 *   2. 该对象的关键字段（goods_id / price / reward_items / purchase_limit）可直接读
 */
test.before(async () => loadProto());

test('goods_list 解码后是结构化对象，不能再当 bytes decode', () => {
  // 手工构造一条 MallGoods：goods_id=1002  price={id:1002,count:42}
  const MallGoods = types.MallGoods;
  const Item = types.CoreItem;
  assert.ok(MallGoods, 'MallGoods 必须已注册');
  assert.ok(Item, 'corepb.Item 必须已注册');

  const goodsBytes = MallGoods.encode(MallGoods.create({
    goods_id: 1002,
    name: '测试化肥',
    goods_type: 1,
    price: Item.create({ id: 1002, count: 42 }),
    reward_items: [Item.create({ id: 80011, count: 1 })],
    purchase_limit: types.PurchaseLimit
      ? types.PurchaseLimit.create({ limit_type: 1, bought_count: 2, limit_count: 3 })
      : undefined,
    is_free: false,
    is_available: true,
  })).finish();

  // 构造一个 Reply，goods_list 里塞上面这条
  const Reply = types.GetMallListBySlotTypeResponse;
  const replyBytes = Reply.encode(Reply.create({
    goods_list: [MallGoods.decode(goodsBytes)],
  })).finish();

  const decoded = Reply.decode(replyBytes);
  const list = decoded.goods_list;

  assert.ok(Array.isArray(list), 'goods_list 应是数组');
  assert.equal(list.length, 1);

  const g = list[0];
  assert.equal(typeof g, 'object');
  assert.ok(!Buffer.isBuffer(g), '⚠️ goods_list 元素不应是 Buffer（这是旧 bug 的判据）');

  // 关键字段可直读
  const num = v => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
  assert.equal(num(g.goods_id), 1002);
  assert.equal(num(g.price.id), 1002, 'price.id 应是货币道具 id');
  assert.equal(num(g.price.count), 42, 'price.count 才是价格');
  assert.equal(g.reward_items.length, 1, 'reward_items 应解出结构化 Item');
  assert.equal(num(g.reward_items[0].id), 80011);
});

test('对已结构化的 goods_list 再调 decode 会失败（证明旧写法必空）', () => {
  const MallGoods = types.MallGoods;
  const obj = MallGoods.create({ goods_id: 1, name: 'x' });
  // decode 期望 bytes，传对象会抛错；旧代码正是被 catch 吞掉
  assert.throws(() => MallGoods.decode(obj), '对对象调用 decode 应抛错');
});