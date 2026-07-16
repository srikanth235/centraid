// Wire protocol + iroh binding seam for the centraid tunnel (issue #263).
//
// Framing must stay byte-for-byte in lockstep with
// packages/tunnel/src/protocol.ts: a header frame is a u32 big-endian byte
// length followed by that many bytes of UTF-8 JSON; body bytes follow until
// stream FIN; EOF is signalled by an empty read. This is the ONLY file that
// touches the iroh binding — see the adapter section at the bottom.

package expo.modules.centraidtunnel

import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.RecvStream
import computer.iroh.SendStream
import computer.iroh.presetN0
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * One QUIC bi-stream. The only shape the proxy and runtime see, so binding
 * types never leak out of this file.
 */
data class TunnelStream(val send: SendStream, val recv: RecvStream)

object TunnelWire {
  const val TUNNEL_ALPN = "centraid/tunnel/1"
  const val PAIR_ALPN = "centraid/pair/1"
  const val MAX_HEADER_FRAME_BYTES = 256 * 1024
  const val MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
  const val READ_CHUNK_BYTES = 64 * 1024

  /** Hop-by-hop headers that must not cross the tunnel (RFC 9110 §7.6.1). */
  val HOP_BY_HOP = setOf(
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  )

  /**
   * Pure framing: u32 BE length prefix + payload bytes. Separated from the
   * stream I/O so it is unit-testable against the shared golden fixture
   * (packages/tunnel/fixtures/wire-golden.json).
   */
  fun frame(payload: ByteArray): ByteArray {
    if (payload.size > MAX_HEADER_FRAME_BYTES) {
      throw TunnelException("tunnel: header frame length ${payload.size} out of bounds")
    }
    val frame = ByteArray(4 + payload.size)
    frame[0] = (payload.size ushr 24).toByte()
    frame[1] = (payload.size ushr 16).toByte()
    frame[2] = (payload.size ushr 8).toByte()
    frame[3] = payload.size.toByte()
    payload.copyInto(frame, 4)
    return frame
  }

  /**
   * Pure decode of the u32 BE length prefix, validating the cap. Shared by
   * readHeaderFrame and the conformance test.
   */
  fun decodeFrameLength(bytes: ByteArray): Int {
    val length = ((bytes[0].toInt() and 0xff) shl 24) or
      ((bytes[1].toInt() and 0xff) shl 16) or
      ((bytes[2].toInt() and 0xff) shl 8) or
      (bytes[3].toInt() and 0xff)
    if (length <= 0 || length > MAX_HEADER_FRAME_BYTES) {
      throw TunnelException("tunnel: header frame length $length out of bounds")
    }
    return length
  }

  /** Encode a header frame: u32 BE length + UTF-8 JSON. */
  fun encodeHeaderFrame(header: JSONObject): ByteArray =
    frame(header.toString().toByteArray(Charsets.UTF_8))

  /** Read one header frame. Throws on oversized or malformed frames. */
  suspend fun readHeaderFrame(stream: TunnelStream): JSONObject {
    val length = decodeFrameLength(IrohAdapter.readExact(stream.recv, 4))
    val jsonBytes = IrohAdapter.readExact(stream.recv, length)
    return JSONObject(String(jsonBytes, Charsets.UTF_8))
  }

  suspend fun writeAll(stream: TunnelStream, data: ByteArray) {
    IrohAdapter.writeAll(stream.send, data)
  }

  suspend fun finish(stream: TunnelStream) {
    IrohAdapter.finish(stream.send)
  }

  /** Read body bytes until stream FIN (an empty read), one chunk at a time. */
  suspend fun readBody(stream: TunnelStream, onChunk: suspend (ByteArray) -> Unit) {
    while (true) {
      val chunk = IrohAdapter.read(stream.recv, READ_CHUNK_BYTES)
      if (chunk.isEmpty()) return
      onChunk(chunk)
    }
  }

  /**
   * Lowercase names, drop hop-by-hop, merge duplicates into JSON arrays —
   * mirrors protocol.ts sanitizeHeaders + the Node HeaderMap shape.
   */
  fun sanitizeRequestHeaders(headers: List<Pair<String, String>>): JSONObject {
    val out = JSONObject()
    for ((rawName, value) in headers) {
      val name = rawName.lowercase()
      if (name in HOP_BY_HOP) continue
      when (val existing = out.opt(name)) {
        null -> out.put(name, value)
        is JSONArray -> existing.put(value)
        else -> out.put(name, JSONArray().put(existing).put(value))
      }
    }
    return out
  }

  /** Flatten a response HeaderMap into writable lines, dropping hop-by-hop. */
  fun responseHeaderLines(headers: JSONObject): List<Pair<String, String>> {
    val lines = mutableListOf<Pair<String, String>>()
    for (rawName in headers.keys()) {
      val name = rawName.lowercase()
      if (name in HOP_BY_HOP) continue
      when (val value = headers.get(rawName)) {
        is JSONArray -> for (i in 0 until value.length()) lines.add(name to value.get(i).toString())
        else -> lines.add(name to value.toString())
      }
    }
    return lines
  }
}

/** Owns the iroh endpoint and the lazily-redialed tunnel connection. */
class TunnelTransport private constructor(
  private val endpoint: Endpoint,
  private val ticket: String,
) {
  private val mutex = Mutex()
  private var connection: Connection? = null

  companion object {
    suspend fun bind(secretKey: ByteArray, ticket: String): TunnelTransport =
      TunnelTransport(IrohAdapter.bindEndpoint(secretKey), ticket)

    /**
     * One-shot pairing on its own short-lived endpoint: dial the pair ALPN,
     * send {code, deviceName, platform}, FIN, read the desktop's response.
     */
    suspend fun pair(
      secretKey: ByteArray,
      ticket: String,
      code: String,
      deviceName: String,
      platform: String,
    ): Map<String, Any?> {
      val endpoint = IrohAdapter.bindEndpoint(secretKey)
      try {
        val connection = IrohAdapter.dial(endpoint, ticket, TunnelWire.PAIR_ALPN)
        try {
          val stream = IrohAdapter.openBi(connection)
          val frame = JSONObject()
            .put("code", code)
            .put("deviceName", deviceName)
            .put("platform", platform)
          TunnelWire.writeAll(stream, TunnelWire.encodeHeaderFrame(frame))
          TunnelWire.finish(stream)
          val response = TunnelWire.readHeaderFrame(stream)
          return buildMap { for (key in response.keys()) put(key, response.get(key)) }
        } finally {
          IrohAdapter.closeConnection(connection)
        }
      } finally {
        IrohAdapter.closeEndpoint(endpoint)
      }
    }
  }

  /**
   * One bi-stream per HTTP request; concurrent requests share the cached
   * connection. When it is dead (desktop restarted, device revoked) we drop
   * it and dial fresh — if that dial also fails the caller answers 502.
   */
  suspend fun openTunnelStream(): TunnelStream = mutex.withLock {
    connection?.let { cached ->
      try {
        return IrohAdapter.openBi(cached)
      } catch (_: Throwable) {
        connection = null
      }
    }
    val fresh = IrohAdapter.dial(endpoint, ticket, TunnelWire.TUNNEL_ALPN)
    connection = fresh
    IrohAdapter.openBi(fresh)
  }

  suspend fun close() {
    connection?.let { IrohAdapter.closeConnection(it) }
    connection = null
    IrohAdapter.closeEndpoint(endpoint)
  }
}

// ── iroh binding adapter ─────────────────────────────────────────────────
// Every binding touchpoint lives in this section. The expected surface is
// the uniffi-generated Kotlin artifact (`computer.iroh:iroh`, from
// n0-computer/iroh-ffi 1.0), which mirrors the Node binding declared in
// packages/tunnel/src/iroh.ts: Endpoint.builder()/bind,
// EndpointTicket.fromString → endpointAddr, endpoint.connect(addr, alpn),
// connection.openBi() → send/recv halves with writeAll/finish/read/
// readExact; EOF = empty read. If the vendored binding differs slightly —
// method vs property for the BiStream halves, UInt vs Int sizes, ByteArray
// vs List<UByte> buffers — each call below is a one-line fix.

object IrohAdapter {
  suspend fun bindEndpoint(secretKey: ByteArray): Endpoint {
    // iroh-ffi 1.0: no builder — Endpoint.bind(EndpointOptions(...)). The
    // preset carries the n0 relay/discovery defaults; secretKey is raw bytes.
    return Endpoint.bind(EndpointOptions(preset = presetN0(), secretKey = secretKey))
  }

  suspend fun dial(endpoint: Endpoint, ticket: String, alpn: String): Connection {
    val addr = EndpointTicket.fromString(ticket).endpointAddr()
    return endpoint.connect(addr, alpn.toByteArray(Charsets.UTF_8))
  }

  suspend fun openBi(connection: Connection): TunnelStream {
    val bi = connection.openBi()
    return TunnelStream(bi.send(), bi.recv())
  }

  suspend fun writeAll(send: SendStream, data: ByteArray) {
    send.writeAll(data)
  }

  suspend fun finish(send: SendStream) {
    send.finish()
  }

  /** One chunk of at most `max` bytes; an empty array signals stream FIN. */
  suspend fun read(recv: RecvStream, max: Int): ByteArray = recv.read(max.toUInt())

  suspend fun readExact(recv: RecvStream, count: Int): ByteArray = recv.readExact(count.toUInt())

  fun closeConnection(connection: Connection) {
    // Connection.close(errorCode: i64, reason: &[u8]) — errorCode is signed.
    connection.close(0L, byteArrayOf())
  }

  suspend fun closeEndpoint(endpoint: Endpoint) {
    // uniffi renames Endpoint.close -> shutdown in Kotlin (AutoCloseable clash).
    runCatching { endpoint.shutdown() }
  }
}
