import { MAX_CONTROLLERS, ROOM_TTL_MS, envelope, json, sameSecret, safeSend } from './shared.js';

/**
 * One Durable Object per room — the whole relay.
 *
 * Hibernatable WebSockets mean an idle room costs nothing while the phone and
 * the browser keep their sockets open; Cloudflare evicts the object and wakes
 * it on the next message. Only two small things live in storage: the room
 * token (for validation) and the device's last `hello` (so a controller that
 * joins late still sees the device name).
 */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') return this.init(request);
    if (url.pathname === '/ws') return this.upgrade(request, url);
    return json({ error: 'not_found' }, 404);
  }

  async init(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const token = String(body.token || '');
    const name = String(body.name || 'Android device').slice(0, 80);
    if (!token) return json({ error: 'missing_token' }, 400);

    await this.ctx.storage.put({ token, name, createdAt: Date.now() });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return json({ ok: true });
  }

  // -------------------------------------------------------------- websocket
  async upgrade(request, url) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }

    const role = url.searchParams.get('role') || 'controller';
    if (role !== 'device' && role !== 'controller') return json({ error: 'bad_role' }, 400);

    const expected = await this.ctx.storage.get('token');
    if (!expected || !sameSecret(String(url.searchParams.get('token') || ''), expected)) {
      return json({ error: 'unauthorized' }, 401);
    }

    if (role === 'controller' && this.ctx.getWebSockets('controller').length >= MAX_CONTROLLERS) {
      return json({ error: 'room_full' }, 429);
    }

    // Collect stale sockets before accepting, or the loop below would close
    // the socket we are about to hand back.
    const staleDevices = role === 'device' ? this.ctx.getWebSockets('device') : [];

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // A reconnecting phone replaces the stale socket instead of duplicating.
    for (const stale of staleDevices) {
      try {
        stale.close(4001, 'replaced');
      } catch {
        /* already gone */
      }
    }

    if (role === 'controller') {
      const hello = await this.ctx.storage.get('hello');
      if (hello) safeSend(server, hello);
    }

    const name = (await this.ctx.storage.get('name')) || 'Android device';
    const room = url.searchParams.get('room') || '';
    safeSend(server, envelope('relay.welcome', { role, room, name }));
    this.notifyPeers();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    const role = attachment.role === 'device' ? 'device' : 'controller';

    if (role === 'device') {
      if (typeof message === 'string') {
        // Cache the phone's hello so late controllers can be oriented.
        try {
          const parsed = JSON.parse(message);
          if (parsed && parsed.type === 'hello') await this.ctx.storage.put('hello', message);
        } catch {
          /* not our business */
        }
      }
      for (const controller of this.ctx.getWebSockets('controller')) safeSend(controller, message);
      return;
    }

    const device = this.ctx.getWebSockets('device')[0];
    if (device) safeSend(device, message);
  }

  async webSocketClose(ws, code, reason) {
    this.notifyPeers();
  }

  async webSocketError(ws, error) {
    this.notifyPeers();
  }

  /** Mirrors the Node relay's presence messages. */
  notifyPeers() {
    const device = this.ctx.getWebSockets('device')[0];
    const controllers = this.ctx.getWebSockets('controller');

    if (device && controllers.length > 0) {
      const joined = envelope('relay.peer.joined', { role: 'device' });
      for (const controller of controllers) safeSend(controller, joined);
      safeSend(
        device,
        envelope('relay.peer.joined', { role: 'controller', count: controllers.length }),
      );
      return;
    }

    if (device) safeSend(device, envelope('relay.peer.left', { role: 'controller' }));
    const left = envelope('relay.peer.left', { role: 'device' });
    for (const controller of controllers) safeSend(controller, left);
  }

  async alarm() {
    // Reap an abandoned room; a room with live sockets keeps its data.
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
}
