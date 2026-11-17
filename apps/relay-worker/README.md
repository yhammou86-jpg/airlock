# Airlock relay on Cloudflare Workers

The same relay contract as [`../relay`](../relay) (`/health`, `/api/pair`,
`/api/pair/claim`, `/ws`) implemented with Workers + Durable Objects. This is
the variant that runs on Cloudflare's free plan without any cold start: one
Durable Object per room is where the phone and every browser meet, so routing
needs no shared memory, no database and no always-on container.

```
browser ──┐                        ┌── Durable Object "Pairing"
          ├─ wss://…/ws?role=… ───► │     codes + room tokens, 10 min TTL
phone ────┘                        └── Durable Object per room
                                        forwards text + binary frames
```

## Why a Worker instead of the Node relay

| | `apps/relay` (Node) | this Worker |
| --- | --- | --- |
| host | Render / Fly / Railway container | Cloudflare edge, no container |
| free-tier idle | sleeps after 15 min (~40 s wake) | hibernates, wakes in milliseconds |
| rooms | in-process `Map` | one Durable Object per room |
| binary frames | `ws` passthrough | `ws.send(ArrayBuffer)` passthrough |

Both speak the identical wire protocol, so `scripts/e2e.mjs` passes against
either one (`RELAY=http://127.0.0.1:8789 npm run e2e`).

## Run locally

```bash
cd apps/relay-worker
npx wrangler dev --port 8789
curl http://127.0.0.1:8789/health
```

From the repository root: `npm run relay:worker`.

Workerd (the Workers runtime) runs locally, Durable Objects included, so pairing
and WebSocket routing can be tested without an account.

## Deploy

```bash
cd apps/relay-worker
npx wrangler login          # browser OAuth, once
npx wrangler deploy
```

The first deploy prints the URL, e.g. `https://airlock-relay.<subdomain>.workers.dev`.
Check `https://airlock-relay.<subdomain>.workers.dev/health` → `{"ok":true,…}`.

Then point the dashboard at it and redeploy Vercel:

```bash
vercel env add VITE_RELAY_URL production     # https://airlock-relay.<subdomain>.workers.dev
vercel deploy --prod
```

Without that, the Connect screen still works — paste the relay URL there.

### Custom domain

`wrangler.toml` → add

```toml
routes = [{ pattern = "relay.example.com", custom_domain = true }]
```

and `wrangler deploy` again. WebSockets need no extra configuration.

## Free-plan notes

- Durable Objects on the free plan are SQLite-backed (`new_sqlite_classes` in
  `wrangler.toml`). Do not switch them to key-value classes without a paid plan.
- WebSocket messages bill as requests; a mirror stream is chatty. The dashboard
  defaults to 8 fps, which is well inside the daily allowance for personal use.
- Hibernation closes nothing: the sockets survive and the object is re-created on
  the next frame, re-reading the cached `hello` from storage.
- Rooms are capped at three controllers and one device, exactly like the Node
  relay. Pairing codes are single-use with a 10 minute TTL.
- `/health` reports `rooms` but returns `null` for `waiting`/`uptime`, because a
  Worker has no process to ask.

## Security

The object never stores payloads, never logs them, and has no database. It keeps
two values per room: the 24-byte room token and the phone's last `hello`. TLS is
terminated by Cloudflare, so the relay can read frames in transit — same caveat
as any relay, which is why `apps/relay` is also shippable to your own box.
