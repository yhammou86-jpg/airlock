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
| size | 10,283,746 bytes (9.8 MiB) |
| package | `dev.airlock.agent` 1.0.1 (versionCode 2), minSdk 26, targetSdk 34 |
| signing | debug keystore (`CN=Android Debug`), sideload only |
| sha256 | `ed820155a9e96dffdd80bc66401a9c748868129ff145fdfadf44c718a0a65ccd` |
| lint | `gradle lintDebug` — 0 errors, 20 informational warnings |

A copy is published with the dashboard at
<https://airlock-rho.vercel.app/airlock-1.0.1-debug.apk>.

The repo intentionally does not commit `gradle-wrapper.jar`; generate it once
with `gradle wrapper --gradle-version 8.7` or let Android Studio create it.

The APK is compile-verified only: this machine had no emulator or USB device
attached, so runtime behaviour (MediaProjection, accessibility injection, SMS)
is untested. Test those on hardware before relying on them.

### Reliability and silent mode

The 1.0.1 build fixes the “everything times out” failure mode on mobile links:

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
- **Silent mode** (on by default in the phone app) suppresses volume-panel pops
  and accessibility toasts. Android still requires the foreground-service
  notification for camera and screen capture; that one cannot be hidden.
- The dashboard no longer polls the camera on a fixed timer: it waits for each
  frame before asking for the next one and stops “live” after three failures.

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
