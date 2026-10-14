/* 定位测试：把地球转到已知经纬度，读取屏幕中心像素与周边亮点数量 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:8777/index.html';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-geo-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--ignore-certificate-errors', '--window-size=1000,700', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const waiting = new Map();
function send(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const HELPER = `
window.__geo = function(lat, lon, dist){
  var g = window.GlobeTV.globe;
  g.target = null; g.vel.x = 0; g.vel.y = 0; g.idle = -1e9;
  g.dist = dist || 1.65;
  g.yaw = g.toYaw(lon); g.pitch = lat * Math.PI / 180;
  g.group.rotation.set(g.pitch, g.yaw, 0);
  g.group.updateMatrixWorld(true);
  g.camera.position.z = g.dist;
  g.camera.lookAt(0,0,0);
  g.camera.updateMatrixWorld(true);
  var gl = g.renderer.getContext();
  var W = g.renderer.domElement.width, H = g.renderer.domElement.height;
  function grab(){
    var l = g.renderer.domElement.width;
    var b = new Uint8Array(W*H*4);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);
    return b;
  }
  // 亮点关闭
  g.markMat.uniforms.uOpacity.value = 0;
  g.renderer.render(g.scene, g.camera);
  var off = grab();
  // 亮点打开
  g.markMat.uniforms.uOpacity.value = 1;
  g.renderer.render(g.scene, g.camera);
  var on = grab();
  // 统计差异像素
  var changed = 0, centre = 0, maxAdd = 0, sumAdd = 0;
  var R = 130;                      // 中心 ±130px 视为"该国家区域"
  var cx = W/2, cy = H/2;
  for (var y=0;y<H;y++){
    for (var x=0;x<W;x++){
      var i = (y*W+x)*4;
      var d1 = on[i+1]-off[i+1];
      if (d1 > 10){ changed++; sumAdd += d1; if (d1>maxAdd) maxAdd=d1;
        if (Math.abs(x-cx)<R && Math.abs(y-cy)<R) centre++; }
    }
  }
  var buf = new Uint8Array(4);
  gl.readPixels(Math.floor(W/2), Math.floor(H/2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { px:[buf[0],buf[1],buf[2]], changed: changed, centre: centre,
           maxAdd: maxAdd, avgAdd: changed? Math.round(sumAdd/changed):0, canvas:[W,H] };
};
`;

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
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { if (await evaluate('!!(window.GlobeTV && GlobeTV.globe && GlobeTV.globe.markerCount)')) break; } catch (e) { }
  }
  await evaluate(HELPER);

  const targets = [
    ['Sahara 撒哈拉', 23, 13, 'land'],
    ['Amazon 亚马逊', -5, -62, 'land'],
    ['Siberia 西伯利亚', 63, 100, 'land'],
    ['Australia 澳洲内陆', -25, 133, 'land'],
    ['Greenland 格陵兰', 72, -42, 'land'],
    ['Pacific 太平洋', 0, -140, 'ocean'],
    ['Atlantic 大西洋', 0, -30, 'ocean'],
    ['Indian Ocean 印度洋', -25, 80, 'ocean'],
    ['Antarctic 南极', -75, 0, 'land'],
    ['North Sea 北海', 56, 3, 'ocean']
  ];
  console.log('place                     lat   lon   centerRGB        lum   dotPixels  inCentre  maxAdd');
  const rows = [];
  for (const [name, la, lo, kind] of targets) {
    const r = await evaluate(`JSON.stringify(__geo(${la},${lo},1.65))`);
    const d = JSON.parse(r);
    const lum = Math.round((d.px[0] + d.px[1] + d.px[2]) / 3);
    rows.push({ name, la, lo, kind, lum, dots: d.changed, centre: d.centre, maxAdd: d.maxAdd, canvas: d.canvas });
    console.log(name.padEnd(22), String(la).padStart(5), String(lo).padStart(6), ' ', JSON.stringify(d.px).padEnd(18), String(lum).padStart(4), String(d.changed).padStart(9), String(d.centre).padStart(10), String(d.maxAdd).padStart(7));
  }
  const land = rows.filter(r => r.kind === 'land');
  const ocean = rows.filter(r => r.kind === 'ocean');
  const avg = a => Math.round(a.reduce((s, r) => s + r.lum, 0) / a.length);
  console.log('--- land avg lum', avg(land), ' ocean avg lum', avg(ocean), ' -> ', avg(land) > avg(ocean) + 10 ? 'PASS 贴图经纬定位正确' : 'FAIL 贴图错位');

  // 亮点定位：转到有频道的国家，中心附近应出现亮点；转到无频道海域应几乎为 0
  const dotTest = [
    ['美国 US', 39, -98], ['中国 CN', 35, 105], ['巴西 BR', -10, -52], ['太平洋中部', 0, -140], ['南大西洋', -30, -15]
  ];
  console.log('--- 亮点定位 (dist 1.5, 中心±70px) ---');
  for (const [name, la, lo] of dotTest) {
    const r = await evaluate(`JSON.stringify(__geo(${la},${lo},1.5))`);
    const d = JSON.parse(r);
    console.log(name.padEnd(14), 'dotPixels=', String(d.changed).padStart(6), ' 中心±130px=', String(d.centre).padStart(6), ' 最亮增益=', String(d.maxAdd).padStart(4), ' canvas=', d.canvas.join('x'));
  }
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
