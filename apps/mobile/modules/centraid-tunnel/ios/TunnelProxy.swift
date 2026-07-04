/*
 * Localhost HTTP proxy (issue #263): the WebView points at
 * http://127.0.0.1:<port> and every request — documents, module imports,
 * EventSource — is forwarded over one iroh bi-stream per request.
 * Connection-close semantics keep parsing trivial: each response ends by
 * closing the socket, and body bytes are flushed to the socket as they
 * arrive, so SSE events reach the WebView live (the bi-stream stays open
 * until the desktop FINs it).
 */

import Foundation
import Network

final class TunnelProxy: @unchecked Sendable {
  typealias OpenStream = @Sendable () async throws -> TunnelStream

  private let openStream: OpenStream
  private let queue = DispatchQueue(label: "centraid.tunnel.proxy")
  private var listener: NWListener?

  init(openStream: @escaping OpenStream) {
    self.openStream = openStream
  }

  /// Bind 127.0.0.1:0 (ephemeral). Loopback only — the proxy must never be
  /// reachable from off-device.
  func start() async throws -> UInt16 {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
    parameters.allowLocalEndpointReuse = true
    let listener = try NWListener(using: parameters)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] socket in
      guard let self else {
        socket.cancel()
        return
      }
      socket.start(queue: self.queue)
      Task { await self.handle(socket) }
    }
    return try await withCheckedThrowingContinuation { continuation in
      var resumed = false
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          guard !resumed, let port = listener.port?.rawValue else { return }
          resumed = true
          continuation.resume(returning: port)
        case .failed(let error), .waiting(let error):
          guard !resumed else { return }
          resumed = true
          listener.cancel()
          continuation.resume(throwing: error)
        case .cancelled:
          guard !resumed else { return }
          resumed = true
          continuation.resume(throwing: TunnelError("proxy listener cancelled before binding"))
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  // MARK: - Per-socket handling

  /// Written across an await boundary, so `inout` won't do.
  private final class Flag { var value = false }

  private func handle(_ socket: NWConnection) async {
    do {
      guard let request = try await readRequest(socket) else {
        socket.cancel() // speculative connection closed idle — nothing to answer
        return
      }
      let headersSent = Flag()
      do {
        try await forward(request, to: socket, headersSent: headersSent)
      } catch {
        // Dial/stream failure → 502, matching the Node reference proxy. If
        // headers already went out, closing the socket mid-body is the only
        // honest signal left.
        if !headersSent.value {
          try await writeSimpleResponse(socket, status: 502, message: describe(error))
        }
      }
    } catch let error as HttpParseError {
      try? await writeSimpleResponse(socket, status: 400, message: error.localizedDescription)
    } catch {
      // Socket error before a full request arrived; nothing to answer.
    }
    socket.cancel()
  }

  /// Accumulate the head (bounded), then exactly Content-Length body bytes.
  private func readRequest(_ socket: NWConnection) async throws -> HttpRequest? {
    var buffer = Data()
    var headEnd: Int?
    while headEnd == nil {
      guard buffer.count <= HttpParser.maxHeadBytes else { throw HttpParseError.headTooLarge }
      guard let chunk = try await receive(socket) else {
        if buffer.isEmpty { return nil }
        throw HttpParseError.truncated
      }
      buffer.append(chunk)
      headEnd = HttpParser.endOfHead(in: buffer)
    }
    let head = try HttpParser.parseHead(buffer.subdata(in: 0..<headEnd!))
    let expected = head.contentLength
    guard expected <= TunnelWire.maxRequestBodyBytes else {
      throw HttpParseError.unsupported("request bodies over \(TunnelWire.maxRequestBodyBytes) bytes")
    }
    var body = buffer.subdata(in: headEnd!..<buffer.count)
    while body.count < expected {
      guard let chunk = try await receive(socket) else { throw HttpParseError.truncated }
      body.append(chunk)
    }
    return HttpRequest(head: head, body: body)
  }

  /// One bi-stream per request: header frame + raw body + FIN out; response
  /// header frame in, then body streamed chunk-by-chunk until FIN.
  private func forward(_ request: HttpRequest, to socket: NWConnection, headersSent: Flag) async throws {
    let stream = try await openStream() // lazy dial / redial lives behind this closure
    let requestHeader: [String: Any] = [
      "method": request.head.method,
      "target": request.head.target,
      "headers": TunnelWire.sanitizeRequestHeaders(request.head.headers),
    ]
    try await TunnelWire.writeAll(stream, TunnelWire.encodeHeaderFrame(requestHeader))
    if !request.body.isEmpty { try await TunnelWire.writeAll(stream, request.body) }
    try await TunnelWire.finish(stream)

    let responseHeader = try await TunnelWire.readHeaderFrame(stream)
    let status = (responseHeader["status"] as? Int) ?? 502
    let headers = (responseHeader["headers"] as? [String: Any]) ?? [:]
    try await send(socket, Self.responseHead(status: status, headers: headers))
    headersSent.value = true
    try await TunnelWire.readBody(stream) { chunk in
      try await self.send(socket, chunk) // per-chunk flush: SSE stays live
    }
  }

  // MARK: - Response writing

  private static func responseHead(status: Int, headers: [String: Any]) -> Data {
    var head = "HTTP/1.1 \(status) \(reasonPhrase(status))\r\n"
    for (name, value) in TunnelWire.responseHeaderLines(headers) {
      head += "\(name): \(value)\r\n"
    }
    head += "connection: close\r\n\r\n"
    return Data(head.utf8)
  }

  private func writeSimpleResponse(_ socket: NWConnection, status: Int, message: String) async throws {
    let body = try JSONSerialization.data(withJSONObject: ["error": "tunnel_error", "message": message])
    var head = "HTTP/1.1 \(status) \(Self.reasonPhrase(status))\r\n"
    head += "content-type: application/json\r\n"
    head += "content-length: \(body.count)\r\n"
    head += "connection: close\r\n\r\n"
    try await send(socket, Data(head.utf8) + body)
  }

  private static func reasonPhrase(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 201: return "Created"
    case 204: return "No Content"
    case 301: return "Moved Permanently"
    case 302: return "Found"
    case 304: return "Not Modified"
    case 400: return "Bad Request"
    case 401: return "Unauthorized"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 500: return "Internal Server Error"
    case 502: return "Bad Gateway"
    default: return "Status"
    }
  }

  private func describe(_ error: Error) -> String {
    if let tunnelError = error as? TunnelError { return tunnelError.message }
    return String(describing: error)
  }

  // MARK: - NWConnection async wrappers

  private func send(_ socket: NWConnection, _ data: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      socket.send(content: data, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      })
    }
  }

  /// nil = peer closed cleanly; empty Data = nothing yet (caller re-reads).
  private func receive(_ socket: NWConnection) async throws -> Data? {
    try await withCheckedThrowingContinuation { continuation in
      socket.receive(minimumIncompleteLength: 1, maximumLength: TunnelWire.readChunkBytes) { data, _, isComplete, error in
        if let error {
          continuation.resume(throwing: error)
          return
        }
        if let data, !data.isEmpty {
          continuation.resume(returning: data)
          return
        }
        continuation.resume(returning: isComplete ? nil : Data())
      }
    }
  }
}
