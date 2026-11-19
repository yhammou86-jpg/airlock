package dev.airlock.agent

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Screen mirroring that never asks the user for permission.
 *
 * `AccessibilityService.takeScreenshot()` (API 30+) can read the display once
 * the user has enabled the accessibility service, and it does not show the
 * MediaProjection "Start recording or casting?" dialog. The platform throttles
 * the API (typically one screenshot per 333 ms), so this runs at 2-3 fps and is
 * the silent default. [ScreenCapture] remains the fallback when accessibility is
 * off or an OEM refuses to implement accessibility screenshots.
 *
 * Every frame is scaled and JPEG-encoded on a private worker thread so the main
 * thread only dispatches the request.
 */
class SilentMirror {

    private val handler = Handler(Looper.getMainLooper())
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "airlock-silent-mirror").apply { isDaemon = true }
    }

    @Volatile private var service: KeyAccessibilityService? = null
    @Volatile private var callback: ((ByteArray, Int, Int) -> Unit)? = null
    @Volatile private var onFatal: ((String) -> Unit)? = null
    @Volatile private var running = false
    @Volatile private var failures = 0
    @Volatile private var lastSent = 0L

    @Volatile private var quality = 65
    @Volatile private var maxWidth = 720
    @Volatile private var interval = MIN_INTERVAL_MS

    val isRunning: Boolean get() = running

    /** Actual frames per second after the platform's minimum interval is applied. */
    val fps: Int get() = (1000L / interval.coerceAtLeast(1L)).toInt().coerceIn(1, 5)

    /**
     * True when this build and phone can screenshot without a dialog: API 30+,
     * the accessibility service is connected, and its config declares the
     * screenshot capability.
     */
    val isAvailable: Boolean
        get() {
            if (Build.VERSION.SDK_INT < 30) return false
            val service = KeyAccessibilityService.instance ?: return false
            return service.supportsScreenshot
        }

    fun start(
        fps: Int,
        quality: Int,
        maxWidth: Int,
        onFrame: (ByteArray, Int, Int) -> Unit,
        onFatal: (String) -> Unit,
    ): Boolean {
        if (!isAvailable) return false
        val service = KeyAccessibilityService.instance ?: return false

        stop()
        this.service = service
        this.callback = onFrame
        this.onFatal = onFatal
        this.quality = quality.coerceIn(30, 90)
        this.maxWidth = maxWidth.coerceIn(240, 1440)

        val wanted = (1000L / fps.coerceIn(1, 5)).coerceAtLeast(MIN_INTERVAL_MS)
        this.interval = wanted
        this.failures = 0
        this.lastSent = 0L
        this.running = true

        handler.post(::tick)
        Log.i(TAG, "silent mirror requested at ${this.fps} fps (interval ${interval} ms)")
        return true
    }

    fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        callback = null
        onFatal = null
        service = null
    }

    // -------------------------------------------------------------- internals
    private fun tick() {
        if (!running) return
        // start() only runs on API 30+, but keep lint and older devices happy.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            stop()
            return
        }
        val now = SystemClock.elapsedRealtime()
        val wait = interval - (now - lastSent)
        if (wait > 0) {
            handler.postDelayed(::tick, wait)
            return
        }
        lastSent = now
        captureOnce()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun captureOnce() {
        val service = service ?: run {
            stop()
            return
        }
        try {
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                worker,
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                        try {
                            if (!running) return
                            val frame = encode(result)
                            if (frame == null) {
                                failed("the phone returned an unreadable screenshot")
                                return
                            }
                            failures = 0
                            callback?.invoke(frame.first, frame.second, frame.third)
                            if (running) handler.postDelayed(::tick, interval)
                        } catch (t: Throwable) {
                            failed("screenshot encoding failed: ${t.message ?: t.javaClass.simpleName}")
                        } finally {
                            try {
                                result.hardwareBuffer.close()
                            } catch (_: Throwable) {
                            }
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        if (!running) return
                        if (errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
                            // We raced the platform's own throttle: wait longer
                            // instead of counting this as a broken capture.
                            interval += 120L
                            handler.postDelayed(::tick, interval)
                            return
                        }
                        failed(explain(errorCode))
                    }
                },
            )
        } catch (t: Throwable) {
            failed("could not request a screenshot: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private fun failed(message: String) {
        if (!running) return
        failures += 1
        Log.w(TAG, "$message (failure $failures)")
        if (failures < MAX_FAILURES) {
            handler.postDelayed(::tick, interval)
            return
        }
        val fatal = onFatal
        stop()
        handler.post { fatal?.invoke(message) }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun encode(result: AccessibilityService.ScreenshotResult): Triple<ByteArray, Int, Int>? {
        val wrapped = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: return null
        val bitmap = try {
            wrapped.copy(Bitmap.Config.ARGB_8888, false)
        } finally {
            wrapped.recycle()
        } ?: return null

        val scaled = scaleToWidth(bitmap, maxWidth)
        if (scaled !== bitmap) bitmap.recycle()
        try {
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            return Triple(out.toByteArray(), scaled.width, scaled.height)
        } finally {
            scaled.recycle()
        }
    }

    private fun scaleToWidth(bitmap: Bitmap, maxWidth: Int): Bitmap {
        val width = bitmap.width
        if (width <= maxWidth) return bitmap
        val ratio = maxWidth.toFloat() / width
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, maxWidth, height, true)
    }

    private fun explain(errorCode: Int): String = when (errorCode) {
        1 -> "the screenshot service hit an internal error"
        2 -> "the phone revoked accessibility screenshot access — turn Airlock accessibility off and on again"
        3 -> "the phone rejected the screenshot rate"
        4 -> "the default display is not available"
        else -> "the phone refused the screenshot (error $errorCode)"
    }

    companion object {
        private const val TAG = "AirlockSilentMirror"

        /** ~3 fps; the platform usually throttles to 333 ms between shots. */
        private const val MIN_INTERVAL_MS = 340L

        private const val MAX_FAILURES = 3
    }
}
