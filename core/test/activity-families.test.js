const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACTIVITY_FAMILIES,
  getFamilyByActivityId,
  getFamilySubActivitySlots,
  getFamilySlots,
  extractSlotFingerprint,
  resolveActivityFamily,
  describeFamilyHint,
  listKnownFamilyActivityIds,
} = require('../src/config/activity-families');

test('族谱覆盖全部已适配活动，且成员 ID 全局唯一', () => {
  assert.ok(ACTIVITY_FAMILIES.length >= 8, '族数量不应少于已适配的活动族数');

  const seen = new Map();
  for (const family of ACTIVITY_FAMILIES) {
    assert.ok(family.key, '族必须有 key');
    assert.ok(family.name, '族必须有中文名');
    assert.ok(Array.isArray(family.slots) && family.slots.length > 0, `族 ${family.key} 必须声明槽位`);
    assert.ok(family.members.length > 0, `族 ${family.key} 必须有成员`);

    for (const member of family.members) {
      const id = Number(member.activityId);
      assert.ok(id > 0, `族 ${family.key} 成员 activityId 非法`);
      assert.ok(member.title, `族 ${family.key} 成员 ${id} 缺标题`);
      assert.equal(seen.has(id), false, `活动 ID ${id} 重复登记（${seen.get(id)} / ${family.key}）`);
      seen.set(id, family.key);

      for (const subId of member.subActivities || []) {
        assert.equal(seen.has(Number(subId)), false, `子活动 ID ${subId} 重复登记`);
        seen.set(Number(subId), family.key);
      }
    }
  }
});

test('按活动 ID 可定位族，子活动 ID 同样命中', () => {
  const helu = getFamilyByActivityId(2026060100);
  assert.equal(helu.key, 'helu-star');
  // 子活动 ID 也应归属同一族
  assert.equal(getFamilyByActivityId(2026060103).key, 'helu-star');
  assert.equal(getFamilyByActivityId(2026072702).key, 'helu-star');
  // 未登记 ID 返回 null
  assert.equal(getFamilyByActivityId(2099010100), null);
});

test('荷风游记与千星游记同族，且都映射到 journey 槽位（换皮依据）', () => {
  const slots = getFamilySubActivitySlots('helu-star');
  // 荷风游记(2026060103) 与千星游记在代码里共用 HeluPassportPanel，
  // 族谱必须把两者的槽位都登记为 journey，否则换皮时又要翻代码考古。
  assert.equal(slots[2026060103], 'journey');
  const journey = getFamilySlots('helu-star').find(item => item.slot === 'journey');
  assert.equal(journey.panel, 'HeluPassportPanel');
  assert.equal(journey.rpc, 'SeasonService');
});

test('槽位指纹归族：结构相近的未知活动能落到正确的族', () => {
  // 模拟一个未登记 ID、但下发 exchange_shop + draw_info 的新活动
  const resolved = resolveActivityFamily({
    id: 2099010100,
    title: '未来新活动',
    features: { exchangeShop: true, draw: true },
  });
  assert.equal(resolved.matched, true);
  assert.equal(resolved.byId, false);
  assert.equal(resolved.familyKey, 'helu-star');
  assert.ok(resolved.coverage > 0);
  // 参照成员应取族内最新活动
  assert.equal(resolved.member.activityId, 2026072700);
});

test('槽位指纹提取只认 ActivityNode 内的字段槽位', () => {
  const slots = extractSlotFingerprint({ features: { exchangeShop: true, draw: true, milkTea: true } });
  assert.deepEqual(slots.sort(), ['draw', 'exchangeShop', 'milkTea']);
  // 无特征返回空数组
  assert.deepEqual(extractSlotFingerprint({ features: {} }), []);
});

test('无法归族的活动给出明确的人工提示，不误报归属', () => {
  const resolved = resolveActivityFamily({ id: 2099010101, title: '陌生玩法', features: {} });
  assert.equal(resolved.matched, false);
  assert.equal(resolved.familyKey, '');
  assert.match(describeFamilyHint({ id: 2099010101, title: '陌生玩法', features: {} }), /需人工定族/);
});

test('已登记活动直接命中族并给出「照谁改」提示', () => {
  const hint = describeFamilyHint({ id: 2026060100, title: '荷风十里蝉初鸣', features: {} });
  assert.match(hint, /已登记/);
  assert.match(hint, /抽奖/);
  assert.match(hint, /换皮改造/);
});

test('已知活动 ID 列表含子活动，供发现层排除误报', () => {
  const ids = listKnownFamilyActivityIds();
  // 这些子活动 ID 未在 activity.js 导出常量中，曾导致被反复误报为新活动
  for (const id of [2026060103, 2026060104, 2026070301, 2026090101, 2026110100]) {
    assert.ok(ids.includes(id), `${id} 应包含在已知活动 ID 列表中`);
  }
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), '已知 ID 列表应升序');
});
