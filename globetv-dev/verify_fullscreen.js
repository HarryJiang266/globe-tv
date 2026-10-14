/* 验证：① 播放中不再出现中央三角 ② 全屏控制条能唤出并自动淡出 ③ 更新提醒会出现
   用法：node verify_fullscreen.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9520;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-fs-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

let ws, seq = 0; const wq = new Map(); const errs = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
async function ev(e, aw) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!aw });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result && r.result.value;
}
async function shot(n) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64'));
  return OUT + n + '.png';
}
async function mouse(type, x, y) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
}

const opacity = sel => `parseFloat(getComputedStyle(document.querySelector('${sel}')).opacity)`;

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; errs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 160)); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 160));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  /* ---------- 1) 更新提醒 ----------
     先预置一个"更早的已读版本"，模拟老用户升级，看会不会弹说明。 */
  await send('Page.navigate', { url: URL });
  await sleep(1200);
  await ev(`localStorage.setItem('globetv.seenVersion', '"2026-10-01.0"')`);
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(2600);
  const upd = JSON.parse(await ev(`(function(){
    var box=document.getElementById('upd'), dot=document.getElementById('upd-dot');
    return JSON.stringify({
      visible: !box.hidden,
      version: document.getElementById('upd-cur').textContent,
      entries: document.querySelectorAll('.upd-item').length,
      bullets: document.querySelectorAll('.upd-list li').length,
      newMarked: document.querySelectorAll('.upd-item.is-new').length,
      dotShown: !dot.hidden,
      seen: localStorage.getItem('globetv.seenVersion'),
      cardRect: (function(){var r=document.querySelector('.upd-card').getBoundingClientRect();
        return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]})()
    });})()`));
  console.log('=== 1) 更新提醒 ===');
  console.log('  自动弹出: %s | 版本 %s | 条目 %d 条 / 共 %d 个要点 | 新版标记 %d 个',
    upd.visible, upd.version, upd.entries, upd.bullets, upd.newMarked);
  console.log('  卡片位置 %s  视口内: %s', JSON.stringify(upd.cardRect),
    upd.cardRect[0] >= 0 && upd.cardRect[1] >= 0 &&
    upd.cardRect[0] + upd.cardRect[2] <= 1280 && upd.cardRect[1] + upd.cardRect[3] <= 800);
  await shot('u1_更新弹窗');

  // 关闭后圆点应消失、已读版本被写入
  await ev(`document.getElementById('upd-close').click()`);
  await sleep(400);
  const after = JSON.parse(await ev(`JSON.stringify({
    visible: !document.getElementById('upd').hidden,
    dotShown: !document.getElementById('upd-dot').hidden,
    seen: localStorage.getItem('globetv.seenVersion')
  })`));
  console.log('  关闭后: 弹窗隐藏 %s | 圆点消失 %s | 已读版本 %s',
    !after.visible, !after.dotShown, after.seen);

  // 再次打开（从右上角按钮），验证随时可查
  await ev(`document.getElementById('btn-updates').click()`);
  await sleep(400);
  console.log('  点右上角按钮可再次打开: %s', !(await ev(`document.getElementById('upd').hidden`)));
  await ev(`document.getElementById('upd-close').click()`);
  await sleep(300);

  // 刷新后不应再自动弹（已读）
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(2400);
  console.log('  刷新后不再自动弹（已读）: %s', await ev(`document.getElementById('upd').hidden`));

  /* ---------- 2) 播放中的中央三角 ---------- */
  const target = JSON.parse(await ev(`(function(){
    var g=GlobeTV.globe, best=null;
    for (var i=0;i<g.markerCount;i++){
      var v=g._tmp2.set(g.pos[i*3],g.pos[i*3+1],g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx=g.camera.position.x-v.x, cy=g.camera.position.y-v.y, cz=g.camera.position.z-v.z;
      if(v.x*cx+v.y*cy+v.z*cz<=0.3) continue;
      var p=v.clone().project(g.camera);
      var sx=(p.x*0.5+0.5)*innerWidth, sy=(-p.y*0.5+0.5)*innerHeight;
      if(sx<300||sx>innerWidth-300||sy<200||sy>innerHeight-320) continue;
      var m=g.meta[i]; if(!best||m.total>best.total) best={x:sx,y:sy,name:m.ch.n};
    } return JSON.stringify(best);})()`));
  await mouse('mouseMoved', Math.round(target.x), Math.round(target.y));
  await sleep(500);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(target.x), y: Math.round(target.y), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(target.x), y: Math.round(target.y), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(6000);

  const play = JSON.parse(await ev(`(function(){
    var v=document.getElementById('video'), st=document.getElementById('stage');
    return JSON.stringify({
      name: document.getElementById('p-name').textContent,
      paused: v.paused, w: v.videoWidth,
      isPlaying: st.classList.contains('is-playing'),
      hasMsg: st.classList.contains('has-msg')
    });})()`));
  console.log();
  console.log('=== 2) 播放中的中央三角 ===');
  console.log('  频道 %s | 播放中 %s | 分辨率 %s | is-playing=%s',
    play.name, !play.paused, play.w, play.isPlaying);

  // 读取三个状态下的三角透明度（stage-big 覆盖整屏，指针必然悬停在上面）
  await mouse('mouseMoved', 640, 400);      // 指针停在画面正中
  await sleep(500);
  const opPlaying = await ev(opacity('#p-bigplay'));
  await shot('u2_播放中_指针在正中');

  await ev(`document.getElementById('video').pause()`);
  await sleep(600);
  const opPaused = await ev(opacity('#p-bigplay'));
  await shot('u3_暂停时_显示三角');

  await ev(`document.getElementById('video').play()`);
  await sleep(800);
  const opResume = await ev(opacity('#p-bigplay'));
  console.log('  播放中三角透明度: %s  →  %s', opPlaying, opPlaying === 0 ? '已隐藏 ✓' : '仍可见 ✗');
  console.log('  暂停后三角透明度: %s  →  %s', opPaused, opPaused > 0.5 ? '显示 ✓（提示可继续）' : '未显示 ✗');
  console.log('  恢复播放后:       %s  →  %s', opResume, opResume === 0 ? '再次隐藏 ✓' : '仍可见 ✗');

  /* ---------- 3) 全屏控制条 ---------- */
  // 必须用真实鼠标点击：requestFullscreen 要求用户手势，
  // 用 JS 调 .click() 会被浏览器以 "Permissions check failed" 拒绝。
  const fsBtn = JSON.parse(await ev(`(function(){
    var r=document.getElementById('p-fs').getBoundingClientRect();
    return JSON.stringify([Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)]);})()`));
  await mouse('mouseMoved', fsBtn[0], fsBtn[1]);
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fsBtn[0], y: fsBtn[1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fsBtn[0], y: fsBtn[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1800);
  const fsOn = await ev(`!!document.fullscreenElement && document.fullscreenElement.id`);
  const ctl0 = await ev(opacity('#p-fsctl'));
  await mouse('mouseMoved', 640, 300);
  await sleep(500);
  const ctl1 = await ev(opacity('#p-fsctl'));
  const icon1 = await ev(`document.querySelector('#p-fsplay-icon').innerHTML.indexOf('M12.9') >= 0 ? 'pause' : 'play'`);
  await shot('u4_全屏控制条');
  await sleep(3400);
  const ctl2 = await ev(opacity('#p-fsctl'));

  console.log();
  console.log('=== 3) 全屏控制条 ===');
  console.log('  已进入全屏: %s (%s)', !!fsOn, fsOn || '-');
  console.log('  进入时(未动鼠标): 透明度 %s', ctl0);
  console.log('  移动鼠标后:       透明度 %s  %s', ctl1, ctl1 > 0.5 ? '已唤出 ✓' : '未唤出 ✗');
  console.log('  播放中图标为:     %s  %s', icon1, icon1 === 'pause' ? '（正确，点击可暂停）' : '（应为 pause）');
  console.log('  停手 3.4 秒后:     透明度 %s  %s', ctl2, ctl2 === 0 ? '已自动淡出 ✓' : '未淡出 ✗');

  // 控制条按钮真的能暂停吗
  await mouse('mouseMoved', 640, 300);
  await sleep(400);
  const btnPos = JSON.parse(await ev(`(function(){
    var r=document.getElementById('p-fsplay').getBoundingClientRect();
    return JSON.stringify([Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)]);})()`));
  await mouse('mouseMoved', btnPos[0], btnPos[1]);
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnPos[0], y: btnPos[1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnPos[0], y: btnPos[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(900);
  console.log('  点击控制条暂停键 → video.paused = %s  %s',
    await ev(`document.getElementById('video').paused`),
    (await ev(`document.getElementById('video').paused`)) ? '生效 ✓' : '未生效 ✗');
  await shot('u5_控制条暂停后');

  console.log();
  console.log('控制台错误: ' + (errs.length ? [...new Set(errs)].slice(0, 4).join(' | ') : '无'));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
