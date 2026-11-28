const assert = require('node:assert/strict');
const test = require('node:test');

const { parseMallPriceValue } = require('../src/services/mall');

function varintField(fieldNum, value) {
  const bytes = [(fieldNum << 3) | 0];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

test('PriceInfo 取数量(field 2)而非货币id(field 1)', () => {
  // id=1002(点券), count=42
  const buf = Buffer.concat([varintField(1, 1002), varintField(2, 42)]);
  assert.equal(parseMallPriceValue(buf), 42, '价格应为数量 42，不是货币 id 1002');
});

test('大数量不被 32 位截断成负数', () => {
  // 40 亿量级，位运算写法会溢出为负
  const big = 4000000000;
  const buf = Buffer.concat([varintField(1, 1002), varintField(2, big)]);
  const v = parseMallPriceValue(buf);
  assert.ok(v >= big * 0.99, `大数值应近似 ${big}，实际 ${v}`);
  assert.ok(v > 0, '不应为负数');
});

test('只有货币 id 没有数量时视为未定价', () => {
  const buf = varintField(1, 1005);
  assert.equal(parseMallPriceValue(buf), 0);
});

test('单字段按官方 PriceInfo 语义：field 1 是货币 id，不是价格', () => {
  assert.equal(parseMallPriceValue(varintField(1, 88)), 0, 'field 1 是货币 id，不能当价格');
});

test('空值与数字入参', () => {
  assert.equal(parseMallPriceValue(null), 0);
  assert.equal(parseMallPriceValue(undefined), 0);
  assert.equal(parseMallPriceValue(99), 99);
});