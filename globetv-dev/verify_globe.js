/* 地球可见性综合自检
   覆盖：① 深色球体亮度 ② 亮点在球面上的对比 ③ 浅色主题对比度
        ④ 贴图缺失时的兜底（不能是黑洞） ⑤ 贴图请求次数（应只发 1 次）
   用法：node tools/verify_globe.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let PORT = 9410;

async function session(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-vg-'));
  const port = ++PORT;
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}`,
    '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors',
    '--window-size=1920,1080', 'about:blank'
  ], { stdio: 'ignore' });
  let ws, seq = 0; const wq = new Map(); const errs = [];
  const texReq = [];
  function send(m, p) {
    const id = ++seq;
    return new Promise((res, rej) => { wq.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  }
  async function ev(e) {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result && r.result.value;
  }
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
    if (m.method === 'Network.requestWillBeSent' && /earth-(dark|light)\.jpg/.test(m.params.request.url)) texReq.push(m.params.request.url.split('/').pop());
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; errs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 150)); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 150));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  if (opts.blockTex) await send('Network.setBlockedURLs', { urls: ['*earth-dark.jpg*', '*earth-light.jpg*'] });
  await send('Page.navigate', { url: URL });

  let ready = false;
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) { ready = true; break; } } catch (e) { }
  }
  if (!ready) { console.log('   页面未就绪', errs.slice(0, 3)); }
  if (opts.light) {
    await ev(`document.getElementById('btn-theme').click()`);
    for (let i = 0; i < 70; i++) {
      await sleep(400);
      const ok = await ev(`(function(){var u=GlobeTV.globe.earthMat.uniforms.uMap.value;
        return !!(u && /earth-light/.test(String(u.image.currentSrc||u.image.src)) && u.image.complete);})()`).catch(() => false);
      if (ok) break;
    }
  }
  await ev(`(function(){var g=GlobeTV.globe; g.idle=-1e9; g.vel.x=0; g.vel.y=0; g.target=null;
    g.yaw=g.toYaw(${opts.lon !== undefined ? opts.lon : 20}); g.pitch=${opts.lat !== undefined ? opts.lat : 20}*Math.PI/180; return 1;})()`);
  await sleep(1000);
  const state = JSON.parse(await ev(`(function(){var g=GlobeTV.globe;var u=g.earthMat.uniforms.uMap.value;
    return JSON.stringify({hasMap: g.earthMat.uniforms.uHasMap.value,
      map: u?String(u.image.currentSrc||u.image.src).split('/').pop():null,
      texReady: !!g.texReady, markers: g.markerCount, bootGone: !document.getElementById('boot')});})()`));

  async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(OUT + name + '.png', Buffer.from(r.data, 'base64'));
  }
  let diff = null;
  if (opts.abMarkers) {
    await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 0`);
    await sleep(500); await shot(opts.name + '_nomark');
    await ev(`GlobeTV.globe.markMat.uniforms.uOpacity.value = 1`);
    await sleep(500);
  }
  await shot(opts.name);
  if (opts.abMarkers) diff = opts.name + '_nomark';
  const out = { state, errs: [...new Set(errs)], texReq };
  try { proc.kill(); } catch (e) { }
  return { out, shot: OUT + opts.name + '.png', plain: diff ? OUT + diff + '.png' : null };
}

function report(f) {
  const { execSync } = require('child_process');
  return f;
}

(async () => {
  const A = await session({ name: '90_dark_africa', lon: 20, lat: 20, abMarkers: true });
  console.log('=== 深色（非洲视角）===');
  console.log('  ' + JSON.stringify(A.out.state));
  console.log('  贴图请求次数 ' + A.out.texReq.length + ' 次: ' + JSON.stringify(A.out.texReq));
  console.log('  错误: ' + (A.out.errs.length ? A.out.errs.join(' | ') : '无'));

  const B = await session({ name: '91_light_africa', lon: 20, lat: 20, light: true });
  console.log('=== 浅色（非洲视角）===');
  console.log('  ' + JSON.stringify(B.out.state));
  console.log('  错误: ' + (B.out.errs.length ? B.out.errs.join(' | ') : '无'));

  const C = await session({ name: '92_dark_pacific', lon: -140, lat: 0 });
  console.log('=== 深色（太平洋，全海）===');
  console.log('  ' + JSON.stringify(C.out.state));

  const D = await session({ name: '93_notexture', lon: 20, lat: 20, blockTex: true });
  console.log('=== 贴图被屏蔽（兜底测试）===');
  console.log('  ' + JSON.stringify(D.out.state));
  console.log('  错误: ' + (D.out.errs.length ? D.out.errs.slice(0, 2).join(' | ') : '无'));

  console.log();
  console.log(JSON.stringify({ dark: A.shot, darkNoMark: A.plain, light: B.shot, pacific: C.shot, noTex: D.shot }));
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
