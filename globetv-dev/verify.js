/* Globe TV — 最终验收（真实交互 + 截图） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const URL = process.argv[2] || 'http://127.0.0.1:8777/index.html';
const OUT = require('path').join(__dirname, '.shots') + require('path').sep;
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-v-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const waiting = new Map(); const errors = [];
function send(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
}
function onMsg(raw) {
  const m = JSON.parse(raw);
  if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 260));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
    errors.push('LOG ' + m.params.entry.text.slice(0, 260));
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    var d = r.exceptionDetails;
    throw new Error('EVAL FAIL: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text) +
      ' | 表达式: ' + String(expr).slice(0, 200));
  }
  return r.result.value;
}
async function shot(n) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64'));
}
async function mouse(type, x, y, btn) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: btn || 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type.includes('Press') || type.includes('Rele') ? 1 : 0, pointerType: 'mouse' });
}
async function click(x, y) { await mouse('mouseMoved', x, y); await sleep(110); await mouse('mousePressed', x, y); await sleep(70); await mouse('mouseReleased', x, y); }

const R = {};

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => onMsg(e.data);
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV && GlobeTV.globe && GlobeTV.globe.markerCount) && !document.getElementById("boot")')) break; } catch (e) { }
  }
  R.bootMs = Date.now() - t0;
  await sleep(900);

  R.basic = await ev(`(function(){var g=GlobeTV.globe;var u=g.earthMat.uniforms.uMap.value;return{
    channels:TV_DATA.channels.length, countries:Object.keys(TV_DATA.countries).length, streams:TV_DATA.meta.streams,
    markers:g.markerCount, texture:u?[u.image.width,u.image.height]:null, canvas:[g.renderer.domElement.width,g.renderer.domElement.height],
    cats:TV_DATA.categories.length, theme:document.documentElement.className||'(light)',
    hud:[stat_ch(),stat_cc(),stat_st()]};function stat_ch(){return document.getElementById('stat-ch').textContent};
    function stat_cc(){return document.getElementById('stat-cc').textContent}
    function stat_st(){return document.getElementById('stat-st').textContent}})()`);
  await shot('20_dark');

  // 悬停 + 点击
  R.hover = JSON.parse(await ev(`(function(){var g=GlobeTV.globe,best=null;
    for(var i=0;i<g.markerCount;i++){
      var v=g._tmp2.set(g.pos[i*3],g.pos[i*3+1],g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx=g.camera.position.x-v.x,cy=g.camera.position.y-v.y,cz=g.camera.position.z-v.z;
      if(v.x*cx+v.y*cy+v.z*cz<=0.3) continue;
      var p=v.clone().project(g.camera),sx=(p.x*.5+.5)*innerWidth,sy=(-p.y*.5+.5)*innerHeight;
      if(sx<420||sx>innerWidth-260||sy<150||sy>innerHeight-300) continue;
      var m=g.meta[i]; if(!best||m.total>best.total) best={x:sx,y:sy,total:m.total,name:m.ch.n,cc:m.cc};
    } return JSON.stringify(best)})()`));
  if (R.hover) {
    await mouse('mouseMoved', 20, 20); await sleep(60);
    await mouse('mouseMoved', Math.round(R.hover.x), Math.round(R.hover.y)); await sleep(800);
    R.tip = await ev(`(function(){var t=document.getElementById('tip');return{hidden:t.hidden,name:document.getElementById('tip-name').textContent,meta:document.getElementById('tip-meta').textContent}})()`);
    await shot('21_hover');
    await click(Math.round(R.hover.x), Math.round(R.hover.y));
    await sleep(3500);
    R.player = await ev(`(function(){var p=document.getElementById('player'),v=document.getElementById('video');
      var pr=p.getBoundingClientRect(),zr=document.querySelector('.zoomctl').getBoundingClientRect();
      var overlap=!(zr.right<pr.left||zr.left>pr.right||zr.bottom<pr.top||zr.top>pr.bottom);
      return{hidden:p.hidden,name:document.getElementById('p-name').textContent,meta:document.getElementById('p-meta').textContent,
        sources:document.querySelectorAll('#p-sources .src').length,rows:document.querySelectorAll('#p-pl-body .row').length,
        badge:document.getElementById('p-quality').textContent,videoW:v.videoWidth,videoH:v.videoHeight,videoErr:v.error?v.error.code:null,
        msg:document.getElementById('p-msg').hidden?null:document.getElementById('p-msg-title').textContent,
        playerRect:[Math.round(pr.x),Math.round(pr.y),Math.round(pr.width),Math.round(pr.height)],
        zoomOverlap:overlap}})()`);
    await shot('22_player');
  }

  // 收藏
  await ev(`document.getElementById('p-fav').click()`);
  await sleep(400);
  R.fav = await ev(`({stored:(function(){try{return JSON.parse(localStorage.getItem('globetv.fav')||'[]').length}catch(e){return -1}})(),btn:document.getElementById('p-fav').className})`);

  // 抽屉 + 搜索
  await ev(`document.getElementById('btn-browse').click()`); await sleep(600);
  R.drawer = await ev(`({open:document.getElementById('drawer').classList.contains('is-open'),rows:document.querySelectorAll('#pane-country .row').length})`);
  await shot('23_drawer');
  await ev(`document.getElementById('search-input').focus()`);
  await ev(`document.getElementById('search-input').value='cnn'; document.getElementById('search-input').dispatchEvent(new Event('input'))`);
  await sleep(800);
  R.search = await ev(`({suggest:document.querySelectorAll('#suggest .row').length,first:(document.querySelector('#suggest .row-name')||{}).textContent,results:document.querySelectorAll('#pane-result .row').length,title:(document.querySelector('#pane-result .list-title')||{}).textContent})`);
  await shot('24_search');
  await ev(`document.querySelector('[data-tab="fav"]').click()`); await sleep(500);
  R.favTab = await ev(`({rows:document.querySelectorAll('#pane-fav .row').length,first:(document.querySelector('#pane-fav .row-name')||{}).textContent})`);
  await shot('25_favtab');

  // 关抽屉 + 深色干净视图
  await ev(`document.getElementById('drawer-close').click()`); await sleep(700);
  await ev(`document.getElementById('search-input').value='';document.getElementById('search-input').dispatchEvent(new Event('input'))`);
  await ev(`GlobeTV.globe.focusTo(20,25,3.1,10)`); await sleep(700);
  await shot('26_dark_clean');

  // 浅色
  await ev(`document.getElementById('btn-theme').click()`); await sleep(1400);
  R.light = await ev(`({cls:document.documentElement.className||'(light)',bg:getComputedStyle(document.body).backgroundColor,hud:getComputedStyle(document.getElementById('hud')).backgroundColor})`);
  await shot('27_light_clean');
  await ev(`document.getElementById('btn-theme').click()`); await sleep(900);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 880, deviceScaleFactor: 2, mobile: true });
  await sleep(1600);
  R.mobile = await ev(`(function(){var pr=document.getElementById('player').getBoundingClientRect();
    return{viewport:[innerWidth,innerHeight],playerRect:[Math.round(pr.x),Math.round(pr.y),Math.round(pr.width),Math.round(pr.height)],
    searchW:Math.round(document.querySelector('.searchwrap').getBoundingClientRect().width),
    zoomRect:(function(r){return [Math.round(r.x+r.width/2),Math.round(r.y)]})(document.querySelector('.zoomctl').getBoundingClientRect()),
    hudW:Math.round(document.getElementById('hud').getBoundingClientRect().width),
    overflowX: document.documentElement.scrollWidth>innerWidth+1}})()`);
  await shot('28_mobile');

  R.errors = errors;
  console.log(JSON.stringify(R, null, 1));
  proc.kill();
  process.exit(errors.length ? 2 : 0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
