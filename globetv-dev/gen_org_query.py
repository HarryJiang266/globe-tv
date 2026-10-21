# -*- coding: utf-8 -*-
"""生成「按机构名查总部坐标」的 SPARQL 查询。

思路：Wikidata 里带坐标的"电视台"条目只有 1248 个，跟我们 10102 个频道
对不上。但我们手上有 network / owners 的机构名（几千个），直接按名字去
Wikidata 精确查这些机构的坐标，命中率高得多，而且只查关心的名字，不会超时。

生成的查询存到 globetv-dev/queries/ 下，分批（每批 ~180 个名字），
用户复制到 https://query.wikidata.org/ 跑，下载 JSON 存成
    .globetv-cache/wikidata_orgs_1.json / _2.json ...
"""
import collections
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(ROOT, '.globetv-cache')
OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'queries')
BATCH = 180

raw = open(os.path.join(ROOT, 'global-tv', 'assets', 'js', 'data', 'channels.js'), encoding='utf-8').read()
chs = json.loads(raw[raw.index('{'):raw.rindex('}') + 1])['channels']
src = {c['id']: c for c in json.load(open(os.path.join(CACHE, 'channels.json'), encoding='utf-8'))}

# 机构名 -> 覆盖多少频道
cov = collections.Counter()
for c in chs:
    s = src.get(c['i']) or {}
    if s.get('network'):
        cov[s['network']] += 1
    for o in (s.get('owners') or []):
        cov[o] += 1

names = [n for n, _ in cov.most_common() if n and len(n) >= 3]


def esc(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')


os.makedirs(OUTDIR, exist_ok=True)
total = 0
for bi in range(0, len(names), BATCH):
    part = names[bi:bi + BATCH]
    vals = '\n      '.join('"%s"@en' % esc(n) for n in part)
    q = '''# 第 %d 批（%d 个机构名，覆盖频道最多的优先）
SELECT ?name ?item ?coord ?countryLabel
       (GROUP_CONCAT(DISTINCT ?alt; SEPARATOR="|") AS ?alts)
WHERE {
  VALUES ?name {
      %s
  }
  ?item rdfs:label ?name ;
        wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item skos:altLabel ?alt . FILTER(lang(?alt) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
GROUP BY ?name ?item ?coord ?countryLabel
''' % (bi // BATCH + 1, len(part), vals)
    path = os.path.join(OUTDIR, 'org_coords_%d.sparql' % (bi // BATCH + 1))
    with open(path, 'w', encoding='utf-8') as f:
        f.write(q)
    total += 1
    print('%s  %d 个名字' % (os.path.basename(path), len(part)))

print()
print('共 %d 批，机构名 %d 个。' % (total, len(names)))
print('文件在 %s' % OUTDIR)
print('第 1 批覆盖频道数约 %d'
      % sum(cov[n] for n in names[:BATCH]))
