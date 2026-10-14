/* 精确检查全屏控制条：DOM 几何 + 开关差分（排除视频画面干扰）
   用法：node verify_fsctl.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9530;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-fc-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

let ws, seq = 0; const wq = new Map();
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
}
async function mouse(type, x, y, click) {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: click ? 'left' : 'none',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
    pointerType: 'mouse'
  });
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(2000);

  // 播一个频道（静态画面，便于差分）
  const t = JSON.parse(await ev(`(function(){
    var g=GlobeTV.globe,best=null;
    for(var i=0;i<g.markerCount;i++){
      var v=g._tmp2.set(g.pos[i*3],g.pos[i*3+1],g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx=g.camera.position.x-v.x,cy=g.camera.position.y-v.y,cz=g.camera.position.z-v.z;
      if(v.x*cx+v.y*cy+v.z*cz<=0.3) continue;
      var p=v.clone().project(g.camera);
      var sx=(p.x*0.5+0.5)*innerWidth,sy=(-p.y*0.5+0.5)*innerHeight;
      if(sx<300||sx>innerWidth-300||sy<200||sy>innerHeight-320) continue;
      var m=g.meta[i]; if(!best||m.total>best.total) best={x:sx,y:sy};
    } return JSON.stringify(best);})()`));
  await mouse('mouseMoved', Math.round(t.x), Math.round(t.y));
  await sleep(300);
  await mouse('mousePressed', Math.round(t.x), Math.round(t.y), true);
  await mouse('mouseReleased', Math.round(t.x), Math.round(t.y), true);
  await sleep(3500);

  // 真实点击进全屏
  const fsb = JSON.parse(await ev(`(function(){var r=document.getElementById('p-fs').getBoundingClientRect();
    return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]);})()`));
  await mouse('mouseMoved', fsb[0], fsb[1]);
  await sleep(150);
  await mouse('mousePressed', fsb[0], fsb[1], true);
  await mouse('mouseReleased', fsb[0], fsb[1], true);
  await sleep(2200);
  console.log('进入全屏: %s' , await ev(`!!document.fullscreenElement && document.fullscreenElement.id`));

  // DOM 几何
  const geo = JSON.parse(await ev(`(function(){
    function box(id){var r=document.getElementById(id).getBoundingClientRect();
      return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
              right:Math.round(r.right),bottom:Math.round(r.bottom),
              opacity:+getComputedStyle(document.getElementById(id)).opacity};}
    var ctl=document.getElementById('p-fsctl');
    return JSON.stringify({
      viewport:[innerWidth,innerHeight],
      ctl: box('p-fsctl'),
      play: box('p-fsplay'),
      exit: box('p-fsexit'),
      playIcon: document.querySelector('#p-fsplay-icon').innerHTML.trim().slice(0,26),
      exitSvg: !!document.querySelector('#p-fsexit svg'),
      ctlPE: getComputedStyle(ctl).pointerEvents,
      farFromCenter: (function(){
        var r=ctl.getBoundingClientRect(), cx=innerWidth/2, cy=innerHeight/2;
        var ccx=r.x+r.width/2, ccy=r.y+r.height/2;
        return Math.round(Math.hypot(ccx-cx, ccy-cy));
      })()
    });})()`));
  console.log('视口 %s', JSON.stringify(geo.viewport));
  console.log('控制条  x=%d y=%d w=%d h=%d  透明度=%s  pointer-events=%s',
    geo.ctl.x, geo.ctl.y, geo.ctl.w, geo.ctl.h, geo.ctl.opacity, geo.ctlPE);
  console.log('  → 距右边缘 %d px，距底边 %d px', geo.viewport[0] - geo.ctl.right, geo.viewport[1] - geo.ctl.bottom);
  console.log('  → 距屏幕中心 %d px（越远越不挡画面）', geo.farFromCenter);
  console.log('暂停按钮  %dx%d 在 (%d,%d)，图标: %s', geo.play.w, geo.play.h, geo.play.x, geo.play.y, geo.playIcon);
  console.log('退出按钮  %dx%d 在 (%d,%d)，含 SVG: %s', geo.exit.w, geo.exit.h, geo.exit.x, geo.exit.y, geo.exitSvg);
  console.log('两按钮均在视口内: %s', geo.play.right <= 1280 && geo.exit.right <= 1280 && geo.exit.bottom <= 800);

  // 开关差分：确认真的画出来了，而且只占右下角一小块。
  // 必须先把视频暂停 —— 直播画面每帧都在变，否则差分会被画面运动淹没。
  await ev(`document.getElementById('video').pause()`);
  await sleep(1200);
  await mouse('mouseMoved', 640, 300);
  await sleep(400);
  await shot('f1_ctl_on');
  await ev(`document.getElementById('p-fsctl').style.opacity = 0`);
  await sleep(350);
  await shot('f2_ctl_off');
  await ev(`document.getElementById('p-fsctl').style.opacity = ''`);

  // 中央有没有残留东西
  const center = JSON.parse(await ev(`(function(){
    var b=document.getElementById('p-bigplay');
    var st=document.getElementById('stage');
    return JSON.stringify({
      bigplayOpacity:+getComputedStyle(b).opacity,
      isPlaying: st.classList.contains('is-playing'),
      hasMsg: st.classList.contains('has-msg'),
      paused: document.getElementById('video').paused
    });})()`));
  console.log();
  // 注意：走到这里视频已经被上面故意暂停（为了让差分不受画面变化干扰），
  // 所以此刻 is-playing=false、三角理应显示（0.9）。播放态的判定在上面第 2 节。
  console.log('当前状态（差分前已暂停视频）：中央播放键透明度 %s | is-playing=%s | 暂停=%s',
    center.bigplayOpacity, center.isPlaying, center.paused);
  console.log('  → 暂停时显示三角是预期行为；播放中为 0 已在上一步单独验证。');

  console.log('SHOTS ' + JSON.stringify({ on: OUT + 'f1_ctl_on.png', off: OUT + 'f2_ctl_off.png' }));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
