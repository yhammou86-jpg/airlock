package dev.airlock.agent

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * CameraX snapshot on demand. The service owns a LifecycleRegistry so CameraX
 * has a lifecycle to bind to without an Activity.
 */
class CameraController(
    private val context: Context,
    private val owner: LifecycleOwner,
) {
    suspend fun snapshot(lens: String): ByteArray = suspendCancellableCoroutine { cont ->
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try {
                val provider = future.get()
                val selector = if (lens == "front") {
                    CameraSelector.DEFAULT_FRONT_CAMERA
                } else {
                    CameraSelector.DEFAULT_BACK_CAMERA
                }
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
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
                            val bytes = try {
                                file.readBytes()
                            } catch (e: Exception) {
                                null
                            }
                            file.delete()
                            provider.unbindAll()
                            if (cont.isActive) {
                                if (bytes != null) cont.resume(bytes)
                                else cont.resumeWithException(IllegalStateException("could not read capture"))
                            }
                        }

                        override fun onError(exception: ImageCaptureException) {
                            file.delete()
                            provider.unbindAll()
                            if (cont.isActive) cont.resumeWithException(exception)
                        }
                    },
                )
            } catch (e: Exception) {
                if (cont.isActive) cont.resumeWithException(e)
            }
        }, ContextCompat.getMainExecutor(context))
    }
}
