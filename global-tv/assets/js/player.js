/* ============================================================
   Globe TV — 播放器
   HLS / 直链播放，线路失效自动切换，失败时给出可操作提示
   ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------- 公共小工具
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function initials(name) {
    var s = (name || '?').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
    var parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) return 'TV';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  function logoInner(ch) {
    if (ch.o) {
      var img = el('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.onerror = function () {
        if (img.parentNode) img.parentNode.replaceChild(el('span', null, initials(ch.n)), img);
      };
      img.src = ch.o;
      return img;
    }
    return el('span', null, initials(ch.n));
  }
  function logoInto(host, ch) {
    host.innerHTML = '';
    host.appendChild(logoInner(ch));
  }
  function logoEl(ch, cls) {
    var box = el('div', cls || 'logoimg');
    box.appendChild(logoInner(ch));
    return box;
  }
  function fmt(n) { return (n || 0).toLocaleString('en-US'); }
  function ccLabel(cc, info) {
    if (!info) return cc || '';
    return (info.f ? info.f + ' ' : '') + info.n;
  }

  window.TVUtil = { el: el, logoEl: logoEl, logoInto: logoInto, initials: initials, fmt: fmt, ccLabel: ccLabel };

  // ---------------------------------------------------------- 播放器
  var HLS_URL = 'assets/vendor/hls.min.js';
  var hlsState = 0;          // 0 未加载 / 1 加载中 / 2 就绪 / -1 失败
  var hlsQueue = [];

  function needHls(cb) {
    if (window.Hls) { cb(null); return; }
    if (hlsState === -1) { cb(new Error('hls.js 加载失败')); return; }
    hlsQueue.push(cb);
    if (hlsState === 1) return;
    hlsState = 1;
    var s = document.createElement('script');
    s.src = HLS_URL;
    s.onload = function () {
      hlsState = window.Hls ? 2 : -1;
      flush(window.Hls ? null : new Error('hls.js 未就绪'));
    };
    s.onerror = function () { hlsState = -1; flush(new Error('hls.js 加载失败')); };
    document.head.appendChild(s);
  }

  function flush(err) {
    var q = hlsQueue;
    hlsQueue = [];
    for (var i = 0; i < q.length; i++) q[i](err);
  }

  var HLS_OPTS = {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
    manifestLoadingTimeOut: 11000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 11000,
    fragLoadingTimeOut: 22000,
    fragLoadingMaxRetry: 2
  };

  function Player(opts) {
    this.o = opts || {};
    this.root = document.getElementById('player');
    this.video = document.getElementById('video');
    this.cover = document.getElementById('p-cover');
    this.msg = document.getElementById('p-msg');
    this.msgTitle = document.getElementById('p-msg-title');
    this.msgSub = document.getElementById('p-msg-sub');
    this.msgActions = document.getElementById('p-msg-actions');
    this.spin = document.getElementById('p-spin');
    this.badge = document.getElementById('p-quality');
    this.bigplay = document.getElementById('p-bigplay');
    this.logoBox = document.getElementById('p-logo');
    this.nameBox = document.getElementById('p-name');
    this.metaBox = document.getElementById('p-meta');
    this.sourcesBox = document.getElementById('p-sources');
    this.plBody = document.getElementById('p-pl-body');
    this.plTitle = document.getElementById('p-pl-title');
    this.plFilter = document.getElementById('p-pl-filter');
    this.favBtn = document.getElementById('p-fav');
    this.stage = document.getElementById('stage');
    this.hls = null;
    this.ch = null;
    this.srcIdx = 0;
    this.bad = {};
    this.playlist = [];
    this.timer = null;
    this.tries = 0;
    this.gen = 0;
    this.expectUrl = '';
    this.video.volume = 0.85;
    this._bind();
  }

  Player.prototype._bind = function () {
    var self = this;
    document.getElementById('p-close').addEventListener('click', function () { self.close(); });
    this.bigplay.addEventListener('click', function () {
      if (self.video.paused) self.tryPlay(true); else self.video.pause();
    });
    this.video.addEventListener('pause', function () {
      self.stage.classList.remove('is-playing');
      self.root.classList.remove('is-playing');
      if (document.fullscreenElement) syncFsPlayIcon();
    });
    this.video.addEventListener('play', function () {
      self.stage.classList.add('is-playing');
      self.root.classList.add('is-playing');
      if (document.fullscreenElement) syncFsPlayIcon();
      self.clearTimer();
      self.hideMsg();
      self.o.onStatus && self.o.onStatus('playing', self.ch);
    });
    this.video.addEventListener('playing', function () { self.cover.classList.remove('is-on'); });
    var vol = document.getElementById('p-vol');
    vol.addEventListener('input', function () {
      self.video.volume = parseFloat(vol.value);
      self.video.muted = self.video.volume === 0;
      self._syncMute();
    });
    document.getElementById('p-mute').addEventListener('click', function () {
      self.video.muted = !self.video.muted;
      self._syncMute();
    });
    document.getElementById('p-fs').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (self.stage.requestFullscreen) self.stage.requestFullscreen();
    });

    /* 全屏控制条。全屏的是 .stage 本身，外层的控件栏看不到，
       所以暂停 / 退出全屏这两个入口必须放进画面里。
       平时隐藏，鼠标动一下淡入、停手 2.6 秒淡出 —— 这样观看时画面是干净的。 */
    var fsTimer = null;
    function syncFsPlayIcon() {
      var icon = document.getElementById('p-fsplay-icon');
      icon.innerHTML = self.video.paused
        ? '<path d="M8 5.5v13l11-6.5z"/>'
        : '<path d="M8 4.8h3.1v14.4H8zM12.9 4.8H16v14.4h-3.1z"/>';
    }
    function pokeFsCtl() {
      if (!document.fullscreenElement) return;
      self.stage.classList.add('is-ctl');
      clearTimeout(fsTimer);
      fsTimer = setTimeout(function () { self.stage.classList.remove('is-ctl'); }, 2600);
    }
    document.getElementById('p-fsplay').addEventListener('click', function (e) {
      e.stopPropagation();
      if (self.video.paused) self.tryPlay(true); else self.video.pause();
      syncFsPlayIcon();
      pokeFsCtl();
    });
    document.getElementById('p-fsexit').addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen();
    });
    this.stage.addEventListener('pointermove', pokeFsCtl);
    document.addEventListener('fullscreenchange', function () {
      if (document.fullscreenElement) { syncFsPlayIcon(); pokeFsCtl(); }
      else { self.stage.classList.remove('is-ctl'); clearTimeout(fsTimer); }
    });
    this.favBtn.addEventListener('click', function () {
      if (!self.ch) return;
      var on = self.o.onToggleFav && self.o.onToggleFav(self.ch);
      self.favBtn.classList.toggle('is-on', !!on);
    });
    this.plFilter.addEventListener('input', function () { self.renderPlaylist(); });
    document.addEventListener('keydown', function (e) {
      if (self.root.hidden) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') self.close();
      if (e.key === ' ') { e.preventDefault(); self.bigplay.click(); }
    });
    this._syncMute();
  };

  Player.prototype._syncMute = function () {
    document.getElementById('p-mute').classList.toggle('is-on', this.video.muted);
  };

  Player.prototype.isOpen = function () { return !this.root.hidden; };

  Player.prototype.open = function (ch, playlist, title) {
    this.root.hidden = false;
    this.root.classList.remove('is-closing');
    document.body.classList.add('has-player');
    if (playlist) { this.playlist = playlist; this.plTitle.textContent = title || '频道列表'; }
    this.setChannel(ch);
  };

  Player.prototype.close = function () {
    var self = this;
    this.stop();
    this.root.classList.add('is-closing');
    document.body.classList.remove('has-player');
    setTimeout(function () {
      self.root.hidden = true;
      self.root.classList.remove('is-closing');
    }, 240);
    this.o.onClose && this.o.onClose();
  };

  Player.prototype.stop = function () {
    this.clearTimer();
    if (this._offErr) { this._offErr(); this._offErr = null; }
    if (this.hls) { try { this.hls.destroy(); } catch (e) { } this.hls = null; }
    try { this.video.pause(); } catch (e) { }
    this.video.removeAttribute('src');
    try { this.video.load(); } catch (e) { }
    this.stage.classList.remove('is-playing');
    this.root.classList.remove('is-playing');
  };

  Player.prototype.setChannel = function (ch) {
    this.ch = ch;
    this.bad = {};
    this.tries = 0;
    this.srcIdx = 0;
    this._renderHead();
    this.renderSources();
    this.renderPlaylist();
    this.playSource(0);
  };

  Player.prototype._renderHead = function () {
    var ch = this.ch, cc = ch.c;
    var info = (this.o.countries && this.o.countries[cc]) || null;
    logoInto(this.logoBox, ch);
    this.nameBox.textContent = ch.n;
    var bits = [ccLabel(cc, info)];
    if (ch.k && ch.k.length) bits.push(ch.k.slice(0, 2).join(' / '));
    bits.push(ch.s.length + ' 条线路');
    this.metaBox.textContent = bits.join('  ·  ');
    this.favBtn.classList.toggle('is-on', !!(this.o.isFav && this.o.isFav(ch)));
  };

  Player.prototype.isHlsUrl = function (u) { return /\.m3u8(\?|#|$)/i.test(u); };

  /* stop() 会清空 src 并 load()，此时浏览器会抛一个空源错误（code 4）。
     在 hls.js 按需下载期间这个错误会晚到，不能当成流中断，
     所以只有确实挂上了源（或 hls 已接管）时才认这个错误。 */
  Player.prototype.mediaReady = function () {
    return !!(this.hls || this.video.currentSrc);
  };

  Player.prototype.renderSources = function () {
    var self = this, box = this.sourcesBox;
    box.innerHTML = '';
    this.ch.s.forEach(function (s, i) {
      var b = el('button', 'src' + (i === self.srcIdx ? ' is-active' : '') + (self.bad[i] ? ' is-bad' : ''));
      var q = s[1] || '自动';
      b.appendChild(el('span', null, '线路 ' + (i + 1)));
      var qq = el('b', null, q);
      qq.style.fontWeight = '400';
      qq.style.opacity = '.72';
      b.appendChild(qq);
      b.title = s[0];
      b.addEventListener('click', function () { self.playSource(i); });
      box.appendChild(b);
    });
  };

  Player.prototype.setMsg = function (title, sub, actions, spin) {
    var self = this;
    this.msg.hidden = false;
    this.stage.classList.add('has-msg');
    this.msgTitle.textContent = title || '';
    this.msgSub.textContent = sub || '';
    this.spin.style.display = spin === false ? 'none' : 'block';
    this.msgActions.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = el('button', 'skeu-key', a.label);
      b.addEventListener('click', a.fn);
      self.msgActions.appendChild(b);
    });
  };

  Player.prototype.hideMsg = function () {
    this.msg.hidden = true;
    this.stage.classList.remove('has-msg');
  };

  Player.prototype.clearTimer = function () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  };

  Player.prototype.playSource = function (i) {
    var self = this;
    var ch = this.ch;
    if (!ch || !ch.s.length) return;
    i = Math.max(0, Math.min(ch.s.length - 1, i));
    this.srcIdx = i;
    this.renderSources();

    var s = ch.s[i];
    var url = s[0];
    var ref = s[2];
    var gen = ++this.gen;

    this.stop();
    this.badge.textContent = (s[1] || 'LIVE') + ' · 线路 ' + (i + 1);

    var mixed = location.protocol === 'https:' && url.indexOf('http://') === 0;

    if (mixed) {
      this.bad[i] = 'mixed';
      this.setMsg('HTTPS 页面加载不了 HTTP 线路', '浏览器会拦截明文流，已自动跳下一条。', null, false);
      this.nextSource(1);
      return;
    }

    this.setMsg('正在连接信号…',
      ref ? '该线路需要 Referer（' + String(ref).replace(/^https?:\/\//, '').slice(0, 42) + '），浏览器无法伪造，可能失败。'
        : '若长时间无响应会自动切换下一条线路。', null, true);

    this.gen = gen;
    this.timer = setTimeout(function () {
      if (gen !== self.gen) return;
      self.fail('连接超时');
    }, 15000);

    var isHls = this.isHlsUrl(url);
    /* 注意：Chrome 的 canPlayType('...mpegurl') 会返回 "maybe"，但实际解不了 HLS
       （内核没有 MPEG-TS 解复用），照它走原生分支必然 err 4。
       所以只要浏览器有 MSE 就一律用 hls.js，原生只留给没有 MSE 的 Safari/iOS。 */
    var canMse = !!(window.MediaSource || window.ManagedMediaSource);
    var nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl') !== '';

    function onErr() {
      if (gen !== self.gen || !self.mediaReady()) return;
      self.fail('视频流中断');
    }
    this.video.addEventListener('error', onErr);
    this._offErr = function () { self.video.removeEventListener('error', onErr); };

    if (isHls && canMse) {
      this.setMsg('正在准备播放组件…', '首次播放需要加载 HLS 解码库。', null, true);
      needHls(function (err) {
        if (gen !== self.gen) return;
        if (err || !window.Hls || !window.Hls.isSupported()) {
          self.fail('当前浏览器不支持 HLS 播放');
          return;
        }
        self.setMsg('正在连接信号…', ref ? '该线路需要 Referer，浏览器无法伪造，可能失败。' : '若长时间无响应会自动切换下一条线路。', null, true);
        // 下载 hls.js 这段不算线路超时，重新计时
        self.clearTimer();
        self.timer = setTimeout(function () {
          if (gen !== self.gen) return;
          self.fail('连接超时');
        }, 15000);
        var hls = new window.Hls(HLS_OPTS);
        self.hls = hls;
        hls.on(window.Hls.Events.ERROR, function (evt, data) {
          if (gen !== self.gen || !data || !data.fatal) return;
          self.fail(data.type === 'networkError' ? '网络 / 跨域被拒绝' : '解码失败');
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          if (gen !== self.gen) return;
          self.tryPlay();
        });
        hls.attachMedia(self.video);
        hls.loadSource(url);
      });
      return;
    } else if (isHls && nativeHls) {   // 无 MSE 的平台（iOS Safari）才走这里
      this.video.src = url;
      this.tryPlay();
    } else if (isHls) {
      this.fail('当前浏览器不支持 HLS');
      return;
    } else {
      this.video.src = url;
      this.tryPlay();
    }
  };

  Player.prototype.tryPlay = function (userGesture) {
    var self = this;
    this.cover.classList.add('is-on');
    var p = this.video.play();
    if (p && p.catch) {
      p.catch(function () {
        // 媒体本身有问题：直接算这条线路失败，别提示"点击播放"
        if (self.mediaReady() && self.video.error) { self.fail('线路无法解码'); return; }
        if (userGesture) {
          self.setMsg('浏览器阻止了播放', '点一下按钮开始。', [{ label: '开始播放', fn: function () { self.tryPlay(true); } }], false);
        } else {
          self.video.muted = true;
          self._syncMute();
          self.video.play().catch(function () {
            if (self.mediaReady() && self.video.error) { self.fail('线路无法解码'); return; }
            self.setMsg('点击播放', '浏览器要求先有一次用户交互。', [{ label: '开始播放', fn: function () { self.tryPlay(true); } }], false);
          });
        }
      });
    }
  };

  Player.prototype.nextSource = function (dir) {
    var n = this.ch.s.length;
    var next = this.srcIdx + (dir || 1);
    for (var k = 1; k <= n; k++) {
      var cand = ((next + k - 1) % n + n) % n;
      if (!this.bad[cand]) { this.playSource(cand); return; }
    }
    this.giveUp();
  };

  Player.prototype.fail = function (why) {
    this.clearTimer();
    this.bad[this.srcIdx] = why || true;
    this.o.onStatus && this.o.onStatus('failed', this.ch, why);
    if (this.hls) { try { this.hls.destroy(); } catch (e) { } this.hls = null; }
    this.expectUrl = '';
    try { this.video.pause(); } catch (e) { }
    var left = 0;
    for (var i = 0; i < this.ch.s.length; i++) if (!this.bad[i]) left++;
    this.renderSources();
    if (left > 0 && this.tries < 10) {
      this.tries++;
      this.nextSource(1);
    } else {
      this.giveUp(why);
    }
  };

  Player.prototype.giveUp = function (why) {
    var self = this;
    var url = this.ch.s[this.srcIdx] ? this.ch.s[this.srcIdx][0] : '';
    var n = this.ch.s.length, mixed = 0;
    for (var k = 0; k < n; k++) if (this.bad[k] === 'mixed') mixed++;
    this.o.onStatus && this.o.onStatus('dead', this.ch, why);
    if (mixed === n) {
      this.setMsg('这个频道只有明文线路',
        '它的 ' + n + ' 条线路全是 http://，HTTPS 页面下浏览器会直接拦截，网页里播不了。复制地址到 VLC / mpv 里可以正常看。',
        [
          { label: '复制播放地址', fn: function () { if (navigator.clipboard) navigator.clipboard.writeText(url); self.o.onStatus && self.o.onStatus('copied', self.ch); } },
          { label: 'VLC 打开', fn: function () { window.open(url, '_blank'); } },
          { label: '随机换一个', fn: function () { self.o.onRandom && self.o.onRandom(); } }
        ], false);
      return;
    }
    this.setMsg('这个频道暂时播不了',
      '已试过全部 ' + n + ' 条线路，都不通。常见原因：线路需要伪造 Referer / User-Agent、地区限制、或源已失效。换个频道，或把地址丢给 VLC 试试。',
      [
        { label: '重试全部线路', fn: function () { self.bad = {}; self.tries = 0; self.playSource(0); } },
        {
          label: '复制播放地址', fn: function () {
            if (navigator.clipboard) navigator.clipboard.writeText(url);
            self.o.onStatus && self.o.onStatus('copied', self.ch);
          }
        },
        { label: 'VLC 打开', fn: function () { window.open(url, '_blank'); } },
        { label: '随机换一个', fn: function () { self.o.onRandom && self.o.onRandom(); } }
      ], false);
  };

  Player.prototype.renderPlaylist = function () {
    var self = this;
    var q = (this.plFilter.value || '').trim().toLowerCase();
    var body = this.plBody;
    body.innerHTML = '';
    var list = this.playlist;
    if (q) {
      list = list.filter(function (c) {
        return c.n.toLowerCase().indexOf(q) >= 0 || (c.k || []).join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    if (!list.length) { body.appendChild(el('div', 'suggest-empty', '没有匹配的频道')); return; }
    var limit = Math.min(list.length, 400);
    for (var i = 0; i < limit; i++) body.appendChild(this._row(list[i]));
    if (list.length > limit) {
      var more = el('div', 'suggest-empty', '还有 ' + fmt(list.length - limit) + ' 个频道，用上面的筛选框缩小范围');
      body.appendChild(more);
    }
  };

  Player.prototype._row = function (ch) {
    var self = this;
    var cur = this.ch && ch.i === this.ch.i;
    var row = el('div', 'row' + (cur ? ' is-active' : ''));
    row.appendChild(logoEl(ch, 'logoimg'));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-name', ch.n));
    var q = ch.s[0] && ch.s[0][1] ? ch.s[0][1] : '自动';
    main.appendChild(el('div', 'row-sub', (ch.k && ch.k.length ? ch.k[0] + ' · ' : '') + q + ' · ' + ch.s.length + ' 条线路'));
    row.appendChild(main);
    if (cur) {
      var bars = el('div', 'bars');
      bars.innerHTML = '<i></i><i></i><i></i>';
      row.appendChild(bars);
    }
    row.addEventListener('click', function () { self.setChannel(ch); });
    return row;
  };

  window.Player = Player;
})();
