const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const UPLOADS = process.env.UPLOADS || path.join(__dirname, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(UPLOADS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.vtt': 'text/vtt; charset=utf-8',
};

// rooms: id -> { videoExt, videoName, subs: bool, state, clients:Set }
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { video: null, videoName: null, vid: 0, sub: false, state: { playing: false, time: 0, at: Date.now() }, clients: new Set(), waiting: new Map() });
  }
  return rooms.get(id);
}
const validId = (id) => /^[a-z0-9]{4,32}$/.test(id);
// Vídeos já enviados continuam valendo depois de reiniciar o servidor.
for (const f of fs.readdirSync(UPLOADS)) {
  const m = /^([a-z0-9]{4,32})\.(mp4|m4v|webm|mkv|vtt)$/.exec(f);
  if (!m) continue;
  const room = getRoom(m[1]);
  if (m[2] === 'vtt') room.sub = true;
  else { room.video = path.join(UPLOADS, f); room.videoName = f; room.vid = 1; }
}

// state.playing é a intenção do grupo; o relógio só corre se ninguém estiver carregando (waiting vazio).
function currentTime(room) {
  const s = room.state;
  return s.playing && room.waiting.size === 0 ? s.time + (Date.now() - s.at) / 1000 : s.time;
}
// Congela o relógio no instante atual; chamar antes de mudar room.waiting ou state.playing.
function freeze(room) { room.state = { ...room.state, time: currentTime(room), at: Date.now() }; }
function effective(room) {
  return {
    playing: room.state.playing && room.waiting.size === 0,
    time: currentTime(room),
    waiting: [...room.waiting.keys()].map((c) => c.nick),
  };
}
function pushState(room, extra = {}) { broadcast(room, { type: 'state', state: effective(room), ...extra }); }

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');
}

// Move o índice do MP4 (moov) para o início, para o navegador começar a tocar sem baixar o fim do arquivo.
// Sem ffmpeg, ou se falhar, segue com o arquivo original.
function faststart(file, ext, done) {
  if (!['.mp4', '.m4v'].includes(ext)) return done();
  const out = file + '.fs.mp4';
  execFile('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out], (err) => {
    if (err) { fs.unlink(out, () => {}); return done(); }
    fs.rename(out, file, () => done());
  });
}

function sendFile(req, res, file, type) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== except && c.readyState === 1) c.send(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;

  if (req.method === 'GET' && p === '/new') {
    const id = crypto.randomBytes(4).toString('hex');
    res.writeHead(302, { Location: '/r/' + id }); return res.end();
  }
  if (req.method === 'GET' && /^\/r\/[a-z0-9]+$/.test(p)) return sendFile(req, res, path.join(PUBLIC, 'room.html'), MIME['.html']);

  if ((m = /^\/upload\/([a-z0-9]+)$/.exec(p)) && req.method === 'POST') {
    if (!validId(m[1])) { res.writeHead(400); return res.end(); }
    const room = getRoom(m[1]);
    const kind = url.searchParams.get('kind') === 'sub' ? 'sub' : 'video';
    const name = decodeURIComponent(req.headers['x-filename'] || 'video.mp4');
    const ext = path.extname(name).toLowerCase();
    if (kind === 'video' && !['.mp4', '.m4v', '.webm', '.mkv'].includes(ext)) { res.writeHead(400); return res.end('formato nao suportado'); }
    if (kind === 'sub' && !['.srt', '.vtt'].includes(ext)) { res.writeHead(400); return res.end('formato nao suportado'); }
    const dest = path.join(UPLOADS, m[1] + (kind === 'sub' ? '.vtt' : ext));
    const tmp = dest + '.part';
    if (kind === 'sub') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let txt = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
        if (ext === '.srt') txt = srtToVtt(txt);
        fs.writeFileSync(dest, txt);
        room.sub = true;
        broadcast(room, { type: 'sub' });
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => faststart(tmp, ext, () => {
      if (room.video && room.video !== dest) fs.unlink(room.video, () => {});
      fs.renameSync(tmp, dest);
      room.video = dest; room.videoName = name; room.vid++;
      room.waiting.clear();
      room.state = { playing: false, time: 0, at: Date.now() };
      broadcast(room, { type: 'video', name, ext, vid: room.vid, state: effective(room) });
      res.writeHead(200); res.end('ok');
    }));
    req.on('aborted', () => { out.destroy(); fs.unlink(tmp, () => {}); });
    return;
  }

  if ((m = /^\/video\/([a-z0-9]+)$/.exec(p))) {
    const room = rooms.get(m[1]);
    if (!room || !room.video) { res.writeHead(404); return res.end(); }
    return sendFile(req, res, room.video, MIME[path.extname(room.video)] || 'video/mp4');
  }
  if ((m = /^\/sub\/([a-z0-9]+)$/.exec(p))) {
    return sendFile(req, res, path.join(UPLOADS, m[1] + '.vtt'), MIME['.vtt']);
  }

  // static
  const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  sendFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream');
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const id = new URL(req.url, 'http://x').searchParams.get('room') || '';
  if (!validId(id)) return ws.close();
  const room = getRoom(id);
  room.clients.add(ws);
  ws.nick = 'Anônimo';
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const sendCount = () => broadcast(room, { type: 'count', n: room.clients.size });

  ws.send(JSON.stringify({
    type: 'init', id: ws.id, hasVideo: !!room.video, name: room.videoName, vid: room.vid,
    ext: room.video ? path.extname(room.video) : null, sub: room.sub, state: effective(room),
  }));
  sendCount();

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'nick') { ws.nick = String(msg.nick || '').slice(0, 20) || 'Anônimo'; return; }
    if (msg.type === 'chat') { broadcast(room, { type: 'chat', nick: ws.nick, text: String(msg.text || '').slice(0, 500) }); return; }
    if (msg.type === 'sync') { ws.send(JSON.stringify({ type: 'state', reply: msg.t, state: effective(room) })); return; }
    if (msg.type === 'buffering') {
      if (!room.waiting.has(ws)) { freeze(room); room.waiting.set(ws, Date.now()); pushState(room); }
      else room.waiting.set(ws, Date.now());
      return;
    }
    if (msg.type === 'ready') {
      if (room.waiting.has(ws)) { freeze(room); room.waiting.delete(ws); pushState(room); }
      return;
    }
    // O relógio é do servidor: play e pause valem a partir da posição dele, nunca da posição de quem clicou.
    // Assim, alguém atrasado ou adiantado não arrasta o grupo junto ao pausar ou dar play.
    if (msg.type === 'play' || msg.type === 'pause') {
      const want = msg.type === 'play';
      if (room.state.playing === want) { ws.send(JSON.stringify({ type: 'state', ack: true, state: effective(room) })); return; }
      freeze(room);
      room.state = { ...room.state, playing: want };
      broadcast(room, { type: msg.type, from: ws.id, nick: ws.nick, time: room.state.time, state: effective(room) });
      return;
    }
    // Só o pulo usa a posição enviada por quem pulou.
    if (msg.type === 'seek') {
      const time = Math.max(0, Number(msg.time));
      if (!Number.isFinite(time)) return;
      room.state = { playing: room.state.playing, time, at: Date.now() };
      broadcast(room, { type: 'seek', from: ws.id, nick: ws.nick, n: msg.n, time, state: effective(room) });
    }
  });
  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.waiting.has(ws)) { freeze(room); room.waiting.delete(ws); pushState(room); }
    sendCount();
  });
});

// Quem trava carregando por mais de 30s não segura o grupo; conexões mortas são derrubadas.
setInterval(() => {
  for (const room of rooms.values()) {
    const stale = [...room.waiting].filter(([, t]) => Date.now() - t > 30000);
    if (stale.length) { freeze(room); stale.forEach(([c]) => room.waiting.delete(c)); pushState(room); }
  }
  for (const c of wss.clients) { if (!c.alive) { c.terminate(); continue; } c.alive = false; c.ping(); }
}, 5000);

server.listen(PORT, '0.0.0.0', () => console.log(`Watch Party em http://localhost:${PORT}`));
