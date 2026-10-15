"""校验极区纬线（±75°）已从贴图移除，±60° 仍保留。

等距圆柱投影：y = (90 - lat) / 180 * H。H=2048：
  75S -> y=1877   60S -> y=1706
在中太平洋（lon=-150）取竖直像素列，纬线处应有明显亮峰。
"""
import io
import subprocess

from PIL import Image

ROOT = r"C:\Users\harry\WorkBuddy\2026-10-13-11-28-11"
X = int((-150 + 180) / 360 * 4096)  # 中太平洋，纯海洋


def col_peak(im, y_target):
    """返回目标行附近 ±6 行里的最大亮度。"""
    px = im.convert("L").load()
    return max(px[X, y] for y in range(y_target - 6, y_target + 7))


Y75 = round((90 + 75) / 180 * 2048)
Y60 = round((90 + 60) / 180 * 2048)

for name in ("earth-dark.jpg", "earth-light.jpg"):
    old = Image.open(io.BytesIO(subprocess.run(
        ["git", "-C", ROOT, "show", "HEAD:global-tv/assets/img/" + name],
        stdout=subprocess.PIPE, check=True).stdout))
    new = Image.open(ROOT + r"\global-tv\assets\img" + "\\" + name)
    for tag, y in (("75°", Y75), ("60°", Y60)):
        print("%-16s %s  旧版亮度峰值=%3d  新版=%3d"
              % (name, tag + "S" if tag.endswith("75") else tag + "S",
                 col_peak(old, y), col_peak(new, y)))
