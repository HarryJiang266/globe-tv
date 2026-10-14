/* 测不同视角下球盘的平均亮度：验证"海洋=纯黑 → 转到太平洋半球就像黑球"
   用法：node tools/scan_lon.js <URL> [light] */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2] || 'https://global-tv-globe.app.workbuddy.host/index.html';
const LIGHT = process.argv[3] === 'light';
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9400;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-sl-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors', '--window-size=1920,1080', 'about:blank'
], { stdio: 'ignore' });
let ws, seq = 0; const wq = new Map(); const errs = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errs.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      errs.push('LOG ' + m.params.entry.text.slice(0, 200));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) { ready = true; break; } } catch (e) { }
  }
  if (!ready) {
    console.log('页面未就绪，收集到的错误：');
    console.log('  ' + (errs.length ? JSON.stringify([...new Set(errs)], null, 1) : '（无控制台错误）'));
    const dom = await ev('document.body ? document.body.innerText.slice(0,300) : "(no body)"');
    console.log('  boot 是否还在: ' + (await ev('!!document.getElementById("boot")')));
    console.log('  可见文本: ' + JSON.stringify(dom));
  }
  if (LIGHT) {
    await ev(`document.getElementById('btn-theme').click()`);
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      const ok = await ev(`(function(){var g=GlobeTV.globe;var u=g.earthMat.uniforms.uMap.value;
        return !!(u && /earth-light/.test(String(u.image.currentSrc||u.image.src)) && u.image.complete);})()`);
      if (ok) break;
    }
  }
  const spots = [
    ['太平洋（几乎全是海）', -140, 0],
    ['大西洋', -30, 10],
    ['非洲/欧洲', 20, 20],
    ['亚洲', 100, 30],
    ['北美', -100, 40],
    ['南美', -60, -15]
  ];
  for (const [name, lon, lat] of spots) {
    await ev(`(function(){var g=GlobeTV.globe; g.idle=-1e9; g.vel.x=0; g.vel.y=0;
      g.target=null; g.yaw=g.toYaw(${lon}); g.pitch=${lat}*Math.PI/180; return 1;})()`);
    await sleep(700);
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(OUT + 'scanf_' + Math.abs(lon) + '.png', Buffer.from(r.data, 'base64'));
    console.log('SAVED ' + name + ' lon=' + lon + ' lat=' + lat + ' -> scanf_' + Math.abs(lon) + '.png');
  }
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
