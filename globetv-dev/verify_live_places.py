"""校验线上：bundle、频道数据、贴图是否与本地一致，并抽查位置等级。"""
import gzip
import hashlib
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://global-tv-globe.app.workbuddy.host/'

FILES = [
    ('', 'index.html'),
    ('assets/js/', 'app.bundle.js'),
    ('assets/js/data/', 'channels.json.gz'),
    ('assets/js/data/', 'channels.js'),
    ('assets/img/', 'earth-dark.jpg'),
    ('assets/img/', 'earth-light.jpg'),
]

ok = True
for sub, name in FILES:
    raw = urllib.request.urlopen(BASE + sub + name, timeout=60).read()
    with open(os.path.join(ROOT, 'global-tv', sub, name), 'rb') as f:
        local = f.read()
    same = hashlib.md5(raw).hexdigest() == hashlib.md5(local).hexdigest()
    ok = ok and same
    print('%-24s %8d B  与本地一致=%s' % (name, len(raw), same))

raw = urllib.request.urlopen(BASE + 'assets/js/data/channels.json.gz', timeout=60).read()
d = json.loads(gzip.decompress(raw).decode('utf-8'))
cnt = {}
for c in d['channels']:
    cnt[c.get('p', 0)] = cnt.get(c.get('p', 0), 0) + 1
print()
print('线上频道 %d：精确定位 %d / 城市加权 %d / 虚拟(不显示) %d'
      % (len(d['channels']), cnt.get(0, 0), cnt.get(1, 0), cnt.get(2, 0)))
print('地球仪应显示', cnt.get(0, 0) + cnt.get(1, 0), '个点')

bundle = urllib.request.urlopen(BASE + 'assets/js/app.bundle.js', timeout=60).read().decode('utf-8')
print('bundle 含 2026-10-21.1:', '2026-10-21.1' in bundle)
print('RESULT:', 'OK' if ok else 'FAIL')
