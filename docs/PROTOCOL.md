# Airlock wire protocol (v1)

One WebSocket carries two kinds of traffic:

| kind | format | used for |
| --- | --- | --- |
| text | JSON envelope | RPC, events, presence |
| binary | 16-byte header + payload | screen frames, camera frames, file chunks |

The contract lives in [`packages/protocol/protocol.js`](../packages/protocol/protocol.js)
and is duplicated in Kotlin in `apps/android/.../Protocol.kt`. Nothing in it is
copied from AirDroid; it is a clean-room design derived from the feature list in
[`HOW-AIRDROID-WORKS.md`](./HOW-AIRDROID-WORKS.md).

## 1. Connections

### LAN

```
ws://<phone-ip>:8787/agent        (the WebSocket)
http://<phone-ip>:8787/health     (discovery: { ok, device, name, clients })
```

The first message must be:

```json
{ "v": 1, "id": "x1", "type": "auth", "data": { "code": "123456" } }
```

A wrong code gets `error.code = "bad_code"` and a close frame `4003`. A correct
code is answered with `res:auth` followed by `hello` and an `event:stats`.

The code can also be supplied as `?code=123456` on the URL; the in-band message
is still required so the code never appears in proxy logs.

### Cloud relay

```
wss://<relay>/ws?role=device|controller&room=<room>&token=<token>
```

`role=device` is a phone, `role=controller` is a browser. The relay validates the
room token, forwards frames to the other side, and caches the device's `hello`
so a controller that joins late still sees the device name. Cloud peers are
authenticated by the token and do not send `auth`.

Max three controllers per room. Pairing codes are six digits, single use, and
expire after ten minutes (`POST /api/pair`, `POST /api/pair/claim`).

## 2. Text envelopes

```json
{ "v": 1, "id": "lz3k-1", "ts": 1730000000000, "type": "fs.list", "data": { "path": "/" } }
```

```json
{ "v": 1, "id": "lz3k-1-r", "replyTo": "lz3k-1", "ts": 1730000000100,
  "type": "res:fs.list", "ok": true, "data": { "path": "/", "entries": [] } }
```

Failures keep the same shape with `"ok": false` and

```json
{ "error": { "code": "handler_error", "message": "is a directory" } }
```

`type` for events is prefixed: `event:stats`, `event:log`, `event:notif`,
`event:sms`. Events have no `id` and are fire-and-forget.

Error codes: `bad_code`, `unauthorized`, `unknown_type`, `handler_error`,
`permission`, `timeout`, `bad_request`.

Handlers are single-flight per request with a watchdog: 25 seconds by default,
15 minutes for `fs.download`. A handler that hangs or dies returns `timeout` or
`handler_error` with a message instead of leaving the client to time out. A
missing permission returns `permission` with the setting to grant.

### hello

Sent by the device on attach (and re-sent on `auth`):

```json
{ "type": "hello", "data": {
  "device": { "id": "demo-3f8a1c", "name": "Pixel 8", "model": "Pixel 8",
              "android": "14", "agent": "airlock-android/1.0.2",
              "ip": "192.168.1.24", "port": 8787 },
  "capabilities": ["device.stats", "fs.list", "mirror.start", "..."],
  "permissions": { "camera": true, "smsRead": false, "smsSend": false,
                   "notifications": true, "accessibility": false,
                   "allFiles": true, "battery": false },
  "silent": true } }
```

`permissions` is the phone's live grant state and `silent` is its UI policy.
Both are re-sent whenever the phone returns to the Airlock app, so the dashboard
can turn missing grants into actionable buttons.

`capabilities` is advisory: clients should disable controls missing from it.

### event:stats (every 2 s)

```json
{ "battery": 87, "charging": false, "volume": 7, "muted": false, "cpu": 12.4,
  "mem": { "total": 8589934592, "free": 3221225472 },
  "storage": { "total": 128000000000, "used": 64000000000, "free": 64000000000 },
  "network": { "type": "wifi", "ssid": "lab", "ip": "192.168.1.24", "signal": 0 },
  "uptime": 18422, "time": 1730000000 }
```

### event:log / event:notif / event:sms

```json
{ "level": "info", "message": "upload ok · /welcome.txt · 108 B" }
{ "id": "0|com.app|42|null|10123", "app": "Messages", "title": "Ada",
  "body": "see you at 8", "ts": 1730000000000, "canReply": true }
{ "threadId": "17", "message": { "id": "m12", "from": "me", "body": "hi", "ts": 1730000000000 } }
```

## 3. RPC methods

Coordinates in `input.*` are normalised `0..1` relative to the captured frame, so
the browser never needs to know the phone's pixel size.

| method | request data | response data |
| --- | --- | --- |
| `device.stats` | `{}` | same shape as `event:stats` |
| `device.action` | `{ action, value? }` | `{ action, ok }` or `{ text }` |
| `device.permission` | `{ permission }` | `{ opened }` — opens the matching Settings screen |
| `fs.list` | `{ path }` | `{ path, entries[], allFiles, root }` |
| `fs.mkdir` | `{ path, name }` | `{ created }` |
| `fs.rename` | `{ path, name, newName }` | `{ path }` |
| `fs.delete` | `{ paths: [] }` | `{ deleted }` |
| `fs.upload.begin` | `{ path, name, size, sha256 }` | `{ uploadId, path }` |
| `fs.upload.done` | `{ uploadId, sha256 }` | `{ path, size, sha256, ok }` |
| `fs.download` | `{ path }` | `{ name, size, sha256 }` after binary frames |
| `mirror.start` | `{ fps, quality, maxWidth }` | `{ fps, quality, control, silent }` |
| `mirror.stop` | `{}` | `{ ok }` |
| `input.tap` | `{ x, y }` | `{ tapped }` |
| `input.swipe` | `{ x1, y1, x2, y2, ms }` | `{ swiped }` |
| `input.longpress` | `{ x, y, ms }` | `{ ok }` |
| `input.key` | `{ key }` | `{ ok }` |
| `input.text` | `{ text }` | `{ ok }` |
| `sms.threads` | `{}` | `{ threads[] }` |
| `sms.messages` | `{ threadId }` | `{ thread, messages[] }` |
| `sms.send` | `{ threadId?, to, body }` | `{ message, threadId }` |
| `notif.list` | `{}` | `{ notifications[] }` |
| `notif.dismiss` | `{ id }` | `{ dismissed }` |
| `notif.reply` | `{ id, text }` | `{ sent }` |
| `camera.shot` | `{ lens: "back"\|"front" }` | `{ lens, ts, width, height, bytes }` then one binary frame |
| `apps.list` | `{}` | `{ apps[] }` |
| `apps.launch` | `{ pkg }` | `{ launched }` |

`camera.shot` always sends the JSON reply first and the JPEG immediately after,
so the request that produced the image is settled before the large frame is
queued. The Android agent caps the JPEG at 1440 px on the long edge and rejects
overlapping captures with `handler_error`. Mirror frames are best-effort: the
agent drops them while its socket backlog exceeds 512 KB rather than delaying
request/response traffic.

File entry:

```json
{ "name": "welcome.txt", "path": "/welcome.txt", "dir": false,
  "size": 108, "mtime": 1730000000000, "kind": "text", "mime": "text/plain" }
```

`kind` is one of `folder`, `image`, `video`, `audio`, `text`, `archive`, `apk`,
`file`. `mtime` is milliseconds (what `new Date()` expects in the dashboard).

SMS thread: `{ id, name, address, unread, preview, ts }`.
SMS message: `{ id, from: "me"|"them", body, ts }`.
Notification: `{ id, app, title, body, ts, canReply }`.

`device.action` values:

| action | effect |
| --- | --- |
| `volume.up` / `volume.down` / `volume.mute` | music stream |
| `media.play` / `media.pause` | media key dispatch |
| `flashlight` | torch toggle |
| `wake` | brief screen wake lock |
| `lock` | accessibility lock action (Android 9+) |
| `find` | ring at full volume for 8 s |
| `silent.on` / `silent.off` / `silent.toggle` | phone UI policy; returns `{ silent }` |
| `clipboard.get` / `clipboard.set` | `{ text }` |
| `light`/`dark` (dashboard only) | not sent to the device |

Silent mode is a device-side policy. When on, volume changes pass no
`FLAG_SHOW_UI`, accessibility failures return an error instead of a toast, the
foreground-service entry uses minimum importance (no status-bar icon, no sound,
hidden on the lock screen) and omits the pairing code and IP. Android still
requires that entry and the per-session MediaProjection approval; neither can be
removed without root. The camera/microphone privacy indicator is system-owned.

`input.key` accepts `home`, `back`, `recents`, `notifications`, `lock`,
`backspace`, `enter`. `power` is rejected on unrooted devices.

## 4. Binary frames

```
offset 0      1      2        3       4       5       6   7      8..11        12..15
       'A'    'D'    version  kind    codec   flags   rsv rsv    stream u32   ts u32
```

All integers little-endian. `payload` is everything after byte 15.

| kind | name | payload |
| --- | --- | --- |
| 1 | `MIRROR` | one encoded screen frame |
| 2 | `CAMERA` | one snapshot |
| 3 | `UPLOAD` | next chunk of a file, in order |
| 4 | `DOWNLOAD` | next chunk of a file, in order |
| 5 | `AUDIO` | reserved |

| codec | payload | |
| --- | --- | --- |
| 1 | JPEG | phone and reference agent |
| 2 | WEBP | reserved |
| 3 | SVG | reference agent's simulated screen only |
| 4 | PNG | reserved |

### Upload

1. Controller → `fs.upload.begin { path, name, size, sha256 }`.
2. Controller sends `UPLOAD` frames of **at most 64 KiB** payload each.
3. Controller → `fs.upload.done { uploadId, sha256 }`.
4. Device streams into `<name>.part`, verifies SHA-256, renames on success and
   returns `ok:false` on mismatch (the partial file is deleted).

### Download

1. Controller → `fs.download { path }`.
2. Device sends `DOWNLOAD` frames until the file ends, then answers the RPC with
   `{ name, size, sha256 }`. The response is the end-of-stream marker, so the
   controller must attach its frame listener **before** sending the request.

### Mirror

1. `mirror.start` enables the capture pipeline for that peer.
2. Frames arrive as `MIRROR` with codec 1 at roughly the requested fps.
3. `mirror.stop` (or disconnect) releases the capture when the last viewer goes.

Capture is shared: five viewers cost one MediaProjection session.

## 5. Relay HTTP API

```
GET  /health                 → { ok, version, rooms, waiting, uptime, host }
POST /api/pair               → { code, room, token, expiresAt }
POST /api/pair/claim {code}  → { room, token }        (single use, 10 min)
```

Rooms are in memory, reaped ten minutes after they go idle. The relay never
reads payloads beyond the JSON `type`/`hello` cache, never stores files, and
never terminates TLS itself when deployed behind Render/Fly.

The Cloudflare Workers build in `apps/relay-worker` serves the same four routes
with identical status codes and bodies, except that `/health` reports
`"waiting": null` and `"uptime": null` (a Worker has no process to ask). Rooms
live in a Durable Object each, which is why a late controller still receives the
cached `hello`.

## 6. Compatibility notes

- Unknown `type` values must fail with `unknown_type`, not close the socket.
- New fields are additive; clients must ignore what they do not know.
- The reference agent (`apps/agent`) fakes the phone: SVG screen, fake camera,
  seeded SMS. It is the executable specification for this document.
- `npm run e2e` checks the contract end-to-end (22 assertions).
