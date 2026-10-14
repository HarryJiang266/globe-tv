# -*- coding: utf-8 -*-
"""
Globe TV — 前端脚本打包

线上静态托管每个请求有 1~2 秒的基础延迟（连 2KB 的文件都要 2 秒），所以把 4 个
应用脚本合并成 1 个请求，首屏能从 ~10 次请求降到 ~6 次、且全部并行。

源文件仍是唯一事实来源，改完源码后跑一次本脚本重新生成：
    python tools/bundle.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))          # globetv-dev/
ROOT = os.path.join(os.path.dirname(HERE), 'global-tv')    # 发布目录
JS = os.path.join(ROOT, 'assets', 'js')

# 顺序有依赖：changelog 是数据，player/globe 只定义构造函数，
# app 在其上定义启动入口，boot 最后触发
PARTS = ['changelog.js', 'globe.js', 'player.js', 'app.js', 'boot.js']
OUT = os.path.join(JS, 'app.bundle.js')


def main():
    chunks = []
    for name in PARTS:
        path = os.path.join(JS, name)
        with open(path, encoding='utf-8') as f:
            src = f.read()
        if src.startswith('\ufeff'):
            src = src[1:]
        chunks.append('/* ===== %s ===== */\n%s' % (name, src.rstrip()))

    bundle = ('/* Globe TV — 自动生成，请勿直接修改。\n'
              '   源文件：%s\n'
              '   重新生成：python tools/bundle.py */\n' % ' + '.join(PARTS)) + '\n\n'.join(chunks) + '\n'

    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(bundle)

    total = sum(os.path.getsize(os.path.join(JS, n)) for n in PARTS)
    print('app.bundle.js  %d 个源文件 -> 1 个请求，%.1f KB (源 %.1f KB)'
          % (len(PARTS), os.path.getsize(OUT) / 1024, total / 1024))


if __name__ == '__main__':
    main()
