package dev.airlock.agent

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/** In-memory notification feed, newest first, capped to keep the payload small. */
object NotifStore {
    private const val LIMIT = 60
    private val items = LinkedHashMap<String, JSONObject>()
    private val watchers = CopyOnWriteArrayList<(JSONObject) -> Unit>()

    fun watch(cb: (JSONObject) -> Unit) {
        watchers.add(cb)
    }

    fun upsert(n: JSONObject) {
        val id = n.optString("id")
        if (id.isEmpty()) return
        synchronized(items) {
            items.remove(id)
            items[id] = n
            while (items.size > LIMIT) items.remove(items.keys.first())
        }
        watchers.forEach { it(n) }
    }

    fun list(): JSONArray = synchronized(items) {
        JSONArray(items.values.sortedByDescending { it.optLong("ts") })
    }

    fun get(id: String): JSONObject? = synchronized(items) { items[id] }

    fun dismiss(id: String) {
        synchronized(items) { items.remove(id) }
    }
}
