/**
 * Airlock reference agent.
 *
 * A complete, dependency-light implementation of the device side of the
 * protocol. It is deliberately a *desktop* program so the whole product can be
 * exercised without a phone:
 *
 *   node apps/agent/agent.mjs --port 8787 --cloud ws://localhost:8788 --name "Pixel 8 (demo)"
 *
 * The Android app in apps/android implements exactly the same message set; see
 * docs/PROTOCOL.md. Everything this agent fakes (screen pixels, camera, SMS)
 * maps to a real Android API there.
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  FrameKind, Codec, encodeFrame, response, failure, event, CHUNK_BYTES,
} from '../../packages/protocol/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arguments
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PORT = Number(arg('port', process.env.PORT || 8787));
const SANDBOX = path.resolve(arg('dir', process.env.AIRLOCK_DIR || path.join(__dirname, 'sandbox')));
const NAME = String(arg('name', 'Airlock Demo Device'));
const LAN_CODE = String(arg('code', '123456'));
const CLOUD = arg('cloud', process.env.AIRLOCK_CLOUD || '');
const CLOUD_ROOM = arg('room', process.env.AIRLOCK_ROOM || '');
const CLOUD_TOKEN = arg('token', process.env.AIRLOCK_TOKEN || '');
const VERBOSE = !!arg('verbose', false);

const log = (...a) => console.log('[agent]', ...a);
const trace = (...a) => { if (VERBOSE) console.log('[agent:debug]', ...a); };

// ---------------------------------------------------------------- device state
const DEVICE_ID = 'demo-' + crypto.createHash('sha1').update(os.hostname() + SANDBOX).digest('hex').slice(0, 10);
const state = {
  battery: 87,
  charging: false,
  volume: 7,
  muted: false,
  flashlight: false,
  clipboard: 'Hello from Airlock 👋',
  media: 'paused',
  ripples: [],
  typed: '',
  lastAction: 'idle',
  silent: true,
  uptimeStart: Date.now(),
};

// Seed a sandbox the first time.
async function seed() {
  await fsp.mkdir(path.join(SANDBOX, 'Photos'), { recursive: true });
  await fsp.mkdir(path.join(SANDBOX, 'Documents'), { recursive: true });
  await fsp.mkdir(path.join(SANDBOX, 'Music'), { recursive: true });
  const files = {
    'welcome.txt': 'This folder is the demo device filesystem.\nEverything here is real: list, upload, download, rename, delete.\n',
    'Documents/notes.md': '# Notes\n\n- Pair from the dashboard with code 123456\n- Try dragging a file onto the Files view\n',
    'Photos/README.txt': 'Drop images here; they stream back over the download channel.\n',
    'Photos/welcome.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#0f2233"/><text x="40" y="200" font-family="system-ui" font-size="32" fill="#dcecff">Airlock preview</text></svg>\n',
    'Music/playlist.m3u': '#EXTM3U\n# Airlock demo playlist\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(SANDBOX, rel);
    if (!fs.existsSync(p)) await fsp.writeFile(p, body);
  }
}

// ---------------------------------------------------------------- helpers
function safeJoin(rel) {
  const norm = path.normalize(String(rel || '/')).replace(/^([/\\])+/, '');
  const abs = path.resolve(SANDBOX, norm);
  const base = path.resolve(SANDBOX);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('path outside sandbox');
  return abs;
}

function rel(abs) {
  const r = path.relative(SANDBOX, abs).split(path.sep).join('/');
  return '/' + (r || '');
}

function kindOf(name) {
  const ext = path.extname(name).toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (['zip', '7z', 'tar', 'gz', 'rar'].includes(ext)) return 'archive';
  if (['apk', 'aab'].includes(ext)) return 'apk';
  if (['md', 'txt', 'log', 'json', 'js', 'ts', 'kt', 'java', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'ini', 'csv'].includes(ext)) return 'document';
  return 'file';
}

async function listDir(p) {
  const abs = safeJoin(p);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    try {
      const st = await fsp.stat(path.join(abs, e.name));
      out.push({
        name: e.name,
        path: rel(path.join(abs, e.name)),
        dir: st.isDirectory(),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        kind: st.isDirectory() ? 'folder' : kindOf(e.name),
      });
    } catch { /* vanished */ }
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function storageInfo() {
  try {
    const s = fs.statfsSync(SANDBOX);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (total > 0) return { total, used: total - free, free };
  } catch { /* not available */ }
  return { total: 128 * 1024 ** 3, used: 41.2 * 1024 ** 3, free: 86.8 * 1024 ** 3 };
}

let lastCpu = os.cpus().map((c) => c.times);
let cpuAvg = null;
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0; let total = 0;
  now.forEach((t, i) => {
    const prev = lastCpu[i] || t;
    const di = t.idle - prev.idle;
    const dt = (t.user - prev.user) + (t.nice - prev.nice) + (t.sys - prev.sys) + (t.irq - prev.irq) + di;
    idle += di; total += dt;
  });
  lastCpu = now;
  if (total < 20) return Math.round(cpuAvg ?? 0);
  const sample = Math.max(0, Math.min(100, 100 * (1 - idle / total)));
  cpuAvg = cpuAvg === null ? sample : cpuAvg * 0.55 + sample * 0.45;
  return Math.round(cpuAvg);
}

function ipAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

// ---------------------------------------------------------------- fake data
const sms = [
  {
    id: 't1', name: 'Maya', address: '+1 555 0142', unread: 1,
    messages: [
      { id: 'm1', from: 'them', body: 'Did the demo build finish?', ts: Date.now() - 1000 * 60 * 42 },
      { id: 'm2', from: 'me', body: 'Yes — phone is online in the dashboard.', ts: Date.now() - 1000 * 60 * 40 },
      { id: 'm3', from: 'them', body: 'Perfect. Try sending me that PDF 📄', ts: Date.now() - 1000 * 60 * 3 },
    ],
  },
  {
    id: 't2', name: 'Bank OTP', address: 'VM-HDFCBK', unread: 0,
    messages: [
      { id: 'm4', from: 'them', body: '482913 is your one-time password. Valid 10 minutes. Do not share.', ts: Date.now() - 1000 * 60 * 90 },
    ],
  },
  {
    id: 't3', name: 'Ops Team', address: '+1 555 0199', unread: 2,
    messages: [
      { id: 'm5', from: 'them', body: 'Deploy is green. Relay p95 is 38ms.', ts: Date.now() - 1000 * 60 * 12 },
      { id: 'm6', from: 'them', body: 'Can you mirror the test phone?', ts: Date.now() - 1000 * 60 * 11 },
    ],
  },
];

const notifications = [
  { id: 'n1', app: 'Slack', title: '#airlock-eng', body: 'Sara: relay reconnect looks solid now', ts: Date.now() - 60000, canReply: true },
  { id: 'n2', app: 'Gmail', title: 'Vercel', body: 'Deployment completed for airlock-web', ts: Date.now() - 1000 * 60 * 8, canReply: false },
  { id: 'n3', app: 'WhatsApp', title: 'Maya', body: 'Sent you a photo', ts: Date.now() - 1000 * 60 * 22, canReply: true },
];

const apps = [
  { pkg: 'com.android.settings', name: 'Settings' },
  { pkg: 'com.android.chrome', name: 'Chrome' },
  { pkg: 'com.google.android.apps.photos', name: 'Photos' },
  { pkg: 'com.android.camera2', name: 'Camera' },
  { pkg: 'com.spotify.music', name: 'Spotify' },
  { pkg: 'com.slack', name: 'Slack' },
];

// ---------------------------------------------------------------- fake screen
function pad(n) { return String(n).padStart(2, '0'); }

function svgScreen() {
  const now = new Date();
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const W = 400; const H = 860;
  const charge = `${state.battery}%`;
  const ripples = state.ripples.map((r) => {
    const age = (Date.now() - r.ts) / 900;
    const rad = 8 + age * 70;
    const op = Math.max(0, 0.55 - age * 0.55);
    return `<circle cx="${(r.x * W).toFixed(1)}" cy="${(r.y * H).toFixed(1)}" r="${rad.toFixed(1)}" fill="none" stroke="#7fb2ff" stroke-width="3" opacity="${op.toFixed(2)}"/>`;
  }).join('');
  const tiles = apps.slice(0, 8).map((a, i) => {
    const x = 41 + (i % 4) * 84; const y = 300 + Math.floor(i / 4) * 96;
    const colors = ['#2a4a7f', '#24483b', '#4a3a24', '#44304f', '#28454a', '#4a2a33', '#2f3a55', '#3c4630'];
    return `<g>
      <rect x="${x}" y="${y}" width="56" height="56" rx="16" fill="${colors[i % 8]}"/>
      <text x="${x + 28}" y="${y + 35}" font-size="20" font-family="system-ui" fill="#dbe6ff" text-anchor="middle">${a.name[0]}</text>
      <text x="${x + 28}" y="${y + 74}" font-size="10" font-family="system-ui" fill="#93a3b8" text-anchor="middle">${a.name}</text>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#0e1826"/><stop offset="0.55" stop-color="#0b1119"/><stop offset="1" stop-color="#111a26"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.2" cy="0.1" r="0.8">
      <stop offset="0" stop-color="#1d3f6b" stop-opacity="0.75"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <text x="22" y="34" font-size="13" font-family="system-ui" fill="#cfe0ff">${hh}:${mm}</text>
  <text x="378" y="34" font-size="12" font-family="system-ui" fill="#9fb2c9" text-anchor="end">${charge} ▮</text>
  <text x="20" y="120" font-size="64" font-family="system-ui" font-weight="600" fill="#f2f7ff">${hh}:${mm}</text>
  <text x="22" y="150" font-size="13" font-family="system-ui" fill="#8fa3ba">Mon, 16 Nov · ${ss}s · ${NAME}</text>

  <rect x="20" y="180" width="360" height="90" rx="20" fill="#142235" stroke="#20344d"/>
  <text x="38" y="210" font-size="12" font-family="system-ui" fill="#7f95ad">MIRRORED BY AIRLOCK</text>
  <text x="38" y="238" font-size="15" font-family="system-ui" fill="#dce8f8">Touch the stream to send input</text>
  <text x="38" y="258" font-size="12" font-family="system-ui" fill="#5f7c9c">last: ${state.lastAction}${state.typed ? ' · typed: "' + state.typed.slice(-18) + '"' : ''}</text>
  <circle cx="348" cy="225" r="9" fill="${state.flashlight ? '#ffd166' : '#243447'}"/>
  ${tiles}
  <rect x="20" y="520" width="360" height="132" rx="18" fill="#0f1a28" stroke="#1c2c40"/>
  <text x="38" y="548" font-size="11" font-family="system-ui" fill="#6f86a0">NOTIFICATIONS</text>
  <text x="38" y="574" font-size="13" font-family="system-ui" fill="#cfe0f6">${notifications[0].app}: ${notifications[0].title}</text>
  <text x="38" y="594" font-size="11" font-family="system-ui" fill="#8ba0b8">${notifications[0].body.slice(0, 44)}</text>
  <text x="38" y="622" font-size="11" font-family="system-ui" fill="#6f86a0">MEDIA ${state.media.toUpperCase()} · VOL ${state.muted ? 'MUTE' : state.volume}/15</text>
  <rect x="38" y="632" width="${Math.round((state.muted ? 0 : state.volume / 15) * 324)}" height="4" rx="2" fill="#4f8cff"/>
  <rect x="20" y="690" width="360" height="60" rx="30" fill="#101d2c" stroke="#1d2f44"/>
  <circle cx="60" cy="720" r="18" fill="#233a55"/>
  <circle cx="140" cy="720" r="18" fill="#233a55"/>
  <circle cx="260" cy="720" r="18" fill="#233a55"/>
  <circle cx="340" cy="720" r="18" fill="#233a55"/>
  <text x="200" y="790" font-size="10" font-family="system-ui" fill="#4d6785" text-anchor="middle">demo frame · ${now.toISOString().slice(11, 19)}</text>
  <text x="200" y="812" font-size="10" font-family="system-ui" fill="#31465e" text-anchor="middle">${DEVICE_ID} · ${ipAddress()}:${PORT}</text>
  ${ripples}
  </svg>`;
}

function svgPreview(name, size) {
  const label = String(name).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0f2233"/><stop offset="1" stop-color="#1b3a52"/>
  </linearGradient></defs>
  <rect width="640" height="480" fill="url(#p)"/>
  <rect x="24" y="24" width="592" height="432" rx="18" fill="none" stroke="#7fb2ff" stroke-opacity="0.3"/>
  <text x="48" y="112" font-family="system-ui" font-size="26" fill="#e6f1ff">${label}</text>
  <text x="48" y="152" font-family="monospace" font-size="16" fill="#8fb0d0">${size} B · preview rendered on the device</text>
  <text x="48" y="196" font-family="monospace" font-size="14" fill="#6f8ba8">the real agent sends a downscaled JPEG here</text>
  <circle cx="560" cy="112" r="42" fill="#7fb2ff" opacity="0.14"/>
  <circle cx="560" cy="112" r="26" fill="#7fb2ff" opacity="0.24"/>
  </svg>`;
}

function svgCamera(lens) {
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720">
  <defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#12263a"/><stop offset="0.5" stop-color="#1d4460"/><stop offset="1" stop-color="#0a1620"/>
  </linearGradient></defs>
  <rect width="720" height="720" fill="url(#c)"/>
  <circle cx="540" cy="180" r="90" fill="#f4f9ff" opacity="0.14"/>
  <circle cx="540" cy="180" r="58" fill="#f4f9ff" opacity="0.25"/>
  <rect x="30" y="30" width="660" height="660" fill="none" stroke="#7fb2ff" stroke-opacity="0.35" stroke-width="2"/>
  <text x="56" y="86" font-family="monospace" font-size="22" fill="#dcecff">${lens.toUpperCase()} CAMERA</text>
  <text x="56" y="120" font-family="monospace" font-size="16" fill="#8fb0d0">${t} · 4032×3024 · ISO 320</text>
  <text x="56" y="640" font-family="monospace" font-size="18" fill="#bcd6f2">${NAME}</text>
  <circle cx="660" cy="660" r="8" fill="#ff5f56"/>
  </svg>`;
}

// ---------------------------------------------------------------- sessions
const clients = new Set();

function authedSessions() {
  return [...clients].filter((s) => s.authed && s.ws.readyState === WebSocket.OPEN);
}

function send(session, obj) {
  if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(obj));
}

function broadcastEvent(type, data) {
  for (const s of authedSessions()) send(s, event(type, data));
}

function pushStats() {
  if (!authedSessions().length) return;
  const cpu = cpuPercent();
  const st = storageInfo();
  state.battery = Math.max(3, state.battery - (state.charging ? -0.02 : 0.004));
  const payload = {
    id: DEVICE_ID,
    name: NAME,
    model: 'Airlock Reference',
    android: '14 (API 34)',
    agent: '1.0.0',
    battery: Math.round(state.battery),
    charging: state.charging,
    volume: state.volume,
    muted: state.muted,
    flashlight: state.flashlight,
    cpu,
    mem: { total: os.totalmem(), free: os.freemem() },
    storage: st,
    network: { type: 'wifi', ssid: 'Airlock-LAN', ip: ipAddress(), signal: -54 },
    uptime: Math.round((Date.now() - state.uptimeStart) / 1000),
    time: Date.now(),
  };
  broadcastEvent('stats', payload);
}

// ---------------------------------------------------------------- mirror
let mirrorTimer = null;
let mirrorClients = new Set();
let lastFrame = null;

function mirrorTick() {
  if (!mirrorClients.size) return;
  const svg = svgScreen();
  const buf = encodeFrame({ kind: FrameKind.MIRROR, codec: Codec.SVG }, Buffer.from(svg, 'utf8'));
  lastFrame = buf;
  for (const s of [...mirrorClients]) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(buf, { binary: true });
    else mirrorClients.delete(s);
  }
}

function startMirror(session, opts = {}) {
  mirrorClients.add(session);
  const fps = Math.max(1, Math.min(Number(opts.fps || 10), 20));
  if (!mirrorTimer) {
    mirrorTimer = setInterval(mirrorTick, Math.round(1000 / fps));
    mirrorTick();
  }
  return { fps, codec: 'svg', width: 400, height: 860, control: true, silent: true };
}

function stopMirror(session) {
  mirrorClients.delete(session);
  if (!mirrorClients.size && mirrorTimer) {
    clearInterval(mirrorTimer);
    mirrorTimer = null;
  }
  return { stopped: true };
}

// ---------------------------------------------------------------- handlers
const handlers = {
  hello: () => ({ device: DEVICE_ID }),

  'stats.get'() {
    pushStats();
    const st = storageInfo();
    return {
      id: DEVICE_ID, name: NAME, battery: Math.round(state.battery), charging: state.charging,
      volume: state.volume, muted: state.muted, storage: st, network: { ip: ipAddress(), type: 'wifi' },
    };
  },

  async 'fs.list'(d) {
    const p = d.path || '/';
    return { path: p, entries: await listDir(p), allFiles: true, root: '/' };
  },

  async 'fs.mkdir'(d) {
    const abs = safeJoin(path.join(String(d.path || '/'), String(d.name)));
    await fsp.mkdir(abs, { recursive: true });
    return { created: rel(abs) };
  },

  async 'fs.rename'(d) {
    const abs = safeJoin(path.join(String(d.path || '/'), String(d.name)));
    const dest = safeJoin(path.join(String(d.path || '/'), String(d.newName)));
    await fsp.rename(abs, dest);
    return { path: rel(dest) };
  },

  async 'fs.delete'(d) {
    for (const p of d.paths || []) {
      await fsp.rm(safeJoin(p), { recursive: true, force: true });
    }
    return { deleted: (d.paths || []).length };
  },

  async 'fs.upload.begin'(d, session) {
    const abs = safeJoin(path.join(String(d.path || '/'), String(d.name)));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const uploadId = crypto.randomBytes(8).toString('hex');
    session.upload = {
      id: uploadId, abs, size: Number(d.size || 0), received: 0,
      hash: crypto.createHash('sha256'),
      stream: fs.createWriteStream(abs),
    };
    return { uploadId, path: rel(abs) };
  },

  async 'fs.upload.done'(d, session) {
    const up = session.upload;
    if (!up || up.id !== d.uploadId) throw new Error('unknown upload');
    await new Promise((r) => up.stream.end(r));
    const digest = up.hash.digest('hex');
    const st = await fsp.stat(up.abs);
    const ok = !d.sha256 || d.sha256 === digest;
    session.upload = null;
    broadcastEvent('log', { level: ok ? 'info' : 'error', message: `upload ${ok ? 'ok' : 'checksum mismatch'} · ${rel(up.abs)} · ${st.size} B` });
    return { path: rel(up.abs), size: st.size, sha256: digest, ok };
  },

  async 'fs.preview'(d, session) {
    const abs = safeJoin(d.path);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error('is a directory');
    const svg = svgPreview(path.basename(abs), st.size);
    session.previewFrame = svg;
    return { path: d.path, bytes: Buffer.byteLength(svg), ts: Date.now() };
  },

  async 'fs.download'(d, session) {
    const abs = safeJoin(d.path);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error('is a directory');
    const stream = fs.createReadStream(abs, { highWaterMark: CHUNK_BYTES });
    for await (const chunk of stream) {
      session.ws.send(encodeFrame({ kind: FrameKind.DOWNLOAD }, chunk), { binary: true });
    }
    const sha = await sha256File(abs);
    return { name: path.basename(abs), size: st.size, sha256: sha };
  },

  'mirror.start'(d, session) { return startMirror(session, d || {}); },
  'mirror.stop'(d, session) { return stopMirror(session); },

  'input.tap'(d) {
    state.ripples.push({ x: Number(d.x), y: Number(d.y), ts: Date.now() });
    state.ripples = state.ripples.slice(-6);
    state.lastAction = `tap ${(d.x * 100).toFixed(0)}%,${(d.y * 100).toFixed(0)}%`;
    return { tapped: true };
  },

  'input.swipe'(d) {
    for (let i = 0; i <= 4; i++) {
      state.ripples.push({
        x: Number(d.x1) + (Number(d.x2) - Number(d.x1)) * (i / 4),
        y: Number(d.y1) + (Number(d.y2) - Number(d.y1)) * (i / 4),
        ts: Date.now() + i * 20,
      });
    }
    state.ripples = state.ripples.slice(-6);
    state.lastAction = 'swipe';
    return { swiped: true };
  },

  'input.longpress'(d) {
    state.ripples.push({ x: Number(d.x), y: Number(d.y), ts: Date.now() });
    state.lastAction = `long-press ${d.ms || 600}ms`;
    return { ok: true };
  },

  'input.key'(d) {
    state.lastAction = `key ${String(d.key).toUpperCase()}`;
    if (d.key === 'backspace') state.typed = state.typed.slice(0, -1);
    if (d.key === 'enter') state.typed += '↵';
    return { ok: true };
  },

  'input.text'(d) {
    state.typed = (state.typed + String(d.text || '')).slice(-80);
    state.lastAction = 'text input';
    return { ok: true };
  },

  'sms.threads'() { return { threads: sms.map(({ messages, ...t }) => ({ ...t, preview: messages.at(-1)?.body || '', ts: messages.at(-1)?.ts || 0 })) }; },

  'sms.messages'(d) {
    const th = sms.find((t) => t.id === d.threadId);
    if (!th) throw new Error('no such thread');
    th.unread = 0;
    return { thread: { id: th.id, name: th.name, address: th.address }, messages: th.messages };
  },

  'sms.send'(d) {
    let th = sms.find((t) => t.id === d.threadId) || sms.find((t) => t.address === d.to);
    if (!th) {
      th = { id: 't' + crypto.randomBytes(3).toString('hex'), name: d.to, address: d.to, unread: 0, messages: [] };
      sms.unshift(th);
    }
    const msg = { id: 'm' + crypto.randomBytes(4).toString('hex'), from: 'me', body: String(d.body || ''), ts: Date.now() };
    th.messages.push(msg);
    broadcastEvent('sms', { threadId: th.id, message: msg });
    return { message: msg, threadId: th.id };
  },

  'notif.list'() { return { notifications }; },

  'notif.dismiss'(d) {
    const i = notifications.findIndex((n) => n.id === d.id);
    if (i >= 0) notifications.splice(i, 1);
    broadcastEvent('notif', { dismissed: d.id });
    return { dismissed: d.id };
  },

  'notif.reply'(d) {
    const n = notifications.find((x) => x.id === d.id);
    if (!n) throw new Error('unknown notification');
    broadcastEvent('log', { level: 'info', message: `replied to ${n.app}: ${d.text}` });
    return { sent: true };
  },

  'camera.shot'(d, session) {
    const svg = svgCamera(d.lens || 'back');
    session.ws.send(encodeFrame({ kind: FrameKind.CAMERA, codec: Codec.SVG }, Buffer.from(svg, 'utf8')), { binary: true });
    return { lens: d.lens || 'back', ts: Date.now(), width: 400, height: 860, bytes: Buffer.byteLength(svg) };
  },

  'device.permission'(d) {
    return { opened: String(d.permission || 'demo'), demo: true };
  },

  'device.action'(d) {
    const a = String(d.action || '');
    switch (a) {
      case 'volume.up': state.volume = Math.min(15, state.volume + 1); state.muted = false; break;
      case 'volume.down': state.volume = Math.max(0, state.volume - 1); break;
      case 'volume.mute': state.muted = !state.muted; break;
      case 'media.play': state.media = 'playing'; break;
      case 'media.pause': state.media = 'paused'; break;
      case 'flashlight': state.flashlight = !state.flashlight; break;
      case 'clipboard.get': return { text: state.clipboard };
      case 'clipboard.set': state.clipboard = String(d.value ?? ''); return { text: state.clipboard };
      case 'wake': state.lastAction = 'screen wake'; break;
      case 'lock': state.lastAction = 'screen lock'; break;
      case 'find': broadcastEvent('log', { level: 'warn', message: 'find phone: ringing at full volume' }); break;
      case 'silent.on': state.silent = true; break;
      case 'silent.off': state.silent = false; break;
      case 'silent.toggle': state.silent = !state.silent; break;
      default: throw new Error(`unsupported action ${a}`);
    }
    state.lastAction = a;
    broadcastEvent('log', { level: 'info', message: `action ${a}` });
    return { action: a, silent: state.silent, state: { volume: state.volume, muted: state.muted, flashlight: state.flashlight, media: state.media } };
  },

  'apps.list'() { return { apps }; },
  'apps.launch'(d) {
    const app = apps.find((a) => a.pkg === d.pkg);
    if (!app) throw new Error('unknown app');
    state.lastAction = `launch ${app.name}`;
    return { launched: app.name, pkg: app.pkg };
  },
};

// ---------------------------------------------------------------- socket wiring
function attach(ws, { remote = false } = {}) {
  const session = {
    ws, authed: remote, upload: null, remote,
    id: crypto.randomBytes(4).toString('hex'),
  };
  clients.add(session);
  trace('client attached', session.id, remote ? 'cloud' : 'lan');

  send(session, event('log', { level: 'info', message: `connected (${remote ? 'cloud' : 'lan'})` }));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // 16-byte header: kind at offset 3
      if (buf.length < 16) return;
      const kind = buf[3];
      if (kind === FrameKind.UPLOAD) {
        const up = session.upload;
        if (!up) return;
        const chunk = buf.subarray(16);
        up.received += chunk.length;
        up.hash.update(chunk);
        if (!up.stream.write(chunk)) await new Promise((r) => up.stream.once('drain', r));
      }
      return;
    }

    let req;
    try { req = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!req || typeof req.type !== 'string' || req.type.startsWith('relay.')) return;

    if (req.type === 'auth') {
      if (remote || String(req.data?.code) === LAN_CODE) {
        session.authed = true;
        send(session, response(req, { ok: true, device: DEVICE_ID }));
        send(session, {
          v: 1, type: 'hello', ts: Date.now(),
          data: {
            device: { id: DEVICE_ID, name: NAME, model: 'Airlock Reference', android: '14', agent: '1.0.3', ip: ipAddress(), port: PORT, silentCapture: true },
            capabilities: Object.keys(handlers),
            permissions: { camera: true, smsRead: true, smsSend: true, notifications: true, accessibility: true, screenshot: true, allFiles: true, battery: true },
            silent: state.silent,
          },
        });
        pushStats();
      } else {
        send(session, failure(req, 'bad_code', 'pairing code rejected'));
        setTimeout(() => ws.close(4003, 'bad code'), 250);
      }
      return;
    }

    if (!session.authed) { send(session, failure(req, 'unauthorized', 'send auth first')); return; }

    if (req.type === 'mirror.start' && !lastFrame) { /* first frame comes on tick */ }
    const fn = handlers[req.type];
    if (!fn) { send(session, failure(req, 'unknown_type', `no handler for ${req.type}`)); return; }
    try {
      const result = await fn(req.data || {}, session);
      send(session, response(req, result ?? {}));
      if (req.type === 'fs.preview' && session.previewFrame) {
        const svg = session.previewFrame;
        session.previewFrame = null;
        session.ws.send(
          encodeFrame({ kind: FrameKind.PREVIEW, codec: Codec.SVG }, Buffer.from(svg, 'utf8')),
          { binary: true },
        );
      }
    } catch (err) {
      send(session, failure(req, 'handler_error', err?.message || String(err)));
    }
  });

  ws.on('close', () => {
    clients.delete(session);
    mirrorClients.delete(session);
    if (!mirrorClients.size && mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; }
    trace('client detached', session.id);
  });
  ws.on('error', () => {});
  return session;
}

// ---------------------------------------------------------------- HTTP + LAN WS
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, device: DEVICE_ID, name: NAME, clients: clients.size }));
    return;
  }
  if (req.url === '/' || req.url === '/info') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({
      app: 'Airlock device agent', version: '1.0.0', device: DEVICE_ID, name: NAME,
      lan: `ws://${ipAddress()}:${PORT}/agent`, auth: 'six digit pairing code',
    }, null, 2));
    return;
  }
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/agent')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, { remote: false }));
});
wss.on('connection', (ws) => { /* attach() already ran */ });

// ---------------------------------------------------------------- cloud link
let cloudWs = null;
let cloudBackoff = 3000;
function connectCloud() {
  if (!CLOUD) return;
  const base = CLOUD.replace(/\/+$/, '');
  let url;
  if (base.includes('?')) url = `${base}&role=device`;
  else if (base.endsWith('/ws')) url = `${base}?role=device&room=${encodeURIComponent(CLOUD_ROOM)}&token=${encodeURIComponent(CLOUD_TOKEN)}`;
  else url = `${base}/ws?role=device&room=${encodeURIComponent(CLOUD_ROOM)}&token=${encodeURIComponent(CLOUD_TOKEN)}`;
  log('cloud link →', url.replace(/token=[^&]+/, 'token=***'));
  const ws = new WebSocket(url);
  cloudWs = ws;
  ws.on('open', () => {
    log('cloud link online');
    cloudBackoff = 3000;
    attach(ws, { remote: true });
    send({ ws }, {
      v: 1, type: 'hello', ts: Date.now(),
      data: {
        device: { id: DEVICE_ID, name: NAME, model: 'Airlock Reference', android: '14', agent: '1.0.1', ip: ipAddress(), port: PORT },
        capabilities: Object.keys(handlers),
        permissions: { camera: true, smsRead: true, smsSend: true, notifications: true, accessibility: true, allFiles: true, battery: true },
        silent: state.silent,
      },
    });
    pushStats();
  });
  ws.on('close', () => {
    log(`cloud link closed, retrying in ${Math.round(cloudBackoff / 1000)}s`);
    setTimeout(connectCloud, cloudBackoff);
    cloudBackoff = Math.min(30000, Math.round(cloudBackoff * 1.6));
  });
  ws.on('error', (e) => trace('cloud error', e.message));
}

// ---------------------------------------------------------------- boot
await seed();
httpServer.listen(PORT, () => {
  log(`LAN agent ws://${ipAddress()}:${PORT}/agent  code=${LAN_CODE}`);
  log(`sandbox: ${SANDBOX}`);
});
setInterval(pushStats, 4000);
connectCloud();

const shutdown = () => {
  log('shutting down');
  try { cloudWs?.close(); } catch {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
