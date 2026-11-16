# How AirDroid 4.3.12.0 works

A static, evidence-based teardown of the shipped artifact
`AirDroid_+File+&_Remote+Access_4.3.12.0.xapk`.

Everything below is either **observed** (read directly out of the package),
**inferred** (a conclusion drawn from several observations) or **unknown**
(not recoverable without running the app). No part of this document comes from
AirDroid's marketing copy except where it is labelled as such.

---

## 1. The artifact

| Fact | Value |
| --- | --- |
| Package | `com.sand.airdroid` |
| Version | `4.3.12.0` (`versionCode` 40312001) |
| minSdk / targetSdk | 26 / 36 |
| XAPK splits | `com.sand.airdroid.apk` (43.8 MB) + `config.arm64_v8a.apk` (15.7 MB) |
| Native ABI shipped | arm64-v8a only |
| DEX files | **one**, `classes.dex`, **3,180 bytes** |
| Resources | 3,365 files, all encrypted |
| Signing | v1/v2, single signer |

That single 3 KB DEX is the most important fact in this teardown.

### 1.1 The app is hardened with DexProtector

The only Java code in the package is a bootstrap stub:

```
Lcom/sand/airdroid/ProtectedSandApp;
dexprotector
loadLibrary
Certificate mismatch. Expecting sha256[...
Package is signed by multiple signing certificates [
```

`ProtectedSandApp` extends `Application`, checks its own signing certificate
against a hard-coded SHA-256, calls `System.loadLibrary(...)` (`libdexprotector.so`),
and hands the real application to the native loader. `assets/assets.dat`
(23 MB) and every file under `assets/assets/` are high-entropy ciphertext —
including `dnsconfig.ini`, `connect.json` and the JS bundles.

**Consequence:** the business logic (protocol handlers, API clients, crypto,
account model) is not statically readable. Anyone who wants it must dump the
decrypted DEX from a running process. This teardown therefore reconstructs the
architecture from three things that *are* readable:

1. the binary `AndroidManifest.xml` (component/feature inventory),
2. the native libraries (they contain unencrypted engine strings),
3. the asset/ABI split and permission set.

---

## 2. Feature map from the manifest

The component names are unusually descriptive, so the feature set can be
recovered almost completely.

### Screen mirroring / remote control

```
activity  com.sand.airdroid.virtualdisplay.InitVirtualDisplayActivity
service   com.sand.airdroid.virtualdisplay.VirtualDisplayService
service   com.sand.airdroid.vnc.RotationListenerService
service   com.sand.airdroid.vnc.RemoteInputMethodService
service   com.sand.airdroid.vnc.ImeBackService
activity  com.sand.airdroid.webrtc.InitWebRTCScreenActivity
activity  com.sand.airdroid.ui.ime.InitImePickerActivity
activity  com.sand.airdroid.ui.ime.ClipBoardSyncActivity
service   com.sand.airdroid.addon.AddonHelpService_
activity  com.sand.airdroid.ui.addon.AddonAccessibilityActivity_
```

- `InitVirtualDisplayActivity` is the consent screen for `MediaProjection`
  (Android requires a user tap for screen capture; it cannot be granted
  silently).
- `VirtualDisplayService` owns the `MediaProjection` + `VirtualDisplay` +
  `ImageReader` pipeline that turns the framebuffer into frames.
- `RemoteInputMethodService` is an `InputMethodService`: a keyboard that AirDroid
  can select programmatically. This is the trick that lets a remote client type
  into *any* app without root — switch the active IME to the remote one and
  commit text.
- `AddonAccessibilityActivity` / `AddonHelpService_` gate the accessibility
  service that is used to dispatch taps and system-level actions.
- `AddonDownloadDialog_` + the `com.sand.remotesupportaddon` package queries +
  custom permission `com.sand.airsos.addon.permission` show that deep control
  ("AirMirror") ships as a **separate downloadable add-on**, not in the base APK.
  Android 11+ blocks `AccessibilityService` self-enablement, so control is
  effectively a separate install + user grant.

### File transfer and file management

```
service   com.sand.airdroid.services.TransferSendService
service   com.sand.airdroid.services.TransferReceiveService
service   com.sand.airdroid.services.TransferVerifyService
service   com.sand.airdroid.services.TransferMsgSendService
provider  com.sand.airdroid.provider.TransferProvider
service   com.sand.airdroid.components.discover.NeighborGetService_
service   com.sand.airdroid.services.AmazonS3UploadService
service   com.sand.airdroid.services.OfflineFileService
activity  ...ui.tools.file.* (FileManager, categories, upload list, history)
activity  ...ui.hotspot.Hotspot* (personal hotspot / nearby mode)
activity  ...ui.transfer.discover.trust.* (trust pairing)
```

The presence of `TransferVerifyService` **and** `TransferVerifyDialogActivity`
**and** `TransferDiscoverTrustActivity` proves a local trust/verification step
(short numeric code confirmed on both ends). `NeighborGetService_` is LAN
discovery. `AmazonS3UploadService` + `OfflineFileService` implement "send to a
device that is offline": upload into object storage, notify the peer, download
later.

### Notifications, SMS, calls

```
service   com.sand.airdroid.services.NotificationService
receiver  com.sand.airdroid.SmsSendedorReceivedReceiver
permissions READ_SMS, SEND_SMS, RECEIVE_SMS, RECEIVE_MMS,
            READ_CONTACTS, READ_PHONE_STATE, ANSWER_PHONE_CALLS,
            CALL_PHONE, READ_CALL_LOG
activity  ...ui.notification.* , ...ui.settings.OTPSmsProtectActivity_
```

`NotificationService` is the `NotificationListenerService`; the manifest also
declares `POST_NOTIFICATIONS`, `SYSTEM_ALERT_WINDOW` and
`FOREGROUND_SERVICE_CONNECTED_DEVICE`. OTP-SMS protection is a real feature
(bank OTP messages flagged/hidden).

### Remote camera, audio, location, find-phone

```
service   com.sand.airdroid.CameraPreviewService
activity  com.sand.airdroid.webrtc.InitWebRTCCameraActivity
activity  com.sand.airdroid.webrtc.InitAudioActivity
service   com.sand.airdroid.webrtc.SandWebRTCService
service   com.sand.airdroid.services.FindPhoneService
activity  ...ui.account.findphone.FindPhoneGuideActivity_
service   com.sand.airdroid.services.LocationUpdateJobService
permissions CAMERA, RECORD_AUDIO, ACCESS_FINE_LOCATION,
            ACCESS_BACKGROUND_LOCATION, FOREGROUND_SERVICE_CAMERA/MICROPHONE
```

### Always-on connection

```
service   com.sand.airdroid.servers.push.PushService        process=:push
service   com.sand.airdroid.servers.push.PushJobService     process=:push
service   com.sand.airdroid.servers.push.PushBindService    process=:push
service   com.sand.airdroid.servers.push.PushKeepLiveService process=:push
service   com.sand.airdroid.services.AirDroidKeepLiveService
service   com.sand.airdroid.services.KeepLiveJobService
service   com.sand.airdroid.services.AirDroidAssistService
service   com.sand.airdroid.services.AirDroidBoxService     (exported)
receiver  ...servers.push.PushNetworkConnectionReceiver
```
A dedicated `:push` process, plus keep-alive/assist/box services and the
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + `RECEIVE_BOOT_COMPLETED` +
`SCHEDULE_EXACT_ALARM` permissions. That is the classic Android "stay online
against Doze" stack: foreground service + job scheduler + alarms + OEM
autostart prompts.

---

## 3. The engine, from the native libraries

| Library | Size | What the strings prove |
| --- | --- | --- |
| `libadjServer.so` | 12.0 MB | Embedded **asio** HTTP/WebSocket server + a full **WebRTC** stack (`stun`, `turn`, `dtls`, `srtp`, `sctp`, `rtp_rtcp`, `p2p_transport_channel`). Exports `Sec-WebSocket-Key/Accept/Protocol`, `Upgrade: websocket`, `HTTP/1.1 101`, and even `Sec-WebSocket-Protocol: mqtt`. JNI targets `com.sand.airdroidbiz.input.Input` and `com.sand.airdroidbiz.services.AmsSmartInstallerService`. |
| `libvncServer.so` | 5.6 MB | A **VNC (RFB) server**: framebuffer geometry/bpp, `Frame buffer block %d`, WebSocket frame handling (`Clients may not send unmasked frames`, close frames), and input injection via `/dev/input/event*`, `/dev/uinput` **and** a Java bridge (`Input Java write`, `InputJava config`). |
| `libjingle_peerconnection_so.so` | 12.5 MB | Google's WebRTC peer-connection native library. |
| `libRemoteInput.so` | 1.1 MB | Remote touch/key injection helper. |
| `libMotionDetector.so` | 0.96 MB | Frame-difference detection (send only changed tiles) and/or camera motion. |
| `libyuv*.so`, `libimage_processing_util_jni.so`, `libsurface_util_jni.so` | small | Colour-space conversion + surface readback for the capture pipeline. |
| `libnms.so` | 0.18 MB | AirDroid's messaging/session layer. |
| `libdexprotector.so` | 0.45 MB | Application packer / anti-tamper. |
| `libmmkv.so`, `libconscrypt_jni.so` | — | Fast KV store; TLS. |

Two different real-time transports in one APK is the key architectural
insight: **VNC for local/LAN mirroring, WebRTC for internet mirroring/camera/audio.**

---

## 4. The two data paths

### 4.1 Same Wi-Fi ("Local" / nearby)

```
 Phone                                                   Browser / Desktop client
 ─────                                                   ────────────────────────
 MediaProjection ─► VirtualDisplay ─► ImageReader
                          │                                  ┌─ RFB client over WebSocket
                          ▼                                  │  (framebuffer updates)
                   VNC server (libvncServer.so) ◄──WS───────►│
                          ▲                                  │
 touch/key ◄── uinput OR RemoteInputMethodService ◄──RFB────┘
                          ▲
 "com.sand.airdroidbiz.input.Input" (Java, accessibility)

 asio HTTP/WebSocket server (libadjServer.so)
   ├─ /… MQTT-over-WebSocket session  (device ⇄ account/push messages)
   ├─ file up/download endpoints (TransferProvider, HTTP)
   └─ LAN discovery via NeighborGetService_
```

- Pairing: the desktop and the phone must show/accept the same verification
  code (`TransferVerifyDialogActivity`, `TransferDiscoverTrustActivity`).
- Transfer: plain HTTP(S) against the embedded server, with a resume/verify
  service and a per-file checksum (`TransferVerifyService`).
- Mirroring: RFB over WebSocket. RFB is a dumb-but-perfect fit for LAN: tiny
  CPU cost, absolute coordinates, no NAT traversal needed.

### 4.2 Different networks ("Remote")

```
 Phone                        AirDroid cloud                      Browser
 ─────                        ──────────────                      ───────
 PushService (:push) ◄──────► session/device registry ◄──────────► web.airdroid.com
      │                              │                                  │
      │  ice servers / SDP           │  signalling                      │
      ▼                              ▼                                  ▼
 WebRTC (libjingle) ◄────────── TURN relay (when P2P fails) ─────► WebRTC
      │                                                               │
      └──────────── data channel: touch, keys, clipboard ─────────────┘
```

- The device is registered to an account; the `:push` process keeps a
  long-lived socket so the phone can be woken without FCM (the manifest keeps
  FCM as a fallback — `FCMService`, `FirebaseMessagingService`).
- Media is WebRTC: `InitWebRTCScreenActivity`, `InitWebRTCCameraActivity`,
  `InitAudioActivity` all produce a `MediaProjection`/Camera/Mic source feeding
  `SandWebRTCService`.
- Control rides WebRTC's SCTP data channel; injected through accessibility /
  the remote IME (no root).
- Files that a sleeping peer cannot take go to object storage
  (`AmazonS3UploadService` → `OfflineFileService`), i.e. "cloud drive" mode.

### 4.3 Notification / SMS sync

```
NotificationListenerService (NotificationService)
  └─ status-bar notification extras ──► push session ──► browser
     reply path: RemoteInput action PendingIntent, or SMS via SmsManager

SmsSendedorReceivedReceiver ──► SMS/MMS content providers ──► push session ──► browser
```
This is why the app asks for `READ_SMS`, `SEND_SMS`, `RECEIVE_MMS`,
`READ_CONTACTS` and `ANSWER_PHONE_CALLS`: the browser is a thin client over the
phone's own telephony stack, not a VoIP service.

---

## 5. Security model (as observed)

| Layer | Mechanism |
| --- | --- |
| Package integrity | DexProtector: encrypted DEX + encrypted assets + signing-certificate pinning in `ProtectedSandApp` |
| Local pairing | short verification code + explicit trust store (`*TrustActivity`, `TransferVerifyService`, `KeyManageService`) |
| Transport | TLS to the cloud (Conscrypt), WebRTC DTLS-SRTP + SCTP for media/control, RFB inside an authenticated WebSocket locally |
| Account | email/social login, device list, per-device sessions (`PcListActivity_`, `UnBindLoginActivity_`) |
| Cloud | OAuth-style tokens, remote wipe/lock (`LockScreenConfirmActivity`, `MyDeviceAdminReceiver`) |

**Not observed:** end-to-end encryption of the relayed media. Media terminates
at TURN; TURN can see DTLS metadata but not media content, yet the signalling
and account backend are AirDroid-operated. Treat the cloud path as
"encrypted in transit, operator-visible metadata".

---

## 6. What cannot be known without running it

- The wire format behind `libnms.so` / the MQTT topics, auth token format,
  refresh strategy.
- The exact RFB extensions AirDroid added (tile codec, clipboard channel,
  audio). `libvncServer.so` shows a custom WebSocket layer around stock RFB.
- The cloud REST API surface (`HttpRetryService`, `HttpRetryRecordListActivity`
  hint at a retry queue, not the schema).
- The add-on's IPC contract (`libsos`/AirSOS).
- Real throughput numbers. The "20 MB/s" figure in the README is marketing.

Confirming any of those needs a rooted test device or a proxy + certificate
pinning bypass, which is out of scope for a clean-room rebuild.

---

## 7. What I rebuilt, and why the architecture differs

The clone in this repository (`Airlock`) keeps the *product* shape — one phone,
one browser dashboard, the same six jobs — but uses only free, open
infrastructure:

| AirDroid | Airlock | Why |
| --- | --- | --- |
| Embedded C++ asio HTTP/WS + VNC server | Kotlin `ServerSocket` HTTP + WebSocket agent, JSON protocol, JPEG/WebP frames | Same LAN behaviour, far less code, no native build |
| WebRTC + operator-run TURN | WebSocket relay (Deno Deploy / Render free) + optional WebRTC upgrade path | Free tier cannot host TURN; WS relay is enough for control + 10 fps mirroring |
| AirDroid cloud account | Supabase Auth + Postgres + Storage (free tier) | Drop-in managed backend with row-level security |
| Desktop client + web client | One React dashboard on Vercel (static) | No install, works on any browser |
| DexProtector, S3, paid tiers | Nothing hidden, no ads, no telemetry | Auditable and self-hostable |

See `docs/ARCHITECTURE.md` for the protocol and `docs/DEPLOY.md` for the
free-tier deployment.
