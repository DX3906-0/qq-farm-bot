"""扫描 web/src 与 core/src 中所有字面量静态资源路径，校验磁盘存在性 —— 找真图裂。

静态根目录（按优先级）：
  /game-config/*  -> core/src/gameConfig/* 或 web/public/game-config/*
  /activity/* 等  -> web/public/*
"""
import os
import re

ROOT = 'D:/小工具/qq-farm-bot-main'
SRC_DIRS = [os.path.join(ROOT, 'web', 'src'), os.path.join(ROOT, 'core', 'src')]
SKIP = ('node_modules',)

PAT = re.compile(
    r"""['"`](/(?:activity|game-config)/[A-Za-z0-9_\-./]+\.(?:png|jpg|jpeg|webp|gif))['"`]"""
)


def candidates(p):
    rel = p.lstrip('/')
    if p.startswith('/game-config/'):
        tail = p[len('/game-config/'):]
        return [
            os.path.join(ROOT, 'core', 'src', 'gameConfig', tail),
            os.path.join(ROOT, 'web', 'public', 'game-config', tail),
        ]
    return [os.path.join(ROOT, 'web', 'public', rel)]


def exists(p):
    return any(os.path.isfile(c) for c in candidates(p))


found = {}
for d in SRC_DIRS:
    for root, dirs, files in os.walk(d):
        if any(s in root for s in SKIP):
            continue
        for f in files:
            if not f.endswith(('.ts', '.js', '.vue', '.mjs', '.cjs')):
                continue
            fp = os.path.join(root, f)
            try:
                src = open(fp, encoding='utf-8').read()
            except Exception:
                continue
            for m in PAT.finditer(src):
                found.setdefault(m.group(1), []).append(os.path.relpath(fp, ROOT))

bad = []
for p, refs in sorted(found.items()):
    if not exists(p):
        bad.append((p, sorted(set(refs))))

print('代码字面量引用: %d | 缺失: %d' % (len(found), len(bad)))
print()
if bad:
    print('=== 缺失（真图裂候选）===')
    for p, refs in bad:
        print('  %s' % p)
        for r in refs[:3]:
            print('      <- %s' % r)
else:
    print('=== 全部命中，无图裂 ===')
