// Harness: servidor de teste + proxy com banda/latência ajustáveis + 2 Firefox gravando a posição do vídeo.
const net = require('net'), { spawn, execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
const { firefox } = require('playwright');
const APP = path.join(__dirname, '..');
// O vídeo de teste não fica no repositório: passe um MP4 (H.264) de pelo menos 26 minutos em VIDEO=/caminho/ep.mp4
const VIDEO = process.env.VIDEO;
if (!VIDEO || !fs.existsSync(VIDEO)) { console.error('Defina VIDEO=/caminho/para/um.mp4'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function proxy(lp, tp, net_) { // net_ = { kbps, lat } mutável
  return net.createServer((c) => {
    const s = net.connect(tp, '127.0.0.1');
    c.on('data', (d) => setTimeout(() => s.writable && s.write(d), net_.lat));
    let q = [], busy = false;
    s.on('data', (d) => { for (let i = 0; i < d.length; i += 8192) q.push(d.subarray(i, i + 8192)); if (q.length > 8) s.pause(); pump(); });
    function pump() {
      if (busy) return; const d = q.shift(); if (!d) return; if (q.length < 4) s.resume(); busy = true;
      setTimeout(() => { c.writable && c.write(d); }, net_.lat);
      setTimeout(() => { busy = false; pump(); }, d.length / (net_.kbps * 125) * 1000);
    }
    const kill = () => { c.destroy(); s.destroy(); };
    s.on('end', () => setTimeout(() => c.end(), net_.lat + 50)); s.on('error', kill); c.on('error', kill); c.on('close', kill);
  }).listen(lp);
}

const RECORDER = `(() => {
  window.__log = []; const t0 = Date.now(); const L = (k, d) => window.__log.push([Date.now() - t0, k, d]);
  window.__L = L;
  const WS = window.WebSocket;
  window.WebSocket = function (u) { const w = new WS(u); const send = w.send.bind(w);
    w.send = (x) => { try { const m = JSON.parse(x); if (m.type !== 'sync') L('TX', x); } catch {} send(x); };
    w.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (!m.reply && m.type !== 'count') L('RX', e.data); } catch {} });
    return w; };
  window.WebSocket.prototype = WS.prototype;
  let last = null;
  setInterval(() => { const v = document.getElementById('v'); if (!v || !v.src) return;
    const t = v.currentTime; if (last !== null && t < last - 0.3) L('BACK', last.toFixed(2) + ' -> ' + t.toFixed(2));
    if (last !== null && t > last + 1.2) L('FWD', last.toFixed(2) + ' -> ' + t.toFixed(2));
    last = t; }, 200);
  document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('v');
    ['play','pause','seeking','seeked','waiting','playing','stalled'].forEach((e) => v.addEventListener(e, () => L('ev', e + ' @' + v.currentTime.toFixed(2) + ' rs' + v.readyState))); });
})();`;

async function setup({ autoplay = true, port = 3101 } = {}) {
  const up = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wp-up-'));
  const srv = spawn('node', [APP + '/server.js'], { env: { ...process.env, PORT: port, UPLOADS: up }, stdio: ['ignore', 'pipe', 'inherit'] });
  const slow = { kbps: 3000, lat: 40 };
  const px = proxy(port + 1, port, slow);
  await sleep(600);
  const room = 'test' + Math.random().toString(36).slice(2, 8);
  execFileSync('curl', ['-s', '-X', 'POST', '-H', 'X-Filename: ep.mp4', '--data-binary', '@' + VIDEO, `http://127.0.0.1:${port}/upload/${room}`]);
  const browser = await firefox.launch({ headless: true, firefoxUserPrefs: autoplay ? { 'media.autoplay.default': 0, 'media.volume_scale': '0.0' } : { 'media.autoplay.default': 5, 'media.autoplay.blocking_policy': 0, 'media.autoplay.block-webaudio': true } });
  const mk = async (name, p) => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.addInitScript(`localStorage.setItem('wp-nick', '${name}');` + RECORDER);
    // Simula o bloqueio de play automático: play() falha até a pessoa clicar em algo na página.
    if (!autoplay && name === 'Amigo') await page.addInitScript(`(() => { const o = HTMLMediaElement.prototype.play; let ok = false;
      document.addEventListener('click', () => { ok = true; }, true);
      HTMLMediaElement.prototype.play = function () { return ok ? o.call(this) : Promise.reject(new DOMException('bloqueado', 'NotAllowedError')); }; })();`);
    page.on('pageerror', (e) => console.log(name, 'PAGEERROR', e.message));
    await page.goto(`http://127.0.0.1:${p}/r/${room}`);
    return page;
  };
  const A = await mk('Host', port), B = await mk('Amigo', port + 1);
  const pos = async (p) => p.evaluate(() => { const v = document.getElementById('v'); return { t: +v.currentTime.toFixed(2), p: v.paused, rs: v.readyState, sk: v.seeking, w: document.getElementById('wait').classList.contains('hidden') ? '' : 'W' }; });
  const watch = async (secs, label = '') => {
    for (let i = 0; i < secs; i++) { await sleep(1000); const [a, b] = await Promise.all([pos(A), pos(B)]);
      console.log(`${label.padEnd(10)} A ${String(a.t).padStart(8)} ${a.p ? 'P' : '>'}${a.w} | B ${String(b.t).padStart(8)} ${b.p ? 'P' : '>'}${b.w} rs${b.rs}${b.sk ? ' seeking' : ''} | diff ${(a.t - b.t).toFixed(2)}`); }
  };
  const logs = async (filter) => {
    for (const [n, p] of [['A', A], ['B', B]]) {
      const l = await p.evaluate(() => window.__log);
      for (const [t, k, d] of l) if (!filter || filter(k, d)) console.log(n, (t / 1000).toFixed(2).padStart(7), k, String(d).slice(0, 150));
    }
  };
  const summary = async () => {
    const out = {};
    for (const [n, p] of [['A', A], ['B', B]]) { const l = await p.evaluate(() => window.__log);
      out[n] = { back: l.filter((x) => x[1] === 'BACK').length, fwd: l.filter((x) => x[1] === 'FWD').length, tx: l.filter((x) => x[1] === 'TX').map((x) => JSON.parse(x[2]).type).join(',') }; }
    return out;
  };
  const close = async () => { await browser.close(); srv.kill(); px.close(); fs.rmSync(up, { recursive: true, force: true }); };
  return { A, B, slow, watch, logs, summary, close, sleep, pos };
}
module.exports = { setup, sleep };
