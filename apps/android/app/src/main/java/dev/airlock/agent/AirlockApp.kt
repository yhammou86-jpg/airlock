package dev.airlock.agent

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager

class AirlockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)

        // Earlier builds used LOW/MIN channels, which still draw a silent line
        // in the shade. Remove both so upgraded installs inherit the hidden one.
        manager.deleteNotificationChannel("airlock-service")
        manager.deleteNotificationChannel("airlock-link-quiet")

        // IMPORTANCE_NONE blocks the channel: the mandatory foreground-service
        // notification is still posted (Android requires it) but never appears
        // in the shade, on the lock screen or as a status-bar icon. A new id is
        // required because Android ignores importance changes on an existing
        // channel. Android may still list the service in the Task Manager.
        val channel = NotificationChannel(
            DeviceService.CHANNEL_ID,
            getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_NONE,
        ).apply {
            description = getString(R.string.channel_service_desc)
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
            setBypassDnd(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        manager.createNotificationChannel(channel)
    }
}
