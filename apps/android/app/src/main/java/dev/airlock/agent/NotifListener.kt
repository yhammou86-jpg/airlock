package dev.airlock.agent

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

/**
 * Mirrors the notification shade to paired browsers and replies through the
 * notification's own RemoteInput action (no synthetic taps).
 */
class NotifListener : NotificationListenerService() {

    override fun onListenerConnected() {
        instance = this
        activeNotifications?.forEach { ingest(it) }
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) = ingest(sbn)

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        NotifStore.dismiss(sbn.key)
    }

    private fun ingest(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val n = sbn.notification ?: return
        val extras = n.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val body = (
            extras.getCharSequence(Notification.EXTRA_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            )?.toString().orEmpty()
        if (title.isBlank() && body.isBlank()) return

        val canReply = n.actions?.any { action ->
            action.remoteInputs?.isNotEmpty() == true
        } == true

        val json = JSONObject()
            .put("id", sbn.key)
            .put("key", sbn.key)
            .put("app", appLabel(sbn.packageName))
            .put("pkg", sbn.packageName)
            .put("title", title)
            .put("body", body)
            .put("ts", sbn.postTime)
            .put("canReply", canReply)

        NotifStore.upsert(json)
    }

    fun dismiss(key: String): Boolean = try {
        cancelNotification(key)
        NotifStore.dismiss(key)
        true
    } catch (e: Exception) {
        Log.w(TAG, "dismiss failed: ${e.message}")
        false
    }

    fun reply(key: String, text: String): Boolean {
        val sbn = try {
            activeNotifications?.firstOrNull { it.key == key }
        } catch (e: Exception) {
            null
        } ?: return false

        val actions = sbn.notification?.actions ?: return false
        for (action in actions) {
            val inputs = action.remoteInputs ?: continue
            if (inputs.isEmpty()) continue
            val intent = Intent()
            val results = Bundle()
            for (input in inputs) results.putCharSequence(input.resultKey, text)
            RemoteInput.addResultsToIntent(inputs, intent, results)
            return try {
                action.actionIntent.send(this, 0, intent)
                true
            } catch (e: Exception) {
                Log.w(TAG, "reply failed: ${e.message}")
                false
            }
        }
        return false
    }

    private fun appLabel(pkg: String): String = try {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        pkg
    }

    companion object {
        private const val TAG = "AirlockNotif"

        @Volatile
        var instance: NotifListener? = null
            private set

        fun isConnected(): Boolean = instance != null
    }
}
