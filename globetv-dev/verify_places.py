"""校验新坐标：落海比例、城市聚集情况。"""
import collections
import json
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

raw = open(os.path.join(ROOT, 'global-tv', 'assets', 'js', 'data', 'channels.js'), encoding='utf-8').read()
chs = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])['channels']

im = Image.open(os.path.join(ROOT, 'global-tv', 'assets', 'img', 'earth-dark.jpg')).convert('L')
px = im.load()
W, H = im.size

# 深色主题：海洋 (27,35,44)->L≈34，陆地 (50,58,68)->L≈57，海岸线更亮
SEA_MAX = 45


def is_sea(lat, lon):
    x = int((lon + 180.0) / 360.0 * W) % W
    y = max(0, min(H - 1, int((90.0 - lat) / 180.0 * H)))
    return px[x, y] <= SEA_MAX


sea = [c for c in chs if is_sea(c['la'], c['lo'])]
print('频道总数 %d，落海 %d 个 (%.1f%%)' % (len(chs), len(sea), len(sea) * 100.0 / len(chs)))
print('  （旧版「国界内几何均匀撒点」实测约 15.5% 落海）')
print()
print('落海样例:')
for c in sea[:8]:
    print('   %-30s [%s]  %.2f, %.2f' % (c['n'][:30], c['c'], c['la'], c['lo']))
print()

# 城市聚集：看频道数最多的坐标簇
clusters = collections.Counter()
for c in chs:
    clusters[(round(c['la'], 1), round(c['lo'], 1))] += 1
print('最密集的 0.1° 网格 Top 15:')
for (la, lo), n in clusters.most_common(15):
    print('   %3d 个  %.1f, %.1f' % (n, la, lo))
print()

# 抽样几个国家，看主要落点城市
for cc in ('US', 'IN', 'RU', 'DE', 'BR'):
    sub = [c for c in chs if c['c'] == cc]
    top = collections.Counter((round(c['la'], 1), round(c['lo'], 1)) for c in sub).most_common(4)
    print('%s (%d 个) 主要聚集点: %s' % (cc, len(sub), top))
