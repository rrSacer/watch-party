const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const UPLOADS = path.join(__dirname, 'uploads');
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
    rooms.set(id, { video: null, videoName: null, sub: false, state: { playing: false, time: 0, at: Date.now() }, clients: new Set() });
  }
  return rooms.get(id);
}
const validId = (id) => /^[a-z0-9]{4,32}$/.test(id);

function currentTime(s) {
  return s.playing ? s.time + (Date.now() - s.at) / 1000 : s.time;
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2');
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
    out.on('finish', () => {
      if (room.video && room.video !== dest) fs.unlink(room.video, () => {});
      fs.renameSync(tmp, dest);
      room.video = dest; room.videoName = name;
      room.state = { playing: false, time: 0, at: Date.now() };
      broadcast(room, { type: 'video', name, ext, state: room.state });
      res.writeHead(200); res.end('ok');
    });
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
  const state = () => ({ ...room.state, time: currentTime(room.state), at: Date.now() });
  const sendCount = () => broadcast(room, { type: 'count', n: room.clients.size });

  ws.send(JSON.stringify({
    type: 'init', hasVideo: !!room.video, name: room.videoName,
    ext: room.video ? path.extname(room.video) : null, sub: room.sub, state: state(),
  }));
  sendCount();

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'nick') { ws.nick = String(msg.nick || '').slice(0, 20) || 'Anônimo'; return; }
    if (msg.type === 'chat') { broadcast(room, { type: 'chat', nick: ws.nick, text: String(msg.text || '').slice(0, 500) }); return; }
    if (msg.type === 'sync') { ws.send(JSON.stringify({ type: 'state', state: state() })); return; }
    if (['play', 'pause', 'seek'].includes(msg.type)) {
      const time = Number(msg.time);
      if (!Number.isFinite(time)) return;
      const playing = msg.type === 'play' ? true : msg.type === 'pause' ? false : room.state.playing;
      room.state = { playing, time, at: Date.now() };
      broadcast(room, { type: msg.type, time, nick: ws.nick, state: room.state }, ws);
    }
  });
  ws.on('close', () => {
    room.clients.delete(ws);
    sendCount();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Watch Party em http://localhost:${PORT}`));
