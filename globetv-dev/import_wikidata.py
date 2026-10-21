# -*- coding: utf-8 -*-
"""把 Wikidata 导出的电视台坐标导入成本地索引。

为什么需要这个脚本：本机网络访问不了 Wikidata（TLS 握手被阻断），
所以由用户在能上网的设备上跑 SPARQL，把结果 JSON 存到
    .globetv-cache/wikidata_stations.json   （可以存多份：*_1.json / *_2.json）
然后跑本脚本生成
    globetv-dev/wikidata_index.json
station_places.py 会自动加载它，频道名/别名能对上就用 Wikidata 的真实台址坐标。

用法：
    python globetv-dev/import_wikidata.py
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(ROOT, '.globetv-cache')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wikidata_index.json')

# 名称归一化用 station_places 那一份，保证导入和查询两侧完全一致
from station_places import norm


def load_country_map():
    """iptv-org countries.json：国家英文名 -> ISO2"""
    path = os.path.join(CACHE, 'countries.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        arr = json.load(f)
    m = {}
    for c in arr:
        if c.get('name') and c.get('code'):
            m[c['name'].lower()] = c['code']
    return m


def parse_coord(v):
    """'Point(-0.13 51.5)' -> (lat, lon)"""
    m = re.match(r'Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)', v or '')
    if not m:
        return None
    return (float(m.group(2)), float(m.group(1)))      # (lat, lon)


def main():
    files = sorted(glob.glob(os.path.join(CACHE, 'wikidata_stations*.json')))
    if not files:
        print('没找到 %s\\wikidata_stations*.json' % CACHE)
        print('先在 https://query.wikidata.org/ 跑 SPARQL，Download 成 JSON 放这里。')
        return 1

    cmap = load_country_map()
    index = {}          # norm_name -> [[lat, lon, cc], ...]
    orgs = {}           # norm机构名 -> [[lat, lon, cc], ...]
    n_rows = n_ok = 0

    # ---- 机构总部坐标（wikidata_orgs_*.json，按我们自己的机构名查出来的）
    for path in sorted(glob.glob(os.path.join(CACHE, 'wikidata_orgs*.json'))):
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            rows = data['results']['bindings']
            val = lambda r, k: (r.get(k) or {}).get('value')        # noqa: E731
        else:
            rows = data
            val = lambda r, k: r.get(k)                              # noqa: E731
        print('%s  %d 行' % (os.path.basename(path), len(rows)))
        for r in rows:
            coord = parse_coord(val(r, 'coord'))
            if not coord:
                continue
            cc = cmap.get((val(r, 'countryLabel') or '').lower(), '')
            for nm in [val(r, 'name'), val(r, 'itemLabel'), val(r, 'alts')]:
                if not nm:
                    continue
                for one in (nm.split('|') if '|' in nm else [nm]):
                    key = norm(one)
                    if len(key) < 3:
                        continue
                    entry = [round(coord[0], 4), round(coord[1], 4), cc]
                    b = orgs.setdefault(key, [])
                    if entry not in b:
                        b.append(entry)
    if orgs:
        with open(os.path.join(os.path.dirname(OUT), 'wikidata_orgs.json'), 'w', encoding='utf-8') as f:
            json.dump(orgs, f, ensure_ascii=False, separators=(',', ':'))
        print('机构坐标索引 %d 条 -> wikidata_orgs.json' % len(orgs))

    for path in files:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        # 两种格式都吃：
        #   标准 SPARQL JSON  -> {"results": {"bindings": [{"item": {"value": ...}}]}}
        #   WDQS 下载的简化版 -> [{"item": "...", "itemLabel": "..."}, ...]
        if isinstance(data, dict):
            rows = data['results']['bindings']
            val = lambda r, k: (r.get(k) or {}).get('value')      # noqa: E731
        else:
            rows = data
            val = lambda r, k: r.get(k)                            # noqa: E731
        print('%s  %d 行' % (os.path.basename(path), len(rows)))
        for r in rows:
            n_rows += 1
            coord = parse_coord(val(r, 'coord'))
            if not coord:
                continue
            cc = cmap.get((val(r, 'countryLabel') or '').lower(), '')
            names = [val(r, 'itemLabel')]
            names += [a for a in (val(r, 'alts') or '').split('|') if a]
            for nm in names:
                key = norm(nm)
                if len(key) < 3:
                    continue
                entry = [round(coord[0], 4), round(coord[1], 4), cc]
                bucket = index.setdefault(key, [])
                if entry not in bucket:
                    bucket.append(entry)
            n_ok += 1

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    print()
    print('解析 %d 行，其中带坐标 %d 行' % (n_rows, n_ok))
    print('索引条目 %d 个 -> %s (%.2f MB)' % (len(index), OUT, os.path.getsize(OUT) / 1048576))

    # 先拿现有频道数据试匹配，看看能多定位多少
    raw = open(os.path.join(ROOT, 'global-tv', 'assets', 'js', 'data', 'channels.js'), encoding='utf-8').read()
    chs = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])['channels']
    hit = 0
    for c in chs:
        for key in (norm(c['n']), norm(c.get('a') or '')):
            cand = index.get(key) if key else None
            if cand and any(e[2] == c['c'] for e in cand):
                hit += 1
                break
    print('试匹配（严格同国）：现有 %d 个频道里能对上的 %d 个 (%.1f%%)'
          % (len(chs), hit, hit * 100.0 / len(chs)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
