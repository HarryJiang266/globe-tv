"""抽查 Wikidata 匹配结果的质量：频道名 vs 匹配到的台址坐标。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import station_places as sp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(ROOT, '.globetv-cache')

raw = open(os.path.join(ROOT, 'global-tv', 'assets', 'js', 'data', 'channels.js'), encoding='utf-8').read()
chs = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])['channels']
src = {c['id']: c for c in json.load(open(os.path.join(CACHE, 'channels.json'), encoding='utf-8'))}

hits = []
for c in chs:
    s = src.get(c['i']) or {}
    kind, la, lo, label = sp.resolve(s.get('network'), s.get('owners'), c['n'], c.get('a'), c['c'])
    if kind == 'wiki':
        hits.append((c['n'], c['c'], la, lo))
print('Wikidata 命中 %d 个' % len(hits))
for n, cc, la, lo in hits[:25]:
    print('   %-34s [%s]  %.2f, %.2f' % (n[:34], cc, la, lo))

# 这些命中里，有多少原来就已经能精确定位（说明不是新增）
新增 = 0
for c in chs:
    s = src.get(c['i']) or {}
    k1 = sp.resolve(s.get('network'), s.get('owners'), c['n'], c.get('a'), c['c'])
print()
print('（上面是最终解析结果，wiki 优先级最高，会覆盖原来的 city/org 判定）')
