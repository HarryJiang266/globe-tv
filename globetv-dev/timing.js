/* 首屏时间线：看每个资源什么时候开始、花了多久（用来定位串行等待）
   用法：node tools/timing.js https://your-app.app.workbuddy.host/index.html */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9343;
const URL = process.argv[2];
if (!URL) { console.error('用法: node tools/timing.js <URL>'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-t-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const wq = new Map();
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result && r.result.value;
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } }
    } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  await send('Page.navigate', { url: URL });
  let ready = -1;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) {
        ready = Date.now() - t0; break;
      }
    } catch (e) { }
  }
  const r = await ev(`JSON.stringify({
    ready: ${ready},
    nav: Math.round(performance.timing.responseStart - performance.timing.navigationStart),
    domDone: Math.round(performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart),
    loadEnd: Math.round(performance.timing.loadEventEnd - performance.timing.navigationStart),
    marks: (window.__tvMarks||null),
    res: performance.getEntriesByType('resource').map(function(e){return {
      n:e.name.split('/').pop().slice(0,26), s:Math.round(e.startTime), d:Math.round(e.duration), kb:Math.round(e.transferSize/1024)};})
      .sort(function(a,b){return a.s-b.s;})
  })`);
  const d = JSON.parse(r);
  const total = d.res.reduce((s, x) => s + x.kb, 0);
  console.log('首屏就绪 ' + d.ready + ' ms | DOMContentLoaded ' + d.domDone +
              ' ms | 请求 ' + d.res.length + ' 个 / 共 ' + total + ' KB');
  console.log('资源：');
  for (const x of d.res) {
    console.log('   ' + x.n.padEnd(28) + ' 开始 ' + String(x.s).padStart(6) + ' ms' +
                '  耗时 ' + String(x.d).padStart(6) + ' ms' +
                '  ' + String(x.kb).padStart(6) + ' KB');
  }
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
