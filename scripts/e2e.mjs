#!/usr/bin/env node
/**
 * Airlock end-to-end smoke test.
 *
 * Exercises the real wire protocol against a running reference agent and relay:
 *
 *   node apps/agent/agent.mjs      (terminal 1)
 *   node apps/relay/server.mjs     (terminal 2)
 *   node scripts/e2e.mjs           (terminal 3, or `npm run e2e`)
 *
 * Covers: pairing, hello, filesystem list/download/upload with checksums, live
 * mirror frames, SMS, notifications and the relay's room routing.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  FrameKind, decodeFrame, encodeFrame, CHUNK_BYTES,
} from '../packages/protocol/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_WS = process.env.AGENT_WS || 'ws://127.0.0.1:8787/agent';
const RELAY = (process.env.RELAY || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CODE = process.env.AIRLOCK_CODE || '123456';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Minimal protocol client: request() plus a binary-frame listener. */
function client(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const frames = new Set();
  const events = [];
  let hello = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const f = decodeFrame(data);
      if (f) frames.forEach((cb) => cb(f));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.type === 'hello') { hello = msg.data; return; }
    if (msg.type?.startsWith('res:') && msg.replyTo) {
      const p = pending.get(msg.replyTo);
      if (!p) return;
      pending.delete(msg.replyTo);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error?.message || 'request failed'));
      return;
    }
    if (msg.type?.startsWith('event:')) events.push(msg);
  });

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('close', (code) => { if (code !== 1000) reject(new Error(`closed ${code}`)); });
  });

  let seq = 0;
  return {
    ws, ready, events,
    get hello() { return hello; },
    onFrame(cb) { frames.add(cb); return () => frames.delete(cb); },
    request(type, data = {}, timeout = 20000) {
      const id = `e2e-${Date.now().toString(36)}-${seq++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, timeout);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), type, data }));
      });
    },
    close() {
      try { ws.close(1000); } catch { /* already gone */ }
    },
  };
}

async function lan() {
  console.log('\nLAN agent', AGENT_WS);
  const c = client(AGENT_WS);
  await c.ready;

  const wrong = client(AGENT_WS);
  await wrong.ready;
  let rejected = false;
  await wrong.request('auth', { code: '000000' }).catch(() => { rejected = true; });
  check('rejects a wrong pairing code', rejected);
  wrong.close();

  await c.request('auth', { code: CODE });
  await sleep(500);
  check('auth + hello', !!c.hello?.device?.id, c.hello?.device?.name);
  check('hello advertises capabilities', (c.hello?.capabilities || []).length > 10,
    `${c.hello?.capabilities?.length} methods`);
  check('hello advertises silent capture', c.hello?.device?.silentCapture === true &&
    c.hello?.permissions?.screenshot === true);

  const list = await c.request('fs.list', { path: '/' });
  const names = list.entries.map((e) => e.name);
  check('fs.list returns sandbox root', names.includes('welcome.txt'), names.join(', '));

  // ---- download
  const onDisk = await fsp.readFile(path.join(__dirname, '../apps/agent/sandbox/welcome.txt'));
  const chunks = [];
  const off = c.onFrame((f) => { if (f.kind === FrameKind.DOWNLOAD) chunks.push(Buffer.from(f.payload)); });
  const meta = await c.request('fs.download', { path: '/welcome.txt' }, 60000);
  off();
  const got = Buffer.concat(chunks);
  check('fs.download streams every byte', got.length === onDisk.length,
    `${got.length}/${onDisk.length} B in ${chunks.length} frame(s)`);
  check('fs.download checksum matches disk', sha256(got) === sha256(onDisk));

  // ---- preview (reply first, then one PREVIEW frame)
  const previewFrames = [];
  const offPreview = c.onFrame((f) => {
    if (f.kind === FrameKind.PREVIEW) previewFrames.push(Buffer.from(f.payload));
  });
  const previewMeta = await c.request('fs.preview', { path: '/Photos/welcome.svg' }, 30000);
  await sleep(120);
  offPreview();
  check('fs.preview sends one downscaled frame', previewFrames.length === 1 && previewMeta.bytes > 0,
    `${previewMeta.bytes} B in ${previewFrames.length} frame(s)`);

  // ---- upload
  const body = Buffer.from(`Airlock e2e ${new Date().toISOString()}\n`);
  const digest = sha256(body);
  const name = `e2e-${Date.now().toString(36)}.txt`;
  const begin = await c.request('fs.upload.begin', { path: '/', name, size: body.length, sha256: digest });
  for (let o = 0; o < body.length; o += CHUNK_BYTES) {
    c.ws.send(encodeFrame({ kind: FrameKind.UPLOAD, stream: 1 }, body.subarray(o, o + CHUNK_BYTES)));
  }
  const done = await c.request('fs.upload.done', { uploadId: begin.uploadId, sha256: digest }, 30000);
  const written = await fsp.readFile(path.join(__dirname, '../apps/agent/sandbox', name)).catch(() => null);
  check('fs.upload writes verified bytes', !!written && written.equals(body), `${done.size} B, sha ${String(done.sha256).slice(0, 12)}…`);
  await fsp.rm(path.join(__dirname, '../apps/agent/sandbox', name), { force: true });

  // ---- mirror
  const frames = [];
  const offMirror = c.onFrame((f) => { if (f.kind === FrameKind.MIRROR) frames.push(f); });
  await c.request('mirror.start', { fps: 8, quality: 60 });
  await sleep(900);
  await c.request('mirror.stop', {});
  offMirror();
  check('mirror streams frames', frames.length > 0, `${frames.length} frame(s), codec ${frames[0]?.codec}`);
  if (frames.length > 1) {
    const t0 = frames[0].ts;
    const t1 = frames.at(-1).ts;
    check('mirror frames carry timestamps', t1 >= t0, `${t1 - t0}s span`);
  }

  // ---- messaging
  const threads = await c.request('sms.threads', {});
  check('sms.threads', Array.isArray(threads.threads) && threads.threads.length > 0,
    `${threads.threads.length} thread(s)`);
  const sent = await c.request('sms.send', { threadId: threads.threads[0].id, body: 'hello from e2e' });
  check('sms.send', sent.message?.body === 'hello from e2e');

  const notifs = await c.request('notif.list', {});
  check('notif.list', Array.isArray(notifs.notifications));

  const stats = c.events.filter((e) => e.type === 'event:stats').at(-1);
  check('event:stats broadcasts telemetry', !!stats?.data?.battery,
    stats ? `battery ${stats.data.battery}%` : 'none yet');

  c.close();
  return results.slice(-14);
}

async function relay() {
  console.log('\nCloud relay', RELAY);
  const created = await fetch(`${RELAY}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e device' }),
  }).then((r) => r.json());
  check('POST /api/pair issues a code', /^\d{6}$/.test(created.code || ''), `code ${created.code}`);

  const claimed = await fetch(`${RELAY}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: created.code }),
  }).then((r) => r.json());
  check('POST /api/pair/claim returns the room', claimed.room === created.room);

  const again = await fetch(`${RELAY}/api/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: created.code }),
  });
  check('pair codes are single use', again.status === 404);

  const url = (role) => `${RELAY.replace(/^http/, 'ws')}/ws?role=${role}&room=${encodeURIComponent(created.room)}&token=${encodeURIComponent(created.token)}`;
  const device = client(url('device'));
  await device.ready;
  device.ws.send(JSON.stringify({ v: 1, type: 'hello', ts: Date.now(), data: { device: { id: 'e2e', name: 'E2E phone' } } }));
  await sleep(100);

  const controller = client(url('controller'));
  await controller.ready;
  await sleep(250);
  check('late controller gets cached hello', controller.hello?.device?.id === 'e2e');

  controller.ws.send(JSON.stringify({ v: 1, id: 'rq1', ts: Date.now(), type: 'fs.list', data: { path: '/' } }));
  const forwarded = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    device.ws.on('message', (d, isBin) => {
      if (isBin) return;
      const m = JSON.parse(d.toString());
      if (m.type === 'fs.list') { clearTimeout(t); resolve(m); }
    });
  });
  check('controller → device routing', forwarded?.id === 'rq1');

  device.ws.send(JSON.stringify({ v: 1, id: 'rq1-r', replyTo: 'rq1', ts: Date.now(), type: 'res:fs.list', ok: true, data: { entries: [] } }));
  const back = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    controller.ws.on('message', (d, isBin) => {
      if (isBin) return;
      const m = JSON.parse(d.toString());
      if (m.replyTo === 'rq1') { clearTimeout(t); resolve(m); }
    });
  });
  check('device → controller routing', back?.ok === true);

  const binary = Buffer.concat([encodeFrame({ kind: FrameKind.MIRROR, codec: 3 }, Buffer.from('<svg/>'))]);
  const binBack = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    controller.onFrame(() => { clearTimeout(t); resolve(true); });
    device.ws.send(binary);
  });
  check('binary frames cross the relay intact', binBack);

  const bad = new WebSocket(`${RELAY.replace(/^http/, 'ws')}/ws?role=controller&room=nope&token=nope`);
  const denied = await new Promise((resolve) => {
    bad.once('open', () => resolve(false));
    bad.once('error', () => resolve(true));
  });
  check('rejects an unknown room', denied);

  controller.close();
  device.close();
  const health = await fetch(`${RELAY}/health`).then((r) => r.json());
  check('GET /health', health.ok === true, `${health.rooms} room(s)`);
}

try {
  await lan();
  await relay();
} catch (err) {
  check('suite completed', false, err?.message || String(err));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
