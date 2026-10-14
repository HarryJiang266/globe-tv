/* 手机端触摸交互测试：真实 touch 事件，验证「点亮点 → 打开播放器」这条主链路。
   朋友基本都用手机打开，这是分享场景的核心风险点。
   用法：node tools/verify_mobile.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9480;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-mb-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=390,844', 'about:blank'
], { stdio: 'ignore' });

let ws, seq = 0; const wq = new Map(); const errs = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result && r.result.value;
}
async function shot(n) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64'));
}

// 真实触摸：touchStart -> touchEnd
async function tap(x, y) {
  const pt = [{ x: Math.round(x), y: Math.round(y), radiusX: 12, radiusY: 12, force: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(90);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; errs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 150)); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 150));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  // 手机 + 触摸
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await send('Page.navigate', { url: URL });

  let ready = false;
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) { ready = true; break; } } catch (e) { }
  }
  console.log('页面就绪: ' + ready);
  if (!ready) { console.log('错误: ' + errs.slice(0, 3)); process.exit(1); }
  await sleep(1500);

  const info = JSON.parse(await ev(`(function(){
    var g = GlobeTV.globe;
    return JSON.stringify({
      viewport:[innerWidth, innerHeight, devicePixelRatio],
      markerCount: g.markerCount,
      hitRadiusPx: Math.sqrt(g.hitR2),
      canvas:[g.renderer.domElement.width, g.renderer.domElement.height]
    });})()`));
  console.log('视口 ' + info.viewport.join('x') + ' (dpr ' + info.viewport[2] + ')  亮点 ' + info.markerCount +
    '  命中半径 ' + info.hitRadiusPx.toFixed(1) + ' CSS px  canvas ' + info.canvas.join('x'));

  // 找一个屏幕中间区域、正面的亮点
  const target = JSON.parse(await ev(`(function(){
    var g = GlobeTV.globe, best = null;
    for (var i = 0; i < g.markerCount; i++) {
      var v = g._tmp2.set(g.pos[i*3], g.pos[i*3+1], g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx = g.camera.position.x - v.x, cy = g.camera.position.y - v.y, cz = g.camera.position.z - v.z;
      if (v.x*cx + v.y*cy + v.z*cz <= 0.3) continue;
      var p = v.clone().project(g.camera);
      var sx = (p.x*0.5+0.5)*innerWidth, sy = (-p.y*0.5+0.5)*innerHeight;
      if (sx < 70 || sx > innerWidth-70 || sy < 170 || sy > innerHeight-170) continue;
      var m = g.meta[i];
      if (!best || m.total > best.total) best = { i:i, x:sx, y:sy, name:m.ch.name, cc:m.cc, total:m.total };
    }
    return JSON.stringify(best);})()`) );
  console.log('测试目标: ' + target.name + ' (' + target.cc + ') @ (' + Math.round(target.x) + ',' + Math.round(target.y) + ')');
  await shot('mb_1_before');

  // 用手指点它
  await tap(target.x, target.y);
  await sleep(2600);
  const afterTap = JSON.parse(await ev(`(function(){
    var p = document.getElementById('player');
    var r = p.getBoundingClientRect();
    return JSON.stringify({
      playerHidden: p.hidden,
      name: document.getElementById('p-name').textContent,
      sources: document.querySelectorAll('#p-sources .src').length,
      playlistRows: document.querySelectorAll('#p-pl-body .row').length,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      inViewport: r.x >= -1 && r.right <= innerWidth + 1 && r.y >= -1 && r.bottom <= innerHeight + 1,
      msg: document.getElementById('p-msg').hidden ? null : document.getElementById('p-msg-title').textContent
    });})()`));
  console.log('手指轻点后: ' + JSON.stringify(afterTap));
  await shot('mb_2_player');

  // 点关闭
  if (!afterTap.playerHidden) {
    await ev(`document.getElementById('p-close').click()`);
    await sleep(600);
    const closed = await ev(`document.getElementById('player').hidden`);
    console.log('关闭播放器: ' + (closed ? '正常' : '失败'));
  }

  // 打开抽屉（朋友会用手机浏览频道列表）
  await ev(`document.getElementById('btn-browse').click()`);
  await sleep(800);
  const drawer = JSON.parse(await ev(`(function(){
    var d = document.getElementById('drawer');
    var r = d.getBoundingClientRect();
    return JSON.stringify({ open: d.classList.contains('is-open'),
      rect:[Math.round(r.x),Math.round(r.width)], viewportW: innerWidth,
      rows: document.querySelectorAll('#pane-country .row').length,
      coversScreen: r.width / innerWidth });})()`));
  console.log('抽屉: ' + JSON.stringify(drawer));
  await shot('mb_3_drawer');

  // 抽屉里点一个国家（验证触屏选中）
  const rowY = JSON.parse(await ev(`(function(){
    var rows = document.querySelectorAll('#pane-country .row');
    var r = rows[2].getBoundingClientRect();
    return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2, name: rows[2].querySelector('.row-name').textContent});})()`));
  await tap(rowY.x, rowY.y);
  await sleep(2200);
  const afterRow = JSON.parse(await ev(`(function(){
    var p = document.getElementById('player');
    return JSON.stringify({playerHidden:p.hidden, name:document.getElementById('p-name').textContent,
      drawerOpen: document.getElementById('drawer').classList.contains('is-open')});})()`));
  console.log('抽屉点「' + rowY.name + '」后: ' + JSON.stringify(afterRow));
  await shot('mb_4_after');

  // 命中容差测试：故意点偏，看还能不能命中（手指接触面约 8~10mm，点不准是常态）
  await ev(`document.getElementById('p-close').click()`);
  await sleep(700);
  const off = JSON.parse(await ev(`(function(){
    var g = GlobeTV.globe, best = null;
    for (var i = 0; i < g.markerCount; i++) {
      var v = g._tmp2.set(g.pos[i*3], g.pos[i*3+1], g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx = g.camera.position.x - v.x, cy = g.camera.position.y - v.y, cz = g.camera.position.z - v.z;
      if (v.x*cx + v.y*cy + v.z*cz <= 0.3) continue;
      var p = v.clone().project(g.camera);
      var sx = (p.x*0.5+0.5)*innerWidth, sy = (-p.y*0.5+0.5)*innerHeight;
      if (sx < 90 || sx > innerWidth-90 || sy < 200 || sy > innerHeight-200) continue;
      var m = g.meta[i];
      if (!best || m.total > best.total) best = { x:sx, y:sy, name:m.ch.n };
    }
    return JSON.stringify(best);})()`));
  console.log();
  console.log('=== 命中容差测试（触屏命中半径 ' + info.hitRadiusPx.toFixed(1) + ' px）===');
  const offsets = [[0,0],[14,0],[-14,0],[0,14],[0,-14],[20,20],[26,-18]];
  let hitCount = 0;
  for (const [dx,dy] of offsets) {
    await ev(`document.getElementById('player').hidden = true`);
    await tap(off.x + dx, off.y + dy);
    await sleep(900);
    const opened = !(await ev("document.getElementById('player').hidden"));
    if (opened) hitCount++;
    const nm = opened ? await ev("document.getElementById('p-name').textContent") : '';
    console.log('  偏移 (' + String(dx).padStart(3) + ',' + String(dy).padStart(3) + ')  ' +
      (opened ? '命中 → ' + nm : '未命中'));
    if (opened) await ev(`document.getElementById('p-close').click()`);
    await sleep(400);
  }
  console.log('  → ' + hitCount + '/' + offsets.length + ' 次点偏仍能命中');

  console.log('控制台错误: ' + (errs.length ? [...new Set(errs)].slice(0, 4).join(' | ') : '无'));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
