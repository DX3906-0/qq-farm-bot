'use strict';

// Pure presentation data only. Both the API and the frontend build use these
// rules; importing this module never loads a game session, files or RPC clients.
function buildMutationCatalog(raw, cfg, itemById = () => null, imageById = () => '') {
    if (!Array.isArray(raw) || !Array.isArray(cfg?.MutantPublicity)
        || !Array.isArray(cfg?.CollectionSeries) || !Array.isArray(cfg?.CollectionGroup)
        || !Array.isArray(cfg?.CollectionItem)) throw new TypeError('变异规则配置不完整');
    const rarityCandidates = new Map();
    for (const row of cfg.CollectionGroup) {
        const id = Number(row.source_rarity);
        const label = String(row.group_name || '').split('·').at(-1).trim();
        if (!Number.isSafeInteger(id) || id <= 0 || !label) continue;
        if (!rarityCandidates.has(id)) rarityCandidates.set(id, new Set());
        rarityCandidates.get(id).add(label);
    }
    // This is crop/source rarity, not collection-item rarity. Conflicting or
    // future names remain numeric rather than using an unrelated rarity enum.
    const rarityNames = Object.fromEntries([...rarityCandidates]
        .filter(([, labels]) => labels.size === 1).map(([id, labels]) => [id, [...labels][0]]));
    const effects = raw.filter(row => !row.hide_ui).sort((a, b) => Number(a.sort) - Number(b.sort)).map(row => {
        const [action, value] = String(row.actions || '').split(':').map(Number);
        const icon = String(row.icon || '').split('/').filter(Boolean).slice(-2, -1)[0] || '';
        return { id: row.id, name: row.effect_name, tag: row.tag,
            image: icon ? `/game-config/seed_images_named/mutant/${icon}.png` : '',
            description: row.tips || '',
            effect: action === 2 ? `产量×${value}` : action === 3 ? `售价×${value}` : action === 4 ? `产出${row.fruit_name || ''}` : '',
            effectType: action === 2 ? 'yield' : action === 3 ? 'price' : action === 4 ? 'produce' : 'other',
            probabilities: cfg.MutantPublicity.filter(entry => Number(entry.mutant_id) === Number(row.id))
                .map(entry => ({ rarity: entry.rarity, percent: Number(entry.public_probability) / 100 })) };
    });
    return { normal: effects.filter(value => value.tag === '无'), decoration: effects.filter(value => value.tag === '装扮'),
        collections: cfg.CollectionSeries.filter(series => Number(series.category) === 1 && !series.display).map(series => ({
            id: series.series_id, name: series.series_name, description: series.desc,
            groups: cfg.CollectionGroup.filter(group => group.series_id === series.series_id).map(group => ({
                name: group.group_name, probability: Number((group.public_probability / 100).toFixed(1)), guarantee: group.display_guarantee })),
            items: cfg.CollectionItem.filter(value => value.series_id === series.series_id).map(item => ({
                id: item.item_id, name: itemById(item.item_id)?.name || `藏品${item.item_id}`, image: imageById(item.item_id) || '' })),
        })), rarityNames, source: cfg.source, readOnly: true,
        note: '概率为公开配置的系列或变异概率，不等于单款藏品概率；保底按独立档位累计。' };
}
module.exports = { buildMutationCatalog };
