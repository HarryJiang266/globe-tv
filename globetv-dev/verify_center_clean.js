/* 确认「播放全屏时中央没有画三角」：
   在冻结画面后，人为把 bigplay 的透明度 0 → 1 再差分，
   这样得到的才是三角真实占据的区域，可与"播放态"下的中央画面作比对。
   用法：node verify_center_clean.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9540;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-cc-'));
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
  return OUT + n + '.png';
}
async function mouse(type, x, y, click) {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: click ? 'left' : 'none',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, pointerType: 'mouse'
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

  // 播一个频道
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
  await sleep(250);
  await mouse('mousePressed', Math.round(t.x), Math.round(t.y), true);
  await mouse('mouseReleased', Math.round(t.x), Math.round(t.y), true);
  await sleep(4500);

  // 进全屏
  const fsb = JSON.parse(await ev(`(function(){var r=document.getElementById('p-fs').getBoundingClientRect();
    return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]);})()`));
  await mouse('mouseMoved', fsb[0], fsb[1]);
  await sleep(180);
  await mouse('mousePressed', fsb[0], fsb[1], true);
  await mouse('mouseReleased', fsb[0], fsb[1], true);
  await sleep(2000);

  const playing = !(await ev(`document.getElementById('video').paused`));
  const op = await ev(`+getComputedStyle(document.getElementById('p-bigplay')).opacity`);
  console.log('== 播放中（全屏）==');
  console.log('  正在播放: %s   中央播放键计算透明度: %s  %s',
    playing, op, op === 0 ? '→ 不参与绘制 ✓' : '→ 会画出来 ✗');

  /* 冻结画面：暂停后立即把 bigplay 强制打开再关掉，两次截图差分。
     暂停后画面不再变化，差分结果只可能来自三角本身。 */
  await ev(`document.getElementById('video').pause()`);
  await sleep(1300);
  await ev(`document.getElementById('p-bigplay').style.opacity = 0`);
  await sleep(350);
  const b0 = await shot('c1_三角_关');
  await ev(`document.getElementById('p-bigplay').style.opacity = 0.9`);
  await sleep(350);
  const b1 = await shot('c2_三角_开');
  await ev(`document.getElementById('p-bigplay').style.opacity = ''`);

  /* 决定性验证：把视频层隐藏（画面变纯黑），此时中央出现任何亮块都只可能是三角。
     这样就不受直播画面逐帧变化干扰了。 */
  await ev(`document.getElementById('video').style.visibility = 'hidden'`);
  await ev(`document.getElementById('video').play()`);
  await sleep(1400);
  await mouse('mouseMoved', 640, 300);
  await sleep(500);
  const state2 = JSON.parse(await ev(`(function(){
    var st=document.getElementById('stage');
    return JSON.stringify({playing: !document.getElementById('video').paused,
      isPlaying: st.classList.contains('is-playing'),
      bigplayOpacity: +getComputedStyle(document.getElementById('p-bigplay')).opacity});})()`));
  console.log('  隐藏视频层后：playing=%s is-playing=%s 三角透明度=%s',
    state2.playing, state2.isPlaying, state2.bigplayOpacity);
  const b2 = await shot('c3_播放中_中央');

  // 同一状态下人为打开三角，作为对照：证明这条检测手段能看见三角
  await ev(`document.getElementById('p-bigplay').style.opacity = 1`);
  await sleep(400);
  const b3 = await shot('c4_人为开三角_对照');
  await ev(`document.getElementById('p-bigplay').style.opacity = ''`);
  await ev(`document.getElementById('video').style.visibility = ''`);
  console.log('SHOTS2 ' + JSON.stringify({ playing: b2, forced: b3 }));

  console.log('SHOTS ' + JSON.stringify({ off: b0, on: b1, playing: b2 }));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
