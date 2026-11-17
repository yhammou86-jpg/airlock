# Airlock

**Remote device access with the door bolted shut.**

Airlock is an open-source, self-hostable alternative to AirDroid: a browser
dashboard, a tiny WebSocket relay, and a phone agent. Pair with a six digit code,
then browse files, mirror the screen, tap and type, read SMS, follow
notifications and grab camera snapshots. No account, no ads, no telemetry.

- Dashboard: <https://airlock-rho.vercel.app>
- Relay: <https://airlock-relay.y-hammou86.workers.dev> (`/health` for status)
- Source: <https://github.com/yhammou86-jpg/airlock>
- License: MIT

The design comes from a clean-room teardown of AirDroid 4.3.12.0 — read
[how AirDroid actually works](./docs/HOW-AIRDROID-WORKS.md), then
[how Airlock differs](./docs/ARCHITECTURE.md).

## Features

| | LAN | Cloud relay |
| --- | --- | --- |
| Pair with a six digit code | yes | yes |
| Browse, upload, download, rename, delete files | yes | yes |
| Live screen mirror (JPEG frames) | yes | yes |
| Tap, swipe, long-press, keys, text input | yes | yes |
| SMS threads, read and send | yes | yes |
| Notification feed, dismiss, inline reply | yes | yes |
| Front/back camera snapshot | yes | yes |
| Battery, CPU, memory, storage, network | yes | yes |
| Volume, torch, wake, lock, find phone, clipboard | yes | yes |
| Cloud account or history | not needed | not needed |

## Try it in 60 seconds

```bash
npm install
npm run dev          # relay :8788, demo phone :8787, dashboard :5173
```

Open <http://localhost:5173/?demo=1>. You are connected to the reference agent,
which fakes a phone with a real filesystem sandbox, real uploads/downloads, a
rendered screen, seeded SMS and notifications.

Create a cloud room and watch the whole WAN path locally:

```bash
npm run pair         # prints a code + pre-filled dashboard link
```

Then start a second device in that room (the command is printed for you) and
open the link.

## Deploy for free

Three pieces, all free tier:

1. **Dashboard** → Vercel (static). `vercel deploy --prod`.
2. **Relay** → Cloudflare Workers (Durable Objects, no sleep):
   `cd apps/relay-worker && npx wrangler login && npx wrangler deploy`.
   Prefer a container? Render's blueprint is one click too:
   <https://render.com/deploy?repo=https://github.com/yhammou86-jpg/airlock>.
3. **History (optional)** → Supabase. Run `supabase/migrations/001_init.sql`.

Set `VITE_RELAY_URL` on Vercel to the relay URL and redeploy. Full steps,
alternatives (Fly/Koyeb/Railway), the hardening checklist and the honest limits
of each free tier are in [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Repository layout

```
apps/web          dashboard — Vite + React + TypeScript, hand-written CSS
apps/relay        relay — Node + ws, pairing API, room routing
apps/agent        reference phone — Node, fakes screen/camera/SMS; protocol spec
apps/android      real phone agent — Kotlin, Compose, CameraX, NanoWSD
packages/protocol one dependency-free file shared by all of the above
scripts/dev.mjs   run the whole stack
scripts/pair.mjs  create a room from the CLI
scripts/e2e.mjs   22 protocol assertions against a live agent + relay
docs/             teardown, protocol, architecture, deployment
supabase/         optional accounts + history schema with RLS
```

## Phone agent

`apps/android` is a complete Gradle/Kotlin project implementing the same
messages as the reference agent: NanoWSD LAN server, OkHttp relay client,
MediaProjection mirroring, accessibility input, SMS provider, notification
listener, CameraX snapshots, foreground service.

It must be sideloaded because `READ_SMS`, `SEND_SMS` and
`MANAGE_EXTERNAL_STORAGE` are not grantable on Google Play. Build instructions
and the permission rationale are in
[`apps/android/README.md`](./apps/android/README.md).

A compiled debug build is available for direct download:

| build | size | package |
| --- | --- | --- |
| [Airlock 1.0.0 (debug)](https://airlock-rho.vercel.app/airlock-1.0.0-debug.apk) | 9.7 MiB | `dev.airlock.agent`, minSdk 26, targetSdk 34 |

It is debug-signed with the standard Android debug keystore, which is fine for
sideloading but not for a store. Open the link on the phone and allow installs
from the browser, or `adb install -r airlock-1.0.0-debug.apk`.

## Test

```bash
npm run dev        # in one terminal (or start agent + relay separately)
npm run e2e        # in another
```

The suite checks pairing rejection, hello/capabilities, filesystem listing,
checksum-verified download and upload, mirror frames, SMS, notifications, stats,
and every relay path (claim, single-use codes, routing both ways, binary frames,
room rejection, health).

## Security posture

- Six digit codes are single use with a 10 minute TTL; rooms use 24-byte tokens.
- The relay stores nothing: no files, no database, no logs of payloads.
- SMS and all-files permissions are individually opt-in on the phone.
- Accessibility is used for gesture injection only, never to read content.
- TLS protects the relay hop, but the relay process can read frames. Run your
  own relay (Docker included) if that matters to you.
- No telemetry, no analytics, no third-party fonts or scripts.

## Limits

- Mirroring is JPEG over WebSocket: 3–10 fps on Wi-Fi, no audio. WebRTC/H.264 is
  the documented upgrade path.
- Clipboard reads are blocked by Android while another app is focused.
- SMS uses the default SIM.
- The reference agent is a simulation; it is not a phone emulator.

## License

MIT. Airlock contains no code, assets, protocol constants or trademarks from
AirDroid or Sand Studio.
