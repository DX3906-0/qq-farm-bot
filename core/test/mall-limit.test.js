const assert = require('node:assert/strict');
const test = require('node:test');

const { parseMallLimitInfo } = require('../src/services/mall');

/** 构造一个 protobuf varint 字段（field 编号 + 值）。 */
function varintField(fieldNum, value) {
  const bytes = [(fieldNum << 3) | 0]; // wireType 0 = varint
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

test('PurchaseLimit 按官方字段号解析：1=limit_type 2=bought 3=limit', () => {
  // limit_type=4(永久) bought_count=2 limit_count=3
  const buf = Buffer.concat([
    varintField(1, 4),
    varintField(2, 2),
    varintField(3, 3),
  ]);
  const info = parseMallLimitInfo(buf);

  assert.equal(info.limitType, 4, 'limit_type 应来自 field 1');
  assert.equal(info.boughtNum, 2, 'bought_count 应来自 field 2');
  assert.equal(info.limitCount, 3, 'limit_count 应来自 field 3');
});

test('限购周期四种类型都能正确识别', () => {
  const cases = [
    [1, '每日'],
    [2, '每周'],
    [3, '每月'],
    [4, '永久'],
  ];
  for (const [type, label] of cases) {
    const buf = Buffer.concat([varintField(1, type), varintField(3, 10)]);
    const info = parseMallLimitInfo(buf);
    assert.equal(info.limitType, type, `${label}限购的 limit_type 应为 ${type}`);
    assert.equal(info.limitCount, 10, `${label}限购的 limit_count 应为 10`);
  }
});

test('缺失 limit_count 时不把 limit_type 误当上限', () => {
  // 只下发 limit_type=1(每日)，没有 limit_count
  const buf = varintField(1, 1);
  const info = parseMallLimitInfo(buf);

  assert.equal(info.limitType, 1);
  assert.equal(info.limitCount, 0, 'limitCount 必须是 0，不能等于 limit_type');
  assert.equal(info.boughtNum, 0);
});

test('空数据返回全零而不是抛错', () => {
  for (const raw of [null, undefined, Buffer.alloc(0)]) {
    const info = parseMallLimitInfo(raw);
    assert.equal(info.limitType, 0);
    assert.equal(info.limitCount, 0);
    assert.equal(info.boughtNum, 0);
  }
});