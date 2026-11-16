package dev.airlock.agent

import android.content.Context
import android.net.Uri
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reads and sends SMS through the platform provider. This is why the app must
 * be sideloaded: READ_SMS / SEND_SMS are restricted permissions on Play.
 */
class SmsStore(private val context: Context) {

    private data class Row(
        val id: String,
        val threadId: String,
        val address: String,
        val body: String,
        val date: Long,
        val inbound: Boolean,
        val unread: Boolean,
    )

    private fun queryMessages(selection: String? = null, args: Array<String>? = null, limit: Int = 800): List<Row> {
        val rows = ArrayList<Row>()
        val cursor = context.contentResolver.query(
            Uri.parse("content://sms"),
            arrayOf("_id", "thread_id", "address", "body", "date", "type", "read"),
            selection,
            args,
            "date DESC",
        ) ?: return rows
        cursor.use {
            while (it.moveToNext() && rows.size < limit) {
                val type = it.getInt(5)
                rows += Row(
                    id = it.getString(0),
                    threadId = it.getString(1) ?: it.getString(0),
                    address = it.getString(2) ?: "unknown",
                    body = it.getString(3) ?: "",
                    date = it.getLong(4),
                    inbound = type == 1,
                    unread = it.getInt(6) == 0 && type == 1,
                )
            }
        }
        return rows
    }

    fun threads(): JSONObject {
        val grouped = LinkedHashMap<String, MutableList<Row>>()
        for (row in queryMessages()) grouped.getOrPut(row.threadId) { ArrayList() }.add(row)
        val out = JSONArray()
        for ((threadId, messages) in grouped) {
            val latest = messages.first()
            out.put(
                JSONObject()
                    .put("id", threadId)
                    .put("name", latest.address)
                    .put("address", latest.address)
                    .put("unread", messages.count { it.unread })
                    .put("preview", latest.body)
                    .put("ts", latest.date)
            )
        }
        return JSONObject().put("threads", out)
    }

    fun messages(threadId: String): JSONObject {
        val rows = queryMessages("thread_id = ?", arrayOf(threadId)).reversed()
        val list = JSONArray()
        for (row in rows) {
            list.put(
                JSONObject()
                    .put("id", row.id)
                    .put("from", if (row.inbound) "them" else "me")
                    .put("body", row.body)
                    .put("ts", row.date)
            )
        }
        val address = rows.lastOrNull()?.address ?: "unknown"
        return JSONObject()
            .put("thread", JSONObject().put("id", threadId).put("name", address).put("address", address))
            .put("messages", list)
    }

    fun send(address: String, body: String): JSONObject {
        val manager = if (android.os.Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
        val parts = manager.divideMessage(body)
        if (parts.size > 1) {
            manager.sendMultipartTextMessage(address, null, parts, null, null)
        } else {
            manager.sendTextMessage(address, null, body, null, null)
        }
        return JSONObject()
            .put("message", JSONObject()
                .put("id", "out-" + System.currentTimeMillis())
                .put("from", "me")
                .put("body", body)
                .put("ts", System.currentTimeMillis()))
            .put("threadId", address)
    }
}
