package dev.airlock.agent

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.ByteArrayOutputStream
import kotlin.math.min

/**
 * MediaProjection + VirtualDisplay + ImageReader, the same pipeline AirDroid
 * uses for mirroring. Frames are throttled, scaled to maxWidth and JPEG encoded
 * before they hit the socket.
 */
class ScreenCapture(private val context: Context) {

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var running = false

    private var fps = 8
    private var quality = 65
    private var maxWidth = 720
    private var lastSent = 0L
    private var callback: ((ByteArray, Int, Int) -> Unit)? = null

    val isReady: Boolean get() = projection != null
    val isRunning: Boolean get() = running

    /** Called from ProjectionActivity once the user approved the capture dialog. */
    fun setProjection(resultCode: Int, data: android.content.Intent): Boolean {
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        stop()
        try {
            projection?.stop()
        } catch (_: Exception) {
        }
        projection = null
        projection = try {
            manager.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.w(TAG, "projection refused: ${e.message}")
            null
        }
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                stop()
            }
        }, Handler(Looper.getMainLooper()))
        return projection != null
    }

    fun start(fps: Int, quality: Int, maxWidth: Int, onFrame: (ByteArray, Int, Int) -> Unit): Boolean {
        val projection = projection ?: return false
        this.fps = fps.coerceIn(1, 20)
        this.quality = quality.coerceIn(30, 90)
        this.maxWidth = maxWidth.coerceIn(320, 1440)
        this.callback = onFrame
        if (running) return true

        val metrics = context.resources.displayMetrics
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val dpi = metrics.densityDpi

        val reader = try {
            ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        } catch (e: Exception) {
            Log.w(TAG, "ImageReader failed: ${e.message}")
            return false
        }
        this.reader = reader

        val thread = HandlerThread("airlock-screen").also { it.start() }
        this.thread = thread
        val handler = Handler(thread.looper)

        reader.setOnImageAvailableListener({ r -> onImage(r) }, handler)

        display = try {
            projection.createVirtualDisplay(
                "airlock-mirror",
                width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface, null, handler,
            )
        } catch (e: Exception) {
            Log.w(TAG, "VirtualDisplay failed: ${e.message}")
            null
        }
        if (display == null) {
            stop()
            return false
        }
        running = true
        return true
    }

    private fun onImage(reader: ImageReader) {
        val image = reader.acquireLatestImage() ?: return
        try {
            val now = SystemClock.elapsedRealtime()
            val interval = 1000L / fps.coerceAtLeast(1)
            if (now - lastSent < interval) return
            lastSent = now
            val bytes = image.toJpeg() ?: return
            callback?.invoke(bytes.first, bytes.second, bytes.third)
        } catch (e: Exception) {
            Log.w(TAG, "frame failed: ${e.message}")
        } finally {
            image.close()
        }
    }

    private fun Image.toJpeg(): Triple<ByteArray, Int, Int>? {
        val plane = planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val padded = Bitmap.createBitmap(
            width + rowPadding / pixelStride,
            height,
            Bitmap.Config.ARGB_8888,
        )
        padded.copyPixelsFromBuffer(buffer)
        val cropped = Bitmap.createBitmap(padded, 0, 0, width, height)
        val scale = min(1f, maxWidth.toFloat() / cropped.width)
        val scaled = if (scale < 1f) {
            Bitmap.createScaledBitmap(
                cropped,
                (cropped.width * scale).toInt().coerceAtLeast(2),
                (cropped.height * scale).toInt().coerceAtLeast(2),
                true,
            )
        } else {
            cropped
        }
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
        val bytes = out.toByteArray()
        val result = Triple(bytes, scaled.width, scaled.height)
        if (scaled !== cropped) scaled.recycle()
        cropped.recycle()
        padded.recycle()
        return result
    }

    fun stop() {
        running = false
        callback = null
        try {
            display?.release()
        } catch (_: Exception) {
        }
        display = null
        try {
            reader?.close()
        } catch (_: Exception) {
        }
        reader = null
        thread?.quitSafely()
        thread = null
    }

    /** Tear down the projection itself (service shutdown). */
    fun release() {
        stop()
        try {
            projection?.stop()
        } catch (_: Exception) {
        }
        projection = null
    }

    companion object {
        private const val TAG = "AirlockScreen"
    }
}
