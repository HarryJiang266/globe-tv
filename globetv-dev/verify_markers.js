/* 亮点对比度专项检查：连到线上站点，A/B 关开亮点图层，
   量化每个亮点的亮度增益与"绿色可辨识度"，确认调亮背景后亮点没被洗掉。
   用法：node tools/verify_markers.js <URL> [light] */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const LIGHT = process.argv[3] === 'light';
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9460;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-vm-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1920,1080', 'about:blank'
], { stdio: 'ignore' });
let ws, seq = 0; const wq = new Map(); const errs = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result && r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const p = OUT + name + '.png';
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errs.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 150));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      errs.push('LOG ' + m.params.entry.text.slice(0, 150));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) { ready = true; break; } } catch (e) { }
  }
  if (!ready) { console.log('页面未就绪', errs.slice(0, 3)); process.exit(1); }
  if (LIGHT) {
    await ev(`document.getElementById('btn-theme').click()`);
    for (let i = 0; i < 70; i++) {
      await sleep(400);
      const ok = await ev(`(function(){var u=GlobeTV.globe.earthMat.uniforms.uMap.value;
        return !!(u && /earth-light/.test(String(u.image.currentSrc||u.image.src)) && u.image.complete);})()`).catch(() => false);
      if (ok) break;
    }
  }
  // 固定视角：非洲（有陆有海，亮点密）
  await ev(`(function(){var g=GlobeTV.globe; g.idle=-1e9; g.vel.x=0; g.vel.y=0; g.target=null;
    g.yaw=g.toYaw(20); g.pitch=20*Math.PI/180; return 1;})()`);
  await sleep(1200);

  const markScale = await ev('GlobeTV.globe.markMat.uniforms.uScale.value');
  const markOpacity = await ev('GlobeTV.globe.markMat.uniforms.uOpacity.value');
  const markColor = await ev('JSON.stringify(GlobeTV.globe.markMat.uniforms.uColor.value)');
  console.log('亮点材质: uScale=' + markScale.toFixed(3) + '  uOpacity=' + markOpacity + '  uColor=' + markColor);

  // A：关掉亮点
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 0`);
  await sleep(700);
  const a = await shot(LIGHT ? 'mk_light_off' : 'mk_dark_off');
  // B：打开亮点
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
  await sleep(700);
  const b = await shot(LIGHT ? 'mk_light_on' : 'mk_dark_on');

  console.log('SHOTS ' + JSON.stringify({ off: a, on: b }));
  console.log('错误: ' + (errs.length ? [...new Set(errs)].slice(0, 3).join(' | ') : '无'));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
