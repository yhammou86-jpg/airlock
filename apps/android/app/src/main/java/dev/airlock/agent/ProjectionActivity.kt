package dev.airlock.agent

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Transparent hop that shows the system "Start recording or casting?" dialog and
 * hands the token to DeviceService. Kept as an Activity because MediaProjection
 * consent can only be requested from one.
 */
class ProjectionActivity : ComponentActivity() {

    private val launcher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            DeviceService.setProjection(this, result.resultCode, data)
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) {
            val manager = getSystemService(MediaProjectionManager::class.java)
            launcher.launch(manager.createScreenCaptureIntent())
        } else {
            finish()
        }
    }
}
