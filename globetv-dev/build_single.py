# -*- coding: utf-8 -*-
"""Globe TV — 单文件构建

把整站压成一个 index.html：CSS、JS、字体、贴图、频道数据全部内联。

为什么需要：平台的「网页」发布通道只上传递入口 HTML，assets/ 下的文件不会上传，
任何子路径都返回首页，多文件站点在线上必然 404。单文件版本没有子资源，能跑。

    python build_single.py            # 输出到 ../dist-single/index.html

代价：首屏要下载整包（约 5MB），并且失去分文件缓存。只在多文件发布不可用时用。
"""
import base64
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(os.path.dirname(HERE), 'global-tv')
OUT_DIR = os.path.join(os.path.dirname(HERE), 'dist-single')
OUT = os.path.join(OUT_DIR, 'index.html')


def read(path, binary=False):
    if binary:
        with open(path, 'rb') as f:
            return f.read()
    with io.open(path, encoding='utf-8') as f:
        return f.read()


def data_url(path, mime):
    return 'data:%s;base64,%s' % (mime, base64.b64encode(read(path, True)).decode('ascii'))


def safe_script(js):
    # 内联脚本里出现 </script 会提前闭合标签
    return js.replace('</script', '<\\/script')


def main():
    html = read(os.path.join(SITE, 'index.html'))
    css = read(os.path.join(SITE, 'assets/css/style.css'))
    bundle = read(os.path.join(SITE, 'assets/js/app.bundle.js'))
    three = read(os.path.join(SITE, 'assets/vendor/three.min.js'))
    hls = read(os.path.join(SITE, 'assets/vendor/hls.min.js'))
    gz = read(os.path.join(SITE, 'assets/js/data/channels.json.gz'), True)

    fonts = {
        'InstrumentSerif-Regular-latin.woff2': 'font/woff2',
        'InstrumentSerif-Italic-latin.woff2': 'font/woff2',
        'Montserrat-latin.woff2': 'font/woff2',
        'Montserrat-latin-ext.woff2': 'font/woff2',
        'Nunito-latin.woff2': 'font/woff2',
        'Nunito-latin-ext.woff2': 'font/woff2',
    }
    for name, mime in fonts.items():
        p = os.path.join(SITE, 'assets/fonts', name)
        if os.path.exists(p):
            css = css.replace('../fonts/' + name, data_url(p, mime))

    # 贴图：换掉 globe.js 里 THEME 的两条路径
    for name in ('earth-dark.jpg', 'earth-light.jpg'):
        p = os.path.join(SITE, 'assets/img', name)
        bundle = bundle.replace("'assets/img/" + name + "'", "'" + data_url(p, 'image/jpeg') + "'")

    # 内联 CSS
    html = html.replace(
        '<link rel="stylesheet" href="assets/css/style.css" />',
        '<style>\n' + css + '\n</style>')

    # favicon 内联
    html = re.sub(r'<link rel="icon"[^>]*>',
                  '<link rel="icon" href="%s" type="image/svg+xml" />'
                  % data_url(os.path.join(SITE, 'assets/img/favicon.svg'), 'image/svg+xml'),
                  html)

    # 头部那段预加载脚本：去掉会 404 的 preload，改为把频道数据塞成内存里的 Response
    head_script = re.search(r'<script>\n(/\* 尽早并行.*?)\n</script>', html, re.S)
    if not head_script:
        raise SystemExit('没找到头部内联脚本，index.html 结构变了？')
    theme_part = head_script.group(1)
    theme_part = theme_part.split('if (location.protocol')[0].rstrip()
    theme_part = theme_part.replace('<script>', '').strip()
    b64 = base64.b64encode(gz).decode('ascii')
    new_head = (
        '<script>\n' + theme_part + '\n})();\n\n'
        '/* 单文件版：频道数据以 gz 字节内联，boot.js 会直接复用这个 Response。 */\n'
        'window.__tvGz = Promise.resolve(new Response(\n'
        "  Uint8Array.from(atob('%s'), function (c) { return c.charCodeAt(0); }),\n"
        "  { headers: { 'Content-Length': '%d' } }\n"
        '));\n'
        '</script>' % (b64, len(gz)))
    html = html[:head_script.start()] + new_head + html[head_script.end():]

    # 两个外链脚本改成内联
    html = html.replace('<script src="assets/vendor/three.min.js" defer></script>',
                        '<script>\n' + safe_script(three) + '\n</script>')
    # hls.js 不在 index.html 里，是播放时按需插 <script> 加载的（player.js 的 HLS_URL）。
    # 单文件版没有 assets/ 可加载，必须提前内联，让 needHls() 的 window.Hls 检查直接短路。
    html = html.replace('<script src="assets/js/app.bundle.js" defer></script>',
                        '<script>\n' + safe_script(hls) + '\n</script>\n'
                        '<script>\n' + safe_script(bundle) + '\n</script>')

    left = re.findall(r'(?:src|href)="(assets/[^"]+)"', html)
    if left:
        raise SystemExit('还有未内联的外部资源：%s' % sorted(set(left)))
    if 'assets/img/earth-' in html:
        raise SystemExit('贴图路径没有全部替换')
    # player.js 里仍留着 HLS_URL 常量，但 needHls() 会先看 window.Hls，
    # 只要 hls.js 内联在 bundle 之前，这条路就不会被走到（构建后用浏览器验 window.Hls）。
    if 'Hls=' not in html and 'Hls =' not in html:
        raise SystemExit('hls.js 似乎没有内联进来')

    os.makedirs(OUT_DIR, exist_ok=True)
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('单文件  %s  %.2f MB' % (OUT, os.path.getsize(OUT) / 1048576))


if __name__ == '__main__':
    main()
