# Airlock for Android

The phone-side agent. It implements the exact message set the browser dashboard
and the reference agent speak, so a real device and `apps/agent` are
interchangeable.

```
app/src/main/java/dev/airlock/agent/
  Protocol.kt             wire envelopes + 16-byte binary header
  LanServer.kt            NanoWSD WebSocket server on :8787 (+ /health)
  CloudLink.kt            OkHttp WebSocket to the relay, backoff reconnect
  DeviceCore.kt           all RPC handlers (files, mirror, input, SMS, ...)
  ScreenCapture.kt        MediaProjection → VirtualDisplay → ImageReader → JPEG
  CameraController.kt     CameraX one-shot snapshots
  KeyAccessibilityService gestures, keys, text injection
  NotifListener.kt        NotificationListenerService → dashboard feed
  SmsStore.kt             content://sms read + SmsManager send
  FsStore.kt              path-scoped file access
  DeviceService.kt        foreground service owning everything
  MainActivity.kt         Compose pairing / permission console
  ProjectionActivity.kt   one-tap MediaProjection consent
```

## Build

Requires JDK 17 and Android SDK 34 (build-tools 34.0.0). No Android Studio
needed; any of these work:

```bash
cd apps/android
echo "sdk.dir=/path/to/android-sdk" > local.properties
gradle assembleDebug          # or ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` is gitignored — each machine writes its own SDK path.

### Verified build

This tree has been compiled for real, not just reviewed:

| item | value |
| --- | --- |
| command | `gradle assembleDebug` (Gradle 8.7, JDK 17.0.21, AGP 8.5.2) |
| output | `app/build/outputs/apk/debug/app-debug.apk` |
| size | 10,312,255 bytes (9.8 MiB) |
| package | `dev.airlock.agent` 1.0.3 (versionCode 4), minSdk 26, targetSdk 34 |
| signing | debug keystore (`CN=Android Debug`), sideload only |
| sha256 | `d7d46e3cb1284cca004f32b6aa89ad81ab7277111c22004f1a627d606bff3533` |
| lint | `gradle lintDebug` — 0 errors, 20 informational warnings |

A copy is published with the dashboard at
<https://airlock-rho.vercel.app/airlock-1.0.3-debug.apk>.

The repo intentionally does not commit `gradle-wrapper.jar`; generate it once
with `gradle wrapper --gradle-version 8.7` or let Android Studio create it.

The APK is compile-verified only: this machine had no emulator or USB device
attached, so runtime behaviour (accessibility screenshots, MediaProjection,
accessibility injection, SMS) is untested. Test those on hardware before relying
on them.

### Reliability and silent mode

The 1.0.1+ builds fix the “everything times out” failure mode on mobile links:

- `camera.shot` is single-flight, downsizes to a 1440 px JPEG (quality 72) and
  sends the JSON reply **before** the image bytes, so a photo can never sit in
  front of other replies in the socket queue.
- Every RPC has a watchdog (25 s, downloads 15 min). If a handler dies or hangs,
  the dashboard gets `timeout` / `handler_error` with the real reason instead of
  silence. Handler failures are caught as `Throwable`, so coroutine crashes no
  longer look like network timeouts.
- Mirror frames are dropped while the socket backlog is above 512 KB, and file
  downloads pause when the queue is above 1.5 MB.
- SMS, notification, camera and storage handlers check permissions first and
  return `permission` errors that say exactly which row to grant.
- **Silent mirroring.** On Android 11+ with the accessibility service enabled,
  frames come from `AccessibilityService.takeScreenshot()`. There is no
  MediaProjection approval dialog, no cast indicator and no per-session prompt;
  Android throttles the API to ~3 fps. MediaProjection remains the fallback when
  accessibility is off. 1.0.3 also stops the silent stream cleanly when the
  service is revoked.
- **Silent mode** (on by default, also toggled from the dashboard) suppresses
  volume-panel pops and accessibility toasts, and reduces the link notification
  to minimum importance: no status-bar icon, no sound, no lock-screen content,
  and no pairing code or IP in the shade. Denying Notifications on Android 13+
  removes even that line while the service keeps running. The foreground-service
  entry itself is required by Android and cannot be removed without root.
- The foreground service uses `specialUse` on Android 14+ instead of `dataSync`,
  so Android 15/16 does not stop it after six hours.
- Directory listings are cached for four seconds and capped at 400 entries with
  `total`/`truncated`; the browser also paints cached folders immediately.
  `fs.preview` renders a 1280 px EXIF-rotated JPEG on the phone, so opening a
  photo transfers tens of KB instead of the original.
- `camera.shot` also runs inside the reply watchdog now, and a cancelled capture
  unbinds CameraX. The dashboard waits for each frame before asking for the next
  one and stops “live” after two failures.

If SMS still returns a permission error after tapping **grant**, some Android 16
builds treat `READ_SMS`/`SEND_SMS` as restricted for sideloaded apps. Grant them
over USB once:

```bash
adb shell pm grant dev.airlock.agent android.permission.READ_SMS
adb shell pm grant dev.airlock.agent android.permission.SEND_SMS
```


## First run

1. **Start agent** — a foreground notification appears with the LAN address and
   a six digit code.
2. **Allow capture** — the system MediaProjection dialog. Needed only for screen
   mirroring; it must be re-approved after a reboot.
3. **Grant** — Accessibility (gestures/keys), Notification access, Camera, SMS
   and optionally "Browse all storage".
4. Open the dashboard, pick the **LAN** tab, paste `ws://<phone-ip>:8787/agent`
   and the code. For remote access, **Create room** on the phone, then type the
   code under the dashboard's **Cloud relay** tab.

Without "Browse all files", the file browser root is
`/sdcard/Android/data/dev.airlock.agent/files` — still a real, bidirectional
folder. Granting all-files moves the root to `/sdcard`.

## Why sideload

`READ_SMS`, `SEND_SMS`, `MANAGE_EXTERNAL_STORAGE` and `QUERY_ALL_PACKAGES` are
restricted or policy-gated on Google Play. Airlock is distributed as source and
debug APKs, exactly like other self-hosted device tooling. Review every
permission before installing.

## Deliberate limits

- Screen mirroring sends JPEG frames (no H.264) to keep the app dependency-free.
  Expect 3–10 fps on Wi-Fi depending on resolution.
- Input injection requires the accessibility service; `power` and system-level
  keys need root or device-owner privileges.
- Clipboard reads are blocked by Android 10+ while another app is focused.
- SMS sending uses the default SIM only.
