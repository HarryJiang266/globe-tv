"""诊断：代理端口是否活、代理能否 CONNECT github、按域名直连能否完整 TLS。"""
import os
import socket
import ssl
import urllib.request

# 1. 代理端口
proxy_url = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
print("proxy env:", proxy_url)
if proxy_url:
    host, port = proxy_url.replace("http://", "").split(":")
    try:
        socket.create_connection((host, int(port)), timeout=4).close()
        print("proxy port: ALIVE")
        # 2. 通过代理访问 github（CONNECT 隧道）
        try:
            ph = urllib.request.ProxyHandler({"https": proxy_url})
            r = urllib.request.build_opener(ph).open(
                "https://github.com/HarryJiang266/globe-tv", timeout=15)
            print("via proxy: HTTP", r.status)
        except Exception as exc:
            print("via proxy: FAIL", type(exc).__name__, str(exc)[:80])
    except Exception as exc:
        print("proxy port: DEAD", type(exc).__name__)

# 3. 按域名直连 + 完整 TLS 握手
try:
    s = socket.create_connection(("github.com", 443), timeout=8)
    ss = ssl.create_default_context().wrap_socket(s, server_hostname="github.com")
    print("direct by name + TLS: OK", ss.version())
    ss.close()
except Exception as exc:
    print("direct by name + TLS: FAIL", type(exc).__name__, str(exc)[:80])
