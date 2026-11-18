package dev.airlock.agent

import java.io.File
import java.io.OutputStream
import java.security.MessageDigest

/** An in-flight upload (binary UPLOAD frames land in this stream). */
class UploadState(
    val id: String,
    val target: File,
    val tmp: File,
    val size: Long,
    val out: OutputStream,
    val digest: MessageDigest,
) {
    var received: Long = 0
}

/** Per-connection state, shared by the LAN and relay transports. */
class PeerState(remote: Boolean) {
    @Volatile var authed: Boolean = remote
    @Volatile var mirroring: Boolean = false
    var upload: UploadState? = null
    val uploadLock = Any()
}

/**
 * One connected transport. LAN peers authenticate in-band with the six digit
 * code; relay peers are already authenticated by the room token.
 *
 * This is an interface because the LAN transport must extend NanoWSD.WebSocket.
 */
interface Peer {
    val peerId: String
    val remote: Boolean
    val state: PeerState

    /** Code supplied on the LAN handshake (?code=...), if any. */
    val providedCode: String? get() = null

    fun sendText(text: String)
    fun sendBinary(bytes: ByteArray)
    fun close(code: Int = 1000, reason: String = "bye")

    /**
     * Bytes still queued in the transport, best effort. Media producers use it
     * to shed frames instead of building an unbounded backlog that starves
     * request/response traffic on a slow mobile uplink.
     */
    val backlog: Int get() = 0
}
