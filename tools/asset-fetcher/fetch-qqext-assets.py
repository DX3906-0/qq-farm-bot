# -*- coding: utf-8 -*-
"""按 QQ 小游戏 bundle 清单，从官方 CDN 批量取回美术资源（可复用）。

为什么需要它
------------
游戏的美术资源（装扮图标、图鉴图标、活动贴图…）不在 `miniapp_src` 里，而在远程
Cocos bundle 中，只有客户端**实际加载过**才会落到本地缓存
（`.../QQEX/miniapp/fs/<uin>/1112386029/usr/gamecaches/<bundle>/`）。
所以「本地没图」≠「游戏里没有」——只要能从 bundle 清单拿到 uuid + hash，
就可以**直接按 CDN 地址下载**，不必等客户端把那个界面点开。

定位链（已验证）
----------------
1. bundle 清单 JSON（缓存里形如 `<bundle>/<本地id>.json`，含 `name`/`uuids`/`paths`/`versions`）：
   - `paths` : `"<index>" -> ["<资产路径>", <type>, ...]`
   - `uuids` : `<index>` 取出**压缩 uuid**（22 字符）
   - `versions.native[index]` / `versions.import[index]` : 该资产的版本 hash
2. 压缩 uuid → 标准 GUID（Cocos 私有字母表，**不是**标准 base64 顺序）：
   - 字母表 `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`
   - 前 2 个字符原样保留；之后每 2 字符 → 3 个 hex：
     `hex0 = r >> 2`, `hex1 = ((r & 3) << 2) | (s >> 4)`, `hex2 = s & 0xF`
     （r/s 是两字符的 6bit 值），再按 8-4-4-4-12 插连字符。
3. 下载地址：
   - 图片：`https://cdn-resource.nqf.qq.com/release/remote/<bundle>/native/<前2位>/<GUID>.<nativeHash>.png`
   - 数据：`https://cdn-resource.nqf.qq.com/release/remote/<bundle>/import/<前2位>/<GUID>.<importHash>.json`

用法
----
  # 1) 从缓存清单里筛出目标资源（先 dry-run 看清单）
  python fetch-qqext-assets.py --cache <gamecaches目录> --list skinDecorationIcon

  # 2) 真正下载
  python fetch-qqext-assets.py --cache <gamecaches目录> \\
      --match skinDecorationIcon --out <输出目录>

  # 3) 只看某个账号的缓存（默认自动挑文件最多的那个）
  python fetch-qqext-assets.py --uin 1000000001 --match skinDecorationIcon --out out/

参数
----
  --cache   指定 gamecaches 目录（默认在 %APPDATA%\\QQEX\\miniapp\\fs\\*\\1112386029\\usr\\gamecaches 里自动挑）
  --uin     指定账号目录名（fs/<uin>）
  --bundle  限定 bundle（extraRes / mainscene / plant …），默认全部
  --match   资产路径包含该子串才下载（可多次）
  --names-file  只下载这些「资产名」（文件里一行一个，取路径最后一段做精确匹配）；
                用于"ItemInfo.icon_res 需要哪些就补哪些"，避免把整个目录几百个都拉下来
  --list    只列出匹配到的资产，不下载
  --out     输出目录；文件名取资产路径最后一段
  --dump-map  把匹配到的资产映射（名字→bundle/GUID/hash）写成 JSON，便于改版后核对/重拉
  --bundle-tag  文件名前缀加上 bundle 名（默认关）

注意
----
- CDN 是本游戏官方静态资源站，直连即可；本机走代理反而容易失败 → 统一 `--noproxy '*'`，
  Windows 证书吊销检查可能离线 → 统一 `--ssl-no-revoke`。
- 只读游戏缓存，不修改；输出写到 `--out`。
"""

import argparse
import glob
import io
import json
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CDN = "https://cdn-resource.nqf.qq.com/release/remote"
KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
VALS = {c: i for i, c in enumerate(KEYS)}


def uuid_to_guid(compact):
    """Cocos 压缩 uuid（22 字符）→ 标准 GUID。"""
    if len(compact) != 22:
        return ""
    hexes = [compact[0], compact[1]]
    for i in range(2, 22, 2):
        r = VALS.get(compact[i])
        s = VALS.get(compact[i + 1])
        if r is None or s is None:
            return ""
        hexes.append("%x" % (r >> 2))
        hexes.append("%x" % (((r & 3) << 2) | (s >> 4)))
        hexes.append("%x" % (s & 0xF))
    h = "".join(hexes)
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def pick_cache_dir(explicit, uin):
    if explicit:
        return explicit
    base = os.path.join(os.environ.get("APPDATA", ""), "QQEX", "miniapp", "fs")
    cands = []
    pattern = os.path.join(base, uin or "*", "1112386029", "usr", "gamecaches")
    for d in glob.glob(pattern):
        if not os.path.isdir(d):
            continue
        n = sum(len(fs) for _, _, fs in os.walk(d))
        cands.append((n, d))
    if not cands:
        return ""
    cands.sort(reverse=True)
    if len(cands) > 1:
        print("[i] 发现多个缓存目录，选文件最多的：")
        for n, d in cands[:5]:
            print("      %6d 文件  %s" % (n, d))
    return cands[0][1]


def load_bundle_manifests(cache_dir, bundle_filter):
    """从缓存里找出所有 bundle 清单 JSON 并解析。"""
    out = []
    for name in sorted(os.listdir(cache_dir)):
        sub = os.path.join(cache_dir, name)
        if not os.path.isdir(sub):
            continue
        if bundle_filter and name != bundle_filter:
            continue
        for fn in sorted(os.listdir(sub)):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(sub, fn)
            try:
                d = json.load(io.open(p, encoding="utf-8", errors="replace"))
            except Exception:
                continue
            if not isinstance(d, dict) or "uuids" not in d or "paths" not in d:
                continue
            out.append({"bundle": name, "file": p, "manifest": d})
    return out


def native_hash(manifest, index):
    arr = (manifest.get("versions") or {}).get("native")
    if not isinstance(arr, list):
        return None
    for j in range(0, len(arr) - 1, 2):
        if arr[j] == index:
            return arr[j + 1]
    return None


def collect(cache_dir, bundle_filter, matches, names=None):
    """names 非空时只保留「路径最后一段」精确命中的资产。"""
    hits = {}
    for entry in load_bundle_manifests(cache_dir, bundle_filter):
        m = entry["manifest"]
        uuids = m.get("uuids") or []
        for idx_s, val in (m.get("paths") or {}).items():
            path = val[0] if isinstance(val, (list, tuple)) and val else ""
            if not path:
                continue
            if matches and not any(k in path for k in matches):
                continue
            if names is not None and path.split("/")[-1] not in names:
                continue
            try:
                idx = int(idx_s)
                compact = uuids[idx]
            except Exception:
                continue
            guid = uuid_to_guid(compact)
            if not guid:
                continue
            h = native_hash(m, idx)
            if not h:
                continue
            name = path.split("/")[-1]
            hits.setdefault(name, []).append(
                {"bundle": entry["bundle"], "path": path, "guid": guid, "hash": h}
            )
    # 同名去重：优先 extraRes（UI 资源主要在这），其余按 bundle 名排序
    dedup = {}
    for name, lst in hits.items():
        lst.sort(key=lambda x: (x["bundle"] != "extraRes", x["bundle"]))
        dedup[name] = lst[0]
    return dedup


def download(entry, out_dir, prefix_bundle):
    guid, h, bundle = entry["guid"], entry["hash"], entry["bundle"]
    url = "%s/%s/native/%s/%s.%s.png" % (CDN, bundle, guid[:2], guid, h)
    stem = entry["path"].split("/")[-1]
    if prefix_bundle:
        stem = "%s__%s" % (bundle, stem)
    dst = os.path.join(out_dir, stem + ".png")
    r = subprocess.run(
        ["curl", "-s", "-o", dst, "-w", "%{http_code} %{size_download}",
         "-m", "60", "--noproxy", "*", "--ssl-no-revoke", url],
        capture_output=True, text=True,
    )
    parts = (r.stdout or "").split()
    code = parts[0] if parts else "0"
    size = int(parts[1]) if len(parts) > 1 else 0
    if code == "200" and size > 200:
        return True, size, url
    try:
        os.remove(dst)
    except Exception:
        pass
    return False, 0, url


def import_blue_crystal_asset(image_file, project_root=None, confirmed=False, single=False):
    """按固定 Git blob 校验并原字节同步 GitHub 单格/四格图；不拼铺、不冒称官方来源。"""
    import hashlib
    from pathlib import Path
    from PIL import Image

    root = Path(project_root) if project_root else Path(__file__).resolve().parents[2]
    candidate = Path(image_file)
    asset_name = 'land_valid6' if single else 'land_valid6_2x2'
    dimensions = [112, 64] if single else [356, 202]
    expected_sha = ('e5352c6190bbc11c84cc3271d9508535af7a9eb04457840d882d42703877de2e' if single
                    else 'aa885a4ca41d548aed705b736bce36f07ba67674b8b279fcc55d739fecf2acae')
    expected_blob = ('a5c7c5d3fd1786852501dfd9ba56d5846b26b168' if single
                     else 'd9a09f5c2ed6e8ebe3be96d5f6008cf2f80c0a2d')
    if not candidate.is_file() or candidate.is_symlink():
        raise RuntimeError('蓝晶四格候选文件不存在或为符号链接')
    raw = candidate.read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode('ascii') + b'\0' + raw).hexdigest()
    if hashlib.sha256(raw).hexdigest() != expected_sha or blob != expected_blob:
        raise RuntimeError('不是已核验 GitHub 蓝晶四格候选，不覆盖资源')
    image = Image.open(io.BytesIO(raw))
    image.load()
    if image.format != 'PNG' or image.mode != 'RGBA' or list(image.size) != dimensions:
        raise RuntimeError('蓝晶候选图像格式或尺寸变化，需重新核验')
    commit = '669f5969ad03fe60b68df9440b02bb7a503fafa8'
    asset_path = 'web/public/game-config/land_images/' + asset_name + '.png'
    entry = {
        'kind': 'github-single-land-candidate' if single else 'github-four-cell-candidate',
        'independentOfficialAsset': False,
        'officialOriginVerified': False,
        'previewOnly': not confirmed,
        'userConfirmedApplication': bool(confirmed),
        'url': '/game-config/land_images/' + asset_name + '.png',
        'source': {
            'repository': 'BUGDey/qq-farm-bot', 'commit': commit, 'path': asset_path,
            'url': 'https://github.com/BUGDey/qq-farm-bot/blob/' + commit + '/' + asset_path,
            'gitBlob': expected_blob, 'sha256': expected_sha, 'size': dimensions,
            'matchingRepository': 'aaang99/qq-farm-bot-404',
            'matchingCommit': 'ffb66f6551ad178423236f0e8d105f33c8f2c4a4',
            'provenance': 'GitHub pixels and commit verified; official CDN/GUID and asset permission not independently verified.',
        },
        'layout': {
            'cellCount': 1 if single else 4, 'outerFrameCount': 1,
            'nativeSize': dimensions, 'outputSize': dimensions, 'resampling': 'none',
            'description': ('Blue-crystal small-land texture from the same upstream commit; original PNG bytes without edits.' if single
                            else 'One continuous blue-crystal frame containing four inner faces; original PNG bytes copied without edits.'),
        },
        'sha256': expected_sha,
    }
    destinations = []
    # 两根先完整预检，再写入；不触及单格6.png或其它级别已有资源。
    for parent in [root / 'core/src/gameConfig', root / 'web/public/game-config']:
        if not parent.is_dir() or parent.is_symlink():
            raise RuntimeError('资源父目录不存在或为符号链接')
        folder = parent / 'land_images'
        if not folder.is_dir() or folder.is_symlink():
            raise RuntimeError('土地资源目录不存在或为符号链接')
        image_path = folder / (asset_name + '.png')
        map_path = folder / 'sources.json'
        if image_path.is_symlink() or map_path.is_symlink():
            raise RuntimeError('资源或映射路径不安全')
        mapping = json.loads(map_path.read_text(encoding='utf-8')) if map_path.exists() else {}
        if not isinstance(mapping, dict):
            raise RuntimeError('土地来源映射不是对象')
        mapping[asset_name] = entry
        destinations.append((image_path, map_path, mapping))
    for image_path, map_path, mapping in destinations:
        image_path.write_bytes(raw)
        map_path.write_text(json.dumps(mapping, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
        if image_path.read_bytes() != raw:
            raise RuntimeError('四格蓝晶候选写入字节不一致')
    print(json.dumps({'ok': True, 'previewOnly': not confirmed, 'officialOriginVerified': False,
                      'bytesUnchanged': True, 'size': dimensions, 'sha256': expected_sha}, ensure_ascii=True))
    return 0


def import_blue_crystal_2x2(image_file, project_root=None, confirmed=False):
    return import_blue_crystal_asset(image_file, project_root, confirmed=confirmed)


def import_avatar_assets(cache_dir, project_root=None, download_missing=False, verify_only=False):
    """Import exact official avatar/nameplate PNGs and atlas crops into both roots.

    Only cacheList.json references are read; QQ caches are never modified. The
    newest extraRes manifest is selected by its concrete local file timestamp,
    not filesystem enumeration or old last-access times. All images and source
    metadata are prepared and validated before the first project-resource write.
    """
    import hashlib
    import re
    from datetime import datetime, timezone
    from pathlib import Path
    from PIL import Image

    root = Path(project_root) if project_root else Path(__file__).resolve().parents[2]
    core = root / 'core/src/gameConfig'
    web = root / 'web/public/game-config'
    if not core.is_dir() or not web.is_dir():
        raise RuntimeError('头像资源双根父目录不存在')
    if verify_only:
        mapping_file = core / 'deco_icons/avatar-frame-sources.json'
        mapping = json.loads(mapping_file.read_text(encoding='utf-8'))
        for entry in mapping['items'].values():
            if entry['officialOriginVerified'] is not True:
                raise RuntimeError('头像素材缺少官方来源证明')
            relative = entry['url'].removeprefix('/game-config/')
            first, second = core / relative, web / relative
            raw = first.read_bytes()
            if raw != second.read_bytes() or hashlib.sha256(raw).hexdigest() != entry['sha256']:
                raise RuntimeError('头像素材双根/hash不一致：' + relative)
            image = Image.open(io.BytesIO(raw))
            image.load()
            if image.format != 'PNG' or list(image.size) != entry['size']:
                raise RuntimeError('头像素材PNG尺寸不一致：' + relative)
        if mapping_file.read_bytes() != (web / 'deco_icons/avatar-frame-sources.json').read_bytes():
            raise RuntimeError('头像素材来源映射双根不一致')
        print(json.dumps({'ok': True, 'items': len(mapping['items']), 'dualRoot': True,
                          'hashesVerified': True, 'noNetwork': True}, ensure_ascii=False))
        return 0

    cache = Path(cache_dir)
    index = json.loads((cache / 'cacheList.json').read_text(encoding='utf-8'))['files']
    prefix = 'qqfile://usr/gamecaches/'
    entries = {}
    for url, meta in index.items():
        local = str(meta.get('url') or '')
        if not local.startswith(prefix):
            continue
        candidate = cache / local[len(prefix):]
        if candidate.is_file() and not candidate.is_symlink():
            entries[url] = candidate
    manifests = [(url, file) for url, file in entries.items()
                 if re.fullmatch(re.escape(CDN) + r'/extraRes/config\.[a-f0-9]+\.json', url)]
    if not manifests:
        raise RuntimeError('没有可证明来源的extraRes清单')
    manifest_url, manifest_file = max(manifests, key=lambda entry: entry[1].stat().st_mtime_ns)
    manifest_raw = manifest_file.read_bytes()
    manifest = json.loads(manifest_raw)
    native = {manifest['versions']['native'][i]: manifest['versions']['native'][i + 1]
              for i in range(0, len(manifest['versions']['native']), 2)}
    paths = manifest['paths']
    definitions = json.loads((core / 'ItemInfo.json').read_text(encoding='utf-8'))
    definitions = definitions if isinstance(definitions, list) else list(definitions.values())
    wanted = [item for item in definitions if int(item.get('type') or 0) == 10
              and re.search('头像框|铭牌', item.get('name') or '') and item.get('icon_res')]
    missing_definition = [item['id'] for item in definitions if int(item.get('type') or 0) == 10
                          and re.search('头像框|铭牌', item.get('name') or '') and not item.get('icon_res')]
    assert (root / '.workbuddy').is_dir()
    stage = root / '.workbuddy/avatar-assets-20261111'
    stage.mkdir(exist_ok=True)
    source_raws = {}
    download_count = 0

    def resource_bytes(url):
        nonlocal download_count
        if url in source_raws:
            return source_raws[url]
        local = entries.get(url)
        if local:
            raw = local.read_bytes()
            # 公共溯源只记录缓存内相对路径，不暴露本机用户名、账号目录或绝对路径。
            origin = {'kind': 'official-local-cache', 'url': url,
                      'cacheFile': local.relative_to(cache).as_posix(), 'sha256': hashlib.sha256(raw).hexdigest()}
        else:
            if not download_missing:
                raise RuntimeError('缺少精确版本缓存，使用--download-missing才可下载：' + url)
            if not url.startswith(CDN + '/'):
                raise RuntimeError('拒绝非官方静态资源站')
            dst = stage / url.rsplit('/', 1)[-1]
            result = subprocess.run(['curl', '-sS', '--fail', '--noproxy', '*', '--ssl-no-revoke',
                                     '-m', '45', '-o', str(dst), url], capture_output=True, text=True)
            if result.returncode != 0 or not dst.is_file():
                raise RuntimeError('官方静态资源下载失败：' + url)
            raw = dst.read_bytes()
            origin = {'kind': 'official-cdn', 'url': url, 'sha256': hashlib.sha256(raw).hexdigest()}
            download_count += 1
        source_raws[url] = (raw, origin)
        return raw, origin

    def native_url(uuid_index):
        compact = str(manifest['uuids'][uuid_index]).split('@')[0]
        guid = uuid_to_guid(compact) if len(compact) == 22 else compact
        version = native.get(uuid_index)
        if not guid or not version:
            raise RuntimeError('原生纹理缺失GUID/hash')
        return '%s/extraRes/native/%s/%s.%s.png' % (CDN, guid[:2], guid, version), guid, version

    def named_objects(value, name):
        found = []
        def walk(node):
            if isinstance(node, dict):
                if node.get('name') == name and 'rect' in node and 'originalSize' in node:
                    found.append(node)
                for child in node.values():
                    walk(child)
            elif isinstance(node, list):
                for child in node:
                    walk(child)
        walk(value)
        return found

    def get_sprite_crop(sprite_index, stem):
        pack_names = [name for name, members in manifest['packs'].items() if sprite_index in members]
        if len(pack_names) != 1:
            raise RuntimeError('头像图集包不是唯一：' + stem)
        name = pack_names[0]
        package_urls = [url for url in entries if re.fullmatch(re.escape(CDN) + '/extraRes/import/'
                        + re.escape(name[:2] + '/' + name) + r'\.[a-f0-9]+\.json', url)]
        if len(package_urls) != 1:
            raise RuntimeError('找不到精确头像图集包缓存：' + stem)
        package_url = package_urls[0]
        package_raw, package_origin = resource_bytes(package_url)
        package = json.loads(package_raw)
        members = named_objects(package, stem)
        if len(members) != 1:
            raise RuntimeError('图集里头像矩形不是唯一：' + stem)
        frame = members[0]
        dependency = package[1]
        if len(dependency) != 1 or not str(dependency[0]).endswith('@6c48a'):
            raise RuntimeError('图集纹理关联未验证，拒绝猜测：' + stem)
        texture_uuid = dependency[0].split('@')[0]
        texture_indices = [i for i, value in enumerate(manifest['uuids']) if value == texture_uuid and i in native]
        if len(texture_indices) != 1:
            raise RuntimeError('图集原生纹理不是唯一')
        url, guid, version = native_url(texture_indices[0])
        texture_raw, texture_origin = resource_bytes(url)
        atlas = Image.open(io.BytesIO(texture_raw))
        atlas.load()
        if atlas.format != 'PNG':
            raise RuntimeError('头像图集不是PNG')
        atlas = atlas.convert('RGBA')
        rect = frame['rect']
        x, y, width, height = [int(rect[key]) for key in ('x', 'y', 'width', 'height')]
        rotated = frame.get('rotated') is True
        stored_w, stored_h = (height, width) if rotated else (width, height)
        if x < 0 or y < 0 or x + stored_w > atlas.width or y + stored_h > atlas.height:
            raise RuntimeError('头像图集矩形越界：' + stem)
        cropped = atlas.crop((x, y, x + stored_w, y + stored_h))
        if rotated:
            # Cocos packs rotated frames clockwise. Losslessly rotate the stored
            # pixels counter-clockwise, then restore the authoritative trim offset.
            cropped = cropped.transpose(Image.Transpose.ROTATE_90)
        if cropped.size != (width, height):
            raise RuntimeError('头像裁剪像素尺寸不一致')
        original = frame['originalSize']
        canvas = Image.new('RGBA', (int(original['width']), int(original['height'])), (0, 0, 0, 0))
        left = (canvas.width - width) / 2 + frame['offset']['x']
        top = (canvas.height - height) / 2 - frame['offset']['y']
        if not left.is_integer() or not top.is_integer() or min(left, top) < 0:
            raise RuntimeError('头像裁剪偏移不在像素边界')
        canvas.paste(cropped, (int(left), int(top)))
        if canvas.crop((int(left), int(top), int(left) + width, int(top) + height)).tobytes() != cropped.tobytes():
            raise RuntimeError('图集裁剪恢复发生像素改变')
        output = io.BytesIO()
        canvas.save(output, format='PNG')
        return output.getvalue(), {'kind': 'official-atlas-extraction', 'url': url, 'guid': guid,
                'nativeHash': version, 'sourceTexture': texture_origin, 'sourcePack': package_origin,
                'rect': rect, 'rotated': rotated, 'originalSize': original, 'offset': frame['offset'],
                'resampling': 'none', 'restoredTransparentMargins': True}

    results = {}
    raw_images = {}
    for item in wanted:
        resource = str(item['icon_res'])
        base = re.sub(r'/(spriteFrame|texture)$', '', resource)
        stem = base.rsplit('/', 1)[-1]
        candidates = [(int(index), info) for index, info in paths.items()
                      if info[0] == base and int(index) in native]
        if len(candidates) == 1:
            url, guid, version = native_url(candidates[0][0])
            raw, origin = resource_bytes(url)
            origin = {**origin, 'guid': guid, 'nativeHash': version, 'bytesUnchanged': True}
        else:
            sprites = [int(index) for index, info in paths.items() if info[0] == resource
                       and manifest['types'][info[1]] == 'cc.SpriteFrame']
            if len(sprites) != 1:
                raise RuntimeError('没有唯一官方头像资源：' + resource)
            raw, origin = get_sprite_crop(sprites[0], stem)
        image = Image.open(io.BytesIO(raw))
        image.load()
        if image.format != 'PNG' or min(image.size) < 20:
            raise RuntimeError('无效头像PNG：' + stem)
        if stem in raw_images and raw_images[stem] != raw:
            raise RuntimeError('同名头像素材冲突')
        raw_images[stem] = raw
        results[str(item['id'])] = {'itemId': item['id'], 'frameId': item.get('target_id') or item['id'],
            'frameType': 2 if '铭牌' in item['name'] else 1, 'name': item['name'], 'resource': resource,
            'url': '/game-config/deco_icons/' + stem + '.png', 'size': list(image.size),
            'sha256': hashlib.sha256(raw).hexdigest(), 'officialOriginVerified': True,
            'source': origin}
    if len(results) != len(wanted):
        raise RuntimeError('未准备齐全部头像素材，拒绝部分写入')
    source = {'kind': 'official-cocos-avatar-assets', 'localOnly': True,
              'importedAt': datetime.now(timezone.utc).isoformat(), 'manifest': {'url': manifest_url,
              'sha256': hashlib.sha256(manifest_raw).hexdigest(), 'bundle': manifest['name']},
              'unresolvedPrototypeItemIds': missing_definition, 'items': results}
    source_raw = (json.dumps(source, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    for parent in (core, web):
        folder = parent / 'deco_icons'
        if not folder.is_dir() or folder.is_symlink():
            raise RuntimeError('deco_icons双根目录不存在或不安全')
        for stem, raw in raw_images.items():
            target = folder / (stem + '.png')
            if target.is_symlink():
                raise RuntimeError('头像目标为符号链接')
        if (folder / 'avatar-frame-sources.json').is_symlink():
            raise RuntimeError('头像来源映射目标为符号链接')
    for parent in (core, web):
        folder = parent / 'deco_icons'
        for stem, raw in raw_images.items():
            (folder / (stem + '.png')).write_bytes(raw)
        (folder / 'avatar-frame-sources.json').write_bytes(source_raw)
    print(json.dumps({'ok': True, 'items': len(results),
          'avatarFrames': sum(entry['frameType'] == 1 for entry in results.values()),
          'nameplates': sum(entry['frameType'] == 2 for entry in results.values()),
          'atlasCrops': sum(entry['source']['kind'] == 'official-atlas-extraction' for entry in results.values()),
          'downloadedStaticFiles': download_count, 'unresolvedPrototypeItemIds': missing_definition,
          'localOnly': True, 'gameRpcSent': False}, ensure_ascii=False))
    return import_avatar_assets(cache_dir, root, verify_only=True)


def art_uuid(value, keep_suffix=False):
    """Decode a manifest UUID, including packed IDs and optional SpriteFrame suffixes."""
    import re
    base, separator, suffix = str(value).partition('@')
    guid = uuid_to_guid(base) if len(base) == 22 else base
    if not re.fullmatch(r'(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{9})', guid):
        raise ValueError('Unsupported manifest UUID: ' + str(value))
    if separator and not re.fullmatch(r'[a-f0-9]+', suffix):
        raise ValueError('Unsupported SpriteFrame suffix')
    return guid + ('@' + suffix if keep_suffix and separator else '')


def art_version_map(manifest, kind):
    values = (manifest.get('versions') or {}).get(kind) or []
    if len(values) % 2:
        raise ValueError('Incomplete ' + kind + ' version pairs')
    return dict(zip(values[::2], values[1::2]))


def art_crop_frame(image, frame):
    """Restore an authoritative Cocos SpriteFrame without scaling or invented pixels."""
    from PIL import Image
    rect, original, offset = frame['rect'], frame['originalSize'], frame['offset']
    values = [float(rect[key]) for key in ('x', 'y', 'width', 'height')]
    if any(not number.is_integer() for number in values):
        raise ValueError('Sprite rectangle is not pixel aligned')
    x, y, width, height = [int(number) for number in values]
    rotated = frame.get('rotated') is True
    stored_w, stored_h = (height, width) if rotated else (width, height)
    if min(x, y) < 0 or min(width, height) <= 0 or x + stored_w > image.width or y + stored_h > image.height:
        raise ValueError('Sprite rectangle exceeds texture bounds')
    cropped = image.convert('RGBA').crop((x, y, x + stored_w, y + stored_h))
    if rotated:
        cropped = cropped.transpose(Image.Transpose.ROTATE_90)
    canvas = Image.new('RGBA', (int(original['width']), int(original['height'])), (0, 0, 0, 0))
    left = (canvas.width - width) / 2 + float(offset['x'])
    top = (canvas.height - height) / 2 - float(offset['y'])
    if not left.is_integer() or not top.is_integer() or min(left, top) < 0:
        raise ValueError('Sprite trim offset is not pixel aligned')
    if left + width > canvas.width or top + height > canvas.height:
        raise ValueError('Restored sprite exceeds original bounds')
    canvas.paste(cropped, (int(left), int(top)))
    if canvas.crop((int(left), int(top), int(left) + width, int(top) + height)).tobytes() != cropped.tobytes():
        raise ValueError('Sprite restoration changed source pixels')
    return canvas


class OfficialArtResolver:
    """Resolve only versioned assets declared by an explicitly supplied official manifest."""
    def __init__(self, cache_dir, settings_file, stage, manifest_sources=None):
        import hashlib
        import re
        import threading
        from pathlib import Path
        self.cache = Path(cache_dir) if cache_dir else None
        self.stage = Path(stage)
        self.entries, self.resources, self.locks = {}, {}, {}
        self.guard = threading.Lock()
        self.download_count = 0
        index = json.loads((self.cache / 'cacheList.json').read_text(encoding='utf-8'))['files'] if self.cache else {}
        for url, metadata in index.items():
            local = str(metadata.get('url') or '')
            prefix = 'qqfile://usr/gamecaches/'
            if not local.startswith(prefix):
                continue
            file = self.cache / local[len(prefix):]
            if not file.resolve().is_relative_to(self.cache.resolve()):
                raise ValueError('Cache reference escapes the supplied directory')
            if file.is_file() and not file.is_symlink():
                self.entries[url] = file
        # 续跑只复用已登记的精确清单/hash，不重新扫描或修改个人QQ缓存。
        if manifest_sources is not None:
            self.manifests = []
            for source in manifest_sources:
                match = re.fullmatch(re.escape(CDN) + r'/([A-Za-z0-9]+)/config\.[a-f0-9]+\.json', str(source.get('url') or ''))
                if not match or not re.fullmatch(r'[a-f0-9]{64}', str(source.get('sha256') or '')):
                    raise ValueError('Invalid recorded official manifest evidence')
                raw, _origin = self.resource_bytes(source['url'])
                if hashlib.sha256(raw).hexdigest() != source['sha256']:
                    raise ValueError('Recorded official manifest hash changed')
                manifest = json.loads(raw)
                if manifest.get('name') != match[1]:
                    raise ValueError('Recorded manifest bundle name mismatch')
                self.manifests.append({'bundle': match[1], 'manifest': manifest, 'source': source})
            if not self.manifests:
                raise ValueError('No verified manifests available for resuming')
            return
        settings_raw = Path(settings_file).read_bytes()
        settings = json.loads(settings_raw)['assets']
        if settings.get('server') != 'https://cdn-resource.nqf.qq.com/release/':
            raise ValueError('Settings do not declare the verified official CDN')
        self.manifests = []
        for bundle in ('extraRes', 'plant', 'mainscene', 'delayRes', 'animal', 'mcRes', 'petdog'):
            version = (settings.get('bundleVers') or {}).get(bundle)
            if not version or not re.fullmatch(r'[a-f0-9]+', version):
                continue
            url = CDN + '/' + bundle + '/config.' + version + '.json'
            raw, _origin = self.resource_bytes(url)
            manifest = json.loads(raw)
            if manifest.get('name') != bundle:
                raise ValueError('Manifest bundle name mismatch')
            self.manifests.append({'bundle': bundle, 'manifest': manifest,
                'source': {'url': url, 'sha256': hashlib.sha256(raw).hexdigest(),
                           'settingsSha256': hashlib.sha256(settings_raw).hexdigest()}})

    def resource_bytes(self, url):
        import hashlib
        import re
        if not re.fullmatch(re.escape(CDN) + r'/[A-Za-z0-9]+/(?:config\.[a-f0-9]+\.json|(?:import|native)/[a-f0-9]{2}/[a-f0-9@.-]+\.(?:json|png|astc))', url):
            raise ValueError('Refusing an undeclared/non-static CDN request')
        with self.guard:
            lock = self.locks.setdefault(url, __import__('threading').Lock())
        with lock:
            if url in self.resources:
                return self.resources[url]
            cached = self.entries.get(url)
            if cached:
                raw = cached.read_bytes()
                kind = 'official-local-cache'
            else:
                extension = '.' + url.rsplit('.', 1)[-1]
                file = self.stage / (hashlib.sha256(url.encode()).hexdigest() + extension)
                if file.is_file():
                    raw = file.read_bytes()
                else:
                    result = subprocess.run(['curl', '-sS', '--fail', '--noproxy', '*', '--ssl-no-revoke',
                        '--connect-timeout', '10', '--max-time', '35', url], capture_output=True)
                    if result.returncode:
                        raise RuntimeError('Static CDN request failed (' + str(result.returncode) + '): ' + url)
                    raw = result.stdout
                    if not raw:
                        raise RuntimeError('Empty static CDN response: ' + url)
                    file.write_bytes(raw)
                    with self.guard:
                        self.download_count += 1
                kind = 'official-cdn'
            value = (raw, {'kind': kind, 'url': url, 'sha256': hashlib.sha256(raw).hexdigest()})
            self.resources[url] = value
            return value

    def native_image(self, entry, index):
        from PIL import Image
        manifest, bundle = entry['manifest'], entry['bundle']
        guid = art_uuid(manifest['uuids'][index])
        version = art_version_map(manifest, 'native').get(index)
        if not version:
            raise ValueError('No authoritative native version')
        base = CDN + '/' + bundle + '/native/' + guid[:2] + '/' + guid + '.' + version
        try:
            raw, source = self.resource_bytes(base + '.png')
            image = Image.open(io.BytesIO(raw))
            image.load()
            if image.format != 'PNG':
                raise ValueError('CDN PNG is not a decoded PNG')
            return raw, image, {**source, 'guid': guid, 'nativeHash': version, 'bytesUnchanged': True}
        except RuntimeError as error:
            # These are the two formats supported by the existing official extractor;
            # a missing PNG may legitimately be available only as an ASTC texture.
            if 'failed (22)' not in str(error):
                raise
        raw, source = self.resource_bytes(base + '.astc')
        if raw[:4] != b'\x13\xab\xa1\x5c' or len(raw) < 16 or raw[6] != 1:
            raise ValueError('Unsupported ASTC header')
        width = int.from_bytes(raw[7:10], 'little')
        height = int.from_bytes(raw[10:13], 'little')
        if int.from_bytes(raw[13:16], 'little') != 1 or min(width, height) <= 0 or max(width, height) > 8192:
            raise ValueError('Unsupported ASTC dimensions')
        import texture2ddecoder
        pixels = texture2ddecoder.decode_astc(raw[16:], width, height, raw[4], raw[5])
        image = Image.frombytes('RGBA', (width, height), pixels, 'raw', 'BGRA')
        output = io.BytesIO()
        image.save(output, format='PNG')
        return output.getvalue(), image, {**source, 'guid': guid, 'nativeHash': version,
            'decodedFormat': 'ASTC', 'decodedSize': [width, height], 'resampling': 'none', 'bytesUnchanged': False}

    def resolve(self, resource, preferred_bundle=''):
        from PIL import Image
        base = str(resource).removesuffix('/spriteFrame').removesuffix('/texture')
        entries = sorted(self.manifests, key=lambda value: value['bundle'] != preferred_bundle)
        for entry in entries:
            manifest = entry['manifest']
            native = art_version_map(manifest, 'native')
            direct = [int(index) for index, info in manifest['paths'].items()
                if info[0] == base and int(index) in native and manifest['types'][info[1]] == 'cc.ImageAsset']
            if len(direct) == 1:
                raw, _image, source = self.native_image(entry, direct[0])
                return raw, {**source, 'manifest': entry['source'], 'resource': base, 'officialOriginVerified': True}
            sprites = [int(index) for index, info in manifest['paths'].items()
                if info[0] == base + '/spriteFrame' and manifest['types'][info[1]] == 'cc.SpriteFrame']
            if len(sprites) != 1:
                continue
            sprite = sprites[0]
            packs = [name for name, members in manifest.get('packs', {}).items() if sprite in members]
            if len(packs) > 1:
                raise ValueError('Ambiguous sprite pack')
            import_versions = art_version_map(manifest, 'import')
            pack_name = packs[0] if packs else None
            if pack_name:
                indices = [i for i, value in enumerate(manifest['uuids']) if value == pack_name]
                if len(indices) != 1:
                    raise ValueError('Ambiguous pack UUID')
                guid = art_uuid(pack_name)
                version = import_versions.get(indices[0])
            else:
                guid = art_uuid(manifest['uuids'][sprite], keep_suffix=True)
                version = import_versions.get(sprite)
            if not version:
                raise ValueError('Sprite has no authoritative import hash')
            url = CDN + '/' + entry['bundle'] + '/import/' + guid[:2] + '/' + guid + '.' + version + '.json'
            imported, pack_source = self.resource_bytes(url)
            package = json.loads(imported)
            frames = []
            def walk(value):
                if isinstance(value, dict):
                    if value.get('name') == base.rsplit('/', 1)[-1] and all(key in value for key in ('rect', 'originalSize', 'offset')):
                        frames.append(value)
                    for child in value.values():
                        walk(child)
                elif isinstance(value, list):
                    for child in value:
                        walk(child)
            walk(package)
            if len(frames) != 1 or not isinstance(package[1], list) or len(package[1]) != 1:
                raise ValueError('Sprite rectangle/texture dependency is not unique')
            texture_guid = art_uuid(package[1][0])
            textures = [i for i, value in enumerate(manifest['uuids'])
                        if i in native and art_uuid(value) == texture_guid]
            if len(textures) != 1:
                raise ValueError('Sprite native texture is not unique')
            _raw, atlas, texture_source = self.native_image(entry, textures[0])
            image = art_crop_frame(atlas, frames[0])
            output = io.BytesIO()
            image.save(output, format='PNG')
            return output.getvalue(), {'kind': 'official-atlas-extraction', 'manifest': entry['source'],
                'resource': base, 'officialOriginVerified': True, 'sourcePack': pack_source,
                'sourceTexture': texture_source, 'rect': frames[0]['rect'], 'offset': frames[0]['offset'],
                'originalSize': frames[0]['originalSize'], 'rotated': frames[0].get('rotated') is True,
                'resampling': 'none', 'restoredTransparentMargins': True}
        raise LookupError('Not declared by the supplied official manifests: ' + base)


def complete_project_art_assets(cache_dir, settings_file, baseline_file, stage_dir, upstream_hints='', project_root=None,
                                resume=False):
    """Add verified missing artwork; preserve every pre-existing image and gameplay setting."""
    import hashlib
    import re
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from datetime import datetime, timezone
    from pathlib import Path
    from urllib.parse import unquote, urlparse
    from PIL import Image
    root = Path(project_root) if project_root else Path(__file__).resolve().parents[2]
    core, web = root / 'core/src/gameConfig', root / 'web/public/game-config'
    stage = Path(stage_dir)
    if not core.is_dir() or not web.is_dir() or not stage.is_dir() or not stage.resolve().is_relative_to((root / '.workbuddy').resolve()):
        raise ValueError('Resource roots/stage are not existing project directories')
    baseline = json.loads(Path(baseline_file).read_text(encoding='utf-8'))
    definitions = json.loads((core / 'ItemInfo.json').read_text(encoding='utf-8'))
    items = {int(item['id']): item for item in definitions}
    previous_index, previous_result = {}, {}
    source_file = core / 'art-resource-sources.json'
    if source_file.is_file():
        if source_file.read_bytes() != (web / 'art-resource-sources.json').read_bytes():
            raise ValueError('Existing artwork source indexes disagree')
        previous_index = json.loads(source_file.read_text(encoding='utf-8'))
        for relative, source in previous_index.get('items', {}).items():
            if relative.startswith('/') or '..' in relative.split('/'):
                raise ValueError('Unsafe recorded artwork path')
            for parent in (core, web):
                file = parent / relative
                if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != source['sha256']:
                    raise ValueError('Previously recorded artwork changed: ' + relative)
    if resume:
        previous_result = json.loads((stage / 'acquisition.json').read_text(encoding='utf-8'))
        if previous_result.get('ok') is not True or previous_result.get('localOnly') is not True:
            raise ValueError('Previous acquisition is not a verified local run')
    resolver = OfficialArtResolver(cache_dir, settings_file, stage,
        previous_index.get('manifests') if resume else None)
    planned, acquired, unresolved = {}, [], []
    hints = json.loads(Path(upstream_hints).read_text(encoding='utf-8')) if upstream_hints else {}
    reviewed = {int(item['itemId']): item for item in hints.get('reviewedResources', []) if item.get('itemId')}
    legacy_commit = '282f6c2d209c6864b5e92fc89bb920c00c1314fb'
    approved_references = {('Xb-Fishing/qq-farm-evolution', legacy_commit),
        ('chengleier/qq-farm-bot', '5e7c027115ede6fc835bb69d7ad9a081a84c4133')}
    wanted = {int(row['itemId']) for row in previous_result.get('unresolvedItems', [])} if resume else None
    resolved_existing = {int(row['itemId']): row for row in previous_result.get('resolvedExistingItems', [])}
    # 原轮同步的同名图可能已被真实接口识别；不要继续登记成缺图或再次下载。
    for item_id in wanted or ():
        item = items[item_id]
        icon = str(item.get('icon_res') or '').removesuffix('/spriteFrame').removesuffix('/texture')
        if not icon.startswith('gui/texture/'):
            continue
        relative = 'deco_icons/' + icon.rsplit('/', 1)[-1] + '.png'
        if relative in previous_index.get('items', {}):
            resolved_existing[item_id] = {'itemId': item_id, 'name': item.get('name'), 'file': relative,
                'source': previous_index['items'][relative], 'resolution': 'existing-identity-matched-artwork'}
    reference = hints.get('resumeReference') if resume else None
    if reference:
        if (reference.get('repository'), reference.get('commit')) not in approved_references:
            raise ValueError('Unreviewed resume repository/commit')
        evidence = {}
        for key in ('tree', 'itemInfo'):
            filename = reference.get(key + 'File', '')
            if not re.fullmatch(r'[A-Za-z0-9_.-]+\.json', filename):
                raise ValueError('Unsafe resume evidence path')
            raw = (stage / filename).read_bytes()
            if hashlib.sha256(raw).hexdigest() != reference.get(key + 'Sha256'):
                raise ValueError('Resume evidence hash mismatch')
            evidence[key] = json.loads(raw)
        tree = evidence['tree']
        if tree.get('sha') != reference['commit'] or tree.get('truncated'):
            raise ValueError('Resume tree is not complete at the reviewed commit')
        blobs = {row['path']: row for row in tree['tree'] if row.get('type') == 'blob'}
        snapshot_items = {int(row['id']): row for row in evidence['itemInfo']}
        for item_id in reference['itemIds']:
            item_id = int(item_id)
            current, snapshot = items.get(item_id), snapshot_items.get(item_id)
            if not current or not snapshot or any(current.get(key) != snapshot.get(key)
                    for key in ('type', 'name', 'icon_res', 'asset_name')):
                raise ValueError('Resume ItemInfo identity mismatch: ' + str(item_id))
            source_path = 'core/src/gameConfig/seed_images_named/seed_images/' + str(item_id) + '.png'
            blob = blobs.get(source_path)
            if not blob:
                raise ValueError('Resume tree has no exact item image: ' + str(item_id))
            old_hint = reviewed.get(item_id, {})
            reviewed[item_id] = {**old_hint, 'itemId': item_id, 'file': old_hint.get('file') or str(item_id) + '.png',
                'repository': reference['repository'], 'sourceCommit': reference['commit'], 'sourcePath': source_path,
                'gitBlob': blob['sha'], 'bytes': blob['size'],
                'identity': {key: snapshot.get(key) for key in ('type', 'name', 'icon_res', 'asset_name')},
                'identityEvidence': {'commit': reference['commit'], 'itemInfoSha256': reference['itemInfoSha256'],
                    'treeSha256': reference['treeSha256']}}

    def prepare(relative, raw, source):
        relative = str(relative).replace('\\', '/')
        if '..' in relative.split('/') or relative.startswith('/'):
            raise ValueError('Unsafe output path')
        image = Image.open(io.BytesIO(raw))
        image.load()
        if image.format != 'PNG' or min(image.size) <= 0 or max(image.size) > 8192:
            raise ValueError('Invalid output PNG: ' + relative)
        if relative in planned and planned[relative][0] != raw:
            raise ValueError('Ambiguous artwork destination: ' + relative)
        planned[relative] = (raw, {**source, 'url': '/game-config/' + relative,
            'sha256': hashlib.sha256(raw).hexdigest(), 'size': list(image.size)})

    def upstream(item):
        hint = reviewed.get(int(item['id']))
        if not hint or not hint.get('file') or not hint.get('gitBlob'):
            raise LookupError('No fixed upstream resource evidence')
        repository = hint.get('repository') or ('chengleier/qq-farm-bot' if hint.get('repositoryAlias') == 'public-reference-2'
            else 'Xb-Fishing/qq-farm-evolution')
        commit = hint.get('sourceCommit') or hint.get('commit') or legacy_commit
        if (repository, commit) not in approved_references:
            raise ValueError('Upstream reference is not the reviewed fixed repository/commit')
        file = str(hint['file'])
        source_path = hint.get('sourcePath') or 'core/src/gameConfig/seed_images_named/' + file
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.png', file) or not re.fullmatch(
                r'core/src/gameConfig/seed_images_named/(?:seed_images/)?[A-Za-z0-9_-]+\.png', source_path):
            raise ValueError('Unsafe upstream resource path')
        identity = hint.get('identity')
        if isinstance(identity, dict):
            if any(key not in identity or identity[key] != item.get(key) for key in ('type', 'name', 'icon_res', 'asset_name')):
                raise ValueError('Upstream item identity differs from current metadata')
        else:
            icon = str(item.get('icon_res') or '').removesuffix('/spriteFrame').removesuffix('/texture').rsplit('/', 1)[-1]
            if item.get('asset_name'):
                asset = str(item['asset_name'])
                exact_seed_file = str(item['id']) + '_' + asset + '_Seed.png'
                if hint.get('assetName') != asset and not (int(item.get('type') or 0) == 5 and file == exact_seed_file):
                    raise ValueError('Upstream crop asset does not match current item')
            elif not icon or not file.endswith('_' + icon + '.png'):
                raise ValueError('Upstream icon does not match current item')
        if source_path.endswith('/seed_images/' + str(item['id']) + '.png') and not isinstance(identity, dict):
            raise ValueError('Numeric upstream image requires verified ItemInfo identity')
        if not re.fullmatch(r'[a-f0-9]{40}', str(hint['gitBlob'])):
            raise ValueError('Invalid upstream Git blob evidence')
        url = 'https://raw.githubusercontent.com/' + repository + '/' + commit + '/' + source_path
        staged = stage / ('github-' + hint['gitBlob'] + '.png')
        if staged.is_symlink():
            raise ValueError('Unsafe staged upstream resource')
        if staged.is_file():
            raw = staged.read_bytes()
        else:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(url, timeout=30) as response:
                raw = response.read()
        blob = hashlib.sha1(b'blob ' + str(len(raw)).encode('ascii') + b'\0' + raw).hexdigest()
        if blob != hint['gitBlob'] or hint.get('sha256') and hashlib.sha256(raw).hexdigest() != hint['sha256']:
            raise ValueError('Upstream pixels do not match the frozen evidence')
        if hint.get('bytes') is not None and len(raw) != hint['bytes']:
            raise ValueError('Upstream resource size differs from the reviewed tree')
        if not staged.is_file():
            staged.write_bytes(raw)
        return raw, {'kind': 'github-client-resource-snapshot', 'repository': repository,
            'commit': commit, 'path': source_path, 'sourceUrl': url, 'gitBlob': blob,
            'identity': identity, 'identityEvidence': hint.get('identityEvidence'), 'officialOriginVerified': False,
            'provenance': 'Original fixed-commit pixels; current official CDN linkage is not independently verified.'}

    def acquire(row):
        item = items[int(row['id'])]
        icon = str(item.get('icon_res') or '')
        asset = str(item.get('asset_name') or '')
        bundle = str(item.get('bundle_name') or '')
        resource = icon
        if not resource and bundle == 'animal' and asset:
            resource = 'texture/' + asset
        if not resource and re.fullmatch(r'(?:gold/)?Crop_\d+', asset):
            resource = 'model/v4/' + asset + '_Seed'
        if not resource and asset:
            exact_paths = {info[0] for entry in resolver.manifests for index, info in entry['manifest']['paths'].items()
                if info[0].rsplit('/', 1)[-1] == asset and int(index) in art_version_map(entry['manifest'], 'native')
                and entry['manifest']['types'][info[1]] == 'cc.ImageAsset'}
            if len(exact_paths) == 1:
                resource = next(iter(exact_paths))
        icon_name = icon.removesuffix('/spriteFrame').removesuffix('/texture').rsplit('/', 1)[-1]
        output = ('deco_icons/' + icon_name + '.png' if icon.startswith('gui/texture/') else
                  'deco_icons/' + str(item['id']) + '.png' if resource.startswith('texture/') else
                  'seed_images_named/' + str(item['id']) + '.png')
        try:
            if not resource:
                raise LookupError('Item has no unambiguous artwork reference')
            raw, source = resolver.resolve(resource, bundle or ('plant' if resource.startswith('model/') else 'extraRes'))
            return item, output, raw, source
        except (LookupError, RuntimeError, ValueError) as error:
            try:
                raw, source = upstream(item)
                if icon.startswith('gui/texture/'):
                    output = 'deco_icons/' + icon_name + '.png'
                elif int(item.get('type') or 0) == 5:
                    output = 'seed_images_named/' + str(item['id']) + '_' + asset + '_Seed.png'
                elif int(item.get('type') or 0) == 6 and asset:
                    output = 'seed_images_named/' + str(item['id']) + '_' + asset + '_Fruit.png'
                return item, output, raw, source
            except (LookupError, ValueError, RuntimeError, OSError) as fallback_error:
                return item, None, None, {'reason': str(error), 'upstreamReason': str(fallback_error)}

    missing = [item for item in baseline['itemImages'] if not item.get('image')
        and (wanted is None or int(item['id']) in wanted) and int(item['id']) not in resolved_existing]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in as_completed([pool.submit(acquire, item) for item in missing]):
            item, relative, raw, source = future.result()
            if relative:
                prepare(relative, raw, source)
                acquired.append({'itemId': item['id'], 'name': item.get('name'), 'file': relative, 'source': source})
            else:
                unresolved.append({'itemId': item['id'], 'name': item.get('name'), **source})

    # Resolve every missing sprite phase from the current official Plant -> fruit/seed
    # resource association. Stage 1 stays the common land seed; bag icons never become
    # mature plant frames. Existing manifest URLs and images are left untouched.
    old_manifest_raw = (core / 'plant_images/manifest.json').read_bytes()
    if old_manifest_raw != (web / 'plant_images/manifest.json').read_bytes():
        raise ValueError('Existing plant phase manifests disagree')
    old_manifest = json.loads(old_manifest_raw)
    phase_manifest = json.loads(json.dumps(old_manifest))
    plants = [] if resume else json.loads((core / 'Plant.json').read_text(encoding='utf-8')) + json.loads((core / 'EventPlants.json').read_text(encoding='utf-8'))
    phase_jobs, seen = [], set()
    for plant in plants:
        seed = items.get(int(plant.get('seed_id') or 0), {})
        fruit = items.get(int((plant.get('fruit') or {}).get('id') or 0), {})
        asset = str(plant.get('asset_name') or seed.get('asset_name') or
                    ('Crop_' + str(int(plant['seed_id']) - 20000) if int(plant.get('seed_id') or 0) > 20000 else 'Plant_' + str(plant['id'])))
        logical_asset = str(plant.get('asset_name') or seed.get('asset_name') or fruit.get('asset_name') or '')
        if not re.fullmatch(r'(?:gold/)?Crop_\d+', logical_asset):
            continue
        for phase in range(2, 8):
            key = (asset, phase)
            if key in seen or str(phase) in phase_manifest.get(asset, {}):
                continue
            seen.add(key)
            phase_jobs.append((asset, phase, 'model/v4/' + logical_asset + '_' + str(phase)))

    def acquire_phase(job):
        asset, phase, resource = job
        try:
            raw, source = resolver.resolve(resource, 'plant')
            return asset, phase, raw, source
        except (LookupError, RuntimeError, ValueError) as error:
            return asset, phase, None, {'reason': str(error)}

    phase_added = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in as_completed([pool.submit(acquire_phase, job) for job in phase_jobs]):
            asset, phase, raw, source = future.result()
            if raw is None:
                continue
            relative = 'plant_images/' + asset + '/' + str(phase) + '.png'
            prepare(relative, raw, source)
            phase_manifest.setdefault(asset, {})[str(phase)] = '/game-config/' + relative
            phase_added += 1

    # Fully synchronize the already verified project image sets, not QQ's cache.
    synced = {'core': 0, 'web': 0}
    web_only_aliases = {'seed_images_named/' + str(item_id) + '.png' for item_id, alias
        in previous_index.get('webNumericAliases', {}).items() if alias.get('deploymentAliasOnly') is True}
    for directory in ('seed_images_named', 'plant_images', 'deco_icons', 'land_images', 'effect_images', 'career', 'scene_images', 'pest_images'):
        files = {}
        for parent in (core, web):
            folder = parent / directory
            if not folder.is_dir():
                continue
            for file in folder.rglob('*'):
                if file.is_file():
                    if file.is_symlink():
                        raise ValueError('Existing resource is a symlink')
                    relative = file.relative_to(parent).as_posix()
                    if parent == web and relative in web_only_aliases:
                        continue
                    if relative in files and files[relative].read_bytes() != file.read_bytes():
                        raise ValueError('Existing dual-root conflict: ' + relative)
                    files[relative] = file
        for relative, source_file in files.items():
            raw = source_file.read_bytes()
            if relative in planned:
                if planned[relative][0] != raw:
                    raise ValueError('Would overwrite existing artwork: ' + relative)
                continue
            if not all((parent / relative).is_file() for parent in (core, web)):
                if source_file.suffix.lower() == '.png':
                    prepare(relative, raw, {'kind': 'existing-project-resource-sync',
                        'sourceFile': source_file.relative_to(root).as_posix(), 'officialOriginVerified': False,
                        'provenance': 'Existing project pixels, not a new official-source attribution.'})
                else:
                    planned[relative] = (raw, {'kind': 'existing-project-metadata-sync',
                        'sourceFile': source_file.relative_to(root).as_posix(), 'sha256': hashlib.sha256(raw).hexdigest()})

    # Complete preflight before the first write to either resource root.
    for relative, (raw, _source) in planned.items():
        for parent in (core, web):
            target = parent / relative
            if target.is_symlink() or target.exists() and target.read_bytes() != raw:
                raise ValueError('Would overwrite an existing resource: ' + relative)
    for relative, (raw, _source) in planned.items():
        for label, parent in (('core', core), ('web', web)):
            target = parent / relative
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            if target.read_bytes() != raw:
                raise RuntimeError('Asset write verification failed: ' + relative)
            synced[label] += 1
    manifest_raw = ((json.dumps(phase_manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                    if phase_added else old_manifest_raw)
    for parent in (core, web):
        file = parent / 'plant_images/manifest.json'
        if file.is_symlink():
            raise ValueError('Unsafe phase manifest path')
        file.write_bytes(manifest_raw)

    # Numeric aliases are web deployment aliases only: adding them to core would
    # alter the existing first-match seedImageMap and invalidate stable API URLs.
    # The original source image remains intact and present in both resource roots.
    aliases = dict(previous_index.get('webNumericAliases', {}))
    alias_rows = list(baseline['itemImages']) + [{'id': row['itemId'], 'image': '/game-config/' + row['file']}
        for row in [*acquired, *resolved_existing.values()]]
    aliases_added = 0
    for row in alias_rows:
        url = row.get('image') or ''
        if not url.startswith('/game-config/') and not url.startswith('/activity/'):
            continue
        path = unquote(urlparse(url).path)
        source_file = core / path[len('/game-config/'):] if path.startswith('/game-config/') else root / 'web/public' / path.lstrip('/')
        if not source_file.is_file() or source_file.suffix.lower() != '.png':
            continue
        target = web / 'seed_images_named' / (str(row['id']) + '.png')
        if target.exists():
            continue
        raw = source_file.read_bytes()
        image = Image.open(io.BytesIO(raw))
        image.load()
        target.write_bytes(raw)
        aliases_added += 1
        aliases[str(row['id'])] = {'url': '/game-config/seed_images_named/' + target.name,
            'sourceUrl': url, 'sha256': hashlib.sha256(raw).hexdigest(), 'deploymentAliasOnly': True}
    # 多次续跑合并原始来源和累计成果，不能把成功后再次运行变成空索引。
    indexed = dict(previous_index.get('items', {}))
    for relative, (_raw, source) in sorted(planned.items()):
        if relative.endswith('.png'):
            if relative in indexed and indexed[relative]['sha256'] != source['sha256']:
                raise ValueError('Artwork provenance would replace different pixels')
            indexed.setdefault(relative, source)
    now = datetime.now(timezone.utc).isoformat()
    source_index = {**previous_index, 'version': 1, 'importedAt': previous_index.get('importedAt', now),
        'updatedAt': now, 'localOnly': True, 'gameRpcSent': False,
        'manifests': [entry['source'] for entry in resolver.manifests], 'items': indexed, 'webNumericAliases': aliases}
    source_raw = (json.dumps(source_index, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    for parent in (core, web):
        (parent / 'art-resource-sources.json').write_bytes(source_raw)
    all_acquired = {int(row['itemId']): row for row in previous_result.get('acquired', [])}
    all_acquired.update({int(row['itemId']): row for row in acquired})
    acquired_rows = sorted(all_acquired.values(), key=lambda row: int(row['itemId']))
    result = {**previous_result, 'ok': True, 'localOnly': True, 'updatedAt': now, 'acquiredItems': len(acquired_rows),
        'officialAcquiredItems': sum(item['source'].get('officialOriginVerified') is True for item in acquired_rows),
        'upstreamSnapshotItems': sum(item['source'].get('kind') == 'github-client-resource-snapshot' for item in acquired_rows),
        'phaseImagesAdded': previous_result.get('phaseImagesAdded', 0) + phase_added,
        'newFilesByRoot': {label: previous_result.get('newFilesByRoot', {}).get(label, 0) + count for label, count in synced.items()},
        'webNumericAliases': len(aliases), 'staticFilesDownloaded': previous_result.get('staticFilesDownloaded', 0) + resolver.download_count,
        'acquired': acquired_rows, 'unresolvedItems': sorted(unresolved, key=lambda row: int(row['itemId'])),
        'resolvedExistingItems': sorted(resolved_existing.values(), key=lambda row: int(row['itemId'])),
        'lastRun': {'resume': resume, 'acquiredItems': len(acquired), 'phaseImagesAdded': phase_added,
            'newFilesByRoot': synced, 'webNumericAliasesAdded': aliases_added, 'staticFilesDownloaded': resolver.download_count}}
    (stage / 'acquisition.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in result.items() if key not in ('acquired', 'unresolvedItems')}, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="")
    ap.add_argument("--uin", default="")
    ap.add_argument("--bundle", default="")
    ap.add_argument("--match", action="append", default=[])
    ap.add_argument("--names-file", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default="")
    ap.add_argument("--bundle-tag", action="store_true")
    ap.add_argument("--dump-map", default="")
    ap.add_argument('--complete-project-art', action='store_true',
                    help='补齐明确配置的缺图与双根资源，只改本地项目，不操作游戏')
    ap.add_argument('--settings-file', default='', help='明确官方小程序settings JSON路径')
    ap.add_argument('--baseline-file', default='', help='本轮既有图片与物品解析基线JSON')
    ap.add_argument('--stage-dir', default='', help='既有项目内资源暂存目录')
    ap.add_argument('--upstream-hints', default='', help='固定版本Git对象已核对的资源索引')
    ap.add_argument('--resume-project-art', action='store_true', help='复用已登记清单与采集记录，仅补剩余缺图且不读取QQ缓存')
    ap.add_argument("--import-avatar-assets", action="store_true",
                    help="按官方extraRes清单导入头像框/铭牌原图及图集裁剪到本地双根")
    ap.add_argument("--verify-avatar-assets", action="store_true",
                    help="只验证头像资源双根、来源和hash，不下载不写入")
    ap.add_argument("--download-missing", action="store_true",
                    help="头像导入缺精确版本缓存时允许下载官方静态CDN文件，不发游戏RPC")
    ap.add_argument("--import-blue-crystal-2x2", metavar="PNG",
                    help="校验已下载 GitHub 四格候选并原字节同步双根，仅本地，不访问游戏缓存")
    ap.add_argument("--import-blue-crystal-single", metavar="PNG",
                    help="校验已下载 GitHub 清晰小格图并原字节同步双根，仅本地")
    ap.add_argument("--confirm-application", action="store_true",
                    help="用户确认应用后更新本地来源状态，不自动部署或宣称官方来源")
    args = ap.parse_args()
    if args.complete_project_art or args.resume_project_art:
        if args.complete_project_art and args.resume_project_art:
            ap.error('Initial art completion and resume are mutually exclusive')
        if not all((args.baseline_file, args.stage_dir)) or args.complete_project_art and not all((args.cache, args.settings_file)):
            ap.error('Art completion requires explicit baseline/stage and initial completion requires cache/settings')
        if args.resume_project_art and (args.cache or args.settings_file):
            ap.error('Art resume uses recorded manifests only, not QQ cache/settings')
        if any((args.import_avatar_assets, args.verify_avatar_assets, args.import_blue_crystal_2x2,
                args.import_blue_crystal_single, args.confirm_application, args.download_missing)):
            ap.error('Art completion cannot be mixed with another import action')
        return complete_project_art_assets(args.cache, args.settings_file, args.baseline_file,
            args.stage_dir, args.upstream_hints, resume=args.resume_project_art)
    if args.import_avatar_assets or args.verify_avatar_assets:
        if args.import_blue_crystal_2x2 or args.import_blue_crystal_single:
            ap.error('头像与蓝晶素材导入不能混用')
        if args.verify_avatar_assets:
            return import_avatar_assets('', verify_only=True)
        if not args.cache:
            ap.error('头像素材导入必须显式指定--cache，不自动扫描个人目录')
        return import_avatar_assets(args.cache, download_missing=args.download_missing)
    if args.download_missing:
        ap.error('--download-missing 只用于--import-avatar-assets')
    if args.import_blue_crystal_2x2 and args.import_blue_crystal_single:
        ap.error('一次只导入单格或四格素材')
    if args.import_blue_crystal_2x2:
        return import_blue_crystal_2x2(args.import_blue_crystal_2x2, confirmed=args.confirm_application)
    if args.import_blue_crystal_single:
        return import_blue_crystal_asset(args.import_blue_crystal_single, confirmed=args.confirm_application, single=True)
    if args.confirm_application:
        ap.error('--confirm-application 必须与蓝晶素材导入参数一同使用')

    cache_dir = pick_cache_dir(args.cache, args.uin)
    if not cache_dir or not os.path.isdir(cache_dir):
        print("[x] 找不到 gamecaches 目录，请用 --cache 指定")
        return 2
    print("[i] 缓存目录: %s" % cache_dir)

    names = None
    if args.names_file:
        raw = io.open(args.names_file, encoding="utf-8").read()
        names = {ln.strip() for ln in raw.splitlines() if ln.strip() and not ln.startswith("#")}
        print("[i] 名字清单: %d 个" % len(names))

    hits = collect(cache_dir, args.bundle, args.match, names)
    print("[i] 匹配到 %d 个资源" % len(hits))
    if not hits:
        return 1
    if args.dump_map:
        io.open(args.dump_map, "w", encoding="utf-8").write(
            json.dumps(hits, ensure_ascii=False, indent=1))
        print("[i] 映射已写出: %s (%d 条)" % (args.dump_map, len(hits)))
        return 0
    if args.list:
        for name in sorted(hits):
            e = hits[name]
            print("  %-40s %-10s %s" % (name, e["bundle"], e["guid"]))
        return 0

    if not args.out:
        print("[x] 需要 --out 指定输出目录")
        return 2
    os.makedirs(args.out, exist_ok=True)

    ok = fail = 0
    for name in sorted(hits):
        good, size, url = download(hits[name], args.out, args.bundle_tag)
        if good:
            ok += 1
            print("  [ok] %-38s %7d B" % (name, size))
        else:
            fail += 1
            print("  [!!] %-38s %s" % (name, url))
    print("\n完成：成功 %d / 失败 %d → %s" % (ok, fail, args.out))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
