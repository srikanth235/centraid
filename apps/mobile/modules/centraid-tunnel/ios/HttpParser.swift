/*
 * Minimal HTTP/1.1 request parsing for the localhost proxy (issue #263).
 *
 * Only what a WebView sends us: a request line, headers, and an optional
 * Content-Length body. Chunked request bodies are rejected (the tunnel
 * frame carries raw body bytes, so chunk framing would be forwarded
 * verbatim and corrupt the request). Responses never pass through here —
 * the proxy writes them with connection-close semantics.
 */

import Foundation

struct HttpRequestHead {
  let method: String
  /// Path + query (origin form) — matches TunnelRequestHeader.target.
  let target: String
  /// Raw header pairs in arrival order; names not yet lowercased.
  let headers: [(name: String, value: String)]

  var contentLength: Int {
    for (name, value) in headers where name.lowercased() == "content-length" {
      return Int(value) ?? 0
    }
    return 0
  }
}

struct HttpRequest {
  let head: HttpRequestHead
  let body: Data
}

enum HttpParseError: Error, LocalizedError {
  case malformed(String)
  case unsupported(String)
  case headTooLarge
  case truncated

  var errorDescription: String? {
    switch self {
    case .malformed(let what): return "malformed HTTP request (\(what))"
    case .unsupported(let what): return "\(what) not supported by the tunnel proxy"
    case .headTooLarge: return "request head exceeds \(HttpParser.maxHeadBytes) bytes"
    case .truncated: return "socket closed mid-request"
    }
  }
}

enum HttpParser {
  static let maxHeadBytes = 64 * 1024
  private static let headTerminator = Data("\r\n\r\n".utf8)

  /// Index just past the \r\n\r\n terminator, or nil while incomplete.
  static func endOfHead(in buffer: Data) -> Int? {
    guard let range = buffer.range(of: headTerminator) else { return nil }
    return range.upperBound
  }

  static func parseHead(_ head: Data) throws -> HttpRequestHead {
    // isoLatin1 decodes any byte sequence; header values are byte-preserved.
    guard let text = String(data: head, encoding: .isoLatin1) else {
      throw HttpParseError.malformed("undecodable head")
    }
    var lines = text.components(separatedBy: "\r\n")
    while let last = lines.last, last.isEmpty { lines.removeLast() }
    guard let requestLine = lines.first, !requestLine.isEmpty else {
      throw HttpParseError.malformed("empty request head")
    }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 3 else {
      throw HttpParseError.malformed("request line: \(requestLine)")
    }
    var headers: [(String, String)] = []
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
        throw HttpParseError.malformed("header line: \(line)")
      }
      let name = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      headers.append((name, value))
    }
    if headers.contains(where: { $0.0.lowercased() == "transfer-encoding" }) {
      throw HttpParseError.unsupported("chunked request bodies")
    }
    return HttpRequestHead(
      method: String(parts[0]),
      target: normalizeTarget(String(parts[1])),
      headers: headers
    )
  }

  /// WebViews talk to 127.0.0.1 as an origin, so targets arrive in origin
  /// form already; absolute-form (RFC 9112 §3.2.2) is normalized defensively.
  static func normalizeTarget(_ target: String) -> String {
    let lowered = target.lowercased()
    guard lowered.hasPrefix("http://") || lowered.hasPrefix("https://") else { return target }
    guard let schemeEnd = target.range(of: "://") else { return target }
    let afterScheme = target[schemeEnd.upperBound...]
    guard let slash = afterScheme.firstIndex(of: "/") else { return "/" }
    return String(afterScheme[slash...])
  }
}
