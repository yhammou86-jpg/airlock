package dev.airlock.agent

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * WAN transport: dials the relay as the `device` role and keeps reconnecting
 * with capped backoff. Payloads are opaque to the relay.
 */
class CloudLink(
    relayUrl: String,
    private val room: String,
    token: String,
    private val core: DeviceCore,
) {
    private val wsBase = relayUrl.trim().trimEnd('/')
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://")
    private val url = "$wsBase/ws?role=device&room=${enc(room)}&token=${enc(token)}"

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val handler = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var peer: CloudPeer? = null
    private var backoff = 3_000L
    private var stopped = false

    fun start() {
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        peer?.let { core.detach(it) }
        peer = null
        socket?.close(1000, "agent stopping")
        socket = null
    }

    private fun connect() {
        if (stopped) return
        Log.i(TAG, "cloud connect ${wsBase}")
        val request = Request.Builder().url(url).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoff = 3_000L
                val p = CloudPeer(webSocket)
                peer = p
                core.attach(p)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                peer?.let { core.onText(it, text) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                peer?.let { core.onBinary(it, bytes.toByteArray()) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                peer?.let { core.detach(it) }
                peer = null
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "cloud link failed: ${t.message}")
                peer?.let { core.detach(it) }
                peer = null
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = backoff
        backoff = (backoff * 2).coerceAtMost(30_000L)
        handler.postDelayed({ connect() }, delay)
    }

    class CloudPeer(private val socket: WebSocket) : Peer {
        override val peerId: String = "relay"
        override val remote: Boolean = true
        override val state = PeerState(remote = true)

        override fun sendText(text: String) {
            socket.send(text)
        }

        override fun sendBinary(bytes: ByteArray) {
            socket.send(ByteString.of(*bytes))
        }

        override val backlog: Int
            get() = try {
                socket.queueSize().coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            } catch (_: Throwable) {
                0
            }

        override fun close(code: Int, reason: String) {
            socket.close(code, reason)
        }
    }

    companion object {
        private const val TAG = "AirlockCloud"
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    }
}
