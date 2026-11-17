/**
 * Airlock relay on Cloudflare Workers.
 *
 *   GET  /health                 -> { ok, version, rooms, waiting, uptime, host }
 *   POST /api/pair               -> { code, room, token, expiresAt }
 *   POST /api/pair/claim {code}  -> { room, token }        (single use, 10 min)
 *   WS   /ws?role=device|controller&room=&token=
 *
 * The worker itself is stateless glue: pairing lives in one Durable Object,
 * each room in another. Same wire contract as `apps/relay/server.mjs`, so the
 * dashboard and the phone cannot tell them apart.
 */
import { json, preflight } from './shared.js';

export { Pairing } from './pairing.js';
export { Room } from './room.js';

const PAIRING_NAME = 'global';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight();

    if (url.pathname === '/') {
      return json({ ok: true, service: 'airlock-relay', version: 1, runtime: 'cloudflare-workers' });
    }

    if (url.pathname === '/health') {
      const pairing = env.PAIRING.get(env.PAIRING.idFromName(PAIRING_NAME));
      const stats = await pairing.fetch('https://pairing/stats').then((r) => r.json()).catch(() => ({ rooms: 0 }));
      return json({
        ok: true,
        version: 1,
        rooms: stats.rooms || 0,
        // The Worker has no process and no shared room table, so "rooms with a
        // live device" is not a cheap number to report; null means unknown.
        waiting: null,
        uptime: null,
        host: 'cloudflare-workers',
      });
    }

    if (url.pathname === '/api/pair' || url.pathname === '/api/pair/claim') {
      const pairing = env.PAIRING.get(env.PAIRING.idFromName(PAIRING_NAME));
      return pairing.fetch(new Request(`https://pairing${url.pathname}`, request));
    }

    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') || '';
      if (!room) return json({ error: 'missing_room' }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const target = new URL('https://room/ws');
      target.searchParams.set('role', url.searchParams.get('role') || 'controller');
      target.searchParams.set('token', url.searchParams.get('token') || '');
      target.searchParams.set('room', room);
      return stub.fetch(new Request(target.toString(), request));
    }

    return json({ error: 'not_found' }, 404);
  },
};
