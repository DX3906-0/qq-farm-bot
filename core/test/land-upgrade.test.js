const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLandUpgradeDetail } = require('../src/services/farm-land-upgrade');

test('land 21 keeps the exact server level and currency conditions and compares gold to crystal bonuses', () => {
    const landsMap = new Map(Array.from({ length: 21 }, (_, index) => [index + 1, { unlocked: true, level: 4 }]));
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 6,
        buff: { plant_yield_bonus: 30000, planting_time_reduction: 2000, plant_exp_bonus: 2000 },
        upgrade_condition: { preceeding_lands_count_need: 1, level_need: 150,
            items_need: [{ id: 1001, count: '450000000' }, { id: 1005, count: '18670' }] } }, landsMap);
    assert.equal(info.needLevel, 150);
    assert.deepEqual(info.costs.map(c => [c.id, c.count]), [['1001', '450000000'], ['1005', '18670']]);
    assert.equal(info.current.expBonus, 20);
    assert.equal(info.next.expBonus, 25);
    assert.equal(info.next.mutantMultiplier, 1.2);
    assert.equal(info.next.resonanceBonus, 25);
    assert.equal(info.unknown, false);
});

test('blue crystal level 6 shows official bonuses and max state', () => {
    const info = buildLandUpgradeDetail({ unlocked: true, level: 6, max_level: 6, buff: { plant_exp_bonus: 3000 } });
    assert.equal(info.mode, 'max');
    assert.equal(info.current.name, '蓝晶土地');
    assert.equal(info.current.yieldBonus, 400);
    assert.equal(info.current.growthReduction, 20);
    assert.equal(info.current.expBonus, 30);
    assert.equal(info.current.mutantMultiplier, 1.25);
    assert.equal(info.current.resonanceBonus, 30);
    assert.equal(info.next, null);
    assert.deepEqual(info.costs, []);
});

test('purple crystal to blue crystal uses official level, cost and preceding-land conditions', () => {
    const landsMap = new Map([
        [1, { id: 1, unlocked: true, level: 5 }],
        [2, { id: 2, unlocked: true, level: 5 }],
        [3, { id: 3, unlocked: true, level: 4 }],
    ]);
    const info = buildLandUpgradeDetail({
        id: 1, unlocked: true, level: 5, max_level: 6, could_upgrade: true,
        upgrade_condition: {
            preceeding_lands_count_need: 2,
            level_need: 125,
            items_need: [{ id: 1001, count: '100000000' }, { id: 1005, count: '11350' }],
        },
    }, landsMap);
    assert.equal(info.next.name, '蓝晶土地');
    assert.equal(info.needLevel, 125);
    assert.deepEqual(info.costs.map(c => [c.id, c.count]), [['1001', '100000000'], ['1005', '11350']]);
    assert.deepEqual(info.precedingLands, {
        name: '紫晶土地', required: 2, owned: 2, met: true,
    });
    assert.equal(info.serverAllowed, true);
    assert.equal(info.unknown, false);
});

test('unlocking shows prerequisite land and exact price instead of upgrade requirements', () => {
    const raw = { id: 8, unlocked: false, unlock_condition: { preceding_land_id: 7, need_level: 10, need_gold: 100000 } };
    const info = buildLandUpgradeDetail(raw, new Map([[7, { unlocked: true }]]));
    assert.equal(info.mode, 'unlock');
    assert.equal(info.needLevel, 10);
    assert.equal(info.prerequisite.met, true);
    assert.equal(info.costs[0].count, '100000');
    assert.equal(buildLandUpgradeDetail(raw).prerequisite.met, false);
});

test('malformed server condition stays unknown; known official fallback does not imply upgrade permission', () => {
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 6,
        upgrade_condition: { preceeding_lands_count_need: 1, level_need: 0, items_need: [] } });
    assert.equal(info.unknown, true);
    assert.equal(info.needLevel, null);
    const fallback = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 6 });
    assert.equal(fallback.needLevel, 150);
    assert.equal(fallback.serverAllowed, false);
    assert.equal(fallback.costs[1].count, '18670');
});
