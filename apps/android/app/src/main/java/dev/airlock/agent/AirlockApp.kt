package dev.airlock.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class AirlockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            DeviceService.CHANNEL_ID,
            getString(R.string.channel_service),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.channel_service_desc)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}
