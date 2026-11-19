# Troubleshooting the Android agent

The 1.0.1+ agent replaces silent hangs with explicit errors. When something fails
the dashboard now shows `permission`, `timeout` or `handler_error` and the reason
instead of waiting forever. Use this page to map that reason to a fix.

## “camera.shot timed out” (1.0.0 only)

Fixed in 1.0.1. The old dashboard asked for a new photo every 1.5 s without
waiting, while the phone captured full-resolution JPEGs and queued them ahead of
every other reply. On a mobile uplink that starved files, SMS and notifications
too.

1.0.1 changes the contract:

- one capture at a time; a second request gets `handler_error: camera is busy`
- the JPEG is capped at 1440 px on the long edge, quality 72
- the JSON reply is sent before the image bytes
- the dashboard waits for each frame before asking again and stops “live” after
  three failures

If it still fails, the message now says why:

| message | fix |
| --- | --- |
| `camera permission is not granted` | Airlock → Permissions → **Camera snapshots** → grant |
| `camera is busy with the previous snapshot` | wait a second; close other camera apps |
| `camera did not deliver a frame within 20s` | close other camera apps, lock/unlock the phone, restart the agent |
| `camera capture failed: …` | the driver rejected the request; try the other lens |

Android 14+ also needs the camera foreground-service notification. It is created
automatically when the first snapshot runs.

## “sms.threads timed out” / SMS permission

`READ_SMS` and `SEND_SMS` are restricted permissions. The agent checks them
before touching the provider, so 1.0.1 returns:

> SMS read permission is not granted — open Airlock on the phone and tap grant
> next to “SMS read + send”

If the grant dialog never appears or stays denied on Android 16, grant over USB
once (debug-signed sideload build):

```bash
adb shell pm grant dev.airlock.agent android.permission.READ_SMS
adb shell pm grant dev.airlock.agent android.permission.SEND_SMS
```

Then force-stop and reopen Airlock. Sending also needs an active SIM.

## Notifications: empty feed or timeout

The feed comes from a `NotificationListenerService`, not from the notification
permission.

1. Airlock → Permissions → **Notification access** → enable Airlock.
2. Open the dashboard Notifications page; 1.0.1 shows an **Enable** button that
   opens that settings screen on the phone.
3. New posts stream live. Existing posts are ingested when the listener connects.

If `notif.list` still returns `permission`, the listener was revoked or the
service was killed — reopen Airlock and re-enable it.

## Files: empty folder or timeout

- With **Browse all storage** the root is `/storage/emulated/0` (Downloads, DCIM,
  …).
- Without it the root is the app's own folder
  `/sdcard/Android/data/dev.airlock.agent/files`. That is deliberate scoping,
  not a failure. The Files page now shows a banner with a **Grant** button.
- `fs.list` has a 45 s client timeout; a folder with thousands of entries can be
  slow the first time. The agent caps listings at 1000 entries.
- Downloads stream in 64 KiB frames and share the socket with mirror frames. The
  agent pauses when the outgoing queue exceeds 1.5 MB; the client allows 10
  minutes for a download. Stop the mirror before moving very large files.
- Uploads verify SHA-256 on the phone; a mismatch deletes the partial file and
  returns `ok: false`.

## Mirror is view-only / taps do nothing

Gesture and key injection requires the accessibility service:

1. Airlock → Permissions → **Accessibility (touch + keys)** → enable Airlock.
2. Or use the dashboard warning strip → **Enable** (1.0.1 opens the right screen
   when Android allows a background activity start).
3. `mirror.start` also returns `control: true|false`; the dashboard uses it to
   show the banner immediately.

Screen mirroring itself needs **Allow capture** once per session (Android
revokes MediaProjection after a reboot). Without it `mirror.start` returns
`screen capture not approved`.

Android 16 may block opening Settings from the background. If the **Enable**
button reports that, open Airlock on the phone and use its Permissions card.

## Silent mode

On by default on the phone, and toggleable from the dashboard under
**Settings → Quiet operation**.

What it removes:

- the volume panel on `volume.*`
- the accessibility “no focused field” toast (the dashboard gets an error instead)
- the status-bar icon for the link (channel importance is `MIN`)
- the pairing code, LAN IP and socket URL from the shade and lock screen

What it cannot remove, by Android policy:

- the foreground-service entry itself (minimum importance, so it is a silent
  shade line with no icon). On Android 13+ you can additionally deny
  **Notifications** for Airlock: the service keeps running and the shade entry
  disappears completely.
- the MediaProjection “Start recording or casting?” approval, once per session
- the green camera/microphone privacy dot while a capture is active
- the system permission dialogs

`find` still rings on purpose. Screen mirroring shows the system cast indicator
for as long as the projection is live.

1.0.2 also switches the foreground service from `dataSync` to `specialUse` on
Android 14+, because Android 15+ stops `dataSync` services after six hours.
That keeps an idle agent reachable all day without extra notifications.

## Link keeps reconnecting

- Cloud: check the relay URL. The default is
  `https://airlock-relay.y-hammou86.workers.dev`. Create a new room on the phone
  if the old room expired, then pair with the new six-digit code.
- LAN: the phone and browser must be on the same network and the phone must allow
  inbound connections on port 8787. Some guest Wi-Fi networks block peer traffic.
- Battery optimisation can kill the agent. Grant **Battery unrestricted** in the
  Permissions card.

## Collecting a useful report

The dashboard’s Overview log shows every `event:log` from the phone, including
`<method> failed: <reason>` and slow-call warnings over 2 s. Include the last few
lines plus the phone model, Android version and whether the connection was LAN or
cloud.
