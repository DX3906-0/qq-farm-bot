#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 404 参考副本（D:/小工具/_ref404）的 gameConfig 数据并集合并进本地。

策略：**只追加，不覆盖**。
  - ItemInfo.json : 404 是本地严格超集（同名 ID 内容 0 差异）→ 按 404 顺序输出全部 716 项
  - Plant.json    : 本地有 12 项 404 没有（本地为已适配活动手加）→ 404 全量 + 本地独有项追加尾部

用法：
  python merge-gameconfig-union.py --check     # 只报告，不写文件
  python merge-gameconfig-union.py             # 执行合并
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.path.abspath(os.path.join(HERE, '..', '..'))
REF404 = os.path.abspath(os.path.join(LOCAL, '..', '_ref404'))

TARGETS = ['ItemInfo.json', 'Plant.json']


def load_list(path):
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get('items') or list(data.values())[0]
    return data


def index_by_id(items):
    return {it['id']: it for it in items if isinstance(it, dict) and 'id' in it}


def merge(name, local_items, ref_items):
    """返回 (合并后列表, 追加的 id 列表)。只追加，不覆盖。"""
    ref_ids = {it['id'] for it in ref_items}
    local_ids = {it['id'] for it in local_items}

    merged = list(ref_items)                      # 以 404 全量为骨架（顺序稳定）
    extra = [it for it in local_items if it['id'] not in ref_ids]
    merged.extend(extra)

    added = sorted(ref_ids - local_ids)
    return merged, added, [it['id'] for it in extra]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只报告差异，不写文件')
    args = ap.parse_args()

    if not os.path.isdir(REF404):
        print(f'[错误] 404 参考副本不存在: {REF404}', file=sys.stderr)
        return 1

    for name in TARGETS:
        lp = os.path.join(LOCAL, 'core', 'src', 'gameConfig', name)
        rp = os.path.join(REF404, 'core', 'src', 'gameConfig', name)
        if not (os.path.isfile(lp) and os.path.isfile(rp)):
            print(f'[跳过] {name}: 文件缺失')
            continue

        local_items = load_list(lp)
        ref_items = load_list(rp)
        merged, added, extra = merge(name, local_items, ref_items)

        print(f'=== {name} ===')
        print(f'  本地 {len(local_items)} 项 | 404 {len(ref_items)} 项')
        print(f'  将追加 404 独有: {len(added)} 项 -> {added}')
        print(f'  保留本地独有:   {len(extra)} 项 -> {extra}')
        print(f'  合并后: {len(merged)} 项')

        if args.check:
            print('  [check 模式，未写入]')
            continue

        # 原子写：先写临时文件再替换
        tmp = lp + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(merged, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
        os.replace(tmp, lp)
        print(f'  [已写入] {lp}')
        print()

    return 0


if __name__ == '__main__':
    sys.exit(main())
