package dev.airlock.agent

import android.accessibilityservice.AccessibilityService
import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicLong

/**
 * Transport-independent device brain: every RPC in docs/PROTOCOL.md is handled
 * here, whether the request arrived over LAN or the relay.
 */
class DeviceCore(
    private val context: Context,
    private val prefs: Prefs,
    private val screen: ScreenCapture,
    private val camera: CameraController,
    private val scope: CoroutineScope,
) {
    private val fs = FsStore(context)
    private val sms = SmsStore(context)
    private val stats = DeviceStats(context)
    private val peers = CopyOnWriteArraySet<Peer>()
    private val main = Handler(Looper.getMainLooper())
    private val audio = context.getSystemService(AudioManager::class.java)
    private val clipboard = context.getSystemService(ClipboardManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)
    private val cameraManager = context.getSystemService(CameraManager::class.java)
    private val uploadIds = AtomicLong(0)
    private var torchId: String? = null
    private var ringtone: Ringtone? = null

    init {
        NotifStore.watch { json -> broadcastEvent("notif", json) }
    }

    // ---------------------------------------------------------------- peers
    fun attach(peer: Peer) {
        peers += peer
        if (peer.remote) {
            peer.sendText(hello().toString())
            pushStats(peer)
        }
    }

    fun detach(peer: Peer) {
        peers -= peer
        peer.state.upload?.let { up ->
            synchronized(peer.state.uploadLock) {
                try {
                    up.out.close()
                } catch (_: Exception) {
                }
                up.tmp.delete()
                peer.state.upload = null
            }
        }
        if (peers.none { it.state.mirroring }) screen.stop()
    }

    fun clientCount(): Int = peers.count { it.state.authed }

    fun hello(): JSONObject {
        val device = JSONObject()
            .put("id", prefs.installId)
            .put("name", prefs.deviceName)
            .put("model", Build.MODEL)
            .put("android", Build.VERSION.RELEASE)
            .put("agent", "airlock-android/1.0.0")
            .put("ip", DeviceStats.lanIp() ?: JSONObject.NULL)
            .put("port", DeviceService.LAN_PORT)
        return Protocol.envelope("hello", JSONObject()
            .put("device", device)
            .put("capabilities", Protocol.capabilities))
    }

    fun broadcastEvent(type: String, data: JSONObject) {
        val payload = Protocol.event(type, data).toString()
        for (p in peers) if (p.state.authed) p.sendText(payload)
    }

    fun broadcastStats() {
        val snapshot = stats.snapshot()
        val payload = Protocol.event("stats", snapshot).toString()
        for (p in peers) if (p.state.authed) p.sendText(payload)
    }

    private fun pushStats(peer: Peer) {
        peer.sendText(Protocol.event("stats", stats.snapshot()).toString())
    }

    private fun log(level: String, message: String) {
        broadcastEvent("log", JSONObject().put("level", level).put("message", message))
    }

    // ---------------------------------------------------------------- inbound
    fun onText(peer: Peer, text: String) {
        val req = try {
            JSONObject(text)
        } catch (e: Exception) {
            return
        }
        val type = req.optString("type")
        if (type.isEmpty() || type.startsWith("relay.")) return
        scope.launch(Dispatchers.IO) { handle(peer, req, type) }
    }

    fun onBinary(peer: Peer, bytes: ByteArray) {
        if (!peer.state.authed) return
        val frame = Protocol.decodeFrame(bytes) ?: return
        if (frame.kind != Protocol.Kind.UPLOAD) return
        val upload = peer.state.upload ?: return
        synchronized(peer.state.uploadLock) {
            try {
                upload.out.write(frame.payload)
                upload.digest.update(frame.payload)
                upload.received += frame.payload.size
            } catch (e: Exception) {
                Log.w(TAG, "upload write failed: ${e.message}")
            }
        }
    }

    private suspend fun handle(peer: Peer, req: JSONObject, type: String) {
        if (type == "auth") {
            val code = req.optJSONObject("data")?.optString("code").orEmpty()
            val accepted = peer.remote || code == prefs.lanCode || code == peer.providedCode
            if (accepted) {
                peer.state.authed = true
                peer.sendText(Protocol.response(req, JSONObject().put("ok", true).put("device", prefs.installId)).toString())
                peer.sendText(hello().toString())
                pushStats(peer)
                log("info", "paired (${if (peer.remote) "cloud" else "lan"})")
            } else {
                peer.sendText(Protocol.failure(req, "bad_code", "pairing code rejected").toString())
                kotlinx.coroutines.delay(250)
                peer.close(4003, "bad code")
            }
            return
        }

        if (!peer.state.authed) {
            peer.sendText(Protocol.failure(req, "unauthorized", "send auth first").toString())
            return
        }

        val data = req.optJSONObject("data") ?: JSONObject()
        try {
            val result = dispatch(peer, type, data)
            peer.sendText(Protocol.response(req, result).toString())
        } catch (e: SecurityException) {
            peer.sendText(Protocol.failure(req, "permission", e.message ?: "permission denied").toString())
        } catch (e: Exception) {
            peer.sendText(Protocol.failure(req, "handler_error", e.message ?: e.toString()).toString())
        }
    }

    private suspend fun dispatch(peer: Peer, type: String, d: JSONObject): JSONObject = when (type) {
        "device.stats" -> stats.snapshot()
        "fs.list" -> fs.list(d.optString("path", "/"))
        "fs.mkdir" -> fs.mkdir(d.optString("path", "/"), d.optString("name"))
        "fs.rename" -> fs.rename(d.optString("path", "/"), d.optString("name"), d.optString("newName"))
        "fs.delete" -> fs.delete(d.optJSONArray("paths")?.toStringList() ?: emptyList())
        "fs.upload.begin" -> beginUpload(peer, d)
        "fs.upload.done" -> finishUpload(peer, d)
        "fs.download" -> download(peer, d)
        "mirror.start" -> startMirror(peer, d)
        "mirror.stop" -> stopMirrorFor(peer)
        "input.tap" -> tap(d)
        "input.swipe" -> swipe(d)
        "input.longpress" -> longPress(d)
        "input.key" -> key(d)
        "input.text" -> text(d)
        "sms.threads" -> sms.threads()
        "sms.messages" -> sms.messages(d.optString("threadId"))
        "sms.send" -> sms.send(d.optString("to"), d.optString("body"))
        "notif.list" -> JSONObject().put("notifications", NotifStore.list())
        "notif.dismiss" -> JSONObject().put("dismissed", NotifListener.instance?.dismiss(d.optString("id")) ?: false)
        "notif.reply" -> JSONObject().put("sent", NotifListener.instance?.reply(d.optString("id"), d.optString("text")) ?: false)
        "camera.shot" -> cameraShot(peer, d)
        "apps.list" -> apps()
        "apps.launch" -> launch(d)
        "device.action" -> action(d)
        else -> throw IllegalArgumentException("no handler for $type")
    }

    // ---------------------------------------------------------------- files
    private fun beginUpload(peer: Peer, d: JSONObject): JSONObject {
        val target = File(fs.resolve(d.optString("path", "/")), fs.safeName(d.optString("name")))
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, ".${target.name}.${System.currentTimeMillis()}.part")
        val out = FileOutputStream(tmp)
        val id = "up-" + uploadIds.incrementAndGet()
        val state = UploadState(id, target, tmp, d.optLong("size", 0), out, MessageDigest.getInstance("SHA-256"))
        synchronized(peer.state.uploadLock) {
            peer.state.upload?.let { old ->
                try {
                    old.out.close()
                } catch (_: Exception) {
                }
                old.tmp.delete()
            }
            peer.state.upload = state
        }
        return JSONObject().put("uploadId", id).put("path", fs.wirePath(target))
    }

    private fun finishUpload(peer: Peer, d: JSONObject): JSONObject {
        val upload = peer.state.upload ?: throw IllegalStateException("unknown upload")
        if (upload.id != d.optString("uploadId")) throw IllegalStateException("unknown upload")
        synchronized(peer.state.uploadLock) {
            upload.out.flush()
            upload.out.close()
            peer.state.upload = null
            val digest = upload.digest.digest().joinToString("") { "%02x".format(it) }
            val expected = d.optString("sha256").lowercase()
            val ok = expected.isEmpty() || expected == digest
            if (!ok) {
                upload.tmp.delete()
                return JSONObject().put("ok", false).put("sha256", digest).put("size", upload.tmp.length())
            }
            if (upload.target.exists()) upload.target.delete()
            val moved = upload.tmp.renameTo(upload.target)
            if (!moved) {
                // Cross-device fallback (should not happen in the same folder).
                upload.tmp.copyTo(upload.target, overwrite = true)
                upload.tmp.delete()
            }
            log("info", "upload ok · ${fs.wirePath(upload.target)} · ${upload.target.length()} B")
            return JSONObject()
                .put("path", fs.wirePath(upload.target))
                .put("size", upload.target.length())
                .put("sha256", digest)
                .put("ok", true)
        }
    }

    private fun download(peer: Peer, d: JSONObject): JSONObject {
        val file = fs.resolve(d.optString("path"))
        if (file.isDirectory) throw IllegalArgumentException("is a directory")
        if (!file.exists()) throw IllegalArgumentException("no such file")
        fs.open(d.optString("path")).use { input ->
            val buffer = ByteArray(Protocol.CHUNK_BYTES)
            while (true) {
                val n = input.read(buffer)
                if (n <= 0) break
                val chunk = if (n == buffer.size) buffer.copyOf() else buffer.copyOf(n)
                peer.sendBinary(Protocol.encodeFrame(Protocol.Kind.DOWNLOAD, payload = chunk))
            }
        }
        return JSONObject()
            .put("name", file.name)
            .put("size", file.length())
            .put("sha256", fs.sha256(file))
    }

    // ---------------------------------------------------------------- mirror
    private fun startMirror(peer: Peer, d: JSONObject): JSONObject {
        if (!screen.isReady) {
            throw IllegalStateException("screen capture not approved — open Airlock on the phone and tap Allow capture")
        }
        val fps = d.optInt("fps", 8)
        val quality = d.optInt("quality", 65)
        val maxWidth = d.optInt("maxWidth", 720)
        val started = screen.start(fps, quality, maxWidth) { jpeg, _, _ ->
            val frame = Protocol.encodeFrame(Protocol.Kind.MIRROR, Protocol.Codec.JPEG, payload = jpeg)
            for (p in peers) if (p.state.authed && p.state.mirroring) p.sendBinary(frame)
        }
        if (!started) throw IllegalStateException("could not start capture")
        peer.state.mirroring = true
        log("info", "mirror started at $fps fps")
        return JSONObject().put("fps", fps).put("quality", quality)
    }

    private fun stopMirrorFor(peer: Peer): JSONObject {
        peer.state.mirroring = false
        if (peers.none { it.state.mirroring }) screen.stop()
        return JSONObject().put("ok", true)
    }

    // ---------------------------------------------------------------- input
    private fun metrics(): Pair<Int, Int> {
        val dm = context.resources.displayMetrics
        return dm.widthPixels to dm.heightPixels
    }

    private fun service(): KeyAccessibilityService =
        KeyAccessibilityService.instance
            ?: throw IllegalStateException("enable Airlock in Settings → Accessibility to inject gestures")

    private fun tap(d: JSONObject): JSONObject {
        val (w, h) = metrics()
        val ok = service().tap(d.optDouble("x", 0.0).toFloat() * w, d.optDouble("y", 0.0).toFloat() * h)
        log("info", "tap ${(d.optDouble("x", 0.0) * 100).toInt()}%,${(d.optDouble("y", 0.0) * 100).toInt()}%")
        return JSONObject().put("tapped", ok)
    }

    private fun swipe(d: JSONObject): JSONObject {
        val (w, h) = metrics()
        val ok = service().swipe(
            d.optDouble("x1", 0.0).toFloat() * w,
            d.optDouble("y1", 0.0).toFloat() * h,
            d.optDouble("x2", 0.0).toFloat() * w,
            d.optDouble("y2", 0.0).toFloat() * h,
            d.optLong("ms", 260),
        )
        log("info", "swipe")
        return JSONObject().put("swiped", ok)
    }

    private fun longPress(d: JSONObject): JSONObject {
        val (w, h) = metrics()
        val ok = service().longPress(
            d.optDouble("x", 0.0).toFloat() * w,
            d.optDouble("y", 0.0).toFloat() * h,
            d.optLong("ms", 700),
        )
        return JSONObject().put("ok", ok)
    }

    private fun key(d: JSONObject): JSONObject {
        val name = d.optString("key")
        val ok = when (name) {
            "back" -> service().global(AccessibilityService.GLOBAL_ACTION_BACK)
            "home" -> service().global(AccessibilityService.GLOBAL_ACTION_HOME)
            "recents" -> service().global(AccessibilityService.GLOBAL_ACTION_RECENTS)
            "notifications" -> service().global(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
            "lock" -> if (Build.VERSION.SDK_INT >= 28) {
                service().global(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
            } else {
                false
            }
            "backspace", "enter" -> service().key(name)
            "power" -> throw IllegalStateException("power key needs root or device-owner privileges")
            else -> throw IllegalArgumentException("unknown key $name")
        }
        log("info", "key $name")
        return JSONObject().put("ok", ok)
    }

    private fun text(d: JSONObject): JSONObject {
        val ok = service().type(d.optString("text"))
        log("info", "text input")
        return JSONObject().put("ok", ok)
    }

    // ---------------------------------------------------------------- camera
    private suspend fun cameraShot(peer: Peer, d: JSONObject): JSONObject {
        if (context.checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("grant camera permission in Airlock")
        }
        val lens = d.optString("lens", "back")
        DeviceService.instance?.promoteCamera()
        val bytes = camera.snapshot(lens)
        peer.sendBinary(Protocol.encodeFrame(Protocol.Kind.CAMERA, Protocol.Codec.JPEG, payload = bytes))
        log("info", "camera snapshot ($lens)")
        return JSONObject().put("lens", lens).put("ts", System.currentTimeMillis()).put("bytes", bytes.size)
    }

    // ---------------------------------------------------------------- apps
    private fun apps(): JSONObject {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = pm.queryIntentActivities(intent, 0)
        val seen = HashSet<String>()
        val list = JSONArray()
        for (info in resolved.sortedBy { it.loadLabel(pm).toString().lowercase() }) {
            val pkg = info.activityInfo.packageName
            if (!seen.add(pkg)) continue
            list.put(
                JSONObject()
                    .put("pkg", pkg)
                    .put("name", info.loadLabel(pm).toString())
                    .put("system", (info.activityInfo.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
            )
            if (list.length() >= 300) break
        }
        return JSONObject().put("apps", list)
    }

    private fun launch(d: JSONObject): JSONObject {
        val pkg = d.optString("pkg")
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
            ?: throw IllegalArgumentException("no launcher activity for $pkg")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        log("info", "launch $pkg")
        return JSONObject().put("launched", pkg)
    }

    // ---------------------------------------------------------------- actions
    private fun action(d: JSONObject): JSONObject {
        when (val a = d.optString("action")) {
            "volume.up" -> audio?.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
            "volume.down" -> audio?.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
            "volume.mute" -> audio?.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                AudioManager.ADJUST_TOGGLE_MUTE,
                AudioManager.FLAG_SHOW_UI,
            )
            "media.play" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PLAY)
            "media.pause" -> mediaKey(KeyEvent.KEYCODE_MEDIA_PAUSE)
            "flashlight" -> toggleTorch()
            "wake" -> wake()
            "lock" -> {
                if (Build.VERSION.SDK_INT < 28) throw IllegalStateException("lock needs Android 9+")
                service().global(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
            }
            "find" -> findPhone()
            "clipboard.get" -> return JSONObject().put("text", clipboardText())
            "clipboard.set" -> {
                clipboard?.setPrimaryClip(ClipData.newPlainText("Airlock", d.optString("value")))
                return JSONObject().put("text", d.optString("value"))
            }
            else -> throw IllegalArgumentException("unsupported action $a")
        }
        log("info", "action ${d.optString("action")}")
        return JSONObject().put("action", d.optString("action")).put("ok", true)
    }

    private fun mediaKey(code: Int) {
        val manager = audio ?: return
        manager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        manager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    private fun toggleTorch() {
        val manager = cameraManager ?: throw IllegalStateException("camera service unavailable")
        val id = torchId ?: manager.cameraIdList.firstOrNull { candidate ->
            manager.getCameraCharacteristics(candidate)
                .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: throw IllegalStateException("no torch on this device")
        torchId = id
        torchOn = !torchOn
        manager.setTorchMode(id, torchOn)
    }

    private var torchOn = false

    private fun wake() {
        val manager = power ?: return
        @Suppress("DEPRECATION")
        val lock = manager.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "airlock:wake",
        )
        lock.acquire(4_000)
    }

    private fun findPhone() {
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val tone = RingtoneManager.getRingtone(context, uri) ?: return
        audio?.let { am ->
            am.setStreamVolume(AudioManager.STREAM_RING, am.getStreamMaxVolume(AudioManager.STREAM_RING), 0)
        }
        ringtone?.stop()
        ringtone = tone
        tone.play()
        main.postDelayed({ runCatching { tone.stop() } }, 8_000)
    }

    private fun clipboardText(): String {
        val clip = clipboard?.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(context).toString()
    }

    private fun JSONArray.toStringList(): List<String> {
        val out = ArrayList<String>(length())
        for (i in 0 until length()) out.add(optString(i))
        return out
    }

    companion object {
        private const val TAG = "AirlockCore"
    }
}
