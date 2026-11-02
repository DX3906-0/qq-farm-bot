#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同步 core/src/gameConfig 资源到服务器宿主机目录。

为什么需要它：
  deploy.py --src 的 SRC_SKIP_EXT 会跳过 .png/.webp 等二进制，
  所以新增的物品图标 / 作物阶段图 / 种子图不会被推上去；
  而 ./core/src 是宿主机 bind mount，直接写宿主机目录即对容器可见。

策略：只推送本地存在、且服务器缺失或大小不同的文件（增量，幂等）。

用法：
  python sync-gameconfig-assets.py --check   # 只列出待推送文件
  python sync-gameconfig-assets.py           # 执行推送
"""
import argparse
import io
import os
import posixpath
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(BASE, 'cloudbase', '.ref'))

import deploy  # noqa: E402

REMOTE_ROOT = 'qq-farm-bot-main/core/src/gameConfig'
LOCAL_ROOT = os.path.join(BASE, 'core', 'src', 'gameConfig')

# 只同步这些子目录/文件（避免误推 data/logs）
# deco_icons = 装扮/皮肤装饰图标（type=32 道具的 ItemInfo.icon_res 对应图），
# 用 .workbuddy/scripts/fetch-qqext-assets.py 从官方 CDN 取回，体积小、更新少。
INCLUDE_DIRS = ['plant_images', 'seed_images_named', 'deco_icons', 'effect_images']
INCLUDE_FILES = [
    'ItemInfo.json', 'Plant.json', 'EventPlants.json', 'MutantEffect.json',
    'LandLevel.json', 'LandLevelNeed.json', 'RoleLevel.json', 'WishSignRewards.json',
    'InvalidPlants.json',
]
BIN_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.json'}


def collect_local():
    """返回 {相对路径: 本地绝对路径}"""
    out = {}
    for name in INCLUDE_FILES:
        p = os.path.join(LOCAL_ROOT, name)
        if os.path.isfile(p):
            out[name] = p
    for d in INCLUDE_DIRS:
        root = os.path.join(LOCAL_ROOT, d)
        if not os.path.isdir(root):
            continue
        for cur, _dirs, files in os.walk(root):
            for fn in files:
                full = os.path.join(cur, fn)
                rel = os.path.relpath(full, LOCAL_ROOT).replace('\\', '/')
                out[rel] = full
    return out


def remote_sizes(cli, rels):
    """一次 SSH 批量取服务器文件大小，返回 {rel: size or -1}

    用 `find -printf '%s %p'` 一次拿全（逐文件 SFTP stat 会因往返次数多而极慢）。
    """
    wanted = set(rels)
    # 一次 find 两个子目录 + 顶层文件，输出 "size<TAB>相对路径"
    cmd = (
        f'cd {REMOTE_ROOT} && '
        "find . -type f -printf '%s %P\\n' 2>/dev/null"
    )
    out, _ = deploy.ssh_run(cli, cmd, timeout=180)
    sizes = {rel: -1 for rel in wanted}
    for line in (out or '').splitlines():
        parts = line.split(' ', 1)
        if len(parts) != 2:
            continue
        size_s, rel = parts
        rel = rel.strip().lstrip('./')
        if rel in wanted:
            try:
                sizes[rel] = int(size_s)
            except ValueError:
                pass
    return sizes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只列出待推送文件')
    args = ap.parse_args()

    local = collect_local()
    rels = sorted(local)
    print(f'本地候选文件: {len(rels)}')

    cli = deploy.ssh_connect()
    try:
        print('查询服务器现状...')
        sizes = remote_sizes(cli, rels)

        todo, unchanged, missing_remote = [], 0, 0
        for rel in rels:
            lsize = os.path.getsize(local[rel])
            rsize = sizes.get(rel, -1)
            if rsize < 0:
                todo.append(rel)
                missing_remote += 1
            elif rsize != lsize:
                todo.append(rel)
            else:
                unchanged += 1

        print(f'  服务器缺失: {missing_remote} | 大小不同: {len(todo) - missing_remote} '
              f'| 已一致: {unchanged} | 待推送: {len(todo)}')

        if args.check:
            for rel in todo[:60]:
                print('   +', rel)
            if len(todo) > 60:
                print(f'   ... 其余 {len(todo) - 60} 个')
            return 0

        if not todo:
            print('无需推送，服务器已是最新。')
            return 0

        # 建远端目录
        need_dirs = sorted({posixpath.dirname(posixpath.join(REMOTE_ROOT, r)) for r in todo})
        cmd = 'mkdir -p ' + ' '.join(f'"{d}"' for d in need_dirs)
        deploy.ssh_run(cli, cmd, timeout=120)

        # 批量上传
        sftp = cli.open_sftp()
        ok, fail = 0, []
        try:
            for i, rel in enumerate(todo, 1):
                rp = posixpath.join(REMOTE_ROOT, rel)
                try:
                    sftp.put(local[rel], rp)
                    ok += 1
                except Exception as exc:  # noqa: BLE001
                    fail.append((rel, str(exc)))
                if i % 50 == 0:
                    print(f'  ... {i}/{len(todo)}')
        finally:
            sftp.close()

        print(f'上传完成: ok={ok} fail={len(fail)}')
        for rel, err in fail[:10]:
            print('  FAIL', rel, err)

        # 复核
        sizes2 = remote_sizes(cli, todo)
        bad = [r for r in todo if sizes2.get(r, -1) != os.path.getsize(local[r])]
        print(f'复核: 不一致 {len(bad)} 个')
        for r in bad[:10]:
            print('   !', r)
        return 0 if not bad else 1
    finally:
        cli.close()


if __name__ == '__main__':
    sys.exit(main())
