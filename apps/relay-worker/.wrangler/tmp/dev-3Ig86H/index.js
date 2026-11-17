var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/shared.js
var CODE_TTL_MS = 10 * 60 * 1e3;
var ROOM_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_CONTROLLERS = 3;
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "cache-control": "no-store"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS }
  });
}
__name(json, "json");
function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
__name(preflight, "preflight");
function randomId(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let raw = "";
  for (const b of buf) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(randomId, "randomId");
function sixDigits() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1e6;
  return String(n).padStart(6, "0");
}
__name(sixDigits, "sixDigits");
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(sameSecret, "sameSecret");
async function readJson(request) {
  try {
    const text = await request.text();
    if (!text || text.length > 8192) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
__name(readJson, "readJson");
function safeSend(ws, payload) {
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}
__name(safeSend, "safeSend");
function envelope(type, data) {
  return JSON.stringify({ v: 1, type, ts: Date.now(), data });
}
__name(envelope, "envelope");

// src/pairing.js
var Pairing = class {
  static {
    __name(this, "Pairing");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pair" && request.method === "POST") return this.create(request);
    if (url.pathname === "/api/pair/claim" && request.method === "POST") return this.claim(request);
    if (url.pathname === "/stats") return this.stats();
    return json({ error: "not_found" }, 404);
  }
  // ---------------------------------------------------------------- pair
  async create(request) {
    const body = await readJson(request);
    const name = String(body.name || "Android device").slice(0, 80);
    const room = randomId(9);
    const token = randomId(24);
    let code = sixDigits();
    while (await this.ctx.storage.get(`code:${code}`)) code = sixDigits();
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(room));
    const init = await stub.fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ token, name })
    });
    if (!init.ok) return json({ error: "room_init_failed" }, 502);
    const now = Date.now();
    const expiresAt = now + CODE_TTL_MS;
    await this.ctx.storage.put({
      [`code:${code}`]: { room, token, expiresAt },
      [`room:${room}`]: { token, name, expiresAt: now + ROOM_TTL_MS }
    });
    await this.ensureCleanup(expiresAt);
    return json({ code, room, token, expiresAt });
  }
  async claim(request) {
    const body = await readJson(request);
    const code = String(body.code || "").trim();
    if (!/^\d{6}$/.test(code)) return json({ error: "unknown_or_expired_code" }, 404);
    const entry = await this.ctx.storage.get(`code:${code}`);
    if (!entry || entry.expiresAt < Date.now()) return json({ error: "unknown_or_expired_code" }, 404);
    await this.ctx.storage.delete(`code:${code}`);
    return json({ room: entry.room, token: entry.token });
  }
  // ---------------------------------------------------------------- ops
  async stats() {
    const now = Date.now();
    const rooms = await this.ctx.storage.list({ prefix: "room:" });
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
      if (!key.startsWith("code:") && !key.startsWith("room:")) continue;
      if (value.expiresAt < now) dead.push(key);
      else if (next === null || value.expiresAt < next) next = value.expiresAt;
    }
    if (dead.length) await this.ctx.storage.delete(dead);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
};

// src/room.js
var Room = class {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") return this.init(request);
    if (url.pathname === "/ws") return this.upgrade(request, url);
    return json({ error: "not_found" }, 404);
  }
  async init(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const token = String(body.token || "");
    const name = String(body.name || "Android device").slice(0, 80);
    if (!token) return json({ error: "missing_token" }, 400);
    await this.ctx.storage.put({ token, name, createdAt: Date.now() });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return json({ ok: true });
  }
  // -------------------------------------------------------------- websocket
  async upgrade(request, url) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "expected_websocket" }, 426);
    }
    const role = url.searchParams.get("role") || "controller";
    if (role !== "device" && role !== "controller") return json({ error: "bad_role" }, 400);
    const expected = await this.ctx.storage.get("token");
    if (!expected || !sameSecret(String(url.searchParams.get("token") || ""), expected)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (role === "controller" && this.ctx.getWebSockets("controller").length >= MAX_CONTROLLERS) {
      return json({ error: "room_full" }, 429);
    }
    const staleDevices = role === "device" ? this.ctx.getWebSockets("device") : [];
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });
    for (const stale of staleDevices) {
      try {
        stale.close(4001, "replaced");
      } catch {
      }
    }
    if (role === "controller") {
      const hello = await this.ctx.storage.get("hello");
      if (hello) safeSend(server, hello);
    }
    const name = await this.ctx.storage.get("name") || "Android device";
    const room = url.searchParams.get("room") || "";
    safeSend(server, envelope("relay.welcome", { role, room, name }));
    this.notifyPeers();
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    const role = attachment.role === "device" ? "device" : "controller";
    if (role === "device") {
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message);
          if (parsed && parsed.type === "hello") await this.ctx.storage.put("hello", message);
        } catch {
        }
      }
      for (const controller of this.ctx.getWebSockets("controller")) safeSend(controller, message);
      return;
    }
    const device = this.ctx.getWebSockets("device")[0];
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
    const device = this.ctx.getWebSockets("device")[0];
    const controllers = this.ctx.getWebSockets("controller");
    if (device && controllers.length > 0) {
      const joined = envelope("relay.peer.joined", { role: "device" });
      for (const controller of controllers) safeSend(controller, joined);
      safeSend(
        device,
        envelope("relay.peer.joined", { role: "controller", count: controllers.length })
      );
      return;
    }
    if (device) safeSend(device, envelope("relay.peer.left", { role: "controller" }));
    const left = envelope("relay.peer.left", { role: "device" });
    for (const controller of controllers) safeSend(controller, left);
  }
  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1e3);
  }
};

// src/index.js
var PAIRING_NAME = "global";
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight();
    if (url.pathname === "/") {
      return json({ ok: true, service: "airlock-relay", version: 1, runtime: "cloudflare-workers" });
    }
    if (url.pathname === "/health") {
      const pairing = env.PAIRING.get(env.PAIRING.idFromName(PAIRING_NAME));
      const stats = await pairing.fetch("https://pairing/stats").then((r) => r.json()).catch(() => ({ rooms: 0 }));
      return json({
        ok: true,
        version: 1,
        rooms: stats.rooms || 0,
        // The Worker has no process and no shared room table, so "rooms with a
        // live device" is not a cheap number to report; null means unknown.
        waiting: null,
        uptime: null,
        host: "cloudflare-workers"
      });
    }
    if (url.pathname === "/api/pair" || url.pathname === "/api/pair/claim") {
      const pairing = env.PAIRING.get(env.PAIRING.idFromName(PAIRING_NAME));
      return pairing.fetch(new Request(`https://pairing${url.pathname}`, request));
    }
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") || "";
      if (!room) return json({ error: "missing_room" }, 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const target = new URL("https://room/ws");
      target.searchParams.set("role", url.searchParams.get("role") || "controller");
      target.searchParams.set("token", url.searchParams.get("token") || "");
      target.searchParams.set("room", room);
      return stub.fetch(new Request(target.toString(), request));
    }
    return json({ error: "not_found" }, 404);
  }
};

// ../../../../../AppData/Local/npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../AppData/Local/npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ll4Bt6/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../AppData/Local/npm-cache/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ll4Bt6/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Pairing,
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
