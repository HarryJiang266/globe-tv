# -*- coding: utf-8 -*-
"""本地 HTTPS 静态服务，用来验证「线上 HTTPS」下的实际行为（自签证书，仅本地测试用）"""
import http.server, os, ssl, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), 'global-tv')    # 发布目录
CERT = os.path.join(HERE, '.devcert')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def ensure_cert():
    """没有证书就用 openssl 现场生成一张自签的（仅本地测试用）"""
    cert, key = os.path.join(CERT, 'cert.pem'), os.path.join(CERT, 'key.pem')
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    os.makedirs(CERT, exist_ok=True)
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
                    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
                   check=True, capture_output=True)
    return cert, key


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    cert, key = ensure_cert()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    sys.stderr.write('https://127.0.0.1:%d/  serving %s\n' % (port, os.path.abspath(ROOT)))
    httpd.serve_forever()
