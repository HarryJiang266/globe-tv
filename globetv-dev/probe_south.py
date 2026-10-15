"""检查贴图南极底部纬度带的像素，找暗环来源。"""
from PIL import Image

im = Image.open(r"C:\Users\harry\WorkBuddy\2026-10-13-11-28-11\global-tv\assets\img\earth-dark.jpg").convert("L")
px = im.load()
W, H = im.size

def lat2y(lat):
    return round((90 - lat) / 180 * H)

# 南极大陆内部几个经度，打印 y=1940..2047 的亮度剖面
for lon in (-150, -90, 0, 90, 150):
    x = round((lon + 180) / 360 * W)
    col = [px[x, y] for y in range(1940, 2048, 6)]
    print("lon=%5d  y1940-2047:" % lon, col)

# 找出 1940~2048 范围内整行亮度突变的位置
print()
for y in range(1940, 2047):
    row = [px[x, y] for x in range(0, W, 64)]
    avg = sum(row) / len(row)
    row2 = [px[x, y + 1] for x in range(0, W, 64)]
    avg2 = sum(row2) / len(row2)
    if abs(avg - avg2) > 4:
        print("y=%d avg=%.1f -> y=%d avg=%.1f  (lat %.1f)" % (
            y, avg, y + 1, avg2, 90 - (y + 1) / H * 180))
