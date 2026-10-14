/* 在真实页面上试多组亮点配色/混合方式，量化"哪些点还能看出是薄荷绿"。
   用法：node tools/tune_markers.js <URL> [light] */
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

const PORT = 9470;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-tm-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
  '--window-size=1920,1080', 'about:blank'
], { stdio: 'ignore' });
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const p = OUT + name + '.png';
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

// 候选方案：mark=光晕色, hot=芯色, blend=0 加法 / 1 普通
const CANDS = [
  ['D1_加法_op90', 0, [0.26, 1.0, 0.46], [0.72, 1.0, 0.62], 0.90],
  ['D2_加法_op88', 0, [0.30, 1.0, 0.50], [0.85, 1.0, 0.75], 0.88],
  ['D3_加法_op92', 0, [0.24, 1.0, 0.42], [0.66, 1.0, 0.55], 0.92],
  ['D4_加法_op95', 0, [0.28, 1.0, 0.48], [0.80, 1.0, 0.68], 0.95],
  ['D5_加法_op85_绿芯', 0, [0.28, 1.0, 0.48], [0.62, 1.0, 0.50], 0.85]
];

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  if (LIGHT) {
    await ev(`document.getElementById('btn-theme').click()`);
    for (let i = 0; i < 70; i++) {
      await sleep(400);
      const ok = await ev(`(function(){var u=GlobeTV.globe.earthMat.uniforms.uMap.value;
        return !!(u && /earth-light/.test(String(u.image.currentSrc||u.image.src)) && u.image.complete);})()`).catch(() => false);
      if (ok) break;
    }
  }
  // 固定视角：非洲，点密集
  await ev(`(function(){var g=GlobeTV.globe; g.idle=-1e9; g.vel.x=0; g.vel.y=0; g.target=null;
    g.yaw=g.toYaw(20); g.pitch=20*Math.PI/180; return 1;})()`);
  await sleep(1000);

  // 基线：关掉亮点
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 0`);
  await sleep(600);
  const base = await shot(LIGHT ? 'tune_light_base' : 'tune_dark_base');

  const out = [];
  for (const [name, blend, mark, hot, op] of CANDS) {
    await ev(`(function(){
      var m = GlobeTV.globe.markMat;
      m.uniforms.uColor.value.set(${mark[0]},${mark[1]},${mark[2]});
      m.uniforms.uHot.value.set(${hot[0]},${hot[1]},${hot[2]});
      m.uniforms.uOpacity.value = ${op};
      m.blending = ${blend === 1 ? 'THREE.NormalBlending' : 'THREE.AdditiveBlending'};
      m.needsUpdate = true;
      return 1;})()`);
    await sleep(700);
    const f = await shot((LIGHT ? 'tune_light_' : 'tune_dark_') + name);
    out.push({ name, file: f, blend, mark, hot, op });
  }
  // 恢复
  await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
  console.log('BASE ' + base);
  console.log(JSON.stringify(out));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
