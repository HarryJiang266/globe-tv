"""评估 station_places.resolve 的覆盖率与误匹配。"""
import collections
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import station_places as sp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(ROOT, '.globetv-cache')

raw = open(os.path.join(ROOT, 'global-tv', 'assets', 'js', 'data', 'channels.js'), encoding='utf-8').read()
chs = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])['channels']
src = {c['id']: c for c in json.load(open(os.path.join(CACHE, 'channels.json'), encoding='utf-8'))}

stat = collections.Counter()
samples = collections.defaultdict(list)
city_top = collections.Counter()

for c in chs:
    s = src.get(c['i']) or {}
    kind, lat, lon, label = sp.resolve(s.get('network'), s.get('owners'),
                                       c['n'], c.get('a'), c['c'])
    k = kind or 'none'
    stat[k] += 1
    if kind in ('city', 'org'):
        city_top[label] += 1
    if len(samples[k]) < 12:
        samples[k].append('%s [%s] -> %s' % (c['n'][:34], c['c'], label))

tot = len(chs)
print('频道总数 %d' % tot)
for k in ('city', 'org', 'fast', 'none'):
    print('  %-5s %5d  (%.1f%%)' % (k, stat[k], stat[k] * 100.0 / tot))
located = stat['city'] + stat['org']
print('  可定位合计 %d (%.1f%%)' % (located, located * 100.0 / tot))
print()
for k in ('city', 'org', 'fast', 'none'):
    print('--- %s 样例 ---' % k)
    for s in samples[k]:
        print('   ', s)
    print()
print('--- 定位最多的城市 Top 20 ---')
for k, v in city_top.most_common(20):
    print('   %5d  %s' % (v, k))
