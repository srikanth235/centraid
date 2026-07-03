/*
 * Expo module surface for the centraid tunnel (issue #263): pairing plus
 * lifecycle for the localhost proxy that forwards WebView HTTP over iroh
 * QUIC. The JS contract lives in ../index.ts; the wire protocol reference
 * is packages/tunnel/src/protocol.ts.
 */

import ExpoModulesCore
import Security

struct PairArgs: Record {
  @Field var ticket: String = ""
  @Field var code: String = ""
  @Field var deviceName: String = ""
  @Field var platform: String = ""
  @Field var secretKeyB64: String = ""
}

struct StartArgs: Record {
  @Field var ticket: String = ""
  @Field var secretKeyB64: String = ""
}

public class CentraidTunnelModule: Module {
  private let runtime = TunnelRuntime()

  public func definition() -> ModuleDefinition {
    Name("CentraidTunnel")
    Events("onStatusChange")

    OnCreate {
      Task { [weak self] in
        await self?.runtime.setStatusHandler { [weak self] payload in
          self?.sendEvent("onStatusChange", payload)
        }
      }
    }

    AsyncFunction("generateSecretKey") { () throws -> String in
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw TunnelError("secure random generator unavailable")
      }
      return Data(bytes).base64EncodedString()
    }

    AsyncFunction("pairWithDesktop") { (args: PairArgs) async -> [String: Any] in
      await self.runtime.pair(args)
    }

    AsyncFunction("startTunnel") { (args: StartArgs) async throws -> [String: Any] in
      ["port": try await self.runtime.start(ticket: args.ticket, secretKeyB64: args.secretKeyB64)]
    }

    AsyncFunction("stopTunnel") { () async in
      await self.runtime.stop()
    }

    AsyncFunction("getTunnelStatus") { () async -> [String: Any] in
      await self.runtime.status()
    }

    OnDestroy {
      let runtime = self.runtime
      Task { await runtime.stop() }
    }
  }
}

/// Tunnel lifecycle state machine. An actor because JS calls arrive on
/// Expo's dispatch queue while proxy sockets call back from
/// Network.framework queues.
actor TunnelRuntime {
  private enum State: String {
    case stopped, starting, running, error
  }

  private var state: State = .stopped
  private var port: UInt16?
  private var lastError: String?
  private var transport: TunnelTransport?
  private var proxy: TunnelProxy?
  private var statusHandler: (@Sendable ([String: Any]) -> Void)?

  func setStatusHandler(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
    statusHandler = handler
  }

  func status() -> [String: Any] {
    var payload: [String: Any] = ["state": state.rawValue]
    if let port { payload["port"] = Int(port) }
    if let lastError { payload["error"] = lastError }
    return payload
  }

  /// Pairing rides its own short-lived endpoint, so it works whether or not
  /// the tunnel is running. Transport failures fold into `{ok: false,
  /// error}` — the TS contract keeps one error path for dial and
  /// desktop-side rejections alike.
  func pair(_ args: PairArgs) async -> [String: Any] {
    do {
      let key = try Self.decodeSecretKey(args.secretKeyB64)
      return try await TunnelTransport.pair(
        secretKey: key,
        ticket: args.ticket,
        code: args.code,
        deviceName: args.deviceName,
        platform: args.platform
      )
    } catch {
      return ["ok": false, "error": Self.describe(error)]
    }
  }

  /// Idempotent while running: returns the already-bound proxy port.
  func start(ticket: String, secretKeyB64: String) async throws -> Int {
    if state == .running, let port { return Int(port) }
    if state == .starting { throw TunnelError("tunnel is already starting") }
    transition(.starting)
    var boundTransport: TunnelTransport?
    do {
      let key = try Self.decodeSecretKey(secretKeyB64)
      let transport = try await TunnelTransport.bind(secretKey: key, ticket: ticket)
      boundTransport = transport
      // The desktop is NOT dialed here — the first proxied request dials
      // lazily, and a dead connection is redialed the same way.
      let proxy = TunnelProxy { try await transport.openTunnelStream() }
      let boundPort = try await proxy.start()
      self.transport = transport
      self.proxy = proxy
      self.port = boundPort
      transition(.running)
      return Int(boundPort)
    } catch {
      if let boundTransport { await boundTransport.close() }
      transition(.error, error: Self.describe(error))
      throw error
    }
  }

  func stop() async {
    proxy?.stop()
    proxy = nil
    if let transport { await transport.close() }
    transport = nil
    port = nil
    transition(.stopped)
  }

  /// Every transition emits a status event; `error` only survives in the
  /// error state.
  private func transition(_ newState: State, error: String? = nil) {
    state = newState
    lastError = error
    statusHandler?(status())
  }

  private static func decodeSecretKey(_ b64: String) throws -> Data {
    guard let key = Data(base64Encoded: b64), key.count == 32 else {
      throw TunnelError("secretKeyB64 must be base64 of exactly 32 bytes")
    }
    return key
  }

  private static func describe(_ error: Error) -> String {
    if let tunnelError = error as? TunnelError { return tunnelError.message }
    return String(describing: error)
  }
}
