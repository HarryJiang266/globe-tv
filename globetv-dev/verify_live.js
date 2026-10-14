/* 线上链接：确认真的能解码出画面（不只是拿到播放列表） */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9338;
const URL = process.argv[2] || 'https://global-tv-globe.app.workbuddy.host/index.html';
const OUT = path.join(__dirname, '.shots') + path.sep;
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gvtv-live-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, seq = 0; const waiting = new Map(); const errors = [];
function send(m, p) {
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
}
function onMsg(raw) {
  const m = JSON.parse(raw);
  if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errors.push('CONSOLE ' + (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ').slice(0, 240));
}
async function ev(e, aw) {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!aw });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function shot(n) {
  const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(OUT + n + '.png', Buffer.from(r.data, 'base64'));
}

(async () => {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) { const l = await r.json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } } catch (e) { }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => onMsg(e.data);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    try { if (await ev('!!(window.GlobeTV && GlobeTV.globe && GlobeTV.globe.markerCount) && !document.getElementById("boot")')) break; } catch (e) { }
  }
  console.log('首屏就绪耗时 %d ms', Date.now() - t0);
  await sleep(1200);

  // 依次试几个频道，直到有一个真正出画面
  const result = JSON.parse(await ev(`(async function(){
    var out=[], done=0;
    var names=['CCTV+ 1','Anhui TV','Baicheng TV','CCTV-4','Anshun Comprehensive News Channel'];
    for (var i=0;i<names.length;i++){
      var ch=null;
      for (var j=0;j<TV_DATA.channels.length;j++){ if(TV_DATA.channels[j].n===names[i]){ch=TV_DATA.channels[j];break;} }
      if(!ch) continue;
      GlobeTV.play(ch.i);
      var r = await new Promise(function(res){
        var t0=Date.now();
        var iv=setInterval(function(){
          var v=document.getElementById('video');
          if(v.videoWidth>0 && v.readyState>=2){ clearInterval(iv); res({w:v.videoWidth,h:v.videoHeight,ms:Date.now()-t0,state:'playing'}); return; }
          var m=document.getElementById('p-msg');
          if(!m.hidden && /暂时播不了|只有明文线路/.test(m.textContent)){ clearInterval(iv); res({state:'failed',why:m.textContent.slice(0,40),ms:Date.now()-t0}); return; }
          if(Date.now()-t0>22000){ clearInterval(iv); res({state:'timeout',ms:Date.now()-t0}); }
        },400);
      });
      out.push({name:names[i], lines:ch.s.length, https:ch._h, r:r});
      if(r.state==='playing'){ done=1; break; }
    }
    return JSON.stringify({tried:out.length, gotPicture:done, detail:out});
  })()`, true));

  console.log(JSON.stringify(result, null, 1));
  await shot('40_live_playback');
  console.log('控制台错误:', errors.length ? errors : '无');
  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e); try { proc.kill(); } catch (x) { } process.exit(1); });
