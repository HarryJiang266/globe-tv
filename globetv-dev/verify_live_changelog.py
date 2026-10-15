"""校验线上 app.bundle.js 是否已包含最新一条更新记录。"""
import hashlib
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://global-tv-globe.app.workbuddy.host/assets/js/app.bundle.js"
LOCAL = os.path.join(ROOT, "global-tv", "assets", "js", "app.bundle.js")

raw = urllib.request.urlopen(URL, timeout=30).read()
text = raw.decode("utf-8")
with open(LOCAL, "rb") as fh:
    local = fh.read()

print("live size   :", len(raw))
print("live md5    :", hashlib.md5(raw).hexdigest()[:12])
print("matches local:", hashlib.md5(local).hexdigest() == hashlib.md5(raw).hexdigest())
print("current=2026-10-15.1 :", "2026-10-15.1" in text)
print("新条目标题存在       :", "去掉陆地上的网点纹理" in text)
