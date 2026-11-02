import Foundation

/// Owns a NotificationCenter registration without exposing its non-Sendable
/// token. ARC can release an actor's stored properties on any thread;
/// NotificationCenter supports removing registrations from that thread.
/// This owner is never shared or mutated after construction.
final class NotificationObservation {
    private let center: NotificationCenter
    private let token: NSObjectProtocol

    init(_ token: NSObjectProtocol, center: NotificationCenter = .default) {
        self.center = center
        self.token = token
    }

    deinit {
        center.removeObserver(token)
    }
}
