"""探测 Wikidata / Wikipedia 等外部坐标源现在是否可达。"""
import json
import os
import socket
import ssl
import urllib.parse
import urllib.request

UA = 'globetv-build/1.0 (local dev)'
Q = ('SELECT ?item ?coord WHERE { '
     '?item wdt:P31/wdt:P279* wd:Q1616075 ; wdt:P625 ?coord . } LIMIT 3')

print('代理环境变量:', os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY') or '(无)')
print()
for host, port in (('query.wikidata.org', 443), ('query-main.wikidata.org', 443),
                   ('www.wikidata.org', 443), ('en.wikipedia.org', 443)):
    try:
        socket.create_connection((host, port), timeout=8).close()
        print('TCP  %-26s OK' % host)
    except Exception as exc:
        print('TCP  %-26s FAIL %s' % (host, type(exc).__name__))

print()
hosts = ['https://query.wikidata.org/sparql', 'https://query-main.wikidata.org/sparql']
for h in hosts:
    for method in ('GET', 'POST'):
        try:
            if method == 'GET':
                url = h + '?format=json&query=' + urllib.parse.quote(Q)
                req = urllib.request.Request(url, headers={'User-Agent': UA})
                raw = urllib.request.urlopen(req, timeout=40).read()
            else:
                data = urllib.parse.urlencode({'query': Q, 'format': 'json'}).encode()
                req = urllib.request.Request(h, data=data, headers={'User-Agent': UA})
                raw = urllib.request.urlopen(req, timeout=40).read()
            d = json.loads(raw.decode('utf-8'))
            print('%-42s %-4s OK  rows=%d' % (h, method, len(d['results']['bindings'])))
        except Exception as exc:
            print('%-42s %-4s FAIL %s %s' % (h, method, type(exc).__name__, str(exc)[:60]))

print()
extra = [
    ('Wikipedia API', 'https://en.wikipedia.org/w/api.php?action=query&prop=coordinates&titles=BBC%20One&format=json'),
    ('Wikidata REST', 'https://www.wikidata.org/wiki/Special:EntityData/Q1616075.json'),
    ('Nominatim', 'https://nominatim.openstreetmap.org/search?q=Berlin&format=json&limit=1'),
    ('Overpass', 'https://overpass-api.de/api/status'),
]
for name, url in extra:
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        raw = urllib.request.urlopen(req, timeout=25).read()
        print('%-16s OK  %6d B' % (name, len(raw)))
    except Exception as exc:
        print('%-16s FAIL %s %s' % (name, type(exc).__name__, str(exc)[:60]))
