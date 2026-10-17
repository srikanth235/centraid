import Foundation

/// A ROUTE THAT OPENS ONCE PER PUSH: the screen's `Opened` event, as the shared
/// side spelled it, and a nonce that is unique to the push.
///
/// `CentraidApp` sends a route's `open` on every appearance, and a pop back onto
/// a screen is one. For most screens that is right (a re-read); for a few it
/// would undo what the member did there — Money's home re-opened on Spending
/// with its month and filters reset, Tasks' quick add seeded with the words a
/// second time. Their routes carry this instead of the bare event, and
/// `OpenMemory` says "this push was already opened". JSON because a `Route`
/// holds `Data`.
struct OncePerPush: Codable, Hashable {
    var nonce: String = UUID().uuidString
    var opened: Data = Data()

    var encoded: Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(self)) ?? Data()
    }

    init(opened: Data) {
        self.opened = opened
    }

    /// Nil for bytes that are not one: the route carries a plain event.
    init?(decoding data: Data) {
        guard let decoded = try? JSONDecoder().decode(OncePerPush.self, from: data) else { return nil }
        self = decoded
    }
}

/// WHICH PUSH A SCREEN WAS LAST OPENED FOR. A class, so a route's `open` closure
/// holds it without crossing an actor.
final class OpenMemory {
    private var nonces: [String: String] = [:]

    /// True the first time `nonce` opens `identifier`; an empty nonce always opens.
    func firstOpen(_ identifier: String, _ nonce: String) -> Bool {
        if nonce.isEmpty { return true }
        if nonces[identifier] == nonce { return false }
        nonces[identifier] = nonce
        return true
    }
}
