# -*- coding: utf-8 -*-
"""
Globe TV — 数据与地球贴图构建脚本（可重复执行）

它会：
  1. 从 iptv-org 公共 API 拉取 channels / streams / countries / categories / logos
  2. 与国别经纬度、世界地图拓扑数据合并，生成前端直接加载的精简数据集
     -> assets/js/data/channels.js
  3. 用 Pillow 把世界地图绘制成 4096x2048 的等距圆柱投影贴图
     -> assets/img/earth-dark.jpg / earth-light.jpg

依赖：Pillow（本机隔离环境已有）
    C:/Users/harry/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
        tools/build_data.py
"""
import gzip, json, math, os, random, sys, time, urllib.request
from collections import defaultdict, Counter
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))          # globetv-dev/
sys.path.insert(0, HERE)
import station_places                                       # 频道实际位置解析
ROOT = os.path.join(os.path.dirname(HERE), 'global-tv')    # 发布目录（只放网站本身）
# 原始 API 缓存（约 17MB）默认放在项目**外面**，免得发布上线时把它一起传上去。
# 想换位置就设环境变量 GLOBETV_CACHE。
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(os.path.dirname(HERE), '.globetv-cache')
DATA = os.path.join(ROOT, 'assets', 'js', 'data')
TEX = os.path.join(ROOT, 'assets', 'img')
os.makedirs(CACHE, exist_ok=True)
os.makedirs(DATA, exist_ok=True)
os.makedirs(TEX, exist_ok=True)

SOURCES = {
    'channels': 'https://iptv-org.github.io/api/channels.json',
    'streams': 'https://iptv-org.github.io/api/streams.json',
    'countries': 'https://iptv-org.github.io/api/countries.json',
    'categories': 'https://iptv-org.github.io/api/categories.json',
    'logos': 'https://iptv-org.github.io/api/logos.json',
    'world': 'https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json',
    'topo': 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
}


def fetch(name, url, force=False):
    path = os.path.join(CACHE, name + '.json')
    if os.path.exists(path) and not force:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    sys.stderr.write('下载 %s ...\n' % name)
    req = urllib.request.Request(url, headers={'User-Agent': 'globetv-build/1.0'})
    raw = urllib.request.urlopen(req, timeout=180).read()
    with open(path, 'wb') as f:
        f.write(raw)
    return json.loads(raw.decode('utf-8'))


# ---------------------------------------------------------------- 国界多边形
def topo_rings_by_country(topo, ccn3_to_cca2):
    """把 topojson 解成 {cca2: [[外环, 内环...], ...]}，并返回全部环。

    环是 (lon, lat) 列表。这里不做反经线处理，采样时再展开。
    """
    tr = topo['transform']
    sx, sy = tr['scale']
    tx, ty = tr['translate']
    arcs = topo['arcs']

    def decode(idx):
        x = y = 0
        out = []
        for dx, dy in arcs[idx]:
            x += dx
            y += dy
            out.append((x * sx + tx, y * sy + ty))
        return out

    by_cc, all_rings = {}, []
    for g in topo['objects']['countries']['geometries']:
        gid = g.get('id')
        cc = ccn3_to_cca2.get(str(gid).zfill(3)) if gid is not None else None
        polys = g['arcs'] if g['type'] == 'MultiPolygon' else [g['arcs']]
        for poly in polys:
            rings = []
            for ring in poly:
                pts = []
                for idx in ring:
                    seg = decode(~idx if idx < 0 else idx)
                    if idx < 0:
                        seg = seg[::-1]
                    pts.extend(seg)
                if len(pts) > 1:
                    rings.append(pts)
                    all_rings.append(pts)
            if rings and cc:
                by_cc.setdefault(cc, []).append(rings)
    return by_cc, all_rings


def unwrap_ring(ring):
    """把环的经度解成连续值。

    跨 ±180° 的国界（俄罗斯、斐济、新西兰、阿拉斯加）原始坐标会在
    接缝处突然从 +180 跳到 -180，直接画出来就是一条横穿整幅地图的长线 ——
    之前贴图上纬度 65°/71° 那两条假线就是这么来的。解成连续经度后，
    再配合 ±360° 的副本绘制，接缝处才会正常闭合。
    """
    out = [ring[0]]
    for lo, la in ring[1:]:
        prev = out[-1][0]
        while lo - prev > 180:
            lo -= 360
        while prev - lo > 180:
            lo += 360
        out.append((lo, la))
    return out


def _in_ring(x, y, ring):
    """射线法：点是否在环内。"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _ring_area(ring):
    s = 0.0
    j = len(ring) - 1
    for i in range(len(ring)):
        s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        j = i
    return abs(s) * 0.5


def sample_in_country(polys, n, seed=0):
    """在一个国家的国界内撒 n 个点，返回 [(lon, lat), ...]。

    做法：抖动网格 + 多边形内测试，格距由国土面积估算，不够就缩小重试。
    这样点会贴合国土形状 —— 旧的"以质心为圆心、按面积估半径"写法
    会让长条形和不规则国家把点撒到海里（智利、挪威、印尼尤其明显）。
    """
    if n <= 0 or not polys:
        return []

    # 反经线展开：经度跨度 > 180° 说明国界绕过了 ±180
    # （斐济、俄罗斯、新西兰、阿拉斯加都这样）
    lons = [pt[0] for poly in polys for ring in poly for pt in ring]
    if max(lons) - min(lons) > 180:
        polys = [[[(lo + 360.0 if lo < 0 else lo, la) for lo, la in ring] for ring in poly]
                 for poly in polys]
        lons = [pt[0] for poly in polys for ring in poly for pt in ring]
    lats = [pt[1] for poly in polys for ring in poly for pt in ring]
    x0, x1, y0, y1 = min(lons), max(lons), min(lats), max(lats)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return []

    boxes, area = [], 0.0
    for poly in polys:
        ox = [pt[0] for pt in poly[0]]
        oy = [pt[1] for pt in poly[0]]
        boxes.append((min(ox), max(ox), min(oy), max(oy)))
        area += _ring_area(poly[0])
        for hole in poly[1:]:
            area -= _ring_area(hole)      # 扣掉飞地里的洞，如南非里的莱索托
    if area <= 0:
        area = (x1 - x0) * (y1 - y0) * 0.25

    step = math.sqrt(area / n)
    pts = []
    for _ in range(30):
        nx = max(1, int((x1 - x0) / step) + 1)
        ny = max(1, int((y1 - y0) / step) + 1)
        if nx * ny > 200000:               # 防御：格子过密就放大步长
            step *= 1.3
            continue
        r2 = random.Random(seed)
        pts = []
        for gy in range(ny):
            cy = y0 + (gy + 0.5) * step
            for gx in range(nx):
                cx = x0 + (gx + 0.5) * step
                px = cx + r2.uniform(-0.36, 0.36) * step
                py = cy + r2.uniform(-0.36, 0.36) * step
                for k, poly in enumerate(polys):
                    b = boxes[k]
                    if not (b[0] <= px <= b[1] and b[2] <= py <= b[3]):
                        continue
                    if not _in_ring(px, py, poly[0]):
                        continue
                    if any(_in_ring(px, py, h) for h in poly[1:]):
                        continue
                    pts.append((px, py))
                    break
        if len(pts) >= n:
            break
        step *= 0.86

    if not pts:
        return [((x0 + x1) / 2.0, (y0 + y1) / 2.0)]

    rnd = random.Random(seed)
    rnd.shuffle(pts)
    out = []
    for i in range(n):
        if i < len(pts):
            out.append(pts[i])
        else:
            # 国土太小放不下这么多点：循环复用 + 轻微抖动，
            # 保证每个频道都有亮点（会挤在一起，属预期）
            bx, by = pts[i % len(pts)]
            k = (i // len(pts)) + 1
            out.append((bx + rnd.uniform(-0.05, 0.05) * step * k,
                        by + rnd.uniform(-0.05, 0.05) * step * k))
    return [(((lo + 180.0) % 360.0) - 180.0, la) for lo, la in out]


def main():
    channels = fetch('channels', SOURCES['channels'])
    streams = fetch('streams', SOURCES['streams'])
    countries = fetch('countries', SOURCES['countries'])
    categories = fetch('categories', SOURCES['categories'])
    logos = fetch('logos', SOURCES['logos'])
    world = fetch('world', SOURCES['world'])
    topo = fetch('topo', SOURCES['topo'])

    # ------------------------------------------------------------ 坐标
    latlng, area = {}, {}
    for w in world:
        if w.get('latlng'):
            latlng[w['cca2']] = w['latlng']
        if w.get('cca2'):
            area[w['cca2']] = w.get('area') or 0
    # iptv-org 使用了一些非 ISO 代码
    latlng['UK'] = latlng.get('GB'); area['UK'] = area.get('GB', 0)
    for code, ll in {'XK': [42.6, 20.9], 'EH': [24.5, -13.0], 'AN': [12.2, -69.0],
                     'CS': [44.0, 21.0], 'SU': [55.7, 37.6], 'YU': [44.0, 20.9],
                     'INT': None, 'XG': None}.items():
        latlng.setdefault(code, ll)

    cc_info = {c['code']: {'n': c['name'], 'f': c.get('flag') or ''} for c in countries}
    cat_name = {c['id']: c['name'] for c in categories}
    by_id = {c['id']: c for c in channels}

    # ------------------------------------------------------------ 线路挑选
    def rank(q):
        m = __import__('re').match(r'(\d+)', q or '')
        return -int(m.group(1)) if m else 8

    def score(s):
        u = s['url'].lower()
        v = 50 if not u.startswith('https') else 0
        v += 0 if '.m3u8' in u else (3 if '.mpd' in u else 12)
        v += rank(s.get('quality')) / 10.0
        if s.get('referrer'):
            v += 2
        return v

    per_channel = defaultdict(list)
    for s in streams:
        cid = s.get('channel')
        if cid in by_id:
            per_channel[cid].append(s)

    chosen = {}
    for cid, slist in per_channel.items():
        good = [s for s in slist if s['url'].lower().startswith(('http://', 'https://'))]
        if not good:
            continue
        good.sort(key=score)
        seen, keep = set(), []
        for s in good:
            if s['url'] in seen:
                continue
            seen.add(s['url'])
            keep.append(s)
            if len(keep) >= 5:
                break
        chosen[cid] = keep

    recs = []
    for cid, slist in chosen.items():
        c = by_id[cid]
        cc = c.get('country')
        if not cc or cc not in cc_info or latlng.get(cc) is None:
            continue
        if c.get('closed') or c.get('is_nsfw'):
            continue
        recs.append((cid, c, cc, slist))

    by_country = defaultdict(list)
    for r in recs:
        by_country[r[2]].append(r)

    # ------------------------------------------------------------ 地理散布
    GOLD = 2.399963229728653
    # 拓扑里的国家 id 是数字代码（ccn3），换成 ISO2 才能和 iptv-org 对上
    ccn3_to_cca2 = {}
    for w in world:
        if w.get('ccn3') and w.get('cca2'):
            ccn3_to_cca2[str(w['ccn3']).zfill(3)] = w['cca2']
    polys_by_cc, all_rings = topo_rings_by_country(topo, ccn3_to_cca2)
    polys_by_cc['UK'] = polys_by_cc.get('GB', [])      # iptv-org 用 UK 而不是 GB

    # ------------------------------------------------------------ 坐标
    # 三级定位（见 station_places.py）：
    #   city  频道名里写了城市 -> 该城市真实坐标
    #   org   命中「广播机构 -> 总部城市」表 -> 总部城市
    #   其余（含 Pluto 这类无实体台址的虚拟频道）-> 按城市人口权重落在该国城市里
    #
    # 只有该国在 GeoNames 里没有城市数据时，才退回最早的「国界内均匀撒点」。
    # 电视台都在城市里，几何均匀撒点会把一堆频道撒进荒漠和海面。
    out_channels, country_out = [], {}
    n_by_poly = n_fallback = 0
    stat = Counter()
    for cc, items in sorted(by_country.items(), key=lambda kv: -len(kv[1])):
        items.sort(key=lambda r: r[1]['name'].lower())
        n = len(items)

        resolved = []          # (lat, lon, kind)
        for (cid, c, _, slist) in items:
            kind, la, lo, _label = station_places.resolve(
                c.get('network'), c.get('owners'), c['name'],
                (c.get('alt_names') or [None])[0] or '', cc)
            stat[kind or 'none'] += 1
            resolved.append((la, lo, kind) if (kind in ('city', 'org') and la is not None)
                            else (None, None, kind or 'none'))

        result = [None] * n
        # 精确命中的：按城市分组，组内环形铺开（同城几十个台不会叠成一点）
        groups = {}
        for i, p in enumerate(resolved):
            if p[0] is not None:
                groups.setdefault((round(p[0], 2), round(p[1], 2)), []).append(i)
        for (la, lo), idxs in groups.items():
            for i, (plon, plat) in zip(idxs, station_places.spread_in_city(la, lo, len(idxs))):
                result[i] = (plon, plat)

        # 其余：城市加权
        rest = [i for i, p in enumerate(resolved) if p[0] is None]
        if rest:
            pts = station_places.city_weighted_points(
                cc, len(rest), seed=(sum(ord(ch) for ch in cc) * 7919) % 100000)
            if len(pts) != len(rest):
                # GeoNames 没这个国家的城市（XK / INT 等），退回国界内均匀撒点
                pts = sample_in_country(polys_by_cc.get(cc), len(rest),
                                        seed=(sum(ord(ch) for ch in cc) * 7919) % 100000)
                if len(pts) == len(rest):
                    n_by_poly += len(rest)
                else:
                    n_fallback += len(rest)
                if len(pts) != len(rest):
                    # 拓扑里也没有：用质心圆撒点兜底
                    n_fallback += len(rest)
                    base_lat, base_lon = latlng[cc]
                    coslat = max(0.22, math.cos(math.radians(base_lat)))
                    rmax = max(0.18, min(9.0, 0.9 * math.sqrt(max(area.get(cc) or 0, 1)) / 111.0))
                    pts = []
                    for i in range(len(rest)):
                        rad = rmax * math.sqrt((i + 0.5) / len(rest))
                        th = i * GOLD
                        pts.append((base_lon + rad * math.cos(th) / coslat,
                                    max(-84.0, min(84.0, base_lat + rad * math.sin(th)))))
            for i, (plon, plat) in zip(rest, pts):
                result[i] = (plon, plat)

        pts = result
        for (lo, la), (cid, c, _, slist), (_la, _lo, kind) in zip(pts, items, resolved):
            rec = {
                'i': cid, 'n': c['name'], 'a': (c.get('alt_names') or [None])[0] or '',
                'c': cc, 'k': c.get('categories') or [], 'w': c.get('website') or '', 'o': '',
                'la': round(la, 3), 'lo': round(lo, 3),
                's': [[s['url'], s.get('quality') or '', s.get('referrer') or '', s.get('user_agent') or ''] for s in slist],
            }
            # 位置等级：0 精确定位（城市级/机构级）| 1 城市加权兜底 | 2 虚拟网络频道（无实体台址）
            # 0 不写字段，省一点体积；前端用 (ch.p || 0) 读
            if kind == 'fast':
                rec['p'] = 2
            elif kind != 'city' and kind != 'org':
                rec['p'] = 1
            out_channels.append(rec)
        country_out[cc] = {'n': cc_info[cc]['n'], 'f': cc_info[cc]['f'],
                           'la': round(latlng[cc][0], 3), 'lo': round(latlng[cc][1], 3), 'c': n}
    tot = sum(stat.values()) or 1
    print('坐标定位  城市级 %d (%.1f%%) / 机构级 %d (%.1f%%) / 城市加权兜底 %d (%.1f%%)'
          % (stat['city'], stat['city'] * 100.0 / tot,
             stat['org'], stat['org'] * 100.0 / tot,
             stat['none'] + stat['fast'], (stat['none'] + stat['fast']) * 100.0 / tot))
    print('          其中无实体台址的虚拟频道 %d 个；无城市数据退回旧撒点 %d 个'
          % (stat['fast'], n_by_poly + n_fallback))

    # ------------------------------------------------------------ 台标
    best_logo = {}
    for lg in logos:
        cid, url = lg.get('channel'), lg.get('url')
        if not cid or not url or not url.lower().startswith('https') or not lg.get('in_use', True):
            continue
        sc = 4 + (2 if lg.get('format') == 'PNG' else 0) + (1 if (lg.get('width') or 0) >= 100 else 0)
        cur = best_logo.get(cid)
        if cur is None or sc > cur[0]:
            best_logo[cid] = (sc, url)
    for ch in out_channels:
        got = best_logo.get(ch['i'])
        if got:
            ch['o'] = got[1]

    used = Counter()
    for ch in out_channels:
        for k in ch['k']:
            used[k] += 1
    cats = [{'id': k, 'n': cat_name.get(k, k), 'c': v} for k, v in used.most_common()]

    payload = {
        'meta': {'source': 'iptv-org', 'url': 'https://github.com/iptv-org/iptv',
                 'api': 'https://iptv-org.github.io/api/', 'generated': time.strftime('%Y-%m-%d'),
                 'channels': len(out_channels), 'countries': len(country_out),
                 'streams': sum(len(c['s']) for c in out_channels)},
        'categories': cats, 'countries': country_out, 'channels': out_channels,
    }
    txt = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    # channels.js  ：给本地 file:// 直开和资源较旧的浏览器兜底
    # channels.json.gz：线上走这个（静态托管不做 gzip，体积差 4.6 倍）
    with open(os.path.join(DATA, 'channels.js'), 'w', encoding='utf-8') as f:
        f.write('window.TV_DATA=' + txt + ';\n')
    raw = txt.encode('utf-8')
    with open(os.path.join(DATA, 'channels.json.gz'), 'wb') as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
    print('channels.js  %.2f MB  ->  channels.json.gz  %.2f MB (%d 频道 / %d 国家 / %d 线路)'
          % (len(raw) / 1048576, os.path.getsize(os.path.join(DATA, 'channels.json.gz')) / 1048576,
             len(out_channels), len(country_out), payload['meta']['streams']))

    # ------------------------------------------------------------ 地图轮廓
    # 直接复用上面采样时解出来的轮廓，不再重复解析一遍 topojson
    rings = all_rings
    print('地图轮廓  %d 个环 / %d 个点' % (len(rings), sum(len(r) for r in rings)))

    # ------------------------------------------------------------ 贴图
    # 预处理成可直接绘制的环：经度解开 + 补 ±360° 副本（覆盖接缝）
    def copies(pts):
        return [pts,
                [(lo - 360.0, la) for lo, la in pts],
                [(lo + 360.0, la) for lo, la in pts]]

    draw_rings = []          # 闭合环（普通国家）
    coast_lines = []         # (折线, 是否闭合)
    pole_fills = []          # 需要补画到极点的纬度（南极洲）
    pole_rings = []          # 南极洲 ring：逐列填充用
    for ring in rings:
        ur = unwrap_ring(ring)
        lons = [p[0] for p in ur]
        if max(lons) - min(lons) >= 350:
            # 环绕极点的环（南极洲）：数据用一条贴着最低纬度的人为闭合边收口。
            # 直接画会有两个问题：极点被涂成海洋、冰盖中间多出一条假海岸线。
            # 处理办法：海岸按开口折线画（切掉人为边）；
            # 填色在 render_texture 里逐列处理（见 pole_rings）。
            #
            # ⚠️ 填色不能只靠 polygon 奇偶填充 + minla 以下的矩形：人为闭合边
            # 和真实海岸最低点之间会漏出一条横贯全图的海洋色带，球面上就是
            # 极点旁一圈突兀的暗环（用户反馈过）；而且海岸下探最深处
            # （罗斯冰架一带）扫描线交点为偶数，奇偶填充照样漏。
            minla = min(p[1] for p in ur)
            pole_fills.append(minla)
            pole_rings.append(ur)
            draw_rings.extend(copies(ur))
            run = []
            for pt in ur:
                if pt[1] <= minla + 0.02:
                    if len(run) > 1:
                        coast_lines.append((run, False))
                    run = []
                else:
                    run.append(pt)
            if len(run) > 1:
                coast_lines.append((run, False))
            continue
        draw_rings.extend(copies(ur))
        coast_lines.append((ur, True))

    def render_texture(path, theme):
        W, H, S = 4096, 2048, 2
        W2, H2 = W * S, H * S

        def px(lon, lat):
            return ((lon + 180.0) / 360.0 * W2, (90.0 - lat) / 180.0 * H2)

        # 陆地上原本还叠了一层 9px 周期的半调网点（dot 变量）。
        # 用户反馈那片灰色点点很影响观感，已整体移除，陆地现在是纯色块，
        # 只靠海岸线 / 国界线勾轮廓。不要再加回来。
        #
        # 颜色取值原则（踩过坑）：不能贴着纯黑或纯白，否则在不同显示链路
        # （HDR 显示器、系统对比度增强）上会被压没。
        # 深色：海洋必须明显亮于页面底色 (#18191b)，地球才不会看成一个黑洞；
        # 浅色：海洋必须明显暗于页面底色 (#e9ebee)，地球才不会在白底上"隐身"。
        if theme == 'dark':
            ocean, land = (27, 35, 44), (50, 58, 68)
            coast, grat = (206, 232, 224, 120), (255, 255, 255, 18)
        else:
            ocean, land = (148, 162, 178), (208, 215, 224)
            coast, grat = (26, 56, 52, 140), (30, 48, 64, 24)

        mask = Image.new('L', (W2, H2), 0)
        md = ImageDraw.Draw(mask)
        for ring in draw_rings:
            poly = [px(lo, la) for lo, la in ring]
            if len(poly) > 2:
                md.polygon(poly, fill=255)
        for la in pole_fills:                      # 南极洲：一直填到极点
            md.polygon([px(-180, la), px(180, la), px(180, -90), px(-180, -90)], fill=255)
        # 南极洲逐列填充：每个经度上，从最南海岸点一直填到贴图底边。
        # 奇偶填充在极区会被人为闭合边和下探的海岸搅出漏带（球面上是
        # 极点旁的暗环），这里利用「南极洲在每个经度上都连着极点」的
        # 地理事实按列兜全，不依赖奇偶判定。
        for pring in pole_rings:
            pts = [px(lo, la) for lo, la in pring]
            n = len(pts)
            col_y = {}
            for i in range(n):
                x1, y1 = pts[i]
                x2, y2 = pts[(i + 1) % n]
                if x1 == x2:
                    continue
                if x2 < x1:
                    x1, y1, x2, y2 = x2, y2, x1, y1
                span = x2 - x1
                for xi in range(max(0, int(x1)), min(W2, int(x2) + 1)):
                    yy = y1 + (y2 - y1) * ((xi + 0.5 - x1) / span)
                    if yy > col_y.get(xi, -1.0):
                        col_y[xi] = yy
            for xi, yy in col_y.items():
                md.line([(xi, yy), (xi, H2)], fill=255)
        mask_s = mask.resize((W, H), Image.LANCZOS)

        line = Image.new('L', (W2, H2), 0)
        ld = ImageDraw.Draw(line)
        for pts, closed in coast_lines:
            for seg in copies(pts):
                poly = [px(lo, la) for lo, la in seg]
                if len(poly) < 2:
                    continue
                if closed:
                    poly = poly + [poly[0]]
                ld.line(poly, fill=255, width=max(1, int(1.6 * S)), joint='curve')
        line_s = line.resize((W, H), Image.LANCZOS)

        grat_l = Image.new('L', (W2, H2), 0)
        gd = ImageDraw.Draw(grat_l)
        for lon in range(-180, 181, 15):
            gd.line([(px(lon, -90)[0], 0), (px(lon, 90)[0], H2)], fill=255, width=S)
        # 纬线只画到 ±60°：±75° 那两条在贴图上是横线，但到了球面上、
        # 视线正对极点时会变成一个以极点为圆心的突兀圆环（用户反馈过）。
        # 极区保持干净，不要再把范围改回 ±75。
        for lat in range(-60, 61, 15):
            y = px(0, lat)[1]
            gd.line([(0, y), (W2, y)], fill=255, width=S)
        grat_s = grat_l.resize((W, H), Image.LANCZOS)

        base = Image.new('RGB', (W, H), ocean)
        base.paste(Image.new('RGB', (W, H), land), (0, 0), mask_s)
        base.paste(Image.new('RGB', (W, H), grat[:3]), (0, 0), grat_s.point(lambda v: int(v * grat[3] / 255.0)))
        base.paste(Image.new('RGB', (W, H), coast[:3]), (0, 0), line_s.point(lambda v: int(v * coast[3] / 255.0)))
        base.save(path, 'JPEG', quality=85, optimize=True)
        print('%-22s %.2f MB' % (os.path.basename(path), os.path.getsize(path) / 1048576))

    render_texture(os.path.join(TEX, 'earth-dark.jpg'), 'dark')
    render_texture(os.path.join(TEX, 'earth-light.jpg'), 'light')

    print('\n前 10 个国家：')
    for cc, items in sorted(by_country.items(), key=lambda kv: -len(kv[1]))[:10]:
        print('   %-4s %-20s %4d 个频道' % (cc, cc_info[cc]['n'], len(items)))


if __name__ == '__main__':
    main()
