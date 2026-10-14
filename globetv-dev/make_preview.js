/* 生成预览图：默认视角 / 欧洲密区 / 太平洋（验证没有亮点落海）/ 浅色主题
   用法：node make_preview.js <URL> */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.argv[2];
// 直接产出 README 引用的配图（英文名 + JPEG，体积小、GitHub 加载快）
const PREV = path.join(__dirname, '..', 'docs', 'images') + path.sep;
fs.mkdirSync(PREV, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 9510;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-pv-'));
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 84, fromSurface: true });
  const p = PREV + name + '.jpg';
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wq.has(m.id)) { const w = wq.get(m.id); wq.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  // 1200x675：够清晰，且 6 张合计不到 1MB（1600 宽会翻倍）
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 675, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(2200);

  async function view(lon, lat, dist) {
    await ev(`(function(){var g=GlobeTV.globe; g.target=null; g.vel.x=0; g.vel.y=0; g.idle=-1e9;
      g.dist=${dist}; g.yaw=g.toYaw(${lon}); g.pitch=${lat}*Math.PI/180;
      g.group.rotation.set(g.pitch,g.yaw,0); g.group.updateMatrixWorld(); return 1;})()`);
    await sleep(900);
  }

  const out = [];
  await view(20, 22, 3.1);
  out.push(await shot('01-globe-dark'));
  await view(12, 48, 1.9);
  out.push(await shot('02-europe-markers'));
  await view(-150, 5, 2.6);
  out.push(await shot('03-pacific-clean'));

  // 浅色主题
  await ev(`document.getElementById('btn-theme').click()`);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const ok = await ev(`(function(){var u=GlobeTV.globe.earthMat.uniforms.uMap.value;
      return !!(u && /earth-light/.test(String(u.image.currentSrc||u.image.src)) && u.image.complete);})()`).catch(() => false);
    if (ok) break;
  }
  await view(20, 22, 3.1);
  out.push(await shot('04-light-theme'));

  // 回深色，抓新功能：更新弹窗 + 全屏控制条
  await ev(`document.getElementById('btn-theme').click()`);
  await sleep(1600);
  await ev(`localStorage.setItem('globetv.seenVersion','"2026-10-01.0"')`);
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 110; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV&&GlobeTV.globe&&GlobeTV.globe.markerCount&&!document.getElementById("boot"))')) break; } catch (e) { }
  }
  await sleep(3200);
  out.push(await shot('05-changelog'));
  await ev(`document.getElementById('upd-close').click()`);
  await sleep(500);

  // 全屏控制条：先播一个频道，再用真实鼠标点全屏按钮
  const t = JSON.parse(await ev(`(function(){
    var g=GlobeTV.globe,best=null;
    for(var i=0;i<g.markerCount;i++){
      var v=g._tmp2.set(g.pos[i*3],g.pos[i*3+1],g.pos[i*3+2]).applyMatrix4(g.group.matrixWorld);
      var cx=g.camera.position.x-v.x,cy=g.camera.position.y-v.y,cz=g.camera.position.z-v.z;
      if(v.x*cx+v.y*cy+v.z*cz<=0.3) continue;
      var p=v.clone().project(g.camera);
      var sx=(p.x*0.5+0.5)*innerWidth,sy=(-p.y*0.5+0.5)*innerHeight;
      if(sx<320||sx>innerWidth-320||sy<220||sy>innerHeight-340) continue;
      var m=g.meta[i]; if(!best||m.total>best.total) best={x:sx,y:sy};
    } return JSON.stringify(best);})()`));
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(t.x),y:Math.round(t.y),button:'none',buttons:0,pointerType:'mouse'});
  await sleep(300);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:Math.round(t.x),y:Math.round(t.y),button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:Math.round(t.x),y:Math.round(t.y),button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  await sleep(5000);
  const fsb = JSON.parse(await ev(`(function(){var r=document.getElementById('p-fs').getBoundingClientRect();
    return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]);})()`));
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:fsb[0],y:fsb[1],button:'none',buttons:0,pointerType:'mouse'});
  await sleep(200);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:fsb[0],y:fsb[1],button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:fsb[0],y:fsb[1],button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
  await sleep(2200);
  // 鼠标移出中央 → 控制条淡入、中央保持干净
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(innerWidthSafe(0.35)),y:300,button:'none',buttons:0,pointerType:'mouse'});
  function innerWidthSafe(r){ return 1600*r; }
  await sleep(500);
  out.push(await shot('06-fullscreen'));
  console.log(JSON.stringify({ fullscreen: await ev('!!document.fullscreenElement'),
    ctlOpacity: await ev(`+getComputedStyle(document.getElementById('p-fsctl')).opacity`),
    bigplay: await ev(`+getComputedStyle(document.getElementById('p-bigplay')).opacity`) }));

  console.log(JSON.stringify(out, null, 0));
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
