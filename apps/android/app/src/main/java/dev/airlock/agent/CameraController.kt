package dev.airlock.agent

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * CameraX snapshot on demand. The service owns a LifecycleRegistry so CameraX
 * has a lifecycle to bind to without an Activity.
 *
 * A phone camera is a single exclusive resource: binding it twice in quick
 * succession makes CameraX throw "camera in use", which used to surface as a
 * dashboard timeout because the reply never went out. Captures are therefore
 * single-flight, bounded to a screen-sized JPEG and re-encoded on a worker
 * thread before they touch the socket.
 */
class CameraController(
    private val context: Context,
    private val owner: LifecycleOwner,
) {
    private val busy = AtomicBoolean(false)

    data class Shot(val bytes: ByteArray, val width: Int, val height: Int)

    suspend fun snapshot(lens: String): Shot {
        if (!busy.compareAndSet(false, true)) {
            throw IllegalStateException("camera is busy with the previous snapshot")
        }
        try {
            val file = capture(lens)
            return withContext(Dispatchers.IO) { shrink(file) }
        } finally {
            busy.set(false)
        }
    }

    private suspend fun capture(lens: String): File = suspendCancellableCoroutine { cont ->
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            var provider: ProcessCameraProvider? = null
            try {
                provider = future.get()
                val selector = if (lens == "front") {
                    CameraSelector.DEFAULT_FRONT_CAMERA
                } else {
                    CameraSelector.DEFAULT_BACK_CAMERA
                }
                // Ask CameraX for a roughly screen-sized stream instead of a
                // 12-50 MP sensor dump. Older devices fall back gracefully.
                val resolution = ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            Size(CAPTURE_MAX_EDGE, CAPTURE_MAX_EDGE),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                        )
                    )
                    .build()
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setResolutionSelector(resolution)
                    .build()

                provider.unbindAll()
                provider.bindToLifecycle(owner, selector, capture)

                val file = File(context.cacheDir, "airlock-shot-${System.currentTimeMillis()}.jpg")
                val options = ImageCapture.OutputFileOptions.Builder(file).build()

                capture.takePicture(
                    options,
                    ContextCompat.getMainExecutor(context),
                    object : ImageCapture.OnImageSavedCallback {
                        override fun onImageSaved(results: ImageCapture.OutputFileResults) {
                            provider?.unbindAll()
                            if (cont.isActive) cont.resume(file) else file.delete()
                        }

                        override fun onError(exception: ImageCaptureException) {
                            file.delete()
                            provider?.unbindAll()
                            if (cont.isActive) {
                                cont.resumeWithException(
                                    IllegalStateException(
                                        "camera capture failed: ${exception.message ?: "unknown error"}",
                                        exception,
                                    )
                                )
                            }
                        }
                    },
                )
            } catch (e: Throwable) {
                try {
                    provider?.unbindAll()
                } catch (_: Throwable) {
                }
                if (cont.isActive) cont.resumeWithException(e)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    /** Decode, rotate by EXIF, cap the long edge and re-encode as a small JPEG. */
    private fun shrink(file: File): Shot {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                throw IllegalStateException("camera returned an unreadable image")
            }

            var sample = 1
            var longEdge = maxOf(bounds.outWidth, bounds.outHeight)
            while (longEdge / sample > DELIVER_MAX_EDGE * 2) sample *= 2
            val decoded = BitmapFactory.decodeFile(
                file.path,
                BitmapFactory.Options().apply { inSampleSize = sample },
            ) ?: throw IllegalStateException("could not decode the camera image")

            val rotated = rotate(decoded, readRotation(file))
            if (rotated !== decoded) decoded.recycle()

            val scaled = scaleToFit(rotated, DELIVER_MAX_EDGE)
            if (scaled !== rotated) rotated.recycle()

            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            val shot = Shot(out.toByteArray(), scaled.width, scaled.height)
            scaled.recycle()
            return shot
        } finally {
            file.delete()
        }
    }

    private fun readRotation(file: File): Int = try {
        ExifInterface(file.path).rotationDegrees
    } catch (_: Throwable) {
        0
    }

    private fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees % 360 == 0) return bitmap
        val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun scaleToFit(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val longEdge = maxOf(bitmap.width, bitmap.height)
        if (longEdge <= maxEdge) return bitmap
        val ratio = maxEdge.toFloat() / longEdge
        val width = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    companion object {
        /** Candidate sensor size; CameraX rounds to the nearest supported one. */
        private const val CAPTURE_MAX_EDGE = 1920

        /** Final JPEG long edge sent over the socket. */
        private const val DELIVER_MAX_EDGE = 1440

        private const val JPEG_QUALITY = 72
    }
}
