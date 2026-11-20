package dev.airlock.agent

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service that owns the LAN server, the relay link and the capture
 * pipeline. Android keeps it alive with a low-priority notification, which is
 * also where the pairing code lives.
 */
class DeviceService : Service(), LifecycleOwner {

    private val lifecycleRegistry by lazy { LifecycleRegistry(this) }
    override val lifecycle: Lifecycle get() = lifecycleRegistry

    private lateinit var prefs: Prefs
    private lateinit var scope: CoroutineScope
    private lateinit var screen: ScreenCapture
    private lateinit var silent: SilentMirror
    private lateinit var core: DeviceCore
    private var camera: CameraController? = null
    private var lanServer: LanServer? = null
    private var cloudLink: CloudLink? = null
    private var statsJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        lifecycleRegistry.currentState = Lifecycle.State.RESUMED
        prefs = Prefs(this)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        screen = ScreenCapture(this)
        silent = SilentMirror()
        camera = CameraController(this, this)
        core = DeviceCore(this, prefs, screen, silent, camera!!, scope)
        DeviceService.core = core

        foreground(linkType())
        keepAwake()
        startLan()
        startCloud()
        statsJob = scope.launch {
            while (isActive) {
                runCatching { core.broadcastStats() }
                runCatching { publish() }
                delay(2_000)
            }
        }
        state.update {
            it.copy(running = true, code = prefs.lanCode, cloudRoom = prefs.room)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_PROJECTION -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
                if (data != null) {
                    // Android 11+ requires the foreground-service type to be
                    // mediaProjection *before* getMediaProjection() is called.
                    foreground(
                        linkType() or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    )
                    if (screen.setProjection(resultCode, data)) {
                        state.update { it.copy(mirrored = true, error = null) }
                        Log.i(TAG, "projection approved")
                    } else {
                        state.update { it.copy(error = "screen capture was not approved") }
                    }
                } else {
                    state.update { it.copy(error = "screen capture was not approved") }
                }
            }
            ACTION_START, null -> {
                // Re-read the room in case MainActivity created a new one.
                if (prefs.room != null && prefs.token != null) startCloud()
            }
        }
        publish()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        statsJob?.cancel()
        cloudLink?.stop()
        cloudLink = null
        try {
            lanServer?.stop()
        } catch (_: Exception) {
        }
        lanServer = null
        silent.stop()
        screen.release()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        scope.cancel()
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        DeviceService.core = null
        instance = null
        state.update { it.copy(running = false, clients = 0, mirrored = false) }
        super.onDestroy()
    }

    // ---------------------------------------------------------------- transports
    private fun startLan() {
        try {
            val server = LanServer(LAN_PORT, prefs, core)
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            lanServer = server
            state.update {
                it.copy(
                    running = true,
                    lanUrl = "ws://${DeviceStats.lanIp() ?: "127.0.0.1"}:$LAN_PORT/agent",
                    code = prefs.lanCode,
                    error = null,
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "LAN server failed: ${e.message}")
            state.update { it.copy(error = "LAN port $LAN_PORT unavailable: ${e.message}") }
        }
    }

    @Synchronized
    private fun startCloud() {
        val room = prefs.room ?: return
        val token = prefs.token ?: return
        cloudLink?.stop()
        cloudLink = CloudLink(prefs.relayUrl, room, token, core).also { it.start() }
        state.update { it.copy(cloudRoom = room, relay = prefs.relayUrl) }
    }

    fun rotateCode(): String {
        val code = prefs.rotateCode()
        state.update { it.copy(code = code) }
        notifyForeground()
        return code
    }

    /** CameraX needs the camera FGS type, which needs the runtime permission. */
    fun promoteCamera(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= 29 &&
                ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                foreground(
                    linkType() or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                )
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "camera foreground type failed: ${e.message}")
            false
        }
    }

    // ---------------------------------------------------------------- notification
    /**
     * Android 15+ stops `dataSync` foreground services after six hours. The
     * agent is meant to stay reachable all day, so on API 34+ it declares
     * `specialUse` (unlimited) instead. Older releases fall back to dataSync.
     */
    private fun linkType(): Int =
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }

    private fun foreground(types: Int) {
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), types)
        state.update { it.copy(running = true, code = prefs.lanCode, lanUrl = it.lanUrl) }
    }

    /** Re-post the shade entry after the silent toggle or a code rotation. */
    fun refreshNotification() = notifyForeground()

    private fun notifyForeground() {
        // Deliberately no NotificationManager.notify(): on Android 13+ that
        // needs POST_NOTIFICATIONS, which this app does not hold (the whole
        // point is an invisible link). Re-running startForeground updates the
        // notification and is allowed without the runtime permission.
        try {
            foreground(linkType())
        } catch (e: Exception) {
            Log.w(TAG, "notification refresh failed: ${e.message}")
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 2,
            Intent(this, DeviceService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val quiet = prefs.silent
        val ip = DeviceStats.lanIp() ?: "this phone"
        val text = if (quiet) {
            // Silent mode: no pairing code, IP or LAN address on the lock screen.
            "Connected · tap to open"
        } else {
            "code ${prefs.lanCode} · ws://$ip:$LAN_PORT/agent"
        }
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_airlock)
            .setContentTitle(if (quiet) "Airlock" else "Airlock is listening")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setLocalOnly(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
        if (!quiet) builder.setStyle(NotificationCompat.BigTextStyle().bigText(text))
        return builder.build()
    }

    private fun keepAwake() {
        val power = getSystemService(PowerManager::class.java) ?: return
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "airlock:service").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun publish() {
        state.update {
            it.copy(
                clients = core.clientCount(),
                code = prefs.lanCode,
                mirrored = core.captureRunning(),
            )
        }
    }

    companion object {
        const val CHANNEL_ID = "airlock-link-hidden"
        const val LAN_PORT = 8787
        const val NOTIF_ID = 4711

        const val ACTION_START = "dev.airlock.action.START"
        const val ACTION_STOP = "dev.airlock.action.STOP"
        const val ACTION_PROJECTION = "dev.airlock.action.PROJECTION"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        private const val TAG = "AirlockService"

        @Volatile
        var instance: DeviceService? = null
            private set

        @Volatile
        var core: DeviceCore? = null
            private set

        data class UiState(
            val running: Boolean = false,
            val lanUrl: String = "",
            val code: String = "",
            val relay: String = "",
            val cloudRoom: String? = null,
            val clients: Int = 0,
            val mirrored: Boolean = false,
            val error: String? = null,
        )

        val state = MutableStateFlow(UiState())

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, DeviceService::class.java).setAction(ACTION_START),
            )
        }

        fun stop(context: Context) {
            context.startService(Intent(context, DeviceService::class.java).setAction(ACTION_STOP))
        }

        fun setProjection(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, DeviceService::class.java)
                .setAction(ACTION_PROJECTION)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
