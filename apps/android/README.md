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
| size | 10,269,963 bytes (9.8 MiB) |
| package | `dev.airlock.agent` 1.0.0, minSdk 26, targetSdk 34 |
| signing | debug keystore (`CN=Android Debug`), sideload only |
| sha256 | `7355caf2b32dfa52e0b6b99b7a071c10ea51c3a8a0ab21f915d11d6a7f70e471` |
| lint | `gradle lintDebug` — 0 errors, 19 informational warnings |

A copy is published with the dashboard at
<https://airlock-rho.vercel.app/airlock-1.0.0-debug.apk>.

The repo intentionally does not commit `gradle-wrapper.jar`; generate it once
with `gradle wrapper --gradle-version 8.7` or let Android Studio create it.

The APK is compile-verified only: this machine had no emulator or USB device
attached, so runtime behaviour (MediaProjection, accessibility injection, SMS)
is untested. Test those on hardware before relying on them.


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
