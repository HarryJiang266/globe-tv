"""探测 github.com:443 是否可连（TCP -> TLS 握手）。

坑：curl 在沙箱里对 github.com 恒返回 HTTP 000，会把通的误判成不通，
所以只用 socket 逐层测。代理端口一天内会变（8523/8226/9365/2941），
每次都重新扫，不沿用上次的结论。
"""
import os, socket, ssl


def tcp_ok(host, port, timeout=4.0):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except OSError:
        return False


def tls_ok(host, port, timeout=6.0):
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as s:
            with ctx.wrap_socket(s, server_hostname=host):
                return True
    except Exception as e:
        return 'ERR: %s' % type(e).__name__


def proxy_ports():
    out = []
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
              'ALL_PROXY', 'all_proxy'):
        v = os.environ.get(k)
        if not v:
            continue
        v = v.rstrip('/')
        if '://' in v:
            v = v.split('://', 1)[1]
        host, _, p = v.partition(':')
        if p.isdigit():
            out.append((k, int(p)))
    return out


print('TCP  github.com:443 ->', tcp_ok('github.com', 443))
print('TLS  github.com:443 ->', tls_ok('github.com', 443))
for k, p in proxy_ports():
    print('proxy %s=%d  TCP127.0.0.1 -> %s | TLS->github -> %s'
          % (k, p, tcp_ok('127.0.0.1', p), tls_ok('github.com', 443)))
