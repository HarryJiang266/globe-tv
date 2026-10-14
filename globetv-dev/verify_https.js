/* 在真实 HTTPS 页面下验证「仅 HTTPS」筛选逻辑 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const URL = process.argv[2] || 'https://127.0.0.1:8443/index.html';
const OUT = require('path').join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-ssl-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--ignore-certificate-errors', '--allow-running-insecure-content=false',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const waiting = new Map(); const errors = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
function onMsg(raw) {
  const m = JSON.parse(raw);
  if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 240));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    var e = m.params.entry;
    errors.push('LOG ' + e.text.slice(0, 120) + (e.url ? '  <- ' + e.url : ''));
  }
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400)
    errors.push('HTTP ' + m.params.response.status + ' ' + m.params.response.url);
}
async function ev(e, awaitPromise) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!awaitPromise });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function shot(n) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64'));
}

const R = {};
(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => onMsg(e.data);
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV && GlobeTV.globe && GlobeTV.globe.markerCount) && !document.getElementById("boot")')) break; } catch (e) { }
  }
  await sleep(900);

  R.protocol = await ev('location.protocol');
  R.initial = await ev(`(function(){var g=GlobeTV.globe;return{
      isHttps:location.protocol==='https:',
      markers:g.markerCount,
      hud:[stat('stat-ch'),stat('stat-cc'),stat('stat-st')],
      btnHidden:document.getElementById('btn-https').hidden,
      btnOn:document.getElementById('btn-https').classList.contains('is-on'),
      countryRows:document.querySelectorAll('#pane-country .row').length,
      chips:document.querySelectorAll('#pane-category .chip').length,
      stored:(function(){try{return localStorage.getItem('globetv.httpsOnly')}catch(e){return 'ERR'}})()};
      function stat(id){return document.getElementById(id).textContent}})()`);
  R.flagged = await ev(`(function(){var n=0;for(var i=0;i<TV_DATA.channels.length;i++) if(TV_DATA.channels[i]._h) n++; return {httpsCapable:n, total:TV_DATA.channels.length}})()`);
  await shot('30_https_filtered');

  // 关掉筛选 → 全部频道
  await ev(`document.getElementById('btn-https').click()`);
  await sleep(1600);
  R.afterOff = await ev(`(function(){var g=GlobeTV.globe;return{
      markers:g.markerCount,
      hud:[stat('stat-ch'),stat('stat-cc'),stat('stat-st')],
      btnOn:document.getElementById('btn-https').classList.contains('is-on'),
      stored:(function(){try{return localStorage.getItem('globetv.httpsOnly')}catch(e){return 'ERR'}})()};
      function stat(id){return document.getElementById(id).textContent}})()`);
  await shot('31_https_all');

  // 搜索时是否也跟随筛选
  await ev(`document.getElementById('search-input').value='cctv';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
  await sleep(900);
  R.searchFiltered = await ev(`(function(){return{results:document.querySelectorAll('#pane-result .row').length,title:(document.querySelector('#pane-result .list-title')||{}).textContent}})()`);
  await ev(`document.getElementById('search-input').value='';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
  await ev(`document.getElementById('drawer-close').click()`);
  await sleep(500);

  // 再打开筛选，然后点一个"只有 http 线路"的频道，验证播放器提示
  await ev(`document.getElementById('btn-https').click()`); await sleep(1500);
  R.reOn = await ev(`(function(){var g=GlobeTV.globe;return{markers:g.markerCount,hud:document.getElementById('stat-ch').textContent}})()`);

  // 直接用一个 http-only 频道测试提示文案（模拟用户点了被过滤掉的频道）
  R.httpOnlyChannel = await ev(`(function(){
      var c=null;for(var i=0;i<TV_DATA.channels.length;i++){ if(!TV_DATA.channels[i]._h){c=TV_DATA.channels[i];break;} }
      if(!c) return null;
      GlobeTV.play(c.i);
      return {name:c.n, lines:c.s.map(function(s){return s[0].split(':')[0]})};
  })()`);
  await sleep(2600);
  R.httpOnlyPlayer = await ev(`({msg:document.getElementById('p-msg').hidden?null:document.getElementById('p-msg-title').textContent,sub:document.getElementById('p-msg-sub').hidden?null:document.getElementById('p-msg-sub').textContent,badge:document.getElementById('p-quality').textContent})`);
  await shot('32_https_httponly');

  // HTTPS 频道在 HTTPS 页面下应能真正播放
  await ev(`(function(){
      var c=null;for(var i=0;i<TV_DATA.channels.length;i++){ var k=TV_DATA.channels[i]; if(k._h && k.c==='CN'){c=k;break;} }
      if(c) GlobeTV.play(c.i);
  })()`);
  await sleep(6000);
  R.httpsPlay = await ev(`(function(){var v=document.getElementById('video');return{
      name:document.getElementById('p-name').textContent,
      videoW:v.videoWidth, videoH:v.videoHeight, err:v.error?v.error.code:null,
      paused:v.paused, badge:document.getElementById('p-quality').textContent,
      msg:document.getElementById('p-msg').hidden?null:document.getElementById('p-msg-title').textContent}})()`);
  await shot('33_https_playing');

  // 分类页 chip 是否跟随筛选
  await ev(`document.getElementById('btn-browse').click();document.querySelector('[data-tab="category"]').click()`);
  await sleep(900);
  R.catsFiltered = await ev(`({chips:document.querySelectorAll('#pane-category .chip').length, rows:document.querySelectorAll('#catlist .row').length, first:(document.querySelector('.chip:nth-child(1)')||{}).textContent})`);
  await shot('34_https_cats');
  await ev(`document.querySelector('[data-tab="country"]').click()`); await sleep(500);
  R.countryList = await ev(`({rows:document.querySelectorAll('#pane-country .row').length,title:(document.querySelector('#pane-country .list-title')||{}).textContent,first:(document.querySelector('#pane-country .row-name')||{}).textContent})`);
  await ev(`document.getElementById('drawer-close').click()`); await sleep(400);

  // 批量测试 https 频道的真实可播率（用来判断线上到底能不能用）
  R.batch = JSON.parse(await ev(`(async function(){
    var cands=[];
    for(var i=0;i<TV_DATA.channels.length;i++){
      var k=TV_DATA.channels[i];
      if(k._h && k.c==='CN' && cands.length<6) cands.push(k);
    }
    var ok=0, res=[];
    // hls.js 现在是按需加载的，抽测前先确保它到位
    if(!window.Hls){
      await new Promise(function(d){ var s=document.createElement('script');
        s.src='assets/vendor/hls.min.js'; s.onload=d; s.onerror=d; document.head.appendChild(s); });
    }
    for(var j=0;j<cands.length;j++){
      var k=cands[j];
      var u=null; for(var q=0;q<k.s.length;q++){ if(k.s[q][0].indexOf('https://')===0){u=k.s[q][0];break;} }
      if(!u) continue;
      var r=await new Promise(function(done){
        var v=document.createElement('video'); v.muted=true; v.playsInline=true;
        var t=setTimeout(function(){ cleanup(); done({s:'timeout'}); }, 12000);
        function cleanup(){ clearTimeout(t); try{v.pause()}catch(e){} v.removeAttribute('src'); try{v.load()}catch(e){} }
        v.addEventListener('loadedmetadata',function(){ cleanup(); done({s:'meta', w:v.videoWidth, h:v.videoHeight}); });
        v.addEventListener('error',function(){ cleanup(); done({s:'error', c:v.error?v.error.code:null}); });
        if(window.Hls && window.Hls.isSupported() && /\.m3u8/i.test(u)){
          var h=new window.Hls({manifestLoadingTimeOut:9000});
          h.on(window.Hls.Events.ERROR,function(e,d){ if(d&&d.fatal){ try{h.destroy()}catch(x){} cleanup(); done({s:'hls_err', t:d.type}); }});
          h.on(window.Hls.Events.MANIFEST_PARSED,function(){ h.destroy(); cleanup(); done({s:'manifest_ok'}); });
          h.attachMedia(v); h.loadSource(u);
        } else { v.src=u; }
      });
      res.push({n:k.n, u:u.slice(0,52), r:r.s, w:r.w||0});
      if(r.s==='meta'||r.s==='manifest_ok') ok++;
    }
    return JSON.stringify({tested:cands.length, playable:ok, res:res});
  })()`, true));

  // 移动端（开关按钮此时可见，检查顶栏是否溢出）
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1600);
  R.mobile = await ev(`(function(){
    var tb=document.querySelector('.topbar').getBoundingClientRect();
    var btns=document.querySelectorAll('.topactions .skeu-key');
    var last=btns[btns.length-1].getBoundingClientRect();
    return { viewport:[innerWidth,innerHeight],
      topbarH:Math.round(tb.height), buttons:btns.length,
      lastRight:Math.round(last.right), overflowX:document.documentElement.scrollWidth>innerWidth+1,
      httpsBtnHidden:document.getElementById('btn-https').hidden,
      httpsBtnLabel:(document.querySelector('#btn-https span')||{}).offsetParent===null?'(仅图标)':'(带文字)',
      toolbarsWrap:tb.height>70 };
  })()`);
  await shot('35_https_mobile');

  R.errors = errors;
  console.log(JSON.stringify(R, null, 1));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
