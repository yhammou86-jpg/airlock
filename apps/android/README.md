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

You need JDK 17 and Android SDK 34. Easiest path is Android Studio (Ladybug or
newer):

1. **File → Open** → `apps/android`.
2. Let Gradle sync (it downloads the wrapper through Android Studio).
3. Run the `app` configuration on a device with USB debugging enabled.

Command line, if your machine already has Gradle 8.7+:

```bash
cd apps/android
gradle wrapper --gradle-version 8.7   # creates gradlew + wrapper jar
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The repo intentionally does not commit `gradle-wrapper.jar`; generate it once
with the command above or let Android Studio create it.

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
- The agent cannot be built in this workspace: no JDK/Android SDK was available.
  The source is complete and mirrors the protocol that *was* tested end-to-end
  against the Node reference agent.
