import { CODE_TTL_MS, ROOM_TTL_MS, json, randomId, readJson, sixDigits } from './shared.js';

/**
 * One singleton Durable Object owns code issuance and room tokens. That gives
 * the worker a single place to check "is this room real?" and keeps the
 * six-digit code space collision-free.
 *
 * Keys:
 *   code:<digits> -> { room, token, expiresAt }   single use, 10 minutes
 *   room:<id>     -> { token, name, expiresAt }   lives as long as the room
 */
export class Pairing {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/pair' && request.method === 'POST') return this.create(request);
    if (url.pathname === '/api/pair/claim' && request.method === 'POST') return this.claim(request);
    if (url.pathname === '/stats') return this.stats();
    return json({ error: 'not_found' }, 404);
  }

  // ---------------------------------------------------------------- pair
  async create(request) {
    const body = await readJson(request);
    const name = String(body.name || 'Android device').slice(0, 80);

    const room = randomId(9);
    const token = randomId(24);
    let code = sixDigits();
    while (await this.ctx.storage.get(`code:${code}`)) code = sixDigits();

    // Create the room object first: if that fails we burn nothing.
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(room));
    const init = await stub.fetch('https://room/init', {
      method: 'POST',
      body: JSON.stringify({ token, name }),
    });
    if (!init.ok) return json({ error: 'room_init_failed' }, 502);

    const now = Date.now();
    const expiresAt = now + CODE_TTL_MS;
    await this.ctx.storage.put({
      [`code:${code}`]: { room, token, expiresAt },
      [`room:${room}`]: { token, name, expiresAt: now + ROOM_TTL_MS },
    });
    await this.ensureCleanup(expiresAt);

    return json({ code, room, token, expiresAt });
  }

  async claim(request) {
    const body = await readJson(request);
    const code = String(body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return json({ error: 'unknown_or_expired_code' }, 404);

    const entry = await this.ctx.storage.get(`code:${code}`);
    if (!entry || entry.expiresAt < Date.now()) return json({ error: 'unknown_or_expired_code' }, 404);

    await this.ctx.storage.delete(`code:${code}`); // single use
    return json({ room: entry.room, token: entry.token });
  }

  // ---------------------------------------------------------------- ops
  async stats() {
    const now = Date.now();
    const rooms = await this.ctx.storage.list({ prefix: 'room:' });
    let live = 0;
    for (const value of rooms.values()) if (value.expiresAt > now) live += 1;
    return json({ rooms: live });
  }

  async ensureCleanup(at) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const now = Date.now();
    const entries = await this.ctx.storage.list();
    const dead = [];
    let next = null;
    for (const [key, value] of entries) {
      if (!key.startsWith('code:') && !key.startsWith('room:')) continue;
      if (value.expiresAt < now) dead.push(key);
      else if (next === null || value.expiresAt < next) next = value.expiresAt;
    }
    if (dead.length) await this.ctx.storage.delete(dead);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
