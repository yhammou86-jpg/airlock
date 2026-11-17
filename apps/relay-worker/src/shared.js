/** Shared helpers for the Worker relay. */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CONTROLLERS = 3;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'cache-control': 'no-store',
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** base64url of `bytes` random bytes, without padding. */
export function randomId(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let raw = '';
  for (const b of buf) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Six digits, leading zeros preserved. */
export function sixDigits() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Constant-time-ish compare for room tokens. */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** JSON body, or an empty object for garbage/oversized input. */
export async function readJson(request) {
  try {
    const text = await request.text();
    if (!text || text.length > 8192) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** ws.send that never throws on a socket the peer just closed. */
export function safeSend(ws, payload) {
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

export function envelope(type, data) {
  return JSON.stringify({ v: 1, type, ts: Date.now(), data });
}
