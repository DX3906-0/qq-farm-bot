"""物品名称缺口审计：找出会显示为「物品#xxx」的物品 ID。

数据来源（任一有名称即视为已知）：
  1. core/src/gameConfig/ItemInfo.json
  2. core/src/config/gameConfig.js 的 staticItemInfoMap

候选来源（应尽量全覆盖）：
  - core/src/activity-data/*.json 的 item_id/itemId/seed_id/seedId/fruit_id/fruitId/product_id
  - core/src/**/*.js 的 *_ITEM_ID 常量
"""
import json
import os
import re

ROOT = 'D:/小工具/qq-farm-bot-main'

# ---- 已知名称 ----
names = set()
d = json.load(open(os.path.join(ROOT, 'core/src/gameConfig/ItemInfo.json'), encoding='utf-8'))
for it in (d if isinstance(d, list) else d.get('items', [])):
    if it.get('id'):
        names.add(int(it['id']))
info_count = len(names)

gc = open(os.path.join(ROOT, 'core/src/config/gameConfig.js'), encoding='utf-8').read()
m = re.search(r'const staticItemInfoMap = new Map\(\[(.*?)\]\);', gc, re.S)
static_ids = set()
if m:
    for mm in re.finditer(r'\[\s*(\d+)\s*,\s*\{', m.group(1)):
        static_ids.add(int(mm.group(1)))
names |= static_ids

# ---- 候选 ----
cand = {}

act_dir = os.path.join(ROOT, 'core/src/activity-data')
if os.path.isdir(act_dir):
    for f in os.listdir(act_dir):
        if not f.endswith('.json'):
            continue
        try:
            s = open(os.path.join(act_dir, f), encoding='utf-8').read()
        except Exception:
            continue
        for mm in re.finditer(
            r'"(?:item_id|itemId|seed_id|seedId|fruit_id|fruitId|product_id)"\s*:\s*"?(\d{3,7})"?', s
        ):
            cand.setdefault(int(mm.group(1)), set()).add(f)

for root, dirs, files in os.walk(os.path.join(ROOT, 'core/src')):
    if 'node_modules' in root:
        continue
    for f in files:
        if not f.endswith('.js'):
            continue
        fp = os.path.join(root, f)
        src = open(fp, encoding='utf-8', errors='replace').read()
        for mm in re.finditer(r'_ITEM_ID\s*=\s*(\d{3,7})', src):
            cand.setdefault(int(mm.group(1)), set()).add(os.path.relpath(fp, ROOT))

miss = {k: v for k, v in cand.items() if k not in names}

print('ItemInfo.json: %d | staticItemInfoMap: %d | 已知合计: %d' % (info_count, len(static_ids), len(names)))
print('候选 ID: %d | 无名称: %d' % (len(cand), len(miss)))
if miss:
    print()
    print('=== 无名称（会显示为「物品#xxx」）===')
    for k in sorted(miss):
        print('  %-8d <- %s' % (k, ', '.join(sorted(miss[k])[:3])))
else:
    print()
    print('=== 全部有名称 ===')
