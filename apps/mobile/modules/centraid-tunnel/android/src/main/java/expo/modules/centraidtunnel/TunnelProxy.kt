// Localhost HTTP proxy (issue #263): the WebView points at
// http://127.0.0.1:<port> and every request — documents, module imports,
// EventSource — is forwarded over one iroh bi-stream per request.
// Connection-close semantics keep parsing trivial: each response ends by
// closing the socket, and body bytes are flushed to the socket as they
// arrive, so SSE events reach the WebView live (the bi-stream stays open
// until the desktop FINs it).

package expo.modules.centraidtunnel

import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

class TunnelProxy(private val openStream: suspend () -> TunnelStream) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var server: ServerSocket? = null

  /**
   * Bind 127.0.0.1:0 (ephemeral). Loopback only — the proxy must never be
   * reachable from off-device.
   */
  fun start(): Int {
    val socket = ServerSocket(0, 64, InetAddress.getLoopbackAddress())
    server = socket
    scope.launch { acceptLoop(socket) }
    return socket.localPort
  }

  fun stop() {
    runCatching { server?.close() }
    server = null
    scope.cancel()
  }

  private fun acceptLoop(server: ServerSocket) {
    while (!server.isClosed) {
      // accept() unblocks with a SocketException when stop() closes the server.
      val client = try {
        server.accept()
      } catch (_: Throwable) {
        return
      }
      scope.launch { handle(client) }
    }
  }

  private suspend fun handle(client: Socket) {
    client.use { socket ->
      val output = socket.getOutputStream()
      val request = try {
        HttpParser.readRequest(socket.getInputStream())
      } catch (err: Throwable) {
        writeSimpleResponse(output, 400, err.message ?: "bad request")
        return
      } ?: return // speculative connection closed idle — nothing to answer

      var headersSent = false
      try {
        // One bi-stream per request: header frame + raw body + FIN out;
        // response header frame in, then body streamed until FIN. The lazy
        // dial / redial lives behind openStream.
        val stream = openStream()
        val header = JSONObject()
          .put("method", request.method)
          .put("target", request.target)
          .put("headers", TunnelWire.sanitizeRequestHeaders(request.headers))
        TunnelWire.writeAll(stream, TunnelWire.encodeHeaderFrame(header))
        if (request.body.isNotEmpty()) TunnelWire.writeAll(stream, request.body)
        TunnelWire.finish(stream)

        val response = TunnelWire.readHeaderFrame(stream)
        val status = response.optInt("status", 502)
        val headers = response.optJSONObject("headers") ?: JSONObject()
        output.write(responseHead(status, headers))
        output.flush()
        headersSent = true
        TunnelWire.readBody(stream) { chunk ->
          output.write(chunk)
          output.flush() // per-chunk flush: SSE stays live
        }
      } catch (err: Throwable) {
        // Dial/stream failure → 502, matching the Node reference proxy. If
        // headers already went out, closing the socket mid-body is the only
        // honest signal left.
        if (!headersSent) writeSimpleResponse(output, 502, err.message ?: err.toString())
      }
    }
  }

  private fun responseHead(status: Int, headers: JSONObject): ByteArray {
    val head = StringBuilder()
    head.append("HTTP/1.1 ").append(status).append(' ').append(reasonPhrase(status)).append("\r\n")
    for ((name, value) in TunnelWire.responseHeaderLines(headers)) {
      head.append(name).append(": ").append(value).append("\r\n")
    }
    head.append("connection: close\r\n\r\n")
    return head.toString().toByteArray(Charsets.ISO_8859_1)
  }

  private fun writeSimpleResponse(output: OutputStream, status: Int, message: String) {
    runCatching {
      val body = JSONObject()
        .put("error", "tunnel_error")
        .put("message", message)
        .toString()
        .toByteArray(Charsets.UTF_8)
      val head = "HTTP/1.1 $status ${reasonPhrase(status)}\r\n" +
        "content-type: application/json\r\n" +
        "content-length: ${body.size}\r\n" +
        "connection: close\r\n\r\n"
      output.write(head.toByteArray(Charsets.ISO_8859_1))
      output.write(body)
      output.flush()
    }
  }

  private fun reasonPhrase(status: Int): String = when (status) {
    200 -> "OK"
    201 -> "Created"
    204 -> "No Content"
    301 -> "Moved Permanently"
    302 -> "Found"
    304 -> "Not Modified"
    400 -> "Bad Request"
    401 -> "Unauthorized"
    403 -> "Forbidden"
    404 -> "Not Found"
    500 -> "Internal Server Error"
    502 -> "Bad Gateway"
    else -> "Status"
  }
}
