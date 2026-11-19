package dev.airlock.agent

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicLong

/**
 * Wire format shared with packages/protocol/protocol.js.
 *
 * Text frames are JSON envelopes, binary frames start with a 16 byte header:
 *
 *   0  'A'   1 'D'   2 version   3 kind   4 codec
 *   5  flags 6 rsv   7 rsv       8..11 stream (u32 LE)   12..15 unix seconds
 */
object Protocol {
    const val VERSION = 1
    const val HEADER_BYTES = 16
    const val CHUNK_BYTES = 64 * 1024

    object Kind {
        const val MIRROR = 1
        const val CAMERA = 2
        const val UPLOAD = 3
        const val DOWNLOAD = 4
        const val AUDIO = 5
        const val PREVIEW = 6
    }

    object Codec {
        const val JPEG = 1
        const val WEBP = 2
        const val SVG = 3
        const val PNG = 4
    }

    private val seq = AtomicLong(0)

    private fun id(): String = "${System.currentTimeMillis().toString(36)}-${seq.incrementAndGet().toString(36)}"

    fun encodeFrame(
        kind: Int,
        codec: Int = 0,
        flags: Int = 0,
        stream: Int = 0,
        ts: Long = System.currentTimeMillis() / 1000,
        payload: ByteArray,
    ): ByteArray {
        val out = ByteArray(HEADER_BYTES + payload.size)
        out[0] = 'A'.code.toByte()
        out[1] = 'D'.code.toByte()
        out[2] = VERSION.toByte()
        out[3] = kind.toByte()
        out[4] = codec.toByte()
        out[5] = flags.toByte()
        val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
        bb.putInt(8, stream)
        bb.putInt(12, ts.toInt())
        System.arraycopy(payload, 0, out, HEADER_BYTES, payload.size)
        return out
    }

    data class Frame(val kind: Int, val codec: Int, val stream: Int, val payload: ByteArray)

    fun decodeFrame(buf: ByteArray): Frame? {
        if (buf.size < HEADER_BYTES) return null
        if (buf[0] != 'A'.code.toByte() || buf[1] != 'D'.code.toByte()) return null
        val bb = ByteBuffer.wrap(buf, 0, HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        return Frame(
            kind = buf[3].toInt() and 0xff,
            codec = buf[4].toInt() and 0xff,
            stream = bb.getInt(8),
            payload = buf.copyOfRange(HEADER_BYTES, buf.size),
        )
    }

    fun envelope(type: String, data: JSONObject): JSONObject = JSONObject()
        .put("v", VERSION)
        .put("id", id())
        .put("ts", System.currentTimeMillis())
        .put("type", type)
        .put("data", data)

    fun response(req: JSONObject, data: JSONObject): JSONObject = JSONObject()
        .put("v", VERSION)
        .put("id", req.optString("id") + "-r")
        .put("replyTo", req.optString("id"))
        .put("ts", System.currentTimeMillis())
        .put("type", "res:" + req.optString("type"))
        .put("ok", true)
        .put("data", data)

    fun failure(req: JSONObject, code: String, message: String): JSONObject = JSONObject()
        .put("v", VERSION)
        .put("id", req.optString("id") + "-e")
        .put("replyTo", req.optString("id"))
        .put("ts", System.currentTimeMillis())
        .put("type", "res:" + req.optString("type"))
        .put("ok", false)
        .put("error", JSONObject().put("code", code).put("message", message))

    fun event(type: String, data: JSONObject): JSONObject = JSONObject()
        .put("v", VERSION)
        .put("ts", System.currentTimeMillis())
        .put("type", "event:$type")
        .put("data", data)

    fun mimeFor(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "bmp" -> "image/bmp"
            "heic", "heif" -> "image/heic"
            "avif" -> "image/avif"
            "mp4", "m4v" -> "video/mp4"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "wav" -> "audio/wav"
            "pdf" -> "application/pdf"
            "txt", "md", "log" -> "text/plain"
            "json" -> "application/json"
            "apk" -> "application/vnd.android.package-archive"
            "zip" -> "application/zip"
            else -> "application/octet-stream"
        }
    }

    val capabilities: JSONArray = JSONArray(
        listOf(
            "device.stats", "device.action", "device.permission",
            "fs.list", "fs.mkdir", "fs.rename", "fs.delete",
            "fs.upload.begin", "fs.upload.done", "fs.download", "fs.preview",
            "mirror.start", "mirror.stop",
            "input.tap", "input.swipe", "input.longpress", "input.key", "input.text",
            "sms.threads", "sms.messages", "sms.send",
            "notif.list", "notif.dismiss", "notif.reply",
            "camera.shot", "apps.list", "apps.launch",
        )
    )
}
