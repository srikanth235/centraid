import CentraidCoreC
import Foundation
import SwiftProtobuf

/// THE SWIFT SIDE OF THE C ABI (#1135, lane C2): `centraid_open`, `centraid_call`,
/// `centraid_next_event`, `centraid_free` and `centraid_close`, wrapped once.
///
/// This is the whole of what Swift knows about the core. Every decision a
/// person sees is made in Rust (`crates/screens`): this actor sends a request,
/// hands back the answer, and streams the view-state updates the core pushes.
/// It holds no screen state, writes no copy and names no screen.
///
/// `CONTRACT.md`'s clauses, kept here: buffers are copied out and released only
/// through `centraid_free` (clause 1); `centraid_call` and `centraid_next_event`
/// run off the main thread (the core asserts the UI thread by name in debug); a
/// panic arrives as `CENTRAID_PANICKED` and the handle is not reused (clause 9).
actor Core {
    /// What can go wrong, as a value. `refused` carries the core's typed error;
    /// the member-facing sentence is the core's, never made up here.
    enum Failure: Error {
        case closed
        case poisoned(diagnosticID: String)
        case malformed(String)
        case refused(Centraid_Core_V1_Error)
    }

    /// `centraid_open`'s JSON configuration (`crates/core-ffi/src/lib.rs`). The
    /// seed is the only secret in it and is never logged.
    struct Configuration: Encodable {
        struct Vault: Encodable {
            let seed: String
            let index: Int
        }
        var path: String
        var create = true
        var uiThreadName = "main"
        var expectedIdentity: String?
        var vault: Vault?
    }

    /// The handle pointer, carried across queues. The core serialises its own
    /// calls and a handle is safe to share between `call` and `next_event`.
    private struct Raw: @unchecked Sendable {
        let pointer: OpaquePointer
    }

    private let raw: Raw
    private let calls = DispatchQueue(label: "dev.centraid.core.call")
    private var closed = false

    /// Screen updates the core pushed, in order: the stream ends when the core
    /// closes or is poisoned.
    nonisolated let updates: AsyncStream<Centraid_Core_V1_ScreenUpdate>
    private nonisolated let updateSink: AsyncStream<Centraid_Core_V1_ScreenUpdate>.Continuation

    private init(raw: Raw) {
        self.raw = raw
        var sink: AsyncStream<Centraid_Core_V1_ScreenUpdate>.Continuation!
        updates = AsyncStream { sink = $0 }
        updateSink = sink
    }

    /// Open a core over a vault file. Blocking: call from a background task.
    static func open(_ configuration: Configuration) throws -> Core {
        let json = try JSONEncoder().encode(configuration)
        var handle: OpaquePointer?
        let status = json.withUnsafeBytes { bytes in
            centraid_open(
                bytes.bindMemory(to: UInt8.self).baseAddress, json.count, &handle)
        }
        guard status == CENTRAID_OK, let handle else {
            throw Failure.malformed("centraid_open answered \(status)")
        }
        let core = Core(raw: Raw(pointer: handle))
        core.startPump()
        return core
    }

    /// One request, one answer, off the caller's thread.
    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        var envelope = Centraid_Core_V1_Envelope()
        envelope.body = .request(request)
        let bytes = try envelope.serializedData()
        let raw = self.raw
        return try await withCheckedThrowingContinuation { continuation in
            calls.async {
                continuation.resume(with: Result { try Core.callSync(raw, bytes) })
            }
        }
    }

    /// Close the core. Unblocks the event pump, which ends `updates`.
    func close() {
        guard !closed else { return }
        closed = true
        _ = centraid_close(raw.pointer)
    }

    // MARK: - the five symbols

    private static func callSync(_ raw: Raw, _ request: Data) throws -> Centraid_Core_V1_Response {
        var out: UnsafeMutablePointer<UInt8>?
        var outLength = 0
        let status = request.withUnsafeBytes { bytes in
            centraid_call(
                raw.pointer, bytes.bindMemory(to: UInt8.self).baseAddress, request.count,
                &out, &outLength)
        }
        // Copy, then free through the core's own allocator and never `free(3)`.
        let answer = out.map { Data(bytes: $0, count: outLength) }
        if let out { centraid_free(out, outLength) }
        let envelope = try answer.map { try Centraid_Core_V1_Envelope(serializedBytes: $0) }
        if case .error(let error)? = envelope?.body {
            if status == CENTRAID_PANICKED { throw Failure.poisoned(diagnosticID: error.diagnosticID) }
            throw Failure.refused(error)
        }
        switch status {
        case CENTRAID_OK:
            if case .response(let response)? = envelope?.body { return response }
            throw Failure.malformed("an OK call without a response")
        case CENTRAID_CLOSED: throw Failure.closed
        default: throw Failure.malformed("centraid_call answered \(status)")
        }
    }

    private nonisolated func startPump() {
        let raw = self.raw
        let sink = updateSink
        let thread = Thread {
            while true {
                var out: UnsafeMutablePointer<UInt8>?
                var outLength = 0
                let status = centraid_next_event(raw.pointer, 1000, &out, &outLength)
                let bytes = out.map { Data(bytes: $0, count: outLength) }
                if let out { centraid_free(out, outLength) }
                if status == CENTRAID_TIMEOUT { continue }
                guard status == CENTRAID_OK else { break }
                if let bytes,
                    let envelope = try? Centraid_Core_V1_Envelope(serializedBytes: bytes),
                    case .event(let event)? = envelope.body,
                    case .screen(let update)? = event.kind
                {
                    sink.yield(update)
                }
            }
            sink.finish()
        }
        thread.name = "dev.centraid.core.events"
        thread.start()
    }
}
