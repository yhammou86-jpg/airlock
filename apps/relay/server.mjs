/**
 * Airlock relay — a dumb, room-scoped pipe between one device and its
 * controllers. Deploy free on Deno Deploy, Render, Fly.io or Railway; run
 * locally with `node apps/relay/server.mjs`.
 *
 * It never inspects payloads beyond routing metadata and never stores files.
 *
 * Endpoints
 *   GET  /health                 -> { ok, rooms, version }
 *   POST /api/pair               -> create a room: { code, room, token, expiresAt }
 *   POST /api/pair/claim {code}  -> { room, token }  (single use, 10 min TTL)
 *   WS   /ws?room=&token=&role=device|controller
 */
import http from 'node:http';
import os from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8788);
const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_FRAME = 2 * 1024 * 1024;
const IDLE_MS = 90 * 1000;

const rooms = new Map(); // roomId -> { token, device, controllers:Set, lastDeviceHello, createdAt }
const codes = new Map(); // code -> { room, token, expiresAt }

function roomId() { return randomBytes(9).toString('base64url'); }
function token() { return randomBytes(24).toString('base64url'); }
function code6() {
  // avoid leading zero readability complaints, still 000000-999999
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      version: 1,
      rooms: rooms.size,
      waiting: [...rooms.values()].filter((r) => r.device).length,
      uptime: Math.round(process.uptime()),
      host: os.hostname(),
    });
  }

  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const body = await readBody(req);
    const id = roomId();
    const tok = token();
    let c = code6();
    while (codes.has(c)) c = code6();
    const expiresAt = Date.now() + PAIR_TTL_MS;
    rooms.set(id, {
      token: tok,
      device: null,
      controllers: new Set(),
      lastDeviceHello: null,
      name: String(body.name || 'Android device').slice(0, 80),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
    codes.set(c, { room: id, token: tok, expiresAt });
    return json(res, 200, { code: c, room: id, token: tok, expiresAt });
  }

  if (url.pathname === '/api/pair/claim' && req.method === 'POST') {
    const body = await readBody(req);
    const entry = codes.get(String(body.code || '').trim());
    if (!entry || entry.expiresAt < Date.now()) {
      return json(res, 404, { error: 'unknown_or_expired_code' });
    }
    codes.delete(String(body.code).trim()); // single use
    return json(res, 200, { room: entry.room, token: entry.token });
  }

  return json(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const room = url.searchParams.get('room') || '';
  const tok = url.searchParams.get('token') || '';
  const role = url.searchParams.get('role') || 'controller';
  const entry = rooms.get(room);
  if (!entry || entry.token !== tok || !['device', 'controller'].includes(role)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.room = room;
    ws.role = role;
    wss.emit('connection', ws, req);
  });
});

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, fromRole, payload, isBinary) {
  const entry = rooms.get(room);
  if (!entry) return;
  if (fromRole === 'device') {
    for (const c of entry.controllers) {
      if (c.readyState === c.OPEN) c.send(payload, { binary: isBinary });
    }
  } else if (entry.device && entry.device.readyState === entry.device.OPEN) {
    entry.device.send(payload, { binary: isBinary });
  }
}

function notifyPeer(room) {
  const entry = rooms.get(room);
  if (!entry) return;
  if (entry.device && entry.controllers.size > 0) {
    for (const c of entry.controllers) send(c, { v: 1, type: 'relay.peer.joined', ts: Date.now(), data: { role: 'device' } });
    send(entry.device, { v: 1, type: 'relay.peer.joined', ts: Date.now(), data: { role: 'controller', count: entry.controllers.size } });
  } else {
    if (entry.device) send(entry.device, { v: 1, type: 'relay.peer.left', ts: Date.now(), data: { role: 'controller' } });
    for (const c of entry.controllers) send(c, { v: 1, type: 'relay.peer.left', ts: Date.now(), data: { role: 'device' } });
  }
}

wss.on('connection', (ws) => {
  const entry = rooms.get(ws.room);
  if (!entry) { ws.close(1008, 'room gone'); return; }

  if (ws.role === 'device') {
    if (entry.device && entry.device.readyState === entry.device.OPEN) entry.device.close(4001, 'replaced');
    entry.device = ws;
  } else {
    if (entry.controllers.size >= 3) { ws.close(4029, 'room full'); return; }
    entry.controllers.add(ws);
    if (entry.lastDeviceHello) send(ws, entry.lastDeviceHello);
  }
  entry.lastActivity = Date.now();
  send(ws, { v: 1, type: 'relay.welcome', ts: Date.now(), data: { role: ws.role, room: ws.room, name: entry.name } });
  notifyPeer(ws.room);

  ws.on('message', (data, isBinary) => {
    const e = rooms.get(ws.room);
    if (!e) return;
    e.lastActivity = Date.now();
    if (!isBinary) {
      // cache the device's hello so a controller that joins later is oriented
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        if (ws.role === 'device' && parsed && parsed.type === 'hello') e.lastDeviceHello = parsed;
      } catch { /* not our business */ }
    }
    broadcast(ws.room, ws.role, data, isBinary);
  });

  ws.on('close', () => {
    const e = rooms.get(ws.room);
    if (!e) return;
    if (ws.role === 'device') { if (e.device === ws) e.device = null; }
    else e.controllers.delete(ws);
    notifyPeer(ws.room);
  });

  ws.on('error', () => {});
});

// Reap idle rooms and expired codes.
setInterval(() => {
  const now = Date.now();
  for (const [c, v] of codes) if (v.expiresAt < now) codes.delete(c);
  for (const [id, r] of rooms) {
    const empty = !r.device && r.controllers.size === 0;
    if (empty && now - r.lastActivity > PAIR_TTL_MS) rooms.delete(id);
  }
  wss.clients.forEach((ws) => {
    if (Date.now() - (ws.lastSeen || Date.now()) > IDLE_MS) ws.terminate();
  });
}, 30 * 1000).unref?.();

wss.on('connection', (ws) => {
  ws.on('pong', () => { ws.lastSeen = Date.now(); });
});
setInterval(() => {
  wss.clients.forEach((ws) => { try { ws.ping(); } catch {} });
}, 25 * 1000).unref?.();

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}  health=http://localhost:${PORT}/health`);
});
