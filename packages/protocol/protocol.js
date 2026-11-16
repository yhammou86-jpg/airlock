/**
 * Airlock wire protocol — shared by the browser dashboard, the Node reference
 * agent and (as a direct port) the Android agent.
 *
 * Two channels run over one WebSocket:
 *   1. JSON text frames: RPC (`type` = request, `res:<type>` = response) + events.
 *   2. Binary frames: media/files, always prefixed with a 16-byte header.
 *
 * Keeping this file dependency-free means the same code runs in Vite, Node and
 * Deno.
 */

export const PROTOCOL_VERSION = 1;

/** Binary frame kinds. */
export const FrameKind = {
  MIRROR: 1,
  CAMERA: 2,
  UPLOAD: 3,
  DOWNLOAD: 4,
  AUDIO: 5,
};

/** Payload codecs for MIRROR / CAMERA frames. */
export const Codec = {
  JPEG: 1,
  WEBP: 2,
  SVG: 3, // reference agent only
  PNG: 4,
};

export const HEADER_BYTES = 16;

/** Build a binary frame: magic|ver|kind|codec|flags|rsv|stream|ts|payload. */
export function encodeFrame({ kind, codec = 0, flags = 0, stream = 0, ts = 0 }, payload) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = 0x41; // 'A'
  out[1] = 0x44; // 'D'
  out[2] = PROTOCOL_VERSION;
  out[3] = kind & 0xff;
  out[4] = codec & 0xff;
  out[5] = flags & 0xff;
  out[6] = 0;
  out[7] = 0;
  dv.setUint32(8, stream >>> 0, true);
  dv.setUint32(12, (ts || Date.now() / 1000) >>> 0, true);
  out.set(body, HEADER_BYTES);
  return out;
}

/** Parse a binary frame. Returns null if the header is not ours. */
export function decodeFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < HEADER_BYTES || u8[0] !== 0x41 || u8[1] !== 0x44) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    version: u8[2],
    kind: u8[3],
    codec: u8[4],
    flags: u8[5],
    stream: dv.getUint32(8, true),
    ts: dv.getUint32(12, true),
    payload: u8.subarray(HEADER_BYTES),
  };
}

export function mimeFor(codec) {
  switch (codec) {
    case Codec.JPEG: return 'image/jpeg';
    case Codec.WEBP: return 'image/webp';
    case Codec.SVG: return 'image/svg+xml';
    case Codec.PNG: return 'image/png';
    default: return 'application/octet-stream';
  }
}

let counter = 0;
/** Request/event envelope. */
export function envelope(type, data = {}, extra = {}) {
  counter = (counter + 1) % 1e9;
  return {
    v: PROTOCOL_VERSION,
    id: `${Date.now().toString(36)}-${counter.toString(36)}`,
    ts: Date.now(),
    type,
    data,
    ...extra,
  };
}

export function response(req, data, extra = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: `${req.id}-r`,
    replyTo: req.id,
    ts: Date.now(),
    type: `res:${req.type}`,
    ok: true,
    data,
    ...extra,
  };
}

export function failure(req, code, message, extra = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: `${req.id}-e`,
    replyTo: req.id,
    ts: Date.now(),
    type: `res:${req.type}`,
    ok: false,
    error: { code, message },
    ...extra,
  };
}

export function event(type, data = {}) {
  return { v: PROTOCOL_VERSION, ts: Date.now(), type: `event:${type}`, data };
}

/** Chunk size used for uploads/downloads. 64 KiB keeps frames small on mobile. */
export const CHUNK_BYTES = 64 * 1024;

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
