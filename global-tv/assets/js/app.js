/* ============================================================
   Globe TV — 应用主逻辑
   数据：iptv-org（https://github.com/iptv-org/iptv）
   ============================================================ */
// 由 boot.js 在频道数据就绪后调用（数据走 gz，所以不能在这里立即执行）
window.__startGlobeTV = function () {
  'use strict';

  var U = window.TVUtil;
  var el = U.el;
  var DATA = window.TV_DATA;
  if (!DATA) { console.error('TV_DATA 缺失'); return; }

  var CH = DATA.channels;
  var CC = DATA.countries;
  var CATS = DATA.categories;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------- 本地存储
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  // HTTPS 页面加载不了明文 http 流（浏览器按混合内容拦截）。
  // 线上链接是 HTTPS，所以默认只显示"至少有一条 https 线路"的频道，避免点到播不了的亮点。
  var IS_HTTPS = location.protocol === 'https:';
  var httpsOnly = lsGet('globetv.httpsOnly', null);
  if (httpsOnly === null) httpsOnly = IS_HTTPS;
  var visibleCats = [];

  // ---------------------------------------------------------- 索引
  var N = CH.length;
  var searchStr = new Array(N);
  var httpsFlag = new Uint8Array(N);   // 该频道是否至少有一条 https 线路
  var byCountry = {};
  var byCat = {};
  var idMap = {};
  var visMask = new Uint8Array(N);     // 当前筛选下是否可见
  var visCount = 0, visStreams = 0, visCountries = 0;
  var httpsIdx = [];                   // 有 https 线路的频道下标（原表）
  var safeIdx = [];                    // 当前筛选后"最可能能播"的频道下标

  (function buildIndex() {
    for (var i = 0; i < N; i++) {
      var ch = CH[i];
      idMap[ch.i] = ch;
      var info = CC[ch.c] || { n: ch.c, f: '' };
      searchStr[i] = (ch.n + ' ' + (ch.a || '') + ' ' + info.n + ' ' + ch.c + ' ' +
        (ch.k || []).join(' ')).toLowerCase();
      var hasHttps = false;
      for (var q = 0; q < ch.s.length; q++) if (ch.s[q][0].indexOf('https://') === 0) { hasHttps = true; break; }
      ch._h = hasHttps;
      httpsFlag[i] = hasHttps ? 1 : 0;
      if (hasHttps) httpsIdx.push(i);
    }
  })();

  // 按当前筛选重建可见索引（byCountry / byCat / 统计数字都跟着走）
  function refreshVisible() {
    byCountry = {};
    byCat = {};
    visCount = 0;
    visStreams = 0;
    visCountries = 0;
    var seenCountry = {};
    for (var i = 0; i < N; i++) {
      var on = !httpsOnly || httpsFlag[i];
      visMask[i] = on ? 1 : 0;
      if (!on) continue;
      var ch = CH[i];
      visCount++;
      visStreams += ch.s.length;
      if (!seenCountry[ch.c]) { seenCountry[ch.c] = 1; visCountries++; }
      (byCountry[ch.c] || (byCountry[ch.c] = [])).push(ch);
      var ks = ch.k && ch.k.length ? ch.k : ['general'];
      for (var j = 0; j < ks.length; j++) (byCat[ks[j]] || (byCat[ks[j]] = [])).push(ch);
    }
    // 每个国家内按"线路数多 → 名称"排序，最可能可播的排前面
    Object.keys(byCountry).forEach(function (cc) {
      byCountry[cc].sort(function (a, b) {
        return (b.s.length - a.s.length) || a.n.localeCompare(b.n, 'en');
      });
    });
    Object.keys(byCat).forEach(function (k) {
      byCat[k].sort(function (a, b) { return (b.s.length - a.s.length) || a.n.localeCompare(b.n, 'en'); });
    });
    visibleCats = CATS.filter(function (c) { return byCat[c.id] && byCat[c.id].length; });
    safeIdx = httpsOnly ? httpsIdx.slice() : httpsIdx;
  }

  function updateStats() {
    $('stat-ch').textContent = U.fmt(visCount);
    $('stat-cc').textContent = U.fmt(visCountries);
    $('stat-st').textContent = U.fmt(visStreams);
  }

  refreshVisible();
  updateStats();

  // ---------------------------------------------------------- 收藏 / 主题
  var favs = lsGet('globetv.fav', []);
  var favSet = {};
  favs.forEach(function (f) { favSet[f] = 1; });
  function isFav(ch) { return !!favSet[ch.i]; }
  function toggleFav(ch) {
    if (favSet[ch.i]) { delete favSet[ch.i]; favs = favs.filter(function (x) { return x !== ch.i; }); }
    else { favSet[ch.i] = 1; favs.unshift(ch.i); }
    lsSet('globetv.fav', favs);
    renderFav();
    return !!favSet[ch.i];
  }

  var theme = lsGet('globetv.theme', null);
  if (!theme) theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', theme === 'dark');
  $('btn-theme').title = theme === 'dark' ? '切换到浅色' : '切换到深色';

  // ---------------------------------------------------------- toast
  function toast(msg, bad, ms) {
    var box = $('toasts');
    var t = el('div', 'toast' + (bad ? ' is-bad' : ''), msg);
    box.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s ease,transform .3s ease';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { t.remove(); }, 320);
    }, ms || 3200);
  }

  // ---------------------------------------------------------- 地球
  $('boot-sub').textContent = '正在绘制地球…';
  var globe = new window.GlobeView($('globe-canvas'));
  try {
    globe.init();
  } catch (e) {
    console.error(e);
    toast('WebGL 初始化失败，可能浏览器禁用了硬件加速', true, 8000);
  }
  globe.setCountries(CC);
  globe.setTheme(theme);
  globe.setData(DATA);
  globe.onTexError = function () { toast('地球贴图加载失败', true); };

  // 地球只渲染"当前筛选可见"的频道
  function applyFilter() {
    globe.setFilter(httpsOnly ? function (ch) { return !!ch._h; } : null);
  }
  applyFilter();

  // 当前悬停 / 播放
  var curCh = null;
  var curMeta = null;
  var curCountry = null;

  var tip = $('tip');
  var tipLogo = $('tip-logo');
  var tipName = $('tip-name');
  var tipMeta = $('tip-meta');
  var lastMouse = { x: 0, y: 0 };

  document.addEventListener('mousemove', function (e) { lastMouse.x = e.clientX; lastMouse.y = e.clientY; });

  function qualityTag(ch) {
    var best = '';
    for (var i = 0; i < ch.s.length; i++) {
      var q = ch.s[i][1];
      if (!q) continue;
      var m = /(\d{3,4})/.exec(q);
      var v = m ? parseInt(m[1], 10) : 0;
      if (v > (parseInt(best, 10) || 0)) best = String(v);
    }
    return best ? best + 'p' : '自动';
  }

  globe.hover = function (meta, idx, mx, my) {
    if (!meta) { tip.hidden = true; return; }
    var ch = meta.ch;
    var info = meta.info || {};
    U.logoInto(tipLogo, ch);
    tipName.textContent = ch.n;
    tipMeta.textContent = (info.f ? info.f + ' ' : '') + (info.n || ch.c) +
      ' · ' + qualityTag(ch) + ' · ' + ch.s.length + ' 条线路';
    tip.hidden = false;
    placeTip(mx == null ? lastMouse.x + 16 : mx + 16, my == null ? lastMouse.y + 14 : my + 14);
  };

  function placeTip(x, y) {
    var w = tip.offsetWidth || 260, h = tip.offsetHeight || 48;
    x = Math.min(x, window.innerWidth - w - 12);
    y = Math.min(y, window.innerHeight - h - 12);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  // 提示框跟随亮点（亮点转到背面时自动隐藏）
  globe.hoverMove = function (p) {
    if (tip.hidden) return;
    placeTip(p.x + 18, p.y + 10);
  };

  // ---------------------------------------------------------- 播放
  var player = new window.Player({
    countries: CC,
    isFav: isFav,
    onToggleFav: function (ch) {
      var on = toggleFav(ch);
      toast(on ? '已收藏「' + ch.n + '」' : '已取消收藏');
      return on;
    },
    onRandom: function () { playRandom(); },
    onStatus: function (type, ch, why) {
      if (type === 'failed') toast('线路不通（' + why + '），自动换线…', false, 2200);
      else if (type === 'dead') toast('「' + ch.n + '」的线路都连不上，换一个试试', true, 4200);
      else if (type === 'timeout') toast('连接超时，换线中…', false, 2000);
      else if (type === 'copied') toast('播放地址已复制');
    }
  });

  function countryPlaylist(cc) {
    return (byCountry[cc] || []).slice();
  }

  function openChannel(ch, opts) {
    opts = opts || {};
    curCh = ch;
    curCountry = ch.c;
    tip.hidden = true;
    var info = CC[ch.c] || {};
    player.open(ch, countryPlaylist(ch.c), (info.f ? info.f + ' ' : '') + (info.n || ch.c) + ' 的全部频道');
    if (opts.focus !== false) globe.focusTo(ch.la, ch.lo, Math.min(globe.dist, 2.1), 900);
    curMeta = { ch: ch, cc: ch.c, info: info };
    globe.markSelected(curMeta);
    setActiveRow(ch);
  }

  globe.pick = function (meta) { openChannel(meta.ch, { focus: true }); };
  globe.bgPick = function () { };

  function playRandom() {
    var i = safeIdx[Math.floor(Math.random() * safeIdx.length)];
    if (i == null) return;
    openChannel(CH[i], { focus: true });
  }

  // ---------------------------------------------------------- 抽屉
  var drawer = $('drawer');
  var panes = { country: $('pane-country'), category: $('pane-category'), fav: $('pane-fav'), result: $('pane-result') };
  var curTab = 'country';
  var curCat = null;
  var activeRowEl = null;

  function setActiveRow(ch) {
    activeRowEl = null;
    if (drawer.classList.contains('is-open')) refreshPane();
  }

  function refreshPane() {
    if (curTab === 'country') renderCountries();
    else if (curTab === 'category') renderCats();
    else if (curTab === 'fav') renderFav();
    if (!panes.result.hidden) renderResults(searchInput.value.trim());
  }

  function showPane(name) {
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
  }

  function openDrawer(tab) {
    if (tab) selectTab(tab);
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }
  function selectTab(tab) {
    curTab = tab;
    Array.prototype.forEach.call($('drawer-tabs').children, function (b) {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    showPane(tab);
    if (tab === 'country') renderCountries();
    if (tab === 'category') renderCats();
    if (tab === 'fav') renderFav();
  }

  function channelRow(ch, subExtra) {
    var info = CC[ch.c] || {};
    var row = el('div', 'row' + (curCh && curCh.i === ch.i ? ' is-active' : ''));
    if (subExtra === 'flag') row.appendChild(el('div', 'row-flag', info.f || ''));
    else row.appendChild(U.logoEl(ch, 'logoimg'));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-name', ch.n));
    var sub = [];
    if (subExtra === 'flag') sub.push(info.n || ch.c);
    sub.push(qualityTag(ch));
    if (ch.k && ch.k.length) sub.push(ch.k[0]);
    sub.push(ch.s.length + ' 线路');
    main.appendChild(el('div', 'row-sub', sub.join(' · ')));
    row.appendChild(main);
    if (curCh && curCh.i === ch.i) {
      var bars = el('div', 'bars');
      bars.innerHTML = '<i></i><i></i><i></i>';
      row.appendChild(bars);
    } else if (isFav(ch)) {
      var st = el('div', 'row-count', '★');
      st.style.color = 'var(--favorite)';
      row.appendChild(st);
    }
    row.addEventListener('click', function () { openChannel(ch, { focus: true }); });
    return row;
  }

  function renderCountries() {
    var box = panes.country;
    box.innerHTML = '';
    box.appendChild(el('div', 'list-title', '共 ' + U.fmt(visCountries) + ' 个国家 / 地区'));
    var list = Object.keys(byCountry).sort(function (a, b) {
      return byCountry[b].length - byCountry[a].length;
    });
    list.forEach(function (cc) {
      var info = CC[cc] || {};
      var row = el('div', 'row');
      row.appendChild(el('div', 'row-flag', info.f || ''));
      var main = el('div', 'row-main');
      main.appendChild(el('div', 'row-name', info.n || cc));
      main.appendChild(el('div', 'row-sub', byCountry[cc].length + ' 个频道 · 点击飞过去'));
      row.appendChild(main);
      row.appendChild(el('div', 'row-count', String(byCountry[cc].length)));
      row.addEventListener('click', function () {
        globe.focusTo(info.la, info.lo, 1.95, 1100);
        var ch = byCountry[cc][0];
        if (ch) openChannel(ch, { focus: false });
        toast((info.f || '') + ' ' + (info.n || cc) + ' · ' + byCountry[cc].length + ' 个频道');
        if (window.innerWidth < 900) closeDrawer();
      });
      box.appendChild(row);
    });
  }

  function renderCats() {
    var box = panes.category;
    box.innerHTML = '';
    box.appendChild(el('div', 'list-title', '按类型找频道'));
    var wrap = el('div', 'chipwrap');
    var all = el('button', 'chip' + (curCat == null ? ' is-active' : ''), '全部类型');
    all.addEventListener('click', function () { curCat = null; renderCats(); renderCatList(); });
    wrap.appendChild(all);
    visibleCats.forEach(function (c) {
      var b = el('button', 'chip' + (curCat === c.id ? ' is-active' : ''), c.n + ' ' + (byCat[c.id] ? byCat[c.id].length : 0));
      b.addEventListener('click', function () { curCat = c.id; renderCats(); renderCatList(); });
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
    var curName = curCat ? (CATS.filter(function (c) { return c.id === curCat; })[0] || {n:curCat}).n : '热门频道';
    box.appendChild(el('div', 'list-title', curCat ? curName + ' · ' + byCat[curCat].length + ' 个频道' : curName));
    var listBox = el('div');
    listBox.id = 'catlist';
    box.appendChild(listBox);
    renderCatList();
  }

  function renderCatList() {
    var listBox = document.getElementById('catlist');
    if (!listBox) return;
    listBox.innerHTML = '';
    var list;
    if (curCat) list = byCat[curCat] || [];
    else {
      list = safeIdx.map(function (i) { return CH[i]; });
      list.sort(function (a, b) { return b.s.length - a.s.length; });
    }
    var limit = 300;
    for (var i = 0; i < Math.min(list.length, limit); i++) listBox.appendChild(channelRow(list[i], true));
    if (list.length > limit) listBox.appendChild(el('div', 'suggest-empty', '仅显示前 ' + limit + ' 个，共 ' + U.fmt(list.length) + ' 个'));
  }

  function renderFav() {
    var box = panes.fav;
    box.innerHTML = '';
    if (!favs.length) {
      box.appendChild(el('div', 'list-title', '收藏夹'));
      box.appendChild(el('div', 'suggest-empty', '还没有收藏。播放时点右上角的星标即可收藏。'));
      return;
    }
    box.appendChild(el('div', 'list-title', '收藏 ' + favs.length + ' 个频道'));
    favs.forEach(function (id) {
      var ch = idMap[id];
      if (ch) box.appendChild(channelRow(ch, true));
    });
  }

  // ---------------------------------------------------------- 搜索结果
  function search(q) {
    q = q.trim().toLowerCase();
    var out = [];
    if (!q) return out;
    for (var i = 0; i < N; i++) {
      if (visMask[i] && searchStr[i].indexOf(q) >= 0) {
        out.push(CH[i]);
        if (out.length >= 600) break;
      }
    }
    out.sort(function (a, b) {
      var ai = a.n.toLowerCase().indexOf(q), bi = b.n.toLowerCase().indexOf(q);
      if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return b.s.length - a.s.length;
    });
    return out;
  }

  var suggest = $('suggest');
  var searchInput = $('search-input');
  var searchTimer = null;

  function renderSuggest(q) {
    if (!q) { suggest.hidden = true; return; }
    var res = search(q).slice(0, 8);
    suggest.innerHTML = '';
    if (!res.length) {
      suggest.appendChild(el('div', 'suggest-empty', '没找到相关频道'));
    } else {
      res.forEach(function (ch) { suggest.appendChild(channelRow(ch, true)); });
      var all = el('div', 'row');
      all.style.justifyContent = 'center';
      all.appendChild(el('div', 'row-sub', '在左侧面板查看全部结果 →'));
      all.addEventListener('click', function () { suggest.hidden = true; openDrawer('result'); });
      suggest.appendChild(all);
    }
    suggest.hidden = false;
  }

  function renderResults(q) {
    var box = panes.result;
    box.innerHTML = '';
    var res = search(q);
    box.appendChild(el('div', 'list-title', '“' + q + '” 匹配 ' + U.fmt(res.length) + ' 个频道'));
    if (!res.length) { box.appendChild(el('div', 'suggest-empty', '换个关键词试试')); return; }
    var limit = Math.min(res.length, 400);
    for (var i = 0; i < limit; i++) box.appendChild(channelRow(res[i], true));
    if (res.length > limit) box.appendChild(el('div', 'suggest-empty', '仅显示前 ' + limit + ' 个'));
  }

  searchInput.addEventListener('input', function () {
    var q = searchInput.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { renderSuggest(q); }, 110);
    if (q.length >= 2) {
      showPane('result');
      drawer.classList.add('is-open');
      renderResults(q);
    } else if (!q) {
      if (curTab !== 'result') showPane(curTab);
      suggest.hidden = true;
    }
  });
  searchInput.addEventListener('focus', function () {
    if (searchInput.value.trim()) renderSuggest(searchInput.value.trim());
  });
  document.addEventListener('click', function (e) {
    if (!$('suggest').contains(e.target) && e.target !== searchInput) suggest.hidden = true;
    if (drawer.classList.contains('is-open') && !drawer.contains(e.target) &&
      !e.target.closest('.topbar') && !e.target.closest('#player')) {
      if (window.innerWidth < 900) closeDrawer();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape') { suggest.hidden = true; if (document.activeElement === searchInput) searchInput.blur(); }
  });

  // ---------------------------------------------------------- 顶栏动作
  $('btn-random').addEventListener('click', function () {
    playRandom();
  });
  $('btn-browse').addEventListener('click', function () {
    if (drawer.classList.contains('is-open') && curTab !== 'result') closeDrawer();
    else openDrawer('country');
  });
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (b) selectTab(b.dataset.tab);
  });
  $('btn-theme').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    $('btn-theme').title = theme === 'dark' ? '切换到浅色' : '切换到深色';
    lsSet('globetv.theme', theme);
    globe.setTheme(theme);
  });

  // 仅 HTTPS 可播：HTTPS 页面下默认开启（明文 http 流会被浏览器拦掉）
  var httpsBtn = $('btn-https');
  function syncHttpsBtn() {
    httpsBtn.hidden = !IS_HTTPS;
    httpsBtn.classList.toggle('is-on', httpsOnly);
    httpsBtn.title = httpsOnly
      ? '当前只显示至少有一条 HTTPS 线路的频道（点击显示全部）'
      : '显示全部频道（点击仅保留 HTTPS 可播的）';
  }
  httpsBtn.addEventListener('click', function () {
    httpsOnly = !httpsOnly;
    lsSet('globetv.httpsOnly', httpsOnly);
    refreshVisible();
    updateStats();
    applyFilter();
    syncHttpsBtn();
    refreshPane();
    toast(httpsOnly
      ? '只显示 HTTPS 可播的频道 · ' + U.fmt(visCount) + ' 个'
      : '已显示全部频道 · ' + U.fmt(visCount) + ' 个（明文 http 线路在 HTTPS 页面下无法播放）');
  });
  syncHttpsBtn();
  $('z-in').addEventListener('click', function () { globe.zoomBy(0.82); });
  $('z-out').addEventListener('click', function () { globe.zoomBy(1.22); });
  $('z-reset').addEventListener('click', function () { globe.focusTo(20, 25, 3.1, 900); });
  $('brand').addEventListener('click', function () { globe.focusTo(20, 25, 3.1, 900); });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'r' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) playRandom();
  });

  // ---------------------------------------------------------- 更新提醒
  /* 版本号写在 assets/js/changelog.js，发版时改那里（改完记得重跑 bundle.py）。
     这里把它和本地记录的已读版本比对：
       - 第一次来（本地没有记录）→ 静默记下，不打扰
       - 检测到新版本 → 右上角按钮点小圆点，并自动弹出一次更新说明
     目的是让用户知道「这次更新改了什么」，而不是默默变了。 */
  (function initUpdates() {
    var CL = window.TV_CHANGELOG;
    var btn = $('btn-updates');
    if (!CL || !CL.entries || !CL.entries.length || !btn) { if (btn) btn.hidden = true; return; }

    var box = $('upd'), body = $('upd-body'), dot = $('upd-dot');
    var KEY = 'globetv.seenVersion';
    var seen = lsGet(KEY, null);
    var isNew = seen !== CL.current;
    $('upd-cur').textContent = CL.current;

    // 用 el() 建节点（走 textContent），不拼 innerHTML
    CL.entries.forEach(function (e) {
      var item = el('div', 'upd-item' + (isNew && e.v === CL.current ? ' is-new' : ''));
      var top = el('div', 'upd-item-top');
      top.appendChild(el('span', 'upd-v', e.v));
      top.appendChild(el('span', 'upd-item-name', e.title || ''));
      top.appendChild(el('span', 'upd-date', e.date || ''));
      item.appendChild(top);
      var ul = el('ul', 'upd-list');
      (e.items || []).forEach(function (t) { ul.appendChild(el('li', null, t)); });
      item.appendChild(ul);
      body.appendChild(item);
    });

    function open() { box.hidden = false; lsSet(KEY, CL.current); dot.hidden = true; }
    function close() { box.hidden = true; }
    btn.addEventListener('click', function () { if (box.hidden) open(); else close(); });
    $('upd-close').addEventListener('click', close);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !box.hidden) { e.stopPropagation(); close(); }
    });

    if (seen === null) {
      lsSet(KEY, CL.current);            // 第一次访问：记录下来但不弹窗
    } else if (isNew) {
      dot.hidden = false;                // 先点小圆点，等启动页收完再弹说明
      setTimeout(function () {
        open();
        toast('已更新到 ' + CL.current + ' · 这里是改动内容', false, 4600);
      }, 1200);
    }
  })();

  // ---------------------------------------------------------- 启动画面
  selectTab('country');
  renderFav();

  /* 等地球贴图真正挂上再收起启动页。
     贴图没到就收，用户会看到一个没有纹理的球（在深色主题下就是一个黑球）。 */
  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    $('boot').classList.add('is-done');
    setTimeout(function () {
      var b = $('boot');
      if (b && b.parentNode) b.parentNode.removeChild(b);
    }, 700);
    toast('准备好了 · 点地球上任意一个亮点开始播放', false, 4200);
    if (IS_HTTPS && httpsOnly) {
      setTimeout(function () {
        toast('HTTPS 页面下已过滤掉只有明文线路的频道，可点右上角「仅 HTTPS」显示全部', false, 6500);
      }, 4600);
    }
  }
  if (globe.texReady) setTimeout(reveal, 300);
  else globe.onTexReady = function () { setTimeout(reveal, 260); };
  // 兜底：贴图慢或彻底失败时也不能一直卡在启动页
  setTimeout(reveal, 9000);

  // 首屏随机一个频道？不自动播放，避免打扰
  window.GlobeTV = {
    data: DATA,
    play: function (id) { if (idMap[id]) openChannel(idMap[id]); },
    random: playRandom,
    globe: globe,
    player: player
  };
};
