/*
 * Wire protocol + iroh binding seam for the centraid tunnel (issue #263).
 *
 * Framing must stay byte-for-byte in lockstep with
 * packages/tunnel/src/protocol.ts: a header frame is a u32 big-endian byte
 * length followed by that many bytes of UTF-8 JSON; body bytes follow until
 * stream FIN; EOF is signalled by an empty read. This is the ONLY file that
 * touches IrohLib — see the adapter section at the bottom.
 */

import Foundation
// The uniffi-generated iroh Swift wrapper (IrohLib.swift) is compiled directly
// into this pod, so its types (Endpoint, Connection, …) are in-module — no
// `import IrohLib`. The low-level FFI comes from the vendored Iroh.xcframework
// (module `Iroh`), which IrohLib.swift imports internally.

struct TunnelError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// One QUIC bi-stream. The only shape the proxy and runtime see, so binding
/// types never leak out of this file.
struct TunnelStream {
  let send: SendStream
  let recv: RecvStream
}

enum TunnelWire {
  static let tunnelAlpn = "centraid/tunnel/1"
  static let pairAlpn = "centraid/pair/1"
  static let maxHeaderFrameBytes = 256 * 1024
  static let maxRequestBodyBytes = 32 * 1024 * 1024
  static let readChunkBytes = 64 * 1024

  /// Hop-by-hop headers that must not cross the tunnel (RFC 9110 §7.6.1).
  static let hopByHopHeaders: Set<String> = [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  ]

  /// Pure framing: u32 BE length prefix + payload bytes. Separated from the
  /// stream I/O so it is unit-testable against the shared golden fixture
  /// (packages/tunnel/fixtures/wire-golden.json).
  static func frame(_ payload: Data) throws -> Data {
    guard payload.count <= maxHeaderFrameBytes else {
      throw TunnelError("tunnel: header frame length \(payload.count) out of bounds")
    }
    var frame = Data(capacity: 4 + payload.count)
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
    frame.append(payload)
    return frame
  }

  /// Pure decode of the u32 BE length prefix, validating the cap. Shared by
  /// readHeaderFrame and the conformance test.
  static func decodeFrameLength(_ bytes: Data) throws -> Int {
    let length = bytes.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maxHeaderFrameBytes else {
      throw TunnelError("tunnel: header frame length \(length) out of bounds")
    }
    return length
  }

  /// Encode a header frame: u32 BE length + UTF-8 JSON.
  static func encodeHeaderFrame(_ header: [String: Any]) throws -> Data {
    try frame(try JSONSerialization.data(withJSONObject: header))
  }

  /// Read one header frame. Throws on oversized or malformed frames.
  static func readHeaderFrame(_ stream: TunnelStream) async throws -> [String: Any] {
    let lengthBytes = try await IrohAdapter.readExact(stream.recv, count: 4)
    let length = try decodeFrameLength(lengthBytes)
    let jsonBytes = try await IrohAdapter.readExact(stream.recv, count: length)
    guard let header = try JSONSerialization.jsonObject(with: jsonBytes) as? [String: Any] else {
      throw TunnelError("tunnel: header frame is not a JSON object")
    }
    return header
  }

  static func writeAll(_ stream: TunnelStream, _ data: Data) async throws {
    try await IrohAdapter.writeAll(stream.send, data)
  }

  static func finish(_ stream: TunnelStream) async throws {
    try await IrohAdapter.finish(stream.send)
  }

  /// Read body bytes until stream FIN (an empty read), one chunk at a time.
  static func readBody(_ stream: TunnelStream, onChunk: (Data) async throws -> Void) async throws {
    while true {
      let chunk = try await IrohAdapter.read(stream.recv, max: readChunkBytes)
      if chunk.isEmpty { return }
      try await onChunk(chunk)
    }
  }

  /// Lowercase names, drop hop-by-hop, merge duplicates into arrays —
  /// mirrors protocol.ts sanitizeHeaders + the Node HeaderMap shape.
  static func sanitizeRequestHeaders(_ headers: [(name: String, value: String)]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (rawName, value) in headers {
      let name = rawName.lowercased()
      if hopByHopHeaders.contains(name) { continue }
      if let existing = out[name] {
        if var list = existing as? [String] {
          list.append(value)
          out[name] = list
        } else if let single = existing as? String {
          out[name] = [single, value]
        }
      } else {
        out[name] = value
      }
    }
    return out
  }

  /// Flatten a response HeaderMap into writable lines, dropping hop-by-hop.
  static func responseHeaderLines(_ headers: [String: Any]) -> [(name: String, value: String)] {
    var lines: [(String, String)] = []
    for (rawName, value) in headers {
      let name = rawName.lowercased()
      if hopByHopHeaders.contains(name) { continue }
      if let list = value as? [Any] {
        for item in list { lines.append((name, String(describing: item))) }
      } else {
        lines.append((name, String(describing: value)))
      }
    }
    return lines
  }
}

/// Owns the iroh endpoint and the lazily-redialed tunnel connection.
actor TunnelTransport {
  private let endpoint: Endpoint
  private let ticket: String
  private var connection: Connection?

  private init(endpoint: Endpoint, ticket: String) {
    self.endpoint = endpoint
    self.ticket = ticket
  }

  static func bind(secretKey: Data, ticket: String) async throws -> TunnelTransport {
    TunnelTransport(endpoint: try await IrohAdapter.bindEndpoint(secretKey: secretKey), ticket: ticket)
  }

  /// One-shot pairing on its own short-lived endpoint: dial the pair ALPN,
  /// send {code, deviceName, platform}, FIN, read the desktop's response.
  static func pair(
    secretKey: Data,
    ticket: String,
    code: String,
    deviceName: String,
    platform: String
  ) async throws -> [String: Any] {
    let endpoint = try await IrohAdapter.bindEndpoint(secretKey: secretKey)
    do {
      let connection = try await IrohAdapter.dial(endpoint, ticket: ticket, alpn: TunnelWire.pairAlpn)
      let stream = try await IrohAdapter.openBi(connection)
      let frame = try TunnelWire.encodeHeaderFrame([
        "code": code, "deviceName": deviceName, "platform": platform,
      ])
      try await TunnelWire.writeAll(stream, frame)
      try await TunnelWire.finish(stream)
      let response = try await TunnelWire.readHeaderFrame(stream)
      IrohAdapter.closeConnection(connection)
      await IrohAdapter.closeEndpoint(endpoint)
      return response
    } catch {
      await IrohAdapter.closeEndpoint(endpoint)
      throw error
    }
  }

  /// One bi-stream per HTTP request; concurrent requests share the cached
  /// connection. When it is dead (desktop restarted, device revoked) we drop
  /// it and dial fresh — if that dial also fails the caller answers 502.
  func openTunnelStream() async throws -> TunnelStream {
    if let connection {
      do {
        return try await IrohAdapter.openBi(connection)
      } catch {
        self.connection = nil
      }
    }
    let fresh = try await IrohAdapter.dial(endpoint, ticket: ticket, alpn: TunnelWire.tunnelAlpn)
    connection = fresh
    return try await IrohAdapter.openBi(fresh)
  }

  func close() async {
    if let connection { IrohAdapter.closeConnection(connection) }
    connection = nil
    await IrohAdapter.closeEndpoint(endpoint)
  }
}

// MARK: - IrohLib binding adapter
//
// Every IrohLib touchpoint lives in this section. The expected surface is
// the uniffi-generated Swift package from n0-computer/iroh-ffi 1.0, which
// mirrors the Node binding declared in packages/tunnel/src/iroh.ts:
// Endpoint.builder()/bind, EndpointTicket.fromString → endpointAddr,
// endpoint.connect(addr, alpn), connection.openBi() → send/recv halves with
// writeAll/finish/read/readExact; EOF = empty read. If the vendored binding
// differs slightly — argument labels, [UInt8] vs Data buffers, property vs
// accessor for the BiStream halves — each call below is a one-line fix.

enum IrohAdapter {
  static func bindEndpoint(secretKey: Data) async throws -> Endpoint {
    // iroh-ffi 1.0: no builder — Endpoint.bind(options:). presetN0 carries the
    // n0 relay/discovery defaults; secretKey is the raw 32 bytes.
    try await Endpoint.bind(options: EndpointOptions(preset: presetN0(), secretKey: secretKey))
  }

  static func dial(_ endpoint: Endpoint, ticket: String, alpn: String) async throws -> Connection {
    // EndpointTicket.fromString takes `str:` (EndpointId.fromString uses `s:`).
    let addr = try EndpointTicket.fromString(str: ticket).endpointAddr()
    return try await endpoint.connect(addr: addr, alpn: Data(alpn.utf8))
  }

  static func openBi(_ connection: Connection) async throws -> TunnelStream {
    let bi = try await connection.openBi()
    // send()/recv() are methods in the 1.0 binding, not properties.
    return TunnelStream(send: bi.send(), recv: bi.recv())
  }

  static func writeAll(_ send: SendStream, _ data: Data) async throws {
    try await send.writeAll(buf: data)
  }

  static func finish(_ send: SendStream) async throws {
    try await send.finish()
  }

  /// One chunk of at most `max` bytes; empty Data signals stream FIN.
  static func read(_ recv: RecvStream, max: Int) async throws -> Data {
    try await recv.read(sizeLimit: UInt32(max))
  }

  static func readExact(_ recv: RecvStream, count: Int) async throws -> Data {
    try await recv.readExact(size: UInt32(count))
  }

  static func closeConnection(_ connection: Connection) {
    // Connection.close throws in the 1.0 binding; best-effort on cleanup paths.
    try? connection.close(errorCode: 0, reason: Data())
  }

  static func closeEndpoint(_ endpoint: Endpoint) async {
    try? await endpoint.close()
  }
}
