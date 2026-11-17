# Deploy Airlock for free

Three pieces, three free tiers. The dashboard is static, the relay is a tiny
container, and Supabase is optional.

| piece | host | free tier | notes |
| --- | --- | --- | --- |
| `apps/web` | Vercel (Hobby) | 100 GB bandwidth | static build, no functions needed |
| `apps/relay-worker` | Cloudflare Workers + Durable Objects | 100k requests/day, no sleep | **recommended**: hibernates, wakes in ms |
| `apps/relay` | Render (free web service) | 750 h/month, sleeps after 15 min idle | Docker, one instance, in-memory rooms |
| database | Supabase (free) | 500 MB Postgres | only if you want accounts/history |

Both relays speak the same protocol; pick one. The Worker is the better default
because it never cold-starts, while the container host is the fallback for
people who would rather run a process they control.

---

## 1. Dashboard → Vercel

### From the CLI (what this repo was deployed with)

```bash
npm i -g vercel
vercel login
vercel deploy --prod        # from the repository root
```

`vercel.json` already sets:

- install: `npm install` (workspace-aware)
- build: `npm run build --workspace @airlock/web`
- output: `apps/web/dist`

### From the dashboard

1. **Add New… → Project → Import** `yhammou86-jpg/airlock`.
2. Framework preset: **Other**. Root directory: **/**.
3. Build command: `npm run build --workspace @airlock/web`.
   Output directory: `apps/web/dist`.
4. Add environment variable `VITE_RELAY_URL` = your relay URL (see step 2),
   for all environments. Example: `https://airlock-relay.onrender.com`.
5. Deploy.

Without `VITE_RELAY_URL` the dashboard still works; the relay field on the
Connect screen is simply empty until you paste a URL. `?relay=https://…&code=123456`
also works and is what `npm run pair` prints.

---

## 2. Relay → Cloudflare Workers (recommended)

No container, no cold start, free plan includes Durable Objects (SQLite
backed). One command deploys it:

```bash
cd apps/relay-worker
npx wrangler login        # browser OAuth, once
npx wrangler deploy       # prints https://airlock-relay.<subdomain>.workers.dev
```

Then check `https://airlock-relay.<subdomain>.workers.dev/health` →
`{"ok":true,"version":1,...}`. The relay config lives in
`apps/relay-worker/wrangler.toml`; nothing else needs to change.

Try it locally first if you like — workerd runs Durable Objects on your machine:

```bash
npm run relay:worker      # http://127.0.0.1:8789
RELAY=http://127.0.0.1:8789 npm run e2e
```

### 2b. Relay → Render (container alternative)

1. Open the blueprint:
   **https://render.com/deploy?repo=https://github.com/yhammou86-jpg/airlock**
2. Sign in with GitHub and approve access to the repository.
3. Render reads `render.yaml`, shows one free **Web service** named
   `airlock-relay`, and builds `deploy/relay/Dockerfile`.
4. Create the service. First build takes 2–4 minutes.
5. Copy the URL, e.g. `https://airlock-relay.onrender.com`, and check
   `https://airlock-relay.onrender.com/health` returns
   `{"ok":true,"version":1,...}`.

Free services sleep after 15 minutes without traffic. The first WebSocket
connect after sleep can take ~40 seconds; the dashboard retries automatically.
For an always-warm relay, Render's cheapest paid instance or any small VPS will
do — nothing else changes.

### Fly.io / Koyeb / Railway instead

```bash
fly launch --no-deploy --copy-config   # uses fly.toml + deploy/relay/Dockerfile
fly deploy
```

or build the image yourself:

```bash
docker build -f deploy/relay/Dockerfile -t airlock-relay .
docker run -p 10000:10000 airlock-relay
```

The relay listens on `$PORT` (default 8788 locally, 10000 in the image).

---

## 3. Tell the dashboard where the relay is

Vercel CLI:

```bash
vercel env add VITE_RELAY_URL production
# paste https://airlock-relay.<subdomain>.workers.dev
vercel deploy --prod
```

Dashboard UI: **Settings → Environment Variables → VITE_RELAY_URL**, then
redeploy. Vite inlines the value at build time, so a redeploy is required.

---

## 4. Optional: accounts and history (Supabase)

The product is fully usable without it. To enable history:

1. Create a project at supabase.com (free).
2. SQL editor → paste `supabase/migrations/001_init.sql` → run.
3. Copy the project URL + anon key into the dashboard build environment
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) when you add the optional
   history UI.

The migration creates `devices`, `pairings`, `sessions`, `sms_messages`,
`notifications`, `transfers` and `audit_log`, all protected by row level security
keyed on `auth.uid()`, plus a `device_overview` view. Only SHA-256 hashes of
pairing codes are stored. The relay never gets database credentials.

---

## 5. Pair a phone

On the phone agent:

1. Start the agent → note the LAN address and code, or tap **Create room** and
   type your relay URL first.
2. Approve screen capture and the permissions you want.

In the dashboard:

- **Demo device** → `ws://localhost:8787/agent` with code `123456` (reference agent).
- **LAN** → `ws://<phone-ip>:8787/agent` + the six digit code.
- **Cloud relay** → relay URL + the six digit room code.

From a terminal:

```bash
npm run pair -- --relay https://airlock-relay.<subdomain>.workers.dev --web https://airlock-rho.vercel.app
```

It prints the code, a pre-filled dashboard link, and the matching agent command.

---

## 6. Hardening checklist

- [ ] Rotate the LAN code after pairing guests.
- [ ] Serve the relay over HTTPS only (Render/Fly do this automatically).
- [ ] Do not reuse the relay room token in links; it is a bearer secret.
- [ ] Keep the dashboard and relay on the same major version.
- [ ] If you self-host the relay, restrict it to your own domain and monitor
      `/health`.
- [ ] Remember the relay can read forwarded frames. Use LAN, or your own relay,
      for traffic you would not send through a third party.
- [ ] Set `cleartextTrafficPermitted="false"` in
      `apps/android/app/src/main/res/xml/network_security_config.xml` if you
      only ever use the cloud.

## 7. What the free tiers cannot do

- Cloudflare's free plan is request-metered: a busy mirror stream spends the
  daily allowance faster than idle pairing does. Hibernation keeps idle rooms
  free, and the sockets survive it.
- Render free sleeps; a sleeping relay drops both sockets. Clients reconnect,
  but the room is re-created on the next `POST /api/pair`.
- Vercel Functions now support WebSockets, but each connection is capped
  (300 s on Hobby) and instances are not shared, so Airlock uses a relay with
  per-room state instead of function-based fan-out.
- Supabase free pauses after a week of inactivity; history is optional and
  non-blocking.
- No free host provides TURN. If you later add WebRTC mirroring, budget for a
  TURN service; JPEG-over-WebSocket needs none.
