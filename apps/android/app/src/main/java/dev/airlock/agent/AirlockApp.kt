package dev.airlock.agent

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager

class AirlockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)

        // 1.0.0/1.0.1 used a LOW channel, which draws a status-bar icon and
        // alerts on every change. Remove it so upgraded installs go quiet too.
        manager.deleteNotificationChannel("airlock-service")

        // IMPORTANCE_MIN keeps the mandatory foreground-service entry in the
        // shade only: no status-bar icon, no heads-up, no sound, no vibration.
        // A new id is required because Android ignores importance changes on an
        // existing channel.
        val channel = NotificationChannel(
            DeviceService.CHANNEL_ID,
            getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_MIN,
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
