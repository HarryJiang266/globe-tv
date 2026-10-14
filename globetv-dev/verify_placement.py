# -*- coding: utf-8 -*-
"""亮点落点与贴图伪影自检

回答两个问题：
  1. 数据集里的频道坐标有多少落在海里（目标：接近 0）
  2. 贴图里有没有"横穿整幅地图"的反经线假线

用法（在 globetv-dev/ 下）：
    python verify_placement.py
"""
import json
import os
import sys

from PIL import Image, ImageDraw

import build_data as B

ROOT = B.ROOT
W, H = 4096, 2048
CH = os.path.join(ROOT, 'assets', 'js', 'data', 'channels.js')


def land_mask(rings):
    """按绘制时的解环方式生成陆地掩码（与贴图口径一致）。"""
    draw = []
    for r in rings:
        ur = B.unwrap_ring(r)
        draw.append(ur)
        draw.append([(lo - 360.0, la) for lo, la in ur])
        draw.append([(lo + 360.0, la) for lo, la in ur])
    m = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(m)
    for r in draw:
        pts = [((lo + 180.0) / 360.0 * W, (90.0 - la) / 180.0 * H) for lo, la in r]
        if len(pts) > 2:
            d.polygon(pts, fill=255)
    return m.load()


def main():
    topo = B.fetch('topo', B.SOURCES['topo'])
    world = B.fetch('world', B.SOURCES['world'])
    c3 = {}
    for w in world:
        if w.get('ccn3') and w.get('cca2'):
            c3[str(w['ccn3']).zfill(3)] = w['cca2']
    _, all_rings = B.topo_rings_by_country(topo, c3)
    px = land_mask(all_rings)

    def on_land(lo, la):
        return px[int((lo + 180.0) / 360.0 * W) % W,
                  min(H - 1, max(0, int((90.0 - la) / 180.0 * H)))] > 0

    txt = open(CH, encoding='utf-8').read()
    chans = json.loads(txt[txt.index('=') + 1:].rstrip().rstrip(';'))['channels']
    sea = [c for c in chans if not on_land(c['lo'], c['la'])]
    print('=== 亮点落点 ===')
    print('  频道坐标共 %d 个' % len(chans))
    print('  落在海里   %d (%.2f%%)   ← 目标接近 0' % (len(sea), 100.0 * len(sea) / len(chans)))

    by_cc = {}
    for c in chans:
        by_cc.setdefault(c['c'], []).append(c)
    print('\n  落在海里最多的国家：')
    ranks = sorted(by_cc.items(), key=lambda kv: -sum(1 for c in kv[1] if not on_land(c['lo'], c['la'])))[:6]
    for cc, arr in ranks:
        bad = sum(1 for c in arr if not on_land(c['lo'], c['la']))
        if bad:
            print('    %-4s %4d 个里 %3d 个在海上' % (cc, len(arr), bad))
    if ranks and not sum(1 for c in ranks[0][1] if not on_land(c['lo'], c['la'])):
        print('    （没有落海的国家）')

    print('\n=== 贴图伪影检查（横穿整幅地图的假线）===')
    for theme in ('dark', 'light'):
        path = os.path.join(ROOT, 'assets', 'img', 'earth-%s.jpg' % theme)
        im = Image.open(path).convert('RGB')
        w2, h2 = im.size
        p = im.load()
        # 判定标准用"最长连续段"：真正的反经线假线会是一条横贯整幅图的长线，
        # 而正常海岸线即使一行里像素很多，也是许多短段（行均值会被骗）。
        # 海岸线颜色：深色主题是亮青 (206,232,224)，浅色主题是暗青 (26,56,52)，
        # 所以判定条件要跟着主题走（浅色的海洋本身就偏亮，用"亮"判会全中）。
        if theme == 'dark':
            def is_coast(r, g, b):
                return g > 90 and g >= r + 10
        else:
            def is_coast(r, g, b):
                return r + g + b < 300

        worst = []
        for y in range(h2):
            cur = best = 0
            for x in range(w2):
                if is_coast(*p[x, y]):
                    cur += 1
                    if cur > best:
                        best = cur
                else:
                    cur = 0
            worst.append(best)
        top = sorted(((n, y) for y, n in enumerate(worst)), reverse=True)[:3]
        span = max(worst)
        print('  %-6s 单行最长连续海岸段 %d px (占整宽 %.1f%%)' % (theme, span, 100.0 * span / w2))
        for n, y in top:
            print('        y=%d (纬度 %.1f) 连续 %d px' % (y, 90 - y / h2 * 180, n))
        print('        %s' % ('✓ 没有横穿整幅图的假线' if span < w2 * 0.25
                             else '✗ 疑似仍有假线（应为真实海岸线，或需继续排查）'))


if __name__ == '__main__':
    main()
