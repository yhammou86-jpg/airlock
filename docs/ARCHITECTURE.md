# Airlock architecture

Airlock is three small programs that share one wire format:

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  apps/web  (static)      │        │  apps/android            │
│  Vite + React dashboard  │        │  Kotlin agent            │
│  Vercel / Pages / any CDN│        │  phone, sideloaded       │
└────────────┬─────────────┘        └────────────┬─────────────┘
             │ WebSocket                        │ WebSocket
             │                                  │
      ┌──────┴───────────────┬──────────────────┘
      │                      │
 LAN │ ws://phone:8787      │ WAN (wss)
      │                      │
┌─────┴──────────────┐  ┌────┴──────────────────────────────┐
│ NanoWSD server     │  │ apps/relay (Node + ws)            │
│ inside the phone   │  │ Render / Fly / Koyeb / Docker     │
│ (apps/agent mirrors│  │ stateless rooms, no file storage  │
│  it on the desktop)│  └───────────────────────────────────┘
└────────────────────┘
             │
             │ optional, never required
      ┌──────┴───────────────┐
      │ Supabase             │
      │ accounts + history   │
      └──────────────────────┘
```

## Why this split

| concern | choice | reason |
| --- | --- | --- |
| dashboard hosting | static files on Vercel | free, fast, no server to keep alive |
| relay hosting | Cloudflare Workers + Durable Objects (or a Node container) | WebSockets need a persistent connection; a Durable Object per room gives one without an always-on server |
| phone transport | embedded WebSocket | no cloud dependency on the same Wi-Fi, and the same protocol over WAN |
| media | JPEG frames over the same socket | works everywhere, no codec negotiation, easy to audit; H.264/WebRTC is a future upgrade |
| files | chunked binary frames | no S3, no bucket, no retention; bytes go phone ↔ browser |
| state | in memory | the relay cannot leak what it never stores |

## Message flow: pair on LAN

```
browser                       phone (LAN server)              capture
   │  ws://ip:8787/agent             │                           │
   ├───────────────open─────────────►│                           │
   ├──── {"type":"auth",code} ──────►│ compare with prefs code   │
   │◄──── res:auth + hello + stats ──┤                           │
   ├──── {"type":"mirror.start"} ───►│                           │
   │                                 ├──── MediaProjection ─────►│
   │◄──── binary MIRROR (JPEG) ──────┤◄─── ImageReader ──────────┤
   ├──── {"type":"input.tap",x,y} ──►│ AccessibilityService      │
   │                                 ├──── dispatchGesture ─────►│
```

## Message flow: pair through the relay

1. Phone: `POST /api/pair` → `{ code, room, token }`, shows `code`.
2. Browser: user types `code`; `POST /api/pair/claim` → `{ room, token }`.
3. Both open `wss://relay/ws?role=…&room=…&token=…`.
4. Relay caches the phone's `hello`, forwards everything else verbatim, and caps
   a room at three controllers.
5. Phone and browser speak the same protocol as on LAN. The relay has no
   application logic, no database and no file storage.

## Security model

- **Pairing**: six random digits, single use, ten minute TTL, constant-time-ish
  room token of 24 random bytes. A LAN code can be rotated from the phone.
- **Transport**: `wss://` to the relay (TLS terminated by the host), `ws://` on
  the LAN because there is no CA for `192.168.x.x`.
- **Relay visibility**: TLS protects the hop, but the relay process can read the
  frames it forwards. It is deliberately small and self-hostable; if you do not
  trust a relay you do not control, use LAN or run your own (`fly.toml`,
  `render.yaml`, `Dockerfile` included).
- **At rest**: nothing. No accounts, no telemetry, no analytics, no CDN fonts.
  `localStorage` holds only the last connection target.
- **Phone permissions**: SMS and all-files access are the dangerous ones and are
  opt-in individually in the agent UI. The accessibility service injects
  gestures only; it never reads window contents.
- **Audit**: every RPC is a small JSON object, so a proxy or `wireshark` on your
  own LAN can show exactly what the dashboard asked for.

Not implemented on purpose: end-to-end payload encryption, remote unauthenticated
access, screen recording to disk, and any upload to a third party.

## Compared with the AirDroid build we analysed

| area | AirDroid 4.3.12.0 (observed) | Airlock |
| --- | --- | --- |
| LAN server | `libadjServer.so`, asio HTTP/WebSocket | NanoWSD, same request shape |
| mirroring | `libvncServer.so` RFB over WebSocket + MediaProjection | JPEG frames over the same socket |
| WAN | WebRTC (`libjingle_peerconnection_so.so`), STUN/TURN, `:push` process | room relay, no WebRTC |
| input | `/dev/uinput`, `vnc.RemoteInputMethodService` | AccessibilityService gestures |
| files | HTTP + S3 upload services | binary frames, no cloud bucket |
| notifications/SMS | NotificationListenerService + telephony | same platform APIs |
| auth | account + QR + device cert | code → room token, no account |
| payload protection | DexProtector, cert pinning, encrypted assets | open source, auditable |

The full teardown, including which claims are observed vs inferred, is in
[`HOW-AIRDROID-WORKS.md`](./HOW-AIRDROID-WORKS.md).

## Repository map

```
apps/web        dashboard (React, no UI framework)
apps/relay      WebSocket relay + pairing API (Node, for containers)
apps/relay-worker  same relay on Cloudflare Workers + Durable Objects
apps/agent      reference phone (Node) — executable spec for the Android app
apps/android    real phone agent (Kotlin, Compose)
packages/protocol   the only shared code: framing + envelope helpers
scripts/dev.mjs     relay + agent + dashboard in one terminal
scripts/pair.mjs    create a cloud room from the CLI
scripts/e2e.mjs     22-assertion protocol test
supabase/migrations optional accounts/history schema with RLS
```
