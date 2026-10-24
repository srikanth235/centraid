import CentraidShared
import Foundation
import SwiftProtobuf

/// THE SCREEN RUNTIME'S TRANSPORT, over the session's one core (#1135).
///
/// `HomeSession.screenTransport` carries the core's `centraid_call` and
/// `centraid_next_event` bytes (serialized `Centraid_Core_V1_Envelope`s) and
/// nothing else: this adapter encodes a request, decodes the answer, and turns
/// the pushed events into the stream the `ScreenStore` is the one consumer of.
/// It words nothing and holds no screen state.
final class SessionScreenCore: ScreenCore, @unchecked Sendable {
    enum Failure: Error {
        case malformed
        case refused(Centraid_Core_V1_Error)
    }

    private let transport: ScreenTransport
    let updates: AsyncStream<Centraid_Core_V1_ScreenUpdate>

    init(transport: ScreenTransport) {
        self.transport = transport
        var sink: AsyncStream<Centraid_Core_V1_ScreenUpdate>.Continuation!
        updates = AsyncStream { sink = $0 }
        let updateSink = sink!
        transport.observe { bytes in
            guard let envelope = try? Centraid_Core_V1_Envelope(serializedBytes: bytes.data),
                case .event(let event)? = envelope.body,
                case .screen(let update)? = event.kind
            else { return }
            updateSink.yield(update)
        }
    }

    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        var envelope = Centraid_Core_V1_Envelope()
        envelope.body = .request(request)
        let bytes = try envelope.serializedData().kotlin
        let answer: Data = await withCheckedContinuation { continuation in
            transport.call(request: bytes) { continuation.resume(returning: $0.data) }
        }
        let decoded = try Centraid_Core_V1_Envelope(serializedBytes: answer)
        switch decoded.body {
        case .response(let response)?: return response
        case .error(let error)?: throw Failure.refused(error)
        default: throw Failure.malformed
        }
    }
}
