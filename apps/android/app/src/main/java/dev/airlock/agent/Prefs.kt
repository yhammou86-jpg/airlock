package dev.airlock.agent

import android.content.Context
import android.os.Build
import java.security.SecureRandom
import java.util.UUID

/** Small typed wrapper over SharedPreferences: pairing code, name, cloud room. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("airlock", Context.MODE_PRIVATE)
    private val random = SecureRandom()

    val installId: String
        get() = sp.getString("install", null) ?: UUID.randomUUID().toString().also {
            sp.edit().putString("install", it).apply()
        }

    var deviceName: String
        get() = sp.getString("name", null)?.takeIf { it.isNotBlank() } ?: (Build.MODEL ?: "Android device")
        set(value) = sp.edit().putString("name", value.take(80)).apply()

    var lanCode: String
        get() = sp.getString("code", null) ?: rotateCode()
        private set(value) = sp.edit().putString("code", value).apply()

    var relayUrl: String
        get() = sp.getString("relay", null) ?: "https://airlock-relay.y-hammou86.workers.dev"
        set(value) = sp.edit().putString("relay", value.trimEnd('/')).apply()

    var room: String?
        get() = sp.getString("room", null)
        set(value) = sp.edit().putString("room", value).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()

    var autoStart: Boolean
        get() = sp.getBoolean("autostart", false)
        set(value) = sp.edit().putBoolean("autostart", value).apply()

    /**
     * Silent mode: keep remote actions off the phone's UI (volume panel,
     * accessibility toasts). Foreground-service notifications stay because
     * Android requires them for camera and screen capture.
     */
    var silent: Boolean
        get() = sp.getBoolean("silent", true)
        set(value) = sp.edit().putBoolean("silent", value).apply()

    fun rotateCode(): String {
        val code = "%06d".format(random.nextInt(1_000_000))
        lanCode = code
        return code
    }
}
