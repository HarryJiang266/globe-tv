/* 亮点尺寸调参：在真实页面上注入不同参数，量各密度区域的覆盖情况。
   目标：整体明显比旧版密（旧版 2551 个点、固定尺寸 0.0104），
        但印度/欧洲这种密区不能糊成一整片。
   用法：node tune_dots.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9500;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-dt-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1600,900', 'about:blank'
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

// [名称, base, exp, min]
const CANDS = [
  ['A_base0190_exp009_min072', 0.0190, 0.09, 0.72],
  ['B_base0160_exp009_min072', 0.0160, 0.09, 0.72],
  ['C_base0130_exp009_min072', 0.0130, 0.09, 0.72],
  ['D_base0190_exp014_min065', 0.0190, 0.14, 0.65],
  ['E_base0220_exp009_min072', 0.0220, 0.09, 0.72]
];

const VIEWS = [
  ['asia', `g.yaw = g.toYaw(78); g.pitch = 22*Math.PI/180;`],
  ['eu', `g.yaw = g.toYaw(12); g.pitch = 48*Math.PI/180;`]
];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(1500);
  // 关掉自转带来的不确定性（新版本来就没有，这里只是保险）
  await ev(`(function(){var g=GlobeTV.globe; g.target=null; g.vel.x=0; g.vel.y=0; return 1;})()`);

  const out = [];
  for (const [name, base, exp, min] of CANDS) {
    await ev(`(function(){var g=GlobeTV.globe;
      g.dot = {base:${base}, head:${(base * 1.45).toFixed(4)}, ref:46, exp:${exp}, min:${min}, max:1.0};
      g.buildMarkers(g.byCountry); return 1;})()`);
    await sleep(500);
    for (const [view, js] of VIEWS) {
      await ev(`(function(){var g=GlobeTV.globe; ${js} g.group.rotation.set(g.pitch,g.yaw,0); g.group.updateMatrixWorld(); return 1;})()`);
      await sleep(700);
      await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
      await sleep(300);
      await shot(`d_${name}_${view}`);
      await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 0`);
      await sleep(300);
      await shot(`d_${name}_${view}_off`);
      await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
    }
    out.push(name);
  }
  console.log('DONE ' + JSON.stringify(out));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
