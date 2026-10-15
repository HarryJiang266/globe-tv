"""检测地球贴图是否还有 9px 周期网点（halftone dots）。

判据：全图按 16x16 分块，统计"完全纯色块"（块内 max-min == 0）的占比。
- 有网点时：陆地块内部会有 9px 周期的明暗起伏，几乎不可能纯色 → 占比低
- 无网点时：陆地与海洋都是大块纯色 → 占比高

为什么不用 lag9 自相关：自相关会把"图像本身很平滑"也算进去
（大片纯色海洋的 lag9 同样接近 1），无法区分"平滑"与"周期纹理"。

用法: python check_live_dots.py          # 只查线上
      python check_live_dots.py --ab     # 额外拉基线(ec861d6)做 A/B 对照
"""
import hashlib
import io
import os
import subprocess
import sys
import urllib.request

from PIL import Image

BASE_URL = "https://global-tv-globe.app.workbuddy.host/assets/img/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(ROOT, "global-tv", "assets", "img")
BASE_REV = "ec861d6"
PATCH = 16


def flat_ratio(im):
    """完全纯色的 16x16 块占全部块的比例。"""
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    total = flat = 0
    for by in range(0, h - PATCH, PATCH * 4):
        for bx in range(0, w - PATCH, PATCH * 4):
            vals = [px[x, y]
                    for y in range(by, by + PATCH)
                    for x in range(bx, bx + PATCH)]
            total += 1
            if max(vals) == min(vals):
                flat += 1
    return flat / total


def base_bytes(name):
    rel = "global-tv/assets/img/" + name
    return subprocess.run(
        ["git", "show", BASE_REV + ":" + rel],
        cwd=ROOT, stdout=subprocess.PIPE, check=True).stdout


def show(tag, raw):
    print("%-30s 纯色块占比=%.3f  md5=%s"
          % (tag, flat_ratio(Image.open(io.BytesIO(raw))),
             hashlib.md5(raw).hexdigest()[:12]))


if __name__ == "__main__":
    ab = "--ab" in sys.argv
    results = {}
    for name in ("earth-dark.jpg", "earth-light.jpg"):
        raw = urllib.request.urlopen(BASE_URL + name, timeout=30).read()
        with open(os.path.join(LOCAL, name), "rb") as fh:
            local = fh.read()
        same = hashlib.md5(raw).hexdigest() == hashlib.md5(local).hexdigest()
        print("[%s] 线上与本地一致: %s" % (name, same))
        if ab:
            show("  BASE(%s, 带网点)" % BASE_REV, base_bytes(name))
        show("  LIVE(当前线上)", raw)
        results[name] = same

    ok = all(results.values())
    print("RESULT:", "OK 线上贴图与本地一致" if ok else "FAIL 线上与本地不一致")
