/* 亮点性能与渲染自检：1 万个点的帧率、悬停延迟、点击命中、海域占比
   用法：node verify_markers_perf.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const PREFIX = process.argv[3] || 'p';
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9490;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-pf-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1600,900', 'about:blank'
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  await send('Page.navigate', { url: URL });
  let ready = false;
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) { ready = true; break; } } catch (e) { }
  }
  const bootMs = Date.now() - t0;
  console.log('首屏就绪 %d ms，页面就绪=%s', bootMs, ready);
  if (!ready) { console.log('错误:', errs.slice(0, 3)); process.exit(1); }
  await sleep(1800);

  const basic = JSON.parse(await ev(`(function(){var g=GlobeTV.globe;
    return JSON.stringify({markers:g.markerCount, channels:TV_DATA.channels.length,
      dot:g.dot, hasIdle:'idle' in g, dotsForSample:g.dotsFor(1000)});})()`));
  // 旧版线上有自转，会污染"亮点开/关"的对比，这里统一冻住
  await ev(`(function(){var g=GlobeTV.globe; if('idle' in g) g.idle = -1e9; return 1;})()`);
  console.log('亮点数 %d / 频道数 %d', basic.markers, basic.channels);
  console.log('亮点尺寸参数', JSON.stringify(basic.dot));
  console.log('idle 字段是否已移除:', !basic.hasIdle);
  console.log('dotsFor(1000) =', basic.dotsForSample, basic.dotsForSample === 1000 ? '(全量 OK)' : '(仍在截断!)');

  // --- 自转是否真的停了 ---
  await ev(`(function(){var g=GlobeTV.globe; g.target=null; g.vel.x=0; g.vel.y=0; return 1;})()`);
  const yawA = await ev('GlobeTV.globe.yaw');
  await sleep(3000);
  const yawB = await ev('GlobeTV.globe.yaw');
  console.log('静止 3 秒后 yaw 变化: %s  → %s', yawA.toFixed(6), yawB.toFixed(6));
  console.log('  %s', Math.abs(yawB - yawA) < 1e-6 ? '✓ 已停止自转' : '✗ 仍在自转');

  // --- 帧率（连续 2 秒采样）---
  const fps = await ev(`new Promise(function(res){
    var n=0, t0=performance.now();
    function tick(){ n++; if(performance.now()-t0 < 2000) requestAnimationFrame(tick);
      else res(Math.round(n/((performance.now()-t0)/1000))); }
    requestAnimationFrame(tick);
  })`, true);
  console.log('平均帧率 %d fps', fps);

  // --- 悬停延迟（模拟指针移动，量 hitTest 耗时）---
  const hover = JSON.parse(await ev(`(function(){
    var g=GlobeTV.globe, N=60, t0=performance.now();
    for(var i=0;i<N;i++) g.hitTest(300+i*7, 400+(i%37));
    return JSON.stringify({perCall:+( (performance.now()-t0)/N ).toFixed(3), n:g.markerCount});
  })()`));
  console.log('单次命中检测 %s ms（%d 个点）→ 悬停预算 %s', hover.perCall, hover.n,
    hover.perCall < 4 ? '✓ 流畅' : '△ 偏慢');

  // --- 点击命中：随机取 20 个亮点，用屏幕坐标点它，看是否选对 ---
  const click = JSON.parse(await ev(`(function(){
    var g=GlobeTV.globe, w=innerWidth, h=innerHeight, tested=0, ok=0, miss=[];
    for (var i=0;i<g.markerCount && tested<24;i+=Math.max(1,Math.floor(g.markerCount/24))){
      var v=g._tmp2.set(g.pos[i*3],g.pos[i*3+1],g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx=g.camera.position.x-v.x, cy=g.camera.position.y-v.y, cz=g.camera.position.z-v.z;
      if(v.x*cx+v.y*cy+v.z*cz<=0.3) continue;
      var p=v.clone().project(g.camera);
      var sx=(p.x*0.5+0.5)*w, sy=(-p.y*0.5+0.5)*h;
      if(sx<10||sx>w-10||sy<10||sy>h-10) continue;
      tested++;
      var hit=g.hitTest(sx,sy);
      if(hit===i) ok++; else miss.push({want:i,got:hit});
    }
    return JSON.stringify({tested:tested, ok:ok, miss:miss.slice(0,4), rate: tested? (100*ok/tested).toFixed(0)+'%':'-'});
  })()`));
  console.log('点击命中 %d/%d (%s)', click.ok, click.tested, click.rate);

  // --- 亮点渲染覆盖率（判断密区有没有糊成一片）---
  const shots = {};
  shots.default = await shot(PREFIX + '1_default');
  await ev(`(function(){var g=GlobeTV.globe; g.target=null; g.vel.x=0; g.vel.y=0;
    g.yaw=g.toYaw(78); g.pitch=22*Math.PI/180; return 1;})()`);
  await sleep(900);
  shots.india = await shot(PREFIX + '2_india');
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 0`);
  await sleep(600);
  shots.indiaOff = await shot(PREFIX + '2_india_nomark');
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
  await ev(`(function(){var g=GlobeTV.globe; g.yaw=g.toYaw(20); g.pitch=30*Math.PI/180; return 1;})()`);
  await sleep(900);
  shots.europe = await shot(PREFIX + '3_europe');

  console.log('错误: ' + (errs.length ? [...new Set(errs)].slice(0, 4).join(' | ') : '无'));
  console.log('SHOTS ' + JSON.stringify(shots));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
