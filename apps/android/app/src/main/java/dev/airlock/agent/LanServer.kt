package dev.airlock.agent

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import fi.iki.elonen.NanoWSD.WebSocketFrame
import fi.iki.elonen.NanoWSD.WebSocketFrame.CloseCode
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong

/**
 * LAN transport: an embedded WebSocket server, the same shape as AirDroid's
 * libadjServer.so (asio HTTP + WebSocket) but written from scratch on NanoWSD.
 *
 *   ws://<phone-ip>:8787/agent        (authenticate with {"type":"auth"})
 *   http://<phone-ip>:8787/health     (discovery, no secrets)
 */
class LanServer(
    private val port: Int,
    private val prefs: Prefs,
    private val core: DeviceCore,
) : NanoWSD(port) {

    private val nextId = AtomicLong(0)
    val connections = AtomicLong(0)

    override fun serveHttp(session: IHTTPSession): Response {
        val path = session.uri
        if (path == "/health" || path == "/info" || path == "/") {
            val body = JSONObject()
                .put("ok", true)
                .put("app", "Airlock device agent")
                .put("device", prefs.installId)
                .put("name", prefs.deviceName)
                .put("lan", "ws://<this-host>:$port/agent")
                .put("auth", "six digit pairing code")
                .put("clients", connections.get())
                .toString()
            val response = newFixedLengthResponse(Response.Status.OK, "application/json", body)
            response.addHeader("access-control-allow-origin", "*")
            response.addHeader("cache-control", "no-store")
            return response
        }
        return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "not found")
    }

    override fun openWebSocket(handshake: IHTTPSession): WebSocket {
        val code = handshake.parameters["code"]?.firstOrNull()
        return LanPeer("lan-${nextId.incrementAndGet()}", code, handshake)
    }

    inner class LanPeer(
        override val peerId: String,
        override val providedCode: String?,
        session: IHTTPSession,
    ) : WebSocket(session), Peer {

        override val remote: Boolean = false
        override val state = PeerState(remote = false)

        @Synchronized
        override fun sendText(text: String) {
            try {
                send(text)
            } catch (e: IOException) {
                Log.w(TAG, "lan send failed: ${e.message}")
            }
        }

        @Synchronized
        override fun sendBinary(bytes: ByteArray) {
            try {
                send(bytes)
            } catch (e: IOException) {
                Log.w(TAG, "lan binary send failed: ${e.message}")
            }
        }

        override fun close(code: Int, reason: String) {
            try {
                close(CloseCode.NormalClosure, reason, false)
            } catch (_: Exception) {
            }
        }

        override fun onOpen() {
            connections.incrementAndGet()
            core.attach(this)
        }

        override fun onClose(code: CloseCode?, reason: String?, remote: Boolean) {
            connections.decrementAndGet()
            core.detach(this)
        }

        override fun onMessage(message: WebSocketFrame) {
            when (message.opCode) {
                WebSocketFrame.OpCode.Binary -> core.onBinary(this, message.binaryPayload)
                WebSocketFrame.OpCode.Text -> core.onText(this, message.textPayload)
                else -> {}
            }
        }

        override fun onPong(pong: WebSocketFrame) {}

        override fun onException(exception: IOException) {
            core.detach(this)
        }
    }

    companion object {
        private const val TAG = "AirlockLan"
    }
}
