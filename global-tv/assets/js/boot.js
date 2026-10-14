/* ============================================================
   Globe TV — 数据加载 + 启动
   静态托管一般不做 gzip，所以数据额外预压了一份 gz（3.1MB -> 0.68MB）。
   这里优先带进度地拉 gz，再用浏览器原生 DecompressionStream 解压；
   拿不到（老浏览器 / file:// 直开）就退回普通 <script>。
   ============================================================ */
(function () {
  'use strict';

  var GZ = 'assets/js/data/channels.json.gz';
  var PLAIN = 'assets/js/data/channels.js';
  var sub = document.getElementById('boot-sub');
  var started = false;
  var guard = null;
  var pendingReader = null;

  function say(t) { if (sub) sub.textContent = t; }

  function finish(via) {
    if (started) return;
    started = true;
    if (guard) { clearTimeout(guard); guard = null; }
    if (typeof window.__startGlobeTV !== 'function') {
      console.error('启动入口缺失（app.js 未加载）');
      return;
    }
    window.__startGlobeTV();
  }

  function plain() {
    if (started) return;
    say('载入频道目录…');
    var s = document.createElement('script');
    s.src = PLAIN;
    s.onload = function () { finish('plain'); };
    s.onerror = function () {
      say('频道数据加载失败，请刷新重试');
      console.error('无法加载 ' + PLAIN);
    };
    document.head.appendChild(s);
  }

  function pump(reader, chunks, got, total) {
    return reader.read().then(function (res) {
      if (res.done) {
        var all = new Uint8Array(got), off = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
        return all.buffer;
      }
      chunks.push(res.value);
      got += res.value.length;
      say(total ? '下载频道目录 ' + Math.round(got / total * 100) + '%'
        : '下载频道目录 ' + (got / 1024 | 0) + ' KB');
      return pump(reader, chunks, got, total);
    });
  }

  function loadGz() {
    if (started) return;
    // file:// 下 fetch 会被同源策略拦掉，直接用未压缩版本
    if (location.protocol === 'file:') return plain();
    if (!('DecompressionStream' in window) || !window.fetch) return plain();
    say('连接服务器…');

    // index.html 里的内联脚本已经提前发了这个请求，这里直接复用它
    Promise.resolve(window.__tvGz || fetch(GZ))
      .then(function (r) {
        if (!r) throw new Error('无网络响应');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = parseInt(r.headers.get('Content-Length') || '0', 10);
        if (!r.body) return r.arrayBuffer();
        pendingReader = r.body.getReader();
        return pump(pendingReader, [], 0, total);
      })
      .then(function (buf) {
        say('解压数据 ' + ((buf.byteLength / 1048576) || 0).toFixed(1) + ' MB…');
        var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      })
      .then(function (txt) {
        say('解析频道数据…');
        window.TV_DATA = JSON.parse(txt);
        finish('gz');
      })
      .catch(function (e) {
        console.warn('gz 数据加载失败，改用未压缩版本：', e && e.message);
        if (pendingReader) { try { pendingReader.cancel(); } catch (x) { } }
        plain();
      });
  }

  guard = setTimeout(function () {
    if (!started) { console.warn('gz 数据加载超时，改用未压缩版本'); plain(); }
  }, 15000);

  // 内联脚本已经发了请求，这里立刻开始读进度；数据请求与库文件下载是并行的
  loadGz();
})();
