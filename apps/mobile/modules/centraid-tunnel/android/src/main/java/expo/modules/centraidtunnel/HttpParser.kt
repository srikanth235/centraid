// Minimal HTTP/1.1 request parsing for the localhost proxy (issue #263).
//
// Only what a WebView sends us: a request line, headers, and an optional
// Content-Length body. Chunked request bodies are rejected (the tunnel
// frame carries raw body bytes, so chunk framing would be forwarded
// verbatim and corrupt the request). Responses never pass through here —
// the proxy writes them with connection-close semantics.

package expo.modules.centraidtunnel

import java.io.EOFException
import java.io.InputStream

class HttpRequest(
  val method: String,
  /** Path + query (origin form) — matches TunnelRequestHeader.target. */
  val target: String,
  /** Raw header pairs in arrival order; names not yet lowercased. */
  val headers: List<Pair<String, String>>,
  val body: ByteArray,
)

class HttpParseException(message: String) : Exception(message)

object HttpParser {
  const val MAX_HEAD_BYTES = 64 * 1024

  /**
   * Blocking read of one full request. Returns null if the socket closes
   * before any byte arrives (speculative browser connections do this).
   */
  fun readRequest(input: InputStream): HttpRequest? {
    val head = readHead(input) ?: return null
    val lines = head.split("\r\n").dropLastWhile { it.isEmpty() }
    val requestLine = lines.firstOrNull()
      ?: throw HttpParseException("malformed HTTP request (empty request head)")
    val parts = requestLine.split(' ')
    if (parts.size < 3) throw HttpParseException("malformed HTTP request (request line: $requestLine)")

    val headers = mutableListOf<Pair<String, String>>()
    for (line in lines.drop(1)) {
      val colon = line.indexOf(':')
      if (colon <= 0) throw HttpParseException("malformed HTTP request (header line: $line)")
      headers.add(line.substring(0, colon).trim() to line.substring(colon + 1).trim())
    }
    if (headers.any { it.first.equals("transfer-encoding", ignoreCase = true) }) {
      throw HttpParseException("chunked request bodies not supported by the tunnel proxy")
    }

    val contentLength = headers
      .firstOrNull { it.first.equals("content-length", ignoreCase = true) }
      ?.second?.toIntOrNull() ?: 0
    if (contentLength > TunnelWire.MAX_REQUEST_BODY_BYTES) {
      throw HttpParseException("request body exceeds ${TunnelWire.MAX_REQUEST_BODY_BYTES} bytes")
    }
    val body = ByteArray(contentLength)
    var read = 0
    while (read < contentLength) {
      val n = input.read(body, read, contentLength - read)
      if (n < 0) throw EOFException("socket closed mid-request body")
      read += n
    }
    return HttpRequest(parts[0], normalizeTarget(parts[1]), headers, body)
  }

  /**
   * Accumulate bytes until \r\n\r\n (bounded). Byte-per-byte via ISO-8859-1
   * keeps header values byte-faithful; bodies never pass through here.
   */
  private fun readHead(input: InputStream): String? {
    val head = StringBuilder()
    var matched = 0
    while (true) {
      val b = input.read()
      if (b < 0) {
        if (head.isEmpty()) return null
        throw EOFException("socket closed mid-request head")
      }
      if (head.length >= MAX_HEAD_BYTES) {
        throw HttpParseException("request head exceeds $MAX_HEAD_BYTES bytes")
      }
      head.append(b.toChar())
      matched = when {
        b == '\r'.code && (matched == 0 || matched == 2) -> matched + 1
        b == '\n'.code && (matched == 1 || matched == 3) -> matched + 1
        b == '\r'.code -> 1
        else -> 0
      }
      if (matched == 4) return head.toString()
    }
  }

  /**
   * WebViews talk to 127.0.0.1 as an origin, so targets arrive in origin
   * form already; absolute-form (RFC 9112 §3.2.2) is normalized defensively.
   */
  fun normalizeTarget(target: String): String {
    val lowered = target.lowercase()
    if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) return target
    val afterScheme = target.substringAfter("://")
    val slash = afterScheme.indexOf('/')
    return if (slash < 0) "/" else afterScheme.substring(slash)
  }
}
