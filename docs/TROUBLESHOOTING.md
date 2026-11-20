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
  two failures; 1.0.3 also wraps `camera.shot` in the same reply watchdog as every
  other RPC, so a stuck driver can no longer leave the spinner running

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
- `fs.list` is cached on the phone for four seconds, so going back to a folder is
  instant. Listings are capped at 400 entries; larger folders return
  `truncated: true` with the real `total`, and the Files page shows a banner.
- Image previews no longer download the original. `fs.preview` renders an
  EXIF-rotated JPEG capped at 1080 px on the phone and sends it in a `PREVIEW`
  frame, so opening a photo is tens of KB instead of several MB.
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

## Mirror: “could not start capture” or the approval dialog

1.0.3 prefers silent capture through the accessibility service. Enable it once:

1. Airlock → Permissions → **Accessibility (touch + keys)** → enable Airlock.
2. Mirror again. `mirror.start` reports `capture: "accessibility"` and Android
   shows no “Start recording or casting?” dialog and no cast indicator. The same
   service also injects taps, swipes and keys.
3. Android throttles accessibility screenshots to roughly one per 333 ms, so
   silent mirroring runs at about 3 fps. That is a platform limit, not link lag.

If accessibility is off (or an OEM refuses the screenshot capability), the agent
falls back to MediaProjection:

- open Airlock on the phone and tap **Allow capture** once, or
- re-enable Accessibility, which removes the prompt entirely.

Without either, `mirror.start` returns `could not start capture` with an
explanation instead of leaving a blank screen.

### Camera snapshot spinner

Fixed in 1.0.3. `camera.shot` is now inside the reply watchdog and the client
times out after 20 seconds. A cancelled capture also unbinds CameraX in
`CameraController`, so the next attempt is not blocked by “camera in use”. Live
mode stops itself after two consecutive failures.

Android 16 may block opening Settings from the background. If the **Enable**
button reports that, open Airlock on the phone and use its Permissions card.

## Silent mode

On by default on the phone, and toggleable from the dashboard under
**Settings → Quiet operation**.

What it removes:

- the volume panel on `volume.*`
- the accessibility “no focused field” toast (the dashboard gets an error instead)
- the link notification entirely (channel importance is `NONE`, so nothing is
  drawn in the shade, status bar or lock screen; the app never asks for
  notification permission)
- the pairing code, LAN IP and socket URL from the shade and lock screen

What it cannot remove, by Android policy:

- the foreground-service notification object itself: Android requires the
  service to post one, and it may list Airlock in the Task Manager, but it is not
  displayed
- the green camera/microphone privacy dot while a capture is active
- the system permission dialogs

If a vendor build still shows its own “running in background” notice, open
Airlock → Behaviour → **Link notification → settings** and set the *Device link*
channel to **Off**. The service keeps running.

With the accessibility service enabled, mirroring needs **no** MediaProjection
approval. Android revokes only the fallback projection token after a reboot.

`find` still rings on purpose. Silent accessibility mirroring shows no cast
indicator; the MediaProjection fallback does, for as long as it is live.

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
