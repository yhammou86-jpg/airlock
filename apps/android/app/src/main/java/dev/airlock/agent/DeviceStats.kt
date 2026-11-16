package dev.airlock.agent

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

/** Cheap telemetry for the overview cards; sampled, never stored. */
class DeviceStats(private val context: Context) {

    private var lastCpuTotal = -1L
    private var lastCpuIdle = -1L

    fun snapshot(): JSONObject {
        val battery = battery()
        val mem = memory()
        val storage = storage()
        val audio = context.getSystemService(AudioManager::class.java)
        return JSONObject()
            .put("battery", battery.first)
            .put("charging", battery.second)
            .put("volume", audio?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: 0)
            .put("muted", audio?.isStreamMute(AudioManager.STREAM_MUSIC) ?: false)
            .put("cpu", cpuPercent())
            .put("mem", mem)
            .put("storage", storage)
            .put("network", network())
            .put("uptime", SystemClock.elapsedRealtime() / 1000)
            .put("time", System.currentTimeMillis() / 1000)
    }

    private fun battery(): Pair<Int, Boolean> {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else 0
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        return pct to charging
    }

    private fun memory(): JSONObject {
        val am = context.getSystemService(ActivityManager::class.java)
        val info = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(info)
        return JSONObject()
            .put("total", info.totalMem)
            .put("free", info.availMem)
    }

    private fun storage(): JSONObject {
        return try {
            val stat = StatFs(Environment.getDataDirectory().absolutePath)
            val total = stat.blockCountLong * stat.blockSizeLong
            val free = stat.availableBlocksLong * stat.blockSizeLong
            JSONObject().put("total", total).put("free", free).put("used", total - free)
        } catch (e: Exception) {
            JSONObject().put("total", 0).put("free", 0).put("used", 0)
        }
    }

    private fun network(): JSONObject {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
        val type = when {
            caps == null -> "offline"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val ssid = try {
            @Suppress("DEPRECATION")
            context.applicationContext.getSystemService(WifiManager::class.java)
                ?.connectionInfo?.ssid
                ?.trim('"')
                ?.takeIf { it.isNotBlank() && !it.contains("unknown", ignoreCase = true) }
        } catch (e: Exception) {
            null
        }
        return JSONObject()
            .put("type", type)
            .put("ssid", ssid ?: JSONObject.NULL)
            .put("ip", lanIp() ?: JSONObject.NULL)
            .put("signal", 0)
    }

    /** CPU load between two snapshots, from /proc/stat. */
    private fun cpuPercent(): Double {
        return try {
            val line = File("/proc/stat").readLines().first()
            val parts = line.split(Regex("\\s+")).filter { it.isNotEmpty() }.drop(1).take(7)
                .map { it.toLongOrNull() ?: 0L }
            val idle = parts.getOrElse(3) { 0 } + parts.getOrElse(4) { 0 }
            val total = parts.sum()
            val prevTotal = lastCpuTotal
            val prevIdle = lastCpuIdle
            lastCpuTotal = total
            lastCpuIdle = idle
            if (prevTotal < 0 || total <= prevTotal) 0.0
            else ((total - prevTotal - (idle - prevIdle)).toDouble() * 100.0 / (total - prevTotal))
                .coerceIn(0.0, 100.0)
        } catch (e: Exception) {
            0.0
        }
    }

    companion object {
        /** First non-loopback IPv4; IPv6 deprioritised because LAN links are v4. */
        fun lanIp(): String? {
            return try {
                NetworkInterface.getNetworkInterfaces().toList()
                    .filter { it.isUp && !it.isLoopback }
                    .flatMap { it.inetAddresses.toList() }
                    .filterIsInstance<Inet4Address>()
                    .firstOrNull { !it.isLoopbackAddress }
                    ?.hostAddress
            } catch (e: Exception) {
                null
            }
        }
    }
}
